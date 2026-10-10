import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import {
  DailyRosterRequestError,
  DAILY_ROSTER_UNAVAILABLE,
  type DailyRosterDocument,
} from '@/lib/daily-roster';
import { InMemoryDailyRosterStore, type DailyRosterStore } from '@/lib/daily-roster-store';
import { InMemoryFundingStore } from '@/lib/funding-store';
import type { GiftRow } from '@/lib/gift';
import { InMemoryGiftStore } from '@/lib/gift-store';
import { unsignedNostrDefaults, type ForumPhoto } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import { setDiagnosticSink } from '@/lib/log';
import { spendInstructionRoutes } from '@/routes/spend-instruction-route';
import { createApp } from '@/server';
import { LNURL_SERVER, WALLET_PUBKEY } from '@/__tests__/helpers/wallet-lnurl';

const TOKEN = 'spend-secret-token';
const ADDRESS = 'alice@example.test';
const LNURL_ENV = {
  LNURL_SERVER_URL: LNURL_SERVER.baseUrl,
  PUBLIC_BASE_URL: LNURL_SERVER.publicBaseUrl,
};
const NOW_MS = Date.parse('2026-10-08T12:00:00.000Z');
const POST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEWER_POST_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROFILE_NOTE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const JPEG: ForumPhoto = {
  contentType: 'image/jpeg',
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
};

const PAYING_ROSTER: DailyRosterDocument = {
  comment: 'thanks',
  paymentsEnabled: true,
  moderatorPaymentsEnabled: true,
  defaultAmountUsd: 1,
  recipients: [{ address: ADDRESS, amountUsd: 2 }],
  moderators: [],
};

const welcomeToday: GiftRow = {
  paidAt: new Date('2026-10-08T08:00:00.000Z'),
  amountSats: 1000,
  recipientWosUser: 'Alice',
  kind: 'welcome',
};

function admittedStore(accountId = 'acc-alice'): InMemoryFundingStore {
  return new InMemoryFundingStore([
    {
      accountId,
      status: 'admitted',
      appliedAt: Date.parse('2026-09-01T00:00:00.000Z'),
      decidedAt: Date.parse('2026-09-10T08:00:00.000Z'),
      decidedBy: 'staff',
      trialUtcDate: null,
      admittedAt: Date.parse('2026-09-15T18:00:00.000Z'),
      note: null,
    },
  ]);
}

function fakeStore(get?: DailyRosterStore['get']): DailyRosterStore {
  const fallback = new InMemoryDailyRosterStore(PAYING_ROSTER);
  return {
    get: get ?? (async () => PAYING_ROSTER),
    hasBeenWritten: async () => true,
    setComment: (comment) => fallback.setComment(comment),
    setPaymentsEnabled: (enabled) => fallback.setPaymentsEnabled(enabled),
    setModeratorPaymentsEnabled: (enabled) => fallback.setModeratorPaymentsEnabled(enabled),
    addRecipient: (address, amountUsd) => fallback.addRecipient(address, amountUsd),
    updateRecipient: (address, amountUsd) => fallback.updateRecipient(address, amountUsd),
    deleteRecipient: (address) => fallback.deleteRecipient(address),
    addModerator: (address, amountUsd) => fallback.addModerator(address, amountUsd),
    updateModerator: (address, amountUsd) => fallback.updateModerator(address, amountUsd),
    deleteModerator: (address) => fallback.deleteModerator(address),
    importDocument: (body) => fallback.importDocument(body),
  };
}

function createSpendApp(deps: Parameters<typeof createApp>[0] = {}): ReturnType<typeof createApp> {
  return createApp({
    spendApiToken: TOKEN,
    rosterStore: fakeStore(),
    fundingStore: admittedStore(),
    now: () => NOW_MS,
    env: { ...process.env, ...LNURL_ENV },
    ...deps,
  });
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

async function verifyWallet(authStore: InMemoryAuthStore): Promise<void> {
  await authStore.claimSparkPubkey('acc-alice', WALLET_PUBKEY);
  await authStore.markSparkPubkeyVerified('acc-alice', WALLET_PUBKEY, 'alice', 2);
}

async function seedPasskeyAccount(
  authStore: InMemoryAuthStore,
  role: 'verified' | 'basis' = 'verified',
): Promise<void> {
  await authStore.createAccount({
    id: 'acc-alice',
    linkingKey: null,
    role,
    name: 'Ada',
    username: 'alice',
    walletRequired: true,
    forumLawsDismissed: false,
    location: null,
    viewKey: 'a'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: null,
  });
  await verifyWallet(authStore);
  await authStore.createPasskeyCredential({
    credentialId: 'cred-alice',
    publicKey: new Uint8Array([1]),
    signCount: 0,
    accountId: 'acc-alice',
    createdAt: 1,
  });
}

function livePostStore(accountId: string = 'acc-alice'): InMemoryMessageStore {
  return new InMemoryMessageStore([
    {
      id: POST_ID,
      accountId,
      name: 'Ada',
      text: 'first',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    },
  ]);
}

async function liveMediaPostStore(accountId: string = 'acc-alice'): Promise<InMemoryMessageStore> {
  const store = new InMemoryMessageStore();
  await store.create(
    {
      id: POST_ID,
      accountId,
      name: 'Ada',
      text: 'first',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    },
    JPEG,
  );
  return store;
}

function mount(overrides: Partial<Parameters<typeof spendInstructionRoutes>[0]> = {}): Hono {
  return new Hono().route(
    '/spend',
    spendInstructionRoutes({
      spendApiToken: TOKEN,
      authStore: new InMemoryAuthStore(),
      messageStore: new InMemoryMessageStore(),
      fundingStore: new InMemoryFundingStore(),
      now: () => NOW_MS,
      lnurlServer: LNURL_SERVER,
      ...overrides,
    }),
  );
}

describe('POST /spend/daily-instruction', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    setDiagnosticSink(null);
  });

  it('returns 503 when the spend token is not configured', async () => {
    const get = vi.fn(async () => PAYING_ROSTER);
    const res = await createSpendApp({
      spendApiToken: '',
      rosterStore: fakeStore(get),
    }).request(
      '/spend/daily-instruction',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS }) }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Spend invoices are not configured' });
    expect(get).not.toHaveBeenCalled();
  });

  it('returns 401 when the bearer is wrong', async () => {
    const res = await createSpendApp().request('/spend/daily-instruction', {
      method: 'POST',
      headers: {
        authorization: 'Bearer nope',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ address: ADDRESS }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 400 when the body is not a JSON object with a string address', async () => {
    const app = createSpendApp();
    const cases: Array<{ body: string }> = [
      { body: 'not-json' },
      { body: JSON.stringify([]) },
      { body: JSON.stringify(null) },
      { body: JSON.stringify(1) },
      { body: JSON.stringify({ extra: true }) },
      { body: JSON.stringify({ address: null }) },
      { body: JSON.stringify({ address: 1 }) },
    ];
    for (const item of cases) {
      const res = await app.request(
        '/spend/daily-instruction',
        auth({ method: 'POST', body: item.body }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Expected a JSON body with address' });
    }
  });

  it('returns 400 when the address string is not a Lightning Address', async () => {
    const res = await createSpendApp().request(
      '/spend/daily-instruction',
      auth({ method: 'POST', body: JSON.stringify({ address: 'nope' }) }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Not a valid Lightning Address (expected name@domain)',
    });
  });

  it('returns no_passkey when there is no account', async () => {
    const messageStore = new InMemoryMessageStore();
    const fundingStore = admittedStore();
    const hasPosted = vi.spyOn(messageStore, 'accountHasLiveTopLevelPost');
    const getGrant = vi.spyOn(fundingStore, 'getByAccountId');
    const res = await createSpendApp({ messageStore, fundingStore }).request(
      '/spend/daily-instruction',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action: 'skip', reason: 'no_passkey' });
    expect(hasPosted).not.toHaveBeenCalled();
    expect(getGrant).not.toHaveBeenCalled();
  });

  it('returns no_passkey when the account has no passkey', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount({
      id: 'acc-alice',
      linkingKey: null,
      role: 'verified',
      name: 'Ada',
      username: 'alice',
      walletRequired: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await verifyWallet(authStore);
    const res = await createSpendApp({ authStore }).request(
      '/spend/daily-instruction',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action: 'skip', reason: 'no_passkey' });
  });

  it('returns no_post when there is no live top-level non-profile post', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const messageStore = new InMemoryMessageStore();
    const hasMedia = vi.spyOn(messageStore, 'accountHasLiveTopLevelMediaPost');
    const listPosts = vi.spyOn(messageStore, 'listPostsByAccount');
    const res = await createSpendApp({ authStore, messageStore }).request(
      '/spend/daily-instruction',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action: 'skip', reason: 'no_post' });
    expect(hasMedia).not.toHaveBeenCalled();
    expect(listPosts).not.toHaveBeenCalled();
  });

  it('returns no_media when the live post has no media', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const res = await createSpendApp({
      authStore,
      messageStore: livePostStore(),
    }).request(
      '/spend/daily-instruction',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action: 'skip', reason: 'no_media' });
  });

  it('returns not_eligible for a basis account without reading a grant', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore, 'basis');
    const fundingStore = admittedStore();
    const getGrant = vi.spyOn(fundingStore, 'getByAccountId');
    const res = await createSpendApp({
      authStore,
      messageStore: await liveMediaPostStore(),
      fundingStore,
    }).request(
      '/spend/daily-instruction',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action: 'skip', reason: 'not_eligible' });
    expect(getGrant).not.toHaveBeenCalled();
  });

  it('returns not_eligible when eligibleToday rejects a non-basis account', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const res = await createSpendApp({
      authStore,
      messageStore: await liveMediaPostStore(),
      fundingStore: new InMemoryFundingStore(),
    }).request(
      '/spend/daily-instruction',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action: 'skip', reason: 'not_eligible' });
  });

  it('returns payments_disabled when the roster switch is off', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const res = await createSpendApp({
      authStore,
      messageStore: await liveMediaPostStore(),
      rosterStore: fakeStore(async () => ({
        ...PAYING_ROSTER,
        paymentsEnabled: false,
      })),
    }).request(
      '/spend/daily-instruction',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action: 'skip', reason: 'payments_disabled' });
  });

  it('returns welcome_paid when a welcome gift was paid today and the comment is not Welcome', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const res = await createSpendApp({
      authStore,
      messageStore: await liveMediaPostStore(),
      giftStore: new InMemoryGiftStore([welcomeToday]),
    }).request(
      '/spend/daily-instruction',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action: 'skip', reason: 'welcome_paid' });
  });

  it('returns a pay with the newest non-profile post id', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const res = await createSpendApp({
      authStore,
      messageStore: await liveMediaPostStore(),
    }).request(
      '/spend/daily-instruction',
      auth({
        method: 'POST',
        body: JSON.stringify({ address: ADDRESS, amountUsd: 9, kind: 'welcome' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      action: 'pay',
      amountUsd: 2,
      comment: 'thanks',
      messageId: POST_ID,
    });
  });

  it('returns a pay with the older media post when a newer note is text only', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const messageStore = await liveMediaPostStore();
    await messageStore.create({
      id: NEWER_POST_ID,
      accountId: 'acc-alice',
      name: 'Ada',
      text: 'later',
      createdAt: new Date('2026-08-02T00:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const res = await createSpendApp({ authStore, messageStore }).request(
      '/spend/daily-instruction',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      action: 'pay',
      amountUsd: 2,
      comment: 'thanks',
      messageId: POST_ID,
    });
  });

  it('returns a pay with the newer media post when an older note also has a photo', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const messageStore = await liveMediaPostStore();
    await messageStore.create(
      {
        id: NEWER_POST_ID,
        accountId: 'acc-alice',
        name: 'Ada',
        text: 'later photo',
        createdAt: new Date('2026-08-02T00:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      JPEG,
    );
    const res = await createSpendApp({ authStore, messageStore }).request(
      '/spend/daily-instruction',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      action: 'pay',
      amountUsd: 2,
      comment: 'thanks',
      messageId: NEWER_POST_ID,
    });
  });

  it('omits messageId when listed posts have no non-profile id', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount({
      id: 'acc-alice',
      linkingKey: null,
      role: 'verified',
      name: 'Ada',
      username: 'alice',
      walletRequired: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
      profileMessageId: PROFILE_NOTE_ID,
    });
    await verifyWallet(authStore);
    await authStore.createPasskeyCredential({
      credentialId: 'cred-alice',
      publicKey: new Uint8Array([1]),
      signCount: 0,
      accountId: 'acc-alice',
      createdAt: 1,
    });
    const inner = new InMemoryMessageStore();
    const messageStore = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'accountHasLiveTopLevelPost') {
          return async () => true;
        }
        if (prop === 'accountHasLiveTopLevelMediaPost') {
          return async () => true;
        }
        if (prop === 'listPostsByAccount') {
          return async () => [{ id: PROFILE_NOTE_ID }];
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...args: never[]) => unknown).bind(target)
          : value;
      },
    });
    const res = await createSpendApp({ authStore, messageStore }).request(
      '/spend/daily-instruction',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      action: 'pay',
      amountUsd: 2,
      comment: 'thanks',
    });
  });

  it('returns 503 when the gift ledger cannot be listed and does not read the roster', async () => {
    const get = vi.fn(async () => PAYING_ROSTER);
    const giftStore = {
      listOutbound: () => Promise.reject(new Error('ledger down')),
    };
    const res = await createSpendApp({
      giftStore,
      rosterStore: fakeStore(get),
    }).request(
      '/spend/daily-instruction',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS }) }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Gift ledger unreadable' });
    expect(get).not.toHaveBeenCalled();
  });

  it('pays when gifts are omitted on the factory and skips welcome_paid when a welcome gift is listed today', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const messageStore = await liveMediaPostStore();
    const fundingStore = admittedStore();
    const omitted = mount({
      authStore,
      messageStore,
      fundingStore,
      rosterStore: fakeStore(),
    });
    const paid = await omitted.request(
      '/spend/daily-instruction',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS }) }),
    );
    expect(paid.status).toBe(200);
    expect(await paid.json()).toEqual({
      action: 'pay',
      amountUsd: 2,
      comment: 'thanks',
      messageId: POST_ID,
    });
    const flagged = await createSpendApp({
      authStore,
      messageStore,
      fundingStore,
      giftStore: new InMemoryGiftStore([welcomeToday]),
    }).request(
      '/spend/daily-instruction',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS }) }),
    );
    expect(flagged.status).toBe(200);
    expect(await flagged.json()).toEqual({ action: 'skip', reason: 'welcome_paid' });
  });

  it('skips when the roster store is omitted and the account has no passkey', async () => {
    const authStore = new InMemoryAuthStore();
    const res = await mount({ authStore }).request(
      '/spend/daily-instruction',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action: 'skip', reason: 'no_passkey' });
  });

  it('forwards DailyRosterRequestError status 400 and the error string', async () => {
    const res = await createSpendApp({
      rosterStore: fakeStore(async () => {
        throw new DailyRosterRequestError(400, 'Invalid comment');
      }),
    }).request(
      '/spend/daily-instruction',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS }) }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid comment' });
  });

  it('forwards DailyRosterRequestError status 502 and the error string', async () => {
    const res = await createSpendApp({
      rosterStore: fakeStore(async () => {
        throw new DailyRosterRequestError(502, DAILY_ROSTER_UNAVAILABLE);
      }),
    }).request(
      '/spend/daily-instruction',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS }) }),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: DAILY_ROSTER_UNAVAILABLE });
  });

  it('returns 502 when roster get throws any other error', async () => {
    const res = await createSpendApp({
      rosterStore: fakeStore(async () => {
        throw new Error('network');
      }),
    }).request(
      '/spend/daily-instruction',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS }) }),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: DAILY_ROSTER_UNAVAILABLE });
  });
});
