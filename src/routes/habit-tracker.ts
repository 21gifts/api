import { Hono } from 'hono';
import { z } from 'zod';
import { resolveSession } from '@/lib/auth/service';
import type { AuthStore } from '@/lib/auth/store';
import type { HabitStore } from '@/lib/habit-store';
import { HABIT_WEEK_MS, habitWeek } from '@/lib/habit-tracker';
import { bearerToken } from '@/routes/me';

const weekSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = Date.parse(`${value}T00:00:00+08:00`);
    return Number.isFinite(date) && habitWeek(date).start === value;
  });
const operation = z.discriminatedUnion('action', [
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

/** Public weekly history; all mutations require a session and owner checks. */
export function habitTrackerRoutes(deps: {
  authStore: AuthStore;
  habitStore: HabitStore;
  now: () => number;
}): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.get('/', async (c) => {
    const current = habitWeek(deps.now());
    const requested = weekSchema.safeParse(c.req.query('week') ?? current.start);
    if (!requested.success || requested.data > current.start)
      return c.json({ error: 'Invalid week' }, 400);
    const week = habitWeek(Date.parse(`${requested.data}T00:00:00+08:00`));
    const [habits, results, comments] = await Promise.all([
      deps.habitStore.habits(),
      deps.habitStore.results(week.start),
      deps.habitStore.comments(week.start),
    ]);
    const firstWeek = (await deps.habitStore.firstWeek()) ?? current.start;
    return c.json({
      week,
      currentWeek: current.start,
      firstWeek,
      habits: habits.filter(
        (habit) =>
          habit.firstWeek <= week.start &&
          (habit.lastWeek === null || habit.lastWeek >= week.start),
      ),
      results,
      comments,
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
    const current = habitWeek(now).start;
    if (input.action === 'comment') {
      const first = (await deps.habitStore.firstWeek()) ?? current;
      if (input.week > current || input.week < first) return c.json({ error: 'Invalid week' }, 400);
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
    if (caller.role !== 'founder' && caller.role !== 'initiator')
      return c.json({ error: 'Forbidden' }, 403);
    if (input.action === 'add') {
      await deps.habitStore.add({
        id: crypto.randomUUID(),
        accountId: caller.id,
        role: caller.role,
        name: caller.name ?? '',
        text: input.text,
        firstWeek: current,
        lastWeek: null,
      });
      return c.json({ ok: true }, 201);
    }
    const habit = (await deps.habitStore.habits()).find((row) => row.id === input.id);
    if (!habit || habit.accountId !== caller.id) return c.json({ error: 'Not found' }, 404);
    if (input.action === 'retire') {
      await deps.habitStore.retire(habit.id, caller.id, current);
    } else {
      // Previous week remains rateable on Monday after Sunday's platform rest.
      const previous = habitWeek(now - HABIT_WEEK_MS).start;
      if (
        input.week > current ||
        input.week < previous ||
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
