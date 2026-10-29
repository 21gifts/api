import { describe, it, expect, vi } from 'vitest';
import { requestGiftInvoice } from '@/lib/gift-invoice';
import { LNURLP_METADATA_TIMEOUT_MS, type FetchFn } from '@/lib/lnurlp';

const ADDRESS = 'alice@example.com';
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
          callback: 'https://example.com/lnurlp/callback',
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
          callback: 'https://example.com/lnurlp/callback',
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
        callback: 'https://example.com/lnurlp/callback',
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
        callback: 'https://example.com/lnurlp/callback',
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
        callback: 'https://example.com/lnurlp/callback',
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
        callback: 'https://example.com/lnurlp/callback',
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
          callback: 'https://example.com/lnurlp/callback',
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
          callback: 'https://example.com/lnurlp/callback',
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
          callback: 'https://example.com/lnurlp/callback',
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
          callback: 'https://example.com/lnurlp/callback',
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

  describe('with a deadline', () => {
    interface Seen {
      url: string;
      init: RequestInit | undefined;
    }

    function provider(seen: Seen[], onCall?: () => void): FetchFn {
      return async (input, init) => {
        seen.push({ url: String(input), init });
        onCall?.();
        if (String(input).includes('/.well-known/lnurlp/')) {
          return jsonResponse({
            callback: 'https://example.com/lnurlp/callback',
            minSendable: 1000,
            maxSendable: MAX_SENDABLE,
          });
        }
        return jsonResponse({ pr: PR });
      };
    }

    it('hands the resolve the time left, and the callback what is left after the resolve', async () => {
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      const seen: Seen[] = [];
      let clock = 1_000;
      const result = await requestGiftInvoice({
        address: ADDRESS,
        amountMsat: 1000,
        fetchImpl: provider(seen, () => {
          clock += 2_500;
        }),
        deadlineMs: 10_000,
        now: () => clock,
      });
      expect(result).toEqual({ ok: true, pr: PR });
      expect(seen).toHaveLength(2);
      // The resolve's own metadata timeout, then the wrapper's: resolve at
      // 1000 gets 9000 ms, the callback at 3500 gets 6500 ms.
      expect(timeout.mock.calls).toEqual([[LNURLP_METADATA_TIMEOUT_MS], [9_000], [6_500]]);
      // The wrapper's signal replaces the resolve's own on the wire.
      expect(seen[0]?.init?.signal).toBe(timeout.mock.results[1]?.value);
      expect(seen[1]?.init?.signal).toBe(timeout.mock.results[2]?.value);
      timeout.mockRestore();
    });

    it('hands both calls an abort signal and keeps their other options', async () => {
      const seen: Seen[] = [];
      const result = await requestGiftInvoice({
        address: ADDRESS,
        amountMsat: 1000,
        fetchImpl: provider(seen),
        deadlineMs: 10_000,
        now: () => 1_000,
      });
      expect(result).toEqual({ ok: true, pr: PR });
      expect(seen).toHaveLength(2);
      for (const call of seen) {
        expect(call.init?.signal).toBeInstanceOf(AbortSignal);
        expect(call.init?.signal?.aborted).toBe(false);
        expect(call.init?.redirect).toBe('error');
      }
    });

    it('fails like an unreachable provider without a request once the deadline passed', async () => {
      const seen: Seen[] = [];
      const result = await requestGiftInvoice({
        address: ADDRESS,
        amountMsat: 1000,
        fetchImpl: provider(seen),
        deadlineMs: 1_000,
        now: () => 1_000,
      });
      expect(result).toEqual({ ok: false, reason: 'unreachable' });
      expect(seen).toHaveLength(0);
    });

    it('skips the callback when the resolve used up the time', async () => {
      const seen: Seen[] = [];
      let clock = 1_000;
      const result = await requestGiftInvoice({
        address: ADDRESS,
        amountMsat: 1000,
        fetchImpl: provider(seen, () => {
          clock = 5_000;
        }),
        deadlineMs: 5_000,
        now: () => clock,
      });
      expect(result).toEqual({ ok: false, reason: 'unreachable' });
      expect(seen.map((call) => call.url)).toEqual([
        'https://example.com/.well-known/lnurlp/alice',
      ]);
    });

    it('without a deadline, sets no timeout of its own on either call', async () => {
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      const seen: Seen[] = [];
      expect(
        await requestGiftInvoice({ address: ADDRESS, amountMsat: 1000, fetchImpl: provider(seen) }),
      ).toEqual({ ok: true, pr: PR });
      expect(seen).toHaveLength(2);
      // Only the resolve's own metadata timeout applies; the callback gets none.
      expect(timeout.mock.calls).toEqual([[LNURLP_METADATA_TIMEOUT_MS]]);
      expect(seen[0]?.init?.signal).toBe(timeout.mock.results[0]?.value);
      expect(seen[1]?.init?.signal).toBeUndefined();
      timeout.mockRestore();
    });

    it('defaults the clock to Date.now', async () => {
      const seen: Seen[] = [];
      const ok = await requestGiftInvoice({
        address: ADDRESS,
        amountMsat: 1000,
        fetchImpl: provider(seen),
        deadlineMs: Date.now() + 60_000,
      });
      expect(ok).toEqual({ ok: true, pr: PR });
      const late = await requestGiftInvoice({
        address: ADDRESS,
        amountMsat: 1000,
        fetchImpl: provider(seen),
        deadlineMs: Date.now() - 1,
      });
      expect(late).toEqual({ ok: false, reason: 'unreachable' });
      expect(seen).toHaveLength(2);
    });
  });
});
