import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import type { FetchFn } from '@/lib/lnurlp';
import { debugRoutes } from '@/routes/debug';

const unusedFetch: FetchFn = async () => new Response(null, { status: 500 });

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
      debugRoutes({
        store: new InMemoryAuthStore(),
        debugToken: undefined,
        fetchImpl: async () => new Response(null, { status: 500 }),
      }),
    );
    const res = await app.request('/debug/accounts');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Debug is not configured' });
  });

  it('returns 503 when the token is blank', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store: new InMemoryAuthStore(),
        debugToken: '  ',
        fetchImpl: unusedFetch,
      }),
    );
    const res = await app.request('/debug/accounts', { headers: { authorization: 'Bearer   ' } });
    expect(res.status).toBe(503);
  });

  it('returns 401 without a matching bearer', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store: new InMemoryAuthStore(),
        debugToken: 'secret',
        fetchImpl: unusedFetch,
      }),
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
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({ store, debugToken: 'secret', fetchImpl: unusedFetch }),
    );
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
    expect(body.accounts[0]).toHaveProperty('isPlatform');
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.accounts.listed')).toBe(true);
  });

  it('PATCH returns 503 when debug is not configured', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store: new InMemoryAuthStore(),
        debugToken: undefined,
        fetchImpl: async () => new Response(null, { status: 500 }),
      }),
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
      debugRoutes({
        store: new InMemoryAuthStore(),
        debugToken: 'secret',
        fetchImpl: unusedFetch,
      }),
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
      debugRoutes({
        store: new InMemoryAuthStore(),
        debugToken: 'secret',
        fetchImpl: unusedFetch,
      }),
    );
    const res = await app.request('/debug/accounts/acc', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        'Expected a JSON body with a "role" string, lightningAddress null, and/or platform boolean',
    });
  });

  it('PATCH returns 400 for an unknown role', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store: new InMemoryAuthStore(),
        debugToken: 'secret',
        fetchImpl: unusedFetch,
      }),
    );
    const res = await app.request('/debug/accounts/acc', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        'Expected a JSON body with a "role" string, lightningAddress null, and/or platform boolean',
    });
  });

  it('PATCH returns 400 for non-JSON', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store: new InMemoryAuthStore(),
        debugToken: 'secret',
        fetchImpl: unusedFetch,
      }),
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
      debugRoutes({
        store: new InMemoryAuthStore(),
        debugToken: 'secret',
        fetchImpl: unusedFetch,
      }),
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
      forumLawsDismissed: false,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({ store, debugToken: 'secret', fetchImpl: unusedFetch }),
    );
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
    expect(body).toHaveProperty('isPlatform');
  });

  it('PATCH sets the platform flag and clears any other platform account', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'founder',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await store.createAccount({
      id: 'old',
      linkingKey: null,
      role: 'founder',
      name: 'Old',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'c'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
      isPlatform: true,
    });
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({ store, debugToken: 'secret', fetchImpl: unusedFetch }),
    );
    const res = await app.request('/debug/accounts/acc', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ platform: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; isPlatform: boolean };
    expect(body.id).toBe('acc');
    expect(body.isPlatform).toBe(true);
    expect((await store.getAccount('acc'))?.isPlatform).toBe(true);
    expect((await store.getAccount('old'))?.isPlatform).toBe(false);
  });

  it('PATCH clears the Lightning Address and verification flag', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: 'ada@walletofsatoshi.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: 2,
    });
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({ store, debugToken: 'secret', fetchImpl: unusedFetch }),
    );
    const res = await app.request('/debug/accounts/acc', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ lightningAddress: null }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lightningAddress: string | null;
      lightningAddressVerified: boolean;
    };
    expect(body.lightningAddress).toBeNull();
    expect(body.lightningAddressVerified).toBe(false);
    const stored = await store.getAccount('acc');
    expect(stored?.lightningAddress).toBeNull();
    expect(stored?.lightningAddressVerified).toBe(false);
    expect(stored?.name).toBe('Ada');
    expect(await store.getVerification('acc')).toBeUndefined();
    expect(
      parsedEvents(warn).some((e) => e['event'] === 'debug.accounts.lightning_address.cleared'),
    ).toBe(true);
  });

  it('PATCH unlink drops in-flight address verification', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: 'ada@walletofsatoshi.com',
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: 2,
    });
    await store.putVerification({
      accountId: 'acc',
      address: 'ada@walletofsatoshi.com',
      nonce: 'a'.repeat(32),
      createdAt: 1,
    });
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({ store, debugToken: 'secret', fetchImpl: unusedFetch }),
    );
    const res = await app.request('/debug/accounts/acc', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ lightningAddress: null }),
    });
    expect(res.status).toBe(200);
    expect(await store.getVerification('acc')).toBeUndefined();
  });

  it('PATCH can set role and unlink in one body', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: 'ada@walletofsatoshi.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: 2,
    });
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({ store, debugToken: 'secret', fetchImpl: unusedFetch }),
    );
    const res = await app.request('/debug/accounts/acc', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'moderator', lightningAddress: null }),
    });
    expect(res.status).toBe(200);
    const stored = await store.getAccount('acc');
    expect(stored?.role).toBe('moderator');
    expect(stored?.lightningAddress).toBeNull();
    expect(stored?.lightningAddressVerified).toBe(false);
  });

  it('PATCH returns 400 when lightningAddress is not null', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store: new InMemoryAuthStore(),
        debugToken: 'secret',
        fetchImpl: unusedFetch,
      }),
    );
    const res = await app.request('/debug/accounts/acc', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ lightningAddress: 'ada@walletofsatoshi.com' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        'Expected a JSON body with a "role" string, lightningAddress null, and/or platform boolean',
    });
  });

  it('POST returns 503 when debug is not configured', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store: new InMemoryAuthStore(),
        debugToken: undefined,
        fetchImpl: async () => new Response(null, { status: 500 }),
      }),
    );
    const res = await app.request('/debug/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accounts: [{ name: 'Ada', lightningAddress: 'guest@walletofsatoshi.com' }],
      }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Debug is not configured' });
  });

  it('POST returns 401 without a matching bearer', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store: new InMemoryAuthStore(),
        debugToken: 'secret',
        fetchImpl: unusedFetch,
      }),
    );
    const res = await app.request('/debug/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accounts: [{ name: 'Ada', lightningAddress: 'guest@walletofsatoshi.com' }],
      }),
    });
    expect(res.status).toBe(401);
  });

  it('POST returns 400 for an invalid body', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store: new InMemoryAuthStore(),
        debugToken: 'secret',
        fetchImpl: unusedFetch,
      }),
    );
    const res = await app.request('/debug/accounts', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with an "accounts" array',
    });
  });

  it('POST returns 400 when name or Lightning Address fail normalisation', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store: new InMemoryAuthStore(),
        debugToken: 'secret',
        fetchImpl: unusedFetch,
      }),
    );
    const badName = await app.request('/debug/accounts', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        accounts: [{ name: 'Ada\u0001', lightningAddress: 'guest@walletofsatoshi.com' }],
      }),
    });
    expect(badName.status).toBe(400);
    expect(await badName.json()).toEqual({
      error: 'Expected a JSON body with an "accounts" array',
    });
    const badAddr = await app.request('/debug/accounts', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        accounts: [{ name: 'Ada', lightningAddress: 'a@b' }],
      }),
    });
    expect(badAddr.status).toBe(400);
    expect(await badAddr.json()).toEqual({
      error: 'Expected a JSON body with an "accounts" array',
    });
  });

  it('POST returns 400 without persisting earlier rows when one address fails normalisation', async () => {
    const store = new InMemoryAuthStore();
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({ store, debugToken: 'secret', fetchImpl: unusedFetch }),
    );
    const res = await app.request('/debug/accounts', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        accounts: [
          { name: 'Ada', lightningAddress: 'guest@walletofsatoshi.com' },
          { name: 'Bob', lightningAddress: 'a@b' },
        ],
      }),
    });
    expect(res.status).toBe(400);
    expect(await store.getAccountByLightningAddress('guest@walletofsatoshi.com')).toBeUndefined();
  });

  it('POST provisions a new account without a passkey', async () => {
    const store = new InMemoryAuthStore();
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({ store, debugToken: 'secret', fetchImpl: unusedFetch }),
    );
    const res = await app.request('/debug/accounts', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        accounts: [{ name: 'Ada', lightningAddress: 'guest@walletofsatoshi.com' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accounts: Array<{
        name: string;
        lightningAddress: string;
        viewKey: string;
        created: boolean;
      }>;
    };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]?.created).toBe(true);
    expect(body.accounts[0]?.name).toBe('Ada');
    expect(body.accounts[0]?.lightningAddress).toBe('guest@walletofsatoshi.com');
    expect(body.accounts[0]?.viewKey).toMatch(/^[0-9a-f]{64}$/);
    const stored = await store.getAccountByLightningAddress('guest@walletofsatoshi.com');
    expect(stored).toMatchObject({
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: 'guest@walletofsatoshi.com',
      rulesAgreedAt: null,
      viewKey: body.accounts[0]?.viewKey,
    });
    expect(await store.accountHasPasskey(stored!.id)).toBe(false);
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'debug.accounts.provisioned' && e['created'] === 1 && e['updated'] === 0,
      ),
    ).toBe(true);
  });

  it('POST updates name idempotently for the same address ignoring case', async () => {
    const store = new InMemoryAuthStore();
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({ store, debugToken: 'secret', fetchImpl: unusedFetch }),
    );
    const first = await app.request('/debug/accounts', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        accounts: [{ name: 'Ada', lightningAddress: 'guest@walletofsatoshi.com' }],
      }),
    });
    const firstBody = (await first.json()) as {
      accounts: Array<{ viewKey: string; created: boolean }>;
    };
    const second = await app.request('/debug/accounts', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        accounts: [{ name: 'Ada Lovelace', lightningAddress: 'Guest@WalletOfSatoshi.com' }],
      }),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      accounts: Array<{ name: string; viewKey: string; created: boolean }>;
    };
    expect(secondBody.accounts[0]?.created).toBe(false);
    expect(secondBody.accounts[0]?.viewKey).toBe(firstBody.accounts[0]?.viewKey);
    expect(secondBody.accounts[0]?.name).toBe('Ada Lovelace');
    expect((await store.getAccountByLightningAddress('guest@walletofsatoshi.com'))?.name).toBe(
      'Ada Lovelace',
    );
    const listed = await app.request('/debug/accounts', {
      headers: { authorization: 'Bearer secret' },
    });
    const listBody = (await listed.json()) as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(listBody.accounts[0]).not.toHaveProperty('viewKey');
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'debug.accounts.provisioned' && e['created'] === 0 && e['updated'] === 1,
      ),
    ).toBe(true);
  });

  it('POST updates only name on an existing moderator account', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'existing',
      linkingKey: null,
      role: 'moderator',
      name: 'Old',
      lightningAddress: 'guest@walletofsatoshi.com',
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'c'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: 9_000,
    });
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({ store, debugToken: 'secret', fetchImpl: unusedFetch }),
    );
    const res = await app.request('/debug/accounts', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        accounts: [{ name: 'Ada', lightningAddress: 'guest@walletofsatoshi.com' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accounts: Array<{ name: string; created: boolean; viewKey: string }>;
    };
    expect(body.accounts[0]?.created).toBe(false);
    expect(body.accounts[0]?.name).toBe('Ada');
    expect(body.accounts[0]?.viewKey).toBe('c'.repeat(64));
    const stored = await store.getAccount('existing');
    expect(stored?.name).toBe('Ada');
    expect(stored?.role).toBe('moderator');
    expect(stored?.rulesAgreedAt).toBe(9_000);
  });

  it('POST returns 500 when create does not persist the address', async () => {
    class HollowStore extends InMemoryAuthStore {
      override async getAccountByLightningAddress(): Promise<undefined> {
        return undefined;
      }
      override async createAccount(): Promise<void> {
        return;
      }
    }
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({ store: new HollowStore(), debugToken: 'secret', fetchImpl: unusedFetch }),
    );
    const res = await app.request('/debug/accounts', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        accounts: [{ name: 'Ada', lightningAddress: 'guest@walletofsatoshi.com' }],
      }),
    });
    expect(res.status).toBe(500);
  });

  it('POST returns 500 when the name-only update finds no row', async () => {
    class MissingNameUpdateStore extends InMemoryAuthStore {
      override async getAccountByLightningAddress() {
        return {
          id: 'existing',
          linkingKey: null,
          role: 'basis' as const,
          name: 'Old',
          lightningAddress: 'guest@walletofsatoshi.com',
          lightningAddressVerified: false,
          forumLawsDismissed: false,
          viewKey: 'c'.repeat(64),
          createdAt: 1,
          rulesAgreedAt: null,
        };
      }
      override async updateAccountNameByLightningAddress(): Promise<undefined> {
        return undefined;
      }
    }
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store: new MissingNameUpdateStore(),
        debugToken: 'secret',
        fetchImpl: unusedFetch,
      }),
    );
    const res = await app.request('/debug/accounts', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        accounts: [{ name: 'Ada', lightningAddress: 'guest@walletofsatoshi.com' }],
      }),
    });
    expect(res.status).toBe(500);
  });

  it('POST applies the name when create loses a race to an existing address', async () => {
    class RaceStore extends InMemoryAuthStore {
      #lookups = 0;
      override async getAccountByLightningAddress(address: string) {
        this.#lookups += 1;
        if (this.#lookups === 1) {
          return undefined;
        }
        return super.getAccountByLightningAddress(address);
      }
    }
    const store = new RaceStore();
    await store.createAccount({
      id: 'existing',
      linkingKey: null,
      role: 'moderator',
      name: 'Old',
      lightningAddress: 'guest@walletofsatoshi.com',
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'c'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: 9_000,
    });
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({ store, debugToken: 'secret', fetchImpl: unusedFetch }),
    );
    const res = await app.request('/debug/accounts', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        accounts: [{ name: 'Ada', lightningAddress: 'guest@walletofsatoshi.com' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accounts: Array<{ name: string; created: boolean; viewKey: string }>;
    };
    expect(body.accounts[0]?.created).toBe(false);
    expect(body.accounts[0]?.name).toBe('Ada');
    expect(body.accounts[0]?.viewKey).toBe('c'.repeat(64));
    const stored = await store.getAccount('existing');
    expect(stored?.name).toBe('Ada');
    expect(stored?.role).toBe('moderator');
    expect(stored?.rulesAgreedAt).toBe(9_000);
  });

  it('POST returns 500 when a create race cannot apply the name-only update', async () => {
    class RaceHollowNameStore extends InMemoryAuthStore {
      #lookups = 0;
      override async getAccountByLightningAddress(address: string) {
        this.#lookups += 1;
        if (this.#lookups === 1) {
          return undefined;
        }
        return super.getAccountByLightningAddress(address);
      }
      override async updateAccountNameByLightningAddress(): Promise<undefined> {
        return undefined;
      }
    }
    const store = new RaceHollowNameStore();
    await store.createAccount({
      id: 'existing',
      linkingKey: null,
      role: 'basis',
      name: 'Old',
      lightningAddress: 'guest@walletofsatoshi.com',
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'c'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({ store, debugToken: 'secret', fetchImpl: unusedFetch }),
    );
    const res = await app.request('/debug/accounts', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        accounts: [{ name: 'Ada', lightningAddress: 'guest@walletofsatoshi.com' }],
      }),
    });
    expect(res.status).toBe(500);
  });

  it('POST returns 500 when the name-only update does not persist the request name', async () => {
    class NullAddressStore extends InMemoryAuthStore {
      override async getAccountByLightningAddress() {
        return {
          id: 'existing',
          linkingKey: null,
          role: 'basis' as const,
          name: 'Old',
          lightningAddress: null,
          lightningAddressVerified: false,
          forumLawsDismissed: false,
          viewKey: 'c'.repeat(64),
          createdAt: 1,
          rulesAgreedAt: null,
        };
      }
      override async updateAccountNameByLightningAddress() {
        return {
          id: 'existing',
          linkingKey: null,
          role: 'basis' as const,
          name: null,
          lightningAddress: null,
          lightningAddressVerified: false,
          forumLawsDismissed: false,
          viewKey: 'c'.repeat(64),
          createdAt: 1,
          rulesAgreedAt: null,
        };
      }
    }
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({ store: new NullAddressStore(), debugToken: 'secret', fetchImpl: unusedFetch }),
    );
    const res = await app.request('/debug/accounts', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        accounts: [{ name: 'Ada', lightningAddress: 'guest@walletofsatoshi.com' }],
      }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Could not save the account' });
  });

  it('POST falls back to the request name and address when create returns null fields', async () => {
    class NullCreatedStore extends InMemoryAuthStore {
      override async getAccountByLightningAddress(address: string) {
        const acc = await super.getAccountByLightningAddress(address);
        if (acc === undefined) {
          return undefined;
        }
        return { ...acc, name: null, lightningAddress: null };
      }
    }
    const store = new NullCreatedStore();
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({ store, debugToken: 'secret', fetchImpl: unusedFetch }),
    );
    const res = await app.request('/debug/accounts', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        accounts: [{ name: 'Ada', lightningAddress: 'guest@walletofsatoshi.com' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accounts: Array<{ name: string; lightningAddress: string; created: boolean }>;
    };
    expect(body.accounts[0]?.created).toBe(true);
    expect(body.accounts[0]?.name).toBe('Ada');
    expect(body.accounts[0]?.lightningAddress).toBe('guest@walletofsatoshi.com');
  });

  it('POST returns 500 when a create-race name-only update does not persist the request name', async () => {
    class RaceNullAddressStore extends InMemoryAuthStore {
      #lookups = 0;
      override async getAccountByLightningAddress(address: string) {
        this.#lookups += 1;
        if (this.#lookups === 1) {
          return undefined;
        }
        const acc = await super.getAccountByLightningAddress(address);
        return acc === undefined ? undefined : { ...acc, name: null, lightningAddress: null };
      }
      override async updateAccountNameByLightningAddress(address: string, name: string) {
        const acc = await super.updateAccountNameByLightningAddress(address, name);
        return acc === undefined ? undefined : { ...acc, name: null, lightningAddress: null };
      }
    }
    const store = new RaceNullAddressStore();
    await store.createAccount({
      id: 'existing',
      linkingKey: null,
      role: 'basis',
      name: 'Old',
      lightningAddress: 'guest@walletofsatoshi.com',
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'c'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({ store, debugToken: 'secret', fetchImpl: unusedFetch }),
    );
    const res = await app.request('/debug/accounts', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        accounts: [{ name: 'Ada', lightningAddress: 'guest@walletofsatoshi.com' }],
      }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Could not save the account' });
  });

  it('POST falls back to the request address when the name-only update omits it', async () => {
    const saved = {
      id: 'existing',
      linkingKey: null,
      role: 'basis' as const,
      name: 'Ada',
      lightningAddress: null as string | null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'c'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    };
    class AddressFallbackStore extends InMemoryAuthStore {
      override async getAccountByLightningAddress() {
        return saved;
      }
      override async updateAccountNameByLightningAddress() {
        return saved;
      }
    }
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store: new AddressFallbackStore(),
        debugToken: 'secret',
        fetchImpl: unusedFetch,
      }),
    );
    const existing = await app.request('/debug/accounts', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        accounts: [{ name: 'Ada', lightningAddress: 'guest@walletofsatoshi.com' }],
      }),
    });
    expect(existing.status).toBe(200);
    expect(
      ((await existing.json()) as { accounts: Array<{ lightningAddress: string }> }).accounts[0]
        ?.lightningAddress,
    ).toBe('guest@walletofsatoshi.com');

    class RaceAddressFallbackStore extends InMemoryAuthStore {
      #lookups = 0;
      override async getAccountByLightningAddress() {
        this.#lookups += 1;
        return this.#lookups === 1 ? undefined : saved;
      }
      override async updateAccountNameByLightningAddress() {
        return saved;
      }
    }
    const raceApp = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store: new RaceAddressFallbackStore(),
        debugToken: 'secret',
        fetchImpl: unusedFetch,
      }),
    );
    const raced = await raceApp.request('/debug/accounts', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        accounts: [{ name: 'Ada', lightningAddress: 'guest@walletofsatoshi.com' }],
      }),
    });
    expect(raced.status).toBe(200);
    const racedBody = (await raced.json()) as {
      accounts: Array<{ lightningAddress: string; created: boolean }>;
    };
    expect(racedBody.accounts[0]?.created).toBe(false);
    expect(racedBody.accounts[0]?.lightningAddress).toBe('guest@walletofsatoshi.com');
  });
});
