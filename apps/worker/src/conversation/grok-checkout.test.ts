import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoFallbackCard } from '../payments/demo-card.ts';
import { grokCheckoutPrompt, grokCheckoutShell } from './grok-checkout.ts';

const url = 'https://www.allbirds.com/products/mens-wool-runners-true-black';

test('prompt fills the sandbox test card and forbids placing the order', () => {
  const card = demoFallbackCard();
  const prompt = grokCheckoutPrompt(url);
  assert.match(prompt, new RegExp(url.replaceAll('.', '\\.')));
  assert.match(prompt, new RegExp(card.token));
  assert.match(prompt, new RegExp(card.dynamicCvv));
  assert.match(prompt, /Do not click Pay, Place order/);
  assert.match(prompt, /order was not placed/);
});

test('shell starts the local grok binary outside the repo', () => {
  const shell = grokCheckoutShell(url, '/Users/hohjiada/.grok/bin/grok', '/tmp/sendit-grok/work');
  assert.match(shell, /exec '\/Users\/hohjiada\/\.grok\/bin\/grok'/);
  assert.match(shell, /--cwd '\/tmp\/sendit-grok\/work'/);
  assert.match(shell, /--always-approve/);
  assert.match(shell, /Do not click Pay/);
  assert.doesNotMatch(shell, /sendit\/apps/);
});
