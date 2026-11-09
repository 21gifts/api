/**
 * Settling a forwarded social recovery (docs/social-recovery.md, rule 5).
 *
 * The transfer route commits on the address claim's own 2xx. When that answer
 * is lost, a later signed lookup decides: the new key holding the username,
 * or a verified "user not found" for the old key, commits; the old key still
 * holding the username drops. Only lookups sent more than twice
 * `LNURL_SERVER_TIMEOUT_MS` after the forward count, so an aborted forward the
 * LNURL server may still run cannot be overtaken. Never logs a key, a
 * signature, or a body.
 */

import type { AuthStore, PendingRecovery } from '@/lib/auth/store';
import type { LnurlServerConfig } from '@/lib/config';
import { errorLogFields, logEvent } from '@/lib/log';
import type { FetchFn } from '@/lib/lnurlp';
import {
  LNURL_SERVER_TIMEOUT_MS,
  callLnurlServer,
  readLookupAnswer,
  type LnurlServerResult,
  type LookupAnswer,
} from '@/lib/lnurl-server';
import { normalizeUsername } from '@/lib/username';

/** A lookup counts for settling only when sent more than this long after the forward. */
export const RECOVERY_SETTLE_AFTER_MS = 2 * LNURL_SERVER_TIMEOUT_MS;

/**
 * Forward the old wallet's signed lookup to the LNURL server and read its answer.
 *
 * Sends `POST lnurlpay/<sparkPubkey>/recover` with `{ signature, timestamp }`
 * as JSON. An unreachable server logs `lnurl_server.unreachable` with
 * `route: 'recovery'`.
 *
 * @param config - Resolved LNURL server configuration.
 * @param fetchImpl - Injected `fetch`.
 * @param now - Clock in epoch milliseconds; read once, before the call.
 * @param sparkPubkey - Normalized identity key of the old wallet.
 * @param lookup - DER signature (lowercase hex) and Unix-seconds timestamp the
 *   wallet signed the lookup with.
 * @returns `sentAt` (epoch ms, taken before the call) and the read answer.
 */
export async function forwardRecoveryLookup(
  config: LnurlServerConfig,
  fetchImpl: FetchFn,
  now: () => number,
  sparkPubkey: string,
  lookup: { signature: string; timestamp: number },
): Promise<{ sentAt: number; answer: LookupAnswer }> {
  const sentAt = now();
  const result = await callLnurlServer(config, fetchImpl, {
    method: 'POST',
    segments: ['lnurlpay', sparkPubkey, 'recover'],
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ signature: lookup.signature, timestamp: lookup.timestamp }),
    timeoutMs: LNURL_SERVER_TIMEOUT_MS,
  });
  if (!result.ok && result.reason === 'unreachable') {
    logEvent('lnurl_server.unreachable', { route: 'recovery' });
  }
  return { sentAt, answer: readLookupAnswer(result) };
}

/**
 * Decide what a signed lookup means for a pending recovery.
 *
 * Keeps an unforwarded recovery, and a forwarded one unless the lookup was
 * sent more than {@link RECOVERY_SETTLE_AFTER_MS} after the forward. Then the
 * new key holding the account's username commits, a verified "user not found"
 * for the old key commits, and the old key holding the username drops.
 * Anything else keeps.
 *
 * @param pending - The account's pending recovery.
 * @param lookup - Whose key was looked up (`old` or `new`), when the lookup
 *   was sent (epoch ms), and the read answer.
 * @param username - The account's username; compared normalized.
 * @returns `commit`, `drop`, or `keep`.
 */
export function settleDecision(
  pending: PendingRecovery,
  lookup: { role: 'old' | 'new'; sentAt: number; answer: LookupAnswer },
  username: string | null | undefined,
): 'commit' | 'drop' | 'keep' {
  if (
    pending.forwardedAt === null ||
    lookup.sentAt - pending.forwardedAt <= RECOVERY_SETTLE_AFTER_MS
  ) {
    return 'keep';
  }
  const name = typeof username === 'string' ? normalizeUsername(username) : null;
  const holdsName =
    lookup.answer.kind === 'holds' && name !== null && lookup.answer.username === name;
  if (lookup.role === 'new') {
    return holdsName ? 'commit' : 'keep';
  }
  if (lookup.answer.kind === 'not_found') {
    return 'commit';
  }
  return holdsName ? 'drop' : 'keep';
}

/**
 * Settle a forwarded pending recovery after a lookup the recover route forwarded.
 *
 * With `pendingNew`, the lookup was of that recovery's new key. Otherwise it
 * was of `pubkey` as some account's verified key, and only that account's
 * pending recovery with `pubkey` as its old key is considered. A commit logs
 * `account.recovery.committed` (`via: 'lookup'`); a drop logs
 * `account.recovery.dropped` (`via: 'lookup'`). Never throws: a store failure
 * logs `account.recovery.settle_failed` and resolves.
 *
 * @param deps - Auth store and clock.
 * @param input - Path key, the pending recovery found by it as a new key (or
 *   `undefined`), when the lookup was sent (epoch ms), and the upstream result.
 * @returns Resolves when settled or left alone.
 */
export async function settleAfterLookup(
  deps: { auth: AuthStore; now: () => number },
  input: {
    pubkey: string;
    pendingNew: PendingRecovery | undefined;
    sentAt: number;
    result: LnurlServerResult;
  },
): Promise<void> {
  try {
    const answer = readLookupAnswer(input.result);
    let pending: PendingRecovery;
    let role: 'old' | 'new';
    if (input.pendingNew !== undefined) {
      pending = input.pendingNew;
      role = 'new';
    } else {
      const holder = await deps.auth.getAccountByVerifiedSparkPubkey(input.pubkey);
      if (holder === undefined) {
        return;
      }
      const found = await deps.auth.getPendingRecovery(holder.id, deps.now());
      if (found?.oldSparkPubkey !== input.pubkey) {
        return;
      }
      pending = found;
      role = 'old';
    }
    const account = await deps.auth.getAccount(pending.accountId);
    const decision = settleDecision(
      pending,
      { role, sentAt: input.sentAt, answer },
      account?.username,
    );
    if (decision === 'commit') {
      const committed = await deps.auth.commitRecovery({
        accountId: pending.accountId,
        newSparkPubkey: pending.newSparkPubkey,
        now: deps.now(),
      });
      if (committed === 'committed') {
        logEvent('account.recovery.committed', { accountId: pending.accountId, via: 'lookup' });
      }
    } else if (decision === 'drop') {
      const dropped = await deps.auth.dropPendingRecovery({
        accountId: pending.accountId,
        newSparkPubkey: pending.newSparkPubkey,
      });
      if (dropped) {
        logEvent('account.recovery.dropped', { accountId: pending.accountId, via: 'lookup' });
      }
    }
  } catch (error) {
    logEvent('account.recovery.settle_failed', errorLogFields(error));
  }
}
