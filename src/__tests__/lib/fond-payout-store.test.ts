import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import {
  FOND_CLAIM_LEASE_MS,
  FOND_OVERDUE_MS,
  FOND_PAYOUT_SCHEMA_SQL,
  InMemoryFondPayoutStore,
  PostgresFondPayoutStore,
  migrateFondPayoutSchema,
  type FondPayoutEnqueue,
} from '@/lib/fond-payout-store';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');

function enqueue(partial: Partial<FondPayoutEnqueue> = {}): FondPayoutEnqueue {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    utcDay: '2026-11-09',
    kind: 'daily',
    address: 'ada@example.com',
    amountUsd: '1.00',
    comment: 'thanks',
    messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    groupMessageId: null,
    ...partial,
  };
}

class MockSql implements SqlClient {
  executes: { text: string; params: readonly unknown[] }[] = [];
  queries: { text: string; params: readonly unknown[] }[] = [];
  queryResults: unknown[][] = [];

  async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    this.queries.push({ text, params });
    return (this.queryResults.shift() ?? []) as T[];
  }

  async execute(text: string, params: readonly unknown[] = []): Promise<void> {
    this.executes.push({ text, params });
  }
}

describe('FOND_PAYOUT_SCHEMA_SQL', () => {
  it('creates the table, both checks, and the dedupe indexes', () => {
    const all = FOND_PAYOUT_SCHEMA_SQL.join('\n');
    expect(all).toContain('CREATE TABLE IF NOT EXISTS fond_payout');
    expect(all).toContain("kind text NOT NULL CHECK (kind IN ('daily', 'moderator', 'welcome'))");
    expect(all).toContain(
      "status IN ('owed', 'issuing', 'invoiced', 'settling', 'paid', 'failed')",
    );
    expect(all).toContain('amount_msat bigint');
    expect(all).toContain('claimed_at timestamptz NULL');
    expect(all).toContain('ADD COLUMN IF NOT EXISTS claimed_at timestamptz NULL');
    expect(all).toContain('spark_invoice text');
    expect(all).toContain('ADD COLUMN IF NOT EXISTS spark_invoice text NULL');
    expect(all).toContain(
      'ALTER TABLE fond_payout DROP CONSTRAINT IF EXISTS fond_payout_status_check',
    );
    expect(all).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS fond_payout_daily_moderator_uidx/);
    expect(all).toMatch(/\(utc_day, kind, address\)\s+WHERE kind IN \('daily', 'moderator'\)/);
    expect(all).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS fond_payout_welcome_uidx/);
    expect(all).toMatch(/\(kind, address\)\s+WHERE kind = 'welcome'/);
  });
});

describe('migrateFondPayoutSchema', () => {
  it('runs every statement in order', async () => {
    const sql = new MockSql();
    await migrateFondPayoutSchema(sql);
    expect(sql.executes.map((item) => item.text)).toEqual([...FOND_PAYOUT_SCHEMA_SQL]);
  });
});

describe('InMemoryFondPayoutStore', () => {
  it('enqueues an owed row and dedupes daily per day, kind, and address', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    expect(await store.enqueue(enqueue())).toBe('accepted');
    expect(await store.enqueue(enqueue({ id: '22222222-2222-4222-8222-222222222222' }))).toBe(
      'accepted',
    );
    expect(await store.listOpen('2026-11-09')).toHaveLength(1);
    const row = (await store.listOpen('2026-11-09'))[0];
    expect(row).toMatchObject({ status: 'owed', amountUsd: '1.00', comment: 'thanks' });
    expect(row?.createdAt).toEqual(new Date(NOW));
  });

  it('allows the same address on another day or as another kind', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    await store.enqueue(enqueue());
    expect(await store.enqueue(enqueue({ id: 'other-day', utcDay: '2026-11-10' }))).toBe(
      'accepted',
    );
    expect(
      await store.enqueue(enqueue({ id: 'moderator', kind: 'moderator', groupMessageId: null })),
    ).toBe('accepted');
    expect(await store.enqueue(enqueue({ id: 'welcome', kind: 'welcome' }))).toBe('accepted');
    expect(await store.listOpen('2026-11-09')).toHaveLength(3);
  });

  it('aggregates only paid rows and sums their USD strings in cents', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    expect(await store.paidTotals()).toEqual({ payoutsPaid: 0, payoutsPaidUsd: '0.00' });
    await store.enqueue(enqueue({ id: 'paid-a', amountUsd: '1.00' }));
    await store.enqueue(enqueue({ id: 'paid-b', address: 'bob@example.com', amountUsd: '2.50' }));
    await store.enqueue(
      enqueue({ id: 'unpaid', address: 'unpaid@example.com', amountUsd: '9.99' }),
    );
    for (const id of ['paid-a', 'paid-b']) {
      await store.claimForInvoice(id, '2026-11-09');
      await store.setInvoiced(id, {
        invoiceId: `inv-${id}`,
        paymentHash: id === 'paid-a' ? 'aa'.repeat(32) : 'bb'.repeat(32),
        bolt11: `lnbc-${id}`,
        sparkInvoice: null,
        amountMsat: 1_000_000,
      });
      await store.claimSettlement(id);
      await store.markPaid(id);
    }
    expect(await store.paidTotals()).toEqual({ payoutsPaid: 2, payoutsPaidUsd: '3.50' });
  });

  it('maps paid USD by payment hash or invoice and skips unpaid and unknown rows', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    const paidHash = 'aa'.repeat(32);
    const unpaidHash = 'bb'.repeat(32);
    const otherPaidHash = 'dd'.repeat(32);
    for (const [id, address, paymentHash, bolt11, sparkInvoice] of [
      ['paid', 'paid@example.com', paidHash, 'lnbc-paid', 'spark-paid'],
      ['unpaid', 'unpaid@example.com', unpaidHash, 'lnbc-unpaid', 'spark-unpaid'],
      ['null-hash', 'null@example.com', null, 'lnbc-null', null],
      ['other-paid', 'other@example.com', otherPaidHash, 'lnbc-other', 'spark-other'],
    ] as const) {
      await store.enqueue(enqueue({ id, address }));
      await store.claimForInvoice(id, '2026-11-09');
      await store.setInvoiced(id, {
        invoiceId: `inv-${id}`,
        paymentHash: paymentHash as string,
        bolt11,
        sparkInvoice,
        amountMsat: 1_000_000,
      });
    }
    for (const id of ['paid', 'null-hash', 'other-paid']) {
      await store.claimSettlement(id);
      await store.markPaid(id);
    }
    await expect(store.paidUsdByPaymentHashOrInvoice([], [])).resolves.toEqual(new Map());
    const paid = await store.paidUsdByPaymentHashOrInvoice(
      [paidHash, unpaidHash, 'cc'.repeat(32), paidHash],
      ['spark-paid', 'lnbc-paid', 'spark-unpaid', 'unknown'],
    );
    expect([...paid]).toEqual([
      [paidHash, '1.00'],
      ['spark-paid', '1.00'],
      ['lnbc-paid', '1.00'],
    ]);
  });

  it('formats paid USD amounts with exactly two decimals', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    for (const [id, amountUsd] of [
      ['one', '1'],
      ['two-and-a-half', '2.5'],
      ['three', '3.00'],
    ] as const) {
      await store.enqueue(enqueue({ id, address: `${id}@example.com`, amountUsd }));
      await store.claimForInvoice(id, '2026-11-09');
      await store.setInvoiced(id, {
        invoiceId: `inv-${id}`,
        paymentHash: id.padEnd(64, '0'),
        bolt11: `lnbc-${id}`,
        sparkInvoice: null,
        amountMsat: 1_000_000,
      });
      await store.claimSettlement(id);
      await store.markPaid(id);
    }
    await expect(
      store.paidUsdByPaymentHashOrInvoice(
        ['one'.padEnd(64, '0'), 'two-and-a-half'.padEnd(64, '0'), 'three'.padEnd(64, '0')],
        [],
      ),
    ).resolves.toEqual(
      new Map([
        ['one'.padEnd(64, '0'), '1.00'],
        ['two-and-a-half'.padEnd(64, '0'), '2.50'],
        ['three'.padEnd(64, '0'), '3.00'],
      ]),
    );
  });

  it('refuses an invalid stored USD amount on a paid row', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    await store.enqueue(enqueue({ id: 'bad-amount', amountUsd: 'not-money' }));
    await store.claimForInvoice('bad-amount', '2026-11-09');
    await store.setInvoiced('bad-amount', {
      invoiceId: 'inv-bad',
      paymentHash: 'cc'.repeat(32),
      bolt11: 'lnbc-bad',
      sparkInvoice: null,
      amountMsat: 1_000_000,
    });
    await store.claimSettlement('bad-amount');
    await store.markPaid('bad-amount');
    await expect(store.paidTotals()).rejects.toThrow('invalid stored payout amount');
  });

  it('dedupes welcome once ever per address, regardless of day', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    await store.enqueue(enqueue({ kind: 'welcome' }));
    expect(await store.enqueue(enqueue({ kind: 'welcome', utcDay: '2026-11-10', id: 'x' }))).toBe(
      'accepted',
    );
    expect(await store.listOpen('2026-11-10')).toHaveLength(0);
  });

  it('claims, writes, releases, fails, and pays with guarded transitions', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    const { id } = enqueue();
    await store.enqueue(enqueue());
    expect(await store.claimSettlement(id)).toBeUndefined();
    expect(await store.markPaid(id)).toBeUndefined();
    expect(await store.releaseSettlement(id)).toBeUndefined();
    expect(await store.claimForInvoice(id, '2026-11-08')).toBeNull();
    expect(
      await store.setInvoiced(id, {
        invoiceId: 'inv-0',
        paymentHash: 'aa'.repeat(32),
        bolt11: 'lnbc0',
        sparkInvoice: null,
        amountMsat: 1_000_000,
      }),
    ).toBeUndefined();
    expect(await store.claimForInvoice(id, '2026-11-09')).toMatchObject({
      status: 'issuing',
      claimedAt: new Date(NOW),
    });
    expect(await store.claimForInvoice(id, '2026-11-09')).toBeNull();
    expect(await store.releaseClaim(id)).toMatchObject({ status: 'owed', claimedAt: null });
    expect(await store.releaseClaim(id)).toBeUndefined();
    await store.claimForInvoice(id, '2026-11-09');
    const invoiced = await store.setInvoiced(id, {
      invoiceId: 'inv-1',
      paymentHash: 'aa'.repeat(32),
      bolt11: 'lnbc1',
      sparkInvoice: 'spark1one',
      amountMsat: 1_000_000,
    });
    expect(invoiced).toMatchObject({
      status: 'invoiced',
      invoiceId: 'inv-1',
      paymentHash: 'aa'.repeat(32),
      bolt11: 'lnbc1',
      sparkInvoice: 'spark1one',
      amountMsat: 1_000_000,
    });
    expect(await store.markPaid(id)).toBeUndefined();
    expect(await store.claimSettlement(id)).toMatchObject({ status: 'settling' });
    expect(await store.claimSettlement(id)).toBeUndefined();
    expect(await store.releaseSettlement(id)).toMatchObject({ status: 'invoiced' });
    expect(await store.releaseSettlement(id)).toBeUndefined();
    expect(await store.claimSettlement(id)).toMatchObject({ status: 'settling' });
    expect(await store.markPaid(id)).toMatchObject({ status: 'paid', failure: null });
    expect(await store.markPaid(id)).toBeUndefined();
    expect(await store.releaseSettlement(id)).toBeUndefined();
    expect(await store.markFailed(id, 'Passkey required')).toBeUndefined();
  });

  it('marks only an issuing row failed and refuses paid on it', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    const { id } = enqueue();
    await store.enqueue(enqueue());
    expect(await store.markFailed(id, 'Passkey required')).toBeUndefined();
    await store.claimForInvoice(id, '2026-11-09');
    expect(await store.markFailed(id, 'Passkey required')).toMatchObject({
      status: 'failed',
      failure: 'Passkey required',
    });
    expect(await store.markPaid(id)).toBeUndefined();
  });

  it('lists open rows of one day oldest first, including issuing and settling rows', async () => {
    let clock = NOW;
    const store = new InMemoryFondPayoutStore(() => clock);
    await store.enqueue(enqueue({ id: 'a' }));
    clock = NOW + 1000;
    await store.enqueue(enqueue({ id: 'b', address: 'bob@example.com' }));
    clock = NOW + 2000;
    await store.enqueue(enqueue({ id: 'c', address: 'cy@example.com' }));
    clock = NOW + 3000;
    await store.enqueue(enqueue({ id: 'other', utcDay: '2026-11-08', kind: 'welcome' }));
    await store.claimForInvoice('a', '2026-11-09');
    await store.setInvoiced('a', {
      invoiceId: 'inv-a',
      paymentHash: 'aa'.repeat(32),
      bolt11: 'lnbc1',
      sparkInvoice: null,
      amountMsat: 1_000_000,
    });
    await store.claimSettlement('a');
    await store.markPaid('a');
    await store.enqueue(enqueue({ id: 'settling', address: 'settling@example.com' }));
    await store.claimForInvoice('settling', '2026-11-09');
    await store.setInvoiced('settling', {
      invoiceId: 'inv-s',
      paymentHash: 'bb'.repeat(32),
      bolt11: 'lnbc2',
      sparkInvoice: null,
      amountMsat: 1_000_000,
    });
    await store.claimSettlement('settling');
    await store.claimForInvoice('b', '2026-11-09');
    await store.markFailed('b', 'x');
    expect((await store.listOpen('2026-11-09')).map((row) => row.id)).toEqual(['c', 'settling']);
    expect((await store.listOpen('2026-11-08')).map((row) => row.id)).toEqual(['other']);
  });

  it('breaks same-createdAt ties by id in both directions and when ids compare equal', async () => {
    async function orderedIds(ids: readonly string[]): Promise<string[]> {
      const store = new InMemoryFondPayoutStore(() => NOW);
      for (const [index, id] of ids.entries()) {
        await store.enqueue(enqueue({ id, address: `user${index}@example.com` }));
      }
      return (await store.listOpen('2026-11-09')).map((row) => String(row.id));
    }

    expect(await orderedIds(['b', 'a'])).toEqual(['a', 'b']);
    expect(await orderedIds(['a', 'b'])).toEqual(['a', 'b']);

    const equalId = (): string => {
      return { toString: () => 'same', valueOf: () => 'same' } as unknown as string;
    };
    expect(await orderedIds([equalId(), equalId()])).toEqual(['same', 'same']);
  });

  it('returns copies so callers cannot mutate stored rows', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    const { id } = enqueue();
    await store.enqueue(enqueue());
    const row = await store.get(id);
    row?.createdAt.setTime(0);
    expect((await store.get(id))?.createdAt.getTime()).toBe(NOW);
  });

  it('returns null for a claim and undefined for a transition on an unknown id', async () => {
    const store = new InMemoryFondPayoutStore(() => NOW);
    expect(await store.claimForInvoice('missing', '2026-11-09')).toBeNull();
    expect(await store.claimSettlement('missing')).toBeUndefined();
    expect(await store.markPaid('missing')).toBeUndefined();
    expect(await store.releaseSettlement('missing')).toBeUndefined();
    expect(await store.claimStaleIssuing('missing', new Date(NOW))).toBeUndefined();
    expect(await store.markStaleSettlingPaid('missing', new Date(NOW))).toBeUndefined();
    expect(await store.restoreStaleSettling('missing', new Date(NOW))).toBeUndefined();
  });

  it('re-claims a stale issuing row and reports both time windows', async () => {
    let clock = NOW;
    const store = new InMemoryFondPayoutStore(() => clock);
    expect(FOND_CLAIM_LEASE_MS).toBe(120_000);
    expect(FOND_OVERDUE_MS).toBe(15 * 60_000);
    await store.enqueue(enqueue());
    await store.claimForInvoice(enqueue().id, '2026-11-09');
    expect(await store.claimStaleIssuing(enqueue().id, new Date(NOW))).toBeUndefined();
    clock = NOW + 1000;
    const reclaimed = await store.claimStaleIssuing(enqueue().id, new Date(NOW + 1));
    expect(reclaimed).toMatchObject({ status: 'issuing', claimedAt: new Date(clock) });

    await store.enqueue(enqueue({ id: 'owed', address: 'owed@example.com' }));
    expect(await store.claimStaleIssuing('owed', new Date(NOW + 999_999))).toBeUndefined();
  });

  it('recovers a stale settling row only when its claim expired', async () => {
    let clock = NOW;
    const store = new InMemoryFondPayoutStore(() => clock);
    const { id } = enqueue();
    await store.enqueue(enqueue());
    await store.claimForInvoice(id, '2026-11-09');
    await store.setInvoiced(id, {
      invoiceId: 'inv',
      paymentHash: 'aa'.repeat(32),
      bolt11: 'lnbc1',
      sparkInvoice: null,
      amountMsat: 1_000_000,
    });
    expect((await store.get(id))?.claimedAt).toBeNull();
    await store.claimSettlement(id);
    expect(await store.markStaleSettlingPaid(id, new Date(NOW))).toBeUndefined();

    clock = NOW + FOND_CLAIM_LEASE_MS;
    expect(await store.restoreStaleSettling(id, new Date(NOW + 1))).toMatchObject({
      status: 'invoiced',
      claimedAt: null,
    });

    await store.claimSettlement(id);
    clock = NOW + FOND_CLAIM_LEASE_MS * 2;
    expect(
      await store.markStaleSettlingPaid(id, new Date(NOW + FOND_CLAIM_LEASE_MS + 1)),
    ).toMatchObject({
      status: 'paid',
      failure: null,
      claimedAt: null,
    });
  });

  it('keeps a stale settling row unchanged when it is restored for a retry', async () => {
    let clock = NOW;
    const store = new InMemoryFondPayoutStore(() => clock);
    const { id } = enqueue();
    await store.enqueue(enqueue());
    await store.claimForInvoice(id, '2026-11-09');
    await store.setInvoiced(id, {
      invoiceId: 'inv',
      paymentHash: 'aa'.repeat(32),
      bolt11: 'lnbc1',
      sparkInvoice: null,
      amountMsat: 1_000_000,
    });
    await store.claimSettlement(id);
    clock = NOW + 1000;
    expect(await store.restoreStaleSettling(id, new Date(NOW + 1))).toMatchObject({
      status: 'invoiced',
      failure: null,
      claimedAt: null,
    });
  });
});

describe('PostgresFondPayoutStore', () => {
  it('inserts with ON CONFLICT DO NOTHING and returns accepted for a new row', async () => {
    const sql = new MockSql();
    sql.queryResults = [[{ id: 'x' }]];
    const store = new PostgresFondPayoutStore(sql);
    expect(await store.enqueue(enqueue())).toBe('accepted');
    expect(sql.queries[0]?.text).toContain('ON CONFLICT DO NOTHING');
    expect(sql.queries[0]?.params).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '2026-11-09',
      'daily',
      'ada@example.com',
      '1.00',
      'thanks',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      null,
    ]);
  });

  it('aggregates paid rows with one count-plus-sum query', async () => {
    const sql = new MockSql();
    sql.queryResults = [[{ payouts_paid: '2', payouts_paid_usd: '350' }]];
    const store = new PostgresFondPayoutStore(sql);
    await expect(store.paidTotals()).resolves.toEqual({
      payoutsPaid: 2,
      payoutsPaidUsd: '3.50',
    });
    expect(sql.queries[0]?.text).toContain("WHERE status = 'paid'");
    expect(sql.queries[0]?.text).toContain('COUNT(*)::bigint');
    expect(sql.queries[0]?.text).toContain('round(amount_usd::numeric * 100)');
    expect(sql.queries[0]?.params).toEqual([]);
  });

  it('reads paid USD by payment hash or invoice in one ANY text[] query', async () => {
    const sql = new MockSql();
    sql.queryResults = [
      [
        {
          payment_hash: 'aa',
          spark_invoice: 'spark-a',
          bolt11: 'lnbc-a',
          amount_usd: '1',
        },
        {
          payment_hash: 'bb',
          spark_invoice: 'spark-b',
          bolt11: 'lnbc-b',
          amount_usd: '2.5',
        },
        {
          payment_hash: null,
          spark_invoice: 'spark-open',
          bolt11: 'lnbc-open',
          amount_usd: '9.99',
        },
        {
          payment_hash: 'zz',
          spark_invoice: null,
          bolt11: null,
          amount_usd: '4.00',
        },
      ],
    ];
    const store = new PostgresFondPayoutStore(sql);
    await expect(
      store.paidUsdByPaymentHashOrInvoice(['aa', 'bb', 'cc'], ['spark-b', 'lnbc-a', 'unknown']),
    ).resolves.toEqual(
      new Map([
        ['aa', '1.00'],
        ['lnbc-a', '1.00'],
        ['bb', '2.50'],
        ['spark-b', '2.50'],
      ]),
    );
    expect(sql.queries[0]?.text).toContain(
      "WHERE status = 'paid' AND (payment_hash = ANY($1::text[]) OR spark_invoice = ANY($2::text[]) OR bolt11 = ANY($2::text[]))",
    );
    expect(sql.queries[0]?.text).toContain(
      'SELECT payment_hash, spark_invoice, bolt11, amount_usd',
    );
    expect(sql.queries[0]?.params).toEqual(['{"aa","bb","cc"}', '{"spark-b","lnbc-a","unknown"}']);
    await expect(store.paidUsdByPaymentHashOrInvoice([], [])).resolves.toEqual(new Map());
    expect(sql.queries).toHaveLength(1);
  });

  it('returns zero paid totals when the aggregate has no rows', async () => {
    const sql = new MockSql();
    const store = new PostgresFondPayoutStore(sql);
    await expect(store.paidTotals()).resolves.toEqual({ payoutsPaid: 0, payoutsPaidUsd: '0.00' });
    sql.queryResults = [[{ payouts_paid: 0n, payouts_paid_usd: null }]];
    await expect(store.paidTotals()).resolves.toEqual({ payoutsPaid: 0, payoutsPaidUsd: '0.00' });
  });

  it('reads the conflicting daily row and maps paid to skipped', async () => {
    const sql = new MockSql();
    sql.queryResults = [[], [{ status: 'paid' }]];
    const store = new PostgresFondPayoutStore(sql);
    expect(await store.enqueue(enqueue())).toBe('paid');
    expect(sql.queries[1]?.text).toContain('utc_day = $1 AND kind = $2 AND address = $3');
    expect(sql.queries[1]?.params).toEqual(['2026-11-09', 'daily', 'ada@example.com']);
  });

  it('reads the conflicting welcome row without the day', async () => {
    const sql = new MockSql();
    sql.queryResults = [[], [{ status: 'owed' }]];
    const store = new PostgresFondPayoutStore(sql);
    expect(await store.enqueue(enqueue({ kind: 'welcome' }))).toBe('accepted');
    expect(sql.queries[1]?.text).toContain("kind = 'welcome' AND address = $1");
    expect(sql.queries[1]?.params).toEqual(['ada@example.com']);
  });

  it('treats a missing conflict row as failed', async () => {
    const sql = new MockSql();
    sql.queryResults = [[], []];
    const store = new PostgresFondPayoutStore(sql);
    expect(await store.enqueue(enqueue())).toBe('failed');
  });

  it('lists open rows and maps driver values', async () => {
    const sql = new MockSql();
    sql.queryResults = [
      [
        {
          id: 'row',
          utc_day: '2026-11-09',
          kind: 'daily',
          address: 'ada@example.com',
          amount_usd: '1.00',
          comment: 'thanks',
          message_id: 'm',
          group_message_id: null,
          status: 'owed',
          failure: null,
          invoice_id: null,
          payment_hash: null,
          bolt11: null,
          spark_invoice: null,
          amount_msat: null,
          claimed_at: null,
          created_at: new Date(NOW),
          updated_at: NOW,
        },
      ],
    ];
    const rows = await new PostgresFondPayoutStore(sql).listOpen('2026-11-09');
    expect(sql.queries[0]?.text).toContain("status IN ('owed', 'issuing', 'invoiced', 'settling')");
    expect(sql.queries[0]?.params).toEqual(['2026-11-09']);
    expect(rows[0]).toEqual({
      id: 'row',
      utcDay: '2026-11-09',
      kind: 'daily',
      address: 'ada@example.com',
      amountUsd: '1.00',
      comment: 'thanks',
      messageId: 'm',
      groupMessageId: null,
      status: 'owed',
      failure: null,
      invoiceId: null,
      paymentHash: null,
      bolt11: null,
      sparkInvoice: null,
      amountMsat: null,
      claimedAt: null,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    });
  });

  it('maps a Date utc_day and returns undefined for a missing row', async () => {
    const sql = new MockSql();
    sql.queryResults = [
      [
        {
          id: 'row',
          utc_day: new Date('2026-11-09T00:00:00.000Z'),
          kind: 'welcome',
          address: 'ada@example.com',
          amount_usd: '1.00',
          comment: 'Welcome',
          message_id: null,
          group_message_id: null,
          status: 'paid',
          failure: null,
          invoice_id: 'i',
          payment_hash: 'h',
          bolt11: 'b',
          spark_invoice: 'spark1one',
          amount_msat: '1000000',
          claimed_at: new Date(NOW),
          created_at: NOW,
          updated_at: NOW,
        },
      ],
      [],
    ];
    const store = new PostgresFondPayoutStore(sql);
    const row = await store.get('row');
    expect(row?.utcDay).toBe('2026-11-09');
    expect(row?.claimedAt).toEqual(new Date(NOW));
    expect(row?.sparkInvoice).toBe('spark1one');
    expect(await store.get('missing')).toBeUndefined();
  });

  it('returns undefined when a stale issuing claim wins no row', async () => {
    const sql = new MockSql();
    const store = new PostgresFondPayoutStore(sql);
    expect(await store.claimStaleIssuing('row', new Date(NOW))).toBeUndefined();
    expect(sql.queries[0]?.text).toContain("status = 'issuing' AND claimed_at < $2");
  });

  it('returns undefined when a stale settlement wins no row', async () => {
    const sql = new MockSql();
    const store = new PostgresFondPayoutStore(sql);
    expect(await store.markStaleSettlingPaid('row', new Date(NOW))).toBeUndefined();
    expect(sql.queries[0]?.text).toContain("status = 'settling' AND claimed_at < $2");
  });

  it('maps a stale issuing claim that wins a row', async () => {
    const sql = new MockSql();
    const claimedAt = new Date(NOW);
    sql.queryResults = [
      [
        {
          id: 'row',
          utc_day: '2026-11-09',
          kind: 'daily',
          address: 'ada@example.com',
          amount_usd: '1.00',
          comment: 'thanks',
          message_id: 'm',
          group_message_id: null,
          status: 'issuing',
          failure: null,
          invoice_id: null,
          payment_hash: null,
          bolt11: null,
          spark_invoice: null,
          amount_msat: null,
          claimed_at: claimedAt,
          created_at: NOW,
          updated_at: NOW,
        },
      ],
    ];
    const store = new PostgresFondPayoutStore(sql);
    const row = await store.claimStaleIssuing('row', new Date(NOW));
    expect(row).toMatchObject({ status: 'issuing', claimedAt });
    expect(sql.queries[0]?.params).toEqual(['row', new Date(NOW)]);
  });

  it('maps stale settlement transitions that win a row', async () => {
    const sql = new MockSql();
    const claimedAt = new Date(NOW);
    const driver = {
      id: 'row',
      utc_day: '2026-11-09',
      kind: 'daily',
      address: 'ada@example.com',
      amount_usd: '1.00',
      comment: 'thanks',
      message_id: 'm',
      group_message_id: null,
      status: 'paid',
      failure: null,
      invoice_id: 'i',
      payment_hash: 'h',
      bolt11: 'b',
      spark_invoice: null,
      amount_msat: '1000000',
      claimed_at: claimedAt,
      created_at: NOW,
      updated_at: NOW,
    };
    sql.queryResults = [[driver], [{ ...driver, status: 'invoiced' }]];
    const store = new PostgresFondPayoutStore(sql);
    expect(await store.markStaleSettlingPaid('row', new Date(NOW))).toMatchObject({
      status: 'paid',
      claimedAt,
    });
    expect(await store.restoreStaleSettling('row', new Date(NOW))).toMatchObject({
      status: 'invoiced',
      claimedAt,
    });
    expect(sql.queries[0]?.params).toEqual(['row', new Date(NOW), 'paid']);
    expect(sql.queries[1]?.params).toEqual(['row', new Date(NOW), 'invoiced']);
  });

  it('returns undefined from stale transitions when UPDATE RETURNING is empty', async () => {
    const sql = new MockSql();
    sql.queryResults = [[], [], []];
    const store = new PostgresFondPayoutStore(sql);
    expect(await store.claimStaleIssuing('row', new Date(NOW))).toBeUndefined();
    expect(await store.markStaleSettlingPaid('row', new Date(NOW))).toBeUndefined();
    expect(await store.restoreStaleSettling('row', new Date(NOW))).toBeUndefined();
    expect(sql.queries).toHaveLength(3);
    expect(sql.queries[0]?.text).toContain('RETURNING');
    expect(sql.queries[0]?.text).toContain("status = 'issuing' AND claimed_at < $2");
    expect(sql.queries[0]?.params).toEqual(['row', new Date(NOW)]);
    expect(sql.queries[1]?.text).toContain(
      'SET status = $3, claimed_at = NULL, updated_at = now()',
    );
    expect(sql.queries[1]?.text).toContain("status = 'settling' AND claimed_at < $2");
    expect(sql.queries[1]?.params).toEqual(['row', new Date(NOW), 'paid']);
    expect(sql.queries[2]?.params).toEqual(['row', new Date(NOW), 'invoiced']);
  });

  it('claims, updates invoice, releases, fails, and pays with guarded WHERE clauses', async () => {
    const sql = new MockSql();
    const store = new PostgresFondPayoutStore(sql);
    const driver = {
      id: 'row',
      utc_day: '2026-11-09',
      kind: 'daily',
      address: 'ada@example.com',
      amount_usd: '1.00',
      comment: 'thanks',
      message_id: 'm',
      group_message_id: null,
      status: 'invoiced',
      failure: null,
      invoice_id: 'i',
      payment_hash: 'h',
      bolt11: 'b',
      spark_invoice: null,
      amount_msat: 1_000_000,
      claimed_at: null,
      created_at: NOW,
      updated_at: NOW,
    };
    sql.queryResults = [
      [driver],
      [driver],
      [driver],
      [driver],
      [driver],
      [driver],
      [driver],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
    ];
    expect(await store.claimForInvoice('row', '2026-11-09')).toMatchObject({ status: 'invoiced' });
    expect(sql.queries[0]?.text).toContain("WHERE id = $1 AND utc_day = $2 AND status = 'owed'");
    expect(sql.queries[0]?.text).toContain('claimed_at = now()');
    expect(sql.queries[0]?.params).toEqual(['row', '2026-11-09']);
    expect(
      await store.setInvoiced('row', {
        invoiceId: 'i',
        paymentHash: 'h',
        bolt11: 'b',
        sparkInvoice: 'spark1one',
        amountMsat: 1_000_000,
      }),
    ).toMatchObject({ status: 'invoiced' });
    expect(sql.queries[1]?.text).toContain("WHERE id = $1 AND status = 'issuing'");
    expect(sql.queries[1]?.text).toContain('claimed_at = NULL');
    expect(sql.queries[1]?.text).toContain('spark_invoice = $5, amount_msat = $6');
    expect(sql.queries[1]?.params).toEqual(['row', 'i', 'h', 'b', 'spark1one', 1_000_000]);
    expect(await store.markFailed('row', 'Passkey required')).toMatchObject({
      status: 'invoiced',
    });
    expect(sql.queries[2]?.params).toEqual(['row', 'Passkey required']);
    expect(sql.queries[2]?.text).toContain('claimed_at = NULL');
    expect(await store.releaseClaim('row')).toMatchObject({ status: 'invoiced' });
    expect(sql.queries[3]?.text).toContain("WHERE id = $1 AND status = 'issuing'");
    expect(sql.queries[3]?.params).toEqual(['row']);
    expect(sql.queries[3]?.text).toContain('claimed_at = NULL');
    expect(await store.claimSettlement('row')).toMatchObject({ status: 'invoiced' });
    expect(sql.queries[4]?.text).toContain(
      "SET status = 'settling', claimed_at = now(), updated_at = now()",
    );
    expect(sql.queries[4]?.text).toContain("WHERE id = $1 AND status = 'invoiced'");
    expect(sql.queries[4]?.params).toEqual(['row']);
    expect(await store.markPaid('row')).toMatchObject({ status: 'invoiced' });
    expect(sql.queries[5]?.text).toContain(
      "SET status = 'paid', failure = NULL, claimed_at = NULL, updated_at = now()",
    );
    expect(sql.queries[5]?.text).toContain("WHERE id = $1 AND status = 'settling'");
    expect(sql.queries[5]?.params).toEqual(['row']);
    expect(await store.releaseSettlement('row')).toMatchObject({ status: 'invoiced' });
    expect(sql.queries[6]?.text).toContain(
      "SET status = 'invoiced', claimed_at = NULL, updated_at = now()",
    );
    expect(sql.queries[6]?.text).toContain("WHERE id = $1 AND status = 'settling'");
    expect(sql.queries[6]?.params).toEqual(['row']);
    expect(
      await store.setInvoiced('row', {
        invoiceId: 'i',
        paymentHash: 'h',
        bolt11: 'b',
        sparkInvoice: null,
        amountMsat: 1_000_000,
      }),
    ).toBeUndefined();
    expect(await store.claimForInvoice('row', '2026-11-09')).toBeNull();
    expect(await store.markFailed('row', 'x')).toBeUndefined();
    expect(await store.releaseClaim('row')).toBeUndefined();
    expect(await store.claimSettlement('row')).toBeUndefined();
    expect(await store.markPaid('row')).toBeUndefined();
    expect(await store.releaseSettlement('row')).toBeUndefined();
    expect(await store.claimStaleIssuing('row', new Date(NOW))).toBeUndefined();
    expect(sql.queries[14]?.text).toContain("status = 'issuing' AND claimed_at < $2");
    expect(await store.markStaleSettlingPaid('row', new Date(NOW))).toBeUndefined();
    expect(sql.queries[15]?.text).toContain("status = 'settling' AND claimed_at < $2");
    expect(await store.restoreStaleSettling('row', new Date(NOW))).toBeUndefined();
    expect(sql.queries[16]?.text).toContain("status = 'settling' AND claimed_at < $2");
  });

  it('stores a null Spark invoice when setInvoiced omits it', async () => {
    const memory = new InMemoryFondPayoutStore(() => NOW);
    await memory.enqueue(enqueue());
    await memory.claimForInvoice(enqueue().id, '2026-11-09');
    expect(
      await memory.setInvoiced(enqueue().id, {
        invoiceId: 'i',
        paymentHash: 'h',
        bolt11: 'b',
        amountMsat: 1_000_000,
      }),
    ).toMatchObject({ sparkInvoice: null });

    const sql = new MockSql();
    const driver = {
      id: 'row',
      utc_day: '2026-11-09',
      kind: 'daily',
      address: 'ada@example.com',
      amount_usd: '1.00',
      comment: 'thanks',
      message_id: null,
      group_message_id: null,
      status: 'invoiced',
      failure: null,
      invoice_id: 'i',
      payment_hash: 'h',
      bolt11: 'b',
      spark_invoice: null,
      amount_msat: 1_000_000,
      claimed_at: null,
      created_at: NOW,
      updated_at: NOW,
    };
    sql.queryResults = [[driver]];
    const postgres = new PostgresFondPayoutStore(sql);
    await postgres.setInvoiced('row', {
      invoiceId: 'i',
      paymentHash: 'h',
      bolt11: 'b',
      amountMsat: 1_000_000,
    });
    expect(sql.queries[0]?.params).toEqual(['row', 'i', 'h', 'b', null, 1_000_000]);
  });
});
