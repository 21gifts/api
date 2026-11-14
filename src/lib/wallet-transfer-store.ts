/** Persistence for server-verified Spark wallet transfers. */

import type { SqlClient } from '@/lib/auth/sql';
import { utcDayKey } from '@/lib/funding';
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
  inputCount: number;
  resolvedInputCount: number;
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

/** Read port of the counterparty lookup over server-observed transfers. */
export interface ObservedCounterpartyStore {
  /**
   * Name the other account of the caller's completed, server-observed transfers of type
   * `transfer`; other Spark operator types never name anyone.
   *
   * @param accountId - Caller account id.
   * @param keys - Transfer ids (the reported payment ids) and directions.
   * @returns Sorted distinct counterparty account ids keyed by transfer id; absent ids have none.
   * @throws Propagates storage failures.
   */
  findObservedCounterparties(
    accountId: string,
    keys: readonly { id: string; direction: WalletTransferDirection }[],
  ): Promise<Map<string, string[]>>;
}

/** How a till receipt reached the wallet: over Lightning through the SSP, or as a plain Spark transfer. */
export type TillReceiptKind = 'lightning' | 'spark';

/** One completed incoming payment of a till's wallet that settled none of its till charges. */
export interface TillReceipt {
  /** Spark transfer id, the payment id the shop's own wallet shows. */
  id: string;
  /** Received amount in whole sats, as the server observed it. */
  amountSats: number;
  /** Operator creation time of the transfer. */
  receivedAt: Date;
  /** `lightning` for a `preimage_swap`, `spark` for a `transfer`. */
  kind: TillReceiptKind;
}

/** Bounds of one till receipt read. */
export interface TillReceiptQuery {
  /** Signed-in account; only its own wallets are read. */
  accountId: string;
  /** Oldest transfer creation time listed (epoch ms). */
  sinceMs: number;
  /** Clock (epoch ms); the end of an open charge's lifetime. */
  nowMs: number;
  /** Allowed difference between the Spark operator clock and this server's clock (ms). */
  clockAllowanceMs: number;
  /** Most receipts returned, newest first. */
  limit: number;
}

/** A till charge as the in-memory till receipt read sees it. */
export interface TillReceiptCharge {
  status: 'pending' | 'paid' | 'cancelled' | 'expired';
  sparkInvoice: string | null;
  paidAt: Date | null;
  /** BOLT11 payment hashes handed out for the charge, with their issue time. */
  invoices: readonly { paymentHash: string; createdAt: Date }[];
}

/** Collaborator data of the in-memory till receipt read (the SQL adapter joins the tables). */
export interface TillReceiptContext {
  /** Current and previous wallet keys of the account. */
  ownWalletKeys: readonly string[];
  /** The account's till charges. */
  charges: readonly TillReceiptCharge[];
  /** The account's own wallet report rows (`wallet_payment`). */
  reports: readonly {
    paymentId: string;
    direction: WalletTransferDirection;
    paymentHash: string | null;
  }[];
}

/** Read port of the till: payments a shop received without a till charge. */
export interface TillReceiptStore {
  /**
   * List the account's completed incoming Lightning receipts and plain Spark
   * transfers that settled none of its open or paid till charges, newest first.
   * Moves between the account's own current and previous wallets are left out.
   * A Spark payment settled a charge when its Spark invoice is the charge's. A
   * Lightning receipt settled a charge when the account's own wallet report of
   * that transfer id carries a payment hash recorded for the charge; while that
   * report is missing, a Lightning receipt is withheld when it falls inside the
   * lifetime of an open or paid charge with BOLT11 invoices whose settling
   * payment is not known yet.
   *
   * @param query - Account, window, clock, clock allowance, and limit.
   * @returns At most `query.limit` receipts.
   * @throws Propagates storage failures.
   */
  listTillReceipts(query: TillReceiptQuery): Promise<TillReceipt[]>;
}

const NO_TILL_CONTEXT: TillReceiptContext = { ownWalletKeys: [], charges: [], reports: [] };

function lowerOrNull(value: string | null): string | null {
  return value === null ? null : value.trim().toLowerCase();
}

/**
 * The till receipt rule over plain data; the SQL adapter states the same rule in one query.
 *
 * @param rows - The account's stored transfer rows.
 * @param context - Own wallet keys, till charges, and wallet report rows.
 * @param query - Window, clock, clock allowance, and limit.
 * @returns Receipts newest first, one per transfer id.
 */
function selectTillReceipts(
  rows: readonly WalletTransferRecord[],
  context: TillReceiptContext,
  query: TillReceiptQuery,
): TillReceipt[] {
  const live = context.charges.filter(
    (charge) =>
      charge.status === 'pending' ||
      (charge.status === 'paid' &&
        charge.paidAt !== null &&
        charge.paidAt.getTime() >= query.sinceMs - query.clockAllowanceMs),
  );
  const reported = new Map<string, string>();
  for (const report of context.reports) {
    const hash = lowerOrNull(report.paymentHash);
    if (report.direction === 'in' && hash !== null) reported.set(report.paymentId, hash);
  }
  const reportedHashes = new Set(reported.values());
  const observedInvoices = new Set(
    rows
      .filter(
        (row) =>
          row.accountId === query.accountId && row.direction === 'in' && row.status === 'completed',
      )
      .map((row) => lowerOrNull(row.sparkInvoice))
      .filter((invoice): invoice is string => invoice !== null),
  );
  const settles = (row: WalletTransferRecord, charge: TillReceiptCharge): boolean => {
    const invoice = lowerOrNull(row.sparkInvoice);
    const hash = reported.get(row.transferId);
    return (
      (invoice !== null && invoice === lowerOrNull(charge.sparkInvoice)) ||
      (hash !== undefined && charge.invoices.some((entry) => entry.paymentHash === hash))
    );
  };
  const unsettled = live.filter((charge) => {
    const invoice = lowerOrNull(charge.sparkInvoice);
    return (
      charge.invoices.length > 0 &&
      !(invoice !== null && observedInvoices.has(invoice)) &&
      !charge.invoices.some((entry) => reportedHashes.has(entry.paymentHash))
    );
  });
  const byId = new Map<string, TillReceipt>();
  for (const row of rows) {
    const created = row.transferCreatedAt?.getTime();
    if (
      row.accountId !== query.accountId ||
      row.direction !== 'in' ||
      row.status !== 'completed' ||
      (row.type !== 'preimage_swap' && row.type !== 'transfer') ||
      created === undefined ||
      created < query.sinceMs ||
      row.counterpartyPubkeys.some(
        (key) => key === row.walletPubkey || context.ownWalletKeys.includes(key),
      ) ||
      live.some((charge) => settles(row, charge))
    ) {
      continue;
    }
    if (
      row.type === 'preimage_swap' &&
      !reported.has(row.transferId) &&
      unsettled.some((charge) => {
        const first = Math.min(...charge.invoices.map((entry) => entry.createdAt.getTime()));
        const end = charge.paidAt?.getTime() ?? query.nowMs;
        return created >= first - query.clockAllowanceMs && created <= end + query.clockAllowanceMs;
      })
    ) {
      continue;
    }
    const seen = byId.get(row.transferId);
    byId.set(row.transferId, {
      id: row.transferId,
      amountSats: (seen?.amountSats ?? 0) + row.amountSats,
      receivedAt: new Date(Math.min(created, seen?.receivedAt.getTime() ?? created)),
      kind: row.type === 'preimage_swap' ? 'lightning' : 'spark',
    });
  }
  return [...byId.values()]
    .sort(
      (left, right) =>
        right.receivedAt.getTime() - left.receivedAt.getTime() ||
        Number(left.id < right.id) - Number(left.id > right.id),
    )
    .slice(0, query.limit);
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
  return at === null ? null : utcDayKey(at.getTime());
}

function transferObservationIsOlder(
  incoming: WalletTransferRecord,
  current: WalletTransferRecord,
): boolean {
  return (
    incoming.transferUpdatedAt !== null &&
    current.transferUpdatedAt !== null &&
    incoming.transferUpdatedAt.getTime() < current.transferUpdatedAt.getTime()
  );
}

/** Process-local adapter used by database-free boots and tests. */
export class InMemoryWalletTransferStore
  implements WalletTransferStore, ObservedCounterpartyStore, TillReceiptStore
{
  readonly #rows = new Map<string, WalletTransferRecord>();
  readonly #tokens = new Map<string, WalletTokenTransactionRecord>();
  readonly #fullSyncAt = new Map<string, Date>();
  readonly #wallets: WalletTransferWallet[];
  readonly #verifiedAccountForPubkey: (pubkey: string) => Promise<string | null>;
  readonly #previousAccountForPubkey: (pubkey: string) => Promise<string | null>;
  readonly #isShop: (accountId: string) => Promise<boolean>;
  readonly #tillContext: (accountId: string) => Promise<TillReceiptContext>;

  /**
   * Create an in-memory transfer store.
   *
   * @param options - Optional wallets, verified-current and previous-key resolvers,
   *   shop predicate, and till receipt context (default: no own keys, charges, or reports).
   */
  constructor(
    options: {
      wallets?: readonly WalletTransferWallet[];
      verifiedAccountForPubkey?: (pubkey: string) => Promise<string | null>;
      previousAccountForPubkey?: (pubkey: string) => Promise<string | null>;
      isShop?: (accountId: string) => Promise<boolean>;
      tillContext?: (accountId: string) => Promise<TillReceiptContext>;
    } = {},
  ) {
    this.#wallets = (options.wallets ?? []).map((wallet) => ({ ...wallet }));
    this.#verifiedAccountForPubkey =
      options.verifiedAccountForPubkey ?? (() => Promise.resolve(null));
    this.#previousAccountForPubkey =
      options.previousAccountForPubkey ?? (() => Promise.resolve(null));
    this.#isShop = options.isShop ?? (() => Promise.resolve(false));
    this.#tillContext = options.tillContext ?? (() => Promise.resolve(NO_TILL_CONTEXT));
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
      .filter(
        (row) =>
          (row.status !== 'finalized' && row.status !== 'cancelled') ||
          row.resolvedInputCount < row.inputCount,
      )
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
          ((row.status !== 'finalized' && row.status !== 'cancelled') ||
            row.resolvedInputCount < row.inputCount) &&
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
    if (existing !== undefined && transferObservationIsOlder(row, existing)) {
      return {
        inserted: false,
        updated: false,
        shopPaymentBecameCompleted: false,
      };
    }
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
    if (existing !== undefined && row.transferUpdatedAt === null) {
      next.transferUpdatedAt = dateCopy(existing.transferUpdatedAt);
      if (row.status === 'pending' && existing.status !== 'pending') {
        next.status = existing.status;
      }
    }
    if (existing !== undefined && next.seenAt.getTime() < existing.seenAt.getTime()) {
      next.seenAt = new Date(existing.seenAt.getTime());
    }
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
    const existing = this.#tokens.get(key);
    if (existing !== undefined && row.seenAt.getTime() < existing.seenAt.getTime()) {
      return Promise.resolve();
    }
    const next = {
      ...row,
      transactionCreatedAt: dateCopy(row.transactionCreatedAt),
      transactionExpiryAt: dateCopy(row.transactionExpiryAt),
      counterpartyPubkeys: [...row.counterpartyPubkeys],
      sparkInvoices: [...row.sparkInvoices],
      seenAt: new Date(row.seenAt.getTime()),
    };
    if (existing !== undefined && row.resolvedInputCount < existing.resolvedInputCount) {
      next.direction = existing.direction;
      next.amount = existing.amount;
      next.counterpartyPubkeys = [...existing.counterpartyPubkeys];
      next.inputCount = existing.inputCount;
      next.resolvedInputCount = existing.resolvedInputCount;
    }
    this.#tokens.set(key, next);
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

  async findObservedCounterparties(
    accountId: string,
    keys: readonly { id: string; direction: WalletTransferDirection }[],
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    for (const key of keys) {
      const accounts = new Set<string>();
      for (const row of this.#rows.values()) {
        if (!isObservedCounterpartyRow(row, accountId, key)) continue;
        const counterparty = await this.#accountForPubkey(row.counterpartyPubkey);
        if (counterparty !== null && counterparty !== accountId) accounts.add(counterparty);
      }
      if (accounts.size > 0) result.set(key.id, [...accounts].sort());
    }
    return result;
  }

  async listTillReceipts(query: TillReceiptQuery): Promise<TillReceipt[]> {
    const context = await this.#tillContext(query.accountId);
    return selectTillReceipts([...this.#rows.values()], context, query);
  }

  async #accountForPubkey(pubkey: string): Promise<string | null> {
    return (
      (await this.#verifiedAccountForPubkey(pubkey)) ??
      (await this.#previousAccountForPubkey(pubkey))
    );
  }
}

function isObservedCounterpartyRow(
  row: WalletTransferRecord,
  accountId: string,
  key: { id: string; direction: WalletTransferDirection },
): boolean {
  return (
    row.accountId === accountId &&
    row.transferId === key.id &&
    row.direction === key.direction &&
    row.type === 'transfer' &&
    row.status === 'completed' &&
    row.counterpartyPubkeys.every((pubkey) => pubkey === row.counterpartyPubkey)
  );
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
export class PostgresWalletTransferStore
  implements WalletTransferStore, ObservedCounterpartyStore, TillReceiptStore
{
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
                 AND (status NOT IN ('finalized', 'cancelled')
                      OR (input_count IS NOT NULL
                          AND (resolved_input_count IS NULL
                               OR resolved_input_count < input_count)))) AS oldest_pending_token_created_at,
              (SELECT coalesce(bool_or(transaction_created_at IS NULL), false)
               FROM wallet_token_transaction
               WHERE account_id = $1 AND wallet_pubkey = $2
                 AND (status NOT IN ('finalized', 'cancelled')
                      OR (input_count IS NOT NULL
                          AND (resolved_input_count IS NULL
                               OR resolved_input_count < input_count)))) AS pending_token_without_created_at,
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
           amount_sats = EXCLUDED.amount_sats,
           counterparty_pubkey = EXCLUDED.counterparty_pubkey,
           counterparty_pubkeys = EXCLUDED.counterparty_pubkeys,
           counterparty_account_id = EXCLUDED.counterparty_account_id,
           spark_invoice = EXCLUDED.spark_invoice,
           transfer_created_at = EXCLUDED.transfer_created_at,
           transfer_updated_at = COALESCE(EXCLUDED.transfer_updated_at, wallet_transfer.transfer_updated_at),
           status = CASE
             WHEN EXCLUDED.transfer_updated_at IS NULL
              AND EXCLUDED.status = 'pending'
              AND wallet_transfer.status <> 'pending'
             THEN wallet_transfer.status
             ELSE EXCLUDED.status
           END,
           last_seen_at = GREATEST(EXCLUDED.last_seen_at, wallet_transfer.last_seen_at)
         WHERE EXCLUDED.transfer_updated_at IS NULL
            OR wallet_transfer.transfer_updated_at IS NULL
            OR EXCLUDED.transfer_updated_at >= wallet_transfer.transfer_updated_at`,
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
        await tx.query<TransferSqlRow>(
          `SELECT wallet_pubkey, direction, type, status, amount_sats, counterparty_pubkey,
                  counterparty_pubkeys, counterparty_account_id, spark_invoice,
                  transfer_created_at, transfer_updated_at,
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
      const stored =
        after === undefined ? undefined : recordFromSql(row.accountId, row.transferId, after);
      return {
        inserted: before === undefined,
        updated:
          comparable !== undefined &&
          after !== undefined &&
          stored !== undefined &&
          (!substantiveEqual(recordFromSql(row.accountId, row.transferId, comparable), stored) ||
            comparable.counterparty_account_id !== after.counterparty_account_id),
        shopPaymentBecameCompleted:
          after?.is_shop_payment === true && before?.is_shop_payment !== true,
      };
    });
  }

  async upsertTokenTransaction(row: WalletTokenTransactionRecord): Promise<void> {
    await this.sql.execute(
      `INSERT INTO wallet_token_transaction
         (account_id, wallet_pubkey, transaction_hash, token_identifier, direction, amount,
          counterparty_pubkeys, input_count, resolved_input_count, spark_invoices, type, status,
          transaction_created_at, transaction_expiry_at, first_seen_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::text[],$8,$9,$10::text[],$11,$12,$13,$14,$15,$15)
       ON CONFLICT (account_id, wallet_pubkey, transaction_hash) DO UPDATE SET
         token_identifier = EXCLUDED.token_identifier,
         direction = CASE
           WHEN wallet_token_transaction.resolved_input_count IS NULL
             THEN CASE WHEN EXCLUDED.resolved_input_count = EXCLUDED.input_count
                       THEN EXCLUDED.direction ELSE wallet_token_transaction.direction END
           WHEN EXCLUDED.resolved_input_count >= wallet_token_transaction.resolved_input_count
             THEN EXCLUDED.direction
           ELSE wallet_token_transaction.direction
         END,
         amount = CASE
           WHEN wallet_token_transaction.resolved_input_count IS NULL
             THEN CASE WHEN EXCLUDED.resolved_input_count = EXCLUDED.input_count
                       THEN EXCLUDED.amount ELSE wallet_token_transaction.amount END
           WHEN EXCLUDED.resolved_input_count >= wallet_token_transaction.resolved_input_count
             THEN EXCLUDED.amount
           ELSE wallet_token_transaction.amount
         END,
         counterparty_pubkeys = CASE
           WHEN wallet_token_transaction.resolved_input_count IS NULL
             THEN CASE WHEN EXCLUDED.resolved_input_count = EXCLUDED.input_count
                       THEN EXCLUDED.counterparty_pubkeys
                       ELSE wallet_token_transaction.counterparty_pubkeys END
           WHEN EXCLUDED.resolved_input_count >= wallet_token_transaction.resolved_input_count
             THEN EXCLUDED.counterparty_pubkeys
           ELSE wallet_token_transaction.counterparty_pubkeys
         END,
         input_count = CASE
           WHEN wallet_token_transaction.resolved_input_count IS NULL
             THEN EXCLUDED.input_count
           WHEN EXCLUDED.resolved_input_count >= wallet_token_transaction.resolved_input_count
             THEN EXCLUDED.input_count
           ELSE wallet_token_transaction.input_count
         END,
         resolved_input_count = CASE
           WHEN wallet_token_transaction.resolved_input_count IS NULL
             THEN CASE WHEN EXCLUDED.resolved_input_count = EXCLUDED.input_count
                       THEN EXCLUDED.resolved_input_count
                       ELSE wallet_token_transaction.resolved_input_count END
           ELSE GREATEST(EXCLUDED.resolved_input_count,
                         wallet_token_transaction.resolved_input_count)
         END,
         spark_invoices = EXCLUDED.spark_invoices,
         type = EXCLUDED.type,
         status = EXCLUDED.status,
         transaction_created_at = EXCLUDED.transaction_created_at,
         transaction_expiry_at = EXCLUDED.transaction_expiry_at,
         last_seen_at = EXCLUDED.last_seen_at
       WHERE EXCLUDED.last_seen_at >= wallet_token_transaction.last_seen_at`,
      [
        row.accountId,
        row.walletPubkey,
        row.transactionHash,
        row.tokenIdentifier,
        row.direction,
        row.amount,
        postgresTextArrayLiteral(row.counterpartyPubkeys),
        row.inputCount,
        row.resolvedInputCount,
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
  async findObservedCounterparties(
    accountId: string,
    keys: readonly { id: string; direction: WalletTransferDirection }[],
  ): Promise<Map<string, string[]>> {
    // PostgreSQL text cannot contain NUL, so such ids cannot have stored rows.
    const searchableKeys = keys.filter((key) => !key.id.includes('\u0000'));
    const rows = await this.sql.query<{ id: string; account_id: string }>(
      `SELECT DISTINCT transfer.transfer_id AS id, resolved.account_id::text AS account_id
       FROM unnest($2::text[], $3::text[]) AS k(id, direction)
       JOIN wallet_transfer AS transfer
         ON transfer.account_id = $1 AND transfer.transfer_id = k.id
        AND transfer.direction = k.direction
       CROSS JOIN LATERAL (
         SELECT COALESCE(
           (SELECT id FROM account
            WHERE spark_pubkey = transfer.counterparty_pubkey
              AND spark_pubkey_verified_at IS NOT NULL
            ORDER BY id LIMIT 1),
           (SELECT account_id FROM previous_wallet
            WHERE spark_pubkey = transfer.counterparty_pubkey
            ORDER BY replaced_at DESC, account_id LIMIT 1)
         ) AS account_id
       ) AS resolved
       WHERE transfer.type = 'transfer'
         AND transfer.status = 'completed'
         AND transfer.counterparty_pubkeys <@ ARRAY[transfer.counterparty_pubkey]
         AND resolved.account_id IS NOT NULL
         AND resolved.account_id <> transfer.account_id
       ORDER BY id, account_id`,
      [
        accountId,
        postgresTextArrayLiteral(searchableKeys.map((key) => key.id)),
        postgresTextArrayLiteral(searchableKeys.map((key) => key.direction)),
      ],
    );
    const result = new Map<string, string[]>();
    for (const row of rows) {
      result.set(row.id, [...(result.get(row.id) ?? []), row.account_id]);
    }
    return result;
  }
  async listTillReceipts(query: TillReceiptQuery): Promise<TillReceipt[]> {
    const rows = await this.sql.query<{
      id: string;
      amount_sats: number | string | bigint;
      received_at: Date | string;
      type: 'preimage_swap' | 'transfer';
    }>(
      `WITH own_key AS (
         SELECT spark_pubkey AS pubkey FROM account WHERE id = $1 AND spark_pubkey IS NOT NULL
         UNION
         SELECT spark_pubkey FROM previous_wallet WHERE account_id = $1
       ),
       till_charge AS (
         SELECT id, lower(btrim(spark_invoice)) AS spark_invoice, paid_at
         FROM pos_charge
         WHERE account_id = $1
           AND (status = 'pending'
                OR (status = 'paid' AND paid_at >= $2::timestamptz - $4 * interval '1 millisecond'))
       ),
       received AS (
         SELECT t.transfer_id, t.type, t.amount_sats, t.transfer_created_at
         FROM wallet_transfer AS t
         WHERE t.account_id = $1
           AND t.direction = 'in'
           AND t.status = 'completed'
           AND t.type IN ('preimage_swap', 'transfer')
           AND t.transfer_created_at >= $2
           AND NOT (t.counterparty_pubkeys && (ARRAY(SELECT pubkey FROM own_key) || t.wallet_pubkey))
           AND NOT EXISTS (
             SELECT 1 FROM till_charge AS c
             WHERE t.spark_invoice IS NOT NULL AND c.spark_invoice = lower(btrim(t.spark_invoice))
           )
           AND NOT EXISTS (
             SELECT 1
             FROM wallet_payment AS p
             JOIN pos_charge_invoice AS i ON i.payment_hash = lower(btrim(p.payment_hash))
             JOIN till_charge AS c ON c.id = i.charge_id
             WHERE p.account_id = $1 AND p.payment_id = t.transfer_id AND p.direction = 'in'
           )
           AND NOT (
             t.type = 'preimage_swap'
             AND NOT EXISTS (
               SELECT 1 FROM wallet_payment AS p
               WHERE p.account_id = $1 AND p.payment_id = t.transfer_id AND p.direction = 'in'
                 AND p.payment_hash IS NOT NULL
             )
             AND EXISTS (
               SELECT 1
               FROM till_charge AS c
               CROSS JOIN LATERAL (
                 SELECT min(created_at) AS first_at FROM pos_charge_invoice WHERE charge_id = c.id
               ) AS issued
               WHERE issued.first_at IS NOT NULL
                 AND t.transfer_created_at >= issued.first_at - $4 * interval '1 millisecond'
                 AND t.transfer_created_at
                     <= COALESCE(c.paid_at, $3::timestamptz) + $4 * interval '1 millisecond'
                 AND NOT EXISTS (
                   SELECT 1 FROM wallet_transfer AS s
                   WHERE s.account_id = $1 AND s.direction = 'in' AND s.status = 'completed'
                     AND c.spark_invoice IS NOT NULL
                     AND lower(btrim(s.spark_invoice)) = c.spark_invoice
                 )
                 AND NOT EXISTS (
                   SELECT 1
                   FROM wallet_payment AS p
                   JOIN pos_charge_invoice AS i ON i.payment_hash = lower(btrim(p.payment_hash))
                   WHERE p.account_id = $1 AND p.direction = 'in' AND i.charge_id = c.id
                 )
             )
           )
       )
       SELECT transfer_id AS id, type, sum(amount_sats) AS amount_sats,
              min(transfer_created_at) AS received_at
       FROM received
       GROUP BY transfer_id, type
       ORDER BY received_at DESC, id DESC
       LIMIT $5`,
      [
        query.accountId,
        new Date(query.sinceMs),
        new Date(query.nowMs),
        query.clockAllowanceMs,
        query.limit,
      ],
    );
    return rows.map((row) => ({
      id: row.id,
      amountSats: Number(row.amount_sats),
      receivedAt: row.received_at instanceof Date ? row.received_at : new Date(row.received_at),
      kind: row.type === 'preimage_swap' ? 'lightning' : 'spark',
    }));
  }
}
