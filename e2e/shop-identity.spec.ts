import { deflateSync } from 'node:zlib';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { nip19 } from 'nostr-tools';

const PUBLIC_CACHE = 'public, max-age=60';
const DEBUG = { authorization: 'Bearer e2e-debug-token' };
const ADDRESS = {
  street: 'Bahnhofstrasse',
  houseNumber: '1',
  postalCode: '8001',
  city: 'Zürich',
  country: 'CH',
};

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** A valid RGB PNG of `width` × `height`, base64-encoded for `POST /messages`. */
function pngBase64(width: number, height: number): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc(height * (1 + width * 3), 0x80);
  for (let y = 0; y < height; y += 1) rows[y * (1 + width * 3)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', new Uint8Array()),
  ]).toString('base64');
}

interface ShopPhoto {
  url: string;
  width: number | null;
  height: number | null;
}

interface ShopBody {
  shop: {
    npub: string;
    messageId: string;
    name: string;
    description: string;
    place: { lat: number; lng: number; label: string; address: typeof ADDRESS };
    photos: ShopPhoto[];
    payUsername: string | null;
    nip05: string | null;
    createdAt: string;
  };
}

interface ListedShopFixture {
  /** Bearer headers of the shop author (a moderator). */
  auth: { authorization: string };
  /** Shop note id. */
  noteId: string;
  /** Shop name (pin label). */
  name: string;
  /** Shop npub answered by `POST /messages`. */
  npub: string;
  /** 64-hex shop public key. */
  pubkey: string;
  /** Till account username. */
  tillUsername: string;
}

/**
 * Provision a moderator author and a till account through `/debug/accounts`,
 * then post a complete `#21GiftsShop` note with a pin, the till account and
 * two photos (3×2 and 4×5 PNG). The memory boot creates the shop key.
 */
async function listedShop(request: APIRequestContext, tag: string): Promise<ListedShopFixture> {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 8)}`;
  const authorName = `E2eShopMod${tag}${stamp}`;
  const tillName = `E2eTill${tag}${stamp}`;
  const provision = await request.post('/debug/accounts', {
    headers: DEBUG,
    data: {
      accounts: [
        { name: authorName, lightningAddress: `e2e-shopmod-${stamp}@walletofsatoshi.com` },
        { name: tillName, lightningAddress: `e2e-till-${stamp}@walletofsatoshi.com` },
      ],
    },
  });
  expect(provision.status()).toBe(200);
  const listed = await request.get('/debug/accounts', { headers: DEBUG });
  expect(listed.status()).toBe(200);
  const accounts = (
    (await listed.json()) as {
      accounts: Array<{ id: string; name: string; username: string | null }>;
    }
  ).accounts;
  const author = accounts.find((row) => row.name === authorName);
  const till = accounts.find((row) => row.name === tillName);
  expect(author).toBeDefined();
  expect(till?.username).toBeTruthy();

  const session = await request.post(`/debug/accounts/${author?.id}/session`, { headers: DEBUG });
  expect(session.status()).toBe(200);
  const auth = { authorization: `Bearer ${((await session.json()) as { token: string }).token}` };
  expect((await request.post('/me/rules-agreement', { headers: auth })).status()).toBe(200);
  const promoted = await request.patch(`/debug/accounts/${author?.id}`, {
    headers: DEBUG,
    data: { role: 'moderator' },
  });
  expect(promoted.status()).toBe(200);

  const name = `Cafe ${tag} ${stamp}`;
  const posted = await request.post('/messages', {
    headers: { ...auth, 'content-type': 'application/json' },
    data: {
      text: `Coffee roasted on site and served at the bar every morning by ${name}.\n\n#21GiftsShop`,
      place: { lat: 47.3769, lng: 8.5417, label: name, address: ADDRESS },
      shopUsername: till?.username,
      photos: [
        { contentType: 'image/png', data: pngBase64(3, 2) },
        { contentType: 'image/png', data: pngBase64(4, 5) },
      ],
    },
  });
  expect(posted.status()).toBe(200);
  const note = (await posted.json()) as { id: string; shopNpub: string | null };
  expect(note.shopNpub).toMatch(/^npub1[02-9ac-hj-np-z]{58}$/);
  const npub = note.shopNpub as string;
  const pubkey = nip19.decode(npub as nip19.NPub).data;
  return { auth, noteId: note.id, name, npub, pubkey, tillUsername: till?.username as string };
}

async function getShop(request: APIRequestContext, segment: string): Promise<ShopBody> {
  const response = await request.get(`/shops/${segment}`);
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toBe(PUBLIC_CACHE);
  return (await response.json()) as ShopBody;
}

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
  expect(response.status()).toBe(200);
});

test('e2e: listed shop is 200, hex is 301, hide is 410, restore is 200 again', async ({
  request,
}) => {
  const shop = await listedShop(request, 'Flow');
  const body = await getShop(request, shop.npub);
  expect(body.shop.npub).toBe(shop.npub);
  expect(body.shop.messageId).toBe(shop.noteId);

  const hex = await request.get(`/shops/${shop.pubkey}`, { maxRedirects: 0 });
  expect(hex.status()).toBe(301);
  expect(hex.headers()['location']).toBe(`/shops/${shop.npub}`);

  const hidden = await request.delete(`/messages/${shop.noteId}`, { headers: shop.auth });
  expect(hidden.status()).toBe(204);
  const gone = await request.get(`/shops/${shop.npub}`);
  expect(gone.status()).toBe(410);
  expect(gone.headers()['cache-control']).toBe(PUBLIC_CACHE);
  expect(await gone.json()).toEqual({ error: 'Shop is no longer listed', npub: shop.npub });

  const restored = await request.post(`/debug/messages/${shop.noteId}/restore`, {
    headers: DEBUG,
  });
  expect(restored.status()).toBe(204);
  expect((await getShop(request, shop.npub)).shop.npub).toBe(shop.npub);
});

test('Function: shopRoutes — GET /shops/:npub answers the listed shop', async ({ request }) => {
  const shop = await listedShop(request, 'Route');
  const body = await getShop(request, shop.npub);
  expect(body.shop).toMatchObject({
    npub: shop.npub,
    messageId: shop.noteId,
    name: shop.name,
    payUsername: shop.tillUsername,
    nip05: null,
  });
  expect(body.shop.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  await expectNotFound(request, `/shops/${'22'.repeat(32)}`);
});

test('Function: InMemoryShopIdentityStore — the memory boot keeps one key per shop', async ({
  request,
}) => {
  const shop = await listedShop(request, 'Mem');
  const hex = await request.get(`/shops/${shop.pubkey}`, { maxRedirects: 0 });
  expect(hex.status()).toBe(301);
  expect(hex.headers()['location']).toBe(`/shops/${shop.npub}`);
  const edited = await request.patch(`/messages/${shop.noteId}/text`, {
    headers: { ...shop.auth, 'content-type': 'application/json' },
    data: {
      text: `Fresh coffee and cake served all day long at ${shop.name}.\n\n#21GiftsShop`,
    },
  });
  expect(edited.status()).toBe(200);
  expect(((await edited.json()) as { shopNpub: string | null }).shopNpub).toBe(shop.npub);
});

test('Function: listedShop — GET /shops/:npub carries the name, pin and description', async ({
  request,
}) => {
  const shop = await listedShop(request, 'Pin');
  const body = await getShop(request, shop.npub);
  expect(body.shop.place).toEqual({
    lat: 47.3769,
    lng: 8.5417,
    label: shop.name,
    address: ADDRESS,
  });
  expect(body.shop.description).toBe(
    `Coffee roasted on site and served at the bar every morning by ${shop.name}.`,
  );
});

/** NIP-05 local part of a fresh shop name (no collision: the name carries a stamp). */
function shopLocal(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

/**
 * `GET /.well-known/nostr.json?name=` until it answers `local`. The directory
 * is cached; a name it does not hold forces one fresh directory, at most once
 * per 10 s (`NIP05_DIRECTORY_REFRESH_MS`), so a parallel test's refresh can
 * delay this one by that gap.
 */
async function pollNip05(
  request: APIRequestContext,
  local: string,
): Promise<Record<string, string>> {
  let names: Record<string, string> = {};
  await expect
    .poll(
      async () => {
        const response = await request.get(`/.well-known/nostr.json?name=${local}`);
        expect(response.status()).toBe(200);
        names = ((await response.json()) as { names: Record<string, string> }).names;
        return names[local] ?? null;
      },
      { timeout: 20_000, intervals: [250, 500, 1_000] },
    )
    .not.toBeNull();
  return names;
}

test('Function: listedShopName — nostr.json names the shop after its pin label', async ({
  request,
}) => {
  const shop = await listedShop(request, 'Nip');
  const local = shopLocal(shop.name);
  expect((await pollNip05(request, local))[local]).toBe(shop.pubkey);
});

test('Function: listShopNip05Entries — GET /.well-known/nostr.json?name= answers the shop key', async ({
  request,
}) => {
  const shop = await listedShop(request, 'Dir');
  const local = shopLocal(shop.name);
  expect(await pollNip05(request, local)).toEqual({ [local]: shop.pubkey });
});

test('Function: nip05Directory — the full nostr.json carries a shop once a ?name= refresh found it', async ({
  request,
}) => {
  const shop = await listedShop(request, 'Cache');
  const local = shopLocal(shop.name);
  await pollNip05(request, local);
  // The forced refresh replaced the shared cache, so the full body has it too.
  const all = await request.get('/.well-known/nostr.json');
  expect(all.status()).toBe(200);
  expect(((await all.json()) as { names: Record<string, string> }).names[local]).toBe(shop.pubkey);
});

test('Function: isListedShop — removing the till account unlists the shop', async ({ request }) => {
  const shop = await listedShop(request, 'Unl');
  const cleared = await request.patch(`/messages/${shop.noteId}/shop-account`, {
    headers: { ...shop.auth, 'content-type': 'application/json' },
    data: { username: null },
  });
  expect(cleared.status()).toBe(200);
  expect(((await cleared.json()) as { shopNpub: string | null }).shopNpub).toBeNull();
  const note = await request.get(`/messages/${shop.noteId}`);
  expect(note.status()).toBe(200);
  expect(((await note.json()) as { shopNpub: string | null }).shopNpub).toBeNull();
  const gone = await request.get(`/shops/${shop.npub}`);
  expect(gone.status()).toBe(410);
});

test('Function: shopNpub — GET /messages/:id and GET /messages/places carry the shop npub', async ({
  request,
}) => {
  const shop = await listedShop(request, 'Npub');
  const note = await request.get(`/messages/${shop.noteId}`);
  expect(note.status()).toBe(200);
  expect(((await note.json()) as { shopNpub: string | null }).shopNpub).toBe(shop.npub);
  const places = await request.get('/messages/places', { headers: shop.auth });
  expect(places.status()).toBe(200);
  const row = (
    (await places.json()) as { places: Array<{ id: string; shop: unknown; shopNpub: unknown }> }
  ).places.find((item) => item.id === shop.noteId);
  expect(row?.shopNpub).toBe(shop.npub);
  expect(nip19.npubEncode(shop.pubkey)).toBe(shop.npub);
});

test('Function: imageHeaderSize — GET /shops/:npub reports each photo size', async ({
  request,
}) => {
  const shop = await listedShop(request, 'Img');
  const body = await getShop(request, shop.npub);
  expect(body.shop.photos).toEqual([
    {
      url: expect.stringMatching(new RegExp(`/messages/${shop.noteId}/photo\\.png$`)),
      width: 3,
      height: 2,
    },
    {
      url: expect.stringMatching(new RegExp(`/messages/${shop.noteId}/photo/1\\.png$`)),
      width: 4,
      height: 5,
    },
  ]);
  const cover = await request.get(`/messages/${shop.noteId}/photo`);
  expect(cover.status()).toBe(200);
});

// Exceptions (CONTRIBUTING.md E2E): these need DATABASE_URL, NOSTR_NSEC_KEK with a
// publisher, or the OpenCryptoPay map target, all blank in webServer.env. Each test
// proves the default boot serves a listed shop without them.

test('Function: migrateShopIdentitySchema — DATABASE_URL blank still serves a listed shop', async ({
  request,
}) => {
  const shop = await listedShop(request, 'NoMig');
  expect((await getShop(request, shop.npub)).shop.npub).toBe(shop.npub);
});

test('Function: PostgresShopIdentityStore — DATABASE_URL blank keeps shop keys in memory', async ({
  request,
}) => {
  const shop = await listedShop(request, 'NoPg');
  expect((await getShop(request, shop.pubkey)).shop.npub).toBe(shop.npub);
});

test('Function: signEventForShop — no publisher, the shop is served without a kind 0', async ({
  request,
}) => {
  const shop = await listedShop(request, 'NoSig');
  expect((await getShop(request, shop.npub)).shop.nip05).toBeNull();
});

async function servedWithoutMap(request: APIRequestContext, tag: string): Promise<void> {
  const shop = await listedShop(request, tag);
  expect((await getShop(request, shop.npub)).shop.photos).toHaveLength(2);
}

test('Function: runOcpPlaceOutboxPass — OCP map target blank, the listed shop is still served', ({
  request,
}) => servedWithoutMap(request, 'OcpPl'));

test('Function: runOcpPhotoOutboxPass — OCP map target blank, the listed shop is still served', ({
  request,
}) => servedWithoutMap(request, 'OcpPh'));

test('Function: ocpPhotoSetHash — OCP map target blank, the listed shop is still served', ({
  request,
}) => servedWithoutMap(request, 'OcpHs'));

test('Function: queueAllShopPlaces — OCP map target blank, the listed shop is still served', ({
  request,
}) => servedWithoutMap(request, 'OcpQ'));

test('Function: startOcpOutboxWorker — OCP map target blank, the listed shop is still served', ({
  request,
}) => servedWithoutMap(request, 'OcpW'));
