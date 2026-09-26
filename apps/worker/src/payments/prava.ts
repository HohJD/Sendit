/**
 * Thin client for the Prava calls this flow needs, against the real
 * documented shapes (docs.prava.space/api-reference, verified 2026-07-30
 * against a live sandbox session — the first draft of this file guessed at
 * /v1/payment-result as a flat query-param endpoint, which is wrong; see the
 * corrections below):
 *
 *   POST /v1/sessions                          — open a transaction, get an iframe_url
 *   GET  /v1/sessions/:id/payment-result        — poll until the one-time card is minted
 *   POST /v1/sessions/:id/revoke                — abandon a session early
 *   POST /v1/sessions/:id/report-status         — settle the outcome back to Prava
 *
 * This module only talks to Prava. It knows nothing about Rye or the
 * merchant checkout — that's deliberately a separate module, matching the
 * real division of labor: Prava mints credentials, it never places orders.
 */

export interface MerchantDetails {
  name: string;
  url: string;
  countryCodeIso2: string;
}

export interface ProductDetail {
  description: string;
  unitPrice: string;
  quantity?: number;
  productId?: string;
}

export interface CreateSessionInput {
  userId: string;
  userEmail: string;
  totalAmount: string;
  currency: string;
  merchant: MerchantDetails;
  products: ProductDetail[];
  /** Reuse an enrolled card instead of collecting a fresh one. */
  cardId?: string;
  /** Where Prava returns the cardholder after they approve. Must be https. */
  callbackUrl?: string;
}

export interface CreateSessionResult {
  sessionId: string;
  sessionToken: string;
  iframeUrl: string;
  orderId: string;
  expiresAt: string;
}

/**
 * `txnRefId` is not optional bookkeeping — Report Status requires it to
 * identify which line item the outcome applies to. It comes from the same
 * line item as the credentials, so it travels with them.
 */
export interface MintedCredentials {
  txnRefId: string;
  token: string;
  dynamicCvv: string;
  expiryMonth: string;
  expiryYear: string;
}

export type PaymentResultStatus = 'pending' | 'awaiting_result' | 'completed' | 'failed';

export interface PaymentResult {
  status: PaymentResultStatus;
  credentials?: MintedCredentials;
  error?: { code: string; message: string };
}

export class PravaError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'PravaError';
  }
}

function config() {
  const secretKey = process.env.PRAVA_SECRET_KEY;
  const baseUrl = process.env.PRAVA_API_BASE_URL ?? 'https://sandbox.api.prava.space';
  if (!secretKey) {
    throw new Error(
      'PRAVA_SECRET_KEY is not set. Create a sandbox key at dashboard.prava.space — it works instantly, no waiting.',
    );
  }
  return { secretKey, baseUrl };
}

async function pravaFetch<T>(path: string, init: RequestInit): Promise<T> {
  const { secretKey, baseUrl } = config();

  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${secretKey}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  });

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const error = (body as { error?: { message?: string; code?: string } } | null)?.error;
    throw new PravaError(error?.message ?? `HTTP ${res.status}`, res.status, error?.code);
  }

  return body as T;
}

export interface EnrolledCard {
  cardId: string;
  last4: string;
  isDefault: boolean;
}

export async function listCards(customerId: string): Promise<EnrolledCard[]> {
  const body = await pravaFetch<{
    cards?: Array<{ card_id: string; card_last4: string; is_default: boolean }>;
  }>(`/v1/listCards?customer_id=${encodeURIComponent(customerId)}`, { method: 'GET' });

  return (body.cards ?? []).map((c) => ({
    cardId: c.card_id,
    last4: c.card_last4,
    isDefault: c.is_default,
  }));
}

export async function deleteCard(customerId: string, cardId: string): Promise<void> {
  await pravaFetch('/v1/deleteCard', {
    method: 'POST',
    body: JSON.stringify({
      customer_id: customerId,
      card_id: cardId,
      reason: 'CUSTOMER_CONFIRMED',
    }),
  });
}

/**
 * Drop every enrolled card for a customer before opening a session.
 *
 * Works around a sandbox fault: a card can end up stored and flagged
 * "verified when stored" without a passkey ever being bound to it. Every later
 * session then takes the savedCard path, skips card entry, and dies at
 * /v1/fido/start with FIDO_START_FAILED — permanently, for that customer id,
 * across refreshes and restarts. Starting each session with no stored card
 * forces the addCard path, which does the device binding properly.
 *
 * Never throws: a checkout that can't purge is still worth attempting.
 */
export async function purgeEnrolledCards(customerId: string): Promise<number> {
  try {
    const cards = await listCards(customerId);
    let removed = 0;

    for (const card of cards) {
      try {
        await deleteCard(customerId, card.cardId);
        removed += 1;
      } catch (err) {
        console.error(`prava: could not delete card ${card.cardId}`, err);
      }
    }

    return removed;
  } catch (err) {
    // A customer Prava has never seen 404s here, which is the healthy case.
    if (!(err instanceof PravaError && err.status === 404)) {
      console.error('prava: could not list cards for purge', err);
    }
    return 0;
  }
}

const RESERVED_TLDS = new Set([
  'local',
  'test',
  'example',
  'demo',
  'invalid',
  'localhost',
  'internal',
  'devices',
]);

function tldOf(hostname: string): string {
  return hostname.split('.').pop()?.toLowerCase() ?? '';
}

function assertRoutableTld(hostname: string, what: string): void {
  const tld = tldOf(hostname);
  if (!/^[a-z]{2,}$/.test(tld) || RESERVED_TLDS.has(tld)) {
    throw new Error(`${what} uses a non-routable TLD (${hostname}) — the card network rejects it`);
  }
}

export function merchantOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`merchant url is not a valid URL: ${raw}`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`merchant url must be http(s): ${raw}`);
  }

  assertRoutableTld(url.hostname, 'merchant url');

  // Always https, and never anything after the host.
  return `https://${url.hostname}`;
}

export async function createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
  const emailHost = input.userEmail.split('@')[1];
  if (!emailHost) throw new Error(`user email is not an address: ${input.userEmail}`);
  assertRoutableTld(emailHost, 'user email');

  const body = await pravaFetch<{
    session_id: string;
    session_token: string;
    iframe_url: string;
    order_id: string;
    expires_at: string;
  }>('/v1/sessions', {
    method: 'POST',
    body: JSON.stringify({
      user_id: input.userId,
      user_email: input.userEmail,
      total_amount: input.totalAmount,
      currency: input.currency,
      // Prava rejects a bare array here with VAL_2001 "Expected object,
      // received array" (verified live 2026-09-26) — the contexts sit under
      // `custom`, matching the quickstart.
      purchase_context: {
        custom: [
          {
            merchant_details: {
              name: input.merchant.name,
              url: merchantOrigin(input.merchant.url),
              country_code_iso2: input.merchant.countryCodeIso2,
            },
            product_details: input.products.map((p) => ({
              description: p.description,
              unit_price: p.unitPrice,
              quantity: p.quantity ?? 1,
              // Prava rejects the whole body (VAL_2001) when product_id is a
              // URL — which is exactly what search-derived candidates carry as
              // their id. Only pass short, opaque ids.
              ...(p.productId && p.productId.length <= 64 && !/^https?:\/\//i.test(p.productId)
                ? { product_id: p.productId }
                : {}),
            })),
          },
        ],
      },
      integration_type: 'full_checkout',
      ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
      ...(input.cardId ? { card: { card_id: input.cardId } } : {}),
    }),
  });

  return {
    sessionId: body.session_id,
    sessionToken: body.session_token,
    iframeUrl: body.iframe_url,
    orderId: body.order_id,
    expiresAt: body.expires_at,
  };
}

interface RawLineItem {
  txn_ref_id: string;
  status: string;
  token: string | null;
  dynamic_cvv: string | null;
  expiry_month: string | null;
  expiry_year: string | null;
}

interface RawPaymentResult {
  session_id: string;
  order_id: string | null;
  status: PaymentResultStatus;
  transactions: Array<{
    txn_id: string;
    status: string;
    line_items: RawLineItem[];
    error?: { code: string; message: string };
  }>;
}

export async function getPaymentResult(sessionId: string): Promise<PaymentResult> {
  const body = await pravaFetch<RawPaymentResult>(
    `/v1/sessions/${encodeURIComponent(sessionId)}/payment-result`,
    { method: 'GET' },
  );

  const transaction = body.transactions[0];
  const item = transaction?.line_items[0];

  const credentials =
    item?.token && item?.dynamic_cvv
      ? {
          txnRefId: item.txn_ref_id,
          token: item.token,
          dynamicCvv: item.dynamic_cvv,
          expiryMonth: item.expiry_month ?? '',
          expiryYear: item.expiry_year ?? '',
        }
      : undefined;

  return { status: body.status, credentials, error: transaction?.error };
}

/**
 * Poll until the card is minted or the session's 15-minute window runs out.
 * `onTick` lets a CLI print progress without this module knowing about stdout.
 */
export async function waitForCredentials(
  sessionId: string,
  opts: { intervalMs?: number; timeoutMs?: number; onTick?: (status: PaymentResultStatus) => void } = {},
): Promise<MintedCredentials> {
  const intervalMs = opts.intervalMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await getPaymentResult(sessionId);
    opts.onTick?.(result.status);

    if (result.status === 'awaiting_result' && result.credentials) return result.credentials;
    if (result.status === 'failed') {
      throw new Error(
        result.error ? `Payment failed: ${result.error.code} — ${result.error.message}` : 'Payment session failed before credentials were minted',
      );
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(`Timed out waiting for card entry on session ${sessionId}`);
}

export async function revokeSession(sessionId: string): Promise<void> {
  await pravaFetch(`/v1/sessions/${encodeURIComponent(sessionId)}/revoke`, {
    method: 'POST',
    body: '{}',
  });
}

export interface ReportStatusInput {
  sessionId: string;
  txnRefId: string;
  status: 'APPROVED' | 'DECLINED';
  authorizationCode?: string;
  responseCode?: string;
}

export async function reportStatus(input: ReportStatusInput): Promise<void> {
  await pravaFetch(`/v1/sessions/${encodeURIComponent(input.sessionId)}/report-status`, {
    method: 'POST',
    body: JSON.stringify({
      txn_ref_id: input.txnRefId,
      txn_status: input.status,
      ...(input.authorizationCode ? { authorization_code: input.authorizationCode } : {}),
      ...(input.responseCode ? { response_code: input.responseCode } : {}),
    }),
  });
}
