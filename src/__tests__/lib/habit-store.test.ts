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
  it('lists in-memory habits by firstWeek then id and comments by createdAt then id', async () => {
    const store = new InMemoryHabitStore();
    await store.add({ ...habit, id: 'b', firstWeek: '2026-10-05' });
    await store.add({ ...habit, id: 'a', firstWeek: '2026-09-28' });
    expect((await store.habits()).map((row) => row.id)).toEqual(['a', 'b']);
    const sameWeek = new InMemoryHabitStore();
    await sameWeek.add({ ...habit, id: 'b', firstWeek: '2026-09-28' });
    await sameWeek.add({ ...habit, id: 'a', firstWeek: '2026-09-28' });
    expect((await sameWeek.habits()).map((row) => row.id)).toEqual(['a', 'b']);
    await store.comment({ ...comment, id: 'd', createdAt: 200 });
    await store.comment({ ...comment, id: 'c', createdAt: 100 });
    expect((await store.comments(comment.week)).map((row) => row.id)).toEqual(['c', 'd']);
    const sameTime = new InMemoryHabitStore();
    await sameTime.comment({ ...comment, id: 'd', createdAt: 100 });
    await sameTime.comment({ ...comment, id: 'c', createdAt: 100 });
    expect((await sameTime.comments(comment.week)).map((row) => row.id)).toEqual(['c', 'd']);
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

it('soft-deletes comments without losing the start of history', async () => {
  const store = new InMemoryHabitStore();
  await store.comment(comment);
  expect(await store.findComment('c')).toEqual(comment);
  await store.deleteComment('c');
  expect(await store.findComment('c')).toBeNull();
  expect(await store.comments(comment.week)).toEqual([]);
  expect(await store.firstWeek()).toBe(comment.week);
});
it('binds comment lookup and soft deletion in Postgres', async () => {
  const query = vi.fn().mockResolvedValueOnce([comment]).mockResolvedValueOnce([]);
  const execute = vi.fn().mockResolvedValue(undefined);
  const store = new PostgresHabitStore({ query, execute });
  expect(await store.findComment('c')).toEqual(comment);
  expect(await store.findComment('missing')).toBeNull();
  await store.deleteComment('c');
  expect(execute).toHaveBeenCalledWith(expect.stringContaining('deleted_at = CURRENT_TIMESTAMP'), [
    'c',
  ]);
});

it('stores parameter-bound weekly text revisions', async () => {
  const query = vi.fn().mockResolvedValue([]);
  const execute = vi.fn().mockResolvedValue(undefined);
  const store = new PostgresHabitStore({ query, execute });
  await store.updateText('id', '2026-09-28', "User's text");
  expect(execute).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT'), [
    'id',
    '2026-09-28',
    "User's text",
  ]);
  await store.habits('2026-09-21');
  expect(query).toHaveBeenCalledWith(expect.stringContaining('r.week <= $1'), ['2026-09-21']);
});
