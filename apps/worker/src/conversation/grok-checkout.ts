import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Approve on WhatsApp opens the store with the local Grok agent, before the
 * passkey. Grok may drive the page up to the card form. It never receives a
 * card number; payment still goes through the Prava sandbox link.
 */
export function grokCheckoutPrompt(productUrl: string): string {
  return [
    `Open this product page in a browser and walk the checkout until the card form is on screen: ${productUrl}`,
    'Add the item to the cart and continue through contact and shipping if the page asks.',
    'Stop when the site asks for a card.',
    'Do not type a card number. Do not submit payment. Do not place an order.',
    'This is a Prava sandbox test, not a real purchase.',
    'When the page is waiting for a card, say so and leave the browser open.',
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
  console.log(`checkout: launched Grok for ${productUrl}`);
}
