import type { AuthStore } from '@/lib/auth/store';
import type { MessageStore } from '@/lib/message-store';
import { logEvent } from '@/lib/log';
import { buildKind1Event } from '@/lib/nostr/event';
import { ensureAccountNostrKey } from '@/lib/nostr/keys';
import { publicAcked, spaceAcked, type NostrPublisher } from '@/lib/nostr/publish';
import { resolveWriteSet, type ResolvedWriteSet } from '@/lib/nostr/relays';
import { signEventForAccount } from '@/lib/nostr/sign';

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
  /** Clock. */
  now: () => number;
  /** Env slice for write-set flags. */
  env: Record<string, string | undefined>;
}

/**
 * Sign unsigned rows, then optionally fan out to relays.
 *
 * Always signs. Publishes only when `NOSTR_PUBLISH=1`. Public relays only
 * when `NOSTR_PUBLISH_PUBLIC=1`. Space ACK parks; published requires space
 * plus ≥1 public ACK.
 *
 * @param deps - Stores, kek, publisher, clock, env.
 */
export async function runNostrWorkerTick(deps: NostrWorkerDeps): Promise<void> {
  const writeSet = resolveWriteSet(deps.env);
  const nowMs = deps.now();
  await signBatch(deps, nowMs);
  if (writeSet.publishEnabled) {
    await publishBatch(deps, writeSet, nowMs);
  }
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
      const createdAt = Math.floor(row.createdAt.getTime() / 1000);
      const unsigned = buildKind1Event(row.text, createdAt);
      const signed = await signEventForAccount(deps.auth, row.accountId, deps.kek, unsigned);
      await deps.messages.updateSignedEvent(
        row.id,
        signed.id,
        signed as unknown as Record<string, unknown>,
      );
      /* v8 ignore next 3 -- sign/decrypt failures */
    } catch {
      logEvent('nostr.sign.failed', { messageId: row.id });
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
    try {
      const acks = await deps.publisher.publish(row.nostrEvent, urls, RELAY_TIMEOUT_MS);
      const space = spaceAcked(acks, writeSet.spaceUrl);
      if (!space) {
        logEvent('nostr.publish.nack', { messageId: row.id, relay: 'space' });
        continue;
      }
      if (writeSet.publicEnabled && publicAcked(acks, writeSet.spaceUrl)) {
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
