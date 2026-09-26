/**
 * Client for Shopify's Global Catalog MCP — the discoverability layer.
 * Confirmed against shopify.dev (read 2026-07-30):
 *
 *   Token:   POST https://api.shopify.com/auth/access_token
 *            body { client_id, client_secret, grant_type: "client_credentials" }
 *            → { access_token }, expires in 60 minutes — refetched here on demand,
 *            not proactively refreshed, since this runs per-resolve, not as a daemon.
 *
 *   Catalog: POST https://catalog.shopify.com/api/ucp/mcp
 *            JSON-RPC 2.0, method "tools/call", params.name = "search_catalog".
 *            The agent profile goes INSIDE the call, at
 *            params.arguments.meta["ucp-agent"].profile — not a header, not a
 *            top-level JSON-RPC field. This is the one detail their docs make
 *            explicit with a concrete example, so it's load-bearing here.
 *
 * NOT verified live yet — flagged rather than silently assumed correct:
 *   - The exact shape of an image passed to `catalog.like` (URL vs base64 vs an
 *     MCP content-block array). Their own tool docs say only "pass an image" without
 *     specifying the field. searchByImage() below is a best-effort guess (data URI
 *     under `like.image`) — verify against a real call before trusting it, the same
 *     way /v1/payment-result turned out not to be a query-param endpoint despite
 *     reading like one in prose.
 *   - The result envelope's exact content shape (assumed MCP-standard
 *     `result.content: [{type:"text", text: "<json>"}]` — parsed defensively below).
 *
 * Terms of service note: don't cache search results or images across requests —
 * every resolve() call must hit this live, which is why there is no cache layer
 * here beyond the 60-minute token.
 */

const TOKEN_URL = 'https://api.shopify.com/auth/access_token';
const CATALOG_URL = 'https://catalog.shopify.com/api/ucp/mcp';

let cachedToken: { value: string; expiresAt: number } | null = null;

/** Test-only: the token cache is module-scoped, so tests need a way to clear it between cases. */
export function __resetCatalogTokenCacheForTests(): void {
  cachedToken = null;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: requireEnv('SHOPIFY_CATALOG_CLIENT_ID'),
      client_secret: requireEnv('SHOPIFY_CATALOG_CLIENT_SECRET'),
      grant_type: 'client_credentials',
    }),
  });

  if (!res.ok) {
    throw new Error(`Catalog token exchange failed: HTTP ${res.status}`);
  }

  const body = (await res.json()) as { access_token: string };
  // Refresh 5 minutes early rather than racing the exact 60-minute edge.
  cachedToken = { value: body.access_token, expiresAt: Date.now() + 55 * 60 * 1000 };
  return body.access_token;
}

export interface CatalogCandidate {
  productId: string;
  title: string;
  merchant: string | null;
  merchantDomain: string | null;
  priceAmount: string | null;
  currency: string | null;
  imageUrl: string | null;
  productUrl: string;
  /**
   * True when the merchant runs a Shopify storefront the checkout agent can
   * drive; false when probed and not Shopify; undefined when unprobed
   * (treated as "allow" — unknown must not dead-end a priced card).
   */
  checkoutSupported?: boolean;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const token = await getAccessToken();

  const res = await fetch(CATALOG_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name,
        arguments: {
          ...args,
          meta: { 'ucp-agent': { profile: requireEnv('UCP_AGENT_PROFILE_URL') } },
        },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Catalog MCP call failed: HTTP ${res.status}`);
  }

  const body = (await res.json()) as {
    error?: { message: string };
    result?: { content?: Array<{ type: string; text?: string }> };
  };

  if (body.error) throw new Error(`Catalog MCP error: ${body.error.message}`);

  // Defensive: unwrap the standard MCP text-content envelope, but don't
  // assume it's the only shape their server actually returns.
  const textBlock = body.result?.content?.find((c) => c.type === 'text' && c.text);
  if (!textBlock?.text) throw new Error('Catalog MCP returned no parseable content');

  return JSON.parse(textBlock.text);
}

function toCandidates(raw: unknown): CatalogCandidate[] {
  const items = Array.isArray((raw as { products?: unknown[] })?.products)
    ? (raw as { products: unknown[] }).products
    : Array.isArray(raw)
      ? raw
      : [];

  return items.map((item) => {
    const p = item as Record<string, unknown>;
    return {
      productId: String(p.product_id ?? p.id ?? ''),
      title: String(p.title ?? p.name ?? 'Unknown product'),
      merchant: (p.merchant as string) ?? null,
      merchantDomain: (p.merchant_domain as string) ?? null,
      priceAmount: (p.price as string) ?? null,
      currency: (p.currency as string) ?? null,
      imageUrl: (p.image_url as string) ?? null,
      productUrl: String(p.url ?? p.product_url ?? ''),
    };
  });
}

/** Text search — the confirmed, straightforward path. */
export async function searchByText(query: string): Promise<CatalogCandidate[]> {
  const raw = await callTool('search_catalog', { catalog: { query } });
  return toCandidates(raw);
}

/**
 * Multimodal search — pairs a text query with an image for tighter matching.
 * The `like.image` shape below is unverified; see the module comment.
 */
export async function searchByImage(query: string, imageDataUrl: string): Promise<CatalogCandidate[]> {
  const raw = await callTool('search_catalog', {
    catalog: { query, like: { image: imageDataUrl } },
  });
  return toCandidates(raw);
}
