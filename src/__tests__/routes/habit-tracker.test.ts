import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import { InMemoryHabitStore } from '@/lib/habit-store';
import { habitWeek, type Habit, type HabitResult, type HabitComment } from '@/lib/habit-tracker';
import { habitTrackerRoutes } from '@/routes/habit-tracker';

async function payload(
  response: Promise<Response>,
): Promise<{ habits: Habit[]; results: HabitResult[]; comments: HabitComment[] }> {
  return (await (await response).json()) as {
    habits: Habit[];
    results: HabitResult[];
    comments: HabitComment[];
  };
}

async function setup() {
  let clock = Date.parse('2026-12-28T00:00:00+08:00');
  const authStore = new InMemoryAuthStore();
  const habitStore = new InMemoryHabitStore();
  for (const [id, role] of [
    ['f', 'founder'],
    ['i', 'initiator'],
    ['m', 'moderator'],
    ['v', 'verified'],
    ['b', 'basis'],
  ] as const) {
    await authStore.createAccount({
      id,
      role,
      name: id,
      linkingKey: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: id.repeat(64),
      createdAt: clock,
      rulesAgreedAt: null,
    } as Account);
    await authStore.createSession({ token: id, accountId: id, createdAt: clock });
  }
  const app = new Hono().route(
    '/habit-tracker',
    habitTrackerRoutes({ authStore, habitStore, now: () => clock }),
  );
  const post = (token: string, body: unknown) =>
    app.request('/habit-tracker', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const get = (week?: string) => app.request(`/habit-tracker${week ? `?week=${week}` : ''}`);
  return {
    authStore,
    habitStore,
    post,
    get,
    setClock: (time: string) => {
      clock = Date.parse(time);
    },
  };
}

describe('habit calendar', () => {
  it('rolls over at Manila midnight and uses ISO week years', () => {
    expect(habitWeek(Date.parse('2027-01-03T15:59:59.999Z')).label).toBe('2026-W53');
    expect(habitWeek(Date.parse('2027-01-03T16:00:00Z'))).toEqual({
      start: '2027-01-04',
      label: '2027-W01',
      nextAt: Date.parse('2027-01-10T16:00:00Z'),
    });
    expect(habitWeek(Date.parse('2025-12-28T16:00:00Z')).label).toBe('2026-W01');
  });
});

describe('habit permissions and history', () => {
  it('allows public reading, rejects invalid weeks and unauthenticated writes', async () => {
    const s = await setup();
    expect((await s.get()).status).toBe(200);
    for (const week of ['garbage', '2026-12-29', '2026-02-30', '2027-01-04'])
      expect((await s.get(week)).status).toBe(400);
    expect((await s.post('unknown', { action: 'add', text: 'Read' })).status).toBe(401);
    expect((await s.post('f', { action: 'add', text: ' ' })).status).toBe(400);
    expect((await s.post('f', { action: 'add', text: 'x'.repeat(201) })).status).toBe(400);
  });
  it('only lets founder and initiator add and rate their own resolutions', async () => {
    const s = await setup();
    for (const token of ['m', 'v', 'b'])
      expect((await s.post(token, { action: 'add', text: 'Read' })).status).toBe(403);
    expect((await s.post('f', { action: 'add', text: ' Read ' })).status).toBe(201);
    expect((await s.post('i', { action: 'add', text: 'Walk' })).status).toBe(201);
    const habit = (await s.habitStore.habits())[0]!;
    expect(habit.text).toBe('Read');
    for (const action of ['retire', 'rate']) {
      const body =
        action === 'rate'
          ? { action, id: habit.id, week: '2026-12-28', status: 'achieved' }
          : { action, id: habit.id };
      expect((await s.post('i', body)).status).toBe(404);
      expect((await s.post('m', body)).status).toBe(403);
    }
    for (const status of ['achieved', 'partial', 'missed'])
      expect(
        (await s.post('f', { action: 'rate', id: habit.id, week: '2026-12-28', status })).status,
      ).toBe(200);
    expect(await s.habitStore.results('2026-12-28')).toEqual([
      { habitId: habit.id, week: '2026-12-28', status: 'missed' },
    ]);
  });
  it('carries active resolutions without ratings, preserves archived history, and catches up after downtime', async () => {
    const s = await setup();
    await s.post('f', { action: 'add', text: 'Read' });
    await s.post('f', { action: 'add', text: 'Walk' });
    const [read, walk] = await s.habitStore.habits();
    await s.post('f', { action: 'rate', id: read!.id, week: '2026-12-28', status: 'achieved' });
    await s.post('f', { action: 'retire', id: read!.id });
    await s.post('f', { action: 'retire', id: read!.id });
    s.setClock('2027-01-04T00:00:00+08:00');
    const next = await payload(s.get());
    expect(next.habits.map((row: { id: string }) => row.id)).toEqual([walk!.id]);
    expect(next.results).toEqual([]);
    const past = await payload(s.get('2026-12-28'));
    expect(past.habits).toHaveLength(2);
    expect(past.results[0]!.status).toBe('achieved');
    expect(
      (await s.post('f', { action: 'rate', id: read!.id, week: '2027-01-04', status: 'partial' }))
        .status,
    ).toBe(409);
    expect(
      (await s.post('f', { action: 'rate', id: read!.id, week: '2026-12-28', status: 'partial' }))
        .status,
    ).toBe(200);
    s.setClock('2027-01-25T00:00:00+08:00');
    expect((await payload(s.get('2027-01-11'))).habits).toHaveLength(1);
    expect(
      (await s.post('f', { action: 'rate', id: walk!.id, week: '2026-12-28', status: 'achieved' }))
        .status,
    ).toBe(409);
  });
  it('stores comments from all signed-in roles only in their selected tracker week', async () => {
    const s = await setup();
    for (const token of ['f', 'i', 'm', 'v', 'b'])
      expect(
        (await s.post(token, { action: 'comment', week: '2026-12-28', text: 'Keep going' })).status,
      ).toBe(201);
    expect((await payload(s.get())).comments).toHaveLength(5);
    expect(
      (await s.post('unknown', { action: 'comment', week: '2026-12-28', text: 'Spam' })).status,
    ).toBe(401);
    expect(
      (await s.post('b', { action: 'comment', week: '2027-01-04', text: 'Future' })).status,
    ).toBe(400);
    expect(
      (await s.post('b', { action: 'comment', week: '2026-12-21', text: 'Past' })).status,
    ).toBe(400);
    expect((await s.post('b', { action: 'comment', week: '2026-12-28', text: ' ' })).status).toBe(
      400,
    );
    s.setClock('2027-01-04T00:00:00+08:00');
    expect((await payload(s.get())).comments).toHaveLength(0);
    expect((await payload(s.get('2026-12-28'))).comments).toHaveLength(5);
  });
});

it('rejects missing sessions and malformed JSON, and handles unnamed accounts', async () => {
  const authStore = new InMemoryAuthStore();
  const habitStore = new InMemoryHabitStore();
  const now = () => Date.parse('2026-12-28T00:00:00+08:00');
  await authStore.createAccount({
    id: 'anon',
    role: 'founder',
    name: null,
    linkingKey: null,
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    location: null,
    viewKey: 'a'.repeat(64),
    createdAt: now(),
    rulesAgreedAt: null,
  });
  await authStore.createSession({ token: 'unnamed', accountId: 'anon', createdAt: now() });
  const app = habitTrackerRoutes({ authStore, habitStore, now });
  expect((await app.request('/', { method: 'POST' })).status).toBe(401);
  const headers = { Authorization: 'Bearer unnamed', 'Content-Type': 'application/json' };
  expect((await app.request('/', { method: 'POST', headers, body: '{' })).status).toBe(400);
  for (const body of [
    { action: 'add', text: 'Read' },
    { action: 'comment', week: '2026-12-28', text: 'Hello' },
  ]) {
    expect(
      (await app.request('/', { method: 'POST', headers, body: JSON.stringify(body) })).status,
    ).toBe(201);
  }
  expect((await habitStore.habits())[0]!.name).toBe('');
  expect((await habitStore.comments('2026-12-28'))[0]!.name).toBe('');
});
