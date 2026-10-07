import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import {
  InMemoryMemberDataStore,
  MEMBER_DATA_SCHEMA_SQL,
  migrateMemberDataSchema,
  PostgresMemberDataStore,
  WALLET_PAYMENT_CATEGORIES,
  type MemberEventRow,
  type WalletPaymentRow,
} from '@/lib/member-data-store';

class MockSql implements SqlClient {
  executes: { text: string; params: readonly unknown[] }[] = [];
  queries: { text: string; params: readonly unknown[] }[] = [];
  nextRows: unknown[] = [];

  async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    this.queries.push({ text, params });
    return Promise.resolve(this.nextRows as T[]);
  }

  async execute(text: string, params: readonly unknown[] = []): Promise<void> {
    this.executes.push({ text, params });
    return Promise.resolve();
  }
}

const A = 'acc-a';
const B = 'acc-b';

function payment(overrides: Partial<WalletPaymentRow> = {}): WalletPaymentRow {
  return {
    accountId: A,
    paymentId: 'p1',
    direction: 'out',
    status: 'completed',
    amountSats: 100,
    feeSats: 1,
    paidAt: new Date('2026-10-01T00:00:00.000Z'),
    method: 'lightning',
    paymentHash: 'ab'.repeat(32),
    invoice: 'lnbc1test',
    destination: 'shop@21.gifts',
    description: 'coffee',
    lnurlComment: null,
    category: 'shop',
    counterpartyAccountId: null,
    firstSeenAt: new Date('2026-10-01T00:00:01.000Z'),
    updatedAt: new Date('2026-10-01T00:00:02.000Z'),
    ...overrides,
  };
}

function event(overrides: Partial<MemberEventRow> = {}): MemberEventRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    accountId: A,
    name: 'screen_view',
    at: new Date('2026-10-01T00:00:00.000Z'),
    path: '/forum',
    props: { count: 1 },
    receivedAt: new Date('2026-10-01T00:00:05.000Z'),
    ...overrides,
  };
}

describe('MEMBER_DATA_SCHEMA_SQL', () => {
  it('lists every category in the check and creates all four tables', () => {
    const ddl = MEMBER_DATA_SCHEMA_SQL.join('\n');
    for (const category of WALLET_PAYMENT_CATEGORIES) {
      expect(ddl).toContain(`'${category}'`);
    }
    for (const table of [
      'wallet_balance_snapshot',
      'wallet_payment',
      'member_event',
      'team_access_audit',
    ]) {
      expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(ddl).not.toMatch(/preimage|seed|mnemonic|private_key|prf/i);
  });

  it('migrates every statement in order', async () => {
    const sql = new MockSql();
    await migrateMemberDataSchema(sql);
    expect(sql.executes.map((call) => call.text)).toEqual([...MEMBER_DATA_SCHEMA_SQL]);
  });
});

describe('InMemoryMemberDataStore', () => {
  it('starts empty without a seed', async () => {
    const store = new InMemoryMemberDataStore();
    expect(await store.latestBalance(A)).toBeNull();
    expect(await store.listPayments(A, { since: null }, null, 10)).toEqual([]);
    expect(await store.paymentTotals(A, null)).toEqual([]);
    expect(await store.listEvents(A, null, 10)).toEqual([]);
    expect(await store.listAccess(null, 10)).toEqual([]);
  });

  it('returns the newest balance report of the account', async () => {
    const t1 = new Date('2026-10-01T00:00:00.000Z');
    const t2 = new Date('2026-10-02T00:00:00.000Z');
    const store = new InMemoryMemberDataStore({
      balances: [
        { id: 'b1', accountId: A, balanceSats: 10, syncedAt: t1, receivedAt: t1 },
        { id: 'b3', accountId: A, balanceSats: 30, syncedAt: t2, receivedAt: t2 },
        { id: 'b3', accountId: A, balanceSats: 30, syncedAt: t2, receivedAt: t2 },
        { id: 'b2', accountId: A, balanceSats: 20, syncedAt: t2, receivedAt: t2 },
        { id: 'b9', accountId: B, balanceSats: 90, syncedAt: t2, receivedAt: t2 },
      ],
    });
    const latest = await store.latestBalance(A);
    expect(latest).toEqual({
      id: 'b3',
      accountId: A,
      balanceSats: 30,
      syncedAt: t2,
      receivedAt: t2,
    });
  });

  it('lists payments newest first with filters and a keyset cursor', async () => {
    const day = (d: number): Date => new Date(Date.UTC(2026, 9, d));
    const store = new InMemoryMemberDataStore({
      payments: [
        payment({ paymentId: 'p1', paidAt: day(1) }),
        payment({ paymentId: 'p2', paidAt: day(2), direction: 'in', category: 'member' }),
        payment({ paymentId: 'p3', paidAt: day(3) }),
        payment({ paymentId: 'p4', paidAt: day(3) }),
        payment({ paymentId: 'p5', paidAt: day(4), accountId: B }),
      ],
    });
    const all = await store.listPayments(A, { since: null }, null, 10);
    expect(all.map((row) => row.paymentId)).toEqual(['p4', 'p3', 'p2', 'p1']);
    const next = await store.listPayments(A, { since: null }, { at: day(3), id: 'p4' }, 10);
    expect(next.map((row) => row.paymentId)).toEqual(['p3', 'p2', 'p1']);
    expect(
      (await store.listPayments(A, { since: day(2) }, null, 10)).map((row) => row.paymentId),
    ).toEqual(['p4', 'p3', 'p2']);
    expect(
      (await store.listPayments(A, { since: null, category: 'member' }, null, 10)).map(
        (row) => row.paymentId,
      ),
    ).toEqual(['p2']);
    expect(
      (await store.listPayments(A, { since: null, direction: 'out' }, null, 2)).map(
        (row) => row.paymentId,
      ),
    ).toEqual(['p4', 'p3']);
    all[0]!.amountSats = 999;
    expect((await store.listPayments(A, { since: null }, null, 1))[0]?.amountSats).toBe(100);
  });

  it('totals completed payments by category and direction', async () => {
    const day = (d: number): Date => new Date(Date.UTC(2026, 9, d));
    const store = new InMemoryMemberDataStore({
      payments: [
        payment({ paymentId: 'p1', paidAt: day(1), amountSats: 50, feeSats: 2 }),
        payment({ paymentId: 'p2', paidAt: day(2), amountSats: 70, feeSats: 3 }),
        payment({ paymentId: 'p3', paidAt: day(2), direction: 'in', category: 'gift' }),
        payment({ paymentId: 'p4', paidAt: day(2), status: 'pending' }),
        payment({ paymentId: 'p5', paidAt: day(2), accountId: B }),
      ],
    });
    expect(await store.paymentTotals(A, null)).toEqual([
      { category: 'shop', direction: 'out', count: 2, amountSats: 120, feeSats: 5 },
      { category: 'gift', direction: 'in', count: 1, amountSats: 100, feeSats: 1 },
    ]);
    expect(await store.paymentTotals(A, day(2))).toEqual([
      { category: 'shop', direction: 'out', count: 1, amountSats: 70, feeSats: 3 },
      { category: 'gift', direction: 'in', count: 1, amountSats: 100, feeSats: 1 },
    ]);
  });

  it('lists events newest first with a keyset cursor', async () => {
    const at = new Date('2026-10-02T00:00:00.000Z');
    const id = (n: number): string => `00000000-0000-4000-8000-00000000000${n}`;
    const store = new InMemoryMemberDataStore({
      events: [
        event({ id: id(1) }),
        event({ id: id(2), at }),
        event({ id: id(3), at }),
        event({ id: id(4), accountId: B }),
      ],
    });
    const first = await store.listEvents(A, null, 2);
    expect(first.map((row) => row.id)).toEqual([id(3), id(2)]);
    first[0]!.props['count'] = 7;
    const rest = await store.listEvents(A, { at, id: id(2) }, 10);
    expect(rest.map((row) => row.id)).toEqual([id(1)]);
    expect((await store.listEvents(A, null, 1))[0]?.props).toEqual({ count: 1 });
  });

  it('appends and lists audit rows newest first', async () => {
    const store = new InMemoryMemberDataStore();
    const at = new Date('2026-10-02T00:00:00.000Z');
    const row = (id: string, when: Date): Parameters<typeof store.appendAccess>[0] => ({
      id,
      viewerAccountId: A,
      memberAccountId: B,
      what: 'wallet',
      at: when,
    });
    await store.appendAccess(row('a1', new Date('2026-10-01T00:00:00.000Z')));
    await store.appendAccess(row('a2', at));
    await store.appendAccess(row('a3', at));
    expect((await store.listAccess(null, 10)).map((r) => r.id)).toEqual(['a3', 'a2', 'a1']);
    expect((await store.listAccess({ at, id: 'a3' }, 1)).map((r) => r.id)).toEqual(['a2']);
  });
});

describe('PostgresMemberDataStore', () => {
  it('maps the newest balance or null', async () => {
    const sql = new MockSql();
    const store = new PostgresMemberDataStore(sql);
    expect(await store.latestBalance(A)).toBeNull();
    sql.nextRows = [
      {
        id: 'b1',
        account_id: A,
        balance_sats: '1234',
        synced_at: '2026-10-01T00:00:00.000Z',
        received_at: new Date('2026-10-01T00:00:01.000Z'),
      },
    ];
    expect(await store.latestBalance(A)).toEqual({
      id: 'b1',
      accountId: A,
      balanceSats: 1234,
      syncedAt: new Date('2026-10-01T00:00:00.000Z'),
      receivedAt: new Date('2026-10-01T00:00:01.000Z'),
    });
    expect(sql.queries[1]?.params).toEqual([A]);
  });

  it('builds the payment page query from the filters and maps rows', async () => {
    const sql = new MockSql();
    const store = new PostgresMemberDataStore(sql);
    await store.listPayments(A, { since: null }, null, 51);
    expect(sql.queries[0]?.params).toEqual([A, 51]);
    expect(sql.queries[0]?.text).toContain('WHERE account_id = $1\n');
    const since = new Date('2026-09-01T00:00:00.000Z');
    const cursorAt = new Date('2026-10-01T00:00:00.000Z');
    sql.nextRows = [
      {
        account_id: A,
        payment_id: 'p1',
        direction: 'in',
        status: 'pending',
        amount_sats: '21',
        fee_sats: 0,
        paid_at: '2026-09-30T00:00:00.000Z',
        method: 'spark',
        payment_hash: null,
        invoice: null,
        destination: null,
        description: null,
        lnurl_comment: 'thanks',
        category: 'member',
        counterparty_account_id: B,
        first_seen_at: '2026-09-30T00:00:01.000Z',
        updated_at: '2026-09-30T00:00:02.000Z',
      },
    ];
    const rows = await store.listPayments(
      A,
      { since, category: 'member', direction: 'in' },
      { at: cursorAt, id: 'p9' },
      51,
    );
    const call = sql.queries[1];
    expect(call?.params).toEqual([A, since, 'member', 'in', cursorAt, 'p9', 51]);
    expect(call?.text).toContain('paid_at >= $2');
    expect(call?.text).toContain('category = $3');
    expect(call?.text).toContain('direction = $4');
    expect(call?.text).toContain(
      '(paid_at < $5 OR (paid_at = $5 AND payment_id COLLATE "C" < $6))',
    );
    expect(call?.text).toContain('LIMIT $7');
    expect(rows).toEqual([
      {
        accountId: A,
        paymentId: 'p1',
        direction: 'in',
        status: 'pending',
        amountSats: 21,
        feeSats: 0,
        paidAt: new Date('2026-09-30T00:00:00.000Z'),
        method: 'spark',
        paymentHash: null,
        invoice: null,
        destination: null,
        description: null,
        lnurlComment: 'thanks',
        category: 'member',
        counterpartyAccountId: B,
        firstSeenAt: new Date('2026-09-30T00:00:01.000Z'),
        updatedAt: new Date('2026-09-30T00:00:02.000Z'),
      },
    ]);
  });

  it('maps grouped totals', async () => {
    const sql = new MockSql();
    const store = new PostgresMemberDataStore(sql);
    sql.nextRows = [
      { category: 'onchain', direction: 'out', count: '2', amount_sats: '5000', fee_sats: '300' },
    ];
    const since = new Date('2026-09-01T00:00:00.000Z');
    expect(await store.paymentTotals(A, since)).toEqual([
      { category: 'onchain', direction: 'out', count: 2, amountSats: 5000, feeSats: 300 },
    ]);
    expect(sql.queries[0]?.params).toEqual([A, since]);
    expect(sql.queries[0]?.text).toContain("status = 'completed'");
  });

  it('maps events with jsonb props as object, text, or null', async () => {
    const sql = new MockSql();
    const store = new PostgresMemberDataStore(sql);
    const base = {
      account_id: A,
      name: 'search',
      at: '2026-10-01T00:00:00.000Z',
      path: null,
      received_at: '2026-10-01T00:00:01.000Z',
    };
    sql.nextRows = [
      { ...base, id: 'e1', props: { q: 'bread' } },
      { ...base, id: 'e2', props: '{"q":"milk"}' },
      { ...base, id: 'e3', props: null },
    ];
    const rows = await store.listEvents(A, null, 101);
    expect(rows.map((row) => row.props)).toEqual([{ q: 'bread' }, { q: 'milk' }, {}]);
    expect(sql.queries[0]?.params).toEqual([A, null, null, 101]);
    const at = new Date('2026-10-01T00:00:00.000Z');
    await store.listEvents(A, { at, id: 'e1' }, 101);
    expect(sql.queries[1]?.params).toEqual([A, at, 'e1', 101]);
  });

  it('inserts and lists audit rows', async () => {
    const sql = new MockSql();
    const store = new PostgresMemberDataStore(sql);
    const at = new Date('2026-10-01T00:00:00.000Z');
    await store.appendAccess({
      id: 'a1',
      viewerAccountId: A,
      memberAccountId: B,
      what: 'events',
      at,
    });
    expect(sql.executes[0]?.params).toEqual(['a1', A, B, 'events', at]);
    sql.nextRows = [
      {
        id: 'a1',
        viewer_account_id: A,
        member_account_id: B,
        what: 'events',
        at: '2026-10-01T00:00:00.000Z',
      },
    ];
    expect(await store.listAccess(null, 101)).toEqual([
      { id: 'a1', viewerAccountId: A, memberAccountId: B, what: 'events', at },
    ]);
    expect(sql.queries[0]?.params).toEqual([null, null, 101]);
    await store.listAccess({ at, id: 'a1' }, 101);
    expect(sql.queries[1]?.params).toEqual([at, 'a1', 101]);
  });
});
