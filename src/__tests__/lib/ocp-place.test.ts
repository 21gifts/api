import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  normalizeOcpPlace,
  publishExistingShopPlaces,
  recordFirstShopOcpPlace,
  resolveMapPush,
  shopOcpPlaceInput,
  shopOcpPlaceName,
  type MapFetch,
  type MapPush,
} from '@/lib/ocp-place';
import { createApp } from '@/server';
import { InMemoryAuthStore } from '@/lib/auth/store';
import type { FetchFn } from '@/lib/lnurlp';

const COORD_ERROR = 'Place must be a latitude and longitude';
const ORIGIN_ERROR = 'Place origin is invalid';
const EXTERNAL_ID_ERROR = 'Place external id is required';
const NAME_ERROR = 'Place name is required';
const CATEGORY_ERROR = 'Place category is required';

const VALID = {
  origin: 'partner',
  externalId: 'ext-1',
  name: 'Cafe',
  lat: 47.3,
  lon: 8.5,
  category: 'cafe',
  paymentMethods: 'lightning',
};

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

describe('normalizeOcpPlace', () => {
  it('rejects non-objects and arrays', () => {
    expect(normalizeOcpPlace(null)).toEqual({ ok: false, error: COORD_ERROR });
    expect(normalizeOcpPlace('x')).toEqual({ ok: false, error: COORD_ERROR });
    expect(normalizeOcpPlace([])).toEqual({ ok: false, error: COORD_ERROR });
  });

  it('rejects missing, non-finite, and out-of-range coordinates', () => {
    expect(normalizeOcpPlace({ ...VALID, lat: undefined })).toEqual({
      ok: false,
      error: COORD_ERROR,
    });
    expect(normalizeOcpPlace({ ...VALID, lon: '8.5' })).toEqual({
      ok: false,
      error: COORD_ERROR,
    });
    expect(normalizeOcpPlace({ ...VALID, lat: Number.NaN })).toEqual({
      ok: false,
      error: COORD_ERROR,
    });
    expect(normalizeOcpPlace({ ...VALID, lat: 90.000001 })).toEqual({
      ok: false,
      error: COORD_ERROR,
    });
    expect(normalizeOcpPlace({ ...VALID, lon: -180.000001 })).toEqual({
      ok: false,
      error: COORD_ERROR,
    });
  });

  it('rounds coordinates to six decimals and collapses -0', () => {
    const result = normalizeOcpPlace({
      ...VALID,
      lat: 47.1234567,
      lon: -0,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        ...VALID,
        lat: 47.123457,
        lon: 0,
      },
    });
    if (result.ok) {
      expect(Object.is(result.value.lon, -0)).toBe(false);
    }
  });

  it('validates origin, externalId, name, and category', () => {
    expect(normalizeOcpPlace({ ...VALID, origin: 1 })).toEqual({
      ok: false,
      error: ORIGIN_ERROR,
    });
    expect(normalizeOcpPlace({ ...VALID, externalId: 1 })).toEqual({
      ok: false,
      error: EXTERNAL_ID_ERROR,
    });
    expect(normalizeOcpPlace({ ...VALID, name: 1 })).toEqual({
      ok: false,
      error: NAME_ERROR,
    });
    expect(normalizeOcpPlace({ ...VALID, category: 1 })).toEqual({
      ok: false,
      error: CATEGORY_ERROR,
    });
    expect(normalizeOcpPlace({ ...VALID, origin: 'Bad' })).toEqual({
      ok: false,
      error: ORIGIN_ERROR,
    });
    expect(normalizeOcpPlace({ ...VALID, origin: '' })).toEqual({
      ok: false,
      error: ORIGIN_ERROR,
    });
    expect(normalizeOcpPlace({ ...VALID, externalId: '' })).toEqual({
      ok: false,
      error: EXTERNAL_ID_ERROR,
    });
    expect(normalizeOcpPlace({ ...VALID, externalId: 'x'.repeat(81) })).toEqual({
      ok: false,
      error: EXTERNAL_ID_ERROR,
    });
    expect(normalizeOcpPlace({ ...VALID, externalId: 'a\nb' })).toEqual({
      ok: false,
      error: EXTERNAL_ID_ERROR,
    });
    expect(normalizeOcpPlace({ ...VALID, name: '   ' })).toEqual({
      ok: false,
      error: NAME_ERROR,
    });
    expect(normalizeOcpPlace({ ...VALID, name: 'a\u007fb' })).toEqual({
      ok: false,
      error: NAME_ERROR,
    });
    expect(normalizeOcpPlace({ ...VALID, category: 'Cafe' })).toEqual({
      ok: false,
      error: CATEGORY_ERROR,
    });
    expect(normalizeOcpPlace({ ...VALID, category: '' })).toEqual({
      ok: false,
      error: CATEGORY_ERROR,
    });
  });

  it('trims fields and normalizes paymentMethods', () => {
    expect(
      normalizeOcpPlace({
        ...VALID,
        origin: ' partner ',
        externalId: ' ext-1 ',
        name: ' Cafe ',
        category: ' cafe ',
        paymentMethods: ' onchain,lightning ',
      }),
    ).toEqual({
      ok: true,
      value: {
        ...VALID,
        origin: 'partner',
        externalId: 'ext-1',
        name: 'Cafe',
        category: 'cafe',
        paymentMethods: 'onchain,lightning',
      },
    });
    expect(normalizeOcpPlace({ ...VALID, paymentMethods: null }).ok && true).toBe(true);
    expect(normalizeOcpPlace({ ...VALID, paymentMethods: '' })).toMatchObject({
      ok: true,
      value: { paymentMethods: null },
    });
    expect(normalizeOcpPlace({ ...VALID, paymentMethods: undefined })).toMatchObject({
      ok: true,
      value: { paymentMethods: null },
    });
    expect(normalizeOcpPlace({ ...VALID, paymentMethods: 'cash' })).toMatchObject({
      ok: true,
      value: { paymentMethods: null },
    });
    expect(normalizeOcpPlace({ ...VALID, paymentMethods: 1 })).toMatchObject({
      ok: true,
      value: { paymentMethods: null },
    });
  });
});

describe('shopOcpPlaceName / shopOcpPlaceInput', () => {
  it('prefers label, then author name, then Shop, truncated to 80', () => {
    expect(shopOcpPlaceName({ lat: 1, lng: 2, label: 'Pin' }, 'Ada')).toBe('Pin');
    expect(shopOcpPlaceName({ lat: 1, lng: 2, label: null }, 'Ada')).toBe('Ada');
    expect(shopOcpPlaceName({ lat: 1, lng: 2, label: null }, null)).toBe('Shop');
    expect(shopOcpPlaceName({ lat: 1, lng: 2, label: 'A'.repeat(90) }, null)).toHaveLength(80);
  });

  it('maps a shop pin onto origin 21gifts and lightning', () => {
    expect(shopOcpPlaceInput('msg-1', { lat: 47.3, lng: 8.5, label: 'Stall' }, 'Ada')).toEqual({
      origin: '21gifts',
      externalId: 'msg-1',
      name: 'Stall',
      lat: 47.3,
      lon: 8.5,
      category: 'shopping',
      paymentMethods: 'lightning',
    });
  });
});

type RecordedCall = { url: string; authorization: string; body: string };

function recordingPush(status = 201): { mapPush: MapPush; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: MapFetch = async (input, init) => {
    const headers = new Headers(init.headers);
    calls.push({
      url: String(input),
      authorization: headers.get('authorization') ?? '',
      body: String(init.body),
    });
    return new Response('{}', { status });
  };
  return {
    mapPush: { baseUrl: 'http://map.test', token: 'secret', fetchImpl },
    calls,
  };
}

async function shopAccount(): Promise<InMemoryAuthStore> {
  const store = new InMemoryAuthStore();
  const now = Date.now();
  await store.createAccount({
    id: 'acc',
    linkingKey: 'a'.repeat(64),
    role: 'verified',
    name: 'Ada',
    lightningAddress: 'ada@walletofsatoshi.com',
    lightningAddressVerified: true,
    forumLawsDismissed: false,
    location: null,
    viewKey: 'b'.repeat(64),
    createdAt: now,
    rulesAgreedAt: now,
    username: 'ada',
  });
  await store.createSession({ token: 'tok', accountId: 'acc', createdAt: now });
  return store;
}

describe('resolveMapPush', () => {
  it('returns undefined when the url or token is missing', () => {
    const fetchImpl: MapFetch = async () => new Response('{}');
    expect(resolveMapPush({}, fetchImpl)).toBeUndefined();
    expect(resolveMapPush({ OCP_MAP_BASE_URL: '  ' }, fetchImpl)).toBeUndefined();
    expect(
      resolveMapPush(
        { OCP_MAP_BASE_URL: 'http://map.test', OCP_PLACE_INGEST_TOKEN: ' ' },
        fetchImpl,
      ),
    ).toBeUndefined();
  });

  it('returns the trimmed url and token when both are set', () => {
    const fetchImpl: MapFetch = async () => new Response('{}');
    expect(
      resolveMapPush(
        { OCP_MAP_BASE_URL: ' http://map.test/// ', OCP_PLACE_INGEST_TOKEN: ' secret ' },
        fetchImpl,
      ),
    ).toMatchObject({ baseUrl: 'http://map.test', token: 'secret' });
  });
});

describe('createApp map push', () => {
  const pin = { text: 'Open #21GiftsShop', place: { lat: 47.3, lng: 8.5, label: 'Stall' } };

  async function postShop(app: ReturnType<typeof createApp>): Promise<number> {
    const res = await app.request('/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify(pin),
    });
    return res.status;
  }

  it('keeps the pin and posts nothing when the url or token is blank', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchFn = async (input) => {
      calls.push(String(input));
      return new Response('{}', { status: 201 });
    };
    const app = createApp({
      env: { OCP_MAP_BASE_URL: '  ', OCP_PLACE_INGEST_TOKEN: '  ' },
      fetchImpl,
      authStore: await shopAccount(),
    });
    expect((await app.request('/healthz')).status).toBe(200);
    expect(await postShop(app)).toBe(200);
    expect(calls).toEqual([]);
  });

  it('posts one shop pin when the url and token are set', async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl: FetchFn = async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        authorization: headers.get('authorization') ?? '',
        body: String(init?.body),
      });
      return new Response('{}', { status: 201 });
    };
    const app = createApp({
      env: { OCP_MAP_BASE_URL: 'http://map.test/', OCP_PLACE_INGEST_TOKEN: ' secret ' },
      fetchImpl,
      authStore: await shopAccount(),
    });
    expect(await postShop(app)).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://map.test/map/places');
    expect(calls[0]?.authorization).toBe('Bearer secret');
    const body = JSON.parse(calls[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({
      origin: '21gifts',
      category: 'shopping',
      paymentMethods: 'lightning',
      name: 'Stall',
      lat: 47.3,
      lon: 8.5,
    });
    expect(typeof body['externalId']).toBe('string');
    expect(String(body['externalId']).length).toBeGreaterThan(0);
  });
});

describe('recordFirstShopOcpPlace', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('posts a first top-level shop pin to /map/places', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const { mapPush, calls } = recordingPush();
    await recordFirstShopOcpPlace({
      mapPush,
      messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      text: 'Open #21GiftsShop',
      parentId: null,
      place: { lat: 1, lng: 2, label: 'Stall' },
      authorName: 'Ada',
      hadPlaceBefore: false,
      textHasHashtagToken: (text, name) => text.includes(`#${name}`),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://map.test/map/places');
    expect(calls[0]?.authorization).toBe('Bearer secret');
    expect(timeoutSpy).toHaveBeenCalledWith(5_000);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({
      origin: '21gifts',
      name: 'Stall',
      category: 'shopping',
      paymentMethods: 'lightning',
    });
    timeoutSpy.mockRestore();
  });

  it('skips replies, non-shops, missing pins, prior pins, and a missing push', async () => {
    const { mapPush, calls } = recordingPush();
    const base = {
      mapPush,
      messageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      text: 'Open #21GiftsShop',
      place: { lat: 1, lng: 2, label: null } as const,
      authorName: 'Ada',
      textHasHashtagToken: (text: string, name: string) => text.includes(`#${name}`),
    };
    await recordFirstShopOcpPlace({ ...base, parentId: 'parent', hadPlaceBefore: false });
    await recordFirstShopOcpPlace({
      ...base,
      parentId: null,
      text: 'plain',
      hadPlaceBefore: false,
    });
    await recordFirstShopOcpPlace({
      ...base,
      parentId: null,
      place: null,
      hadPlaceBefore: false,
    });
    await recordFirstShopOcpPlace({ ...base, parentId: null, hadPlaceBefore: true });
    await recordFirstShopOcpPlace({
      messageId: base.messageId,
      text: base.text,
      place: base.place,
      authorName: base.authorName,
      textHasHashtagToken: base.textHasHashtagToken,
      parentId: null,
      hadPlaceBefore: false,
    });
    expect(calls).toEqual([]);
  });

  it('logs ocp.place.failed when the map answers an error or the call throws', async () => {
    const { mapPush } = recordingPush(500);
    await recordFirstShopOcpPlace({
      mapPush,
      messageId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      text: '#21GiftsShop',
      parentId: null,
      place: { lat: 1, lng: 2, label: null },
      authorName: null,
      hadPlaceBefore: false,
      textHasHashtagToken: () => true,
    });
    const throwing: MapPush = {
      baseUrl: 'http://map.test',
      token: 'secret',
      fetchImpl: async () => {
        throw new Error('down');
      },
    };
    await expect(
      recordFirstShopOcpPlace({
        mapPush: throwing,
        messageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        text: '#21GiftsShop',
        parentId: null,
        place: { lat: 1, lng: 2, label: null },
        authorName: null,
        hadPlaceBefore: false,
        textHasHashtagToken: () => true,
      }),
    ).resolves.toBeUndefined();
    expect(parsedEvents(warn).filter((e) => e['event'] === 'ocp.place.failed')).toHaveLength(2);
  });
});

describe('publishExistingShopPlaces', () => {
  const hasShopTag = (text: string, name: string) => text.includes(`#${name}`);
  const stall = { lat: 47.3, lng: 8.5, label: 'Stall' };

  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('does not call listPlaces when mapPush is omitted', async () => {
    const listPlaces = vi.fn(async () => [{ id: 'keep' }]);
    await publishExistingShopPlaces({
      listPlaces,
      getById: async () => undefined,
      textHasHashtagToken: hasShopTag,
    });
    expect(listPlaces).not.toHaveBeenCalled();
  });

  it('posts a live shop pin and skips replies, hidden notes, missing rows, and non-shops', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const { mapPush, calls } = recordingPush();
    const listPlaces = vi.fn(async () => [
      { id: 'keep' },
      { id: 'notag' },
      { id: 'reply' },
      { id: 'missing' },
      { id: 'nullplace' },
      { id: 'undefplace' },
      { id: 'hidden' },
    ]);
    await publishExistingShopPlaces({
      mapPush,
      listPlaces,
      getById: async (id) => {
        if (id === 'keep') {
          return {
            id: 'keep',
            text: 'Open #21GiftsShop',
            name: 'Ada',
            parentId: null,
            place: stall,
          };
        }
        if (id === 'notag') {
          return {
            id: 'notag',
            text: 'plain',
            name: 'Ada',
            parentId: null,
            place: { lat: 1, lng: 2, label: null },
          };
        }
        if (id === 'reply') {
          return {
            id: 'reply',
            text: 'Open #21GiftsShop',
            name: 'Ada',
            parentId: 'parent',
            place: { lat: 1, lng: 2, label: null },
          };
        }
        if (id === 'nullplace') {
          return {
            id: 'nullplace',
            text: 'Open #21GiftsShop',
            name: 'Ada',
            parentId: null,
            place: null,
          };
        }
        if (id === 'undefplace') {
          return {
            id: 'undefplace',
            text: 'Open #21GiftsShop',
            name: 'Ada',
            parentId: null,
          };
        }
        if (id === 'hidden') {
          return {
            id: 'hidden',
            text: 'Open #21GiftsShop',
            name: 'Ada',
            parentId: null,
            place: { lat: 1, lng: 2, label: null },
            deletedAt: new Date('2026-01-01T00:00:00.000Z'),
          };
        }
        return undefined;
      },
      textHasHashtagToken: hasShopTag,
    });
    expect(listPlaces).toHaveBeenCalledWith(1000);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://map.test/map/places');
    expect(calls[0]?.authorization).toBe('Bearer secret');
    expect(timeoutSpy).toHaveBeenCalledWith(5_000);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual(shopOcpPlaceInput('keep', stall, 'Ada'));
    timeoutSpy.mockRestore();
  });

  it('treats HTTP 200 as success and logs no failure', async () => {
    const { mapPush, calls } = recordingPush(200);
    await publishExistingShopPlaces({
      mapPush,
      listPlaces: async () => [{ id: 'keep' }],
      getById: async () => ({
        id: 'keep',
        text: 'Open #21GiftsShop',
        name: 'Ada',
        parentId: null,
        place: stall,
        deletedAt: null,
      }),
      textHasHashtagToken: hasShopTag,
    });
    expect(calls).toHaveLength(1);
    expect(parsedEvents(warn).filter((e) => e['event'] === 'ocp.place.failed')).toHaveLength(0);
  });

  it('logs ocp.place.failed on HTTP 500 and still posts the next shop row', async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl: MapFetch = async (input, init) => {
      const headers = new Headers(init.headers);
      calls.push({
        url: String(input),
        authorization: headers.get('authorization') ?? '',
        body: String(init.body),
      });
      return new Response('{}', { status: calls.length === 1 ? 500 : 201 });
    };
    await publishExistingShopPlaces({
      mapPush: { baseUrl: 'http://map.test', token: 'secret', fetchImpl },
      listPlaces: async () => [{ id: 'first' }, { id: 'second' }],
      getById: async (id) => ({
        id,
        text: 'Open #21GiftsShop',
        name: 'Ada',
        parentId: null,
        place: stall,
      }),
      textHasHashtagToken: hasShopTag,
    });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual(shopOcpPlaceInput('first', stall, 'Ada'));
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual(shopOcpPlaceInput('second', stall, 'Ada'));
    expect(parsedEvents(warn).filter((e) => e['event'] === 'ocp.place.failed')).toHaveLength(1);
  });

  it('logs ocp.place.failed when fetch throws and does not reject', async () => {
    const throwing: MapPush = {
      baseUrl: 'http://map.test',
      token: 'secret',
      fetchImpl: async () => {
        throw new Error('down');
      },
    };
    await expect(
      publishExistingShopPlaces({
        mapPush: throwing,
        listPlaces: async () => [{ id: 'keep' }],
        getById: async () => ({
          id: 'keep',
          text: 'Open #21GiftsShop',
          name: 'Ada',
          parentId: null,
          place: stall,
        }),
        textHasHashtagToken: hasShopTag,
      }),
    ).resolves.toBeUndefined();
    expect(parsedEvents(warn).filter((e) => e['event'] === 'ocp.place.failed')).toHaveLength(1);
  });

  it('logs ocp.place.failed once when listPlaces throws and does not reject', async () => {
    const getById = vi.fn(async () => undefined);
    const { mapPush } = recordingPush();
    await expect(
      publishExistingShopPlaces({
        mapPush,
        listPlaces: async () => {
          throw new Error('list');
        },
        getById,
        textHasHashtagToken: hasShopTag,
      }),
    ).resolves.toBeUndefined();
    expect(getById).not.toHaveBeenCalled();
    expect(parsedEvents(warn).filter((e) => e['event'] === 'ocp.place.failed')).toHaveLength(1);
  });

  it('logs ocp.place.failed when getById throws and still loads the next id', async () => {
    const { mapPush, calls } = recordingPush();
    await publishExistingShopPlaces({
      mapPush,
      listPlaces: async () => [{ id: 'bad' }, { id: 'keep' }],
      getById: async (id) => {
        if (id === 'bad') {
          throw new Error('load');
        }
        return {
          id: 'keep',
          text: 'Open #21GiftsShop',
          name: 'Ada',
          parentId: null,
          place: stall,
        };
      },
      textHasHashtagToken: hasShopTag,
    });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual(shopOcpPlaceInput('keep', stall, 'Ada'));
    expect(parsedEvents(warn).filter((e) => e['event'] === 'ocp.place.failed')).toHaveLength(1);
  });
});
