/**
 * Member interaction-log ingest: batched first-party events for a signed-in
 * account.
 *
 * Mounted at `/` so discovery sees the full public path `/me/events`.
 */

import { Hono } from 'hono';
import { resolveSession } from '@/lib/auth/service';
import type { Account, AuthStore } from '@/lib/auth/store';
import { readCappedText } from '@/lib/capped-body';
import { IpRateLimiter } from '@/lib/ip-rate-limit';
import { logEvent } from '@/lib/log';
import { parseMemberEventBatch } from '@/lib/member-event';
import type { MemberEvent, MemberEventStore } from '@/lib/member-event-store';
import { bearerToken } from '@/routes/me';

/** Largest accepted `POST /me/events` body, in bytes. */
export const MEMBER_EVENTS_BODY_LIMIT_BYTES = 64 * 1024;

/** Maximum accepted POSTs per account inside one rate-limit window. */
export const MEMBER_EVENTS_PER_MINUTE = 30;

/** Collaborators the member-event routes need. */
export interface MemberEventRouteDeps {
  /** Shared auth persistence port. */
  authStore: AuthStore;
  /** Member-event persistence port. */
  store: MemberEventStore;
  /** Clock returning epoch milliseconds. */
  now: () => number;
  /**
   * Per-account limiter. Default: one {@link IpRateLimiter} of
   * {@link MEMBER_EVENTS_PER_MINUTE} created once per {@link memberEventRoutes} call.
   */
  limiter?: IpRateLimiter;
}

/** Resolve the account behind a request's bearer session, or `null`. */
async function authedAccount(
  deps: MemberEventRouteDeps,
  header: string | undefined,
): Promise<Account | null> {
  const token = bearerToken(header);
  if (token === null) {
    return null;
  }
  return resolveSession(deps.authStore, deps.now(), token);
}

/**
 * Build the member interaction-log route group (full public path `/me/events`).
 *
 * @param deps - Auth store, event store, clock, optional limiter.
 * @returns A Hono app with POST `/me/events`.
 */
export function memberEventRoutes(deps: MemberEventRouteDeps): Hono {
  const limiter = deps.limiter ?? new IpRateLimiter(MEMBER_EVENTS_PER_MINUTE);
  return new Hono().post('/me/events', async (c) => {
    const account = await authedAccount(deps, c.req.header('authorization'));
    if (account === null) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const now = deps.now();
    if (!limiter.allow(account.id, now)) {
      return c.json({ error: 'Too many requests' }, 429);
    }
    const text = await readCappedText(c.req.raw, MEMBER_EVENTS_BODY_LIMIT_BYTES);
    if (text === null) {
      return c.json({ error: 'Request body is too large' }, 413);
    }
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      return c.json({ error: 'Invalid events' }, 400);
    }
    const parsed = parseMemberEventBatch(body, now);
    if (!parsed.ok) {
      return c.json({ error: 'Invalid events' }, 400);
    }
    const receivedAt = new Date(now);
    const rows: MemberEvent[] = parsed.events.map((event) => ({
      id: crypto.randomUUID(),
      accountId: account.id,
      name: event.name,
      at: event.at,
      path: event.path,
      props: event.props,
      receivedAt,
    }));
    try {
      await deps.store.appendMany(rows);
    } catch {
      logEvent('member_event.write.failed', { accountId: account.id });
      return c.json({ error: 'Log is unavailable' }, 503);
    }
    return c.json({ accepted: rows.length, dropped: parsed.dropped }, 200);
  });
}
