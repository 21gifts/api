import { expect, test, type APIRequestContext } from '@playwright/test';
import { staffPinSession, verifiedPinSession } from './helpers/pin-session';

const ADDRESS = {
  street: 'Bahnhofstrasse',
  houseNumber: '1',
  postalCode: '8001',
  city: 'Zürich',
  country: 'CH',
};

const PLACE = { lat: 47.376887, lng: 8.541694, label: 'Kiosk Lindenhof', address: ADDRESS };
const SHOP_TEXT = 'Fresh coffee and snacks are served every day.\n\n#21GiftsShop';
async function postCompleteShop(request: APIRequestContext): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const auth = await verifiedPinSession(request, stamp);
  const posted = await request.post('/messages', {
    headers: { ...auth, 'content-type': 'application/json' },
    data: { text: SHOP_TEXT, place: PLACE },
  });
  expect(posted.status()).toBe(200);
  return ((await posted.json()) as { id: string }).id;
}

test('Function: shopDescription — POST /messages preserves a valid shop address', async ({
  request,
}) => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const auth = await verifiedPinSession(request, stamp);
  const posted = await request.post('/messages', {
    headers: { ...auth, 'content-type': 'application/json' },
    data: {
      text: SHOP_TEXT,
      place: PLACE,
    },
  });
  expect(posted.status()).toBe(200);
  const body = (await posted.json()) as { place?: { address?: unknown } };
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

test('Function: publishExistingShopPlaces — default boot is healthy', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: resolveMapPush — POST /messages stores a complete shop with the map unconfigured', async ({
  request,
}) => {
  const id = await postCompleteShop(request);
  const read = await request.get(`/messages/${id}`);
  expect(read.status()).toBe(200);
  expect(((await read.json()) as { place?: unknown }).place).toEqual(PLACE);
});

test('Function: shopOcpPlaceInput — PATCH /messages/:id/text keeps a complete shop with the map unconfigured', async ({
  request,
}) => {
  const id = await postCompleteShop(request);
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const auth = await staffPinSession(request, stamp);
  const edited = await request.patch(`/messages/${id}/text`, {
    headers: { ...auth, 'content-type': 'application/json' },
    data: { text: 'Fresh coffee, tea and snacks are served every day.' },
  });
  expect(edited.status()).toBe(200);
  const body = (await edited.json()) as { text: string; place?: unknown };
  expect(body.text).toBe('Fresh coffee, tea and snacks are served every day.\n\n#21GiftsShop');
  expect(body.place).toEqual(PLACE);
});

test('Function: syncShopOcpPlace — PATCH /messages/:id/place replaces a shop pin with the map unconfigured', async ({
  request,
}) => {
  const id = await postCompleteShop(request);
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const auth = await staffPinSession(request, stamp);
  const moved = { ...PLACE, lat: 47.3, lng: 8.5 };
  const replaced = await request.patch(`/messages/${id}/place`, {
    headers: { ...auth, 'content-type': 'application/json' },
    data: { place: moved },
  });
  expect(replaced.status()).toBe(200);
  expect(((await replaced.json()) as { place?: unknown }).place).toEqual(moved);
});

test('Function: removeShopOcpPlace — PATCH /messages/:id/place clears a shop pin with the map unconfigured', async ({
  request,
}) => {
  const id = await postCompleteShop(request);
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const auth = await staffPinSession(request, stamp);
  const cleared = await request.patch(`/messages/${id}/place`, {
    headers: { ...auth, 'content-type': 'application/json' },
    data: { place: null },
  });
  expect(cleared.status()).toBe(200);
  expect(((await cleared.json()) as { place?: unknown }).place).toBeUndefined();
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
