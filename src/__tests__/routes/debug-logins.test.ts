import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { LoginGate } from '@/lib/login-gate';
import { InMemoryLoginGateStore } from '@/lib/login-gate-store';
import { debugLoginsRoutes } from '@/routes/debug-logins';

const TOKEN = 'logins-debug';
const OPERATOR = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const ID = '00000000-0000-4000-8000-0000000000c1';
const now = (): number => 1_700_000_000_000;

interface Mounted {
  app: Hono;
  store: InMemoryAuthStore;
  gateStore: InMemoryLoginGateStore;
}

async function mount(debugToken: string | null = TOKEN): Promise<Mounted> {
  const store = new InMemoryAuthStore();
  await store.createAccount({
    id: ID,
    linkingKey: null,
    role: 'basis',
    name: 'Ada',
    forumLawsDismissed: false,
    location: null,
    viewKey: 'c'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: null,
  });
  const gateStore = new InMemoryLoginGateStore();
  const app = new Hono().route(
    '/debug',
    debugLoginsRoutes({
      authStore: store,
      loginGate: new LoginGate(gateStore, true),
      now,
      debugToken: debugToken ?? undefined,
    }),
  );
  return { app, store, gateStore };
}

describe('debug login routes', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('answers 503 on every route when debug is not configured', async () => {
    const { app } = await mount('  ');
    for (const [method, path] of [
      ['GET', '/debug/logins'],
      ['PUT', '/debug/logins'],
      ['POST', '/debug/logins/allowlist'],
      ['DELETE', `/debug/logins/allowlist/${ID}`],
      ['DELETE', '/debug/sessions'],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Debug is not configured' });
    }
    expect((await (await mount(null)).app.request('/debug/logins')).status).toBe(503);
  });

  it('answers 401 on every route without the operator bearer', async () => {
    const { app, store } = await mount();
    await store.createSession({ token: 'member', accountId: ID, createdAt: now() });
    for (const [method, path] of [
      ['GET', '/debug/logins'],
      ['PUT', '/debug/logins'],
      ['POST', '/debug/logins/allowlist'],
      ['DELETE', `/debug/logins/allowlist/${ID}`],
      ['DELETE', '/debug/sessions'],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: { authorization: 'Bearer member' },
      });
      expect(res.status).toBe(401);
    }
    expect(await store.listSessions()).toHaveLength(1);
  });

  it('GET /debug/logins reports the default state and an empty allowlist', async () => {
    const { app } = await mount();
    const res = await app.request('/debug/logins', { headers: OPERATOR });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      open: true,
      source: 'default',
      defaultOpen: true,
      allowlist: [],
    });
  });

  it('PUT /debug/logins stores the switch', async () => {
    const { app, gateStore } = await mount();
    const res = await app.request('/debug/logins', {
      method: 'PUT',
      headers: OPERATOR,
      body: JSON.stringify({ open: false }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ open: false, source: 'stored', defaultOpen: true });
    await expect(gateStore.loginsOpen()).resolves.toBe(false);
  });

  it('PUT /debug/logins refuses a body without an open boolean', async () => {
    const { app } = await mount();
    for (const body of ['nope', '{}', '{"open":"false"}', '{"open":true,"extra":1}']) {
      const res = await app.request('/debug/logins', { method: 'PUT', headers: OPERATOR, body });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Expected a JSON body with an "open" boolean' });
    }
  });

  it('POST /debug/logins/allowlist adds an existing account once', async () => {
    const { app } = await mount();
    const add = (accountId: string): Promise<Response> =>
      Promise.resolve(
        app.request('/debug/logins/allowlist', {
          method: 'POST',
          headers: OPERATOR,
          body: JSON.stringify({ accountId }),
        }),
      );
    const first = await add(ID.toUpperCase());
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      added: true,
      open: true,
      source: 'default',
      defaultOpen: true,
      allowlist: [{ accountId: ID, createdAt: new Date(now()).toISOString() }],
    });
    expect(await (await add(ID)).json()).toMatchObject({ added: false });
  });

  it('POST /debug/logins/allowlist refuses a bad body and an unknown account', async () => {
    const { app } = await mount();
    for (const body of ['nope', '{}', '{"accountId":"abc"}']) {
      const res = await app.request('/debug/logins/allowlist', {
        method: 'POST',
        headers: OPERATOR,
        body,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Expected a JSON body with an "accountId" uuid' });
    }
    const unknown = await app.request('/debug/logins/allowlist', {
      method: 'POST',
      headers: OPERATOR,
      body: JSON.stringify({ accountId: '00000000-0000-4000-8000-0000000000ff' }),
    });
    expect(unknown.status).toBe(404);
  });

  it('DELETE /debug/logins/allowlist/:accountId removes a listed account', async () => {
    const { app, gateStore } = await mount();
    await gateStore.addToAllowlist(ID, 1);
    const res = await app.request(`/debug/logins/allowlist/${ID.toUpperCase()}`, {
      method: 'DELETE',
      headers: OPERATOR,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ removed: true, allowlist: [] });
    const again = await app.request(`/debug/logins/allowlist/${ID}`, {
      method: 'DELETE',
      headers: OPERATOR,
    });
    expect(await again.json()).toMatchObject({ removed: false });
    const bad = await app.request('/debug/logins/allowlist/not-a-uuid', {
      method: 'DELETE',
      headers: OPERATOR,
    });
    expect(bad.status).toBe(404);
  });

  it('DELETE /debug/sessions deletes every session and returns the count', async () => {
    const { app, store } = await mount();
    await store.createSession({ token: 't1', accountId: ID, createdAt: now() });
    await store.createSession({ token: 't2', accountId: ID, createdAt: now() });
    const res = await app.request('/debug/sessions', { method: 'DELETE', headers: OPERATOR });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 2 });
    expect(await store.listSessions()).toEqual([]);
  });
});
