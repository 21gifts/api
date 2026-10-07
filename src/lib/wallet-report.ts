/** Allowlisted parsing for wallet balance and payment reports. */

import { parseClientInstant } from '@/lib/client-instant';
import { looksLikeSecretValue } from '@/lib/secret-shape';

/** Maximum payment entries accepted in one wallet report. */
export const WALLET_REPORT_PAYMENTS_MAX = 200;

/** Largest accepted whole-satoshi value: 21 million bitcoin. */
export const MAX_SATS = 2_100_000_000_000_000;

/** Direction of a reported wallet payment. */
export type WalletPaymentDirection = 'in' | 'out';

/** Settlement state of a reported wallet payment. */
export type WalletPaymentStatus = 'pending' | 'completed' | 'failed';

/** One validated, secret-filtered payment from a wallet report. */
export interface ReportedWalletPayment {
  /** Wallet-local stable payment id. */
  paymentId: string;
  /** Whether value entered or left the wallet. */
  direction: WalletPaymentDirection;
  /** Current wallet settlement state. */
  status: WalletPaymentStatus;
  /** Payment amount in whole sats. */
  amountSats: number;
  /** Wallet fee in whole sats. */
  feeSats: number;
  /** Client-reported payment instant. */
  paidAt: Date;
  /** Lower-case wallet method identifier. */
  method: string;
  /** BOLT11 payment hash when safely supplied. */
  paymentHash: string | null;
  /** Invoice string when safely supplied. */
  invoice: string | null;
  /** Payment destination when safely supplied. */
  destination: string | null;
  /** Wallet description when safely supplied. */
  description: string | null;
  /** LNURL comment when safely supplied. */
  lnurlComment: string | null;
}

/** Fully parsed wallet report plus the count of rejected payment entries. */
export interface ParsedWalletReport {
  /** Wallet balance in whole sats. */
  balanceSats: number;
  /** Client sync instant. */
  syncedAt: Date;
  /** Valid payment entries, in request order. */
  payments: ReportedWalletPayment[];
  /** Number of invalid payment entries omitted from `payments`. */
  skipped: number;
}

/** True when `value` holds a C0 control character or DEL. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

const METHOD = /^[a-z][a-z0-9_]{0,31}$/;
const PAYMENT_HASH = /^[0-9a-f]{64}$/;

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function sats(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SATS
    ? value
    : null;
}

function safeDetail(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (
    trimmed === '' ||
    trimmed.length > maxLength ||
    hasControlCharacter(trimmed) ||
    looksLikeSecretValue(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function parsePayment(value: unknown, nowMs: number): ReportedWalletPayment | null {
  if (!plainObject(value)) {
    return null;
  }
  const rawId = value['id'];
  if (typeof rawId !== 'string') {
    return null;
  }
  const paymentId = rawId.trim();
  if (
    paymentId.length < 1 ||
    paymentId.length > 256 ||
    hasControlCharacter(paymentId) ||
    looksLikeSecretValue(paymentId)
  ) {
    return null;
  }
  const direction = value['direction'];
  if (direction !== 'in' && direction !== 'out') {
    return null;
  }
  const status = value['status'];
  if (status !== 'pending' && status !== 'completed' && status !== 'failed') {
    return null;
  }
  const amountSats = sats(value['amountSats']);
  if (amountSats === null) {
    return null;
  }
  const rawFee = value['feeSats'];
  const feeSats = rawFee === undefined || rawFee === null ? 0 : sats(rawFee);
  if (feeSats === null) {
    return null;
  }
  const paidAt = parseClientInstant(value['timestamp'], nowMs);
  if (paidAt === null) {
    return null;
  }
  const rawMethod = value['method'];
  if (typeof rawMethod !== 'string') {
    return null;
  }
  const method = rawMethod.toLowerCase();
  if (!METHOD.test(method)) {
    return null;
  }
  const rawPaymentHash = safeDetail(value['paymentHash'], 64);
  const paymentHash =
    rawPaymentHash !== null && PAYMENT_HASH.test(rawPaymentHash.toLowerCase())
      ? rawPaymentHash.toLowerCase()
      : null;
  return {
    paymentId,
    direction,
    status,
    amountSats,
    feeSats,
    paidAt,
    method,
    paymentHash,
    invoice: safeDetail(value['invoice'], 4096),
    destination: safeDetail(value['destination'], 512),
    description: safeDetail(value['description'], 640),
    lnurlComment: safeDetail(value['lnurlComment'], 640),
  };
}

/**
 * Parse an untrusted wallet report with report-level rejection and per-payment skipping.
 *
 * @param body - Parsed JSON value supplied by the client.
 * @param nowMs - Server clock used to bound client timestamps.
 * @returns A parsed report, or `{ ok: false }` when the report envelope is invalid.
 */
export function parseWalletReport(
  body: unknown,
  nowMs: number,
): { ok: true; report: ParsedWalletReport } | { ok: false } {
  if (!plainObject(body)) {
    return { ok: false };
  }
  const balanceSats = sats(body['balanceSats']);
  const syncedAt = parseClientInstant(body['syncedAt'], nowMs);
  if (balanceSats === null || syncedAt === null) {
    return { ok: false };
  }
  const rawPayments = body['payments'];
  if (rawPayments !== undefined && !Array.isArray(rawPayments)) {
    return { ok: false };
  }
  const paymentValues: readonly unknown[] = rawPayments ?? [];
  if (paymentValues.length > WALLET_REPORT_PAYMENTS_MAX) {
    return { ok: false };
  }
  const payments: ReportedWalletPayment[] = [];
  let skipped = 0;
  for (const value of paymentValues) {
    const payment = parsePayment(value, nowMs);
    if (payment === null) {
      skipped += 1;
    } else {
      payments.push(payment);
    }
  }
  return { ok: true, report: { balanceSats, syncedAt, payments, skipped } };
}
