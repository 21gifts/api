import { describe, expect, it } from 'vitest';
import {
  WRONG_ACCOUNT_ERROR,
  WRONG_ACCOUNT_IDS,
  isWrongAccount,
} from '@/lib/auth/wrong-account';

const LISTED_ID = '7191f7a8-2cf1-4d67-a46e-f33e79996c0a';

describe('WRONG_ACCOUNT_ERROR', () => {
  it('is the client-facing copy', () => {
    expect(WRONG_ACCOUNT_ERROR).toBe(
      'You signed in with the wrong account. Please try again with the correct account.',
    );
  });
});

describe('WRONG_ACCOUNT_IDS', () => {
  it('lists the duplicate account id', () => {
    expect(WRONG_ACCOUNT_IDS.has(LISTED_ID)).toBe(true);
    expect(WRONG_ACCOUNT_IDS.size).toBe(1);
  });
});

describe('isWrongAccount', () => {
  it('is true only for listed ids', () => {
    expect(isWrongAccount(LISTED_ID)).toBe(true);
    expect(isWrongAccount('acc')).toBe(false);
    expect(isWrongAccount('')).toBe(false);
  });
});
