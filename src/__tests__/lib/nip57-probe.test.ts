import { describe, it, expect, vi, afterEach } from 'vitest';
import type { EventTemplate } from 'nostr-tools/pure';
import type { FetchFn } from '@/lib/lnurlp';
import { LIGHTNING_ADDRESS_NOT_ZAP, probeNip57Mint } from '@/lib/nip57-probe';

const ADDRESS = 'alice@walletofsatoshi.com';
const PUBKEY = 'aa'.repeat(32);
const PR = 'lnbc10n1ptest';
const MAX_SENDABLE = 100_000_000_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function zapMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    callback: 'https://walletofsatoshi.com/lnurlp/callback',
    minSendable: 1000,
    maxSendable: MAX_SENDABLE,
    allowsNostr: true,
    nostrPubkey: PUBKEY,
    ...overrides,
  };
}

function zapCapableFetch(callbackBody: unknown = { pr: PR }): FetchFn {
  return async (input) => {
    if (String(input).includes('/.well-known/lnurlp/')) {
      return jsonResponse(zapMeta());
    }
    return jsonResponse(callbackBody);
  };
}

async function withNip57(value: boolean, run: () => Promise<unknown>): Promise<void> {
  const bolt11 = await import('@/lib/bolt11');
  const spy = vi.spyOn(bolt11, 'isNip57Invoice').mockReturnValue(value);
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('probeNip57Mint', () => {
  it('exports LIGHTNING_ADDRESS_NOT_ZAP', () => {
    expect(LIGHTNING_ADDRESS_NOT_ZAP).toBe(
      'This Wallet of Satoshi address cannot receive these Bitcoin payments',
    );
  });

  it('returns unreachable when LNURL metadata cannot be resolved', async () => {
    const result = await probeNip57Mint({
      address: 'not-an-address',
      recipientPubkey: PUBKEY,
      sign: async () => ({}),
      fetchImpl: async () => {
        throw new Error('no');
      },
    });
    expect(result).toBe('unreachable');
  });

  it('returns unreachable when allowsNostr is missing', async () => {
    const fetchImpl: FetchFn = async () =>
      jsonResponse({
        callback: 'https://walletofsatoshi.com/lnurlp/callback',
        minSendable: 1000,
        maxSendable: MAX_SENDABLE,
      });
    const result = await probeNip57Mint({
      address: ADDRESS,
      recipientPubkey: PUBKEY,
      sign: async () => ({}),
      fetchImpl,
    });
    expect(result).toBe('unreachable');
  });

  it('returns unreachable when allowsNostr is true but nostrPubkey is missing', async () => {
    const fetchImpl: FetchFn = async () =>
      jsonResponse({
        callback: 'https://walletofsatoshi.com/lnurlp/callback',
        minSendable: 1000,
        maxSendable: MAX_SENDABLE,
        allowsNostr: true,
      });
    const result = await probeNip57Mint({
      address: ADDRESS,
      recipientPubkey: PUBKEY,
      sign: async () => ({}),
      fetchImpl,
    });
    expect(result).toBe('unreachable');
  });

  it('returns unreachable when nostrPubkey is blank', async () => {
    const fetchImpl: FetchFn = async () => jsonResponse(zapMeta({ nostrPubkey: '   ' }));
    const result = await probeNip57Mint({
      address: ADDRESS,
      recipientPubkey: PUBKEY,
      sign: async () => ({}),
      fetchImpl,
    });
    expect(result).toBe('unreachable');
  });

  it('returns not_zap when requestZapInvoice reports noZap', async () => {
    let wellKnown = 0;
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).includes('/.well-known/lnurlp/')) {
        wellKnown += 1;
        if (wellKnown === 1) {
          return jsonResponse(zapMeta());
        }
        return jsonResponse({
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: MAX_SENDABLE,
        });
      }
      return jsonResponse({ pr: PR });
    };
    const result = await probeNip57Mint({
      address: ADDRESS,
      recipientPubkey: PUBKEY,
      sign: async (unsigned: EventTemplate) => ({
        ...unsigned,
        id: '1',
        sig: '2',
        pubkey: PUBKEY,
      }),
      fetchImpl,
    });
    expect(result).toBe('not_zap');
  });

  it('returns unreachable when amount exceeds maxSendable', async () => {
    const fetchImpl: FetchFn = async () =>
      jsonResponse(zapMeta({ minSendable: 5000, maxSendable: 2000 }));
    const result = await probeNip57Mint({
      address: ADDRESS,
      recipientPubkey: PUBKEY,
      sign: async () => ({}),
      fetchImpl,
    });
    expect(result).toBe('unreachable');
  });

  it('returns unreachable when sign throws', async () => {
    const result = await probeNip57Mint({
      address: ADDRESS,
      recipientPubkey: PUBKEY,
      sign: async () => {
        throw new Error('sign failed');
      },
      fetchImpl: zapCapableFetch(),
    });
    expect(result).toBe('unreachable');
  });

  it('returns unreachable when the zap invoice callback fails', async () => {
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).includes('/.well-known/lnurlp/')) {
        return jsonResponse(zapMeta());
      }
      return jsonResponse({}, 500);
    };
    const result = await probeNip57Mint({
      address: ADDRESS,
      recipientPubkey: PUBKEY,
      sign: async (unsigned: EventTemplate) => ({ ...unsigned, id: '1', sig: '2', pubkey: PUBKEY }),
      fetchImpl,
    });
    expect(result).toBe('unreachable');
  });

  it('returns not_zap when the invoice is not NIP-57', async () => {
    await withNip57(false, async () => {
      const result = await probeNip57Mint({
        address: ADDRESS,
        recipientPubkey: PUBKEY,
        sign: async (unsigned: EventTemplate) => ({
          ...unsigned,
          id: '1',
          sig: '2',
          pubkey: PUBKEY,
        }),
        fetchImpl: zapCapableFetch(),
      });
      expect(result).toBe('not_zap');
    });
  });

  it('returns ok when the minted invoice is NIP-57', async () => {
    await withNip57(true, async () => {
      const result = await probeNip57Mint({
        address: ADDRESS,
        recipientPubkey: PUBKEY,
        sign: async (unsigned: EventTemplate) => ({
          ...unsigned,
          id: '1',
          sig: '2',
          pubkey: PUBKEY,
        }),
        fetchImpl: zapCapableFetch(),
        env: { NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' },
      });
      expect(result).toBe('ok');
    });
  });
});
