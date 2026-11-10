import { describe, expect, it } from 'vitest';
import { buildWalletStats } from '@/lib/wallet-stats';
import { MAX_SATS } from '@/lib/wallet-report';
import type { WalletBalanceSnapshot } from '@/lib/wallet-store';

function snapshot(
  accountId: string,
  id: string,
  balanceSats: number,
  receivedAt: string,
): WalletBalanceSnapshot {
  return {
    accountId,
    id,
    balanceSats,
    receivedAt: new Date(receivedAt),
    syncedAt: new Date(receivedAt),
  };
}

describe('buildWalletStats', () => {
  it('returns empty stats when the table has no snapshot', () => {
    expect(buildWalletStats([], Date.parse('2026-11-10T06:21:04.985Z'))).toEqual({
      walletCount: 0,
      fundedWalletCount: 0,
      totalSats: 0,
      totalBtc: '0.00000000',
      asOf: null,
      balanceOverTime: [],
    });
  });

  it('keeps the last snapshot of a day and breaks a received_at tie by id', () => {
    const stats = buildWalletStats(
      [
        snapshot('account-a', 'a', 100, '2026-11-09T00:00:00.000Z'),
        snapshot('account-a', 'b', 300, '2026-11-09T12:00:00.000Z'),
        snapshot('account-a', 'c', 400, '2026-11-09T12:00:00.000Z'),
        snapshot('account-a', 'b-lower', 500, '2026-11-09T12:00:00.000Z'),
        snapshot('account-a', 'a-old', 200, '2026-11-09T11:00:00.000Z'),
      ],
      Date.parse('2026-11-09T18:00:00.000Z'),
    );

    expect(stats).toEqual({
      walletCount: 1,
      fundedWalletCount: 1,
      totalSats: 400,
      totalBtc: '0.00000400',
      asOf: '2026-11-09T12:00:00.000Z',
      balanceOverTime: [
        {
          day: '2026-11-09',
          totalSats: 400,
          totalBtc: '0.00000400',
          walletCount: 1,
          fundedWalletCount: 1,
        },
      ],
    });
  });

  it('sums several wallets on the same day', () => {
    const stats = buildWalletStats(
      [
        snapshot('account-a', 'a', 100, '2026-11-09T08:00:00.000Z'),
        snapshot('account-b', 'b', 50, '2026-11-09T09:00:00.000Z'),
        snapshot('account-c', 'c', 0, '2026-11-09T10:00:00.000Z'),
      ],
      Date.parse('2026-11-09T18:00:00.000Z'),
    );

    expect(stats).toMatchObject({
      walletCount: 3,
      fundedWalletCount: 2,
      totalSats: 150,
      totalBtc: '0.00000150',
      asOf: '2026-11-09T10:00:00.000Z',
    });
    expect(stats.balanceOverTime).toEqual([
      {
        day: '2026-11-09',
        totalSats: 150,
        totalBtc: '0.00000150',
        walletCount: 3,
        fundedWalletCount: 2,
      },
    ]);
  });

  it('keeps a zero balance in walletCount while it stops counting as funded', () => {
    const stats = buildWalletStats(
      [
        snapshot('account-a', 'a', 400, '2026-11-09T10:00:00.000Z'),
        snapshot('account-a', 'b', 0, '2026-11-10T10:00:00.000Z'),
      ],
      Date.parse('2026-11-11T12:00:00.000Z'),
    );

    expect(stats).toMatchObject({
      walletCount: 1,
      fundedWalletCount: 0,
      totalSats: 0,
      totalBtc: '0.00000000',
      asOf: '2026-11-10T10:00:00.000Z',
    });
    expect(stats.balanceOverTime).toEqual([
      {
        day: '2026-11-09',
        totalSats: 400,
        totalBtc: '0.00000400',
        walletCount: 1,
        fundedWalletCount: 1,
      },
      {
        day: '2026-11-10',
        totalSats: 0,
        totalBtc: '0.00000000',
        walletCount: 1,
        fundedWalletCount: 0,
      },
      {
        day: '2026-11-11',
        totalSats: 0,
        totalBtc: '0.00000000',
        walletCount: 1,
        fundedWalletCount: 0,
      },
    ]);
  });

  it('carries balances through gap days and adds a wallet that appears later', () => {
    const stats = buildWalletStats(
      [
        snapshot('account-b', 'b', 500, '2026-11-11T09:00:00.000Z'),
        snapshot('account-a', 'a', 1_000, '2026-11-09T08:00:00.000Z'),
      ],
      Date.parse('2026-11-13T12:00:00.000Z'),
    );

    expect(stats).toMatchObject({
      walletCount: 2,
      fundedWalletCount: 2,
      totalSats: 1_500,
      totalBtc: '0.00001500',
      asOf: '2026-11-11T09:00:00.000Z',
    });
    expect(stats.balanceOverTime).toEqual([
      {
        day: '2026-11-09',
        totalSats: 1_000,
        totalBtc: '0.00001000',
        walletCount: 1,
        fundedWalletCount: 1,
      },
      {
        day: '2026-11-10',
        totalSats: 1_000,
        totalBtc: '0.00001000',
        walletCount: 1,
        fundedWalletCount: 1,
      },
      {
        day: '2026-11-11',
        totalSats: 1_500,
        totalBtc: '0.00001500',
        walletCount: 2,
        fundedWalletCount: 2,
      },
      {
        day: '2026-11-12',
        totalSats: 1_500,
        totalBtc: '0.00001500',
        walletCount: 2,
        fundedWalletCount: 2,
      },
      {
        day: '2026-11-13',
        totalSats: 1_500,
        totalBtc: '0.00001500',
        walletCount: 2,
        fundedWalletCount: 2,
      },
    ]);
  });

  it('puts a snapshot exactly at UTC midnight into the new day', () => {
    const stats = buildWalletStats(
      [
        snapshot('account-a', 'a', 100, '2026-11-09T23:59:59.999Z'),
        snapshot('account-a', 'b', 200, '2026-11-10T00:00:00.000Z'),
      ],
      Date.parse('2026-11-10T12:00:00.000Z'),
    );

    expect(stats.balanceOverTime).toEqual([
      {
        day: '2026-11-09',
        totalSats: 100,
        totalBtc: '0.00000100',
        walletCount: 1,
        fundedWalletCount: 1,
      },
      {
        day: '2026-11-10',
        totalSats: 200,
        totalBtc: '0.00000200',
        walletCount: 1,
        fundedWalletCount: 1,
      },
    ]);
  });

  it('throws instead of rounding when five MAX_SATS balances exceed the safe integer range', () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      snapshot(
        `account-${index}`,
        `snapshot-${index}`,
        MAX_SATS,
        `2026-11-09T1${index}:00:00.000Z`,
      ),
    );

    expect(() => buildWalletStats(rows, Date.parse('2026-11-09T18:00:00.000Z'))).toThrow(
      /MAX_SAFE_INTEGER/,
    );
  });
});
