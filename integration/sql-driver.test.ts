import { SQL } from 'bun';
import { describe, expect, test } from 'bun:test';
import { migrateAuthSchema, PostgresAuthStore } from '@/lib/auth/postgres-store';
import type { SqlClient } from '@/lib/auth/sql';
import type { FundingGrant } from '@/lib/funding';
import { migrateFundingSchema, PostgresFundingStore } from '@/lib/funding-store';
import { migrateDbChangeSchema } from '@/lib/db-change';
import { postgresTextArrayLiteral } from '@/lib/postgres-text-array';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined || databaseUrl === '') {
  throw new Error('DATABASE_URL is required');
}

/**
 * `query` / `execute` body matches `createBunSqlClient` in `src/index.ts`.
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
        lightningAddress: null,
        lightningAddressVerified: false,
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
        lightningAddress: null,
        lightningAddressVerified: false,
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
        name: 'ShouldNotStick',
      });
      const afterRename = await store.getAccount(idA);
      expect(afterRename?.username).toBe(usernameA);
      expect(afterRename?.name).toBeNull();
      expect(afterRename?.sparkPubkey).toBe(pubkey);
      expect(typeof afterRename?.sparkPubkeyVerifiedAt).toBe('number');

      await store.updateAccount({
        ...verified,
        username: usernameA,
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
