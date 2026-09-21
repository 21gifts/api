import { describe, expect, it, vi } from 'vitest';
import type { AuthStore } from '@/lib/auth/store';
import { unsignedNostrDefaults, type MessageRow } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import {
  fanoutToBellSubscribers,
  isStaffAccount,
  notifyExternalForumReply,
  notifyForumPost,
  notifyForumReply,
  notifyModeratorAppointed,
  notifyModeratorProposed,
  notificationsMatchingLevel,
  notifyZap,
  parseNotificationLevel,
  serializeNotification,
  wantsNotification,
  type NotificationRow,
} from '@/lib/notification';
import { InMemoryNotificationStore } from '@/lib/notification-store';
import { buildModeratorAppointedPushPayload } from '@/lib/push';
import { InMemoryPushStore } from '@/lib/push-store';

const NOW = new Date('2026-08-29T12:00:00.000Z');
const ZAP_RECEIPT_ID = 'aa'.repeat(32);
const ZAP_REPLY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function payloadObject(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected object payload');
  }
  return value as Record<string, unknown>;
}

function message(partial: Partial<MessageRow> & Pick<MessageRow, 'id' | 'accountId'>): MessageRow {
  return {
    name: 'Ada',
    text: 'child',
    createdAt: NOW,
    hasPhoto: false,
    hasVideo: false,
    videoContentType: null,
    ...unsignedNostrDefaults(),
    ...partial,
  };
}

function notification(partial: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: 'n-1',
    recipientAccountId: 'parent',
    actorAccountId: 'actor',
    type: 'forum_reply',
    parentId: 'parent-note',
    replyId: 'reply-1',
    name: 'Ada',
    text: 'child',
    createdAt: NOW,
    readAt: null,
    ...partial,
  };
}

async function seedParent(
  messages: InMemoryMessageStore,
  accountId: string | null = 'parent',
): Promise<MessageRow> {
  return messages.create(
    message({
      id: 'parent-note',
      accountId,
      name: 'Pat',
      text: 'parent',
    }),
  );
}

async function subscribe(
  pushStore: InMemoryPushStore,
  accountId: string,
  endpoint = `https://push.example/${accountId}`,
): Promise<void> {
  await pushStore.upsertSubscription({
    endpoint,
    accountId,
    p256dh: 'p',
    auth: 'a',
    createdAt: NOW,
  });
}

describe('serializeNotification', () => {
  it('projects ISO dates and omits account ids', () => {
    const readAt = new Date('2026-08-30T00:00:00.000Z');
    const publicRow = serializeNotification(
      notification({
        recipientAccountId: 'secret-parent',
        actorAccountId: 'secret-actor',
        createdAt: NOW,
        readAt,
      }),
    );
    expect(publicRow).toEqual({
      id: 'n-1',
      type: 'forum_reply',
      parentId: 'parent-note',
      replyId: 'reply-1',
      name: 'Ada',
      text: 'child',
      createdAt: NOW.toISOString(),
      readAt: readAt.toISOString(),
    });
    expect(publicRow).not.toHaveProperty('recipientAccountId');
    expect(publicRow).not.toHaveProperty('actorAccountId');
  });

  it('keeps null readAt as null', () => {
    expect(serializeNotification(notification({ readAt: null })).readAt).toBeNull();
  });

  it('accepts type forum_post', () => {
    const publicRow = serializeNotification(
      notification({ type: 'forum_post', parentId: 'post-1', replyId: 'post-1' }),
    );
    expect(publicRow.type).toBe('forum_post');
  });

  it('accepts type zap', () => {
    expect(serializeNotification(notification({ type: 'zap', replyId: ZAP_REPLY_ID })).type).toBe(
      'zap',
    );
  });

  it('accepts type moderator_appointed', () => {
    expect(
      serializeNotification(
        notification({
          type: 'moderator_appointed',
          parentId: 'subject',
          replyId: 'subject',
        }),
      ).type,
    ).toBe('moderator_appointed');
  });
});

describe('fanoutToBellSubscribers', () => {
  const template: Omit<NotificationRow, 'id' | 'recipientAccountId'> = {
    actorAccountId: 'actor',
    type: 'forum_reply',
    parentId: 'parent-note',
    replyId: 'reply-1',
    name: 'Ada',
    text: 'child',
    createdAt: NOW,
    readAt: null,
  };

  it('is a no-op when auth and pushStore are omitted (no in-app rows)', async () => {
    const notifications = new InMemoryNotificationStore();
    await fanoutToBellSubscribers({
      notifications,
      skipAccountId: 'actor',
      template,
      outboxType: 'forum',
      outboxMessageId: 'reply-1',
      payload: '{}',
      nowMs: NOW.getTime(),
    });
    expect(await notifications.listByRecipient('parent', 10)).toEqual([]);
    expect(await notifications.listByRecipient('other', 10)).toEqual([]);
  });

  it('writes one row and one outbox per subscriber except skip', async () => {
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'one');
    await subscribe(pushStore, 'two');
    await subscribe(pushStore, 'actor');
    await fanoutToBellSubscribers({
      notifications,
      pushStore,
      skipAccountId: 'actor',
      template,
      outboxType: 'forum',
      outboxMessageId: 'reply-1',
      payload: '{"tag":"forum_reply:reply-1"}',
      nowMs: NOW.getTime(),
    });
    expect(await notifications.listByRecipient('one', 10)).toHaveLength(1);
    expect(await notifications.listByRecipient('two', 10)).toHaveLength(1);
    expect(await notifications.listByRecipient('actor', 10)).toEqual([]);
    const claimed = await pushStore.claimPending(10, NOW.getTime(), 60_000);
    expect(claimed).toHaveLength(2);
    expect(claimed.map((row) => row.accountId).sort()).toEqual(['one', 'two']);
  });

  it('skips nobody when skipAccountId is null', async () => {
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'one');
    await fanoutToBellSubscribers({
      notifications,
      pushStore,
      skipAccountId: null,
      template,
      outboxType: 'zap',
      outboxMessageId: 'note-1',
      payload: '{}',
      nowMs: NOW.getTime(),
    });
    expect(await notifications.listByRecipient('one', 10)).toHaveLength(1);
  });

  it('merges each recipient unreadCount into the outbox payload after create', async () => {
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'one');
    await subscribe(pushStore, 'two');
    await notifications.create({
      ...template,
      id: 'seed-two',
      recipientAccountId: 'two',
      replyId: 'seed-reply',
    });
    await fanoutToBellSubscribers({
      notifications,
      pushStore,
      skipAccountId: 'actor',
      template,
      outboxType: 'forum',
      outboxMessageId: 'reply-1',
      payload: '{"tag":"forum_reply:reply-1"}',
      nowMs: NOW.getTime(),
    });
    const claimed = await pushStore.claimPending(10, NOW.getTime(), 60_000);
    expect(claimed).toHaveLength(2);
    for (const row of claimed) {
      expect(payloadObject(row.payload)['unreadCount']).toBe(
        await notifications.unreadCount(row.accountId),
      );
    }
    expect(await notifications.unreadCount('one')).toBe(1);
    expect(await notifications.unreadCount('two')).toBe(2);
  });

  it('enqueues the payload unchanged when notifications is omitted', async () => {
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'one');
    const payload = '{"tag":"forum_reply:reply-1"}';
    await fanoutToBellSubscribers({
      pushStore,
      skipAccountId: 'actor',
      template,
      outboxType: 'forum',
      outboxMessageId: 'reply-1',
      payload,
      nowMs: NOW.getTime(),
    });
    const claimed = await pushStore.claimPending(10, NOW.getTime(), 60_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.payload).toBe(payload);
    expect(payloadObject(claimed[0]?.payload ?? '{}')).not.toHaveProperty('unreadCount');
  });

  it('writes unreadCount from inbox only when notifications is omitted', async () => {
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'one');
    await fanoutToBellSubscribers({
      pushStore,
      skipAccountId: 'actor',
      template,
      outboxType: 'forum',
      outboxMessageId: 'reply-1',
      payload: '{"tag":"forum_reply:reply-1"}',
      nowMs: NOW.getTime(),
      inboxUnreadCount: async () => 4,
    });
    const claimed = await pushStore.claimPending(10, NOW.getTime(), 60_000);
    expect(payloadObject(claimed[0]?.payload ?? '{}')['unreadCount']).toBe(4);
  });

  it('sums notification unread and inbox unread', async () => {
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'one');
    await fanoutToBellSubscribers({
      notifications,
      pushStore,
      skipAccountId: 'actor',
      template,
      outboxType: 'forum',
      outboxMessageId: 'reply-1',
      payload: '{"tag":"forum_reply:reply-1"}',
      nowMs: NOW.getTime(),
      inboxUnreadCount: async () => 3,
    });
    const claimed = await pushStore.claimPending(10, NOW.getTime(), 60_000);
    expect(payloadObject(claimed[0]?.payload ?? '{}')['unreadCount']).toBe(
      (await notifications.unreadCount('one')) + 3,
    );
  });

  it('continues fan-out when inbox unread rejects', async () => {
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'one');
    await subscribe(pushStore, 'two');
    await expect(
      fanoutToBellSubscribers({
        pushStore,
        skipAccountId: 'actor',
        template,
        outboxType: 'forum',
        outboxMessageId: 'reply-1',
        payload: '{}',
        nowMs: NOW.getTime(),
        inboxUnreadCount: async (accountId) => {
          if (accountId === 'one') {
            throw new Error('boom');
          }
          return 2;
        },
      }),
    ).rejects.toThrow('push.fanout.failed');
    const claimed = await pushStore.claimPending(10, NOW.getTime(), 60_000);
    expect(claimed.map((row) => row.accountId)).toEqual(['two']);
    expect(payloadObject(claimed[0]?.payload ?? '{}')['unreadCount']).toBe(2);
  });

  it('enqueues { unreadCount } when the payload template is not a JSON object', async () => {
    for (const payload of ['not-json', '[]', 'null', '1']) {
      const notifications = new InMemoryNotificationStore();
      const pushStore = new InMemoryPushStore();
      await subscribe(pushStore, 'one');
      await fanoutToBellSubscribers({
        notifications,
        pushStore,
        skipAccountId: 'actor',
        template,
        outboxType: 'forum',
        outboxMessageId: 'reply-1',
        payload,
        nowMs: NOW.getTime(),
      });
      const claimed = await pushStore.claimPending(10, NOW.getTime(), 60_000);
      expect(payloadObject(claimed[0]?.payload ?? '{}')).toEqual({
        unreadCount: await notifications.unreadCount('one'),
      });
    }
  });

  it('continues fan-out when one recipient unreadCount rejects', async () => {
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'one');
    await subscribe(pushStore, 'two');
    const original = notifications.unreadCount.bind(notifications);
    notifications.unreadCount = async (accountId) => {
      if (accountId === 'one') {
        throw new Error('boom');
      }
      return original(accountId);
    };
    await expect(
      fanoutToBellSubscribers({
        notifications,
        pushStore,
        skipAccountId: 'actor',
        template,
        outboxType: 'forum',
        outboxMessageId: 'reply-1',
        payload: '{}',
        nowMs: NOW.getTime(),
      }),
    ).rejects.toThrow('push.fanout.failed');
    expect(await notifications.listByRecipient('one', 10)).toHaveLength(1);
    expect(await notifications.listByRecipient('two', 10)).toHaveLength(1);
    const claimed = await pushStore.claimPending(10, NOW.getTime(), 60_000);
    expect(claimed.map((row) => row.accountId)).toEqual(['two']);
    expect(payloadObject(claimed[0]?.payload ?? '{}')['unreadCount']).toBe(
      await notifications.unreadCount('two'),
    );
  });

  it('continues fan-out when one recipient create rejects', async () => {
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'one');
    await subscribe(pushStore, 'two');
    const original = notifications.create.bind(notifications);
    notifications.create = async (row) => {
      if (row.recipientAccountId === 'one') {
        throw new Error('boom');
      }
      return original(row);
    };
    await expect(
      fanoutToBellSubscribers({
        notifications,
        pushStore,
        skipAccountId: 'actor',
        template,
        outboxType: 'forum',
        outboxMessageId: 'reply-1',
        payload: '{}',
        nowMs: NOW.getTime(),
      }),
    ).rejects.toThrow('push.fanout.failed');
    expect(await notifications.listByRecipient('one', 10)).toEqual([]);
    expect(await notifications.listByRecipient('two', 10)).toHaveLength(1);
  });

  it('writes in-app rows to every account except skip when auth is set; push only to subscribers', async () => {
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'sub');
    await subscribe(pushStore, 'actor');
    const auth = {
      listAccounts: async () =>
        [{ id: 'member' }, { id: 'sub' }, { id: 'actor' }] as Awaited<
          ReturnType<AuthStore['listAccounts']>
        >,
    };
    await fanoutToBellSubscribers({
      notifications,
      pushStore,
      auth,
      skipAccountId: 'actor',
      template,
      outboxType: 'forum',
      outboxMessageId: 'reply-1',
      payload: '{}',
      nowMs: NOW.getTime(),
    });
    expect(await notifications.listByRecipient('member', 10)).toHaveLength(1);
    expect(await notifications.listByRecipient('sub', 10)).toHaveLength(1);
    expect(await notifications.listByRecipient('actor', 10)).toEqual([]);
    const claimed = await pushStore.claimPending(10, NOW.getTime(), 60_000);
    expect(claimed.map((row) => row.accountId).sort()).toEqual(['sub']);
  });

  it('writes in-app rows when auth is set even if pushStore is omitted', async () => {
    const notifications = new InMemoryNotificationStore();
    const auth = {
      listAccounts: async () =>
        [{ id: 'member' }, { id: 'actor' }] as Awaited<ReturnType<AuthStore['listAccounts']>>,
    };
    await fanoutToBellSubscribers({
      notifications,
      auth,
      skipAccountId: 'actor',
      template,
      outboxType: 'forum',
      outboxMessageId: 'reply-1',
      payload: '{}',
      nowMs: NOW.getTime(),
    });
    expect(await notifications.listByRecipient('member', 10)).toHaveLength(1);
    expect(await notifications.listByRecipient('actor', 10)).toEqual([]);
  });

  it('applies onlyAccountIds to in-app and push recipients before level filtering', async () => {
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'allowed');
    await subscribe(pushStore, 'excluded');
    const auth = {
      listAccounts: async () =>
        [
          { id: 'allowed', role: 'basis', notificationLevel: 'mentions' },
          { id: 'excluded', role: 'basis', notificationLevel: 'all' },
        ] as Awaited<ReturnType<AuthStore['listAccounts']>>,
    };
    await fanoutToBellSubscribers({
      notifications,
      pushStore,
      auth,
      skipAccountId: null,
      onlyAccountIds: ['allowed'],
      match: {
        actorIsStaff: false,
        isActive: false,
        mentionedAccountId: 'allowed',
      },
      template,
      outboxType: 'forum',
      outboxMessageId: 'reply-1',
      payload: '{}',
      nowMs: NOW.getTime(),
    });
    expect(await notifications.listByRecipient('allowed', 10)).toHaveLength(1);
    expect(await notifications.listByRecipient('excluded', 10)).toEqual([]);
    const claimed = await pushStore.claimPending(10, NOW.getTime(), 60_000);
    expect(claimed.map((row) => row.accountId)).toEqual(['allowed']);
  });
});

describe('notifyForumReply', () => {
  it('creates a forum_reply row and enqueues a targeted push', async () => {
    const messages = new InMemoryMessageStore();
    await seedParent(messages);
    const created = await messages.create(
      message({ id: 'reply-1', accountId: 'actor', parentId: 'parent-note' }),
    );
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'parent');
    await notifyForumReply({
      messages,
      notifications,
      pushStore,
      account: { id: 'actor' },
      created,
      parentId: 'parent-note',
    });
    const listed = await notifications.listByRecipient('parent', 10);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.type).toBe('forum_reply');
    expect(listed[0]?.replyId).toBe('reply-1');
    expect(listed[0]?.parentId).toBe('parent-note');
    expect(listed[0]?.actorAccountId).toBe('actor');
    expect(listed[0]?.text).toBe('child');
    const claimed = await pushStore.claimPending(10, NOW.getTime(), 60_000);
    expect(claimed).toHaveLength(1);
    expect(payloadObject(claimed[0]?.payload ?? '{}')).toEqual({
      type: 'forum',
      title: 'New reply on 21.gifts',
      body: 'Someone replied in the living room.',
      url: '/notifications',
      tag: 'forum_reply:reply-1',
      unreadCount: 1,
    });
  });

  it('forwards inboxUnreadCount into the forum-reply payload', async () => {
    const messages = new InMemoryMessageStore();
    await seedParent(messages);
    const created = await messages.create(
      message({ id: 'reply-1', accountId: 'actor', parentId: 'parent-note' }),
    );
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'parent');
    await notifyForumReply({
      messages,
      notifications,
      pushStore,
      account: { id: 'actor' },
      created,
      parentId: 'parent-note',
      inboxUnreadCount: async () => 2,
    });
    const claimed = await pushStore.claimPending(10, NOW.getTime(), 60_000);
    expect(payloadObject(claimed[0]?.payload ?? '{}')['unreadCount']).toBe(3);
  });

  it('does nothing when the parent is missing', async () => {
    const messages = new InMemoryMessageStore();
    const created = await messages.create(message({ id: 'reply-1', accountId: 'actor' }));
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'parent');
    await notifyForumReply({
      messages,
      notifications,
      pushStore,
      account: { id: 'actor' },
      created,
      parentId: 'missing',
    });
    expect(await notifications.listByRecipient('parent', 10)).toEqual([]);
    expect(await pushStore.claimPending(10, NOW.getTime(), 60_000)).toEqual([]);
  });

  it('fans out to bell subscribers when the parent is Damus-only', async () => {
    const messages = new InMemoryMessageStore();
    await seedParent(messages, null);
    const created = await messages.create(
      message({ id: 'reply-1', accountId: 'actor', parentId: 'parent-note' }),
    );
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'subscriber');
    await notifyForumReply({
      messages,
      notifications,
      pushStore,
      account: { id: 'actor' },
      created,
      parentId: 'parent-note',
    });
    const listed = await notifications.listByRecipient('subscriber', 10);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.type).toBe('forum_reply');
    expect(listed[0]?.parentId).toBe('parent-note');
    expect(listed[0]?.replyId).toBe('reply-1');
    expect(await notifications.listByRecipient('actor', 10)).toEqual([]);
  });

  it('fans out when the parent accountId is undefined', async () => {
    const parent = message({
      id: 'parent-note',
      accountId: undefined as unknown as null,
      name: 'Pat',
      text: 'parent',
    });
    const messages = {
      getById: async () => parent,
    } as unknown as InMemoryMessageStore;
    const created = message({ id: 'reply-1', accountId: 'actor', parentId: 'parent-note' });
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'subscriber');
    await notifyForumReply({
      messages,
      notifications,
      pushStore,
      account: { id: 'actor' },
      created,
      parentId: 'parent-note',
    });
    expect(await notifications.listByRecipient('subscriber', 10)).toHaveLength(1);
  });

  it('does nothing on a self-reply when only the actor is subscribed', async () => {
    const messages = new InMemoryMessageStore();
    await seedParent(messages, 'actor');
    const created = await messages.create(
      message({ id: 'reply-1', accountId: 'actor', parentId: 'parent-note' }),
    );
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'actor');
    await notifyForumReply({
      messages,
      notifications,
      pushStore,
      account: { id: 'actor' },
      created,
      parentId: 'parent-note',
    });
    expect(await notifications.listByRecipient('actor', 10)).toEqual([]);
    expect(await pushStore.claimPending(10, NOW.getTime(), 60_000)).toEqual([]);
  });

  it('skips the actor on a self-reply and still notifies another subscriber', async () => {
    const messages = new InMemoryMessageStore();
    await seedParent(messages, 'actor');
    const created = await messages.create(
      message({ id: 'reply-1', accountId: 'actor', parentId: 'parent-note' }),
    );
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'actor');
    await subscribe(pushStore, 'other');
    await notifyForumReply({
      messages,
      notifications,
      pushStore,
      account: { id: 'actor' },
      created,
      parentId: 'parent-note',
    });
    expect(await notifications.listByRecipient('actor', 10)).toEqual([]);
    const listed = await notifications.listByRecipient('other', 10);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.type).toBe('forum_reply');
  });

  it('creates a notification for a photo-only empty text reply', async () => {
    const messages = new InMemoryMessageStore();
    await seedParent(messages);
    const created = await messages.create(
      message({
        id: 'reply-1',
        accountId: 'actor',
        parentId: 'parent-note',
        text: '',
        hasPhoto: true,
      }),
    );
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'parent');
    await notifyForumReply({
      messages,
      notifications,
      pushStore,
      account: { id: 'actor' },
      created,
      parentId: 'parent-note',
    });
    const listed = await notifications.listByRecipient('parent', 10);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.text).toBe('');
  });

  it('returns the existing unique row on a second create of the same replyId', async () => {
    const messages = new InMemoryMessageStore();
    await seedParent(messages);
    const created = await messages.create(
      message({ id: 'reply-1', accountId: 'actor', parentId: 'parent-note' }),
    );
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'parent');
    await notifyForumReply({
      messages,
      notifications,
      pushStore,
      account: { id: 'actor' },
      created,
      parentId: 'parent-note',
    });
    await notifyForumReply({
      messages,
      notifications,
      pushStore,
      account: { id: 'actor' },
      created,
      parentId: 'parent-note',
    });
    const listed = await notifications.listByRecipient('parent', 10);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.replyId).toBe('reply-1');
  });

  it('still enqueues a push when notifications is omitted', async () => {
    const messages = new InMemoryMessageStore();
    await seedParent(messages);
    const created = await messages.create(
      message({ id: 'reply-1', accountId: 'actor', parentId: 'parent-note' }),
    );
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'parent');
    await notifyForumReply({
      messages,
      pushStore,
      account: { id: 'actor' },
      created,
      parentId: 'parent-note',
    });
    const claimed = await pushStore.claimPending(10, NOW.getTime(), 60_000);
    expect(claimed).toHaveLength(1);
    expect(payloadObject(claimed[0]?.payload ?? '{}')).toMatchObject({
      url: '/notifications',
      tag: 'forum_reply:reply-1',
    });
    expect(payloadObject(claimed[0]?.payload ?? '{}')).not.toHaveProperty('unreadCount');
  });

  it('creates no in-app row when auth and pushStore are omitted', async () => {
    const messages = new InMemoryMessageStore();
    await seedParent(messages);
    const created = await messages.create(
      message({ id: 'reply-1', accountId: 'actor', parentId: 'parent-note' }),
    );
    const notifications = new InMemoryNotificationStore();
    await notifyForumReply({
      messages,
      notifications,
      account: { id: 'actor' },
      created,
      parentId: 'parent-note',
    });
    expect(await notifications.listByRecipient('parent', 10)).toEqual([]);
  });

  it('does not throw when both stores are omitted', async () => {
    const messages = new InMemoryMessageStore();
    await seedParent(messages);
    const created = await messages.create(
      message({ id: 'reply-1', accountId: 'actor', parentId: 'parent-note' }),
    );
    await expect(
      notifyForumReply({
        messages,
        account: { id: 'actor' },
        created,
        parentId: 'parent-note',
      }),
    ).resolves.toBeUndefined();
  });

  it('fans out to two subscribers besides the actor', async () => {
    const messages = new InMemoryMessageStore();
    await seedParent(messages);
    const created = await messages.create(
      message({ id: 'reply-1', accountId: 'actor', parentId: 'parent-note' }),
    );
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'one');
    await subscribe(pushStore, 'two');
    await subscribe(pushStore, 'actor');
    await notifyForumReply({
      messages,
      notifications,
      pushStore,
      account: { id: 'actor' },
      created,
      parentId: 'parent-note',
    });
    expect(await notifications.listByRecipient('one', 10)).toHaveLength(1);
    expect(await notifications.listByRecipient('two', 10)).toHaveLength(1);
    expect(await notifications.listByRecipient('actor', 10)).toEqual([]);
    const claimed = await pushStore.claimPending(10, NOW.getTime(), 60_000);
    expect(claimed).toHaveLength(2);
    expect(claimed.map((row) => row.accountId).sort()).toEqual(['one', 'two']);
  });

  it('is a no-op when the reply actor is the platform account', async () => {
    const messages = new InMemoryMessageStore();
    await seedParent(messages);
    const created = await messages.create(
      message({ id: 'reply-1', accountId: 'plat', parentId: 'parent-note' }),
    );
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'other');
    const auth = {
      listAccounts: async () =>
        [
          { id: 'plat', role: 'basis', isPlatform: true, notificationLevel: 'all' },
          { id: 'other', role: 'basis', isPlatform: false, notificationLevel: 'all' },
        ] as Awaited<ReturnType<AuthStore['listAccounts']>>,
    };
    await notifyForumReply({
      messages,
      notifications,
      pushStore,
      auth,
      account: { id: 'plat' },
      created,
      parentId: 'parent-note',
    });
    expect(await notifications.listByRecipient('other', 10)).toEqual([]);
    expect(await pushStore.claimPending(10, NOW.getTime(), 60_000)).toEqual([]);
  });
});

describe('notifyExternalForumReply', () => {
  it('notifies only the parent author in-app and by push', async () => {
    const parent = message({
      id: 'parent-note',
      accountId: 'parent',
      name: 'Pat',
      text: 'parent',
      sats: 0,
    });
    const created = message({
      id: 'external-reply',
      accountId: null,
      parentId: parent.id,
      name: 'Robin',
      text: 'hello from nostr',
      authorPubkey: 'ab'.repeat(32),
    });
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'parent');
    await subscribe(pushStore, 'bystander');
    const auth = {
      listAccounts: async () =>
        [
          { id: 'parent', role: 'basis', notificationLevel: 'mentions' },
          { id: 'bystander', role: 'basis', notificationLevel: 'all' },
        ] as Awaited<ReturnType<AuthStore['listAccounts']>>,
    };
    await notifyExternalForumReply({ parent, created, notifications, pushStore, auth });
    const rows = await notifications.listByRecipient('parent', 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorAccountId: 'parent',
      type: 'forum_reply',
      parentId: 'parent-note',
      replyId: 'external-reply',
      name: 'Someone',
      text: 'hello from nostr',
    });
    expect(await notifications.listByRecipient('bystander', 10)).toEqual([]);
    const claimed = await pushStore.claimPending(10, NOW.getTime(), 60_000);
    expect(claimed.map((row) => row.accountId)).toEqual(['parent']);
    expect(claimed[0]?.payload).not.toContain('Robin');
  });

  it('notifies the parent author when auth is omitted', async () => {
    const parent = message({
      id: 'parent-without-auth',
      accountId: 'parent-without-auth',
      name: 'Pat',
      text: 'parent',
      sats: 0,
    });
    const created = message({
      id: 'external-reply-without-auth',
      accountId: null,
      parentId: parent.id,
      name: 'Robin',
      text: 'hello without auth',
      authorPubkey: 'cd'.repeat(32),
    });
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'parent-without-auth');
    await subscribe(pushStore, 'bystander-without-auth');

    await expect(
      notifyExternalForumReply({ parent, created, notifications, pushStore }),
    ).resolves.toBeUndefined();

    expect(await notifications.listByRecipient('parent-without-auth', 10)).toHaveLength(1);
    expect(await notifications.listByRecipient('bystander-without-auth', 10)).toEqual([]);
    const claimed = await pushStore.claimPending(10, NOW.getTime(), 60_000);
    expect(claimed.map((row) => row.accountId)).toEqual(['parent-without-auth']);
  });

  it('does nothing when the parent has no account', async () => {
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    const create = vi.spyOn(notifications, 'create');
    const listAccounts = vi.fn(async () => [] as Awaited<ReturnType<AuthStore['listAccounts']>>);
    const upsertSubscription = vi.spyOn(pushStore, 'upsertSubscription');
    const deleteSubscription = vi.spyOn(pushStore, 'deleteSubscription');
    const listByAccount = vi.spyOn(pushStore, 'listByAccount');
    const listAccountIdsWithSubscriptions = vi.spyOn(pushStore, 'listAccountIdsWithSubscriptions');
    const enqueue = vi.spyOn(pushStore, 'enqueue');
    const claimPending = vi.spyOn(pushStore, 'claimPending');
    const markSent = vi.spyOn(pushStore, 'markSent');
    const markFailed = vi.spyOn(pushStore, 'markFailed');
    const recordDelivered = vi.spyOn(pushStore, 'recordDelivered');
    await notifyExternalForumReply({
      parent: message({ id: 'external-parent', accountId: null }),
      created: message({ id: 'external-reply', accountId: null }),
      notifications,
      pushStore,
      auth: { listAccounts },
    });
    expect(listAccounts).toHaveBeenCalledTimes(0);
    expect(create).toHaveBeenCalledTimes(0);
    expect(upsertSubscription).toHaveBeenCalledTimes(0);
    expect(deleteSubscription).toHaveBeenCalledTimes(0);
    expect(listByAccount).toHaveBeenCalledTimes(0);
    expect(listAccountIdsWithSubscriptions).toHaveBeenCalledTimes(0);
    expect(enqueue).toHaveBeenCalledTimes(0);
    expect(claimPending).toHaveBeenCalledTimes(0);
    expect(markSent).toHaveBeenCalledTimes(0);
    expect(markFailed).toHaveBeenCalledTimes(0);
    expect(recordDelivered).toHaveBeenCalledTimes(0);
  });
});

describe('notifyForumPost', () => {
  it('notifies subscribers except the actor with parentId and replyId equal to the post id', async () => {
    const created = message({ id: 'post-1', accountId: 'actor', name: 'Ada', text: 'hello' });
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'other');
    await subscribe(pushStore, 'actor');
    await notifyForumPost({
      notifications,
      pushStore,
      account: { id: 'actor' },
      created,
    });
    const listed = await notifications.listByRecipient('other', 10);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.type).toBe('forum_post');
    expect(listed[0]?.parentId).toBe('post-1');
    expect(listed[0]?.replyId).toBe('post-1');
    expect(listed[0]?.actorAccountId).toBe('actor');
    expect(await notifications.listByRecipient('actor', 10)).toEqual([]);
    const claimed = await pushStore.claimPending(10, NOW.getTime(), 60_000);
    expect(claimed).toHaveLength(1);
    expect(payloadObject(claimed[0]?.payload ?? '{}')).toEqual({
      type: 'forum',
      title: 'New post on 21.gifts',
      body: 'Someone posted in the living room.',
      url: '/notifications',
      tag: 'forum_post:post-1',
      unreadCount: 1,
    });
  });

  it('forwards inboxUnreadCount into the forum-post payload', async () => {
    const created = message({ id: 'post-1', accountId: 'actor', name: 'Ada', text: 'hello' });
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'other');
    await notifyForumPost({
      notifications,
      pushStore,
      account: { id: 'actor' },
      created,
      inboxUnreadCount: async () => 5,
    });
    const claimed = await pushStore.claimPending(10, NOW.getTime(), 60_000);
    expect(payloadObject(claimed[0]?.payload ?? '{}')['unreadCount']).toBe(6);
  });

  it('skips the actor even when they have a subscription', async () => {
    const created = message({ id: 'post-1', accountId: 'actor' });
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'actor');
    await notifyForumPost({
      notifications,
      pushStore,
      account: { id: 'actor' },
      created,
    });
    expect(await notifications.listByRecipient('actor', 10)).toEqual([]);
    expect(await pushStore.claimPending(10, NOW.getTime(), 60_000)).toEqual([]);
  });

  it('is a no-op when auth and pushStore are omitted', async () => {
    const created = message({ id: 'post-1', accountId: 'actor' });
    const notifications = new InMemoryNotificationStore();
    await notifyForumPost({
      notifications,
      account: { id: 'actor' },
      created,
    });
    expect(await notifications.listByRecipient('other', 10)).toEqual([]);
  });

  it('is a no-op when the actor is the platform account', async () => {
    const created = message({ id: 'post-1', accountId: 'plat', name: '21.gifts', text: 'hello' });
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'other');
    const auth = {
      listAccounts: async () =>
        [
          { id: 'plat', role: 'basis', isPlatform: true, notificationLevel: 'all' },
          { id: 'other', role: 'basis', isPlatform: false, notificationLevel: 'all' },
        ] as Awaited<ReturnType<AuthStore['listAccounts']>>,
    };
    await notifyForumPost({
      notifications,
      pushStore,
      auth,
      account: { id: 'plat' },
      created,
    });
    expect(await notifications.listByRecipient('other', 10)).toEqual([]);
    expect(await pushStore.claimPending(10, NOW.getTime(), 60_000)).toEqual([]);
  });

  it('still notifies when the actor is founder without isPlatform', async () => {
    const created = message({ id: 'post-1', accountId: 'actor', name: 'Ada', text: 'hello' });
    const notifications = new InMemoryNotificationStore();
    const auth = {
      listAccounts: async () =>
        [
          { id: 'all-user', role: 'basis', notificationLevel: 'all' },
          { id: 'mentions-user', role: 'basis', notificationLevel: 'mentions' },
          { id: 'actor', role: 'founder' },
        ] as Awaited<ReturnType<AuthStore['listAccounts']>>,
    };
    await notifyForumPost({
      notifications,
      auth,
      account: { id: 'actor' },
      created,
    });
    expect(await notifications.listByRecipient('all-user', 10)).toHaveLength(1);
    expect(await notifications.listByRecipient('mentions-user', 10)).toHaveLength(1);
  });
});

describe('notifyZap', () => {
  it('notifies the note author and stores amount text with default name Someone', async () => {
    const note = message({ id: 'note-1', accountId: 'author', name: 'Pat', text: 'post' });
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'author');
    await notifyZap({
      notifications,
      pushStore,
      note,
      receiptId: ZAP_RECEIPT_ID,
      amountSats: 21,
      nowMs: NOW.getTime(),
    });
    const listed = await notifications.listByRecipient('author', 10);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.type).toBe('zap');
    expect(listed[0]?.parentId).toBe('note-1');
    expect(listed[0]?.replyId).toBe(ZAP_REPLY_ID);
    expect(listed[0]?.text).toBe('21');
    expect(listed[0]?.name).toBe('Someone');
    const claimed = await pushStore.claimPending(10, NOW.getTime(), 60_000);
    expect(claimed).toHaveLength(1);
    expect(payloadObject(claimed[0]?.payload ?? '{}')).toEqual({
      type: 'zap',
      title: 'Bitcoin on 21.gifts',
      body: 'Someone sent sats.',
      url: '/notifications',
      tag: `zap:${ZAP_REPLY_ID}`,
      unreadCount: 1,
    });
  });

  it('forwards inboxUnreadCount into the zap payload', async () => {
    const note = message({ id: 'note-1', accountId: 'author', name: 'Pat', text: 'post' });
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'author');
    await notifyZap({
      notifications,
      pushStore,
      note,
      receiptId: ZAP_RECEIPT_ID,
      amountSats: 21,
      nowMs: NOW.getTime(),
      inboxUnreadCount: async () => 4,
    });
    const claimed = await pushStore.claimPending(10, NOW.getTime(), 60_000);
    expect(payloadObject(claimed[0]?.payload ?? '{}')['unreadCount']).toBe(5);
  });

  it('derives replyId from the first 32 hex of a 64-hex receipt id', async () => {
    const note = message({ id: 'note-1', accountId: 'author' });
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'author');
    const receiptId = `${'ab'.repeat(16)}${'cd'.repeat(16)}`;
    await notifyZap({
      notifications,
      pushStore,
      note,
      receiptId,
      amountSats: 1,
      nowMs: NOW.getTime(),
    });
    const listed = await notifications.listByRecipient('author', 10);
    expect(listed[0]?.replyId).toBe('abababab-abab-abab-abab-abababababab');
  });

  it('skips payerAccountId and still notifies the note author', async () => {
    const note = message({ id: 'note-1', accountId: 'author' });
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'author');
    await subscribe(pushStore, 'payer');
    await notifyZap({
      notifications,
      pushStore,
      note,
      receiptId: ZAP_RECEIPT_ID,
      amountSats: 7,
      nowMs: NOW.getTime(),
      payerAccountId: 'payer',
      payerName: 'Bob',
    });
    const forAuthor = await notifications.listByRecipient('author', 10);
    expect(forAuthor).toHaveLength(1);
    expect(forAuthor[0]?.name).toBe('Bob');
    expect(forAuthor[0]?.text).toBe('7');
    expect(await notifications.listByRecipient('payer', 10)).toEqual([]);
  });

  it('does not notify the note author when they are the payer', async () => {
    const note = message({ id: 'note-1', accountId: 'author' });
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'author');
    await notifyZap({
      notifications,
      pushStore,
      note,
      receiptId: ZAP_RECEIPT_ID,
      amountSats: 3,
      nowMs: NOW.getTime(),
      payerAccountId: 'author',
    });
    expect(await notifications.listByRecipient('author', 10)).toEqual([]);
    expect(await pushStore.claimPending(10, NOW.getTime(), 60_000)).toEqual([]);
  });

  it('is a no-op when the note has no accountId', async () => {
    const note = message({ id: 'note-1', accountId: null });
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'other');
    await notifyZap({
      notifications,
      pushStore,
      note,
      receiptId: ZAP_RECEIPT_ID,
      amountSats: 21,
      nowMs: NOW.getTime(),
    });
    expect(await notifications.listByRecipient('other', 10)).toEqual([]);
    expect(await pushStore.claimPending(10, NOW.getTime(), 60_000)).toEqual([]);
  });

  it('is a no-op when auth and pushStore are omitted', async () => {
    const note = message({ id: 'note-1', accountId: 'author' });
    const notifications = new InMemoryNotificationStore();
    await notifyZap({
      notifications,
      note,
      receiptId: ZAP_RECEIPT_ID,
      amountSats: 21,
      nowMs: NOW.getTime(),
    });
    expect(await notifications.listByRecipient('author', 10)).toEqual([]);
  });

  it('is a no-op when payerAccountId is the platform account', async () => {
    const note = message({ id: 'note-1', accountId: 'author', name: 'Pat', text: 'post' });
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'author');
    const auth = {
      listAccounts: async () =>
        [
          { id: 'plat', role: 'basis', isPlatform: true, notificationLevel: 'all' },
          { id: 'author', role: 'basis', isPlatform: false, notificationLevel: 'all' },
        ] as Awaited<ReturnType<AuthStore['listAccounts']>>,
    };
    await notifyZap({
      notifications,
      pushStore,
      auth,
      note,
      receiptId: ZAP_RECEIPT_ID,
      amountSats: 21,
      nowMs: NOW.getTime(),
      payerAccountId: 'plat',
    });
    expect(await notifications.listByRecipient('author', 10)).toEqual([]);
    expect(await pushStore.claimPending(10, NOW.getTime(), 60_000)).toEqual([]);
  });
});

describe('notifyModeratorAppointed', () => {
  it('is a no-op when both stores are omitted', async () => {
    await expect(
      notifyModeratorAppointed({
        subject: { id: 'subject' },
        actor: { id: 'actor', name: 'Ada' },
        nowMs: NOW.getTime(),
      }),
    ).resolves.toBeUndefined();
  });

  it('creates the in-app row when only notifications is set', async () => {
    const notifications = new InMemoryNotificationStore();
    await notifyModeratorAppointed({
      notifications,
      subject: { id: 'subject' },
      actor: { id: 'actor', name: 'Ada' },
      nowMs: NOW.getTime(),
    });
    const listed = await notifications.listByRecipient('subject', 10);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.type).toBe('moderator_appointed');
  });

  it('enqueues without unreadCount when only pushStore is set', async () => {
    const pushStore = new InMemoryPushStore();
    await notifyModeratorAppointed({
      pushStore,
      subject: { id: 'subject' },
      actor: { id: 'actor', name: 'Ada' },
      nowMs: NOW.getTime(),
    });
    const claimed = await pushStore.claimPending(10, NOW.getTime(), 60_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.accountId).toBe('subject');
    expect(payloadObject(claimed[0]?.payload ?? '{}')).toEqual(
      buildModeratorAppointedPushPayload('subject'),
    );
    expect(payloadObject(claimed[0]?.payload ?? '{}')).not.toHaveProperty('unreadCount');
  });

  it('notifies only the subject and enqueues one forum outbox row', async () => {
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'subject');
    await subscribe(pushStore, 'actor');
    await subscribe(pushStore, 'other');
    await notifyModeratorAppointed({
      notifications,
      pushStore,
      subject: { id: 'subject' },
      actor: { id: 'actor', name: 'Ada' },
      nowMs: NOW.getTime(),
    });
    const listed = await notifications.listByRecipient('subject', 10);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.type).toBe('moderator_appointed');
    expect(listed[0]?.parentId).toBe('subject');
    expect(listed[0]?.replyId).toBe('subject');
    expect(listed[0]?.actorAccountId).toBe('actor');
    expect(listed[0]?.name).toBe('Ada');
    expect(listed[0]?.text).toBe('');
    expect(listed[0]?.readAt).toBeNull();
    expect(await notifications.listByRecipient('actor', 10)).toEqual([]);
    expect(await notifications.listByRecipient('other', 10)).toEqual([]);
    const claimed = await pushStore.claimPending(10, NOW.getTime(), 60_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.accountId).toBe('subject');
    expect(claimed[0]?.type).toBe('forum');
    expect(claimed[0]?.messageId).toBe('subject');
    expect(payloadObject(claimed[0]?.payload ?? '{}')).toEqual({
      ...buildModeratorAppointedPushPayload('subject'),
      unreadCount: 1,
    });
  });

  it('writes inbox-only unreadCount when notifications is omitted', async () => {
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'subject');
    await notifyModeratorAppointed({
      pushStore,
      inboxUnreadCount: async () => 3,
      subject: { id: 'subject' },
      actor: { id: 'actor', name: 'Ada' },
      nowMs: NOW.getTime(),
    });
    const claimed = await pushStore.claimPending(10, NOW.getTime(), 60_000);
    expect(payloadObject(claimed[0]?.payload ?? '{}')).toEqual({
      ...buildModeratorAppointedPushPayload('subject'),
      unreadCount: 3,
    });
  });

  it('adds listed inbox unread into the appointed payload', async () => {
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'subject');
    await notifyModeratorAppointed({
      notifications,
      pushStore,
      inboxUnreadCount: async () => 4,
      subject: { id: 'subject' },
      actor: { id: 'actor', name: 'Ada' },
      nowMs: NOW.getTime(),
    });
    const claimed = await pushStore.claimPending(10, NOW.getTime(), 60_000);
    expect(payloadObject(claimed[0]?.payload ?? '{}')).toEqual({
      ...buildModeratorAppointedPushPayload('subject'),
      unreadCount: 1 + 4,
    });
  });

  it('stores name Someone when actor.name is null', async () => {
    const notifications = new InMemoryNotificationStore();
    await notifyModeratorAppointed({
      notifications,
      subject: { id: 'subject' },
      actor: { id: 'actor', name: null },
      nowMs: NOW.getTime(),
    });
    expect((await notifications.listByRecipient('subject', 10))[0]?.name).toBe('Someone');
  });

  it('does not skip the subject even when the subject is the actor', async () => {
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'subject');
    await notifyModeratorAppointed({
      notifications,
      pushStore,
      subject: { id: 'subject' },
      actor: { id: 'subject', name: 'Ada' },
      nowMs: NOW.getTime(),
    });
    expect(await notifications.listByRecipient('subject', 10)).toHaveLength(1);
    const claimed = await pushStore.claimPending(10, NOW.getTime(), 60_000);
    expect(claimed.map((row) => row.accountId)).toEqual(['subject']);
  });

  it('returns the existing unique row on a second create for the same subject', async () => {
    const notifications = new InMemoryNotificationStore();
    await notifyModeratorAppointed({
      notifications,
      subject: { id: 'subject' },
      actor: { id: 'actor', name: 'Ada' },
      nowMs: NOW.getTime(),
    });
    await notifyModeratorAppointed({
      notifications,
      subject: { id: 'subject' },
      actor: { id: 'actor', name: 'Ada' },
      nowMs: NOW.getTime(),
    });
    expect(await notifications.listByRecipient('subject', 10)).toHaveLength(1);
  });

  it('throws push.fanout.failed when create rejects', async () => {
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    notifications.create = async () => {
      throw new Error('boom');
    };
    await expect(
      notifyModeratorAppointed({
        notifications,
        pushStore,
        subject: { id: 'subject' },
        actor: { id: 'actor', name: 'Ada' },
        nowMs: NOW.getTime(),
      }),
    ).rejects.toThrow('push.fanout.failed');
  });

  it('throws push.fanout.failed when unreadCount rejects', async () => {
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    let attempted = false;
    notifications.unreadCount = async () => {
      attempted = true;
      throw new Error('boom');
    };
    await expect(
      notifyModeratorAppointed({
        notifications,
        pushStore,
        subject: { id: 'subject' },
        actor: { id: 'actor', name: 'Ada' },
        nowMs: NOW.getTime(),
      }),
    ).rejects.toThrow('push.fanout.failed');
    expect(attempted).toBe(true);
  });

  it('throws push.fanout.failed when enqueue rejects', async () => {
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    pushStore.enqueue = async () => {
      throw new Error('boom');
    };
    await expect(
      notifyModeratorAppointed({
        notifications,
        pushStore,
        subject: { id: 'subject' },
        actor: { id: 'actor', name: 'Ada' },
        nowMs: NOW.getTime(),
      }),
    ).rejects.toThrow('push.fanout.failed');
  });
});

describe('notifyModeratorProposed', () => {
  it('creates in-app rows for staff except the actor and isPlatform', async () => {
    const notifications = new InMemoryNotificationStore();
    const founder = { id: 'founder', role: 'founder' as const };
    const actor = { id: 'actor', role: 'moderator' as const };
    const platform = { id: 'platform', role: 'moderator' as const, isPlatform: true };
    const basis = { id: 'basis', role: 'basis' as const };
    const subject = { id: 'subject', role: 'verified' as const };
    await notifyModeratorProposed({
      notifications,
      recipients: [founder, actor, platform, basis, subject],
      subject: { id: subject.id, name: 'Sub' },
      actor: { id: actor.id, name: 'Mod' },
      nowMs: NOW.getTime(),
    });
    const listed = await notifications.listByRecipient(founder.id, 10);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.type).toBe('moderator_proposal');
    expect(listed[0]?.parentId).toBe(subject.id);
    expect(listed[0]?.replyId).toBe(subject.id);
    expect(listed[0]?.name).toBe('Mod');
    expect(listed[0]?.text).toBe('Sub');
    expect(listed[0]?.readAt).toBeNull();
    expect(await notifications.listByRecipient(actor.id, 10)).toEqual([]);
    expect(await notifications.listByRecipient(platform.id, 10)).toEqual([]);
    expect(await notifications.listByRecipient(basis.id, 10)).toEqual([]);
    expect(await notifications.listByRecipient(subject.id, 10)).toEqual([]);
  });

  it('defaults missing actor and subject names', async () => {
    const notifications = new InMemoryNotificationStore();
    await notifyModeratorProposed({
      notifications,
      recipients: [{ id: 'founder', role: 'founder' }],
      subject: { id: 'subject', name: null },
      actor: { id: 'actor', name: null },
      nowMs: NOW.getTime(),
    });
    const listed = await notifications.listByRecipient('founder', 10);
    expect(listed[0]?.name).toBe('Someone');
    expect(listed[0]?.text).toBe('');
  });

  it('throws push.fanout.failed when create rejects', async () => {
    const notifications = new InMemoryNotificationStore();
    notifications.create = async () => {
      throw new Error('boom');
    };
    await expect(
      notifyModeratorProposed({
        notifications,
        recipients: [{ id: 'founder', role: 'founder' }],
        subject: { id: 'subject', name: 'Sub' },
        actor: { id: 'actor', name: 'Mod' },
        nowMs: NOW.getTime(),
      }),
    ).rejects.toThrow('push.fanout.failed');
  });

  it('includes inbox unread in the push payload', async () => {
    const pushStore = new InMemoryPushStore();
    await notifyModeratorProposed({
      pushStore,
      inboxUnreadCount: async () => 3,
      recipients: [{ id: 'founder', role: 'founder' }],
      subject: { id: 'subject', name: 'Sub' },
      actor: { id: 'actor', name: 'Mod' },
      nowMs: NOW.getTime(),
    });
    const claimed = await pushStore.claimPending(10, NOW.getTime(), 60_000);
    expect(payloadObject(claimed[0]?.payload ?? '{}')['unreadCount']).toBe(3);
  });

  it('throws push.fanout.failed when enqueue rejects', async () => {
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    pushStore.enqueue = async () => {
      throw new Error('boom');
    };
    await expect(
      notifyModeratorProposed({
        notifications,
        pushStore,
        recipients: [{ id: 'founder', role: 'founder' }],
        subject: { id: 'subject', name: 'Sub' },
        actor: { id: 'actor', name: 'Mod' },
        nowMs: NOW.getTime(),
      }),
    ).rejects.toThrow('push.fanout.failed');
  });
});

describe('parseNotificationLevel', () => {
  it('round-trips known levels and defaults unknown values to all', () => {
    expect(parseNotificationLevel('all')).toBe('all');
    expect(parseNotificationLevel('active')).toBe('active');
    expect(parseNotificationLevel('mentions')).toBe('mentions');
    expect(parseNotificationLevel('unknown')).toBe('all');
    expect(parseNotificationLevel(1)).toBe('all');
    expect(parseNotificationLevel(null)).toBe('all');
    expect(parseNotificationLevel(undefined)).toBe('all');
    expect(parseNotificationLevel({})).toBe('all');
  });
});

describe('isStaffAccount', () => {
  it('treats founder, moderator, and platform as staff; verified and basis are not', () => {
    expect(isStaffAccount({ role: 'founder' })).toBe(true);
    expect(isStaffAccount({ role: 'moderator' })).toBe(true);
    expect(isStaffAccount({ role: 'basis', isPlatform: true })).toBe(true);
    expect(isStaffAccount({ role: 'verified' })).toBe(false);
    expect(isStaffAccount({ role: 'basis' })).toBe(false);
  });

  it('treats an unknown role string as not staff', () => {
    expect(isStaffAccount({ role: 'admin' })).toBe(false);
    expect(isStaffAccount({ role: 'unknown', isPlatform: false })).toBe(false);
  });
});

describe('wantsNotification', () => {
  const recipientAccountId = 'me';
  const cases: Array<{
    name: string;
    actorIsStaff: boolean;
    isActive: boolean;
    mentionedAccountId: string | null;
    expected: { all: boolean; active: boolean; mentions: boolean };
  }> = [
    {
      name: 'unpaid post',
      actorIsStaff: false,
      isActive: false,
      mentionedAccountId: null,
      expected: { all: true, active: false, mentions: false },
    },
    {
      name: 'paid post',
      actorIsStaff: false,
      isActive: true,
      mentionedAccountId: null,
      expected: { all: true, active: true, mentions: false },
    },
    {
      name: 'staff unpaid post',
      actorIsStaff: true,
      isActive: false,
      mentionedAccountId: null,
      expected: { all: true, active: false, mentions: true },
    },
    {
      name: 'reply-to-me',
      actorIsStaff: false,
      isActive: false,
      mentionedAccountId: recipientAccountId,
      expected: { all: true, active: false, mentions: true },
    },
    {
      name: 'reply-to-other',
      actorIsStaff: false,
      isActive: false,
      mentionedAccountId: 'other',
      expected: { all: true, active: false, mentions: false },
    },
    {
      name: 'zap-to-me',
      actorIsStaff: false,
      isActive: true,
      mentionedAccountId: recipientAccountId,
      expected: { all: true, active: true, mentions: true },
    },
    {
      name: 'zap-to-other',
      actorIsStaff: false,
      isActive: true,
      mentionedAccountId: 'other',
      expected: { all: true, active: true, mentions: false },
    },
  ];

  for (const row of cases) {
    it(`applies all/active/mentions to ${row.name}`, () => {
      for (const level of ['all', 'active', 'mentions'] as const) {
        expect(
          wantsNotification({
            level,
            actorIsStaff: row.actorIsStaff,
            isActive: row.isActive,
            mentionedAccountId: row.mentionedAccountId,
            recipientAccountId,
          }),
        ).toBe(row.expected[level]);
      }
    });
  }
});

describe('notificationsMatchingLevel', () => {
  it('drops a non-staff unpaid forum_post at mentions and keeps a reply to the recipient', () => {
    const rows: NotificationRow[] = [
      notification({
        id: 'n-post',
        recipientAccountId: 'me',
        type: 'forum_post',
        parentId: 'post-1',
        replyId: 'post-1',
      }),
      notification({
        id: 'n-reply',
        recipientAccountId: 'me',
        type: 'forum_reply',
        parentId: 'parent-note',
        replyId: 'reply-1',
      }),
    ];
    const parentById = new Map<string, MessageRow>([
      [
        'post-1',
        message({ id: 'post-1', accountId: 'actor', parentId: null, sats: 0, text: 'hello' }),
      ],
      [
        'parent-note',
        message({ id: 'parent-note', accountId: 'me', parentId: null, sats: 0, text: 'mine' }),
      ],
    ]);
    const matched = notificationsMatchingLevel({
      rows,
      level: 'mentions',
      recipientAccountId: 'me',
      accounts: [{ id: 'actor', role: 'basis' }],
      parentById,
    });
    expect(matched.map((row) => row.id)).toEqual(['n-reply']);
  });

  it('keeps moderator_appointed at mentions', () => {
    const rows: NotificationRow[] = [
      notification({
        id: 'n-appoint',
        recipientAccountId: 'me',
        type: 'moderator_appointed',
        parentId: 'me',
        replyId: 'me',
      }),
    ];
    expect(
      notificationsMatchingLevel({
        rows,
        level: 'mentions',
        recipientAccountId: 'me',
        accounts: [],
        parentById: new Map(),
      }).map((row) => row.id),
    ).toEqual(['n-appoint']);
  });

  it('keeps moderator_proposal at mentions', () => {
    const rows: NotificationRow[] = [
      notification({
        id: 'n-propose',
        recipientAccountId: 'me',
        type: 'moderator_proposal',
        parentId: 'subject',
        replyId: 'subject',
      }),
    ];
    expect(
      notificationsMatchingLevel({
        rows,
        level: 'mentions',
        recipientAccountId: 'me',
        accounts: [],
        parentById: new Map(),
      }).map((row) => row.id),
    ).toEqual(['n-propose']);
  });

  it('returns every row at all including an unpaid non-staff forum_post', () => {
    const rows: NotificationRow[] = [
      notification({
        id: 'n-post',
        recipientAccountId: 'me',
        type: 'forum_post',
        parentId: 'post-1',
        replyId: 'post-1',
      }),
      notification({
        id: 'n-reply',
        recipientAccountId: 'me',
        type: 'forum_reply',
        parentId: 'parent-note',
        replyId: 'reply-1',
      }),
    ];
    const parentById = new Map<string, MessageRow>([
      [
        'post-1',
        message({ id: 'post-1', accountId: 'actor', parentId: null, sats: 0, text: 'hello' }),
      ],
    ]);
    const matched = notificationsMatchingLevel({
      rows,
      level: 'all',
      recipientAccountId: 'me',
      accounts: [{ id: 'actor', role: 'basis' }],
      parentById,
    });
    expect(matched.map((row) => row.id)).toEqual(['n-post', 'n-reply']);
  });

  it('keeps a paid parent at active and drops an unpaid forum_post', () => {
    const rows: NotificationRow[] = [
      notification({
        id: 'n-unpaid',
        recipientAccountId: 'me',
        type: 'forum_post',
        parentId: 'post-unpaid',
        replyId: 'post-unpaid',
      }),
      notification({
        id: 'n-paid',
        recipientAccountId: 'me',
        type: 'forum_post',
        parentId: 'post-paid',
        replyId: 'post-paid',
      }),
    ];
    const parentById = new Map<string, MessageRow>([
      [
        'post-unpaid',
        message({ id: 'post-unpaid', accountId: 'actor', parentId: null, sats: 0, text: 'hello' }),
      ],
      [
        'post-paid',
        message({ id: 'post-paid', accountId: 'actor', parentId: null, sats: 21, text: 'paid' }),
      ],
    ]);
    const matched = notificationsMatchingLevel({
      rows,
      level: 'active',
      recipientAccountId: 'me',
      accounts: [{ id: 'actor', role: 'basis' }],
      parentById,
    });
    expect(matched.map((row) => row.id)).toEqual(['n-paid']);
  });

  it('keeps a zap with missing parent and finite amount at active', () => {
    const rows: NotificationRow[] = [
      notification({
        id: 'n-zap',
        recipientAccountId: 'me',
        type: 'zap',
        parentId: 'missing',
        replyId: ZAP_REPLY_ID,
        text: '21',
      }),
    ];
    const matched = notificationsMatchingLevel({
      rows,
      level: 'active',
      recipientAccountId: 'me',
      accounts: [{ id: 'actor', role: 'basis' }],
      parentById: new Map(),
    });
    expect(matched.map((row) => row.id)).toEqual(['n-zap']);
  });

  it('drops a zap with missing parent and non-finite text at active', () => {
    const rows: NotificationRow[] = [
      notification({
        id: 'n-zap',
        recipientAccountId: 'me',
        type: 'zap',
        parentId: 'missing',
        replyId: ZAP_REPLY_ID,
        text: 'nope',
      }),
    ];
    expect(
      notificationsMatchingLevel({
        rows,
        level: 'active',
        recipientAccountId: 'me',
        accounts: [{ id: 'actor', role: 'basis' }],
        parentById: new Map(),
      }).map((row) => row.id),
    ).toEqual([]);
  });

  it('keeps a zap on an unpaid parent when zap amount is positive at active', () => {
    const rows: NotificationRow[] = [
      notification({
        id: 'n-zap',
        recipientAccountId: 'me',
        type: 'zap',
        parentId: 'parent-note',
        replyId: ZAP_REPLY_ID,
        text: '7',
      }),
    ];
    const parentById = new Map<string, MessageRow>([
      [
        'parent-note',
        message({ id: 'parent-note', accountId: 'me', parentId: null, sats: 0, text: 'mine' }),
      ],
    ]);
    const matched = notificationsMatchingLevel({
      rows,
      level: 'active',
      recipientAccountId: 'me',
      accounts: [{ id: 'actor', role: 'basis' }],
      parentById,
    });
    expect(matched.map((row) => row.id)).toEqual(['n-zap']);
  });

  it('keeps an unpaid founder forum_post at mentions', () => {
    const rows: NotificationRow[] = [
      notification({
        id: 'n-post',
        recipientAccountId: 'me',
        type: 'forum_post',
        parentId: 'post-1',
        replyId: 'post-1',
      }),
    ];
    const parentById = new Map<string, MessageRow>([
      [
        'post-1',
        message({ id: 'post-1', accountId: 'actor', parentId: null, sats: 0, text: 'hello' }),
      ],
    ]);
    const matched = notificationsMatchingLevel({
      rows,
      level: 'mentions',
      recipientAccountId: 'me',
      accounts: [{ id: 'actor', role: 'founder' }],
      parentById,
    });
    expect(matched.map((row) => row.id)).toEqual(['n-post']);
  });

  it('drops an unknown-payer zap on a founder note at mentions', () => {
    const rows: NotificationRow[] = [
      notification({
        id: 'n-zap',
        recipientAccountId: 'me',
        actorAccountId: 'actor',
        type: 'zap',
        parentId: 'parent-note',
        replyId: ZAP_REPLY_ID,
        text: '21',
      }),
    ];
    const parentById = new Map<string, MessageRow>([
      [
        'parent-note',
        message({ id: 'parent-note', accountId: 'actor', parentId: null, sats: 0, text: 'mine' }),
      ],
    ]);
    const matched = notificationsMatchingLevel({
      rows,
      level: 'mentions',
      recipientAccountId: 'me',
      accounts: [{ id: 'actor', role: 'founder' }],
      parentById,
    });
    expect(matched.map((row) => row.id)).toEqual([]);
  });

  it('keeps a zap from a distinct founder payer at mentions', () => {
    const rows: NotificationRow[] = [
      notification({
        id: 'n-zap',
        recipientAccountId: 'me',
        actorAccountId: 'staff',
        type: 'zap',
        parentId: 'parent-note',
        replyId: ZAP_REPLY_ID,
        text: '21',
      }),
    ];
    const parentById = new Map<string, MessageRow>([
      [
        'parent-note',
        message({ id: 'parent-note', accountId: 'author', parentId: null, sats: 0, text: 'mine' }),
      ],
    ]);
    const matched = notificationsMatchingLevel({
      rows,
      level: 'mentions',
      recipientAccountId: 'me',
      accounts: [{ id: 'staff', role: 'founder' }],
      parentById,
    });
    expect(matched.map((row) => row.id)).toEqual(['n-zap']);
  });

  it('drops a zap with missing parent at mentions even if the actor is founder', () => {
    const rows: NotificationRow[] = [
      notification({
        id: 'n-zap',
        recipientAccountId: 'me',
        actorAccountId: 'staff',
        type: 'zap',
        parentId: 'missing',
        replyId: ZAP_REPLY_ID,
        text: '21',
      }),
    ];
    expect(
      notificationsMatchingLevel({
        rows,
        level: 'mentions',
        recipientAccountId: 'me',
        accounts: [{ id: 'staff', role: 'founder' }],
        parentById: new Map(),
      }).map((row) => row.id),
    ).toEqual([]);
  });

  it('drops a zap whose parent has a null accountId at mentions even if the actor is founder', () => {
    const rows: NotificationRow[] = [
      notification({
        id: 'n-zap',
        recipientAccountId: 'me',
        actorAccountId: 'staff',
        type: 'zap',
        parentId: 'parent-note',
        replyId: ZAP_REPLY_ID,
        text: '21',
      }),
    ];
    const parentById = new Map<string, MessageRow>([
      [
        'parent-note',
        message({ id: 'parent-note', accountId: null, parentId: null, sats: 0, text: 'anon' }),
      ],
    ]);
    expect(
      notificationsMatchingLevel({
        rows,
        level: 'mentions',
        recipientAccountId: 'me',
        accounts: [{ id: 'staff', role: 'founder' }],
        parentById,
      }).map((row) => row.id),
    ).toEqual([]);
  });

  it('drops a forum_reply with missing parent at mentions', () => {
    const rows: NotificationRow[] = [
      notification({
        id: 'n-reply',
        recipientAccountId: 'me',
        type: 'forum_reply',
        parentId: 'missing',
        replyId: 'reply-1',
      }),
    ];
    expect(
      notificationsMatchingLevel({
        rows,
        level: 'mentions',
        recipientAccountId: 'me',
        accounts: [{ id: 'actor', role: 'basis' }],
        parentById: new Map(),
      }).map((row) => row.id),
    ).toEqual([]);
  });

  it('drops a forum_reply whose parent has a null accountId at mentions', () => {
    const rows: NotificationRow[] = [
      notification({
        id: 'n-reply',
        recipientAccountId: 'me',
        type: 'forum_reply',
        parentId: 'parent-note',
        replyId: 'reply-1',
      }),
    ];
    const parentById = new Map<string, MessageRow>([
      [
        'parent-note',
        message({ id: 'parent-note', accountId: null, parentId: null, sats: 0, text: 'anon' }),
      ],
    ]);
    expect(
      notificationsMatchingLevel({
        rows,
        level: 'mentions',
        recipientAccountId: 'me',
        accounts: [{ id: 'actor', role: 'basis' }],
        parentById,
      }).map((row) => row.id),
    ).toEqual([]);
  });
});

describe('notification level fan-out', () => {
  it('notifies only all on an unpaid non-staff forum post when recipients are all vs active', async () => {
    const created = message({ id: 'post-1', accountId: 'actor', name: 'Ada', text: 'hello' });
    const notifications = new InMemoryNotificationStore();
    const auth = {
      listAccounts: async () =>
        [
          { id: 'all-user', role: 'basis', notificationLevel: 'all' },
          { id: 'active-user', role: 'basis', notificationLevel: 'active' },
          { id: 'actor', role: 'basis' },
        ] as Awaited<ReturnType<AuthStore['listAccounts']>>,
    };
    await notifyForumPost({
      notifications,
      auth,
      account: { id: 'actor' },
      created,
    });
    expect(await notifications.listByRecipient('all-user', 10)).toHaveLength(1);
    expect(await notifications.listByRecipient('active-user', 10)).toEqual([]);
    expect(await notifications.listByRecipient('actor', 10)).toEqual([]);
  });

  it('notifies all and mentions on a staff unpaid forum post; active is dropped', async () => {
    const created = message({ id: 'post-1', accountId: 'actor', name: 'Ada', text: 'hello' });
    const notifications = new InMemoryNotificationStore();
    const auth = {
      listAccounts: async () =>
        [
          { id: 'all-user', role: 'basis', notificationLevel: 'all' },
          { id: 'active-user', role: 'basis', notificationLevel: 'active' },
          { id: 'mentions-user', role: 'basis', notificationLevel: 'mentions' },
          { id: 'actor', role: 'founder' },
        ] as Awaited<ReturnType<AuthStore['listAccounts']>>,
    };
    await notifyForumPost({
      notifications,
      auth,
      account: { id: 'actor' },
      created,
    });
    expect(await notifications.listByRecipient('all-user', 10)).toHaveLength(1);
    expect(await notifications.listByRecipient('mentions-user', 10)).toHaveLength(1);
    expect(await notifications.listByRecipient('active-user', 10)).toEqual([]);
    expect(await notifications.listByRecipient('actor', 10)).toEqual([]);
  });

  it('treats an actor missing from listAccounts as non-staff', async () => {
    const created = message({ id: 'post-1', accountId: 'ghost', name: 'Ada', text: 'hello' });
    const notifications = new InMemoryNotificationStore();
    const auth = {
      listAccounts: async () =>
        [
          { id: 'all-user', role: 'basis', notificationLevel: 'all' },
          { id: 'mentions-user', role: 'basis', notificationLevel: 'mentions' },
        ] as Awaited<ReturnType<AuthStore['listAccounts']>>,
    };
    await notifyForumPost({
      notifications,
      auth,
      account: { id: 'ghost' },
      created,
    });
    expect(await notifications.listByRecipient('all-user', 10)).toHaveLength(1);
    expect(await notifications.listByRecipient('mentions-user', 10)).toEqual([]);
  });

  it('notifies all and active on a paid non-staff forum post; mentions is dropped', async () => {
    const created = message({
      id: 'post-1',
      accountId: 'actor',
      name: 'Ada',
      text: 'hello',
      sats: 21,
    });
    const notifications = new InMemoryNotificationStore();
    const auth = {
      listAccounts: async () =>
        [
          { id: 'all-user', role: 'basis', notificationLevel: 'all' },
          { id: 'active-user', role: 'basis', notificationLevel: 'active' },
          { id: 'mentions-user', role: 'basis', notificationLevel: 'mentions' },
          { id: 'actor', role: 'basis' },
        ] as Awaited<ReturnType<AuthStore['listAccounts']>>,
    };
    await notifyForumPost({
      notifications,
      auth,
      account: { id: 'actor' },
      created,
    });
    expect(await notifications.listByRecipient('all-user', 10)).toHaveLength(1);
    expect(await notifications.listByRecipient('active-user', 10)).toHaveLength(1);
    expect(await notifications.listByRecipient('mentions-user', 10)).toEqual([]);
    expect(await notifications.listByRecipient('actor', 10)).toEqual([]);
  });

  it('notifies the parent author at mentions and drops a bystander at mentions', async () => {
    const messages = new InMemoryMessageStore();
    await seedParent(messages, 'parent-author');
    const created = await messages.create(
      message({ id: 'reply-1', accountId: 'actor', parentId: 'parent-note' }),
    );
    const notifications = new InMemoryNotificationStore();
    const auth = {
      listAccounts: async () =>
        [
          { id: 'parent-author', role: 'basis', notificationLevel: 'mentions' },
          { id: 'bystander', role: 'basis', notificationLevel: 'mentions' },
          { id: 'actor', role: 'basis' },
        ] as Awaited<ReturnType<AuthStore['listAccounts']>>,
    };
    await notifyForumReply({
      messages,
      notifications,
      auth,
      account: { id: 'actor' },
      created,
      parentId: 'parent-note',
    });
    expect(await notifications.listByRecipient('parent-author', 10)).toHaveLength(1);
    expect(await notifications.listByRecipient('bystander', 10)).toEqual([]);
    expect(await notifications.listByRecipient('actor', 10)).toEqual([]);
  });

  it('notifies the note author at mentions and drops a bystander at mentions', async () => {
    const note = message({ id: 'note-1', accountId: 'author', name: 'Pat', text: 'post' });
    const notifications = new InMemoryNotificationStore();
    const auth = {
      listAccounts: async () =>
        [
          { id: 'author', role: 'basis', notificationLevel: 'mentions' },
          { id: 'bystander', role: 'basis', notificationLevel: 'mentions' },
        ] as Awaited<ReturnType<AuthStore['listAccounts']>>,
    };
    await notifyZap({
      notifications,
      auth,
      note,
      receiptId: ZAP_RECEIPT_ID,
      amountSats: 0,
      nowMs: NOW.getTime(),
    });
    expect(await notifications.listByRecipient('author', 10)).toHaveLength(1);
    expect(await notifications.listByRecipient('bystander', 10)).toEqual([]);
  });

  it('writes everyone except skip when match is set but auth is omitted', async () => {
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'one');
    await subscribe(pushStore, 'two');
    await subscribe(pushStore, 'actor');
    const template: Omit<NotificationRow, 'id' | 'recipientAccountId'> = {
      actorAccountId: 'actor',
      type: 'forum_reply',
      parentId: 'parent-note',
      replyId: 'reply-1',
      name: 'Ada',
      text: 'child',
      createdAt: NOW,
      readAt: null,
    };
    await fanoutToBellSubscribers({
      notifications,
      pushStore,
      skipAccountId: 'actor',
      match: { actorIsStaff: false, isActive: false, mentionedAccountId: null },
      template,
      outboxType: 'forum',
      outboxMessageId: 'reply-1',
      payload: '{}',
      nowMs: NOW.getTime(),
    });
    expect(await notifications.listByRecipient('one', 10)).toHaveLength(1);
    expect(await notifications.listByRecipient('two', 10)).toHaveLength(1);
    expect(await notifications.listByRecipient('actor', 10)).toEqual([]);
    const claimed = await pushStore.claimPending(10, NOW.getTime() + 1, 60_000);
    expect(claimed.map((row) => row.accountId).sort()).toEqual(['one', 'two']);
  });

  it('treats a push-only id missing from listAccounts as all', async () => {
    const created = message({ id: 'post-1', accountId: 'actor', name: 'Ada', text: 'hello' });
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await subscribe(pushStore, 'push-only');
    const auth = {
      listAccounts: async () =>
        [
          { id: 'active-user', role: 'basis', notificationLevel: 'active' },
          { id: 'actor', role: 'basis' },
        ] as Awaited<ReturnType<AuthStore['listAccounts']>>,
    };
    await notifyForumPost({
      notifications,
      pushStore,
      auth,
      account: { id: 'actor' },
      created,
    });
    expect(await notifications.listByRecipient('push-only', 10)).toHaveLength(1);
    expect(await notifications.listByRecipient('active-user', 10)).toEqual([]);
    const claimed = await pushStore.claimPending(10, NOW.getTime() + 1, 60_000);
    expect(claimed.map((row) => row.accountId)).toEqual(['push-only']);
  });
});
