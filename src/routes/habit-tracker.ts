import { Hono } from 'hono';
import { z } from 'zod';
import { roleAtLeast } from '@/lib/auth/roles';
import { resolveSession } from '@/lib/auth/service';
import type { AuthStore } from '@/lib/auth/store';
import type { HabitStore } from '@/lib/habit-store';
import {
  habitCommentsAllowed,
  habitCommentsCloseAt,
  habitCommentsAllowedAt,
  habitReviewWeek,
  habitWeek,
  type Habit,
} from '@/lib/habit-tracker';
import { requestGiftInvoice } from '@/lib/gift-invoice';
import { decodeBolt11 } from '@/lib/bolt11';
import { normalizeLightningAddress } from '@/lib/lightning-address';
import type { FetchFn } from '@/lib/lnurlp';
import { InvoiceRateLimiter } from '@/lib/nostr/rate-limit';
import { bearerToken } from '@/routes/me';

const weekSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = Date.parse(`${value}T00:00:00+08:00`);
    return Number.isFinite(date) && habitWeek(date).start === value;
  });
const operation = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('edit'),
      id: z.string().uuid(),
      text: z.string().trim().min(1).max(200),
    })
    .strict(),
  z.object({ action: z.literal('deleteComment'), id: z.string().uuid() }).strict(),
  z
    .object({
      action: z.literal('invoice'),
      id: z.string().uuid(),
      amountSats: z
        .number()
        .int()
        .min(1)
        .max(Math.floor(Number.MAX_SAFE_INTEGER / 1000)),
    })
    .strict(),
  z.object({ action: z.literal('add'), text: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal('retire'), id: z.string().uuid() }).strict(),
  z
    .object({
      action: z.literal('rate'),
      id: z.string().uuid(),
      week: weekSchema,
      status: z.enum(['achieved', 'partial', 'missed']),
    })
    .strict(),
  z
    .object({
      action: z.literal('comment'),
      week: weekSchema,
      text: z.string().trim().min(1).max(2000),
    })
    .strict(),
]);

/**
 * Public weekly history; all mutations require a session and owner checks.
 *
 * @param deps - Auth store, habit store, clock, and optional fetch.
 * @returns The Hono app.
 */
export function habitTrackerRoutes(deps: {
  authStore: AuthStore;
  habitStore: HabitStore;
  now: () => number;
  fetchImpl?: FetchFn;
}): Hono {
  const app = new Hono();
  const invoiceLimiter = new InvoiceRateLimiter();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.get('/', async (c) => {
    const current = habitReviewWeek(deps.now());
    const requested = weekSchema.safeParse(c.req.query('week') ?? current.start);
    if (!requested.success || requested.data > current.start)
      return c.json({ error: 'Invalid week' }, 400);
    const week = habitWeek(Date.parse(`${requested.data}T00:00:00+08:00`));
    const [habits, results, comments] = await Promise.all([
      deps.habitStore.habits(week.start),
      deps.habitStore.results(week.start),
      deps.habitStore.comments(week.start),
    ]);
    const firstWeek = (await deps.habitStore.firstWeek()) ?? current.start;
    return c.json({
      week: { ...week, nextAt: current.nextAt },
      currentWeek: current.start,
      commentsAllowed: habitCommentsAllowed(week.start, deps.now()),
      commentsCloseAt: habitCommentsCloseAt(week.start),
      commentsAllowedAt: habitCommentsAllowedAt(week.start),
      firstWeek,
      habits: habits.filter(
        (habit) =>
          habit.firstWeek <= week.start &&
          (habit.lastWeek === null || habit.lastWeek >= week.start),
      ),
      results,
      comments: await Promise.all(
        comments.map(async (comment) => {
          const author = await deps.authStore.getAccount(comment.accountId);
          return {
            ...comment,
            canReceiveDonation: normalizeLightningAddress(author?.lightningAddress ?? '') !== null,
          };
        }),
      ),
    });
  });
  app.post('/', async (c) => {
    const token = bearerToken(c.req.header('authorization'));
    const now = deps.now();
    const caller = token === null ? null : await resolveSession(deps.authStore, now, token);
    if (caller === null) return c.json({ error: 'Unauthorized' }, 401);
    const parsed = operation.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid habit operation' }, 400);
    const input = parsed.data;
    const current = habitReviewWeek(now).start;
    if (input.action === 'invoice') {
      const comment = await deps.habitStore.findComment(input.id);
      if (!comment) return c.json({ error: 'Not found' }, 404);
      if (comment.accountId === caller.id)
        return c.json({ error: 'Cannot donate to yourself' }, 409);
      const author = await deps.authStore.getAccount(comment.accountId);
      const address = normalizeLightningAddress(author?.lightningAddress ?? '');
      if (address === null) return c.json({ error: 'Author wallet unavailable' }, 409);
      if (!invoiceLimiter.allow(caller.id, now)) return c.json({ error: 'Too many requests' }, 429);
      const amountMsat = input.amountSats * 1000;
      const invoice = await requestGiftInvoice({
        address,
        amountMsat,
        fetchImpl: deps.fetchImpl ?? globalThis.fetch,
      });
      if (!invoice.ok || decodeBolt11(invoice.pr)?.amountMsat !== amountMsat)
        return c.json({ error: 'Invoice unavailable' }, 502);
      return c.json({ pr: invoice.pr, amountSats: input.amountSats });
    }
    if (input.action === 'comment') {
      const first = (await deps.habitStore.firstWeek()) ?? current;
      if (input.week > current || input.week < first) return c.json({ error: 'Invalid week' }, 400);
      if (!habitCommentsAllowed(input.week, now))
        return c.json(
          {
            error: 'Comments are closed for this week',
            commentsAllowedAt: habitCommentsAllowedAt(input.week),
          },
          403,
        );
      await deps.habitStore.comment({
        id: crypto.randomUUID(),
        accountId: caller.id,
        name: caller.name ?? '',
        text: input.text,
        week: input.week,
        createdAt: now,
      });
      return c.json({ ok: true }, 201);
    }
    if (!roleAtLeast(caller.role, 'initiator')) return c.json({ error: 'Forbidden' }, 403);
    if (input.action === 'deleteComment') {
      if (!(await deps.habitStore.findComment(input.id)))
        return c.json({ error: 'Not found' }, 404);
      await deps.habitStore.deleteComment(input.id);
      return c.json({ ok: true });
    }
    if (input.action === 'add') {
      await deps.habitStore.add({
        id: crypto.randomUUID(),
        accountId: caller.id,
        role: caller.role as Habit['role'],
        name: caller.name ?? '',
        text: input.text,
        firstWeek: current,
        lastWeek: null,
      });
      return c.json({ ok: true }, 201);
    }
    const habit = (await deps.habitStore.habits(current)).find((row) => row.id === input.id);
    if (!habit || habit.accountId !== caller.id) return c.json({ error: 'Not found' }, 404);
    if (input.action === 'edit') {
      if (habit.firstWeek > current || (habit.lastWeek !== null && habit.lastWeek < current))
        return c.json({ error: 'Week is closed' }, 409);
      await deps.habitStore.updateText(habit.id, current, input.text);
      return c.json({ ok: true });
    }
    if (input.action === 'retire') {
      await deps.habitStore.retire(habit.id, caller.id, current);
    } else {
      // Only the currently published retrospective week is editable.
      if (
        input.week !== current ||
        input.week < habit.firstWeek ||
        (habit.lastWeek !== null && input.week > habit.lastWeek)
      )
        return c.json({ error: 'Week is closed' }, 409);
      await deps.habitStore.setResult({
        habitId: habit.id,
        week: input.week,
        status: input.status,
      });
    }
    return c.json({ ok: true });
  });
  return app;
}
