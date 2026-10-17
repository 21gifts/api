import { SQL } from 'bun';
import { describe, expect, test } from 'bun:test';
import type { MergeDb, MergeTx } from '@/lib/account-merge';
import { migrateAuthSchema, PostgresAuthStore } from '@/lib/auth/postgres-store';
import { sqlState, type SqlClient } from '@/lib/auth/sql';
import {
  migrateDailyRosterSchema,
  moveDailyRosterToWalletAddresses,
  PostgresDailyRosterStore,
  setUsernameWithRoster,
} from '@/lib/daily-roster-store';
import type { FundingGrant } from '@/lib/funding';
import { migrateFundingSchema, PostgresFundingStore } from '@/lib/funding-store';
import { migrateMemberHabitSchema, PostgresMemberHabitStore } from '@/lib/member-habit-store';
import { migrateDbChangeSchema } from '@/lib/db-change';
import { DEBUG_DB_PAGE_SIZE, PostgresDebugDbStore } from '@/lib/debug-db';
import { migrateFxSpotSchema, PostgresFxSpotStore } from '@/lib/fx-spot-store';
import { unsignedNostrDefaults } from '@/lib/message';
import { migrateMessageSchema, PostgresMessageStore } from '@/lib/message-store';
import { postgresTextArrayLiteral } from '@/lib/postgres-text-array';
import { POS_CHARGE_TTL_MS } from '@/lib/pos-charge';
import { migratePosSchema, PostgresPosStore } from '@/lib/pos-store';
import {
  migrateShopPaymentSchema,
  PostgresShopPaymentStore,
  type ShopOffer,
  type ShopPayment,
  type ShopProof,
  type ShopProofLookup,
} from '@/lib/shop-payment-store';
import { migrateSparkInvoiceSchema, PostgresSparkInvoiceStore } from '@/lib/spark-invoice-store';
import { migrateMemberEventSchema, PostgresMemberEventStore } from '@/lib/member-event-store';
import { parseWalletReport } from '@/lib/wallet-report';
import { migrateWalletSchema, PostgresWalletStore } from '@/lib/wallet-store';
import { migrateBtcUsdSchema } from '@/lib/btc-usd-store';
import { migrateFiatSchema } from '@/lib/usd-fiat-store';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined || databaseUrl === '') {
  throw new Error('DATABASE_URL is required');
}

/**
 * `query` / `execute` body matches `createBunDatabase(...).client` in `src/index.ts`.
 * `mergeDb.begin` matches `createBunDatabase(...).mergeDb`.
 * `sql` is that same instance so the test can close it.
 */
function createBunSqlClient(databaseUrl: string): {
  client: SqlClient;
  mergeDb: MergeDb;
  sql: SQL;
} {
  const sql = new SQL(databaseUrl);
  const client: SqlClient = {
    async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      const rows = (await sql.unsafe(text, [...params])) as T[];
      return rows;
    },
    async execute(text: string, params: readonly unknown[] = []): Promise<void> {
      await sql.unsafe(text, [...params]);
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
  test('driver rejects a JavaScript array', async () => {
    const sql = new SQL(databaseUrl);
    try {
      let thrown: unknown;
      try {
        await sql.unsafe('SELECT $1::text[] AS tags', [['rejected']]);
      } catch (error) {
        thrown = error;
      }
      if (thrown === undefined) {
        throw new Error('expected sql.unsafe to reject a JavaScript array');
      }
      const message = String(thrown);
      if (!message.includes('malformed array literal')) {
        throw thrown;
      }
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

describe('PostgresDailyRosterStore importDocument', () => {
  test('writes once on real Postgres and no-ops a second import', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateDailyRosterSchema(client);
      await client.execute('DELETE FROM daily_roster_entry');
      await client.execute('DELETE FROM daily_roster');
      const store = new PostgresDailyRosterStore(client);
      const first = await store.importDocument({
        comment: 'kept',
        paymentsEnabled: false,
        moderatorPaymentsEnabled: true,
        recipients: [{ address: 'roster-import@example.com', amountUsd: 2.5 }],
        moderators: [{ address: 'roster-mod@example.com', amountUsd: 3 }],
      });
      expect(first.comment).toBe('kept');
      expect(first.paymentsEnabled).toBe(false);
      expect(first.moderatorPaymentsEnabled).toBe(true);
      expect(first.defaultAmountUsd).toBe(1);
      expect(first.recipients).toEqual([{ address: 'roster-import@example.com', amountUsd: 2.5 }]);
      expect(first.moderators).toEqual([{ address: 'roster-mod@example.com', amountUsd: 3 }]);
      const second = await store.importDocument({ comment: 'other' });
      expect(second).toEqual(first);
      expect(second.comment).toBe('kept');
    } finally {
      await client.execute('DELETE FROM daily_roster_entry');
      await client.execute('DELETE FROM daily_roster');
      await closeIfPossible(sql);
    }
  });
});

describe('moveDailyRosterToWalletAddresses', () => {
  test('moves the roster to wallet addresses in one logged transaction on real Postgres', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    const stamp = `${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
    const named = crypto.randomUUID();
    const unnamed = crypto.randomUUID();
    const username = `roster_${stamp}`;
    const legacy = `legacy_${stamp}@walletofsatoshi.com`;
    const unnamedLegacy = `unnamed_${stamp}@walletofsatoshi.com`;
    const viewKey = (): string =>
      `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
    try {
      await migrateAuthSchema(client);
      await migrateDailyRosterSchema(client);
      await migrateDbChangeSchema(client);
      await client.execute('DELETE FROM daily_roster_entry');
      await client.execute(
        `INSERT INTO account (id, role, name, username, lightning_address, lightning_address_verified,
           forum_laws_dismissed, created_at, view_key)
         VALUES ($1, 'verified', 'Roster', $2, $3, true, false, now(), $4),
                ($5, 'verified', 'Unnamed', NULL, $6, true, false, now(), $7)`,
        [named, username, legacy, viewKey(), unnamed, unnamedLegacy, viewKey()],
      );
      const inserted = await client.query<{ id: number; address: string; bucket: string }>(
        `INSERT INTO daily_roster_entry (address, amount_usd, bucket)
         SELECT address, amount_usd, bucket
           FROM unnest($1::text[], $2::double precision[], $3::text[])
                WITH ORDINALITY AS t(address, amount_usd, bucket, n)
          ORDER BY n
         RETURNING id, address, bucket`,
        [
          postgresTextArrayLiteral([
            ` ${legacy.toUpperCase()} `,
            legacy,
            legacy,
            `${username}@GIFTS.example`,
            `nobody_${stamp}@walletofsatoshi.com`,
            unnamedLegacy,
            ` Carol_${stamp}@Gifts.Example `,
            `Dave_${stamp}@gifts.example`,
            `dave_${stamp}@gifts.example`,
            `x_${stamp}@evil@gifts.example`,
          ]),
          '{3,9,5,7,2,2,2,6,4,1}',
          postgresTextArrayLiteral([
            'daily',
            'daily',
            'moderator',
            'moderator',
            'daily',
            'daily',
            'daily',
            'moderator',
            'moderator',
            'daily',
          ]),
        ],
      );
      const ids = inserted.map((row) => Number(row.id));
      const idsAt = (...positions: number[]): number[] =>
        positions.map((position) => Number(ids[position])).sort((x, y) => x - y);
      const markerRows = await client.query<{ marker: string }>(
        'SELECT coalesce(max(id), 0)::text AS marker FROM db_change',
      );
      const marker = markerRows[0]?.marker ?? '0';

      expect(await moveDailyRosterToWalletAddresses(client, 'Gifts.Example')).toEqual({
        moved: 3,
        removed: 6,
      });
      const rows = await client.query<{ address: string; amount_usd: number; bucket: string }>(
        'SELECT address, amount_usd, bucket FROM daily_roster_entry ORDER BY bucket, address',
      );
      expect(rows).toEqual([
        { address: `carol_${stamp}@gifts.example`, amount_usd: 2, bucket: 'daily' },
        { address: `${username}@gifts.example`, amount_usd: 3, bucket: 'daily' },
        { address: `dave_${stamp}@gifts.example`, amount_usd: 4, bucket: 'moderator' },
        { address: `${username}@gifts.example`, amount_usd: 7, bucket: 'moderator' },
      ]);

      const changes = await client.query<{ op: string; row_id: number; txid: string }>(
        `SELECT op, coalesce(before ->> 'id', after ->> 'id')::int AS row_id, txid::text AS txid
           FROM db_change
          WHERE id > $1::bigint AND table_name = 'daily_roster_entry'
          ORDER BY id`,
        [marker],
      );
      const rowIds = (op: string): number[] =>
        changes
          .filter((c) => c.op === op)
          .map((c) => Number(c.row_id))
          .sort((x, y) => x - y);
      expect(rowIds('UPDATE')).toEqual(idsAt(0, 3, 6));
      expect(rowIds('DELETE')).toEqual(idsAt(1, 2, 4, 5, 7, 9));
      expect(new Set(changes.map((c) => c.txid)).size).toBe(1);

      expect(await moveDailyRosterToWalletAddresses(client, 'gifts.example')).toEqual({
        moved: 0,
        removed: 0,
      });
    } finally {
      await client.execute('DELETE FROM daily_roster_entry');
      await client.execute('DELETE FROM account WHERE id = ANY($1::uuid[])', [
        postgresTextArrayLiteral([named, unnamed]),
      ]);
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresDailyRosterStore.renameAddress', () => {
  test('moves both buckets, deletes a conflict, no-ops, and logs one txid', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    const stamp = `${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
    const oldAddress = `old_${stamp}@gifts.example`;
    const newAddress = `new_${stamp}@gifts.example`;
    const conflictAddress = `keep_${stamp}@gifts.example`;
    const store = new PostgresDailyRosterStore(client);
    try {
      await migrateDailyRosterSchema(client);
      await migrateDbChangeSchema(client);
      await client.execute('DELETE FROM daily_roster_entry');
      await client.execute('DELETE FROM daily_roster');

      await store.addRecipient(oldAddress, 2);
      await store.addModerator(oldAddress, 3);
      const moveMarkerRows = await client.query<{ marker: string }>(
        'SELECT coalesce(max(id), 0)::text AS marker FROM db_change',
      );
      const moveMarker = moveMarkerRows[0]?.marker ?? '0';

      expect(await store.renameAddress(oldAddress.toUpperCase(), ` ${newAddress} `)).toEqual({
        moved: 2,
        removed: 0,
      });
      expect(await store.get()).toMatchObject({
        recipients: [{ address: newAddress, amountUsd: 2 }],
        moderators: [{ address: newAddress, amountUsd: 3 }],
      });
      const moveChanges = await client.query<{ op: string; txid: string }>(
        `SELECT op, txid::text AS txid
           FROM db_change
          WHERE id > $1::bigint AND table_name = 'daily_roster_entry'
          ORDER BY id`,
        [moveMarker],
      );
      expect(moveChanges.map((row) => row.op)).toEqual(['UPDATE', 'UPDATE']);
      expect(new Set(moveChanges.map((row) => row.txid)).size).toBe(1);

      await store.addRecipient(conflictAddress, 9);
      const conflictMarkerRows = await client.query<{ marker: string }>(
        'SELECT coalesce(max(id), 0)::text AS marker FROM db_change',
      );
      const conflictMarker = conflictMarkerRows[0]?.marker ?? '0';

      expect(await store.renameAddress(newAddress, conflictAddress)).toEqual({
        moved: 1,
        removed: 1,
      });
      expect(await store.get()).toMatchObject({
        recipients: [{ address: conflictAddress, amountUsd: 9 }],
        moderators: [{ address: conflictAddress, amountUsd: 3 }],
      });
      const conflictChanges = await client.query<{ op: string; txid: string }>(
        `SELECT op, txid::text AS txid
           FROM db_change
          WHERE id > $1::bigint AND table_name = 'daily_roster_entry'
          ORDER BY id`,
        [conflictMarker],
      );
      expect(conflictChanges.map((row) => row.op).sort()).toEqual(['DELETE', 'UPDATE']);
      expect(new Set(conflictChanges.map((row) => row.txid)).size).toBe(1);

      const afterConflict = await store.get();
      expect(await store.renameAddress(`missing_${stamp}@gifts.example`, oldAddress)).toEqual({
        moved: 0,
        removed: 0,
      });
      expect(await store.renameAddress(conflictAddress, conflictAddress.toUpperCase())).toEqual({
        moved: 0,
        removed: 0,
      });
      expect(await store.get()).toEqual(afterConflict);
    } finally {
      await client.execute('DELETE FROM daily_roster_entry');
      await client.execute('DELETE FROM daily_roster');
      await closeIfPossible(sql);
    }
  });
});

describe('setUsernameWithRoster', () => {
  const host = 'gifts.example';
  const hex64 = (): string =>
    `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
  const viewKey = (): string => hex64();

  test('moves both buckets, deletes a conflict, and logs one txid', async () => {
    const { client, mergeDb, sql } = createBunSqlClient(databaseUrl);
    const stamp = `${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
    const id = crypto.randomUUID();
    const previous = `old_${stamp}`;
    const next = `new_${stamp}`;
    const oldAddress = `${previous}@${host}`;
    const newAddress = `${next}@${host}`;
    const store = new PostgresAuthStore(client);
    const roster = new PostgresDailyRosterStore(client);
    try {
      await migrateAuthSchema(client);
      await migrateDailyRosterSchema(client);
      await migrateDbChangeSchema(client);
      await client.execute('DELETE FROM daily_roster_entry');
      await store.createAccount({
        id,
        linkingKey: null,
        role: 'basis',
        name: 'Roster',
        username: previous,
        location: null,
        forumLawsDismissed: false,
        viewKey: viewKey(),
        createdAt: Date.now(),
        rulesAgreedAt: null,
      });
      await roster.addRecipient(oldAddress, 2);
      await roster.addModerator(oldAddress, 3);
      await roster.addRecipient(newAddress, 9);
      const markerRows = await client.query<{ marker: string }>(
        'SELECT coalesce(max(id), 0)::text AS marker FROM db_change',
      );
      const marker = markerRows[0]?.marker ?? '0';

      expect(await setUsernameWithRoster(mergeDb, id, next, 'Gifts.Example')).toEqual({
        ok: true,
        previous,
        moved: 1,
        removed: 1,
      });
      expect((await store.getAccount(id))?.username).toBe(next);
      expect(await roster.get()).toMatchObject({
        recipients: [{ address: newAddress, amountUsd: 9 }],
        moderators: [{ address: newAddress, amountUsd: 3 }],
      });
      const changes = await client.query<{ table_name: string; op: string; txid: string }>(
        `SELECT table_name, op, txid::text AS txid
           FROM db_change
          WHERE id > $1::bigint AND table_name IN ('account', 'daily_roster_entry')
          ORDER BY id`,
        [marker],
      );
      expect(changes.some((row) => row.table_name === 'account' && row.op === 'UPDATE')).toBe(true);
      expect(
        changes.some((row) => row.table_name === 'daily_roster_entry' && row.op === 'UPDATE'),
      ).toBe(true);
      expect(new Set(changes.map((row) => row.txid)).size).toBe(1);
    } finally {
      await client.execute('DELETE FROM daily_roster_entry');
      await client.execute('DELETE FROM daily_roster');
      await client.execute('DELETE FROM account WHERE id = $1', [id]);
      await closeIfPossible(sql);
    }
  });

  test('skips the roster move when the previous username is null', async () => {
    const { client, mergeDb, sql } = createBunSqlClient(databaseUrl);
    const stamp = `${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
    const id = crypto.randomUUID();
    const next = `new_${stamp}`;
    const other = `keep_${stamp}@${host}`;
    const store = new PostgresAuthStore(client);
    const roster = new PostgresDailyRosterStore(client);
    try {
      await migrateAuthSchema(client);
      await migrateDailyRosterSchema(client);
      await store.createAccount({
        id,
        linkingKey: null,
        role: 'basis',
        name: 'Blank',
        username: null,
        location: null,
        forumLawsDismissed: false,
        viewKey: viewKey(),
        createdAt: Date.now(),
        rulesAgreedAt: null,
      });
      await roster.addRecipient(other, 2);
      expect(await setUsernameWithRoster(mergeDb, id, next, host)).toEqual({
        ok: true,
        previous: null,
        moved: 0,
        removed: 0,
      });
      expect((await store.getAccount(id))?.username).toBe(next);
      expect(await roster.get()).toMatchObject({
        recipients: [{ address: other, amountUsd: 2 }],
      });
    } finally {
      await client.execute('DELETE FROM daily_roster_entry');
      await client.execute('DELETE FROM daily_roster');
      await client.execute('DELETE FROM account WHERE id = $1', [id]);
      await closeIfPossible(sql);
    }
  });

  test('returns frozen when the wallet is verified', async () => {
    const { client, mergeDb, sql } = createBunSqlClient(databaseUrl);
    const stamp = `${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
    const id = crypto.randomUUID();
    const username = `frz_${stamp}`;
    const store = new PostgresAuthStore(client);
    try {
      await migrateAuthSchema(client);
      await store.createAccount({
        id,
        linkingKey: null,
        role: 'basis',
        name: 'Frozen',
        username,
        location: null,
        forumLawsDismissed: false,
        viewKey: viewKey(),
        createdAt: Date.now(),
        rulesAgreedAt: null,
        walletRequired: true,
      });
      const pubkey = `02${hex64()}`;
      expect((await store.claimSparkPubkey(id, pubkey))?.wrote).toBe(true);
      expect(await store.markSparkPubkeyVerified(id, pubkey, username, Date.now())).toBe(true);
      expect(await setUsernameWithRoster(mergeDb, id, `next_${stamp}`, host)).toEqual({
        ok: false,
        reason: 'frozen',
      });
      expect((await store.getAccount(id))?.username).toBe(username);
    } finally {
      await client.execute('DELETE FROM account WHERE id = $1', [id]);
      await closeIfPossible(sql);
    }
  });

  test('returns taken when another account holds the username', async () => {
    const { client, mergeDb, sql } = createBunSqlClient(databaseUrl);
    const stamp = `${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
    const id = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    const mine = `mine_${stamp}`;
    const taken = `take_${stamp}`;
    const store = new PostgresAuthStore(client);
    try {
      await migrateAuthSchema(client);
      await store.createAccount({
        id,
        linkingKey: null,
        role: 'basis',
        name: 'Mine',
        username: mine,
        location: null,
        forumLawsDismissed: false,
        viewKey: viewKey(),
        createdAt: Date.now(),
        rulesAgreedAt: null,
      });
      await store.createAccount({
        id: otherId,
        linkingKey: null,
        role: 'basis',
        name: 'Other',
        username: taken,
        location: null,
        forumLawsDismissed: false,
        viewKey: viewKey(),
        createdAt: Date.now() + 1,
        rulesAgreedAt: null,
      });
      expect(await setUsernameWithRoster(mergeDb, id, taken, host)).toEqual({
        ok: false,
        reason: 'taken',
      });
      expect((await store.getAccount(id))?.username).toBe(mine);
    } finally {
      await client.execute('DELETE FROM account WHERE id = ANY($1::uuid[])', [
        postgresTextArrayLiteral([id, otherId]),
      ]);
      await closeIfPossible(sql);
    }
  });

  test('returns missing when the account id is unknown', async () => {
    const { client, mergeDb, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateAuthSchema(client);
      expect(await setUsernameWithRoster(mergeDb, crypto.randomUUID(), 'nobody', host)).toEqual({
        ok: false,
        reason: 'missing',
      });
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('two concurrent renames of one account chain the roster onto the final username', async () => {
    const { client, mergeDb, sql } = createBunSqlClient(databaseUrl);
    const stamp = `${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
    const id = crypto.randomUUID();
    const orig = `u${stamp}`;
    const userA = `a${stamp}`;
    const userB = `b${stamp}`;
    const store = new PostgresAuthStore(client);
    const roster = new PostgresDailyRosterStore(client);
    try {
      await migrateAuthSchema(client);
      await migrateDailyRosterSchema(client);
      await store.createAccount({
        id,
        linkingKey: null,
        role: 'basis',
        name: 'Race',
        username: orig,
        location: null,
        forumLawsDismissed: false,
        viewKey: viewKey(),
        createdAt: Date.now(),
        rulesAgreedAt: null,
      });
      await roster.addRecipient(`${orig}@${host}`, 2);
      await roster.addModerator(`${orig}@${host}`, 3);
      const [first, second] = await Promise.all([
        setUsernameWithRoster(mergeDb, id, userA, host),
        setUsernameWithRoster(mergeDb, id, userB, host),
      ]);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      const final = (await store.getAccount(id))?.username;
      expect(final === userA || final === userB).toBe(true);
      const previous = [first, second].map((result) =>
        result.ok ? (result.previous ?? '').trim().toLowerCase() : '',
      );
      const other = final === userA ? userB : userA;
      expect(new Set(previous)).toEqual(new Set([orig, other]));
      expect(await roster.get()).toMatchObject({
        recipients: [{ address: `${final}@${host}`, amountUsd: 2 }],
        moderators: [{ address: `${final}@${host}`, amountUsd: 3 }],
      });
    } finally {
      await client.execute('DELETE FROM daily_roster_entry');
      await client.execute('DELETE FROM daily_roster');
      await client.execute('DELETE FROM account WHERE id = $1', [id]);
      await closeIfPossible(sql);
    }
  });

  test('two accounts racing for one username: one wins, the other gets taken', async () => {
    const { client, mergeDb, sql } = createBunSqlClient(databaseUrl);
    const stamp = `${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const wanted = `w${stamp}`;
    const store = new PostgresAuthStore(client);
    try {
      await migrateAuthSchema(client);
      await migrateDailyRosterSchema(client);
      for (const [index, id] of ids.entries()) {
        await store.createAccount({
          id,
          linkingKey: null,
          role: 'basis',
          name: 'Race',
          username: `r${index}${stamp}`,
          location: null,
          forumLawsDismissed: false,
          viewKey: viewKey(),
          createdAt: Date.now(),
          rulesAgreedAt: null,
        });
      }
      const results = await Promise.all(
        ids.map((id) => setUsernameWithRoster(mergeDb, id, wanted, host)),
      );
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: 'taken' }]);
      const holders = (await Promise.all(ids.map((id) => store.getAccount(id)))).filter(
        (account) => account?.username === wanted,
      );
      expect(holders).toHaveLength(1);
    } finally {
      for (const id of ids) {
        await client.execute('DELETE FROM account WHERE id = $1', [id]);
      }
      await closeIfPossible(sql);
    }
  });

  test('a write from a snapshot taken before the rename keeps the new username', async () => {
    const { client, mergeDb, sql } = createBunSqlClient(databaseUrl);
    const stamp = `${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
    const id = crypto.randomUUID();
    const orig = `s${stamp}`;
    const renamed = `t${stamp}`;
    const store = new PostgresAuthStore(client);
    const roster = new PostgresDailyRosterStore(client);
    try {
      await migrateAuthSchema(client);
      await migrateDailyRosterSchema(client);
      await store.createAccount({
        id,
        linkingKey: null,
        role: 'basis',
        name: 'Stale',
        username: orig,
        location: null,
        forumLawsDismissed: false,
        viewKey: viewKey(),
        createdAt: Date.now(),
        rulesAgreedAt: null,
      });
      await roster.addRecipient(`${orig}@${host}`, 2);
      const stale = await store.getAccount(id);
      if (stale === undefined) {
        throw new Error('expected account');
      }
      expect(await setUsernameWithRoster(mergeDb, id, renamed, host)).toMatchObject({ ok: true });
      await store.updateAccount({ ...stale, location: 'Zurich' });
      const after = await store.getAccount(id);
      expect(after?.username).toBe(renamed);
      expect(after?.location).toBe('Zurich');
      expect(await roster.get()).toMatchObject({
        recipients: [{ address: `${renamed}@${host}`, amountUsd: 2 }],
      });
    } finally {
      await client.execute('DELETE FROM daily_roster_entry');
      await client.execute('DELETE FROM daily_roster');
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

describe('PostgresPosStore paid tracking', () => {
  test('migrate an old status check, record invoices, watch, pay once, and db_change', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
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

      const store = new PostgresPosStore(client);
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
      });

      const hashA = hex64();
      const hashB = hex64();
      expect(await store.recordInvoice(chargeId, hashA, now + 1)).toBe(true);
      expect(await store.recordInvoice(chargeId, hashA, now + 2)).toBe(false);
      expect(await store.recordInvoice(chargeId, hashB, now + POS_CHARGE_TTL_MS)).toBe(false);
      expect(await store.recordInvoice(crypto.randomUUID(), hashB, now)).toBe(false);
      expect(await store.recordInvoice(chargeId, hashB, now + 3)).toBe(true);
      // Marked expired by a later read; an invoice issued before expiry still records.
      await store.currentPending(accountId, now + POS_CHARGE_TTL_MS);
      const hashC = hex64();
      expect(await store.recordInvoice(chargeId, hashC, now + 4)).toBe(true);

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
      expect(await store.recordInvoice(chargeId, hex64(), now + 5)).toBe(false);
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

describe('PostgresWalletStore', () => {
  test('migrate twice, balance, guarded upsert, order, db_change, and secrets', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateAuthSchema(client);
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
      const latest = await store.latestBalance(accountId);
      expect(latest?.id).toBe(snapshotId);
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

describe('PostgresShopPaymentStore', () => {
  const hex64 = (): string =>
    `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
  const hex40 = (): string => `0x${hex64().slice(0, 40)}`;

  const setup = async (): Promise<{
    client: SqlClient;
    sql: SQL;
    store: PostgresShopPaymentStore;
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
    return { client, sql, store: new PostgresShopPaymentStore(client, mergeDb), newAccount };
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
    const { client, sql, store, newAccount } = await setup();
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

      await store.transaction(async (tx) => {
        await tx.lockAccount(accountId);
        expect(await tx.lockCharge(chargeId)).toBeNull();
        expect(await tx.insertCharge(charge)).toBe(true);
        // A second pending charge hits the unique index; the transaction goes on.
        expect(await tx.insertCharge({ ...charge, id: crypto.randomUUID() })).toBe(false);
        expect((await tx.pendingCharge(accountId, now))?.id).toBe(chargeId);
        expect((await tx.lockCharge(chargeId))?.status).toBe('pending');
        expect(await tx.recordChargeInvoice(chargeId, payment.paymentHash, now)).toBe(true);
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
        expect(await tx.countOpenLookups(quoteId)).toBe(1);
        expect(await tx.findLookup(1, lookup.hash, quoteId)).toEqual(lookup);
        expect((await tx.dueLookups(now, 100_000)).some((row) => row.id === lookup.id)).toBe(true);
        expect(await tx.updateLookup(lookup.id, { tries: 1, doneAt: new Date(now) })).toEqual({
          ...lookup,
          tries: 1,
          doneAt: new Date(now),
        });
        expect(await tx.countOpenLookups(quoteId)).toBe(0);

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
});
