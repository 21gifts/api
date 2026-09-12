import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GIFT_INVOICE_MAX_MSAT } from '@/lib/config';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { InMemoryInvoiceStore, type GiftInvoice } from '@/lib/invoice-store';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import { createApp } from '@/server';
import { decodeBolt11 } from '@/lib/bolt11';
import type { FetchFn } from '@/lib/lnurlp';

vi.mock('@/lib/bolt11', () => ({
  decodeBolt11: vi.fn(),
}));

const TOKEN = 'spend-secret-token';
const ADDRESS = 'alice@walletofsatoshi.com';
const PR = 'lnbc1issued';
const HASH = 'aa'.repeat(32);
const PREIMAGE = '11'.repeat(32);
const MATCHING_HASH = createHash('sha256').update(Buffer.from(PREIMAGE, 'hex')).digest('hex');
const MAX_SENDABLE = 100_000_000_000;

const mockedDecode = vi.mocked(decodeBolt11);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function happyFetch(): FetchFn {
  return async (input) => {
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
}

function auth(init?: RequestInit): RequestInit {
  return {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      ...init?.headers,
    },
  };
}

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

/**
 * Seed an account for `address` with a passkey credential so POST /invoices
 * can reach LNURL / 200.
 */
async function seedPasskeyAccount(
  authStore: InMemoryAuthStore,
  address: string = ADDRESS,
): Promise<void> {
  await authStore.createAccount({
    id: 'acc-alice',
    linkingKey: null,
    role: 'basis',
    name: 'Ada',
    lightningAddress: address,
    lightningAddressVerified: true,
    forumLawsDismissed: false,
    viewKey: 'a'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: null,
  });
  await authStore.createPasskeyCredential({
    credentialId: 'cred-alice',
    publicKey: new Uint8Array([1]),
    signCount: 0,
    accountId: 'acc-alice',
    createdAt: 1,
  });
}

/**
 * Seed one live non-profile forum row for `accountId` (EARLY-shaped).
 */
function livePostStore(accountId: string = 'acc-alice'): InMemoryMessageStore {
  return new InMemoryMessageStore([
    {
      id: 'post-alice',
      accountId,
      name: 'Ada',
      text: 'first',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    },
  ]);
}

describe('GET /invoices/passkey', () => {
  it('returns 503 when the spend token is not configured', async () => {
    const res = await createApp({ spendApiToken: '' }).request(
      `/invoices/passkey?address=${encodeURIComponent(ADDRESS)}`,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Spend invoices are not configured' });
  });

  it('returns 401 when the bearer is missing', async () => {
    const res = await createApp({ spendApiToken: TOKEN }).request(
      `/invoices/passkey?address=${encodeURIComponent(ADDRESS)}`,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 400 when address is missing', async () => {
    const res = await createApp({ spendApiToken: TOKEN }).request('/invoices/passkey', auth());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Not a valid Lightning Address (expected name@domain)',
    });
  });

  it('returns 400 on a bad Lightning Address', async () => {
    const res = await createApp({ spendApiToken: TOKEN }).request(
      '/invoices/passkey?address=nope',
      auth(),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Not a valid Lightning Address (expected name@domain)',
    });
  });

  it('returns hasPasskey false for an unknown address', async () => {
    const res = await createApp({ spendApiToken: TOKEN }).request(
      `/invoices/passkey?address=${encodeURIComponent(ADDRESS)}`,
      auth(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasPasskey: false });
  });

  it('returns hasPasskey false for an account without a credential', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount({
      id: 'acc-alice',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: ADDRESS,
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const res = await createApp({ spendApiToken: TOKEN, authStore }).request(
      `/invoices/passkey?address=${encodeURIComponent(ADDRESS)}`,
      auth(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasPasskey: false });
  });

  it('returns hasPasskey true when the account has a credential', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const res = await createApp({ spendApiToken: TOKEN, authStore }).request(
      `/invoices/passkey?address=${encodeURIComponent(ADDRESS)}`,
      auth(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasPasskey: true });
  });
});

describe('GET /invoices/posted', () => {
  it('returns 503 when the spend token is not configured', async () => {
    const res = await createApp({ spendApiToken: '' }).request(
      `/invoices/posted?address=${encodeURIComponent(ADDRESS)}`,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Spend invoices are not configured' });
  });

  it('returns 401 when the bearer is missing', async () => {
    const res = await createApp({ spendApiToken: TOKEN }).request(
      `/invoices/posted?address=${encodeURIComponent(ADDRESS)}`,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 400 when address is missing', async () => {
    const res = await createApp({ spendApiToken: TOKEN }).request('/invoices/posted', auth());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Not a valid Lightning Address (expected name@domain)',
    });
  });

  it('returns 400 on a bad Lightning Address', async () => {
    const res = await createApp({ spendApiToken: TOKEN }).request(
      '/invoices/posted?address=nope',
      auth(),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Not a valid Lightning Address (expected name@domain)',
    });
  });

  it('returns hasPosted false for an unknown address', async () => {
    const res = await createApp({ spendApiToken: TOKEN }).request(
      `/invoices/posted?address=${encodeURIComponent(ADDRESS)}`,
      auth(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasPosted: false });
  });

  it('returns hasPosted false for an account without messages', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount({
      id: 'acc-alice',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: ADDRESS,
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const res = await createApp({ spendApiToken: TOKEN, authStore }).request(
      `/invoices/posted?address=${encodeURIComponent(ADDRESS)}`,
      auth(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasPosted: false });
  });

  it('returns hasPosted true when the account has a live non-profile message', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount({
      id: 'acc-alice',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: ADDRESS,
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const res = await createApp({
      spendApiToken: TOKEN,
      authStore,
      messageStore: livePostStore(),
    }).request(`/invoices/posted?address=${encodeURIComponent(ADDRESS)}`, auth());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasPosted: true });
  });

  it('returns hasPosted false when the account has only a profile note', async () => {
    const authStore = new InMemoryAuthStore();
    const profileId = 'prof-alice';
    await authStore.createAccount({
      id: 'acc-alice',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: ADDRESS,
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
      profileMessageId: profileId,
    });
    const messageStore = new InMemoryMessageStore([
      {
        id: profileId,
        accountId: 'acc-alice',
        name: 'Ada',
        text: 'Ada',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
    ]);
    const res = await createApp({ spendApiToken: TOKEN, authStore, messageStore }).request(
      `/invoices/posted?address=${encodeURIComponent(ADDRESS)}`,
      auth(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasPosted: false });
  });
});

describe('POST /invoices', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockedDecode.mockReset();
    mockedDecode.mockReturnValue({ paymentHash: HASH, amountMsat: 1000 });
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns 503 when the spend token is not configured', async () => {
    const res = await createApp({ spendApiToken: '' }).request('/invoices', {
      method: 'POST',
      body: JSON.stringify({ address: ADDRESS, amountMsat: 1000 }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Spend invoices are not configured' });
  });

  it('returns 401 when the bearer is missing', async () => {
    const res = await createApp({ spendApiToken: TOKEN }).request('/invoices', {
      method: 'POST',
      body: JSON.stringify({ address: ADDRESS, amountMsat: 1000 }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 on invalid JSON', async () => {
    const res = await createApp({ spendApiToken: TOKEN }).request(
      '/invoices',
      auth({ method: 'POST', body: 'not-json' }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 on a bad body', async () => {
    const res = await createApp({ spendApiToken: TOKEN }).request(
      '/invoices',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS }) }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 on a bad Lightning Address', async () => {
    const res = await createApp({ spendApiToken: TOKEN }).request(
      '/invoices',
      auth({ method: 'POST', body: JSON.stringify({ address: 'nope', amountMsat: 1000 }) }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Not a valid Lightning Address (expected name@domain)',
    });
  });

  it('returns 400 when amountMsat is below the api minimum', async () => {
    const res = await createApp({ spendApiToken: TOKEN }).request(
      '/invoices',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS, amountMsat: 1 }) }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when amountMsat is above the api maximum', async () => {
    const res = await createApp({ spendApiToken: TOKEN }).request(
      '/invoices',
      auth({
        method: 'POST',
        body: JSON.stringify({ address: ADDRESS, amountMsat: GIFT_INVOICE_MAX_MSAT + 1 }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 403 when there is no account for the address', async () => {
    const res = await createApp({ spendApiToken: TOKEN, fetchImpl: happyFetch() }).request(
      '/invoices',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS, amountMsat: 1000 }) }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Passkey required' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.passkey_required')).toBe(true);
  });

  it('returns 403 when the account has no passkey credential', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount({
      id: 'acc-alice',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: ADDRESS,
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const res = await createApp({
      spendApiToken: TOKEN,
      authStore,
      fetchImpl: happyFetch(),
    }).request(
      '/invoices',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS, amountMsat: 1000 }) }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Passkey required' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.passkey_required')).toBe(true);
  });

  it('returns 403 when the account has a passkey but no live forum post', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const fetchImpl: FetchFn = async () => {
      throw new Error('LNURL must not be called');
    };
    const res = await createApp({ spendApiToken: TOKEN, authStore, fetchImpl }).request(
      '/invoices',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS, amountMsat: 1000 }) }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forum post required' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.forum_post_required')).toBe(true);
  });

  it('returns 502 when LNURL-pay cannot issue an invoice', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const fetchImpl: FetchFn = async () => jsonResponse({}, 500);
    const res = await createApp({
      spendApiToken: TOKEN,
      authStore,
      messageStore: livePostStore(),
      fetchImpl,
    }).request(
      '/invoices',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS, amountMsat: 1000 }) }),
    );
    expect(res.status).toBe(502);
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.issue_failed')).toBe(true);
  });

  it('returns 502 when bolt11 decode fails', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    mockedDecode.mockReturnValue(null);
    const res = await createApp({
      spendApiToken: TOKEN,
      authStore,
      messageStore: livePostStore(),
      fetchImpl: happyFetch(),
    }).request(
      '/invoices',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS, amountMsat: 1000 }) }),
    );
    expect(res.status).toBe(502);
  });

  it('returns 502 when the invoice amount does not match', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    mockedDecode.mockReturnValue({ paymentHash: HASH, amountMsat: 999 });
    const res = await createApp({
      spendApiToken: TOKEN,
      authStore,
      messageStore: livePostStore(),
      fetchImpl: happyFetch(),
    }).request(
      '/invoices',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS, amountMsat: 1000 }) }),
    );
    expect(res.status).toBe(502);
  });

  it('returns 200 with id, pr, paymentHash, amountMsat', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const res = await createApp({
      spendApiToken: TOKEN,
      authStore,
      messageStore: livePostStore(),
      fetchImpl: happyFetch(),
    }).request(
      '/invoices',
      auth({
        method: 'POST',
        body: JSON.stringify({ address: ADDRESS, amountMsat: 1000, comment: '21gifts daily' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      pr: string;
      paymentHash: string;
      amountMsat: number;
    };
    expect(body.pr).toBe(PR);
    expect(body.paymentHash).toBe(HASH);
    expect(body.amountMsat).toBe(1000);
    expect(body.id).toMatch(/^[0-9a-f]{32}$/);
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.issued')).toBe(true);
  });
});

describe('POST /invoices/proof', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let store: InMemoryInvoiceStore;

  function unpaid(overrides?: Partial<GiftInvoice>): GiftInvoice {
    return {
      id: 'ab'.repeat(16),
      address: ADDRESS,
      pr: PR,
      paymentHash: MATCHING_HASH,
      amountMsat: 1000,
      createdAt: 1,
      expiresAt: 1_000_000,
      ...overrides,
    };
  }

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    store = new InMemoryInvoiceStore();
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns 503 when unconfigured', async () => {
    const res = await createApp({ spendApiToken: '' }).request('/invoices/proof', {
      method: 'POST',
      body: JSON.stringify({ id: 'x', preimage: PREIMAGE }),
    });
    expect(res.status).toBe(503);
  });

  it('returns 401 when unauthorized', async () => {
    const res = await createApp({ spendApiToken: TOKEN }).request('/invoices/proof', {
      method: 'POST',
      body: JSON.stringify({ id: 'x', preimage: PREIMAGE }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 on invalid JSON', async () => {
    const res = await createApp({ spendApiToken: TOKEN, invoiceStore: store }).request(
      '/invoices/proof',
      auth({ method: 'POST', body: 'nope' }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 on a bad body', async () => {
    const res = await createApp({ spendApiToken: TOKEN, invoiceStore: store }).request(
      '/invoices/proof',
      auth({ method: 'POST', body: JSON.stringify({ preimage: PREIMAGE }) }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await createApp({ spendApiToken: TOKEN, invoiceStore: store }).request(
      '/invoices/proof',
      auth({ method: 'POST', body: JSON.stringify({ id: 'missing', preimage: PREIMAGE }) }),
    );
    expect(res.status).toBe(404);
  });

  it('accepts a matching preimage after store TTL', async () => {
    store.put(unpaid({ expiresAt: 10 }));
    const res = await createApp({
      spendApiToken: TOKEN,
      invoiceStore: store,
      now: () => 11,
    }).request(
      '/invoices/proof',
      auth({ method: 'POST', body: JSON.stringify({ id: unpaid().id, preimage: PREIMAGE }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'paid',
      id: unpaid().id,
      paymentHash: MATCHING_HASH,
    });
  });

  it('returns 409 when expired unpaid and the preimage does not match', async () => {
    store.put(unpaid({ expiresAt: 10 }));
    const res = await createApp({
      spendApiToken: TOKEN,
      invoiceStore: store,
      now: () => 11,
    }).request(
      '/invoices/proof',
      auth({
        method: 'POST',
        body: JSON.stringify({ id: unpaid().id, preimage: '22'.repeat(32) }),
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Invoice expired' });
  });

  it('returns 400 when the preimage does not match', async () => {
    store.put(unpaid());
    const res = await createApp({
      spendApiToken: TOKEN,
      invoiceStore: store,
      now: () => 100,
    }).request(
      '/invoices/proof',
      auth({
        method: 'POST',
        body: JSON.stringify({ id: unpaid().id, preimage: '22'.repeat(32) }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Proof does not match invoice' });
  });

  it('returns 200 and stores the preimage on a matching proof', async () => {
    store.put(unpaid());
    const recorded: unknown[] = [];
    const res = await createApp({
      spendApiToken: TOKEN,
      invoiceStore: store,
      now: () => 100,
      giftRecorder: {
        recordOutbound: async (row) => {
          recorded.push(row);
        },
      },
    }).request(
      '/invoices/proof',
      auth({ method: 'POST', body: JSON.stringify({ id: unpaid().id, preimage: PREIMAGE }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'paid',
      id: unpaid().id,
      paymentHash: MATCHING_HASH,
    });
    expect(store.get(unpaid().id)?.paidAt).toBe(100);
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.paid')).toBe(true);
    expect(recorded).toEqual([
      {
        paidAt: new Date(100),
        amountSats: 1,
        feeSats: 0,
        recipientWosUser: 'alice',
        lightningInvoice: PR,
        description: '21gifts daily',
        sourceWallet: 'lightning.space',
      },
    ]);
  });

  it('returns 200 when gift recording fails', async () => {
    store.put(unpaid());
    const res = await createApp({
      spendApiToken: TOKEN,
      invoiceStore: store,
      now: () => 100,
      giftRecorder: {
        recordOutbound: async () => {
          throw new Error('db');
        },
      },
    }).request(
      '/invoices/proof',
      auth({ method: 'POST', body: JSON.stringify({ id: unpaid().id, preimage: PREIMAGE }) }),
    );
    expect(res.status).toBe(200);
    expect(parsedEvents(warn).some((e) => e['event'] === 'gifts.record_failed')).toBe(true);
  });

  it('returns 200 idempotently for the same preimage', async () => {
    store.put(unpaid({ paidAt: 5, preimage: PREIMAGE }));
    const recorded: unknown[] = [];
    const res = await createApp({
      spendApiToken: TOKEN,
      invoiceStore: store,
      now: () => 100,
      giftRecorder: {
        recordOutbound: async (row) => {
          recorded.push(row);
        },
      },
    }).request(
      '/invoices/proof',
      auth({ method: 'POST', body: JSON.stringify({ id: unpaid().id, preimage: PREIMAGE }) }),
    );
    expect(res.status).toBe(200);
    expect(recorded).toEqual([
      {
        paidAt: new Date(5),
        amountSats: 1,
        feeSats: 0,
        recipientWosUser: 'alice',
        lightningInvoice: PR,
        description: '21gifts daily',
        sourceWallet: 'lightning.space',
      },
    ]);
  });

  it('returns 409 when already paid with a different preimage', async () => {
    store.put(unpaid({ paidAt: 5, preimage: '22'.repeat(32) }));
    const res = await createApp({
      spendApiToken: TOKEN,
      invoiceStore: store,
      now: () => 100,
    }).request(
      '/invoices/proof',
      auth({ method: 'POST', body: JSON.stringify({ id: unpaid().id, preimage: PREIMAGE }) }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Invoice already paid' });
  });
});
