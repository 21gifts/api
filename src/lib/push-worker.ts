/**
 * Enqueue helpers and the Web Push outbox worker.
 */

import { buildForumPushPayload, buildZapPushPayload, type PushPayload } from '@/lib/push';
import type { PushSender } from '@/lib/push-sender';
import type { PushOutboxRow, PushStore } from '@/lib/push-store';

/** Max outbox rows claimed per tick. */
export const PUSH_WORKER_BATCH = 20;

/** Lease duration while a worker owns a row (ms). */
export const PUSH_WORKER_LEASE_MS = 60_000;

/** Default `setInterval` period (ms). */
export const PUSH_WORKER_INTERVAL_MS = 2_000;

/** Debug ping payload (zap type, null message id). */
function buildDebugPushPayload(): PushPayload {
  return {
    type: 'zap',
    title: 'Test notification',
    body: 'This is a test from 21.gifts.',
    url: '/welcome',
    tag: 'debug',
  };
}

/**
 * Enqueue one forum notification per subscriber except the author.
 *
 * @param store - Push store.
 * @param authorId - Message author (never notified).
 * @param messageId - Forum message id.
 * @param nowMs - Enqueue clock.
 */
export async function enqueueForumPushes(
  store: PushStore,
  authorId: string,
  messageId: string,
  nowMs: number,
): Promise<void> {
  const accountIds = await store.listAccountIdsWithSubscriptions();
  const payload = JSON.stringify(buildForumPushPayload());
  const createdAt = new Date(nowMs);
  for (const accountId of accountIds) {
    if (accountId === authorId) {
      continue;
    }
    const row: PushOutboxRow = {
      id: crypto.randomUUID(),
      accountId,
      type: 'forum',
      messageId,
      payload,
      status: 'pending',
      attempts: 0,
      claimedUntil: null,
      createdAt,
    };
    await store.enqueue(row);
  }
}

/**
 * Enqueue one zap notification for the note author when they have a subscription.
 *
 * @param store - Push store.
 * @param authorId - Note author to notify.
 * @param messageId - Forum message id.
 * @param nowMs - Enqueue clock.
 */
export async function enqueueZapPush(
  store: PushStore,
  authorId: string,
  messageId: string,
  nowMs: number,
): Promise<void> {
  const subs = await store.listByAccount(authorId);
  if (subs.length === 0) {
    return;
  }
  const row: PushOutboxRow = {
    id: crypto.randomUUID(),
    accountId: authorId,
    type: 'zap',
    messageId,
    payload: JSON.stringify(buildZapPushPayload(messageId)),
    status: 'pending',
    attempts: 0,
    claimedUntil: null,
    createdAt: new Date(nowMs),
  };
  await store.enqueue(row);
}

/**
 * Enqueue a debug test notification when the account has a subscription.
 *
 * @param store - Push store.
 * @param accountId - Target account.
 * @param nowMs - Enqueue clock.
 * @returns Number of rows enqueued (`0` or `1`).
 */
export async function enqueueDebugPush(
  store: PushStore,
  accountId: string,
  nowMs: number,
): Promise<number> {
  const subs = await store.listByAccount(accountId);
  if (subs.length === 0) {
    return 0;
  }
  const row: PushOutboxRow = {
    id: crypto.randomUUID(),
    accountId,
    type: 'zap',
    messageId: null,
    payload: JSON.stringify(buildDebugPushPayload()),
    status: 'pending',
    attempts: 0,
    claimedUntil: null,
    createdAt: new Date(nowMs),
  };
  await store.enqueue(row);
  return 1;
}

/** Collaborators for one push worker tick. */
export interface PushWorkerDeps {
  /** Shared push store (same instance as HTTP). */
  store: PushStore;
  /** Delivery collaborator. */
  sender: PushSender;
  /** Clock. */
  now: () => number;
}

/**
 * Claim a batch and deliver each row to every subscription for its account.
 *
 * @param deps - Store, sender, clock.
 */
export async function runPushWorkerTick(deps: PushWorkerDeps): Promise<void> {
  if (!deps.sender.isConfigured()) {
    return;
  }
  const nowMs = deps.now();
  const rows = await deps.store.claimPending(PUSH_WORKER_BATCH, nowMs, PUSH_WORKER_LEASE_MS);
  for (const row of rows) {
    const subs = await deps.store.listByAccount(row.accountId);
    if (subs.length === 0) {
      await deps.store.markSent(row.id);
      continue;
    }
    let anyFail = false;
    for (const sub of subs) {
      const result = await deps.sender.send(sub, row.payload);
      if (result.ok) {
        continue;
      }
      if (result.reason === 'gone') {
        await deps.store.deleteSubscription(row.accountId, sub.endpoint);
        continue;
      }
      anyFail = true;
    }
    if (anyFail) {
      await deps.store.markFailed(row.id);
    } else {
      await deps.store.markSent(row.id);
    }
  }
}

/**
 * Start a periodic push worker. Returns a handle to stop the interval.
 *
 * @param deps - Store, sender, clock.
 * @param intervalMs - Tick period (default {@link PUSH_WORKER_INTERVAL_MS}).
 * @returns `{ stop }` to clear the interval.
 */
export function startPushWorker(
  deps: PushWorkerDeps,
  intervalMs: number = PUSH_WORKER_INTERVAL_MS,
): { stop: () => void } {
  /* v8 ignore next 3 -- interval callback */
  const timer = setInterval(() => {
    void runPushWorkerTick(deps);
  }, intervalMs);
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
