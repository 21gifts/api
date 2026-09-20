import { describe, expect, it } from 'vitest';
import {
  buildForumPushPayload,
  buildModeratorAppointedPushPayload,
  buildReplyPushPayload,
  buildConversationPushPayload,
  buildZapPushPayload,
  parsePushSubscription,
} from '@/lib/push';

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
    expect(buildForumPushPayload('post-1')).toEqual({
      type: 'forum',
      title: 'New post on 21.gifts',
      body: 'Someone posted in the living room.',
      url: '/notifications',
      tag: 'forum_post:post-1',
    });
  });
});

describe('buildReplyPushPayload', () => {
  it('points at /notifications with the reply id tag', () => {
    expect(buildReplyPushPayload('reply-1')).toEqual({
      type: 'forum',
      title: 'New reply on 21.gifts',
      body: 'Someone replied in the living room.',
      url: '/notifications',
      tag: 'forum_reply:reply-1',
    });
  });
});

describe('buildZapPushPayload', () => {
  it('includes the message id in the tag', () => {
    expect(buildZapPushPayload('msg-1')).toEqual({
      type: 'zap',
      title: 'Bitcoin on 21.gifts',
      body: 'Someone sent sats.',
      url: '/notifications',
      tag: 'zap:msg-1',
    });
  });
});

describe('buildModeratorAppointedPushPayload', () => {
  it('returns the fixed English moderator-appointed payload', () => {
    expect(buildModeratorAppointedPushPayload('subject-1')).toEqual({
      type: 'forum',
      title: 'You are a moderator',
      body: 'You were appointed a moderator in the living room.',
      url: '/welcome',
      tag: 'moderator_appointed:subject-1',
    });
  });
});

describe('buildConversationPushPayload', () => {
  it('points at /messages?c= with the sender name as title', () => {
    expect(
      buildConversationPushPayload({
        conversationId: 'c-1',
        name: 'Ada',
        text: 'hello',
      }),
    ).toEqual({
      type: 'conversation',
      title: 'Ada',
      body: 'hello',
      url: '/messages?c=c-1',
      tag: 'conversation:c-1',
    });
  });

  it('uses 21.gifts when the name is empty', () => {
    expect(
      buildConversationPushPayload({ conversationId: 'c-1', name: '', text: 'hi' }).title,
    ).toBe('21.gifts');
  });

  it('uses a provided non-empty url', () => {
    expect(
      buildConversationPushPayload({
        conversationId: 'c-1',
        name: 'Ada',
        text: 'hello',
        url: '/moderate/group',
      }),
    ).toEqual({
      type: 'conversation',
      title: 'Ada',
      body: 'hello',
      url: '/moderate/group',
      tag: 'conversation:c-1',
    });
  });

  it('keeps the inbox url when url is empty', () => {
    expect(
      buildConversationPushPayload({
        conversationId: 'c-1',
        name: 'Ada',
        text: 'hello',
        url: '',
      }).url,
    ).toBe('/messages?c=c-1');
  });
});
