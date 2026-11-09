import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import {
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
      "status text NOT NULL CHECK (status IN ('owed', 'issuing', 'invoiced', 'paid', 'failed'))",
    );
    expect(all).toContain('amount_msat bigint');
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
    expect(await store.markPaid(id)).toBeUndefined();
    expect(await store.claimForInvoice(id, '2026-11-08')).toBeNull();
    expect(
      await store.setInvoiced(id, {
        invoiceId: 'inv-0',
        paymentHash: 'aa'.repeat(32),
        bolt11: 'lnbc0',
        amountMsat: 1_000_000,
      }),
    ).toBeUndefined();
    expect(await store.claimForInvoice(id, '2026-11-09')).toMatchObject({ status: 'issuing' });
    expect(await store.claimForInvoice(id, '2026-11-09')).toBeNull();
    expect(await store.releaseClaim(id)).toMatchObject({ status: 'owed' });
    expect(await store.releaseClaim(id)).toBeUndefined();
    await store.claimForInvoice(id, '2026-11-09');
    const invoiced = await store.setInvoiced(id, {
      invoiceId: 'inv-1',
      paymentHash: 'aa'.repeat(32),
      bolt11: 'lnbc1',
      amountMsat: 1_000_000,
    });
    expect(invoiced).toMatchObject({
      status: 'invoiced',
      invoiceId: 'inv-1',
      paymentHash: 'aa'.repeat(32),
      bolt11: 'lnbc1',
      amountMsat: 1_000_000,
    });
    expect(await store.markPaid(id)).toMatchObject({ status: 'paid', failure: null });
    expect(await store.markFailed(id, 'Passkey required')).toBeUndefined();
    expect(await store.markPaid(id)).toBeUndefined();
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

  it('lists open rows of one day oldest first and hides paid/failed/other days', async () => {
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
      amountMsat: 1_000_000,
    });
    await store.markPaid('a');
    await store.claimForInvoice('b', '2026-11-09');
    await store.markFailed('b', 'x');
    expect((await store.listOpen('2026-11-09')).map((row) => row.id)).toEqual(['c']);
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
    expect(await store.markPaid('missing')).toBeUndefined();
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
          amount_msat: null,
          created_at: new Date(NOW),
          updated_at: NOW,
        },
      ],
    ];
    const rows = await new PostgresFondPayoutStore(sql).listOpen('2026-11-09');
    expect(sql.queries[0]?.text).toContain("status IN ('owed', 'invoiced')");
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
      amountMsat: null,
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
          amount_msat: '1000000',
          created_at: NOW,
          updated_at: NOW,
        },
      ],
      [],
    ];
    const store = new PostgresFondPayoutStore(sql);
    expect((await store.get('row'))?.utcDay).toBe('2026-11-09');
    expect(await store.get('missing')).toBeUndefined();
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
      amount_msat: 1_000_000,
      created_at: NOW,
      updated_at: NOW,
    };
    sql.queryResults = [[driver], [driver], [driver], [driver], [driver], [], [], [], []];
    expect(await store.claimForInvoice('row', '2026-11-09')).toMatchObject({ status: 'invoiced' });
    expect(sql.queries[0]?.text).toContain("WHERE id = $1 AND utc_day = $2 AND status = 'owed'");
    expect(sql.queries[0]?.params).toEqual(['row', '2026-11-09']);
    expect(
      await store.setInvoiced('row', {
        invoiceId: 'i',
        paymentHash: 'h',
        bolt11: 'b',
        amountMsat: 1_000_000,
      }),
    ).toMatchObject({ status: 'invoiced' });
    expect(sql.queries[1]?.text).toContain("WHERE id = $1 AND status = 'issuing'");
    expect(sql.queries[1]?.params).toEqual(['row', 'i', 'h', 'b', 1_000_000]);
    expect(await store.markFailed('row', 'Passkey required')).toMatchObject({
      status: 'invoiced',
    });
    expect(sql.queries[2]?.params).toEqual(['row', 'Passkey required']);
    expect(await store.releaseClaim('row')).toMatchObject({ status: 'invoiced' });
    expect(sql.queries[3]?.text).toContain("WHERE id = $1 AND status = 'issuing'");
    expect(sql.queries[3]?.params).toEqual(['row']);
    expect(await store.markPaid('row')).toMatchObject({ status: 'invoiced' });
    expect(sql.queries[4]?.text).toContain("status = 'invoiced'");
    expect(sql.queries[4]?.params).toEqual(['row']);
    expect(
      await store.setInvoiced('row', {
        invoiceId: 'i',
        paymentHash: 'h',
        bolt11: 'b',
        amountMsat: 1_000_000,
      }),
    ).toBeUndefined();
    expect(await store.claimForInvoice('row', '2026-11-09')).toBeNull();
    expect(await store.markFailed('row', 'x')).toBeUndefined();
    expect(await store.releaseClaim('row')).toBeUndefined();
    expect(await store.markPaid('row')).toBeUndefined();
  });
});
