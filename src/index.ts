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
import type { SqlClient } from './lib/auth/sql';
import { WebsocketNostrPublisher } from './lib/nostr/publish';
import { WebsocketNostrQuerier } from './lib/nostr/query';
import { PostRateLimiter } from './lib/nostr/rate-limit';
import { RELAY_TIMEOUT_MS, startNostrWorker, WORKER_INTERVAL_MS } from './lib/nostr/worker';
import { InMemoryMessageStore } from './lib/message-store';
import { resolveBtcMapPush } from './lib/btcmap-push';
import { resolveSpendPing } from './lib/spend-ping';
import { syncWelcomePing } from './lib/welcome-media';
import { resolveZapRelays } from './lib/nostr/relays';
import { ExternalIngestLimiter } from './lib/nostr/external';
import { resolveVapidConfig } from './lib/push-config';
import { UnconfiguredPushSender, WebPushSender, type PushSender } from './lib/push-sender';
import { InMemoryPushStore } from './lib/push-store';
import { PUSH_WORKER_INTERVAL_MS, startPushWorker } from './lib/push-worker';
import { resolveMediaDir } from './lib/video';
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
  resolveMediaDir(process.env);
  const databaseUrl = process.env['DATABASE_URL'];
  // BTC_USD_CANDLES_URL and FRANKFURTER_RATES_URL are optional — resolvers
  // inside openBootStores fall back to Coinbase / Frankfurter ECB; unset
  // does not fail boot.
  const querier = new WebsocketNostrQuerier();
  const boot = await openBootStores(databaseUrl, createBunSqlClient, {
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
    ocpPlaces,
    nostrKek,
    contactStore,
    posStore,
    apiLogStore,
    conversationStore,
    notificationStore,
    trustStore,
    fundingStore,
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
  const spendPing = resolveSpendPing(process.env, globalThis.fetch);
  const btcMapPush = resolveBtcMapPush(process.env, globalThis.fetch);
  const postLimiter = new PostRateLimiter();
  const forumMessages = messageStore ?? new InMemoryMessageStore();
  const app = createApp({
    authStore,
    btcUsdRates,
    fiatRates,
    pushStore,
    posStore,
    env: process.env,
    messageStore: forumMessages,
    ocpPlaces,
    ...(btcMapPush === undefined ? {} : { btcMapPush }),
    ...(giftStore === undefined ? {} : { giftStore }),
    ...(giftRecorder === undefined ? {} : { giftRecorder }),
    ...(boot.translationStore === undefined ? {} : { translationStore: boot.translationStore }),
    ...(boot.conversationTranslationStore === undefined
      ? {}
      : { conversationTranslationStore: boot.conversationTranslationStore }),
    ...(nostrKek === undefined ? {} : { nostrKek }),
    ...(publisher === undefined ? {} : { nostrPublisher: publisher }),
    ...(contactStore === undefined ? {} : { contactStore }),
    ...(apiLogStore === undefined ? {} : { apiLogStore }),
    ...(conversationStore === undefined ? {} : { conversationStore }),
    ...(notificationStore === undefined ? {} : { notificationStore }),
    ...(trustStore === undefined ? {} : { trustStore }),
    ...(fundingStore === undefined ? {} : { fundingStore }),
    ...(boot.listDbChange === undefined ? {} : { listDbChange: boot.listDbChange }),
    ...(debugDbStore === undefined ? {} : { debugDbStore }),
    vapidPublicKey: vapidPublicKey ?? '',
    postLimiter,
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
        fiatRates,
      },
      WORKER_INTERVAL_MS,
    );
  }
}
/* v8 ignore stop */
