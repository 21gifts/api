import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SATS } from '@/lib/wallet-report';
import { buildWalletUsage, walletUsageReadSince } from '@/lib/wallet-usage';
import { InMemoryWalletUsageStore, type WalletUsageStore } from '@/lib/wallet-usage-store';
import { InMemoryWalletStore, type WalletStore } from '@/lib/wallet-store';
import { createApp } from '@/server';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

describe('GET /wallets/stats', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns public current totals and a daily series', async () => {
    const store = new InMemoryWalletStore();
    await store.recordBalance({
      id: 'a',
      accountId: 'account-a',
      balanceSats: 21,
      syncedAt: new Date('2026-11-09T10:00:00.000Z'),
      receivedAt: new Date('2026-11-09T10:00:00.000Z'),
    });
    const app = createApp({
      walletStore: store,
      now: () => Date.parse('2026-11-10T06:21:04.985Z'),
    });

    const res = await app.request('/wallets/stats');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      walletCount: 1,
      fundedWalletCount: 1,
      totalSats: 21,
      totalBtc: '0.00000021',
      asOf: '2026-11-09T10:00:00.000Z',
      balanceOverTime: [
        {
          day: '2026-11-09',
          totalSats: 21,
          totalBtc: '0.00000021',
          walletCount: 1,
          fundedWalletCount: 1,
        },
        {
          day: '2026-11-10',
          totalSats: 21,
          totalBtc: '0.00000021',
          walletCount: 1,
          fundedWalletCount: 1,
        },
      ],
    });
  });

  it('uses legacy balances only for accounts without a keyed balance', async () => {
    const store = new InMemoryWalletStore();
    const day = new Date('2026-11-09T10:00:00.000Z');
    await store.recordBalance({
      id: 'legacy-replaced',
      accountId: 'account-a',
      walletPubkey: null,
      balanceSats: 900,
      syncedAt: day,
      receivedAt: day,
    });
    await store.recordBalance({
      id: 'keyed',
      accountId: 'account-a',
      walletPubkey: `02${'a'.repeat(64)}`,
      balanceSats: 100,
      syncedAt: day,
      receivedAt: day,
    });
    await store.recordBalance({
      id: 'legacy-fallback',
      accountId: 'account-b',
      walletPubkey: null,
      balanceSats: 50,
      syncedAt: day,
      receivedAt: day,
    });

    const res = await createApp({
      walletStore: store,
      now: () => Date.parse('2026-11-09T12:00:00.000Z'),
    }).request('/wallets/stats');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      walletCount: 2,
      fundedWalletCount: 2,
      totalSats: 150,
      totalBtc: '0.00000150',
    });
  });

  it('returns full totals with carry-forward for two accounts over two days', async () => {
    const store = new InMemoryWalletStore();
    await store.recordBalance({
      id: 'a-1',
      accountId: 'account-a',
      balanceSats: 100,
      syncedAt: new Date('2026-11-09T08:00:00.000Z'),
      receivedAt: new Date('2026-11-09T08:00:00.000Z'),
    });
    await store.recordBalance({
      id: 'b-1',
      accountId: 'account-b',
      balanceSats: 50,
      syncedAt: new Date('2026-11-09T09:00:00.000Z'),
      receivedAt: new Date('2026-11-09T09:00:00.000Z'),
    });
    await store.recordBalance({
      id: 'a-2',
      accountId: 'account-a',
      balanceSats: 300,
      syncedAt: new Date('2026-11-10T10:00:00.000Z'),
      receivedAt: new Date('2026-11-10T10:00:00.000Z'),
    });
    const app = createApp({
      walletStore: store,
      now: () => Date.parse('2026-11-10T12:00:00.000Z'),
    });

    const res = await app.request('/wallets/stats');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      walletCount: 2,
      fundedWalletCount: 2,
      totalSats: 350,
      totalBtc: '0.00000350',
      asOf: '2026-11-10T10:00:00.000Z',
      balanceOverTime: [
        {
          day: '2026-11-09',
          totalSats: 150,
          totalBtc: '0.00000150',
          walletCount: 2,
          fundedWalletCount: 2,
        },
        {
          day: '2026-11-10',
          totalSats: 350,
          totalBtc: '0.00000350',
          walletCount: 2,
          fundedWalletCount: 2,
        },
      ],
    });
  });

  it('returns empty stats for an empty wallet table', async () => {
    const res = await createApp().request('/wallets/stats');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      walletCount: 0,
      fundedWalletCount: 0,
      totalSats: 0,
      totalBtc: '0.00000000',
      asOf: null,
      balanceOverTime: [],
    });
  });

  it('returns 503 and logs when the balance query throws', async () => {
    const store: WalletStore = {
      recordBalance: () => Promise.resolve(),
      upsertPayments: () => Promise.resolve(),
      latestBalance: () => Promise.resolve(undefined),
      listPayments: () => Promise.resolve([]),
      dailyBalances: () => Promise.reject(new Error('down')),
      paymentTotals: () => Promise.resolve({ receivedSats: 0n, paidOutSats: 0n, feesSats: 0n }),
    };
    const res = await createApp({ walletStore: store }).request('/wallets/stats');
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: 'Wallet stats are unavailable' });
    expect(parsedEvents(warn)).toContainEqual(
      expect.objectContaining({ event: 'wallets.stats.failed' }),
    );
  });

  it('returns 503 instead of rounded totals when five MAX_SATS balances overflow', async () => {
    const store = new InMemoryWalletStore();
    for (let index = 0; index < 5; index += 1) {
      await store.recordBalance({
        id: `snapshot-${index}`,
        accountId: `account-${index}`,
        balanceSats: MAX_SATS,
        syncedAt: new Date('2026-11-09T10:00:00.000Z'),
        receivedAt: new Date('2026-11-09T10:00:00.000Z'),
      });
    }
    const res = await createApp({
      walletStore: store,
      now: () => Date.parse('2026-11-09T18:00:00.000Z'),
    }).request('/wallets/stats');

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: 'Wallet stats are unavailable' });
    expect(parsedEvents(warn)).toContainEqual(
      expect.objectContaining({ event: 'wallets.stats.failed' }),
    );
  });
});

describe('GET /wallets/usage', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns the public aggregate and caches it for 60 seconds', async () => {
    const nowMs = Date.parse('2026-11-12T15:51:00.000Z');
    const since = walletUsageReadSince();
    const seen = { payments: 0, forumInvoices: 0, shopCharges: 0 };
    const inner = new InMemoryWalletUsageStore({
      payments: [
        {
          paidAt: new Date('2026-11-11T12:00:00.000Z'),
          amountSats: 21,
          feeSats: 1,
          category: 'gift',
          payerAccountId: 'acct-route-payer',
          payeeAccountId: 'acct-route-payee',
          payerParty: 'members',
          payeeParty: 'members',
          isFundPayout: false,
          isForumGift: false,
        },
      ],
      forumInvoices: [
        { createdAt: new Date('2026-10-01T00:00:00.000Z'), amountSats: 9, heart: true },
        { createdAt: new Date('2026-11-11T12:00:00.000Z'), amountSats: 5, heart: true },
      ],
      shopCharges: [
        { createdAt: new Date('2026-10-01T00:00:00.000Z'), status: 'paid' },
        { createdAt: new Date('2026-11-12T08:00:00.000Z'), status: 'paid' },
      ],
    });
    const usageStore: WalletUsageStore = {
      payments: (bound) => {
        seen.payments = bound;
        return inner.payments(bound);
      },
      forumInvoices: (bound) => {
        seen.forumInvoices = bound;
        return inner.forumInvoices(bound);
      },
      shopCharges: (bound) => {
        seen.shopCharges = bound;
        return inner.shopCharges(bound);
      },
    };
    const res = await createApp({
      usageStore,
      now: () => nowMs,
    }).request('/wallets/usage');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(seen).toEqual(since);
    const filtered = {
      payments: await inner.payments(since.payments),
      forumInvoices: await inner.forumInvoices(since.forumInvoices),
      shopCharges: await inner.shopCharges(since.shopCharges),
    };
    const body = (await res.json()) as { totals: { paymentCount: number } };
    expect(body).toEqual(buildWalletUsage(filtered, nowMs));
    expect(JSON.stringify(body)).not.toContain('acct-route-payer');
    expect(JSON.stringify(body)).not.toContain('acct-route-payee');
    const stats = await createApp({ usageStore, now: () => nowMs }).request('/wallets/stats');
    expect(stats.status).toBe(200);
  });

  it('serves zeros from the default in-memory store', async () => {
    const nowMs = Date.parse('2026-11-12T15:51:00.000Z');
    const res = await createApp({ now: () => nowMs }).request('/wallets/usage');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(await res.json()).toEqual(
      buildWalletUsage({ payments: [], forumInvoices: [], shopCharges: [] }, nowMs),
    );
  });

  it('returns 503 without a cache header when the read fails', async () => {
    const usageStore: WalletUsageStore = {
      payments: () => Promise.reject(new Error('down')),
      forumInvoices: () => Promise.resolve([]),
      shopCharges: () => Promise.resolve([]),
    };
    const res = await createApp({ usageStore }).request('/wallets/usage');
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBeNull();
    await expect(res.json()).resolves.toEqual({ error: 'Wallet usage is unavailable' });
    expect(parsedEvents(warn)).toContainEqual(
      expect.objectContaining({ event: 'wallets.usage.failed' }),
    );
  });

  it('returns 503 when the aggregate is not a safe integer', async () => {
    const huge = Number.MAX_SAFE_INTEGER;
    const usageStore = new InMemoryWalletUsageStore({
      payments: [0, 1].map((index) => ({
        paidAt: new Date(`2026-11-1${index}T00:00:00.000Z`),
        amountSats: huge,
        feeSats: 0,
        category: 'member',
        payerAccountId: null,
        payeeAccountId: null,
        payerParty: 'outside' as const,
        payeeParty: 'outside' as const,
        isFundPayout: false,
        isForumGift: false,
      })),
      forumInvoices: [],
      shopCharges: [],
    });
    const res = await createApp({
      usageStore,
      now: () => Date.parse('2026-11-12T00:00:00.000Z'),
    }).request('/wallets/usage');
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBeNull();
    await expect(res.json()).resolves.toEqual({ error: 'Wallet usage is unavailable' });
    expect(parsedEvents(warn)).toContainEqual(
      expect.objectContaining({ event: 'wallets.usage.failed' }),
    );
  });
});
