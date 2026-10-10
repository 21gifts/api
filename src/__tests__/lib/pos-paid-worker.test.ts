import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LnurlServerConfig } from '@/lib/config';
import { POS_CHARGE_TTL_MS, type PosCharge } from '@/lib/pos-charge';
import { POS_PAID_WATCH_MS, runPosPaidTick, startPosPaidWorker } from '@/lib/pos-paid-worker';
import { InMemoryPosStore, type PosStore } from '@/lib/pos-store';
import { concatBytes, decodeProto, protoBytesField, protoVarintField } from '@/lib/protobuf';
import { SPARK_QUERY_LIMIT } from '@/lib/spark-operator';
import { SPARK_WORKER_INTERVAL_MS } from '@/lib/spark-worker';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const OPERATOR_URL = 'https://op.example';
const LNURL: LnurlServerConfig = {
  baseUrl: 'http://lnurl.test',
  publicBaseUrl: 'https://example.test',
  host: 'example.test',
};
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function charge(id: string, partial: Partial<PosCharge> = {}): PosCharge {
  return {
    id,
    accountId: `acc-${id}`,
    amountSats: 21,
    status: 'pending',
    createdAt: new Date(NOW - 1_000),
    expiresAt: new Date(NOW - 1_000 + POS_CHARGE_TTL_MS),
    paidAt: null,
    sparkInvoice: null,
    ...partial,
  };
}

function frame(flags: number, payload: Uint8Array): Uint8Array {
  const header = new Uint8Array(5);
  header[0] = flags;
  new DataView(header.buffer).setUint32(1, payload.byteLength);
  return concatBytes(header, payload);
}

function requestedInvoices(body: unknown): string[] {
  return decodeProto((body as Uint8Array).subarray(5))
    .filter((f) => f.field === 3)
    .map((f) => new TextDecoder().decode(f.value as Uint8Array));
}

/** gRPC-web body answering each invoice with a status number. */
function operatorBody(statuses: Map<string, number>, invoices: readonly string[]): Uint8Array {
  const entries = invoices.flatMap((invoice) => {
    const status = statuses.get(invoice);
    return status === undefined
      ? []
      : [protoBytesField(2, concatBytes(protoBytesField(1, invoice), protoVarintField(2, status)))];
  });
  return concatBytes(
    frame(0, concatBytes(...entries)),
    frame(0x80, new TextEncoder().encode('grpc-status: 0')),
  );
}

interface FakeNetwork {
  fetchImpl: ReturnType<typeof vi.fn>;
  sparkBatches: string[][];
  verified: string[];
}

/**
 * Fake coordinator and LNURL server. `spark` maps invoices to wire statuses
 * (2 = finalized); `verify` maps payment hashes to a response.
 */
function network(
  spark: Map<string, number>,
  verify: Map<string, () => Response>,
  sparkReply?: () => Response,
): FakeNetwork {
  const sparkBatches: string[][] = [];
  const verified: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(OPERATOR_URL)) {
      const invoices = requestedInvoices(init?.body);
      sparkBatches.push(invoices);
      return sparkReply?.() ?? new Response(operatorBody(spark, invoices), { status: 200 });
    }
    const hash = url.slice(`${LNURL.baseUrl}/verify/`.length);
    verified.push(hash);
    return verify.get(hash)?.() ?? new Response('{"status":"OK","settled":false}');
  });
  return { fetchImpl, sparkBatches, verified };
}

const settled = (): Response => new Response('{"status":"OK","settled":true,"preimage":"00"}');

describe('runPosPaidTick', () => {
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

  async function status(store: PosStore, id: string): Promise<PosCharge | undefined> {
    return (await store.listLatest(50)).find((row) => row.id === id);
  }

  it('marks a charge paid when its Spark invoice is finalized', async () => {
    const store = new InMemoryPosStore();
    await store.create(charge('c1', { sparkInvoice: 'spark1one' }));
    await store.create(charge('c2', { sparkInvoice: 'spark1two' }));
    const net = network(
      new Map([
        ['spark1one', 2],
        ['spark1two', 1],
      ]),
      new Map(),
    );
    await runPosPaidTick({
      store,
      lnurlServer: LNURL,
      operatorUrl: OPERATOR_URL,
      fetchImpl: net.fetchImpl,
      now: () => NOW,
    });
    expect(net.sparkBatches).toEqual([['spark1one', 'spark1two']]);
    expect(await status(store, 'c1')).toEqual(
      expect.objectContaining({ status: 'paid', paidAt: new Date(NOW) }),
    );
    expect((await status(store, 'c2'))?.status).toBe('pending');
    expect(events().filter((e) => e['event'] === 'pos.paid')).toEqual([
      expect.objectContaining({ accountId: 'acc-c1' }),
    ]);
  });

  it('skips the coordinator when free in-app payments are off or nothing has a Spark invoice', async () => {
    const store = new InMemoryPosStore();
    await store.create(charge('c1', { sparkInvoice: 'spark1one' }));
    const off = network(new Map([['spark1one', 2]]), new Map());
    await runPosPaidTick({ store, lnurlServer: LNURL, fetchImpl: off.fetchImpl, now: () => NOW });
    expect(off.sparkBatches).toEqual([]);
    expect((await status(store, 'c1'))?.status).toBe('pending');
    const plain = new InMemoryPosStore();
    await plain.create(charge('c1'));
    const none = network(new Map(), new Map());
    await runPosPaidTick({
      store: plain,
      lnurlServer: LNURL,
      operatorUrl: OPERATOR_URL,
      fetchImpl: none.fetchImpl,
      now: () => NOW,
    });
    expect(none.fetchImpl).not.toHaveBeenCalled();
  });

  it('batches Spark invoices and keeps going after a failed batch', async () => {
    const store = new InMemoryPosStore();
    for (let i = 0; i <= SPARK_QUERY_LIMIT; i += 1) {
      await store.create(
        charge(`c${String(i).padStart(3, '0')}`, {
          createdAt: new Date(NOW - 1_000 + i),
          sparkInvoice: `spark1inv${i}`,
        }),
      );
    }
    let calls = 0;
    const net = network(new Map([[`spark1inv${SPARK_QUERY_LIMIT}`, 2]]), new Map(), () => {
      calls += 1;
      return calls === 1
        ? new Response('', { status: 503 })
        : new Response(
            operatorBody(new Map([[`spark1inv${SPARK_QUERY_LIMIT}`, 2]]), [
              `spark1inv${SPARK_QUERY_LIMIT}`,
            ]),
            { status: 200 },
          );
    });
    await runPosPaidTick({
      store,
      lnurlServer: LNURL,
      operatorUrl: OPERATOR_URL,
      fetchImpl: net.fetchImpl,
      now: () => NOW,
    });
    expect(net.sparkBatches.map((batch) => batch.length)).toEqual([SPARK_QUERY_LIMIT, 1]);
    expect((await status(store, `c${SPARK_QUERY_LIMIT}`))?.status).toBe('paid');
    expect(events()).toContainEqual(
      expect.objectContaining({ event: 'pos.spark.query_failed', reason: 'http' }),
    );
  });

  it('logs the gRPC status of a refused Spark query', async () => {
    const store = new InMemoryPosStore();
    await store.create(charge('c1', { sparkInvoice: 'spark1one' }));
    const net = network(
      new Map(),
      new Map(),
      () => new Response(new Uint8Array(0), { status: 200, headers: { 'grpc-status': '14' } }),
    );
    await runPosPaidTick({
      store,
      lnurlServer: LNURL,
      operatorUrl: OPERATOR_URL,
      fetchImpl: net.fetchImpl,
      now: () => NOW,
    });
    expect(events()).toContainEqual(
      expect.objectContaining({ event: 'pos.spark.query_failed', reason: 'grpc', grpcStatus: 14 }),
    );
  });

  it('ignores a finalized invoice it did not ask about', async () => {
    const store = new InMemoryPosStore();
    await store.create(charge('c1', { sparkInvoice: 'spark1one' }));
    const net = network(
      new Map(),
      new Map(),
      () =>
        new Response(operatorBody(new Map([['spark1other', 2]]), ['spark1other']), {
          status: 200,
        }),
    );
    await runPosPaidTick({
      store,
      lnurlServer: LNURL,
      operatorUrl: OPERATOR_URL,
      fetchImpl: net.fetchImpl,
      now: () => NOW,
    });
    expect((await status(store, 'c1'))?.status).toBe('pending');
  });

  it('marks a charge paid when a recorded BOLT11 settles and stops checking it', async () => {
    const store = new InMemoryPosStore();
    await store.create(charge('c1'));
    await store.recordInvoice('c1', HASH_A, NOW);
    await store.recordInvoice('c1', HASH_B, NOW);
    const net = network(new Map(), new Map([[HASH_A, settled]]));
    await runPosPaidTick({ store, lnurlServer: LNURL, fetchImpl: net.fetchImpl, now: () => NOW });
    expect(net.verified).toEqual([HASH_A]);
    expect(net.fetchImpl.mock.calls[0]?.[0]).toBe(`${LNURL.baseUrl}/verify/${HASH_A}`);
    expect((await status(store, 'c1'))?.status).toBe('paid');
  });

  it('does not verify a charge the Spark path already paid in this tick', async () => {
    const store = new InMemoryPosStore();
    await store.create(charge('c1', { sparkInvoice: 'spark1one' }));
    await store.recordInvoice('c1', HASH_A, NOW);
    const net = network(new Map([['spark1one', 2]]), new Map([[HASH_A, settled]]));
    await runPosPaidTick({
      store,
      lnurlServer: LNURL,
      operatorUrl: OPERATOR_URL,
      fetchImpl: net.fetchImpl,
      now: () => NOW,
    });
    expect(net.verified).toEqual([]);
    expect(events().filter((e) => e['event'] === 'pos.paid')).toHaveLength(1);
  });

  it('still pays a charge that expired after the invoice was recorded', async () => {
    const store = new InMemoryPosStore();
    await store.create(charge('c1'));
    await store.recordInvoice('c1', HASH_A, NOW);
    const later = NOW + POS_CHARGE_TTL_MS + 60_000;
    await store.currentPending('acc-c1', later);
    expect((await status(store, 'c1'))?.status).toBe('expired');
    const net = network(new Map(), new Map([[HASH_A, settled]]));
    await runPosPaidTick({ store, lnurlServer: LNURL, fetchImpl: net.fetchImpl, now: () => later });
    expect(await status(store, 'c1')).toEqual(
      expect.objectContaining({ status: 'paid', paidAt: new Date(later) }),
    );
  });

  it('stops watching a charge that expired more than ten minutes ago', async () => {
    const store = new InMemoryPosStore();
    await store.create(charge('c1'));
    await store.recordInvoice('c1', HASH_A, NOW);
    const net = network(new Map(), new Map([[HASH_A, settled]]));
    const expiresAt = NOW - 1_000 + POS_CHARGE_TTL_MS;
    await runPosPaidTick({
      store,
      lnurlServer: LNURL,
      fetchImpl: net.fetchImpl,
      now: () => expiresAt + POS_PAID_WATCH_MS,
    });
    expect(net.fetchImpl).not.toHaveBeenCalled();
    expect((await status(store, 'c1'))?.status).toBe('pending');
  });

  it('never pays a cancelled charge', async () => {
    const store = new InMemoryPosStore();
    await store.create(charge('c1', { sparkInvoice: 'spark1one' }));
    await store.recordInvoice('c1', HASH_A, NOW);
    await store.cancelPending('acc-c1', NOW);
    const net = network(new Map([['spark1one', 2]]), new Map([[HASH_A, settled]]));
    await runPosPaidTick({
      store,
      lnurlServer: LNURL,
      operatorUrl: OPERATOR_URL,
      fetchImpl: net.fetchImpl,
      now: () => NOW,
    });
    expect(net.fetchImpl).not.toHaveBeenCalled();
    expect((await status(store, 'c1'))?.status).toBe('cancelled');
  });

  it('counts unreachable, non-200, and unreadable verify answers once per tick', async () => {
    const store = new InMemoryPosStore();
    await store.create(charge('c1'));
    const hashes = ['1', '2', '3', '4', '5'].map((digit) => digit.repeat(64));
    for (const hash of hashes) {
      await store.recordInvoice('c1', hash, NOW);
    }
    const net = network(
      new Map(),
      new Map([
        [
          hashes[0] as string,
          () => {
            throw new Error('down');
          },
        ],
        [hashes[1] as string, () => new Response('{}', { status: 404 })],
        [hashes[2] as string, () => new Response('not json')],
        [hashes[3] as string, () => new Response('null')],
      ]),
    );
    await runPosPaidTick({ store, lnurlServer: LNURL, fetchImpl: net.fetchImpl, now: () => NOW });
    expect(net.verified).toEqual(hashes);
    expect((await status(store, 'c1'))?.status).toBe('pending');
    expect(events().filter((e) => e['event'] === 'pos.verify.failed')).toEqual([
      expect.objectContaining({ failures: 3 }),
    ]);
  });

  it('does not log pos.verify.failed when every answer was readable', async () => {
    const store = new InMemoryPosStore();
    await store.create(charge('c1'));
    await store.recordInvoice('c1', HASH_A, NOW);
    const net = network(new Map(), new Map());
    await runPosPaidTick({ store, lnurlServer: LNURL, fetchImpl: net.fetchImpl, now: () => NOW });
    expect(events().some((e) => e['event'] === 'pos.verify.failed')).toBe(false);
  });
});

describe('startPosPaidWorker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function blockingStore(listWatched: PosStore['listWatched']): PosStore {
    const base = new InMemoryPosStore();
    return Object.assign(base, { listWatched });
  }

  it('ticks now and on the Spark worker interval without overlapping, and stops', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const listWatched = vi.fn(
      () =>
        new Promise<never[]>((resolve) => {
          release = () => resolve([]);
        }),
    );
    const handle = startPosPaidWorker({
      store: blockingStore(listWatched),
      lnurlServer: LNURL,
      fetchImpl: vi.fn(),
      now: () => NOW,
    });
    expect(listWatched).toHaveBeenCalledTimes(1);
    expect(listWatched).toHaveBeenCalledWith(NOW - POS_PAID_WATCH_MS);
    await vi.advanceTimersByTimeAsync(SPARK_WORKER_INTERVAL_MS * 3);
    expect(listWatched).toHaveBeenCalledTimes(1);
    release?.();
    await vi.advanceTimersByTimeAsync(SPARK_WORKER_INTERVAL_MS);
    expect(listWatched).toHaveBeenCalledTimes(2);
    handle.stop();
    release?.();
    await vi.advanceTimersByTimeAsync(SPARK_WORKER_INTERVAL_MS * 3);
    expect(listWatched).toHaveBeenCalledTimes(2);
  });

  it('logs a failed tick and keeps running', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const listWatched = vi.fn(() => Promise.reject(new Error('db down')));
    const handle = startPosPaidWorker(
      { store: blockingStore(listWatched), lnurlServer: LNURL, fetchImpl: vi.fn(), now: () => NOW },
      1000,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(listWatched).toHaveBeenCalledTimes(2);
    const failed = warn.mock.calls
      .map((call) => call[0])
      .filter(
        (arg): arg is string => typeof arg === 'string' && arg.includes('pos.worker.tick.failed'),
      );
    expect(failed).toHaveLength(2);
    handle.stop();
    warn.mockRestore();
  });
});
