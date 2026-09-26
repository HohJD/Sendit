import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  wassist,
  conversationFor,
  __resetWassistConversationsForTests,
} from './wassist.ts';

let calls: Array<{ url: string; init: RequestInit }>;
let responses: Array<{ status: number; body?: unknown; bytes?: Uint8Array; contentType?: string }>;
let realFetch: typeof fetch;

const SECRET = 'test-webhook-secret';

beforeEach(() => {
  calls = [];
  responses = [];
  realFetch = globalThis.fetch;
  __resetWassistConversationsForTests();
  process.env.WASSIST_API_KEY = 'wassist-key';
  process.env.WASSIST_WEBHOOK_SECRET = SECRET;

  // @ts-expect-error — minimal Response stand-in
  globalThis.fetch = async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('no mocked response queued');
    return {
      ok: next.status < 400,
      status: next.status,
      headers: new Headers({ 'content-type': next.contentType ?? 'application/json' }),
      json: async () => next.body,
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? '')),
      arrayBuffer: async () => (next.bytes ?? new Uint8Array()).buffer,
    };
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.WASSIST_API_KEY;
  delete process.env.WASSIST_WEBHOOK_SECRET;
});

function signatureHeader(rawBody: Buffer, t = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', SECRET).update(`${t}.`).update(rawBody).digest('hex');
  return `t=${t},v1=${v1}`;
}

function verify(rawBody: string | Buffer, header = signatureHeader(Buffer.from(rawBody))): boolean {
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody) : rawBody;
  return wassist.verifyRequest!(body, { 'x-wassist-signature': header });
}

describe('wassist verifyRequest', () => {
  const body = '{"event":"subscription.message.received"}';

  test('accepts a valid t,v1 signature', () => {
    assert.equal(verify(body), true);
  });

  test('rejects a bad hmac', () => {
    const t = Math.floor(Date.now() / 1000);
    assert.equal(verify(body, `t=${t},v1=${'0'.repeat(64)}`), false);
  });

  test('rejects a stale timestamp', () => {
    assert.equal(verify(body, signatureHeader(Buffer.from(body), Math.floor(Date.now() / 1000) - 301)), false);
  });

  test('rejects missing or malformed headers', () => {
    assert.equal(wassist.verifyRequest!(Buffer.from(body), {}), false);
    assert.equal(verify(body, 'garbage'), false);
  });
});

const RECEIVED = (message: Record<string, unknown>) => ({
  event: 'subscription.message.received',
  conversationId: 'conv-1',
  whatsappNumber: '447700900100',
  contact: { id: 'c1', name: 'Alex', phoneNumber: '+44 7700 900200' },
  message: { id: 'msg-1', media: [], buttons: [], ...message },
});

describe('wassist parse', () => {
  test('text body → text + urls, externalId is phone digits', () => {
    const messages = wassist.parseWebhook(
      RECEIVED({ body: 'find this https://www.instagram.com/reel/XYZ/' }),
    );
    assert.equal(messages.length, 1);
    const m = messages[0];
    assert.equal(m.channel, 'wassist');
    assert.equal(m.externalId, '447700900200');
    assert.equal(m.messageId, 'msg-1');
    assert.equal(m.text, 'find this https://www.instagram.com/reel/XYZ/');
    assert.deepEqual(m.urls, ['https://www.instagram.com/reel/XYZ']);
  });

  test('media url string + caption → image share', () => {
    const messages = wassist.parseWebhook(
      RECEIVED({
        body: 'want this',
        media: ['https://backend.wassist.app/media/jacket.jpg'],
      }),
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0].media?.kind, 'image');
    assert.equal(messages[0].media?.ref, 'https://backend.wassist.app/media/jacket.jpg');
    assert.equal(messages[0].media?.caption, 'want this');
    assert.equal(messages[0].text, 'want this');
  });

  test('media object with mimeType is honoured; non-image → video/other kind', () => {
    const obj = wassist.parseWebhook(
      RECEIVED({ media: [{ url: 'https://x/m.bin', mimeType: 'image/png' }] }),
    );
    assert.equal(obj[0].media?.kind, 'image');
    assert.equal(obj[0].media?.mimeType, 'image/png');

    const vid = wassist.parseWebhook(
      RECEIVED({ media: [{ url: 'https://x/clip.mp4', type: 'video' }] }),
    );
    assert.equal(vid[0].media?.kind, 'video');
  });

  test('button tap → buttonReply with the id round-tripped', () => {
    const messages = wassist.parseWebhook(
      RECEIVED({ buttons: [{ id: 'approve:item-1', text: 'Approve' }] }),
    );
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].buttonReply, { id: 'approve:item-1', title: 'Approve' });
  });

  test('non-routed events → []', () => {
    assert.deepEqual(wassist.parseWebhook({ event: 'conversation.routing.updated' }), []);
    assert.deepEqual(wassist.parseWebhook({ event: 'test.ping' }), []);
  });
});

describe('wassist send', () => {
  function seedConversation() {
    wassist.parseWebhook(RECEIVED({ body: 'hi' }));
  }

  test('sendText posts to the conversation with X-API-Key', async () => {
    seedConversation();
    responses.push({ status: 201, body: {} });
    await wassist.sendText('447700900200', 'hello');

    assert.equal(calls[0].url, 'https://backend.wassist.app/api/v1/conversations/conv-1/messages/');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers['X-API-Key'], 'wassist-key');
    const body = JSON.parse(String(calls[0].init.body));
    assert.deepEqual(body, { type: 'text', text: { body: 'hello' } });
  });

  test('sendImage posts a unified media message', async () => {
    seedConversation();
    responses.push({ status: 201, body: {} });
    await wassist.sendImage('447700900200', { url: 'https://x/img.jpg', caption: 'found it' });

    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.type, 'unified');
    assert.equal(body.unified.media.url, 'https://x/img.jpg');
    assert.equal(body.unified.text, 'found it');
  });

  test('sendButtons posts quick_reply buttons, title sliced to 20', async () => {
    seedConversation();
    responses.push({ status: 201, body: {} });
    await wassist.sendButtons('447700900200', 'pick one', [
      { id: 'approve:item-1', title: 'Approve' },
      { id: 'reject:item-1', title: 'Not this one, it is far too long' },
    ]);

    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.type, 'unified');
    assert.equal(body.unified.text, 'pick one');
    assert.deepEqual(body.unified.buttons[0], {
      type: 'quick_reply',
      text: 'Approve',
      quickReplyId: 'approve:item-1',
    });
    assert.ok(body.unified.buttons[1].text.length <= 20);
    assert.equal(body.unified.buttons[1].quickReplyId, 'reject:item-1');
  });

  test('a non-2xx send throws with status', async () => {
    seedConversation();
    responses.push({ status: 401, body: 'unauthorized' });
    await assert.rejects(() => wassist.sendText('447700900200', 'hi'), /401/);
  });
});

describe('wassist conversationFor', () => {
  test('uses the map seeded by inbound delivery, no API call', async () => {
    wassist.parseWebhook(RECEIVED({ body: 'hi' }));
    assert.equal(await conversationFor('447700900200'), 'conv-1');
    assert.equal(calls.length, 0);
  });

  test('falls back to the list API on a miss, then caches', async () => {
    responses.push({
      status: 200,
      body: {
        results: [
          { id: 'conv-old', contact: { phoneNumber: '+1 555 000 0000' } },
          { id: 'conv-hit', contact: { phoneNumber: '+44 7700 900200' } },
        ],
      },
    });
    assert.equal(await conversationFor('+44 7700 900200'), 'conv-hit');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/conversations\/\?contact=/);
    assert.equal((calls[0].init.headers as Record<string, string>)['X-API-Key'], 'wassist-key');

    assert.equal(await conversationFor('447700900200'), 'conv-hit');
    assert.equal(calls.length, 1); // cached
  });

  test('throws a clear error when no conversation exists', async () => {
    responses.push({ status: 200, body: { results: [] } });
    await assert.rejects(() => conversationFor('447700900200'), /no conversation on record/);
  });
});

describe('wassist fetchMedia', () => {
  test('includes X-API-Key only for wassist-hosted URLs', async () => {
    responses.push({ status: 200, bytes: new Uint8Array([1, 2]), contentType: 'image/jpeg' });
    const got = await wassist.fetchMedia('https://backend.wassist.app/media/x.jpg');
    assert.equal((calls[0].init.headers as Record<string, string>)['X-API-Key'], 'wassist-key');
    assert.equal(got.mimeType, 'image/jpeg');
    assert.deepEqual([...got.buffer], [1, 2]);

    responses.push({ status: 200, bytes: new Uint8Array([3]) });
    await wassist.fetchMedia('https://cdn.other.net/y.jpg');
    assert.equal((calls[1].init.headers as Record<string, string>)['X-API-Key'], undefined);
  });
});
