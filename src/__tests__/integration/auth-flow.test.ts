import { describe, it, expect } from 'vitest';
import { createApp } from '@/server';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { FakePasskeyCeremony } from '@/__tests__/helpers/fake-passkey';

const ORIGIN = 'http://localhost:3000';

describe('passkey auth end-to-end via createApp', () => {
  it('registers a passkey and serves /me with the issued token', async () => {
    const store = new InMemoryAuthStore();
    const app = createApp({
      authStore: store,
      now: () => 1_000_000,
      allowedOrigins: [ORIGIN],
      webAuthnRpId: 'localhost',
      passkeyCeremony: new FakePasskeyCeremony(),
    });
    const begin = (await (
      await app.request('/auth/passkey/register/begin', { method: 'POST' })
    ).json()) as { challengeId: string };
    const finish = await app.request('/auth/passkey/register/finish', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ challengeId: begin.challengeId, credential: { test: 'ok' } }),
    });
    expect(finish.status).toBe(200);
    const body = (await finish.json()) as {
      token: string;
      account: { linkingKey: string | null };
    };
    expect(body.account.linkingKey).toBeNull();
    const me = await app.request('/me', { headers: { authorization: `Bearer ${body.token}` } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { linkingKey: string | null }).linkingKey).toBeNull();
  });

  it('returns 500 from passkey begin when WEBAUTHN_RP_ID is unset', async () => {
    const res = await createApp({ webAuthnRpId: '' }).request('/auth/passkey/register/begin', {
      method: 'POST',
    });
    expect(res.status).toBe(500);
  });
});
