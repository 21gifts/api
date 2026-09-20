import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { unsignedNostrDefaults, type MessageRow } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import type { NotificationRow } from '@/lib/notification';
import { InMemoryNotificationStore } from '@/lib/notification-store';
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
const READ_ISO = new Date(now()).toISOString();

function mount(
  authStore: InMemoryAuthStore,
  store = new InMemoryNotificationStore(),
  messages: InMemoryMessageStore = new InMemoryMessageStore(),
): Hono {
  return new Hono().route(
    '/notifications',
    notificationRoutes({ store, authStore, messages, now }),
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
    expect(await store.getByIdForRecipient(ID_READ, 'acc')).toBeUndefined();
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
    expect(await res.json()).toEqual({ ok: true });
    expect(await store.unreadCount('acc')).toBe(0);
  });

  it('is 200 not 404 (mount order)', async () => {
    const res = await mount(await seeded()).request('/notifications/read-all', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
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

describe('POST /notifications/:id/read', () => {
  it('returns 401 without a session', async () => {
    const res = await mount(new InMemoryAuthStore()).request(`/notifications/${ID_A}/read`, {
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });

  it('sets readAt and is idempotent', async () => {
    const store = new InMemoryNotificationStore([note({ id: ID_A })]);
    const app = mount(await seeded(), store);
    const first = await app.request(`/notifications/${ID_A}/read`, {
      method: 'POST',
      headers: AUTH,
    });
    expect(first.status).toBe(200);
    const body = (await first.json()) as { readAt: string };
    expect(body.readAt).toBe(READ_ISO);
    const second = await app.request(`/notifications/${ID_A}/read`, {
      method: 'POST',
      headers: AUTH,
    });
    expect(second.status).toBe(200);
    expect((await second.json()) as { readAt: string }).toEqual({ ...body });
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
});
