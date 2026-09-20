import { describe, it, expect } from 'vitest';
import { WRONG_ACCOUNT_ERROR, isWrongAccount } from '@/lib/auth/wrong-account';

describe('WRONG_ACCOUNT_ERROR', () => {
  it('is the client-facing 403 copy', () => {
    expect(WRONG_ACCOUNT_ERROR).toBe(
      'You signed in with the wrong account. Please try again with the correct account.',
    );
  });
});

describe('isWrongAccount', () => {
  it('is true only when sessionRefused is set', () => {
    expect(isWrongAccount({ sessionRefused: true })).toBe(true);
    expect(isWrongAccount({ sessionRefused: false })).toBe(false);
    expect(isWrongAccount({})).toBe(false);
  });
});
