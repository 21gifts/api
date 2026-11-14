import { describe, expect, it, vi } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import { postgresTextArrayLiteral } from '@/lib/postgres-text-array';
import {
  InMemoryWalletTransferStore,
  PostgresWalletTransferStore,
  type TillReceiptCharge,
  type TillReceiptContext,
  type TillReceiptQuery,
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
    inputCount: 0,
    resolvedInputCount: 0,
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
    await expect(
      store.upsertTransfer(
        row({
          status: 'pending',
          transferUpdatedAt: new Date('2026-11-12T08:59:59.000Z'),
          seenAt: new Date('2026-11-12T10:00:00.000Z'),
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
      inputCount: 0,
      resolvedInputCount: 0,
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

  it('does not let strictly older transfer or token observations regress current state', async () => {
    const store = new InMemoryWalletTransferStore();
    await store.upsertTransfer(
      row({
        status: 'completed',
        transferUpdatedAt: new Date('2026-11-12T10:00:00.000Z'),
        seenAt: new Date('2026-11-12T10:01:00.000Z'),
      }),
    );
    await expect(
      store.upsertTransfer(
        row({
          status: 'pending',
          transferUpdatedAt: new Date('2026-11-12T09:00:00.000Z'),
          seenAt: new Date('2026-11-12T11:00:00.000Z'),
        }),
      ),
    ).resolves.toEqual({ inserted: false, updated: false, shopPaymentBecameCompleted: false });
    await store.upsertTokenTransaction(
      tokenRow({ status: 'finalized', seenAt: new Date('2026-11-12T10:00:00.000Z') }),
    );
    await store.upsertTokenTransaction(
      tokenRow({ status: 'started', seenAt: new Date('2026-11-12T09:00:00.000Z') }),
    );

    await expect(store.syncState('account', OWNER)).resolves.toMatchObject({
      oldestPendingCreatedAt: null,
      oldestPendingTokenCreatedAt: null,
    });
  });

  it('orders only observations with two transfer times and preserves a timed final state', async () => {
    const store = new InMemoryWalletTransferStore();
    await store.upsertTransfer(
      row({
        status: 'pending',
        transferUpdatedAt: null,
        seenAt: new Date('2026-11-12T10:00:00.000Z'),
      }),
    );
    await expect(
      store.upsertTransfer(
        row({
          status: 'completed',
          transferUpdatedAt: new Date('2026-11-12T09:30:00.000Z'),
          seenAt: new Date('2026-11-12T10:01:00.000Z'),
        }),
      ),
    ).resolves.toMatchObject({ updated: true });
    await expect(
      store.upsertTransfer(
        row({
          status: 'pending',
          transferUpdatedAt: null,
          seenAt: new Date('2026-11-12T11:00:00.000Z'),
        }),
      ),
    ).resolves.toEqual({ inserted: false, updated: false, shopPaymentBecameCompleted: false });

    await expect(store.syncState('account', OWNER)).resolves.toMatchObject({
      oldestPendingCreatedAt: null,
    });
  });

  it('keeps the better-resolved token projection and retries finalized unresolved inputs', async () => {
    const store = new InMemoryWalletTransferStore();
    await store.upsertTokenTransaction(
      tokenRow({
        direction: 'out',
        amount: '34',
        counterpartyPubkeys: [SHOP],
        inputCount: 2,
        resolvedInputCount: 2,
        status: 'finalized',
        seenAt: new Date('2026-11-12T10:00:00.000Z'),
      }),
    );
    await store.upsertTokenTransaction(
      tokenRow({
        direction: 'in',
        amount: '1',
        counterpartyPubkeys: [],
        inputCount: 2,
        resolvedInputCount: 1,
        status: 'finalized',
        seenAt: new Date('2026-11-12T11:00:00.000Z'),
      }),
    );
    await expect(store.syncState('account', OWNER)).resolves.toMatchObject({
      oldestPendingTokenCreatedAt: null,
    });

    await store.upsertTokenTransaction(
      tokenRow({
        transactionHash: '55'.repeat(32),
        inputCount: 2,
        resolvedInputCount: 1,
        status: 'finalized',
        transactionCreatedAt: null,
      }),
    );
    await expect(store.syncState('account', OWNER)).resolves.toMatchObject({
      pendingTokenWithoutCreatedAt: true,
    });
  });

  it('accepts an equal-age substantive transfer change', async () => {
    const store = new InMemoryWalletTransferStore();
    await store.upsertTransfer(
      row({
        status: 'completed',
        transferUpdatedAt: new Date('2026-11-12T10:00:00.000Z'),
        seenAt: new Date('2026-11-12T10:01:00.000Z'),
      }),
    );

    await expect(
      store.upsertTransfer(
        row({
          status: 'returned',
          transferUpdatedAt: new Date('2026-11-12T10:00:00.000Z'),
          seenAt: new Date('2026-11-12T10:00:00.000Z'),
        }),
      ),
    ).resolves.toEqual({ inserted: false, updated: true, shopPaymentBecameCompleted: false });
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
      { transferUpdatedAt: new Date('2026-11-12T08:01:00.000Z') },
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

describe('InMemoryWalletTransferStore.findObservedCounterparties', () => {
  it('names only the resolved other account of the caller’s completed observed transfers', async () => {
    const PREVIOUS = `03${'e'.repeat(64)}`;
    const SECOND_WALLET = `02${'f'.repeat(64)}`;
    const store = new InMemoryWalletTransferStore({
      verifiedAccountForPubkey: async (pubkey) =>
        pubkey === MEMBER
          ? 'member-account'
          : pubkey === SHOP
            ? 'shop-account'
            : pubkey === OWNER
              ? 'me'
              : null,
      previousAccountForPubkey: async (pubkey) => (pubkey === PREVIOUS ? 'previous-account' : null),
    });
    const completed = (partial: Partial<WalletTransferRecord>): WalletTransferRecord =>
      row({ accountId: 'me', status: 'completed', counterpartyPubkey: MEMBER, ...partial });
    for (const record of [
      completed({ transferId: 'out' }),
      completed({ transferId: 'in', direction: 'in', counterpartyPubkey: PREVIOUS }),
      completed({ transferId: 'pending', status: 'pending' }),
      completed({ transferId: 'lightning', type: 'preimage_swap' }),
      completed({ transferId: 'self', counterpartyPubkey: OWNER }),
      completed({ transferId: 'unresolved', counterpartyPubkey: UNKNOWN }),
      completed({ transferId: 'multi', counterpartyPubkeys: [MEMBER, SHOP] }),
      completed({ transferId: 'two-wallets' }),
      completed({
        transferId: 'two-wallets',
        walletPubkey: SECOND_WALLET,
        counterpartyPubkey: SHOP,
      }),
      completed({ transferId: 'foreign', accountId: 'other' }),
    ]) {
      await store.upsertTransfer(record);
    }
    const found = await store.findObservedCounterparties('me', [
      { id: 'out', direction: 'out' },
      { id: 'in', direction: 'in' },
      { id: 'pending', direction: 'out' },
      { id: 'lightning', direction: 'out' },
      { id: 'self', direction: 'out' },
      { id: 'unresolved', direction: 'out' },
      { id: 'multi', direction: 'out' },
      { id: 'two-wallets', direction: 'out' },
      { id: 'foreign', direction: 'out' },
      { id: 'out-as-in', direction: 'in' },
      { id: 'missing', direction: 'out' },
    ]);
    expect([...found]).toEqual([
      ['out', ['member-account']],
      ['in', ['previous-account']],
      ['two-wallets', ['member-account', 'shop-account']],
    ]);
    expect([
      ...(await store.findObservedCounterparties('me', [{ id: 'out', direction: 'in' }])),
    ]).toEqual([]);
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
      inputCount: 2,
      resolvedInputCount: 2,
      sparkInvoices: ['spark1one', 'spark1two'],
      type: 'transfer',
      status: 'revealed',
      transactionCreatedAt: null,
      transactionExpiryAt: new Date('2026-11-12T08:05:00.000Z'),
      seenAt: new Date('2026-11-12T08:00:00.000Z'),
    });
    await store.markFullSync('account', OWNER, new Date('2026-11-12T09:00:00.000Z'));
    expect(execute.mock.calls[0]?.[0]).toContain('INSERT INTO wallet_token_transaction');
    expect(execute.mock.calls[0]?.[0]).toContain(
      'EXCLUDED.last_seen_at >= wallet_token_transaction.last_seen_at',
    );
    expect(execute.mock.calls[0]?.[0]).not.toContain('payload');
    expect(execute.mock.calls[0]?.[1]).toContain('256');
    expect(execute.mock.calls[0]?.[1]?.[9]).toBe(
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
          {
            wallet_pubkey: OWNER,
            direction: 'out',
            type: 'transfer',
            status: 'completed',
            amount_sats: 21,
            counterparty_pubkey: SHOP,
            counterparty_pubkeys: [SHOP],
            counterparty_account_id: 'shop-account',
            spark_invoice: null,
            transfer_created_at: new Date('2026-11-12T08:00:00.000Z'),
            transfer_updated_at: new Date('2026-11-12T09:00:00.000Z'),
            is_shop_payment: true,
          },
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
    expect(vi.mocked(tx.execute).mock.calls[0]?.[0]).toContain(
      'GREATEST(EXCLUDED.last_seen_at, wallet_transfer.last_seen_at)',
    );
    expect(vi.mocked(tx.execute).mock.calls[0]?.[0]).toContain(
      'OR wallet_transfer.transfer_updated_at IS NULL',
    );
    expect(vi.mocked(tx.execute).mock.calls[0]?.[0]).not.toContain(
      'COALESCE(EXCLUDED.transfer_updated_at, EXCLUDED.last_seen_at)',
    );
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
                ...before,
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

describe('PostgresWalletTransferStore.findObservedCounterparties', () => {
  it('resolves verified or previous owners in one bound query and groups them by id', async () => {
    const query = vi.fn(async (): Promise<unknown[]> => [
      { id: 'a', account_id: 'x' },
      { id: 'a', account_id: 'y' },
      { id: 'b', account_id: 'z' },
    ]);
    const sql = { query, execute: vi.fn(async () => undefined) } as unknown as SqlClient;
    const found = await new PostgresWalletTransferStore(sql).findObservedCounterparties('me', [
      { id: 'a', direction: 'out' },
      { id: 'b', direction: 'in' },
      { id: 'bad\u0000id', direction: 'in' },
    ]);
    expect([...found]).toEqual([
      ['a', ['x', 'y']],
      ['b', ['z']],
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    const [text, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(params).toEqual([
      'me',
      postgresTextArrayLiteral(['a', 'b']),
      postgresTextArrayLiteral(['out', 'in']),
    ]);
    expect(text).toContain("transfer.type = 'transfer'");
    expect(text).toContain("transfer.status = 'completed'");
    expect(text).toContain('transfer.counterparty_pubkeys <@ ARRAY[transfer.counterparty_pubkey]');
    expect(text).toContain('spark_pubkey_verified_at IS NOT NULL');
    expect(text).toContain('ORDER BY replaced_at DESC, account_id');
    expect(text).toContain('resolved.account_id <> transfer.account_id');
  });
});

describe('InMemoryWalletTransferStore.listTillReceipts', () => {
  const NOW = Date.parse('2026-11-12T12:00:00.000Z');
  const DAY = 24 * 60 * 60 * 1000;
  const ALLOW = 300_000;
  const PREVIOUS = `03${'e'.repeat(64)}`;
  const PAYER = `02${'f'.repeat(64)}`;
  const HASH_A = 'aa'.repeat(32);
  const HASH_B = 'bb'.repeat(32);
  const HASH_C = 'cc'.repeat(32);
  const query = (partial: Partial<TillReceiptQuery> = {}): TillReceiptQuery => ({
    accountId: 'account',
    sinceMs: NOW - DAY,
    nowMs: NOW,
    clockAllowanceMs: ALLOW,
    limit: 20,
    ...partial,
  });
  const at = (minutesBeforeNow: number): Date => new Date(NOW - minutesBeforeNow * 60_000);
  const receipt = (
    transferId: string,
    minutesBeforeNow: number,
    partial: Partial<WalletTransferRecord> = {},
  ): WalletTransferRecord =>
    row({
      transferId,
      direction: 'in',
      type: 'preimage_swap',
      status: 'completed',
      counterpartyPubkey: PAYER,
      counterpartyPubkeys: [PAYER],
      transferCreatedAt: at(minutesBeforeNow),
      ...partial,
    });

  async function storeWith(
    rows: WalletTransferRecord[],
    context: Partial<TillReceiptContext> = {},
  ): Promise<InMemoryWalletTransferStore> {
    const contexts: string[] = [];
    const store = new InMemoryWalletTransferStore({
      tillContext: async (accountId) => {
        contexts.push(accountId);
        return { ownWalletKeys: [], charges: [], reports: [], ...context };
      },
    });
    for (const entry of rows) await store.upsertTransfer(entry);
    return store;
  }

  it('lists completed incoming Lightning and Spark receipts of the account, newest first', async () => {
    const store = await storeWith(
      [
        receipt('ln', 10, { amountSats: 2100 }),
        receipt('spark', 20, { type: 'transfer', amountSats: 21 }),
        receipt('old', 24 * 60 + 1),
        receipt('undated', 5, { transferCreatedAt: null }),
        receipt('other-account', 5, { accountId: 'other' }),
        receipt('sent', 5, { direction: 'out' }),
        receipt('pending', 5, { status: 'pending' }),
        receipt('exit', 5, { type: 'cooperative_exit' }),
        receipt('deposit', 5, { type: 'utxo_swap' }),
        receipt('leaf-swap', 5, { type: 'swap' }),
        receipt('from-previous', 5, { type: 'transfer', counterpartyPubkeys: [PREVIOUS] }),
        receipt('self', 5, { type: 'transfer', counterpartyPubkeys: [OWNER] }),
      ],
      { ownWalletKeys: [PREVIOUS] },
    );
    await expect(store.listTillReceipts(query())).resolves.toEqual([
      { id: 'ln', amountSats: 2100, receivedAt: at(10), kind: 'lightning' },
      { id: 'spark', amountSats: 21, receivedAt: at(20), kind: 'spark' },
    ]);
    await expect(store.listTillReceipts(query({ limit: 1 }))).resolves.toHaveLength(1);
  });

  it('defaults to an empty context and merges one transfer seen in two wallets', async () => {
    const store = new InMemoryWalletTransferStore();
    await store.upsertTransfer(receipt('both', 10, { amountSats: 10 }));
    await store.upsertTransfer(receipt('both', 12, { walletPubkey: PREVIOUS, amountSats: 11 }));
    await store.upsertTransfer(receipt('a-tie', 30));
    await store.upsertTransfer(receipt('b-tie', 30));
    await store.upsertTransfer(receipt('c-tie', 30));
    await expect(store.listTillReceipts(query())).resolves.toEqual([
      { id: 'both', amountSats: 21, receivedAt: at(12), kind: 'lightning' },
      { id: 'c-tie', amountSats: 21, receivedAt: at(30), kind: 'lightning' },
      { id: 'b-tie', amountSats: 21, receivedAt: at(30), kind: 'lightning' },
      { id: 'a-tie', amountSats: 21, receivedAt: at(30), kind: 'lightning' },
    ]);
  });

  it('shows a payment that settled an open or paid charge only as that charge', async () => {
    const store = await storeWith(
      [
        receipt('spark-paid', 10, { type: 'transfer', sparkInvoice: ' SPARK1PAID ' }),
        receipt('spark-cancelled', 11, { type: 'transfer', sparkInvoice: 'spark1cancelled' }),
        receipt('spark-old-paid', 12, { type: 'transfer', sparkInvoice: 'spark1old' }),
        receipt('ln-pending', 13),
        receipt('ln-expired', 14),
        receipt('ln-out-report', 15),
      ],
      {
        charges: [
          { status: 'paid', sparkInvoice: 'spark1paid', paidAt: at(9), invoices: [] },
          { status: 'cancelled', sparkInvoice: 'spark1cancelled', paidAt: null, invoices: [] },
          { status: 'paid', sparkInvoice: 'spark1old', paidAt: at(24 * 60 + 6), invoices: [] },
          { status: 'paid', sparkInvoice: null, paidAt: null, invoices: [] },
          {
            status: 'pending',
            sparkInvoice: null,
            paidAt: null,
            invoices: [{ paymentHash: HASH_A, createdAt: at(16) }],
          },
          {
            status: 'expired',
            sparkInvoice: null,
            paidAt: null,
            invoices: [{ paymentHash: HASH_B, createdAt: at(16) }],
          },
        ],
        reports: [
          { paymentId: 'ln-pending', direction: 'in', paymentHash: HASH_A.toUpperCase() },
          { paymentId: 'ln-expired', direction: 'in', paymentHash: HASH_B },
          { paymentId: 'ln-out-report', direction: 'out', paymentHash: HASH_A },
          { paymentId: 'ln-out-report', direction: 'in', paymentHash: HASH_C },
          { paymentId: 'no-hash', direction: 'in', paymentHash: null },
        ],
      },
    );
    await expect(store.listTillReceipts(query())).resolves.toEqual([
      { id: 'spark-cancelled', amountSats: 21, receivedAt: at(11), kind: 'spark' },
      { id: 'spark-old-paid', amountSats: 21, receivedAt: at(12), kind: 'spark' },
      { id: 'ln-expired', amountSats: 21, receivedAt: at(14), kind: 'lightning' },
      { id: 'ln-out-report', amountSats: 21, receivedAt: at(15), kind: 'lightning' },
    ]);
  });

  it('withholds an unreported Lightning receipt inside the lifetime of a charge whose payment is not known', async () => {
    const charge = (partial: Partial<TillReceiptCharge>): TillReceiptCharge => ({
      status: 'paid',
      sparkInvoice: null,
      paidAt: at(30),
      invoices: [
        { paymentHash: HASH_A, createdAt: at(40) },
        { paymentHash: HASH_B, createdAt: at(35) },
      ],
      ...partial,
    });
    const rows = [
      receipt('before', 46),
      receipt('first-edge', 45),
      receipt('inside', 33),
      receipt('last-edge', 25),
      receipt('after', 24),
      receipt('spark-inside', 33, { type: 'transfer' }),
      receipt('reported-inside', 34),
    ];
    const reports = [
      { paymentId: 'reported-inside', direction: 'in' as const, paymentHash: HASH_C },
    ];
    const unknown = await storeWith(rows, { charges: [charge({})], reports });
    expect((await unknown.listTillReceipts(query())).map((entry) => entry.id)).toEqual([
      'after',
      'spark-inside',
      'reported-inside',
      'before',
    ]);

    const open = await storeWith([receipt('open', 1)], {
      charges: [charge({ status: 'pending', paidAt: null })],
    });
    await expect(open.listTillReceipts(query())).resolves.toEqual([]);

    const noInvoices = await storeWith([receipt('inside', 33)], {
      charges: [charge({ invoices: [] })],
    });
    await expect(noInvoices.listTillReceipts(query())).resolves.toHaveLength(1);

    const linkedByReport = await storeWith([...rows, receipt('settling', 32)], {
      charges: [charge({})],
      reports: [...reports, { paymentId: 'settling', direction: 'in', paymentHash: HASH_B }],
    });
    expect((await linkedByReport.listTillReceipts(query())).map((entry) => entry.id)).toEqual([
      'after',
      'last-edge',
      'spark-inside',
      'inside',
      'reported-inside',
      'first-edge',
      'before',
    ]);

    const linkedBySpark = await storeWith(
      [
        receipt('inside', 33),
        receipt('spark-settling', 31, {
          type: 'transfer',
          sparkInvoice: 'SPARK1CHARGE',
        }),
        receipt('other-account-settling', 31, {
          accountId: 'other',
          type: 'transfer',
          sparkInvoice: 'spark1other',
        }),
      ],
      {
        charges: [charge({ sparkInvoice: 'spark1charge' })],
      },
    );
    expect((await linkedBySpark.listTillReceipts(query())).map((entry) => entry.id)).toEqual([
      'inside',
    ]);

    const otherAccountOnly = await storeWith(
      [
        receipt('inside', 33),
        receipt('foreign', 31, {
          accountId: 'other',
          type: 'transfer',
          sparkInvoice: 'spark1charge',
        }),
        receipt('sent', 31, { direction: 'out', type: 'transfer', sparkInvoice: 'spark1charge' }),
        receipt('pending', 31, {
          status: 'pending',
          type: 'transfer',
          sparkInvoice: 'spark1charge',
        }),
      ],
      { charges: [charge({ sparkInvoice: 'spark1charge' })] },
    );
    await expect(otherAccountOnly.listTillReceipts(query())).resolves.toEqual([]);
  });
});

describe('PostgresWalletTransferStore.listTillReceipts', () => {
  it('runs one bound query and maps rows', async () => {
    const query = vi.fn(async (): Promise<unknown[]> => [
      {
        id: 'b',
        type: 'preimage_swap',
        amount_sats: '2100',
        received_at: '2026-11-12T10:00:00.000Z',
      },
      {
        id: 'a',
        type: 'transfer',
        amount_sats: 21,
        received_at: new Date('2026-11-12T09:00:00.000Z'),
      },
    ]);
    const sql = { query, execute: vi.fn(async () => undefined) } as unknown as SqlClient;
    const found = await new PostgresWalletTransferStore(sql).listTillReceipts({
      accountId: 'me',
      sinceMs: Date.parse('2026-11-11T12:00:00.000Z'),
      nowMs: Date.parse('2026-11-12T12:00:00.000Z'),
      clockAllowanceMs: 300_000,
      limit: 20,
    });
    expect(found).toEqual([
      {
        id: 'b',
        amountSats: 2100,
        receivedAt: new Date('2026-11-12T10:00:00.000Z'),
        kind: 'lightning',
      },
      { id: 'a', amountSats: 21, receivedAt: new Date('2026-11-12T09:00:00.000Z'), kind: 'spark' },
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    const [text, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(params).toEqual([
      'me',
      new Date('2026-11-11T12:00:00.000Z'),
      new Date('2026-11-12T12:00:00.000Z'),
      300_000,
      20,
    ]);
    expect(text).toContain("t.direction = 'in'");
    expect(text).toContain("t.status = 'completed'");
    expect(text).toContain("t.type IN ('preimage_swap', 'transfer')");
    expect(text).toContain('LIMIT $5');
  });
});
