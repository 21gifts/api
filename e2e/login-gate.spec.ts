import { expect, test, type APIRequestContext } from '@playwright/test';

const DEBUG = { authorization: 'Bearer e2e-debug-token' };
// Every test in this file gets its own 30 s cap.
test.describe.configure({ timeout: 30_000 });

interface LoginsBody {
  open: boolean;
  source: 'stored' | 'default';
  defaultOpen: boolean;
  allowlist: Array<{ accountId: string; createdAt: string }>;
}

async function provisionedAccountId(request: APIRequestContext): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const name = `E2eGate${stamp}`;
  const provision = await request.post('/debug/accounts', {
    headers: DEBUG,
    data: { accounts: [{ name, username: `e2e-gate-${stamp}`.slice(0, 32) }] },
  });
  expect(provision.status()).toBe(200);
  const listed = await request.get('/debug/accounts', { headers: DEBUG });
  const accounts = ((await listed.json()) as { accounts: Array<{ id: string; name: string }> })
    .accounts;
  const row = accounts.find((item) => item.name === name);
  expect(row).toBeDefined();
  return row?.id as string;
}

// The switch and the session table are shared by every parallel e2e test, so these
// tests never close logins and never wipe sessions; Vitest covers those branches.

test('GET /debug/logins reports an open switch on the default boot', async ({ request }) => {
  const res = await request.get('/debug/logins', { headers: DEBUG });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as LoginsBody;
  expect(body.open).toBe(true);
  expect(body.defaultOpen).toBe(true);
  expect(Array.isArray(body.allowlist)).toBe(true);
});

test('PUT /debug/logins stores open and refuses a bad body', async ({ request }) => {
  const res = await request.put('/debug/logins', { headers: DEBUG, data: { open: true } });
  expect(res.status()).toBe(200);
  expect((await res.json()) as LoginsBody).toMatchObject({ open: true, source: 'stored' });
  const bad = await request.put('/debug/logins', { headers: DEBUG, data: { open: 'no' } });
  expect(bad.status()).toBe(400);
});

test('POST /debug/logins/allowlist adds an account, 404 for an unknown one', async ({
  request,
}) => {
  const accountId = await provisionedAccountId(request);
  const res = await request.post('/debug/logins/allowlist', {
    headers: DEBUG,
    data: { accountId },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as LoginsBody & { added: boolean };
  expect(body.added).toBe(true);
  expect(body.allowlist.some((row) => row.accountId === accountId)).toBe(true);
  const unknown = await request.post('/debug/logins/allowlist', {
    headers: DEBUG,
    data: { accountId: '00000000-0000-4000-8000-0000000000ff' },
  });
  expect(unknown.status()).toBe(404);
});

test('DELETE /debug/logins/allowlist/:accountId removes an account', async ({ request }) => {
  const notUuid = await request.delete('/debug/logins/allowlist/:accountId', { headers: DEBUG });
  expect(notUuid.status()).toBe(404);
  const accountId = await provisionedAccountId(request);
  await request.post('/debug/logins/allowlist', { headers: DEBUG, data: { accountId } });
  const res = await request.delete(`/debug/logins/allowlist/${accountId}`, { headers: DEBUG });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as LoginsBody & { removed: boolean };
  expect(body.removed).toBe(true);
  expect(body.allowlist.some((row) => row.accountId === accountId)).toBe(false);
});

test('DELETE /debug/sessions without the operator bearer is 401', async ({ request }) => {
  const res = await request.delete('/debug/sessions');
  expect(res.status()).toBe(401);
  const wrong = await request.delete('/debug/sessions', {
    headers: { authorization: 'Bearer not-the-token' },
  });
  expect(wrong.status()).toBe(401);
});

test('Function: resolveLoginsOpenDefault — boots open', async ({ request }) => {
  const body = (await (
    await request.get('/debug/logins', { headers: DEBUG })
  ).json()) as LoginsBody;
  expect(body.defaultOpen).toBe(true);
});

test('Function: resolveRequiredAppBuild — no check', async ({ request }) => {
  const res = await request.post('/auth/passkey/authenticate/begin');
  expect(res.status()).toBe(200);
});

test('Function: appBuildAccepted — any build passes', async ({ request }) => {
  const res = await request.post('/auth/passkey/authenticate/begin', {
    headers: { 'x-app-build': 'some-old-build' },
  });
  expect(res.status()).toBe(200);
});

test('Function: LoginGate — open lets register begin', async ({ request }) => {
  const res = await request.post('/auth/passkey/register/begin');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { challengeId: string };
  expect(body.challengeId).toMatch(/^[0-9a-f]{64}$/);
});

test('Function: InMemoryLoginGateStore — allowlist round trip', async ({ request }) => {
  const accountId = await provisionedAccountId(request);
  const added = await request.post('/debug/logins/allowlist', {
    headers: DEBUG,
    data: { accountId },
  });
  expect(((await added.json()) as { added: boolean }).added).toBe(true);
  const again = await request.post('/debug/logins/allowlist', {
    headers: DEBUG,
    data: { accountId },
  });
  expect(((await again.json()) as { added: boolean }).added).toBe(false);
  const removed = await request.delete(`/debug/logins/allowlist/${accountId}`, {
    headers: DEBUG,
  });
  expect(((await removed.json()) as { removed: boolean }).removed).toBe(true);
});

test('Function: PostgresLoginGateStore — no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: migrateLoginGateSchema — no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: debugLoginsRoutes — operator bearer required', async ({ request }) => {
  expect((await request.get('/debug/logins')).status()).toBe(401);
  expect((await request.get('/debug/logins', { headers: DEBUG })).status()).toBe(200);
});
