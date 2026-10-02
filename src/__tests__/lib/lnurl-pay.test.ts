import { describe, it, expect } from 'vitest';
import { requestZapInvoice, type FetchFn } from '@/lib/lnurl-pay';

const ADDRESS = 'alice@wallet.example';
const PR = 'lnbc10n1ptest';
const MAX_SENDABLE = 100_000_000_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

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
          callback: 'https://wallet.example/lnurlp/callback',
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
        callback: 'https://wallet.example/lnurlp/callback',
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
        callback: 'https://wallet.example/lnurlp/callback',
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
          callback: 'https://wallet.example/lnurlp/callback',
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
          callback: 'https://wallet.example/lnurlp/callback',
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
          callback: 'https://wallet.example/lnurlp/callback',
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

  it('treats a non-2xx callback with a pr field as unreachable', async () => {
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).includes('/.well-known/lnurlp/')) {
        return jsonResponse({
          callback: 'https://wallet.example/lnurlp/callback',
          minSendable: 1000,
          maxSendable: MAX_SENDABLE,
          allowsNostr: true,
          nostrPubkey: 'aa'.repeat(32),
        });
      }
      return jsonResponse({ pr: 'lnbc1fail' }, 502);
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
      lnurlResponse: { pr: 'lnbc1fail' },
    });
  });

  it('returns unreachable with lnurlResponse null when the callback fetch throws', async () => {
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).includes('/.well-known/lnurlp/')) {
        return jsonResponse({
          callback: 'https://wallet.example/lnurlp/callback',
          minSendable: 1000,
          maxSendable: MAX_SENDABLE,
          allowsNostr: true,
          nostrPubkey: 'aa'.repeat(32),
        });
      }
      throw new Error('callback down');
    };
    const result = await requestZapInvoice({
      address: ADDRESS,
      amountMsat: 1000,
      zapRequestJson: '{}',
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, reason: 'unreachable', lnurlResponse: null });
  });

  it('returns unreachable with lnurlResponse null when the callback json() throws', async () => {
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).includes('/.well-known/lnurlp/')) {
        return jsonResponse({
          callback: 'https://wallet.example/lnurlp/callback',
          minSendable: 1000,
          maxSendable: MAX_SENDABLE,
          allowsNostr: true,
          nostrPubkey: 'aa'.repeat(32),
        });
      }
      return new Response('not json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const result = await requestZapInvoice({
      address: ADDRESS,
      amountMsat: 1000,
      zapRequestJson: '{}',
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, reason: 'unreachable', lnurlResponse: null });
  });

  it('retries once when the first metadata fetch fails and returns the second invoice', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchFn = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/.well-known/lnurlp/')) {
        if (calls.length === 1) {
          throw new Error('resolve blip');
        }
        return jsonResponse({
          callback: 'https://wallet.example/lnurlp/callback',
          minSendable: 1000,
          maxSendable: MAX_SENDABLE,
          allowsNostr: true,
          nostrPubkey: 'aa'.repeat(32),
        });
      }
      return jsonResponse({ pr: PR });
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
      lnurlResponse: { pr: PR },
    });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain('/.well-known/lnurlp/');
    expect(calls[1]).toContain('/.well-known/lnurlp/');
    expect(calls[2]).toContain('nostr=');
  });

  it('does not retry when the first result is noZap', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchFn = async (input) => {
      calls.push(String(input));
      return jsonResponse({
        callback: 'https://wallet.example/lnurlp/callback',
        minSendable: 1000,
        maxSendable: MAX_SENDABLE,
      });
    };
    const result = await requestZapInvoice({
      address: ADDRESS,
      amountMsat: 1000,
      zapRequestJson: '{}',
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, reason: 'noZap', lnurlResponse: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/.well-known/lnurlp/');
  });
});
