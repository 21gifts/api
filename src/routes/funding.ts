import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { serializeOwnerAccountWithPosts } from '@/lib/auth/account-json';
import { resolveSession } from '@/lib/auth/service';
import { staffTagOf, type Account, type AuthStore } from '@/lib/auth/store';
import {
  applicationPauseExempt,
  effectiveStatus,
  serializeOwnerFunding,
  utcDayKey,
  type FundingGrant,
  type OwnerFundingJson,
} from '@/lib/funding';
import { loadGrantEffective, type FundingStore } from '@/lib/funding-store';
import { buildFundingPayoutMatrix } from '@/lib/funding-payouts';
import type { GiftStore } from '@/lib/gift-store';
import { logEvent } from '@/lib/log';
import { MESSAGE_LIST_LIMIT, serializeMessage, type MessageRow } from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import type { SpendGrantStatus } from '@/lib/spend-instruction';
import type { SpendPing } from '@/lib/spend-ping';
import { canEditDailyPayoutRoster, roleAtLeast } from '@/lib/auth/roles';
import type { LnurlServerConfig } from '@/lib/config';
import {
  DAILY_ROSTER_INVALID_ADDRESS,
  DAILY_ROSTER_INVALID_COMMENT,
  DAILY_ROSTER_INVALID_PAYMENTS,
  DAILY_ROSTER_INVALID_PERSON,
  DAILY_ROSTER_NO_LIGHTNING,
  DAILY_ROSTER_UNAVAILABLE,
  DAILY_ROSTER_UNKNOWN_ADDRESS,
  DAILY_ROSTER_UNKNOWN_PERSON,
  DailyRosterRequestError,
  normalizeDailyRosterComment,
  withRecipientIdentities,
  type DailyRoster,
  type DailyRosterDocument,
  type DailyRosterPublic,
} from '@/lib/daily-roster';
import {
  DAILY_ROSTER_DEFAULT_AMOUNT_USD,
  InMemoryDailyRosterStore,
  type DailyRosterStore,
} from '@/lib/daily-roster-store';
import { checkSpendAuth } from '@/lib/spend-auth';
import { accountByReceivingAddress, receivingAddress } from '@/lib/receiving-address';
import { isStaffRole } from '@/lib/trust';
import { forumVideoFilePresent, resolveMediaDir } from '@/lib/video';
import { bearerToken } from '@/routes/me';
import { MESSAGE_ID_RE } from '@/routes/messages';

/**
 * Member apply (paused: 403, no write, except joey-rosima, vincent, and
 * jewel-bacolbas), staff review, and the initiator/founder daily payout roster.
 * Bearer session required. Grant routes are independent of `account.role`
 * except `basis` cannot apply or be granted. Roster routes use
 * {@link canEditDailyPayoutRoster} (initiator or founder only).
 */

/** Collaborators the funding routes need. */
export interface FundingRouteDeps {
  /** Shared auth persistence port. */
  authStore: AuthStore;
  /** Funding-grant persistence port. */
  fundingStore: FundingStore;
  /** Forum persistence for staff application detail. */
  messageStore: MessageStore;
  /** LNURL server; omitted when off. A verified wallet makes an applicant's notes payable. */
  lnurlServer?: LnurlServerConfig;
  /** Clock returning epoch milliseconds (injected for testability). */
  now: () => number;
  /** Optional spend ping. Omitted → skip the daily post ping after trial/admit. */
  spendPing?: SpendPing;
  /**
   * Daily payout roster. Omitted → a fresh in-memory store.
   */
  rosterStore?: DailyRosterStore;
  /**
   * Spend-worker shared secret for the full-document roster routes and the
   * worker write routes. Unset → those routes return 503 like the invoices.
   */
  spendApiToken?: string;
  /** Outbound gifts. Daily rows mark a payout day collected. */
  gifts: GiftStore;
  /**
   * When omitted or true, new applications are paused except joey-rosima,
   * vincent, and jewel-bacolbas. Pass false to run the stored apply walk
   * for every caller.
   */
  applicationsPaused?: boolean;
}

/** Body schema for staff POSTs that target one account. */
const accountIdBody = z.object({ accountId: z.string() });

/** Body schema for `POST /funding/daily-roster/comment`. */
const rosterCommentBody = z.object({ comment: z.string() });

/** Body schema for `POST /funding/daily-roster/payments`. */
const rosterPaymentsBody = z.object({ enabled: z.boolean() });

/** Body schema for `POST /funding/daily-roster/recipients`. */
const rosterRecipientAddBody = z.object({
  accountId: z.string(),
  amountUsd: z.number().finite(),
});

/** Body schema for recipient update. */
const rosterRecipientBody = z.object({
  address: z.string(),
  amountUsd: z.number().finite(),
});

/** Body schema for `POST /funding/daily-roster/recipients/delete`. */
const rosterDeleteBody = z.object({ address: z.string() });

/**
 * True when a JSON value has a string `address`. Update uses this so a bad
 * amount is `Invalid address or amount` and a missing address is
 * `Unknown address`, matching spend.
 *
 * @param raw - Parsed JSON, or `null` when the body was not JSON.
 * @returns Whether `address` is a string.
 */
function rawAddressIsString(raw: unknown): boolean {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    !Array.isArray(raw) &&
    typeof (raw as Record<string, unknown>)['address'] === 'string'
  );
}

/** Logged roster action. Never a comment or a Lightning address. */
type DailyRosterAction =
  'read' | 'comment' | 'payments' | 'recipient-add' | 'recipient-update' | 'recipient-delete';

type RosterStop = { error: string; status: 401 | 403 };

type RosterReply =
  { status: 200; body: DailyRosterPublic } | { status: 400 | 502; body: { error: string } };

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
    funding: serializeOwnerFunding(account.role, grant, nowMs, reviewerName, account.id),
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
 * Daily spend ping for the newest live top-level photo or video posted
 * today UTC. No-op when spend ping is omitted, the address is blank, or
 * there is no such post. Lookup and ping failures are logged and swallowed.
 *
 * @param deps - Route collaborators.
 * @param account - Subject after the grant write.
 * @param nowMs - Grant decision clock.
 * @param grantStatus - Effective grant status after the write.
 */
async function pingTodayMedia(
  deps: FundingRouteDeps,
  account: Account,
  nowMs: number,
  grantStatus: SpendGrantStatus,
): Promise<void> {
  if (deps.spendPing === undefined) {
    return;
  }
  const address = receivingAddress(account, deps.lnurlServer)?.address ?? null;
  if (address === null) {
    return;
  }
  try {
    const id = await deps.messageStore.latestLiveTopLevelMediaId(account.id);
    if (id === null) {
      return;
    }
    const row = await deps.messageStore.getById(id);
    if (row === undefined) {
      return;
    }
    if (utcDayKey(row.createdAt.getTime()) !== utcDayKey(nowMs)) {
      return;
    }
    await deps.spendPing.ping(address, id, 'daily', grantStatus);
  } catch {
    logEvent('funding.daily_ping.failed', { accountId: account.id });
  }
}

/**
 * Bearer session, then {@link canEditDailyPayoutRoster}.
 * A moderator is 403 and never 503.
 *
 * @param deps - Route collaborators.
 * @param header - Raw `Authorization` header.
 * @returns The caller, or a 401/403 JSON error.
 */
async function openDailyRoster(
  deps: FundingRouteDeps,
  header: string | undefined,
): Promise<{ caller: Account } | RosterStop> {
  const caller = await authedAccount(deps, header);
  if (caller === null) {
    return { error: 'Unauthorized', status: 401 };
  }
  if (!canEditDailyPayoutRoster(caller.role)) {
    return { error: 'Forbidden', status: 403 };
  }
  return { caller };
}

/**
 * Public daily list from the stored document. Moderators stay off this shape.
 *
 * @param doc - Full stored document.
 * @returns Recipients-only roster for {@link withRecipientIdentities}.
 */
function publicDailyRoster(doc: DailyRosterDocument): DailyRoster {
  return {
    comment: doc.comment,
    paymentsEnabled: doc.paymentsEnabled,
    defaultAmountUsd: DAILY_ROSTER_DEFAULT_AMOUNT_USD,
    recipients: doc.recipients,
  };
}

/**
 * Map {@link checkSpendAuth} to a Hono JSON response, or `null` when ok.
 *
 * @param status - Auth check result.
 * @param json - Hono `c.json` bound to the request.
 * @returns 503/401 response, or `null` to continue.
 */
function spendAuthGate(
  status: ReturnType<typeof checkSpendAuth>,
  json: (body: { error: string }, status: 401 | 503) => Response,
): Response | null {
  if (status === 'unconfigured') {
    return json({ error: 'Spend invoices are not configured' }, 503);
  }
  if (status === 'unauthorized') {
    return json({ error: 'Unauthorized' }, 401);
  }
  return null;
}

/**
 * Spend Bearer then the stored document. Store 400 stays `{ error }`.
 *
 * @param c - Hono context.
 * @param token - Configured spend token, or unset.
 * @param call - Store read or write.
 * @returns 200 document, 401/503 from {@link spendAuthGate}, 400, or 502.
 */
async function answerSpendDocument(
  c: Context,
  token: string | undefined,
  call: () => Promise<DailyRosterDocument>,
): Promise<Response> {
  const denied = spendAuthGate(
    checkSpendAuth(token, c.req.header('Authorization')),
    (body, status) => c.json(body, status),
  );
  if (denied !== null) {
    return denied;
  }
  try {
    return c.json(await call(), 200);
  } catch (err) {
    if (err instanceof DailyRosterRequestError && err.status === 400) {
      return c.json({ error: err.error }, 400);
    }
    return c.json({ error: DAILY_ROSTER_UNAVAILABLE }, 502);
  }
}

/**
 * Call spend and map failures. Success and 502 log the actor id and action only.
 *
 * @param deps - Route collaborators (auth store and LNURL server for recipient identity).
 * @param caller - Initiator or founder.
 * @param action - Stable action name.
 * @param call - Client method.
 * @returns 200 public roster, 400 forwarded change, or 502 unavailable.
 */
async function callRoster(
  deps: FundingRouteDeps,
  caller: Account,
  action: DailyRosterAction,
  call: () => Promise<DailyRosterDocument>,
): Promise<RosterReply> {
  try {
    const roster = publicDailyRoster(await call());
    const body = await withRecipientIdentities(roster, async (address) => {
      const found = await accountByReceivingAddress(deps.authStore, address, deps.lnurlServer);
      if (found === undefined) {
        return undefined;
      }
      return { id: found.account.id, name: found.account.name };
    });
    logEvent('funding.daily_roster', { accountId: caller.id, action });
    return { status: 200, body };
  } catch (err) {
    if (err instanceof DailyRosterRequestError && err.status === 400) {
      return { status: 400, body: { error: err.error } };
    }
    logEvent('funding.daily_roster.failed', { accountId: caller.id, action });
    const error = err instanceof DailyRosterRequestError ? err.error : DAILY_ROSTER_UNAVAILABLE;
    return { status: 502, body: { error } };
  }
}

/**
 * @param c - Hono context.
 * @param result - Roster call outcome.
 * @returns The JSON response.
 */
function answerRoster(c: Context, result: RosterReply): Response {
  if (result.status === 200) {
    return c.json(result.body, 200);
  }
  return c.json(result.body, result.status);
}

/**
 * @param c - Hono context.
 * @param stop - Auth or configuration failure.
 * @returns The JSON response.
 */
function stopRoster(c: Context, stop: RosterStop): Response {
  return c.json({ error: stop.error }, stop.status);
}

/**
 * Build the `/funding` route group.
 *
 * Mounted at `/funding` so the public paths are `POST /funding/apply`,
 * `GET /funding/applications`, `GET /funding/applications/:accountId`,
 * `POST /funding/trial`, `POST /funding/admit`, `POST /funding/reject`,
 * `GET /funding/payout-days`, `GET /funding/daily-roster`,
 * `POST /funding/daily-roster/comment`, `POST /funding/daily-roster/payments`,
 * `POST /funding/daily-roster/recipients`,
 * `POST /funding/daily-roster/recipients/update`,
 * `POST /funding/daily-roster/recipients/delete`,
 * `GET /funding/daily-roster/document`,
 * `POST /funding/daily-roster/document`,
 * `POST /funding/daily-roster/worker/comment`,
 * `POST /funding/daily-roster/worker/payments`,
 * `POST /funding/daily-roster/worker/recipients`,
 * `POST /funding/daily-roster/worker/recipients/update`,
 * `POST /funding/daily-roster/worker/recipients/delete`,
 * `POST /funding/daily-roster/worker/moderators`,
 * `POST /funding/daily-roster/worker/moderators/update`,
 * `POST /funding/daily-roster/worker/moderators/delete`, and
 * `POST /funding/daily-roster/worker/moderators/payments`.
 *
 * `POST /apply` is paused unless `deps.applicationsPaused` is false.
 * While paused, authenticated `verified` and above receive 403
 * `{ error: 'Applications are paused' }` with no grant write, except
 * `joey-rosima`, `vincent`, and `jewel-bacolbas`. Those three, and every
 * caller when `applicationsPaused` is false, still run the About-me,
 * photo, location, and grant write. That walk returns 400
 * `{ error: 'About me is required' }`, 400
 * `{ error: 'About me photo is required' }`, 400
 * `{ error: 'Location is required' }`, 409 `{ error: 'Conflict' }`,
 * 200 `{ funding }` (log `funding.applied`), or 503
 * `{ error: 'Funding is unavailable' }`. `basis` is 403 Forbidden.
 *
 * @param deps - Auth store, funding store, message store, gift store, clock,
 *   optional spend ping, optional roster store, optional spend token,
 *   optional LNURL server, and optional applicationsPaused flag.
 * @returns A Hono app with member apply, staff review, and daily roster routes.
 */
export function fundingRoutes(deps: FundingRouteDeps): Hono {
  const rosterStore = deps.rosterStore ?? new InMemoryDailyRosterStore();
  return new Hono()
    .post('/apply', async (c) => {
      const caller = await authedAccount(deps, c.req.header('authorization'));
      if (caller === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (!roleAtLeast(caller.role, 'verified')) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      if (deps.applicationsPaused !== false && !applicationPauseExempt(caller.username)) {
        logEvent('funding.apply.paused', { accountId: caller.id });
        return c.json({ error: 'Applications are paused' }, 403);
      }
      const nowMs = deps.now();
      try {
        const owner = await serializeOwnerAccountWithPosts(caller, deps.messageStore);
        if (owner.aboutMe === null) {
          return c.json({ error: 'About me is required' }, 400);
        }
        if (!owner.aboutMeHasPhoto) {
          return c.json({ error: 'About me photo is required' }, 400);
        }
        const location = caller.location;
        if (location === null || location.trim() === '') {
          return c.json({ error: 'Location is required' }, 400);
        }
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
        return c.json(
          { funding: serializeOwnerFunding(caller.role, grant, nowMs, null, caller.id) },
          200,
        );
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
            receivingAddress(account, deps.lnurlServer) !== null;
          messages.push(
            serializeMessage(
              kept,
              payable,
              account.role,
              Math.max(0, row.replyCount - dropped),
              true,
              undefined,
              staffTagOf(account.staffTag),
            ),
          );
        }
        return c.json(
          {
            account: {
              id: account.id,
              name: account.name,
              role: account.role,
              lightningAddress: receivingAddress(account, deps.lnurlServer)?.address ?? null,
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
        await pingTodayMedia(deps, subject, nowMs, effectiveStatus(grant, nowMs));
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
        if (status === 'pending') {
          await pingTodayMedia(deps, subject, nowMs, effectiveStatus(grant, nowMs));
        }
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
    })
    .get('/payout-days', async (c) => {
      const staff = await requireStaff(deps, c.req.header('authorization'));
      if ('status' in staff) {
        return c.json({ error: staff.error }, staff.status);
      }
      const nowMs = deps.now();
      try {
        const [grants, accounts, giftRows] = await Promise.all([
          deps.fundingStore.listGrants(),
          deps.authStore.listAccounts(),
          deps.gifts.listOutbound(),
        ]);
        const matrix = buildFundingPayoutMatrix({
          nowMs,
          accounts: accounts.map((account) => ({
            id: account.id,
            name: account.name,
            role: account.role,
            lightningAddress: receivingAddress(account, deps.lnurlServer)?.address ?? null,
          })),
          grants,
          gifts: giftRows,
        });
        logEvent('funding.payouts.listed', { count: matrix.rows.length });
        return c.json(matrix, 200);
      } catch {
        logEvent('funding.payouts.failed');
        return c.json({ error: 'Funding is unavailable' }, 503);
      }
    })
    .get('/daily-roster', async (c) => {
      const opened = await openDailyRoster(deps, c.req.header('authorization'));
      if ('status' in opened) {
        return stopRoster(c, opened);
      }
      const result = await callRoster(deps, opened.caller, 'read', () => rosterStore.get());
      return answerRoster(c, result);
    })
    .get('/daily-roster/document', async (c) => {
      const denied = spendAuthGate(
        checkSpendAuth(deps.spendApiToken, c.req.header('Authorization')),
        (body, status) => c.json(body, status),
      );
      if (denied !== null) {
        return denied;
      }
      try {
        return c.json(await rosterStore.get(), 200);
      } catch (err) {
        if (err instanceof DailyRosterRequestError && err.status === 400) {
          return c.json({ error: err.error }, 400);
        }
        return c.json({ error: DAILY_ROSTER_UNAVAILABLE }, 502);
      }
    })
    .post('/daily-roster/document', async (c) => {
      const denied = spendAuthGate(
        checkSpendAuth(deps.spendApiToken, c.req.header('Authorization')),
        (body, status) => c.json(body, status),
      );
      if (denied !== null) {
        return denied;
      }
      const raw = await c.req.json().catch(() => null);
      try {
        return c.json(await rosterStore.importDocument(raw), 200);
      } catch (err) {
        if (err instanceof DailyRosterRequestError && err.status === 400) {
          return c.json({ error: err.error }, 400);
        }
        return c.json({ error: DAILY_ROSTER_UNAVAILABLE }, 502);
      }
    })
    .post('/daily-roster/worker/comment', async (c) => {
      return answerSpendDocument(c, deps.spendApiToken, async () => {
        const parsed = rosterCommentBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
          throw new DailyRosterRequestError(400, DAILY_ROSTER_INVALID_COMMENT);
        }
        const comment = normalizeDailyRosterComment(parsed.data.comment);
        if (comment === undefined) {
          throw new DailyRosterRequestError(400, DAILY_ROSTER_INVALID_COMMENT);
        }
        return rosterStore.setComment(comment);
      });
    })
    .post('/daily-roster/worker/payments', async (c) => {
      return answerSpendDocument(c, deps.spendApiToken, async () => {
        const parsed = rosterPaymentsBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
          throw new DailyRosterRequestError(400, DAILY_ROSTER_INVALID_PAYMENTS);
        }
        return rosterStore.setPaymentsEnabled(parsed.data.enabled);
      });
    })
    .post('/daily-roster/worker/recipients', async (c) => {
      return answerSpendDocument(c, deps.spendApiToken, async () => {
        const parsed = rosterRecipientBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
          throw new DailyRosterRequestError(400, DAILY_ROSTER_INVALID_ADDRESS);
        }
        return rosterStore.addRecipient(parsed.data.address, parsed.data.amountUsd);
      });
    })
    .post('/daily-roster/worker/recipients/update', async (c) => {
      return answerSpendDocument(c, deps.spendApiToken, async () => {
        const raw = await c.req.json().catch(() => null);
        const parsed = rosterRecipientBody.safeParse(raw);
        if (!parsed.success) {
          throw new DailyRosterRequestError(
            400,
            rawAddressIsString(raw) ? DAILY_ROSTER_INVALID_ADDRESS : DAILY_ROSTER_UNKNOWN_ADDRESS,
          );
        }
        return rosterStore.updateRecipient(parsed.data.address, parsed.data.amountUsd);
      });
    })
    .post('/daily-roster/worker/recipients/delete', async (c) => {
      return answerSpendDocument(c, deps.spendApiToken, async () => {
        const parsed = rosterDeleteBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
          throw new DailyRosterRequestError(400, DAILY_ROSTER_UNKNOWN_ADDRESS);
        }
        return rosterStore.deleteRecipient(parsed.data.address);
      });
    })
    .post('/daily-roster/worker/moderators', async (c) => {
      return answerSpendDocument(c, deps.spendApiToken, async () => {
        const parsed = rosterRecipientBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
          throw new DailyRosterRequestError(400, DAILY_ROSTER_INVALID_ADDRESS);
        }
        return rosterStore.addModerator(parsed.data.address, parsed.data.amountUsd);
      });
    })
    .post('/daily-roster/worker/moderators/update', async (c) => {
      return answerSpendDocument(c, deps.spendApiToken, async () => {
        const raw = await c.req.json().catch(() => null);
        const parsed = rosterRecipientBody.safeParse(raw);
        if (!parsed.success) {
          throw new DailyRosterRequestError(
            400,
            rawAddressIsString(raw) ? DAILY_ROSTER_INVALID_ADDRESS : DAILY_ROSTER_UNKNOWN_ADDRESS,
          );
        }
        return rosterStore.updateModerator(parsed.data.address, parsed.data.amountUsd);
      });
    })
    .post('/daily-roster/worker/moderators/delete', async (c) => {
      return answerSpendDocument(c, deps.spendApiToken, async () => {
        const parsed = rosterDeleteBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
          throw new DailyRosterRequestError(400, DAILY_ROSTER_UNKNOWN_ADDRESS);
        }
        return rosterStore.deleteModerator(parsed.data.address);
      });
    })
    .post('/daily-roster/worker/moderators/payments', async (c) => {
      return answerSpendDocument(c, deps.spendApiToken, async () => {
        const parsed = rosterPaymentsBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
          throw new DailyRosterRequestError(400, DAILY_ROSTER_INVALID_PAYMENTS);
        }
        return rosterStore.setModeratorPaymentsEnabled(parsed.data.enabled);
      });
    })
    .post('/daily-roster/comment', async (c) => {
      const opened = await openDailyRoster(deps, c.req.header('authorization'));
      if ('status' in opened) {
        return stopRoster(c, opened);
      }
      const parsed = rosterCommentBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: DAILY_ROSTER_INVALID_COMMENT }, 400);
      }
      const comment = normalizeDailyRosterComment(parsed.data.comment);
      if (comment === undefined) {
        return c.json({ error: DAILY_ROSTER_INVALID_COMMENT }, 400);
      }
      const result = await callRoster(deps, opened.caller, 'comment', () =>
        rosterStore.setComment(comment),
      );
      return answerRoster(c, result);
    })
    .post('/daily-roster/payments', async (c) => {
      const opened = await openDailyRoster(deps, c.req.header('authorization'));
      if ('status' in opened) {
        return stopRoster(c, opened);
      }
      const parsed = rosterPaymentsBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: DAILY_ROSTER_INVALID_PAYMENTS }, 400);
      }
      const enabled = parsed.data.enabled;
      const result = await callRoster(deps, opened.caller, 'payments', () =>
        rosterStore.setPaymentsEnabled(enabled),
      );
      return answerRoster(c, result);
    })
    .post('/daily-roster/recipients', async (c) => {
      const opened = await openDailyRoster(deps, c.req.header('authorization'));
      if ('status' in opened) {
        return stopRoster(c, opened);
      }
      const parsed = rosterRecipientAddBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success || !MESSAGE_ID_RE.test(parsed.data.accountId)) {
        return c.json({ error: DAILY_ROSTER_INVALID_PERSON }, 400);
      }
      const amountUsd = parsed.data.amountUsd;
      let account: Account | undefined;
      try {
        account = await deps.authStore.getAccount(parsed.data.accountId);
      } catch {
        logEvent('funding.daily_roster.failed', {
          accountId: opened.caller.id,
          action: 'recipient-add',
        });
        return c.json({ error: DAILY_ROSTER_UNAVAILABLE }, 502);
      }
      if (account === undefined) {
        return c.json({ error: DAILY_ROSTER_UNKNOWN_PERSON }, 400);
      }
      const address = receivingAddress(account, deps.lnurlServer)?.address ?? null;
      if (address === null) {
        return c.json({ error: DAILY_ROSTER_NO_LIGHTNING }, 400);
      }
      const result = await callRoster(deps, opened.caller, 'recipient-add', () =>
        rosterStore.addRecipient(address, amountUsd),
      );
      return answerRoster(c, result);
    })
    .post('/daily-roster/recipients/update', async (c) => {
      const opened = await openDailyRoster(deps, c.req.header('authorization'));
      if ('status' in opened) {
        return stopRoster(c, opened);
      }
      const raw = await c.req.json().catch(() => null);
      const parsed = rosterRecipientBody.safeParse(raw);
      if (!parsed.success) {
        return c.json(
          {
            error: rawAddressIsString(raw)
              ? DAILY_ROSTER_INVALID_ADDRESS
              : DAILY_ROSTER_UNKNOWN_ADDRESS,
          },
          400,
        );
      }
      const address = parsed.data.address;
      const amountUsd = parsed.data.amountUsd;
      const result = await callRoster(deps, opened.caller, 'recipient-update', () =>
        rosterStore.updateRecipient(address, amountUsd),
      );
      return answerRoster(c, result);
    })
    .post('/daily-roster/recipients/delete', async (c) => {
      const opened = await openDailyRoster(deps, c.req.header('authorization'));
      if ('status' in opened) {
        return stopRoster(c, opened);
      }
      const parsed = rosterDeleteBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: DAILY_ROSTER_UNKNOWN_ADDRESS }, 400);
      }
      const address = parsed.data.address;
      const result = await callRoster(deps, opened.caller, 'recipient-delete', () =>
        rosterStore.deleteRecipient(address),
      );
      return answerRoster(c, result);
    });
}
