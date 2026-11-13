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

const noTokenTransactions = async () => ({
  transactions: [],
  hasNextPage: false,
  nextCursor: null,
  rawCount: 0,
});

const noTokenWrite = async (): Promise<void> => undefined;
const noFullSyncWrite = async (): Promise<void> => undefined;

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
    senders: [],
    receivers: [],
    leaves: [],
    ...partial,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('runWalletTransferTick', () => {
  it('pages, normalizes, stores balance and catches up a D-1 shop payment', async () => {
    const stored: WalletTransferRecord[] = [];
    const transferStore: WalletTransferStore = {
      listWallets: async () => [
        { accountId: 'account', sparkPubkey: OWNER, sparkAddress: 'spark1address' },
      ],
      syncState: async () => ({
        newestCreatedAt: null,
        oldestPendingCreatedAt: null,
        pendingWithoutCreatedAt: false,
        lastFullSyncAt: null,
      }),
      upsertTransfer: async (row) => {
        stored.push(row);
        return {
          inserted: true,
          updated: false,
          shopPaymentBecameCompleted: true,
        };
      },
      upsertTokenTransaction: vi.fn(async () => undefined),
      markFullSync: vi.fn(async () => undefined),
      hasShopPayment: vi.fn(async () => true),
    };
    const transfers = vi
      .fn()
      .mockResolvedValueOnce({
        transfers: [
          transfer({
            createdTime: new Date('2026-11-11T10:00:00.000Z'),
            updatedTime: new Date('2026-11-11T10:01:00.000Z'),
          }),
        ],
        offset: 7,
        rawCount: 100,
      })
      .mockResolvedValueOnce({ transfers: [], offset: -1, rawCount: 100 });
    const tokenTransactions = vi.fn(async () => ({
      transactions: [0, 1, 5, 2, 3, 4, 10].map((status, index) => ({
        hash: String(index + 1)
          .padStart(2, '0')
          .repeat(32),
        status,
        createdTime: index === 0 ? new Date('2026-11-12T10:02:00.000Z') : undefined,
        expiryTime: undefined,
        tokenIdentifier: null,
        direction: 'in' as const,
        amount: '0',
        counterpartyPubkeys: [],
        sparkInvoices: [],
        type: 'unknown' as const,
      })),
      hasNextPage: false,
      nextCursor: null,
      rawCount: 100,
      ownerResolution: {
        next: async () => ({ transactions: [], done: true }),
      },
    }));
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
      viewer: { transfers, tokenTransactions, balance: async () => 34 },
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
    expect(
      vi.mocked(transferStore.upsertTokenTransaction).mock.calls.map((call) => call[0].status),
    ).toEqual(['started', 'signed', 'revealed', 'finalized', 'cancelled', 'cancelled', 'unknown']);
    expect(ping).toHaveBeenCalledOnce();
    transfers.mockResolvedValueOnce({
      transfers: [transfer({ id: 'transfer-2' })],
      offset: -1,
      rawCount: 1,
    });
    await runWalletTransferTick({
      viewer: { transfers, tokenTransactions, balance: async () => 34 },
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
    expect(tokenTransactions).toHaveBeenCalledTimes(2);
  });

  it('stores the token page and completes wallet sync when owner enrichment times out', async () => {
    vi.useFakeTimers();
    const upsertTokenTransaction = vi.fn(async () => undefined);
    const markFullSync = vi.fn(async () => undefined);
    const hasShopPayment = vi.fn(async () => true);
    const recordBalance = vi.fn(async () => undefined);
    const balance = vi.fn(async () => 34);
    const ping = vi.fn(async () => undefined);
    const next = vi
      .fn()
      .mockResolvedValueOnce({
        transactions: [
          {
            hash: '11'.repeat(32),
            tokenIdentifier: null,
            direction: 'out',
            amount: '5',
            counterpartyPubkeys: [SHOP],
            sparkInvoices: [],
            type: 'transfer',
            status: 2,
            createdTime: undefined,
            expiryTime: undefined,
          },
        ],
        done: false,
      })
      .mockImplementation(
        () =>
          new Promise<{ transactions: []; done: boolean }>(() => {
            // A stuck owner lookup must not hold the rest of the wallet sync.
          }),
      );
    const pending = runWalletTransferTick({
      viewer: {
        transfers: async () => ({ transfers: [], offset: -1, rawCount: 0 }),
        tokenTransactions: async () => ({
          transactions: [
            {
              hash: '11'.repeat(32),
              tokenIdentifier: null,
              direction: 'in',
              amount: '21',
              counterpartyPubkeys: [],
              sparkInvoices: [],
              type: 'transfer',
              status: 2,
              createdTime: undefined,
              expiryTime: undefined,
            },
          ],
          hasNextPage: false,
          nextCursor: null,
          rawCount: 1,
          ownerResolution: { next },
        }),
        balance,
      },
      transfers: {
        listWallets: async () => [
          { accountId: 'account', sparkPubkey: OWNER, sparkAddress: 'spark1address' },
        ],
        syncState: async () => ({
          newestCreatedAt: null,
          oldestPendingCreatedAt: null,
          pendingWithoutCreatedAt: false,
          lastFullSyncAt: null,
        }),
        upsertTransfer: async () => ({
          inserted: false,
          updated: false,
          shopPaymentBecameCompleted: false,
        }),
        upsertTokenTransaction,
        markFullSync,
        hasShopPayment,
      },
      balances: { recordBalance },
      auth: {
        getAccount: async () =>
          ({
            id: 'account',
            role: 'verified',
            username: 'alice',
            sparkPubkey: OWNER,
            sparkPubkeyVerifiedAt: NOW,
            isPlatform: false,
          }) as Account,
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
        walletTransfers: { hasShopPayment },
      },
      now: () => NOW,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(upsertTokenTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'in', amount: '21' }),
    );
    expect(upsertTokenTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'out', amount: '5' }),
    );
    await vi.advanceTimersByTimeAsync(15_000);

    expect((await pending).size).toBe(0);
    expect(next).toHaveBeenCalledTimes(2);
    expect(hasShopPayment).toHaveBeenCalled();
    expect(ping).toHaveBeenCalledOnce();
    expect(balance).toHaveBeenCalledOnce();
    expect(recordBalance).toHaveBeenCalledOnce();
    expect(markFullSync).toHaveBeenCalledOnce();
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
      upsertTokenTransaction: noTokenWrite,
      markFullSync: noFullSyncWrite,
      hasShopPayment: async () => false,
    };
    const base = {
      viewer: {
        transfers: async () => ({ transfers: [], offset: -1, rawCount: 0 }),
        tokenTransactions: noTokenTransactions,
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

  it('retries a level-triggered catch-up until delivery succeeds, then deduplicates the UTC day', async () => {
    let now = NOW;
    let dailyPaid = false;
    const store: WalletTransferStore = {
      listWallets: async () => [
        { accountId: 'retry-account', sparkPubkey: OWNER, sparkAddress: 'spark1address' },
      ],
      syncState: async () => ({
        newestCreatedAt: null,
        oldestPendingCreatedAt: null,
        pendingWithoutCreatedAt: false,
        lastFullSyncAt: new Date(NOW),
      }),
      upsertTransfer: async () => ({
        inserted: false,
        updated: false,
        shopPaymentBecameCompleted: false,
      }),
      upsertTokenTransaction: noTokenWrite,
      markFullSync: noFullSyncWrite,
      hasShopPayment: async () => true,
    };
    const account = {
      id: 'retry-account',
      role: 'verified',
      username: 'alice',
      sparkPubkey: OWNER,
      sparkPubkeyVerifiedAt: NOW,
      isPlatform: false,
    } as Account;
    let pingAttempts = 0;
    const ping = vi.fn(async () => {
      pingAttempts += 1;
      return pingAttempts === 1
        ? ({ status: 'skipped', reason: 'not_ready' } as const)
        : pingAttempts === 2
          ? ({ status: 'failed' } as const)
          : ({ status: 'accepted' } as const);
    });
    const deps = {
      viewer: {
        transfers: async () => ({ transfers: [], offset: -1, rawCount: 0 }),
        tokenTransactions: noTokenTransactions,
        balance: async () => 0,
      },
      transfers: store,
      balances: { recordBalance: async () => undefined },
      auth: {
        getAccount: async () => account,
        hasRecoveryShareForVerifiedWallet: async () => true,
      },
      funding: {
        getByAccountId: async () => ({
          accountId: account.id,
          status: 'admitted' as const,
          appliedAt: 1,
          decidedAt: 2,
          decidedBy: null,
          trialUtcDate: null,
          admittedAt: 2,
          note: null,
        }),
      },
      gifts: {
        listOutbound: async () =>
          dailyPaid
            ? [
                {
                  paidAt: new Date(now),
                  amountSats: 1,
                  recipientWosUser: 'Alice@21.gifts',
                  kind: 'daily' as const,
                },
              ]
            : [],
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
        walletTransfers: store,
      },
      now: () => now,
    };

    expect((await runWalletTransferTick(deps)).size).toBe(0);
    expect((await runWalletTransferTick(deps)).get(`retry-account\u0000${OWNER}`)).toBe(true);
    expect((await runWalletTransferTick(deps)).size).toBe(0);
    expect((await runWalletTransferTick(deps)).size).toBe(0);
    expect(ping).toHaveBeenCalledTimes(3);
    now += 86_400_000;
    dailyPaid = true;
    expect((await runWalletTransferTick(deps)).size).toBe(0);
    expect(ping).toHaveBeenCalledTimes(3);
  });

  it('continues catch-up eligibility without reading gifts when the account has no username', async () => {
    const store: WalletTransferStore = {
      listWallets: async () => [
        { accountId: 'nameless-account', sparkPubkey: OWNER, sparkAddress: 'spark1address' },
      ],
      syncState: async () => ({
        newestCreatedAt: null,
        oldestPendingCreatedAt: null,
        pendingWithoutCreatedAt: false,
        lastFullSyncAt: new Date(NOW),
      }),
      upsertTransfer: async () => ({
        inserted: false,
        updated: false,
        shopPaymentBecameCompleted: false,
      }),
      upsertTokenTransaction: noTokenWrite,
      markFullSync: noFullSyncWrite,
      hasShopPayment: async () => true,
    };
    const account = {
      id: 'nameless-account',
      role: 'verified',
      username: null,
      sparkPubkey: OWNER,
      sparkPubkeyVerifiedAt: NOW,
      isPlatform: false,
    } as Account;
    const listOutbound = vi.fn(async () => []);
    const getByAccountId = vi.fn(async () => ({
      accountId: account.id,
      status: 'admitted' as const,
      appliedAt: 1,
      decidedAt: 2,
      decidedBy: null,
      trialUtcDate: null,
      admittedAt: 2,
      note: null,
    }));
    const ping = vi.fn(async () => ({ status: 'accepted' as const }));

    const failed = await runWalletTransferTick({
      viewer: {
        transfers: async () => ({ transfers: [], offset: -1, rawCount: 0 }),
        tokenTransactions: noTokenTransactions,
        balance: async () => 0,
      },
      transfers: store,
      balances: { recordBalance: async () => undefined },
      auth: {
        getAccount: async () => account,
        hasRecoveryShareForVerifiedWallet: async () => true,
      },
      funding: { getByAccountId },
      gifts: { listOutbound },
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
        walletTransfers: store,
      },
      now: () => NOW,
    });

    expect(failed.size).toBe(0);
    expect(listOutbound).not.toHaveBeenCalled();
    expect(getByAccountId).toHaveBeenCalledWith(account.id);
    expect(ping).not.toHaveBeenCalled();
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
          id: 'multi-party',
          senderIdentityPublicKey: bytes(MEMBER),
          receiverIdentityPublicKey: bytes(MEMBER),
          totalValue: 999,
          senders: [
            { id: 'sender-owner', identityPublicKey: bytes(OWNER) },
            { id: 'sender-member', identityPublicKey: bytes(MEMBER) },
          ],
          receivers: [
            { id: 'receiver-shop', identityPublicKey: bytes(SHOP), amountSats: 34, status: 5 },
          ],
          leaves: [
            { senderId: 'sender-owner', receiverId: 'receiver-shop', value: 13 },
            { senderId: 'sender-owner', receiverId: 'receiver-shop', value: 21 },
            { senderId: 'sender-member', receiverId: 'receiver-shop', value: 55 },
          ],
        }),
        transfer({
          id: 'multi-out-no-leaves',
          senders: [{ id: 'sender-owner', identityPublicKey: bytes(OWNER) }],
          receivers: [
            { id: 'receiver-shop', identityPublicKey: bytes(SHOP), amountSats: 8, status: 5 },
          ],
          leaves: [],
        }),
        transfer({
          id: 'multi-incoming',
          senderIdentityPublicKey: bytes(MEMBER),
          receiverIdentityPublicKey: bytes(MEMBER),
          totalValue: 999,
          senders: [{ id: 'sender-shop', identityPublicKey: bytes(SHOP) }],
          receivers: [
            {
              id: 'receiver-owner-a',
              identityPublicKey: bytes(OWNER),
              amountSats: 999,
              status: 6,
            },
            {
              id: 'receiver-owner-b',
              identityPublicKey: bytes(OWNER),
              amountSats: 777,
              status: 6,
            },
            { id: 'receiver-member', identityPublicKey: bytes(MEMBER), amountSats: 21, status: 5 },
          ],
          leaves: [
            { senderId: 'sender-shop', receiverId: 'receiver-owner-a', value: 13 },
            { senderId: 'sender-shop', receiverId: 'receiver-owner-b', value: 8 },
            { senderId: 'sender-shop', receiverId: 'receiver-member', value: 21 },
          ],
        }),
        transfer({
          id: 'multi-returned',
          senders: [{ id: 'sender-shop', identityPublicKey: bytes(SHOP) }],
          receivers: [
            { id: 'receiver-owner', identityPublicKey: bytes(OWNER), amountSats: 1, status: 7 },
          ],
          leaves: [{ senderId: 'sender-shop', receiverId: 'receiver-owner', value: 1 }],
        }),
        transfer({
          id: 'multi-pending',
          senders: [{ id: 'sender-shop', identityPublicKey: bytes(SHOP) }],
          receivers: [
            {
              id: 'receiver-owner-complete',
              identityPublicKey: bytes(OWNER),
              amountSats: 20,
              status: 6,
            },
            {
              id: 'receiver-owner-pending',
              identityPublicKey: bytes(OWNER),
              amountSats: 20,
              status: 1,
            },
          ],
          leaves: [
            { senderId: 'sender-shop', receiverId: 'receiver-owner-complete', value: 1 },
            { senderId: 'sender-shop', receiverId: 'receiver-owner-pending', value: 1 },
          ],
        }),
        transfer({
          id: 'unrelated',
          senderIdentityPublicKey: bytes(SHOP),
          receiverIdentityPublicKey: bytes(MEMBER),
        }),
        transfer({
          id: 'overflow-leaves',
          senders: [{ id: 'sender-owner', identityPublicKey: bytes(OWNER) }],
          receivers: [
            { id: 'receiver-shop', identityPublicKey: bytes(SHOP), amountSats: 1, status: 5 },
          ],
          leaves: [
            {
              senderId: 'sender-owner',
              receiverId: 'receiver-shop',
              value: Number.MAX_SAFE_INTEGER,
            },
            { senderId: 'sender-owner', receiverId: 'receiver-shop', value: 1 },
          ],
        }),
        transfer({
          id: 'negative-leaf',
          senders: [{ id: 'sender-owner', identityPublicKey: bytes(OWNER) }],
          receivers: [
            { id: 'receiver-shop', identityPublicKey: bytes(SHOP), amountSats: 1, status: 5 },
          ],
          leaves: [{ senderId: 'sender-owner', receiverId: 'receiver-shop', value: -1 }],
        }),
        transfer({
          id: 'ambiguous-no-leaves',
          senders: [
            { id: 'sender-owner', identityPublicKey: bytes(OWNER) },
            { id: 'sender-member', identityPublicKey: bytes(MEMBER) },
          ],
          receivers: [
            { id: 'receiver-shop', identityPublicKey: bytes(SHOP), amountSats: 1, status: 5 },
          ],
          leaves: [],
        }),
        transfer({
          id: 'self-counterparty',
          senders: [{ id: 'sender-owner', identityPublicKey: bytes(OWNER) }],
          receivers: [
            { id: 'receiver-owner', identityPublicKey: bytes(OWNER), amountSats: 1, status: 5 },
          ],
          leaves: [{ senderId: 'sender-owner', receiverId: 'receiver-owner', value: 1 }],
        }),
        transfer({ id: 'bad-counterparty', receiverIdentityPublicKey: Uint8Array.of(1) }),
        transfer({ id: '' }),
        transfer({ id: 'fractional', totalValue: 1.5 }),
        transfer({ id: 'negative', totalValue: -1 }),
      ],
      offset: -1,
      rawCount: 16,
    }));
    const transferStore: WalletTransferStore = {
      listWallets: async () => [
        { accountId: 'account', sparkPubkey: OWNER, sparkAddress: 'spark1address' },
      ],
      syncState: async () => ({
        newestCreatedAt: new Date('2026-11-12T12:00:00.000Z'),
        oldestPendingCreatedAt: new Date('2026-11-12T10:00:00.000Z'),
        pendingWithoutCreatedAt: false,
        lastFullSyncAt: new Date(NOW),
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
      upsertTokenTransaction: noTokenWrite,
      markFullSync: noFullSyncWrite,
      hasShopPayment: async () => false,
    };
    const recordBalance = vi.fn(async () => undefined);
    const failed = await runWalletTransferTick({
      viewer: {
        transfers: viewerTransfers,
        tokenTransactions: noTokenTransactions,
        balance: async () => 0,
      },
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
      expect.objectContaining({ createdAfter: new Date('2026-11-12T09:59:59.999Z') }),
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
      new Set(['pending', 'completed', 'cancelled', 'expired', 'returned']),
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
    expect(stored.find((record) => record.transferId === 'multi-party')).toMatchObject({
      direction: 'out',
      amountSats: 34,
      counterpartyPubkey: SHOP,
    });
    expect(stored.find((record) => record.transferId === 'multi-out-no-leaves')).toBeUndefined();
    expect(stored.find((record) => record.transferId === 'multi-incoming')).toMatchObject({
      direction: 'in',
      status: 'completed',
      amountSats: 21,
      counterpartyPubkey: SHOP,
    });
    expect(stored.find((record) => record.transferId === 'multi-returned')).toMatchObject({
      direction: 'in',
      status: 'cancelled',
      amountSats: 1,
      counterpartyPubkey: SHOP,
    });
    expect(stored.find((record) => record.transferId === 'multi-pending')).toMatchObject({
      direction: 'in',
      status: 'pending',
      amountSats: 2,
    });
    expect(stored.find((record) => record.transferId === 'self-counterparty')).toMatchObject({
      counterpartyPubkey: OWNER,
      counterpartyPubkeys: [OWNER],
    });
    expect(stored).toHaveLength(16);
    expect(recordBalance).toHaveBeenCalledOnce();
  });

  it('forces full scans and skips catch-up for missing or ineligible accounts', async () => {
    const store: WalletTransferStore = {
      listWallets: async () => [
        { accountId: 'missing', sparkPubkey: OWNER, sparkAddress: 'spark1address' },
        { accountId: 'ineligible', sparkPubkey: OWNER, sparkAddress: 'spark1second' },
      ],
      syncState: async (accountId) =>
        accountId === 'missing'
          ? {
              newestCreatedAt: new Date(NOW),
              oldestPendingCreatedAt: null,
              pendingWithoutCreatedAt: true,
              lastFullSyncAt: new Date(NOW),
            }
          : {
              newestCreatedAt: new Date(NOW),
              oldestPendingCreatedAt: null,
              pendingWithoutCreatedAt: false,
              lastFullSyncAt: new Date('2026-11-11T12:00:00.000Z'),
            },
      upsertTransfer: async () => ({
        inserted: false,
        updated: false,
        shopPaymentBecameCompleted: true,
      }),
      upsertTokenTransaction: noTokenWrite,
      markFullSync: noFullSyncWrite,
      hasShopPayment: async () => false,
    };
    const transfers = vi.fn(async () => ({ transfers: [transfer()], offset: -1, rawCount: 1 }));
    await runWalletTransferTick({
      viewer: { transfers, tokenTransactions: noTokenTransactions, balance: async () => 0 },
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

  it('fails a wallet when the transfer offset repeats', async () => {
    const store: WalletTransferStore = {
      listWallets: async () => [
        { accountId: 'account', sparkPubkey: OWNER, sparkAddress: 'spark1address' },
      ],
      syncState: async () => ({
        newestCreatedAt: new Date(NOW),
        oldestPendingCreatedAt: null,
        pendingWithoutCreatedAt: false,
        lastFullSyncAt: new Date(NOW),
      }),
      upsertTransfer: async () => ({
        inserted: false,
        updated: false,
        shopPaymentBecameCompleted: false,
      }),
      upsertTokenTransaction: noTokenWrite,
      markFullSync: noFullSyncWrite,
      hasShopPayment: async () => false,
    };
    const failed = await runWalletTransferTick({
      viewer: {
        transfers: async () => ({ transfers: [], offset: 0, rawCount: 100 }),
        tokenTransactions: noTokenTransactions,
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
    expect(failed.get(`account\u0000${OWNER}`)).toBe(true);
  });

  it('fails token paging on a missing or repeated next cursor', async () => {
    const store: WalletTransferStore = {
      listWallets: async () => [
        { accountId: 'account', sparkPubkey: OWNER, sparkAddress: 'spark1address' },
      ],
      syncState: async () => ({
        newestCreatedAt: null,
        oldestPendingCreatedAt: null,
        pendingWithoutCreatedAt: false,
        lastFullSyncAt: null,
      }),
      upsertTransfer: async () => ({
        inserted: false,
        updated: false,
        shopPaymentBecameCompleted: false,
      }),
      upsertTokenTransaction: noTokenWrite,
      markFullSync: noFullSyncWrite,
      hasShopPayment: async () => false,
    };
    const base = {
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
    const missing = await runWalletTransferTick({
      ...base,
      viewer: {
        transfers: async () => ({ transfers: [], offset: -1, rawCount: 0 }),
        tokenTransactions: async () => ({
          transactions: [],
          hasNextPage: true,
          nextCursor: null,
          rawCount: 100,
        }),
        balance: async () => 0,
      },
    });
    expect(missing.get(`account\u0000${OWNER}`)).toBe(true);

    const repeated = await runWalletTransferTick({
      ...base,
      viewer: {
        transfers: async () => ({ transfers: [], offset: -1, rawCount: 0 }),
        tokenTransactions: async () => ({
          transactions: [],
          hasNextPage: true,
          nextCursor: 'same',
          rawCount: 100,
        }),
        balance: async () => 0,
      },
    });
    expect(repeated.get(`account\u0000${OWNER}`)).toBe(true);
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
        lastFullSyncAt: null,
      }),
      upsertTransfer: async () => ({
        inserted: false,
        updated: false,
        shopPaymentBecameCompleted: false,
      }),
      upsertTokenTransaction: noTokenWrite,
      markFullSync: noFullSyncWrite,
      hasShopPayment: async () => false,
    };
    const pending = runWalletTransferTick({
      viewer: {
        transfers: () =>
          new Promise<{ transfers: SparkViewerTransfer[]; offset: number; rawCount: number }>(
            () => undefined,
          ),
        tokenTransactions: noTokenTransactions,
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
      viewer: {
        transfers: async () => ({ transfers: [], offset: -1, rawCount: 0 }),
        tokenTransactions: noTokenTransactions,
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
        lastFullSyncAt: null,
      })),
      upsertTransfer: vi.fn(async () => ({
        inserted: false,
        updated: false,
        shopPaymentBecameCompleted: false,
      })),
      upsertTokenTransaction: vi.fn(noTokenWrite),
      markFullSync: vi.fn(noFullSyncWrite),
      hasShopPayment: vi.fn(async () => false),
    };
    const handle = startWalletTransferWorker({
      viewer: {
        transfers: async () => ({ transfers: [], offset: -1, rawCount: 0 }),
        tokenTransactions: noTokenTransactions,
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
        viewer: {
          transfers: async () => ({ transfers: [], offset: -1, rawCount: 0 }),
          tokenTransactions: noTokenTransactions,
          balance: async () => 0,
        },
        transfers: {
          listWallets,
          syncState: async () => ({
            newestCreatedAt: null,
            oldestPendingCreatedAt: null,
            pendingWithoutCreatedAt: false,
            lastFullSyncAt: null,
          }),
          upsertTransfer: async () => ({
            inserted: false,
            updated: false,
            shopPaymentBecameCompleted: false,
          }),
          upsertTokenTransaction: noTokenWrite,
          markFullSync: noFullSyncWrite,
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
        viewer: {
          transfers: async () => ({ transfers: [], offset: -1, rawCount: 0 }),
          tokenTransactions: noTokenTransactions,
          balance: async () => 0,
        },
        transfers: {
          listWallets,
          syncState: async () => ({
            newestCreatedAt: null,
            oldestPendingCreatedAt: null,
            pendingWithoutCreatedAt: false,
            lastFullSyncAt: null,
          }),
          upsertTransfer: async () => ({
            inserted: false,
            updated: false,
            shopPaymentBecameCompleted: false,
          }),
          upsertTokenTransaction: noTokenWrite,
          markFullSync: noFullSyncWrite,
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
        viewer: {
          transfers: async () => ({ transfers: [], offset: -1, rawCount: 0 }),
          tokenTransactions: noTokenTransactions,
          balance: async () => 0,
        },
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
              lastFullSyncAt: null,
            };
          },
          upsertTransfer: async () => ({
            inserted: false,
            updated: false,
            shopPaymentBecameCompleted: false,
          }),
          upsertTokenTransaction: noTokenWrite,
          markFullSync: noFullSyncWrite,
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
        viewer: {
          transfers: async () => ({ transfers: [], offset: -1, rawCount: 0 }),
          tokenTransactions: noTokenTransactions,
          balance: async () => 0,
        },
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
          upsertTokenTransaction: noTokenWrite,
          markFullSync: noFullSyncWrite,
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

describe('wallet transfer worker edge decisions', () => {
  async function runWithTransfers(
    transfers: Parameters<typeof runWalletTransferTick>[0]['viewer']['transfers'],
    syncState: Awaited<ReturnType<WalletTransferStore['syncState']>> = {
      newestCreatedAt: new Date(NOW),
      oldestPendingCreatedAt: null,
      pendingWithoutCreatedAt: false,
      lastFullSyncAt: new Date(NOW),
    },
    tokenTransactions: Parameters<
      typeof runWalletTransferTick
    >[0]['viewer']['tokenTransactions'] = noTokenTransactions,
  ): Promise<{ failed: Map<string, boolean>; stored: WalletTransferRecord[] }> {
    const stored: WalletTransferRecord[] = [];
    const store: WalletTransferStore = {
      listWallets: async () => [
        { accountId: 'account', sparkPubkey: OWNER, sparkAddress: 'spark1address' },
      ],
      syncState: async () => syncState,
      upsertTransfer: async (row) => {
        stored.push(row);
        return {
          inserted: false,
          updated: false,
          shopPaymentBecameCompleted: false,
        };
      },
      upsertTokenTransaction: noTokenWrite,
      markFullSync: noFullSyncWrite,
      hasShopPayment: async () => false,
    };
    const failed = await runWalletTransferTick({
      viewer: { transfers, tokenTransactions, balance: async () => 0 },
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
    return { failed, stored };
  }

  it('derives every incremental cursor through the public worker', async () => {
    const createdAfter: Array<Date | undefined> = [];
    const transfers: Parameters<typeof runWalletTransferTick>[0]['viewer']['transfers'] = async (
      input,
    ) => {
      createdAfter.push(input.createdAfter);
      return { transfers: [], offset: -1, rawCount: 0 };
    };
    const states: Array<Awaited<ReturnType<WalletTransferStore['syncState']>>> = [
      {
        newestCreatedAt: new Date('2025-03-04T05:06:07.000Z'),
        oldestPendingCreatedAt: null,
        pendingWithoutCreatedAt: true,
        lastFullSyncAt: new Date(NOW),
      },
      {
        newestCreatedAt: null,
        oldestPendingCreatedAt: null,
        pendingWithoutCreatedAt: false,
        lastFullSyncAt: new Date(NOW),
      },
      {
        newestCreatedAt: null,
        oldestPendingCreatedAt: new Date('2025-03-04T05:06:07.000Z'),
        pendingWithoutCreatedAt: false,
        lastFullSyncAt: new Date(NOW),
      },
      {
        newestCreatedAt: new Date('2025-03-05T05:06:07.000Z'),
        oldestPendingCreatedAt: new Date('2025-03-04T05:06:07.000Z'),
        pendingWithoutCreatedAt: false,
        lastFullSyncAt: new Date(NOW),
      },
      {
        newestCreatedAt: new Date('2025-03-05T05:06:07.000Z'),
        oldestPendingCreatedAt: null,
        pendingWithoutCreatedAt: false,
        lastFullSyncAt: new Date(NOW),
      },
    ];

    for (const state of states) {
      const { failed } = await runWithTransfers(transfers, state);
      expect(failed.size).toBe(0);
    }

    expect(createdAfter).toEqual([
      undefined,
      undefined,
      new Date('2025-03-04T05:06:06.999Z'),
      new Date('2025-03-04T05:06:06.999Z'),
      new Date('2025-03-05T04:06:07.000Z'),
    ]);
  });

  it('reads tokens every tick and stops an incremental pass after the overlap boundary', async () => {
    const tokenTransactions = vi.fn(async () => ({
      transactions: [
        {
          hash: '11'.repeat(32),
          tokenIdentifier: '22'.repeat(32),
          direction: 'in' as const,
          amount: '1',
          counterpartyPubkeys: [],
          sparkInvoices: ['spark1token'],
          type: 'mint' as const,
          status: 2,
          createdTime: new Date('2026-11-12T10:00:00.000Z'),
          expiryTime: undefined,
        },
      ],
      hasNextPage: true,
      nextCursor: 'older',
      rawCount: 100,
    }));
    const { failed } = await runWithTransfers(
      async () => ({ transfers: [], offset: -1, rawCount: 0 }),
      {
        newestCreatedAt: null,
        oldestPendingCreatedAt: null,
        pendingWithoutCreatedAt: false,
        newestTokenCreatedAt: new Date(NOW),
        oldestPendingTokenCreatedAt: null,
        pendingTokenWithoutCreatedAt: false,
        lastFullSyncAt: new Date(NOW),
      },
      tokenTransactions,
    );

    expect(failed.size).toBe(0);
    expect(tokenTransactions).toHaveBeenCalledOnce();
  });

  it('maps counterparties through public wallet synchronization', async () => {
    const rows = [
      transfer({
        id: 'outbound-leaves',
        senders: [{ id: 'sender-owner', identityPublicKey: bytes(OWNER) }],
        receivers: [
          { id: 'wallet', identityPublicKey: bytes(OWNER), amountSats: 1, status: 5 },
          { id: 'z', identityPublicKey: bytes(SHOP), amountSats: 1, status: 5 },
          { id: 'a', identityPublicKey: bytes(MEMBER), amountSats: 1, status: 5 },
        ],
        leaves: [
          { senderId: 'sender-owner', receiverId: 'missing', value: 1 },
          { senderId: 'sender-owner', receiverId: 'z', value: 1 },
          { senderId: 'sender-owner', receiverId: 'a', value: 1 },
          { senderId: 'sender-owner', receiverId: 'wallet', value: 1 },
        ],
      }),
      transfer({
        id: 'outbound-fallback',
        senders: [{ id: 'sender-owner', identityPublicKey: bytes(OWNER) }],
        receivers: [
          { id: 'wallet', identityPublicKey: bytes(OWNER), amountSats: 1, status: 5 },
          { id: 'z', identityPublicKey: bytes(SHOP), amountSats: 1, status: 5 },
          { id: 'a', identityPublicKey: bytes(MEMBER), amountSats: 1, status: 5 },
        ],
      }),
      transfer({
        id: 'outbound-without-counterparty',
        senders: [{ id: 'sender-owner', identityPublicKey: bytes(OWNER) }],
        receivers: [{ id: 'wallet', identityPublicKey: bytes(OWNER), amountSats: 1, status: 5 }],
        leaves: [{ senderId: 'sender-owner', receiverId: 'missing', value: 1 }],
      }),
      transfer({
        id: 'empty-edge-ids',
        senders: [{ id: '', identityPublicKey: bytes(OWNER) }],
        receivers: [{ id: '', identityPublicKey: bytes(SHOP), amountSats: 999, status: 6 }],
        leaves: [{ senderId: '', receiverId: '', value: 999 }],
      }),
      transfer({
        id: 'inbound-leaves',
        senders: [{ id: 'z', identityPublicKey: bytes(SHOP) }],
        receivers: [
          { id: 'receiver-owner', identityPublicKey: bytes(OWNER), amountSats: 2, status: 6 },
        ],
        leaves: [
          { senderId: 'missing', receiverId: 'receiver-owner', value: 1 },
          { senderId: 'z', receiverId: 'receiver-owner', value: 1 },
        ],
      }),
      transfer({
        id: 'inbound-fallback',
        senders: [
          { id: 'z', identityPublicKey: bytes(SHOP) },
          { id: 'a', identityPublicKey: bytes(MEMBER) },
        ],
        receivers: [
          { id: 'receiver-owner', identityPublicKey: bytes(OWNER), amountSats: 2, status: 6 },
        ],
      }),
      transfer({
        id: 'inbound-without-counterparty',
        senders: [{ id: 'z', identityPublicKey: Uint8Array.of(1) }],
        receivers: [
          { id: 'receiver-owner', identityPublicKey: bytes(OWNER), amountSats: 1, status: 6 },
        ],
        leaves: [{ senderId: 'missing', receiverId: 'receiver-owner', value: 1 }],
      }),
      transfer({
        id: 'inbound-invalid-amount',
        senders: [{ id: 'z', identityPublicKey: bytes(SHOP) }],
        receivers: [
          { id: 'receiver-owner', identityPublicKey: bytes(OWNER), amountSats: -1, status: 6 },
        ],
        leaves: [{ senderId: 'z', receiverId: 'receiver-owner', value: 1 }],
      }),
    ];
    const { failed, stored } = await runWithTransfers(async () => ({
      transfers: rows,
      offset: -1,
      rawCount: rows.length,
    }));

    expect(failed.size).toBe(0);
    expect(
      stored.map(({ transferId, counterpartyPubkey, counterpartyPubkeys }) => ({
        transferId,
        counterpartyPubkey,
        counterpartyPubkeys,
      })),
    ).toEqual([
      {
        transferId: 'outbound-leaves',
        counterpartyPubkey: MEMBER,
        counterpartyPubkeys: [MEMBER, SHOP],
      },
      {
        transferId: 'inbound-leaves',
        counterpartyPubkey: SHOP,
        counterpartyPubkeys: [SHOP],
      },
      {
        transferId: 'inbound-invalid-amount',
        counterpartyPubkey: SHOP,
        counterpartyPubkeys: [SHOP],
      },
    ]);
  });

  it('sums leaves on every own non-empty receiver edge and ignores amountSats', async () => {
    const { failed, stored } = await runWithTransfers(async () => ({
      transfers: [
        transfer({
          id: 'incoming-sum',
          senders: [{ id: 'sender-shop', identityPublicKey: bytes(SHOP) }],
          receivers: [
            {
              id: 'receiver-owner-1',
              identityPublicKey: bytes(OWNER),
              amountSats: 800,
              status: 6,
            },
            {
              id: 'receiver-owner-2',
              identityPublicKey: bytes(OWNER),
              amountSats: 1_300,
              status: 6,
            },
          ],
          leaves: [
            { senderId: 'sender-shop', receiverId: 'receiver-owner-1', value: 8 },
            { senderId: 'sender-shop', receiverId: 'receiver-owner-2', value: 13 },
          ],
        }),
      ],
      offset: -1,
      rawCount: 1,
    }));

    expect(failed.size).toBe(0);
    expect(stored).toEqual([
      expect.objectContaining({ transferId: 'incoming-sum', amountSats: 21 }),
    ]);
  });

  it('uses the returned rows when a fake viewer omits its raw count', async () => {
    let calls = 0;
    const { failed } = await runWithTransfers(async () => {
      calls += 1;
      return calls === 1
        ? { transfers: [], offset: 100, rawCount: 100 }
        : ({ transfers: [], offset: 2 } as never);
    });

    expect(failed.size).toBe(0);
    expect(calls).toBe(2);
  });
});
