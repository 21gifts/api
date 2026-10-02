import { describe, expect, it } from 'vitest';
import { mergeAccounts, type MergeDb } from '@/lib/account-merge';

const FROM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INTO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface RecordedQuery {
  text: string;
  params: readonly unknown[];
}

function fakeDatabase(options: { platform?: boolean; bothGrants?: boolean } = {}): {
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
            return [
              {
                id: FROM,
                is_platform: options.platform === true,
                role: 'verified',
                profile_message_id: null,
              },
              {
                id: INTO,
                is_platform: false,
                role: 'verified',
                profile_message_id: null,
              },
            ] as T[];
          }
          if (text.includes('SELECT account_id FROM funding_grant')) {
            return (options.bothGrants
              ? [{ account_id: FROM }, { account_id: INTO }]
              : []) as T[];
          }
          if (text.includes('count(*)')) {
            return [{ n: 1 }] as T[];
          }
          if (text.includes('pg_constraint') && text.includes('JOIN LATERAL')) {
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
            return [];
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
          query.params[0] === FROM,
      ),
    ).toBe(true);
    expect(queries.some((query) => query.text.includes('DELETE FROM account WHERE id = $1'))).toBe(
      true,
    );
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
        query.text.includes('wallet_required = survivor.wallet_required OR source.wallet_required') &&
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
          query.text.includes("DELETE FROM trust_edge WHERE subject_id = $2 AND kind = 'verify'") &&
          query.params[1] === INTO,
      ),
    ).toBe(true);
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
});
