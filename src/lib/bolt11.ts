import { createHash } from 'node:crypto';
import * as bolt11 from 'light-bolt11-decoder';

/**
 * Fields the spend-invoice path needs from a BOLT11 string.
 */
export interface DecodedBolt11 {
  /** 32-byte payment hash, lowercase hex. */
  paymentHash: string;
  /** Invoice amount in millisatoshis. */
  amountMsat: number;
}

/**
 * Operator-facing BOLT11 fields (description vs description_hash for NIP-57).
 */
export interface InspectedBolt11 {
  /** 32-byte payment hash, lowercase hex. */
  paymentHash: string;
  /** Invoice amount in millisatoshis. */
  amountMsat: number;
  /** Plaintext description when present (not description_hash). */
  description: string | null;
  /** 32-byte description hash, lowercase hex, when present. */
  descriptionHash: string | null;
  /** Expiry from the invoice, seconds, when present. */
  expirySeconds: number | null;
}

/** One tagged section from `light-bolt11-decoder`. */
interface Bolt11Section {
  name?: unknown;
  value?: unknown;
}

/**
 * Call `light-bolt11-decoder.decode` regardless of CJS default-vs-named interop.
 *
 * @param pr - BOLT11 string.
 * @returns Decoder result with `sections`.
 */
function libraryDecode(pr: string): { sections?: Bolt11Section[] } {
  return (bolt11 as { decode: (invoice: string) => { sections?: Bolt11Section[] } }).decode(pr);
}

/**
 * Decode sections with optional test inject; `null` when the library throws.
 *
 * @param pr - BOLT11 string.
 * @param decodeImpl - Optional decoder.
 * @returns Sections, or `null` on failure.
 */
function decodeSections(
  pr: string,
  decodeImpl?: (invoice: string) => { sections?: Bolt11Section[] },
): Bolt11Section[] | null {
  try {
    const decoded = (decodeImpl ?? libraryDecode)(pr);
    return decoded.sections ?? [];
  } catch {
    return null;
  }
}

/**
 * Read payment_hash + positive amount from sections, or `null`.
 *
 * @param sections - Decoded tagged sections.
 * @returns Hash and amount, or `null`.
 */
function paymentHashAndAmount(sections: Bolt11Section[]): DecodedBolt11 | null {
  const hashSection = sections.find((s) => s.name === 'payment_hash');
  const amountSection = sections.find((s) => s.name === 'amount');
  if (hashSection === undefined || typeof hashSection.value !== 'string') {
    return null;
  }
  const paymentHash = hashSection.value.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(paymentHash)) {
    return null;
  }
  if (amountSection === undefined) {
    return null;
  }
  const amountMsat = Number(amountSection.value);
  if (!Number.isInteger(amountMsat) || amountMsat <= 0) {
    return null;
  }
  return { paymentHash, amountMsat };
}

/**
 * Decode a BOLT11 payment request into payment hash and amount.
 *
 * Zero-amount invoices and malformed strings yield `null`. The caller maps
 * that to a 502 so provider failures stay collapsed.
 *
 * @param pr - BOLT11 string from the LNURL-pay callback.
 * @param decodeImpl - Optional decoder (tests inject a fake; production uses the library).
 * @returns Hash + amount, or `null` when decode fails.
 */
export function decodeBolt11(
  pr: string,
  decodeImpl?: (invoice: string) => { sections?: Bolt11Section[] },
): DecodedBolt11 | null {
  const sections = decodeSections(pr, decodeImpl);
  if (sections === null) {
    return null;
  }
  return paymentHashAndAmount(sections);
}

/**
 * Inspect a BOLT11 for payment hash, amount, and description fields.
 *
 * Malformed invoices yield `null`. Does not change {@link decodeBolt11}.
 *
 * @param pr - BOLT11 string.
 * @param decodeImpl - Optional decoder (tests inject a fake).
 * @returns Inspected fields, or `null` when decode fails.
 */
export function inspectBolt11(
  pr: string,
  decodeImpl?: (invoice: string) => { sections?: Bolt11Section[] },
): InspectedBolt11 | null {
  const sections = decodeSections(pr, decodeImpl);
  if (sections === null) {
    return null;
  }
  const core = paymentHashAndAmount(sections);
  if (core === null) {
    return null;
  }

  const descriptionSection = sections.find((s) => s.name === 'description');
  const description =
    descriptionSection !== undefined && typeof descriptionSection.value === 'string'
      ? descriptionSection.value
      : null;

  const hashSection = sections.find((s) => s.name === 'description_hash');
  let descriptionHash: string | null = null;
  if (hashSection !== undefined && typeof hashSection.value === 'string') {
    const hex = hashSection.value.toLowerCase();
    if (/^[0-9a-f]{64}$/.test(hex)) {
      descriptionHash = hex;
    }
  }

  const expirySection = sections.find((s) => s.name === 'expiry');
  let expirySeconds: number | null = null;
  if (expirySection !== undefined) {
    const expiry = Number(expirySection.value);
    if (Number.isInteger(expiry) && expiry >= 0) {
      expirySeconds = expiry;
    }
  }

  return {
    paymentHash: core.paymentHash,
    amountMsat: core.amountMsat,
    description,
    descriptionHash,
    expirySeconds,
  };
}

/**
 * NIP-57 invoice: description_hash equals sha256(utf8(zap request JSON)).
 *
 * @param descriptionHash - Lowercase hex hash from the invoice, or null.
 * @param zapRequestJson - Exact JSON string sent as `nostr=`, or null.
 * @returns Whether the invoice commits to that zap request.
 */
export function isNip57Invoice(
  descriptionHash: string | null,
  zapRequestJson: string | null,
): boolean {
  if (descriptionHash === null || zapRequestJson === null) {
    return false;
  }
  const digest = createHash('sha256').update(zapRequestJson, 'utf8').digest('hex');
  return digest === descriptionHash;
}
