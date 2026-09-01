import { describe, expect, it } from 'vitest';
import {
  serializeAccount,
  serializeDebugAccount,
  serializeOwnerAccount,
  serializeViewProfile,
} from '@/lib/auth/account-json';
import type { Account } from '@/lib/auth/store';

const account: Account = {
  id: 'acc',
  linkingKey: null,
  role: 'basis',
  name: 'Ada',
  lightningAddress: 'ada@walletofsatoshi.com',
  lightningAddressVerified: false,
  forumLawsDismissed: false,
  viewKey: 'a'.repeat(64),
  createdAt: 1,
  rulesAgreedAt: null,
};

describe('serializeAccount', () => {
  it('emits only the nine public fields without viewKey', () => {
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
      rulesAgreedAt: null,
    });
    expect(json).not.toHaveProperty('viewKey');
    expect(Object.keys(json)).toHaveLength(9);
    expect(JSON.stringify(json)).not.toMatch(/nostr|npub|nsec/i);
  });
});

describe('serializeDebugAccount', () => {
  it('adds isPlatform without exposing viewKey', () => {
    const json = serializeDebugAccount({ ...account, isPlatform: true });
    expect(json.isPlatform).toBe(true);
    expect(json).not.toHaveProperty('viewKey');
    expect(serializeDebugAccount(account).isPlatform).toBe(false);
  });
});

describe('serializeOwnerAccount', () => {
  it('includes viewKey alongside the nine public fields', () => {
    const json = serializeOwnerAccount(account);
    expect(json).toEqual({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: 'ada@walletofsatoshi.com',
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      createdAt: 1,
      rulesAgreedAt: null,
      viewKey: 'a'.repeat(64),
      setup: 'rules',
    });
    expect(json.viewKey).toBe(account.viewKey);
    expect(json.setup).toBe('rules');
    expect(json).not.toHaveProperty('isPlatform');
  });
});

describe('serializeViewProfile', () => {
  it('emits exactly five public profile fields', () => {
    const json = serializeViewProfile(account, false);
    expect(json).toEqual({
      name: 'Ada',
      lightningAddress: 'ada@walletofsatoshi.com',
      lightningAddressVerified: false,
      createdAt: 1,
      hasPasskey: false,
    });
    expect(json).not.toHaveProperty('id');
    expect(json).not.toHaveProperty('linkingKey');
    expect(json).not.toHaveProperty('role');
    expect(json).not.toHaveProperty('viewKey');
    expect(Object.keys(json)).toHaveLength(5);
  });

  it('passes through hasPasskey true', () => {
    expect(serializeViewProfile(account, true).hasPasskey).toBe(true);
  });
});
