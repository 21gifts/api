import { InMemoryAuthStore, type AuthStore } from '@/lib/auth/store';
import { migrateAuthSchema, PostgresAuthStore } from '@/lib/auth/postgres-store';
import type { SqlClient } from '@/lib/auth/sql';

/**
 * Factory for the process AuthStore.
 *
 * Blank or unset `DATABASE_URL` yields the in-memory adapter (tests, local
 * boots without Postgres). A set URL migrates the auth schema and returns
 * the Postgres adapter. The SQL client factory is required when a URL is set
 * so unit tests never import the Bun SQL runtime.
 *
 * @param databaseUrl - `postgres://` URL, or `undefined` / blank for memory.
 * @param createClient - SQL client factory; required when `databaseUrl` is set.
 * @returns The store to inject into {@link createApp}.
 * @throws If `databaseUrl` is set and `createClient` is omitted.
 */
export async function openAuthStore(
  databaseUrl: string | undefined,
  createClient?: (url: string) => SqlClient,
): Promise<AuthStore> {
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    return new InMemoryAuthStore();
  }
  if (createClient === undefined) {
    throw new Error('openAuthStore requires a SQL client factory when DATABASE_URL is set');
  }
  const sql = createClient(databaseUrl.trim());
  await migrateAuthSchema(sql);
  return new PostgresAuthStore(sql);
}
