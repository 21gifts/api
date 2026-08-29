import type { AuthStore } from '@/lib/auth/store';
import type { FetchFn } from '@/lib/lnurlp';
import type { MessageStore } from '@/lib/message-store';
import { logEvent } from '@/lib/log';
import { buildKind0Event, buildKind0Content, buildKind1Event } from '@/lib/nostr/event';
import { ensureAccountNostrKey } from '@/lib/nostr/keys';
import { publicAcked, spaceAcked, type NostrPublisher } from '@/lib/nostr/publish';
import type { NostrEventFrame, NostrQuerier } from '@/lib/nostr/query';
import { resolveWriteSet, resolveZapRelays, type ResolvedWriteSet } from '@/lib/nostr/relays';
import { signEventForAccount } from '@/lib/nostr/sign';
import { indexOpenZapReceipts } from '@/lib/nostr/zap-index';

/** Max rows per claim. */
export const WORKER_BATCH = 20;

/** Lease before WebSocket I/O. */
export const WORKER_LEASE_MS = 60_000;

/** Per-relay timeout. */
export const RELAY_TIMEOUT_MS = 5_000;

/** Tick interval. */
export const WORKER_INTERVAL_MS = 2_000;

/** Collaborators for one worker tick. */
export interface NostrWorkerDeps {
  /** Forum store. */
  messages: MessageStore;
  /** Auth store (keys). */
  auth: AuthStore;
  /** AES KEK. */
  kek: Uint8Array;
  /** Publisher (fake in tests). */
  publisher: NostrPublisher;
  /** Querier for zap-receipt ingest (fake in tests). */
  querier: NostrQuerier;
  /** Fetch used for LNURL provider pubkey resolve. */
  fetchImpl: FetchFn;
  /** Optional 9735 signature check (tests inject; production uses nostr-tools). */
  verifyReceipt?: (event: NostrEventFrame) => boolean;
  /** Clock. */
  now: () => number;
  /** Env slice for write-set flags. */
  env: Record<string, string | undefined>;
}

/** Reserved or last-acked kind:0 content per account, keyed by auth store. */
const profileCaches = new WeakMap<AuthStore, Map<string, string>>();

function profileCacheFor(auth: AuthStore): Map<string, string> {
  const existing = profileCaches.get(auth);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Map<string, string>();
  profileCaches.set(auth, created);
  return created;
}

/**
 * Sign unsigned rows, optionally fan out to relays, then ingest zap receipts.
 *
 * Always signs. Publishes only when `NOSTR_PUBLISH=1`. Public relays only
 * when `NOSTR_PUBLISH_PUBLIC=1`. Space ACK with public off is terminal
 * `published`/`space`. With public on, space-only ACK parks `pending`/`space`
 * until a public ACK makes `published`/`public`. Pending kind:1 JSON without
 * `t=bitcoin` is dropped and re-signed before fan-out. When publishing, also
 * fans out a replaceable kind:0 profile (`name` / `display_name` from the
 * account row) to the space relay, and to the public list when
 * `NOSTR_PUBLISH_PUBLIC=1`, so Damus/Primal show the forum name. Kind:0
 * `created_at` is the wall clock at sign time. Each tick also queries
 * zap relays (space plus the public list, even when `NOSTR_PUBLISH_PUBLIC` is
 * off) for kind:9735 receipts and indexes validated ones onto `sats`, even
 * when publish is off.
 *
 * @param deps - Stores, kek, publisher, querier, fetch, clock, env.
 */
export async function runNostrWorkerTick(deps: NostrWorkerDeps): Promise<void> {
  const writeSet = resolveWriteSet(deps.env);
  const nowMs = deps.now();
  await resignLegacyKind1Tags(deps);
  await signBatch(deps, nowMs);
  if (writeSet.publishEnabled) {
    await publishProfiles(deps, writeSet);
    await publishBatch(deps, writeSet, nowMs);
  }
  const urls = resolveZapRelays(deps.env);
  await indexOpenZapReceipts({
    store: deps.messages,
    auth: deps.auth,
    querier: deps.querier,
    urls,
    timeoutMs: RELAY_TIMEOUT_MS,
    now: deps.now,
    fetchImpl: deps.fetchImpl,
    ...(deps.verifyReceipt === undefined ? {} : { verifyReceipt: deps.verifyReceipt }),
  });
}

/**
 * Drop stored kind:1 JSON that predates `t=bitcoin` so `signBatch` rebuilds it.
 */
async function resignLegacyKind1Tags(deps: NostrWorkerDeps): Promise<void> {
  const rows = await deps.messages.listPendingSigned(WORKER_BATCH);
  for (const row of rows) {
    if (!kind1HasBitcoinTag(row.nostrEvent)) {
      await deps.messages.clearSignedEvent(row.id, row.eventId);
    }
  }
}

function kind1HasBitcoinTag(event: Record<string, unknown> | null): boolean {
  if (event === null) {
    return false;
  }
  const tags = event['tags'];
  if (!Array.isArray(tags)) {
    return false;
  }
  return tags.some((tag) => Array.isArray(tag) && tag[0] === 't' && tag[1] === 'bitcoin');
}

async function signBatch(deps: NostrWorkerDeps, nowMs: number): Promise<void> {
  const ids = await deps.auth.listAccountIdsWithoutNostrKey(WORKER_BATCH);
  for (const accountId of ids) {
    try {
      await ensureAccountNostrKey(deps.auth, accountId, deps.kek);
    } catch {
      logEvent('nostr.keygen.backfill.failed', { accountId });
    }
  }
  const rows = await deps.messages.claimUnsigned(WORKER_BATCH, nowMs, WORKER_LEASE_MS);
  for (const row of rows) {
    try {
      await ensureAccountNostrKey(deps.auth, row.accountId, deps.kek);
      let createdAt = Math.floor(row.createdAt.getTime() / 1000);
      let stored = false;
      for (let attempt = 0; attempt < 2 && !stored; attempt += 1) {
        const unsigned = buildKind1Event(row.text, createdAt);
        const signed = await signEventForAccount(deps.auth, row.accountId, deps.kek, unsigned);
        stored = await deps.messages.updateSignedEvent(
          row.id,
          signed.id,
          signed as unknown as Record<string, unknown>,
        );
        if (!stored) {
          createdAt += 1;
        }
      }
      if (!stored) {
        logEvent('nostr.sign.failed', { messageId: row.id, reason: 'event_id' });
      }
      /* v8 ignore next 3 -- sign/decrypt failures */
    } catch {
      logEvent('nostr.sign.failed', { messageId: row.id });
    }
  }
}

async function publishProfiles(deps: NostrWorkerDeps, writeSet: ResolvedWriteSet): Promise<void> {
  const cache = profileCacheFor(deps.auth);
  const urls = writeSet.publicEnabled
    ? [writeSet.spaceUrl, ...writeSet.publicUrls]
    : [writeSet.spaceUrl];
  const accounts = await deps.auth.listAccounts();
  let attempted = 0;
  for (const account of accounts) {
    if (attempted >= WORKER_BATCH) {
      break;
    }
    if (account.name === null) {
      continue;
    }
    const content = buildKind0Content(account.name, account.lightningAddress);
    if (cache.get(account.id) === content) {
      continue;
    }
    attempted += 1;
    cache.set(account.id, content);
    try {
      const pubkey = await deps.auth.getNostrPublicKey(account.id);
      if (pubkey === undefined) {
        if (cache.get(account.id) === content) {
          cache.delete(account.id);
        }
        continue;
      }
      const unsigned = buildKind0Event(
        account.name,
        account.lightningAddress,
        Math.floor(deps.now() / 1000),
      );
      const signed = await signEventForAccount(deps.auth, account.id, deps.kek, unsigned);
      if (cache.get(account.id) !== content) {
        continue;
      }
      const acks = await deps.publisher.publish(
        signed as unknown as Record<string, unknown>,
        urls,
        RELAY_TIMEOUT_MS,
      );
      const spaceOk = spaceAcked(acks, writeSet.spaceUrl);
      const publicOk = !writeSet.publicEnabled || publicAcked(acks, writeSet.spaceUrl);
      if (!spaceOk || !publicOk) {
        if (cache.get(account.id) === content) {
          cache.delete(account.id);
        }
        logEvent('nostr.profile.nack', { accountId: account.id });
        continue;
      }
      logEvent('nostr.profile.ok', { accountId: account.id });
    } catch {
      if (cache.get(account.id) === content) {
        cache.delete(account.id);
      }
      logEvent('nostr.profile.nack', { accountId: account.id });
    }
  }
}

async function publishBatch(
  deps: NostrWorkerDeps,
  writeSet: ResolvedWriteSet,
  nowMs: number,
): Promise<void> {
  const rows = await deps.messages.claimUnpublished(WORKER_BATCH, nowMs, WORKER_LEASE_MS);
  const urls = writeSet.publicEnabled
    ? [writeSet.spaceUrl, ...writeSet.publicUrls]
    : [writeSet.spaceUrl];
  for (const row of rows) {
    /* v8 ignore next 3 -- signed rows always store nostrEvent */
    if (row.nostrEvent === null) {
      continue;
    }
    /* v8 ignore start -- overlapping tick may still hold a pre-resign snapshot */
    if (!kind1HasBitcoinTag(row.nostrEvent)) {
      await deps.messages.clearSignedEvent(row.id, row.eventId);
      continue;
    }
    /* v8 ignore stop */
    try {
      const acks = await deps.publisher.publish(row.nostrEvent, urls, RELAY_TIMEOUT_MS);
      const space = spaceAcked(acks, writeSet.spaceUrl);
      if (!space) {
        logEvent('nostr.publish.nack', { messageId: row.id, relay: 'space' });
        continue;
      }
      if (!writeSet.publicEnabled) {
        await deps.messages.updatePublishState(row.id, 'published', 'space');
        logEvent('nostr.publish.ok', { messageId: row.id, epoch: 'space' });
      } else if (publicAcked(acks, writeSet.spaceUrl)) {
        await deps.messages.updatePublishState(row.id, 'published', 'public');
        logEvent('nostr.publish.ok', { messageId: row.id });
      } else {
        await deps.messages.updatePublishState(row.id, 'pending', 'space');
        logEvent('nostr.publish.ok', { messageId: row.id, parked: 1 });
      }
    } catch {
      logEvent('nostr.publish.nack', { messageId: row.id });
    }
  }
}

/**
 * Start an interval worker. Returns a stop function.
 *
 * @param deps - Worker collaborators.
 * @param intervalMs - Tick period.
 * @returns Stop handle.
 */
export function startNostrWorker(
  deps: NostrWorkerDeps,
  intervalMs: number = WORKER_INTERVAL_MS,
): { stop: () => void } {
  /* v8 ignore next 3 -- interval callback */
  const timer = setInterval(() => {
    void runNostrWorkerTick(deps);
  }, intervalMs);
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
