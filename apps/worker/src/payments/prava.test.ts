import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession,
  getPaymentResult,
  waitForCredentials,
  reportStatus,
  revokeSession,
  PravaError,
} from './prava.ts';

let calls: Array<{ url: string; init: RequestInit }>;
let responses: Array<{ status: number; body: unknown }>;

beforeEach(() => {
  calls = [];
  responses = [];
  process.env.PRAVA_SECRET_KEY = 'sk_test_fake';
  process.env.PRAVA_API_BASE_URL = 'https://sandbox.api.prava.space';

  // @ts-expect-error — test double, real fetch is not exercised here
  globalThis.fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('no mocked response queued');
    return {
      ok: next.status < 400,
      status: next.status,
      json: async () => next.body,
    };
  };
});

afterEach(() => {
  delete process.env.PRAVA_SECRET_KEY;
});

describe('createSession', () => {
  test('sends the documented request shape and parses the response', async () => {
    responses.push({
      status: 201,
      body: {
        session_id: 'sess_1',
        session_token: 'tok_1',
        iframe_url: 'https://checkout.prava.space/s/sess_1',
        order_id: 'ord_1',
        expires_at: '2026-07-30T12:15:00Z',
      },
    });

    const result = await createSession({
      userId: 'user_1',
      userEmail: 'a@b.com',
      totalAmount: '179.99',
      currency: 'USD',
      merchant: { name: 'Nike', url: 'https://www.nike.com', countryCodeIso2: 'US' },
      products: [{ description: 'Air Max 90', unitPrice: '179.99' }],
    });

    assert.equal(result.sessionId, 'sess_1');
    assert.equal(result.iframeUrl, 'https://checkout.prava.space/s/sess_1');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://sandbox.api.prava.space/v1/sessions');
    assert.equal(
      (calls[0].init.headers as Record<string, string>).authorization,
      'Bearer sk_test_fake',
    );

    const sentBody = JSON.parse(calls[0].init.body as string);
    assert.equal(sentBody.user_id, 'user_1');
    assert.equal(sentBody.purchase_context.custom.length, 1);
    assert.equal(sentBody.purchase_context.custom[0].merchant_details.name, 'Nike');
    assert.equal(sentBody.purchase_context.custom[0].product_details[0].quantity, 1);
  });

  test('throws PravaError with the API status and code on failure', async () => {
    responses.push({
      status: 400,
      body: { error: { code: 'VAL_2001', message: 'Validation failed' } },
    });

    await assert.rejects(
      () =>
        createSession({
          userId: 'user_1',
          userEmail: 'a@b.com',
          totalAmount: '10.00',
          currency: 'USD',
          merchant: { name: 'X', url: 'https://x.com', countryCodeIso2: 'US' },
          products: [{ description: 'thing', unitPrice: '10.00' }],
        }),
      (err: unknown) => {
        assert.ok(err instanceof PravaError);
        assert.equal(err.status, 400);
        assert.equal(err.code, 'VAL_2001');
        return true;
      },
    );
  });
});

describe('getPaymentResult', () => {
  test('hits the per-session path (not a query-param endpoint) and parses the nested transaction', async () => {
    responses.push({
      status: 200,
      body: {
        session_id: 'sess_1',
        order_id: 'ord_1',
        status: 'awaiting_result',
        transactions: [
          {
            txn_id: 'txn_1',
            status: 'awaiting_result',
            line_items: [
              {
                txn_ref_id: 'tli_1',
                status: 'awaiting_result',
                token: '4111',
                dynamic_cvv: '123',
                expiry_month: '12',
                expiry_year: '2028',
              },
            ],
          },
        ],
      },
    });

    const result = await getPaymentResult('sess_1');

    assert.equal(calls[0].url, 'https://sandbox.api.prava.space/v1/sessions/sess_1/payment-result');
    assert.equal(result.status, 'awaiting_result');
    assert.deepEqual(result.credentials, {
      txnRefId: 'tli_1',
      token: '4111',
      dynamicCvv: '123',
      expiryMonth: '12',
      expiryYear: '2028',
    });
  });

  test('has no credentials while pending', async () => {
    responses.push({
      status: 200,
      body: {
        session_id: 'sess_1',
        order_id: null,
        status: 'pending',
        transactions: [{ txn_id: 'txn_1', status: 'pending', line_items: [] }],
      },
    });

    const result = await getPaymentResult('sess_1');
    assert.equal(result.credentials, undefined);
  });

  test('surfaces the transaction error on failure', async () => {
    responses.push({
      status: 200,
      body: {
        session_id: 'sess_1',
        order_id: null,
        status: 'failed',
        transactions: [
          {
            txn_id: 'txn_1',
            status: 'failed',
            line_items: [],
            error: { code: 'DECLINED', message: 'Card declined' },
          },
        ],
      },
    });

    const result = await getPaymentResult('sess_1');
    assert.deepEqual(result.error, { code: 'DECLINED', message: 'Card declined' });
  });
});

describe('waitForCredentials', () => {
  test('polls through pending and returns once minted', async () => {
    const pendingBody = {
      session_id: 'sess_1',
      order_id: null,
      status: 'pending',
      transactions: [{ txn_id: 'txn_1', status: 'pending', line_items: [] }],
    };
    responses.push(
      { status: 200, body: pendingBody },
      { status: 200, body: pendingBody },
      {
        status: 200,
        body: {
          session_id: 'sess_1',
          order_id: 'ord_1',
          status: 'awaiting_result',
          transactions: [
            {
              txn_id: 'txn_1',
              status: 'awaiting_result',
              line_items: [
                {
                  txn_ref_id: 'tli_1',
                  status: 'awaiting_result',
                  token: 'tok',
                  dynamic_cvv: '999',
                  expiry_month: '1',
                  expiry_year: '2030',
                },
              ],
            },
          ],
        },
      },
    );

    const seen: string[] = [];
    const creds = await waitForCredentials('sess_1', {
      intervalMs: 1,
      onTick: (s) => seen.push(s),
    });

    assert.equal(creds.token, 'tok');
    assert.equal(creds.txnRefId, 'tli_1');
    assert.deepEqual(seen, ['pending', 'pending', 'awaiting_result']);
  });

  test('throws immediately on a failed status rather than continuing to poll', async () => {
    responses.push({
      status: 200,
      body: {
        session_id: 'sess_1',
        order_id: null,
        status: 'failed',
        transactions: [
          { txn_id: 'txn_1', status: 'failed', line_items: [], error: { code: 'X', message: 'nope' } },
        ],
      },
    });

    await assert.rejects(() => waitForCredentials('sess_1', { intervalMs: 1 }), /nope/);
    assert.equal(calls.length, 1);
  });
});

describe('reportStatus and revokeSession', () => {
  test('reportStatus posts to the per-session path with txn_ref_id and txn_status', async () => {
    responses.push({
      status: 200,
      body: { status: 'confirmed', txn_ref_id: 'tli_1', txn_status: 'APPROVED', visa_confirmation: 'SUCCESS' },
    });

    await reportStatus({ sessionId: 'sess_1', txnRefId: 'tli_1', status: 'APPROVED' });

    assert.equal(calls[0].url, 'https://sandbox.api.prava.space/v1/sessions/sess_1/report-status');
    const body = JSON.parse(calls[0].init.body as string);
    assert.deepEqual(body, { txn_ref_id: 'tli_1', txn_status: 'APPROVED' });
  });

  test('revokeSession hits the per-session revoke path', async () => {
    responses.push({ status: 200, body: { success: true } });
    await revokeSession('sess_1');
    assert.equal(calls[0].url, 'https://sandbox.api.prava.space/v1/sessions/sess_1/revoke');
  });
});
