/**
 * Spark invoices for member-to-member zaps.
 *
 * A Spark invoice is a bech32m string (prefix `spark`) over a protobuf
 * `SparkAddress { 1: identity_public_key, 2: spark_invoice_fields }` without a
 * signature. Its memo names the payment hash of the zap invoice it stands in
 * for, so a settled Spark transfer can be turned into a zap receipt for that
 * invoice.
 */

import { bech32m, hex } from '@scure/base';
import { logEvent } from '@/lib/log';
import { concatBytes, protoBytesField, protoVarintField } from '@/lib/protobuf';
import type { ReceivingAddress } from '@/lib/receiving-address';
import type { SparkInvoiceStore } from '@/lib/spark-invoice-store';

/** Fields of one Spark invoice. */
export interface SparkInvoiceFields {
  /** Receiver's wallet identity public key (66 lower-case hex, compressed secp256k1). */
  identityPublicKey: string;
  /** 16-byte invoice id (UUIDv7). */
  id: Uint8Array;
  /** Memo; `zap:<payment hash>` for a zap. */
  memo: string;
  /** Amount in whole sats (a safe integer, 0 or more). */
  amountSats: number;
}

/** Spark invoice version written into `SparkInvoiceFields.version`. */
const SPARK_INVOICE_VERSION = 1;

/**
 * Serialise a Spark invoice to its bech32m string.
 *
 * `SparkInvoiceFields` is written in the canonical order `version (1)`,
 * `id (2)`, `memo (5)`, `sats_payment (4)`; that order is part of the
 * encoding the Spark operators accept and is not field-number order.
 *
 * @param fields - Receiver key, id, memo, and amount.
 * @returns `spark1…` string (bech32m, no length limit).
 * @throws Error when the key is not 33 bytes or the id is not 16 bytes.
 * @throws RangeError when `amountSats` is negative or not a safe integer.
 */
export function encodeSparkInvoice(fields: SparkInvoiceFields): string {
  const identity = hex.decode(fields.identityPublicKey);
  if (identity.byteLength !== 33) {
    throw new Error('Spark identity public key must be 33 bytes');
  }
  if (fields.id.byteLength !== 16) {
    throw new Error('Spark invoice id must be 16 bytes');
  }
  const invoiceFields = concatBytes(
    protoVarintField(1, SPARK_INVOICE_VERSION),
    protoBytesField(2, fields.id),
    protoBytesField(5, fields.memo),
    protoBytesField(4, protoVarintField(1, fields.amountSats)),
  );
  const address = concatBytes(protoBytesField(1, identity), protoBytesField(2, invoiceFields));
  return bech32m.encode('spark', bech32m.toWords(address), false);
}

/**
 * Build a UUIDv7 (RFC 9562): 48-bit Unix milliseconds, version 7, variant 10, random rest.
 *
 * @param nowMs - Clock in epoch milliseconds.
 * @param random - 10 random bytes (injected so tests are deterministic).
 * @returns 16 bytes.
 */
export function uuidV7(nowMs: number, random: Uint8Array): Uint8Array {
  const out = new Uint8Array(16);
  let ms = BigInt(nowMs);
  for (let i = 5; i >= 0; i -= 1) {
    out[i] = Number(ms & 0xffn);
    ms >>= 8n;
  }
  out.set(random.subarray(0, 10), 6);
  out[6] = 0x70 | ((random[0] ?? 0) & 0x0f);
  out[8] = 0x80 | ((random[2] ?? 0) & 0x3f);
  return out;
}

/** A zap invoice the payer may settle with a Spark transfer instead. */
export interface SparkZap {
  /** The zap BOLT11 (`pr`). */
  pr: string;
  /** Payment hash of `pr` (64 lower-case hex), or `null` when `pr` did not decode. */
  paymentHash: string | null;
  /** Amount of `pr` in millisats, or `null` when `pr` did not decode. */
  prAmountMsat: number | null;
  /** Amount in whole sats. */
  amountSats: number;
  /** Exact zap request string sent to the LNURL server as `nostr=`. */
  zapRequestJson: string;
}

/** Collaborators for {@link issueSparkInvoice}. */
export interface IssueSparkInvoiceDeps {
  /** Issued Spark invoices; omitted when the feature is off. */
  sparkInvoices?: SparkInvoiceStore;
  /** Clock in epoch milliseconds. */
  now: () => number;
  /** Random bytes; default `crypto.getRandomValues`. */
  randomBytes?: (length: number) => Uint8Array;
}

/**
 * Issue (or return the already issued) Spark invoice for a zap invoice.
 *
 * Returns `null` without writing when the feature is off (`sparkInvoices`
 * omitted), the receiver is not wallet-backed, the payment hash is unknown, or
 * the amount of `pr` is not `amountSats` (the receipt credits the amount of
 * `pr`, so the Spark invoice must charge the same). One payment hash has at most one
 * Spark invoice; a second call returns the stored string. A store failure logs
 * `spark.invoice.issue_failed` and resolves `null` so the caller still returns `pr`.
 *
 * @param deps - Store, clock, and optional randomness.
 * @param receiving - Receiver's address from `receivingAddress`.
 * @param zap - Zap invoice, payment hash, amount, and zap request string.
 * @returns `spark1…` string, or `null`.
 */
export async function issueSparkInvoice(
  deps: IssueSparkInvoiceDeps,
  receiving: ReceivingAddress,
  zap: SparkZap,
): Promise<string | null> {
  const store = deps.sparkInvoices;
  const paymentHash = zap.paymentHash;
  if (
    store === undefined ||
    receiving.kind !== 'wallet' ||
    paymentHash === null ||
    zap.prAmountMsat !== zap.amountSats * 1000
  ) {
    return null;
  }
  const randomBytes =
    deps.randomBytes ?? ((length: number) => crypto.getRandomValues(new Uint8Array(length)));
  const nowMs = deps.now();
  const invoice = encodeSparkInvoice({
    identityPublicKey: receiving.sparkPubkey,
    id: uuidV7(nowMs, randomBytes(10)),
    memo: `zap:${paymentHash}`,
    amountSats: zap.amountSats,
  });
  try {
    return await store.issue({
      paymentHash,
      invoice,
      receiverPubkey: receiving.sparkPubkey,
      amountSats: zap.amountSats,
      bolt11: zap.pr,
      zapRequest: zap.zapRequestJson,
      createdAt: new Date(nowMs),
    });
  } catch {
    logEvent('spark.invoice.issue_failed');
    return null;
  }
}
