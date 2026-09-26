import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from './resolve.ts';
import { __resetClientForTests } from './llm.ts';
import { __setLookupForTests } from './enrich.ts';

const KEYS = ['DEMO_MODE', 'LLM_PROVIDER', 'IDENTIFY_MODEL', 'SEARCH_PROVIDER', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'NVIDIA_API_KEY', 'SERPAPI_API_KEY', 'TAVILY_API_KEY'];
let saved: Record<string, string | undefined>;
let calls: Array<{ url: string; init: RequestInit }>;
let realFetch: typeof fetch;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  calls = [];
  realFetch = globalThis.fetch;
  __resetClientForTests();
  // Enrichment/Shopify probing does a DNS check — never hit real DNS in tests.
  __setLookupForTests(async () => ({ address: '93.184.216.34', family: 4 }) as never);
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
  __resetClientForTests();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('resolve (OpenRouter + Tavily)', () => {
  test('an image goes through OpenRouter vision, Tavily, and OpenRouter extraction', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.SERPAPI_API_KEY;
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.IDENTIFY_MODEL = 'openai/gpt-4.1-mini';
    process.env.SEARCH_PROVIDER = 'tavily';
    process.env.OPENROUTER_API_KEY = 'router-test';
    process.env.TAVILY_API_KEY = 'tavily-test';
    process.env.DEMO_MODE = 'false';
    const productUrl = 'https://store.example/products/jacket';
    const signal = { brand: 'Example', product_type: 'jacket', color: 'black',
      distinguishing_features: ['denim'], search_query: 'Example black denim jacket', confidence: 'high' };
    const candidates = [{ title: 'Black Denim Jacket', merchant: 'Example Store',
      price_amount: '128.00', currency: 'USD', product_url: productUrl }];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      const body = url === 'https://api.tavily.com/search'
        ? { results: [{ url: productUrl, title: 'Black Denim Jacket', content: 'Price: USD 128.00', images: ['https://store.example/jacket.png'] }] }
        : { id: 'mock-completion', object: 'chat.completion', choices: [{ index: 0,
          finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(calls.length === 1 ? signal : { candidates }) } }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
    const result = await resolve({ media: { imageBase64, mediaType: 'image/png' } });
    assert.deepEqual(calls.map((c) => c.url), [
      'https://openrouter.ai/api/v1/chat/completions',
      'https://api.tavily.com/search',
      'https://openrouter.ai/api/v1/chat/completions',
    ]);
    assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer router-test');
    assert.equal(new Headers(calls[1].init.headers).get('authorization'), 'Bearer tavily-test');
    assert.equal(new Headers(calls[2].init.headers).get('authorization'), 'Bearer router-test');
    assert.ok(String(calls[0].init.body).includes(`data:image/png;base64,${imageBase64}`));
    assert.equal(JSON.parse(String(calls[1].init.body)).query, 'Example black denim jacket buy');
    assert.equal(result.resolution, 'exact');
    assert.equal(result.candidates[0].productUrl, productUrl);
    assert.equal(result.candidates[0].priceAmount, '128.00');
  });

  test('brand + priceless top candidate → Shopify lookup on the brand host', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.SERPAPI_API_KEY;
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.IDENTIFY_MODEL = 'openai/gpt-4.1-mini';
    process.env.SEARCH_PROVIDER = 'tavily';
    process.env.OPENROUTER_API_KEY = 'router-test';
    process.env.TAVILY_API_KEY = 'tavily-test';
    process.env.DEMO_MODE = 'false';

    const signal = { brand: 'Overtime', product_type: 'tee', color: 'black',
      distinguishing_features: ['O logo'], search_query: 'Overtime classic tee black O logo', confidence: 'high' };
    const candidates = [{ title: 'Some tee', merchant: 'Other', product_url: 'https://other.com/products/a' }];

    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      let body: unknown;
      let status = 200;
      if (url === 'https://api.tavily.com/search') {
        body = { results: [
          { url: 'https://other.com/products/a', title: 'Some tee', content: 'x' },
          { url: 'https://other.com/products/b', title: 'Other tee', content: 'x' },
          { url: 'https://shop.overtime.tv/collections/tees', title: 'Tees', content: 'store' },
        ] };
      } else if (url.includes('openrouter.ai')) {
        const which = calls.filter((c) => c.url.includes('openrouter.ai')).length === 1 ? signal : { candidates };
        body = { id: 'm', object: 'chat.completion', choices: [{ index: 0,
          finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(which) } }] };
      } else if (url === 'https://other.com/products/a') {
        return new Response('<html><body>no price</body></html>', { status: 200 });
      } else if (url === 'https://shop.overtime.tv/meta.json') {
        body = { name: 'Overtime Shop', currency: 'USD' };
      } else if (url.startsWith('https://shop.overtime.tv/search/suggest.json')) {
        body = { resources: { results: { products: [
          { title: 'Classic Tee', url: '/products/classic-tee', price: '40.00' },
        ] } } };
      } else {
        status = 404;
        body = {};
      }
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    };

    const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
    const result = await resolve({ media: { imageBase64, mediaType: 'image/png' } });
    assert.equal(result.candidates[0].productUrl, 'https://shop.overtime.tv/products/classic-tee');
    assert.equal(result.candidates[0].priceAmount, '40.00');
    assert.equal(result.candidates[0].currency, 'USD');
    // The Shopify probe hit the brand host, not the other store.
    assert.ok(calls.some((c) => c.url === 'https://shop.overtime.tv/meta.json'));
  });

  test('forced demo mode never calls OpenRouter or search', async () => {
    process.env.DEMO_MODE = 'true';
    process.env.LLM_PROVIDER = 'openrouter';
    const result = await resolve({ media: null, text: 'jacket' });
    assert.equal(result.candidates.length, 3);
    assert.equal(calls.length, 0);
  });
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
