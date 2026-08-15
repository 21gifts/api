import { describe, it, expect } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import type { Account } from '@/lib/auth/store';
import { VERIFICATION_TTL_MS } from '@/lib/config';
import type { InvoicePayer, PayInvoiceResult } from '@/lib/invoice-payer';
import type { FetchFn } from '@/lib/lnurl-pay';
import { confirmVerification, startVerification } from '@/lib/verification';

const T0 = 1_000_000;
const ADDRESS = 'alice@walletofsatoshi.com';
const PR = 'lnbc10n1ptest';

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc',
    linkingKey: `02${'a'.repeat(64)}`,
    role: 'basis',
    lightningAddress: ADDRESS,
    lightningAddressVerified: false,
    createdAt: T0,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** LNURL-pay fetch that always returns a valid invoice for 1 sat. */
function happyFetch(): FetchFn {
  return async (input) => {
    if (String(input).includes('/.well-known/lnurlp/')) {
      return jsonResponse({
        callback: 'https://walletofsatoshi.com/lnurlp/callback',
        minSendable: 1000,
        commentAllowed: 255,
      });
    }
    return jsonResponse({ pr: PR });
  };
}

function okPayer(): InvoicePayer {
  return {
    payInvoice: async (): Promise<PayInvoiceResult> => ({ ok: true }),
  };
}

describe('startVerification', () => {
  it('returns no_address when the account has no lightning address', async () => {
    const result = await startVerification({
      store: new InMemoryAuthStore(),
      payer: okPayer(),
      fetchImpl: happyFetch(),
      now: T0,
      account: account({ lightningAddress: null }),
    });
    expect(result).toEqual({ ok: false, code: 'no_address' });
  });

  it('returns already_verified when the address is already proven', async () => {
    const result = await startVerification({
      store: new InMemoryAuthStore(),
      payer: okPayer(),
      fetchImpl: happyFetch(),
      now: T0,
      account: account({ lightningAddressVerified: true }),
    });
    expect(result).toEqual({ ok: false, code: 'already_verified' });
  });

  it('returns unreachable when LNURL-pay fails', async () => {
    const fetchImpl: FetchFn = async () => jsonResponse({}, 502);
    const result = await startVerification({
      store: new InMemoryAuthStore(),
      payer: okPayer(),
      fetchImpl,
      now: T0,
      account: account(),
    });
    expect(result).toEqual({ ok: false, code: 'unreachable' });
  });

  it('returns not_configured when the payer is unconfigured', async () => {
    const payer: InvoicePayer = {
      payInvoice: async () => ({ ok: false, reason: 'not_configured' }),
    };
    const result = await startVerification({
      store: new InMemoryAuthStore(),
      payer,
      fetchImpl: happyFetch(),
      now: T0,
      account: account(),
    });
    expect(result).toEqual({ ok: false, code: 'not_configured' });
  });

  it('returns unreachable when payment fails', async () => {
    const payer: InvoicePayer = {
      payInvoice: async () => ({ ok: false, reason: 'payment_failed' }),
    };
    const result = await startVerification({
      store: new InMemoryAuthStore(),
      payer,
      fetchImpl: happyFetch(),
      now: T0,
      account: account(),
    });
    expect(result).toEqual({ ok: false, code: 'unreachable' });
  });

  it('pays the invoice, stores a verification record, and returns sats + TTL', async () => {
    const store = new InMemoryAuthStore();
    const paid: string[] = [];
    const payer: InvoicePayer = {
      payInvoice: async (bolt11) => {
        paid.push(bolt11);
        return { ok: true };
      },
    };
    const comments: string[] = [];
    const fetchImpl: FetchFn = async (input) => {
      const url = String(input);
      if (url.includes('/.well-known/lnurlp/')) {
        return jsonResponse({
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
          minSendable: 1000,
          commentAllowed: 255,
        });
      }
      comments.push(url);
      return jsonResponse({ pr: PR });
    };

    // randomHex is real crypto; we only assert structure after success.
    const result = await startVerification({
      store,
      payer,
      fetchImpl,
      now: T0,
      account: account(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.expiresInSeconds).toBe(Math.floor(VERIFICATION_TTL_MS / 1000));
    expect(result.sats).toBe(1);
    expect(paid).toEqual([PR]);
    const callbackUrl = comments[0];
    expect(callbackUrl).toBeDefined();
    expect(new URL(callbackUrl ?? '').searchParams.get('comment')).toMatch(
      /^21gifts [0-9a-f]{32}$/,
    );

    const record = store.getVerification('acc');
    expect(record).toBeDefined();
    expect(record?.address).toBe(ADDRESS);
    expect(record?.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(record?.createdAt).toBe(T0);
  });
});

describe('confirmVerification', () => {
  it('returns bad_nonce for an empty / whitespace-only nonce', () => {
    const store = new InMemoryAuthStore();
    expect(confirmVerification(store, T0, account(), '   ')).toEqual({
      ok: false,
      code: 'bad_nonce',
    });
  });

  it('returns no_pending when there is no verification record', () => {
    const store = new InMemoryAuthStore();
    expect(confirmVerification(store, T0, account(), 'a'.repeat(32))).toEqual({
      ok: false,
      code: 'no_pending',
    });
  });

  it('returns no_pending when the linked address no longer matches the record', () => {
    const store = new InMemoryAuthStore();
    store.putVerification({
      accountId: 'acc',
      address: ADDRESS,
      nonce: 'a'.repeat(32),
      createdAt: T0,
    });
    const result = confirmVerification(
      store,
      T0,
      account({ lightningAddress: 'bob@getalby.com' }),
      'a'.repeat(32),
    );
    expect(result).toEqual({ ok: false, code: 'no_pending' });
  });

  it('returns expired and deletes the record when past the TTL', () => {
    const store = new InMemoryAuthStore();
    store.putVerification({
      accountId: 'acc',
      address: ADDRESS,
      nonce: 'a'.repeat(32),
      createdAt: T0,
    });
    const result = confirmVerification(
      store,
      T0 + VERIFICATION_TTL_MS + 1,
      account(),
      'a'.repeat(32),
    );
    expect(result).toEqual({ ok: false, code: 'expired' });
    expect(store.getVerification('acc')).toBeUndefined();
  });

  it('returns mismatch for a wrong nonce', () => {
    const store = new InMemoryAuthStore();
    store.putVerification({
      accountId: 'acc',
      address: ADDRESS,
      nonce: 'a'.repeat(32),
      createdAt: T0,
    });
    expect(confirmVerification(store, T0, account(), 'b'.repeat(32))).toEqual({
      ok: false,
      code: 'mismatch',
    });
  });

  it('returns mismatch when nonce lengths differ', () => {
    const store = new InMemoryAuthStore();
    store.putVerification({
      accountId: 'acc',
      address: ADDRESS,
      nonce: 'a'.repeat(32),
      createdAt: T0,
    });
    expect(confirmVerification(store, T0, account(), 'short')).toEqual({
      ok: false,
      code: 'mismatch',
    });
  });

  it('sets verified, deletes the record, and returns the updated account', () => {
    const store = new InMemoryAuthStore();
    const acc = account();
    store.createAccount(acc);
    store.putVerification({
      accountId: 'acc',
      address: ADDRESS,
      nonce: 'c'.repeat(32),
      createdAt: T0,
    });
    const result = confirmVerification(store, T0, acc, '  ' + 'c'.repeat(32) + '  ');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.account.lightningAddressVerified).toBe(true);
    expect(store.getAccount('acc')?.lightningAddressVerified).toBe(true);
    expect(store.getVerification('acc')).toBeUndefined();
  });
});
