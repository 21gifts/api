import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import type { InvoicePayer, PayInvoiceResult } from '@/lib/invoice-payer';
import { UnconfiguredInvoicePayer } from '@/lib/invoice-payer';
import { VERIFICATION_TTL_MS } from '@/lib/config';
import type { FetchFn } from '@/lib/lnurl-pay';
import { bearerToken, meRoutes } from '@/routes/me';

const now = (): number => 1_000_000;
const AUTH = { authorization: 'Bearer tok' };
const LINKING_KEY = `02${'a'.repeat(64)}`;
const ADDRESS = 'alice@walletofsatoshi.com';
const PR = 'lnbc10n1testinvoice';

interface MountOpts {
  payer?: InvoicePayer;
  fetchImpl?: FetchFn;
  clock?: () => number;
}

function mount(store: InMemoryAuthStore, opts: MountOpts = {}): Hono {
  return new Hono().route(
    '/me',
    meRoutes({
      store,
      now: opts.clock ?? now,
      payer: opts.payer ?? new UnconfiguredInvoicePayer(),
      fetchImpl: opts.fetchImpl ?? globalThis.fetch,
    }),
  );
}

/** A store with a signed-in account `acc` reachable via session `tok`. */
function seededStore(
  overrides: { lightningAddress?: string | null; verified?: boolean } = {},
): InMemoryAuthStore {
  const store = new InMemoryAuthStore();
  store.createAccount({
    id: 'acc',
    linkingKey: LINKING_KEY,
    role: 'basis',
    lightningAddress: overrides.lightningAddress ?? null,
    lightningAddressVerified: overrides.verified ?? false,
    createdAt: 1_000_000,
  });
  store.createSession({ token: 'tok', accountId: 'acc', createdAt: 1_000_000 });
  return store;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Fake LNURL-pay that always yields a 1-sat invoice. */
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

function okPayer(paid: string[] = []): InvoicePayer {
  return {
    payInvoice: async (bolt11): Promise<PayInvoiceResult> => {
      paid.push(bolt11);
      return { ok: true };
    },
  };
}

describe('GET /me', () => {
  it('returns 401 without an Authorization header', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me');
    expect(res.status).toBe(401);
  });

  it('returns 401 for a non-Bearer scheme', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me', {
      headers: { authorization: 'Basic abc' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for an empty bearer token', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me', {
      headers: { authorization: 'Bearer    ' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for an unknown token', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me', {
      headers: { authorization: 'Bearer nope' },
    });
    expect(res.status).toBe(401);
  });

  it('returns the account for a valid session', async () => {
    const store = seededStore();
    const res = await mount(store).request('/me', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      role: string;
      lightningAddress: string | null;
      lightningAddressVerified: boolean;
    };
    expect(body.id).toBe('acc');
    expect(body.role).toBe('basis');
    expect(body.lightningAddress).toBeNull();
    expect(body.lightningAddressVerified).toBe(false);
  });
});

describe('POST /me/lightning-address', () => {
  it('returns 401 without a valid session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me/lightning-address', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: ADDRESS }),
    });
    expect(res.status).toBe(401);
  });

  it('links a valid Lightning Address', async () => {
    const store = seededStore();
    const res = await mount(store).request('/me/lightning-address', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ address: ADDRESS }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lightningAddress: string;
      lightningAddressVerified: boolean;
    };
    expect(body.lightningAddress).toBe(ADDRESS);
    expect(body.lightningAddressVerified).toBe(false);
    expect(store.getAccount('acc')?.lightningAddress).toBe(ADDRESS);
  });

  it('clears a pending verification when linking', async () => {
    const store = seededStore({ lightningAddress: ADDRESS });
    store.putVerification({
      accountId: 'acc',
      address: ADDRESS,
      nonce: 'a'.repeat(32),
      createdAt: 1_000_000,
    });
    const res = await mount(store).request('/me/lightning-address', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'bob@getalby.com' }),
    });
    expect(res.status).toBe(200);
    expect(store.getVerification('acc')).toBeUndefined();
  });

  it('rejects a malformed JSON body', async () => {
    const res = await mount(seededStore()).request('/me/lightning-address', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid Lightning Address', async () => {
    const res = await mount(seededStore()).request('/me/lightning-address', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'not-an-address' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /me/lightning-address', () => {
  it('returns 401 without a valid session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me/lightning-address', {
      method: 'DELETE',
    });
    expect(res.status).toBe(401);
  });

  it('unlinks the address and clears pending verification', async () => {
    const store = seededStore({ lightningAddress: ADDRESS });
    store.putVerification({
      accountId: 'acc',
      address: ADDRESS,
      nonce: 'a'.repeat(32),
      createdAt: 1_000_000,
    });
    const res = await mount(store).request('/me/lightning-address', {
      method: 'DELETE',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lightningAddress: string | null };
    expect(body.lightningAddress).toBeNull();
    expect(store.getAccount('acc')?.lightningAddress).toBeNull();
    expect(store.getVerification('acc')).toBeUndefined();
  });
});

describe('POST /me/lightning-address/verification', () => {
  it('returns 401 without a valid session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me/lightning-address/verification', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 409 when no address is linked', async () => {
    const res = await mount(seededStore(), {
      payer: okPayer(),
      fetchImpl: happyFetch(),
    }).request('/me/lightning-address/verification', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'No Lightning Address linked' });
  });

  it('returns 409 when already verified', async () => {
    const res = await mount(seededStore({ lightningAddress: ADDRESS, verified: true }), {
      payer: okPayer(),
      fetchImpl: happyFetch(),
    }).request('/me/lightning-address/verification', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Lightning Address already verified' });
  });

  it('returns 503 when the payer is not configured', async () => {
    const res = await mount(seededStore({ lightningAddress: ADDRESS }), {
      payer: new UnconfiguredInvoicePayer(),
      fetchImpl: happyFetch(),
    }).request('/me/lightning-address/verification', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'Verification payments are not configured',
    });
  });

  it('returns 502 when the address is unreachable', async () => {
    const fetchImpl: FetchFn = async () => jsonResponse({}, 502);
    const res = await mount(seededStore({ lightningAddress: ADDRESS }), {
      payer: okPayer(),
      fetchImpl,
    }).request('/me/lightning-address/verification', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'Lightning Address did not accept the verification payment',
    });
  });

  it('returns 200 sent with expiresInSeconds and sats (no nonce)', async () => {
    const paid: string[] = [];
    const callbackUrls: string[] = [];
    const fetchImpl: FetchFn = async (input) => {
      const url = String(input);
      if (url.includes('/.well-known/lnurlp/')) {
        return jsonResponse({
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
          minSendable: 1000,
          commentAllowed: 255,
        });
      }
      callbackUrls.push(url);
      return jsonResponse({ pr: PR });
    };
    const store = seededStore({ lightningAddress: ADDRESS });
    const res = await mount(store, { payer: okPayer(paid), fetchImpl }).request(
      '/me/lightning-address/verification',
      { method: 'POST', headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      status: 'sent',
      expiresInSeconds: Math.floor(VERIFICATION_TTL_MS / 1000),
      sats: 1,
    });
    expect(body).not.toHaveProperty('nonce');
    expect(paid).toEqual([PR]);
    const callbackUrl = callbackUrls[0];
    expect(callbackUrl).toBeDefined();
    expect(new URL(callbackUrl ?? '').searchParams.get('comment')).toMatch(
      /^21gifts [0-9a-f]{32}$/,
    );
    expect(store.getVerification('acc')).toBeDefined();
  });
});

describe('POST /me/lightning-address/verification/confirm', () => {
  it('returns 401 without a valid session', async () => {
    const res = await mount(new InMemoryAuthStore()).request(
      '/me/lightning-address/verification/confirm',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce: 'a'.repeat(32) }),
      },
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 for a missing nonce string', async () => {
    const res = await mount(seededStore({ lightningAddress: ADDRESS })).request(
      '/me/lightning-address/verification/confirm',
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with a "nonce" string',
    });
  });

  it('returns 400 for an incorrect nonce', async () => {
    const store = seededStore({ lightningAddress: ADDRESS });
    store.putVerification({
      accountId: 'acc',
      address: ADDRESS,
      nonce: 'a'.repeat(32),
      createdAt: 1_000_000,
    });
    const res = await mount(store).request('/me/lightning-address/verification/confirm', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: 'b'.repeat(32) }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Incorrect verification code' });
  });

  it('returns 400 for an empty nonce after trim', async () => {
    const store = seededStore({ lightningAddress: ADDRESS });
    store.putVerification({
      accountId: 'acc',
      address: ADDRESS,
      nonce: 'a'.repeat(32),
      createdAt: 1_000_000,
    });
    const res = await mount(store).request('/me/lightning-address/verification/confirm', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: '   ' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Incorrect verification code' });
  });

  it('returns 409 when no verification is in progress', async () => {
    const res = await mount(seededStore({ lightningAddress: ADDRESS })).request(
      '/me/lightning-address/verification/confirm',
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ nonce: 'a'.repeat(32) }),
      },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'No verification in progress' });
  });

  it('returns 409 when the verification has expired', async () => {
    const store = seededStore({ lightningAddress: ADDRESS });
    store.putVerification({
      accountId: 'acc',
      address: ADDRESS,
      nonce: 'a'.repeat(32),
      createdAt: 1_000_000,
    });
    const res = await mount(store, {
      clock: () => 1_000_000 + VERIFICATION_TTL_MS + 1,
    }).request('/me/lightning-address/verification/confirm', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: 'a'.repeat(32) }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Verification expired' });
  });

  it('returns 200 and flips lightningAddressVerified on success', async () => {
    const store = seededStore({ lightningAddress: ADDRESS });
    store.putVerification({
      accountId: 'acc',
      address: ADDRESS,
      nonce: 'c'.repeat(32),
      createdAt: 1_000_000,
    });
    const res = await mount(store).request('/me/lightning-address/verification/confirm', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: 'c'.repeat(32) }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lightningAddress: string;
      lightningAddressVerified: boolean;
    };
    expect(body.lightningAddress).toBe(ADDRESS);
    expect(body.lightningAddressVerified).toBe(true);
    expect(store.getAccount('acc')?.lightningAddressVerified).toBe(true);
    expect(store.getVerification('acc')).toBeUndefined();
  });

  it('returns 409 after link clears a pending verification', async () => {
    const store = seededStore({ lightningAddress: ADDRESS });
    store.putVerification({
      accountId: 'acc',
      address: ADDRESS,
      nonce: 'a'.repeat(32),
      createdAt: 1_000_000,
    });
    await mount(store).request('/me/lightning-address', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ address: ADDRESS }),
    });
    const res = await mount(store).request('/me/lightning-address/verification/confirm', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: 'a'.repeat(32) }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'No verification in progress' });
  });

  it('returns 409 after unlink clears a pending verification', async () => {
    const store = seededStore({ lightningAddress: ADDRESS });
    store.putVerification({
      accountId: 'acc',
      address: ADDRESS,
      nonce: 'a'.repeat(32),
      createdAt: 1_000_000,
    });
    await mount(store).request('/me/lightning-address', {
      method: 'DELETE',
      headers: AUTH,
    });
    // Re-link so the account has an address again, but no pending record.
    store.updateAccount({
      id: 'acc',
      linkingKey: LINKING_KEY,
      role: 'basis',
      lightningAddress: ADDRESS,
      lightningAddressVerified: false,
      createdAt: 1_000_000,
    });
    const res = await mount(store).request('/me/lightning-address/verification/confirm', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: 'a'.repeat(32) }),
    });
    expect(res.status).toBe(409);
  });
});

describe('bearerToken', () => {
  it('returns null for a missing header', () => {
    expect(bearerToken(undefined)).toBeNull();
  });

  it('returns null for a non-Bearer scheme', () => {
    expect(bearerToken('Basic abc')).toBeNull();
  });

  it('returns null for an empty token', () => {
    expect(bearerToken('Bearer ')).toBeNull();
  });

  it('returns null for a whitespace-only token', () => {
    expect(bearerToken('Bearer    ')).toBeNull();
  });

  it('extracts a present token', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123');
  });
});
