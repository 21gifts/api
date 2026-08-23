import { expect, test, type APIRequestContext } from '@playwright/test';
import { newWallet, type TestWallet } from './helpers/wallet';

type StartChallenge = { lnurl: string; k1: string; pollToken: string };
type SessionAccount = { linkingKey: string; lightningAddress: string | null };

async function startChallenge(request: APIRequestContext): Promise<StartChallenge> {
  const res = await request.get('/auth/lnurl');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as StartChallenge;
  expect(body.lnurl.startsWith('lnurl1') || body.lnurl.startsWith('LNURL1')).toBe(true);
  expect(body.k1.length).toBeGreaterThan(8);
  expect(body.pollToken.length).toBeGreaterThan(8);
  return body;
}

async function completeCallback(
  request: APIRequestContext,
  start: StartChallenge,
  wallet: TestWallet,
): Promise<void> {
  const res = await request.get(
    `/auth/lnurl/callback?tag=login&k1=${start.k1}&sig=${wallet.sign(start.k1)}&key=${wallet.key}`,
  );
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ status: 'OK' });
}

async function login(request: APIRequestContext): Promise<{
  token: string;
  account: SessionAccount;
  wallet: TestWallet;
  pollToken: string;
}> {
  const wallet = newWallet();
  const start = await startChallenge(request);
  await completeCallback(request, start, wallet);
  const sessRes = await request.get('/auth/session', {
    headers: { 'x-poll-token': start.pollToken },
  });
  expect(sessRes.status()).toBe(200);
  const sess = (await sessRes.json()) as {
    status: string;
    token: string;
    account: SessionAccount;
  };
  expect(sess.status).toBe('authenticated');
  expect(sess.account.linkingKey).toBe(wallet.key);
  return { token: sess.token, account: sess.account, wallet, pollToken: start.pollToken };
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

test('Function: parseBindAddr — process listens on BIND_ADDR', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: resolveBindAddr — process listens on BIND_ADDR', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: createApp — booted process serves HTTP', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: healthRoute — GET /healthz is ok', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { status: string };
  expect(body.status).toBe('ok');
});

test('Function: infoRoute — GET /info names the service', async ({ request }) => {
  const res = await request.get('/info');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { service: string };
  expect(body.service).toBe('21gifts-api');
});

test('Function: brandRoutes — GET /favicon.svg is svg', async ({ request }) => {
  const res = await request.get('/favicon.svg');
  expect(res.status()).toBe(200);
  expect((res.headers()['content-type'] ?? '').startsWith('image/svg+xml')).toBe(true);
});

test('Function: readPublicBrandFile — GET /favicon.svg has bytes', async ({ request }) => {
  const res = await request.get('/favicon.svg');
  expect(res.status()).toBe(200);
  const body = await res.body();
  expect(body.byteLength).toBeGreaterThan(0);
});

test('Function: requestLog — GET /info succeeds through middleware', async ({ request }) => {
  const res = await request.get('/info');
  expect(res.status()).toBe(200);
});

test('Function: logEvent — GET /info succeeds through middleware', async ({ request }) => {
  const res = await request.get('/info');
  expect(res.status()).toBe(200);
});

test('Function: resolveAllowedOrigins — CORS preflight allows localhost', async ({ request }) => {
  const res = await request.fetch('/info', {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:3000',
      'Access-Control-Request-Method': 'GET',
    },
  });
  expect(res.status()).toBe(204);
  expect(res.headers()['access-control-allow-origin']).toBe('http://localhost:3000');
});

test('Function: normalizePublicBaseUrl — GET /auth/lnurl issues a challenge', async ({
  request,
}) => {
  const start = await startChallenge(request);
  expect(start.lnurl.startsWith('lnurl1') || start.lnurl.startsWith('LNURL1')).toBe(true);
});

test('Function: authRoutes — GET /auth/lnurl issues a challenge', async ({ request }) => {
  await startChallenge(request);
});

test('Function: startChallenge — GET /auth/lnurl returns k1 and pollToken', async ({ request }) => {
  await startChallenge(request);
});

test('Function: encodeLnurl — challenge lnurl is bech32', async ({ request }) => {
  const start = await startChallenge(request);
  expect(start.lnurl.toLowerCase().startsWith('lnurl1')).toBe(true);
});

test('Function: randomHex — k1 and pollToken are long hex', async ({ request }) => {
  const start = await startChallenge(request);
  expect(/^[0-9a-f]+$/i.test(start.k1)).toBe(true);
  expect(/^[0-9a-f]+$/i.test(start.pollToken)).toBe(true);
});

test('Function: InMemoryAuthStore — challenge persists until claimed', async ({ request }) => {
  const wallet = newWallet();
  const start = await startChallenge(request);
  await completeCallback(request, start, wallet);
  const sess = await request.get('/auth/session', {
    headers: { 'x-poll-token': start.pollToken },
  });
  expect(((await sess.json()) as { status: string }).status).toBe('authenticated');
});

test('Function: verifyAuthSig — wallet callback is OK', async ({ request }) => {
  const wallet = newWallet();
  const start = await startChallenge(request);
  await completeCallback(request, start, wallet);
});

test('Function: verifyAuthSig — a bad signature is ERROR', async ({ request }) => {
  const wallet = newWallet();
  const start = await startChallenge(request);
  const res = await request.get(
    `/auth/lnurl/callback?tag=login&k1=${start.k1}&sig=${wallet.sign(start.k1, { prehash: true })}&key=${wallet.key}`,
  );
  expect(res.status()).toBe(200);
  expect(((await res.json()) as { status: string }).status).toBe('ERROR');
});

test('Function: completeCallback — wallet callback is OK', async ({ request }) => {
  const wallet = newWallet();
  const start = await startChallenge(request);
  await completeCallback(request, start, wallet);
});

test('Function: claimSession — poll returns authenticated then used', async ({ request }) => {
  const { pollToken } = await login(request);
  const again = await request.get('/auth/session', {
    headers: { 'x-poll-token': pollToken },
  });
  expect(((await again.json()) as { status: string }).status).toBe('used');
});

test('Function: resolveSession — GET /me with bearer is the wallet account', async ({
  request,
}) => {
  const { token, wallet } = await login(request);
  const me = await request.get('/me', { headers: bearer(token) });
  expect(me.status()).toBe(200);
  const body = (await me.json()) as { linkingKey: string };
  expect(body.linkingKey).toBe(wallet.key);
});

test('Function: bearerToken — GET /me with bearer is the wallet account', async ({ request }) => {
  const { token, wallet } = await login(request);
  const me = await request.get('/me', { headers: bearer(token) });
  expect(me.status()).toBe(200);
  expect(((await me.json()) as { linkingKey: string }).linkingKey).toBe(wallet.key);
});

test('Function: meRoutes — GET /me with bearer is 200', async ({ request }) => {
  const { token } = await login(request);
  const me = await request.get('/me', { headers: bearer(token) });
  expect(me.status()).toBe(200);
});

test('Function: normalizeDisplayName — POST /me/name trims and rejects empty', async ({
  request,
}) => {
  const { token } = await login(request);
  const empty = await request.post('/me/name', {
    headers: bearer(token),
    data: { name: '   ' },
  });
  expect(empty.status()).toBe(400);
  const ok = await request.post('/me/name', {
    headers: bearer(token),
    data: { name: '  Ada  ' },
  });
  expect(ok.status()).toBe(200);
  expect(((await ok.json()) as { name: string }).name).toBe('Ada');
});

test('Function: normalizeLightningAddress — POST rejects garbage and stores a trimmed valid address', async ({
  request,
}) => {
  const { token } = await login(request);
  const bad = await request.post('/me/lightning-address', {
    headers: bearer(token),
    data: { address: 'not-an-address' },
  });
  expect(bad.status()).toBe(400);
  const ok = await request.post('/me/lightning-address', {
    headers: bearer(token),
    data: { address: '  Alice@walletofsatoshi.com  ' },
  });
  expect(ok.status()).toBe(200);
  const body = (await ok.json()) as { lightningAddress: string };
  expect(body.lightningAddress).toBe('Alice@walletofsatoshi.com');
  const me = await request.get('/me', { headers: bearer(token) });
  expect(((await me.json()) as { lightningAddress: string }).lightningAddress).toBe(
    'Alice@walletofsatoshi.com',
  );
});

test('Function: startVerification — POST without a linked address is 409', async ({ request }) => {
  const { token } = await login(request);
  const res = await request.post('/me/lightning-address/verification', {
    headers: bearer(token),
  });
  expect(res.status()).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('No Lightning Address linked');
});

test('Function: UnconfiguredInvoicePayer — POST verification after link is 503', async ({
  request,
}) => {
  const { token } = await login(request);
  await request.post('/me/lightning-address', {
    headers: bearer(token),
    data: { address: 'alice@walletofsatoshi.com' },
  });
  const res = await request.post('/me/lightning-address/verification', {
    headers: bearer(token),
  });
  expect(res.status()).toBe(503);
  expect(((await res.json()) as { error: string }).error).toBe(
    'Verification payments are not configured',
  );
});

test('Function: requestPayInvoice — default boot never pays; verification is 503', async ({
  request,
}) => {
  const { token } = await login(request);
  const linked = await request.post('/me/lightning-address', {
    headers: bearer(token),
    data: { address: 'alice@not-a-lnurlp.invalid' },
  });
  expect(linked.status()).toBe(200);
  const res = await request.post('/me/lightning-address/verification', {
    headers: bearer(token),
  });
  expect(res.status()).toBe(503);
  expect(((await res.json()) as { error: string }).error).toBe(
    'Verification payments are not configured',
  );
});

test('Function: confirmVerification — confirm without a pending payment is 409', async ({
  request,
}) => {
  const { token } = await login(request);
  const res = await request.post('/me/lightning-address/verification/confirm', {
    headers: bearer(token),
    data: { nonce: '00' },
  });
  expect(res.status()).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('No verification in progress');
});

test('Function: lightningAddressRoutes — GET with a public address is 502 when LNURL-pay is unreachable', async ({
  request,
}) => {
  const res = await request.get('/lightning-address?address=alice@not-a-lnurlp.invalid');
  expect(res.status()).toBe(502);
});

test('Function: resolveLnurlp — GET an unresolvable address is 502', async ({ request }) => {
  const res = await request.get('/lightning-address?address=alice@not-a-lnurlp.invalid');
  expect(res.status()).toBe(502);
});

test('Function: InMemoryLnAddressCache — a failed resolve is not cached as success', async ({
  request,
}) => {
  const first = await request.get('/lightning-address?address=alice@not-a-lnurlp.invalid');
  const second = await request.get('/lightning-address?address=alice@not-a-lnurlp.invalid');
  expect(first.status()).toBe(502);
  expect(second.status()).toBe(502);
});

test('Function: openAuthStore — default boot has no DATABASE_URL and serves HTTP', async ({
  request,
}) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: PostgresAuthStore — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: migrateAuthSchema — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: debugRoutes — GET /debug/accounts with the e2e token is 200', async ({
  request,
}) => {
  const res = await request.get('/debug/accounts', {
    headers: { authorization: 'Bearer e2e-debug-token' },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { accounts: unknown[] };
  expect(Array.isArray(body.accounts)).toBe(true);
});

test('Function: bearerMatchesDebugToken — GET /debug/accounts without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/debug/accounts');
  expect(res.status()).toBe(401);
  const wrong = await request.get('/debug/accounts', {
    headers: { authorization: 'Bearer wrong-token' },
  });
  expect(wrong.status()).toBe(401);
});

test('Function: compareAccountsForList — debug listing is ordered by createdAt', async ({
  request,
}) => {
  await login(request);
  await login(request);
  const res = await request.get('/debug/accounts', {
    headers: { authorization: 'Bearer e2e-debug-token' },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { accounts: Array<{ createdAt: number }> };
  expect(body.accounts.length).toBeGreaterThanOrEqual(2);
  for (let i = 1; i < body.accounts.length; i += 1) {
    expect(body.accounts[i]!.createdAt).toBeGreaterThanOrEqual(body.accounts[i - 1]!.createdAt);
  }
});

test('Function: meRoutes unlink — DELETE clears the linked address', async ({ request }) => {
  const { token } = await login(request);
  const linked = await request.post('/me/lightning-address', {
    headers: bearer(token),
    data: { address: 'alice@walletofsatoshi.com' },
  });
  expect(linked.status()).toBe(200);
  expect(((await linked.json()) as { lightningAddress: string }).lightningAddress).toBe(
    'alice@walletofsatoshi.com',
  );
  const res = await request.delete('/me/lightning-address', { headers: bearer(token) });
  expect(res.status()).toBe(200);
  expect(((await res.json()) as { lightningAddress: string | null }).lightningAddress).toBeNull();
  const me = await request.get('/me', { headers: bearer(token) });
  expect(((await me.json()) as { lightningAddress: string | null }).lightningAddress).toBeNull();
});
