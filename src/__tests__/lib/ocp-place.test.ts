import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  publishExistingShopPlaces,
  removeShopOcpPlace,
  resolveMapPush,
  shopOcpPlaceInput,
  syncShopOcpPlace,
  type MapFetch,
  type MapPush,
} from '@/lib/ocp-place';
import { createApp } from '@/server';
import { InMemoryAuthStore } from '@/lib/auth/store';
import type { FetchFn } from '@/lib/lnurlp';
import type { ForumPlace } from '@/lib/place';

const ADDRESS = {
  street: 'Bahnhofstrasse',
  houseNumber: '1',
  postalCode: '8001',
  city: 'Zürich',
  country: 'CH',
};

const STALL: ForumPlace = { lat: 47.3, lng: 8.5, label: 'Stall', address: ADDRESS };
const SHOP_TEXT = 'Coffee roasted on site and served at the bar every morning.\n\n#21GiftsShop';
const SHOP_DESCRIPTION = 'Coffee roasted on site and served at the bar every morning.';
const INCOMPLETE: ForumPlace = { lat: 1, lng: 2, label: null, address: null };

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

describe('shopOcpPlaceInput', () => {
  it('maps a complete shop pin onto origin 21gifts with description, shopType, and address', () => {
    expect(shopOcpPlaceInput('msg-1', SHOP_TEXT, STALL)).toEqual({
      origin: '21gifts',
      externalId: 'msg-1',
      name: 'Stall',
      description: SHOP_DESCRIPTION,
      lat: 47.3,
      lon: 8.5,
      category: 'shopping',
      paymentMethods: 'lightning',
      techProvider: '21.gifts',
      shopType: 'Others',
      street: 'Bahnhofstrasse',
      houseNumber: '1',
      postalCode: '8001',
      city: 'Zürich',
      country: 'CH',
    });
  });

  it('returns null when the shop name, address, or description is incomplete', () => {
    expect(shopOcpPlaceInput('msg-1', SHOP_TEXT, INCOMPLETE)).toBeNull();
    expect(shopOcpPlaceInput('msg-1', SHOP_TEXT, { ...STALL, address: null })).toBeNull();
    expect(shopOcpPlaceInput('msg-1', 'Open #21GiftsShop', STALL)).toBeNull();
  });
});

type RecordedCall = { url: string; method: string; authorization: string; body: string };

function recordingPush(status = 201): { mapPush: MapPush; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: MapFetch = async (input, init) => {
    const headers = new Headers(init.headers);
    calls.push({
      url: String(input),
      method: init.method ?? 'GET',
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
  const pin = { text: SHOP_TEXT, place: STALL };

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
        method: init?.method ?? 'GET',
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
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.authorization).toBe('Bearer secret');
    const body = JSON.parse(calls[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({
      origin: '21gifts',
      category: 'shopping',
      paymentMethods: 'lightning',
      techProvider: '21.gifts',
      shopType: 'Others',
      name: 'Stall',
      description: SHOP_DESCRIPTION,
      lat: 47.3,
      lon: 8.5,
      street: 'Bahnhofstrasse',
      houseNumber: '1',
      postalCode: '8001',
      city: 'Zürich',
      country: 'CH',
    });
    expect(typeof body['externalId']).toBe('string');
    expect(String(body['externalId']).length).toBeGreaterThan(0);
  });
});

describe('syncShopOcpPlace', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('puts a top-level shop pin to /map/places', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const { mapPush, calls } = recordingPush();
    await syncShopOcpPlace({
      mapPush,
      messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      text: SHOP_TEXT,
      parentId: null,
      place: { lat: 1, lng: 2, label: 'Stall', address: ADDRESS },
      textHasHashtagToken: (text, name) => text.includes(`#${name}`),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://map.test/map/places');
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.authorization).toBe('Bearer secret');
    expect(timeoutSpy).toHaveBeenCalledWith(5_000);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({
      origin: '21gifts',
      name: 'Stall',
      category: 'shopping',
      paymentMethods: 'lightning',
      techProvider: '21.gifts',
    });
    timeoutSpy.mockRestore();
  });

  it('puts again when a pin already existed', async () => {
    const { mapPush, calls } = recordingPush();
    const opts = {
      mapPush,
      messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      text: SHOP_TEXT,
      parentId: null,
      place: { lat: 1, lng: 2, label: 'Stall', address: ADDRESS },
      textHasHashtagToken: (text: string, name: string) => text.includes(`#${name}`),
    };
    await syncShopOcpPlace(opts);
    await syncShopOcpPlace({
      ...opts,
      place: { lat: 3, lng: 4, label: 'Moved', address: ADDRESS },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[1]?.method).toBe('PUT');
    expect(JSON.parse(calls[1]?.body ?? '{}')).toMatchObject({
      lat: 3,
      lon: 4,
      name: 'Moved',
      techProvider: '21.gifts',
    });
  });

  it('skips replies, non-shops, missing pins, and a missing push', async () => {
    const { mapPush, calls } = recordingPush();
    const base = {
      mapPush,
      messageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      text: SHOP_TEXT,
      place: STALL,
      textHasHashtagToken: (text: string, name: string) => text.includes(`#${name}`),
    };
    await syncShopOcpPlace({ ...base, parentId: 'parent' });
    await syncShopOcpPlace({
      ...base,
      parentId: null,
      text: SHOP_DESCRIPTION,
    });
    await syncShopOcpPlace({
      ...base,
      parentId: null,
      place: null,
    });
    await syncShopOcpPlace({
      messageId: base.messageId,
      text: base.text,
      place: base.place,
      textHasHashtagToken: base.textHasHashtagToken,
      parentId: null,
    });
    expect(calls).toEqual([]);
  });

  it('deletes an incomplete shop only when removeWhenIncomplete is set', async () => {
    const { mapPush, calls } = recordingPush();
    const opts = {
      mapPush,
      messageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      text: SHOP_TEXT,
      parentId: null,
      place: { ...STALL, address: null },
      textHasHashtagToken: (text: string, name: string) => text.includes(`#${name}`),
    };
    await syncShopOcpPlace(opts);
    expect(calls).toEqual([]);
    await syncShopOcpPlace({ ...opts, removeWhenIncomplete: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('DELETE');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      origin: '21gifts',
      externalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
  });

  it('logs ocp.place.failed when the map answers an error or the call throws', async () => {
    const { mapPush } = recordingPush(500);
    await syncShopOcpPlace({
      mapPush,
      messageId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      text: SHOP_TEXT,
      parentId: null,
      place: STALL,
      textHasHashtagToken: () => true,
    });
    const throwing: MapPush = {
      baseUrl: 'http://map.test',
      token: 'secret',
      fetchImpl: async () => {
        throw Object.assign(new Error('down'), { address: 'addr-must-not-appear' });
      },
    };
    await expect(
      syncShopOcpPlace({
        mapPush: throwing,
        messageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        text: SHOP_TEXT,
        parentId: null,
        place: STALL,
        textHasHashtagToken: () => true,
      }),
    ).resolves.toBeUndefined();
    const failed = parsedEvents(warn).filter((e) => e['event'] === 'ocp.place.failed');
    expect(failed).toHaveLength(2);
    expect(failed[0]?.['status']).toBe(500);
    expect(failed[1]?.['name']).toBe('Error');
    expect(failed[1]).not.toHaveProperty('address');
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).not.toContain('secret');
    expect(warned).not.toContain('down');
    expect(warned).not.toContain('addr-must-not-appear');
  });

  it('logs ocp.place.failed with the syscall code from cause', async () => {
    const throwing: MapPush = {
      baseUrl: 'http://map.test',
      token: 'secret',
      fetchImpl: async () => {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
        });
      },
    };
    await expect(
      syncShopOcpPlace({
        mapPush: throwing,
        messageId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        text: SHOP_TEXT,
        parentId: null,
        place: STALL,
        textHasHashtagToken: () => true,
      }),
    ).resolves.toBeUndefined();
    const failed = parsedEvents(warn).filter((e) => e['event'] === 'ocp.place.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.['code']).toBe('ECONNREFUSED');
    expect(failed[0]?.['name']).toBe('TypeError');
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).not.toContain('fetch failed');
    expect(warned).not.toContain('connect');
  });

  it('logs ocp.place.failed with the outer code, not the cause code', async () => {
    const throwing: MapPush = {
      baseUrl: 'http://map.test',
      token: 'secret',
      fetchImpl: async () => {
        throw Object.assign(new TypeError('fetch failed'), {
          code: 'EPIPE',
          cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
        });
      },
    };
    await expect(
      syncShopOcpPlace({
        mapPush: throwing,
        messageId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        text: SHOP_TEXT,
        parentId: null,
        place: STALL,
        textHasHashtagToken: () => true,
      }),
    ).resolves.toBeUndefined();
    const failed = parsedEvents(warn).filter((e) => e['event'] === 'ocp.place.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.['code']).toBe('EPIPE');
    expect(failed[0]?.['name']).toBe('TypeError');
    expect(Object.values(failed[0] ?? {})).not.toContain('ECONNREFUSED');
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).not.toContain('ECONNREFUSED');
    expect(warned).not.toContain('fetch failed');
    expect(warned).not.toContain('connect');
  });

  it('logs ocp.place.failed with the outer errno when outer has no code', async () => {
    const throwing: MapPush = {
      baseUrl: 'http://map.test',
      token: 'secret',
      fetchImpl: async () => {
        throw Object.assign(new Error('outer-hidden'), {
          errno: 'EAGAIN',
          cause: Object.assign(new Error('inner-hidden'), { code: 'ECONNREFUSED' }),
        });
      },
    };
    await expect(
      syncShopOcpPlace({
        mapPush: throwing,
        messageId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        text: SHOP_TEXT,
        parentId: null,
        place: STALL,
        textHasHashtagToken: () => true,
      }),
    ).resolves.toBeUndefined();
    const failed = parsedEvents(warn).filter((e) => e['event'] === 'ocp.place.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.['name']).toBe('Error');
    expect(failed[0]?.['errno']).toBe('EAGAIN');
    expect(failed[0]?.['code']).not.toBe('ECONNREFUSED');
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).not.toContain('outer-hidden');
    expect(warned).not.toContain('inner-hidden');
    expect(warned).not.toContain('ECONNREFUSED');
  });

  it('logs the bare ocp.place.failed event for a non-Error throw', async () => {
    const throwing: MapPush = {
      baseUrl: 'http://map.test',
      token: 'secret',
      fetchImpl: async () => {
        throw 'token-must-not-appear';
      },
    };
    await expect(
      syncShopOcpPlace({
        mapPush: throwing,
        messageId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        text: SHOP_TEXT,
        parentId: null,
        place: STALL,
        textHasHashtagToken: () => true,
      }),
    ).resolves.toBeUndefined();
    const failed = parsedEvents(warn).filter((e) => e['event'] === 'ocp.place.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.['name']).toBeUndefined();
    expect(failed[0]?.['code']).toBeUndefined();
    expect(failed[0]?.['errno']).toBeUndefined();
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).not.toContain('token-must-not-appear');
  });

  it('does not treat a null cause as a syscall cause', async () => {
    const throwing: MapPush = {
      baseUrl: 'http://map.test',
      token: 'secret',
      fetchImpl: async () => {
        throw Object.assign(new Error('null-cause-hidden'), { cause: null });
      },
    };
    await expect(
      syncShopOcpPlace({
        mapPush: throwing,
        messageId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        text: SHOP_TEXT,
        parentId: null,
        place: STALL,
        textHasHashtagToken: () => true,
      }),
    ).resolves.toBeUndefined();
    const failed = parsedEvents(warn).filter((e) => e['event'] === 'ocp.place.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.['name']).toBe('Error');
    expect(failed[0]?.['code']).toBeUndefined();
    expect(failed[0]?.['errno']).toBeUndefined();
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).not.toContain('null-cause-hidden');
  });

  it('logs ocp.place.failed with the cause errno when the cause has no code', async () => {
    const throwing: MapPush = {
      baseUrl: 'http://map.test',
      token: 'secret',
      fetchImpl: async () => {
        throw Object.assign(new Error('errno-hidden'), {
          cause: { errno: 'ENOENT' },
        });
      },
    };
    await expect(
      syncShopOcpPlace({
        mapPush: throwing,
        messageId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        text: SHOP_TEXT,
        parentId: null,
        place: STALL,
        textHasHashtagToken: () => true,
      }),
    ).resolves.toBeUndefined();
    const failed = parsedEvents(warn).filter((e) => e['event'] === 'ocp.place.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.['name']).toBe('Error');
    expect(failed[0]?.['errno']).toBe('ENOENT');
    expect(failed[0]?.['code']).toBeUndefined();
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).not.toContain('errno-hidden');
  });

  it('logs ocp.place.failed without code or errno when the cause has neither', async () => {
    const throwing: MapPush = {
      baseUrl: 'http://map.test',
      token: 'secret',
      fetchImpl: async () => {
        throw Object.assign(new Error('outer-plain'), {
          cause: new Error('cause-plain'),
        });
      },
    };
    await expect(
      syncShopOcpPlace({
        mapPush: throwing,
        messageId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        text: SHOP_TEXT,
        parentId: null,
        place: STALL,
        textHasHashtagToken: () => true,
      }),
    ).resolves.toBeUndefined();
    const failed = parsedEvents(warn).filter((e) => e['event'] === 'ocp.place.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.['name']).toBe('Error');
    expect(failed[0]?.['code']).toBeUndefined();
    expect(failed[0]?.['errno']).toBeUndefined();
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).not.toContain('outer-plain');
    expect(warned).not.toContain('cause-plain');
  });
});

describe('removeShopOcpPlace', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('deletes origin 21gifts and the message id', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const { mapPush, calls } = recordingPush();
    await removeShopOcpPlace({
      mapPush,
      messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://map.test/map/places');
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.authorization).toBe('Bearer secret');
    expect(timeoutSpy).toHaveBeenCalledWith(5_000);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      origin: '21gifts',
      externalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    timeoutSpy.mockRestore();
  });

  it('does nothing when mapPush is omitted', async () => {
    const { calls } = recordingPush();
    await removeShopOcpPlace({ messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    expect(calls).toEqual([]);
  });

  it('logs ocp.place.failed when the map answers an error or the call throws', async () => {
    const { mapPush } = recordingPush(500);
    await removeShopOcpPlace({
      mapPush,
      messageId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    });
    const throwing: MapPush = {
      baseUrl: 'http://map.test',
      token: 'secret',
      fetchImpl: async () => {
        throw Object.assign(new Error('down'), { address: 'addr-must-not-appear' });
      },
    };
    await expect(
      removeShopOcpPlace({
        mapPush: throwing,
        messageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      }),
    ).resolves.toBeUndefined();
    const failed = parsedEvents(warn).filter((e) => e['event'] === 'ocp.place.failed');
    expect(failed).toHaveLength(2);
    expect(failed[0]?.['status']).toBe(500);
    expect(failed[1]?.['name']).toBe('Error');
    expect(failed[1]).not.toHaveProperty('address');
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).not.toContain('secret');
    expect(warned).not.toContain('down');
    expect(warned).not.toContain('addr-must-not-appear');
  });
});

describe('publishExistingShopPlaces', () => {
  const hasShopTag = (text: string, name: string) => text.includes(`#${name}`);
  const stall = STALL;

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

  it('puts a live shop pin and skips replies, hidden notes, missing rows, and non-shops', async () => {
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
            text: SHOP_TEXT,
            name: 'Ada',
            parentId: null,
            place: stall,
          };
        }
        if (id === 'notag') {
          return {
            id: 'notag',
            text: SHOP_DESCRIPTION,
            name: 'Ada',
            parentId: null,
            place: stall,
          };
        }
        if (id === 'reply') {
          return {
            id: 'reply',
            text: SHOP_TEXT,
            name: 'Ada',
            parentId: 'parent',
            place: stall,
          };
        }
        if (id === 'nullplace') {
          return {
            id: 'nullplace',
            text: SHOP_TEXT,
            name: 'Ada',
            parentId: null,
            place: null,
          };
        }
        if (id === 'undefplace') {
          return {
            id: 'undefplace',
            text: SHOP_TEXT,
            name: 'Ada',
            parentId: null,
          };
        }
        if (id === 'hidden') {
          return {
            id: 'hidden',
            text: SHOP_TEXT,
            name: 'Ada',
            parentId: null,
            place: stall,
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
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.authorization).toBe('Bearer secret');
    expect(timeoutSpy).toHaveBeenCalledWith(5_000);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual(shopOcpPlaceInput('keep', SHOP_TEXT, stall));
    timeoutSpy.mockRestore();
  });

  it('skips an incomplete live shop pin and puts only a complete one', async () => {
    const { mapPush, calls } = recordingPush();
    await publishExistingShopPlaces({
      mapPush,
      listPlaces: async () => [{ id: 'incomplete' }, { id: 'keep' }],
      getById: async (id) => {
        if (id === 'incomplete') {
          return {
            id: 'incomplete',
            text: SHOP_TEXT,
            name: 'Ada',
            parentId: null,
            place: { ...STALL, address: null },
          };
        }
        return {
          id: 'keep',
          text: SHOP_TEXT,
          name: 'Ada',
          parentId: null,
          place: stall,
        };
      },
      textHasHashtagToken: hasShopTag,
    });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual(shopOcpPlaceInput('keep', SHOP_TEXT, stall));
  });

  it('treats HTTP 200 as success and logs no failure', async () => {
    const { mapPush, calls } = recordingPush(200);
    await publishExistingShopPlaces({
      mapPush,
      listPlaces: async () => [{ id: 'keep' }],
      getById: async () => ({
        id: 'keep',
        text: SHOP_TEXT,
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

  it('logs ocp.place.failed on HTTP 500 and still puts the next shop row', async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl: MapFetch = async (input, init) => {
      const headers = new Headers(init.headers);
      calls.push({
        url: String(input),
        method: init.method ?? 'GET',
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
        text: SHOP_TEXT,
        name: 'Ada',
        parentId: null,
        place: stall,
      }),
      textHasHashtagToken: hasShopTag,
    });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual(
      shopOcpPlaceInput('first', SHOP_TEXT, stall),
    );
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual(
      shopOcpPlaceInput('second', SHOP_TEXT, stall),
    );
    const failed = parsedEvents(warn).filter((e) => e['event'] === 'ocp.place.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.['status']).toBe(500);
    expect(Object.keys(failed[0] ?? {}).filter((key) => key !== 'ts' && key !== 'event')).toEqual([
      'status',
    ]);
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).not.toContain('secret');
  });

  it('logs ocp.place.failed when fetch throws and does not reject', async () => {
    const throwing: MapPush = {
      baseUrl: 'http://map.test',
      token: 'secret',
      fetchImpl: async () => {
        throw Object.assign(new Error('down'), { address: 'addr-must-not-appear' });
      },
    };
    await expect(
      publishExistingShopPlaces({
        mapPush: throwing,
        listPlaces: async () => [{ id: 'keep' }],
        getById: async () => ({
          id: 'keep',
          text: SHOP_TEXT,
          name: 'Ada',
          parentId: null,
          place: stall,
        }),
        textHasHashtagToken: hasShopTag,
      }),
    ).resolves.toBeUndefined();
    const failed = parsedEvents(warn).filter((e) => e['event'] === 'ocp.place.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.['name']).toBe('Error');
    expect(failed[0]).not.toHaveProperty('address');
    expect(Object.keys(failed[0] ?? {}).filter((key) => key !== 'ts' && key !== 'event')).toEqual([
      'name',
    ]);
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).not.toContain('down');
    expect(warned).not.toContain('secret');
    expect(warned).not.toContain('addr-must-not-appear');
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
          text: SHOP_TEXT,
          name: 'Ada',
          parentId: null,
          place: stall,
        };
      },
      textHasHashtagToken: hasShopTag,
    });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual(shopOcpPlaceInput('keep', SHOP_TEXT, stall));
    expect(parsedEvents(warn).filter((e) => e['event'] === 'ocp.place.failed')).toHaveLength(1);
  });
});
