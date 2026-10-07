import { SQL } from 'bun';
import { describe, expect, test } from 'bun:test';
import { migrateAuthSchema, PostgresAuthStore } from '@/lib/auth/postgres-store';
import { sqlState, type SqlClient } from '@/lib/auth/sql';
import { migrateDailyRosterSchema, PostgresDailyRosterStore } from '@/lib/daily-roster-store';
import type { FundingGrant } from '@/lib/funding';
import { migrateFundingSchema, PostgresFundingStore } from '@/lib/funding-store';
import { migrateMemberHabitSchema, PostgresMemberHabitStore } from '@/lib/member-habit-store';
import { migrateDbChangeSchema } from '@/lib/db-change';
import { migrateFxSpotSchema, PostgresFxSpotStore } from '@/lib/fx-spot-store';
import { unsignedNostrDefaults } from '@/lib/message';
import { migrateMessageSchema, PostgresMessageStore } from '@/lib/message-store';
import { postgresTextArrayLiteral } from '@/lib/postgres-text-array';
import { POS_CHARGE_TTL_MS } from '@/lib/pos-charge';
import { migratePosSchema, PostgresPosStore } from '@/lib/pos-store';
import { migrateSparkInvoiceSchema, PostgresSparkInvoiceStore } from '@/lib/spark-invoice-store';
import { migrateMemberEventSchema, PostgresMemberEventStore } from '@/lib/member-event-store';
import { parseWalletReport } from '@/lib/wallet-report';
import { migrateWalletSchema, PostgresWalletStore } from '@/lib/wallet-store';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined || databaseUrl === '') {
  throw new Error('DATABASE_URL is required');
}

/**
 * `query` / `execute` body matches `createBunDatabase(...).client` in `src/index.ts`.
 * `sql` is that same instance so the test can close it.
 */
function createBunSqlClient(databaseUrl: string): { client: SqlClient; sql: SQL } {
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
  return { client, sql };
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
