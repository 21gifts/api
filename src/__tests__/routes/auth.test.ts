import { describe, it, expect } from 'vitest';
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
  });
});

describe('GET /auth/lnurl/callback', () => {
  it('returns ERROR on a malformed query', async () => {
    const res = await mount(new InMemoryAuthStore(), BASE).request('/auth/lnurl/callback?k1=abc');
    expect(await res.json()).toEqual({ status: 'ERROR', reason: 'Missing k1, sig, or key' });
  });

  it('returns ERROR on an invalid signature', async () => {
    const app = mount(new InMemoryAuthStore(), BASE);
    const { k1 } = await startLogin(app);
    const res = await app.request(`/auth/lnurl/callback?k1=${k1}&sig=abcd&key=02${'a'.repeat(64)}`);
    expect(await res.json()).toEqual({ status: 'ERROR', reason: 'Invalid signature' });
  });

  it('returns OK on a valid signature', async () => {
    const app = mount(new InMemoryAuthStore(), BASE);
    const { k1 } = await startLogin(app);
    const w = newWallet();
    const res = await app.request(
      `/auth/lnurl/callback?tag=login&k1=${k1}&sig=${w.sign(k1)}&key=${w.key}`,
    );
    expect(await res.json()).toEqual({ status: 'OK' });
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
