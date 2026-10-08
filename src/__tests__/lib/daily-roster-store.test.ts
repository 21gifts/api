import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import {
  DAILY_ROSTER_ADDRESS_LISTED,
  DAILY_ROSTER_INVALID_ADDRESS,
  DAILY_ROSTER_INVALID_COMMENT,
  DAILY_ROSTER_INVALID_PAYMENTS,
  DAILY_ROSTER_UNKNOWN_ADDRESS,
  type DailyRosterDocument,
} from '@/lib/daily-roster';
import {
  DAILY_ROSTER_DEFAULT_AMOUNT_USD,
  DAILY_ROSTER_SCHEMA_SQL,
  InMemoryDailyRosterStore,
  PostgresDailyRosterStore,
  migrateDailyRosterSchema,
} from '@/lib/daily-roster-store';

class MockSql implements SqlClient {
  executes: { text: string; params: readonly unknown[] }[] = [];
  queries: { text: string; params: readonly unknown[] }[] = [];
  queryResults: unknown[][] = [];
  executeError: unknown | undefined;
  queryError: unknown | undefined;

  async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    this.queries.push({ text, params });
    if (this.queryError !== undefined) {
      throw this.queryError;
    }
    const next = this.queryResults.shift();
    return (next ?? []) as T[];
  }

  async execute(text: string, params: readonly unknown[] = []): Promise<void> {
    this.executes.push({ text, params });
    if (this.executeError !== undefined) {
      throw this.executeError;
    }
  }
}

const EMPTY: DailyRosterDocument = {
  comment: '',
  paymentsEnabled: true,
  moderatorPaymentsEnabled: true,
  defaultAmountUsd: DAILY_ROSTER_DEFAULT_AMOUNT_USD,
  recipients: [],
  moderators: [],
};

function uniqueError(): { code: string } {
  return { code: '23505' };
}

describe('DAILY_ROSTER_SCHEMA_SQL', () => {
  it('creates the singleton settings table and the entry table', () => {
    expect(DAILY_ROSTER_SCHEMA_SQL).toHaveLength(2);
    expect(DAILY_ROSTER_SCHEMA_SQL[0]).toMatch(/CREATE TABLE IF NOT EXISTS daily_roster/i);
    expect(DAILY_ROSTER_SCHEMA_SQL[0]).toMatch(/singleton boolean PRIMARY KEY/);
    expect(DAILY_ROSTER_SCHEMA_SQL[1]).toMatch(/CREATE TABLE IF NOT EXISTS daily_roster_entry/i);
    expect(DAILY_ROSTER_SCHEMA_SQL[1]).toMatch(/UNIQUE \(address, bucket\)/);
  });
});

describe('migrateDailyRosterSchema', () => {
  it('runs every DAILY_ROSTER_SCHEMA_SQL statement', async () => {
    const sql = new MockSql();
    await migrateDailyRosterSchema(sql);
    expect(sql.executes.map((item) => item.text)).toEqual([...DAILY_ROSTER_SCHEMA_SQL]);
  });
});

describe('InMemoryDailyRosterStore', () => {
  it('returns the empty defaults and does not share the array', async () => {
    const store = new InMemoryDailyRosterStore();
    const first = await store.get();
    expect(first).toEqual(EMPTY);
    first.recipients.push({ address: 'ada@example.com', amountUsd: 1 });
    expect(await store.get()).toEqual(EMPTY);
  });

  it('copies a seed document and always sets defaultAmountUsd to 1', async () => {
    const seed: DailyRosterDocument = {
      comment: 'thanks',
      paymentsEnabled: false,
      moderatorPaymentsEnabled: false,
      defaultAmountUsd: 9,
      recipients: [{ address: 'ada@example.com', amountUsd: 2 }],
      moderators: [{ address: 'mod@example.com', amountUsd: 3 }],
    };
    const store = new InMemoryDailyRosterStore(seed);
    const loaded = await store.get();
    expect(loaded).toEqual({ ...seed, defaultAmountUsd: 1 });
    expect(loaded.recipients).not.toBe(seed.recipients);
    expect(loaded.moderators).not.toBe(seed.moderators);
    seed.recipients[0] = { address: 'other@example.com', amountUsd: 9 };
    expect((await store.get()).recipients[0]?.address).toBe('ada@example.com');
  });

  it('folds a comment, accepts empty, and refuses length over 500', async () => {
    const store = new InMemoryDailyRosterStore();
    expect(await store.setComment('  a\r\nb\nc\rd  ')).toMatchObject({ comment: 'a b c d' });
    expect(await store.setComment(' \n\r ')).toMatchObject({ comment: '' });
    await expect(store.setComment(` ${'a'.repeat(501)}\n`)).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_INVALID_COMMENT,
    });
    await expect(store.setComment(1 as unknown as string)).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_INVALID_COMMENT,
    });
    expect(await store.setComment('b'.repeat(500))).toMatchObject({ comment: 'b'.repeat(500) });
  });

  it('stores both payment switches and refuses a non-boolean', async () => {
    const store = new InMemoryDailyRosterStore();
    expect(await store.setPaymentsEnabled(false)).toMatchObject({ paymentsEnabled: false });
    expect(await store.setModeratorPaymentsEnabled(false)).toMatchObject({
      moderatorPaymentsEnabled: false,
    });
    await expect(store.setPaymentsEnabled(1 as unknown as boolean)).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_INVALID_PAYMENTS,
    });
    await expect(
      store.setModeratorPaymentsEnabled('x' as unknown as boolean),
    ).rejects.toMatchObject({ status: 400, error: DAILY_ROSTER_INVALID_PAYMENTS });
  });

  it('adds, updates, and deletes daily recipients with one address form', async () => {
    const store = new InMemoryDailyRosterStore();
    await store.addRecipient('  Ada@Example.com  ', 2);
    expect(await store.get()).toMatchObject({
      recipients: [{ address: 'ada@example.com', amountUsd: 2 }],
    });
    await expect(store.addRecipient('ADA@example.com', 3)).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_ADDRESS_LISTED,
    });
    await store.updateRecipient(' ADA@EXAMPLE.COM ', 5);
    expect((await store.get()).recipients).toEqual([{ address: 'ada@example.com', amountUsd: 5 }]);
    await store.deleteRecipient('Ada@example.com');
    expect((await store.get()).recipients).toEqual([]);
  });

  it('adds, updates, and deletes moderators without mixing them into recipients', async () => {
    const store = new InMemoryDailyRosterStore();
    await store.addModerator('mod@example.com', 3);
    await store.addRecipient('mod@example.com', 1);
    const doc = await store.get();
    expect(doc.recipients).toEqual([{ address: 'mod@example.com', amountUsd: 1 }]);
    expect(doc.moderators).toEqual([{ address: 'mod@example.com', amountUsd: 3 }]);
    await store.updateModerator('mod@example.com', 4);
    await store.deleteModerator('mod@example.com');
    expect((await store.get()).moderators).toEqual([]);
    expect((await store.get()).recipients).toEqual([{ address: 'mod@example.com', amountUsd: 1 }]);
  });

  it('rejects a blank address, a non-positive amount, and an unknown address', async () => {
    const store = new InMemoryDailyRosterStore();
    await expect(store.addRecipient('   ', 1)).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_INVALID_ADDRESS,
    });
    await expect(store.addRecipient('ada@example.com', 0)).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_INVALID_ADDRESS,
    });
    await expect(store.addRecipient('ada@example.com', Number.NaN)).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_INVALID_ADDRESS,
    });
    await expect(store.updateRecipient('ada@example.com', 1)).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_UNKNOWN_ADDRESS,
    });
    await expect(store.deleteRecipient('ada@example.com')).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_UNKNOWN_ADDRESS,
    });
    await expect(store.updateModerator('ada@example.com', 1)).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_UNKNOWN_ADDRESS,
    });
    await expect(store.deleteModerator('ada@example.com')).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_UNKNOWN_ADDRESS,
    });
  });

  it('imports once, ignores defaultAmountUsd, and leaves a second import unchanged', async () => {
    const store = new InMemoryDailyRosterStore();
    const first = await store.importDocument({
      comment: '  hi\nthere  ',
      paymentsEnabled: false,
      defaultAmountUsd: 9,
      recipients: [{ address: '  Ada@Example.com ', amountUsd: 2 }],
      moderators: [{ address: 'mod@example.com', amountUsd: 3 }],
    });
    expect(first).toEqual({
      comment: 'hi there',
      paymentsEnabled: false,
      moderatorPaymentsEnabled: true,
      defaultAmountUsd: 1,
      recipients: [{ address: 'ada@example.com', amountUsd: 2 }],
      moderators: [{ address: 'mod@example.com', amountUsd: 3 }],
    });
    const second = await store.importDocument({ paymentsEnabled: true, comment: 1 });
    expect(second).toEqual(first);
  });

  it('treats missing import lists as empty and refuses a bad first import', async () => {
    const store = new InMemoryDailyRosterStore();
    expect(await store.importDocument({})).toEqual(EMPTY);
    const other = new InMemoryDailyRosterStore();
    await expect(other.importDocument(null)).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_INVALID_COMMENT,
    });
    await expect(other.importDocument([])).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_INVALID_COMMENT,
    });
    await expect(other.importDocument({ comment: 1 })).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_INVALID_COMMENT,
    });
    await expect(other.importDocument({ paymentsEnabled: 'on' })).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_INVALID_PAYMENTS,
    });
    await expect(other.importDocument({ moderatorPaymentsEnabled: 1 })).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_INVALID_PAYMENTS,
    });
    await expect(other.importDocument({ recipients: 'x' })).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_INVALID_ADDRESS,
    });
    await expect(other.importDocument({ recipients: [null] })).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_INVALID_ADDRESS,
    });
    await expect(other.importDocument({ recipients: [{ amountUsd: 1 }] })).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_INVALID_ADDRESS,
    });
    await expect(
      other.importDocument({ recipients: [{ address: 'ada@example.com', amountUsd: '1' }] }),
    ).rejects.toMatchObject({ status: 400, error: DAILY_ROSTER_INVALID_ADDRESS });
    await expect(
      other.importDocument({
        recipients: [
          { address: 'ada@example.com', amountUsd: 1 },
          { address: 'ADA@example.com', amountUsd: 2 },
        ],
      }),
    ).rejects.toMatchObject({ status: 400, error: DAILY_ROSTER_ADDRESS_LISTED });
    expect(await other.get()).toEqual(EMPTY);
  });
});

describe('PostgresDailyRosterStore', () => {
  it('returns empty defaults when no settings row exists', async () => {
    const sql = new MockSql();
    sql.queryResults = [[]];
    expect(await new PostgresDailyRosterStore(sql).get()).toEqual(EMPTY);
    expect(sql.queries[0]?.text).toMatch(/FROM daily_roster WHERE singleton = true/);
  });

  it('maps settings and both buckets in id order', async () => {
    const sql = new MockSql();
    sql.queryResults = [
      [{ comment: 'thanks', payments_enabled: false, moderator_payments_enabled: false }],
      [
        { address: 'ada@example.com', amount_usd: '2', bucket: 'daily' },
        { address: 'mod@example.com', amount_usd: 3, bucket: 'moderator' },
      ],
    ];
    expect(await new PostgresDailyRosterStore(sql).get()).toEqual({
      comment: 'thanks',
      paymentsEnabled: false,
      moderatorPaymentsEnabled: false,
      defaultAmountUsd: 1,
      recipients: [{ address: 'ada@example.com', amountUsd: 2 }],
      moderators: [{ address: 'mod@example.com', amountUsd: 3 }],
    });
  });

  it('writes comment and both switches after ensuring the settings row', async () => {
    const sql = new MockSql();
    const store = new PostgresDailyRosterStore(sql);
    sql.queryResults = [
      [{ comment: 'hi', payments_enabled: true, moderator_payments_enabled: true }],
      [],
      [{ comment: 'hi', payments_enabled: false, moderator_payments_enabled: true }],
      [],
      [{ comment: 'hi', payments_enabled: false, moderator_payments_enabled: false }],
      [],
    ];
    await store.setComment('hi');
    await store.setPaymentsEnabled(false);
    await store.setModeratorPaymentsEnabled(false);
    expect(sql.executes).toHaveLength(3);
    expect(sql.executes[0]?.text).toMatch(/ON CONFLICT \(singleton\) DO UPDATE SET comment/);
    expect(sql.executes[0]?.params).toEqual(['hi']);
    expect(sql.executes[1]?.text).toMatch(/DO UPDATE SET payments_enabled/);
    expect(sql.executes[1]?.params).toEqual([false]);
    expect(sql.executes[2]?.text).toMatch(/SET moderator_payments_enabled/);
    expect(sql.executes[2]?.params).toEqual([false]);
  });

  it('inserts a recipient and maps unique violation to Address already listed', async () => {
    const sql = new MockSql();
    const store = new PostgresDailyRosterStore(sql);
    sql.queryResults = [
      [{ comment: '', payments_enabled: true, moderator_payments_enabled: true }],
      [],
    ];
    await store.addRecipient('Ada@Example.com', 2);
    expect(sql.executes).toHaveLength(1);
    expect(sql.executes[0]?.text).toMatch(/INSERT INTO daily_roster /);
    expect(sql.executes[0]?.text).toMatch(/INSERT INTO daily_roster_entry/);
    expect(sql.executes[0]?.params).toEqual(['ada@example.com', 2, 'daily']);
    const inner = sql.execute.bind(sql);
    sql.execute = async (text, params) => {
      if (text.includes('INSERT INTO daily_roster_entry')) {
        throw uniqueError();
      }
      return inner(text, params);
    };
    await expect(store.addRecipient('ada@example.com', 2)).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_ADDRESS_LISTED,
    });
    sql.execute = async (text, params) => {
      if (text.includes('INSERT INTO daily_roster_entry')) {
        throw new Error('disk');
      }
      return inner(text, params);
    };
    await expect(store.addModerator('mod@example.com', 3)).rejects.toThrow('disk');
  });

  it('updates and deletes by normalized address or throws Unknown address', async () => {
    const sql = new MockSql();
    const store = new PostgresDailyRosterStore(sql);
    sql.queryResults = [
      [{ address: 'ada@example.com' }],
      [{ comment: '', payments_enabled: true, moderator_payments_enabled: true }],
      [],
      [],
      [{ address: 'mod@example.com' }],
      [{ comment: '', payments_enabled: true, moderator_payments_enabled: true }],
      [],
      [{ address: 'ada@example.com' }],
      [{ comment: '', payments_enabled: true, moderator_payments_enabled: true }],
      [],
      [],
      [{ address: 'mod@example.com' }],
      [{ comment: '', payments_enabled: true, moderator_payments_enabled: true }],
      [],
    ];
    await store.updateRecipient(' ADA@EXAMPLE.COM ', 5);
    expect(sql.queries[0]?.text).toMatch(/UPDATE daily_roster_entry/);
    expect(sql.queries[0]?.text).toMatch(/INSERT INTO daily_roster /);
    expect(sql.queries[0]?.params).toEqual([5, 'ada@example.com', 'daily']);
    await expect(store.updateRecipient('missing@example.com', 1)).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_UNKNOWN_ADDRESS,
    });
    await store.updateModerator('mod@example.com', 4);
    await store.deleteRecipient('Ada@example.com');
    await expect(store.deleteRecipient('missing@example.com')).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_UNKNOWN_ADDRESS,
    });
    await store.deleteModerator('mod@example.com');
  });

  it('imports when no settings row exists and no-ops when one does', async () => {
    const sql = new MockSql();
    const store = new PostgresDailyRosterStore(sql);
    sql.queryResults = [
      [],
      [{ comment: 'hi', payments_enabled: false, moderator_payments_enabled: true }],
      [
        { address: 'ada@example.com', amount_usd: 2, bucket: 'daily' },
        { address: 'mod@example.com', amount_usd: 3, bucket: 'moderator' },
      ],
      [{ comment: 'hi', payments_enabled: false, moderator_payments_enabled: true }],
      [{ comment: 'hi', payments_enabled: false, moderator_payments_enabled: true }],
      [
        { address: 'ada@example.com', amount_usd: 2, bucket: 'daily' },
        { address: 'mod@example.com', amount_usd: 3, bucket: 'moderator' },
      ],
    ];
    const first = await store.importDocument({
      comment: 'hi',
      paymentsEnabled: false,
      recipients: [{ address: 'ada@example.com', amountUsd: 2 }],
      moderators: [{ address: 'mod@example.com', amountUsd: 3 }],
    });
    expect(first.comment).toBe('hi');
    expect(sql.executes).toHaveLength(1);
    const importSql = sql.executes[0]?.text ?? '';
    expect(importSql).toMatch(/WITH inserted AS/);
    expect(importSql).toMatch(/INSERT INTO daily_roster /);
    expect(importSql).toMatch(/INSERT INTO daily_roster_entry/);
    expect(importSql).toMatch(/unnest/);
    expect(importSql).toContain('AS imported(addr, amt, bucket)');
    expect(importSql).not.toContain('AS row(');
    expect(sql.executes[0]?.params).toEqual([
      'hi',
      false,
      true,
      '{"ada@example.com","mod@example.com"}',
      '{"2","3"}',
      '{"daily","moderator"}',
    ]);
    const second = await store.importDocument({ comment: 1 });
    expect(second.comment).toBe('hi');
    expect(sql.executes).toHaveLength(1);
  });

  it('imports empty lists in one CTE execute', async () => {
    const sql = new MockSql();
    const store = new PostgresDailyRosterStore(sql);
    sql.queryResults = [
      [],
      [{ comment: '', payments_enabled: true, moderator_payments_enabled: true }],
      [],
    ];
    expect(await store.importDocument({})).toEqual(EMPTY);
    expect(sql.executes).toHaveLength(1);
    const importSql = sql.executes[0]?.text ?? '';
    expect(importSql).toMatch(/WITH inserted AS/);
    expect(importSql).toMatch(/INSERT INTO daily_roster /);
    expect(importSql).toMatch(/INSERT INTO daily_roster_entry/);
    expect(importSql).toMatch(/unnest/);
    expect(importSql).toContain('AS imported(addr, amt, bucket)');
    expect(importSql).not.toContain('AS row(');
    expect(sql.executes[0]?.params).toEqual(['', true, true, '{}', '{}', '{}']);
  });

  it('returns the stored document when a concurrent import hits unique', async () => {
    const sql = new MockSql();
    const store = new PostgresDailyRosterStore(sql);
    sql.queryResults = [
      [],
      [{ comment: '', payments_enabled: true, moderator_payments_enabled: true }],
      [],
    ];
    let inserts = 0;
    const inner = sql.execute.bind(sql);
    sql.execute = async (text, params) => {
      if (text.includes('INSERT INTO daily_roster ') && inserts === 0) {
        inserts += 1;
        throw uniqueError();
      }
      return inner(text, params);
    };
    const doc = await store.importDocument({ comment: 'ignored' });
    expect(doc).toEqual(EMPTY);
  });

  it('rethrows an import insert error that is not a unique violation', async () => {
    const sql = new MockSql();
    const store = new PostgresDailyRosterStore(sql);
    sql.queryResults = [[]];
    sql.execute = async () => {
      throw new Error('db down');
    };
    await expect(store.importDocument({ comment: 'hi' })).rejects.toThrow('db down');
  });

  it('adds a moderator row on the moderator bucket', async () => {
    const sql = new MockSql();
    sql.queryResults = [
      [{ comment: '', payments_enabled: true, moderator_payments_enabled: true }],
      [{ address: 'mod@example.com', amount_usd: 3, bucket: 'moderator' }],
    ];
    await new PostgresDailyRosterStore(sql).addModerator('mod@example.com', 3);
    expect(sql.executes).toHaveLength(1);
    expect(sql.executes[0]?.text).toMatch(/INSERT INTO daily_roster_entry/);
    expect(sql.executes[0]?.params).toEqual(['mod@example.com', 3, 'moderator']);
  });
});
