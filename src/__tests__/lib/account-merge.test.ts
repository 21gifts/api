import { describe, expect, it } from 'vitest';
import { mergeAccounts, type MergeDb } from '@/lib/account-merge';

const FROM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INTO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROFILE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

interface RecordedQuery {
  text: string;
  params: readonly unknown[];
}

interface FakeLockRow {
  id: string;
  is_platform: boolean;
  role: string;
  profile_message_id: string | null;
}

interface FakeCatalogColumn {
  schema_name: string;
  table_name: string;
  column_name: string;
}

interface FakeDatabaseOptions {
  platform?: boolean;
  bothGrants?: boolean;
  lock?: readonly FakeLockRow[];
  fromRole?: string;
  intoRole?: string;
  fromProfile?: string | null;
  intoProfile?: string | null;
  intoPlatform?: boolean;
  composite?: readonly { constraint_name: string }[];
  columns?: readonly FakeCatalogColumn[];
  verifyExists?: readonly { exists: boolean }[];
  messageCount?: readonly { n: number }[];
}

function fakeDatabase(options: FakeDatabaseOptions = {}): {
  db: MergeDb;
  queries: RecordedQuery[];
  begins: { n: number };
} {
  const queries: RecordedQuery[] = [];
  const begins = { n: 0 };
  const db: MergeDb = {
    async begin(run) {
      begins.n += 1;
      return run({
        async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
          queries.push({ text, params });
          if (text.includes('FOR UPDATE')) {
            if (options.lock !== undefined) {
              return options.lock as T[];
            }
            return [
              {
                id: FROM,
                is_platform: options.platform === true,
                role: options.fromRole ?? 'verified',
                profile_message_id: options.fromProfile ?? null,
              },
              {
                id: INTO,
                is_platform: options.intoPlatform === true,
                role: options.intoRole ?? 'verified',
                profile_message_id: options.intoProfile ?? null,
              },
            ] as T[];
          }
          if (text.includes('SELECT account_id FROM funding_grant')) {
            return (options.bothGrants ? [{ account_id: FROM }, { account_id: INTO }] : []) as T[];
          }
          if (text.includes('count(*)')) {
            return (options.messageCount ?? [{ n: 1 }]) as T[];
          }
          if (text.includes('pg_constraint') && text.includes('JOIN LATERAL')) {
            if (options.columns !== undefined) {
              return options.columns as T[];
            }
            return [
              { schema_name: 'public', table_name: 'message', column_name: 'account_id' },
              { schema_name: 'public', table_name: 'message', column_name: 'shop_account_id' },
              {
                schema_name: 'public',
                table_name: 'passkey_credential',
                column_name: 'account_id',
              },
              { schema_name: 'public', table_name: 'auth_session', column_name: 'account_id' },
            ] as T[];
          }
          if (text.includes('pg_constraint') && text.includes('array_length')) {
            return (options.composite ?? []) as T[];
          }
          if (text.includes('SELECT true AS exists FROM trust_edge')) {
            return (options.verifyExists ?? []) as T[];
          }
          return [];
        },
      });
    },
  };
  return { db, queries, begins };
}

describe('mergeAccounts', () => {
  it('moves catalog foreign keys after disambiguation and deletes the source account', async () => {
    const { db, queries, begins } = fakeDatabase();

    await expect(mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' })).resolves.toEqual({
      ok: true,
      messages: 1,
    });

    expect(begins.n).toBe(1);
    const contentFingerprint = queries.findIndex((query) => query.text.includes('SET content_fp'));
    const messageAccount = queries.findIndex((query) =>
      query.text.includes('UPDATE "public"."message" SET "account_id"'),
    );
    expect(contentFingerprint).toBeGreaterThanOrEqual(0);
    expect(messageAccount).toBeGreaterThan(contentFingerprint);
    expect(queries.some((query) => query.text.includes('DELETE FROM auth_session'))).toBe(true);
    expect(queries).toContainEqual({
      text: 'UPDATE "public"."passkey_credential" SET "account_id" = $1 WHERE "account_id" = $2',
      params: [INTO, FROM],
    });
    expect(
      queries.some(
        (query) =>
          query.text.includes("DELETE FROM trust_edge WHERE subject_id = $1 AND kind = 'verify'") &&
          query.params.length === 1 &&
          query.params[0] === FROM,
      ),
    ).toBe(true);
    expect(queries.some((query) => query.text.includes('DELETE FROM account WHERE id = $1'))).toBe(
      true,
    );
    expect(
      queries.some(
        (query) => query.text.includes('dst.account_a = LEAST(') && query.text.includes('$2::uuid'),
      ),
    ).toBe(true);
    expect(
      queries.some(
        (query) => query.text.includes('SET account_a = LEAST(') && query.text.includes('$2::uuid'),
      ),
    ).toBe(true);
    expect(queries.some((query) => /THEN \$2(?!::uuid)/.test(query.text))).toBe(false);
  });

  it('copies earlier join time and consent onto the survivor before deleting the source', async () => {
    const { db, queries } = fakeDatabase();

    await expect(mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' })).resolves.toEqual({
      ok: true,
      messages: 1,
    });

    const history = queries.findIndex(
      (query) =>
        query.text.includes('LEAST(survivor.created_at, source.created_at)') &&
        query.text.includes(
          'wallet_required = survivor.wallet_required OR source.wallet_required',
        ) &&
        query.text.includes('survivor.id = $2'),
    );
    const deleted = queries.findIndex((query) =>
      query.text.includes('DELETE FROM account WHERE id = $1'),
    );
    expect(history).toBeGreaterThanOrEqual(0);
    expect(deleted).toBeGreaterThan(history);
    expect(queries[history]?.params).toEqual([FROM, INTO]);
    expect(queries[history]?.text).not.toContain('SET name');
    expect(queries[history]?.text).not.toContain('username =');
    expect(queries[history]?.text).not.toContain('location =');
    expect(queries[history]?.text).not.toContain('lightning_address =');
  });

  it('keeps the source verify edge when requested', async () => {
    const { db, queries } = fakeDatabase();

    await mergeAccounts(db, { from: FROM, into: INTO, verify: 'from' });

    expect(
      queries.some(
        (query) =>
          query.text.includes("DELETE FROM trust_edge WHERE subject_id = $1 AND kind = 'verify'") &&
          query.params.length === 1 &&
          query.params[0] === INTO,
      ),
    ).toBe(true);
    expect(
      queries.some((query) => query.text.includes('$2') && !query.text.includes('$1')),
    ).toBe(false);
  });

  it('returns same_account without opening a transaction', async () => {
    const { db, begins } = fakeDatabase();

    await expect(mergeAccounts(db, { from: FROM, into: FROM, verify: 'into' })).resolves.toEqual({
      ok: false,
      error: 'same_account',
    });
    expect(begins.n).toBe(0);
  });

  it('refuses a platform account before any delete', async () => {
    const { db, queries } = fakeDatabase({ platform: true });

    await expect(mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' })).resolves.toEqual({
      ok: false,
      error: 'platform',
    });
    expect(queries.some((query) => query.text.includes('DELETE FROM account'))).toBe(false);
  });

  it('refuses two funding grants before any delete', async () => {
    const { db, queries } = fakeDatabase({ bothGrants: true });

    await expect(mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' })).resolves.toEqual({
      ok: false,
      error: 'both_grants',
    });
    expect(queries.some((query) => query.text.includes('DELETE FROM account'))).toBe(false);
  });

  it('rejects a composite account foreign key before deleting the source', async () => {
    const { db, queries } = fakeDatabase({ composite: [{ constraint_name: 'account_pair_fk' }] });

    let thrown: unknown;
    try {
      await mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof Error ? thrown.message : undefined).toBe(
      'composite account foreign key',
    );
    expect(queries.some((query) => query.text.includes('DELETE FROM account WHERE'))).toBe(false);
  });

  it('rejects a catalog identifier that fails the public allowlist', async () => {
    const { db } = fakeDatabase({
      columns: [{ schema_name: 'public', table_name: 'Message', column_name: 'account_id' }],
    });

    let thrown: unknown;
    try {
      await mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof Error ? thrown.message : undefined).toBe(
      'invalid account foreign key identifier',
    );
  });

  it('promotes a basis survivor that already has a verify edge', async () => {
    const { db, queries } = fakeDatabase({ intoRole: 'basis', verifyExists: [{ exists: true }] });

    await expect(mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' })).resolves.toEqual({
      ok: true,
      messages: 1,
    });
    expect(queries).toContainEqual({
      text: "UPDATE account SET role = 'verified' WHERE id = $1 AND role = 'basis'",
      params: [INTO],
    });
  });

  it('leaves a basis survivor without a verify edge on the basis role', async () => {
    const { db, queries } = fakeDatabase({ intoRole: 'basis', verifyExists: [] });

    await expect(mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' })).resolves.toEqual({
      ok: true,
      messages: 1,
    });
    expect(queries).not.toContainEqual({
      text: "UPDATE account SET role = 'verified' WHERE id = $1 AND role = 'basis'",
      params: [INTO],
    });
  });

  it('copies the source profile pointer onto a survivor that has none', async () => {
    const { db, queries } = fakeDatabase({ fromProfile: PROFILE });

    await expect(mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' })).resolves.toEqual({
      ok: true,
      messages: 1,
    });
    const copied = queries.findIndex(
      (query) =>
        query.text === 'UPDATE account SET profile_message_id = $1 WHERE id = $2' &&
        query.params[0] === PROFILE &&
        query.params[1] === INTO,
    );
    const cleared = queries.findIndex((query) =>
      query.text.includes('SET profile_message_id = NULL'),
    );
    const deleted = queries.findIndex((query) => query.text.includes('DELETE FROM account WHERE'));
    expect(copied).toBeGreaterThan(cleared);
    expect(copied).toBeLessThan(deleted);
    expect(queries[copied]?.params).toEqual([PROFILE, INTO]);
  });

  it('refuses a platform survivor before any delete', async () => {
    const { db, queries } = fakeDatabase({ intoPlatform: true });

    await expect(mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' })).resolves.toEqual({
      ok: false,
      error: 'platform',
    });
    expect(queries.some((query) => query.text.includes('DELETE FROM account'))).toBe(false);
  });

  it('returns zero messages when the count query yields no row', async () => {
    const { db } = fakeDatabase({ messageCount: [] });

    await expect(mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' })).resolves.toEqual({
      ok: true,
      messages: 0,
    });
  });

  it('returns not_found when the lock query misses one account', async () => {
    const { db, queries, begins } = fakeDatabase({
      lock: [
        {
          id: FROM,
          is_platform: false,
          role: 'verified',
          profile_message_id: null,
        },
      ],
    });

    await expect(mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' })).resolves.toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(begins.n).toBe(1);
    expect(queries.some((query) => query.text.includes('DELETE FROM account'))).toBe(false);
  });

  it('returns not_found when the lock set is size 2 but from is missing', async () => {
    const { db, queries, begins } = fakeDatabase({
      lock: [
        {
          id: INTO,
          is_platform: false,
          role: 'verified',
          profile_message_id: null,
        },
        {
          id: OTHER,
          is_platform: false,
          role: 'verified',
          profile_message_id: null,
        },
      ],
    });

    await expect(mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' })).resolves.toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(begins.n).toBe(1);
    expect(queries.some((query) => query.text.includes('DELETE FROM account WHERE'))).toBe(false);
  });

  it('returns not_found when the lock set is size 2 but into is missing', async () => {
    const { db, queries, begins } = fakeDatabase({
      lock: [
        {
          id: FROM,
          is_platform: false,
          role: 'verified',
          profile_message_id: null,
        },
        {
          id: OTHER,
          is_platform: false,
          role: 'verified',
          profile_message_id: null,
        },
      ],
    });

    await expect(mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' })).resolves.toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(begins.n).toBe(1);
    expect(queries.some((query) => query.text.includes('DELETE FROM account WHERE'))).toBe(false);
  });

  it('does not copy a source profile onto a survivor that already has one', async () => {
    const { db, queries } = fakeDatabase({ intoProfile: OTHER });

    await expect(mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' })).resolves.toEqual({
      ok: true,
      messages: 1,
    });
    expect(
      queries.some(
        (query) => query.text === 'UPDATE account SET profile_message_id = $1 WHERE id = $2',
      ),
    ).toBe(false);
    expect(queries.some((query) => query.text.includes('SET profile_message_id = NULL'))).toBe(
      true,
    );
  });
});
