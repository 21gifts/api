/**
 * Minimal BOLT11 encoder for the LNURL server stand-in: a mainnet invoice
 * (`lnbc`) with amount, payment hash, payment secret, description, expiry,
 * min-final-cltv, and feature bits, signed with secp256k1 over
 * `sha256(hrp || data)` as BOLT11 states. The api decodes it with
 * `light-bolt11-decoder` (`src/lib/bolt11.ts`).
 */

import { createHash, randomBytes } from 'node:crypto';
import { bech32 } from '@scure/base';
import { sign } from 'viem/accounts';

/** Node key of the stand-in's "wallet" (fixed test key, never funded). */
const NODE_KEY = `0x${'11'.repeat(32)}` as const;

/** BOLT11 tagged field codes (bech32 character values). */
const TAG = { p: 1, s: 16, d: 13, x: 6, c: 24, features: 5 } as const;

/** Big-endian 5-bit words of a non-negative integer, at least `minWords` long. */
function intWords(value: number, minWords = 1): number[] {
  const words: number[] = [];
  let rest = value;
  while (rest > 0) {
    words.unshift(rest & 31);
    rest = Math.floor(rest / 32);
  }
  while (words.length < minWords) {
    words.unshift(0);
  }
  return words;
}

/** One tagged field: type, 10-bit length, data words. */
function tagged(type: number, words: number[]): number[] {
  return [type, ...intWords(words.length, 2), ...words];
}

/** 5-bit words to bytes, zero-padded at the end (BOLT11 signing preimage). */
function wordsToPaddedBytes(words: number[]): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const word of words) {
    acc = (acc << 5) | word;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (bits > 0) {
    out.push((acc << (8 - bits)) & 0xff);
  }
  return Uint8Array.from(out);
}

/** A minted invoice. */
export interface MintedInvoice {
  pr: string;
  paymentHash: string;
  preimage: string;
  amountMsat: number;
  expirySeconds: number;
}

/**
 * Mint one signed BOLT11 for whole sats.
 *
 * @param amountMsat - Amount in millisats; must be a whole number of sats.
 * @param description - `d` field.
 * @param expirySeconds - `x` field.
 * @param nowSeconds - Timestamp field.
 * @returns The invoice (`pr`), its payment hash and preimage, its amount, and its expiry.
 * @throws Error when `amountMsat` is not a positive whole number of sats.
 */
export async function mintBolt11(
  amountMsat: number,
  description: string,
  expirySeconds: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<MintedInvoice> {
  if (!Number.isSafeInteger(amountMsat) || amountMsat <= 0 || amountMsat % 1000 !== 0) {
    throw new Error('amount must be whole sats');
  }
  const preimage = randomBytes(32);
  const paymentHash = createHash('sha256').update(preimage).digest();
  const secret = randomBytes(32);
  // 1 n (nano-bitcoin) is 0.1 sat.
  const hrp = `lnbc${(amountMsat / 1000) * 10}n`;
  const words = [
    ...intWords(nowSeconds, 7),
    ...tagged(TAG.p, bech32.toWords(paymentHash)),
    ...tagged(TAG.s, bech32.toWords(secret)),
    ...tagged(TAG.d, bech32.toWords(new TextEncoder().encode(description))),
    ...tagged(TAG.x, intWords(expirySeconds)),
    ...tagged(TAG.c, intWords(18)),
    // var_onion_optin (bit 8) and payment_secret (bit 14), both required.
    ...tagged(TAG.features, [16, 8, 0]),
  ];
  const preimageBytes = new Uint8Array([
    ...new TextEncoder().encode(hrp),
    ...wordsToPaddedBytes(words),
  ]);
  const digest = createHash('sha256').update(preimageBytes).digest('hex');
  const signature = await sign({ hash: `0x${digest}`, privateKey: NODE_KEY, to: 'object' });
  const sigBytes = new Uint8Array(65);
  sigBytes.set(Buffer.from(signature.r.slice(2).padStart(64, '0'), 'hex'), 0);
  sigBytes.set(Buffer.from(signature.s.slice(2).padStart(64, '0'), 'hex'), 32);
  sigBytes[64] = signature.yParity ?? 0;
  const pr = bech32.encode(hrp, [...words, ...bech32.toWords(sigBytes)], false);
  return {
    pr,
    paymentHash: paymentHash.toString('hex'),
    preimage: preimage.toString('hex'),
    amountMsat,
    expirySeconds,
  };
}
