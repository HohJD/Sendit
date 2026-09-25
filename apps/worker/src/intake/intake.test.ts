import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySignature, verifyHandshake } from './signature.ts';
import { extractUrls, canonicalize } from './extract-url.ts';

const SECRET = 'test_app_secret';

const sign = (body: string) =>
  'sha256=' + createHmac('sha256', SECRET).update(Buffer.from(body)).digest('hex');

describe('signature', () => {
  test('accepts a correct digest', () => {
    const body = '{"object":"instagram"}';
    assert.equal(verifySignature(Buffer.from(body), sign(body), SECRET), true);
  });

  test('rejects a digest computed over different bytes', () => {
    const body = '{"object":"instagram"}';
    // Same JSON semantically, different bytes — this is why the raw buffer matters.
    const reserialized = '{"object": "instagram"}';
    assert.equal(verifySignature(Buffer.from(reserialized), sign(body), SECRET), false);
  });

  test('rejects a missing or malformed header', () => {
    assert.equal(verifySignature(Buffer.from('{}'), undefined, SECRET), false);
    assert.equal(verifySignature(Buffer.from('{}'), 'sha1=abc', SECRET), false);
  });
});

describe('handshake', () => {
  test('echoes the challenge when the token matches', () => {
    const params = new URLSearchParams({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'tok',
      'hub.challenge': '12345',
    });
    assert.equal(verifyHandshake(params, 'tok'), '12345');
  });

  test('refuses a wrong token', () => {
    const params = new URLSearchParams({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong',
      'hub.challenge': '12345',
    });
    assert.equal(verifyHandshake(params, 'tok'), null);
  });
});

describe('url extraction', () => {
  test('strips share and campaign tracking so repeats dedupe', () => {
    assert.equal(
      canonicalize('https://www.instagram.com/reel/ABC123/?igsh=xyz&utm_source=ig_web'),
      'https://www.instagram.com/reel/ABC123',
    );
  });

  test('ignores hosts we cannot resolve', () => {
    assert.deepEqual(extractUrls('check https://example.com/thing'), []);
  });

  test('pulls a reel link out of surrounding text and trailing punctuation', () => {
    assert.deepEqual(
      extractUrls('omg look at this https://www.instagram.com/reel/ABC123/.'),
      ['https://www.instagram.com/reel/ABC123'],
    );
  });
});
