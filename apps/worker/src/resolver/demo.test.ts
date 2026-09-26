import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { demoEnabled, demoReason, demoResolve } from './demo.ts';

const KEYS = ['DEMO_MODE', 'LLM_PROVIDER', 'IDENTIFY_MODEL', 'SEARCH_PROVIDER', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'NVIDIA_API_KEY', 'XAI_API_KEY', 'SERPAPI_API_KEY', 'TAVILY_API_KEY'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('demoEnabled', () => {
  test('OpenRouter and Tavily enable real matching with no direct model-provider keys', () => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.SEARCH_PROVIDER = 'tavily';
    process.env.OPENROUTER_API_KEY = 'router-test';
    process.env.TAVILY_API_KEY = 'tavily-test';
    process.env.DEMO_MODE = 'false';
    assert.equal(demoReason(), null);
    assert.equal(demoEnabled(), false);
  });

  test('an unrelated model key cannot satisfy an explicitly selected provider', () => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENAI_API_KEY = 'other-key';
    process.env.TAVILY_API_KEY = 'tavily-test';
    assert.equal(demoReason(), 'missing OPENROUTER_API_KEY for openrouter');
  });

  test('an unrelated search key cannot satisfy an explicitly selected search provider', () => {
    process.env.OPENAI_API_KEY = 'openai-test';
    process.env.SEARCH_PROVIDER = 'tavily';
    process.env.SERPAPI_API_KEY = 'other-key';
    assert.equal(demoReason(), 'missing TAVILY_API_KEY for tavily');
  });

  test('legacy model inference checks that model provider rather than any key', () => {
    process.env.IDENTIFY_MODEL = 'grok-4.7';
    process.env.OPENAI_API_KEY = 'other-key';
    process.env.TAVILY_API_KEY = 'tavily-test';
    assert.equal(demoReason(), 'missing XAI_API_KEY for xai');
  });

  test('invalid configuration is not silently treated as a demo', () => {
    process.env.LLM_PROVIDER = 'typo';
    assert.throws(demoReason, /LLM_PROVIDER must be/);
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'router-test';
    process.env.SEARCH_PROVIDER = 'typo';
    assert.throws(demoReason, /SEARCH_PROVIDER must be/);
  });

  test('off when all keys are present and DEMO_MODE unset', () => {
    process.env.OPENAI_API_KEY = 'k';
    process.env.SERPAPI_API_KEY = 'k';
    assert.equal(demoEnabled(), false);
    assert.equal(demoReason(), null);
  });

  test('on when DEMO_MODE=true regardless of keys', () => {
    process.env.DEMO_MODE = 'true';
    process.env.OPENAI_API_KEY = 'k';
    process.env.SERPAPI_API_KEY = 'k';
    assert.equal(demoEnabled(), true);
    assert.equal(demoReason(), 'DEMO_MODE=true');
  });

  test('on with no vision key', () => {
    process.env.SERPAPI_API_KEY = 'k';
    assert.equal(demoEnabled(), true);
    assert.equal(demoReason(), 'missing NVIDIA_API_KEY for nim');
  });

  test('off when only XAI_API_KEY supplies the vision key', () => {
    process.env.XAI_API_KEY = 'k';
    process.env.SERPAPI_API_KEY = 'k';
    assert.equal(demoEnabled(), false);
  });

  test('on with no search key', () => {
    process.env.NVIDIA_API_KEY = 'k';
    assert.equal(demoEnabled(), true);
    assert.equal(demoReason(), 'missing SERPAPI_API_KEY for serpapi');
  });

  test('off when only TAVILY_API_KEY supplies the search key', () => {
    process.env.OPENAI_API_KEY = 'k';
    process.env.TAVILY_API_KEY = 'k';
    assert.equal(demoEnabled(), false);
  });
});

describe('demoResolve', () => {
  test('leads with the keyword-matched product', () => {
    const result = demoResolve({ text: 'find me a black jacket' });
    assert.equal(result.candidates.length, 3);
    assert.match(result.candidates[0].title, /Jacket/);
    assert.equal(result.resolution, 'exact');
    assert.equal(result.candidates[0].currency, 'USD');
    assert.match(result.candidates[0].imageUrl ?? '', /^https:\/\//);
  });

  test('matches on caption when there is no text', () => {
    const result = demoResolve({ caption: 'obsessed with these sneakers' });
    assert.equal(result.candidates[0].merchant, 'Allbirds');
  });

  test('defaults to the catalog order on no match', () => {
    const result = demoResolve({ text: 'something vague' });
    assert.match(result.candidates[0].title, /Jacket/);
    assert.equal(result.resolution, 'similar');
  });
});
