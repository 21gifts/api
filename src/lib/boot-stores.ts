import { openAuthStore } from '@/lib/auth/open-store';
import type { SqlClient } from '@/lib/auth/sql';
import type { AuthStore } from '@/lib/auth/store';
import { mapGiftQueryRow } from '@/lib/gift';
import { QueryGiftStore, type GiftStore } from '@/lib/gift-store';

/** Auth plus optional gift persistence produced from `DATABASE_URL`. */
export interface BootStores {
  /** Durable or in-memory account store. */
  authStore: AuthStore;
  /**
   * Postgres-backed gift stats, or `undefined` when no SQL client was
   * opened so `createApp` keeps the empty in-memory default.
   */
  giftStore: GiftStore | undefined;
}

/**
 * Open auth and optional gift persistence from `DATABASE_URL`.
 *
 * Blank or unset URL yields in-memory auth and `giftStore: undefined`.
 * A set URL asks `createClient` for one `SqlClient`, migrates auth, and
 * builds a {@link QueryGiftStore} that SELECTs outbound gifts on that
 * same client.
 *
 * @param databaseUrl - `postgres://` URL, or `undefined` / blank for memory.
 * @param createClient - SQL factory; required when `databaseUrl` is set.
 * @returns Stores to inject into `createApp`.
 */
export async function openBootStores(
  databaseUrl: string | undefined,
  createClient?: (url: string) => SqlClient,
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
    return { authStore, giftStore: undefined };
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
  return { authStore, giftStore };
}
