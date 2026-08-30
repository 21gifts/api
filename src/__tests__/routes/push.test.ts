import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { InMemoryPushStore } from '@/lib/push-store';
import { pushRoutes } from '@/routes/push';

const now = (): number => 1_700_000_000_000;
const AUTH = { authorization: 'Bearer tok' };
const LINKING_KEY = `02${'a'.repeat(64)}`;

function mount(
  authStore: InMemoryAuthStore,
  pushStore: InMemoryPushStore = new InMemoryPushStore(),
  vapidPublicKey: string | undefined = 'vapid-pub',
): Hono {
  return new Hono().route(
    '/',
    pushRoutes({
      authStore,
      pushStore,
      now,
      vapidPublicKey,
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
  await store.createSession({ token: 'tok', accountId: 'acc', createdAt: now() });
  return store;
}

const validBody = {
  endpoint: 'https://push.example/sub',
  keys: { p256dh: 'abcABC123_-', auth: 'xyzXYZ789_-' },
};

describe('GET /push/vapid-public', () => {
  it('returns 401 without bearer even when unconfigured', async () => {
    const res = await mount(new InMemoryAuthStore(), new InMemoryPushStore(), undefined).request(
      '/push/vapid-public',
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 503 when push is not configured', async () => {
    const auth = await seededStore();
    const res = await mount(auth, new InMemoryPushStore(), '  ').request('/push/vapid-public', {
      headers: AUTH,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Push is not configured' });
  });

  it('returns the public key when configured', async () => {
    const auth = await seededStore();
    const res = await mount(auth).request('/push/vapid-public', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ publicKey: 'vapid-pub' });
  });
});

describe('POST /me/push-subscriptions', () => {
  it('returns 401 / 503 / 400 / 200', async () => {
    expect(
      (
        await mount(new InMemoryAuthStore()).request('/me/push-subscriptions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(validBody),
        })
      ).status,
    ).toBe(401);

    const auth = await seededStore();
    const unconfigured = await mount(auth, new InMemoryPushStore(), undefined).request(
      '/me/push-subscriptions',
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify(validBody),
      },
    );
    expect(unconfigured.status).toBe(503);

    const bad = await mount(auth).request('/me/push-subscriptions', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'http://evil.test/p', keys: validBody.keys }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Invalid subscription' });

    const pushStore = new InMemoryPushStore();
    const ok = await mount(auth, pushStore).request('/me/push-subscriptions', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      endpoint: validBody.endpoint,
      createdAt: new Date(now()).toISOString(),
    });
    expect(await pushStore.listByAccount('acc')).toHaveLength(1);
  });
});

describe('DELETE /me/push-subscriptions', () => {
  it('returns 401 / 503 / 400 / 404 / 200', async () => {
    expect(
      (
        await mount(new InMemoryAuthStore()).request('/me/push-subscriptions', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: validBody.endpoint }),
        })
      ).status,
    ).toBe(401);

    const auth = await seededStore();
    expect(
      (
        await mount(auth, new InMemoryPushStore(), undefined).request('/me/push-subscriptions', {
          method: 'DELETE',
          headers: { ...AUTH, 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: validBody.endpoint }),
        })
      ).status,
    ).toBe(503);

    expect(
      (
        await mount(auth).request('/me/push-subscriptions', {
          method: 'DELETE',
          headers: { ...AUTH, 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(400);

    expect(
      (
        await mount(auth).request('/me/push-subscriptions', {
          method: 'DELETE',
          headers: { ...AUTH, 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: validBody.endpoint }),
        })
      ).status,
    ).toBe(404);

    const pushStore = new InMemoryPushStore();
    await pushStore.upsertSubscription({
      endpoint: validBody.endpoint,
      accountId: 'acc',
      p256dh: validBody.keys.p256dh,
      auth: validBody.keys.auth,
      createdAt: new Date(now()),
    });
    const ok = await mount(auth, pushStore).request('/me/push-subscriptions', {
      method: 'DELETE',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: validBody.endpoint }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
  });
});
