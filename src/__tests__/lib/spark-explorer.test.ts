import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchFn } from '@/lib/lnurlp';
import {
  SPARK_EXPLORER_BASE_URL,
  SPARK_EXPLORER_TIMEOUT_MS,
  fetchSparkAddressBalance,
} from '@/lib/spark-explorer';

const ADDRESS = 'spark1pgssyuuuhnrrdjswal5c3s3rafw9w3y5dd4cjy3duxlf7hjzkp0rqx6dj6mrhu';

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

function events(): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

/** A Sparkscan address body as checked on 2026-10-29. */
function addressBody(balance: unknown): Record<string, unknown> {
  return {
    sparkAddress: ADDRESS,
    publicKey: `02${'a'.repeat(64)}`,
    balance,
    totalValueUsd: 1.23,
    transactionCount: 4,
  };
}

function answering(response: Response): {
  fetchImpl: FetchFn;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: FetchFn = async (input, init) => {
    calls.push({ url: String(input), init });
    return response;
  };
  return { fetchImpl, calls };
}

describe('fetchSparkAddressBalance', () => {
  it('reads the soft balance anonymously from the mainnet address endpoint', async () => {
    const { fetchImpl, calls } = answering(
      Response.json(
        addressBody({ btcSoftBalanceSats: 1234, btcHardBalanceSats: 1000, totalTokens: 0 }),
      ),
    );
    await expect(fetchSparkAddressBalance(fetchImpl, ADDRESS)).resolves.toBe(1234);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${SPARK_EXPLORER_BASE_URL}/v1/address/${ADDRESS}?network=MAINNET`);
    expect(SPARK_EXPLORER_BASE_URL).toBe('https://api.sparkscan.io');
    const init = calls[0]?.init;
    expect(init?.headers).toEqual({ accept: 'application/json' });
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.method).toBeUndefined();
    expect(events()).toEqual([]);
  });

  it('times out after five seconds', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { fetchImpl } = answering(Response.json(addressBody({ btcSoftBalanceSats: 0 })));
    await expect(fetchSparkAddressBalance(fetchImpl, ADDRESS)).resolves.toBe(0);
    expect(SPARK_EXPLORER_TIMEOUT_MS).toBe(5_000);
    expect(timeout).toHaveBeenCalledWith(SPARK_EXPLORER_TIMEOUT_MS);
    timeout.mockRestore();
  });

  it('percent-encodes the address path segment', async () => {
    const { fetchImpl, calls } = answering(Response.json(addressBody({ btcSoftBalanceSats: 1 })));
    await fetchSparkAddressBalance(fetchImpl, 'a/b?c');
    expect(calls[0]?.url).toBe(`${SPARK_EXPLORER_BASE_URL}/v1/address/a%2Fb%3Fc?network=MAINNET`);
  });

  it('does not fall back to the hard balance', async () => {
    const { fetchImpl } = answering(Response.json(addressBody({ btcHardBalanceSats: 1000 })));
    await expect(fetchSparkAddressBalance(fetchImpl, ADDRESS)).resolves.toBeNull();
  });

  it('returns null for a bad address answer and logs only the status', async () => {
    const { fetchImpl } = answering(
      Response.json({ message: `Invalid address: ${ADDRESS}` }, { status: 400 }),
    );
    await expect(fetchSparkAddressBalance(fetchImpl, ADDRESS)).resolves.toBeNull();
    expect(events()).toEqual([
      expect.objectContaining({ event: 'spark_explorer.unavailable', status: 400 }),
    ]);
  });

  it.each([404, 429, 500, 503])('returns null for HTTP %i', async (status) => {
    const { fetchImpl } = answering(
      Response.json(addressBody({ btcSoftBalanceSats: 5 }), { status }),
    );
    await expect(fetchSparkAddressBalance(fetchImpl, ADDRESS)).resolves.toBeNull();
    expect(events()).toEqual([
      expect.objectContaining({ event: 'spark_explorer.unavailable', status }),
    ]);
  });

  it('returns null for a body that is not JSON', async () => {
    const { fetchImpl } = answering(new Response('<html>busy</html>', { status: 200 }));
    await expect(fetchSparkAddressBalance(fetchImpl, ADDRESS)).resolves.toBeNull();
    expect(events()).toEqual([
      expect.objectContaining({ event: 'spark_explorer.unavailable', status: 200 }),
    ]);
  });

  it.each([
    ['null', null],
    ['an array', [1]],
    ['a string', 'spark'],
    ['a body without balance', { sparkAddress: ADDRESS }],
    ['a null balance', addressBody(null)],
    ['a string balance object', addressBody('1234')],
    ['a negative soft balance', addressBody({ btcSoftBalanceSats: -1 })],
    ['a fractional soft balance', addressBody({ btcSoftBalanceSats: 1.5 })],
    ['an unsafe soft balance', addressBody({ btcSoftBalanceSats: Number.MAX_SAFE_INTEGER + 1 })],
    ['a string soft balance', addressBody({ btcSoftBalanceSats: '1234' })],
  ])('returns null for %s', async (_label, body) => {
    const { fetchImpl } = answering(Response.json(body));
    await expect(fetchSparkAddressBalance(fetchImpl, ADDRESS)).resolves.toBeNull();
    expect(events()).toEqual([
      expect.objectContaining({ event: 'spark_explorer.unavailable', status: 200 }),
    ]);
  });

  it('returns null without a status when the request throws or times out', async () => {
    for (const failure of [
      new TypeError('fetch failed'),
      new DOMException('The operation was aborted.', 'TimeoutError'),
    ]) {
      warn.mockClear();
      const fetchImpl: FetchFn = async () => {
        throw failure;
      };
      await expect(fetchSparkAddressBalance(fetchImpl, ADDRESS)).resolves.toBeNull();
      expect(events()).toEqual([{ ts: expect.any(String), event: 'spark_explorer.unavailable' }]);
    }
  });

  it('never logs the address', async () => {
    const { fetchImpl } = answering(Response.json({ message: 'Invalid address' }, { status: 400 }));
    await fetchSparkAddressBalance(fetchImpl, ADDRESS);
    const thrower: FetchFn = async () => {
      throw new Error(`cannot reach ${ADDRESS}`);
    };
    await fetchSparkAddressBalance(thrower, ADDRESS);
    const output = warn.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(output).toContain('spark_explorer.unavailable');
    expect(output).not.toContain(ADDRESS);
    expect(output).not.toContain('spark1');
  });
});
