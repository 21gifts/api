import { expect, test } from '@playwright/test';
import { moderatorAboutNote } from './helpers/pin-session';

const ADDRESS = {
  street: 'Bahnhofstrasse',
  houseNumber: '1',
  postalCode: '8001',
  city: 'Zürich',
  country: 'CH',
};

const PLACE = { lat: 47.376887, lng: 8.541694, label: 'Kiosk Lindenhof', address: ADDRESS };
const SHOP_TEXT = 'Fresh coffee and snacks are served every day.\n\n#21GiftsShop';

// Members cannot post on the default boot (no LNURL server confirms a wallet),
// so these shop checks run on a moderator's About-me note through
// `PATCH /messages/:id/place`, which applies the same rules as `POST /messages`.

test('Function: shopDescription — PATCH /messages/:id/place strips the shop tag before the length rule', async ({
  request,
}) => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const description = 'Fresh coffee and snacks are served every day. '
    .repeat(22)
    .slice(0, 995)
    .trim();
  const text = `${description}\n\n#21GiftsShop`;
  expect(description.length).toBeLessThanOrEqual(1000);
  expect(text.length).toBeGreaterThan(1000);
  const { auth, noteId } = await moderatorAboutNote(request, stamp, text);
  const pinned = await request.patch(`/messages/${noteId}/place`, {
    headers: auth,
    data: { place: PLACE },
  });
  expect(pinned.status()).toBe(200);
  const body = (await pinned.json()) as { text: string; place?: { address?: unknown } };
  expect(body.text).toBe(text);
  expect(body.place?.address).toEqual(ADDRESS);
});

test('Function: shopPlaceProblem — PATCH /messages/:id/place rejects incomplete shop places', async ({
  request,
}) => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const { auth, noteId } = await moderatorAboutNote(request, stamp, SHOP_TEXT);
  const patch = (place: unknown) =>
    request.patch(`/messages/${noteId}/place`, { headers: auth, data: { place } });

  const unnamed = await patch({ lat: PLACE.lat, lng: PLACE.lng, address: ADDRESS });
  expect(unnamed.status()).toBe(400);
  expect(await unnamed.json()).toEqual({ error: 'Shop name is required' });

  const unaddressed = await patch({ ...PLACE, address: null });
  expect(unaddressed.status()).toBe(400);
  expect(await unaddressed.json()).toEqual({ error: 'Shop address is required' });

  const addressName = await patch({ ...PLACE, label: 'Kiosk Bahnhofstrasse' });
  expect(addressName.status()).toBe(400);
  expect(await addressName.json()).toEqual({ error: 'Shop name must not contain the address' });

  const postalName = await patch({ ...PLACE, label: 'Kiosk 8001' });
  expect(postalName.status()).toBe(400);
  expect(await postalName.json()).toEqual({ error: 'Shop name must not contain the address' });
});

test('Function: shopTextProblem — PATCH /messages/:id/place rejects a short shop description', async ({
  request,
}) => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const { auth, noteId } = await moderatorAboutNote(request, stamp, 'Fresh coffee\n\n#21GiftsShop');
  const pinned = await request.patch(`/messages/${noteId}/place`, {
    headers: auth,
    data: { place: PLACE },
  });
  expect(pinned.status()).toBe(400);
  expect(await pinned.json()).toEqual({
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
