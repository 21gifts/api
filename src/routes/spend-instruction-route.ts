/**
 * Spend-worker daily instruction: collect passkey, post, media, funding,
 * welcome-paid, and roster facts, then return the daily pay-or-skip decision.
 * The api does not pay. Nothing is logged.
 */

import { Hono } from 'hono';
import type { AuthStore } from '@/lib/auth/store';
import { DailyRosterRequestError, DAILY_ROSTER_UNAVAILABLE } from '@/lib/daily-roster';
import { InMemoryDailyRosterStore, type DailyRosterStore } from '@/lib/daily-roster-store';
import { effectiveStatus, eligibleToday } from '@/lib/funding';
import type { FundingStore } from '@/lib/funding-store';
import type { GiftStore } from '@/lib/gift-store';
import { normalizeLightningAddress } from '@/lib/lightning-address';
import { MESSAGE_LIST_LIMIT } from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import { checkSpendAuth } from '@/lib/spend-auth';
import {
  decideCliDailyInstruction,
  welcomeGiftPaidOnUtcDay,
  type SpendGrantStatus,
} from '@/lib/spend-instruction';

/** Collaborators the daily-instruction route needs. */
export interface SpendInstructionRouteDeps {
  /** `SPEND_API_TOKEN` (blank/undefined → 503). */
  spendApiToken: string | undefined;
  /**
   * Auth store for Lightning Address → account and passkey lookup.
   */
  authStore: Pick<AuthStore, 'getAccountByLightningAddress' | 'accountHasPasskey'>;
  /**
   * Forum store for live top-level post, media, and newest non-profile id.
   */
  messageStore: Pick<
    MessageStore,
    'accountHasLiveTopLevelPost' | 'accountHasLiveTopLevelMediaPost' | 'listPostsByAccount'
  >;
  /** Funding grants for spend eligibility. */
  fundingStore: Pick<FundingStore, 'getByAccountId'>;
  /** Clock, epoch milliseconds. */
  now: () => number;
  /**
   * Outbound gifts for the same-UTC-day welcome flag. Omitted → the rule
   * is not applied.
   */
  gifts?: Pick<GiftStore, 'listOutbound'>;
  /**
   * Daily payout roster. Omitted → a fresh in-memory store.
   */
  rosterStore?: DailyRosterStore;
}

/**
 * Map {@link checkSpendAuth} to a Hono JSON response, or `null` when ok.
 *
 * @param status - Auth check result.
 * @param json - Hono `c.json` bound to the request.
 * @returns 503/401 response, or `null` to continue.
 */
function authGate(
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
 * Build the `/spend` route group.
 *
 * @param deps - Token, auth store, message store, funding store, clock,
 *   optional gift store, optional roster store.
 * @returns Hono app mounted at `/spend`.
 */
export function spendInstructionRoutes(deps: SpendInstructionRouteDeps): Hono {
  const rosterStore = deps.rosterStore ?? new InMemoryDailyRosterStore();
  return new Hono().post('/daily-instruction', async (c) => {
    const denied = authGate(
      checkSpendAuth(deps.spendApiToken, c.req.header('Authorization')),
      (body, status) => c.json(body, status),
    );
    if (denied !== null) {
      return denied;
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'Expected a JSON body with address' }, 400);
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return c.json({ error: 'Expected a JSON body with address' }, 400);
    }
    const body = raw as Record<string, unknown>;
    if (typeof body['address'] !== 'string') {
      return c.json({ error: 'Expected a JSON body with address' }, 400);
    }
    const address = normalizeLightningAddress(body['address']);
    if (address === null) {
      return c.json({ error: 'Not a valid Lightning Address (expected name@domain)' }, 400);
    }

    const nowMs = deps.now();
    const account = await deps.authStore.getAccountByLightningAddress(address);
    let hasPasskey = false;
    let hasPosted = false;
    let hasMedia = false;
    let messageId: string | null = null;
    let eligible = false;
    let grantStatus: SpendGrantStatus | undefined;
    if (account !== undefined) {
      hasPasskey = await deps.authStore.accountHasPasskey(account.id);
      const excludeId = account.profileMessageId ?? null;
      hasPosted = await deps.messageStore.accountHasLiveTopLevelPost(account.id, excludeId);
      if (hasPosted) {
        hasMedia = await deps.messageStore.accountHasLiveTopLevelMediaPost(account.id, excludeId);
        const posts = await deps.messageStore.listPostsByAccount(account.id, MESSAGE_LIST_LIMIT);
        const newest = posts.find((row) => row.id !== excludeId);
        messageId = newest === undefined ? null : newest.id;
      }
      if (account.role !== 'basis') {
        const grant = await deps.fundingStore.getByAccountId(account.id);
        eligible = eligibleToday(account.role, grant, nowMs);
        grantStatus = effectiveStatus(grant, nowMs);
      }
    }

    let welcomePaidOnUtcDay: boolean | undefined;
    if (deps.gifts !== undefined) {
      let outbound: Awaited<ReturnType<GiftStore['listOutbound']>>;
      try {
        outbound = await deps.gifts.listOutbound();
      } catch {
        return c.json({ error: 'Gift ledger unreadable' }, 503);
      }
      welcomePaidOnUtcDay = welcomeGiftPaidOnUtcDay(
        outbound,
        address,
        new Date(nowMs).toISOString().slice(0, 10),
      );
    }

    let roster: unknown;
    try {
      roster = await rosterStore.get();
    } catch (err) {
      if (err instanceof DailyRosterRequestError) {
        if (err.status === 400) {
          return c.json({ error: err.error }, 400);
        }
        return c.json({ error: err.error }, 502);
      }
      return c.json({ error: DAILY_ROSTER_UNAVAILABLE }, 502);
    }

    const decision = decideCliDailyInstruction({
      address,
      hasPasskey,
      hasPosted,
      hasMedia,
      eligible,
      messageId,
      roster,
      ...(grantStatus === undefined ? {} : { grantStatus }),
      ...(welcomePaidOnUtcDay === undefined ? {} : { welcomePaidOnUtcDay }),
    });
    if (decision.action === 'skip') {
      return c.json({ action: 'skip', reason: decision.reason }, 200);
    }
    return c.json(
      {
        action: 'pay',
        amountUsd: decision.amountUsd,
        comment: decision.comment,
        ...(decision.messageId === undefined ? {} : { messageId: decision.messageId }),
      },
      200,
    );
  });
}
