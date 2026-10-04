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
import type { MergeDb, MergeTx } from './lib/account-merge';
import type { SqlClient } from './lib/auth/sql';
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
import { InMemoryMessageStore, textHasHashtagToken } from './lib/message-store';
import { seedDevShopPlaces } from './lib/dev-shop-places';
import { publishExistingShopPlaces, resolveMapPush } from './lib/ocp-place';
import { resolveSpendPing } from './lib/spend-ping';
import { syncWelcomePing } from './lib/welcome-media';
import { resolveZapRelays } from './lib/nostr/relays';
import { ExternalIngestLimiter } from './lib/nostr/external';
import { resolveVapidConfig } from './lib/push-config';
import { UnconfiguredPushSender, WebPushSender, type PushSender } from './lib/push-sender';
import { InMemoryPushStore } from './lib/push-store';
import { PUSH_WORKER_INTERVAL_MS, startPushWorker } from './lib/push-worker';
import { resolveMediaDir } from './lib/video';
import { resolveFreePaymentsConfig, resolveLnurlServerConfig } from './lib/config';
import { InMemorySparkInvoiceStore } from './lib/spark-invoice-store';
import { startSparkInvoiceWorker } from './lib/spark-worker';
import { startPosPaidWorker } from './lib/pos-paid-worker';
import { createApp, parseBindAddr, resolveBindAddr } from './server';

/* v8 ignore start — Bun runtime boot path; exercised by smoke tests, not unit tests */
function createBunDatabase(databaseUrl: string): { client: SqlClient; mergeDb: MergeDb } {
  const sql = new SQL(databaseUrl);
  return {
    client: {
      async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
        return (await sql.unsafe(text, [...params])) as T[];
      },
      async execute(text: string, params: readonly unknown[] = []): Promise<void> {
        await sql.unsafe(text, [...params]);
      },
    },
    mergeDb: {
      async begin<T>(run: (tx: MergeTx) => Promise<T>): Promise<T> {
        return sql.begin(async (tx) =>
          run({
            query: async <R>(text: string, params: readonly unknown[] = []): Promise<R[]> =>
              (await tx.unsafe(text, [...params])) as R[],
          }),
        );
      },
    },
  };
}

if (import.meta.main) {
  const addr = resolveBindAddr(undefined, process.env);
  const { host, port } = parseBindAddr(addr);
  resolveMediaDir(process.env);
  const databaseUrl = process.env['DATABASE_URL'];
  const trimmedDatabaseUrl = databaseUrl?.trim() ?? '';
  const bun = trimmedDatabaseUrl === '' ? undefined : createBunDatabase(trimmedDatabaseUrl);
  // BTC_USD_CANDLES_URL and FRANKFURTER_RATES_URL are optional — resolvers
  // inside openBootStores fall back to Coinbase / Frankfurter ECB; unset
  // does not fail boot.
  const querier = new WebsocketNostrQuerier();
  const boot = await openBootStores(databaseUrl, bun === undefined ? undefined : () => bun.client, {
    nostrQuerier: querier,
    zapRelayUrls: resolveZapRelays(process.env),
    nostrRelayTimeoutMs: RELAY_TIMEOUT_MS,
    now: Date.now,
  });
  const {
    authStore,
    giftStore,
    giftRecorder,
    btcUsdRates,
    fiatRates,
    messageStore,
    nostrKek,
    contactStore,
    memberHabitStore,
    posStore,
    apiLogStore,
    diagnosticStore,
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
  const banners = boot.bannerStore ?? new InMemoryBannerStore();
  const lnurlServer = resolveLnurlServerConfig(process.env) ?? undefined;
  const freePayments = resolveFreePaymentsConfig(process.env);
  const sparkInvoiceStore =
    lnurlServer !== undefined && freePayments !== null
      ? (boot.sparkInvoiceStore ?? new InMemorySparkInvoiceStore())
      : undefined;
  const app = createApp({
    authStore,
    btcUsdRates,
    fiatRates,
    pushStore,
    posStore,
    env: process.env,
    messageStore: forumMessages,
    ...(giftStore === undefined ? {} : { giftStore }),
    ...(giftRecorder === undefined ? {} : { giftRecorder }),
    ...(boot.translationStore === undefined ? {} : { translationStore: boot.translationStore }),
    ...(boot.conversationTranslationStore === undefined
      ? {}
      : { conversationTranslationStore: boot.conversationTranslationStore }),
    ...(nostrKek === undefined ? {} : { nostrKek }),
    ...(publisher === undefined ? {} : { nostrPublisher: publisher }),
    nostrQuerier: querier,
    nostrRelayUrls: resolveZapRelays(process.env),
    ...(contactStore === undefined ? {} : { contactStore }),
    ...(memberHabitStore === undefined ? {} : { memberHabitStore }),
    ...(apiLogStore === undefined ? {} : { apiLogStore }),
    ...(diagnosticStore === undefined ? {} : { diagnosticStore }),
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
  void publishExistingShopPlaces({
    ...(mapPush === undefined ? {} : { mapPush }),
    listPlaces: (limit) => forumMessages.listPlaces(limit),
    getById: (id) => forumMessages.getById(id),
    textHasHashtagToken,
  }).catch(() => {
    console.warn(JSON.stringify({ event: 'ocp.place.failed' }));
  });
  setInterval(welcomeCatchUp, 15 * 60 * 1000).unref();
  if (sender.isConfigured()) {
    startPushWorker({ store: pushStore, sender, now: Date.now }, PUSH_WORKER_INTERVAL_MS);
  }
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
    });
  }
}
/* v8 ignore stop */
