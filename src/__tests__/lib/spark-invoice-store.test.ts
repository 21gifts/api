import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import {
  InMemorySparkInvoiceStore,
  PostgresSparkInvoiceStore,
  SPARK_INVOICE_SCHEMA_SQL,
  migrateSparkInvoiceSchema,
  type SparkInvoiceIssue,
} from '@/lib/spark-invoice-store';

const T0 = Date.parse('2026-10-01T12:00:00.000Z');

function issue(partial: Partial<SparkInvoiceIssue> = {}): SparkInvoiceIssue {
  return {
    paymentHash: 'a'.repeat(64),
    invoice: 'spark1a',
    receiverPubkey: `02${'b'.repeat(64)}`,
    amountSats: 21,
    bolt11: 'lnbc21n1',
    zapRequest: '{}',
    createdAt: new Date(T0),
    ...partial,
  };
}

class MockSql implements SqlClient {
  executes: { text: string; params: readonly unknown[] }[] = [];
  queries: { text: string; params: readonly unknown[] }[] = [];
  rows: unknown[] = [];

  async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    this.queries.push({ text, params });
    return this.rows as T[];
  }

  async execute(text: string, params: readonly unknown[] = []): Promise<void> {
    this.executes.push({ text, params });
  }
}

describe('InMemorySparkInvoiceStore', () => {
  it('issues once and returns the stored invoice for the same payment hash', async () => {
    const store = new InMemorySparkInvoiceStore();
    expect(await store.issue(issue())).toBe('spark1a');
    expect(await store.issue(issue({ invoice: 'spark1b' }))).toBe('spark1a');
    const rows = await store.listOpen(new Date(0));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      invoice: 'spark1a',
      status: 'open',
      transferId: null,
      receiptEventId: null,
    });
  });

  it('moves createdAt forward only for a newer issue of an open row', async () => {
    const store = new InMemorySparkInvoiceStore();
    await store.issue(issue());
    await store.issue(issue({ createdAt: new Date(T0 - 1000) }));
    expect((await store.listOpen(new Date(0)))[0]?.createdAt.getTime()).toBe(T0);
    await store.issue(issue({ createdAt: new Date(T0 + 1000) }));
    expect((await store.listOpen(new Date(0)))[0]?.createdAt.getTime()).toBe(T0 + 1000);
    expect(await store.markSettled('a'.repeat(64), 'ff', 'e1')).toBe(true);
    expect(await store.issue(issue({ createdAt: new Date(T0 + 5000) }))).toBe('spark1a');
    expect(await store.listOpen(new Date(0))).toEqual([]);
  });

  it('lists open rows in the window oldest first and returns copies', async () => {
    const store = new InMemorySparkInvoiceStore();
    await store.issue(issue({ paymentHash: 'c', invoice: 'c', createdAt: new Date(T0 + 2) }));
    await store.issue(issue({ paymentHash: 'b', invoice: 'b', createdAt: new Date(T0 + 1) }));
    await store.issue(issue({ paymentHash: 'old', invoice: 'old', createdAt: new Date(T0 - 1) }));
    await store.issue(issue({ paymentHash: 'done', invoice: 'done', createdAt: new Date(T0 + 3) }));
    await store.markSettled('done', null, 'e');
    const rows = await store.listOpen(new Date(T0));
    expect(rows.map((r) => r.paymentHash)).toEqual(['b', 'c']);
    rows[0]?.createdAt.setTime(0);
    expect((await store.listOpen(new Date(T0)))[0]?.createdAt.getTime()).toBe(T0 + 1);
  });

  it('settles an open row once', async () => {
    const store = new InMemorySparkInvoiceStore();
    expect(await store.markSettled('missing', 'ff', 'e')).toBe(false);
    await store.issue(issue());
    expect(await store.markSettled('a'.repeat(64), 'ff', 'e1')).toBe(true);
    expect(await store.markSettled('a'.repeat(64), 'ee', 'e2')).toBe(false);
  });
});

describe('migrateSparkInvoiceSchema', () => {
  it('runs every DDL statement in order', async () => {
    const sql = new MockSql();
    await migrateSparkInvoiceSchema(sql);
    expect(sql.executes.map((e) => e.text)).toEqual([...SPARK_INVOICE_SCHEMA_SQL]);
    expect(SPARK_INVOICE_SCHEMA_SQL[0]).toContain('CREATE TABLE IF NOT EXISTS spark_invoice');
  });
});

describe('PostgresSparkInvoiceStore', () => {
  it('inserts with a conflict update and returns the stored invoice', async () => {
    const sql = new MockSql();
    sql.rows = [{ invoice: 'spark1stored' }];
    const store = new PostgresSparkInvoiceStore(sql);
    expect(await store.issue(issue())).toBe('spark1stored');
    expect(sql.executes[0]?.text).toContain('ON CONFLICT (payment_hash) DO UPDATE');
    expect(sql.executes[0]?.text).toContain("WHERE spark_invoice.status = 'open'");
    expect(sql.executes[0]?.params).toEqual([
      'a'.repeat(64),
      'spark1a',
      `02${'b'.repeat(64)}`,
      21,
      'lnbc21n1',
      '{}',
      new Date(T0).toISOString(),
    ]);
    expect(sql.queries[0]?.params).toEqual(['a'.repeat(64)]);
  });

  it('lists open rows and maps driver values', async () => {
    const sql = new MockSql();
    sql.rows = [
      {
        payment_hash: 'h1',
        invoice: 'i1',
        receiver_pubkey: 'p1',
        amount_sats: '21',
        bolt11: 'b1',
        zap_request: 'z1',
        created_at: new Date(T0),
        status: 'open',
        transfer_id: null,
        receipt_event_id: null,
      },
      {
        payment_hash: 'h2',
        invoice: 'i2',
        receiver_pubkey: 'p2',
        amount_sats: 5n,
        bolt11: 'b2',
        zap_request: 'z2',
        created_at: new Date(T0 + 1).toISOString(),
        status: 'open',
        transfer_id: null,
        receipt_event_id: null,
      },
    ];
    const store = new PostgresSparkInvoiceStore(sql);
    const rows = await store.listOpen(new Date(T0));
    expect(sql.queries[0]?.text).toContain("WHERE status = 'open' AND created_at >= $1");
    expect(sql.queries[0]?.params).toEqual([new Date(T0).toISOString()]);
    expect(rows).toEqual([
      {
        paymentHash: 'h1',
        invoice: 'i1',
        receiverPubkey: 'p1',
        amountSats: 21,
        bolt11: 'b1',
        zapRequest: 'z1',
        createdAt: new Date(T0),
        status: 'open',
        transferId: null,
        receiptEventId: null,
      },
      {
        paymentHash: 'h2',
        invoice: 'i2',
        receiverPubkey: 'p2',
        amountSats: 5,
        bolt11: 'b2',
        zapRequest: 'z2',
        createdAt: new Date(T0 + 1),
        status: 'open',
        transferId: null,
        receiptEventId: null,
      },
    ]);
  });

  it('settles only an open row', async () => {
    const sql = new MockSql();
    const store = new PostgresSparkInvoiceStore(sql);
    sql.rows = [{ payment_hash: 'h' }];
    expect(await store.markSettled('h', 'ff', 'e')).toBe(true);
    expect(sql.queries[0]?.text).toContain("WHERE payment_hash = $1 AND status = 'open'");
    expect(sql.queries[0]?.params).toEqual(['h', 'ff', 'e']);
    sql.rows = [];
    expect(await store.markSettled('h', null, 'e')).toBe(false);
  });
});
