import { describe, it, expect } from 'vitest';
import { createApp } from '@/server';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { newWallet } from '@/__tests__/helpers/auth-vectors';

describe('LNURL-auth end-to-end via createApp', () => {
  it('logs in from challenge to /me and consumes the challenge exactly once', async () => {
    const store = new InMemoryAuthStore();
    const app = createApp({
      authStore: store,
      now: () => 5_000_000,
      publicBaseUrl: 'https://dev-api.21.gifts',
    });

    const start = (await (await app.request('/auth/lnurl')).json()) as {
      k1: string;
      lnurl: string;
      pollToken: string;
    };
    expect(start.lnurl.startsWith('lnurl1')).toBe(true);

    const wallet = newWallet();
    const cb = await app.request(
      `/auth/lnurl/callback?tag=login&k1=${start.k1}&sig=${wallet.sign(start.k1)}&key=${wallet.key}`,
    );
    expect(await cb.json()).toEqual({ status: 'OK' });

    const sess = (await (
      await app.request('/auth/session', { headers: { 'x-poll-token': start.pollToken } })
    ).json()) as {
      status: string;
      token: string;
      account: { linkingKey: string };
    };
    expect(sess.status).toBe('authenticated');
    expect(sess.account.linkingKey).toBe(wallet.key);

    const me = await app.request('/me', { headers: { authorization: `Bearer ${sess.token}` } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { linkingKey: string }).linkingKey).toBe(wallet.key);

    const again = (await (
      await app.request('/auth/session', { headers: { 'x-poll-token': start.pollToken } })
    ).json()) as {
      status: string;
    };
    expect(again.status).toBe('used');
  });

  it('reads PUBLIC_BASE_URL from the environment when no override is given', async () => {
    const prev = process.env['PUBLIC_BASE_URL'];
    process.env['PUBLIC_BASE_URL'] = 'https://dev-api.21.gifts';
    try {
      const res = await createApp().request('/auth/lnurl');
      expect(res.status).toBe(200);
    } finally {
      if (prev === undefined) {
        delete process.env['PUBLIC_BASE_URL'];
      } else {
        process.env['PUBLIC_BASE_URL'] = prev;
      }
    }
  });
});
