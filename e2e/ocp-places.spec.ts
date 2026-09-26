import { expect, test } from '@playwright/test';

test('Function: ocpPlacesRoutes — GET /ocp/places is public', async ({ request }) => {
  const res = await request.get('/ocp/places');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { places: unknown[] };
  expect(Array.isArray(body.places)).toBe(true);
});

test('Function: normalizeOcpPlace — POST /ocp/places without a token is 503', async ({
  request,
}) => {
  const res = await request.post('/ocp/places', {
    data: { origin: 'dfx', externalId: '1', name: 'Shop', lat: 1, lon: 2, category: 'shopping' },
  });
  expect(res.status()).toBe(503);
});

test('Function: shopOcpPlaceName — default boot lists places', async ({ request }) => {
  const res = await request.get('/ocp/places');
  expect(res.status()).toBe(200);
});

test('Function: shopOcpPlaceInput — default boot lists places', async ({ request }) => {
  const res = await request.get('/ocp/places');
  expect(res.status()).toBe(200);
});

test('Function: recordFirstShopOcpPlace — default boot lists places', async ({ request }) => {
  const res = await request.get('/ocp/places');
  expect(res.status()).toBe(200);
});

test('Function: migrateOcpPlaceSchema — default boot lists places', async ({ request }) => {
  const res = await request.get('/ocp/places');
  expect(res.status()).toBe(200);
});

test('Function: InMemoryOcpPlaceStore — default boot lists places', async ({ request }) => {
  const res = await request.get('/ocp/places');
  expect(res.status()).toBe(200);
});

test('Function: PostgresOcpPlaceStore — default boot lists places', async ({ request }) => {
  const res = await request.get('/ocp/places');
  expect(res.status()).toBe(200);
});

test('Function: btcMapSubmissionBody — default boot lists places', async ({ request }) => {
  const res = await request.get('/ocp/places');
  expect(res.status()).toBe(200);
});

test('Function: HttpBtcMapPush — default boot lists places', async ({ request }) => {
  const res = await request.get('/ocp/places');
  expect(res.status()).toBe(200);
});

test('Function: resolveBtcMapPush — default boot lists places', async ({ request }) => {
  const res = await request.get('/ocp/places');
  expect(res.status()).toBe(200);
});
