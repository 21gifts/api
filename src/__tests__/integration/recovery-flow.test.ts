import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '@/server';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { InMemoryPushStore } from '@/lib/push-store';
import { recoveryMessage } from '@/lib/recovery-signature';
import { FakePasskeyCeremony } from '@/__tests__/helpers/fake-passkey';
import {
  PINNED,
  PINNED_PRIVATE_KEYS,
  RECOVERY_USERNAME,
  lookupHolds,
  lookupUserNotFound,
  scriptedLnurlFetch,
  seedPinnedAccount,
  signCompact,
  signedLookup,
  transferAccepted,
  transferBody,
} from '@/__tests__/helpers/recovery';
import { LNURL_SERVER } from '@/__tests__/helpers/wallet-lnurl';

const ORIGIN = 'http://localhost:3000';
const T0 = 1_700_000_000_000;
const TS = Math.floor(T0 / 1000);
const OLD_SESSION = 'e'.repeat(64);
const OLD_CREDENTIAL = 'old-passkey';

/**
 * One full social recovery through `createApp` on a memory boot, with the
 * pinned SDK signature: begin, finish, the address claim, sign-in with the new
 * passkey, and what the old key can do afterwards.
 */
describe('social recovery end to end via createApp', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  /** Which name each key holds on the fake LNURL server. */
  let names: Map<string, string>;
  /** Answer of the fake LNURL server to the next transfer. */
  let transferAnswer: () => Response;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    names = new Map([[PINNED.oldSparkPubkey, RECOVERY_USERNAME]]);
    transferAnswer = () => {
      names.delete(PINNED.oldSparkPubkey);
      names.set(PINNED.newSparkPubkey, RECOVERY_USERNAME);
      return transferAccepted(RECOVERY_USERNAME);
    };
  });

  afterEach(() => {
    warn.mockRestore();
  });

  async function boot(): Promise<{
    app: Hono;
    store: InMemoryAuthStore;
    push: InMemoryPushStore;
    calls: ReturnType<typeof scriptedLnurlFetch>['calls'];
  }> {
    const store = new InMemoryAuthStore();
    const push = new InMemoryPushStore();
    const { fetchImpl, calls } = scriptedLnurlFetch({
      recover: (pubkey) => {
        const name = names.get(pubkey);
        return name === undefined ? lookupUserNotFound() : lookupHolds(name);
      },
      transfer: () => transferAnswer(),
    });
    const app = createApp({
      authStore: store,
      pushStore: push,
      now: () => T0,
      allowedOrigins: [ORIGIN],
      webAuthnRpId: 'localhost',
      passkeyCeremony: new FakePasskeyCeremony({ challenge: PINNED.challenge }),
      env: { LNURL_SERVER_URL: LNURL_SERVER.baseUrl, PUBLIC_BASE_URL: LNURL_SERVER.publicBaseUrl },
      fetchImpl,
    });
    await seedPinnedAccount(store);
    await store.createPasskeyCredential({
      credentialId: OLD_CREDENTIAL,
      publicKey: Uint8Array.of(1, 2, 3),
      signCount: 4,
      accountId: PINNED.accountId,
      createdAt: 1,
    });
    await store.createSession({ token: OLD_SESSION, accountId: PINNED.accountId, createdAt: T0 });
    await push.upsertSubscription({
      endpoint: 'https://push.test/old-phone',
      accountId: PINNED.accountId,
      p256dh: 'p',
      auth: 'a',
      createdAt: new Date(T0),
      sessionToken: null,
    });
    return { app, store, push, calls };
  }

  function post(app: Hono, path: string, body: unknown): Promise<Response> {
    return Promise.resolve(
      app.request(path, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }

  function begin(app: Hono): Promise<Response> {
    return post(app, '/auth/passkey/recovery/begin', {
      sparkPubkey: PINNED.oldSparkPubkey,
      lookup: signedLookup(PINNED.oldSparkPubkey, PINNED_PRIVATE_KEYS.old, TS),
    });
  }

  function finishBody(challengeId: string, newSparkPubkey: string = PINNED.newSparkPubkey) {
    const signature =
      newSparkPubkey === PINNED.newSparkPubkey
        ? PINNED.signature
        : signCompact(
            recoveryMessage({
              accountId: PINNED.accountId,
              challenge: PINNED.challenge,
              credentialId: PINNED.credentialId,
              newSparkPubkey,
            }),
            PINNED_PRIVATE_KEYS.old,
          );
    return {
      challengeId,
      credential: { test: 'recovery', id: PINNED.credentialId },
      newSparkPubkey,
      signature: { pubkey: PINNED.oldSparkPubkey, signature },
    };
  }

  function claim(app: Hono): Promise<Response> {
    return post(
      app,
      `/lnurlpay/${PINNED.newSparkPubkey}/transfer`,
      transferBody({
        username: RECOVERY_USERNAME,
        fromPubkey: PINNED.oldSparkPubkey,
        fromPrivKey: PINNED_PRIVATE_KEYS.old,
        toPubkey: PINNED.newSparkPubkey,
        toPrivKey: PINNED_PRIVATE_KEYS.new,
        timestamp: TS,
      }),
    );
  }

  async function me(app: Hono, token: string): Promise<Response> {
    return app.request('/me', { headers: { authorization: `Bearer ${token}` } });
  }

  async function begunAndFinished(app: Hono): Promise<string> {
    const begun = await begin(app);
    expect(begun.status).toBe(200);
    const { challengeId } = (await begun.json()) as { challengeId: string };
    const finished = await post(app, '/auth/passkey/recovery/finish', finishBody(challengeId));
    expect(finished.status).toBe(200);
    expect(await finished.json()).toEqual({ status: 'pending' });
    return challengeId;
  }

  it('recovers the account onto the new passkey and wallet exactly once', async () => {
    const { app, store, push, calls } = await boot();

    const begun = await begin(app);
    expect(begun.status).toBe(200);
    const started = (await begun.json()) as {
      challengeId: string;
      options: { challenge: string; user: { id: string } };
      accountId: string;
      username: string;
    };
    expect(started.accountId).toBe(PINNED.accountId);
    expect(started.username).toBe(RECOVERY_USERNAME);
    expect(started.options.challenge).toBe(PINNED.challenge);
    expect(started.options.user.id).toBe(PINNED.accountId);

    const finishPath = '/auth/passkey/recovery/finish';
    const finished = await post(app, finishPath, finishBody(started.challengeId));
    expect(finished.status).toBe(200);
    const before = await me(app, OLD_SESSION);
    expect(((await before.json()) as { sparkPubkey: string }).sparkPubkey).toBe(
      PINNED.oldSparkPubkey,
    );

    const claimed = await claim(app);
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toEqual({
      lnurl: 'lnurlp://example.test/lnurlp/ada',
      lightning_address: 'ada@example.test',
    });
    expect((await me(app, OLD_SESSION)).status).toBe(401);
    expect(await push.listByAccount(PINNED.accountId)).toEqual([]);
    expect(await store.getPasskeyCredential(OLD_CREDENTIAL)).toBeUndefined();

    const authBegin = await app.request('/auth/passkey/authenticate/begin', { method: 'POST' });
    const { challengeId: authChallenge } = (await authBegin.json()) as { challengeId: string };
    const signedIn = await post(app, '/auth/passkey/authenticate/finish', {
      challengeId: authChallenge,
      credential: { test: 'ok', id: PINNED.credentialId },
    });
    expect(signedIn.status).toBe(200);
    const session = (await signedIn.json()) as {
      token: string;
      account: { id: string; sparkPubkey: string; sparkWalletVerified: boolean; username: string };
    };
    expect(session.account).toEqual(
      expect.objectContaining({
        id: PINNED.accountId,
        sparkPubkey: PINNED.newSparkPubkey,
        sparkWalletVerified: true,
        username: RECOVERY_USERNAME,
      }),
    );
    expect((await me(app, session.token)).status).toBe(200);

    const again = await begin(app);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error: 'This account was already recovered. Sign in with the new passkey.',
      code: 'recovery_done',
    });

    const lookupsBefore = calls.length;
    const oldLookup = await app.request(`/lnurlpay/${PINNED.oldSparkPubkey}/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signedLookup(PINNED.oldSparkPubkey, PINNED_PRIVATE_KEYS.old, TS)),
    });
    expect(oldLookup.status).toBe(404);
    expect(calls).toHaveLength(lookupsBefore);

    expect(
      await store.commitRecovery({
        accountId: PINNED.accountId,
        newSparkPubkey: PINNED.newSparkPubkey,
        now: T0,
      }),
    ).toBe('gone');

    const replay = await post(app, finishPath, finishBody(started.challengeId));
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: 'Invalid recovery signature' });
    expect(await store.listPreviousWallets(PINNED.accountId)).toHaveLength(1);
  });

  it('answers a repeat of the stored finish again and changes nothing', async () => {
    const { app, store } = await boot();
    const challengeId = await begunAndFinished(app);
    const stored = await store.getPendingRecovery(PINNED.accountId, T0);
    const repeat = await post(app, '/auth/passkey/recovery/finish', finishBody(challengeId));
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ status: 'pending' });
    expect(await store.getPendingRecovery(PINNED.accountId, T0)).toEqual(stored);
    expect((await store.getAccount(PINNED.accountId))?.sparkPubkey).toBe(PINNED.oldSparkPubkey);
  });

  it('never replaces a forwarded pending recovery', async () => {
    const { app, store } = await boot();
    transferAnswer = () => new Response('"internal server error"', { status: 500 });
    const challengeId = await begunAndFinished(app);
    expect((await claim(app)).status).toBe(503);
    const forwarded = await store.getPendingRecovery(PINNED.accountId, T0);
    expect(forwarded?.forwardedAt).toBe(T0);

    const otherKey = `02${'1'.repeat(63)}2`;
    const sameChallenge = await post(
      app,
      '/auth/passkey/recovery/finish',
      finishBody(challengeId, otherKey),
    );
    expect(sameChallenge.status).toBe(400);
    expect(await sameChallenge.json()).toEqual({ error: 'Challenge already used' });

    const stale = 'a'.repeat(64);
    await store.createPasskeyChallenge({
      id: stale,
      type: 'recovery',
      challenge: PINNED.challenge,
      accountId: PINNED.accountId,
      consumed: false,
      createdAt: T0,
    });
    const freshChallenge = await post(
      app,
      '/auth/passkey/recovery/finish',
      finishBody(stale, otherKey),
    );
    expect(freshChallenge.status).toBe(409);
    expect(await freshChallenge.json()).toEqual({ error: 'A recovery is already pending' });

    const kept = await begin(app);
    expect(kept.status).toBe(503);
    expect(await store.getPendingRecovery(PINNED.accountId, T0)).toEqual(forwarded);
  });
});
