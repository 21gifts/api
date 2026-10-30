/**
 * Service entry point.
 *
 * The thinnest possible top-level: resolve + parse the bind address, build
 * the app via the factory, hand the request handler to Bun's native HTTP
 * server. Testable store wiring lives in `lib/boot-stores.ts`; this file is
 * the I/O boundary that wires helpers to the Bun runtime and is therefore
 * excluded from coverage.
 */
import { SQL } from 'bun';
import { openBootStores } from './lib/boot-stores';
import {
  installPostgresConnectionClosedGuard,
  retryWhilePostgresConnectionClosed,
} from './lib/postgres-connection-closed';
import type { MergeDb, MergeTx } from './lib/account-merge';
import type { SqlClient } from './lib/auth/sql';
import { logPoolOptions } from './lib/sql-pool';
import { WebsocketNostrPublisher } from './lib/nostr/publish';
import { WebsocketNostrQuerier } from './lib/nostr/query';
import { PostRateLimiter } from './lib/nostr/rate-limit';
import { InMemoryBannerStore } from './lib/banner-store';
import {
  RELAY_TIMEOUT_MS,
  startNostrWorker,
  WORKER_INTERVAL_MS,
  zapReceiptIngest,
} from './lib/nostr/worker';
import { InMemoryMessageStore } from './lib/message-store';
import { seedDevShopPlaces } from './lib/dev-shop-places';
import { resolveMapPush } from './lib/ocp-place';
import { InMemoryShopIdentityStore } from './lib/shop-identity';
import { startOcpOutboxWorker } from './lib/ocp-outbox';
import { resolveSpendPing } from './lib/spend-ping';
import { syncWelcomePing } from './lib/welcome-media';
import { resolveZapRelays } from './lib/nostr/relays';
import { ExternalIngestLimiter } from './lib/nostr/external';
import { resolveVapidConfig } from './lib/push-config';
import { UnconfiguredPushSender, WebPushSender, type PushSender } from './lib/push-sender';
import { InMemoryPushStore } from './lib/push-store';
import { PUSH_WORKER_INTERVAL_MS, startPushWorker } from './lib/push-worker';
import { resolveMediaDir } from './lib/video';
import {
  resolveFreePaymentsConfig,
  resolveLnurlServerConfig,
  resolveShopPaymentConfig,
} from './lib/config';
import { OrchestraClient } from './lib/orchestra';
import { ShopPayments } from './lib/shop-payment';
import { InMemoryShopPaymentStore, PostgresShopPaymentStore } from './lib/shop-payment-store';
import { InMemorySparkInvoiceStore } from './lib/spark-invoice-store';
import { startSparkInvoiceWorker } from './lib/spark-worker';
import { startPosPaidWorker } from './lib/pos-paid-worker';
import { resolveFxSpotUrl, startFxSpotWorker } from './lib/fx-spot';
import { createApp, parseBindAddr, resolveBindAddr } from './server';

/* v8 ignore start — Bun runtime boot path; exercised by smoke tests, not unit tests */
const POSTGRES_REOPEN_MS = 1000;

interface BunDatabase {
  client: SqlClient;
  log: SqlClient;
  mergeDb: MergeDb;
  close(): Promise<void>;
}

/** Keep a rejection handler on the driver query. The caller still sees the rejection. */
function retain<T>(pending: Promise<T>): Promise<T> {
  void pending.catch(() => undefined);
  return pending;
}

function bunSqlClient(sql: SQL): SqlClient {
  return {
    async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      return (await retain(sql.unsafe(text, [...params]))) as T[];
    },
    async execute(text: string, params: readonly unknown[] = []): Promise<void> {
      await retain(sql.unsafe(text, [...params]));
    },
  };
}

function createBunDatabase(databaseUrl: string): BunDatabase {
  const sql = new SQL(databaseUrl);
  // Log inserts use their own pool. A stuck insert must not take a request connection.
  const logSql = new SQL(databaseUrl, logPoolOptions());
  const client: SqlClient = {
    ...bunSqlClient(sql),
    async transaction<T>(run: (tx: SqlClient) => Promise<T>): Promise<T> {
      return retain(
        sql.begin(async (tx) =>
          run({
            query: async <R>(text: string, params: readonly unknown[] = []): Promise<R[]> =>
              (await retain(tx.unsafe(text, [...params]))) as R[],
            execute: async (text: string, params: readonly unknown[] = []): Promise<void> => {
              await retain(tx.unsafe(text, [...params]));
            },
          }),
        ),
      );
    },
  };
  return {
    client,
    log: bunSqlClient(logSql),
    mergeDb: {
      async begin<T>(run: (tx: MergeTx) => Promise<T>): Promise<T> {
        return retain(
          sql.begin(async (tx) =>
            run({
              query: async <R>(text: string, params: readonly unknown[] = []): Promise<R[]> =>
                (await retain(tx.unsafe(text, [...params]))) as R[],
            }),
          ),
        );
      },
    },
    close(): Promise<void> {
      return Promise.all([sql.close({ timeout: 0 }), logSql.close({ timeout: 0 })]).then(
        () => undefined,
      );
    },
  };
}

if (import.meta.main) {
  // Closed connections reject the query and can also surface as unhandled.
  // The guard keeps a listening process up. Boot retries the open. Writes are not retried.
  installPostgresConnectionClosedGuard();
  const addr = resolveBindAddr(undefined, process.env);
  const { host, port } = parseBindAddr(addr);
  resolveMediaDir(process.env);
  const databaseUrl = process.env['DATABASE_URL'];
  const trimmedDatabaseUrl = databaseUrl?.trim() ?? '';
  // BTC_USD_CANDLES_URL and FRANKFURTER_RATES_URL are optional — resolvers
  // inside openBootStores fall back to Coinbase / Frankfurter ECB; unset
  // does not fail boot.
  const querier = new WebsocketNostrQuerier();
  const bootFx = {
    nostrQuerier: querier,
    zapRelayUrls: resolveZapRelays(process.env),
    nostrRelayTimeoutMs: RELAY_TIMEOUT_MS,
    now: Date.now,
  };
  let bun: BunDatabase | undefined;
  const boot =
    trimmedDatabaseUrl === ''
      ? await openBootStores(databaseUrl, undefined, bootFx)
      : await retryWhilePostgresConnectionClosed(
          async () => {
            const next = createBunDatabase(trimmedDatabaseUrl);
            try {
              const stores = await openBootStores(
                databaseUrl,
                () => next.client,
                { ...bootFx, logSql: next.log },
                next.mergeDb,
              );
              bun = next;
              return stores;
            } catch (error) {
              try {
                await next.close();
              } catch {
                // The pools are already closed.
              }
              throw error;
            }
          },
          (ms) => Bun.sleep(ms),
          POSTGRES_REOPEN_MS,
        );
  const {
    authStore,
    giftStore,
    giftRecorder,
    btcUsdRates,
    fiatRates,
    fxSpotStore,
    messageStore,
    shopIdentityStore,
    nostrKek,
    recoveryShareKek,
    contactStore,
    memberHabitStore,
    posStore,
    apiLogStore,
    diagnosticStore,
    walletStore,
    memberEventStore,
    conversationStore,
    notificationStore,
    trustStore,
    fundingStore,
    rosterStore,
    debugDbStore,
  } = boot;
  const pushStore = boot.pushStore ?? new InMemoryPushStore();
  const vapid = resolveVapidConfig(process.env);
  let sender: PushSender = new UnconfiguredPushSender();
  let vapidPublicKey: string | undefined;
  if (vapid !== null) {
    try {
      sender = new WebPushSender(vapid);
      vapidPublicKey = vapid.publicKey;
    } catch {
      console.warn(JSON.stringify({ event: 'push.vapid.invalid' }));
    }
  }
  const publisher =
    nostrKek !== undefined && messageStore !== undefined
      ? new WebsocketNostrPublisher()
      : undefined;
  const spendPing = resolveSpendPing(
    process.env,
    globalThis.fetch,
    giftStore === undefined ? { rosterStore } : { gifts: giftStore, rosterStore },
  );
  const postLimiter = new PostRateLimiter();
  const forumMessages = messageStore ?? new InMemoryMessageStore();
  const shopIdentities = shopIdentityStore ?? new InMemoryShopIdentityStore(forumMessages);
  const banners = boot.bannerStore ?? new InMemoryBannerStore();
  const lnurlServer = resolveLnurlServerConfig(process.env) ?? undefined;
  const freePayments = resolveFreePaymentsConfig(process.env);
  const sparkInvoiceStore =
    lnurlServer !== undefined && freePayments !== null
      ? (boot.sparkInvoiceStore ?? new InMemorySparkInvoiceStore())
      : undefined;
  const shopConfig = resolveShopPaymentConfig(process.env);
  const shopPayments =
    lnurlServer === undefined
      ? undefined
      : new ShopPayments({
          store:
            bun === undefined
              ? new InMemoryShopPaymentStore(posStore)
              : new PostgresShopPaymentStore(bun.client, bun.mergeDb),
          posStore,
          auth: authStore,
          lnurlServer,
          config: shopConfig,
          orchestra:
            shopConfig === null
              ? null
              : new OrchestraClient({
                  baseUrl: shopConfig.orchestraBaseUrl,
                  apiKey: shopConfig.orchestraApiKey,
                  fetchImpl: globalThis.fetch,
                  now: Date.now,
                }),
          fxSpot: fxSpotStore,
          fetchImpl: globalThis.fetch,
          now: Date.now,
        });
  const app = createApp({
    ...(shopPayments === undefined ? {} : { shopPayments }),
    authStore,
    btcUsdRates,
    fiatRates,
    fxSpotStore,
    pushStore,
    posStore,
    env: process.env,
    ...(boot.loginGateStore === undefined ? {} : { loginGateStore: boot.loginGateStore }),
    messageStore: forumMessages,
    shopIdentityStore: shopIdentities,
    ...(giftStore === undefined ? {} : { giftStore }),
    ...(giftRecorder === undefined ? {} : { giftRecorder }),
    ...(boot.translationStore === undefined ? {} : { translationStore: boot.translationStore }),
    ...(boot.conversationTranslationStore === undefined
      ? {}
      : { conversationTranslationStore: boot.conversationTranslationStore }),
    // A memory boot has no KEK; its shop keys use a process-ephemeral one and vanish with the rows.
    ...(nostrKek === undefined
      ? { shopKek: crypto.getRandomValues(new Uint8Array(32)) }
      : { nostrKek }),
    ...(recoveryShareKek === undefined ? {} : { recoveryShareKek }),
    ...(publisher === undefined ? {} : { nostrPublisher: publisher }),
    nostrQuerier: querier,
    nostrRelayUrls: resolveZapRelays(process.env),
    ...(contactStore === undefined ? {} : { contactStore }),
    ...(memberHabitStore === undefined ? {} : { memberHabitStore }),
    ...(apiLogStore === undefined ? {} : { apiLogStore }),
    ...(diagnosticStore === undefined ? {} : { diagnosticStore }),
    ...(walletStore === undefined ? {} : { walletStore }),
    ...(memberEventStore === undefined ? {} : { memberEventStore }),
    ...(conversationStore === undefined ? {} : { conversationStore }),
    ...(notificationStore === undefined ? {} : { notificationStore }),
    ...(trustStore === undefined ? {} : { trustStore }),
    ...(fundingStore === undefined ? {} : { fundingStore }),
    rosterStore,
    ...(boot.listDbChange === undefined ? {} : { listDbChange: boot.listDbChange }),
    ...(debugDbStore === undefined ? {} : { debugDbStore }),
    ...(bun === undefined ? {} : { mergeDb: bun.mergeDb }),
    vapidPublicKey: vapidPublicKey ?? '',
    postLimiter,
    bannerStore: banners,
    ...(sparkInvoiceStore === undefined ? {} : { sparkInvoiceStore }),
  });
  Bun.serve({ fetch: app.fetch, hostname: host, port });
  console.warn(`21gifts-api listening on ${host}:${port}`);
  const welcomeCatchUp = (): void => {
    void syncWelcomePing({
      ...(spendPing === undefined ? {} : { spendPing }),
      messages: forumMessages,
      auth: authStore,
      ...(giftStore === undefined ? {} : { gifts: giftStore }),
      ...(lnurlServer === undefined ? {} : { lnurlServer }),
    });
  };
  welcomeCatchUp();
  // Copies the public production shop pins only when the public base URL is dev.
  await seedDevShopPlaces({
    env: process.env,
    ...(bun === undefined ? {} : { sql: bun.client }),
  });
  const mapPush = resolveMapPush(process.env, globalThis.fetch);
  if (mapPush !== undefined) {
    // Also runs the start-up pass (queueAllShopPlaces) and retries it until it succeeds.
    startOcpOutboxWorker({ identities: shopIdentities, messages: forumMessages, mapPush });
  }
  setInterval(welcomeCatchUp, 15 * 60 * 1000).unref();
  startFxSpotWorker({
    store: fxSpotStore,
    fetchImpl: globalThis.fetch,
    url: resolveFxSpotUrl(process.env),
    now: Date.now,
  });
  // Always started: ticks send nothing without VAPID, but the hourly sweep
  // still drops subscriptions whose session ended and old outbox rows.
  startPushWorker({ store: pushStore, sender, now: Date.now, authStore }, PUSH_WORKER_INTERVAL_MS);
  const ingestDeps = {
    messages: forumMessages,
    auth: authStore,
    querier,
    fetchImpl: globalThis.fetch,
    now: Date.now,
    env: process.env,
    pushStore,
    postLimiter,
    ...(conversationStore === undefined ? {} : { conversations: conversationStore }),
    ...(notificationStore === undefined ? {} : { notificationStore }),
    ...(spendPing === undefined ? {} : { spendPing }),
    ...(fundingStore === undefined ? {} : { fundingStore }),
    fiatRates,
    ...(lnurlServer === undefined ? {} : { lnurlServer }),
  };
  if (publisher !== undefined && nostrKek !== undefined && messageStore !== undefined) {
    startNostrWorker(
      {
        ...ingestDeps,
        kek: nostrKek,
        publisher,
        externalLimiter: new ExternalIngestLimiter(),
        banners,
        shopIdentities,
      },
      WORKER_INTERVAL_MS,
    );
  }
  if (sparkInvoiceStore !== undefined && freePayments !== null) {
    startSparkInvoiceWorker({
      store: sparkInvoiceStore,
      config: freePayments,
      fetchImpl: globalThis.fetch,
      publisher: publisher ?? new WebsocketNostrPublisher(),
      ingest: zapReceiptIngest(ingestDeps),
      claims: forumMessages,
      now: Date.now,
    });
  }
  if (lnurlServer !== undefined) {
    startPosPaidWorker({
      store: posStore,
      lnurlServer,
      ...(sparkInvoiceStore === undefined || freePayments === null
        ? {}
        : { operatorUrl: freePayments.operatorUrl }),
      fetchImpl: globalThis.fetch,
      now: Date.now,
      ...(shopPayments === undefined ? {} : { shop: shopPayments }),
    });
  }
}
/* v8 ignore stop */
