import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '@/server';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { wellKnownRoutes } from '@/routes/well-known';

describe('GET /.well-known/nostr.json', () => {
  it('returns names and CORS', async () => {
    const auth = new InMemoryAuthStore();
    await auth.createAccount({
      id: '00000000-0000-4000-8000-000000000001',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
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
  it('passes through the linked Wallet of Satoshi payRequest', async () => {
    const auth = new InMemoryAuthStore();
    await auth.createAccount({
      id: '00000000-0000-4000-8000-000000000001',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      username: 'ada',
      lightningAddress: 'alice@walletofsatoshi.com',
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'cd'.repeat(32),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const fetchImpl = async (input: string | URL | Request) => {
      expect(String(input)).toBe('https://walletofsatoshi.com/.well-known/lnurlp/alice');
      return new Response(
        JSON.stringify({
          tag: 'payRequest',
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: 100_000_000_000,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const app = createApp({ authStore: auth, fetchImpl });
    const res = await app.request('/.well-known/lnurlp/Ada');
    const bare = new Hono().route('/.well-known', wellKnownRoutes({ auth, fetchImpl }));
    const unpinned = await bare.request('/.well-known/lnurlp/ada');
    expect(unpinned.status).toBe(200);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = (await res.json()) as { tag: string; callback: string };
    expect(body.tag).toBe('payRequest');
    expect(body.callback).toBe('https://walletofsatoshi.com/lnurlp/callback');
  });

  it('returns 404 when the username is unknown or has no linked address', async () => {
    const app = createApp({ authStore: new InMemoryAuthStore() });
    const missing = await app.request('/.well-known/lnurlp/ada');
    expect(missing.status).toBe(404);
    const invalid = await app.request('/.well-known/lnurlp/_');
    expect(invalid.status).toBe(404);
  });

  it('returns 502 when Wallet of Satoshi is unreachable', async () => {
    const auth = new InMemoryAuthStore();
    await auth.createAccount({
      id: '00000000-0000-4000-8000-000000000001',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      username: 'ada',
      lightningAddress: 'alice@walletofsatoshi.com',
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'cd'.repeat(32),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const app = createApp({
      authStore: auth,
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    const res = await app.request('/.well-known/lnurlp/ada');
    expect(res.status).toBe(502);
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
});
