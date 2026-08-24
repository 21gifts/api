import { describe, it, expect } from 'vitest';
import { requestGiftInvoice } from '@/lib/gift-invoice';
import type { FetchFn } from '@/lib/lnurlp';

const ADDRESS = 'alice@walletofsatoshi.com';
const PR = 'lnbc10n1ptest';
const MAX_SENDABLE = 100_000_000_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('requestGiftInvoice', () => {
  it('returns pr and does not raise the amount to minSendable', async () => {
    const calls: string[] = [];
    const redirects: Array<RequestInit['redirect'] | undefined> = [];
    const fetchImpl: FetchFn = async (input, init) => {
      const url = String(input);
      calls.push(url);
      redirects.push(init?.redirect);
      if (url.includes('/.well-known/lnurlp/')) {
        return jsonResponse({
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: MAX_SENDABLE,
          commentAllowed: 255,
        });
      }
      return jsonResponse({ pr: PR });
    };

    const result = await requestGiftInvoice({
      address: ADDRESS,
      amountMsat: 1000,
      fetchImpl,
    });

    expect(result).toEqual({ ok: true, pr: PR });
    expect(calls[1]).toContain('amount=1000');
    expect(redirects[1]).toBe('error');
    expect(new URL(calls[1] ?? '').searchParams.get('comment')).toBeNull();
  });

  it('attaches a comment when provided and allowed', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchFn = async (input) => {
      calls.push(String(input));
      if (String(input).includes('/.well-known/lnurlp/')) {
        return jsonResponse({
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: MAX_SENDABLE,
          commentAllowed: 255,
        });
      }
      return jsonResponse({ pr: PR });
    };

    await requestGiftInvoice({
      address: ADDRESS,
      amountMsat: 1000,
      comment: '21gifts daily',
      fetchImpl,
    });
    expect(new URL(calls[1] ?? '').searchParams.get('comment')).toBe('21gifts daily');
  });

  it('rejects when amount is below minSendable', async () => {
    const fetchImpl: FetchFn = async () =>
      jsonResponse({
        callback: 'https://walletofsatoshi.com/lnurlp/callback',
        minSendable: 5000,
        maxSendable: MAX_SENDABLE,
      });
    expect(await requestGiftInvoice({ address: ADDRESS, amountMsat: 1000, fetchImpl })).toEqual({
      ok: false,
      reason: 'unreachable',
    });
  });

  it('rejects when amount is above maxSendable', async () => {
    const fetchImpl: FetchFn = async () =>
      jsonResponse({
        callback: 'https://walletofsatoshi.com/lnurlp/callback',
        minSendable: 1000,
        maxSendable: 2000,
      });
    expect(await requestGiftInvoice({ address: ADDRESS, amountMsat: 3000, fetchImpl })).toEqual({
      ok: false,
      reason: 'unreachable',
    });
  });

  it('rejects a comment when commentAllowed is missing', async () => {
    const fetchImpl: FetchFn = async () =>
      jsonResponse({
        callback: 'https://walletofsatoshi.com/lnurlp/callback',
        minSendable: 1000,
        maxSendable: MAX_SENDABLE,
      });
    expect(
      await requestGiftInvoice({
        address: ADDRESS,
        amountMsat: 1000,
        comment: 'hi',
        fetchImpl,
      }),
    ).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('rejects a comment longer than commentAllowed', async () => {
    const fetchImpl: FetchFn = async () =>
      jsonResponse({
        callback: 'https://walletofsatoshi.com/lnurlp/callback',
        minSendable: 1000,
        maxSendable: MAX_SENDABLE,
        commentAllowed: 2,
      });
    expect(
      await requestGiftInvoice({
        address: ADDRESS,
        amountMsat: 1000,
        comment: 'toolong',
        fetchImpl,
      }),
    ).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('collapses resolve failure', async () => {
    const fetchImpl: FetchFn = async () => jsonResponse({}, 500);
    expect(await requestGiftInvoice({ address: ADDRESS, amountMsat: 1000, fetchImpl })).toEqual({
      ok: false,
      reason: 'unreachable',
    });
  });

  it('collapses callback network failure', async () => {
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).includes('/.well-known/lnurlp/')) {
        return jsonResponse({
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: MAX_SENDABLE,
        });
      }
      throw new Error('offline');
    };
    expect(await requestGiftInvoice({ address: ADDRESS, amountMsat: 1000, fetchImpl })).toEqual({
      ok: false,
      reason: 'unreachable',
    });
  });

  it('collapses callback HTTP error', async () => {
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).includes('/.well-known/lnurlp/')) {
        return jsonResponse({
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: MAX_SENDABLE,
        });
      }
      return jsonResponse({ pr: PR }, 500);
    };
    expect(await requestGiftInvoice({ address: ADDRESS, amountMsat: 1000, fetchImpl })).toEqual({
      ok: false,
      reason: 'unreachable',
    });
  });

  it('collapses callback non-JSON', async () => {
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).includes('/.well-known/lnurlp/')) {
        return jsonResponse({
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: MAX_SENDABLE,
        });
      }
      return new Response('not-json', { status: 200 });
    };
    expect(await requestGiftInvoice({ address: ADDRESS, amountMsat: 1000, fetchImpl })).toEqual({
      ok: false,
      reason: 'unreachable',
    });
  });

  it('collapses callback schema failure', async () => {
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).includes('/.well-known/lnurlp/')) {
        return jsonResponse({
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: MAX_SENDABLE,
        });
      }
      return jsonResponse({ nope: true });
    };
    expect(await requestGiftInvoice({ address: ADDRESS, amountMsat: 1000, fetchImpl })).toEqual({
      ok: false,
      reason: 'unreachable',
    });
  });
});
