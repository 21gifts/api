import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '@/lib/auth/store';
import type { SparkViewerTransfer } from '@/lib/spark-viewer';
import type { WalletTransferRecord, WalletTransferStore } from '@/lib/wallet-transfer-store';
import { runWalletTransferTick, startWalletTransferWorker } from '@/lib/wallet-transfer-worker';

const OWNER = `02${'a'.repeat(64)}`;
const SHOP = `03${'b'.repeat(64)}`;
const MEMBER = `02${'c'.repeat(64)}`;
const NOW = Date.parse('2026-11-12T12:00:00.000Z');

function bytes(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? []);
}

function transfer(partial: Partial<SparkViewerTransfer> = {}): SparkViewerTransfer {
  return {
    id: 'transfer-1',
    senderIdentityPublicKey: bytes(OWNER),
    receiverIdentityPublicKey: bytes(SHOP),
    status: 5,
    totalValue: 21,
    createdTime: new Date('2026-11-12T10:00:00.000Z'),
    updatedTime: new Date('2026-11-12T10:01:00.000Z'),
    type: 2,
    sparkInvoice: 'spark1invoice',
    ...partial,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('runWalletTransferTick', () => {
  it('pages, normalizes, stores balance, and sends the same-day catch-up ping', async () => {
    const stored: WalletTransferRecord[] = [];
    const transferStore: WalletTransferStore = {
      listWallets: async () => [
        { accountId: 'account', sparkPubkey: OWNER, sparkAddress: 'spark1address' },
      ],
      syncState: async () => ({
        newestCreatedAt: null,
        oldestPendingCreatedAt: null,
        pendingWithoutCreatedAt: false,
      }),
      upsertTransfer: async (row) => {
        stored.push(row);
        return {
          inserted: true,
          updated: false,
          shopPaymentBecameCompleted: true,
        };
      },
      hasShopPayment: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
    };
    const transfers = vi
      .fn()
      .mockResolvedValueOnce({ transfers: [transfer()], offset: 7 })
      .mockResolvedValueOnce({ transfers: [], offset: -1 });
    const recordBalance = vi.fn(async () => undefined);
    const ping = vi.fn(async () => undefined);
    const account = {
      id: 'account',
      role: 'verified',
      username: 'alice',
      sparkPubkey: OWNER,
      sparkPubkeyVerifiedAt: NOW,
      isPlatform: false,
    } as Account;
    const failed = await runWalletTransferTick({
      viewer: { transfers, balance: async () => 34 },
      transfers: transferStore,
      balances: { recordBalance },
      auth: {
        getAccount: async () => account,
        hasRecoveryShareForVerifiedWallet: async () => true,
      },
      funding: {
        getByAccountId: async () => ({
          accountId: 'account',
          status: 'admitted',
          appliedAt: 1,
          decidedAt: 2,
          decidedBy: null,
          trialUtcDate: null,
          admittedAt: 2,
          note: null,
        }),
      },
      ping: {
        spendPing: { ping },
        lnurlServer: {
          baseUrl: 'https://lnurl.test',
          publicBaseUrl: 'https://21.gifts',
          host: '21.gifts',
        },
        messageStore: {
          latestLiveTopLevelMediaId: async () => 'message',
          getById: async () => ({ id: 'message', createdAt: new Date(NOW) }) as never,
        },
        authStore: { hasRecoveryShareForVerifiedWallet: async () => true },
        walletTransfers: transferStore,
      },
      now: () => NOW,
    });
    expect(failed.size).toBe(0);
    expect(transfers).toHaveBeenCalledTimes(2);
    expect(stored[0]).toMatchObject({
      direction: 'out',
      type: 'transfer',
      status: 'completed',
      amountSats: 21,
      counterpartyPubkey: SHOP,
      sparkInvoice: 'spark1invoice',
    });
    expect(recordBalance).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'account', walletPubkey: OWNER, balanceSats: 34 }),
    );
    expect(ping).toHaveBeenCalledOnce();
    transfers.mockResolvedValueOnce({
      transfers: [transfer({ id: 'transfer-2' })],
      offset: -1,
    });
    await runWalletTransferTick({
      viewer: { transfers, balance: async () => 34 },
      transfers: transferStore,
      balances: { recordBalance },
      auth: {
        getAccount: async () => account,
        hasRecoveryShareForVerifiedWallet: async () => true,
      },
      funding: {
        getByAccountId: async () => ({
          accountId: 'account',
          status: 'admitted',
          appliedAt: 1,
          decidedAt: 2,
          decidedBy: null,
          trialUtcDate: null,
          admittedAt: 2,
          note: null,
        }),
      },
      ping: {
        spendPing: { ping },
        lnurlServer: {
          baseUrl: 'https://lnurl.test',
          publicBaseUrl: 'https://21.gifts',
          host: '21.gifts',
        },
        messageStore: {
          latestLiveTopLevelMediaId: async () => 'message',
          getById: async () => ({ id: 'message', createdAt: new Date(NOW) }) as never,
        },
        authStore: { hasRecoveryShareForVerifiedWallet: async () => true },
        walletTransfers: transferStore,
      },
      now: () => NOW,
    });
    expect(ping).toHaveBeenCalledOnce();
  });

  it('skips a wallet under backoff and records a safe failure reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store: WalletTransferStore = {
      listWallets: async () => [
        { accountId: 'account', sparkPubkey: OWNER, sparkAddress: 'spark1address' },
      ],
      syncState: async () => {
        throw new TypeError('contains spark1secret');
      },
      upsertTransfer: async () => ({
        inserted: false,
        updated: false,
        shopPaymentBecameCompleted: false,
      }),
      hasShopPayment: async () => false,
    };
    const base = {
      viewer: { transfers: async () => ({ transfers: [], offset: -1 }), balance: async () => 0 },
      transfers: store,
      balances: { recordBalance: async () => undefined },
      auth: {
        getAccount: async () => undefined,
        hasRecoveryShareForVerifiedWallet: async () => false,
      },
      funding: { getByAccountId: async () => undefined },
      ping: {
        messageStore: {
          latestLiveTopLevelMediaId: async () => null,
          getById: async () => undefined,
        },
        authStore: { hasRecoveryShareForVerifiedWallet: async () => false },
      },
      now: () => NOW,
    };
    const skipped = await runWalletTransferTick(
      base,
      new Map([[`account\u0000${OWNER}`, NOW + 1]]),
    );
    expect(skipped.get(`account\u0000${OWNER}`)).toBe(false);
    const failed = await runWalletTransferTick(base);
    expect(failed.has(`account\u0000${OWNER}`)).toBe(true);
    const output = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('TypeError');
    expect(output).not.toContain('spark1secret');
  });

  it('normalizes every transfer enum and ignores malformed or unrelated rows', async () => {
    vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce(() => undefined as never);
    const stored: WalletTransferRecord[] = [];
    const viewerTransfers = vi.fn(async () => ({
      transfers: [
        transfer({ id: 'preimage-insert', type: 0, status: 0, sparkInvoice: '' }),
        transfer({ id: 'cooperative-update', type: 1, status: 6 }),
        transfer({ id: 'transfer', type: 2, status: 7 }),
        transfer({ id: 'utxo', type: 3 }),
        transfer({ id: 'primary', type: 4 }),
        transfer({ id: 'counter-v3', type: 5 }),
        transfer({ id: 'swap', type: 30 }),
        transfer({ id: 'counter', type: 40 }),
        transfer({ id: 'unknown', type: 999 }),
        transfer({
          id: 'old-shop',
          createdTime: new Date('2026-11-11T10:00:00.000Z'),
          updatedTime: undefined,
        }),
        transfer({
          id: 'incoming',
          senderIdentityPublicKey: bytes(SHOP),
          receiverIdentityPublicKey: bytes(OWNER),
          createdTime: undefined,
          updatedTime: undefined,
        }),
        transfer({
          id: 'unrelated',
          senderIdentityPublicKey: bytes(SHOP),
          receiverIdentityPublicKey: bytes(MEMBER),
        }),
        transfer({ id: 'bad-counterparty', receiverIdentityPublicKey: Uint8Array.of(1) }),
        transfer({ id: '' }),
        transfer({ id: 'fractional', totalValue: 1.5 }),
        transfer({ id: 'negative', totalValue: -1 }),
      ],
      offset: -1,
    }));
    const transferStore: WalletTransferStore = {
      listWallets: async () => [
        { accountId: 'account', sparkPubkey: OWNER, sparkAddress: 'spark1address' },
      ],
      syncState: async () => ({
        newestCreatedAt: new Date('2026-11-12T12:00:00.000Z'),
        oldestPendingCreatedAt: new Date('2026-11-12T10:00:00.000Z'),
        pendingWithoutCreatedAt: false,
      }),
      upsertTransfer: async (record) => {
        stored.push(record);
        return {
          inserted: record.transferId.endsWith('insert'),
          updated: record.transferId.endsWith('update'),
          shopPaymentBecameCompleted:
            record.transferId === 'incoming' || record.transferId === 'old-shop',
        };
      },
      hasShopPayment: async () => false,
    };
    const recordBalance = vi.fn(async () => undefined);
    const failed = await runWalletTransferTick({
      viewer: { transfers: viewerTransfers, balance: async () => 0 },
      transfers: transferStore,
      balances: { recordBalance },
      auth: {
        getAccount: async () => undefined,
        hasRecoveryShareForVerifiedWallet: async () => false,
      },
      funding: { getByAccountId: async () => undefined },
      ping: {
        messageStore: {
          latestLiveTopLevelMediaId: async () => null,
          getById: async () => undefined,
        },
        authStore: { hasRecoveryShareForVerifiedWallet: async () => false },
      },
      now: () => NOW,
    });
    expect(failed.size).toBe(0);
    expect(viewerTransfers).toHaveBeenCalledWith(
      expect.objectContaining({ createdAfter: new Date('2026-11-12T10:00:00.000Z') }),
    );
    expect(new Set(stored.map((record) => record.type))).toEqual(
      new Set([
        'preimage_swap',
        'cooperative_exit',
        'transfer',
        'utxo_swap',
        'primary_swap_v3',
        'counter_swap_v3',
        'swap',
        'counter_swap',
        'unrecognized',
      ]),
    );
    expect(new Set(stored.map((record) => record.status))).toEqual(
      new Set(['pending', 'completed', 'expired', 'returned']),
    );
    expect(
      stored.find((record) => record.transferId === 'preimage-insert')?.sparkInvoice,
    ).toBeNull();
    expect(stored.find((record) => record.transferId === 'incoming')).toMatchObject({
      direction: 'in',
      counterpartyPubkey: SHOP,
      transferCreatedAt: null,
      transferUpdatedAt: null,
    });
    expect(stored).toHaveLength(11);
    expect(recordBalance).toHaveBeenCalledOnce();
  });

  it('forces full scans and skips catch-up for missing or ineligible accounts', async () => {
    const store: WalletTransferStore = {
      listWallets: async () => [
        { accountId: 'missing', sparkPubkey: OWNER, sparkAddress: 'spark1address' },
        { accountId: 'ineligible', sparkPubkey: OWNER, sparkAddress: 'spark1second' },
      ],
      syncState: async () => ({
        newestCreatedAt: new Date(NOW),
        oldestPendingCreatedAt: null,
        pendingWithoutCreatedAt: true,
      }),
      upsertTransfer: async () => ({
        inserted: false,
        updated: false,
        shopPaymentBecameCompleted: true,
      }),
      hasShopPayment: async () => false,
    };
    const transfers = vi.fn(async () => ({ transfers: [transfer()], offset: -1 }));
    await runWalletTransferTick({
      viewer: { transfers, balance: async () => 0 },
      transfers: store,
      balances: { recordBalance: async () => undefined },
      auth: {
        getAccount: async (accountId) =>
          accountId === 'ineligible'
            ? ({ id: 'ineligible', role: 'verified' } as Account)
            : undefined,
        hasRecoveryShareForVerifiedWallet: async () => false,
      },
      funding: { getByAccountId: async () => undefined },
      ping: {
        messageStore: {
          latestLiveTopLevelMediaId: async () => null,
          getById: async () => undefined,
        },
        authStore: { hasRecoveryShareForVerifiedWallet: async () => false },
      },
      now: () => NOW,
    });
    expect(transfers).toHaveBeenCalledWith(
      expect.not.objectContaining({ createdAfter: expect.anything() }),
    );
  });

  it('turns SDK timeouts and non-Error failures into per-wallet failures', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store: WalletTransferStore = {
      listWallets: async () => [
        { accountId: 'account', sparkPubkey: OWNER, sparkAddress: 'spark1address' },
      ],
      syncState: async () => ({
        newestCreatedAt: null,
        oldestPendingCreatedAt: null,
        pendingWithoutCreatedAt: false,
      }),
      upsertTransfer: async () => ({
        inserted: false,
        updated: false,
        shopPaymentBecameCompleted: false,
      }),
      hasShopPayment: async () => false,
    };
    const pending = runWalletTransferTick({
      viewer: {
        transfers: () =>
          new Promise<{ transfers: SparkViewerTransfer[]; offset: number }>(() => undefined),
        balance: async () => 0,
      },
      transfers: store,
      balances: { recordBalance: async () => undefined },
      auth: {
        getAccount: async () => undefined,
        hasRecoveryShareForVerifiedWallet: async () => false,
      },
      funding: { getByAccountId: async () => undefined },
      ping: {
        messageStore: {
          latestLiveTopLevelMediaId: async () => null,
          getById: async () => undefined,
        },
        authStore: { hasRecoveryShareForVerifiedWallet: async () => false },
      },
      now: () => NOW,
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await pending).get(`account\u0000${OWNER}`)).toBe(true);

    store.syncState = async () => Promise.reject('no details');
    await runWalletTransferTick({
      viewer: { transfers: async () => ({ transfers: [], offset: -1 }), balance: async () => 0 },
      transfers: store,
      balances: { recordBalance: async () => undefined },
      auth: {
        getAccount: async () => undefined,
        hasRecoveryShareForVerifiedWallet: async () => false,
      },
      funding: { getByAccountId: async () => undefined },
      ping: {
        messageStore: {
          latestLiveTopLevelMediaId: async () => null,
          getById: async () => undefined,
        },
        authStore: { hasRecoveryShareForVerifiedWallet: async () => false },
      },
      now: () => NOW,
    });
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain('unknown');
  });
});

describe('startWalletTransferWorker', () => {
  it('can stop while its immediate pass is still running', async () => {
    vi.useFakeTimers();
    let release = (): void => undefined;
    const listWallets = vi.fn(
      () =>
        new Promise<[]>((resolve) => {
          release = () => resolve([]);
        }),
    );
    const store: WalletTransferStore = {
      listWallets,
      syncState: vi.fn(async () => ({
        newestCreatedAt: null,
        oldestPendingCreatedAt: null,
        pendingWithoutCreatedAt: false,
      })),
      upsertTransfer: vi.fn(async () => ({
        inserted: false,
        updated: false,
        shopPaymentBecameCompleted: false,
      })),
      hasShopPayment: vi.fn(async () => false),
    };
    const handle = startWalletTransferWorker({
      viewer: { transfers: async () => ({ transfers: [], offset: -1 }), balance: async () => 0 },
      transfers: store,
      balances: { recordBalance: async () => undefined },
      auth: {
        getAccount: async () => undefined,
        hasRecoveryShareForVerifiedWallet: async () => false,
      },
      funding: { getByAccountId: async () => undefined },
      ping: {
        messageStore: {
          latestLiveTopLevelMediaId: async () => null,
          getById: async () => undefined,
        },
        authStore: { hasRecoveryShareForVerifiedWallet: async () => false },
      },
      now: () => NOW,
    });
    handle.stop();
    const callsAfterStop = Object.values(store).map((value) =>
      vi.isMockFunction(value) ? value.mock.calls.length : null,
    );
    release();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(
      Object.values(store).map((value) =>
        vi.isMockFunction(value) ? value.mock.calls.length : null,
      ),
    ).toEqual(callsAfterStop);
    expect(listWallets).toHaveBeenCalledOnce();
  });

  it('starts immediately and stops its later self-schedule', async () => {
    vi.useFakeTimers();
    const listWallets = vi.fn(async () => []);
    const handle = startWalletTransferWorker(
      {
        viewer: { transfers: async () => ({ transfers: [], offset: -1 }), balance: async () => 0 },
        transfers: {
          listWallets,
          syncState: async () => ({
            newestCreatedAt: null,
            oldestPendingCreatedAt: null,
            pendingWithoutCreatedAt: false,
          }),
          upsertTransfer: async () => ({
            inserted: false,
            updated: false,
            shopPaymentBecameCompleted: false,
          }),
          hasShopPayment: async () => false,
        },
        balances: { recordBalance: async () => undefined },
        auth: {
          getAccount: async () => undefined,
          hasRecoveryShareForVerifiedWallet: async () => false,
        },
        funding: { getByAccountId: async () => undefined },
        ping: {
          messageStore: {
            latestLiveTopLevelMediaId: async () => null,
            getById: async () => undefined,
          },
          authStore: { hasRecoveryShareForVerifiedWallet: async () => false },
        },
        now: () => NOW,
      },
      100,
    );
    await vi.runAllTicks();
    expect(listWallets).toHaveBeenCalledOnce();
    vi.spyOn(globalThis, 'clearTimeout').mockImplementationOnce(() => undefined);
    handle.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(listWallets).toHaveBeenCalledOnce();
  });

  it('backs off a failed wallet and recovers it on a later pass', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const listWallets = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('catalog down');
      if (calls === 2) return Promise.reject('catalog still down');
      return [];
    });
    const handle = startWalletTransferWorker(
      {
        viewer: { transfers: async () => ({ transfers: [], offset: -1 }), balance: async () => 0 },
        transfers: {
          listWallets,
          syncState: async () => ({
            newestCreatedAt: null,
            oldestPendingCreatedAt: null,
            pendingWithoutCreatedAt: false,
          }),
          upsertTransfer: async () => ({
            inserted: false,
            updated: false,
            shopPaymentBecameCompleted: false,
          }),
          hasShopPayment: async () => false,
        },
        balances: { recordBalance: async () => undefined },
        auth: {
          getAccount: async () => undefined,
          hasRecoveryShareForVerifiedWallet: async () => false,
        },
        funding: { getByAccountId: async () => undefined },
        ping: {
          messageStore: {
            latestLiveTopLevelMediaId: async () => null,
            getById: async () => undefined,
          },
          authStore: { hasRecoveryShareForVerifiedWallet: async () => false },
        },
        now: () => NOW,
      },
      100,
    );
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(100);
    expect(listWallets).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(listWallets).toHaveBeenCalledTimes(3);
    handle.stop();
  });

  it('retains per-wallet backoff skips and clears attempts after recovery', async () => {
    vi.useFakeTimers();
    let now = NOW;
    let syncCalls = 0;
    const handle = startWalletTransferWorker(
      {
        viewer: { transfers: async () => ({ transfers: [], offset: -1 }), balance: async () => 0 },
        transfers: {
          listWallets: async () => [
            { accountId: 'account', sparkPubkey: OWNER, sparkAddress: 'spark1address' },
          ],
          syncState: async () => {
            syncCalls += 1;
            if (syncCalls === 1) throw new Error('temporary');
            return {
              newestCreatedAt: null,
              oldestPendingCreatedAt: null,
              pendingWithoutCreatedAt: false,
            };
          },
          upsertTransfer: async () => ({
            inserted: false,
            updated: false,
            shopPaymentBecameCompleted: false,
          }),
          hasShopPayment: async () => false,
        },
        balances: { recordBalance: async () => undefined },
        auth: {
          getAccount: async () => undefined,
          hasRecoveryShareForVerifiedWallet: async () => false,
        },
        funding: { getByAccountId: async () => undefined },
        ping: {
          messageStore: {
            latestLiveTopLevelMediaId: async () => null,
            getById: async () => undefined,
          },
          authStore: { hasRecoveryShareForVerifiedWallet: async () => false },
        },
        now: () => now,
      },
      100,
    );
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);
    now += 100;
    await vi.advanceTimersByTimeAsync(100);
    expect(syncCalls).toBe(1);
    now += 100;
    await vi.advanceTimersByTimeAsync(100);
    expect(syncCalls).toBe(2);
    handle.stop();
  });

  it('caps repeated per-wallet backoff after six failures', async () => {
    vi.useFakeTimers();
    let now = NOW;
    let syncCalls = 0;
    const handle = startWalletTransferWorker(
      {
        viewer: { transfers: async () => ({ transfers: [], offset: -1 }), balance: async () => 0 },
        transfers: {
          listWallets: async () => [
            { accountId: 'account', sparkPubkey: OWNER, sparkAddress: 'spark1address' },
          ],
          syncState: async () => {
            syncCalls += 1;
            throw new Error('still down');
          },
          upsertTransfer: async () => ({
            inserted: false,
            updated: false,
            shopPaymentBecameCompleted: false,
          }),
          hasShopPayment: async () => false,
        },
        balances: { recordBalance: async () => undefined },
        auth: {
          getAccount: async () => undefined,
          hasRecoveryShareForVerifiedWallet: async () => false,
        },
        funding: { getByAccountId: async () => undefined },
        ping: {
          messageStore: {
            latestLiveTopLevelMediaId: async () => null,
            getById: async () => undefined,
          },
          authStore: { hasRecoveryShareForVerifiedWallet: async () => false },
        },
        now: () => now,
      },
      1_000_000,
    );
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);
    for (let attempt = 1; attempt < 7; attempt += 1) {
      now += 60 * 60_000 + 1;
      await vi.advanceTimersByTimeAsync(1_000_000);
    }
    expect(syncCalls).toBe(7);
    handle.stop();
  });
});
