import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { signChatLogin, verifyChatLogin } from './link.ts';

const SECRET = 'test-session-secret';

describe('chat login links', () => {
  test('round trips a signed link', () => {
    const qs = signChatLogin({ userId: 'user_1', next: '/checkout/item_7' }, SECRET);
    const verified = verifyChatLogin(new URLSearchParams(qs), SECRET);
    assert.deepEqual(verified, { userId: 'user_1', next: '/checkout/item_7' });
  });

  test('rejects an expired link', () => {
    const qs = signChatLogin({ userId: 'user_1', next: '/checkout/x', ttlMs: -1000 }, SECRET);
    assert.equal(verifyChatLogin(new URLSearchParams(qs), SECRET), null);
  });

  test('rejects a tampered signature', () => {
    const qs = new URLSearchParams(signChatLogin({ userId: 'user_1', next: '/checkout/x' }, SECRET));
    qs.set('u', 'user_2'); // same signature, different user
    assert.equal(verifyChatLogin(qs, SECRET), null);
  });

  test('rejects a non-relative next', () => {
    const qs = signChatLogin({ userId: 'user_1', next: 'https://evil.example/x' }, SECRET);
    // The signer happily signs anything; the verifier refuses to consume it.
    assert.equal(verifyChatLogin(new URLSearchParams(qs), SECRET), null);
  });

  test('rejects a wrong secret', () => {
    const qs = signChatLogin({ userId: 'user_1', next: '/checkout/x' }, SECRET);
    assert.equal(verifyChatLogin(new URLSearchParams(qs), 'other-secret'), null);
  });
});
