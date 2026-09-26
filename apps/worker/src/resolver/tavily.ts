import type { CatalogCandidate } from './catalog.ts';
import { getClient, identifyModel, providerOptions } from './llm.ts';
import { enrichCandidates } from './enrich.ts';
import { findShopifyProduct, isShopifyStore } from './shopify.ts';

/**
 * Tavily search + LLM extraction as a drop-in for serpapi.ts.
 *
 * Tavily is a general web index, not a shopping engine — results carry no
 * price field, so prices are recovered from page snippets by the same LLM the
 * resolver already uses. Two consequences: candidates with no price render
 * view-only (no "Buy" affordance), and extraction is only as good as the
 * snippets — the model is kept on a short leash by restricting it to URLs
 * Tavily actually returned.
 */

const TAVILY_URL = 'https://api.tavily.com/search';

/**
 * Marketplaces and social/UGC hosts are excluded at the search level: the
 * checkout agent can only drive in-page, Shopify-style checkouts — a listing
 * on Amazon or an Etsy shop would resolve fine and then stall at payment.
 */
const EXCLUDE_DOMAINS = [
  'amazon.com',
  'ebay.com',
  'walmart.com',
  'aliexpress.com',
  'temu.com',
  'etsy.com',
  'pinterest.com',
  'reddit.com',
  'youtube.com',
  'tiktok.com',
  'instagram.com',
  'facebook.com',
  // Resale / marketplace hosts — same reason as above: their checkout isn't a
  // plain in-page Shopify-style flow the agent can drive.
  'poshmark.com',
  'shein.com',
  'depop.com',
  'mercari.com',
  'grailed.com',
  'vinted.com',
  'vinted.co.uk',
  'therealreal.com',
  'vestiairecollective.com',
  'stockx.com',
  'goat.com',
  'farfetch.com',
  // Big-box / department stores — checkouts the agent can't drive.
  'target.com',
  'bestbuy.com',
  'macys.com',
  'nordstrom.com',
  'kohls.com',
  'zappos.com',
  'asos.com',
  'shop.app',
];

/** Strip tracking params/hash/trailing slash so a product URL is canonical. */
function canonicalise(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (key !== 'variant') u.searchParams.delete(key);
    }
    u.hash = '';
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return null;
  }
}

const PRODUCT_PATH = /\/(products?|p|dp|item|items)\/[^/?]+|\/shop\/[^/]+\/[^/]+/i;
const NON_PRODUCT_PATH = /^\/?$|^\/(collections?|category|c|search|pages?|blogs?|tags?)(\/|$)/i;
const NON_PRODUCT_HOST = /^(shop\.app|(.*\.)?(google|bing|youtube)\.com|(.*\.)?pinterest\.[a-z.]+)$/i;

/**
 * Is this URL plausibly a single-product page? Used to keep collections,
 * store roots and aggregator hosts out of the extraction — and out of the
 * candidate list even if the model returns them anyway.
 */
export function isProductPage(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (NON_PRODUCT_HOST.test(u.hostname)) return false;
  const path = u.pathname.replace(/\/$/, '') || '/';
  if (NON_PRODUCT_PATH.test(path)) return false;
  if (PRODUCT_PATH.test(path)) return true;
  const segments = path.split('/').filter(Boolean);
  return segments.length >= 2 && /\.html?$/i.test(path);
}

/** Tavily's exclude_domains doesn't reliably cover subdomains (us.shein.com), so we re-check. */
function isExcludedDomain(domain: string | null): boolean {
  return !!domain && EXCLUDE_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
}

interface TavilyResponse {
  results?: TavilyResult[];
  images?: string[];
  /** Per Tavily docs, images may also arrive grouped per result. */
  [key: string]: unknown;
}

const SYSTEM = `You turn web search results into shopping candidates. Given a product query and search results (title, url, snippet), return ONLY JSON: {"candidates": [{"title": string, "merchant": string, "merchant_domain": string, "price_amount": string | null, "currency": string | null, "product_url": string}]}. Include a result only if its URL is a single product page on a store that sells the item (not a category, review, blog, marketplace, or social page). Prefer the brand's own store or a specialist retailer; exclude resale, second-hand and marketplace listings. price_amount is a plain decimal like "128.00" only when the snippet states the price; otherwise null. Order by how well the result matches the query. Return at most {N} candidates.`;

interface RawCandidate {
  title?: string;
  merchant?: string;
  merchant_domain?: string;
  price_amount?: string | null;
  currency?: string | null;
  product_url?: string;
}

/** Models hand back "128", "128.0", "$128.00" — we store a plain 2dp decimal. */
function normaliseAmount(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const n = Number(String(raw).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : null;
}

function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export interface SearchOptions {
  /** Identified brand — used to prefer brand-domain candidates and origins. */
  brand?: string | null;
}

export async function searchByText(
  query: string,
  limit = 3,
  opts: SearchOptions = {},
): Promise<CatalogCandidate[]> {
  const apiKey = requireEnv('TAVILY_API_KEY');

  const res = await fetch(TAVILY_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      query: `${query} buy`,
      search_depth: 'advanced',
      max_results: 10,
      include_images: true,
      include_raw_content: false,
      exclude_domains: EXCLUDE_DOMAINS,
    }),
  });

  if (!res.ok) {
    throw new Error(`tavily search failed: ${res.status} ${await res.text().catch(() => '')}`);
  }

  const body = (await res.json()) as TavilyResponse;
  const rawResults = body.results ?? [];

  // Canonicalise + dedupe before anything downstream: Tavily happily returns
  // the same product page three times wearing different tracking params.
  const seen = new Set<string>();
  const results: TavilyResult[] = [];
  for (const r of rawResults) {
    const url = canonicalise(r.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    if (isExcludedDomain(domainOf(url))) continue;
    results.push({ ...r, url });
  }
  if (results.length === 0) return [];

  const brandToken = (opts.brand ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  // Hosts worth probing for Shopify JSON: the brand domain, or any host
  // containing a distinctive query token (brand names often survive only as
  // query text when identify() can't isolate a brand field).
  const hostTokens = [
    brandToken,
    ...query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4),
  ].filter(Boolean);
  const onBrandHost = (url: string | undefined) =>
    !!brandToken && !!url && domainOf(url)?.includes(brandToken);

  // Only single-product pages may become candidates. When there aren't at
  // least two, collection/root results are still shown to the model — marked
  // — purely as brand/store context.
  const productResults = results.filter((r) => r.url && isProductPage(r.url));
  const contextResults = results.filter((r) => r.url && !isProductPage(r.url));
  const shown =
    productResults.length >= 2
      ? productResults.map((r) => ({ r, note: '' }))
      : [
          ...productResults.map((r) => ({ r, note: '' })),
          ...contextResults.map((r) => ({ r, note: '   [category page — not a product]' })),
        ];

  const listing = shown
    .map(({ r, note }, i) => `${i + 1}. ${r.title ?? ''}\n   ${r.url ?? ''}\n   ${r.content ?? ''}${note}`)
    .join('\n\n');

  const completion = await getClient().chat.completions.create({
    ...providerOptions(),
    model: identifyModel(),
    temperature: 0.1,
    top_p: 1,
    max_tokens: 1024,
    stream: false,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM.replace('{N}', String(limit)) },
      {
        role: 'user',
        content: `Product query: ${query}\n\nSearch results:\n${listing}`,
      },
    ],
  });

  console.log(`tavily extraction: model used ${completion.model ?? identifyModel()}`);

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error(
      `tavily extraction: no content in completion response (model ${completion.model ?? identifyModel()})`,
    );
  }

  let parsed: { candidates?: RawCandidate[] };
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`tavily extraction: model did not return valid JSON: ${content.slice(0, 200)}`);
  }

  // The model only ever sees URLs from Tavily, but trust nothing: a candidate
  // whose canonical URL isn't a product page Tavily returned is a
  // hallucination — or a collection page — and gets dropped either way.
  const validUrls = new Set(productResults.map((r) => r.url).filter(Boolean));
  const imagesByUrl = new Map<string, string[]>();
  for (const r of results) {
    if (r.url) {
      const perResult = (r as { images?: string[] }).images;
      imagesByUrl.set(r.url, Array.isArray(perResult) ? perResult : []);
    }
  }

  const candidates: CatalogCandidate[] = [];
  for (const c of parsed.candidates ?? []) {
    if (candidates.length >= limit) break;
    const canonical = canonicalise(c.product_url);
    if (!canonical || !validUrls.has(canonical)) continue;
    const merchantDomain = domainOf(canonical);
    if (isExcludedDomain(merchantDomain)) continue;

    candidates.push({
      productId: canonical,
      title: c.title ?? 'Unknown product',
      merchant: c.merchant ?? null,
      merchantDomain,
      priceAmount: normaliseAmount(c.price_amount),
      currency: c.currency ?? null,
      imageUrl: imagesByUrl.get(canonical)?.[0] ?? body.images?.[0] ?? null,
      productUrl: canonical,
    });
  }

  // Priced candidates first, then brand-domain matches — a view-only card can
  // never reach checkout, so it should never lead.
  candidates.sort((a, b) => rank(b) - rank(a));
  function rank(c: CatalogCandidate): number {
    return (c.priceAmount ? 2 : 0) + (onBrandHost(c.productUrl) ? 1 : 0);
  }

  // Snippets rarely carry prices — recover them from the product pages
  // directly so candidates render buyable instead of view-only.
  await enrichCandidates(candidates);

  // Still no priced top card — or the top card isn't on a host that mentions
  // the brand/query? The store is almost certainly Shopify — ask it directly
  // for the product instead of leaving the share view-only or off-brand.
  const topOnKnownHost =
    !!candidates[0] &&
    hostTokens.some((t) => domainOf(candidates[0].productUrl)?.includes(t));
  if (!candidates[0]?.priceAmount || !topOnKnownHost) {
    const counts = new Map<string, number>();
    for (const r of results) {
      const host = r.url ? domainOf(r.url) : null;
      if (host) counts.set(host, (counts.get(host) ?? 0) + 1);
    }
    const origins = [...counts.entries()]
      .sort((a, b) => {
        const aBrand = hostTokens.some((t) => a[0].includes(t)) ? 1 : 0;
        const bBrand = hostTokens.some((t) => b[0].includes(t)) ? 1 : 0;
        return bBrand - aBrand || b[1] - a[1];
      })
      .map(([host]) => `https://${host}`);

    for (const origin of origins.slice(0, 2)) {
      const found = await findShopifyProduct(origin, query).catch(() => null);
      if (!found) continue;
      // Proven Shopify by detection — keep it marked even if the probe below flakes.
      found.checkoutSupported = true;
      const foundOnTokenHost = hostTokens.some((t) =>
        domainOf(found.productUrl)?.includes(t),
      );
      // Jump the queue only for a priced product on a brand/query-matching
      // host, or when the alternative is an empty/view-only list.
      if (found.priceAmount && (!candidates[0]?.priceAmount || foundOnTokenHost)) {
        candidates.unshift(found);
        break;
      }
      if (candidates.length === 0) candidates.push(found);
    }
  }

  // Flag which stores the checkout agent can actually drive. A priced product
  // on a non-Shopify storefront can never be bought — it must not outrank a
  // Shopify one just because it carried a price.
  const probeOrigins = [
    ...new Set(
      candidates
        .slice(0, 5)
        .map((c) => domainOf(c.productUrl))
        .filter((h): h is string => !!h)
        .map((h) => `https://${h}`),
    ),
  ];
  const probes = await Promise.allSettled(probeOrigins.map((o) => isShopifyStore(o)));
  const supported = new Map<string, boolean>(
    probeOrigins.map((o, i) => [
      o,
      probes[i]?.status === 'fulfilled' ? probes[i].value : false,
    ]),
  );
  for (const c of candidates) {
    const host = domainOf(c.productUrl);
    // Beyond the 5 probed origins the flag stays undefined — unknown, not false.
    c.checkoutSupported ??= host ? supported.get(`https://${host}`) : undefined;
  }

  candidates.sort((a, b) => finalRank(b) - finalRank(a));
  function finalRank(c: CatalogCandidate): number {
    return (
      (c.checkoutSupported && c.priceAmount ? 4 : 0) +
      (c.priceAmount ? 2 : 0) +
      (onBrandHost(c.productUrl) ? 1 : 0)
    );
  }
  console.log(
    `tavily: ${candidates.length} candidates, ${[...supported.values()].filter(Boolean).length} on Shopify (agent-checkout capable)`,
  );

  return candidates;
}
