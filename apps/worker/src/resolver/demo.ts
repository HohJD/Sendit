import type { CatalogCandidate } from './catalog.ts';
import type { ResolveResult } from './resolve.ts';
import type { ProductSignal } from './identify.ts';
import { identifyApiKeyName, identifyProvider } from './llm.ts';
import { searchProvider } from './search.ts';

/**
 * Demo mode: canned matches instead of vision + paid search. Triggers three
 * ways — forced via DEMO_MODE, or implicitly when there is no vision key and
 * no search key to run the real pipeline with. Any trigger short-circuits the
 * whole resolve so a partial key set can't half-run and crash mid-call.
 */
export function demoReason(): string | null {
  if (process.env.DEMO_MODE === 'true') return 'DEMO_MODE=true';
  const modelProvider = identifyProvider();
  const modelKey = identifyApiKeyName();
  const search = searchProvider();
  const searchKey = search === 'tavily' ? 'TAVILY_API_KEY' : 'SERPAPI_API_KEY';
  if (!process.env[modelKey]?.trim()) return `missing ${modelKey} for ${modelProvider}`;
  if (!process.env[searchKey]?.trim()) return `missing ${searchKey} for ${search}`;
  return null;
}

export function demoEnabled(): boolean {
  return demoReason() !== null;
}

interface DemoEntry extends CatalogCandidate {
  keywords: string[];
}

/**
 * Real DTC product pages so the demo's checkout step still drives a real
 * merchant — every URL and image verified reachable (curl 200) at write time.
 */
const DEMO_CATALOG: DemoEntry[] = [
  {
    productId: 'demo-jacket',
    title: 'The Long Haul Jacket in Indigo Waffle',
    merchant: 'Taylor Stitch',
    merchantDomain: 'taylorstitch.com',
    priceAmount: '128.00',
    currency: 'USD',
    imageUrl:
      'https://cdn.shopify.com/s/files/1/0070/1922/products/mens_workshop_Q218_product_long_haul_waffle_indigo_001.jpg?v=1762198633',
    productUrl: 'https://www.taylorstitch.com/products/the-long-haul-jacket-in-indigo-waffle',
    keywords: ['jacket', 'coat', 'denim', 'waffle', 'outerwear', 'trucker'],
  },
  {
    productId: 'demo-sneakers',
    title: "Men's Wool Runner - True Black",
    merchant: 'Allbirds',
    merchantDomain: 'allbirds.com',
    priceAmount: '110.00',
    currency: 'USD',
    imageUrl:
      'https://cdn.shopify.com/s/files/1/1104/4168/files/Allbirds_WL_RN_SF_PDP_Natural_Black_LAT.png?v=1751143102',
    productUrl: 'https://www.allbirds.com/products/mens-wool-runners-true-black',
    keywords: ['sneaker', 'sneakers', 'shoe', 'shoes', 'runner', 'runners', 'trainers', 'wool'],
  },
  {
    productId: 'demo-backpack',
    title: '18L Packable Backpack',
    merchant: 'Matador',
    merchantDomain: 'matadorequipment.com',
    priceAmount: '75.00',
    currency: 'USD',
    imageUrl:
      'https://cdn.shopify.com/s/files/1/0585/0209/files/MATZPB18001BK_Matador_PackableBackpack_Black_1.jpg?v=1780074429',
    productUrl: 'https://www.matadorequipment.com/products/18l-packable-backpack',
    keywords: ['bag', 'backpack', 'rucksack', 'pack', 'sling', 'tote'],
  },
  {
    productId: 'demo-sunglasses',
    title: 'High Key Mini Sunglasses',
    merchant: 'Quay',
    merchantDomain: 'quayaustralia.com',
    priceAmount: '65.00',
    currency: 'USD',
    imageUrl:
      'https://www.quay.com/cdn/shop/files/QUAY_HIGHKEY_BLACKFADEPOL_0001_ff67b990-13ae-449e-8f0a-43aab704d7ee.jpg?v=1758927399',
    productUrl: 'https://www.quayaustralia.com/products/high-key-mini',
    keywords: ['sunglasses', 'glasses', 'shades', 'aviator'],
  },
  {
    productId: 'demo-watch',
    title: 'Chrono Monochrome Grey 45mm',
    merchant: 'MVMT',
    merchantDomain: 'mvmt.com',
    priceAmount: '148.00',
    currency: 'USD',
    imageUrl: 'https://mvmt.com/cdn/shop/files/MC01-BBLGR_fr.jpg?v=1785322877&width=2048',
    productUrl: 'https://www.mvmt.com/products/chrono-monochrome-grey-45mm-mc01-bblgr',
    keywords: ['watch', 'watches', 'chrono', 'chronograph', 'wristwatch'],
  },
  {
    productId: 'demo-hoodie',
    title: "Men's Merino Wool Half Zip Sweater",
    merchant: 'Pangaia',
    merchantDomain: 'pangaia.com',
    priceAmount: '195.00',
    currency: 'USD',
    imageUrl:
      'https://cdn.shopify.com/s/files/1/0035/1309/0115/files/10002831_9868_Mens_Merino_Wool_Half_Zip_Sweater_Black.jpg?v=1790086559',
    productUrl: 'https://www.pangaia.com/products/mens-merino-wool-half-zip-sweater-black',
    keywords: ['hoodie', 'hooded', 'sweater', 'sweatshirt', 'jumper', 'pullover', 'zip'],
  },
];

/**
 * Keyword match against whatever text came with the share. The matched entry
 * leads, two neighbours trail as alternates; a total miss defaults to the
 * jacket — the point of demo mode is that the pipeline always produces
 * something tappable.
 */
export function demoResolve(params: { text?: string; caption?: string }): ResolveResult {
  const haystack = `${params.text ?? ''} ${params.caption ?? ''}`.toLowerCase();
  const hit = DEMO_CATALOG.findIndex((entry) =>
    entry.keywords.some((kw) => haystack.includes(kw)),
  );

  const order =
    hit >= 0
      ? [DEMO_CATALOG[hit], DEMO_CATALOG[(hit + 1) % DEMO_CATALOG.length], DEMO_CATALOG[(hit + 2) % DEMO_CATALOG.length]]
      : DEMO_CATALOG.slice(0, 3);

  const query = params.text ?? params.caption ?? '';
  const signal: ProductSignal = {
    brand: null,
    productType: hit >= 0 ? (order[0].keywords[0] ?? 'product') : 'product',
    color: null,
    distinguishingFeatures: [],
    searchQuery: query || (hit >= 0 ? order[0].title : 'product'),
    confidence: 'medium',
  };

  console.log(`demo: canned results (${demoReason()})`);

  return {
    signal,
    candidates: order.map(({ keywords: _k, ...c }) => c),
    resolution: hit >= 0 ? 'exact' : 'similar',
  };
}
