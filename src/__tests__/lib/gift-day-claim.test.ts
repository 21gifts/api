import { describe, expect, it, vi } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import {
  AllowAllDayClaimStore,
  GIFT_DAY_CLAIM_SCHEMA_SQL,
  InMemoryDayClaimStore,
  SqlDayClaimStore,
  migrateGiftDayClaimSchema,
} from '@/lib/gift-day-claim';

describe('AllowAllDayClaimStore', () => {
  it('always claims', async () => {
    const store = new AllowAllDayClaimStore();
    await expect(store.tryClaim('alice', '2026-08-27')).resolves.toBe(true);
    await expect(store.tryClaim('alice', '2026-08-27')).resolves.toBe(true);
  });
});

describe('InMemoryDayClaimStore', () => {
  it('allows the first claim and rejects the second', async () => {
    const store = new InMemoryDayClaimStore();
    await expect(store.tryClaim('alice', '2026-08-27')).resolves.toBe(true);
    await expect(store.tryClaim('alice', '2026-08-27')).resolves.toBe(false);
    await expect(store.tryClaim('bob', '2026-08-27')).resolves.toBe(true);
    await expect(store.tryClaim('alice', '2026-08-28')).resolves.toBe(true);
  });

  it('seeds already-paid pairs as claimed', async () => {
    const store = new InMemoryDayClaimStore(['alice\x002026-08-27']);
    await expect(store.tryClaim('alice', '2026-08-27')).resolves.toBe(false);
  });
});

describe('migrateGiftDayClaimSchema', () => {
  it('executes the claim DDL', async () => {
    const execute = vi.fn(async () => undefined);
    const sql: SqlClient = {
      query: async () => {
        throw new Error('unused');
      },
      execute,
    };
    await migrateGiftDayClaimSchema(sql);
    expect(execute).toHaveBeenCalledWith(GIFT_DAY_CLAIM_SCHEMA_SQL);
  });
});

describe('SqlDayClaimStore', () => {
  it('returns false when a gift already exists that UTC day', async () => {
    const sql: SqlClient = {
      query: async <T>(): Promise<T[]> => [{ one: 1 }] as T[],
      execute: async () => undefined,
    };
    await expect(new SqlDayClaimStore(sql).tryClaim('alice', '2026-08-27')).resolves.toBe(false);
  });

  it('inserts a claim when no gift exists', async () => {
    const query = vi.fn(async <T>(text: string): Promise<T[]> => {
      if (text.includes('FROM gift')) {
        return [] as T[];
      }
      return [{ utc_day: '2026-08-27' }] as T[];
    });
    const sql: SqlClient = {
      query: query as SqlClient['query'],
      execute: async () => undefined,
    };
    await expect(new SqlDayClaimStore(sql).tryClaim('alice', '2026-08-27')).resolves.toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('returns false when the claim PK already exists', async () => {
    const query = vi.fn(async <T>(text: string): Promise<T[]> => {
      if (text.includes('FROM gift')) {
        return [] as T[];
      }
      return [] as T[];
    });
    const sql: SqlClient = {
      query: query as SqlClient['query'],
      execute: async () => undefined,
    };
    await expect(new SqlDayClaimStore(sql).tryClaim('alice', '2026-08-27')).resolves.toBe(false);
  });
});
