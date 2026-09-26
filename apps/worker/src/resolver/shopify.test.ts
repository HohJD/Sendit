import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { findShopifyProduct, isShopifyStore, __resetShopifyCacheForTests } from './shopify.ts';
import { __setLookupForTests } from './enrich.ts';

let calls: string[];
let responses: Array<{ status: number; body: unknown }>;
let realFetch: typeof fetch;

beforeEach(() => {
  calls = [];
  responses = [];
  realFetch = globalThis.fetch;
  __resetShopifyCacheForTests();
  // safeFetch does a DNS check first — never let tests hit real DNS.
  __setLookupForTests(async () => ({ address: '93.184.216.34', family: 4 }) as never);

  // @ts-expect-error — test double
  globalThis.fetch = async (url: string) => {
    calls.push(String(url));
    const next = responses.shift();
    if (!next) throw new Error('no mocked response queued');
    return {
      ok: next.status < 400,
      status: next.status,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => next.body,
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)),
    };
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('findShopifyProduct', () => {
  test('suggest.json happy path returns a priced candidate with absolute URLs', async () => {
    responses.push({ status: 200, body: { name: 'Overtime Shop', currency: 'USD' } });
    responses.push({
      status: 200,
      body: {
        resources: {
          results: {
            products: [
              { title: 'Hoodie', url: '/products/hoodie', price: '60.00' },
              { title: 'Classic Tee Black', url: '/products/classic-tee', price: '40.00', image: '/img/tee.jpg' },
            ],
          },
        },
      },
    });

    const out = await findShopifyProduct('https://shop.overtime.tv', 'overtime classic tee black');
    assert.equal(out?.productUrl, 'https://shop.overtime.tv/products/classic-tee');
    assert.equal(out?.title, 'Classic Tee Black');
    assert.equal(out?.priceAmount, '40.00');
    assert.equal(out?.currency, 'USD');
    assert.equal(out?.imageUrl, 'https://shop.overtime.tv/img/tee.jpg');
    assert.equal(out?.merchantDomain, 'shop.overtime.tv');
  });

  test('falls back to products.json with title matching', async () => {
    responses.push({ status: 200, body: { name: 'Store' } }); // meta.json, no currency
    responses.push({ status: 404, body: {} }); // suggest.json
    responses.push({
      status: 200,
      body: {
        products: [
          { title: 'Unrelated mug', handle: 'mug', variants: [{ price: '10.00' }], images: [{ src: 'https://cdn.com/m.jpg' }] },
          { title: 'The Long Haul Jacket', handle: 'long-haul-jacket', variants: [{ price: '128.00' }] },
        ],
      },
    });

    const out = await findShopifyProduct('https://taylorstitch.com', 'taylor stitch long haul jacket');
    assert.equal(out?.productUrl, 'https://taylorstitch.com/products/long-haul-jacket');
    assert.equal(out?.priceAmount, '128.00');
    assert.equal(out?.currency, 'USD'); // .com fallback
  });

  test('non-Shopify origin returns null', async () => {
    responses.push({ status: 404, body: {} });
    responses.push({ status: 200, body: '<html><body>wordpress blog</body></html>' });
    assert.equal(await findShopifyProduct('https://plain.example', 'tee'), null);
  });

  test('refuses private hosts without fetching', async () => {
    __setLookupForTests(async () => ({ address: '10.0.0.5', family: 4 }) as never);
    assert.equal(await findShopifyProduct('http://internal.example', 'tee'), null);
    assert.equal(calls.length, 0);
  });
});

describe('isShopifyStore', () => {
  test('true when meta.json returns shop info', async () => {
    responses.push({ status: 200, body: { name: 'Overtime Shop', currency: 'USD' } });
    assert.equal(await isShopifyStore('https://shop.overtime.tv'), true);
    assert.equal(calls.length, 1);
  });

  test('falls through to the HTML sniff on a meta.json miss', async () => {
    responses.push({ status: 404, body: {} });
    responses.push({ status: 200, body: '<html><script src="https://cdn.shopify.com/x.js"></script></html>' });
    assert.equal(await isShopifyStore('https://brand.example'), true);
  });

  test('false for a plain non-Shopify site and never throws', async () => {
    responses.push({ status: 404, body: {} });
    responses.push({ status: 200, body: '<html><body>wordpress blog</body></html>' });
    assert.equal(await isShopifyStore('https://commedesgaarcons.example'), false);
    // Unreachable origin — still false, not a throw.
    assert.equal(await isShopifyStore('https://dead.example'), false);
  });

  test('caches per origin — second call makes no requests', async () => {
    responses.push({ status: 200, body: { name: 'Store' } });
    assert.equal(await isShopifyStore('https://cached.example'), true);
    const afterFirst = calls.length;
    assert.equal(await isShopifyStore('https://cached.example'), true);
    assert.equal(calls.length, afterFirst);
  });
});
