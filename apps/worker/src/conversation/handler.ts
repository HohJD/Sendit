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
  'Hi, I\'m Sendit. Send me an Instagram/TikTok link, a screenshot, or just ' +
  'describe the product ("find me this jacket") and I\'ll find it and set up ' +
  'a test purchase — no real money, Prava sandbox.';

const GREETING = /^\s*(hi|hello|hey|start|help)\b/i;

/**
 * The conversation brain: one inbound DM in, shares queued and replies sent
 * out. Shares are persisted before any ack goes out, but a failed send never
 * reaches the caller — the webhook ack must not turn a delivery error into a
 * Meta retry of an already-processed message.
 */
export function createHandler(deps: HandlerDeps) {
  /** Fire-and-forget: logged, never thrown. The unsent body goes to the log so
   * a failed send (dead token, no network) still shows what the user missed. */
  const send = (fn: () => Promise<void>, body?: string): void => {
    fn().catch((err) => {
      console.error('conversation: send failed', err);
      if (body) console.log(`conversation: unsent message: ${body}`);
    });
  };

  return async function handleInbound(adapter: ChannelAdapter, msg: InboundMessage): Promise<void> {
    const to = msg.externalId;

    // A tap on a button we sent — these ids are ours, minted by the resolver.
    if (msg.buttonReply) {
      const [action, id] = msg.buttonReply.id.split(':');
      if (action === 'approve' && id) {
        const userId = await deps.resolveUserId(msg.channel, msg.externalId);
        const text = await deps.startCheckout(userId, id);
        send(() => adapter.sendText(to, text), text);
      } else if (action === 'reject') {
        send(() =>
          adapter.sendText(to, 'No problem. Send me another screenshot, link, or describe what you\'re after.'),
        );
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
        send(() =>
          adapter.sendText(to, "I can't watch videos yet. Send me a screenshot of the product instead."),
        );
        return;
      }
    } else {
      const text = (msg.text ?? '').trim();
      if (GREETING.test(text) || text.length < 4) {
        send(() => adapter.sendText(to, WELCOME));
        return;
      }
      if (await deps.recordShare({
        platform: msg.channel,
        externalId: msg.externalId,
        messageId: msg.messageId,
        inputKind: 'text',
        sourceUrl: '',
        inputText: text,
        raw: msg.raw,
      })) queued += 1;
      ack = () => adapter.sendText(to, `On it — searching for "${text}"…`);
    }

    // One ack per inbound message no matter how many shares it produced, and
    // silence on a redelivery — the user already heard from us the first time.
    if (queued > 0 && ack) send(ack);
  };
}
