import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LnurlServerConfig } from '@/lib/config';
import {
  FOND_CLAIM_LEASE_MS,
  InMemoryFondPayoutStore,
  type FondPayoutRow,
} from '@/lib/fond-payout-store';
import { runFondPaidTick, startFondPaidWorker } from '@/lib/fond-paid-worker';
import { setDiagnosticSink, type LogFields } from '@/lib/log';
import { concatBytes, decodeProto, protoBytesField, protoVarintField } from '@/lib/protobuf';
import { settleProvenGift, type GiftActionDeps } from '@/routes/invoices';
import { SPARK_WORKER_INTERVAL_MS } from '@/lib/spark-worker';

vi.mock('@/routes/invoices', () => ({ settleProvenGift: vi.fn() }));

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const TODAY = '2026-11-09';
const YESTERDAY = '2026-11-08';
const OPERATOR_URL = 'https://op.example';
const FOND_USERNAME = 'tondo-fond';
const HASH = 'aa'.repeat(32);
const BOLT11 = 'lnbc1fond';
const SPARK = 'spark1fond';
const LNURL: LnurlServerConfig = {
  baseUrl: 'https://lnurl.test',
  publicBaseUrl: 'https://gifts.test',
  host: 'gifts.test',
};

const mockedSettle = vi.mocked(settleProvenGift);

interface GiftLookup {
  hasOutboundInvoice?: (lightningInvoice: string) => Promise<boolean>;
}

function actions(giftStore?: GiftLookup | object): GiftActionDeps {
  return actionDeps(giftStore);
}

function actionDeps(giftStore?: GiftLookup | object): GiftActionDeps {
  return { giftStore } as unknown as GiftActionDeps;
}

function frame(flags: number, payload: Uint8Array): Uint8Array {
  const header = new Uint8Array(5);
  header[0] = flags;
  new DataView(header.buffer).setUint32(1, payload.byteLength);
  return concatBytes(header, payload);
}

function requestedInvoices(body: unknown): string[] {
  return decodeProto((body as Uint8Array).subarray(5))
    .filter((field) => field.field === 3)
    .map((field) => new TextDecoder().decode(field.value as Uint8Array));
}

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

async function invoiced(
  store: InMemoryFondPayoutStore,
  partial: Partial<{
    id: string;
    utcDay: string;
    address: string;
    kind: 'daily' | 'moderator' | 'welcome';
    messageId: string | null;
    groupMessageId: string | null;
    paymentHash: string | null;
    bolt11: string;
    sparkInvoice: string | null;
  }> = {},
): Promise<FondPayoutRow> {
  const id = partial.id ?? 'row-a';
  const utcDay = partial.utcDay ?? TODAY;
  await store.enqueue({
    id,
    utcDay,
    kind: partial.kind ?? 'daily',
    address: partial.address ?? `${id}@example.com`,
    amountUsd: '1.00',
    comment: 'thanks',
    messageId: partial.messageId === undefined ? 'm' : partial.messageId,
    groupMessageId: partial.groupMessageId ?? null,
  });
  await store.claimForInvoice(id, utcDay);
  return (await store.setInvoiced(id, {
    invoiceId: `inv-${id}`,
    paymentHash: partial.paymentHash === undefined ? HASH : (partial.paymentHash as string),
    bolt11: partial.bolt11 ?? BOLT11,
    sparkInvoice: partial.sparkInvoice ?? null,
    amountMsat: 1000,
  })) as FondPayoutRow;
}

let warn: ReturnType<typeof vi.spyOn>;
let logged: Array<{ event: string; fields: LogFields | undefined }>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  logged = [];
  setDiagnosticSink((event, fields) => {
    logged.push({ event, fields });
  });
  mockedSettle.mockReset();
  mockedSettle.mockResolvedValue(undefined);
});

afterEach(() => {
  setDiagnosticSink(null);
  warn.mockRestore();
  vi.useRealTimers();
});

function eventNames(): string[] {
  return logged.map((entry) => entry.event);
}

describe('runFondPaidTick', () => {
  it('settles a finalized Spark invoice once with the Fond source wallet', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    await invoiced(store, { sparkInvoice: SPARK, address: 'ada@example.com' });
    const net = network(new Map([[SPARK, 2]]), new Map([[HASH, settled]]));
    await runFondPaidTick({
      store,
      lnurlServer: LNURL,
      operatorUrl: OPERATOR_URL,
      fetchImpl: net.fetchImpl,
      now: () => NOW,
      fondUsername: FOND_USERNAME,
      actions: actions(),
    });

    expect(net.sparkBatches).toEqual([[SPARK]]);
    expect(net.verified).toEqual([]);
    expect(mockedSettle).toHaveBeenCalledTimes(1);
    expect(mockedSettle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: 'inv-row-a',
        address: 'ada@example.com',
        pr: BOLT11,
        paymentHash: HASH,
        amountMsat: 1000,
        createdAt: NOW,
        expiresAt: NOW,
        comment: 'thanks',
        messageId: 'm',
        amountUsd: '1.00',
      }),
      NOW,
      FOND_USERNAME,
      { usd: '1.00', chf: null, eur: null, php: null },
      'daily',
    );
    expect(mockedSettle.mock.calls[0]?.[1]).not.toHaveProperty('groupMessageId');
    expect(await store.get('row-a')).toMatchObject({ status: 'paid', claimedAt: null });
    expect(eventNames()).toContain('fond.payout.paid');
  });

  it('settles when LUD-21 reports the BOLT11 payment hash settled', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    await invoiced(store, {
      kind: 'moderator',
      messageId: null,
      groupMessageId: 'g',
      address: 'ada@example.com',
    });
    const net = network(new Map(), new Map([[HASH, settled]]));
    await runFondPaidTick({
      store,
      lnurlServer: LNURL,
      fetchImpl: net.fetchImpl,
      now: () => NOW,
      fondUsername: FOND_USERNAME,
      actions: actions(),
    });

    expect(net.verified).toEqual([HASH]);
    expect(mockedSettle).toHaveBeenCalledTimes(1);
    expect(mockedSettle.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ groupMessageId: 'g' }),
    );
    expect(mockedSettle.mock.calls[0]?.[1]).not.toHaveProperty('messageId');
    expect(mockedSettle.mock.calls[0]?.[5]).toBe('moderator');
    expect((await store.get('row-a'))?.status).toBe('paid');
  });

  it('lists today and yesterday, ignores non-invoiced rows, and watches yesterday', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    await store.enqueue({
      id: 'owed',
      utcDay: TODAY,
      kind: 'daily',
      address: 'owed@example.com',
      amountUsd: '1.00',
      comment: 'thanks',
      messageId: null,
      groupMessageId: null,
    });
    await invoiced(store, { id: 'yesterday', utcDay: YESTERDAY });
    const net = network(new Map(), new Map([[HASH, settled]]));
    await runFondPaidTick({
      store,
      lnurlServer: LNURL,
      fetchImpl: net.fetchImpl,
      now: () => NOW,
      fondUsername: FOND_USERNAME,
      actions: actions(),
    });
    expect(net.verified).toEqual([HASH]);
    expect((await store.get('owed'))?.status).toBe('owed');
    expect((await store.get('yesterday'))?.status).toBe('paid');
  });

  it('does nothing for an open invoice', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    await invoiced(store, { sparkInvoice: SPARK });
    const net = network(new Map([[SPARK, 1]]), new Map());
    await runFondPaidTick({
      store,
      lnurlServer: LNURL,
      operatorUrl: OPERATOR_URL,
      fetchImpl: net.fetchImpl,
      now: () => NOW,
      fondUsername: FOND_USERNAME,
      actions: actions(),
    });
    expect(mockedSettle).not.toHaveBeenCalled();
    expect((await store.get('row-a'))?.status).toBe('invoiced');
    expect(eventNames()).not.toContain('fond.payout.paid');
  });

  it('retries after a failed coordinator read and a failed verify read', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    await invoiced(store, { sparkInvoice: SPARK });
    let sparkCalls = 0;
    let verifyCalls = 0;
    const net = network(
      new Map([[SPARK, 2]]),
      new Map([
        [
          HASH,
          () => {
            verifyCalls += 1;
            return verifyCalls === 1 ? new Response('', { status: 500 }) : settled();
          },
        ],
      ]),
      () => {
        sparkCalls += 1;
        return sparkCalls === 1
          ? new Response('', { status: 503 })
          : new Response(operatorBody(new Map([[SPARK, 2]]), [SPARK]), { status: 200 });
      },
    );
    const deps = {
      store,
      lnurlServer: LNURL,
      operatorUrl: OPERATOR_URL,
      fetchImpl: net.fetchImpl,
      now: () => NOW,
      fondUsername: FOND_USERNAME,
      actions: actions(),
    };
    await runFondPaidTick(deps);
    expect(mockedSettle).not.toHaveBeenCalled();
    expect(eventNames()).toContain('fond.paid.spark_query_failed');
    expect((await store.get('row-a'))?.status).toBe('invoiced');

    await runFondPaidTick(deps);
    expect(mockedSettle).toHaveBeenCalledTimes(1);
    expect((await store.get('row-a'))?.status).toBe('paid');
  });

  it('counts verify failures and settles on the next tick', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    await invoiced(store);
    let calls = 0;
    const net = network(new Map(), new Map(), undefined);
    net.fetchImpl.mockImplementation(async (input: string | URL | Request) => {
      calls += 1;
      if (calls === 1) {
        return new Response('', { status: 500 });
      }
      void input;
      return settled();
    });
    const deps = {
      store,
      lnurlServer: LNURL,
      fetchImpl: net.fetchImpl,
      now: () => NOW,
      fondUsername: FOND_USERNAME,
      actions: actions(),
    };
    await runFondPaidTick(deps);
    expect(mockedSettle).not.toHaveBeenCalled();
    expect(logged).toContainEqual(
      expect.objectContaining({ event: 'fond.paid.verify_failed', fields: { failures: 1 } }),
    );

    await runFondPaidTick(deps);
    expect(mockedSettle).toHaveBeenCalledTimes(1);
  });

  it('settles a concurrently confirmed row only once', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    await invoiced(store);
    const net = network(new Map(), new Map([[HASH, settled]]));
    const deps = {
      store,
      lnurlServer: LNURL,
      fetchImpl: net.fetchImpl,
      now: () => NOW,
      fondUsername: FOND_USERNAME,
      actions: actions(),
    };
    await Promise.all([runFondPaidTick(deps), runFondPaidTick(deps)]);
    expect(mockedSettle).toHaveBeenCalledTimes(1);
    expect((await store.get('row-a'))?.status).toBe('paid');
  });

  it('releases the claim after a settlement throw and retries next tick', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    await invoiced(store);
    mockedSettle.mockRejectedValueOnce(new Error('down'));
    const net = network(new Map(), new Map([[HASH, settled]]));
    const deps = {
      store,
      lnurlServer: LNURL,
      fetchImpl: net.fetchImpl,
      now: () => NOW,
      fondUsername: FOND_USERNAME,
      actions: actions(),
    };
    await runFondPaidTick(deps);
    expect((await store.get('row-a'))?.status).toBe('invoiced');
    expect(await store.get('row-a')).toMatchObject({ claimedAt: null });
    expect(eventNames()).toContain('fond.proof.failed');

    await runFondPaidTick(deps);
    expect(mockedSettle).toHaveBeenCalledTimes(2);
    expect((await store.get('row-a'))?.status).toBe('paid');
  });

  it('logs when the release after a settlement throw misses or throws', async () => {
    for (const failure of ['undefined', 'throw'] as const) {
      const store = new InMemoryFondPayoutStore(() => NOW);
      await invoiced(store);
      mockedSettle.mockRejectedValueOnce(new Error('down'));
      const release = vi.spyOn(store, 'releaseSettlement');
      if (failure === 'undefined') {
        release.mockResolvedValueOnce(undefined);
      } else {
        release.mockRejectedValueOnce(new Error('down'));
      }
      const net = network(new Map(), new Map([[HASH, settled]]));
      await runFondPaidTick({
        store,
        lnurlServer: LNURL,
        fetchImpl: net.fetchImpl,
        now: () => NOW,
        fondUsername: FOND_USERNAME,
        actions: actions(),
      });
      expect(eventNames()).toContain('fond.proof.revert_failed');
    }
  });

  it('leaves a recorded gift recoverable when markPaid misses or throws', async () => {
    for (const failure of ['undefined', 'throw'] as const) {
      const store = new InMemoryFondPayoutStore(() => NOW);
      await invoiced(store);
      const markPaid = vi.spyOn(store, 'markPaid');
      if (failure === 'undefined') {
        markPaid.mockResolvedValueOnce(undefined);
      } else {
        markPaid.mockRejectedValueOnce(new Error('down'));
      }
      const net = network(new Map(), new Map([[HASH, settled]]));
      await runFondPaidTick({
        store,
        lnurlServer: LNURL,
        fetchImpl: net.fetchImpl,
        now: () => NOW,
        fondUsername: FOND_USERNAME,
        actions: actions(),
      });
      expect(await store.get('row-a')).toMatchObject({ status: 'settling' });
      expect(eventNames()).toContain('fond.proof.failed');
    }
  });

  it('logs a failed claim and a failed re-read', async () => {
    for (const failure of ['claim', 'read'] as const) {
      const store = new InMemoryFondPayoutStore(() => NOW);
      await invoiced(store);
      if (failure === 'claim') {
        vi.spyOn(store, 'claimSettlement').mockRejectedValueOnce(new Error('down'));
      } else {
        vi.spyOn(store, 'claimSettlement').mockResolvedValueOnce(undefined);
        vi.spyOn(store, 'get').mockRejectedValueOnce(new Error('down'));
      }
      const net = network(new Map(), new Map([[HASH, settled]]));
      await runFondPaidTick({
        store,
        lnurlServer: LNURL,
        fetchImpl: net.fetchImpl,
        now: () => NOW,
        fondUsername: FOND_USERNAME,
        actions: actions(),
      });
      expect(eventNames()).toContain('fond.proof.failed');
      expect(mockedSettle).not.toHaveBeenCalled();
    }
  });

  it('recognizes an already-paid row after losing the settlement claim', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    await invoiced(store);
    await store.claimSettlement('row-a');
    await store.markPaid('row-a');
    const paid = (await store.get('row-a')) as FondPayoutRow;
    vi.spyOn(store, 'listOpen').mockResolvedValueOnce([{ ...paid, status: 'invoiced' }]);
    vi.spyOn(store, 'claimSettlement').mockResolvedValueOnce(undefined);
    const net = network(new Map(), new Map([[HASH, settled]]));
    await runFondPaidTick({
      store,
      lnurlServer: LNURL,
      fetchImpl: net.fetchImpl,
      now: () => NOW,
      fondUsername: FOND_USERNAME,
      actions: actions(),
    });
    expect(eventNames()).toContain('fond.payout.paid');
    expect(mockedSettle).not.toHaveBeenCalled();
  });

  it('does nothing after losing the claim to another non-paid state', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    await invoiced(store);
    vi.spyOn(store, 'claimSettlement').mockResolvedValueOnce(undefined);
    const net = network(new Map(), new Map([[HASH, settled]]));
    await runFondPaidTick({
      store,
      lnurlServer: LNURL,
      fetchImpl: net.fetchImpl,
      now: () => NOW,
      fondUsername: FOND_USERNAME,
      actions: actions(),
    });
    expect(mockedSettle).not.toHaveBeenCalled();
    expect(eventNames()).not.toContain('fond.payout.paid');
  });

  it('does nothing when the lost-claim re-read finds no row', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    await invoiced(store);
    vi.spyOn(store, 'claimSettlement').mockResolvedValueOnce(undefined);
    vi.spyOn(store, 'get').mockResolvedValueOnce(undefined);
    const net = network(new Map(), new Map([[HASH, settled]]));
    await runFondPaidTick({
      store,
      lnurlServer: LNURL,
      fetchImpl: net.fetchImpl,
      now: () => NOW,
      fondUsername: FOND_USERNAME,
      actions: actions(),
    });
    expect(mockedSettle).not.toHaveBeenCalled();
    expect(eventNames()).not.toContain('fond.payout.paid');
  });

  it.each(['invoiceId', 'bolt11', 'paymentHash', 'amountMsat'] as const)(
    'releases a claimed row with a null %s',
    async (field) => {
      const store = new InMemoryFondPayoutStore(() => NOW);
      const row = await invoiced(store);
      const release = vi.spyOn(store, 'releaseSettlement');
      vi.spyOn(store, 'claimSettlement').mockResolvedValueOnce({ ...row, [field]: null });
      const net = network(new Map(), new Map([[HASH, settled]]));
      await runFondPaidTick({
        store,
        lnurlServer: LNURL,
        fetchImpl: net.fetchImpl,
        now: () => NOW,
        fondUsername: FOND_USERNAME,
        actions: actions(),
      });
      expect(release).toHaveBeenCalledWith('row-a');
      expect(mockedSettle).not.toHaveBeenCalled();
      expect(eventNames()).toContain('fond.proof.failed');
    },
  );

  it('recovers a stale settling row whose gift already exists', async () => {
    let clock = NOW;
    const store = new InMemoryFondPayoutStore(() => clock);
    await invoiced(store);
    await store.claimSettlement('row-a');
    clock = NOW + FOND_CLAIM_LEASE_MS + 1;
    const lookup = vi.fn(async () => true);
    const net = network(new Map(), new Map([[HASH, settled]]));
    await runFondPaidTick({
      store,
      lnurlServer: LNURL,
      fetchImpl: net.fetchImpl,
      now: () => clock,
      fondUsername: FOND_USERNAME,
      actions: actions({ hasOutboundInvoice: lookup }),
    });
    expect(lookup).toHaveBeenCalledWith(BOLT11);
    expect((await store.get('row-a'))?.status).toBe('paid');
    expect(mockedSettle).not.toHaveBeenCalled();
    expect(eventNames()).toContain('fond.payout.paid');
  });

  it('skips a fresh settling row and one without a claim time', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    await invoiced(store);
    await store.claimSettlement('row-a');
    const settlingRow = (await store.get('row-a')) as FondPayoutRow;
    const listOpen = vi
      .spyOn(store, 'listOpen')
      .mockResolvedValueOnce([settlingRow])
      .mockResolvedValueOnce([{ ...settlingRow, claimedAt: null }]);
    const net = network(new Map(), new Map([[HASH, settled]]));
    await runFondPaidTick({
      store,
      lnurlServer: LNURL,
      fetchImpl: net.fetchImpl,
      now: () => NOW,
      fondUsername: FOND_USERNAME,
      actions: actions(),
    });
    expect(listOpen).toHaveBeenCalledTimes(2);
    expect(net.fetchImpl).not.toHaveBeenCalled();
    expect(mockedSettle).not.toHaveBeenCalled();
  });

  it('restores a stale settling row without a gift lookup and verifies it', async () => {
    for (const deps of [actions(), actions({})]) {
      let clock = NOW;
      const store = new InMemoryFondPayoutStore(() => clock);
      await invoiced(store);
      await store.claimSettlement('row-a');
      clock = NOW + FOND_CLAIM_LEASE_MS + 1;
      const net = network(new Map(), new Map([[HASH, settled]]));
      await runFondPaidTick({
        store,
        lnurlServer: LNURL,
        fetchImpl: net.fetchImpl,
        now: () => clock,
        fondUsername: FOND_USERNAME,
        actions: deps,
      });
      expect((await store.get('row-a'))?.status).toBe('paid');
      expect(mockedSettle).toHaveBeenCalledTimes(1);
      mockedSettle.mockClear();
    }
  });

  it('uses an empty invoice for the gift lookup when a stale row has no BOLT11', async () => {
    let clock = NOW;
    const store = new InMemoryFondPayoutStore(() => clock);
    await invoiced(store, { bolt11: '' });
    await store.claimSettlement('row-a');
    clock = NOW + FOND_CLAIM_LEASE_MS + 1;
    const lookup = vi.fn(async () => false);
    const net = network(new Map(), new Map());
    await runFondPaidTick({
      store,
      lnurlServer: LNURL,
      fetchImpl: net.fetchImpl,
      now: () => clock,
      fondUsername: FOND_USERNAME,
      actions: actions({ hasOutboundInvoice: lookup }),
    });
    expect(lookup).toHaveBeenCalledWith('');
  });

  it('uses an empty invoice for the gift lookup when a stale row has a null BOLT11', async () => {
    let clock = NOW;
    const store = new InMemoryFondPayoutStore(() => clock);
    await invoiced(store);
    await store.claimSettlement('row-a');
    const settling = (await store.get('row-a')) as FondPayoutRow;
    vi.spyOn(store, 'listOpen').mockResolvedValueOnce([{ ...settling, bolt11: null }]);
    clock = NOW + FOND_CLAIM_LEASE_MS + 1;
    const lookup = vi.fn(async () => false);
    const net = network(new Map(), new Map());
    await runFondPaidTick({
      store,
      lnurlServer: LNURL,
      fetchImpl: net.fetchImpl,
      now: () => clock,
      fondUsername: FOND_USERNAME,
      actions: actions({ hasOutboundInvoice: lookup }),
    });
    expect(lookup).toHaveBeenCalledWith('');
  });

  it('leaves a stale row alone when the gift lookup throws', async () => {
    let clock = NOW;
    const store = new InMemoryFondPayoutStore(() => clock);
    await invoiced(store);
    await store.claimSettlement('row-a');
    clock = NOW + FOND_CLAIM_LEASE_MS + 1;
    const lookup = vi.fn(async () => {
      throw new Error('down');
    });
    const net = network(new Map(), new Map());
    await runFondPaidTick({
      store,
      lnurlServer: LNURL,
      fetchImpl: net.fetchImpl,
      now: () => clock,
      fondUsername: FOND_USERNAME,
      actions: actions({ hasOutboundInvoice: lookup }),
    });
    expect((await store.get('row-a'))?.status).toBe('settling');
    expect(eventNames()).toContain('fond.proof.failed');
  });

  it('leaves a stale row alone when marking it paid misses or throws', async () => {
    for (const failure of ['undefined', 'throw'] as const) {
      let clock = NOW;
      const store = new InMemoryFondPayoutStore(() => clock);
      await invoiced(store);
      await store.claimSettlement('row-a');
      clock = NOW + FOND_CLAIM_LEASE_MS + 1;
      const mark = vi.spyOn(store, 'markStaleSettlingPaid');
      if (failure === 'undefined') {
        mark.mockResolvedValueOnce(undefined);
      } else {
        mark.mockRejectedValueOnce(new Error('down'));
      }
      const net = network(new Map(), new Map());
      await runFondPaidTick({
        store,
        lnurlServer: LNURL,
        fetchImpl: net.fetchImpl,
        now: () => clock,
        fondUsername: FOND_USERNAME,
        actions: actions({ hasOutboundInvoice: async () => true }),
      });
      expect(eventNames()).toContain('fond.proof.failed');
    }
  });

  it('leaves a stale row alone when restoring it misses or throws', async () => {
    for (const failure of ['undefined', 'throw'] as const) {
      let clock = NOW;
      const store = new InMemoryFondPayoutStore(() => clock);
      await invoiced(store);
      await store.claimSettlement('row-a');
      clock = NOW + FOND_CLAIM_LEASE_MS + 1;
      const restore = vi.spyOn(store, 'restoreStaleSettling');
      if (failure === 'undefined') {
        restore.mockResolvedValueOnce(undefined);
      } else {
        restore.mockRejectedValueOnce(new Error('down'));
      }
      const net = network(new Map(), new Map());
      await runFondPaidTick({
        store,
        lnurlServer: LNURL,
        fetchImpl: net.fetchImpl,
        now: () => clock,
        fondUsername: FOND_USERNAME,
        actions: actions({ hasOutboundInvoice: async () => false }),
      });
      expect(eventNames()).toContain('fond.proof.failed');
    }
  });

  it('skips a row without a payment hash', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    await invoiced(store, { paymentHash: null });
    const net = network(new Map(), new Map());
    await runFondPaidTick({
      store,
      lnurlServer: LNURL,
      fetchImpl: net.fetchImpl,
      now: () => NOW,
      fondUsername: FOND_USERNAME,
      actions: actions(),
    });
    expect(net.fetchImpl).not.toHaveBeenCalled();
  });

  it('ignores duplicate and unrequested finalized Spark replies', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    await invoiced(store, { sparkInvoice: SPARK });
    const net = network(
      new Map([
        [SPARK, 2],
        ['spark1other', 2],
      ]),
      new Map(),
      () =>
        new Response(
          operatorBody(
            new Map([
              [SPARK, 2],
              ['spark1other', 2],
            ]),
            [SPARK, SPARK, 'spark1other'],
          ),
          { status: 200 },
        ),
    );
    await runFondPaidTick({
      store,
      lnurlServer: LNURL,
      operatorUrl: OPERATOR_URL,
      fetchImpl: net.fetchImpl,
      now: () => NOW,
      fondUsername: FOND_USERNAME,
      actions: actions(),
    });
    expect(mockedSettle).toHaveBeenCalledTimes(1);
  });

  it('polls no Spark invoice for a row without one and still verifies its hash', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    await invoiced(store);
    const net = network(new Map(), new Map());
    await runFondPaidTick({
      store,
      lnurlServer: LNURL,
      operatorUrl: OPERATOR_URL,
      fetchImpl: net.fetchImpl,
      now: () => NOW,
      fondUsername: FOND_USERNAME,
      actions: actions(),
    });
    expect(net.sparkBatches).toEqual([]);
    expect(net.verified).toEqual([HASH]);
  });

  it('logs a gRPC refusal with its status', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    await invoiced(store, { sparkInvoice: SPARK });
    const net = network(
      new Map(),
      new Map(),
      () => new Response(new Uint8Array(0), { status: 200, headers: { 'grpc-status': '14' } }),
    );
    await runFondPaidTick({
      store,
      lnurlServer: LNURL,
      operatorUrl: OPERATOR_URL,
      fetchImpl: net.fetchImpl,
      now: () => NOW,
      fondUsername: FOND_USERNAME,
      actions: actions(),
    });
    expect(logged).toContainEqual(
      expect.objectContaining({
        event: 'fond.paid.spark_query_failed',
        fields: { reason: 'grpc', grpcStatus: 14 },
      }),
    );
  });

  it('batches Spark invoices above the query limit', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    const invoices: string[] = [];
    for (let index = 0; index <= 100; index += 1) {
      const spark = `spark1${String(index).padStart(3, '0')}`;
      invoices.push(spark);
      await invoiced(store, { id: `row-${index}`, sparkInvoice: spark });
    }
    const net = network(
      new Map(invoices.map((invoice) => [invoice, 1])),
      new Map(invoices.map((hash) => [hash, () => new Response('{}')])),
    );
    await runFondPaidTick({
      store,
      lnurlServer: LNURL,
      operatorUrl: OPERATOR_URL,
      fetchImpl: net.fetchImpl,
      now: () => NOW,
      fondUsername: FOND_USERNAME,
      actions: actions(),
    });
    expect(net.sparkBatches.map((batch) => batch.length)).toEqual([100, 1]);
  });

  it('never logs an address, BOLT11, Spark invoice, payment hash, or preimage', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    await invoiced(store, { sparkInvoice: SPARK, address: 'ada@example.com' });
    const net = network(new Map([[SPARK, 2]]), new Map([[HASH, settled]]));
    await runFondPaidTick({
      store,
      lnurlServer: LNURL,
      operatorUrl: OPERATOR_URL,
      fetchImpl: net.fetchImpl,
      now: () => NOW,
      fondUsername: FOND_USERNAME,
      actions: actions(),
    });
    const raw = warn.mock.calls.map((call) => String(call[0])).join('\n');
    const fields = JSON.stringify(logged);
    for (const secret of ['ada@example.com', BOLT11, SPARK, HASH, 'preimage']) {
      expect(raw).not.toContain(secret);
      expect(fields).not.toContain(secret);
    }
  });
});

describe('startFondPaidWorker', () => {
  it('ticks now and on the Spark worker interval without overlapping, and stops', async () => {
    vi.useFakeTimers();
    const store = new InMemoryFondPayoutStore(() => NOW);
    let release: (() => void) | undefined;
    const listOpen = vi.fn(
      () =>
        new Promise<FondPayoutRow[]>((resolve) => {
          release = () => resolve([]);
        }),
    );
    vi.spyOn(store, 'listOpen').mockImplementation(listOpen);
    const handle = startFondPaidWorker({
      store,
      lnurlServer: LNURL,
      fetchImpl: vi.fn(),
      now: () => NOW,
      fondUsername: FOND_USERNAME,
      actions: actions(),
    });
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
    const store = new InMemoryFondPayoutStore(() => NOW);
    const listOpen = vi.fn(() => Promise.reject(new Error('db down')));
    vi.spyOn(store, 'listOpen').mockImplementation(listOpen);
    const handle = startFondPaidWorker(
      {
        store,
        lnurlServer: LNURL,
        fetchImpl: vi.fn(),
        now: () => NOW,
        fondUsername: FOND_USERNAME,
        actions: actions(),
      },
      1000,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(listOpen).toHaveBeenCalledTimes(2);
    expect(eventNames().filter((event) => event === 'fond.paid.tick.failed')).toHaveLength(2);
    handle.stop();
  });

  it('accepts a custom interval', async () => {
    vi.useFakeTimers();
    const store = new InMemoryFondPayoutStore(() => NOW);
    const listOpen = vi.spyOn(store, 'listOpen');
    const handle = startFondPaidWorker(
      {
        store,
        lnurlServer: LNURL,
        fetchImpl: vi.fn(),
        now: () => NOW,
        fondUsername: FOND_USERNAME,
        actions: actions(),
      },
      5000,
    );
    await vi.advanceTimersByTimeAsync(4999);
    expect(listOpen).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(listOpen).toHaveBeenCalledTimes(4);
    handle.stop();
  });
});
