import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { unsignedNostrDefaults, type MessageRow } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import type { NotificationRow } from '@/lib/notification';
import { InMemoryNotificationStore } from '@/lib/notification-store';
import { InMemoryPushStore } from '@/lib/push-store';
import { notificationRoutes } from '@/routes/notifications';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

const now = (): number => 1_700_000_000_000;
const AUTH = { authorization: 'Bearer tok' };
const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID_READ = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ID_OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ID_E = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ID_F = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const READ_ISO = new Date(now()).toISOString();

function mount(
  authStore: InMemoryAuthStore,
  store = new InMemoryNotificationStore(),
  messages: InMemoryMessageStore = new InMemoryMessageStore(),
  optional: {
    now?: () => number;
    pushStore?: InMemoryPushStore;
    inboxUnreadCount?: (accountId: string) => Promise<number>;
  } = {},
): Hono {
  return new Hono().route(
    '/notifications',
    notificationRoutes({
      store,
      authStore,
      messages,
      now: optional.now ?? now,
      ...(optional.pushStore === undefined ? {} : { pushStore: optional.pushStore }),
      ...(optional.inboxUnreadCount === undefined
        ? {}
        : { inboxUnreadCount: optional.inboxUnreadCount }),
    }),
  );
}

async function seeded(): Promise<InMemoryAuthStore> {
  const store = new InMemoryAuthStore();
  await store.createAccount({
    id: 'acc',
    linkingKey: null,
    role: 'basis',
    name: 'Ada',
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    location: null,
    viewKey: 'a'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: null,
    notificationLevel: 'all',
  });
  await store.createSession({ token: 'tok', accountId: 'acc', createdAt: now() });
  return store;
}

async function seededMentions(): Promise<InMemoryAuthStore> {
  const store = await seeded();
  const account = await store.getAccount('acc');
  if (account === undefined) {
    throw new Error('missing seed account');
  }
  await store.updateAccount({ ...account, notificationLevel: 'mentions' });
  return store;
}

function forumNote(partial: Partial<MessageRow> & Pick<MessageRow, 'id'>): MessageRow {
  return {
    accountId: 'actor',
    name: 'Ada',
    text: 'hello',
    createdAt: new Date(now()),
    hasPhoto: false,
    hasVideo: false,
    videoContentType: null,
    ...unsignedNostrDefaults(),
    ...partial,
  };
}

function note(partial: Partial<NotificationRow> & Pick<NotificationRow, 'id'>): NotificationRow {
  return {
    recipientAccountId: 'acc',
    actorAccountId: 'actor',
    type: 'forum_reply',
    parentId: 'parent-note',
    replyId: partial.id,
    name: 'Ada',
    text: 'child',
    createdAt: new Date(now()),
    readAt: null,
    ...partial,
  };
}

describe('GET /notifications', () => {
  it('returns 401 without a session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/notifications');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns public notifications and total unreadCount', async () => {
    const parentId = 'parent-note';
    const messages = new InMemoryMessageStore([
      forumNote({ id: parentId, accountId: 'acc' }),
      forumNote({ id: ID_A, accountId: 'acc', parentId }),
      forumNote({ id: ID_B, accountId: 'acc', parentId }),
      forumNote({ id: ID_READ, accountId: 'acc', parentId }),
    ]);
    const store = new InMemoryNotificationStore([
      note({
        id: ID_A,
        parentId,
        replyId: ID_A,
        text: 'first',
        createdAt: new Date(now() - 1000),
      }),
      note({
        id: ID_B,
        parentId,
        replyId: ID_B,
        text: 'second',
        createdAt: new Date(now()),
      }),
      note({
        id: ID_READ,
        parentId,
        replyId: ID_READ,
        text: 'already-read',
        createdAt: new Date(now() - 500),
        readAt: new Date(now() - 5000),
      }),
      note({
        id: ID_OTHER,
        recipientAccountId: 'other',
        parentId,
        replyId: ID_OTHER,
        text: 'other',
      }),
    ]);
    const res = await mount(await seeded(), store, messages).request('/notifications', {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notifications: Array<Record<string, unknown>>;
      unreadCount: number;
    };
    expect(body.unreadCount).toBe(2);
    expect(body.notifications).toHaveLength(3);
    expect(body.notifications[0]?.['id']).toBe(ID_B);
    for (const item of body.notifications) {
      expect(item).not.toHaveProperty('recipientAccountId');
      expect(item).not.toHaveProperty('actorAccountId');
      expect(item['type']).toBe('forum_reply');
    }
  });

  it('hides old posts at all while retaining explicit mentions on the same post', async () => {
    const messages = new InMemoryMessageStore();
    await messages.create(forumNote({ id: 'parent-note' }));
    const store = new InMemoryNotificationStore([
      note({ id: ID_A, type: 'forum_post', replyId: 'parent-note' }),
      note({ id: ID_B, type: 'forum_mention', replyId: 'parent-note' }),
    ]);
    const res = await mount(await seeded(), store, messages).request('/notifications', {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notifications: NotificationRow[]; unreadCount: number };
    expect(body.notifications.map((item) => item.type)).toEqual(['forum_mention']);
    expect(body.unreadCount).toBe(1);
    expect(await store.unreadCount('acc')).toBe(1);
  });

  it('hides a non-staff unpaid forum_post at mentions and keeps a reply to the owner', async () => {
    const postId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const parentId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const replyNoteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01';
    const messages = new InMemoryMessageStore([
      forumNote({ id: postId, accountId: 'actor', sats: 0 }),
      forumNote({ id: parentId, accountId: 'acc', sats: 0 }),
      forumNote({ id: replyNoteId, accountId: 'actor', parentId, sats: 0 }),
    ]);
    const store = new InMemoryNotificationStore([
      note({
        id: ID_A,
        type: 'forum_post',
        parentId: postId,
        replyId: postId,
        text: 'noise',
      }),
      note({
        id: ID_B,
        type: 'forum_reply',
        parentId,
        replyId: replyNoteId,
        text: 'to me',
      }),
    ]);
    const res = await mount(await seededMentions(), store, messages).request('/notifications', {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notifications: Array<Record<string, unknown>>;
      unreadCount: number;
    };
    expect(body.unreadCount).toBe(1);
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0]?.['id']).toBe(ID_B);
  });

  it('returns 503 when listing throws', async () => {
    const store = new InMemoryNotificationStore();
    store.listByRecipient = async () => {
      throw new Error('boom');
    };
    const res = await mount(await seeded(), store).request('/notifications', { headers: AUTH });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Notifications are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'notifications.list.failed')).toBe(true);
  });

  it('omits rows whose parent or reply is hidden or missing', async () => {
    const parentLive = '11111111-1111-4111-8111-111111111111';
    const replyLive = '22222222-2222-4222-8222-222222222222';
    const parentHidden = '33333333-3333-4333-8333-333333333333';
    const missingId = '55555555-5555-4555-8555-555555555555';
    const appointedId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const appointedAccountId = '99999999-9999-4999-8999-999999999999';
    const messages = new InMemoryMessageStore();
    await messages.create({
      id: parentLive,
      accountId: 'acc',
      name: 'Ada',
      text: 'live parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    await messages.create({
      id: replyLive,
      accountId: 'acc',
      name: 'Ada',
      text: 'live reply',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId: parentLive,
    });
    await messages.create({
      id: parentHidden,
      accountId: 'acc',
      name: 'Ada',
      text: 'hidden parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    expect(await messages.markDeleted(parentHidden, new Date(now()), 'acc')).toBe(true);
    const store = new InMemoryNotificationStore([
      note({
        id: ID_A,
        parentId: parentLive,
        replyId: replyLive,
        text: 'live',
      }),
      note({
        id: ID_B,
        parentId: parentHidden,
        replyId: parentHidden,
        text: 'hidden',
      }),
      note({
        id: ID_READ,
        type: 'forum_post',
        parentId: missingId,
        replyId: missingId,
        text: 'missing',
      }),
      note({
        id: appointedId,
        type: 'moderator_appointed',
        parentId: appointedAccountId,
        replyId: appointedAccountId,
        text: '',
      }),
    ]);
    const res = await mount(await seeded(), store, messages).request('/notifications', {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notifications: Array<Record<string, unknown>>;
      unreadCount: number;
    };
    expect(body.notifications.map((item) => item['id'])).toEqual([appointedId, ID_A]);
    expect(body.notifications[0]?.['type']).toBe('moderator_appointed');
    expect(body.notifications[1]?.['type']).toBe('forum_reply');
    expect(body.unreadCount).toBe(2);
    expect(await store.getByIdForRecipient(ID_B, 'acc')).toBeUndefined();
    expect(await store.getByIdForRecipient(ID_READ, 'acc')).toBeDefined(); // Legacy posts stay stored but hidden.
    expect(await store.getByIdForRecipient(appointedId, 'acc')).toBeDefined();
  });

  it('keeps moderator_appointed when parent and reply are missing', async () => {
    const appointedId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const missingParent = '66666666-6666-4666-8666-666666666666';
    const missingReply = '77777777-7777-4777-8777-777777777777';
    const store = new InMemoryNotificationStore([
      note({
        id: appointedId,
        type: 'moderator_appointed',
        parentId: missingParent,
        replyId: missingReply,
        text: '',
      }),
    ]);
    const res = await mount(await seeded(), store, new InMemoryMessageStore()).request(
      '/notifications',
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notifications: Array<Record<string, unknown>>;
    };
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0]?.['id']).toBe(appointedId);
    expect(body.notifications[0]?.['type']).toBe('moderator_appointed');
  });

  it('keeps moderator_proposal when parent and reply are missing', async () => {
    const proposalId = '10101010-1010-4101-8101-101010101010';
    const accountId = '88888888-8888-4888-8888-888888888888';
    const store = new InMemoryNotificationStore([
      note({
        id: proposalId,
        type: 'moderator_proposal',
        parentId: accountId,
        replyId: accountId,
        text: 'Sub',
      }),
    ]);
    const res = await mount(await seeded(), store, new InMemoryMessageStore()).request(
      '/notifications',
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notifications: Array<Record<string, unknown>>;
    };
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0]?.['id']).toBe(proposalId);
    expect(body.notifications[0]?.['type']).toBe('moderator_proposal');
  });

  it('reuses the message lookup when two live replies share a parent', async () => {
    const parentLive = '11111111-1111-4111-8111-111111111111';
    const replyA = '22222222-2222-4222-8222-222222222222';
    const replyB = '44444444-4444-4444-8444-444444444444';
    const messages = new InMemoryMessageStore();
    let lookups = 0;
    const innerGet = messages.getById.bind(messages);
    messages.getById = async (id) => {
      lookups += 1;
      return innerGet(id);
    };
    await messages.create({
      id: parentLive,
      accountId: 'acc',
      name: 'Ada',
      text: 'live parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    await messages.create({
      id: replyA,
      accountId: 'acc',
      name: 'Ada',
      text: 'a',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId: parentLive,
    });
    await messages.create({
      id: replyB,
      accountId: 'acc',
      name: 'Ada',
      text: 'b',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId: parentLive,
    });
    const store = new InMemoryNotificationStore([
      note({ id: ID_A, parentId: parentLive, replyId: replyA, text: 'a' }),
      note({ id: ID_B, parentId: parentLive, replyId: replyB, text: 'b' }),
    ]);
    const res = await mount(await seeded(), store, messages).request('/notifications', {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(lookups).toBe(3);
  });

  it('falls back to kept unreadCount when hidden purge throws', async () => {
    const parentHidden = '33333333-3333-4333-8333-333333333333';
    const messages = new InMemoryMessageStore();
    await messages.create({
      id: parentHidden,
      accountId: 'acc',
      name: 'Ada',
      text: 'hidden',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    expect(await messages.markDeleted(parentHidden, new Date(now()), 'acc')).toBe(true);
    const store = new InMemoryNotificationStore([
      note({
        id: ID_A,
        parentId: parentHidden,
        replyId: parentHidden,
        text: 'hidden',
      }),
    ]);
    store.deleteByMessageIds = async () => {
      throw new Error('purge boom');
    };
    const res = await mount(await seeded(), store, messages).request('/notifications', {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notifications: Array<Record<string, unknown>>;
      unreadCount: number;
    };
    expect(body.notifications).toEqual([]);
    expect(body.unreadCount).toBe(0);
  });

  it('keeps a zap whose parent note is live even when replyId is not a message id', async () => {
    const parentLive = '11111111-1111-4111-8111-111111111111';
    const receiptReplyId = 'cafef00d-cafe-4f00-8d00-cafef00d0001';
    const messages = new InMemoryMessageStore();
    await messages.create({
      id: parentLive,
      accountId: 'acc',
      name: 'Ada',
      text: 'live parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    const store = new InMemoryNotificationStore([
      note({
        id: ID_A,
        type: 'zap',
        parentId: parentLive,
        replyId: receiptReplyId,
        text: '21',
      }),
    ]);
    const res = await mount(await seeded(), store, messages).request('/notifications', {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notifications: Array<Record<string, unknown>>;
      unreadCount: number;
    };
    expect(body.notifications.map((item) => item['id'])).toEqual([ID_A]);
    expect(body.notifications[0]?.['type']).toBe('zap');
    expect(body.unreadCount).toBe(1);
    expect(await store.getByIdForRecipient(ID_A, 'acc')).toBeDefined();
  });

  it('keeps forum_mention, preserves hidden post rows, and drops duplicate reply rows', async () => {
    const postId = '11111111-1111-4111-8111-111111111111';
    const replyId = '22222222-2222-4222-8222-222222222222';
    const zapReplyId = 'cafef00d-cafe-4f00-8d00-cafef00d0001';
    const messages = new InMemoryMessageStore();
    await messages.create({
      id: postId,
      accountId: 'actor',
      name: 'Ada',
      text: 'post',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    await messages.create({
      id: replyId,
      accountId: 'actor',
      name: 'Ada',
      text: 'reply',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId: postId,
    });
    const store = new InMemoryNotificationStore([
      note({
        id: ID_A,
        type: 'forum_post',
        parentId: postId,
        replyId: postId,
        text: 'posted',
      }),
      note({
        id: ID_B,
        type: 'forum_mention',
        parentId: postId,
        replyId: postId,
        text: 'marked on post',
      }),
      note({
        id: ID_READ,
        type: 'forum_reply',
        parentId: postId,
        replyId,
        text: 'replied',
      }),
      note({
        id: ID_E,
        type: 'forum_mention',
        parentId: postId,
        replyId,
        text: 'marked on reply',
      }),
      note({
        id: ID_F,
        type: 'zap',
        parentId: postId,
        replyId: zapReplyId,
        text: '21',
      }),
      note({
        id: ID_OTHER,
        recipientAccountId: 'other',
        type: 'forum_post',
        parentId: postId,
        replyId: postId,
        text: 'other post',
      }),
    ]);
    const res = await mount(await seeded(), store, messages).request('/notifications', {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notifications: Array<Record<string, unknown>>;
      unreadCount: number;
    };
    expect(body.notifications.map((item) => item['id'])).toEqual([ID_F, ID_E, ID_B]);
    expect(body.notifications.map((item) => item['type'])).toEqual([
      'zap',
      'forum_mention',
      'forum_mention',
    ]);
    expect(body.unreadCount).toBe(3);
    expect(await store.getByIdForRecipient(ID_A, 'acc')).toBeDefined();
    expect(await store.getByIdForRecipient(ID_READ, 'acc')).toBeUndefined();
    expect(await store.getByIdForRecipient(ID_B, 'acc')).toBeDefined();
    expect(await store.getByIdForRecipient(ID_E, 'acc')).toBeDefined();
    expect(await store.getByIdForRecipient(ID_F, 'acc')).toBeDefined();
    expect(await store.getByIdForRecipient(ID_OTHER, 'other')).toBeDefined();
    expect(
      parsedEvents(warn).some(
        (event) => event['event'] === 'notifications.duplicate.purged' && event['count'] === 1,
      ),
    ).toBe(true);
  });

  it('still lists the mention when duplicate purge throws', async () => {
    const postId = '11111111-1111-4111-8111-111111111111';
    const messages = new InMemoryMessageStore();
    await messages.create({
      id: postId,
      accountId: 'actor',
      name: 'Ada',
      text: 'post',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    const store = new InMemoryNotificationStore([
      note({
        id: ID_A,
        type: 'forum_reply',
        parentId: postId,
        replyId: postId,
        text: 'posted',
      }),
      note({
        id: ID_B,
        type: 'forum_mention',
        parentId: postId,
        replyId: postId,
        text: 'marked',
      }),
    ]);
    store.deleteForRecipient = async () => {
      throw new Error('purge boom');
    };
    const res = await mount(await seeded(), store, messages).request('/notifications', {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notifications: Array<Record<string, unknown>>;
      unreadCount: number;
    };
    expect(body.notifications.map((item) => item['id'])).toEqual([ID_B]);
    expect(body.unreadCount).toBe(1);
    expect(await store.getByIdForRecipient(ID_A, 'acc')).toBeDefined();
    expect(
      parsedEvents(warn).some((event) => event['event'] === 'notifications.duplicate.purge_failed'),
    ).toBe(true);
  });

  it('drops a zap when its parent note is hidden', async () => {
    const parentHidden = '33333333-3333-4333-8333-333333333333';
    const receiptReplyId = 'cafef00d-cafe-4f00-8d00-cafef00d0001';
    const messages = new InMemoryMessageStore();
    await messages.create({
      id: parentHidden,
      accountId: 'acc',
      name: 'Ada',
      text: 'hidden',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    expect(await messages.markDeleted(parentHidden, new Date(now()), 'acc')).toBe(true);
    const store = new InMemoryNotificationStore([
      note({
        id: ID_A,
        type: 'zap',
        parentId: parentHidden,
        replyId: receiptReplyId,
        text: '21',
      }),
    ]);
    const res = await mount(await seeded(), store, messages).request('/notifications', {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notifications: Array<Record<string, unknown>>;
    };
    expect(body.notifications).toEqual([]);
    expect(await store.getByIdForRecipient(ID_A, 'acc')).toBeUndefined();
  });

  it('drops a forum_reply when the child is missing and the parent is live', async () => {
    const parentLive = '11111111-1111-4111-8111-111111111111';
    const missingReply = '55555555-5555-4555-8555-555555555555';
    const messages = new InMemoryMessageStore();
    await messages.create({
      id: parentLive,
      accountId: 'acc',
      name: 'Ada',
      text: 'live parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    const store = new InMemoryNotificationStore([
      note({
        id: ID_A,
        type: 'forum_reply',
        parentId: parentLive,
        replyId: missingReply,
        text: 'orphan reply',
      }),
    ]);
    const res = await mount(await seeded(), store, messages).request('/notifications', {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notifications: Array<Record<string, unknown>> };
    expect(body.notifications).toEqual([]);
    expect(await store.getByIdForRecipient(ID_A, 'acc')).toBeUndefined();
  });

  it('drops a forum_reply when the child is hidden and the parent is live', async () => {
    const parentLive = '11111111-1111-4111-8111-111111111111';
    const childHidden = '33333333-3333-4333-8333-333333333333';
    const messages = new InMemoryMessageStore();
    await messages.create({
      id: parentLive,
      accountId: 'acc',
      name: 'Ada',
      text: 'live parent',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
    });
    await messages.create({
      id: childHidden,
      accountId: 'acc',
      name: 'Ada',
      text: 'hidden reply',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      videoContentType: null,
      ...unsignedNostrDefaults(),
      parentId: parentLive,
    });
    expect(await messages.markDeleted(childHidden, new Date(now()), 'acc')).toBe(true);
    const store = new InMemoryNotificationStore([
      note({
        id: ID_A,
        type: 'forum_reply',
        parentId: parentLive,
        replyId: childHidden,
        text: 'about hidden reply',
      }),
    ]);
    const res = await mount(await seeded(), store, messages).request('/notifications', {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notifications: Array<Record<string, unknown>> };
    expect(body.notifications).toEqual([]);
    expect(await store.getByIdForRecipient(ID_A, 'acc')).toBeUndefined();
  });
});

describe('POST /notifications/read-all', () => {
  it('returns 401 without a session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/notifications/read-all', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });

  it('marks every unread notification read', async () => {
    const store = new InMemoryNotificationStore([note({ id: ID_A }), note({ id: ID_B })]);
    const res = await mount(await seeded(), store).request('/notifications/read-all', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      tags: [`forum_reply:${ID_A}`, `forum_reply:${ID_B}`],
    });
    expect(await store.unreadCount('acc')).toBe(0);
  });

  it('leaves moderator_proposal unread when marking all read', async () => {
    const proposalId = '10101010-1010-4101-8101-101010101010';
    const accountId = '88888888-8888-4888-8888-888888888888';
    const store = new InMemoryNotificationStore([
      note({ id: ID_A }),
      note({
        id: proposalId,
        type: 'moderator_proposal',
        parentId: accountId,
        replyId: accountId,
        text: 'Sub',
      }),
    ]);
    const res = await mount(await seeded(), store).request('/notifications/read-all', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, tags: [`forum_reply:${ID_A}`] });
    expect((await store.getByIdForRecipient(ID_A, 'acc'))?.readAt?.toISOString()).toBe(READ_ISO);
    expect((await store.getByIdForRecipient(proposalId, 'acc'))?.readAt).toBeNull();
  });

  it('is 200 not 404 (mount order)', async () => {
    const res = await mount(await seeded()).request('/notifications/read-all', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, tags: [] });
  });

  it('uniques first-seen tags and does not enqueue a second dismiss', async () => {
    const sharedReply = '11111111-1111-4111-8111-111111111111';
    const store = new InMemoryNotificationStore([
      note({ id: ID_A, replyId: sharedReply }),
      note({ id: ID_B, replyId: sharedReply }),
    ]);
    const pushStore = new InMemoryPushStore();
    const app = mount(await seeded(), store, new InMemoryMessageStore(), { pushStore });
    const first = await app.request('/notifications/read-all', {
      method: 'POST',
      headers: AUTH,
    });
    expect(await first.json()).toEqual({ ok: true, tags: [`forum_reply:${sharedReply}`] });
    expect(await pushStore.listAllOutbox(10)).toHaveLength(1);

    const second = await app.request('/notifications/read-all', {
      method: 'POST',
      headers: AUTH,
    });
    expect(await second.json()).toEqual({ ok: true, tags: [] });
    expect(await pushStore.listAllOutbox(10)).toHaveLength(1);
  });

  it('skips only an endpoint subscribed by the account and never echoes it', async () => {
    const pushStore = new InMemoryPushStore();
    const endpoint = 'https://push.example/current';
    await pushStore.upsertSubscription({
      endpoint,
      accountId: 'acc',
      p256dh: 'p',
      auth: 'a',
      createdAt: new Date(now()),
    });
    const store = new InMemoryNotificationStore([note({ id: ID_A })]);
    const res = await mount(await seeded(), store, new InMemoryMessageStore(), {
      pushStore,
    }).request('/notifications/read-all', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    });
    expect(await res.json()).toEqual({ ok: true, tags: [`forum_reply:${ID_A}`] });
    expect((await pushStore.listAllOutbox(10))[0]?.skipEndpoints).toEqual([endpoint]);
  });

  it.each([
    { name: 'missing JSON', request: {} },
    {
      name: 'array body',
      request: { headers: { 'content-type': 'application/json' }, body: '[]' },
    },
    {
      name: 'numeric endpoint',
      request: {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: 1 }),
      },
    },
    {
      name: 'empty endpoint',
      request: {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: '' }),
      },
    },
    {
      name: 'unowned endpoint',
      request: {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: 'https://push.example/unowned' }),
      },
    },
  ])('accepts $name and does not skip an endpoint', async ({ request }) => {
    const pushStore = new InMemoryPushStore();
    const store = new InMemoryNotificationStore([note({ id: ID_A })]);
    const res = await mount(await seeded(), store, new InMemoryMessageStore(), {
      pushStore,
    }).request('/notifications/read-all', {
      method: 'POST',
      headers: { ...AUTH, ...request.headers },
      ...('body' in request ? { body: request.body } : {}),
    });
    expect(res.status).toBe(200);
    expect((await pushStore.listAllOutbox(10))[0]?.skipEndpoints).toEqual([]);
  });

  it('adds inbox unread to the dismiss badge', async () => {
    const proposalId = '10101010-1010-4101-8101-101010101010';
    const pushStore = new InMemoryPushStore();
    const store = new InMemoryNotificationStore([
      note({ id: ID_A }),
      note({
        id: proposalId,
        type: 'moderator_proposal',
        parentId: ID_OTHER,
        replyId: ID_OTHER,
      }),
    ]);
    const res = await mount(await seeded(), store, new InMemoryMessageStore(), {
      pushStore,
      inboxUnreadCount: async () => 3,
    }).request('/notifications/read-all', { method: 'POST', headers: AUTH });
    expect(res.status).toBe(200);
    const payload = JSON.parse((await pushStore.listAllOutbox(1))[0]?.payload ?? '{}') as Record<
      string,
      unknown
    >;
    expect(payload['unreadCount']).toBe(4);
  });

  it('keeps notification unread count when inbox unread fails', async () => {
    const proposalId = '10101010-1010-4101-8101-101010101010';
    const pushStore = new InMemoryPushStore();
    const store = new InMemoryNotificationStore([
      note({ id: ID_A }),
      note({
        id: proposalId,
        type: 'moderator_proposal',
        parentId: ID_OTHER,
        replyId: ID_OTHER,
      }),
    ]);
    const res = await mount(await seeded(), store, new InMemoryMessageStore(), {
      pushStore,
      inboxUnreadCount: async () => {
        throw new Error('inbox boom');
      },
    }).request('/notifications/read-all', { method: 'POST', headers: AUTH });
    expect(res.status).toBe(200);
    const payload = JSON.parse((await pushStore.listAllOutbox(1))[0]?.payload ?? '{}') as Record<
      string,
      unknown
    >;
    expect(payload['unreadCount']).toBe(1);
    expect(parsedEvents(warn).some((event) => event['event'] === 'push.dismiss.failed')).toBe(true);
  });

  it('keeps 200 when dismiss dependency lookup or enqueue fails', async () => {
    const listStore = new InMemoryNotificationStore([note({ id: ID_A })]);
    const listPushStore = new InMemoryPushStore();
    listPushStore.listByAccount = async () => {
      throw new Error('list boom');
    };
    const listRes = await mount(await seeded(), listStore, new InMemoryMessageStore(), {
      pushStore: listPushStore,
    }).request('/notifications/read-all', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://push.example/current' }),
    });
    expect(listRes.status).toBe(200);
    expect(await listPushStore.listAllOutbox(10)).toEqual([]);

    const unreadStore = new InMemoryNotificationStore([note({ id: ID_B })]);
    unreadStore.unreadCount = async () => {
      throw new Error('unread boom');
    };
    const unreadPushStore = new InMemoryPushStore();
    const unreadRes = await mount(await seeded(), unreadStore, new InMemoryMessageStore(), {
      pushStore: unreadPushStore,
    }).request('/notifications/read-all', { method: 'POST', headers: AUTH });
    expect(unreadRes.status).toBe(200);
    expect(await unreadPushStore.listAllOutbox(10)).toEqual([]);

    const enqueueStore = new InMemoryNotificationStore([note({ id: ID_READ })]);
    const enqueuePushStore = new InMemoryPushStore();
    enqueuePushStore.enqueue = async () => {
      throw new Error('enqueue boom');
    };
    const enqueueRes = await mount(await seeded(), enqueueStore, new InMemoryMessageStore(), {
      pushStore: enqueuePushStore,
    }).request('/notifications/read-all', { method: 'POST', headers: AUTH });
    expect(enqueueRes.status).toBe(200);
    expect(await enqueuePushStore.listAllOutbox(10)).toEqual([]);
    expect(
      parsedEvents(warn).filter((event) => event['event'] === 'push.dismiss.failed').length,
    ).toBe(3);
  });

  it('returns 503 when markAllRead throws', async () => {
    const store = new InMemoryNotificationStore();
    store.markAllRead = async () => {
      throw new Error('boom');
    };
    const res = await mount(await seeded(), store).request('/notifications/read-all', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Notifications are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'notifications.read_all.failed')).toBe(
      true,
    );
  });
});

describe('POST /notifications/read-by-message', () => {
  const messageId = '11111111-1111-4111-8111-111111111111';

  it('returns 401 without a session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/notifications/read-by-message', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it.each([
    { name: 'missing JSON', body: undefined },
    { name: 'null', body: 'null' },
    { name: 'array', body: '[]' },
    { name: 'string', body: '"message"' },
    { name: 'missing messageId', body: '{}' },
    { name: 'invalid messageId', body: '{"messageId":"not-a-uuid"}' },
  ])('returns 404 for $name', async ({ body }) => {
    const res = await mount(await seeded()).request('/notifications/read-by-message', {
      method: 'POST',
      headers: {
        ...AUTH,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('stamps matching kinds in id order, dismisses once, and leaves excluded rows unread', async () => {
    const replyId = '22222222-2222-4222-8222-222222222222';
    const receiptId = '44444444-4444-4444-8444-444444444444';
    const store = new InMemoryNotificationStore([
      note({ id: ID_F, type: 'moderator_proposal', parentId: messageId, replyId: ID_F }),
      note({ id: ID_E, type: 'moderator_appointed', parentId: messageId, replyId: ID_E }),
      note({ id: ID_OTHER, type: 'zap', parentId: messageId, replyId: receiptId }),
      note({ id: ID_READ, type: 'forum_mention', parentId: ID_OTHER, replyId: messageId }),
      note({ id: ID_B, type: 'forum_reply', parentId: messageId, replyId }),
      note({ id: ID_A, type: 'forum_post', parentId: messageId, replyId: messageId }),
      note({
        id: '99999999-9999-4999-8999-999999999999',
        recipientAccountId: 'other',
        parentId: messageId,
      }),
    ]);
    const pushStore = new InMemoryPushStore();
    const app = mount(await seeded(), store, new InMemoryMessageStore(), { pushStore });
    const request = {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ messageId }),
    };
    const first = await app.request('/notifications/read-by-message', request);
    expect(first.status).toBe(200);
    const tags = [
      `forum_post:${messageId}`,
      `forum_reply:${replyId}`,
      `forum_mention:${messageId}`,
      `zap:${receiptId}`,
    ];
    expect(await first.json()).toEqual({ ok: true, tags });
    expect((await store.getByIdForRecipient(ID_E, 'acc'))?.readAt).toBeNull();
    expect((await store.getByIdForRecipient(ID_F, 'acc'))?.readAt).toBeNull();
    expect(
      (await store.getByIdForRecipient('99999999-9999-4999-8999-999999999999', 'other'))?.readAt,
    ).toBeNull();
    expect(await pushStore.listAllOutbox(10)).toHaveLength(1);
    expect(JSON.parse((await pushStore.listAllOutbox(1))[0]?.payload ?? '{}')).toMatchObject({
      type: 'dismiss',
      tags,
    });

    const firstReadAt = (await store.getByIdForRecipient(ID_A, 'acc'))?.readAt;
    const second = await app.request('/notifications/read-by-message', request);
    expect(await second.json()).toEqual({ ok: true, tags: [] });
    expect((await store.getByIdForRecipient(ID_A, 'acc'))?.readAt).toEqual(firstReadAt);
    expect(await pushStore.listAllOutbox(10)).toHaveLength(1);

    const readAll = await app.request('/notifications/read-all', { method: 'POST', headers: AUTH });
    expect(await readAll.json()).toEqual({
      ok: true,
      tags: [`moderator_appointed:${messageId}`],
    });
    expect((await store.getByIdForRecipient(ID_E, 'acc'))?.readAt?.toISOString()).toBe(READ_ISO);
    expect((await store.getByIdForRecipient(ID_F, 'acc'))?.readAt).toBeNull();
  });

  it('returns 503 and logs when the store throws', async () => {
    const store = new InMemoryNotificationStore();
    store.markReadByMessage = async () => {
      throw new Error('boom');
    };
    const res = await mount(await seeded(), store).request('/notifications/read-by-message', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Notifications are unavailable' });
    expect(
      parsedEvents(warn).some((event) => event['event'] === 'notifications.read_message.failed'),
    ).toBe(true);
  });
});

describe('POST /notifications/:id/read', () => {
  it('returns 401 without a session', async () => {
    const res = await mount(new InMemoryAuthStore()).request(`/notifications/${ID_A}/read`, {
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });

  it('sets readAt and is idempotent', async () => {
    const store = new InMemoryNotificationStore([note({ id: ID_A })]);
    let clock = now();
    const app = mount(await seeded(), store, new InMemoryMessageStore(), {
      now: () => clock,
    });
    const first = await app.request(`/notifications/${ID_A}/read`, {
      method: 'POST',
      headers: AUTH,
    });
    expect(first.status).toBe(200);
    const body = (await first.json()) as { readAt: string };
    expect(body.readAt).toBe(READ_ISO);
    clock += 1;
    const second = await app.request(`/notifications/${ID_A}/read`, {
      method: 'POST',
      headers: AUTH,
    });
    expect(second.status).toBe(200);
    expect((await second.json()) as { readAt: string }).toEqual({ ...body });
  });

  it('returns 200 with readAt still null for a moderator_proposal', async () => {
    const proposalId = '10101010-1010-4101-8101-101010101010';
    const accountId = '88888888-8888-4888-8888-888888888888';
    const store = new InMemoryNotificationStore([
      note({
        id: proposalId,
        type: 'moderator_proposal',
        parentId: accountId,
        replyId: accountId,
        text: 'Sub',
      }),
    ]);
    const res = await mount(await seeded(), store).request(`/notifications/${proposalId}/read`, {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { readAt: string | null };
    expect(body.readAt).toBeNull();
    expect((await store.getByIdForRecipient(proposalId, 'acc'))?.readAt).toBeNull();
  });

  it('returns 404 for unknown, other-account, and non-uuid ids', async () => {
    const store = new InMemoryNotificationStore([
      note({ id: ID_A }),
      note({ id: ID_OTHER, recipientAccountId: 'other' }),
    ]);
    const app = mount(await seeded(), store);
    const missing = await app.request('/notifications/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/read', {
      method: 'POST',
      headers: AUTH,
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Not found' });
    const other = await app.request(`/notifications/${ID_OTHER}/read`, {
      method: 'POST',
      headers: AUTH,
    });
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ error: 'Not found' });
    const bad = await app.request('/notifications/not-a-uuid/read', {
      method: 'POST',
      headers: AUTH,
    });
    expect(bad.status).toBe(404);
    expect(await bad.json()).toEqual({ error: 'Not found' });
  });

  it('returns 503 when markRead throws', async () => {
    const store = new InMemoryNotificationStore();
    store.markRead = async () => {
      throw new Error('boom');
    };
    const res = await mount(await seeded(), store).request(`/notifications/${ID_A}/read`, {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Notifications are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'notifications.read.failed')).toBe(true);
  });

  it('dismisses a freshly stamped row once and keeps the serialized body', async () => {
    const store = new InMemoryNotificationStore([note({ id: ID_A })]);
    const pushStore = new InMemoryPushStore();
    const clock = now();
    const app = mount(await seeded(), store, new InMemoryMessageStore(), {
      now: () => clock,
      pushStore,
    });
    const first = await app.request(`/notifications/${ID_A}/read`, {
      method: 'POST',
      headers: AUTH,
    });
    expect(first.status).toBe(200);
    const body = (await first.json()) as { id: string; readAt: string };
    expect(body.id).toBe(ID_A);
    expect(body.readAt).toBe(READ_ISO);
    expect(body).not.toHaveProperty('ok');
    expect(body).not.toHaveProperty('tags');
    const outbox = await pushStore.listAllOutbox(10);
    expect(outbox).toHaveLength(1);
    const payload = JSON.parse(outbox[0]?.payload ?? '{}') as Record<string, unknown>;
    expect(payload).toEqual({
      type: 'dismiss',
      tags: [`forum_reply:${ID_A}`],
      unreadCount: 0,
    });
    expect(payload).not.toHaveProperty('endpoint');
    const second = await app.request(`/notifications/${ID_A}/read`, {
      method: 'POST',
      headers: AUTH,
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { readAt: string }).readAt).toBe(READ_ISO);
    expect(await pushStore.listAllOutbox(10)).toHaveLength(1);
  });

  it('does not dismiss a moderator_proposal', async () => {
    const proposalId = '10101010-1010-4101-8101-101010101010';
    const accountId = '88888888-8888-4888-8888-888888888888';
    const store = new InMemoryNotificationStore([
      note({
        id: proposalId,
        type: 'moderator_proposal',
        parentId: accountId,
        replyId: accountId,
        text: 'Sub',
      }),
    ]);
    const pushStore = new InMemoryPushStore();
    const res = await mount(await seeded(), store, new InMemoryMessageStore(), {
      pushStore,
    }).request(`/notifications/${proposalId}/read`, {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { readAt: string | null }).readAt).toBeNull();
    expect(await pushStore.listAllOutbox(10)).toEqual([]);
  });

  it('does not dismiss a proposal whose returned readAt equals the clock', async () => {
    const store = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    store.markRead = async () => ({
      row: note({
        id: ID_A,
        type: 'moderator_proposal',
        readAt: new Date(now()),
      }),
      stamped: false,
    });
    const res = await mount(await seeded(), store, new InMemoryMessageStore(), {
      pushStore,
    }).request(`/notifications/${ID_A}/read`, {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await pushStore.listAllOutbox(10)).toEqual([]);
  });

  it('does not dismiss an already-read forum row when readAt equals the clock', async () => {
    const store = new InMemoryNotificationStore();
    const pushStore = new InMemoryPushStore();
    const readAt = new Date(now());
    const forum = note({ id: ID_A, type: 'forum_reply', readAt });
    store.markRead = async () => ({ row: forum, stamped: false });
    const res = await mount(await seeded(), store, new InMemoryMessageStore(), {
      pushStore,
    }).request(`/notifications/${ID_A}/read`, {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      type: string;
      parentId: string;
      replyId: string;
      name: string;
      text: string;
      createdAt: string;
      readAt: string | null;
    };
    expect(body).toEqual({
      id: forum.id,
      type: forum.type,
      parentId: forum.parentId,
      replyId: forum.replyId,
      name: forum.name,
      text: forum.text,
      createdAt: forum.createdAt.toISOString(),
      readAt: readAt.toISOString(),
    });
    expect(await pushStore.listAllOutbox(10)).toEqual([]);
  });
});
