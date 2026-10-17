import { describe, it, expect } from 'vitest';
import { InMemoryTranslationStore } from '@/lib/translation-store';
import { createApp } from '@/server';
import { healthRoute, walletFeatures } from '@/routes/health';
import type { HealthResponse, WalletFeatures } from '@/routes/health';

const ZAP_NSEC_HEX = 'ab'.repeat(32);

const WALLET_ENV = {
  LNURL_SERVER_URL: 'http://lnurl.test',
  PUBLIC_BASE_URL: 'https://example.test',
  LNURL_ZAP_NSEC_HEX: ZAP_NSEC_HEX,
  SPARK_OPERATOR_URL: 'https://operator.test',
};

const LOCAL_ORIGINS = ['http://localhost:3000'];

const ALL_OFF: WalletFeatures = {
  lnurlServer: false,
  zapSigning: false,
  freePayments: false,
  passkey: false,
};

describe('GET /healthz', () => {
  it('returns 200 with status ok', async () => {
    const app = createApp();
    const res = await app.request('/healthz');

    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(body.status).toBe('ok');
    expect(body.service).toBe('21gifts-api');
    expect(typeof body.version).toBe('string');
  });

  it('answers health when a conversation translation store is passed', async () => {
    const app = createApp({ conversationTranslationStore: new InMemoryTranslationStore() });
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
  });

  it('returns JSON content-type', async () => {
    const app = createApp();
    const res = await app.request('/healthz');
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });

  it('reports every wallet feature off when none is configured', async () => {
    const app = createApp({ env: {}, webAuthnRpId: '', allowedOrigins: LOCAL_ORIGINS });
    const body = (await (await app.request('/healthz')).json()) as HealthResponse;
    expect(body.status).toBe('ok');
    expect(body.wallet).toEqual(ALL_OFF);
  });

  it('reports every wallet feature on when all are configured', async () => {
    const app = createApp({
      env: WALLET_ENV,
      webAuthnRpId: 'localhost',
      allowedOrigins: LOCAL_ORIGINS,
    });
    const body = (await (await app.request('/healthz')).json()) as HealthResponse;
    expect(body.wallet).toEqual({
      lnurlServer: true,
      zapSigning: true,
      freePayments: true,
      passkey: true,
    });
  });

  it('never echoes a configured value, key, or URL', async () => {
    const app = createApp({
      env: WALLET_ENV,
      webAuthnRpId: 'localhost',
      allowedOrigins: LOCAL_ORIGINS,
    });
    const text = await (await app.request('/healthz')).text();
    for (const value of [...Object.values(WALLET_ENV), 'lnurl.test', 'example.test']) {
      expect(text).not.toContain(value);
    }
    const body = JSON.parse(text) as HealthResponse;
    for (const flag of Object.values(body.wallet)) {
      expect(typeof flag).toBe('boolean');
    }
  });
});

describe('walletFeatures', () => {
  it('turns lnurlServer on without zap signing', () => {
    expect(
      walletFeatures(
        { LNURL_SERVER_URL: 'http://lnurl.test', PUBLIC_BASE_URL: 'https://example.test' },
        undefined,
        LOCAL_ORIGINS,
      ),
    ).toEqual({ ...ALL_OFF, lnurlServer: true });
  });

  it('turns zapSigning on without the LNURL server, so free payments stay off', () => {
    expect(walletFeatures({ LNURL_ZAP_NSEC_HEX: ZAP_NSEC_HEX }, undefined, LOCAL_ORIGINS)).toEqual({
      ...ALL_OFF,
      zapSigning: true,
    });
  });

  it('keeps zapSigning off for a malformed secret or a non-http operator URL', () => {
    expect(
      walletFeatures({ LNURL_ZAP_NSEC_HEX: 'not-hex' }, undefined, LOCAL_ORIGINS).zapSigning,
    ).toBe(false);
    expect(
      walletFeatures(
        { LNURL_ZAP_NSEC_HEX: ZAP_NSEC_HEX, SPARK_OPERATOR_URL: 'ftp://operator.test' },
        undefined,
        LOCAL_ORIGINS,
      ).zapSigning,
    ).toBe(false);
  });

  it('reports passkey only for a known RP ID', () => {
    expect(walletFeatures({}, 'localhost', LOCAL_ORIGINS).passkey).toBe(true);
    expect(walletFeatures({}, 'unknown.test', LOCAL_ORIGINS).passkey).toBe(false);
  });

  it('keeps passkey off for a known RP ID that no allowed origin matches', () => {
    expect(walletFeatures({}, '21.gifts', LOCAL_ORIGINS).passkey).toBe(false);
    expect(walletFeatures({}, '21.gifts', ['https://21.gifts']).passkey).toBe(true);
  });
});

describe('passkey flag and passkey routes', () => {
  const cases: { webAuthnRpId: string; allowedOrigins: string[] }[] = [
    { webAuthnRpId: 'localhost', allowedOrigins: LOCAL_ORIGINS },
    { webAuthnRpId: '21.gifts', allowedOrigins: LOCAL_ORIGINS },
    { webAuthnRpId: '', allowedOrigins: LOCAL_ORIGINS },
  ];
  for (const deps of cases) {
    it(`agree for RP ID '${deps.webAuthnRpId}' with ${deps.allowedOrigins.join(',')}`, async () => {
      const app = createApp({ env: {}, ...deps });
      const health = (await (await app.request('/healthz')).json()) as HealthResponse;
      const begin = await app.request('/auth/passkey/authenticate/begin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: deps.allowedOrigins[0] ?? '' },
        body: '{}',
      });
      expect(health.wallet.passkey).toBe(begin.status !== 500);
    });
  }
});

describe('healthRoute', () => {
  it('serves the flags it was built with, as a copy', async () => {
    const wallet: WalletFeatures = { ...ALL_OFF, passkey: true };
    const route = healthRoute(wallet);
    wallet.passkey = false;
    const body = (await (await route.request('/')).json()) as HealthResponse;
    expect(body.wallet).toEqual({ ...ALL_OFF, passkey: true });
  });
});
