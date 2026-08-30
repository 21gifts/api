import { describe, expect, it } from 'vitest';
import { createApp } from '@/server';
import { InMemoryAuthStore } from '@/lib/auth/store';

describe('GET /.well-known/nostr.json', () => {
  it('returns names and CORS', async () => {
    const auth = new InMemoryAuthStore();
    await auth.createAccount({
      id: '00000000-0000-4000-8000-000000000001',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'cd'.repeat(32),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await auth.setNostrKeyIfAbsent('00000000-0000-4000-8000-000000000001', {
      pubkey: 'aa'.repeat(32),
      ciphertext: new Uint8Array(16),
      kekId: 1,
      custody: 'custodial',
    });
    const app = createApp({ authStore: auth });
    const res = await app.request('/.well-known/nostr.json?name=ada');
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const body = (await res.json()) as { names: Record<string, string> };
    expect(body.names['ada']).toBe('aa'.repeat(32));
  });

  it('returns 503 when the store throws', async () => {
    const auth = new InMemoryAuthStore();
    auth.listAccounts = async () => {
      throw new Error('boom');
    };
    const app = createApp({ authStore: auth });
    const res = await app.request('/.well-known/nostr.json');
    expect(res.status).toBe(503);
  });
});
