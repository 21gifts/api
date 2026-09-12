import { Hono } from 'hono';
import { z } from 'zod';
import { resolveSession } from '@/lib/auth/service';
import type { Account, AuthStore } from '@/lib/auth/store';
import { logEvent } from '@/lib/log';
import { isStaffRole, type TrustEdge, type TrustKind } from '@/lib/trust';
import type { TrustStore } from '@/lib/trust-store';
import { bearerToken } from '@/routes/me';
import { MESSAGE_ID_RE } from '@/routes/messages';

/**
 * Staff trust POSTs: verify a person, propose/confirm a moderator, or
 * appoint a moderator as a founder. Bearer session required.
 */

/** Collaborators the staff trust routes need. */
export interface TrustRouteDeps {
  /** Shared auth persistence port. */
  authStore: AuthStore;
  /** Trust-edge persistence port. */
  trustStore: TrustStore;
  /** Clock returning epoch milliseconds (injected for testability). */
  now: () => number;
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
 * Build the `/trust` route group.
 *
 * Mounted at `/trust` so the public paths are `POST /trust/verify`,
 * `POST /trust/propose-moderator`, `POST /trust/confirm-moderator`, and
 * `POST /trust/appoint-moderator`.
 *
 * @param deps - Auth store, trust-edge store, and clock.
 * @returns A Hono app with the four staff POSTs.
 */
export function trustRoutes(deps: TrustRouteDeps): Hono {
  return new Hono()
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
      const subject = await deps.authStore.getAccount(parsed.data.accountId);
      if (subject === undefined) {
        return c.json({ error: 'Not found' }, 404);
      }
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
      if (subject.role === 'verified' && verifyEdge?.actorId === caller.id) {
        return c.json(accountSummary(subject), 200);
      }
      if (subject.role !== 'basis' || verifyEdge !== undefined) {
        return c.json({ error: 'Conflict' }, 409);
      }
      const updated = { ...subject, role: 'verified' as const };
      try {
        await deps.authStore.updateAccount(updated);
        await deps.trustStore.insertEdge(
          newEdge(deps, subject.id, caller.id, 'verify'),
        );
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
      const subject = await deps.authStore.getAccount(parsed.data.accountId);
      if (subject === undefined) {
        return c.json({ error: 'Not found' }, 404);
      }
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
      const hasStaffGrant = existing.some(
        (edge) =>
          edge.kind === 'moderator_propose' ||
          edge.kind === 'moderator_confirm' ||
          edge.kind === 'moderator_appoint',
      );
      if (hasStaffGrant) {
        return c.json({ error: 'Conflict' }, 409);
      }
      try {
        await deps.trustStore.insertEdge(
          newEdge(deps, subject.id, caller.id, 'moderator_propose'),
        );
      } catch (error) {
        if (isDuplicateTrustEdge(error)) {
          return c.json({ error: 'Conflict' }, 409);
        }
        logEvent('trust.write.failed');
        return c.json({ error: 'Trust chain is unavailable' }, 503);
      }
      logEvent('trust.moderator_proposed', { subjectId: subject.id, actorId: caller.id });
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
      const subject = await deps.authStore.getAccount(parsed.data.accountId);
      if (subject === undefined) {
        return c.json({ error: 'Not found' }, 404);
      }
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
      const propose = existing.find((edge) => edge.kind === 'moderator_propose');
      if (propose === undefined || propose.actorId === caller.id) {
        return c.json({ error: 'Conflict' }, 409);
      }
      const updated = { ...subject, role: 'moderator' as const };
      try {
        await deps.authStore.updateAccount(updated);
        await deps.trustStore.insertEdge(
          newEdge(deps, subject.id, caller.id, 'moderator_confirm'),
        );
      } catch (error) {
        if (isDuplicateTrustEdge(error)) {
          return c.json({ error: 'Conflict' }, 409);
        }
        logEvent('trust.write.failed');
        return c.json({ error: 'Trust chain is unavailable' }, 503);
      }
      logEvent('trust.moderator_confirmed', { subjectId: subject.id, actorId: caller.id });
      return c.json(accountSummary(updated), 200);
    })
    .post('/appoint-moderator', async (c) => {
      const caller = await authedAccount(deps, c.req.header('authorization'));
      if (caller === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (caller.role !== 'founder') {
        return c.json({ error: 'Forbidden' }, 403);
      }
      const parsed = accountIdBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with an "accountId" string' }, 400);
      }
      if (!MESSAGE_ID_RE.test(parsed.data.accountId)) {
        return c.json({ error: 'Not found' }, 404);
      }
      const subject = await deps.authStore.getAccount(parsed.data.accountId);
      if (subject === undefined) {
        return c.json({ error: 'Not found' }, 404);
      }
      if (
        subject.id === caller.id ||
        subject.role === 'founder' ||
        subject.role === 'moderator'
      ) {
        return c.json({ error: 'Conflict' }, 409);
      }
      const updated = { ...subject, role: 'moderator' as const };
      try {
        await deps.authStore.updateAccount(updated);
        await deps.trustStore.insertEdge(
          newEdge(deps, subject.id, caller.id, 'moderator_appoint'),
        );
      } catch (error) {
        if (isDuplicateTrustEdge(error)) {
          return c.json({ error: 'Conflict' }, 409);
        }
        logEvent('trust.write.failed');
        return c.json({ error: 'Trust chain is unavailable' }, 503);
      }
      logEvent('trust.moderator_appointed', { subjectId: subject.id, actorId: caller.id });
      return c.json(accountSummary(updated), 200);
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
