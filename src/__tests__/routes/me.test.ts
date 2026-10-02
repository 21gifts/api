import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore, type Account, type PasskeyRenewAttemptInput } from '@/lib/auth/store';
import { SESSION_TTL_MS } from '@/lib/config';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import { InMemoryNotificationStore } from '@/lib/notification-store';
import { InMemoryPushStore } from '@/lib/push-store';
import { WRONG_ACCOUNT_ERROR } from '@/lib/auth/wrong-account';
import { bearerToken, meRoutes } from '@/routes/me';
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
    }),
  );
}

const SPARK_PUBKEY = `02${'a'.repeat(64)}`;
const SPARK_PUBKEY_OTHER = `03${'b'.repeat(64)}`;

/** A store with a signed-in account `acc` reachable via session `tok`. */
async function seededStore(overrides: { wallet?: boolean } = {}): Promise<InMemoryAuthStore> {
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
      notificationLevel: 'all' | 'active' | 'mentions';
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
      error: 'Expected a JSON body with a level of all, active, or mentions',
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
      error: 'Expected a JSON body with a level of all, active, or mentions',
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

  it('trims, stores, and returns the name without a profile note when LN is missing', async () => {
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
