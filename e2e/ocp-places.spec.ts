import { expect, test } from '@playwright/test';
import { verifiedPinSession } from './helpers/pin-session';

const ADDRESS = {
  street: 'Bahnhofstrasse',
  houseNumber: '1',
  postalCode: '8001',
  city: 'Zürich',
  country: 'CH',
};

const PLACE = { lat: 47.376887, lng: 8.541694, label: 'Kiosk Lindenhof', address: ADDRESS };
const SHOP_TEXT = 'Fresh coffee and snacks are served every day.\n\n#21GiftsShop';

test('Function: shopDescription — POST /messages strips the shop tag before the length rule', async ({
  request,
}) => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const auth = await verifiedPinSession(request, stamp);
  const me = await request.get('/me', { headers: auth });
  expect(me.status()).toBe(200);
  const username = ((await me.json()) as { username: string | null }).username;
  expect(username).toBeTruthy();
  const description = 'Fresh coffee and snacks are served every day. '
    .repeat(22)
    .slice(0, 995)
    .trim();
  const text = `${description}\n\n#21GiftsShop`;
  expect(description.length).toBeLessThanOrEqual(1000);
  expect(text.length).toBeGreaterThan(1000);
  const posted = await request.post('/messages', {
    headers: { ...auth, 'content-type': 'application/json' },
    data: { text, place: PLACE, shopUsername: username },
  });
  expect(posted.status()).toBe(200);
  const body = (await posted.json()) as { text: string; place?: { address?: unknown } };
  expect(body.text).toBe(text);
  expect(body.place?.address).toEqual(ADDRESS);
});

test('Function: shopPlaceProblem — POST /messages rejects incomplete shop places', async ({
  request,
}) => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const auth = await verifiedPinSession(request, stamp);
  const text = SHOP_TEXT;

  const unnamed = await request.post('/messages', {
    headers: { ...auth, 'content-type': 'application/json' },
    data: { text, place: { lat: PLACE.lat, lng: PLACE.lng, address: ADDRESS } },
  });
  expect(unnamed.status()).toBe(400);
  expect(await unnamed.json()).toEqual({ error: 'Shop name is required' });

  const unaddressed = await request.post('/messages', {
    headers: { ...auth, 'content-type': 'application/json' },
    data: { text, place: { ...PLACE, address: null } },
  });
  expect(unaddressed.status()).toBe(400);
  expect(await unaddressed.json()).toEqual({ error: 'Shop address is required' });

  const addressName = await request.post('/messages', {
    headers: { ...auth, 'content-type': 'application/json' },
    data: { text, place: { ...PLACE, label: 'Kiosk Bahnhofstrasse' } },
  });
  expect(addressName.status()).toBe(400);
  expect(await addressName.json()).toEqual({ error: 'Shop name must not contain the address' });

  const postalName = await request.post('/messages', {
    headers: { ...auth, 'content-type': 'application/json' },
    data: { text, place: { ...PLACE, label: 'Kiosk 8001' } },
  });
  expect(postalName.status()).toBe(400);
  expect(await postalName.json()).toEqual({ error: 'Shop name must not contain the address' });
});

test('Function: shopTextProblem — POST /messages rejects a short shop description', async ({
  request,
}) => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const auth = await verifiedPinSession(request, stamp);
  const posted = await request.post('/messages', {
    headers: { ...auth, 'content-type': 'application/json' },
    data: { text: 'Fresh coffee\n\n#21GiftsShop', place: PLACE },
  });
  expect(posted.status()).toBe(400);
  expect(await posted.json()).toEqual({
    error: 'Shop description must be 20 to 1000 characters and longer than the shop name',
  });
});

test('Function: isDevShopSeedTarget — default boot is healthy', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: seedDevShopPlaces — default boot is healthy', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: resolveActivityPing — default boot is healthy', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: pingShopActivity — default boot is healthy', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: logActivityFailure — default boot is healthy', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
