import { db, shares, items } from '@prava/db';
import { asc, eq } from 'drizzle-orm';
import { resolve } from './resolve.ts';
import { acquireMedia, UnreadableLinkError } from './media.ts';
import { getChannel } from '../channels/index.ts';
import { lookupExternalId } from '../intake/store.ts';
import type { ChannelName } from '../channels/types.ts';

const IDLE_POLL_MS = 3000;

type Share = typeof shares.$inferSelect;

/**
 * Take the oldest queued share and mark it in-flight. A crash mid-resolve
 * leaves the row stuck in 'resolving' rather than silently re-running an
 * LLM call and a paid search on every restart.
 */
async function claimNext(): Promise<Share | undefined> {
  const [next] = await db
    .select()
    .from(shares)
    .where(eq(shares.status, 'queued'))
    .orderBy(asc(shares.createdAt))
    .limit(1);

  if (!next) return undefined;

  await db.update(shares).set({ status: 'resolving' }).where(eq(shares.id, next.id));
  return next;
}

/**
 * Tell the sender what their DM turned into. A send failure is logged, never
 * thrown — the share is resolved regardless of whether the reply landed, and
 * an unreachable chat API must not poison the row.
 */
async function notify(share: Share, text: string): Promise<void>;
async function notify(share: Share, fn: (to: string) => Promise<void>, label: string): Promise<void>;
async function notify(
  share: Share,
  fnOrText: string | ((to: string) => Promise<void>),
  label = 'text',
): Promise<void> {
  try {
    const to = await lookupExternalId(share.userId, share.platform as ChannelName);
    if (!to) return;
    const channel = getChannel(share.platform);
    const fn = typeof fnOrText === 'string' ? (t: string) => channel.sendText(t, fnOrText) : fnOrText;
    await fn(to);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The outgoing body is the only evidence of what the user would have seen
    // when a send can't be delivered — keep it in the log at info level.
    console.error(`resolver: notify ${label} failed for share ${share.id} — ${message}`);
    if (typeof fnOrText === 'string') console.log(`resolver: unsent message: ${fnOrText}`);
  }
}

async function processShare(share: Share): Promise<void> {
  try {
    const media = await acquireMedia(share);

    // Persisted before resolving: even a share that fails to match should show
    // the user what they sent. Text shares have no frame, so nothing to store.
    if (media) {
      await db
        .update(shares)
        .set({ thumbnail: `data:${media.mediaType};base64,${media.imageBase64}` })
        .where(eq(shares.id, share.id));
    }

    const result = await resolve({ media, text: share.inputText ?? media?.caption });

    let topItemId: string | null = null;
    if (result.candidates.length) {
      const inserted = await db
        .insert(items)
        .values(
          result.candidates.map((candidate, rank) => ({
            shareId: share.id,
            rank,
            tier: 'deeplink' as const,
            title: candidate.title,
            merchant: candidate.merchant,
            merchantDomain: candidate.merchantDomain,
            priceAmount: candidate.priceAmount,
            currency: candidate.currency,
            imageUrl: candidate.imageUrl,
            productUrl: candidate.productUrl,
            catalogProductId: candidate.productId,
          })),
        )
        .returning({ id: items.id, rank: items.rank });
      topItemId = inserted.find((i) => i.rank === 0)?.id ?? inserted[0]?.id ?? null;
    }

    await db
      .update(shares)
      .set({ status: 'resolved', resolution: result.resolution, resolvedAt: new Date() })
      .where(eq(shares.id, share.id));

    console.log(
      `resolver: ${share.id} → ${result.resolution}, ${result.candidates.length} item(s)`,
    );

    const top = result.candidates[0];
    if (!top || !topItemId) {
      await notify(
        share,
        "I couldn't find a match. Try a clearer screenshot or tell me the brand and product name.",
      );
      return;
    }

    if (top.imageUrl) {
      await notify(share, (to) => getChannel(share.platform).sendImage(to, { url: top.imageUrl! }), 'image');
    }

    const price =
      top.priceAmount && top.currency
        ? new Intl.NumberFormat('en', { style: 'currency', currency: top.currency }).format(
            Number(top.priceAmount),
          )
        : 'price unknown';

    const body =
      `Best match:\n${top.title}\n${top.merchant ?? 'Unknown merchant'} — ${price}\n\n` +
      'Test purchase, no real money (Prava sandbox). Approve to continue.';

    await notify(
      share,
      (to) =>
        getChannel(share.platform).sendButtons(to, body, [
          { id: `approve:${topItemId}`, title: 'Approve' },
          { id: `reject:${share.id}`, title: 'Not this one' },
        ]),
      'buttons',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(shares).set({ status: 'failed', error: message }).where(eq(shares.id, share.id));
    console.error(`resolver: ${share.id} failed — ${message}`);

    await notify(
      share,
      err instanceof UnreadableLinkError
        ? "I couldn't read that link. Send me a screenshot of the product instead."
        : 'Something went wrong finding that product. Try again with a screenshot.',
    );
  }
}

export function startResolverLoop(): void {
  const tick = async (): Promise<void> => {
    let worked = false;

    try {
      const share = await claimNext();
      if (share) {
        worked = true;
        await processShare(share);
      }
    } catch (err) {
      console.error('resolver: loop error', err);
    }

    // Drain a backlog without waiting a full poll between each share.
    setTimeout(tick, worked ? 0 : IDLE_POLL_MS);
  };

  console.log('resolver loop started');
  void tick();
}
