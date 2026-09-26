import { db, users, identities } from '@prava/db';
import { and, eq, inArray } from 'drizzle-orm';
import { loadItem } from '../intake/store.ts';
import { launchGrokCheckout } from './grok-checkout.ts';

/**
 * Approve button → Grok walks the store on this Mac with the sandbox test
 * card and stops before placing the order. No pay link is sent.
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
      // Same identity either way: both adapters key on the sender's phone.
      .where(and(eq(identities.userId, userId), inArray(identities.platform, ['wassist', 'whatsapp'])))
      .limit(1);
    const external = identity?.externalId ?? userId;
    await db
      .update(users)
      .set({ email: `wa-${external}@sendit.app` })
      .where(eq(users.id, userId));
  }

  const price =
    item.priceAmount && item.currency
      ? new Intl.NumberFormat('en', { style: 'currency', currency: item.currency }).format(
          Number(item.priceAmount),
        )
      : 'price unknown';

  let grokOpened = false;
  if (item.productUrl) {
    try {
      await launchGrokCheckout(item.productUrl);
      grokOpened = true;
    } catch (err) {
      console.error('checkout: could not launch Grok', err);
    }
  }

  const intro = grokOpened
    ? 'Grok is walking this purchase on your laptop. It will fill the sandbox test card and stop before placing the order.'
    : 'Grok could not be started on this laptop, so nothing was opened and no order was placed.';

  return `${intro}\n\n${item.title} — ${price}\n${item.merchant ?? 'Unknown merchant'}\n\nNo order will be placed.`;
}
