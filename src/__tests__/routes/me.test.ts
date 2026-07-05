import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { bearerToken, meRoutes } from '@/routes/me';

const now = (): number => 1_000_000;

function mount(store: InMemoryAuthStore): Hono {
  return new Hono().route('/me', meRoutes({ store, now }));
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
      createdAt: 1_000_000,
    });
    store.createSession({ token: 'tok', accountId: 'acc', createdAt: 1_000_000 });
    const res = await mount(store).request('/me', { headers: { authorization: 'Bearer tok' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; role: string; linkingKey: string };
    expect(body.id).toBe('acc');
    expect(body.role).toBe('basis');
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
