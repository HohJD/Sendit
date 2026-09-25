import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed one-shot login link sent over chat. WhatsApp can't carry a browser
 * session, so the approve button ends here: the link signs the user in and
 * lands them on the checkout page. It carries no authority beyond a session —
 * the checkout itself still needs a passkey on Prava's surface.
 *
 * Signature covers `u.next.exp` so neither the destination nor the expiry can
 * be re-pointed without SESSION_SECRET.
 */
export function signChatLogin(
  params: { userId: string; next: string; ttlMs?: number },
  secret = process.env.SESSION_SECRET,
): string {
  if (!secret) throw new Error('SESSION_SECRET is not set');

  const exp = String(Date.now() + (params.ttlMs ?? 15 * 60 * 1000));
  const payload = `${params.userId}.${params.next}.${exp}`;
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');

  return new URLSearchParams({
    u: params.userId,
    next: params.next,
    exp,
    sig,
  }).toString();
}

export function verifyChatLogin(
  params: URLSearchParams,
  secret: string | undefined = process.env.SESSION_SECRET,
  now = Date.now(),
): { userId: string; next: string } | null {
  if (!secret) throw new Error('SESSION_SECRET is not set');

  const userId = params.get('u');
  const next = params.get('next');
  const exp = params.get('exp');
  const sig = params.get('sig');
  if (!userId || !next || !exp || !sig) return null;

  if (Number(exp) < now) return null;

  // Only relative paths — an absolute next would make this an open redirect
  // minted with our own signature.
  if (!next.startsWith('/') || next.startsWith('//')) return null;

  const expected = Buffer.from(
    createHmac('sha256', secret).update(`${userId}.${next}.${exp}`).digest('base64url'),
  );
  const provided = Buffer.from(sig);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  return { userId, next };
}
