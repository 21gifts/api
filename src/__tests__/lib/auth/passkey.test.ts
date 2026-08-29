import { describe, it, expect } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { CHALLENGE_TTL_MS } from '@/lib/config';
import type { WebAuthnRuntimeConfig } from '@/lib/config';
import {
  credentialIdFrom,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
  startPasskeyAuthentication,
  startPasskeyRegistration,
} from '@/lib/auth/passkey';
import { FakePasskeyCeremony } from '@/__tests__/helpers/fake-passkey';

const T0 = 1_000_000;
const CONFIG: WebAuthnRuntimeConfig = {
  rpId: 'localhost',
  rpName: '21.gifts',
  expectedOrigins: ['http://localhost:3000'],
};
const ORIGIN = 'http://localhost:3000';

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
    expect((await store.getPasskeyCredential('cred-1'))?.accountId).toBe(finish.value.account.id);
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
      override async createPasskeyCredential(): Promise<boolean> {
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
});
