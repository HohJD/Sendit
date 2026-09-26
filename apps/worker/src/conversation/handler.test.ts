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
  test('a stream of automated plain-text messages gets only one hint', async () => {
    const sent: Sent[] = [];
    const d = deps();
    const handle = createHandler(d);
    const adapter = fakeAdapter(sent);
    for (let i = 0; i < 20; i++) {
      await handle(adapter, base({ messageId: `automated-${i}`, text: 'My draft is saved. Waiting for your screenshot.' }));
    }
    await flush();
    assert.equal(sent.length, 1);
    assert.equal(d.shares.length, 0);
  });

  test('greetings and unsupported media cannot sustain a reply loop', async () => {
    const sent: Sent[] = [];
    const handle = createHandler(deps());
    const adapter = fakeAdapter(sent);
    await handle(adapter, base({ messageId: 'greeting', text: 'hi' }));
    await handle(adapter, base({ messageId: 'hint', text: 'Waiting for your screenshot' }));
    await handle(adapter, base({ messageId: 'video', media: { ref: 'v', kind: 'video' } }));
    await flush();
    assert.equal(sent.length, 1);
  });

  test('empty events do not generate a welcome reply', async () => {
    const sent: Sent[] = [];
    await createHandler(deps())(fakeAdapter(sent), base({ text: '  ' }));
    await flush();
    assert.equal(sent.length, 0);
  });

  test('a new image resets the hint allowance without another conversation being affected', async () => {
    const sent: Sent[] = [];
    const d = deps();
    const handle = createHandler(d);
    const adapter = fakeAdapter(sent);
    await handle(adapter, base({ messageId: 'first', text: 'A plain request' }));
    await handle(adapter, base({ messageId: 'other', externalId: 'different-sender', text: 'A plain request' }));
    await handle(adapter, base({ messageId: 'photo', media: { ref: 'img', kind: 'image' } }));
    await handle(adapter, base({ messageId: 'after-photo', text: 'Another plain request' }));
    await handle(adapter, base({ messageId: 'repeated', text: 'Another plain request' }));
    await flush();
    assert.equal(sent.length, 4);
    assert.equal(d.shares.length, 1);
  });

  test('concurrent and later duplicate Approve deliveries only start checkout once', async () => {
    const sent: Sent[] = [];
    let checkouts = 0;
    const handle = createHandler(deps({ startCheckout: async () => { checkouts++; return 'checkout link'; } }));
    const adapter = fakeAdapter(sent);
    const message = base({ buttonReply: { id: 'approve:item_7', title: 'Approve' } });
    await Promise.all([handle(adapter, message), handle(adapter, message)]);
    await handle(adapter, message);
    await flush();
    assert.equal(checkouts, 1);
    assert.equal(sent.length, 1);
  });

  test('a persistence failure can be retried using the same message ID', async () => {
    const sent: Sent[] = [];
    let attempts = 0;
    const handle = createHandler(deps({ recordShare: async () => {
      if (++attempts === 1) throw new Error('database unavailable');
      return true;
    } }));
    const adapter = fakeAdapter(sent);
    const message = base({ urls: ['https://www.instagram.com/reel/A'] });
    await assert.rejects(handle(adapter, message), /database unavailable/);
    await handle(adapter, message);
    await flush();
    assert.equal(attempts, 2);
    assert.equal(sent.length, 1);
  });

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
    assert.match(sent[0].args[0] as string, /another screenshot or product link/);
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

  test('a plain product request never creates a share — it gets the hint', async () => {
    const sent: Sent[] = [];
    let called = false;
    const d = deps({ recordShare: async () => (called = true, true) });
    await createHandler(d)(fakeAdapter(sent), base({ text: 'find me a black jacket' }));
    await flush();

    assert.equal(called, false);
    assert.equal(d.shares.length, 0);
    assert.equal(sent.length, 1);
    assert.equal(
      sent[0].args[0],
      "Send me a link to the post or a screenshot of the product and I'll find it.",
    );
  });

  test('any other plain text gets the same hint', async () => {
    const sent: Sent[] = [];
    const d = deps();
    await createHandler(d)(
      fakeAdapter(sent),
      base({ text: 'do you guys ship to canada' }),
    );
    await flush();

    assert.equal(d.shares.length, 0);
    assert.match(sent[0].args[0] as string, /screenshot of the product/);
  });

  test('a redelivery that dedupes sends no ack', async () => {
    const sent: Sent[] = [];
    const d = deps({ recordShare: async () => false });
    await createHandler(d)(
      fakeAdapter(sent),
      base({
        text: 'look https://www.instagram.com/reel/A/',
        urls: ['https://www.instagram.com/reel/A'],
      }),
    );
    await flush();

    assert.equal(sent.length, 0);
  });
});
