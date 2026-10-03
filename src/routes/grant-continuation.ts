import { Hono } from 'hono';
import { resolveSession } from '@/lib/auth/service';
import type { AuthStore } from '@/lib/auth/store';
import { measureGrantContinuation } from '@/lib/grant-continuation';
import { logEvent } from '@/lib/log';
import type { ShopNoteRef } from '@/lib/message-store';
import type { PosChargeRef } from '@/lib/pos-store';
import { bearerToken } from '@/routes/me';

const WINDOW_DAYS = 7;
const MS_PER_DAY = 86_400_000;

/** Collaborators the `/funding/goal` route needs. All required. */
export interface GrantContinuationRouteDeps {
  /** Shared auth persistence port. */
  authStore: AuthStore;
  /** Clock returning epoch milliseconds (injected for testability). */
  now: () => number;
  /** Live assigned shop notes (hashtag filtered in {@link measureGrantContinuation}). */
  messages: { listLiveAssignedShops(): Promise<ShopNoteRef[]> };
  /** POS charges in the UTC window, every status. */
  pos: { listCreatedBetween(startMs: number, endMs: number): Promise<PosChargeRef[]> };
}

/**
 * Build the `/funding/goal` route group.
 *
 * Mounted at `/funding/goal` so the public path is `GET /funding/goal`.
 * Any signed-in role may read it. This does not serve the public 30-day series.
 *
 * @param deps - Auth store, clock, shop notes, and POS charges.
 * @returns A Hono app with `GET /`.
 */
export function grantContinuationRoutes(deps: GrantContinuationRouteDeps): Hono {
  return new Hono().get('/', async (c) => {
    const token = bearerToken(c.req.header('authorization'));
    if (token === null) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const account = await resolveSession(deps.authStore, deps.now(), token);
    if (account === null) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const today = new Date(deps.now()).toISOString().slice(0, 10);
    const todayMs = Date.parse(`${today}T00:00:00.000Z`);
    const startMs = todayMs - (WINDOW_DAYS - 1) * MS_PER_DAY;
    const endMs = todayMs + MS_PER_DAY;
    try {
      const [notes, charges] = await Promise.all([
        deps.messages.listLiveAssignedShops(),
        deps.pos.listCreatedBetween(startMs, endMs),
      ]);
      return c.json(measureGrantContinuation(notes, charges, today), 200);
    } catch {
      logEvent('funding.goal.failed');
      return c.json({ error: 'Funding goal is unavailable' }, 503);
    }
  });
}
