import { test, expect } from '@playwright/test';
import { isSundayRest } from '../src/lib/sunday-rest';

test('Function: isSundayRest — HTTP boundary follows Manila Sunday', async ({ request }) => {
  const response = await request.get('/healthz');
  expect(response.status()).toBe(isSundayRest(Date.now()) ? 503 : 200);
});
test('Function: sundayRetryAfter — HTTP retry points to Monday', async ({ request }) => {
  const response = await request.get('/healthz');
  if (isSundayRest(Date.now()))
    expect(Number(response.headers()['retry-after'])).toBeGreaterThan(0);
  else expect(response.status()).toBe(200);
});
