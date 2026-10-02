import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import type { ShopNoteRef } from '@/lib/message-store';
import type { ActivityPing } from '@/lib/ocp-activity';
import type { MapFetch } from '@/lib/ocp-place';
import { InMemoryPosStore, type PosStore } from '@/lib/pos-store';
import { POS_CHARGE_TTL_MS } from '@/lib/pos-charge';
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
    expect(await addr.json()).toEqual({ error: 'Set up your wallet first' });
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
    expect(await res.json()).toEqual({ error: 'Set up your wallet first' });
    expect(seen).toEqual([]);
  });
});
