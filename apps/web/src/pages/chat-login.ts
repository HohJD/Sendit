import type { APIRoute } from 'astro';
import { verifyChatLogin } from '@prava/worker/conversation/link';
import { setSession } from '../lib/session.ts';

/**
 * Entry point for the signed links Sendit sends over WhatsApp. The link
 * carries a 15-minute HMAC of user+destination+expiry; on success it mints
 * the normal session cookie and drops the user on the checkout page.
 */
export const GET: APIRoute = ({ url, cookies, redirect }) => {
  const verified = verifyChatLogin(url.searchParams, process.env.SESSION_SECRET);
  if (!verified) {
    return new Response('Link expired or invalid — ask Sendit for a new one.', { status: 403 });
  }

  setSession(cookies, verified.userId);
  return redirect(verified.next);
};
