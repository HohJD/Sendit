import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { searchByText } from './tavily.ts';
import { searchProvider } from './search.ts';
import { __resetClientForTests } from './llm.ts';
import { __setLookupForTests } from './enrich.ts';

let calls: Array<{ url: string; init: RequestInit }>;
let responses: Array<{ status: number; body: unknown }>;

const ENV_KEYS = [
  'TAVILY_API_KEY',
  'SERPAPI_API_KEY',
  'SEARCH_PROVIDER',
  'IDENTIFY_MODEL',
  'OPENAI_API_KEY',
  'XAI_API_KEY',
  'NVIDIA_API_KEY',
  'LLM_PROVIDER',
  'LLM_FALLBACK_MODELS',
  'OPENROUTER_API_KEY',
];
let saved: Record<string, string | undefined>;
let realFetch: typeof fetch;

beforeEach(() => {
  calls = [];
  responses = [];
  realFetch = globalThis.fetch;
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  __resetClientForTests();
  // Enrichment does a DNS check before fetching — never let tests hit real DNS.
  __setLookupForTests(async () => ({ address: '93.184.216.34', family: 4 }) as never);

  // @ts-expect-error — test double; the OpenAI SDK uses global fetch under Node 18+
  globalThis.fetch = async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('no mocked response queued');
    return {
      ok: next.status < 400,
      status: next.status,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => next.body,
      text: async () => JSON.stringify(next.body),
    };
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  __resetClientForTests();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function tavilyBody() {
  return {
    results: [
      {
        title: 'The Long Haul Jacket',
        url: 'https://www.taylorstitch.com/products/long-haul-jacket',
        content: 'The Long Haul Jacket in black — $128.00 at Taylor Stitch.',
        score: 0.9,
        images: ['https://cdn.taylorstitch.com/jacket.jpg'],
      },
      {
        title: 'Black jacket buying guide',
        url: 'https://blog.example.com/best-black-jackets',
        content: 'Our top picks for black jackets.',
        score: 0.5,
      },
      {
        title: 'SHEIN black jacket',
        url: 'https://us.shein.com/products/jacket',
        content: 'SHEIN jacket',
        score: 0.4,
      },
    ],
    images: ['https://cdn.taylorstitch.com/jacket.jpg'],
  };
}

function llmBody(candidates: unknown[]) {
  return {
    id: 'cmpl-1',
    object: 'chat.completion',
    model: 'gpt-4.1-mini',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: JSON.stringify({ candidates }) },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
  };
}

function useOpenAi() {
  process.env.IDENTIFY_MODEL = 'gpt-4.1-mini';
  process.env.OPENAI_API_KEY = 'openai-test';
}

function authHeader(init: RequestInit): string | null {
  const h = init.headers as Record<string, string> | Headers;
  return h instanceof Headers ? h.get('authorization') : (h.authorization ?? h.Authorization ?? null);
}

describe('tavily searchByText', () => {
  test('extracts Tavily product results through OpenRouter using only its model API key', async () => {
    process.env.TAVILY_API_KEY = 'tavily-test';
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'openrouter-test';
    delete process.env.IDENTIFY_MODEL;
    process.env.LLM_FALLBACK_MODELS = ''; // keep this test on the router alone — fallback is covered in identify.test.ts
    responses.push({ status: 200, body: tavilyBody() });
    responses.push({ status: 200, body: llmBody([{
      title: 'The Long Haul Jacket', merchant: 'Taylor Stitch', price_amount: '128.00',
      currency: 'USD', product_url: 'https://www.taylorstitch.com/products/long-haul-jacket',
    }]) });
    const results = await searchByText('black jacket');
    assert.equal(calls[1].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(authHeader(calls[1].init), 'Bearer openrouter-test');
    const extractionRequest = JSON.parse(String(calls[1].init.body));
    assert.equal(extractionRequest.model, 'openrouter/free');
    assert.equal(extractionRequest.models, undefined);
    assert.deepEqual(extractionRequest.provider, { require_parameters: true });
    assert.equal(results[0].priceAmount, '128.00');
    assert.equal(results[0].merchantDomain, 'taylorstitch.com');
  });

  test('POSTs to tavily, then maps LLM-extracted candidates', async () => {
    process.env.TAVILY_API_KEY = 'tavily-test';
    useOpenAi();
    responses.push({ status: 200, body: tavilyBody() });
    responses.push({
      status: 200,
      body: llmBody([
        {
          title: 'The Long Haul Jacket',
          merchant: 'Taylor Stitch',
          merchant_domain: 'IGNORED.example',
          price_amount: '128.00',
          currency: 'USD',
          product_url: 'https://www.taylorstitch.com/products/long-haul-jacket',
        },
        { title: 'Ghost', merchant: 'X', product_url: 'https://made-up.example.com/p' },
        { title: 'Shein jacket', merchant: 'SHEIN', product_url: 'https://us.shein.com/products/jacket' },
      ]),
    });

    const out = await searchByText('black jacket', 3);

    // Tavily request
    const [tav, llm] = calls;
    assert.equal(tav.url, 'https://api.tavily.com/search');
    assert.equal(authHeader(tav.init), 'Bearer tavily-test');
    const tavBody = JSON.parse(String(tav.init.body));
    assert.equal(tavBody.query, 'black jacket buy');
    assert.equal(tavBody.include_images, true);
    assert.ok(tavBody.exclude_domains.includes('amazon.com'));

    // LLM request carries the result URLs so the model can only pick real ones
    const llmBodyText = String(llm.init.body);
    assert.ok(llmBodyText.includes('taylorstitch.com/products/long-haul-jacket'));
    assert.ok(llmBodyText.includes('blog.example.com/best-black-jackets'));
    const parsed = JSON.parse(llmBodyText);
    assert.equal(parsed.response_format.type, 'json_object');
    assert.equal(parsed.temperature, 0.1);

    assert.equal(out.length, 1); // hallucinated URL and excluded-domain candidate dropped
    const c = out[0];
    assert.equal(c.title, 'The Long Haul Jacket');
    assert.equal(c.merchantDomain, 'taylorstitch.com'); // derived, www stripped, model ignored
    assert.equal(c.priceAmount, '128.00');
    assert.equal(c.currency, 'USD');
    assert.equal(c.imageUrl, 'https://cdn.taylorstitch.com/jacket.jpg');
    assert.equal(c.productUrl, 'https://www.taylorstitch.com/products/long-haul-jacket');
  });

  test('respects the limit', async () => {
    process.env.TAVILY_API_KEY = 'tavily-test';
    useOpenAi();
    responses.push({ status: 200, body: tavilyBody() });
    const url = 'https://www.taylorstitch.com/products/long-haul-jacket';
    responses.push({ status: 200, body: llmBody([{ title: 'a', product_url: url }, { title: 'b', product_url: url }]) });

    const out = await searchByText('jacket', 1);
    assert.equal(out.length, 1);
  });

  test('canonicalises tracking params and dedupes results; uses advanced depth', async () => {
    process.env.TAVILY_API_KEY = 'tavily-test';
    useOpenAi();
    responses.push({
      status: 200,
      body: {
        results: [
          { title: 'Tee', url: 'https://shop.brand.com/products/tee?g_acctid=1&utm=x', content: '$40' },
          { title: 'Tee dupe', url: 'https://shop.brand.com/products/tee?fbclid=abc', content: '$40' },
          { title: 'Tee root', url: 'https://shop.brand.com/products/tee/', content: '$40' },
          { title: 'Other', url: 'https://other.com/products/other', content: 'x' },
        ],
      },
    });
    responses.push({ status: 200, body: llmBody([
      { title: 'Tee', price_amount: '40.00', currency: 'USD', product_url: 'https://shop.brand.com/products/tee?utm=z' },
    ]) });

    const out = await searchByText('tee');
    const tavBody = JSON.parse(String(calls[0].init.body));
    assert.equal(tavBody.search_depth, 'advanced');
    assert.equal(tavBody.max_results, 10);
    assert.equal(out.length, 1);
    assert.equal(out[0].productUrl, 'https://shop.brand.com/products/tee');
    assert.equal(out[0].priceAmount, '40.00');
    // The listing deduped to 2 results — canonicalised.
    const listing = String(calls[1].init.body);
    assert.equal((listing.match(/shop\.brand\.com\/products\/tee/g) ?? []).length, 1);
  });

  test('collection and root results never become candidates', async () => {
    process.env.TAVILY_API_KEY = 'tavily-test';
    useOpenAi();
    responses.push({
      status: 200,
      body: {
        results: [
          { title: 'Tees collection', url: 'https://brand.com/collections/tees', content: 'shop tees' },
          { title: 'Store root', url: 'https://brand.com/?g_acctid=9', content: 'home' },
          { title: 'Aggregator', url: 'https://shop.app/m/brand', content: 'x' },
        ],
      },
    });
    // The model ignores the marker and returns a collection anyway.
    responses.push({ status: 200, body: llmBody([
      { title: 'Tees', product_url: 'https://brand.com/collections/tees' },
    ]) });
    // Shopify fallback also finds nothing (meta.json 404 + no Shopify markers).
    responses.push({ status: 404, body: {} });
    responses.push({ status: 200, body: '<html><body>plain site</body></html>' });

    const out = await searchByText('brand tee');
    assert.equal(out.length, 0);
    const listing = String(calls[1].init.body);
    assert.ok(listing.includes('[category page — not a product]'));
    assert.ok(!listing.includes('shop.app'));
  });

  test('priced candidates sort first and target.com is dropped', async () => {
    process.env.TAVILY_API_KEY = 'tavily-test';
    useOpenAi();
    responses.push({
      status: 200,
      body: {
        results: [
          { title: 'a', url: 'https://a.com/products/a', content: 'x' },
          { title: 'b', url: 'https://b.com/products/b', content: '$50' },
          { title: 't', url: 'https://www.target.com/p/t/-/A-1', content: '$20' },
        ],
      },
    });
    responses.push({ status: 200, body: llmBody([
      { title: 'no price', product_url: 'https://a.com/products/a' },
      { title: 'priced', price_amount: '50.00', product_url: 'https://b.com/products/b' },
      { title: 'target', price_amount: '20.00', product_url: 'https://www.target.com/p/t/-/A-1' },
    ]) });

    const out = await searchByText('x', 3);
    assert.equal(out.length, 2);
    assert.equal(out[0].productUrl, 'https://b.com/products/b');
    assert.equal(out[0].priceAmount, '50.00');
    assert.ok(!out.some((c) => c.productUrl.includes('target.com')));
  });

  test('priceless top candidate triggers a Shopify lookup on the brand origin', async () => {
    process.env.TAVILY_API_KEY = 'tavily-test';
    useOpenAi();
    responses.push({
      status: 200,
      body: {
        results: [
          { title: 'Tees', url: 'https://shop.overtime.tv/collections/tees', content: 'store' },
          { title: 'A', url: 'https://other.com/products/a', content: 'x' },
          { title: 'B', url: 'https://else.com/products/b', content: 'x' },
        ],
      },
    });
    // Model picks the non-brand product page but can't find a price.
    responses.push({ status: 200, body: llmBody([
      { title: 'Some tee', product_url: 'https://other.com/products/a' },
    ]) });
    // Enrich attempt on other.com/products/a — page HTML first, then the .js probe.
    responses.push({ status: 200, body: '<html><body>no price here</body></html>' });
    responses.push({ status: 404, body: {} });
    // Shopify probe on shop.overtime.tv (brand host ranks first).
    responses.push({ status: 200, body: { name: 'Overtime Shop', currency: 'USD' } });
    responses.push({
      status: 200,
      body: { resources: { results: { products: [
        { title: 'Classic Tee', url: '/products/classic-tee', price: '40.00', image: '/img/tee.jpg' },
      ] } } },
    });

    const out = await searchByText('overtime classic tee', 3, { brand: 'Overtime' });
    assert.equal(out[0].productUrl, 'https://shop.overtime.tv/products/classic-tee');
    assert.equal(out[0].priceAmount, '40.00');
    assert.equal(out[0].currency, 'USD');
    assert.equal(out[0].imageUrl, 'https://shop.overtime.tv/img/tee.jpg');
  });

  test('throws when TAVILY_API_KEY is unset', async () => {
    await assert.rejects(() => searchByText('jacket'), /TAVILY_API_KEY is not set/);
  });

  test('throws with the status on a tavily 401', async () => {
    process.env.TAVILY_API_KEY = 'bad';
    responses.push({ status: 401, body: { error: 'unauthorized' } });
    await assert.rejects(() => searchByText('jacket'), /401/);
  });

  test('returns empty when tavily has no results (no LLM call)', async () => {
    process.env.TAVILY_API_KEY = 'tavily-test';
    useOpenAi();
    responses.push({ status: 200, body: { results: [] } });
    assert.deepEqual(await searchByText('nothing'), []);
    assert.equal(calls.length, 1);
  });
});

describe('searchProvider', () => {
  test('explicit SEARCH_PROVIDER wins over keys', () => {
    process.env.SEARCH_PROVIDER = 'tavily';
    process.env.SERPAPI_API_KEY = 'k';
    assert.equal(searchProvider(), 'tavily');
    process.env.SEARCH_PROVIDER = 'serpapi';
    process.env.TAVILY_API_KEY = 'k';
    assert.equal(searchProvider(), 'serpapi');
  });

  test('tavily when only TAVILY_API_KEY is set', () => {
    process.env.TAVILY_API_KEY = 'k';
    assert.equal(searchProvider(), 'tavily');
  });

  test('serpapi when only SERPAPI_API_KEY is set', () => {
    process.env.SERPAPI_API_KEY = 'k';
    assert.equal(searchProvider(), 'serpapi');
  });

  test('serpapi when both keys are set', () => {
    process.env.SERPAPI_API_KEY = 'k';
    process.env.TAVILY_API_KEY = 'k';
    assert.equal(searchProvider(), 'serpapi');
  });

  test('falls back to serpapi when nothing is configured', () => {
    assert.equal(searchProvider(), 'serpapi');
  });
});
