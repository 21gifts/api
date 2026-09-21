import { Hono } from 'hono';
import { z } from 'zod';
import { roleAtLeast } from '@/lib/auth/roles';
import { resolveSession } from '@/lib/auth/service';
import type { Account, AuthStore } from '@/lib/auth/store';
import { inboxUnreadCountFor } from '@/lib/conversation-push';
import type { ConversationStore } from '@/lib/conversation-store';
import { logEvent } from '@/lib/log';
import { notifyModeratorAppointed, notifyModeratorProposed } from '@/lib/notification';
import type { NotificationStore } from '@/lib/notification-store';
import type { PushStore } from '@/lib/push-store';
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
  /** Optional conversation store so appointed push unreadCount includes inbox. */
  conversationStore?: ConversationStore;
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
      try {
        for (;;) {
          const after = await deps.trustStore.listEdgesForSubject(subject.id);
          const open = openProposesForSubject(after, subject.id);
          const oldest = oldestOpenPropose(open);
          if (oldest === undefined || oldest.id !== created.id) {
            await deleteMatchingPropose(deps.trustStore, subject.id, created.id);
            return c.json({ error: 'Conflict' }, 409);
          }
          if (open.length <= 1) {
            break;
          }
          await deps.trustStore.deleteEdge(subject.id, 'moderator_propose');
        }
      } catch {
        logEvent('trust.write.failed');
        return c.json({ error: 'Trust chain is unavailable' }, 503);
      }
      logEvent('trust.moderator_proposed', { subjectId: subject.id, actorId: caller.id });
      await notifyStaffProposed(deps, subject, caller);
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
        if (subject.role === 'moderator') {
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
        if (openProposesForSubject(after, subject.id).length === 0) {
          await deps.trustStore.deleteEdge(subject.id, 'moderator_confirm');
          return c.json({ error: 'Conflict' }, 409);
        }
      } catch {
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
      try {
        await deps.trustStore.insertEdge(newEdge(deps, subject.id, caller.id, 'moderator_reject'));
      } catch (error) {
        if (isDuplicateTrustEdge(error)) {
          return c.json({ error: 'Conflict' }, 409);
        }
        logEvent('trust.write.failed');
        return c.json({ error: 'Trust chain is unavailable' }, 503);
      }
      try {
        const after = await deps.trustStore.listEdgesForSubject(subject.id);
        if (
          after.some(
            (edge) => edge.kind === 'moderator_confirm' || edge.kind === 'moderator_appoint',
          )
        ) {
          await deps.trustStore.deleteEdge(subject.id, 'moderator_reject');
          return c.json({ error: 'Conflict' }, 409);
        }
      } catch {
        logEvent('trust.write.failed');
        return c.json({ error: 'Trust chain is unavailable' }, 503);
      }
      logEvent('trust.moderator_rejected', { subjectId: subject.id, actorId: caller.id });
      await clearModeratorProposalNotifications(deps, subject.id);
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
        if (subject.role === 'moderator') {
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
      if (subject.role === 'moderator') {
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
  caller: Account,
): Promise<void> {
  try {
    const recipients = await deps.authStore.listAccounts();
    await notifyModeratorProposed({
      recipients,
      subject: { id: subject.id, name: subject.name },
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

/** Delete propose rows newest-first until `id` is gone or none remain. */
async function deleteMatchingPropose(
  store: TrustStore,
  subjectId: string,
  id: string,
): Promise<void> {
  for (;;) {
    const removed = await store.deleteEdge(subjectId, 'moderator_propose');
    if (removed === undefined || removed.id === id) {
      return;
    }
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
