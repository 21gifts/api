/**
 * Minimal BOLT11 encoder for the loan-cycle LNURL stand-in.
 *
 * The invoice is bookkeeping for a Spark payment: amount, payment hash, and
 * description hash must decode. A zero signature is enough when the decoder
 * does not check it; `selfCheck` fails the run if this build does not decode.
 */
import { createHash, randomBytes } from 'node:crypto';
import { bech32 } from '@scure/base';

/**
 * @param {number} amountSats
 * @param {Uint8Array} paymentHash
 * @param {Uint8Array} descriptionHash
 * @param {number} timestamp
 * @param {number} expirySeconds
 * @returns {string}
 */
export function encodeBolt11({
  amountSats,
  paymentHash,
  descriptionHash,
  timestamp,
  expirySeconds,
}) {
  if (!Number.isInteger(amountSats) || amountSats < 1) {
    throw new Error('bolt11 amount must be a positive integer');
  }
  if (paymentHash.byteLength !== 32 || descriptionHash.byteLength !== 32) {
    throw new Error('bolt11 hashes must be 32 bytes');
  }
  const bits = [];
  pushBig(bits, BigInt(timestamp), 35n);
  writeTag(bits, 1, paymentHash);
  writeTag(bits, 23, descriptionHash);
  writeTag(bits, 6, minimalBytes(expirySeconds));
  for (let i = 0; i < 65 * 8; i += 1) {
    bits.push(0);
  }
  if (bits.length % 5 !== 0) {
    throw new Error('bolt11 bit length is not word-aligned');
  }
  const words = [];
  for (let i = 0; i < bits.length; i += 5) {
    words.push(
      (bits[i] << 4) | (bits[i + 1] << 3) | (bits[i + 2] << 2) | (bits[i + 3] << 1) | bits[i + 4],
    );
  }
  return bech32.encode(`lnbc${amountSats * 10}n`, words, 2000);
}

/**
 * @param {string} zapRequestJson
 * @param {number} amountMsat
 * @returns {string}
 */
export function invoiceForZap(zapRequestJson, amountMsat) {
  if (!Number.isInteger(amountMsat) || amountMsat < 1000 || amountMsat % 1000 !== 0) {
    throw new Error('zap amount must be a positive whole number of sats in millisats');
  }
  const descriptionHash = createHash('sha256').update(zapRequestJson, 'utf8').digest();
  return encodeBolt11({
    amountSats: amountMsat / 1000,
    paymentHash: randomBytes(32),
    descriptionHash,
    timestamp: Math.floor(Date.now() / 1000),
    expirySeconds: 24 * 60 * 60,
  });
}

/**
 * Decode with the same library the API uses. Throws when the invoice is unusable.
 *
 * @returns {Promise<void>}
 */
export async function selfCheck() {
  const zap = '{"kind":9734}';
  const pr = invoiceForZap(zap, 5000);
  const bolt11 = await import('light-bolt11-decoder');
  const decode = bolt11.decode ?? bolt11.default?.decode;
  if (typeof decode !== 'function') {
    throw new Error('light-bolt11-decoder has no decode');
  }
  const decoded = decode(pr);
  const sections = decoded.sections ?? [];
  const named = (name) => sections.find((section) => section.name === name);
  const hash = named('payment_hash')?.value;
  const descriptionHash = String(named('description_hash')?.value ?? '').toLowerCase();
  const amount = Number(named('amount')?.value);
  const expected = createHash('sha256').update(zap, 'utf8').digest('hex');
  if (!/^[0-9a-f]{64}$/.test(String(hash).toLowerCase())) {
    throw new Error('bolt11 self-check missing payment hash');
  }
  if (descriptionHash !== expected) {
    throw new Error('bolt11 self-check description hash mismatch');
  }
  if (amount !== 5000) {
    throw new Error(`bolt11 self-check amount ${amount}`);
  }
}

/**
 * @param {number[]} bits
 * @param {bigint} value
 * @param {bigint} width
 */
function pushBig(bits, value, width) {
  for (let i = width - 1n; i >= 0n; i -= 1n) {
    bits.push(Number((value >> i) & 1n));
  }
}

/**
 * @param {number[]} bits
 * @param {number} tag
 * @param {Uint8Array} data
 */
function writeTag(bits, tag, data) {
  const groups = Math.ceil((data.byteLength * 8) / 5);
  pushBig(bits, BigInt(tag), 5n);
  pushBig(bits, BigInt(groups), 10n);
  for (const byte of data) {
    pushBig(bits, BigInt(byte), 8n);
  }
  const padded = groups * 5;
  const written = data.byteLength * 8;
  for (let i = written; i < padded; i += 1) {
    bits.push(0);
  }
}

/**
 * @param {number} value
 * @returns {Uint8Array}
 */
function minimalBytes(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('bolt11 integer must be non-negative');
  }
  if (value === 0) {
    return Uint8Array.of(0);
  }
  const bytes = [];
  let left = value;
  while (left > 0) {
    bytes.push(left & 0xff);
    left = Math.floor(left / 256);
  }
  bytes.reverse();
  return Uint8Array.from(bytes);
}
