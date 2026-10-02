import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { SESSION_TTL_MS } from '@/lib/config';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { mentionsRoutes } from '@/routes/mentions';

const AUTH = { authorization: 'Bearer tok' };
const FROZEN = 1_000_000;
const frozenNow = (): number => FROZEN;

function mount(auth: InMemoryAuthStore, now: () => number = frozenNow): Hono {
  return new Hono().route('/mentions', mentionsRoutes({ auth, now }));
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
    createdAt?: number;
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
    createdAt: opts.createdAt ?? FROZEN,
    rulesAgreedAt: FROZEN,
    ...(opts.username !== undefined ? { username: opts.username } : {}),
  });
}

describe('GET /mentions', () => {
  it('returns 401 without an Authorization header', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/mentions');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 with an invalid bearer', async () => {
    const res = await mount(await seededCaller()).request('/mentions', {
      headers: { authorization: 'Bearer nope' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 409 when the caller lacks rules agreement', async () => {
    const res = await mount(await seededCaller({ rulesAgreedAt: null })).request('/mentions', {
      headers: AUTH,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'missing_requirements',
      missing: ['rules'],
    });
  });

  it('returns 400 for an invalid query', async () => {
    const store = await seededCaller();
    for (const q of ['_ada', 'ada bob', '@ Ada', 'a'.repeat(33)]) {
      const res = await mount(store).request(`/mentions?q=${encodeURIComponent(q)}`, {
        headers: AUTH,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid query' });
    }
  });

  it('expires the session on the injected clock', async () => {
    const store = await seededCaller();
    const fresh = await mount(store, () => FROZEN + SESSION_TTL_MS).request('/mentions', {
      headers: AUTH,
    });
    expect(fresh.status).toBe(200);
    const expired = await mount(store, () => FROZEN + SESSION_TTL_MS + 1).request('/mentions', {
      headers: AUTH,
    });
    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual({ error: 'Unauthorized' });
  });

  it('caps an empty query at 20 rows in username order, not insertion or id order', async () => {
    const store = await seededCaller();
    for (let n = 21; n >= 1; n -= 1) {
      const label = String(n).padStart(2, '0');
      const id = n === 1 ? 'z-m01' : n === 21 ? 'a-m21' : `q-m${label}`;
      await addAccount(store, {
        id,
        username: `m${label}`,
        viewKey: hexKey(`m${label}`),
        createdAt: 22 - n,
      });
    }
    const res = await mount(store).request('/mentions', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accounts: { id: string; username: string; name: string }[];
    };
    expect(body.accounts).toHaveLength(20);
    expect(body.accounts[0]?.username).toBe('m01');
    expect(body.accounts[19]?.username).toBe('m20');
    expect(body.accounts.map((row) => row.username)).not.toContain('m21');
  });

  it('returns as, asia, aspen for prefix as and for @As', async () => {
    const store = await seededCaller();
    for (const username of ['bob', 'aspen', 'asia', 'as', 'atlas']) {
      await addAccount(store, {
        id: `id-${username}`,
        username,
        viewKey: hexKey(username),
      });
    }
    for (const path of ['/mentions?q=as', '/mentions?q=@As']) {
      const res = await mount(store).request(path, { headers: AUTH });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        accounts: { username: string }[];
      };
      expect(body.accounts.map((row) => row.username)).toEqual(['as', 'asia', 'aspen']);
    }
  });

  it('treats underscore as a literal, not a wildcard', async () => {
    const store = await seededCaller();
    for (const username of ['axb', 'a_b', 'a_c', 'ab']) {
      await addAccount(store, {
        id: `id-${username}`,
        username,
        viewKey: hexKey(username),
      });
    }
    const res = await mount(store).request('/mentions?q=a_', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accounts: { username: string }[] };
    expect(body.accounts.map((row) => row.username)).toEqual(['a_b', 'a_c']);
  });

  it('omits null, blank, and missing usernames', async () => {
    const store = await seededCaller();
    await addAccount(store, { id: 'null-user', username: null, viewKey: hexKey('null') });
    await addAccount(store, { id: 'blank-user', username: 'keep', viewKey: hexKey('blank') });
    await store.updateAccount({
      ...(await store.getAccount('blank-user'))!,
      username: '   ',
    });
    await addAccount(store, { id: 'omit-user', viewKey: hexKey('omit') });
    await addAccount(store, { id: 'zed-user', username: 'zed', viewKey: hexKey('zed') });
    const res = await mount(store).request('/mentions', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accounts: { username: string }[] };
    expect(body.accounts.map((row) => row.username)).toEqual(['zed']);
  });

  it('falls back to the stored username when the display name is blank', async () => {
    const store = await seededCaller();
    await addAccount(store, {
      id: 'cara',
      username: 'cara',
      name: null,
      viewKey: hexKey('cara'),
    });
    await addAccount(store, {
      id: 'cara2',
      username: 'cara2',
      name: '   ',
      viewKey: hexKey('cara2'),
    });
    await addAccount(store, {
      id: 'ada',
      username: 'Ada',
      name: '  Ada Lovelace  ',
      viewKey: hexKey('Ada'),
    });
    const empty = await mount(store).request('/mentions', { headers: AUTH });
    expect(empty.status).toBe(200);
    const emptyBody = (await empty.json()) as {
      accounts: { username: string; name: string }[];
    };
    expect(emptyBody.accounts).toEqual([
      { id: 'ada', username: 'Ada', name: 'Ada Lovelace' },
      { id: 'cara', username: 'cara', name: 'cara' },
      { id: 'cara2', username: 'cara2', name: 'cara2' },
    ]);
    const prefixed = await mount(store).request('/mentions?q=ada', { headers: AUTH });
    expect(prefixed.status).toBe(200);
    expect(await prefixed.json()).toEqual({
      accounts: [{ id: 'ada', username: 'Ada', name: 'Ada Lovelace' }],
    });
  });
});
