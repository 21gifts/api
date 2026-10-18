import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '@/server';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import { InMemoryLoginGateStore } from '@/lib/login-gate-store';
import {
  APP_OUTDATED_CODE,
  APP_OUTDATED_ERROR,
  LOGINS_CLOSED_CODE,
  LOGINS_CLOSED_ERROR,
} from '@/lib/login-gate';
import { FakePasskeyCeremony } from '@/__tests__/helpers/fake-passkey';

const ORIGIN = 'http://localhost:3000';
const DEBUG = 'gate-debug-token';
const OPERATOR = { authorization: `Bearer ${DEBUG}`, 'content-type': 'application/json' };
const PROVISIONED_ID = '00000000-0000-4000-8000-0000000000a1';
const VIEW_KEY = 'b'.repeat(64);
const LOGINS_CLOSED = { error: LOGINS_CLOSED_ERROR, code: LOGINS_CLOSED_CODE };
const APP_OUTDATED = { error: APP_OUTDATED_ERROR, code: APP_OUTDATED_CODE };

interface Harness {
  app: Hono;
  store: InMemoryAuthStore;
  gateStore: InMemoryLoginGateStore;
}

function harness(env: Record<string, string> = {}): Harness {
  const store = new InMemoryAuthStore();
  const gateStore = new InMemoryLoginGateStore();
  const app = createApp({
    authStore: store,
    loginGateStore: gateStore,
    now: () => 1_000_000,
    allowedOrigins: [ORIGIN],
    webAuthnRpId: 'localhost',
    passkeyCeremony: new FakePasskeyCeremony(),
    debugToken: DEBUG,
    env,
  });
  return { app, store, gateStore };
}

function post(app: Hono, path: string, body?: unknown, build?: string): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(build === undefined ? {} : { 'x-app-build': build }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function register(
  app: Hono,
  build?: string,
  beginBody?: unknown,
): Promise<{ begin: Response; finish?: Response; token?: string; accountId?: string }> {
  const begin = await post(app, '/auth/passkey/register/begin', beginBody, build);
  if (begin.status !== 200) {
    return { begin };
  }
  const { challengeId } = (await begin.json()) as { challengeId: string };
  const finish = await post(
    app,
    '/auth/passkey/register/finish',
    { challengeId, credential: { test: 'ok' } },
    build,
  );
  if (finish.status !== 200) {
    return { begin, finish };
  }
  const body = (await finish.clone().json()) as { token: string; account: { id: string } };
  return { begin, finish, token: body.token, accountId: body.account.id };
}

async function login(app: Hono, build?: string): Promise<Response> {
  const begin = await post(app, '/auth/passkey/authenticate/begin', undefined, build);
  if (begin.status !== 200) {
    return begin;
  }
  const { challengeId } = (await begin.json()) as { challengeId: string };
  return post(
    app,
    '/auth/passkey/authenticate/finish',
    { challengeId, credential: { test: 'ok', id: 'cred-1' } },
    build,
  );
}

async function setLogins(app: Hono, open: boolean): Promise<void> {
  const res = await app.request('/debug/logins', {
    method: 'PUT',
    headers: OPERATOR,
    body: JSON.stringify({ open }),
  });
  expect(res.status).toBe(200);
}

async function allow(app: Hono, accountId: string): Promise<void> {
  const res = await app.request('/debug/logins/allowlist', {
    method: 'POST',
    headers: OPERATOR,
    body: JSON.stringify({ accountId }),
  });
  expect(res.status).toBe(200);
}

function me(app: Hono, token: string): Promise<Response> {
  return Promise.resolve(app.request('/me', { headers: { authorization: `Bearer ${token}` } }));
}

async function provision(store: InMemoryAuthStore, extra: Partial<Account> = {}): Promise<void> {
  await store.createAccount({
    id: PROVISIONED_ID,
    linkingKey: null,
    role: 'basis',
    name: 'Ada',
    forumLawsDismissed: false,
    location: null,
    viewKey: VIEW_KEY,
    createdAt: 1,
    rulesAgreedAt: null,
    ...extra,
  });
}

describe('login gate via createApp', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe('login switch', () => {
    it('is open by default: register and login create sessions', async () => {
      const { app } = harness();
      const registered = await register(app);
      expect(registered.finish?.status).toBe(200);
      expect((await login(app)).status).toBe(200);
    });

    it('closed refuses register and login, and keeps existing sessions', async () => {
      const { app, store } = harness();
      const registered = await register(app);
      await setLogins(app, false);
      const credentialsBefore = await store.listPasskeyCredentials();
      const challengesBefore = await store.listPasskeyChallenges();

      const begin = await post(app, '/auth/passkey/register/begin');
      expect(begin.status).toBe(503);
      expect(await begin.json()).toEqual(LOGINS_CLOSED);
      const named = await post(app, '/auth/passkey/register/begin', { name: 'ada' });
      expect(named.status).toBe(503);
      expect(await store.listPasskeyChallenges()).toEqual(challengesBefore);

      // Authenticate begin does not know the account yet, so only finish refuses.
      const loginBegin = await post(app, '/auth/passkey/authenticate/begin');
      expect(loginBegin.status).toBe(200);
      const { challengeId } = (await loginBegin.json()) as { challengeId: string };
      const refused = await post(app, '/auth/passkey/authenticate/finish', {
        challengeId,
        credential: { test: 'ok', id: 'cred-1' },
      });
      expect(refused.status).toBe(503);
      expect(await refused.json()).toEqual(LOGINS_CLOSED);
      expect(await store.listPasskeyCredentials()).toEqual(credentialsBefore);
      expect((await store.listSessions()).map((row) => row.token)).toEqual([registered.token]);
      expect(await store.listAccounts()).toHaveLength(1);

      expect((await me(app, registered.token as string)).status).toBe(200);
    });

    it('boots closed from LOGINS_OPEN_DEFAULT=closed when nothing is stored', async () => {
      const { app, store } = harness({ LOGINS_OPEN_DEFAULT: 'closed' });
      const registered = await register(app);
      expect(registered.begin.status).toBe(503);
      expect(await store.listPasskeyChallenges()).toEqual([]);
      const state = await app.request('/debug/logins', { headers: OPERATOR });
      expect(await state.json()).toEqual({
        open: false,
        source: 'default',
        defaultOpen: false,
        allowlist: [],
      });
    });

    it('a stored open wins over LOGINS_OPEN_DEFAULT=closed', async () => {
      const { app } = harness({ LOGINS_OPEN_DEFAULT: 'closed' });
      await setLogins(app, true);
      expect((await register(app)).finish?.status).toBe(200);
    });

    it('a stored closed wins over LOGINS_OPEN_DEFAULT=open', async () => {
      const { app } = harness({ LOGINS_OPEN_DEFAULT: 'open' });
      await setLogins(app, false);
      expect((await register(app)).begin.status).toBe(503);
    });

    it('lets an allowlisted account log in while closed, not another one', async () => {
      const { app, store } = harness();
      const registered = await register(app);
      const accountId = registered.accountId as string;
      await setLogins(app, false);
      expect((await login(app)).status).toBe(503);
      await allow(app, accountId);
      const res = await login(app);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { account: { id: string } }).account.id).toBe(accountId);
      expect(await store.getAccount(accountId)).toBeDefined();
      await provision(store);
      const challengesBefore = await store.listPasskeyChallenges();
      const otherClaim = await post(app, '/auth/passkey/register/begin', { viewKey: VIEW_KEY });
      expect(otherClaim.status).toBe(503);
      expect((await post(app, '/auth/passkey/register/begin')).status).toBe(503);
      expect(await store.listPasskeyChallenges()).toEqual(challengesBefore);
    });

    it('always lets the platform account log in while closed', async () => {
      const { app, store } = harness();
      const registered = await register(app);
      const accountId = registered.accountId as string;
      await setLogins(app, false);
      const account = (await store.getAccount(accountId)) as Account;
      await store.updateAccount({ ...account, isPlatform: true });
      expect((await login(app)).status).toBe(200);
    });

    it('refuses at finish when logins close after begin, without writing anything', async () => {
      const { app, store } = harness();
      const begin = await post(app, '/auth/passkey/register/begin');
      const { challengeId } = (await begin.json()) as { challengeId: string };
      await setLogins(app, false);
      const finish = await post(app, '/auth/passkey/register/finish', {
        challengeId,
        credential: { test: 'ok' },
      });
      expect(finish.status).toBe(503);
      expect(await finish.json()).toEqual(LOGINS_CLOSED);
      expect(await store.listAccounts()).toEqual([]);
      expect(await store.listPasskeyCredentials()).toEqual([]);
      expect(await store.listSessions()).toEqual([]);
    });

    it('refuses a claim while closed unless the account is allowlisted', async () => {
      const { app, store } = harness();
      await provision(store);
      await setLogins(app, false);
      const refused = await post(app, '/auth/passkey/register/begin', { viewKey: VIEW_KEY });
      expect(refused.status).toBe(503);
      expect(await refused.json()).toEqual(LOGINS_CLOSED);
      expect(await store.listPasskeyChallenges()).toEqual([]);
      await allow(app, PROVISIONED_ID);
      const claimed = await register(app, undefined, { viewKey: VIEW_KEY });
      expect(claimed.finish?.status).toBe(200);
      expect(claimed.accountId).toBe(PROVISIONED_ID);
    });

    it('refuses a claim at finish when logins close after begin', async () => {
      const { app, store } = harness();
      await provision(store);
      const begin = await post(app, '/auth/passkey/register/begin', { viewKey: VIEW_KEY });
      const { challengeId } = (await begin.json()) as { challengeId: string };
      await setLogins(app, false);
      const finish = await post(app, '/auth/passkey/register/finish', {
        challengeId,
        credential: { test: 'ok' },
      });
      expect(finish.status).toBe(503);
      expect(await store.accountHasPasskey(PROVISIONED_ID)).toBe(false);
      expect(await store.listSessions()).toEqual([]);
    });

    it('keeps the operator session mint open while closed', async () => {
      const { app, store } = harness({ LOGINS_OPEN_DEFAULT: 'closed', APP_BUILD_REQUIRED: 'b1' });
      await provision(store);
      const res = await app.request(`/debug/accounts/${PROVISIONED_ID}/session`, {
        method: 'POST',
        headers: OPERATOR,
      });
      expect(res.status).toBe(200);
    });
  });

  describe('build check', () => {
    it('does not check without APP_BUILD_REQUIRED', async () => {
      const { app } = harness();
      expect((await register(app)).finish?.status).toBe(200);
      expect((await login(app, 'anything')).status).toBe(200);
    });

    it('refuses every session-creating route without the required build', async () => {
      const { app } = harness({ APP_BUILD_REQUIRED: ' sha-1 ' });
      for (const path of [
        '/auth/passkey/register/begin',
        '/auth/passkey/register/finish',
        '/auth/passkey/authenticate/begin',
        '/auth/passkey/authenticate/finish',
      ]) {
        const missing = await post(app, path);
        expect(missing.status).toBe(403);
        expect(await missing.json()).toEqual(APP_OUTDATED);
        const other = await post(app, path, undefined, 'sha-0');
        expect(other.status).toBe(403);
        expect(await other.json()).toEqual(APP_OUTDATED);
      }
    });

    it('accepts the exact required build', async () => {
      const { app } = harness({ APP_BUILD_REQUIRED: 'sha-1' });
      const registered = await register(app, 'sha-1');
      expect(registered.finish?.status).toBe(200);
      expect((await login(app, 'sha-1')).status).toBe(200);
    });

    it('checks the build before the login switch', async () => {
      const { app } = harness({ APP_BUILD_REQUIRED: 'sha-1', LOGINS_OPEN_DEFAULT: 'closed' });
      expect((await post(app, '/auth/passkey/register/begin')).status).toBe(403);
      expect((await post(app, '/auth/passkey/register/begin', undefined, 'sha-1')).status).toBe(
        503,
      );
    });

    it('does not check the build on the seed routes', async () => {
      const { app } = harness({ APP_BUILD_REQUIRED: 'sha-1' });
      const res = await post(app, '/auth/passkey/seed/begin');
      expect(res.status).toBe(401);
    });
  });

  describe('end all sessions', () => {
    it('deletes every session; those bearers answer 401 and a new login works', async () => {
      const { app } = harness();
      const first = await register(app);
      const second = await login(app);
      const secondToken = ((await second.json()) as { token: string }).token;
      const res = await app.request('/debug/sessions', { method: 'DELETE', headers: OPERATOR });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ deleted: 2 });
      expect((await me(app, first.token as string)).status).toBe(401);
      expect((await me(app, secondToken)).status).toBe(401);
      expect((await login(app)).status).toBe(200);
    });
  });

  it('throws at createApp for an unknown LOGINS_OPEN_DEFAULT', () => {
    expect(() => harness({ LOGINS_OPEN_DEFAULT: 'close' })).toThrow(
      'LOGINS_OPEN_DEFAULT must be "open" or "closed"',
    );
  });
});
