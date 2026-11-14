import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import {
  InMemoryWalletStore,
  type WalletBalanceSnapshot,
  type WalletPaymentCursor,
  type WalletPaymentRecord,
  type WalletPaymentTotals,
  type WalletStore,
} from '@/lib/wallet-store';
import {
  debugWalletRoutes,
  decodeWalletPaymentCursor,
  encodeWalletPaymentCursor,
} from '@/routes/debug-wallet';

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const T1 = new Date('2026-10-01T00:00:00.000Z');
const T2 = new Date('2026-10-02T00:00:00.000Z');
const RECEIVED = new Date('2026-10-01T23:56:47.001Z');

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

function payment(paymentId: string, paidAt: Date): WalletPaymentRecord {
  return {
    accountId: ACCOUNT_ID,
    paymentId,
    direction: 'out',
    status: 'completed',
    amountSats: 21,
    feeSats: 1,
    paidAt,
    method: 'spark',
    paymentHash: null,
    invoice: null,
    destination: 'alice@example.test',
    description: 'coffee',
    lnurlComment: null,
    category: 'member',
    counterpartyAccountId: OTHER_ID,
    firstSeenAt: T1,
    updatedAt: T2,
  };
}

class FailingWalletStore implements WalletStore {
  recordBalance(_snapshot: WalletBalanceSnapshot): Promise<void> {
    return Promise.reject(new Error('sql failed'));
  }

  upsertPayments(_rows: readonly WalletPaymentRecord[]): Promise<void> {
    return Promise.reject(new Error('sql failed'));
  }

  latestBalance(
    _accountId: string,
    _walletPubkey: string | null,
  ): Promise<WalletBalanceSnapshot | undefined> {
    return Promise.reject(new Error('sql failed'));
  }

  dailyBalances(): Promise<WalletBalanceSnapshot[]> {
    return Promise.reject(new Error('sql failed'));
  }

  paymentTotals(_accountId: string): Promise<WalletPaymentTotals> {
    return Promise.reject(new Error('sql failed'));
  }

  listPayments(
    _accountId: string,
    _limit: number,
    _after?: WalletPaymentCursor,
  ): Promise<WalletPaymentRecord[]> {
    return Promise.reject(new Error('sql failed'));
  }

  findCompletedPayments(
    _accountId: string,
    _keys: readonly {
      id: string;
      direction: 'in' | 'out';
    }[],
  ): Promise<Set<string>> {
    return Promise.reject(new Error('sql failed'));
  }
}

async function walletApp(
  options: {
    debugToken?: string | undefined;
    debugReadToken?: string;
    now?: () => number;
    walletStore?: WalletStore;
    withAccount?: boolean;
    walletPubkey?: string;
  } = {},
): Promise<Hono> {
  const authStore = new InMemoryAuthStore();
  if (options.withAccount !== false) {
    await authStore.createAccount({
      id: ACCOUNT_ID,
      linkingKey: null,
      role: 'verified',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: T1.getTime(),
      rulesAgreedAt: T1.getTime(),
      username: 'ada',
      walletRequired: true,
    });
    if (options.walletPubkey !== undefined) {
      await authStore.claimSparkPubkey(ACCOUNT_ID, options.walletPubkey);
      await authStore.markSparkPubkeyVerified(
        ACCOUNT_ID,
        options.walletPubkey,
        'ada',
        T1.getTime(),
      );
    }
  }
  return new Hono().route(
    '/debug/accounts',
    debugWalletRoutes({
      walletStore: options.walletStore ?? new InMemoryWalletStore(),
      authStore,
      debugToken: options.debugToken,
      ...(options.debugReadToken === undefined ? {} : { debugReadToken: options.debugReadToken }),
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
  );
}

describe('wallet payment cursor', () => {
  it('round-trips paidAt and paymentId and refuses malformed cursors', () => {
    const cursor = { paidAt: T2, paymentId: 'pay-1' };
    const encoded = encodeWalletPaymentCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeWalletPaymentCursor(encoded)).toEqual(cursor);

    const json = (value: unknown): string =>
      Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    for (const raw of [
      '',
      'not+base64url',
      'ab',
      Buffer.from('not json', 'utf8').toString('base64url'),
      json([]),
      json(null),
      json(3),
      json({ paidAt: T2.toISOString() }),
      json({ paidAt: T2.toISOString(), extra: 'x' }),
      json({ paidAt: 3, paymentId: 'pay-1' }),
      json({ paidAt: T2.toISOString(), paymentId: '' }),
      json({ paidAt: T2.toISOString(), paymentId: 3 }),
      json({ paidAt: 'not-a-date', paymentId: 'pay-1' }),
      json({ paidAt: '2026-02-30T00:00:00Z', paymentId: 'pay-1' }),
      json({ paidAt: T2.toISOString(), paymentId: 'pay-1', extra: true }),
    ]) {
      expect(decodeWalletPaymentCursor(raw)).toBeNull();
    }
    expect(decodeWalletPaymentCursor(`${encoded}=`)).toBeNull();
    expect(
      decodeWalletPaymentCursor(json({ paidAt: '2026-10-02T00:00:00Z', paymentId: 'pay-1' })),
    ).toEqual(cursor);
  });
});

describe('debugWalletRoutes', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns 503 when debug is not configured or both tokens are blank', async () => {
    const app = await walletApp({ debugToken: undefined });
    const res = await app.request(`/debug/accounts/${ACCOUNT_ID}/wallet`);
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: 'Debug is not configured' });
    const blank = await walletApp({ debugToken: '   ', debugReadToken: '  ' });
    const blankRes = await blank.request(`/debug/accounts/${ACCOUNT_ID}/wallet`);
    expect(blankRes.status).toBe(503);
  });

  it('returns 401 when the bearer matches neither token', async () => {
    const app = await walletApp({ debugToken: 'secret' });
    const res = await app.request(`/debug/accounts/${ACCOUNT_ID}/wallet`, {
      headers: { authorization: 'Bearer other' },
    });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('accepts the write and read tokens', async () => {
    const app = await walletApp({ debugToken: 'write-secret', debugReadToken: 'read-secret' });
    for (const token of ['write-secret', 'read-secret']) {
      const res = await app.request(`/debug/accounts/${ACCOUNT_ID}/wallet`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
    }
    const readOnly = await walletApp({ debugToken: undefined, debugReadToken: 'read-only' });
    const res = await readOnly.request(`/debug/accounts/${ACCOUNT_ID}/wallet`, {
      headers: { authorization: 'Bearer read-only' },
    });
    expect(res.status).toBe(200);
  });

  it('returns 404 for a malformed or unknown account id', async () => {
    const app = await walletApp({ debugToken: 'secret' });
    for (const path of [
      '/debug/accounts/not-a-uuid/wallet',
      '/debug/accounts/cccccccc-cccc-4ccc-8ccc-cccccccccccc/wallet',
    ]) {
      const res = await app.request(path, { headers: { authorization: 'Bearer secret' } });
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: 'Not found' });
    }
  });

  it('returns 400 for a limit outside canonical decimal 1..500', async () => {
    const app = await walletApp({ debugToken: 'secret' });
    for (const limit of ['', '0', '501', '1000', '+1', '1e2', ' 1', '1 ', 'abc', '1.0']) {
      const res = await app.request(
        `/debug/accounts/${ACCOUNT_ID}/wallet?limit=${encodeURIComponent(limit)}`,
        { headers: { authorization: 'Bearer secret' } },
      );
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: 'Invalid limit' });
    }
    for (const limit of ['050', '500']) {
      const ok = await app.request(`/debug/accounts/${ACCOUNT_ID}/wallet?limit=${limit}`, {
        headers: { authorization: 'Bearer secret' },
      });
      expect(ok.status).toBe(200);
    }
  });

  it('returns 400 for a malformed cursor', async () => {
    const app = await walletApp({ debugToken: 'secret' });
    const res = await app.request(`/debug/accounts/${ACCOUNT_ID}/wallet?cursor=abc`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Invalid cursor' });
  });

  it('returns a null balance and an empty payment page when the account never reported', async () => {
    const app = await walletApp({ debugToken: 'secret' });
    const res = await app.request(`/debug/accounts/${ACCOUNT_ID}/wallet`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      accountId: ACCOUNT_ID,
      balance: null,
      payments: [],
    });
    expect(parsedEvents(warn)).toContainEqual(
      expect.objectContaining({ event: 'debug.wallet.shown', accountId: ACCOUNT_ID, count: 0 }),
    );
  });

  it('returns the newest balance with a floored, non-negative age and serialized payments', async () => {
    const store = new InMemoryWalletStore();
    const walletPubkey = `02${'d'.repeat(64)}`;
    await store.recordBalance({
      id: 'snapshot-1',
      accountId: ACCOUNT_ID,
      walletPubkey,
      balanceSats: 1000,
      syncedAt: T1,
      receivedAt: RECEIVED,
    });
    await store.upsertPayments([payment('pay-1', T2)]);
    const app = await walletApp({
      debugToken: 'secret',
      walletStore: store,
      walletPubkey,
      now: () => T2.getTime(),
    });
    const res = await app.request(`/debug/accounts/${ACCOUNT_ID}/wallet`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accountId: string;
      balance: Record<string, unknown>;
      payments: Array<Record<string, unknown>>;
    };
    expect(body.accountId).toBe(ACCOUNT_ID);
    expect(body.balance).toEqual({
      balanceSats: 1000,
      syncedAt: T1.toISOString(),
      receivedAt: RECEIVED.toISOString(),
      ageSeconds: 192,
    });
    expect(body.payments[0]).toEqual({
      accountId: ACCOUNT_ID,
      paymentId: 'pay-1',
      direction: 'out',
      status: 'completed',
      amountSats: 21,
      feeSats: 1,
      paidAt: T2.toISOString(),
      method: 'spark',
      paymentHash: null,
      invoice: null,
      destination: 'alice@example.test',
      description: 'coffee',
      lnurlComment: null,
      category: 'member',
      counterpartyAccountId: OTHER_ID,
      firstSeenAt: T1.toISOString(),
      updatedAt: T2.toISOString(),
    });
    expect(parsedEvents(warn)).toContainEqual(
      expect.objectContaining({ event: 'debug.wallet.shown', accountId: ACCOUNT_ID, count: 1 }),
    );
  });

  it('falls back to a legacy balance when the verified wallet has no keyed snapshot', async () => {
    const store = new InMemoryWalletStore();
    const walletPubkey = `02${'d'.repeat(64)}`;
    await store.recordBalance({
      id: 'legacy-snapshot',
      accountId: ACCOUNT_ID,
      walletPubkey: null,
      balanceSats: 1000,
      syncedAt: T1,
      receivedAt: RECEIVED,
    });
    const app = await walletApp({
      debugToken: 'secret',
      walletStore: store,
      walletPubkey,
      now: () => T2.getTime(),
    });

    const res = await app.request(`/debug/accounts/${ACCOUNT_ID}/wallet`, {
      headers: { authorization: 'Bearer secret' },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      balance: {
        balanceSats: 1000,
        syncedAt: T1.toISOString(),
        receivedAt: RECEIVED.toISOString(),
        ageSeconds: 192,
      },
    });
  });

  it('never reports a negative balance age when the clock is before receivedAt', async () => {
    const store = new InMemoryWalletStore();
    await store.recordBalance({
      id: 'snapshot-1',
      accountId: ACCOUNT_ID,
      balanceSats: 1,
      syncedAt: T2,
      receivedAt: T2,
    });
    const app = await walletApp({
      debugToken: 'secret',
      walletStore: store,
      now: () => T1.getTime(),
    });
    const res = await app.request(`/debug/accounts/${ACCOUNT_ID}/wallet`, {
      headers: { authorization: 'Bearer secret' },
    });
    const body = (await res.json()) as { balance: { ageSeconds: number } };
    expect(body.balance.ageSeconds).toBe(0);
  });

  it('returns at most limit rows and a nextCursor only when more rows exist', async () => {
    const store = new InMemoryWalletStore();
    await store.upsertPayments([payment('pay-c', T2), payment('pay-b', T1), payment('pay-a', T1)]);
    const app = await walletApp({
      debugToken: 'secret',
      walletStore: store,
      now: () => T2.getTime(),
    });
    const first = await app.request(`/debug/accounts/${ACCOUNT_ID}/wallet?limit=2`, {
      headers: { authorization: 'Bearer secret' },
    });
    const firstBody = (await first.json()) as {
      payments: Array<{ paymentId: string }>;
      nextCursor?: string;
    };
    expect(firstBody.payments.map((row) => row.paymentId)).toEqual(['pay-c', 'pay-b']);
    expect(firstBody.nextCursor).toBeDefined();
    const second = await app.request(
      `/debug/accounts/${ACCOUNT_ID}/wallet?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? '')}`,
      { headers: { authorization: 'Bearer secret' } },
    );
    const secondBody = (await second.json()) as {
      payments: Array<{ paymentId: string }>;
      nextCursor?: string;
    };
    expect(secondBody.payments.map((row) => row.paymentId)).toEqual(['pay-a']);
    expect(secondBody.nextCursor).toBeUndefined();
    expect(decodeWalletPaymentCursor(firstBody.nextCursor ?? '')).toEqual({
      paidAt: T1,
      paymentId: 'pay-b',
    });
  });

  it('returns 503 and logs no amounts when the wallet store fails', async () => {
    const walletStore = new FailingWalletStore();
    const app = await walletApp({ debugToken: 'secret', walletStore });
    const res = await app.request(`/debug/accounts/${ACCOUNT_ID}/wallet`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: 'Wallet data is unavailable' });
    const events = parsedEvents(warn);
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'debug.wallet.failed', accountId: ACCOUNT_ID }),
    );
    for (const event of events) {
      expect(event).not.toHaveProperty('amountSats');
      expect(event).not.toHaveProperty('invoice');
      expect(event).not.toHaveProperty('counterpartyAccountId');
    }
    await expect(walletStore.paymentTotals(ACCOUNT_ID)).rejects.toThrow('sql failed');
    await expect(walletStore.dailyBalances()).rejects.toThrow('sql failed');
  });
});
