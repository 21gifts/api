/** Secret material hidden inside an encoded invoice, address, or key. */

import { createHash } from 'node:crypto';
import { base58, bech32, bech32m } from '@scure/base';
import { bolt11Descriptions } from '@/lib/bolt11';
import { decodeProto } from '@/lib/protobuf';
import { looksLikeSecretValue } from '@/lib/secret-shape';

/** Shortest token worth decoding: a bech32 checksum alone is six characters. */
const ENCODED_TOKEN_MIN_LENGTH = 20;

/** Bytes as text: printable ASCII kept, every other byte a space. */
function printable(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) {
    text += byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ' ';
  }
  return text;
}

/** Payload bytes of a bech32 or bech32m token, or `null`. */
function payloadBytes(token: string): Uint8Array | null {
  for (const codec of [bech32m, bech32]) {
    try {
      const { words } = codec.decode(token as `${string}1${string}`, false);
      const bytes = codec.fromWordsUnsafe(words);
      if (bytes !== undefined) {
        return bytes;
      }
    } catch {
      // Not this checksum variant (or not bech32 at all); try the next one.
    }
  }
  return null;
}

/** Most bytes the protobuf walk may decode, as a multiple of the payload length (real Spark invoices nest 2–3 levels). */
const PROTO_WORK_FACTOR = 8;

/**
 * Text of every length-delimited protobuf field, repeated and nested ones
 * included at any depth, so a field's length byte never glues onto the first
 * word of its value. Walks an explicit stack; every nested value is strictly
 * shorter than its parent, so the walk ends.
 *
 * @returns The texts, or `null` when the walk would decode more than
 *   {@link PROTO_WORK_FACTOR} times the payload (pathological nesting; the
 *   caller then treats the value as secret material, fail-closed).
 */
function protoTexts(bytes: Uint8Array): string[] | null {
  const out: string[] = [];
  const pending: Uint8Array[] = [bytes];
  let budget = PROTO_WORK_FACTOR * bytes.length;
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    budget -= next.length;
    if (budget < 0) {
      return null;
    }
    let fields: ReturnType<typeof decodeProto>;
    try {
      fields = decodeProto(next);
    } catch {
      continue;
    }
    for (const field of fields) {
      if (field.wire === 2) {
        out.push(printable(field.value));
        pending.push(field.value);
      }
    }
  }
  return out;
}

/** True for a Base58Check WIF private key: version 0x80 or 0xef, 32-byte key, optional 0x01 flag. */
function isWifPrivateKey(token: string): boolean {
  if (token.length !== 51 && token.length !== 52) {
    return false;
  }
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(token);
  } catch {
    return false;
  }
  if (
    (bytes.length !== 37 && bytes.length !== 38) ||
    (bytes[0] !== 0x80 && bytes[0] !== 0xef) ||
    (bytes.length === 38 && bytes[33] !== 0x01)
  ) {
    return false;
  }
  const payload = bytes.subarray(0, bytes.length - 4);
  const check = createHash('sha256').update(createHash('sha256').update(payload).digest()).digest();
  return check.subarray(0, 4).equals(Buffer.from(bytes.subarray(bytes.length - 4)));
}

/** True when a text holds a key token, a recovery-phrase run, or a WIF private key token. */
function textHoldsSecret(text: string): boolean {
  return looksLikeSecretValue(text) || text.split(/[^A-Za-z0-9]+/).some(isWifPrivateKey);
}

/**
 * True when a value holds secret material, also inside an encoded token.
 *
 * Flags a key token, a recovery-phrase run, or a WIF private key (Base58Check)
 * in the value itself, and the same in every text decoded from it: for every
 * bech32 or bech32m token the whole payload plus every length-delimited
 * protobuf field on its own (every memo of a Spark address or invoice,
 * repeated and nested fields included at any depth; a token whose nesting
 * would cost more than eight times its payload to walk counts as secret, fail-closed), and every description tag of a BOLT11
 * token. An undecodable token is only screened by its visible text.
 *
 * @param value - Candidate string (a detail field, an event path, or a prop value).
 * @returns Whether `value` or anything encoded in it looks like secret material.
 */
export function containsEncodedSecret(value: string): boolean {
  if (textHoldsSecret(value)) {
    return true;
  }
  for (const token of value.split(/[^A-Za-z0-9]+/)) {
    if (token.length < ENCODED_TOKEN_MIN_LENGTH || !token.includes('1')) {
      continue;
    }
    // Bech32 rejects mixed case, but decoders that lower-case first (the Spark decoder) still read it.
    const lower = token.toLowerCase();
    const bytes = payloadBytes(lower);
    if (bytes !== null) {
      const nested = protoTexts(bytes);
      if (nested === null || [printable(bytes), ...nested].some(textHoldsSecret)) {
        return true;
      }
    }
    if (bolt11Descriptions(lower).some(textHoldsSecret)) {
      return true;
    }
  }
  return false;
}
