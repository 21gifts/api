import { describe, expect, it } from 'vitest';
import { accountMissing, accountSetup } from '@/lib/auth/account-setup';
import type { Account } from '@/lib/auth/store';

const base: Account = {
  id: 'acc',
  linkingKey: null,
  role: 'basis',
  name: null,
  forumLawsDismissed: false,
  location: null,
  viewKey: 'a'.repeat(64),
  createdAt: 1,
  rulesAgreedAt: null,
};

describe('accountSetup', () => {
  it('asks for a name first', () => {
    expect(accountSetup(base)).toBe('name');
  });

  it('asks for a name when a recovery phrase is required', () => {
    expect(accountSetup({ ...base, walletRequired: true })).toBe('name');
    expect(accountSetup({ ...base, walletRequired: true, walletBackupSeenAt: null })).toBe('name');
    expect(
      accountSetup({
        ...base,
        walletRequired: true,
        name: 'Ada',
        username: 'ada',
        sparkPubkeyVerifiedAt: 3,
        rulesAgreedAt: 2,
      }),
    ).toBeNull();
  });

  it('does not ask for wallet when required is false or omitted', () => {
    expect(accountSetup({ ...base, walletRequired: false })).toBe('name');
    expect(accountSetup(base)).toBe('name');
  });

  it('asks for a name when a recovery phrase is required and the marker is set', () => {
    expect(accountSetup({ ...base, walletRequired: true, walletBackupSeenAt: 10 })).toBe('name');
  });

  it('treats a blank name as missing', () => {
    expect(accountSetup({ ...base, name: '  ' })).toBe('name');
  });

  it('asks for a username after a name', () => {
    expect(accountSetup({ ...base, name: 'Ada' })).toBe('username');
  });

  it('treats a blank username as missing', () => {
    expect(accountSetup({ ...base, name: 'Ada', username: '  ' })).toBe('username');
  });

  it('asks for the receiving wallet after a name and username', () => {
    expect(accountSetup({ ...base, name: 'Ada', username: 'ada' })).toBe('lightning-address');
  });

  it('asks for rules once the wallet is verified', () => {
    expect(
      accountSetup({
        ...base,
        name: 'Ada',
        username: 'ada',
        sparkPubkeyVerifiedAt: 3,
      }),
    ).toBe('rules');
  });

  it('asks for rules once the wallet step is skipped', () => {
    expect(
      accountSetup({
        ...base,
        name: 'Ada',
        username: 'ada',
        lightningAddressSkippedAt: 11,
      }),
    ).toBe('rules');
  });

  it('is complete when name, username, a verified wallet, and rules are set', () => {
    expect(
      accountSetup({
        ...base,
        name: 'Ada',
        username: 'ada',
        sparkPubkeyVerifiedAt: 3,
        rulesAgreedAt: 2,
      }),
    ).toBeNull();
  });

  it('treats a skipped name as done and asks for a username', () => {
    expect(accountSetup({ ...base, nameSkippedAt: 10 })).toBe('username');
  });

  it('cannot skip username even when name and the wallet step are skipped', () => {
    expect(
      accountSetup({
        ...base,
        nameSkippedAt: 10,
        lightningAddressSkippedAt: 11,
      }),
    ).toBe('username');
  });

  it('is complete when name is skipped, username is set, the wallet step is skipped, and rules are agreed', () => {
    expect(
      accountSetup({
        ...base,
        username: 'ada',
        nameSkippedAt: 10,
        lightningAddressSkippedAt: 11,
        rulesAgreedAt: 12,
      }),
    ).toBeNull();
  });

  it('is complete when a recovery phrase is required and the other steps are done', () => {
    expect(
      accountSetup({
        ...base,
        walletRequired: true,
        walletBackupSeenAt: 9,
        username: 'ada',
        nameSkippedAt: 10,
        lightningAddressSkippedAt: 11,
        rulesAgreedAt: 12,
      }),
    ).toBeNull();
  });
});

describe('accountMissing', () => {
  it('lists skipped fields as still missing', () => {
    expect(
      accountMissing({
        ...base,
        nameSkippedAt: 10,
        lightningAddressSkippedAt: 11,
      }),
    ).toEqual(['name', 'username', 'lightning-address', 'rules']);
  });

  it('does not list wallet when a recovery phrase is required', () => {
    expect(accountMissing({ ...base, walletRequired: true })).toEqual([
      'name',
      'username',
      'lightning-address',
      'rules',
    ]);
    expect(
      accountMissing({
        ...base,
        walletRequired: true,
        nameSkippedAt: 10,
        lightningAddressSkippedAt: 11,
      }),
    ).toEqual(['name', 'username', 'lightning-address', 'rules']);
  });

  it('omits wallet when a recovery phrase is required and the marker is set', () => {
    expect(
      accountMissing({
        ...base,
        walletRequired: true,
        walletBackupSeenAt: 10,
        name: 'Ada',
        username: 'ada',
        sparkPubkeyVerifiedAt: 3,
        rulesAgreedAt: 2,
      }),
    ).toEqual([]);
  });

  it('omits wallet when not required', () => {
    expect(accountMissing({ ...base, walletRequired: false })).toEqual([
      'name',
      'username',
      'lightning-address',
      'rules',
    ]);
  });

  it('omits set fields', () => {
    expect(
      accountMissing({
        ...base,
        name: 'Ada',
        username: 'ada',
        sparkPubkeyVerifiedAt: 3,
        rulesAgreedAt: 2,
      }),
    ).toEqual([]);
  });

  it('lists lightning-address until the wallet is verified, even when skipped', () => {
    const named: Account = {
      ...base,
      name: 'Ada',
      username: 'ada',
      lightningAddressSkippedAt: 11,
      rulesAgreedAt: 2,
    };
    expect(accountSetup(named)).toBeNull();
    expect(accountMissing(named)).toEqual(['lightning-address']);
    expect(accountMissing({ ...named, sparkPubkey: `02${'a'.repeat(64)}` })).toEqual([
      'lightning-address',
    ]);
  });

  it('counts a verified wallet for both setup and missing', () => {
    const wallet: Account = {
      ...base,
      name: 'Ada',
      username: 'ada',
      rulesAgreedAt: 2,
      sparkPubkey: `02${'a'.repeat(64)}`,
      sparkPubkeyVerifiedAt: 3,
    };
    expect(accountMissing(wallet)).toEqual([]);
    expect(accountSetup(wallet)).toBeNull();
    expect(accountMissing({ ...wallet, sparkPubkeyVerifiedAt: null })).toEqual([
      'lightning-address',
    ]);
    expect(accountSetup({ ...wallet, sparkPubkeyVerifiedAt: null })).toBe('lightning-address');
  });
});
