/** Persistence for server-verified Spark wallet transfers. */

import type { SqlClient } from '@/lib/auth/sql';

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
export type WalletTransferStatus = 'pending' | 'completed' | 'expired' | 'returned';

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
  sparkInvoice: string | null;
  transferCreatedAt: Date | null;
  transferUpdatedAt: Date | null;
  seenAt: Date;
}

/** Cursor facts used for overlap and pending re-reads. */
export interface WalletTransferSyncState {
  newestCreatedAt: Date | null;
  oldestPendingCreatedAt: Date | null;
  pendingWithoutCreatedAt: boolean;
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
  hasShopPayment(accountId: string, fromUtcDay: string, toUtcDay: string): Promise<boolean>;
}

function dateCopy(value: Date | null): Date | null {
  return value === null ? null : new Date(value.getTime());
}

function copyRecord(row: WalletTransferRecord): WalletTransferRecord {
  return {
    ...row,
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
  readonly #wallets: WalletTransferWallet[];
  readonly #accountForPubkey: (pubkey: string) => Promise<string | null>;
  readonly #isShop: (accountId: string) => Promise<boolean>;

  /**
   * Create an in-memory transfer store.
   *
   * @param options - Optional wallets, key resolver, and shop predicate.
   */
  constructor(
    options: {
      wallets?: readonly WalletTransferWallet[];
      accountForPubkey?: (pubkey: string) => Promise<string | null>;
      isShop?: (accountId: string) => Promise<boolean>;
    } = {},
  ) {
    this.#wallets = (options.wallets ?? []).map((wallet) => ({ ...wallet }));
    this.#accountForPubkey = options.accountForPubkey ?? (() => Promise.resolve(null));
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
    return Promise.resolve({
      newestCreatedAt: created.length === 0 ? null : new Date(Math.max(...created)),
      oldestPendingCreatedAt: pending.length === 0 ? null : new Date(Math.min(...pending)),
      pendingWithoutCreatedAt: rows.some(
        (row) => row.status === 'pending' && row.transferCreatedAt === null,
      ),
    });
  }

  async upsertTransfer(row: WalletTransferRecord): Promise<WalletTransferUpsertResult> {
    const key = `${row.accountId}\u0000${row.transferId}`;
    const existing = this.#rows.get(key);
    const counterparty = await this.#accountForPubkey(row.counterpartyPubkey);
    const wasShop =
      existing !== undefined &&
      existing.status === 'completed' &&
      existing.direction === 'out' &&
      existing.type === 'transfer' &&
      counterparty !== null &&
      counterparty !== existing.accountId &&
      (await this.#isShop(counterparty));
    const next = copyRecord(row);
    this.#rows.set(key, next);
    const isShop =
      next.status === 'completed' &&
      next.direction === 'out' &&
      next.type === 'transfer' &&
      counterparty !== null &&
      counterparty !== next.accountId &&
      (await this.#isShop(counterparty));
    return {
      inserted: existing === undefined,
      updated: existing !== undefined && !substantiveEqual(existing, next),
      shopPaymentBecameCompleted: isShop && !wasShop,
    };
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
      const counterparty = await this.#accountForPubkey(row.counterpartyPubkey);
      if (
        day !== null &&
        day >= fromUtcDay &&
        day <= toUtcDay &&
        counterparty !== null &&
        counterparty !== accountId &&
        (await this.#isShop(counterparty))
      ) {
        return true;
      }
    }
    return false;
  }
}

interface TransferSqlRow {
  wallet_pubkey: string;
  direction: WalletTransferDirection;
  type: WalletTransferType;
  status: WalletTransferStatus;
  amount_sats: number | string | bigint;
  counterparty_pubkey: string;
  counterparty_account_id: string | null;
  spark_invoice: string | null;
  transfer_created_at: Date | string | null;
  transfer_updated_at: Date | string | null;
  is_shop_payment: boolean;
}

const SHOP_EXISTS_SQL = `EXISTS (
  SELECT 1 FROM message AS shop
  WHERE shop.parent_id IS NULL
    AND shop.deleted_at IS NULL
    AND shop.shop_account_id = wallet_transfer.counterparty_account_id
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
    }>(
      `SELECT max(transfer_created_at) AS newest_created_at,
              min(transfer_created_at) FILTER (WHERE status = 'pending') AS oldest_pending_created_at
              , bool_or(status = 'pending' AND transfer_created_at IS NULL) AS pending_without_created_at
       FROM wallet_transfer WHERE account_id = $1 AND wallet_pubkey = $2`,
      [accountId, walletPubkey],
    );
    const row = rows[0];
    return {
      newestCreatedAt: sqlDate(row?.newest_created_at ?? null),
      oldestPendingCreatedAt: sqlDate(row?.oldest_pending_created_at ?? null),
      pendingWithoutCreatedAt: row?.pending_without_created_at === true,
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
                counterparty_account_id, spark_invoice, transfer_created_at, transfer_updated_at,
                (direction = 'out' AND status = 'completed' AND type = 'transfer'
                 AND counterparty_account_id IS NOT NULL AND counterparty_account_id <> account_id
                 AND ${SHOP_EXISTS_SQL}) AS is_shop_payment
         FROM wallet_transfer
         WHERE account_id = $1 AND transfer_id = $2
         FOR UPDATE`,
        [row.accountId, row.transferId],
      );
      await tx.execute(
        `INSERT INTO wallet_transfer
          (account_id, wallet_pubkey, transfer_id, direction, type, status, amount_sats,
           counterparty_pubkey, counterparty_account_id, spark_invoice, transfer_created_at,
           transfer_updated_at, first_seen_at, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
           COALESCE(
             (SELECT id FROM account WHERE spark_pubkey = $8 ORDER BY (spark_pubkey_verified_at IS NOT NULL) DESC LIMIT 1),
             (SELECT account_id FROM previous_wallet WHERE spark_pubkey = $8 ORDER BY replaced_at DESC, account_id LIMIT 1)
           ),$9,$10,$11,$12,$12)
         ON CONFLICT (account_id, transfer_id) DO UPDATE SET
           wallet_pubkey = EXCLUDED.wallet_pubkey,
           direction = EXCLUDED.direction,
           type = EXCLUDED.type,
           status = EXCLUDED.status,
           amount_sats = EXCLUDED.amount_sats,
           counterparty_pubkey = EXCLUDED.counterparty_pubkey,
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
                   AND counterparty_account_id IS NOT NULL AND counterparty_account_id <> account_id
                   AND ${SHOP_EXISTS_SQL}) AS is_shop_payment
           FROM wallet_transfer WHERE account_id = $1 AND transfer_id = $2`,
          [row.accountId, row.transferId],
        )
      )[0];
      const before = beforeRows[0];
      return {
        inserted: before === undefined,
        updated:
          before !== undefined &&
          (!substantiveEqual(recordFromSql(row.accountId, row.transferId, before), row) ||
            before.counterparty_account_id !== after?.counterparty_account_id),
        shopPaymentBecameCompleted:
          after?.is_shop_payment === true && before?.is_shop_payment !== true,
      };
    });
  }

  async hasShopPayment(accountId: string, fromUtcDay: string, toUtcDay: string): Promise<boolean> {
    const rows = await this.sql.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM wallet_transfer AS payment
         JOIN message AS shop
           ON shop.shop_account_id = payment.counterparty_account_id
          AND shop.parent_id IS NULL
          AND shop.deleted_at IS NULL
          AND shop.text ~* '#21GiftsShop([^A-Za-z0-9_]|$)'
         WHERE payment.account_id = $1
           AND payment.direction = 'out'
           AND payment.status = 'completed'
           AND payment.type = 'transfer'
           AND payment.counterparty_account_id IS NOT NULL
           AND payment.counterparty_account_id <> payment.account_id
           AND COALESCE(payment.transfer_updated_at, payment.transfer_created_at) >= $2::date
           AND COALESCE(payment.transfer_updated_at, payment.transfer_created_at) < ($3::date + interval '1 day')
       ) AS present`,
      [accountId, fromUtcDay, toUtcDay],
    );
    return rows[0]?.present === true;
  }
}
