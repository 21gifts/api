/** Encode and decode Spark addresses and invoices for the wallet identity fields used by the api. */

import { bech32m, hex } from '@scure/base';
import { decodeProto, protoBytesField, type ProtoField } from '@/lib/protobuf';

const SPARK_HRPS = new Set([
  'spark',
  'sparkrt',
  'sparkt',
  'sparks',
  'sparkl',
  'sp',
  'sprt',
  'spt',
  'sps',
  'spl',
]);

/** Identity fields recovered from a Spark address or Spark invoice. */
export interface DecodedSparkAddress {
  /** Compressed Spark identity public key as 66 lower-case hex characters. */
  identityPublicKey: string;
  /** Invoice memo, or `null` for an address or memo-less invoice. */
  memo: string | null;
}

/** A length-delimited protobuf field. */
type BytesField = Extract<ProtoField, { wire: 2 }>;

/**
 * Encode a wallet identity public key as its mainnet Spark address.
 *
 * The address is bech32m (prefix `spark`) over a protobuf
 * `SparkAddress { 1: identity_public_key }` with no invoice fields and no
 * signature, so it is a pure function of the key.
 *
 * @param identityPublicKey - Compressed Spark identity public key as 66 hex characters.
 * @returns `spark1…` address (68 characters).
 * @throws Error when the key is not 33 bytes of hex.
 */
export function encodeSparkAddress(identityPublicKey: string): string {
  const identity = hex.decode(identityPublicKey);
  if (identity.byteLength !== 33) {
    throw new Error('Spark identity public key must be 33 bytes');
  }
  return bech32m.encode('spark', bech32m.toWords(protoBytesField(1, identity)), false);
}

/**
 * Decode a Spark address or invoice without throwing on malformed input.
 *
 * @param text - Candidate bech32m Spark address or invoice.
 * @returns Its identity public key and optional memo, or `null` on any failure.
 */
export function decodeSparkAddress(text: string): DecodedSparkAddress | null {
  try {
    const normalised = text.trim().toLowerCase();
    const decoded = bech32m.decode(normalised as `${string}1${string}`, false);
    if (!SPARK_HRPS.has(decoded.prefix)) {
      return null;
    }
    const fields = decodeProto(bech32m.fromWords(decoded.words));
    const identity = fields.find(
      (field): field is BytesField => field.field === 1 && field.wire === 2,
    );
    if (identity === undefined || identity.value.byteLength !== 33) {
      return null;
    }
    const invoice = fields.find(
      (field): field is BytesField => field.field === 2 && field.wire === 2,
    );
    let memo: string | null = null;
    if (invoice !== undefined) {
      const invoiceFields = decodeProto(invoice.value);
      const memoField = invoiceFields.find(
        (field): field is BytesField => field.field === 5 && field.wire === 2,
      );
      if (memoField !== undefined) {
        memo = new TextDecoder('utf-8', { fatal: true }).decode(memoField.value);
      }
    }
    return { identityPublicKey: hex.encode(identity.value), memo };
  } catch {
    return null;
  }
}
