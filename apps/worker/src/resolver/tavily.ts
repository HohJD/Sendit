import type { CatalogCandidate } from './catalog.ts';
import { getClient, identifyModel, providerOptions } from './llm.ts';
import { enrichCandidates } from './enrich.ts';

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
];

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

export async function searchByText(query: string, limit = 3): Promise<CatalogCandidate[]> {
  const apiKey = requireEnv('TAVILY_API_KEY');

  const res = await fetch(TAVILY_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      query: `${query} buy`,
      search_depth: 'basic',
      max_results: 8,
      include_images: true,
      include_raw_content: false,
      exclude_domains: EXCLUDE_DOMAINS,
    }),
  });

  if (!res.ok) {
    throw new Error(`tavily search failed: ${res.status} ${await res.text().catch(() => '')}`);
  }

  const body = (await res.json()) as TavilyResponse;
  const results = body.results ?? [];
  if (results.length === 0) return [];

  const listing = results
    .map((r, i) => `${i + 1}. ${r.title ?? ''}\n   ${r.url ?? ''}\n   ${r.content ?? ''}`)
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
  // whose URL isn't in the result set is a hallucination and gets dropped.
  const validUrls = new Set(results.map((r) => r.url).filter(Boolean));
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
    if (!c.product_url || !validUrls.has(c.product_url)) continue;
    const merchantDomain = domainOf(c.product_url);
    if (isExcludedDomain(merchantDomain)) continue;

    candidates.push({
      productId: c.product_url,
      title: c.title ?? 'Unknown product',
      merchant: c.merchant ?? null,
      merchantDomain,
      priceAmount: normaliseAmount(c.price_amount),
      currency: c.currency ?? null,
      imageUrl: imagesByUrl.get(c.product_url)?.[0] ?? body.images?.[0] ?? null,
      productUrl: c.product_url,
    });
  }

  // Snippets rarely carry prices — recover them from the product pages
  // directly so candidates render buyable instead of view-only.
  await enrichCandidates(candidates);
  return candidates;
}
