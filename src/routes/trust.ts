import { Hono } from 'hono';
import { z } from 'zod';
import { roleAtLeast, sameRoleRank } from '@/lib/auth/roles';
import { resolveSession } from '@/lib/auth/service';
import type { Account, AuthStore } from '@/lib/auth/store';
import { inboxUnreadCountFor } from '@/lib/conversation-push';
import type { ConversationStore } from '@/lib/conversation-store';
import { logEvent } from '@/lib/log';
import { notifyModeratorAppointed, notifyModeratorProposed } from '@/lib/notification';
import type { NotificationStore } from '@/lib/notification-store';
import type { MessageStore } from '@/lib/message-store';
import type { PushStore } from '@/lib/push-store';
import type { SpendPing } from '@/lib/spend-ping';
import { syncWelcomePing } from '@/lib/welcome-media';
import {
  isStaffRole,
  pendingModeratorProposals,
  type TrustEdge,
  type TrustKind,
} from '@/lib/trust';
import type { TrustStore } from '@/lib/trust-store';
import { bearerToken } from '@/routes/me';
import { MESSAGE_ID_RE } from '@/routes/messages';

/**
 * Staff trust routes: list pending moderator proposals, verify a person,
 * propose/confirm/reject a moderator, or appoint a moderator as a founder.
 * Bearer session required.
 */

/** Collaborators the staff trust routes need. */
export interface TrustRouteDeps {
  /** Shared auth persistence port. */
  authStore: AuthStore;
  /** Trust-edge persistence port. */
  trustStore: TrustStore;
  /** Clock returning epoch milliseconds (injected for testability). */
  now: () => number;
  /** Optional in-app notification persistence. */
  notificationStore?: NotificationStore;
  /** Optional Web Push outbox. */
  pushStore?: PushStore;
  /** Optional conversation store so appointed and propose push unreadCount include inbox. */
  conversationStore?: ConversationStore;
  /** Forum notes. Present → a new or repeat verify welcome-pings an existing photo. */
  messages?: MessageStore;
  /** Optional spend ping. Omitted → skip the welcome ping. Failures do not fail the 200. */
  spendPing?: SpendPing;
}

/**
 * Welcome-ping when `account` is verified and already has a photo or video.
 * No forum store → no-op. Does not throw.
 *
 * @param deps - Trust route collaborators.
 * @param account - Subject after the verify write, or the already-verified row.
 */
async function welcomeVerified(deps: TrustRouteDeps, account: Account): Promise<void> {
  if (deps.messages === undefined) {
    return;
  }
  await syncWelcomePing({
    ...(deps.spendPing === undefined ? {} : { spendPing: deps.spendPing }),
    messages: deps.messages,
    account,
  });
}

/** Body schema for staff POSTs that target one account. */
const accountIdBody = z.object({ accountId: z.string() });

/** Resolve the account behind a request's bearer session, or `null`. */
async function authedAccount(
  deps: TrustRouteDeps,
  header: string | undefined,
): Promise<Account | null> {
  const token = bearerToken(header);
  if (token === null) {
    return null;
  }
  return resolveSession(deps.authStore, deps.now(), token);
}

/** `{ id, name, role }` for a successful staff write. */
function accountSummary(account: Account): {
  id: string;
  name: string | null;
  role: Account['role'];
} {
  return { id: account.id, name: account.name, role: account.role };
}

/** True when `error` is the store's duplicate `(subjectId, kind)` rejection. */
function isDuplicateTrustEdge(error: unknown): boolean {
  return error instanceof Error && error.message === 'duplicate trust edge';
}

/**
 * Load a target account. Missing → 404. Postgres/query throw → 503, matching
 * SPEC unexpected-store-throw on the staff POSTs.
 */
async function loadTargetAccount(
  store: AuthStore,
  id: string,
): Promise<{ account: Account } | { error: string; status: 404 | 503 }> {
  try {
    const account = await store.getAccount(id);
    if (account === undefined) {
      return { error: 'Not found', status: 404 };
    }
    return { account };
  } catch {
    logEvent('trust.write.failed');
    return { error: 'Trust chain is unavailable', status: 503 };
  }
}

/**
 * Build the `/trust` route group.
 *
 * Mounted at `/trust` so the public paths are `GET /trust/proposals`,
 * `POST /trust/verify`, `POST /trust/propose-moderator`,
 * `POST /trust/confirm-moderator`, `POST /trust/reject-moderator`, and
 * `POST /trust/appoint-moderator`.
 *
 * @param deps - Auth store, trust-edge store, clock, optional notification/push stores, and optional conversation store.
 * @returns A Hono app with the staff GET and five staff POSTs.
 */
export function trustRoutes(deps: TrustRouteDeps): Hono {
  return new Hono()
    .get('/proposals', async (c) => {
      try {
        const caller = await authedAccount(deps, c.req.header('authorization'));
        if (caller === null) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
        if (!isStaffRole(caller.role)) {
          return c.json({ error: 'Forbidden' }, 403);
        }
        const [accounts, edges] = await Promise.all([
          deps.authStore.listAccounts(),
          deps.trustStore.listEdges(),
        ]);
        const proposals = pendingModeratorProposals(accounts, edges).map((row) => ({
          id: row.id,
          subject: row.subject,
          proposedBy: row.proposedBy,
          createdAt: new Date(row.createdAt).toISOString(),
        }));
        logEvent('trust.proposals.listed', { count: proposals.length });
        return c.json({ proposals }, 200);
      } catch {
        logEvent('trust.proposals.failed');
        return c.json({ error: 'Trust chain is unavailable' }, 503);
      }
    })
    .post('/verify', async (c) => {
      const caller = await authedAccount(deps, c.req.header('authorization'));
      if (caller === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (!isStaffRole(caller.role)) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      const parsed = accountIdBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with an "accountId" string' }, 400);
      }
      if (!MESSAGE_ID_RE.test(parsed.data.accountId)) {
        return c.json({ error: 'Not found' }, 404);
      }
      const loaded = await loadTargetAccount(deps.authStore, parsed.data.accountId);
      if ('status' in loaded) {
        return c.json({ error: loaded.error }, loaded.status);
      }
      const subject = loaded.account;
      if (subject.id === caller.id) {
        return c.json({ error: 'Conflict' }, 409);
      }
      let existing: TrustEdge[];
      try {
        existing = await deps.trustStore.listEdgesForSubject(subject.id);
      } catch {
        logEvent('trust.write.failed');
        return c.json({ error: 'Trust chain is unavailable' }, 503);
      }
      const verifyEdge = existing.find((edge) => edge.kind === 'verify');
      if (verifyEdge !== undefined) {
        if (verifyEdge.actorId !== caller.id) {
          return c.json({ error: 'Conflict' }, 409);
        }
        if (subject.role === 'verified') {
          await welcomeVerified(deps, subject);
          return c.json(accountSummary(subject), 200);
        }
        if (subject.role !== 'basis') {
          return c.json({ error: 'Conflict' }, 409);
        }
        const updated = { ...subject, role: 'verified' as const };
        try {
          await deps.authStore.updateAccount(updated);
        } catch {
          logEvent('trust.write.failed');
          return c.json({ error: 'Trust chain is unavailable' }, 503);
        }
        logEvent('trust.verified', { subjectId: subject.id, actorId: caller.id });
        await welcomeVerified(deps, updated);
        return c.json(accountSummary(updated), 200);
      }
      if (subject.role !== 'basis') {
        return c.json({ error: 'Conflict' }, 409);
      }
      const updated = { ...subject, role: 'verified' as const };
      try {
        await deps.trustStore.insertEdge(newEdge(deps, subject.id, caller.id, 'verify'));
        await deps.authStore.updateAccount(updated);
      } catch (error) {
        if (isDuplicateTrustEdge(error)) {
          return c.json({ error: 'Conflict' }, 409);
        }
        logEvent('trust.write.failed');
        return c.json({ error: 'Trust chain is unavailable' }, 503);
      }
      logEvent('trust.verified', { subjectId: subject.id, actorId: caller.id });
      await welcomeVerified(deps, updated);
      return c.json(accountSummary(updated), 200);
    })
    .post('/propose-moderator', async (c) => {
      const caller = await authedAccount(deps, c.req.header('authorization'));
      if (caller === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (!isStaffRole(caller.role)) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      const parsed = accountIdBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with an "accountId" string' }, 400);
      }
      if (!MESSAGE_ID_RE.test(parsed.data.accountId)) {
        return c.json({ error: 'Not found' }, 404);
      }
      const loaded = await loadTargetAccount(deps.authStore, parsed.data.accountId);
      if ('status' in loaded) {
        return c.json({ error: loaded.error }, loaded.status);
      }
      const subject = loaded.account;
      if (subject.id === caller.id) {
        return c.json({ error: 'Conflict' }, 409);
      }
      if (subject.role !== 'verified') {
        return c.json({ error: 'Conflict' }, 409);
      }
      let existing: TrustEdge[];
      try {
        existing = await deps.trustStore.listEdgesForSubject(subject.id);
      } catch {
        logEvent('trust.write.failed');
        return c.json({ error: 'Trust chain is unavailable' }, 503);
      }
      const hasClosedGrant = existing.some(
        (edge) => edge.kind === 'moderator_confirm' || edge.kind === 'moderator_appoint',
      );
      if (hasClosedGrant || pendingModeratorProposals([subject], existing).length > 0) {
        return c.json({ error: 'Conflict' }, 409);
      }
      const created = newEdge(deps, subject.id, caller.id, 'moderator_propose');
      try {
        await deps.trustStore.insertEdge(created);
      } catch (error) {
        if (isDuplicateTrustEdge(error)) {
          return c.json({ error: 'Conflict' }, 409);
        }
        logEvent('trust.write.failed');
        return c.json({ error: 'Trust chain is unavailable' }, 503);
      }
      let extras: Array<{ id: string }> = [];
      try {
        const after = await deps.trustStore.listEdgesForSubject(subject.id);
        if (
          after.some(
            (edge) => edge.kind === 'moderator_confirm' || edge.kind === 'moderator_appoint',
          )
        ) {
          await deps.trustStore.deleteEdgeById(created.id);
          return c.json({ error: 'Conflict' }, 409);
        }
        const open = openProposesForSubject(after, subject.id);
        const oldest = oldestOpenPropose(open);
        if (oldest === undefined || oldest.id !== created.id) {
          await deps.trustStore.deleteEdgeById(created.id);
          try {
            const remaining = await deps.trustStore.listEdgesForSubject(subject.id);
            const live = pendingModeratorProposals([subject], remaining)[0];
            await clearModeratorProposalNotifications(deps, subject.id);
            if (live !== undefined) {
              await fanOutPendingProposal(deps, subject, live.id);
            }
          } catch {
            logEvent('push.enqueue.failed');
          }
          return c.json({ error: 'Conflict' }, 409);
        }
        extras = open.filter((row) => row.id !== created.id);
      } catch {
        /* v8 ignore next 5 -- rollback throw still 503 */
        try {
          await deps.trustStore.deleteEdgeById(created.id);
        } catch {
          /* still 503 */
        }
        logEvent('trust.write.failed');
        return c.json({ error: 'Trust chain is unavailable' }, 503);
      }
      for (const extra of extras) {
        try {
          await deps.trustStore.deleteEdgeById(extra.id);
        } catch {
          logEvent('trust.write.failed');
        }
      }
      logEvent('trust.moderator_proposed', { subjectId: subject.id, actorId: caller.id });
      await clearModeratorProposalNotifications(deps, subject.id);
      await notifyStaffProposed(deps, subject, caller);
      await reconcileOpenProposalNotifications(deps, subject, created.id);
      return c.json(accountSummary(subject), 200);
    })
    .post('/confirm-moderator', async (c) => {
      const caller = await authedAccount(deps, c.req.header('authorization'));
      if (caller === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (!isStaffRole(caller.role)) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      const parsed = accountIdBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with an "accountId" string' }, 400);
      }
      if (!MESSAGE_ID_RE.test(parsed.data.accountId)) {
        return c.json({ error: 'Not found' }, 404);
      }
      const loaded = await loadTargetAccount(deps.authStore, parsed.data.accountId);
      if ('status' in loaded) {
        return c.json({ error: loaded.error }, loaded.status);
      }
      const subject = loaded.account;
      if (subject.id === caller.id) {
        return c.json({ error: 'Conflict' }, 409);
      }
      let existing: TrustEdge[];
      try {
        existing = await deps.trustStore.listEdgesForSubject(subject.id);
      } catch {
        logEvent('trust.write.failed');
        return c.json({ error: 'Trust chain is unavailable' }, 503);
      }
      const confirmEdge = existing.find((edge) => edge.kind === 'moderator_confirm');
      if (confirmEdge !== undefined) {
        if (confirmEdge.actorId !== caller.id) {
          return c.json({ error: 'Conflict' }, 409);
        }
        if (sameRoleRank(subject.role, 'moderator')) {
          await clearModeratorProposalNotifications(deps, subject.id);
          await notifySubjectAppointed(deps, subject, caller);
          return c.json(accountSummary(subject), 200);
        }
        if (subject.role !== 'verified') {
          return c.json({ error: 'Conflict' }, 409);
        }
        const updated = { ...subject, role: 'moderator' as const };
        try {
          await deps.authStore.updateAccount(updated);
        } catch {
          logEvent('trust.write.failed');
          return c.json({ error: 'Trust chain is unavailable' }, 503);
        }
        logEvent('trust.moderator_confirmed', { subjectId: subject.id, actorId: caller.id });
        await clearModeratorProposalNotifications(deps, subject.id);
        await notifySubjectAppointed(deps, subject, caller);
        return c.json(accountSummary(updated), 200);
      }
      if (subject.role !== 'verified') {
        return c.json({ error: 'Conflict' }, 409);
      }
      const pending = pendingModeratorProposals([subject], existing)[0];
      if (pending === undefined || pending.proposedBy.id === caller.id) {
        return c.json({ error: 'Conflict' }, 409);
      }
      const created = newEdge(deps, subject.id, caller.id, 'moderator_confirm');
      try {
        await deps.trustStore.insertEdge(created);
      } catch (error) {
        if (isDuplicateTrustEdge(error)) {
          return c.json({ error: 'Conflict' }, 409);
        }
        logEvent('trust.write.failed');
        return c.json({ error: 'Trust chain is unavailable' }, 503);
      }
      try {
        const after = await deps.trustStore.listEdgesForSubject(subject.id);
        const withoutConfirm = after.filter((edge) => edge.id !== created.id);
        const still = pendingModeratorProposals([subject], withoutConfirm)[0];
        const oldest = oldestOpenPropose(openProposesForSubject(withoutConfirm, subject.id));
        if (still === undefined || still.id !== pending.id || oldest?.id !== still.id) {
          await deps.trustStore.deleteEdgeById(created.id);
          return c.json({ error: 'Conflict' }, 409);
        }
      } catch {
        /* v8 ignore next 5 -- rollback throw still 503 */
        try {
          await deps.trustStore.deleteEdgeById(created.id);
        } catch {
          /* still 503 */
        }
        logEvent('trust.write.failed');
        return c.json({ error: 'Trust chain is unavailable' }, 503);
      }
      const updated = { ...subject, role: 'moderator' as const };
      try {
        await deps.authStore.updateAccount(updated);
      } catch {
        logEvent('trust.write.failed');
        return c.json({ error: 'Trust chain is unavailable' }, 503);
      }
      logEvent('trust.moderator_confirmed', { subjectId: subject.id, actorId: caller.id });
      await clearModeratorProposalNotifications(deps, subject.id);
      await notifySubjectAppointed(deps, subject, caller);
      return c.json(accountSummary(updated), 200);
    })
    .post('/reject-moderator', async (c) => {
      const caller = await authedAccount(deps, c.req.header('authorization'));
      if (caller === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (!isStaffRole(caller.role)) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      const parsed = accountIdBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with an "accountId" string' }, 400);
      }
      if (!MESSAGE_ID_RE.test(parsed.data.accountId)) {
        return c.json({ error: 'Not found' }, 404);
      }
      const loaded = await loadTargetAccount(deps.authStore, parsed.data.accountId);
      if ('status' in loaded) {
        return c.json({ error: loaded.error }, loaded.status);
      }
      const subject = loaded.account;
      if (subject.id === caller.id) {
        return c.json({ error: 'Conflict' }, 409);
      }
      if (subject.role !== 'verified') {
        return c.json({ error: 'Conflict' }, 409);
      }
      let existing: TrustEdge[];
      try {
        existing = await deps.trustStore.listEdgesForSubject(subject.id);
      } catch {
        logEvent('trust.write.failed');
        return c.json({ error: 'Trust chain is unavailable' }, 503);
      }
      if (pendingModeratorProposals([subject], existing).length === 0) {
        return c.json({ error: 'Conflict' }, 409);
      }
      const created = newEdge(deps, subject.id, caller.id, 'moderator_reject');
      try {
        await deps.trustStore.insertEdge(created);
      } catch (error) {
        if (isDuplicateTrustEdge(error)) {
          return c.json({ error: 'Conflict' }, 409);
        }
        logEvent('trust.write.failed');
        return c.json({ error: 'Trust chain is unavailable' }, 503);
      }
      let dropNotifications = false;
      let wonEmpty = false;
      try {
        const after = await deps.trustStore.listEdgesForSubject(subject.id);
        if (
          after.some(
            (edge) => edge.kind === 'moderator_confirm' || edge.kind === 'moderator_appoint',
          )
        ) {
          await deps.trustStore.deleteEdgeById(created.id);
          return c.json({ error: 'Conflict' }, 409);
        }
        const still = pendingModeratorProposals([subject], after);
        if (still.length === 0) {
          logEvent('trust.moderator_rejected', { subjectId: subject.id, actorId: caller.id });
          wonEmpty = true;
        } else {
          const beforePending = pendingModeratorProposals([subject], existing)[0];
          const open = still[0];
          if (beforePending !== undefined && open !== undefined && open.id === beforePending.id) {
            await deps.trustStore.deleteEdgeById(created.id);
            return c.json({ error: 'Conflict' }, 409);
          }
          logEvent('trust.moderator_rejected', { subjectId: subject.id, actorId: caller.id });
        }
      } catch {
        /* v8 ignore next 5 -- rollback throw still 503 */
        try {
          await deps.trustStore.deleteEdgeById(created.id);
        } catch {
          /* still 503 */
        }
        logEvent('trust.write.failed');
        return c.json({ error: 'Trust chain is unavailable' }, 503);
      }
      if (wonEmpty) {
        try {
          const latest = await deps.trustStore.listEdgesForSubject(subject.id);
          dropNotifications = pendingModeratorProposals([subject], latest).length === 0;
        } catch {
          logEvent('push.enqueue.failed');
        }
      }
      if (dropNotifications) {
        await clearModeratorProposalNotifications(deps, subject.id);
        try {
          const afterClear = await deps.trustStore.listEdgesForSubject(subject.id);
          const reopened = pendingModeratorProposals([subject], afterClear)[0];
          if (reopened !== undefined) {
            await fanOutPendingProposal(deps, subject, reopened.id);
          }
        } catch {
          logEvent('push.enqueue.failed');
        }
      }
      return c.json(accountSummary(subject), 200);
    })
    .post('/appoint-moderator', async (c) => {
      const caller = await authedAccount(deps, c.req.header('authorization'));
      if (caller === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (!roleAtLeast(caller.role, 'founder')) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      const parsed = accountIdBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with an "accountId" string' }, 400);
      }
      if (!MESSAGE_ID_RE.test(parsed.data.accountId)) {
        return c.json({ error: 'Not found' }, 404);
      }
      const loaded = await loadTargetAccount(deps.authStore, parsed.data.accountId);
      if ('status' in loaded) {
        return c.json({ error: loaded.error }, loaded.status);
      }
      const subject = loaded.account;
      if (subject.id === caller.id || subject.role === 'founder') {
        return c.json({ error: 'Conflict' }, 409);
      }
      let existing: TrustEdge[];
      try {
        existing = await deps.trustStore.listEdgesForSubject(subject.id);
      } catch {
        logEvent('trust.write.failed');
        return c.json({ error: 'Trust chain is unavailable' }, 503);
      }
      const appointEdge = existing.find((edge) => edge.kind === 'moderator_appoint');
      if (appointEdge !== undefined) {
        if (appointEdge.actorId !== caller.id) {
          return c.json({ error: 'Conflict' }, 409);
        }
        if (sameRoleRank(subject.role, 'moderator')) {
          await clearModeratorProposalNotifications(deps, subject.id);
          await notifySubjectAppointed(deps, subject, caller);
          return c.json(accountSummary(subject), 200);
        }
        const updated = { ...subject, role: 'moderator' as const };
        try {
          await deps.authStore.updateAccount(updated);
        } catch {
          logEvent('trust.write.failed');
          return c.json({ error: 'Trust chain is unavailable' }, 503);
        }
        logEvent('trust.moderator_appointed', { subjectId: subject.id, actorId: caller.id });
        await clearModeratorProposalNotifications(deps, subject.id);
        await notifySubjectAppointed(deps, subject, caller);
        return c.json(accountSummary(updated), 200);
      }
      if (sameRoleRank(subject.role, 'moderator')) {
        return c.json({ error: 'Conflict' }, 409);
      }
      const updated = { ...subject, role: 'moderator' as const };
      try {
        await deps.trustStore.insertEdge(newEdge(deps, subject.id, caller.id, 'moderator_appoint'));
        await deps.authStore.updateAccount(updated);
      } catch (error) {
        if (isDuplicateTrustEdge(error)) {
          return c.json({ error: 'Conflict' }, 409);
        }
        logEvent('trust.write.failed');
        return c.json({ error: 'Trust chain is unavailable' }, 503);
      }
      logEvent('trust.moderator_appointed', { subjectId: subject.id, actorId: caller.id });
      await clearModeratorProposalNotifications(deps, subject.id);
      await notifySubjectAppointed(deps, subject, caller);
      return c.json(accountSummary(updated), 200);
    });
}

/** Best-effort drop of open-proposal in-app rows; persist still 200. */
async function clearModeratorProposalNotifications(
  deps: TrustRouteDeps,
  subjectId: string,
): Promise<void> {
  if (deps.notificationStore === undefined) {
    return;
  }
  try {
    await deps.notificationStore.deleteByTypeAndReplyId('moderator_proposal', subjectId);
  } catch {
    logEvent('notifications.hidden.purge_failed');
  }
}

/** Best-effort staff fan-out of an open proposal; persist still 200. */
async function notifyStaffProposed(
  deps: TrustRouteDeps,
  subject: Account,
  actor: { id: string; name: string | null },
): Promise<void> {
  try {
    const recipients = await deps.authStore.listAccounts();
    await notifyModeratorProposed({
      recipients,
      subject: { id: subject.id, name: subject.name },
      actor: { id: actor.id, name: actor.name },
      nowMs: deps.now(),
      ...(deps.notificationStore === undefined ? {} : { notifications: deps.notificationStore }),
      ...(deps.pushStore === undefined ? {} : { pushStore: deps.pushStore }),
      /* v8 ignore next 4 -- createApp always injects conversationStore */
      ...(deps.conversationStore === undefined
        ? {}
        : { inboxUnreadCount: inboxUnreadCountFor(deps.conversationStore, deps.authStore) }),
    });
  } catch {
    logEvent('push.enqueue.failed');
  }
}

/**
 * Best-effort fan-out for one pending propose-edge id. Re-lists before
 * and after notify so a concurrent reject/confirm cannot leave stale
 * `moderator_proposal` rows. A pending-id change at depth 0 (first list
 * or after notify) clears first then fans out once more; a mismatch at
 * depth 1 drops the rows. Throws stay 200 for the caller.
 */
async function fanOutPendingProposal(
  deps: TrustRouteDeps,
  subject: Account,
  proposeId: string,
  depth = 0,
): Promise<void> {
  try {
    const edges = await deps.trustStore.listEdgesForSubject(subject.id);
    const pending = pendingModeratorProposals([subject], edges)[0];
    if (pending === undefined || pending.id !== proposeId) {
      await clearModeratorProposalNotifications(deps, subject.id);
      if (depth === 0 && pending !== undefined) {
        await fanOutPendingProposal(deps, subject, pending.id, 1);
      }
      return;
    }
    const actor = await deps.authStore.getAccount(pending.proposedBy.id);
    await notifyStaffProposed(deps, subject, {
      id: pending.proposedBy.id,
      name: actor === undefined ? null : actor.name,
    });
    const after = await deps.trustStore.listEdgesForSubject(subject.id);
    const now = pendingModeratorProposals([subject], after)[0];
    if (now === undefined) {
      await clearModeratorProposalNotifications(deps, subject.id);
    } else if (now.id !== proposeId) {
      await clearModeratorProposalNotifications(deps, subject.id);
      if (depth === 0) {
        await fanOutPendingProposal(deps, subject, now.id, 1);
      }
    }
  } catch {
    logEvent('push.enqueue.failed');
  }
}

/**
 * After propose notify, drop stale rows when this insert is no longer
 * pending. If a newer propose already reopened, fan out for that actor.
 * Persist is already 200; list/notify throw stays 200.
 */
async function reconcileOpenProposalNotifications(
  deps: TrustRouteDeps,
  subject: Account,
  proposeId: string,
): Promise<void> {
  try {
    const after = await deps.trustStore.listEdgesForSubject(subject.id);
    const pending = pendingModeratorProposals([subject], after)[0];
    if (pending !== undefined && pending.id === proposeId) {
      return;
    }
    await clearModeratorProposalNotifications(deps, subject.id);
    if (pending === undefined) {
      return;
    }
    await fanOutPendingProposal(deps, subject, pending.id);
  } catch {
    logEvent('push.enqueue.failed');
  }
}

/** Best-effort targeted notify of the appointed subject; persist still 200. */
async function notifySubjectAppointed(
  deps: TrustRouteDeps,
  subject: Account,
  caller: Account,
): Promise<void> {
  try {
    await notifyModeratorAppointed({
      subject: { id: subject.id },
      actor: { id: caller.id, name: caller.name },
      nowMs: deps.now(),
      ...(deps.notificationStore === undefined ? {} : { notifications: deps.notificationStore }),
      ...(deps.pushStore === undefined ? {} : { pushStore: deps.pushStore }),
      /* v8 ignore next 4 -- createApp always injects conversationStore */
      ...(deps.conversationStore === undefined
        ? {}
        : { inboxUnreadCount: inboxUnreadCountFor(deps.conversationStore, deps.authStore) }),
    });
  } catch {
    logEvent('push.enqueue.failed');
  }
}

/** Oldest open propose by `createdAt` then `id`, or none. */
function oldestOpenPropose(open: readonly TrustEdge[]): TrustEdge | undefined {
  let oldest: TrustEdge | undefined;
  for (const edge of open) {
    if (
      oldest === undefined ||
      edge.createdAt < oldest.createdAt ||
      (edge.createdAt === oldest.createdAt && edge.id < oldest.id)
    ) {
      oldest = edge;
    }
  }
  return oldest;
}

/** Propose rows after the latest reject for `subjectId`, or all proposes. */
function openProposesForSubject(edges: readonly TrustEdge[], subjectId: string): TrustEdge[] {
  let latestReject: TrustEdge | undefined;
  const proposes: TrustEdge[] = [];
  for (const edge of edges) {
    if (edge.subjectId !== subjectId) {
      continue;
    }
    if (edge.kind === 'moderator_reject') {
      if (
        latestReject === undefined ||
        edge.createdAt > latestReject.createdAt ||
        (edge.createdAt === latestReject.createdAt && edge.id > latestReject.id)
      ) {
        latestReject = edge;
      }
    }
    if (edge.kind === 'moderator_propose') {
      proposes.push(edge);
    }
  }
  if (latestReject === undefined) {
    return proposes;
  }
  const reject = latestReject;
  return proposes.filter((edge) => {
    if (edge.createdAt !== reject.createdAt) {
      return edge.createdAt > reject.createdAt;
    }
    return edge.id > reject.id;
  });
}

/** Fully formed edge using the injected clock and a fresh uuid. */
function newEdge(
  deps: TrustRouteDeps,
  subjectId: string,
  actorId: string,
  kind: TrustKind,
): TrustEdge {
  return {
    id: crypto.randomUUID(),
    subjectId,
    actorId,
    kind,
    createdAt: deps.now(),
  };
}
