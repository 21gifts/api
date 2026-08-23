import { describe, it, expect } from 'vitest';
import {
  expectedOriginsForRpId,
  normalizePublicBaseUrl,
  normalizeWebAuthnRpId,
  resolveAllowedOrigins,
  resolveWebAuthnConfig,
} from '@/lib/config';

describe('normalizePublicBaseUrl', () => {
  it('returns null when unset', () => {
    expect(normalizePublicBaseUrl(undefined)).toBeNull();
  });

  it('returns null when blank', () => {
    expect(normalizePublicBaseUrl('   ')).toBeNull();
  });

  it('strips a trailing slash', () => {
    expect(normalizePublicBaseUrl('https://dev.21.gifts/')).toBe('https://dev.21.gifts');
  });

  it('strips multiple trailing slashes', () => {
    expect(normalizePublicBaseUrl('https://21.gifts///')).toBe('https://21.gifts');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizePublicBaseUrl('  https://21.gifts  ')).toBe('https://21.gifts');
  });

  it('passes a clean url through unchanged', () => {
    expect(normalizePublicBaseUrl('https://21.gifts')).toBe('https://21.gifts');
  });
});

describe('resolveAllowedOrigins', () => {
  it('returns the default app surfaces when unset', () => {
    const origins = resolveAllowedOrigins({});
    expect(origins).toContain('https://21.gifts');
    expect(origins).toContain('https://dev.21.gifts');
    expect(origins).toContain('https://app.21.gifts');
    expect(origins).toContain('https://dev-app.21.gifts');
    expect(origins).toContain('http://localhost:3000');
  });

  it('returns the defaults when blank', () => {
    expect(resolveAllowedOrigins({ CORS_ALLOWED_ORIGINS: '   ' })).toContain('https://21.gifts');
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

describe('normalizeWebAuthnRpId', () => {
  it('returns null when unset or blank', () => {
    expect(normalizeWebAuthnRpId(undefined)).toBeNull();
    expect(normalizeWebAuthnRpId('  ')).toBeNull();
  });

  it('trims a configured RP ID', () => {
    expect(normalizeWebAuthnRpId('  21.gifts  ')).toBe('21.gifts');
  });
});

describe('expectedOriginsForRpId', () => {
  it('keeps the apex and its subdomains', () => {
    expect(
      expectedOriginsForRpId('21.gifts', [
        'https://21.gifts',
        'https://app.21.gifts',
        'http://localhost:3000',
        'not a url',
      ]),
    ).toEqual(['https://21.gifts', 'https://app.21.gifts']);
  });

  it('does not treat localhost as the production RP ID', () => {
    expect(expectedOriginsForRpId('21.gifts', ['http://localhost:3000'])).toEqual([]);
  });
});

describe('resolveWebAuthnConfig', () => {
  it('returns null when the RP ID is missing', () => {
    expect(resolveWebAuthnConfig({}, ['https://21.gifts'])).toBeNull();
  });

  it('returns null when no origin matches the RP ID', () => {
    expect(
      resolveWebAuthnConfig({ WEBAUTHN_RP_ID: '21.gifts' }, ['http://localhost:3000']),
    ).toBeNull();
  });

  it('defaults the RP name and filters origins', () => {
    expect(
      resolveWebAuthnConfig({ WEBAUTHN_RP_ID: '21.gifts' }, [
        'https://21.gifts',
        'http://localhost:3000',
      ]),
    ).toEqual({
      rpId: '21.gifts',
      rpName: '21.gifts',
      expectedOrigins: ['https://21.gifts'],
    });
  });

  it('uses WEBAUTHN_RP_NAME when set', () => {
    const config = resolveWebAuthnConfig(
      { WEBAUTHN_RP_ID: 'localhost', WEBAUTHN_RP_NAME: ' Local ' },
      ['http://localhost:3000'],
    );
    expect(config?.rpName).toBe('Local');
  });

  it('treats a blank RP name as the default', () => {
    const config = resolveWebAuthnConfig({ WEBAUTHN_RP_ID: 'localhost', WEBAUTHN_RP_NAME: '  ' }, [
      'http://localhost:3000',
    ]);
    expect(config?.rpName).toBe('21.gifts');
  });
});
