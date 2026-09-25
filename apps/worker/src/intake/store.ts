import { db, users, identities, shares, items } from '@prava/db';
import { and, eq } from 'drizzle-orm';
import type { ChannelName } from '../channels/types.ts';

/**
 * One share to persist, normalised by the conversation handler rather than a
 * platform parser — by this point the platform-specific shape is gone.
 */
export interface NewShare {
  platform: ChannelName;
  externalId: string;
  messageId: string;
  inputKind: 'link' | 'image' | 'text';
  /** '' for image/text shares — the dedupe index keys on it. */
  sourceUrl: string;
  inputText?: string;
  mediaRef?: string;
  raw: unknown;
}

/**
 * Map a platform handle to a user, creating one if this is a first contact.
 *
 * Instagram senders arrive as an IGSID with no phone number attached, so a
 * first-contact IG user is created with no contact details. Binding that to a
 * real account is a separate one-time link step; until then the shares still
 * accumulate against a stable user row rather than being dropped.
 */
export async function resolveUserId(
  platform: ChannelName,
  externalId: string,
): Promise<string> {
  const existing = await db
    .select({ userId: identities.userId })
    .from(identities)
    .where(and(eq(identities.platform, platform), eq(identities.externalId, externalId)))
    .limit(1);

  if (existing[0]) return existing[0].userId;

  const [user] = await db
    .insert(users)
    .values({ phone: platform === 'whatsapp' ? externalId : null })
    .returning({ id: users.id });

  await db
    .insert(identities)
    .values({ userId: user.id, platform, externalId })
    .onConflictDoNothing();

  // A concurrent delivery from the same new sender may have won the insert.
  const settled = await db
    .select({ userId: identities.userId })
    .from(identities)
    .where(and(eq(identities.platform, platform), eq(identities.externalId, externalId)))
    .limit(1);

  return settled[0]?.userId ?? user.id;
}

/**
 * Insert one share. Returns true when a row was actually queued — false when
 * the dedupe index swallowed it (Meta retries deliveries), which tells the
 * caller not to ack a message the user already got a reply for.
 */
export async function recordShare(share: NewShare): Promise<boolean> {
  const userId = await resolveUserId(share.platform, share.externalId);

  const inserted = await db
    .insert(shares)
    .values({
      userId,
      platform: share.platform,
      sourceUrl: share.sourceUrl,
      inputKind: share.inputKind,
      inputText: share.inputText ?? null,
      mediaRef: share.mediaRef ?? null,
      messageId: share.messageId,
      rawPayload: share.raw as object,
      status: 'queued',
    })
    .onConflictDoNothing()
    .returning({ id: shares.id });

  return inserted.length > 0;
}

/** External handle for a user on a channel — where outbound replies go. */
export async function lookupExternalId(
  userId: string,
  platform: ChannelName,
): Promise<string | null> {
  const [row] = await db
    .select({ externalId: identities.externalId })
    .from(identities)
    .where(and(eq(identities.userId, userId), eq(identities.platform, platform)))
    .limit(1);
  return row?.externalId ?? null;
}

export async function loadItem(itemId: string) {
  const [item] = await db.select().from(items).where(eq(items.id, itemId)).limit(1);
  return item ?? null;
}
