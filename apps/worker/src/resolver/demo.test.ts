import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { demoEnabled, demoReason, demoResolve } from './demo.ts';

const KEYS = ['DEMO_MODE', 'OPENAI_API_KEY', 'NVIDIA_API_KEY', 'XAI_API_KEY', 'SERPAPI_API_KEY', 'TAVILY_API_KEY'];
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
    assert.equal(demoReason(), 'no vision key (OPENAI_API_KEY / XAI_API_KEY / NVIDIA_API_KEY)');
  });

  test('off when only XAI_API_KEY supplies the vision key', () => {
    process.env.XAI_API_KEY = 'k';
    process.env.SERPAPI_API_KEY = 'k';
    assert.equal(demoEnabled(), false);
  });

  test('on with no search key', () => {
    process.env.NVIDIA_API_KEY = 'k';
    assert.equal(demoEnabled(), true);
    assert.equal(demoReason(), 'no search key (TAVILY_API_KEY / SERPAPI_API_KEY)');
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
