import { describe, expect, it } from 'vitest';
import {
  buildForumPushPayload,
  buildModeratorAppointedPushPayload,
  buildReplyPushPayload,
  buildConversationPushPayload,
  buildZapPushPayload,
  parsePushSubscription,
  pushTagForNotification,
} from '@/lib/push';

describe('pushTagForNotification', () => {
  it('maps notification kinds to their stored collapse ids', () => {
    const ids = { parentId: 'parent', replyId: 'reply' };
    expect(pushTagForNotification({ type: 'forum_post', ...ids })).toBe('forum_post:parent');
    expect(pushTagForNotification({ type: 'forum_reply', ...ids })).toBe('forum_reply:reply');
    expect(pushTagForNotification({ type: 'forum_mention', ...ids })).toBe('forum_mention:reply');
    expect(pushTagForNotification({ type: 'zap', ...ids })).toBe('zap:reply');
    expect(pushTagForNotification({ type: 'moderator_appointed', ...ids })).toBe(
      'moderator_appointed:parent',
    );
    expect(pushTagForNotification({ type: 'moderator_proposal', ...ids })).toBeNull();
  });
});

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
  it('uses the author name and note text, and keeps the forum tag', () => {
    expect(buildForumPushPayload({ postId: 'post-1', name: 'Ada', text: 'hello' })).toEqual({
      type: 'forum',
      title: 'Ada',
      body: 'hello',
      url: '/messages/post-1',
      tag: 'forum_post:post-1',
    });
  });

  it('collapses whitespace in the name and the text', () => {
    expect(
      buildForumPushPayload({
        postId: 'post-1',
        name: '  Ada \n\t Lovelace  ',
        text: 'hello\n\tworld',
      }),
    ).toMatchObject({
      title: 'Ada Lovelace',
      body: 'hello world',
    });
  });

  it('uses Someone when the name is empty or whitespace', () => {
    expect(buildForumPushPayload({ postId: 'post-1', name: '', text: 'hi' }).title).toBe('Someone');
    expect(buildForumPushPayload({ postId: 'post-1', name: ' \n\t ', text: 'hi' }).title).toBe(
      'Someone',
    );
  });

  it('keeps an 80-code-point name and cuts 81 with an ellipsis', () => {
    const eighty = 'a'.repeat(80);
    const eightyOne = 'a'.repeat(81);
    expect(buildForumPushPayload({ postId: 'post-1', name: eighty, text: 'hi' }).title).toBe(
      eighty,
    );
    expect(buildForumPushPayload({ postId: 'post-1', name: eightyOne, text: 'hi' }).title).toBe(
      `${'a'.repeat(79)}…`,
    );
  });

  it('uses the living-room sentence when text is empty or whitespace', () => {
    expect(buildForumPushPayload({ postId: 'post-1', name: 'Ada', text: '' }).body).toBe(
      'Posted in the living room.',
    );
    expect(buildForumPushPayload({ postId: 'post-1', name: 'Ada', text: ' \n\t ' }).body).toBe(
      'Posted in the living room.',
    );
  });

  it('uses a photo or video sentence when the text is empty', () => {
    expect(
      buildForumPushPayload({ postId: 'post-1', name: 'Ada', text: '', hasPhoto: true }).body,
    ).toBe('Posted a photo.');
    expect(
      buildForumPushPayload({ postId: 'post-1', name: 'Ada', text: '', hasVideo: true }).body,
    ).toBe('Posted a video.');
    expect(
      buildForumPushPayload({
        postId: 'post-1',
        name: 'Ada',
        text: '',
        hasPhoto: true,
        hasVideo: true,
      }).body,
    ).toBe('Posted a photo and a video.');
  });

  it('keeps non-empty text when media flags are set', () => {
    expect(
      buildForumPushPayload({
        postId: 'post-1',
        name: 'Ada',
        text: 'hello',
        hasPhoto: true,
        hasVideo: true,
      }).body,
    ).toBe('hello');
  });

  it('keeps 180 code points and cuts 181 with an ellipsis', () => {
    const exact = 'b'.repeat(180);
    const over = 'b'.repeat(181);
    expect(buildForumPushPayload({ postId: 'post-1', name: 'Ada', text: exact }).body).toBe(exact);
    expect(buildForumPushPayload({ postId: 'post-1', name: 'Ada', text: over }).body).toBe(
      `${'b'.repeat(179)}…`,
    );
  });

  it('counts an emoji as one code point and does not leave a lone surrogate', () => {
    const fits = `${'a'.repeat(179)}😀`;
    expect(Array.from(fits)).toHaveLength(180);
    expect(buildForumPushPayload({ postId: 'post-1', name: 'Ada', text: fits }).body).toBe(fits);
    const over = `${'a'.repeat(180)}😀`;
    const body = buildForumPushPayload({ postId: 'post-1', name: 'Ada', text: over }).body;
    expect(body).toBe(`${'a'.repeat(179)}…`);
    expect(body).not.toMatch(/[\uD800-\uDFFF]/);
  });

  it('percent-encodes a slash in the post id so it stays one path segment', () => {
    expect(buildForumPushPayload({ postId: 'a/b', name: 'Ada', text: 'hello' }).url).toBe(
      '/messages/a%2Fb',
    );
  });
});

describe('buildReplyPushPayload', () => {
  it('points at /messages/<replyId> with the reply id tag', () => {
    expect(buildReplyPushPayload({ replyId: 'reply-1', name: 'Ada', text: 'child' })).toEqual({
      type: 'forum',
      title: 'Ada',
      body: 'child',
      url: '/messages/reply-1',
      tag: 'forum_reply:reply-1',
    });
  });

  it('uses the living-room sentence when text is empty or whitespace', () => {
    expect(buildReplyPushPayload({ replyId: 'reply-1', name: 'Ada', text: '' }).body).toBe(
      'Replied in the living room.',
    );
    expect(buildReplyPushPayload({ replyId: 'reply-1', name: 'Ada', text: ' \n\t ' }).body).toBe(
      'Replied in the living room.',
    );
  });

  it('uses a photo or video sentence when the text is empty', () => {
    expect(
      buildReplyPushPayload({ replyId: 'reply-1', name: 'Ada', text: '', hasPhoto: true }).body,
    ).toBe('Replied with a photo.');
    expect(
      buildReplyPushPayload({ replyId: 'reply-1', name: 'Ada', text: '', hasVideo: true }).body,
    ).toBe('Replied with a video.');
    expect(
      buildReplyPushPayload({
        replyId: 'reply-1',
        name: 'Ada',
        text: '',
        hasPhoto: true,
        hasVideo: true,
      }).body,
    ).toBe('Replied with a photo and a video.');
  });

  it('keeps non-empty text when media flags are set', () => {
    expect(
      buildReplyPushPayload({
        replyId: 'reply-1',
        name: 'Ada',
        text: 'child',
        hasPhoto: true,
        hasVideo: true,
      }).body,
    ).toBe('child');
  });
});

describe('buildZapPushPayload', () => {
  it('names the payer and states the amount', () => {
    expect(buildZapPushPayload({ messageId: 'msg-1', name: 'Ada', amountSats: 21 })).toEqual({
      type: 'zap',
      title: 'Ada',
      body: 'Sent 21 sats.',
      url: '/messages/msg-1',
      tag: 'zap:msg-1',
    });
  });

  it('uses Someone and zero sats when the name is empty', () => {
    expect(buildZapPushPayload({ messageId: 'msg-1', name: '', amountSats: 0 })).toEqual({
      type: 'zap',
      title: 'Someone',
      body: 'Sent 0 sats.',
      url: '/messages/msg-1',
      tag: 'zap:msg-1',
    });
  });

  it('opens noteId when set and falls back to messageId when noteId is empty', () => {
    expect(
      buildZapPushPayload({ messageId: 'msg-1', name: 'Ada', amountSats: 21, noteId: 'note-9' }),
    ).toEqual({
      type: 'zap',
      title: 'Ada',
      body: 'Sent 21 sats.',
      url: '/messages/note-9',
      tag: 'zap:msg-1',
    });
    expect(
      buildZapPushPayload({ messageId: 'msg-1', name: 'Ada', amountSats: 21, noteId: '' }),
    ).toEqual({
      type: 'zap',
      title: 'Ada',
      body: 'Sent 21 sats.',
      url: '/messages/msg-1',
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
