import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from './resolve.ts';

const KEYS = ['DEMO_MODE', 'OPENAI_API_KEY', 'NVIDIA_API_KEY', 'SERPAPI_API_KEY'];
let saved: Record<string, string | undefined>;
let calls: Array<{ url: string; init: RequestInit }>;
let realFetch: typeof fetch;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  calls = [];
  realFetch = globalThis.fetch;

  // The whole pipeline needs both keys for demo mode to stay off.
  process.env.OPENAI_API_KEY = 'oai';
  process.env.SERPAPI_API_KEY = 'serp';

  // @ts-expect-error — test double
  globalThis.fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        shopping_results: [
          {
            title: 'Black Jacket',
            product_link: 'https://store.example/jacket',
            source: 'Example Store',
            price: '$128.00',
            extracted_price: 128,
            thumbnail: 'https://cdn.example/j.jpg',
          },
        ],
      }),
      text: async () => '{}',
    };
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('resolve (text-only path)', () => {
  test('skips identify entirely and searches on the sender’s words', async () => {
    const result = await resolve({ media: null, text: 'black denim jacket' });

    // The only outbound call is SerpAPI — no OpenAI/NIM vision call was made.
    assert.equal(
      calls.every((c) => !/openai\.com|nvidia\.com/.test(c.url)),
      true,
    );
    assert.match(calls[0].url, /serpapi\.com\/search\.json/);
    assert.match(calls[0].url, /q=black\+denim\+jacket/);

    assert.equal(result.signal.searchQuery, 'black denim jacket');
    assert.equal(result.candidates[0].title, 'Black Jacket');
    // No brand → never 'exact' even at higher confidences.
    assert.equal(result.resolution, 'similar');
  });

  test('throws when neither media nor text is supplied', async () => {
    await assert.rejects(() => resolve({ media: null }), /neither media nor text/);
  });
});
