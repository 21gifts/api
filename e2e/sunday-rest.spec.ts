import { test, expect } from '@playwright/test';

const sundayOrigin = 'http://127.0.0.1:3002';

test('Function: isSundayRest — HTTP boundary follows Manila Sunday', async ({ request }) => {
  const response = await request.get(`${sundayOrigin}/info`);
  expect(response.status()).toBe(503);
  expect(await response.text()).toContain('Christ is risen!');
  expect((await request.get(`${sundayOrigin}/healthz`)).status()).toBe(200);
  expect((await request.get('/info')).status()).toBe(200);
});
test('Function: sundayRetryAfter — HTTP retry points to Monday', async ({ request }) => {
  const response = await request.post(`${sundayOrigin}/messages`, { data: { text: 'Sunday' } });
  expect(response.status()).toBe(503);
  expect(Number(response.headers()['retry-after'])).toBeGreaterThan(0);
  expect(response.headers()['cache-control']).toBe('no-store');
});

test('Function: sundayRestResponse — Sunday boot serves the API error contract without booting business services', async ({
  request,
}) => {
  const response = await request.get(`${sundayOrigin}/info`);
  expect(response.status()).toBe(503);
  expect(await response.json()).toMatchObject({
    error: 'SUNDAY_REST',
    timeZone: 'Asia/Manila',
    message: expect.stringContaining('Christ is risen!'),
  });
});
