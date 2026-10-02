import { SQL } from 'bun';
import { describe, expect, test } from 'bun:test';
import { migrateAuthSchema } from '@/lib/auth/postgres-store';
import type { SqlClient } from '@/lib/auth/sql';
import type { FundingGrant } from '@/lib/funding';
import { migrateFundingSchema, PostgresFundingStore } from '@/lib/funding-store';
import { postgresTextArrayLiteral } from '@/lib/postgres-text-array';

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

describe('Habit-Tracker Postgres persistence', () => {
  test('retains history across store recreation and upserts one outcome per week', async () => {
    const { migrateHabitSchema, PostgresHabitStore } = await import('@/lib/habit-store');
    const { client, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateAuthSchema(client);
      await migrateHabitSchema(client);
      await migrateHabitSchema(client);
      const accountId = crypto.randomUUID();
      const habitId = crypto.randomUUID();
      const commentId = crypto.randomUUID();
      await client.execute(
        `INSERT INTO account (id, role, lightning_address_verified, forum_laws_dismissed, created_at) VALUES ($1, 'founder', false, false, $2)`,
        [accountId, new Date()],
      );
      const store = new PostgresHabitStore(client);
      const habit = {
        id: habitId,
        accountId,
        role: 'founder' as const,
        name: 'Founder',
        text: 'Read daily',
        firstWeek: '2026-09-28',
        lastWeek: null,
      };
      await store.add(habit);
      await store.setResult({ habitId, week: '2026-09-28', status: 'partial' });
      await store.setResult({ habitId, week: '2026-09-28', status: 'achieved' });
      await store.comment({
        id: commentId,
        accountId,
        name: 'Founder',
        text: 'Progress',
        week: '2026-09-28',
        createdAt: 1790899200000,
      });
      await store.retire(habitId, accountId, '2026-10-05');
      await store.retire(habitId, accountId, '2026-10-12');
      const reopened = new PostgresHabitStore(client);
      expect((await reopened.habits()).find((row) => row.id === habitId)).toEqual({
        ...habit,
        lastWeek: '2026-10-05',
      });
      expect(
        (await reopened.results('2026-09-28')).filter((row) => row.habitId === habitId),
      ).toEqual([{ habitId, week: '2026-09-28', status: 'achieved' }]);
      expect(
        (await reopened.results('2026-10-05')).filter((row) => row.habitId === habitId),
      ).toEqual([]);
      expect(
        (await reopened.comments('2026-09-28')).find((row) => row.id === commentId)?.createdAt,
      ).toBe(1790899200000);
      expect(await reopened.firstWeek()).toBe('2026-09-28');
    } finally {
      await closeIfPossible(sql);
    }
  });
});
