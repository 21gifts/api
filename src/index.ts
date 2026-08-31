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
import { startNostrWorker, WORKER_INTERVAL_MS } from './lib/nostr/worker';
import { resolveVapidConfig } from './lib/push-config';
import { UnconfiguredPushSender, WebPushSender, type PushSender } from './lib/push-sender';
import { InMemoryPushStore } from './lib/push-store';
import { PUSH_WORKER_INTERVAL_MS, startPushWorker } from './lib/push-worker';
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
  // BTC_USD_CANDLES_URL is optional — resolveCandlesUrl inside openBootStores
  // falls back to Coinbase; unset does not fail boot.
  const boot = await openBootStores(databaseUrl, createBunSqlClient);
  const {
    authStore,
    giftStore,
    giftRecorder,
    btcUsdRates,
    messageStore,
    nostrKek,
    contactStore,
    conversationStore,
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
  const app = createApp({
    authStore,
    btcUsdRates,
    pushStore,
    ...(giftStore === undefined ? {} : { giftStore }),
    ...(giftRecorder === undefined ? {} : { giftRecorder }),
    ...(messageStore === undefined ? {} : { messageStore }),
    ...(nostrKek === undefined ? {} : { nostrKek }),
    ...(contactStore === undefined ? {} : { contactStore }),
    ...(conversationStore === undefined ? {} : { conversationStore }),
    vapidPublicKey: vapidPublicKey ?? '',
  });
  Bun.serve({ fetch: app.fetch, hostname: host, port });
  console.warn(`21gifts-api listening on ${host}:${port}`);
  if (sender.isConfigured()) {
    startPushWorker({ store: pushStore, sender, now: Date.now }, PUSH_WORKER_INTERVAL_MS);
  }
  if (nostrKek !== undefined && messageStore !== undefined) {
    const publisher = new WebsocketNostrPublisher();
    startNostrWorker(
      {
        messages: messageStore,
        auth: authStore,
        kek: nostrKek,
        publisher,
        querier: new WebsocketNostrQuerier(),
        fetchImpl: globalThis.fetch,
        now: Date.now,
        env: process.env,
        pushStore,
        ...(conversationStore === undefined ? {} : { conversations: conversationStore }),
      },
      WORKER_INTERVAL_MS,
    );
  }
}
/* v8 ignore stop */
