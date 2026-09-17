import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GIFT_INVOICE_MAX_MSAT } from '@/lib/config';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { InMemoryInvoiceStore, type GiftInvoice } from '@/lib/invoice-store';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import { InMemoryNotificationStore } from '@/lib/notification-store';
import { InMemoryPushStore } from '@/lib/push-store';
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
const POST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEWER_POST_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_POST_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REPLY_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PROFILE_NOTE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const UNKNOWN_POST_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

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
    location: null,
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
 * Seed one live non-profile top-level forum row for `accountId` (EARLY-shaped).
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

/**
 * Seed one live reply (no top-level row) for `accountId`.
 */
function liveReplyStore(accountId: string = 'acc-alice'): InMemoryMessageStore {
  return new InMemoryMessageStore([
    {
      id: 'reply-alice',
      accountId,
      name: 'Ada',
      text: 'reply',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: 'parent-alice',
    },
  ]);
}

async function seedPasskeyAndPlatform(authStore: InMemoryAuthStore): Promise<void> {
  await seedPasskeyAccount(authStore);
  await authStore.createAccount({
    id: 'plat',
    linkingKey: null,
    role: 'founder',
    name: '21.gifts',
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    location: null,
    viewKey: 'b'.repeat(64),
    createdAt: 2,
    rulesAgreedAt: null,
    isPlatform: true,
  });
}

function uuidPostStore(): InMemoryMessageStore {
  return new InMemoryMessageStore([
    {
      id: POST_ID,
      accountId: 'acc-alice',
      name: 'Ada',
      text: 'first',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    },
  ]);
}

function uuidReplyStore(): InMemoryMessageStore {
  return new InMemoryMessageStore([
    {
      id: POST_ID,
      accountId: 'acc-alice',
      name: 'Ada',
      text: 'first',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    },
    {
      id: REPLY_ID,
      accountId: 'acc-alice',
      name: 'Ada',
      text: 'reply',
      createdAt: new Date('2026-08-01T00:00:01.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: POST_ID,
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
      location: null,
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
    expect(await res.json()).toEqual({ hasPosted: false, messageId: null, postedAt: null });
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
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const res = await createApp({ spendApiToken: TOKEN, authStore }).request(
      `/invoices/posted?address=${encodeURIComponent(ADDRESS)}`,
      auth(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasPosted: false, messageId: null, postedAt: null });
  });

  it('returns hasPosted true when the account has a live top-level non-profile message', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount({
      id: 'acc-alice',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: ADDRESS,
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
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
    expect(await res.json()).toEqual({
      hasPosted: true,
      messageId: 'post-alice',
      postedAt: '2026-08-01T00:00:00.000Z',
    });
  });

  it('returns hasPosted true with messageId null when the list has no non-profile row', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount({
      id: 'acc-alice',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: ADDRESS,
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const inner = livePostStore();
    const messageStore = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'listPostsByAccount') {
          return async () => [];
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...args: never[]) => unknown).bind(target)
          : value;
      },
    });
    const res = await createApp({ spendApiToken: TOKEN, authStore, messageStore }).request(
      `/invoices/posted?address=${encodeURIComponent(ADDRESS)}`,
      auth(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasPosted: true, messageId: null, postedAt: null });
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
      location: null,
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
    expect(await res.json()).toEqual({ hasPosted: false, messageId: null, postedAt: null });
  });

  it('returns hasPosted false when the account has only a live reply', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount({
      id: 'acc-alice',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: ADDRESS,
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const res = await createApp({
      spendApiToken: TOKEN,
      authStore,
      messageStore: liveReplyStore(),
    }).request(`/invoices/posted?address=${encodeURIComponent(ADDRESS)}`, auth());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasPosted: false, messageId: null, postedAt: null });
  });

  it('returns the live top-level post id as messageId', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount({
      id: 'acc-alice',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: ADDRESS,
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const res = await createApp({
      spendApiToken: TOKEN,
      authStore,
      messageStore: uuidPostStore(),
    }).request(`/invoices/posted?address=${encodeURIComponent(ADDRESS)}`, auth());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      hasPosted: true,
      messageId: POST_ID,
      postedAt: '2026-08-01T00:00:00.000Z',
    });
  });

  it('returns the newest live top-level post id as messageId', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount({
      id: 'acc-alice',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: ADDRESS,
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const messageStore = new InMemoryMessageStore([
      {
        id: POST_ID,
        accountId: 'acc-alice',
        name: 'Ada',
        text: 'first',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      {
        id: NEWER_POST_ID,
        accountId: 'acc-alice',
        name: 'Ada',
        text: 'second',
        createdAt: new Date('2026-08-02T00:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
    ]);
    const res = await createApp({
      spendApiToken: TOKEN,
      authStore,
      messageStore,
    }).request(`/invoices/posted?address=${encodeURIComponent(ADDRESS)}`, auth());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      hasPosted: true,
      messageId: NEWER_POST_ID,
      postedAt: '2026-08-02T00:00:00.000Z',
    });
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
      location: null,
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

  it('returns 403 when the account has a passkey but only a live reply', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const fetchImpl: FetchFn = async () => {
      throw new Error('LNURL must not be called');
    };
    const res = await createApp({
      spendApiToken: TOKEN,
      authStore,
      messageStore: liveReplyStore(),
      fetchImpl,
    }).request(
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

  it('stores messageId and comment when issuing against a UUID post', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const invoiceStore = new InMemoryInvoiceStore();
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const res = await createApp({
      spendApiToken: TOKEN,
      authStore,
      messageStore: uuidPostStore(),
      invoiceStore,
      fetchImpl,
    }).request(
      '/invoices',
      auth({
        method: 'POST',
        body: JSON.stringify({
          address: ADDRESS,
          amountMsat: 1000,
          messageId: POST_ID,
          comment: 'gm',
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(invoiceStore.get(body.id)?.messageId).toBe(POST_ID);
    expect(invoiceStore.get(body.id)?.comment).toBe('gm');
  });

  it('stores an empty comment when messageId is set and comment is omitted', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const invoiceStore = new InMemoryInvoiceStore();
    const res = await createApp({
      spendApiToken: TOKEN,
      authStore,
      messageStore: uuidPostStore(),
      invoiceStore,
      fetchImpl: happyFetch(),
    }).request(
      '/invoices',
      auth({
        method: 'POST',
        body: JSON.stringify({ address: ADDRESS, amountMsat: 1000, messageId: POST_ID }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(invoiceStore.get(body.id)?.messageId).toBe(POST_ID);
    expect(invoiceStore.get(body.id)?.comment).toBe('');
  });

  it('returns 400 when messageId is not a UUID', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const res = await createApp({
      spendApiToken: TOKEN,
      authStore,
      messageStore: uuidPostStore(),
      fetchImpl,
    }).request(
      '/invoices',
      auth({
        method: 'POST',
        body: JSON.stringify({
          address: ADDRESS,
          amountMsat: 1000,
          messageId: 'nope',
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with address and amountMsat',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns 403 when messageId is an unknown UUID', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const res = await createApp({
      spendApiToken: TOKEN,
      authStore,
      messageStore: uuidPostStore(),
      fetchImpl,
    }).request(
      '/invoices',
      auth({
        method: 'POST',
        body: JSON.stringify({
          address: ADDRESS,
          amountMsat: 1000,
          messageId: UNKNOWN_POST_ID,
        }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forum post required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns 403 when messageId is a reply', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const messageStore = new InMemoryMessageStore([
      {
        id: POST_ID,
        accountId: 'acc-alice',
        name: 'Ada',
        text: 'first',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      {
        id: REPLY_ID,
        accountId: 'acc-alice',
        name: 'Ada',
        text: 'reply',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        parentId: POST_ID,
      },
    ]);
    const res = await createApp({
      spendApiToken: TOKEN,
      authStore,
      messageStore,
      fetchImpl,
    }).request(
      '/invoices',
      auth({
        method: 'POST',
        body: JSON.stringify({
          address: ADDRESS,
          amountMsat: 1000,
          messageId: REPLY_ID,
        }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forum post required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns 403 when messageId is the account profile note', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount({
      id: 'acc-alice',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: ADDRESS,
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
      profileMessageId: PROFILE_NOTE_ID,
    });
    await authStore.createPasskeyCredential({
      credentialId: 'cred-alice',
      publicKey: new Uint8Array([1]),
      signCount: 0,
      accountId: 'acc-alice',
      createdAt: 1,
    });
    await authStore.createAccount({
      id: 'plat',
      linkingKey: null,
      role: 'founder',
      name: '21.gifts',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
      isPlatform: true,
    });
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const messageStore = new InMemoryMessageStore([
      {
        id: POST_ID,
        accountId: 'acc-alice',
        name: 'Ada',
        text: 'first',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      {
        id: PROFILE_NOTE_ID,
        accountId: 'acc-alice',
        name: 'Ada',
        text: 'Ada',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
    ]);
    const res = await createApp({
      spendApiToken: TOKEN,
      authStore,
      messageStore,
      fetchImpl,
    }).request(
      '/invoices',
      auth({
        method: 'POST',
        body: JSON.stringify({
          address: ADDRESS,
          amountMsat: 1000,
          messageId: PROFILE_NOTE_ID,
        }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forum post required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns 403 when messageId is another account's post", async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    await authStore.createAccount({
      id: 'acc-bob',
      linkingKey: null,
      role: 'basis',
      name: 'Bob',
      lightningAddress: 'bob@walletofsatoshi.com',
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'c'.repeat(64),
      createdAt: 3,
      rulesAgreedAt: null,
    });
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const messageStore = new InMemoryMessageStore([
      {
        id: POST_ID,
        accountId: 'acc-alice',
        name: 'Ada',
        text: 'first',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      {
        id: OTHER_POST_ID,
        accountId: 'acc-bob',
        name: 'Bob',
        text: 'bob',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
    ]);
    const res = await createApp({
      spendApiToken: TOKEN,
      authStore,
      messageStore,
      fetchImpl,
    }).request(
      '/invoices',
      auth({
        method: 'POST',
        body: JSON.stringify({
          address: ADDRESS,
          amountMsat: 1000,
          messageId: OTHER_POST_ID,
        }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forum post required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns 503 when messageId is set and the platform account is missing', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const invoiceStore = new InMemoryInvoiceStore();
    const putSpy = vi.spyOn(invoiceStore, 'put');
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const res = await createApp({
      spendApiToken: TOKEN,
      authStore,
      messageStore: uuidPostStore(),
      invoiceStore,
      fetchImpl,
    }).request(
      '/invoices',
      auth({
        method: 'POST',
        body: JSON.stringify({
          address: ADDRESS,
          amountMsat: 1000,
          messageId: POST_ID,
        }),
      }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Platform account is not configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('returns 200 when messageId is omitted even without a platform account', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const res = await createApp({
      spendApiToken: TOKEN,
      authStore,
      messageStore: livePostStore(),
      fetchImpl,
    }).request(
      '/invoices',
      auth({
        method: 'POST',
        body: JSON.stringify({ address: ADDRESS, amountMsat: 1000 }),
      }),
    );
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('returns 403 when getAccount misses the post author', async () => {
    const inner = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(inner);
    const authStore = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'getAccount') {
          return async (id: string) => {
            if (id === 'acc-alice') {
              return undefined;
            }
            return target.getAccount(id);
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...args: never[]) => unknown).bind(target)
          : value;
      },
    });
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const res = await createApp({
      spendApiToken: TOKEN,
      authStore,
      messageStore: uuidPostStore(),
      fetchImpl,
    }).request(
      '/invoices',
      auth({
        method: 'POST',
        body: JSON.stringify({
          address: ADDRESS,
          amountMsat: 1000,
          messageId: POST_ID,
        }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forum post required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns 403 when the post author's Lightning Address is unset", async () => {
    const inner = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(inner);
    const authStore = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'getAccount') {
          return async (id: string) => {
            const account = await target.getAccount(id);
            if (account === undefined || id !== 'acc-alice') {
              return account;
            }
            return { ...account, lightningAddress: null };
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...args: never[]) => unknown).bind(target)
          : value;
      },
    });
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const res = await createApp({
      spendApiToken: TOKEN,
      authStore,
      messageStore: uuidPostStore(),
      fetchImpl,
    }).request(
      '/invoices',
      auth({
        method: 'POST',
        body: JSON.stringify({
          address: ADDRESS,
          amountMsat: 1000,
          messageId: POST_ID,
        }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forum post required' });
    expect(fetchImpl).not.toHaveBeenCalled();
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

  it('attaches a platform gift-reply and addSats when the invoice has messageId', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const messageStore = uuidPostStore();
    store.put(unpaid({ messageId: POST_ID, comment: 'gm', amountMsat: 1000 }));
    const res = await createApp({
      spendApiToken: TOKEN,
      invoiceStore: store,
      authStore,
      messageStore,
      now: () => 100,
    }).request(
      '/invoices/proof',
      auth({ method: 'POST', body: JSON.stringify({ id: unpaid().id, preimage: PREIMAGE }) }),
    );
    expect(res.status).toBe(200);
    expect((await messageStore.getById(POST_ID))?.sats).toBe(1);
    const replies = await messageStore.listReplies(POST_ID, 200);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.accountId).toBe('plat');
    expect(replies[0]?.name).toBe('21.gifts');
    expect(replies[0]?.parentId).toBe(POST_ID);
    expect(replies[0]?.sats).toBe(1);
    expect(replies[0]?.text).toBe('gm');
    expect(replies[0]?.nostrPublishState).toBe('pending');
  });

  it('addSats a reply invoice without creating a nested gift-reply', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const messageStore = uuidReplyStore();
    store.put(unpaid({ messageId: REPLY_ID, comment: 'gm', amountMsat: 1000 }));
    const res = await createApp({
      spendApiToken: TOKEN,
      invoiceStore: store,
      authStore,
      messageStore,
      now: () => 100,
    }).request(
      '/invoices/proof',
      auth({ method: 'POST', body: JSON.stringify({ id: unpaid().id, preimage: PREIMAGE }) }),
    );
    expect(res.status).toBe(200);
    expect((await messageStore.getById(REPLY_ID))?.sats).toBe(1);
    expect(await messageStore.listReplies(REPLY_ID, 200)).toEqual([]);
    expect(await messageStore.listReplies(POST_ID, 200)).toHaveLength(1);
  });

  it('does not double addSats or create a second gift-reply on the same preimage', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const messageStore = uuidPostStore();
    store.put(unpaid({ messageId: POST_ID, comment: 'gm', amountMsat: 1000 }));
    const app = createApp({
      spendApiToken: TOKEN,
      invoiceStore: store,
      authStore,
      messageStore,
      now: () => 100,
    });
    const body = auth({
      method: 'POST',
      body: JSON.stringify({ id: unpaid().id, preimage: PREIMAGE }),
    });
    expect((await app.request('/invoices/proof', body)).status).toBe(200);
    expect((await app.request('/invoices/proof', body)).status).toBe(200);
    expect((await messageStore.getById(POST_ID))?.sats).toBe(1);
    expect(await messageStore.listReplies(POST_ID, 200)).toHaveLength(1);
  });

  it('skips nostr publish when the gift-reply comment is empty', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const messageStore = uuidPostStore();
    store.put(unpaid({ messageId: POST_ID, comment: '', amountMsat: 1000 }));
    const res = await createApp({
      spendApiToken: TOKEN,
      invoiceStore: store,
      authStore,
      messageStore,
      now: () => 100,
    }).request(
      '/invoices/proof',
      auth({ method: 'POST', body: JSON.stringify({ id: unpaid().id, preimage: PREIMAGE }) }),
    );
    expect(res.status).toBe(200);
    const replies = await messageStore.listReplies(POST_ID, 200);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toBe('');
    expect(replies[0]?.nostrPublishState).toBe('skipped');
  });

  it('publishes a pending gift-reply when the comment is non-empty', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const messageStore = uuidPostStore();
    store.put(unpaid({ messageId: POST_ID, comment: 'gm', amountMsat: 1000 }));
    const res = await createApp({
      spendApiToken: TOKEN,
      invoiceStore: store,
      authStore,
      messageStore,
      now: () => 100,
    }).request(
      '/invoices/proof',
      auth({ method: 'POST', body: JSON.stringify({ id: unpaid().id, preimage: PREIMAGE }) }),
    );
    expect(res.status).toBe(200);
    const replies = await messageStore.listReplies(POST_ID, 200);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toBe('gm');
    expect(replies[0]?.nostrPublishState).toBe('pending');
  });

  it('names the gift-reply 21.gifts when the platform name is null', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    await authStore.createAccount({
      id: 'plat',
      linkingKey: null,
      role: 'founder',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
      isPlatform: true,
    });
    const messageStore = uuidPostStore();
    store.put(unpaid({ messageId: POST_ID, comment: 'gm', amountMsat: 1000 }));
    const res = await createApp({
      spendApiToken: TOKEN,
      invoiceStore: store,
      authStore,
      messageStore,
      now: () => 100,
    }).request(
      '/invoices/proof',
      auth({ method: 'POST', body: JSON.stringify({ id: unpaid().id, preimage: PREIMAGE }) }),
    );
    expect(res.status).toBe(200);
    expect((await messageStore.listReplies(POST_ID, 200))[0]?.name).toBe('21.gifts');
  });

  it('names the gift-reply 21.gifts when the platform name is blank', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    await authStore.createAccount({
      id: 'plat',
      linkingKey: null,
      role: 'founder',
      name: '   ',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
      isPlatform: true,
    });
    const messageStore = uuidPostStore();
    store.put(unpaid({ messageId: POST_ID, comment: 'gm', amountMsat: 1000 }));
    const res = await createApp({
      spendApiToken: TOKEN,
      invoiceStore: store,
      authStore,
      messageStore,
      now: () => 100,
    }).request(
      '/invoices/proof',
      auth({ method: 'POST', body: JSON.stringify({ id: unpaid().id, preimage: PREIMAGE }) }),
    );
    expect(res.status).toBe(200);
    expect((await messageStore.listReplies(POST_ID, 200))[0]?.name).toBe('21.gifts');
  });

  it('returns 200 and logs invoice.gift_reply.failed when the parent is missing', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const messageStore = new InMemoryMessageStore();
    store.put(unpaid({ messageId: POST_ID, comment: 'gm', amountMsat: 1000 }));
    const res = await createApp({
      spendApiToken: TOKEN,
      invoiceStore: store,
      authStore,
      messageStore,
      now: () => 100,
    }).request(
      '/invoices/proof',
      auth({ method: 'POST', body: JSON.stringify({ id: unpaid().id, preimage: PREIMAGE }) }),
    );
    expect(res.status).toBe(200);
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.gift_reply.failed')).toBe(true);
    expect(await messageStore.listReplies(POST_ID, 200)).toHaveLength(0);
  });

  it('returns 200 and logs invoice.gift_reply.failed when the parent is deleted', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const messageStore = uuidPostStore();
    await messageStore.markDeleted(POST_ID, new Date(50), 'mod');
    store.put(unpaid({ messageId: POST_ID, comment: 'gm', amountMsat: 1000 }));
    const res = await createApp({
      spendApiToken: TOKEN,
      invoiceStore: store,
      authStore,
      messageStore,
      now: () => 100,
    }).request(
      '/invoices/proof',
      auth({ method: 'POST', body: JSON.stringify({ id: unpaid().id, preimage: PREIMAGE }) }),
    );
    expect(res.status).toBe(200);
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.gift_reply.failed')).toBe(true);
    expect(await messageStore.listReplies(POST_ID, 200)).toHaveLength(0);
  });

  it('returns 200 and logs invoice.gift_reply.failed when the platform is missing at proof', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const messageStore = uuidPostStore();
    store.put(unpaid({ messageId: POST_ID, comment: 'gm', amountMsat: 1000 }));
    const res = await createApp({
      spendApiToken: TOKEN,
      invoiceStore: store,
      authStore,
      messageStore,
      now: () => 100,
    }).request(
      '/invoices/proof',
      auth({ method: 'POST', body: JSON.stringify({ id: unpaid().id, preimage: PREIMAGE }) }),
    );
    expect(res.status).toBe(200);
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.gift_reply.failed')).toBe(true);
    expect(await messageStore.listReplies(POST_ID, 200)).toHaveLength(0);
    expect((await messageStore.getById(POST_ID))?.sats).toBe(0);
  });

  it('creates no forum reply when the proven invoice has no messageId', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const messageStore = uuidPostStore();
    store.put(unpaid());
    const res = await createApp({
      spendApiToken: TOKEN,
      invoiceStore: store,
      authStore,
      messageStore,
      now: () => 100,
    }).request(
      '/invoices/proof',
      auth({ method: 'POST', body: JSON.stringify({ id: unpaid().id, preimage: PREIMAGE }) }),
    );
    expect(res.status).toBe(200);
    expect(await messageStore.listReplies(POST_ID, 200)).toHaveLength(0);
    expect((await messageStore.getById(POST_ID))?.sats).toBe(0);
  });

  it('returns 200 and logs invoice.gift_reply.failed when addSats throws', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const inner = uuidPostStore();
    const messageStore = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'addSats') {
          return async () => {
            throw new Error('addSats');
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...args: never[]) => unknown).bind(target)
          : value;
      },
    });
    store.put(unpaid({ messageId: POST_ID, comment: 'gm', amountMsat: 1000 }));
    const res = await createApp({
      spendApiToken: TOKEN,
      invoiceStore: store,
      authStore,
      messageStore,
      now: () => 100,
    }).request(
      '/invoices/proof',
      auth({ method: 'POST', body: JSON.stringify({ id: unpaid().id, preimage: PREIMAGE }) }),
    );
    expect(res.status).toBe(200);
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.gift_reply.failed')).toBe(true);
    expect(await inner.listReplies(POST_ID, 200)).toHaveLength(1);
    expect((await inner.getById(POST_ID))?.sats).toBe(0);
  });

  it('does not addSats when create throws, then credits once on retry', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const inner = uuidPostStore();
    let createCalls = 0;
    const messageStore = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'create') {
          return async (row: Parameters<InMemoryMessageStore['create']>[0]) => {
            createCalls += 1;
            if (createCalls === 1) {
              throw new Error('create');
            }
            return target.create(row);
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...args: never[]) => unknown).bind(target)
          : value;
      },
    });
    store.put(unpaid({ messageId: POST_ID, comment: 'gm', amountMsat: 1000 }));
    const app = createApp({
      spendApiToken: TOKEN,
      invoiceStore: store,
      authStore,
      messageStore,
      now: () => 100,
    });
    const body = auth({
      method: 'POST',
      body: JSON.stringify({ id: unpaid().id, preimage: PREIMAGE }),
    });
    expect((await app.request('/invoices/proof', body)).status).toBe(200);
    expect((await inner.getById(POST_ID))?.sats).toBe(0);
    expect((await app.request('/invoices/proof', body)).status).toBe(200);
    expect((await inner.getById(POST_ID))?.sats).toBe(1);
    expect(await inner.listReplies(POST_ID, 200)).toHaveLength(1);
  });

  it('returns 200 and logs messages.reply.notify.failed when notifyForumReply throws', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const messageStore = uuidPostStore();
    const notifications = new InMemoryNotificationStore();
    notifications.create = async () => {
      throw new Error('notify');
    };
    const pushStore = new InMemoryPushStore();
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/plat',
      accountId: 'acc-alice',
      p256dh: 'p',
      auth: 'a',
      createdAt: new Date(1),
    });
    store.put(unpaid({ messageId: POST_ID, comment: 'gm', amountMsat: 1000 }));
    const res = await createApp({
      spendApiToken: TOKEN,
      invoiceStore: store,
      authStore,
      messageStore,
      notificationStore: notifications,
      pushStore,
      now: () => 100,
    }).request(
      '/invoices/proof',
      auth({ method: 'POST', body: JSON.stringify({ id: unpaid().id, preimage: PREIMAGE }) }),
    );
    expect(res.status).toBe(200);
    expect(parsedEvents(warn).some((e) => e['event'] === 'messages.reply.notify.failed')).toBe(
      true,
    );
    expect((await messageStore.getById(POST_ID))?.sats).toBe(1);
    expect(await messageStore.listReplies(POST_ID, 200)).toHaveLength(1);
  });

  it('treats a missing invoice comment as empty gift-reply text', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const messageStore = uuidPostStore();
    store.put(unpaid({ messageId: POST_ID, amountMsat: 1000 }));
    const res = await createApp({
      spendApiToken: TOKEN,
      invoiceStore: store,
      authStore,
      messageStore,
      now: () => 100,
    }).request(
      '/invoices/proof',
      auth({ method: 'POST', body: JSON.stringify({ id: unpaid().id, preimage: PREIMAGE }) }),
    );
    expect(res.status).toBe(200);
    const replies = await messageStore.listReplies(POST_ID, 200);
    expect(replies[0]?.text).toBe('');
    expect(replies[0]?.nostrPublishState).toBe('skipped');
  });
});
