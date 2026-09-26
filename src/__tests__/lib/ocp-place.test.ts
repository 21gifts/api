import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  normalizeOcpPlace,
  recordFirstShopOcpPlace,
  resolveMapPush,
  shopOcpPlaceInput,
  shopOcpPlaceName,
  type MapFetch,
  type MapPush,
} from '@/lib/ocp-place';
import { createApp } from '@/server';

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

function recordingPush(status = 201): { mapPush: MapPush; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: MapFetch = async (input, init) => {
    calls.push(String(init.body));
    return new Response('{}', { status });
  };
  return {
    mapPush: { baseUrl: 'http://map.test/', token: ' ingest ', fetchImpl },
    calls,
  };
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

  it('trims the url and the token', () => {
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
  it('forwards a configured map push into the app', async () => {
    const app = createApp({
      env: { OCP_MAP_BASE_URL: 'http://map.test', OCP_PLACE_INGEST_TOKEN: 'secret' },
    });
    expect((await app.request('/healthz')).status).toBe(200);
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
    expect(JSON.parse(calls[0] ?? '{}')).toMatchObject({
      origin: '21gifts',
      name: 'Stall',
      category: 'shopping',
      paymentMethods: 'lightning',
    });
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
