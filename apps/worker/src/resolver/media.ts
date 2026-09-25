import { getChannel, type ChannelName } from '../channels/index.ts';

export interface ShareMedia {
  imageBase64: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  caption?: string;
}

const MEDIA_TYPES: Record<string, ShareMedia['mediaType']> = {
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
};

/** Instagram serves og: tags to crawlers, and only to crawlers. */
const CRAWLER_UA = 'facebookexternalhit/1.1';

const OG_IMAGE = /<meta property="og:image" content="([^"]+)"/;

/**
 * The link pointed somewhere we can't read — private post, removed page, or
 * the CDN rejected the download. Named so the loop can tell the sender apart
 * from a genuine resolver failure.
 */
export class UnreadableLinkError extends Error {
  constructor(public readonly url: string) {
    super(`unreadable link: ${url}`);
    this.name = 'UnreadableLinkError';
  }
}

interface RawEvent {
  message?: {
    text?: string;
    attachments?: Array<{ type?: string; payload?: { url?: string; title?: string } }>;
  };
}

async function download(
  url: string,
  onFailure: (err: Error) => Error,
): Promise<{ imageBase64: string; mediaType: ShareMedia['mediaType'] }> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'user-agent': CRAWLER_UA } });
  } catch (err) {
    throw onFailure(err as Error);
  }
  if (!res.ok) throw onFailure(new Error(`media fetch failed: ${res.status}`));

  const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const mediaType = MEDIA_TYPES[contentType];
  if (!mediaType) throw new Error(`unsupported media type: ${contentType || 'unknown'}`);

  return { imageBase64: Buffer.from(await res.arrayBuffer()).toString('base64'), mediaType };
}

/**
 * The og:image off a public page. Instagram's own reel pages carry the
 * keyframe there; most other storefront/feed pages do too. Crawler UA is the
 * whole trick — served to crawlers only.
 */
async function ogImage(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'user-agent': CRAWLER_UA } });
  } catch {
    throw new UnreadableLinkError(url);
  }
  if (!res.ok) throw new UnreadableLinkError(url);

  const match = OG_IMAGE.exec(await res.text());
  if (!match) throw new UnreadableLinkError(url);

  return match[1].replace(/&amp;/g, '&');
}

/**
 * Pull a resolvable image out of a share — or null for a text request, which
 * has nothing to look at.
 *
 * 'image' shares hold a platform media ref (a WhatsApp media id or an
 * Instagram CDN url) resolved through the channel adapter. 'link' shares
 * scrape the og:image of whatever page the link points at — Instagram reel
 * pages and anything else alike. CDN URLs are signed and expire, which is why
 * the loop downloads on a short poll rather than lazily at render time.
 */
export async function acquireMedia(share: {
  rawPayload: unknown;
  sourceUrl: string;
  inputKind?: string;
  inputText?: string | null;
  mediaRef?: string | null;
  platform: string;
}): Promise<ShareMedia | null> {
  const kind = share.inputKind ?? 'link';

  if (kind === 'text') return null;

  if (kind === 'image') {
    if (!share.mediaRef) throw new Error('image share has no media ref');
    const { buffer, mimeType } = await getChannel(share.platform as ChannelName).fetchMedia(share.mediaRef);
    const mediaType = MEDIA_TYPES[mimeType.toLowerCase()];
    if (!mediaType) throw new Error(`unsupported media type: ${mimeType || 'unknown'}`);
    return {
      imageBase64: buffer.toString('base64'),
      mediaType,
      caption: share.inputText ?? undefined,
    };
  }

  const event = share.rawPayload as RawEvent | null;
  const attachments = event?.message?.attachments ?? [];

  // Rows from before inputKind existed still carry attachments in the raw
  // payload — photos and shared feed posts have a directly fetchable CDN image.
  const direct = attachments.find(
    (a) => (a.type === 'image' || a.type === 'ig_post') && a.payload?.url,
  );
  if (direct?.payload?.url) {
    return {
      ...(await download(direct.payload.url, () => new UnreadableLinkError(share.sourceUrl))),
      // A shared post carries the original caption; a photo carries whatever
      // the sender typed alongside it.
      caption: direct.payload.title ?? share.inputText ?? event?.message?.text,
    };
  }

  if (/^https?:\/\//i.test(share.sourceUrl)) {
    const reel = attachments.find((a) => a.type === 'ig_reel' || a.type === 'reel');
    const imageUrl = await ogImage(share.sourceUrl);
    return {
      ...(await download(imageUrl, () => new UnreadableLinkError(share.sourceUrl))),
      caption: reel?.payload?.title ?? share.inputText ?? event?.message?.text,
    };
  }

  throw new UnreadableLinkError(share.sourceUrl || '(none)');
}
