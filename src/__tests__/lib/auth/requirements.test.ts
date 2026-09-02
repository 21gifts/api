import { describe, expect, it } from 'vitest';
import { accountMissing } from '@/lib/auth/account-setup';
import {
  actionRequirements,
  MISSING_REQUIREMENTS_ERROR,
  requireAction,
} from '@/lib/auth/requirements';
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

describe('actionRequirements', () => {
  it('lists fields for each action', () => {
    expect(actionRequirements('forum.read')).toEqual(['rules']);
    expect(actionRequirements('forum.post')).toEqual(['rules', 'name']);
    expect(actionRequirements('contact.post')).toEqual(['rules', 'name']);
    expect(actionRequirements('forum.pay')).toEqual(['rules']);
  });
});

describe('requireAction', () => {
  it('ok when all required fields are present', () => {
    const account: Account = {
      ...base,
      name: 'Ada',
      rulesAgreedAt: 2,
    };
    expect(requireAction(account, 'forum.post')).toEqual({ ok: true });
    expect(requireAction(account, 'forum.read')).toEqual({ ok: true });
    expect(requireAction(account, 'forum.pay')).toEqual({ ok: true });
  });

  it('does not treat skip as satisfying missing', () => {
    const account: Account = {
      ...base,
      nameSkippedAt: 10,
      lightningAddressSkippedAt: 11,
      rulesAgreedAt: 12,
    };
    expect(accountMissing(account)).toEqual(['name', 'lightning-address']);
    expect(requireAction(account, 'forum.post')).toEqual({
      ok: false,
      missing: ['name'],
    });
  });

  it('orders 409 missing as rules then name', () => {
    const account: Account = { ...base };
    expect(requireAction(account, 'forum.post')).toEqual({
      ok: false,
      missing: ['rules', 'name'],
    });
    expect(MISSING_REQUIREMENTS_ERROR).toBe('missing_requirements');
  });

  it('forum.pay only requires rules for the payer', () => {
    const account: Account = {
      ...base,
      name: null,
      lightningAddress: null,
      rulesAgreedAt: 2,
    };
    expect(requireAction(account, 'forum.pay')).toEqual({ ok: true });
  });
});
