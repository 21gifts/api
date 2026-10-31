import { describe, it, expect } from 'vitest';
import type { MergeDb } from '@/lib/account-merge';
import { openAuthStore } from '@/lib/auth/open-store';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { PostgresAuthStore } from '@/lib/auth/postgres-store';
import type { SqlClient } from '@/lib/auth/sql';

function unusedClient(): SqlClient {
  return {
    query: async () => {
      throw new Error('unused');
    },
    execute: async () => {
      throw new Error('unused');
    },
  };
}

describe('openAuthStore', () => {
  it('returns in-memory storage when the URL is unset', async () => {
    const store = await openAuthStore(undefined, () => unusedClient());
    expect(store).toBeInstanceOf(InMemoryAuthStore);
  });

  it('returns in-memory storage when the URL is blank', async () => {
    const store = await openAuthStore('   ', () => unusedClient());
    expect(store).toBeInstanceOf(InMemoryAuthStore);
  });

  it('throws when a URL is set without a client factory', async () => {
    await expect(openAuthStore('postgres://gifts21@localhost/gifts21')).rejects.toThrow(
      /SQL client factory/,
    );
  });

  it('migrates, backfills Spark addresses, and returns Postgres when a URL is set', async () => {
    const executes: string[] = [];
    const queries: string[] = [];
    const store = await openAuthStore('postgres://gifts21@localhost/gifts21', () => ({
      query: async (text) => {
        queries.push(text);
        return [];
      },
      execute: async (text) => {
        executes.push(text);
      },
    }));
    expect(store).toBeInstanceOf(PostgresAuthStore);
    expect(executes.length).toBeGreaterThan(0);
    expect(executes[0]).toMatch(/CREATE TABLE IF NOT EXISTS account/);
    expect(queries[0]).toBe(
      'SELECT id, spark_pubkey, spark_address FROM account WHERE spark_pubkey IS NOT NULL',
    );
  });

  it('hands the transaction port to the Postgres store for the recovery steps', async () => {
    const client: SqlClient = { query: async () => [], execute: async () => undefined };
    const locked: string[] = [];
    const transactions: MergeDb = {
      begin: (run) =>
        run({
          query: async <T>(text: string): Promise<T[]> => {
            locked.push(text);
            return [] as T[];
          },
        }),
    };
    const withPort = await openAuthStore(
      'postgres://gifts21@localhost/gifts21',
      () => client,
      transactions,
    );
    expect(
      await withPort.commitRecovery({
        accountId: 'acc',
        newSparkPubkey: `03${'2'.repeat(64)}`,
        now: 1,
      }),
    ).toBe('gone');
    expect(locked[0]).toMatch(/FROM account WHERE id = \$1 FOR UPDATE/);
    const withoutPort = await openAuthStore('postgres://gifts21@localhost/gifts21', () => client);
    await expect(
      withoutPort.commitRecovery({
        accountId: 'acc',
        newSparkPubkey: `03${'2'.repeat(64)}`,
        now: 1,
      }),
    ).rejects.toThrow('auth transactions are not configured');
  });
});
