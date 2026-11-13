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
  /** Rows still pending after due charges are marked expired (deleted when the survivor still has one). */
  pendingCharges?: readonly { id: string }[];
  /** Rows of the survivor's open shop payment beside the merged account's pending charge. */
  openBesideCharge?: readonly { id: string }[];
  /** Legacy full-share repayments read before the first merge write. */
  legacyRepayments?: readonly {
    message_id: string;
    day_index: number;
    recipient_account_id: string;
    due_sats: number;
    paid_at: Date;
    goal_currency: string | null;
    goal_amount: string | null;
    goal_term_days: number | null;
    goal_debt_frozen?: boolean;
  }[];
  /** Original credit payers used to reconstruct each legacy share. */
  repaymentPayers?: readonly {
    account_id: string;
    sats: number;
    usd: string | null;
    chf: string | null;
    eur: string | null;
    php: string | null;
    debt_frozen?: boolean;
    goal_currency?: string | null;
    snapshot_currency?: string | null;
    snapshot_units?: string | number | null;
  }[];
  /** Anonymous sats returned when legacy debt reconstruction asks for them. */
  unassignedRepaymentSats?: number;
  /** Repayable credits where both identities gave and some repayment settled. */
  repaymentConflicts?: readonly { message_id: string }[];
  /** Successful repayment invoice candidates on affected source-funded credits. */
  openRepaymentInvoices?: readonly {
    message_id: string;
    author_account_id: string;
    amount_sats: number;
    payment_hash: string | null;
    description: string;
    created_at: Date;
    pr: string;
    payment_claimed: boolean;
  }[];
  /** Result of the shared exact claim-only lookup for an affected invoice. */
  claimOnlyRepayment?: boolean;
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
          if (
            text.includes('SELECT legacy.message_id') &&
            text.includes('FROM message_repayment AS legacy')
          ) {
            return (options.legacyRepayments ?? []) as T[];
          }
          if (text.includes('WITH payers AS') && text.includes('message_credit_payer_snapshot')) {
            return (options.repaymentPayers ?? []) as T[];
          }
          if (text.includes('payer_account_id IS NULL') && text.includes('SUM(r.sats)')) {
            return [{ sats: options.unassignedRepaymentSats ?? 0 }] as T[];
          }
          if (text.includes('FROM message AS credit') && text.includes('source_gift')) {
            return (options.repaymentConflicts ?? []) as T[];
          }
          if (text.includes('FROM message_invoice AS invoice')) {
            return (options.openRepaymentInvoices ?? []) as T[];
          }
          if (text.includes('AS claim_only') && text.includes('nostr_zap_payment AS claim')) {
            return [{ claim_only: options.claimOnlyRepayment === true }] as T[];
          }
          if (text.includes('FROM pos_charge') && text.includes('FOR UPDATE')) {
            return [];
          }
          if (text.startsWith('SELECT id FROM pos_charge') && text.includes("status = 'pending'")) {
            return (options.pendingCharges ?? []) as T[];
          }
          if (text.includes('FROM shop_payment') && text.includes('FOR UPDATE')) {
            return [];
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

/** Index of the lock on all of the merged account's charge rows. */
function chargeLockIndex(queries: readonly RecordedQuery[]): number {
  return queries.findIndex(
    (query) => query.text.includes('FROM pos_charge') && query.text.includes('FOR UPDATE'),
  );
}

/** Index of the read of the merged account's pending charges to delete. */
function doomedReadIndex(queries: readonly RecordedQuery[]): number {
  return queries.findIndex(
    (query) =>
      query.text.startsWith('SELECT id FROM pos_charge') &&
      query.text.includes("status = 'pending'"),
  );
}

describe('mergeAccounts', () => {
  it('combines frozen snapshots and reindexes canonical repayment parts without loss', async () => {
    const { db, queries } = fakeDatabase();
    await mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' });

    const snapshot = queries.findIndex((query) =>
      query.text.includes('INSERT INTO message_credit_payer_snapshot'),
    );
    const parts = queries.findIndex(
      (query) =>
        query.text.includes('UPDATE message_repayment_part AS part') &&
        query.text.includes('row_number() OVER'),
    );
    const normalized = queries.findIndex(
      (query) =>
        query.text.includes('UPDATE message_repayment_part') &&
        query.text.includes('SET part_index = -part_index - 1'),
    );
    const accountDelete = queries.findIndex((query) =>
      query.text.includes('DELETE FROM account WHERE id = $1'),
    );
    const messageLocks = queries.findIndex((query) => query.text.includes('pg_advisory_xact_lock'));
    const accountLocks = queries.findIndex(
      (query) => query.text.includes('FROM account') && query.text.includes('FOR UPDATE'),
    );
    const repaymentRowLocks = queries.findIndex(
      (query) =>
        query.text.includes('FROM message_repayment AS legacy') &&
        query.text.includes('FOR UPDATE OF legacy, message'),
    );

    expect(messageLocks).toBe(0);
    expect(queries[messageLocks]?.text).toContain('ORDER BY affected.message_id');
    expect(accountLocks).toBeGreaterThan(messageLocks);
    expect(repaymentRowLocks).toBeGreaterThan(accountLocks);
    expect(snapshot).toBeGreaterThanOrEqual(0);
    expect(queries[snapshot]?.text).toContain('SUM(units)::bigint');
    expect(queries[snapshot]?.text).toContain('ON CONFLICT (message_id, account_id) DO UPDATE');
    expect(parts).toBeGreaterThan(snapshot);
    expect(queries[parts]?.text).toContain('SET recipient_account_id = $2');
    expect(normalized).toBeGreaterThan(parts);
    expect(normalized).toBeLessThan(accountDelete);
    expect(queries[normalized]?.text).toContain('recipient_account_id = $1::uuid');
    expect(queries[normalized]?.params).toEqual([INTO]);
  });

  it('locks invoice and receipt messages for either identity before account rows', async () => {
    const { db, queries } = fakeDatabase();

    await mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' });

    const messageLocks = queries.findIndex((query) => query.text.includes('pg_advisory_xact_lock'));
    const accountLocks = queries.findIndex(
      (query) => query.text.includes('FROM account') && query.text.includes('FOR UPDATE'),
    );
    expect(queries[messageLocks]?.text).toContain('SELECT id AS message_id FROM message');
    expect(queries[messageLocks]?.text).toContain('account_id = $1::uuid OR account_id = $2::uuid');
    expect(queries[messageLocks]?.text).toContain('SELECT message_id FROM message_invoice');
    expect(queries[messageLocks]?.text).toContain('payer_account_id = $1::uuid');
    expect(queries[messageLocks]?.text).toContain('author_account_id = $2::uuid');
    expect(queries[messageLocks]?.text).toContain('SELECT message_id FROM nostr_zap_receipt');
    expect(queries[messageLocks]?.text).toContain(
      'payer_account_id = $1::uuid OR payer_account_id = $2::uuid',
    );
    expect(queries[messageLocks]?.text).not.toContain('UNION ALL');
    expect(queries[messageLocks]?.text.match(/ORDER BY affected\.message_id/g)).toHaveLength(1);
    expect(messageLocks).toBeLessThan(accountLocks);
  });

  it('uses oldest ingests to convert a legacy fiat share before merging', async () => {
    const messageId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const paidAt = new Date('2026-11-11T12:00:00.000Z');
    const { db, queries } = fakeDatabase({
      legacyRepayments: [
        {
          message_id: messageId,
          day_index: 0,
          recipient_account_id: FROM,
          due_sats: 5000,
          paid_at: paidAt,
          goal_currency: 'USD',
          goal_amount: '2.00',
          goal_term_days: 1,
        },
      ],
      repaymentPayers: [
        { account_id: FROM, sats: 50, usd: '1.00', chf: null, eur: null, php: null },
        { account_id: INTO, sats: 50, usd: '1.00', chf: null, eur: null, php: null },
      ],
    });

    await expect(mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' })).resolves.toEqual({
      ok: true,
      messages: 1,
    });
    const converted = queries.find(
      (query) =>
        query.text.includes('INSERT INTO message_repayment_part') &&
        query.text.includes('COALESCE(MAX(part_index) + 1, 0)'),
    );
    const deleted = queries.find(
      (query) =>
        query.text.includes('DELETE FROM message_repayment') && query.params[0] === messageId,
    );
    const identityMove = queries.findIndex((query) =>
      query.text.includes('UPDATE message_repayment_part AS part'),
    );
    const canonicalPayers = queries.find((query) => query.text.includes('nostr_zap_ingest'));

    expect(converted?.params).toEqual([messageId, 0, FROM, '100', 5000, paidAt]);
    expect(converted?.text).toContain('SELECT $1::uuid, $2::integer, $3::uuid');
    expect(converted?.text).toContain('$4::bigint, $5::bigint, $6::timestamptz');
    expect(canonicalPayers?.text).toContain('ORDER BY created_at ASC, id ASC');
    expect(canonicalPayers?.text).not.toContain('ORDER BY created_at DESC');
    expect(canonicalPayers?.params).toEqual([messageId, true, false, null, false]);
    expect(deleted?.params).toEqual([messageId, 0, FROM]);
    expect(queries.indexOf(converted as RecordedQuery)).toBeLessThan(identityMove);
  });

  it('reconstructs frozen fiat legacy debt from named snapshots without anonymous sats', async () => {
    const messageId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const paidAt = new Date('2026-11-11T12:00:00.000Z');
    const { db, queries } = fakeDatabase({
      legacyRepayments: [
        {
          message_id: messageId,
          day_index: 0,
          recipient_account_id: FROM,
          due_sats: 4000,
          paid_at: paidAt,
          goal_currency: 'USD',
          goal_amount: '9.99',
          goal_term_days: 1,
          goal_debt_frozen: true,
        },
      ],
      repaymentPayers: [
        {
          account_id: FROM,
          sats: 40,
          usd: null,
          chf: null,
          eur: null,
          php: null,
          debt_frozen: true,
          goal_currency: 'USD',
          snapshot_currency: 'USD',
          snapshot_units: 40,
        },
      ],
      unassignedRepaymentSats: 60,
    });

    await expect(mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' })).resolves.toEqual({
      ok: true,
      messages: 1,
    });
    const converted = queries.find(
      (query) =>
        query.text.includes('INSERT INTO message_repayment_part') && query.params[0] === messageId,
    );
    expect(converted?.params).toEqual([messageId, 0, FROM, '40', 4000, paidAt]);
    expect(queries.some((query) => query.text.includes('payer_account_id IS NULL'))).toBe(false);
  });

  it('refuses a merge without writes when legacy loan units cannot be reconstructed', async () => {
    const messageId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const { db, queries } = fakeDatabase({
      legacyRepayments: [
        {
          message_id: messageId,
          day_index: 0,
          recipient_account_id: FROM,
          due_sats: 5000,
          paid_at: new Date('2026-11-11T12:00:00.000Z'),
          goal_currency: 'USD',
          goal_amount: null,
          goal_term_days: 1,
        },
      ],
      repaymentPayers: [{ account_id: FROM, sats: 50, usd: null, chf: null, eur: null, php: null }],
    });

    await expect(mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' })).resolves.toEqual({
      ok: false,
      error: 'repayment_unavailable',
    });
    expect(
      queries.some((query) => /^(?:INSERT|UPDATE|DELETE)\b/.test(query.text.trimStart())),
    ).toBe(false);

    const missingShare = fakeDatabase({
      legacyRepayments: [
        {
          message_id: messageId,
          day_index: 9,
          recipient_account_id: FROM,
          due_sats: 5000,
          paid_at: new Date('2026-11-11T12:00:00.000Z'),
          goal_currency: 'USD',
          goal_amount: '1.00',
          goal_term_days: 1,
        },
      ],
      repaymentPayers: [
        { account_id: FROM, sats: 50, usd: '1.00', chf: null, eur: null, php: null },
      ],
    });
    await expect(
      mergeAccounts(missingShare.db, { from: FROM, into: INTO, verify: 'into' }),
    ).resolves.toEqual({ ok: false, error: 'repayment_unavailable' });
    expect(
      missingShare.queries.some((query) =>
        /^(?:INSERT|UPDATE|DELETE)\b/.test(query.text.trimStart()),
      ),
    ).toBe(false);
  });

  it('refuses without writes when both accounts gave to a credit with a settled repayment', async () => {
    const messageId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const { db, queries } = fakeDatabase({
      repaymentConflicts: [{ message_id: messageId }],
    });

    await expect(mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' })).resolves.toEqual({
      ok: false,
      error: 'repayment_unavailable',
    });
    const conflict = queries.find((query) => query.text.includes('source_gift'));
    expect(conflict?.params).toEqual([FROM, INTO]);
    expect(conflict?.text).toContain('credit.goal_repayable IS TRUE');
    expect(conflict?.text).toContain('source_gift.payer_account_id = $1');
    expect(conflict?.text).toContain('survivor_gift.payer_account_id = $2');
    expect(conflict?.text).toContain('source_gift.recorded_at <= credit.goal_funded_at');
    expect(conflict?.text).toContain('survivor_gift.recorded_at <= credit.goal_funded_at');
    expect(conflict?.text).toContain('FROM message_repayment AS settled');
    expect(conflict?.text).toContain('FROM message_repayment_part AS settled_part');
    expect(
      queries.some((query) => /^(?:INSERT|UPDATE|DELETE)\b/.test(query.text.trimStart())),
    ).toBe(false);
  });

  it('refuses a payable source invoice when only the source funded the credit', async () => {
    const { db, queries } = fakeDatabase({
      openRepaymentInvoices: [
        {
          message_id: PROFILE,
          author_account_id: INTO,
          amount_sats: 100,
          payment_hash: null,
          description: `repay:0:${INTO}`,
          created_at: new Date(),
          pr: 'lnbc-open-repayment',
          payment_claimed: false,
        },
      ],
    });

    await expect(mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' })).resolves.toEqual({
      ok: false,
      error: 'repayment_unavailable',
    });
    const open = queries.find((query) => query.text.includes('FROM message_invoice AS invoice'));
    expect(open?.params).toEqual([FROM, INTO]);
    expect(open?.text).toContain('source_gift.payer_account_id = $1');
    expect(open?.text).not.toContain('survivor_gift');
    expect(open?.text).toContain("invoice.description LIKE 'repay:%:' || $1::text");
    expect(open?.text).toContain("invoice.description LIKE 'repayp:%:' || $1::text || ':%'");
    expect(open?.text).toContain("invoice.description LIKE 'repay:%:' || $2::text");
    expect(open?.text).toContain("invoice.description LIKE 'repayp:%:' || $2::text || ':%'");
    expect(open?.text).toContain('AS payment_claimed');
    expect(
      queries.some((query) => /^(?:INSERT|UPDATE|DELETE)\b/.test(query.text.trimStart())),
    ).toBe(false);
  });

  it('refuses an expired claim-only sibling part by its exact part index', async () => {
    const paymentHash = 'ab'.repeat(32);
    const { db, queries } = fakeDatabase({
      openRepaymentInvoices: [
        {
          message_id: PROFILE,
          author_account_id: INTO,
          amount_sats: 100,
          payment_hash: paymentHash,
          description: `repayp:0:${INTO}:1:100:200`,
          created_at: new Date(0),
          pr: 'expired-repayment',
          payment_claimed: true,
        },
      ],
      claimOnlyRepayment: true,
    });

    await expect(mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' })).resolves.toEqual({
      ok: false,
      error: 'repayment_unavailable',
    });
    const open = queries.find((query) => query.text.includes('FROM message_invoice AS invoice'));
    expect(open?.text).toContain('AS payment_claimed');
    const exact = queries.find(
      (query) =>
        query.text.includes('AS claim_only') &&
        query.text.includes('FROM message_repayment_part AS settled'),
    );
    expect(exact?.text).toContain('settled.part_index = $5::integer');
    expect(exact?.params).toEqual([paymentHash, PROFILE, 0, INTO, 1, '100', 100]);
    expect(
      queries.some((query) => /^(?:INSERT|UPDATE|DELETE)\b/.test(query.text.trimStart())),
    ).toBe(false);
  });

  it('allows an expired claimed invoice whose exact part is settled', async () => {
    const { db } = fakeDatabase({
      openRepaymentInvoices: [
        {
          message_id: PROFILE,
          author_account_id: INTO,
          amount_sats: 100,
          payment_hash: 'cd'.repeat(32),
          description: `repayp:0:${INTO}:1:100:200`,
          created_at: new Date(0),
          pr: 'expired-settled-repayment',
          payment_claimed: true,
        },
      ],
      claimOnlyRepayment: false,
    });

    await expect(mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' })).resolves.toEqual({
      ok: true,
      messages: 1,
    });
  });

  it('ignores malformed repayment-like descriptions in the merge scan', async () => {
    const { db } = fakeDatabase({
      openRepaymentInvoices: [
        {
          message_id: PROFILE,
          author_account_id: INTO,
          amount_sats: 100,
          payment_hash: null,
          description: 'repay:not-canonical',
          created_at: new Date(),
          pr: 'malformed-repayment',
          payment_claimed: false,
        },
      ],
    });

    await expect(mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' })).resolves.toEqual({
      ok: true,
      messages: 1,
    });
  });

  it('moves message.shop_account_id to the surviving account, so a shop stays listed', async () => {
    const { db, queries } = fakeDatabase();
    await mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' });
    expect(queries).toContainEqual({
      text: 'UPDATE "public"."message" SET "shop_account_id" = $1 WHERE "shop_account_id" = $2',
      params: [INTO, FROM],
    });
    expect(queries.some((query) => query.text.includes('shop_identity'))).toBe(false);
  });

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

  it('deletes the source social recovery rows before the challenge move and the catalog loop', async () => {
    const { db, queries } = fakeDatabase();

    await mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' });

    const deletes = [
      'DELETE FROM recovery_share WHERE account_id = $1',
      'DELETE FROM held_share_box WHERE account_id = $1',
      'DELETE FROM pending_recovery WHERE account_id = $1',
      'DELETE FROM previous_wallet WHERE account_id = $1',
      "DELETE FROM passkey_challenge WHERE account_id = $1 AND type = 'recovery'",
    ].map((text) => queries.findIndex((query) => query.text === text));
    const challengeMove = queries.findIndex(
      (query) =>
        query.text === 'UPDATE passkey_challenge SET account_id = $2 WHERE account_id = $1',
    );
    const catalog = queries.findIndex(
      (query) => query.text.includes('pg_constraint') && query.text.includes('JOIN LATERAL'),
    );
    expect(deletes.every((index) => index >= 0)).toBe(true);
    expect([...deletes].sort((a, b) => a - b)).toEqual(deletes);
    for (const index of deletes) {
      expect(queries[index]?.params).toEqual([FROM]);
      expect(index).toBeLessThan(challengeMove);
      expect(index).toBeLessThan(catalog);
    }
  });

  it('deletes the source held-share boxes before the catalog loop could move them', async () => {
    const { db, queries } = fakeDatabase({
      columns: [{ schema_name: 'public', table_name: 'held_share_box', column_name: 'account_id' }],
    });

    await expect(mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' })).resolves.toEqual({
      ok: true,
      messages: 1,
    });

    const deleted = queries.findIndex(
      (query) => query.text === 'DELETE FROM held_share_box WHERE account_id = $1',
    );
    const moved = queries.findIndex(
      (query) =>
        query.text ===
        'UPDATE "public"."held_share_box" SET "account_id" = $1 WHERE "account_id" = $2',
    );
    expect(queries[deleted]?.params).toEqual([FROM]);
    // The catalog loop still runs over the table, but no source row is left to move.
    expect(deleted).toBeGreaterThanOrEqual(0);
    expect(deleted).toBeLessThan(moved);
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
    const moved = queries.find((query) =>
      query.text.includes(
        "UPDATE trust_edge SET subject_id = $2 WHERE subject_id = $1 AND kind = 'verify'",
      ),
    );
    expect(moved?.params).toEqual([FROM, INTO]);
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
    // The merged account's payment rows are locked in id order after both
    // account rows and the charge lock, and before the catalog update moves them.
    const paymentLock = queries.findIndex(
      (query) => query.text.includes('FROM shop_payment') && query.text.includes('FOR UPDATE'),
    );
    expect(queries[paymentLock]?.params).toEqual([FROM]);
    expect(queries[paymentLock]?.text.replace(/\s+/g, ' ').trim()).toBe(
      'SELECT id FROM shop_payment WHERE account_id = $1 ORDER BY id FOR UPDATE',
    );
    expect(paymentLock).toBeGreaterThan(
      queries.findIndex(
        (query) => query.text.includes('FROM account') && query.text.includes('FOR UPDATE'),
      ),
    );
    expect(paymentLock).toBeGreaterThan(
      queries.findIndex(
        (query) => query.text.includes('FROM pos_charge') && query.text.includes('FOR UPDATE'),
      ),
    );
    expect(paymentLock).toBeLessThan(
      queries.findIndex((query) => query.text.startsWith('UPDATE "public"."shop_payment"')),
    );
  });

  it('refuses while the merged account has an unexpired pending charge and the survivor an open shop payment but no unexpired pending charge', async () => {
    const { db, queries } = fakeDatabase({ openBesideCharge: [{ id: 'sp-into-open' }] });
    await expect(mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' })).resolves.toEqual({
      ok: false,
      error: 'shop_payment_open',
    });
    const check = queries.at(-1);
    expect(check?.params).toEqual([FROM, INTO]);
    const flat = (check?.text ?? '').replace(/\s+/g, ' ').trim();
    expect(flat).toBe(
      "SELECT p.id FROM shop_payment AS p WHERE p.account_id = $2 AND p.status = 'open' AND EXISTS ( SELECT 1 FROM pos_charge AS c WHERE c.account_id = $1 AND c.status = 'pending' AND c.expires_at > now() ) AND NOT EXISTS ( SELECT 1 FROM pos_charge AS s WHERE s.account_id = $2 AND s.status = 'pending' AND s.expires_at > now() ) LIMIT 1",
    );
    // Checked under both account locks, which follow the affected message locks,
    // after the merged account's own check and before any write.
    expect(queries[0]?.text).toContain('pg_advisory_xact_lock');
    expect(
      queries.findIndex(
        (query) => query.text.includes('FROM account') && query.text.includes('FOR UPDATE'),
      ),
    ).toBeGreaterThan(0);
    expect(queries.filter((query) => query.text.includes('FROM shop_payment'))).toHaveLength(2);
    expect(queries.some((query) => /^\s*(UPDATE|DELETE|INSERT)\b/.test(query.text))).toBe(false);
  });

  it('goes on when the check finds no refusal (the survivor has its own pending charge): the merged account’s charge is deleted', async () => {
    const { db, queries } = fakeDatabase({ pendingCharges: [{ id: 'c-from-1' }] });
    const result = await mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' });
    expect(result.ok).toBe(true);
    const check = queries.findIndex((query) => query.text.includes("p.status = 'open'"));
    const lock = chargeLockIndex(queries);
    expect(check).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(check);
    expect(queries[lock + 5]).toEqual({
      text: 'DELETE FROM pos_charge WHERE id = ANY($1::uuid[])',
      params: ['{"c-from-1"}'],
    });
    // The survivor's shop payments are not written.
    expect(queries.some((query) => /UPDATE shop_payment/.test(query.text))).toBe(false);
  });

  it('locks all of the merged account’s charges in id order, then its payments, then deletes the pending charge’s invoice rows and the charge by the read ids', async () => {
    const { db, queries } = fakeDatabase({
      pendingCharges: [{ id: 'c-from-1' }, { id: 'c-from-2' }],
    });
    await mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' });
    const lock = chargeLockIndex(queries);
    expect(lock).toBeGreaterThanOrEqual(0);
    // Every charge row of the merged account, pending or not, in id order:
    // the deleted charge and the ones the catalog update moves.
    expect(queries[lock]).toEqual({
      text: `SELECT id FROM pos_charge
       WHERE account_id = $1 OR account_id = $2
       ORDER BY id
       FOR UPDATE`,
      params: [FROM, INTO],
    });
    // It is the only charge lock, and it comes before the payment lock.
    expect(
      queries.filter(
        (query) => query.text.includes('FROM pos_charge') && query.text.includes('FOR UPDATE'),
      ),
    ).toHaveLength(1);
    // Payments next, before any charge write, in id order.
    expect(queries[lock + 1]).toEqual({
      text: `SELECT id FROM shop_payment
       WHERE account_id = $1
       ORDER BY id
       FOR UPDATE`,
      params: [FROM],
    });
    // Due pending rows stop being pending before the collision read.
    expect(queries[lock + 2]?.params).toEqual([FROM, INTO]);
    expect((queries[lock + 2]?.text ?? '').replace(/\s+/g, ' ').trim()).toBe(
      "UPDATE pos_charge SET status = 'expired' WHERE account_id IN ($1, $2) AND status = 'pending' AND expires_at <= now()",
    );
    // Then only charges that are still unexpired, rows already held, and only
    // while the kept account still has an unexpired one.
    expect(doomedReadIndex(queries)).toBe(lock + 3);
    expect(queries[lock + 3]?.params).toEqual([FROM, INTO]);
    expect((queries[lock + 3]?.text ?? '').replace(/\s+/g, ' ').trim()).toBe(
      "SELECT id FROM pos_charge WHERE account_id = $1 AND status = 'pending' AND expires_at > now() AND EXISTS ( SELECT 1 FROM pos_charge WHERE account_id = $2 AND status = 'pending' AND expires_at > now() ) ORDER BY id",
    );
    expect(queries[lock + 4]).toEqual({
      text: 'DELETE FROM pos_charge_invoice WHERE charge_id = ANY($1::uuid[])',
      params: ['{"c-from-1","c-from-2"}'],
    });
    expect(queries[lock + 5]).toEqual({
      text: 'DELETE FROM pos_charge WHERE id = ANY($1::uuid[])',
      params: ['{"c-from-1","c-from-2"}'],
    });
  });

  it('locks the charge rows before the payment rows and writes neither before both locks', async () => {
    const { db, queries } = fakeDatabase({
      pendingCharges: [{ id: 'c-from-1' }],
      columns: [
        { schema_name: 'public', table_name: 'pos_charge', column_name: 'account_id' },
        { schema_name: 'public', table_name: 'shop_payment', column_name: 'account_id' },
      ],
    });
    await mergeAccounts(db, { from: FROM, into: INTO, verify: 'into' });
    const chargeLock = chargeLockIndex(queries);
    const paymentLock = queries.findIndex(
      (query) => query.text.includes('FROM shop_payment') && query.text.includes('FOR UPDATE'),
    );
    const chargeWrites = queries
      .map((query, index) => ({ query, index }))
      .filter(({ query }) => /^(UPDATE|DELETE FROM) ("public"\.)?"?pos_charge"?\b/.test(query.text))
      .map(({ index }) => index);
    const paymentWrites = queries
      .map((query, index) => ({ query, index }))
      .filter(({ query }) => /^UPDATE ("public"\.)?"?shop_payment"?\b/.test(query.text))
      .map(({ index }) => index);
    expect(chargeWrites).toHaveLength(3);
    expect(paymentWrites).toHaveLength(1);
    expect(chargeLock).toBeLessThan(paymentLock);
    for (const index of [...chargeWrites, ...paymentWrites]) {
      expect(index).toBeGreaterThan(paymentLock);
    }
    // The catalog update writes the merged account's remaining charges too.
    expect(queries).toContainEqual({
      text: 'UPDATE "public"."pos_charge" SET "account_id" = $1 WHERE "account_id" = $2',
      params: [INTO, FROM],
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
