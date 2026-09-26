import { lookup } from 'node:dns/promises';
import type { CatalogCandidate } from './catalog.ts';

/**
 * Post-extraction price/image recovery. Tavily snippets almost never carry a
 * price, so without this step candidates render view-only and the Approve →
 * checkout flow never triggers. For each price-less candidate we fetch the
 * product page and try, in order:
 *
 *   1. Shopify's `/products/<handle>.js` JSON (price in cents, featured_image)
 *   2. JSON-LD `Product` blocks (`offers.price`, `priceCurrency`, `image`)
 *   3. `<meta property="product:price:*" / og:*">` tags
 *
 * Currency comes from the page HTML (steps 2–3) since Shopify's .js payload
 * has none. When it stays unknown we default to 'USD' — but only for a price
 * recovered from Shopify on a .com domain, where that guess is right ~always
 * in this demo's DTC-merchant world. Documented as an assumption, not a fact.
 *
 * Never throws: enrichment is best-effort, a failed fetch just leaves the
 * candidate view-only.
 */

const TIMEOUT_MS = 6_000;
const MAX_BYTES = 1_500_000; // 1.5 MB
const MAX_REDIRECTS = 3;

// A normal desktop Chrome UA — plenty of stores 403 obvious bot agents.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Test-only seam so unit tests never hit real DNS. */
let lookupFn: typeof lookup = lookup;
export function __setLookupForTests(fn: typeof lookup): void {
  lookupFn = fn;
}

function isPrivateIp(ip: string): boolean {
  return (
    /^127\./.test(ip) ||
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^169\.254\./.test(ip) ||
    /^0\./.test(ip) ||
    ip === '::1' ||
    /^(fe80|fc|fd)/i.test(ip)
  );
}

function bareHost(hostname: string): string {
  return hostname.replace(/^www\./i, '').toLowerCase();
}

/** Read at most MAX_BYTES of a response body; aborts the stream beyond the cap. */
async function readCapped(res: Response): Promise<string> {
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > MAX_BYTES) throw new Error(`body too large (${length} bytes)`);

  const reader = res.body?.getReader?.();
  if (!reader) return res.text(); // test doubles and odd runtimes

  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('body too large (stream)');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * Fetch a page with SSRF guards: http(s) only, hostname must not resolve to a
 * private/loopback/link-local address, and redirects are followed only within
 * the same registrable domain (bare host compare — www↔apex is fine, an
 * off-domain bounce is not).
 */
async function fetchGuarded(url: string): Promise<{ html: string; finalUrl: URL }> {
  let current = new URL(url);
  if (!/^https?:$/.test(current.protocol)) throw new Error(`refusing ${current.protocol}`);

  for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
    if (/^(localhost|127\.0\.0\.1|\[?::1\]?)$/i.test(current.hostname)) {
      throw new Error('refusing loopback host');
    }
    try {
      const { address } = await lookupFn(current.hostname);
      if (isPrivateIp(address)) throw new Error(`refusing private address ${address}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('refusing')) throw err;
      throw new Error(`dns lookup failed: ${current.hostname}`);
    }

    const res = await fetch(current, {
      redirect: 'manual',
      headers: { 'user-agent': UA, accept: 'text/html,application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (res.status >= 300 && res.status < 400) {
      const target = res.headers.get('location');
      if (!target) throw new Error(`redirect ${res.status} without location`);
      const next = new URL(target, current);
      if (bareHost(next.hostname) !== bareHost(current.hostname)) {
        throw new Error(`refusing cross-domain redirect to ${next.hostname}`);
      }
      current = next;
      continue;
    }

    if (!res.ok) throw new Error(`page fetch failed: ${res.status}`);
    return { html: await readCapped(res), finalUrl: current };
  }
  throw new Error('too many redirects');
}

interface ShopifyJs {
  price?: number;
  variants?: Array<{ price?: number | string }>;
  featured_image?: string;
}

interface LdPrice {
  price?: string;
  currency?: string;
  image?: string;
}

function findProduct(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findProduct(n);
      if (hit) return hit;
    }
    return null;
  }
  const type = (node as { '@type'?: unknown })['@type'];
  if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) {
    return node as Record<string, unknown>;
  }
  const graph = (node as { '@graph'?: unknown })['@graph'];
  return graph ? findProduct(graph) : null;
}

function priceFromLd(html: string): LdPrice | null {
  const blocks = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, json] of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json.trim());
    } catch {
      continue;
    }
    const product = findProduct(parsed);
    if (!product) continue;

    const offers = Array.isArray(product.offers)
      ? product.offers[0]
      : product.offers;
    const raw = (offers as Record<string, unknown> | undefined) ?? {};
    const price = raw.price ?? raw.lowPrice;
    const images = product.image;
    return {
      price: price === undefined || price === null ? undefined : String(price),
      currency: typeof raw.priceCurrency === 'string' ? raw.priceCurrency : undefined,
      image: Array.isArray(images) ? String(images[0] ?? '') : images ? String(images) : undefined,
    };
  }
  return null;
}

function metaContent(html: string, name: string): string | undefined {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]+content=["']([^"']+)["']`,
    'i',
  );
  const forward = html.match(re)?.[1];
  if (forward) return forward;
  // content may precede property
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`,
    'i',
  );
  return html.match(re2)?.[1];
}

function priceFromMeta(html: string): LdPrice {
  return {
    price: metaContent(html, 'product:price:amount') ?? metaContent(html, 'og:price:amount'),
    currency:
      metaContent(html, 'product:price:currency') ?? metaContent(html, 'og:price:currency'),
    image: metaContent(html, 'og:image'),
  };
}

function normalisePrice(raw: string | number | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n <= 0 || n > 100_000) return null;
  return n.toFixed(2);
}

async function enrichOne(candidate: CatalogCandidate): Promise<void> {
  const page = await fetchGuarded(candidate.productUrl);

  let price: string | null = null;
  let currency: string | null = null;
  let image: string | undefined;
  let fromShopify = false;

  // 1. Shopify's public .js endpoint — the cleanest price source there is.
  if (page.finalUrl.pathname.includes('/products/')) {
    try {
      const jsUrl = `${page.finalUrl.origin}${page.finalUrl.pathname.replace(/\/$/, '')}.js`;
      const res = await fetch(jsUrl, {
        headers: { 'user-agent': UA, accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        const data = (await res.json()) as ShopifyJs;
        const cents =
          typeof data.price === 'number'
            ? data.price
            : Number(data.variants?.[0]?.price);
        price = normalisePrice(Number.isFinite(cents) ? cents / 100 : undefined);
        if (price) fromShopify = true;
        if (data.featured_image) {
          image = data.featured_image.startsWith('//')
            ? `https:${data.featured_image}`
            : data.featured_image;
        }
      }
    } catch {
      // .js is a bonus path — fall through to HTML parsing
    }
  }

  // 2 + 3. Page HTML for currency (and price when Shopify .js missed).
  const ld = priceFromLd(page.html);
  const meta = priceFromMeta(page.html);
  price = price ?? normalisePrice(ld?.price) ?? normalisePrice(meta.price);
  currency = ld?.currency ?? meta.currency ?? null;
  image = image ?? ld?.image ?? meta.image;

  if (price && !currency && fromShopify && bareHost(page.finalUrl.hostname).endsWith('.com')) {
    currency = 'USD';
  }

  if (price) candidate.priceAmount = price;
  if (currency) candidate.currency = currency;
  if (!candidate.imageUrl && image) candidate.imageUrl = image;
}

/**
 * Enrich price-less candidates in place — at most 3, concurrently. Any
 * failure is logged and swallowed; a candidate we can't enrich stays
 * view-only rather than failing the whole resolve.
 */
export async function enrichCandidates(candidates: CatalogCandidate[]): Promise<CatalogCandidate[]> {
  const targets = candidates.filter((c) => c.priceAmount == null).slice(0, 3);
  if (targets.length === 0) return candidates;

  const settled = await Promise.allSettled(targets.map(enrichOne));
  settled.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.log(`enrich: skipped ${targets[i].productUrl} — ${r.reason?.message ?? r.reason}`);
    }
  });
  return candidates;
}
