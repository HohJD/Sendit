import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { whatsapp } from './whatsapp.ts';

let calls: Array<{ url: string; init: RequestInit }>;
let responses: Array<{ status: number; body?: unknown; bytes?: Uint8Array }>;
let realFetch: typeof fetch;

beforeEach(() => {
  calls = [];
  responses = [];
  realFetch = globalThis.fetch;
  process.env.WHATSAPP_TOKEN = 'wa-token';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '12345';

  // @ts-expect-error — minimal Response stand-in
  globalThis.fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('no mocked response queued');
    return {
      ok: next.status < 400,
      status: next.status,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => next.body,
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? '')),
      arrayBuffer: async () => (next.bytes ?? new Uint8Array()).buffer,
    };
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.WHATSAPP_TOKEN;
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;
});

describe('whatsapp parse', () => {
  test('reads a reel link out of a text body', () => {
    const messages = whatsapp.parseWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    id: 'wamid.1',
                    from: '447700900000',
                    type: 'text',
                    text: { body: 'this one https://www.instagram.com/reel/XYZ/' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    assert.equal(messages.length, 1);
    assert.equal(messages[0].channel, 'whatsapp');
    assert.equal(messages[0].externalId, '447700900000');
    assert.equal(messages[0].messageId, 'wamid.1');
    assert.deepEqual(messages[0].urls, ['https://www.instagram.com/reel/XYZ']);
  });

  test('reads an image message with ref, mime and caption', () => {
    const messages = whatsapp.parseWebhook({
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    id: 'wamid.2',
                    from: '447700900000',
                    type: 'image',
                    image: { id: 'media_9', mime_type: 'image/jpeg', caption: 'want this' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].media, {
      ref: 'media_9',
      kind: 'image',
      mimeType: 'image/jpeg',
      caption: 'want this',
    });
    assert.equal(messages[0].text, 'want this');
  });

  test('reads an interactive button_reply', () => {
    const messages = whatsapp.parseWebhook({
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    id: 'wamid.3',
                    from: '447700900000',
                    type: 'interactive',
                    interactive: {
                      type: 'button_reply',
                      button_reply: { id: 'approve:item_1', title: 'Approve' },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].buttonReply, { id: 'approve:item_1', title: 'Approve' });
  });

  test('ignores delivery-status callbacks', () => {
    const messages = whatsapp.parseWebhook({
      entry: [{ changes: [{ field: 'statuses', value: { statuses: [{}] } }] }],
    });
    assert.deepEqual(messages, []);
  });
});

describe('whatsapp send', () => {
  test('sendText posts to the phone-number messages edge', async () => {
    responses.push({ status: 200, body: { messages: [{ id: 'wamid.out' }] } });
    await whatsapp.sendText('447700900000', 'hello');

    assert.equal(calls[0].url, 'https://graph.facebook.com/v23.0/12345/messages');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer wa-token');

    const body = JSON.parse(calls[0].init.body as string);
    assert.equal(body.messaging_product, 'whatsapp');
    assert.equal(body.to, '447700900000');
    assert.equal(body.type, 'text');
    assert.equal(body.text.body, 'hello');
    assert.equal(body.text.preview_url, true);
  });

  test('sendImage sends a public link', async () => {
    responses.push({ status: 200, body: {} });
    await whatsapp.sendImage('447700900000', { url: 'https://x/img.jpg', caption: 'found it' });

    const body = JSON.parse(calls[0].init.body as string);
    assert.equal(body.type, 'image');
    assert.equal(body.image.link, 'https://x/img.jpg');
    assert.equal(body.image.caption, 'found it');
  });

  test('sendButtons builds reply buttons and truncates titles', async () => {
    responses.push({ status: 200, body: {} });
    await whatsapp.sendButtons('447700900000', 'pick one', [
      { id: 'approve:item_1', title: 'Approve' },
      { id: 'reject:share_1', title: 'Not this one, it is far too long' },
    ]);

    const body = JSON.parse(calls[0].init.body as string);
    assert.equal(body.type, 'interactive');
    const buttons = body.interactive.action.buttons;
    assert.equal(buttons.length, 2);
    assert.deepEqual(buttons[0], { type: 'reply', reply: { id: 'approve:item_1', title: 'Approve' } });
    assert.equal(buttons[1].reply.title.length <= 20, true);
  });

  test('a non-2xx send throws with Meta’s error body', async () => {
    responses.push({ status: 401, body: '{"error":{"message":"Invalid OAuth access token"}}' });
    await assert.rejects(
      () => whatsapp.sendText('447700900000', 'hi'),
      /401.*Invalid OAuth access token/,
    );
  });
});

describe('whatsapp fetchMedia', () => {
  test('resolves the media id then downloads with the token on both calls', async () => {
    responses.push({ status: 200, body: { url: 'https://cdn.meta/abc', mime_type: 'image/jpeg' } });
    responses.push({ status: 200, bytes: new Uint8Array([1, 2, 3]) });

    const { buffer, mimeType } = await whatsapp.fetchMedia('media_9');

    assert.equal(calls[0].url, 'https://graph.facebook.com/v23.0/media_9');
    assert.equal(calls[1].url, 'https://cdn.meta/abc');
    for (const call of calls) {
      assert.equal((call.init.headers as Record<string, string>).authorization, 'Bearer wa-token');
    }
    assert.equal(mimeType, 'image/jpeg');
    assert.deepEqual([...buffer], [1, 2, 3]);
  });
});
