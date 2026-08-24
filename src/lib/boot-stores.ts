import { openAuthStore } from '@/lib/auth/open-store';
import type { SqlClient } from '@/lib/auth/sql';
import type { AuthStore } from '@/lib/auth/store';
import {
  InMemoryBtcUsdStore,
  PostgresBtcUsdStore,
  fillRatesForGiftRange,
  migrateBtcUsdSchema,
  type BtcUsdRateBook,
} from '@/lib/btc-usd-store';
import { resolveCandlesUrl, type FetchFn } from '@/lib/btc-usd-candles';
import { mapGiftQueryRow } from '@/lib/gift';
import { QueryGiftStore, type GiftStore } from '@/lib/gift-store';
import { logEvent } from '@/lib/log';

/** Auth, gift, and FX persistence produced from `DATABASE_URL`. */
export interface BootStores {
  /** Durable or in-memory account store. */
  authStore: AuthStore;
  /**
   * Postgres-backed gift stats, or `undefined` when no SQL client was
   * opened so `createApp` keeps the empty in-memory default.
   */
  giftStore: GiftStore | undefined;
  /** BTC-USD rate book (memory when no SQL; Postgres otherwise). */
  btcUsdRates: BtcUsdRateBook;
}

/** Optional FX wiring so tests never hit the network. */
export interface BootFxOptions {
  /** Injected fetch (default: `globalThis.fetch`). */
  fetchImpl?: FetchFn;
  /** Candles URL (default: `resolveCandlesUrl(process.env)`). */
  candlesUrl?: string;
  /** Clock for boot range-fill (default: `Date.now`). */
  now?: () => number;
}

/**
 * Open auth, optional gift persistence, and the BTC-USD rate book from
 * `DATABASE_URL`.
 *
 * Blank or unset URL yields in-memory auth, `giftStore: undefined`, and an
 * empty {@link InMemoryBtcUsdStore}. A set URL asks `createClient` for one
 * `SqlClient`, migrates auth (via `openAuthStore`) then the FX table, builds
 * a {@link QueryGiftStore}, constructs {@link PostgresBtcUsdStore}, and
 * best-effort fills rates for the outbound gift day range (failures log
 * `gifts.fx.boot_fill.failed` and do not throw).
 *
 * @param databaseUrl - `postgres://` URL, or `undefined` / blank for memory.
 * @param createClient - SQL factory; required when `databaseUrl` is set.
 * @param fx - Optional fetch / URL / clock overrides for tests.
 * @returns Stores to inject into `createApp`.
 * @throws If `databaseUrl` is set and `createClient` is omitted.
 */
export async function openBootStores(
  databaseUrl: string | undefined,
  createClient?: (url: string) => SqlClient,
  fx?: BootFxOptions,
): Promise<BootStores> {
  let sqlClient: SqlClient | undefined;
  const authStore = await openAuthStore(
    databaseUrl,
    createClient === undefined
      ? undefined
      : (url) => {
          sqlClient = createClient(url);
          return sqlClient;
        },
  );
  if (sqlClient === undefined) {
    return { authStore, giftStore: undefined, btcUsdRates: new InMemoryBtcUsdStore() };
  }

  await migrateBtcUsdSchema(sqlClient);

  const fetchImpl = fx?.fetchImpl ?? globalThis.fetch;
  const candlesUrl = fx?.candlesUrl ?? resolveCandlesUrl(process.env);
  const now = fx?.now ?? Date.now;
  const btcUsdRates = new PostgresBtcUsdStore({ sql: sqlClient, fetchImpl, candlesUrl });

  try {
    await fillRatesForGiftRange(sqlClient, btcUsdRates, now());
  } catch {
    logEvent('gifts.fx.boot_fill.failed');
  }

  const giftSql = sqlClient;
  const giftStore = new QueryGiftStore(async () => {
    const rows = await giftSql.query<{
      paid_at: Date | string;
      amount_sats: number | string | bigint;
      recipient_wos_user: string;
    }>(
      `SELECT paid_at, amount_sats, recipient_wos_user
             FROM gift
             WHERE direction = 'outbound'
             ORDER BY paid_at ASC`,
    );
    return rows.map((row) => mapGiftQueryRow(row));
  });
  return { authStore, giftStore, btcUsdRates };
}
