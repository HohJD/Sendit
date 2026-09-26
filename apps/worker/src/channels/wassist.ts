import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { extractUrls } from '../intake/extract-url.ts';
import type { Button, ChannelAdapter, InboundMessage } from './types.ts';

/**
 * Wassist (wassist.app) — a WhatsApp agent platform that forwards inbound
 * messages to our webhook and takes replies over its REST API.
 *
 * Inbound: a single `subscription.message.received` event per POST (unlike
 * Meta's batched entries). `externalId` is the contact's phone in E.164
 * digits so a user has one identity whether they reach us via Meta's Cloud
 * API or via Wassist.
 *
 * Outbound: Wassist addresses messages by `conversationId`, but our identity
 * is the phone number — `conversationByPhone` bridges the two, seeded by every
 * inbound delivery and recovered after a restart via the list-conversations
 * API.
 *
 * Signature: Stripe-style `X-Wassist-Signature: t=<unix>,v1=<hmac-sha256
 * (WASSIST_WEBHOOK_SECRET, `${t}.${rawBody}`)>`, with a ±300s replay window.
 */

const API = 'https://backend.wassist.app/api/v1';

/** phone (E.164 digits) → Wassist conversationId */
const conversationByPhone = new Map<string, string>();

interface WassistMediaEntry {
  url?: string;
  type?: string;
  mimeType?: string;
  mime_type?: string;
  mediaType?: string;
}

interface WassistButton {
  id?: string;
  quickReplyId?: string;
  payload?: string;
  text?: string;
  title?: string;
  name?: string;
}

interface WassistEvent {
  event?: string;
  conversationId?: string;
  contact?: { id?: string; name?: string | null; phoneNumber?: string };
  message?: {
    id?: string;
    body?: string | null;
    media?: Array<string | WassistMediaEntry>;
    buttons?: Array<string | WassistButton>;
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** Digits only — '447700900200' and '+44 7700 900200' are the same sender. */
function digits(phone: string): string {
  return phone.replace(/\D/g, '');
}

function mediaEntryRef(entry: string | WassistMediaEntry): string {
  return typeof entry === 'string' ? entry : (entry.url ?? '');
}

function mediaKind(entry: string | WassistMediaEntry): 'image' | 'video' | 'other' {
  const hint =
    typeof entry === 'string'
      ? entry
      : (entry.mimeType ?? entry.mime_type ?? entry.mediaType ?? entry.type ?? entry.url ?? '');
  if (/image|jpe?g|png|webp|gif/i.test(hint)) return 'image';
  if (/video|mp4|mov|webm/i.test(hint)) return 'video';
  return typeof entry === 'string' && /\.(jpe?g|png|webp|gif)(\?|$)/i.test(entry) ? 'image' : 'other';
}

function buttonReply(buttons: Array<string | WassistButton>): { id: string; title: string } | undefined {
  const first = buttons[0];
  if (first === undefined) return undefined;
  if (typeof first === 'string') return { id: first, title: first };
  const id = first.id ?? first.quickReplyId ?? first.payload ?? first.text;
  if (!id) return undefined;
  return { id, title: first.text ?? first.title ?? first.name ?? '' };
}

export function parseWassistWebhook(body: unknown): InboundMessage[] {
  const event = body as WassistEvent;
  // Only routed inbound messages produce work; lifecycle/test events are acked
  // and dropped. Wassist retries 5xx anyway, so a delivery we can't use must
  // not look like a failure.
  if (event.event !== 'subscription.message.received') return [];

  const phone = event.contact?.phoneNumber ? digits(event.contact.phoneNumber) : '';
  const messageId = event.message?.id;
  const conversationId = event.conversationId;
  if (!phone || !messageId || !conversationId) return [];

  // Refresh the phone→conversation mapping on every delivery — conversations
  // can be re-routed, so the newest id wins.
  conversationByPhone.set(phone, conversationId);

  const text = event.message?.body ?? undefined;
  const reply = buttonReply(event.message?.buttons ?? []);
  const mediaEntry = event.message?.media?.[0];

  const base = {
    channel: 'wassist' as const,
    externalId: phone,
    messageId,
    raw: event,
  };

  if (reply) {
    return [{ ...base, text, urls: extractUrls(text), buttonReply: reply }];
  }

  if (mediaEntry) {
    const ref = mediaEntryRef(mediaEntry);
    if (ref) {
      const kind = mediaKind(mediaEntry);
      const mimeType =
        typeof mediaEntry === 'string'
          ? undefined
          : (mediaEntry.mimeType ?? mediaEntry.mime_type ?? mediaEntry.mediaType);
      return [
        {
          ...base,
          text,
          urls: extractUrls(text),
          media: { ref, kind, mimeType, caption: text },
        },
      ];
    }
  }

  return [{ ...base, text, urls: extractUrls(text) }];
}

/**
 * `to` is the sender's phone (our externalId) but Wassist sends by
 * conversationId. Inbound deliveries seed the map; on a miss (worker restart)
 * ask the API for the conversation whose contact carries this number.
 */
export async function conversationFor(phone: string): Promise<string> {
  const key = digits(phone);
  const cached = conversationByPhone.get(key);
  if (cached) return cached;

  const res = await fetch(`${API}/conversations/?contact=${encodeURIComponent(key)}&limit=100`, {
    headers: { 'X-API-Key': requireEnv('WASSIST_API_KEY') },
  });
  if (!res.ok) {
    throw new Error(`wassist conversation lookup failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  const body = (await res.json()) as {
    results?: Array<{ id?: string; contact?: { phoneNumber?: string } }>;
  };
  const match = (body.results ?? []).find(
    (c) => c.id && c.contact?.phoneNumber && digits(c.contact.phoneNumber) === key,
  );
  if (!match?.id) {
    throw new Error(
      `wassist: no conversation on record for +${key} — the user must message us first`,
    );
  }
  conversationByPhone.set(key, match.id);
  return match.id;
}

async function post(path: string, payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      'X-API-Key': requireEnv('WASSIST_API_KEY'),
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`wassist send failed: ${res.status} ${text}`);
  }
}

export const wassist: ChannelAdapter = {
  name: 'wassist',
  webhookPath: '/webhooks/wassist',

  /** Wassist has no subscription handshake — GETs are acked in the server. */
  verifyToken() {
    throw new Error('wassist: verifyToken not applicable — signature verification only');
  },

  /**
   * Stripe-style `t=<ts>,v1=<hex>`: HMAC-SHA256 of `${t}.${rawBody}` under the
   * webhook signing secret, constant-time compared, ±300s replay window.
   */
  verifyRequest(rawBody: Buffer, headers: IncomingHttpHeaders): boolean {
    const secret = process.env.WASSIST_WEBHOOK_SECRET;
    const header = headers['x-wassist-signature'];
    const sig = Array.isArray(header) ? header[0] : header;
    if (!secret || !sig) return false;

    const parts = Object.fromEntries(
      sig.split(',').map((p) => p.split('=', 2) as [string, string]).filter(([k, v]) => k && v),
    );
    const t = parts.t;
    const v1 = parts.v1;
    if (!t || !v1 || !/^\d+$/.test(t)) return false;

    const expected = createHmac('sha256', secret)
      .update(`${t}.`)
      .update(rawBody)
      .digest('hex');
    const a = Buffer.from(v1, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

    return Math.abs(Date.now() / 1000 - Number(t)) <= 300;
  },

  parseWebhook: parseWassistWebhook,

  async sendText(to, text) {
    const conversationId = await conversationFor(to);
    await post(`/conversations/${conversationId}/messages/`, {
      type: 'text',
      text: { body: text },
    });
  },

  async sendImage(to, image) {
    const conversationId = await conversationFor(to);
    // 'unified' carries media + caption together; the legacy 'image' type is
    // deprecated in the API.
    await post(`/conversations/${conversationId}/messages/`, {
      type: 'unified',
      unified: {
        media: { url: image.url },
        ...(image.caption ? { text: image.caption.slice(0, 1024) } : {}),
      },
    });
  },

  async sendButtons(to, body, buttons: Button[]) {
    const conversationId = await conversationFor(to);
    // WhatsApp caps quick-reply titles at 20 chars and ids at 200 — the
    // approve:/reject: ids we carry are short, but titles get sliced anyway.
    await post(`/conversations/${conversationId}/messages/`, {
      type: 'unified',
      unified: {
        text: body.slice(0, 1024),
        buttons: buttons.map((b) => ({
          type: 'quick_reply',
          text: b.title.slice(0, 20),
          quickReplyId: b.id.slice(0, 200),
        })),
      },
    });
  },

  /**
   * Media refs are plain URLs. Anything hosted by Wassist itself presumably
   * needs the API key; third-party CDNs get a bare GET.
   */
  async fetchMedia(ref) {
    const needsKey = (() => {
      try {
        return new URL(ref).hostname.endsWith('wassist.app');
      } catch {
        return false;
      }
    })();
    const res = await fetch(ref, {
      headers: needsKey ? { 'X-API-Key': requireEnv('WASSIST_API_KEY') } : {},
    });
    if (!res.ok) {
      throw new Error(`wassist media download failed: ${res.status}`);
    }
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      mimeType: res.headers.get('content-type') ?? '',
    };
  },
};

/** Test-only: the phone→conversation map survives across parses. */
export function __resetWassistConversationsForTests(): void {
  conversationByPhone.clear();
}
