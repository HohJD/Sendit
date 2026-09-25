export type ChannelName = 'whatsapp' | 'instagram';

/**
 * One inbound DM, normalised out of a platform webhook. A single webhook
 * delivery can hold several of these (Meta batches), so parsers return arrays.
 */
export interface InboundMessage {
  channel: ChannelName;
  /** IGSID for Instagram, E.164 digits for WhatsApp. Not a user id. */
  externalId: string;
  /** Platform message id — the idempotency key for retried deliveries. */
  messageId: string;
  /** Message body, or the caption riding on a media message. */
  text?: string;
  /** URLs extracted from text by intake/extract-url.ts. */
  urls: string[];
  media?: {
    /** WhatsApp media id, or an Instagram CDN url — resolved via fetchMedia. */
    ref: string;
    kind: 'image' | 'video' | 'other';
    mimeType?: string;
    caption?: string;
  };
  /** A tap on a button we sent — carries our payload id back. */
  buttonReply?: { id: string; title: string };
  raw: unknown;
}

/** WhatsApp caps interactive replies at 3 buttons, titles <= 20 chars. */
export interface Button {
  id: string;
  title: string;
}

/**
 * One messaging surface: parse what the platform POSTs us, send what the
 * conversation and resolver need to say back. Outbound calls throw on failure
 * — callers decide whether a send error is worth failing work over (it isn't:
 * a share stays resolved even when the reply can't be delivered).
 */
export interface ChannelAdapter {
  name: ChannelName;
  webhookPath: string;
  /** Handshake token Meta echoes back during webhook subscription. */
  verifyToken(): string;
  parseWebhook(body: unknown): InboundMessage[];
  sendText(to: string, text: string): Promise<void>;
  sendImage(to: string, image: { url: string; caption?: string }): Promise<void>;
  sendButtons(to: string, body: string, buttons: Button[]): Promise<void>;
  fetchMedia(ref: string): Promise<{ buffer: Buffer; mimeType: string }>;
}
