import { openAuthStore } from '@/lib/auth/open-store';
import type { SqlClient } from '@/lib/auth/sql';
import type { AuthStore } from '@/lib/auth/store';
import { parseNostrKek } from '@/lib/nostr/kek';
import {
  InMemoryBtcUsdStore,
  PostgresBtcUsdStore,
  fillRatesForGiftRange,
  migrateBtcUsdSchema,
  type BtcUsdRateBook,
} from '@/lib/btc-usd-store';
import { resolveCandlesUrl, type FetchFn } from '@/lib/btc-usd-candles';
import { migrateDbChangeSchema } from '@/lib/db-change';
import { mapGiftQueryRow } from '@/lib/gift';
import { QueryGiftStore, type GiftStore } from '@/lib/gift-store';
import { SqlGiftRecorder, type GiftRecorder } from '@/lib/gift-recorder';
import { logEvent } from '@/lib/log';
import { migrateContactSchema, PostgresContactStore, type ContactStore } from '@/lib/contact-store';
import {
  migrateConversationSchema,
  PostgresConversationStore,
  type ConversationStore,
} from '@/lib/conversation-store';
import { migrateMessageSchema, PostgresMessageStore, type MessageStore } from '@/lib/message-store';
import { migratePushSchema, PostgresPushStore, type PushStore } from '@/lib/push-store';

/** Auth, gift, forum, contact, conversation, push, and FX persistence produced from `DATABASE_URL`. */
export interface BootStores {
  /** Durable or in-memory account store. */
  authStore: AuthStore;
  /**
   * Postgres-backed gift stats, or `undefined` when no SQL client was
   * opened so `createApp` keeps the empty in-memory default.
   */
  giftStore: GiftStore | undefined;
  /**
   * Inserts proven spend gifts into `gift`, or `undefined` when no SQL
   * client was opened so `createApp` keeps the no-op recorder.
   */
  giftRecorder: GiftRecorder | undefined;
  /** BTC-USD rate book (memory when no SQL; Postgres otherwise). */
  btcUsdRates: BtcUsdRateBook;
  /**
   * Postgres-backed forum store, or `undefined` when no SQL client was
   * opened so `createApp` keeps the empty in-memory default.
   */
  messageStore: MessageStore | undefined;
  /** Parsed KEK when DATABASE_URL is set; `undefined` on memory boots. */
  nostrKek: Uint8Array | undefined;
  /**
   * Postgres-backed contact mailbox, or `undefined` when no SQL client was
   * opened so `createApp` keeps the empty in-memory default.
   */
  contactStore: ContactStore | undefined;
  /**
   * Postgres-backed private messaging store, or `undefined` when no SQL
   * client was opened so `createApp` keeps the empty in-memory default.
   */
  conversationStore: ConversationStore | undefined;
  /**
   * Postgres-backed push store, or `undefined` when no SQL client was
   * opened so the entry point keeps an in-memory default.
   */
  pushStore: PushStore | undefined;
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
 * Open auth, optional gift, forum, contact, conversation, and push persistence, and the
 * BTC-USD rate book from `DATABASE_URL`.
 *
 * Blank or unset URL yields in-memory auth, `giftStore: undefined`,
 * `giftRecorder: undefined`, `messageStore: undefined`,
 * `contactStore: undefined`, `conversationStore: undefined`,
 * `pushStore: undefined`, `nostrKek: undefined`,
 * and an empty {@link InMemoryBtcUsdStore}. A set URL asks `createClient`
 * for one `SqlClient`, migrates auth (via `openAuthStore`) then the FX,
 * `message`, `contact`, `conversation`, `push`, and `db_change` schemas, builds a
 * {@link QueryGiftStore}, {@link SqlGiftRecorder},
 * {@link PostgresMessageStore}, {@link PostgresContactStore},
 * {@link PostgresConversationStore}, and
 * {@link PostgresPushStore}, parses `NOSTR_NSEC_KEK` into `nostrKek`,
 * constructs {@link PostgresBtcUsdStore}, and best-effort fills rates for
 * the outbound gift day range (failures log `gifts.fx.boot_fill.failed` and
 * do not throw). Memory boots leave `nostrKek` undefined and do not run
 * the `db_change` migrate.
 *
 * @param databaseUrl - `postgres://` URL, or `undefined` / blank for memory.
 * @param createClient - SQL factory; required when `databaseUrl` is set.
 * @param fx - Optional fetch / URL / clock overrides for tests.
 * @returns Stores to inject into `createApp`.
 * @throws If `databaseUrl` is set and `createClient` is omitted, or if the
 *   SQL path has a missing or malformed `NOSTR_NSEC_KEK`.
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
    return {
      authStore,
      giftStore: undefined,
      giftRecorder: undefined,
      btcUsdRates: new InMemoryBtcUsdStore(),
      messageStore: undefined,
      nostrKek: undefined,
      contactStore: undefined,
      conversationStore: undefined,
      pushStore: undefined,
    };
  }

  const nostrKek = parseNostrKek(process.env['NOSTR_NSEC_KEK']);

  await migrateBtcUsdSchema(sqlClient);
  await migrateMessageSchema(sqlClient);
  await migrateContactSchema(sqlClient);
  await migrateConversationSchema(sqlClient);
  await migratePushSchema(sqlClient);
  await migrateDbChangeSchema(sqlClient);

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
  const giftRecorder = new SqlGiftRecorder(giftSql);
  const messageStore = new PostgresMessageStore(sqlClient);
  const contactStore = new PostgresContactStore(sqlClient);
  const conversationStore = new PostgresConversationStore(sqlClient);
  const pushStore = new PostgresPushStore(sqlClient);
  return {
    authStore,
    giftStore,
    giftRecorder,
    btcUsdRates,
    messageStore,
    nostrKek,
    contactStore,
    conversationStore,
    pushStore,
  };
}
