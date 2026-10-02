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

test('Function: habitWeek — ISO review week carries a Monday date', async ({ request }) => {
  const { week } = await (await request.get('/habit-tracker')).json();
  const monday = Date.parse(`${week.start}T00:00:00+08:00`);
  expect(week.nextAt - monday).toBe(2 * 604800000 + 28800000);
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

test('Function: habitReviewWeek — default response represents the completed previous week', async ({
  request,
}) => {
  const body = await (await request.get('/habit-tracker')).json();
  const monday = Date.parse(`${body.week.start}T00:00:00+08:00`);
  expect(Date.now()).toBeGreaterThanOrEqual(monday + 604800000 + 28800000);
  expect(Date.now()).toBeLessThan(body.week.nextAt);
  expect(body.currentWeek).toBe(body.week.start);
});
test('Function: habitCommentsAllowedAt — opening time is Monday afternoon after the completed week', async ({
  request,
}) => {
  const body = await (await request.get('/habit-tracker')).json();
  expect(body.commentsAllowedAt).toBe(Date.parse(`${body.week.start}T16:00:00+08:00`) + 604800000);
});
test('Function: habitCommentsCloseAt — the comment period ends Saturday evening', async ({
  request,
}) => {
  const body = await (await request.get('/habit-tracker')).json();
  expect(body.commentsCloseAt - body.commentsAllowedAt).toBe((5 * 24 + 4) * 3600000);
});
test('Function: habitCommentsAllowed — historical comments are read only', async ({ request }) => {
  const body = await (await request.get('/habit-tracker')).json();
  const previous = new Date(Date.parse(`${body.currentWeek}T00:00:00Z`) - 604800000)
    .toISOString()
    .slice(0, 10);
  const history = await (await request.get(`/habit-tracker?week=${previous}`)).json();
  expect(history.commentsAllowed).toBe(false);
});
