import { describe, expect, it } from 'vitest';
import { ROLE_ORDER, roleAtLeast, roleRank } from '@/lib/auth/roles';
import type { AccountRole } from '@/lib/auth/store';

const roles: readonly AccountRole[] = ['basis', 'verified', 'moderator', 'founder'];

describe('ROLE_ORDER', () => {
  it('lists roles from lowest to highest', () => {
    expect(ROLE_ORDER).toEqual(['basis', 'verified', 'moderator', 'founder']);
  });
});

describe('roleRank', () => {
  it('is the index in ROLE_ORDER for every role', () => {
    expect(roleRank('basis')).toBe(0);
    expect(roleRank('verified')).toBe(1);
    expect(roleRank('moderator')).toBe(2);
    expect(roleRank('founder')).toBe(3);
    expect(roles.map(roleRank)).toEqual([0, 1, 2, 3]);
  });
});

describe('roleAtLeast', () => {
  it('is the 4×4 truth table of rank comparison', () => {
    const table: ReadonlyArray<readonly [AccountRole, AccountRole, boolean]> = [
      ['basis', 'basis', true],
      ['basis', 'verified', false],
      ['basis', 'moderator', false],
      ['basis', 'founder', false],
      ['verified', 'basis', true],
      ['verified', 'verified', true],
      ['verified', 'moderator', false],
      ['verified', 'founder', false],
      ['moderator', 'basis', true],
      ['moderator', 'verified', true],
      ['moderator', 'moderator', true],
      ['moderator', 'founder', false],
      ['founder', 'basis', true],
      ['founder', 'verified', true],
      ['founder', 'moderator', true],
      ['founder', 'founder', true],
    ];
    expect(table).toHaveLength(roles.length * roles.length);
    for (const [role, min, want] of table) {
      expect(roleAtLeast(role, min)).toBe(want);
      expect(roleAtLeast(role, min)).toBe(roleRank(role) >= roleRank(min));
    }
  });
});
