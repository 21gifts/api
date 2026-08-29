import { describe, expect, it } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { buildKind1Event } from '@/lib/nostr/event';
import { parseNostrKek } from '@/lib/nostr/kek';
import { ensureAccountNostrKey } from '@/lib/nostr/keys';
import { signEventForAccount } from '@/lib/nostr/sign';

const KEK = parseNostrKek('ef'.repeat(32));

describe('signEventForAccount', () => {
  it('signs a kind:1 for an account with keys', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      createdAt: 1,
    });
    await ensureAccountNostrKey(store, 'acc', KEK);
    const signed = await signEventForAccount(
      store,
      'acc',
      KEK,
      buildKind1Event('hi', 1_700_000_000),
    );
    expect(signed.id).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.kind).toBe(1);
    expect(signed.content).toBe('hi');
  });

  it('throws when the account has no secret', async () => {
    const store = new InMemoryAuthStore();
    await expect(
      signEventForAccount(store, 'missing', KEK, buildKind1Event('hi', 1)),
    ).rejects.toThrow(/missing/);
  });
});
