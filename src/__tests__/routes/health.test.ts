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
    const app = createApp({ env: {}, webAuthnRpId: '' });
    const body = (await (await app.request('/healthz')).json()) as HealthResponse;
    expect(body.status).toBe('ok');
    expect(body.wallet).toEqual(ALL_OFF);
  });

  it('reports every wallet feature on when all are configured', async () => {
    const app = createApp({ env: WALLET_ENV, webAuthnRpId: 'localhost' });
    const body = (await (await app.request('/healthz')).json()) as HealthResponse;
    expect(body.wallet).toEqual({
      lnurlServer: true,
      zapSigning: true,
      freePayments: true,
      passkey: true,
    });
  });

  it('never echoes a configured value, key, or URL', async () => {
    const app = createApp({ env: WALLET_ENV, webAuthnRpId: 'localhost' });
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
      ),
    ).toEqual({ ...ALL_OFF, lnurlServer: true });
  });

  it('turns zapSigning on without the LNURL server, so free payments stay off', () => {
    expect(walletFeatures({ LNURL_ZAP_NSEC_HEX: ZAP_NSEC_HEX }, undefined)).toEqual({
      ...ALL_OFF,
      zapSigning: true,
    });
  });

  it('keeps zapSigning off for a malformed secret or a non-http operator URL', () => {
    expect(walletFeatures({ LNURL_ZAP_NSEC_HEX: 'not-hex' }, undefined).zapSigning).toBe(false);
    expect(
      walletFeatures(
        { LNURL_ZAP_NSEC_HEX: ZAP_NSEC_HEX, SPARK_OPERATOR_URL: 'ftp://operator.test' },
        undefined,
      ).zapSigning,
    ).toBe(false);
  });

  it('reports passkey only for a known RP ID', () => {
    expect(walletFeatures({}, 'localhost').passkey).toBe(true);
    expect(walletFeatures({}, 'unknown.test').passkey).toBe(false);
  });
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
