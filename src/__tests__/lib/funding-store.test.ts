import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import type { FundingGrant } from '@/lib/funding';
import {
  FUNDING_SCHEMA_SQL,
  InMemoryFundingStore,
  PostgresFundingStore,
  loadGrantEffective,
  migrateFundingSchema,
} from '@/lib/funding-store';

class MockSql implements SqlClient {
  executes: { text: string; params: readonly unknown[] }[] = [];
  queries: { text: string; params: readonly unknown[] }[] = [];
  nextRows: unknown[] = [];
  queryError: unknown | undefined;
  executeError: unknown | undefined;

  async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    this.queries.push({ text, params });
    if (this.queryError !== undefined) {
      throw this.queryError;
    }
    return this.nextRows as T[];
  }

  async execute(text: string, params: readonly unknown[] = []): Promise<void> {
    this.executes.push({ text, params });
    if (this.executeError !== undefined) {
      throw this.executeError;
    }
  }
}

const NOW_MS = Date.parse('2026-09-20T12:00:00.000Z');
const TODAY = '2026-09-20';
const YESTERDAY = '2026-09-19';
const TOMORROW = '2026-09-21';
const APPLIED = Date.parse('2026-09-01T00:00:00.000Z');
const DECIDED = Date.parse('2026-09-10T08:00:00.000Z');
const ADMITTED = Date.parse('2026-09-15T18:00:00.000Z');

function grant(overrides: Partial<FundingGrant> = {}): FundingGrant {
  return {
    accountId: 'acc-a',
    status: 'pending',
    appliedAt: APPLIED,
    decidedAt: null,
    decidedBy: null,
    trialUtcDate: null,
    admittedAt: null,
    note: null,
    ...overrides,
  };
}

const EARLY = grant({
  accountId: 'acc-z',
  appliedAt: Date.parse('2026-08-01T00:00:00.000Z'),
  note: 'early',
});

const TIE_HIGH = grant({
  accountId: 'acc-b',
  appliedAt: Date.parse('2026-08-02T00:00:00.000Z'),
  note: 'tie-high',
});

const TIE_LOW = grant({
  accountId: 'acc-a',
  appliedAt: Date.parse('2026-08-02T00:00:00.000Z'),
  note: 'tie-low',
});

const LATE = grant({
  accountId: 'acc-m',
  appliedAt: Date.parse('2026-08-03T00:00:00.000Z'),
  note: 'late',
});

describe('FUNDING_SCHEMA_SQL', () => {
  it('creates funding_grant with the expected columns and status check', () => {
    expect(FUNDING_SCHEMA_SQL).toHaveLength(1);
    expect(FUNDING_SCHEMA_SQL[0]).toMatch(/CREATE TABLE IF NOT EXISTS funding_grant/i);
    expect(FUNDING_SCHEMA_SQL[0]).toMatch(/account_id uuid PRIMARY KEY REFERENCES account/i);
    expect(FUNDING_SCHEMA_SQL[0]).toMatch(
      /CHECK \(status IN \('pending', 'trial', 'admitted', 'rejected'\)\)/,
    );
    expect(FUNDING_SCHEMA_SQL[0]).toMatch(/trial_utc_date date/);
  });
});

describe('migrateFundingSchema', () => {
  it('runs every FUNDING_SCHEMA_SQL statement', async () => {
    const sql = new MockSql();
    await migrateFundingSchema(sql);
    expect(sql.executes.map((item) => item.text)).toEqual([...FUNDING_SCHEMA_SQL]);
    expect(sql.executes[0]?.text).toMatch(/CREATE TABLE IF NOT EXISTS funding_grant/i);
  });
});

describe('InMemoryFundingStore', () => {
  it('returns an equal copy after upsert, not the same object', async () => {
    const store = new InMemoryFundingStore();
    const input = grant({ status: 'admitted', admittedAt: ADMITTED, note: 'ok' });
    const created = await store.upsert(input);
    expect(created).toEqual(input);
    expect(created).not.toBe(input);
    const loaded = await store.getByAccountId('acc-a');
    expect(loaded).toEqual(input);
    expect(loaded).not.toBe(input);
    expect(loaded).not.toBe(created);
  });

  it('getByAccountId returns undefined when missing', async () => {
    expect(await new InMemoryFundingStore().getByAccountId('missing')).toBeUndefined();
  });

  it('listGrants is empty on a fresh store', async () => {
    expect(await new InMemoryFundingStore().listGrants()).toEqual([]);
  });

  it('listGrants orders by oldest appliedAt then accountId ascending', async () => {
    const store = new InMemoryFundingStore([LATE, TIE_HIGH, EARLY, TIE_LOW]);
    expect((await store.listGrants()).map((row) => row.note)).toEqual([
      'early',
      'tie-low',
      'tie-high',
      'late',
    ]);
  });

  it('second upsert for the same accountId replaces the row', async () => {
    const store = new InMemoryFundingStore();
    await store.upsert(grant({ status: 'pending', note: 'old' }));
    const replaced = await store.upsert(
      grant({
        status: 'trial',
        trialUtcDate: TODAY,
        decidedAt: DECIDED,
        decidedBy: 'staff',
        note: 'new',
      }),
    );
    expect(replaced.status).toBe('trial');
    expect(replaced.note).toBe('new');
    const listed = await store.listGrants();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.note).toBe('new');
    expect(listed[0]?.status).toBe('trial');
    expect(listed[0]?.trialUtcDate).toBe(TODAY);
  });

  it('copies seed, listed, got, and upserted objects so callers cannot mutate store state', async () => {
    const seed: FundingGrant[] = [grant({ note: 'seed' }), LATE];
    const store = new InMemoryFundingStore(seed);
    seed.pop();
    if (seed[0] !== undefined) {
      seed[0].note = 'mutated-seed';
      seed[0].status = 'rejected';
    }
    const listed = await store.listGrants();
    expect(listed).toHaveLength(2);
    listed.pop();
    if (listed[0] !== undefined) {
      listed[0].note = 'mutated-list';
    }
    const got = await store.getByAccountId('acc-a');
    if (got !== undefined) {
      got.note = 'mutated-got';
    }
    const created = await store.upsert(grant({ accountId: 'acc-new', note: 'fresh' }));
    created.note = 'mutated-upsert-return';
    const input = grant({ accountId: 'acc-write', note: 'write' });
    await store.upsert(input);
    input.note = 'mutated-input';
    expect((await store.getByAccountId('acc-a'))?.note).toBe('seed');
    expect((await store.getByAccountId('acc-m'))?.note).toBe('late');
    expect((await store.getByAccountId('acc-new'))?.note).toBe('fresh');
    expect((await store.getByAccountId('acc-write'))?.note).toBe('write');
    expect(await store.listGrants()).toHaveLength(4);
  });
});

describe('loadGrantEffective', () => {
  it('persists pending when the stored trial day is before today UTC', async () => {
    const store = new InMemoryFundingStore();
    const stored = grant({
      status: 'trial',
      trialUtcDate: YESTERDAY,
      decidedAt: DECIDED,
      decidedBy: 'staff',
      note: 'keep',
    });
    await store.upsert(stored);
    const loaded = await loadGrantEffective(store, 'acc-a', NOW_MS);
    expect(loaded).toEqual({
      accountId: 'acc-a',
      status: 'pending',
      appliedAt: APPLIED,
      decidedAt: DECIDED,
      decidedBy: 'staff',
      trialUtcDate: null,
      admittedAt: null,
      note: 'keep',
    });
    expect(await store.getByAccountId('acc-a')).toEqual(loaded);
  });

  it('returns undefined and does not upsert when no row exists', async () => {
    const store = new InMemoryFundingStore();
    expect(await loadGrantEffective(store, 'missing', NOW_MS)).toBeUndefined();
    expect(await store.listGrants()).toEqual([]);
  });

  it('does not rewrite a trial for today or tomorrow', async () => {
    const store = new InMemoryFundingStore();
    await store.upsert(grant({ accountId: 'today', status: 'trial', trialUtcDate: TODAY }));
    await store.upsert(grant({ accountId: 'tomorrow', status: 'trial', trialUtcDate: TOMORROW }));
    const today = await loadGrantEffective(store, 'today', NOW_MS);
    const tomorrow = await loadGrantEffective(store, 'tomorrow', NOW_MS);
    expect(today?.status).toBe('trial');
    expect(today?.trialUtcDate).toBe(TODAY);
    expect(tomorrow?.status).toBe('trial');
    expect(tomorrow?.trialUtcDate).toBe(TOMORROW);
    expect((await store.getByAccountId('today'))?.status).toBe('trial');
    expect((await store.getByAccountId('tomorrow'))?.status).toBe('trial');
  });
});

describe('PostgresFundingStore', () => {
  it('getByAccountId binds $1 and maps Date and string timestamps and trial_utc_date Date', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        account_id: 'acc-a',
        status: 'trial',
        applied_at: new Date('2026-09-01T00:00:00.000Z'),
        decided_at: '2026-09-10T08:00:00.000Z',
        decided_by: 'staff',
        trial_utc_date: new Date('2026-09-20T00:00:00.000Z'),
        admitted_at: null,
        note: 'hello',
      },
    ];
    const loaded = await new PostgresFundingStore(sql).getByAccountId('acc-a');
    expect(sql.queries[0]?.text).toMatch(/SELECT .+ FROM funding_grant WHERE account_id = \$1/);
    expect(sql.queries[0]?.params).toEqual(['acc-a']);
    expect(loaded).toEqual({
      accountId: 'acc-a',
      status: 'trial',
      appliedAt: APPLIED,
      decidedAt: DECIDED,
      decidedBy: 'staff',
      trialUtcDate: TODAY,
      admittedAt: null,
      note: 'hello',
    });
  });

  it('getByAccountId returns undefined when no row matches', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    expect(await new PostgresFundingStore(sql).getByAccountId('missing')).toBeUndefined();
  });

  it('maps null trial_utc_date and null timestamptz columns', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        account_id: 'acc-a',
        status: 'pending',
        applied_at: new Date('2026-09-01T00:00:00.000Z'),
        decided_at: null,
        decided_by: null,
        trial_utc_date: null,
        admitted_at: null,
        note: null,
      },
    ];
    expect(await new PostgresFundingStore(sql).getByAccountId('acc-a')).toEqual(grant());
  });

  it('listGrants orders by applied_at then account_id and maps string trial dates', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        account_id: 'acc-a',
        status: 'admitted',
        applied_at: '2026-09-01T00:00:00.000Z',
        decided_at: new Date('2026-09-10T08:00:00.000Z'),
        decided_by: null,
        trial_utc_date: '2026-09-20T00:00:00.000Z',
        admitted_at: new Date('2026-09-15T18:00:00.000Z'),
        note: null,
      },
    ];
    const listed = await new PostgresFundingStore(sql).listGrants();
    expect(sql.queries[0]?.text).toMatch(/ORDER BY applied_at ASC, account_id ASC/);
    expect(sql.queries[0]?.params).toEqual([]);
    expect(listed).toEqual([
      {
        accountId: 'acc-a',
        status: 'admitted',
        appliedAt: APPLIED,
        decidedAt: DECIDED,
        decidedBy: null,
        trialUtcDate: TODAY,
        admittedAt: ADMITTED,
        note: null,
      },
    ]);
  });

  it('upsert uses INSERT and ON CONFLICT (account_id) DO UPDATE', async () => {
    const sql = new MockSql();
    const input = grant({
      status: 'admitted',
      decidedAt: DECIDED,
      decidedBy: 'staff',
      trialUtcDate: TODAY,
      admittedAt: ADMITTED,
      note: 'n',
    });
    const created = await new PostgresFundingStore(sql).upsert(input);
    expect(sql.executes[0]?.text).toMatch(/INSERT INTO funding_grant/);
    expect(sql.executes[0]?.text).toMatch(/ON CONFLICT \(account_id\) DO UPDATE/);
    expect(sql.executes[0]?.params).toEqual([
      input.accountId,
      input.status,
      new Date(input.appliedAt),
      new Date(DECIDED),
      'staff',
      TODAY,
      new Date(ADMITTED),
      'n',
    ]);
    expect(created).toEqual(input);
    expect(created).not.toBe(input);
  });

  it('propagates query errors', async () => {
    const sql = new MockSql();
    sql.queryError = new Error('list boom');
    await expect(new PostgresFundingStore(sql).getByAccountId('acc-a')).rejects.toThrow(
      'list boom',
    );
    await expect(new PostgresFundingStore(sql).listGrants()).rejects.toThrow('list boom');
  });

  it('propagates upsert execute errors', async () => {
    const sql = new MockSql();
    sql.executeError = new Error('write boom');
    await expect(new PostgresFundingStore(sql).upsert(grant())).rejects.toThrow('write boom');
  });
});
