/**
 * Service entry point.
 *
 * The thinnest possible top-level: resolve + parse the bind address, build
 * the app via the factory, hand the request handler to Bun's native HTTP
 * server. All testable logic lives in `server.ts`; this file is the I/O
 * boundary that wires those pure helpers to the Bun runtime and is therefore
 * excluded from coverage.
 */
import { SQL } from 'bun';
import { openAuthStore } from './lib/auth/open-store';
import type { SqlClient } from './lib/auth/sql';
import { mapGiftQueryRow } from './lib/gift';
import { QueryGiftStore } from './lib/gift-store';
import { createApp, parseBindAddr, resolveBindAddr } from './server';

/* v8 ignore start — Bun runtime boot path; exercised by smoke tests, not unit tests */
function createBunSqlClient(databaseUrl: string): SqlClient {
  const sql = new SQL(databaseUrl);
  return {
    async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      const rows = (await sql.unsafe(text, [...params])) as T[];
      return rows;
    },
    async execute(text: string, params: readonly unknown[] = []): Promise<void> {
      await sql.unsafe(text, [...params]);
    },
  };
}

if (import.meta.main) {
  const addr = resolveBindAddr(undefined, process.env);
  const { host, port } = parseBindAddr(addr);
  const databaseUrl = process.env['DATABASE_URL'];
  let sqlClient: SqlClient | undefined;
  const store = await openAuthStore(databaseUrl, (url) => {
    sqlClient = createBunSqlClient(url);
    return sqlClient;
  });
  const giftSql = sqlClient;
  const giftStore =
    giftSql === undefined
      ? undefined
      : new QueryGiftStore(async () => {
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
  const app = createApp({ authStore: store, giftStore });
  Bun.serve({ fetch: app.fetch, hostname: host, port });
  console.warn(`21gifts-api listening on ${host}:${port}`);
}
/* v8 ignore stop */
