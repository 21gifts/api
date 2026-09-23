import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { UnconfiguredInvoicePayer } from '@/lib/invoice-payer';
import { InMemoryMessageStore } from '@/lib/message-store';
import { WRONG_ACCOUNT_ERROR } from '@/lib/auth/wrong-account';
import { authRoutes } from '@/routes/auth';
import { FakePasskeyCeremony } from '@/__tests__/helpers/fake-passkey';
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
        lightningAddress: 'guest@walletofsatoshi.com',
        lightningAddressVerified: false,
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
        lightningAddress: 'guest@walletofsatoshi.com',
        lightningAddressVerified: false,
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
        account: { id: string; linkingKey: string | null; viewKey: string; hasPosted: boolean };
      };
      expect(body.token).toMatch(/^[0-9a-f]{64}$/);
      expect(body.account.linkingKey).toBeNull();
      expect(body.account.viewKey).toMatch(/^[0-9a-f]{64}$/);
      expect(body.account.hasPosted).toBe(false);
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
          payer: new UnconfiguredInvoicePayer(),
          fetchImpl: globalThis.fetch,
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
        lightningAddress: null,
        lightningAddressVerified: false,
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
    });

    it('returns 500 on finish when unconfigured', async () => {
      const res = await mount(new InMemoryAuthStore(), '').request(
        '/auth/passkey/authenticate/finish',
        { method: 'POST' },
      );
      expect(res.status).toBe(500);
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
        lightningAddress: null,
        lightningAddressVerified: false,
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
        lightningAddress: null,
        lightningAddressVerified: false,
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
        account: {
          id: string;
          walletRequired: boolean;
          walletBackupSeenAt: number | null;
          passkeyCredentialId: string | null;
        };
      };
      expect(finishBody).not.toHaveProperty('token');
      expect(finishBody.account.id).toBe(accountId);
      expect(finishBody.account.walletRequired).toBe(true);
      expect(finishBody.account.walletBackupSeenAt).toBe(9);
      expect(finishBody.account.passkeyCredentialId).toBe('cred-2');
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
      const { app, token } = await register(store);
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
    });

    it('returns 409 on seed finish without parsing a body when walletRequired is true', async () => {
      const store = new InMemoryAuthStore();
      const { app, token } = await register(store);
      const res = await app.request('/auth/passkey/seed/finish', {
        method: 'POST',
        headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'This account already has a recovery phrase',
      });
    });

    it('rejects a missing finish body on a legacy account', async () => {
      const store = new InMemoryAuthStore();
      const { app, token } = await legacySignedIn(store);
      const res = await app.request('/auth/passkey/seed/finish', {
        method: 'POST',
        headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Expected a JSON body with challengeId and credential',
      });
    });
  });
});
