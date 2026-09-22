import { afterEach, describe, it, expect, vi } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { CHALLENGE_TTL_MS } from '@/lib/config';
import type { WebAuthnRuntimeConfig } from '@/lib/config';
import {
  credentialIdFrom,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
  finishPasskeyReplace,
  startPasskeyAuthentication,
  startPasskeyClaim,
  startPasskeyRegistration,
  startPasskeyReplace,
} from '@/lib/auth/passkey';
import * as authService from '@/lib/auth/service';
import { WRONG_ACCOUNT_ERROR } from '@/lib/auth/wrong-account';
import { FakePasskeyCeremony } from '@/__tests__/helpers/fake-passkey';

const T0 = 1_000_000;
const REFUSED_ID = '00000000-0000-4000-8000-0000000000ff';
const CONFIG: WebAuthnRuntimeConfig = {
  rpId: 'localhost',
  rpName: '21.gifts',
  expectedOrigins: ['http://localhost:3000'],
};
const ORIGIN = 'http://localhost:3000';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('credentialIdFrom', () => {
  it('returns null for non-objects and missing ids', () => {
    expect(credentialIdFrom(null)).toBeNull();
    expect(credentialIdFrom('x')).toBeNull();
    expect(credentialIdFrom({})).toBeNull();
    expect(credentialIdFrom({ id: 1 })).toBeNull();
    expect(credentialIdFrom({ id: '' })).toBeNull();
  });

  it('returns a non-empty id string', () => {
    expect(credentialIdFrom({ id: 'cred-1' })).toBe('cred-1');
  });
});

describe('passkey registration', () => {
  it('creates an account with linkingKey null', async () => {
    const store = new InMemoryAuthStore();
    const ceremony = new FakePasskeyCeremony();
    const begin = await startPasskeyRegistration(store, ceremony, CONFIG, T0);
    const finish = await finishPasskeyRegistration(
      store,
      ceremony,
      CONFIG,
      T0,
      ORIGIN,
      begin.challengeId,
      { test: 'ok' },
    );
    expect(finish.ok).toBe(true);
    if (!finish.ok) {
      return;
    }
    expect(finish.value.account.linkingKey).toBeNull();
    expect(finish.value.account.viewKey).toMatch(/^[0-9a-f]{64}$/);
    expect(finish.value.account.walletRequired).toBe(true);
    expect(finish.value.account.walletBackupSeenAt).toBeNull();
    expect((await store.getPasskeyCredential('cred-1'))?.accountId).toBe(finish.value.account.id);
    expect((await store.getAccount(finish.value.account.id))?.walletRequired).toBe(true);
  });

  it('generates a Nostr key when a KEK is provided', async () => {
    const store = new InMemoryAuthStore();
    const ceremony = new FakePasskeyCeremony();
    const begin = await startPasskeyRegistration(store, ceremony, CONFIG, T0);
    const kek = new Uint8Array(32).fill(9);
    const finish = await finishPasskeyRegistration(
      store,
      ceremony,
      CONFIG,
      T0,
      ORIGIN,
      begin.challengeId,
      { test: 'ok' },
      { kek },
    );
    expect(finish.ok).toBe(true);
    if (!finish.ok) {
      return;
    }
    expect(await store.getNostrPublicKey(finish.value.account.id)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects an expired registration challenge', async () => {
    const store = new InMemoryAuthStore();
    const ceremony = new FakePasskeyCeremony();
    const begin = await startPasskeyRegistration(store, ceremony, CONFIG, T0);
    const finish = await finishPasskeyRegistration(
      store,
      ceremony,
      CONFIG,
      T0 + CHALLENGE_TTL_MS + 1,
      ORIGIN,
      begin.challengeId,
      { test: 'ok' },
    );
    expect(finish).toEqual({ ok: false, error: 'Challenge expired' });
  });

  it('rejects a register challenge with a null pending account id', async () => {
    const store = new InMemoryAuthStore();
    const ceremony = new FakePasskeyCeremony();
    await store.createPasskeyChallenge({
      id: 'ch',
      type: 'register',
      challenge: 'test-challenge',
      accountId: null,
      consumed: false,
      createdAt: T0,
    });
    const finish = await finishPasskeyRegistration(store, ceremony, CONFIG, T0, ORIGIN, 'ch', {
      test: 'ok',
    });
    expect(finish).toEqual({ ok: false, error: 'Unknown or expired challenge' });
  });

  it('rejects a duplicate credential id', async () => {
    const store = new InMemoryAuthStore();
    const ceremony = new FakePasskeyCeremony();
    const first = await startPasskeyRegistration(store, ceremony, CONFIG, T0);
    await finishPasskeyRegistration(store, ceremony, CONFIG, T0, ORIGIN, first.challengeId, {
      test: 'ok',
    });
    const second = await startPasskeyRegistration(store, ceremony, CONFIG, T0);
    const finish = await finishPasskeyRegistration(
      store,
      ceremony,
      CONFIG,
      T0,
      ORIGIN,
      second.challengeId,
      { test: 'ok' },
    );
    expect(finish).toEqual({ ok: false, error: 'Invalid passkey' });
  });

  it('rejects register finish when consume loses the race', async () => {
    class RaceStore extends InMemoryAuthStore {
      override async updatePasskeyChallenge(): Promise<boolean> {
        return false;
      }
    }
    const store = new RaceStore();
    const ceremony = new FakePasskeyCeremony();
    const begin = await startPasskeyRegistration(store, ceremony, CONFIG, T0);
    const finish = await finishPasskeyRegistration(
      store,
      ceremony,
      CONFIG,
      T0,
      ORIGIN,
      begin.challengeId,
      { test: 'ok' },
    );
    expect(finish).toEqual({ ok: false, error: 'Challenge already used' });
  });

  it('rejects register finish when the credential id is already stored', async () => {
    class DupStore extends InMemoryAuthStore {
      override async createFirstPasskeyCredential(): Promise<boolean> {
        return false;
      }
    }
    const store = new DupStore();
    const ceremony = new FakePasskeyCeremony();
    const begin = await startPasskeyRegistration(store, ceremony, CONFIG, T0);
    const finish = await finishPasskeyRegistration(
      store,
      ceremony,
      CONFIG,
      T0,
      ORIGIN,
      begin.challengeId,
      { test: 'ok' },
    );
    expect(finish).toEqual({ ok: false, error: 'Invalid passkey' });
    const pending = await store.getPasskeyChallenge(begin.challengeId);
    expect(pending?.accountId).toEqual(expect.any(String));
    expect(await store.getAccount(pending?.accountId ?? '')).toBeUndefined();
  });
});

describe('passkey claim', () => {
  const VIEW_KEY = 'a'.repeat(64);

  async function provisionedStore(): Promise<InMemoryAuthStore> {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'provisioned',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: 'guest@walletofsatoshi.com',
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: VIEW_KEY,
      createdAt: T0,
      rulesAgreedAt: null,
    });
    return store;
  }

  it('returns not-found for a malformed viewKey', async () => {
    const result = await startPasskeyClaim(
      new InMemoryAuthStore(),
      new FakePasskeyCeremony(),
      CONFIG,
      T0,
      'not-a-key',
    );
    expect(result).toEqual({ ok: false, error: 'This profile could not be found.' });
  });

  it('returns not-found for an unknown viewKey', async () => {
    const result = await startPasskeyClaim(
      new InMemoryAuthStore(),
      new FakePasskeyCeremony(),
      CONFIG,
      T0,
      'b'.repeat(64),
    );
    expect(result).toEqual({ ok: false, error: 'This profile could not be found.' });
  });

  it('refuses claim begin when the account already has a passkey', async () => {
    const store = await provisionedStore();
    await store.createPasskeyCredential({
      credentialId: 'cred-existing',
      publicKey: new Uint8Array([1]),
      signCount: 0,
      accountId: 'provisioned',
      createdAt: T0,
    });
    const result = await startPasskeyClaim(store, new FakePasskeyCeremony(), CONFIG, T0, VIEW_KEY);
    expect(result).toEqual({ ok: false, error: 'This profile already has a passkey' });
  });

  it('uses a fallback display name when the provisioned account has no name', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'provisioned',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: 'guest@walletofsatoshi.com',
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: VIEW_KEY,
      createdAt: T0,
      rulesAgreedAt: null,
    });
    const result = await startPasskeyClaim(store, new FakePasskeyCeremony(), CONFIG, T0, VIEW_KEY);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const options = result.value.options as { user: { displayName: string } };
    expect(options.user.displayName).toBe('21.gifts');
  });

  it('begins claim with the existing account id and display name', async () => {
    const store = await provisionedStore();
    const result = await startPasskeyClaim(store, new FakePasskeyCeremony(), CONFIG, T0, VIEW_KEY);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const options = result.value.options as {
      user: { id: string; name: string; displayName: string };
    };
    expect(options.user.id).toBe('provisioned');
    expect(options.user.name).toBe('provisioned');
    expect(options.user.displayName).toBe('Ada');
    expect((await store.getPasskeyChallenge(result.value.challengeId))?.accountId).toBe(
      'provisioned',
    );
  });

  it('finish after claim keeps name, lightningAddress, viewKey, and id', async () => {
    const store = await provisionedStore();
    const begin = await startPasskeyClaim(store, new FakePasskeyCeremony(), CONFIG, T0, VIEW_KEY);
    expect(begin.ok).toBe(true);
    if (!begin.ok) {
      return;
    }
    const finish = await finishPasskeyRegistration(
      store,
      new FakePasskeyCeremony(),
      CONFIG,
      T0,
      ORIGIN,
      begin.value.challengeId,
      { test: 'ok' },
    );
    expect(finish.ok).toBe(true);
    if (!finish.ok) {
      return;
    }
    expect(finish.value.account).toMatchObject({
      id: 'provisioned',
      name: 'Ada',
      lightningAddress: 'guest@walletofsatoshi.com',
      viewKey: VIEW_KEY,
      walletRequired: true,
    });
    expect(finish.value.account.walletBackupSeenAt).toBeUndefined();
    expect((await store.listAccounts()).map((row) => row.id)).toEqual(['provisioned']);
  });

  it('sets walletRequired on claim without clearing a seen backup', async () => {
    const store = await provisionedStore();
    const existing = await store.getAccount('provisioned');
    expect(existing).toBeDefined();
    expect(await store.markWalletBackupSeen('provisioned', 99)).toMatchObject({
      wrote: true,
      account: { walletBackupSeenAt: 99 },
    });
    const begin = await startPasskeyClaim(store, new FakePasskeyCeremony(), CONFIG, T0, VIEW_KEY);
    expect(begin.ok).toBe(true);
    if (!begin.ok) {
      return;
    }
    const finish = await finishPasskeyRegistration(
      store,
      new FakePasskeyCeremony(),
      CONFIG,
      T0,
      ORIGIN,
      begin.value.challengeId,
      { test: 'ok' },
    );
    expect(finish.ok).toBe(true);
    if (!finish.ok) {
      return;
    }
    expect(finish.value.account.walletRequired).toBe(true);
    expect(finish.value.account.walletBackupSeenAt).toBe(99);
    expect((await store.getAccount('provisioned'))?.walletBackupSeenAt).toBe(99);
  });

  it('does not delete a provisioned account when credential insert races', async () => {
    class DupStore extends InMemoryAuthStore {
      override async createFirstPasskeyCredential(): Promise<boolean> {
        return false;
      }
    }
    const store = new DupStore();
    await store.createAccount({
      id: 'provisioned',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: 'guest@walletofsatoshi.com',
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: VIEW_KEY,
      createdAt: T0,
      rulesAgreedAt: null,
    });
    const begin = await startPasskeyClaim(store, new FakePasskeyCeremony(), CONFIG, T0, VIEW_KEY);
    expect(begin.ok).toBe(true);
    if (!begin.ok) {
      return;
    }
    const finish = await finishPasskeyRegistration(
      store,
      new FakePasskeyCeremony(),
      CONFIG,
      T0,
      ORIGIN,
      begin.value.challengeId,
      { test: 'ok' },
    );
    expect(finish).toEqual({ ok: false, error: 'Invalid passkey' });
    expect(await store.getAccount('provisioned')).toMatchObject({
      id: 'provisioned',
      name: 'Ada',
      viewKey: VIEW_KEY,
    });
  });

  it('rejects claim finish when a passkey appeared after begin', async () => {
    const store = await provisionedStore();
    const begin = await startPasskeyClaim(store, new FakePasskeyCeremony(), CONFIG, T0, VIEW_KEY);
    expect(begin.ok).toBe(true);
    if (!begin.ok) {
      return;
    }
    await store.createPasskeyCredential({
      credentialId: 'cred-existing',
      publicKey: new Uint8Array([1]),
      signCount: 0,
      accountId: 'provisioned',
      createdAt: T0,
    });
    const finish = await finishPasskeyRegistration(
      store,
      new FakePasskeyCeremony(),
      CONFIG,
      T0,
      ORIGIN,
      begin.value.challengeId,
      { test: 'ok' },
    );
    expect(finish).toEqual({ ok: false, error: 'Invalid passkey' });
  });

  it('mints a Nostr key on claim when a KEK is provided', async () => {
    const store = await provisionedStore();
    const begin = await startPasskeyClaim(store, new FakePasskeyCeremony(), CONFIG, T0, VIEW_KEY);
    expect(begin.ok).toBe(true);
    if (!begin.ok) {
      return;
    }
    const kek = new Uint8Array(32).fill(3);
    const finish = await finishPasskeyRegistration(
      store,
      new FakePasskeyCeremony(),
      CONFIG,
      T0,
      ORIGIN,
      begin.value.challengeId,
      { test: 'ok' },
      { kek },
    );
    expect(finish.ok).toBe(true);
    expect(await store.getNostrPublicKey('provisioned')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('still issues a claim session when Nostr keygen fails', async () => {
    const store = await provisionedStore();
    const begin = await startPasskeyClaim(store, new FakePasskeyCeremony(), CONFIG, T0, VIEW_KEY);
    expect(begin.ok).toBe(true);
    if (!begin.ok) {
      return;
    }
    const finish = await finishPasskeyRegistration(
      store,
      new FakePasskeyCeremony(),
      CONFIG,
      T0,
      ORIGIN,
      begin.value.challengeId,
      { test: 'ok' },
      {
        kek: new Uint8Array(32).fill(3),
        keygen: {
          generateSecretKey: (): never => {
            throw new Error('no entropy');
          },
        },
      },
    );
    expect(finish.ok).toBe(true);
    expect(await store.getNostrPublicKey('provisioned')).toBeUndefined();
  });

  it('refuses a sessionRefused account before binding a credential', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: REFUSED_ID,
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: VIEW_KEY,
      createdAt: T0,
      rulesAgreedAt: null,
      sessionRefused: true,
    });
    await store.createPasskeyChallenge({
      id: 'ch',
      type: 'register',
      challenge: 'test-challenge',
      accountId: REFUSED_ID,
      consumed: false,
      createdAt: T0,
    });
    const createSession = vi.spyOn(store, 'createSession');
    const createFirst = vi.spyOn(store, 'createFirstPasskeyCredential');
    const finish = await finishPasskeyRegistration(
      store,
      new FakePasskeyCeremony(),
      CONFIG,
      T0,
      ORIGIN,
      'ch',
      { test: 'ok' },
    );
    expect(finish).toEqual({ ok: false, error: WRONG_ACCOUNT_ERROR });
    expect(createSession).not.toHaveBeenCalled();
    expect(createFirst).not.toHaveBeenCalled();
  });

  it('maps a concurrent refuse during first credential insert to the wrong-account error', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: REFUSED_ID,
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: VIEW_KEY,
      createdAt: T0,
      rulesAgreedAt: null,
    });
    await store.createPasskeyChallenge({
      id: 'ch',
      type: 'register',
      challenge: 'test-challenge',
      accountId: REFUSED_ID,
      consumed: false,
      createdAt: T0,
    });
    vi.spyOn(store, 'createFirstPasskeyCredential').mockImplementation(async () => {
      await store.setSessionRefused(REFUSED_ID, true);
      return false;
    });
    const finish = await finishPasskeyRegistration(
      store,
      new FakePasskeyCeremony(),
      CONFIG,
      T0,
      ORIGIN,
      'ch',
      { test: 'ok' },
    );
    expect(finish).toEqual({ ok: false, error: WRONG_ACCOUNT_ERROR });
    expect(await store.getPasskeyCredential('cred-1')).toBeUndefined();
  });
});

describe('passkey authentication', () => {
  async function seed(): Promise<{
    store: InMemoryAuthStore;
    ceremony: FakePasskeyCeremony;
    accountId: string;
  }> {
    const store = new InMemoryAuthStore();
    const ceremony = new FakePasskeyCeremony();
    const begin = await startPasskeyRegistration(store, ceremony, CONFIG, T0);
    const finish = await finishPasskeyRegistration(
      store,
      ceremony,
      CONFIG,
      T0,
      ORIGIN,
      begin.challengeId,
      { test: 'ok' },
    );
    if (!finish.ok) {
      throw new Error('seed register failed');
    }
    return { store, ceremony, accountId: finish.value.account.id };
  }

  it('issues a session and bumps signCount', async () => {
    const { store, ceremony, accountId } = await seed();
    const begin = await startPasskeyAuthentication(store, ceremony, CONFIG, T0);
    const finish = await finishPasskeyAuthentication(
      store,
      ceremony,
      CONFIG,
      T0,
      ORIGIN,
      begin.challengeId,
      { test: 'ok', id: 'cred-1' },
    );
    expect(finish.ok).toBe(true);
    if (!finish.ok) {
      return;
    }
    expect(finish.value.account.id).toBe(accountId);
    expect((await store.getPasskeyCredential('cred-1'))?.signCount).toBe(1);
  });

  it('ensures a Nostr key on authenticate when a KEK is provided', async () => {
    const { store, ceremony, accountId } = await seed();
    const begin = await startPasskeyAuthentication(store, ceremony, CONFIG, T0);
    const kek = new Uint8Array(32).fill(3);
    const finish = await finishPasskeyAuthentication(
      store,
      ceremony,
      CONFIG,
      T0,
      ORIGIN,
      begin.challengeId,
      { test: 'ok', id: 'cred-1' },
      { kek },
    );
    expect(finish.ok).toBe(true);
    expect(await store.getNostrPublicKey(accountId)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects authentication when the account is gone', async () => {
    const store = new InMemoryAuthStore();
    const ceremony = new FakePasskeyCeremony();
    await store.createPasskeyCredential({
      credentialId: 'cred-1',
      publicKey: new Uint8Array([1, 2, 3]),
      signCount: 0,
      accountId: 'missing',
      createdAt: T0,
    });
    const begin = await startPasskeyAuthentication(store, ceremony, CONFIG, T0);
    const finish = await finishPasskeyAuthentication(
      store,
      ceremony,
      CONFIG,
      T0,
      ORIGIN,
      begin.challengeId,
      { test: 'ok', id: 'cred-1' },
    );
    expect(finish).toEqual({ ok: false, error: 'Unknown or expired challenge' });
  });

  it('issues a session when signCount stays at 0', async () => {
    const { store, ceremony, accountId } = await seed();
    const begin = await startPasskeyAuthentication(store, ceremony, CONFIG, T0);
    const finish = await finishPasskeyAuthentication(
      store,
      ceremony,
      CONFIG,
      T0,
      ORIGIN,
      begin.challengeId,
      { test: 'zero', id: 'cred-1' },
    );
    expect(finish.ok).toBe(true);
    if (!finish.ok) {
      return;
    }
    expect(finish.value.account.id).toBe(accountId);
    expect((await store.getPasskeyCredential('cred-1'))?.signCount).toBe(0);
  });

  it('rejects authenticate finish when a zero signCount follows a positive counter', async () => {
    const { store, ceremony } = await seed();
    const beginOk = await startPasskeyAuthentication(store, ceremony, CONFIG, T0);
    const finishOk = await finishPasskeyAuthentication(
      store,
      ceremony,
      CONFIG,
      T0,
      ORIGIN,
      beginOk.challengeId,
      { test: 'ok', id: 'cred-1' },
    );
    expect(finishOk.ok).toBe(true);
    expect((await store.getPasskeyCredential('cred-1'))?.signCount).toBe(1);
    const beginZero = await startPasskeyAuthentication(store, ceremony, CONFIG, T0);
    const finishZero = await finishPasskeyAuthentication(
      store,
      ceremony,
      CONFIG,
      T0,
      ORIGIN,
      beginZero.challengeId,
      { test: 'zero', id: 'cred-1' },
    );
    expect(finishZero).toEqual({ ok: false, error: 'Invalid passkey' });
    expect((await store.getPasskeyCredential('cred-1'))?.signCount).toBe(1);
  });

  it('rejects authenticate finish when signCount CAS loses', async () => {
    const { ceremony } = await seed();
    class RaceStore extends InMemoryAuthStore {
      override async updatePasskeyCredential(): Promise<boolean> {
        return false;
      }
    }
    const store = new RaceStore();
    await store.createPasskeyCredential({
      credentialId: 'cred-1',
      publicKey: new Uint8Array([1, 2, 3]),
      signCount: 0,
      accountId: 'acc',
      createdAt: T0,
    });
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: T0,
      rulesAgreedAt: null,
    });
    const begin = await startPasskeyAuthentication(store, ceremony, CONFIG, T0);
    const finish = await finishPasskeyAuthentication(
      store,
      ceremony,
      CONFIG,
      T0,
      ORIGIN,
      begin.challengeId,
      { test: 'ok', id: 'cred-1' },
    );
    expect(finish).toEqual({ ok: false, error: 'Invalid passkey' });
  });

  it('rejects authenticate finish when consume loses the race', async () => {
    const { ceremony } = await seed();
    class RaceStore extends InMemoryAuthStore {
      override async updatePasskeyChallenge(): Promise<boolean> {
        return false;
      }
    }
    const store = new RaceStore();
    const begin = await startPasskeyAuthentication(store, ceremony, CONFIG, T0);
    const finish = await finishPasskeyAuthentication(
      store,
      ceremony,
      CONFIG,
      T0,
      ORIGIN,
      begin.challengeId,
      { test: 'ok', id: 'cred-1' },
    );
    expect(finish).toEqual({ ok: false, error: 'Challenge already used' });
  });

  it('refuses a sessionRefused account before issuing a session', async () => {
    const store = new InMemoryAuthStore();
    const ceremony = new FakePasskeyCeremony();
    await store.createAccount({
      id: REFUSED_ID,
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: T0,
      rulesAgreedAt: null,
      sessionRefused: true,
    });
    await store.createPasskeyCredential({
      credentialId: 'cred-1',
      publicKey: new Uint8Array([1, 2, 3]),
      signCount: 0,
      accountId: REFUSED_ID,
      createdAt: T0,
    });
    const begin = await startPasskeyAuthentication(store, ceremony, CONFIG, T0);
    const createSession = vi.spyOn(store, 'createSession');
    const finish = await finishPasskeyAuthentication(
      store,
      ceremony,
      CONFIG,
      T0,
      ORIGIN,
      begin.challengeId,
      { test: 'ok', id: 'cred-1' },
    );
    expect(finish).toEqual({ ok: false, error: WRONG_ACCOUNT_ERROR });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('maps a concurrent tryCreateSession failure to the wrong-account error', async () => {
    const { store, ceremony } = await seed();
    vi.spyOn(store, 'tryCreateSession').mockResolvedValue(false);
    const begin = await startPasskeyAuthentication(store, ceremony, CONFIG, T0);
    const finish = await finishPasskeyAuthentication(
      store,
      ceremony,
      CONFIG,
      T0,
      ORIGIN,
      begin.challengeId,
      { test: 'ok', id: 'cred-1' },
    );
    expect(finish).toEqual({ ok: false, error: WRONG_ACCOUNT_ERROR });
  });

  it('rethrows a non-wrong-account issueSession failure', async () => {
    const { store, ceremony } = await seed();
    vi.spyOn(authService, 'issueSession').mockRejectedValue(new Error('disk'));
    const begin = await startPasskeyAuthentication(store, ceremony, CONFIG, T0);
    await expect(
      finishPasskeyAuthentication(store, ceremony, CONFIG, T0, ORIGIN, begin.challengeId, {
        test: 'ok',
        id: 'cred-1',
      }),
    ).rejects.toThrow('disk');
  });
});

describe('passkey replace', () => {
  async function seed(): Promise<{
    store: InMemoryAuthStore;
    ceremony: FakePasskeyCeremony;
    accountId: string;
  }> {
    const store = new InMemoryAuthStore();
    const ceremony = new FakePasskeyCeremony();
    const begin = await startPasskeyRegistration(store, ceremony, CONFIG, T0);
    const finish = await finishPasskeyRegistration(
      store,
      ceremony,
      CONFIG,
      T0,
      ORIGIN,
      begin.challengeId,
      { test: 'ok' },
    );
    if (!finish.ok) {
      throw new Error('seed register failed');
    }
    return { store, ceremony, accountId: finish.value.account.id };
  }

  it('returns no-passkey when the account has no credential', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'provisioned',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: T0,
      rulesAgreedAt: null,
    });
    const account = await store.getAccount('provisioned');
    if (account === undefined) {
      throw new Error('missing account');
    }
    const started = await startPasskeyReplace(
      store,
      new FakePasskeyCeremony(),
      CONFIG,
      T0,
      account,
    );
    expect(started).toEqual({ ok: false, error: 'No passkey to replace' });
  });

  it('replaces cred-1 with cred-2', async () => {
    const { store, ceremony, accountId } = await seed();
    const account = await store.getAccount(accountId);
    if (account === undefined) {
      throw new Error('missing account');
    }
    const begin = await startPasskeyReplace(store, ceremony, CONFIG, T0, account);
    expect('challengeId' in begin).toBe(true);
    if (!('challengeId' in begin)) {
      return;
    }
    const options = begin.options as {
      excludeCredentials?: Array<{ id: string; type: string }>;
      user: { displayName: string };
    };
    expect(options.excludeCredentials).toEqual([{ id: 'cred-1', type: 'public-key' }]);
    expect(options.user.displayName).toBe('21.gifts');
    const finish = await finishPasskeyReplace(
      store,
      ceremony,
      CONFIG,
      T0,
      ORIGIN,
      begin.challengeId,
      { test: 'replace' },
      account,
    );
    expect(finish.ok).toBe(true);
    if (!finish.ok) {
      return;
    }
    expect(finish.account.id).toBe(accountId);
    expect(await store.getPasskeyCredential('cred-1')).toBeUndefined();
    expect((await store.getPasskeyCredential('cred-2'))?.accountId).toBe(accountId);
    expect((await store.getAccount(accountId))?.walletRequired).toBe(true);
  });

  it('does not set walletRequired on replace', async () => {
    const store = new InMemoryAuthStore();
    const ceremony = new FakePasskeyCeremony();
    await store.createAccount({
      id: 'existing',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: T0,
      rulesAgreedAt: null,
      walletRequired: false,
    });
    expect(
      await store.createPasskeyCredential({
        credentialId: 'cred-1',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: 'existing',
        createdAt: T0,
      }),
    ).toBe(true);
    const current = await store.getAccount('existing');
    if (current === undefined) {
      throw new Error('missing account');
    }
    const begin = await startPasskeyReplace(store, ceremony, CONFIG, T0, current);
    expect('challengeId' in begin).toBe(true);
    if (!('challengeId' in begin)) {
      return;
    }
    const finish = await finishPasskeyReplace(
      store,
      ceremony,
      CONFIG,
      T0,
      ORIGIN,
      begin.challengeId,
      { test: 'replace' },
      current,
    );
    expect(finish.ok).toBe(true);
    expect((await store.getAccount('existing'))?.walletRequired).toBe(false);
    expect((await store.getAccount('existing'))?.walletBackupSeenAt ?? null).toBeNull();
  });

  it('uses the account name as the WebAuthn display name', async () => {
    const { store, ceremony, accountId } = await seed();
    const account = await store.getAccount(accountId);
    if (account === undefined) {
      throw new Error('missing account');
    }
    account.name = 'Ada';
    await store.updateAccount(account);
    const named = await store.getAccount(accountId);
    if (named === undefined) {
      throw new Error('missing named account');
    }
    const begin = await startPasskeyReplace(store, ceremony, CONFIG, T0, named);
    if (!('challengeId' in begin)) {
      throw new Error('expected begin');
    }
    const options = begin.options as { user: { displayName: string } };
    expect(options.user.displayName).toBe('Ada');
  });

  it('rejects replace finish with the current credential id', async () => {
    const { store, ceremony, accountId } = await seed();
    const account = await store.getAccount(accountId);
    if (account === undefined) {
      throw new Error('missing account');
    }
    const begin = await startPasskeyReplace(store, ceremony, CONFIG, T0, account);
    if (!('challengeId' in begin)) {
      throw new Error('expected begin');
    }
    const finish = await finishPasskeyReplace(
      store,
      ceremony,
      CONFIG,
      T0,
      ORIGIN,
      begin.challengeId,
      { test: 'ok' },
      account,
    );
    expect(finish).toEqual({ ok: false, error: 'Invalid passkey' });
    expect((await store.getPasskeyCredential('cred-1'))?.accountId).toBe(accountId);
  });

  it('rejects a register challenge on replace finish', async () => {
    const { store, ceremony, accountId } = await seed();
    const account = await store.getAccount(accountId);
    if (account === undefined) {
      throw new Error('missing account');
    }
    const register = await startPasskeyRegistration(store, ceremony, CONFIG, T0);
    const finish = await finishPasskeyReplace(
      store,
      ceremony,
      CONFIG,
      T0,
      ORIGIN,
      register.challengeId,
      { test: 'replace' },
      account,
    );
    expect(finish).toEqual({ ok: false, error: 'Wrong challenge type' });
  });

  it('rejects another account finishing this replace challenge', async () => {
    const { store, ceremony, accountId } = await seed();
    const account = await store.getAccount(accountId);
    if (account === undefined) {
      throw new Error('missing account');
    }
    const begin = await startPasskeyReplace(store, ceremony, CONFIG, T0, account);
    if (!('challengeId' in begin)) {
      throw new Error('expected begin');
    }
    const other = {
      ...account,
      id: 'other',
      viewKey: 'b'.repeat(64),
    };
    const finish = await finishPasskeyReplace(
      store,
      ceremony,
      CONFIG,
      T0,
      ORIGIN,
      begin.challengeId,
      { test: 'replace' },
      other,
    );
    expect(finish).toEqual({ ok: false, error: 'Unknown or expired challenge' });
  });

  it('rejects replace finish when the challenge has no account id', async () => {
    const { store, ceremony, accountId } = await seed();
    const account = await store.getAccount(accountId);
    if (account === undefined) {
      throw new Error('missing account');
    }
    await store.createPasskeyChallenge({
      id: 'ch',
      type: 'replace',
      challenge: 'test-challenge',
      accountId: null,
      consumed: false,
      createdAt: T0,
    });
    const finish = await finishPasskeyReplace(
      store,
      ceremony,
      CONFIG,
      T0,
      ORIGIN,
      'ch',
      { test: 'replace' },
      account,
    );
    expect(finish).toEqual({ ok: false, error: 'Unknown or expired challenge' });
  });

  it('rejects replace finish with a missing origin', async () => {
    const { store, ceremony, accountId } = await seed();
    const account = await store.getAccount(accountId);
    if (account === undefined) {
      throw new Error('missing account');
    }
    const begin = await startPasskeyReplace(store, ceremony, CONFIG, T0, account);
    if (!('challengeId' in begin)) {
      throw new Error('expected begin');
    }
    const finish = await finishPasskeyReplace(
      store,
      ceremony,
      CONFIG,
      T0,
      undefined,
      begin.challengeId,
      { test: 'replace' },
      account,
    );
    expect(finish).toEqual({ ok: false, error: 'Invalid origin' });
  });

  it('rejects an invalid attestation on replace finish', async () => {
    const { store, ceremony, accountId } = await seed();
    const account = await store.getAccount(accountId);
    if (account === undefined) {
      throw new Error('missing account');
    }
    const begin = await startPasskeyReplace(store, ceremony, CONFIG, T0, account);
    if (!('challengeId' in begin)) {
      throw new Error('expected begin');
    }
    const finish = await finishPasskeyReplace(
      store,
      ceremony,
      CONFIG,
      T0,
      ORIGIN,
      begin.challengeId,
      { test: 'nope' },
      account,
    );
    expect(finish).toEqual({ ok: false, error: 'Invalid passkey' });
  });

  it('rejects replace when the new id belongs to another account', async () => {
    const { store, ceremony, accountId } = await seed();
    const account = await store.getAccount(accountId);
    if (account === undefined) {
      throw new Error('missing account');
    }
    await store.createPasskeyCredential({
      credentialId: 'cred-2',
      publicKey: new Uint8Array([4, 5, 6]),
      signCount: 0,
      accountId: 'other',
      createdAt: T0,
    });
    const begin = await startPasskeyReplace(store, ceremony, CONFIG, T0, account);
    if (!('challengeId' in begin)) {
      throw new Error('expected begin');
    }
    const finish = await finishPasskeyReplace(
      store,
      ceremony,
      CONFIG,
      T0,
      ORIGIN,
      begin.challengeId,
      { test: 'replace' },
      account,
    );
    expect(finish).toEqual({ ok: false, error: 'Invalid passkey' });
  });

  it('rejects replace finish when consume loses the race', async () => {
    const { store: seeded, ceremony, accountId } = await seed();
    class RaceStore extends InMemoryAuthStore {
      override async updatePasskeyChallenge(): Promise<boolean> {
        return false;
      }
    }
    const store = new RaceStore();
    const account = await seeded.getAccount(accountId);
    if (account === undefined) {
      throw new Error('missing account');
    }
    await store.createAccount(account);
    await store.createPasskeyCredential({
      credentialId: 'cred-1',
      publicKey: new Uint8Array([1, 2, 3]),
      signCount: 0,
      accountId,
      createdAt: T0,
    });
    const begin = await startPasskeyReplace(store, ceremony, CONFIG, T0, account);
    if (!('challengeId' in begin)) {
      throw new Error('expected begin');
    }
    const finish = await finishPasskeyReplace(
      store,
      ceremony,
      CONFIG,
      T0,
      ORIGIN,
      begin.challengeId,
      { test: 'replace' },
      account,
    );
    expect(finish).toEqual({ ok: false, error: 'Challenge already used' });
  });

  it('rejects replace finish when replacePasskeyCredential returns false', async () => {
    const { ceremony, accountId } = await seed();
    class FailStore extends InMemoryAuthStore {
      override async replacePasskeyCredential(): Promise<boolean> {
        return false;
      }
    }
    const store = new FailStore();
    const account = {
      id: accountId,
      linkingKey: null,
      role: 'basis' as const,
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: T0,
      rulesAgreedAt: null,
    };
    await store.createAccount(account);
    await store.createPasskeyCredential({
      credentialId: 'cred-1',
      publicKey: new Uint8Array([1, 2, 3]),
      signCount: 0,
      accountId,
      createdAt: T0,
    });
    const begin = await startPasskeyReplace(store, ceremony, CONFIG, T0, account);
    if (!('challengeId' in begin)) {
      throw new Error('expected begin');
    }
    const finish = await finishPasskeyReplace(
      store,
      ceremony,
      CONFIG,
      T0,
      ORIGIN,
      begin.challengeId,
      { test: 'replace' },
      account,
    );
    expect(finish).toEqual({ ok: false, error: 'Invalid passkey' });
  });

  it('rejects an expired replace challenge', async () => {
    const { store, ceremony, accountId } = await seed();
    const account = await store.getAccount(accountId);
    if (account === undefined) {
      throw new Error('missing account');
    }
    const begin = await startPasskeyReplace(store, ceremony, CONFIG, T0, account);
    if (!('challengeId' in begin)) {
      throw new Error('expected begin');
    }
    const finish = await finishPasskeyReplace(
      store,
      ceremony,
      CONFIG,
      T0 + CHALLENGE_TTL_MS + 1,
      ORIGIN,
      begin.challengeId,
      { test: 'replace' },
      account,
    );
    expect(finish).toEqual({ ok: false, error: 'Challenge expired' });
  });
});
