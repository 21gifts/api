import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore, type Account, type PasskeyRenewAttemptInput } from '@/lib/auth/store';
import { SESSION_TTL_MS } from '@/lib/config';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import { InMemoryNotificationStore } from '@/lib/notification-store';
import { InMemoryPushStore } from '@/lib/push-store';
import type { ShopIdentityStore } from '@/lib/shop-identity';
import { createApp } from '@/server';
import { WRONG_ACCOUNT_ERROR } from '@/lib/auth/wrong-account';
import { InMemoryFundingStore, type FundingStore } from '@/lib/funding-store';
import type { FetchFn } from '@/lib/lnurlp';
import { SPARK_EXPLORER_BASE_URL } from '@/lib/spark-explorer';
import type { SpendPing } from '@/lib/spend-ping';
import { bearerToken, meRoutes } from '@/routes/me';
import {
  PINNED,
  RECOVERY_USERNAME,
  seedPinnedAccount,
  stagePendingRecovery,
} from '@/__tests__/helpers/recovery';
import { LNURL_SERVER, WALLET_PUBKEY } from '@/__tests__/helpers/wallet-lnurl';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

const now = (): number => 1_000_000;
const AUTH = { authorization: 'Bearer tok' };
const LINKING_KEY = `02${'a'.repeat(64)}`;
const VIEW_KEY = 'a'.repeat(64);
const ADDRESS = 'alice@example.test';

interface MountOpts {
  clock?: () => number;
  messages?: InMemoryMessageStore;
  pushStore?: InMemoryPushStore;
  notificationStore?: InMemoryNotificationStore;
  walletEnabled?: boolean;
  recoveryShareKek?: Uint8Array;
  fetchImpl?: FetchFn;
  fundingStore?: FundingStore;
  spendPing?: SpendPing;
}

function mount(store: InMemoryAuthStore, opts: MountOpts = {}): Hono {
  return new Hono().route(
    '/me',
    meRoutes({
      store,
      messages: opts.messages ?? new InMemoryMessageStore(),
      now: opts.clock ?? now,
      ...(opts.pushStore === undefined ? {} : { pushStore: opts.pushStore }),
      ...(opts.notificationStore === undefined
        ? {}
        : { notificationStore: opts.notificationStore }),
      ...(opts.walletEnabled === true ? { lnurlServer: LNURL_SERVER } : {}),
      ...(opts.recoveryShareKek === undefined ? {} : { recoveryShareKek: opts.recoveryShareKek }),
      ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
      ...(opts.fundingStore === undefined ? {} : { fundingStore: opts.fundingStore }),
      ...(opts.spendPing === undefined ? {} : { spendPing: opts.spendPing }),
    }),
  );
}

const SPARK_PUBKEY = `02${'a'.repeat(64)}`;
const SPARK_PUBKEY_OTHER = `03${'b'.repeat(64)}`;

/** A store with a signed-in account `acc` reachable via session `tok`. */
async function seededStore(
  overrides: { wallet?: boolean; hadExternalWallet?: boolean } = {},
): Promise<InMemoryAuthStore> {
  const store = new InMemoryAuthStore();
  await store.createAccount({
    id: 'acc',
    linkingKey: LINKING_KEY,
    role: 'basis',
    name: null,
    forumLawsDismissed: false,
    location: null,
    viewKey: VIEW_KEY,
    createdAt: 1_000_000,
    rulesAgreedAt: null,
    ...(overrides.wallet === true ? { username: 'alice', walletRequired: true } : {}),
    ...(overrides.hadExternalWallet === true ? { hadExternalWallet: true } : {}),
  });
  if (overrides.wallet === true) {
    await store.claimSparkPubkey('acc', WALLET_PUBKEY);
    await store.markSparkPubkeyVerified('acc', WALLET_PUBKEY, 'alice', 1);
  }
  await store.createSession({ token: 'tok', accountId: 'acc', createdAt: 1_000_000 });
  return store;
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

  it('returns 401 for an expired session', async () => {
    const store = await seededStore();
    const res = await mount(store, { clock: () => 1_000_000 + SESSION_TTL_MS + 1 }).request('/me', {
      headers: AUTH,
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 for a sessionRefused account', async () => {
    const store = new InMemoryAuthStore();
    const id = '00000000-0000-4000-8000-0000000000ff';
    await store.createAccount({
      id,
      linkingKey: LINKING_KEY,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: VIEW_KEY,
      createdAt: 1_000_000,
      rulesAgreedAt: null,
      sessionRefused: true,
    });
    await store.createSession({ token: 'tok', accountId: id, createdAt: 1_000_000 });
    const res = await mount(store).request('/me', { headers: AUTH });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: WRONG_ACCOUNT_ERROR });
  });

  it('returns 401 on other /me routes for a sessionRefused account', async () => {
    const store = new InMemoryAuthStore();
    const id = '00000000-0000-4000-8000-0000000000ff';
    await store.createAccount({
      id,
      linkingKey: LINKING_KEY,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: VIEW_KEY,
      createdAt: 1_000_000,
      rulesAgreedAt: null,
      sessionRefused: true,
    });
    await store.createSession({ token: 'tok', accountId: id, createdAt: 1_000_000 });
    const res = await mount(store).request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns the account for a valid session', async () => {
    const store = await seededStore();
    const res = await mount(store).request('/me', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      role: string;
      name: string | null;
      username: string | null;
      location: string | null;
      lightningAddress: string | null;
      lightningAddressVerified: boolean;
      viewKey: string;
      rulesAgreedAt: number | null;
      setup: 'wallet' | 'name' | 'username' | 'lightning-address' | 'rules' | null;
      missing: string[];
      hasPosted: boolean;
      notificationLevel: 'all' | 'active' | 'mentions' | 'none';
      notifyHearts: boolean;
      amountUnit: 'btc' | 'fiat';
      locale: 'en' | 'de' | 'es' | 'fil' | null;
      fiat: 'CHF' | 'EUR' | 'USD' | 'PHP' | null;
      funding: null;
      walletRequired: boolean;
      walletBackupSeenAt: number | null;
      passkeyRenewFailed: boolean;
      passkeyRenewClosed: boolean;
    };
    expect(body.id).toBe('acc');
    expect(body.role).toBe('basis');
    expect(body.name).toBeNull();
    expect(body.username).toBeNull();
    expect(body.location).toBeNull();
    expect(body.lightningAddress).toBeNull();
    expect(body.lightningAddressVerified).toBe(false);
    expect(body.viewKey).toBe(VIEW_KEY);
    expect(body.rulesAgreedAt).toBeNull();
    expect(body.setup).toBe('name');
    expect(body.missing).toEqual(['name', 'username', 'lightning-address', 'rules']);
    expect(body.hasPosted).toBe(false);
    expect(body.notificationLevel).toBe('all');
    expect(body.notifyHearts).toBe(true);
    expect(body.amountUnit).toBe('btc');
    expect(body.locale).toBeNull();
    expect(body.fiat).toBeNull();
    expect(body.funding).toBeNull();
    expect(body.walletRequired).toBe(false);
    expect(body.walletBackupSeenAt).toBeNull();
    expect(body.passkeyRenewFailed).toBe(false);
    expect(body.passkeyRenewClosed).toBe(false);
  });

  it('returns funding none for a verified account without a grant', async () => {
    const store = await seededStore();
    const existing = await store.getAccount('acc');
    expect(existing).toBeDefined();
    await store.updateAccount({ ...existing!, role: 'verified' });
    const res = await mount(store).request('/me', { headers: AUTH });
    expect(res.status).toBe(200);
    const funded = (await res.json()) as {
      funding: unknown;
      walletRequired: boolean;
      walletBackupSeenAt: number | null;
    };
    expect(funded.funding).toEqual({
      status: 'none',
      trialUtcDate: null,
      admittedAt: null,
      reviewedByName: null,
      dailyPayoutStoppedNotice: false,
    });
    expect(funded.walletRequired).toBe(false);
    expect(funded.walletBackupSeenAt).toBeNull();
  });

  it('returns dailyPayoutStoppedNotice true for a listed verified account without a grant', async () => {
    const store = new InMemoryAuthStore();
    const id = '14101481-f421-42ef-9d37-6df3ccb6b25f';
    await store.createAccount({
      id,
      linkingKey: LINKING_KEY,
      role: 'verified',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: VIEW_KEY,
      createdAt: 1_000_000,
      rulesAgreedAt: null,
    });
    await store.createSession({ token: 'tok', accountId: id, createdAt: 1_000_000 });
    const res = await mount(store).request('/me', { headers: AUTH });
    expect(res.status).toBe(200);
    const funded = (await res.json()) as {
      funding: { status: string; dailyPayoutStoppedNotice: boolean };
    };
    expect(funded.funding.status).toBe('none');
    expect(funded.funding.dailyPayoutStoppedNotice).toBe(true);
  });

  it('returns hasPosted false when the only live row is the profile note', async () => {
    const store = await seededStore();
    const existing = await store.getAccount('acc');
    expect(existing).toBeDefined();
    await store.updateAccount({ ...existing!, name: 'Ada', profileMessageId: 'post-alice' });
    const messages = new InMemoryMessageStore([
      {
        id: 'post-alice',
        accountId: 'acc',
        name: 'Ada',
        text: 'Ada',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
    ]);
    const res = await mount(store, { messages }).request('/me', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasPosted: boolean; aboutMe: string | null };
    expect(body.hasPosted).toBe(false);
    expect(body.aboutMe).toBeNull();
  });

  it('returns hasPosted true when the profile note is a real bio', async () => {
    const store = await seededStore();
    const existing = await store.getAccount('acc');
    expect(existing).toBeDefined();
    await store.updateAccount({ ...existing!, profileMessageId: 'post-alice' });
    const messages = new InMemoryMessageStore([
      {
        id: 'post-alice',
        accountId: 'acc',
        name: 'Ada',
        text: 'first',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
    ]);
    const res = await mount(store, { messages }).request('/me', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasPosted: boolean; aboutMe: string | null };
    expect(body.hasPosted).toBe(true);
    expect(body.aboutMe).toBe('first');
  });

  it('returns hasPosted true when the account has an extra live message', async () => {
    const store = await seededStore();
    const messages = new InMemoryMessageStore([
      {
        id: 'post-alice',
        accountId: 'acc',
        name: 'Ada',
        text: 'first',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
    ]);
    const res = await mount(store, { messages }).request('/me', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { hasPosted: boolean }).hasPosted).toBe(true);
  });
});

describe('POST /me/setup/skip', () => {
  it('returns 401 without a session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me/setup/skip', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ step: 'name' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects step rules and unknown steps', async () => {
    const store = await seededStore();
    const rules = await mount(store).request('/me/setup/skip', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ step: 'rules' }),
    });
    expect(rules.status).toBe(400);
    const bad = await mount(store).request('/me/setup/skip', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ step: 'nope' }),
    });
    expect(bad.status).toBe(400);
  });

  it('rejects step wallet with the same copy as an invalid step', async () => {
    const store = await seededStore();
    const res = await mount(store).request('/me/setup/skip', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ step: 'wallet' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with step "name" or "lightning-address"',
    });
  });

  it('skips name then GET /me advances setup to username', async () => {
    const store = await seededStore();
    const res = await mount(store).request('/me/setup/skip', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ step: 'name' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      setup: string | null;
      missing: string[];
      name: string | null;
    };
    expect(body.setup).toBe('username');
    expect(body.name).toBeNull();
    expect(body.missing).toContain('name');
    expect(body.missing).toContain('username');
    expect((await store.getAccount('acc'))?.nameSkippedAt).toBe(now());
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'account.setup.skipped' &&
          e['accountId'] === 'acc' &&
          e['step'] === 'name',
      ),
    ).toBe(true);
    const me = await mount(store).request('/me', { headers: AUTH });
    expect(((await me.json()) as { setup: string }).setup).toBe('username');
  });

  it('rejects skipping username', async () => {
    const store = await seededStore();
    const res = await mount(store).request('/me/setup/skip', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ step: 'username' }),
    });
    expect(res.status).toBe(400);
  });

  it('skips lightning-address', async () => {
    const store = await seededStore();
    const account = await store.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await store.updateAccount({ ...account, name: 'Ada', username: 'ada' });
    const res = await mount(store).request('/me/setup/skip', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ step: 'lightning-address' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { setup: string }).setup).toBe('rules');
    expect((await store.getAccount('acc'))?.lightningAddressSkippedAt).toBe(now());
  });
});

describe('POST /me/wallet-backup-seen', () => {
  it('returns 401 without a session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me/wallet-backup-seen', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('sets walletBackupSeenAt and returns owner JSON', async () => {
    const store = await seededStore();
    const existing = await store.getAccount('acc');
    expect(existing).toBeDefined();
    expect(
      await store.createFirstPasskeyCredential({
        credentialId: 'cred-wallet',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(true);
    const res = await mount(store).request('/me/wallet-backup-seen', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      walletRequired: boolean;
      walletBackupSeenAt: number | null;
      setup: string | null;
    };
    expect(body.walletRequired).toBe(true);
    expect(body.walletBackupSeenAt).toBe(now());
    expect(body.setup).toBe('name');
    expect((await store.getAccount('acc'))?.walletBackupSeenAt).toBe(now());
    const events = parsedEvents(warn).filter((e) => e['event'] === 'account.wallet.backup_seen');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'account.wallet.backup_seen', accountId: 'acc' });
    expect(events[0]).not.toHaveProperty('mnemonic');
    expect(events[0]).not.toHaveProperty('prf');
  });

  it('keeps the original timestamp on a second POST', async () => {
    const store = await seededStore();
    const existing = await store.getAccount('acc');
    expect(existing).toBeDefined();
    expect(await store.markWalletBackupSeen('acc', 1_000_000)).toMatchObject({
      wrote: true,
      account: { walletBackupSeenAt: 1_000_000 },
    });
    const res = await mount(store, { clock: () => 2_000_000 }).request('/me/wallet-backup-seen', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { walletBackupSeenAt: number | null }).walletBackupSeenAt).toBe(
      1_000_000,
    );
    expect((await store.getAccount('acc'))?.walletBackupSeenAt).toBe(1_000_000);
    expect(parsedEvents(warn).some((e) => e['event'] === 'account.wallet.backup_seen')).toBe(false);
  });
});

class RecordingAuthStore extends InMemoryAuthStore {
  inserts: PasskeyRenewAttemptInput[] = [];
  override async insertPasskeyRenewAttempt(input: PasskeyRenewAttemptInput): Promise<void> {
    this.inserts.push(input);
    await super.insertPasskeyRenewAttempt(input);
  }
}

const PASSKEY_RENEW_REPORT = {
  stage: 'ceremony' as const,
  outcome: 'failed' as const,
  errorName: 'Error',
  errorCode: null,
  httpStatus: null,
  message: 'seed failed',
};

describe('POST /me/passkey-renew/report', () => {
  it('returns 401 without a session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me/passkey-renew/report', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('stores a failed row and returns owner JSON with passkeyRenewFailed true', async () => {
    const store = new RecordingAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: LINKING_KEY,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: VIEW_KEY,
      createdAt: 1_000_000,
      rulesAgreedAt: null,
    });
    await store.createSession({ token: 'tok', accountId: 'acc', createdAt: 1_000_000 });
    const res = await mount(store).request('/me/passkey-renew/report', {
      method: 'POST',
      headers: {
        ...AUTH,
        'content-type': 'application/json',
        'user-agent': 'TestAgent',
      },
      body: JSON.stringify(PASSKEY_RENEW_REPORT),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      passkeyRenewFailed: boolean;
      passkeyRenewClosed: boolean;
      passkeyRenewPrfUnsupported: boolean;
      walletRequired: boolean;
    };
    expect(body.passkeyRenewFailed).toBe(true);
    expect(body.passkeyRenewClosed).toBe(false);
    expect(body.passkeyRenewPrfUnsupported).toBe(false);
    expect(body.walletRequired).toBe(false);
    expect((await store.getAccount('acc'))?.walletRequired === true).toBe(false);
    expect(store.inserts).toHaveLength(1);
    expect(store.inserts[0]).toMatchObject({
      accountId: 'acc',
      createdAt: now(),
      stage: 'ceremony',
      outcome: 'failed',
      errorName: 'Error',
      errorCode: null,
      httpStatus: null,
      message: 'seed failed',
      userAgent: 'TestAgent',
    });
  });

  it('stores allowlisted authenticator facts and marks a missing PRF', async () => {
    const store = new RecordingAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: LINKING_KEY,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: VIEW_KEY,
      createdAt: 1_000_000,
      rulesAgreedAt: null,
    });
    await store.createSession({ token: 'tok', accountId: 'acc', createdAt: 1_000_000 });
    const res = await mount(store).request('/me/passkey-renew/report', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...PASSKEY_RENEW_REPORT,
        errorName: 'prfUnsupported',
        message: 'wallet.prfUnsupported',
        authenticatorAttachment: 'cross-platform',
        transports: 'usb,nope',
        aaguid: 'ab'.repeat(16),
        prfEnabled: false,
        prfPresent: false,
        extensions: 'prf,nope',
        authenticatorFlags: 0,
        publicKeyAlgorithm: -7,
        residentKey: true,
        hmacSecret: false,
        credProtect: 2,
        clientCapabilities: 'prf,hybridTransport',
      }),
    });
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { passkeyRenewPrfUnsupported: boolean }).passkeyRenewPrfUnsupported,
    ).toBe(true);
    expect(store.inserts[0]).toMatchObject({
      errorName: 'prfUnsupported',
      authenticatorAttachment: 'cross-platform',
      transports: 'usb,nope',
      aaguid: 'ab'.repeat(16),
      prfEnabled: false,
      prfPresent: false,
      extensions: 'prf,nope',
      authenticatorFlags: 0,
      publicKeyAlgorithm: -7,
      residentKey: true,
      hmacSecret: false,
      credProtect: 2,
      clientCapabilities: 'prf,hybridTransport',
    });
  });

  it('stores the row when a debug value is the wrong type', async () => {
    const store = new RecordingAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: LINKING_KEY,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: VIEW_KEY,
      createdAt: 1_000_000,
      rulesAgreedAt: null,
    });
    await store.createSession({ token: 'tok', accountId: 'acc', createdAt: 1_000_000 });
    const res = await mount(store).request('/me/passkey-renew/report', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...PASSKEY_RENEW_REPORT,
        authenticatorFlags: 'nope',
        credProtect: { policy: 'userVerificationRequired' },
      }),
    });
    expect(res.status).toBe(200);
    expect(store.inserts).toHaveLength(1);
    expect(store.inserts[0]).toMatchObject({ authenticatorFlags: 'nope' });
  });

  it('returns 400 for an unknown report key and stores nothing', async () => {
    const store = new RecordingAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: LINKING_KEY,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: VIEW_KEY,
      createdAt: 1_000_000,
      rulesAgreedAt: null,
    });
    await store.createSession({ token: 'tok', accountId: 'acc', createdAt: 1_000_000 });
    const res = await mount(store).request('/me/passkey-renew/report', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ ...PASSKEY_RENEW_REPORT, credentialId: 'secret' }),
    });
    expect(res.status).toBe(400);
    expect(store.inserts).toHaveLength(0);
  });

  it('accepts an over-long phrase and a long secret instead of rejecting them', async () => {
    const store = new RecordingAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: LINKING_KEY,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: VIEW_KEY,
      createdAt: 1_000_000,
      rulesAgreedAt: null,
    });
    await store.createSession({ token: 'tok', accountId: 'acc', createdAt: 1_000_000 });
    const phrase = Array.from({ length: 12 }, () => 'x'.repeat(50)).join(' ');
    const longName = `${'a'.repeat(64)}name`;
    const longCode = `${'c'.repeat(40)}.${'d'.repeat(40)}`;
    const res = await mount(store).request('/me/passkey-renew/report', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...PASSKEY_RENEW_REPORT,
        errorName: longName,
        errorCode: longCode,
        message: phrase,
      }),
    });
    expect(res.status).toBe(200);
    expect(store.inserts).toHaveLength(1);
    expect(store.inserts[0]?.errorName).toBe(longName);
    expect(store.inserts[0]?.errorCode).toBe(longCode);
    expect(store.inserts[0]?.message).toBe(phrase);
    expect((await store.getAccount('acc'))?.walletRequired === true).toBe(false);
  });

  it('does not look closed when a seed lands during the report', async () => {
    const store = new RecordingAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: LINKING_KEY,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: VIEW_KEY,
      createdAt: 1_000_000,
      rulesAgreedAt: null,
    });
    await store.createSession({ token: 'tok', accountId: 'acc', createdAt: 1_000_000 });
    await InMemoryAuthStore.prototype.insertPasskeyRenewAttempt.call(store, {
      id: 'prior-fail',
      accountId: 'acc',
      createdAt: 1,
      stage: 'ceremony',
      outcome: 'failed',
      errorName: null,
      errorCode: null,
      httpStatus: null,
      message: 'seed failed',
      userAgent: null,
    });
    await store.acknowledgePasskeyRenewFailures('acc', 2);
    const seeded = store.insertPasskeyRenewAttempt.bind(store);
    store.insertPasskeyRenewAttempt = async (input) => {
      await store.addSeedPasskeyCredential({
        credentialId: 'seed-during-report',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: input.accountId,
        createdAt: 3,
      });
      await seeded(input);
    };
    const res = await mount(store).request('/me/passkey-renew/report', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(PASSKEY_RENEW_REPORT),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      passkeyRenewClosed: boolean;
      walletRequired: boolean;
    };
    expect(body.walletRequired).toBe(true);
    expect(body.passkeyRenewClosed).toBe(false);
  });

  it('returns 400 for outcome succeeded and stores nothing', async () => {
    const store = new RecordingAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: LINKING_KEY,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: VIEW_KEY,
      createdAt: 1_000_000,
      rulesAgreedAt: null,
    });
    await store.createSession({ token: 'tok', accountId: 'acc', createdAt: 1_000_000 });
    const res = await mount(store).request('/me/passkey-renew/report', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ ...PASSKEY_RENEW_REPORT, outcome: 'succeeded' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        'Expected a JSON body with stage, outcome, errorName, errorCode, httpStatus, and message',
    });
    expect(store.inserts).toEqual([]);
    expect(await store.hasUnacknowledgedPasskeyRenewFailure('acc')).toBe(false);
  });

  it('returns 400 for invalid JSON and stores nothing', async () => {
    const store = new RecordingAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: LINKING_KEY,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: VIEW_KEY,
      createdAt: 1_000_000,
      rulesAgreedAt: null,
    });
    await store.createSession({ token: 'tok', accountId: 'acc', createdAt: 1_000_000 });
    const res = await mount(store).request('/me/passkey-renew/report', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    expect(store.inserts).toEqual([]);
  });
});

describe('POST /me/passkey-renew/ack', () => {
  it('returns 401 without a session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me/passkey-renew/ack', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('acknowledges a failed report and returns passkeyRenewFailed false', async () => {
    const store = new RecordingAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: LINKING_KEY,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: VIEW_KEY,
      createdAt: 1_000_000,
      rulesAgreedAt: null,
    });
    await store.createSession({ token: 'tok', accountId: 'acc', createdAt: 1_000_000 });
    const reported = await mount(store).request('/me/passkey-renew/report', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(PASSKEY_RENEW_REPORT),
    });
    expect(reported.status).toBe(200);
    expect(((await reported.json()) as { passkeyRenewFailed: boolean }).passkeyRenewFailed).toBe(
      true,
    );
    const res = await mount(store).request('/me/passkey-renew/ack', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      passkeyRenewFailed: boolean;
      passkeyRenewClosed: boolean;
      walletRequired: boolean;
    };
    expect(body.passkeyRenewFailed).toBe(false);
    expect(body.passkeyRenewClosed).toBe(true);
    expect(body.walletRequired).toBe(false);
    expect(store.inserts).toHaveLength(1);
  });
});

describe('POST /me/forum-laws-dismissed', () => {
  it('returns 401 without a valid session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me/forum-laws-dismissed', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('sets forumLawsDismissed on first POST and logs', async () => {
    const store = await seededStore();
    const res = await mount(store).request('/me/forum-laws-dismissed', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { forumLawsDismissed: boolean };
    expect(body.forumLawsDismissed).toBe(true);
    expect((await store.getAccount('acc'))?.forumLawsDismissed).toBe(true);
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'account.forum_laws.dismissed' && e['accountId'] === 'acc',
      ),
    ).toBe(true);
  });

  it('is idempotent on a second POST', async () => {
    const store = await seededStore();
    const app = mount(store);
    await app.request('/me/forum-laws-dismissed', { method: 'POST', headers: AUTH });
    const before = warn.mock.calls.length;
    const res = await app.request('/me/forum-laws-dismissed', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { forumLawsDismissed: boolean }).forumLawsDismissed).toBe(true);
    expect((await store.getAccount('acc'))?.forumLawsDismissed).toBe(true);
    const dismissLogs = parsedEvents(warn)
      .slice(before)
      .filter((e) => e['event'] === 'account.forum_laws.dismissed');
    expect(dismissLogs).toHaveLength(0);
  });

  it('includes forumLawsDismissed true on GET /me after dismiss', async () => {
    const store = await seededStore();
    const app = mount(store);
    await app.request('/me/forum-laws-dismissed', { method: 'POST', headers: AUTH });
    const res = await app.request('/me', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { forumLawsDismissed: boolean }).forumLawsDismissed).toBe(true);
  });

  it('does not clear forumLawsDismissed when setting a name', async () => {
    const store = await seededStore();
    const app = mount(store);
    await app.request('/me/forum-laws-dismissed', { method: 'POST', headers: AUTH });
    const res = await app.request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; forumLawsDismissed: boolean };
    expect(body.name).toBe('Ada');
    expect(body.forumLawsDismissed).toBe(true);
    expect((await store.getAccount('acc'))?.forumLawsDismissed).toBe(true);
  });
});

describe('POST /me/wallet-intro-seen', () => {
  it('returns 401 without a valid session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me/wallet-intro-seen', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('is false on GET /me before the first POST', async () => {
    const store = await seededStore();
    const res = await mount(store).request('/me', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { walletIntroSeen: boolean }).walletIntroSeen).toBe(false);
  });

  it('sets walletIntroSeen on first POST and logs', async () => {
    const store = await seededStore();
    const res = await mount(store).request('/me/wallet-intro-seen', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { walletIntroSeen: boolean; viewKey: string };
    expect(body.walletIntroSeen).toBe(true);
    expect(body.viewKey).toBe(VIEW_KEY);
    expect((await store.getAccount('acc'))?.walletIntroSeen).toBe(true);
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'account.wallet_intro.seen' && e['accountId'] === 'acc',
      ),
    ).toBe(true);
  });

  it('is idempotent on a second POST', async () => {
    const store = await seededStore();
    const app = mount(store);
    await app.request('/me/wallet-intro-seen', { method: 'POST', headers: AUTH });
    const before = warn.mock.calls.length;
    const res = await app.request('/me/wallet-intro-seen', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { walletIntroSeen: boolean }).walletIntroSeen).toBe(true);
    expect((await store.getAccount('acc'))?.walletIntroSeen).toBe(true);
    const seenLogs = parsedEvents(warn)
      .slice(before)
      .filter((e) => e['event'] === 'account.wallet_intro.seen');
    expect(seenLogs).toHaveLength(0);
  });

  it('includes walletIntroSeen true on GET /me after the POST', async () => {
    const store = await seededStore();
    const app = mount(store);
    await app.request('/me/wallet-intro-seen', { method: 'POST', headers: AUTH });
    const res = await app.request('/me', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { walletIntroSeen: boolean }).walletIntroSeen).toBe(true);
  });

  it('does not clear walletIntroSeen when setting a name', async () => {
    const store = await seededStore();
    const app = mount(store);
    await app.request('/me/wallet-intro-seen', { method: 'POST', headers: AUTH });
    const res = await app.request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; walletIntroSeen: boolean };
    expect(body.name).toBe('Ada');
    expect(body.walletIntroSeen).toBe(true);
    expect((await store.getAccount('acc'))?.walletIntroSeen).toBe(true);
  });

  it('does not clear walletIntroSeen when a stale snapshot is written', async () => {
    const store = await seededStore();
    const stale = await store.getAccount('acc');
    await mount(store).request('/me/wallet-intro-seen', { method: 'POST', headers: AUTH });
    await store.updateAccount({ ...stale!, name: 'Stale' });
    const stored = await store.getAccount('acc');
    expect(stored?.name).toBe('Stale');
    expect(stored?.walletIntroSeen).toBe(true);
  });
});

describe('GET /me hadExternalWallet', () => {
  it('is false when the account has no stored external payout address', async () => {
    const store = await seededStore();
    const res = await mount(store).request('/me', { headers: AUTH });
    expect(((await res.json()) as { hadExternalWallet: boolean }).hadExternalWallet).toBe(false);
  });

  it('is true when the account has a stored external payout address', async () => {
    const store = await seededStore({ hadExternalWallet: true });
    const res = await mount(store).request('/me', { headers: AUTH });
    expect(((await res.json()) as { hadExternalWallet: boolean }).hadExternalWallet).toBe(true);
  });

  it('stays true when the account is written', async () => {
    const store = await seededStore({ hadExternalWallet: true });
    const res = await mount(store).request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    expect(((await res.json()) as { hadExternalWallet: boolean }).hadExternalWallet).toBe(true);
    expect((await store.getAccount('acc'))?.hadExternalWallet).toBe(true);
  });
});

describe('POST /me/notification-level', () => {
  it('returns 401 without a valid session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me/notification-level', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('rejects a missing body', async () => {
    const res = await mount(await seededStore()).request('/me/notification-level', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with a level of all, active, mentions, or none',
    });
  });

  it('rejects an invalid level', async () => {
    const res = await mount(await seededStore()).request('/me/notification-level', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'nope' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with a level of all, active, mentions, or none',
    });
  });

  it('sets notificationLevel on first POST and logs', async () => {
    const store = await seededStore();
    const res = await mount(store).request('/me/notification-level', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'active' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notificationLevel: string };
    expect(body.notificationLevel).toBe('active');
    expect((await store.getAccount('acc'))?.notificationLevel).toBe('active');
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'account.notification_level.set' &&
          e['accountId'] === 'acc' &&
          e['level'] === 'active',
      ),
    ).toBe(true);
  });

  it('includes notificationLevel active on GET /me after POST', async () => {
    const store = await seededStore();
    const app = mount(store);
    await app.request('/me/notification-level', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'active' }),
    });
    const res = await app.request('/me', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { notificationLevel: string }).notificationLevel).toBe('active');
  });

  it('is idempotent on a second POST of the same level', async () => {
    const store = await seededStore();
    const app = mount(store);
    const headers = { ...AUTH, 'content-type': 'application/json' };
    const body = JSON.stringify({ level: 'active' });
    await app.request('/me/notification-level', { method: 'POST', headers, body });
    const res = await app.request('/me/notification-level', { method: 'POST', headers, body });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { notificationLevel: string }).notificationLevel).toBe('active');
    expect((await store.getAccount('acc'))?.notificationLevel).toBe('active');
  });

  it('rejects messages', async () => {
    const res = await mount(await seededStore()).request('/me/notification-level', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'messages' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with a level of all, active, mentions, or none',
    });
  });

  it('sets notificationLevel none and reads it back from the store', async () => {
    const store = await seededStore();
    const res = await mount(store).request('/me/notification-level', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'none' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notificationLevel: string };
    expect(body.notificationLevel).toBe('none');
    expect((await store.getAccount('acc'))?.notificationLevel).toBe('none');
  });
});

describe('POST /me/heart-notifications', () => {
  it('returns 401 without a valid session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me/heart-notifications', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('rejects a missing body', async () => {
    const res = await mount(await seededStore()).request('/me/heart-notifications', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with an enabled boolean',
    });
  });

  it('writes true and false and owner JSON shows the value', async () => {
    const store = await seededStore();
    const app = mount(store);
    const headers = { ...AUTH, 'content-type': 'application/json' };
    const off = await app.request('/me/heart-notifications', {
      method: 'POST',
      headers,
      body: JSON.stringify({ enabled: false }),
    });
    expect(off.status).toBe(200);
    expect(((await off.json()) as { notifyHearts: boolean }).notifyHearts).toBe(false);
    expect((await store.getAccount('acc'))?.notifyHearts).toBe(false);
    const on = await app.request('/me/heart-notifications', {
      method: 'POST',
      headers,
      body: JSON.stringify({ enabled: true }),
    });
    expect(on.status).toBe(200);
    expect(((await on.json()) as { notifyHearts: boolean }).notifyHearts).toBe(true);
    expect((await store.getAccount('acc'))?.notifyHearts).toBe(true);
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'account.heart_notifications.set' &&
          e['accountId'] === 'acc' &&
          e['enabled'] === false,
      ),
    ).toBe(true);
  });

  it('is idempotent on a second POST of the same value', async () => {
    const store = await seededStore();
    const app = mount(store);
    const headers = { ...AUTH, 'content-type': 'application/json' };
    const body = JSON.stringify({ enabled: false });
    await app.request('/me/heart-notifications', { method: 'POST', headers, body });
    const res = await app.request('/me/heart-notifications', { method: 'POST', headers, body });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { notifyHearts: boolean }).notifyHearts).toBe(false);
    expect((await store.getAccount('acc'))?.notifyHearts).toBe(false);
  });
});

describe('POST /me/amount-unit', () => {
  it('returns 401 without a valid session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me/amount-unit', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('rejects a missing body', async () => {
    const res = await mount(await seededStore()).request('/me/amount-unit', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with a unit of btc or fiat',
    });
  });

  it('rejects an invalid unit', async () => {
    const res = await mount(await seededStore()).request('/me/amount-unit', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ unit: 'sats' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with a unit of btc or fiat',
    });
  });

  it('sets amountUnit on first POST and logs', async () => {
    const store = await seededStore();
    const res = await mount(store).request('/me/amount-unit', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ unit: 'fiat' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { amountUnit: string };
    expect(body.amountUnit).toBe('fiat');
    expect((await store.getAccount('acc'))?.amountUnit).toBe('fiat');
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'account.amount_unit.set' &&
          e['accountId'] === 'acc' &&
          e['unit'] === 'fiat',
      ),
    ).toBe(true);
  });

  it('includes amountUnit fiat on GET /me after POST', async () => {
    const store = await seededStore();
    const app = mount(store);
    await app.request('/me/amount-unit', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ unit: 'fiat' }),
    });
    const res = await app.request('/me', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { amountUnit: string }).amountUnit).toBe('fiat');
  });

  it('is idempotent on a second POST of the same unit', async () => {
    const store = await seededStore();
    const app = mount(store);
    const headers = { ...AUTH, 'content-type': 'application/json' };
    const body = JSON.stringify({ unit: 'fiat' });
    await app.request('/me/amount-unit', { method: 'POST', headers, body });
    const res = await app.request('/me/amount-unit', { method: 'POST', headers, body });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { amountUnit: string }).amountUnit).toBe('fiat');
    expect((await store.getAccount('acc'))?.amountUnit).toBe('fiat');
  });
});

describe('POST /me/locale', () => {
  it('returns 401 without a valid session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me/locale', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('rejects a missing body', async () => {
    const res = await mount(await seededStore()).request('/me/locale', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with a locale of en, de, es, or fil',
    });
  });

  it('rejects a non-boolean onlyIfUnset', async () => {
    const store = await seededStore();
    const res = await mount(store).request('/me/locale', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ locale: 'de', onlyIfUnset: 'yes' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with a locale of en, de, es, or fil',
    });
    expect((await store.getAccount('acc'))?.locale).toBeNull();
  });

  it('sets locale on first POST and logs', async () => {
    const store = await seededStore();
    const res = await mount(store).request('/me/locale', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ locale: 'de' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { locale: string | null };
    expect(body.locale).toBe('de');
    expect((await store.getAccount('acc'))?.locale).toBe('de');
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'account.locale.set' &&
          e['accountId'] === 'acc' &&
          e['locale'] === 'de' &&
          e['onlyIfUnset'] === false &&
          e['wrote'] === true,
      ),
    ).toBe(true);
  });

  it('writes when onlyIfUnset is true and locale is still unset', async () => {
    const store = await seededStore();
    const res = await mount(store).request('/me/locale', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ locale: 'de', onlyIfUnset: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { locale: string | null };
    expect(body.locale).toBe('de');
    expect((await store.getAccount('acc'))?.locale).toBe('de');
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'account.locale.set' &&
          e['accountId'] === 'acc' &&
          e['locale'] === 'de' &&
          e['onlyIfUnset'] === true &&
          e['wrote'] === true,
      ),
    ).toBe(true);
  });

  it('keeps a stored locale when onlyIfUnset is true', async () => {
    const store = await seededStore();
    const app = mount(store);
    const headers = { ...AUTH, 'content-type': 'application/json' };
    await app.request('/me/locale', {
      method: 'POST',
      headers,
      body: JSON.stringify({ locale: 'de' }),
    });
    const res = await app.request('/me/locale', {
      method: 'POST',
      headers,
      body: JSON.stringify({ locale: 'en', onlyIfUnset: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { locale: string | null };
    expect(body.locale).toBe('de');
    expect((await store.getAccount('acc'))?.locale).toBe('de');
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'account.locale.set' &&
          e['accountId'] === 'acc' &&
          e['locale'] === 'en' &&
          e['onlyIfUnset'] === true &&
          e['wrote'] === false,
      ),
    ).toBe(true);
  });
});

describe('POST /me/fiat', () => {
  it('returns 401 without a valid session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me/fiat', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('rejects a missing body', async () => {
    const res = await mount(await seededStore()).request('/me/fiat', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with a fiat of CHF, EUR, USD, or PHP',
    });
  });

  it('rejects a non-boolean onlyIfUnset', async () => {
    const store = await seededStore();
    const res = await mount(store).request('/me/fiat', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ fiat: 'CHF', onlyIfUnset: 'yes' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with a fiat of CHF, EUR, USD, or PHP',
    });
    expect((await store.getAccount('acc'))?.fiat).toBeNull();
  });

  it('sets fiat on first POST and logs', async () => {
    const store = await seededStore();
    const res = await mount(store).request('/me/fiat', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ fiat: 'CHF' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fiat: string | null };
    expect(body.fiat).toBe('CHF');
    expect((await store.getAccount('acc'))?.fiat).toBe('CHF');
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'account.fiat.set' &&
          e['accountId'] === 'acc' &&
          e['fiat'] === 'CHF' &&
          e['onlyIfUnset'] === false &&
          e['wrote'] === true,
      ),
    ).toBe(true);
  });

  it('writes when onlyIfUnset is true and fiat is still unset', async () => {
    const store = await seededStore();
    const res = await mount(store).request('/me/fiat', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ fiat: 'CHF', onlyIfUnset: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fiat: string | null };
    expect(body.fiat).toBe('CHF');
    expect((await store.getAccount('acc'))?.fiat).toBe('CHF');
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'account.fiat.set' &&
          e['accountId'] === 'acc' &&
          e['fiat'] === 'CHF' &&
          e['onlyIfUnset'] === true &&
          e['wrote'] === true,
      ),
    ).toBe(true);
  });

  it('keeps a stored fiat when onlyIfUnset is true', async () => {
    const store = await seededStore();
    const app = mount(store);
    const headers = { ...AUTH, 'content-type': 'application/json' };
    await app.request('/me/fiat', {
      method: 'POST',
      headers,
      body: JSON.stringify({ fiat: 'CHF' }),
    });
    const res = await app.request('/me/fiat', {
      method: 'POST',
      headers,
      body: JSON.stringify({ fiat: 'EUR', onlyIfUnset: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fiat: string | null };
    expect(body.fiat).toBe('CHF');
    expect((await store.getAccount('acc'))?.fiat).toBe('CHF');
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'account.fiat.set' &&
          e['accountId'] === 'acc' &&
          e['fiat'] === 'EUR' &&
          e['onlyIfUnset'] === true &&
          e['wrote'] === false,
      ),
    ).toBe(true);
  });
});

describe('POST /me/rules-agreement', () => {
  it('returns 401 without a valid session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me/rules-agreement', {
      method: 'POST',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('records the first agreement using the injected clock', async () => {
    const store = await seededStore();
    const agreedAt = 2_000_000;
    const res = await mount(store, { clock: () => agreedAt }).request('/me/rules-agreement', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rulesAgreedAt: number | null };
    expect(body.rulesAgreedAt).toBe(agreedAt);
    expect((await store.getAccount('acc'))?.rulesAgreedAt).toBe(agreedAt);
    expect(parsedEvents(warn).some((e) => e['event'] === 'account.rules_agreement.set')).toBe(true);
  });

  it('keeps the original timestamp on later POSTs', async () => {
    const store = await seededStore();
    const first = 2_000_000;
    await mount(store, { clock: () => first }).request('/me/rules-agreement', {
      method: 'POST',
      headers: AUTH,
    });
    const res = await mount(store, { clock: () => 9_000_000 }).request('/me/rules-agreement', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ agreedAt: 9_000_000 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rulesAgreedAt: number | null };
    expect(body.rulesAgreedAt).toBe(first);
    expect((await store.getAccount('acc'))?.rulesAgreedAt).toBe(first);
    const agreeEvents = parsedEvents(warn).filter(
      (e) => e['event'] === 'account.rules_agreement.set',
    );
    expect(agreeEvents).toHaveLength(1);
  });

  it('keeps the timestamp when the name changes', async () => {
    const store = await seededStore();
    const agreedAt = 2_000_000;
    await mount(store, { clock: () => agreedAt }).request('/me/rules-agreement', {
      method: 'POST',
      headers: AUTH,
    });
    const named = await mount(store).request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    expect(named.status).toBe(200);
    expect(((await named.json()) as { rulesAgreedAt: number | null }).rulesAgreedAt).toBe(agreedAt);
    expect((await store.getAccount('acc'))?.rulesAgreedAt).toBe(agreedAt);
  });
});

describe('POST /me/name', () => {
  it('returns 401 without a valid session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me/name', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed JSON body', async () => {
    const res = await mount(await seededStore()).request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Expected a JSON body with a "name" string' });
  });

  it('rejects a body without a name string', async () => {
    const res = await mount(await seededStore()).request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Expected a JSON body with a "name" string' });
  });

  it('rejects an empty name', async () => {
    const res = await mount(await seededStore()).request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Name must be 1–80 characters' });
  });

  it('rejects an over-long name', async () => {
    const res = await mount(await seededStore()).request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'A'.repeat(81) }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Name must be 1–80 characters' });
  });

  it('rejects a name with a newline', async () => {
    const res = await mount(await seededStore()).request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada\nLovelace' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Name must be 1–80 characters' });
  });

  it('trims, stores, and returns the name without a profile note when no wallet is verified', async () => {
    const store = await seededStore();
    const messages = new InMemoryMessageStore();
    const res = await mount(store, { messages }).request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  Ada  ' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string | null; viewKey: string };
    expect(body.name).toBe('Ada');
    expect(body.viewKey).toBe(VIEW_KEY);
    expect(body).not.toHaveProperty('profileMessageId');
    const stored = await store.getAccount('acc');
    expect(stored?.name).toBe('Ada');
    expect(stored?.profileMessageId).toBeUndefined();
    expect(await messages.listLatest(10)).toHaveLength(0);
    expect(
      parsedEvents(warn).some((e) => e['event'] === 'account.name.set' && e['accountId'] === 'acc'),
    ).toBe(true);
  });

  it('creates a profile note when setting a name with a verified wallet', async () => {
    const store = await seededStore({ wallet: true });
    const messages = new InMemoryMessageStore();
    const res = await mount(store, { messages }).request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    expect(res.status).toBe(200);
    const stored = await store.getAccount('acc');
    expect(typeof stored?.profileMessageId).toBe('string');
    const note = await messages.getById(stored!.profileMessageId!);
    expect(note?.text).toBe('Ada');
    expect(note?.parentId).toBeNull();
  });

  it('does not enqueue forum pushes when a name is set with a verified wallet', async () => {
    const store = await seededStore({ wallet: true });
    const messages = new InMemoryMessageStore();
    const pushStore = new InMemoryPushStore();
    await pushStore.upsertSubscription({
      accountId: 'other',
      endpoint: 'https://push.example/1',
      p256dh: 'p',
      auth: 'a',
      createdAt: new Date(now()),
      sessionToken: null,
    });
    const res = await mount(store, {
      messages,
      pushStore,
      notificationStore: new InMemoryNotificationStore(),
    }).request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    expect(res.status).toBe(200);
    const pending = await pushStore.claimPending(10, now(), 60_000);
    expect(pending.some((row) => row.type === 'forum')).toBe(false);
  });

  it('does not create a second profile note or change its text on rename', async () => {
    const store = await seededStore({ wallet: true });
    const messages = new InMemoryMessageStore();
    const first = await mount(store, { messages }).request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    expect(first.status).toBe(200);
    const profileId = (await store.getAccount('acc'))?.profileMessageId;
    expect(typeof profileId).toBe('string');
    const second = await mount(store, { messages }).request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada Lovelace' }),
    });
    expect(second.status).toBe(200);
    expect((await store.getAccount('acc'))?.profileMessageId).toBe(profileId);
    expect((await messages.getById(profileId!))?.text).toBe('Ada');
    expect((await messages.listLatest(10)).filter((row) => row.parentId === null)).toHaveLength(1);
  });

  it('keeps the wallet receiving address when setting a name', async () => {
    const store = await seededStore({ wallet: true });
    const res = await mount(store, { walletEnabled: true }).request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string | null; lightningAddress: string | null };
    expect(body.name).toBe('Ada');
    expect(body.lightningAddress).toBe(ADDRESS);
  });

  it('replaces an existing name', async () => {
    const store = await seededStore();
    const existing = await store.getAccount('acc');
    expect(existing).toBeDefined();
    if (existing === undefined) {
      return;
    }
    await store.updateAccount({ ...existing, name: 'Ada' });
    const res = await mount(store).request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bob' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe('Bob');
    expect((await store.getAccount('acc'))?.name).toBe('Bob');
  });

  it('auto-assigns a free username from the display name', async () => {
    const store = await seededStore();
    const res = await mount(store).request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada Lovelace' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { username: string | null; setup: string };
    expect(body.username).toBe('ada-lovelace');
    expect(body.setup).toBe('lightning-address');
  });

  it('leaves username unset when the derived handle is taken', async () => {
    const store = await seededStore();
    await store.createAccount({
      id: 'other',
      linkingKey: null,
      role: 'basis',
      name: 'Other',
      username: 'ada',
      location: null,
      forumLawsDismissed: false,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const res = await mount(store).request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string | null;
      username: string | null;
      setup: string;
    };
    expect(body.name).toBe('Ada');
    expect(body.username).toBeNull();
    expect(body.setup).toBe('username');
    expect((await store.getAccount('acc'))?.name).toBe('Ada');
    expect((await store.getAccount('acc'))?.username ?? null).toBeNull();
  });

  it('keeps the display name when a uniqueness race no-ops the username write', async () => {
    const store = await seededStore();
    await store.createAccount({
      id: 'other',
      linkingKey: null,
      role: 'basis',
      name: 'Other',
      username: 'ada',
      location: null,
      forumLawsDismissed: false,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const applyUpdate = store.updateAccount.bind(store);
    vi.spyOn(store, 'getAccountByUsername').mockResolvedValue(undefined);
    vi.spyOn(store, 'updateAccount').mockImplementation(async (account: Account) => {
      const handle = account.username;
      if (handle !== null && handle !== undefined && handle.trim() !== '') {
        return;
      }
      await applyUpdate(account);
    });
    const res = await mount(store).request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string | null;
      username: string | null;
      setup: string;
    };
    expect(body.name).toBe('Ada');
    expect(body.username).toBeNull();
    expect(body.setup).toBe('username');
    expect((await store.getAccount('acc'))?.name).toBe('Ada');
    expect((await store.getAccount('acc'))?.username ?? null).toBeNull();
  });

  it('does not overwrite a handle stored after the free-check', async () => {
    const store = await seededStore();
    let afterLookup = false;
    vi.spyOn(store, 'getAccountByUsername').mockImplementation(async () => {
      afterLookup = true;
      return undefined;
    });
    const realGet = store.getAccount.bind(store);
    vi.spyOn(store, 'getAccount').mockImplementation(async (id: string) => {
      const row = await realGet(id);
      if (afterLookup && row !== undefined) {
        return { ...row, username: 'manual' };
      }
      return row;
    });
    const res = await mount(store).request('/me/name', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { username: string | null };
    expect(body.username).toBe('manual');
  });
});

describe('POST /me/username', () => {
  it('returns 401 without a valid session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me/username', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ada' }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 400 without a username string', async () => {
    const res = await mount(await seededStore()).request('/me/username', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with a "username" string',
    });
  });

  it('returns 400 for an invalid username', async () => {
    const res = await mount(await seededStore()).request('/me/username', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'Ada Lovelace' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Username must be 1–32 characters of a-z, 0-9, hyphen, underscore, or dot',
    });
  });

  it('sets a username and logs', async () => {
    const store = await seededStore();
    const res = await mount(store).request('/me/username', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'Ada' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { username: string };
    expect(body.username).toBe('ada');
    expect((await store.getAccount('acc'))?.username).toBe('ada');
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'account.username.set' && e['accountId'] === 'acc',
      ),
    ).toBe(true);
  });

  it('returns 409 when another account owns the username', async () => {
    const store = await seededStore();
    await store.createAccount({
      id: 'other',
      linkingKey: null,
      role: 'basis',
      name: 'Other',
      username: 'ada',
      location: null,
      forumLawsDismissed: false,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const res = await mount(store).request('/me/username', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ada' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Username is already in use' });
  });

  it('allows keeping the same username', async () => {
    const store = await seededStore();
    const existing = await store.getAccount('acc');
    await store.updateAccount({ ...existing!, username: 'ada' });
    const res = await mount(store).request('/me/username', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ada' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { username: string }).username).toBe('ada');
  });

  it('returns 409 once the wallet is connected', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: LINKING_KEY,
      role: 'basis',
      name: 'Ada',
      username: 'ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: VIEW_KEY,
      createdAt: 1_000_000,
      rulesAgreedAt: null,
      walletRequired: true,
    });
    await store.createSession({ token: 'tok', accountId: 'acc', createdAt: 1_000_000 });
    await store.claimSparkPubkey('acc', SPARK_PUBKEY);
    await store.markSparkPubkeyVerified('acc', SPARK_PUBKEY, 'ada', 1_000_000);
    const res = await mount(store).request('/me/username', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ada2' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Username is fixed once the wallet is connected',
    });
  });

  it('returns 409 when setUsername reports the username taken after the pre-check', async () => {
    const store = await seededStore();
    vi.spyOn(store, 'getAccountByUsername').mockResolvedValue(undefined);
    vi.spyOn(store, 'setUsername').mockResolvedValue({ ok: false, reason: 'taken' });
    const res = await mount(store).request('/me/username', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ada' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Username is already in use' });
  });

  it('returns 409 when setUsername reports the username frozen after the pre-check', async () => {
    const store = await seededStore();
    vi.spyOn(store, 'setUsername').mockResolvedValue({ ok: false, reason: 'frozen' });
    const res = await mount(store).request('/me/username', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ada' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Username is fixed once the wallet is connected',
    });
  });

  it('returns 401 when setUsername reports the account missing after auth', async () => {
    const store = await seededStore();
    vi.spyOn(store, 'setUsername').mockResolvedValue({ ok: false, reason: 'missing' });
    const res = await mount(store).request('/me/username', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ada' }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });
});

describe('PUT /me/wallet', () => {
  async function walletReadyStore(
    overrides: { username?: string | null; walletRequired?: boolean } = {},
  ): Promise<InMemoryAuthStore> {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: LINKING_KEY,
      role: 'basis',
      name: 'Ada',
      username: overrides.username === undefined ? 'ada' : overrides.username,
      forumLawsDismissed: false,
      location: null,
      viewKey: VIEW_KEY,
      createdAt: 1_000_000,
      rulesAgreedAt: null,
      walletRequired: overrides.walletRequired ?? true,
    });
    await store.createSession({ token: 'tok', accountId: 'acc', createdAt: 1_000_000 });
    return store;
  }

  it('returns 404 when walletEnabled is not true', async () => {
    const store = await walletReadyStore();
    const res = await mount(store).request('/me/wallet', {
      method: 'PUT',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sparkPubkey: SPARK_PUBKEY }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 401 without a valid session', async () => {
    const res = await mount(await walletReadyStore(), { walletEnabled: true }).request(
      '/me/wallet',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sparkPubkey: SPARK_PUBKEY }),
      },
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 400 for bad JSON, a missing field, or a bad key', async () => {
    const store = await walletReadyStore();
    const app = mount(store, { walletEnabled: true });
    for (const body of ['{', '{}', JSON.stringify({ sparkPubkey: 'nope' })]) {
      const res = await app.request('/me/wallet', {
        method: 'PUT',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Expected a JSON body with a "sparkPubkey" of 66 hex characters',
      });
    }
  });

  it('returns 409 when the username is missing', async () => {
    const store = await walletReadyStore({ username: null });
    const res = await mount(store, { walletEnabled: true }).request('/me/wallet', {
      method: 'PUT',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sparkPubkey: SPARK_PUBKEY }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'missing_requirements',
      missing: ['username'],
    });
  });

  it('returns 409 when walletRequired is not true', async () => {
    const store = await walletReadyStore({ walletRequired: false });
    const res = await mount(store, { walletEnabled: true }).request('/me/wallet', {
      method: 'PUT',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sparkPubkey: SPARK_PUBKEY }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Wallet is not set up' });
  });

  it('claims the key, overwrites while unverified, and returns owner JSON', async () => {
    const store = await walletReadyStore();
    const app = mount(store, { walletEnabled: true });
    const first = await app.request('/me/wallet', {
      method: 'PUT',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sparkPubkey: SPARK_PUBKEY }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      sparkPubkey: string | null;
      sparkWalletVerified: boolean;
    };
    expect(firstBody.sparkPubkey).toBe(SPARK_PUBKEY);
    expect(firstBody.sparkWalletVerified).toBe(false);
    expect((await store.getAccount('acc'))?.sparkPubkey).toBe(SPARK_PUBKEY);
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'account.wallet.claimed' && e['accountId'] === 'acc',
      ),
    ).toBe(true);

    const second = await app.request('/me/wallet', {
      method: 'PUT',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sparkPubkey: SPARK_PUBKEY_OTHER }),
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { sparkPubkey: string }).sparkPubkey).toBe(SPARK_PUBKEY_OTHER);
    expect((await store.getAccount('acc'))?.sparkPubkey).toBe(SPARK_PUBKEY_OTHER);
  });

  it('returns 409 once the wallet is verified', async () => {
    const store = await walletReadyStore();
    await store.claimSparkPubkey('acc', SPARK_PUBKEY);
    await store.markSparkPubkeyVerified('acc', SPARK_PUBKEY, 'ada', 1_000_000);
    const res = await mount(store, { walletEnabled: true }).request('/me/wallet', {
      method: 'PUT',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sparkPubkey: SPARK_PUBKEY_OTHER }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Wallet is already connected' });
  });
});

describe('POST /me/location', () => {
  it('returns 401 without a valid session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/me/location', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ location: 'Berlin' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed JSON body', async () => {
    const res = await mount(await seededStore()).request('/me/location', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Expected a JSON body with a "location" string' });
  });

  it('rejects a body without a location string', async () => {
    const res = await mount(await seededStore()).request('/me/location', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Expected a JSON body with a "location" string' });
  });

  it('rejects an over-long location', async () => {
    const res = await mount(await seededStore()).request('/me/location', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ location: 'A'.repeat(81) }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Location must be at most 80 characters' });
  });

  it('rejects a location with a newline', async () => {
    const res = await mount(await seededStore()).request('/me/location', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ location: 'Berlin\nDE' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Location must be at most 80 characters' });
  });

  it('trims, stores, and returns the location', async () => {
    const store = await seededStore();
    const res = await mount(store).request('/me/location', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ location: '  Berlin  ' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { location: string | null; viewKey: string };
    expect(body.location).toBe('Berlin');
    expect(body.viewKey).toBe(VIEW_KEY);
    expect((await store.getAccount('acc'))?.location).toBe('Berlin');
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'account.location.set' && e['accountId'] === 'acc',
      ),
    ).toBe(true);
  });

  it('clears an empty location to null', async () => {
    const store = await seededStore();
    const existing = await store.getAccount('acc');
    expect(existing).toBeDefined();
    if (existing === undefined) {
      return;
    }
    await store.updateAccount({ ...existing, location: 'Berlin' });
    const res = await mount(store).request('/me/location', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ location: '   ' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { location: string | null }).location).toBeNull();
    expect((await store.getAccount('acc'))?.location).toBeNull();
  });

  it('clears an empty-string location to null', async () => {
    const store = await seededStore();
    const existing = await store.getAccount('acc');
    expect(existing).toBeDefined();
    if (existing === undefined) {
      return;
    }
    await store.updateAccount({ ...existing, location: 'Berlin' });
    const res = await mount(store).request('/me/location', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ location: '' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { location: string | null }).location).toBeNull();
    expect((await store.getAccount('acc'))?.location).toBeNull();
  });
});

describe('receiving wallet on owner JSON', () => {
  it('shows the wallet address and clears the posting requirement only once verified', async () => {
    const store = await seededStore({ wallet: true });
    const res = await mount(store, { walletEnabled: true }).request('/me', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lightningAddress: string | null;
      lightningAddressVerified: boolean;
      setup: string | null;
      missing: string[];
    };
    expect(body.lightningAddress).toBe(ADDRESS);
    expect(body.lightningAddressVerified).toBe(true);
    expect(body.missing).not.toContain('lightning-address');
    expect(body.setup).not.toBe('lightning-address');

    const off = (await (await mount(store).request('/me', { headers: AUTH })).json()) as {
      lightningAddress: string | null;
      lightningAddressVerified: boolean;
    };
    expect(off.lightningAddress).toBeNull();
    expect(off.lightningAddressVerified).toBe(false);
  });

  it('keeps lightning-address missing after the wallet step is skipped', async () => {
    const store = await seededStore();
    const existing = await store.getAccount('acc');
    await store.updateAccount({ ...existing!, name: 'Ada', username: 'ada', rulesAgreedAt: 1 });
    const before = (await (await mount(store).request('/me', { headers: AUTH })).json()) as {
      setup: string | null;
      missing: string[];
    };
    expect(before.setup).toBe('lightning-address');
    expect(before.missing).toEqual(['lightning-address']);
    const skipped = await mount(store).request('/me/setup/skip', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ step: 'lightning-address' }),
    });
    const body = (await skipped.json()) as { setup: string | null; missing: string[] };
    expect(body.setup).toBeNull();
    expect(body.missing).toEqual(['lightning-address']);
  });
});

describe('removed external address routes', () => {
  it('answers 404 for linking, removing, and verifying an external address', async () => {
    const store = await seededStore();
    const app = mount(store, { walletEnabled: true });
    const headers = { ...AUTH, 'content-type': 'application/json' };
    const requests: Array<[string, string, unknown]> = [
      ['POST', '/me/lightning-address', { address: 'alice@example.com' }],
      ['DELETE', '/me/lightning-address', undefined],
      ['POST', '/me/lightning-address/verification', {}],
      ['POST', '/me/lightning-address/verification/confirm', { nonce: 'a'.repeat(32) }],
    ];
    for (const [method, path, body] of requests) {
      const res = await app.request(path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });
});

describe('bearerToken', () => {
  it('returns null for a missing header', async () => {
    expect(bearerToken(undefined)).toBeNull();
  });

  it('returns null for a non-Bearer scheme', async () => {
    expect(bearerToken('Basic abc')).toBeNull();
  });

  it('returns null for an empty token', async () => {
    expect(bearerToken('Bearer ')).toBeNull();
  });

  it('returns null for a whitespace-only token', async () => {
    expect(bearerToken('Bearer    ')).toBeNull();
  });

  it('extracts a present token', async () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123');
  });
});

/** A 20-word share of a 16-byte secret, from the official SLIP-39 test vectors (vector 1). */
const RECOVERY_SHARE =
  'duckling enlarge academic academic agency result length solution fridge kidney ' +
  'coal piece deal husband erode duke ajar critical decision keyboard';
const SHARE_KEK = new Uint8Array(32).fill(0xcd);
/** A day the grant gate is in force. */
const GATE_NOW = Date.parse('2026-10-29T12:00:00.000Z');
const gateClock = (): number => GATE_NOW;
const MEMBER_PHOTO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** Open a share envelope in the test only; the api has no decrypt function. */
async function openShare(envelope: Uint8Array, accountId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', SHARE_KEK, { name: 'AES-GCM' }, false, [
    'decrypt',
  ]);
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: envelope.subarray(5, 17),
      additionalData: new TextEncoder().encode(accountId),
    },
    key,
    envelope.subarray(17),
  );
  return new TextDecoder().decode(plain);
}

/** Verified member `acc` (`alice`) signed in at {@link GATE_NOW}, optionally unverified. */
async function memberStore(
  options: { role?: Account['role']; verified?: boolean } = {},
): Promise<InMemoryAuthStore> {
  const store = new InMemoryAuthStore();
  await store.createAccount({
    id: 'acc',
    linkingKey: null,
    role: options.role ?? 'verified',
    name: 'Alice',
    username: 'alice',
    forumLawsDismissed: false,
    location: null,
    viewKey: VIEW_KEY,
    createdAt: 1,
    rulesAgreedAt: 1,
    walletRequired: true,
  });
  await store.claimSparkPubkey('acc', WALLET_PUBKEY);
  if (options.verified !== false) {
    await store.markSparkPubkeyVerified('acc', WALLET_PUBKEY, 'alice', 2);
  }
  await store.createSession({ token: 'tok', accountId: 'acc', createdAt: GATE_NOW });
  return store;
}

function admitted(accountId = 'acc'): InMemoryFundingStore {
  return new InMemoryFundingStore([
    {
      accountId,
      status: 'admitted',
      appliedAt: 1,
      decidedAt: 2,
      decidedBy: 'staff',
      trialUtcDate: null,
      admittedAt: 2,
      note: null,
    },
  ]);
}

/** A message store with the member's photo post of {@link GATE_NOW}. */
async function todayPhoto(): Promise<InMemoryMessageStore> {
  const messages = new InMemoryMessageStore();
  await messages.create(
    {
      id: MEMBER_PHOTO,
      accountId: 'acc',
      name: 'Alice',
      text: 'today',
      createdAt: new Date(GATE_NOW),
      hasPhoto: true,
      ...unsignedNostrDefaults(),
    },
    { contentType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) },
  );
  return messages;
}

function putShare(
  app: Hono,
  body: unknown,
  headers: Record<string, string> = AUTH,
): Promise<Response> {
  return Promise.resolve(
    app.request('/me/recovery-share', {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

describe('PUT /me/recovery-share', () => {
  const body = { sparkPubkey: WALLET_PUBKEY, share: RECOVERY_SHARE };

  it('is not mounted without the LNURL server', async () => {
    const res = await putShare(
      mount(await memberStore(), { clock: gateClock, recoveryShareKek: SHARE_KEK }),
      body,
    );
    expect(res.status).toBe(404);
  });

  it('returns 401 without a valid session, before the key check', async () => {
    const app = mount(await memberStore(), { clock: gateClock, walletEnabled: true });
    for (const headers of [{}, { authorization: 'Bearer nope' }]) {
      const res = await putShare(app, body, headers);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
    }
  });

  it('returns 503 without RECOVERY_SHARE_KEK (memory boot)', async () => {
    const store = await memberStore();
    const res = await putShare(mount(store, { clock: gateClock, walletEnabled: true }), body);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Social recovery is unavailable' });
    expect(await store.hasRecoveryShareForVerifiedWallet('acc')).toBe(false);
  });

  it('returns 400 for a bad body, key, or share', async () => {
    const app = mount(await memberStore(), {
      clock: gateClock,
      walletEnabled: true,
      recoveryShareKek: SHARE_KEK,
    });
    for (const bad of [
      '{',
      'null',
      {},
      { sparkPubkey: WALLET_PUBKEY },
      { share: RECOVERY_SHARE },
      { ...body, extra: true },
      { ...body, sparkPubkey: 'nope' },
      { ...body, share: 42 },
      { ...body, share: RECOVERY_SHARE.split(' ').slice(0, 19).join(' ') },
      { ...body, share: RECOVERY_SHARE.toUpperCase() },
      { ...body, share: `${RECOVERY_SHARE} ` },
    ]) {
      const res = await putShare(app, bad);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Expected a JSON body with sparkPubkey and a recovery share',
      });
    }
  });

  it('returns 409 while the wallet is not verified', async () => {
    const store = await memberStore({ verified: false });
    const put = vi.spyOn(store, 'putRecoveryShare');
    const res = await putShare(
      mount(store, { clock: gateClock, walletEnabled: true, recoveryShareKek: SHARE_KEK }),
      body,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Wallet is not connected' });
    expect(put).not.toHaveBeenCalled();
  });

  it('returns 409 when the key is not the verified wallet key', async () => {
    const store = await memberStore();
    const put = vi.spyOn(store, 'putRecoveryShare');
    const res = await putShare(
      mount(store, { clock: gateClock, walletEnabled: true, recoveryShareKek: SHARE_KEK }),
      { ...body, sparkPubkey: SPARK_PUBKEY_OTHER },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Wallet changed' });
    expect(put).not.toHaveBeenCalled();
  });

  it('accepts the key in upper case', async () => {
    const res = await putShare(
      mount(await memberStore(), {
        clock: gateClock,
        walletEnabled: true,
        recoveryShareKek: SHARE_KEK,
      }),
      { ...body, sparkPubkey: WALLET_PUBKEY.toUpperCase() },
    );
    expect(res.status).toBe(200);
  });

  it('returns 409 when the wallet changes before the locked write', async () => {
    const store = await memberStore();
    vi.spyOn(store, 'putRecoveryShare').mockResolvedValue('changed');
    const res = await putShare(
      mount(store, { clock: gateClock, walletEnabled: true, recoveryShareKek: SHARE_KEK }),
      body,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Wallet changed' });
    expect(parsedEvents(warn).map((e) => e['event'])).not.toContain(
      'account.recovery_share.stored',
    );
  });

  it('stores the encrypted share, answers owner JSON, and replaces it in one row', async () => {
    const store = await memberStore();
    const put = vi.spyOn(store, 'putRecoveryShare');
    const app = mount(store, {
      clock: gateClock,
      walletEnabled: true,
      recoveryShareKek: SHARE_KEK,
    });
    const first = await putShare(app, body);
    expect(first.status).toBe(200);
    const json = (await first.json()) as Record<string, unknown>;
    expect(json['id']).toBe('acc');
    expect(json['sparkPubkey']).toBe(WALLET_PUBKEY);
    expect(json['socialRecoverySetUp']).toBe(true);
    expect(put).toHaveBeenCalledTimes(1);
    const input = put.mock.calls[0]![0];
    expect(input).toMatchObject({ accountId: 'acc', sparkPubkey: WALLET_PUBKEY, now: GATE_NOW });
    expect(await openShare(input.ciphertext, 'acc')).toBe(RECOVERY_SHARE);
    await expect(openShare(input.ciphertext, 'other')).rejects.toThrow();
    expect(await put.mock.results[0]!.value).toBe('stored');

    const second = await putShare(app, body);
    expect(second.status).toBe(200);
    expect(((await second.json()) as Record<string, unknown>)['socialRecoverySetUp']).toBe(true);
    expect(await put.mock.results[1]!.value).toBe('replaced');
    expect(await store.hasRecoveryShareForVerifiedWallet('acc')).toBe(true);

    const stored = parsedEvents(warn).filter((e) => e['event'] === 'account.recovery_share.stored');
    expect(stored.map((e) => [e['accountId'], e['replaced']])).toEqual([
      ['acc', false],
      ['acc', true],
    ]);
    const output = warn.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(output).not.toContain('duckling');
  });

  it('returns 503 when encryption or the store fails', async () => {
    const shortKek = await memberStore();
    const res = await putShare(
      mount(shortKek, {
        clock: gateClock,
        walletEnabled: true,
        recoveryShareKek: new Uint8Array(31),
      }),
      body,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Social recovery is unavailable' });
    expect(await shortKek.hasRecoveryShareForVerifiedWallet('acc')).toBe(false);

    const failing = await memberStore();
    vi.spyOn(failing, 'putRecoveryShare').mockRejectedValue(
      Object.assign(new Error('duplicate key value'), { code: '23505' }),
    );
    const stored = await putShare(
      mount(failing, { clock: gateClock, walletEnabled: true, recoveryShareKek: SHARE_KEK }),
      body,
    );
    expect(stored.status).toBe(503);
    expect(await stored.json()).toEqual({ error: 'Social recovery is unavailable' });
    const failed = parsedEvents(warn).filter((e) => e['event'] === 'account.recovery_share.failed');
    expect(failed).toHaveLength(2);
    expect(failed[1]).toMatchObject({ accountId: 'acc', name: 'Error', code: '23505' });
    expect(JSON.stringify(failed)).not.toContain('duplicate key value');
  });

  describe('daily ping after the first share', () => {
    it("pings today's media post of an eligible member without reading the share again", async () => {
      const store = await memberStore();
      const shareReads = vi.spyOn(store, 'hasRecoveryShareForVerifiedWallet');
      let readsDuringPing = -1;
      const ping = vi.fn(async () => {
        readsDuringPing = shareReads.mock.calls.length;
      });
      const res = await putShare(
        mount(store, {
          clock: gateClock,
          walletEnabled: true,
          recoveryShareKek: SHARE_KEK,
          fundingStore: admitted(),
          messages: await todayPhoto(),
          spendPing: { ping },
        }),
        body,
      );
      expect(res.status).toBe(200);
      expect(ping).toHaveBeenCalledTimes(1);
      expect(ping).toHaveBeenCalledWith('alice@example.test', MEMBER_PHOTO, 'daily', 'admitted');
      expect(readsDuringPing).toBe(0);
    });

    it('does not ping on a replacement', async () => {
      const store = await memberStore();
      const ping = vi.fn(async () => undefined);
      const app = mount(store, {
        clock: gateClock,
        walletEnabled: true,
        recoveryShareKek: SHARE_KEK,
        fundingStore: admitted(),
        messages: await todayPhoto(),
        spendPing: { ping },
      });
      expect((await putShare(app, body)).status).toBe(200);
      expect((await putShare(app, body)).status).toBe(200);
      expect(ping).toHaveBeenCalledTimes(1);
    });

    it('does not ping a member outside the grant program or a basis account', async () => {
      const ping = vi.fn(async () => undefined);
      for (const [store, fundingStore] of [
        [await memberStore(), new InMemoryFundingStore()],
        [await memberStore({ role: 'basis' }), admitted()],
      ] as const) {
        const getGrant = vi.spyOn(fundingStore, 'getByAccountId');
        const res = await putShare(
          mount(store, {
            clock: gateClock,
            walletEnabled: true,
            recoveryShareKek: SHARE_KEK,
            fundingStore,
            messages: await todayPhoto(),
            spendPing: { ping },
          }),
          body,
        );
        expect(res.status).toBe(200);
        expect(getGrant).toHaveBeenCalledWith('acc');
      }
      // Without a funding store there is no grant, so no one is in the program.
      const noGrants = await putShare(
        mount(await memberStore(), {
          clock: gateClock,
          walletEnabled: true,
          recoveryShareKek: SHARE_KEK,
          messages: await todayPhoto(),
          spendPing: { ping },
        }),
        body,
      );
      expect(noGrants.status).toBe(200);
      expect(ping).not.toHaveBeenCalled();
    });

    it('still answers 200 when the grant read or the ping fails', async () => {
      // The ping's grant read fails; the owner JSON read after it succeeds.
      const grantDown = admitted();
      vi.spyOn(grantDown, 'getByAccountId').mockRejectedValueOnce(new Error('grant down'));
      const pingDown = vi.fn(async () => {
        throw new Error('ping down');
      });
      for (const [fundingStore, ping] of [
        [grantDown, vi.fn(async () => undefined)],
        [admitted(), pingDown],
      ] as const) {
        const res = await putShare(
          mount(await memberStore(), {
            clock: gateClock,
            walletEnabled: true,
            recoveryShareKek: SHARE_KEK,
            fundingStore,
            messages: await todayPhoto(),
            spendPing: { ping },
          }),
          body,
        );
        expect(res.status).toBe(200);
        expect(((await res.json()) as Record<string, unknown>)['socialRecoverySetUp']).toBe(true);
      }
      expect(pingDown).toHaveBeenCalledTimes(1);
      const failed = parsedEvents(warn).filter((e) => e['event'] === 'funding.daily_ping.failed');
      expect(failed.map((e) => e['accountId'])).toEqual(['acc', 'acc']);
    });
  });
});

/** The pinned account after one committed recovery: OLD is its previous wallet. */
async function recoveredStore(): Promise<InMemoryAuthStore> {
  const store = new InMemoryAuthStore();
  await seedPinnedAccount(store);
  await store.putRecoveryShare({
    accountId: PINNED.accountId,
    sparkPubkey: PINNED.oldSparkPubkey,
    ciphertext: Uint8Array.of(1),
    now: 1,
  });
  await stagePendingRecovery(store, { createdAt: GATE_NOW - 2, forwardedAt: GATE_NOW - 1 });
  expect(
    await store.commitRecovery({
      accountId: PINNED.accountId,
      newSparkPubkey: PINNED.newSparkPubkey,
      now: GATE_NOW,
    }),
  ).toBe('committed');
  await store.createSession({ token: 'tok', accountId: PINNED.accountId, createdAt: GATE_NOW });
  return store;
}

/** Fake explorer: answers the soft balance per address, or the given failure. */
function explorer(answer: (address: string) => Response | Error): {
  fetchImpl: FetchFn;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: FetchFn = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    const address = decodeURIComponent(url.split('/v1/address/')[1]!.split('?')[0]!);
    const result = answer(address);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };
  return { fetchImpl, calls };
}

describe('GET /me/previous-wallets', () => {
  it('is not mounted without the LNURL server', async () => {
    const res = await mount(await recoveredStore(), { clock: gateClock }).request(
      '/me/previous-wallets',
      { headers: AUTH },
    );
    expect(res.status).toBe(404);
  });

  it('returns 401 without a valid session', async () => {
    const res = await mount(await recoveredStore(), {
      clock: gateClock,
      walletEnabled: true,
    }).request('/me/previous-wallets');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('lists the previous wallets with the explorer soft balance, read anonymously', async () => {
    const store = await recoveredStore();
    const [wallet] = await store.listPreviousWallets(PINNED.accountId);
    const { fetchImpl, calls } = explorer(() =>
      Response.json({ balance: { btcSoftBalanceSats: 1234, btcHardBalanceSats: 1000 } }),
    );
    const res = await mount(store, { clock: gateClock, walletEnabled: true, fetchImpl }).request(
      '/me/previous-wallets',
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      wallets: [
        {
          sparkPubkey: PINNED.oldSparkPubkey,
          sparkAddress: wallet!.sparkAddress,
          replacedAt: GATE_NOW,
          balanceSats: 1234,
        },
      ],
    });
    expect(wallet!.sparkAddress.startsWith('spark1')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `${SPARK_EXPLORER_BASE_URL}/v1/address/${wallet!.sparkAddress}?network=MAINNET`,
    );
    expect(new Headers(calls[0]!.init?.headers).has('authorization')).toBe(false);
  });

  it('answers null for an unknown balance and an empty list without previous wallets', async () => {
    const store = await recoveredStore();
    const { fetchImpl } = explorer(() => new TypeError('fetch failed'));
    const res = await mount(store, { clock: gateClock, walletEnabled: true, fetchImpl }).request(
      '/me/previous-wallets',
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { wallets: Array<{ balanceSats: number | null }> };
    expect(json.wallets.map((w) => w.balanceSats)).toEqual([null]);

    const fresh = await memberStore();
    const empty = explorer(() => new Error('never called'));
    const none = await mount(fresh, {
      clock: gateClock,
      walletEnabled: true,
      fetchImpl: empty.fetchImpl,
    }).request('/me/previous-wallets', { headers: AUTH });
    expect(await none.json()).toEqual({ wallets: [] });
    expect(empty.calls).toEqual([]);
  });

  it('returns 503 when the store fails', async () => {
    const store = await recoveredStore();
    vi.spyOn(store, 'listPreviousWallets').mockRejectedValue(new Error('db down'));
    const { fetchImpl, calls } = explorer(() => Response.json({}));
    const res = await mount(store, { clock: gateClock, walletEnabled: true, fetchImpl }).request(
      '/me/previous-wallets',
      { headers: AUTH },
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Wallet data is unavailable' });
    expect(calls).toEqual([]);
    expect(parsedEvents(warn)).toContainEqual(
      expect.objectContaining({
        event: 'account.previous_wallets.failed',
        accountId: PINNED.accountId,
      }),
    );
  });
});

describe('DELETE /me/previous-wallets/:sparkPubkey', () => {
  function drop(app: Hono, key: string, headers: Record<string, string> = AUTH): Promise<Response> {
    return Promise.resolve(
      app.request(`/me/previous-wallets/${key}`, { method: 'DELETE', headers }),
    );
  }

  it('is not mounted without the LNURL server', async () => {
    const res = await drop(
      mount(await recoveredStore(), { clock: gateClock }),
      PINNED.oldSparkPubkey,
    );
    expect(res.status).toBe(404);
  });

  it('returns 401 without a valid session', async () => {
    const res = await drop(
      mount(await recoveredStore(), { clock: gateClock, walletEnabled: true }),
      PINNED.oldSparkPubkey,
      {},
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 404 for a bad key or a key that is not a previous wallet', async () => {
    const store = await recoveredStore();
    const app = mount(store, { clock: gateClock, walletEnabled: true });
    for (const key of ['nope', PINNED.newSparkPubkey, SPARK_PUBKEY_OTHER]) {
      const res = await drop(app, key);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    }
    expect(await store.listPreviousWallets(PINNED.accountId)).toHaveLength(1);
  });

  it('drops the previous wallet and its share, then answers 404', async () => {
    const store = await recoveredStore();
    const app = mount(store, { clock: gateClock, walletEnabled: true });
    const res = await drop(app, PINNED.oldSparkPubkey.toUpperCase());
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(await store.listPreviousWallets(PINNED.accountId)).toEqual([]);
    expect(parsedEvents(warn)).toContainEqual(
      expect.objectContaining({
        event: 'account.previous_wallet.dropped',
        accountId: PINNED.accountId,
      }),
    );
    expect((await drop(app, PINNED.oldSparkPubkey)).status).toBe(404);

    // Recover back to the old key: its share went with the previous wallet.
    const challengeId = 'd'.repeat(64);
    expect(
      await store.startRecoveryChallenge({
        accountId: PINNED.accountId,
        oldSparkPubkey: PINNED.newSparkPubkey,
        challenge: {
          id: challengeId,
          type: 'recovery',
          challenge: 'back',
          accountId: PINNED.accountId,
          consumed: false,
          createdAt: GATE_NOW,
        },
        now: GATE_NOW,
      }),
    ).toBe('started');
    expect(
      await store.storePendingRecovery({
        challengeId,
        pending: {
          accountId: PINNED.accountId,
          oldSparkPubkey: PINNED.newSparkPubkey,
          newSparkPubkey: PINNED.oldSparkPubkey,
          credentialId: 'back-credential',
          publicKey: Uint8Array.of(7),
          signCount: 0,
          createdAt: GATE_NOW,
          forwardedAt: null,
        },
        now: GATE_NOW,
      }),
    ).toBe('stored');
    await store.markRecoveryForwarded({
      newSparkPubkey: PINNED.oldSparkPubkey,
      oldSparkPubkey: PINNED.newSparkPubkey,
      username: RECOVERY_USERNAME,
      now: GATE_NOW,
    });
    expect(
      await store.commitRecovery({
        accountId: PINNED.accountId,
        newSparkPubkey: PINNED.oldSparkPubkey,
        now: GATE_NOW + 1,
      }),
    ).toBe('committed');
    expect((await store.getAccount(PINNED.accountId))?.sparkPubkey).toBe(PINNED.oldSparkPubkey);
    expect(await store.hasRecoveryShareForVerifiedWallet(PINNED.accountId)).toBe(false);
  });

  it('returns 503 when the store fails', async () => {
    const store = await recoveredStore();
    vi.spyOn(store, 'dropPreviousWallet').mockRejectedValue(new Error('db down'));
    const res = await drop(
      mount(store, { clock: gateClock, walletEnabled: true }),
      PINNED.oldSparkPubkey,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Wallet data is unavailable' });
    expect(await store.listPreviousWallets(PINNED.accountId)).toHaveLength(1);
    const events = parsedEvents(warn).map((e) => e['event']);
    expect(events).toContain('account.previous_wallets.failed');
    expect(events).not.toContain('account.previous_wallet.dropped');
  });
});
describe('held-share boxes', () => {
  const BOX = '0123456789abcdef0123456789abcdef';
  const BOX_2 = 'f'.repeat(32);
  /** A minimal valid box: version byte 0x01, then 28 more bytes. */
  const BYTES = Uint8Array.from({ length: 29 }, (_, i) => (i === 0 ? 1 : i));
  const CIPHERTEXT = Buffer.from(BYTES).toString('base64url');

  function put(
    app: Hono,
    id: string,
    body: unknown,
    headers: Record<string, string> = AUTH,
  ): Promise<Response> {
    return Promise.resolve(
      app.request(`/me/held-shares/${id}`, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    );
  }

  function list(app: Hono, headers: Record<string, string> = AUTH): Promise<Response> {
    return Promise.resolve(app.request('/me/held-shares', { headers }));
  }

  function remove(
    app: Hono,
    id: string,
    headers: Record<string, string> = AUTH,
  ): Promise<Response> {
    return Promise.resolve(app.request(`/me/held-shares/${id}`, { method: 'DELETE', headers }));
  }

  async function withOther(store: InMemoryAuthStore): Promise<void> {
    await store.createAccount({
      id: 'other',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1_000_000,
      rulesAgreedAt: null,
    });
  }

  /** Every logged line must stay free of box ids and ciphertext. */
  function expectNoBoxInLogs(extra: readonly string[] = []): void {
    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
    for (const secret of [BOX, BOX_2, CIPHERTEXT, ...extra]) {
      expect(logged).not.toContain(secret);
    }
  }

  it('is mounted without the LNURL server and starts empty', async () => {
    const res = await list(mount(await seededStore()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ boxes: [] });
  });

  it('answers 401 on every route without a session or for a refused account', async () => {
    const store = await seededStore();
    const app = mount(store);
    expect((await list(app, {})).status).toBe(401);
    expect((await put(app, BOX, { ciphertext: CIPHERTEXT }, {})).status).toBe(401);
    const removed = await remove(app, BOX, { authorization: 'Bearer nope' });
    expect(removed.status).toBe(401);
    expect(await removed.json()).toEqual({ error: 'Unauthorized' });
    await store.createAccount({
      id: 'refused',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'c'.repeat(64),
      createdAt: 1_000_000,
      rulesAgreedAt: null,
      sessionRefused: true,
    });
    await store.createSession({ token: 'refused', accountId: 'refused', createdAt: 1_000_000 });
    const refused = { authorization: 'Bearer refused' };
    // A box of the refused account must survive its refused DELETE.
    await store.putHeldShareBox({
      accountId: 'refused',
      id: BOX_2,
      ciphertext: BYTES,
      now: 1,
      limit: 50,
    });
    expect((await list(app, refused)).status).toBe(401);
    expect((await put(app, BOX, { ciphertext: CIPHERTEXT }, refused)).status).toBe(401);
    expect((await remove(app, BOX_2, refused)).status).toBe(401);
    expect((await store.listHeldShareBoxes('refused')).map((box) => box.id)).toEqual([BOX_2]);
  });

  it('creates (201), replaces (200), and lists the caller’s boxes oldest first', async () => {
    let clock = Date.parse('2026-10-30T10:00:00.000Z');
    const store = await seededStore();
    await store.createSession({ token: 'tok', accountId: 'acc', createdAt: clock });
    const app = mount(store, { clock: () => clock });
    // Created BOX_2, BOX, MIDDLE; BOX_2 is replaced last. Creation order then
    // matches neither id order nor update order, ascending or descending.
    const MIDDLE = '8'.repeat(32);
    const created = await put(app, BOX_2, { ciphertext: CIPHERTEXT });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id: BOX_2, updatedAt: '2026-10-30T10:00:00.000Z' });
    clock += 1_000;
    expect((await put(app, BOX, { ciphertext: CIPHERTEXT })).status).toBe(201);
    clock += 1_000;
    expect((await put(app, MIDDLE, { ciphertext: CIPHERTEXT })).status).toBe(201);
    clock += 1_000;
    const replacement = Buffer.from(Uint8Array.from({ length: 1024 }, () => 1)).toString(
      'base64url',
    );
    const replaced = await put(app, BOX_2, { ciphertext: replacement });
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toEqual({ id: BOX_2, updatedAt: '2026-10-30T10:00:03.000Z' });
    const res = await list(app);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      boxes: [
        { id: BOX_2, ciphertext: replacement, updatedAt: '2026-10-30T10:00:03.000Z' },
        { id: BOX, ciphertext: CIPHERTEXT, updatedAt: '2026-10-30T10:00:01.000Z' },
        { id: MIDDLE, ciphertext: CIPHERTEXT, updatedAt: '2026-10-30T10:00:02.000Z' },
      ],
    });
    const events = parsedEvents(warn).filter((e) => e['event'] === 'account.held_share.stored');
    expect(events).toEqual([
      expect.objectContaining({ accountId: 'acc', replaced: false }),
      expect.objectContaining({ accountId: 'acc', replaced: false }),
      expect.objectContaining({ accountId: 'acc', replaced: false }),
      expect.objectContaining({ accountId: 'acc', replaced: true }),
    ]);
    expectNoBoxInLogs([MIDDLE, replacement]);
  });

  it('refuses an id that is not 32 lowercase hex', async () => {
    const app = mount(await seededStore());
    for (const id of ['A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), 'g'.repeat(32), ':id']) {
      const stored = await put(app, id, { ciphertext: CIPHERTEXT });
      expect(stored.status).toBe(400);
      expect(await stored.json()).toEqual({
        error: 'Expected a box id of 32 lowercase hex characters',
      });
      const removed = await remove(app, id);
      expect(removed.status).toBe(400);
      expect(await removed.json()).toEqual({
        error: 'Expected a box id of 32 lowercase hex characters',
      });
    }
  });

  it('refuses a body that is not one canonical box of 29–1024 bytes with version 1', async () => {
    const store = await seededStore();
    const app = mount(store);
    const encode = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
    const bodies: unknown[] = [
      'not json',
      null,
      {},
      { ciphertext: 1 },
      { ciphertext: CIPHERTEXT, extra: true },
      { ciphertext: '' },
      { ciphertext: `${CIPHERTEXT}=` },
      { ciphertext: `${CIPHERTEXT.slice(0, -1)}+` },
      // Non-zero unused bits: decodes, but is not the canonical encoding.
      { ciphertext: `${CIPHERTEXT.slice(0, -1)}B` },
      { ciphertext: encode(BYTES.slice(0, 28)) },
      { ciphertext: encode(Uint8Array.from({ length: 1025 }, () => 1)) },
      { ciphertext: 'A'.repeat(1367) },
      { ciphertext: encode(Uint8Array.from({ length: 29 }, () => 2)) },
    ];
    for (const body of bodies) {
      const res = await put(app, BOX, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Expected a JSON body with a held share ciphertext',
      });
    }
    expect(await store.listHeldShareBoxes('acc')).toEqual([]);
  });

  it('answers 409 for an id of another account and leaves that box alone', async () => {
    const store = await seededStore();
    await withOther(store);
    await store.putHeldShareBox({
      accountId: 'other',
      id: BOX,
      ciphertext: Uint8Array.of(1, 2),
      now: 1,
      limit: 50,
    });
    const app = mount(store);
    const res = await put(app, BOX, { ciphertext: CIPHERTEXT });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Box id in use' });
    // The caller never sees the other account's box.
    expect(await (await list(app)).json()).toEqual({ boxes: [] });
    expect(await store.listHeldShareBoxes('acc')).toEqual([]);
    expect((await remove(app, BOX)).status).toBe(204);
    expect(await (await list(app)).json()).toEqual({ boxes: [] });
    expect(await store.listHeldShareBoxes('other')).toEqual([
      { id: BOX, ciphertext: Uint8Array.of(1, 2), createdAt: 1, updatedAt: 1 },
    ]);
  });

  it('creates the 50th box, answers 409 for a 51st, and still replaces one of the 50', async () => {
    const store = await seededStore();
    for (let i = 0; i < 49; i += 1) {
      await store.putHeldShareBox({
        accountId: 'acc',
        id: i.toString(16).padStart(32, '0'),
        ciphertext: BYTES,
        now: i,
        limit: 50,
      });
    }
    const app = mount(store);
    expect((await put(app, BOX_2, { ciphertext: CIPHERTEXT })).status).toBe(201);
    const res = await put(app, BOX, { ciphertext: CIPHERTEXT });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Too many held shares' });
    const other = Uint8Array.from({ length: 40 }, (_, i) => (i === 0 ? 1 : 9));
    const replaced = await put(app, '0'.repeat(32), {
      ciphertext: Buffer.from(other).toString('base64url'),
    });
    expect(replaced.status).toBe(200);
    const boxes = await store.listHeldShareBoxes('acc');
    expect(boxes).toHaveLength(50);
    expect(boxes.find((box) => box.id === '0'.repeat(32))?.ciphertext).toEqual(other);
  });

  it('deletes the caller’s box with 204, idempotently', async () => {
    const store = await seededStore();
    const app = mount(store);
    expect((await put(app, BOX, { ciphertext: CIPHERTEXT })).status).toBe(201);
    const res = await remove(app, BOX);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect((await remove(app, BOX)).status).toBe(204);
    expect(await (await list(app)).json()).toEqual({ boxes: [] });
    expect(parsedEvents(warn)).toContainEqual(
      expect.objectContaining({ event: 'account.held_share.deleted', accountId: 'acc' }),
    );
    expectNoBoxInLogs();
  });

  it('answers 503 when the store fails, without logging the box', async () => {
    const store = await seededStore();
    vi.spyOn(store, 'listHeldShareBoxes').mockRejectedValue(new Error('db down'));
    vi.spyOn(store, 'putHeldShareBox').mockRejectedValue(new Error('db down'));
    vi.spyOn(store, 'deleteHeldShareBox').mockRejectedValue(new Error('db down'));
    const app = mount(store);
    for (const res of [
      await list(app),
      await put(app, BOX, { ciphertext: CIPHERTEXT }),
      await remove(app, BOX),
    ]) {
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Held shares are unavailable' });
    }
    const events = parsedEvents(warn).map((e) => e['event']);
    expect(events.filter((e) => e === 'account.held_shares.failed')).toHaveLength(3);
    expect(events).not.toContain('account.held_share.stored');
    expect(events).not.toContain('account.held_share.deleted');
    expectNoBoxInLogs();
  });
});

describe('shop identity hooks', () => {
  const now = (): number => 1_700_000_000_000;

  const AUTH = { authorization: 'Bearer tok', 'content-type': 'application/json' };

  const KEK = new Uint8Array(32).fill(7);

  function account(overrides: Partial<Account>): Account {
    return {
      id: 'mod',
      linkingKey: null,
      role: 'moderator',
      name: 'Mo',
      username: 'mo',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: 1,
      ...overrides,
    } as Account;
  }

  async function authStore(): Promise<InMemoryAuthStore> {
    const auth = new InMemoryAuthStore();
    await auth.createAccount(account({}));
    await auth.createAccount(
      account({
        id: 'till',
        role: 'basis',
        name: 'Coffee',
        username: 'coffee',
        viewKey: 'b'.repeat(64),
      }),
    );
    await auth.createSession({ token: 'tok', accountId: 'mod', createdAt: now() });
    return auth;
  }

  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  function logged(event: string): Array<Record<string, unknown>> {
    return warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line['event'] === event);
  }

  describe('shop key after PUT /me/about', () => {
    it('asks for the key of the profile note and logs a failure without failing', async () => {
      const auth = await authStore();
      const calls: string[] = [];
      const spy = {
        ensureListed: (id: string) => {
          calls.push(id);
          return calls.length === 1 ? Promise.resolve(undefined) : Promise.reject(new Error('db'));
        },
      } as unknown as ShopIdentityStore;
      const app = createApp({ authStore: auth, now, nostrKek: KEK, shopIdentityStore: spy });
      const put = (text: string): Promise<Response> =>
        Promise.resolve(
          app.request('/me/about', {
            method: 'PUT',
            headers: AUTH,
            body: JSON.stringify({ text }),
          }),
        );
      expect((await put('About the coffee shop')).status).toBe(200);
      expect((await put('About the coffee shop again')).status).toBe(200);
      const profileId = (await auth.getAccount('mod'))?.profileMessageId;
      expect(calls).toEqual([profileId, profileId]);
      expect(logged('shop.nostr_key.failed')).toEqual([
        expect.objectContaining({ messageId: profileId }),
      ]);
    });

    it('skips the key without a KEK', async () => {
      const calls: string[] = [];
      const spy = {
        ensureListed: (id: string) => {
          calls.push(id);
          return Promise.resolve(undefined);
        },
      } as unknown as ShopIdentityStore;
      const app = createApp({ authStore: await authStore(), now, shopIdentityStore: spy });
      const res = await app.request('/me/about', {
        method: 'PUT',
        headers: AUTH,
        body: JSON.stringify({ text: 'About' }),
      });
      expect(res.status).toBe(200);
      expect(calls).toEqual([]);
    });
  });
});
