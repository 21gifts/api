/**
 * Proof of a shop stablecoin payment (`docs/shop-stablecoin-payment.md`,
 * Proof): `GET /lnurlp/tx/:username`, the verification of `tx` and `hex`,
 * the one "Storing and submitting" step shared by the route and the
 * watcher, the Orchestra submit with its key rule, and the operator retry
 * of a `stuck` proof.
 *
 * Every row change runs in {@link ShopPaymentStore.transaction} under the
 * account row lock of the proof's payment. No transaction is held across an
 * RPC or Orchestra call.
 */

import type { Account } from '@/lib/auth/store';
import {
  evmGasPrice,
  evmGetTransactionByHash,
  evmGetTransactionReceipt,
  evmGetUserOperationReceipt,
  evmSendRawTransaction,
  type EvmLog,
} from '@/lib/evm-rpc';
import {
  decodeSignedEvmTransaction,
  decodeTransferLog,
  erc20TransferData,
  hexFeeReaches,
  recommendedMinFee,
  type DecodedEvmTransaction,
  type Erc20TransferLog,
} from '@/lib/evm-transfer';
import { logEvent, type LogFields } from '@/lib/log';
import type { OrchestraSubmitCaller } from '@/lib/orchestra';
import { normalizeHex32 } from '@/lib/proof';
import {
  SHOP_UNRESOLVED_LIMIT_MS,
  evaluateProof,
  recordProofOrder,
  refuseProof,
  shopError,
  shopMethodByName,
  shopResponse,
  type ShopMethod,
  type ShopPayments,
} from '@/lib/shop-payment';
import type {
  ShopOffer,
  ShopPayment,
  ShopProof,
  ShopProofPatch,
  ShopProofResult,
  ShopProofSource,
  ShopQuote,
  ShopTx,
} from '@/lib/shop-payment-store';
import { normalizeUuid } from '@/lib/uuid';

/** Whole budget of one proof request (below Tether's 20 s). */
export const SHOP_PROOF_BUDGET_MS = 18_000;
/** Timeout of each RPC call of a proof request. */
export const SHOP_RPC_TIMEOUT_MS = 3_000;
/** Longest Orchestra call of a proof request. */
export const SHOP_PROOF_ORCHESTRA_MS = 10_000;
/** Two submits of one proof are at least this far apart (the slot claim). */
export const SHOP_SUBMIT_SLOT_MS = 2_000;
/** Resubmits of one proof that repeats may trigger per minute. */
export const SHOP_REPEAT_SUBMITS_PER_MINUTE = 5;
/** Open lookup rows per quote. */
export const SHOP_MAX_LOOKUPS_PER_QUOTE = 4;
/** First lookup of a stored lookup row. */
export const SHOP_FIRST_LOOKUP_MS = 10_000;
/** First watcher submit of a stored proof. */
export const SHOP_FIRST_SUBMIT_MS = 10_000;
/** First watcher receipt read or resend of a proof without a log index. */
export const SHOP_FIRST_RECEIPT_MS = 30_000;
/** First order-status read after an order was found. */
export const SHOP_FIRST_STATUS_MS = 10_000;
/** A `hex` transaction still unknown this long after its first send is refused. */
export const SHOP_HEX_UNKNOWN_MS = 10 * 60_000;
/** Fewest hexadecimal characters of a `hex` proof (after an optional `0x`). */
export const SHOP_HEX_MIN_CHARS = 100;
/** Most hexadecimal characters of a `hex` proof (after an optional `0x`). */
export const SHOP_HEX_MAX_CHARS = 4096;

/** Text of the generic proof refusal. */
const NOT_ACCEPTED = 'Payment was not accepted';
/** Text of a deposit that another quote or offer already holds. */
const TX_USED = 'Transaction already used';
/** Text of an unresolved, held, or stuck proof. */
const BEING_CONFIRMED = 'Payment is being confirmed';
/** Text of an unknown or foreign quote. */
const QUOTE_EXPIRED = 'Quote expired';
/** Text of a request the rate limiter refused. */
const TOO_MANY = 'Too many requests';
/** Substrings of a send error that still count as sent once the node knows the hash. */
const SENT_ANYWAY = ['already known', 'nonce too low'];
/** Substrings of a send error that refuse the proof. */
const SEND_REJECTED = ['insufficient funds', 'invalid', 'intrinsic gas'];
/** Results a `tx_used` refusal may move a proof from (`accepted` is left to its order). */
const TX_USED_FROM: readonly (ShopProofResult | null)[] = [null, 'stuck', 'late', 'superseded'];

/** Query of `GET /lnurlp/tx/:username` as the route read it. */
export interface ShopProofQuery {
  /** `quote`, or `null`. */
  quote: string | null;
  /** `method`, or `null`. */
  method: string | null;
  /** `asset`, or `null`. */
  asset: string | null;
  /** `tx`, or `null`. */
  tx: string | null;
  /** `hex`, or `null`. */
  hex: string | null;
  /** `true` when `quote`, `method`, `asset`, `tx`, or `hex` appears more than once. */
  repeated: boolean;
}

/** A quote with its payment and offers. */
export interface ShopProofContext {
  /** The quote. */
  quote: ShopQuote;
  /** Its payment. */
  payment: ShopPayment;
  /** Every offer of the quote. */
  offers: ShopOffer[];
}

/** One deposit to store through {@link storeProof}. */
export interface ShopProofCandidate {
  /** The offer whose deposit address received the transfer. */
  offer: ShopOffer;
  /** The offer's payment. */
  paymentId: string;
  /** `tx`, `hex`, or `detected`. */
  source: ShopProofSource;
  /** Transaction hash, lowercase `0x` + 64 hex. */
  txHash: string;
  /** Transfer log index, or `null` (a `hex` or `detected` proof). */
  logIndex: number | null;
  /** User-operation hash the wallet sent, or `null`. */
  userOpHash: string | null;
  /** Signed transaction without `0x` (only `hex`). */
  rawHex: string | null;
  /** Transferred value in base units, or `null` while unknown. */
  transferAmount: string | null;
  /** The Orchestra order the orders duty found, or `null`. */
  order: { orderId: string; status: string } | null;
}

/** Result of {@link storeProof}. */
export interface StoredShopProof {
  /** The stored row (a new row, a repeat, or the row it was merged into). */
  proof: ShopProof;
  /** `true` when this call inserted the row. */
  created: boolean;
}

/** Result of {@link verifyTxProof}. */
export type ShopTxVerification =
  | { kind: 'not_found' }
  | { kind: 'failed' }
  | { kind: 'no_log' }
  | { kind: 'used' }
  | {
      kind: 'found';
      offer: ShopOffer;
      txHash: string;
      logIndex: number;
      transferAmount: string;
      userOpHash: string | null;
    };

/** Result of {@link verifyHexProof}. */
export type ShopHexVerification =
  { kind: 'invalid' } | { kind: 'unavailable' } | { kind: 'valid'; offer: ShopOffer };

/** Outcome of {@link sendHexProof}. */
export type ShopHexSendOutcome = 'sent' | 'rejected' | 'retry';

/** Outcome of {@link readProofReceipt}. */
export type ShopReceiptOutcome = 'filled' | 'pending' | 'failed' | 'mismatch' | 'error';

/** Result of {@link submitProofAttempt}. */
export interface ShopSubmitAttempt {
  /** The proof after the attempt, or `null` when it does not exist. */
  proof: ShopProof | null;
  /** `true` when an Orchestra submit was sent. */
  sent: boolean;
}

/** Proof submits that repeats triggered, per service and proof (epoch ms). */
const repeatSubmits = new WeakMap<ShopPayments, Map<string, number[]>>();

/**
 * Log one proof event with its ids (never a key, URL, raw hex, or BOLT11).
 *
 * @param event - Event name.
 * @param proof - The proof.
 * @param extra - Further fields.
 */
function proofLog(event: string, proof: ShopProof, extra: LogFields = {}): void {
  logEvent(event, {
    paymentId: proof.paymentId,
    proofId: proof.id,
    offerId: proof.offerId,
    ...extra,
  });
}

/**
 * Time left for one call: the call limit, cut to what remains of the deadline.
 *
 * @param shop - Service (clock).
 * @param deadlineMs - Absolute deadline.
 * @param limitMs - Longest call.
 * @returns Milliseconds, at least 1.
 */
function callTimeout(shop: ShopPayments, deadlineMs: number, limitMs: number): number {
  return Math.max(1, Math.min(limitMs, deadlineMs - shop.deps.now()));
}

/**
 * Lock the account of a payment inside `tx`.
 *
 * @param tx - Transaction.
 * @param paymentId - Payment id.
 */
async function lockPaymentAccount(tx: ShopTx, paymentId: string): Promise<void> {
  const payment = await tx.getPayment(paymentId);
  /* v8 ignore next 3 -- a proof's payment is a foreign key */
  if (payment === null) {
    return;
  }
  await tx.lockAccount(payment.accountId);
}

/**
 * Whether a proof is unresolved and may be submitted: no result, no order, no
 * stop after `409 quote_expired`, and for `hex` the transaction was sent.
 *
 * @param proof - Stored proof.
 * @returns `true` when a submit may run.
 */
function submittable(proof: ShopProof): boolean {
  return (
    proof.result === null &&
    proof.providerOrder === null &&
    !proof.submitStopped &&
    (proof.source !== 'hex' || proof.sentAt !== null)
  );
}

/**
 * The response for a stored proof (Storing and submitting, the response table).
 *
 * @param proof - Stored proof.
 * @returns 200 `{ txId }` when `accepted`; 400 with the result's text for
 *   `superseded`, `late`, `refunded`, `failed`, and `refused`; otherwise 503
 *   `Payment is being confirmed`.
 */
export function proofResponse(proof: ShopProof): Response {
  switch (proof.result) {
    case 'accepted':
      return shopResponse({ txId: proof.txHash }, 200);
    case 'superseded':
      return shopError(400, 'Another transfer is paying this payment');
    case 'late':
      return shopError(400, 'Invoice expired');
    case 'refunded':
      return shopError(400, 'The transfer was refunded');
    case 'failed':
      return shopError(400, 'The transfer was not completed');
    case 'refused':
      return shopError(400, proof.refusal === 'tx_used' ? TX_USED : NOT_ACCEPTED);
    default:
      return shopError(503, BEING_CONFIRMED);
  }
}

/**
 * Read a quote with its payment and offers.
 *
 * @param shop - Service.
 * @param quoteId - Lowercase quote id.
 * @returns The context, or `null` when the quote does not exist.
 */
export function shopProofContext(
  shop: ShopPayments,
  quoteId: string,
): Promise<ShopProofContext | null> {
  return shop.store.transaction(async (tx) => {
    const quote = await tx.getQuote(quoteId);
    if (quote === null) {
      return null;
    }
    const payment = await tx.getPayment(quote.paymentId);
    /* v8 ignore next 3 -- a quote's payment is a foreign key */
    if (payment === null) {
      return null;
    }
    return { quote, payment, offers: await tx.offersOf(quote.id) };
  });
}

/**
 * Offers of a method, and of an asset when one is given (matched without case).
 *
 * @param offers - Offers of a quote.
 * @param method - Table row of the method.
 * @param asset - Requested asset, or `null`.
 * @returns The matching offers.
 */
function offersFor(
  offers: readonly ShopOffer[],
  method: ShopMethod,
  asset: string | null,
): ShopOffer[] {
  return offers.filter(
    (offer) =>
      offer.method === method.method &&
      (asset === null || offer.asset.toLowerCase() === asset.toLowerCase()),
  );
}

/**
 * The transfer log of an offer in a receipt: the first log whose value equals
 * `amountIn`, else the first log to the offer's deposit address.
 *
 * @param logs - Receipt logs.
 * @param offer - The offer.
 * @returns The decoded transfer, or `undefined`.
 */
function offerTransfer(logs: readonly EvmLog[], offer: ShopOffer): Erc20TransferLog | undefined {
  const transfers = logs
    .map(decodeTransferLog)
    .filter(
      (transfer): transfer is Erc20TransferLog =>
        transfer !== null &&
        transfer.token === offer.tokenAddress &&
        transfer.to === offer.depositAddress,
    );
  const amount = BigInt(offer.amountIn);
  return transfers.find((transfer) => transfer.value === amount) ?? transfers[0];
}

/**
 * Verification of `tx` (contract steps 1, 3, 4, and 5): the transaction
 * receipt, else the ERC-4337 user-operation receipt; a failed transfer; the
 * `Transfer` log to an offer's deposit address that no proof of another
 * quote holds, preferring the log whose value is the offer's `amountIn`.
 * A failed RPC call counts as not found.
 *
 * @param shop - Service (fetch, clock).
 * @param input - Quote offers, method, asset, endpoint, hash, deadline, and call limit.
 * @returns `found` with the candidate log, or why the hash proves nothing yet.
 */
export async function verifyTxProof(
  shop: ShopPayments,
  input: {
    quoteOffers: readonly ShopOffer[];
    method: ShopMethod;
    asset: string | null;
    url: string;
    hash: string;
    deadlineMs: number;
    callLimitMs: number;
  },
): Promise<ShopTxVerification> {
  const { fetchImpl } = shop.deps;
  const receipt = await evmGetTransactionReceipt(
    input.url,
    fetchImpl,
    input.hash,
    callTimeout(shop, input.deadlineMs, input.callLimitMs),
  );
  if (!receipt.ok) {
    return { kind: 'not_found' };
  }
  let txHash: string;
  let success: boolean;
  let logs: EvmLog[];
  let userOpHash: string | null = null;
  if (receipt.value !== null) {
    txHash = receipt.value.transactionHash;
    success = receipt.value.status === '0x1';
    logs = receipt.value.logs;
  } else {
    if (input.deadlineMs - shop.deps.now() <= 0) {
      return { kind: 'not_found' };
    }
    const operation = await evmGetUserOperationReceipt(
      input.url,
      fetchImpl,
      input.hash,
      callTimeout(shop, input.deadlineMs, input.callLimitMs),
    );
    if (!operation.ok || operation.value === null) {
      return { kind: 'not_found' };
    }
    txHash = operation.value.transactionHash;
    success = operation.value.success === true;
    logs = operation.value.logs;
    userOpHash = input.hash;
  }
  if (!success) {
    return { kind: 'failed' };
  }
  const matches: { offer: ShopOffer; transfer: Erc20TransferLog }[] = [];
  for (const offer of offersFor(input.quoteOffers, input.method, input.asset)) {
    for (const log of logs) {
      const transfer = decodeTransferLog(log);
      if (
        transfer !== null &&
        transfer.token === offer.tokenAddress &&
        transfer.to === offer.depositAddress
      ) {
        matches.push({ offer, transfer });
      }
    }
  }
  if (matches.length === 0) {
    return { kind: 'no_log' };
  }
  const quoteOfferIds = new Set(input.quoteOffers.map((offer) => offer.id));
  const stored = await shop.store.transaction((tx) =>
    tx.findProofs({ chainId: input.method.chainId, txHash }),
  );
  const free = matches.filter(
    (match) =>
      !stored.some(
        (proof) => proof.logIndex === match.transfer.logIndex && !quoteOfferIds.has(proof.offerId),
      ),
  );
  const pick =
    free.find((match) => match.transfer.value === BigInt(match.offer.amountIn)) ?? free[0];
  if (pick === undefined) {
    return { kind: 'used' };
  }
  return {
    kind: 'found',
    offer: pick.offer,
    txHash,
    logIndex: pick.transfer.logIndex,
    transferAmount: pick.transfer.value.toString(),
    userOpHash,
  };
}

/**
 * Verification of `hex` (contract step 2): the method's chain id, an offer
 * contract of this quote and method as `to`, zero value, the offer's
 * transfer data byte for byte, the requested asset, and the fee against the
 * offer's `minFee` (EIP-1559 reads the current `eth_gasPrice`).
 *
 * @param shop - Service (fetch, clock).
 * @param input - Method offers, method, asset, endpoint, decoded transaction, deadline.
 * @returns `valid` with the offer, `invalid`, or `unavailable` when the gas
 *   price could not be read.
 */
export async function verifyHexProof(
  shop: ShopPayments,
  input: {
    quoteOffers: readonly ShopOffer[];
    method: ShopMethod;
    asset: string | null;
    url: string;
    decoded: DecodedEvmTransaction;
    deadlineMs: number;
  },
): Promise<ShopHexVerification> {
  const { decoded } = input;
  const offer = offersFor(input.quoteOffers, input.method, null).find(
    (row) => row.tokenAddress === decoded.to,
  );
  if (
    decoded.chainId !== input.method.chainId ||
    offer === undefined ||
    (input.asset !== null && input.asset.toLowerCase() !== offer.asset.toLowerCase()) ||
    decoded.value !== 0n ||
    decoded.data !== erc20TransferData(offer.depositAddress, BigInt(offer.amountIn))
  ) {
    return { kind: 'invalid' };
  }
  let current = 0n;
  if (decoded.type === 'eip1559') {
    const gas = await evmGasPrice(
      input.url,
      shop.deps.fetchImpl,
      callTimeout(shop, input.deadlineMs, SHOP_RPC_TIMEOUT_MS),
    );
    if (!gas.ok) {
      return { kind: 'unavailable' };
    }
    current = recommendedMinFee(gas.value, input.method.chainId);
  }
  return hexFeeReaches(decoded, BigInt(offer.minFee), current)
    ? { kind: 'valid', offer }
    : { kind: 'invalid' };
}

/**
 * Pick which of two rows of one deposit survives a merge: the `accepted`
 * row, else the row with an order, else the older row.
 *
 * @param a - One row (with its intended values).
 * @param b - The other row.
 * @returns `[keep, other]`.
 */
function keepOf(a: ShopProof, b: ShopProof): [ShopProof, ShopProof] {
  const rank = (row: ShopProof): number =>
    (row.result === 'accepted' ? 2 : 0) + (row.providerOrder === null ? 0 : 1);
  if (rank(a) !== rank(b)) {
    return rank(a) > rank(b) ? [a, b] : [b, a];
  }
  return a.createdAt.getTime() <= b.createdAt.getTime() ? [a, b] : [b, a];
}

/**
 * Step 3 and 4 of Storing and submitting: a row being filled in collides
 * with `holder`, which already holds the log index or the order. Another
 * offer's row: the filled row is `refused` with `tx_used`. The same offer:
 * the kept row takes every value of the other row it lacks, the other row is
 * deleted, then the values are written (the indexes are not deferrable).
 *
 * @param tx - Transaction (account locked).
 * @param filling - The row being filled in, as stored.
 * @param patch - What was being written onto it.
 * @param holder - The row that holds the value.
 * @param nowMs - Clock.
 * @returns The surviving row after evaluation.
 */
async function mergeDeposit(
  tx: ShopTx,
  filling: ShopProof,
  patch: ShopProofPatch,
  holder: ShopProof,
  nowMs: number,
): Promise<ShopProof> {
  if (holder.offerId !== filling.offerId) {
    const refused = await tx.updateProof(
      filling.id,
      { results: TX_USED_FROM },
      {
        result: 'refused',
        refusal: 'tx_used',
        resolvedAt: new Date(nowMs),
        nextSubmitAt: null,
        nextReceiptAt: null,
      },
    );
    if (refused === null || refused === 'conflict') {
      return filling;
    }
    proofLog('shop.proof.refused', refused, { refusal: 'tx_used' });
    return refused;
  }
  const intended: ShopProof = { ...filling, ...patch };
  const [keep, other] = keepOf(intended, holder);
  const merged: ShopProofPatch = {
    logIndex: keep.logIndex ?? other.logIndex,
    transferAmount: keep.transferAmount ?? other.transferAmount,
    userOpHash: keep.userOpHash ?? other.userOpHash,
    providerOrder: keep.providerOrder ?? other.providerOrder,
    orderStatus: keep.providerOrder === null ? other.orderStatus : keep.orderStatus,
    orderFoundAt: keep.orderFoundAt ?? other.orderFoundAt,
    nextStatusAt: keep.nextStatusAt ?? other.nextStatusAt,
  };
  if (merged.logIndex !== null) {
    merged.nextReceiptAt = null;
  }
  if (merged.providerOrder !== null) {
    merged.nextSubmitAt = null;
  }
  await tx.deleteProof(other.id);
  const written = await tx.updateProof(keep.id, {}, merged);
  /* v8 ignore next 3 -- the only other holder of these values was just deleted */
  if (written === null || written === 'conflict') {
    return keep;
  }
  /* v8 ignore next -- evaluateProof returns null only for a missing row */
  return (await evaluateProof(tx, written.id, nowMs)) ?? written;
}

/**
 * Fill values into a stored row and re-evaluate it; a unique conflict on the
 * log index merges the two rows of one deposit.
 *
 * @param tx - Transaction (account locked).
 * @param proof - Stored row.
 * @param patch - Values to fill in (`logIndex` and `transferAmount`, `userOpHash`).
 * @param nowMs - Clock.
 * @returns The row after the fill or merge.
 */
async function fillProof(
  tx: ShopTx,
  proof: ShopProof,
  patch: ShopProofPatch,
  nowMs: number,
): Promise<ShopProof> {
  const updated = await tx.updateProof(proof.id, {}, patch);
  if (updated === 'conflict') {
    const holder = (await tx.findProofs({ chainId: proof.chainId, txHash: proof.txHash })).find(
      (row) => row.id !== proof.id && row.logIndex === patch.logIndex,
    );
    /* v8 ignore next 3 -- a fill sets only the log index, so the log index clashed */
    if (holder === undefined) {
      return proof;
    }
    return mergeDeposit(tx, proof, patch, holder, nowMs);
  }
  /* v8 ignore next 3 -- the row was read in this transaction */
  if (updated === null) {
    return proof;
  }
  /* v8 ignore next -- evaluateProof returns null only for a missing row */
  return (await evaluateProof(tx, updated.id, nowMs)) ?? updated;
}

/**
 * Record an Orchestra order on a proof (`recordProofOrder`); when another
 * row already holds the order id, the rows are one deposit and merge, or the
 * newer one is refused with `tx_used` (steps 3 and 4).
 *
 * @param tx - Transaction (account of the payment locked).
 * @param proof - Stored proof.
 * @param order - Order id and status.
 * @param nowMs - Clock.
 * @returns The proof (or the row it merged into) after evaluation.
 */
export async function applyProofOrder(
  tx: ShopTx,
  proof: ShopProof,
  order: { orderId: string; status: string },
  nowMs: number,
): Promise<ShopProof> {
  const recorded = await recordProofOrder(tx, proof.id, order, nowMs);
  if (recorded !== 'conflict') {
    /* v8 ignore next -- the row was read in this transaction */
    return recorded ?? proof;
  }
  return mergeOrderHolder(tx, proof, order.orderId, order.status, nowMs);
}

/**
 * Merge a proof with the row that already holds an order id.
 *
 * @param tx - Transaction (account locked).
 * @param proof - The proof that was to take the order.
 * @param orderId - Order id.
 * @param status - The order status to write, or `null` to keep the proof's.
 * @param nowMs - Clock.
 * @returns The surviving row.
 */
async function mergeOrderHolder(
  tx: ShopTx,
  proof: ShopProof,
  orderId: string,
  status: string | null,
  nowMs: number,
): Promise<ShopProof> {
  const holder = (await tx.findProofs({ providerOrder: orderId })).find(
    (row) => row.id !== proof.id,
  );
  /* v8 ignore next 3 -- the conflict was on the order index */
  if (holder === undefined) {
    return proof;
  }
  return mergeDeposit(
    tx,
    proof,
    {
      providerOrder: orderId,
      orderStatus: status ?? proof.orderStatus,
      orderFoundAt: proof.orderFoundAt ?? new Date(nowMs),
      nextStatusAt: new Date(nowMs + SHOP_FIRST_STATUS_MS),
    },
    holder,
    nowMs,
  );
}

/**
 * Follow `supersededByOperationId`: the proof's order becomes the successor,
 * whose status the next status read fetches.
 *
 * @param tx - Transaction (account locked).
 * @param proof - Stored proof with an order.
 * @param successorId - The successor order id.
 * @param nowMs - Clock.
 * @returns The proof (or the row it merged into).
 */
export async function followProofOrder(
  tx: ShopTx,
  proof: ShopProof,
  successorId: string,
  nowMs: number,
): Promise<ShopProof> {
  const updated = await tx.updateProof(
    proof.id,
    {},
    { providerOrder: successorId, nextStatusAt: new Date(nowMs) },
  );
  if (updated === 'conflict') {
    return mergeOrderHolder(tx, proof, successorId, null, nowMs);
  }
  /* v8 ignore next -- the row was read in this transaction */
  return updated ?? proof;
}

/**
 * The one "Storing and submitting" step 1 (and 3/4 on a conflict), shared by
 * the route, the lookup duty, and the orders duty: a stored row of the same
 * offer and transaction is reused (filling in a missing log index, value,
 * user-operation hash, and order); otherwise a row is inserted with
 * `give_up_at` 24 h ahead. A lost insert answers from the winning row.
 * The submit (step 2) is the caller's.
 *
 * @param shop - Service (store, ids, clock).
 * @param candidate - The verified deposit.
 * @returns The stored row and whether this call inserted it.
 */
export function storeProof(
  shop: ShopPayments,
  candidate: ShopProofCandidate,
): Promise<StoredShopProof> {
  return shop.store.transaction(async (tx) => {
    const nowMs = shop.deps.now();
    await lockPaymentAccount(tx, candidate.paymentId);
    const { offer } = candidate;
    if (candidate.order !== null) {
      const [holder] = await tx.findProofs({ providerOrder: candidate.order.orderId });
      if (holder !== undefined) {
        return { proof: holder, created: false };
      }
    }
    const sameTx = await tx.findProofs({ chainId: offer.chainId, txHash: candidate.txHash });
    const sameOffer = sameTx.filter((row) => row.offerId === offer.id);
    const existing =
      candidate.logIndex === null
        ? (sameOffer.find((row) => row.logIndex === null) ?? sameOffer[0])
        : (sameOffer.find((row) => row.logIndex === candidate.logIndex) ??
          sameOffer.find((row) => row.logIndex === null));
    if (existing !== undefined) {
      const patch: ShopProofPatch = {};
      if (existing.logIndex === null && candidate.logIndex !== null) {
        patch.logIndex = candidate.logIndex;
        patch.transferAmount = candidate.transferAmount;
        patch.nextReceiptAt = null;
      }
      if (existing.userOpHash === null && candidate.userOpHash !== null) {
        patch.userOpHash = candidate.userOpHash;
      }
      let proof =
        Object.keys(patch).length === 0 ? existing : await fillProof(tx, existing, patch, nowMs);
      if (candidate.order !== null && proof.providerOrder === null) {
        proof = await applyProofOrder(tx, proof, candidate.order, nowMs);
      }
      return { proof, created: false };
    }
    const row: ShopProof = {
      id: shop.newId(),
      offerId: offer.id,
      paymentId: candidate.paymentId,
      source: candidate.source,
      chainId: offer.chainId,
      txHash: candidate.txHash,
      logIndex: candidate.logIndex,
      userOpHash: candidate.userOpHash,
      rawHex: candidate.rawHex,
      transferAmount: candidate.transferAmount,
      idempotencyKey: shop.newId(),
      result: null,
      providerOrder: null,
      orderStatus: null,
      orderFoundAt: null,
      refusal: null,
      submitStopped: false,
      sentAt: null,
      lastSubmitAt: null,
      giveUpAt: new Date(nowMs + SHOP_UNRESOLVED_LIMIT_MS),
      nextSubmitAt:
        candidate.source === 'hex' || candidate.order !== null
          ? null
          : new Date(nowMs + SHOP_FIRST_SUBMIT_MS),
      nextReceiptAt: candidate.logIndex === null ? new Date(nowMs + SHOP_FIRST_RECEIPT_MS) : null,
      nextStatusAt: null,
      tries: 0,
      resolvedAt: null,
      createdAt: new Date(nowMs),
    };
    if (!(await tx.insertProof(row))) {
      const winner = sameTx.find(
        (other) => other.logIndex !== null && other.logIndex === candidate.logIndex,
      );
      /* v8 ignore next 3 -- an unlogged row of the same offer was reused above, so only a log index clashes */
      if (winner === undefined) {
        throw new Error('shop proof insert lost without a winning row');
      }
      return { proof: winner, created: false };
    }
    proofLog(candidate.source === 'detected' ? 'shop.proof.detected' : 'shop.proof.stored', row, {
      quoteId: offer.quoteId,
      source: candidate.source,
    });
    const proof =
      candidate.order === null ? row : await applyProofOrder(tx, row, candidate.order, nowMs);
    return { proof, created: true };
  });
}

/**
 * Give a proof a new idempotency key (the key rule: after a definitive,
 * non-retryable answer a new attempt uses a new key).
 *
 * @param tx - Transaction.
 * @param shop - Service (ids).
 * @param proof - The proof as read in this transaction.
 * @returns The proof with its new key.
 */
async function rotateKey(tx: ShopTx, shop: ShopPayments, proof: ShopProof): Promise<ShopProof> {
  const rotated = await tx.updateProof(proof.id, {}, { idempotencyKey: shop.newId() });
  /* v8 ignore next -- the row was read in this transaction; a key change clashes with no index */
  return rotated === null || rotated === 'conflict' ? proof : rotated;
}

/**
 * One Orchestra submit of a proof, with the slot claim and the answer mapping
 * (Calls › Submit): claims the 2 s slot with a conditional update of
 * `last_submit_at`; an order is recorded (`recordProofOrder`, merge on an
 * order conflict); `xchain_deposit_mismatch` refuses; `409 quote_expired`
 * makes the proof `late` and stops submitting; a definitive unresolved
 * answer rotates the idempotency key.
 *
 * @param shop - Service.
 * @param proofId - Proof id.
 * @param caller - Budget share of the call.
 * @param deadlineMs - No submit starts at or after this instant; the call's
 *   timeout is the time left, at most {@link SHOP_PROOF_ORCHESTRA_MS}.
 * @returns The proof afterwards and whether a submit was sent.
 */
export async function submitProofAttempt(
  shop: ShopPayments,
  proofId: string,
  caller: OrchestraSubmitCaller,
  deadlineMs: number,
): Promise<ShopSubmitAttempt> {
  const { orchestra } = shop.deps;
  const claimMs = shop.deps.now();
  const claim = await shop.store.transaction(async (tx) => {
    const proof = await tx.getProof(proofId);
    if (proof === null) {
      return null;
    }
    if (orchestra === null || deadlineMs - claimMs <= 0 || !submittable(proof)) {
      return { proof, offer: null };
    }
    const claimed = await tx.updateProof(
      proof.id,
      { results: [null], lastSubmitAtOrBefore: new Date(claimMs - SHOP_SUBMIT_SLOT_MS) },
      { lastSubmitAt: new Date(claimMs) },
    );
    if (claimed === null || claimed === 'conflict') {
      return { proof, offer: null };
    }
    return { proof: claimed, offer: await tx.getOffer(claimed.offerId) };
  });
  if (claim === null) {
    return { proof: null, sent: false };
  }
  const { offer } = claim;
  if (orchestra === null || offer === null) {
    return { proof: claim.proof, sent: false };
  }
  const answer = await orchestra.submit(
    offer.providerRef,
    claim.proof.txHash,
    claim.proof.idempotencyKey,
    caller,
    callTimeout(shop, deadlineMs, SHOP_PROOF_ORCHESTRA_MS),
  );
  if (answer.kind === 'budget') {
    return { proof: claim.proof, sent: false };
  }
  proofLog('shop.proof.submitted', claim.proof, {
    providerRef: offer.providerRef,
    answer: answer.kind,
  });
  const proof = await shop.store.transaction(async (tx) => {
    const nowMs = shop.deps.now();
    await lockPaymentAccount(tx, claim.proof.paymentId);
    const current = await tx.getProof(proofId);
    if (current === null) {
      return null;
    }
    if (answer.kind === 'order') {
      if (current.providerOrder !== null) {
        return current;
      }
      return applyProofOrder(
        tx,
        current,
        { orderId: answer.orderId, status: answer.status },
        nowMs,
      );
    }
    if (current.result !== null || current.providerOrder !== null) {
      return current;
    }
    if (answer.kind === 'mismatch') {
      await refuseProof(tx, proofId, 'mismatch', nowMs);
      return rotateKey(tx, shop, current);
    }
    if (answer.kind === 'quote_expired') {
      const late = await tx.updateProof(
        proofId,
        { results: [null] },
        {
          result: 'late',
          submitStopped: true,
          resolvedAt: new Date(nowMs),
          nextSubmitAt: null,
          idempotencyKey: shop.newId(),
        },
      );
      /* v8 ignore next 3 -- checked unresolved above in this transaction */
      if (late === null || late === 'conflict') {
        return current;
      }
      proofLog('shop.proof.late', late);
      proofLog('shop.alert.late_deposit', late);
      return late;
    }
    proofLog('shop.proof.unresolved', current);
    return answer.retryable ? current : rotateKey(tx, shop, current);
  });
  return { proof, sent: true };
}

/**
 * Submit a proof to Orchestra once ({@link submitProofAttempt}).
 *
 * @param shop - Service.
 * @param proofId - Proof id.
 * @param caller - `proof-first`, `proof-repeat`, or `watcher`.
 * @param deadlineMs - No submit starts at or after this instant.
 * @returns The proof afterwards, or `null` when it does not exist.
 */
export async function submitProof(
  shop: ShopPayments,
  proofId: string,
  caller: OrchestraSubmitCaller,
  deadlineMs: number,
): Promise<ShopProof | null> {
  return (await submitProofAttempt(shop, proofId, caller, deadlineMs)).proof;
}

/**
 * Record a rejected or reverted `hex` transaction through `refuseProof`: the
 * proof becomes `refused` with `hex_rejected` from any result the States
 * table allows (an `accepted` proof included, which ends its payment with
 * `proof_refused`) and is no longer read or submitted.
 *
 * @param shop - Service.
 * @param proofId - Proof id.
 * @returns The proof afterwards, or `null` when it does not exist.
 */
export function refuseHexProof(shop: ShopPayments, proofId: string): Promise<ShopProof | null> {
  return shop.store.transaction(async (tx) => {
    const nowMs = shop.deps.now();
    const proof = await tx.getProof(proofId);
    if (proof === null) {
      return null;
    }
    await lockPaymentAccount(tx, proof.paymentId);
    const refused = await refuseProof(tx, proofId, 'hex_rejected', nowMs);
    if (refused?.result !== 'refused') {
      return refused;
    }
    const stopped = await tx.updateProof(proofId, {}, { nextReceiptAt: null });
    /* v8 ignore next -- the row was refused in this transaction */
    return stopped === null || stopped === 'conflict' ? refused : stopped;
  });
}

/**
 * Broadcast a stored `hex` proof (`eth_sendRawTransaction`). An error that
 * contains `already known` or `nonce too low` counts as sent once
 * `eth_getTransactionByHash` finds the hash; `insufficient funds`, `invalid`,
 * or `intrinsic gas` refuse the proof; anything else is retried later. A
 * first send sets `sent_at` and schedules the first watcher submit.
 *
 * @param shop - Service.
 * @param proof - Stored `hex` proof.
 * @param url - RPC endpoint of its chain.
 * @param timeoutMs - Timeout of each call.
 * @returns `sent`, `rejected`, or `retry`.
 */
export async function sendHexProof(
  shop: ShopPayments,
  proof: ShopProof,
  url: string,
  timeoutMs: number,
): Promise<ShopHexSendOutcome> {
  /* v8 ignore next 3 -- every hex row stores its raw transaction */
  if (proof.rawHex === null) {
    return 'retry';
  }
  const { fetchImpl } = shop.deps;
  const sent = await evmSendRawTransaction(url, fetchImpl, proof.rawHex, timeoutMs);
  let outcome: ShopHexSendOutcome = 'retry';
  if (sent.ok) {
    outcome = 'sent';
  } else if (sent.kind === 'rpc') {
    const message = sent.message.toLowerCase();
    if (SENT_ANYWAY.some((text) => message.includes(text))) {
      const known = await evmGetTransactionByHash(url, fetchImpl, proof.txHash, timeoutMs);
      outcome = known.ok && known.value ? 'sent' : 'retry';
    } else if (SEND_REJECTED.some((text) => message.includes(text))) {
      outcome = 'rejected';
    }
  }
  if (outcome === 'rejected') {
    await refuseHexProof(shop, proof.id);
    return outcome;
  }
  if (outcome === 'sent') {
    await shop.store.transaction(async (tx) => {
      const nowMs = shop.deps.now();
      const current = await tx.getProof(proof.id);
      if (current === null || current.sentAt !== null) {
        return;
      }
      await tx.updateProof(
        proof.id,
        {},
        {
          sentAt: new Date(nowMs),
          nextReceiptAt: new Date(nowMs + SHOP_FIRST_RECEIPT_MS),
          ...(submittable({ ...current, sentAt: new Date(nowMs) })
            ? { nextSubmitAt: new Date(nowMs + SHOP_FIRST_SUBMIT_MS) }
            : {}),
        },
      );
    });
  }
  return outcome;
}

/**
 * Read the receipt of a proof without a log index and fill in its log index
 * and value. A failed `hex` transaction is refused; a `detected` (or `hex`)
 * proof whose successful receipt has no transfer log to its offer, or whose
 * transaction failed, stays held, stops being read, and logs
 * `shop.alert.detected_mismatch`.
 *
 * @param shop - Service.
 * @param proof - Stored proof without a log index.
 * @param url - RPC endpoint of its chain.
 * @param timeoutMs - Timeout of the call.
 * @returns `filled`, `pending` (no receipt yet), `failed`, `mismatch`, or
 *   `error` (the call failed).
 */
export async function readProofReceipt(
  shop: ShopPayments,
  proof: ShopProof,
  url: string,
  timeoutMs: number,
): Promise<ShopReceiptOutcome> {
  const receipt = await evmGetTransactionReceipt(url, shop.deps.fetchImpl, proof.txHash, timeoutMs);
  if (!receipt.ok) {
    return 'error';
  }
  if (receipt.value === null) {
    return 'pending';
  }
  if (receipt.value.status !== '0x1' && proof.source === 'hex') {
    await refuseHexProof(shop, proof.id);
    return 'failed';
  }
  const logs = receipt.value.status === '0x1' ? receipt.value.logs : [];
  return shop.store.transaction(async (tx) => {
    const nowMs = shop.deps.now();
    await lockPaymentAccount(tx, proof.paymentId);
    const current = await tx.getProof(proof.id);
    const offer = await tx.getOffer(proof.offerId);
    /* v8 ignore next 3 -- the proof was just read; its offer is a foreign key */
    if (current === null || offer === null) {
      return 'error';
    }
    if (current.logIndex !== null) {
      return 'filled';
    }
    const transfer = offerTransfer(logs, offer);
    if (transfer === undefined) {
      await tx.updateProof(current.id, {}, { nextReceiptAt: null });
      proofLog('shop.alert.detected_mismatch', current, { source: current.source });
      return 'mismatch';
    }
    await fillProof(
      tx,
      current,
      {
        logIndex: transfer.logIndex,
        transferAmount: transfer.value.toString(),
        nextReceiptAt: null,
      },
      nowMs,
    );
    return 'filled';
  });
}

/**
 * Store a lookup row for a hash whose receipt was not found: at most
 * {@link SHOP_MAX_LOOKUPS_PER_QUOTE} open rows per quote, counted and
 * inserted under the quote's row lock. An existing row for the hash is kept.
 *
 * @param shop - Service.
 * @param quote - The quote.
 * @param method - Table row of the method.
 * @param asset - Requested asset, or `null`.
 * @param hash - Normalised hash.
 */
async function recordLookup(
  shop: ShopPayments,
  quote: ShopQuote,
  method: ShopMethod,
  asset: string | null,
  hash: string,
): Promise<void> {
  await shop.store.transaction(async (tx) => {
    const nowMs = shop.deps.now();
    await tx.lockQuote(quote.id);
    if ((await tx.findLookup(method.chainId, hash, quote.id)) !== null) {
      return;
    }
    if ((await tx.countOpenLookups(quote.id)) >= SHOP_MAX_LOOKUPS_PER_QUOTE) {
      return;
    }
    await tx.insertLookup({
      id: shop.newId(),
      quoteId: quote.id,
      method: method.method,
      asset,
      chainId: method.chainId,
      hash,
      nextTryAt: new Date(nowMs + SHOP_FIRST_LOOKUP_MS),
      tries: 0,
      doneAt: null,
      createdAt: new Date(nowMs),
    });
  });
}

/**
 * Close the open lookup row of a hash once its proof is stored.
 *
 * @param shop - Service.
 * @param chainId - Chain id.
 * @param hash - Normalised hash.
 * @param quoteId - Quote id.
 */
async function closeLookup(
  shop: ShopPayments,
  chainId: number,
  hash: string,
  quoteId: string,
): Promise<void> {
  await shop.store.transaction(async (tx) => {
    const lookup = await tx.findLookup(chainId, hash, quoteId);
    if (lookup !== null && lookup.doneAt === null) {
      await tx.updateLookup(lookup.id, { doneAt: new Date(shop.deps.now()) });
    }
  });
}

/** A parsed proof form. */
type ProofForm =
  | { kind: 'tx'; hash: string }
  | { kind: 'hex'; hash: string; rawHex: string; decoded: DecodedEvmTransaction };

/**
 * Parse `tx` or `hex` (Accepted forms). Exactly one must be present.
 *
 * @param query - Proof query.
 * @returns The form, or `null` when neither or both are present or the value is malformed.
 */
function parseProofForm(query: ShopProofQuery): ProofForm | null {
  if (query.tx !== null) {
    if (query.hex !== null) {
      return null;
    }
    const bare = /^0x/i.test(query.tx) ? query.tx.slice(2) : query.tx;
    const hash = normalizeHex32(bare);
    return hash === null ? null : { kind: 'tx', hash: `0x${hash}` };
  }
  const hex = query.hex;
  if (hex === null) {
    return null;
  }
  const raw = (/^0x/i.test(hex) ? hex.slice(2) : hex).toLowerCase();
  if (
    raw.length < SHOP_HEX_MIN_CHARS ||
    raw.length > SHOP_HEX_MAX_CHARS ||
    !/^([0-9a-f]{2})+$/.test(raw)
  ) {
    return null;
  }
  const decoded = decodeSignedEvmTransaction(raw);
  return decoded === null ? null : { kind: 'hex', hash: decoded.hash, rawHex: raw, decoded };
}

/**
 * The stored proof a request repeats: a proof of this quote's offers whose
 * `tx_hash` (or, for `tx`, `user_op_hash`) equals the hash. Several rows:
 * the `accepted` one, else the one whose offer's asset equals `asset`, else
 * the oldest.
 *
 * @param shop - Service.
 * @param context - Quote, payment, offers.
 * @param chainId - Method chain id.
 * @param form - Parsed proof form.
 * @param asset - Requested asset, or `null`.
 * @returns The row, or `null` when the request is no repeat.
 */
async function findRepeat(
  shop: ShopPayments,
  context: ShopProofContext,
  chainId: number,
  form: ProofForm,
  asset: string | null,
): Promise<ShopProof | null> {
  const offerIds = new Map(context.offers.map((offer) => [offer.id, offer]));
  const rows = await shop.store.transaction(async (tx) => {
    const byTx = await tx.findProofs({ chainId, txHash: form.hash });
    const byOp = form.kind === 'tx' ? await tx.findProofs({ chainId, userOpHash: form.hash }) : [];
    return [...byTx, ...byOp.filter((row) => !byTx.some((other) => other.id === row.id))];
  });
  const mine = rows
    .filter((row) => offerIds.has(row.offerId))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return (
    mine.find((row) => row.result === 'accepted') ??
    (asset === null
      ? undefined
      : mine.find(
          (row) => offerIds.get(row.offerId)?.asset.toLowerCase() === asset.toLowerCase(),
        )) ??
    mine[0] ??
    null
  );
}

/**
 * Whether a repeat may resubmit a proof now: at most
 * {@link SHOP_REPEAT_SUBMITS_PER_MINUTE} per minute per proof. Records the
 * submit when allowed.
 *
 * @param shop - Service.
 * @param proofId - Proof id.
 * @returns `true` when allowed.
 */
function allowRepeatSubmit(shop: ShopPayments, proofId: string): boolean {
  const nowMs = shop.deps.now();
  let byProof = repeatSubmits.get(shop);
  if (byProof === undefined) {
    byProof = new Map();
    repeatSubmits.set(shop, byProof);
  }
  for (const [id, times] of byProof) {
    const kept = times.filter((at) => at > nowMs - 60_000);
    if (kept.length === 0) {
      byProof.delete(id);
    } else {
      byProof.set(id, kept);
    }
  }
  const times = byProof.get(proofId) ?? [];
  if (times.length >= SHOP_REPEAT_SUBMITS_PER_MINUTE) {
    return false;
  }
  byProof.set(proofId, [...times, nowMs]);
  return true;
}

/**
 * Submit for a request: a new proof with `proof-first`; a repeat with
 * `proof-repeat` only when its slot is free (2 s) and the per-proof repeat
 * limit allows it.
 *
 * @param shop - Service.
 * @param proof - Stored proof.
 * @param created - Whether this request stored it.
 * @param deadlineMs - Request deadline.
 * @returns The proof afterwards.
 */
async function submitForRequest(
  shop: ShopPayments,
  proof: ShopProof,
  created: boolean,
  deadlineMs: number,
): Promise<ShopProof> {
  if (!submittable(proof)) {
    return proof;
  }
  if (!created) {
    const nowMs = shop.deps.now();
    if (
      (proof.lastSubmitAt !== null && nowMs - proof.lastSubmitAt.getTime() < SHOP_SUBMIT_SLOT_MS) ||
      !allowRepeatSubmit(shop, proof.id)
    ) {
      return proof;
    }
  }
  const after = await submitProof(
    shop,
    proof.id,
    created ? 'proof-first' : 'proof-repeat',
    deadlineMs,
  );
  /* v8 ignore next -- the proof was stored by this request or read just now */
  return after ?? proof;
}

/**
 * Re-read one proof.
 *
 * @param shop - Service.
 * @param proof - The proof as last seen.
 * @returns The stored row, or the given one when it was merged away.
 */
async function reread(shop: ShopPayments, proof: ShopProof): Promise<ShopProof> {
  return (await shop.store.transaction((tx) => tx.getProof(proof.id))) ?? proof;
}

/**
 * Bring a repeated row forward within the request's budget: read its receipt
 * once when it has no log index, send a `hex` transaction that was never
 * sent, and resubmit it when it is unresolved.
 *
 * @param shop - Service.
 * @param row - Stored row.
 * @param url - RPC endpoint.
 * @param deadlineMs - Request deadline.
 * @returns The row afterwards.
 */
async function bringForward(
  shop: ShopPayments,
  row: ShopProof,
  url: string,
  deadlineMs: number,
): Promise<ShopProof> {
  let proof = row;
  const left = (): number => deadlineMs - shop.deps.now();
  if (proof.logIndex === null && left() > 0) {
    await readProofReceipt(shop, proof, url, callTimeout(shop, deadlineMs, SHOP_RPC_TIMEOUT_MS));
    proof = await reread(shop, proof);
  }
  if (
    proof.source === 'hex' &&
    proof.sentAt === null &&
    proof.result === null &&
    proof.providerOrder === null &&
    left() > 0
  ) {
    await sendHexProof(shop, proof, url, callTimeout(shop, deadlineMs, SHOP_RPC_TIMEOUT_MS));
    proof = await reread(shop, proof);
  }
  return submitForRequest(shop, proof, false, deadlineMs);
}

/**
 * Read the quote of a proof request: it must be a quote of a shop payment of
 * this account, current or earlier, in any status.
 *
 * @param shop - Service.
 * @param account - The username's account.
 * @param raw - `quote` query value.
 * @returns The context, or `null` (answered **404** `Quote expired`).
 */
async function requestContext(
  shop: ShopPayments,
  account: Account,
  raw: string | null,
): Promise<ShopProofContext | null> {
  const quoteId = raw === null ? null : normalizeUuid(raw);
  if (quoteId === null) {
    return null;
  }
  const context = await shopProofContext(shop, quoteId);
  return context === null || context.payment.accountId !== account.id ? null : context;
}

/**
 * `GET /lnurlp/tx/:username` after the username and account checks and the
 * rate-limit count (Proof). A repeated key is **400**; a quote that is not a
 * quote of this account is **404** `Quote expired`; a missing or unknown
 * method or a malformed `tx` / `hex` is **400**. A stored proof of this
 * quote's offers with the same hash is a repeat: it is brought forward and
 * answered from its row. Otherwise `tx` and `hex` are verified, stored,
 * sent (`hex`), and submitted within {@link SHOP_PROOF_BUDGET_MS}.
 *
 * Over the rate limit only a stored row answers; anything else is **503**
 * `Too many requests`. Without shop configuration, or without an RPC
 * endpoint for the method's chain, a stored row is answered as it stands
 * and a new proof is **404** `Quote expired`.
 *
 * @param shop - Service.
 * @param account - The username's account.
 * @param _username - The username (the route already resolved it).
 * @param query - Proof query.
 * @param overLimit - `true` when the 120/min limiter refused the request.
 * @returns The response.
 */
export async function handleShopProof(
  shop: ShopPayments,
  account: Account,
  _username: string,
  query: ShopProofQuery,
  overLimit: boolean,
): Promise<Response> {
  const deadlineMs = shop.deps.now() + SHOP_PROOF_BUDGET_MS;
  const refuse = (status: number, text: string): Response =>
    overLimit ? shopError(503, TOO_MANY) : shopError(status, text);
  if (query.repeated) {
    return refuse(400, NOT_ACCEPTED);
  }
  const context = await requestContext(shop, account, query.quote);
  if (context === null) {
    return refuse(404, QUOTE_EXPIRED);
  }
  const method = query.method === null ? undefined : shopMethodByName(query.method);
  const form = parseProofForm(query);
  if (method === undefined || form === null) {
    return refuse(400, NOT_ACCEPTED);
  }
  const stored = await findRepeat(shop, context, method.chainId, form, query.asset);
  if (overLimit) {
    return stored === null ? shopError(503, TOO_MANY) : proofResponse(stored);
  }
  const url = shop.deps.config?.evmRpc.get(method.chainId);
  if (stored !== null) {
    return proofResponse(
      url === undefined ? stored : await bringForward(shop, stored, url, deadlineMs),
    );
  }
  if (url === undefined) {
    return shopError(404, QUOTE_EXPIRED);
  }
  return form.kind === 'tx'
    ? newTxProof(shop, context, method, query.asset, form.hash, url, deadlineMs)
    : newHexProof(shop, context, method, query.asset, form, url, deadlineMs);
}

/**
 * A `tx` proof that is not a repeat: verify, store, submit.
 *
 * @param shop - Service.
 * @param context - Quote context.
 * @param method - Table row of the method.
 * @param asset - Requested asset, or `null`.
 * @param hash - Normalised hash.
 * @param url - RPC endpoint.
 * @param deadlineMs - Request deadline.
 * @returns The response.
 */
async function newTxProof(
  shop: ShopPayments,
  context: ShopProofContext,
  method: ShopMethod,
  asset: string | null,
  hash: string,
  url: string,
  deadlineMs: number,
): Promise<Response> {
  const verified = await verifyTxProof(shop, {
    quoteOffers: context.offers,
    method,
    asset,
    url,
    hash,
    deadlineMs,
    callLimitMs: SHOP_RPC_TIMEOUT_MS,
  });
  switch (verified.kind) {
    case 'not_found':
      await recordLookup(shop, context.quote, method, asset, hash);
      return shopError(503, 'Transfer not found yet');
    case 'failed':
    case 'no_log':
      return shopError(400, NOT_ACCEPTED);
    case 'used':
      return shopError(400, TX_USED);
  }
  await closeLookup(shop, method.chainId, hash, context.quote.id);
  const { proof, created } = await storeProof(shop, {
    offer: verified.offer,
    paymentId: context.payment.id,
    source: 'tx',
    txHash: verified.txHash,
    logIndex: verified.logIndex,
    userOpHash: verified.userOpHash,
    rawHex: null,
    transferAmount: verified.transferAmount,
    order: null,
  });
  return proofResponse(await submitForRequest(shop, proof, created, deadlineMs));
}

/**
 * A `hex` proof that is not a repeat: verify, store with `raw_hex`, send,
 * submit.
 *
 * @param shop - Service.
 * @param context - Quote context.
 * @param method - Table row of the method.
 * @param asset - Requested asset, or `null`.
 * @param form - Parsed `hex` form.
 * @param url - RPC endpoint.
 * @param deadlineMs - Request deadline.
 * @returns The response.
 */
async function newHexProof(
  shop: ShopPayments,
  context: ShopProofContext,
  method: ShopMethod,
  asset: string | null,
  form: Extract<ProofForm, { kind: 'hex' }>,
  url: string,
  deadlineMs: number,
): Promise<Response> {
  const verified = await verifyHexProof(shop, {
    quoteOffers: context.offers,
    method,
    asset,
    url,
    decoded: form.decoded,
    deadlineMs,
  });
  if (verified.kind === 'invalid') {
    return shopError(400, NOT_ACCEPTED);
  }
  if (verified.kind === 'unavailable') {
    return shopError(503, BEING_CONFIRMED);
  }
  const { proof, created } = await storeProof(shop, {
    offer: verified.offer,
    paymentId: context.payment.id,
    source: 'hex',
    txHash: form.hash,
    logIndex: null,
    userOpHash: null,
    rawHex: form.rawHex,
    transferAmount: verified.offer.amountIn,
    order: null,
  });
  /* v8 ignore next 3 -- findRepeat already answered every row of this quote with this hash */
  if (!created) {
    return proofResponse(await bringForward(shop, proof, url, deadlineMs));
  }
  const outcome = await sendHexProof(
    shop,
    proof,
    url,
    callTimeout(shop, deadlineMs, SHOP_RPC_TIMEOUT_MS),
  );
  const current = await reread(shop, proof);
  if (outcome !== 'sent') {
    return proofResponse(current);
  }
  return proofResponse(await submitForRequest(shop, current, true, deadlineMs));
}

/**
 * Operator retry (`POST /debug/shop-proofs/:id/retry`): a `stuck` proof
 * becomes unresolved again, `give_up_at` moves 24 h ahead, the watcher
 * submits it on its next tick, and `shop.proof.retried` is logged.
 *
 * @param shop - Service.
 * @param proofId - Proof id (any case).
 * @returns `retried`, `not_stuck` when the proof is not `stuck`, or
 *   `not_found`.
 */
export function retryStuckProof(
  shop: ShopPayments,
  proofId: string,
): Promise<'retried' | 'not_stuck' | 'not_found'> {
  const id = normalizeUuid(proofId);
  if (id === null) {
    return Promise.resolve('not_found');
  }
  return shop.store.transaction(async (tx) => {
    const nowMs = shop.deps.now();
    const proof = await tx.getProof(id);
    if (proof === null) {
      return 'not_found';
    }
    await lockPaymentAccount(tx, proof.paymentId);
    const retried = await tx.updateProof(
      id,
      { results: ['stuck'] },
      {
        result: null,
        giveUpAt: new Date(nowMs + SHOP_UNRESOLVED_LIMIT_MS),
        tries: 0,
        ...(proof.source === 'hex' && proof.sentAt === null
          ? { nextSubmitAt: null, nextReceiptAt: new Date(nowMs) }
          : { nextSubmitAt: new Date(nowMs) }),
      },
    );
    if (retried === null || retried === 'conflict') {
      return 'not_stuck';
    }
    proofLog('shop.proof.retried', retried);
    return 'retried';
  });
}
