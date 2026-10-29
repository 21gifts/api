import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import type { ShopNoteRef } from '@/lib/message-store';
import type { ActivityPing } from '@/lib/ocp-activity';
import type { MapFetch } from '@/lib/ocp-place';
import type { FxSpotQuote } from '@/lib/fx-spot';
import type { FxSpotStore } from '@/lib/fx-spot-store';
import { InMemoryPosStore, type PosStore } from '@/lib/pos-store';
import { POS_CHARGE_TTL_MS, POS_PAID_SHOW_MS, type PosCharge } from '@/lib/pos-charge';
import { ShopPayments } from '@/lib/shop-payment';
import { InMemoryFxSpotStore } from '@/lib/fx-spot-store';
import { InMemoryShopPaymentStore } from '@/lib/shop-payment-store';
import { posRoutes } from '@/routes/pos';
import { createApp } from '@/server';
import {
  LNURL_SERVER,
  WALLET_PUBKEY,
  allInternal,
  createWalletAccount,
  walletLnurlFetch,
  type SeenRequest,
} from '@/__tests__/helpers/wallet-lnurl';

const nowMs = 1_700_000_000_000;
const now = (): number => nowMs;
const AUTH = { authorization: 'Bearer tok' };
/** Public callback of `ada@example.test`. */
const CALLBACK = `${LNURL_SERVER.publicBaseUrl}/lnurlp/ada/invoice`;

function lnurlFetch(minSendable = 1000, maxSendable = 100_000_000): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        callback: CALLBACK,
        minSendable,
        maxSendable,
        metadata: '[["text/plain","ada"]]',
        tag: 'payRequest',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
}

async function readyStore(wallet = true): Promise<InMemoryAuthStore> {
  const store = new InMemoryAuthStore();
  await store.createAccount({
    id: 'acc',
    linkingKey: null,
    role: 'basis',
    name: 'Ada',
    username: 'ada',
    walletRequired: true,
    forumLawsDismissed: false,
    location: null,
    viewKey: 'a'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: nowMs,
  });
  if (wallet) {
    await store.claimSparkPubkey('acc', WALLET_PUBKEY);
    await store.markSparkPubkeyVerified('acc', WALLET_PUBKEY, 'ada', 2);
  }
  await store.createSession({ token: 'tok', accountId: 'acc', createdAt: nowMs });
  return store;
}

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

type RecordedCall = {
  url: string;
  method: string;
  authorization: string;
  contentType: string;
  body: string;
};

function recordingActivity(status = 200): { activity: ActivityPing; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: MapFetch = async (input, init) => {
    const headers = new Headers(init.headers);
    calls.push({
      url: String(input),
      method: init.method ?? 'GET',
      authorization: headers.get('authorization') ?? '',
      contentType: headers.get('content-type') ?? '',
      body: String(init.body),
    });
    return new Response('{}', { status });
  };
  return {
    activity: { baseUrl: 'http://map.test', token: 'secret', fetchImpl },
    calls,
  };
}

function shops(notes: ShopNoteRef[]): { listLiveAssignedShops(): Promise<ShopNoteRef[]> } {
  return { listLiveAssignedShops: async () => notes };
}

function mount(
  authStore: InMemoryAuthStore,
  fetchImpl: typeof fetch = lnurlFetch(),
  extras: {
    messageStore?: { listLiveAssignedShops(): Promise<ShopNoteRef[]> };
    activity?: ActivityPing;
    store?: PosStore;
  } = {},
): Hono {
  return new Hono().route(
    '/pos',
    posRoutes({
      store: extras.store === undefined ? new InMemoryPosStore() : extras.store,
      authStore,
      now,
      fetchImpl,
      lnurlServer: LNURL_SERVER,
      ...(extras.messageStore === undefined ? {} : { messageStore: extras.messageStore }),
      ...(extras.activity === undefined ? {} : { activity: extras.activity }),
    }),
  );
}

describe('POS routes', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('rejects missing sessions', async () => {
    const app = mount(await readyStore());
    expect((await app.request('/pos')).status).toBe(401);
    expect((await app.request('/pos', { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await app.request('/pos', { method: 'DELETE' })).status).toBe(401);
  });

  it('rejects a bad body, missing username, and no verified wallet', async () => {
    const auth = await readyStore();
    const app = mount(auth);
    const bad = await app.request('/pos', {
      method: 'POST',
      headers: AUTH,
      body: '{"amountSats":1.5}',
    });
    expect(bad.status).toBe(400);
    for (const body of [
      'not-json',
      'null',
      '[]',
      '"21"',
      '{}',
      '{"amountSats":"21"}',
      '{"amountSats":0}',
    ]) {
      const res = await app.request('/pos', { method: 'POST', headers: AUTH, body });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Expected a JSON body with an integer "amountSats"',
      });
    }

    const noName = new InMemoryAuthStore();
    await noName.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: nowMs,
    });
    await noName.createSession({ token: 'tok', accountId: 'acc', createdAt: nowMs });
    const nameRes = await mount(noName).request('/pos', {
      method: 'POST',
      headers: AUTH,
      body: '{"amountSats":21}',
    });
    expect(nameRes.status).toBe(400);
    expect(await nameRes.json()).toEqual({ error: 'Set a username first' });

    const addr = await mount(await readyStore(false)).request('/pos', {
      method: 'POST',
      headers: AUTH,
      body: '{"amountSats":21}',
    });
    expect(addr.status).toBe(400);
    expect(await addr.json()).toEqual({
      error: 'Set up your wallet first',
      code: 'wallet_required',
    });
  });

  it('creates one open charge, pins LNURL bounds, and cancels it', async () => {
    const auth = await readyStore();
    const pos = new InMemoryPosStore();
    const fetchImpl = lnurlFetch();
    const app = createApp({
      authStore: auth,
      posStore: pos,
      now,
      fetchImpl,
      env: {
        ...process.env,
        LNURL_SERVER_URL: LNURL_SERVER.baseUrl,
        PUBLIC_BASE_URL: LNURL_SERVER.publicBaseUrl,
      },
    });
    const empty = await app.request('/pos', { headers: AUTH });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ charge: null, history: [] });
    const created = await app.request('/pos', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ amountSats: 21 }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      charge: { amountSats: number; expiresAt: string };
    };
    expect(createdBody.charge.amountSats).toBe(21);
    expect(Date.parse(createdBody.charge.expiresAt) - nowMs).toBe(POS_CHARGE_TTL_MS);

    const again = await app.request('/pos', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ amountSats: 21 }),
    });
    expect(again.status).toBe(409);

    const listed = await app.request('/pos', { headers: AUTH });
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { charge: { amountSats: number } | null };
    expect(listedBody.charge?.amountSats).toBe(21);

    const lnurl = await app.request('/.well-known/lnurlp/ada');
    expect(lnurl.status).toBe(200);
    expect(lnurl.headers.get('Cache-Control')).toBe('no-store');
    const pay = (await lnurl.json()) as {
      minSendable: number;
      maxSendable: number;
      callback: string;
    };
    expect(pay.minSendable).toBe(21_000);
    expect(pay.maxSendable).toBe(21_000);
    expect(pay.callback).toBe(CALLBACK);

    const removed = await app.request('/pos', { method: 'DELETE', headers: AUTH });
    expect(removed.status).toBe(200);
    const gone = await app.request('/pos', { method: 'DELETE', headers: AUTH });
    expect(gone.status).toBe(404);

    const unpinned = await app.request('/.well-known/lnurlp/ada');
    const open = (await unpinned.json()) as { minSendable: number; maxSendable: number };
    expect(open.minSendable).toBe(1000);
    expect(open.maxSendable).toBe(100_000_000);
  });

  it('rejects an amount outside the wallet range and an unreachable address', async () => {
    const auth = await readyStore();
    const low = await mount(auth, lnurlFetch(50_000)).request('/pos', {
      method: 'POST',
      headers: AUTH,
      body: '{"amountSats":21}',
    });
    expect(low.status).toBe(400);
    expect(await low.json()).toEqual({ error: 'Amount is outside the wallet range' });

    const high = await mount(auth, lnurlFetch()).request('/pos', {
      method: 'POST',
      headers: AUTH,
      body: '{"amountSats":100000000}',
    });
    expect(high.status).toBe(400);
    expect(await high.json()).toEqual({ error: 'Amount is outside the wallet range' });

    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const failed = await mount(await readyStore(), down).request('/pos', {
      method: 'POST',
      headers: AUTH,
      body: '{"amountSats":21}',
    });
    expect(failed.status).toBe(502);
  });

  it('returns 409 when a second insert overlaps an open charge', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fetches = 0;
    const fetchImpl = (async () => {
      fetches += 1;
      if (fetches === 1) {
        await gate;
      }
      return new Response(
        JSON.stringify({
          callback: CALLBACK,
          minSendable: 1000,
          maxSendable: 100_000_000,
          metadata: '[["text/plain","ada"]]',
          tag: 'payRequest',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const app = mount(await readyStore(), fetchImpl);
    const first = app.request('/pos', {
      method: 'POST',
      headers: AUTH,
      body: '{"amountSats":21}',
    });
    await vi.waitFor(() => {
      expect(fetches).toBe(1);
    });
    const second = await app.request('/pos', {
      method: 'POST',
      headers: AUTH,
      body: '{"amountSats":21}',
    });
    release();
    const opened = await first;
    expect([opened.status, second.status].sort()).toEqual([201, 409]);
    const conflict = opened.status === 409 ? opened : second;
    expect(await conflict.json()).toEqual({ error: 'A payment is already open' });
  });

  it('maps a unique violation and an already-open error to 409 and rethrows the rest', async () => {
    const auth = await readyStore();
    const base = new InMemoryPosStore();
    function routes(create: PosStore['create']): Hono {
      const store: PosStore = {
        currentPending: (accountId, nowMs) => base.currentPending(accountId, nowMs),
        create,
        cancelPending: (accountId, nowMs) => base.cancelPending(accountId, nowMs),
        listForAccount: (accountId, limit) => base.listForAccount(accountId, limit),
        listLatest: (limit) => base.listLatest(limit),
        listCreatedBetween: (startMs, endMs) => base.listCreatedBetween(startMs, endMs),
        issueSparkInvoice: (chargeId, invoice, nowMs) =>
          base.issueSparkInvoice(chargeId, invoice, nowMs),
        recordInvoice: (chargeId, paymentHash, nowMs) =>
          base.recordInvoice(chargeId, paymentHash, nowMs),
        findChargeForPayment: (ref) => base.findChargeForPayment(ref),
        listWatched: (sinceMs) => base.listWatched(sinceMs),
        markPaid: (chargeId, paidAtMs) => base.markPaid(chargeId, paidAtMs),
        deleteInvoice: (paymentHash) => base.deleteInvoice(paymentHash),
      };
      return new Hono().route(
        '/pos',
        posRoutes({
          store,
          authStore: auth,
          now,
          fetchImpl: lnurlFetch(),
          lnurlServer: LNURL_SERVER,
        }),
      );
    }
    const unique = await routes(() =>
      Promise.reject(Object.assign(new Error('duplicate key'), { code: '23505' })),
    ).request('/pos', { method: 'POST', headers: AUTH, body: '{"amountSats":21}' });
    expect(unique.status).toBe(409);
    expect(await unique.json()).toEqual({ error: 'A payment is already open' });

    const already = await routes(() =>
      Promise.reject(new Error('A payment is already open')),
    ).request('/pos', { method: 'POST', headers: AUTH, body: '{"amountSats":21}' });
    expect(already.status).toBe(409);

    const other = await routes(() => Promise.reject(new Error('create boom'))).request('/pos', {
      method: 'POST',
      headers: AUTH,
      body: '{"amountSats":21}',
    });
    expect(other.status).toBe(500);

    await expect(
      routes(() => Promise.reject('nope')).request('/pos', {
        method: 'POST',
        headers: AUTH,
        body: '{"amountSats":21}',
      }),
    ).rejects.toBe('nope');
  });

  it('does not list shops when activity is omitted', async () => {
    const listLiveAssignedShops = vi.fn(async () => [
      { id: 'shop-1', accountId: 'acc', text: 'Open #21GiftsShop' },
    ]);
    const app = mount(await readyStore(), lnurlFetch(), {
      messageStore: { listLiveAssignedShops },
    });
    const created = await app.request('/pos', {
      method: 'POST',
      headers: AUTH,
      body: '{"amountSats":21}',
    });
    expect(created.status).toBe(201);
    expect(listLiveAssignedShops).not.toHaveBeenCalled();
  });

  it('does not ping when messageStore is omitted', async () => {
    const { activity, calls } = recordingActivity();
    const app = mount(await readyStore(), lnurlFetch(), { activity });
    const created = await app.request('/pos', {
      method: 'POST',
      headers: AUTH,
      body: '{"amountSats":21}',
    });
    expect(created.status).toBe(201);
    expect(calls).toEqual([]);
  });

  it('pings one matching shop at the charge createdAt', async () => {
    const { activity, calls } = recordingActivity();
    const app = mount(await readyStore(), lnurlFetch(), {
      messageStore: shops([{ id: 'shop-1', accountId: 'acc', text: 'Open #21GiftsShop' }]),
      activity,
    });
    const created = await app.request('/pos', {
      method: 'POST',
      headers: AUTH,
      body: '{"amountSats":21}',
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { charge: { createdAt: string } };
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://map.test/map/places/transactions');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.authorization).toBe('Bearer secret');
    expect(calls[0]?.contentType).toBe('application/json');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      origin: '21gifts',
      externalId: 'shop-1',
      occurredAt: createdBody.charge.createdAt,
    });
  });

  it('pings two matching shops in list order', async () => {
    const { activity, calls } = recordingActivity();
    const app = mount(await readyStore(), lnurlFetch(), {
      messageStore: shops([
        { id: 'shop-1', accountId: 'acc', text: 'Open #21GiftsShop' },
        { id: 'shop-2', accountId: 'acc', text: 'Also #21GiftsShop' },
      ]),
      activity,
    });
    const created = await app.request('/pos', {
      method: 'POST',
      headers: AUTH,
      body: '{"amountSats":21}',
    });
    expect(created.status).toBe(201);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({ externalId: 'shop-1' });
    expect(JSON.parse(calls[1]?.body ?? '{}')).toMatchObject({ externalId: 'shop-2' });
  });

  it('does not post a note for another accountId', async () => {
    const { activity, calls } = recordingActivity();
    const app = mount(await readyStore(), lnurlFetch(), {
      messageStore: shops([
        { id: 'other', accountId: 'other', text: 'Open #21GiftsShop' },
        { id: 'shop-1', accountId: 'acc', text: 'Open #21GiftsShop' },
      ]),
      activity,
    });
    const created = await app.request('/pos', {
      method: 'POST',
      headers: AUTH,
      body: '{"amountSats":21}',
    });
    expect(created.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({ externalId: 'shop-1' });
  });

  it('does not post a note without the shop hashtag token', async () => {
    const { activity, calls } = recordingActivity();
    const app = mount(await readyStore(), lnurlFetch(), {
      messageStore: shops([
        { id: 'shopping', accountId: 'acc', text: 'Open #21GiftsShopping' },
        { id: 'shop-1', accountId: 'acc', text: 'Open #21GiftsShop' },
      ]),
      activity,
    });
    const created = await app.request('/pos', {
      method: 'POST',
      headers: AUTH,
      body: '{"amountSats":21}',
    });
    expect(created.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({ externalId: 'shop-1' });
  });

  it('returns 201 when listLiveAssignedShops rejects and does not fetch the map', async () => {
    const { activity, calls } = recordingActivity();
    const app = mount(await readyStore(), lnurlFetch(), {
      messageStore: {
        listLiveAssignedShops: async () => {
          throw new Error('list-must-not-appear');
        },
      },
      activity,
    });
    const created = await app.request('/pos', {
      method: 'POST',
      headers: AUTH,
      body: '{"amountSats":21}',
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { charge: { amountSats: number } };
    expect(createdBody.charge.amountSats).toBe(21);
    expect(calls).toEqual([]);
    const failed = parsedEvents(warn).filter((e) => e['event'] === 'ocp.activity.failed');
    expect(failed).toHaveLength(1);
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).not.toContain('list-must-not-appear');
  });

  it('returns 201 with the charge when the map fetch throws', async () => {
    const activity: ActivityPing = {
      baseUrl: 'http://map.test',
      token: 'secret',
      fetchImpl: async () => {
        throw new Error('map-down');
      },
    };
    const app = mount(await readyStore(), lnurlFetch(), {
      messageStore: shops([{ id: 'shop-1', accountId: 'acc', text: 'Open #21GiftsShop' }]),
      activity,
    });
    const created = await app.request('/pos', {
      method: 'POST',
      headers: AUTH,
      body: '{"amountSats":21}',
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { charge: { amountSats: number } };
    expect(createdBody.charge.amountSats).toBe(21);
  });

  it('returns 201 with the charge on map HTTP 404 and logs status', async () => {
    const { activity } = recordingActivity(404);
    const app = mount(await readyStore(), lnurlFetch(), {
      messageStore: shops([{ id: 'shop-1', accountId: 'acc', text: 'Open #21GiftsShop' }]),
      activity,
    });
    const created = await app.request('/pos', {
      method: 'POST',
      headers: AUTH,
      body: '{"amountSats":21}',
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { charge: { amountSats: number } };
    expect(createdBody.charge.amountSats).toBe(21);
    const failed = parsedEvents(warn).filter((e) => e['event'] === 'ocp.activity.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.['status']).toBe(404);
  });

  it('returns 201 with the charge on map HTTP 200 and logs no failure', async () => {
    const { activity } = recordingActivity(200);
    const app = mount(await readyStore(), lnurlFetch(), {
      messageStore: shops([{ id: 'shop-1', accountId: 'acc', text: 'Open #21GiftsShop' }]),
      activity,
    });
    const created = await app.request('/pos', {
      method: 'POST',
      headers: AUTH,
      body: '{"amountSats":21}',
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { charge: { amountSats: number } };
    expect(createdBody.charge.amountSats).toBe(21);
    expect(parsedEvents(warn).filter((e) => e['event'] === 'ocp.activity.failed')).toHaveLength(0);
  });

  it('does not ping the map on GET or DELETE', async () => {
    const { activity, calls } = recordingActivity();
    const pos = new InMemoryPosStore();
    await pos.create({
      id: 'charge-1',
      accountId: 'acc',
      amountSats: 21,
      status: 'pending',
      createdAt: new Date(nowMs),
      expiresAt: new Date(nowMs + POS_CHARGE_TTL_MS),
      paidAt: null,
      sparkInvoice: null,
      amountCurrency: null,
      amountText: null,
      fiatUsd: null,
      fiatChf: null,
      fiatEur: null,
      fiatPhp: null,
    });
    const app = mount(await readyStore(), lnurlFetch(), {
      store: pos,
      messageStore: shops([{ id: 'shop-1', accountId: 'acc', text: 'Open #21GiftsShop' }]),
      activity,
    });
    const listed = await app.request('/pos', { headers: AUTH });
    expect(listed.status).toBe(200);
    const removed = await app.request('/pos', { method: 'DELETE', headers: AUTH });
    expect(removed.status).toBe(200);
    expect(calls).toEqual([]);
  });
});

describe('POS for a wallet-backed member', () => {
  async function walletPos(lnurlServer: boolean): Promise<{ app: Hono; seen: SeenRequest[] }> {
    const auth = new InMemoryAuthStore();
    await createWalletAccount(auth, 'wal', 'wally');
    await auth.createSession({ token: 'tok', accountId: 'wal', createdAt: nowMs });
    const { fetchImpl, seen } = walletLnurlFetch('wally');
    const app = new Hono().route(
      '/pos',
      posRoutes({
        store: new InMemoryPosStore(),
        authStore: auth,
        now,
        fetchImpl,
        ...(lnurlServer ? { lnurlServer: LNURL_SERVER } : {}),
      }),
    );
    return { app, seen };
  }

  it('checks the amount against the wallet resolved internally', async () => {
    const { app, seen } = await walletPos(true);
    const res = await app.request('/pos', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ amountSats: 21 }),
    });
    expect(res.status).toBe(201);
    expect(allInternal(seen)).toBe(true);
  });

  it('asks for a wallet when the LNURL server is off', async () => {
    const { app, seen } = await walletPos(false);
    const res = await app.request('/pos', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ amountSats: 21 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Set up your wallet first',
      code: 'wallet_required',
    });
    expect(seen).toEqual([]);
  });
});

describe('GET /pos paid confirmation', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let clock: number;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    clock = nowMs;
  });

  afterEach(() => {
    warn.mockRestore();
  });

  function row(partial: Partial<PosCharge> & Pick<PosCharge, 'id'>): PosCharge {
    return {
      accountId: 'acc',
      amountSats: 21,
      status: 'pending',
      createdAt: new Date(nowMs),
      expiresAt: new Date(nowMs + POS_CHARGE_TTL_MS),
      paidAt: null,
      sparkInvoice: null,
      amountCurrency: null,
      amountText: null,
      fiatUsd: null,
      fiatChf: null,
      fiatEur: null,
      fiatPhp: null,
      ...partial,
    };
  }

  async function tillApp(store: PosStore): Promise<Hono> {
    return new Hono().route(
      '/pos',
      posRoutes({
        store,
        authStore: await readyStore(),
        now: () => clock,
        fetchImpl: lnurlFetch(),
        lnurlServer: LNURL_SERVER,
      }),
    );
  }

  async function read(app: Hono): Promise<{ charge: unknown; history: unknown[] }> {
    return (await (await app.request('/pos', { headers: AUTH })).json()) as {
      charge: unknown;
      history: unknown[];
    };
  }

  it('keeps a charge paid within the last 60 s as charge, then only in history', async () => {
    const store = new InMemoryPosStore();
    await store.create(row({ id: 'c1', sparkInvoice: 'spark1x' }));
    await store.markPaid('c1', nowMs + 10_000);
    const app = await tillApp(store);
    const paidJson = {
      id: 'c1',
      amountSats: 21,
      status: 'paid',
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + POS_CHARGE_TTL_MS).toISOString(),
      paidAt: new Date(nowMs + 10_000).toISOString(),
      amountCurrency: null,
      amount: null,
      amountUsd: null,
      amountChf: null,
      amountEur: null,
      amountPhp: null,
    };
    clock = nowMs + 10_000 + POS_PAID_SHOW_MS - 1;
    const shown = await read(app);
    expect(shown).toEqual({ charge: paidJson, history: [paidJson] });
    // Without the LNURL server (no shop payment service) the key is absent.
    expect(shown.charge).not.toHaveProperty('shopPayment');
    clock = nowMs + 10_000 + POS_PAID_SHOW_MS;
    expect(await read(app)).toEqual({ charge: null, history: [paidJson] });
  });

  it('prefers the pending charge over an older paid one', async () => {
    const store = new InMemoryPosStore();
    await store.create(row({ id: 'c1' }));
    await store.markPaid('c1', nowMs + 1_000);
    await store.create(row({ id: 'c2', createdAt: new Date(nowMs + 2_000) }));
    clock = nowMs + 3_000;
    const body = (await read(await tillApp(store))) as { charge: { id: string; status: string } };
    expect(body.charge).toEqual(expect.objectContaining({ id: 'c2', status: 'pending' }));
  });

  it('does not show a newest row that is not paid, or a paid row without paidAt', async () => {
    const cancelled = new InMemoryPosStore();
    await cancelled.create(row({ id: 'c1', status: 'cancelled' }));
    expect((await read(await tillApp(cancelled))).charge).toBeNull();
    const legacy = new InMemoryPosStore();
    await legacy.create(row({ id: 'c1', status: 'paid' }));
    expect((await read(await tillApp(legacy))).charge).toBeNull();
    expect(await read(await tillApp(new InMemoryPosStore()))).toEqual({
      charge: null,
      history: [],
    });
  });
});

describe('POS with shop payments', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  async function shopApp(
    store: PosStore,
    shopPayments: ShopPayments,
  ): Promise<{ app: Hono; auth: InMemoryAuthStore }> {
    const auth = await readyStore();
    const app = new Hono().route(
      '/pos',
      posRoutes({
        store,
        authStore: auth,
        now,
        fetchImpl: lnurlFetch(),
        lnurlServer: LNURL_SERVER,
        shopPayments,
      }),
    );
    return { app, auth };
  }

  function realShop(store: InMemoryPosStore, auth: InMemoryAuthStore): ShopPayments {
    return new ShopPayments({
      store: new InMemoryShopPaymentStore(store),
      posStore: store,
      auth,
      lnurlServer: LNURL_SERVER,
      config: null,
      orchestra: null,
      fxSpot: new InMemoryFxSpotStore(),
      fetchImpl: lnurlFetch(),
      now,
    });
  }

  it('creates, shows, and cancels a charge through the shop payment service', async () => {
    const pos = new InMemoryPosStore();
    const auth = await readyStore();
    const shop = realShop(pos, auth);
    const createCharge = vi.spyOn(shop, 'createCharge');
    const cancelCharge = vi.spyOn(shop, 'cancelCharge');
    const app = new Hono().route(
      '/pos',
      posRoutes({
        store: pos,
        authStore: auth,
        now,
        fetchImpl: lnurlFetch(),
        lnurlServer: LNURL_SERVER,
        shopPayments: shop,
      }),
    );
    expect(await (await app.request('/pos', { headers: AUTH })).json()).toEqual({
      charge: null,
      history: [],
    });
    const created = await app.request('/pos', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ amountSats: 21 }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { charge: { id: string; amountSats: number } };
    expect(body.charge.amountSats).toBe(21);
    expect(createCharge).toHaveBeenCalledTimes(1);
    const stored = await pos.currentPending('acc', nowMs);
    expect(stored?.id).toBe(body.charge.id);

    const listed = (await (await app.request('/pos', { headers: AUTH })).json()) as {
      charge: { id: string; shopPayment: unknown };
    };
    expect(listed.charge.id).toBe(body.charge.id);
    expect(listed.charge.shopPayment).toBeNull();

    const removed = await app.request('/pos', { method: 'DELETE', headers: AUTH });
    expect(removed.status).toBe(200);
    expect(cancelCharge).toHaveBeenCalledWith('acc', nowMs);
    expect(await pos.currentPending('acc', nowMs)).toBeNull();
    const gone = await app.request('/pos', { method: 'DELETE', headers: AUTH });
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: 'No open payment' });
  });

  it('shows the charge shop payment id and status', async () => {
    const pos = new InMemoryPosStore();
    const charge: PosCharge = {
      id: 'c1',
      accountId: 'acc',
      amountSats: 21,
      status: 'pending',
      createdAt: new Date(nowMs),
      expiresAt: new Date(nowMs + POS_CHARGE_TTL_MS),
      paidAt: null,
      sparkInvoice: null,
      amountCurrency: null,
      amountText: null,
      fiatUsd: null,
      fiatChf: null,
      fiatEur: null,
      fiatPhp: null,
    };
    await pos.create(charge);
    const shopPaymentOfCharge = vi.fn(async () => ({ id: 'p1', status: 'accepted' as const }));
    const { app } = await shopApp(pos, { shopPaymentOfCharge } as unknown as ShopPayments);
    const body = (await (await app.request('/pos', { headers: AUTH })).json()) as {
      charge: { id: string; shopPayment: unknown };
      history: Array<Record<string, unknown>>;
    };
    expect(body.charge.shopPayment).toEqual({ id: 'p1', status: 'accepted' });
    expect(shopPaymentOfCharge).toHaveBeenCalledWith('c1');
    expect(body.history[0]).not.toHaveProperty('shopPayment');
  });

  it('answers 409 when the service finds a pending charge at insert time', async () => {
    const pos = new InMemoryPosStore();
    const createCharge = vi.fn(async () => false);
    const { app } = await shopApp(pos, { createCharge } as unknown as ShopPayments);
    const res = await app.request('/pos', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ amountSats: 21 }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'A payment is already open' });
    expect(createCharge).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'acc' }),
      expect.objectContaining({ accountId: 'acc', amountSats: 21, status: 'pending' }),
      nowMs,
    );
    expect(await pos.currentPending('acc', nowMs)).toBeNull();
  });
});

describe('POST /pos typed fiat', () => {
  const NULL_JSON = {
    amountCurrency: null,
    amount: null,
    amountUsd: null,
    amountChf: null,
    amountEur: null,
    amountPhp: null,
  };

  function spot(rates: FxSpotQuote['rates'], latestThrows = false): FxSpotStore {
    return {
      latest: async () => {
        if (latestThrows) {
          throw new Error('spot down');
        }
        return { asOf: '2026-10-20T00:00:00.000Z', source: 'coinbase-exchange-rates', rates };
      },
      save: async () => undefined,
    };
  }

  async function till(quote?: FxSpotStore): Promise<{ app: Hono; store: InMemoryPosStore }> {
    const store = new InMemoryPosStore();
    const app = new Hono().route(
      '/pos',
      posRoutes({
        store,
        authStore: await readyStore(),
        now,
        fetchImpl: lnurlFetch(),
        lnurlServer: LNURL_SERVER,
        ...(quote === undefined ? {} : { spot: quote }),
      }),
    );
    return { app, store };
  }

  async function post(app: Hono, body: unknown): Promise<Response> {
    return app.request('/pos', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('stores six nulls for a sats-only body', async () => {
    const { app, store } = await till();
    const res = await post(app, { amountSats: 21 });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { charge: object }).charge).toEqual(
      expect.objectContaining({ amountSats: 21, ...NULL_JSON }),
    );
    expect(await store.listLatest(1)).toEqual([
      expect.objectContaining({
        amountSats: 21,
        amountCurrency: null,
        amountText: null,
        fiatUsd: null,
        fiatChf: null,
        fiatEur: null,
        fiatPhp: null,
      }),
    ]);
  });

  it('keeps 12.00 PHP and freezes the other three from the spot', async () => {
    const { app, store } = await till(
      spot({ USD: '100000', CHF: '90000', EUR: '95000', PHP: '5000000' }),
    );
    const res = await post(app, { amountSats: 21, amountCurrency: 'PHP', amount: '12.00' });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { charge: object }).charge).toEqual(
      expect.objectContaining({
        amountSats: 21,
        amountCurrency: 'PHP',
        amount: '12.00',
        amountUsd: '0.24',
        amountChf: '0.22',
        amountEur: '0.23',
        amountPhp: '12.00',
      }),
    );
    expect((await store.listLatest(1))[0]).toEqual(
      expect.objectContaining({
        amountSats: 21,
        amountCurrency: 'PHP',
        amountText: '12.00',
        fiatUsd: '0.24',
        fiatChf: '0.22',
        fiatEur: '0.23',
        fiatPhp: null,
      }),
    );
  });

  it('leaves a missing spot leg null', async () => {
    const { app, store } = await till(spot({ USD: '100000', CHF: '90000', PHP: '5000000' }));
    const res = await post(app, { amountSats: 21, amountCurrency: 'PHP', amount: '12.00' });
    expect(res.status).toBe(201);
    const charge = ((await res.json()) as { charge: Record<string, unknown> }).charge;
    expect(charge['amountEur']).toBeNull();
    expect(charge['amountUsd']).toBe('0.24');
    expect(charge['amountPhp']).toBe('12.00');
    expect((await store.listLatest(1))[0]?.fiatEur).toBeNull();
    expect((await store.listLatest(1))[0]?.fiatPhp).toBeNull();
  });

  it('still stores the typed string when the spot read throws', async () => {
    const { app, store } = await till(
      spot({ USD: '100000', CHF: '90000', EUR: '95000', PHP: '5000000' }, true),
    );
    const res = await post(app, { amountSats: 21, amountCurrency: 'PHP', amount: '12.00' });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { charge: object }).charge).toEqual(
      expect.objectContaining({
        amountSats: 21,
        amountCurrency: 'PHP',
        amount: '12.00',
        amountPhp: '12.00',
        amountUsd: null,
        amountChf: null,
        amountEur: null,
      }),
    );
    expect((await store.listLatest(1))[0]).toEqual(
      expect.objectContaining({
        amountText: '12.00',
        fiatUsd: null,
        fiatChf: null,
        fiatEur: null,
        fiatPhp: null,
      }),
    );
  });

  it('rejects a currency and an amount that are not sent together', async () => {
    const { app } = await till();
    const currencyOnly = await post(app, { amountSats: 21, amountCurrency: 'PHP' });
    const amountOnly = await post(app, { amountSats: 21, amount: '12.00' });
    expect(currencyOnly.status).toBe(400);
    expect(await currencyOnly.json()).toEqual({
      error: 'Expected amountCurrency and amount together',
    });
    expect(amountOnly.status).toBe(400);
    expect(await amountOnly.json()).toEqual({
      error: 'Expected amountCurrency and amount together',
    });
  });

  it('rejects a bad amount or a bad currency', async () => {
    const { app } = await till();
    const zero = await post(app, { amountSats: 21, amountCurrency: 'PHP', amount: '0' });
    const jpy = await post(app, { amountSats: 21, amountCurrency: 'JPY', amount: '12.00' });
    expect(zero.status).toBe(400);
    expect(await zero.json()).toEqual({ error: 'Expected a typed fiat amount' });
    expect(jpy.status).toBe(400);
    expect(await jpy.json()).toEqual({ error: 'Expected a typed fiat amount' });
  });

  it('keeps a trimmed comma amount and the client amountSats', async () => {
    const { app, store } = await till(
      spot({ USD: '100000', CHF: '90000', EUR: '95000', PHP: '5000000' }),
    );
    const res = await post(app, { amountSats: 21, amountCurrency: 'PHP', amount: ' 12,00 ' });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { charge: object }).charge).toEqual(
      expect.objectContaining({ amountSats: 21, amount: '12.00', amountPhp: '12.00' }),
    );
    expect((await store.listLatest(1))[0]?.amountSats).toBe(21);
    expect((await store.listLatest(1))[0]?.amountText).toBe('12.00');
  });
});
