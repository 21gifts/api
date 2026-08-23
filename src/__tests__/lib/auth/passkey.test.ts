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
    expect(store.getPasskeyCredential('cred-1')?.accountId).toBe(finish.value.account.id);
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
    store.createPasskeyChallenge({
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
    expect(store.getPasskeyCredential('cred-1')?.signCount).toBe(1);
  });

  it('rejects authentication when the account is gone', async () => {
    const store = new InMemoryAuthStore();
    const ceremony = new FakePasskeyCeremony();
    store.createPasskeyCredential({
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
});
