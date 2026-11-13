import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import {
  InMemorySparkInvoiceStore,
  MEMBER_SPARK_INVOICE_CAP,
  PostgresSparkInvoiceStore,
  SPARK_INVOICE_SCHEMA_SQL,
  migrateSparkInvoiceSchema,
  type MemberSparkInvoiceIssue,
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

const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const HOUR = 60 * 60_000;

function member(partial: Partial<MemberSparkInvoiceIssue> = {}): MemberSparkInvoiceIssue {
  return {
    invoice: 'spark1m',
    kind: 'pay',
    accountId: ACCOUNT,
    receiverPubkey: `02${'c'.repeat(64)}`,
    amountSats: 21,
    createdAt: new Date(T0),
    expiresAt: new Date(T0 + HOUR),
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

describe('InMemorySparkInvoiceStore member invoices', () => {
  it('looks up member invoice accounts through notification and pruning', async () => {
    const store = new InMemorySparkInvoiceStore();
    await store.issueMember(member());
    expect(await store.memberInvoiceAccountId('spark1m')).toBe(ACCOUNT);
    expect(await store.memberInvoiceAccountId('unknown')).toBeUndefined();
    await store.claimMemberNotified('spark1m', new Date(T0));
    expect(await store.memberInvoiceAccountId('spark1m')).toBe(ACCOUNT);
    await store.pruneMember(new Date(T0 + HOUR));
    expect(await store.memberInvoiceAccountId('spark1m')).toBeUndefined();
  });

  it('stores a member invoice once and lists it while open and unexpired', async () => {
    const store = new InMemorySparkInvoiceStore();
    await store.issueMember(member());
    await store.issueMember(member({ amountSats: 99 }));
    expect(await store.listOpenMember(new Date(T0))).toEqual([{ ...member(), status: 'open' }]);
    expect(await store.listOpenMember(new Date(T0 + HOUR))).toEqual([]);
  });

  it('keeps only the newest open invoices of one account', async () => {
    const store = new InMemorySparkInvoiceStore();
    await store.issueMember(member({ invoice: 'other', accountId: 'b', createdAt: new Date(T0) }));
    for (let i = 0; i <= MEMBER_SPARK_INVOICE_CAP; i += 1) {
      await store.issueMember(
        member({ invoice: `m${String(i).padStart(2, '0')}`, createdAt: new Date(T0 + i) }),
      );
    }
    const open = await store.listOpenMember(new Date(T0));
    expect(open.map((row) => row.invoice)).not.toContain('m00');
    expect(open.filter((row) => row.accountId === ACCOUNT)).toHaveLength(MEMBER_SPARK_INVOICE_CAP);
    expect(open[0]?.invoice).toBe('other');
  });

  it('keeps the stored invoice even when it is not the newest', async () => {
    const store = new InMemorySparkInvoiceStore();
    for (let i = 0; i < MEMBER_SPARK_INVOICE_CAP; i += 1) {
      await store.issueMember(
        member({ invoice: `m${String(i).padStart(2, '0')}`, createdAt: new Date(T0 + 10 + i) }),
      );
    }
    await store.issueMember(member({ invoice: 'late', createdAt: new Date(T0) }));
    const open = (await store.listOpenMember(new Date(T0))).map((row) => row.invoice);
    expect(open).toHaveLength(MEMBER_SPARK_INVOICE_CAP);
    expect(open).toContain('late');
    expect(open).not.toContain('m00');
  });

  it('does not count notified invoices against the cap', async () => {
    const store = new InMemorySparkInvoiceStore();
    await store.issueMember(member({ invoice: 'paid', createdAt: new Date(T0 - 1) }));
    expect(await store.claimMemberNotified('paid', new Date(T0))).toBe(true);
    for (let i = 0; i < MEMBER_SPARK_INVOICE_CAP; i += 1) {
      await store.issueMember(
        member({ invoice: `m${String(i).padStart(2, '0')}`, createdAt: new Date(T0) }),
      );
    }
    expect(await store.listOpenMember(new Date(T0))).toHaveLength(MEMBER_SPARK_INVOICE_CAP);
    expect(await store.pruneMember(new Date(T0 + HOUR))).toBe(MEMBER_SPARK_INVOICE_CAP + 1);
  });

  it('claims an open member invoice once and returns copies', async () => {
    const store = new InMemorySparkInvoiceStore();
    expect(await store.claimMemberNotified('spark1m', new Date(T0))).toBe(false);
    await store.issueMember(member());
    const listed = await store.listOpenMember(new Date(T0));
    listed[0]?.createdAt.setTime(0);
    listed[0]?.expiresAt.setTime(0);
    expect((await store.listOpenMember(new Date(T0)))[0]?.expiresAt.getTime()).toBe(T0 + HOUR);
    expect(await store.claimMemberNotified('spark1m', new Date(T0))).toBe(true);
    expect(await store.claimMemberNotified('spark1m', new Date(T0))).toBe(false);
    expect(await store.listOpenMember(new Date(T0))).toEqual([]);
  });

  it('does not claim an expired member invoice', async () => {
    const store = new InMemorySparkInvoiceStore();
    await store.issueMember(member());
    expect(await store.claimMemberNotified('spark1m', new Date(T0 + HOUR))).toBe(false);
    expect(await store.listOpenMember(new Date(T0))).toHaveLength(1);
  });

  it('releases a claimed member invoice back to open once', async () => {
    const store = new InMemorySparkInvoiceStore();
    expect(await store.releaseMemberNotified('spark1m')).toBe(false);
    await store.issueMember(member());
    expect(await store.releaseMemberNotified('spark1m')).toBe(false);
    expect(await store.claimMemberNotified('spark1m', new Date(T0))).toBe(true);
    expect(await store.releaseMemberNotified('spark1m')).toBe(true);
    expect(await store.releaseMemberNotified('spark1m')).toBe(false);
    expect(await store.listOpenMember(new Date(T0))).toHaveLength(1);
  });

  it('prunes member invoices that expired at or before now', async () => {
    const store = new InMemorySparkInvoiceStore();
    await store.issueMember(member({ invoice: 'a', expiresAt: new Date(T0) }));
    await store.issueMember(member({ invoice: 'b', expiresAt: new Date(T0 + 1) }));
    expect(await store.pruneMember(new Date(T0))).toBe(1);
    expect((await store.listOpenMember(new Date(0))).map((row) => row.invoice)).toEqual(['b']);
  });
});

describe('migrateSparkInvoiceSchema', () => {
  it('runs every DDL statement in order', async () => {
    const sql = new MockSql();
    await migrateSparkInvoiceSchema(sql);
    expect(sql.executes.map((e) => e.text)).toEqual([...SPARK_INVOICE_SCHEMA_SQL]);
    expect(SPARK_INVOICE_SCHEMA_SQL[0]).toContain('CREATE TABLE IF NOT EXISTS spark_invoice');
    expect(SPARK_INVOICE_SCHEMA_SQL[2]).toContain(
      'CREATE TABLE IF NOT EXISTS member_spark_invoice',
    );
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

  it('stores a member invoice and trims the account to the cap in one statement', async () => {
    const sql = new MockSql();
    await new PostgresSparkInvoiceStore(sql).issueMember(member());
    expect(sql.executes).toHaveLength(1);
    expect(sql.executes[0]?.text).toContain('ON CONFLICT (invoice) DO NOTHING');
    expect(sql.executes[0]?.text).toContain('DELETE FROM member_spark_invoice');
    expect(sql.executes[0]?.params).toEqual([
      'spark1m',
      'pay',
      ACCOUNT,
      `02${'c'.repeat(64)}`,
      21,
      new Date(T0).toISOString(),
      new Date(T0 + HOUR).toISOString(),
      MEMBER_SPARK_INVOICE_CAP - 1,
    ]);
  });

  it('looks up a member invoice by a bound exact string', async () => {
    const sql = new MockSql();
    const store = new PostgresSparkInvoiceStore(sql);
    sql.rows = [{ account_id: ACCOUNT }];
    expect(await store.memberInvoiceAccountId('spark1m')).toBe(ACCOUNT);
    expect(sql.queries[0]?.params).toEqual(['spark1m']);
    sql.rows = [];
    expect(await store.memberInvoiceAccountId('unknown')).toBeUndefined();
  });

  it('lists open member invoices and maps driver values', async () => {
    const sql = new MockSql();
    sql.rows = [
      {
        invoice: 'i1',
        kind: 'pay',
        account_id: ACCOUNT,
        receiver_pubkey: 'p1',
        amount_sats: '21',
        created_at: new Date(T0),
        expires_at: new Date(T0 + HOUR).toISOString(),
        status: 'open',
      },
    ];
    const rows = await new PostgresSparkInvoiceStore(sql).listOpenMember(new Date(T0));
    expect(sql.queries[0]?.text).toContain("WHERE status = 'open' AND expires_at > $1");
    expect(sql.queries[0]?.params).toEqual([new Date(T0).toISOString()]);
    expect(rows).toEqual([{ ...member({ invoice: 'i1', receiverPubkey: 'p1' }), status: 'open' }]);
  });

  it('claims only an open, unexpired member invoice', async () => {
    const sql = new MockSql();
    const store = new PostgresSparkInvoiceStore(sql);
    sql.rows = [{ invoice: 'i1' }];
    expect(await store.claimMemberNotified('i1', new Date(T0))).toBe(true);
    expect(sql.queries[0]?.text).toContain(
      "WHERE invoice = $1 AND status = 'open' AND expires_at > $2",
    );
    expect(sql.queries[0]?.params).toEqual(['i1', new Date(T0).toISOString()]);
    sql.rows = [];
    expect(await store.claimMemberNotified('i1', new Date(T0))).toBe(false);
  });

  it('releases only a notified member invoice', async () => {
    const sql = new MockSql();
    const store = new PostgresSparkInvoiceStore(sql);
    sql.rows = [{ invoice: 'i1' }];
    expect(await store.releaseMemberNotified('i1')).toBe(true);
    expect(sql.queries[0]?.text).toContain("SET status = 'open'");
    expect(sql.queries[0]?.text).toContain("WHERE invoice = $1 AND status = 'notified'");
    expect(sql.queries[0]?.params).toEqual(['i1']);
    sql.rows = [];
    expect(await store.releaseMemberNotified('i1')).toBe(false);
  });

  it('prunes expired member invoices and counts them', async () => {
    const sql = new MockSql();
    sql.rows = [{ invoice: 'a' }, { invoice: 'b' }];
    expect(await new PostgresSparkInvoiceStore(sql).pruneMember(new Date(T0))).toBe(2);
    expect(sql.queries[0]?.text).toContain('WHERE expires_at <= $1');
    expect(sql.queries[0]?.params).toEqual([new Date(T0).toISOString()]);
  });
});
