import { describe, expect, it } from 'vitest';
import { createApp } from '@/server';
import { InMemoryAuthStore } from '@/lib/auth/store';

const ADA_ID = '00000000-0000-4000-8000-000000000001';
const WIDE_MAX_SENDABLE = 100_000_000_000;
const CALLBACK = 'https://walletofsatoshi.com/lnurlp/callback';
const WELL_KNOWN_URL = 'https://walletofsatoshi.com/.well-known/lnurlp/alice';
const PR = 'lnbc1paylink';

function createAccount(
  overrides: {
    name?: string | null;
    lightningAddress?: string | null;
  } = {},
) {
  return {
    id: ADA_ID,
    linkingKey: null,
    role: 'basis' as const,
    name: overrides.name === undefined ? 'Ada' : overrides.name,
    username: 'ada',
    lightningAddress:
      overrides.lightningAddress === undefined
        ? 'alice@walletofsatoshi.com'
        : overrides.lightningAddress,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    location: null,
    viewKey: 'cd'.repeat(32),
    createdAt: 1,
    rulesAgreedAt: null,
  };
}

function metadataResponse(minSendable: number, maxSendable: number): Response {
  return new Response(
    JSON.stringify({
      callback: CALLBACK,
      minSendable,
      maxSendable,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function invoiceResponse(): Response {
  return new Response(JSON.stringify({ pr: PR }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function seededApp(
  overrides: {
    name?: string | null;
    lightningAddress?: string | null;
    minSendable?: number;
    maxSendable?: number;
    fetchImpl?: (input: string | URL | Request) => Promise<Response>;
    throwOnLookup?: boolean;
  } = {},
) {
  const authStore = new InMemoryAuthStore();
  if (overrides.throwOnLookup === true) {
    authStore.getAccountByUsername = async () => {
      throw new Error('db');
    };
  } else {
    await authStore.createAccount(createAccount(overrides));
  }
  const minSendable = overrides.minSendable ?? 1000;
  const maxSendable = overrides.maxSendable ?? WIDE_MAX_SENDABLE;
  const urls: string[] = [];
  const fetchImpl =
    overrides.fetchImpl ??
    (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/.well-known/lnurlp/')) {
        return metadataResponse(minSendable, maxSendable);
      }
      return invoiceResponse();
    });
  return { app: createApp({ authStore, fetchImpl }), urls };
}

describe('GET /pay/:username', () => {
  it('returns name and satoshi bounds from the linked Wallet of Satoshi address', async () => {
    const { app, urls } = await seededApp();
    const res = await app.request('/pay/Ada');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      name: 'Ada',
      username: 'ada',
      minSats: 1,
      maxSats: 100000000,
    });
    expect(Object.keys(body).sort()).toEqual(['maxSats', 'minSats', 'name', 'username']);
    expect(urls[0]).toBe(WELL_KNOWN_URL);
    expect(urls.some((url) => url.includes('21.gifts'))).toBe(false);
  });

  it('trims the display name', async () => {
    const { app } = await seededApp({ name: '  Ada  ' });
    const res = await app.request('/pay/ada');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: 'Ada',
      username: 'ada',
      minSats: 1,
      maxSats: 100000000,
    });
  });

  it('uses the username when name is null', async () => {
    const { app } = await seededApp({ name: null });
    const res = await app.request('/pay/ada');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: 'ada',
      username: 'ada',
      minSats: 1,
      maxSats: 100000000,
    });
  });

  it('uses the username when name is blank', async () => {
    const { app } = await seededApp({ name: '   ' });
    const res = await app.request('/pay/ada');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: 'ada',
      username: 'ada',
      minSats: 1,
      maxSats: 100000000,
    });
  });

  it('returns 404 for an invalid username', async () => {
    const app = createApp({ authStore: new InMemoryAuthStore() });
    const res = await app.request('/pay/_');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 when the account is unknown', async () => {
    const app = createApp({ authStore: new InMemoryAuthStore() });
    const res = await app.request('/pay/ada');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 when lightningAddress is null', async () => {
    const { app } = await seededApp({ lightningAddress: null });
    const res = await app.request('/pay/ada');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 when lightningAddress is blank', async () => {
    const { app } = await seededApp({ lightningAddress: '   ' });
    const res = await app.request('/pay/ada');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 502 when the stored address is not LUD-16', async () => {
    let called = false;
    const { app } = await seededApp({
      lightningAddress: 'not-an-address',
      fetchImpl: async () => {
        called = true;
        return metadataResponse(1000, WIDE_MAX_SENDABLE);
      },
    });
    const res = await app.request('/pay/ada');
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Lightning Address could not be resolved' });
    expect(called).toBe(false);
  });

  it('returns 502 when fetchImpl throws', async () => {
    const { app } = await seededApp({
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    const res = await app.request('/pay/ada');
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Lightning Address could not be resolved' });
  });

  it('returns 502 when getAccountByUsername throws', async () => {
    const { app } = await seededApp({ throwOnLookup: true });
    const res = await app.request('/pay/ada');
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Lightning Address could not be resolved' });
  });

  it('returns 502 when maxSats is below minSats', async () => {
    const { app } = await seededApp({ minSendable: 1500, maxSendable: 1999 });
    const res = await app.request('/pay/ada');
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Lightning Address could not be resolved' });
  });
});

describe('POST /pay/:username/invoice', () => {
  it('mints a BOLT11 for an exact satoshi amount on the linked address', async () => {
    const { app, urls } = await seededApp();
    const res = await app.request('/pay/ada/invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountSats: 21 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ pr: PR, amountSats: 21 });
    expect(Object.keys(body).sort()).toEqual(['amountSats', 'pr']);
    expect(urls.length).toBeGreaterThan(1);
    expect(urls[0]).toBe(WELL_KNOWN_URL);
    expect(urls[1]).toBe(WELL_KNOWN_URL);
    const callback = urls[2] ?? '';
    const callbackUrl = new URL(callback);
    expect(callbackUrl.searchParams.get('amount')).toBe('21000');
    expect(callbackUrl.searchParams.has('comment')).toBe(false);
    expect(urls.some((url) => url.includes('21.gifts'))).toBe(false);
  });

  it('returns 400 when the amount is below the window', async () => {
    const { app } = await seededApp({ minSendable: 5000, maxSendable: 100000 });
    const res = await app.request('/pay/ada/invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountSats: 1 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Enter a whole number of sats' });
  });

  it('returns 400 when the amount is above the window', async () => {
    const { app } = await seededApp({ minSendable: 1000, maxSendable: 5000 });
    const res = await app.request('/pay/ada/invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountSats: 6 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Enter a whole number of sats' });
  });

  it('returns 400 for a non-integer amount', async () => {
    const { app } = await seededApp();
    const res = await app.request('/pay/ada/invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountSats: 1.5 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Enter a whole number of sats' });
  });

  it('returns 400 when the amount is missing', async () => {
    const { app } = await seededApp();
    const res = await app.request('/pay/ada/invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Enter a whole number of sats' });
  });

  it('returns 400 for invalid JSON', async () => {
    const { app } = await seededApp();
    const res = await app.request('/pay/ada/invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Enter a whole number of sats' });
  });

  it('returns 404 when the account is unknown', async () => {
    const app = createApp({ authStore: new InMemoryAuthStore() });
    const res = await app.request('/pay/ada/invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountSats: 1 }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 for an invalid username', async () => {
    const app = createApp({ authStore: new InMemoryAuthStore() });
    const res = await app.request('/pay/_/invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountSats: 1 }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 502 when the first well-known fetch throws', async () => {
    const { app } = await seededApp({
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    const res = await app.request('/pay/ada/invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountSats: 21 }),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Lightning Address could not be resolved' });
  });

  it('returns 502 when the invoice callback fails', async () => {
    const { app } = await seededApp({
      fetchImpl: async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/.well-known/lnurlp/')) {
          return metadataResponse(1000, WIDE_MAX_SENDABLE);
        }
        return new Response('fail', { status: 500 });
      },
    });
    const res = await app.request('/pay/ada/invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountSats: 21 }),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Lightning Address could not be resolved' });
  });

  it('returns 502 when getAccountByUsername throws', async () => {
    const { app } = await seededApp({ throwOnLookup: true });
    const res = await app.request('/pay/ada/invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountSats: 1 }),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Lightning Address could not be resolved' });
  });

  it('returns 502 when maxSats is below minSats', async () => {
    const { app } = await seededApp({ minSendable: 1500, maxSendable: 1999 });
    const res = await app.request('/pay/ada/invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountSats: 1 }),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Lightning Address could not be resolved' });
  });
});
