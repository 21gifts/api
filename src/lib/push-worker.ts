/**
 * Enqueue helpers and the Web Push outbox worker.
 */

import {
  buildForumPushPayload,
  buildReplyPushPayload,
  buildZapPushPayload,
  type PushPayload,
} from '@/lib/push';
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
 * Enqueue one forum notification per bell subscriber except the skip id.
 * Production path is {@link notifyForumPost}; this helper’s `messageId` is
 * both the outbox id and the payload tag id.
 *
 * @param store - Push store.
 * @param authorId - Skip id (post actor; never notified).
 * @param messageId - Forum message id (outbox `messageId` and payload tag).
 * @param nowMs - Enqueue clock.
 * @returns Resolves after each recipient is enqueued (including no-ops).
 * @throws If `listAccountIdsWithSubscriptions` or `enqueue` rejects.
 */
export async function enqueueForumPushes(
  store: PushStore,
  authorId: string,
  messageId: string,
  nowMs: number,
): Promise<void> {
  const accountIds = await store.listAccountIdsWithSubscriptions();
  const payload = JSON.stringify(buildForumPushPayload(messageId));
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
      deliveredEndpoints: [],
    };
    await store.enqueue(row);
  }
}

/**
 * Enqueue one reply notification per bell subscriber except the skip id.
 * Production path is {@link notifyForumReply}. `parentId` is unused; the
 * payload tag is always `forum_reply:<messageId>` (the reply id).
 *
 * @param store - Push store.
 * @param authorId - Skip id (reply actor; never notified).
 * @param messageId - Reply forum message id (outbox `messageId` and payload tag).
 * @param parentId - Unused (kept for call-site compatibility).
 * @param nowMs - Enqueue clock.
 * @returns Resolves after each recipient is enqueued (including no-ops).
 * @throws If `listAccountIdsWithSubscriptions` or `enqueue` rejects.
 */
export async function enqueueReplyPush(
  store: PushStore,
  authorId: string,
  messageId: string,
  parentId: string,
  nowMs: number,
): Promise<void> {
  void parentId;
  const accountIds = await store.listAccountIdsWithSubscriptions();
  const payload = JSON.stringify(buildReplyPushPayload(messageId));
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
      deliveredEndpoints: [],
    };
    await store.enqueue(row);
  }
}

/**
 * Enqueue one zap notification per bell subscriber except the skip id.
 * `authorId` is a skip id (the payer), not “notify only this author”. The
 * note author is notified unless they are the skip id. Production path is
 * {@link notifyZap}; this helper’s `messageId` is the tag id (callers that
 * pass the forum note id collapse two zaps onto one tag).
 *
 * @param store - Push store.
 * @param authorId - Skip id (payer; may be the note author).
 * @param messageId - Tag id (also stored as outbox `messageId` here).
 * @param nowMs - Enqueue clock.
 * @returns Resolves after each recipient is enqueued (including no-ops).
 * @throws If `listAccountIdsWithSubscriptions` or `enqueue` rejects.
 */
export async function enqueueZapPush(
  store: PushStore,
  authorId: string,
  messageId: string,
  nowMs: number,
): Promise<void> {
  const accountIds = await store.listAccountIdsWithSubscriptions();
  const payload = JSON.stringify(buildZapPushPayload(messageId));
  const createdAt = new Date(nowMs);
  for (const accountId of accountIds) {
    if (accountId === authorId) {
      continue;
    }
    const row: PushOutboxRow = {
      id: crypto.randomUUID(),
      accountId,
      type: 'zap',
      messageId,
      payload,
      status: 'pending',
      attempts: 0,
      claimedUntil: null,
      createdAt,
      deliveredEndpoints: [],
    };
    await store.enqueue(row);
  }
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
    deliveredEndpoints: [],
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
 * Skips endpoints already recorded on the outbox row so retries do not
 * re-send a payload that succeeded on a previous tick.
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
    const delivered = new Set(row.deliveredEndpoints);
    const newlyDelivered: string[] = [];
    let anyFail = false;
    for (const sub of subs) {
      if (delivered.has(sub.endpoint)) {
        continue;
      }
      const result = await deps.sender.send(sub, row.payload);
      if (result.ok) {
        newlyDelivered.push(sub.endpoint);
        delivered.add(sub.endpoint);
        continue;
      }
      if (result.reason === 'gone') {
        await deps.store.deleteSubscription(row.accountId, sub.endpoint);
        continue;
      }
      anyFail = true;
    }
    if (newlyDelivered.length > 0) {
      await deps.store.recordDelivered(row.id, newlyDelivered);
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
  let inFlight = false;
  /* v8 ignore next 8 -- interval callback */
  const timer = setInterval(() => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    void runPushWorkerTick(deps).finally(() => {
      inFlight = false;
    });
  }, intervalMs);
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
