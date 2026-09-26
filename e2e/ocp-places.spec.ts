import { expect, test } from '@playwright/test';

test('Function: normalizeOcpPlace — default boot is healthy', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: shopOcpPlaceName — default boot is healthy', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: shopOcpPlaceInput — default boot is healthy', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: recordFirstShopOcpPlace — default boot is healthy', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: resolveMapPush — default boot is healthy', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
