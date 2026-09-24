import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryMessageStore, PostgresMessageStore } from '@/lib/message-store';
import { RecordingPublisher } from '@/lib/nostr/publish';
import { PostRateLimiter } from '@/lib/nostr/rate-limit';
import { createApp, resolveBindAddr, parseBindAddr } from '@/server';

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
}

const VAPID_PUBLIC_BYTES = new Uint8Array(65);
VAPID_PUBLIC_BYTES[0] = 4;
const VAPID_PUBLIC_KEY = b64url(VAPID_PUBLIC_BYTES);
const VAPID_PRIVATE_KEY = b64url(new Uint8Array(32).fill(1));

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

  it('accepts an injected spendPing', async () => {
    const app = createApp({ spendPing: { ping: async () => undefined } });
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
  });

  it('accepts an injected postLimiter', async () => {
    const app = createApp({ postLimiter: new PostRateLimiter() });
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
  });

  it('accepts an injected Nostr publisher', async () => {
    const app = createApp({ nostrPublisher: new RecordingPublisher() });
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

  it('dumps rate tables on GET /debug/dump', async () => {
    const app = createApp({
      debugToken: 'secret',
      listDbChange: async () => [{ id: 1 }],
      btcUsdRates: { ensureDays: async () => new Map() },
    });
    const res = await app.request('/debug/dump', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tables: Record<string, unknown[]> };
    expect(Array.isArray(body.tables['btc_usd_daily'])).toBe(true);
    expect(body.tables['db_change']).toEqual([{ id: 1 }]);
  });

  it('reads VAPID public key from the environment when createApp omits it', async () => {
    process.env['VAPID_PUBLIC_KEY'] = VAPID_PUBLIC_KEY;
    process.env['VAPID_PRIVATE_KEY'] = VAPID_PRIVATE_KEY;
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: `02${'a'.repeat(64)}`,
      role: 'basis',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1_000_000,
      rulesAgreedAt: null,
    });
    await store.createSession({ token: 'tok', accountId: 'acc', createdAt: Date.now() });
    const app = createApp({ authStore: store });
    const res = await app.request('/push/vapid-public', {
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ publicKey: VAPID_PUBLIC_KEY });
    delete process.env['VAPID_PUBLIC_KEY'];
    delete process.env['VAPID_PRIVATE_KEY'];
  });

  it('returns 401 on GET /push/vapid-public without a session', async () => {
    delete process.env['VAPID_PUBLIC_KEY'];
    delete process.env['VAPID_PRIVATE_KEY'];
    const app = createApp();
    const res = await app.request('/push/vapid-public');
    expect(res.status).toBe(401);
  });

  it('returns 503 on POST /debug/push-ping when debugToken is blank', async () => {
    const app = createApp({ debugToken: '' });
    const res = await app.request('/debug/push-ping', { method: 'POST' });
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

  it('returns 404 for GET /view/not-a-key', async () => {
    const res = await createApp().request('/view/not-a-key');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 for GET /view/<64-hex> when unknown', async () => {
    const res = await createApp().request('/view/' + 'a'.repeat(64));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('emits http.request for GET /view/<64-hex> with redacted path', async () => {
    const key = 'a'.repeat(64);
    await createApp().request('/view/' + key);
    const httpEvents = parsedEvents(warn).filter((e) => e['event'] === 'http.request');
    expect(httpEvents).toHaveLength(1);
    expect(httpEvents[0]?.['path']).toBe('/view/:viewKey');
    const raw = warn.mock.calls
      .map((call) => call[0])
      .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))[0];
    expect(raw).toBeDefined();
    expect(raw).not.toContain(key);
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
      totalChf: '0.00',
      totalEur: '0.00',
      totalPhp: '0.00',
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
        quotes: [{ code: 'USD', pair: 'BTC-USD', source: 'coinbase-exchange-daily-close' }],
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

  it('omits profile notes from GET /messages after binding useProfileNoteIds', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount({
      id: 'acc-null',
      linkingKey: `02${'a'.repeat(64)}`,
      role: 'basis',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1_000_000,
      rulesAgreedAt: 1_000_001,
      profileMessageId: null,
    });
    await authStore.createAccount({
      id: 'acc-spaces',
      linkingKey: `02${'b'.repeat(64)}`,
      role: 'basis',
      name: 'Bea',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1_000_002,
      rulesAgreedAt: 1_000_003,
      profileMessageId: '   ',
    });
    await authStore.createAccount({
      id: 'acc-missing',
      linkingKey: `02${'d'.repeat(64)}`,
      role: 'basis',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'd'.repeat(64),
      createdAt: 1_000_004,
      rulesAgreedAt: 1_000_005,
      profileMessageId: 'missing-note',
    });
    await authStore.createAccount({
      id: 'acc-hidden',
      linkingKey: `02${'e'.repeat(64)}`,
      role: 'basis',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'e'.repeat(64),
      createdAt: 1_000_006,
      rulesAgreedAt: 1_000_007,
      profileMessageId: 'hidden-name-copy',
    });
    await authStore.createAccount({
      id: 'acc-photo',
      linkingKey: `02${'f'.repeat(64)}`,
      role: 'basis',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'f'.repeat(64),
      createdAt: 1_000_008,
      rulesAgreedAt: 1_000_009,
      profileMessageId: 'photo-name-copy',
    });
    await authStore.createAccount({
      id: 'acc-video',
      linkingKey: `02${'0'.repeat(64)}`,
      role: 'basis',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: '0'.repeat(64),
      createdAt: 1_000_010,
      rulesAgreedAt: 1_000_011,
      profileMessageId: 'video-name-copy',
    });
    await authStore.createAccount({
      id: 'acc-empty',
      linkingKey: `02${'1'.repeat(64)}`,
      role: 'basis',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: '1'.repeat(64),
      createdAt: 1_000_012,
      rulesAgreedAt: 1_000_013,
      profileMessageId: 'empty-about',
    });
    await authStore.createAccount({
      id: 'acc-about',
      linkingKey: `02${'2'.repeat(64)}`,
      role: 'basis',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: '2'.repeat(64),
      createdAt: 1_000_014,
      rulesAgreedAt: 1_000_015,
      profileMessageId: 'about-note',
    });
    await authStore.createAccount({
      id: 'acc-noname',
      linkingKey: `02${'3'.repeat(64)}`,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: '3'.repeat(64),
      createdAt: 1_000_016,
      rulesAgreedAt: 1_000_017,
      profileMessageId: 'noname-about',
    });
    await authStore.createAccount({
      id: 'acc-profile',
      linkingKey: `02${'c'.repeat(64)}`,
      role: 'basis',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'c'.repeat(64),
      createdAt: 1_000_018,
      rulesAgreedAt: 1_000_019,
      profileMessageId: 'profile-note',
    });
    await authStore.createSession({
      token: 'tok',
      accountId: 'acc-profile',
      createdAt: Date.now(),
    });
    const messageStore = new InMemoryMessageStore([
      {
        id: 'real-post',
        accountId: 'acc-profile',
        name: 'Ada',
        text: 'Ada',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        ...unsignedNostrDefaults(),
        hasPhoto: false,
        hasVideo: false,
        deletedAt: null,
      },
      {
        id: 'profile-note',
        accountId: 'acc-profile',
        name: 'Ada',
        text: 'Ada',
        createdAt: new Date('2026-08-02T00:00:00.000Z'),
        ...unsignedNostrDefaults(),
        hasPhoto: false,
        hasVideo: false,
        deletedAt: null,
      },
      {
        id: 'hidden-name-copy',
        accountId: 'acc-hidden',
        name: 'Ada',
        text: 'Ada',
        createdAt: new Date('2026-08-03T00:00:00.000Z'),
        ...unsignedNostrDefaults(),
        hasPhoto: false,
        hasVideo: false,
        deletedAt: new Date('2026-08-04T00:00:00.000Z'),
        deletedBy: null,
      },
      {
        id: 'photo-name-copy',
        accountId: 'acc-photo',
        name: 'Ada',
        text: 'Ada',
        createdAt: new Date('2026-08-05T00:00:00.000Z'),
        ...unsignedNostrDefaults(),
        hasPhoto: true,
        hasVideo: false,
        deletedAt: null,
      },
      {
        id: 'video-name-copy',
        accountId: 'acc-video',
        name: 'Ada',
        text: 'Ada',
        createdAt: new Date('2026-08-06T00:00:00.000Z'),
        ...unsignedNostrDefaults(),
        hasPhoto: false,
        hasVideo: true,
        deletedAt: null,
      },
      {
        id: 'empty-about',
        accountId: 'acc-empty',
        name: 'Ada',
        text: '',
        createdAt: new Date('2026-08-07T00:00:00.000Z'),
        ...unsignedNostrDefaults(),
        hasPhoto: false,
        hasVideo: false,
        deletedAt: null,
      },
      {
        id: 'about-note',
        accountId: 'acc-about',
        name: 'Ada',
        text: 'Good afternoon everyone',
        createdAt: new Date('2026-08-08T00:00:00.000Z'),
        ...unsignedNostrDefaults(),
        hasPhoto: false,
        hasVideo: false,
        deletedAt: null,
      },
      {
        id: 'noname-about',
        accountId: 'acc-noname',
        name: 'Ada',
        text: 'Good afternoon everyone',
        createdAt: new Date('2026-08-09T00:00:00.000Z'),
        ...unsignedNostrDefaults(),
        hasPhoto: false,
        hasVideo: false,
        deletedAt: null,
      },
    ]);
    const app = createApp({ authStore, messageStore });
    const res = await app.request('/messages', {
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ id: string }> };
    const ids = body.messages.map((row) => row.id);
    expect([...ids].sort()).toEqual(
      [
        'about-note',
        'empty-about',
        'noname-about',
        'photo-name-copy',
        'real-post',
        'video-name-copy',
      ].sort(),
    );
    expect(ids).not.toContain('profile-note');
  });

  it('leaves a non-in-memory message store unbound', async () => {
    const app = createApp({
      messageStore: new PostgresMessageStore({
        query: async () => [],
        execute: async () => undefined,
      }),
    });
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
  });

  it('returns 401 for unauthenticated GET /conversations', async () => {
    const app = createApp();
    const res = await app.request('/conversations');
    expect(res.status).toBe(401);
  });

  it('returns 401 for unauthenticated POST /contact', async () => {
    const app = createApp();
    const res = await app.request('/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 503 on /debug/contacts when debugToken is blank', async () => {
    const app = createApp({ debugToken: '' });
    const res = await app.request('/debug/contacts');
    expect(res.status).toBe(503);
  });

  it('returns 503 on /debug/api-log when debugToken is blank', async () => {
    const app = createApp({ debugToken: '' });
    const res = await app.request('/debug/api-log');
    expect(res.status).toBe(503);
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

  it('allows PUT on the About me preflight', async () => {
    const res = await createApp().request('/me/about', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://21.gifts',
        'access-control-request-method': 'PUT',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toMatch(/PUT/i);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://21.gifts');
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
