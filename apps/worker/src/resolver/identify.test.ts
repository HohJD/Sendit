import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { identify, __resetIdentifyClientForTests } from './identify.ts';

// Smallest valid JPEG (1x1 black pixel) — real bytes, not a placeholder string,
// so the test exercises the actual base64 image content block.
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

let calls: Array<{ url: string; init: RequestInit }>;
let responses: Array<{ status: number; body: unknown }>;

beforeEach(() => {
  calls = [];
  responses = [];
  __resetIdentifyClientForTests();
  process.env.NVIDIA_API_KEY = 'nvapi-test';
  delete process.env.IDENTIFY_MODEL;
  delete process.env.XAI_API_KEY;

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
  delete process.env.NVIDIA_API_KEY;
  delete process.env.IDENTIFY_MODEL;
  delete process.env.XAI_API_KEY;
});

function chatResponse(message: Record<string, unknown>) {
  return {
    id: 'cmpl-1',
    object: 'chat.completion',
    model: 'moonshotai/kimi-k2.6',
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
  };
}

describe('identify', () => {
  test('sends the image as a data URI and defaults to Kimi K2.6', async () => {
    responses.push({
      status: 200,
      body: chatResponse({
        content: JSON.stringify({
          brand: 'Nike',
          product_type: 'sneakers',
          color: 'white',
          distinguishing_features: ['swoosh logo', 'chunky sole'],
          search_query: 'Nike Air Max 90 white leather sneakers',
          confidence: 'high',
        }),
      }),
    });

    const result = await identify({
      imageBase64: TINY_JPEG_BASE64,
      mediaType: 'image/jpeg',
      caption: 'obsessed with these',
    });

    assert.equal(result.brand, 'Nike');
    assert.equal(result.searchQuery, 'Nike Air Max 90 white leather sneakers');
    assert.equal(result.confidence, 'high');
    assert.deepEqual(result.distinguishingFeatures, ['swoosh logo', 'chunky sole']);

    const sentBody = JSON.parse(calls[0].init.body as string);
    assert.equal(sentBody.model, 'moonshotai/kimi-k2.6');
    assert.equal(sentBody.response_format.type, 'json_object');

    const userContent = sentBody.messages[1].content;
    assert.equal(userContent[0].type, 'image_url');
    assert.equal(
      userContent[0].image_url.url,
      `data:image/jpeg;base64,${TINY_JPEG_BASE64}`,
    );
    assert.match(userContent[1].text, /obsessed with these/);
  });

  test('logs reasoning_content when present but does not require it', async () => {
    responses.push({
      status: 200,
      body: chatResponse({
        content: JSON.stringify({
          brand: null,
          product_type: 'jacket',
          color: null,
          distinguishing_features: [],
          search_query: 'brown corduroy jacket',
          confidence: 'low',
        }),
        reasoning_content: 'the jacket is the only product-like item in frame',
      }),
    });

    const result = await identify({ imageBase64: TINY_JPEG_BASE64, mediaType: 'image/jpeg' });
    assert.equal(result.productType, 'jacket');
  });

  test('respects IDENTIFY_MODEL override', async () => {
    process.env.IDENTIFY_MODEL = 'openai/gpt-oss-120b';
    responses.push({
      status: 200,
      body: chatResponse({
        content: JSON.stringify({
          brand: null,
          product_type: 'bag',
          color: null,
          distinguishing_features: [],
          search_query: 'canvas tote bag',
          confidence: 'low',
        }),
      }),
    });

    await identify({ imageBase64: TINY_JPEG_BASE64, mediaType: 'image/jpeg' });

    const sentBody = JSON.parse(calls[0].init.body as string);
    assert.equal(sentBody.model, 'openai/gpt-oss-120b');
  });

  test('sends a placeholder note when no caption is provided', async () => {
    responses.push({
      status: 200,
      body: chatResponse({
        content: JSON.stringify({
          brand: null,
          product_type: 'bag',
          color: null,
          distinguishing_features: [],
          search_query: 'canvas tote bag',
          confidence: 'low',
        }),
      }),
    });

    await identify({ imageBase64: TINY_JPEG_BASE64, mediaType: 'image/jpeg' });

    const sentBody = JSON.parse(calls[0].init.body as string);
    assert.match(sentBody.messages[1].content[1].text, /No caption was provided/);
  });

  test('routes grok models to xAI with XAI_API_KEY', async () => {
    process.env.IDENTIFY_MODEL = 'grok-4.7';
    process.env.XAI_API_KEY = 'xai-test';
    responses.push({
      status: 200,
      body: chatResponse({
        content: JSON.stringify({
          brand: null,
          product_type: 'jacket',
          color: 'black',
          distinguishing_features: [],
          search_query: 'black jacket',
          confidence: 'medium',
        }),
      }),
    });

    await identify({ imageBase64: TINY_JPEG_BASE64, mediaType: 'image/jpeg' });

    assert.match(calls[0].url, /^https:\/\/api\.x\.ai\/v1\/chat\/completions/);
    assert.equal((calls[0].init.headers as Record<string, string>).authorization ?? (calls[0].init.headers as Headers).get?.('authorization'), 'Bearer xai-test');
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.model, 'grok-4.7');
  });

  test('throws when grok is configured but XAI_API_KEY is unset', async () => {
    process.env.IDENTIFY_MODEL = 'grok-4.7';
    delete process.env.XAI_API_KEY;
    await assert.rejects(
      () => identify({ imageBase64: TINY_JPEG_BASE64, mediaType: 'image/jpeg' }),
      /XAI_API_KEY is not set/,
    );
  });

  test('rejects webp input when the provider is xAI', async () => {
    process.env.IDENTIFY_MODEL = 'grok-4.7';
    process.env.XAI_API_KEY = 'xai-test';
    await assert.rejects(
      () => identify({ imageBase64: TINY_JPEG_BASE64, mediaType: 'image/webp' }),
      /xAI does not accept WebP/,
    );
  });

  test('throws a clear error when the model does not return valid JSON', async () => {
    responses.push({ status: 200, body: chatResponse({ content: 'not json' }) });

    await assert.rejects(
      () => identify({ imageBase64: TINY_JPEG_BASE64, mediaType: 'image/jpeg' }),
      /did not return valid JSON/,
    );
  });
});
