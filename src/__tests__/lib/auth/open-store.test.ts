import { describe, it, expect } from 'vitest';
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

  it('migrates and returns Postgres when a URL is set', async () => {
    const executes: string[] = [];
    const store = await openAuthStore('postgres://gifts21@localhost/gifts21', () => ({
      query: async () => [],
      execute: async (text) => {
        executes.push(text);
      },
    }));
    expect(store).toBeInstanceOf(PostgresAuthStore);
    expect(executes.length).toBeGreaterThan(0);
    expect(executes[0]).toMatch(/CREATE TABLE IF NOT EXISTS account/);
  });
});
