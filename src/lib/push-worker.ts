/**
 * Enqueue helpers and the Web Push outbox worker.
 */

import { resolveSession } from '@/lib/auth/service';
import type { AuthStore } from '@/lib/auth/store';
import { errorLogFields, logEvent } from '@/lib/log';
import {
  buildForumPushPayload,
  buildReplyPushPayload,
  buildZapPushPayload,
  type PushPayload,
} from '@/lib/push';
import type { PushSender } from '@/lib/push-sender';
import type { PushOutboxRow, PushStore, PushSubscriptionRecord } from '@/lib/push-store';

/** Max outbox rows claimed per tick. */
export const PUSH_WORKER_BATCH = 20;

/** Lease duration while a worker owns a row (ms). */
export const PUSH_WORKER_LEASE_MS = 60_000;

/** Default `setInterval` period (ms). */
export const PUSH_WORKER_INTERVAL_MS = 2_000;

/** Period of {@link sweepPushStore} inside {@link startPushWorker} (ms). */
export const PUSH_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How long a `sent` or `failed` outbox row is kept after it finished (ms).
 * Long enough to look at a delivery problem reported a few days later,
 * short enough that notification text does not pile up in the table.
 */
export const PUSH_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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
  const payload = JSON.stringify(
    buildForumPushPayload({ postId: messageId, name: 'Someone', text: '' }),
  );
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
      finishedAt: null,
      createdAt,
      deliveredEndpoints: [],
      skipEndpoints: [],
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
  const payload = JSON.stringify(
    buildReplyPushPayload({ replyId: messageId, name: 'Someone', text: '' }),
  );
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
      finishedAt: null,
      createdAt,
      deliveredEndpoints: [],
      skipEndpoints: [],
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
  const payload = JSON.stringify(
    buildZapPushPayload({ messageId, name: 'Someone', amountSats: 0 }),
  );
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
      finishedAt: null,
      createdAt,
      deliveredEndpoints: [],
      skipEndpoints: [],
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
    finishedAt: null,
    createdAt: new Date(nowMs),
    deliveredEndpoints: [],
    skipEndpoints: [],
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
  /** Auth store whose sessions the subscriptions are bound to. */
  authStore: AuthStore;
}

/**
 * Whether the session that registered `sub` still authenticates its account
 * (same rule as a bearer request: known, not expired, account not refused).
 */
async function subscriptionSessionLive(
  authStore: AuthStore,
  nowMs: number,
  sub: PushSubscriptionRecord,
): Promise<boolean> {
  if (sub.sessionToken === null) {
    return false;
  }
  const account = await resolveSession(authStore, nowMs, sub.sessionToken);
  return account !== null && account.id === sub.accountId;
}

function payloadTag(payload: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed === null || typeof parsed !== 'object') {
      return undefined;
    }
    const tag = (parsed as { tag?: unknown }).tag;
    if (typeof tag !== 'string' || tag === '') {
      return undefined;
    }
    return tag;
  } catch {
    return undefined;
  }
}

function dismissPayloadTags(payload: string): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed === null || typeof parsed !== 'object') {
      return undefined;
    }
    const record = parsed as { type?: unknown; tags?: unknown };
    if (record.type !== 'dismiss' || !Array.isArray(record.tags)) {
      return undefined;
    }
    const tags: string[] = [];
    for (const item of record.tags) {
      if (typeof item !== 'string') {
        return undefined;
      }
      tags.push(item);
    }
    return tags;
  } catch {
    return undefined;
  }
}

function sameClaimDismissesTag(rows: readonly PushOutboxRow[], row: PushOutboxRow): boolean {
  const tag = payloadTag(row.payload);
  if (tag === undefined) {
    return false;
  }
  // Dismiss rows are newer and later in the claim; inspect the full batch.
  for (const other of rows) {
    if (other.id === row.id) {
      continue;
    }
    if (other.accountId !== row.accountId) {
      continue;
    }
    const tags = dismissPayloadTags(other.payload);
    if (tags !== undefined && tags.includes(tag)) {
      return true;
    }
  }
  return false;
}

/**
 * Claim a batch and deliver each row to every subscription for its account.
 * A subscription whose session no longer authenticates its account is
 * deleted instead of sent to. Does not send endpoints listed in
 * `skipEndpoints`. A skipped endpoint is not recorded as delivered. Skips endpoints already recorded on the outbox
 * row so retries do not re-send a payload that succeeded on a previous tick.
 * A failed send is marked sent when the same claim includes a dismiss for
 * that payload tag for the same account, so a later tick cannot deliver the
 * content after the dismiss.
 *
 * @param deps - Store, sender, clock, auth store.
 */
export async function runPushWorkerTick(deps: PushWorkerDeps): Promise<void> {
  if (!deps.sender.isConfigured()) {
    return;
  }
  const nowMs = deps.now();
  const rows = await deps.store.claimPending(PUSH_WORKER_BATCH, nowMs, PUSH_WORKER_LEASE_MS);
  for (const row of rows) {
    const subs = await deps.store.listByAccount(row.accountId);
    const skip = new Set(row.skipEndpoints);
    const targets = subs.filter((sub) => !skip.has(sub.endpoint));
    if (targets.length === 0) {
      await deps.store.markSent(row.id, nowMs);
      continue;
    }
    const delivered = new Set(row.deliveredEndpoints);
    const newlyDelivered: string[] = [];
    let anyFail = false;
    for (const sub of targets) {
      if (delivered.has(sub.endpoint)) {
        continue;
      }
      if (!(await subscriptionSessionLive(deps.authStore, nowMs, sub))) {
        await deps.store.deleteStaleSubscription(sub);
        continue;
      }
      const result = await deps.sender.send(sub, row.payload);
      if (result.ok) {
        newlyDelivered.push(sub.endpoint);
        delivered.add(sub.endpoint);
        continue;
      }
      if (result.reason === 'gone') {
        await deps.store.deleteStaleSubscription(sub);
        continue;
      }
      anyFail = true;
      if (result.reason === 'fail' && 'status' in result && typeof result.status === 'number') {
        logEvent('push.send.failed', { status: result.status });
      } else {
        logEvent('push.send.failed');
      }
    }
    if (newlyDelivered.length > 0) {
      await deps.store.recordDelivered(row.id, newlyDelivered);
    }
    if (anyFail) {
      if (sameClaimDismissesTag(rows, row)) {
        await deps.store.markSent(row.id, nowMs);
      } else {
        await deps.store.markFailed(row.id, nowMs);
      }
    } else {
      await deps.store.markSent(row.id, nowMs);
    }
  }
}

/**
 * Delete every subscription whose session no longer authenticates its
 * account (expired, removed, or refused; or a row stored without a session),
 * then every `sent` or `failed` outbox row that finished more than
 * {@link PUSH_OUTBOX_RETENTION_MS} ago. Pending rows stay. Runs whether or
 * not a push sender is configured.
 *
 * @param deps - Store, auth store, clock (the sender is not used).
 * @returns Counts of deleted subscriptions and outbox rows.
 */
export async function sweepPushStore(
  deps: Pick<PushWorkerDeps, 'store' | 'authStore' | 'now'>,
): Promise<{ subscriptions: number; outbox: number }> {
  const nowMs = deps.now();
  let subscriptions = 0;
  for (const sub of await deps.store.listAllSubscriptions()) {
    if (await subscriptionSessionLive(deps.authStore, nowMs, sub)) {
      continue;
    }
    if (await deps.store.deleteStaleSubscription(sub)) {
      subscriptions += 1;
    }
  }
  const outbox = await deps.store.deleteFinishedOutbox(nowMs - PUSH_OUTBOX_RETENTION_MS);
  if (subscriptions > 0 || outbox > 0) {
    logEvent('push.sweep', { subscriptions, outbox });
  }
  return { subscriptions, outbox };
}

/**
 * Start a periodic push worker. Each tick delivers the outbox; once at start
 * and then every {@link PUSH_SWEEP_INTERVAL_MS} it runs {@link sweepPushStore}.
 * Returns a handle to stop both intervals.
 *
 * @param deps - Store, sender, clock, auth store.
 * @param intervalMs - Tick period (default {@link PUSH_WORKER_INTERVAL_MS}).
 * @returns `{ stop }` to clear the intervals.
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
  const sweep = (): void => {
    void sweepPushStore(deps).catch((error: unknown) => {
      // No message: a driver error can embed bound values such as a session token.
      logEvent('push.sweep.failed', errorLogFields(error));
    });
  };
  sweep();
  const sweepTimer = setInterval(sweep, PUSH_SWEEP_INTERVAL_MS);
  return {
    stop: () => {
      clearInterval(timer);
      clearInterval(sweepTimer);
    },
  };
}
