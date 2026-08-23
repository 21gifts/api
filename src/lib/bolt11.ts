import decodeBolt11Lib from 'light-bolt11-decoder';

/**
 * Fields the spend-invoice path needs from a BOLT11 string.
 */
export interface DecodedBolt11 {
  /** 32-byte payment hash, lowercase hex. */
  paymentHash: string;
  /** Invoice amount in millisatoshis. */
  amountMsat: number;
}

/** One tagged section from `light-bolt11-decoder`. */
interface Bolt11Section {
  name?: unknown;
  value?: unknown;
}

const decoder = decodeBolt11Lib as (pr: string) => { sections?: Bolt11Section[] };

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
  let sections: Bolt11Section[];
  try {
    const decoded = (decodeImpl ?? decoder)(pr);
    sections = decoded.sections ?? [];
  } catch {
    return null;
  }

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
