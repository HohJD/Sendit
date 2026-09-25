import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { instagram } from './instagram.ts';

describe('instagram parse', () => {
  test('reads a shared reel attachment into urls', () => {
    const messages = instagram.parseWebhook({
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'IGSID_123' },
              message: {
                mid: 'mid_1',
                attachments: [
                  {
                    type: 'ig_reel',
                    payload: {
                      url: 'https://www.instagram.com/reel/ABC123/?igsh=drop',
                      title: 'linen shirt haul',
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    assert.equal(messages.length, 1);
    assert.equal(messages[0].channel, 'instagram');
    assert.equal(messages[0].externalId, 'IGSID_123');
    assert.equal(messages[0].messageId, 'mid_1');
    assert.deepEqual(messages[0].urls, ['https://www.instagram.com/reel/ABC123']);
    assert.equal(messages[0].media, undefined);
  });

  test('ignores echoes of our own outbound replies', () => {
    const messages = instagram.parseWebhook({
      entry: [
        {
          messaging: [
            {
              sender: { id: 'IGSID_123' },
              message: {
                mid: 'mid_2',
                is_echo: true,
                attachments: [
                  { type: 'ig_reel', payload: { url: 'https://www.instagram.com/reel/X/' } },
                ],
              },
            },
          ],
        },
      ],
    });

    assert.deepEqual(messages, []);
  });

  test('ignores non-shareable attachments but keeps the message', () => {
    const messages = instagram.parseWebhook({
      entry: [
        {
          messaging: [
            {
              sender: { id: 'IGSID_123' },
              message: {
                mid: 'mid_3',
                attachments: [{ type: 'audio', payload: { url: 'https://cdn/x.m4a' } }],
              },
            },
          ],
        },
      ],
    });

    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].urls, []);
    assert.equal(messages[0].media, undefined);
  });

  test('reads a photo attachment into media', () => {
    const messages = instagram.parseWebhook({
      entry: [
        {
          messaging: [
            {
              sender: { id: 'IGSID_123' },
              message: {
                mid: 'mid_4',
                text: 'where can I get this',
                attachments: [{ type: 'image', payload: { url: 'https://cdn/x.jpg' } }],
              },
            },
          ],
        },
      ],
    });

    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].media, {
      ref: 'https://cdn/x.jpg',
      kind: 'image',
      caption: 'where can I get this',
    });
  });

  test('reads a shared feed post into media', () => {
    const messages = instagram.parseWebhook({
      entry: [
        {
          messaging: [
            {
              sender: { id: 'IGSID_9' },
              message: {
                mid: 'mid_post',
                attachments: [
                  {
                    type: 'ig_post',
                    payload: {
                      ig_post_media_id: '18222878329325287',
                      title: 'Comment link for Links #jeans',
                      url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1&signature=x',
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    assert.equal(messages.length, 1);
    assert.equal(messages[0].media?.ref, 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1&signature=x');
    assert.equal(messages[0].media?.caption, 'Comment link for Links #jeans');
  });

  test('does not double-count a link that is both attached and pasted', () => {
    const messages = instagram.parseWebhook({
      entry: [
        {
          messaging: [
            {
              sender: { id: 'IGSID_123' },
              message: {
                mid: 'mid_5',
                text: 'https://www.instagram.com/reel/ABC123/',
                attachments: [
                  {
                    type: 'ig_reel',
                    payload: { url: 'https://www.instagram.com/reel/ABC123/?igsh=z' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    assert.deepEqual(messages[0].urls, ['https://www.instagram.com/reel/ABC123']);
  });

  test('reads a quick_reply payload into buttonReply', () => {
    const messages = instagram.parseWebhook({
      entry: [
        {
          messaging: [
            {
              sender: { id: 'IGSID_123' },
              message: {
                mid: 'mid_6',
                text: 'Approve',
                quick_reply: { payload: 'approve:item_1' },
              },
            },
          ],
        },
      ],
    });

    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].buttonReply, { id: 'approve:item_1', title: '' });
  });
});
