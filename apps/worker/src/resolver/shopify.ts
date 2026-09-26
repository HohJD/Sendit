import type { CatalogCandidate } from './catalog.ts';
import { safeFetch } from './enrich.ts';

/**
 * Turn a store origin into a priced product candidate using Shopify's public
 * JSON endpoints — no auth needed on any standard Shopify storefront:
 *
 *   /meta.json                          → shop info (also our "is Shopify" probe)
 *   /search/suggest.json?q=…            → lightweight product suggestions
 *   /products.json?limit=250            → full catalog, title-matched as fallback
 *
 * Returns null for non-Shopify origins and when nothing matches. Never throws
 * for network reasons — safeFetch failures just mean "can't help here".
 */

interface SuggestResponse {
  resources?: { results?: { products?: SuggestProduct[] } };
}

interface SuggestProduct {
  title?: string;
  url?: string; // path like /products/<handle>
  price?: string;
  image?: string;
  featured_image?: { url?: string } | string;
  handle?: string;
}

interface ProductsResponse {
  products?: Array<{
    title?: string;
    handle?: string;
    images?: Array<{ src?: string }>;
    variants?: Array<{ price?: string | number }>;
  }>;
}

interface MetaResponse {
  name?: string;
  currency?: string;
}

/** suggest.json URLs arrive with tracking params (_pos/_psq/_ss…) — strip them. */
function abs(origin: string, path: string): string {
  const u = new URL(path, origin);
  for (const key of [...u.searchParams.keys()]) {
    if (key !== 'variant') u.searchParams.delete(key);
  }
  u.hash = '';
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

function normalisePrice(raw: string | number | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n <= 0 || n > 100_000) return null;
  return n.toFixed(2);
}

function score(query: string, title: string): number {
  const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  const hay = title.toLowerCase();
  return tokens.filter((t) => hay.includes(t)).length;
}

async function detectShopify(origin: string): Promise<{ shopify: boolean; currency: string | null }> {
  try {
    const meta = await safeFetch(`${origin}/meta.json`);
    const data = JSON.parse(meta.html) as MetaResponse;
    if (data && typeof data === 'object' && (data.name || data.currency)) {
      return { shopify: true, currency: typeof data.currency === 'string' ? data.currency : null };
    }
  } catch {
    // fall through to the HTML probe
  }
  try {
    const home = await safeFetch(origin);
    if (/cdn\.shopify\.com|Shopify\.theme/i.test(home.html)) {
      return { shopify: true, currency: null };
    }
  } catch {
    // not reachable
  }
  return { shopify: false, currency: null };
}

export async function findShopifyProduct(
  origin: string,
  query: string,
): Promise<CatalogCandidate | null> {
  const base = origin.replace(/\/$/, '');
  const host = new URL(base).hostname.replace(/^www\./, '');
  const { shopify, currency } = await detectShopify(base);
  if (!shopify) {
    console.log(`shopify: ${base} not a shopify store`);
    return null;
  }

  // Documented assumption, same as enrich.ts: Shopify JSON has no currency —
  // meta.json's `currency` wins, else USD only on .com DTC stores.
  const fallbackCurrency =
    currency ?? (host.endsWith('.com') ? 'USD' : null);

  // 1. Predictive search — cheap and already relevance-ranked.
  try {
    const sug = await safeFetch(
      `${base}/search/suggest.json?q=${encodeURIComponent(query)}&resources[type]=product&resources[limit]=5`,
    );
    const products = (JSON.parse(sug.html) as SuggestResponse).resources?.results?.products ?? [];
    let best: SuggestProduct | null = null;
    let bestScore = -1;
    for (const p of products) {
      const s = score(query, p.title ?? '');
      if (s > bestScore) {
        best = p;
        bestScore = s;
      }
    }
    if (best?.title && best.url) {
      const price = normalisePrice(best.price);
      const img =
        typeof best.featured_image === 'string'
          ? best.featured_image
          : (best.featured_image?.url ?? best.image ?? null);
      const productUrl = abs(base, best.url);
      console.log(`shopify: ${base} → ${best.title} ${price ?? 'no price'}`);
      return {
        productId: productUrl,
        title: best.title,
        merchant: host,
        merchantDomain: host,
        priceAmount: price,
        currency: price ? fallbackCurrency : null,
        imageUrl: img ? abs(base, img) : null,
        productUrl,
      };
    }
  } catch {
    // suggest.json missing/blocked — fall through to the catalog dump
  }

  // 2. Full catalog dump, best title match.
  try {
    const all = await safeFetch(`${base}/products.json?limit=250`);
    const products = (JSON.parse(all.html) as ProductsResponse).products ?? [];
    let best: (typeof products)[number] | null = null;
    let bestScore = -1;
    for (const p of products) {
      const s = score(query, p.title ?? '');
      if (s > bestScore) {
        best = p;
        bestScore = s;
      }
    }
    if (best?.title && best.handle) {
      const price = normalisePrice(best.variants?.[0]?.price);
      const productUrl = `${base}/products/${best.handle}`;
      console.log(`shopify: ${base} → ${best.title} ${price ?? 'no price'}`);
      return {
        productId: productUrl,
        title: best.title,
        merchant: host,
        merchantDomain: host,
        priceAmount: price,
        currency: price ? fallbackCurrency : null,
        imageUrl: best.images?.[0]?.src ?? null,
        productUrl,
      };
    }
  } catch {
    // nothing usable
  }

  console.log(`shopify: ${base} no match`);
  return null;
}
