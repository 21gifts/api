import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '@/server';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { InMemoryPosStore, type PosStore } from '@/lib/pos-store';
import { Hono } from 'hono';
import { payRoutes } from '@/routes/pay';
import { decodeBolt11 } from '@/lib/bolt11';
import type { PosCharge } from '@/lib/pos-charge';
import { encodeSparkInvoice, uuidV7 } from '@/lib/spark-invoice';
import {
  LNURL_SERVER,
  WALLET_PUBKEY,
  allInternal,
  createWalletAccount,
  walletLnurlFetch,
  type SeenRequest,
} from '@/__tests__/helpers/wallet-lnurl';

const ADA_ID = '00000000-0000-4000-8000-000000000001';
const WIDE_MAX_SENDABLE = 100_000_000_000;
/** Public callback; the api fetches it from the LNURL server. */
const CALLBACK = `${LNURL_SERVER.publicBaseUrl}/lnurlp/ada/invoice`;
/** Internal LNURL server URL of `ada@example.test`'s payRequest. */
const WELL_KNOWN_URL = `${LNURL_SERVER.baseUrl}/.well-known/lnurlp/ada`;
/** Internal LNURL server URL the public callback is fetched from. */
const INTERNAL_CALLBACK = `${LNURL_SERVER.baseUrl}/lnurlp/ada/invoice`;
/** Env that resolves the LNURL server. */
const LNURL_ENV = {
  LNURL_SERVER_URL: LNURL_SERVER.baseUrl,
  PUBLIC_BASE_URL: LNURL_SERVER.publicBaseUrl,
};
/** BOLT11 for 2500 uBTC = 250_000 sats = 250_000_000 msat. */
const PR =
  'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';
const PR_SATS = 250_000;

function createAccount(
  overrides: {
    name?: string | null;
  } = {},
) {
  return {
    id: ADA_ID,
    linkingKey: null,
    role: 'basis' as const,
    name: overrides.name === undefined ? 'Ada' : overrides.name,
    username: 'ada',
    walletRequired: true,
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
    /** `false` leaves the wallet unverified (the member cannot receive). */
    wallet?: boolean;
    minSendable?: number;
    maxSendable?: number;
    fetchImpl?: (input: string | URL | Request) => Promise<Response>;
    throwOnLookup?: boolean;
    posStore?: PosStore;
    now?: () => number;
    env?: Record<string, string>;
  } = {},
) {
  const authStore = new InMemoryAuthStore();
  if (overrides.throwOnLookup === true) {
    authStore.getAccountByUsername = async () => {
      throw new Error('db');
    };
  } else {
    await authStore.createAccount(createAccount(overrides));
    if (overrides.wallet !== false) {
      await authStore.claimSparkPubkey(ADA_ID, WALLET_PUBKEY);
      await authStore.markSparkPubkeyVerified(ADA_ID, WALLET_PUBKEY, 'ada', 2);
    }
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
  const appOpts: {
    authStore: InMemoryAuthStore;
    fetchImpl: (input: string | URL | Request) => Promise<Response>;
    posStore?: PosStore;
    now?: () => number;
    env: Record<string, string | undefined>;
  } = {
    authStore,
    fetchImpl,
    env: { ...process.env, ...LNURL_ENV, ...(overrides.env ?? {}) },
  };
  if (overrides.posStore !== undefined) {
    appOpts.posStore = overrides.posStore;
  }
  if (overrides.now !== undefined) {
    appOpts.now = overrides.now;
  }
  return { app: createApp(appOpts), urls };
}

describe('GET /pay/:username', () => {
  it('returns name and satoshi bounds from the verified wallet', async () => {
    const { app, urls } = await seededApp();
    const res = await app.request('/pay/Ada');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      name: 'Ada',
      username: 'ada',
      minSats: 1,
      maxSats: 100000000,
      charge: null,
    });
    expect(Object.keys(body).sort()).toEqual(['charge', 'maxSats', 'minSats', 'name', 'username']);
    expect(urls[0]).toBe(WELL_KNOWN_URL);
    expect(urls.every((url) => url.startsWith(`${LNURL_SERVER.baseUrl}/`))).toBe(true);
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
      charge: null,
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
      charge: null,
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
      charge: null,
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

  it('returns 404 without a verified wallet and never fetches', async () => {
    let called = false;
    const { app } = await seededApp({
      wallet: false,
      fetchImpl: async () => {
        called = true;
        return metadataResponse(1000, WIDE_MAX_SENDABLE);
      },
    });
    expect((await app.request('/pay/ada')).status).toBe(404);
    const res = await app.request('/pay/ada/invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountSats: PR_SATS }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
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

  it('pins minSats and maxSats to an unexpired pending charge', async () => {
    const nowMs = 1_700_000_000_000;
    const now = (): number => nowMs;
    const expiresAt = new Date(nowMs + 60_000);
    const posStore = new InMemoryPosStore();
    await posStore.create({
      id: '11111111-1111-4111-8111-111111111111',
      accountId: ADA_ID,
      amountSats: 21,
      status: 'pending',
      createdAt: new Date(nowMs),
      expiresAt,
      paidAt: null,
      sparkInvoice: null,
    });
    const { app } = await seededApp({ posStore, now });
    const res = await app.request('/pay/ada');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      name: 'Ada',
      username: 'ada',
      minSats: 21,
      maxSats: 21,
      charge: { amountSats: 21, expiresAt: expiresAt.toISOString() },
    });
    expect(body).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('status');
    expect(body).not.toHaveProperty('createdAt');
    expect(body).not.toHaveProperty('accountId');
  });

  it('returns charge null and the wallet range when the pending charge is expired', async () => {
    const nowMs = 1_700_000_000_000;
    const now = (): number => nowMs;
    const posStore = new InMemoryPosStore();
    await posStore.create({
      id: '22222222-2222-4222-8222-222222222222',
      accountId: ADA_ID,
      amountSats: 21,
      status: 'pending',
      createdAt: new Date(nowMs - 1),
      expiresAt: new Date(nowMs),
      paidAt: null,
      sparkInvoice: null,
    });
    const { app } = await seededApp({ posStore, now });
    const res = await app.request('/pay/ada');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: 'Ada',
      username: 'ada',
      minSats: 1,
      maxSats: 100000000,
      charge: null,
    });
  });

  it('returns charge null and the wallet range when the row is cancelled', async () => {
    const nowMs = 1_700_000_000_000;
    const now = (): number => nowMs;
    const posStore = new InMemoryPosStore();
    await posStore.create({
      id: '33333333-3333-4333-8333-333333333333',
      accountId: ADA_ID,
      amountSats: 21,
      status: 'cancelled',
      createdAt: new Date(nowMs),
      expiresAt: new Date(nowMs + 60_000),
      paidAt: null,
      sparkInvoice: null,
    });
    const { app } = await seededApp({ posStore, now });
    const res = await app.request('/pay/ada');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: 'Ada',
      username: 'ada',
      minSats: 1,
      maxSats: 100000000,
      charge: null,
    });
  });

  it('returns 502 when currentPending throws', async () => {
    const posStore = new InMemoryPosStore();
    posStore.currentPending = async () => {
      throw new Error('till');
    };
    const { app } = await seededApp({ posStore });
    const res = await app.request('/pay/ada');
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Lightning Address could not be resolved' });
  });
});

describe('POST /pay/:username/invoice', () => {
  it('mints a BOLT11 for an exact satoshi amount on the wallet address', async () => {
    const { app, urls } = await seededApp();
    const res = await app.request('/pay/ada/invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountSats: PR_SATS }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ pr: PR, amountSats: PR_SATS, sparkInvoice: null });
    expect(Object.keys(body).sort()).toEqual(['amountSats', 'pr', 'sparkInvoice']);
    expect(urls.length).toBeGreaterThan(1);
    expect(urls[0]).toBe(WELL_KNOWN_URL);
    expect(urls[1]).toBe(WELL_KNOWN_URL);
    const callback = urls[2] ?? '';
    expect(callback.startsWith(`${INTERNAL_CALLBACK}?`)).toBe(true);
    const callbackUrl = new URL(callback);
    expect(callbackUrl.searchParams.get('amount')).toBe(String(PR_SATS * 1000));
    expect(callbackUrl.searchParams.has('comment')).toBe(false);
    expect(urls.every((url) => url.startsWith(`${LNURL_SERVER.baseUrl}/`))).toBe(true);
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

  it('returns 502 when the invoice is not a BOLT11 for that amount', async () => {
    const { app } = await seededApp({
      fetchImpl: async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/.well-known/lnurlp/')) {
          return metadataResponse(1000, WIDE_MAX_SENDABLE);
        }
        return new Response(JSON.stringify({ pr: 'lnbc1not-an-invoice' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
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

  it('returns 502 when the provider window is not a safe integer', async () => {
    const unsafeMin = Number.MAX_SAFE_INTEGER + 2;
    const wideUnsafeMax = 1e16;
    const minUnsafe = await seededApp({ minSendable: unsafeMin, maxSendable: wideUnsafeMax });
    const minRes = await minUnsafe.app.request('/pay/ada');
    expect(minRes.status).toBe(502);
    expect(await minRes.json()).toEqual({ error: 'Lightning Address could not be resolved' });
    expect(minUnsafe.urls).toEqual([WELL_KNOWN_URL]);

    const maxUnsafe = await seededApp({ minSendable: 1000, maxSendable: wideUnsafeMax });
    const maxRes = await maxUnsafe.app.request('/pay/ada/invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountSats: 21 }),
    });
    expect(maxRes.status).toBe(502);
    expect(await maxRes.json()).toEqual({ error: 'Lightning Address could not be resolved' });
    expect(maxUnsafe.urls).toEqual([WELL_KNOWN_URL]);
  });

  it('returns 502 when the BOLT11 amount is not the requested amount', async () => {
    const { app } = await seededApp();
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

  it('rejects a different amount while a charge is open without fetching the callback', async () => {
    const nowMs = 1_700_000_000_000;
    const now = (): number => nowMs;
    const posStore = new InMemoryPosStore();
    await posStore.create({
      id: '44444444-4444-4444-8444-444444444444',
      accountId: ADA_ID,
      amountSats: 21,
      status: 'pending',
      createdAt: new Date(nowMs),
      expiresAt: new Date(nowMs + 60_000),
      paidAt: null,
      sparkInvoice: null,
    });
    const { app, urls } = await seededApp({ posStore, now });
    const res = await app.request('/pay/ada/invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountSats: 1 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Enter a whole number of sats' });
    expect(urls.some((url) => url.startsWith(INTERNAL_CALLBACK))).toBe(false);
  });

  it('mints the open charge amount of 250000 sats', async () => {
    const nowMs = 1_700_000_000_000;
    const now = (): number => nowMs;
    const posStore = new InMemoryPosStore();
    await posStore.create({
      id: '55555555-5555-4555-8555-555555555555',
      accountId: ADA_ID,
      amountSats: PR_SATS,
      status: 'pending',
      createdAt: new Date(nowMs),
      expiresAt: new Date(nowMs + 60_000),
      paidAt: null,
      sparkInvoice: null,
    });
    const { app } = await seededApp({ posStore, now });
    const res = await app.request('/pay/ada/invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountSats: PR_SATS }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pr: PR, amountSats: PR_SATS, sparkInvoice: null });
  });

  it('pins GET to a charge outside the provider window and rejects that POST amount', async () => {
    const nowMs = 1_700_000_000_000;
    const now = (): number => nowMs;
    const posStore = new InMemoryPosStore();
    await posStore.create({
      id: '66666666-6666-4666-8666-666666666666',
      accountId: ADA_ID,
      amountSats: 21,
      status: 'pending',
      createdAt: new Date(nowMs),
      expiresAt: new Date(nowMs + 60_000),
      paidAt: null,
      sparkInvoice: null,
    });
    const { app, urls } = await seededApp({ posStore, now, maxSendable: 5000 });
    const getRes = await app.request('/pay/ada');
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({
      name: 'Ada',
      username: 'ada',
      minSats: 21,
      maxSats: 21,
      charge: { amountSats: 21, expiresAt: new Date(nowMs + 60_000).toISOString() },
    });
    const postRes = await app.request('/pay/ada/invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountSats: 21 }),
    });
    expect(postRes.status).toBe(400);
    expect(await postRes.json()).toEqual({ error: 'Enter a whole number of sats' });
    expect(urls.some((url) => url.startsWith(INTERNAL_CALLBACK))).toBe(false);
  });
});

describe('wallet-backed pay link', () => {
  async function walletPayApp(lnurlServer: boolean): Promise<{
    app: Hono;
    seen: SeenRequest[];
  }> {
    const auth = new InMemoryAuthStore();
    await createWalletAccount(auth, ADA_ID, 'wally');
    const { fetchImpl, seen } = walletLnurlFetch('wally', PR);
    const app = new Hono().route(
      '/pay',
      payRoutes({
        auth,
        fetchImpl,
        posStore: new InMemoryPosStore(),
        now: () => 1,
        ...(lnurlServer ? { lnurlServer: LNURL_SERVER } : {}),
      }),
    );
    return { app, seen };
  }

  it('resolves the wallet internally for the card and the invoice', async () => {
    const { app, seen } = await walletPayApp(true);
    const card = await app.request('/pay/wally');
    expect(card.status).toBe(200);
    expect(await card.json()).toMatchObject({ username: 'wally', minSats: 1, maxSats: 1_000_000 });
    const invoice = await app.request('/pay/wally/invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountSats: PR_SATS }),
    });
    expect(invoice.status).toBe(200);
    expect(await invoice.json()).toEqual({ pr: PR, amountSats: PR_SATS, sparkInvoice: null });
    expect(allInternal(seen)).toBe(true);
    expect(seen.some((request) => request.url.includes('/lnurlp/wally/invoice?'))).toBe(true);
  });

  it('is not found for a wallet-only member when the LNURL server is off', async () => {
    const { app, seen } = await walletPayApp(false);
    expect((await app.request('/pay/wally')).status).toBe(404);
    expect(seen).toEqual([]);
  });
});

describe('till payments on POST /pay/:username/invoice', () => {
  const NOW_MS = 1_700_000_000_000;
  const CHARGE_ID = '77777777-7777-4777-8777-777777777777';
  const PAYMENT_HASH = decodeBolt11(PR)?.paymentHash ?? '';
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  function events(): string[] {
    return warn.mock.calls
      .map((call) => call[0])
      .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
      .map((arg) => (JSON.parse(arg) as { event: string }).event);
  }

  function pendingCharge(): PosCharge {
    return {
      id: CHARGE_ID,
      accountId: ADA_ID,
      amountSats: PR_SATS,
      status: 'pending',
      createdAt: new Date(NOW_MS),
      expiresAt: new Date(NOW_MS + 60_000),
      paidAt: null,
      sparkInvoice: null,
    };
  }

  async function tillApp(opts: {
    posStore: PosStore;
    freePayments?: boolean;
    randomBytes?: (length: number) => Uint8Array;
  }): Promise<Hono> {
    const auth = new InMemoryAuthStore();
    await auth.createAccount(createAccount());
    await auth.claimSparkPubkey(ADA_ID, WALLET_PUBKEY);
    await auth.markSparkPubkeyVerified(ADA_ID, WALLET_PUBKEY, 'ada', 2);
    const fetchImpl = async (input: string | URL | Request): Promise<Response> =>
      String(input).includes('/.well-known/lnurlp/')
        ? metadataResponse(1000, WIDE_MAX_SENDABLE)
        : invoiceResponse();
    return new Hono().route(
      '/pay',
      payRoutes({
        auth,
        fetchImpl,
        posStore: opts.posStore,
        now: () => NOW_MS,
        lnurlServer: LNURL_SERVER,
        ...(opts.freePayments === undefined ? {} : { freePayments: opts.freePayments }),
        ...(opts.randomBytes === undefined ? {} : { randomBytes: opts.randomBytes }),
      }),
    );
  }

  async function mint(app: Hono): Promise<Response> {
    return app.request('/pay/ada/invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountSats: PR_SATS }),
    });
  }

  it('returns one Spark invoice per charge and records the BOLT11 against it', async () => {
    const posStore = new InMemoryPosStore();
    await posStore.create(pendingCharge());
    let fill = 0;
    const app = await tillApp({
      posStore,
      freePayments: true,
      randomBytes: (length) => new Uint8Array(length).fill((fill += 1)),
    });
    const expected = encodeSparkInvoice({
      identityPublicKey: WALLET_PUBKEY,
      id: uuidV7(NOW_MS, new Uint8Array(10).fill(1)),
      memo: `pos:${CHARGE_ID}`,
      amountSats: PR_SATS,
    });
    const first = await mint(app);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ pr: PR, amountSats: PR_SATS, sparkInvoice: expected });
    const second = await mint(app);
    expect(await second.json()).toEqual({ pr: PR, amountSats: PR_SATS, sparkInvoice: expected });
    expect(fill).toBe(1);
    const watched = await posStore.listWatched(NOW_MS);
    expect(watched).toEqual([
      {
        charge: expect.objectContaining({ id: CHARGE_ID, sparkInvoice: expected }),
        paymentHashes: [PAYMENT_HASH],
      },
    ]);
  });

  it('uses the issue time before the mint, so a mint that ends after expiry still counts', async () => {
    const posStore = new InMemoryPosStore();
    await posStore.create(pendingCharge());
    const auth = new InMemoryAuthStore();
    await auth.createAccount(createAccount());
    await auth.claimSparkPubkey(ADA_ID, WALLET_PUBKEY);
    await auth.markSparkPubkeyVerified(ADA_ID, WALLET_PUBKEY, 'ada', 2);
    let clock = NOW_MS;
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      if (String(input).includes('/.well-known/lnurlp/')) {
        return metadataResponse(1000, WIDE_MAX_SENDABLE);
      }
      clock = NOW_MS + 120_000;
      return invoiceResponse();
    };
    const app = new Hono().route(
      '/pay',
      payRoutes({
        auth,
        fetchImpl,
        posStore,
        now: () => clock,
        lnurlServer: LNURL_SERVER,
        freePayments: true,
      }),
    );
    const body = (await (await mint(app)).json()) as { sparkInvoice: string | null };
    expect(body.sparkInvoice?.startsWith('spark1')).toBe(true);
    expect((await posStore.listWatched(0))[0]?.paymentHashes).toEqual([PAYMENT_HASH]);
  });

  it('records the BOLT11 but returns no Spark invoice when free in-app payments are off', async () => {
    const posStore = new InMemoryPosStore();
    await posStore.create(pendingCharge());
    const res = await mint(await tillApp({ posStore }));
    expect(await res.json()).toEqual({ pr: PR, amountSats: PR_SATS, sparkInvoice: null });
    expect((await posStore.listWatched(NOW_MS))[0]?.paymentHashes).toEqual([PAYMENT_HASH]);
    expect((await posStore.listWatched(NOW_MS))[0]?.charge.sparkInvoice).toBeNull();
  });

  it('returns no Spark invoice and records nothing without an open charge', async () => {
    const posStore = new InMemoryPosStore();
    const res = await mint(await tillApp({ posStore, freePayments: true }));
    expect(await res.json()).toEqual({ pr: PR, amountSats: PR_SATS, sparkInvoice: null });
    expect(await posStore.listWatched(0)).toEqual([]);
  });

  it('draws the Spark invoice id from crypto randomness by default', async () => {
    const posStore = new InMemoryPosStore();
    await posStore.create(pendingCharge());
    const body = (await (await mint(await tillApp({ posStore, freePayments: true }))).json()) as {
      sparkInvoice: string;
    };
    expect(body.sparkInvoice.startsWith('spark1')).toBe(true);
  });

  it('still answers with the Spark invoice when recording the BOLT11 fails', async () => {
    const posStore = new InMemoryPosStore();
    await posStore.create(pendingCharge());
    posStore.recordInvoice = async () => {
      throw new Error('db');
    };
    const body = (await (await mint(await tillApp({ posStore, freePayments: true }))).json()) as {
      sparkInvoice: string | null;
    };
    expect(body.sparkInvoice).not.toBeNull();
    expect(events()).toContain('pos.invoice.record_failed');
  });

  it('answers with the BOLT11 and no Spark invoice when storing it fails', async () => {
    const posStore = new InMemoryPosStore();
    await posStore.create(pendingCharge());
    posStore.issueSparkInvoice = async () => {
      throw new Error('db');
    };
    const res = await mint(await tillApp({ posStore, freePayments: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pr: PR, amountSats: PR_SATS, sparkInvoice: null });
    expect(events()).toContain('pos.spark_invoice.issue_failed');
  });

  it('turns Spark invoices on in createApp when free in-app payments resolve', async () => {
    const posStore = new InMemoryPosStore();
    await posStore.create(pendingCharge());
    const { app } = await seededApp({
      posStore,
      now: () => NOW_MS,
      env: { LNURL_ZAP_NSEC_HEX: 'ab'.repeat(32), SPARK_OPERATOR_URL: '' },
    });
    const body = (await (await mint(app)).json()) as { sparkInvoice: string | null };
    expect(body.sparkInvoice?.startsWith('spark1')).toBe(true);
  });
});
