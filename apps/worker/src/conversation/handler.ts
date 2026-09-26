import type { ChannelAdapter, ChannelName, InboundMessage } from '../channels/types.ts';
import type { NewShare } from '../intake/store.ts';

/**
 * Dependencies injected so tests can drive the handler without a database or
 * a live Meta token — server.ts wires the real store.ts implementations.
 */
export interface HandlerDeps {
  /** true when a share row was queued; false when dedupe swallowed it. */
  recordShare(share: NewShare): Promise<boolean>;
  resolveUserId(channel: ChannelName, externalId: string): Promise<string>;
  /** Returns the chat message containing the checkout link. */
  startCheckout(userId: string, itemId: string): Promise<string>;
}

const WELCOME =
  'Hi, I\'m Sendit. Send me an Instagram/TikTok link or a screenshot of a ' +
  'product and I\'ll find it and set up a test purchase — no real money, ' +
  'Prava sandbox.';

/** Text alone is never enough to identify a product — it earns a hint, not a share. */
const HINT =
  'Send me a link to the post or a screenshot of the product and I\'ll find it.';

const GREETING = /^\s*(hi|hello|hey|start|help)\b/i;

/**
 * The conversation brain: one inbound DM in, shares queued and replies sent
 * out. Shares are persisted before any ack goes out, but a failed send never
 * reaches the caller — the webhook ack must not turn a delivery error into a
 * Meta retry of an already-processed message.
 */
export function createHandler(deps: HandlerDeps) {
  const notices = new Set<string>();
  const processed = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();
  const remember = (entries: Set<string>, key: string): void => {
    entries.add(key);
    if (entries.size > 10_000) entries.delete(entries.values().next().value!);
  };
  /** Fire-and-forget: logged, never thrown. The unsent body goes to the log so
   * a failed send (dead token, no network) still shows what the user missed. */
  const send = (fn: () => Promise<void>, body?: string): void => {
    fn().catch((err) => {
      console.error('conversation: send failed', err);
      if (body) console.log(`conversation: unsent message: ${body}`);
    });
  };

  async function handleMessage(adapter: ChannelAdapter, msg: InboundMessage): Promise<void> {
    const to = msg.externalId;
    const conversationKey = JSON.stringify([msg.channel, to]);
    const informOnce = (text: string): void => {
      if (notices.has(conversationKey)) return;
      remember(notices, conversationKey);
      send(() => adapter.sendText(to, text));
    };

    // A tap on a button we sent — these ids are ours, minted by the resolver.
    if (msg.buttonReply) {
      const [action, id] = msg.buttonReply.id.split(':');
      if (action === 'approve' && id) {
        const userId = await deps.resolveUserId(msg.channel, msg.externalId);
        const text = await deps.startCheckout(userId, id);
        send(() => adapter.sendText(to, text), text);
      } else if (action === 'reject') {
        informOnce('No problem. Send me another screenshot or product link.');
      }
      return;
    }

    let queued = 0;
    let ack: (() => Promise<void>) | null = null;

    if (msg.urls.length) {
      for (const url of msg.urls) {
        if (await deps.recordShare({
          platform: msg.channel,
          externalId: msg.externalId,
          messageId: msg.messageId,
          inputKind: 'link',
          sourceUrl: url,
          inputText: msg.text,
          raw: msg.raw,
        })) queued += 1;
      }
      ack = () => adapter.sendText(to, 'On it — reading that link…');
    } else if (msg.media) {
      if (msg.media.kind === 'image') {
        if (await deps.recordShare({
          platform: msg.channel,
          externalId: msg.externalId,
          messageId: msg.messageId,
          inputKind: 'image',
          sourceUrl: '',
          inputText: msg.media.caption ?? msg.text,
          mediaRef: msg.media.ref,
          raw: msg.raw,
        })) queued += 1;
        ack = () => adapter.sendText(to, 'On it — finding that product…');
      } else {
        informOnce("I can't watch videos yet. Send me a screenshot of the product instead.");
        return;
      }
    } else {
      const text = (msg.text ?? '').trim();
      if (!text) return;
      if (GREETING.test(text) || text.length < 4) {
        informOnce(WELCOME);
        return;
      }
      // Plain text never starts a search — "find me a black jacket" can't be
      // identified by the resolver, so we steer to a link or screenshot and
      // record nothing.
      informOnce(HINT);
      return;
    }

    // One ack per inbound message no matter how many shares it produced, and
    // silence on a redelivery — the user already heard from us the first time.
    if (queued > 0 && ack) {
      notices.delete(conversationKey);
      send(ack);
    }
  }

  return async function handleInbound(adapter: ChannelAdapter, msg: InboundMessage): Promise<void> {
    const key = JSON.stringify([msg.channel, msg.externalId, msg.messageId]);
    if (processed.has(key)) return;
    const pending = inFlight.get(key);
    if (pending) return pending;
    if (inFlight.size >= 10_000) throw new Error('intake capacity reached');
    const task = Promise.resolve().then(() => handleMessage(adapter, msg));
    inFlight.set(key, task);
    try {
      await task;
      remember(processed, key);
    } finally {
      inFlight.delete(key);
    }
  };
}
