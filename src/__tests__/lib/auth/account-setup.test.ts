import { describe, expect, it } from 'vitest';
import { accountSetup } from '@/lib/auth/account-setup';
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
});
