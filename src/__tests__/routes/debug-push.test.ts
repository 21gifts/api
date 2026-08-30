import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { InMemoryPushStore } from '@/lib/push-store';
import { debugPushRoutes } from '@/routes/debug-push';

const now = (): number => 1_700_000_000_000;
const LINKING_KEY = `02${'a'.repeat(64)}`;

function mount(args: {
  authStore?: InMemoryAuthStore;
  pushStore?: InMemoryPushStore;
  debugToken?: string | undefined;
  vapidPublicKey?: string | undefined;
}): Hono {
  return new Hono().route(
    '/debug/push-ping',
    debugPushRoutes({
      authStore: args.authStore ?? new InMemoryAuthStore(),
      pushStore: args.pushStore ?? new InMemoryPushStore(),
      now,
      debugToken: args.debugToken,
      vapidPublicKey: args.vapidPublicKey,
    }),
  );
}

async function seededStore(): Promise<InMemoryAuthStore> {
  const store = new InMemoryAuthStore();
  await store.createAccount({
    id: 'acc',
    linkingKey: LINKING_KEY,
    role: 'basis',
    name: 'Ada',
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    viewKey: 'a'.repeat(64),
    createdAt: 1_000_000,
    rulesAgreedAt: null,
  });
  return store;
}

describe('POST /debug/push-ping', () => {
  it('returns 503 before JSON when debug is not configured', async () => {
    const res = await mount({ debugToken: '' }).request('/debug/push-ping', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Debug is not configured' });
  });

  it('returns 401 before JSON when the debug token is wrong', async () => {
    const res = await mount({ debugToken: 'secret' }).request('/debug/push-ping', {
      method: 'POST',
      headers: {
        authorization: 'Bearer wrong',
        'content-type': 'application/json',
      },
      body: 'not-json',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 503 when push is not configured', async () => {
    const res = await mount({
      debugToken: 'secret',
      vapidPublicKey: undefined,
    }).request('/debug/push-ping', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ accountId: 'acc' }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Push is not configured' });
  });

  it('returns 400 when accountId is missing', async () => {
    const res = await mount({
      debugToken: 'secret',
      vapidPublicKey: 'pub',
    }).request('/debug/push-ping', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with an "accountId" string',
    });
  });

  it('returns 404 for an unknown account', async () => {
    const res = await mount({
      debugToken: 'secret',
      vapidPublicKey: 'pub',
    }).request('/debug/push-ping', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ accountId: 'missing' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns enqueued 0 or 1', async () => {
    const auth = await seededStore();
    const pushStore = new InMemoryPushStore();
    const none = await mount({
      authStore: auth,
      pushStore,
      debugToken: 'secret',
      vapidPublicKey: 'pub',
    }).request('/debug/push-ping', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ accountId: 'acc' }),
    });
    expect(none.status).toBe(200);
    expect(await none.json()).toEqual({ enqueued: 0 });

    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/a',
      accountId: 'acc',
      p256dh: 'p',
      auth: 'a',
      createdAt: new Date(now()),
    });
    const one = await mount({
      authStore: auth,
      pushStore,
      debugToken: 'secret',
      vapidPublicKey: 'pub',
    }).request('/debug/push-ping', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ accountId: 'acc' }),
    });
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual({ enqueued: 1 });
  });
});
