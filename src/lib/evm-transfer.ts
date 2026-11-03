/**
 * ERC-20 transfer encoding and signed EVM transaction decoding for the shop
 * stablecoin proof (docs/shop-stablecoin-payment.md, Offer checks, Proof,
 * Open amount).
 */

import { keccak256, parseTransaction, serializeTransaction, type Hex } from 'viem';
import type { EvmLog } from '@/lib/evm-rpc';

/** Topic 0 of the ERC-20 `Transfer(address,address,uint256)` event. */
export const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Selector of `transfer(address,uint256)`. */
const TRANSFER_SELECTOR = 'a9059cbb';

const MAX_UINT256 = (1n << 256n) - 1n;

const TRANSFER_DATA = /^0xa9059cbb0{24}[0-9a-f]{104}$/;
const ADDRESS_TOPIC = /^0x0{24}[0-9a-f]{40}$/;
const WORD = /^0x[0-9a-f]{64}$/;
const EVEN_HEX = /^([0-9a-f]{2})+$/;
const ZERO_HEX = /^0x0*$/;

/**
 * Normalise an EVM address.
 *
 * @param value - `0x` plus 40 hexadecimal characters, any case.
 * @returns The lowercase address, or `null` when the shape is wrong.
 */
export function normalizeEvmAddress(value: string): string | null {
  return /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : null;
}

/**
 * Build the 68-byte calldata of `transfer(recipient, amount)`.
 *
 * @param recipient - Recipient address, `0x` + 40 hex, any case.
 * @param amount - Token amount in base units, `0 ≤ amount < 2^256`.
 * @returns `0xa9059cbb`, 12 zero bytes, the 20-byte recipient, and the
 *   32-byte amount, lowercase.
 * @throws RangeError when the recipient or the amount is out of shape.
 */
export function erc20TransferData(recipient: string, amount: bigint): string {
  const address = normalizeEvmAddress(recipient);
  if (address === null) {
    throw new RangeError('invalid recipient address');
  }
  if (amount < 0n || amount > MAX_UINT256) {
    throw new RangeError('amount out of uint256 range');
  }
  return `0x${TRANSFER_SELECTOR}${'0'.repeat(24)}${address.slice(2)}${amount.toString(16).padStart(64, '0')}`;
}

/**
 * Parse `transfer(address,uint256)` calldata.
 *
 * @param data - Calldata hex with `0x`, any case.
 * @returns Lowercase recipient and amount, or `null` unless the data is
 *   exactly 68 bytes with the transfer selector and a zero-padded address.
 */
export function parseErc20TransferData(data: string): { recipient: string; amount: bigint } | null {
  const lower = data.toLowerCase();
  if (!TRANSFER_DATA.test(lower)) {
    return null;
  }
  return { recipient: `0x${lower.slice(34, 74)}`, amount: BigInt(`0x${lower.slice(74)}`) };
}

/** A decoded ERC-20 `Transfer` log. */
export interface Erc20TransferLog {
  /** Emitting token contract, lowercase. */
  token: string;
  /** Sender, lowercase. */
  from: string;
  /** Recipient, lowercase. */
  to: string;
  /** Transferred amount in base units. */
  value: bigint;
  /** Log index in the block. */
  logIndex: number;
}

/**
 * Decode an ERC-20 `Transfer` event log.
 *
 * @param log - One receipt log.
 * @returns The transfer, or `null` unless topic 0 is
 *   {@link ERC20_TRANSFER_TOPIC}, there are exactly three topics with
 *   zero-padded addresses, and the data is one 32-byte word.
 */
export function decodeTransferLog(log: EvmLog): Erc20TransferLog | null {
  if (log.topics.length !== 3) {
    return null;
  }
  const [topic0, fromTopic, toTopic] = log.topics.map((topic) => topic.toLowerCase());
  const token = normalizeEvmAddress(log.address);
  const from = addressFromTopic(fromTopic);
  const to = addressFromTopic(toTopic);
  const data = log.data.toLowerCase();
  if (
    topic0 !== ERC20_TRANSFER_TOPIC ||
    token === null ||
    from === null ||
    to === null ||
    !WORD.test(data)
  ) {
    return null;
  }
  return { token, from, to, value: BigInt(data), logIndex: log.logIndex };
}

function addressFromTopic(topic: string | undefined): string | null {
  if (topic === undefined || !ADDRESS_TOPIC.test(topic)) {
    return null;
  }
  return `0x${topic.slice(26)}`;
}

/** The fields of a signed EVM transaction the `hex` proof checks. */
export interface DecodedEvmTransaction {
  /** `0x` + Keccak-256 of the signed bytes, lowercase. */
  hash: string;
  /** Envelope type. */
  type: 'legacy' | 'eip2930' | 'eip1559';
  /** Chain id; `null` for a legacy transaction without EIP-155. */
  chainId: number | null;
  /** Recipient, lowercase; `null` for a contract creation. */
  to: string | null;
  /** Native value in wei. */
  value: bigint;
  /** Calldata, lowercase, `0x` when empty. */
  data: string;
  /** Gas price (legacy, EIP-2930); `null` for EIP-1559. */
  gasPrice: bigint | null;
  /** Fee cap (EIP-1559); `null` otherwise. */
  maxFeePerGas: bigint | null;
  /** Priority fee cap (EIP-1559); `null` otherwise. */
  maxPriorityFeePerGas: bigint | null;
}

/**
 * Decode a signed legacy, EIP-2930, or EIP-1559 transaction.
 *
 * The bytes must re-encode to themselves, so the hash always belongs to
 * exactly the decoded fields. The signature's `r` and `s` must be non-zero;
 * the sender is not recovered (the node checks it on broadcast).
 *
 * @param rawHex - Signed transaction bytes as hex without `0x`, any case.
 * @returns The decoded transaction, or `null` when the input is not a
 *   canonical signed transaction of one of the three types (EIP-4844,
 *   EIP-7702, unsigned, and malformed input all give `null`).
 */
export function decodeSignedEvmTransaction(rawHex: string): DecodedEvmTransaction | null {
  const lower = rawHex.toLowerCase();
  if (!EVEN_HEX.test(lower)) {
    return null;
  }
  const serialized: Hex = `0x${lower}`;
  try {
    const parsed = parseTransaction(serialized);
    if (parsed.type !== 'legacy' && parsed.type !== 'eip2930' && parsed.type !== 'eip1559') {
      return null;
    }
    const { r, s, v } = parsed;
    if (r === undefined || s === undefined || v === undefined) {
      return null;
    }
    if (ZERO_HEX.test(r) || ZERO_HEX.test(s)) {
      return null;
    }
    if (serializeTransaction(parsed, { r, s, v }) !== serialized) {
      return null;
    }
    const base = {
      hash: keccak256(serialized),
      to: parsed.to === undefined || parsed.to === null ? null : parsed.to.toLowerCase(),
      value: parsed.value ?? 0n,
      data: parsed.data === undefined ? '0x' : parsed.data.toLowerCase(),
    };
    if (parsed.type === 'eip1559') {
      return {
        ...base,
        type: 'eip1559',
        chainId: parsed.chainId,
        gasPrice: null,
        maxFeePerGas: parsed.maxFeePerGas ?? 0n,
        maxPriorityFeePerGas: parsed.maxPriorityFeePerGas ?? 0n,
      };
    }
    return {
      ...base,
      type: parsed.type,
      chainId: parsed.chainId ?? null,
      gasPrice: parsed.gasPrice ?? 0n,
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
    };
  } catch {
    return null;
  }
}

/**
 * DFX's recommended gas price, the `minFee` of an offer.
 *
 * @param gasPrice - The `eth_gasPrice` result in wei.
 * @param chainId - The method's chain id.
 * @returns `floor(g × 12 / 10)`, and on chain 56 (BNB Smart Chain)
 *   `floor(floor(g × 12 / 10) × 20 / 12)`.
 */
export function recommendedMinFee(gasPrice: bigint, chainId: number): bigint {
  const fee = (gasPrice * 12n) / 10n;
  return chainId === 56 ? (fee * 20n) / 12n : fee;
}

/**
 * Check that a signed transaction's fee reaches an offer's `minFee`.
 *
 * Legacy and EIP-2930: the gas price. EIP-1559: the lower of `maxFeePerGas`
 * and `currentRecommended + maxPriorityFeePerGas`. A missing fee counts as 0.
 *
 * @param tx - The decoded transaction.
 * @param minFee - The offer's `minFee` in wei.
 * @param currentRecommended - {@link recommendedMinFee} of the current
 *   `eth_gasPrice`.
 * @returns `true` when the effective fee is at least `minFee`.
 */
export function hexFeeReaches(
  tx: DecodedEvmTransaction,
  minFee: bigint,
  currentRecommended: bigint,
): boolean {
  let effective: bigint;
  if (tx.type === 'eip1559') {
    const cap = tx.maxFeePerGas ?? 0n;
    const offered = currentRecommended + (tx.maxPriorityFeePerGas ?? 0n);
    effective = cap < offered ? cap : offered;
  } else {
    effective = tx.gasPrice ?? 0n;
  }
  return effective >= minFee;
}
