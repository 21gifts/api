import { describe, it, expect } from 'vitest';
import { bearerMatchesDebugToken } from '@/lib/debug-token';

const TOKEN = 'op-secret-token';

describe('bearerMatchesDebugToken', () => {
  it('accepts an exact Bearer match', () => {
    expect(bearerMatchesDebugToken(TOKEN, `Bearer ${TOKEN}`)).toBe(true);
  });

  it('rejects a missing header', () => {
    expect(bearerMatchesDebugToken(TOKEN, undefined)).toBe(false);
  });

  it('rejects a non-Bearer scheme', () => {
    expect(bearerMatchesDebugToken(TOKEN, `Basic ${TOKEN}`)).toBe(false);
  });

  it('rejects a different token of the same length', () => {
    expect(bearerMatchesDebugToken(TOKEN, 'Bearer op-secret-tokem')).toBe(false);
  });

  it('rejects a different length token', () => {
    expect(bearerMatchesDebugToken(TOKEN, 'Bearer short')).toBe(false);
  });

  it('trims the presented token', () => {
    expect(bearerMatchesDebugToken(TOKEN, `Bearer ${TOKEN}  `)).toBe(true);
  });
});
