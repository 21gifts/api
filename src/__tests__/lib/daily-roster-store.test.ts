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
  DAILY_ROSTER_ACCOUNT_LINK_SQL,
  DAILY_ROSTER_DEFAULT_AMOUNT_USD,
  DAILY_ROSTER_SCHEMA_SQL,
  InMemoryDailyRosterStore,
  PostgresDailyRosterStore,
  linkDailyRosterAccounts,
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

const ADA = '11111111-1111-4111-8111-111111111111';
const MOD = '22222222-2222-4222-8222-222222222222';

const SETTINGS = { comment: '', payments_enabled: true, moderator_payments_enabled: true };

describe('DAILY_ROSTER_SCHEMA_SQL', () => {
  it('creates both tables, then keys rows by account', () => {
    expect(DAILY_ROSTER_SCHEMA_SQL).toHaveLength(5);
    expect(DAILY_ROSTER_SCHEMA_SQL[0]).toMatch(/CREATE TABLE IF NOT EXISTS daily_roster/i);
    expect(DAILY_ROSTER_SCHEMA_SQL[0]).toMatch(/singleton boolean PRIMARY KEY/);
    expect(DAILY_ROSTER_SCHEMA_SQL[1]).toMatch(/CREATE TABLE IF NOT EXISTS daily_roster_entry/i);
    expect(DAILY_ROSTER_SCHEMA_SQL[2]).toMatch(
      /ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES account \(id\)/,
    );
    expect(DAILY_ROSTER_SCHEMA_SQL[3]).toMatch(/ALTER COLUMN address DROP NOT NULL/);
    expect(DAILY_ROSTER_SCHEMA_SQL[4]).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS daily_roster_entry_account_bucket_uidx[\s\S]*\(account_id, bucket\)/,
    );
  });
});

describe('migrateDailyRosterSchema', () => {
  it('runs every DAILY_ROSTER_SCHEMA_SQL statement', async () => {
    const sql = new MockSql();
    await migrateDailyRosterSchema(sql);
    expect(sql.executes.map((item) => item.text)).toEqual([...DAILY_ROSTER_SCHEMA_SQL]);
  });
});

describe('linkDailyRosterAccounts', () => {
  it('runs the link as one statement with the lower-cased host and returns its counts', async () => {
    const sql = new MockSql();
    sql.queryResults = [[{ linked: '21', unlinked: 1 }]];
    expect(await linkDailyRosterAccounts(sql, 'Gifts.Example')).toEqual({
      linked: 21,
      unlinked: 1,
    });
    expect(sql.queries).toEqual([
      { text: DAILY_ROSTER_ACCOUNT_LINK_SQL, params: ['gifts.example'] },
    ]);
  });

  it('passes a null host and reads zero counts when the statement returns no row', async () => {
    const sql = new MockSql();
    expect(await linkDailyRosterAccounts(sql, null)).toEqual({ linked: 0, unlinked: 0 });
    expect(sql.queries[0]?.params).toEqual([null]);
  });

  it('links only rows without an account, by legacy address or in-app address, one per bucket', () => {
    expect(DAILY_ROSTER_ACCOUNT_LINK_SQL).toMatch(
      /WHERE e\.account_id IS NULL AND e\.address IS NOT NULL/,
    );
    expect(DAILY_ROSTER_ACCOUNT_LINK_SQL).toMatch(
      /lower\(btrim\(a\.lightning_address\)\) = lower\(btrim\(e\.address\)\)/,
    );
    expect(DAILY_ROSTER_ACCOUNT_LINK_SQL).toMatch(
      /lower\(btrim\(a\.username\)\) \|\| '@' \|\| \$1::text/,
    );
    expect(DAILY_ROSTER_ACCOUNT_LINK_SQL).toMatch(
      /PARTITION BY m\.account_id, m\.bucket ORDER BY m\.id/,
    );
    expect(DAILY_ROSTER_ACCOUNT_LINK_SQL).toMatch(/r\.position = 1/);
    expect(DAILY_ROSTER_ACCOUNT_LINK_SQL).not.toMatch(/DELETE/);
  });
});

describe('InMemoryDailyRosterStore', () => {
  it('reports hasBeenWritten false only before the first write', async () => {
    const fresh = new InMemoryDailyRosterStore();
    expect(await fresh.hasBeenWritten()).toBe(false);
    expect(await new InMemoryDailyRosterStore(EMPTY).hasBeenWritten()).toBe(true);
    await fresh.setComment('');
    expect(await fresh.hasBeenWritten()).toBe(true);
  });

  it('returns the empty defaults and does not share the array', async () => {
    const store = new InMemoryDailyRosterStore();
    const first = await store.get();
    expect(first).toEqual(EMPTY);
    first.recipients.push({ accountId: ADA, amountUsd: 1 });
    expect(await store.get()).toEqual(EMPTY);
  });

  it('copies a seed document and always sets defaultAmountUsd to 1', async () => {
    const seed: DailyRosterDocument = {
      comment: 'thanks',
      paymentsEnabled: false,
      moderatorPaymentsEnabled: false,
      defaultAmountUsd: 9,
      recipients: [{ accountId: ADA, amountUsd: 2 }],
      moderators: [{ accountId: MOD, amountUsd: 3 }],
    };
    const store = new InMemoryDailyRosterStore(seed);
    const loaded = await store.get();
    expect(loaded).toEqual({ ...seed, defaultAmountUsd: 1 });
    expect(loaded.recipients).not.toBe(seed.recipients);
    seed.recipients[0] = { accountId: MOD, amountUsd: 9 };
    expect((await store.get()).recipients[0]?.accountId).toBe(ADA);
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

  it('adds, updates, and deletes daily recipients by account id', async () => {
    const store = new InMemoryDailyRosterStore();
    await store.addRecipient(`  ${ADA}  `, 2);
    expect(await store.get()).toMatchObject({ recipients: [{ accountId: ADA, amountUsd: 2 }] });
    await expect(store.addRecipient(ADA, 3)).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_ADDRESS_LISTED,
    });
    await store.updateRecipient(ADA, 5);
    expect((await store.get()).recipients).toEqual([{ accountId: ADA, amountUsd: 5 }]);
    await store.deleteRecipient(ADA);
    expect((await store.get()).recipients).toEqual([]);
  });

  it('keeps one account in both buckets apart', async () => {
    const store = new InMemoryDailyRosterStore();
    await store.addModerator(MOD, 3);
    await store.addRecipient(MOD, 1);
    const doc = await store.get();
    expect(doc.recipients).toEqual([{ accountId: MOD, amountUsd: 1 }]);
    expect(doc.moderators).toEqual([{ accountId: MOD, amountUsd: 3 }]);
    await store.updateModerator(MOD, 4);
    expect((await store.get()).moderators).toEqual([{ accountId: MOD, amountUsd: 4 }]);
    await store.deleteModerator(MOD);
    expect((await store.get()).moderators).toEqual([]);
    expect((await store.get()).recipients).toEqual([{ accountId: MOD, amountUsd: 1 }]);
  });

  it('rejects a blank account id, a non-positive amount, and an unlisted account', async () => {
    const store = new InMemoryDailyRosterStore();
    for (const bad of ['   ', 7 as unknown as string]) {
      await expect(store.addRecipient(bad, 1)).rejects.toMatchObject({
        status: 400,
        error: DAILY_ROSTER_INVALID_ADDRESS,
      });
    }
    await expect(store.addRecipient(ADA, 0)).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_INVALID_ADDRESS,
    });
    await expect(store.addRecipient(ADA, Number.NaN)).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_INVALID_ADDRESS,
    });
    await expect(store.updateRecipient(ADA, 1)).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_UNKNOWN_ADDRESS,
    });
    await expect(store.deleteRecipient(ADA)).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_UNKNOWN_ADDRESS,
    });
    await expect(store.updateModerator(ADA, 1)).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_UNKNOWN_ADDRESS,
    });
    await expect(store.deleteModerator(ADA)).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_UNKNOWN_ADDRESS,
    });
  });

  it('imports once without accounts: rows stay unlinked and out of the document', async () => {
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
      recipients: [],
      moderators: [],
    });
    expect(await store.importDocument({ paymentsEnabled: true, comment: 1 })).toEqual(first);
    expect(await store.linkReport()).toEqual({
      rows: 2,
      linked: 0,
      unlinked: [
        { bucket: 'daily', address: 'ada@example.com', amountUsd: 2 },
        { bucket: 'moderator', address: 'mod@example.com', amountUsd: 3 },
      ],
      buckets: {
        daily: { rows: 1, linked: 0, totalUsd: 2, linkedUsd: 0 },
        moderator: { rows: 1, linked: 0, totalUsd: 3, linkedUsd: 0 },
      },
    });
  });

  it('reports linked rows and sums per bucket', async () => {
    const store = new InMemoryDailyRosterStore({
      ...EMPTY,
      recipients: [
        { accountId: ADA, amountUsd: 2 },
        { accountId: MOD, amountUsd: 2.5 },
      ],
      moderators: [{ accountId: MOD, amountUsd: 5 }],
    });
    expect(await store.linkReport()).toEqual({
      rows: 3,
      linked: 3,
      unlinked: [],
      buckets: {
        daily: { rows: 2, linked: 2, totalUsd: 4.5, linkedUsd: 4.5 },
        moderator: { rows: 1, linked: 1, totalUsd: 5, linkedUsd: 5 },
      },
    });
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
      other.importDocument({ recipients: [{ address: '  ', amountUsd: 1 }] }),
    ).rejects.toMatchObject({ status: 400, error: DAILY_ROSTER_INVALID_ADDRESS });
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
  it('reports hasBeenWritten false when no settings row exists', async () => {
    const sql = new MockSql();
    sql.queryResults = [[]];
    expect(await new PostgresDailyRosterStore(sql).hasBeenWritten()).toBe(false);
    expect(sql.queries[0]?.text).toMatch(/FROM daily_roster WHERE singleton = true/);
    expect(sql.queries).toHaveLength(1);
  });

  it('reports hasBeenWritten true when a settings row exists', async () => {
    const sql = new MockSql();
    sql.queryResults = [[SETTINGS]];
    expect(await new PostgresDailyRosterStore(sql).hasBeenWritten()).toBe(true);
  });

  it('returns empty defaults when no settings row exists', async () => {
    const sql = new MockSql();
    sql.queryResults = [[]];
    expect(await new PostgresDailyRosterStore(sql).get()).toEqual(EMPTY);
  });

  it('maps settings and the linked rows of both buckets in id order', async () => {
    const sql = new MockSql();
    sql.queryResults = [
      [{ comment: 'thanks', payments_enabled: false, moderator_payments_enabled: false }],
      [
        { account_id: ADA, address: 'ada@example.com', amount_usd: '2', bucket: 'daily' },
        { account_id: null, address: 'gone@example.com', amount_usd: 3, bucket: 'daily' },
        { account_id: MOD, address: null, amount_usd: 3, bucket: 'moderator' },
      ],
    ];
    expect(await new PostgresDailyRosterStore(sql).get()).toEqual({
      comment: 'thanks',
      paymentsEnabled: false,
      moderatorPaymentsEnabled: false,
      defaultAmountUsd: 1,
      recipients: [{ accountId: ADA, amountUsd: 2 }],
      moderators: [{ accountId: MOD, amountUsd: 3 }],
    });
    expect(sql.queries[1]?.text).toMatch(
      /SELECT account_id, address, amount_usd, bucket FROM daily_roster_entry ORDER BY id ASC/,
    );
  });

  it('reports every row, linked or not, with sums per bucket', async () => {
    const sql = new MockSql();
    sql.queryResults = [
      [
        { account_id: ADA, address: 'ada@example.com', amount_usd: '3', bucket: 'daily' },
        { account_id: null, address: 'gone@example.com', amount_usd: 2.5, bucket: 'daily' },
        { account_id: MOD, address: 'mod@example.com', amount_usd: 5, bucket: 'moderator' },
      ],
    ];
    expect(await new PostgresDailyRosterStore(sql).linkReport()).toEqual({
      rows: 3,
      linked: 2,
      unlinked: [{ bucket: 'daily', address: 'gone@example.com', amountUsd: 2.5 }],
      buckets: {
        daily: { rows: 2, linked: 1, totalUsd: 5.5, linkedUsd: 3 },
        moderator: { rows: 1, linked: 1, totalUsd: 5, linkedUsd: 5 },
      },
    });
  });

  it('writes comment and both switches after ensuring the settings row', async () => {
    const sql = new MockSql();
    const store = new PostgresDailyRosterStore(sql);
    sql.queryResults = [[SETTINGS], [], [SETTINGS], [], [SETTINGS], []];
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

  it('inserts an account row and maps unique violation to Address already listed', async () => {
    const sql = new MockSql();
    const store = new PostgresDailyRosterStore(sql);
    sql.queryResults = [[SETTINGS], []];
    await store.addRecipient(` ${ADA} `, 2);
    expect(sql.executes).toHaveLength(1);
    expect(sql.executes[0]?.text).toMatch(/INSERT INTO daily_roster /);
    expect(sql.executes[0]?.text).toMatch(
      /INSERT INTO daily_roster_entry \(account_id, amount_usd, bucket\)/,
    );
    expect(sql.executes[0]?.params).toEqual([ADA, 2, 'daily']);
    const inner = sql.execute.bind(sql);
    sql.execute = async (text, params) => {
      if (text.includes('INSERT INTO daily_roster_entry')) {
        throw uniqueError();
      }
      return inner(text, params);
    };
    await expect(store.addRecipient(ADA, 2)).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_ADDRESS_LISTED,
    });
    sql.execute = async (text, params) => {
      if (text.includes('INSERT INTO daily_roster_entry')) {
        throw new Error('disk');
      }
      return inner(text, params);
    };
    await expect(store.addModerator(MOD, 3)).rejects.toThrow('disk');
  });

  it('adds a moderator row on the moderator bucket', async () => {
    const sql = new MockSql();
    sql.queryResults = [[SETTINGS], []];
    await new PostgresDailyRosterStore(sql).addModerator(MOD, 3);
    expect(sql.executes[0]?.params).toEqual([MOD, 3, 'moderator']);
  });

  it('updates and deletes by account id or throws Unknown address', async () => {
    const sql = new MockSql();
    const store = new PostgresDailyRosterStore(sql);
    sql.queryResults = [
      [{ id: 1 }],
      [SETTINGS],
      [],
      [],
      [{ id: 2 }],
      [SETTINGS],
      [],
      [{ id: 1 }],
      [SETTINGS],
      [],
      [],
      [{ id: 2 }],
      [SETTINGS],
      [],
    ];
    await store.updateRecipient(ADA, 5);
    expect(sql.queries[0]?.text).toMatch(/UPDATE daily_roster_entry SET amount_usd = \$1/);
    expect(sql.queries[0]?.text).toMatch(/WHERE account_id = \$2 AND bucket = \$3/);
    expect(sql.queries[0]?.params).toEqual([5, ADA, 'daily']);
    await expect(store.updateRecipient(MOD, 1)).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_UNKNOWN_ADDRESS,
    });
    await store.updateModerator(MOD, 4);
    expect(sql.queries[4]?.params).toEqual([4, MOD, 'moderator']);
    await store.deleteRecipient(ADA);
    expect(sql.queries[7]?.text).toMatch(/DELETE FROM daily_roster_entry/);
    expect(sql.queries[7]?.params).toEqual([ADA, 'daily']);
    await expect(store.deleteRecipient(MOD)).rejects.toMatchObject({
      status: 400,
      error: DAILY_ROSTER_UNKNOWN_ADDRESS,
    });
    await store.deleteModerator(MOD);
    expect(sql.queries[11]?.params).toEqual([MOD, 'moderator']);
  });

  it('imports address rows, links them with its host, and no-ops when written', async () => {
    const sql = new MockSql();
    const store = new PostgresDailyRosterStore(sql, 'Gifts.Example');
    sql.queryResults = [
      [],
      [{ linked: 1, unlinked: 1 }],
      [{ comment: 'hi', payments_enabled: false, moderator_payments_enabled: true }],
      [
        { account_id: ADA, address: 'ada@example.com', amount_usd: 2, bucket: 'daily' },
        { account_id: null, address: 'mod@example.com', amount_usd: 3, bucket: 'moderator' },
      ],
      [{ comment: 'hi', payments_enabled: false, moderator_payments_enabled: true }],
      [{ comment: 'hi', payments_enabled: false, moderator_payments_enabled: true }],
      [],
    ];
    const first = await store.importDocument({
      comment: 'hi',
      paymentsEnabled: false,
      recipients: [{ address: 'ada@example.com', amountUsd: 2 }],
      moderators: [{ address: 'mod@example.com', amountUsd: 3 }],
    });
    expect(first).toMatchObject({
      comment: 'hi',
      recipients: [{ accountId: ADA, amountUsd: 2 }],
      moderators: [],
    });
    expect(sql.executes).toHaveLength(1);
    const importSql = sql.executes[0]?.text ?? '';
    expect(importSql).toMatch(/WITH inserted AS/);
    expect(importSql).toMatch(/INSERT INTO daily_roster_entry \(address, amount_usd, bucket\)/);
    expect(importSql).toContain('AS imported(addr, amt, bucket)');
    expect(sql.executes[0]?.params).toEqual([
      'hi',
      false,
      true,
      '{"ada@example.com","mod@example.com"}',
      '{"2","3"}',
      '{"daily","moderator"}',
    ]);
    expect(sql.queries[1]).toEqual({
      text: DAILY_ROSTER_ACCOUNT_LINK_SQL,
      params: ['gifts.example'],
    });
    const second = await store.importDocument({ comment: 1 });
    expect(second.comment).toBe('hi');
    expect(sql.executes).toHaveLength(1);
  });

  it('imports empty lists and links with no host by default', async () => {
    const sql = new MockSql();
    const store = new PostgresDailyRosterStore(sql);
    sql.queryResults = [[], [{ linked: 0, unlinked: 0 }], [SETTINGS], []];
    expect(await store.importDocument({})).toEqual(EMPTY);
    expect(sql.executes[0]?.params).toEqual(['', true, true, '{}', '{}', '{}']);
    expect(sql.queries[1]?.params).toEqual([null]);
  });

  it('returns the stored document when a concurrent import hits unique', async () => {
    const sql = new MockSql();
    const store = new PostgresDailyRosterStore(sql);
    sql.queryResults = [[], [SETTINGS], []];
    sql.execute = async () => {
      throw uniqueError();
    };
    expect(await store.importDocument({ comment: 'ignored' })).toEqual(EMPTY);
    expect(sql.queries.some((q) => q.text === DAILY_ROSTER_ACCOUNT_LINK_SQL)).toBe(false);
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
});
