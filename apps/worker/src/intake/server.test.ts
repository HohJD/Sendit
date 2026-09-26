import './server.test.env.ts';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequestHandler } from './server.ts';

let server: Server;
let upstream: Server;
let base: string;
let upstreamBase: string;
let upstreamSaw: Array<{ method?: string; url?: string; host?: string; body: string }>;
let savedTarget: string | undefined;

beforeEach(async () => {
  savedTarget = process.env.WEB_PROXY_TARGET;
  upstreamSaw = [];

  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      upstreamSaw.push({ method: req.method, url: req.url, host: req.headers.host, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'content-type': 'text/plain', 'x-upstream': 'yes' });
      res.end('upstream body');
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  server = createServer(createRequestHandler());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (savedTarget === undefined) delete process.env.WEB_PROXY_TARGET;
  else process.env.WEB_PROXY_TARGET = savedTarget;
  await new Promise((r) => server.close(r));
  await new Promise((r) => upstream.close(r));
});

/** Raw HTTP request — undici won't spoof Host or send upgrades. */
function rawRequest(
  target: string,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  const u = new URL(target);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        method: opts.method ?? 'GET',
        path: opts.path ?? '/',
        headers: opts.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe('intake reverse proxy', () => {
  test('unknown paths proxy to WEB_PROXY_TARGET, preserving method/host/body', async () => {
    process.env.WEB_PROXY_TARGET = upstreamBase;
    // fetch/undici won't let us spoof Host — drive the socket directly.
    const res = await rawRequest(base, {
      method: 'POST',
      path: '/some/page?x=1',
      headers: { host: 'foothill.example.dev', 'content-type': 'text/plain' },
      body: 'hello upstream',
    });

    assert.equal(res.status, 200);
    assert.equal(res.body, 'upstream body');
    assert.equal(res.headers['x-upstream'], 'yes');
    assert.equal(upstreamSaw.length, 1);
    assert.equal(upstreamSaw[0].method, 'POST');
    assert.equal(upstreamSaw[0].url, '/some/page?x=1');
    assert.equal(upstreamSaw[0].host, 'foothill.example.dev');
    assert.equal(upstreamSaw[0].body, 'hello upstream');
  });

  test('x-forwarded-proto on the inbound adds x-forwarded-host upstream', async () => {
    process.env.WEB_PROXY_TARGET = upstreamBase;
    const res = await fetch(`${base}/page`, {
      headers: {
        host: 'foothill.example.dev',
        'x-forwarded-proto': 'https',
      },
    });
    assert.equal(res.status, 200);
  });

  test('worker routes win over the proxy', async () => {
    process.env.WEB_PROXY_TARGET = upstreamBase;
    const health = await fetch(`${base}/health`);
    assert.equal(await health.text(), 'ok');

    const wassist = await fetch(`${base}/webhooks/wassist`);
    assert.equal(await wassist.text(), 'ok');

    assert.equal(upstreamSaw.length, 0);
  });

  test('unknown path is a 404 when WEB_PROXY_TARGET is unset', async () => {
    delete process.env.WEB_PROXY_TARGET;
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
  });

  test('a websocket upgrade gets a 501, not a hang', async () => {
    process.env.WEB_PROXY_TARGET = upstreamBase;
    const res = await rawRequest(base, {
      path: '/',
      headers: { upgrade: 'websocket', connection: 'upgrade' },
    });
    assert.equal(res.status, 501);
  });

  test('a dead upstream answers 502', async () => {
    await new Promise((r) => upstream.close(r));
    process.env.WEB_PROXY_TARGET = upstreamBase;
    const res = await fetch(`${base}/page`);
    assert.equal(res.status, 502);
    // recreate for afterEach teardown
    upstream = createServer();
  });
});
