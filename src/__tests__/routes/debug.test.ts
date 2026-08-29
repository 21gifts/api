import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { debugRoutes } from '@/routes/debug';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

describe('debugRoutes', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns 503 when debug is not configured', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({ store: new InMemoryAuthStore(), debugToken: undefined }),
    );
    const res = await app.request('/debug/accounts');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Debug is not configured' });
  });

  it('returns 503 when the token is blank', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({ store: new InMemoryAuthStore(), debugToken: '  ' }),
    );
    const res = await app.request('/debug/accounts', { headers: { authorization: 'Bearer   ' } });
    expect(res.status).toBe(503);
  });

  it('returns 401 without a matching bearer', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({ store: new InMemoryAuthStore(), debugToken: 'secret' }),
    );
    const res = await app.request('/debug/accounts');
    expect(res.status).toBe(401);
  });

  it('lists accounts for a valid bearer', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: `02${'a'.repeat(64)}`,
      role: 'basis',
      name: null,
      lightningAddress: 'a@b.com',
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const app = new Hono().route('/debug/accounts', debugRoutes({ store, debugToken: 'secret' }));
    const res = await app.request('/debug/accounts', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accounts: Array<{ id: string; lightningAddress: string | null }>;
    };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]?.id).toBe('acc');
    expect(body.accounts[0]?.lightningAddress).toBe('a@b.com');
    expect(body.accounts[0]).not.toHaveProperty('viewKey');
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.accounts.listed')).toBe(true);
  });

  it('PATCH returns 503 when debug is not configured', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({ store: new InMemoryAuthStore(), debugToken: undefined }),
    );
    const res = await app.request('/debug/accounts/acc', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'moderator' }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Debug is not configured' });
  });

  it('PATCH returns 401 without a matching bearer', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({ store: new InMemoryAuthStore(), debugToken: 'secret' }),
    );
    const res = await app.request('/debug/accounts/acc', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'moderator' }),
    });
    expect(res.status).toBe(401);
  });

  it('PATCH returns 400 for a missing role body', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({ store: new InMemoryAuthStore(), debugToken: 'secret' }),
    );
    const res = await app.request('/debug/accounts/acc', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with a "role" string',
    });
  });

  it('PATCH returns 400 for an unknown role', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({ store: new InMemoryAuthStore(), debugToken: 'secret' }),
    );
    const res = await app.request('/debug/accounts/acc', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with a "role" string',
    });
  });

  it('PATCH returns 400 for non-JSON', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({ store: new InMemoryAuthStore(), debugToken: 'secret' }),
    );
    const res = await app.request('/debug/accounts/acc', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('PATCH returns 404 for a missing account', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({ store: new InMemoryAuthStore(), debugToken: 'secret' }),
    );
    const res = await app.request('/debug/accounts/missing', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'verified' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('PATCH sets the role and returns the updated account', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      createdAt: 1,
    });
    const app = new Hono().route('/debug/accounts', debugRoutes({ store, debugToken: 'secret' }));
    const res = await app.request('/debug/accounts/acc', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'founder' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; role: string };
    expect(body.id).toBe('acc');
    expect(body.role).toBe('founder');
    expect((await store.getAccount('acc'))?.role).toBe('founder');
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'debug.accounts.role_set' && e['role'] === 'founder',
      ),
    ).toBe(true);
  });
});
