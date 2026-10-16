import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '@/server';
import { InMemoryAuthStore } from '@/lib/auth/store';
import type { LnurlServerConfig } from '@/lib/config';
import { LNURL_PAY_REQUEST_TIMEOUT_MS } from '@/lib/lnurl-server';
import type { FetchFn } from '@/lib/lnurlp';
import { InMemoryPosStore } from '@/lib/pos-store';
import { POS_CHARGE_TTL_MS } from '@/lib/pos-charge';
import { wellKnownRoutes } from '@/routes/well-known';

const PUBKEY = `02${'a'.repeat(64)}`;
const LNURL_CONFIG: LnurlServerConfig = {
  baseUrl: 'http://lnurl.test',
  publicBaseUrl: 'https://example.test',
  host: 'example.test',
};
const NOW = 1_000_000;

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

async function seedVerifiedWallet(store: InMemoryAuthStore): Promise<void> {
  await store.createAccount({
    id: '00000000-0000-4000-8000-000000000001',
    linkingKey: null,
    role: 'basis',
    name: 'Ada',
    username: 'ada',
    forumLawsDismissed: false,
    location: null,
    viewKey: 'cd'.repeat(32),
    createdAt: 1,
    rulesAgreedAt: null,
    walletRequired: true,
  });
  await store.claimSparkPubkey('00000000-0000-4000-8000-000000000001', PUBKEY);
  await store.markSparkPubkeyVerified('00000000-0000-4000-8000-000000000001', PUBKEY, 'ada', NOW);
}

function walletPayDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag: 'payRequest',
    callback: 'https://example.test/lnurlp/ada/invoice',
    metadata: '[["text/plain","ada"]]',
    minSendable: 1000,
    maxSendable: 4_000_000_000,
    commentAllowed: 255,
    ...overrides,
  };
}

describe('GET /.well-known/nostr.json', () => {
  it('returns names and CORS', async () => {
    const auth = new InMemoryAuthStore();
    await auth.createAccount({
      id: '00000000-0000-4000-8000-000000000001',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'cd'.repeat(32),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await auth.setNostrKeyIfAbsent('00000000-0000-4000-8000-000000000001', {
      pubkey: 'aa'.repeat(32),
      ciphertext: new Uint8Array(16),
      kekId: 1,
      custody: 'custodial',
    });
    const app = createApp({ authStore: auth });
    const res = await app.request('/.well-known/nostr.json?name=ada');
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const body = (await res.json()) as { names: Record<string, string> };
    expect(body.names['ada']).toBe('aa'.repeat(32));
  });

  it('returns 503 when the store throws', async () => {
    const auth = new InMemoryAuthStore();
    auth.listAccounts = async () => {
      throw new Error('boom');
    };
    const app = createApp({ authStore: auth });
    const res = await app.request('/.well-known/nostr.json');
    expect(res.status).toBe(503);
  });

  it('keeps CORS * when Origin is a foreign site', async () => {
    const app = createApp({ authStore: new InMemoryAuthStore() });
    const res = await app.request('/.well-known/nostr.json', {
      headers: { Origin: 'https://example.com' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('answers OPTIONS preflight with CORS *', async () => {
    const app = createApp({ authStore: new InMemoryAuthStore() });
    const res = await app.request('/.well-known/nostr.json', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect([200, 204]).toContain(res.status);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

describe('GET /.well-known/lnurlp/:username', () => {
  it('returns 404 for a member without a verified wallet and never fetches', async () => {
    const auth = new InMemoryAuthStore();
    await auth.createAccount({
      id: '00000000-0000-4000-8000-000000000001',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      username: 'ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'cd'.repeat(32),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const fetchImpl = vi.fn<FetchFn>();
    const app = createApp({
      authStore: auth,
      fetchImpl,
      env: {
        ...process.env,
        LNURL_SERVER_URL: LNURL_CONFIG.baseUrl,
        PUBLIC_BASE_URL: LNURL_CONFIG.publicBaseUrl,
      },
    });
    const res = await app.request('/.well-known/lnurlp/Ada');
    expect(res.status).toBe(404);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns 404 when the username is unknown or invalid', async () => {
    const app = createApp({ authStore: new InMemoryAuthStore() });
    const missing = await app.request('/.well-known/lnurlp/ada');
    expect(missing.status).toBe(404);
    const invalid = await app.request('/.well-known/lnurlp/_');
    expect(invalid.status).toBe(404);
  });

  it('returns 502 when the username lookup throws', async () => {
    const auth = new InMemoryAuthStore();
    auth.getAccountByUsername = async () => {
      throw new Error('db');
    };
    const app = createApp({ authStore: auth });
    const res = await app.request('/.well-known/lnurlp/ada');
    expect(res.status).toBe(502);
  });

  describe('wallet-backed payRequest', () => {
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      warn.mockRestore();
    });

    it('serves the LNURL server document with a 5s timeout and fixed Host', async () => {
      const auth = new InMemoryAuthStore();
      await seedVerifiedWallet(auth);
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
      let seenInit: RequestInit | undefined;
      const fetchImpl: FetchFn = async (input, init) => {
        expect(String(input)).toBe('http://lnurl.test/.well-known/lnurlp/ada');
        seenInit = init;
        return new Response(JSON.stringify(walletPayDoc()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
      const app = new Hono().route(
        '/.well-known',
        wellKnownRoutes({
          auth,
          fetchImpl,
          now: () => NOW,
          lnurlServer: LNURL_CONFIG,
        }),
      );
      const res = await app.request('/.well-known/lnurlp/Ada');
      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(await res.json()).toEqual(walletPayDoc());
      expect(seenInit?.headers).toEqual({ host: 'example.test' });
      expect(timeoutSpy).toHaveBeenCalledWith(LNURL_PAY_REQUEST_TIMEOUT_MS);
      expect(
        parsedEvents(warn).some((e) => e['event'] === 'lnurlp.resolved' && e['username'] === 'ada'),
      ).toBe(true);
      timeoutSpy.mockRestore();
    });

    it('pins min/max to a pending point-of-sale charge', async () => {
      const auth = new InMemoryAuthStore();
      await seedVerifiedWallet(auth);
      const posStore = new InMemoryPosStore();
      await posStore.create({
        id: '11111111-1111-4111-8111-111111111111',
        accountId: '00000000-0000-4000-8000-000000000001',
        amountSats: 21,
        status: 'pending',
        createdAt: new Date(NOW),
        expiresAt: new Date(NOW + POS_CHARGE_TTL_MS),
        paidAt: null,
        sparkInvoice: null,
      });
      const fetchImpl: FetchFn = async () =>
        new Response(JSON.stringify(walletPayDoc()), { status: 200 });
      const app = new Hono().route(
        '/.well-known',
        wellKnownRoutes({
          auth,
          fetchImpl,
          posStore,
          now: () => NOW,
          lnurlServer: LNURL_CONFIG,
        }),
      );
      const res = await app.request('/.well-known/lnurlp/ada');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ minSendable: 21_000, maxSendable: 21_000 });
    });

    it('returns 404 when the upstream returns 404', async () => {
      const auth = new InMemoryAuthStore();
      await seedVerifiedWallet(auth);
      const app = new Hono().route(
        '/.well-known',
        wellKnownRoutes({
          auth,
          fetchImpl: async () => new Response('', { status: 404 }),
          lnurlServer: LNURL_CONFIG,
        }),
      );
      const res = await app.request('/.well-known/lnurlp/ada');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    });

    it('returns 503 when the upstream is unreachable, non-2xx, or returns invalid JSON', async () => {
      const auth = new InMemoryAuthStore();
      await seedVerifiedWallet(auth);
      const cases: FetchFn[] = [
        async () => {
          throw new Error('offline');
        },
        async () => new Response('err', { status: 500 }),
        async () => new Response('not-json', { status: 200 }),
      ];
      for (const fetchImpl of cases) {
        const app = new Hono().route(
          '/.well-known',
          wellKnownRoutes({ auth, fetchImpl, lnurlServer: LNURL_CONFIG }),
        );
        const res = await app.request('/.well-known/lnurlp/ada');
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: 'Lightning Address could not be resolved' });
      }
      expect(
        parsedEvents(warn).some(
          (e) => e['event'] === 'lnurlp.unreachable' && e['username'] === 'ada',
        ),
      ).toBe(true);
    });

    it('returns 503 when walletPayRequest rejects the document', async () => {
      const auth = new InMemoryAuthStore();
      await seedVerifiedWallet(auth);
      const app = new Hono().route(
        '/.well-known',
        wellKnownRoutes({
          auth,
          fetchImpl: async () =>
            new Response(JSON.stringify(walletPayDoc({ tag: 'withdrawRequest' })), {
              status: 200,
            }),
          lnurlServer: LNURL_CONFIG,
        }),
      );
      const res = await app.request('/.well-known/lnurlp/ada');
      expect(res.status).toBe(503);
    });

    it('returns 429 after the wallet-branch rate limit', async () => {
      const auth = new InMemoryAuthStore();
      await seedVerifiedWallet(auth);
      let calls = 0;
      const fetchImpl: FetchFn = async () => {
        calls += 1;
        return new Response(JSON.stringify(walletPayDoc()), { status: 200 });
      };
      const app = new Hono().route(
        '/.well-known',
        wellKnownRoutes({
          auth,
          fetchImpl,
          now: () => NOW,
          lnurlServer: LNURL_CONFIG,
        }),
      );
      for (let i = 0; i < 120; i += 1) {
        expect(
          (
            await app.request('/.well-known/lnurlp/ada', {
              headers: { 'cf-connecting-ip': '203.0.113.80' },
            })
          ).status,
        ).toBe(200);
      }
      const limited = await app.request('/.well-known/lnurlp/ada', {
        headers: { 'cf-connecting-ip': '203.0.113.80' },
      });
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({ error: 'Too many requests' });
      expect(calls).toBe(120);
    });

    it('returns 404 for an unknown username even when the LNURL server is configured', async () => {
      const app = new Hono().route(
        '/.well-known',
        wellKnownRoutes({
          auth: new InMemoryAuthStore(),
          fetchImpl: async () => {
            throw new Error('fetch must not be called');
          },
          lnurlServer: LNURL_CONFIG,
        }),
      );
      const res = await app.request('/.well-known/lnurlp/missing');
      expect(res.status).toBe(404);
    });

    it('returns 404 when the wallet is claimed but not verified', async () => {
      const auth = new InMemoryAuthStore();
      await auth.createAccount({
        id: '00000000-0000-4000-8000-000000000001',
        linkingKey: null,
        role: 'basis',
        name: 'Ada',
        username: 'ada',
        forumLawsDismissed: false,
        location: null,
        viewKey: 'cd'.repeat(32),
        createdAt: 1,
        rulesAgreedAt: null,
        walletRequired: true,
      });
      await auth.claimSparkPubkey('00000000-0000-4000-8000-000000000001', PUBKEY);
      const fetchImpl = vi.fn<FetchFn>();
      const app = new Hono().route(
        '/.well-known',
        wellKnownRoutes({ auth, fetchImpl, lnurlServer: LNURL_CONFIG }),
      );
      const res = await app.request('/.well-known/lnurlp/ada');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(
        parsedEvents(warn).some((e) => e['event'] === 'lnurlp.unknown' && e['username'] === 'ada'),
      ).toBe(true);
    });

    it('returns 404 for a verified wallet when lnurlServer is omitted', async () => {
      const auth = new InMemoryAuthStore();
      await seedVerifiedWallet(auth);
      const fetchImpl = vi.fn<FetchFn>();
      const app = new Hono().route('/.well-known', wellKnownRoutes({ auth, fetchImpl }));
      const res = await app.request('/.well-known/lnurlp/ada');
      expect(res.status).toBe(404);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
});
