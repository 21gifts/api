/** Secret material hidden inside an encoded invoice, address, or key. */

import { createHash } from 'node:crypto';
import { base58, bech32, bech32m } from '@scure/base';
import { bolt11Descriptions } from '@/lib/bolt11';
import { decodeProto } from '@/lib/protobuf';
import { looksLikeSecretValue } from '@/lib/secret-shape';

/** Shortest token worth decoding: a bech32 checksum alone is six characters. */
const ENCODED_TOKEN_MIN_LENGTH = 20;

/** Deepest protobuf nesting that is walked (a Spark memo sits at depth 1). */
const MAX_PROTO_DEPTH = 4;

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

/**
 * Text of every length-delimited protobuf field, repeated and nested ones
 * included, so a field's length byte never glues onto the first word of its value.
 */
function protoTexts(bytes: Uint8Array, depth: number, out: string[]): void {
  if (depth > MAX_PROTO_DEPTH) {
    return;
  }
  let fields: ReturnType<typeof decodeProto>;
  try {
    fields = decodeProto(bytes);
  } catch {
    return;
  }
  for (const field of fields) {
    if (field.wire === 2) {
      out.push(printable(field.value));
      protoTexts(field.value, depth + 1, out);
    }
  }
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

/**
 * True when a value holds secret material, also inside an encoded token.
 *
 * Applies {@link looksLikeSecretValue} to the value itself; flags a WIF
 * private key token (Base58Check); and for every bech32 or bech32m token
 * screens the whole payload plus every length-delimited protobuf field in it
 * (every memo of a Spark address or invoice, repeated and nested fields
 * included), and every description tag of a BOLT11 token. An undecodable
 * token is only screened by its visible text.
 *
 * @param value - Candidate string (a detail field, an event path, or a prop value).
 * @returns Whether `value` or anything encoded in it looks like secret material.
 */
export function containsEncodedSecret(value: string): boolean {
  if (looksLikeSecretValue(value)) {
    return true;
  }
  for (const token of value.split(/[^A-Za-z0-9]+/)) {
    if (isWifPrivateKey(token)) {
      return true;
    }
    if (token.length < ENCODED_TOKEN_MIN_LENGTH || !token.includes('1')) {
      continue;
    }
    const bytes = payloadBytes(token);
    if (bytes !== null) {
      const texts = [printable(bytes)];
      protoTexts(bytes, 0, texts);
      if (texts.some((text) => looksLikeSecretValue(text))) {
        return true;
      }
    }
    if (bolt11Descriptions(token).some((description) => looksLikeSecretValue(description))) {
      return true;
    }
  }
  return false;
}
