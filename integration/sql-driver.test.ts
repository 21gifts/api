import { createHash } from 'node:crypto';
import { SQL } from 'bun';
import { describe, expect, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import { mergeAccounts, type MergeDb, type MergeTx } from '@/lib/account-merge';
import {
  backfillSparkAddresses,
  migrateAuthSchema,
  PostgresAuthStore,
} from '@/lib/auth/postgres-store';
import { AUTH_SCHEMA_SQL } from '@/lib/auth/schema';
import { sqlState, type SqlClient } from '@/lib/auth/sql';
import type { PasskeyChallenge, PendingRecovery } from '@/lib/auth/store';
import { CHALLENGE_TTL_MS } from '@/lib/config';
import { repaymentDescription, repaymentPartDescription } from '@/lib/credit-repayment';
import {
  linkDailyRosterAccounts,
  migrateDailyRosterSchema,
  PostgresDailyRosterStore,
} from '@/lib/daily-roster-store';
import type { FundingGrant } from '@/lib/funding';
import { migrateFundingSchema, PostgresFundingStore } from '@/lib/funding-store';
import { migrateMemberHabitSchema, PostgresMemberHabitStore } from '@/lib/member-habit-store';
import {
  migrateFondPayoutSchema,
  PostgresFondPayoutStore,
  type FondPayoutEnqueue,
} from '@/lib/fond-payout-store';
import { migrateDbChangeSchema } from '@/lib/db-change';
import { DEBUG_DB_PAGE_SIZE, PostgresDebugDbStore } from '@/lib/debug-db';
import { migrateFxSpotSchema, PostgresFxSpotStore } from '@/lib/fx-spot-store';
import { NOT_PAYABLE, serializeMessage, unsignedNostrDefaults } from '@/lib/message';
import { migrateMessageSchema, PostgresMessageStore, type MessageStore } from '@/lib/message-store';
import { migrateBannerSchema } from '@/lib/banner-store';
import { migrateConversationSchema } from '@/lib/conversation-store';
import { migrateNotificationSchema } from '@/lib/notification-store';
import { migratePushSchema, PostgresPushStore, type PushOutboxRow } from '@/lib/push-store';
import { migrateTrustSchema } from '@/lib/trust-store';
import { PAYMENT_HASH_LOCK_NAMESPACE } from '@/lib/payment-hash-claim';
import { postgresTextArrayLiteral } from '@/lib/postgres-text-array';
import { POS_CHARGE_TTL_MS, type PosCharge } from '@/lib/pos-charge';
import { migratePosSchema, PostgresPosStore } from '@/lib/pos-store';
import { evaluateProof, lockPaymentForProofs, ShopPayments } from '@/lib/shop-payment';
import {
  followsOrderStatus,
  migrateShopPaymentSchema,
  PostgresShopPaymentStore,
  type ShopOffer,
  type ShopPayment,
  type ShopProof,
  type ShopProofLookup,
  type ShopTx,
} from '@/lib/shop-payment-store';
import { encodeSparkAddress } from '@/lib/spark-address';
import {
  MEMBER_SPARK_INVOICE_CAP,
  migrateSparkInvoiceSchema,
  PostgresSparkInvoiceStore,
} from '@/lib/spark-invoice-store';
import { migrateMemberEventSchema, PostgresMemberEventStore } from '@/lib/member-event-store';
import { migrateLoginGateSchema, PostgresLoginGateStore } from '@/lib/login-gate-store';
import { parseWalletReport } from '@/lib/wallet-report';
import { buildWalletStats } from '@/lib/wallet-stats';
import {
  migrateWalletSchema,
  PostgresWalletStore,
  repairWalletPaymentPairs,
  type WalletPaymentRecord,
} from '@/lib/wallet-store';
import {
  PostgresWalletTransferStore,
  type WalletTransferRecord,
} from '@/lib/wallet-transfer-store';
import {
  migrateWelcomeInvoiceReservationSchema,
  PostgresWelcomeInvoiceReservationStore,
} from '@/lib/welcome-reservation';
import { PostgresWalletUsageStore } from '@/lib/wallet-usage-store';
import type { WalletUsagePaymentRow } from '@/lib/wallet-usage';
import { migrateBtcUsdSchema } from '@/lib/btc-usd-store';
import { migrateFiatSchema } from '@/lib/usd-fiat-store';
import type { OrchestraClient } from '@/lib/orchestra';
import { submitProofAttempt, type ShopSubmitAttempt } from '@/lib/shop-proof';
import { runShopPaymentTick } from '@/lib/shop-payment-worker';
import {
  migrateShopIdentitySchema,
  PostgresShopIdentityStore,
  shopNpub,
} from '@/lib/shop-identity';
import { isListedShop } from '@/lib/shop-place';
import { runOcpPhotoOutboxPass, runOcpPlaceOutboxPass } from '@/lib/ocp-outbox';
import { signEventForShop } from '@/lib/nostr/sign';
import { manualReceiptIdForPaymentHash, settleInvoiceManually } from '@/lib/nostr/zap-index';
import type { ForumPhoto, MessageRow } from '@/lib/message';
import { messagesRoutes } from '@/routes/messages';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined || databaseUrl === '') {
  throw new Error('DATABASE_URL is required');
}

/**
 * `query` / `execute` body matches `createBunDatabase(...).client` in `src/index.ts`.
 * `mergeDb.begin` matches `createBunDatabase(...).mergeDb`.
 * `sql` is that same instance so the test can close it.
 */
function createBunSqlClient(
  databaseUrl: string,
  options: { max?: number } = {},
): {
  client: SqlClient;
  mergeDb: MergeDb;
  sql: SQL;
} {
  const sql = new SQL({ url: databaseUrl, ...options });
  const client: SqlClient = {
    async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      const rows = (await sql.unsafe(text, [...params])) as T[];
      return rows;
    },
    async execute(text: string, params: readonly unknown[] = []): Promise<void> {
      await sql.unsafe(text, [...params]);
    },
    async transaction<T>(run: (tx: SqlClient) => Promise<T>): Promise<T> {
      return sql.begin(async (tx) =>
        run({
          query: async <R>(text: string, params: readonly unknown[] = []): Promise<R[]> =>
            (await tx.unsafe(text, [...params])) as R[],
          execute: async (text: string, params: readonly unknown[] = []): Promise<void> => {
            await tx.unsafe(text, [...params]);
          },
        }),
      );
    },
  };
  const mergeDb: MergeDb = {
    async begin<T>(run: (tx: MergeTx) => Promise<T>): Promise<T> {
      return sql.begin(async (tx) =>
        run({
          query: async <R>(text: string, params: readonly unknown[] = []): Promise<R[]> =>
            (await tx.unsafe(text, [...params])) as R[],
        }),
      );
    },
  };
  return { client, mergeDb, sql };
}

async function closeIfPossible(sql: SQL): Promise<void> {
  if (typeof sql.close === 'function') {
    await sql.close();
  }
}

describe('Bun SQL text[] binding', () => {
  test('driver binds or rejects a JavaScript array', async () => {
    const sql = new SQL(databaseUrl);
    try {
      let thrown: unknown;
      let rows: { tags: unknown }[] | undefined;
      try {
        rows = (await sql.unsafe('SELECT $1::text[] AS tags', [['rejected']])) as {
          tags: unknown;
        }[];
      } catch (error) {
        thrown = error;
      }
      // Bun 1.3 rejects a JavaScript array as a malformed array literal.
      // Bun 1.4 binds it. The literal form remains the next test.
      if (thrown !== undefined) {
        const message = String(thrown);
        if (!message.includes('malformed array literal')) {
          throw thrown;
        }
        return;
      }
      const tags = rows?.[0]?.tags;
      if (Array.isArray(tags)) {
        expect(tags.includes('rejected')).toBe(true);
        return;
      }
      if (typeof tags === 'string') {
        expect(tags.includes('rejected')).toBe(true);
        return;
      }
      throw new Error(`unexpected tags shape: ${typeof tags}`);
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('driver accepts the literal', async () => {
    const sql = new SQL(databaseUrl);
    try {
      const rows = (await sql.unsafe('SELECT $1::text[] AS tags', [
        postgresTextArrayLiteral(['rejected']),
      ])) as { tags: unknown }[];
      const tags = rows[0]?.tags;
      if (Array.isArray(tags)) {
        expect(tags.includes('rejected')).toBe(true);
      } else if (typeof tags === 'string') {
        expect(tags.includes('rejected')).toBe(true);
      } else {
        throw new Error(`unexpected tags shape: ${typeof tags}`);
      }
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('admitWithinPlaces never exceeds the round under concurrent admissions', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateAuthSchema(client);
      await migrateFundingSchema(client);
      const transactions: MergeDb = {
        begin: (run) =>
          sql.begin(async (tx) =>
            run({
              query: async <R>(text: string, params: readonly unknown[] = []): Promise<R[]> =>
                (await tx.unsafe(text, [...params])) as R[],
            }),
          ),
      };
      const store = new PostgresFundingStore(client, transactions);
      const startsAtMs = Date.now() + 60_000;
      const round = { number: 99, startsAtMs, places: 2, nextGoalShops: 20 };
      const ids = [
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
      ];
      for (const id of ids) {
        await client.execute(
          `INSERT INTO account (id, role, lightning_address_verified, forum_laws_dismissed, created_at)
VALUES ($1, 'verified', false, false, $2)`,
          [id, new Date()],
        );
        await store.transition(
          {
            accountId: id,
            status: 'pending',
            appliedAt: Date.now(),
            decidedAt: null,
            decidedBy: null,
            trialUtcDate: null,
            admittedAt: null,
            note: null,
          },
          ['none'],
        );
      }
      const results = await Promise.all(
        ids.map((id) =>
          store.admitWithinPlaces(
            {
              accountId: id,
              status: 'admitted',
              appliedAt: Date.now(),
              decidedAt: startsAtMs,
              decidedBy: null,
              trialUtcDate: null,
              admittedAt: startsAtMs,
              note: null,
            },
            ['pending', 'trial'],
            round,
          ),
        ),
      );
      expect(results.filter((result) => result === 'full')).toHaveLength(2);
      expect(results.filter((result) => typeof result === 'object')).toHaveLength(2);
      const stored = await Promise.all(ids.map((id) => store.getByAccountId(id)));
      expect(stored.filter((grant) => grant?.status === 'admitted')).toHaveLength(2);
      await client.execute('DELETE FROM funding_grant WHERE account_id = ANY($1::uuid[])', [
        `{${ids.join(',')}}`,
      ]);
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('migrateFundingSchema lets a table with the old status check store withdrawn', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    const accountId = crypto.randomUUID();
    try {
      await migrateAuthSchema(client);
      await migrateFundingSchema(client);
      await client.execute(
        `INSERT INTO account (id, role, lightning_address_verified, forum_laws_dismissed, created_at)
VALUES ($1, 'verified', false, false, $2)`,
        [accountId, new Date()],
      );
      // The check as it was before `withdrawn` existed. NOT VALID keeps rows of
      // other tests out of the way; new writes are still checked.
      await client.execute(
        'ALTER TABLE funding_grant DROP CONSTRAINT IF EXISTS funding_grant_status_check',
      );
      await client.execute(
        `ALTER TABLE funding_grant ADD CONSTRAINT funding_grant_status_check
          CHECK (status IN ('pending', 'trial', 'admitted', 'rejected')) NOT VALID`,
      );
      const store = new PostgresFundingStore(client);
      const admitted: FundingGrant = {
        accountId,
        status: 'admitted',
        appliedAt: 1_000,
        decidedAt: 2_000,
        decidedBy: null,
        trialUtcDate: null,
        admittedAt: 2_000,
        note: 'kept',
      };
      await store.upsert(admitted);
      const withdrawn: FundingGrant = {
        ...admitted,
        status: 'withdrawn',
        decidedAt: 3_000,
        decidedBy: accountId,
        admittedAt: null,
      };
      let refused: unknown;
      try {
        await store.transition(withdrawn, ['admitted']);
      } catch (err) {
        refused = err;
      }
      expect(sqlState(refused)).toBe('23514');

      await migrateFundingSchema(client);
      await migrateFundingSchema(client);
      const checks = await client.query<{ def: string; validated: boolean }>(
        `SELECT pg_get_constraintdef(oid) AS def, convalidated AS validated FROM pg_constraint
         WHERE conrelid = 'funding_grant'::regclass AND conname = 'funding_grant_status_check'`,
      );
      expect(checks).toHaveLength(1);
      expect(checks[0]?.validated).toBe(true);
      expect(checks[0]?.def).toContain("'withdrawn'::text");

      expect(await store.transition(withdrawn, ['pending'])).toBeUndefined();
      expect(await store.transition(withdrawn, ['admitted'])).toEqual(withdrawn);
      expect(await store.getByAccountId(accountId)).toEqual(withdrawn);
      expect(await store.transition(withdrawn, ['admitted'])).toBeUndefined();

      const again: FundingGrant = {
        accountId,
        status: 'pending',
        appliedAt: 4_000,
        decidedAt: null,
        decidedBy: null,
        trialUtcDate: null,
        admittedAt: null,
        note: null,
      };
      expect(await store.transition(again, ['none', 'rejected', 'withdrawn'])).toEqual(again);
    } finally {
      await client.execute('DELETE FROM funding_grant WHERE account_id = $1', [accountId]);
      await closeIfPossible(sql);
    }
  });

  test('db_change keeps a withdrawal after the member applies again', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    const accountId = crypto.randomUUID();
    const staffId = crypto.randomUUID();
    try {
      await migrateAuthSchema(client);
      await migrateFundingSchema(client);
      await migrateDbChangeSchema(client);
      for (const id of [accountId, staffId]) {
        await client.execute(
          `INSERT INTO account (id, role, lightning_address_verified, forum_laws_dismissed, created_at)
VALUES ($1, 'verified', false, false, $2)`,
          [id, new Date()],
        );
      }
      const store = new PostgresFundingStore(client);
      const appliedAt = Date.parse('2026-11-01T08:00:00.000Z');
      const admittedAt = Date.parse('2026-11-02T08:00:00.000Z');
      const withdrawnAt = Date.parse('2026-11-03T08:00:00.000Z');
      const reappliedAt = Date.parse('2026-11-04T08:00:00.000Z');
      const base: FundingGrant = {
        accountId,
        status: 'pending',
        appliedAt,
        decidedAt: null,
        decidedBy: null,
        trialUtcDate: null,
        admittedAt: null,
        note: null,
      };
      expect(await store.transition(base, ['none', 'rejected', 'withdrawn'])).toEqual(base);
      const admitted: FundingGrant = {
        ...base,
        status: 'admitted',
        decidedAt: admittedAt,
        decidedBy: staffId,
        admittedAt,
      };
      expect(await store.transition(admitted, ['pending', 'trial'])).toEqual(admitted);
      const withdrawn: FundingGrant = {
        ...base,
        status: 'withdrawn',
        decidedAt: withdrawnAt,
        decidedBy: accountId,
      };
      expect(await store.transition(withdrawn, ['admitted'])).toEqual(withdrawn);
      const again: FundingGrant = { ...base, appliedAt: reappliedAt };
      expect(await store.transition(again, ['none', 'rejected', 'withdrawn'])).toEqual(again);
      expect((await store.getByAccountId(accountId))?.status).toBe('pending');

      const changes = await client.query<{
        op: string;
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
      }>(
        `SELECT op, before, after FROM db_change
         WHERE table_name = 'funding_grant' AND after->>'account_id' = $1
         ORDER BY id ASC`,
        [accountId],
      );
      const statuses = changes.map((row) => [
        row.before?.['status'] ?? null,
        row.after?.['status'],
      ]);
      expect(statuses).toEqual([
        [null, 'pending'],
        ['pending', 'admitted'],
        ['admitted', 'withdrawn'],
        ['withdrawn', 'pending'],
      ]);
      const leaving = changes[2];
      expect(leaving?.op).toBe('UPDATE');
      expect(leaving?.after?.['decided_by']).toBe(accountId);
      expect(Date.parse(String(leaving?.after?.['decided_at']))).toBe(withdrawnAt);
      expect(leaving?.after?.['admitted_at']).toBeNull();
      expect(leaving?.before?.['decided_by']).toBe(staffId);
      expect(Date.parse(String(leaving?.before?.['admitted_at']))).toBe(admittedAt);
      const returning = changes[3];
      expect(returning?.op).toBe('UPDATE');
      expect(returning?.before?.['decided_by']).toBe(accountId);
      expect(Date.parse(String(returning?.before?.['decided_at']))).toBe(withdrawnAt);
      expect(Date.parse(String(returning?.after?.['applied_at']))).toBe(reappliedAt);

      const listed = (await store.listWithdrawals()).filter((row) => row.accountId === accountId);
      expect(listed).toEqual([{ accountId, withdrawnAt, from: 'admitted', admittedAt }]);
    } finally {
      await client.execute('DELETE FROM funding_grant WHERE account_id = $1', [accountId]);
      await closeIfPossible(sql);
    }
  });

  test('funding apply through PostgresFundingStore', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateAuthSchema(client);
      await migrateFundingSchema(client);

      const accountId = crypto.randomUUID();
      await client.execute(
        `INSERT INTO account (id, role, lightning_address_verified, forum_laws_dismissed, created_at)
VALUES ($1, 'verified', false, false, $2)`,
        [accountId, new Date()],
      );

      const store = new PostgresFundingStore(client);
      const appliedAt = Date.now();
      const pending: FundingGrant = {
        accountId,
        status: 'pending',
        appliedAt,
        decidedAt: null,
        decidedBy: null,
        trialUtcDate: null,
        admittedAt: null,
        note: null,
      };

      const created = await store.transition(pending, ['none', 'rejected']);
      expect(created?.status).toBe('pending');

      const second = await store.transition(
        {
          accountId,
          status: 'pending',
          appliedAt: appliedAt + 1,
          decidedAt: null,
          decidedBy: null,
          trialUtcDate: null,
          admittedAt: null,
          note: null,
        },
        ['none', 'rejected'],
      );
      expect(second).toBeUndefined();

      const stillPending = await store.getByAccountId(accountId);
      expect(stillPending?.status).toBe('pending');

      const decidedAt = Date.now();
      const admitted = await store.transition(
        {
          accountId,
          status: 'admitted',
          appliedAt,
          decidedAt,
          decidedBy: null,
          trialUtcDate: null,
          admittedAt: decidedAt,
          note: null,
        },
        ['pending', 'trial'],
      );
      expect(admitted?.status).toBe('admitted');
    } finally {
      await closeIfPossible(sql);
    }
  });
});

describe('member habit revision checks', () => {
  test('a reused table gains char_length checks and a bad comment id is missing', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    const habitSql = {
      async query(text: string, params?: unknown[]) {
        const rows = await client.query<Record<string, unknown>>(text, params);
        return { rows };
      },
    };
    const accountId = crypto.randomUUID();
    const habitId = crypto.randomUUID();
    let ready = false;
    try {
      await migrateAuthSchema(client);
      await migrateMemberHabitSchema(habitSql);
      ready = true;
      // A table created before the length checks has no char_length constraint.
      // CREATE TABLE IF NOT EXISTS does not add one, so only the DO block can.
      await client.execute(
        `DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint AS con
    WHERE con.conrelid = 'member_habit_revision'::regclass
      AND con.contype = 'c'
      AND (
        pg_get_constraintdef(con.oid) LIKE '%char_length(name)%'
        OR pg_get_constraintdef(con.oid) LIKE '%char_length(description)%'
      )
  LOOP
    EXECUTE format('ALTER TABLE member_habit_revision DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;`,
      );
      const revisionChecks = async (): Promise<{ name: string; def: string }[]> => {
        return client.query<{ name: string; def: string }>(
          `SELECT conname AS name, pg_get_constraintdef(oid) AS def
           FROM pg_constraint
           WHERE conrelid = 'member_habit_revision'::regclass AND contype = 'c'`,
        );
      };
      const dropped = await revisionChecks();
      expect(dropped.map((row) => row.def).join('\n')).not.toContain('char_length(');
      await migrateMemberHabitSchema(habitSql);
      const added = await revisionChecks();
      expect(added.map((row) => row.name).sort()).toEqual([
        'member_habit_revision_description_len',
        'member_habit_revision_name_len',
      ]);
      expect(added.map((row) => row.def).join('\n')).toContain('char_length(name)');
      expect(added.map((row) => row.def).join('\n')).toContain('char_length(description)');
      await migrateMemberHabitSchema(habitSql);
      const again = await revisionChecks();
      expect(again.map((row) => row.name).sort()).toEqual([
        'member_habit_revision_description_len',
        'member_habit_revision_name_len',
      ]);

      await client.execute(
        `INSERT INTO account (id, role, lightning_address_verified, forum_laws_dismissed, created_at)
VALUES ($1, 'basis', false, false, $2)`,
        [accountId, new Date()],
      );
      const store = new PostgresMemberHabitStore(habitSql, {
        get: async () => null,
        set: async () => {
          return;
        },
      });
      await store.add({
        id: habitId,
        accountId,
        ownerName: 'Owner',
        role: 'basis',
        name: 'Walk',
        description: '',
        notes: '',
        cadence: 'daily',
        timeZone: 'Asia/Manila',
        firstPeriod: '2026-10-01',
        lastPeriod: null,
      });
      expect(
        await store.edit(
          habitId,
          accountId,
          { name: 'Run', description: 'Out', notes: 'n' },
          '2026-10-05',
        ),
      ).toBe('ok');
      expect(await store.archive(habitId, accountId, '2026-10-05')).toBe('ok');
      expect(
        await store.edit(
          habitId,
          accountId,
          { name: 'Later', description: 'Out', notes: 'n' },
          '2026-10-06',
        ),
      ).toBe('closed');
      const kept = await store.listPublic(accountId, Date.parse('2026-10-07T04:00:00.000Z'));
      expect(kept.find((row) => row.id === habitId)?.name).toBe('Run');
      await client.execute(
        `INSERT INTO member_habit_revision (habit_id, period, name, description)
VALUES ($1, '2026-10-02', $2, 'ok')`,
        [habitId, 'a'.repeat(80)],
      );

      let tooLongName: unknown;
      try {
        await client.execute(
          `INSERT INTO member_habit_revision (habit_id, period, name, description)
VALUES ($1, '2026-10-03', $2, 'ok')`,
          [habitId, 'a'.repeat(81)],
        );
      } catch (error) {
        tooLongName = error;
      }
      expect(sqlState(tooLongName)).toBe('23514');

      let tooLongDescription: unknown;
      try {
        await client.execute(
          `INSERT INTO member_habit_revision (habit_id, period, name, description)
VALUES ($1, '2026-10-04', 'ok', $2)`,
          [habitId, 'b'.repeat(2001)],
        );
      } catch (error) {
        tooLongDescription = error;
      }
      expect(sqlState(tooLongDescription)).toBe('23514');

      expect(await store.findComment('nope')).toBeNull();
      expect(await store.deleteComment('nope', 1)).toBe(false);
      expect(await store.findComment(crypto.randomUUID())).toBeNull();
    } finally {
      if (ready) {
        await client.execute(`DELETE FROM member_habit_revision WHERE habit_id = $1`, [habitId]);
        await client.execute(`DELETE FROM member_habit_log WHERE habit_id = $1`, [habitId]);
        await client.execute(`DELETE FROM member_habit_comment WHERE habit_id = $1`, [habitId]);
        await client.execute(`DELETE FROM member_habit WHERE id = $1`, [habitId]);
        await client.execute(`DELETE FROM account WHERE id = $1`, [accountId]);
      }
      await closeIfPossible(sql);
    }
  });
});

describe('daily roster keyed by account', () => {
  const viewKey = (): string =>
    `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;

  /** Two accounts with a legacy external address; one has a second account's in-app address. */
  async function seedAccounts(
    client: SqlClient,
    stamp: string,
  ): Promise<{ ada: string; bea: string; legacyAda: string; legacyBea: string }> {
    const ada = crypto.randomUUID();
    const bea = crypto.randomUUID();
    const legacyAda = `ada_${stamp}@wallet.example`;
    const legacyBea = `bea_${stamp}@wallet.example`;
    await client.execute(
      `INSERT INTO account (id, role, name, username, lightning_address, lightning_address_verified,
         forum_laws_dismissed, created_at, view_key)
       VALUES ($1, 'verified', 'Ada', $2, $3, true, false, now(), $4),
              ($5, 'moderator', 'Bea', $6, $7, true, false, now(), $8)`,
      [ada, `ada_${stamp}`, legacyAda, viewKey(), bea, `bea_${stamp}`, legacyBea, viewKey()],
    );
    return { ada, bea, legacyAda, legacyBea };
  }

  async function reset(client: SqlClient): Promise<void> {
    await migrateAuthSchema(client);
    await migrateDailyRosterSchema(client);
    await migrateDbChangeSchema(client);
    await client.execute('DELETE FROM daily_roster_entry');
    await client.execute('DELETE FROM daily_roster');
  }

  test('links legacy rows once, keeps amounts and buckets, and leaves an unmatched row unpaid', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    const stamp = `${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
    let ids: string[] = [];
    try {
      await reset(client);
      const { ada, bea, legacyAda, legacyBea } = await seedAccounts(client, stamp);
      ids = [ada, bea];
      await client.execute(
        `INSERT INTO daily_roster (singleton, comment, payments_enabled, moderator_payments_enabled)
         VALUES (true, 'thanks', true, true)`,
      );
      await client.execute(
        `INSERT INTO daily_roster_entry (address, amount_usd, bucket)
         SELECT address, amount_usd, bucket
           FROM unnest($1::text[], $2::double precision[], $3::text[])
                WITH ORDINALITY AS t(address, amount_usd, bucket, n)
          ORDER BY n`,
        [
          postgresTextArrayLiteral([
            ` ${legacyAda.toUpperCase()} `,
            legacyBea,
            legacyBea,
            `gone_${stamp}@wallet.example`,
            `BEA_${stamp}@Gifts.Example`,
          ]),
          '{3,2.5,5,3,9}',
          postgresTextArrayLiteral(['daily', 'daily', 'moderator', 'daily', 'moderator']),
        ],
      );
      const store = new PostgresDailyRosterStore(client);
      const before = await store.linkReport();
      expect(before.rows).toBe(5);
      expect(before.linked).toBe(0);
      const markerRows = await client.query<{ marker: string }>(
        'SELECT coalesce(max(id), 0)::text AS marker FROM db_change',
      );

      expect(await linkDailyRosterAccounts(client, 'Gifts.Example')).toEqual({
        linked: 3,
        unlinked: 2,
      });
      const after = await store.linkReport();
      expect(after).toEqual({
        rows: 5,
        linked: 3,
        unlinked: [
          { bucket: 'daily', address: `gone_${stamp}@wallet.example`, amountUsd: 3 },
          { bucket: 'moderator', address: `BEA_${stamp}@Gifts.Example`, amountUsd: 9 },
        ],
        buckets: {
          daily: { rows: 3, linked: 2, totalUsd: 8.5, linkedUsd: 5.5 },
          moderator: { rows: 2, linked: 1, totalUsd: 14, linkedUsd: 5 },
        },
      });
      expect(after.buckets.daily.totalUsd - after.buckets.daily.linkedUsd).toBe(3);
      expect(await store.get()).toEqual({
        comment: 'thanks',
        paymentsEnabled: true,
        moderatorPaymentsEnabled: true,
        defaultAmountUsd: 1,
        recipients: [
          { accountId: ada, amountUsd: 3 },
          { accountId: bea, amountUsd: 2.5 },
        ],
        moderators: [{ accountId: bea, amountUsd: 5 }],
      });
      const changes = await client.query<{ op: string }>(
        `SELECT op FROM db_change WHERE id > $1::bigint AND table_name = 'daily_roster_entry'`,
        [markerRows[0]?.marker ?? '0'],
      );
      expect(changes.map((row) => row.op)).toEqual(['UPDATE', 'UPDATE', 'UPDATE']);

      expect(await linkDailyRosterAccounts(client, 'gifts.example')).toEqual({
        linked: 0,
        unlinked: 2,
      });
      expect(await store.linkReport()).toEqual(after);
    } finally {
      await client.execute('DELETE FROM daily_roster_entry');
      await client.execute('DELETE FROM daily_roster');
      await client.execute('DELETE FROM account WHERE id = ANY($1::uuid[])', [
        postgresTextArrayLiteral(ids),
      ]);
      await closeIfPossible(sql);
    }
  });

  test('links an in-app address only with a host and a row per account and bucket', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    const stamp = `${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
    let ids: string[] = [];
    try {
      await reset(client);
      const { ada, bea, legacyAda } = await seedAccounts(client, stamp);
      ids = [ada, bea];
      await client.execute(
        `INSERT INTO daily_roster_entry (address, amount_usd, bucket)
         VALUES ($1, 2, 'daily'), ($2, 3, 'daily'), ($3, 4, 'daily')`,
        [`bea_${stamp}@gifts.example`, legacyAda, `ADA_${stamp}@gifts.example`],
      );
      expect(await linkDailyRosterAccounts(client, null)).toEqual({ linked: 1, unlinked: 2 });
      expect(await linkDailyRosterAccounts(client, 'gifts.example')).toEqual({
        linked: 1,
        unlinked: 1,
      });
      const rows = await client.query<{ account_id: string | null; amount_usd: number }>(
        'SELECT account_id, amount_usd FROM daily_roster_entry ORDER BY id',
      );
      expect(rows).toEqual([
        { account_id: bea, amount_usd: 2 },
        { account_id: ada, amount_usd: 3 },
        { account_id: null, amount_usd: 4 },
      ]);
    } finally {
      await client.execute('DELETE FROM daily_roster_entry');
      await client.execute('DELETE FROM account WHERE id = ANY($1::uuid[])', [
        postgresTextArrayLiteral(ids),
      ]);
      await closeIfPossible(sql);
    }
  });

  test('leaves a row unlinked when its legacy and in-app matches name different accounts', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    const stamp = `${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
    let ids: string[] = [];
    try {
      await reset(client);
      const { ada, bea } = await seedAccounts(client, stamp);
      ids = [ada, bea];
      const shared = `bea_${stamp}@gifts.example`;
      await client.execute('UPDATE account SET lightning_address = $1 WHERE id = $2', [
        shared,
        ada,
      ]);
      await client.execute(
        `INSERT INTO daily_roster_entry (address, amount_usd, bucket) VALUES ($1, 2, 'daily')`,
        [shared],
      );
      expect(await linkDailyRosterAccounts(client, 'gifts.example')).toEqual({
        linked: 0,
        unlinked: 1,
      });
      const report = await new PostgresDailyRosterStore(client, 'gifts.example').linkReport();
      expect(report.unlinked).toEqual([{ bucket: 'daily', address: shared, amountUsd: 2 }]);
    } finally {
      await client.execute('DELETE FROM daily_roster_entry');
      await client.execute('DELETE FROM account WHERE id = ANY($1::uuid[])', [
        postgresTextArrayLiteral(ids),
      ]);
      await closeIfPossible(sql);
    }
  });

  test('edits rows by account, imports once with the link, and keeps one row per bucket', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    const stamp = `${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
    let ids: string[] = [];
    try {
      await reset(client);
      const { ada, bea, legacyAda } = await seedAccounts(client, stamp);
      ids = [ada, bea];
      const store = new PostgresDailyRosterStore(client, 'gifts.example');
      const first = await store.importDocument({
        comment: 'kept',
        paymentsEnabled: false,
        recipients: [
          { address: legacyAda, amountUsd: 2.5 },
          { address: `gone_${stamp}@wallet.example`, amountUsd: 1 },
        ],
        moderators: [{ address: `bea_${stamp}@gifts.example`, amountUsd: 3 }],
      });
      expect(first).toEqual({
        comment: 'kept',
        paymentsEnabled: false,
        moderatorPaymentsEnabled: true,
        defaultAmountUsd: 1,
        recipients: [{ accountId: ada, amountUsd: 2.5 }],
        moderators: [{ accountId: bea, amountUsd: 3 }],
      });
      expect(await store.importDocument({ comment: 'other' })).toEqual(first);
      await client.execute('UPDATE daily_roster_entry SET account_id = NULL WHERE address = $1', [
        legacyAda,
      ]);
      expect(await store.importDocument({ comment: 'retry' })).toEqual(first);
      await expect(store.addRecipient(ada, 4)).rejects.toMatchObject({
        status: 400,
        error: 'Address already listed',
      });
      await store.addRecipient(bea, 4);
      await store.updateModerator(bea, 6);
      const edited = await store.deleteRecipient(ada);
      expect(edited.recipients).toEqual([{ accountId: bea, amountUsd: 4 }]);
      expect(edited.moderators).toEqual([{ accountId: bea, amountUsd: 6 }]);
      await expect(store.updateRecipient(ada, 1)).rejects.toMatchObject({
        error: 'Unknown address',
      });
      expect((await store.linkReport()).unlinked).toEqual([
        { bucket: 'daily', address: `gone_${stamp}@wallet.example`, amountUsd: 1 },
      ]);
    } finally {
      await client.execute('DELETE FROM daily_roster_entry');
      await client.execute('DELETE FROM daily_roster');
      await client.execute('DELETE FROM account WHERE id = ANY($1::uuid[])', [
        postgresTextArrayLiteral(ids),
      ]);
      await closeIfPossible(sql);
    }
  });

  test('a merge keeps the survivor row of a shared bucket and moves the other', async () => {
    const { client, mergeDb, sql } = createBunSqlClient(databaseUrl);
    const stamp = `${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
    let ids: string[] = [];
    try {
      await migrateMergeTables(client);
      await reset(client);
      const { ada, bea } = await seedAccounts(client, stamp);
      ids = [ada, bea];
      const store = new PostgresDailyRosterStore(client);
      await store.addRecipient(ada, 2);
      await store.addModerator(ada, 5);
      await store.addRecipient(bea, 3);
      expect((await mergeAccounts(mergeDb, { from: ada, into: bea, verify: 'into' })).ok).toBe(
        true,
      );
      const doc = await store.get();
      expect(doc.recipients).toEqual([{ accountId: bea, amountUsd: 3 }]);
      expect(doc.moderators).toEqual([{ accountId: bea, amountUsd: 5 }]);
    } finally {
      await client.execute('DELETE FROM daily_roster_entry');
      await client.execute('DELETE FROM daily_roster');
      await client.execute('DELETE FROM account WHERE id = ANY($1::uuid[])', [
        postgresTextArrayLiteral(ids),
      ]);
      await closeIfPossible(sql);
    }
  });
});

describe('staff_tag role migration on Postgres', () => {
  test('promotes fond and the lower ranks; initiator and founder keep their role', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    const ids = {
      basis: crypto.randomUUID(),
      verified: crypto.randomUUID(),
      moderator: crypto.randomUUID(),
      fond: crypto.randomUUID(),
      initiator: crypto.randomUUID(),
      founder: crypto.randomUUID(),
    };
    try {
      await migrateAuthSchema(client);
      await client.execute('ALTER TABLE account ADD COLUMN IF NOT EXISTS staff_tag text');
      for (const [role, id] of Object.entries(ids)) {
        await client.execute(
          `INSERT INTO account
             (id, role, staff_tag, lightning_address_verified, forum_laws_dismissed, created_at)
           VALUES ($1, $2, 'software_developer', false, false, $3)`,
          [id, role, new Date()],
        );
      }

      await migrateAuthSchema(client);

      const roleOf = async (id: string): Promise<string | undefined> => {
        const rows = await client.query<{ role: string }>(
          'SELECT role FROM account WHERE id = $1',
          [id],
        );
        return rows[0]?.role;
      };
      expect(await roleOf(ids.basis)).toBe('software_developer');
      expect(await roleOf(ids.verified)).toBe('software_developer');
      expect(await roleOf(ids.moderator)).toBe('software_developer');
      expect(await roleOf(ids.fond)).toBe('software_developer');
      expect(await roleOf(ids.initiator)).toBe('initiator');
      expect(await roleOf(ids.founder)).toBe('founder');
      expect(
        await client.query(
          `SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'account' AND column_name = 'staff_tag'`,
        ),
      ).toEqual([]);
    } finally {
      for (const id of Object.values(ids)) {
        await client.execute('DELETE FROM account WHERE id = $1', [id]);
      }
      await closeIfPossible(sql);
    }
  });

  test('runs the staff_tag migration once when 8 boots race', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    const id = crypto.randomUUID();
    try {
      await migrateAuthSchema(client);
      await client.execute('ALTER TABLE account ADD COLUMN IF NOT EXISTS staff_tag text');
      await client.execute(
        `INSERT INTO account
           (id, role, staff_tag, lightning_address_verified, forum_laws_dismissed, created_at)
         VALUES ($1, 'moderator', 'software_developer', false, false, $2)`,
        [id, new Date()],
      );

      const statement = AUTH_SCHEMA_SQL.find((s) => s.includes('$staff_tag_role$'));
      expect(statement).toBeDefined();
      if (statement === undefined) {
        throw new Error('staff_tag migration statement is missing');
      }

      const boots = Array.from({ length: 8 }, () =>
        createBunSqlClient(String(databaseUrl), { max: 1 }),
      );
      try {
        const results = await Promise.allSettled(
          boots.map(({ client: bootClient }) => bootClient.execute(statement)),
        );
        expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
      } finally {
        await Promise.all(boots.map(({ sql: bootSql }) => closeIfPossible(bootSql)));
      }

      const rows = await client.query<{ role: string }>('SELECT role FROM account WHERE id = $1', [
        id,
      ]);
      expect(rows[0]?.role).toBe('software_developer');
      expect(
        await client.query(
          `SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'account' AND column_name = 'staff_tag'`,
        ),
      ).toEqual([]);
    } finally {
      await client.execute('DELETE FROM account WHERE id = $1', [id]);
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresAuthStore spark pubkey', () => {
  test('claim, verify, unique index, username freeze, and db_change', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateAuthSchema(client);
      await migrateDbChangeSchema(client);

      const store = new PostgresAuthStore(client);
      const hex64 = (): string =>
        `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
      const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      const usernameA = `spark_a_${stamp}`;
      const usernameB = `spark_b_${stamp}`;
      const pubkey = `02${hex64()}`;
      const idA = crypto.randomUUID();
      const idB = crypto.randomUUID();
      const viewA = hex64();
      const viewB = hex64();

      await store.createAccount({
        id: idA,
        linkingKey: null,
        role: 'basis',
        name: null,
        username: usernameA,
        location: null,
        forumLawsDismissed: false,
        viewKey: viewA,
        createdAt: Date.now(),
        rulesAgreedAt: null,
        walletRequired: true,
      });
      await store.createAccount({
        id: idB,
        linkingKey: null,
        role: 'basis',
        name: null,
        username: usernameB,
        location: null,
        forumLawsDismissed: false,
        viewKey: viewB,
        createdAt: Date.now() + 1,
        rulesAgreedAt: null,
        walletRequired: true,
      });

      const claimA = await store.claimSparkPubkey(idA, pubkey);
      expect(claimA?.wrote).toBe(true);
      expect(claimA?.account.sparkPubkey).toBe(pubkey);
      expect(claimA?.account.sparkPubkeyVerifiedAt ?? null).toBeNull();
      const addressRows = await client.query<{ spark_address: string | null }>(
        'SELECT spark_address FROM account WHERE id = $1',
        [idA],
      );
      expect(addressRows[0]?.spark_address).toBe(encodeSparkAddress(pubkey));

      const claimB = await store.claimSparkPubkey(idB, pubkey);
      expect(claimB?.wrote).toBe(true);
      expect(claimB?.account.sparkPubkey).toBe(pubkey);

      const now = Date.now();
      expect(await store.markSparkPubkeyVerified(idA, pubkey, usernameA, now)).toBe(true);
      expect(await store.markSparkPubkeyVerified(idA, pubkey, usernameA, now + 1)).toBe(false);
      expect(await store.markSparkPubkeyVerified(idB, pubkey, usernameB, now + 2)).toBe(false);

      const verified = await store.getAccount(idA);
      expect(verified?.sparkPubkey).toBe(pubkey);
      expect(typeof verified?.sparkPubkeyVerifiedAt).toBe('number');
      const stillUnverified = await store.getAccount(idB);
      expect(stillUnverified?.sparkPubkey).toBe(pubkey);
      expect(stillUnverified?.sparkPubkeyVerifiedAt ?? null).toBeNull();

      if (verified === undefined) {
        throw new Error('expected verified account');
      }
      await store.updateAccount({
        ...verified,
        username: `renamed_${stamp}`,
        name: 'Renamed',
        sparkPubkey: `03${'b'.repeat(64)}`,
        sparkPubkeyVerifiedAt: null,
      });
      const afterUpdate = await store.getAccount(idA);
      expect(afterUpdate?.username).toBe(usernameA);
      expect(afterUpdate?.name).toBe('Renamed');
      expect(afterUpdate?.sparkPubkey).toBe(pubkey);
      expect(typeof afterUpdate?.sparkPubkeyVerifiedAt).toBe('number');

      const changeRows = await client.query<{
        op: string;
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
      }>(
        `SELECT op, before, after
         FROM db_change
         WHERE table_name = 'account'
           AND op = 'UPDATE'
           AND (
             (before ->> 'id' = $1 OR after ->> 'id' = $1)
             OR (before ->> 'id' = $2 OR after ->> 'id' = $2)
           )
         ORDER BY id ASC`,
        [idA, idB],
      );

      const claimChange = changeRows.find(
        (row) =>
          (row.before?.['spark_pubkey'] === null || row.before?.['spark_pubkey'] === undefined) &&
          row.after?.['spark_pubkey'] === pubkey,
      );
      expect(claimChange).toBeDefined();
      expect(claimChange?.after?.['spark_address']).toBe(encodeSparkAddress(pubkey));

      const verifyChange = changeRows.find(
        (row) =>
          (row.before?.['spark_pubkey_verified_at'] === null ||
            row.before?.['spark_pubkey_verified_at'] === undefined) &&
          row.after?.['spark_pubkey_verified_at'] !== null &&
          row.after?.['spark_pubkey_verified_at'] !== undefined &&
          row.after?.['spark_pubkey'] === pubkey,
      );
      expect(verifyChange).toBeDefined();
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('backfillSparkAddresses fills missing and stale addresses; the CHECK refuses bad ones', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateAuthSchema(client);

      const store = new PostgresAuthStore(client);
      const hex64 = (): string =>
        `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
      const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      for (const [index, id] of ids.entries()) {
        await store.createAccount({
          id,
          linkingKey: null,
          role: 'basis',
          name: null,
          username: `spark_fill_${index}_${stamp}`,
          location: null,
          forumLawsDismissed: false,
          viewKey: hex64(),
          createdAt: Date.now() + index,
          rulesAgreedAt: null,
          walletRequired: true,
        });
      }
      const [missingId, staleId, keylessId] = ids as [string, string, string];
      const missingKey = `02${hex64()}`;
      const staleKey = `03${hex64()}`;
      await client.execute('UPDATE account SET spark_pubkey = $2 WHERE id = $1', [
        missingId,
        missingKey,
      ]);
      await client.execute(
        'UPDATE account SET spark_pubkey = $2, spark_address = $3 WHERE id = $1',
        [staleId, staleKey, encodeSparkAddress(missingKey)],
      );

      expect(await backfillSparkAddresses(client)).toBeGreaterThanOrEqual(2);
      const rows = await client.query<{ id: string; spark_address: string | null }>(
        'SELECT id::text AS id, spark_address FROM account WHERE id = ANY($1::uuid[])',
        [postgresTextArrayLiteral(ids)],
      );
      const addressOf = (id: string): string | null | undefined =>
        rows.find((row) => row.id === id)?.spark_address;
      expect(addressOf(missingId)).toBe(encodeSparkAddress(missingKey));
      expect(addressOf(staleId)).toBe(encodeSparkAddress(staleKey));
      expect(addressOf(keylessId)).toBeNull();

      let keyless: unknown;
      try {
        await client.execute('UPDATE account SET spark_address = $2 WHERE id = $1', [
          keylessId,
          encodeSparkAddress(missingKey),
        ]);
      } catch (error) {
        keyless = error;
      }
      expect(sqlState(keyless)).toBe('23514');

      let malformed: unknown;
      try {
        await client.execute('UPDATE account SET spark_address = $2 WHERE id = $1', [
          missingId,
          'spark1notanaddress',
        ]);
      } catch (error) {
        malformed = error;
      }
      expect(sqlState(malformed)).toBe('23514');
    } finally {
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresAuthStore social recovery', () => {
  const hex64 = (): string =>
    `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
  const walletKey = (): string => `02${hex64()}`;

  const setup = async (): Promise<{
    client: SqlClient;
    mergeDb: MergeDb;
    sql: SQL;
    store: PostgresAuthStore;
    push: PostgresPushStore;
  }> => {
    const { client, mergeDb, sql } = createBunSqlClient(databaseUrl);
    await migrateAuthSchema(client);
    await migratePushSchema(client);
    await migrateAuthSchema(client);
    await migratePushSchema(client);
    await migrateDbChangeSchema(client);
    return {
      client,
      mergeDb,
      sql,
      store: new PostgresAuthStore(client, mergeDb),
      push: new PostgresPushStore(client),
    };
  };

  /** An account whose verified wallet key is `sparkPubkey`. */
  async function recoverable(
    store: PostgresAuthStore,
    sparkPubkey: string,
  ): Promise<{ id: string; username: string }> {
    const id = crypto.randomUUID();
    const username = `recovery_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
    await store.createAccount({
      id,
      linkingKey: null,
      role: 'basis',
      name: null,
      username,
      location: null,
      forumLawsDismissed: false,
      viewKey: hex64(),
      createdAt: Date.now(),
      rulesAgreedAt: null,
      walletRequired: true,
    });
    await store.claimSparkPubkey(id, sparkPubkey);
    expect(await store.markSparkPubkeyVerified(id, sparkPubkey, username, Date.now())).toBe(true);
    return { id, username };
  }

  function recoveryChallenge(accountId: string, now: number): PasskeyChallenge {
    return {
      id: hex64(),
      type: 'recovery',
      challenge: `challenge-${hex64()}`,
      accountId,
      consumed: false,
      createdAt: now,
    };
  }

  function pendingRecovery(
    accountId: string,
    oldSparkPubkey: string,
    newSparkPubkey: string,
    now: number,
  ): PendingRecovery {
    return {
      accountId,
      oldSparkPubkey,
      newSparkPubkey,
      credentialId: `credential-${hex64()}`,
      publicKey: Uint8Array.of(4, 5, 6),
      signCount: 0,
      createdAt: now,
      forwardedAt: null,
    };
  }

  /** Begin and finish one recovery; returns the stored pending recovery and its challenge. */
  async function stored(
    store: PostgresAuthStore,
    accountId: string,
    oldSparkPubkey: string,
    now: number,
  ): Promise<{ pending: PendingRecovery; challenge: PasskeyChallenge }> {
    const challenge = recoveryChallenge(accountId, now);
    expect(await store.startRecoveryChallenge({ accountId, oldSparkPubkey, challenge, now })).toBe(
      'started',
    );
    const pending = pendingRecovery(accountId, oldSparkPubkey, walletKey(), now);
    expect(await store.storePendingRecovery({ challengeId: challenge.id, pending, now })).toBe(
      'stored',
    );
    return { pending, challenge };
  }

  async function countRows(client: SqlClient, table: string, accountId: string): Promise<number> {
    const rows = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE account_id = $1`,
      [accountId],
    );
    return rows[0]?.n ?? -1;
  }

  test('begin, finish, admission, and commit replace the passkey, sessions, push, and wallet key', async () => {
    const { client, sql, store, push } = await setup();
    try {
      const oldKey = walletKey();
      const { id, username } = await recoverable(store, oldKey);
      const before = await store.getAccount(id);
      await store.createPasskeyCredential({
        credentialId: `login-${hex64()}`,
        publicKey: Uint8Array.of(1, 2, 3),
        signCount: 7,
        accountId: id,
        createdAt: Date.now(),
      });
      await store.createSession({ token: hex64(), accountId: id, createdAt: Date.now() });
      await push.upsertSubscription({
        endpoint: `https://push.example/${hex64()}`,
        accountId: id,
        p256dh: 'p',
        auth: 'a',
        createdAt: new Date(),
        sessionToken: null,
      });
      const now = Date.now();

      const first = recoveryChallenge(id, now);
      expect(
        await store.startRecoveryChallenge({
          accountId: id,
          oldSparkPubkey: oldKey,
          challenge: first,
          now,
        }),
      ).toBe('started');
      expect(await store.getPasskeyChallenge(first.id)).toEqual({ ...first, requestedName: null });
      const { pending, challenge } = await stored(store, id, oldKey, now);
      expect((await store.getPasskeyChallenge(first.id))?.consumed).toBe(true);
      expect((await store.getPasskeyChallenge(challenge.id))?.consumed).toBe(true);
      expect(
        await store.storePendingRecovery({ challengeId: challenge.id, pending, now: now + 1 }),
      ).toBe('same');
      expect(await store.getPendingRecovery(id, now)).toEqual(pending);
      expect(await store.getPendingRecoveryByNewSparkPubkey(pending.newSparkPubkey, now)).toEqual(
        pending,
      );
      expect(await store.getPendingRecoveryByCredentialId(pending.credentialId, now)).toEqual(
        pending,
      );
      expect(await store.getPendingRecovery(id, now + CHALLENGE_TTL_MS + 1)).toBeUndefined();

      const admission = {
        newSparkPubkey: pending.newSparkPubkey,
        oldSparkPubkey: oldKey,
        now: now + 2,
      };
      expect(await store.markRecoveryForwarded({ ...admission, username: 'someone' })).toBe(
        undefined,
      );
      const forwarded = await store.markRecoveryForwarded({ ...admission, username });
      expect(forwarded).toEqual({ ...pending, forwardedAt: now + 2 });
      expect(await store.markRecoveryForwarded({ ...admission, username })).toBeUndefined();
      expect(await store.getPendingRecovery(id, now + 100 * CHALLENGE_TTL_MS)).toEqual(forwarded);
      expect(
        await store.startRecoveryChallenge({
          accountId: id,
          oldSparkPubkey: oldKey,
          challenge: recoveryChallenge(id, now + 3),
          now: now + 3,
        }),
      ).toBe('forwarded');

      expect(
        await store.commitRecovery({
          accountId: id,
          newSparkPubkey: pending.newSparkPubkey,
          now: now + 4,
        }),
      ).toBe('committed');

      const credentials = await client.query<{ credential_id: string; public_key: Uint8Array }>(
        'SELECT credential_id, public_key FROM passkey_credential WHERE account_id = $1',
        [id],
      );
      expect(credentials.map((row) => row.credential_id)).toEqual([pending.credentialId]);
      expect([...new Uint8Array(credentials[0]?.public_key ?? [])]).toEqual([...pending.publicKey]);
      expect(await countRows(client, 'auth_session', id)).toBe(0);
      expect(await countRows(client, 'push_subscription', id)).toBe(0);
      expect(await countRows(client, 'pending_recovery', id)).toBe(0);
      const account = await client.query<{
        spark_pubkey: string;
        spark_address: string;
        wallet_required: boolean;
        username: string;
      }>(
        'SELECT spark_pubkey, spark_address, wallet_required, username FROM account WHERE id = $1',
        [id],
      );
      expect(account[0]).toEqual({
        spark_pubkey: pending.newSparkPubkey,
        spark_address: encodeSparkAddress(pending.newSparkPubkey),
        wallet_required: true,
        username,
      });
      expect((await store.getAccount(id))?.sparkPubkeyVerifiedAt).toBe(
        before?.sparkPubkeyVerifiedAt,
      );
      const previous = {
        accountId: id,
        sparkPubkey: oldKey,
        sparkAddress: encodeSparkAddress(oldKey),
        replacedAt: now + 4,
      };
      expect(await store.listPreviousWallets(id)).toEqual([previous]);
      expect(await store.getPreviousWalletBySparkPubkey(oldKey)).toEqual(previous);
      expect(
        await store.commitRecovery({
          accountId: id,
          newSparkPubkey: pending.newSparkPubkey,
          now: now + 5,
        }),
      ).toBe('gone');
      expect(
        await store.startRecoveryChallenge({
          accountId: id,
          oldSparkPubkey: oldKey,
          challenge: recoveryChallenge(id, now + 6),
          now: now + 6,
        }),
      ).toBe('changed');
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('the finish refuses a used challenge, a second pending, and a key or credential in use', async () => {
    const { client, sql, store } = await setup();
    try {
      const oldKey = walletKey();
      const { id } = await recoverable(store, oldKey);
      const other = await recoverable(store, walletKey());
      const now = Date.now();

      const expired = recoveryChallenge(id, now - CHALLENGE_TTL_MS - 1);
      await store.startRecoveryChallenge({
        accountId: id,
        oldSparkPubkey: oldKey,
        challenge: expired,
        now: now - CHALLENGE_TTL_MS - 1,
      });
      expect(
        await store.storePendingRecovery({
          challengeId: expired.id,
          pending: pendingRecovery(id, oldKey, walletKey(), now),
          now,
        }),
      ).toBe('challenge');

      const open = recoveryChallenge(id, now);
      await store.startRecoveryChallenge({
        accountId: id,
        oldSparkPubkey: oldKey,
        challenge: open,
        now,
      });
      const finish = (pending: PendingRecovery) =>
        store.storePendingRecovery({ challengeId: open.id, pending, now });
      expect(await finish(pendingRecovery(id, walletKey(), walletKey(), now))).toBe('changed');
      const otherAccount = await store.getAccount(other.id);
      expect(await finish(pendingRecovery(id, oldKey, otherAccount?.sparkPubkey ?? '', now))).toBe(
        'key',
      );
      const loginId = `login-${hex64()}`;
      await store.createPasskeyCredential({
        credentialId: loginId,
        publicKey: Uint8Array.of(1),
        signCount: 0,
        accountId: other.id,
        createdAt: now,
      });
      expect(
        await finish({ ...pendingRecovery(id, oldKey, walletKey(), now), credentialId: loginId }),
      ).toBe('credential');
      expect((await store.getPasskeyChallenge(open.id))?.consumed).toBe(false);
      const first = pendingRecovery(id, oldKey, walletKey(), now);
      expect(await finish(first)).toBe('stored');
      expect(await finish(pendingRecovery(id, oldKey, walletKey(), now))).toBe('challenge');

      const next = recoveryChallenge(id, now);
      await client.query(
        `INSERT INTO passkey_challenge (id, type, challenge, account_id, consumed, created_at)
         VALUES ($1, 'recovery', $2, $3, false, to_timestamp($4::double precision / 1000.0))`,
        [next.id, next.challenge, id, now],
      );
      expect(
        await store.storePendingRecovery({
          challengeId: next.id,
          pending: pendingRecovery(id, oldKey, walletKey(), now),
          now,
        }),
      ).toBe('pending');
      const otherFinish = await stored(store, other.id, otherAccount?.sparkPubkey ?? '', now);
      expect(
        await store.storePendingRecovery({
          challengeId: next.id,
          pending: {
            ...pendingRecovery(id, oldKey, walletKey(), now),
            credentialId: first.credentialId,
          },
          now,
        }),
      ).toBe('pending');
      expect(otherFinish.pending.accountId).toBe(other.id);

      expect(await store.dropPendingRecovery({ accountId: id, newSparkPubkey: walletKey() })).toBe(
        false,
      );
      expect(
        await store.dropPendingRecovery({ accountId: id, newSparkPubkey: first.newSparkPubkey }),
      ).toBe(true);
      expect(await store.getPendingRecovery(id, now)).toBeUndefined();
      expect(
        await store.storePendingRecovery({
          challengeId: next.id,
          pending: pendingRecovery(id, oldKey, otherFinish.pending.newSparkPubkey, now),
          now,
        }),
      ).toBe('key');
      expect(
        await store.storePendingRecovery({
          challengeId: next.id,
          pending: {
            ...pendingRecovery(id, oldKey, walletKey(), now),
            credentialId: otherFinish.pending.credentialId,
          },
          now,
        }),
      ).toBe('credential');
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('a commit after the account left the old verified key drops the pending recovery', async () => {
    const { client, sql, store } = await setup();
    try {
      const oldKey = walletKey();
      const { id, username } = await recoverable(store, oldKey);
      const now = Date.now();
      const { pending } = await stored(store, id, oldKey, now);
      expect(
        await store.markRecoveryForwarded({
          newSparkPubkey: pending.newSparkPubkey,
          oldSparkPubkey: oldKey,
          username,
          now,
        }),
      ).toBeDefined();
      await client.query('UPDATE account SET spark_pubkey_verified_at = NULL WHERE id = $1', [id]);
      expect(
        await store.commitRecovery({ accountId: id, newSparkPubkey: pending.newSparkPubkey, now }),
      ).toBe('changed');
      expect(await countRows(client, 'pending_recovery', id)).toBe(0);
      expect((await store.getAccount(id))?.sparkPubkey).toBe(oldKey);
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('parallel commits commit once and parallel finishes of one challenge store once', async () => {
    const { client, sql, store } = await setup();
    try {
      const oldKey = walletKey();
      const { id, username } = await recoverable(store, oldKey);
      const now = Date.now();
      const challenge = recoveryChallenge(id, now);
      await store.startRecoveryChallenge({ accountId: id, oldSparkPubkey: oldKey, challenge, now });
      const pending = pendingRecovery(id, oldKey, walletKey(), now);
      const finishes = await Promise.all([
        store.storePendingRecovery({ challengeId: challenge.id, pending, now }),
        store.storePendingRecovery({ challengeId: challenge.id, pending, now }),
      ]);
      expect([...finishes].sort()).toEqual(['same', 'stored']);
      expect(await countRows(client, 'pending_recovery', id)).toBe(1);

      await store.markRecoveryForwarded({
        newSparkPubkey: pending.newSparkPubkey,
        oldSparkPubkey: oldKey,
        username,
        now,
      });
      const commits = await Promise.all([
        store.commitRecovery({ accountId: id, newSparkPubkey: pending.newSparkPubkey, now }),
        store.commitRecovery({ accountId: id, newSparkPubkey: pending.newSparkPubkey, now }),
      ]);
      expect([...commits].sort()).toEqual(['committed', 'gone']);
      expect(await countRows(client, 'previous_wallet', id)).toBe(1);
      expect(await countRows(client, 'passkey_credential', id)).toBe(1);
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('a parallel begin and admission serialize on the account lock', async () => {
    const { client, sql, store } = await setup();
    try {
      for (let round = 0; round < 4; round += 1) {
        const oldKey = walletKey();
        const { id, username } = await recoverable(store, oldKey);
        const now = Date.now();
        const { pending } = await stored(store, id, oldKey, now);
        const [begun, admitted] = await Promise.all([
          store.startRecoveryChallenge({
            accountId: id,
            oldSparkPubkey: oldKey,
            challenge: recoveryChallenge(id, now + 1),
            now: now + 1,
          }),
          store.markRecoveryForwarded({
            newSparkPubkey: pending.newSparkPubkey,
            oldSparkPubkey: oldKey,
            username,
            now: now + 1,
          }),
        ]);
        const rows = await client.query<{ forwarded_at: Date | null }>(
          'SELECT forwarded_at FROM pending_recovery WHERE account_id = $1',
          [id],
        );
        if (admitted === undefined) {
          expect(begun).toBe('started');
          expect(rows).toEqual([]);
        } else {
          expect(begun).toBe('forwarded');
          expect(rows).toHaveLength(1);
          expect(rows[0]?.forwarded_at).not.toBeNull();
        }
      }
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('shares are stored per wallet key, logged only as SHA-256, and dropped with their previous wallet', async () => {
    const { client, sql, store } = await setup();
    try {
      const oldKey = walletKey();
      const { id, username } = await recoverable(store, oldKey);
      const firstShare = crypto.getRandomValues(new Uint8Array(64));
      const secondShare = crypto.getRandomValues(new Uint8Array(64));
      const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
      const sha256OfBytea = (bytes: Uint8Array): string =>
        createHash('sha256')
          .update(`\\x${hexOf(bytes)}`, 'utf8')
          .digest('hex');
      const marker = await client.query<{ id: string }>(
        'SELECT coalesce(max(id), 0)::text AS id FROM db_change',
      );
      const now = Date.now();
      expect(await store.hasRecoveryShareForVerifiedWallet(id)).toBe(false);
      expect(
        await store.putRecoveryShare({
          accountId: id,
          sparkPubkey: walletKey(),
          ciphertext: firstShare,
          now,
        }),
      ).toBe('changed');
      expect(
        await store.putRecoveryShare({
          accountId: id,
          sparkPubkey: oldKey,
          ciphertext: firstShare,
          now,
        }),
      ).toBe('stored');
      expect(await store.hasRecoveryShareForVerifiedWallet(id)).toBe(true);
      expect(
        await store.putRecoveryShare({
          accountId: id,
          sparkPubkey: oldKey,
          ciphertext: secondShare,
          now: now + 1,
        }),
      ).toBe('replaced');
      const shares = await client.query<{ recovery_share_ciphertext: Uint8Array }>(
        'SELECT recovery_share_ciphertext FROM recovery_share WHERE account_id = $1',
        [id],
      );
      expect(shares.map((row) => new Uint8Array(row.recovery_share_ciphertext))).toEqual([
        secondShare,
      ]);

      const { pending } = await stored(store, id, oldKey, now);
      await store.markRecoveryForwarded({
        newSparkPubkey: pending.newSparkPubkey,
        oldSparkPubkey: oldKey,
        username,
        now,
      });
      await store.commitRecovery({ accountId: id, newSparkPubkey: pending.newSparkPubkey, now });
      expect(await store.hasRecoveryShareForVerifiedWallet(id)).toBe(false);
      expect(await countRows(client, 'recovery_share', id)).toBe(1);
      expect(await store.dropPreviousWallet(id, pending.newSparkPubkey)).toBe(false);
      expect(await countRows(client, 'recovery_share', id)).toBe(1);
      expect(await store.dropPreviousWallet(id, oldKey)).toBe(true);
      expect(await countRows(client, 'recovery_share', id)).toBe(0);
      expect(await countRows(client, 'previous_wallet', id)).toBe(0);
      expect(await store.dropPreviousWallet(id, oldKey)).toBe(false);

      const changes = await client.query<{
        op: string;
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
      }>(
        `SELECT op, before, after FROM db_change
         WHERE table_name = 'recovery_share' AND id > $1::bigint
           AND coalesce(after ->> 'account_id', before ->> 'account_id') = $2
         ORDER BY id ASC`,
        [marker[0]?.id ?? '0', id],
      );
      expect(changes.map((row) => row.op)).toEqual(['INSERT', 'UPDATE', 'DELETE']);
      expect(changes[0]?.after?.['recovery_share_ciphertext']).toBe(sha256OfBytea(firstShare));
      expect(changes[1]?.before?.['recovery_share_ciphertext']).toBe(sha256OfBytea(firstShare));
      expect(changes[1]?.after?.['recovery_share_ciphertext']).toBe(sha256OfBytea(secondShare));
      expect(changes[2]?.before?.['recovery_share_ciphertext']).toBe(sha256OfBytea(secondShare));
      const dump = JSON.stringify(changes);
      for (const share of [firstShare, secondShare]) {
        expect(dump.includes(hexOf(share))).toBe(false);
      }
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('held-share boxes: put, list, delete, refusals, db_change hashes, recovery commit, and account delete', async () => {
    const { client, sql, store } = await setup();
    try {
      const oldKey = walletKey();
      const holder = await recoverable(store, oldKey);
      const other = await recoverable(store, walletKey());
      const box = (): string => hex64().slice(0, 32);
      const bytes = (fill: number): Uint8Array => {
        const out = new Uint8Array(40).fill(fill);
        out[0] = 1;
        return out;
      };
      const hexOf = (value: Uint8Array): string => Buffer.from(value).toString('hex');
      const sha256OfBytea = (value: Uint8Array): string =>
        createHash('sha256')
          .update(`\\x${hexOf(value)}`, 'utf8')
          .digest('hex');
      const marker = await client.query<{ id: string }>(
        'SELECT coalesce(max(id), 0)::text AS id FROM db_change',
      );
      const now = Date.now();
      const first = box();
      const second = box();
      const put = (accountId: string, id: string, ciphertext: Uint8Array, at: number, limit = 50) =>
        store.putHeldShareBox({ accountId, id, ciphertext, now: at, limit });

      expect(await put(holder.id, second, bytes(2), now)).toBe('created');
      expect(await put(holder.id, first, bytes(3), now + 1)).toBe('created');
      expect(await put(holder.id, second, bytes(4), now + 2)).toBe('replaced');
      expect(await put(other.id, first, bytes(5), now)).toBe('taken');
      expect(await put(holder.id, box(), bytes(6), now, 2)).toBe('full');
      expect(await store.listHeldShareBoxes(holder.id)).toEqual([
        { id: second, ciphertext: bytes(4), createdAt: now, updatedAt: now + 2 },
        { id: first, ciphertext: bytes(3), createdAt: now + 1, updatedAt: now + 1 },
      ]);
      expect(await store.listHeldShareBoxes(other.id)).toEqual([]);
      await store.deleteHeldShareBox(other.id, first);
      expect(await countRows(client, 'held_share_box', holder.id)).toBe(2);
      await store.deleteHeldShareBox(holder.id, first);
      await store.deleteHeldShareBox(holder.id, first);
      expect(await countRows(client, 'held_share_box', holder.id)).toBe(1);
      await expect(
        client.execute(
          `INSERT INTO held_share_box (id, account_id, ciphertext, created_at, updated_at)
           VALUES ($1, $2, $3, now(), now())`,
          [box(), holder.id, new Uint8Array(40).fill(2)],
        ),
      ).rejects.toThrow();

      // The recovery commit keeps the account id, so the boxes stay.
      const { pending } = await stored(store, holder.id, oldKey, now);
      await store.markRecoveryForwarded({
        newSparkPubkey: pending.newSparkPubkey,
        oldSparkPubkey: oldKey,
        username: holder.username,
        now,
      });
      expect(
        await store.commitRecovery({
          accountId: holder.id,
          newSparkPubkey: pending.newSparkPubkey,
          now,
        }),
      ).toBe('committed');
      expect((await store.listHeldShareBoxes(holder.id)).map((row) => row.id)).toEqual([second]);

      const changes = await client.query<{
        op: string;
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
      }>(
        `SELECT op, before, after FROM db_change
         WHERE table_name = 'held_share_box' AND id > $1::bigint
           AND coalesce(after ->> 'account_id', before ->> 'account_id') = $2
         ORDER BY id ASC`,
        [marker[0]?.id ?? '0', holder.id],
      );
      expect(changes.map((row) => row.op)).toEqual(['INSERT', 'INSERT', 'UPDATE', 'DELETE']);
      expect(changes[0]?.after?.['ciphertext']).toBe(sha256OfBytea(bytes(2)));
      expect(changes[2]?.before?.['ciphertext']).toBe(sha256OfBytea(bytes(2)));
      expect(changes[2]?.after?.['ciphertext']).toBe(sha256OfBytea(bytes(4)));
      expect(changes[3]?.before?.['ciphertext']).toBe(sha256OfBytea(bytes(3)));
      const dump = JSON.stringify(changes);
      for (const value of [bytes(2), bytes(3), bytes(4)]) {
        expect(dump.includes(hexOf(value))).toBe(false);
      }

      // Deleting a plain account takes its boxes with it.
      const plain = await recoverable(store, walletKey());
      expect(await put(plain.id, box(), bytes(7), now)).toBe('created');
      await store.deleteAccount(plain.id);
      expect(await countRows(client, 'held_share_box', plain.id)).toBe(0);
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('mergeAccounts deletes the merged account social recovery rows', async () => {
    const { client, mergeDb, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateMergeTables(client);
      await migrateDbChangeSchema(client);
      const store = new PostgresAuthStore(client, mergeDb);
      const oldKey = walletKey();
      const from = await recoverable(store, oldKey);
      const into = await recoverable(store, walletKey());
      const now = Date.now();
      const { pending } = await stored(store, from.id, oldKey, now);
      await store.markRecoveryForwarded({
        newSparkPubkey: pending.newSparkPubkey,
        oldSparkPubkey: oldKey,
        username: from.username,
        now,
      });
      await store.commitRecovery({
        accountId: from.id,
        newSparkPubkey: pending.newSparkPubkey,
        now,
      });
      await store.putRecoveryShare({
        accountId: from.id,
        sparkPubkey: pending.newSparkPubkey,
        ciphertext: new Uint8Array(40).fill(1),
        now,
      });
      await stored(store, from.id, pending.newSparkPubkey, now + 1);
      await store.putRecoveryShare({
        accountId: into.id,
        sparkPubkey: (await store.getAccount(into.id))?.sparkPubkey ?? '',
        ciphertext: new Uint8Array(40).fill(2),
        now,
      });
      const droppedBox = hex64().slice(0, 32);
      const keptBox = hex64().slice(0, 32);
      const boxBytes = new Uint8Array(40).fill(1);
      expect(
        await store.putHeldShareBox({
          accountId: from.id,
          id: droppedBox,
          ciphertext: boxBytes,
          now,
          limit: 50,
        }),
      ).toBe('created');
      expect(
        await store.putHeldShareBox({
          accountId: into.id,
          id: keptBox,
          ciphertext: boxBytes,
          now: now + 1,
          limit: 50,
        }),
      ).toBe('created');
      for (const table of ['recovery_share', 'pending_recovery', 'previous_wallet']) {
        expect(await countRows(client, table, from.id)).toBe(1);
      }

      expect(
        (await mergeAccounts(mergeDb, { from: from.id, into: into.id, verify: 'into' })).ok,
      ).toBe(true);

      for (const table of ['pending_recovery', 'previous_wallet']) {
        expect(await countRows(client, table, into.id)).toBe(0);
      }
      expect(await countRows(client, 'recovery_share', into.id)).toBe(1);
      expect(await store.hasRecoveryShareForVerifiedWallet(into.id)).toBe(true);
      const challenges = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM passkey_challenge WHERE account_id = $1 AND type = 'recovery'`,
        [into.id],
      );
      expect(challenges[0]?.n).toBe(0);
      // The merged account's held-share boxes are dropped: the survivor
      // could never open them. The survivor's own box stays.
      expect((await store.listHeldShareBoxes(into.id)).map((row) => row.id)).toEqual([keptBox]);
      const dropped = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM held_share_box WHERE id = $1',
        [droppedBox],
      );
      expect(dropped[0]?.n).toBe(0);
      expect(await store.getAccount(from.id)).toBeUndefined();
    } finally {
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresAuthStore setUsername', () => {
  test('ok, previous, frozen, taken, missing, and concurrent writes chain previous', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateAuthSchema(client);

      const store = new PostgresAuthStore(client);
      const hex64 = (): string =>
        `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
      const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      const original = `cas_orig_${stamp}`.slice(0, 32);
      const firstNew = `cas_a_${stamp}`.slice(0, 32);
      const secondNew = `cas_b_${stamp}`.slice(0, 32);
      const takenName = `cas_taken_${stamp}`.slice(0, 32);
      const id = crypto.randomUUID();
      const otherId = crypto.randomUUID();
      const frozenId = crypto.randomUUID();
      const pubkey = `02${hex64()}`;

      await store.createAccount({
        id,
        linkingKey: null,
        role: 'basis',
        name: null,
        location: null,
        forumLawsDismissed: false,
        viewKey: hex64(),
        createdAt: Date.now(),
        rulesAgreedAt: null,
      });
      expect(await store.setUsername(id, original)).toEqual({ ok: true, previous: null });
      expect(await store.setUsername(id, firstNew)).toEqual({ ok: true, previous: original });
      expect((await store.getAccount(id))?.username).toBe(firstNew);

      await store.createAccount({
        id: otherId,
        linkingKey: null,
        role: 'basis',
        name: null,
        username: takenName,
        location: null,
        forumLawsDismissed: false,
        viewKey: hex64(),
        createdAt: Date.now() + 1,
        rulesAgreedAt: null,
      });
      expect(await store.setUsername(id, takenName)).toEqual({ ok: false, reason: 'taken' });
      expect((await store.getAccount(id))?.username).toBe(firstNew);

      await store.createAccount({
        id: frozenId,
        linkingKey: null,
        role: 'basis',
        name: null,
        username: `cas_frz_${stamp}`.slice(0, 32),
        location: null,
        forumLawsDismissed: false,
        viewKey: hex64(),
        createdAt: Date.now() + 2,
        rulesAgreedAt: null,
        walletRequired: true,
      });
      const frozenName = (await store.getAccount(frozenId))?.username ?? '';
      expect((await store.claimSparkPubkey(frozenId, pubkey))?.wrote).toBe(true);
      expect(await store.markSparkPubkeyVerified(frozenId, pubkey, frozenName, Date.now())).toBe(
        true,
      );
      expect(await store.setUsername(frozenId, secondNew)).toEqual({
        ok: false,
        reason: 'frozen',
      });
      expect((await store.getAccount(frozenId))?.username).toBe(frozenName);

      expect(await store.setUsername(crypto.randomUUID(), original)).toEqual({
        ok: false,
        reason: 'missing',
      });

      await store.setUsername(id, original);
      const [left, right] = await Promise.all([
        store.setUsername(id, firstNew),
        store.setUsername(id, secondNew),
      ]);
      expect(left.ok).toBe(true);
      expect(right.ok).toBe(true);
      if (!left.ok || !right.ok) {
        throw new Error('expected both concurrent setUsername calls to succeed');
      }
      expect(new Set([left.previous, right.previous]).size).toBe(2);
      expect([left.previous, right.previous].filter((value) => value === original)).toHaveLength(1);
      const stored = await store.getAccount(id);
      expect(stored?.username === firstNew || stored?.username === secondNew).toBe(true);
    } finally {
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresAuthStore renameUsername', () => {
  test('renames a verified account and maps a taken handle', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateAuthSchema(client);

      const store = new PostgresAuthStore(client);
      const hex64 = (): string =>
        `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
      const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      const original = `rn_orig_${stamp}`.slice(0, 32);
      const renamed = `rn_next_${stamp}`.slice(0, 32);
      const other = `rn_other_${stamp}`.slice(0, 32);
      const id = crypto.randomUUID();
      const otherId = crypto.randomUUID();
      const pubkey = `02${hex64()}`;

      await store.createAccount({
        id,
        linkingKey: null,
        role: 'basis',
        name: null,
        username: original,
        location: null,
        forumLawsDismissed: false,
        viewKey: hex64(),
        createdAt: Date.now(),
        rulesAgreedAt: null,
        walletRequired: true,
      });
      expect((await store.claimSparkPubkey(id, pubkey))?.wrote).toBe(true);
      expect(await store.markSparkPubkeyVerified(id, pubkey, original, Date.now())).toBe(true);

      expect(await store.renameUsername(id, renamed)).toEqual({
        ok: true,
        previous: original,
      });
      expect(await store.getAccount(id)).toMatchObject({
        username: renamed,
        sparkPubkeyVerifiedAt: expect.any(Number),
      });
      expect(await store.getAccountByUsername(original)).toBeUndefined();

      await store.createAccount({
        id: otherId,
        linkingKey: null,
        role: 'basis',
        name: null,
        username: other,
        location: null,
        forumLawsDismissed: false,
        viewKey: hex64(),
        createdAt: Date.now() + 1,
        rulesAgreedAt: null,
      });
      expect(await store.renameUsername(id, other)).toEqual({ ok: false, reason: 'taken' });
      expect(await store.renameUsername(crypto.randomUUID(), other)).toEqual({
        ok: false,
        reason: 'missing',
      });
      expect((await store.getAccount(id))?.username).toBe(renamed);
    } finally {
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresSparkInvoiceStore', () => {
  test('issue, re-issue, list open, settle once, and db_change', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateSparkInvoiceSchema(client);
      await migrateDbChangeSchema(client);

      const store = new PostgresSparkInvoiceStore(client);
      const paymentHash = `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
      const invoice = `spark1test${paymentHash}`;
      const issuedAt = new Date(Date.now() - 10 * 60_000);
      const row = {
        paymentHash,
        invoice,
        receiverPubkey: `02${'a'.repeat(64)}`,
        amountSats: 21,
        bolt11: 'lnbc210n1test',
        zapRequest: '{"kind":9734}',
        createdAt: issuedAt,
      };
      expect(await store.issue(row)).toBe(invoice);

      const reissuedAt = new Date(issuedAt.getTime() + 60_000);
      expect(
        await store.issue({ ...row, invoice: `spark1other${paymentHash}`, createdAt: reissuedAt }),
      ).toBe(invoice);

      const open = await store.listOpen(new Date(issuedAt.getTime() - 60_000));
      const mine = open.find((candidate) => candidate.paymentHash === paymentHash);
      expect(mine?.invoice).toBe(invoice);
      expect(mine?.createdAt.getTime()).toBe(reissuedAt.getTime());
      expect(mine?.status).toBe('open');
      expect(mine?.amountSats).toBe(21);
      expect(
        (await store.listOpen(new Date(reissuedAt.getTime() + 1))).some(
          (candidate) => candidate.paymentHash === paymentHash,
        ),
      ).toBe(false);

      expect(await store.markSettled(paymentHash, 'ab'.repeat(16), 'cd'.repeat(32))).toBe(true);
      expect(await store.markSettled(paymentHash, 'ab'.repeat(16), 'cd'.repeat(32))).toBe(false);
      expect(
        (await store.listOpen(new Date(0))).some(
          (candidate) => candidate.paymentHash === paymentHash,
        ),
      ).toBe(false);

      const changes = await client.query<{
        op: string;
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
      }>(
        `SELECT op, before, after
         FROM db_change
         WHERE table_name = 'spark_invoice'
           AND (before ->> 'payment_hash' = $1 OR after ->> 'payment_hash' = $1)
         ORDER BY id ASC`,
        [paymentHash],
      );
      const insert = changes.find((change) => change.op === 'INSERT');
      expect(insert?.before).toBeNull();
      expect(insert?.after?.['invoice']).toBe(invoice);
      const settle = changes.find(
        (change) => change.op === 'UPDATE' && change.after?.['status'] === 'settled',
      );
      expect(settle?.before?.['status']).toBe('open');
      expect(settle?.after?.['receipt_event_id']).toBe('cd'.repeat(32));
      expect(
        changes.some(
          (change) =>
            change.op === 'UPDATE' &&
            change.before?.['status'] === 'open' &&
            change.after?.['status'] === 'open',
        ),
      ).toBe(true);
    } finally {
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresSparkInvoiceStore member invoices', () => {
  test('store, cap per account, list open, notify once, prune, and db_change', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateSparkInvoiceSchema(client);
      await migrateDbChangeSchema(client);

      const store = new PostgresSparkInvoiceStore(client);
      const accountId = crypto.randomUUID();
      const stamp = crypto.randomUUID().replaceAll('-', '');
      const issuedAt = new Date(Date.now() - 10 * 60_000);
      const expiresAt = new Date(issuedAt.getTime() + 60 * 60_000);
      const invoiceAt = (i: number): string => `spark1pay${stamp}${String(i).padStart(2, '0')}`;
      for (let i = 0; i <= MEMBER_SPARK_INVOICE_CAP; i += 1) {
        await store.issueMember({
          invoice: invoiceAt(i),
          kind: 'pay',
          accountId,
          receiverPubkey: `02${'a'.repeat(64)}`,
          amountSats: 21,
          createdAt: new Date(issuedAt.getTime() + i),
          expiresAt,
        });
      }
      const mine = async (now: Date): Promise<string[]> =>
        (await store.listOpenMember(now))
          .filter((row) => row.accountId === accountId)
          .map((row) => row.invoice);
      const open = await mine(issuedAt);
      expect(open).toHaveLength(MEMBER_SPARK_INVOICE_CAP);
      expect(open).not.toContain(invoiceAt(0));
      expect(open[0]).toBe(invoiceAt(1));
      const first = (await store.listOpenMember(issuedAt)).find(
        (row) => row.invoice === invoiceAt(1),
      );
      expect(first).toMatchObject({ kind: 'pay', amountSats: 21, status: 'open', expiresAt });

      expect(await store.claimMemberNotified(invoiceAt(2), expiresAt)).toBe(false);
      expect(await store.claimMemberNotified(invoiceAt(0), issuedAt)).toBe(false);
      expect(await store.claimMemberNotified(invoiceAt(1), issuedAt)).toBe(true);
      expect(await store.claimMemberNotified(invoiceAt(1), issuedAt)).toBe(false);
      expect(await store.releaseMemberNotified(invoiceAt(1))).toBe(true);
      expect(await store.releaseMemberNotified(invoiceAt(1))).toBe(false);
      expect(await mine(issuedAt)).toContain(invoiceAt(1));
      expect(await store.claimMemberNotified(invoiceAt(1), issuedAt)).toBe(true);
      expect(await mine(issuedAt)).not.toContain(invoiceAt(1));
      expect(await mine(expiresAt)).toEqual([]);

      expect(await store.pruneMember(expiresAt)).toBeGreaterThanOrEqual(MEMBER_SPARK_INVOICE_CAP);
      const left = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM member_spark_invoice WHERE account_id = $1`,
        [accountId],
      );
      expect(left[0]?.n).toBe('0');

      const changes = await client.query<{
        op: string;
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
      }>(
        `SELECT op, before, after
         FROM db_change
         WHERE table_name = 'member_spark_invoice'
           AND (before ->> 'account_id' = $1 OR after ->> 'account_id' = $1)
         ORDER BY id ASC`,
        [accountId],
      );
      expect(changes.filter((change) => change.op === 'INSERT')).toHaveLength(
        MEMBER_SPARK_INVOICE_CAP + 1,
      );
      expect(
        changes.some(
          (change) =>
            change.op === 'UPDATE' &&
            change.before?.['status'] === 'open' &&
            change.after?.['status'] === 'notified',
        ),
      ).toBe(true);
      expect(changes.filter((change) => change.op === 'DELETE')).toHaveLength(
        MEMBER_SPARK_INVOICE_CAP + 1,
      );
    } finally {
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresPosStore paid tracking', () => {
  test('migrate an old status check, record invoices, watch, pay once, and db_change', async () => {
    const { client, mergeDb, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateAuthSchema(client);
      await migratePosSchema(client);
      // An install from before the paid status: the old check, added NOT VALID so
      // rows paid by an earlier run do not block it.
      await client.execute(`ALTER TABLE pos_charge DROP CONSTRAINT pos_charge_status_check`);
      await client.execute(
        `ALTER TABLE pos_charge ADD CONSTRAINT pos_charge_status_check
         CHECK (status IN ('pending', 'cancelled', 'expired')) NOT VALID`,
      );
      await migratePosSchema(client);
      await migratePosSchema(client);
      await migrateShopPaymentSchema(client);
      await migrateDbChangeSchema(client);

      const auth = new PostgresAuthStore(client);
      const hex64 = (): string =>
        `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
      const accountId = crypto.randomUUID();
      await auth.createAccount({
        id: accountId,
        linkingKey: null,
        role: 'basis',
        name: null,
        username: `till_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`,
        location: null,
        forumLawsDismissed: false,
        viewKey: hex64(),
        createdAt: Date.now(),
        rulesAgreedAt: null,
        walletRequired: true,
      });

      const store = new PostgresPosStore(client, mergeDb);
      const now = Date.now();
      const chargeId = crypto.randomUUID();
      await store.create({
        id: chargeId,
        accountId,
        amountSats: 21,
        status: 'pending',
        createdAt: new Date(now),
        expiresAt: new Date(now + POS_CHARGE_TTL_MS),
        paidAt: null,
        sparkInvoice: null,
        amountCurrency: null,
        amountText: null,
        fiatUsd: null,
        fiatChf: null,
        fiatEur: null,
        fiatPhp: null,
      });

      const hashA = hex64();
      const hashB = hex64();
      expect(await store.recordInvoice(chargeId, hashA, now + 1)).toEqual({ outcome: 'recorded' });
      expect(await store.recordInvoice(chargeId, hashA, now + 2)).toEqual({
        outcome: 'this_charge',
      });
      expect(await store.recordInvoice(chargeId, hashB, now + POS_CHARGE_TTL_MS)).toEqual({
        outcome: 'not_open',
      });
      expect(await store.recordInvoice(crypto.randomUUID(), hashB, now)).toEqual({
        outcome: 'not_open',
      });
      // Another charge's row holds hashA.
      expect(await store.recordInvoice(crypto.randomUUID(), hashA, now)).toEqual({
        outcome: 'other_payment',
        holderChargeId: chargeId,
        holderPaymentId: null,
      });
      expect(await store.recordInvoice(chargeId, hashB, now + 3)).toEqual({ outcome: 'recorded' });
      // Marked expired by a later read; an invoice issued before expiry still records.
      await store.currentPending(accountId, now + POS_CHARGE_TTL_MS);
      const hashC = hex64();
      expect(await store.recordInvoice(chargeId, hashC, now + 4)).toEqual({ outcome: 'recorded' });

      expect(await store.issueSparkInvoice(chargeId, `spark1a${chargeId}`, now)).toBe(
        `spark1a${chargeId}`,
      );
      expect(await store.issueSparkInvoice(chargeId, `spark1b${chargeId}`, now)).toBe(
        `spark1a${chargeId}`,
      );
      expect(
        await store.issueSparkInvoice(chargeId, `spark1c${chargeId}`, now + POS_CHARGE_TTL_MS),
      ).toBeNull();

      const watched = (await store.listWatched(now)).find((entry) => entry.charge.id === chargeId);
      expect(watched?.paymentHashes).toEqual([hashA, hashB, hashC]);
      expect(watched?.charge.status).toBe('expired');
      expect(watched?.charge.sparkInvoice).toBe(`spark1a${chargeId}`);
      expect(watched?.charge.amountSats).toBe(21);

      const paid = await store.markPaid(chargeId, now + 10_000);
      expect(paid?.status).toBe('paid');
      expect(await store.recordInvoice(chargeId, hex64(), now + 5)).toEqual({
        outcome: 'not_open',
      });
      expect(paid?.paidAt?.getTime()).toBe(now + 10_000);
      expect(await store.markPaid(chargeId, now + 20_000)).toBeNull();
      expect((await store.listWatched(now)).some((entry) => entry.charge.id === chargeId)).toBe(
        false,
      );
      expect(await store.currentPending(accountId, now + 30_000)).toBeNull();
      const listed = await store.listForAccount(accountId, 5);
      expect(listed[0]?.status).toBe('paid');
      expect(listed[0]?.paidAt?.getTime()).toBe(now + 10_000);

      let refused: unknown;
      try {
        await client.execute(`UPDATE pos_charge SET status = 'bogus' WHERE id = $1`, [chargeId]);
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeDefined();

      const changes = await client.query<{
        table_name: string;
        op: string;
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
      }>(
        `SELECT table_name, op, before, after
         FROM db_change
         WHERE (table_name = 'pos_charge'
                AND (before ->> 'id' = $1 OR after ->> 'id' = $1))
            OR (table_name = 'pos_charge_invoice' AND after ->> 'charge_id' = $1)
         ORDER BY id ASC`,
        [chargeId],
      );
      expect(changes.filter((change) => change.table_name === 'pos_charge_invoice').length).toBe(3);
      const pay = changes.find(
        (change) => change.op === 'UPDATE' && change.after?.['status'] === 'paid',
      );
      expect(pay?.before?.['status']).toBe('expired');
      expect(pay?.after?.['paid_at']).not.toBeNull();
    } finally {
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresPosStore listLatestCreatedByAccount', () => {
  test('binds the ids as one uuid[] literal and returns the latest charge per account', async () => {
    const { client, mergeDb, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateAuthSchema(client);
      await migratePosSchema(client);
      await migrateDbChangeSchema(client);

      const auth = new PostgresAuthStore(client);
      const hex64 = (): string =>
        `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
      const stamp = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
      const first = crypto.randomUUID();
      const second = crypto.randomUUID();
      const idle = crypto.randomUUID();
      for (const [id, suffix] of [
        [first, 'a'],
        [second, 'b'],
        [idle, 'c'],
      ] as const) {
        await auth.createAccount({
          id,
          linkingKey: null,
          role: 'basis',
          name: null,
          username: `latest_${suffix}_${stamp}`,
          location: null,
          forumLawsDismissed: false,
          viewKey: hex64(),
          createdAt: Date.now(),
          rulesAgreedAt: null,
        });
      }

      const store = new PostgresPosStore(client, mergeDb);
      const old = Date.parse('2025-01-02T03:00:00.000Z');
      const newer = Date.parse('2026-09-01T00:00:00.000Z');
      for (const [accountId, status, createdAtMs] of [
        [first, 'expired', newer],
        [first, 'cancelled', old],
        [second, 'cancelled', old],
      ] as const) {
        await store.create({
          id: crypto.randomUUID(),
          accountId,
          amountSats: 21,
          status,
          createdAt: new Date(createdAtMs),
          expiresAt: new Date(createdAtMs + POS_CHARGE_TTL_MS),
          paidAt: null,
          sparkInvoice: null,
          amountCurrency: null,
          amountText: null,
          fiatUsd: null,
          fiatChf: null,
          fiatEur: null,
          fiatPhp: null,
        });
      }

      const latest = await store.listLatestCreatedByAccount([first, second, idle, first]);
      expect(latest).toHaveLength(2);
      expect(new Map(latest.map((ref) => [ref.accountId, ref.createdAtMs]))).toEqual(
        new Map([
          [first, newer],
          [second, old],
        ]),
      );
      expect(await store.listLatestCreatedByAccount([])).toEqual([]);
    } finally {
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresAuthStore stored external address', () => {
  test('new rows leave it unset and writes keep existing data', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateAuthSchema(client);
      await migrateDbChangeSchema(client);

      const store = new PostgresAuthStore(client);
      const hex64 = (): string =>
        `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
      const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      const fresh = crypto.randomUUID();
      await store.createAccount({
        id: fresh,
        linkingKey: null,
        role: 'basis',
        name: null,
        username: `fresh_${stamp}`,
        location: null,
        forumLawsDismissed: false,
        viewKey: hex64(),
        createdAt: Date.now(),
        rulesAgreedAt: null,
      });
      const [created] = await client.query<{
        lightning_address: string | null;
        lightning_address_verified: boolean;
      }>('SELECT lightning_address, lightning_address_verified FROM account WHERE id = $1', [
        fresh,
      ]);
      expect(created).toEqual({ lightning_address: null, lightning_address_verified: false });
      expect((await store.getAccount(fresh))?.hadExternalWallet).toBe(false);

      const legacy = crypto.randomUUID();
      const address = `legacy_${stamp}@example.com`;
      await client.execute(
        `INSERT INTO account (id, role, name, lightning_address, lightning_address_verified,
           forum_laws_dismissed, created_at, view_key)
         VALUES ($1, 'basis', 'Legacy', $2, true, false, now(), $3)`,
        [legacy, address, hex64()],
      );
      const stored = await store.getAccount(legacy);
      expect(stored).toBeDefined();
      expect(stored).not.toHaveProperty('lightningAddress');
      expect(stored?.hadExternalWallet).toBe(true);
      await store.updateAccount({ ...stored!, name: 'Renamed' });
      const [kept] = await client.query<{
        name: string;
        lightning_address: string | null;
        lightning_address_verified: boolean;
      }>('SELECT name, lightning_address, lightning_address_verified FROM account WHERE id = $1', [
        legacy,
      ]);
      expect(kept).toEqual({
        name: 'Renamed',
        lightning_address: address,
        lightning_address_verified: true,
      });
    } finally {
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresAuthStore getAccounts', () => {
  test('binds the ids as one uuid[] literal and returns each known account once', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateAuthSchema(client);
      await migrateDbChangeSchema(client);

      const store = new PostgresAuthStore(client);
      const hex64 = (): string =>
        `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
      const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      const first = crypto.randomUUID();
      const second = crypto.randomUUID();
      for (const [id, suffix] of [
        [first, 'a'],
        [second, 'b'],
      ] as const) {
        await store.createAccount({
          id,
          linkingKey: null,
          role: 'basis',
          name: null,
          username: `bulk_${suffix}_${stamp}`,
          location: null,
          forumLawsDismissed: false,
          viewKey: hex64(),
          createdAt: Date.now(),
          rulesAgreedAt: null,
        });
      }
      const unknown = crypto.randomUUID();
      const found = await store.getAccounts([first, unknown, second, first]);
      expect(found.map((row) => row.id).sort()).toEqual([first, second].sort());
      expect(await store.getAccounts([])).toEqual([]);
    } finally {
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresPushStore countBroadcastOutbox', () => {
  test('counts one broadcast id by status and delivered endpoints', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateAuthSchema(client);
      await migratePushSchema(client);
      await migrateDbChangeSchema(client);
      const auth = new PostgresAuthStore(client);
      const accountId = crypto.randomUUID();
      await auth.createAccount({
        id: accountId,
        linkingKey: null,
        role: 'basis',
        name: null,
        location: null,
        forumLawsDismissed: false,
        viewKey: `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`,
        createdAt: Date.now(),
        rulesAgreedAt: null,
      });
      const store = new PostgresPushStore(client);
      const broadcastId = crypto.randomUUID();
      const row = (messageId: string, tag = `broadcast:${messageId}`): PushOutboxRow => ({
        id: crypto.randomUUID(),
        accountId,
        type: 'zap',
        messageId,
        payload: JSON.stringify({ tag }),
        status: 'pending',
        attempts: 0,
        claimedUntil: null,
        createdAt: new Date(),
        finishedAt: null,
        deliveredEndpoints: [],
        skipEndpoints: [],
      });
      const rows = [
        row(broadcastId),
        row(broadcastId),
        row(broadcastId),
        row(broadcastId),
        row(broadcastId),
      ];
      const forumRow = { ...row(broadcastId, `zap:${broadcastId}`), status: 'sent' as const };
      for (const item of [...rows, row(crypto.randomUUID()), forumRow]) {
        await store.enqueue(item);
      }
      const [delivered, dropped, failed, partial] = rows;
      await store.recordDelivered(delivered?.id ?? '', ['https://push.example/a']);
      await store.markSent(delivered?.id ?? '', Date.now());
      await store.markSent(dropped?.id ?? '', Date.now());
      await store.recordDelivered(partial?.id ?? '', ['https://push.example/b']);
      for (let i = 0; i < 8; i += 1) {
        await store.markFailed(failed?.id ?? '', Date.now());
        await store.markFailed(partial?.id ?? '', Date.now());
      }
      expect(await store.countBroadcastOutbox(broadcastId)).toEqual({
        queued: 5,
        pending: 1,
        delivered: 2,
        dropped: 1,
        failed: 1,
      });
      expect(await store.countBroadcastOutbox(crypto.randomUUID())).toEqual({
        queued: 0,
        pending: 0,
        delivered: 0,
        dropped: 0,
        failed: 0,
      });
    } finally {
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresPushStore enqueuePaymentReceived', () => {
  test('parallel calls for one payment hash enqueue one row, and db_change logs the claim', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl, { max: 4 });
    try {
      await migrateAuthSchema(client);
      await migratePushSchema(client);
      await migrateDbChangeSchema(client);
      const auth = new PostgresAuthStore(client);
      const accountId = crypto.randomUUID();
      await auth.createAccount({
        id: accountId,
        linkingKey: null,
        role: 'basis',
        name: null,
        location: null,
        forumLawsDismissed: false,
        viewKey: `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`,
        createdAt: Date.now(),
        rulesAgreedAt: null,
      });
      const store = new PostgresPushStore(client);
      const paymentHash = `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
      const createdAt = new Date('2026-10-30T12:00:00.000Z');
      const row = (): PushOutboxRow => ({
        id: crypto.randomUUID(),
        accountId,
        type: 'zap',
        messageId: null,
        payload: JSON.stringify({ tag: `payment:${paymentHash}` }),
        status: 'pending',
        attempts: 0,
        claimedUntil: null,
        createdAt,
        finishedAt: null,
        deliveredEndpoints: [],
        skipEndpoints: [],
      });
      const rows = [row(), row(), row(), row()];
      const results = await Promise.all(
        rows.map((item) => store.enqueuePaymentReceived(paymentHash, item)),
      );
      expect(results.filter((queued) => queued)).toHaveLength(1);
      const winner = rows[results.indexOf(true)];
      if (winner === undefined) {
        throw new Error('no enqueue won');
      }
      const stored = (await store.listAllOutbox(1000)).filter(
        (item) => item.accountId === accountId,
      );
      expect(stored).toEqual([winner]);
      expect(await store.enqueuePaymentReceived(paymentHash, row())).toBe(false);
      const claims = await client.query<{ op: string; payment_hash: string; outbox_id: string }>(
        `SELECT op, after->>'payment_hash' AS payment_hash, after->>'outbox_id' AS outbox_id
         FROM db_change WHERE table_name = 'push_payment_received' AND after->>'payment_hash' = $1`,
        [paymentHash],
      );
      expect(claims).toEqual([{ op: 'INSERT', payment_hash: paymentHash, outbox_id: winner.id }]);
    } finally {
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresAuthStore wallet intro seen', () => {
  test('defaults false, a write raises it, a stale write keeps it, and db_change logs it', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateAuthSchema(client);
      await migrateDbChangeSchema(client);

      const store = new PostgresAuthStore(client);
      const hex64 = (): string =>
        `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
      const id = crypto.randomUUID();
      await store.createAccount({
        id,
        linkingKey: null,
        role: 'basis',
        name: null,
        location: null,
        forumLawsDismissed: false,
        viewKey: hex64(),
        createdAt: Date.now(),
        rulesAgreedAt: null,
      });
      const stale = await store.getAccount(id);
      expect(stale?.walletIntroSeen).toBe(false);

      await store.updateAccount({ ...stale!, walletIntroSeen: true });
      expect((await store.getAccount(id))?.walletIntroSeen).toBe(true);

      await store.updateAccount({ ...stale!, name: 'Stale' });
      const kept = await store.getAccount(id);
      expect(kept?.name).toBe('Stale');
      expect(kept?.walletIntroSeen).toBe(true);

      const changeRows = await client.query<{
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
      }>(
        `SELECT before, after
         FROM db_change
         WHERE table_name = 'account' AND op = 'UPDATE' AND after ->> 'id' = $1
         ORDER BY id ASC`,
        [id],
      );
      expect(
        changeRows.some(
          (row) =>
            row.before?.['wallet_intro_seen'] === false &&
            row.after?.['wallet_intro_seen'] === true,
        ),
      ).toBe(true);
    } finally {
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresAuthStore heart amount', () => {
  test('an update without heartSats keeps 21 and a provided 5 replaces it', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateAuthSchema(client);

      const store = new PostgresAuthStore(client);
      const hex64 = (): string =>
        `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
      const id = crypto.randomUUID();
      await store.createAccount({
        id,
        linkingKey: null,
        role: 'basis',
        name: null,
        location: null,
        forumLawsDismissed: false,
        viewKey: hex64(),
        createdAt: Date.now(),
        rulesAgreedAt: null,
        heartSats: 21,
      });

      const created = await store.getAccount(id);
      expect(created?.heartSats).toBe(21);
      const { heartSats: _omit, ...withoutHeartSats } = created!;
      void _omit;
      await store.updateAccount({ ...withoutHeartSats, name: 'Renamed' });
      expect((await store.getAccount(id))?.heartSats).toBe(21);

      await store.updateAccount({ ...created!, heartSats: 5 });
      expect((await store.getAccount(id))?.heartSats).toBe(5);
    } finally {
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresMessageStore welcome gift', () => {
  test('a platform Welcome reply under the account notes counts, live or hidden', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateAuthSchema(client);
      await migrateMessageSchema(client);
      const auth = new PostgresAuthStore(client);
      const messages = new PostgresMessageStore(client);
      const hex64 = (): string =>
        `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
      const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      const member = crypto.randomUUID();
      const platform = crypto.randomUUID();
      for (const [id, name] of [
        [member, `welcome_m_${stamp}`],
        [platform, `welcome_p_${stamp}`],
      ] as const) {
        await auth.createAccount({
          id,
          linkingKey: null,
          role: 'basis',
          name,
          username: name,
          location: null,
          forumLawsDismissed: false,
          viewKey: hex64(),
          createdAt: Date.now(),
          rulesAgreedAt: null,
        });
      }
      const note = crypto.randomUUID();
      const base = {
        name: 'n',
        createdAt: new Date(),
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
        ...unsignedNostrDefaults(),
      };
      await messages.create({ ...base, id: note, accountId: member, text: 'note' });
      expect(await messages.accountHasWelcomeGift(member, platform)).toBe(false);
      await messages.create({
        ...base,
        id: crypto.randomUUID(),
        accountId: platform,
        parentId: note,
        text: '21gifts daily',
      });
      expect(await messages.accountHasWelcomeGift(member, platform)).toBe(false);
      const welcome = crypto.randomUUID();
      await messages.create({
        ...base,
        id: welcome,
        accountId: platform,
        parentId: note,
        text: 'Welcome',
      });
      expect(await messages.accountHasWelcomeGift(member, platform)).toBe(true);
      await messages.markDeleted(welcome, new Date(), platform);
      expect(await messages.accountHasWelcomeGift(member, platform)).toBe(true);
    } finally {
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresMessageStore free first post', () => {
  test('concurrent first posts store one row; profile note and replies do not count', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateAuthSchema(client);
      await migrateMessageSchema(client);
      const auth = new PostgresAuthStore(client);
      const messages = new PostgresMessageStore(client);
      const hex64 = (): string =>
        `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
      const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      const member = crypto.randomUUID();
      const other = crypto.randomUUID();
      for (const [id, name] of [
        [member, `first_m_${stamp}`],
        [other, `first_o_${stamp}`],
      ] as const) {
        await auth.createAccount({
          id,
          linkingKey: null,
          role: 'basis',
          name,
          username: name,
          location: null,
          forumLawsDismissed: false,
          viewKey: hex64(),
          createdAt: Date.now(),
          rulesAgreedAt: null,
        });
      }
      const base = {
        name: 'n',
        createdAt: new Date(),
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
        ...unsignedNostrDefaults(),
      };
      const profile = crypto.randomUUID();
      await messages.create({ ...base, id: profile, accountId: member, text: 'about me' });
      const parent = crypto.randomUUID();
      await messages.create({ ...base, id: parent, accountId: other, text: 'parent' });
      await messages.create({
        ...base,
        id: crypto.randomUUID(),
        accountId: member,
        parentId: parent,
        text: 'a reply',
      });
      expect(await messages.accountHasTopLevelPost(member, profile)).toBe(false);
      const attempts = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          messages.createFirstPost(
            { ...base, id: crypto.randomUUID(), accountId: member, text: `first ${i}` },
            profile,
          ),
        ),
      );
      const stored = attempts.filter((row) => row !== undefined);
      expect(stored).toHaveLength(1);
      const rows = (await sql.unsafe(
        `SELECT id FROM message WHERE account_id = $1 AND parent_id IS NULL AND first_post_free IS TRUE`,
        [member],
      )) as { id: string }[];
      expect(rows.map((row) => row.id)).toEqual([stored[0]!.id]);
      await messages.markDeleted(stored[0]!.id, new Date(), other);
      expect(await messages.accountHasTopLevelPost(member, profile)).toBe(true);
      expect(
        await messages.createFirstPost(
          { ...base, id: crypto.randomUUID(), accountId: member, text: 'again' },
          profile,
        ),
      ).toBeUndefined();
    } finally {
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresFxSpotStore', () => {
  test('keeps provider digits, orders by asOf, replaces a future row, and logs db_change', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateAuthSchema(client);
      await migrateFxSpotSchema(client);
      await migrateDbChangeSchema(client);
      const store = new PostgresFxSpotStore(client);
      const stamp = `test-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      // The row is shared across runs on one database: start after whatever it
      // holds, but stay in the past of the database clock.
      const stored = await store.latest();
      const storedMs = stored === null ? 0 : Date.parse(stored.asOf);
      const startMs = Math.max(storedMs + 1_000, Date.now() - 10 * 60_000);
      const iso = (ms: number): string => new Date(ms).toISOString();
      const digits = {
        USD: '62345.12',
        CHF: '55000.5',
        EUR: '57000',
        PHP: '5218637.18388173333610621',
      };
      await store.save({ asOf: iso(startMs), source: stamp, rates: digits });
      expect(await store.latest()).toEqual({ asOf: iso(startMs), source: stamp, rates: digits });
      await store.save({ asOf: iso(startMs + 2_000), source: stamp, rates: { USD: '62400' } });
      expect(await store.latest()).toEqual({
        asOf: iso(startMs + 2_000),
        source: stamp,
        rates: { USD: '62400' },
      });
      await store.save({ asOf: iso(startMs + 1_000), source: stamp, rates: { USD: '1' } });
      expect((await store.latest())?.rates).toEqual({ USD: '62400' });
      await store.save({ asOf: iso(Date.now() + 3_600_000), source: stamp, rates: { USD: '2' } });
      await store.save({ asOf: iso(startMs + 3_000), source: stamp, rates: { USD: '62500' } });
      expect(await store.latest()).toEqual({
        asOf: iso(startMs + 3_000),
        source: stamp,
        rates: { USD: '62500' },
      });
      const rows = await client.query<{ op: string; after: { usd: unknown; php: unknown } | null }>(
        `SELECT op, after
         FROM db_change
         WHERE table_name = 'btc_fiat_spot' AND after ->> 'source' = $1
         ORDER BY id ASC`,
        [stamp],
      );
      expect(rows.length).toBeGreaterThanOrEqual(4);
      const last = rows[rows.length - 1];
      expect(last?.op).toBe('UPDATE');
      expect(Number(last?.after?.usd)).toBe(62500);
      expect(last?.after?.php).toBeNull();
    } finally {
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresWalletTransferStore UTC shop window', () => {
  test('is independent of the session TimeZone at the last UTC hour of D and D-2', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl, { max: 1 });
    const buyerId = crypto.randomUUID();
    const shopId = crypto.randomUUID();
    const noteId = crypto.randomUUID();
    const hex64 = (): string =>
      `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
    const buyerKey = `02${hex64()}`;
    const shopKey = `03${hex64()}`;
    try {
      await migrateAuthSchema(client);
      await migrateMessageSchema(client);
      await migrateWalletSchema(client);
      await migrateDbChangeSchema(client);
      const auth = new PostgresAuthStore(client);
      for (const [id, username] of [
        [buyerId, `utc_buyer_${buyerId.slice(0, 8)}`],
        [shopId, `utc_shop_${shopId.slice(0, 8)}`],
      ] as const) {
        await auth.createAccount({
          id,
          linkingKey: null,
          role: 'verified',
          name: null,
          username,
          location: null,
          forumLawsDismissed: false,
          viewKey: hex64(),
          createdAt: Date.now(),
          rulesAgreedAt: null,
          walletRequired: true,
        });
      }
      await client.execute(
        `UPDATE account SET spark_pubkey = CASE id WHEN $1 THEN $2 ELSE $3 END,
                            spark_pubkey_verified_at = now()
         WHERE id IN ($1, $4)`,
        [buyerId, buyerKey, shopKey, shopId],
      );
      await new PostgresMessageStore(client).create({
        id: noteId,
        accountId: shopId,
        name: 'UTC Shop',
        text: 'Open #21GiftsShop',
        createdAt: new Date('2026-11-12T12:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        shopAccount: { id: shopId, username: null, name: 'UTC Shop' },
      });
      await client.execute("SET TIME ZONE 'Pacific/Honolulu'");
      const store = new PostgresWalletTransferStore(client);
      const tokenHash = hex64();
      await store.upsertTokenTransaction({
        accountId: buyerId,
        walletPubkey: buyerKey,
        transactionHash: tokenHash,
        tokenIdentifier: 'ab'.repeat(32),
        direction: 'in',
        amount: '21',
        counterpartyPubkeys: [],
        inputCount: 0,
        resolvedInputCount: 0,
        sparkInvoices: ['spark1token'],
        type: 'mint',
        status: 'finalized',
        transactionCreatedAt: new Date('2026-11-12T22:00:00.000Z'),
        transactionExpiryAt: new Date('2026-11-12T22:05:00.000Z'),
        seenAt: new Date('2026-11-12T22:01:00.000Z'),
      });
      const tokenChanges = await client.query<{ op: string; after: Record<string, unknown> }>(
        `SELECT op, after FROM db_change
         WHERE table_name = 'wallet_token_transaction'
           AND after ->> 'transaction_hash' = $1`,
        [tokenHash],
      );
      expect(tokenChanges.map((row) => row.op)).toContain('INSERT');
      expect(tokenChanges.every((row) => !('payload' in row.after))).toBe(true);
      expect(
        tokenChanges.some((row) => {
          const invoices = row.after['spark_invoices'];
          return Array.isArray(invoices) && invoices[0] === 'spark1token';
        }),
      ).toBe(true);
      expect(JSON.stringify(tokenChanges)).not.toContain('revocationSecret');
      const observed = new Date('2026-11-13T00:00:00.000Z');
      const transfer = (id: string, at: string) => ({
        accountId: buyerId,
        walletPubkey: buyerKey,
        transferId: id,
        direction: 'out' as const,
        type: 'transfer' as const,
        status: 'completed' as const,
        amountSats: 21,
        counterpartyPubkey: shopKey,
        counterpartyPubkeys: [shopKey],
        sparkInvoice: null,
        transferCreatedAt: new Date(at),
        transferUpdatedAt: null,
        seenAt: observed,
      });
      await store.upsertTransfer(transfer('utc-d-minus-2', '2026-11-10T23:30:00.000Z'));
      await expect(store.hasShopPayment(buyerId, '2026-11-11', '2026-11-12')).resolves.toBe(false);
      await store.upsertTransfer(transfer('utc-d', '2026-11-12T23:30:00.000Z'));
      await expect(store.hasShopPayment(buyerId, '2026-11-11', '2026-11-12')).resolves.toBe(true);

      const missingTimeTransferId = crypto.randomUUID();
      await store.upsertTransfer({
        ...transfer(missingTimeTransferId, '2026-11-12T20:00:00.000Z'),
        status: 'pending',
        transferUpdatedAt: null,
        seenAt: new Date('2026-11-12T22:00:00.000Z'),
      });
      // A transfer time is compared only with another transfer time, never
      // with the later poll clock stored in last_seen_at.
      await store.upsertTransfer({
        ...transfer(missingTimeTransferId, '2026-11-12T20:00:00.000Z'),
        status: 'completed',
        transferUpdatedAt: new Date('2026-11-12T21:00:00.000Z'),
        seenAt: new Date('2026-11-12T22:01:00.000Z'),
      });
      await store.upsertTransfer({
        ...transfer(missingTimeTransferId, '2026-11-12T20:00:00.000Z'),
        status: 'pending',
        transferUpdatedAt: null,
        seenAt: new Date('2026-11-12T23:00:00.000Z'),
      });
      await expect(
        client.query<{ status: string; transfer_updated_at: Date; last_seen_at: Date }>(
          `SELECT status, transfer_updated_at, last_seen_at FROM wallet_transfer
           WHERE account_id = $1 AND wallet_pubkey = $2 AND transfer_id = $3`,
          [buyerId, buyerKey, missingTimeTransferId],
        ),
      ).resolves.toEqual([
        {
          status: 'completed',
          transfer_updated_at: new Date('2026-11-12T21:00:00.000Z'),
          last_seen_at: new Date('2026-11-12T23:00:00.000Z'),
        },
      ]);

      const monotonicTransferId = crypto.randomUUID();
      await store.upsertTransfer({
        ...transfer(monotonicTransferId, '2026-11-12T20:00:00.000Z'),
        status: 'completed',
        transferUpdatedAt: new Date('2026-11-12T22:00:00.000Z'),
        seenAt: new Date('2026-11-12T22:01:00.000Z'),
      });
      // Commit the older observation second: current state must remain the newer one.
      await store.upsertTransfer({
        ...transfer(monotonicTransferId, '2026-11-12T20:00:00.000Z'),
        status: 'pending',
        transferUpdatedAt: new Date('2026-11-12T21:00:00.000Z'),
        seenAt: new Date('2026-11-12T23:00:00.000Z'),
      });
      const monotonicTokenHash = hex64();
      await store.upsertTokenTransaction({
        accountId: buyerId,
        walletPubkey: buyerKey,
        transactionHash: monotonicTokenHash,
        tokenIdentifier: null,
        direction: 'out',
        amount: '34',
        counterpartyPubkeys: [shopKey],
        inputCount: 1,
        resolvedInputCount: 1,
        sparkInvoices: [],
        type: 'transfer',
        status: 'finalized',
        transactionCreatedAt: new Date('2026-11-12T20:00:00.000Z'),
        transactionExpiryAt: null,
        seenAt: new Date('2026-11-12T22:00:00.000Z'),
      });
      await store.upsertTokenTransaction({
        accountId: buyerId,
        walletPubkey: buyerKey,
        transactionHash: monotonicTokenHash,
        tokenIdentifier: null,
        direction: 'in',
        amount: '1',
        counterpartyPubkeys: [],
        inputCount: 1,
        resolvedInputCount: 0,
        sparkInvoices: [],
        type: 'transfer',
        status: 'finalized',
        transactionCreatedAt: new Date('2026-11-12T20:00:00.000Z'),
        transactionExpiryAt: null,
        seenAt: new Date('2026-11-12T23:00:00.000Z'),
      });
      await expect(
        client.query<{ status: string }>(
          `SELECT status FROM wallet_transfer
           WHERE account_id = $1 AND wallet_pubkey = $2 AND transfer_id = $3`,
          [buyerId, buyerKey, monotonicTransferId],
        ),
      ).resolves.toEqual([{ status: 'completed' }]);
      // Equal operator age remains authoritative even when it arrived with an earlier seen time.
      await store.upsertTransfer({
        ...transfer(monotonicTransferId, '2026-11-12T20:00:00.000Z'),
        status: 'returned',
        transferUpdatedAt: new Date('2026-11-12T22:00:00.000Z'),
        seenAt: new Date('2026-11-12T22:00:00.000Z'),
      });
      await expect(
        client.query<{ status: string; seen_preserved: boolean }>(
          `SELECT status, last_seen_at = $4 AS seen_preserved FROM wallet_transfer
           WHERE account_id = $1 AND wallet_pubkey = $2 AND transfer_id = $3`,
          [buyerId, buyerKey, monotonicTransferId, new Date('2026-11-12T22:01:00.000Z')],
        ),
      ).resolves.toEqual([{ status: 'returned', seen_preserved: true }]);
      await expect(
        client.query<{
          status: string;
          direction: string;
          amount: string;
          counterparty_pubkeys: string[];
          input_count: number;
          resolved_input_count: number;
          last_seen_at: Date;
        }>(
          `SELECT status, direction, amount::text AS amount, counterparty_pubkeys,
                  input_count, resolved_input_count, last_seen_at
           FROM wallet_token_transaction
           WHERE account_id = $1 AND wallet_pubkey = $2 AND transaction_hash = $3`,
          [buyerId, buyerKey, monotonicTokenHash],
        ),
      ).resolves.toEqual([
        {
          status: 'finalized',
          direction: 'out',
          amount: '34',
          counterparty_pubkeys: [shopKey],
          input_count: 1,
          resolved_input_count: 1,
          last_seen_at: new Date('2026-11-12T23:00:00.000Z'),
        },
      ]);
      const unresolvedTokenHash = hex64();
      await store.upsertTokenTransaction({
        accountId: buyerId,
        walletPubkey: buyerKey,
        transactionHash: unresolvedTokenHash,
        tokenIdentifier: null,
        direction: 'in',
        amount: '1',
        counterpartyPubkeys: [],
        inputCount: 1,
        resolvedInputCount: 0,
        sparkInvoices: [],
        type: 'transfer',
        status: 'finalized',
        transactionCreatedAt: new Date('2026-11-12T19:00:00.000Z'),
        transactionExpiryAt: null,
        seenAt: new Date('2026-11-12T23:01:00.000Z'),
      });
      await expect(store.syncState(buyerId, buyerKey)).resolves.toMatchObject({
        oldestPendingTokenCreatedAt: new Date('2026-11-12T19:00:00.000Z'),
        pendingTokenWithoutCreatedAt: false,
      });
    } finally {
      await client.execute('DELETE FROM wallet_token_transaction WHERE account_id = $1', [buyerId]);
      await client.execute('DELETE FROM wallet_transfer WHERE account_id = $1', [buyerId]);
      await client.execute('DELETE FROM message WHERE id = $1', [noteId]);
      await client.execute('DELETE FROM account WHERE id IN ($1, $2)', [buyerId, shopId]);
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresWelcomeInvoiceReservationStore concurrency', () => {
  test('atomically grants one welcome entitlement and audits its release', async () => {
    const firstDb = createBunSqlClient(databaseUrl, { max: 2 });
    const secondDb = createBunSqlClient(databaseUrl, { max: 1 });
    const accountId = crypto.randomUUID();
    const firstReservation = 'a'.repeat(32);
    const secondReservation = 'b'.repeat(32);
    try {
      await migrateAuthSchema(firstDb.client);
      await migrateWelcomeInvoiceReservationSchema(firstDb.client);
      await migrateDbChangeSchema(firstDb.client);
      await new PostgresAuthStore(firstDb.client).createAccount({
        id: accountId,
        linkingKey: null,
        role: 'verified',
        name: null,
        username: `welcome_reservation_${accountId.slice(0, 8)}`,
        location: null,
        forumLawsDismissed: false,
        viewKey: `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`,
        createdAt: Date.now(),
        rulesAgreedAt: null,
        walletRequired: true,
      });
      const createdAt = new Date('2026-11-12T12:00:00.000Z');
      const expiresAt = new Date('2026-11-12T12:05:00.000Z');
      const outcomes = await Promise.all([
        new PostgresWelcomeInvoiceReservationStore(firstDb.client).reserve(
          accountId,
          firstReservation,
          createdAt,
          expiresAt,
        ),
        new PostgresWelcomeInvoiceReservationStore(secondDb.client).reserve(
          accountId,
          secondReservation,
          createdAt,
          expiresAt,
        ),
      ]);
      expect(outcomes.sort()).toEqual([false, true]);
      const rows = await firstDb.client.query<{ reservation_id: string }>(
        `SELECT reservation_id FROM welcome_invoice_reservation WHERE account_id = $1`,
        [accountId],
      );
      const reservationId = rows[0]?.reservation_id;
      if (reservationId === undefined) {
        throw new Error('welcome reservation was not stored');
      }
      expect([firstReservation, secondReservation]).toContain(reservationId);
      await new PostgresWelcomeInvoiceReservationStore(firstDb.client).release(
        accountId,
        reservationId,
      );
      const changes = await firstDb.client.query<{ op: string }>(
        `SELECT op FROM db_change
         WHERE table_name = 'welcome_invoice_reservation'
           AND COALESCE(after ->> 'account_id', before ->> 'account_id') = $1
         ORDER BY id`,
        [accountId],
      );
      expect(changes.map((row) => row.op)).toEqual(['INSERT', 'DELETE']);
    } finally {
      await firstDb.client.execute(
        'DELETE FROM welcome_invoice_reservation WHERE account_id = $1',
        [accountId],
      );
      await firstDb.client.execute('DELETE FROM account WHERE id = $1', [accountId]);
      await closeIfPossible(firstDb.sql);
      await closeIfPossible(secondDb.sql);
    }
  });
});

describe('PostgresWalletTransferStore verified counterparty ownership', () => {
  test('an unverified shop claim is ignored and an unverified claim cannot shadow previous_wallet', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl, { max: 1 });
    const buyerId = crypto.randomUUID();
    const unverifiedShopId = crypto.randomUUID();
    const previousShopId = crypto.randomUUID();
    const claimantId = crypto.randomUUID();
    const unverifiedShopNoteId = crypto.randomUUID();
    const previousShopNoteId = crypto.randomUUID();
    const hex64 = (): string =>
      `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
    const buyerKey = `02${hex64()}`;
    const unverifiedClaimKey = `03${hex64()}`;
    const previousShopKey = `02${hex64()}`;
    try {
      await migrateAuthSchema(client);
      await migrateMessageSchema(client);
      await migrateWalletSchema(client);
      const auth = new PostgresAuthStore(client);
      for (const [id, username] of [
        [buyerId, `claim_buyer_${buyerId.slice(0, 8)}`],
        [unverifiedShopId, `claim_shop_${unverifiedShopId.slice(0, 8)}`],
        [previousShopId, `previous_shop_${previousShopId.slice(0, 8)}`],
        [claimantId, `claimant_${claimantId.slice(0, 8)}`],
      ] as const) {
        await auth.createAccount({
          id,
          linkingKey: null,
          role: 'verified',
          name: null,
          username,
          location: null,
          forumLawsDismissed: false,
          viewKey: hex64(),
          createdAt: Date.now(),
          rulesAgreedAt: null,
          walletRequired: true,
        });
      }
      await client.execute(
        `UPDATE account
         SET spark_pubkey = CASE
           WHEN id = $1 THEN $2
           WHEN id = $3 THEN $4
           ELSE $5
         END,
         spark_pubkey_verified_at = CASE WHEN id = $1 THEN now() ELSE NULL END
         WHERE id IN ($1, $3, $6)`,
        [buyerId, buyerKey, unverifiedShopId, unverifiedClaimKey, previousShopKey, claimantId],
      );
      await client.execute(
        `INSERT INTO previous_wallet (account_id, spark_pubkey, spark_address, replaced_at)
         VALUES ($1, $2, $3, $4)`,
        [
          previousShopId,
          previousShopKey,
          `spark1${'q'.repeat(62)}`,
          new Date('2026-11-11T00:00:00.000Z'),
        ],
      );
      const messages = new PostgresMessageStore(client);
      for (const [id, accountId, name] of [
        [unverifiedShopNoteId, unverifiedShopId, 'Unverified Claim Shop'],
        [previousShopNoteId, previousShopId, 'Previous Wallet Shop'],
      ] as const) {
        await messages.create({
          id,
          accountId,
          name,
          text: `${name} #21GiftsShop`,
          createdAt: new Date('2026-11-12T12:00:00.000Z'),
          hasPhoto: false,
          ...unsignedNostrDefaults(),
          shopAccount: { id: accountId, username: null, name },
        });
      }
      const store = new PostgresWalletTransferStore(client);
      const transfer = (transferId: string, counterpartyPubkey: string) => ({
        accountId: buyerId,
        walletPubkey: buyerKey,
        transferId,
        direction: 'out' as const,
        type: 'transfer' as const,
        status: 'completed' as const,
        amountSats: 21,
        counterpartyPubkey,
        counterpartyPubkeys: [counterpartyPubkey],
        sparkInvoice: null,
        transferCreatedAt: new Date('2026-11-12T13:00:00.000Z'),
        transferUpdatedAt: null,
        seenAt: new Date('2026-11-12T13:01:00.000Z'),
      });

      await store.upsertTransfer(transfer('unverified-shop-claim', unverifiedClaimKey));
      await expect(store.hasShopPayment(buyerId, '2026-11-12', '2026-11-12')).resolves.toBe(false);
      const unverified = await client.query<{ counterparty_account_id: string | null }>(
        `SELECT counterparty_account_id FROM wallet_transfer
         WHERE account_id = $1 AND transfer_id = 'unverified-shop-claim'`,
        [buyerId],
      );
      expect(unverified[0]?.counterparty_account_id).toBeNull();

      await store.upsertTransfer(transfer('previous-wallet-shop', previousShopKey));
      await expect(store.hasShopPayment(buyerId, '2026-11-12', '2026-11-12')).resolves.toBe(true);
      const previous = await client.query<{ counterparty_account_id: string | null }>(
        `SELECT counterparty_account_id FROM wallet_transfer
         WHERE account_id = $1 AND transfer_id = 'previous-wallet-shop'`,
        [buyerId],
      );
      expect(previous[0]?.counterparty_account_id).toBe(previousShopId);
    } finally {
      await client.execute('DELETE FROM wallet_transfer WHERE account_id = $1', [buyerId]);
      await client.execute('DELETE FROM message WHERE id IN ($1, $2)', [
        unverifiedShopNoteId,
        previousShopNoteId,
      ]);
      await client.execute('DELETE FROM previous_wallet WHERE account_id = $1', [previousShopId]);
      await client.execute('DELETE FROM account WHERE id IN ($1, $2, $3, $4)', [
        buyerId,
        unverifiedShopId,
        previousShopId,
        claimantId,
      ]);
      await closeIfPossible(sql);
    }
  });
});

describe('POST /me/wallet/counterparties sources in Postgres', () => {
  test('own completed reports and the counterparty of completed observed transfers', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl, { max: 1 });
    const hex64 = (): string =>
      `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
    const receiverId = crypto.randomUUID();
    const senderId = crypto.randomUUID();
    const previousOwnerId = crypto.randomUUID();
    const claimantId = crypto.randomUUID();
    const receiverKey = `02${hex64()}`;
    const senderKey = `03${hex64()}`;
    const previousKey = `02${hex64()}`;
    const claimKey = `03${hex64()}`;
    const prefix = crypto.randomUUID();
    const id = (name: string): string => `${prefix}-${name}`;
    try {
      await migrateAuthSchema(client);
      await migrateMessageSchema(client);
      await migrateWalletSchema(client);
      const auth = new PostgresAuthStore(client);
      for (const accountId of [receiverId, senderId, previousOwnerId, claimantId]) {
        await auth.createAccount({
          id: accountId,
          linkingKey: null,
          role: 'verified',
          name: null,
          username: `cp_${accountId.replaceAll('-', '').slice(0, 12)}`,
          location: null,
          forumLawsDismissed: false,
          viewKey: hex64(),
          createdAt: Date.now(),
          rulesAgreedAt: null,
          walletRequired: true,
        });
      }
      await client.execute(
        `UPDATE account
         SET spark_pubkey = CASE WHEN id = $1 THEN $2 WHEN id = $3 THEN $4 ELSE $5 END,
             spark_pubkey_verified_at = CASE WHEN id = $6 THEN NULL ELSE now() END
         WHERE id IN ($1, $3, $6)`,
        [receiverId, receiverKey, senderId, senderKey, claimKey, claimantId],
      );
      await client.execute(
        `INSERT INTO previous_wallet (account_id, spark_pubkey, spark_address, replaced_at)
         VALUES ($1, $2, $3, $4)`,
        [
          previousOwnerId,
          previousKey,
          `spark1${'q'.repeat(62)}`,
          new Date('2026-11-11T00:00:00.000Z'),
        ],
      );
      const time = new Date('2026-11-12T13:00:00.000Z');
      const report = (
        name: string,
        extra: Partial<WalletPaymentRecord> = {},
      ): WalletPaymentRecord => ({
        accountId: receiverId,
        paymentId: id(name),
        direction: 'out',
        status: 'completed',
        amountSats: 21,
        feeSats: 0,
        paidAt: time,
        method: 'spark',
        paymentHash: null,
        invoice: null,
        destination: null,
        description: null,
        lnurlComment: null,
        category: 'member',
        counterpartyAccountId: null,
        firstSeenAt: time,
        updatedAt: time,
        ...extra,
      });
      const wallet = new PostgresWalletStore(client);
      await wallet.upsertPayments([
        report('out'),
        report('in', { direction: 'in' }),
        report('pending', { status: 'pending' }),
        report('failed', { status: 'failed' }),
        report('sender-only', { accountId: senderId }),
      ]);
      expect(
        [
          ...(await wallet.findCompletedPayments(receiverId, [
            { id: id('out'), direction: 'out' },
            { id: id('in'), direction: 'in' },
            { id: id('in'), direction: 'out' },
            { id: id('pending'), direction: 'out' },
            { id: id('failed'), direction: 'out' },
            { id: id('sender-only'), direction: 'out' },
            { id: 'bad\u0000id', direction: 'out' },
          ])),
        ].sort(),
      ).toEqual([id('in'), id('out')].sort());

      const transfers = new PostgresWalletTransferStore(client);
      const transfer = (
        name: string,
        counterpartyPubkey: string,
        extra: Partial<WalletTransferRecord> = {},
      ): WalletTransferRecord => ({
        accountId: receiverId,
        walletPubkey: receiverKey,
        transferId: id(name),
        direction: 'out',
        type: 'transfer',
        status: 'completed',
        amountSats: 21,
        counterpartyPubkey,
        counterpartyPubkeys: [counterpartyPubkey],
        sparkInvoice: null,
        transferCreatedAt: time,
        transferUpdatedAt: null,
        seenAt: time,
        ...extra,
      });
      for (const row of [
        transfer('out', senderKey),
        transfer('in', senderKey, { direction: 'in' }),
        transfer('previous', previousKey),
        transfer('unverified', claimKey),
        transfer('self', receiverKey),
        transfer('pending', senderKey, { status: 'pending' }),
        transfer('lightning', senderKey, { type: 'preimage_swap' }),
        transfer('multi', senderKey, { counterpartyPubkeys: [senderKey, previousKey] }),
        transfer('sender-side', receiverKey, { accountId: senderId, walletPubkey: senderKey }),
      ]) {
        await transfers.upsertTransfer(row);
      }
      const found = await transfers.findObservedCounterparties(receiverId, [
        { id: id('out'), direction: 'out' },
        { id: id('in'), direction: 'in' },
        { id: id('previous'), direction: 'out' },
        { id: id('unverified'), direction: 'out' },
        { id: id('self'), direction: 'out' },
        { id: id('pending'), direction: 'out' },
        { id: id('lightning'), direction: 'out' },
        { id: id('multi'), direction: 'out' },
        { id: id('sender-side'), direction: 'in' },
        { id: id('sender-side'), direction: 'out' },
        { id: id('out'), direction: 'in' },
        { id: 'bad\u0000id', direction: 'out' },
      ]);
      expect(found).toEqual(
        new Map([
          [id('in'), [senderId]],
          [id('out'), [senderId]],
          [id('previous'), [previousOwnerId]],
        ]),
      );
    } finally {
      await client.execute('DELETE FROM wallet_transfer WHERE account_id IN ($1, $2)', [
        receiverId,
        senderId,
      ]);
      await client.execute('DELETE FROM wallet_payment WHERE account_id IN ($1, $2)', [
        receiverId,
        senderId,
      ]);
      await client.execute('DELETE FROM previous_wallet WHERE account_id = $1', [previousOwnerId]);
      await client.execute('DELETE FROM account WHERE id IN ($1, $2, $3, $4)', [
        receiverId,
        senderId,
        previousOwnerId,
        claimantId,
      ]);
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresWalletStore', () => {
  test('migrate twice, balance, guarded upsert, order, db_change, and secrets', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateAuthSchema(client);
      await migrateMessageSchema(client);
      await migrateWalletSchema(client);
      await migrateWalletSchema(client);
      await migrateDbChangeSchema(client);

      const auth = new PostgresAuthStore(client);
      const hex64 = (): string =>
        `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
      const accountId = crypto.randomUUID();
      await auth.createAccount({
        id: accountId,
        linkingKey: null,
        role: 'basis',
        name: null,
        username: `wallet_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`,
        location: null,
        forumLawsDismissed: false,
        viewKey: hex64(),
        createdAt: Date.now(),
        rulesAgreedAt: null,
        walletRequired: true,
      });

      const store = new PostgresWalletStore(client);
      const receivedAt = new Date();
      const snapshotId = crypto.randomUUID();
      await store.recordBalance({
        id: snapshotId,
        accountId,
        balanceSats: 1000,
        syncedAt: receivedAt,
        receivedAt,
      });
      const latest = await store.latestBalance(accountId, null);
      const legacyFallback = await store.latestBalance(accountId, `02${'a'.repeat(64)}`);
      expect(latest?.id).toBe(snapshotId);
      expect(legacyFallback?.id).toBe(snapshotId);
      expect(latest?.balanceSats).toBe(1000);
      expect(latest?.accountId).toBe(accountId);

      const paidPending = new Date(Date.now() - 5_000);
      const paidLater = new Date(Date.now() - 1_000);
      const firstSeen = new Date(Date.now() - 4_000);
      const pending = {
        accountId,
        paymentId: 'p-pending',
        direction: 'out' as const,
        status: 'pending' as const,
        amountSats: 21,
        feeSats: 0,
        paidAt: paidPending,
        method: 'lightning',
        paymentHash: null,
        invoice: null,
        destination: null,
        description: 'coffee',
        lnurlComment: null,
        category: 'unknown' as const,
        counterpartyAccountId: null,
        firstSeenAt: firstSeen,
        updatedAt: firstSeen,
      };
      await store.upsertPayments([pending]);
      const laterPayment = {
        ...pending,
        paymentId: 'p-later',
        paidAt: paidLater,
        description: 'later',
        firstSeenAt: new Date(),
        updatedAt: new Date(),
      };
      await store.upsertPayments([laterPayment]);

      const walletPaymentChanges = (paymentId: string) =>
        client.query<{ op: string }>(
          `SELECT op
           FROM db_change
           WHERE table_name = 'wallet_payment'
             AND (before ->> 'payment_id' = $1 OR after ->> 'payment_id' = $1)
             AND (before ->> 'account_id' = $2 OR after ->> 'account_id' = $2)
           ORDER BY id ASC`,
          [paymentId, accountId],
        );

      const afterInsert = await walletPaymentChanges('p-pending');
      expect(afterInsert.map((row) => row.op)).toEqual(['INSERT']);
      const storedPending = (await store.listPayments(accountId, 10)).find(
        (row) => row.paymentId === 'p-pending',
      );
      if (storedPending === undefined) {
        throw new Error('expected pending payment');
      }
      expect(storedPending.updatedAt.getTime()).toBe(firstSeen.getTime());
      const pendingUpdatedAt = storedPending.updatedAt.getTime();
      const pendingFirstSeen = storedPending.firstSeenAt.getTime();

      await store.upsertPayments([{ ...pending, updatedAt: new Date(Date.now() + 5_000) }]);
      // An identical re-send changes no value; it only advances the staleness watermark.
      const afterIdentical = await walletPaymentChanges('p-pending');
      expect(afterIdentical.map((row) => row.op)).toEqual(['INSERT', 'UPDATE']);
      const stillPending = (await store.listPayments(accountId, 10)).find(
        (row) => row.paymentId === 'p-pending',
      );
      expect(stillPending?.updatedAt.getTime()).toBe(pendingUpdatedAt);
      expect(stillPending?.status).toBe('pending');

      await store.upsertPayments([
        {
          ...pending,
          status: 'completed',
          description: null,
          updatedAt: new Date(Date.now() + 10_000),
        },
      ]);
      const completed = (await store.listPayments(accountId, 10)).find(
        (row) => row.paymentId === 'p-pending',
      );
      if (completed === undefined) {
        throw new Error('expected completed payment');
      }
      expect(completed.status).toBe('completed');
      expect(completed.description).toBe('coffee');
      expect(completed.firstSeenAt.getTime()).toBe(pendingFirstSeen);
      const afterCompleted = await walletPaymentChanges('p-pending');
      expect(afterCompleted.map((row) => row.op)).toEqual(['INSERT', 'UPDATE', 'UPDATE']);

      const ordered = await store.listPayments(accountId, 10);
      expect(ordered.map((row) => row.paymentId)).toEqual(['p-later', 'p-pending']);

      const firstPage = await store.listPayments(accountId, 1);
      expect(firstPage.map((row) => row.paymentId)).toEqual(['p-later']);
      const afterFirst = firstPage[0];
      if (afterFirst === undefined) {
        throw new Error('expected one first-page payment');
      }
      const nextPage = await store.listPayments(accountId, 10, {
        paidAt: afterFirst.paidAt,
        paymentId: afterFirst.paymentId,
      });
      expect(nextPage.map((row) => row.paymentId)).toEqual(['p-pending']);

      const tied = new Date(paidLater.getTime() + 1_000);
      await store.upsertPayments([
        { ...pending, paymentId: 'p-tie-a', paidAt: tied, firstSeenAt: tied, updatedAt: tied },
        { ...pending, paymentId: 'p-tie-b', paidAt: tied, firstSeenAt: tied, updatedAt: tied },
      ]);
      const tiePage = await store.listPayments(accountId, 10, {
        paidAt: tied,
        paymentId: 'p-tie-b',
      });
      expect(tiePage.map((row) => row.paymentId)).toEqual(['p-tie-a', 'p-later', 'p-pending']);

      // An observation older than the stored state never overwrites it.
      await store.upsertPayments([{ ...pending, status: 'pending', updatedAt: firstSeen }]);
      const notRegressed = (await store.listPayments(accountId, 10)).find(
        (row) => row.paymentId === 'p-pending',
      );
      expect(notRegressed?.status).toBe('completed');

      // A resolved category is upgraded from a fallback but never turned back into one.
      await store.upsertPayments([
        {
          ...pending,
          status: 'completed',
          category: 'gift',
          updatedAt: new Date(Date.now() + 20_000),
        },
      ]);
      await store.upsertPayments([
        {
          ...pending,
          status: 'completed',
          category: 'outside_lightning',
          updatedAt: new Date(Date.now() + 30_000),
        },
      ]);
      const kept = (await store.listPayments(accountId, 10)).find(
        (row) => row.paymentId === 'p-pending',
      );
      expect(kept?.category).toBe('gift');
      expect((await walletPaymentChanges('p-pending')).map((row) => row.op)).toEqual([
        'INSERT',
        'UPDATE',
        'UPDATE',
        'UPDATE',
        'UPDATE',
      ]);

      // Stored at t0, an identical re-send observed at t2, then a slower different report from t1: t1 is ignored.
      const t0 = new Date(Date.now() + 40_000);
      const t1 = new Date(t0.getTime() + 1_000);
      const t2 = new Date(t0.getTime() + 2_000);
      const watermark = { ...pending, paymentId: 'p-watermark', status: 'completed' as const };
      await store.upsertPayments([{ ...watermark, firstSeenAt: t0, updatedAt: t0 }]);
      await store.upsertPayments([{ ...watermark, firstSeenAt: t2, updatedAt: t2 }]);
      await store.upsertPayments([
        { ...watermark, status: 'pending', firstSeenAt: t1, updatedAt: t1 },
      ]);
      const watermarked = (await store.listPayments(accountId, 10)).find(
        (row) => row.paymentId === 'p-watermark',
      );
      expect(watermarked?.status).toBe('completed');
      expect(watermarked?.updatedAt.getTime()).toBe(t0.getTime());

      const preimage = '0123456789abcdef'.repeat(4);
      const phrase =
        'abandon ability able about above absent absorb abstract absurd abuse access accident';
      const parsed = parseWalletReport(
        {
          balanceSats: 1000,
          syncedAt: new Date().toISOString(),
          payments: [
            {
              id: 'p-secret',
              direction: 'out',
              status: 'completed',
              amountSats: 21,
              feeSats: 0,
              timestamp: Math.floor(Date.now() / 1000),
              method: 'lightning',
              preimage,
              description: phrase,
            },
          ],
        },
        Date.now(),
      );
      if (!parsed.ok) {
        throw new Error('expected parsed wallet report');
      }
      const secretPayment = parsed.report.payments[0];
      if (secretPayment === undefined) {
        throw new Error('expected one parsed payment');
      }
      const secretSeen = new Date();
      await store.upsertPayments([
        {
          ...secretPayment,
          accountId,
          category: 'unknown',
          counterpartyAccountId: null,
          firstSeenAt: secretSeen,
          updatedAt: secretSeen,
        },
      ]);

      const paymentRows = await client.query(`SELECT * FROM wallet_payment WHERE account_id = $1`, [
        accountId,
      ]);
      const changeRows = await client.query(
        `SELECT * FROM db_change WHERE table_name IN ('wallet_payment', 'wallet_balance_snapshot')`,
      );
      const dump = JSON.stringify({ paymentRows, changeRows });
      expect(dump.includes(preimage)).toBe(false);
      expect(dump.includes(phrase)).toBe(false);
      expect(dump.includes('preimage')).toBe(false);

      const snapshotChanges = await client.query<{
        op: string;
        before: unknown;
        after: Record<string, unknown> | null;
      }>(
        `SELECT op, before, after FROM db_change
         WHERE table_name = 'wallet_balance_snapshot' AND after ->> 'id' = $1
         ORDER BY id ASC`,
        [snapshotId],
      );
      expect(snapshotChanges).toHaveLength(1);
      expect(snapshotChanges[0]?.op).toBe('INSERT');
      expect(snapshotChanges[0]?.before).toBeNull();
      expect(snapshotChanges[0]?.after?.['account_id']).toBe(accountId);
      expect(Number(snapshotChanges[0]?.after?.['balance_sats'])).toBe(1000);
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('aggregates completed payments by direction with bigint sums', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateAuthSchema(client);
      await migrateWalletSchema(client);

      const auth = new PostgresAuthStore(client);
      const accountId = crypto.randomUUID();
      const otherId = crypto.randomUUID();
      const hex64 = (): string =>
        `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
      for (const [id, username] of [
        [accountId, `summary_${accountId.slice(0, 8)}`],
        [otherId, `summary_${otherId.slice(0, 8)}`],
      ] as const) {
        await auth.createAccount({
          id,
          linkingKey: null,
          role: 'basis',
          name: null,
          username,
          location: null,
          forumLawsDismissed: false,
          viewKey: hex64(),
          createdAt: Date.now(),
          rulesAgreedAt: null,
          walletRequired: true,
        });
      }

      const store = new PostgresWalletStore(client);
      const at = new Date();
      const row = (
        account: string,
        paymentId: string,
        direction: 'in' | 'out',
        status: 'pending' | 'completed' | 'failed',
        amountSats: number,
        feeSats: number,
      ): WalletPaymentRecord => ({
        accountId: account,
        paymentId,
        direction,
        status,
        amountSats,
        feeSats,
        paidAt: at,
        method: 'spark',
        paymentHash: null,
        invoice: null,
        destination: null,
        description: null,
        lnurlComment: null,
        category: 'unknown',
        counterpartyAccountId: null,
        firstSeenAt: at,
        updatedAt: at,
      });
      await store.upsertPayments([
        row(accountId, 'in-1', 'in', 'completed', 1_000, 0),
        row(accountId, 'in-2', 'in', 'completed', 250, 0),
        row(accountId, 'out-1', 'out', 'completed', 40, 2),
        row(accountId, 'out-2', 'out', 'completed', 1, 3),
        row(accountId, 'pending', 'in', 'pending', 9_999, 0),
        row(accountId, 'failed', 'out', 'failed', 8_888, 0),
        row(otherId, 'other', 'in', 'completed', 7_777, 0),
      ]);

      await expect(store.paymentTotals(accountId)).resolves.toEqual({
        receivedSats: 1_250n,
        paidOutSats: 41n,
        feesSats: 5n,
      });
      await expect(store.paymentTotals(crypto.randomUUID())).resolves.toEqual({
        receivedSats: 0n,
        paidOutSats: 0n,
        feesSats: 0n,
      });
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('dailyBalances keeps the last snapshot per UTC day and buildWalletStats carries balances', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    const auth = new PostgresAuthStore(client);
    const accountPrefix = crypto.randomUUID().slice(0, 23);
    const snapshotPrefix = crypto.randomUUID().slice(0, 23);
    const orderedId = (prefix: string, suffix: number): string =>
      `${prefix}-${String(suffix).padStart(12, '0')}`;
    const accountA = orderedId(accountPrefix, 1);
    const accountB = orderedId(accountPrefix, 2);
    const snapshotId = (suffix: number): string => orderedId(snapshotPrefix, suffix);
    const hex64 = (): string =>
      `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
    let seeded = false;
    try {
      await migrateAuthSchema(client);
      await migrateWalletSchema(client);
      await migrateDbChangeSchema(client);
      seeded = true;
      for (const [index, accountId] of [accountA, accountB].entries()) {
        await auth.createAccount({
          id: accountId,
          linkingKey: null,
          role: 'basis',
          name: null,
          username: `wd${index}${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
          location: null,
          forumLawsDismissed: false,
          viewKey: hex64(),
          createdAt: Date.now(),
          rulesAgreedAt: null,
          walletRequired: true,
        });
      }

      const store = new PostgresWalletStore(client);
      const rows = [
        {
          id: snapshotId(1),
          accountId: accountA,
          balanceSats: 100,
          receivedAt: '2026-11-09T00:00:00.000Z',
        },
        {
          id: snapshotId(3),
          accountId: accountA,
          balanceSats: 300,
          receivedAt: '2026-11-09T12:00:00.000Z',
        },
        {
          id: snapshotId(2),
          accountId: accountA,
          balanceSats: 200,
          receivedAt: '2026-11-09T12:00:00.000Z',
        },
        {
          id: snapshotId(4),
          accountId: accountA,
          balanceSats: 400,
          receivedAt: '2026-11-10T00:00:00.000Z',
        },
        {
          id: snapshotId(5),
          accountId: accountA,
          balanceSats: 500,
          receivedAt: '2026-11-10T12:00:00.000Z',
        },
        {
          id: snapshotId(6),
          accountId: accountB,
          balanceSats: 40,
          receivedAt: '2026-11-09T12:00:00.000Z',
        },
        {
          id: snapshotId(7),
          accountId: accountB,
          balanceSats: 50,
          receivedAt: '2026-11-09T23:59:59.999Z',
        },
        {
          id: snapshotId(8),
          accountId: accountB,
          balanceSats: 60,
          receivedAt: '2026-11-10T00:00:00.000Z',
        },
        {
          id: snapshotId(9),
          accountId: accountB,
          balanceSats: 80,
          receivedAt: '2026-11-10T12:00:00.000Z',
        },
      ] as const;
      for (const row of rows) {
        const receivedAt = new Date(row.receivedAt);
        await store.recordBalance({
          id: row.id,
          accountId: row.accountId,
          balanceSats: row.balanceSats,
          syncedAt: receivedAt,
          receivedAt,
        });
      }

      const daily = await store.dailyBalances();
      const accountIds = new Set([accountA, accountB]);
      const dailyForAccounts = daily.filter((row) => accountIds.has(row.accountId));
      expect(
        dailyForAccounts.map((row) => ({
          id: row.id,
          accountId: row.accountId,
          balanceSats: row.balanceSats,
          receivedAt: row.receivedAt.toISOString(),
        })),
      ).toEqual([
        {
          id: rows[1].id,
          accountId: accountA,
          balanceSats: 300,
          receivedAt: '2026-11-09T12:00:00.000Z',
        },
        {
          id: rows[4].id,
          accountId: accountA,
          balanceSats: 500,
          receivedAt: '2026-11-10T12:00:00.000Z',
        },
        {
          id: rows[6].id,
          accountId: accountB,
          balanceSats: 50,
          receivedAt: '2026-11-09T23:59:59.999Z',
        },
        {
          id: rows[8].id,
          accountId: accountB,
          balanceSats: 80,
          receivedAt: '2026-11-10T12:00:00.000Z',
        },
      ]);

      expect(buildWalletStats(dailyForAccounts, Date.parse('2026-11-10T12:00:00.000Z'))).toEqual({
        walletCount: 2,
        fundedWalletCount: 2,
        totalSats: 580,
        totalBtc: '0.00000580',
        asOf: '2026-11-10T12:00:00.000Z',
        balanceOverTime: [
          {
            day: '2026-11-09',
            totalSats: 350,
            totalBtc: '0.00000350',
            walletCount: 2,
            fundedWalletCount: 2,
          },
          {
            day: '2026-11-10',
            totalSats: 580,
            totalBtc: '0.00000580',
            walletCount: 2,
            fundedWalletCount: 2,
          },
        ],
      });
    } finally {
      if (seeded) {
        await client.execute(
          'DELETE FROM wallet_balance_snapshot WHERE account_id = ANY($1::uuid[])',
          [postgresTextArrayLiteral([accountA, accountB])],
        );
        await client.execute('DELETE FROM account WHERE id = ANY($1::uuid[])', [
          postgresTextArrayLiteral([accountA, accountB]),
        ]);
      }
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresFondPayoutStore', () => {
  test('aggregates paid rows and sums their USD strings', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateFondPayoutSchema(client);
      const store = new PostgresFondPayoutStore(client);
      const stamp = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
      const address = `paid_${stamp}@example.com`;
      const add = async (id: string, amountUsd: string): Promise<FondPayoutEnqueue> => {
        const row: FondPayoutEnqueue = {
          id: crypto.randomUUID(),
          utcDay: '2099-01-01',
          kind: 'welcome',
          address: `${id}_${address}`,
          amountUsd,
          comment: 'summary',
          messageId: null,
          groupMessageId: null,
        };
        await store.enqueue(row);
        return row;
      };
      const paidA = await add('a', '1.00');
      const paidB = await add('b', '2.50');
      await add('open', '9.99');
      for (const row of [paidA, paidB]) {
        await store.claimForInvoice(row.id, row.utcDay);
        await store.setInvoiced(row.id, {
          invoiceId: `inv-${row.id}`,
          paymentHash: crypto.randomUUID().replaceAll('-', '').repeat(2),
          bolt11: 'lnbc1',
          amountMsat: 1_000_000,
        });
        await store.claimSettlement(row.id);
        await store.markPaid(row.id);
      }

      const before = await store.paidTotals();
      await add('c', '1.00');
      await add('d', '2.50');
      for (const rowAddress of [`c_${address}`, `d_${address}`]) {
        const [row] = await client.query<{ id: string; utc_day: string }>(
          `SELECT id, utc_day FROM fond_payout WHERE address = $1`,
          [rowAddress],
        );
        if (row === undefined) {
          throw new Error('expected payout row');
        }
        await store.claimForInvoice(row.id, '2099-01-01');
        await store.setInvoiced(row.id, {
          invoiceId: `inv-${row.id}`,
          paymentHash: crypto.randomUUID().replaceAll('-', '').repeat(2),
          bolt11: 'lnbc1',
          amountMsat: 1_000_000,
        });
        await store.claimSettlement(row.id);
        await store.markPaid(row.id);
      }
      const after = await store.paidTotals();
      expect(after.payoutsPaid - before.payoutsPaid).toBe(2);
      const cents = (value: string): bigint => {
        const [whole = '0', frac = ''] = value.split('.');
        return BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0'));
      };
      expect(cents(after.payoutsPaidUsd) - cents(before.payoutsPaidUsd)).toBe(350n);
    } finally {
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresWalletStore pairing by payment id', () => {
  const setup = async (): Promise<{
    client: SqlClient;
    sql: SQL;
    store: PostgresWalletStore;
    newAccount: () => Promise<string>;
    row: (id: string) => Promise<Record<string, unknown> | undefined>;
  }> => {
    const { client, sql } = createBunSqlClient(databaseUrl, { max: 8 });
    await migrateAuthSchema(client);
    await migrateMessageSchema(client);
    await migrateWalletSchema(client);
    await migrateDbChangeSchema(client);
    const auth = new PostgresAuthStore(client);
    const newAccount = async (): Promise<string> => {
      const id = crypto.randomUUID();
      const hex = id.replaceAll('-', '');
      await auth.createAccount({
        id,
        linkingKey: null,
        role: 'basis',
        name: null,
        username: `pair_${hex.slice(0, 16)}`,
        location: null,
        forumLawsDismissed: false,
        viewKey: hex.padEnd(64, 'e'),
        createdAt: Date.now(),
        rulesAgreedAt: null,
        walletRequired: true,
      });
      return id;
    };
    const row = async (accountId: string): Promise<Record<string, unknown> | undefined> =>
      (
        await client.query<Record<string, unknown>>(
          `SELECT category, counterparty_account_id, updated_at, last_observed_at, description
           FROM wallet_payment WHERE account_id = $1`,
          [accountId],
        )
      )[0];
    return { client, sql, store: new PostgresWalletStore(client), newAccount, row };
  };

  const base = Date.now() - 60_000;
  const at = (offsetMs: number): Date => new Date(base + offsetMs);

  /** An outgoing transfer the sender's wallet reported without any detail. */
  const bare = (
    accountId: string,
    paymentId: string,
    extra: Partial<WalletPaymentRecord> = {},
  ): WalletPaymentRecord => ({
    accountId,
    paymentId,
    direction: 'out',
    status: 'completed',
    amountSats: 500,
    feeSats: 0,
    paidAt: at(0),
    method: 'spark',
    paymentHash: null,
    invoice: null,
    destination: null,
    description: null,
    lnurlComment: null,
    category: 'unknown',
    counterpartyAccountId: null,
    firstSeenAt: at(0),
    updatedAt: at(0),
    ...extra,
  });

  /** The receiver's side of the same transfer, categorized as a zap from `sender`. */
  const zapIn = (
    accountId: string,
    paymentId: string,
    sender: string,
    extra: Partial<WalletPaymentRecord> = {},
  ): WalletPaymentRecord =>
    bare(accountId, paymentId, {
      direction: 'in',
      description: `zap:${'c'.repeat(64)}`,
      category: 'gift',
      counterpartyAccountId: sender,
      ...extra,
    });

  test('fills either side in either order, names a shop, and never overwrites own categories', async () => {
    const { client, sql, store, newAccount, row } = await setup();
    const shopNoteId = crypto.randomUUID();
    try {
      const transfer = (): string => `pair-${crypto.randomUUID()}`;

      // Categorized in-row first, bare out-row later.
      const [s1, r1] = [await newAccount(), await newAccount()];
      const p1 = transfer();
      await store.upsertPayments([zapIn(r1, p1, s1, { updatedAt: at(1) })]);
      await store.upsertPayments([bare(s1, p1, { updatedAt: at(2) })]);
      expect(await row(s1)).toMatchObject({
        category: 'gift',
        counterparty_account_id: r1,
        description: null,
      });

      // Bare out-row first, categorized in-row later fills the earlier row.
      const [s2, r2] = [await newAccount(), await newAccount()];
      const p2 = transfer();
      await store.upsertPayments([bare(s2, p2, { updatedAt: at(1) })]);
      expect((await row(s2))?.['category']).toBe('unknown');
      await store.upsertPayments([zapIn(r2, p2, s2, { updatedAt: at(5) })]);
      const filled = await row(s2);
      expect(filled).toMatchObject({ category: 'gift', counterparty_account_id: r2 });
      expect(new Date(filled?.['updated_at'] as string).getTime()).toBe(at(5).getTime());
      // The watermark of the filled row stays its own last observation.
      expect(new Date(filled?.['last_observed_at'] as string).getTime()).toBe(at(1).getTime());
      const changes = await client.query<{ op: string; before: Record<string, unknown> }>(
        `SELECT op, before FROM db_change
         WHERE table_name = 'wallet_payment' AND after ->> 'account_id' = $1
         ORDER BY id ASC`,
        [s2],
      );
      expect(changes.map((change) => change.op)).toEqual(['INSERT', 'UPDATE']);
      expect(changes[1]?.before['category']).toBe('unknown');

      // Reverse direction: a bare in-row from a shop's resolved out-row is a shop payment.
      const [shop, buyer] = [await newAccount(), await newAccount()];
      await new PostgresMessageStore(client).create({
        id: shopNoteId,
        accountId: shop,
        name: 'Shop',
        text: 'Open today #21GiftsShop',
        createdAt: new Date(),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        shopAccount: { id: shop, username: null, name: 'Shop' },
      });
      const p3 = transfer();
      await store.upsertPayments([bare(buyer, p3, { direction: 'in' })]);
      await store.upsertPayments([
        bare(shop, p3, { category: 'member', counterpartyAccountId: buyer, updatedAt: at(1) }),
      ]);
      expect(await row(buyer)).toMatchObject({ category: 'shop', counterparty_account_id: shop });

      // A category the row's own fields determined is never replaced.
      const [s4, r4] = [await newAccount(), await newAccount()];
      const p4 = transfer();
      await store.upsertPayments([bare(s4, p4, { category: 'outside_lightning' })]);
      await store.upsertPayments([zapIn(r4, p4, s4, { updatedAt: at(1) })]);
      expect(await row(s4)).toMatchObject({
        category: 'outside_lightning',
        counterparty_account_id: null,
      });

      // A third row makes the payment id ambiguous: nothing is paired.
      const [s5, r5, x5] = [await newAccount(), await newAccount(), await newAccount()];
      const p5 = transfer();
      await store.upsertPayments([zapIn(r5, p5, s5), zapIn(x5, p5, s5)]);
      await store.upsertPayments([bare(s5, p5, { updatedAt: at(1) })]);
      expect(await row(s5)).toMatchObject({ category: 'unknown', counterparty_account_id: null });

      // Same direction on two accounts is no pair.
      const [s6, r6] = [await newAccount(), await newAccount()];
      const p6 = transfer();
      await store.upsertPayments([zapIn(r6, p6, s6, { direction: 'out' })]);
      await store.upsertPayments([bare(s6, p6, { updatedAt: at(1) })]);
      expect((await row(s6))?.['category']).toBe('unknown');
    } finally {
      // Other tests count the live shop notes of the shared database.
      await client.execute('DELETE FROM message WHERE id = $1', [shopNoteId]);
      await closeIfPossible(sql);
    }
  });

  test('concurrent reports of both sides always pair', async () => {
    const { sql, store, newAccount, row } = await setup();
    try {
      for (let round = 0; round < 20; round += 1) {
        const [sender, receiver] = [await newAccount(), await newAccount()];
        const paymentId = `race-${crypto.randomUUID()}`;
        await Promise.all([
          store.upsertPayments([bare(sender, paymentId)]),
          store.upsertPayments([zapIn(receiver, paymentId, sender)]),
        ]);
        expect(await row(sender)).toMatchObject({
          category: 'gift',
          counterparty_account_id: receiver,
        });
      }
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('the repair fills exactly the eligible stored rows and a second run changes nothing', async () => {
    const { client, sql, newAccount, row } = await setup();
    try {
      const insert = async (
        record: WalletPaymentRecord,
        lastObservedAt: Date | null,
      ): Promise<void> => {
        await client.execute(
          `INSERT INTO wallet_payment (account_id, payment_id, direction, status, amount_sats,
             fee_sats, paid_at, method, description, category, counterparty_account_id,
             first_seen_at, updated_at, last_observed_at)
           VALUES ($1,$2,$3,'completed',500,0,$4,'spark',$5,$6,$7,$8,$8,$9)`,
          [
            record.accountId,
            record.paymentId,
            record.direction,
            record.paidAt,
            record.description,
            record.category,
            record.counterpartyAccountId,
            record.updatedAt,
            lastObservedAt,
          ],
        );
      };
      const [sender, receiver, own, ownPeer, amb, ambA, ambB, lone] = [
        await newAccount(),
        await newAccount(),
        await newAccount(),
        await newAccount(),
        await newAccount(),
        await newAccount(),
        await newAccount(),
        await newAccount(),
      ];
      const stamp = crypto.randomUUID();
      // Eligible: stored before pairing existed, without a watermark.
      await insert(bare(sender, `repair-${stamp}`, { updatedAt: at(1) }), null);
      await insert(zapIn(receiver, `repair-${stamp}`, sender, { updatedAt: at(2) }), at(2));
      // Not eligible: own category, ambiguous id, no other side.
      await insert(bare(own, `own-${stamp}`, { category: 'onchain' }), at(0));
      await insert(zapIn(ownPeer, `own-${stamp}`, own), at(0));
      await insert(bare(amb, `amb-${stamp}`), at(0));
      await insert(zapIn(ambA, `amb-${stamp}`, amb), at(0));
      await insert(zapIn(ambB, `amb-${stamp}`, amb), at(0));
      await insert(bare(lone, `lone-${stamp}`), at(0));

      const now = new Date();
      expect(await repairWalletPaymentPairs(client, now)).toBeGreaterThanOrEqual(1);
      const repaired = await row(sender);
      expect(repaired).toMatchObject({ category: 'gift', counterparty_account_id: receiver });
      expect(new Date(repaired?.['updated_at'] as string).getTime()).toBe(now.getTime());
      // The pre-column row keeps its old watermark instead of the repair time.
      expect(new Date(repaired?.['last_observed_at'] as string).getTime()).toBe(at(1).getTime());
      expect(await row(receiver)).toMatchObject({
        category: 'gift',
        counterparty_account_id: sender,
      });
      expect(await row(own)).toMatchObject({ category: 'onchain', counterparty_account_id: null });
      expect(await row(amb)).toMatchObject({ category: 'unknown', counterparty_account_id: null });
      expect(await row(lone)).toMatchObject({ category: 'unknown', counterparty_account_id: null });

      expect(await repairWalletPaymentPairs(client, new Date())).toBe(0);
    } finally {
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresMemberEventStore', () => {
  test('migrate twice, appendMany, list order, and db_change inserts', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateAuthSchema(client);
      await migrateMemberEventSchema(client);
      await migrateMemberEventSchema(client);
      await migrateDbChangeSchema(client);

      const auth = new PostgresAuthStore(client);
      const hex64 = (): string =>
        `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
      const accountId = crypto.randomUUID();
      await auth.createAccount({
        id: accountId,
        linkingKey: null,
        role: 'basis',
        name: null,
        username: `events_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`,
        location: null,
        forumLawsDismissed: false,
        viewKey: hex64(),
        createdAt: Date.now(),
        rulesAgreedAt: null,
        walletRequired: true,
      });

      const store = new PostgresMemberEventStore(client);
      const olderId = crypto.randomUUID();
      const newerId = crypto.randomUUID();
      const receivedAt = new Date();
      await store.appendMany([
        {
          id: olderId,
          accountId,
          name: 'login',
          at: new Date('2026-01-01T00:00:00.000Z'),
          path: '/old',
          props: {},
          receivedAt,
        },
        {
          id: newerId,
          accountId,
          name: 'screen_view',
          at: new Date('2026-01-02T00:00:00.000Z'),
          path: '/new',
          props: { count: 1 },
          receivedAt,
        },
      ]);

      const listed = await store.listForAccount(accountId, 10);
      expect(listed.map((row) => row.id)).toEqual([newerId, olderId]);
      expect(listed[0]?.name).toBe('screen_view');
      expect(listed[1]?.name).toBe('login');

      const inserts = await client.query<{ op: string }>(
        `SELECT op
         FROM db_change
         WHERE table_name = 'member_event'
           AND op = 'INSERT'
           AND (after ->> 'account_id' = $1)
         ORDER BY id ASC`,
        [accountId],
      );
      expect(inserts).toHaveLength(2);
    } finally {
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresLoginGateStore and session wipe', () => {
  test('switch upsert, allowlist with cascade, deleteAllSessions count, db_change rows', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateAuthSchema(client);
      await migrateLoginGateSchema(client);
      await migrateLoginGateSchema(client);
      await migrateDbChangeSchema(client);

      const store = new PostgresLoginGateStore(client);
      // db_change is append-only and logins_open is a singleton key, so only
      // rows written after this mark prove this run's triggers fired.
      const [mark] = await client.query<{ id: string }>(
        `SELECT COALESCE(MAX(id), 0)::text AS id FROM db_change`,
      );
      await client.execute(`DELETE FROM app_setting WHERE key = 'logins_open'`);
      expect(await store.loginsOpen()).toBeNull();
      await store.setLoginsOpen(false, Date.now());
      expect(await store.loginsOpen()).toBe(false);
      await store.setLoginsOpen(true, Date.now());
      expect(await store.loginsOpen()).toBe(true);

      const auth = new PostgresAuthStore(client);
      const hex64 = (): string =>
        `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
      const accountId = crypto.randomUUID();
      await auth.createAccount({
        id: accountId,
        linkingKey: null,
        role: 'basis',
        name: null,
        username: `gate_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`,
        location: null,
        forumLawsDismissed: false,
        viewKey: hex64(),
        createdAt: Date.now(),
        rulesAgreedAt: null,
      });
      expect(await store.addToAllowlist(accountId, 1_000)).toBe(true);
      expect(await store.addToAllowlist(accountId, 2_000)).toBe(false);
      expect(await store.isAllowlisted(accountId)).toBe(true);
      const listed = await store.listAllowlist();
      expect(listed.find((row) => row.accountId === accountId)).toEqual({
        accountId,
        createdAt: 1_000,
      });
      expect(await store.removeFromAllowlist(accountId)).toBe(true);
      expect(await store.removeFromAllowlist(accountId)).toBe(false);
      await store.addToAllowlist(accountId, 3_000);
      await auth.deleteAccount(accountId);
      expect(await store.isAllowlisted(accountId)).toBe(false);

      const sessionOwner = crypto.randomUUID();
      await auth.createAccount({
        id: sessionOwner,
        linkingKey: null,
        role: 'basis',
        name: null,
        username: `wipe_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`,
        location: null,
        forumLawsDismissed: false,
        viewKey: hex64(),
        createdAt: Date.now(),
        rulesAgreedAt: null,
      });
      await auth.deleteAllSessions();
      await auth.createSession({ token: hex64(), accountId: sessionOwner, createdAt: Date.now() });
      await auth.createSession({ token: hex64(), accountId: sessionOwner, createdAt: Date.now() });
      expect(await auth.deleteAllSessions()).toBe(2);
      expect(await auth.deleteAllSessions()).toBe(0);

      const changes = await client.query<{ table_name: string; op: string }>(
        `SELECT table_name, op
         FROM db_change
         WHERE id > $3::bigint
           AND ((table_name = 'app_setting'
                AND COALESCE(after->>'key', before->>'key') = 'logins_open'
                AND COALESCE(after->>'value', '') = 'open'
                AND COALESCE(before->>'value', '') = 'closed')
            OR (table_name = 'login_allowlist'
                AND COALESCE(after->>'account_id', before->>'account_id') = $1)
            OR (table_name = 'auth_session'
                AND COALESCE(after->>'account_id', before->>'account_id') = $2))`,
        [accountId, sessionOwner, mark?.id ?? '0'],
      );
      const seen = new Set(changes.map((row) => `${row.table_name}:${row.op}`));
      expect(seen.has('app_setting:UPDATE')).toBe(true);
      expect(seen.has('login_allowlist:INSERT')).toBe(true);
      expect(seen.has('login_allowlist:DELETE')).toBe(true);
      expect(seen.has('auth_session:DELETE')).toBe(true);
    } finally {
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresDebugDbStore member data tables', () => {
  test('lists the wallet and event tables and pages wallet_payment by its composite key', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateAuthSchema(client);
      await migrateWalletSchema(client);
      await migrateMemberEventSchema(client);

      const auth = new PostgresAuthStore(client);
      const hex64 = (): string =>
        `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
      const accountId = crypto.randomUUID();
      await auth.createAccount({
        id: accountId,
        linkingKey: null,
        role: 'basis',
        name: null,
        username: `debugdb_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`,
        location: null,
        forumLawsDismissed: false,
        viewKey: hex64(),
        createdAt: Date.now(),
        rulesAgreedAt: null,
        walletRequired: true,
      });

      const now = new Date();
      const wallet = new PostgresWalletStore(client);
      await wallet.recordBalance({
        id: crypto.randomUUID(),
        accountId,
        balanceSats: 5,
        syncedAt: now,
        receivedAt: now,
      });
      const paymentIds = Array.from(
        { length: DEBUG_DB_PAGE_SIZE + 1 },
        (_, index) => `debugdb-${String(index).padStart(3, '0')}`,
      );
      await wallet.upsertPayments(
        paymentIds.map((paymentId) => ({
          accountId,
          paymentId,
          direction: 'in' as const,
          status: 'completed' as const,
          amountSats: 1,
          feeSats: 0,
          paidAt: now,
          method: 'spark',
          paymentHash: null,
          invoice: null,
          destination: null,
          description: null,
          lnurlComment: null,
          category: 'unknown' as const,
          counterpartyAccountId: null,
          firstSeenAt: now,
          updatedAt: now,
        })),
      );
      await new PostgresMemberEventStore(client).appendMany([
        {
          id: crypto.randomUUID(),
          accountId,
          name: 'logout',
          at: now,
          path: '/settings',
          props: {},
          receivedAt: now,
        },
      ]);

      const store = new PostgresDebugDbStore(client);
      const tables = await store.listTables();
      const count = (name: string): number =>
        tables.find((table) => table.name === name)?.rowCount ?? -1;
      expect(count('wallet_balance_snapshot')).toBeGreaterThanOrEqual(1);
      expect(count('wallet_payment')).toBeGreaterThanOrEqual(paymentIds.length);
      expect(count('wallet_transfer')).toBeGreaterThanOrEqual(0);
      expect(count('member_event')).toBeGreaterThanOrEqual(1);

      const seen: string[] = [];
      let pages = 0;
      let cursor: string | null = null;
      do {
        const page = await store.readPage('wallet_payment', cursor);
        if (page === undefined) {
          throw new Error('expected wallet_payment to be listed');
        }
        expect(page.columns).toContain('last_observed_at');
        for (const row of page.rows) {
          if (row['account_id'] === accountId) {
            seen.push(String(row['payment_id']));
          }
        }
        pages += 1;
        cursor = page.nextCursor;
      } while (cursor !== null);
      expect(pages).toBeGreaterThan(1);
      expect(seen.sort()).toEqual(paymentIds);

      const events = await store.readPage('member_event', null);
      expect(events?.columns).toEqual(
        expect.arrayContaining(['account_id', 'name', 'at', 'path', 'props', 'received_at']),
      );
    } finally {
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresMessageStore deleteById on a credit', () => {
  test('a credit with sats survives a hard delete and a plain note does not', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    const accountId = crypto.randomUUID();
    const creditId = crypto.randomUUID();
    const plainId = crypto.randomUUID();
    let ready = false;
    try {
      await migrateAuthSchema(client);
      await migrateBtcUsdSchema(client);
      await migrateFiatSchema(client);
      await migrateMessageSchema(client);
      await migrateShopIdentitySchema(client);
      ready = true;
      await new PostgresAuthStore(client).createAccount({
        id: accountId,
        linkingKey: `02${accountId.replaceAll('-', '').padEnd(64, '0')}`,
        role: 'verified',
        name: 'Ada',
        forumLawsDismissed: false,
        location: null,
        viewKey: accountId.replaceAll('-', '').padEnd(64, 'a'),
        createdAt: 1,
        rulesAgreedAt: null,
      });
      const store = new PostgresMessageStore(client);
      const base = {
        accountId,
        name: 'Ada',
        createdAt: new Date(),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      };
      await store.create({
        ...base,
        id: creditId,
        text: 'credit',
        goalSats: 10,
        goalRepayable: true,
      });
      await store.create({ ...base, id: plainId, text: 'plain' });
      await client.execute('UPDATE message SET sats = 5 WHERE id = $1', [creditId]);
      expect(await store.deleteById(creditId)).toBe(false);
      expect((await store.getById(creditId))?.sats).toBe(5);
      expect(await store.deleteById(plainId)).toBe(true);
      expect(await store.getById(plainId)).toBeUndefined();
    } finally {
      if (ready) {
        await client.execute('DELETE FROM message WHERE account_id = $1', [accountId]);
        await client.execute('DELETE FROM account WHERE id = $1', [accountId]);
      }
      await closeIfPossible(sql);
    }
  });

  test('a payment committed during a hide or a hard delete wins over both', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    const accountId = crypto.randomUUID();
    const creditId = crypto.randomUUID();
    const replyId = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    let ready = false;
    const settled = async (pending: Promise<boolean>): Promise<boolean> => {
      const marker = Symbol('pending');
      const first = await Promise.race([pending, Bun.sleep(300).then(() => marker)]);
      return first !== marker;
    };
    try {
      await migrateAuthSchema(client);
      await migrateBtcUsdSchema(client);
      await migrateFiatSchema(client);
      await migrateMessageSchema(client);
      await migrateShopIdentitySchema(client);
      ready = true;
      await new PostgresAuthStore(client).createAccount({
        id: accountId,
        linkingKey: `02${accountId.replaceAll('-', '').padEnd(64, '1')}`,
        role: 'verified',
        name: 'Ada',
        forumLawsDismissed: false,
        location: null,
        viewKey: accountId.replaceAll('-', '').padEnd(64, 'b'),
        createdAt: 1,
        rulesAgreedAt: null,
      });
      const store = new PostgresMessageStore(client);
      const base = {
        accountId,
        name: 'Ada',
        createdAt: new Date(),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      };
      await store.create({
        ...base,
        id: creditId,
        text: 'credit',
        goalSats: 10,
        goalRepayable: true,
      });
      await store.create({ ...base, id: replyId, parentId: creditId, text: 'reply' });
      await store.create({
        ...base,
        id: otherId,
        text: 'other',
        goalSats: 10,
        goalRepayable: true,
      });

      const payer = await sql.reserve();
      try {
        await payer.unsafe('BEGIN');
        await payer.unsafe('UPDATE message SET sats = 5 WHERE id = $1', [creditId]);
        const hide = store.markDeleted(creditId, new Date(), accountId, 0);
        expect(await settled(hide)).toBe(false);
        await payer.unsafe('COMMIT');
        expect(await hide).toBe(false);
      } finally {
        payer.release();
      }
      expect((await store.getById(creditId))?.deletedAt).toBeNull();
      expect((await store.getById(replyId))?.deletedAt).toBeNull();

      const second = await sql.reserve();
      try {
        await second.unsafe('BEGIN');
        await second.unsafe('UPDATE message SET sats = 5 WHERE id = $1', [otherId]);
        const remove = store.deleteById(otherId);
        expect(await settled(remove)).toBe(false);
        await second.unsafe('COMMIT');
        expect(await remove).toBe(false);
      } finally {
        second.release();
      }
      expect((await store.getById(otherId))?.sats).toBe(5);
    } finally {
      if (ready) {
        await client.execute('DELETE FROM message WHERE parent_id = $1', [creditId]);
        await client.execute('DELETE FROM message WHERE account_id = $1', [accountId]);
        await client.execute('DELETE FROM account WHERE id = $1', [accountId]);
      }
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresMessageStore loan ledger fiat', () => {
  test('oldest same-note indexed ingest sets grant chf, and bare-grant and repayment fiat stay null', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    const authorId = crypto.randomUUID();
    const payerId = crypto.randomUUID();
    const loanId = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    const receiptId = `receipt-${crypto.randomUUID()}`;
    const bareReceiptId = `receipt-${crypto.randomUUID()}`;
    let ready = false;
    try {
      await migrateAuthSchema(client);
      await migrateBtcUsdSchema(client);
      await migrateFiatSchema(client);
      await migrateMessageSchema(client);
      await migrateShopIdentitySchema(client);
      ready = true;
      const auth = new PostgresAuthStore(client);
      await auth.createAccount({
        id: authorId,
        linkingKey: `02${authorId.replaceAll('-', '').padEnd(64, '0')}`,
        role: 'verified',
        name: 'Ada',
        forumLawsDismissed: false,
        location: null,
        viewKey: authorId.replaceAll('-', '').padEnd(64, 'a'),
        createdAt: 1,
        rulesAgreedAt: null,
      });
      await auth.createAccount({
        id: payerId,
        linkingKey: `02${payerId.replaceAll('-', '').padEnd(64, '1')}`,
        role: 'verified',
        name: 'Bea',
        forumLawsDismissed: false,
        location: null,
        viewKey: payerId.replaceAll('-', '').padEnd(64, 'b'),
        createdAt: 1,
        rulesAgreedAt: null,
      });
      const store = new PostgresMessageStore(client);
      const base = {
        accountId: authorId,
        name: 'Ada',
        createdAt: new Date(),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      };
      await store.create({
        ...base,
        id: loanId,
        text: 'loan',
        goalSats: 1_000_000,
        goalRepayable: true,
      });
      await store.create({ ...base, id: otherId, text: 'other' });
      expect(await store.recordZapReceipt(receiptId, loanId, 450, null)).toBe(true);
      await store.updateZapReceiptGift(receiptId, { payerAccountId: payerId });
      const recordIngest = (
        createdAt: string,
        outcome: 'indexed' | 'rejected',
        amountChf: string,
        messageId: string,
      ): Promise<void> =>
        store.recordZapIngest({
          id: crypto.randomUUID(),
          createdAt: new Date(createdAt),
          receiptId,
          noteEventId: null,
          messageId,
          outcome,
          reason: null,
          amountSats: 450,
          amountChf,
          receiptPubkey: null,
          receipt: { id: receiptId, kind: 9735 },
        });
      const grantChf = async (sats: number): Promise<(string | null)[]> =>
        (await store.listLoanLedger(payerId))
          .filter((row) => row.kind === 'grant' && row.sats === sats)
          .map((row) => row.amountChf);
      await recordIngest('2026-06-03T00:00:00.000Z', 'indexed', '4.50', loanId);
      await recordIngest('2026-06-04T00:00:00.000Z', 'indexed', '1.00', loanId);
      expect(await grantChf(450)).toEqual(['4.50']);
      await recordIngest('2026-06-02T00:00:00.000Z', 'indexed', '77.77', otherId);
      expect(await grantChf(450)).toEqual(['4.50']);
      await recordIngest('2026-06-01T00:00:00.000Z', 'rejected', '99.99', loanId);
      expect(await grantChf(450)).toEqual(['4.50']);
      expect(await store.listCreditPayers(loanId)).toEqual([
        {
          accountId: payerId,
          sats: 450,
          usd: null,
          chf: '4.50',
          eur: null,
          php: null,
        },
      ]);
      expect(await store.recordZapReceipt(bareReceiptId, loanId, 8, null)).toBe(true);
      await store.updateZapReceiptGift(bareReceiptId, { payerAccountId: payerId });
      const bareFiat = (await store.listLoanLedger(payerId))
        .filter((row) => row.kind === 'grant' && row.sats === 8)
        .map((row) => ({
          amountUsd: row.amountUsd,
          amountChf: row.amountChf,
          amountEur: row.amountEur,
          amountPhp: row.amountPhp,
        }));
      expect(bareFiat).toEqual([
        { amountUsd: null, amountChf: null, amountEur: null, amountPhp: null },
      ]);
      await store.markRepaymentPaid({
        messageId: loanId,
        dayIndex: 0,
        recipientAccountId: payerId,
        dueSats: 40,
        paidAt: new Date('2026-06-05T00:00:00.000Z'),
      });
      const repaymentFiat = (await store.listLoanLedger(payerId))
        .filter((row) => row.kind === 'repayment' && row.sats === 40)
        .map((row) => ({
          amountUsd: row.amountUsd,
          amountChf: row.amountChf,
          amountEur: row.amountEur,
          amountPhp: row.amountPhp,
        }));
      expect(repaymentFiat).toEqual([
        { amountUsd: null, amountChf: null, amountEur: null, amountPhp: null },
      ]);
    } finally {
      if (ready) {
        await client.execute('DELETE FROM nostr_zap_ingest WHERE receipt_id = $1', [receiptId]);
        await client.execute('DELETE FROM nostr_zap_receipt WHERE message_id = $1', [loanId]);
        await client.execute('DELETE FROM message_repayment WHERE message_id = $1', [loanId]);
        await client.execute('DELETE FROM message WHERE id = $1 OR id = $2', [loanId, otherId]);
        await client.execute('DELETE FROM account WHERE id = $1 OR id = $2', [authorId, payerId]);
      }
      await closeIfPossible(sql);
    }
  });

  test('early fiat close endpoint includes earlier-microsecond receipts in its response', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    const authorId = crypto.randomUUID();
    const payerId = crypto.randomUUID();
    const loanId = crypto.randomUUID();
    const receiptId = `receipt-${crypto.randomUUID()}`;
    const unassignedReceiptId = `receipt-${crypto.randomUUID()}`;
    let ready = false;
    try {
      await migrateAuthSchema(client);
      await migrateBtcUsdSchema(client);
      await migrateFiatSchema(client);
      await migrateMessageSchema(client);
      await migrateShopIdentitySchema(client);
      ready = true;
      const auth = new PostgresAuthStore(client);
      const nowMs = Date.now();
      for (const [id, suffix] of [
        [authorId, 'a'],
        [payerId, 'b'],
      ] as const) {
        await auth.createAccount({
          id,
          linkingKey: `02${id.replaceAll('-', '').padEnd(64, suffix)}`,
          role: 'verified',
          name: suffix,
          forumLawsDismissed: false,
          location: null,
          viewKey: id.replaceAll('-', '').padEnd(64, suffix),
          createdAt: nowMs,
          rulesAgreedAt: nowMs,
        });
      }
      const sessionToken = `close-${crypto.randomUUID()}`;
      await auth.createSession({ token: sessionToken, accountId: authorId, createdAt: nowMs });
      const store = new PostgresMessageStore(client);
      await store.create({
        id: loanId,
        accountId: authorId,
        name: 'Ada',
        text: 'microsecond close',
        createdAt: new Date(),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        goalSats: 1_000,
        goalCurrency: 'USD',
        goalAmount: '10.00',
        goalRepayable: true,
        goalTermDays: 1,
      });
      expect(await store.recordZapReceipt(receiptId, loanId, 100, null)).toBe(true);
      await store.updateZapReceiptGift(receiptId, { payerAccountId: payerId });
      expect(await store.recordZapReceipt(unassignedReceiptId, loanId, 7, null)).toBe(true);
      await store.recordZapIngest({
        id: crypto.randomUUID(),
        createdAt: new Date(),
        receiptId,
        noteEventId: null,
        messageId: loanId,
        outcome: 'indexed',
        reason: null,
        amountSats: 100,
        amountUsd: '1.23',
        receiptPubkey: null,
        receipt: { id: receiptId, kind: 9735 },
      });
      await client.execute(
        `UPDATE nostr_zap_receipt
         SET recorded_at = '2026-11-11T12:00:00.123456Z'::timestamptz
         WHERE event_id = $1::text`,
        [receiptId],
      );
      await client.execute(
        `UPDATE nostr_zap_receipt
         SET recorded_at = '2026-11-11T12:00:00.123500Z'::timestamptz
         WHERE event_id = $1::text`,
        [unassignedReceiptId],
      );
      await client.execute(
        `UPDATE message
         SET goal_closed_at = '2026-11-11T12:00:00.123789Z'::timestamptz
         WHERE id = $1::uuid`,
        [loanId],
      );

      const app = new Hono().route(
        '/messages',
        messagesRoutes({ store, authStore: auth, now: () => nowMs }),
      );
      const response = await app.request(`/messages/${loanId}/repayment/close`, {
        method: 'POST',
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        collectedSats: 107,
        collectedAmount: '1.23',
      });
      const snapshot = await client.query<{
        units: string;
        funded_at: string;
        closed_at: string;
      }>(
        `SELECT snapshot.units::text AS units,
                message.goal_funded_at::text AS funded_at,
                message.goal_closed_at::text AS closed_at
         FROM message_credit_payer_snapshot AS snapshot
         JOIN message ON message.id = snapshot.message_id
         WHERE snapshot.message_id = $1::uuid AND snapshot.account_id = $2::uuid`,
        [loanId, payerId],
      );
      expect(snapshot).toEqual([
        expect.objectContaining({
          units: '123',
          funded_at: expect.stringContaining('.123789'),
          closed_at: expect.stringContaining('.123789'),
        }),
      ]);
    } finally {
      if (ready) {
        await client.execute('DELETE FROM auth_session WHERE account_id = $1::uuid', [authorId]);
        await client.execute('DELETE FROM nostr_zap_ingest WHERE receipt_id = $1', [receiptId]);
        await client.execute('DELETE FROM nostr_zap_receipt WHERE message_id = $1', [loanId]);
        await client.execute('DELETE FROM message WHERE id = $1', [loanId]);
        await client.execute('DELETE FROM account WHERE id = $1 OR id = $2', [authorId, payerId]);
      }
      await closeIfPossible(sql);
    }
  });
});

/** Every table `mergeAccounts` names, so the merge runs end to end. */
async function migrateMergeTables(client: SqlClient): Promise<void> {
  await migrateAuthSchema(client);
  await migrateBtcUsdSchema(client);
  await migrateFiatSchema(client);
  await migrateMessageSchema(client);
  await migratePosSchema(client);
  await migrateShopPaymentSchema(client);
  await migrateConversationSchema(client);
  await migratePushSchema(client);
  await migrateNotificationSchema(client);
  await migrateTrustSchema(client);
  await migrateFundingSchema(client);
  await migrateBannerSchema(client);
  await migrateWalletSchema(client);
  await migrateDailyRosterSchema(client);
  await migrateWelcomeInvoiceReservationSchema(client);
}

describe('Postgres wallet-transfer account merge reconciliation', () => {
  const hex64 = (): string =>
    `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
  type TransferState = {
    direction: 'in' | 'out';
    type: 'transfer' | 'swap';
    status: 'pending' | 'completed' | 'expired';
    amountSats: number;
    updatedAt: string | null;
    seenAt: string;
    shopPayment?: boolean;
  };
  const completedSource: TransferState = {
    direction: 'out',
    type: 'transfer',
    status: 'completed',
    amountSats: 21,
    updatedAt: null,
    seenAt: '2026-11-12T12:00:00.000Z',
  };
  const completedSurvivor: TransferState = {
    ...completedSource,
    amountSats: 22,
  };
  const cases: ReadonlyArray<{
    name: string;
    source: TransferState;
    survivor: TransferState;
    expected: 'source' | 'survivor';
    hasShopPayment: boolean;
  }> = [
    {
      name: 'keeps the source when only it has an operator update time',
      source: {
        direction: 'in',
        type: 'swap',
        status: 'expired',
        amountSats: 31,
        updatedAt: '2026-11-12T11:00:00.000Z',
        seenAt: '2026-11-12T12:00:00.000Z',
      },
      survivor: {
        ...completedSurvivor,
        seenAt: '2026-11-12T13:00:00.000Z',
      },
      expected: 'source',
      hasShopPayment: false,
    },
    {
      name: 'keeps the survivor when only it has an operator update time',
      source: {
        ...completedSource,
        seenAt: '2026-11-12T13:00:00.000Z',
      },
      survivor: {
        direction: 'in',
        type: 'swap',
        status: 'expired',
        amountSats: 32,
        updatedAt: '2026-11-12T11:00:00.000Z',
        seenAt: '2026-11-12T12:00:00.000Z',
      },
      expected: 'survivor',
      hasShopPayment: false,
    },
    {
      name: 'keeps the survivor when operator update times are equal',
      source: {
        ...completedSource,
        updatedAt: '2026-11-12T11:00:00.000Z',
        seenAt: '2026-11-12T13:00:00.000Z',
      },
      survivor: {
        direction: 'in',
        type: 'swap',
        status: 'pending',
        amountSats: 33,
        updatedAt: '2026-11-12T11:00:00.000Z',
        seenAt: '2026-11-12T12:00:00.000Z',
      },
      expected: 'survivor',
      hasShopPayment: false,
    },
    {
      name: 'keeps a completed outgoing source over a later-seen expired survivor',
      source: completedSource,
      survivor: {
        direction: 'in',
        type: 'swap',
        status: 'expired',
        amountSats: 34,
        updatedAt: null,
        seenAt: '2026-11-12T13:00:00.000Z',
      },
      expected: 'source',
      hasShopPayment: true,
    },
    {
      name: 'keeps a completed outgoing survivor over a later-seen expired source',
      source: {
        direction: 'in',
        type: 'swap',
        status: 'expired',
        amountSats: 35,
        updatedAt: null,
        seenAt: '2026-11-12T13:00:00.000Z',
      },
      survivor: completedSurvivor,
      expected: 'survivor',
      hasShopPayment: true,
    },
    {
      name: 'keeps a completed outgoing source over a later-seen pending survivor',
      source: completedSource,
      survivor: {
        direction: 'in',
        type: 'transfer',
        status: 'pending',
        amountSats: 36,
        updatedAt: null,
        seenAt: '2026-11-12T13:00:00.000Z',
      },
      expected: 'source',
      hasShopPayment: true,
    },
    {
      name: 'keeps a completed outgoing survivor over a later-seen pending source',
      source: {
        direction: 'in',
        type: 'transfer',
        status: 'pending',
        amountSats: 37,
        updatedAt: null,
        seenAt: '2026-11-12T13:00:00.000Z',
      },
      survivor: completedSurvivor,
      expected: 'survivor',
      hasShopPayment: true,
    },
    {
      name: 'keeps a shop-counted source over a later-seen non-shop completed transfer',
      source: { ...completedSource, amountSats: 38, shopPayment: true },
      survivor: {
        ...completedSurvivor,
        amountSats: 39,
        seenAt: '2026-11-12T13:00:00.000Z',
        shopPayment: false,
      },
      expected: 'source',
      hasShopPayment: true,
    },
    {
      name: 'keeps a shop-counted survivor over a later-seen non-shop completed transfer',
      source: {
        ...completedSource,
        amountSats: 40,
        seenAt: '2026-11-12T13:00:00.000Z',
        shopPayment: false,
      },
      survivor: { ...completedSurvivor, amountSats: 41, shopPayment: true },
      expected: 'survivor',
      hasShopPayment: true,
    },
    {
      name: 'keeps a non-shop final source over a later-seen pending survivor',
      source: {
        direction: 'in',
        type: 'swap',
        status: 'expired',
        amountSats: 42,
        updatedAt: null,
        seenAt: '2026-11-12T12:00:00.000Z',
      },
      survivor: {
        direction: 'in',
        type: 'swap',
        status: 'pending',
        amountSats: 43,
        updatedAt: null,
        seenAt: '2026-11-12T13:00:00.000Z',
      },
      expected: 'source',
      hasShopPayment: false,
    },
    {
      name: 'keeps a non-shop final survivor over a later-seen pending source',
      source: {
        direction: 'in',
        type: 'swap',
        status: 'pending',
        amountSats: 44,
        updatedAt: null,
        seenAt: '2026-11-12T13:00:00.000Z',
      },
      survivor: {
        direction: 'in',
        type: 'swap',
        status: 'expired',
        amountSats: 45,
        updatedAt: null,
        seenAt: '2026-11-12T12:00:00.000Z',
      },
      expected: 'survivor',
      hasShopPayment: false,
    },
    {
      name: 'keeps the later-seen source when states are equivalent',
      source: {
        direction: 'in',
        type: 'swap',
        status: 'expired',
        amountSats: 46,
        updatedAt: null,
        seenAt: '2026-11-12T13:00:00.000Z',
      },
      survivor: {
        direction: 'in',
        type: 'swap',
        status: 'expired',
        amountSats: 47,
        updatedAt: null,
        seenAt: '2026-11-12T12:00:00.000Z',
      },
      expected: 'source',
      hasShopPayment: false,
    },
    {
      name: 'keeps the later-seen survivor when states are equivalent',
      source: {
        direction: 'in',
        type: 'swap',
        status: 'expired',
        amountSats: 48,
        updatedAt: null,
        seenAt: '2026-11-12T12:00:00.000Z',
      },
      survivor: {
        direction: 'in',
        type: 'swap',
        status: 'expired',
        amountSats: 49,
        updatedAt: null,
        seenAt: '2026-11-12T13:00:00.000Z',
      },
      expected: 'survivor',
      hasShopPayment: false,
    },
    {
      name: 'keeps the survivor when equivalent states have tied observation times',
      source: {
        direction: 'in',
        type: 'swap',
        status: 'expired',
        amountSats: 50,
        updatedAt: null,
        seenAt: '2026-11-12T12:00:00.000Z',
      },
      survivor: {
        direction: 'in',
        type: 'swap',
        status: 'expired',
        amountSats: 51,
        updatedAt: null,
        seenAt: '2026-11-12T12:00:00.000Z',
      },
      expected: 'survivor',
      hasShopPayment: false,
    },
  ];

  for (const mergeCase of cases) {
    test(mergeCase.name, async () => {
      const { client, mergeDb, sql } = createBunSqlClient(databaseUrl);
      const from = crypto.randomUUID();
      const into = crypto.randomUUID();
      const shop = crypto.randomUUID();
      const shopMessageId = crypto.randomUUID();
      const walletPubkey = `02${hex64()}`;
      const shopPubkey = `03${hex64()}`;
      const externalPubkey = `02${hex64()}`;
      const transferId = crypto.randomUUID();
      try {
        await migrateMergeTables(client);
        const auth = new PostgresAuthStore(client);
        for (const [id, username] of [
          [from, `merge_transfer_from_${from.slice(0, 8)}`],
          [into, `merge_transfer_into_${into.slice(0, 8)}`],
          [shop, `merge_transfer_shop_${shop.slice(0, 8)}`],
        ] as const) {
          await auth.createAccount({
            id,
            linkingKey: null,
            role: 'basis',
            name: null,
            username,
            location: null,
            forumLawsDismissed: false,
            viewKey: hex64(),
            createdAt: Date.now(),
            rulesAgreedAt: null,
            walletRequired: true,
          });
        }
        await client.execute(
          'UPDATE account SET spark_pubkey = $2, spark_pubkey_verified_at = now() WHERE id = $1',
          [shop, shopPubkey],
        );
        await new PostgresMessageStore(client).create({
          id: shopMessageId,
          accountId: shop,
          name: 'Merge shop',
          text: 'Open #21GiftsShop',
          createdAt: new Date('2026-11-12T10:00:00.000Z'),
          hasPhoto: false,
          ...unsignedNostrDefaults(),
          shopAccount: { id: shop, username: null, name: 'Merge shop' },
        });
        const insertTransfer = async (accountId: string, state: TransferState): Promise<void> => {
          const shopPayment =
            state.shopPayment ??
            (state.status === 'completed' &&
              state.direction === 'out' &&
              state.type === 'transfer');
          const counterpartyPubkey = shopPayment ? shopPubkey : externalPubkey;
          const createdAt = new Date(`2026-11-12T10:${String(state.amountSats)}:00.000Z`);
          await client.execute(
            `INSERT INTO wallet_transfer (
               account_id, wallet_pubkey, transfer_id, direction, type, status,
               amount_sats, counterparty_pubkey, counterparty_pubkeys,
               counterparty_account_id, spark_invoice, transfer_created_at,
               transfer_updated_at, first_seen_at, last_seen_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, ARRAY[$8], $9, $10, $11, $12, $11, $13
             )`,
            [
              accountId,
              walletPubkey,
              transferId,
              state.direction,
              state.type,
              state.status,
              state.amountSats,
              counterpartyPubkey,
              shopPayment ? shop : null,
              `invoice-${state.amountSats}`,
              createdAt,
              state.updatedAt === null ? null : new Date(state.updatedAt),
              new Date(state.seenAt),
            ],
          );
        };
        await insertTransfer(from, mergeCase.source);
        await insertTransfer(into, mergeCase.survivor);

        expect(await mergeAccounts(mergeDb, { from, into, verify: 'into' })).toEqual({
          ok: true,
          messages: 0,
        });
        const expected = mergeCase.expected === 'source' ? mergeCase.source : mergeCase.survivor;
        const expectedShopPayment =
          expected.shopPayment ??
          (expected.status === 'completed' &&
            expected.direction === 'out' &&
            expected.type === 'transfer');
        const expectedCounterpartyPubkey = expectedShopPayment ? shopPubkey : externalPubkey;
        await expect(
          client.query<{
            status: string;
            direction: string;
            type: string;
            amount_sats: string;
            counterparty_pubkey: string;
            counterparty_pubkeys: string[];
            counterparty_account_id: string | null;
            spark_invoice: string | null;
            transfer_created_at: Date;
            transfer_updated_at: Date | null;
          }>(
            `SELECT status, direction, type, amount_sats::text AS amount_sats,
                    counterparty_pubkey, counterparty_pubkeys,
                    counterparty_account_id, spark_invoice, transfer_created_at,
                    transfer_updated_at
             FROM wallet_transfer
             WHERE account_id = $1 AND wallet_pubkey = $2 AND transfer_id = $3`,
            [into, walletPubkey, transferId],
          ),
        ).resolves.toEqual([
          {
            status: expected.status,
            direction: expected.direction,
            type: expected.type,
            amount_sats: String(expected.amountSats),
            counterparty_pubkey: expectedCounterpartyPubkey,
            counterparty_pubkeys: [expectedCounterpartyPubkey],
            counterparty_account_id: expectedShopPayment ? shop : null,
            spark_invoice: `invoice-${expected.amountSats}`,
            transfer_created_at: new Date(`2026-11-12T10:${String(expected.amountSats)}:00.000Z`),
            transfer_updated_at: expected.updatedAt === null ? null : new Date(expected.updatedAt),
          },
        ]);
        await expect(
          new PostgresWalletTransferStore(client).hasShopPayment(into, '2026-11-11', '2026-11-13'),
        ).resolves.toBe(mergeCase.hasShopPayment);
      } finally {
        await client.execute('DELETE FROM wallet_transfer WHERE account_id IN ($1, $2)', [
          from,
          into,
        ]);
        await client.execute('DELETE FROM message WHERE id = $1', [shopMessageId]);
        await client.execute('DELETE FROM account WHERE id IN ($1, $2, $3)', [from, into, shop]);
        await closeIfPossible(sql);
      }
    });
  }
});

describe('Postgres welcome reservation account merge', () => {
  test('keeps the later lease without colliding its unique reservation id', async () => {
    const cases = [
      {
        name: 'source later',
        sourceExpiryOffset: -60_000,
        destinationExpiryOffset: -120_000,
        expected: 'source',
      },
      {
        name: 'equal expiry',
        sourceExpiryOffset: -60_000,
        destinationExpiryOffset: -60_000,
        expected: 'destination',
      },
      {
        name: 'source earlier',
        sourceExpiryOffset: -120_000,
        destinationExpiryOffset: -60_000,
        expected: 'destination',
      },
    ] as const;

    for (const entry of cases) {
      const { client, mergeDb, sql } = createBunSqlClient(databaseUrl);
      const fromId = crypto.randomUUID();
      const intoId = crypto.randomUUID();
      const sourceReservation = crypto.randomUUID().replaceAll('-', '');
      const destinationReservation = crypto.randomUUID().replaceAll('-', '');
      try {
        await migrateMergeTables(client);
        const auth = new PostgresAuthStore(client);
        for (const [id, suffix] of [
          [fromId, 'a'],
          [intoId, 'b'],
        ] as const) {
          await auth.createAccount({
            id,
            linkingKey: null,
            role: 'verified',
            name: `${entry.name}-${suffix}`,
            forumLawsDismissed: false,
            location: null,
            viewKey: id.replaceAll('-', '').padEnd(64, suffix),
            createdAt: 1,
            rulesAgreedAt: null,
          });
        }
        const now = Date.now();
        const createdAt = new Date(now - 600_000);
        const sourceExpiry = new Date(now + entry.sourceExpiryOffset);
        const destinationExpiry = new Date(now + entry.destinationExpiryOffset);
        await client.execute(
          `INSERT INTO welcome_invoice_reservation
             (account_id, reservation_id, created_at, expires_at)
           VALUES ($1,$2,$3,$4),($5,$6,$3,$7)`,
          [
            fromId,
            sourceReservation,
            createdAt,
            sourceExpiry,
            intoId,
            destinationReservation,
            destinationExpiry,
          ],
        );

        expect(
          await mergeAccounts(mergeDb, { from: fromId, into: intoId, verify: 'into' }),
        ).toEqual({ ok: true, messages: 0 });
        await expect(
          client.query<{ account_id: string; reservation_id: string; expires_at: Date }>(
            `SELECT account_id, reservation_id, expires_at
             FROM welcome_invoice_reservation WHERE account_id = $1`,
            [intoId],
          ),
        ).resolves.toEqual([
          {
            account_id: intoId,
            reservation_id:
              entry.expected === 'source' ? sourceReservation : destinationReservation,
            expires_at: entry.expected === 'source' ? sourceExpiry : destinationExpiry,
          },
        ]);
      } finally {
        await client.execute('DELETE FROM welcome_invoice_reservation WHERE account_id = $1', [
          intoId,
        ]);
        await client.execute('DELETE FROM account WHERE id = $1 OR id = $2', [fromId, intoId]);
        await closeIfPossible(sql);
      }
    }
  });

  test('refuses without writes while both accounts have live welcome leases', async () => {
    const { client, mergeDb, sql } = createBunSqlClient(databaseUrl);
    const fromId = crypto.randomUUID();
    const intoId = crypto.randomUUID();
    const sourceReservation = crypto.randomUUID().replaceAll('-', '');
    const destinationReservation = crypto.randomUUID().replaceAll('-', '');
    try {
      await migrateMergeTables(client);
      const auth = new PostgresAuthStore(client);
      for (const [id, suffix] of [
        [fromId, 'a'],
        [intoId, 'b'],
      ] as const) {
        await auth.createAccount({
          id,
          linkingKey: null,
          role: 'verified',
          name: `live-welcome-${suffix}`,
          forumLawsDismissed: false,
          location: null,
          viewKey: id.replaceAll('-', '').padEnd(64, suffix),
          createdAt: 1,
          rulesAgreedAt: null,
        });
      }
      const createdAt = new Date();
      await client.execute(
        `INSERT INTO welcome_invoice_reservation
           (account_id, reservation_id, created_at, expires_at)
         VALUES ($1,$2,$3,$4),($5,$6,$3,$7)`,
        [
          fromId,
          sourceReservation,
          createdAt,
          new Date(createdAt.getTime() + 600_000),
          intoId,
          destinationReservation,
          new Date(createdAt.getTime() + 900_000),
        ],
      );

      expect(await mergeAccounts(mergeDb, { from: fromId, into: intoId, verify: 'into' })).toEqual({
        ok: false,
        error: 'welcome_invoice_open',
      });
      await expect(
        client.query<{ account_id: string; reservation_id: string }>(
          `SELECT account_id, reservation_id FROM welcome_invoice_reservation
           WHERE account_id IN ($1, $2) ORDER BY account_id`,
          [fromId, intoId],
        ),
      ).resolves.toEqual(
        [
          { account_id: fromId, reservation_id: sourceReservation },
          { account_id: intoId, reservation_id: destinationReservation },
        ].sort((left, right) => left.account_id.localeCompare(right.account_id)),
      );
      await expect(
        client.query<{ id: string }>('SELECT id FROM account WHERE id IN ($1, $2) ORDER BY id', [
          fromId,
          intoId,
        ]),
      ).resolves.toEqual([{ id: fromId }, { id: intoId }].sort((a, b) => a.id.localeCompare(b.id)));
    } finally {
      await client.execute('DELETE FROM welcome_invoice_reservation WHERE account_id IN ($1, $2)', [
        fromId,
        intoId,
      ]);
      await client.execute('DELETE FROM account WHERE id = $1 OR id = $2', [fromId, intoId]);
      await closeIfPossible(sql);
    }
  });
});

describe('Postgres zap settlement during account merge', () => {
  test('a merge completed after invoice lookup attributes the receipt to the survivor', async () => {
    const { client, mergeDb, sql } = createBunSqlClient(databaseUrl);
    const authorId = crypto.randomUUID();
    const fromId = crypto.randomUUID();
    const intoId = crypto.randomUUID();
    const loanId = crypto.randomUUID();
    const paymentHash = crypto.randomUUID().replaceAll('-', '').padEnd(64, '0');
    const receiptId = manualReceiptIdForPaymentHash(paymentHash);
    let ready = false;
    let releaseSettlement = (): void => undefined;
    const settlementGate = new Promise<void>((resolve) => {
      releaseSettlement = resolve;
    });
    let reachedLock = (): void => undefined;
    const beforeLock = new Promise<void>((resolve) => {
      reachedLock = resolve;
    });
    try {
      await migrateMergeTables(client);
      ready = true;
      const auth = new PostgresAuthStore(client);
      for (const [id, suffix] of [
        [authorId, 'a'],
        [fromId, 'b'],
        [intoId, 'c'],
      ] as const) {
        await auth.createAccount({
          id,
          linkingKey: null,
          role: 'verified',
          name: suffix,
          forumLawsDismissed: false,
          location: null,
          viewKey: id.replaceAll('-', '').padEnd(64, suffix),
          createdAt: 1,
          rulesAgreedAt: null,
        });
      }
      class PausedBeforeLockStore extends PostgresMessageStore {
        override async withMessageLock<T>(
          messageId: string,
          run: (store: MessageStore) => Promise<T>,
        ): Promise<T> {
          reachedLock();
          await settlementGate;
          return super.withMessageLock(messageId, run);
        }
      }
      const store = new PausedBeforeLockStore(client);
      await store.create({
        id: loanId,
        accountId: authorId,
        name: 'Ada',
        text: 'merge during zap settlement',
        createdAt: new Date(),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        goalSats: 100,
        goalRepayable: true,
        goalTermDays: 1,
      });
      await store.recordInvoiceAttempt({
        id: crypto.randomUUID(),
        createdAt: new Date(),
        messageId: loanId,
        payerAccountId: fromId,
        authorAccountId: authorId,
        amountSats: 21,
        lightningAddress: null,
        zapRequest: null,
        result: 'ok',
        httpStatus: 200,
        pr: `lnbc-merge-settle-${loanId}`,
        paymentHash,
        description: null,
        descriptionHash: null,
        isNip57Invoice: true,
        lnurlResponse: null,
        fiatPinned: true,
        amountUsd: '0.21',
        amountChf: null,
        amountEur: null,
        amountPhp: null,
        heart: true,
      });

      const settling = settleInvoiceManually({
        store,
        auth,
        now: () => Date.parse('2026-11-13T12:00:00.000Z'),
        paymentHash,
        note: 'provider receipt missing',
      });
      await beforeLock;
      expect(await mergeAccounts(mergeDb, { from: fromId, into: intoId, verify: 'into' })).toEqual(
        expect.objectContaining({ ok: true }),
      );
      releaseSettlement();
      await expect(settling).resolves.toMatchObject({ ok: true, receiptId });

      expect(
        await client.query<{ payer_account_id: string }>(
          `SELECT payer_account_id
           FROM nostr_zap_receipt
           WHERE event_id = $1::text`,
          [receiptId],
        ),
      ).toEqual([{ payer_account_id: intoId }]);
    } finally {
      releaseSettlement();
      if (ready) {
        await client.execute('DELETE FROM nostr_zap_payment WHERE payment_hash = $1::text', [
          paymentHash,
        ]);
        await client.execute('DELETE FROM nostr_zap_ingest WHERE receipt_id = $1::text', [
          receiptId,
        ]);
        await client.execute('DELETE FROM nostr_zap_receipt WHERE message_id = $1::uuid', [loanId]);
        await client.execute('DELETE FROM message WHERE id = $1::uuid', [loanId]);
        await client.execute(
          'DELETE FROM account WHERE id = $1::uuid OR id = $2::uuid OR id = $3::uuid',
          [authorId, fromId, intoId],
        );
      }
      await closeIfPossible(sql);
    }
  });
});

describe('Postgres repayment retry after account merge', () => {
  test('an expired unpaid invoice refuses merging its sole giver into an account without a wallet', async () => {
    const { client, mergeDb, sql } = createBunSqlClient(databaseUrl);
    const authorId = crypto.randomUUID();
    const fromId = crypto.randomUUID();
    const intoId = crypto.randomUUID();
    const loanId = crypto.randomUUID();
    const sourceReceiptId = `receipt-${crypto.randomUUID()}`;
    const paymentHash = crypto.randomUUID().replaceAll('-', '').padEnd(64, '0');
    let ready = false;
    try {
      await migrateMergeTables(client);
      ready = true;
      const auth = new PostgresAuthStore(client);
      for (const [id, suffix] of [
        [authorId, 'a'],
        [fromId, 'b'],
        [intoId, 'c'],
      ] as const) {
        await auth.createAccount({
          id,
          linkingKey: null,
          role: 'verified',
          name: suffix,
          forumLawsDismissed: false,
          location: null,
          viewKey: id.replaceAll('-', '').padEnd(64, suffix),
          createdAt: 1,
          rulesAgreedAt: null,
        });
      }
      const store = new PostgresMessageStore(client);
      await store.create({
        id: loanId,
        accountId: authorId,
        name: 'Ada',
        text: 'expired unpaid invoice on a sole-giver credit',
        createdAt: new Date(),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        goalSats: 100,
        goalRepayable: true,
        goalTermDays: 1,
        goalFundedAt: new Date('2099-01-01T00:00:00.000Z'),
      });
      expect(await store.recordZapReceipt(sourceReceiptId, loanId, 100, null)).toBe(true);
      await store.updateZapReceiptGift(sourceReceiptId, { payerAccountId: fromId });
      await store.recordInvoiceAttempt({
        id: crypto.randomUUID(),
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
        messageId: loanId,
        payerAccountId: authorId,
        authorAccountId: fromId,
        amountSats: 100,
        lightningAddress: 'merged-away@example.test',
        zapRequest: null,
        result: 'ok',
        httpStatus: 200,
        pr: `lnbc-expired-sole-giver-${loanId}`,
        paymentHash,
        description: repaymentDescription(0, fromId),
        descriptionHash: null,
        isNip57Invoice: true,
        lnurlResponse: null,
      });

      expect(await mergeAccounts(mergeDb, { from: fromId, into: intoId, verify: 'into' })).toEqual({
        ok: false,
        error: 'repayment_unavailable',
      });
      expect(await auth.getAccount(fromId)).toBeDefined();
      expect(await auth.getAccount(intoId)).toBeDefined();
      expect((await auth.getAccount(intoId))?.sparkPubkey).toBeNull();
    } finally {
      if (ready) {
        await client.execute('DELETE FROM nostr_zap_payment WHERE payment_hash = $1::text', [
          paymentHash,
        ]);
        await client.execute('DELETE FROM nostr_zap_ingest WHERE receipt_id = $1::text', [
          sourceReceiptId,
        ]);
        await client.execute('DELETE FROM nostr_zap_receipt WHERE message_id = $1::uuid', [loanId]);
        await client.execute('DELETE FROM message_invoice WHERE message_id = $1::uuid', [loanId]);
        await client.execute('DELETE FROM message WHERE id = $1::uuid', [loanId]);
        await client.execute(
          'DELETE FROM account WHERE id = $1::uuid OR id = $2::uuid OR id = $3::uuid',
          [authorId, fromId, intoId],
        );
      }
      await closeIfPossible(sql);
    }
  });

  test('expired unpaid legacy and part invoices refuse merging two givers', async () => {
    for (const kind of ['legacy', 'part'] as const) {
      const { client, mergeDb, sql } = createBunSqlClient(databaseUrl);
      const authorId = crypto.randomUUID();
      const fromId = crypto.randomUUID();
      const intoId = crypto.randomUUID();
      const loanId = crypto.randomUUID();
      const sourceReceiptId = `receipt-${crypto.randomUUID()}`;
      const survivorReceiptId = `receipt-${crypto.randomUUID()}`;
      const paymentHash = crypto.randomUUID().replaceAll('-', '').padEnd(64, '0');
      let ready = false;
      try {
        await migrateMergeTables(client);
        ready = true;
        const auth = new PostgresAuthStore(client);
        for (const [id, suffix] of [
          [authorId, 'a'],
          [fromId, 'b'],
          [intoId, 'c'],
        ] as const) {
          await auth.createAccount({
            id,
            linkingKey: null,
            role: 'verified',
            name: suffix,
            forumLawsDismissed: false,
            location: null,
            viewKey: id.replaceAll('-', '').padEnd(64, suffix),
            createdAt: 1,
            rulesAgreedAt: null,
          });
        }
        const store = new PostgresMessageStore(client);
        await store.create({
          id: loanId,
          accountId: authorId,
          name: 'Ada',
          text: `expired unpaid ${kind} invoice on a dual-giver credit`,
          createdAt: new Date(),
          hasPhoto: false,
          ...unsignedNostrDefaults(),
          goalSats: 200,
          goalRepayable: true,
          goalTermDays: 1,
          goalFundedAt: new Date('2099-01-01T00:00:00.000Z'),
        });
        expect(await store.recordZapReceipt(sourceReceiptId, loanId, 100, null)).toBe(true);
        await store.updateZapReceiptGift(sourceReceiptId, { payerAccountId: fromId });
        expect(await store.recordZapReceipt(survivorReceiptId, loanId, 100, null)).toBe(true);
        await store.updateZapReceiptGift(survivorReceiptId, { payerAccountId: intoId });
        await store.recordInvoiceAttempt({
          id: crypto.randomUUID(),
          createdAt: new Date('2020-01-01T00:00:00.000Z'),
          messageId: loanId,
          payerAccountId: authorId,
          authorAccountId: fromId,
          amountSats: 100,
          lightningAddress: 'merged-away@example.test',
          zapRequest: null,
          result: 'ok',
          httpStatus: 200,
          pr: `lnbc-expired-${kind}-${loanId}`,
          paymentHash,
          description:
            kind === 'legacy'
              ? repaymentDescription(0, fromId)
              : repaymentPartDescription(0, fromId, 0, 100n, 100n),
          descriptionHash: null,
          isNip57Invoice: true,
          lnurlResponse: null,
        });

        expect(
          await mergeAccounts(mergeDb, { from: fromId, into: intoId, verify: 'into' }),
        ).toEqual({ ok: false, error: 'repayment_unavailable' });
        expect(await auth.getAccount(fromId)).toBeDefined();
        expect(await auth.getAccount(intoId)).toBeDefined();
      } finally {
        if (ready) {
          await client.execute('DELETE FROM nostr_zap_payment WHERE payment_hash = $1::text', [
            paymentHash,
          ]);
          await client.execute(
            'DELETE FROM nostr_zap_ingest WHERE receipt_id = $1::text OR receipt_id = $2::text',
            [sourceReceiptId, survivorReceiptId],
          );
          await client.execute('DELETE FROM nostr_zap_receipt WHERE message_id = $1::uuid', [
            loanId,
          ]);
          await client.execute('DELETE FROM message_invoice WHERE message_id = $1::uuid', [loanId]);
          await client.execute('DELETE FROM message WHERE id = $1::uuid', [loanId]);
          await client.execute(
            'DELETE FROM account WHERE id = $1::uuid OR id = $2::uuid OR id = $3::uuid',
            [authorId, fromId, intoId],
          );
        }
        await closeIfPossible(sql);
      }
    }
  });

  test('an expired part invoice refuses a merge before it can collide with a legacy payment', async () => {
    const { client, mergeDb, sql } = createBunSqlClient(databaseUrl);
    const authorId = crypto.randomUUID();
    const fromId = crypto.randomUUID();
    const intoId = crypto.randomUUID();
    const loanId = crypto.randomUUID();
    const sourceReceiptId = `receipt-${crypto.randomUUID()}`;
    const paymentHash = crypto.randomUUID().replaceAll('-', '').padEnd(64, '0');
    let ready = false;
    try {
      await migrateMergeTables(client);
      ready = true;
      const auth = new PostgresAuthStore(client);
      for (const [id, suffix] of [
        [authorId, 'a'],
        [fromId, 'b'],
        [intoId, 'c'],
      ] as const) {
        await auth.createAccount({
          id,
          linkingKey: null,
          role: 'verified',
          name: suffix,
          forumLawsDismissed: false,
          location: null,
          viewKey: id.replaceAll('-', '').padEnd(64, suffix),
          createdAt: 1,
          rulesAgreedAt: null,
        });
      }
      const store = new PostgresMessageStore(client);
      await store.create({
        id: loanId,
        accountId: authorId,
        name: 'Ada',
        text: 'expired part before legacy merge',
        createdAt: new Date(),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        goalSats: 100,
        goalRepayable: true,
        goalTermDays: 1,
        goalFundedAt: new Date('2099-01-01T00:00:00.000Z'),
      });
      expect(await store.recordZapReceipt(sourceReceiptId, loanId, 100, null)).toBe(true);
      await store.updateZapReceiptGift(sourceReceiptId, { payerAccountId: fromId });
      await store.recordInvoiceAttempt({
        id: crypto.randomUUID(),
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
        messageId: loanId,
        payerAccountId: authorId,
        authorAccountId: fromId,
        amountSats: 100,
        lightningAddress: 'merged-away@example.test',
        zapRequest: null,
        result: 'ok',
        httpStatus: 200,
        pr: `lnbc-expired-part-${loanId}`,
        paymentHash,
        description: repaymentPartDescription(0, fromId, 0, 100n, 100n),
        descriptionHash: null,
        isNip57Invoice: true,
        lnurlResponse: null,
      });
      const paidAt = new Date('2026-11-12T12:00:00.000Z');
      await store.markRepaymentPaid({
        messageId: loanId,
        dayIndex: 0,
        recipientAccountId: fromId,
        dueSats: 100,
        paidAt,
      });

      expect(await mergeAccounts(mergeDb, { from: fromId, into: intoId, verify: 'into' })).toEqual({
        ok: false,
        error: 'repayment_unavailable',
      });
      expect(await store.listRepayments(loanId)).toEqual([
        expect.objectContaining({
          recipientAccountId: fromId,
          dueSats: 100,
          paidAt,
        }),
      ]);
      expect(await store.listRepaymentParts(loanId)).toEqual([]);
      expect(await auth.getAccount(fromId)).toBeDefined();
      expect(await auth.getAccount(intoId)).toBeDefined();
      expect(await store.zapPaymentReceiptId(paymentHash)).toBeUndefined();
    } finally {
      if (ready) {
        await client.execute('DELETE FROM nostr_zap_payment WHERE payment_hash = $1::text', [
          paymentHash,
        ]);
        await client.execute('DELETE FROM nostr_zap_ingest WHERE receipt_id = $1::text', [
          sourceReceiptId,
        ]);
        await client.execute('DELETE FROM nostr_zap_receipt WHERE message_id = $1::uuid', [loanId]);
        await client.execute('DELETE FROM message_repayment_part WHERE message_id = $1::uuid', [
          loanId,
        ]);
        await client.execute('DELETE FROM message_repayment WHERE message_id = $1::uuid', [loanId]);
        await client.execute('DELETE FROM message WHERE id = $1::uuid', [loanId]);
        await client.execute(
          'DELETE FROM account WHERE id = $1::uuid OR id = $2::uuid OR id = $3::uuid',
          [authorId, fromId, intoId],
        );
      }
      await closeIfPossible(sql);
    }
  });

  test('a claim-only retry settles once and converted legacy survives a second merge', async () => {
    for (const kind of ['legacy', 'part'] as const) {
      const { client, mergeDb, sql } = createBunSqlClient(databaseUrl);
      const authorId = crypto.randomUUID();
      const fromId = crypto.randomUUID();
      const intoId = crypto.randomUUID();
      const finalId = crypto.randomUUID();
      const loanId = crypto.randomUUID();
      const receiptId = `receipt-${crypto.randomUUID()}`;
      const paymentHash = crypto.randomUUID().replaceAll('-', '').padEnd(64, '0');
      let ready = false;
      try {
        await migrateMergeTables(client);
        ready = true;
        const auth = new PostgresAuthStore(client);
        for (const [id, suffix] of [
          [authorId, 'a'],
          [fromId, 'b'],
          [intoId, 'c'],
          [finalId, 'd'],
        ] as const) {
          await auth.createAccount({
            id,
            linkingKey: null,
            role: 'verified',
            name: suffix,
            forumLawsDismissed: false,
            location: null,
            viewKey: id.replaceAll('-', '').padEnd(64, suffix),
            createdAt: 1,
            rulesAgreedAt: null,
          });
        }
        const store = new PostgresMessageStore(client);
        await store.create({
          id: loanId,
          accountId: authorId,
          name: 'Ada',
          text: `${kind} retry`,
          createdAt: new Date(),
          hasPhoto: false,
          ...unsignedNostrDefaults(),
          goalSats: 100,
          goalRepayable: true,
          goalTermDays: 1,
          goalFundedAt: new Date('2099-01-01T00:00:00.000Z'),
        });
        expect(await store.recordZapReceipt(receiptId, loanId, 100, null)).toBe(true);
        await store.updateZapReceiptGift(receiptId, { payerAccountId: fromId });
        await store.recordInvoiceAttempt({
          id: crypto.randomUUID(),
          createdAt: new Date(),
          messageId: loanId,
          payerAccountId: authorId,
          authorAccountId: fromId,
          amountSats: 100,
          lightningAddress: 'merged-away@example.test',
          zapRequest: null,
          result: 'ok',
          httpStatus: 200,
          pr: `lnbc-${kind}-${loanId}`,
          paymentHash,
          description:
            kind === 'legacy'
              ? repaymentDescription(0, fromId)
              : repaymentPartDescription(0, fromId, 0, 100n, 100n),
          descriptionHash: null,
          isNip57Invoice: true,
          lnurlResponse: null,
        });
        const paidAt = new Date('2026-11-12T12:00:00.000Z');
        const settlement: Parameters<PostgresMessageStore['settleRepaymentPayment']>[3] =
          kind === 'legacy'
            ? {
                kind,
                messageId: loanId,
                dayIndex: 0,
                recipientAccountId: fromId,
                dueSats: 100,
                paidAt,
              }
            : {
                kind,
                messageId: loanId,
                dayIndex: 0,
                recipientAccountId: fromId,
                partIndex: 0,
                units: 100n,
                sats: 100,
                shareUnits: 100n,
                paidAt,
              };
        // Reproduce the historical split write: the durable claim committed,
        // then the repayment-row insert failed.
        expect(await store.claimZapPayment(paymentHash, receiptId, paidAt)).toBe(true);
        expect(
          await mergeAccounts(mergeDb, { from: fromId, into: intoId, verify: 'into' }),
        ).toEqual({ ok: false, error: 'repayment_unavailable' });
        expect(
          await store.settleRepaymentPayment(paymentHash, receiptId, paidAt, settlement, true),
        ).toBe(true);
        expect(
          await store.settleRepaymentPayment(paymentHash, receiptId, paidAt, settlement, true),
        ).toBe(true);
        expect(
          await client.query<{ n: number }>(
            `SELECT (
               (SELECT COUNT(*) FROM message_repayment WHERE message_id = $1::uuid) +
               (SELECT COUNT(*) FROM message_repayment_part WHERE message_id = $1::uuid)
             )::integer AS n`,
            [loanId],
          ),
        ).toEqual([{ n: 1 }]);
        expect(
          await client.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM nostr_zap_ingest WHERE receipt_id = $1',
            [receiptId],
          ),
        ).toEqual([{ n: 0 }]);

        expect(
          await mergeAccounts(mergeDb, { from: fromId, into: intoId, verify: 'into' }),
        ).toEqual(expect.objectContaining({ ok: true }));
        const survivingId = kind === 'legacy' ? finalId : intoId;
        if (kind === 'legacy') {
          expect(
            await mergeAccounts(mergeDb, { from: intoId, into: finalId, verify: 'into' }),
          ).toEqual(expect.objectContaining({ ok: true }));
          expect(
            await client.query<{ n: number }>(
              `SELECT (
                 (SELECT COUNT(*) FROM message_repayment WHERE message_id = $1::uuid) +
                 (SELECT COUNT(*) FROM message_repayment_part WHERE message_id = $1::uuid)
               )::integer AS n`,
              [loanId],
            ),
          ).toEqual([{ n: 1 }]);
        }
        const mergedSettlement = { ...settlement, recipientAccountId: survivingId };
        // A legacy row is intentionally canonicalized to a part by the merge,
        // so only the unchanged exact part identity remains an idempotent retry.
        expect(
          await store.settleRepaymentPayment(
            paymentHash,
            receiptId,
            paidAt,
            mergedSettlement,
            true,
          ),
        ).toBe(kind === 'part');

        const rows = await client.query<{ recipient_account_id: string; n: number }>(
          `SELECT recipient_account_id, count(*)::int AS n
           FROM message_repayment_part
           WHERE message_id = $1::uuid
           GROUP BY recipient_account_id
           ORDER BY recipient_account_id`,
          [loanId],
        );
        expect(rows).toEqual([{ recipient_account_id: survivingId, n: 1 }]);
        expect(await auth.getAccount(fromId)).toBeUndefined();
        expect((await auth.getAccount(intoId)) === undefined).toBe(kind === 'legacy');
      } finally {
        if (ready) {
          await client.execute('DELETE FROM nostr_zap_payment WHERE payment_hash = $1', [
            paymentHash,
          ]);
          await client.execute('DELETE FROM nostr_zap_ingest WHERE receipt_id = $1', [receiptId]);
          await client.execute('DELETE FROM nostr_zap_receipt WHERE message_id = $1', [loanId]);
          await client.execute('DELETE FROM message_repayment_part WHERE message_id = $1', [
            loanId,
          ]);
          await client.execute('DELETE FROM message_repayment WHERE message_id = $1', [loanId]);
          await client.execute('DELETE FROM message WHERE id = $1', [loanId]);
          await client.execute(
            'DELETE FROM account WHERE id = $1 OR id = $2 OR id = $3 OR id = $4',
            [authorId, fromId, intoId, finalId],
          );
        }
        await closeIfPossible(sql);
      }
    }
  });
});

describe('PostgresShopPaymentStore', () => {
  const hex64 = (): string =>
    `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
  const hex40 = (): string => `0x${hex64().slice(0, 40)}`;

  const setup = async (): Promise<{
    client: SqlClient;
    mergeDb: MergeDb;
    sql: SQL;
    store: PostgresShopPaymentStore;
    pos: PostgresPosStore;
    newAccount: () => Promise<string>;
  }> => {
    const { client, mergeDb, sql } = createBunSqlClient(databaseUrl);
    await migrateAuthSchema(client);
    await migratePosSchema(client);
    await migrateShopPaymentSchema(client);
    await migrateShopPaymentSchema(client);
    await migrateDbChangeSchema(client);
    const auth = new PostgresAuthStore(client);
    const newAccount = async (): Promise<string> => {
      const id = crypto.randomUUID();
      await auth.createAccount({
        id,
        linkingKey: null,
        role: 'basis',
        name: null,
        username: `shop_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`,
        location: null,
        forumLawsDismissed: false,
        viewKey: hex64(),
        createdAt: Date.now(),
        rulesAgreedAt: null,
        walletRequired: true,
      });
      return id;
    };
    return {
      client,
      mergeDb,
      sql,
      store: new PostgresShopPaymentStore(client, mergeDb),
      pos: new PostgresPosStore(client, mergeDb),
      newAccount,
    };
  };

  function shopPayment(
    accountId: string,
    now: number,
    partial: Partial<ShopPayment> = {},
  ): ShopPayment {
    return {
      id: crypto.randomUUID(),
      accountId,
      amountSats: 2100,
      posChargeId: null,
      bolt11: 'lnbc21',
      paymentHash: hex64(),
      bolt11ExpiresAt: new Date(now + 600_000),
      status: 'open',
      endReason: null,
      windowEndsAt: new Date(now + 300_000),
      replacements: 0,
      nextSettleAt: new Date(now),
      nextHistoryAt: null,
      historyOffset: 0,
      successorWaitUntil: null,
      createdAt: new Date(now),
      acceptedAt: null,
      paidAt: null,
      endedAt: null,
      closedAt: null,
      ...partial,
    };
  }

  function shopOffer(quoteId: string, now: number, partial: Partial<ShopOffer> = {}): ShopOffer {
    return {
      id: crypto.randomUUID(),
      quoteId,
      method: 'Ethereum',
      chainId: 1,
      asset: 'USDT',
      tokenAddress: hex40(),
      depositAddress: hex40(),
      amountIn: '123456789012345678901234567890',
      requiredAmountIn: '1',
      maxAcceptedAmountIn: null,
      decimals: 6,
      minFee: '1000000000',
      providerRef: 'quote-1',
      idempotencyKey: crypto.randomUUID(),
      expiresAt: new Date(now + 120_000),
      detailIssuedAt: null,
      createdAt: new Date(now),
      ...partial,
    };
  }

  function shopProof(
    offer: ShopOffer,
    paymentId: string,
    now: number,
    partial: Partial<ShopProof> = {},
  ): ShopProof {
    return {
      id: crypto.randomUUID(),
      offerId: offer.id,
      paymentId,
      source: 'tx',
      chainId: 1,
      txHash: `0x${hex64()}`,
      logIndex: 0,
      userOpHash: null,
      rawHex: null,
      transferAmount: '1500000',
      idempotencyKey: crypto.randomUUID(),
      result: null,
      providerOrder: null,
      supersededByOrder: null,
      orderStatus: null,
      orderFoundAt: null,
      refusal: null,
      submitStopped: false,
      sentAt: null,
      lastSubmitAt: null,
      giveUpAt: new Date(now + 86_400_000),
      nextSubmitAt: new Date(now),
      nextReceiptAt: null,
      nextStatusAt: null,
      tries: 0,
      resolvedAt: null,
      createdAt: new Date(now),
      ...partial,
    };
  }

  test('every ShopTx method on real Postgres, with conflicts that keep the transaction alive', async () => {
    const { client, sql, store, pos, newAccount } = await setup();
    try {
      const accountId = await newAccount();
      const now = Date.now();
      const chargeId = crypto.randomUUID();
      const charge = {
        id: chargeId,
        accountId,
        amountSats: 2100,
        status: 'pending' as const,
        createdAt: new Date(now),
        expiresAt: new Date(now + POS_CHARGE_TTL_MS),
        paidAt: null,
        sparkInvoice: null,
        amountCurrency: null,
        amountText: null,
        fiatUsd: null,
        fiatChf: null,
        fiatEur: null,
        fiatPhp: null,
      };
      const payment = shopPayment(accountId, now, { posChargeId: chargeId });
      const quoteId = crypto.randomUUID();
      const amounts = [
        {
          method: 'Ethereum',
          minFee: 1,
          assets: [{ asset: 'USDT', amount: '0.21' }],
          available: true,
        },
      ];
      const offerA = shopOffer(quoteId, now);
      const offerB = shopOffer(quoteId, now, {
        asset: 'USDC',
        depositAddress: offerA.depositAddress,
      });
      const offerC = shopOffer(quoteId, now + 1, { method: 'Polygon', chainId: 137 });

      expect(await store.transaction((tx) => tx.lockCharge(chargeId))).toBeNull();
      expect(await store.transaction((tx) => tx.insertCharge(charge))).toBe(true);
      // Step 4 records the charge's hash in its own claim transaction.
      expect(await pos.recordInvoice(chargeId, payment.paymentHash, now)).toEqual({
        outcome: 'recorded',
      });
      await store.transaction(async (tx) => {
        await tx.claimPaymentHash(payment.paymentHash);
        await tx.lockAccount(accountId);
        // A second pending charge hits the unique index; the transaction goes on.
        expect(await tx.insertCharge({ ...charge, id: crypto.randomUUID() })).toBe(false);
        expect((await tx.pendingCharge(accountId, now))?.id).toBe(chargeId);
        expect((await tx.lockCharge(chargeId))?.status).toBe('pending');
        expect(await tx.chargeIdForInvoice(payment.paymentHash)).toBe(chargeId);

        expect(await tx.insertPayment(payment)).toBe(true);
        expect(await tx.insertPayment({ ...payment, id: crypto.randomUUID() })).toBe(false);
        expect(await tx.insertPayment(shopPayment(accountId, now))).toBe(false);
        expect(
          await tx.insertPayment(
            shopPayment(accountId, now, {
              status: 'paid',
              paidAt: new Date(now),
              posChargeId: chargeId,
            }),
          ),
        ).toBe(false);
        expect(await tx.getPayment(payment.id)).toEqual(payment);
        expect(await tx.lockPayment(payment.id.toUpperCase())).toEqual(payment);
        expect((await tx.openPayment(accountId))?.id).toBe(payment.id);
        expect((await tx.paymentForCharge(chargeId))?.id).toBe(payment.id);
        expect((await tx.paymentForHash(payment.paymentHash))?.id).toBe(payment.id);
        expect(await tx.getPayment('not-a-uuid')).toBeNull();

        await tx.insertQuote({
          id: quoteId,
          paymentId: payment.id,
          expiresAt: new Date(now + 120_000),
          transferAmounts: [],
          createdAt: new Date(now),
        });
        const replaced = await tx.updateQuote(quoteId, {
          expiresAt: new Date(now + 60_000),
          transferAmounts: amounts,
        });
        expect(replaced).toEqual({
          id: quoteId,
          paymentId: payment.id,
          expiresAt: new Date(now + 60_000),
          transferAmounts: amounts,
          createdAt: new Date(now),
        });
        expect(await tx.lockQuote(quoteId)).toEqual(replaced);
        expect(await tx.quotesOf(payment.id)).toEqual([replaced!]);
        expect(
          await tx.updateQuote(crypto.randomUUID(), {
            expiresAt: new Date(now),
            transferAmounts: [],
          }),
        ).toBeNull();

        const inserted = await tx.insertOffers([offerA, offerB, offerC]);
        expect(inserted.map((row) => row.id)).toEqual([offerA.id, offerC.id]);
        expect(await tx.getOffer(offerA.id)).toEqual(offerA);
        expect((await tx.offersOf(quoteId)).map((row) => row.id)).toEqual([offerA.id, offerC.id]);
        expect(await tx.markDetailIssued(offerA.id, now + 5)).toBe(true);
        expect(await tx.markDetailIssued(offerA.id, now + 6)).toBe(false);
        expect((await tx.getOffer(offerA.id))?.detailIssuedAt).toEqual(new Date(now + 5));

        const proofA = shopProof(offerA, payment.id, now, { userOpHash: `0x${hex64()}` });
        const proofB = shopProof(offerA, payment.id, now + 1, {
          txHash: proofA.txHash,
          logIndex: 1,
        });
        expect(await tx.insertProof(proofA)).toBe(true);
        expect(await tx.insertProof({ ...proofA, id: crypto.randomUUID() })).toBe(false);
        expect(await tx.insertProof(proofB)).toBe(true);
        expect(await tx.getProof(proofA.id)).toEqual(proofA);
        expect((await tx.proofsOf(payment.id)).map((row) => row.id)).toEqual([
          proofA.id,
          proofB.id,
        ]);
        expect(
          (await tx.findProofs({ chainId: 1, txHash: proofA.txHash })).map((row) => row.id),
        ).toEqual([proofA.id, proofB.id]);
        expect(
          (await tx.findProofs({ chainId: 1, userOpHash: proofA.userOpHash ?? '' })).map(
            (row) => row.id,
          ),
        ).toEqual([proofA.id]);
        const order = `order-${crypto.randomUUID()}`;
        const accepted = await tx.updateProof(
          proofA.id,
          { results: [null], lastSubmitAtOrBefore: new Date(now) },
          {
            result: 'accepted',
            providerOrder: order,
            orderStatus: 'completed',
            resolvedAt: new Date(now + 7),
          },
        );
        expect(accepted).toEqual({
          ...proofA,
          result: 'accepted',
          providerOrder: order,
          orderStatus: 'completed',
          resolvedAt: new Date(now + 7),
        });
        expect((await tx.findProofs({ providerOrder: order })).map((row) => row.id)).toEqual([
          proofA.id,
        ]);
        // Unique violations inside a savepoint: the transaction stays usable.
        expect(await tx.updateProof(proofB.id, {}, { providerOrder: order })).toBe('conflict');
        expect(await tx.updateProof(proofB.id, {}, { logIndex: 0 })).toBe('conflict');
        expect(await tx.updateProof(proofB.id, { results: ['late'] }, { tries: 1 })).toBeNull();
        expect(
          await tx.updateProof(
            proofB.id,
            { results: [null, 'late'] },
            { tries: 2, lastSubmitAt: new Date(now) },
          ),
        ).toMatchObject({ tries: 2 });
        expect(
          await tx.updateProof(
            proofB.id,
            { lastSubmitAtOrBefore: new Date(now - 1) },
            { tries: 3 },
          ),
        ).toBeNull();
        expect(
          (await tx.dueProofs('submit', now + 1, 100_000)).some((row) => row.id === proofB.id),
        ).toBe(true);
        expect(
          (await tx.dueProofs('submit', now + 1, 100_000)).some((row) => row.id === proofA.id),
        ).toBe(false);
        expect(
          (await tx.dueProofs('stuck', now + 86_400_001, 100_000)).some(
            (row) => row.id === proofB.id,
          ),
        ).toBe(true);
        expect(await tx.updateProof(proofA.id, {}, { nextStatusAt: new Date(now) })).not.toBeNull();
        expect(
          (await tx.dueProofs('status', now, 100_000)).some((row) => row.id === proofA.id),
        ).toBe(true);
        expect(
          await tx.updateProof(proofB.id, {}, { nextReceiptAt: new Date(now) }),
        ).not.toBeNull();
        expect(
          (await tx.dueProofs('receipt', now, 100_000)).some((row) => row.id === proofB.id),
        ).toBe(true);
        await tx.deleteProof(proofB.id);
        expect(await tx.getProof(proofB.id)).toBeNull();

        const lookup: ShopProofLookup = {
          id: crypto.randomUUID(),
          quoteId,
          method: 'Ethereum',
          asset: 'USDT',
          chainId: 1,
          hash: `0x${hex64()}`,
          nextTryAt: new Date(now),
          tries: 0,
          doneAt: null,
          createdAt: new Date(now),
        };
        expect(await tx.insertLookup(lookup)).toBe(true);
        expect(await tx.insertLookup({ ...lookup, id: crypto.randomUUID() })).toBe(false);
        expect(await tx.countLookups(quoteId)).toBe(1);
        expect(await tx.findLookup(1, lookup.hash, quoteId)).toEqual(lookup);
        expect((await tx.dueLookups(now, 100_000)).some((row) => row.id === lookup.id)).toBe(true);
        expect(await tx.updateLookup(lookup.id, { tries: 1, doneAt: new Date(now) })).toEqual({
          ...lookup,
          tries: 1,
          doneAt: new Date(now),
        });
        // A done row still counts against the cap of 4 rows per quote.
        expect(await tx.countLookups(quoteId)).toBe(1);
        expect(await tx.countLookups(crypto.randomUUID())).toBe(0);

        expect(
          await tx.updatePayment(payment.id, { statuses: ['accepted'] }, { replacements: 1 }),
        ).toBeNull();
        expect(
          await tx.updatePayment(
            payment.id,
            { windowEndsAfter: new Date(now + 300_000) },
            { replacements: 1 },
          ),
        ).toBeNull();
        const bumped = await tx.updatePayment(
          payment.id,
          { statuses: ['open'], replacements: 0, windowEndsAfter: new Date(now), notClosed: true },
          { replacements: 1, nextHistoryAt: new Date(now), historyOffset: 20 },
        );
        expect(bumped).toEqual({
          ...payment,
          replacements: 1,
          nextHistoryAt: new Date(now),
          historyOffset: 20,
        });
        const settle = (await tx.duePayments('settle', now, 100_000)).map((row) => row.id);
        expect(settle).toContain(payment.id);
        expect((await tx.duePayments('history', now, 100_000)).map((row) => row.id)).toContain(
          payment.id,
        );
        expect((await tx.unsettledPayments(accountId)).map((row) => row.id)).toEqual([payment.id]);
        const ended = await tx.endLapsedWindows(now + 300_000);
        expect(ended.find((row) => row.id === payment.id)).toEqual({
          ...bumped!,
          status: 'ended',
          endReason: 'window',
          endedAt: new Date(now + 300_000),
        });

        await tx.deleteChargeInvoice(payment.paymentHash);
        expect(await tx.chargeIdForInvoice(payment.paymentHash)).toBeNull();
        expect((await tx.cancelPendingCharge(accountId, now + 1))?.id).toBe(chargeId);
        expect(await tx.markChargePaid(chargeId, now + 2)).toBeNull();
      });

      const changes = await client.query<{ table_name: string; op: string }>(
        `SELECT table_name, op FROM db_change
         WHERE table_name LIKE 'shop_%' AND (after ->> 'id' = ANY($1::text[]) OR before ->> 'id' = ANY($1::text[]))
         ORDER BY id ASC`,
        [postgresTextArrayLiteral([payment.id, quoteId, offerA.id])],
      );
      expect(
        changes.filter((row) => row.table_name === 'shop_payment').map((row) => row.op),
      ).toEqual(['INSERT', 'UPDATE', 'UPDATE']);
      expect(changes.some((row) => row.table_name === 'shop_quote' && row.op === 'UPDATE')).toBe(
        true,
      );
      expect(changes.some((row) => row.table_name === 'shop_offer' && row.op === 'UPDATE')).toBe(
        true,
      );
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('a thrown callback rolls back every write, including writes after a caught conflict', async () => {
    const { sql, store, newAccount } = await setup();
    try {
      const accountId = await newAccount();
      const now = Date.now();
      const payment = shopPayment(accountId, now);
      await expect(
        store.transaction(async (tx) => {
          expect(await tx.insertPayment(payment)).toBe(true);
          expect(await tx.insertPayment(shopPayment(accountId, now))).toBe(false);
          await tx.insertQuote({
            id: crypto.randomUUID(),
            paymentId: payment.id,
            expiresAt: new Date(now),
            transferAmounts: [],
            createdAt: new Date(now),
          });
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await store.transaction((tx) => tx.getPayment(payment.id))).toBeNull();
      expect(await store.transaction((tx) => tx.insertPayment(payment))).toBe(true);
      // An update that would open a second payment of the account fails the transaction.
      const second = shopPayment(accountId, now, {
        status: 'ended',
        endReason: 'window',
        endedAt: new Date(now),
      });
      expect(await store.transaction((tx) => tx.insertPayment(second))).toBe(true);
      let refused: unknown;
      try {
        await store.transaction((tx) =>
          tx.updatePayment(second.id, {}, { status: 'open', endReason: null, endedAt: null }),
        );
      } catch (error) {
        refused = error;
      }
      expect(sqlState(refused)).toBe('23505');
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('lockAccount and lockPayment hold FOR UPDATE locks until the transaction ends', async () => {
    const { sql, store, newAccount } = await setup();
    try {
      const accountId = await newAccount();
      const now = Date.now();
      const payment = shopPayment(accountId, now);
      expect(await store.transaction((tx) => tx.insertPayment(payment))).toBe(true);
      const events: string[] = [];
      let locked = (): void => undefined;
      const firstLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const first = store.transaction(async (tx) => {
        await tx.lockAccount(accountId);
        await tx.lockPayment(payment.id);
        locked();
        await new Promise((resolve) => setTimeout(resolve, 300));
        await tx.updatePayment(payment.id, {}, { replacements: 1 });
        events.push('first:commit');
      });
      await firstLocked;
      const second = store.transaction(async (tx) => {
        await tx.lockAccount(accountId);
        events.push('second:account');
        const row = await tx.lockPayment(payment.id);
        events.push(`second:replacements=${row?.replacements}`);
      });
      await Promise.all([first, second]);
      expect(events).toEqual(['first:commit', 'second:account', 'second:replacements=1']);
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('successor_wait_until, superseded_by_order, and shop_proof_superseded_idx exist and round-trip', async () => {
    const { client, sql, store, newAccount } = await setup();
    try {
      const columns = await client.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE (table_name = 'shop_payment' AND column_name = 'successor_wait_until')
            OR (table_name = 'shop_proof' AND column_name = 'superseded_by_order')
         ORDER BY table_name`,
      );
      expect(columns.map((row) => `${row.table_name}.${row.column_name}`)).toEqual([
        'shop_payment.successor_wait_until',
        'shop_proof.superseded_by_order',
      ]);
      const indexes = await client.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'shop_proof_superseded_idx'`,
      );
      expect(indexes).toHaveLength(1);
      expect(indexes[0]?.indexdef).toContain('(payment_id)');
      expect(indexes[0]?.indexdef).toContain('superseded_by_order IS NOT NULL');

      const accountId = await newAccount();
      const now = Date.now();
      const payment = shopPayment(accountId, now, { successorWaitUntil: new Date(now + 1) });
      const quoteId = crypto.randomUUID();
      const offer = shopOffer(quoteId, now);
      const proof = shopProof(offer, payment.id, now, { supersededByOrder: `order-${quoteId}` });
      await store.transaction(async (tx) => {
        expect(await tx.insertPayment(payment)).toBe(true);
        expect(await tx.getPayment(payment.id)).toEqual(payment);
        expect(
          (await tx.updatePayment(payment.id, {}, { successorWaitUntil: new Date(now + 2) }))
            ?.successorWaitUntil,
        ).toEqual(new Date(now + 2));
        await tx.insertQuote({
          id: quoteId,
          paymentId: payment.id,
          expiresAt: new Date(now),
          transferAmounts: [],
          createdAt: new Date(now),
        });
        expect(await tx.insertOffers([offer])).toHaveLength(1);
        expect(await tx.insertProof(proof)).toBe(true);
        expect(await tx.getProof(proof.id)).toEqual(proof);
        const patched = await tx.updateProof(proof.id, {}, { supersededByOrder: null });
        expect(patched === 'conflict' ? 'conflict' : patched?.supersededByOrder).toBeNull();
      });
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('the submits duty needs a log index and the status duty skips a tx_used refusal', async () => {
    const { sql, store, newAccount } = await setup();
    try {
      const accountId = await newAccount();
      const now = Date.now();
      const payment = shopPayment(accountId, now);
      const quoteId = crypto.randomUUID();
      const offer = shopOffer(quoteId, now);
      const unlogged = shopProof(offer, payment.id, now, {
        source: 'hex',
        rawHex: 'ab',
        logIndex: null,
        transferAmount: null,
        nextSubmitAt: new Date(now - 1),
      });
      const logged = shopProof(offer, payment.id, now, { nextSubmitAt: new Date(now - 1) });
      const used = shopProof(offer, payment.id, now, {
        result: 'refused',
        refusal: 'tx_used',
        providerOrder: `order-used-${quoteId}`,
        nextSubmitAt: null,
        nextStatusAt: new Date(now - 1),
      });
      const mismatch = shopProof(offer, payment.id, now, {
        result: 'refused',
        refusal: 'mismatch',
        providerOrder: `order-mismatch-${quoteId}`,
        nextSubmitAt: null,
        nextStatusAt: new Date(now - 1),
      });
      await store.transaction(async (tx) => {
        expect(await tx.insertPayment(payment)).toBe(true);
        await tx.insertQuote({
          id: quoteId,
          paymentId: payment.id,
          expiresAt: new Date(now),
          transferAmounts: [],
          createdAt: new Date(now),
        });
        await tx.insertOffers([offer]);
        for (const row of [unlogged, logged, used, mismatch]) {
          expect(await tx.insertProof(row)).toBe(true);
        }
        const submit = (await tx.dueProofs('submit', now, 100_000)).map((row) => row.id);
        expect(submit).toContain(logged.id);
        expect(submit).not.toContain(unlogged.id);
        const status = (await tx.dueProofs('status', now, 100_000)).map((row) => row.id);
        expect(status).toContain(mismatch.id);
        expect(status).not.toContain(used.id);
      });
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('the status duty selects exactly the due proofs that followsOrderStatus admits', async () => {
    const { sql, store, newAccount } = await setup();
    try {
      const accountId = await newAccount();
      const now = Date.now();
      const payment = shopPayment(accountId, now);
      const quoteId = crypto.randomUUID();
      const offer = shopOffer(quoteId, now);
      const outcomes: Pick<ShopProof, 'result' | 'refusal'>[] = [
        { result: null, refusal: null },
        { result: 'refused', refusal: 'tx_used' },
        { result: 'refused', refusal: 'mismatch' },
        { result: 'refused', refusal: 'expired_order' },
        { result: 'stuck', refusal: null },
        { result: 'late', refusal: null },
      ];
      const rows: ShopProof[] = [];
      for (const ordered of [false, true]) {
        for (const nextStatusAt of [null, now - 1, now, now + 1]) {
          for (const outcome of outcomes) {
            rows.push(
              shopProof(offer, payment.id, now, {
                ...outcome,
                providerOrder: ordered ? `order-${crypto.randomUUID()}` : null,
                orderStatus: ordered ? 'processing' : null,
                nextSubmitAt: null,
                nextStatusAt: nextStatusAt === null ? null : new Date(nextStatusAt),
              }),
            );
          }
        }
      }
      await store.transaction(async (tx) => {
        expect(await tx.insertPayment(payment)).toBe(true);
        await tx.insertQuote({
          id: quoteId,
          paymentId: payment.id,
          expiresAt: new Date(now),
          transferAmounts: [],
          createdAt: new Date(now),
        });
        await tx.insertOffers([offer]);
        for (const row of rows) {
          expect(await tx.insertProof(row)).toBe(true);
        }
        const ids = new Set(rows.map((row) => row.id));
        const selected = (await tx.dueProofs('status', now, 100_000))
          .map((row) => row.id)
          .filter((id) => ids.has(id))
          .sort();
        const admitted = rows
          .filter(
            (row) =>
              followsOrderStatus(row) &&
              row.nextStatusAt !== null &&
              row.nextStatusAt.getTime() <= now,
          )
          .map((row) => row.id)
          .sort();
        // 2 due instants x 5 outcomes other than tx_used, all with an order.
        expect(admitted).toHaveLength(10);
        expect(selected).toEqual(admitted);
      });
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('lockProofs returns the payment proofs by id and holds them until the transaction ends', async () => {
    const { sql, store, newAccount } = await setup();
    try {
      const accountId = await newAccount();
      const now = Date.now();
      const payment = shopPayment(accountId, now);
      const quoteId = crypto.randomUUID();
      const offer = shopOffer(quoteId, now);
      const suffix = crypto.randomUUID().slice(8);
      const high = shopProof(offer, payment.id, now, { id: `ffffffff${suffix}` });
      const low = shopProof(offer, payment.id, now + 1, { id: `00000000${suffix}` });
      await store.transaction(async (tx) => {
        expect(await tx.insertPayment(payment)).toBe(true);
        await tx.insertQuote({
          id: quoteId,
          paymentId: payment.id,
          expiresAt: new Date(now),
          transferAmounts: [],
          createdAt: new Date(now),
        });
        await tx.insertOffers([offer]);
        expect(await tx.insertProof(high)).toBe(true);
        expect(await tx.insertProof(low)).toBe(true);
        expect((await tx.proofsOf(payment.id)).map((row) => row.id)).toEqual([high.id, low.id]);
        expect((await tx.lockProofs(payment.id)).map((row) => row.id)).toEqual([low.id, high.id]);
      });
      const events: string[] = [];
      let locked = (): void => undefined;
      const firstLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const first = store.transaction(async (tx) => {
        await tx.lockPayment(payment.id);
        await tx.lockProofs(payment.id);
        locked();
        await new Promise((resolve) => setTimeout(resolve, 300));
        await tx.updateProof(low.id, {}, { tries: 1 });
        events.push('first:commit');
      });
      await firstLocked;
      const second = store.transaction(async (tx) => {
        const rows = await tx.lockProofs(payment.id);
        events.push(`second:tries=${rows[0]?.tries}`);
      });
      await Promise.all([first, second]);
      expect(events).toEqual(['first:commit', 'second:tries=1']);
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('a settlement and proof decisions on one payment run without a deadlock; two decisions serialize', async () => {
    const { client, sql, store, pos, newAccount } = await setup();
    try {
      const accountId = await newAccount();
      const now = Date.now();
      const chargeId = crypto.randomUUID();
      await pos.create({
        id: chargeId,
        accountId,
        amountSats: 2100,
        status: 'pending',
        createdAt: new Date(now),
        expiresAt: new Date(now + POS_CHARGE_TTL_MS),
        paidAt: null,
        sparkInvoice: null,
        amountCurrency: null,
        amountText: null,
        fiatUsd: null,
        fiatChf: null,
        fiatEur: null,
        fiatPhp: null,
      });
      const payment = shopPayment(accountId, now, {
        posChargeId: chargeId,
        status: 'accepted',
        acceptedAt: new Date(now),
      });
      const quoteId = crypto.randomUUID();
      const offer = shopOffer(quoteId, now);
      const accepted = shopProof(offer, payment.id, now, {
        result: 'accepted',
        providerOrder: `o-${crypto.randomUUID()}`,
        orderStatus: 'processing',
      });
      const superseded = shopProof(offer, payment.id, now + 1, {
        result: 'superseded',
        providerOrder: `o-${crypto.randomUUID()}`,
        orderStatus: 'swapping',
      });
      await store.transaction(async (tx) => {
        expect(await tx.insertPayment(payment)).toBe(true);
        await tx.insertQuote({
          id: quoteId,
          paymentId: payment.id,
          expiresAt: new Date(now),
          transferAmounts: [],
          createdAt: new Date(now),
        });
        await tx.insertOffers([offer]);
        expect(await tx.insertProof(accepted)).toBe(true);
        expect(await tx.insertProof(superseded)).toBe(true);
      });
      const shop = new ShopPayments({
        store,
        posStore: pos,
        auth: new PostgresAuthStore(client),
        lnurlServer: {
          baseUrl: 'http://lnurl.test',
          publicBaseUrl: 'https://example.test',
          host: 'example.test',
        },
        config: null,
        orchestra: null,
        fxSpot: new PostgresFxSpotStore(client),
        fetchImpl: fetch,
        now: () => Date.now(),
      });
      const events: string[] = [];
      let locked = (): void => undefined;
      const decisionLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      // A proof decision holds the payment row and its proof rows: the
      // accepted proof is refunded and the superseded one takes its place.
      const decision = store.transaction(async (tx) => {
        expect((await lockPaymentForProofs(tx, payment.id))?.proofs).toHaveLength(2);
        locked();
        await new Promise((resolve) => setTimeout(resolve, 300));
        await tx.updateProof(accepted.id, {}, { orderStatus: 'refunded' });
        await evaluateProof(tx, accepted.id, Date.now());
        events.push('decision:commit');
      });
      await decisionLocked;
      // The settlement takes the account and the charge, then waits for the payment row.
      const settlement = shop
        .applySettlement(payment.id, true, Date.now())
        .then(() => events.push('settlement:commit'));
      // A second decision waits for the first.
      const second = store.transaction(async (tx) => {
        const again = await lockPaymentForProofs(tx, payment.id);
        events.push(`second:${again?.proofs.map((row) => row.result).join(',')}`);
      });
      await Promise.all([decision, settlement, second]);
      expect(events[0]).toBe('decision:commit');
      expect(events).toContain('settlement:commit');
      // The second decision saw the first one's results.
      const seen = events.find((event) => event.startsWith('second:'));
      expect(seen?.slice('second:'.length).split(',').sort()).toEqual(['accepted', 'refunded']);
      const after = await store.transaction(async (tx) => ({
        payment: await tx.getPayment(payment.id),
        accepted: await tx.getProof(accepted.id),
        superseded: await tx.getProof(superseded.id),
      }));
      expect(after.payment?.status).toBe('paid');
      expect(after.accepted?.result).toBe('refunded');
      expect(after.superseded?.result).toBe('accepted');
      expect((await pos.findChargeForPayment({ chargeId }))?.status).toBe('paid');
      // The other way round: the settlement holds account, charge, and payment
      // rows while a proof decision waits only for the payment row.
      const order: string[] = [];
      let held = (): void => undefined;
      const settlementHeld = new Promise<void>((resolve) => {
        held = resolve;
      });
      const holder = store.transaction(async (tx) => {
        await tx.lockAccount(accountId);
        await tx.lockCharge(chargeId);
        await tx.lockPayment(payment.id);
        held();
        await new Promise((resolve) => setTimeout(resolve, 300));
        order.push('settlement-order:commit');
      });
      await settlementHeld;
      const waiting = store.transaction(async (tx) => {
        await lockPaymentForProofs(tx, payment.id);
        order.push('decision:locked');
      });
      await Promise.all([holder, waiting]);
      expect(order).toEqual(['settlement-order:commit', 'decision:locked']);
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('two submit answers on crossed payments lock both payment rows by id and do not deadlock', async () => {
    const { client, sql, store, pos, newAccount } = await setup();
    try {
      const now = Date.now();
      // Two payments, each with an older proof being submitted and a newer
      // row of another offer that holds the order Orchestra answers for the
      // other payment's proof: each answer refuses a row of the other payment.
      const sides = await Promise.all(
        [0, 1].map(async () => {
          const payment = shopPayment(await newAccount(), now);
          const quoteId = crypto.randomUUID();
          const offer = shopOffer(quoteId, now);
          const older = shopProof(offer, payment.id, now - 1_000, {
            nextSubmitAt: null,
            lastSubmitAt: null,
          });
          const newer = shopProof(offer, payment.id, now, {
            providerOrder: `o-${crypto.randomUUID()}`,
            orderStatus: 'processing',
            orderFoundAt: new Date(now),
            nextSubmitAt: null,
          });
          return { payment, quoteId, offer, older, newer };
        }),
      );
      const [a, b] = sides as [(typeof sides)[0], (typeof sides)[0]];
      for (const side of [a, b]) {
        await store.transaction(async (tx) => {
          expect(await tx.insertPayment(side.payment)).toBe(true);
          await tx.insertQuote({
            id: side.quoteId,
            paymentId: side.payment.id,
            expiresAt: new Date(now + 120_000),
            transferAmounts: [],
            createdAt: new Date(now),
          });
          await tx.insertOffers([side.offer]);
          expect(await tx.insertProof(side.older)).toBe(true);
          expect(await tx.insertProof(side.newer)).toBe(true);
        });
      }
      // a's older proof is answered with b's order, b's older proof with a's.
      const answers = new Map([
        [a.older.txHash, b.newer.providerOrder as string],
        [b.older.txHash, a.newer.providerOrder as string],
      ]);
      const orchestra = {
        submit: async (_quote: string, txHash: string) => ({
          kind: 'order' as const,
          orderId: answers.get(txHash) as string,
          status: 'processing',
        }),
      } as unknown as OrchestraClient;
      const shop = new ShopPayments({
        store,
        posStore: pos,
        auth: new PostgresAuthStore(client),
        lnurlServer: {
          baseUrl: 'http://lnurl.test',
          publicBaseUrl: 'https://example.test',
          host: 'example.test',
        },
        config: null,
        orchestra,
        fxSpot: new PostgresFxSpotStore(client),
        fetchImpl: fetch,
        now: () => Date.now(),
      });
      // Hold the lower payment row, so that both answers queue on it: taken
      // in opposite order (a's own payment first, then b's, and b's the other
      // way round) the two would deadlock once the holder lets go.
      const [low] = [a.payment.id, b.payment.id].sort();
      const order: string[] = [];
      let held = (): void => undefined;
      const lowHeld = new Promise<void>((resolve) => {
        held = resolve;
      });
      const holder = store.transaction(async (tx) => {
        await tx.lockPayment(low as string);
        held();
        await new Promise((resolve) => setTimeout(resolve, 500));
        order.push('holder:commit');
      });
      await lowHeld;
      const deadline = Date.now() + 10_000;
      const [first, second] = await Promise.all([
        submitProofAttempt(shop, a.older.id, 'watcher', deadline),
        submitProofAttempt(shop, b.older.id, 'watcher', deadline),
        holder,
      ]);
      expect(order).toEqual(['holder:commit']);
      expect(first).toMatchObject({ sent: true });
      expect(second).toMatchObject({ sent: true });
      const after = await store.transaction(async (tx) => ({
        aOlder: await tx.getProof(a.older.id),
        aNewer: await tx.getProof(a.newer.id),
        bOlder: await tx.getProof(b.older.id),
        bNewer: await tx.getProof(b.newer.id),
      }));
      // Each older proof took the other payment's order; each newer holder
      // was refused tx_used by the other payment's answer.
      expect(after.aOlder?.providerOrder).toBe(b.newer.providerOrder);
      expect(after.bOlder?.providerOrder).toBe(a.newer.providerOrder);
      expect(after.aNewer).toMatchObject({
        result: 'refused',
        refusal: 'tx_used',
        providerOrder: null,
      });
      expect(after.bNewer).toMatchObject({
        result: 'refused',
        refusal: 'tx_used',
        providerOrder: null,
      });
      expect(after.aOlder?.result).toBe('accepted');
      expect(after.bOlder?.result).toBe('accepted');
    } finally {
      await closeIfPossible(sql);
    }
  });

  /**
   * Wait until `n` backends of this database wait for a lock in a statement
   * on `shop_payment`.
   */
  async function untilShopPaymentLockWaiters(client: SqlClient, n: number): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const rows = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'
           AND query LIKE '%shop_payment%'`,
      );
      if ((rows[0]?.n ?? 0) >= n) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`fewer than ${n} backends wait on a shop_payment lock`);
  }

  /**
   * Two payments with ids in a known order, the higher id inserted first (a
   * scan of the table meets it first, and an index on `account_id` too: its
   * account id is the lower one). Each has an older proof being submitted and
   * a newer row that holds an order; the lower payment's older proof is
   * answered with the order of the higher payment's newer row, so that answer
   * locks both payment rows (`lockPaymentsForProofs`).
   */
  async function crossedPayments(
    client: SqlClient,
    store: PostgresShopPaymentStore,
    pos: PostgresPosStore,
    accounts: readonly [string, string],
    now: number,
    partial: Partial<ShopPayment>,
  ) {
    const [lowId, highId] = [crypto.randomUUID(), crypto.randomUUID()].sort() as [string, string];
    const [highAccount, lowAccount] = [...accounts].sort() as [string, string];
    const side = (id: string, accountId: string) => {
      const payment = shopPayment(accountId, now, { ...partial, id });
      const quoteId = crypto.randomUUID();
      const offer = shopOffer(quoteId, now);
      const older = shopProof(offer, payment.id, now - 1_000, {
        nextSubmitAt: null,
        lastSubmitAt: null,
      });
      const newer = shopProof(offer, payment.id, now, {
        providerOrder: `o-${crypto.randomUUID()}`,
        orderStatus: 'processing',
        orderFoundAt: new Date(now),
        nextSubmitAt: null,
      });
      return { payment, quoteId, offer, older, newer };
    };
    const high = side(highId, highAccount);
    const low = side(lowId, lowAccount);
    for (const row of [high, low]) {
      await store.transaction(async (tx) => {
        expect(await tx.insertPayment(row.payment)).toBe(true);
        await tx.insertQuote({
          id: row.quoteId,
          paymentId: row.payment.id,
          expiresAt: new Date(now + 120_000),
          transferAmounts: [],
          createdAt: new Date(now),
        });
        await tx.insertOffers([row.offer]);
        expect(await tx.insertProof(row.older)).toBe(true);
        expect(await tx.insertProof(row.newer)).toBe(true);
      });
    }
    const orchestra = {
      submit: async () => ({
        kind: 'order' as const,
        orderId: high.newer.providerOrder as string,
        status: 'processing',
      }),
    } as unknown as OrchestraClient;
    const shop = new ShopPayments({
      store,
      posStore: pos,
      auth: new PostgresAuthStore(client),
      lnurlServer: {
        baseUrl: 'http://lnurl.test',
        publicBaseUrl: 'https://example.test',
        host: 'example.test',
      },
      config: null,
      orchestra,
      fxSpot: new PostgresFxSpotStore(client),
      fetchImpl: fetch,
      now: () => Date.now(),
    });
    return { low, high, shop };
  }

  /**
   * A holder locks the lower payment row; the crossed submit answer queues on
   * it, then `other` starts and queues behind the answer. Run in the old,
   * unordered way, `other` holds the higher row by then, and once the holder
   * lets go the answer waits for it while `other` waits for the lower row: a
   * deadlock (40P01). Taken in id order, `other` holds no payment row yet.
   */
  async function besideCrossedAnswer<T>(
    client: SqlClient,
    store: PostgresShopPaymentStore,
    crossed: Awaited<ReturnType<typeof crossedPayments>>,
    other: () => Promise<T>,
  ): Promise<[ShopSubmitAttempt, T]> {
    let held = (): void => undefined;
    const lowHeld = new Promise<void>((resolve) => {
      held = resolve;
    });
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = store.transaction(async (tx) => {
      await tx.lockPayment(crossed.low.payment.id);
      held();
      await released;
    });
    await lowHeld;
    const answer = submitProofAttempt(
      crossed.shop,
      crossed.low.older.id,
      'watcher',
      Date.now() + 30_000,
    );
    await untilShopPaymentLockWaiters(client, 1);
    const running = other();
    await untilShopPaymentLockWaiters(client, 2);
    release();
    const [attempt, result] = await Promise.all([answer, running, holder]);
    return [attempt, result];
  }

  test('endLapsedWindows beside a crossed submit answer locks the payment rows by id and does not deadlock', async () => {
    const { client, sql, store, pos, newAccount } = await setup();
    try {
      const now = Date.now();
      const crossed = await crossedPayments(
        client,
        store,
        pos,
        [await newAccount(), await newAccount()],
        now,
        { windowEndsAt: new Date(now - 1_000) },
      );
      const ids = [crossed.low.payment.id, crossed.high.payment.id];
      const [attempt, ended] = await besideCrossedAnswer(client, store, crossed, () =>
        store.transaction((tx) => tx.endLapsedWindows(Date.now())),
      );
      expect(attempt).toMatchObject({ sent: true });
      // The answer went first: the lower payment is accepted, so only the
      // higher one is still open and lapsed.
      expect(ended.filter((row) => ids.includes(row.id))).toEqual([
        expect.objectContaining({
          id: crossed.high.payment.id,
          status: 'ended',
          endReason: 'window',
        }),
      ]);
      const after = await store.transaction(async (tx) => ({
        low: await tx.getPayment(crossed.low.payment.id),
        lowOlder: await tx.getProof(crossed.low.older.id),
        highNewer: await tx.getProof(crossed.high.newer.id),
      }));
      expect(after.low?.status).toBe('accepted');
      expect(after.lowOlder).toMatchObject({
        result: 'accepted',
        providerOrder: crossed.high.newer.providerOrder,
      });
      expect(after.highNewer).toMatchObject({
        result: 'refused',
        refusal: 'tx_used',
        providerOrder: null,
      });
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('a merge moving both payments beside a crossed submit answer locks them by id and does not deadlock', async () => {
    const { client, mergeDb, sql, store, pos, newAccount } = await setup();
    try {
      await migrateMergeTables(client);
      const from = await newAccount();
      const into = await newAccount();
      const now = Date.now();
      // Paid payments do not stop the merge, and both belong to the merged account.
      const crossed = await crossedPayments(client, store, pos, [from, from], now, {
        status: 'paid',
        acceptedAt: new Date(now),
        paidAt: new Date(now),
      });
      const [attempt, merged] = await besideCrossedAnswer(client, store, crossed, () =>
        mergeAccounts(mergeDb, { from, into, verify: 'into' }),
      );
      expect(attempt).toMatchObject({ sent: true });
      expect(merged).toEqual({ ok: true, messages: 0 });
      const after = await store.transaction(async (tx) => ({
        low: await tx.getPayment(crossed.low.payment.id),
        high: await tx.getPayment(crossed.high.payment.id),
        lowOlder: await tx.getProof(crossed.low.older.id),
        highNewer: await tx.getProof(crossed.high.newer.id),
      }));
      expect(after.low?.accountId).toBe(into);
      expect(after.high?.accountId).toBe(into);
      expect(after.lowOlder?.providerOrder).toBe(crossed.high.newer.providerOrder);
      expect(after.highNewer).toMatchObject({
        result: 'refused',
        refusal: 'tx_used',
        providerOrder: null,
      });
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('claimPaymentHash serializes writers whose hashes share their first 32 bits only', async () => {
    const { sql, store } = await setup();
    try {
      const prefix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
      const other = (Number.parseInt(prefix, 16) ^ 1).toString(16).padStart(8, '0');
      const a = `${prefix}${hex64().slice(8)}`;
      const b = `${prefix}${hex64().slice(8)}`;
      const c = `${other}${hex64().slice(8)}`;
      const events: string[] = [];
      let locked = (): void => undefined;
      const firstLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const first = store.transaction(async (tx) => {
        await tx.claimPaymentHash(a);
        locked();
        await new Promise((resolve) => setTimeout(resolve, 300));
        events.push('first:commit');
      });
      await firstLocked;
      const second = store.transaction(async (tx) => {
        await tx.claimPaymentHash(b);
        events.push('same-prefix');
      });
      const third = store.transaction(async (tx) => {
        await tx.claimPaymentHash(c);
        events.push('other-prefix');
      });
      await Promise.all([first, second, third]);
      expect(events).toEqual(['other-prefix', 'first:commit', 'same-prefix']);
      // The two-key form never meets a one-key lock on the same number.
      await store.transaction(async (tx) => {
        await tx.claimPaymentHash(a);
        const { mergeDb, sql: plain } = createBunSqlClient(databaseUrl);
        try {
          const taken = await mergeDb.begin((conn) =>
            conn.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS ok', [
              PAYMENT_HASH_LOCK_NAMESPACE,
            ]),
          );
          expect(taken[0]?.ok).toBe(true);
        } finally {
          await closeIfPossible(plain);
        }
      });
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('recordInvoice waits for a step-8 claim on the same hash and then answers other_payment', async () => {
    const { client, sql, store, pos, newAccount } = await setup();
    try {
      const payerAccount = await newAccount();
      const shopAccount = await newAccount();
      const now = Date.now();
      const chargeId = crypto.randomUUID();
      await pos.create({
        id: chargeId,
        accountId: shopAccount,
        amountSats: 2100,
        status: 'pending',
        createdAt: new Date(now),
        expiresAt: new Date(now + POS_CHARGE_TTL_MS),
        paidAt: null,
        sparkInvoice: null,
        amountCurrency: null,
        amountText: null,
        fiatUsd: null,
        fiatChf: null,
        fiatEur: null,
        fiatPhp: null,
      });
      const hash = hex64();
      const payment = shopPayment(payerAccount, now, { paymentHash: hash });
      let locked = (): void => undefined;
      const firstLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const order: string[] = [];
      const step8 = store.transaction(async (tx) => {
        await tx.claimPaymentHash(hash);
        await tx.lockAccount(payerAccount);
        locked();
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(await tx.chargeIdForInvoice(hash)).toBeNull();
        expect(await tx.insertPayment(payment)).toBe(true);
        order.push('step8:commit');
      });
      await firstLocked;
      const recorded = pos.recordInvoice(chargeId, hash, now).then((result) => {
        order.push('recordInvoice');
        return result;
      });
      await step8;
      expect(await recorded).toEqual({
        outcome: 'other_payment',
        holderChargeId: null,
        holderPaymentId: payment.id,
      });
      expect(order).toEqual(['step8:commit', 'recordInvoice']);
      const rows = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pos_charge_invoice WHERE payment_hash = $1',
        [hash],
      );
      expect(rows[0]?.n).toBe(0);
      // The charge's own shop payment holding the hash is this charge.
      const own = shopPayment(shopAccount, now, { posChargeId: chargeId });
      expect(await store.transaction((tx) => tx.insertPayment(own))).toBe(true);
      expect(await pos.recordInvoice(chargeId, own.paymentHash, now)).toEqual({
        outcome: 'this_charge',
      });
    } finally {
      await closeIfPossible(sql);
    }
  });

  test("a payer creation's re-check beside the settlement of the lapsed charge payment takes the account first and does not deadlock", async () => {
    const { client, mergeDb, sql, store, pos, newAccount } = await setup();
    try {
      const accountId = await newAccount();
      const account = await new PostgresAuthStore(client).getAccount(accountId);
      if (account === undefined) {
        throw new Error('account missing');
      }
      const now = Date.now();
      // A charge whose expiry passed while it is still `pending` (no read has
      // expired it yet), and its `open` payment, whose window was the charge's.
      const charge: PosCharge = {
        id: crypto.randomUUID(),
        accountId,
        amountSats: 2100,
        status: 'pending',
        createdAt: new Date(now - 400_000),
        expiresAt: new Date(now - 10_000),
        paidAt: null,
        sparkInvoice: null,
        amountCurrency: null,
        amountText: null,
        fiatUsd: null,
        fiatChf: null,
        fiatEur: null,
        fiatPhp: null,
      };
      await pos.create(charge);
      const lapsed = shopPayment(accountId, now - 400_000, {
        posChargeId: charge.id,
        windowEndsAt: charge.expiresAt,
      });
      expect(await store.transaction((tx) => tx.insertPayment(lapsed))).toBe(true);
      let ended = (): void => undefined;
      const lapsedEnded = new Promise<void>((resolve) => {
        ended = resolve;
      });
      let release = (): void => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      /** Holds the creation's re-check right after it ended the lapsed payment. */
      class PausingStore extends PostgresShopPaymentStore {
        #paused = false;
        override transaction<T>(run: (tx: ShopTx) => Promise<T>): Promise<T> {
          return super.transaction((tx) =>
            run(
              new Proxy(tx, {
                get: (target, prop) => {
                  const value = (target as unknown as Record<string | symbol, unknown>)[prop];
                  if (typeof value !== 'function') {
                    return value;
                  }
                  if (prop === 'updatePayment' && !this.#paused) {
                    this.#paused = true;
                    return async (...args: unknown[]) => {
                      const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(
                        target,
                        args,
                      );
                      ended();
                      await released;
                      return result;
                    };
                  }
                  return (value as (...a: unknown[]) => unknown).bind(target);
                },
              }),
            ),
          );
        }
      }
      const deps = {
        posStore: pos,
        auth: new PostgresAuthStore(client),
        lnurlServer: {
          baseUrl: 'http://lnurl.test',
          publicBaseUrl: 'https://example.test',
          host: 'example.test',
        },
        config: null,
        orchestra: null,
        fxSpot: new PostgresFxSpotStore(client),
        fetchImpl: fetch,
        now: () => Date.now(),
      };
      const creator = new ShopPayments({ ...deps, store: new PausingStore(client, mergeDb) });
      const settler = new ShopPayments({ ...deps, store });
      // The re-check holds the lapsed payment's row (and, in the account-first
      // order, the account row and the charge row) when it pauses.
      const creation = creator.createForPayer(account, account.username ?? '', 2100, Date.now());
      await lapsedEnded;
      // The settlement locks the account, then the charge, then the payment:
      // it queues on the first row the paused re-check holds.
      const settlement = settler.applySettlement(lapsed.id, true, Date.now());
      for (let i = 0; ; i += 1) {
        const rows = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        if ((rows[0]?.n ?? 0) >= 1) {
          break;
        }
        if (i === 200) {
          throw new Error('the settlement never waited for a lock');
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // Taking the payment row before the charge rows, the re-check would now
      // wait for the charge the settlement holds while the settlement waits
      // for the payment: a deadlock (40P01).
      release();
      const [created] = await Promise.all([creation, settlement]);
      expect(created).toEqual({ kind: 'unavailable' });
      const after = await store.transaction((tx) => tx.getPayment(lapsed.id));
      expect(after?.endReason).toBeNull();
      expect(after?.status).toBe('paid');
      expect((await pos.findChargeForPayment({ chargeId: charge.id }))?.status).toBe('paid');
    } finally {
      await closeIfPossible(sql);
    }
  });
  test('two containers that selected the same lapsed status row log order_stuck once', async () => {
    const { client, sql, store, pos, newAccount } = await setup();
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const now = Date.now();
      // The watchers' clock lies before every row other tests left behind,
      // so their duties select only this proof.
      const clockMs = Date.UTC(2001, 0, 1);
      const payment = shopPayment(await newAccount(), now);
      const quoteId = crypto.randomUUID();
      const offer = shopOffer(quoteId, now);
      const lapsed = shopProof(offer, payment.id, now, {
        providerOrder: `o-${crypto.randomUUID()}`,
        orderStatus: 'processing',
        orderFoundAt: new Date(clockMs - 86_400_000),
        nextSubmitAt: null,
        nextStatusAt: new Date(clockMs - 1_000),
      });
      await store.transaction(async (tx) => {
        expect(await tx.insertPayment(payment)).toBe(true);
        await tx.insertQuote({
          id: quoteId,
          paymentId: payment.id,
          expiresAt: new Date(now + 120_000),
          transferAmounts: [],
          createdAt: new Date(now),
        });
        await tx.insertOffers([offer]);
        expect(await tx.insertProof(lapsed)).toBe(true);
      });
      const container = (): ShopPayments =>
        new ShopPayments({
          store,
          posStore: pos,
          auth: new PostgresAuthStore(client),
          lnurlServer: {
            baseUrl: 'http://lnurl.test',
            publicBaseUrl: 'https://example.test',
            host: 'example.test',
          },
          config: null,
          // The 24 h stop makes no call.
          orchestra: {
            status: async () => {
              throw new Error('no status read expected');
            },
          } as unknown as OrchestraClient,
          fxSpot: new PostgresFxSpotStore(client),
          fetchImpl: fetch,
          now: () => clockMs,
        });
      // Hold the payment row, so that both containers select the row without
      // a lock and then queue for the payment row.
      let held = (): void => undefined;
      const paymentHeld = new Promise<void>((resolve) => {
        held = resolve;
      });
      const holder = store.transaction(async (tx) => {
        await tx.lockPayment(payment.id);
        held();
        await new Promise((resolve) => setTimeout(resolve, 500));
      });
      await paymentHeld;
      await Promise.all([
        runShopPaymentTick(container(), 2),
        runShopPaymentTick(container(), 2),
        holder,
      ]);
      const alerts = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((text) => text.startsWith('{'))
        .map((text) => JSON.parse(text) as Record<string, unknown>)
        .filter(
          (line) => line['event'] === 'shop.alert.order_stuck' && line['proofId'] === lapsed.id,
        );
      expect(alerts).toHaveLength(1);
      expect((await store.transaction((tx) => tx.getProof(lapsed.id)))?.nextStatusAt).toBeNull();
    } finally {
      warn.mockRestore();
      await closeIfPossible(sql);
    }
  });
  test('a status read that another container overtook with expired keeps expired and stays stopped', async () => {
    const { client, sql, store, pos, newAccount } = await setup();
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const now = Date.now();
      // As above, the watchers' clock selects only this proof.
      const clockMs = Date.UTC(2001, 0, 1);
      const payment = shopPayment(await newAccount(), now);
      const quoteId = crypto.randomUUID();
      const offer = shopOffer(quoteId, now);
      const orderId = `o-${crypto.randomUUID()}`;
      const watched = shopProof(offer, payment.id, now, {
        providerOrder: orderId,
        orderStatus: 'processing',
        orderFoundAt: new Date(clockMs - 1_000),
        nextSubmitAt: null,
        nextStatusAt: new Date(clockMs - 1_000),
      });
      await store.transaction(async (tx) => {
        expect(await tx.insertPayment(payment)).toBe(true);
        await tx.insertQuote({
          id: quoteId,
          paymentId: payment.id,
          expiresAt: new Date(now + 120_000),
          transferAmounts: [],
          createdAt: new Date(now),
        });
        await tx.insertOffers([offer]);
        expect(await tx.insertProof(watched)).toBe(true);
      });
      const container = (status: () => Promise<unknown>): ShopPayments =>
        new ShopPayments({
          store,
          posStore: pos,
          auth: new PostgresAuthStore(client),
          lnurlServer: {
            baseUrl: 'http://lnurl.test',
            publicBaseUrl: 'https://example.test',
            host: 'example.test',
          },
          config: null,
          orchestra: { status } as unknown as OrchestraClient,
          fxSpot: new PostgresFxSpotStore(client),
          fetchImpl: fetch,
          now: () => clockMs,
        });
      const answer = (value: string): unknown => ({
        ok: true,
        order: { id: orderId, status: value, supersededByOperationId: null },
      });
      // Container A reads `expired` and commits while container B's read,
      // which answers `processing`, is still in flight.
      const first = container(async () => answer('expired'));
      const second = container(async () => {
        await runShopPaymentTick(first, 2);
        return answer('processing');
      });
      await runShopPaymentTick(second, 2);
      expect(await store.transaction((tx) => tx.getProof(watched.id))).toMatchObject({
        orderStatus: 'expired',
        result: 'refused',
        refusal: 'expired_order',
        nextStatusAt: null,
      });
      expect((await store.transaction((tx) => tx.getPayment(payment.id)))?.status).toBe('open');
      const proofLines = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((text) => text.startsWith('{'))
        .map((text) => JSON.parse(text) as Record<string, unknown>)
        .filter((line) => line['proofId'] === watched.id)
        .map((line) => String(line['event']))
        .filter((event) => event.startsWith('shop.proof.') || event.startsWith('shop.alert.'));
      expect(proofLines).toEqual(['shop.proof.refused']);
    } finally {
      warn.mockRestore();
      await closeIfPossible(sql);
    }
  });
});

describe('mergeAccounts and the shop payment rows', () => {
  const hex64 = (): string =>
    `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;

  async function newAccount(auth: PostgresAuthStore): Promise<string> {
    const id = crypto.randomUUID();
    await auth.createAccount({
      id,
      linkingKey: null,
      role: 'basis',
      name: null,
      username: `merge_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`,
      location: null,
      forumLawsDismissed: false,
      viewKey: hex64(),
      createdAt: Date.now(),
      rulesAgreedAt: null,
      walletRequired: true,
    });
    return id;
  }

  function pendingCharge(
    accountId: string,
    now: number,
    expiresInMs = POS_CHARGE_TTL_MS,
  ): PosCharge {
    return {
      id: crypto.randomUUID(),
      accountId,
      amountSats: 21,
      status: 'pending',
      createdAt: new Date(now),
      expiresAt: new Date(now + expiresInMs),
      paidAt: null,
      sparkInvoice: null,
      amountCurrency: null,
      amountText: null,
      fiatUsd: null,
      fiatChf: null,
      fiatEur: null,
      fiatPhp: null,
    };
  }

  test('the merge locks the deleted pending charge, so a recordInvoice for it fails and leaves no row', async () => {
    const { client, mergeDb, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateMergeTables(client);
      const auth = new PostgresAuthStore(client);
      const pos = new PostgresPosStore(client, mergeDb);
      const from = await newAccount(auth);
      const into = await newAccount(auth);
      const now = Date.now();
      const fromCharge = pendingCharge(from, now);
      await pos.create(fromCharge);
      await pos.create(pendingCharge(into, now));
      const hash = hex64();
      let recording: Promise<unknown> | null = null;
      const watched: MergeDb = {
        begin: (run) =>
          mergeDb.begin((tx) =>
            run({
              query: async <R>(text: string, params: readonly unknown[] = []): Promise<R[]> => {
                const rows = await tx.query<R>(text, params);
                if (
                  recording === null &&
                  text.includes('FROM pos_charge') &&
                  text.includes('FOR UPDATE')
                ) {
                  recording = pos.recordInvoice(fromCharge.id, hash, now).then(
                    (result) => result,
                    (error: unknown) => error,
                  );
                  // Wait until the insert's foreign-key check waits on the charge row lock.
                  for (let i = 0; i < 50; i += 1) {
                    const waiting = await client.query<{ n: number }>(
                      `SELECT count(*)::int AS n FROM pg_stat_activity
                       WHERE wait_event_type = 'Lock' AND query LIKE 'INSERT INTO pos_charge_invoice%'`,
                    );
                    if ((waiting[0]?.n ?? 0) > 0) {
                      break;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 100));
                  }
                }
                return rows;
              },
            }),
          ),
      };
      expect((await mergeAccounts(watched, { from, into, verify: 'into' })).ok).toBe(true);
      expect(sqlState(await recording)).toBe('23503');
      const invoices = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pos_charge_invoice WHERE payment_hash = $1',
        [hash],
      );
      expect(invoices[0]?.n).toBe(0);
      expect(await pos.findChargeForPayment({ chargeId: fromCharge.id })).toBeUndefined();
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('the merge refuses a pending charge of the merged account beside an open payment of the survivor', async () => {
    const { client, mergeDb, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateMergeTables(client);
      const auth = new PostgresAuthStore(client);
      const pos = new PostgresPosStore(client, mergeDb);
      const shop = new PostgresShopPaymentStore(client, mergeDb);
      const from = await newAccount(auth);
      const into = await newAccount(auth);
      const now = Date.now();
      const charge = pendingCharge(from, now);
      await pos.create(charge);
      const open = {
        id: crypto.randomUUID(),
        accountId: into,
        amountSats: 2100,
        posChargeId: null,
        bolt11: 'lnbc21',
        paymentHash: hex64(),
        bolt11ExpiresAt: new Date(now + 600_000),
        status: 'open' as const,
        endReason: null,
        windowEndsAt: new Date(now + 300_000),
        replacements: 0,
        nextSettleAt: new Date(now),
        nextHistoryAt: null,
        historyOffset: 0,
        successorWaitUntil: null,
        createdAt: new Date(now),
        acceptedAt: null,
        paidAt: null,
        endedAt: null,
        closedAt: null,
      };
      expect(await shop.transaction((tx) => tx.insertPayment(open))).toBe(true);
      expect(await mergeAccounts(mergeDb, { from, into, verify: 'into' })).toEqual({
        ok: false,
        error: 'shop_payment_open',
      });
      expect((await pos.findChargeForPayment({ chargeId: charge.id }))?.accountId).toBe(from);
      // An expired pending charge does not count: the merge runs.
      await client.execute(`UPDATE pos_charge SET expires_at = $2 WHERE id = $1`, [
        charge.id,
        new Date(now - 1).toISOString(),
      ]);
      expect((await mergeAccounts(mergeDb, { from, into, verify: 'into' })).ok).toBe(true);
      expect(await shop.transaction((tx) => tx.getPayment(open.id))).toMatchObject({
        status: 'open',
      });
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('the merge goes on when the survivor has its own unexpired pending charge: the merged charge is deleted, the survivor’s open payment stays', async () => {
    const { client, mergeDb, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateMergeTables(client);
      const auth = new PostgresAuthStore(client);
      const pos = new PostgresPosStore(client, mergeDb);
      const shop = new PostgresShopPaymentStore(client, mergeDb);
      const from = await newAccount(auth);
      const into = await newAccount(auth);
      const now = Date.now();
      const fromCharge = pendingCharge(from, now);
      await pos.create(fromCharge);
      const intoCharge = pendingCharge(into, now);
      await pos.create(intoCharge);
      // The survivor's charge has its own open shop payment.
      const open = {
        id: crypto.randomUUID(),
        accountId: into,
        amountSats: 21,
        posChargeId: intoCharge.id,
        bolt11: 'lnbc21',
        paymentHash: hex64(),
        bolt11ExpiresAt: new Date(now + 600_000),
        status: 'open' as const,
        endReason: null,
        windowEndsAt: new Date(now + 300_000),
        replacements: 0,
        nextSettleAt: new Date(now),
        nextHistoryAt: null,
        historyOffset: 0,
        successorWaitUntil: null,
        createdAt: new Date(now),
        acceptedAt: null,
        paidAt: null,
        endedAt: null,
        closedAt: null,
      };
      expect(await shop.transaction((tx) => tx.insertPayment(open))).toBe(true);
      expect((await mergeAccounts(mergeDb, { from, into, verify: 'into' })).ok).toBe(true);
      expect(await pos.findChargeForPayment({ chargeId: fromCharge.id })).toBeUndefined();
      expect((await pos.findChargeForPayment({ chargeId: intoCharge.id }))?.status).toBe('pending');
      expect(await shop.transaction((tx) => tx.getPayment(open.id))).toMatchObject({
        status: 'open',
        posChargeId: intoCharge.id,
      });
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('the merge takes the merged account’s charge rows before its payment rows: blocked on a held charge, it holds no payment row', async () => {
    const { client, mergeDb, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateMergeTables(client);
      const auth = new PostgresAuthStore(client);
      const pos = new PostgresPosStore(client, mergeDb);
      const shop = new PostgresShopPaymentStore(client, mergeDb);
      const from = await newAccount(auth);
      const into = await newAccount(auth);
      const now = Date.now();
      // The survivor has no pending charge, so the merged account's pending
      // charge is not deleted but moved by the catalog update.
      const fromCharge = pendingCharge(from, now);
      await pos.create(fromCharge);
      const paid = {
        id: crypto.randomUUID(),
        accountId: from,
        amountSats: 21,
        posChargeId: fromCharge.id,
        bolt11: 'lnbc21',
        paymentHash: hex64(),
        bolt11ExpiresAt: new Date(now + 600_000),
        status: 'paid' as const,
        endReason: null,
        windowEndsAt: new Date(now + 300_000),
        replacements: 0,
        nextSettleAt: new Date(now),
        nextHistoryAt: null,
        historyOffset: 0,
        successorWaitUntil: null,
        createdAt: new Date(now),
        acceptedAt: new Date(now),
        paidAt: new Date(now),
        endedAt: null,
        closedAt: null,
      };
      expect(await shop.transaction((tx) => tx.insertPayment(paid))).toBe(true);

      // Another transaction holds the charge row, as the settlement step does.
      let held = (): void => undefined;
      const chargeHeld = new Promise<void>((resolve) => {
        held = resolve;
      });
      let release = (): void => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = mergeDb.begin(async (tx) => {
        await tx.query('SELECT id FROM pos_charge WHERE id = $1 FOR UPDATE', [fromCharge.id]);
        held();
        await released;
      });
      await chargeHeld;
      const merging = mergeAccounts(mergeDb, { from, into, verify: 'into' });
      try {
        // The merge waits on the charge row in its charge lock.
        let waiting = false;
        for (let i = 0; i < 50 && !waiting; i += 1) {
          const rows = await client.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE wait_event_type = 'Lock' AND query LIKE 'SELECT id FROM pos_charge%'`,
          );
          waiting = (rows[0]?.n ?? 0) > 0;
          if (!waiting) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        expect(waiting).toBe(true);
        // While it waits it holds no payment row of the merged account.
        const probe = await mergeDb.begin((tx) =>
          tx
            .query<{ id: string }>('SELECT id FROM shop_payment WHERE id = $1 FOR UPDATE NOWAIT', [
              paid.id,
            ])
            .then(
              (rows) => rows.map((row) => row.id),
              (error: unknown) => sqlState(error),
            ),
        );
        expect(probe).toEqual([paid.id]);
      } finally {
        release();
        await holder;
      }
      expect(await merging).toEqual({ ok: true, messages: 0 });
      expect((await pos.findChargeForPayment({ chargeId: fromCharge.id }))?.accountId).toBe(into);
      expect(await shop.transaction((tx) => tx.getPayment(paid.id))).toMatchObject({
        accountId: into,
        posChargeId: fromCharge.id,
      });
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('the merge refuses when the survivor’s only pending charge has expired', async () => {
    const { client, mergeDb, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateMergeTables(client);
      const auth = new PostgresAuthStore(client);
      const pos = new PostgresPosStore(client, mergeDb);
      const shop = new PostgresShopPaymentStore(client, mergeDb);
      const from = await newAccount(auth);
      const into = await newAccount(auth);
      const now = Date.now();
      const fromCharge = pendingCharge(from, now);
      await pos.create(fromCharge);
      const intoCharge = pendingCharge(into, now);
      await pos.create(intoCharge);
      await client.execute(`UPDATE pos_charge SET expires_at = $2 WHERE id = $1`, [
        intoCharge.id,
        new Date(now - 1).toISOString(),
      ]);
      const open = {
        id: crypto.randomUUID(),
        accountId: into,
        amountSats: 2100,
        posChargeId: null,
        bolt11: 'lnbc2100',
        paymentHash: hex64(),
        bolt11ExpiresAt: new Date(now + 600_000),
        status: 'open' as const,
        endReason: null,
        windowEndsAt: new Date(now + 300_000),
        replacements: 0,
        nextSettleAt: new Date(now),
        nextHistoryAt: null,
        historyOffset: 0,
        successorWaitUntil: null,
        createdAt: new Date(now),
        acceptedAt: null,
        paidAt: null,
        endedAt: null,
        closedAt: null,
      };
      expect(await shop.transaction((tx) => tx.insertPayment(open))).toBe(true);
      expect(await mergeAccounts(mergeDb, { from, into, verify: 'into' })).toEqual({
        ok: false,
        error: 'shop_payment_open',
      });
      expect((await pos.findChargeForPayment({ chargeId: fromCharge.id }))?.accountId).toBe(from);
    } finally {
      await closeIfPossible(sql);
    }
  });
});

describe('shop identity on Postgres', () => {
  const KEK = new Uint8Array(32).fill(7);
  const TEXT = 'Fresh coffee roasted here every morning. #21GiftsShop';
  const PLACE = {
    lat: 47.3769,
    lng: 8.5417,
    label: 'Coffee Lab',
    address: {
      street: 'Main Street',
      houseNumber: '1',
      postalCode: '8001',
      city: 'Zürich',
      country: 'CH',
    },
  };
  const PNG = { contentType: 'image/png' as const, bytes: new Uint8Array([1, 2, 3]) };

  async function setup(): Promise<{
    client: SqlClient;
    sql: SQL;
    accountId: string;
    messages: PostgresMessageStore;
    shops: PostgresShopIdentityStore;
    note: (overrides?: Partial<MessageRow>) => MessageRow;
    cleanup: () => Promise<void>;
  }> {
    const { client, sql } = createBunSqlClient(String(databaseUrl));
    await migrateAuthSchema(client);
    await migrateBtcUsdSchema(client);
    await migrateFiatSchema(client);
    await migrateMessageSchema(client);
    await migrateShopIdentitySchema(client);
    await migrateShopIdentitySchema(client);
    const accountId = crypto.randomUUID();
    await new PostgresAuthStore(client).createAccount({
      id: accountId,
      linkingKey: `02${accountId.replaceAll('-', '').padEnd(64, '2')}`,
      role: 'verified',
      name: 'Coffee',
      username: `c${accountId.replaceAll('-', '').slice(0, 12)}`,
      forumLawsDismissed: false,
      location: null,
      viewKey: accountId.replaceAll('-', '').padEnd(64, 'c'),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const messages = new PostgresMessageStore(client);
    const shops = new PostgresShopIdentityStore(client, messages);
    const note = (overrides: Partial<MessageRow> = {}): MessageRow => ({
      id: crypto.randomUUID(),
      accountId,
      name: 'Coffee',
      text: TEXT,
      createdAt: new Date(),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      place: PLACE,
      shopAccount: { id: accountId, username: 'coffee', name: 'Coffee' },
      ...overrides,
    });
    const cleanup = async (): Promise<void> => {
      await client.execute(
        'DELETE FROM shop_identity WHERE message_id IN (SELECT id FROM message WHERE account_id = $1)',
        [accountId],
      );
      await client.execute('DELETE FROM message WHERE account_id = $1', [accountId]);
      await client.execute('DELETE FROM account WHERE id = $1', [accountId]);
      await closeIfPossible(sql);
    };
    return { client, sql, accountId, messages, shops, note, cleanup };
  }

  test('a failed extra photo leaves neither the note nor a key while the backfill runs', async () => {
    const ctx = await setup();
    try {
      const row = ctx.note({ hasPhoto: true });
      const failing = ctx.messages.create(row, PNG, undefined, [
        PNG,
        { contentType: null as unknown as 'image/png', bytes: PNG.bytes },
      ]);
      const backfill = (async () => {
        for (let round = 0; round < 20; round += 1) {
          for (const candidate of await ctx.shops.listCandidates(null, 50)) {
            if (candidate.id === row.id) await ctx.shops.ensureListed(candidate.id, KEK);
          }
        }
      })();
      let thrown: unknown;
      try {
        await failing;
      } catch (error) {
        thrown = error;
      }
      await backfill;
      expect(thrown).toBeDefined();
      expect(await ctx.messages.getById(row.id)).toBeUndefined();
      expect(await ctx.shops.getByMessageId(row.id)).toBeUndefined();
      expect(
        await ctx.client.query('SELECT 1 FROM message_extra_photo WHERE message_id = $1', [row.id]),
      ).toEqual([]);
    } finally {
      await ctx.cleanup();
    }
  });

  test('18 concurrent migrations from scratch all succeed and leave each object once', async () => {
    const ctx = await setup();
    try {
      // From scratch: the duplicate-key race of CREATE TABLE / CREATE INDEX IF
      // NOT EXISTS and of a new function is only open while the objects are
      // new; the queued boots then replace the existing functions one after
      // another, which also covers "tuple concurrently updated".
      await ctx.client.execute('DROP TABLE shop_identity');
      await ctx.client.execute(
        `DROP FUNCTION queue_shop_identity_place(), queue_shop_identity_cover(),
           queue_shop_identity_photo() CASCADE`,
      );
      await ctx.client.execute('DROP INDEX message_shop_candidate_idx');
      await ctx.client.execute('DROP INDEX message_shop_directory_idx');
      // One connection per boot, as 18 processes would open.
      const boots = Array.from({ length: 18 }, () =>
        createBunSqlClient(String(databaseUrl), { max: 1 }),
      );
      try {
        const results = await Promise.allSettled(
          boots.map(({ client }) => migrateShopIdentitySchema(client)),
        );
        expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
      } finally {
        await Promise.all(boots.map(({ sql }) => closeIfPossible(sql)));
      }
      expect(
        await ctx.client.query<{ tgname: string; n: string }>(
          `SELECT tgname, count(*)::text AS n FROM pg_trigger
           WHERE tgname IN ('trg_shop_identity_place', 'trg_shop_identity_cover',
             'trg_shop_identity_extra_photo')
           GROUP BY tgname ORDER BY tgname`,
        ),
      ).toEqual([
        { tgname: 'trg_shop_identity_cover', n: '1' },
        { tgname: 'trg_shop_identity_extra_photo', n: '1' },
        { tgname: 'trg_shop_identity_place', n: '1' },
      ]);
      expect(
        await ctx.client.query<{ proname: string; n: string }>(
          `SELECT proname, count(*)::text AS n FROM pg_proc
           WHERE proname IN ('queue_shop_identity_place', 'queue_shop_identity_cover',
             'queue_shop_identity_photo')
           GROUP BY proname ORDER BY proname`,
        ),
      ).toEqual([
        { proname: 'queue_shop_identity_cover', n: '1' },
        { proname: 'queue_shop_identity_photo', n: '1' },
        { proname: 'queue_shop_identity_place', n: '1' },
      ]);
      expect(
        await ctx.client.query<{ name: string; n: string }>(
          `SELECT relname AS name, count(*)::text AS n FROM pg_class
           WHERE relname IN ('shop_identity', 'shop_identity_key_order_idx',
             'message_shop_candidate_idx', 'message_shop_directory_idx')
           GROUP BY relname ORDER BY relname`,
        ),
      ).toEqual([
        { name: 'message_shop_candidate_idx', n: '1' },
        { name: 'message_shop_directory_idx', n: '1' },
        { name: 'shop_identity', n: '1' },
        { name: 'shop_identity_key_order_idx', n: '1' },
      ]);
    } finally {
      await ctx.cleanup();
    }
  });

  test('the backfill candidate read walks message_shop_directory_idx', async () => {
    const ctx = await setup();
    try {
      expect(
        await ctx.client.query<{ indexdef: string }>(
          `SELECT indexdef FROM pg_indexes WHERE indexname = 'message_shop_candidate_idx'`,
        ),
      ).toEqual([
        {
          indexdef:
            'CREATE INDEX message_shop_candidate_idx ON public.message USING btree (created_at, id) WHERE ((parent_id IS NULL) AND (deleted_at IS NULL) AND (shop_account_id IS NOT NULL) AND (place_lat IS NOT NULL))',
        },
      ]);
      // Many live top-level notes that are not shops, a few that are.
      for (let index = 0; index < 300; index += 1) {
        await ctx.messages.create(
          ctx.note({ text: `Plain note number ${index}.`, place: null, shopAccount: null }),
        );
      }
      for (let index = 0; index < 3; index += 1) {
        await ctx.messages.create(ctx.note({ text: `${TEXT} Shop ${index}.` }));
      }
      await ctx.client.execute('ANALYZE message');
      const seen: { text: string; params: readonly unknown[] }[] = [];
      const spy: SqlClient = {
        query: <T>(text: string, params: readonly unknown[] = []): Promise<T[]> => {
          seen.push({ text, params });
          return ctx.client.query<T>(text, params);
        },
        execute: (text, params) => ctx.client.execute(text, params),
      };
      const store = new PostgresShopIdentityStore(spy, ctx.messages);
      const first = await store.listCandidates(null, 50);
      expect(first).toHaveLength(3);
      const [read] = seen;
      expect(read!.text).not.toContain('(m.created_at, m.id) >');
      const plan = await ctx.client.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON) ${read!.text}`,
        read!.params,
      );
      expect(JSON.stringify(plan)).toContain('"Index Name":"message_shop_directory_idx"');
      // The page after a cursor is its own statement. Even under the generic
      // plan a prepared statement may cache, the cursor is an index condition.
      const cursor = { createdAt: first[0]!.createdAt, id: first[0]!.id };
      expect((await store.listCandidates(cursor, 50)).map((row) => row.id)).toEqual(
        first.slice(1).map((row) => row.id),
      );
      const after = seen[1]!;
      expect(after.text).not.toBe(read!.text);
      expect(after.text).not.toContain('IS NULL OR');
      expect(after.params).toEqual([cursor.createdAt, cursor.id, 50]);
      const generic = await ctx.sql.begin(async (tx) => {
        await tx.unsafe('SET LOCAL plan_cache_mode = force_generic_plan');
        await tx.unsafe(
          `PREPARE shop_candidate_after (timestamptz, uuid, bigint) AS ${after.text}`,
        );
        const rows = (await tx.unsafe(
          `EXPLAIN (FORMAT JSON) EXECUTE shop_candidate_after (
             '${cursor.createdAt.toISOString()}'::timestamptz, '${cursor.id}'::uuid, 50)`,
        )) as { 'QUERY PLAN': unknown }[];
        await tx.unsafe('DEALLOCATE shop_candidate_after');
        return rows;
      });
      const nodes: Record<string, unknown>[] = [];
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        if (node === null || typeof node !== 'object') return;
        const record = node as Record<string, unknown>;
        if (record['Index Name'] === 'message_shop_directory_idx') nodes.push(record);
        Object.values(record).forEach(walk);
      };
      walk(generic);
      expect(nodes).toHaveLength(1);
      expect(String(nodes[0]!['Index Cond'])).toMatch(/created_at.*\bid\b.*\$1.*\$2/);
    } finally {
      await ctx.cleanup();
    }
  });

  test('the backfill pages past keyed candidates one bounded raw page at a time', async () => {
    const ctx = await setup();
    try {
      for (let index = 0; index < 300; index += 1) {
        await ctx.messages.create(
          ctx.note({ text: `Plain note number ${index}.`, place: null, shopAccount: null }),
        );
      }
      const base = Date.UTC(2031, 0, 1);
      const keyed: string[] = [];
      for (let index = 0; index < 25; index += 1) {
        const row = ctx.note({ createdAt: new Date(base + index * 1000) });
        await ctx.messages.create(row);
        await ctx.shops.ensureListed(row.id, KEK);
        keyed.push(row.id);
      }
      const unkeyed = ctx.note({ createdAt: new Date(base + 25 * 1000) });
      await ctx.messages.create(unkeyed);
      await ctx.client.execute('ANALYZE message');
      const seen: { text: string; params: readonly unknown[] }[] = [];
      const spy: SqlClient = {
        query: <T>(text: string, params: readonly unknown[] = []): Promise<T[]> => {
          seen.push({ text, params });
          return ctx.client.query<T>(text, params);
        },
        execute: (text, params) => ctx.client.execute(text, params),
      };
      const store = new PostgresShopIdentityStore(spy, ctx.messages);
      // The worker's walk: advance on the raw page, key only unkeyed rows,
      // stop after a short raw page.
      let cursor = { createdAt: new Date(base - 1), id: unkeyed.id };
      const pages: { id: string; keyed: boolean }[][] = [];
      for (;;) {
        const page = await store.listCandidates(cursor, 20);
        expect(page.length).toBeLessThanOrEqual(20);
        pages.push(page.map((row) => ({ id: row.id, keyed: row.keyed })));
        for (const candidate of page) {
          if (!candidate.keyed) await ctx.shops.ensureListed(candidate.id, KEK);
        }
        const last = page[page.length - 1];
        if (page.length < 20 || last === undefined) break;
        cursor = { createdAt: last.createdAt, id: last.id };
      }
      const ids = [...keyed, unkeyed.id];
      expect(pages.flat().filter((row) => ids.includes(row.id))).toEqual([
        ...keyed.map((id) => ({ id, keyed: true })),
        { id: unkeyed.id, keyed: false },
      ]);
      expect(pages.length).toBeGreaterThanOrEqual(2);
      expect(await ctx.shops.getByMessageId(unkeyed.id)).toBeDefined();
      // The bounded raw page reads the partial index.
      const [read] = seen;
      expect(read!.text).toContain('LIMIT $3');
      const plan = await ctx.client.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON) ${read!.text}`,
        read!.params,
      );
      expect(JSON.stringify(plan)).toContain('"Index Name":"message_shop_directory_idx"');
    } finally {
      await ctx.cleanup();
    }
  });

  test('the operator dump read of shop identities is limited', async () => {
    const ctx = await setup();
    try {
      for (let index = 0; index < 3; index += 1) {
        const row = ctx.note();
        await ctx.messages.create(row);
        await ctx.shops.ensureListed(row.id, KEK);
      }
      const all = await ctx.shops.listAll();
      expect(all.length).toBeGreaterThanOrEqual(3);
      const limited = await ctx.shops.listDebug(2);
      expect(limited.map((row) => row.messageId)).toEqual(
        all.slice(0, 2).map((row) => row.messageId),
      );
    } finally {
      await ctx.cleanup();
    }
  });

  test('creates one key per listed note, keeps it, and queues every write by trigger', async () => {
    const ctx = await setup();
    try {
      const row = ctx.note({ hasPhoto: true });
      await ctx.messages.create(row, PNG, undefined, [PNG]);
      const [left, right] = await Promise.all([
        ctx.shops.ensureListed(row.id, KEK),
        ctx.shops.ensureListed(row.id, KEK),
      ]);
      expect(left?.nostrPubkey).toBe(right?.nostrPubkey ?? '');
      expect(left).toMatchObject({ ocpPlacePending: true, ocpPlaceGeneration: 1 });
      expect((await ctx.messages.getById(row.id))?.shopNpub).toMatch(/^npub1/);
      expect(
        (await ctx.messages.listPlaces(1000)).find((place) => place.id === row.id)?.shopNpub,
      ).toMatch(/^npub1/);

      const [claim] = await ctx.shops.claimPlaces(20, 60_000);
      expect(claim).toEqual({ messageId: row.id, generation: 1, claim: 1 });
      expect(await ctx.shops.claimPlaces(20, 60_000)).toEqual([]);
      expect(await ctx.shops.leaseHasTime('place', claim!, 15_000)).toBe(true);
      expect(await ctx.shops.leaseHasTime('place', claim!, 120_000)).toBe(false);
      expect(await ctx.shops.nextRevision('place', claim!)).toBe(1);
      await ctx.shops.finishPlace(claim!, 'put');
      // The settle stores its time as the lease end, never null.
      expect(await leaseEnded(ctx, row.id, 'place')).toBe(true);
      let identity = (await ctx.shops.getByMessageId(row.id))!;
      expect(identity).toMatchObject({
        ocpPlacePending: false,
        ocpPhotosPending: true,
        ocpPhotosGeneration: 2,
        ocpRevision: 1,
      });

      await ctx.messages.updateText(row.id, `${TEXT} More beans.`);
      identity = (await ctx.shops.getByMessageId(row.id))!;
      expect(identity).toMatchObject({
        ocpPlacePending: true,
        ocpPlaceGeneration: 2,
        ocpPhotosPending: true,
        ocpPhotosGeneration: 3,
        ocpRevision: 1,
      });

      await ctx.messages.replacePhotos(row.id, [PNG]);
      expect((await ctx.shops.getByMessageId(row.id))!.ocpPhotosGeneration).toBeGreaterThan(1);
      const photoGeneration = (await ctx.shops.getByMessageId(row.id))!.ocpPhotosGeneration;

      await ctx.messages.markDeleted(row.id, new Date(), ctx.accountId);
      identity = (await ctx.shops.getByMessageId(row.id))!;
      expect(identity.ocpPlaceGeneration).toBe(3);
      await ctx.messages.replacePhotos(row.id, []);
      expect((await ctx.shops.getByMessageId(row.id))!.ocpPhotosGeneration).toBe(photoGeneration);
      expect((await ctx.messages.getById(row.id))?.shopNpub).toMatch(/^npub1/);

      expect(await ctx.messages.deleteById(row.id)).toBe(false);
      expect(await ctx.messages.getById(row.id)).toBeDefined();

      await ctx.messages.markUndeleted(row.id);
      expect((await ctx.shops.getByMessageId(row.id))!.ocpPlaceGeneration).toBe(4);
      expect(await ctx.shops.queueAllPlacePage(null, 200)).toContain(row.id);
    } finally {
      await ctx.cleanup();
    }
  });

  test('claims the least recently claimed places and photo sets first, so failing rows never starve later shops', async () => {
    const ctx = await setup();
    try {
      const ids: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const row = ctx.note();
        await ctx.messages.create(row);
        await ctx.shops.ensureListed(row.id, KEK);
        ids.push(row.id);
      }
      const [a, b, c] = [...ids].sort() as [string, string, string];
      // Leases of 1 ms: after the pause every claim of the round before has
      // ended, as the claim of a failed send ends with its lease.
      const places = async (): Promise<string[]> => {
        await Bun.sleep(5);
        return (await ctx.shops.claimPlaces(2, 1)).map((claim) => claim.messageId).sort();
      };
      expect(await places()).toEqual([a, b]);
      // C, never claimed, goes before both; A and B share a lease end, so the id decides.
      expect(await places()).toEqual([a, c]);
      // B's lease ended a round before those of A and C.
      expect(await places()).toEqual([a, b]);
      // C's lease ended first. Its next claim is released after the leases of
      // A and B ended, which counts as a lease that ended at the release, so
      // A and B go before C.
      await Bun.sleep(5);
      const [held] = await ctx.shops.claimPlaces(1, 60_000);
      expect(held?.messageId).toBe(c);
      await Bun.sleep(5);
      await ctx.shops.release('place', held!);
      expect(await ctx.shops.leaseHasTime('place', held!, 0)).toBe(false);
      expect(await places()).toEqual([a, b]);
      // Confirm every place, which queues every photo set.
      await Bun.sleep(5);
      const confirmed = await ctx.shops.claimPlaces(20, 60_000);
      expect(confirmed.map((claim) => claim.messageId).sort()).toEqual([a, b, c]);
      for (const claim of confirmed) await ctx.shops.finishPlace(claim, 'put');
      // Photos are already pending at revision 0. Claiming one here would
      // hold its lease and change the order below. The revision is raised
      // before the photo order is checked.
      for (const claim of confirmed) expect(await ctx.shops.nextRevision('place', claim)).toBe(1);
      const photo = async (): Promise<string | undefined> => {
        await Bun.sleep(5);
        return (await ctx.shops.claimPhoto(1))?.messageId;
      };
      // Every claim fails and ends with its lease; the photo lane still visits
      // every shop before it picks a failed one again.
      expect([await photo(), await photo(), await photo()]).toEqual([a, b, c]);
      expect([await photo(), await photo(), await photo()]).toEqual([a, b, c]);
    } finally {
      await ctx.cleanup();
    }
  });

  test('puts a place or photo set changed during its claim behind the other pending rows', async () => {
    const ctx = await setup();
    try {
      const rows: MessageRow[] = [];
      for (let index = 0; index < 2; index += 1) {
        // Distinct text: a second live photo note with the same content returns the first.
        const row = ctx.note({ hasPhoto: true, text: `${TEXT} Shop ${index}.` });
        await ctx.messages.create(row, PNG, undefined, [PNG]);
        await ctx.shops.ensureListed(row.id, KEK);
        rows.push(row);
      }
      const [first, second] = [...rows].sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      ) as [MessageRow, MessageRow];
      expect(await ctx.shops.getByMessageId(second.id)).toBeDefined();
      // The place of the first shop changes while it is sent: it stays
      // pending with its lease ended now, so the never-claimed second goes first.
      const [place] = await ctx.shops.claimPlaces(1, 60_000);
      expect(place?.messageId).toBe(first.id);
      await ctx.messages.updateText(first.id, `${TEXT} Changed.`);
      await ctx.shops.finishPlace(place!, 'put');
      expect((await ctx.shops.getByMessageId(first.id))?.ocpPlacePending).toBe(true);
      const [secondPlace] = await ctx.shops.claimPlaces(1, 60_000);
      expect(secondPlace?.messageId).toBe(second.id);
      const [firstAgain] = await ctx.shops.claimPlaces(1, 60_000);
      expect(firstAgain?.messageId).toBe(first.id);
      // Both places settle, which queues both photo sets. The revision is
      // raised first, as the place sender does before the request.
      await ctx.shops.nextRevision('place', secondPlace!);
      await ctx.shops.finishPlace(secondPlace!, 'put');
      await ctx.shops.nextRevision('place', firstAgain!);
      await ctx.shops.finishPlace(firstAgain!, 'put');
      // The same for the photos of the first shop.
      const photo = (await ctx.shops.claimPhoto(60_000))!;
      expect(photo.messageId).toBe(first.id);
      await ctx.messages.replacePhotos(first.id, [PNG, PNG]);
      await ctx.shops.finishPhotos(photo, 'hash');
      expect((await ctx.shops.getByMessageId(first.id))?.ocpPhotosPending).toBe(true);
      expect((await ctx.shops.claimPhoto(60_000))?.messageId).toBe(second.id);
      expect((await ctx.shops.claimPhoto(60_000))?.messageId).toBe(first.id);
    } finally {
      await ctx.cleanup();
    }
  });

  test('puts a place or photo set changed after its settle behind a row never claimed', async () => {
    const ctx = await setup();
    try {
      const rows: MessageRow[] = [];
      for (let index = 0; index < 2; index += 1) {
        // Distinct text: a second live photo note with the same content returns the first.
        const row = ctx.note({ hasPhoto: true, text: `${TEXT} Shop ${index}.` });
        await ctx.messages.create(row, PNG, undefined, [PNG]);
        await ctx.shops.ensureListed(row.id, KEK);
        rows.push(row);
      }
      const [first, second] = [...rows].sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      ) as [MessageRow, MessageRow];
      // The first place settles, then its note changes: the trigger queues it
      // again and keeps the lease end of the settle, so the never-claimed
      // second place goes first.
      const [place] = await ctx.shops.claimPlaces(1, 60_000);
      expect(place?.messageId).toBe(first.id);
      await ctx.shops.finishPlace(place!, 'put');
      await ctx.messages.updateText(first.id, `${TEXT} Changed.`);
      expect((await ctx.shops.getByMessageId(first.id))?.ocpPlacePending).toBe(true);
      const [secondPlace] = await ctx.shops.claimPlaces(1, 60_000);
      expect(secondPlace?.messageId).toBe(second.id);
      const [firstAgain] = await ctx.shops.claimPlaces(1, 60_000);
      expect(firstAgain?.messageId).toBe(first.id);
      await ctx.shops.nextRevision('place', secondPlace!);
      await ctx.shops.finishPlace(secondPlace!, 'put');
      await ctx.shops.nextRevision('place', firstAgain!);
      await ctx.shops.finishPlace(firstAgain!, 'put');
      // The same for the photos of the first shop.
      const photo = (await ctx.shops.claimPhoto(60_000))!;
      expect(photo.messageId).toBe(first.id);
      await ctx.shops.finishPhotos(photo, 'hash');
      expect((await ctx.shops.getByMessageId(first.id))?.ocpPhotosPending).toBe(false);
      await ctx.messages.replacePhotos(first.id, [PNG, PNG]);
      expect((await ctx.shops.getByMessageId(first.id))?.ocpPhotosPending).toBe(true);
      expect((await ctx.shops.claimPhoto(60_000))?.messageId).toBe(second.id);
      expect((await ctx.shops.claimPhoto(60_000))?.messageId).toBe(first.id);
    } finally {
      await ctx.cleanup();
    }
  });

  test('creates no key for a note that is not a shop, and keys a pin-only shop', async () => {
    const ctx = await setup();
    try {
      const untagged = ctx.note({ text: 'A forum note without the shop tag.' });
      await ctx.messages.create(untagged);
      expect(await ctx.shops.ensureListed(untagged.id, KEK)).toBeUndefined();
      expect(
        (await ctx.shops.listCandidates(null, 1000)).some((row) => row.id === untagged.id),
      ).toBe(false);
      const pinOnly = ctx.note({
        place: { lat: 14.6, lng: 120.9, label: 'Stall', address: null },
      });
      await ctx.messages.create(pinOnly);
      expect((await ctx.shops.ensureListed(pinOnly.id, KEK))?.profileName).toBe('Stall');
      const page = await ctx.shops.listDirectory(null, 10);
      expect(
        page.shops.some((shop) => shop.id === pinOnly.id && shop.place?.address === null),
      ).toBe(true);
      const bare = ctx.note({ place: null, text: '#21GiftsShop' });
      await ctx.messages.create(bare);
      expect((await ctx.shops.ensureListed(bare.id, KEK))?.profileName).toBe('Shop');
      const moved = ctx.note();
      await ctx.messages.create(moved);
      const stale = new PostgresShopIdentityStore(ctx.client, {
        getById: async (id: string) => ({
          ...(await ctx.messages.getById(id))!,
          text: `${TEXT} Older text.`,
        }),
      } as unknown as PostgresMessageStore);
      expect(await stale.ensureListed(moved.id, KEK)).toBeUndefined();
      expect(await ctx.shops.ensureListed(moved.id, KEK)).toBeDefined();
    } finally {
      await ctx.cleanup();
    }
  });

  test('keeps a shop listed when its till account has no username', async () => {
    const ctx = await setup();
    try {
      const row = ctx.note();
      await ctx.messages.create(row);
      // An account merge keeps the survivor's username, which can be empty.
      await ctx.client.execute('UPDATE account SET username = NULL WHERE id = $1', [ctx.accountId]);
      const stored = (await ctx.messages.getById(row.id))!;
      expect(stored.shopAccount).toEqual({ id: ctx.accountId, username: null, name: 'Coffee' });
      expect(isListedShop(stored)).toBe(true);
      const identity = (await ctx.shops.ensureListed(row.id, KEK))!;
      expect(identity.ocpPlacePending).toBe(true);
      const body = serializeMessage((await ctx.messages.getById(row.id))!, NOT_PAYABLE, 'basis');
      expect(body.shopNpub).toBe(shopNpub(identity));
      expect(body).not.toHaveProperty('shopAccount');
      const sent: string[] = [];
      await runOcpPlaceOutboxPass({
        identities: ctx.shops,
        messages: ctx.messages,
        mapPush: {
          baseUrl: 'https://map.test',
          token: 't',
          fetchImpl: async (_url: string, init: RequestInit): Promise<Response> => {
            sent.push(String(init.method));
            return new Response('{}', { status: 201 });
          },
        },
      });
      expect(sent).toEqual(['PUT']);
    } finally {
      await ctx.cleanup();
    }
  });

  test('a rename from an older note snapshot does not overwrite a newer one', async () => {
    const ctx = await setup();
    try {
      const row = ctx.note();
      await ctx.messages.create(row);
      await ctx.shops.ensureListed(row.id, KEK);
      const older = (await ctx.messages.getById(row.id))!;
      await ctx.messages.setPlace(row.id, { ...PLACE, label: 'Roastery' });
      expect((await ctx.shops.ensureListed(row.id, KEK))?.profileName).toBe('Roastery');
      // An overlapping request that read the note before the rename comes last.
      const stale = new PostgresShopIdentityStore(ctx.client, {
        getById: async () => older,
      } as unknown as PostgresMessageStore);
      expect((await stale.ensureListed(row.id, KEK))?.profileName).toBe('Roastery');
      expect((await ctx.shops.getByMessageId(row.id))?.profileName).toBe('Roastery');
    } finally {
      await ctx.cleanup();
    }
  });

  test('a worker rename from an older note snapshot does not overwrite a newer one', async () => {
    const ctx = await setup();
    try {
      const row = ctx.note();
      await ctx.messages.create(row);
      await ctx.shops.ensureListed(row.id, KEK);
      const older = (await ctx.messages.getById(row.id))!;
      await ctx.messages.setPlace(row.id, { ...PLACE, label: 'Roastery' });
      const newer = (await ctx.messages.getById(row.id))!;
      // The tick that read the renamed note writes the new name.
      await ctx.shops.renameIfListed(newer);
      expect((await ctx.shops.getByMessageId(row.id))?.profileName).toBe('Roastery');
      // An overlapping tick that read the note before the rename writes last.
      await ctx.shops.renameIfListed(older);
      expect((await ctx.shops.getByMessageId(row.id))?.profileName).toBe('Roastery');
      // Unlisted before the next tick: the stored name is still the newest.
      await ctx.messages.setShopAccount(row.id, null);
      await ctx.shops.renameIfListed(older);
      expect((await ctx.shops.getByMessageId(row.id))?.profileName).toBe('Roastery');
    } finally {
      await ctx.cleanup();
    }
  });

  test('runs both outboxes against the real statements', async () => {
    const ctx = await setup();
    try {
      const row = ctx.note({ hasPhoto: true });
      await ctx.messages.create(row, PNG, undefined, [PNG]);
      const identity = (await ctx.shops.ensureListed(row.id, KEK))!;
      expect((await ctx.shops.getByPubkey(identity.nostrPubkey))?.messageId).toBe(row.id);
      const signed = await signEventForShop(ctx.shops, row.id, KEK, {
        kind: 0,
        content: '{}',
        tags: [],
        created_at: 1,
      });
      expect(signed.pubkey).toBe(identity.nostrPubkey);
      expect((await ctx.shops.listAll()).find((r) => r.messageId === row.id)?.profileName).toBe(
        'Coffee Lab',
      );

      const answers: Array<{ status: number; body: string }> = [];
      const sent: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
      const mapPush = {
        baseUrl: 'https://map.test',
        token: 't',
        fetchImpl: async (url: string, init: RequestInit): Promise<Response> => {
          sent.push({
            url,
            method: String(init.method),
            body: JSON.parse(String(init.body)) as Record<string, unknown>,
          });
          const next = answers.shift()!;
          return new Response(next.body, { status: next.status });
        },
      };
      const deps = { identities: ctx.shops, messages: ctx.messages, mapPush };
      const state = async () => (await ctx.shops.getByMessageId(row.id))!;
      const releasePlace = () =>
        ctx.client.execute(
          'UPDATE shop_identity SET ocp_place_claimed_until = NULL WHERE message_id = $1',
          [row.id],
        );
      const releasePhotos = () =>
        ctx.client.execute(
          'UPDATE shop_identity SET ocp_photos_claimed_until = NULL WHERE message_id = $1',
          [row.id],
        );

      answers.push({ status: 201, body: '{}' });
      await runOcpPlaceOutboxPass(deps);
      expect(sent.at(-1)).toMatchObject({ method: 'PUT', body: { revision: 1 } });
      expect(await state()).toMatchObject({
        ocpPlacePending: false,
        ocpPhotosPending: true,
        ocpRevision: 1,
      });

      answers.push({ status: 200, body: '{"photos":[],"skipped":[]}' });
      await runOcpPhotoOutboxPass(deps);
      expect(sent.at(-1)).toMatchObject({
        url: 'https://map.test/map/places/photos',
        body: { revision: 2 },
      });
      const stored = await state();
      expect(stored.ocpPhotosPending).toBe(false);
      expect(stored.ocpPhotosHash).toMatch(/^[0-9a-f]{64}$/);

      await ctx.client.execute(
        'UPDATE shop_identity SET ocp_photos_pending = true, ocp_photos_generation = ocp_photos_generation + 1 WHERE message_id = $1',
        [row.id],
      );
      await runOcpPhotoOutboxPass(deps);
      expect(sent).toHaveLength(2);
      expect((await state()).ocpPhotosPending).toBe(false);

      await ctx.messages.replacePhotos(row.id, [PNG, PNG, PNG]);
      answers.push({ status: 404, body: '404 Not Found' });
      await runOcpPhotoOutboxPass(deps);
      const deferred = await state();
      expect(deferred).toMatchObject({
        ocpPhotosHash: null,
        ocpPhotosPending: true,
        ocpPlacePending: true,
      });
      expect(deferred.ocpPhotosClaimedUntil).not.toBeNull();
      expect(deferred.ocpPlaceClaimedUntil).toEqual(deferred.ocpPhotosClaimedUntil);
      const beforeLease = sent.length;
      await runOcpPlaceOutboxPass(deps);
      await runOcpPhotoOutboxPass(deps);
      expect(sent).toHaveLength(beforeLease);
      await releasePlace();
      answers.push({ status: 200, body: '{}' });
      await runOcpPlaceOutboxPass(deps);
      expect(await state()).toMatchObject({ ocpPlacePending: false, ocpPhotosPending: true });
      await releasePhotos();

      answers.push({ status: 404, body: '{"error":"Place not found"}' });
      await runOcpPhotoOutboxPass(deps);
      expect(await state()).toMatchObject({
        ocpPhotosHash: null,
        ocpPhotosPending: false,
        ocpPlacePending: true,
      });

      answers.push({ status: 409, body: '{"error":"Stale revision"}' });
      await runOcpPlaceOutboxPass(deps);
      expect((await state()).ocpPlacePending).toBe(true);
      // The release ends the lease at the database's now: claimable at once, not null.
      expect(
        await ctx.client.query<{ due: boolean }>(
          `SELECT ocp_place_claimed_until IS NOT NULL AND ocp_place_claimed_until <= now() AS due
           FROM shop_identity WHERE message_id = $1`,
          [row.id],
        ),
      ).toEqual([{ due: true }]);

      answers.push({ status: 200, body: '{}' });
      await runOcpPlaceOutboxPass(deps);
      expect(await state()).toMatchObject({ ocpPlacePending: false, ocpPhotosPending: true });

      answers.push({ status: 413, body: '{"error":"too large"}' });
      await runOcpPhotoOutboxPass(deps);
      expect((await state()).ocpPhotosPending).toBe(false);

      await ctx.messages.markDeleted(row.id, new Date(), ctx.accountId);
      answers.push({ status: 503, body: '' });
      await runOcpPlaceOutboxPass(deps);
      expect(sent.at(-1)).toMatchObject({ method: 'DELETE' });
      expect(await state()).toMatchObject({ ocpPlacePending: true, ocpPhotosHash: null });
      await releasePlace();
      answers.push({ status: 200, body: '{"deleted":true}' });
      await runOcpPlaceOutboxPass(deps);
      expect((await state()).ocpPlacePending).toBe(false);

      await ctx.messages.markUndeleted(row.id);
      answers.push({ status: 400, body: '{"error":"bad"}' });
      await runOcpPlaceOutboxPass(deps);
      expect((await state()).ocpPlacePending).toBe(false);
      await releasePhotos();
      expect((await state()).ocpRevision).toBe(sent.length);
    } finally {
      await ctx.cleanup();
    }
  });

  /**
   * Whether the lane's last claim has ended: every end of a claim stores the
   * database's now as the lease end, so it is set and already over.
   */
  async function leaseEnded(
    ctx: Awaited<ReturnType<typeof setup>>,
    id: string,
    lane: 'place' | 'photos',
  ): Promise<boolean> {
    const column = lane === 'place' ? 'ocp_place_claimed_until' : 'ocp_photos_claimed_until';
    const rows = await ctx.client.query<{ ended: boolean }>(
      `SELECT ${column} IS NOT NULL AND ${column} <= now() AS ended
       FROM shop_identity WHERE message_id = $1`,
      [id],
    );
    return rows[0]?.ended === true;
  }

  /**
   * A listed shop with a confirmed place and pending photos, and outbox deps
   * whose `getPhotoSet` runs `between` once, after the photo pass
   * claimed the row and read the photos and before it reserves a revision.
   */
  async function photoRace(
    ctx: Awaited<ReturnType<typeof setup>>,
    between: (deps: Parameters<typeof runOcpPlaceOutboxPass>[0], id: string) => Promise<void>,
  ): Promise<{
    id: string;
    sent: Array<{ url: string; method: string; revision: unknown }>;
    deps: Parameters<typeof runOcpPlaceOutboxPass>[0];
  }> {
    const row = ctx.note({ hasPhoto: true });
    await ctx.messages.create(row, PNG, undefined, [PNG]);
    await ctx.shops.ensureListed(row.id, KEK);
    const sent: Array<{ url: string; method: string; revision: unknown }> = [];
    let hooked = false;
    const messages = new Proxy(ctx.messages, {
      get(target, key) {
        if (key === 'getPhotoSet') {
          return async (id: string) => {
            const set = await target.getPhotoSet(id);
            if (!hooked) {
              hooked = true;
              await between(deps, id);
            }
            return set;
          };
        }
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const deps = {
      identities: ctx.shops,
      messages,
      mapPush: {
        baseUrl: 'https://map.test',
        token: 't',
        fetchImpl: async (url: string, init: RequestInit): Promise<Response> => {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          sent.push({ url, method: String(init.method), revision: body['revision'] });
          return new Response('{}', { status: 200 });
        },
      },
    };
    await runOcpPlaceOutboxPass(deps);
    expect(await ctx.shops.getByMessageId(row.id)).toMatchObject({
      ocpPlacePending: false,
      ocpPhotosPending: true,
      ocpRevision: 1,
    });
    expect(hooked).toBe(false);
    return { id: row.id, sent, deps };
  }

  test('a photo pass that read the photos before a hide sends nothing and reserves no revision', async () => {
    const ctx = await setup();
    try {
      const race = await photoRace(ctx, async (_deps, id) => {
        await ctx.messages.markDeleted(id, new Date(), ctx.accountId);
      });
      await runOcpPhotoOutboxPass(race.deps);
      expect(race.sent).toEqual([
        { url: 'https://map.test/map/places', method: 'PUT', revision: 1 },
      ]);
      expect(await ctx.shops.getByMessageId(race.id)).toMatchObject({
        ocpRevision: 1,
        ocpPlacePending: true,
        ocpPhotosPending: true,
      });
      expect(await leaseEnded(ctx, race.id, 'photos')).toBe(true);
      await runOcpPlaceOutboxPass(race.deps);
      await runOcpPhotoOutboxPass(race.deps);
      expect(race.sent.map((request) => [request.method, request.revision])).toEqual([
        ['PUT', 1],
        ['DELETE', 2],
      ]);
      expect(await ctx.shops.getByMessageId(race.id)).toMatchObject({
        ocpRevision: 2,
        ocpPlacePending: false,
        ocpPhotosPending: false,
      });
    } finally {
      await ctx.cleanup();
    }
  });

  test('a photo pass that read the photos before the place lane deleted the shop sends nothing', async () => {
    const ctx = await setup();
    try {
      const race = await photoRace(ctx, async (deps, id) => {
        await ctx.messages.markDeleted(id, new Date(), ctx.accountId);
        await runOcpPlaceOutboxPass(deps);
      });
      await runOcpPhotoOutboxPass(race.deps);
      expect(race.sent.map((request) => [request.method, request.revision])).toEqual([
        ['PUT', 1],
        ['DELETE', 2],
      ]);
      expect(await ctx.shops.getByMessageId(race.id)).toMatchObject({
        ocpRevision: 2,
        ocpPlacePending: false,
        ocpPhotosPending: false,
      });
      expect(await leaseEnded(ctx, race.id, 'photos')).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  });

  test('reads the photo content types of a shop note without its bytes', async () => {
    const ctx = await setup();
    try {
      const row = ctx.note({ hasPhoto: true });
      await ctx.messages.create(row, PNG, undefined, [
        { contentType: 'image/jpeg', bytes: new Uint8Array([4, 5]) },
        { contentType: 'image/webp', bytes: new Uint8Array([6]) },
      ]);
      expect(await ctx.messages.getPhotoContentTypes(row.id)).toEqual({
        photo: 'image/png',
        extras: [
          { index: 1, contentType: 'image/jpeg' },
          { index: 2, contentType: 'image/webp' },
        ],
      });
      // Same answer as the byte reads it replaces in shop kind 0.
      expect((await ctx.messages.getPhoto(row.id))?.contentType).toBe('image/png');
      expect((await ctx.messages.listExtraPhotos(row.id)).map((p) => p.contentType)).toEqual([
        'image/jpeg',
        'image/webp',
      ]);
      const plain = ctx.note();
      await ctx.messages.create(plain);
      expect(await ctx.messages.getPhotoContentTypes(plain.id)).toEqual({
        photo: null,
        extras: [],
      });
      expect(await ctx.messages.getPhotoContentTypes(crypto.randomUUID())).toEqual({
        photo: null,
        extras: [],
      });
    } finally {
      await ctx.cleanup();
    }
  });

  for (const bad of [0, 1, 2]) {
    test(`leaves out an unrecognized type at index ${String(bad)} and keeps the stored index of the stills after it`, async () => {
      const ctx = await setup();
      try {
        const row = ctx.note({ hasPhoto: true });
        const stills = [
          PNG,
          { contentType: 'image/jpeg' as const, bytes: new Uint8Array([4, 5]) },
          { contentType: 'image/webp' as const, bytes: new Uint8Array([6]) },
          { contentType: 'image/png' as const, bytes: new Uint8Array([7]) },
        ];
        await ctx.messages.create(row, PNG, undefined, stills.slice(1));
        if (bad === 0) {
          await ctx.client.execute(
            `UPDATE message SET photo_content_type = 'image/gif' WHERE id = $1`,
            [row.id],
          );
        } else {
          await ctx.client.execute(
            `UPDATE message_extra_photo SET photo_content_type = 'image/gif'
             WHERE message_id = $1 AND idx = $2`,
            [row.id, bad],
          );
        }
        const extras = [1, 2, 3].filter((index) => index !== bad);
        expect(await ctx.messages.getPhotoContentTypes(row.id)).toEqual({
          photo: bad === 0 ? null : 'image/png',
          extras: extras.map((index) => ({ index, contentType: stills[index]!.contentType })),
        });
        const set = await ctx.messages.getPhotoSet(row.id);
        expect(set.photo === null ? null : [set.photo.contentType, [...set.photo.bytes]]).toEqual(
          bad === 0 ? null : ['image/png', [1, 2, 3]],
        );
        expect(
          set.extras.map(({ index, photo }) => [index, photo.contentType, [...photo.bytes]]),
        ).toEqual(
          extras.map((index) => [index, stills[index]!.contentType, [...stills[index]!.bytes]]),
        );
      } finally {
        await ctx.cleanup();
      }
    });
  }

  test('reads the whole photo set of a note in one statement, never a mixed set', async () => {
    const ctx = await setup();
    try {
      const row = ctx.note({ hasPhoto: true });
      const jpeg = { contentType: 'image/jpeg' as const, bytes: new Uint8Array([4, 5]) };
      const webp = { contentType: 'image/webp' as const, bytes: new Uint8Array([6]) };
      const first = [PNG, jpeg, webp];
      const second = [webp, PNG];
      await ctx.messages.create(row, PNG, undefined, [jpeg, webp]);
      // The same stills as the two separate reads.
      expect(await ctx.messages.getPhotoSet(row.id)).toEqual({
        photo: await ctx.messages.getPhoto(row.id),
        extras: (await ctx.messages.listExtraPhotos(row.id)).map((photo, position) => ({
          index: position + 1,
          photo,
        })),
      });
      // Plain arrays, so Bun's Buffer and a Uint8Array compare by content.
      const plainStills = (photos: readonly ForumPhoto[]): unknown =>
        photos.map((photo) => ({ contentType: photo.contentType, bytes: [...photo.bytes] }));
      const asList = (set: Awaited<ReturnType<PostgresMessageStore['getPhotoSet']>>): unknown =>
        plainStills([
          ...(set.photo === null ? [] : [set.photo]),
          ...set.extras.map((extra) => extra.photo),
        ]);
      // replacePhotos swaps photo 0 and the extras in one transaction: every
      // read during the swaps is one whole set.
      for (let round = 0; round < 10; round += 1) {
        const reads = await Promise.all([
          ctx.messages.replacePhotos(row.id, round % 2 === 0 ? second : first),
          ctx.messages.getPhotoSet(row.id),
          ctx.messages.getPhotoSet(row.id),
        ]);
        for (const set of reads.slice(1) as Array<
          Awaited<ReturnType<PostgresMessageStore['getPhotoSet']>>
        >) {
          expect([plainStills(first), plainStills(second)]).toContainEqual(asList(set));
        }
      }
      const plain = ctx.note();
      await ctx.messages.create(plain);
      expect(await ctx.messages.getPhotoSet(plain.id)).toEqual({ photo: null, extras: [] });
      expect(await ctx.messages.getPhotoSet(crypto.randomUUID())).toEqual({
        photo: null,
        extras: [],
      });
    } finally {
      await ctx.cleanup();
    }
  });

  test('pages the round robin with bounded keyset reads and wraps at the end', async () => {
    const ctx = await setup();
    try {
      const ids: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const row = ctx.note();
        await ctx.messages.create(row);
        await ctx.shops.ensureListed(row.id, KEK);
        ids.push(row.id);
      }
      expect(
        await ctx.client.query<{ n: string }>('SELECT count(*)::text AS n FROM shop_identity'),
      ).toEqual([{ n: '5' }]);
      // Rows 0 and 1 share a key time, so the message id orders them.
      const order = [...ids.slice(0, 2)].sort().concat(ids.slice(2));
      for (const [index, id] of order.entries()) {
        await ctx.client.execute(
          `UPDATE shop_identity SET nostr_key_created_at = $2 WHERE message_id = $1`,
          [id, new Date(Date.UTC(2026, 9, 1, 0, 0, 0, Math.max(index, 1)))],
        );
      }
      expect((await ctx.shops.listAll()).map((row) => row.messageId)).toEqual(order);
      const rows = await ctx.shops.listAll();
      const at = (index: number): { createdAt: Date; messageId: string } => ({
        createdAt: rows[index]!.nostrKeyCreatedAt,
        messageId: rows[index]!.messageId,
      });
      const round = async (
        cursor: { createdAt: Date; messageId: string } | null,
        limit: number,
      ): Promise<string[]> =>
        (await ctx.shops.listRound(cursor, limit)).map((row) => row.messageId);
      expect(await round(null, 2)).toEqual(order.slice(0, 2));
      expect(await round(at(0), 1)).toEqual([order[1]!]);
      expect(await round(at(1), 2)).toEqual(order.slice(2, 4));
      expect(await round(at(3), 3)).toEqual([order[4]!, order[0]!, order[1]!]);
      expect(await round(at(2), 20)).toEqual([
        order[3]!,
        order[4]!,
        order[0]!,
        order[1]!,
        order[2]!,
      ]);
      const gone = { createdAt: rows[4]!.nostrKeyCreatedAt, messageId: crypto.randomUUID() };
      expect((await round(gone, 5)).length).toBe(5);
      expect(
        await ctx.client.query<{ indexdef: string }>(
          `SELECT indexdef FROM pg_indexes WHERE indexname = 'shop_identity_key_order_idx'`,
        ),
      ).toEqual([
        {
          indexdef:
            'CREATE INDEX shop_identity_key_order_idx ON public.shop_identity USING btree (nostr_key_created_at, message_id)',
        },
      ]);
      // The NIP-05 allocation reads every shop note with one uuid[] statement.
      const notes = await ctx.messages.getByIds([...ids, crypto.randomUUID()]);
      expect(notes.map((note) => note.id).sort()).toEqual([...ids].sort());
      expect(await ctx.messages.getByIds([])).toEqual([]);
    } finally {
      await ctx.cleanup();
    }
  });
});

describe('PostgresWalletUsageStore', () => {
  test('merges completed payments and reads forum invoices and shop charges', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    const ids: string[] = [];
    const payoutIds: string[] = [];
    const paymentHashes: string[] = [];
    const messageIds: string[] = [];
    const receiptIds: string[] = [];
    const sparkInvoices: string[] = [];
    // Every inserted text id carries this prefix, so the assertions never read
    // another run's rows from the shared database.
    const run = `usage-${crypto.randomUUID()}`;
    let previousPlatform: string | undefined;
    let platformId: string | undefined;
    try {
      await migrateAuthSchema(client);
      await migrateMessageSchema(client);
      await migratePosSchema(client);
      await migrateFondPayoutSchema(client);
      await migrateWalletSchema(client);
      await migrateSparkInvoiceSchema(client);
      await migrateDbChangeSchema(client);

      const previous = await client.query<{ id: string }>(
        `SELECT id FROM account WHERE is_platform LIMIT 1`,
      );
      const previousRow = previous[0];
      if (previousRow !== undefined) {
        previousPlatform = previousRow.id;
      }

      const auth = new PostgresAuthStore(client);
      const hex64 = (): string =>
        `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
      const create = async (role: 'basis' | 'fond', isPlatform: boolean): Promise<string> => {
        const id = crypto.randomUUID();
        await auth.createAccount({
          id,
          linkingKey: null,
          role,
          name: null,
          username: `usage_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
          location: null,
          forumLawsDismissed: false,
          viewKey: hex64(),
          createdAt: Date.now(),
          rulesAgreedAt: null,
          walletRequired: true,
          ...(isPlatform ? { isPlatform: true } : {}),
        });
        ids.push(id);
        return id;
      };
      const memberA = await create('basis', false);
      const memberB = await create('basis', false);
      const shop = await create('basis', false);
      const fund = await create('fond', false);
      platformId = await create('fond', true);

      const since = new Date(Date.UTC(2400, 0, 1 + Math.floor(Math.random() * 300), 12, 0, 0));
      const at = (minutes: number): Date => new Date(since.getTime() + minutes * 60_000);
      const bolt11 = `${run}-bolt`;
      const sparkInvoice = `${run}-spark`;
      const owedInvoice = `${run}-owed`;
      const forumPr = `${run}-forum-pr`;
      const invoiceOnlyPr = `${run}-invoice-only-pr`;

      const insertNote = async (accountId: string, hidden: boolean): Promise<string> => {
        const id = crypto.randomUUID();
        messageIds.push(id);
        await client.execute(
          `INSERT INTO message (id, account_id, name, text, created_at, deleted_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, accountId, 'Usage note', `${run} note`, at(0), hidden ? at(5) : null],
        );
        return id;
      };

      const insertShopNote = async (
        accountId: string,
        shopAccountId: string,
        hidden: boolean,
      ): Promise<string> => {
        const id = crypto.randomUUID();
        messageIds.push(id);
        await client.execute(
          `INSERT INTO message (id, account_id, shop_account_id, name, text, created_at, deleted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            id,
            accountId,
            shopAccountId,
            'Usage shop note',
            `${run} shop #21GiftsShop`,
            at(0),
            hidden ? at(5) : null,
          ],
        );
        return id;
      };

      const insertPayment = async (row: {
        accountId: string;
        paymentId: string;
        direction: 'in' | 'out';
        status: string;
        amountSats: number;
        feeSats: number;
        paidAt: Date;
        category: string;
        counterpartyAccountId: string | null;
        paymentHash: string | null;
        invoice: string | null;
        destination?: string | null;
      }): Promise<void> => {
        await client.execute(
          `INSERT INTO wallet_payment (
             account_id, payment_id, direction, status, amount_sats, fee_sats, paid_at,
             method, payment_hash, invoice, destination, description, lnurl_comment,
             category, counterparty_account_id, first_seen_at, updated_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,'lightning',$8,$9,$12,NULL,NULL,$10,$11,$7,$7
           )`,
          [
            row.accountId,
            row.paymentId,
            row.direction,
            row.status,
            row.amountSats,
            row.feeSats,
            row.paidAt,
            row.paymentHash,
            row.invoice,
            row.category,
            row.counterpartyAccountId,
            row.destination ?? null,
          ],
        );
      };
      const insertPayout = async (
        status: string,
        bolt: string | null,
        spark: string | null,
      ): Promise<void> => {
        const id = crypto.randomUUID();
        payoutIds.push(id);
        await client.execute(
          `INSERT INTO fond_payout (
             id, utc_day, kind, address, amount_usd, comment, status, bolt11, spark_invoice
           ) VALUES ($1, '2400-01-01', 'welcome', $2, '1.00', 'usage', $3, $4, $5)`,
          [id, `${run}-${id}`, status, bolt, spark],
        );
      };
      const insertSparkInvoice = async (paymentHash: string, invoice: string): Promise<void> => {
        sparkInvoices.push(invoice);
        await client.execute(
          `INSERT INTO spark_invoice (
             payment_hash, invoice, receiver_pubkey, amount_sats, bolt11, zap_request,
             created_at, status
           ) VALUES ($1,$2,$3,1,$4,$5,$6,'settled')`,
          [
            paymentHash,
            invoice,
            hex64(),
            `${run}-spark-bolt-${crypto.randomUUID()}`,
            `${run}-spark-zap-request-${crypto.randomUUID()}`,
            at(0),
          ],
        );
      };

      const platformProfileNoteId = await insertNote(platformId, false);
      await client.execute(`UPDATE account SET profile_message_id = $1 WHERE id = $2`, [
        platformProfileNoteId,
        platformId,
      ]);
      // A platform-authored note that is not the profile note is ordinary and
      // can receive a real forum gift.
      const platformOrdinaryNoteId = await insertNote(platformId, false);

      await insertPayment({
        accountId: memberA,
        paymentId: `${run}-g1`,
        direction: 'out',
        status: 'completed',
        amountSats: 100,
        feeSats: 200,
        paidAt: at(120),
        category: 'unknown',
        counterpartyAccountId: null,
        paymentHash: null,
        invoice: null,
      });
      await insertPayment({
        accountId: shop,
        paymentId: `${run}-g1`,
        direction: 'in',
        status: 'completed',
        amountSats: 150,
        feeSats: 10,
        paidAt: at(180),
        category: 'shop',
        counterpartyAccountId: null,
        paymentHash: null,
        invoice: null,
      });
      const giftHash = hex64();
      await insertPayment({
        accountId: memberA,
        paymentId: `${run}-g2`,
        direction: 'out',
        status: 'completed',
        amountSats: 40,
        feeSats: 1,
        paidAt: at(240),
        category: 'gift',
        counterpartyAccountId: null,
        paymentHash: giftHash,
        invoice: forumPr,
      });
      await insertPayment({
        accountId: memberB,
        paymentId: `${run}-g2`,
        direction: 'in',
        status: 'completed',
        amountSats: 40,
        feeSats: 0,
        paidAt: at(250),
        category: 'member',
        counterpartyAccountId: null,
        paymentHash: giftHash,
        invoice: forumPr,
      });
      await insertPayment({
        accountId: memberA,
        paymentId: `${run}-g3`,
        direction: 'out',
        status: 'completed',
        amountSats: 12321,
        feeSats: 0,
        paidAt: at(300),
        category: 'member',
        counterpartyAccountId: memberB,
        paymentHash: null,
        invoice: null,
      });
      await insertPayment({
        accountId: fund,
        paymentId: `${run}-g4`,
        direction: 'in',
        status: 'completed',
        amountSats: 293955,
        feeSats: 0,
        paidAt: at(360),
        category: 'outside_lightning',
        counterpartyAccountId: null,
        paymentHash: null,
        invoice: null,
      });
      await insertPayment({
        accountId: memberA,
        paymentId: `${run}-g5`,
        direction: 'out',
        status: 'completed',
        amountSats: 69089,
        feeSats: 210,
        paidAt: at(420),
        category: 'outside_lightning',
        counterpartyAccountId: null,
        paymentHash: null,
        invoice: null,
      });
      await insertPayout('paid', bolt11, null);
      await insertPayment({
        accountId: fund,
        paymentId: `${run}-g6`,
        direction: 'out',
        status: 'completed',
        amountSats: 1000,
        feeSats: 0,
        paidAt: at(480),
        category: 'shop',
        counterpartyAccountId: null,
        paymentHash: null,
        invoice: bolt11,
      });
      await insertPayment({
        accountId: shop,
        paymentId: `${run}-g6`,
        direction: 'in',
        status: 'completed',
        amountSats: 1000,
        feeSats: 0,
        paidAt: at(490),
        category: 'shop',
        counterpartyAccountId: null,
        paymentHash: null,
        invoice: null,
      });
      await insertPayout('paid', null, sparkInvoice);
      await insertPayment({
        accountId: fund,
        paymentId: `${run}-g7`,
        direction: 'out',
        status: 'completed',
        amountSats: 500,
        feeSats: 0,
        paidAt: at(540),
        category: 'member',
        counterpartyAccountId: memberB,
        paymentHash: null,
        invoice: sparkInvoice,
      });
      await insertPayout('owed', owedInvoice, null);
      await insertPayment({
        accountId: memberA,
        paymentId: `${run}-g8`,
        direction: 'out',
        status: 'completed',
        amountSats: 7,
        feeSats: 0,
        paidAt: at(600),
        category: 'gift',
        counterpartyAccountId: null,
        paymentHash: null,
        invoice: owedInvoice,
      });
      await insertPayment({
        accountId: platformId,
        paymentId: `${run}-g9`,
        direction: 'out',
        status: 'completed',
        amountSats: 1,
        feeSats: 0,
        paidAt: at(660),
        category: 'platform',
        counterpartyAccountId: memberB,
        paymentHash: null,
        invoice: null,
      });
      await insertPayment({
        accountId: memberA,
        paymentId: `${run}-pending`,
        direction: 'out',
        status: 'pending',
        amountSats: 111,
        feeSats: 0,
        paidAt: at(30),
        category: 'member',
        counterpartyAccountId: null,
        paymentHash: null,
        invoice: null,
      });
      await insertPayment({
        accountId: memberA,
        paymentId: `${run}-before`,
        direction: 'out',
        status: 'completed',
        amountSats: 222,
        feeSats: 0,
        paidAt: at(-1),
        category: 'member',
        counterpartyAccountId: null,
        paymentHash: null,
        invoice: null,
      });
      // One side is just before the bound and the other just after it. The
      // one-day read slack lets the two rows pair, and `bounds` then drops the
      // whole pair because its earliest `paid_at` is before the bound. Without
      // the slack, the in-window side would count as a separate payment.
      const nearBoundaryId = `${run}-near-boundary`;
      await insertPayment({
        accountId: memberA,
        paymentId: nearBoundaryId,
        direction: 'out',
        status: 'completed',
        amountSats: 223,
        feeSats: 0,
        paidAt: at(-12 * 60),
        category: 'member',
        counterpartyAccountId: null,
        paymentHash: null,
        invoice: null,
      });
      await insertPayment({
        accountId: memberB,
        paymentId: nearBoundaryId,
        direction: 'in',
        status: 'completed',
        amountSats: 223,
        feeSats: 0,
        paidAt: at(12 * 60),
        category: 'member',
        counterpartyAccountId: null,
        paymentHash: null,
        invoice: null,
      });
      await insertPayment({
        accountId: memberA,
        paymentId: `${run}-straddle`,
        direction: 'out',
        status: 'completed',
        amountSats: 333,
        feeSats: 0,
        paidAt: at(-1440),
        category: 'unknown',
        counterpartyAccountId: null,
        paymentHash: null,
        invoice: null,
      });
      await insertPayment({
        accountId: memberB,
        paymentId: `${run}-straddle`,
        direction: 'in',
        status: 'completed',
        amountSats: 333,
        feeSats: 0,
        paidAt: at(1440),
        category: 'member',
        counterpartyAccountId: null,
        paymentHash: null,
        invoice: null,
      });
      // A current outgoing row and a future-dated incoming row share a hash.
      // With the exclusive upper bound the future row is not read: the current
      // row counts on its own instead of pairing and taking the future amount,
      // fee, category, or account.
      const futureHash = hex64();
      await insertPayment({
        accountId: memberA,
        paymentId: `${run}-future-shared-current`,
        direction: 'out',
        status: 'completed',
        amountSats: 74,
        feeSats: 3,
        paidAt: at(1000),
        category: 'member',
        counterpartyAccountId: memberB,
        paymentHash: futureHash,
        invoice: null,
      });
      await insertPayment({
        accountId: shop,
        paymentId: `${run}-future-shared-future`,
        direction: 'in',
        status: 'completed',
        amountSats: 75,
        feeSats: 9,
        paidAt: at(2000),
        category: 'shop',
        counterpartyAccountId: memberA,
        paymentHash: futureHash,
        invoice: null,
      });
      await insertPayment({
        accountId: memberA,
        paymentId: `${run}-unknown`,
        direction: 'out',
        status: 'completed',
        amountSats: 9,
        feeSats: 0,
        paidAt: at(720),
        category: 'unknown',
        counterpartyAccountId: null,
        paymentHash: null,
        invoice: null,
      });
      await insertPayment({
        accountId: memberB,
        paymentId: `${run}-unknown`,
        direction: 'in',
        status: 'completed',
        amountSats: 9,
        feeSats: 0,
        paidAt: at(730),
        category: 'unknown',
        counterpartyAccountId: null,
        paymentHash: null,
        invoice: null,
      });
      await insertPayment({
        accountId: memberA,
        paymentId: `${run}-onchain`,
        direction: 'out',
        status: 'completed',
        amountSats: 15,
        feeSats: 0,
        paidAt: at(780),
        category: 'onchain',
        counterpartyAccountId: null,
        paymentHash: null,
        invoice: null,
      });

      // Forum-gift classifier cases: each `gift` payment is a forum gift only
      // when the paid invoice is a living, claimed forum gift or paid heart.
      const conversationHash = hex64();
      const repaymentHash = hex64();
      const hiddenHash = hex64();
      const heartHash = hex64();
      const invoiceOnlyHash = hex64();
      const zapHash = hex64();
      const sparkInvoiceHash = hex64();
      const sparkDestinationHash = hex64();
      const sparkConversationHash = hex64();
      await insertPayment({
        accountId: memberA,
        paymentId: `${run}-conversation`,
        direction: 'out',
        status: 'completed',
        amountSats: 41,
        feeSats: 0,
        paidAt: at(840),
        category: 'gift',
        counterpartyAccountId: memberB,
        paymentHash: conversationHash,
        invoice: null,
      });
      await insertPayment({
        accountId: memberA,
        paymentId: `${run}-repayment`,
        direction: 'out',
        status: 'completed',
        amountSats: 42,
        feeSats: 0,
        paidAt: at(850),
        category: 'gift',
        counterpartyAccountId: memberB,
        paymentHash: repaymentHash,
        invoice: null,
      });
      await insertPayment({
        accountId: memberA,
        paymentId: `${run}-hidden`,
        direction: 'out',
        status: 'completed',
        amountSats: 43,
        feeSats: 0,
        paidAt: at(860),
        category: 'gift',
        counterpartyAccountId: memberB,
        paymentHash: hiddenHash,
        invoice: null,
      });
      await insertPayment({
        accountId: memberA,
        paymentId: `${run}-heart`,
        direction: 'out',
        status: 'completed',
        amountSats: 44,
        feeSats: 0,
        paidAt: at(870),
        category: 'gift',
        counterpartyAccountId: memberB,
        paymentHash: heartHash,
        invoice: null,
      });
      await insertPayment({
        accountId: memberA,
        paymentId: `${run}-invoice-only`,
        direction: 'out',
        status: 'completed',
        amountSats: 45,
        feeSats: 0,
        paidAt: at(880),
        category: 'platform',
        counterpartyAccountId: platformId,
        paymentHash: null,
        invoice: invoiceOnlyPr,
      });
      await insertPayment({
        accountId: memberA,
        paymentId: `${run}-zap`,
        direction: 'out',
        status: 'completed',
        amountSats: 46,
        feeSats: 0,
        paidAt: at(890),
        category: 'gift',
        counterpartyAccountId: memberB,
        paymentHash: zapHash,
        invoice: null,
      });
      await insertSparkInvoice(sparkInvoiceHash, `${run}-spark-forum`);
      await insertPayment({
        accountId: memberA,
        paymentId: `${run}-spark-invoice`,
        direction: 'out',
        status: 'completed',
        amountSats: 47,
        feeSats: 0,
        paidAt: at(895),
        category: 'gift',
        counterpartyAccountId: memberB,
        paymentHash: null,
        invoice: `${run}-spark-forum`,
      });
      await insertSparkInvoice(sparkDestinationHash, `${run}-spark-destination`);
      await insertPayment({
        accountId: memberA,
        paymentId: `${run}-spark-destination`,
        direction: 'out',
        status: 'completed',
        amountSats: 48,
        feeSats: 0,
        paidAt: at(896),
        category: 'gift',
        counterpartyAccountId: memberB,
        paymentHash: null,
        invoice: null,
        destination: `${run}-spark-destination`,
      });
      await insertSparkInvoice(sparkConversationHash, `${run}-spark-conversation`);
      await insertPayment({
        accountId: memberA,
        paymentId: `${run}-spark-conversation`,
        direction: 'out',
        status: 'completed',
        amountSats: 49,
        feeSats: 0,
        paidAt: at(897),
        category: 'gift',
        counterpartyAccountId: memberB,
        paymentHash: null,
        invoice: `${run}-spark-conversation`,
      });
      const platformFeeHash = hex64();
      const platformHeartHash = hex64();
      const platformOrdinaryGiftHash = hex64();
      await insertPayment({
        accountId: memberA,
        paymentId: `${run}-platform-fee`,
        direction: 'out',
        status: 'completed',
        amountSats: 50,
        feeSats: 0,
        paidAt: at(910),
        category: 'platform',
        counterpartyAccountId: platformId,
        paymentHash: platformFeeHash,
        invoice: null,
      });
      await insertPayment({
        accountId: memberA,
        paymentId: `${run}-platform-heart`,
        direction: 'out',
        status: 'completed',
        amountSats: 51,
        feeSats: 0,
        paidAt: at(911),
        category: 'gift',
        counterpartyAccountId: platformId,
        paymentHash: platformHeartHash,
        invoice: null,
      });
      await insertPayment({
        accountId: memberA,
        paymentId: `${run}-platform-ordinary-gift`,
        direction: 'out',
        status: 'completed',
        amountSats: 52,
        feeSats: 0,
        paidAt: at(912),
        category: 'gift',
        counterpartyAccountId: platformId,
        paymentHash: platformOrdinaryGiftHash,
        invoice: null,
      });
      // An incoming-only row names its payer through `counterparty_account_id`.
      // It must still count as members-to-members rather than outside-to-member.
      await insertPayment({
        accountId: memberB,
        paymentId: `${run}-incoming-only`,
        direction: 'in',
        status: 'completed',
        amountSats: 53,
        feeSats: 0,
        paidAt: at(913),
        category: 'member',
        counterpartyAccountId: memberA,
        paymentHash: null,
        invoice: null,
      });

      const forumHeartAt = at(30);
      const forumGiftAt = at(40);
      const forumErrorAt = at(50);
      const forumOldAt = at(-1440);
      const forumConversationAt = at(60);
      const forumRepayAt = at(70);
      const forumRepayPartAt = at(80);
      const forumUnpaidAt = at(90);
      const forumHiddenAt = at(100);
      const forumInvoiceOnlyAt = at(110);
      const forumPlatformFeeAt = at(120);
      const forumPlatformHeartAt = at(130);
      const insertForum = async (row: {
        createdAt: Date;
        amountSats: number;
        result: string;
        heart: boolean;
        paymentHash: string | null;
        pr: string | null;
        description: string | null;
        conversationId: string | null;
        hiddenNote: boolean;
        noteId?: string;
        noteAuthorId?: string;
        paid: boolean;
      }): Promise<void> => {
        const noteAuthorId = row.noteAuthorId ?? memberB;
        const messageId = row.noteId ?? (await insertNote(noteAuthorId, row.hiddenNote));
        await client.execute(
          `INSERT INTO message_invoice (
             id, created_at, message_id, payer_account_id, author_account_id,
             amount_sats, result, http_status, heart, payment_hash, pr, description,
             conversation_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,200,$8,$9,$10,$11,$12)`,
          [
            crypto.randomUUID(),
            row.createdAt,
            messageId,
            memberA,
            noteAuthorId,
            row.amountSats,
            row.result,
            row.heart,
            row.paymentHash,
            row.pr,
            row.description,
            row.conversationId,
          ],
        );
        if (!row.paid) {
          return;
        }
        if (row.paymentHash === null) {
          throw new Error('paid forum invoice has no payment hash');
        }
        const storedHash = row.paymentHash.toLowerCase();
        const receiptEventId = `${run}-receipt-${crypto.randomUUID()}`;
        receiptIds.push(receiptEventId);
        await client.execute(
          `INSERT INTO nostr_zap_payment (payment_hash, receipt_event_id, created_at)
           VALUES ($1::text, $2::text, $3::timestamptz)`,
          [storedHash, receiptEventId, row.createdAt],
        );
        paymentHashes.push(storedHash);
        await client.execute(
          `INSERT INTO nostr_zap_receipt (event_id, message_id, sats, recorded_at)
           VALUES ($1::text, $2::uuid, $3::bigint, $4::timestamptz)`,
          [receiptEventId, messageId, row.amountSats, row.createdAt],
        );
      };
      await insertForum({
        createdAt: forumHeartAt,
        amountSats: 21,
        result: 'ok',
        heart: true,
        paymentHash: heartHash.toUpperCase(),
        pr: null,
        description: null,
        conversationId: null,
        hiddenNote: false,
        paid: true,
      });
      await insertForum({
        createdAt: forumGiftAt,
        amountSats: 5,
        result: 'ok',
        heart: false,
        paymentHash: giftHash,
        pr: forumPr,
        description: null,
        conversationId: null,
        hiddenNote: false,
        paid: true,
      });
      await insertForum({
        createdAt: forumErrorAt,
        amountSats: 77,
        result: 'error',
        heart: true,
        paymentHash: hex64(),
        pr: null,
        description: null,
        conversationId: null,
        hiddenNote: false,
        paid: true,
      });
      await insertForum({
        createdAt: forumOldAt,
        amountSats: 88,
        result: 'ok',
        heart: true,
        paymentHash: hex64(),
        pr: null,
        description: null,
        conversationId: null,
        hiddenNote: false,
        paid: true,
      });
      await insertForum({
        createdAt: forumConversationAt,
        amountSats: 31,
        result: 'ok',
        heart: true,
        paymentHash: conversationHash,
        pr: null,
        description: null,
        conversationId: crypto.randomUUID(),
        hiddenNote: false,
        paid: true,
      });
      await insertForum({
        createdAt: forumRepayAt,
        amountSats: 32,
        result: 'ok',
        heart: false,
        paymentHash: repaymentHash,
        pr: null,
        description: `repay:0:${memberB}`,
        conversationId: null,
        hiddenNote: false,
        paid: true,
      });
      await insertForum({
        createdAt: forumRepayPartAt,
        amountSats: 33,
        result: 'ok',
        heart: false,
        paymentHash: hex64(),
        pr: null,
        description: `repayp:0:${memberB}:0:21:21`,
        conversationId: null,
        hiddenNote: false,
        paid: true,
      });
      await insertForum({
        createdAt: forumUnpaidAt,
        amountSats: 34,
        result: 'ok',
        heart: true,
        paymentHash: hex64(),
        pr: null,
        description: null,
        conversationId: null,
        hiddenNote: false,
        paid: false,
      });
      await insertForum({
        createdAt: forumHiddenAt,
        amountSats: 35,
        result: 'ok',
        heart: false,
        paymentHash: hiddenHash,
        pr: null,
        description: null,
        conversationId: null,
        hiddenNote: true,
        paid: true,
      });
      await insertForum({
        createdAt: forumInvoiceOnlyAt,
        amountSats: 45,
        result: 'ok',
        heart: false,
        paymentHash: invoiceOnlyHash,
        pr: invoiceOnlyPr,
        description: null,
        conversationId: null,
        hiddenNote: false,
        paid: true,
      });
      await insertForum({
        createdAt: at(898),
        amountSats: 47,
        result: 'ok',
        heart: false,
        paymentHash: sparkInvoiceHash,
        pr: null,
        description: null,
        conversationId: null,
        hiddenNote: false,
        paid: true,
      });
      await insertForum({
        createdAt: at(899),
        amountSats: 48,
        result: 'ok',
        heart: false,
        paymentHash: sparkDestinationHash,
        pr: null,
        description: null,
        conversationId: null,
        hiddenNote: false,
        paid: true,
      });
      await insertForum({
        createdAt: at(900),
        amountSats: 49,
        result: 'ok',
        heart: false,
        paymentHash: sparkConversationHash,
        pr: null,
        description: null,
        conversationId: crypto.randomUUID(),
        hiddenNote: false,
        paid: true,
      });
      await insertForum({
        createdAt: forumPlatformFeeAt,
        amountSats: 1,
        result: 'ok',
        heart: false,
        paymentHash: platformFeeHash,
        pr: null,
        description: null,
        conversationId: null,
        hiddenNote: false,
        noteId: platformProfileNoteId,
        noteAuthorId: platformId,
        paid: true,
      });
      await insertForum({
        createdAt: forumPlatformHeartAt,
        amountSats: 2,
        result: 'ok',
        heart: true,
        paymentHash: platformHeartHash,
        pr: null,
        description: null,
        conversationId: null,
        hiddenNote: false,
        noteId: platformProfileNoteId,
        noteAuthorId: platformId,
        paid: true,
      });
      const forumPlatformOrdinaryGiftAt = at(140);
      await insertForum({
        createdAt: forumPlatformOrdinaryGiftAt,
        amountSats: 3,
        result: 'ok',
        heart: false,
        paymentHash: platformOrdinaryGiftHash,
        pr: null,
        description: null,
        conversationId: null,
        hiddenNote: false,
        noteId: platformOrdinaryNoteId,
        noteAuthorId: platformId,
        paid: true,
      });
      // A zap receipt gift: claimed hash, living note, no heart invoice.
      const zapReceiptId = `${run}-zap-receipt`;
      receiptIds.push(zapReceiptId);
      const zapNoteId = await insertNote(memberB, false);
      await client.execute(
        `INSERT INTO nostr_zap_receipt (event_id, message_id, sats, recorded_at)
         VALUES ($1::text, $2::uuid, 46, $3::timestamptz)`,
        [zapReceiptId, zapNoteId, at(890)],
      );
      paymentHashes.push(zapHash);
      await client.execute(
        `INSERT INTO nostr_zap_payment (payment_hash, receipt_event_id, created_at)
         VALUES ($1::text, $2::text, $3::timestamptz)`,
        [zapHash, zapReceiptId, at(890)],
      );

      // Two unrelated same-direction rows on different accounts keep their id
      // but are not a transfer pair, so they must stay two payments.
      const sharedUnpairedId = `${run}-shared-unpaired`;
      await insertPayment({
        accountId: memberA,
        paymentId: sharedUnpairedId,
        direction: 'out',
        status: 'completed',
        amountSats: 61,
        feeSats: 0,
        paidAt: at(900),
        category: 'member',
        counterpartyAccountId: memberB,
        paymentHash: null,
        invoice: null,
      });
      await insertPayment({
        accountId: memberB,
        paymentId: sharedUnpairedId,
        direction: 'out',
        status: 'completed',
        amountSats: 62,
        feeSats: 0,
        paidAt: at(901),
        category: 'member',
        counterpartyAccountId: memberA,
        paymentHash: null,
        invoice: null,
      });
      // A proper opposite-direction pair on two accounts is one payment.
      const sharedPairId = `${run}-shared-pair`;
      await insertPayment({
        accountId: memberA,
        paymentId: sharedPairId,
        direction: 'out',
        status: 'completed',
        amountSats: 63,
        feeSats: 1,
        paidAt: at(902),
        category: 'member',
        counterpartyAccountId: null,
        paymentHash: null,
        invoice: null,
      });
      await insertPayment({
        accountId: memberB,
        paymentId: sharedPairId,
        direction: 'in',
        status: 'completed',
        amountSats: 63,
        feeSats: 0,
        paidAt: at(903),
        category: 'member',
        counterpartyAccountId: null,
        paymentHash: null,
        invoice: null,
      });
      // A paired id that starts with `row:<account uuid>:` must not collide
      // with that account's unpaired row whose bare payment id is the suffix.
      const rowPrefixedUnpairedId = `${run}-row-prefixed`;
      await insertPayment({
        accountId: memberA,
        paymentId: rowPrefixedUnpairedId,
        direction: 'out',
        status: 'completed',
        amountSats: 64,
        feeSats: 0,
        paidAt: at(904),
        category: 'member',
        counterpartyAccountId: memberB,
        paymentHash: null,
        invoice: null,
      });
      const rowPrefixedPairId = `row:${memberA}:${rowPrefixedUnpairedId}`;
      await insertPayment({
        accountId: memberB,
        paymentId: rowPrefixedPairId,
        direction: 'out',
        status: 'completed',
        amountSats: 65,
        feeSats: 2,
        paidAt: at(905),
        category: 'member',
        counterpartyAccountId: memberA,
        paymentHash: null,
        invoice: null,
      });
      await insertPayment({
        accountId: shop,
        paymentId: rowPrefixedPairId,
        direction: 'in',
        status: 'completed',
        amountSats: 65,
        feeSats: 0,
        paidAt: at(906),
        category: 'member',
        counterpartyAccountId: null,
        paymentHash: null,
        invoice: null,
      });
      // Payment hashes pair member-to-member rows even when their payment ids
      // differ. Hash comparison is case-insensitive.
      const sharedHash = hex64();
      await insertPayment({
        accountId: memberA,
        paymentId: `${run}-hash-out`,
        direction: 'out',
        status: 'completed',
        amountSats: 66,
        feeSats: 1,
        paidAt: at(907),
        category: 'member',
        counterpartyAccountId: memberB,
        paymentHash: sharedHash,
        invoice: null,
      });
      await insertPayment({
        accountId: memberB,
        paymentId: `${run}-hash-in`,
        direction: 'in',
        status: 'completed',
        amountSats: 66,
        feeSats: 0,
        paidAt: at(908),
        category: 'member',
        counterpartyAccountId: memberA,
        paymentHash: sharedHash.toUpperCase(),
        invoice: null,
      });
      // Spark invoices pair through the same non-empty invoice text.
      const sharedInvoice = `${run}-shared-invoice`;
      await insertPayment({
        accountId: memberA,
        paymentId: `${run}-invoice-out`,
        direction: 'out',
        status: 'completed',
        amountSats: 67,
        feeSats: 1,
        paidAt: at(909),
        category: 'member',
        counterpartyAccountId: memberB,
        paymentHash: null,
        invoice: sharedInvoice,
      });
      await insertPayment({
        accountId: memberB,
        paymentId: `${run}-invoice-in`,
        direction: 'in',
        status: 'completed',
        amountSats: 67,
        feeSats: 0,
        paidAt: at(910),
        category: 'member',
        counterpartyAccountId: memberA,
        paymentHash: null,
        invoice: sharedInvoice,
      });
      // One outgoing row matched by two incoming rows is ambiguous and keeps
      // all three rows as separate payments.
      const ambiguousHash = hex64();
      await insertPayment({
        accountId: memberA,
        paymentId: `${run}-ambiguous-out`,
        direction: 'out',
        status: 'completed',
        amountSats: 68,
        feeSats: 0,
        paidAt: at(911),
        category: 'member',
        counterpartyAccountId: memberB,
        paymentHash: ambiguousHash,
        invoice: null,
      });
      await insertPayment({
        accountId: memberB,
        paymentId: `${run}-ambiguous-in-1`,
        direction: 'in',
        status: 'completed',
        amountSats: 70,
        feeSats: 0,
        paidAt: at(912),
        category: 'member',
        counterpartyAccountId: memberA,
        paymentHash: ambiguousHash,
        invoice: null,
      });
      await insertPayment({
        accountId: shop,
        paymentId: `${run}-ambiguous-in-2`,
        direction: 'in',
        status: 'completed',
        amountSats: 71,
        feeSats: 0,
        paidAt: at(913),
        category: 'member',
        counterpartyAccountId: memberA,
        paymentHash: ambiguousHash,
        invoice: null,
      });
      // A same-id pair still merges when a third, non-completed row shares the
      // id: only completed rows take part in the one-partner rule. The two
      // completed rows also share a hash, so the id and hash joins find the
      // same pair and `UNION` must still count it once.
      const sharedIdWithFailedRow = `${run}-shared-id-failed`;
      const sharedIdHash = hex64();
      await insertPayment({
        accountId: memberA,
        paymentId: sharedIdWithFailedRow,
        direction: 'out',
        status: 'completed',
        amountSats: 72,
        feeSats: 1,
        paidAt: at(920),
        category: 'member',
        counterpartyAccountId: memberB,
        paymentHash: sharedIdHash,
        invoice: null,
      });
      await insertPayment({
        accountId: memberB,
        paymentId: sharedIdWithFailedRow,
        direction: 'in',
        status: 'completed',
        amountSats: 72,
        feeSats: 0,
        paidAt: at(921),
        category: 'member',
        counterpartyAccountId: memberA,
        paymentHash: sharedIdHash,
        invoice: null,
      });
      await insertPayment({
        accountId: shop,
        paymentId: sharedIdWithFailedRow,
        direction: 'in',
        status: 'failed',
        amountSats: 73,
        feeSats: 0,
        paidAt: at(922),
        category: 'member',
        counterpartyAccountId: memberA,
        paymentHash: null,
        invoice: null,
      });

      const shopPaidAt = at(15);
      const shopPendingAt = at(25);
      const shopOldAt = at(-60);
      await insertShopNote(shop, memberA, false);
      await insertShopNote(memberB, memberB, true);
      const insertCharge = async (
        accountId: string,
        createdAt: Date,
        status: string,
      ): Promise<void> => {
        await client.execute(
          `INSERT INTO pos_charge (id, account_id, amount_sats, status, created_at, expires_at)
           VALUES ($1,$2,21,$3,$4,$5)`,
          [crypto.randomUUID(), accountId, status, createdAt, at(2000)],
        );
      };
      await insertCharge(memberA, shopPaidAt, 'paid');
      await insertCharge(memberB, shopPendingAt, 'pending');
      await insertCharge(fund, shopOldAt, 'paid');

      const store = new PostgresWalletUsageStore(client);
      // The exclusive bound sits after the one-day straddle row and before the
      // future-dated row that shares `futureHash` with the current row.
      const payments = await store.payments(since.getTime(), at(1441).getTime());
      const ours = payments.filter((row) => {
        const payer = row.payerAccountId;
        const payee = row.payeeAccountId;
        return (payer !== null && ids.includes(payer)) || (payee !== null && ids.includes(payee));
      });
      const byAmount = (amount: number): WalletUsagePaymentRow => {
        const found = ours.find((row) => row.amountSats === amount);
        if (found === undefined) {
          throw new Error(`missing payment amount ${amount}`);
        }
        return found;
      };
      expect(
        ours.map((row) => row.amountSats).sort((left, right) => (left < right ? -1 : 1)),
      ).toEqual([
        1, 7, 9, 15, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 61, 62, 63, 64, 65,
        66, 67, 68, 70, 71, 72, 74, 150, 500, 1000, 12321, 69089, 293955,
      ]);
      expect(byAmount(74)).toMatchObject({
        feeSats: 3,
        category: 'member',
        payerAccountId: memberA,
        payeeAccountId: memberB,
        isFundPayout: false,
        isForumGift: false,
      });
      expect(ours.some((row) => row.amountSats === 75)).toBe(false);
      const pair = ours.filter((row) => row.amountSats === 63);
      expect(pair).toHaveLength(1);
      expect(pair[0]?.feeSats).toBe(1);
      expect(byAmount(64)).toMatchObject({
        feeSats: 0,
        payerAccountId: memberA,
        payeeAccountId: memberB,
      });
      expect(byAmount(65)).toMatchObject({
        feeSats: 2,
        payerAccountId: memberB,
        payeeAccountId: shop,
      });
      expect(
        ours
          .filter((row) => row.amountSats === 64 || row.amountSats === 65)
          .map((row) => row.amountSats)
          .sort((left, right) => left - right),
      ).toEqual([64, 65]);
      expect(byAmount(61)).toMatchObject({
        feeSats: 0,
        payerAccountId: memberA,
        payeeAccountId: memberB,
      });
      expect(byAmount(62)).toMatchObject({
        feeSats: 0,
        payerAccountId: memberB,
        payeeAccountId: memberA,
      });

      const grouped = byAmount(150);
      expect(grouped).toMatchObject({
        feeSats: 210,
        category: 'shop',
        payerAccountId: memberA,
        payeeAccountId: shop,
        payerParty: 'members',
        payeeParty: 'members',
        isFundPayout: false,
        isForumGift: false,
      });
      expect(grouped.paidAt.toISOString()).toBe(at(120).toISOString());

      const gift = byAmount(40);
      expect(gift).toMatchObject({
        category: 'gift',
        feeSats: 1,
        payerAccountId: memberA,
        payeeAccountId: memberB,
        isForumGift: true,
      });
      expect(gift.paidAt.toISOString()).toBe(at(240).toISOString());

      const transfer = byAmount(12321);
      expect(transfer).toMatchObject({
        category: 'member',
        payerAccountId: memberA,
        payeeAccountId: memberB,
        payerParty: 'members',
        payeeParty: 'members',
        isFundPayout: false,
        isForumGift: false,
      });

      const outsideFund = byAmount(293955);
      expect(outsideFund).toMatchObject({
        category: 'outside_lightning',
        payerAccountId: null,
        payeeAccountId: fund,
        payerParty: 'outside',
        payeeParty: 'fund',
        isFundPayout: false,
        isForumGift: false,
      });

      const withdrawal = byAmount(69089);
      expect(withdrawal).toMatchObject({
        feeSats: 210,
        category: 'outside_lightning',
        payerAccountId: memberA,
        payeeAccountId: null,
        payerParty: 'members',
        payeeParty: 'outside',
        isFundPayout: false,
        isForumGift: false,
      });

      const boltPayout = byAmount(1000);
      expect(boltPayout).toMatchObject({
        category: 'shop',
        payerAccountId: fund,
        payeeAccountId: shop,
        payerParty: 'fund',
        payeeParty: 'members',
        isFundPayout: true,
        isForumGift: false,
      });
      expect(boltPayout.paidAt.toISOString()).toBe(at(480).toISOString());

      const sparkPayout = byAmount(500);
      expect(sparkPayout).toMatchObject({
        payerAccountId: fund,
        payeeAccountId: memberB,
        payerParty: 'fund',
        payeeParty: 'members',
        isFundPayout: true,
        isForumGift: false,
      });

      expect(byAmount(7).isFundPayout).toBe(false);
      expect(byAmount(7).category).toBe('gift');
      expect(byAmount(7).isForumGift).toBe(false);

      const platformPayment = byAmount(1);
      expect(platformPayment).toMatchObject({
        payerAccountId: platformId,
        payeeAccountId: memberB,
        payerParty: 'platform',
        payeeParty: 'members',
        category: 'platform',
        isFundPayout: false,
        isForumGift: false,
      });

      expect(byAmount(9).category).toBe('unknown');
      expect(byAmount(9).isForumGift).toBe(false);
      expect(byAmount(15).category).toBe('onchain');

      // Only a paid forum gift or paid heart on a living note is `isForumGift`.
      expect(byAmount(41).isForumGift).toBe(false);
      expect(byAmount(42).isForumGift).toBe(false);
      expect(byAmount(43).isForumGift).toBe(false);
      expect(byAmount(44).isForumGift).toBe(true);
      expect(byAmount(45).isForumGift).toBe(true);
      expect(byAmount(45).category).toBe('platform');
      expect(byAmount(46).isForumGift).toBe(true);
      expect(byAmount(46).category).toBe('gift');
      expect(byAmount(47).isForumGift).toBe(true);
      expect(byAmount(48).isForumGift).toBe(true);
      expect(byAmount(49).isForumGift).toBe(false);
      expect(byAmount(50)).toMatchObject({
        category: 'platform',
        payerAccountId: memberA,
        payeeAccountId: platformId,
        payerParty: 'members',
        payeeParty: 'platform',
        isForumGift: false,
      });
      expect(byAmount(51)).toMatchObject({
        category: 'gift',
        payerAccountId: memberA,
        payeeAccountId: platformId,
        payerParty: 'members',
        payeeParty: 'platform',
        isForumGift: true,
      });
      expect(byAmount(52)).toMatchObject({
        category: 'gift',
        payerAccountId: memberA,
        payeeAccountId: platformId,
        payerParty: 'members',
        payeeParty: 'platform',
        isForumGift: true,
      });
      expect(byAmount(53)).toMatchObject({
        category: 'member',
        payerAccountId: memberA,
        payeeAccountId: memberB,
        payerParty: 'members',
        payeeParty: 'members',
        isForumGift: false,
      });
      expect(byAmount(66)).toMatchObject({
        feeSats: 1,
        payerAccountId: memberA,
        payeeAccountId: memberB,
      });
      expect(byAmount(66).paidAt.toISOString()).toBe(at(907).toISOString());
      expect(ours.filter((row) => row.amountSats === 66)).toHaveLength(1);
      expect(byAmount(67)).toMatchObject({
        feeSats: 1,
        payerAccountId: memberA,
        payeeAccountId: memberB,
      });
      expect(ours.filter((row) => row.amountSats === 67)).toHaveLength(1);
      expect(byAmount(68)).toMatchObject({
        payerAccountId: memberA,
        payeeAccountId: memberB,
      });
      expect(ours.filter((row) => row.amountSats === 68)).toHaveLength(1);
      expect(byAmount(70)).toMatchObject({
        payeeAccountId: memberB,
      });
      expect(ours.filter((row) => row.amountSats === 70)).toHaveLength(1);
      expect(byAmount(71)).toMatchObject({
        payeeAccountId: shop,
      });
      expect(ours.filter((row) => row.amountSats === 71)).toHaveLength(1);
      expect(
        ours.filter(
          (row) => row.amountSats === 68 || row.amountSats === 70 || row.amountSats === 71,
        ),
      ).toHaveLength(3);
      expect(byAmount(72)).toMatchObject({
        feeSats: 1,
        payerAccountId: memberA,
        payeeAccountId: memberB,
      });
      expect(byAmount(72).paidAt.toISOString()).toBe(at(920).toISOString());
      expect(ours.filter((row) => row.amountSats === 72)).toHaveLength(1);
      expect(ours.some((row) => row.amountSats === 73)).toBe(false);
      expect(ours.some((row) => row.payerAccountId === memberA && row.amountSats === 223)).toBe(
        false,
      );
      expect(ours.some((row) => row.payeeAccountId === memberB && row.amountSats === 223)).toBe(
        false,
      );

      const forum = await store.forumInvoices(since.getTime());
      const forumAt = (createdAt: Date) =>
        forum.find((row) => row.createdAt.getTime() === createdAt.getTime());
      expect(forumAt(forumHeartAt)).toEqual({
        createdAt: forumHeartAt,
        amountSats: 21,
        heart: true,
      });
      expect(forumAt(forumGiftAt)).toEqual({
        createdAt: forumGiftAt,
        amountSats: 5,
        heart: false,
      });
      expect(forumAt(forumInvoiceOnlyAt)).toEqual({
        createdAt: forumInvoiceOnlyAt,
        amountSats: 45,
        heart: false,
      });
      expect(forumAt(forumErrorAt)).toBeUndefined();
      expect(forumAt(forumOldAt)).toBeUndefined();
      expect(forumAt(forumConversationAt)).toBeUndefined();
      expect(forumAt(forumRepayAt)).toBeUndefined();
      expect(forumAt(forumRepayPartAt)).toBeUndefined();
      expect(forumAt(forumUnpaidAt)).toBeUndefined();
      expect(forumAt(forumHiddenAt)).toBeUndefined();
      expect(forumAt(forumPlatformFeeAt)).toBeUndefined();
      expect(forumAt(forumPlatformHeartAt)).toEqual({
        createdAt: forumPlatformHeartAt,
        amountSats: 2,
        heart: true,
      });
      expect(forumAt(forumPlatformOrdinaryGiftAt)).toEqual({
        createdAt: forumPlatformOrdinaryGiftAt,
        amountSats: 3,
        heart: false,
      });
      expect(forum.every((row) => row.createdAt.getTime() >= since.getTime())).toBe(true);
      expect(forum.map((row) => row.amountSats).sort((left, right) => left - right)).toEqual([
        2, 3, 5, 21, 45, 47, 48,
      ]);

      const charges = await store.shopCharges(since.getTime());
      const chargeAt = (createdAt: Date) =>
        charges.find((row) => row.createdAt.getTime() === createdAt.getTime());
      expect(chargeAt(shopPaidAt)?.status).toBe('paid');
      expect(chargeAt(shopPendingAt)).toBeUndefined();
      expect(chargeAt(shopOldAt)).toBeUndefined();
      expect(charges).toHaveLength(1);
      expect(charges.every((row) => row.createdAt.getTime() >= since.getTime())).toBe(true);
    } finally {
      if (receiptIds.length > 0) {
        await client.execute(`DELETE FROM nostr_zap_receipt WHERE event_id = ANY($1::text[])`, [
          postgresTextArrayLiteral(receiptIds),
        ]);
      }
      if (ids.length > 0) {
        const idList = postgresTextArrayLiteral(ids);
        await client.execute(
          `DELETE FROM wallet_payment
           WHERE account_id = ANY($1::uuid[]) OR counterparty_account_id = ANY($1::uuid[])`,
          [idList],
        );
        await client.execute(`DELETE FROM pos_charge WHERE account_id = ANY($1::uuid[])`, [idList]);
        await client.execute(
          `DELETE FROM message_invoice
           WHERE payer_account_id = ANY($1::uuid[]) OR author_account_id = ANY($1::uuid[])`,
          [idList],
        );
      }
      if (paymentHashes.length > 0) {
        await client.execute(`DELETE FROM nostr_zap_payment WHERE payment_hash = ANY($1::text[])`, [
          postgresTextArrayLiteral(paymentHashes),
        ]);
      }
      if (messageIds.length > 0) {
        await client.execute(`DELETE FROM message WHERE id = ANY($1::uuid[])`, [
          postgresTextArrayLiteral(messageIds),
        ]);
      }
      if (payoutIds.length > 0) {
        await client.execute(`DELETE FROM fond_payout WHERE id = ANY($1::uuid[])`, [
          postgresTextArrayLiteral(payoutIds),
        ]);
      }
      if (sparkInvoices.length > 0) {
        await client.execute(`DELETE FROM spark_invoice WHERE invoice = ANY($1::text[])`, [
          postgresTextArrayLiteral(sparkInvoices),
        ]);
      }
      if (platformId !== undefined) {
        await client.execute(`UPDATE account SET is_platform = false WHERE id = $1`, [platformId]);
      }
      if (previousPlatform !== undefined && previousPlatform !== platformId) {
        await client.execute(`UPDATE account SET is_platform = true WHERE id = $1`, [
          previousPlatform,
        ]);
      }
      if (ids.length > 0) {
        await client.execute(`DELETE FROM account WHERE id = ANY($1::uuid[])`, [
          postgresTextArrayLiteral(ids),
        ]);
      }
      await closeIfPossible(sql);
    }
  });
});
