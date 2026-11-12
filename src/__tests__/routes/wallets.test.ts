import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SATS } from '@/lib/wallet-report';
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
      findPaymentCounterparties: () => Promise.resolve(new Map()),
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
