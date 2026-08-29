import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, resolveBindAddr, parseBindAddr } from '@/server';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

describe('createApp', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('accepts an injected Nostr KEK', async () => {
    const app = createApp({ nostrKek: new Uint8Array(32).fill(4) });
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
  });

  it('mounts /favicon.ico', async () => {
    const app = createApp();
    const res = await app.request('/favicon.ico');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/image/);
  });

  it('returns 404 for /favicon.ico when readBrand yields null', async () => {
    const app = createApp({ readBrand: async () => null });
    const res = await app.request('/favicon.ico');
    expect(res.status).toBe(404);
  });

  it('serves injected brand bytes for /favicon.ico', async () => {
    const app = createApp({ readBrand: async () => new Uint8Array([1, 2, 3]) });
    const res = await app.request('/favicon.ico');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/image\/x-icon/);
    expect((await res.arrayBuffer()).byteLength).toBe(3);
  });

  it('mounts /healthz', async () => {
    const app = createApp();
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
  });

  it('does not emit http.request for GET /healthz', async () => {
    await createApp().request('/healthz');
    expect(parsedEvents(warn).some((e) => e['event'] === 'http.request')).toBe(false);
  });

  it('mounts /info', async () => {
    const app = createApp();
    const res = await app.request('/info');
    expect(res.status).toBe(200);
  });

  it('returns 503 on /debug/accounts when debugToken is blank', async () => {
    const app = createApp({ debugToken: '' });
    const res = await app.request('/debug/accounts');
    expect(res.status).toBe(503);
  });

  it('emits http.request for GET /info', async () => {
    await createApp().request('/info');
    const httpEvents = parsedEvents(warn).filter((e) => e['event'] === 'http.request');
    expect(httpEvents).toHaveLength(1);
    expect(httpEvents[0]?.['method']).toBe('GET');
    expect(httpEvents[0]?.['path']).toBe('/info');
    expect(httpEvents[0]?.['status']).toBe(200);
    expect(Number.isInteger(httpEvents[0]?.['ms'])).toBe(true);
    const raw = warn.mock.calls
      .map((call) => call[0])
      .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))[0];
    expect(raw).toBeDefined();
    expect(raw).not.toContain('?');
  });

  it('mounts /lightning-address', async () => {
    const app = createApp();
    const res = await app.request('/lightning-address');
    expect(res.status).toBe(400);
  });

  it('mounts /gifts/stats with BTC, USD, and fx on empty stats', async () => {
    const res = await createApp().request('/gifts/stats');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      totalSats: 0,
      totalBtc: '0.00000000',
      totalUsd: '0.00',
      giftCount: 0,
      recipientCount: 0,
      firstPaidAt: null,
      lastPaidAt: null,
      spendOverTime: [],
      byRecipient: [],
      byMonth: [],
      fx: {
        quote: 'BTC-USD',
        dayBasis: 'utc',
        source: 'coinbase-exchange-daily-close',
      },
    });
  });

  it('returns 404 for unknown routes', async () => {
    const app = createApp();
    const res = await app.request('/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('returns 401 for unauthenticated GET /messages', async () => {
    const app = createApp();
    const res = await app.request('/messages');
    expect(res.status).toBe(401);
  });
});

describe('CORS', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('reflects an allowed origin', async () => {
    const res = await createApp().request('/healthz', {
      headers: { origin: 'https://app.21.gifts' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.21.gifts');
  });

  it('reflects the public apex origin', async () => {
    const res = await createApp().request('/healthz', {
      headers: { origin: 'https://21.gifts' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://21.gifts');
  });

  it('does not echo an unknown origin', async () => {
    const res = await createApp().request('/healthz', { headers: { origin: 'https://evil.test' } });
    expect(res.headers.get('access-control-allow-origin')).not.toBe('https://evil.test');
  });

  it('answers the CORS preflight with the allowed headers', async () => {
    const res = await createApp().request('/auth/passkey/register/begin', {
      method: 'OPTIONS',
      headers: { origin: 'https://app.21.gifts', 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toMatch(/authorization/i);
    expect(parsedEvents(warn).some((e) => e['event'] === 'http.request')).toBe(false);
  });

  it('allows DELETE on the lightning-address preflight', async () => {
    const res = await createApp().request('/me/lightning-address', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.21.gifts',
        'access-control-request-method': 'DELETE',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toMatch(/DELETE/i);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.21.gifts');
    expect(parsedEvents(warn).some((e) => e['event'] === 'http.request')).toBe(false);
  });

  it('honors an injected allowedOrigins override', async () => {
    const res = await createApp({ allowedOrigins: ['https://custom.test'] }).request('/healthz', {
      headers: { origin: 'https://custom.test' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://custom.test');
  });
});

describe('resolveBindAddr', () => {
  it('prefers the explicit override', () => {
    expect(resolveBindAddr('127.0.0.1:9000', { BIND_ADDR: '0.0.0.0:1234' })).toBe('127.0.0.1:9000');
  });

  it('falls back to the env var when override is undefined', () => {
    expect(resolveBindAddr(undefined, { BIND_ADDR: '0.0.0.0:1234' })).toBe('0.0.0.0:1234');
  });

  it('falls back to the hard default when both are absent', () => {
    expect(resolveBindAddr(undefined, {})).toBe('0.0.0.0:3000');
  });

  it('treats an undefined env BIND_ADDR like an absent one', () => {
    expect(resolveBindAddr(undefined, { BIND_ADDR: undefined })).toBe('0.0.0.0:3000');
  });
});

describe('parseBindAddr', () => {
  it('parses a standard host:port', () => {
    expect(parseBindAddr('0.0.0.0:3000')).toEqual({ host: '0.0.0.0', port: 3000 });
  });

  it('parses localhost', () => {
    expect(parseBindAddr('127.0.0.1:8080')).toEqual({ host: '127.0.0.1', port: 8080 });
  });

  it('parses port 0 (ephemeral)', () => {
    expect(parseBindAddr('0.0.0.0:0')).toEqual({ host: '0.0.0.0', port: 0 });
  });

  it('parses the maximum legal port', () => {
    expect(parseBindAddr('0.0.0.0:65535')).toEqual({ host: '0.0.0.0', port: 65535 });
  });

  it('rejects missing port', () => {
    expect(() => parseBindAddr('0.0.0.0')).toThrowError(/expected "host:port"/);
  });

  it('rejects empty port after colon', () => {
    expect(() => parseBindAddr('0.0.0.0:')).toThrowError(/expected "host:port"/);
  });

  it('rejects missing host', () => {
    expect(() => parseBindAddr(':3000')).toThrowError(/expected "host:port"/);
  });

  it('rejects non-numeric port', () => {
    expect(() => parseBindAddr('0.0.0.0:abc')).toThrowError(/must be 0\.\.65535/);
  });

  it('rejects port > 65535', () => {
    expect(() => parseBindAddr('0.0.0.0:65536')).toThrowError(/must be 0\.\.65535/);
  });

  it('rejects negative port', () => {
    expect(() => parseBindAddr('0.0.0.0:-1')).toThrowError(/must be 0\.\.65535/);
  });

  it('rejects port with trailing junk', () => {
    expect(() => parseBindAddr('0.0.0.0:3000x')).toThrowError(/must be 0\.\.65535/);
  });
});
