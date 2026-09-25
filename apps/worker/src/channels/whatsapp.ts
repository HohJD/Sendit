import { extractUrls } from '../intake/extract-url.ts';
import type { Button, ChannelAdapter, InboundMessage } from './types.ts';

/**
 * WhatsApp Cloud API (Graph v23.0).
 *
 * Webhook: entry[].changes[] where field === 'messages'; delivery receipts
 * arrive under `statuses` and are ignored. A shared reel arrives as a plain
 * text body — there is no attachment object — so extractUrls does the work.
 *
 * Outbound: we only ever reply inside the 24-hour customer-service window
 * opened by the user's own message, so plain messages suffice — no template
 * approval needed.
 */

const GRAPH = 'https://graph.facebook.com/v23.0';

interface WaMessage {
  id?: string;
  from?: string;
  type?: string;
  text?: { body?: string };
  image?: { id?: string; mime_type?: string; caption?: string };
  video?: { id?: string; mime_type?: string; caption?: string };
  document?: { id?: string; mime_type?: string; caption?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
  };
}

interface WaPayload {
  object?: string;
  entry?: Array<{
    changes?: Array<{ field?: string; value?: { messages?: WaMessage[] } }>;
  }>;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function parseWhatsAppWebhook(body: unknown): InboundMessage[] {
  const payload = body as WaPayload;
  const messages: InboundMessage[] = [];

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field && change.field !== 'messages') continue;

      for (const message of change.value?.messages ?? []) {
        const from = message.from;
        const messageId = message.id;
        if (!from || !messageId) continue;

        const base = { channel: 'whatsapp' as const, externalId: from, messageId, raw: message };

        if (message.type === 'text') {
          const text = message.text?.body ?? '';
          messages.push({ ...base, text, urls: extractUrls(text) });
          continue;
        }

        if (message.type === 'interactive' && message.interactive?.type === 'button_reply') {
          const reply = message.interactive.button_reply;
          if (reply?.id) {
            messages.push({
              ...base,
              urls: [],
              buttonReply: { id: reply.id, title: reply.title ?? '' },
            });
          }
          continue;
        }

        const media: InboundMessage['media'] =
          message.type === 'image'
            ? { ref: message.image?.id ?? '', kind: 'image', mimeType: message.image?.mime_type, caption: message.image?.caption }
            : message.type === 'video'
              ? { ref: message.video?.id ?? '', kind: 'video', mimeType: message.video?.mime_type, caption: message.video?.caption }
              : message.document?.id
                ? { ref: message.document.id, kind: 'other', mimeType: message.document.mime_type, caption: message.document.caption }
                : undefined;

        if (media?.ref) {
          messages.push({
            ...base,
            text: media.caption,
            urls: extractUrls(media.caption),
            media,
          });
        }
      }
    }
  }

  return messages;
}

/**
 * POST to the phone-number's /messages edge. Meta's error body is the only
 * way to tell a bad token from an unregistered recipient, so it goes in the
 * thrown message verbatim.
 */
async function send(payload: Record<string, unknown>): Promise<void> {
  const token = requireEnv('WHATSAPP_TOKEN');
  const phoneNumberId = requireEnv('WHATSAPP_PHONE_NUMBER_ID');

  const res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      ...payload,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`whatsapp send failed: ${res.status} ${text}`);
  }
}

export const whatsapp: ChannelAdapter = {
  name: 'whatsapp',
  webhookPath: '/webhooks/whatsapp',

  verifyToken() {
    return requireEnv('WHATSAPP_VERIFY_TOKEN');
  },

  parseWebhook: parseWhatsAppWebhook,

  async sendText(to, text) {
    await send({ to, type: 'text', text: { body: text, preview_url: true } });
  },

  async sendImage(to, image) {
    await send({
      to,
      type: 'image',
      image: { link: image.url, ...(image.caption ? { caption: image.caption } : {}) },
    });
  },

  async sendButtons(to, body, buttons: Button[]) {
    await send({
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        action: {
          buttons: buttons.map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.title.slice(0, 20) },
          })),
        },
      },
    });
  },

  /**
   * Two-step fetch: the media id (lives 30 days) trades for a CDN URL that
   * expires in ~5 minutes, and that URL 401s without the same Bearer token.
   * Always re-resolve the URL rather than storing it.
   */
  async fetchMedia(ref) {
    const token = requireEnv('WHATSAPP_TOKEN');
    const headers = { authorization: `Bearer ${token}` };

    const meta = await fetch(`${GRAPH}/${ref}`, { headers });
    if (!meta.ok) {
      throw new Error(`whatsapp media lookup failed: ${meta.status} ${await meta.text().catch(() => '')}`);
    }
    const { url, mime_type } = (await meta.json()) as { url?: string; mime_type?: string };
    if (!url) throw new Error('whatsapp media lookup returned no url');

    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`whatsapp media download failed: ${res.status}`);
    }

    return { buffer: Buffer.from(await res.arrayBuffer()), mimeType: mime_type ?? '' };
  },
};
