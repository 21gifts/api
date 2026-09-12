import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
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

function mount(authStore: InMemoryAuthStore, store = new InMemoryNotificationStore()): Hono {
  return new Hono().route('/notifications', notificationRoutes({ store, authStore, now }));
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
    viewKey: 'a'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: null,
  });
  await store.createSession({ token: 'tok', accountId: 'acc', createdAt: now() });
  return store;
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
    const store = new InMemoryNotificationStore([
      note({
        id: ID_A,
        text: 'first',
        createdAt: new Date(now() - 1000),
      }),
      note({
        id: ID_B,
        text: 'second',
        createdAt: new Date(now()),
      }),
      note({
        id: ID_READ,
        text: 'already-read',
        createdAt: new Date(now() - 500),
        readAt: new Date(now() - 5000),
      }),
      note({
        id: ID_OTHER,
        recipientAccountId: 'other',
        text: 'other',
      }),
    ]);
    const res = await mount(await seeded(), store).request('/notifications', { headers: AUTH });
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
