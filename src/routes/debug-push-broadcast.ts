/**
 * Operator Web Push broadcast to every account with a live subscription or
 * to listed usernames, queued on the push outbox. Authenticated by `DEBUG_TOKEN`
 * (Bearer), not by an end-user session.
 */

import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { Account, AuthStore } from '@/lib/auth/store';
import { bearerMatchesDebugToken } from '@/lib/debug-token';
import { logEvent } from '@/lib/log';
import { parseNotificationLevel } from '@/lib/notification';
import type { PushStore } from '@/lib/push-store';
import { enqueueBroadcastPush, listAccountIdsWithLiveSubscriptions } from '@/lib/push-worker';
import { normalizeUsername } from '@/lib/username';
import { normalizeUuid } from '@/lib/uuid';

/** Maximum broadcast title length in characters after trim. */
const TITLE_MAX_LENGTH = 64;

/** Maximum broadcast body length in characters after trim. */
const BODY_MAX_LENGTH = 240;

/** Maximum `link` length in characters. */
const LINK_MAX_LENGTH = 200;

/** Maximum entries in `usernames`. */
const USERNAMES_MAX = 200;

/** Path the notification opens when the body has no `link`. */
const DEFAULT_LINK = '/welcome';

const BODY_ERROR =
  'Expected a JSON body with "title" (1-64 characters), "body" (1-240 characters), and optional "link" (same-site path), "usernames" (1-200 usernames), "dryRun" (boolean)';

/** Collaborators the broadcast routes need. */
export interface DebugPushBroadcastRouteDeps {
  /** Shared auth persistence port. */
  authStore: AuthStore;
  /** Push subscription / outbox store. */
  pushStore: PushStore;
  /** Clock returning epoch milliseconds. */
  now: () => number;
  /** Configured operator token, or `undefined` when debug is disabled. */
  debugToken: string | undefined;
  /** Public VAPID key when configured; missing/blank → 503 on a send that is not a dry run. */
  vapidPublicKey: string | undefined;
}

/** Shared 503/401 gate for every `/debug/push-broadcast` method (before JSON). */
function requireDebugToken(deps: DebugPushBroadcastRouteDeps): MiddlewareHandler {
  return async (c, next) => {
    const token = deps.debugToken;
    if (token === undefined || token.trim() === '') {
      return c.json({ error: 'Debug is not configured' }, 503);
    }
    if (!bearerMatchesDebugToken(token, c.req.header('authorization'))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  };
}

/** Whether `text` has a C0 control or DEL character other than the allowed ones. */
function hasControl(text: string, allowNewline: boolean): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if ((code < 32 || code === 127) && !(allowNewline && code === 10)) {
      return true;
    }
  }
  return false;
}

/** Length in characters (code points), as the push payload builders count it. */
function charCount(text: string): number {
  return Array.from(text).length;
}

/** One leading `/`, not `//`, no backslash, whitespace, or control character. */
function isSameSitePath(link: string): boolean {
  return /^\/(?!\/)[^\\\s]*$/.test(link) && !hasControl(link, false);
}

const broadcastBody = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .refine((value) => charCount(value) <= TITLE_MAX_LENGTH && !hasControl(value, false)),
    body: z
      .string()
      .trim()
      .min(1)
      .refine((value) => charCount(value) <= BODY_MAX_LENGTH && !hasControl(value, true)),
    link: z
      .string()
      .refine((value) => charCount(value) <= LINK_MAX_LENGTH && isSameSitePath(value))
      .optional(),
    usernames: z.array(z.string()).min(1).max(USERNAMES_MAX).optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

/** Accounts a broadcast reaches and the ones it leaves out. */
interface BroadcastTargets {
  targeted: number;
  recipients: string[];
  optedOut: number;
  noSubscription: number;
}

/**
 * Split the selected accounts into recipients, opted-out accounts (level
 * `none`), and accounts without a subscription whose session is live.
 */
function splitTargets(
  accounts: readonly Account[],
  subscribed: ReadonlySet<string>,
): BroadcastTargets {
  const targets: BroadcastTargets = {
    targeted: accounts.length,
    recipients: [],
    optedOut: 0,
    noSubscription: 0,
  };
  for (const account of accounts) {
    if (!subscribed.has(account.id)) {
      targets.noSubscription += 1;
    } else if (parseNotificationLevel(account.notificationLevel) === 'none') {
      targets.optedOut += 1;
    } else {
      targets.recipients.push(account.id);
    }
  }
  return targets;
}

/**
 * Build the operator broadcast routes.
 *
 * Mounted at `/debug/push-broadcast`: `POST /debug/push-broadcast` queues one
 * outbox row per recipient (or counts them on a dry run), and
 * `GET /debug/push-broadcast/:id` reports the delivery counts of a broadcast.
 *
 * @param deps - Auth store, push store, clock, debug token, VAPID public key.
 * @returns A Hono app exposing `POST /` and `GET /:id`.
 */
export function debugPushBroadcastRoutes(deps: DebugPushBroadcastRouteDeps): Hono {
  return new Hono()
    .use('*', requireDebugToken(deps))
    .post('/', async (c) => {
      const parsed = broadcastBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: BODY_ERROR }, 400);
      }
      const input = parsed.data;
      const dryRun = input.dryRun === true;
      if (!dryRun && (deps.vapidPublicKey === undefined || deps.vapidPublicKey.trim() === '')) {
        return c.json({ error: 'Push is not configured' }, 503);
      }
      const subscribed = new Set(
        await listAccountIdsWithLiveSubscriptions(deps.pushStore, deps.authStore, deps.now()),
      );
      let selected: Account[];
      if (input.usernames === undefined) {
        selected = (await deps.authStore.listAccounts()).filter((account) =>
          subscribed.has(account.id),
        );
      } else {
        const names = new Set<string>();
        for (const raw of input.usernames) {
          const name = normalizeUsername(raw);
          if (name === null) {
            return c.json({ error: BODY_ERROR }, 400);
          }
          names.add(name);
        }
        selected = [];
        const unknown: string[] = [];
        for (const name of names) {
          const account = await deps.authStore.getAccountByUsername(name);
          if (account === undefined) {
            unknown.push(name);
          } else {
            selected.push(account);
          }
        }
        if (unknown.length > 0) {
          return c.json({ error: 'Unknown usernames', usernames: unknown }, 400);
        }
      }
      const targets = splitTargets(selected, subscribed);
      if (dryRun) {
        return c.json({ dryRun: true, recipients: targets.recipients.length }, 200);
      }
      const id = crypto.randomUUID();
      const queued = await enqueueBroadcastPush(
        deps.pushStore,
        targets.recipients,
        { broadcastId: id, title: input.title, body: input.body, url: input.link ?? DEFAULT_LINK },
        deps.now(),
      );
      logEvent('debug.push.broadcast', {
        id,
        targeted: targets.targeted,
        queued,
        optedOut: targets.optedOut,
        noSubscription: targets.noSubscription,
      });
      return c.json(
        {
          id,
          targeted: targets.targeted,
          queued,
          optedOut: targets.optedOut,
          noSubscription: targets.noSubscription,
        },
        202,
      );
    })
    .get('/:id', async (c) => {
      const id = normalizeUuid(c.req.param('id'));
      if (id === null) {
        return c.json({ error: 'Not found' }, 404);
      }
      const counts = await deps.pushStore.countOutboxByMessageId(id);
      if (counts.queued === 0) {
        return c.json({ error: 'Not found' }, 404);
      }
      return c.json({ id, ...counts }, 200);
    });
}
