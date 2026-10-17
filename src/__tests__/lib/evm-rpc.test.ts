import { describe, expect, it } from 'vitest';
import {
  evmGasPrice,
  evmGetTransactionByHash,
  evmGetTransactionReceipt,
  evmGetUserOperationReceipt,
  evmSendRawTransaction,
} from '@/lib/evm-rpc';
import type { FetchFn } from '@/lib/lnurlp';

const URL_WITH_KEY = 'https://rpc.example/v2/secret-key';
const HASH = `0x${'ab'.repeat(32)}`;
const HASH_UPPER = `0x${'AB'.repeat(32)}`;
const BUNDLE = `0x${'cd'.repeat(32)}`;
const TOKEN = `0x${'11'.repeat(20)}`;
const TOPIC = `0x${'22'.repeat(32)}`;

interface Captured {
  input: string | URL | Request;
  init: RequestInit | undefined;
}

function respond(body: unknown, status = 200): { fetchImpl: FetchFn; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl: FetchFn = async (input, init) => {
    calls.push({ input, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { fetchImpl, calls };
}

function result(value: unknown): { fetchImpl: FetchFn; calls: Captured[] } {
  return respond({ jsonrpc: '2.0', id: 1, result: value });
}

function log(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: TOKEN.toUpperCase().replace('0X', '0x'),
    topics: [TOPIC.toUpperCase().replace('0X', '0x')],
    data: '0xAB',
    logIndex: '0x1f',
    ...overrides,
  };
}

const PARSED_LOG = { address: TOKEN, topics: [TOPIC], data: '0xab', logIndex: 31 };

describe('JSON-RPC request', () => {
  it('posts a JSON-RPC 2.0 body with a timeout and no redirects', async () => {
    const { fetchImpl, calls } = result(null);
    await evmGetTransactionReceipt(URL_WITH_KEY, fetchImpl, HASH, 3000);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.input).toBe(URL_WITH_KEY);
    expect(call?.init?.method).toBe('POST');
    expect(call?.init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(call?.init?.redirect).toBe('error');
    expect(call?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getTransactionReceipt',
      params: [HASH],
    });
  });

  it('maps a thrown fetch to transport', async () => {
    const fetchImpl: FetchFn = async () => {
      throw new Error(`boom ${URL_WITH_KEY}`);
    };
    const out = await evmGasPrice(URL_WITH_KEY, fetchImpl, 3000);
    expect(out).toEqual({ ok: false, kind: 'transport' });
    expect(JSON.stringify(out)).not.toContain('secret-key');
  });

  it('maps a non-2xx status to transport', async () => {
    const { fetchImpl } = respond({ jsonrpc: '2.0', id: 1, result: '0x1' }, 502);
    expect(await evmGasPrice(URL_WITH_KEY, fetchImpl, 3000)).toEqual({
      ok: false,
      kind: 'transport',
    });
  });

  it('maps a body that is not JSON to transport', async () => {
    const { fetchImpl } = respond('not json');
    expect(await evmGasPrice(URL_WITH_KEY, fetchImpl, 3000)).toEqual({
      ok: false,
      kind: 'transport',
    });
  });

  it('maps a JSON body that is not an object to transport', async () => {
    expect(await evmGasPrice(URL_WITH_KEY, respond([1]).fetchImpl, 3000)).toEqual({
      ok: false,
      kind: 'transport',
    });
    expect(await evmGasPrice(URL_WITH_KEY, respond('null').fetchImpl, 3000)).toEqual({
      ok: false,
      kind: 'transport',
    });
  });

  it('maps a body without result or error to transport', async () => {
    const { fetchImpl } = respond({ jsonrpc: '2.0', id: 1 });
    expect(await evmGasPrice(URL_WITH_KEY, fetchImpl, 3000)).toEqual({
      ok: false,
      kind: 'transport',
    });
  });

  it('maps a JSON-RPC error object to rpc with its message', async () => {
    const { fetchImpl } = respond({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32000, message: 'nonce too low' },
    });
    expect(await evmSendRawTransaction(URL_WITH_KEY, fetchImpl, 'f86c', 3000)).toEqual({
      ok: false,
      kind: 'rpc',
      message: 'nonce too low',
    });
  });

  it('uses an empty message when the error has none', async () => {
    const { fetchImpl } = respond({ jsonrpc: '2.0', id: 1, error: { code: -32601 } });
    expect(await evmGetUserOperationReceipt(URL_WITH_KEY, fetchImpl, HASH, 3000)).toEqual({
      ok: false,
      kind: 'rpc',
      message: '',
    });
  });

  it('ignores an error that is not an object and reads the result', async () => {
    const { fetchImpl } = respond({ jsonrpc: '2.0', id: 1, error: 'x', result: '0x2' });
    expect(await evmGasPrice(URL_WITH_KEY, fetchImpl, 3000)).toEqual({ ok: true, value: 2n });
  });
});

describe('evmGetTransactionReceipt', () => {
  it('returns null when the node knows no receipt', async () => {
    expect(
      await evmGetTransactionReceipt(URL_WITH_KEY, result(null).fetchImpl, HASH, 3000),
    ).toEqual({ ok: true, value: null });
  });

  it('parses a receipt in lowercase', async () => {
    const { fetchImpl } = result({
      transactionHash: HASH_UPPER,
      status: '0X1',
      logs: [log()],
    });
    expect(await evmGetTransactionReceipt(URL_WITH_KEY, fetchImpl, HASH, 3000)).toEqual({
      ok: true,
      value: { transactionHash: HASH, status: '0x1', logs: [PARSED_LOG] },
    });
  });

  it('keeps a missing or null status as null', async () => {
    for (const status of [undefined, null]) {
      const { fetchImpl } = result({ transactionHash: HASH, status, logs: [] });
      expect(await evmGetTransactionReceipt(URL_WITH_KEY, fetchImpl, HASH, 3000)).toEqual({
        ok: true,
        value: { transactionHash: HASH, status: null, logs: [] },
      });
    }
  });

  it.each([
    ['a string result', '0x1'],
    ['an array result', []],
    ['a bad hash', { transactionHash: '0x12', status: '0x1', logs: [] }],
    ['logs that are not an array', { transactionHash: HASH, status: '0x1', logs: {} }],
    ['a log that is not an object', { transactionHash: HASH, status: '0x1', logs: [1] }],
    ['a bad log address', { transactionHash: HASH, logs: [log({ address: '0x12' })] }],
    ['odd log data', { transactionHash: HASH, logs: [log({ data: '0xabc' })] }],
    ['a bad logIndex', { transactionHash: HASH, logs: [log({ logIndex: 31 })] }],
    [
      'an unsafe logIndex',
      { transactionHash: HASH, logs: [log({ logIndex: `0x${'f'.repeat(20)}` })] },
    ],
    ['topics not an array', { transactionHash: HASH, logs: [log({ topics: 'x' })] }],
    ['a bad topic', { transactionHash: HASH, logs: [log({ topics: [TOPIC, '0x1'] })] }],
    ['a numeric status', { transactionHash: HASH, status: 1, logs: [] }],
    ['a non-hex status', { transactionHash: HASH, status: 'ok', logs: [] }],
  ])('maps %s to transport', async (_name, value) => {
    expect(
      await evmGetTransactionReceipt(URL_WITH_KEY, result(value).fetchImpl, HASH, 3000),
    ).toEqual({ ok: false, kind: 'transport' });
  });
});

describe('evmGetUserOperationReceipt', () => {
  it('sends the user operation hash', async () => {
    const { fetchImpl, calls } = result(null);
    expect(await evmGetUserOperationReceipt(URL_WITH_KEY, fetchImpl, HASH, 3000)).toEqual({
      ok: true,
      value: null,
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      method: 'eth_getUserOperationReceipt',
      params: [HASH],
    });
  });

  it('uses the nested transaction hash and the top-level logs', async () => {
    const { fetchImpl } = result({
      userOpHash: HASH,
      success: true,
      logs: [log()],
      receipt: {
        transactionHash: BUNDLE.toUpperCase().replace('0X', '0x'),
        status: '0x1',
        logs: [],
      },
    });
    expect(await evmGetUserOperationReceipt(URL_WITH_KEY, fetchImpl, HASH, 3000)).toEqual({
      ok: true,
      value: { success: true, transactionHash: BUNDLE, logs: [PARSED_LOG] },
    });
  });

  it('keeps success false, and a missing or null success as null', async () => {
    const cases: [unknown, boolean | null][] = [
      [false, false],
      [undefined, null],
      [null, null],
    ];
    for (const [success, expected] of cases) {
      const { fetchImpl } = result({ success, logs: [], receipt: { transactionHash: BUNDLE } });
      expect(await evmGetUserOperationReceipt(URL_WITH_KEY, fetchImpl, HASH, 3000)).toEqual({
        ok: true,
        value: { success: expected, transactionHash: BUNDLE, logs: [] },
      });
    }
  });

  it.each([
    ['a string result', 'x'],
    ['a missing receipt', { success: true, logs: [] }],
    ['a bad nested hash', { success: true, logs: [], receipt: { transactionHash: 'x' } }],
    ['bad logs', { success: true, logs: [null], receipt: { transactionHash: BUNDLE } }],
    ['a non-boolean success', { success: 'yes', logs: [], receipt: { transactionHash: BUNDLE } }],
  ])('maps %s to transport', async (_name, value) => {
    expect(
      await evmGetUserOperationReceipt(URL_WITH_KEY, result(value).fetchImpl, HASH, 3000),
    ).toEqual({ ok: false, kind: 'transport' });
  });
});

describe('evmGetTransactionByHash', () => {
  it('is true for an object, false for null, transport otherwise', async () => {
    const { fetchImpl, calls } = result({ hash: HASH });
    expect(await evmGetTransactionByHash(URL_WITH_KEY, fetchImpl, HASH, 3000)).toEqual({
      ok: true,
      value: true,
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      method: 'eth_getTransactionByHash',
      params: [HASH],
    });
    expect(await evmGetTransactionByHash(URL_WITH_KEY, result(null).fetchImpl, HASH, 3000)).toEqual(
      { ok: true, value: false },
    );
    expect(await evmGetTransactionByHash(URL_WITH_KEY, result('x').fetchImpl, HASH, 3000)).toEqual({
      ok: false,
      kind: 'transport',
    });
  });
});

describe('evmGasPrice', () => {
  it('parses a hex quantity', async () => {
    const { fetchImpl, calls } = result('0x3B9ACA00');
    expect(await evmGasPrice(URL_WITH_KEY, fetchImpl, 3000)).toEqual({
      ok: true,
      value: 1_000_000_000n,
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      method: 'eth_gasPrice',
      params: [],
    });
  });

  it.each([['0x'], ['12'], [12], [null]])('maps %s to transport', async (value) => {
    expect(await evmGasPrice(URL_WITH_KEY, result(value).fetchImpl, 3000)).toEqual({
      ok: false,
      kind: 'transport',
    });
  });
});

describe('evmSendRawTransaction', () => {
  it('sends 0x plus the raw hex and returns the hash in lowercase', async () => {
    const { fetchImpl, calls } = result(HASH_UPPER);
    expect(await evmSendRawTransaction(URL_WITH_KEY, fetchImpl, 'f86c09', 3000)).toEqual({
      ok: true,
      value: HASH,
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      method: 'eth_sendRawTransaction',
      params: ['0xf86c09'],
    });
  });

  it('maps a result that is not a hash to transport', async () => {
    expect(await evmSendRawTransaction(URL_WITH_KEY, result('0x12').fetchImpl, 'f8', 3000)).toEqual(
      { ok: false, kind: 'transport' },
    );
  });
});
