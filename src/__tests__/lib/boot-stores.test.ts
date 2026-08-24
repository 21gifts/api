import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { openBootStores } from '@/lib/boot-stores';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { PostgresAuthStore } from '@/lib/auth/postgres-store';
import type { SqlClient } from '@/lib/auth/sql';
import { MemoryBtcUsdStore, PostgresBtcUsdStore } from '@/lib/btc-usd-store';
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

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

describe('openBootStores', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns in-memory auth, no gift store, and MemoryBtcUsdStore when unset', async () => {
    const factory = vi.fn(() => unusedClient());
    const { authStore, giftStore, btcUsdRates } = await openBootStores(undefined, factory);
    expect(authStore).toBeInstanceOf(InMemoryAuthStore);
    expect(giftStore).toBeUndefined();
    expect(btcUsdRates).toBeInstanceOf(MemoryBtcUsdStore);
    expect(factory).not.toHaveBeenCalled();
  });

  it('returns in-memory auth, no gift store, and MemoryBtcUsdStore when blank', async () => {
    const factory = vi.fn(() => unusedClient());
    const { authStore, giftStore, btcUsdRates } = await openBootStores('   ', factory);
    expect(authStore).toBeInstanceOf(InMemoryAuthStore);
    expect(giftStore).toBeUndefined();
    expect(btcUsdRates).toBeInstanceOf(MemoryBtcUsdStore);
    expect(factory).not.toHaveBeenCalled();
  });

  it('throws when a URL is set without a client factory', async () => {
    await expect(openBootStores('postgres://gifts21@localhost/gifts21')).rejects.toThrow(
      /SQL client factory/,
    );
  });

  it('opens durable auth, QueryGiftStore, migrates FX, and returns PostgresBtcUsdStore', async () => {
    const url = ' postgres://gifts21@localhost/gifts21 ';
    const queries: string[] = [];
    let executeCount = 0;
    const client: SqlClient = {
      query: async <T>(text: string, _params?: readonly unknown[]): Promise<T[]> => {
        queries.push(text);
        if (text.includes('min(paid_at)')) {
          return [{ min: null, max: null }] as T[];
        }
        if (text.includes('btc_usd_daily')) {
          return [] as T[];
        }
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

    const { authStore, giftStore, btcUsdRates } = await openBootStores(url, factory, {
      fetchImpl: async () => new Response('[]', { status: 200 }),
      candlesUrl: 'https://example.test/candles',
      now: () => Date.parse('2026-06-01T12:00:00.000Z'),
    });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(url.trim());
    expect(authStore).toBeInstanceOf(PostgresAuthStore);
    expect(giftStore).toBeInstanceOf(QueryGiftStore);
    expect(btcUsdRates).toBeInstanceOf(PostgresBtcUsdStore);
    expect(executeCount).toBeGreaterThan(0);
    expect(queries.some((q) => q.includes('min(paid_at)'))).toBe(true);

    if (giftStore === undefined) {
      throw new Error('expected QueryGiftStore');
    }
    const giftQueriesBefore = queries.length;
    const rows = await giftStore.listOutbound();
    expect(queries.length).toBe(giftQueriesBefore + 1);
    const sql = queries[queries.length - 1];
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

  it('logs gifts.fx.boot_fill.failed and still returns stores when fill throws', async () => {
    const client: SqlClient = {
      query: async <T>(text: string): Promise<T[]> => {
        if (text.includes('min(paid_at)')) {
          throw new Error('range query failed');
        }
        return [] as T[];
      },
      execute: async () => undefined,
    };
    const { authStore, giftStore, btcUsdRates } = await openBootStores(
      'postgres://gifts21@localhost/gifts21',
      () => client,
      {
        fetchImpl: async () => new Response('[]', { status: 200 }),
        candlesUrl: 'https://example.test/candles',
      },
    );
    expect(authStore).toBeInstanceOf(PostgresAuthStore);
    expect(giftStore).toBeInstanceOf(QueryGiftStore);
    expect(btcUsdRates).toBeInstanceOf(PostgresBtcUsdStore);
    expect(parsedEvents(warn).some((e) => e['event'] === 'gifts.fx.boot_fill.failed')).toBe(true);
  });

  it('uses default fetch and candles URL when fx options are omitted', async () => {
    const client: SqlClient = {
      query: async <T>(text: string): Promise<T[]> => {
        if (text.includes('min(paid_at)')) {
          return [{ min: null, max: null }] as T[];
        }
        return [] as T[];
      },
      execute: async () => undefined,
    };
    const { btcUsdRates, giftStore } = await openBootStores(
      'postgres://gifts21@localhost/gifts21',
      () => client,
    );
    expect(giftStore).toBeInstanceOf(QueryGiftStore);
    expect(btcUsdRates).toBeInstanceOf(PostgresBtcUsdStore);
  });
});
