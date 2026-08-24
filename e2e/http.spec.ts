import { expect, test } from '@playwright/test';

test('GET /healthz is ok', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { status: string };
  expect(body.status).toBe('ok');
});

test('GET /info names the service', async ({ request }) => {
  const res = await request.get('/info');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { service: string };
  expect(body.service).toBe('21gifts-api');
});

test('GET /favicon.ico is an image', async ({ request }) => {
  const res = await request.get('/favicon.ico');
  expect(res.status()).toBe(200);
  const contentType = res.headers()['content-type'] ?? '';
  expect(contentType.startsWith('image/x-icon')).toBe(true);
  const cacheControl = res.headers()['cache-control'] ?? '';
  expect(cacheControl).toMatch(/public/);
  expect(cacheControl).toMatch(/max-age=86400/);
});

test('GET /favicon.svg is svg', async ({ request }) => {
  const res = await request.get('/favicon.svg');
  expect(res.status()).toBe(200);
  const contentType = res.headers()['content-type'] ?? '';
  expect(contentType.startsWith('image/svg+xml')).toBe(true);
  const cacheControl = res.headers()['cache-control'] ?? '';
  expect(cacheControl).toMatch(/public/);
  expect(cacheControl).toMatch(/max-age=86400/);
});

test('GET /apple-touch-icon.png is png', async ({ request }) => {
  const res = await request.get('/apple-touch-icon.png');
  expect(res.status()).toBe(200);
  const contentType = res.headers()['content-type'] ?? '';
  expect(contentType.startsWith('image/png')).toBe(true);
  const cacheControl = res.headers()['cache-control'] ?? '';
  expect(cacheControl).toMatch(/public/);
  expect(cacheControl).toMatch(/max-age=86400/);
});

test('GET /auth/lnurl is gone', async ({ request }) => {
  const res = await request.get('/auth/lnurl');
  expect(res.status()).toBe(404);
});

test('GET /auth/session is gone', async ({ request }) => {
  const res = await request.get('/auth/session');
  expect(res.status()).toBe(404);
});

test('POST /auth/passkey/register/begin issues a challenge', async ({ request }) => {
  const res = await request.post('/auth/passkey/register/begin');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { challengeId: string; options: unknown };
  expect(body.challengeId.length).toBeGreaterThan(8);
  expect(body.options).toBeTruthy();
});

test('GET /me without bearer is 401', async ({ request }) => {
  const res = await request.get('/me');
  expect(res.status()).toBe(401);
});

test('POST /me/name without bearer is 401', async ({ request }) => {
  const res = await request.post('/me/name', {
    data: { name: 'Ada' },
  });
  expect(res.status()).toBe(401);
});

test('POST /me/lightning-address without bearer is 401', async ({ request }) => {
  const res = await request.post('/me/lightning-address', {
    data: { address: 'a@b.com' },
  });
  expect(res.status()).toBe(401);
});

test('DELETE /me/lightning-address without bearer is 401', async ({ request }) => {
  const res = await request.delete('/me/lightning-address');
  expect(res.status()).toBe(401);
});

test('POST /me/lightning-address/verification without bearer is 401', async ({ request }) => {
  const res = await request.post('/me/lightning-address/verification');
  expect(res.status()).toBe(401);
});

test('POST /me/lightning-address/verification/confirm without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/me/lightning-address/verification/confirm', {
    data: { nonce: '00' },
  });
  expect(res.status()).toBe(401);
});

test('GET /debug/accounts without bearer is 401', async ({ request }) => {
  const res = await request.get('/debug/accounts');
  expect(res.status()).toBe(401);
});

test('GET /debug/accounts with the e2e token lists accounts', async ({ request }) => {
  const res = await request.get('/debug/accounts', {
    headers: { authorization: 'Bearer e2e-debug-token' },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { accounts: unknown[] };
  expect(Array.isArray(body.accounts)).toBe(true);
});

test('GET /lightning-address without address is 400', async ({ request }) => {
  const res = await request.get('/lightning-address');
  expect(res.status()).toBe(400);
});

test('GET /gifts/stats is empty without a database', async ({ request }) => {
  const res = await request.get('/gifts/stats');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    giftCount: number;
    totalBtc: string;
    totalUsd: string;
    fx: { quote: string; dayBasis: string; source: string };
  };
  expect(body.giftCount).toBe(0);
  expect(body.totalBtc).toBe('0.00000000');
  expect(body.totalUsd).toBe('0.00');
  expect(body.fx).toEqual({
    quote: 'BTC-USD',
    dayBasis: 'utc',
    source: 'coinbase-exchange-daily-close',
  });
});

test('POST /auth/passkey/register/begin issues options', async ({ request }) => {
  const res = await request.post('/auth/passkey/register/begin');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { challengeId: string; options: { challenge: string } };
  expect(body.challengeId.length).toBeGreaterThan(8);
  expect(body.options.challenge.length).toBeGreaterThan(8);
});

test('POST /auth/passkey/register/finish without body is 400', async ({ request }) => {
  const res = await request.post('/auth/passkey/register/finish');
  expect(res.status()).toBe(400);
});

test('POST /auth/passkey/authenticate/begin issues options', async ({ request }) => {
  const res = await request.post('/auth/passkey/authenticate/begin');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { challengeId: string };
  expect(body.challengeId.length).toBeGreaterThan(8);
});

test('POST /auth/passkey/authenticate/finish without body is 400', async ({ request }) => {
  const res = await request.post('/auth/passkey/authenticate/finish');
  expect(res.status()).toBe(400);
});

test('POST /invoices unconfigured is 503', async ({ request }) => {
  const res = await request.post('/invoices', {
    data: { address: 'alice@walletofsatoshi.com', amountMsat: 1000 },
  });
  expect(res.status()).toBe(503);
});

test('POST /invoices/proof unconfigured is 503', async ({ request }) => {
  const res = await request.post('/invoices/proof', {
    data: { id: 'x', preimage: '11'.repeat(32) },
  });
  expect(res.status()).toBe(503);
});
