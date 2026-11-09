import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SPARK_OPERATOR_URL,
  expectedOriginsForRpId,
  normalizeWebAuthnRpId,
  resolveAllowedOrigins,
  resolveFreePaymentsConfig,
  resolveLnurlServerConfig,
  resolveShopPaymentConfig,
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

describe('resolveFreePaymentsConfig', () => {
  const NSEC = '11'.repeat(32);

  it('is off when the nsec is unset, blank, short, or not hex', () => {
    expect(resolveFreePaymentsConfig({})).toBeNull();
    expect(resolveFreePaymentsConfig({ LNURL_ZAP_NSEC_HEX: '  ' })).toBeNull();
    expect(resolveFreePaymentsConfig({ LNURL_ZAP_NSEC_HEX: '11'.repeat(31) })).toBeNull();
    expect(resolveFreePaymentsConfig({ LNURL_ZAP_NSEC_HEX: 'zz'.repeat(32) })).toBeNull();
  });

  it('accepts upper-case hex and uses the default operator URL when unset or blank', () => {
    const config = resolveFreePaymentsConfig({ LNURL_ZAP_NSEC_HEX: ` ${'AB'.repeat(32)} ` });
    expect(config?.zapNsec).toEqual(new Uint8Array(32).fill(0xab));
    expect(config?.operatorUrl).toBe(DEFAULT_SPARK_OPERATOR_URL);
    expect(
      resolveFreePaymentsConfig({ LNURL_ZAP_NSEC_HEX: NSEC, SPARK_OPERATOR_URL: ' ' })?.operatorUrl,
    ).toBe('https://0.spark.lightspark.com');
  });

  it('trims a custom operator URL and its trailing slash', () => {
    expect(
      resolveFreePaymentsConfig({
        LNURL_ZAP_NSEC_HEX: NSEC,
        SPARK_OPERATOR_URL: ' http://operator.test:8080/ ',
      })?.operatorUrl,
    ).toBe('http://operator.test:8080');
  });

  it('is off when the operator URL is not http(s) or does not parse', () => {
    expect(
      resolveFreePaymentsConfig({ LNURL_ZAP_NSEC_HEX: NSEC, SPARK_OPERATOR_URL: 'ftp://op.test' }),
    ).toBeNull();
    expect(
      resolveFreePaymentsConfig({ LNURL_ZAP_NSEC_HEX: NSEC, SPARK_OPERATOR_URL: 'not a url' }),
    ).toBeNull();
  });
});

describe('resolveShopPaymentConfig', () => {
  const REFUND = `0x${'Ab'.repeat(20)}`;
  const VALID = {
    ORCHESTRA_BASE_URL: 'https://orchestra.example/',
    ORCHESTRA_API_KEY: ' fn_server ',
    SHOP_EVM_RPC: JSON.stringify({
      '1': ' https://eth.rpc.example/key ',
      '137': 'https://pol.example',
    }),
    SHOP_REFUND_ADDRESS: ` ${REFUND} `,
  };

  function withEnv(over: Record<string, string | undefined>) {
    return resolveShopPaymentConfig({ ...VALID, ...over });
  }

  it('resolves all four values, trimmed, with the origin and a lowercase refund address', () => {
    const config = resolveShopPaymentConfig(VALID);
    expect(config).toEqual({
      orchestraBaseUrl: 'https://orchestra.example',
      orchestraApiKey: 'fn_server',
      evmRpc: new Map([
        [1, 'https://eth.rpc.example/key'],
        [137, 'https://pol.example'],
      ]),
      refundAddress: REFUND.toLowerCase(),
    });
  });

  it('is off when ORCHESTRA_BASE_URL is missing or not an https origin', () => {
    for (const value of [
      undefined,
      '',
      'not a url',
      'ftp://orchestra.example',
      'http://orchestra.example',
      'https://user:pw@orchestra.example',
      'https://user@orchestra.example',
      'https://:pw@orchestra.example',
      'https://orchestra.example/v1',
      'https://orchestra.example?x=1',
      'https://orchestra.example#frag',
    ]) {
      expect(withEnv({ ORCHESTRA_BASE_URL: value })).toBeNull();
    }
  });

  it('is off without a server key (fn_…); a client key fnp_… is refused', () => {
    for (const value of [undefined, '', '   ', 'fn_', ' fn_ ', 'fnp_client', 'sk_live']) {
      expect(withEnv({ ORCHESTRA_API_KEY: value })).toBeNull();
    }
  });

  it('is off when SHOP_EVM_RPC is missing, blank, or not a chain-id-to-https object', () => {
    for (const value of [
      undefined,
      '',
      '  ',
      '{not json',
      'null',
      '[]',
      '42',
      '"https://x.example"',
      '{}',
      JSON.stringify({ '01': 'https://x.example' }),
      JSON.stringify({ '0': 'https://x.example' }),
      JSON.stringify({ '-1': 'https://x.example' }),
      JSON.stringify({ '1.5': 'https://x.example' }),
      JSON.stringify({ eth: 'https://x.example' }),
      JSON.stringify({ '99999999999999999999': 'https://x.example' }),
      JSON.stringify({ '1': 42 }),
      JSON.stringify({ '1': 'http://x.example' }),
      JSON.stringify({ '1': 'https://user:pw@x.example' }),
      JSON.stringify({ '1': 'not a url' }),
      JSON.stringify({ '1': 'https://x.example', '137': 'http://y.example' }),
    ]) {
      expect(withEnv({ SHOP_EVM_RPC: value })).toBeNull();
    }
  });

  it('is off without a 0x + 40 hex refund address', () => {
    for (const value of [
      undefined,
      '',
      `0x${'a'.repeat(39)}`,
      `0x${'a'.repeat(41)}`,
      `${'a'.repeat(42)}`,
      `0x${'g'.repeat(40)}`,
    ]) {
      expect(withEnv({ SHOP_REFUND_ADDRESS: value })).toBeNull();
    }
  });
});
