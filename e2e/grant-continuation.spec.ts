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

test('Function: grantContinuationRoutes — GET /funding/goal with DEBUG_TOKEN is 200', async ({
  request,
}) => {
  const res = await request.get('/funding/goal', {
    headers: { authorization: 'Bearer e2e-debug-token' },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { days: unknown[]; qualifyingShops: number };
  expect(body.days).toHaveLength(7);
  expect(body.qualifyingShops).toBe(0);
});
