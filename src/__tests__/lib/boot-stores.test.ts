import { describe, expect, it, vi } from 'vitest';
import { openBootStores } from '@/lib/boot-stores';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { PostgresAuthStore } from '@/lib/auth/postgres-store';
import type { SqlClient } from '@/lib/auth/sql';
import { QueryGiftStore } from '@/lib/gift-store';

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

describe('openBootStores', () => {
  it('returns in-memory auth and no gift store when the URL is unset', async () => {
    const factory = vi.fn(() => unusedClient());
    const { authStore, giftStore } = await openBootStores(undefined, factory);
    expect(authStore).toBeInstanceOf(InMemoryAuthStore);
    expect(giftStore).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it('returns in-memory auth and no gift store when the URL is blank', async () => {
    const factory = vi.fn(() => unusedClient());
    const { authStore, giftStore } = await openBootStores('   ', factory);
    expect(authStore).toBeInstanceOf(InMemoryAuthStore);
    expect(giftStore).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it('throws when a URL is set without a client factory', async () => {
    await expect(openBootStores('postgres://gifts21@localhost/gifts21')).rejects.toThrow(
      /SQL client factory/,
    );
  });

  it('opens durable auth and QueryGiftStore on one captured client', async () => {
    const url = ' postgres://gifts21@localhost/gifts21 ';
    const queries: string[] = [];
    let executeCount = 0;
    const client: SqlClient = {
      query: async <T>(text: string, _params?: readonly unknown[]): Promise<T[]> => {
        queries.push(text);
        return [
          {
            paid_at: '2026-06-01T12:00:00.000Z',
            amount_sats: 42n,
            recipient_wos_user: 'alice',
          },
        ] as T[];
      },
      execute: async () => {
        executeCount += 1;
      },
    };
    const factory = vi.fn(() => client);

    const { authStore, giftStore } = await openBootStores(url, factory);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(url.trim());
    expect(authStore).toBeInstanceOf(PostgresAuthStore);
    expect(giftStore).toBeInstanceOf(QueryGiftStore);
    expect(executeCount).toBeGreaterThan(0);

    if (giftStore === undefined) {
      throw new Error('expected QueryGiftStore');
    }
    const rows = await giftStore.listOutbound();
    expect(queries).toHaveLength(1);
    const sql = queries[0];
    if (sql === undefined) {
      throw new Error('expected gift SELECT');
    }
    expect(sql).toMatch(/SELECT paid_at, amount_sats, recipient_wos_user/);
    expect(sql).toMatch(/FROM gift/);
    expect(sql).toMatch(/direction = 'outbound'/);
    expect(rows).toEqual([
      {
        paidAt: new Date('2026-06-01T12:00:00.000Z'),
        amountSats: 42,
        recipientWosUser: 'alice',
      },
    ]);
  });
});
