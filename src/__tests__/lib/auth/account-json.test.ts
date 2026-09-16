import { describe, expect, it } from 'vitest';
import {
  serializeAccount,
  serializeDebugAccount,
  serializeOwnerAccount,
  serializeOwnerAccountWithPosts,
  serializeViewProfile,
} from '@/lib/auth/account-json';
import type { Account } from '@/lib/auth/store';
import { unsignedNostrDefaults } from '@/lib/message';
import type { MessageRow } from '@/lib/message';

const account: Account = {
  id: 'acc',
  linkingKey: null,
  role: 'basis',
  name: 'Ada',
  lightningAddress: 'ada@walletofsatoshi.com',
  lightningAddressVerified: false,
  forumLawsDismissed: false,
  location: null,
  viewKey: 'a'.repeat(64),
  createdAt: 1,
  rulesAgreedAt: null,
};

function note(text: string, hasPhoto = false): MessageRow {
  return {
    id: 'note-1',
    accountId: 'acc',
    name: 'Ada',
    text,
    createdAt: new Date(0),
    hasPhoto,
    ...unsignedNostrDefaults(),
  };
}

describe('serializeAccount', () => {
  it('emits only the ten public fields without viewKey', () => {
    const json = serializeAccount(account);
    expect(json).toEqual({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      location: null,
      lightningAddress: 'ada@walletofsatoshi.com',
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      createdAt: 1,
      rulesAgreedAt: null,
    });
    expect(json).not.toHaveProperty('viewKey');
    expect(json).not.toHaveProperty('hasPosted');
    expect(json).not.toHaveProperty('aboutMe');
    expect(json).not.toHaveProperty('notificationLevel');
    expect(Object.keys(json)).toHaveLength(10);
    expect(JSON.stringify(json)).not.toMatch(/nostr|npub|nsec/i);
  });
});

describe('serializeDebugAccount', () => {
  it('adds isPlatform without exposing viewKey', () => {
    const json = serializeDebugAccount({ ...account, isPlatform: true });
    expect(json.isPlatform).toBe(true);
    expect(json).not.toHaveProperty('viewKey');
    expect(json).not.toHaveProperty('hasPosted');
    expect(json).not.toHaveProperty('aboutMe');
    expect(json).not.toHaveProperty('notificationLevel');
    expect(serializeDebugAccount(account).isPlatform).toBe(false);
  });
});

describe('serializeOwnerAccount', () => {
  it('includes viewKey, setup, missing, hasPosted, and aboutMe alongside the ten public fields', () => {
    const json = serializeOwnerAccount(account, false, null, false);
    expect(json).toEqual({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      location: null,
      lightningAddress: 'ada@walletofsatoshi.com',
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      createdAt: 1,
      rulesAgreedAt: null,
      viewKey: 'a'.repeat(64),
      setup: 'rules',
      missing: ['rules'],
      hasPosted: false,
      aboutMe: null,
      aboutMeHasPhoto: false,
      notificationLevel: 'all',
    });
    expect(json.viewKey).toBe(account.viewKey);
    expect(json.setup).toBe('rules');
    expect(json.missing).toEqual(['rules']);
    expect(json.hasPosted).toBe(false);
    expect(json.aboutMe).toBeNull();
    expect(json.aboutMeHasPhoto).toBe(false);
    expect(json.notificationLevel).toBe('all');
    expect(json).not.toHaveProperty('isPlatform');
    expect(json).not.toHaveProperty('profileMessageId');
  });

  it('includes a stored notificationLevel on owner JSON', () => {
    const json = serializeOwnerAccount({ ...account, notificationLevel: 'active' }, false, null);
    expect(json.notificationLevel).toBe('active');
  });

  it('passes hasPosted and aboutMe through', () => {
    const json = serializeOwnerAccount(account, true, 'I build on Bitcoin', false);
    expect(json.hasPosted).toBe(true);
    expect(json.aboutMe).toBe('I build on Bitcoin');
    expect(json.aboutMeHasPhoto).toBe(false);
    expect(json).not.toHaveProperty('isPlatform');
    expect(json).not.toHaveProperty('profileMessageId');
  });

  it('passes aboutMeHasPhoto independently of aboutMe', () => {
    const json = serializeOwnerAccount(account, false, null, true);
    expect(json.aboutMe).toBeNull();
    expect(json.aboutMeHasPhoto).toBe(true);
    expect(json).not.toHaveProperty('profileMessageId');
  });
});

describe('serializeOwnerAccountWithPosts', () => {
  it('sets hasPosted false and aboutMe null when there is no live post or note', async () => {
    let excludeId: string | null | undefined;
    let getByIdCalls = 0;
    const json = await serializeOwnerAccountWithPosts(account, {
      accountHasLivePost: async (_accountId, id) => {
        excludeId = id;
        return false;
      },
      getById: async () => {
        getByIdCalls += 1;
        return undefined;
      },
    });
    expect(excludeId).toBeNull();
    expect(getByIdCalls).toBe(0);
    expect(json.hasPosted).toBe(false);
    expect(json.aboutMe).toBeNull();
    expect(json.aboutMeHasPhoto).toBe(false);
    expect(json).not.toHaveProperty('profileMessageId');
    expect(json).not.toHaveProperty('isPlatform');
  });

  it('sets hasPosted true when the store reports a live post', async () => {
    const json = await serializeOwnerAccountWithPosts(account, {
      accountHasLivePost: async () => true,
      getById: async () => undefined,
    });
    expect(json.hasPosted).toBe(true);
    expect(json.aboutMe).toBeNull();
    expect(json.aboutMeHasPhoto).toBe(false);
  });

  it('passes profileMessageId as the exclude id and skips blank ids', async () => {
    let seen: { accountId: string; excludeId: string | null } | undefined;
    const json = await serializeOwnerAccountWithPosts(
      { ...account, profileMessageId: 'note-1' },
      {
        accountHasLivePost: async (accountId, excludeId) => {
          seen = { accountId, excludeId };
          return false;
        },
        getById: async () => undefined,
      },
    );
    expect(seen).toEqual({ accountId: 'acc', excludeId: 'note-1' });
    expect(json.hasPosted).toBe(false);
    expect(json.aboutMe).toBeNull();
    expect(json.aboutMeHasPhoto).toBe(false);
    expect(json).not.toHaveProperty('profileMessageId');

    let blankCalls = 0;
    await serializeOwnerAccountWithPosts(
      { ...account, profileMessageId: '  ' },
      {
        accountHasLivePost: async () => false,
        getById: async () => {
          blankCalls += 1;
          return undefined;
        },
      },
    );
    expect(blankCalls).toBe(0);
  });

  it('sets aboutMe null when the profile note is only the display name', async () => {
    const json = await serializeOwnerAccountWithPosts(
      { ...account, profileMessageId: 'note-1' },
      {
        accountHasLivePost: async () => false,
        getById: async () => note('Ada'),
      },
    );
    expect(json.aboutMe).toBeNull();
    expect(json.aboutMeHasPhoto).toBe(false);
  });

  it('sets aboutMeHasPhoto true on a name-copy note with a photo', async () => {
    const json = await serializeOwnerAccountWithPosts(
      { ...account, profileMessageId: 'note-1' },
      {
        accountHasLivePost: async () => false,
        getById: async () => note('Ada', true),
      },
    );
    expect(json.aboutMe).toBeNull();
    expect(json.aboutMeHasPhoto).toBe(true);
    expect(json).not.toHaveProperty('profileMessageId');
  });

  it('sets aboutMe to the profile-note bio', async () => {
    const json = await serializeOwnerAccountWithPosts(
      { ...account, profileMessageId: 'note-1' },
      {
        accountHasLivePost: async () => false,
        getById: async () => note('I build on Bitcoin'),
      },
    );
    expect(json.aboutMe).toBe('I build on Bitcoin');
    expect(json.aboutMeHasPhoto).toBe(false);
  });

  it('sets aboutMeHasPhoto true when getById returns hasPhoto true', async () => {
    const json = await serializeOwnerAccountWithPosts(
      { ...account, profileMessageId: 'note-1' },
      {
        accountHasLivePost: async () => false,
        getById: async () => note('I build on Bitcoin', true),
      },
    );
    expect(json.aboutMe).toBe('I build on Bitcoin');
    expect(json.aboutMeHasPhoto).toBe(true);
  });

  it('sets aboutMe null when the note is the stored name after a rename', async () => {
    const json = await serializeOwnerAccountWithPosts(
      { ...account, name: 'Grace', profileMessageId: 'note-1' },
      {
        accountHasLivePost: async () => false,
        getById: async () => note('Ada'),
      },
    );
    expect(json.aboutMe).toBeNull();
    expect(json.aboutMeHasPhoto).toBe(false);
  });

  it('sets aboutMe to a real bio after a display-name rename', async () => {
    const json = await serializeOwnerAccountWithPosts(
      { ...account, name: 'Grace', profileMessageId: 'note-1' },
      {
        accountHasLivePost: async () => false,
        getById: async () => note('I build on Bitcoin'),
      },
    );
    expect(json.aboutMe).toBe('I build on Bitcoin');
    expect(json.aboutMeHasPhoto).toBe(false);
  });

  it('sets aboutMe null when the profile note is soft-hidden', async () => {
    const json = await serializeOwnerAccountWithPosts(
      { ...account, profileMessageId: 'note-1' },
      {
        accountHasLivePost: async () => false,
        getById: async () => ({ ...note('I build on Bitcoin'), deletedAt: new Date(1) }),
      },
    );
    expect(json.aboutMe).toBeNull();
    expect(json.aboutMeHasPhoto).toBe(false);
  });

  it('sets aboutMeHasPhoto false when the profile note is missing or hidden', async () => {
    const missing = await serializeOwnerAccountWithPosts(
      { ...account, profileMessageId: 'note-1' },
      {
        accountHasLivePost: async () => false,
        getById: async () => undefined,
      },
    );
    expect(missing.aboutMe).toBeNull();
    expect(missing.aboutMeHasPhoto).toBe(false);

    const hidden = await serializeOwnerAccountWithPosts(
      { ...account, profileMessageId: 'note-1' },
      {
        accountHasLivePost: async () => false,
        getById: async () => ({ ...note('I build on Bitcoin', true), deletedAt: new Date(1) }),
      },
    );
    expect(hidden.aboutMe).toBeNull();
    expect(hidden.aboutMeHasPhoto).toBe(false);
  });
});

describe('serializeViewProfile', () => {
  it('emits exactly eight public profile fields', () => {
    const json = serializeViewProfile(account, false, null, false);
    expect(json).toEqual({
      name: 'Ada',
      location: null,
      lightningAddress: 'ada@walletofsatoshi.com',
      lightningAddressVerified: false,
      createdAt: 1,
      hasPasskey: false,
      aboutMe: null,
      aboutMeHasPhoto: false,
    });
    expect(json).not.toHaveProperty('id');
    expect(json).not.toHaveProperty('linkingKey');
    expect(json).not.toHaveProperty('role');
    expect(json).not.toHaveProperty('viewKey');
    expect(json).not.toHaveProperty('hasPosted');
    expect(json).not.toHaveProperty('profileMessageId');
    expect(json).not.toHaveProperty('notificationLevel');
    expect(Object.keys(json)).toHaveLength(8);
  });

  it('passes through hasPasskey and aboutMe', () => {
    const json = serializeViewProfile(account, true, 'Hello', true);
    expect(json.hasPasskey).toBe(true);
    expect(json.aboutMe).toBe('Hello');
    expect(json.aboutMeHasPhoto).toBe(true);
  });
});
