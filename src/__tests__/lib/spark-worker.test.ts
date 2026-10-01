import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPublicKey, verifyEvent } from 'nostr-tools/pure';
import type { FreePaymentsConfig } from '@/lib/config';
import { concatBytes, decodeProto, protoBytesField, protoVarintField } from '@/lib/protobuf';
import { RecordingPublisher } from '@/lib/nostr/publish';
import type { NostrEventFrame } from '@/lib/nostr/query';
import { zapReceiptSecretKey } from '@/lib/nostr/zap-receipt';
import {
  InMemorySparkInvoiceStore,
  type SparkInvoiceIssue,
  type SparkInvoiceStore,
} from '@/lib/spark-invoice-store';
import {
  SPARK_INVOICE_WINDOW_MS,
  SPARK_WORKER_INTERVAL_MS,
  runSparkInvoiceTick,
  startSparkInvoiceWorker,
  type SparkWorkerDeps,
} from '@/lib/spark-worker';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const OWNER = '0209cb7d2b5d3df3a0ac4ef86cfcfa229ffa52b687d797274c8669cbd5235eccd5';
const config: FreePaymentsConfig = {
  zapNsec: new Uint8Array(32).fill(0x11),
  operatorUrl: 'https://op.example',
};
const zapRequest = (relays: string[] = ['wss://relay.one', 'wss://relay.two']): string =>
  JSON.stringify({
    id: 'dd'.repeat(32),
    pubkey: 'aa'.repeat(32),
    created_at: 1,
    kind: 9734,
    tags: [
      ['p', 'bb'.repeat(32)],
      ['e', 'cc'.repeat(32)],
      ...(relays.length > 0 ? [['relays', ...relays]] : []),
    ],
    content: '',
    sig: 'ee'.repeat(64),
  });

function row(n: number, partial: Partial<SparkInvoiceIssue> = {}): SparkInvoiceIssue {
  return {
    paymentHash: n.toString(16).padStart(64, '0'),
    invoice: `spark1inv${n}`,
    receiverPubkey: OWNER,
    amountSats: 21,
    bolt11: `lnbc21n1pr${n}`,
    zapRequest: zapRequest(),
    createdAt: new Date(NOW - 1000),
    ...partial,
  };
}

type Reply = { status?: number; transferId?: Uint8Array };

function frame(flags: number, payload: Uint8Array): Uint8Array {
  const header = new Uint8Array(5);
  header[0] = flags;
  new DataView(header.buffer).setUint32(1, payload.byteLength);
  return concatBytes(header, payload);
}

function requestedInvoices(body: unknown): string[] {
  const bytes = body as Uint8Array;
  return decodeProto(bytes.subarray(5))
    .filter((f) => f.field === 3)
    .map((f) => new TextDecoder().decode(f.value as Uint8Array));
}

/** Fake coordinator: answers each requested invoice from `replies` (missing → omitted). */
function operator(
  replies: Map<string, Reply>,
  extra: (invoices: string[]) => Uint8Array[] = () => [],
): ReturnType<typeof vi.fn> & { batches: string[][] } {
  const batches: string[][] = [];
  const fn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const invoices = requestedInvoices(init?.body);
    batches.push(invoices);
    const entries = invoices.flatMap((invoice) => {
      const reply = replies.get(invoice);
      if (reply === undefined) {
        return [];
      }
      return [
        protoBytesField(
          2,
          concatBytes(
            protoBytesField(1, invoice),
            ...(reply.status === undefined ? [] : [protoVarintField(2, reply.status)]),
            ...(reply.transferId === undefined
              ? []
              : [protoBytesField(3, protoBytesField(1, reply.transferId))]),
          ),
        ),
      ];
    });
    return new Response(
      concatBytes(
        frame(0, concatBytes(...entries, ...extra(invoices))),
        frame(0x80, new TextEncoder().encode('grpc-status: 0')),
      ),
      { status: 200 },
    );
  });
  return Object.assign(fn, { batches });
}

function deps(
  store: SparkInvoiceStore,
  fetchImpl: SparkWorkerDeps['fetchImpl'],
  overrides: Partial<SparkWorkerDeps> = {},
): SparkWorkerDeps & { ingested: NostrEventFrame[]; publisher: RecordingPublisher } {
  const ingested: NostrEventFrame[] = [];
  const publisher = new RecordingPublisher();
  return {
    store,
    config,
    fetchImpl,
    publisher,
    ingest: async (event) => {
      ingested.push(event);
    },
    now: () => NOW,
    ingested,
    ...overrides,
  } as SparkWorkerDeps & { ingested: NostrEventFrame[]; publisher: RecordingPublisher };
}

function events(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('runSparkInvoiceTick', () => {
  it('turns a finalized invoice into exactly one ingested and published receipt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new InMemorySparkInvoiceStore();
    await store.issue(row(1));
    const replies = new Map<string, Reply>([['spark1inv1', { status: 1 }]]);
    const fetchImpl = operator(replies);
    const d = deps(store, fetchImpl);

    await runSparkInvoiceTick(d);
    expect(d.ingested).toHaveLength(0);

    replies.set('spark1inv1', { status: 2, transferId: Uint8Array.of(0xab, 0xcd) });
    await runSparkInvoiceTick(d);
    expect(d.ingested).toHaveLength(1);
    const receipt = d.ingested[0] as NostrEventFrame;
    expect(receipt.kind).toBe(9735);
    expect(receipt.pubkey).toBe(getPublicKey(zapReceiptSecretKey(config.zapNsec, OWNER)));
    expect(verifyEvent(receipt as Parameters<typeof verifyEvent>[0])).toBe(true);
    expect(receipt.tags).toContainEqual(['bolt11', 'lnbc21n1pr1']);
    expect(receipt.tags).toContainEqual(['description', zapRequest()]);
    expect(receipt.tags).toContainEqual(['P', 'aa'.repeat(32)]);
    expect(receipt.tags.some((t) => t[0] === 'preimage')).toBe(false);
    expect(d.publisher.calls).toHaveLength(1);
    expect(d.publisher.calls[0]?.urls).toEqual(['wss://relay.one', 'wss://relay.two']);
    expect(d.publisher.calls[0]?.event['id']).toBe(receipt.id);
    expect(await store.listOpen(new Date(0))).toEqual([]);
    expect(events(warn)).toContainEqual(
      expect.objectContaining({ event: 'spark.invoice.settled', paymentHash: row(1).paymentHash }),
    );

    await runSparkInvoiceTick(d);
    expect(d.ingested).toHaveLength(1);
    expect(fetchImpl.mock.calls).toHaveLength(2);
  });

  it('records the transfer id and receipt id when settling', async () => {
    const store = new InMemorySparkInvoiceStore();
    await store.issue(row(1));
    const settle = vi.spyOn(store, 'markSettled');
    const d = deps(
      store,
      operator(new Map([['spark1inv1', { status: 2, transferId: Uint8Array.of(1, 2) }]])),
    );
    await runSparkInvoiceTick(d);
    expect(settle).toHaveBeenCalledWith(row(1).paymentHash, '0102', d.ingested[0]?.id);
  });

  it('settles a finalized invoice without a transfer id with a null transfer id', async () => {
    const store = new InMemorySparkInvoiceStore();
    await store.issue(row(1));
    const settle = vi.spyOn(store, 'markSettled');
    const d = deps(store, operator(new Map([['spark1inv1', { status: 2 }]])));
    await runSparkInvoiceTick(d);
    expect(settle).toHaveBeenCalledWith(row(1).paymentHash, null, d.ingested[0]?.id);
  });

  it('does nothing for not found, pending, returned, mismatched, and unknown statuses', async () => {
    const store = new InMemorySparkInvoiceStore();
    for (let n = 1; n <= 7; n += 1) {
      await store.issue(row(n));
    }
    const d = deps(
      store,
      operator(
        new Map<string, Reply>([
          ['spark1inv1', {}],
          ['spark1inv2', { status: 1 }],
          ['spark1inv3', { status: 4 }],
          ['spark1inv4', { status: 5 }],
          ['spark1inv5', { status: 6 }],
          ['spark1inv6', { status: 7 }],
          ['spark1inv7', { status: 9 }],
        ]),
      ),
    );
    await runSparkInvoiceTick(d);
    expect(d.ingested).toEqual([]);
    expect(d.publisher.calls).toEqual([]);
    expect(await store.listOpen(new Date(0))).toHaveLength(7);
  });

  it('queries in batches of 100', async () => {
    const store = new InMemorySparkInvoiceStore();
    for (let n = 1; n <= 250; n += 1) {
      await store.issue(row(n, { createdAt: new Date(NOW - 100_000 + n) }));
    }
    const fetchImpl = operator(new Map());
    await runSparkInvoiceTick(deps(store, fetchImpl));
    expect(fetchImpl.batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(fetchImpl.batches[0]?.[0]).toBe('spark1inv1');
    expect(fetchImpl.batches[2]?.[49]).toBe('spark1inv250');
  });

  it('polls only invoices issued in the last 60 minutes', async () => {
    const store = new InMemorySparkInvoiceStore();
    await store.issue(row(1, { createdAt: new Date(NOW - SPARK_INVOICE_WINDOW_MS) }));
    await store.issue(row(2, { createdAt: new Date(NOW - SPARK_INVOICE_WINDOW_MS - 1) }));
    const fetchImpl = operator(new Map());
    await runSparkInvoiceTick(deps(store, fetchImpl));
    expect(fetchImpl.batches).toEqual([['spark1inv1']]);
  });

  it('does not call the coordinator when nothing is open', async () => {
    const fetchImpl = operator(new Map());
    await runSparkInvoiceTick(deps(new InMemorySparkInvoiceStore(), fetchImpl));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('logs a failed batch and continues with the next one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new InMemorySparkInvoiceStore();
    for (let n = 1; n <= 201; n += 1) {
      await store.issue(row(n, { createdAt: new Date(NOW - 100_000 + n) }));
    }
    const good = operator(new Map([['spark1inv201', { status: 2 }]]));
    let call = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        return new Response(null, { status: 200, headers: { 'grpc-status': '14' } });
      }
      if (call === 2) {
        return new Response('', { status: 502 });
      }
      return good(url, init);
    });
    const d = deps(store, fetchImpl);
    await runSparkInvoiceTick(d);
    const failed = events(warn).filter((e) => e['event'] === 'spark.query.failed');
    expect(failed).toEqual([
      expect.objectContaining({ reason: 'grpc', grpcStatus: 14 }),
      expect.objectContaining({ reason: 'http' }),
    ]);
    expect(failed[1]).not.toHaveProperty('grpcStatus');
    expect(d.ingested).toHaveLength(1);
  });

  it('ignores invoices that are not in the batch and settles a repeated entry once', async () => {
    const store = new InMemorySparkInvoiceStore();
    await store.issue(row(1));
    const fetchImpl = operator(new Map([['spark1inv1', { status: 2 }]]), () => [
      protoBytesField(2, concatBytes(protoBytesField(1, 'spark1inv1'), protoVarintField(2, 2))),
      protoBytesField(2, concatBytes(protoBytesField(1, 'spark1stranger'), protoVarintField(2, 2))),
    ]);
    const d = deps(store, fetchImpl);
    await runSparkInvoiceTick(d);
    expect(d.ingested).toHaveLength(1);
    expect(d.publisher.calls).toHaveLength(1);
  });

  it('skips publishing when the zap request names no relays', async () => {
    const store = new InMemorySparkInvoiceStore();
    await store.issue(row(1, { zapRequest: zapRequest([]) }));
    const d = deps(store, operator(new Map([['spark1inv1', { status: 2 }]])));
    await runSparkInvoiceTick(d);
    expect(d.ingested).toHaveLength(1);
    expect(d.publisher.calls).toEqual([]);
    expect(await store.listOpen(new Date(0))).toEqual([]);
  });

  it('still settles when publishing fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new InMemorySparkInvoiceStore();
    await store.issue(row(1));
    const d = deps(store, operator(new Map([['spark1inv1', { status: 2 }]])));
    vi.spyOn(d.publisher, 'publish').mockRejectedValue(new Error('relay down'));
    await runSparkInvoiceTick(d);
    expect(events(warn)).toContainEqual(
      expect.objectContaining({ event: 'spark.receipt.publish_failed' }),
    );
    expect(d.ingested).toHaveLength(1);
    expect(await store.listOpen(new Date(0))).toEqual([]);
  });

  it('keeps a row open when its zap request cannot become a receipt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new InMemorySparkInvoiceStore();
    await store.issue(row(1, { zapRequest: '{' }));
    const d = deps(store, operator(new Map([['spark1inv1', { status: 2 }]])));
    await runSparkInvoiceTick(d);
    expect(events(warn)).toContainEqual(
      expect.objectContaining({ event: 'spark.receipt.invalid', paymentHash: row(1).paymentHash }),
    );
    expect(d.ingested).toEqual([]);
    expect(await store.listOpen(new Date(0))).toHaveLength(1);
  });

  it('does not log settled when another tick settled the row first', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new InMemorySparkInvoiceStore();
    await store.issue(row(1));
    vi.spyOn(store, 'markSettled').mockResolvedValue(false);
    const d = deps(store, operator(new Map([['spark1inv1', { status: 2 }]])));
    await runSparkInvoiceTick(d);
    expect(d.ingested).toHaveLength(1);
    expect(events(warn).some((e) => e['event'] === 'spark.invoice.settled')).toBe(false);
  });
});

describe('startSparkInvoiceWorker', () => {
  it('ticks now and on the interval without overlapping, and stops', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const listOpen = vi.fn(
      () =>
        new Promise<never[]>((resolve) => {
          release = () => resolve([]);
        }),
    );
    const store: SparkInvoiceStore = {
      issue: vi.fn(),
      listOpen,
      markSettled: vi.fn(),
    };
    const handle = startSparkInvoiceWorker(deps(store, vi.fn()));
    expect(listOpen).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SPARK_WORKER_INTERVAL_MS * 3);
    expect(listOpen).toHaveBeenCalledTimes(1);
    release?.();
    await vi.advanceTimersByTimeAsync(SPARK_WORKER_INTERVAL_MS);
    expect(listOpen).toHaveBeenCalledTimes(2);
    handle.stop();
    release?.();
    await vi.advanceTimersByTimeAsync(SPARK_WORKER_INTERVAL_MS * 3);
    expect(listOpen).toHaveBeenCalledTimes(2);
  });

  it('logs a failed tick and keeps running', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const listOpen = vi.fn(() => Promise.reject(new Error('db down')));
    const store: SparkInvoiceStore = { issue: vi.fn(), listOpen, markSettled: vi.fn() };
    const handle = startSparkInvoiceWorker(deps(store, vi.fn()), 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(listOpen).toHaveBeenCalledTimes(2);
    expect(events(warn).filter((e) => e['event'] === 'spark.worker.tick.failed')).toHaveLength(2);
    handle.stop();
  });
});
