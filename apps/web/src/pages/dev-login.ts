import type { APIRoute } from 'astro';
import { db, users, identities, shares } from '@prava/db';
import { and, eq } from 'drizzle-orm';
import { setSession } from '../lib/session.ts';
import { resolveIgsid } from '../lib/instagram.ts';

/**
 * Sign in and claim your Instagram shares in one step.
 *
 * This identifies a user, it does not authenticate one — there is no password
 * or OTP, so anyone can type any email and handle. Real auth is still owed.
 *
 * Intake creates a user per IGSID with no contact details (see store.ts), so
 * shares pile up against a placeholder account. Claiming re-points that
 * identity, and everything it collected, at the signed-in account.
 */
export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const form = await request.formData();
  const email = String(form.get('email') ?? '').trim();
  const handle = String(form.get('instagram') ?? '').trim();

  if (!email) return new Response('email required', { status: 400 });

  // WhatsApp-first deployments may have no Instagram token at all — skip
  // resolution rather than 502, so email-only sign-in still works.
  let igsid: string | null = null;
  if (process.env.IG_PAGE_ACCESS_TOKEN) {
    try {
      igsid = await resolveIgsid(handle);
    } catch (err) {
      return new Response(err instanceof Error ? err.message : String(err), { status: 502 });
    }
  }

  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const user = existing[0] ?? (await db.insert(users).values({ email }).returning())[0];

  // No matching IGSID — most likely this handle hasn't messaged us yet, or (while
  // Meta's app review is pending) isn't whitelisted to. Sign in anyway: the
  // dashboard renders a waitlist card instead of hard-blocking entry here.
  if (igsid) {
    const [identity] = await db
      .select()
      .from(identities)
      .where(and(eq(identities.platform, 'instagram'), eq(identities.externalId, igsid)))
      .limit(1);

    if (!identity) {
      await db
        .insert(identities)
        .values({ userId: user.id, platform: 'instagram', externalId: igsid })
        .onConflictDoNothing();
    } else if (identity.userId !== user.id) {
      // The placeholder account holds every share this IGSID has sent.
      await db.update(shares).set({ userId: user.id }).where(eq(shares.userId, identity.userId));
      await db.update(identities).set({ userId: user.id }).where(eq(identities.id, identity.id));
    }
  }

  setSession(cookies, user.id);
  return redirect('/dashboard');
};
