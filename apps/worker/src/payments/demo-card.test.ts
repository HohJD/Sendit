import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_FALLBACK_ENABLED, demoFallbackCard } from './demo-card.ts';

let saved: string | undefined;

beforeEach(() => {
  saved = process.env.DEMO_FALLBACK_CARD;
  delete process.env.DEMO_FALLBACK_CARD;
});

afterEach(() => {
  if (saved === undefined) delete process.env.DEMO_FALLBACK_CARD;
  else process.env.DEMO_FALLBACK_CARD = saved;
});

describe('demo fallback card', () => {
  test('disabled by default and for non-"true" values', () => {
    assert.equal(DEMO_FALLBACK_ENABLED(), false);
    process.env.DEMO_FALLBACK_CARD = 'false';
    assert.equal(DEMO_FALLBACK_ENABLED(), false);
  });

  test('enabled when DEMO_FALLBACK_CARD=true', () => {
    process.env.DEMO_FALLBACK_CARD = 'true';
    assert.equal(DEMO_FALLBACK_ENABLED(), true);
  });

  test('card shape matches CardCredentials', () => {
    const card = demoFallbackCard();
    assert.match(card.token, /^\d{13,19}$/);
    assert.match(card.dynamicCvv, /^\d{3}$/);
    assert.match(card.expiryMonth, /^\d{2}$/);
    assert.match(card.expiryYear, /^\d{4}$/);
  });
});
