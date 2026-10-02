import { expect, test } from '@playwright/test';

test('Function: activeShopDays — GET /shops/activity without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/shops/activity');
  expect(res.status()).toBe(401);
});

test('Function: shopActivityRoutes — GET /shops/activity without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/shops/activity');
  expect(res.status()).toBe(401);
});
