import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { authRoutes } from '@/routes/auth';
import { newWallet } from '@/__tests__/helpers/auth-vectors';

const BASE = 'https://dev-api.21.gifts';
const now = (): number => 1_000_000;

function mount(store: InMemoryAuthStore, publicBaseUrl: string | undefined): Hono {
  return new Hono().route('/auth', authRoutes({ store, now, publicBaseUrl }));
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
      expect(body.lnurl.startsWith('lnurl1')).toBe(true);
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
  });
});
