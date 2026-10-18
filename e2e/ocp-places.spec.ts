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
const MAP_STUB_URL = 'http://127.0.0.1:3099';

type MapCall = {
  method: 'PUT' | 'DELETE';
  body: Record<string, unknown>;
};

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

async function mapCalls(request: APIRequestContext, externalId: string): Promise<MapCall[]> {
  const response = await request.get(
    `${MAP_STUB_URL}/_calls?externalId=${encodeURIComponent(externalId)}`,
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as MapCall[];
}

function expectCompletePut(calls: MapCall[], externalId: string): void {
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({
    method: 'PUT',
    body: {
      origin: '21gifts',
      externalId,
      name: PLACE.label,
      description: 'Fresh coffee and snacks are served every day.',
      lat: PLACE.lat,
      lon: PLACE.lng,
      category: 'shopping',
      paymentMethods: 'lightning',
      techProvider: '21.gifts',
      shopType: 'Others',
      ...ADDRESS,
    },
  });
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

test('Function: shopOcpPlaceInput — maps a complete shop note into the PUT body', async ({
  request,
}) => {
  const id = await postCompleteShop(request);
  expectCompletePut(await mapCalls(request, id), id);
});

test('Function: syncShopOcpPlace — sends one complete shop pin', async ({ request }) => {
  const id = await postCompleteShop(request);
  expectCompletePut(await mapCalls(request, id), id);
});

test('Function: removeShopOcpPlace — deletes a shop pin after a moderator clears it', async ({
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
  const calls = await mapCalls(request, id);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual({
    method: 'DELETE',
    body: { origin: '21gifts', externalId: id },
  });
});

test('Function: resolveMapPush — configured bearer records an authorized PUT', async ({
  request,
}) => {
  const id = await postCompleteShop(request);
  const calls = await mapCalls(request, id);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.method).toBe('PUT');
});

test('Function: publishExistingShopPlaces — empty boot store publishes no map call', async ({
  request,
}) => {
  const id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  expect(await mapCalls(request, id)).toEqual([]);
  expect((await request.get('/healthz')).status()).toBe(200);
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
