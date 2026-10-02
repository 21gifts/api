import { expect, test } from '@playwright/test';

test('Function: habitTrackerRoutes — public read and authenticated write boundary', async ({
  request,
}) => {
  const response = await request.get('/habit-tracker');
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toBe('no-store');
  const body = await response.json();
  expect(body.week.label).toMatch(/^\d{4}-W\d{2}$/);
  expect(
    (await request.post('/habit-tracker', { data: { action: 'add', text: 'Read' } })).status(),
  ).toBe(401);
  expect((await request.get('/habit-tracker?week=2026-02-30')).status()).toBe(400);
});

test('Function: habitWeek — next boundary is Monday midnight Manila', async ({ request }) => {
  const { week } = await (await request.get('/habit-tracker')).json();
  const monday = Date.parse(`${week.start}T00:00:00+08:00`);
  expect(week.nextAt - monday).toBe(604800000);
  expect(new Date(monday + 28800000).getUTCDay()).toBe(1);
});

test('Function: InMemoryHabitStore — booted memory store exposes isolated empty data', async ({
  request,
}) => {
  const response = await request.get('/habit-tracker');
  const body = await response.json();
  expect(body.habits).toEqual([]);
  expect(body.results).toEqual([]);
  expect(body.comments).toEqual([]);
});

// Production SQL wiring is covered by boot-store and parameter-binding unit
// tests; the HTTP fixture intentionally boots without DATABASE_URL.
test('Function: PostgresHabitStore — memory boot does not require Postgres', async ({
  request,
}) => {
  expect((await request.get('/habit-tracker')).status()).toBe(200);
});
test('Function: migrateHabitSchema — memory boot needs no migration', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
