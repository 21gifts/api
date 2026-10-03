import { expect, test } from '@playwright/test';

test('Function: activeShopDays — GET /shops/activity without bearer is 200', async ({
  request,
}) => {
  const res = await request.get('/shops/activity');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { days: unknown[] };
  expect(body.days).toHaveLength(30);
});

test('Function: shopActivityRoutes — GET /shops/activity without bearer is 200', async ({
  request,
}) => {
  const res = await request.get('/shops/activity');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { days: unknown[] };
  expect(body.days).toHaveLength(30);
});
