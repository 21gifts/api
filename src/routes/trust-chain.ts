import { Hono } from 'hono';
import { resolveSession } from '@/lib/auth/service';
import type { Account, AuthStore } from '@/lib/auth/store';
import { logEvent } from '@/lib/log';
import { buildTrustChain, isChainAccount, isProjectedTrustEdge, type TrustEdge } from '@/lib/trust';
import type { TrustStore } from '@/lib/trust-store';
import { bearerToken } from '@/routes/me';

/**
 * Trust-chain graph. Bearer session required (any role). Nodes and edges
 * come from stored accounts and trust edges only — never inferred.
 *
 * Bare `GET /trust-chain` returns founder seeds (no edges) so a thousand-person
 * chain is not dumped on first paint. `?around=<id>` returns that account plus
 * one hop of the winning public kind per subject (`moderator_propose` when the
 * subject is a `moderator`, else `verify`, else `moderator_appoint`).
 * `moderator_confirm` is never projected. Neighborhood loads all edges for
 * each subject in the touching set so a verify that does not touch `aroundId`
 * still beats an appoint that does. A pending propose (subject still
 * `verified`) stays private and is not a hop neighbor.
 */

/** Collaborators the trust-chain route needs. */
export interface TrustChainRouteDeps {
  /** Shared auth persistence port. */
  authStore: AuthStore;
  /** Trust-edge persistence port. */
  trustStore: TrustStore;
  /** Clock returning epoch milliseconds (injected for testability). */
  now: () => number;
}

/** Resolve the account behind a request's bearer session, or `null`. */
async function authedAccount(
  deps: TrustChainRouteDeps,
  header: string | undefined,
): Promise<Account | null> {
  const token = bearerToken(header);
  if (token === null) {
    return null;
  }
  return resolveSession(deps.authStore, deps.now(), token);
}

/**
 * Build the `/trust-chain` route group.
 *
 * Mounted at `/trust-chain` so the path is `GET /trust-chain`. Requires a
 * member Bearer session; missing or invalid Bearer is 401.
 *
 * @param deps - Auth store, trust-edge store, and clock.
 * @returns A Hono app with `GET /`.
 */
export function trustChainRoutes(deps: TrustChainRouteDeps): Hono {
  return new Hono().get('/', async (c) => {
    const caller = await authedAccount(deps, c.req.header('authorization'));
    if (caller === null) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    try {
      const around = c.req.query('around');
      if (around !== undefined && around !== '') {
        return c.json(await neighborhood(deps, around), 200);
      }
      const accounts = (await deps.authStore.listAccounts()).filter(
        (account) => account.role === 'founder',
      );
      return c.json(buildTrustChain(accounts, []), 200);
    } catch (error) {
      if (error instanceof NeighborhoodNotFound) {
        return c.json({ error: 'Not found' }, 404);
      }
      logEvent('trust.chain.failed');
      return c.json({ error: 'Trust chain is unavailable' }, 503);
    }
  });
}

/** Focus account is missing or not on the public chain. */
class NeighborhoodNotFound extends Error {}

/** Postgres `22P02` when `around` is not a uuid (memory stores do not throw). */
function isInvalidUuid(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === '22P02'
  );
}

/**
 * One hop around `aroundId`: the focus account, stored public edges of the
 * winning kind per subject after `isProjectedTrustEdge` (`moderator_propose`
 * when the subject is a `moderator`, else `verify`, else
 * `moderator_appoint`; never `moderator_confirm`), and the accounts on those
 * filtered edges. Loads all edges for each touching subject
 * (`listEdgesForSubject`) so a non-touching verify still beats a touching
 * appoint. Pending-propose verified neighbors are not nodes. Confirm never.
 *
 * @param deps - Auth and trust stores.
 * @param aroundId - Focus account id.
 * @returns Public `{ nodes, edges }`.
 */
async function neighborhood(
  deps: TrustChainRouteDeps,
  aroundId: string,
): Promise<ReturnType<typeof buildTrustChain>> {
  let focus: Account | undefined;
  try {
    focus = await deps.authStore.getAccount(aroundId);
  } catch (error) {
    if (isInvalidUuid(error)) {
      throw new NeighborhoodNotFound();
    }
    throw error;
  }
  if (focus === undefined || !isChainAccount(focus)) {
    throw new NeighborhoodNotFound();
  }
  const touching = await deps.trustStore.listEdgesTouching(aroundId);
  const candidateIds = new Set<string>([aroundId]);
  for (const edge of touching) {
    candidateIds.add(edge.actorId);
    candidateIds.add(edge.subjectId);
  }
  const byId = new Map<string, Account>();
  for (const id of candidateIds) {
    const account = await deps.authStore.getAccount(id);
    if (account !== undefined) {
      byId.set(id, account);
    }
  }
  const subjectIds = new Set<string>([aroundId]);
  for (const edge of touching) {
    subjectIds.add(edge.subjectId);
  }
  const siblingsBySubject = new Map<string, TrustEdge[]>();
  await Promise.all(
    [...subjectIds].map(async (subjectId) => {
      siblingsBySubject.set(subjectId, await deps.trustStore.listEdgesForSubject(subjectId));
    }),
  );
  const edges = touching.filter((edge) => {
    const siblings = siblingsBySubject.get(edge.subjectId);
    /* v8 ignore next 3 -- Promise.all set a list for every touching subjectId */
    if (siblings === undefined) {
      return false;
    }
    return isProjectedTrustEdge(edge, byId.get(edge.subjectId), siblings);
  });
  const ids = new Set<string>([aroundId]);
  for (const edge of edges) {
    ids.add(edge.actorId);
    ids.add(edge.subjectId);
  }
  const accounts: Account[] = [];
  for (const id of ids) {
    const account = byId.get(id);
    if (account !== undefined) {
      accounts.push(account);
    }
  }
  return buildTrustChain(accounts, edges);
}
