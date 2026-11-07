/**
 * Minimal EVM JSON-RPC client for the shop stablecoin proof
 * (docs/shop-stablecoin-payment.md, Orchestra › Configuration).
 *
 * Each call is one JSON-RPC 2.0 POST with an AbortSignal timeout and
 * `redirect: 'error'`. The endpoint URL may hold a provider key, so it is
 * never logged and never part of a result.
 */

import type { FetchFn } from '@/lib/lnurlp';

/**
 * Outcome of one JSON-RPC call.
 *
 * `transport`: the call failed, the HTTP status was not 2xx, the body was not
 * a JSON-RPC response, or the result had the wrong shape. `rpc`: the node
 * answered with a JSON-RPC `error` object.
 */
export type EvmRpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'transport' }
  | { ok: false; kind: 'rpc'; message: string };

/** One event log, hex strings in lowercase. */
export interface EvmLog {
  /** Emitting contract address. */
  address: string;
  /** Indexed topics, topic 0 first. */
  topics: string[];
  /** Unindexed data. */
  data: string;
  /** Position of the log in its block. */
  logIndex: number;
}

/** The fields of `eth_getTransactionReceipt` the proof uses. */
export interface EvmReceipt {
  /** Transaction hash, lowercase. */
  transactionHash: string;
  /** `0x1` success, `0x0` failure, lowercase; `null` when the node sends none. */
  status: string | null;
  /** Logs of the transaction. */
  logs: EvmLog[];
}

/** The fields of `eth_getUserOperationReceipt` (ERC-4337) the proof uses. */
export interface EvmUserOperationReceipt {
  /** Whether the user operation itself succeeded; `null` when absent. */
  success: boolean | null;
  /** Hash of the bundle transaction (`receipt.transactionHash`), lowercase. */
  transactionHash: string;
  /** The user operation's own logs (top-level `logs`). */
  logs: EvmLog[];
}

type RpcBody = { kind: 'result'; result: unknown } | { kind: 'error'; message: string } | null;

const HEX_QUANTITY = /^0x[0-9a-f]+$/;
const HEX_DATA = /^0x([0-9a-f]{2})*$/;
const HEX_HASH = /^0x[0-9a-f]{64}$/;
const HEX_ADDRESS = /^0x[0-9a-f]{40}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function rpcCall(
  url: string,
  fetchImpl: FetchFn,
  method: string,
  params: unknown[],
  timeoutMs: number,
): Promise<RpcBody> {
  let body: unknown;
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return null;
    }
    body = await response.json();
  } catch {
    return null;
  }
  if (!isRecord(body)) {
    return null;
  }
  const error = body['error'];
  if (isRecord(error)) {
    const message = error['message'];
    return { kind: 'error', message: typeof message === 'string' ? message : '' };
  }
  if (!('result' in body)) {
    return null;
  }
  return { kind: 'result', result: body['result'] };
}

async function call<T>(
  url: string,
  fetchImpl: FetchFn,
  method: string,
  params: unknown[],
  timeoutMs: number,
  parse: (result: unknown) => { value: T } | null,
): Promise<EvmRpcResult<T>> {
  const body = await rpcCall(url, fetchImpl, method, params, timeoutMs);
  if (body === null) {
    return { ok: false, kind: 'transport' };
  }
  if (body.kind === 'error') {
    return { ok: false, kind: 'rpc', message: body.message };
  }
  const parsed = parse(body.result);
  if (parsed === null) {
    return { ok: false, kind: 'transport' };
  }
  return { ok: true, value: parsed.value };
}

function lowerString(value: unknown, pattern: RegExp): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const lower = value.toLowerCase();
  return pattern.test(lower) ? lower : null;
}

function parseLog(value: unknown): EvmLog | null {
  if (!isRecord(value)) {
    return null;
  }
  const address = lowerString(value['address'], HEX_ADDRESS);
  const data = lowerString(value['data'], HEX_DATA);
  const logIndex = lowerString(value['logIndex'], HEX_QUANTITY);
  const rawTopics = value['topics'];
  if (address === null || data === null || logIndex === null || !Array.isArray(rawTopics)) {
    return null;
  }
  const topics: string[] = [];
  for (const rawTopic of rawTopics) {
    const topic = lowerString(rawTopic, HEX_HASH);
    if (topic === null) {
      return null;
    }
    topics.push(topic);
  }
  const index = Number.parseInt(logIndex.slice(2), 16);
  if (!Number.isSafeInteger(index)) {
    return null;
  }
  return { address, topics, data, logIndex: index };
}

function parseLogs(value: unknown): EvmLog[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const logs: EvmLog[] = [];
  for (const raw of value) {
    const log = parseLog(raw);
    if (log === null) {
      return null;
    }
    logs.push(log);
  }
  return logs;
}

function parseReceipt(result: unknown): { value: EvmReceipt | null } | null {
  if (result === null) {
    return { value: null };
  }
  if (!isRecord(result)) {
    return null;
  }
  const transactionHash = lowerString(result['transactionHash'], HEX_HASH);
  const logs = parseLogs(result['logs']);
  if (transactionHash === null || logs === null) {
    return null;
  }
  const rawStatus = result['status'];
  let status: string | null = null;
  if (rawStatus !== undefined && rawStatus !== null) {
    status = lowerString(rawStatus, HEX_QUANTITY);
    if (status === null) {
      return null;
    }
  }
  return { value: { transactionHash, status, logs } };
}

function parseUserOperationReceipt(
  result: unknown,
): { value: EvmUserOperationReceipt | null } | null {
  if (result === null) {
    return { value: null };
  }
  if (!isRecord(result)) {
    return null;
  }
  const receipt = result['receipt'];
  const rawSuccess = result['success'];
  if (!isRecord(receipt)) {
    return null;
  }
  const transactionHash = lowerString(receipt['transactionHash'], HEX_HASH);
  const logs = parseLogs(result['logs']);
  if (transactionHash === null || logs === null) {
    return null;
  }
  let success: boolean | null;
  if (typeof rawSuccess === 'boolean') {
    success = rawSuccess;
  } else if (rawSuccess === undefined || rawSuccess === null) {
    success = null;
  } else {
    return null;
  }
  return { value: { success, transactionHash, logs } };
}

/**
 * Read a transaction receipt (`eth_getTransactionReceipt`).
 *
 * @param url - JSON-RPC endpoint (secret; never logged or returned).
 * @param fetchImpl - Fetch implementation.
 * @param hash - Transaction hash, `0x` + 64 hex.
 * @param timeoutMs - Abort after this many milliseconds.
 * @returns The receipt, `null` when the node knows none, or a failure.
 */
export function evmGetTransactionReceipt(
  url: string,
  fetchImpl: FetchFn,
  hash: string,
  timeoutMs: number,
): Promise<EvmRpcResult<EvmReceipt | null>> {
  return call(url, fetchImpl, 'eth_getTransactionReceipt', [hash], timeoutMs, parseReceipt);
}

/**
 * Read an ERC-4337 user operation receipt (`eth_getUserOperationReceipt`).
 *
 * `transactionHash` is the bundle's `receipt.transactionHash`; `logs` are the
 * user operation's own top-level logs. A node without the method answers
 * with a JSON-RPC error, which is returned as `rpc`.
 *
 * @param url - JSON-RPC endpoint (secret; never logged or returned).
 * @param fetchImpl - Fetch implementation.
 * @param hash - User operation hash, `0x` + 64 hex.
 * @param timeoutMs - Abort after this many milliseconds.
 * @returns The receipt, `null` when the bundler knows none, or a failure.
 */
export function evmGetUserOperationReceipt(
  url: string,
  fetchImpl: FetchFn,
  hash: string,
  timeoutMs: number,
): Promise<EvmRpcResult<EvmUserOperationReceipt | null>> {
  return call(
    url,
    fetchImpl,
    'eth_getUserOperationReceipt',
    [hash],
    timeoutMs,
    parseUserOperationReceipt,
  );
}

/**
 * Check whether the node knows a transaction (`eth_getTransactionByHash`).
 *
 * @param url - JSON-RPC endpoint (secret; never logged or returned).
 * @param fetchImpl - Fetch implementation.
 * @param hash - Transaction hash, `0x` + 64 hex.
 * @param timeoutMs - Abort after this many milliseconds.
 * @returns `true` when the result is an object, `false` when it is `null`.
 */
export function evmGetTransactionByHash(
  url: string,
  fetchImpl: FetchFn,
  hash: string,
  timeoutMs: number,
): Promise<EvmRpcResult<boolean>> {
  return call(url, fetchImpl, 'eth_getTransactionByHash', [hash], timeoutMs, (result) => {
    if (result === null) {
      return { value: false };
    }
    return isRecord(result) ? { value: true } : null;
  });
}

/**
 * Read the node's gas price (`eth_gasPrice`).
 *
 * @param url - JSON-RPC endpoint (secret; never logged or returned).
 * @param fetchImpl - Fetch implementation.
 * @param timeoutMs - Abort after this many milliseconds.
 * @returns The gas price in wei.
 */
export function evmGasPrice(
  url: string,
  fetchImpl: FetchFn,
  timeoutMs: number,
): Promise<EvmRpcResult<bigint>> {
  return call(url, fetchImpl, 'eth_gasPrice', [], timeoutMs, (result) => {
    const quantity = lowerString(result, HEX_QUANTITY);
    return quantity === null ? null : { value: BigInt(quantity) };
  });
}

/**
 * Broadcast a signed transaction (`eth_sendRawTransaction`).
 *
 * @param url - JSON-RPC endpoint (secret; never logged or returned).
 * @param fetchImpl - Fetch implementation.
 * @param rawHex - Signed transaction bytes as hex without `0x`.
 * @param timeoutMs - Abort after this many milliseconds.
 * @returns The transaction hash the node returns, lowercase.
 */
export function evmSendRawTransaction(
  url: string,
  fetchImpl: FetchFn,
  rawHex: string,
  timeoutMs: number,
): Promise<EvmRpcResult<string>> {
  return call(url, fetchImpl, 'eth_sendRawTransaction', [`0x${rawHex}`], timeoutMs, (result) => {
    const hash = lowerString(result, HEX_HASH);
    return hash === null ? null : { value: hash };
  });
}
