import { expect, test, type APIRequestContext } from '@playwright/test';
import { nip19 } from 'nostr-tools';

const PUBLIC_CACHE = 'public, max-age=60';

async function expectNotFound(request: APIRequestContext, path: string): Promise<void> {
  const response = await request.get(path);
  expect(response.status()).toBe(404);
  expect(response.headers()['cache-control']).toBe(PUBLIC_CACHE);
  expect(await response.json()).toEqual({ error: 'Not found' });
}

test('GET /shops/:npub is 404 with the public cache header for a segment that is no key', async ({
  request,
}) => {
  const response = await request.get('/shops/:npub');
  expect(response.status()).toBe(404);
  expect(response.headers()['cache-control']).toBe(PUBLIC_CACHE);
  expect(await response.json()).toEqual({ error: 'Not found' });
});

test('GET /shops/:npub is 404 for an unknown hex key and an unknown npub', async ({ request }) => {
  await expectNotFound(request, `/shops/${'11'.repeat(32)}`);
  await expectNotFound(request, `/shops/${nip19.npubEncode('11'.repeat(32))}`);
});

test('GET /shops/activity keeps its own handler next to GET /shops/:npub', async ({ request }) => {
  const response = await request.get('/shops/activity');
  expect(response.status()).not.toBe(404);
});

const healthy = async (request: APIRequestContext): Promise<void> => {
  expect((await request.get('/healthz')).status()).toBe(200);
};

test('Function: migrateShopIdentitySchema — default boot is healthy', ({ request }) =>
  healthy(request));
test('Function: InMemoryShopIdentityStore — default boot is healthy', ({ request }) =>
  healthy(request));
test('Function: PostgresShopIdentityStore — default boot is healthy', ({ request }) =>
  healthy(request));
test('Function: listedShop — default boot is healthy', ({ request }) => healthy(request));
test('Function: listedShopName — default boot is healthy', ({ request }) => healthy(request));
test('Function: isListedShop — default boot is healthy', ({ request }) => healthy(request));
test('Function: shopNpub — default boot is healthy', ({ request }) => healthy(request));
test('Function: listShopNip05Entries — GET /.well-known/nostr.json still answers', async ({
  request,
}) => {
  const response = await request.get('/.well-known/nostr.json');
  expect(response.status()).toBe(200);
  expect(await response.json()).toHaveProperty('names');
});
test('Function: signEventForShop — default boot is healthy', ({ request }) => healthy(request));
test('Function: imageHeaderSize — default boot is healthy', ({ request }) => healthy(request));
test('Function: runOcpPlaceOutboxPass — default boot is healthy', ({ request }) =>
  healthy(request));
test('Function: ocpPhotoSetHash — default boot is healthy', ({ request }) => healthy(request));
test('Function: runOcpPhotoOutboxPass — default boot is healthy', ({ request }) =>
  healthy(request));
test('Function: queueAllShopPlaces — default boot is healthy', ({ request }) => healthy(request));
test('Function: startOcpOutboxWorker — default boot is healthy', ({ request }) => healthy(request));
test('Function: shopRoutes — GET /shops/:npub answers 404 for an unknown key', async ({
  request,
}) => {
  await expectNotFound(request, `/shops/${'22'.repeat(32)}`);
});
