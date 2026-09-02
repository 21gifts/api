import { describe, expect, it } from 'vitest';
import { accountMissing, accountSetup } from '@/lib/auth/account-setup';
import type { Account } from '@/lib/auth/store';

const base: Account = {
  id: 'acc',
  linkingKey: null,
  role: 'basis',
  name: null,
  lightningAddress: null,
  lightningAddressVerified: false,
  forumLawsDismissed: false,
  viewKey: 'a'.repeat(64),
  createdAt: 1,
  rulesAgreedAt: null,
};

describe('accountSetup', () => {
  it('asks for a name first', () => {
    expect(accountSetup(base)).toBe('name');
  });

  it('treats a blank name as missing', () => {
    expect(accountSetup({ ...base, name: '  ' })).toBe('name');
  });

  it('asks for a Lightning Address after a name', () => {
    expect(accountSetup({ ...base, name: 'Ada' })).toBe('lightning-address');
  });

  it('treats a blank Lightning Address as missing', () => {
    expect(accountSetup({ ...base, name: 'Ada', lightningAddress: '  ' })).toBe(
      'lightning-address',
    );
  });

  it('asks for rules after name and Lightning Address', () => {
    expect(
      accountSetup({
        ...base,
        name: 'Ada',
        lightningAddress: 'ada@walletofsatoshi.com',
      }),
    ).toBe('rules');
  });

  it('is complete when name, Lightning Address, and rules are set', () => {
    expect(
      accountSetup({
        ...base,
        name: 'Ada',
        lightningAddress: 'ada@walletofsatoshi.com',
        rulesAgreedAt: 2,
      }),
    ).toBeNull();
  });

  it('treats a skipped name as done and asks for Lightning Address', () => {
    expect(accountSetup({ ...base, nameSkippedAt: 10 })).toBe('lightning-address');
  });

  it('asks for rules when name and Lightning Address are skipped', () => {
    expect(
      accountSetup({
        ...base,
        nameSkippedAt: 10,
        lightningAddressSkippedAt: 11,
      }),
    ).toBe('rules');
  });

  it('is complete when both steps are skipped and rules are agreed', () => {
    expect(
      accountSetup({
        ...base,
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
    ).toEqual(['name', 'lightning-address', 'rules']);
  });

  it('omits set fields', () => {
    expect(
      accountMissing({
        ...base,
        name: 'Ada',
        lightningAddress: 'ada@walletofsatoshi.com',
        rulesAgreedAt: 2,
      }),
    ).toEqual([]);
  });

  it('lists lightning-address again after unlink clears the skip', () => {
    const afterUnlink: Account = {
      ...base,
      name: 'Ada',
      lightningAddress: null,
      lightningAddressSkippedAt: null,
      rulesAgreedAt: 2,
    };
    expect(accountSetup(afterUnlink)).toBe('lightning-address');
    expect(accountMissing(afterUnlink)).toEqual(['lightning-address']);
  });
});
