import { describe, expect, it } from 'vitest';
import {
  serializeAccount,
  serializeDebugAccount,
  serializeOwnerAccount,
  serializeOwnerAccountWithPosts,
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
    expect(json).not.toHaveProperty('hasPosted');
    expect(Object.keys(json)).toHaveLength(9);
    expect(JSON.stringify(json)).not.toMatch(/nostr|npub|nsec/i);
  });
});

describe('serializeDebugAccount', () => {
  it('adds isPlatform without exposing viewKey', () => {
    const json = serializeDebugAccount({ ...account, isPlatform: true });
    expect(json.isPlatform).toBe(true);
    expect(json).not.toHaveProperty('viewKey');
    expect(json).not.toHaveProperty('hasPosted');
    expect(serializeDebugAccount(account).isPlatform).toBe(false);
  });
});

describe('serializeOwnerAccount', () => {
  it('includes viewKey, setup, missing, and hasPosted false alongside the nine public fields', () => {
    const json = serializeOwnerAccount(account, false);
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
      missing: ['rules'],
      hasPosted: false,
    });
    expect(json.viewKey).toBe(account.viewKey);
    expect(json.setup).toBe('rules');
    expect(json.missing).toEqual(['rules']);
    expect(json.hasPosted).toBe(false);
    expect(json).not.toHaveProperty('isPlatform');
    expect(json).not.toHaveProperty('profileMessageId');
  });

  it('passes hasPosted true through', () => {
    const json = serializeOwnerAccount(account, true);
    expect(json.hasPosted).toBe(true);
    expect(json).not.toHaveProperty('isPlatform');
    expect(json).not.toHaveProperty('profileMessageId');
  });
});

describe('serializeOwnerAccountWithPosts', () => {
  it('sets hasPosted false when the store reports no live post', async () => {
    let excludeId: string | null | undefined;
    const json = await serializeOwnerAccountWithPosts(account, {
      accountHasLivePost: async (_accountId, id) => {
        excludeId = id;
        return false;
      },
    });
    expect(excludeId).toBeNull();
    expect(json.hasPosted).toBe(false);
    expect(json).not.toHaveProperty('profileMessageId');
    expect(json).not.toHaveProperty('isPlatform');
  });

  it('sets hasPosted true when the store reports a live post', async () => {
    const json = await serializeOwnerAccountWithPosts(account, {
      accountHasLivePost: async () => true,
    });
    expect(json.hasPosted).toBe(true);
  });

  it('passes profileMessageId as the exclude id', async () => {
    let seen: { accountId: string; excludeId: string | null } | undefined;
    const json = await serializeOwnerAccountWithPosts(
      { ...account, profileMessageId: 'note-1' },
      {
        accountHasLivePost: async (accountId, excludeId) => {
          seen = { accountId, excludeId };
          return false;
        },
      },
    );
    expect(seen).toEqual({ accountId: 'acc', excludeId: 'note-1' });
    expect(json.hasPosted).toBe(false);
    expect(json).not.toHaveProperty('profileMessageId');
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
    expect(json).not.toHaveProperty('hasPosted');
    expect(Object.keys(json)).toHaveLength(5);
  });

  it('passes through hasPasskey true', () => {
    expect(serializeViewProfile(account, true).hasPasskey).toBe(true);
  });
});
