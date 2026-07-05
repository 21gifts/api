import { describe, it, expect } from 'vitest';
import { normalizePublicBaseUrl, resolveAllowedOrigins } from '@/lib/config';

describe('normalizePublicBaseUrl', () => {
  it('returns null when unset', () => {
    expect(normalizePublicBaseUrl(undefined)).toBeNull();
  });

  it('returns null when blank', () => {
    expect(normalizePublicBaseUrl('   ')).toBeNull();
  });

  it('strips a trailing slash', () => {
    expect(normalizePublicBaseUrl('https://dev-api.21.gifts/')).toBe('https://dev-api.21.gifts');
  });

  it('strips multiple trailing slashes', () => {
    expect(normalizePublicBaseUrl('https://api.21.gifts///')).toBe('https://api.21.gifts');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizePublicBaseUrl('  https://api.21.gifts  ')).toBe('https://api.21.gifts');
  });

  it('passes a clean url through unchanged', () => {
    expect(normalizePublicBaseUrl('https://api.21.gifts')).toBe('https://api.21.gifts');
  });
});

describe('resolveAllowedOrigins', () => {
  it('returns the default app surfaces when unset', () => {
    const origins = resolveAllowedOrigins({});
    expect(origins).toContain('https://app.21.gifts');
    expect(origins).toContain('https://dev-app.21.gifts');
  });

  it('returns the defaults when blank', () => {
    expect(resolveAllowedOrigins({ CORS_ALLOWED_ORIGINS: '   ' })).toContain(
      'https://app.21.gifts',
    );
  });

  it('parses a comma-separated override', () => {
    expect(
      resolveAllowedOrigins({ CORS_ALLOWED_ORIGINS: 'https://a.test, https://b.test' }),
    ).toEqual(['https://a.test', 'https://b.test']);
  });

  it('drops empty entries from the override', () => {
    expect(
      resolveAllowedOrigins({ CORS_ALLOWED_ORIGINS: 'https://a.test,,  ,https://b.test' }),
    ).toEqual(['https://a.test', 'https://b.test']);
  });
});
