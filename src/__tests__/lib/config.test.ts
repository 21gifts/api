import { describe, it, expect } from 'vitest';
import {
  expectedOriginsForRpId,
  normalizeWebAuthnRpId,
  resolveAllowedOrigins,
  resolveLnurlServerConfig,
  resolveWebAuthnConfig,
} from '@/lib/config';

describe('resolveAllowedOrigins', () => {
  it('returns the default app surfaces when unset', () => {
    const origins = resolveAllowedOrigins({});
    expect(origins).toContain('https://21.gifts');
    expect(origins).toContain('https://dev.21.gifts');
    expect(origins).toContain('https://staging.21.gifts');
    expect(origins).toContain('https://app.21.gifts');
    expect(origins).toContain('https://dev-app.21.gifts');
    expect(origins).toContain('https://staging-app.21.gifts');
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
    expect(normalizeWebAuthnRpId('staging.21.gifts')).toBe('staging.21.gifts');
  });

  it('rejects an RP ID outside the allowlist', () => {
    expect(normalizeWebAuthnRpId('app.21.gifts')).toBeNull();
    expect(normalizeWebAuthnRpId('example.com')).toBeNull();
  });
});

describe('expectedOriginsForRpId', () => {
  it('keeps the RP ID and app.<rpId> only', () => {
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

  it('does not treat the dev apex as a production RP origin', () => {
    expect(
      expectedOriginsForRpId('21.gifts', [
        'https://21.gifts',
        'https://dev.21.gifts',
        'https://dev-app.21.gifts',
      ]),
    ).toEqual(['https://21.gifts']);
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

describe('resolveLnurlServerConfig', () => {
  it('returns null when LNURL_SERVER_URL is unset or blank', () => {
    expect(resolveLnurlServerConfig({})).toBeNull();
    expect(
      resolveLnurlServerConfig({
        LNURL_SERVER_URL: '   ',
        PUBLIC_BASE_URL: 'https://example.test',
      }),
    ).toBeNull();
  });

  it('returns null when either URL is invalid', () => {
    expect(
      resolveLnurlServerConfig({
        LNURL_SERVER_URL: 'not a url',
        PUBLIC_BASE_URL: 'https://example.test',
      }),
    ).toBeNull();
    expect(
      resolveLnurlServerConfig({
        LNURL_SERVER_URL: 'http://lnurl.test',
        PUBLIC_BASE_URL: 'not a url',
      }),
    ).toBeNull();
  });

  it('returns null when PUBLIC_BASE_URL is missing or blank', () => {
    expect(resolveLnurlServerConfig({ LNURL_SERVER_URL: 'http://lnurl.test' })).toBeNull();
    expect(
      resolveLnurlServerConfig({
        LNURL_SERVER_URL: 'http://lnurl.test',
        PUBLIC_BASE_URL: '   ',
      }),
    ).toBeNull();
  });

  it('returns null when either protocol is not http or https', () => {
    expect(
      resolveLnurlServerConfig({
        LNURL_SERVER_URL: 'ftp://lnurl.test',
        PUBLIC_BASE_URL: 'https://example.test',
      }),
    ).toBeNull();
    expect(
      resolveLnurlServerConfig({
        LNURL_SERVER_URL: 'http://lnurl.test',
        PUBLIC_BASE_URL: 'ftp://example.test',
      }),
    ).toBeNull();
  });

  it('trims and removes one trailing slash from both URLs', () => {
    expect(
      resolveLnurlServerConfig({
        LNURL_SERVER_URL: '  http://lnurl.test/  ',
        PUBLIC_BASE_URL: '  https://example.test/  ',
      }),
    ).toEqual({
      baseUrl: 'http://lnurl.test',
      publicBaseUrl: 'https://example.test',
      host: 'example.test',
    });
  });

  it('includes the port in host when PUBLIC_BASE_URL has one', () => {
    expect(
      resolveLnurlServerConfig({
        LNURL_SERVER_URL: 'http://lnurl.test:9090',
        PUBLIC_BASE_URL: 'https://example.test:8443',
      }),
    ).toEqual({
      baseUrl: 'http://lnurl.test:9090',
      publicBaseUrl: 'https://example.test:8443',
      host: 'example.test:8443',
    });
  });

  it('resolves host without a port', () => {
    expect(
      resolveLnurlServerConfig({
        LNURL_SERVER_URL: 'https://lnurl.test',
        PUBLIC_BASE_URL: 'https://example.test',
      }),
    ).toEqual({
      baseUrl: 'https://lnurl.test',
      publicBaseUrl: 'https://example.test',
      host: 'example.test',
    });
  });
});
