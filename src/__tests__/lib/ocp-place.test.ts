import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  normalizeOcpPlace,
  recordFirstShopOcpPlace,
  shopOcpPlaceInput,
  shopOcpPlaceName,
} from '@/lib/ocp-place';
import { InMemoryOcpPlaceStore } from '@/lib/ocp-place-store';
import type { BtcMapPush } from '@/lib/btcmap-push';

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

describe('recordFirstShopOcpPlace', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('inserts and pushes only for a first top-level shop pin', async () => {
    const places = new InMemoryOcpPlaceStore();
    const submit = vi.fn<BtcMapPush['submit']>().mockResolvedValue('sent');
    const push: BtcMapPush = { submit };
    await recordFirstShopOcpPlace({
      places,
      btcMapPush: push,
      messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      text: 'Open #21GiftsShop',
      parentId: null,
      place: { lat: 1, lng: 2, label: 'Stall' },
      authorName: 'Ada',
      hadPlaceBefore: false,
      textHasHashtagToken: (text, name) => text.includes(`#${name}`),
    });
    const listed = await places.list(10);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.origin).toBe('21gifts');
    expect(submit).toHaveBeenCalledTimes(1);

    await recordFirstShopOcpPlace({
      places,
      btcMapPush: push,
      messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      text: 'Open #21GiftsShop',
      parentId: null,
      place: { lat: 9, lng: 9, label: 'Other' },
      authorName: 'Ada',
      hadPlaceBefore: false,
      textHasHashtagToken: (text, name) => text.includes(`#${name}`),
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect((await places.list(10))[0]?.lat).toBe(1);
  });

  it('skips replies, non-shops, missing pins, and prior pins', async () => {
    const places = new InMemoryOcpPlaceStore();
    const submit = vi.fn<BtcMapPush['submit']>().mockResolvedValue('sent');
    const base = {
      places,
      btcMapPush: { submit } satisfies BtcMapPush,
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
    expect(await places.list(10)).toEqual([]);
    expect(submit).not.toHaveBeenCalled();
  });

  it('logs ocp.place.failed and swallows store errors', async () => {
    const places: InMemoryOcpPlaceStore = {
      insertIfNew: async () => {
        throw new Error('boom');
      },
      list: async () => [],
    } as unknown as InMemoryOcpPlaceStore;
    await expect(
      recordFirstShopOcpPlace({
        places,
        messageId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        text: '#21GiftsShop',
        parentId: null,
        place: { lat: 1, lng: 2, label: null },
        authorName: null,
        hadPlaceBefore: false,
        textHasHashtagToken: () => true,
      }),
    ).resolves.toBeUndefined();
    expect(parsedEvents(warn).some((e) => e['event'] === 'ocp.place.failed')).toBe(true);
  });
});
