import { describe, expect, it } from 'vitest';
import { serializeAccount } from '@/lib/auth/account-json';
import type { Account } from '@/lib/auth/store';

const account: Account = {
  id: 'acc',
  linkingKey: null,
  role: 'basis',
  name: 'Ada',
  lightningAddress: 'ada@walletofsatoshi.com',
  lightningAddressVerified: false,
  forumLawsDismissed: false,
  createdAt: 1,
};

describe('serializeAccount', () => {
  it('emits only public fields', () => {
    const json = serializeAccount(account);
    expect(json).toEqual({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: 'ada@walletofsatoshi.com',
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      createdAt: 1,
    });
    expect(JSON.stringify(json)).not.toMatch(/nostr|npub|nsec/i);
  });
});
