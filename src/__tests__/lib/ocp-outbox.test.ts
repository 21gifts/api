import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unsignedNostrDefaults, type ForumPhoto, type MessageRow } from '@/lib/message';
import { InMemoryMessageStore, type MessageStore } from '@/lib/message-store';
import type { MapPush } from '@/lib/ocp-place';
import {
  OCP_LEASE_MARGIN_MS,
  OCP_PHOTO_TIMEOUT_MS,
  OCP_PLACE_TIMEOUT_MS,
  ocpPhotoSetHash,
  queueAllShopPlaces,
  runOcpPhotoOutboxPass,
  runOcpPlaceOutboxPass,
  startOcpOutboxWorker,
  type OcpOutboxDeps,
} from '@/lib/ocp-outbox';
import {
  InMemoryShopIdentityStore,
  type ShopIdentityRow,
  type ShopIdentityStore,
  type ShopOcpClaim,
} from '@/lib/shop-identity';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PUBKEY = 'ab'.repeat(32);
const TEXT = 'Fresh coffee roasted here every morning. #21GiftsShop';
const CLAIM: ShopOcpClaim = { messageId: ID, generation: 1, claim: 1 };
const PNG: ForumPhoto = { contentType: 'image/png', bytes: new Uint8Array([1, 2, 3]) };
const JPEG: ForumPhoto = { contentType: 'image/jpeg', bytes: new Uint8Array([4, 5]) };

function shopNote(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: ID,
    accountId: 'author',
    name: 'Ada',
    text: TEXT,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    hasPhoto: false,
    ...unsignedNostrDefaults(),
    place: {
      lat: 47.3,
      lng: 8.5,
      label: 'Coffee Lab',
      address: {
        street: 'Main Street',
        houseNumber: '1',
        postalCode: '8001',
        city: 'Zürich',
        country: 'CH',
      },
    },
    shopAccount: { id: 'till', username: 'coffee', name: 'Coffee' },
    ...overrides,
  };
}

function identity(overrides: Partial<ShopIdentityRow> = {}): ShopIdentityRow {
  return {
    messageId: ID,
    nostrPubkey: PUBKEY,
    nostrNsecCiphertext: new Uint8Array([1]),
    nostrKekId: 1,
    nostrKeyCustody: 'custodial',
    nostrKeyCreatedAt: new Date(0),
    profileName: 'Coffee Lab',
    ocpPhotosHash: null,
    ocpPhotosPending: true,
    ocpPhotosGeneration: 1,
    ocpPhotosClaimedUntil: null,
    ocpPhotosClaim: 1,
    ocpPlacePending: true,
    ocpPlaceGeneration: 1,
    ocpPlaceClaimedUntil: null,
    ocpPlaceClaim: 1,
    ocpRevision: 0,
    ...overrides,
  };
}

type Stub = { [K in keyof ShopIdentityStore]: ReturnType<typeof vi.fn> };

function stubIdentities(row: ShopIdentityRow | null = identity()): Stub {
  return {
    ensureListed: vi.fn(),
    getByMessageId: vi.fn(() => Promise.resolve(row ?? undefined)),
    getByPubkey: vi.fn(),
    getNostrCiphertext: vi.fn(),
    listAll: vi.fn(),
    renameIfListed: vi.fn(),
    listCandidates: vi.fn(),
    queueAllPlacePage: vi.fn(),
    claimPlaces: vi.fn(() => Promise.resolve([CLAIM])),
    claimPhoto: vi.fn(() => Promise.resolve(CLAIM)),
    leaseHasTime: vi.fn(() => Promise.resolve(true)),
    nextRevision: vi.fn(() => Promise.resolve(7)),
    release: vi.fn(() => Promise.resolve()),
    resetPhotosForDelete: vi.fn(() => Promise.resolve()),
    finishPlace: vi.fn(() => Promise.resolve()),
    clearPhotoWithoutSend: vi.fn(() => Promise.resolve()),
    clearPhotoHash: vi.fn(() => Promise.resolve()),
    finishPhotos: vi.fn(() => Promise.resolve()),
    missingPhotoPlace: vi.fn(() => Promise.resolve()),
    deferPhotos: vi.fn(() => Promise.resolve()),
  };
}

type Sent = { url: string; method: string; body: Record<string, unknown>; init: RequestInit };

function mapPush(answer: (url: string) => Response | Promise<Response>): {
  push: MapPush;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const push: MapPush = {
    baseUrl: 'https://map.test',
    token: 'secret',
    fetchImpl: (async (url: string, init: RequestInit) => {
      sent.push({
        url,
        method: String(init.method),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
        init,
      });
      return answer(url);
    }) as unknown as MapPush['fetchImpl'],
  };
  return { push, sent };
}

async function messagesWith(
  row: MessageRow,
  photos: ForumPhoto[] = [],
): Promise<InMemoryMessageStore> {
  const messages = new InMemoryMessageStore();
  await messages.create(row, photos[0], undefined, photos.slice(1));
  return messages;
}

function deps(
  identities: Stub | ShopIdentityStore,
  messages: MessageStore,
  push: MapPush,
): OcpOutboxDeps {
  return { identities: identities as unknown as ShopIdentityStore, messages, mapPush: push };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  vi.useRealTimers();
});

function logged(event: string): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
    .filter((line) => line['event'] === event);
}

describe('runOcpPlaceOutboxPass', () => {
  it('puts a listed shop with its key and revision, then queues its photos', async () => {
    const messages = await messagesWith(shopNote());
    const { push, sent } = mapPush(() => new Response('{}', { status: 200 }));
    const ids = stubIdentities();
    await runOcpPlaceOutboxPass(deps(ids, messages, push));
    expect(ids.claimPlaces).toHaveBeenCalledWith(20, 60_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ url: 'https://map.test/map/places', method: 'PUT' });
    expect(sent[0]?.body).toMatchObject({
      origin: '21gifts',
      externalId: ID,
      name: 'Coffee Lab',
      nostrPubkey: PUBKEY,
      revision: 7,
    });
    expect((sent[0]?.init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer secret',
    );
    expect(ids.leaseHasTime).toHaveBeenCalledWith(
      'place',
      CLAIM,
      OCP_PLACE_TIMEOUT_MS + OCP_LEASE_MARGIN_MS,
    );
    expect(ids.resetPhotosForDelete).not.toHaveBeenCalled();
    expect(ids.finishPlace).toHaveBeenCalledWith(CLAIM, 'put');
  });

  it('records 201 as a created place', async () => {
    const messages = await messagesWith(shopNote());
    const { push } = mapPush(() => new Response('{}', { status: 201 }));
    const ids = stubIdentities();
    await runOcpPlaceOutboxPass(deps(ids, messages, push));
    expect(ids.finishPlace).toHaveBeenCalledWith(CLAIM, 'created');
  });

  it('resets the photos and deletes a shop that is not listed', async () => {
    const messages = await messagesWith(shopNote({ text: 'Only coffee here, no tag at all.' }));
    const { push, sent } = mapPush(() => new Response('{"deleted":false}', { status: 200 }));
    const ids = stubIdentities();
    await runOcpPlaceOutboxPass(deps(ids, messages, push));
    expect(ids.resetPhotosForDelete).toHaveBeenCalledWith(CLAIM);
    expect(sent[0]?.method).toBe('DELETE');
    expect(sent[0]?.body).toEqual({ origin: '21gifts', externalId: ID, revision: 7 });
    expect(ids.finishPlace).toHaveBeenCalledWith(CLAIM, 'delete');
  });

  it('deletes when the note is gone', async () => {
    const messages = { getById: () => Promise.resolve(undefined) } as unknown as MessageStore;
    const { push, sent } = mapPush(() => new Response(null, { status: 204 }));
    const ids = stubIdentities();
    await runOcpPlaceOutboxPass(deps(ids, messages, push));
    expect(sent[0]?.method).toBe('DELETE');
    expect(ids.finishPlace).toHaveBeenCalledWith(CLAIM, 'delete');
  });

  it('releases a row whose identity vanished', async () => {
    const messages = await messagesWith(shopNote());
    const { push, sent } = mapPush(() => new Response('{}'));
    const ids = stubIdentities(null);
    await runOcpPlaceOutboxPass(deps(ids, messages, push));
    expect(ids.release).toHaveBeenCalledWith('place', CLAIM);
    expect(sent).toEqual([]);
  });

  it('sends nothing when the claim was taken over', async () => {
    const messages = await messagesWith(shopNote());
    const { push, sent } = mapPush(() => new Response('{}'));
    const ids = stubIdentities();
    ids.nextRevision.mockResolvedValueOnce(undefined);
    await runOcpPlaceOutboxPass(deps(ids, messages, push));
    expect(sent).toEqual([]);
    expect(ids.release).not.toHaveBeenCalled();
  });

  it('releases and skips when the lease is too short', async () => {
    const messages = await messagesWith(shopNote());
    const { push, sent } = mapPush(() => new Response('{}'));
    const ids = stubIdentities();
    ids.leaseHasTime.mockResolvedValueOnce(false);
    await runOcpPlaceOutboxPass(deps(ids, messages, push));
    expect(sent).toEqual([]);
    expect(ids.release).toHaveBeenCalledWith('place', CLAIM);
  });

  it('only releases on 409 Stale revision', async () => {
    const messages = await messagesWith(shopNote());
    const { push } = mapPush(() => new Response('{"error":"Stale revision"}', { status: 409 }));
    const ids = stubIdentities();
    await runOcpPlaceOutboxPass(deps(ids, messages, push));
    expect(ids.release).toHaveBeenCalledWith('place', CLAIM);
    expect(ids.finishPlace).not.toHaveBeenCalled();
  });

  it('logs ocp.place.rejected and clears the flag on 400 or another 409', async () => {
    for (const [status, text] of [
      [400, '{"error":"Place NOSTR public key is required"}'],
      [409, '{"error":"nostrPubkey belongs to another place"}'],
    ] as const) {
      const messages = await messagesWith(shopNote());
      const { push } = mapPush(() => new Response(text, { status }));
      const ids = stubIdentities();
      await runOcpPlaceOutboxPass(deps(ids, messages, push));
      expect(ids.finishPlace).toHaveBeenCalledWith(CLAIM, 'reject');
    }
    expect(logged('ocp.place.rejected')).toEqual([
      expect.objectContaining({ messageId: ID, status: 400 }),
      expect.objectContaining({ messageId: ID, status: 409 }),
    ]);
  });

  it('defers the place while OpenCryptoPay does not know nostrPubkey or revision', async () => {
    for (const [method, note, field] of [
      ['PUT', shopNote(), 'nostrPubkey'],
      ['PUT', shopNote(), 'revision'],
      ['DELETE', shopNote({ shopAccount: null }), 'revision'],
    ] as const) {
      const messages = await messagesWith(note);
      const { push, sent } = mapPush(
        () =>
          new Response(JSON.stringify({ error: `Place field is not allowed: ${field}` }), {
            status: 400,
          }),
      );
      const ids = stubIdentities();
      await runOcpPlaceOutboxPass(deps(ids, messages, push));
      expect(sent.map((request) => request.method)).toEqual([method]);
      expect(ids.finishPlace).not.toHaveBeenCalled();
      expect(ids.release).not.toHaveBeenCalled();
    }
    expect(logged('ocp.place.deferred')).toEqual([
      expect.objectContaining({
        messageId: ID,
        status: 400,
        error: 'Place field is not allowed: nostrPubkey',
      }),
      expect.objectContaining({ error: 'Place field is not allowed: revision' }),
      expect.objectContaining({ error: 'Place field is not allowed: revision' }),
    ]);
    expect(logged('ocp.place.rejected')).toEqual([]);
  });

  it('rejects any other 400, also another unknown field or a body that is not that JSON', async () => {
    for (const text of [
      '{"error":"Place field is not allowed: id"}',
      '{"error":["Place field is not allowed: nostrPubkey"]}',
      '{}',
      'Place field is not allowed: nostrPubkey',
    ]) {
      const messages = await messagesWith(shopNote());
      const { push } = mapPush(() => new Response(text, { status: 400 }));
      const ids = stubIdentities();
      await runOcpPlaceOutboxPass(deps(ids, messages, push));
      expect(ids.finishPlace).toHaveBeenCalledWith(CLAIM, 'reject');
    }
    expect(logged('ocp.place.rejected')).toHaveLength(4);
    expect(logged('ocp.place.deferred')).toEqual([]);
  });

  it('keeps the flag and the claim until the lease ends when a 409 body is empty or cannot be read', async () => {
    const broken = {
      ok: false,
      status: 409,
      text: () => Promise.reject(new Error('stream')),
    } as unknown as Response;
    for (const answer of [() => broken, () => new Response('', { status: 409 })]) {
      const messages = await messagesWith(shopNote());
      const { push } = mapPush(answer);
      const ids = stubIdentities();
      await runOcpPlaceOutboxPass(deps(ids, messages, push));
      // The claim stays: nothing releases it, clears the flag or resets the
      // photos, so the retry waits for the lease to end.
      expect(ids.claimPlaces).toHaveBeenCalledTimes(1);
      expect(ids.release).not.toHaveBeenCalled();
      expect(ids.finishPlace).not.toHaveBeenCalled();
      expect(ids.resetPhotosForDelete).not.toHaveBeenCalled();
    }
    expect(logged('ocp.place.failed')).toEqual([
      expect.objectContaining({ messageId: ID, status: 409 }),
      expect.objectContaining({ messageId: ID, status: 409 }),
    ]);
    expect(logged('ocp.place.rejected')).toEqual([]);
  });

  it('keeps the flag and logs ocp.place.failed on any other answer or error', async () => {
    const messages = await messagesWith(shopNote());
    for (const answer of [
      () => new Response('', { status: 401 }),
      () => new Response('', { status: 503 }),
      () => Promise.reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })),
    ]) {
      const { push } = mapPush(answer);
      const ids = stubIdentities();
      await runOcpPlaceOutboxPass(deps(ids, messages, push));
      expect(ids.finishPlace).not.toHaveBeenCalled();
      expect(ids.release).not.toHaveBeenCalled();
    }
    expect(logged('ocp.place.failed')).toEqual([
      expect.objectContaining({ messageId: ID, status: 401 }),
      expect.objectContaining({ messageId: ID, status: 503 }),
      expect.objectContaining({ messageId: ID }),
    ]);
  });
});

describe('ocpPhotoSetHash', () => {
  it('depends on the order, types and bytes of the photos', () => {
    const empty = ocpPhotoSetHash([]);
    expect(empty).toMatch(/^[0-9a-f]{64}$/);
    expect(ocpPhotoSetHash([PNG, JPEG])).toBe(ocpPhotoSetHash([PNG, JPEG]));
    expect(ocpPhotoSetHash([PNG, JPEG])).not.toBe(ocpPhotoSetHash([JPEG, PNG]));
    expect(ocpPhotoSetHash([PNG])).not.toBe(
      ocpPhotoSetHash([{ contentType: 'image/webp', bytes: PNG.bytes }]),
    );
    expect(ocpPhotoSetHash([PNG])).not.toBe(empty);
  });
});

describe('runOcpPhotoOutboxPass', () => {
  it('does nothing without a claim', async () => {
    const ids = stubIdentities();
    ids.claimPhoto.mockResolvedValueOnce(undefined);
    const { push, sent } = mapPush(() => new Response('{}'));
    await runOcpPhotoOutboxPass(deps(ids, new InMemoryMessageStore(), push));
    expect(ids.claimPhoto).toHaveBeenCalledWith(60_000);
    expect(sent).toEqual([]);
  });

  it('sends up to 10 photos in note order with the key and revision', async () => {
    const photos = Array.from({ length: 10 }, (_, index) => ({
      contentType: 'image/png' as const,
      bytes: new Uint8Array([index]),
    }));
    const messages = await messagesWith(shopNote({ hasPhoto: true }), photos);
    const ids = stubIdentities();
    const { push, sent } = mapPush(() => new Response('{"photos":[],"skipped":[]}'));
    await runOcpPhotoOutboxPass(deps(ids, messages, push));
    expect(ids.leaseHasTime).toHaveBeenCalledTimes(2);
    expect(ids.leaseHasTime).toHaveBeenCalledWith(
      'photos',
      CLAIM,
      OCP_PHOTO_TIMEOUT_MS + OCP_LEASE_MARGIN_MS,
    );
    expect(ids.clearPhotoHash).toHaveBeenCalledWith(CLAIM);
    expect(sent[0]?.url).toBe('https://map.test/map/places/photos');
    expect(sent[0]?.method).toBe('PUT');
    expect(sent[0]?.body).toEqual({
      origin: '21gifts',
      nostrPubkey: PUBKEY,
      revision: 7,
      photos: photos.map((photo) => ({
        contentType: 'image/png',
        data: Buffer.from(photo.bytes).toString('base64'),
      })),
    });
    expect(ids.finishPhotos).toHaveBeenCalledWith(CLAIM, ocpPhotoSetHash(photos));
    expect(logged('ocp.photos.skipped')).toEqual([]);
  });

  it('sends an empty list for a shop without photos', async () => {
    const messages = await messagesWith(shopNote());
    const ids = stubIdentities();
    const { push, sent } = mapPush(() => new Response('{"photos":[],"skipped":[]}'));
    await runOcpPhotoOutboxPass(deps(ids, messages, push));
    expect(sent[0]?.body['photos']).toEqual([]);
    expect(ids.finishPhotos).toHaveBeenCalledWith(CLAIM, ocpPhotoSetHash([]));
  });

  it('logs skipped photos and tolerates odd 200 bodies', async () => {
    const messages = await messagesWith(shopNote({ hasPhoto: true }), [PNG]);
    for (const body of [
      '{"photos":[],"skipped":[{"index":0,"error":"bad"}]}',
      '{"photos":[],"skipped":"none"}',
      'not json',
    ]) {
      const ids = stubIdentities();
      const { push } = mapPush(() => new Response(body, { status: 200 }));
      await runOcpPhotoOutboxPass(deps(ids, messages, push));
      expect(ids.finishPhotos).toHaveBeenCalledTimes(1);
    }
    expect(logged('ocp.photos.skipped')).toEqual([
      expect.objectContaining({ messageId: ID, skipped: 1 }),
    ]);
  });

  it('releases when the lease is short before or after reading the bytes', async () => {
    const messages = await messagesWith(shopNote());
    for (const results of [[false], [true, false]]) {
      const ids = stubIdentities();
      for (const value of results) ids.leaseHasTime.mockResolvedValueOnce(value);
      const { push, sent } = mapPush(() => new Response('{}'));
      await runOcpPhotoOutboxPass(deps(ids, messages, push));
      expect(ids.release).toHaveBeenCalledWith('photos', CLAIM);
      expect(sent).toEqual([]);
    }
  });

  it('clears without sending for a shop that is not listed or has no identity', async () => {
    const unlisted = await messagesWith(shopNote({ deletedAt: new Date(0) }));
    const listed = await messagesWith(shopNote());
    for (const [ids, messages] of [
      [stubIdentities(), unlisted],
      [stubIdentities(null), listed],
    ] as const) {
      const { push, sent } = mapPush(() => new Response('{}'));
      await runOcpPhotoOutboxPass(deps(ids, messages, push));
      expect(ids.clearPhotoWithoutSend).toHaveBeenCalledWith(CLAIM);
      expect(sent).toEqual([]);
    }
  });

  it('clears without sending when the set equals the stored hash', async () => {
    const messages = await messagesWith(shopNote({ hasPhoto: true }), [PNG]);
    const ids = stubIdentities(identity({ ocpPhotosHash: ocpPhotoSetHash([PNG]) }));
    const { push, sent } = mapPush(() => new Response('{}'));
    await runOcpPhotoOutboxPass(deps(ids, messages, push));
    expect(ids.clearPhotoWithoutSend).toHaveBeenCalledWith(CLAIM);
    expect(ids.clearPhotoHash).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('sends nothing when the claim was taken over before the revision', async () => {
    const messages = await messagesWith(shopNote());
    const ids = stubIdentities();
    ids.nextRevision.mockResolvedValueOnce(undefined);
    const { push, sent } = mapPush(() => new Response('{}'));
    await runOcpPhotoOutboxPass(deps(ids, messages, push));
    expect(sent).toEqual([]);
  });

  it('nulls the hash and releases on 409 Stale revision', async () => {
    const messages = await messagesWith(shopNote());
    const ids = stubIdentities();
    const { push } = mapPush(() => new Response('{"error":"Stale revision"}', { status: 409 }));
    await runOcpPhotoOutboxPass(deps(ids, messages, push));
    expect(ids.clearPhotoHash).toHaveBeenCalledTimes(2);
    expect(ids.release).toHaveBeenCalledWith('photos', CLAIM);
    expect(ids.finishPhotos).not.toHaveBeenCalled();
  });

  it('stores the hash and logs ocp.photos.rejected on 400 or 413', async () => {
    const messages = await messagesWith(shopNote());
    for (const status of [400, 413]) {
      const ids = stubIdentities();
      const { push } = mapPush(() => new Response('{"error":"x"}', { status }));
      await runOcpPhotoOutboxPass(deps(ids, messages, push));
      expect(ids.finishPhotos).toHaveBeenCalledWith(CLAIM, ocpPhotoSetHash([]));
    }
    expect(logged('ocp.photos.rejected').map((line) => line['status'])).toEqual([400, 413]);
  });

  it('queues the place again on 404 while the shop is still listed', async () => {
    const listed = await messagesWith(shopNote());
    let reads = 0;
    const flipping = {
      getById: async (id: string) => {
        reads += 1;
        const row = await listed.getById(id);
        return reads === 1 ? row : undefined;
      },
      getPhoto: (id: string) => listed.getPhoto(id),
      listExtraPhotos: (id: string) => listed.listExtraPhotos(id),
    } as unknown as MessageStore;
    for (const [messages, expected] of [
      [listed, true],
      [flipping, false],
    ] as const) {
      const ids = stubIdentities();
      const { push } = mapPush(() => new Response('{"error":"Place not found"}', { status: 404 }));
      await runOcpPhotoOutboxPass(deps(ids, messages, push));
      expect(ids.missingPhotoPlace).toHaveBeenCalledWith(CLAIM, expected);
    }
  });

  it('defers the photos on any other 404 and keeps the claim', async () => {
    const messages = await messagesWith(shopNote(), [PNG]);
    const secret = `SECRET-SENTINEL-${'x'.repeat(300)}`;
    const bodies = ['404 Not Found', '{"error":"Not found"}', 'null', secret];
    for (const body of bodies) {
      const ids = stubIdentities();
      const { push, sent } = mapPush(() => new Response(body, { status: 404 }));
      await runOcpPhotoOutboxPass(deps(ids, messages, push));
      expect(sent.map((request) => request.url)).toEqual(['https://map.test/map/places/photos']);
      expect(ids.deferPhotos).toHaveBeenCalledWith(CLAIM, true);
      expect(ids.missingPhotoPlace).not.toHaveBeenCalled();
      expect(ids.finishPhotos).not.toHaveBeenCalled();
      expect(ids.release).not.toHaveBeenCalled();
    }
    expect(logged('ocp.photos.deferred')).toEqual(
      bodies.map((body) => ({
        ts: expect.any(String),
        event: 'ocp.photos.deferred',
        messageId: ID,
        status: 404,
        reason: 'route_missing',
        bodyLength: body.length,
      })),
    );
    const lines = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(lines).not.toContain('SECRET-SENTINEL');
    expect(logged('ocp.photos.rejected')).toEqual([]);
  });

  it('keeps the flag and logs ocp.photos.failed on any other answer or error', async () => {
    const messages = await messagesWith(shopNote());
    for (const answer of [
      () => new Response('', { status: 500 }),
      () => new Response('{"error":"other"}', { status: 409 }),
      () => Promise.reject(new Error('reset')),
    ]) {
      const ids = stubIdentities();
      const { push } = mapPush(answer);
      await runOcpPhotoOutboxPass(deps(ids, messages, push));
      expect(ids.finishPhotos).not.toHaveBeenCalled();
      expect(ids.release).not.toHaveBeenCalled();
    }
    expect(logged('ocp.photos.failed')).toHaveLength(3);
  });
});

describe('OpenCryptoPay without openCryptoPay/api#26', () => {
  it('retries the place once a lease ended and sends the photos after the upgrade', async () => {
    const messages = await messagesWith(shopNote(), [PNG]);
    const clock = { now: 1_000_000 };
    const store = new InMemoryShopIdentityStore(messages, () => clock.now);
    await store.ensureListed(ID, new Uint8Array(32).fill(7));
    let upgraded = false;
    const { push, sent } = mapPush((url) => {
      if (!upgraded) {
        return url.endsWith('/photos')
          ? new Response('404 Not Found', { status: 404 })
          : new Response('{"error":"Place field is not allowed: nostrPubkey"}', { status: 400 });
      }
      return new Response('{}', { status: 200 });
    });
    const outbox = deps(store, messages, push);

    await runOcpPlaceOutboxPass(outbox);
    await runOcpPlaceOutboxPass(outbox);
    await runOcpPhotoOutboxPass(outbox);
    expect(sent.map((request) => request.method)).toEqual(['PUT']);
    expect((await store.getByMessageId(ID))?.ocpPlacePending).toBe(true);

    clock.now += 60_000;
    upgraded = true;
    await runOcpPlaceOutboxPass(outbox);
    await runOcpPhotoOutboxPass(outbox);
    expect(sent.map((request) => request.url)).toEqual([
      'https://map.test/map/places',
      'https://map.test/map/places',
      'https://map.test/map/places/photos',
    ]);
    expect(await store.getByMessageId(ID)).toMatchObject({
      ocpPlacePending: false,
      ocpPhotosPending: false,
      ocpPhotosHash: ocpPhotoSetHash([PNG]),
    });
    expect(logged('ocp.place.deferred')).toHaveLength(1);
  });
});

describe('OpenCryptoPay main without the photo route', () => {
  const PLACE = 'https://map.test/map/places';
  const PHOTOS = 'https://map.test/map/places/photos';

  async function mainApi(): Promise<{
    store: InMemoryShopIdentityStore;
    clock: { now: number };
    sent: Sent[];
    api: { upgraded: boolean; placeNotFound: boolean };
    tick: () => Promise<void>;
  }> {
    const messages = await messagesWith(shopNote(), [PNG]);
    const clock = { now: 1_000_000 };
    const store = new InMemoryShopIdentityStore(messages, () => clock.now);
    await store.ensureListed(ID, new Uint8Array(32).fill(7));
    const api = { upgraded: false, placeNotFound: false };
    const { push, sent } = mapPush((url) => {
      if (url === PLACE) return new Response('{"created":false}', { status: 200 });
      if (!api.upgraded) return new Response('404 Not Found', { status: 404 });
      if (api.placeNotFound) {
        return new Response('{"error":"Place not found"}', { status: 404 });
      }
      return new Response('{"photos":[],"skipped":[]}', { status: 200 });
    });
    const outbox = deps(store, messages, push);
    const tick = async (): Promise<void> => {
      await runOcpPlaceOutboxPass(outbox);
      await runOcpPhotoOutboxPass(outbox);
      clock.now += 2_000;
    };
    return { store, clock, sent, api, tick };
  }

  it('sends one place and one photo request per lease while the photo route is missing', async () => {
    const { store, sent, tick } = await mainApi();
    for (let pass = 0; pass < 30; pass += 1) await tick();
    expect(sent.map((request) => request.url)).toEqual([PLACE, PHOTOS]);
    expect(sent[0]?.body).toMatchObject({ nostrPubkey: expect.any(String), revision: 1 });
    expect(sent[1]?.body).toMatchObject({ revision: 2 });
    const held = await store.getByMessageId(ID);
    expect(held).toMatchObject({ ocpPlacePending: true, ocpPhotosPending: true });
    expect(held?.ocpPlaceClaimedUntil).toEqual(held?.ocpPhotosClaimedUntil);

    await tick();
    expect(sent.map((request) => request.url)).toEqual([PLACE, PHOTOS, PLACE, PHOTOS]);
    for (let pass = 0; pass < 29; pass += 1) await tick();
    expect(sent).toHaveLength(4);
    expect(logged('ocp.photos.deferred')).toHaveLength(2);
    expect(logged('ocp.photos.failed')).toEqual([]);
  });

  it('stores the key and the photos once the API runs openCryptoPay/api#26', async () => {
    const { store, sent, api, tick } = await mainApi();
    await tick();
    api.upgraded = true;
    for (let pass = 0; pass < 30; pass += 1) await tick();
    expect(sent.map((request) => request.url)).toEqual([PLACE, PHOTOS, PLACE, PHOTOS]);
    expect(sent[2]?.body).toMatchObject({ nostrPubkey: sent[0]?.body['nostrPubkey'] });
    expect(await store.getByMessageId(ID)).toMatchObject({
      ocpPlacePending: false,
      ocpPhotosPending: false,
      ocpPhotosHash: ocpPhotoSetHash([PNG]),
      ocpPhotosClaimedUntil: null,
    });
    for (let pass = 0; pass < 40; pass += 1) await tick();
    expect(sent).toHaveLength(4);
  });

  it('queues the place at once when openCryptoPay/api#26 does not know it', async () => {
    const { store, sent, api, tick } = await mainApi();
    api.upgraded = true;
    api.placeNotFound = true;
    await tick();
    expect(sent.map((request) => request.url)).toEqual([PLACE, PHOTOS]);
    expect(await store.getByMessageId(ID)).toMatchObject({
      ocpPlacePending: true,
      ocpPlaceClaimedUntil: null,
      ocpPhotosPending: false,
      ocpPhotosHash: null,
    });
    api.placeNotFound = false;
    await tick();
    expect(sent.map((request) => request.url)).toEqual([PLACE, PHOTOS, PLACE, PHOTOS]);
    expect((await store.getByMessageId(ID))?.ocpPhotosHash).toBe(ocpPhotoSetHash([PNG]));
    expect(logged('ocp.photos.deferred')).toEqual([]);
  });
});

describe('queueAllShopPlaces', () => {
  it('walks every page of 200 by message id', async () => {
    const page = Array.from({ length: 200 }, (_, index) => `id-${String(index).padStart(3, '0')}`);
    const ids = stubIdentities();
    ids.queueAllPlacePage.mockResolvedValueOnce(page).mockResolvedValueOnce(['z']);
    expect(await queueAllShopPlaces(ids as unknown as ShopIdentityStore)).toBe(201);
    expect(ids.queueAllPlacePage.mock.calls).toEqual([
      [null, 200],
      ['id-199', 200],
    ]);
  });

  it('queues the real store and stops at an empty page', async () => {
    const messages = await messagesWith(shopNote());
    const store = new InMemoryShopIdentityStore(messages);
    await store.ensureListed(ID, new Uint8Array(32).fill(7));
    const claim = (await store.claimPlaces(1, 60_000))[0]!;
    await store.finishPlace(claim, 'put');
    expect(await queueAllShopPlaces(store)).toBe(1);
    expect((await store.getByMessageId(ID))?.ocpPlacePending).toBe(true);
    expect(await queueAllShopPlaces(new InMemoryShopIdentityStore(messages))).toBe(0);
  });
});

describe('startOcpOutboxWorker', () => {
  it('runs the place lane on an interval and the photo lane serialised until stopped', async () => {
    vi.useFakeTimers();
    const ids = stubIdentities();
    ids.claimPlaces.mockResolvedValue([]);
    ids.claimPhoto.mockResolvedValue(undefined);
    const handle = startOcpOutboxWorker(
      deps(ids, new InMemoryMessageStore(), mapPush(() => new Response('{}')).push),
      100,
    );
    await vi.advanceTimersByTimeAsync(350);
    expect(ids.claimPlaces).toHaveBeenCalledTimes(3);
    expect(ids.claimPhoto).toHaveBeenCalledTimes(3);
    handle.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(ids.claimPlaces).toHaveBeenCalledTimes(3);
    expect(ids.claimPhoto).toHaveBeenCalledTimes(3);
  });

  it('logs lane failures and does not reschedule a photo pass after stop', async () => {
    vi.useFakeTimers();
    const ids = stubIdentities();
    ids.claimPlaces.mockRejectedValue(new Error('db'));
    let finish: (() => void) | undefined;
    ids.claimPhoto.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          finish = () => reject(new Error('db'));
        }),
    );
    const handle = startOcpOutboxWorker(
      deps(ids, new InMemoryMessageStore(), mapPush(() => new Response('{}')).push),
      100,
    );
    await vi.advanceTimersByTimeAsync(100);
    handle.stop();
    finish?.();
    await vi.advanceTimersByTimeAsync(500);
    expect(ids.claimPhoto).toHaveBeenCalledTimes(1);
    expect(logged('ocp.place.failed')).toHaveLength(1);
    expect(logged('ocp.photos.failed')).toHaveLength(1);
  });

  it('defaults to the worker interval', async () => {
    vi.useFakeTimers();
    const ids = stubIdentities();
    ids.claimPlaces.mockResolvedValue([]);
    ids.claimPhoto.mockResolvedValue(undefined);
    const handle = startOcpOutboxWorker(
      deps(ids, new InMemoryMessageStore(), mapPush(() => new Response('{}')).push),
    );
    await vi.advanceTimersByTimeAsync(1_999);
    expect(ids.claimPlaces).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ids.claimPlaces).toHaveBeenCalledTimes(1);
    handle.stop();
  });
});
