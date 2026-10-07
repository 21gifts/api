/** Secret material hidden inside an encoded invoice or address. */

import { bech32, bech32m } from '@scure/base';
import { bolt11Descriptions } from '@/lib/bolt11';
import { looksLikeSecretValue } from '@/lib/secret-shape';

/** Shortest token worth decoding: a bech32 checksum alone is six characters. */
const ENCODED_TOKEN_MIN_LENGTH = 20;

/** Payload bytes of a bech32 or bech32m token as text: printable ASCII kept, every other byte a space. */
function payloadText(token: string): string | null {
  for (const codec of [bech32m, bech32]) {
    try {
      const { words } = codec.decode(token as `${string}1${string}`, false);
      const bytes = codec.fromWordsUnsafe(words);
      if (bytes === undefined) {
        continue;
      }
      let text = '';
      for (const byte of bytes) {
        text += byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ' ';
      }
      return text;
    } catch {
      // Not this checksum variant (or not bech32 at all); try the next one.
    }
  }
  return null;
}

/**
 * True when a value holds secret material, also inside an encoded token.
 *
 * Applies {@link looksLikeSecretValue} to the value itself, to the payload bytes
 * of every bech32 or bech32m token in it (a Spark address or invoice with any
 * number of memo fields, an LNURL), and to every description tag of a BOLT11
 * token. An undecodable token is only screened by its visible text.
 *
 * @param value - Candidate string (a detail field, an event path, or a prop value).
 * @returns Whether `value` or anything encoded in it looks like secret material.
 */
export function containsEncodedSecret(value: string): boolean {
  if (looksLikeSecretValue(value)) {
    return true;
  }
  for (const token of value.split(/[^A-Za-z0-9]+/)) {
    if (token.length < ENCODED_TOKEN_MIN_LENGTH || !token.includes('1')) {
      continue;
    }
    const text = payloadText(token);
    if (text !== null && looksLikeSecretValue(text)) {
      return true;
    }
    if (bolt11Descriptions(token).some((description) => looksLikeSecretValue(description))) {
      return true;
    }
  }
  return false;
}
