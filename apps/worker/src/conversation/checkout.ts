import { db, users, identities } from '@prava/db';
import { and, eq } from 'drizzle-orm';
import { loadItem } from '../intake/store.ts';
import { signChatLogin } from './link.ts';

/**
 * Approve button → a signed link into the web checkout. Passkey approval only
 * exists inside a browser (Prava's iframe), so the chat flow has to hand off
 * here — the link signs the chat user in and opens the checkout page.
 *
 * Returns the message to send back to the user.
 */
export async function startCheckout(userId: string, itemId: string): Promise<string> {
  const item = await loadItem(itemId);
  if (!item) return 'That item is no longer available.';

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  // Prava requires an email to open a session and WhatsApp users never gave us
  // one — this placeholder only exists so the sandbox flow isn't blocked.
  if (user && !user.email) {
    const [identity] = await db
      .select({ externalId: identities.externalId })
      .from(identities)
      .where(and(eq(identities.userId, userId), eq(identities.platform, 'whatsapp')))
      .limit(1);
    const external = identity?.externalId ?? userId;
    await db
      .update(users)
      .set({ email: `wa-${external}@sendit.app` })
      .where(eq(users.id, userId));
  }

  // || not ?? — .env keeps WEB_ORIGIN present-but-empty in dev.
  const origin = process.env.WEB_ORIGIN || 'http://localhost:4321';
  const url = `${origin}/chat-login?${signChatLogin({ userId, next: `/checkout/${itemId}` })}`;

  const price =
    item.priceAmount && item.currency
      ? new Intl.NumberFormat('en', { style: 'currency', currency: item.currency }).format(
          Number(item.priceAmount),
        )
      : 'price unknown';

  return (
    `Test purchase, no real money (Prava sandbox).\n\n` +
    `${item.title} — ${price}\n${item.merchant ?? 'Unknown merchant'}\n\n` +
    `Confirm with your passkey here (link valid 15 min):\n${url}`
  );
}
