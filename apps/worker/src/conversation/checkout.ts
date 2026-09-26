import { randomUUID } from 'node:crypto';
import { db, users, identities, checkouts } from '@prava/db';
import { and, eq, inArray } from 'drizzle-orm';
import { loadItem } from '../intake/store.ts';
import { demoDeliveryWindow, demoSaleOutcome } from './demo-sale.ts';
import { launchGrokCheckout } from './grok-checkout.ts';
import { signChatLogin } from './link.ts';

/**
 * Approve button → Grok walks the store and stops before Pay. The chat then
 * shows a demo sale: complete, with a delivery window. Nothing is charged.
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

  if (item.productUrl) {
    try {
      await launchGrokCheckout(item.productUrl);
    } catch (err) {
      console.error('checkout: could not launch Grok', err);
    }
  }

  const delivery = demoDeliveryWindow();
  const outcome = demoSaleOutcome(delivery);
  const orderId = `DEMO-${Date.now().toString(36).toUpperCase()}`;
  try {
    await db.insert(checkouts).values({
      userId,
      itemId: item.id,
      sessionId: `demo-${randomUUID()}`,
      orderId,
      status: 'placed',
      totalAmount: item.priceAmount,
      currency: item.currency,
      outcome,
      merchantUrl: item.productUrl,
      settledAt: new Date(),
    });
  } catch (err) {
    console.error('checkout: could not record demo sale', err);
  }

  const origin = process.env.WEB_ORIGIN || 'http://localhost:4321';
  const url = `${origin}/chat-login?${signChatLogin({ userId, next: '/checkouts' })}`;

  return (
    `Sale complete (demo).\n\n` +
    `${item.title} — ${price}\n${item.merchant ?? 'Unknown merchant'}\n\n` +
    `Expected delivery: ${delivery}.\n` +
    `Order ${orderId}. This is demo data. No real order was placed and no money moved.\n\n` +
    `See it here (link valid 15 min):\n${url}`
  );
}
