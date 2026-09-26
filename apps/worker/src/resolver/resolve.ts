import { identify, type ProductSignal } from './identify.ts';
import type { CatalogCandidate } from './catalog.ts';
import { searchByText } from './search.ts';
import { demoEnabled, demoResolve } from './demo.ts';
import type { ShareMedia } from './media.ts';

export interface ResolveResult {
  signal: ProductSignal;
  candidates: CatalogCandidate[];
  /** Drives which tier of dashboard card renders — see @prava/db's `resolution` enum. */
  resolution: 'exact' | 'similar' | 'none';
}

/**
 * identify() → Google Shopping text search. Deliberately text-only: the
 * search_query identify() produces is already built to stand on its own as a
 * shopping-engine query. Catalog MCP (catalog.ts) is the intended backend but
 * needs client credentials we don't have; serpapi.ts returns the same shape.
 *
 * A text-only share skips identify entirely — the sender's own words already
 * are the query. And in demo mode the whole pipeline short-circuits to canned
 * candidates so the chat flow works without vision or search keys.
 */
export async function resolve(params: {
  media: ShareMedia | null;
  text?: string;
}): Promise<ResolveResult> {
  if (demoEnabled()) {
    return demoResolve({ text: params.text, caption: params.media?.caption });
  }

  let signal: ProductSignal;
  if (params.media) {
    signal = await identify(params.media);
  } else {
    if (!params.text) throw new Error('resolve: neither media nor text supplied');
    signal = {
      brand: null,
      productType: params.text,
      color: null,
      distinguishingFeatures: [],
      searchQuery: params.text,
      confidence: 'medium',
    };
  }

  let candidates = await searchByText(signal.searchQuery, 3, { brand: signal.brand });

  // A very specific query can match nothing at all. Retry once on the coarse
  // description before giving up — a 'similar' match beats an empty card, and
  // this only costs a call when the precise query already failed.
  if (candidates.length === 0) {
    const coarse = [signal.brand, signal.color, signal.productType].filter(Boolean).join(' ');
    if (coarse && coarse !== signal.searchQuery) {
      candidates = await searchByText(coarse, 3, { brand: signal.brand });
    }
  }

  const resolution: ResolveResult['resolution'] =
    candidates.length === 0 ? 'none' : signal.confidence === 'high' && signal.brand ? 'exact' : 'similar';

  return { signal, candidates, resolution };
}
