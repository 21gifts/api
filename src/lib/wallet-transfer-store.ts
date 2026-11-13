/** Persistence for server-verified Spark wallet transfers. */

import type { SqlClient } from '@/lib/auth/sql';
import { postgresTextArrayLiteral } from '@/lib/postgres-text-array';

/** Direction as seen from the wallet that granted the viewer key. */
export type WalletTransferDirection = 'in' | 'out';

/** Stable transfer kinds stored independently of SDK enum numbers. */
export type WalletTransferType =
  | 'preimage_swap'
  | 'cooperative_exit'
  | 'transfer'
  | 'utxo_swap'
  | 'primary_swap_v3'
  | 'counter_swap_v3'
  | 'swap'
  | 'counter_swap'
  | 'unrecognized';

/** Stable transfer status stored independently of SDK enum numbers. */
export type WalletTransferStatus = 'pending' | 'completed' | 'cancelled' | 'expired' | 'returned';

/** Stable token-transaction status stored independently of SDK enum numbers. */
export type WalletTokenTransactionStatus =
  'started' | 'signed' | 'revealed' | 'finalized' | 'cancelled' | 'unknown';

/** One current or previous wallet to read through the deployment viewer. */
export interface WalletTransferWallet {
  accountId: string;
  sparkPubkey: string;
  sparkAddress: string;
}

/** One normalized operator transfer observation. */
export interface WalletTransferRecord {
  accountId: string;
  walletPubkey: string;
  transferId: string;
  direction: WalletTransferDirection;
  type: WalletTransferType;
  status: WalletTransferStatus;
  amountSats: number;
  counterpartyPubkey: string;
  counterpartyPubkeys: string[];
  sparkInvoice: string | null;
  transferCreatedAt: Date | null;
  transferUpdatedAt: Date | null;
  seenAt: Date;
}

/** Allow-listed non-secret facts from one viewer-sourced Spark token transaction. */
export interface WalletTokenTransactionRecord {
  accountId: string;
  walletPubkey: string;
  transactionHash: string;
  tokenIdentifier: string | null;
  direction: WalletTransferDirection;
  amount: string;
  counterpartyPubkeys: string[];
  sparkInvoices: string[];
  type: 'create' | 'mint' | 'transfer' | 'unknown';
  status: WalletTokenTransactionStatus;
  transactionCreatedAt: Date | null;
  transactionExpiryAt: Date | null;
  seenAt: Date;
}

/** Cursor facts used for overlap and pending re-reads. */
export interface WalletTransferSyncState {
  newestCreatedAt: Date | null;
  oldestPendingCreatedAt: Date | null;
  pendingWithoutCreatedAt: boolean;
  newestTokenCreatedAt?: Date | null;
  oldestPendingTokenCreatedAt?: Date | null;
  pendingTokenWithoutCreatedAt?: boolean;
  lastFullSyncAt: Date | null;
}

/** Result of one durable transfer upsert. */
export interface WalletTransferUpsertResult {
  inserted: boolean;
  updated: boolean;
  shopPaymentBecameCompleted: boolean;
}

/** Persistence port used by the viewer worker and payout gate. */
export interface WalletTransferStore {
  listWallets(): Promise<WalletTransferWallet[]>;
  syncState(accountId: string, walletPubkey: string): Promise<WalletTransferSyncState>;
  upsertTransfer(row: WalletTransferRecord): Promise<WalletTransferUpsertResult>;
  upsertTokenTransaction(row: WalletTokenTransactionRecord): Promise<void>;
  markFullSync(accountId: string, walletPubkey: string, syncedAt: Date): Promise<void>;
  hasShopPayment(accountId: string, fromUtcDay: string, toUtcDay: string): Promise<boolean>;
}

function dateCopy(value: Date | null): Date | null {
  return value === null ? null : new Date(value.getTime());
}

function copyRecord(row: WalletTransferRecord): WalletTransferRecord {
  return {
    ...row,
    counterpartyPubkeys: [...row.counterpartyPubkeys],
    transferCreatedAt: dateCopy(row.transferCreatedAt),
    transferUpdatedAt: dateCopy(row.transferUpdatedAt),
    seenAt: new Date(row.seenAt.getTime()),
  };
}

function substantiveEqual(left: WalletTransferRecord, right: WalletTransferRecord): boolean {
  return (
    left.walletPubkey === right.walletPubkey &&
    left.direction === right.direction &&
    left.type === right.type &&
    left.status === right.status &&
    left.amountSats === right.amountSats &&
    left.counterpartyPubkey === right.counterpartyPubkey &&
    left.counterpartyPubkeys.length === right.counterpartyPubkeys.length &&
    left.counterpartyPubkeys.every((key, index) => key === right.counterpartyPubkeys[index]) &&
    left.sparkInvoice === right.sparkInvoice &&
    left.transferCreatedAt?.getTime() === right.transferCreatedAt?.getTime() &&
    left.transferUpdatedAt?.getTime() === right.transferUpdatedAt?.getTime()
  );
}

function dayOf(row: WalletTransferRecord): string | null {
  const at = row.transferUpdatedAt ?? row.transferCreatedAt;
  return at === null ? null : at.toISOString().slice(0, 10);
}

/** Process-local adapter used by database-free boots and tests. */
export class InMemoryWalletTransferStore implements WalletTransferStore {
  readonly #rows = new Map<string, WalletTransferRecord>();
  readonly #tokens = new Map<string, WalletTokenTransactionRecord>();
  readonly #fullSyncAt = new Map<string, Date>();
  readonly #wallets: WalletTransferWallet[];
  readonly #verifiedAccountForPubkey: (pubkey: string) => Promise<string | null>;
  readonly #previousAccountForPubkey: (pubkey: string) => Promise<string | null>;
  readonly #isShop: (accountId: string) => Promise<boolean>;

  /**
   * Create an in-memory transfer store.
   *
   * @param options - Optional wallets, verified-current and previous-key resolvers,
   *   and shop predicate.
   */
  constructor(
    options: {
      wallets?: readonly WalletTransferWallet[];
      verifiedAccountForPubkey?: (pubkey: string) => Promise<string | null>;
      previousAccountForPubkey?: (pubkey: string) => Promise<string | null>;
      isShop?: (accountId: string) => Promise<boolean>;
    } = {},
  ) {
    this.#wallets = (options.wallets ?? []).map((wallet) => ({ ...wallet }));
    this.#verifiedAccountForPubkey =
      options.verifiedAccountForPubkey ?? (() => Promise.resolve(null));
    this.#previousAccountForPubkey =
      options.previousAccountForPubkey ?? (() => Promise.resolve(null));
    this.#isShop = options.isShop ?? (() => Promise.resolve(false));
  }

  listWallets(): Promise<WalletTransferWallet[]> {
    return Promise.resolve(this.#wallets.map((wallet) => ({ ...wallet })));
  }

  syncState(accountId: string, walletPubkey: string): Promise<WalletTransferSyncState> {
    const rows = [...this.#rows.values()].filter(
      (row) => row.accountId === accountId && row.walletPubkey === walletPubkey,
    );
    const created = rows
      .map((row) => row.transferCreatedAt)
      .filter((value): value is Date => value !== null)
      .map((value) => value.getTime());
    const pending = rows
      .filter((row) => row.status === 'pending')
      .map((row) => row.transferCreatedAt)
      .filter((value): value is Date => value !== null)
      .map((value) => value.getTime());
    const tokens = [...this.#tokens.values()].filter(
      (row) => row.accountId === accountId && row.walletPubkey === walletPubkey,
    );
    const tokenCreated = tokens
      .map((row) => row.transactionCreatedAt)
      .filter((value): value is Date => value !== null)
      .map((value) => value.getTime());
    const pendingTokenCreated = tokens
      .filter((row) => row.status !== 'finalized' && row.status !== 'cancelled')
      .map((row) => row.transactionCreatedAt)
      .filter((value): value is Date => value !== null)
      .map((value) => value.getTime());
    return Promise.resolve({
      newestCreatedAt: created.length === 0 ? null : new Date(Math.max(...created)),
      oldestPendingCreatedAt: pending.length === 0 ? null : new Date(Math.min(...pending)),
      pendingWithoutCreatedAt: rows.some(
        (row) => row.status === 'pending' && row.transferCreatedAt === null,
      ),
      newestTokenCreatedAt: tokenCreated.length === 0 ? null : new Date(Math.max(...tokenCreated)),
      oldestPendingTokenCreatedAt:
        pendingTokenCreated.length === 0 ? null : new Date(Math.min(...pendingTokenCreated)),
      pendingTokenWithoutCreatedAt: tokens.some(
        (row) =>
          row.status !== 'finalized' &&
          row.status !== 'cancelled' &&
          row.transactionCreatedAt === null,
      ),
      lastFullSyncAt: dateCopy(this.#fullSyncAt.get(`${accountId}\u0000${walletPubkey}`) ?? null),
    });
  }

  async upsertTransfer(row: WalletTransferRecord): Promise<WalletTransferUpsertResult> {
    const key = `${row.accountId}\u0000${row.walletPubkey}\u0000${row.transferId}`;
    const existing = this.#rows.get(key);
    // A wallet change inserts a distinct composite-key row, but it also changes
    // a stored field of the account's observed transfer.
    const comparable =
      existing ??
      [...this.#rows.values()].find(
        (candidate) =>
          candidate.accountId === row.accountId && candidate.transferId === row.transferId,
      );
    const counterparties = await Promise.all(
      row.counterpartyPubkeys.map((key) => this.#accountForPubkey(key)),
    );
    const existingCounterparties =
      existing === undefined
        ? []
        : await Promise.all(existing.counterpartyPubkeys.map((key) => this.#accountForPubkey(key)));
    const wasShop =
      existing !== undefined &&
      existing.status === 'completed' &&
      existing.direction === 'out' &&
      existing.type === 'transfer' &&
      (await hasExternalShop(existingCounterparties, existing.accountId, this.#isShop));
    const next = copyRecord(row);
    this.#rows.set(key, next);
    const isShop =
      next.status === 'completed' &&
      next.direction === 'out' &&
      next.type === 'transfer' &&
      (await hasExternalShop(counterparties, next.accountId, this.#isShop));
    return {
      inserted: existing === undefined,
      updated: comparable !== undefined && !substantiveEqual(comparable, next),
      shopPaymentBecameCompleted: isShop && !wasShop,
    };
  }

  upsertTokenTransaction(row: WalletTokenTransactionRecord): Promise<void> {
    const key = `${row.accountId}\u0000${row.walletPubkey}\u0000${row.transactionHash}`;
    this.#tokens.set(key, {
      ...row,
      transactionCreatedAt: dateCopy(row.transactionCreatedAt),
      transactionExpiryAt: dateCopy(row.transactionExpiryAt),
      counterpartyPubkeys: [...row.counterpartyPubkeys],
      sparkInvoices: [...row.sparkInvoices],
      seenAt: new Date(row.seenAt.getTime()),
    });
    return Promise.resolve();
  }

  markFullSync(accountId: string, walletPubkey: string, syncedAt: Date): Promise<void> {
    this.#fullSyncAt.set(`${accountId}\u0000${walletPubkey}`, new Date(syncedAt.getTime()));
    return Promise.resolve();
  }

  async hasShopPayment(accountId: string, fromUtcDay: string, toUtcDay: string): Promise<boolean> {
    for (const row of this.#rows.values()) {
      if (
        row.accountId !== accountId ||
        row.direction !== 'out' ||
        row.status !== 'completed' ||
        row.type !== 'transfer'
      ) {
        continue;
      }
      const day = dayOf(row);
      const counterparties = await Promise.all(
        row.counterpartyPubkeys.map((key) => this.#accountForPubkey(key)),
      );
      if (
        day !== null &&
        day >= fromUtcDay &&
        day <= toUtcDay &&
        (await hasExternalShop(counterparties, accountId, this.#isShop))
      ) {
        return true;
      }
    }
    return false;
  }

  async #accountForPubkey(pubkey: string): Promise<string | null> {
    return (
      (await this.#verifiedAccountForPubkey(pubkey)) ??
      (await this.#previousAccountForPubkey(pubkey))
    );
  }
}

async function hasExternalShop(
  accountIds: readonly (string | null)[],
  payerAccountId: string,
  isShop: (accountId: string) => Promise<boolean>,
): Promise<boolean> {
  for (const accountId of accountIds) {
    if (accountId !== null && accountId !== payerAccountId && (await isShop(accountId))) {
      return true;
    }
  }
  return false;
}

interface TransferSqlRow {
  wallet_pubkey: string;
  direction: WalletTransferDirection;
  type: WalletTransferType;
  status: WalletTransferStatus;
  amount_sats: number | string | bigint;
  counterparty_pubkey: string;
  counterparty_pubkeys: string[];
  counterparty_account_id: string | null;
  spark_invoice: string | null;
  transfer_created_at: Date | string | null;
  transfer_updated_at: Date | string | null;
  is_shop_payment: boolean;
}

const SHOP_EXISTS_SQL = `EXISTS (
  SELECT 1
  FROM unnest(wallet_transfer.counterparty_pubkeys) AS counterparty(pubkey)
  JOIN LATERAL (
    SELECT COALESCE(
      (SELECT id FROM account
       WHERE spark_pubkey = counterparty.pubkey AND spark_pubkey_verified_at IS NOT NULL
       ORDER BY id LIMIT 1),
      (SELECT account_id FROM previous_wallet WHERE spark_pubkey = counterparty.pubkey
       ORDER BY replaced_at DESC, account_id LIMIT 1)
    ) AS account_id
  ) AS resolved ON resolved.account_id IS NOT NULL
  JOIN message AS shop ON shop.shop_account_id = resolved.account_id
  WHERE resolved.account_id <> wallet_transfer.account_id
    AND shop.parent_id IS NULL
    AND shop.deleted_at IS NULL
    AND shop.text ~* '#21GiftsShop([^A-Za-z0-9_]|$)'
)`;

function sqlDate(value: Date | string | null): Date | null {
  return value === null
    ? null
    : value instanceof Date
      ? new Date(value.getTime())
      : new Date(value);
}

function recordFromSql(
  accountId: string,
  transferId: string,
  row: TransferSqlRow,
): WalletTransferRecord {
  return {
    accountId,
    walletPubkey: row.wallet_pubkey,
    transferId,
    direction: row.direction,
    type: row.type,
    status: row.status,
    amountSats: Number(row.amount_sats),
    counterpartyPubkey: row.counterparty_pubkey,
    counterpartyPubkeys: [...row.counterparty_pubkeys],
    sparkInvoice: row.spark_invoice,
    transferCreatedAt: sqlDate(row.transfer_created_at),
    transferUpdatedAt: sqlDate(row.transfer_updated_at),
    seenAt: new Date(0),
  };
}

/** Durable Postgres adapter for viewer-sourced wallet transfers. */
export class PostgresWalletTransferStore implements WalletTransferStore {
  /**
   * Create a durable transfer store.
   *
   * @param sql - Migrated SQL client with transaction support for writes.
   */
  constructor(private readonly sql: SqlClient) {}

  async listWallets(): Promise<WalletTransferWallet[]> {
    return this.sql.query<WalletTransferWallet>(
      `SELECT id::text AS "accountId", spark_pubkey AS "sparkPubkey", spark_address AS "sparkAddress"
       FROM account
       WHERE spark_address IS NOT NULL AND spark_pubkey_verified_at IS NOT NULL
       UNION ALL
       SELECT account_id::text AS "accountId", spark_pubkey AS "sparkPubkey", spark_address AS "sparkAddress"
       FROM previous_wallet
       ORDER BY "accountId", "sparkPubkey"`,
    );
  }

  async syncState(accountId: string, walletPubkey: string): Promise<WalletTransferSyncState> {
    const rows = await this.sql.query<{
      newest_created_at: Date | string | null;
      oldest_pending_created_at: Date | string | null;
      pending_without_created_at: boolean;
      newest_token_created_at: Date | string | null;
      oldest_pending_token_created_at: Date | string | null;
      pending_token_without_created_at: boolean;
      last_full_sync_at: Date | string | null;
    }>(
      `SELECT max(transfer_created_at) AS newest_created_at,
              min(transfer_created_at) FILTER (WHERE status = 'pending') AS oldest_pending_created_at
              , bool_or(status = 'pending' AND transfer_created_at IS NULL) AS pending_without_created_at,
              (SELECT max(transaction_created_at) FROM wallet_token_transaction
               WHERE account_id = $1 AND wallet_pubkey = $2) AS newest_token_created_at,
              (SELECT min(transaction_created_at) FROM wallet_token_transaction
               WHERE account_id = $1 AND wallet_pubkey = $2
                 AND status NOT IN ('finalized', 'cancelled')) AS oldest_pending_token_created_at,
              (SELECT coalesce(bool_or(transaction_created_at IS NULL), false)
               FROM wallet_token_transaction
               WHERE account_id = $1 AND wallet_pubkey = $2
                 AND status NOT IN ('finalized', 'cancelled')) AS pending_token_without_created_at,
              (SELECT last_full_sync_at FROM wallet_transfer_sync
               WHERE account_id = $1 AND wallet_pubkey = $2) AS last_full_sync_at
       FROM wallet_transfer WHERE account_id = $1 AND wallet_pubkey = $2`,
      [accountId, walletPubkey],
    );
    const row = rows[0];
    return {
      newestCreatedAt: sqlDate(row?.newest_created_at ?? null),
      oldestPendingCreatedAt: sqlDate(row?.oldest_pending_created_at ?? null),
      pendingWithoutCreatedAt: row?.pending_without_created_at === true,
      newestTokenCreatedAt: sqlDate(row?.newest_token_created_at ?? null),
      oldestPendingTokenCreatedAt: sqlDate(row?.oldest_pending_token_created_at ?? null),
      pendingTokenWithoutCreatedAt: row?.pending_token_without_created_at === true,
      lastFullSyncAt: sqlDate(row?.last_full_sync_at ?? null),
    };
  }

  async upsertTransfer(row: WalletTransferRecord): Promise<WalletTransferUpsertResult> {
    const transaction = this.sql.transaction;
    if (transaction === undefined) {
      throw new Error('Wallet transfer writes require a transaction');
    }
    return transaction(async (tx) => {
      const beforeRows = await tx.query<TransferSqlRow>(
        `SELECT wallet_pubkey, direction, type, status, amount_sats, counterparty_pubkey,
                counterparty_pubkeys,
                counterparty_account_id, spark_invoice, transfer_created_at, transfer_updated_at,
                (direction = 'out' AND status = 'completed' AND type = 'transfer'
                 AND ${SHOP_EXISTS_SQL}) AS is_shop_payment
         FROM wallet_transfer
         WHERE account_id = $1 AND transfer_id = $3
         ORDER BY (wallet_pubkey = $2) DESC, wallet_pubkey
         FOR UPDATE`,
        [row.accountId, row.walletPubkey, row.transferId],
      );
      await tx.execute(
        `INSERT INTO wallet_transfer
          (account_id, wallet_pubkey, transfer_id, direction, type, status, amount_sats,
           counterparty_pubkey, counterparty_pubkeys, counterparty_account_id, spark_invoice, transfer_created_at,
           transfer_updated_at, first_seen_at, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],
           COALESCE(
             (SELECT id FROM account
              WHERE spark_pubkey = $8 AND spark_pubkey_verified_at IS NOT NULL
              ORDER BY id LIMIT 1),
             (SELECT account_id FROM previous_wallet WHERE spark_pubkey = $8 ORDER BY replaced_at DESC, account_id LIMIT 1)
           ),$10,$11,$12,$13,$13)
         ON CONFLICT (account_id, wallet_pubkey, transfer_id) DO UPDATE SET
           direction = EXCLUDED.direction,
           type = EXCLUDED.type,
           status = EXCLUDED.status,
           amount_sats = EXCLUDED.amount_sats,
           counterparty_pubkey = EXCLUDED.counterparty_pubkey,
           counterparty_pubkeys = EXCLUDED.counterparty_pubkeys,
           counterparty_account_id = EXCLUDED.counterparty_account_id,
           spark_invoice = EXCLUDED.spark_invoice,
           transfer_created_at = EXCLUDED.transfer_created_at,
           transfer_updated_at = EXCLUDED.transfer_updated_at,
           last_seen_at = EXCLUDED.last_seen_at`,
        [
          row.accountId,
          row.walletPubkey,
          row.transferId,
          row.direction,
          row.type,
          row.status,
          row.amountSats,
          row.counterpartyPubkey,
          postgresTextArrayLiteral(row.counterpartyPubkeys),
          row.sparkInvoice,
          row.transferCreatedAt,
          row.transferUpdatedAt,
          row.seenAt,
        ],
      );
      const after = (
        await tx.query<{ is_shop_payment: boolean; counterparty_account_id: string | null }>(
          `SELECT counterparty_account_id,
                  (direction = 'out' AND status = 'completed' AND type = 'transfer'
                   AND ${SHOP_EXISTS_SQL}) AS is_shop_payment
           FROM wallet_transfer WHERE account_id = $1 AND wallet_pubkey = $2 AND transfer_id = $3`,
          [row.accountId, row.walletPubkey, row.transferId],
        )
      )[0];
      // Prefer the exact composite-key row; otherwise compare the same observed
      // transfer from another wallet while still reporting this row as inserted.
      const before = beforeRows.find((candidate) => candidate.wallet_pubkey === row.walletPubkey);
      const comparable = before ?? beforeRows[0];
      return {
        inserted: before === undefined,
        updated:
          comparable !== undefined &&
          (!substantiveEqual(recordFromSql(row.accountId, row.transferId, comparable), row) ||
            comparable.counterparty_account_id !== after?.counterparty_account_id),
        shopPaymentBecameCompleted:
          after?.is_shop_payment === true && before?.is_shop_payment !== true,
      };
    });
  }

  async upsertTokenTransaction(row: WalletTokenTransactionRecord): Promise<void> {
    await this.sql.execute(
      `INSERT INTO wallet_token_transaction
         (account_id, wallet_pubkey, transaction_hash, token_identifier, direction, amount,
          counterparty_pubkeys, spark_invoices, type, status, transaction_created_at,
          transaction_expiry_at, first_seen_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::text[],$8::text[],$9,$10,$11,$12,$13,$13)
       ON CONFLICT (account_id, wallet_pubkey, transaction_hash) DO UPDATE SET
         token_identifier = EXCLUDED.token_identifier,
         direction = EXCLUDED.direction,
         amount = EXCLUDED.amount,
         counterparty_pubkeys = EXCLUDED.counterparty_pubkeys,
         spark_invoices = EXCLUDED.spark_invoices,
         type = EXCLUDED.type,
         status = EXCLUDED.status,
         transaction_created_at = EXCLUDED.transaction_created_at,
         transaction_expiry_at = EXCLUDED.transaction_expiry_at,
         last_seen_at = EXCLUDED.last_seen_at`,
      [
        row.accountId,
        row.walletPubkey,
        row.transactionHash,
        row.tokenIdentifier,
        row.direction,
        row.amount,
        postgresTextArrayLiteral(row.counterpartyPubkeys),
        postgresTextArrayLiteral(row.sparkInvoices),
        row.type,
        row.status,
        row.transactionCreatedAt,
        row.transactionExpiryAt,
        row.seenAt,
      ],
    );
  }

  async markFullSync(accountId: string, walletPubkey: string, syncedAt: Date): Promise<void> {
    await this.sql.execute(
      `INSERT INTO wallet_transfer_sync (account_id, wallet_pubkey, last_full_sync_at)
       VALUES ($1,$2,$3)
       ON CONFLICT (account_id, wallet_pubkey) DO UPDATE SET
         last_full_sync_at = EXCLUDED.last_full_sync_at`,
      [accountId, walletPubkey, syncedAt],
    );
  }

  async hasShopPayment(accountId: string, fromUtcDay: string, toUtcDay: string): Promise<boolean> {
    const rows = await this.sql.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM wallet_transfer AS payment
         CROSS JOIN LATERAL unnest(payment.counterparty_pubkeys) AS counterparty(pubkey)
         JOIN LATERAL (
           SELECT COALESCE(
             (SELECT id FROM account
              WHERE spark_pubkey = counterparty.pubkey AND spark_pubkey_verified_at IS NOT NULL
              ORDER BY id LIMIT 1),
             (SELECT account_id FROM previous_wallet WHERE spark_pubkey = counterparty.pubkey
              ORDER BY replaced_at DESC, account_id LIMIT 1)
           ) AS account_id
         ) AS resolved ON resolved.account_id IS NOT NULL
         JOIN message AS shop
           ON shop.shop_account_id = resolved.account_id
          AND shop.parent_id IS NULL
          AND shop.deleted_at IS NULL
          AND shop.text ~* '#21GiftsShop([^A-Za-z0-9_]|$)'
         WHERE payment.account_id = $1
           AND payment.direction = 'out'
           AND payment.status = 'completed'
           AND payment.type = 'transfer'
           AND resolved.account_id <> payment.account_id
           AND (COALESCE(payment.transfer_updated_at, payment.transfer_created_at)
                AT TIME ZONE 'UTC')::date BETWEEN $2::date AND $3::date
       ) AS present`,
      [accountId, fromUtcDay, toUtcDay],
    );
    return rows[0]?.present === true;
  }
}
