import { Hono } from 'hono';
import { z } from 'zod';
import { resolveSession } from '@/lib/auth/service';
import type { Account, AuthStore } from '@/lib/auth/store';
import {
  effectiveStatus,
  serializeOwnerFunding,
  utcDayKey,
  type FundingGrant,
  type OwnerFundingJson,
} from '@/lib/funding';
import { loadGrantEffective, type FundingStore } from '@/lib/funding-store';
import { logEvent } from '@/lib/log';
import { MESSAGE_LIST_LIMIT, serializeMessage, type MessageRow } from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import { roleAtLeast } from '@/lib/auth/roles';
import { isStaffRole } from '@/lib/trust';
import { forumVideoFilePresent, resolveMediaDir } from '@/lib/video';
import { bearerToken } from '@/routes/me';
import { MESSAGE_ID_RE } from '@/routes/messages';

/**
 * Member apply and staff review for funding-program grants.
 * Bearer session required. Independent of `account.role` except `basis`
 * cannot apply or be granted.
 */

/** Collaborators the funding routes need. */
export interface FundingRouteDeps {
  /** Shared auth persistence port. */
  authStore: AuthStore;
  /** Funding-grant persistence port. */
  fundingStore: FundingStore;
  /** Forum persistence for staff application detail. */
  messageStore: MessageStore;
  /** Clock returning epoch milliseconds (injected for testability). */
  now: () => number;
}

/** Body schema for staff POSTs that target one account. */
const accountIdBody = z.object({ accountId: z.string() });

/** Resolve the account behind a request's bearer session, or `null`. */
async function authedAccount(
  deps: FundingRouteDeps,
  header: string | undefined,
): Promise<Account | null> {
  const token = bearerToken(header);
  if (token === null) {
    return null;
  }
  return resolveSession(deps.authStore, deps.now(), token);
}

/** `{ id, name, role, funding }` for a successful staff write. */
function decisionBody(
  account: Account,
  grant: FundingGrant,
  nowMs: number,
  reviewerName: string | null,
): {
  id: string;
  name: string | null;
  role: Account['role'];
  funding: OwnerFundingJson | null;
} {
  return {
    id: account.id,
    name: account.name,
    role: account.role,
    funding: serializeOwnerFunding(account.role, grant, nowMs, reviewerName),
  };
}

/**
 * Load a target account. Missing → 404. Postgres/query throw → 503.
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
    logEvent('funding.write.failed');
    return { error: 'Funding is unavailable', status: 503 };
  }
}

/**
 * Delete a `hasVideo` row whose file is missing or empty. Notes without
 * video are unchanged. Same drop as member posts.
 *
 * @param store - Message store.
 * @param row - Store row.
 * @returns The row, or `null` when it was deleted.
 */
async function dropMissingVideoRow(
  store: MessageStore,
  row: MessageRow,
): Promise<MessageRow | null> {
  if (
    row.hasVideo !== true ||
    row.videoContentType === undefined ||
    row.videoContentType === null
  ) {
    return row;
  }
  const present = await forumVideoFilePresent(resolveMediaDir(), row.id, row.videoContentType);
  if (present) {
    return row;
  }
  await store.deleteById(row.id);
  logEvent('messages.video.dropped');
  return null;
}

/** Staff session or a 401/403 JSON response. */
async function requireStaff(
  deps: FundingRouteDeps,
  header: string | undefined,
): Promise<{ caller: Account } | { error: string; status: 401 | 403 }> {
  const caller = await authedAccount(deps, header);
  if (caller === null) {
    return { error: 'Unauthorized', status: 401 };
  }
  if (!isStaffRole(caller.role)) {
    return { error: 'Forbidden', status: 403 };
  }
  return { caller };
}

/** Parse `{ accountId }` or a 400/404. */
function parseAccountId(
  raw: unknown,
): { accountId: string } | { error: string; status: 400 | 404 } {
  const parsed = accountIdBody.safeParse(raw);
  if (!parsed.success) {
    return { error: 'Expected a JSON body with an "accountId" string', status: 400 };
  }
  if (!MESSAGE_ID_RE.test(parsed.data.accountId)) {
    return { error: 'Not found', status: 404 };
  }
  return { accountId: parsed.data.accountId };
}

/**
 * Build the `/funding` route group.
 *
 * Mounted at `/funding` so the public paths are `POST /funding/apply`,
 * `GET /funding/applications`, `GET /funding/applications/:accountId`,
 * `POST /funding/trial`, `POST /funding/admit`, and `POST /funding/reject`.
 *
 * @param deps - Auth store, funding store, message store, and clock.
 * @returns A Hono app with member apply and staff review routes.
 */
export function fundingRoutes(deps: FundingRouteDeps): Hono {
  return new Hono()
    .post('/apply', async (c) => {
      const caller = await authedAccount(deps, c.req.header('authorization'));
      if (caller === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (!roleAtLeast(caller.role, 'verified')) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      const nowMs = deps.now();
      try {
        const observed = await loadGrantEffective(deps.fundingStore, caller.id, nowMs);
        const status = effectiveStatus(observed, nowMs);
        if (status === 'pending' || status === 'trial' || status === 'admitted') {
          return c.json({ error: 'Conflict' }, 409);
        }
        const grant = await deps.fundingStore.transition(
          {
            accountId: caller.id,
            status: 'pending',
            appliedAt: nowMs,
            decidedAt: null,
            decidedBy: null,
            trialUtcDate: null,
            admittedAt: null,
            note: null,
          },
          ['none', 'rejected'],
        );
        if (grant === undefined) {
          return c.json({ error: 'Conflict' }, 409);
        }
        logEvent('funding.applied', { accountId: caller.id });
        return c.json({ funding: serializeOwnerFunding(caller.role, grant, nowMs, null) }, 200);
      } catch {
        logEvent('funding.write.failed');
        return c.json({ error: 'Funding is unavailable' }, 503);
      }
    })
    .get('/applications', async (c) => {
      const staff = await requireStaff(deps, c.req.header('authorization'));
      if ('status' in staff) {
        return c.json({ error: staff.error }, staff.status);
      }
      const nowMs = deps.now();
      try {
        const grants = await deps.fundingStore.listGrants();
        const applications: Array<{
          accountId: string;
          name: string | null;
          role: Account['role'];
          appliedAt: number;
        }> = [];
        for (const stored of grants) {
          const grant = await loadGrantEffective(deps.fundingStore, stored.accountId, nowMs);
          if (grant === undefined || effectiveStatus(grant, nowMs) !== 'pending') {
            continue;
          }
          const account = await deps.authStore.getAccount(grant.accountId);
          if (account === undefined) {
            continue;
          }
          applications.push({
            accountId: account.id,
            name: account.name,
            role: account.role,
            appliedAt: grant.appliedAt,
          });
        }
        logEvent('funding.applications.listed', { count: applications.length });
        return c.json({ applications }, 200);
      } catch {
        logEvent('funding.list.failed');
        return c.json({ error: 'Funding is unavailable' }, 503);
      }
    })
    .get('/applications/:accountId', async (c) => {
      const staff = await requireStaff(deps, c.req.header('authorization'));
      if ('status' in staff) {
        return c.json({ error: staff.error }, staff.status);
      }
      const accountId = c.req.param('accountId');
      if (accountId === undefined || !MESSAGE_ID_RE.test(accountId)) {
        return c.json({ error: 'Not found' }, 404);
      }
      const nowMs = deps.now();
      try {
        const account = await deps.authStore.getAccount(accountId);
        const grant = await loadGrantEffective(deps.fundingStore, accountId, nowMs);
        if (account === undefined || grant === undefined) {
          return c.json({ error: 'Not found' }, 404);
        }
        const rows = await deps.messageStore.listPostsByAccount(account.id, MESSAGE_LIST_LIMIT);
        const messages = [];
        for (const row of rows) {
          const kept = await dropMissingVideoRow(deps.messageStore, row);
          if (kept === null) {
            continue;
          }
          const children = await deps.messageStore.listReplies(kept.id, MESSAGE_LIST_LIMIT);
          let dropped = 0;
          for (const child of children) {
            const keptChild = await dropMissingVideoRow(deps.messageStore, child);
            if (keptChild === null) {
              dropped += 1;
            }
          }
          const payable =
            kept.eventId !== null &&
            kept.eventId !== '' &&
            account.lightningAddress !== null &&
            account.lightningAddress.trim() !== '';
          messages.push(
            serializeMessage(
              kept,
              payable,
              account.role,
              Math.max(0, row.replyCount - dropped),
              true,
            ),
          );
        }
        return c.json(
          {
            account: {
              id: account.id,
              name: account.name,
              role: account.role,
              lightningAddress: account.lightningAddress,
            },
            grant: {
              status: effectiveStatus(grant, nowMs),
              appliedAt: grant.appliedAt,
              trialUtcDate: grant.trialUtcDate,
              admittedAt: grant.admittedAt,
              decidedAt: grant.decidedAt,
            },
            messages,
          },
          200,
        );
      } catch {
        logEvent('funding.list.failed');
        return c.json({ error: 'Funding is unavailable' }, 503);
      }
    })
    .post('/trial', async (c) => {
      const staff = await requireStaff(deps, c.req.header('authorization'));
      if ('status' in staff) {
        return c.json({ error: staff.error }, staff.status);
      }
      const parsed = parseAccountId(await c.req.json().catch(() => null));
      if ('status' in parsed) {
        return c.json({ error: parsed.error }, parsed.status);
      }
      const loaded = await loadTargetAccount(deps.authStore, parsed.accountId);
      if ('status' in loaded) {
        return c.json({ error: loaded.error }, loaded.status);
      }
      const subject = loaded.account;
      if (subject.id === staff.caller.id) {
        return c.json({ error: 'Conflict' }, 409);
      }
      if (subject.role === 'basis') {
        return c.json({ error: 'Conflict' }, 409);
      }
      const nowMs = deps.now();
      try {
        const observed = await loadGrantEffective(deps.fundingStore, subject.id, nowMs);
        if (observed === undefined || effectiveStatus(observed, nowMs) !== 'pending') {
          return c.json({ error: 'Conflict' }, 409);
        }
        const appliedAt = observed.appliedAt;
        const grant = await deps.fundingStore.transition(
          {
            accountId: subject.id,
            status: 'trial',
            appliedAt,
            decidedAt: nowMs,
            decidedBy: staff.caller.id,
            trialUtcDate: utcDayKey(nowMs),
            admittedAt: null,
            note: observed.note,
          },
          ['pending'],
        );
        if (grant === undefined) {
          return c.json({ error: 'Conflict' }, 409);
        }
        logEvent('funding.trial', { accountId: subject.id, actorId: staff.caller.id });
        return c.json(decisionBody(subject, grant, nowMs, staff.caller.name), 200);
      } catch {
        logEvent('funding.write.failed');
        return c.json({ error: 'Funding is unavailable' }, 503);
      }
    })
    .post('/admit', async (c) => {
      const staff = await requireStaff(deps, c.req.header('authorization'));
      if ('status' in staff) {
        return c.json({ error: staff.error }, staff.status);
      }
      const parsed = parseAccountId(await c.req.json().catch(() => null));
      if ('status' in parsed) {
        return c.json({ error: parsed.error }, parsed.status);
      }
      const loaded = await loadTargetAccount(deps.authStore, parsed.accountId);
      if ('status' in loaded) {
        return c.json({ error: loaded.error }, loaded.status);
      }
      const subject = loaded.account;
      if (subject.id === staff.caller.id) {
        return c.json({ error: 'Conflict' }, 409);
      }
      if (subject.role === 'basis') {
        return c.json({ error: 'Conflict' }, 409);
      }
      const nowMs = deps.now();
      try {
        const observed = await loadGrantEffective(deps.fundingStore, subject.id, nowMs);
        const status = effectiveStatus(observed, nowMs);
        if (observed === undefined || (status !== 'pending' && status !== 'trial')) {
          return c.json({ error: 'Conflict' }, 409);
        }
        const appliedAt = observed.appliedAt;
        const grant = await deps.fundingStore.transition(
          {
            accountId: subject.id,
            status: 'admitted',
            appliedAt,
            decidedAt: nowMs,
            decidedBy: staff.caller.id,
            trialUtcDate: null,
            admittedAt: nowMs,
            note: observed.note,
          },
          ['pending', 'trial'],
        );
        if (grant === undefined) {
          return c.json({ error: 'Conflict' }, 409);
        }
        logEvent('funding.admitted', { accountId: subject.id, actorId: staff.caller.id });
        return c.json(decisionBody(subject, grant, nowMs, staff.caller.name), 200);
      } catch {
        logEvent('funding.write.failed');
        return c.json({ error: 'Funding is unavailable' }, 503);
      }
    })
    .post('/reject', async (c) => {
      const staff = await requireStaff(deps, c.req.header('authorization'));
      if ('status' in staff) {
        return c.json({ error: staff.error }, staff.status);
      }
      const parsed = parseAccountId(await c.req.json().catch(() => null));
      if ('status' in parsed) {
        return c.json({ error: parsed.error }, parsed.status);
      }
      const loaded = await loadTargetAccount(deps.authStore, parsed.accountId);
      if ('status' in loaded) {
        return c.json({ error: loaded.error }, loaded.status);
      }
      const subject = loaded.account;
      if (subject.id === staff.caller.id) {
        return c.json({ error: 'Conflict' }, 409);
      }
      const nowMs = deps.now();
      try {
        const observed = await loadGrantEffective(deps.fundingStore, subject.id, nowMs);
        const status = effectiveStatus(observed, nowMs);
        if (observed === undefined || (status !== 'pending' && status !== 'trial')) {
          return c.json({ error: 'Conflict' }, 409);
        }
        const appliedAt = observed.appliedAt;
        const grant = await deps.fundingStore.transition(
          {
            accountId: subject.id,
            status: 'rejected',
            appliedAt,
            decidedAt: nowMs,
            decidedBy: staff.caller.id,
            trialUtcDate: null,
            admittedAt: null,
            note: observed.note,
          },
          ['pending', 'trial'],
        );
        if (grant === undefined) {
          return c.json({ error: 'Conflict' }, 409);
        }
        logEvent('funding.rejected', { accountId: subject.id, actorId: staff.caller.id });
        return c.json(decisionBody(subject, grant, nowMs, staff.caller.name), 200);
      } catch {
        logEvent('funding.write.failed');
        return c.json({ error: 'Funding is unavailable' }, 503);
      }
    });
}
