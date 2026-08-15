import { describe, it, expect } from 'vitest';
import { LN_ADDRESS_CACHE_TTL_MS } from '@/lib/config';
import { InMemoryLnAddressCache } from '@/lib/ln-address-cache';
import type { FetchFn } from '@/lib/lnurlp';
import { createApp } from '@/server';

const ADDRESS = 'alice@walletofsatoshi.com';
const MAX_SENDABLE = 100_000_000_000;
const CALLBACK = 'https://walletofsatoshi.com/lnurlp/callback';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function happyMetadata(commentAllowed?: number): unknown {
  const body: {
    callback: string;
    minSendable: number;
    maxSendable: number;
    commentAllowed?: number;
  } = {
    callback: CALLBACK,
    minSendable: 1000,
    maxSendable: MAX_SENDABLE,
  };
  if (commentAllowed !== undefined) {
    body.commentAllowed = commentAllowed;
  }
  return body;
}

describe('GET /lightning-address', () => {
  it('returns 400 when the address query is missing', async () => {
    const res = await createApp().request('/lightning-address');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Not a valid Lightning Address (expected name@domain)',
    });
  });

  it('returns 400 when the address query is empty', async () => {
    const res = await createApp().request('/lightning-address?address=');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Not a valid Lightning Address (expected name@domain)',
    });
  });

  it('returns 400 for a non LUD-16 address shape', async () => {
    const res = await createApp().request('/lightning-address?address=not-an-address');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Not a valid Lightning Address (expected name@domain)',
    });
  });

  it('returns 400 when the address is longer than 255 characters', async () => {
    // 251 + '@x.co' (5) = 256 characters after trim — over the LUD-16 bound.
    const long = `${'a'.repeat(251)}@x.co`;
    const res = await createApp().request(`/lightning-address?address=${encodeURIComponent(long)}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Not a valid Lightning Address (expected name@domain)',
    });
  });

  it('returns 502 when the well-known fetch fails', async () => {
    const fetchImpl: FetchFn = async () => {
      throw new Error('network down');
    };
    const res = await createApp({ fetchImpl }).request(
      `/lightning-address?address=${encodeURIComponent(ADDRESS)}`,
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'Lightning Address could not be resolved',
    });
  });

  it('returns 502 when metadata is unreachable', async () => {
    const fetchImpl: FetchFn = async () => jsonResponse({}, 404);
    const res = await createApp({ fetchImpl }).request(
      `/lightning-address?address=${encodeURIComponent(ADDRESS)}`,
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'Lightning Address could not be resolved',
    });
  });

  it('returns 200 with the normalised payload on success', async () => {
    const fetchImpl: FetchFn = async () => jsonResponse(happyMetadata(255));
    const res = await createApp({ fetchImpl }).request(
      `/lightning-address?address=${encodeURIComponent(ADDRESS)}`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      address: ADDRESS,
      callback: CALLBACK,
      minSendable: 1000,
      maxSendable: MAX_SENDABLE,
      commentAllowed: 255,
    });
  });

  it('omits commentAllowed when the provider omitted it', async () => {
    const fetchImpl: FetchFn = async () => jsonResponse(happyMetadata());
    const res = await createApp({ fetchImpl }).request(
      `/lightning-address?address=${encodeURIComponent(ADDRESS)}`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      address: ADDRESS,
      callback: CALLBACK,
      minSendable: 1000,
      maxSendable: MAX_SENDABLE,
    });
  });

  it('serves a second GET from cache without calling fetch again', async () => {
    let fetchCount = 0;
    const fetchImpl: FetchFn = async () => {
      fetchCount += 1;
      return jsonResponse(happyMetadata(255));
    };
    const cache = new InMemoryLnAddressCache();
    let now = 1_000_000;
    const app = createApp({
      fetchImpl,
      lnAddressCache: cache,
      now: () => now,
    });

    const first = await app.request(`/lightning-address?address=${encodeURIComponent(ADDRESS)}`);
    expect(first.status).toBe(200);
    expect(fetchCount).toBe(1);

    now += 1_000;
    const second = await app.request(`/lightning-address?address=${encodeURIComponent(ADDRESS)}`);
    expect(second.status).toBe(200);
    expect(fetchCount).toBe(1);
    expect(await second.json()).toEqual({
      address: ADDRESS,
      callback: CALLBACK,
      minSendable: 1000,
      maxSendable: MAX_SENDABLE,
      commentAllowed: 255,
    });
  });

  it('calls fetch again after the cache TTL elapses', async () => {
    let fetchCount = 0;
    const fetchImpl: FetchFn = async () => {
      fetchCount += 1;
      return jsonResponse(happyMetadata(255));
    };
    const cache = new InMemoryLnAddressCache();
    let now = 1_000_000;
    const app = createApp({
      fetchImpl,
      lnAddressCache: cache,
      now: () => now,
    });

    await app.request(`/lightning-address?address=${encodeURIComponent(ADDRESS)}`);
    expect(fetchCount).toBe(1);

    now += LN_ADDRESS_CACHE_TTL_MS;
    const res = await app.request(`/lightning-address?address=${encodeURIComponent(ADDRESS)}`);
    expect(res.status).toBe(200);
    expect(fetchCount).toBe(2);
  });

  it('reflects CORS origin for a guest GET from the app surface', async () => {
    const fetchImpl: FetchFn = async () => jsonResponse(happyMetadata(255));
    const res = await createApp({ fetchImpl }).request(
      `/lightning-address?address=${encodeURIComponent(ADDRESS)}`,
      { headers: { origin: 'https://app.21.gifts' } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.21.gifts');
  });
});
