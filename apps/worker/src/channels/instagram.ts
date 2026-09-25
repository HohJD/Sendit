import { canonicalize, extractUrls } from '../intake/extract-url.ts';
import type { Button, ChannelAdapter, InboundMessage } from './types.ts';

/**
 * Instagram Messaging API (Graph v23.0).
 *
 * Attachment types that carry a shareable media URL. `ig_post` is a shared
 * feed post — the most common thing people actually send — and unlike a reel
 * its payload carries a directly fetchable CDN image, so it lands in `media`.
 * Reels only carry a permalink: it goes into `urls` and the resolver scrapes
 * the keyframe from the public page.
 */
const SHAREABLE = new Set(['ig_reel', 'reel', 'ig_post', 'share', 'image']);
const MEDIA_TYPES = new Set(['image', 'ig_post']);

const GRAPH = 'https://graph.instagram.com/v23.0';

/** Instagram serves og: tags to crawlers, and only to crawlers. */
const CRAWLER_UA = 'facebookexternalhit/1.1';

interface IgAttachment {
  type?: string;
  payload?: { url?: string; title?: string; reel_video_id?: string };
}

interface IgMessaging {
  sender?: { id?: string };
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    attachments?: IgAttachment[];
    quick_reply?: { payload?: string };
  };
}

interface IgPayload {
  object?: string;
  entry?: Array<{ messaging?: IgMessaging[] }>;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function parseInstagramWebhook(body: unknown): InboundMessage[] {
  const payload = body as IgPayload;
  const messages: InboundMessage[] = [];

  for (const entry of payload.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      const message = event.message;
      const senderId = event.sender?.id;

      // Echoes are our own outbound replies coming back to us.
      if (!message || !senderId || message.is_echo) continue;

      const messageId = message.mid;
      if (!messageId) continue;

      const inbound: InboundMessage = {
        channel: 'instagram',
        externalId: senderId,
        messageId,
        text: message.text,
        urls: extractUrls(message.text),
        raw: event,
      };

      if (message.quick_reply?.payload) {
        inbound.buttonReply = { id: message.quick_reply.payload, title: '' };
      }

      const seen = new Set(inbound.urls);

      for (const attachment of message.attachments ?? []) {
        if (!SHAREABLE.has(attachment.type ?? '')) continue;
        const url = attachment.payload?.url;
        if (!url) continue;

        if (MEDIA_TYPES.has(attachment.type ?? '') && !inbound.media) {
          // Photos and shared posts carry a directly fetchable CDN image.
          inbound.media = {
            ref: url,
            kind: 'image',
            caption: attachment.payload?.title ?? message.text,
          };
          continue;
        }

        // Reels and shares carry only a permalink — the resolver scrapes it.
        const sourceUrl = canonicalize(url);
        if (seen.has(sourceUrl)) continue;
        seen.add(sourceUrl);
        inbound.urls.push(sourceUrl);
      }

      messages.push(inbound);
    }
  }

  return messages;
}

async function send(payload: Record<string, unknown>): Promise<void> {
  const token = requireEnv('IG_PAGE_ACCESS_TOKEN');

  const res = await fetch(`${GRAPH}/me/messages?access_token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`instagram send failed: ${res.status} ${text}`);
  }
}

export const instagram: ChannelAdapter = {
  name: 'instagram',
  webhookPath: '/webhooks/instagram',

  verifyToken() {
    return requireEnv('META_VERIFY_TOKEN');
  },

  parseWebhook: parseInstagramWebhook,

  async sendText(to, text) {
    await send({ recipient: { id: to }, message: { text } });
  },

  async sendImage(to, image) {
    await send({
      recipient: { id: to },
      message: { attachment: { type: 'image', payload: { url: image.url } } },
    });
    // The attachment payload can't carry a caption, so it rides separately.
    if (image.caption) await instagram.sendText(to, image.caption);
  },

  async sendButtons(to, body, buttons: Button[]) {
    // IG has no native buttons; quick_replies are the closest equivalent and
    // round-trip our payload id the same way.
    await send({
      recipient: { id: to },
      message: {
        text: body,
        quick_replies: buttons.map((b) => ({
          content_type: 'text',
          title: b.title.slice(0, 20),
          payload: b.id,
        })),
      },
    });
  },

  /** CDN URL — no auth, but signed and short-lived. */
  async fetchMedia(ref) {
    const res = await fetch(ref, { headers: { 'user-agent': CRAWLER_UA } });
    if (!res.ok) throw new Error(`instagram media fetch failed: ${res.status}`);
    const mimeType = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    return { buffer: Buffer.from(await res.arrayBuffer()), mimeType };
  },
};
