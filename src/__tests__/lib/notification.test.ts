import { describe, expect, it } from 'vitest';
import { unsignedNostrDefaults, type MessageRow } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import {
  fanoutToBellSubscribers,
  notifyForumPost,
  notifyForumReply,
  notifyZap,
  serializeNotification,
  type NotificationRow,
} from '@/lib/notification';
import { InMemoryNotificationStore } from '@/lib/notification-store';
import { InMemoryPushStore } from '@/lib/push-store';

const NOW = new Date('2026-08-29T12:00:00.000Z');
const ZAP_RECEIPT_ID = 'aa'.repeat(32);
const ZAP_REPLY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

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

  it('is a no-op when pushStore is omitted (no in-app rows)', async () => {
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
    expect(JSON.parse(claimed[0]?.payload ?? '{}')).toEqual({
      type: 'forum',
      title: 'New reply on 21.gifts',
      body: 'Someone replied in the living room.',
      url: '/notifications',
      tag: 'forum_reply:reply-1',
    });
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
    expect(JSON.parse(claimed[0]?.payload ?? '{}')).toMatchObject({
      url: '/notifications',
      tag: 'forum_reply:reply-1',
    });
  });

  it('creates no in-app row when pushStore is omitted', async () => {
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
    expect(JSON.parse(claimed[0]?.payload ?? '{}')).toEqual({
      type: 'forum',
      title: 'New post on 21.gifts',
      body: 'Someone posted in the living room.',
      url: '/notifications',
      tag: 'forum_post:post-1',
    });
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

  it('is a no-op when pushStore is omitted', async () => {
    const created = message({ id: 'post-1', accountId: 'actor' });
    const notifications = new InMemoryNotificationStore();
    await notifyForumPost({
      notifications,
      account: { id: 'actor' },
      created,
    });
    expect(await notifications.listByRecipient('other', 10)).toEqual([]);
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
    expect(JSON.parse(claimed[0]?.payload ?? '{}')).toEqual({
      type: 'zap',
      title: 'Bitcoin on 21.gifts',
      body: 'Someone sent sats.',
      url: '/notifications',
      tag: `zap:${ZAP_REPLY_ID}`,
    });
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

  it('is a no-op when pushStore is omitted', async () => {
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
});
