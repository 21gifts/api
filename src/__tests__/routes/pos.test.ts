import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { InMemoryPosStore, type PosStore } from '@/lib/pos-store';
import { POS_CHARGE_TTL_MS } from '@/lib/pos-charge';
import { posRoutes } from '@/routes/pos';
import { createApp } from '@/server';

const nowMs = 1_700_000_000_000;
const now = (): number => nowMs;
const AUTH = { authorization: 'Bearer tok' };

function wosFetch(minSendable = 1000, maxSendable = 100_000_000): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        callback: 'https://walletofsatoshi.com/lnurlp/callback',
        minSendable,
        maxSendable,
        metadata: '[["text/plain","ada"]]',
        tag: 'payRequest',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
}

async function readyStore(): Promise<InMemoryAuthStore> {
  const store = new InMemoryAuthStore();
  await store.createAccount({
    id: 'acc',
    linkingKey: null,
    role: 'basis',
    name: 'Ada',
    username: 'ada',
    lightningAddress: 'alice@walletofsatoshi.com',
    lightningAddressVerified: true,
    forumLawsDismissed: false,
    location: null,
    viewKey: 'a'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: nowMs,
  });
  await store.createSession({ token: 'tok', accountId: 'acc', createdAt: nowMs });
  return store;
}

function mount(authStore: InMemoryAuthStore, fetchImpl: typeof fetch = wosFetch()): Hono {
  return new Hono().route(
    '/pos',
    posRoutes({ store: new InMemoryPosStore(), authStore, now, fetchImpl }),
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

  it('rejects a bad body, missing username, and missing lightning address', async () => {
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
      lightningAddress: 'alice@walletofsatoshi.com',
      lightningAddressVerified: true,
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

    const existing = await auth.getAccount('acc');
    if (existing === undefined) {
      throw new Error('expected account');
    }
    await auth.updateAccount({ ...existing, lightningAddress: null });
    const addr = await mount(auth).request('/pos', {
      method: 'POST',
      headers: AUTH,
      body: '{"amountSats":21}',
    });
    expect(addr.status).toBe(400);
    expect(await addr.json()).toEqual({ error: 'Set a Wallet of Satoshi address first' });
  });

  it('creates one open charge, pins LNURL bounds, and cancels it', async () => {
    const auth = await readyStore();
    const pos = new InMemoryPosStore();
    const fetchImpl = wosFetch();
    const app = createApp({ authStore: auth, posStore: pos, now, fetchImpl });
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
    expect(pay.callback).toBe('https://walletofsatoshi.com/lnurlp/callback');

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
    const low = await mount(auth, wosFetch(50_000)).request('/pos', {
      method: 'POST',
      headers: AUTH,
      body: '{"amountSats":21}',
    });
    expect(low.status).toBe(400);
    expect(await low.json()).toEqual({ error: 'Amount is outside the wallet range' });

    const high = await mount(auth, wosFetch()).request('/pos', {
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
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
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
      };
      return new Hono().route(
        '/pos',
        posRoutes({ store, authStore: auth, now, fetchImpl: wosFetch() }),
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
});
