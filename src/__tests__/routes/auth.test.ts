import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { authRoutes } from '@/routes/auth';
import { encodeLnurl } from '@/lib/auth/lnurl';
import { newWallet } from '@/__tests__/helpers/auth-vectors';
import { FakePasskeyCeremony } from '@/__tests__/helpers/fake-passkey';
import { meRoutes } from '@/routes/me';
import { UnconfiguredInvoicePayer } from '@/lib/invoice-payer';

const BASE = 'https://dev.21.gifts';
const now = (): number => 1_000_000;
const ORIGIN = 'http://localhost:3000';

function mount(
  store: InMemoryAuthStore,
  publicBaseUrl: string | undefined,
  webAuthnRpId: string | undefined = 'localhost',
): Hono {
  return new Hono().route(
    '/auth',
    authRoutes({
      store,
      now,
      publicBaseUrl,
      allowedOrigins: [ORIGIN],
      webAuthnRpId,
      webAuthnRpName: undefined,
      passkeyCeremony: new FakePasskeyCeremony(),
    }),
  );
}

async function startLogin(app: Hono): Promise<{ k1: string; pollToken: string }> {
  return (await (await app.request('/auth/lnurl')).json()) as { k1: string; pollToken: string };
}

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

describe('auth routes', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe('GET /auth/lnurl', () => {
    it('returns 500 when PUBLIC_BASE_URL is not configured', async () => {
      const res = await mount(new InMemoryAuthStore(), undefined).request('/auth/lnurl');
      expect(res.status).toBe(500);
    });

    it('issues a challenge', async () => {
      const res = await mount(new InMemoryAuthStore(), BASE).request('/auth/lnurl');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { lnurl: string; k1: string };
      expect(body.lnurl).toBe(encodeLnurl(`${BASE}/auth/lnurl/callback?tag=login&k1=${body.k1}`));
      expect(body.k1).toMatch(/^[0-9a-f]{64}$/);
      expect(
        parsedEvents(warn).some(
          (e) => e['event'] === 'auth.challenge.issued' && e['k1'] === body.k1,
        ),
      ).toBe(true);
    });
  });

  describe('GET /auth/lnurl/callback', () => {
    it('returns ERROR on a malformed query', async () => {
      const res = await mount(new InMemoryAuthStore(), BASE).request('/auth/lnurl/callback?k1=abc');
      expect(await res.json()).toEqual({ status: 'ERROR', reason: 'Missing k1, sig, or key' });
      expect(
        parsedEvents(warn).some(
          (e) => e['event'] === 'auth.login.denied' && e['reason'] === 'Missing k1, sig, or key',
        ),
      ).toBe(true);
    });

    it('returns ERROR on an invalid signature', async () => {
      const app = mount(new InMemoryAuthStore(), BASE);
      const { k1 } = await startLogin(app);
      const res = await app.request(
        `/auth/lnurl/callback?k1=${k1}&sig=abcd&key=02${'a'.repeat(64)}`,
      );
      expect(await res.json()).toEqual({ status: 'ERROR', reason: 'Invalid signature' });
      expect(
        parsedEvents(warn).some(
          (e) => e['event'] === 'auth.login.denied' && e['reason'] === 'Invalid signature',
        ),
      ).toBe(true);
    });

    it('returns OK on a valid signature', async () => {
      const app = mount(new InMemoryAuthStore(), BASE);
      const { k1 } = await startLogin(app);
      const w = newWallet();
      const res = await app.request(
        `/auth/lnurl/callback?tag=login&k1=${k1}&sig=${w.sign(k1)}&key=${w.key}`,
      );
      expect(await res.json()).toEqual({ status: 'OK' });
      const loginOk = parsedEvents(warn).find((e) => e['event'] === 'auth.login.ok');
      expect(loginOk).toBeDefined();
      expect(loginOk?.['firstLogin']).toBe(true);
      expect(loginOk?.['linkingKey']).toBe(w.key.toLowerCase());
      expect(typeof loginOk?.['accountId']).toBe('string');
      expect((loginOk?.['accountId'] as string).length).toBeGreaterThan(0);
      expect(loginOk?.['userAgent']).toBe('unknown');
    });

    it('records the User-Agent when present', async () => {
      const app = mount(new InMemoryAuthStore(), BASE);
      const { k1 } = await startLogin(app);
      const w = newWallet();
      const res = await app.request(
        `/auth/lnurl/callback?tag=login&k1=${k1}&sig=${w.sign(k1)}&key=${w.key}`,
        { headers: { 'user-agent': 'Copay' } },
      );
      expect(await res.json()).toEqual({ status: 'OK' });
      const loginOk = parsedEvents(warn).find((e) => e['event'] === 'auth.login.ok');
      expect(loginOk?.['userAgent']).toBe('Copay');
    });
  });

  describe('GET /auth/session', () => {
    it('returns expired without a poll token', async () => {
      const res = await mount(new InMemoryAuthStore(), BASE).request('/auth/session');
      expect(await res.json()).toEqual({ status: 'expired' });
    });

    it('returns pending before the wallet signs', async () => {
      const app = mount(new InMemoryAuthStore(), BASE);
      const { pollToken } = await startLogin(app);
      const res = await app.request('/auth/session', { headers: { 'x-poll-token': pollToken } });
      expect(((await res.json()) as { status: string }).status).toBe('pending');
    });

    it('emits auth.session.issued when the poll authenticates', async () => {
      const app = mount(new InMemoryAuthStore(), BASE);
      const { k1, pollToken } = await startLogin(app);
      const w = newWallet();
      await app.request(`/auth/lnurl/callback?tag=login&k1=${k1}&sig=${w.sign(k1)}&key=${w.key}`);
      const loginOk = parsedEvents(warn).find((e) => e['event'] === 'auth.login.ok');
      const accountId = loginOk?.['accountId'];
      const res = await app.request('/auth/session', { headers: { 'x-poll-token': pollToken } });
      expect(((await res.json()) as { status: string }).status).toBe('authenticated');
      expect(
        parsedEvents(warn).some(
          (e) => e['event'] === 'auth.session.issued' && e['accountId'] === accountId,
        ),
      ).toBe(true);
    });
  });

  describe('POST /auth/passkey/register', () => {
    it('returns 500 when WEBAUTHN_RP_ID is not configured', async () => {
      const res = await mount(new InMemoryAuthStore(), BASE, '').request(
        '/auth/passkey/register/begin',
        { method: 'POST' },
      );
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Server auth is not configured' });
    });

    it('returns 500 on finish when WEBAUTHN_RP_ID is not configured', async () => {
      const res = await mount(new InMemoryAuthStore(), BASE, '').request(
        '/auth/passkey/register/finish',
        { method: 'POST' },
      );
      expect(res.status).toBe(500);
    });

    it('issues creation options', async () => {
      const res = await mount(new InMemoryAuthStore(), BASE).request(
        '/auth/passkey/register/begin',
        { method: 'POST' },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { challengeId: string; options: { challenge: string } };
      expect(body.challengeId).toMatch(/^[0-9a-f]{64}$/);
      expect(body.options.challenge).toBe('test-challenge');
    });

    it('rejects a missing finish body', async () => {
      const res = await mount(new InMemoryAuthStore(), BASE).request(
        '/auth/passkey/register/finish',
        { method: 'POST', headers: { origin: ORIGIN } },
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Expected a JSON body with challengeId and credential',
      });
    });

    it('rejects a missing origin on finish', async () => {
      const store = new InMemoryAuthStore();
      const app = mount(store, BASE);
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
      const app = mount(store, BASE);
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
        account: { id: string; linkingKey: string | null };
      };
      expect(body.token).toMatch(/^[0-9a-f]{64}$/);
      expect(body.account.linkingKey).toBeNull();
      expect(
        parsedEvents(warn).some(
          (e) => e['event'] === 'auth.passkey.register.ok' && e['accountId'] === body.account.id,
        ),
      ).toBe(true);

      const meApp = new Hono().route(
        '/me',
        meRoutes({
          store,
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
      const app = mount(new InMemoryAuthStore(), BASE);
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
      const app = mount(new InMemoryAuthStore(), BASE);
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

    it('rejects finishing an authenticate challenge as register', async () => {
      const app = mount(new InMemoryAuthStore(), BASE);
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
      const res = await mount(new InMemoryAuthStore(), BASE, '').request(
        '/auth/passkey/authenticate/begin',
        { method: 'POST' },
      );
      expect(res.status).toBe(500);
    });

    it('returns 500 on finish when unconfigured', async () => {
      const res = await mount(new InMemoryAuthStore(), BASE, '').request(
        '/auth/passkey/authenticate/finish',
        { method: 'POST' },
      );
      expect(res.status).toBe(500);
    });

    it('rejects a missing finish body', async () => {
      const res = await mount(new InMemoryAuthStore(), BASE).request(
        '/auth/passkey/authenticate/finish',
        { method: 'POST', headers: { origin: ORIGIN } },
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Expected a JSON body with challengeId and credential',
      });
    });

    it('authenticates a registered credential', async () => {
      const app = mount(new InMemoryAuthStore(), BASE);
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
      const body = (await res.json()) as { token: string; account: { id: string } };
      expect(body.account.id).toBe(accountId);
      expect(
        parsedEvents(warn).some(
          (e) => e['event'] === 'auth.passkey.login.ok' && e['accountId'] === accountId,
        ),
      ).toBe(true);
    });

    it('rejects an unknown credential', async () => {
      const app = mount(new InMemoryAuthStore(), BASE);
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
      const app = mount(new InMemoryAuthStore(), BASE);
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
      const app = mount(new InMemoryAuthStore(), BASE);
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
      const res = await mount(new InMemoryAuthStore(), BASE).request(
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
      const app = mount(new InMemoryAuthStore(), BASE);
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
});
