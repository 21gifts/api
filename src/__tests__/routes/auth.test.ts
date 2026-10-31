import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore, type PasskeyRenewAttemptInput } from '@/lib/auth/store';
import { InMemoryMessageStore } from '@/lib/message-store';
import { WRONG_ACCOUNT_ERROR } from '@/lib/auth/wrong-account';
import { RECOVERY_SETTLE_AFTER_MS } from '@/lib/auth/recovery';
import { CHALLENGE_TTL_MS } from '@/lib/config';
import type { FetchFn } from '@/lib/lnurlp';
import { LOGINS_CLOSED_CODE, LOGINS_CLOSED_ERROR, LoginGate } from '@/lib/login-gate';
import { InMemoryLoginGateStore } from '@/lib/login-gate-store';
import { authRoutes } from '@/routes/auth';
import { FakePasskeyCeremony } from '@/__tests__/helpers/fake-passkey';
import {
  PINNED,
  RECOVERY_USERNAME,
  lookupHolds,
  lookupUserNotFound,
  scriptedLnurlFetch,
  seedPinnedAccount,
  stagePendingRecovery,
} from '@/__tests__/helpers/recovery';
import { LNURL_SERVER } from '@/__tests__/helpers/wallet-lnurl';
import { meRoutes } from '@/routes/me';

const now = (): number => 1_000_000;
const ORIGIN = 'http://localhost:3000';
const REFUSED_ID = '00000000-0000-4000-8000-0000000000ff';

function mount(store: InMemoryAuthStore, webAuthnRpId: string | undefined = 'localhost'): Hono {
  return new Hono().route(
    '/auth',
    authRoutes({
      store,
      now,
      allowedOrigins: [ORIGIN],
      webAuthnRpId,
      webAuthnRpName: undefined,
      passkeyCeremony: new FakePasskeyCeremony(),
      messages: new InMemoryMessageStore(),
    }),
  );
}

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

describe('auth routes', () => {
  it('wires an injected nostrKeygen with a KEK', async () => {
    const { generateSecretKey } = await import('nostr-tools/pure');
    const store = new InMemoryAuthStore();
    const app = new Hono().route(
      '/auth',
      authRoutes({
        store,
        now,
        allowedOrigins: [ORIGIN],
        webAuthnRpId: 'localhost',
        webAuthnRpName: undefined,
        passkeyCeremony: new FakePasskeyCeremony(),
        messages: new InMemoryMessageStore(),
        nostrKek: new Uint8Array(32).fill(8),
        nostrKeygen: { generateSecretKey },
      }),
    );
    const begin = await app.request('/auth/passkey/register/begin', {
      method: 'POST',
      headers: { origin: ORIGIN },
    });
    expect(begin.status).toBe(200);
    const body = (await begin.json()) as { challengeId: string };
    const finish = await app.request('/auth/passkey/register/finish', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: body.challengeId, credential: { test: 'ok' } }),
    });
    expect(finish.status).toBe(200);
  });

  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe('POST /auth/passkey/register', () => {
    it('returns 500 when WEBAUTHN_RP_ID is not configured', async () => {
      const res = await mount(new InMemoryAuthStore(), '').request('/auth/passkey/register/begin', {
        method: 'POST',
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Server auth is not configured' });
    });

    it('returns 500 on finish when WEBAUTHN_RP_ID is not configured', async () => {
      const res = await mount(new InMemoryAuthStore(), '').request(
        '/auth/passkey/register/finish',
        { method: 'POST' },
      );
      expect(res.status).toBe(500);
    });

    it('issues creation options', async () => {
      const res = await mount(new InMemoryAuthStore()).request('/auth/passkey/register/begin', {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { challengeId: string; options: { challenge: string } };
      expect(body.challengeId).toMatch(/^[0-9a-f]{64}$/);
      expect(body.options.challenge).toBe('test-challenge');
    });

    it('issues claim options for a provisioned viewKey', async () => {
      const store = new InMemoryAuthStore();
      const viewKey = 'a'.repeat(64);
      await store.createAccount({
        id: 'provisioned',
        linkingKey: null,
        role: 'basis',
        name: 'Ada',
        forumLawsDismissed: false,
        location: null,
        viewKey,
        createdAt: 1,
        rulesAgreedAt: null,
      });
      const res = await mount(store).request('/auth/passkey/register/begin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ viewKey }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        challengeId: string;
        options: { user: { displayName: string; name: string } };
        ok?: unknown;
        value?: unknown;
      };
      expect(body.challengeId).toMatch(/^[0-9a-f]{64}$/);
      expect(body.options.user.displayName).toBe('Ada');
      expect(body.options.user.name).toBe('provisioned');
      expect(body).not.toHaveProperty('ok');
      expect(body).not.toHaveProperty('value');
      expect((await store.listAccounts()).map((row) => row.id)).toEqual(['provisioned']);
    });

    it('returns 404 when begin viewKey is unknown', async () => {
      const res = await mount(new InMemoryAuthStore()).request('/auth/passkey/register/begin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ viewKey: 'b'.repeat(64) }),
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'This profile could not be found.' });
    });

    it('returns 409 when begin viewKey already has a passkey', async () => {
      const store = new InMemoryAuthStore();
      const viewKey = 'c'.repeat(64);
      await store.createAccount({
        id: 'provisioned',
        linkingKey: null,
        role: 'basis',
        name: 'Ada',
        forumLawsDismissed: false,
        location: null,
        viewKey,
        createdAt: 1,
        rulesAgreedAt: null,
      });
      await store.createPasskeyCredential({
        credentialId: 'cred-1',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: 'provisioned',
        createdAt: 1,
      });
      const res = await mount(store).request('/auth/passkey/register/begin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ viewKey }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'This profile already has a passkey' });
      const logged = parsedEvents(warn).find((e) => e['event'] === 'auth.passkey.register.fail');
      expect(logged).toMatchObject({
        event: 'auth.passkey.register.fail',
        error: 'This profile already has a passkey',
      });
      expect(JSON.stringify(logged)).not.toContain(viewKey);
    });

    it('returns 400 when begin viewKey is not a string', async () => {
      const res = await mount(new InMemoryAuthStore()).request('/auth/passkey/register/begin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ viewKey: 12 }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Expected a JSON body with an optional "viewKey" string',
      });
      const logged = parsedEvents(warn).find((e) => e['event'] === 'auth.passkey.register.fail');
      expect(logged).toEqual({
        ts: expect.any(String),
        event: 'auth.passkey.register.fail',
        error: 'Expected a JSON body with an optional "viewKey" string',
      });
    });

    it('rejects a missing finish body', async () => {
      const res = await mount(new InMemoryAuthStore()).request('/auth/passkey/register/finish', {
        method: 'POST',
        headers: { origin: ORIGIN },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Expected a JSON body with challengeId and credential',
      });
      const logged = parsedEvents(warn).find((e) => e['event'] === 'auth.passkey.register.fail');
      expect(logged).toMatchObject({
        event: 'auth.passkey.register.fail',
        error: 'Expected a JSON body with challengeId and credential',
        json: 'absent',
        bodyBytes: 0,
      });
      expect(logged).not.toHaveProperty('challengeId');
      expect(logged).not.toHaveProperty('accountId');
    });

    it('rejects invalid JSON on register begin and does not open a challenge', async () => {
      const store = new InMemoryAuthStore();
      const raw = '{"viewKey":"secret-view"';
      const res = await mount(store).request('/auth/passkey/register/begin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Begin body is not valid JSON' });
      expect(await store.listPasskeyChallenges()).toEqual([]);
      const logged = parsedEvents(warn).find((e) => e['event'] === 'auth.passkey.register.fail');
      expect(logged).toMatchObject({
        event: 'auth.passkey.register.fail',
        error: 'Begin body is not valid JSON',
        json: 'invalid',
        bodyBytes: raw.length,
      });
      expect(logged).not.toHaveProperty('viewKey');
      expect(JSON.stringify(logged)).not.toContain('secret-view');
    });

    it('does not log a registration challenge id that is not 64 lowercase hex', async () => {
      const res = await mount(new InMemoryAuthStore()).request('/auth/passkey/register/finish', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ challengeId: 'not-a-challenge', credential: { test: 'ok' } }),
      });
      expect(await res.json()).toEqual({ error: 'Unknown or expired challenge' });
      const logged = parsedEvents(warn).find((e) => e['event'] === 'auth.passkey.register.fail');
      expect(logged).toMatchObject({
        event: 'auth.passkey.register.fail',
        error: 'Unknown or expired challenge',
      });
      expect(logged).not.toHaveProperty('challengeId');
    });

    it('rejects a missing origin on finish', async () => {
      const store = new InMemoryAuthStore();
      const app = mount(store);
      const begin = (await (
        await app.request('/auth/passkey/register/begin', { method: 'POST' })
      ).json()) as { challengeId: string };
      const res = await app.request('/auth/passkey/register/finish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challengeId: begin.challengeId, credential: { test: 'ok' } }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid origin' });
    });

    it('registers and issues a session with linkingKey null', async () => {
      const store = new InMemoryAuthStore();
      const app = mount(store);
      const begin = (await (
        await app.request('/auth/passkey/register/begin', { method: 'POST' })
      ).json()) as { challengeId: string };
      const res = await app.request('/auth/passkey/register/finish', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ challengeId: begin.challengeId, credential: { test: 'ok' } }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        token: string;
        account: {
          id: string;
          linkingKey: string | null;
          viewKey: string;
          hasPosted: boolean;
          setup: string;
        };
      };
      expect(body.token).toMatch(/^[0-9a-f]{64}$/);
      expect(body.account.linkingKey).toBeNull();
      expect(body.account.viewKey).toMatch(/^[0-9a-f]{64}$/);
      expect(body.account.hasPosted).toBe(false);
      expect(body.account.setup).toBe('name');
      const stored = await store.getAccount(body.account.id);
      expect(stored?.name).toBeNull();
      expect(stored?.username).toBeUndefined();
      expect(stored?.nameSkippedAt).toBeNull();
      expect(
        parsedEvents(warn).some(
          (e) => e['event'] === 'auth.passkey.register.ok' && e['accountId'] === body.account.id,
        ),
      ).toBe(true);

      const meApp = new Hono().route(
        '/me',
        meRoutes({
          store,
          messages: new InMemoryMessageStore(),
          now,
        }),
      );
      const me = await meApp.request('/me', { headers: { authorization: `Bearer ${body.token}` } });
      expect(me.status).toBe(200);
      expect(((await me.json()) as { linkingKey: string | null }).linkingKey).toBeNull();
    });

    it('rejects a used registration challenge', async () => {
      const app = mount(new InMemoryAuthStore());
      const begin = (await (
        await app.request('/auth/passkey/register/begin', { method: 'POST' })
      ).json()) as { challengeId: string };
      const body = JSON.stringify({ challengeId: begin.challengeId, credential: { test: 'ok' } });
      const headers = { 'content-type': 'application/json', origin: ORIGIN };
      await app.request('/auth/passkey/register/finish', { method: 'POST', headers, body });
      const res = await app.request('/auth/passkey/register/finish', {
        method: 'POST',
        headers,
        body,
      });
      expect(await res.json()).toEqual({ error: 'Challenge already used' });
    });

    it('rejects an invalid passkey on register', async () => {
      const app = mount(new InMemoryAuthStore());
      const begin = (await (
        await app.request('/auth/passkey/register/begin', { method: 'POST' })
      ).json()) as { challengeId: string };
      const res = await app.request('/auth/passkey/register/finish', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ challengeId: begin.challengeId, credential: { test: 'nope' } }),
      });
      expect(await res.json()).toEqual({ error: 'Invalid passkey' });
    });

    it('returns 403 when finishing registration for a sessionRefused account', async () => {
      const store = new InMemoryAuthStore();
      const viewKey = 'a'.repeat(64);
      await store.createAccount({
        id: REFUSED_ID,
        linkingKey: null,
        role: 'basis',
        name: null,
        forumLawsDismissed: false,
        location: null,
        viewKey,
        createdAt: 1,
        rulesAgreedAt: null,
        sessionRefused: true,
      });
      const app = mount(store);
      const begin = await app.request('/auth/passkey/register/begin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ viewKey }),
      });
      expect(begin.status).toBe(200);
      const { challengeId } = (await begin.json()) as { challengeId: string };
      const res = await app.request('/auth/passkey/register/finish', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ challengeId, credential: { test: 'ok' } }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: WRONG_ACCOUNT_ERROR });
      expect(parsedEvents(warn).some((e) => e['event'] === 'auth.passkey.register.ok')).toBe(false);
    });

    it('rejects finishing an authenticate challenge as register', async () => {
      const app = mount(new InMemoryAuthStore());
      const begin = (await (
        await app.request('/auth/passkey/authenticate/begin', { method: 'POST' })
      ).json()) as { challengeId: string };
      const res = await app.request('/auth/passkey/register/finish', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ challengeId: begin.challengeId, credential: { test: 'ok' } }),
      });
      expect(await res.json()).toEqual({ error: 'Wrong challenge type' });
    });

    it('returns 400 when begin name is a number', async () => {
      const store = new InMemoryAuthStore();
      const res = await mount(store).request('/auth/passkey/register/begin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 1 }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Expected a JSON body with an optional "name" string',
      });
      expect(await store.listPasskeyChallenges()).toEqual([]);
    });

    it('returns 400 when begin name is null', async () => {
      const store = new InMemoryAuthStore();
      const res = await mount(store).request('/auth/passkey/register/begin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: null }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Expected a JSON body with an optional "name" string',
      });
      expect(await store.listPasskeyChallenges()).toEqual([]);
    });

    it('returns 400 when begin name is empty', async () => {
      const store = new InMemoryAuthStore();
      const res = await mount(store).request('/auth/passkey/register/begin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Username must be 1–32 characters of a-z, 0-9, hyphen, underscore, or dot',
      });
      expect(await store.listPasskeyChallenges()).toEqual([]);
    });

    it('returns 400 when begin name is not a valid username', async () => {
      const store = new InMemoryAuthStore();
      const res = await mount(store).request('/auth/passkey/register/begin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ada Lovelace' }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Username must be 1–32 characters of a-z, 0-9, hyphen, underscore, or dot',
      });
      expect(await store.listPasskeyChallenges()).toEqual([]);
    });

    it('returns 400 when begin name starts with a dot', async () => {
      const store = new InMemoryAuthStore();
      const res = await mount(store).request('/auth/passkey/register/begin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '.ada' }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Username must be 1–32 characters of a-z, 0-9, hyphen, underscore, or dot',
      });
      expect(await store.listPasskeyChallenges()).toEqual([]);
    });

    it('returns 400 when begin name is a lone underscore', async () => {
      const store = new InMemoryAuthStore();
      const res = await mount(store).request('/auth/passkey/register/begin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '_' }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Username must be 1–32 characters of a-z, 0-9, hyphen, underscore, or dot',
      });
      expect(await store.listPasskeyChallenges()).toEqual([]);
    });

    it('returns 400 when begin name is 33 characters', async () => {
      const store = new InMemoryAuthStore();
      const res = await mount(store).request('/auth/passkey/register/begin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'a'.repeat(33) }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Username must be 1–32 characters of a-z, 0-9, hyphen, underscore, or dot',
      });
      expect(await store.listPasskeyChallenges()).toEqual([]);
    });

    it('issues options for a 32-character begin name', async () => {
      const store = new InMemoryAuthStore();
      const name = 'a' + 'b'.repeat(31);
      const res = await mount(store).request('/auth/passkey/register/begin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        options: { user: { id: string; name: string; displayName: string } };
      };
      expect(body.options.user.name).toBe(name);
      expect(body.options.user.displayName).toBe(name);
      expect(body.options.user.id).not.toBe(name);
    });

    it('returns 409 when begin name is already in use', async () => {
      const store = new InMemoryAuthStore();
      await store.createAccount({
        id: 'taken',
        linkingKey: null,
        role: 'basis',
        name: 'Ada',
        username: 'ada',
        forumLawsDismissed: false,
        location: null,
        viewKey: 'e'.repeat(64),
        createdAt: 1,
        rulesAgreedAt: null,
      });
      const res = await mount(store).request('/auth/passkey/register/begin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ada' }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'Username is already in use' });
      expect(await store.listPasskeyChallenges()).toEqual([]);
    });

    it('issues nameless options when begin has no body', async () => {
      const store = new InMemoryAuthStore();
      const res = await mount(store).request('/auth/passkey/register/begin', {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        options: { user: { name: string; displayName: string } };
      };
      const challenge = (await store.listPasskeyChallenges())[0];
      expect(challenge?.requestedName).toBeNull();
      expect(body.options.user.displayName).toBe('21.gifts');
      expect(body.options.user.name).toBe(challenge?.accountId);
    });

    it('issues nameless options when begin body is empty', async () => {
      const store = new InMemoryAuthStore();
      const res = await mount(store).request('/auth/passkey/register/begin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        options: { user: { name: string; displayName: string } };
      };
      const challenge = (await store.listPasskeyChallenges())[0];
      expect(challenge?.requestedName).toBeNull();
      expect(body.options.user.displayName).toBe('21.gifts');
      expect(body.options.user.name).toBe(challenge?.accountId);
    });

    it('issues nameless options when begin has no name field', async () => {
      const store = new InMemoryAuthStore();
      const res = await mount(store).request('/auth/passkey/register/begin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ extra: true }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        options: { user: { name: string; displayName: string } };
      };
      const challenge = (await store.listPasskeyChallenges())[0];
      expect(challenge?.requestedName).toBeNull();
      expect(body.options.user.displayName).toBe('21.gifts');
      expect(body.options.user.name).toBe(challenge?.accountId);
    });

    it('registers a named account from begin name Ada', async () => {
      const store = new InMemoryAuthStore();
      const app = mount(store);
      const begin = await app.request('/auth/passkey/register/begin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ada' }),
      });
      expect(begin.status).toBe(200);
      const started = (await begin.json()) as {
        challengeId: string;
        options: { user: { id: string; name: string; displayName: string } };
      };
      const challenge = (await store.listPasskeyChallenges())[0];
      expect(challenge?.requestedName).toBe('ada');
      expect(started.options.user.name).toBe('ada');
      expect(started.options.user.displayName).toBe('ada');
      expect(started.options.user.id).toBe(challenge?.accountId);
      expect(started.options.user.id).not.toBe('ada');
      const res = await app.request('/auth/passkey/register/finish', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ challengeId: started.challengeId, credential: { test: 'ok' } }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        account: {
          name: string | null;
          username: string | null;
          setup: string;
        };
      };
      expect(body.account.name).toBe('ada');
      expect(body.account.username).toBe('ada');
      expect(body.account.setup).toBe('lightning-address');
      const stored = await store.getAccount(challenge?.accountId ?? '');
      expect(stored?.name).toBe('ada');
      expect(stored?.username).toBe('ada');
      expect(stored?.nameSkippedAt).toBeNull();
      expect(await store.getPasskeyCredential('cred-1')).toBeDefined();
    });

    it('returns 409 when the name is taken between begin and finish', async () => {
      const store = new InMemoryAuthStore();
      const app = mount(store);
      const begin = await app.request('/auth/passkey/register/begin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ada' }),
      });
      expect(begin.status).toBe(200);
      const { challengeId } = (await begin.json()) as { challengeId: string };
      const pendingId = (await store.listPasskeyChallenges())[0]?.accountId;
      await store.createAccount({
        id: 'other',
        linkingKey: null,
        role: 'basis',
        name: 'Ada',
        username: 'ada',
        forumLawsDismissed: false,
        location: null,
        viewKey: 'd'.repeat(64),
        createdAt: 1,
        rulesAgreedAt: null,
      });
      const res = await app.request('/auth/passkey/register/finish', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ challengeId, credential: { test: 'ok' } }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'Username is already in use' });
      expect(await store.getPasskeyCredential('cred-1')).toBeUndefined();
      expect(await store.getAccount(pendingId ?? '')).toBeUndefined();
    });

    it('ignores name on finish and keeps the challenge handle', async () => {
      const store = new InMemoryAuthStore();
      const app = mount(store);
      const begin = await app.request('/auth/passkey/register/begin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ada' }),
      });
      const { challengeId } = (await begin.json()) as { challengeId: string };
      const res = await app.request('/auth/passkey/register/finish', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({
          challengeId,
          credential: { test: 'ok' },
          name: 'bob',
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        account: { name: string | null; username: string | null };
      };
      expect(body.account.name).toBe('ada');
      expect(body.account.username).toBe('ada');
    });

    it('ignores name when begin claims with viewKey', async () => {
      const store = new InMemoryAuthStore();
      const viewKey = 'a'.repeat(64);
      await store.createAccount({
        id: 'provisioned',
        linkingKey: null,
        role: 'basis',
        name: 'Ada',
        forumLawsDismissed: false,
        location: null,
        viewKey,
        createdAt: 1,
        rulesAgreedAt: null,
      });
      const res = await mount(store).request('/auth/passkey/register/begin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ viewKey, name: 12 }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        options: { user: { displayName: string; name: string } };
      };
      expect(body.options.user.displayName).toBe('Ada');
      expect(body.options.user.name).toBe('provisioned');
      expect((await store.listAccounts()).map((row) => row.id)).toEqual(['provisioned']);
    });
  });

  describe('POST /auth/passkey/authenticate', () => {
    async function register(app: Hono): Promise<{ token: string; accountId: string }> {
      const begin = (await (
        await app.request('/auth/passkey/register/begin', { method: 'POST' })
      ).json()) as { challengeId: string };
      const res = await app.request('/auth/passkey/register/finish', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ challengeId: begin.challengeId, credential: { test: 'ok' } }),
      });
      const body = (await res.json()) as { token: string; account: { id: string } };
      return { token: body.token, accountId: body.account.id };
    }

    it('returns 500 when unconfigured', async () => {
      const res = await mount(new InMemoryAuthStore(), '').request(
        '/auth/passkey/authenticate/begin',
        { method: 'POST' },
      );
      expect(res.status).toBe(500);
      const logged = parsedEvents(warn).find((e) => e['event'] === 'auth.passkey.login.fail');
      expect(logged).toMatchObject({
        event: 'auth.passkey.login.fail',
        error: 'Server auth is not configured',
      });
      expect(logged).not.toHaveProperty('accountId');
    });

    it('returns 500 on finish when unconfigured', async () => {
      const res = await mount(new InMemoryAuthStore(), '').request(
        '/auth/passkey/authenticate/finish',
        { method: 'POST' },
      );
      expect(res.status).toBe(500);
      const logged = parsedEvents(warn).find((e) => e['event'] === 'auth.passkey.login.fail');
      expect(logged).toMatchObject({
        event: 'auth.passkey.login.fail',
        error: 'Server auth is not configured',
      });
    });

    it('rejects a missing finish body', async () => {
      const res = await mount(new InMemoryAuthStore()).request(
        '/auth/passkey/authenticate/finish',
        { method: 'POST', headers: { origin: ORIGIN } },
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Expected a JSON body with challengeId and credential',
      });
      const logged = parsedEvents(warn).find((e) => e['event'] === 'auth.passkey.login.fail');
      expect(logged).toMatchObject({
        event: 'auth.passkey.login.fail',
        error: 'Expected a JSON body with challengeId and credential',
        json: 'absent',
        bodyBytes: 0,
      });
      expect(logged).not.toHaveProperty('challengeId');
      expect(logged).not.toHaveProperty('accountId');
    });

    it('logs invalid JSON on login finish and keeps no credential', async () => {
      const raw = '{"credential":"cred-secret"';
      const res = await mount(new InMemoryAuthStore()).request(
        '/auth/passkey/authenticate/finish',
        {
          method: 'POST',
          headers: { origin: ORIGIN, 'content-type': 'application/json' },
          body: raw,
        },
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Finish body is not valid JSON' });
      const logged = parsedEvents(warn).find((e) => e['event'] === 'auth.passkey.login.fail');
      expect(logged).toMatchObject({
        event: 'auth.passkey.login.fail',
        error: 'Finish body is not valid JSON',
        json: 'invalid',
        bodyBytes: raw.length,
      });
      expect(logged).not.toHaveProperty('challengeId');
      expect(logged).not.toHaveProperty('hasCredential');
      expect(JSON.stringify(logged)).not.toContain('cred-secret');
    });

    it('logs a challenge id when the login finish body has no credential', async () => {
      const challengeId = 'ab'.repeat(32);
      const payload = JSON.stringify({ challengeId, leftover: 'cred-secret' });
      const res = await mount(new InMemoryAuthStore()).request(
        '/auth/passkey/authenticate/finish',
        {
          method: 'POST',
          headers: { origin: ORIGIN, 'content-type': 'application/json' },
          body: payload,
        },
      );
      expect(res.status).toBe(400);
      const logged = parsedEvents(warn).find((e) => e['event'] === 'auth.passkey.login.fail');
      expect(logged).toMatchObject({
        event: 'auth.passkey.login.fail',
        error: 'Expected a JSON body with challengeId and credential',
        challengeId,
        json: 'parsed',
        bodyKind: 'object',
        hasCredential: false,
        challengeIdKind: 'string',
        bodyBytes: payload.length,
      });
      expect(JSON.stringify(logged)).not.toContain('cred-secret');
      expect(logged).not.toHaveProperty('accountId');
    });

    it('drops a non-hex challenge id and never logs the credential', async () => {
      const nonHex = await mount(new InMemoryAuthStore()).request(
        '/auth/passkey/authenticate/finish',
        {
          method: 'POST',
          headers: { origin: ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({ challengeId: 'nope' }),
        },
      );
      expect(nonHex.status).toBe(400);
      const nonHexLog = parsedEvents(warn).find((e) => e['event'] === 'auth.passkey.login.fail');
      expect(nonHexLog).toMatchObject({
        event: 'auth.passkey.login.fail',
        error: 'Expected a JSON body with challengeId and credential',
        json: 'parsed',
        bodyKind: 'object',
        hasCredential: false,
        challengeIdKind: 'string',
      });
      expect(nonHexLog).not.toHaveProperty('challengeId');
      expect(JSON.stringify(nonHexLog)).not.toContain('nope');
      warn.mockClear();
      const credentialOnly = await mount(new InMemoryAuthStore()).request(
        '/auth/passkey/authenticate/finish',
        {
          method: 'POST',
          headers: { origin: ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({ credential: { id: 'cred-secret', signature: 'sig-secret' } }),
        },
      );
      expect(credentialOnly.status).toBe(400);
      const logged = parsedEvents(warn).find((e) => e['event'] === 'auth.passkey.login.fail');
      expect(logged).toMatchObject({
        event: 'auth.passkey.login.fail',
        error: 'Expected a JSON body with challengeId and credential',
        json: 'parsed',
        bodyKind: 'object',
        hasCredential: true,
        challengeIdKind: 'absent',
      });
      expect(logged).not.toHaveProperty('challengeId');
      expect(JSON.stringify(logged)).not.toContain('cred-secret');
      expect(JSON.stringify(logged)).not.toContain('sig-secret');
    });

    it('drops a numeric challenge id and an array body', async () => {
      const numeric = await mount(new InMemoryAuthStore()).request(
        '/auth/passkey/authenticate/finish',
        {
          method: 'POST',
          headers: { origin: ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({ challengeId: 4 }),
        },
      );
      expect(numeric.status).toBe(400);
      const numericLog = parsedEvents(warn).find((e) => e['event'] === 'auth.passkey.login.fail');
      expect(numericLog).toMatchObject({
        json: 'parsed',
        bodyKind: 'object',
        hasCredential: false,
        challengeIdKind: 'number',
      });
      expect(numericLog).not.toHaveProperty('challengeId');
      expect(Object.values(numericLog ?? {})).not.toContain(4);
      warn.mockClear();
      const arrayBody = await mount(new InMemoryAuthStore()).request(
        '/auth/passkey/authenticate/finish',
        {
          method: 'POST',
          headers: { origin: ORIGIN, 'content-type': 'application/json' },
          body: '[]',
        },
      );
      expect(arrayBody.status).toBe(400);
      const arrayLog = parsedEvents(warn).find((e) => e['event'] === 'auth.passkey.login.fail');
      expect(arrayLog).toMatchObject({
        event: 'auth.passkey.login.fail',
        error: 'Expected a JSON body with challengeId and credential',
        json: 'parsed',
        bodyKind: 'array',
        bodyBytes: 2,
      });
      expect(arrayLog).not.toHaveProperty('challengeId');
      expect(arrayLog).not.toHaveProperty('hasCredential');
    });

    it('logs a parsed login finish body by kind and never its values', async () => {
      const cases: Array<{ body: string; fields: Record<string, unknown>; secret?: string }> = [
        { body: 'null', fields: { bodyKind: 'null', bodyBytes: 4 } },
        {
          body: '"cred-secret"',
          fields: { bodyKind: 'string', bodyBytes: '"cred-secret"'.length },
          secret: 'cred-secret',
        },
        {
          body: JSON.stringify({ challengeId: { id: 'cred-secret' } }),
          fields: { bodyKind: 'object', hasCredential: false, challengeIdKind: 'object' },
          secret: 'cred-secret',
        },
        {
          body: JSON.stringify({ challengeId: ['cred-secret'] }),
          fields: { bodyKind: 'object', hasCredential: false, challengeIdKind: 'array' },
          secret: 'cred-secret',
        },
        {
          body: JSON.stringify({ challengeId: null }),
          fields: { bodyKind: 'object', hasCredential: false, challengeIdKind: 'null' },
        },
      ];
      for (const item of cases) {
        warn.mockClear();
        const res = await mount(new InMemoryAuthStore()).request(
          '/auth/passkey/authenticate/finish',
          {
            method: 'POST',
            headers: { origin: ORIGIN, 'content-type': 'application/json' },
            body: item.body,
          },
        );
        expect(res.status).toBe(400);
        const logged = parsedEvents(warn).find((e) => e['event'] === 'auth.passkey.login.fail');
        expect(logged).toMatchObject({
          event: 'auth.passkey.login.fail',
          error: 'Expected a JSON body with challengeId and credential',
          json: 'parsed',
          ...item.fields,
        });
        expect(logged).not.toHaveProperty('challengeId');
        if (item.secret !== undefined) {
          expect(JSON.stringify(logged)).not.toContain(item.secret);
        }
      }
    });

    it('authenticates a registered credential', async () => {
      const app = mount(new InMemoryAuthStore());
      const { accountId } = await register(app);
      const begin = (await (
        await app.request('/auth/passkey/authenticate/begin', { method: 'POST' })
      ).json()) as { challengeId: string };
      const res = await app.request('/auth/passkey/authenticate/finish', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({
          challengeId: begin.challengeId,
          credential: { test: 'ok', id: 'cred-1' },
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        token: string;
        account: { id: string; viewKey: string; hasPosted: boolean };
      };
      expect(body.account.id).toBe(accountId);
      expect(body.account.viewKey).toMatch(/^[0-9a-f]{64}$/);
      expect(body.account.hasPosted).toBe(false);
      expect(
        parsedEvents(warn).some(
          (e) => e['event'] === 'auth.passkey.login.ok' && e['accountId'] === accountId,
        ),
      ).toBe(true);
    });

    it('returns 403 when finishing authentication for a sessionRefused account', async () => {
      const store = new InMemoryAuthStore();
      await store.createAccount({
        id: REFUSED_ID,
        linkingKey: null,
        role: 'basis',
        name: null,
        forumLawsDismissed: false,
        location: null,
        viewKey: 'a'.repeat(64),
        createdAt: 1,
        rulesAgreedAt: null,
        sessionRefused: true,
      });
      await store.createPasskeyCredential({
        credentialId: 'cred-1',
        publicKey: new Uint8Array([1, 2, 3]),
        signCount: 0,
        accountId: REFUSED_ID,
        createdAt: 1,
      });
      const app = mount(store);
      const begin = (await (
        await app.request('/auth/passkey/authenticate/begin', { method: 'POST' })
      ).json()) as { challengeId: string };
      const res = await app.request('/auth/passkey/authenticate/finish', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({
          challengeId: begin.challengeId,
          credential: { test: 'ok', id: 'cred-1' },
        }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: WRONG_ACCOUNT_ERROR });
      expect(parsedEvents(warn).some((e) => e['event'] === 'auth.passkey.login.ok')).toBe(false);
    });

    it('returns 403 when tryCreateSession fails concurrently', async () => {
      const store = new InMemoryAuthStore();
      const app = mount(store);
      await register(app);
      vi.spyOn(store, 'tryCreateSession').mockResolvedValue(false);
      const begin = (await (
        await app.request('/auth/passkey/authenticate/begin', { method: 'POST' })
      ).json()) as { challengeId: string };
      const res = await app.request('/auth/passkey/authenticate/finish', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({
          challengeId: begin.challengeId,
          credential: { test: 'ok', id: 'cred-1' },
        }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: WRONG_ACCOUNT_ERROR });
      expect(parsedEvents(warn).some((e) => e['event'] === 'auth.passkey.login.ok')).toBe(false);
    });

    it('rejects an unknown credential', async () => {
      const app = mount(new InMemoryAuthStore());
      await register(app);
      const begin = (await (
        await app.request('/auth/passkey/authenticate/begin', { method: 'POST' })
      ).json()) as { challengeId: string };
      const res = await app.request('/auth/passkey/authenticate/finish', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({
          challengeId: begin.challengeId,
          credential: { test: 'ok', id: 'missing' },
        }),
      });
      expect(await res.json()).toEqual({ error: 'Unknown credential' });
    });

    it('rejects a credential without id', async () => {
      const app = mount(new InMemoryAuthStore());
      await register(app);
      const begin = (await (
        await app.request('/auth/passkey/authenticate/begin', { method: 'POST' })
      ).json()) as { challengeId: string };
      const res = await app.request('/auth/passkey/authenticate/finish', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ challengeId: begin.challengeId, credential: { test: 'ok' } }),
      });
      expect(await res.json()).toEqual({ error: 'Unknown credential' });
    });

    it('rejects a verify failure', async () => {
      const app = mount(new InMemoryAuthStore());
      await register(app);
      const begin = (await (
        await app.request('/auth/passkey/authenticate/begin', { method: 'POST' })
      ).json()) as { challengeId: string };
      const res = await app.request('/auth/passkey/authenticate/finish', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({
          challengeId: begin.challengeId,
          credential: { test: 'replay', id: 'cred-1' },
        }),
      });
      expect(await res.json()).toEqual({ error: 'Invalid passkey' });
    });

    it('rejects an unknown challenge', async () => {
      const res = await mount(new InMemoryAuthStore()).request(
        '/auth/passkey/authenticate/finish',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN },
          body: JSON.stringify({ challengeId: 'nope', credential: { test: 'ok', id: 'cred-1' } }),
        },
      );
      expect(await res.json()).toEqual({ error: 'Unknown or expired challenge' });
      const logged = parsedEvents(warn).find((e) => e['event'] === 'auth.passkey.login.fail');
      expect(logged).toEqual({
        ts: logged?.['ts'],
        event: 'auth.passkey.login.fail',
        error: 'Unknown or expired challenge',
      });
      expect(logged).not.toHaveProperty('challengeId');
    });

    it('logs a real challenge id when authentication fails', async () => {
      const challengeId = 'ab'.repeat(32);
      const res = await mount(new InMemoryAuthStore()).request(
        '/auth/passkey/authenticate/finish',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN },
          body: JSON.stringify({ challengeId, credential: { test: 'ok', id: 'cred-1' } }),
        },
      );
      expect(await res.json()).toEqual({ error: 'Unknown or expired challenge' });
      expect(parsedEvents(warn)).toContainEqual(
        expect.objectContaining({
          event: 'auth.passkey.login.fail',
          challengeId,
          error: 'Unknown or expired challenge',
        }),
      );
    });

    it('rejects a mismatched origin', async () => {
      const app = mount(new InMemoryAuthStore());
      const begin = (await (
        await app.request('/auth/passkey/authenticate/begin', { method: 'POST' })
      ).json()) as { challengeId: string };
      const res = await app.request('/auth/passkey/authenticate/finish', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.test' },
        body: JSON.stringify({
          challengeId: begin.challengeId,
          credential: { test: 'ok', id: 'cred-1' },
        }),
      });
      expect(await res.json()).toEqual({ error: 'Invalid origin' });
    });
  });

  describe('POST /auth/passkey/replace', () => {
    async function register(
      store: InMemoryAuthStore,
    ): Promise<{ app: Hono; token: string; accountId: string }> {
      const app = mount(store);
      const begin = (await (
        await app.request('/auth/passkey/register/begin', { method: 'POST' })
      ).json()) as { challengeId: string };
      const res = await app.request('/auth/passkey/register/finish', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ challengeId: begin.challengeId, credential: { test: 'ok' } }),
      });
      const body = (await res.json()) as { token: string; account: { id: string } };
      return { app, token: body.token, accountId: body.account.id };
    }

    it('returns 500 when WEBAUTHN_RP_ID is not configured', async () => {
      const res = await mount(new InMemoryAuthStore(), '').request('/auth/passkey/replace/begin', {
        method: 'POST',
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Server auth is not configured' });
    });

    it('returns 500 on finish when WEBAUTHN_RP_ID is not configured', async () => {
      const res = await mount(new InMemoryAuthStore(), '').request('/auth/passkey/replace/finish', {
        method: 'POST',
      });
      expect(res.status).toBe(500);
    });

    it('returns 401 on begin without Authorization', async () => {
      const res = await mount(new InMemoryAuthStore()).request('/auth/passkey/replace/begin', {
        method: 'POST',
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
    });

    it('returns 401 on begin with an invalid Bearer', async () => {
      const res = await mount(new InMemoryAuthStore()).request('/auth/passkey/replace/begin', {
        method: 'POST',
        headers: { authorization: 'Bearer nope' },
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
    });

    it('returns 401 on finish without Authorization', async () => {
      const res = await mount(new InMemoryAuthStore()).request('/auth/passkey/replace/finish', {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ challengeId: 'x', credential: { test: 'replace' } }),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
    });

    it('returns 401 on finish with an invalid Bearer', async () => {
      const res = await mount(new InMemoryAuthStore()).request('/auth/passkey/replace/finish', {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          authorization: 'Bearer nope',
        },
        body: JSON.stringify({ challengeId: 'x', credential: { test: 'replace' } }),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
    });

    it('returns 409 on begin after a valid session and does not swap credentials', async () => {
      const store = new InMemoryAuthStore();
      const { app, token, accountId } = await register(store);
      const res = await app.request('/auth/passkey/replace/begin', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'A recovery phrase cannot be replaced' });
      expect((await store.getPasskeyCredential('cred-1'))?.accountId).toBe(accountId);
      expect(await store.getPasskeyCredential('cred-2')).toBeUndefined();
      expect(
        (await store.listPasskeyChallenges()).some((challenge) => challenge.type === 'replace'),
      ).toBe(false);
      expect(
        parsedEvents(warn).some(
          (e) => e['event'] === 'auth.passkey.replace.refused' && e['accountId'] === accountId,
        ),
      ).toBe(true);
    });

    it('returns 409 on finish after a valid session and does not swap credentials', async () => {
      const store = new InMemoryAuthStore();
      const { app, token, accountId } = await register(store);
      const res = await app.request('/auth/passkey/replace/finish', {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          challengeId: 'x',
          credential: { test: 'replace' },
        }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'A recovery phrase cannot be replaced' });
      expect((await store.getPasskeyCredential('cred-1'))?.accountId).toBe(accountId);
      expect(await store.getPasskeyCredential('cred-2')).toBeUndefined();
      expect(
        parsedEvents(warn).some(
          (e) => e['event'] === 'auth.passkey.replace.refused' && e['accountId'] === accountId,
        ),
      ).toBe(true);
    });
  });

  describe('POST /auth/passkey/seed', () => {
    async function register(
      store: InMemoryAuthStore,
    ): Promise<{ app: Hono; token: string; accountId: string }> {
      const app = mount(store);
      const begin = (await (
        await app.request('/auth/passkey/register/begin', { method: 'POST' })
      ).json()) as { challengeId: string };
      const res = await app.request('/auth/passkey/register/finish', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ challengeId: begin.challengeId, credential: { test: 'ok' } }),
      });
      const body = (await res.json()) as { token: string; account: { id: string } };
      return { app, token: body.token, accountId: body.account.id };
    }

    async function legacySignedIn(
      store: InMemoryAuthStore,
      walletBackupSeenAt: number | null = 9,
    ): Promise<{ app: Hono; token: string; accountId: string }> {
      const accountId = 'legacy';
      const token = 'b'.repeat(64);
      await store.createAccount({
        id: accountId,
        linkingKey: null,
        role: 'basis',
        name: null,
        forumLawsDismissed: false,
        location: null,
        viewKey: 'a'.repeat(64),
        createdAt: 1,
        rulesAgreedAt: null,
        walletRequired: false,
        walletBackupSeenAt,
      });
      await store.createPasskeyCredential({
        credentialId: 'cred-1',
        publicKey: new Uint8Array([1, 2, 3]),
        signCount: 0,
        accountId,
        createdAt: 1,
      });
      await store.createSession({ token, accountId, createdAt: now() });
      return { app: mount(store), token, accountId };
    }

    it('returns 500 when WEBAUTHN_RP_ID is not configured', async () => {
      const res = await mount(new InMemoryAuthStore(), '').request('/auth/passkey/seed/begin', {
        method: 'POST',
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Server auth is not configured' });
    });

    it('returns 500 on finish when WEBAUTHN_RP_ID is not configured', async () => {
      const res = await mount(new InMemoryAuthStore(), '').request('/auth/passkey/seed/finish', {
        method: 'POST',
      });
      expect(res.status).toBe(500);
    });

    it('returns 401 on begin without Authorization', async () => {
      const res = await mount(new InMemoryAuthStore()).request('/auth/passkey/seed/begin', {
        method: 'POST',
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
    });

    it('returns 401 on begin with an invalid Bearer', async () => {
      const res = await mount(new InMemoryAuthStore()).request('/auth/passkey/seed/begin', {
        method: 'POST',
        headers: { authorization: 'Bearer nope' },
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
    });

    it('returns 401 on finish without Authorization', async () => {
      const res = await mount(new InMemoryAuthStore()).request('/auth/passkey/seed/finish', {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ challengeId: 'x', credential: { test: 'replace' } }),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
    });

    it('returns 401 on finish with an invalid Bearer', async () => {
      const res = await mount(new InMemoryAuthStore()).request('/auth/passkey/seed/finish', {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          authorization: 'Bearer nope',
        },
        body: JSON.stringify({ challengeId: 'x', credential: { test: 'replace' } }),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
    });

    it('issues seed options for a legacy account without excludeCredentials', async () => {
      const store = new InMemoryAuthStore();
      const { app, token, accountId } = await legacySignedIn(store);
      const res = await app.request('/auth/passkey/seed/begin', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        challengeId: string;
        options: { excludeCredentials?: unknown; user: { name: string } };
      };
      expect(body.challengeId).toMatch(/^[0-9a-f]{64}$/);
      expect(body.options).not.toHaveProperty('excludeCredentials');
      expect(body.options.user.name).toBe(accountId);
    });

    it('adds a seed passkey and sets walletRequired without minting a session', async () => {
      const store = new InMemoryAuthStore();
      const { app, token, accountId } = await legacySignedIn(store);
      const begin = (await (
        await app.request('/auth/passkey/seed/begin', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()) as { challengeId: string };
      const finish = await app.request('/auth/passkey/seed/finish', {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          challengeId: begin.challengeId,
          credential: { test: 'replace' },
        }),
      });
      expect(finish.status).toBe(200);
      const finishBody = (await finish.json()) as {
        token?: unknown;
        account?: unknown;
        id: string;
        walletRequired: boolean;
        walletBackupSeenAt: number | null;
        passkeyCredentialId: string | null;
      };
      expect(finishBody).not.toHaveProperty('token');
      expect(finishBody).not.toHaveProperty('account');
      expect(finishBody.id).toBe(accountId);
      expect(finishBody.walletRequired).toBe(true);
      expect(finishBody.walletBackupSeenAt).toBe(9);
      expect(finishBody.passkeyCredentialId).toBe('cred-2');
      expect((await store.getPasskeyCredential('cred-1'))?.accountId).toBe(accountId);
      expect((await store.getPasskeyCredential('cred-2'))?.accountId).toBe(accountId);
      expect((await store.getPasskeyCredentialForAccount(accountId))?.credentialId).toBe('cred-2');
      expect((await store.getAccount(accountId))?.walletRequired).toBe(true);
      expect((await store.getAccount(accountId))?.walletBackupSeenAt).toBe(9);
      expect(
        parsedEvents(warn).some(
          (e) => e['event'] === 'auth.passkey.seed.ok' && e['accountId'] === accountId,
        ),
      ).toBe(true);
    });

    it('refuses a second seed finish and does not insert a third credential', async () => {
      const store = new InMemoryAuthStore();
      const { app, token, accountId } = await legacySignedIn(store);
      const firstBegin = (await (
        await app.request('/auth/passkey/seed/begin', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()) as { challengeId: string };
      const secondBegin = (await (
        await app.request('/auth/passkey/seed/begin', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()) as { challengeId: string };
      const firstFinish = await app.request('/auth/passkey/seed/finish', {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          challengeId: firstBegin.challengeId,
          credential: { test: 'replace' },
        }),
      });
      expect(firstFinish.status).toBe(200);
      warn.mockClear();
      const secondFinish = await app.request('/auth/passkey/seed/finish', {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          challengeId: secondBegin.challengeId,
          credential: { test: 'replace' },
        }),
      });
      expect(secondFinish.status).toBe(409);
      expect(await secondFinish.json()).toEqual({
        error: 'This account already has a recovery phrase',
      });
      expect((await store.getPasskeyCredential('cred-1'))?.accountId).toBe(accountId);
      expect((await store.getPasskeyCredential('cred-2'))?.accountId).toBe(accountId);
      const rows = await store.listPasskeyCredentials();
      const forAccount = rows.filter((row) => row.accountId === accountId);
      expect(forAccount).toHaveLength(2);
      expect(parsedEvents(warn).some((e) => e['event'] === 'auth.passkey.seed.ok')).toBe(false);
    });

    it('returns 409 on seed begin for an account that already has a seed', async () => {
      const store = new InMemoryAuthStore();
      const { app, token, accountId } = await register(store);
      const before = await store.listPasskeyChallenges();
      const res = await app.request('/auth/passkey/seed/begin', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'This account already has a recovery phrase',
      });
      expect(await store.listPasskeyChallenges()).toEqual(before);
      expect(
        parsedEvents(warn).filter(
          (e) =>
            e['event'] === 'auth.passkey.seed.fail' &&
            e['error'] === 'This account already has a recovery phrase' &&
            e['accountId'] === accountId,
        ),
      ).toHaveLength(1);
    });

    it('returns 409 on seed finish without parsing a body when walletRequired is true', async () => {
      const store = new InMemoryAuthStore();
      const { app, token, accountId } = await register(store);
      const res = await app.request('/auth/passkey/seed/finish', {
        method: 'POST',
        headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'This account already has a recovery phrase',
      });
      expect(
        parsedEvents(warn).some(
          (e) =>
            e['event'] === 'auth.passkey.seed.fail' &&
            e['error'] === 'This account already has a recovery phrase' &&
            e['accountId'] === accountId,
        ),
      ).toBe(true);
    });

    it('returns 400 when seed finish rejects the attestation', async () => {
      const store = new InMemoryAuthStore();
      const { app, token, accountId } = await legacySignedIn(store);
      const begin = (await (
        await app.request('/auth/passkey/seed/begin', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()) as { challengeId: string };
      const res = await app.request('/auth/passkey/seed/finish', {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          challengeId: begin.challengeId,
          credential: { test: 'nope' },
        }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid passkey' });
      expect(await store.getPasskeyCredential('cred-2')).toBeUndefined();
      expect(
        parsedEvents(warn).some(
          (e) =>
            e['event'] === 'auth.passkey.seed.fail' &&
            e['error'] === 'Invalid passkey' &&
            e['accountId'] === accountId &&
            e['challengeId'] === begin.challengeId,
        ),
      ).toBe(true);
    });

    it('does not log a seed challenge id that is not 64 lowercase hex', async () => {
      const store = new InMemoryAuthStore();
      const { app, token, accountId } = await legacySignedIn(store);
      const res = await app.request('/auth/passkey/seed/finish', {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ challengeId: 'not-a-challenge', credential: { test: 'ok' } }),
      });
      expect(await res.json()).toEqual({ error: 'Unknown or expired challenge' });
      const logged = parsedEvents(warn).find((e) => e['event'] === 'auth.passkey.seed.fail');
      expect(logged).toMatchObject({
        event: 'auth.passkey.seed.fail',
        error: 'Unknown or expired challenge',
        accountId,
      });
      expect(logged).not.toHaveProperty('challengeId');
      expect(JSON.stringify(logged)).not.toContain(token);
    });

    it('returns 409 when finish finds the credential id already stored', async () => {
      const store = new InMemoryAuthStore();
      const { app, token } = await legacySignedIn(store);
      const begin = (await (
        await app.request('/auth/passkey/seed/begin', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()) as { challengeId: string };
      const res = await app.request('/auth/passkey/seed/finish', {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          challengeId: begin.challengeId,
          credential: { test: 'ok' },
        }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'This account already has a recovery phrase',
      });
      expect(await store.getPasskeyCredential('cred-2')).toBeUndefined();
    });

    it('rejects a missing finish body on a legacy account', async () => {
      const store = new InMemoryAuthStore();
      const { app, token, accountId } = await legacySignedIn(store);
      const res = await app.request('/auth/passkey/seed/finish', {
        method: 'POST',
        headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Expected a JSON body with challengeId and credential',
      });
      const logged = parsedEvents(warn).find((e) => e['event'] === 'auth.passkey.seed.fail');
      expect(logged).toMatchObject({
        event: 'auth.passkey.seed.fail',
        error: 'Expected a JSON body with challengeId and credential',
        json: 'absent',
        bodyBytes: 0,
        accountId,
      });
      expect(logged).not.toHaveProperty('challengeId');
      expect(JSON.stringify(logged)).not.toContain(token);
    });

    class RecordingAuthStore extends InMemoryAuthStore {
      inserts: PasskeyRenewAttemptInput[] = [];
      override async insertPasskeyRenewAttempt(input: PasskeyRenewAttemptInput): Promise<void> {
        this.inserts.push(input);
        await super.insertPasskeyRenewAttempt(input);
      }
    }

    it('logs invalid JSON on seed finish and stores the failed renew row', async () => {
      const store = new RecordingAuthStore();
      const { app, token, accountId } = await legacySignedIn(store);
      warn.mockClear();
      const raw = '{"credential":"cred-secret"';
      const res = await app.request('/auth/passkey/seed/finish', {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'user-agent': 'SeedAgent',
        },
        body: raw,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Finish body is not valid JSON' });
      const logged = parsedEvents(warn).find((e) => e['event'] === 'auth.passkey.seed.fail');
      expect(logged).toMatchObject({
        event: 'auth.passkey.seed.fail',
        error: 'Finish body is not valid JSON',
        json: 'invalid',
        bodyBytes: raw.length,
        accountId,
      });
      expect(logged).not.toHaveProperty('challengeId');
      expect(JSON.stringify(logged)).not.toContain('cred-secret');
      expect(JSON.stringify(logged)).not.toContain(token);
      expect(store.inserts).toHaveLength(1);
      expect(store.inserts[0]).toMatchObject({
        accountId,
        stage: 'finish',
        outcome: 'failed',
        httpStatus: 400,
        message: 'Finish body is not valid JSON',
        userAgent: 'SeedAgent',
      });
    });

    it('inserts a failed begin row on seed begin 409 without changing walletRequired', async () => {
      const store = new RecordingAuthStore();
      const { app, token, accountId } = await register(store);
      expect((await store.getAccount(accountId))?.walletRequired).toBe(true);
      const res = await app.request('/auth/passkey/seed/begin', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'user-agent': 'SeedAgent' },
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'This account already has a recovery phrase',
      });
      expect((await store.getAccount(accountId))?.walletRequired).toBe(true);
      expect(store.inserts).toHaveLength(1);
      expect(store.inserts[0]).toMatchObject({
        accountId,
        createdAt: now(),
        stage: 'begin',
        outcome: 'failed',
        errorName: null,
        errorCode: null,
        httpStatus: 409,
        message: 'This account already has a recovery phrase',
        userAgent: 'SeedAgent',
      });
    });

    it('inserts a failed finish row on seed finish 400', async () => {
      const store = new RecordingAuthStore();
      const { app, token, accountId } = await legacySignedIn(store);
      const begin = (await (
        await app.request('/auth/passkey/seed/begin', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()) as { challengeId: string };
      const res = await app.request('/auth/passkey/seed/finish', {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          challengeId: begin.challengeId,
          credential: { test: 'nope' },
        }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid passkey' });
      expect((await store.getAccount(accountId))?.walletRequired).toBe(false);
      expect(store.inserts).toHaveLength(1);
      expect(store.inserts[0]).toMatchObject({
        accountId,
        stage: 'finish',
        outcome: 'failed',
        errorName: null,
        errorCode: null,
        httpStatus: 400,
        message: 'Invalid passkey',
      });
    });

    it('inserts a failed finish row when the account already has a phrase', async () => {
      const store = new RecordingAuthStore();
      const { app, token, accountId } = await register(store);
      const res = await app.request('/auth/passkey/seed/finish', {
        method: 'POST',
        headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'This account already has a recovery phrase',
      });
      expect(store.inserts).toHaveLength(1);
      expect(store.inserts[0]).toMatchObject({
        accountId,
        stage: 'finish',
        outcome: 'failed',
        httpStatus: 409,
        message: 'This account already has a recovery phrase',
      });
    });

    it('inserts succeeded with null error fields and acknowledges an earlier failure', async () => {
      const store = new RecordingAuthStore();
      const { app, token, accountId } = await legacySignedIn(store);
      await store.insertPasskeyRenewAttempt({
        id: 'prior-fail',
        accountId,
        createdAt: 1,
        stage: 'begin',
        outcome: 'failed',
        errorName: null,
        errorCode: null,
        httpStatus: 409,
        message: 'seed failed',
        userAgent: null,
      });
      expect(await store.hasUnacknowledgedPasskeyRenewFailure(accountId)).toBe(true);
      const begin = (await (
        await app.request('/auth/passkey/seed/begin', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()) as { challengeId: string };
      const finish = await app.request('/auth/passkey/seed/finish', {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          challengeId: begin.challengeId,
          credential: { test: 'replace' },
        }),
      });
      expect(finish.status).toBe(200);
      const finishBody = (await finish.json()) as {
        account?: unknown;
        passkeyRenewFailed: boolean;
        passkeyRenewClosed: boolean;
        walletRequired: boolean;
      };
      expect(finishBody).not.toHaveProperty('account');
      expect(finishBody.passkeyRenewFailed).toBe(false);
      expect(finishBody.passkeyRenewClosed).toBe(false);
      expect(finishBody.walletRequired).toBe(true);
      expect(await store.hasUnacknowledgedPasskeyRenewFailure(accountId)).toBe(false);
      const succeeded = store.inserts.filter((row) => row.outcome === 'succeeded');
      expect(succeeded).toHaveLength(1);
      expect(succeeded[0]).toMatchObject({
        accountId,
        stage: 'finish',
        outcome: 'succeeded',
        errorName: null,
        errorCode: null,
        httpStatus: null,
        message: null,
      });
    });

    it('inserts nothing on begin or finish 401', async () => {
      const store = new RecordingAuthStore();
      const app = mount(store);
      const begin = await app.request('/auth/passkey/seed/begin', { method: 'POST' });
      expect(begin.status).toBe(401);
      const finish = await app.request('/auth/passkey/seed/finish', {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ challengeId: 'x', credential: { test: 'replace' } }),
      });
      expect(finish.status).toBe(401);
      expect(store.inserts).toEqual([]);
    });

    it('inserts nothing when WebAuthn is not configured', async () => {
      const store = new RecordingAuthStore();
      const app = mount(store, '');
      const begin = await app.request('/auth/passkey/seed/begin', { method: 'POST' });
      expect(begin.status).toBe(500);
      const finish = await app.request('/auth/passkey/seed/finish', { method: 'POST' });
      expect(finish.status).toBe(500);
      expect(store.inserts).toEqual([]);
    });
  });
});

describe('social recovery routes', () => {
  const LOOKUP = { signature: 'ab'.repeat(36), timestamp: 1_700_000_000 };
  const T0 = 1_000_000;
  const UNAVAILABLE = { error: 'Lightning address service is unavailable' };
  const FINISH_BODY_ERROR =
    'Expected a JSON body with challengeId, credential, newSparkPubkey and signature';
  const BEGIN_BODY_ERROR = 'Expected a JSON body with sparkPubkey and lookup';
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  function recoveryApp(
    store: InMemoryAuthStore,
    options: {
      fetchImpl?: FetchFn;
      lnurl?: boolean;
      rpId?: string;
      loginsOpen?: boolean;
      clock?: () => number;
    } = {},
  ): Hono {
    return new Hono().route(
      '/auth',
      authRoutes({
        store,
        now: options.clock ?? (() => T0),
        allowedOrigins: [ORIGIN],
        webAuthnRpId: options.rpId ?? 'localhost',
        webAuthnRpName: undefined,
        passkeyCeremony: new FakePasskeyCeremony({ challenge: PINNED.challenge }),
        messages: new InMemoryMessageStore(),
        ...(options.lnurl === false ? {} : { lnurlServer: LNURL_SERVER }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(options.loginsOpen === undefined
          ? {}
          : { loginGate: new LoginGate(new InMemoryLoginGateStore(), options.loginsOpen) }),
      }),
    );
  }

  function post(app: Hono, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return app.request(path, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
  }

  function beginBody(sparkPubkey: string = PINNED.oldSparkPubkey): unknown {
    return { sparkPubkey, lookup: LOOKUP };
  }

  function finishBody(challengeId: string, overrides: Record<string, unknown> = {}): unknown {
    return {
      challengeId,
      credential: { test: 'recovery', id: PINNED.credentialId },
      newSparkPubkey: PINNED.newSparkPubkey,
      signature: { pubkey: PINNED.oldSparkPubkey, signature: PINNED.signature },
      ...overrides,
    };
  }

  function recoveryFails(): Array<Record<string, unknown>> {
    return parsedEvents(warn).filter((e) => e['event'] === 'auth.passkey.recovery.fail');
  }

  function expectNoSecretsLogged(): void {
    const logged = JSON.stringify(parsedEvents(warn));
    expect(logged).not.toContain(PINNED.oldSparkPubkey);
    expect(logged).not.toContain(PINNED.newSparkPubkey);
    expect(logged).not.toContain(PINNED.signature);
    expect(logged).not.toContain(LOOKUP.signature);
    expect(logged).not.toContain(String(LOOKUP.timestamp));
  }

  async function begun(
    store: InMemoryAuthStore,
    options: Parameters<typeof recoveryApp>[1] = {},
  ): Promise<{ app: Hono; challengeId: string }> {
    const { fetchImpl } = scriptedLnurlFetch({ recover: () => lookupHolds('ada') });
    const app = recoveryApp(store, { fetchImpl, ...options });
    const res = await post(app, '/auth/passkey/recovery/begin', beginBody());
    expect(res.status).toBe(200);
    return { app, challengeId: ((await res.json()) as { challengeId: string }).challengeId };
  }

  describe('POST /auth/passkey/recovery/begin', () => {
    it('answers 200 with the challenge, options, account id, and username', async () => {
      const store = new InMemoryAuthStore();
      await seedPinnedAccount(store);
      const { fetchImpl, calls } = scriptedLnurlFetch({ recover: () => lookupHolds('ada') });
      const res = await post(
        recoveryApp(store, { fetchImpl }),
        '/auth/passkey/recovery/begin',
        beginBody(` ${PINNED.oldSparkPubkey.toUpperCase()} `),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['accountId', 'challengeId', 'options', 'username']);
      expect(body['accountId']).toBe(PINNED.accountId);
      expect(body['username']).toBe(RECOVERY_USERNAME);
      expect((body['options'] as { challenge: string }).challenge).toBe(PINNED.challenge);
      expect(calls).toEqual([
        expect.objectContaining({
          route: 'recover',
          pubkey: PINNED.oldSparkPubkey,
          body: JSON.stringify(LOOKUP),
        }),
      ]);
      expectNoSecretsLogged();
    });

    it('answers 500 when WebAuthn is not configured', async () => {
      const res = await post(
        recoveryApp(new InMemoryAuthStore(), { rpId: '' }),
        '/auth/passkey/recovery/begin',
        beginBody(),
      );
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Server auth is not configured' });
      expect(recoveryFails()).toEqual([
        expect.objectContaining({ stage: 'begin', error: 'Server auth is not configured' }),
      ]);
    });

    it('answers 503 when the LNURL server is off', async () => {
      const res = await post(
        recoveryApp(new InMemoryAuthStore(), { lnurl: false }),
        '/auth/passkey/recovery/begin',
        beginBody(),
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual(UNAVAILABLE);
    });

    it('answers 400 for invalid JSON and for a body that is not the begin shape', async () => {
      const app = recoveryApp(new InMemoryAuthStore());
      const invalid = await post(app, '/auth/passkey/recovery/begin', '{');
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: 'Begin body is not valid JSON' });
      for (const body of [
        undefined,
        [],
        { sparkPubkey: PINNED.oldSparkPubkey },
        { ...(beginBody() as object), extra: 1 },
        { sparkPubkey: 'nope', lookup: LOOKUP },
        { sparkPubkey: PINNED.oldSparkPubkey, lookup: { ...LOOKUP, signature: 'AB'.repeat(36) } },
        { sparkPubkey: PINNED.oldSparkPubkey, lookup: { ...LOOKUP, signature: 'ab' } },
        { sparkPubkey: PINNED.oldSparkPubkey, lookup: { ...LOOKUP, timestamp: -1 } },
        { sparkPubkey: PINNED.oldSparkPubkey, lookup: { ...LOOKUP, timestamp: 1.5 } },
        { sparkPubkey: PINNED.oldSparkPubkey, lookup: { ...LOOKUP, extra: true } },
      ]) {
        const res = await post(app, '/auth/passkey/recovery/begin', body);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: BEGIN_BODY_ERROR });
      }
      expect(recoveryFails()[0]).toEqual(
        expect.objectContaining({ stage: 'begin', json: 'invalid', bodyBytes: 1 }),
      );
      expect(recoveryFails()[1]).toEqual(
        expect.objectContaining({ stage: 'begin', json: 'absent', error: BEGIN_BODY_ERROR }),
      );
    });

    it('maps each refusal', async () => {
      const store = new InMemoryAuthStore();
      const holds = scriptedLnurlFetch({ recover: () => lookupHolds('ada') });
      const notFound = await post(
        recoveryApp(store, { fetchImpl: holds.fetchImpl }),
        '/auth/passkey/recovery/begin',
        beginBody(),
      );
      expect(notFound.status).toBe(404);
      expect(await notFound.json()).toEqual({ error: 'Not found' });

      await seedPinnedAccount(store);
      const operator = await post(
        recoveryApp(store, {
          fetchImpl: scriptedLnurlFetch({ recover: () => lookupHolds('bob') }).fetchImpl,
        }),
        '/auth/passkey/recovery/begin',
        beginBody(),
      );
      expect(operator.status).toBe(409);
      expect(await operator.json()).toEqual({
        error: 'This account needs an operator to recover it',
        code: 'recovery_operator',
      });

      const unverified = await post(
        recoveryApp(store, {
          fetchImpl: scriptedLnurlFetch({ recover: () => new Response('', { status: 400 }) })
            .fetchImpl,
        }),
        '/auth/passkey/recovery/begin',
        beginBody(),
      );
      expect(unverified.status).toBe(503);
      expect(await unverified.json()).toEqual(UNAVAILABLE);

      const closed = await post(
        recoveryApp(store, { fetchImpl: holds.fetchImpl, loginsOpen: false }),
        '/auth/passkey/recovery/begin',
        beginBody(),
      );
      expect(closed.status).toBe(503);
      expect(await closed.json()).toEqual({ error: LOGINS_CLOSED_ERROR, code: LOGINS_CLOSED_CODE });

      await store.setSessionRefused(PINNED.accountId, true);
      const refused = await post(
        recoveryApp(store, { fetchImpl: holds.fetchImpl }),
        '/auth/passkey/recovery/begin',
        beginBody(),
      );
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: WRONG_ACCOUNT_ERROR });

      expect(recoveryFails().map((e) => e['error'])).toEqual([
        'not_found',
        'operator',
        'unavailable',
        'logins_closed',
        'wrong_account',
      ]);
      expect(recoveryFails().filter((e) => e['error'] === 'operator')).toEqual([
        expect.objectContaining({ accountId: PINNED.accountId }),
      ]);
      expectNoSecretsLogged();
    });

    it('answers 409 recovery_done once a forwarded recovery commits through the lookup', async () => {
      const store = new InMemoryAuthStore();
      await seedPinnedAccount(store);
      await stagePendingRecovery(store, { createdAt: T0, forwardedAt: T0 });
      const { fetchImpl } = scriptedLnurlFetch({ recover: () => lookupUserNotFound() });
      const app = recoveryApp(store, {
        fetchImpl,
        clock: () => T0 + RECOVERY_SETTLE_AFTER_MS + 1,
      });
      const res = await post(app, '/auth/passkey/recovery/begin', beginBody());
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'This account was already recovered. Sign in with the new passkey.',
        code: 'recovery_done',
      });
    });

    it('answers 503 and logs the error kind when the store throws', async () => {
      const store = new InMemoryAuthStore();
      vi.spyOn(store, 'getAccountByVerifiedSparkPubkey').mockRejectedValue(
        Object.assign(new Error('db detail'), { code: 'ECONNRESET' }),
      );
      const res = await post(recoveryApp(store), '/auth/passkey/recovery/begin', beginBody());
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual(UNAVAILABLE);
      expect(recoveryFails()).toEqual([
        expect.objectContaining({ stage: 'begin', name: 'Error', code: 'ECONNRESET' }),
      ]);
      expect(JSON.stringify(recoveryFails())).not.toContain('db detail');
    });

    it('answers 429 after 30 begins a minute from one address', async () => {
      const store = new InMemoryAuthStore();
      const app = recoveryApp(store, { fetchImpl: scriptedLnurlFetch({}).fetchImpl });
      const headers = { 'cf-connecting-ip': '198.51.100.7' };
      for (let i = 0; i < 30; i += 1) {
        expect((await post(app, '/auth/passkey/recovery/begin', beginBody(), headers)).status).toBe(
          404,
        );
      }
      const limited = await post(app, '/auth/passkey/recovery/begin', beginBody(), headers);
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({ error: 'Too many requests' });
    });
  });

  describe('POST /auth/passkey/recovery/finish', () => {
    it('answers 200 pending without a session', async () => {
      const store = new InMemoryAuthStore();
      await seedPinnedAccount(store);
      const { app, challengeId } = await begun(store);
      const res = await post(app, '/auth/passkey/recovery/finish', finishBody(challengeId));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'pending' });
      expect((await store.getPendingRecovery(PINNED.accountId, T0))?.newSparkPubkey).toBe(
        PINNED.newSparkPubkey,
      );
      expect(await store.listSessions()).toEqual([]);
      const repeat = await post(app, '/auth/passkey/recovery/finish', finishBody(challengeId));
      expect(repeat.status).toBe(200);
      expectNoSecretsLogged();
    });

    it('normalizes both wallet keys', async () => {
      const store = new InMemoryAuthStore();
      await seedPinnedAccount(store);
      const { app, challengeId } = await begun(store);
      const res = await post(
        app,
        '/auth/passkey/recovery/finish',
        finishBody(challengeId, {
          newSparkPubkey: ` ${PINNED.newSparkPubkey.toUpperCase()}`,
          signature: { pubkey: PINNED.oldSparkPubkey.toUpperCase(), signature: PINNED.signature },
        }),
      );
      expect(res.status).toBe(200);
    });

    it('answers 500 when WebAuthn is not configured', async () => {
      const res = await post(
        recoveryApp(new InMemoryAuthStore(), { rpId: '' }),
        '/auth/passkey/recovery/finish',
      );
      expect(res.status).toBe(500);
      expect(recoveryFails()).toEqual([
        expect.objectContaining({ stage: 'finish', error: 'Server auth is not configured' }),
      ]);
    });

    it('answers 400 for an absent body, invalid JSON, or the wrong shape', async () => {
      const app = recoveryApp(new InMemoryAuthStore(), { lnurl: false });
      const absent = await post(app, '/auth/passkey/recovery/finish');
      expect(absent.status).toBe(400);
      expect(await absent.json()).toEqual({ error: FINISH_BODY_ERROR });
      const invalid = await post(app, '/auth/passkey/recovery/finish', 'nope');
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: 'Finish body is not valid JSON' });
      const id = 'a'.repeat(64);
      const withoutCredential = { ...(finishBody(id) as Record<string, unknown>) };
      delete withoutCredential['credential'];
      for (const body of [
        withoutCredential,
        { ...(finishBody(id) as object), extra: 1 },
        finishBody(id, { newSparkPubkey: 'nope' }),
        finishBody(id, { signature: { pubkey: 'nope', signature: PINNED.signature } }),
        finishBody(id, { signature: { pubkey: PINNED.oldSparkPubkey } }),
        finishBody(id, {
          signature: { pubkey: PINNED.oldSparkPubkey, signature: PINNED.signature, x: 1 },
        }),
        finishBody(id, { challengeId: 7 }),
      ]) {
        const res = await post(app, '/auth/passkey/recovery/finish', body);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: FINISH_BODY_ERROR });
      }
      const shapes = recoveryFails();
      expect(shapes[0]).toEqual(expect.objectContaining({ stage: 'finish', json: 'absent' }));
      expect(shapes[1]).toEqual(expect.objectContaining({ json: 'invalid' }));
      expect(shapes[2]).toEqual(
        expect.objectContaining({ json: 'parsed', hasCredential: false, challengeId: id }),
      );
      expectNoSecretsLogged();
    });

    it('answers 400 for ceremony refusals', async () => {
      const store = new InMemoryAuthStore();
      await seedPinnedAccount(store);
      const { app, challengeId } = await begun(store);
      const noOrigin = await app.request('/auth/passkey/recovery/finish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(finishBody(challengeId)),
      });
      expect(noOrigin.status).toBe(400);
      expect(await noOrigin.json()).toEqual({ error: 'Invalid origin' });
      const unknown = await post(app, '/auth/passkey/recovery/finish', finishBody('b'.repeat(64)));
      expect(unknown.status).toBe(400);
      expect(await unknown.json()).toEqual({ error: 'Unknown or expired challenge' });
      const badPasskey = await post(
        app,
        '/auth/passkey/recovery/finish',
        finishBody(challengeId, { credential: { test: 'nope' } }),
      );
      expect(badPasskey.status).toBe(400);
      expect(await badPasskey.json()).toEqual({ error: 'Invalid passkey' });
      const badSignature = await post(
        app,
        '/auth/passkey/recovery/finish',
        finishBody(challengeId, {
          signature: { pubkey: PINNED.oldSparkPubkey, signature: PINNED.signatureHighS },
        }),
      );
      expect(badSignature.status).toBe(400);
      expect(await badSignature.json()).toEqual({ error: 'Invalid recovery signature' });
      expect(recoveryFails().at(-1)).toEqual(
        expect.objectContaining({
          stage: 'finish',
          error: 'Invalid recovery signature',
          challengeId,
          accountId: PINNED.accountId,
        }),
      );
      expectNoSecretsLogged();
    });

    it('answers 400 Challenge expired after the challenge window', async () => {
      const store = new InMemoryAuthStore();
      await seedPinnedAccount(store);
      let clock = T0;
      const { app, challengeId } = await begun(store, { clock: () => clock });
      clock = T0 + CHALLENGE_TTL_MS + 1;
      const res = await post(app, '/auth/passkey/recovery/finish', finishBody(challengeId));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Challenge expired' });
    });

    it('answers 409 for a key in use and a pending recovery', async () => {
      const store = new InMemoryAuthStore();
      await seedPinnedAccount(store);
      const { app, challengeId } = await begun(store);
      const sameKey = await post(
        app,
        '/auth/passkey/recovery/finish',
        finishBody(challengeId, { newSparkPubkey: PINNED.oldSparkPubkey }),
      );
      expect(sameKey.status).toBe(409);
      expect(await sameKey.json()).toEqual({ error: 'Wallet key is already in use' });
      vi.spyOn(store, 'storePendingRecovery').mockResolvedValueOnce('pending');
      const pending = await post(app, '/auth/passkey/recovery/finish', finishBody(challengeId));
      expect(pending.status).toBe(409);
      expect(await pending.json()).toEqual({ error: 'A recovery is already pending' });
    });

    it('answers 403 for a session-refused account and 503 while logins are closed', async () => {
      const store = new InMemoryAuthStore();
      await seedPinnedAccount(store);
      const { challengeId } = await begun(store);
      const closed = await post(
        recoveryApp(store, { loginsOpen: false }),
        '/auth/passkey/recovery/finish',
        finishBody(challengeId),
      );
      expect(closed.status).toBe(503);
      expect(await closed.json()).toEqual({ error: LOGINS_CLOSED_ERROR, code: LOGINS_CLOSED_CODE });
      await store.setSessionRefused(PINNED.accountId, true);
      const refused = await post(
        recoveryApp(store),
        '/auth/passkey/recovery/finish',
        finishBody(challengeId),
      );
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: WRONG_ACCOUNT_ERROR });
    });

    it('answers 503 when the store throws, including a unique violation', async () => {
      const store = new InMemoryAuthStore();
      await seedPinnedAccount(store);
      const { app, challengeId } = await begun(store);
      vi.spyOn(store, 'storePendingRecovery').mockRejectedValue(
        Object.assign(new Error('duplicate key value'), { code: '23505' }),
      );
      const res = await post(app, '/auth/passkey/recovery/finish', finishBody(challengeId));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual(UNAVAILABLE);
      expect(recoveryFails().at(-1)).toEqual(
        expect.objectContaining({ stage: 'finish', code: '23505', challengeId }),
      );
    });

    it('answers 429 after 30 finishes a minute from one address', async () => {
      const app = recoveryApp(new InMemoryAuthStore());
      const headers = { 'cf-connecting-ip': '198.51.100.8' };
      for (let i = 0; i < 30; i += 1) {
        expect((await post(app, '/auth/passkey/recovery/finish', undefined, headers)).status).toBe(
          400,
        );
      }
      expect((await post(app, '/auth/passkey/recovery/finish', undefined, headers)).status).toBe(
        429,
      );
    });
  });

  describe('POST /auth/passkey/authenticate/finish with a pending recovery passkey', () => {
    it('answers 409 recovery_pending', async () => {
      const store = new InMemoryAuthStore();
      await seedPinnedAccount(store);
      await stagePendingRecovery(store, { createdAt: T0 });
      const app = recoveryApp(store);
      const begin = await post(app, '/auth/passkey/authenticate/begin');
      const { challengeId } = (await begin.json()) as { challengeId: string };
      const res = await post(app, '/auth/passkey/authenticate/finish', {
        challengeId,
        credential: { test: 'ok', id: PINNED.credentialId },
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'Recovery is not finished',
        code: 'recovery_pending',
      });
    });
  });
});
