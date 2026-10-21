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
import { WebsocketNostrPublisher } from './lib/nostr/publish';
import { WebsocketNostrQuerier } from './lib/nostr/query';
import { PostRateLimiter } from './lib/nostr/rate-limit';
import { InMemoryBannerStore } from './lib/banner-store';
import { RELAY_TIMEOUT_MS, startNostrWorker, WORKER_INTERVAL_MS } from './lib/nostr/worker';
import { InMemoryMessageStore } from './lib/message-store';
import { seedDevShopPlaces } from './lib/dev-shop-places';
import { resolveMapPush } from './lib/ocp-place';
import { InMemoryShopIdentityStore } from './lib/shop-identity';
import { startOcpOutboxWorker } from './lib/ocp-outbox';
import { resolveSpendPing } from './lib/spend-ping';
import { syncWelcomePing } from './lib/welcome-media';
import { resolveZapRelays, resolveZapReadRelays } from './lib/nostr/relays';
import { ExternalIngestLimiter } from './lib/nostr/external';
import { resolveVapidConfig } from './lib/push-config';
import { UnconfiguredPushSender, WebPushSender, type PushSender } from './lib/push-sender';
import { InMemoryPushStore } from './lib/push-store';
import { PUSH_WORKER_INTERVAL_MS, startPushWorker } from './lib/push-worker';
import { resolveMediaDir } from './lib/video';
import { createApp, parseBindAddr, resolveBindAddr } from './server';

/* v8 ignore start — Bun runtime boot path; exercised by smoke tests, not unit tests */
const POSTGRES_REOPEN_MS = 1000;

interface BunDatabase {
  client: SqlClient;
  mergeDb: MergeDb;
  close(): Promise<void>;
}

/** Keep a rejection handler on the driver query. The caller still sees the rejection. */
function retain<T>(pending: Promise<T>): Promise<T> {
  void pending.catch(() => undefined);
  return pending;
}

function createBunDatabase(databaseUrl: string): BunDatabase {
  const sql = new SQL(databaseUrl);
  const client: SqlClient = {
    async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      return (await retain(sql.unsafe(text, [...params]))) as T[];
    },
    async execute(text: string, params: readonly unknown[] = []): Promise<void> {
      await retain(sql.unsafe(text, [...params]));
    },
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
      return sql.close({ timeout: 0 });
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
              const stores = await openBootStores(databaseUrl, () => next.client, bootFx);
              bun = next;
              return stores;
            } catch (error) {
              try {
                await next.close();
              } catch {
                // The pool is already closed.
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
    messageStore,
    shopIdentityStore,
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
  const shopIdentities = shopIdentityStore ?? new InMemoryShopIdentityStore(forumMessages);
  const banners = boot.bannerStore ?? new InMemoryBannerStore();
  const app = createApp({
    authStore,
    btcUsdRates,
    fiatRates,
    pushStore,
    posStore,
    env: process.env,
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
    ...(publisher === undefined ? {} : { nostrPublisher: publisher }),
    nostrQuerier: querier,
    nostrRelayUrls: resolveZapReadRelays(process.env),
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
  });
  Bun.serve({ fetch: app.fetch, hostname: host, port });
  console.warn(`21gifts-api listening on ${host}:${port}`);
  const welcomeCatchUp = (): void => {
    void syncWelcomePing({
      ...(spendPing === undefined ? {} : { spendPing }),
      messages: forumMessages,
      auth: authStore,
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
  if (sender.isConfigured()) {
    startPushWorker({ store: pushStore, sender, now: Date.now }, PUSH_WORKER_INTERVAL_MS);
  }
  if (publisher !== undefined && nostrKek !== undefined && messageStore !== undefined) {
    startNostrWorker(
      {
        messages: messageStore,
        auth: authStore,
        kek: nostrKek,
        publisher,
        querier,
        externalLimiter: new ExternalIngestLimiter(),
        fetchImpl: globalThis.fetch,
        now: Date.now,
        env: process.env,
        pushStore,
        postLimiter,
        ...(conversationStore === undefined ? {} : { conversations: conversationStore }),
        ...(notificationStore === undefined ? {} : { notificationStore }),
        ...(spendPing === undefined ? {} : { spendPing }),
        ...(fundingStore === undefined ? {} : { fundingStore }),
        banners,
        fiatRates,
        shopIdentities,
      },
      WORKER_INTERVAL_MS,
    );
  }
}
/* v8 ignore stop */
