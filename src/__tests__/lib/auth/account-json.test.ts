import { describe, expect, it } from 'vitest';
import {
  EMPTY_DEBUG_NOSTR,
  debugNostrFieldsFromListRow,
  serializeAccount,
  serializeDebugAccount,
  serializeDebugAccountDetail,
  serializeDebugPasskey,
  serializeOwnerAccount,
  serializeOwnerAccountWithPosts,
  serializeViewProfile,
} from '@/lib/auth/account-json';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import { InMemoryFundingStore } from '@/lib/funding-store';
import { unsignedNostrDefaults } from '@/lib/message';
import type { MessageRow } from '@/lib/message';

const account: Account = {
  id: 'acc',
  linkingKey: null,
  role: 'basis',
  name: 'Ada',
  username: 'ada',
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
  it('emits only the eleven public fields without viewKey', () => {
    const json = serializeAccount(account);
    expect(json).toEqual({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      username: 'ada',
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
    expect(json).not.toHaveProperty('amountUnit');
    expect(json).not.toHaveProperty('walletRequired');
    expect(json).not.toHaveProperty('walletBackupSeenAt');
    expect(Object.keys(json)).toHaveLength(11);
    expect(JSON.stringify(json)).not.toMatch(/nostr|npub|nsec/i);
  });
});

describe('debugNostrFieldsFromListRow', () => {
  it('hex-encodes the stored envelope and never decrypts', () => {
    const fields = debugNostrFieldsFromListRow({
      accountId: 'acc',
      record: {
        pubkey: 'ab'.repeat(32),
        ciphertext: new Uint8Array([9, 8, 7]),
        kekId: 1,
        custody: 'custodial',
      },
      createdAt: 42,
    });
    expect(fields).toEqual({
      nostrPubkey: 'ab'.repeat(32),
      nostrNsecCiphertext: '090807',
      nostrKekId: 1,
      nostrKeyCustody: 'custodial',
      nostrKeyCreatedAt: 42,
    });
    expect(fields.nostrNsecCiphertext).toMatch(/^[0-9a-f]+$/);
    expect(fields.nostrNsecCiphertext).not.toMatch(/nsec/i);
  });

  it('emits null ciphertext for an empty envelope and EMPTY_DEBUG_NOSTR when missing', () => {
    expect(
      debugNostrFieldsFromListRow({
        accountId: 'acc',
        record: {
          pubkey: 'cd'.repeat(32),
          ciphertext: new Uint8Array(),
          kekId: 1,
          custody: 'custodial',
        },
        createdAt: null,
      }),
    ).toEqual({
      nostrPubkey: 'cd'.repeat(32),
      nostrNsecCiphertext: null,
      nostrKekId: 1,
      nostrKeyCustody: 'custodial',
      nostrKeyCreatedAt: null,
    });
    expect(debugNostrFieldsFromListRow(undefined)).toEqual(EMPTY_DEBUG_NOSTR);
  });

  it('emits stored kek and custody when pubkey is null', () => {
    expect(
      debugNostrFieldsFromListRow({
        accountId: 'acc',
        record: {
          pubkey: null,
          ciphertext: new Uint8Array(),
          kekId: 1,
          custody: 'custodial',
        },
        createdAt: null,
      }),
    ).toEqual({
      nostrPubkey: null,
      nostrNsecCiphertext: null,
      nostrKekId: 1,
      nostrKeyCustody: 'custodial',
      nostrKeyCreatedAt: null,
    });
    expect(
      debugNostrFieldsFromListRow({
        accountId: 'acc',
        record: {
          pubkey: null,
          ciphertext: new Uint8Array([1, 2]),
          kekId: 1,
          custody: 'custodial',
        },
        createdAt: 7,
      }),
    ).toEqual({
      nostrPubkey: null,
      nostrNsecCiphertext: '0102',
      nostrKekId: 1,
      nostrKeyCustody: 'custodial',
      nostrKeyCreatedAt: 7,
    });
    expect(debugNostrFieldsFromListRow(undefined)).toEqual(EMPTY_DEBUG_NOSTR);
  });
});

describe('serializeDebugAccount', () => {
  it('adds isPlatform, viewKey, skip stamps, and null Nostr fields', () => {
    const json = serializeDebugAccount({ ...account, isPlatform: true });
    expect(json.isPlatform).toBe(true);
    expect(json.viewKey).toBe(account.viewKey);
    expect(json.notificationLevel).toBe('all');
    expect(json.amountUnit).toBe('btc');
    expect(json.nameSkippedAt).toBeNull();
    expect(json.lightningAddressSkippedAt).toBeNull();
    expect(json.profileMessageId).toBeNull();
    expect(json.walletRequired).toBe(false);
    expect(json.walletBackupSeenAt).toBeNull();
    expect(json.nostrPubkey).toBeNull();
    expect(json.nostrNsecCiphertext).toBeNull();
    expect(json).not.toHaveProperty('hasPosted');
    expect(json).not.toHaveProperty('aboutMe');
    expect(serializeDebugAccount(account).isPlatform).toBe(false);
    expect(serializeDebugAccount(account).sessionRefused).toBe(false);
    expect(serializeDebugAccount({ ...account, sessionRefused: true }).sessionRefused).toBe(true);
  });

  it('hex-encodes passkey public keys that are not Uint8Array', () => {
    const json = serializeDebugPasskey({
      credentialId: 'c',
      publicKey: new Uint8Array([255]).buffer as unknown as Uint8Array,
      signCount: 0,
      accountId: 'acc',
      createdAt: 1,
    });
    expect(json.publicKey).toMatch(/^[0-9a-f]+$/);
  });
});

describe('serializeDebugAccountDetail', () => {
  it('emits null addressVerification when none is stored', () => {
    const json = serializeDebugAccountDetail(account, EMPTY_DEBUG_NOSTR, {
      passkeys: [],
      sessions: [],
      addressVerification: undefined,
      passkeyChallenges: [],
    });
    expect(json.addressVerification).toBeNull();
  });
});

describe('serializeOwnerAccount', () => {
  it('includes viewKey, setup, missing, hasPosted, and aboutMe alongside the eleven public fields', () => {
    const json = serializeOwnerAccount(account, false, null, false);
    expect(json).toEqual({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      username: 'ada',
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
      amountUnit: 'btc',
      funding: null,
      walletRequired: false,
      walletBackupSeenAt: null,
      passkeyCredentialId: null,
    });
    expect(json.viewKey).toBe(account.viewKey);
    expect(json.setup).toBe('rules');
    expect(json.missing).toEqual(['rules']);
    expect(json.hasPosted).toBe(false);
    expect(json.aboutMe).toBeNull();
    expect(json.aboutMeHasPhoto).toBe(false);
    expect(json.notificationLevel).toBe('all');
    expect(json.amountUnit).toBe('btc');
    expect(json.walletRequired).toBe(false);
    expect(json.walletBackupSeenAt).toBeNull();
    expect(json.passkeyCredentialId).toBeNull();
    expect(json).not.toHaveProperty('isPlatform');
    expect(json).not.toHaveProperty('sessionRefused');
    expect(json).not.toHaveProperty('profileMessageId');
  });

  it('includes walletRequired and walletBackupSeenAt on owner JSON', () => {
    const json = serializeOwnerAccount(
      { ...account, walletRequired: true, walletBackupSeenAt: 9 },
      false,
      null,
      false,
    );
    expect(json.walletRequired).toBe(true);
    expect(json.walletBackupSeenAt).toBe(9);
    expect(json.setup).toBe('rules');
    expect(json.missing).toEqual(['rules']);
  });

  it('defaults omitted wallet fields on owner JSON', () => {
    const json = serializeOwnerAccount(account, false, null, false);
    expect(json.walletRequired).toBe(false);
    expect(json.walletBackupSeenAt).toBeNull();
  });

  it('includes a stored notificationLevel on owner JSON', () => {
    const json = serializeOwnerAccount(
      { ...account, notificationLevel: 'active' },
      false,
      null,
      false,
    );
    expect(json.notificationLevel).toBe('active');
  });

  it('includes a stored amountUnit on owner JSON', () => {
    const json = serializeOwnerAccount({ ...account, amountUnit: 'fiat' }, false, null, false);
    expect(json.amountUnit).toBe('fiat');
  });

  it('passes hasPosted and aboutMe through', () => {
    const json = serializeOwnerAccount(account, true, 'I build on Bitcoin', false);
    expect(json.hasPosted).toBe(true);
    expect(json.aboutMe).toBe('I build on Bitcoin');
    expect(json.aboutMeHasPhoto).toBe(false);
    expect(json).not.toHaveProperty('isPlatform');
    expect(json).not.toHaveProperty('sessionRefused');
    expect(json).not.toHaveProperty('profileMessageId');
  });

  it('passes aboutMeHasPhoto independently of aboutMe', () => {
    const json = serializeOwnerAccount(account, false, null, true);
    expect(json.aboutMe).toBeNull();
    expect(json.aboutMeHasPhoto).toBe(true);
    expect(json).not.toHaveProperty('profileMessageId');
  });

  it('includes an explicit funding object when provided', () => {
    const json = serializeOwnerAccount(account, false, null, false, {
      status: 'none',
      trialUtcDate: null,
      admittedAt: null,
      reviewedByName: null,
    });
    expect(json.funding).toEqual({
      status: 'none',
      trialUtcDate: null,
      admittedAt: null,
      reviewedByName: null,
    });
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
    expect(json).not.toHaveProperty('sessionRefused');
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
    expect(json.hasPosted).toBe(false);
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
    expect(json.hasPosted).toBe(false);
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
    expect(json.hasPosted).toBe(true);
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
    expect(json.hasPosted).toBe(true);
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
    expect(json.hasPosted).toBe(false);
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
    expect(json.hasPosted).toBe(true);
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
    expect(json.hasPosted).toBe(false);
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
    expect(missing.hasPosted).toBe(false);

    const hidden = await serializeOwnerAccountWithPosts(
      { ...account, profileMessageId: 'note-1' },
      {
        accountHasLivePost: async () => false,
        getById: async () => ({ ...note('I build on Bitcoin', true), deletedAt: new Date(1) }),
      },
    );
    expect(hidden.aboutMe).toBeNull();
    expect(hidden.aboutMeHasPhoto).toBe(false);
    expect(hidden.hasPosted).toBe(false);
  });

  it('sets funding null for basis and none for verified without a row', async () => {
    const none = await serializeOwnerAccountWithPosts(account, {
      accountHasLivePost: async () => false,
      getById: async () => undefined,
    });
    expect(none.funding).toBeNull();

    const verified = await serializeOwnerAccountWithPosts(
      { ...account, role: 'verified' },
      {
        accountHasLivePost: async () => false,
        getById: async () => undefined,
      },
    );
    expect(verified.funding).toEqual({
      status: 'none',
      trialUtcDate: null,
      admittedAt: null,
      reviewedByName: null,
    });
  });

  it('loads admitted funding and the reviewer name', async () => {
    const fundingStore = new InMemoryFundingStore([
      {
        accountId: 'acc',
        status: 'admitted',
        appliedAt: 1,
        decidedAt: 2,
        decidedBy: 'staff',
        trialUtcDate: null,
        admittedAt: 3,
        note: null,
      },
    ]);
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount({
      ...account,
      id: 'staff',
      name: 'Mod',
      role: 'moderator',
      viewKey: 'b'.repeat(64),
    });
    const json = await serializeOwnerAccountWithPosts(
      { ...account, role: 'verified' },
      {
        accountHasLivePost: async () => false,
        getById: async () => undefined,
      },
      { store: fundingStore, nowMs: 4, authStore },
    );
    expect(json.funding).toEqual({
      status: 'admitted',
      trialUtcDate: null,
      admittedAt: 3,
      reviewedByName: 'Mod',
    });
    expect(json.passkeyCredentialId).toBeNull();
  });

  it('leaves passkeyCredentialId null when walletRequired is not true', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount(account);
    expect(
      await authStore.createPasskeyCredential({
        credentialId: 'cred-owner',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(true);
    const json = await serializeOwnerAccountWithPosts(
      account,
      {
        accountHasLivePost: async () => false,
        getById: async () => undefined,
      },
      { store: new InMemoryFundingStore(), nowMs: 1, authStore },
    );
    expect(json.passkeyCredentialId).toBeNull();
  });

  it('surfaces the newest credential id when walletRequired is true', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount(account);
    expect(
      await authStore.createPasskeyCredential({
        credentialId: 'cred-old',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(true);
    expect(
      await authStore.addSeedPasskeyCredential({
        credentialId: 'cred-new',
        publicKey: new Uint8Array([2]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 2,
      }),
    ).toBe(true);
    const json = await serializeOwnerAccountWithPosts(
      { ...account, walletRequired: true },
      {
        accountHasLivePost: async () => false,
        getById: async () => undefined,
      },
      { store: new InMemoryFundingStore(), nowMs: 1, authStore },
    );
    expect(json.passkeyCredentialId).toBe('cred-new');
  });

  it('emits null passkeyCredentialId when walletRequired is true and none is stored', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount({ ...account, walletRequired: true });
    const json = await serializeOwnerAccountWithPosts(
      { ...account, walletRequired: true },
      {
        accountHasLivePost: async () => false,
        getById: async () => undefined,
      },
      { store: new InMemoryFundingStore(), nowMs: 1, authStore },
    );
    expect(json.passkeyCredentialId).toBeNull();
  });

  it('uses a null reviewer name when decidedBy is missing', async () => {
    const fundingStore = new InMemoryFundingStore([
      {
        accountId: 'acc',
        status: 'admitted',
        appliedAt: 1,
        decidedAt: 2,
        decidedBy: 'ghost',
        trialUtcDate: null,
        admittedAt: 3,
        note: null,
      },
    ]);
    const json = await serializeOwnerAccountWithPosts(
      { ...account, role: 'verified' },
      {
        accountHasLivePost: async () => false,
        getById: async () => undefined,
      },
      { store: fundingStore, nowMs: 4, authStore: new InMemoryAuthStore() },
    );
    expect(json.funding).toEqual({
      status: 'admitted',
      trialUtcDate: null,
      admittedAt: 3,
      reviewedByName: null,
    });
  });
});

describe('serializeViewProfile', () => {
  it('emits exactly nine public profile fields', () => {
    const json = serializeViewProfile(account, false, null, false);
    expect(json).toEqual({
      name: 'Ada',
      username: 'ada',
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
    expect(json).not.toHaveProperty('amountUnit');
    expect(Object.keys(json)).toHaveLength(9);
  });

  it('passes through hasPasskey and aboutMe', () => {
    const json = serializeViewProfile(account, true, 'Hello', true);
    expect(json.hasPasskey).toBe(true);
    expect(json.aboutMe).toBe('Hello');
    expect(json.aboutMeHasPhoto).toBe(true);
  });
});
