import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from './handler.ts';
import type { ChannelAdapter, InboundMessage } from '../channels/types.ts';
import type { NewShare } from '../intake/store.ts';

interface Sent {
  kind: 'text' | 'image' | 'buttons' | 'media';
  to: string;
  args: unknown[];
}

function fakeAdapter(sent: Sent[]): ChannelAdapter {
  return {
    name: 'whatsapp',
    webhookPath: '/webhooks/whatsapp',
    verifyToken: () => 'tok',
    parseWebhook: () => [],
    sendText: async (to, text) => void sent.push({ kind: 'text', to, args: [text] }),
    sendImage: async (to, image) => void sent.push({ kind: 'image', to, args: [image] }),
    sendButtons: async (to, body, buttons) => void sent.push({ kind: 'buttons', to, args: [body, buttons] }),
    fetchMedia: async () => ({ buffer: Buffer.alloc(0), mimeType: 'image/jpeg' }),
  };
}

function base(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: 'whatsapp',
    externalId: '447700900000',
    messageId: 'wamid.1',
    urls: [],
    raw: {},
    ...overrides,
  };
}

function deps(overrides: Partial<Parameters<typeof createHandler>[0]> = {}) {
  const shares: NewShare[] = [];
  return {
    shares,
    recordShare: async (s: NewShare) => (shares.push(s), true),
    resolveUserId: async () => 'user_1',
    startCheckout: async (_u: string, itemId: string) => `checkout link for ${itemId}`,
    ...overrides,
  };
}

/** Sends are fire-and-forget promises — give them a tick to settle. */
const flush = () => new Promise((r) => setImmediate(r));

describe('conversation handler', () => {
  test('approve button starts checkout and sends the returned text', async () => {
    const sent: Sent[] = [];
    let checkoutArgs: [string, string] | null = null;
    const d = deps({
      startCheckout: async (u, i) => (checkoutArgs = [u, i], 'link body'),
    });
    await createHandler(d)(fakeAdapter(sent), base({ buttonReply: { id: 'approve:item_7', title: 'Approve' } }));
    await flush();

    assert.deepEqual(checkoutArgs, ['user_1', 'item_7']);
    assert.deepEqual(sent.map((s) => s.args[0]), ['link body']);
  });

  test('reject button sends the try-again line', async () => {
    const sent: Sent[] = [];
    const d = deps();
    await createHandler(d)(fakeAdapter(sent), base({ buttonReply: { id: 'reject:share_9', title: 'Nope' } }));
    await flush();

    assert.equal(d.shares.length, 0);
    assert.match(sent[0].args[0] as string, /another screenshot, link, or describe/);
  });

  test('a link queues one link share per url and acks once', async () => {
    const sent: Sent[] = [];
    const d = deps();
    await createHandler(d)(
      fakeAdapter(sent),
      base({
        text: 'look https://www.instagram.com/reel/A/ and https://www.instagram.com/reel/B/',
        urls: ['https://www.instagram.com/reel/A', 'https://www.instagram.com/reel/B'],
      }),
    );
    await flush();

    assert.equal(d.shares.length, 2);
    assert.equal(d.shares[0].inputKind, 'link');
    assert.equal(d.shares[0].sourceUrl, 'https://www.instagram.com/reel/A');
    assert.equal(d.shares[0].inputText, 'look https://www.instagram.com/reel/A/ and https://www.instagram.com/reel/B/');
    assert.equal(sent.length, 1);
    assert.match(sent[0].args[0] as string, /reading that link/);
  });

  test('an image queues an image share with the media ref', async () => {
    const sent: Sent[] = [];
    const d = deps();
    await createHandler(d)(
      fakeAdapter(sent),
      base({ media: { ref: 'media_1', kind: 'image', mimeType: 'image/jpeg', caption: 'this?' } }),
    );
    await flush();

    assert.equal(d.shares.length, 1);
    assert.equal(d.shares[0].inputKind, 'image');
    assert.equal(d.shares[0].mediaRef, 'media_1');
    assert.equal(d.shares[0].sourceUrl, '');
    assert.equal(d.shares[0].inputText, 'this?');
    assert.match(sent[0].args[0] as string, /finding that product/);
  });

  test('a video gets the no-videos reply and no share', async () => {
    const sent: Sent[] = [];
    const d = deps();
    await createHandler(d)(fakeAdapter(sent), base({ media: { ref: 'v1', kind: 'video' } }));
    await flush();

    assert.equal(d.shares.length, 0);
    assert.match(sent[0].args[0] as string, /can't watch videos/);
  });

  test('"hi" gets the welcome and no share', async () => {
    const sent: Sent[] = [];
    const d = deps();
    await createHandler(d)(fakeAdapter(sent), base({ text: 'hi' }));
    await flush();

    assert.equal(d.shares.length, 0);
    assert.match(sent[0].args[0] as string, /I'm Sendit/);
  });

  test('a plain product request queues a text share', async () => {
    const sent: Sent[] = [];
    const d = deps();
    await createHandler(d)(fakeAdapter(sent), base({ text: 'find me a black jacket' }));
    await flush();

    assert.equal(d.shares.length, 1);
    assert.equal(d.shares[0].inputKind, 'text');
    assert.equal(d.shares[0].inputText, 'find me a black jacket');
    assert.match(sent[0].args[0] as string, /searching for "find me a black jacket"/);
  });

  test('a redelivery that dedupes sends no ack', async () => {
    const sent: Sent[] = [];
    const d = deps({ recordShare: async () => false });
    await createHandler(d)(fakeAdapter(sent), base({ text: 'find me a black jacket' }));
    await flush();

    assert.equal(sent.length, 0);
  });
});
