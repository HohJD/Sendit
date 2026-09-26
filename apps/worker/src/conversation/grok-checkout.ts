import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demoFallbackCard } from '../payments/demo-card.ts';

/**
 * Approve launches the local Grok agent to walk a Shopify checkout with the
 * public sandbox test card. The run is a dry buy: the card may be typed, and
 * the order must not be submitted.
 */
export function grokCheckoutPrompt(productUrl: string): string {
  const card = demoFallbackCard();
  return [
    'Dry run only. Walk the purchase and then stop. Do not place the order.',
    `Open this product page in a browser: ${productUrl}`,
    'Add one item to the cart and continue to checkout.',
    'If the site asks for contact or shipping, use:',
    'Email: demo@sendit.app',
    'Name: Sendit Demo',
    'Address: 1 Market Street',
    'City: San Francisco',
    'State: CA',
    'Postal code: 94105',
    'Country: United States',
    'Phone: 4155550100',
    'When the card form is visible, fill this Prava sandbox test card:',
    `Card number: ${card.token}`,
    `Expiry: ${card.expiryMonth}/${card.expiryYear}`,
    `Security code: ${card.dynamicCvv}`,
    'After the card fields are filled, stop.',
    'Do not click Pay, Place order, Complete order, Buy, Submit, or any control that would place or charge an order.',
    'Leave the browser open on the filled payment form.',
    'Reply with the page URL and say the order was not placed.',
  ].join('\n');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function grokCheckoutShell(productUrl: string, bin: string, cwd: string): string {
  return [
    '#!/bin/bash',
    `cd ${shellQuote(cwd)} || exit 1`,
    `exec ${shellQuote(bin)} --cwd ${shellQuote(cwd)} --always-approve --no-alt-screen --verbatim ${shellQuote(grokCheckoutPrompt(productUrl))}`,
    '',
  ].join('\n');
}

function openInTerminal(scriptPath: string): void {
  const command = `bash ${shellQuote(scriptPath)}`;
  const child = spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(command)}`], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

/** Starts Grok in Terminal. Failures are the caller's to log; this throws. */
export async function launchGrokCheckout(
  productUrl: string,
  open: (scriptPath: string) => void = openInTerminal,
): Promise<void> {
  if (process.env.GROK_CHECKOUT === 'false') return;

  const dir = join(tmpdir(), 'sendit-grok');
  const cwd = join(dir, 'work');
  await mkdir(cwd, { recursive: true });
  const scriptPath = join(dir, `run-${Date.now()}.sh`);
  const bin = process.env.GROK_BIN ?? '/Users/hohjiada/.grok/bin/grok';
  await writeFile(scriptPath, grokCheckoutShell(productUrl, bin, cwd), { mode: 0o700 });
  open(scriptPath);
  console.log(`checkout: launched Grok dry run for ${productUrl}`);
}
