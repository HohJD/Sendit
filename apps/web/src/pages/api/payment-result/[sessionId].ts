import type { APIRoute } from 'astro';
import { db, checkouts } from '@prava/db';
import { and, eq } from 'drizzle-orm';
import { getPaymentResult, PravaError } from '@prava/worker/payments/prava';
import { DEMO_FALLBACK_ENABLED } from '@prava/worker/payments/demo-card';

/** Polled by the checkout page while the user authorizes in the Prava iframe. */
export const GET: APIRoute = async ({ params, locals }) => {
  if (!locals.userId) return new Response('Unauthorized', { status: 401 });

  const { sessionId } = params;
  if (!sessionId) return new Response('Missing session id', { status: 400 });

  const [checkout] = await db
    .select()
    .from(checkouts)
    .where(and(eq(checkouts.sessionId, sessionId), eq(checkouts.userId, locals.userId)))
    .limit(1);

  if (!checkout) return new Response('Not found', { status: 404 });

  try {
    const result = await getPaymentResult(sessionId);

    // Credentials arrive at 'awaiting_result'; 'completed' comes after settlement.
    if (result.credentials && checkout.status === 'authorizing') {
      await db
        .update(checkouts)
        .set({ status: 'authorized', txnRefId: result.credentials.txnRefId })
        .where(eq(checkouts.id, checkout.id));
    }

    return Response.json({ ...result, fallbackAvailable: DEMO_FALLBACK_ENABLED() });
  } catch (err) {
    const status = err instanceof PravaError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ status: 'failed', error: { code: 'proxy', message } }, { status });
  }
};
