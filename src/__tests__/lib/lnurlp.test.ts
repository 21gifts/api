import { describe, it, expect } from 'vitest';
import { resolveLnurlp, type FetchFn } from '@/lib/lnurlp';

const ADDRESS = 'alice@walletofsatoshi.com';
const MAX_SENDABLE = 100_000_000_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('resolveLnurlp', () => {
  it('returns metadata on the happy path (https callback, min/max, commentAllowed)', async () => {
    const fetchImpl: FetchFn = async (input, init) => {
      expect(String(input)).toBe('https://walletofsatoshi.com/.well-known/lnurlp/alice');
      expect(init).toEqual({ redirect: 'error' });
      return jsonResponse({
        callback: 'https://walletofsatoshi.com/lnurlp/callback',
        minSendable: 1000,
        maxSendable: MAX_SENDABLE,
        commentAllowed: 255,
      });
    };

    const result = await resolveLnurlp({ address: ADDRESS, fetchImpl });
    expect(result).toEqual({
      ok: true,
      metadata: {
        callback: 'https://walletofsatoshi.com/lnurlp/callback',
        minSendable: 1000,
        maxSendable: MAX_SENDABLE,
        commentAllowed: 255,
      },
    });
  });

  it('omits commentAllowed when the provider omitted it', async () => {
    const fetchImpl: FetchFn = async () =>
      jsonResponse({
        callback: 'https://walletofsatoshi.com/lnurlp/callback',
        minSendable: 1000,
        maxSendable: MAX_SENDABLE,
      });

    const result = await resolveLnurlp({ address: ADDRESS, fetchImpl });
    expect(result).toEqual({
      ok: true,
      metadata: {
        callback: 'https://walletofsatoshi.com/lnurlp/callback',
        minSendable: 1000,
        maxSendable: MAX_SENDABLE,
      },
    });
  });

  it('rejects a domain containing a slash', async () => {
    const fetchImpl: FetchFn = async () => {
      throw new Error('fetch must not be called');
    };
    const result = await resolveLnurlp({
      address: 'alice@evil.com/path',
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('rejects an address without a local part', async () => {
    const result = await resolveLnurlp({
      address: '@walletofsatoshi.com',
      fetchImpl: async () => {
        throw new Error('fetch must not be called');
      },
    });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('rejects an address with no @ separator', async () => {
    const result = await resolveLnurlp({
      address: 'not-an-address',
      fetchImpl: async () => {
        throw new Error('fetch must not be called');
      },
    });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('rejects an address that ends with @', async () => {
    const result = await resolveLnurlp({
      address: 'alice@',
      fetchImpl: async () => {
        throw new Error('fetch must not be called');
      },
    });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('maps a thrown fetch to unreachable', async () => {
    const fetchImpl: FetchFn = async () => {
      throw new Error('network down');
    };
    const result = await resolveLnurlp({ address: ADDRESS, fetchImpl });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('rejects non-OK HTTP', async () => {
    const fetchImpl: FetchFn = async () => jsonResponse({}, 404);
    const result = await resolveLnurlp({ address: ADDRESS, fetchImpl });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('rejects bad JSON', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response('not-json', { status: 200, headers: { 'content-type': 'text/plain' } });
    const result = await resolveLnurlp({ address: ADDRESS, fetchImpl });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('rejects invalid metadata shape', async () => {
    const fetchImpl: FetchFn = async () =>
      jsonResponse({ callback: 'not-a-url', minSendable: 1000, maxSendable: MAX_SENDABLE });
    const result = await resolveLnurlp({ address: ADDRESS, fetchImpl });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('rejects an http callback', async () => {
    const fetchImpl: FetchFn = async () =>
      jsonResponse({
        callback: 'http://walletofsatoshi.com/lnurlp/callback',
        minSendable: 1000,
        maxSendable: MAX_SENDABLE,
      });
    const result = await resolveLnurlp({ address: ADDRESS, fetchImpl });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('rejects when maxSendable is below minSendable', async () => {
    const fetchImpl: FetchFn = async () =>
      jsonResponse({
        callback: 'https://walletofsatoshi.com/lnurlp/callback',
        minSendable: 5000,
        maxSendable: 1000,
      });
    const result = await resolveLnurlp({ address: ADDRESS, fetchImpl });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('passes redirect: error so redirects are not followed', async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl: FetchFn = async (_input, init) => {
      seenInit = init;
      return jsonResponse({
        callback: 'https://walletofsatoshi.com/lnurlp/callback',
        minSendable: 1000,
        maxSendable: MAX_SENDABLE,
      });
    };
    await resolveLnurlp({ address: ADDRESS, fetchImpl });
    expect(seenInit).toEqual({ redirect: 'error' });
  });

  it('encodes the local part in the well-known path', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchFn = async (input) => {
      calls.push(String(input));
      return jsonResponse({
        callback: 'https://example.com/cb',
        minSendable: 0,
        maxSendable: MAX_SENDABLE,
      });
    };
    await resolveLnurlp({ address: 'a+b@example.com', fetchImpl });
    expect(calls[0]).toBe('https://example.com/.well-known/lnurlp/a%2Bb');
  });
});
