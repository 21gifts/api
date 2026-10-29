import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { accountsByUsernameRoutes } from '@/routes/accounts';

const AUTH = { authorization: 'Bearer tok' };
const FROZEN = 1_000_000;
const frozenNow = (): number => FROZEN;
const NOT_FOUND = { error: 'No account with that username' };

function mount(auth: InMemoryAuthStore, now: () => number = frozenNow): Hono {
  return new Hono().route('/accounts', accountsByUsernameRoutes({ auth, now }));
}

function hexKey(tag: string): string {
  const hex = [...tag].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  return (hex + '0'.repeat(64)).slice(0, 64);
}

async function seededCaller(
  overrides: { rulesAgreedAt?: number | null } = {},
): Promise<InMemoryAuthStore> {
  const store = new InMemoryAuthStore();
  await store.createAccount({
    id: 'caller',
    linkingKey: null,
    role: 'basis',
    name: 'Caller',
    forumLawsDismissed: false,
    location: null,
    viewKey: 'a'.repeat(64),
    createdAt: FROZEN,
    rulesAgreedAt: overrides.rulesAgreedAt === undefined ? FROZEN : overrides.rulesAgreedAt,
  });
  await store.createSession({ token: 'tok', accountId: 'caller', createdAt: FROZEN });
  return store;
}

async function addAccount(
  store: InMemoryAuthStore,
  opts: {
    id: string;
    username?: string | null;
    name?: string | null;
    viewKey: string;
  },
): Promise<void> {
  await store.createAccount({
    id: opts.id,
    linkingKey: null,
    role: 'basis',
    name: opts.name === undefined ? 'Ada' : opts.name,
    forumLawsDismissed: false,
    location: null,
    viewKey: opts.viewKey,
    createdAt: FROZEN,
    rulesAgreedAt: FROZEN,
    ...(opts.username !== undefined ? { username: opts.username } : {}),
  });
}

describe('GET /accounts/by-username/:username', () => {
  it('returns 401 without an Authorization header', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/accounts/by-username/ada');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 with an invalid bearer', async () => {
    const res = await mount(await seededCaller()).request('/accounts/by-username/ada', {
      headers: { authorization: 'Bearer nope' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 409 when the caller lacks rules agreement', async () => {
    const res = await mount(await seededCaller({ rulesAgreedAt: null })).request(
      '/accounts/by-username/ada',
      { headers: AUTH },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'missing_requirements',
      missing: ['rules'],
    });
  });

  it('checks the session before normalizing :username', async () => {
    const anon = await mount(new InMemoryAuthStore()).request('/accounts/by-username/:username');
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({ error: 'Unauthorized' });

    const authed = await mount(await seededCaller()).request('/accounts/by-username/:username', {
      headers: AUTH,
    });
    expect(authed.status).toBe(400);
    expect(await authed.json()).toEqual({ error: 'Username is not valid' });
  });

  it('returns 400 for an empty, blank, or otherwise invalid username', async () => {
    const store = await seededCaller();
    const paths = [
      '/accounts/by-username/%0A',
      '/accounts/by-username/%20',
      '/accounts/by-username/%20%20%20',
      '/accounts/by-username/_',
      `/accounts/by-username/${'a'.repeat(33)}`,
      `/accounts/by-username/${encodeURIComponent('ada bob')}`,
      '/accounts/by-username/-ada',
    ];
    for (const path of paths) {
      const res = await mount(store).request(path, { headers: AUTH });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Username is not valid' });
    }
  });

  it('returns 404 when no account has that username', async () => {
    const res = await mount(await seededCaller()).request('/accounts/by-username/zed', {
      headers: AUTH,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
  });

  it('returns exactly id, username, and name, keeping stored casing and null', async () => {
    const store = await seededCaller();
    await addAccount(store, {
      id: 'ada-id',
      username: 'Ada',
      name: null,
      viewKey: hexKey('Ada'),
    });
    const res = await mount(store).request('/accounts/by-username/ada', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'ada-id', username: 'Ada', name: null });
  });

  it('returns 404 when the stored username is null or blank', async () => {
    const store = await seededCaller();
    const caller = await store.getAccount('caller');
    if (caller === undefined) {
      throw new Error('expected caller');
    }
    const original = store.getAccountByUsername.bind(store);
    for (const username of [null, '   '] as const) {
      store.getAccountByUsername = () => Promise.resolve({ ...caller, username });
      const res = await mount(store).request('/accounts/by-username/ada', { headers: AUTH });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
    }
    store.getAccountByUsername = original;
    await addAccount(store, {
      id: 'ada-id',
      username: 'Ada',
      name: 'Ada Lovelace',
      viewKey: hexKey('Ada'),
    });
    const restored = await mount(store).request('/accounts/by-username/ada', { headers: AUTH });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({
      id: 'ada-id',
      username: 'Ada',
      name: 'Ada Lovelace',
    });
  });
});
