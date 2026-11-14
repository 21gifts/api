import { Hono } from 'hono';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { InMemoryApiLogStore } from '@/lib/api-log';
import { IpRateLimiter } from '@/lib/ip-rate-limit';
import { OperatorLogin } from '@/lib/operator-login';
import { InMemoryOperatorLoginStore } from '@/lib/operator-login-store';
import { loadOperatorSigners } from '@/lib/operator-signers';
import {
  DEBUG_AUTH_BODY_LIMIT_BYTES,
  DEBUG_AUTH_CHALLENGES_PER_MINUTE,
  DEBUG_AUTH_LOGINS_PER_MINUTE,
  debugAuthRoutes,
} from '@/routes/debug-auth';
import { createApp } from '@/server';
import {
  TestKeyring,
  signerLine,
  sshSign,
  type TestKey,
} from '@/__tests__/helpers/ssh-operator-keys';

const NS = '21gifts-debug-dev';
const DEBUG_TOKEN = 'static-operator-token';
const ring = new TestKeyring();
const reader = ring.key('reader');
const admin = ring.key('admin');
const DIR = ring.signersDir({
  read: [signerLine('reader', reader)],
  write: [],
  admin: [signerLine('admin', admin)],
});
const ENV = { DEBUG_ALLOWED_SIGNERS_DIR: DIR, DEBUG_SIGNING_NAMESPACE: NS };

let warn: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

afterAll(() => {
  ring.dispose();
});

async function login(app: Hono, key: TestKey): Promise<Response> {
  const res = await app.request('/debug/auth/challenge');
  const { challenge } = (await res.json()) as { challenge: string };
  return app.request('/debug/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge, signature: sshSign(key, NS, challenge) }),
  });
}

async function tokenFor(app: Hono, key: TestKey): Promise<string> {
  const res = await login(app, key);
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

describe('debug auth routes in the app', () => {
  it('logs in, opens the routes of the level, and answers 403 above it', async () => {
    const apiLogStore = new InMemoryApiLogStore();
    const app = createApp({ env: ENV, debugToken: DEBUG_TOKEN, apiLogStore });
    const challenge = await app.request('/debug/auth/challenge');
    expect(challenge.status).toBe(200);
    expect(await challenge.json()).toEqual({
      challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expiresAt: expect.any(String),
    });
    const res = await login(app, reader);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      token: expect.stringMatching(/^op_/),
      operator: 'reader',
      level: 'read',
      keyFingerprint: reader.fingerprint,
      expiresAt: expect.any(String),
    });
    const bearer = { authorization: `Bearer ${String(body['token'])}` };
    expect((await app.request('/debug/logins', { headers: bearer })).status).toBe(200);
    const write = await app.request('/debug/logins', {
      method: 'PUT',
      headers: { ...bearer, 'content-type': 'application/json' },
      body: JSON.stringify({ open: true }),
    });
    expect(write.status).toBe(403);
    expect(await write.json()).toEqual({ error: 'Forbidden' });
    const adminToken = await tokenFor(app, admin);
    const ended = await app.request('/debug/sessions', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(ended.status).not.toBe(401);
    expect(ended.status).not.toBe(403);
  });

  it('fills api_log.operator for key-token requests only', async () => {
    const apiLogStore = new InMemoryApiLogStore();
    const app = createApp({ env: ENV, debugToken: DEBUG_TOKEN, apiLogStore });
    const token = await tokenFor(app, reader);
    await app.request('/debug/logins', { headers: { authorization: `Bearer ${token}` } });
    await app.request('/debug/logins', { headers: { authorization: `Bearer ${DEBUG_TOKEN}` } });
    await vi.waitFor(async () => {
      expect((await apiLogStore.listLatest(10)).length).toBe(4);
    });
    const rows = (await apiLogStore.listLatest(10)).filter((row) => row.path === '/debug/logins');
    const pairs = rows.map((row) => [row.authKind, row.operator]);
    expect(pairs).toHaveLength(2);
    expect(pairs).toEqual(
      expect.arrayContaining([
        ['debug', 'reader'],
        ['debug', null],
      ]),
    );
  });

  it('answers 503 on both login routes without the files while DEBUG_TOKEN still works', async () => {
    const missing = ring.signersDir({ read: [] });
    const app = createApp({
      env: { DEBUG_ALLOWED_SIGNERS_DIR: missing, DEBUG_SIGNING_NAMESPACE: NS },
      debugToken: DEBUG_TOKEN,
    });
    const challenge = await app.request('/debug/auth/challenge');
    expect(challenge.status).toBe(503);
    expect(await challenge.json()).toEqual({ error: 'Operator login is not configured' });
    const post = await app.request('/debug/auth', { method: 'POST', body: '{}' });
    expect(post.status).toBe(503);
    const logins = await app.request('/debug/logins', {
      headers: { authorization: `Bearer ${DEBUG_TOKEN}` },
    });
    expect(logins.status).toBe(200);
  });

  it('answers 503 on both login routes without a namespace', async () => {
    const app = createApp({ env: { DEBUG_ALLOWED_SIGNERS_DIR: DIR }, debugToken: DEBUG_TOKEN });
    expect((await app.request('/debug/auth/challenge')).status).toBe(503);
  });
});

describe('debugAuthRoutes', () => {
  function routes(
    overrides: { challengeLimiter?: IpRateLimiter; loginLimiter?: IpRateLimiter } = {},
  ): Hono {
    const operatorLogin = new OperatorLogin({
      signers: loadOperatorSigners(ENV),
      store: new InMemoryOperatorLoginStore(),
      now: Date.now,
    });
    return new Hono().route(
      '/debug/auth',
      debugAuthRoutes({ operatorLogin, now: Date.now, ...overrides }),
    );
  }

  const ip = { 'cf-connecting-ip': '192.0.2.7' };

  it('marks every answer of both routes no-store', async () => {
    const app = routes();
    for (const res of [
      await app.request('/debug/auth/challenge'),
      await app.request('/debug/auth', { method: 'POST', body: 'not json' }),
      await app.request('/debug/auth', {
        method: 'POST',
        body: JSON.stringify({ challenge: 'a'.repeat(43), signature: 'nothing' }),
      }),
    ]) {
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    const off = new Hono().route(
      '/debug/auth',
      debugAuthRoutes({
        operatorLogin: new OperatorLogin({
          signers: null,
          store: new InMemoryOperatorLoginStore(),
          now: Date.now,
        }),
        now: Date.now,
      }),
    );
    expect((await off.request('/debug/auth/challenge')).headers.get('cache-control')).toBe(
      'no-store',
    );
  });

  it('logs every login refused before the signature check with its reason', async () => {
    const reasons = (): unknown[] =>
      warn.mock.calls
        .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
        .filter((e) => e['event'] === 'debug.auth.login.refused')
        .map((e) => e['reason']);
    const app = routes({ loginLimiter: new IpRateLimiter(3) });
    const post = async (body: string): Promise<Response> =>
      app.request('/debug/auth', { method: 'POST', headers: ip, body });
    await post('x'.repeat(DEBUG_AUTH_BODY_LIMIT_BYTES + 1));
    await post('null');
    await post('{}');
    await post('{}');
    const off = new Hono().route(
      '/debug/auth',
      debugAuthRoutes({
        operatorLogin: new OperatorLogin({
          signers: null,
          store: new InMemoryOperatorLoginStore(),
          now: Date.now,
        }),
        now: Date.now,
      }),
    );
    await off.request('/debug/auth', { method: 'POST', body: '{}' });
    expect(reasons()).toEqual([
      'body_too_large',
      'invalid_body',
      'invalid_body',
      'rate_limited',
      'not_configured',
    ]);
  });

  it('rate limits each route per client address', async () => {
    const app = routes({
      challengeLimiter: new IpRateLimiter(1),
      loginLimiter: new IpRateLimiter(1),
    });
    expect((await app.request('/debug/auth/challenge', { headers: ip })).status).toBe(200);
    const limited = await app.request('/debug/auth/challenge', { headers: ip });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'Too many requests' });
    const post = { method: 'POST', headers: ip, body: '{}' };
    expect((await app.request('/debug/auth', post)).status).toBe(400);
    expect((await app.request('/debug/auth', post)).status).toBe(429);
    expect(DEBUG_AUTH_CHALLENGES_PER_MINUTE).toBe(30);
    expect(DEBUG_AUTH_LOGINS_PER_MINUTE).toBe(10);
  });

  it('caps the body and the signature', async () => {
    const app = routes();
    const big = await app.request('/debug/auth', {
      method: 'POST',
      body: 'x'.repeat(DEBUG_AUTH_BODY_LIMIT_BYTES + 1),
    });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: 'Request body is too large' });
    const longSignature = await app.request('/debug/auth', {
      method: 'POST',
      body: JSON.stringify({ challenge: 'a'.repeat(43), signature: 's'.repeat(2049) }),
    });
    expect(longSignature.status).toBe(400);
  });

  it('answers 400 for a body that is not a login', async () => {
    const app = routes();
    for (const body of [
      'not json',
      'null',
      '[]',
      '{"challenge":1,"signature":"s"}',
      '{"challenge":"c"}',
    ]) {
      const res = await app.request('/debug/auth', { method: 'POST', body });
      expect([body, res.status]).toEqual([body, 400]);
      expect(await res.json()).toEqual({ error: 'Invalid login' });
    }
  });

  it('answers 401 for a refused login', async () => {
    const app = routes();
    const res = await app.request('/debug/auth', {
      method: 'POST',
      body: JSON.stringify({ challenge: 'a'.repeat(43), signature: 'nothing' }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });
});
