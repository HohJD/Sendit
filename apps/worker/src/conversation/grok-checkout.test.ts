import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grokCheckoutPrompt, grokCheckoutShell } from './grok-checkout.ts';

const url = 'https://www.allbirds.com/products/mens-wool-runners-true-black';

test('prompt sends Grok to the store and stops before payment', () => {
  const prompt = grokCheckoutPrompt(url);
  assert.match(prompt, new RegExp(url.replaceAll('.', '\\.')));
  assert.match(prompt, /Stop when the site asks for a card/);
  assert.match(prompt, /Do not type a card number/);
  assert.doesNotMatch(prompt, /cvv|pan|card number is/i);
});

test('shell starts the local grok binary outside the repo', () => {
  const shell = grokCheckoutShell(url, '/Users/hohjiada/.grok/bin/grok', '/tmp/sendit-grok/work');
  assert.match(shell, /exec '\/Users\/hohjiada\/\.grok\/bin\/grok'/);
  assert.match(shell, /--cwd '\/tmp\/sendit-grok\/work'/);
  assert.match(shell, /--always-approve/);
  assert.doesNotMatch(shell, /sendit\/apps/);
});
