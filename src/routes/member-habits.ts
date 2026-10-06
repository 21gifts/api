import { Hono } from 'hono';
import { z } from 'zod';
import { bearerToken } from '@/routes/me';
import { resolveSession } from '@/lib/auth/service';
import { roleAtLeast } from '@/lib/auth/roles';
import type { AccountRole } from '@/lib/auth/store';
import { InvoiceRateLimiter } from '@/lib/nostr/rate-limit';
import { GIFT_INVOICE_MAX_MSAT } from '@/lib/config';
import { requestGiftInvoice } from '@/lib/gift-invoice';
import type { FetchFn } from '@/lib/lnurlp';
import {
  comparePeriod,
  dayKey,
  isValidTimeZone,
  manilaReviewWeek,
  periodKey,
  weekKey,
  weeklyRatableThrough,
} from '@/lib/member-habit';
import { isSundayRestHeader } from '@/lib/sunday-rest';
import type { MemberHabit, MemberHabitStore } from '@/lib/member-habit-store';

const PERIOD_RE = /^\d{4}-\d{2}-\d{2}$/;

const addBody = z
  .object({
    action: z.literal('add'),
    name: z.string(),
    description: z.string().optional().default(''),
    notes: z.string().optional().default(''),
    cadence: z.enum(['daily', 'weekly']),
  })
  .strict();

const editBody = z
  .object({
    action: z.literal('edit'),
    id: z.string(),
    name: z.string(),
    description: z.string().optional().default(''),
    notes: z.string().optional().default(''),
  })
  .strict();

const archiveBody = z
  .object({
    action: z.literal('archive'),
    id: z.string(),
  })
  .strict();

const logBody = z
  .object({
    action: z.literal('log'),
    id: z.string(),
    period: z.string(),
    status: z.string(),
  })
  .strict();

const commentBody = z
  .object({
    action: z.literal('comment'),
    habitId: z.string(),
    text: z.string(),
  })
  .strict();

const deleteCommentBody = z
  .object({
    action: z.literal('deleteComment'),
    id: z.string(),
  })
  .strict();

const invoiceBody = z
  .object({
    action: z.literal('invoice'),
    commentId: z.string(),
    amountSats: z.unknown().optional(),
  })
  .strict();

const postBody = z.discriminatedUnion('action', [
  addBody,
  editBody,
  archiveBody,
  logBody,
  commentBody,
  deleteCommentBody,
  invoiceBody,
]);

type Viewer = { id: string; role: AccountRole; name: string | null };

function isHabitStatus(status: string): status is 'achieved' | 'partial' | 'missed' {
  return status === 'achieved' || status === 'partial' || status === 'missed';
}

function isRealYmd(period: string): boolean {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const day = Number(period.slice(8, 10));
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year && utc.getUTCMonth() + 1 === month && utc.getUTCDate() === day
  );
}

function roleGroup(role: string): number {
  if (role === 'founder') {
    return 0;
  }
  if (role === 'initiator') {
    return 1;
  }
  return 2;
}

/** Unicode code points, the same count as PostgreSQL `char_length`. */
function unicodeLength(value: string): number {
  return [...value].length;
}

function invalidText(
  name: string,
  description: string,
  notes: string,
): 'Invalid name' | 'Invalid description' | 'Invalid notes' | null {
  const trimmed = name.trim();
  if (unicodeLength(trimmed) < 1 || unicodeLength(trimmed) > 80) {
    return 'Invalid name';
  }
  if (unicodeLength(description) > 2000) {
    return 'Invalid description';
  }
  if (unicodeLength(notes) > 2000) {
    return 'Invalid notes';
  }
  return null;
}

function publicComments(
  comments: Array<{
    id: string;
    habitId: string;
    accountId: string;
    name: string;
    text: string;
    week: string;
    createdAt: number;
    deletedAt: number | null;
  }>,
): Array<{
  id: string;
  habitId: string;
  accountId: string;
  name: string;
  text: string;
  week: string;
  createdAt: number;
}> {
  return comments.map((comment) => ({
    id: comment.id,
    habitId: comment.habitId,
    accountId: comment.accountId,
    name: comment.name,
    text: comment.text,
    week: comment.week,
    createdAt: comment.createdAt,
  }));
}

/**
 * Hono routes `GET /` and `POST /` mounted at `/habits`.
 *
 * @param deps - Habit store, auth store, clock, and fetch.
 * @returns The Hono app mounted at `/habits`.
 */
export function memberHabitRoutes(deps: {
  store: MemberHabitStore;
  authStore: {
    getAccount(id: string): Promise<
      | {
          id: string;
          role: string;
          name: string | null;
          lightningAddress: string | null;
        }
      | undefined
    >;
  };
  now: () => number;
  fetchImpl: FetchFn;
  resolve?: (header: string | undefined) => Promise<Viewer | null>;
}): Hono {
  const invoiceLimiter = new InvoiceRateLimiter();
  const resolve =
    deps.resolve ??
    (async (header: string | undefined): Promise<Viewer | null> => {
      const token = bearerToken(header);
      if (token === null) {
        return null;
      }
      const account = await resolveSession(
        deps.authStore as Parameters<typeof resolveSession>[0],
        deps.now(),
        token,
      );
      if (account === null) {
        return null;
      }
      return { id: account.id, role: account.role, name: account.name };
    });

  const app = new Hono();

  app.get('/', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const viewer = await resolve(c.req.header('Authorization'));
      const viewerId = viewer === null ? null : viewer.id;
      const nowMs = deps.now();
      const listed = await deps.store.listPublic(viewerId, nowMs);
      listed.sort((a, b) => {
        const group = roleGroup(a.role) - roleGroup(b.role);
        if (group !== 0) {
          return group;
        }
        if (a.ownerName !== b.ownerName) {
          return a.ownerName < b.ownerName ? -1 : 1;
        }
        if (a.name !== b.name) {
          return a.name < b.name ? -1 : 1;
        }
        return 0;
      });
      const habits = listed.map((habit) => {
        const comments = publicComments(habit.comments);
        const body = {
          id: habit.id,
          accountId: habit.accountId,
          ownerName: habit.ownerName,
          role: habit.role,
          name: habit.name,
          description: habit.description,
          cadence: habit.cadence,
          timeZone: habit.timeZone,
          firstPeriod: habit.firstPeriod,
          lastPeriod: habit.lastPeriod,
          periods: habit.periods,
          comments,
        };
        if (habit.notes === undefined) {
          return body;
        }
        return { ...body, notes: habit.notes };
      });
      const review = manilaReviewWeek(nowMs);
      return c.json({
        reviewWeek: { start: review.start },
        habits,
      });
    } catch {
      console.warn(JSON.stringify({ ts: new Date().toISOString(), event: 'habits.failed' }));
      return c.json({ error: 'Habits are unavailable' }, 503);
    }
  });

  app.post('/', async (c) => {
    c.header('Cache-Control', 'no-store');
    const header = c.req.header('Authorization');
    if (bearerToken(header) === null) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    let account: Viewer | null;
    try {
      account = await resolve(header);
    } catch {
      console.warn(JSON.stringify({ ts: new Date().toISOString(), event: 'habits.failed' }));
      return c.json({ error: 'Habits are unavailable' }, 503);
    }
    if (account === null) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const raw = await c.req.json().catch(() => null);
    const parsed = postBody.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'Invalid body' }, 400);
    }
    const body = parsed.data;
    const nowMs = deps.now();
    try {
      if (body.action === 'add') {
        const zone = c.req.header('Time-Zone');
        if (zone === undefined || !isValidTimeZone(zone)) {
          return c.json({ error: 'Invalid time zone' }, 400);
        }
        const textError = invalidText(body.name, body.description, body.notes);
        if (textError !== null) {
          return c.json({ error: textError }, 400);
        }
        const id = crypto.randomUUID();
        const habit: MemberHabit = {
          id,
          accountId: account.id,
          ownerName: account.name ?? '',
          role: account.role,
          name: body.name.trim(),
          description: body.description,
          notes: body.notes,
          cadence: body.cadence,
          timeZone: zone,
          firstPeriod: periodKey(nowMs, body.cadence, zone),
          lastPeriod: null,
        };
        await deps.store.add(habit);
        return c.json({ ok: true, id }, 201);
      }

      if (body.action === 'edit') {
        const textError = invalidText(body.name, body.description, body.notes);
        if (textError !== null) {
          return c.json({ error: textError }, 400);
        }
        const habits = await deps.store.listPublic(account.id, nowMs);
        const habit = habits.find((row) => row.id === body.id);
        if (habit === undefined) {
          return c.json({ error: 'Not found' }, 404);
        }
        const result = await deps.store.edit(
          body.id,
          account.id,
          { name: body.name.trim(), description: body.description, notes: body.notes },
          periodKey(nowMs, habit.cadence, habit.timeZone),
        );
        if (result === 'missing') {
          return c.json({ error: 'Not found' }, 404);
        }
        return c.json({ ok: true }, 200);
      }

      if (body.action === 'archive') {
        const habits = await deps.store.listPublic(account.id, nowMs);
        const habit = habits.find((row) => row.id === body.id);
        if (habit === undefined) {
          return c.json({ error: 'Not found' }, 404);
        }
        const result = await deps.store.archive(
          body.id,
          account.id,
          periodKey(nowMs, habit.cadence, habit.timeZone),
        );
        if (result === 'missing') {
          return c.json({ error: 'Not found' }, 404);
        }
        return c.json({ ok: true }, 200);
      }

      if (body.action === 'log') {
        if (!isHabitStatus(body.status)) {
          return c.json({ error: 'Invalid status' }, 400);
        }
        if (!PERIOD_RE.test(body.period)) {
          return c.json({ error: 'Invalid period' }, 400);
        }
        const habits = await deps.store.listPublic(account.id, nowMs);
        const habit = habits.find((row) => row.id === body.id);
        if (habit === undefined) {
          return c.json({ error: 'Not found' }, 404);
        }
        if (!isRealYmd(body.period)) {
          return c.json({ error: 'Invalid period' }, 400);
        }
        if (habit.cadence === 'weekly') {
          const instant = Date.parse(`${body.period}T12:00:00Z`);
          if (body.period !== weekKey(instant, habit.timeZone)) {
            return c.json({ error: 'Invalid period' }, 400);
          }
        }
        const latest =
          habit.cadence === 'daily'
            ? dayKey(nowMs, habit.timeZone)
            : weeklyRatableThrough(nowMs, habit.timeZone);
        if (comparePeriod(body.period, latest) > 0) {
          return c.json({ error: 'Period is closed' }, 409);
        }
        const result = await deps.store.log(body.id, account.id, body.period, body.status);
        if (result === 'closed') {
          return c.json({ error: 'Period is closed' }, 409);
        }
        if (result === 'missing') {
          return c.json({ error: 'Not found' }, 404);
        }
        return c.json({ ok: true }, 200);
      }

      if (body.action === 'comment') {
        if (isSundayRestHeader(nowMs, c.req.header('Time-Zone'))) {
          return c.json({ error: 'SUNDAY_REST' }, 403);
        }
        const text = body.text.trim();
        if (unicodeLength(text) < 1 || unicodeLength(text) > 2000) {
          return c.json({ error: 'Invalid comment' }, 400);
        }
        const habits = await deps.store.listPublic(null, nowMs);
        const habit = habits.find((row) => row.id === body.habitId);
        if (habit === undefined) {
          return c.json({ error: 'Not found' }, 404);
        }
        await deps.store.comment({
          id: crypto.randomUUID(),
          habitId: body.habitId,
          accountId: account.id,
          name: account.name ?? '',
          text,
          week: manilaReviewWeek(nowMs).start,
          createdAt: nowMs,
          deletedAt: null,
        });
        return c.json({ ok: true }, 201);
      }

      if (body.action === 'deleteComment') {
        if (isSundayRestHeader(nowMs, c.req.header('Time-Zone'))) {
          return c.json({ error: 'SUNDAY_REST' }, 403);
        }
        if (!roleAtLeast(account.role, 'initiator')) {
          return c.json({ error: 'Forbidden' }, 403);
        }
        const comment = await deps.store.findComment(body.id);
        if (comment === null) {
          return c.json({ error: 'Not found' }, 404);
        }
        const deleted = await deps.store.deleteComment(body.id);
        if (!deleted) {
          return c.json({ error: 'Not found' }, 404);
        }
        return c.json({ ok: true }, 200);
      }

      if (isSundayRestHeader(nowMs, c.req.header('Time-Zone'))) {
        return c.json({ error: 'SUNDAY_REST' }, 403);
      }
      const amountSats = body.amountSats;
      if (
        typeof amountSats !== 'number' ||
        !Number.isInteger(amountSats) ||
        amountSats < 1 ||
        amountSats > GIFT_INVOICE_MAX_MSAT / 1000
      ) {
        return c.json({ error: 'Expected a JSON body with an integer "amountSats"' }, 400);
      }
      const comment = await deps.store.findComment(body.commentId);
      if (comment === null) {
        return c.json({ error: 'Not found' }, 404);
      }
      if (comment.accountId === account.id) {
        return c.json({ error: 'Cannot donate to yourself' }, 400);
      }
      const author = await deps.authStore.getAccount(comment.accountId);
      if (
        author === undefined ||
        author.lightningAddress === null ||
        author.lightningAddress === ''
      ) {
        return c.json({ error: "The author's wallet cannot receive this Bitcoin payment" }, 409);
      }
      if (!invoiceLimiter.allow(account.id, nowMs)) {
        return c.json({ error: 'Too many payments' }, 429);
      }
      const address = author.lightningAddress;
      let invoice: { ok: true; pr: string } | { ok: false };
      try {
        invoice = await requestGiftInvoice({
          address,
          amountMsat: amountSats * 1000,
          fetchImpl: deps.fetchImpl,
        });
        /* v8 ignore next 3 -- requestGiftInvoice returns ok:false instead of throwing */
      } catch {
        return c.json({ error: 'Lightning Address could not be resolved' }, 502);
      }
      if (!invoice.ok) {
        return c.json({ error: 'Lightning Address could not be resolved' }, 502);
      }
      return c.json({ pr: invoice.pr, amountSats }, 200);
    } catch {
      console.warn(JSON.stringify({ ts: new Date().toISOString(), event: 'habits.failed' }));
      return c.json({ error: 'Habits are unavailable' }, 503);
    }
  });

  return app;
}
