/// <reference lib="dom" />
// The page.evaluate callbacks below run in the browser, not in Node, so this
// file needs DOM types without pulling them into the rest of the worker.
import { chromium, type Frame, type Page } from 'playwright';

export interface ShippingDetails {
  email: string;
  firstName: string;
  lastName: string;
  address1: string;
  city: string;
  postalCode: string;
  /** ISO-2, e.g. "IN". Shopify's country select is keyed by it. */
  countryCode: string;
  province?: string;
  phone?: string;
}

export interface CardCredentials {
  token: string;
  dynamicCvv: string;
  expiryMonth: string;
  expiryYear: string;
}

export interface CheckoutResult {
  status: 'placed' | 'declined' | 'failed';
  message: string;
  /** Final page URL, useful for confirming an order id landed. */
  url?: string;
  screenshot?: string;
}

/**
 * Drive a Shopify checkout with the card Prava minted.
 *
 * Deliberately Shopify-only: its checkout is the one flow standardised enough
 * across merchants to automate without per-store scripting. Anything else
 * fails fast rather than half-completing a purchase.
 *
 * This is inherently brittle — it depends on another company's DOM, and
 * storefronts customise their product pages heavily. Every step therefore
 * fails loudly with a screenshot rather than pressing on.
 */
export async function executeCheckout(params: {
  productUrl: string;
  card: CardCredentials;
  shipping: ShippingDetails;
  headless?: boolean;
  /** Fill everything but never submit — for exercising the driver safely. */
  dryRun?: boolean;
}): Promise<CheckoutResult> {
  const { productUrl, card, shipping, headless = true, dryRun = false } = params;

  const started = Date.now();
  const step = (name: string, detail = '') =>
    console.log(`checkout: [${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s] ${name}${detail ? ' — ' + detail : ''}`);

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
  });
  const page = await context.newPage();

  const fail = async (message: string): Promise<CheckoutResult> => ({
    status: 'failed',
    message,
    url: page.url(),
    screenshot: (await page.screenshot({ fullPage: false }).catch(() => null))?.toString('base64'),
  });

  try {
    const usUrl = (() => {
      try {
        const u = new URL(productUrl);
        u.searchParams.set('country', 'US');
        u.searchParams.set('currency', 'USD');
        return u.toString();
      } catch {
        return productUrl;
      }
    })();

    step('opening product', usUrl);
    await page.goto(usUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    const origin = new URL(page.url()).origin;
    if (!(await isShopify(page))) {
      return await fail('not a Shopify storefront — only Shopify checkout is automated');
    }

    const added = await addToCart(page);
    if (added === 'sold-out') {
      return await fail('the merchant has this product out of stock — nothing to check out');
    }
    if (added !== 'added') {
      return await fail('could not find an add-to-cart control on the product page');
    }

    step('in cart');
    await page.goto(`${origin}/checkout`, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    step('filling contact + shipping', `${shipping.city}, ${shipping.countryCode}`);
    await fillContactAndShipping(page, shipping);
    await advance(page, /continue to shipping|continue to delivery/i);
    await advance(page, /continue to payment/i);

    if (!(await fillCard(page, card, shipping))) {
      // Most Indian Shopify stores sell through PayU/Razorpay/Cashfree rather
      // than Shopify Payments. Those collect the card on their own hosted page
      // after a redirect, so no card fields exist here to fill.
      const body = (await page.textContent('body').catch(() => '')) ?? '';
      const gateway = body.match(/redirected to ([^.]{3,60}?) to complete your purchase/i);

      return await fail(
        gateway
          ? `store checks out via ${gateway[1].trim()}, which collects the card on its own page — this driver only fills Shopify Payments fields`
          : 'could not find the card fields on the payment step',
      );
    }

    step('card fields filled', `**** ${card.token.slice(-4)}`);

    if (dryRun) {
      return {
        status: 'failed',
        message: 'dry run — reached the payment step with the card filled, did not submit',
        url: page.url(),
        screenshot: (await page.screenshot().catch(() => null))?.toString('base64'),
      };
    }

    await dismissShopPayPrompt(page);

    step('submitting payment');
    await advance(page, /pay now|complete order|pay ₹|pay \$/i);

    // A captcha is the merchant asking for a human. When the browser is
    // visible there is one — so hand it over rather than defeating it, then
    // resubmit. Headless runs have nobody to ask, so they fail honestly.
    if (!headless && (await awaitHumanCaptcha(page, step))) {
      step('resubmitting after captcha');
      await advance(page, /pay now|complete order|pay ₹|pay \$/i);
    }

    const outcome = await readOutcome(page);
    step(`result: ${outcome.status}`, outcome.message);
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Some merchants drop the connection outright rather than serve a captcha.
    // That is a block, not a network fault on our side, and saying so saves
    // someone debugging their own wifi.
    if (/ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE/.test(message)) {
      return await fail(
        'the merchant closed the connection — it blocks automated checkout at the network level',
      );
    }

    return await fail(message);
  } finally {
    await browser.close();
  }
}

async function isShopify(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      'Shopify' in window ||
      Boolean(document.querySelector('script[src*="cdn.shopify.com"], link[href*="cdn.shopify.com"]')),
  );
}

/**
 * Every Shopify product page also serves JSON at `<product-url>.js`, and
 * `/cart/<variantId>:1` is a permalink that fills the cart without touching
 * the page. That sidesteps themes whose add-to-cart is custom, lazy-rendered,
 * or absent entirely (resale and pre-order templates have none).
 */
type CartResult = 'added' | 'sold-out' | 'no-control';

async function addViaCartPermalink(page: Page): Promise<CartResult> {
  try {
    // Derived from the page's own URL, not the one we were handed: stores
    // redirect product URLs to a canonical host or handle, and a cross-origin
    // redirect breaks the fetch. After navigation the page already holds the
    // resolved URL.
    const canonical = page.url().split('?')[0].replace(/\/$/, '');

    // Fetched from inside the page, not from Node: storefronts rate-limit and
    // bot-block bare server-side requests, and the browser context already
    // carries the cookies and headers the store expects.
    const product = await page.evaluate(async (url: string) => {
      const res = await fetch(url, { credentials: 'include' });
      return res.ok ? ((await res.json()) as unknown) : null;
    }, `${canonical}.js`);

    const variants =
      (product as { variants?: Array<{ id?: number; available?: boolean }> } | null)?.variants ??
      null;
    if (!variants) return 'no-control';

    // Sold out is a merchant fact, not a driver failure — worth saying plainly
    // rather than reporting a missing button.
    const variant = variants.find((v) => v.available && v.id);
    if (!variant?.id) return 'sold-out';

    const origin = new URL(page.url()).origin;
    await page.goto(`${origin}/cart/${variant.id}:1`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await page.waitForTimeout(2000);
    return 'added';
  } catch {
    return 'no-control';
  }
}

async function addToCart(page: Page): Promise<CartResult> {
  // Permalink first. Clicking add-to-cart looks like the obvious path but is
  // the fragile one: most themes disable the button until a size is chosen, so
  // it is visible yet unclickable. The permalink needs no variant selection
  // and no theme-specific DOM at all.
  const viaPermalink = await addViaCartPermalink(page);
  if (viaPermalink !== 'no-control') return viaPermalink;

  const candidates = [
    page.locator('form[action*="/cart/add"] button[type="submit"]').first(),
    page.locator('button[name="add"]').first(),
    page.getByRole('button', { name: /add to (cart|bag)/i }).first(),
  ];

  for (const button of candidates) {
    if (!(await button.isVisible().catch(() => false))) continue;

    // A disabled or overlaid control times out rather than throwing usefully.
    const clicked = await button
      .click({ timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (clicked) {
      await page.waitForTimeout(2500);
      return 'added';
    }
  }

  return 'no-control';
}

/** Shopify renders each step differently across versions; try every label it uses. */
async function fillFirst(
  scope: Page | Frame,
  selectors: string[],
  value: string,
): Promise<boolean> {
  for (const selector of selectors) {
    const field = scope.locator(selector).first();
    if (await field.isVisible().catch(() => false)) {
      await field.fill(value, { timeout: 10_000 });
      return true;
    }
  }
  return false;
}

async function fillContactAndShipping(page: Page, s: ShippingDetails): Promise<void> {
  await page.waitForTimeout(3000);

  await fillFirst(page, ['input#email', 'input[name="email"]', 'input[type="email"]'], s.email);

  const country = page.locator('select[name*="countryCode"], select#Select0').first();
  if (await country.isVisible().catch(() => false)) {
    await country.selectOption(s.countryCode).catch(() => undefined);
  }

  await fillFirst(page, ['input[name*="firstName"]', 'input#TextField0'], s.firstName);
  await fillFirst(page, ['input[name*="lastName"]', 'input#TextField1'], s.lastName);
  await fillFirst(page, ['input[name*="address1"]', 'input#shipping-address1'], s.address1);
  await fillFirst(page, ['input[name*="city"]'], s.city);
  await fillFirst(page, ['input[name*="postalCode"]', 'input[name*="zip"]'], s.postalCode);

  if (s.phone) await fillFirst(page, ['input[name*="phone"]'], s.phone);

  if (s.province) {
    const province = page.locator('select[name*="zone"], select[name*="province"]').first();
    if (await province.isVisible().catch(() => false)) {
      await province.selectOption({ label: s.province }).catch(() => undefined);
    }
  }
}

const CAPTCHA_PROMPT = /solve the captcha|complete the captcha|i am human|hcaptcha|recaptcha/i;

/** How long to leave the window open for someone to click through a captcha. */
const CAPTCHA_WAIT_MS = 3 * 60_000;

/**
 * Pause for a person to clear a captcha in the visible browser window.
 *
 * The merchant is asking for proof a human is driving, and during a checkout
 * the buyer is right there — so this waits rather than trying to satisfy the
 * challenge programmatically. Returns true only if the challenge actually
 * cleared, so the caller knows whether resubmitting is worth it.
 */
async function awaitHumanCaptcha(page: Page, step: (n: string, d?: string) => void): Promise<boolean> {
  const present = async () =>
    CAPTCHA_PROMPT.test((await page.textContent('body').catch(() => '')) ?? '');

  if (!(await present())) return false;

  step('captcha — solve it in the browser window', `waiting up to ${CAPTCHA_WAIT_MS / 60_000} min`);
  const deadline = Date.now() + CAPTCHA_WAIT_MS;

  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    if (!(await present())) {
      step('captcha cleared by human');
      return true;
    }
  }

  step('captcha not solved in time');
  return false;
}

/**
 * Close Shopify's "Confirm it's you" prompt.
 *
 * If the buyer's email belongs to a Shop Pay account, Shopify overlays a modal
 * demanding an SMS code before it will let the order through — and it covers
 * Pay now, so the click resolves and then times out. Guest checkout itself
 * needs no account, so dismissing the prompt is enough; the SMS code is not
 * something an agent can or should complete on the buyer's behalf.
 */
async function dismissShopPayPrompt(page: Page): Promise<void> {
  const body = (await page.textContent('body').catch(() => '')) ?? '';
  const shopFrame = page.frames().some((f) => /shop\.app|shopify\.com\/pay/i.test(f.url()));

  if (!/confirm it's you|confirm it’s you/i.test(body) && !shopFrame) return;

  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(1000);

  for (const scope of [page, ...page.frames()]) {
    const close = scope
      .locator('[aria-label="Close"], button[aria-label*="lose"], button:has-text("Continue as guest")')
      .first();

    if (await close.isVisible().catch(() => false)) {
      await close.click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(1500);
      break;
    }
  }
}

async function advance(page: Page, label: RegExp): Promise<void> {
  const button = page.getByRole('button', { name: label }).first();
  if (!(await button.isVisible().catch(() => false))) return;

  // Sticky footers and consent banners overlay the real button, so a plain
  // click resolves the element and then times out waiting for it to become
  // hittable. Scroll it into view first, then fall back to a forced click.
  await button.scrollIntoViewIfNeeded().catch(() => undefined);

  const clicked = await button
    .click({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  if (!clicked) {
    await button.click({ timeout: 10_000, force: true }).catch(() => undefined);
  }

  await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => undefined);
  await page.waitForTimeout(2500);
}

/**
 * Shopify isolates card inputs in iframes, one field per frame, named
 * `card-fields-<field>-<id>`. On the current one-page checkout the payment
 * section renders lazily as it scrolls into view, so the frames simply do not
 * exist until then — waiting for them without scrolling waits forever.
 */
async function waitForCardFrames(page: Page): Promise<boolean> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(1500);

    if (page.frames().some((f) => /card-fields|card_fields/i.test(f.name() + f.url()))) {
      return true;
    }
  }

  return false;
}

async function fillCard(page: Page, card: CardCredentials, s: ShippingDetails): Promise<boolean> {
  await page.waitForTimeout(3000);
  await waitForCardFrames(page);

  const expiry = `${card.expiryMonth.padStart(2, '0')}/${card.expiryYear.slice(-2)}`;
  const wanted: Array<[RegExp, string, string[]]> = [
    [/number/i, card.token, ['input[name="number"]', 'input#number']],
    [/name/i, `${s.firstName} ${s.lastName}`, ['input[name="name"]', 'input#name']],
    [/expiry|expiration/i, expiry, ['input[name="expiry"]', 'input#expiry']],
    [/verification|cvv|cvc|security/i, card.dynamicCvv, ['input[name="verification_value"]']],
  ];

  let filled = 0;

  for (const [framePattern, value, selectors] of wanted) {
    const frame = page
      .frames()
      .find((f) => framePattern.test(f.name()) || framePattern.test(f.url()));

    const scope = frame ?? page;
    if (await fillFirst(scope, selectors, value)) filled += 1;
  }

  return filled >= 3;
}

/**
 * Recognise a gateway's rejection of the card.
 *
 * Shopify Payments says "payment details couldn't be verified" rather than
 * "declined", and renders a typographic apostrophe (U+2019) — matching only
 * ASCII reads a real gateway verdict as an unrecognised state, which loses the
 * one outcome that proves the card reached a processor.
 */
export function matchDecline(body: string): string | null {
  const match = body.match(
    /(payment details could(n[''’]t| not) be verified[^.]*\.?|card was declined|payment (was )?declined|could(n[''’]t| not) be processed|(there was an )?issue processing your payment[^.]*\.?|unable to process (your )?payment[^.]*\.?|payment failed|try a different (payment method|card)[^.]*\.?|card (number )?(is )?(invalid|not valid)|card (type )?(is )?n[o']?t supported|insufficient funds|invalid card|verification failed)/i,
  );

  return match ? match[0].trim() : null;
}

async function readOutcome(page: Page): Promise<CheckoutResult> {
  await page.waitForTimeout(6000);

  const url = page.url();
  const body = (await page.textContent('body').catch(() => '')) ?? '';

  if (/thank you|order confirmed|your order is confirmed/i.test(body) || /\/orders\//.test(url)) {
    return { status: 'placed', message: 'Order confirmed by the merchant.', url };
  }

  const declined = matchDecline(body);
  if (declined) {
    return { status: 'declined', message: declined, url };
  }

  // Shopify's bot protection is adaptive: a store that completed cleanly can
  // start demanding a captcha after repeated automated checkouts from one IP.
  // Worth naming, because it is a merchant defence rather than a driver bug,
  // and nothing on our side fixes it.
  if (CAPTCHA_PROMPT.test(body)) {
    return {
      status: 'failed',
      message:
        "blocked by the merchant's bot protection (captcha) — the card was filled but the order was not submitted. Run headful (CHECKOUT_HEADLESS=false) to solve it in the window",
      url,
    };
  }

  // Surface whatever the store is actually saying — an unrecognised state is
  // almost always a notice we simply don't have a pattern for yet.
  const notices = await page
    .locator('[role="alert"], [role="status"], .notice, .field__message--error, [class*="error"], [id^="error-for"]')
    .allInnerTexts()
    .catch(() => [] as string[]);
  const notice = notices.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ').slice(0, 300);
  console.log(`checkout: unrecognised state at ${url}${notice ? ` — store says: ${notice}` : ''}`);

  return {
    status: 'failed',
    message: notice
      ? `The store did not confirm the order. It said: "${notice.slice(0, 160)}"`
      : 'Checkout finished in an unrecognised state.',
    url,
    screenshot: (await page.screenshot().catch(() => null))?.toString('base64'),
  };
}
