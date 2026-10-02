import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryHabitStore,
  PostgresHabitStore,
  migrateHabitSchema,
  HABIT_SCHEMA_SQL,
} from '@/lib/habit-store';
import type { SqlClient } from '@/lib/auth/sql';

const habit = {
  id: 'f',
  accountId: 'owner',
  role: 'founder' as const,
  name: 'Founder',
  text: 'Read',
  firstWeek: '2026-09-28',
  lastWeek: null,
};
const comment = {
  id: 'c',
  accountId: 'visitor',
  name: 'Visitor',
  text: 'Hello',
  week: '2026-09-21',
  createdAt: 123,
};

describe('habit persistence', () => {
  it('protects in-memory history from caller mutations and preserves earliest comment-only weeks', async () => {
    const store = new InMemoryHabitStore();
    expect(await store.firstWeek()).toBeNull();
    await store.add(habit);
    await store.comment(comment);
    expect(await store.firstWeek()).toBe('2026-09-21');
    (await store.habits())[0]!.text = 'Changed';
    (await store.comments(comment.week))[0]!.text = 'Changed';
    expect((await store.habits())[0]!.text).toBe('Read');
    expect((await store.comments(comment.week))[0]!.text).toBe('Hello');
    await store.retire('missing', 'owner', '2026-09-28');
    await store.retire('f', 'intruder', '2026-09-28');
    expect((await store.habits())[0]!.lastWeek).toBeNull();
    await store.retire('f', 'owner', '2026-09-28');
    await store.retire('f', 'owner', '2026-10-05');
    expect((await store.habits())[0]!.lastWeek).toBe('2026-09-28');
    await store.setResult({ habitId: 'f', week: habit.firstWeek, status: 'partial' });
    (await store.results(habit.firstWeek))[0]!.status = 'missed';
    expect((await store.results(habit.firstWeek))[0]!.status).toBe('partial');
    expect(await store.results('2026-10-05')).toEqual([]);
  });
  it('runs idempotent DDL and binds all user data in Postgres operations', async () => {
    const query = vi.fn().mockResolvedValue([]);
    const execute = vi.fn().mockResolvedValue(undefined);
    const sql: SqlClient = { query, execute };
    await migrateHabitSchema(sql);
    expect(execute.mock.calls.map((call) => call[0])).toEqual(HABIT_SCHEMA_SQL);
    const store = new PostgresHabitStore(sql);
    expect(await store.firstWeek()).toBeNull();
    query.mockResolvedValueOnce([{ week: null }]);
    expect(await store.firstWeek()).toBeNull();
    query.mockResolvedValueOnce([{ week: '2026-09-21' }]);
    expect(await store.firstWeek()).toBe('2026-09-21');
    query.mockResolvedValueOnce([habit]);
    expect(await store.habits()).toEqual([habit]);
    await store.results(habit.firstWeek);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('WHERE week = $1'), [
      habit.firstWeek,
    ]);
    await store.comments(comment.week);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('ORDER BY created_at, id'), [
      comment.week,
    ]);
    await store.add(habit);
    expect(execute).toHaveBeenLastCalledWith(expect.stringContaining('INSERT INTO habit '), [
      'f',
      'owner',
      'founder',
      'Founder',
      'Read',
      habit.firstWeek,
    ]);
    await store.retire('f', 'owner', habit.firstWeek);
    expect(execute).toHaveBeenLastCalledWith(expect.stringContaining('last_week IS NULL'), [
      'f',
      'owner',
      habit.firstWeek,
    ]);
    await store.setResult({ habitId: 'f', week: habit.firstWeek, status: 'achieved' });
    expect(execute).toHaveBeenLastCalledWith(expect.stringContaining('ON CONFLICT'), [
      'f',
      habit.firstWeek,
      'achieved',
    ]);
    await store.comment(comment);
    expect(execute).toHaveBeenLastCalledWith(expect.stringContaining('INSERT INTO habit_comment'), [
      'c',
      'visitor',
      'Visitor',
      'Hello',
      comment.week,
      123,
    ]);
  });
});
