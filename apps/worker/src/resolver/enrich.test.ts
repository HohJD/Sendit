import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { lookup } from 'node:dns/promises';
import { enrichCandidates, __setLookupForTests } from './enrich.ts';
import type { CatalogCandidate } from './catalog.ts';

let calls: Array<{ url: string }>;
let routes: Array<{ match: RegExp; status: number; body?: string; contentType?: string; contentLength?: number }>;
let realFetch: typeof fetch;

beforeEach(() => {
  calls = [];
  routes = [];
  realFetch = globalThis.fetch;
  // Tests never do real DNS — every host "resolves" to a public address.
  __setLookupForTests(async () => ({ address: '93.184.216.34', family: 4 }) as never);

  // @ts-expect-error — minimal Response stand-in; no stream reader on purpose
  globalThis.fetch = async (url: string, init: RequestInit) => {
    calls.push({ url: String(url) });
    const route = routes.find((r) => r.match.test(String(url)));
    if (!route) throw new Error(`no mocked route for ${url}`);
    return {
      ok: route.status < 400,
      status: route.status,
      headers: new Headers({
        'content-type': route.contentType ?? 'text/html',
        ...(route.contentLength ? { 'content-length': String(route.contentLength) } : {}),
      }),
      json: async () => JSON.parse(route.body ?? '{}'),
      text: async () => route.body ?? '',
    };
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  __setLookupForTests(lookup);
});

function candidate(over: Partial<CatalogCandidate> = {}): CatalogCandidate {
  return {
    productId: 'https://shop.example.com/products/x',
    title: 'X',
    merchant: 'shop',
    merchantDomain: 'shop.example.com',
    priceAmount: null,
    currency: null,
    imageUrl: null,
    productUrl: 'https://shop.example.com/products/x',
    ...over,
  };
}

describe('enrichCandidates', () => {
  test('Shopify .js supplies the price; currency falls back to USD on .com', async () => {
    routes.push(
      { match: /products\/x$/, status: 200, body: '<html><body>product page</body></html>' },
      {
        match: /products\/x\.js$/,
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ price: 12800, featured_image: '//cdn.shop.example.com/x.jpg' }),
      },
    );

    const c = candidate();
    await enrichCandidates([c]);

    assert.equal(c.priceAmount, '128.00');
    assert.equal(c.currency, 'USD');
    assert.equal(c.imageUrl, 'https://cdn.shop.example.com/x.jpg');
    assert.ok(calls.some((call) => call.url.endsWith('/products/x.js')));
  });

  test('JSON-LD offers in an @graph supply price and currency', async () => {
    const ld = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebPage' },
        {
          '@type': 'Product',
          name: 'Jacket',
          offers: [{ price: '89.50', priceCurrency: 'GBP' }],
          image: ['https://cdn.example.com/j.jpg'],
        },
      ],
    };
    routes.push({
      match: /products\/x$/,
      status: 200,
      body: `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head></html>`,
    });

    const c = candidate({ productUrl: 'https://shop.example.co.uk/products/x' });
    await enrichCandidates([c]);

    assert.equal(c.priceAmount, '89.50');
    assert.equal(c.currency, 'GBP');
    assert.equal(c.imageUrl, 'https://cdn.example.com/j.jpg');
  });

  test('meta product:price tags work when nothing else does', async () => {
    routes.push({
      match: /item\/1$/,
      status: 200,
      body: `<html><head>
        <meta property="product:price:amount" content="42.50"/>
        <meta property="product:price:currency" content="EUR"/>
        <meta property="og:image" content="https://img.example.com/1.jpg"/>
      </head></html>`,
    });

    const c = candidate({ productUrl: 'https://shop.example.eu/item/1' });
    await enrichCandidates([c]);

    assert.equal(c.priceAmount, '42.50');
    assert.equal(c.currency, 'EUR');
    assert.equal(c.imageUrl, 'https://img.example.com/1.jpg');
  });

  test('already-priced candidates are never fetched', async () => {
    const c = candidate({ priceAmount: '10.00', currency: 'USD' });
    await enrichCandidates([c]);
    assert.equal(calls.length, 0);
    assert.equal(c.priceAmount, '10.00');
  });

  test('loopback hostnames are refused without a fetch', async () => {
    const c = candidate({ productUrl: 'http://localhost:4321/products/x' });
    await enrichCandidates([c]);
    assert.equal(c.priceAmount, null);
    assert.equal(calls.length, 0);
  });

  test('hosts resolving to private IPs are refused', async () => {
    __setLookupForTests(async () => ({ address: '192.168.1.5', family: 4 }) as never);
    const c = candidate();
    await enrichCandidates([c]);
    assert.equal(c.priceAmount, null);
    assert.equal(calls.length, 0);
  });

  test('oversized bodies are skipped', async () => {
    routes.push({ match: /products\/x$/, status: 200, body: 'x', contentLength: 2_000_000 });
    const c = candidate();
    await enrichCandidates([c]);
    assert.equal(c.priceAmount, null);
  });

  test('a dead page leaves the candidate untouched and never throws', async () => {
    routes.push({ match: /.*/, status: 500, body: 'oops' });
    const c = candidate();
    const out = await enrichCandidates([c]);
    assert.equal(c.priceAmount, null);
    assert.equal(out[0], c);
  });
});
