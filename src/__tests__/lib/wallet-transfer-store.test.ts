import { describe, expect, it, vi } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import { postgresTextArrayLiteral } from '@/lib/postgres-text-array';
import {
  InMemoryWalletTransferStore,
  PostgresWalletTransferStore,
  type WalletTransferRecord,
  type WalletTokenTransactionRecord,
} from '@/lib/wallet-transfer-store';

const OWNER = `02${'a'.repeat(64)}`;
const SHOP = `03${'b'.repeat(64)}`;
const MEMBER = `02${'c'.repeat(64)}`;
const UNKNOWN = `03${'d'.repeat(64)}`;

function row(partial: Partial<WalletTransferRecord> = {}): WalletTransferRecord {
  return {
    accountId: 'account',
    walletPubkey: OWNER,
    transferId: 'transfer-1',
    direction: 'out',
    type: 'transfer',
    status: 'pending',
    amountSats: 21,
    counterpartyPubkey: SHOP,
    counterpartyPubkeys: partial.counterpartyPubkeys ?? [partial.counterpartyPubkey ?? SHOP],
    sparkInvoice: null,
    transferCreatedAt: new Date('2026-11-12T08:00:00.000Z'),
    transferUpdatedAt: null,
    seenAt: new Date('2026-11-12T08:01:00.000Z'),
    ...partial,
  };
}

function tokenRow(
  partial: Partial<WalletTokenTransactionRecord> = {},
): WalletTokenTransactionRecord {
  return {
    accountId: 'account',
    walletPubkey: OWNER,
    transactionHash: '11'.repeat(32),
    tokenIdentifier: null,
    direction: 'in',
    amount: '21',
    counterpartyPubkeys: [],
    sparkInvoices: [],
    type: 'mint',
    status: 'started',
    transactionCreatedAt: new Date('2026-11-12T07:00:00.000Z'),
    transactionExpiryAt: null,
    seenAt: new Date('2026-11-12T08:00:00.000Z'),
    ...partial,
  };
}

describe('InMemoryWalletTransferStore', () => {
  it('lists wallets, tracks pending state, updates, and verifies shop days', async () => {
    const store = new InMemoryWalletTransferStore({
      wallets: [{ accountId: 'account', sparkPubkey: OWNER, sparkAddress: 'spark1address' }],
      verifiedAccountForPubkey: async (pubkey) => (pubkey === SHOP ? 'shop-account' : null),
      isShop: async (accountId) => accountId === 'shop-account',
    });
    await expect(store.listWallets()).resolves.toEqual([
      { accountId: 'account', sparkPubkey: OWNER, sparkAddress: 'spark1address' },
    ]);
    const multiRecipient = { counterpartyPubkey: MEMBER, counterpartyPubkeys: [MEMBER, SHOP] };
    await expect(store.upsertTransfer(row(multiRecipient))).resolves.toEqual({
      inserted: true,
      updated: false,
      shopPaymentBecameCompleted: false,
    });
    await expect(store.syncState('account', OWNER)).resolves.toEqual({
      newestCreatedAt: new Date('2026-11-12T08:00:00.000Z'),
      oldestPendingCreatedAt: new Date('2026-11-12T08:00:00.000Z'),
      pendingWithoutCreatedAt: false,
      newestTokenCreatedAt: null,
      oldestPendingTokenCreatedAt: null,
      pendingTokenWithoutCreatedAt: false,
      lastFullSyncAt: null,
    });
    await expect(
      store.upsertTransfer(
        row({
          ...multiRecipient,
          status: 'completed',
          transferUpdatedAt: new Date('2026-11-12T09:00:00.000Z'),
          seenAt: new Date('2026-11-12T09:01:00.000Z'),
        }),
      ),
    ).resolves.toEqual({ inserted: false, updated: true, shopPaymentBecameCompleted: true });
    await expect(
      store.upsertTransfer(
        row({
          ...multiRecipient,
          status: 'completed',
          transferUpdatedAt: new Date('2026-11-12T09:00:00.000Z'),
          seenAt: new Date('2026-11-12T09:02:00.000Z'),
        }),
      ),
    ).resolves.toEqual({ inserted: false, updated: false, shopPaymentBecameCompleted: false });
    await expect(store.hasShopPayment('account', '2026-11-11', '2026-11-12')).resolves.toBe(true);
    await expect(store.hasShopPayment('account', '2026-11-10', '2026-11-11')).resolves.toBe(false);
  });

  it('keeps the same transfer id for different wallets and persists token/full-sync state', async () => {
    const store = new InMemoryWalletTransferStore();
    await expect(store.upsertTransfer(row())).resolves.toMatchObject({ inserted: true });
    await expect(store.upsertTransfer(row({ walletPubkey: MEMBER }))).resolves.toMatchObject({
      inserted: true,
      updated: true,
    });
    await store.upsertTokenTransaction({
      accountId: 'account',
      walletPubkey: OWNER,
      transactionHash: '11'.repeat(32),
      tokenIdentifier: '22'.repeat(32),
      direction: 'in',
      amount: '21',
      counterpartyPubkeys: [],
      sparkInvoices: ['spark1mint'],
      type: 'mint',
      status: 'finalized',
      transactionCreatedAt: new Date('2026-11-12T07:00:00.000Z'),
      transactionExpiryAt: null,
      seenAt: new Date('2026-11-12T08:00:00.000Z'),
    });
    await store.markFullSync('account', OWNER, new Date('2026-11-12T09:00:00.000Z'));
    await expect(store.syncState('account', OWNER)).resolves.toMatchObject({
      lastFullSyncAt: new Date('2026-11-12T09:00:00.000Z'),
    });
  });

  it('tracks dated and undated pending token transactions only', async () => {
    const store = new InMemoryWalletTransferStore();
    await store.upsertTokenTransaction(tokenRow());
    await store.upsertTokenTransaction(
      tokenRow({
        transactionHash: '22'.repeat(32),
        status: 'signed',
        transactionCreatedAt: null,
      }),
    );
    await store.upsertTokenTransaction(
      tokenRow({
        transactionHash: '33'.repeat(32),
        status: 'finalized',
        transactionCreatedAt: new Date('2026-11-12T09:00:00.000Z'),
      }),
    );
    await store.upsertTokenTransaction(
      tokenRow({
        transactionHash: '44'.repeat(32),
        status: 'cancelled',
        transactionCreatedAt: null,
      }),
    );

    await expect(store.syncState('account', OWNER)).resolves.toMatchObject({
      newestTokenCreatedAt: new Date('2026-11-12T09:00:00.000Z'),
      oldestPendingTokenCreatedAt: new Date('2026-11-12T07:00:00.000Z'),
      pendingTokenWithoutCreatedAt: true,
    });
  });

  it('forces a full reread for a pending row without a creation time', async () => {
    const store = new InMemoryWalletTransferStore();
    await store.upsertTransfer(row({ transferCreatedAt: null }));
    expect(await store.syncState('account', OWNER)).toEqual({
      newestCreatedAt: null,
      oldestPendingCreatedAt: null,
      pendingWithoutCreatedAt: true,
      newestTokenCreatedAt: null,
      oldestPendingTokenCreatedAt: null,
      pendingTokenWithoutCreatedAt: false,
      lastFullSyncAt: null,
    });
  });

  it('treats counterparties as non-shops when no shop predicate is provided', async () => {
    const store = new InMemoryWalletTransferStore({
      verifiedAccountForPubkey: async (pubkey) => (pubkey === MEMBER ? 'member-account' : null),
    });
    await expect(
      store.upsertTransfer(
        row({
          status: 'completed',
          counterpartyPubkey: MEMBER,
          transferUpdatedAt: new Date('2026-11-12T09:00:00.000Z'),
        }),
      ),
    ).resolves.toEqual({ inserted: true, updated: false, shopPaymentBecameCompleted: false });
    await expect(store.hasShopPayment('account', '2026-11-12', '2026-11-12')).resolves.toBe(false);
  });

  it('covers default resolvers and excludes non-shop transfer shapes and days', async () => {
    const defaults = new InMemoryWalletTransferStore();
    await expect(defaults.listWallets()).resolves.toEqual([]);
    await expect(defaults.syncState('account', OWNER)).resolves.toEqual({
      newestCreatedAt: null,
      oldestPendingCreatedAt: null,
      pendingWithoutCreatedAt: false,
      newestTokenCreatedAt: null,
      oldestPendingTokenCreatedAt: null,
      pendingTokenWithoutCreatedAt: false,
      lastFullSyncAt: null,
    });
    await expect(defaults.upsertTransfer(row({ status: 'completed' }))).resolves.toEqual({
      inserted: true,
      updated: false,
      shopPaymentBecameCompleted: false,
    });
    await expect(defaults.hasShopPayment('account', '2026-11-11', '2026-11-12')).resolves.toBe(
      false,
    );

    const edge = new InMemoryWalletTransferStore({
      verifiedAccountForPubkey: async (pubkey) => {
        if (pubkey === SHOP) return 'shop-account';
        if (pubkey === OWNER) return 'account';
        if (pubkey === MEMBER) return 'member-account';
        return null;
      },
      isShop: async (accountId) => accountId === 'shop-account',
    });
    const variants: WalletTransferRecord[] = [
      row({ transferId: 'other-account', accountId: 'other', status: 'completed' }),
      row({ transferId: 'incoming', direction: 'in', status: 'completed' }),
      row({ transferId: 'pending', status: 'pending' }),
      row({ transferId: 'swap', type: 'swap', status: 'completed' }),
      row({
        transferId: 'no-day',
        status: 'completed',
        transferCreatedAt: null,
        transferUpdatedAt: null,
      }),
      row({ transferId: 'self', status: 'completed', counterpartyPubkey: OWNER }),
      row({ transferId: 'member', status: 'completed', counterpartyPubkey: MEMBER }),
      row({ transferId: 'unknown', status: 'completed', counterpartyPubkey: UNKNOWN }),
      row({
        transferId: 'old',
        status: 'completed',
        transferCreatedAt: new Date('2026-11-10T08:00:00.000Z'),
      }),
    ];
    for (const variant of variants) await edge.upsertTransfer(variant);
    for (const variant of variants) await edge.upsertTransfer(variant);
    await expect(edge.hasShopPayment('account', '2026-11-11', '2026-11-12')).resolves.toBe(false);
  });

  it('treats every substantive transfer field as an update', async () => {
    const changes: Array<Partial<WalletTransferRecord>> = [
      { walletPubkey: SHOP },
      { direction: 'in' },
      { type: 'swap' },
      { status: 'completed' },
      { amountSats: 22 },
      { counterpartyPubkey: MEMBER },
      { counterpartyPubkeys: [MEMBER] },
      { sparkInvoice: 'spark1other' },
      { transferCreatedAt: new Date('2026-11-12T08:00:01.000Z') },
      { transferUpdatedAt: new Date('2026-11-12T08:00:01.000Z') },
    ];
    for (const change of changes) {
      const store = new InMemoryWalletTransferStore();
      await store.upsertTransfer(row());
      await expect(store.upsertTransfer(row(change))).resolves.toMatchObject({ updated: true });
    }
  });

  it('keeps hasShopPayment false when an unverified shop account claims the payer key', async () => {
    const store = new InMemoryWalletTransferStore({
      verifiedAccountForPubkey: async () => null,
      previousAccountForPubkey: async () => null,
      isShop: async (accountId) => accountId === 'unverified-shop',
    });
    await store.upsertTransfer(
      row({
        status: 'completed',
        counterpartyPubkey: OWNER,
        counterpartyPubkeys: [OWNER],
      }),
    );

    await expect(store.hasShopPayment('account', '2026-11-12', '2026-11-12')).resolves.toBe(false);
  });

  it('keeps a previous_wallet shop key true when another account claims it unverified', async () => {
    const verified = vi.fn(async () => null);
    const previous = vi.fn(async (pubkey: string) => (pubkey === SHOP ? 'shop-account' : null));
    const store = new InMemoryWalletTransferStore({
      verifiedAccountForPubkey: verified,
      previousAccountForPubkey: previous,
      isShop: async (accountId) => accountId === 'shop-account',
    });
    await store.upsertTransfer(row({ status: 'completed' }));

    await expect(store.hasShopPayment('account', '2026-11-12', '2026-11-12')).resolves.toBe(true);
    expect(verified).toHaveBeenCalledWith(SHOP);
    expect(previous).toHaveBeenCalledWith(SHOP);
  });

  it('deterministically prefers a verified current owner over previous_wallet', async () => {
    const previous = vi.fn(async () => 'old-shop');
    const store = new InMemoryWalletTransferStore({
      verifiedAccountForPubkey: async () => 'verified-member',
      previousAccountForPubkey: previous,
      isShop: async (accountId) => accountId === 'old-shop',
    });
    await store.upsertTransfer(row({ status: 'completed' }));

    await expect(store.hasShopPayment('account', '2026-11-12', '2026-11-12')).resolves.toBe(false);
    expect(previous).not.toHaveBeenCalled();
  });
});

describe('PostgresWalletTransferStore', () => {
  it('lists wallets, maps sync state, and runs the one-statement shop query', async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes('UNION ALL')) {
        return [{ accountId: 'account', sparkPubkey: OWNER, sparkAddress: 'spark1address' }];
      }
      if (text.includes('max(transfer_created_at)')) {
        return [
          {
            newest_created_at: '2026-11-12T08:00:00.000Z',
            oldest_pending_created_at: new Date('2026-11-12T07:00:00.000Z'),
            pending_without_created_at: true,
            newest_token_created_at: '2026-11-12T05:00:00.000Z',
            oldest_pending_token_created_at: '2026-11-12T04:00:00.000Z',
            pending_token_without_created_at: true,
            last_full_sync_at: '2026-11-12T06:00:00.000Z',
          },
        ];
      }
      return [{ present: true }];
    });
    const sql = { query, execute: vi.fn(async () => undefined) } as unknown as SqlClient;
    const store = new PostgresWalletTransferStore(sql);
    await expect(store.listWallets()).resolves.toHaveLength(1);
    await expect(store.syncState('account', OWNER)).resolves.toEqual({
      newestCreatedAt: new Date('2026-11-12T08:00:00.000Z'),
      oldestPendingCreatedAt: new Date('2026-11-12T07:00:00.000Z'),
      pendingWithoutCreatedAt: true,
      newestTokenCreatedAt: new Date('2026-11-12T05:00:00.000Z'),
      oldestPendingTokenCreatedAt: new Date('2026-11-12T04:00:00.000Z'),
      pendingTokenWithoutCreatedAt: true,
      lastFullSyncAt: new Date('2026-11-12T06:00:00.000Z'),
    });
    await expect(store.hasShopPayment('account', '2026-11-11', '2026-11-12')).resolves.toBe(true);
    expect(query.mock.calls.at(-1)?.[0]).toContain('JOIN message AS shop');
    expect(query.mock.calls.at(-1)?.[0]).toContain('unnest(payment.counterparty_pubkeys)');
    expect(query.mock.calls.at(-1)?.[0]).toContain('spark_pubkey_verified_at IS NOT NULL');
    expect(query.mock.calls.at(-1)?.[0]).toContain('ORDER BY replaced_at DESC, account_id');
    expect(query.mock.calls.at(-1)?.[0]).toContain("AT TIME ZONE 'UTC'");
  });

  it('maps empty sync state and a false shop query', async () => {
    const query = vi.fn(async (text: string): Promise<unknown[]> => {
      if (text.includes('max(transfer_created_at)')) return [];
      return [];
    }) as unknown as <T>(text: string, params?: readonly unknown[]) => Promise<T[]>;
    const store = new PostgresWalletTransferStore({
      query,
      execute: async () => undefined,
    });
    await expect(store.syncState('account', OWNER)).resolves.toEqual({
      newestCreatedAt: null,
      oldestPendingCreatedAt: null,
      pendingWithoutCreatedAt: false,
      newestTokenCreatedAt: null,
      oldestPendingTokenCreatedAt: null,
      pendingTokenWithoutCreatedAt: false,
      lastFullSyncAt: null,
    });
    await expect(store.hasShopPayment('account', '2026-11-11', '2026-11-12')).resolves.toBe(false);
  });

  it('requires transaction support for writes', async () => {
    const store = new PostgresWalletTransferStore({
      query: async () => [],
      execute: async () => {},
    });
    await expect(store.upsertTransfer(row())).rejects.toThrow('require a transaction');
  });

  it('writes token transactions and durable full-sync watermarks', async () => {
    const execute = vi.fn(async (_text: string, _params?: readonly unknown[]) => undefined);
    const store = new PostgresWalletTransferStore({ query: async () => [], execute });
    await store.upsertTokenTransaction({
      accountId: 'account',
      walletPubkey: OWNER,
      transactionHash: '22'.repeat(32),
      tokenIdentifier: '33'.repeat(32),
      direction: 'out',
      amount: '256',
      counterpartyPubkeys: [MEMBER, SHOP],
      sparkInvoices: ['spark1one', 'spark1two'],
      type: 'transfer',
      status: 'revealed',
      transactionCreatedAt: null,
      transactionExpiryAt: new Date('2026-11-12T08:05:00.000Z'),
      seenAt: new Date('2026-11-12T08:00:00.000Z'),
    });
    await store.markFullSync('account', OWNER, new Date('2026-11-12T09:00:00.000Z'));
    expect(execute.mock.calls[0]?.[0]).toContain('INSERT INTO wallet_token_transaction');
    expect(execute.mock.calls[0]?.[0]).not.toContain('payload');
    expect(execute.mock.calls[0]?.[1]).toContain('256');
    expect(execute.mock.calls[0]?.[1]?.[7]).toBe(
      postgresTextArrayLiteral(['spark1one', 'spark1two']),
    );
    expect(execute.mock.calls[1]?.[0]).toContain('INSERT INTO wallet_transfer_sync');
  });

  it('reports a pending-to-completed shop transition in one transaction', async () => {
    let calls = 0;
    const tx: SqlClient = {
      execute: vi.fn(async () => undefined),
      query: async <T>(): Promise<T[]> => {
        calls += 1;
        if (calls === 1) {
          return [
            {
              wallet_pubkey: OWNER,
              direction: 'out',
              type: 'transfer',
              status: 'pending',
              amount_sats: 21,
              counterparty_pubkey: SHOP,
              counterparty_pubkeys: [SHOP],
              counterparty_account_id: 'shop-account',
              spark_invoice: null,
              transfer_created_at: new Date('2026-11-12T08:00:00.000Z'),
              transfer_updated_at: null,
              is_shop_payment: false,
            },
          ] as unknown as T[];
        }
        return [
          { is_shop_payment: true, counterparty_account_id: 'shop-account' },
        ] as unknown as T[];
      },
    };
    const sql: SqlClient = {
      query: async () => [],
      execute: async () => {},
      transaction: async (run) => run(tx),
    };
    const store = new PostgresWalletTransferStore(sql);
    await expect(
      store.upsertTransfer(
        row({ status: 'completed', transferUpdatedAt: new Date('2026-11-12T09:00:00.000Z') }),
      ),
    ).resolves.toEqual({ inserted: false, updated: true, shopPaymentBecameCompleted: true });
  });

  it('reports inserts, other-wallet fields, and counterparty-only updates from snapshots', async () => {
    const incoming = row({
      status: 'completed',
      transferCreatedAt: new Date('2026-11-12T08:00:00.000Z'),
    });
    const before = {
      wallet_pubkey: OWNER,
      direction: 'out' as const,
      type: 'transfer' as const,
      status: 'completed' as const,
      amount_sats: '21',
      counterparty_pubkey: SHOP,
      counterparty_pubkeys: [SHOP],
      counterparty_account_id: 'old-shop',
      spark_invoice: null,
      transfer_created_at: '2026-11-12T08:00:00.000Z',
      transfer_updated_at: null,
      is_shop_payment: false,
    };
    let mode: 'insert' | 'update' | 'same' | 'other-wallet' = 'insert';
    let reads = 0;
    const tx: SqlClient = {
      execute: async () => undefined,
      query: async <T>(): Promise<T[]> => {
        reads += 1;
        if (mode === 'insert') return [];
        return (reads % 2 === 1
          ? [mode === 'other-wallet' ? { ...before, wallet_pubkey: MEMBER } : before]
          : [
              {
                counterparty_account_id: mode === 'same' ? 'old-shop' : 'new-shop',
                is_shop_payment: false,
              },
            ]) as unknown as T[];
      },
    };
    const store = new PostgresWalletTransferStore({
      query: async () => [],
      execute: async () => undefined,
      transaction: async (run) => run(tx),
    });
    await expect(store.upsertTransfer(incoming)).resolves.toEqual({
      inserted: true,
      updated: false,
      shopPaymentBecameCompleted: false,
    });
    mode = 'update';
    reads = 0;
    await expect(store.upsertTransfer(incoming)).resolves.toEqual({
      inserted: false,
      updated: true,
      shopPaymentBecameCompleted: false,
    });
    mode = 'same';
    reads = 0;
    await expect(store.upsertTransfer(incoming)).resolves.toEqual({
      inserted: false,
      updated: false,
      shopPaymentBecameCompleted: false,
    });
    mode = 'other-wallet';
    reads = 0;
    await expect(store.upsertTransfer(incoming)).resolves.toEqual({
      inserted: true,
      updated: true,
      shopPaymentBecameCompleted: false,
    });
  });
});
