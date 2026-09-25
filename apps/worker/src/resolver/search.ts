import type { CatalogCandidate } from './catalog.ts';
import { searchByText as serpapiSearch } from './serpapi.ts';
import { searchByText as tavilySearch } from './tavily.ts';

export type SearchProvider = 'tavily' | 'serpapi';

/**
 * Which search backend resolve() talks to. SEARCH_PROVIDER wins when set;
 * otherwise pick whichever key exists. When both are configured the default
 * is serpapi — Google Shopping returns structured prices and merchant fields,
 * while Tavily makes the LLM recover prices from snippets.
 */
export function searchProvider(): SearchProvider {
  const explicit = process.env.SEARCH_PROVIDER;
  if (explicit === 'tavily' || explicit === 'serpapi') return explicit;
  if (process.env.SERPAPI_API_KEY) return 'serpapi';
  if (process.env.TAVILY_API_KEY) return 'tavily';
  // No key at all: still report a provider so callers get a clear env error.
  return 'serpapi';
}

export async function searchByText(query: string, limit = 3): Promise<CatalogCandidate[]> {
  return searchProvider() === 'tavily' ? tavilySearch(query, limit) : serpapiSearch(query, limit);
}
