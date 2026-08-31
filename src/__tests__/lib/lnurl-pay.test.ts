import { describe, it, expect } from 'vitest';
import { requestPayInvoice, requestZapInvoice, type FetchFn } from '@/lib/lnurl-pay';
import { VERIFICATION_AMOUNT_CAP_MSAT } from '@/lib/config';

const ADDRESS = 'alice@walletofsatoshi.com';
const COMMENT = '21gifts deadbeefdeadbeefdeadbeefdeadbeef';
const PR = 'lnbc10n1ptest';
const MAX_SENDABLE = 100_000_000_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('requestPayInvoice', () => {
  it('returns pr and payMsat on the happy path (minSendable 1000, commentAllowed 255)', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchFn = async (input) => {
      const url = String(input);
      calls.push(url);
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

    const result = await requestPayInvoice({
      address: ADDRESS,
      amountMsat: 1000,
      comment: COMMENT,
      fetchImpl,
    });

    expect(result).toEqual({ ok: true, pr: PR, payMsat: 1000 });
    expect(calls[0]).toBe('https://walletofsatoshi.com/.well-known/lnurlp/alice');
    expect(calls[1]).toContain('amount=1000');
    const callbackUrl = calls[1];
    expect(callbackUrl).toBeDefined();
    expect(new URL(callbackUrl ?? '').searchParams.get('comment')).toBe(COMMENT);
  });

  it('raises amount to minSendable when higher than the preferred amount', async () => {
    const fetchImpl: FetchFn = async (input) => {
      const url = String(input);
      if (url.includes('/.well-known/lnurlp/')) {
        return jsonResponse({
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
          minSendable: 5000,
          maxSendable: MAX_SENDABLE,
          commentAllowed: 255,
        });
      }
      return jsonResponse({ pr: PR });
    };

    const result = await requestPayInvoice({
      address: ADDRESS,
      amountMsat: 1000,
      comment: COMMENT,
      fetchImpl,
    });

    expect(result).toEqual({ ok: true, pr: PR, payMsat: 5000 });
  });

  it('rejects when commentAllowed is missing', async () => {
    const fetchImpl: FetchFn = async () =>
      jsonResponse({
        callback: 'https://walletofsatoshi.com/lnurlp/callback',
        minSendable: 1000,
        maxSendable: MAX_SENDABLE,
      });

    const result = await requestPayInvoice({
      address: ADDRESS,
      amountMsat: 1000,
      comment: COMMENT,
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('rejects when commentAllowed is below the comment length', async () => {
    const fetchImpl: FetchFn = async () =>
      jsonResponse({
        callback: 'https://walletofsatoshi.com/lnurlp/callback',
        minSendable: 1000,
        maxSendable: MAX_SENDABLE,
        commentAllowed: 5,
      });

    const result = await requestPayInvoice({
      address: ADDRESS,
      amountMsat: 1000,
      comment: COMMENT,
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('rejects when minSendable exceeds the verification amount cap', async () => {
    const fetchImpl: FetchFn = async () =>
      jsonResponse({
        callback: 'https://walletofsatoshi.com/lnurlp/callback',
        minSendable: VERIFICATION_AMOUNT_CAP_MSAT + 1,
        maxSendable: MAX_SENDABLE,
        commentAllowed: 255,
      });

    const result = await requestPayInvoice({
      address: ADDRESS,
      amountMsat: 1000,
      comment: COMMENT,
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('rejects non-OK HTTP on the metadata request', async () => {
    const fetchImpl: FetchFn = async () => jsonResponse({}, 404);
    const result = await requestPayInvoice({
      address: ADDRESS,
      amountMsat: 1000,
      comment: COMMENT,
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('rejects bad JSON on the metadata request', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response('not-json', { status: 200, headers: { 'content-type': 'text/plain' } });
    const result = await requestPayInvoice({
      address: ADDRESS,
      amountMsat: 1000,
      comment: COMMENT,
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('rejects invalid metadata shape', async () => {
    const fetchImpl: FetchFn = async () =>
      jsonResponse({
        callback: 'not-a-url',
        minSendable: 1000,
        maxSendable: MAX_SENDABLE,
        commentAllowed: 255,
      });
    const result = await requestPayInvoice({
      address: ADDRESS,
      amountMsat: 1000,
      comment: COMMENT,
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('rejects non-OK HTTP on the invoice callback', async () => {
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).includes('/.well-known/lnurlp/')) {
        return jsonResponse({
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: MAX_SENDABLE,
          commentAllowed: 255,
        });
      }
      return jsonResponse({}, 500);
    };
    const result = await requestPayInvoice({
      address: ADDRESS,
      amountMsat: 1000,
      comment: COMMENT,
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('rejects an empty bolt11 pr', async () => {
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).includes('/.well-known/lnurlp/')) {
        return jsonResponse({
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: MAX_SENDABLE,
          commentAllowed: 255,
        });
      }
      return jsonResponse({ pr: '' });
    };
    const result = await requestPayInvoice({
      address: ADDRESS,
      amountMsat: 1000,
      comment: COMMENT,
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('rejects a domain containing a slash', async () => {
    const fetchImpl: FetchFn = async () => {
      throw new Error('fetch must not be called');
    };
    const result = await requestPayInvoice({
      address: 'alice@evil.com/path',
      amountMsat: 1000,
      comment: COMMENT,
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('rejects an address without a local part', async () => {
    const result = await requestPayInvoice({
      address: '@walletofsatoshi.com',
      amountMsat: 1000,
      comment: COMMENT,
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
    const result = await requestPayInvoice({
      address: ADDRESS,
      amountMsat: 1000,
      comment: COMMENT,
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('rejects bad JSON on the invoice callback', async () => {
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).includes('/.well-known/lnurlp/')) {
        return jsonResponse({
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: MAX_SENDABLE,
          commentAllowed: 255,
        });
      }
      return new Response('not-json', { status: 200 });
    };
    const result = await requestPayInvoice({
      address: ADDRESS,
      amountMsat: 1000,
      comment: COMMENT,
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('rejects an address with no @ separator', async () => {
    const result = await requestPayInvoice({
      address: 'not-an-address',
      amountMsat: 1000,
      comment: COMMENT,
      fetchImpl: async () => {
        throw new Error('fetch must not be called');
      },
    });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('maps a non-ok invoice callback to unreachable', async () => {
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).includes('/.well-known/lnurlp/')) {
        return jsonResponse({
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: MAX_SENDABLE,
          commentAllowed: 255,
        });
      }
      return new Response('nope', { status: 502 });
    };
    const result = await requestPayInvoice({
      address: ADDRESS,
      amountMsat: 1000,
      comment: COMMENT,
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('maps a thrown fetch on the invoice callback to unreachable', async () => {
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).includes('/.well-known/lnurlp/')) {
        return jsonResponse({
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: MAX_SENDABLE,
          commentAllowed: 255,
        });
      }
      throw new Error('callback down');
    };
    const result = await requestPayInvoice({
      address: ADDRESS,
      amountMsat: 1000,
      comment: COMMENT,
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });
});

describe('requestZapInvoice', () => {
  it('returns unreachable when LNURL metadata cannot be resolved', async () => {
    const result = await requestZapInvoice({
      address: 'not-an-address',
      amountMsat: 1000,
      zapRequestJson: '{}',
      fetchImpl: async () => {
        throw new Error('no');
      },
    });
    expect(result).toEqual({ ok: false, reason: 'unreachable', lnurlResponse: null });
  });

  it('returns pr and lnurlResponse when allowsNostr is true', async () => {
    const callbackBody = { pr: PR, status: 'OK' };
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).includes('/.well-known/lnurlp/')) {
        return jsonResponse({
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: MAX_SENDABLE,
          allowsNostr: true,
          nostrPubkey: 'aa'.repeat(32),
        });
      }
      expect(String(input)).toContain('nostr=');
      return jsonResponse(callbackBody);
    };
    const result = await requestZapInvoice({
      address: ADDRESS,
      amountMsat: 21000,
      zapRequestJson: '{}',
      fetchImpl,
    });
    expect(result).toEqual({
      ok: true,
      pr: PR,
      amountSats: 21,
      lnurlResponse: callbackBody,
    });
  });

  it('returns noZap when allowsNostr is missing', async () => {
    const fetchImpl: FetchFn = async () =>
      jsonResponse({
        callback: 'https://walletofsatoshi.com/lnurlp/callback',
        minSendable: 1000,
        maxSendable: MAX_SENDABLE,
      });
    const result = await requestZapInvoice({
      address: ADDRESS,
      amountMsat: 1000,
      zapRequestJson: '{}',
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, reason: 'noZap', lnurlResponse: null });
  });

  it('returns unreachable when the amount is out of range', async () => {
    const fetchImpl: FetchFn = async () =>
      jsonResponse({
        callback: 'https://walletofsatoshi.com/lnurlp/callback',
        minSendable: 1000,
        maxSendable: 2000,
        allowsNostr: true,
        nostrPubkey: 'aa'.repeat(32),
      });
    const result = await requestZapInvoice({
      address: ADDRESS,
      amountMsat: 21_000,
      zapRequestJson: '{}',
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, reason: 'unreachable', lnurlResponse: null });
  });

  it('returns unreachable with lnurlResponse when the callback JSON is schema-invalid', async () => {
    const invalidBody = { error: 'nope', detail: 'missing pr' };
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).includes('/.well-known/lnurlp/')) {
        return jsonResponse({
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: MAX_SENDABLE,
          allowsNostr: true,
          nostrPubkey: 'aa'.repeat(32),
        });
      }
      return jsonResponse(invalidBody);
    };
    const result = await requestZapInvoice({
      address: ADDRESS,
      amountMsat: 1000,
      zapRequestJson: '{}',
      fetchImpl,
    });
    expect(result).toEqual({
      ok: false,
      reason: 'unreachable',
      lnurlResponse: invalidBody,
    });
  });

  it('returns unreachable with lnurlResponse null when the callback JSON is an array', async () => {
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).includes('/.well-known/lnurlp/')) {
        return jsonResponse({
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: MAX_SENDABLE,
          allowsNostr: true,
          nostrPubkey: 'aa'.repeat(32),
        });
      }
      return jsonResponse([{ pr: PR }]);
    };
    const result = await requestZapInvoice({
      address: ADDRESS,
      amountMsat: 1000,
      zapRequestJson: '{}',
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, reason: 'unreachable', lnurlResponse: null });
  });

  it('returns unreachable with callback JSON when the callback HTTP fails', async () => {
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).includes('/.well-known/lnurlp/')) {
        return jsonResponse({
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: MAX_SENDABLE,
          allowsNostr: true,
          nostrPubkey: 'aa'.repeat(32),
        });
      }
      return jsonResponse({}, 500);
    };
    const result = await requestZapInvoice({
      address: ADDRESS,
      amountMsat: 1000,
      zapRequestJson: '{}',
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, reason: 'unreachable', lnurlResponse: {} });
  });
});
