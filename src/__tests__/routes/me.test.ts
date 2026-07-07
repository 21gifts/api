import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { bearerToken, meRoutes } from '@/routes/me';

const now = (): number => 1_000_000;

function mount(store: InMemoryAuthStore): Hono {
  return new Hono().route('/me', meRoutes({ store, now }));
}

const AUTH = { authorization: 'Bearer tok' };
const LINKING_KEY = `02${'a'.repeat(64)}`;

/** A store with a signed-in account `acc` reachable via session `tok`. */
function seededStore(): InMemoryAuthStore {
  const store = new InMemoryAuthStore();
  store.createAccount({
    id: 'acc',
    linkingKey: LINKING_KEY,
    role: 'basis',
    lightningAddress: null,
    lightningAddressVerified: false,
    createdAt: 1_000_000,
  });
  store.createSession({ token: 'tok', accountId: 'acc', createdAt: 1_000_000 });
  return store;
}

describe('GET /me', () => {
  it('returns 401 without an Authorization header', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me');
    expect(res.status).toBe(401);
  });

  it('returns 401 for a non-Bearer scheme', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me', {
      headers: { authorization: 'Basic abc' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for an empty bearer token', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me', {
      headers: { authorization: 'Bearer    ' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for an unknown token', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me', {
      headers: { authorization: 'Bearer nope' },
    });
    expect(res.status).toBe(401);
  });

  it('returns the account for a valid session', async () => {
    const store = new InMemoryAuthStore();
    store.createAccount({
      id: 'acc',
      linkingKey: `02${'a'.repeat(64)}`,
      role: 'basis',
      lightningAddress: null,
      lightningAddressVerified: false,
      createdAt: 1_000_000,
    });
    store.createSession({ token: 'tok', accountId: 'acc', createdAt: 1_000_000 });
    const res = await mount(store).request('/me', { headers: { authorization: 'Bearer tok' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      role: string;
      lightningAddress: string | null;
      lightningAddressVerified: boolean;
    };
    expect(body.id).toBe('acc');
    expect(body.role).toBe('basis');
    expect(body.lightningAddress).toBeNull();
    expect(body.lightningAddressVerified).toBe(false);
  });
});

describe('POST /me/lightning-address', () => {
  it('returns 401 without a valid session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me/lightning-address', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'alice@walletofsatoshi.com' }),
    });
    expect(res.status).toBe(401);
  });

  it('links a valid Lightning Address', async () => {
    const store = seededStore();
    const res = await mount(store).request('/me/lightning-address', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'alice@walletofsatoshi.com' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lightningAddress: string;
      lightningAddressVerified: boolean;
    };
    expect(body.lightningAddress).toBe('alice@walletofsatoshi.com');
    expect(body.lightningAddressVerified).toBe(false);
    expect(store.getAccount('acc')?.lightningAddress).toBe('alice@walletofsatoshi.com');
  });

  it('rejects a malformed JSON body', async () => {
    const res = await mount(seededStore()).request('/me/lightning-address', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid Lightning Address', async () => {
    const res = await mount(seededStore()).request('/me/lightning-address', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'not-an-address' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /me/lightning-address', () => {
  it('returns 401 without a valid session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me/lightning-address', {
      method: 'DELETE',
    });
    expect(res.status).toBe(401);
  });

  it('unlinks the address', async () => {
    const store = seededStore();
    store.updateAccount({
      id: 'acc',
      linkingKey: LINKING_KEY,
      role: 'basis',
      lightningAddress: 'alice@walletofsatoshi.com',
      lightningAddressVerified: false,
      createdAt: 1_000_000,
    });
    const res = await mount(store).request('/me/lightning-address', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lightningAddress: string | null };
    expect(body.lightningAddress).toBeNull();
    expect(store.getAccount('acc')?.lightningAddress).toBeNull();
  });
});

describe('bearerToken', () => {
  it('returns null for a missing header', () => {
    expect(bearerToken(undefined)).toBeNull();
  });

  it('returns null for a non-Bearer scheme', () => {
    expect(bearerToken('Basic abc')).toBeNull();
  });

  it('returns null for an empty token', () => {
    expect(bearerToken('Bearer ')).toBeNull();
  });

  it('returns null for a whitespace-only token', () => {
    expect(bearerToken('Bearer    ')).toBeNull();
  });

  it('extracts a present token', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123');
  });
});
