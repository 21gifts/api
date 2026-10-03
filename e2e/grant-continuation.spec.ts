import { expect, test } from '@playwright/test';

test('Function: measureGrantContinuation — GET /funding/goal without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/funding/goal');
  expect(res.status()).toBe(401);
});

test('Function: grantContinuationRoutes — GET /funding/goal without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/funding/goal');
  expect(res.status()).toBe(401);
  expect(await res.json()).toEqual({ error: 'Unauthorized' });
});
