import { expect, test, type APIRequestContext } from '@playwright/test';
import { e2eFingerprint, e2eOperatorKeys, e2eSign } from './helpers/operator-keys';

const keys = e2eOperatorKeys();
const OPERATOR = { authorization: 'Bearer e2e-debug-token' };

interface LoginBody {
  token: string;
  operator: string;
  level: string;
  keyFingerprint: string;
  expiresAt: string;
}

async function challenge(request: APIRequestContext): Promise<string> {
  const res = await request.get('/debug/auth/challenge');
  expect(res.status()).toBe(200);
  return ((await res.json()) as { challenge: string }).challenge;
}

async function signIn(
  request: APIRequestContext,
  keyPath: string,
  namespace?: string,
): Promise<{ status: number; body: unknown }> {
  const text = await challenge(request);
  const res = await request.post('/debug/auth', {
    data: { challenge: text, signature: e2eSign(keyPath, text, namespace) },
  });
  return { status: res.status(), body: await res.json() };
}

test('Function: debugAuthRoutes — GET /debug/auth/challenge returns a 60-second challenge', async ({
  request,
}) => {
  const before = Date.now();
  const res = await request.get('/debug/auth/challenge');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { challenge: string; expiresAt: string };
  expect(body.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const ttl = Date.parse(body.expiresAt) - before;
  expect(ttl).toBeGreaterThan(55_000);
  expect(ttl).toBeLessThanOrEqual(61_000);
  const invalid = await request.post('/debug/auth', { data: { challenge: body.challenge } });
  expect(invalid.status()).toBe(400);
});

test('Function: OperatorLogin — a read key logs in, opens GET debug routes, and gets 403 on writes', async ({
  request,
}) => {
  const login = await signIn(request, keys.readKey);
  expect(login.status).toBe(200);
  const body = login.body as LoginBody;
  expect(body).toMatchObject({ operator: 'e2e-reader', level: 'read' });
  expect(body.token).toMatch(/^op_/);
  const bearer = { authorization: `Bearer ${body.token}` };
  expect((await request.get('/debug/logins', { headers: bearer })).status()).toBe(200);
  expect((await request.get('/debug/accounts', { headers: bearer })).status()).toBe(200);
  expect((await request.get('/funding/payout-days', { headers: bearer })).status()).toBe(200);
  const write = await request.put('/debug/logins', { headers: bearer, data: { open: true } });
  expect(write.status()).toBe(403);
  expect(await write.json()).toEqual({ error: 'Forbidden' });
});

test('Function: OperatorSigners — the admin key logs in at admin and passes an admin route', async ({
  request,
}) => {
  const login = await signIn(request, keys.adminKey);
  expect(login.status).toBe(200);
  const body = login.body as LoginBody;
  expect(body).toMatchObject({ operator: 'e2e-admin', level: 'admin' });
  const admin = await request.post('/debug/shop-keys', {
    headers: { authorization: `Bearer ${body.token}` },
    data: {},
  });
  expect(admin.status()).not.toBe(401);
  expect(admin.status()).not.toBe(403);
});

test('Function: sshKeyFingerprint — the login answer names the fingerprint ssh-keygen prints', async ({
  request,
}) => {
  const login = await signIn(request, keys.readKey);
  expect((login.body as LoginBody).keyFingerprint).toBe(e2eFingerprint(keys.readKey));
});

test('Function: loadOperatorSigners — the listed ECDSA key was dropped at boot and cannot log in', async ({
  request,
}) => {
  const ecdsa = await signIn(request, keys.ecdsaKey);
  expect(ecdsa.status).toBe(401);
  expect(ecdsa.body).toEqual({ error: 'Unauthorized' });
  expect((await signIn(request, keys.unlistedKey)).status).toBe(401);
  expect((await signIn(request, keys.readKey, '21gifts-debug-prd')).status).toBe(401);
});

test('Function: InMemoryOperatorLoginStore — a challenge is single use on the memory boot', async ({
  request,
}) => {
  const text = await challenge(request);
  const signature = e2eSign(keys.readKey, text);
  const first = await request.post('/debug/auth', { data: { challenge: text, signature } });
  expect(first.status()).toBe(200);
  const replay = await request.post('/debug/auth', { data: { challenge: text, signature } });
  expect(replay.status()).toBe(401);
});

test('Function: PostgresOperatorLoginStore — the memory boot keeps the login in process memory', async ({
  request,
}) => {
  // Without DATABASE_URL the boot uses InMemoryOperatorLoginStore; the login still works.
  expect((await signIn(request, keys.readKey)).status).toBe(200);
});

test('Function: migrateOperatorLoginSchema — the memory boot is healthy without the operator tables', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: resolveRequestAuth — api_log names the operator of a key-token request', async ({
  request,
}) => {
  const login = await signIn(request, keys.readKey);
  const token = (login.body as LoginBody).token;
  expect(
    (
      await request.get('/debug/contacts', { headers: { authorization: `Bearer ${token}` } })
    ).status(),
  ).toBe(200);
  await expect
    .poll(async () => {
      const res = await request.get('/debug/api-log', { headers: OPERATOR });
      const logs = ((await res.json()) as { logs: { path: string; operator: string | null }[] })
        .logs;
      return logs.some((row) => row.path === '/debug/contacts' && row.operator === 'e2e-reader');
    })
    .toBe(true);
});
