import type { APIRoute } from 'astro';
import { db, items, checkouts, users, identities, type ShippingAddress } from '@prava/db';
import { and, eq } from 'drizzle-orm';
import { getPaymentResult, reportStatus, revokeSession } from '@prava/worker/payments/prava';
import { DEMO_FALLBACK_ENABLED, demoFallbackCard } from '@prava/worker/payments/demo-card';
import { getChannel } from '@prava/worker/channels';

const EXECUTOR = process.env.CHECKOUT_EXECUTOR_URL ?? 'http://127.0.0.1:8787/execute';

interface ExecutorResult {
  status: 'placed' | 'declined' | 'failed';
  message: string;
  url?: string;
  screenshot?: string;
}

/**
 * Hand the minted card to the checkout executor, then settle with Prava.
 *
 * The card is fetched server-side from Prava rather than accepted from the
 * browser: the page never holds it, and a caller cannot substitute one. A
 * decline is a real outcome — the chain ran and the merchant's gateway
 * answered — so it settles as DECLINED rather than being treated as an error.
 */
export const POST: APIRoute = async ({ params, request, locals }) => {
  if (!locals.userId) return new Response('Unauthorized', { status: 401 });

  const { sessionId } = params;
  if (!sessionId) return new Response('Missing session id', { status: 400 });

  const body = (await request.json().catch(() => null)) as {
    shipping?: Record<string, string>;
    watch?: boolean;
    fallback?: boolean;
  } | null;

  if (!body?.shipping) return new Response('shipping is required', { status: 400 });

  const [checkout] = await db
    .select()
    .from(checkouts)
    .where(and(eq(checkouts.sessionId, sessionId), eq(checkouts.userId, locals.userId)))
    .limit(1);

  if (!checkout) return new Response('Not found', { status: 404 });

  const [item] = await db.select().from(items).where(eq(items.id, checkout.itemId)).limit(1);
  if (!item) return new Response('Not found', { status: 404 });

  // Remembered for next time: nobody should retype their address per purchase.
  await db
    .update(users)
    .set({ shipping: body.shipping as unknown as ShippingAddress })
    .where(eq(users.id, locals.userId))
    .catch((err) => console.error('could not save shipping address', err));

  const demoFallback = body.fallback === true;
  if (demoFallback && !DEMO_FALLBACK_ENABLED()) {
    return Response.json({ status: 'failed', message: 'fallback disabled' }, { status: 403 });
  }

  // Normal path: the minted card comes from Prava server-side — the page never
  // holds it. Demo-fallback path (passkey unavailable on stage): use Prava's
  // published sandbox test card instead; it only works on sandbox gateways.
  let card: import('@prava/worker/checkout/shopify').CardCredentials;
  let txnRefId: string | null = null;
  if (demoFallback) {
    console.log(`order: ${sessionId} — DEMO FALLBACK: using sandbox test card, Prava passkey skipped`);
    card = demoFallbackCard();
  } else {
    console.log(`order: ${sessionId} — fetching minted card from Prava`);
    const payment = await getPaymentResult(sessionId);
    if (!payment.credentials) {
      console.log(`order: ${sessionId} — not minted yet (${payment.status})`);
      return Response.json(
        { status: 'failed', message: `card not minted yet (${payment.status})` },
        { status: 409 },
      );
    }
    card = payment.credentials;
    txnRefId = payment.credentials.txnRefId;
  }

  console.log(
    `order: ${sessionId} — card **** ${card.token.slice(-4)}, handing to executor for ${item.productUrl}`,
  );

  const executorRes = await fetch(EXECUTOR, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // The executor spends real credentials, so it authenticates every caller.
      'x-checkout-secret': process.env.CHECKOUT_SHARED_SECRET ?? '',
    },
    body: JSON.stringify({
      productUrl: item.productUrl,
      card,
      shipping: body.shipping,
      headful: body.watch === true,
    }),
  }).catch(() => null);

  if (!executorRes) {
    await db
      .update(checkouts)
      .set({ status: 'failed', outcome: 'checkout executor unreachable' })
      .where(eq(checkouts.id, checkout.id));

    return Response.json(
      { status: 'failed', message: 'checkout executor unreachable — is the worker running?' },
      { status: 502 },
    );
  }

  const result = (await executorRes.json()) as ExecutorResult;
  console.log(`order: ${sessionId} — merchant said ${result.status}: ${result.message}`);

  const outcomePrefix = demoFallback ? '[sandbox test card — passkey skipped] ' : '';
  await db
    .update(checkouts)
    .set({ status: result.status, outcome: outcomePrefix + result.message, settledAt: new Date() })
    .where(eq(checkouts.id, checkout.id));

  // Report back to the chat that sent the share — the checkout page may be a
  // phone browser opened from the link, but the user lives in the DM thread.
  // Fire-and-forget: a dead chat token must not affect the order's outcome.
  void notifyChat(locals.userId, item.merchant, result, demoFallback).catch((err) =>
    console.error('chat notification failed', err),
  );

  if (demoFallback) {
    // Nothing was minted, so there is no txn to settle — just close the session.
    await revokeSession(sessionId)
      .then(() => console.log(`order: ${sessionId} — demo fallback: Prava session revoked`))
      .catch((err) => console.error('revoke-session failed', err));
  } else if (result.status === 'placed' || result.status === 'declined') {
    await reportStatus({
      sessionId,
      txnRefId: txnRefId!,
      status: result.status === 'placed' ? 'APPROVED' : 'DECLINED',
    })
      .then(() => console.log(`order: ${sessionId} — settled with Prava as ${result.status === 'placed' ? 'APPROVED' : 'DECLINED'}`))
      .catch((err) => console.error('report-status failed', err));
  }

  return Response.json(result);
};

/**
 * Where the order came from: prefer the WhatsApp channel the user last wrote
 * on (wassist, then Meta), fall back to Instagram. A user with no chat identity (dashboard sign-in only) just gets
 * no message.
 */
async function notifyChat(
  userId: string,
  merchant: string | null,
  result: ExecutorResult,
  demoFallback = false,
): Promise<void> {
  const rows = await db
    .select({ platform: identities.platform, externalId: identities.externalId })
    .from(identities)
    .where(eq(identities.userId, userId));

  const identity =
    rows.find((r) => r.platform === 'wassist') ??
    rows.find((r) => r.platform === 'whatsapp') ??
    rows.find((r) => r.platform === 'instagram');
  if (!identity) return;

  const name = merchant ?? 'the store';
  const prefix = demoFallback ? '(Demo: sandbox test card, passkey step skipped.) ' : '';
  const text =
    prefix +
    (result.status === 'placed'
      ? `Order placed (sandbox — no real money moved). ${name} said: ${result.message}`
      : result.status === 'declined'
        ? `The store's payment gateway declined the sandbox card — that's expected with Prava test cards and proves the card reached a real processor. Outcome: ${result.message}`
        : `Couldn't complete the checkout: ${result.message}`);

  await getChannel(identity.platform).sendText(identity.externalId, text);
}
