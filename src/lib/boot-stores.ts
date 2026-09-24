import { openAuthStore } from '@/lib/auth/open-store';
import type { SqlClient } from '@/lib/auth/sql';
import type { AuthStore } from '@/lib/auth/store';
import { parseNostrKek } from '@/lib/nostr/kek';
import { WebsocketNostrQuerier, type NostrQuerier } from '@/lib/nostr/query';
import { resolveZapRelays } from '@/lib/nostr/relays';
import { backfillExternalZappers, backfillZapPayments } from '@/lib/nostr/zap-index';
import {
  InMemoryBtcUsdStore,
  PostgresBtcUsdStore,
  fillRatesForGiftRange,
  migrateBtcUsdSchema,
  type BtcUsdRateBook,
} from '@/lib/btc-usd-store';
import { resolveCandlesUrl, type FetchFn } from '@/lib/btc-usd-candles';
import { resolveFrankfurterUrl } from '@/lib/usd-fiat-candles';
import {
  InMemoryFiatStore,
  PostgresFiatStore,
  fillFiatRatesForGiftRange,
  migrateFiatSchema,
  type FiatRateBook,
} from '@/lib/usd-fiat-store';
import { listDbChanges, migrateDbChangeSchema } from '@/lib/db-change';
import { mapGiftQueryRow } from '@/lib/gift';
import {
  migrateGiftSchema,
  QueryGiftStore,
  type GiftDebugRow,
  type GiftStore,
} from '@/lib/gift-store';
import { SqlGiftRecorder, type GiftRecorder } from '@/lib/gift-recorder';
import { logEvent } from '@/lib/log';
import { migrateApiLogSchema, PostgresApiLogStore, type ApiLogStore } from '@/lib/api-log';
import { migrateContactSchema, PostgresContactStore, type ContactStore } from '@/lib/contact-store';
import {
  InMemoryPosStore,
  PostgresPosStore,
  migratePosSchema,
  type PosStore,
} from '@/lib/pos-store';
import {
  migrateConversationSchema,
  PostgresConversationStore,
  type ConversationStore,
} from '@/lib/conversation-store';
import { migrateMessageSchema, PostgresMessageStore, type MessageStore } from '@/lib/message-store';
import { PostgresTranslationStore, type TranslationStore } from '@/lib/translation-store';
import {
  migrateNotificationSchema,
  PostgresNotificationStore,
  type NotificationStore,
} from '@/lib/notification-store';
import { migratePushSchema, PostgresPushStore, type PushStore } from '@/lib/push-store';
import { migrateTrustSchema, PostgresTrustStore, type TrustStore } from '@/lib/trust-store';
import { migrateFundingSchema, PostgresFundingStore, type FundingStore } from '@/lib/funding-store';
import { PostgresDebugDbStore, type DebugDbStore } from '@/lib/debug-db';

/** Auth, gift, forum, contact, conversation, notification, push, trust, funding, and FX persistence produced from `DATABASE_URL`. */
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
  /** USD→CHF/EUR/PHP rate book (memory when no SQL; Postgres otherwise). */
  fiatRates: FiatRateBook;
  /**
   * Postgres-backed forum store, or `undefined` when no SQL client was
   * opened so `createApp` keeps the empty in-memory default.
   */
  messageStore: MessageStore | undefined;
  /**
   * Postgres-backed translation cache, or `undefined` when no SQL client was
   * opened so `createApp` keeps the empty in-memory default.
   */
  translationStore: TranslationStore | undefined;
  /**
   * Postgres-backed conversation translation cache, or `undefined` when no
   * SQL client was opened so `conversationRoutes` constructs one
   * {@link InMemoryTranslationStore}. Aimed at `conversation_message_translation`.
   */
  conversationTranslationStore: TranslationStore | undefined;
  /** Parsed KEK when DATABASE_URL is set; `undefined` on memory boots. */
  nostrKek: Uint8Array | undefined;
  /**
   * Postgres-backed contact mailbox, or `undefined` when no SQL client was
   * opened so `createApp` keeps the empty in-memory default.
   */
  contactStore: ContactStore | undefined;
  /** POS charge store (memory when no SQL; Postgres otherwise). */
  posStore: PosStore;
  /**
   * Postgres-backed HTTP audit log, or `undefined` when no SQL client was
   * opened so `createApp` keeps the empty in-memory default.
   */
  apiLogStore: ApiLogStore | undefined;
  /**
   * Postgres-backed private messaging store, or `undefined` when no SQL
   * client was opened so `createApp` keeps the empty in-memory default.
   */
  conversationStore: ConversationStore | undefined;
  /**
   * Postgres-backed in-app notifications, or `undefined` on memory boots.
   */
  notificationStore: NotificationStore | undefined;
  /**
   * Postgres-backed push store, or `undefined` when no SQL client was
   * opened so the entry point keeps an in-memory default.
   */
  pushStore: PushStore | undefined;
  /**
   * Postgres-backed trust-edge store, or `undefined` when no SQL client was
   * opened so `createApp` keeps the empty in-memory default.
   */
  trustStore: TrustStore | undefined;
  /**
   * Postgres-backed funding-grant store, or `undefined` when no SQL client was
   * opened so `createApp` keeps the empty in-memory default.
   */
  fundingStore: FundingStore | undefined;
  /** Operator dump of `db_change`, or `undefined` on memory boots. */
  listDbChange: ((limit: number) => Promise<unknown[]>) | undefined;
  /**
   * Postgres reader for `GET /debug/db`, or `undefined` when no SQL client
   * was opened so the route answers 503.
   */
  debugDbStore: DebugDbStore | undefined;
}

/** Optional boot wiring so tests never hit the network. */
export interface BootFxOptions {
  /** Injected fetch (default: `globalThis.fetch`). */
  fetchImpl?: FetchFn;
  /** Candles URL (default: `resolveCandlesUrl(process.env)`). */
  candlesUrl?: string;
  /** Frankfurter ECB rates URL (default: `resolveFrankfurterUrl(process.env)`). */
  frankfurterUrl?: string;
  /** Clock for boot range-fill (default: `Date.now`). */
  now?: () => number;
  /** Nostr querier for the external-zapper backfill. */
  nostrQuerier?: NostrQuerier;
  /** Relay URLs for the external-zapper backfill. */
  zapRelayUrls?: readonly string[];
  /** Per-relay timeout for the external-zapper backfill. */
  nostrRelayTimeoutMs?: number;
}

/**
 * Open auth, optional gift, forum, contact, conversation, notification,
 * push, trust, and funding persistence, and the BTC-USD and USD-fiat rate
 * books from `DATABASE_URL`.
 *
 * Blank or unset URL yields in-memory auth, `giftStore: undefined`,
 * `giftRecorder: undefined`, `messageStore: undefined`,
 * `translationStore: undefined`,
 * `conversationTranslationStore: undefined`,
 * `contactStore: undefined`, a fresh {@link InMemoryPosStore} as `posStore`,
 * `apiLogStore: undefined`,
 * `conversationStore: undefined`,
 * `notificationStore: undefined`, `pushStore: undefined`,
 * `trustStore: undefined`, `fundingStore: undefined`, `listDbChange: undefined`,
 * `debugDbStore: undefined`, `nostrKek: undefined`,
 * an empty {@link InMemoryBtcUsdStore}, and an empty {@link InMemoryFiatStore}.
 * A set URL asks `createClient` for one `SqlClient`, migrates auth (via
 * `openAuthStore`) then the FX tables (`btc_usd_daily` then `usd_fiat_daily`),
 * `message`, `contact`, `pos_charge` (via `migratePosSchema`), `conversation`, `push`, `notification`, `trust_edge`,
 * `funding_grant`, `api_log`, and `db_change` schemas (notification after push, trust
 * after notification, funding after trust, `api_log` immediately before
 * `db_change` so `trg_db_change` attaches), builds a {@link QueryGiftStore},
 * {@link SqlGiftRecorder}, {@link PostgresMessageStore},
 * {@link PostgresTranslationStore},
 * {@link PostgresContactStore}, {@link PostgresPosStore}, {@link PostgresConversationStore},
 * {@link PostgresNotificationStore}, {@link PostgresPushStore},
 * {@link PostgresTrustStore}, and {@link PostgresFundingStore}, parses
 * `NOSTR_NSEC_KEK` into `nostrKek`, constructs {@link PostgresBtcUsdStore} and
 * {@link PostgresFiatStore}, and best-effort fills rates for the outbound gift
 * day range (BTC-USD failures log `gifts.fx.boot_fill.failed`; fiat failures
 * log `gifts.fx.fiat_boot_fill.failed`; neither throws). Once the Postgres
 * message store exists, it backfills zap-payment claims and best-effort
 * backfills external zappers after the `db_change` triggers are attached and
 * before the remaining Postgres stores are constructed. External-zapper
 * backfill failures log `nostr.zapper.backfill.failed` and do not abort boot.
 * Memory boots omit
 * `notificationStore`, `trustStore`, and `fundingStore`, leave `nostrKek`
 * undefined, and do not run the `db_change` migrate. SQL boots return
 * {@link PostgresNotificationStore}, {@link PostgresTrustStore},
 * {@link PostgresFundingStore}, {@link PostgresApiLogStore}, and
 * {@link PostgresDebugDbStore}.
 * `migrateTrustSchema` then `migrateFundingSchema` run after auth/`account`
 * exists and before `migrateApiLogSchema` / `migrateDbChangeSchema` so
 * `trg_db_change` attaches to `trust_edge` and `funding_grant`.
 * `migrateApiLogSchema` runs after `openAuthStore` (account exists) and
 * immediately before `migrateDbChangeSchema` so `trg_db_change` attaches
 * to `api_log`.
 *
 * @param databaseUrl - `postgres://` URL, or `undefined` / blank for memory.
 * @param createClient - SQL factory; required when `databaseUrl` is set.
 * @param fx - Optional network, URL, timeout, and clock overrides for tests.
 * @returns Stores to inject into `createApp`.
 * @throws If `databaseUrl` is set and `createClient` is omitted, if the SQL
 *   path has a missing or malformed `NOSTR_NSEC_KEK`, or if a migration or
 *   zap-payment backfill store operation fails.
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
      fiatRates: new InMemoryFiatStore(),
      messageStore: undefined,
      translationStore: undefined,
      conversationTranslationStore: undefined,
      nostrKek: undefined,
      contactStore: undefined,
      posStore: new InMemoryPosStore(),
      apiLogStore: undefined,
      conversationStore: undefined,
      notificationStore: undefined,
      pushStore: undefined,
      trustStore: undefined,
      fundingStore: undefined,
      listDbChange: undefined,
      debugDbStore: undefined,
    };
  }
  const sql: SqlClient = sqlClient;

  const nostrKek = parseNostrKek(process.env['NOSTR_NSEC_KEK']);

  await migrateBtcUsdSchema(sqlClient);
  await migrateFiatSchema(sqlClient);
  await migrateGiftSchema(sqlClient);
  await migrateMessageSchema(sqlClient);
  await migrateContactSchema(sqlClient);
  await migratePosSchema(sqlClient);
  await migrateConversationSchema(sqlClient);
  await migratePushSchema(sqlClient);
  await migrateNotificationSchema(sqlClient);
  await migrateTrustSchema(sqlClient);
  await migrateFundingSchema(sqlClient);
  await migrateApiLogSchema(sqlClient);
  await migrateDbChangeSchema(sqlClient);

  const fetchImpl = fx?.fetchImpl ?? globalThis.fetch;
  const candlesUrl = fx?.candlesUrl ?? resolveCandlesUrl(process.env);
  const frankfurterUrl = fx?.frankfurterUrl ?? resolveFrankfurterUrl(process.env);
  const now = fx?.now ?? Date.now;
  const btcUsdRates = new PostgresBtcUsdStore({ sql: sqlClient, fetchImpl, candlesUrl });
  const fiatRates = new PostgresFiatStore({ sql: sqlClient, fetchImpl, ratesUrl: frankfurterUrl });

  try {
    await fillRatesForGiftRange(sqlClient, btcUsdRates, now());
  } catch {
    logEvent('gifts.fx.boot_fill.failed');
  }

  try {
    await fillFiatRatesForGiftRange(sqlClient, fiatRates, now());
  } catch {
    logEvent('gifts.fx.fiat_boot_fill.failed');
  }

  const giftSql = sqlClient;
  const giftStore = new QueryGiftStore(
    async () => {
      const rows = await giftSql.query<{
        paid_at: Date | string;
        amount_sats: number | string | bigint;
        recipient_wos_user: string;
        fiat_usd: string | number | null;
        fiat_chf: string | number | null;
        fiat_eur: string | number | null;
        fiat_php: string | number | null;
      }>(
        `SELECT paid_at, amount_sats, recipient_wos_user,
                fiat_usd::text AS fiat_usd, fiat_chf::text AS fiat_chf,
                fiat_eur::text AS fiat_eur, fiat_php::text AS fiat_php
             FROM gift
             WHERE direction = 'outbound'
             ORDER BY paid_at ASC`,
      );
      return rows.map((row) => mapGiftQueryRow(row));
    },
    async () => {
      const rows = await giftSql.query<{
        id: number | string;
        paid_at: Date | string;
        direction: string;
        currency: string;
        amount_sats: number | string | bigint;
        fee_sats: number | string | bigint;
        recipient_wos_user: string;
        lightning_invoice: string;
        wos_transaction_id: string | null;
        description: string;
        point_of_sale: boolean;
        wos_status: string | null;
        source_wallet: string;
        imported_at: Date | string;
        fiat_usd: string | number | null;
        fiat_chf: string | number | null;
        fiat_eur: string | number | null;
        fiat_php: string | number | null;
      }>(
        `SELECT id, paid_at, direction, currency, amount_sats, fee_sats, recipient_wos_user,
                lightning_invoice, wos_transaction_id, description, point_of_sale, wos_status,
                source_wallet, imported_at, fiat_usd::text AS fiat_usd,
                fiat_chf::text AS fiat_chf, fiat_eur::text AS fiat_eur,
                fiat_php::text AS fiat_php
         FROM gift
         ORDER BY paid_at DESC, id DESC`,
      );
      const iso = (value: Date | string): string =>
        value instanceof Date ? value.toISOString() : new Date(value).toISOString();
      return rows.map((row): GiftDebugRow => ({
        id: Number(row.id),
        paidAt: iso(row.paid_at),
        direction: row.direction,
        currency: row.currency,
        amountSats: Number(row.amount_sats),
        amountUsd: row.fiat_usd === null ? null : String(row.fiat_usd),
        amountChf: row.fiat_chf === null ? null : String(row.fiat_chf),
        amountEur: row.fiat_eur === null ? null : String(row.fiat_eur),
        amountPhp: row.fiat_php === null ? null : String(row.fiat_php),
        feeSats: Number(row.fee_sats),
        recipientWosUser: row.recipient_wos_user,
        lightningInvoice: row.lightning_invoice,
        wosTransactionId: row.wos_transaction_id,
        description: row.description,
        pointOfSale: row.point_of_sale === true,
        wosStatus: row.wos_status,
        sourceWallet: row.source_wallet,
        importedAt: iso(row.imported_at),
      }));
    },
  );
  const giftRecorder = new SqlGiftRecorder(giftSql);
  const messageStore = new PostgresMessageStore(sqlClient, { fetchImpl, fiatRates, now });
  const translationStore = new PostgresTranslationStore(sqlClient);
  const conversationTranslationStore = new PostgresTranslationStore(
    sqlClient,
    'conversation_message_translation',
  );
  await backfillZapPayments(messageStore);
  try {
    await backfillExternalZappers(messageStore, {
      auth: authStore,
      querier: fx?.nostrQuerier ?? new WebsocketNostrQuerier(),
      urls: fx?.zapRelayUrls ?? resolveZapRelays(process.env),
      timeoutMs: fx?.nostrRelayTimeoutMs ?? 5_000,
      now,
    });
  } catch {
    logEvent('nostr.zapper.backfill.failed');
  }
  const contactStore = new PostgresContactStore(sqlClient);
  const posStore = new PostgresPosStore(sqlClient);
  const apiLogStore = new PostgresApiLogStore(sqlClient);
  const conversationStore = new PostgresConversationStore(sqlClient, { fetchImpl, fiatRates, now });
  const pushStore = new PostgresPushStore(sqlClient);
  const notificationStore = new PostgresNotificationStore(sqlClient);
  const trustStore = new PostgresTrustStore(sqlClient);
  const fundingStore = new PostgresFundingStore(sqlClient);
  return {
    authStore,
    giftStore,
    giftRecorder,
    btcUsdRates,
    fiatRates,
    messageStore,
    translationStore,
    conversationTranslationStore,
    nostrKek,
    contactStore,
    posStore,
    apiLogStore,
    conversationStore,
    notificationStore,
    pushStore,
    trustStore,
    fundingStore,
    listDbChange: (limit) => listDbChanges(sql, limit),
    debugDbStore: new PostgresDebugDbStore(sqlClient),
  };
}
