/**
 * Persistence for shop payments in USDT and USDC
 * (`docs/shop-stablecoin-payment.md`, Rows).
 *
 * Five tables: `shop_payment`, `shop_quote`, `shop_offer`, `shop_proof`, and
 * `shop_proof_lookup` (`docs/schema/shop_payment.sql`). Every read and write
 * runs inside {@link ShopPaymentStore.transaction}; the domain logic in
 * `shop-payment.ts` uses the row operations of {@link ShopTx} only, so one
 * rule set serves the in-memory boot and Postgres. Charge rows
 * (`pos_charge`, `pos_charge_invoice`) are reached through the same
 * transaction, because a till change and the shop payment it ends commit
 * together under the account row lock.
 */

import type { MergeDb, MergeTx } from '@/lib/account-merge';
import { isUniqueViolation, type SqlClient } from '@/lib/auth/sql';
import type { PosCharge } from '@/lib/pos-charge';
import {
  PAYMENT_HASH_CLAIM_SQL,
  PAYMENT_HASH_LOCK_NAMESPACE,
  PaymentHashClaims,
  paymentHashLockKey,
} from '@/lib/payment-hash-claim';
import { InMemoryPosStore, PostgresPosStore, type PosStore } from '@/lib/pos-store';
import { postgresTextArrayLiteral } from '@/lib/postgres-text-array';
import { UUID_PATTERN } from '@/lib/uuid';

/** `shop_payment.status`. */
export type ShopPaymentStatus = 'open' | 'accepted' | 'paid' | 'ended';

/** `shop_payment.end_reason`. */
export type ShopEndReason =
  | 'window'
  | 'superseded'
  | 'replaced'
  | 'cancelled'
  | 'charge_paid'
  | 'orchestra_refunded'
  | 'orchestra_failed'
  | 'proof_refused'
  | 'expired_unpaid';

/** `shop_offer.asset`. */
export type ShopAsset = 'USDT' | 'USDC';

/** `shop_proof.source`. */
export type ShopProofSource = 'tx' | 'hex' | 'detected';

/** `shop_proof.result`; `null` is unresolved or held. */
export type ShopProofResult =
  'accepted' | 'superseded' | 'late' | 'refunded' | 'failed' | 'refused' | 'stuck';

/** `shop_proof.refusal`. */
export type ShopProofRefusal = 'mismatch' | 'expired_order' | 'hex_rejected' | 'tx_used';

/** One row of `shop_payment`. Amount columns are whole numbers. */
export interface ShopPayment {
  /** UUID; `quote.payment`. */
  id: string;
  /** Owner account id. */
  accountId: string;
  /** Fixed sat amount (at least 1). */
  amountSats: number;
  /** The till charge that fixed the sats, or `null` for a payer-opened payment. */
  posChargeId: string | null;
  /** The one BOLT11 of this payment. */
  bolt11: string;
  /** Its payment hash, 64 lowercase hex. */
  paymentHash: string;
  /** When the BOLT11 stops being payable. */
  bolt11ExpiresAt: Date;
  /** `open`, `accepted`, `paid`, or `ended`. */
  status: ShopPaymentStatus;
  /** Set exactly while `status` is `ended`. */
  endReason: ShopEndReason | null;
  /** End of the window during which the payment may pin the sticker. */
  windowEndsAt: Date;
  /** Quote replacements so far (0 to 4). */
  replacements: number;
  /** Next settlement read, or `null` once paid or closed. */
  nextSettleAt: Date | null;
  /** Next history read, or `null` when the order watch is off. */
  nextHistoryAt: Date | null;
  /** Offset of the next history page. */
  historyOffset: number;
  /**
   * When the payment's successor wait ends, or `null`; set by the
   * order-status duty for a replaced order.
   */
  successorWaitUntil: Date | null;
  /** Creation instant. */
  createdAt: Date;
  /** When the payment last became `accepted`, or `null`. */
  acceptedAt: Date | null;
  /** Set exactly while `status` is `paid`. */
  paidAt: Date | null;
  /** Set exactly while `status` is `ended`. */
  endedAt: Date | null;
  /** When the final settlement read found the BOLT11 unpaid (only on `ended`). */
  closedAt: Date | null;
}

/** One `transferAmounts` entry as served on the pay request. */
export interface ShopTransferAmount {
  /** OpenCryptoPay method name, exactly as in the method table (or `Lightning`). */
  method: string;
  /** Recommended gas price in wei; 0 for Lightning. */
  minFee: number;
  /** Offered assets with their decimal amount strings. */
  assets: { asset: string; amount: string }[];
  /** Always `true` on a stored quote. */
  available: boolean;
}

/** One row of `shop_quote`. */
export interface ShopQuote {
  /** UUID; `quote.id`. */
  id: string;
  /** Owning payment. */
  paymentId: string;
  /** `quote.expiration`. */
  expiresAt: Date;
  /** The exact array this quote served. */
  transferAmounts: ShopTransferAmount[];
  /** Creation instant; the newest quote of a payment is its current quote. */
  createdAt: Date;
}

/** One row of `shop_offer`: one committed Orchestra quote for one method and asset. */
export interface ShopOffer {
  /** UUID. */
  id: string;
  /** Owning quote. */
  quoteId: string;
  /** OpenCryptoPay method name from the method table. */
  method: string;
  /** EVM chain id of the method. */
  chainId: number;
  /** `USDT` or `USDC`. */
  asset: ShopAsset;
  /** Token contract, lowercase `0x` + 40 hex. */
  tokenAddress: string;
  /** Orchestra deposit address, lowercase `0x` + 40 hex. Unique across offers. */
  depositAddress: string;
  /** Orchestra `amountIn`, base units, decimal string. */
  amountIn: string;
  /** Orchestra `requiredAmountIn`, or `null` when absent. */
  requiredAmountIn: string | null;
  /** Orchestra `maxAcceptedAmountIn`, or `null` when absent. */
  maxAcceptedAmountIn: string | null;
  /** Token decimals from the method table. */
  decimals: number;
  /** Recommended gas price in wei at quote creation, decimal string. */
  minFee: string;
  /** Orchestra `quoteId`. */
  providerRef: string;
  /** Idempotency key of the quote call. */
  idempotencyKey: string;
  /** Orchestra `expiresAt`. */
  expiresAt: Date;
  /** First detail response for this offer, or `null`. */
  detailIssuedAt: Date | null;
  /** Creation instant. */
  createdAt: Date;
}

/** One row of `shop_proof`: one deposit to an offer's deposit address. */
export interface ShopProof {
  /** UUID. */
  id: string;
  /** The offer whose deposit address received the transfer. */
  offerId: string;
  /** The offer's payment. */
  paymentId: string;
  /** `tx`, `hex`, or `detected`. */
  source: ShopProofSource;
  /** EVM chain id. */
  chainId: number;
  /** Transaction hash, lowercase `0x` + 64 hex. */
  txHash: string;
  /** Index of the transfer log, or `null` until a receipt fills it in. */
  logIndex: number | null;
  /** ERC-4337 user-operation hash the wallet sent, or `null`. */
  userOpHash: string | null;
  /** Signed raw transaction without `0x` (only `hex`). */
  rawHex: string | null;
  /** Transferred value of the log, base units, or `null` while unknown. */
  transferAmount: string | null;
  /** Idempotency key of the current submit attempt. */
  idempotencyKey: string;
  /** Result; `null` is unresolved or held. */
  result: ShopProofResult | null;
  /** Orchestra `orderId`, or `null`. */
  providerOrder: string | null;
  /**
   * The successor order (`supersededByOperationId`) of this proof's replaced
   * order, or `null`; set by the order-status duty.
   */
  supersededByOrder: string | null;
  /** Last known `order.status`, or `null`. */
  orderStatus: string | null;
  /** When the order was first found. */
  orderFoundAt: Date | null;
  /** Why a `refused` proof was refused. */
  refusal: ShopProofRefusal | null;
  /** Set when a submit answered `409 quote_expired`. */
  submitStopped: boolean;
  /** When a `hex` transaction was first sent. */
  sentAt: Date | null;
  /** Last submit attempt. */
  lastSubmitAt: Date | null;
  /** An unresolved proof becomes `stuck` after this instant. */
  giveUpAt: Date;
  /** Next watcher submit, or `null`. */
  nextSubmitAt: Date | null;
  /** Next watcher receipt read or resend, or `null`. */
  nextReceiptAt: Date | null;
  /** Next watcher order-status read, or `null`. */
  nextStatusAt: Date | null;
  /** Watcher attempts on the current duty. */
  tries: number;
  /** When `result` last became non-null. */
  resolvedAt: Date | null;
  /** Creation instant. */
  createdAt: Date;
}

/** One row of `shop_proof_lookup`: a `tx` hash whose receipt was not found yet. */
export interface ShopProofLookup {
  /** UUID. */
  id: string;
  /** Quote the wallet named. */
  quoteId: string;
  /** Method the wallet named. */
  method: string;
  /** Asset the wallet named, or `null`. */
  asset: string | null;
  /** EVM chain id of the method. */
  chainId: number;
  /** Normalised hash the wallet sent. */
  hash: string;
  /** Next lookup. */
  nextTryAt: Date;
  /** Lookups so far. */
  tries: number;
  /** When the lookup ended, or `null`. */
  doneAt: Date | null;
  /** Creation instant. */
  createdAt: Date;
}

/** Conditions of a conditional payment update; every set condition must hold. */
export interface ShopPaymentWhere {
  /** `status` is one of these. */
  statuses?: readonly ShopPaymentStatus[];
  /** `replacements` equals this value. */
  replacements?: number;
  /** `window_ends_at` is after this instant. */
  windowEndsAfter?: Date;
  /** `closed_at` is null. */
  notClosed?: boolean;
}

/** Columns a payment update may change. */
export type ShopPaymentPatch = Partial<
  Pick<
    ShopPayment,
    | 'status'
    | 'endReason'
    | 'replacements'
    | 'nextSettleAt'
    | 'nextHistoryAt'
    | 'historyOffset'
    | 'successorWaitUntil'
    | 'acceptedAt'
    | 'paidAt'
    | 'endedAt'
    | 'closedAt'
  >
>;

/** Conditions of a conditional proof update. */
export interface ShopProofWhere {
  /** `result` is one of these (`null` included when listed). */
  results?: readonly (ShopProofResult | null)[];
  /** `last_submit_at` is null or at or before this instant (submit slot claim). */
  lastSubmitAtOrBefore?: Date;
}

/** Columns a proof update may change. */
export type ShopProofPatch = Partial<
  Omit<ShopProof, 'id' | 'paymentId' | 'source' | 'chainId' | 'createdAt' | 'rawHex'>
>;

/** Columns a lookup update may change. */
export type ShopProofLookupPatch = Partial<Pick<ShopProofLookup, 'nextTryAt' | 'tries' | 'doneAt'>>;

/** Selector for {@link ShopTx.findProofs}. */
export type ShopProofSelector =
  | { chainId: number; txHash: string }
  | { chainId: number; userOpHash: string }
  | { providerOrder: string };

/** Watcher scans over payments (oldest next-try first). */
export type ShopPaymentDuty = 'settle' | 'history';

/** Watcher scans over proofs (oldest next-try first). */
export type ShopProofDuty = 'receipt' | 'submit' | 'status' | 'stuck';

/**
 * Row operations inside one database transaction. Every write is one
 * conditional statement; a method that reports `false`, `null`, or
 * `'conflict'` changed nothing. Lock methods take `SELECT … FOR UPDATE`
 * locks that hold until the transaction ends (the in-memory store
 * serialises whole transactions instead).
 */
export interface ShopTx {
  /**
   * Take the payment hash claim (`SELECT pg_advisory_xact_lock($1, $2)`,
   * `docs/shop-stablecoin-payment.md`, Payment hash claim) until the
   * transaction ends. The first statement of a transaction that may write a
   * payment hash. A no-op in memory, where the shared in-process map is the
   * claim.
   */
  claimPaymentHash(paymentHash: string): Promise<void>;
  /** Lock the account row (`SELECT … FROM account WHERE id = $1 FOR UPDATE`). */
  lockAccount(accountId: string): Promise<void>;
  /** Lock and read one charge, or `null` when it does not exist. */
  lockCharge(chargeId: string): Promise<PosCharge | null>;
  /**
   * Read one charge without a lock (to learn the account to lock first), or
   * `null` when it does not exist.
   */
  getCharge(chargeId: string): Promise<PosCharge | null>;
  /** Lock and read one payment, or `null`. */
  lockPayment(paymentId: string): Promise<ShopPayment | null>;
  /**
   * Lock and read every proof row of a payment with one
   * `SELECT … FOR UPDATE` ordered by id (after the payment row lock).
   *
   * @returns The proofs, by `id`.
   */
  lockProofs(paymentId: string): Promise<ShopProof[]>;
  /**
   * Lock and read every proof row of several payments with one
   * `SELECT … FOR UPDATE` ordered by id (after the payment row locks).
   *
   * @returns The proofs, by `id`.
   */
  lockProofsOf(paymentIds: readonly string[]): Promise<ShopProof[]>;
  /** Lock and read one quote, or `null`. */
  lockQuote(quoteId: string): Promise<ShopQuote | null>;

  /**
   * Expire due pending charges of the account, then return the newest
   * unexpired pending charge, or `null` (as `PosStore.currentPending`).
   */
  pendingCharge(accountId: string, nowMs: number): Promise<PosCharge | null>;
  /**
   * Insert a charge (as `PosStore.create`).
   *
   * @returns `false` when an unexpired pending charge already exists.
   */
  insertCharge(row: PosCharge): Promise<boolean>;
  /** Cancel the account's pending charges (as `PosStore.cancelPending`). */
  cancelPendingCharge(accountId: string, nowMs: number): Promise<PosCharge | null>;
  /** Mark a pending or expired charge paid once (as `PosStore.markPaid`). */
  markChargePaid(chargeId: string, paidAtMs: number): Promise<PosCharge | null>;
  /** The charge id a payment hash is recorded against, or `null`. */
  chargeIdForInvoice(paymentHash: string): Promise<string | null>;
  /** Delete the `pos_charge_invoice` row of a payment hash, if any. */
  deleteChargeInvoice(paymentHash: string): Promise<void>;

  /** One payment by id, or `null`. */
  getPayment(id: string): Promise<ShopPayment | null>;
  /** The account's `open` payment, or `null`. */
  openPayment(accountId: string): Promise<ShopPayment | null>;
  /** The payment of a charge, or `null`. */
  paymentForCharge(chargeId: string): Promise<ShopPayment | null>;
  /** The payment holding a payment hash, or `null`. */
  paymentForHash(paymentHash: string): Promise<ShopPayment | null>;
  /**
   * Insert a payment.
   *
   * @returns `false` on any unique conflict (open payment of the account,
   *   `pos_charge_id`, or `payment_hash`); nothing is written then.
   */
  insertPayment(row: ShopPayment): Promise<boolean>;
  /**
   * Conditional update of one payment.
   *
   * @returns The updated row, or `null` when no row matched.
   */
  updatePayment(
    id: string,
    where: ShopPaymentWhere,
    patch: ShopPaymentPatch,
  ): Promise<ShopPayment | null>;
  /**
   * End every `open` payment whose window has passed, with `end_reason`
   * `window`, `ended_at` = `nowMs`.
   *
   * @returns The ended rows.
   */
  endLapsedWindows(nowMs: number): Promise<ShopPayment[]>;
  /** Payments due for a watcher duty at `nowMs`, at most `limit`. */
  duePayments(duty: ShopPaymentDuty, nowMs: number, limit: number): Promise<ShopPayment[]>;
  /** Payments of an account that are neither `paid` nor closed. */
  unsettledPayments(accountId: string): Promise<ShopPayment[]>;

  /** Insert a quote. */
  insertQuote(row: ShopQuote): Promise<void>;
  /**
   * Set a quote's `expires_at` and `transfer_amounts` in the transaction that
   * inserted it, once its offers are known (a deposit-address conflict drops
   * an offer, so the served array is final only after the offer insert).
   */
  updateQuote(
    id: string,
    patch: Pick<ShopQuote, 'expiresAt' | 'transferAmounts'>,
  ): Promise<ShopQuote | null>;
  /** One quote, or `null`. */
  getQuote(id: string): Promise<ShopQuote | null>;
  /** Quotes of a payment, oldest first. */
  quotesOf(paymentId: string): Promise<ShopQuote[]>;

  /**
   * Insert offers with `ON CONFLICT (deposit_address) DO NOTHING`.
   *
   * @returns The offers that were inserted, in input order.
   */
  insertOffers(rows: readonly ShopOffer[]): Promise<ShopOffer[]>;
  /** One offer, or `null`. */
  getOffer(id: string): Promise<ShopOffer | null>;
  /** Offers of a quote, in insertion order. */
  offersOf(quoteId: string): Promise<ShopOffer[]>;
  /**
   * Set `detail_issued_at` when it is still null.
   *
   * @returns `true` when this call set it.
   */
  markDetailIssued(offerId: string, atMs: number): Promise<boolean>;

  /**
   * Insert a proof.
   *
   * @returns `false` on a unique conflict; nothing is written then.
   */
  insertProof(row: ShopProof): Promise<boolean>;
  /** One proof, or `null`. */
  getProof(id: string): Promise<ShopProof | null>;
  /** Proofs of a payment, oldest first. */
  proofsOf(paymentId: string): Promise<ShopProof[]>;
  /** Proofs matching a selector, oldest first. */
  findProofs(selector: ShopProofSelector): Promise<ShopProof[]>;
  /**
   * Conditional update of one proof.
   *
   * @returns The updated row; `null` when the conditions did not hold;
   *   `'conflict'` when the change hit a unique index (nothing changed).
   */
  updateProof(
    id: string,
    where: ShopProofWhere,
    patch: ShopProofPatch,
  ): Promise<ShopProof | null | 'conflict'>;
  /** Delete one proof. */
  deleteProof(id: string): Promise<void>;
  /** Proofs due for a watcher duty at `nowMs`, at most `limit`. */
  dueProofs(duty: ShopProofDuty, nowMs: number, limit: number): Promise<ShopProof[]>;

  /**
   * Every lookup row of a quote, done or not: the count the cap of 4 lookup
   * rows per quote is checked against.
   */
  countLookups(quoteId: string): Promise<number>;
  /**
   * Insert a lookup row.
   *
   * @returns `false` on a unique conflict on `(chain_id, hash, quote_id)`.
   */
  insertLookup(row: ShopProofLookup): Promise<boolean>;
  /** The lookup row of a hash and quote, or `null`. */
  findLookup(chainId: number, hash: string, quoteId: string): Promise<ShopProofLookup | null>;
  /** Update one lookup row. */
  updateLookup(id: string, patch: ShopProofLookupPatch): Promise<ShopProofLookup | null>;
  /** Lookup rows due at `nowMs`, at most `limit`. */
  dueLookups(nowMs: number, limit: number): Promise<ShopProofLookup[]>;
}

/** Persistence port for shop payments. */
export interface ShopPaymentStore {
  /**
   * Run `run` in one transaction. A rejection rolls back every write.
   *
   * @param run - Callback receiving the transaction.
   * @returns The callback result.
   */
  transaction<T>(run: (tx: ShopTx) => Promise<T>): Promise<T>;
}

/**
 * Idempotent DDL for the shop payment tables, in order (matches
 * `docs/schema/shop_payment.sql` and the Rows section of
 * `docs/shop-stablecoin-payment.md`). Needs `account` and `pos_charge`.
 */
export const SHOP_PAYMENT_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS shop_payment (
  id                 uuid PRIMARY KEY,
  account_id         uuid NOT NULL REFERENCES account (id),
  amount_sats        bigint NOT NULL CHECK (amount_sats > 0),
  pos_charge_id      uuid UNIQUE REFERENCES pos_charge (id) ON DELETE SET NULL,
  bolt11             text NOT NULL,
  payment_hash       text NOT NULL UNIQUE,
  bolt11_expires_at  timestamptz NOT NULL,
  status             text NOT NULL CHECK (status IN ('open', 'accepted', 'paid', 'ended')),
  end_reason         text CHECK (end_reason IN ('window', 'superseded', 'replaced', 'cancelled',
                       'charge_paid', 'orchestra_refunded', 'orchestra_failed', 'proof_refused',
                       'expired_unpaid')),
  window_ends_at     timestamptz NOT NULL,
  replacements       integer NOT NULL DEFAULT 0 CHECK (replacements BETWEEN 0 AND 4),
  next_settle_at     timestamptz,
  next_history_at    timestamptz,
  history_offset     integer NOT NULL DEFAULT 0,
  successor_wait_until timestamptz,
  created_at         timestamptz NOT NULL,
  accepted_at        timestamptz,
  paid_at            timestamptz,
  ended_at           timestamptz,
  closed_at          timestamptz,
  CHECK ((status = 'paid') = (paid_at IS NOT NULL)),
  CHECK ((status = 'ended') = (ended_at IS NOT NULL)),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
  CHECK (status <> 'accepted' OR accepted_at IS NOT NULL),
  CHECK (closed_at IS NULL OR status = 'ended')
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS shop_payment_account_open_idx
  ON shop_payment (account_id) WHERE status = 'open'`,
  `CREATE INDEX IF NOT EXISTS shop_payment_history_idx
  ON shop_payment (next_history_at) WHERE next_history_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS shop_payment_settle_idx
  ON shop_payment (next_settle_at) WHERE status <> 'paid' AND closed_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS shop_quote (
  id                uuid PRIMARY KEY,
  payment_id        uuid NOT NULL REFERENCES shop_payment (id),
  expires_at        timestamptz NOT NULL,
  transfer_amounts  jsonb NOT NULL,
  created_at        timestamptz NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS shop_quote_payment_idx ON shop_quote (payment_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS shop_offer (
  id                uuid PRIMARY KEY,
  quote_id          uuid NOT NULL REFERENCES shop_quote (id),
  method            text NOT NULL,
  chain_id          integer NOT NULL,
  asset             text NOT NULL CHECK (asset IN ('USDT', 'USDC')),
  token_address     text NOT NULL,
  deposit_address   text NOT NULL,
  amount_in         numeric(78, 0) NOT NULL CHECK (amount_in > 0),
  required_amount_in     numeric(78, 0),
  max_accepted_amount_in numeric(78, 0),
  decimals          smallint NOT NULL,
  min_fee           numeric(78, 0) NOT NULL,
  provider_ref      text NOT NULL,
  idempotency_key   text NOT NULL,
  expires_at        timestamptz NOT NULL,
  detail_issued_at  timestamptz,
  created_at        timestamptz NOT NULL,
  UNIQUE (quote_id, method, asset)
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS shop_offer_deposit_idx ON shop_offer (deposit_address)`,
  `CREATE TABLE IF NOT EXISTS shop_proof (
  id                 uuid PRIMARY KEY,
  offer_id           uuid NOT NULL REFERENCES shop_offer (id),
  payment_id         uuid NOT NULL REFERENCES shop_payment (id),
  source             text NOT NULL CHECK (source IN ('tx', 'hex', 'detected')),
  chain_id           integer NOT NULL,
  tx_hash            text NOT NULL,
  log_index          integer,
  user_op_hash       text,
  raw_hex            text,
  transfer_amount    numeric(78, 0),
  idempotency_key    text NOT NULL,
  result             text CHECK (result IN ('accepted', 'superseded', 'late', 'refunded', 'failed',
                       'refused', 'stuck')),
  provider_order     text,
  superseded_by_order text,
  order_status       text,
  order_found_at     timestamptz,
  refusal            text CHECK (refusal IN ('mismatch', 'expired_order', 'hex_rejected', 'tx_used')),
  submit_stopped     boolean NOT NULL DEFAULT false, -- set when a submit answered 409 quote_expired
  sent_at            timestamptz,
  last_submit_at     timestamptz,
  give_up_at         timestamptz NOT NULL,
  next_submit_at     timestamptz,
  next_receipt_at    timestamptz,
  next_status_at     timestamptz,
  tries              integer NOT NULL DEFAULT 0,
  resolved_at        timestamptz,
  created_at         timestamptz NOT NULL,
  CHECK (source <> 'tx' OR (log_index IS NOT NULL AND transfer_amount IS NOT NULL)),
  CHECK (source <> 'hex' OR raw_hex IS NOT NULL),
  CHECK (result NOT IN ('accepted', 'superseded', 'refunded', 'failed') OR provider_order IS NOT NULL)
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS shop_proof_log_idx
  ON shop_proof (chain_id, tx_hash, log_index) WHERE log_index IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS shop_proof_unlogged_idx
  ON shop_proof (chain_id, tx_hash, offer_id) WHERE log_index IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS shop_proof_order_idx
  ON shop_proof (provider_order) WHERE provider_order IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS shop_proof_payment_accepted_idx
  ON shop_proof (payment_id) WHERE result = 'accepted'`,
  `CREATE INDEX IF NOT EXISTS shop_proof_user_op_idx
  ON shop_proof (chain_id, user_op_hash) WHERE user_op_hash IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS shop_proof_submit_idx ON shop_proof (next_submit_at)`,
  `CREATE INDEX IF NOT EXISTS shop_proof_receipt_idx ON shop_proof (next_receipt_at)`,
  `CREATE INDEX IF NOT EXISTS shop_proof_status_idx ON shop_proof (next_status_at)`,
  `CREATE INDEX IF NOT EXISTS shop_proof_superseded_idx
  ON shop_proof (payment_id) WHERE superseded_by_order IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS shop_proof_lookup (
  id           uuid PRIMARY KEY,
  quote_id     uuid NOT NULL REFERENCES shop_quote (id),
  method       text NOT NULL,
  asset        text,
  chain_id     integer NOT NULL,
  hash         text NOT NULL,
  next_try_at  timestamptz NOT NULL,
  tries        integer NOT NULL DEFAULT 0,
  done_at      timestamptz,
  created_at   timestamptz NOT NULL,
  UNIQUE (chain_id, hash, quote_id)
)`,
  `CREATE INDEX IF NOT EXISTS shop_proof_lookup_due_idx
  ON shop_proof_lookup (next_try_at) WHERE done_at IS NULL`,
];

/**
 * Apply {@link SHOP_PAYMENT_SCHEMA_SQL} in order. Idempotent. Runs after
 * `migratePosSchema` and before `migrateDbChangeSchema`.
 *
 * @param sql - Parameter-bound SQL client.
 * @returns Resolves when every statement has executed.
 */
export async function migrateShopPaymentSchema(sql: SqlClient): Promise<void> {
  for (const statement of SHOP_PAYMENT_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}

/** Error text `PosStore.create` uses for a second unexpired pending charge. */
const PAYMENT_OPEN_ERROR = 'A payment is already open';

/** Epoch ms of a nullable instant; `null` sorts and compares as never. */
function ms(value: Date | null): number {
  return value === null ? Number.POSITIVE_INFINITY : value.getTime();
}

/** Comparator: ascending by `time`, then by `id`. */
function byTimeThenId<T extends { id: string }>(time: (row: T) => number): (a: T, b: T) => number {
  return (a, b) => time(a) - time(b) || a.id.localeCompare(b.id);
}

/** Oldest `createdAt` first, then `id`. */
const byCreated = byTimeThenId<{ id: string; createdAt: Date }>((row) => row.createdAt.getTime());

/**
 * An error shaped like a Postgres unique violation (SQLSTATE 23505), so the
 * in-memory store fails where the unique index would.
 */
function uniqueViolation(index: string): Error {
  return Object.assign(new Error(`duplicate key value violates unique constraint "${index}"`), {
    code: '23505',
  });
}

/** Copy every defined patch value onto `row` (dates and arrays copied). */
function applyPatch(row: object, patch: object): void {
  const target = row as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      target[key] = structuredClone(value);
    }
  }
}

/** True when two distinct payment rows would break a unique index of `shop_payment`. */
function paymentsClash(a: ShopPayment, b: ShopPayment): boolean {
  return (
    a.id === b.id ||
    a.paymentHash === b.paymentHash ||
    (a.posChargeId !== null && a.posChargeId === b.posChargeId) ||
    (a.status === 'open' && b.status === 'open' && a.accountId === b.accountId)
  );
}

/** True when two distinct proof rows would break a unique index of `shop_proof`. */
function proofsClash(a: ShopProof, b: ShopProof): boolean {
  const sameTx = a.chainId === b.chainId && a.txHash === b.txHash;
  return (
    a.id === b.id ||
    (sameTx && a.logIndex !== null && a.logIndex === b.logIndex) ||
    (sameTx && a.logIndex === null && b.logIndex === null && a.offerId === b.offerId) ||
    (a.providerOrder !== null && a.providerOrder === b.providerOrder) ||
    (a.result === 'accepted' && b.result === 'accepted' && a.paymentId === b.paymentId)
  );
}

/** Whether `row` meets every set condition of `where`. */
function paymentMatches(row: ShopPayment, where: ShopPaymentWhere): boolean {
  return (
    (where.statuses === undefined || where.statuses.includes(row.status)) &&
    (where.replacements === undefined || row.replacements === where.replacements) &&
    (where.windowEndsAfter === undefined ||
      row.windowEndsAt.getTime() > where.windowEndsAfter.getTime()) &&
    (where.notClosed !== true || row.closedAt === null)
  );
}

/** Whether `row` meets every set condition of `where`. */
function proofMatches(row: ShopProof, where: ShopProofWhere): boolean {
  return (
    (where.results === undefined || where.results.includes(row.result)) &&
    (where.lastSubmitAtOrBefore === undefined ||
      row.lastSubmitAt === null ||
      row.lastSubmitAt.getTime() <= where.lastSubmitAtOrBefore.getTime())
  );
}

/** Settlement order: `accepted` first, then charge-backed, then `nextSettleAt`, then `id`. */
function settleRank(row: ShopPayment): number {
  return (row.status === 'accepted' ? 2 : 0) + (row.posChargeId === null ? 0 : 1);
}

/** In-memory selection and order of each payment duty (the SQL of {@link PAYMENT_DUTY_SQL}). */
const PAYMENT_DUTY: Readonly<
  Record<
    ShopPaymentDuty,
    {
      due: (row: ShopPayment, nowMs: number) => boolean;
      order: (a: ShopPayment, b: ShopPayment) => number;
    }
  >
> = {
  settle: {
    due: (row, nowMs) =>
      row.status !== 'paid' && row.closedAt === null && ms(row.nextSettleAt) <= nowMs,
    order: (a, b) =>
      settleRank(b) - settleRank(a) ||
      byTimeThenId<ShopPayment>((row) => ms(row.nextSettleAt))(a, b),
  },
  history: {
    due: (row, nowMs) => ms(row.nextHistoryAt) <= nowMs,
    order: byTimeThenId((row) => ms(row.nextHistoryAt)),
  },
};

/** In-memory selection and order of each proof duty (the SQL of {@link PROOF_DUTY_SQL}). */
const PROOF_DUTY: Readonly<
  Record<
    ShopProofDuty,
    { due: (row: ShopProof, nowMs: number) => boolean; at: (row: ShopProof) => number }
  >
> = {
  receipt: {
    due: (row, nowMs) => ms(row.nextReceiptAt) <= nowMs,
    at: (row) => ms(row.nextReceiptAt),
  },
  submit: {
    due: (row, nowMs) =>
      ms(row.nextSubmitAt) <= nowMs &&
      row.result === null &&
      row.providerOrder === null &&
      !row.submitStopped &&
      row.logIndex !== null,
    at: (row) => ms(row.nextSubmitAt),
  },
  status: {
    due: (row, nowMs) =>
      ms(row.nextStatusAt) <= nowMs &&
      row.providerOrder !== null &&
      !(row.result === 'refused' && row.refusal === 'tx_used'),
    at: (row) => ms(row.nextStatusAt),
  },
  stuck: {
    due: (row, nowMs) =>
      row.result === null && row.providerOrder === null && row.giveUpAt.getTime() <= nowMs,
    at: (row) => row.giveUpAt.getTime(),
  },
};

/** The five in-memory tables, each in insertion order. */
interface ShopTables {
  payments: ShopPayment[];
  quotes: ShopQuote[];
  offers: ShopOffer[];
  proofs: ShopProof[];
  lookups: ShopProofLookup[];
}

/** {@link ShopTx} over the in-memory tables; charge calls go to a {@link PosStore}. */
class InMemoryShopTx implements ShopTx {
  readonly #t: ShopTables;
  readonly #pos: PosStore;
  readonly #claims: PaymentHashClaims;
  /** Hashes whose shop side this transaction claimed; released again on rollback. */
  readonly claimed: string[] = [];

  /**
   * Bind the transaction view to the store's tables, the charge store, and
   * the payment hash claim map.
   *
   * @param tables - The store's tables (shared, mutated in place).
   * @param pos - Charge store that charge calls delegate to.
   * @param claims - The in-process payment hash claim shared with `pos`.
   */
  constructor(tables: ShopTables, pos: PosStore, claims: PaymentHashClaims) {
    this.#t = tables;
    this.#pos = pos;
    this.#claims = claims;
  }

  /** No-op: the shared in-process map is the claim, written by `insertPayment`. */
  async claimPaymentHash(): Promise<void> {}

  /** No-op: the store already serialises whole transactions. */
  async lockAccount(): Promise<void> {}

  /** The charge, or `null` (`findChargeForPayment({ chargeId })`). */
  async lockCharge(chargeId: string): Promise<PosCharge | null> {
    return (await this.#pos.findChargeForPayment({ chargeId })) ?? null;
  }

  /** The charge, or `null` (`findChargeForPayment({ chargeId })`). */
  async getCharge(chargeId: string): Promise<PosCharge | null> {
    return (await this.#pos.findChargeForPayment({ chargeId })) ?? null;
  }

  /** Same as {@link InMemoryShopTx.getPayment}. */
  lockPayment(paymentId: string): Promise<ShopPayment | null> {
    return this.getPayment(paymentId);
  }

  /** Copies of the payment's proofs, by `id`. */
  async lockProofs(paymentId: string): Promise<ShopProof[]> {
    return structuredClone(
      this.#t.proofs
        .filter((row) => row.paymentId === paymentId)
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
  }

  /** Copies of the payments' proofs, by `id`. */
  async lockProofsOf(paymentIds: readonly string[]): Promise<ShopProof[]> {
    return structuredClone(
      this.#t.proofs
        .filter((row) => paymentIds.includes(row.paymentId))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
  }

  /** Same as {@link InMemoryShopTx.getQuote}. */
  lockQuote(quoteId: string): Promise<ShopQuote | null> {
    return this.getQuote(quoteId);
  }

  /** `PosStore.currentPending`. */
  pendingCharge(accountId: string, nowMs: number): Promise<PosCharge | null> {
    return this.#pos.currentPending(accountId, nowMs);
  }

  /** `PosStore.create`; its `A payment is already open` refusal becomes `false`. */
  async insertCharge(row: PosCharge): Promise<boolean> {
    try {
      await this.#pos.create(row);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === PAYMENT_OPEN_ERROR) {
        return false;
      }
      throw error;
    }
  }

  /** `PosStore.cancelPending`. */
  cancelPendingCharge(accountId: string, nowMs: number): Promise<PosCharge | null> {
    return this.#pos.cancelPending(accountId, nowMs);
  }

  /** `PosStore.markPaid`. */
  markChargePaid(chargeId: string, paidAtMs: number): Promise<PosCharge | null> {
    return this.#pos.markPaid(chargeId, paidAtMs);
  }

  /** Id of the charge the hash is recorded against, or `null`. */
  async chargeIdForInvoice(paymentHash: string): Promise<string | null> {
    return (await this.#pos.findChargeForPayment({ paymentHash }))?.id ?? null;
  }

  /** `PosStore.deleteInvoice`. */
  deleteChargeInvoice(paymentHash: string): Promise<void> {
    return this.#pos.deleteInvoice(paymentHash);
  }

  /** A copy of the first payment matching `match`, or `null`. */
  #payment(match: (row: ShopPayment) => boolean): ShopPayment | null {
    const row = this.#t.payments.find(match);
    return row === undefined ? null : structuredClone(row);
  }

  /** A copy of the payment, or `null`. */
  async getPayment(id: string): Promise<ShopPayment | null> {
    return this.#payment((row) => row.id === id);
  }

  /** A copy of the account's `open` payment, or `null`. */
  async openPayment(accountId: string): Promise<ShopPayment | null> {
    return this.#payment((row) => row.accountId === accountId && row.status === 'open');
  }

  /** A copy of the charge's payment, or `null`. */
  async paymentForCharge(chargeId: string): Promise<ShopPayment | null> {
    return this.#payment((row) => row.posChargeId === chargeId);
  }

  /** A copy of the payment holding the hash, or `null`. */
  async paymentForHash(paymentHash: string): Promise<ShopPayment | null> {
    return this.#payment((row) => row.paymentHash === paymentHash);
  }

  /**
   * Store a copy unless the payment hash claim or a unique index would refuse
   * it. The claim map is read and written in the same synchronous step as
   * the push: a hash held by another charge's invoice row or by another
   * payment refuses; this charge's own invoice row (step 4) does not.
   */
  async insertPayment(row: ShopPayment): Promise<boolean> {
    const holder = this.#claims.holder(row.paymentHash);
    if (
      (holder !== null &&
        (holder.paymentId !== null ||
          (holder.chargeId !== null && holder.chargeId !== row.posChargeId))) ||
      this.#t.payments.some((other) => paymentsClash(row, other))
    ) {
      return false;
    }
    this.#t.payments.push(structuredClone(row));
    this.#claims.claimShop(row.paymentHash, row.id, row.posChargeId);
    this.claimed.push(row.paymentHash);
    return true;
  }

  /**
   * Patch the payment when `where` holds.
   *
   * @throws Error with code `23505` when the patch opens a second payment of the account.
   */
  async updatePayment(
    id: string,
    where: ShopPaymentWhere,
    patch: ShopPaymentPatch,
  ): Promise<ShopPayment | null> {
    const row = this.#t.payments.find((candidate) => candidate.id === id);
    if (row === undefined || !paymentMatches(row, where)) {
      return null;
    }
    const next = structuredClone(row);
    applyPatch(next, patch);
    if (this.#t.payments.some((other) => other !== row && paymentsClash(next, other))) {
      throw uniqueViolation('shop_payment_account_open_idx');
    }
    applyPatch(row, patch);
    return structuredClone(row);
  }

  /** End `open` payments whose window has passed. */
  async endLapsedWindows(nowMs: number): Promise<ShopPayment[]> {
    const ended: ShopPayment[] = [];
    for (const row of this.#t.payments) {
      if (row.status === 'open' && row.windowEndsAt.getTime() <= nowMs) {
        row.status = 'ended';
        row.endReason = 'window';
        row.endedAt = new Date(nowMs);
        ended.push(structuredClone(row));
      }
    }
    return ended;
  }

  /** Copies of the payments due for `duty`, in the duty's order. */
  async duePayments(duty: ShopPaymentDuty, nowMs: number, limit: number): Promise<ShopPayment[]> {
    const { due, order } = PAYMENT_DUTY[duty];
    return structuredClone(
      this.#t.payments
        .filter((row) => due(row, nowMs))
        .sort(order)
        .slice(0, limit),
    );
  }

  /** Copies of the account's payments that are neither `paid` nor closed, oldest first. */
  async unsettledPayments(accountId: string): Promise<ShopPayment[]> {
    return structuredClone(
      this.#t.payments
        .filter(
          (row) => row.accountId === accountId && row.status !== 'paid' && row.closedAt === null,
        )
        .sort(byCreated),
    );
  }

  /**
   * Store a copy of the quote.
   *
   * @throws Error with code `23505` when the id exists.
   */
  async insertQuote(row: ShopQuote): Promise<void> {
    if (this.#t.quotes.some((other) => other.id === row.id)) {
      throw uniqueViolation('shop_quote_pkey');
    }
    this.#t.quotes.push(structuredClone(row));
  }

  /** Replace the quote's expiry and served array. */
  async updateQuote(
    id: string,
    patch: Pick<ShopQuote, 'expiresAt' | 'transferAmounts'>,
  ): Promise<ShopQuote | null> {
    const row = this.#t.quotes.find((candidate) => candidate.id === id);
    if (row === undefined) {
      return null;
    }
    row.expiresAt = new Date(patch.expiresAt.getTime());
    row.transferAmounts = structuredClone(patch.transferAmounts);
    return structuredClone(row);
  }

  /** A copy of the quote, or `null`. */
  async getQuote(id: string): Promise<ShopQuote | null> {
    const row = this.#t.quotes.find((candidate) => candidate.id === id);
    return row === undefined ? null : structuredClone(row);
  }

  /** Copies of the payment's quotes, oldest first. */
  async quotesOf(paymentId: string): Promise<ShopQuote[]> {
    return structuredClone(
      this.#t.quotes.filter((row) => row.paymentId === paymentId).sort(byCreated),
    );
  }

  /**
   * Store copies; an offer whose deposit address exists is dropped.
   *
   * @throws Error with code `23505` on a duplicate id or `(quote, method, asset)`.
   */
  async insertOffers(rows: readonly ShopOffer[]): Promise<ShopOffer[]> {
    const inserted: ShopOffer[] = [];
    for (const row of rows) {
      const offers = this.#t.offers;
      if (offers.some((other) => other.depositAddress === row.depositAddress)) {
        continue;
      }
      if (
        offers.some(
          (other) =>
            other.id === row.id ||
            (other.quoteId === row.quoteId &&
              other.method === row.method &&
              other.asset === row.asset),
        )
      ) {
        throw uniqueViolation('shop_offer_quote_id_method_asset_key');
      }
      offers.push(structuredClone(row));
      inserted.push(structuredClone(row));
    }
    return inserted;
  }

  /** A copy of the offer, or `null`. */
  async getOffer(id: string): Promise<ShopOffer | null> {
    const row = this.#t.offers.find((candidate) => candidate.id === id);
    return row === undefined ? null : structuredClone(row);
  }

  /** Copies of the quote's offers by `createdAt`, then `id` (as the SQL store). */
  async offersOf(quoteId: string): Promise<ShopOffer[]> {
    return structuredClone(this.#t.offers.filter((row) => row.quoteId === quoteId).sort(byCreated));
  }

  /** Set `detailIssuedAt` when still null. */
  async markDetailIssued(offerId: string, atMs: number): Promise<boolean> {
    const row = this.#t.offers.find((candidate) => candidate.id === offerId);
    if (row === undefined || row.detailIssuedAt !== null) {
      return false;
    }
    row.detailIssuedAt = new Date(atMs);
    return true;
  }

  /** Store a copy unless a unique index would refuse it. */
  async insertProof(row: ShopProof): Promise<boolean> {
    if (this.#t.proofs.some((other) => proofsClash(row, other))) {
      return false;
    }
    this.#t.proofs.push(structuredClone(row));
    return true;
  }

  /** A copy of the proof, or `null`. */
  async getProof(id: string): Promise<ShopProof | null> {
    const row = this.#t.proofs.find((candidate) => candidate.id === id);
    return row === undefined ? null : structuredClone(row);
  }

  /** Copies of the payment's proofs, oldest first. */
  async proofsOf(paymentId: string): Promise<ShopProof[]> {
    return structuredClone(
      this.#t.proofs.filter((row) => row.paymentId === paymentId).sort(byCreated),
    );
  }

  /** Copies of the proofs matching `selector`, oldest first. */
  async findProofs(selector: ShopProofSelector): Promise<ShopProof[]> {
    const match =
      'providerOrder' in selector
        ? (row: ShopProof): boolean => row.providerOrder === selector.providerOrder
        : 'txHash' in selector
          ? (row: ShopProof): boolean =>
              row.chainId === selector.chainId && row.txHash === selector.txHash
          : (row: ShopProof): boolean =>
              row.chainId === selector.chainId && row.userOpHash === selector.userOpHash;
    return structuredClone(this.#t.proofs.filter(match).sort(byCreated));
  }

  /** Patch the proof when `where` holds; `'conflict'` when a unique index would refuse it. */
  async updateProof(
    id: string,
    where: ShopProofWhere,
    patch: ShopProofPatch,
  ): Promise<ShopProof | null | 'conflict'> {
    const row = this.#t.proofs.find((candidate) => candidate.id === id);
    if (row === undefined || !proofMatches(row, where)) {
      return null;
    }
    const next = structuredClone(row);
    applyPatch(next, patch);
    if (this.#t.proofs.some((other) => other !== row && proofsClash(next, other))) {
      return 'conflict';
    }
    applyPatch(row, patch);
    return structuredClone(row);
  }

  /** Remove the proof, if present. */
  async deleteProof(id: string): Promise<void> {
    const index = this.#t.proofs.findIndex((row) => row.id === id);
    if (index !== -1) {
      this.#t.proofs.splice(index, 1);
    }
  }

  /** Copies of the proofs due for `duty`, by the duty's column, then `id`. */
  async dueProofs(duty: ShopProofDuty, nowMs: number, limit: number): Promise<ShopProof[]> {
    const { due, at } = PROOF_DUTY[duty];
    return structuredClone(
      this.#t.proofs
        .filter((row) => due(row, nowMs))
        .sort(byTimeThenId(at))
        .slice(0, limit),
    );
  }

  /** Lookups of the quote, done or not. */
  async countLookups(quoteId: string): Promise<number> {
    return this.#t.lookups.filter((row) => row.quoteId === quoteId).length;
  }

  /** Store a copy unless the id or `(chainId, hash, quoteId)` exists. */
  async insertLookup(row: ShopProofLookup): Promise<boolean> {
    if (
      this.#t.lookups.some(
        (other) =>
          other.id === row.id ||
          (other.chainId === row.chainId &&
            other.hash === row.hash &&
            other.quoteId === row.quoteId),
      )
    ) {
      return false;
    }
    this.#t.lookups.push(structuredClone(row));
    return true;
  }

  /** A copy of the lookup, or `null`. */
  async findLookup(
    chainId: number,
    hash: string,
    quoteId: string,
  ): Promise<ShopProofLookup | null> {
    const row = this.#t.lookups.find(
      (candidate) =>
        candidate.chainId === chainId && candidate.hash === hash && candidate.quoteId === quoteId,
    );
    return row === undefined ? null : structuredClone(row);
  }

  /** Patch the lookup; `null` when it does not exist. */
  async updateLookup(id: string, patch: ShopProofLookupPatch): Promise<ShopProofLookup | null> {
    const row = this.#t.lookups.find((candidate) => candidate.id === id);
    if (row === undefined) {
      return null;
    }
    applyPatch(row, patch);
    return structuredClone(row);
  }

  /** Copies of the open lookups due at `nowMs`, by `nextTryAt`, then `id`. */
  async dueLookups(nowMs: number, limit: number): Promise<ShopProofLookup[]> {
    return structuredClone(
      this.#t.lookups
        .filter((row) => row.doneAt === null && row.nextTryAt.getTime() <= nowMs)
        .sort(byTimeThenId((row) => row.nextTryAt.getTime()))
        .slice(0, limit),
    );
  }
}

/**
 * Process-local {@link ShopPaymentStore} for tests and boots without a
 * database. Whole transactions run one at a time in call order; a rejected
 * callback restores every shop table to its state before the callback and
 * releases the payment hashes its inserts claimed (charge changes go to the
 * given {@link PosStore} and are not undone). The payment hash claim is the
 * in-process {@link PaymentHashClaims} map it shares with an
 * `InMemoryPosStore`. Every row handed out is a caller-owned copy. Calling
 * `transaction` from inside a transaction waits forever.
 */
export class InMemoryShopPaymentStore implements ShopPaymentStore {
  readonly #tables: ShopTables = { payments: [], quotes: [], offers: [], proofs: [], lookups: [] };
  readonly #pos: PosStore;
  readonly #claims: PaymentHashClaims;
  #tail: Promise<void> = Promise.resolve();

  /**
   * Create empty tables whose charge calls go to `pos`.
   *
   * @param pos - Charge store the charge calls delegate to.
   * @param claims - The payment hash claim map; default the
   *   `paymentHashClaims` of `pos` when it is an `InMemoryPosStore`, else a
   *   new map.
   */
  constructor(pos: PosStore, claims?: PaymentHashClaims) {
    this.#pos = pos;
    this.#claims =
      claims ?? (pos instanceof InMemoryPosStore ? pos.paymentHashClaims : new PaymentHashClaims());
  }

  /**
   * Run `run` after every earlier transaction has finished.
   *
   * @param run - Callback receiving the transaction.
   * @returns The callback result.
   * @throws Whatever `run` rejects with, after the shop tables are restored.
   */
  transaction<T>(run: (tx: ShopTx) => Promise<T>): Promise<T> {
    const result = this.#tail.then(() => this.#run(run));
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Run one transaction on a snapshot of the shop tables.
   *
   * @param run - Callback receiving the transaction.
   * @returns The callback result.
   * @throws Whatever `run` rejects with, after the shop tables are restored.
   */
  async #run<T>(run: (tx: ShopTx) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.#tables);
    const tx = new InMemoryShopTx(this.#tables, this.#pos, this.#claims);
    try {
      return await run(tx);
    } catch (error) {
      this.#tables.payments.splice(0, Infinity, ...snapshot.payments);
      this.#tables.quotes.splice(0, Infinity, ...snapshot.quotes);
      this.#tables.offers.splice(0, Infinity, ...snapshot.offers);
      this.#tables.proofs.splice(0, Infinity, ...snapshot.proofs);
      this.#tables.lookups.splice(0, Infinity, ...snapshot.lookups);
      for (const paymentHash of tx.claimed) {
        this.#claims.release(paymentHash, 'shop');
      }
      throw error;
    }
  }
}

/** A `timestamptz` as the driver returns it. */
type SqlTime = Date | string;
/** An integer column as the driver returns it (`bigint` may arrive as a string). */
type SqlInt = number | string | bigint;

/** Row shape selected from `shop_payment`. */
interface PaymentSqlRow {
  id: string;
  account_id: string;
  amount_sats: SqlInt;
  pos_charge_id: string | null;
  bolt11: string;
  payment_hash: string;
  bolt11_expires_at: SqlTime;
  status: string;
  end_reason: string | null;
  window_ends_at: SqlTime;
  replacements: SqlInt;
  next_settle_at: SqlTime | null;
  next_history_at: SqlTime | null;
  history_offset: SqlInt;
  successor_wait_until: SqlTime | null;
  created_at: SqlTime;
  accepted_at: SqlTime | null;
  paid_at: SqlTime | null;
  ended_at: SqlTime | null;
  closed_at: SqlTime | null;
}

/** Row shape selected from `shop_quote`. */
interface QuoteSqlRow {
  id: string;
  payment_id: string;
  expires_at: SqlTime;
  transfer_amounts: unknown;
  created_at: SqlTime;
}

/** Row shape selected from `shop_offer`. */
interface OfferSqlRow {
  id: string;
  quote_id: string;
  method: string;
  chain_id: SqlInt;
  asset: string;
  token_address: string;
  deposit_address: string;
  amount_in: SqlInt;
  required_amount_in: SqlInt | null;
  max_accepted_amount_in: SqlInt | null;
  decimals: SqlInt;
  min_fee: SqlInt;
  provider_ref: string;
  idempotency_key: string;
  expires_at: SqlTime;
  detail_issued_at: SqlTime | null;
  created_at: SqlTime;
}

/** Row shape selected from `shop_proof`. */
interface ProofSqlRow {
  id: string;
  offer_id: string;
  payment_id: string;
  source: string;
  chain_id: SqlInt;
  tx_hash: string;
  log_index: SqlInt | null;
  user_op_hash: string | null;
  raw_hex: string | null;
  transfer_amount: SqlInt | null;
  idempotency_key: string;
  result: string | null;
  provider_order: string | null;
  superseded_by_order: string | null;
  order_status: string | null;
  order_found_at: SqlTime | null;
  refusal: string | null;
  submit_stopped: boolean;
  sent_at: SqlTime | null;
  last_submit_at: SqlTime | null;
  give_up_at: SqlTime;
  next_submit_at: SqlTime | null;
  next_receipt_at: SqlTime | null;
  next_status_at: SqlTime | null;
  tries: SqlInt;
  resolved_at: SqlTime | null;
  created_at: SqlTime;
}

/** Row shape selected from `shop_proof_lookup`. */
interface LookupSqlRow {
  id: string;
  quote_id: string;
  method: string;
  asset: string | null;
  chain_id: SqlInt;
  hash: string;
  next_try_at: SqlTime;
  tries: SqlInt;
  done_at: SqlTime | null;
  created_at: SqlTime;
}

/** Columns of `shop_payment`, in {@link PaymentSqlRow} order. */
const PAYMENT_COLUMNS =
  'id, account_id, amount_sats, pos_charge_id, bolt11, payment_hash, bolt11_expires_at, status, ' +
  'end_reason, window_ends_at, replacements, next_settle_at, next_history_at, history_offset, ' +
  'successor_wait_until, created_at, accepted_at, paid_at, ended_at, closed_at';
/** Columns of `shop_quote`. */
const QUOTE_COLUMNS = 'id, payment_id, expires_at, transfer_amounts, created_at';
/** Columns of `shop_offer`. */
const OFFER_COLUMNS =
  'id, quote_id, method, chain_id, asset, token_address, deposit_address, amount_in, ' +
  'required_amount_in, max_accepted_amount_in, decimals, min_fee, provider_ref, ' +
  'idempotency_key, expires_at, detail_issued_at, created_at';
/** Columns of `shop_proof`. */
const PROOF_COLUMNS =
  'id, offer_id, payment_id, source, chain_id, tx_hash, log_index, user_op_hash, raw_hex, ' +
  'transfer_amount, idempotency_key, result, provider_order, superseded_by_order, order_status, ' +
  'order_found_at, refusal, submit_stopped, sent_at, last_submit_at, give_up_at, ' +
  'next_submit_at, next_receipt_at, next_status_at, tries, resolved_at, created_at';
/** Columns of `shop_proof_lookup`. */
const LOOKUP_COLUMNS =
  'id, quote_id, method, asset, chain_id, hash, next_try_at, tries, done_at, created_at';

/** Patch key to column of `shop_payment`; the only identifiers an update writes. */
const PAYMENT_PATCH_COLUMNS: Readonly<Record<keyof ShopPaymentPatch, string>> = {
  status: 'status',
  endReason: 'end_reason',
  replacements: 'replacements',
  nextSettleAt: 'next_settle_at',
  nextHistoryAt: 'next_history_at',
  historyOffset: 'history_offset',
  successorWaitUntil: 'successor_wait_until',
  acceptedAt: 'accepted_at',
  paidAt: 'paid_at',
  endedAt: 'ended_at',
  closedAt: 'closed_at',
};

/** Patch key to column of `shop_proof`. */
const PROOF_PATCH_COLUMNS: Readonly<Record<keyof ShopProofPatch, string>> = {
  offerId: 'offer_id',
  txHash: 'tx_hash',
  logIndex: 'log_index',
  userOpHash: 'user_op_hash',
  transferAmount: 'transfer_amount',
  idempotencyKey: 'idempotency_key',
  result: 'result',
  providerOrder: 'provider_order',
  supersededByOrder: 'superseded_by_order',
  orderStatus: 'order_status',
  orderFoundAt: 'order_found_at',
  refusal: 'refusal',
  submitStopped: 'submit_stopped',
  sentAt: 'sent_at',
  lastSubmitAt: 'last_submit_at',
  giveUpAt: 'give_up_at',
  nextSubmitAt: 'next_submit_at',
  nextReceiptAt: 'next_receipt_at',
  nextStatusAt: 'next_status_at',
  tries: 'tries',
  resolvedAt: 'resolved_at',
};

/** Patch key to column of `shop_proof_lookup`. */
const LOOKUP_PATCH_COLUMNS: Readonly<Record<keyof ShopProofLookupPatch, string>> = {
  nextTryAt: 'next_try_at',
  tries: 'tries',
  doneAt: 'done_at',
};

/** `WHERE` and `ORDER BY` of each payment duty; `$1` is now, `$2` the limit. */
const PAYMENT_DUTY_SQL: Readonly<Record<ShopPaymentDuty, string>> = {
  settle: `status <> 'paid' AND closed_at IS NULL AND next_settle_at <= $1
ORDER BY (status = 'accepted') DESC, (pos_charge_id IS NOT NULL) DESC, next_settle_at, id`,
  history: `next_history_at <= $1
ORDER BY next_history_at, id`,
};

/** `WHERE` and `ORDER BY` of each proof duty; `$1` is now, `$2` the limit. */
const PROOF_DUTY_SQL: Readonly<Record<ShopProofDuty, string>> = {
  receipt: `next_receipt_at <= $1
ORDER BY next_receipt_at, id`,
  submit: `next_submit_at <= $1 AND result IS NULL AND provider_order IS NULL AND NOT submit_stopped
  AND log_index IS NOT NULL
ORDER BY next_submit_at, id`,
  status: `next_status_at <= $1 AND provider_order IS NOT NULL
  AND NOT (result IS NOT DISTINCT FROM 'refused' AND refusal IS NOT DISTINCT FROM 'tx_used')
ORDER BY next_status_at, id`,
  stuck: `result IS NULL AND provider_order IS NULL AND give_up_at <= $1
ORDER BY give_up_at, id`,
};

/** Savepoint that guards a statement whose unique violation is an answer, not a failure. */
const GUARD_SAVEPOINT = 'shop_store_guard';

/** Returned by {@link PostgresShopTx} guard when the statement hit a unique index. */
const CONFLICT = Symbol('conflict');

/** Copy a driver timestamp into a caller-owned `Date`. */
function asDate(value: SqlTime): Date {
  return new Date(value);
}

/** Nullable {@link asDate}. */
function asMaybeDate(value: SqlTime | null): Date | null {
  return value === null ? null : asDate(value);
}

/** Nullable `numeric` as a decimal string. */
function asMaybeDecimal(value: SqlInt | null): string | null {
  return value === null ? null : String(value);
}

/** Bind value: instants as ISO strings, everything else unchanged. */
function bind(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

/** `$1, $2, …, $count`. */
function placeholders(count: number): string {
  return Array.from({ length: count }, (_, index) => `$${index + 1}`).join(', ');
}

/** Map a `shop_payment` row. */
function mapPayment(row: PaymentSqlRow): ShopPayment {
  return {
    id: row.id,
    accountId: row.account_id,
    amountSats: Number(row.amount_sats),
    posChargeId: row.pos_charge_id,
    bolt11: row.bolt11,
    paymentHash: row.payment_hash,
    bolt11ExpiresAt: asDate(row.bolt11_expires_at),
    status: row.status as ShopPaymentStatus,
    endReason: row.end_reason as ShopEndReason | null,
    windowEndsAt: asDate(row.window_ends_at),
    replacements: Number(row.replacements),
    nextSettleAt: asMaybeDate(row.next_settle_at),
    nextHistoryAt: asMaybeDate(row.next_history_at),
    historyOffset: Number(row.history_offset),
    successorWaitUntil: asMaybeDate(row.successor_wait_until),
    createdAt: asDate(row.created_at),
    acceptedAt: asMaybeDate(row.accepted_at),
    paidAt: asMaybeDate(row.paid_at),
    endedAt: asMaybeDate(row.ended_at),
    closedAt: asMaybeDate(row.closed_at),
  };
}

/** Map a `shop_quote` row; `transfer_amounts` arrives parsed or as JSON text. */
function mapQuote(row: QuoteSqlRow): ShopQuote {
  const amounts: unknown =
    typeof row.transfer_amounts === 'string'
      ? JSON.parse(row.transfer_amounts)
      : structuredClone(row.transfer_amounts);
  return {
    id: row.id,
    paymentId: row.payment_id,
    expiresAt: asDate(row.expires_at),
    transferAmounts: amounts as ShopTransferAmount[],
    createdAt: asDate(row.created_at),
  };
}

/** Map a `shop_offer` row. */
function mapOffer(row: OfferSqlRow): ShopOffer {
  return {
    id: row.id,
    quoteId: row.quote_id,
    method: row.method,
    chainId: Number(row.chain_id),
    asset: row.asset as ShopAsset,
    tokenAddress: row.token_address,
    depositAddress: row.deposit_address,
    amountIn: String(row.amount_in),
    requiredAmountIn: asMaybeDecimal(row.required_amount_in),
    maxAcceptedAmountIn: asMaybeDecimal(row.max_accepted_amount_in),
    decimals: Number(row.decimals),
    minFee: String(row.min_fee),
    providerRef: row.provider_ref,
    idempotencyKey: row.idempotency_key,
    expiresAt: asDate(row.expires_at),
    detailIssuedAt: asMaybeDate(row.detail_issued_at),
    createdAt: asDate(row.created_at),
  };
}

/** Map a `shop_proof` row. */
function mapProof(row: ProofSqlRow): ShopProof {
  return {
    id: row.id,
    offerId: row.offer_id,
    paymentId: row.payment_id,
    source: row.source as ShopProofSource,
    chainId: Number(row.chain_id),
    txHash: row.tx_hash,
    logIndex: row.log_index === null ? null : Number(row.log_index),
    userOpHash: row.user_op_hash,
    rawHex: row.raw_hex,
    transferAmount: asMaybeDecimal(row.transfer_amount),
    idempotencyKey: row.idempotency_key,
    result: row.result as ShopProofResult | null,
    providerOrder: row.provider_order,
    supersededByOrder: row.superseded_by_order,
    orderStatus: row.order_status,
    orderFoundAt: asMaybeDate(row.order_found_at),
    refusal: row.refusal as ShopProofRefusal | null,
    submitStopped: row.submit_stopped,
    sentAt: asMaybeDate(row.sent_at),
    lastSubmitAt: asMaybeDate(row.last_submit_at),
    giveUpAt: asDate(row.give_up_at),
    nextSubmitAt: asMaybeDate(row.next_submit_at),
    nextReceiptAt: asMaybeDate(row.next_receipt_at),
    nextStatusAt: asMaybeDate(row.next_status_at),
    tries: Number(row.tries),
    resolvedAt: asMaybeDate(row.resolved_at),
    createdAt: asDate(row.created_at),
  };
}

/** Map a `shop_proof_lookup` row. */
function mapLookup(row: LookupSqlRow): ShopProofLookup {
  return {
    id: row.id,
    quoteId: row.quote_id,
    method: row.method,
    asset: row.asset,
    chainId: Number(row.chain_id),
    hash: row.hash,
    nextTryAt: asDate(row.next_try_at),
    tries: Number(row.tries),
    doneAt: asMaybeDate(row.done_at),
    createdAt: asDate(row.created_at),
  };
}

/**
 * `SET` list of the defined patch values, binding each into `params`. Only
 * columns from `columns` are written; an empty patch writes `id = id`.
 */
function setList(
  columns: Readonly<Record<string, string>>,
  patch: object,
  params: unknown[],
): string {
  const sets: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const column = columns[key];
    if (column !== undefined && value !== undefined) {
      params.push(bind(value));
      sets.push(`${column} = $${params.length}`);
    }
  }
  return sets.length === 0 ? 'id = id' : sets.join(', ');
}

/** {@link ShopTx} on one Postgres transaction connection. */
class PostgresShopTx implements ShopTx {
  readonly #tx: MergeTx;
  readonly #pos: PostgresPosStore;

  /**
   * Bind the statements to one reserved transaction connection, with a
   * `PostgresPosStore` on the same connection for the charge calls.
   *
   * @param tx - The reserved transaction connection.
   */
  constructor(tx: MergeTx) {
    this.#tx = tx;
    this.#pos = new PostgresPosStore({
      query: (text, params) => tx.query(text, params),
      execute: async (text, params) => {
        await tx.query(text, params);
      },
    });
  }

  /**
   * Run `run` under a savepoint; a unique violation rolls back to it and
   * yields {@link CONFLICT}, any other error propagates.
   */
  async #guard<T>(run: () => Promise<T>): Promise<T | typeof CONFLICT> {
    await this.#tx.query(`SAVEPOINT ${GUARD_SAVEPOINT}`);
    let value: T;
    try {
      value = await run();
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      await this.#tx.query(`ROLLBACK TO SAVEPOINT ${GUARD_SAVEPOINT}`);
      await this.#tx.query(`RELEASE SAVEPOINT ${GUARD_SAVEPOINT}`);
      return CONFLICT;
    }
    await this.#tx.query(`RELEASE SAVEPOINT ${GUARD_SAVEPOINT}`);
    return value;
  }

  /** `SELECT pg_advisory_xact_lock($1, $2)` on the hash's namespace and first 32 bits. */
  async claimPaymentHash(paymentHash: string): Promise<void> {
    await this.#tx.query(PAYMENT_HASH_CLAIM_SQL, [
      PAYMENT_HASH_LOCK_NAMESPACE,
      paymentHashLockKey(paymentHash),
    ]);
  }

  /** `SELECT … FOR UPDATE` on the account row; a malformed id locks nothing. */
  async lockAccount(accountId: string): Promise<void> {
    if (UUID_PATTERN.test(accountId)) {
      await this.#tx.query(`SELECT id FROM account WHERE id = $1 FOR UPDATE`, [accountId]);
    }
  }

  /** Lock the charge row, then read it through `PostgresPosStore`. */
  async lockCharge(chargeId: string): Promise<PosCharge | null> {
    if (!UUID_PATTERN.test(chargeId)) {
      return null;
    }
    const locked = await this.#tx.query<{ id: string }>(
      `SELECT id FROM pos_charge WHERE id = $1 FOR UPDATE`,
      [chargeId],
    );
    if (locked.length === 0) {
      return null;
    }
    return (await this.#pos.findChargeForPayment({ chargeId })) ?? null;
  }

  /** The charge without a lock (`PosStore.findChargeForPayment`); a malformed id reads nothing. */
  async getCharge(chargeId: string): Promise<PosCharge | null> {
    return (await this.#pos.findChargeForPayment({ chargeId })) ?? null;
  }

  /** One payment with `FOR UPDATE`, or `null`. */
  async lockPayment(paymentId: string): Promise<ShopPayment | null> {
    return UUID_PATTERN.test(paymentId) ? this.#onePayment('id = $1 FOR UPDATE', paymentId) : null;
  }

  /** The payment's proofs in one `SELECT … ORDER BY id FOR UPDATE`; a malformed id locks nothing. */
  async lockProofs(paymentId: string): Promise<ShopProof[]> {
    if (!UUID_PATTERN.test(paymentId)) {
      return [];
    }
    const rows = await this.#tx.query<ProofSqlRow>(
      `SELECT ${PROOF_COLUMNS} FROM shop_proof WHERE payment_id = $1 ORDER BY id FOR UPDATE`,
      [paymentId],
    );
    return rows.map(mapProof);
  }

  /**
   * The payments' proofs in one `SELECT … ORDER BY id FOR UPDATE`, the ids
   * bound as one `uuid[]` literal; malformed ids are skipped, and none left
   * locks nothing.
   */
  async lockProofsOf(paymentIds: readonly string[]): Promise<ShopProof[]> {
    const ids = paymentIds.filter((id) => UUID_PATTERN.test(id));
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.#tx.query<ProofSqlRow>(
      `SELECT ${PROOF_COLUMNS} FROM shop_proof WHERE payment_id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [postgresTextArrayLiteral(ids)],
    );
    return rows.map(mapProof);
  }

  /** One quote with `FOR UPDATE`, or `null`. */
  async lockQuote(quoteId: string): Promise<ShopQuote | null> {
    return this.#oneQuote('FOR UPDATE', quoteId);
  }

  /** `PostgresPosStore.currentPending` on this transaction. */
  pendingCharge(accountId: string, nowMs: number): Promise<PosCharge | null> {
    return this.#pos.currentPending(accountId, nowMs);
  }

  /** `PostgresPosStore.create` under a savepoint; a unique violation becomes `false`. */
  async insertCharge(row: PosCharge): Promise<boolean> {
    return (await this.#guard(() => this.#pos.create(row))) !== CONFLICT;
  }

  /** `PostgresPosStore.cancelPending` on this transaction. */
  cancelPendingCharge(accountId: string, nowMs: number): Promise<PosCharge | null> {
    return this.#pos.cancelPending(accountId, nowMs);
  }

  /** `PostgresPosStore.markPaid` on this transaction. */
  markChargePaid(chargeId: string, paidAtMs: number): Promise<PosCharge | null> {
    return this.#pos.markPaid(chargeId, paidAtMs);
  }

  /** Id of the charge the hash is recorded against, or `null`. */
  async chargeIdForInvoice(paymentHash: string): Promise<string | null> {
    return (await this.#pos.findChargeForPayment({ paymentHash }))?.id ?? null;
  }

  /** `PostgresPosStore.deleteInvoice` on this transaction. */
  deleteChargeInvoice(paymentHash: string): Promise<void> {
    return this.#pos.deleteInvoice(paymentHash);
  }

  /** First payment matching `condition` (`$1` = `value`), or `null`. */
  async #onePayment(condition: string, value: string): Promise<ShopPayment | null> {
    const rows = await this.#tx.query<PaymentSqlRow>(
      `SELECT ${PAYMENT_COLUMNS} FROM shop_payment WHERE ${condition}`,
      [value],
    );
    const row = rows[0];
    return row === undefined ? null : mapPayment(row);
  }

  /** One payment by id, or `null`; a malformed id runs no query. */
  async getPayment(id: string): Promise<ShopPayment | null> {
    return UUID_PATTERN.test(id) ? this.#onePayment('id = $1', id) : null;
  }

  /** The account's `open` payment, or `null`. */
  async openPayment(accountId: string): Promise<ShopPayment | null> {
    return UUID_PATTERN.test(accountId)
      ? this.#onePayment(`account_id = $1 AND status = 'open'`, accountId)
      : null;
  }

  /** The charge's payment, or `null`. */
  async paymentForCharge(chargeId: string): Promise<ShopPayment | null> {
    return UUID_PATTERN.test(chargeId) ? this.#onePayment('pos_charge_id = $1', chargeId) : null;
  }

  /** The payment holding the hash, or `null`. */
  paymentForHash(paymentHash: string): Promise<ShopPayment | null> {
    return this.#onePayment('payment_hash = $1', paymentHash);
  }

  /** `INSERT … ON CONFLICT DO NOTHING RETURNING id`. */
  async insertPayment(row: ShopPayment): Promise<boolean> {
    const values = [
      row.id,
      row.accountId,
      row.amountSats,
      row.posChargeId,
      row.bolt11,
      row.paymentHash,
      row.bolt11ExpiresAt,
      row.status,
      row.endReason,
      row.windowEndsAt,
      row.replacements,
      row.nextSettleAt,
      row.nextHistoryAt,
      row.historyOffset,
      row.successorWaitUntil,
      row.createdAt,
      row.acceptedAt,
      row.paidAt,
      row.endedAt,
      row.closedAt,
    ];
    const rows = await this.#tx.query<{ id: string }>(
      `INSERT INTO shop_payment (${PAYMENT_COLUMNS})
VALUES (${placeholders(values.length)})
ON CONFLICT DO NOTHING
RETURNING id`,
      values.map(bind),
    );
    return rows.length > 0;
  }

  /** One conditional `UPDATE … RETURNING`. */
  async updatePayment(
    id: string,
    where: ShopPaymentWhere,
    patch: ShopPaymentPatch,
  ): Promise<ShopPayment | null> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }
    const params: unknown[] = [id];
    const sets = setList(PAYMENT_PATCH_COLUMNS, patch, params);
    const conditions = ['id = $1'];
    if (where.statuses !== undefined) {
      params.push(postgresTextArrayLiteral(where.statuses));
      conditions.push(`status = ANY($${params.length}::text[])`);
    }
    if (where.replacements !== undefined) {
      params.push(where.replacements);
      conditions.push(`replacements = $${params.length}`);
    }
    if (where.windowEndsAfter !== undefined) {
      params.push(bind(where.windowEndsAfter));
      conditions.push(`window_ends_at > $${params.length}`);
    }
    if (where.notClosed === true) {
      conditions.push('closed_at IS NULL');
    }
    const rows = await this.#tx.query<PaymentSqlRow>(
      `UPDATE shop_payment
SET ${sets}
WHERE ${conditions.join(' AND ')}
RETURNING ${PAYMENT_COLUMNS}`,
      params,
    );
    const row = rows[0];
    return row === undefined ? null : mapPayment(row);
  }

  /**
   * End lapsed `open` payments in one `UPDATE … RETURNING` whose rows are
   * first locked in the order of their ids
   * (`SELECT … ORDER BY id FOR UPDATE`), the order `lockPaymentsForProofs`
   * takes them in.
   */
  async endLapsedWindows(nowMs: number): Promise<ShopPayment[]> {
    const rows = await this.#tx.query<PaymentSqlRow>(
      `WITH due AS MATERIALIZED (
  SELECT id FROM shop_payment
  WHERE status = 'open' AND window_ends_at <= $1
  ORDER BY id
  FOR UPDATE
)
UPDATE shop_payment
SET status = 'ended', end_reason = 'window', ended_at = $1
WHERE id IN (SELECT id FROM due) AND status = 'open' AND window_ends_at <= $1
RETURNING ${PAYMENT_COLUMNS}`,
      [new Date(nowMs).toISOString()],
    );
    return rows.map(mapPayment);
  }

  /** Payments due for `duty` (see {@link PAYMENT_DUTY_SQL}). */
  async duePayments(duty: ShopPaymentDuty, nowMs: number, limit: number): Promise<ShopPayment[]> {
    const rows = await this.#tx.query<PaymentSqlRow>(
      `SELECT ${PAYMENT_COLUMNS} FROM shop_payment
WHERE ${PAYMENT_DUTY_SQL[duty]}
LIMIT $2`,
      [new Date(nowMs).toISOString(), limit],
    );
    return rows.map(mapPayment);
  }

  /** The account's payments that are neither `paid` nor closed, oldest first. */
  async unsettledPayments(accountId: string): Promise<ShopPayment[]> {
    if (!UUID_PATTERN.test(accountId)) {
      return [];
    }
    const rows = await this.#tx.query<PaymentSqlRow>(
      `SELECT ${PAYMENT_COLUMNS} FROM shop_payment
WHERE account_id = $1 AND status <> 'paid' AND closed_at IS NULL
ORDER BY created_at, id`,
      [accountId],
    );
    return rows.map(mapPayment);
  }

  /** Plain `INSERT`; a duplicate id raises 23505. */
  async insertQuote(row: ShopQuote): Promise<void> {
    await this.#tx.query(
      `INSERT INTO shop_quote (${QUOTE_COLUMNS}) VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [
        row.id,
        row.paymentId,
        bind(row.expiresAt),
        JSON.stringify(row.transferAmounts),
        bind(row.createdAt),
      ],
    );
  }

  /** `UPDATE shop_quote SET expires_at, transfer_amounts … RETURNING`. */
  async updateQuote(
    id: string,
    patch: Pick<ShopQuote, 'expiresAt' | 'transferAmounts'>,
  ): Promise<ShopQuote | null> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }
    const rows = await this.#tx.query<QuoteSqlRow>(
      `UPDATE shop_quote
SET expires_at = $2, transfer_amounts = $3::jsonb
WHERE id = $1
RETURNING ${QUOTE_COLUMNS}`,
      [id, bind(patch.expiresAt), JSON.stringify(patch.transferAmounts)],
    );
    const row = rows[0];
    return row === undefined ? null : mapQuote(row);
  }

  /** One quote by id with an optional lock suffix, or `null`. */
  async #oneQuote(suffix: string, id: string): Promise<ShopQuote | null> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }
    const rows = await this.#tx.query<QuoteSqlRow>(
      `SELECT ${QUOTE_COLUMNS} FROM shop_quote WHERE id = $1 ${suffix}`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? null : mapQuote(row);
  }

  /** One quote, or `null`. */
  getQuote(id: string): Promise<ShopQuote | null> {
    return this.#oneQuote('', id);
  }

  /** The payment's quotes by `created_at`, then `id`. */
  async quotesOf(paymentId: string): Promise<ShopQuote[]> {
    if (!UUID_PATTERN.test(paymentId)) {
      return [];
    }
    const rows = await this.#tx.query<QuoteSqlRow>(
      `SELECT ${QUOTE_COLUMNS} FROM shop_quote WHERE payment_id = $1 ORDER BY created_at, id`,
      [paymentId],
    );
    return rows.map(mapQuote);
  }

  /** One `INSERT … ON CONFLICT (deposit_address) DO NOTHING` per offer, in input order. */
  async insertOffers(rows: readonly ShopOffer[]): Promise<ShopOffer[]> {
    const inserted: ShopOffer[] = [];
    for (const row of rows) {
      const values = [
        row.id,
        row.quoteId,
        row.method,
        row.chainId,
        row.asset,
        row.tokenAddress,
        row.depositAddress,
        row.amountIn,
        row.requiredAmountIn,
        row.maxAcceptedAmountIn,
        row.decimals,
        row.minFee,
        row.providerRef,
        row.idempotencyKey,
        row.expiresAt,
        row.detailIssuedAt,
        row.createdAt,
      ];
      const stored = await this.#tx.query<{ id: string }>(
        `INSERT INTO shop_offer (${OFFER_COLUMNS})
VALUES (${placeholders(values.length)})
ON CONFLICT (deposit_address) DO NOTHING
RETURNING id`,
        values.map(bind),
      );
      if (stored.length > 0) {
        inserted.push(structuredClone(row));
      }
    }
    return inserted;
  }

  /** One offer, or `null`. */
  async getOffer(id: string): Promise<ShopOffer | null> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }
    const rows = await this.#tx.query<OfferSqlRow>(
      `SELECT ${OFFER_COLUMNS} FROM shop_offer WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? null : mapOffer(row);
  }

  /** The quote's offers by `created_at`, then `id` (no insertion-sequence column exists). */
  async offersOf(quoteId: string): Promise<ShopOffer[]> {
    if (!UUID_PATTERN.test(quoteId)) {
      return [];
    }
    const rows = await this.#tx.query<OfferSqlRow>(
      `SELECT ${OFFER_COLUMNS} FROM shop_offer WHERE quote_id = $1 ORDER BY created_at, id`,
      [quoteId],
    );
    return rows.map(mapOffer);
  }

  /** `UPDATE … WHERE detail_issued_at IS NULL`. */
  async markDetailIssued(offerId: string, atMs: number): Promise<boolean> {
    if (!UUID_PATTERN.test(offerId)) {
      return false;
    }
    const rows = await this.#tx.query<{ id: string }>(
      `UPDATE shop_offer SET detail_issued_at = $2
WHERE id = $1 AND detail_issued_at IS NULL
RETURNING id`,
      [offerId, new Date(atMs).toISOString()],
    );
    return rows.length > 0;
  }

  /** `INSERT … ON CONFLICT DO NOTHING RETURNING id`. */
  async insertProof(row: ShopProof): Promise<boolean> {
    const values = [
      row.id,
      row.offerId,
      row.paymentId,
      row.source,
      row.chainId,
      row.txHash,
      row.logIndex,
      row.userOpHash,
      row.rawHex,
      row.transferAmount,
      row.idempotencyKey,
      row.result,
      row.providerOrder,
      row.supersededByOrder,
      row.orderStatus,
      row.orderFoundAt,
      row.refusal,
      row.submitStopped,
      row.sentAt,
      row.lastSubmitAt,
      row.giveUpAt,
      row.nextSubmitAt,
      row.nextReceiptAt,
      row.nextStatusAt,
      row.tries,
      row.resolvedAt,
      row.createdAt,
    ];
    const rows = await this.#tx.query<{ id: string }>(
      `INSERT INTO shop_proof (${PROOF_COLUMNS})
VALUES (${placeholders(values.length)})
ON CONFLICT DO NOTHING
RETURNING id`,
      values.map(bind),
    );
    return rows.length > 0;
  }

  /** Proofs matching `condition`, oldest first. */
  async #proofs(condition: string, params: readonly unknown[]): Promise<ShopProof[]> {
    const rows = await this.#tx.query<ProofSqlRow>(
      `SELECT ${PROOF_COLUMNS} FROM shop_proof WHERE ${condition} ORDER BY created_at, id`,
      params,
    );
    return rows.map(mapProof);
  }

  /** One proof, or `null`. */
  async getProof(id: string): Promise<ShopProof | null> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }
    return (await this.#proofs('id = $1', [id]))[0] ?? null;
  }

  /** The payment's proofs, oldest first. */
  async proofsOf(paymentId: string): Promise<ShopProof[]> {
    return UUID_PATTERN.test(paymentId) ? this.#proofs('payment_id = $1', [paymentId]) : [];
  }

  /** Proofs matching `selector`, oldest first. */
  findProofs(selector: ShopProofSelector): Promise<ShopProof[]> {
    if ('providerOrder' in selector) {
      return this.#proofs('provider_order = $1', [selector.providerOrder]);
    }
    return 'txHash' in selector
      ? this.#proofs('chain_id = $1 AND tx_hash = $2', [selector.chainId, selector.txHash])
      : this.#proofs('chain_id = $1 AND user_op_hash = $2', [
          selector.chainId,
          selector.userOpHash,
        ]);
  }

  /** One conditional `UPDATE … RETURNING` under a savepoint. */
  async updateProof(
    id: string,
    where: ShopProofWhere,
    patch: ShopProofPatch,
  ): Promise<ShopProof | null | 'conflict'> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }
    const params: unknown[] = [id];
    const sets = setList(PROOF_PATCH_COLUMNS, patch, params);
    const conditions = ['id = $1'];
    if (where.results !== undefined) {
      params.push(
        postgresTextArrayLiteral(
          where.results.filter((result): result is ShopProofResult => result !== null),
        ),
      );
      const listed = `result = ANY($${params.length}::text[])`;
      conditions.push(where.results.includes(null) ? `(result IS NULL OR ${listed})` : listed);
    }
    if (where.lastSubmitAtOrBefore !== undefined) {
      params.push(bind(where.lastSubmitAtOrBefore));
      conditions.push(`(last_submit_at IS NULL OR last_submit_at <= $${params.length})`);
    }
    const rows = await this.#guard(() =>
      this.#tx.query<ProofSqlRow>(
        `UPDATE shop_proof
SET ${sets}
WHERE ${conditions.join(' AND ')}
RETURNING ${PROOF_COLUMNS}`,
        params,
      ),
    );
    if (rows === CONFLICT) {
      return 'conflict';
    }
    const row = rows[0];
    return row === undefined ? null : mapProof(row);
  }

  /** `DELETE FROM shop_proof WHERE id = $1`. */
  async deleteProof(id: string): Promise<void> {
    if (UUID_PATTERN.test(id)) {
      await this.#tx.query(`DELETE FROM shop_proof WHERE id = $1`, [id]);
    }
  }

  /** Proofs due for `duty` (see {@link PROOF_DUTY_SQL}). */
  async dueProofs(duty: ShopProofDuty, nowMs: number, limit: number): Promise<ShopProof[]> {
    const rows = await this.#tx.query<ProofSqlRow>(
      `SELECT ${PROOF_COLUMNS} FROM shop_proof
WHERE ${PROOF_DUTY_SQL[duty]}
LIMIT $2`,
      [new Date(nowMs).toISOString(), limit],
    );
    return rows.map(mapProof);
  }

  /** `count(*)` of every lookup row of the quote, done or not. */
  async countLookups(quoteId: string): Promise<number> {
    if (!UUID_PATTERN.test(quoteId)) {
      return 0;
    }
    const rows = await this.#tx.query<{ total: SqlInt }>(
      `SELECT count(*) AS total FROM shop_proof_lookup WHERE quote_id = $1`,
      [quoteId],
    );
    return Number(rows[0]?.total ?? 0);
  }

  /** `INSERT … ON CONFLICT DO NOTHING RETURNING id`. */
  async insertLookup(row: ShopProofLookup): Promise<boolean> {
    const values = [
      row.id,
      row.quoteId,
      row.method,
      row.asset,
      row.chainId,
      row.hash,
      row.nextTryAt,
      row.tries,
      row.doneAt,
      row.createdAt,
    ];
    const rows = await this.#tx.query<{ id: string }>(
      `INSERT INTO shop_proof_lookup (${LOOKUP_COLUMNS})
VALUES (${placeholders(values.length)})
ON CONFLICT DO NOTHING
RETURNING id`,
      values.map(bind),
    );
    return rows.length > 0;
  }

  /** The lookup of `(chainId, hash, quoteId)`, or `null`. */
  async findLookup(
    chainId: number,
    hash: string,
    quoteId: string,
  ): Promise<ShopProofLookup | null> {
    if (!UUID_PATTERN.test(quoteId)) {
      return null;
    }
    const rows = await this.#tx.query<LookupSqlRow>(
      `SELECT ${LOOKUP_COLUMNS} FROM shop_proof_lookup
WHERE chain_id = $1 AND hash = $2 AND quote_id = $3`,
      [chainId, hash, quoteId],
    );
    const row = rows[0];
    return row === undefined ? null : mapLookup(row);
  }

  /** `UPDATE … RETURNING` of the defined patch values. */
  async updateLookup(id: string, patch: ShopProofLookupPatch): Promise<ShopProofLookup | null> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }
    const params: unknown[] = [id];
    const sets = setList(LOOKUP_PATCH_COLUMNS, patch, params);
    const rows = await this.#tx.query<LookupSqlRow>(
      `UPDATE shop_proof_lookup SET ${sets} WHERE id = $1 RETURNING ${LOOKUP_COLUMNS}`,
      params,
    );
    const row = rows[0];
    return row === undefined ? null : mapLookup(row);
  }

  /** Open lookups due at `nowMs`, by `next_try_at`, then `id`. */
  async dueLookups(nowMs: number, limit: number): Promise<ShopProofLookup[]> {
    const rows = await this.#tx.query<LookupSqlRow>(
      `SELECT ${LOOKUP_COLUMNS} FROM shop_proof_lookup
WHERE done_at IS NULL AND next_try_at <= $1
ORDER BY next_try_at, id
LIMIT $2`,
      [new Date(nowMs).toISOString(), limit],
    );
    return rows.map(mapLookup);
  }
}

/**
 * Durable {@link ShopPaymentStore} on Postgres. Each transaction is one
 * `MergeDb.begin` (a reserved connection); every {@link ShopTx} call runs on
 * it, charge calls through a `PostgresPosStore` bound to the same
 * connection. Inserts that may lose a unique race use
 * `ON CONFLICT … DO NOTHING`, and `updateProof` and `insertCharge` run under
 * a savepoint, so a lost race never aborts the transaction.
 */
export class PostgresShopPaymentStore implements ShopPaymentStore {
  readonly #db: MergeDb;

  /**
   * Bind the store to the transaction port; each call runs on a `MergeDb`
   * transaction, not on the boot SQL client.
   *
   * @param _sql - The boot's SQL client (already migrated); every statement
   *   runs on `db` transactions instead.
   * @param db - Transaction port (`createBunDatabase(...).mergeDb`).
   */
  constructor(_sql: SqlClient, db: MergeDb) {
    this.#db = db;
  }

  /**
   * Run `run` in one Postgres transaction.
   *
   * @param run - Callback receiving the transaction.
   * @returns The callback result; a rejection rolls the transaction back.
   */
  transaction<T>(run: (tx: ShopTx) => Promise<T>): Promise<T> {
    return this.#db.begin((tx) => run(new PostgresShopTx(tx)));
  }
}
