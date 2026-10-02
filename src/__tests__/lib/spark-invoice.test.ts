import { afterEach, describe, expect, it, vi } from 'vitest';
import { bech32m, hex } from '@scure/base';
import { decodeProto } from '@/lib/protobuf';
import { encodeSparkInvoice, issueSparkInvoice, uuidV7 } from '@/lib/spark-invoice';
import { InMemorySparkInvoiceStore, type SparkInvoiceStore } from '@/lib/spark-invoice-store';
import type { ReceivingAddress } from '@/lib/receiving-address';

const PUBKEY = '0209cb7d2b5d3df3a0ac4ef86cfcfa229ffa52b687d797274c8669cbd5235eccd5';
const VECTOR_HEX =
  '0a210209cb7d2b5d3df3a0ac4ef86cfcfa229ffa52b687d797274c8669cbd5235eccd5122208011210070707070707070707070707070707072a087a61703a7465737422020815';
const VECTOR_STRING =
  'spark1pgssyzwt0544600n5zkya7rvlnaz98l622mg04uhyaxgv6wt6534anx4zg3qsqgjzqrswpc8qurswpc8qurswpc8qurj5zr6v9cr5ar9wd6zyqsgz532drgt';
const HASH = 'ab'.repeat(32);

const wallet: ReceivingAddress = { kind: 'wallet', address: 'alice@21.gifts', sparkPubkey: PUBKEY };

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('encodeSparkInvoice', () => {
  it('matches the test vector byte for byte', () => {
    const invoice = encodeSparkInvoice({
      identityPublicKey: PUBKEY,
      id: new Uint8Array(16).fill(0x07),
      memo: 'zap:test',
      amountSats: 21,
    });
    expect(invoice).toBe(VECTOR_STRING);
    const decoded = bech32m.decode(invoice as `${string}1${string}`, false);
    expect(decoded.prefix).toBe('spark');
    expect(hex.encode(bech32m.fromWords(decoded.words))).toBe(VECTOR_HEX);
  });

  it('round-trips through the protobuf reader', () => {
    const bytes = hex.decode(VECTOR_HEX);
    const [identity, fields] = decodeProto(bytes);
    expect(identity).toMatchObject({ field: 1, wire: 2 });
    expect(hex.encode(identity?.value as Uint8Array)).toBe(PUBKEY);
    expect(fields).toMatchObject({ field: 2, wire: 2 });
    const inner = decodeProto(fields?.value as Uint8Array);
    expect(inner.map((f) => f.field)).toEqual([1, 2, 5, 4]);
    expect(inner[0]).toEqual({ field: 1, wire: 0, value: 1n });
    expect(new TextDecoder().decode(inner[2]?.value as Uint8Array)).toBe('zap:test');
    expect(decodeProto(inner[3]?.value as Uint8Array)).toEqual([{ field: 1, wire: 0, value: 21n }]);
  });

  it('rejects a key that is not 33 bytes and an id that is not 16 bytes', () => {
    expect(() =>
      encodeSparkInvoice({
        identityPublicKey: '02',
        id: new Uint8Array(16),
        memo: '',
        amountSats: 1,
      }),
    ).toThrow('33 bytes');
    expect(() =>
      encodeSparkInvoice({
        identityPublicKey: PUBKEY,
        id: new Uint8Array(15),
        memo: '',
        amountSats: 1,
      }),
    ).toThrow('16 bytes');
  });
});

describe('uuidV7', () => {
  it('lays out timestamp, version, variant, and random bytes', () => {
    const ms = 0x0123456789ab;
    const random = Uint8Array.from([0xff, 0x11, 0xff, 3, 4, 5, 6, 7, 8, 9]);
    const id = uuidV7(ms, random);
    expect(hex.encode(id)).toBe('0123456789ab' + '7f11' + 'bf03' + '040506070809');
  });

  it('treats missing random bytes as zero', () => {
    const id = uuidV7(0, new Uint8Array(0));
    expect(hex.encode(id)).toBe('000000000000' + '7000' + '8000' + '000000000000');
  });
});

describe('issueSparkInvoice', () => {
  const zap = {
    pr: 'lnbc21n1test',
    paymentHash: HASH,
    prAmountMsat: 21_000,
    amountSats: 21,
    zapRequestJson: '{"a":1}',
  };

  it('returns null when off, external, without a payment hash, or for another amount', async () => {
    const store = new InMemorySparkInvoiceStore();
    const now = (): number => 1;
    expect(await issueSparkInvoice({ now }, wallet, zap)).toBeNull();
    expect(
      await issueSparkInvoice(
        { now, sparkInvoices: store },
        { kind: 'external', address: 'a@b.com' },
        zap,
      ),
    ).toBeNull();
    expect(
      await issueSparkInvoice({ now, sparkInvoices: store }, wallet, { ...zap, paymentHash: null }),
    ).toBeNull();
    expect(
      await issueSparkInvoice({ now, sparkInvoices: store }, wallet, {
        ...zap,
        prAmountMsat: 1_000_000,
      }),
    ).toBeNull();
    expect(
      await issueSparkInvoice({ now, sparkInvoices: store }, wallet, {
        ...zap,
        prAmountMsat: null,
      }),
    ).toBeNull();
    expect(await store.listOpen(new Date(0))).toEqual([]);
  });

  it('issues and stores, then returns the stored string again', async () => {
    const store = new InMemorySparkInvoiceStore();
    const nowMs = Date.parse('2026-10-01T00:00:00.000Z');
    const first = await issueSparkInvoice(
      { now: () => nowMs, sparkInvoices: store, randomBytes: (n) => new Uint8Array(n).fill(1) },
      wallet,
      zap,
    );
    expect(first).toBe(
      encodeSparkInvoice({
        identityPublicKey: PUBKEY,
        id: uuidV7(nowMs, new Uint8Array(10).fill(1)),
        memo: `zap:${HASH}`,
        amountSats: 21,
      }),
    );
    const [row] = await store.listOpen(new Date(0));
    expect(row).toMatchObject({
      paymentHash: HASH,
      invoice: first,
      receiverPubkey: PUBKEY,
      amountSats: 21,
      bolt11: 'lnbc21n1test',
      zapRequest: '{"a":1}',
      status: 'open',
    });
    const second = await issueSparkInvoice(
      { now: () => nowMs + 5, sparkInvoices: store },
      wallet,
      zap,
    );
    expect(second).toBe(first);
  });

  it('logs and resolves null when the store throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store: SparkInvoiceStore = {
      issue: () => Promise.reject(new Error('down')),
      listOpen: () => Promise.resolve([]),
      markSettled: () => Promise.resolve(false),
    };
    expect(await issueSparkInvoice({ now: () => 1, sparkInvoices: store }, wallet, zap)).toBeNull();
    expect(parsedEvents(warn).map((e) => e['event'])).toContain('spark.invoice.issue_failed');
  });
});
