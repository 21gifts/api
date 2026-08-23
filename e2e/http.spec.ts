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

test('GET /auth/lnurl issues a challenge', async ({ request }) => {
  const res = await request.get('/auth/lnurl');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { lnurl: string; k1: string; pollToken: string };
  expect(body.lnurl.startsWith('lnurl1') || body.lnurl.startsWith('LNURL1')).toBe(true);
  expect(body.k1.length).toBeGreaterThan(8);
  expect(body.pollToken.length).toBeGreaterThan(8);
});

test('GET /auth/lnurl/callback without params returns LUD-04 ERROR', async ({ request }) => {
  const res = await request.get('/auth/lnurl/callback');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { status: string };
  expect(body.status).toBe('ERROR');
});

test('GET /auth/session without poll token is expired', async ({ request }) => {
  const res = await request.get('/auth/session');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { status: string };
  expect(body.status).toBe('expired');
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

test('GET /lightning-address without address is 400', async ({ request }) => {
  const res = await request.get('/lightning-address');
  expect(res.status()).toBe(400);
});
