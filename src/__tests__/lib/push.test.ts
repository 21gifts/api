import { describe, expect, it } from 'vitest';
import { buildForumPushPayload, buildZapPushPayload, parsePushSubscription } from '@/lib/push';

describe('parsePushSubscription', () => {
  const validKeys = { p256dh: 'abcABC123_-', auth: 'xyzXYZ789_-' };

  it('returns null for non-objects', () => {
    expect(parsePushSubscription(null)).toBeNull();
    expect(parsePushSubscription('x')).toBeNull();
    expect(parsePushSubscription(1)).toBeNull();
  });

  it('returns null when endpoint or keys are missing', () => {
    expect(parsePushSubscription({})).toBeNull();
    expect(parsePushSubscription({ endpoint: 'https://x.test/p', keys: null })).toBeNull();
    expect(parsePushSubscription({ endpoint: '', keys: validKeys })).toBeNull();
    expect(parsePushSubscription({ endpoint: 1, keys: validKeys })).toBeNull();
  });

  it('returns null for invalid key charset or empty keys', () => {
    expect(
      parsePushSubscription({
        endpoint: 'https://x.test/p',
        keys: { p256dh: '', auth: 'abc' },
      }),
    ).toBeNull();
    expect(
      parsePushSubscription({
        endpoint: 'https://x.test/p',
        keys: { p256dh: 'abc', auth: '' },
      }),
    ).toBeNull();
    expect(
      parsePushSubscription({
        endpoint: 'https://x.test/p',
        keys: { p256dh: 'abc+', auth: 'xyz' },
      }),
    ).toBeNull();
  });

  it('returns null for non-URL endpoints and non-https remote hosts', () => {
    expect(parsePushSubscription({ endpoint: 'not a url', keys: validKeys })).toBeNull();
    expect(parsePushSubscription({ endpoint: 'http://example.com/p', keys: validKeys })).toBeNull();
    expect(parsePushSubscription({ endpoint: 'ftp://localhost/p', keys: validKeys })).toBeNull();
  });

  it('allows https endpoints and localhost/127.0.0.1 http for tests', () => {
    expect(
      parsePushSubscription({
        endpoint: 'https://push.example/sub',
        keys: { p256dh: 'abc=', auth: 'xyz==' },
      }),
    ).toEqual({
      endpoint: 'https://push.example/sub',
      p256dh: 'abc=',
      auth: 'xyz==',
    });
    expect(
      parsePushSubscription({
        endpoint: 'http://localhost:8080/p',
        keys: validKeys,
      })?.endpoint,
    ).toBe('http://localhost:8080/p');
    expect(
      parsePushSubscription({
        endpoint: 'http://127.0.0.1/p',
        keys: validKeys,
      })?.endpoint,
    ).toBe('http://127.0.0.1/p');
  });
});

describe('buildForumPushPayload', () => {
  it('returns the fixed English forum payload', () => {
    expect(buildForumPushPayload()).toEqual({
      type: 'forum',
      title: 'New message on 21.gifts',
      body: 'Someone posted in the living room.',
      url: '/welcome',
      tag: 'forum',
    });
  });
});

describe('buildZapPushPayload', () => {
  it('includes the message id in the tag', () => {
    expect(buildZapPushPayload('msg-1')).toEqual({
      type: 'zap',
      title: 'Bitcoin on your post',
      body: 'Someone sent you sats.',
      url: '/welcome',
      tag: 'zap:msg-1',
    });
  });
});
