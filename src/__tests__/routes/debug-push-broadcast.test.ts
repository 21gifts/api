import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore, type NotificationLevel } from '@/lib/auth/store';
import { InMemoryPushStore } from '@/lib/push-store';
import { debugPushBroadcastRoutes } from '@/routes/debug-push-broadcast';

const { logEvent } = vi.hoisted(() => ({ logEvent: vi.fn() }));
vi.mock('@/lib/log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/log')>()),
  logEvent,
}));

const now = (): number => 1_700_000_000_000;
const AUTH = { authorization: 'Bearer secret', 'content-type': 'application/json' };

function mount(args: {
  authStore: InMemoryAuthStore;
  pushStore: InMemoryPushStore;
  debugToken?: string;
  vapidPublicKey?: string | undefined;
}): Hono {
  return new Hono().route(
    '/debug/push-broadcast',
    debugPushBroadcastRoutes({
      authStore: args.authStore,
      pushStore: args.pushStore,
      now,
      debugToken: args.debugToken ?? 'secret',
      vapidPublicKey: 'vapidPublicKey' in args ? args.vapidPublicKey : 'vapid',
    }),
  );
}

async function addAccount(
  authStore: InMemoryAuthStore,
  pushStore: InMemoryPushStore,
  args: { n: number; username: string; level?: NotificationLevel; subscribed: boolean },
): Promise<string> {
  const id = `00000000-0000-4000-8000-00000000000${args.n}`;
  await authStore.createAccount({
    id,
    linkingKey: `02${String(args.n).repeat(64)}`,
    role: 'basis',
    name: `Member ${args.n}`,
    username: args.username,
    ...(args.level === undefined ? {} : { notificationLevel: args.level }),
    forumLawsDismissed: false,
    location: null,
    viewKey: String(args.n).repeat(64),
    createdAt: 1_000_000,
    rulesAgreedAt: null,
  });
  if (args.subscribed) {
    await pushStore.upsertSubscription({
      endpoint: `https://push.example/${args.n}`,
      accountId: id,
      p256dh: 'p',
      auth: 'a',
      createdAt: new Date(1_000_000),
      sessionToken: null,
    });
  }
  return id;
}

/** Four accounts: two subscribed, one subscribed but opted out, one without subscription. */
async function seeded(): Promise<{
  authStore: InMemoryAuthStore;
  pushStore: InMemoryPushStore;
  ids: string[];
}> {
  const authStore = new InMemoryAuthStore();
  const pushStore = new InMemoryPushStore();
  const ids = [
    await addAccount(authStore, pushStore, { n: 1, username: 'alpha', subscribed: true }),
    await addAccount(authStore, pushStore, {
      n: 2,
      username: 'bravo',
      level: 'mentions',
      subscribed: true,
    }),
    await addAccount(authStore, pushStore, {
      n: 3,
      username: 'charlie',
      level: 'none',
      subscribed: true,
    }),
    await addAccount(authStore, pushStore, { n: 4, username: 'delta', subscribed: false }),
  ];
  return { authStore, pushStore, ids };
}

function post(app: Hono, body: unknown, headers: Record<string, string> = AUTH): Promise<Response> {
  return Promise.resolve(
    app.request('/debug/push-broadcast', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

describe('debug push broadcast auth', () => {
  it('returns 503 before JSON when debug is not configured', async () => {
    const { authStore, pushStore } = await seeded();
    const res = await post(mount({ authStore, pushStore, debugToken: ' ' }), 'not-json');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Debug is not configured' });
  });

  it('returns 401 for a wrong token on POST and GET', async () => {
    const { authStore, pushStore } = await seeded();
    const app = mount({ authStore, pushStore });
    const headers = { authorization: 'Bearer wrong' };
    expect((await post(app, 'not-json', headers)).status).toBe(401);
    const res = await app.request('/debug/push-broadcast/x', { headers });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });
});

describe('POST /debug/push-broadcast', () => {
  beforeEach(() => {
    logEvent.mockReset();
  });

  it('queues one outbox row per subscribed account that has not opted out', async () => {
    const { authStore, pushStore, ids } = await seeded();
    const res = await post(mount({ authStore, pushStore }), {
      title: '  Update  ',
      body: 'Line one\nline two',
      link: '/messages?tab=new',
    });
    expect(res.status).toBe(202);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      targeted: 3,
      queued: 2,
      optedOut: 1,
      noSubscription: 0,
    });
    const rows = await pushStore.claimPending(10, now(), 1000);
    expect(rows.map((row) => row.accountId).sort()).toEqual([ids[0], ids[1]]);
    for (const row of rows) {
      expect(row.messageId).toBe(json['id']);
      expect(JSON.parse(row.payload)).toEqual({
        type: 'zap',
        title: 'Update',
        body: 'Line one\nline two',
        url: '/messages?tab=new',
        tag: `broadcast:${String(json['id'])}`,
      });
    }
    expect(logEvent).toHaveBeenCalledWith('debug.push.broadcast', {
      id: json['id'],
      targeted: 3,
      queued: 2,
      optedOut: 1,
      noSubscription: 0,
    });
  });

  it('queues only listed usernames, skipping opt-outs and accounts without a subscription', async () => {
    const { authStore, pushStore, ids } = await seeded();
    const res = await post(mount({ authStore, pushStore }), {
      title: 'Hi',
      body: 'Hello',
      usernames: [' Alpha ', 'alpha', 'charlie', 'delta'],
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      targeted: 3,
      queued: 1,
      optedOut: 1,
      noSubscription: 1,
    });
    const rows = await pushStore.claimPending(10, now(), 1000);
    expect(rows.map((row) => row.accountId)).toEqual([ids[0]]);
    expect(JSON.parse(rows[0]?.payload ?? '{}')).toMatchObject({ url: '/welcome' });
  });

  it('dry run returns the recipient count and queues nothing, even without VAPID', async () => {
    const { authStore, pushStore } = await seeded();
    const app = mount({ authStore, pushStore, vapidPublicKey: undefined });
    const all = await post(app, { title: 'Hi', body: 'Hello', dryRun: true });
    expect(all.status).toBe(200);
    expect(await all.json()).toEqual({ dryRun: true, recipients: 2 });
    const listed = await post(app, {
      title: 'Hi',
      body: 'Hello',
      usernames: ['bravo', 'charlie'],
      dryRun: true,
    });
    expect(await listed.json()).toEqual({ dryRun: true, recipients: 1 });
    expect(await pushStore.listAllOutbox(10)).toEqual([]);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it('returns 503 when push is not configured and the body is not a dry run', async () => {
    const { authStore, pushStore } = await seeded();
    const res = await post(mount({ authStore, pushStore, vapidPublicKey: ' ' }), {
      title: 'Hi',
      body: 'Hello',
      dryRun: false,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Push is not configured' });
    expect(await pushStore.listAllOutbox(10)).toEqual([]);
  });

  it('returns 400 for unknown usernames and queues nothing', async () => {
    const { authStore, pushStore } = await seeded();
    const res = await post(mount({ authStore, pushStore }), {
      title: 'Hi',
      body: 'Hello',
      usernames: ['alpha', 'zulu', 'Yankee'],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unknown usernames', usernames: ['zulu', 'yankee'] });
    expect(await pushStore.listAllOutbox(10)).toEqual([]);
  });

  it.each([
    ['not JSON', 'not-json'],
    ['a missing title', { body: 'Hello' }],
    ['a blank title', { title: '   ', body: 'Hello' }],
    ['a title over 64 characters', { title: 'x'.repeat(65), body: 'Hello' }],
    ['a newline in the title', { title: 'a\nb', body: 'Hello' }],
    ['a missing body', { title: 'Hi' }],
    ['a body over 240 characters', { title: 'Hi', body: 'x'.repeat(241) }],
    ['a control character in the body', { title: 'Hi', body: 'a\u0007b' }],
    ['DEL in the body', { title: 'Hi', body: 'a\u007fb' }],
    ['an absolute link', { title: 'Hi', body: 'Hello', link: 'https://example.com/' }],
    ['a protocol-relative link', { title: 'Hi', body: 'Hello', link: '//example.com/' }],
    ['a backslash link', { title: 'Hi', body: 'Hello', link: '/\\example.com' }],
    ['a link with whitespace', { title: 'Hi', body: 'Hello', link: '/a b' }],
    ['a link with a control character', { title: 'Hi', body: 'Hello', link: '/a\u0001b' }],
    ['a relative link', { title: 'Hi', body: 'Hello', link: 'messages' }],
    ['a link over 200 characters', { title: 'Hi', body: 'Hello', link: `/${'a'.repeat(200)}` }],
    ['an empty usernames list', { title: 'Hi', body: 'Hello', usernames: [] }],
    [
      'more than 200 usernames',
      { title: 'Hi', body: 'Hello', usernames: Array.from({ length: 201 }, () => 'alpha') },
    ],
    ['a username that is not a string', { title: 'Hi', body: 'Hello', usernames: [1] }],
    ['an invalid username', { title: 'Hi', body: 'Hello', usernames: ['no spaces'] }],
    ['a dryRun that is not a boolean', { title: 'Hi', body: 'Hello', dryRun: 'yes' }],
    ['an unknown key', { title: 'Hi', body: 'Hello', accountIds: [] }],
  ])('returns 400 for %s', async (_label, body) => {
    const { authStore, pushStore } = await seeded();
    const res = await post(mount({ authStore, pushStore }), body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^Expected a JSON body/);
    expect(await pushStore.listAllOutbox(10)).toEqual([]);
  });

  it('counts the length limits in characters, not UTF-16 units', async () => {
    const { authStore, pushStore } = await seeded();
    const app = mount({ authStore, pushStore });
    const ok = await post(app, {
      title: '🎁'.repeat(64),
      body: '⚡️🎁'.repeat(80),
      link: `/${'é'.repeat(199)}`,
      dryRun: true,
    });
    expect(ok.status).toBe(200);
    for (const body of [
      { title: '🎁'.repeat(65), body: 'Hello' },
      { title: 'Hi', body: '🎁'.repeat(241) },
      { title: 'Hi', body: 'Hello', link: `/${'é'.repeat(200)}` },
    ]) {
      expect((await post(app, { ...body, dryRun: true })).status).toBe(400);
    }
  });

  it('accepts the length limits exactly', async () => {
    const { authStore, pushStore } = await seeded();
    const res = await post(mount({ authStore, pushStore }), {
      title: 'x'.repeat(64),
      body: 'y'.repeat(240),
      link: `/${'a'.repeat(199)}`,
    });
    expect(res.status).toBe(202);
  });
});

describe('GET /debug/push-broadcast/:id', () => {
  it('reports the delivery counts of a broadcast', async () => {
    const { authStore, pushStore } = await seeded();
    const app = mount({ authStore, pushStore });
    const sent = (await (await post(app, { title: 'Hi', body: 'Hello' })).json()) as {
      id: string;
    };
    const [first] = await pushStore.claimPending(1, now(), 1000);
    await pushStore.recordDelivered(first?.id ?? '', ['https://push.example/1']);
    await pushStore.markSent(first?.id ?? '', now());
    const res = await app.request(`/debug/push-broadcast/${sent.id.toUpperCase()}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: sent.id,
      queued: 2,
      pending: 1,
      delivered: 1,
      dropped: 0,
      failed: 0,
    });
  });

  it('returns 404 for a malformed or unknown id', async () => {
    const { authStore, pushStore } = await seeded();
    const app = mount({ authStore, pushStore });
    for (const id of ['not-a-uuid', '0b6c3f4e-2a1d-4c5b-9e8f-7a6b5c4d3e2f']) {
      const res = await app.request(`/debug/push-broadcast/${id}`, { headers: AUTH });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    }
  });
});
