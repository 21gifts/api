import { describe, expect, it } from 'vitest';
import { unsignedNostrDefaults, type MessageRow } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import { notifyForumReply, serializeNotification, type NotificationRow } from '@/lib/notification';
import { InMemoryNotificationStore } from '@/lib/notification-store';
import { InMemoryPushStore } from '@/lib/push-store';

const NOW = new Date('2026-08-29T12:00:00.000Z');

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
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/a',
      accountId: 'parent',
      p256dh: 'p',
      auth: 'a',
      createdAt: NOW,
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
    expect(listed[0]?.type).toBe('forum_reply');
    expect(listed[0]?.replyId).toBe('reply-1');
    expect(listed[0]?.parentId).toBe('parent-note');
    expect(listed[0]?.actorAccountId).toBe('actor');
    expect(listed[0]?.text).toBe('child');
    const claimed = await pushStore.claimPending(10, NOW.getTime(), 60_000);
    expect(claimed).toHaveLength(1);
    expect(JSON.parse(claimed[0]?.payload ?? '{}')).toEqual({
      type: 'forum',
      title: 'Reply on your post',
      body: 'Someone replied in the living room.',
      url: '/notifications',
      tag: 'forum_reply:parent-note',
    });
  });

  it('does nothing when the parent is missing', async () => {
    const messages = new InMemoryMessageStore();
    const created = await messages.create(message({ id: 'reply-1', accountId: 'actor' }));
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/a',
      accountId: 'parent',
      p256dh: 'p',
      auth: 'a',
      createdAt: NOW,
    });
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

  it('does nothing when the parent is Damus-only', async () => {
    const messages = new InMemoryMessageStore();
    await seedParent(messages, null);
    const created = await messages.create(
      message({ id: 'reply-1', accountId: 'actor', parentId: 'parent-note' }),
    );
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/a',
      accountId: 'parent',
      p256dh: 'p',
      auth: 'a',
      createdAt: NOW,
    });
    await notifyForumReply({
      messages,
      notifications,
      pushStore,
      account: { id: 'actor' },
      created,
      parentId: 'parent-note',
    });
    expect(await notifications.listByRecipient('parent', 10)).toEqual([]);
    expect(await pushStore.claimPending(10, NOW.getTime(), 60_000)).toEqual([]);
  });

  it('does nothing when the parent accountId is undefined', async () => {
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
    await notifyForumReply({
      messages,
      notifications,
      pushStore,
      account: { id: 'actor' },
      created,
      parentId: 'parent-note',
    });
    expect(await notifications.listByRecipient('parent', 10)).toEqual([]);
    expect(await pushStore.claimPending(10, NOW.getTime(), 60_000)).toEqual([]);
  });

  it('does nothing on a self-reply', async () => {
    const messages = new InMemoryMessageStore();
    await seedParent(messages, 'actor');
    const created = await messages.create(
      message({ id: 'reply-1', accountId: 'actor', parentId: 'parent-note' }),
    );
    const notifications = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/a',
      accountId: 'actor',
      p256dh: 'p',
      auth: 'a',
      createdAt: NOW,
    });
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
    await notifyForumReply({
      messages,
      notifications,
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
    await notifyForumReply({
      messages,
      notifications,
      account: { id: 'actor' },
      created,
      parentId: 'parent-note',
    });
    await notifyForumReply({
      messages,
      notifications,
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
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/a',
      accountId: 'parent',
      p256dh: 'p',
      auth: 'a',
      createdAt: NOW,
    });
    await notifyForumReply({
      messages,
      pushStore,
      account: { id: 'actor' },
      created,
      parentId: 'parent-note',
    });
    const claimed = await pushStore.claimPending(10, NOW.getTime(), 60_000);
    expect(claimed).toHaveLength(1);
    expect(JSON.parse(claimed[0]?.payload ?? '{}')).toMatchObject({
      url: '/notifications',
      tag: 'forum_reply:parent-note',
    });
  });

  it('still creates a notification when pushStore is omitted', async () => {
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
    expect(await notifications.listByRecipient('parent', 10)).toHaveLength(1);
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
});
