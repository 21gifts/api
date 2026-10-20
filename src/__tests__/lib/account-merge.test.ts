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

interface FakeShopRow {
  id: string;
  account_id: string;
  status: 'open' | 'accepted' | 'paid' | 'ended';
  closed_at: string | null;
}

interface FakeDatabaseOptions {
  platform?: boolean;
  bothGrants?: boolean;
  shopPayments?: readonly { id: string }[];
  /** Stateful `shop_payment` rows: the open check filters them and the column move updates them. */
  shopRows?: FakeShopRow[];
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
  /** Rows of the lock on the merged account's pending charge (deleted when the survivor has one). */
  pendingCharges?: readonly { id: string }[];
  /** Rows of the survivor's open shop payment beside the merged account's pending charge. */
  openBesideCharge?: readonly { id: string }[];
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
          if (text.includes('FROM pos_charge') && text.includes('FOR UPDATE')) {
            return (options.pendingCharges ?? []) as T[];
          }
          if (text.includes("p.status = 'open'")) {
            return (options.openBesideCharge ?? []) as T[];
          }
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
          if (text.includes('FROM shop_payment')) {
            if (options.shopRows !== undefined) {
              return options.shopRows
                .filter(
                  (row) =>
                    row.account_id === params[0] && row.status !== 'paid' && row.closed_at === null,
                )
                .slice(0, 1)
                .map((row) => ({ id: row.id })) as T[];
            }
            return (options.shopPayments ?? []) as T[];
          }
          if (
            options.shopRows !== undefined &&
            text === 'UPDATE "public"."shop_payment" SET "account_id" = $1 WHERE "account_id" = $2'
          ) {
            for (const row of options.shopRows) {
              if (row.account_id === params[1]) {
                row.account_id = String(params[0]);
              }
            }
            return [];
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
    const walletCollision = queries.findIndex((query) =>
      query.text.includes('DELETE FROM wallet_payment AS src'),
    );
    const posCollision = queries.findIndex(
      (query) => query.text.includes('FROM pos_charge') && query.text.includes('FOR UPDATE'),
    );
    const catalog = queries.findIndex(
      (query) => query.text.includes('pg_constraint') && query.text.includes('JOIN LATERAL'),
    );
    expect(walletCollision).toBeGreaterThanOrEqual(0);
    expect(posCollision).toBeGreaterThanOrEqual(0);
    expect(walletCollision).toBeGreaterThan(posCollision);
    expect(walletCollision).toBeLessThan(catalog);
    expect(queries[walletCollision]?.params).toEqual([FROM, INTO]);
    expect(queries[walletCollision]?.text).toContain('dst.payment_id = src.payment_id');
    const walletSelfCounterparty = queries.findIndex((query) =>
      query.text.includes('SET counterparty_account_id = NULL'),
    );
    expect(walletSelfCounterparty).toBeGreaterThan(walletCollision);
    expect(walletSelfCounterparty).toBeLessThan(catalog);
    expect(queries[walletSelfCounterparty]?.params).toEqual([FROM, INTO]);
    expect(queries[walletSelfCounterparty]?.text).toContain('counterparty_account_id IN ($1, $2)');
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

  it('clears the source free first post mark before moving messages when the survivor has one', async () => {
    const { db, queries } = fakeDatabase();

    await mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' });

    const firstPostFree = queries.findIndex((query) =>
      query.text.includes('SET first_post_free = NULL'),
    );
    const messageAccount = queries.findIndex((query) =>
      query.text.includes('UPDATE "public"."message" SET "account_id"'),
    );
    expect(firstPostFree).toBeGreaterThanOrEqual(0);
    expect(queries[firstPostFree]?.params).toEqual([FROM, INTO]);
    expect(queries[firstPostFree]?.text).toContain('dst.account_id = $2');
    expect(queries[firstPostFree]?.text).toContain('dst.first_post_free IS TRUE');
    expect(messageAccount).toBeGreaterThan(firstPostFree);
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
    expect(queries[history]?.text).toContain(
      'wallet_intro_seen = survivor.wallet_intro_seen OR source.wallet_intro_seen',
    );
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
    expect(queries.some((query) => query.text.includes('$2') && !query.text.includes('$1'))).toBe(
      false,
    );
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

  it('refuses while the merged account has a shop payment that is neither paid nor closed', async () => {
    const { db, queries } = fakeDatabase({ shopPayments: [{ id: 'sp-open' }] });
    await expect(mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' })).resolves.toEqual({
      ok: false,
      error: 'shop_payment_open',
    });
    const check = queries.find((query) => query.text.includes('FROM shop_payment'));
    expect(check?.params).toEqual([FROM]);
    expect(check?.text).toContain("status <> 'paid' AND closed_at IS NULL");
    expect(queries.at(-1)).toBe(check);
    expect(queries.some((query) => /^\s*(UPDATE|DELETE|INSERT)\b/.test(query.text))).toBe(false);
  });

  it('moves paid or closed shop payments with the account', async () => {
    const shopRows: FakeShopRow[] = [
      { id: 'sp-paid', account_id: FROM, status: 'paid', closed_at: null },
      { id: 'sp-closed', account_id: FROM, status: 'ended', closed_at: '2026-10-17T10:00:00Z' },
      {
        id: 'sp-accepted-closed',
        account_id: FROM,
        status: 'accepted',
        closed_at: '2026-10-17T10:00:00Z',
      },
      { id: 'sp-into', account_id: INTO, status: 'open', closed_at: null },
    ];
    const { db, queries } = fakeDatabase({
      shopRows,
      columns: [
        { schema_name: 'public', table_name: 'message', column_name: 'account_id' },
        { schema_name: 'public', table_name: 'shop_payment', column_name: 'account_id' },
      ],
    });
    await expect(mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' })).resolves.toEqual({
      ok: true,
      messages: 1,
    });
    // The open check passes on paid or closed rows, and the column move takes them along.
    expect(shopRows.map((row) => [row.id, row.account_id])).toEqual([
      ['sp-paid', INTO],
      ['sp-closed', INTO],
      ['sp-accepted-closed', INTO],
      ['sp-into', INTO],
    ]);
    const move = queries.find(
      (query) =>
        query.text ===
        'UPDATE "public"."shop_payment" SET "account_id" = $1 WHERE "account_id" = $2',
    );
    expect(move?.params).toEqual([INTO, FROM]);
    const check = queries.findIndex((query) => query.text.includes('FROM shop_payment'));
    const grants = queries.findIndex((query) =>
      query.text.includes('SELECT account_id FROM funding_grant'),
    );
    expect(check).toBeGreaterThan(grants);
    expect(queries.findIndex((query) => query.text.includes('count(*)'))).toBeGreaterThan(check);
  });

  it('refuses while the merged account has a pending charge and the survivor an open shop payment', async () => {
    const { db, queries } = fakeDatabase({ openBesideCharge: [{ id: 'sp-into-open' }] });
    await expect(mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' })).resolves.toEqual({
      ok: false,
      error: 'shop_payment_open',
    });
    const check = queries.at(-1);
    expect(check?.params).toEqual([FROM, INTO]);
    const flat = (check?.text ?? '').replace(/\s+/g, ' ').trim();
    expect(flat).toBe(
      "SELECT p.id FROM shop_payment AS p WHERE p.account_id = $2 AND p.status = 'open' AND EXISTS ( SELECT 1 FROM pos_charge AS c WHERE c.account_id = $1 AND c.status = 'pending' AND c.expires_at > now() ) LIMIT 1",
    );
    // Checked under both account locks, after the merged account's own check, before any write.
    expect(queries[0]?.text).toContain('FROM account');
    expect(queries.filter((query) => query.text.includes('FROM shop_payment'))).toHaveLength(2);
    expect(queries.some((query) => /^\s*(UPDATE|DELETE|INSERT)\b/.test(query.text))).toBe(false);
  });

  it('locks the deleted pending charge, then deletes its invoice rows and the charge by those ids', async () => {
    const { db, queries } = fakeDatabase({
      pendingCharges: [{ id: 'c-from-1' }, { id: 'c-from-2' }],
    });
    await mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' });
    const lock = queries.findIndex(
      (query) => query.text.includes('FROM pos_charge') && query.text.includes('FOR UPDATE'),
    );
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(queries[lock]?.params).toEqual([FROM, INTO]);
    // Only the merged account's pending charge, and only while the kept account has one.
    expect((queries[lock]?.text ?? '').replace(/\s+/g, ' ').trim()).toBe(
      "SELECT id FROM pos_charge WHERE account_id = $1 AND status = 'pending' AND EXISTS ( SELECT 1 FROM pos_charge WHERE account_id = $2 AND status = 'pending' ) ORDER BY id FOR UPDATE",
    );
    expect(queries[lock + 1]).toEqual({
      text: 'DELETE FROM pos_charge_invoice WHERE charge_id = ANY($1::uuid[])',
      params: ['{"c-from-1","c-from-2"}'],
    });
    expect(queries[lock + 2]).toEqual({
      text: 'DELETE FROM pos_charge WHERE id = ANY($1::uuid[])',
      params: ['{"c-from-1","c-from-2"}'],
    });
  });

  it('deletes no charge when the lock finds no pending charge to drop', async () => {
    const { db, queries } = fakeDatabase();
    await mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' });
    expect(
      queries.some(
        (query) => query.text.includes('FROM pos_charge') && query.text.includes('FOR UPDATE'),
      ),
    ).toBe(true);
    expect(queries.some((query) => query.text.includes('DELETE FROM pos_charge'))).toBe(false);
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
