import { describe, expect, it } from 'vitest';
import {
  ROLE_ORDER,
  canEditDailyPayoutRoster,
  canSignFondPayouts,
  earnsModeratorGroupPay,
  isModeratorGroupMember,
  roleAtLeast,
  roleRank,
} from '@/lib/auth/roles';
import type { AccountRole } from '@/lib/auth/store';

const roles: readonly AccountRole[] = [
  'basis',
  'verified',
  'moderator',
  'fond',
  'software_developer',
  'initiator',
  'founder',
];

describe('ROLE_ORDER', () => {
  it('lists the roles in hierarchy order', () => {
    expect(ROLE_ORDER).toEqual([
      'basis',
      'verified',
      'moderator',
      'fond',
      'software_developer',
      'initiator',
      'founder',
    ]);
  });
});

describe('roleRank', () => {
  it('is the seven-role hierarchy map', () => {
    expect(roleRank('basis')).toBe(0);
    expect(roleRank('verified')).toBe(1);
    expect(roleRank('moderator')).toBe(2);
    expect(roleRank('fond')).toBe(3);
    expect(roleRank('software_developer')).toBe(4);
    expect(roleRank('initiator')).toBe(5);
    expect(roleRank('founder')).toBe(6);
  });
});

describe('roleAtLeast', () => {
  it('is the full truth table of rank comparison', () => {
    const table: ReadonlyArray<readonly [AccountRole, AccountRole, boolean]> = [
      ['basis', 'basis', true],
      ['basis', 'verified', false],
      ['basis', 'moderator', false],
      ['basis', 'software_developer', false],
      ['basis', 'fond', false],
      ['basis', 'initiator', false],
      ['basis', 'founder', false],
      ['verified', 'basis', true],
      ['verified', 'verified', true],
      ['verified', 'moderator', false],
      ['verified', 'software_developer', false],
      ['verified', 'fond', false],
      ['verified', 'initiator', false],
      ['verified', 'founder', false],
      ['moderator', 'basis', true],
      ['moderator', 'verified', true],
      ['moderator', 'moderator', true],
      ['moderator', 'software_developer', false],
      ['moderator', 'fond', false],
      ['moderator', 'initiator', false],
      ['moderator', 'founder', false],
      ['software_developer', 'basis', true],
      ['software_developer', 'verified', true],
      ['software_developer', 'moderator', true],
      ['software_developer', 'software_developer', true],
      ['software_developer', 'fond', true],
      ['software_developer', 'initiator', false],
      ['software_developer', 'founder', false],
      ['fond', 'basis', true],
      ['fond', 'verified', true],
      ['fond', 'moderator', true],
      ['fond', 'software_developer', false],
      ['fond', 'fond', true],
      ['fond', 'initiator', false],
      ['fond', 'founder', false],
      ['initiator', 'basis', true],
      ['initiator', 'verified', true],
      ['initiator', 'moderator', true],
      ['initiator', 'software_developer', true],
      ['initiator', 'fond', true],
      ['initiator', 'initiator', true],
      ['initiator', 'founder', false],
      ['founder', 'basis', true],
      ['founder', 'verified', true],
      ['founder', 'moderator', true],
      ['founder', 'software_developer', true],
      ['founder', 'fond', true],
      ['founder', 'initiator', true],
      ['founder', 'founder', true],
    ];
    expect(table).toHaveLength(roles.length * roles.length);
    for (const [role, min, want] of table) {
      expect(roleAtLeast(role, min)).toBe(want);
      expect(roleAtLeast(role, min)).toBe(roleRank(role) >= roleRank(min));
    }
  });

  it('lets fond inherit every moderator right', () => {
    expect(roleAtLeast('fond', 'moderator')).toBe(true);
    expect(roleAtLeast('fond', 'verified')).toBe(true);
  });

  it('ranks the software developer above fond and below initiator', () => {
    expect(roleAtLeast('software_developer', 'fond')).toBe(true);
    expect(roleAtLeast('fond', 'software_developer')).toBe(false);
    expect(roleAtLeast('software_developer', 'initiator')).toBe(false);
  });
});

describe('isModeratorGroupMember', () => {
  it('admits every account that is at least a moderator', () => {
    expect(isModeratorGroupMember({ role: 'moderator' })).toBe(true);
    expect(isModeratorGroupMember({ role: 'software_developer' })).toBe(true);
    expect(isModeratorGroupMember({ role: 'fond' })).toBe(true);
    expect(isModeratorGroupMember({ role: 'initiator' })).toBe(true);
    expect(isModeratorGroupMember({ role: 'founder' })).toBe(true);
    expect(isModeratorGroupMember({ role: 'founder', isPlatform: false })).toBe(true);
  });

  it('keeps verified and basis members out', () => {
    expect(isModeratorGroupMember({ role: 'verified' })).toBe(false);
    expect(isModeratorGroupMember({ role: 'basis' })).toBe(false);
  });

  it('keeps the platform account out whatever role it carries', () => {
    expect(isModeratorGroupMember({ role: 'founder', isPlatform: true })).toBe(false);
    expect(isModeratorGroupMember({ role: 'moderator', isPlatform: true })).toBe(false);
    expect(isModeratorGroupMember({ role: 'software_developer', isPlatform: true })).toBe(false);
    expect(isModeratorGroupMember({ role: 'fond', isPlatform: true })).toBe(false);
    expect(isModeratorGroupMember({ role: 'initiator', isPlatform: true })).toBe(false);
  });
});

describe('earnsModeratorGroupPay', () => {
  it('pays every moderator-group member except the software developer', () => {
    expect(earnsModeratorGroupPay({ role: 'moderator' })).toBe(true);
    expect(earnsModeratorGroupPay({ role: 'fond' })).toBe(true);
    expect(earnsModeratorGroupPay({ role: 'initiator' })).toBe(true);
    expect(earnsModeratorGroupPay({ role: 'founder' })).toBe(true);
    expect(earnsModeratorGroupPay({ role: 'software_developer' })).toBe(false);
  });

  it('never pays the platform account or a non-group role', () => {
    expect(earnsModeratorGroupPay({ role: 'founder', isPlatform: true })).toBe(false);
    expect(earnsModeratorGroupPay({ role: 'verified' })).toBe(false);
    expect(earnsModeratorGroupPay({ role: 'basis' })).toBe(false);
  });
});

describe('canEditDailyPayoutRoster', () => {
  it('is true only for initiator and founder', () => {
    expect(canEditDailyPayoutRoster('initiator')).toBe(true);
    expect(canEditDailyPayoutRoster('founder')).toBe(true);
    expect(canEditDailyPayoutRoster('software_developer')).toBe(false);
    expect(canEditDailyPayoutRoster('fond')).toBe(false);
    expect(canEditDailyPayoutRoster('moderator')).toBe(false);
    expect(canEditDailyPayoutRoster('verified')).toBe(false);
    expect(canEditDailyPayoutRoster('basis')).toBe(false);
  });
});

describe('canSignFondPayouts', () => {
  it('is true only for the configured non-platform account at least at fond rank', () => {
    expect(canSignFondPayouts({ role: 'fond', username: ' Tondo-Fond ' }, 'tondo-fond')).toBe(true);
    expect(canSignFondPayouts({ role: 'fond', username: 'tondo-fond' }, 'tondo-fond')).toBe(true);
    expect(canSignFondPayouts({ role: 'fond', username: 'tondo-fond' }, ' Tondo-Fond ')).toBe(true);
    expect(canSignFondPayouts({ role: 'initiator', username: 'tondo-fond' }, 'tondo-fond')).toBe(
      true,
    );
    expect(canSignFondPayouts({ role: 'founder', username: 'tondo-fond' }, 'tondo-fond')).toBe(
      true,
    );
    expect(canSignFondPayouts({ role: 'fond', username: 'other' }, 'tondo-fond')).toBe(false);
    expect(canSignFondPayouts({ role: 'moderator', username: 'tondo-fond' }, 'tondo-fond')).toBe(
      false,
    );
    expect(
      canSignFondPayouts({ role: 'fond', username: 'tondo-fond', isPlatform: true }, 'tondo-fond'),
    ).toBe(false);
  });

  it('is explicitly false for null, missing, or below-fond accounts', () => {
    expect(canSignFondPayouts({ role: 'fond', username: null }, 'tondo-fond')).toBe(false);
    expect(canSignFondPayouts({ role: 'fond' }, 'tondo-fond')).toBe(false);
    for (const role of roles.slice(0, 3)) {
      expect(canSignFondPayouts({ role, username: 'tondo-fond' }, 'tondo-fond')).toBe(false);
    }
  });
});
