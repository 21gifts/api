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

test('donation feed PostgreSQL ordering and cursors match memory, including fiat completion', async () => {
  const { migrateMessageSchema, PostgresMessageStore, InMemoryMessageStore } =
    await import('@/lib/message-store');
  const { unsignedNostrDefaults, messageGoalComplete } = await import('@/lib/message');
  const { randomUUID } = await import('node:crypto');
  const { client, sql } = createBunSqlClient(databaseUrl!);
  const ids: string[] = [];
  try {
    await migrateAuthSchema(client);
    await migrateMessageSchema(client);
    const postgres = new PostgresMessageStore(client);
    const memory = new InMemoryMessageStore();
    const hashtag = 'donations' + Date.now().toString();
    const fixtures = [
      { goalSats: 9000, sats: 9000 },
      { goalSats: 100, sats: 0, goalRepayable: true as const },
      { goalSats: 1000, sats: 0 },
      { goalSats: 1000, sats: 0 },
      {
        goalSats: 2000,
        sats: 2000,
        goalCurrency: 'USD' as const,
        goalAmount: '10.00000001',
        amountUsd: '10.00',
      },
      {
        goalSats: 3000,
        sats: 1,
        goalCurrency: 'EUR' as const,
        goalAmount: '10',
        amountEur: '10.00',
      },
      { sats: 0 },
    ];
    for (const fixture of fixtures) {
      const id = randomUUID();
      ids.push(id);
      const row = {
        id,
        accountId: null,
        name: 'Donation test',
        text: '#' + hashtag,
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        ...fixture,
      };
      await postgres.create(row);
      await memory.create(row);
    }
    const query = {
      mode: 'donations' as const,
      limit: 20,
      cursor: null,
      staffAccountIds: new Set<string>(),
      hashtag,
    };
    const expected = await memory.listFeed(query);
    expect(expected).toHaveLength(6);
    expect((await postgres.listFeed(query)).map((row) => row.id)).toEqual(
      expected.map((row) => row.id),
    );
    for (let index = 0; index < expected.length; index++) {
      const row = expected[index]!;
      const page = await postgres.listFeed({
        ...query,
        limit: 2,
        cursor: {
          k: 'g',
          d: messageGoalComplete(row),
          g: row.goalSats!,
          c: row.createdAt,
          i: row.id,
        },
      });
      expect(page.map((item) => item.id)).toEqual(
        expected.slice(index + 1, index + 3).map((item) => item.id),
      );
    }
  } finally {
    if (ids.length > 0)
      await client.execute('DELETE FROM message WHERE id::text = ANY($1::text[])', [
        postgresTextArrayLiteral(ids),
      ]);
    await closeIfPossible(sql);
  }
});
