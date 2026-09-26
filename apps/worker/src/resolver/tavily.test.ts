import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { searchByText } from './tavily.ts';
import { searchProvider } from './search.ts';
import { __resetClientForTests } from './llm.ts';

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
    process.env.IDENTIFY_MODEL = 'openai/gpt-4.1-mini';
    responses.push({ status: 200, body: tavilyBody() });
    responses.push({ status: 200, body: llmBody([{
      title: 'The Long Haul Jacket', merchant: 'Taylor Stitch', price_amount: '128.00',
      currency: 'USD', product_url: 'https://www.taylorstitch.com/products/long-haul-jacket',
    }]) });
    const results = await searchByText('black jacket');
    assert.equal(calls[1].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(authHeader(calls[1].init), 'Bearer openrouter-test');
    assert.deepEqual(JSON.parse(String(calls[1].init.body)).provider, { require_parameters: true });
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

    assert.equal(out.length, 1); // hallucinated URL dropped
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
