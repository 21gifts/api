import { describe, it, expect } from 'vitest';
import { checkSpendAuth } from '@/lib/spend-auth';

const TOKEN = 'spend-secret-token';

describe('checkSpendAuth', () => {
  it('returns unconfigured when the token env is missing', () => {
    expect(checkSpendAuth(undefined, 'Bearer x')).toBe('unconfigured');
  });

  it('returns unconfigured when the token env is blank', () => {
    expect(checkSpendAuth('  ', 'Bearer x')).toBe('unconfigured');
  });

  it('returns unauthorized when the header is missing', () => {
    expect(checkSpendAuth(TOKEN, undefined)).toBe('unauthorized');
  });

  it('returns unauthorized when the scheme is not Bearer', () => {
    expect(checkSpendAuth(TOKEN, `Basic ${TOKEN}`)).toBe('unauthorized');
  });

  it('returns unauthorized when the presented token has a different length', () => {
    expect(checkSpendAuth(TOKEN, 'Bearer short')).toBe('unauthorized');
  });

  it('returns unauthorized when the presented token differs at equal length', () => {
    expect(checkSpendAuth(TOKEN, 'Bearer spend-secret-tokex')).toBe('unauthorized');
  });

  it('returns ok when the Bearer token matches', () => {
    expect(checkSpendAuth(TOKEN, `Bearer ${TOKEN}`)).toBe('ok');
  });
});
