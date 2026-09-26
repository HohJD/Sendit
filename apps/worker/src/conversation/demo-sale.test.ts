import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoDeliveryWindow, demoSaleOutcome } from './demo-sale.ts';

test('delivery skips the weekend', () => {
  // Saturday 26 Sep 2026. Five business days is Friday 2 Oct; eight is Wednesday 7 Oct.
  const window = demoDeliveryWindow(new Date(2026, 8, 26, 15, 0, 0));
  assert.equal(window, 'Fri 2 Oct – Wed 7 Oct');
});

test('outcome is labelled as demo data', () => {
  const outcome = demoSaleOutcome('Fri 2 Oct – Wed 7 Oct');
  assert.match(outcome, /^Demo sale\./);
  assert.match(outcome, /Expected delivery Fri 2 Oct – Wed 7 Oct/);
  assert.match(outcome, /No real order was placed/);
});
