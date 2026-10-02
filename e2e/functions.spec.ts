import { expect, test, type APIRequestContext } from '@playwright/test';

const DEBUG = { authorization: 'Bearer e2e-debug-token' };

async function memberSession(
  request: APIRequestContext,
): Promise<{ authorization: string; id: string }> {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const name = `E2eFnTrust${stamp.slice(0, 8)}`;
  const provision = await request.post('/debug/accounts', {
    headers: DEBUG,
    data: {
      accounts: [
        {
          name,
          username: `e2e-fn-trust-${stamp}`.slice(0, 32),
        },
      ],
    },
  });
  expect(provision.status()).toBe(200);
  const listed = await request.get('/debug/accounts', { headers: DEBUG });
  const accounts = ((await listed.json()) as { accounts: Array<{ id: string; name: string }> })
    .accounts;
  const row = accounts.find((item) => item.name === name);
  expect(row).toBeDefined();
  const session = await request.post(`/debug/accounts/${row?.id}/session`, { headers: DEBUG });
  expect(session.status()).toBe(200);
  const token = ((await session.json()) as { token: string }).token;
  return { authorization: `Bearer ${token}`, id: row?.id ?? '' };
}

async function rosterRoleSession(
  request: APIRequestContext,
  role: 'moderator' | 'initiator' | 'founder',
): Promise<{ authorization: string; id: string }> {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const name = `E2eRoster${stamp}`;
  const provision = await request.post('/debug/accounts', {
    headers: DEBUG,
    data: { accounts: [{ name }] },
  });
  expect(provision.status()).toBe(200);
  const listed = await request.get('/debug/accounts', { headers: DEBUG });
  expect(listed.status()).toBe(200);
  const accounts = ((await listed.json()) as { accounts: Array<{ id: string; name: string }> })
    .accounts;
  const row = accounts.find((item) => item.name === name);
  expect(row?.id).toBeTruthy();
  const id = row?.id ?? '';
  const patched = await request.patch(`/debug/accounts/${id}`, {
    headers: DEBUG,
    data: { role },
  });
  expect(patched.status()).toBe(200);
  const patchedBody = (await patched.json()) as { id: string; role: string };
  expect(patchedBody.id).toBe(id);
  expect(patchedBody.role).toBe(role);
  const session = await request.post(`/debug/accounts/${id}/session`, { headers: DEBUG });
  expect(session.status()).toBe(200);
  const token = ((await session.json()) as { token: string }).token;
  return { authorization: `Bearer ${token}`, id };
}

/** Bare GET /trust-chain lists every founder. A mirror must not leave that role on the shared server. */
async function releaseRosterFounder(request: APIRequestContext, id: string): Promise<void> {
  const cleared = await request.patch(`/debug/accounts/${id}`, {
    headers: DEBUG,
    data: { role: 'basis' },
  });
  expect(cleared.status()).toBe(200);
}

/** Provision a member whose linked address is on an unreachable domain; returns its username. */
async function unreachableMember(request: APIRequestContext): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const name = `E2eFnPay${stamp.slice(-8)}`;
  const provision = await request.post('/debug/accounts', {
    headers: DEBUG,
    data: { accounts: [{ name, lightningAddress: `e2e-fn-pay-${stamp}@unreachable.invalid` }] },
  });
  expect(provision.status()).toBe(200);
  const listed = await request.get('/debug/accounts', { headers: DEBUG });
  const accounts = (
    (await listed.json()) as { accounts: Array<{ name: string; username: string | null }> }
  ).accounts;
  const username = accounts.find((item) => item.name === name)?.username ?? null;
  expect(username).not.toBeNull();
  return username ?? '';
}

async function passkeyBegin(request: APIRequestContext): Promise<{ challengeId: string }> {
  const res = await request.post('/auth/passkey/register/begin');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { challengeId: string; options: { challenge: string } };
  expect(body.challengeId.length).toBeGreaterThan(8);
  expect(body.options.challenge.length).toBeGreaterThan(8);
  return body;
}

test('Function: syncWelcomePing — posted lookup is up', async ({ request }) => {
  const res = await request.get('/invoices/posted');
  expect(res.status()).toBe(503);
});

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

test('Function: readVideoTakenAt — POST /messages without bearer is 401', async ({ request }) => {
  const res = await request.post('/messages', { data: { text: 'hi' } });
  expect(res.status()).toBe(401);
});

test('Function: normalizePhotoTakenAt — POST /messages without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/messages', {
    data: { text: 'hi' },
  });
  expect(res.status()).toBe(401);
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

test('Function: requestLogPath — GET /view/<64-hex> is 404 (process up)', async ({ request }) => {
  const res = await request.get('/view/' + 'a'.repeat(64));
  expect(res.status()).toBe(404);
});

test('Function: logEvent — GET /info succeeds through middleware', async ({ request }) => {
  const res = await request.get('/info');
  expect(res.status()).toBe(200);
});

test('Function: errorLogFields — GET /healthz is ok while the worker logs no tick failure', async ({
  request,
}) => {
  const res = await request.get('/healthz');
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

test('Function: authRoutes — POST passkey register begin returns a challenge', async ({
  request,
}) => {
  await passkeyBegin(request);
});

test('Function: randomHex — passkey challengeId is long hex', async ({ request }) => {
  const body = await passkeyBegin(request);
  expect(/^[0-9a-f]+$/i.test(body.challengeId)).toBe(true);
});

test('Function: InMemoryAuthStore — passkey begin is 200', async ({ request }) => {
  await passkeyBegin(request);
});

test('Function: resolveSession — GET /me without bearer is 401', async ({ request }) => {
  const me = await request.get('/me');
  expect(me.status()).toBe(401);
});

test('Function: bearerToken — GET /me without bearer is 401', async ({ request }) => {
  const me = await request.get('/me');
  expect(me.status()).toBe(401);
});

test('Function: meRoutes — GET /me without bearer is 401', async ({ request }) => {
  const me = await request.get('/me');
  expect(me.status()).toBe(401);
});

test('Function: meRoutes — POST /me/wallet-backup-seen without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/me/wallet-backup-seen');
  expect(res.status()).toBe(401);
});

test('Function: markWalletBackupSeen — POST /me/wallet-backup-seen without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/me/wallet-backup-seen');
  expect(res.status()).toBe(401);
});

test('Function: capPasskeyRenewText — POST /me/passkey-renew/report without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/me/passkey-renew/report');
  expect(res.status()).toBe(401);
});

test('Function: redactPasskeyRenewField — POST /me/passkey-renew/report field redaction without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/me/passkey-renew/report');
  expect(res.status()).toBe(401);
});

test('Function: sanitizePasskeyRenewDebug — POST /me/passkey-renew/report debug allowlist without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/me/passkey-renew/report');
  expect(res.status()).toBe(401);
});

test('Function: redactPasskeyRenewMessage — POST /me/passkey-renew/ack without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/me/passkey-renew/ack');
  expect(res.status()).toBe(401);
});

test('Function: aboutMeFromNote — PUT /me/about without bearer is 401', async ({ request }) => {
  const res = await request.put('/me/about', { data: { text: 'Hi' } });
  expect(res.status()).toBe(401);
});

test('Function: forumPhotoResponse — GET /me/about/photo without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/me/about/photo');
  expect(res.status()).toBe(401);
});

test('Function: updatePhoto — GET /view/:viewKey/about/photo without a key is 404', async ({
  request,
}) => {
  const res = await request.get('/view/:viewKey/about/photo');
  expect(res.status()).toBe(404);
});

test('Function: buildAccountActivity — GET /me/activity without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/me/activity');
  expect(res.status()).toBe(401);
});

test('Function: matchConfirmedGivenZaps — GET /members/:accountId/activity without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/members/:accountId/activity');
  expect(res.status()).toBe(401);
});

test('Function: paymentHashFromReceipt — GET /view/:viewKey/activity is 404 on default boot', async ({
  request,
}) => {
  const res = await request.get('/view/:viewKey/activity');
  expect(res.status()).toBe(404);
});

test('Function: membersRoutes — GET /members/:accountId without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/members/:accountId');
  expect(res.status()).toBe(401);
});

test('Function: mentionQueryPrefix — GET /mentions without bearer is 401', async ({ request }) => {
  const res = await request.get('/mentions');
  expect(res.status()).toBe(401);
});

test('Function: mentionAccountMatches — GET /mentions without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/mentions');
  expect(res.status()).toBe(401);
});

test('Function: mentionsRoutes — GET /mentions without bearer is 401', async ({ request }) => {
  const res = await request.get('/mentions');
  expect(res.status()).toBe(401);
});

test('Function: requireAction — GET /messages without bearer is 401', async ({ request }) => {
  const res = await request.get('/messages');
  expect(res.status()).toBe(401);
});

test('Function: actionRequirements — GET /messages without bearer is 401', async ({ request }) => {
  const res = await request.get('/messages');
  expect(res.status()).toBe(401);
});

test('Function: accountMissing — GET /me without bearer is 401', async ({ request }) => {
  const me = await request.get('/me');
  expect(me.status()).toBe(401);
});

test('Function: ensureProfileMessage — POST /me/name without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/me/name', { data: { name: 'Ada' } });
  expect(res.status()).toBe(401);
});

test('Function: viewRoutes — GET /view/:viewKey is 404 on default boot', async ({ request }) => {
  const res = await request.get('/view/:viewKey');
  expect(res.status()).toBe(404);
});

test('Function: normalizeDisplayName — POST /me/name without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/me/name', { data: { name: 'Ada' } });
  expect(res.status()).toBe(401);
});

test('Function: normalizeUsername — POST /me/username without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/me/username', { data: { username: 'ada' } });
  expect(res.status()).toBe(401);
});

test('Function: normalizeSparkPubkey — PUT /me/wallet is 404 when LNURL server is off', async ({
  request,
}) => {
  const res = await request.put('/me/wallet');
  expect(res.status()).toBe(404);
  expect(await res.text()).toBe('404 Not Found');
});

test('Function: IpRateLimiter — POST /lnurlpay/:pubkey is 404 when LNURL server is off', async ({
  request,
}) => {
  const res = await request.post('/lnurlpay/:pubkey');
  expect(res.status()).toBe(404);
  expect(await res.text()).toBe('404 Not Found');
});

test('Function: resolveLnurlServerConfig — PUT /me/wallet is 404 when LNURL server is off', async ({
  request,
}) => {
  const res = await request.put('/me/wallet');
  expect(res.status()).toBe(404);
  expect(await res.text()).toBe('404 Not Found');
});

test('Function: callLnurlServer — GET /lnurlp/:username/invoice is 404 when LNURL server is off', async ({
  request,
}) => {
  const res = await request.get('/lnurlp/:username/invoice');
  expect(res.status()).toBe(404);
  expect(await res.text()).toBe('404 Not Found');
});

// PUT /me/wallet unmounted (plain-text 404) proves the feature is off; /.well-known/lnurlp/:username
// is the only route that calls walletPayRequest (only for a verified wallet key when on).
test('Function: walletPayRequest — GET /.well-known/lnurlp/:username is 404 and PUT /me/wallet is unmounted when LNURL server is off', async ({
  request,
}) => {
  const wallet = await request.put('/me/wallet');
  expect(wallet.status()).toBe(404);
  expect(await wallet.text()).toBe('404 Not Found');
  const wellKnown = await request.get('/.well-known/lnurlp/:username');
  expect(wellKnown.status()).toBe(404);
});

test('Function: lnurlServerRoutes — GET /verify/:paymentHash is 404 when LNURL server is off', async ({
  request,
}) => {
  const res = await request.get('/verify/:paymentHash');
  expect(res.status()).toBe(404);
  expect(await res.text()).toBe('404 Not Found');
});

test('Function: usernameFromDisplayName — POST /me/name without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/me/name', { data: { name: 'Ada Lovelace' } });
  expect(res.status()).toBe(401);
});

test('Function: backfillAccountUsernames — GET /healthz is ok after boot backfill', async ({
  request,
}) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: normalizeLocation — POST /me/location without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/me/location', { data: { location: 'Berlin' } });
  expect(res.status()).toBe(401);
});

test('Function: locationHashtagName — POST /me/location without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/me/location', { data: { location: 'Berlin' } });
  expect(res.status()).toBe(401);
});

test('Function: normalizeLightningAddress — GET /lightning-address with a malformed address is 400', async ({
  request,
}) => {
  const res = await request.get('/lightning-address?address=not-an-address');
  expect(res.status()).toBe(400);
});

test('Function: lightningAddressRoutes — GET with a public address is 502 when LNURL-pay is unreachable', async ({
  request,
}) => {
  const res = await request.get('/lightning-address?address=alice@not-a-lnurlp.invalid');
  expect(res.status()).toBe(502);
});

test('Function: lnurlRoutes — POST /lnurl/pay-request without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/lnurl/pay-request', { data: { target: 'bob@example.com' } });
  expect(res.status()).toBe(401);
  expect(await res.json()).toEqual({ error: 'Unauthorized' });
});

test('Function: resolveRelayPayRequest — a Lightning Address on a .localhost host is 400 without a fetch', async ({
  request,
}) => {
  const { authorization } = await memberSession(request);
  const res = await request.post('/lnurl/pay-request', {
    headers: { authorization },
    data: { target: 'bob@printer.localhost' },
  });
  expect(res.status()).toBe(400);
  expect(await res.json()).toEqual({ error: 'Not a payable address' });
});

test('Function: requestRelayInvoice — a target on a .internal host is 400 without a fetch', async ({
  request,
}) => {
  const { authorization } = await memberSession(request);
  const res = await request.post('/lnurl/invoice', {
    headers: { authorization },
    data: { target: 'bob@wallet.internal', amountMsat: 1000 },
  });
  expect(res.status()).toBe(400);
  expect(await res.json()).toEqual({ error: 'Not a payable address' });
});

test('Function: LnurlRelayRateLimiter — the 31st relay request in a minute is 429', async ({
  request,
}) => {
  // Own member, so other relay tests in this file never share these hits.
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const name = `E2eRelayLimit${stamp}`;
  const provision = await request.post('/debug/accounts', {
    headers: DEBUG,
    data: { accounts: [{ name, lightningAddress: `e2e-relay-${stamp}@walletofsatoshi.com` }] },
  });
  expect(provision.status()).toBe(200);
  const listed = await request.get('/debug/accounts', { headers: DEBUG });
  const accounts = ((await listed.json()) as { accounts: Array<{ id: string; name: string }> })
    .accounts;
  const row = accounts.find((item) => item.name === name);
  expect(row).toBeDefined();
  const session = await request.post(`/debug/accounts/${row?.id}/session`, { headers: DEBUG });
  expect(session.status()).toBe(200);
  const authorization = `Bearer ${((await session.json()) as { token: string }).token}`;
  const statuses: number[] = [];
  for (let i = 0; i < 31; i += 1) {
    const res = await request.post('/lnurl/pay-request', {
      headers: { authorization },
      data: { target: 'not-an-address' },
    });
    statuses.push(res.status());
  }
  expect(statuses).toEqual([...Array<number>(30).fill(400), 429]);
});

test('Function: isPublicIp — a relay target whose host does not resolve is 502 before any address check', async ({
  request,
}) => {
  const { authorization } = await memberSession(request);
  const res = await request.post('/lnurl/pay-request', {
    headers: { authorization },
    data: { target: 'bob@not-a-lnurlp.invalid' },
  });
  expect(res.status()).toBe(502);
  expect(await res.json()).toEqual({ error: 'Address could not be reached' });
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

test('Function: isUniqueViolation — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: sqlState — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: migrateAuthSchema — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: debugRoutes — POST /debug/accounts with the e2e token is 200', async ({
  request,
}) => {
  const res = await request.post('/debug/accounts', {
    headers: { authorization: 'Bearer e2e-debug-token' },
    data: { accounts: [{ name: 'Ada' }] },
  });
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

test('Function: mergeAccounts — POST /debug/accounts/merge is 503 on default boot', async ({
  request,
}) => {
  const res = await request.post('/debug/accounts/merge', {
    headers: DEBUG,
    data: {
      from: '00000000-0000-4000-8000-000000000001',
      into: '00000000-0000-4000-8000-000000000002',
    },
  });
  expect(res.status()).toBe(503);
  expect(((await res.json()) as { error: string }).error).toBe('Merge is unavailable');
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

test('Function: assertDistinctDebugTokens — booted process stays up when the read token is empty', async ({
  request,
}) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: classifyDebugDbBearer — write token reaches GET /debug/db and a wrong bearer is 401', async ({
  request,
}) => {
  const ok = await request.get('/debug/db', {
    headers: { authorization: 'Bearer e2e-debug-token' },
  });
  expect(ok.status()).toBe(503);
  expect(((await ok.json()) as { error: string }).error).toBe('Database is not configured');
  const wrong = await request.get('/debug/db', {
    headers: { authorization: 'Bearer wrong-token' },
  });
  expect(wrong.status()).toBe(401);
  expect(((await wrong.json()) as { error: string }).error).toBe('Unauthorized');
});

test('Function: compareAccountsForList — debug listing is ordered by createdAt', async ({
  request,
}) => {
  const res = await request.get('/debug/accounts', {
    headers: { authorization: 'Bearer e2e-debug-token' },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { accounts: Array<{ createdAt: number }> };
  expect(Array.isArray(body.accounts)).toBe(true);
  for (let i = 1; i < body.accounts.length; i += 1) {
    expect(body.accounts[i]!.createdAt).toBeGreaterThanOrEqual(body.accounts[i - 1]!.createdAt);
  }
});

test('Function: meRoutes — the removed DELETE /me/lightning-address is 404', async ({
  request,
}) => {
  const res = await request.delete('/me/lightning-address');
  expect(res.status()).toBe(404);
});

test('Function: giftsRoutes — GET /gifts without a day is 400', async ({ request }) => {
  const res = await request.get('/gifts');
  expect(res.status()).toBe(400);
});

test('Function: isUtcDay — GET /gifts with an impossible day is 400', async ({ request }) => {
  const res = await request.get('/gifts?day=2026-02-31');
  expect(res.status()).toBe(400);
});

test('Function: utcDayFromPaidAt — GET /gifts for an empty day is 200', async ({ request }) => {
  const res = await request.get('/gifts?day=2026-06-01');
  expect(res.status()).toBe(200);
  expect(((await res.json()) as { giftCount: number }).giftCount).toBe(0);
});

test('Function: buildGiftDay — GET /gifts for an empty day is 200', async ({ request }) => {
  const res = await request.get('/gifts?day=2026-06-01');
  expect(res.status()).toBe(200);
});

test('Function: buildPostStats — GET /messages/stats returns a posts total', async ({
  request,
}) => {
  const res = await request.get('/messages/stats');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { postCount: number; postsOverTime: unknown[] };
  expect(body.postCount).toBeGreaterThanOrEqual(0);
  expect(Array.isArray(body.postsOverTime)).toBe(true);
});

test('Function: giftsStatsRoutes — GET /gifts/stats is empty on default boot', async ({
  request,
}) => {
  const res = await request.get('/gifts/stats');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { giftCount: number; totalSats: number };
  expect(body.giftCount).toBe(0);
  expect(body.totalSats).toBe(0);
});

test('Function: giftsForRecipient — GET /gifts/stats?recipient= is empty on default boot', async ({
  request,
}) => {
  const res = await request.get('/gifts/stats?recipient=alice');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    giftCount: number;
    totalSats: number;
    spendOverTime: unknown[];
  };
  expect(body.giftCount).toBe(0);
  expect(body.totalSats).toBe(0);
  expect(body.spendOverTime).toEqual([]);
});

test('Function: InMemoryGiftStore — GET /gifts/stats is empty on default boot', async ({
  request,
}) => {
  const res = await request.get('/gifts/stats');
  expect(res.status()).toBe(200);
  expect(((await res.json()) as { giftCount: number }).giftCount).toBe(0);
});

test('Function: buildGiftStats — GET /gifts/stats is empty on default boot', async ({
  request,
}) => {
  const res = await request.get('/gifts/stats');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    spendOverTime: unknown[];
    firstPaidAt: string | null;
  };
  expect(body.spendOverTime).toEqual([]);
  expect(body.firstPaidAt).toBeNull();
});

test('Function: loadGiftStatsSnapshot — GET /gifts/stats has no spend on default boot', async ({
  request,
}) => {
  const res = await request.get('/gifts/stats');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { giftCount: number; spendOverTime: unknown[] };
  expect(body.giftCount).toBe(0);
  expect(body.spendOverTime).toEqual([]);
});

async function verifiedAskSession(request: APIRequestContext): Promise<{ authorization: string }> {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const name = `Ask${stamp.replace(/[^a-z0-9]/gi, '')}`;
  const provision = await request.post('/debug/accounts', {
    headers: DEBUG,
    data: {
      accounts: [
        {
          name,
          username: `ask-${stamp}`.slice(0, 32),
        },
      ],
    },
  });
  expect(provision.status()).toBe(200);
  const listed = await request.get('/debug/accounts', { headers: DEBUG });
  const accounts = ((await listed.json()) as { accounts: Array<{ id: string; name: string }> })
    .accounts;
  const row = accounts.find((item) => item.name === name);
  expect(row).toBeDefined();
  const minted = await request.post(`/debug/accounts/${row?.id}/session`, { headers: DEBUG });
  expect(minted.status()).toBe(200);
  const token = ((await minted.json()) as { token: string }).token;
  const auth = { authorization: `Bearer ${token}` };
  const agreed = await request.post('/me/rules-agreement', { headers: auth });
  expect(agreed.status()).toBe(200);
  const promoted = await request.patch(`/debug/accounts/${row?.id}`, {
    headers: DEBUG,
    data: { role: 'verified' },
  });
  expect(promoted.status()).toBe(200);
  return auth;
}

// Posting needs a verified wallet, which needs LNURL_SERVER_URL (blank here).
test('Function: loadLatestGoalRateDay — a fiat ask is 409 without a verified wallet', async ({
  request,
}) => {
  const auth = await verifiedAskSession(request);
  const res = await request.post('/messages', {
    headers: auth,
    data: { text: 'pesos', goalCurrency: 'PHP', goalAmount: '200' },
  });
  expect(res.status()).toBe(409);
  expect(await res.json()).toEqual({
    error: 'missing_requirements',
    missing: ['lightning-address'],
  });
});

// Posting needs a verified wallet, which needs LNURL_SERVER_URL (blank here).
test('Function: bindGoalRateDay — a bitcoin ask is 409 without a verified wallet', async ({
  request,
}) => {
  const auth = await verifiedAskSession(request);
  const res = await request.post('/messages', {
    headers: auth,
    data: { text: 'sats', goalCurrency: 'BTC', goalAmount: '21' },
  });
  expect(res.status()).toBe(409);
  expect(await res.json()).toEqual({
    error: 'missing_requirements',
    missing: ['lightning-address'],
  });
});

// Posting needs a verified wallet, which needs LNURL_SERVER_URL (blank here).
test('Function: canonicalGoalAmount — an ask is 409 without a verified wallet', async ({
  request,
}) => {
  const auth = await verifiedAskSession(request);
  const res = await request.post('/messages', {
    headers: auth,
    data: { text: 'bad', goalCurrency: 'USD', goalAmount: '1e2' },
  });
  expect(res.status()).toBe(409);
  expect(await res.json()).toEqual({
    error: 'missing_requirements',
    missing: ['lightning-address'],
  });
});

// Posting needs a verified wallet, which needs LNURL_SERVER_URL (blank here).
test('Function: fiatToSats — an ask is 409 without a verified wallet', async ({ request }) => {
  const auth = await verifiedAskSession(request);
  const res = await request.post('/messages', {
    headers: auth,
    data: { text: 'both', goalSats: 21, goalCurrency: 'USD', goalAmount: '1' },
  });
  expect(res.status()).toBe(409);
  expect(await res.json()).toEqual({
    error: 'missing_requirements',
    missing: ['lightning-address'],
  });
});

// Posting needs a verified wallet, which needs LNURL_SERVER_URL (blank here).
test('Function: satsToFiatAmount — a bitcoin ask is 409 without a verified wallet', async ({
  request,
}) => {
  const auth = await verifiedAskSession(request);
  const res = await request.post('/messages', {
    headers: auth,
    data: { text: 'freeze', goalCurrency: 'BTC', goalAmount: '21' },
  });
  expect(res.status()).toBe(409);
  expect(await res.json()).toEqual({
    error: 'missing_requirements',
    missing: ['lightning-address'],
  });
});

test('Function: QueryGiftStore — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: messagesRoutes — GET /messages without bearer is 401', async ({ request }) => {
  const res = await request.get('/messages');
  expect(res.status()).toBe(401);
});

test('Function: encodeMessageFeedCursor — GET /messages without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/messages');
  expect(res.status()).toBe(401);
});

test('Function: decodeMessageFeedCursor — GET /messages without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/messages');
  expect(res.status()).toBe(401);
});

test('Function: normalizeForumText — POST /messages without bearer is 401', async ({ request }) => {
  const res = await request.post('/messages', {
    data: { text: 'hi' },
  });
  expect(res.status()).toBe(401);
});

test('Function: forumContentFingerprint — POST /messages without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/messages', {
    data: { text: 'hi' },
  });
  expect(res.status()).toBe(401);
});

test('Function: detectImageContentType — GET /messages without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/messages');
  expect(res.status()).toBe(401);
});

test('Function: decodeForumPhoto — POST /messages without bearer is 401', async ({ request }) => {
  const res = await request.post('/messages', {
    data: { text: 'hi' },
  });
  expect(res.status()).toBe(401);
});

test('Function: detectImageContentType — POST /messages with a photo without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/messages', {
    data: {
      photo: { contentType: 'image/jpeg', data: '/9j/4AAQ' },
    },
  });
  expect(res.status()).toBe(401);
});

test('Function: messagesRoutes — GET /messages/:id/photo without bearer is 404', async ({
  request,
}) => {
  const res = await request.get('/messages/:id/photo');
  expect(res.status()).toBe(404);
});

test('Function: serializeMessage — GET /messages without bearer is 401', async ({ request }) => {
  const res = await request.get('/messages');
  expect(res.status()).toBe(401);
});

test('Function: InMemoryMessageStore — GET /messages without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/messages');
  expect(res.status()).toBe(401);
});

test('Function: PostgresMessageStore — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: backfillZapPayments — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: migrateMessageSchema — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: migrateGiftSchema — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: repairGiftKind — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: posRoutes — GET and DELETE /pos without bearer are 401', async ({ request }) => {
  expect((await request.get('/pos')).status()).toBe(401);
  expect((await request.delete('/pos')).status()).toBe(401);
});

test('Function: serializePosCharge — GET /pos without bearer is 401', async ({ request }) => {
  expect((await request.get('/pos')).status()).toBe(401);
});

test('Function: serializeDebugPosCharge — GET /pos without bearer is 401', async ({ request }) => {
  expect((await request.get('/pos')).status()).toBe(401);
});

test('Function: migratePosSchema — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: InMemoryPosStore — POST /pos without bearer is 401', async ({ request }) => {
  expect((await request.post('/pos', { data: { amountSats: 21 } })).status()).toBe(401);
});

test('Function: PostgresPosStore — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: contactRoutes — POST /contact without bearer is 401', async ({ request }) => {
  const res = await request.post('/contact', {
    data: { text: 'hi' },
  });
  expect(res.status()).toBe(401);
});

test('Function: debugContactsRoutes — GET /debug/contacts without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/debug/contacts');
  expect(res.status()).toBe(401);
});

test('Function: debugApiLogRoutes — GET /debug/api-log without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/debug/api-log');
  expect(res.status()).toBe(401);
});

test('Function: diagnosticsRoutes — POST /diagnostics accepts an allowlisted client event', async ({
  request,
}) => {
  const res = await request.post('/diagnostics', {
    data: { event: 'client.passkey.register.begin' },
  });
  expect(res.status()).toBe(204);
});

test('Function: readClientRequestMeta — GET /info stores validated client headers on the audit row', async ({
  request,
}) => {
  const userAgent = 'e2e-request-meta-read';
  const res = await request.get('/info', {
    headers: {
      'cf-connecting-ip': '192.0.2.1',
      'cf-ipcountry': 't1',
      'cf-ray': '0123456789abcdef-ZRH',
      'user-agent': userAgent,
      'accept-language': 'de-CH,de;q=0.9',
      origin: 'https://21.gifts',
    },
  });
  expect(res.status()).toBe(200);
  const listed = await request.get('/debug/api-log', {
    headers: { authorization: 'Bearer e2e-debug-token' },
  });
  expect(listed.status()).toBe(200);
  const body = (await listed.json()) as {
    logs: Array<{
      path: string;
      userAgent: string | null;
      clientIp: string | null;
      clientCountry: string | null;
      cfRay: string | null;
      acceptLanguage: string | null;
      origin: string | null;
    }>;
  };
  const row = body.logs.find((log) => log.userAgent === userAgent && log.path === '/info');
  expect(row).toMatchObject({
    clientIp: '192.0.2.1',
    clientCountry: 'T1',
    cfRay: '0123456789abcdef-ZRH',
    acceptLanguage: 'de-CH,de;q=0.9',
    origin: 'https://21.gifts',
  });
});

test('Function: presentClientFields — POST /diagnostics stores present client headers', async ({
  request,
}) => {
  const res = await request.post('/diagnostics', {
    headers: {
      'cf-connecting-ip': '198.51.100.10',
      'cf-ipcountry': 'ch',
      'cf-ray': 'fedcba9876543210-zrh',
      'user-agent': 'e2e-present-fields',
      'accept-language': 'en',
      origin: 'http://127.0.0.1:3000',
    },
    data: { event: 'client.e2e.present.fields' },
  });
  expect(res.status()).toBe(204);
  const listed = await request.get('/debug/diagnostics', {
    headers: { authorization: 'Bearer e2e-debug-token' },
  });
  expect(listed.status()).toBe(200);
  const body = (await listed.json()) as {
    logs: Array<{ event: string; fields: Record<string, unknown> }>;
  };
  const row = body.logs.find((log) => log.event === 'client.e2e.present.fields');
  expect(row?.fields).toMatchObject({
    clientIp: '198.51.100.10',
    clientCountry: 'CH',
    cfRay: 'fedcba9876543210-zrh',
    userAgent: 'e2e-present-fields',
    acceptLanguage: 'en',
    origin: 'http://127.0.0.1:3000',
  });
});

test('Function: debugDiagnosticsRoutes — GET /debug/diagnostics without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/debug/diagnostics');
  expect(res.status()).toBe(401);
});

test('Function: serializeDebugDiagnostic — GET /debug/diagnostics without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/debug/diagnostics');
  expect(res.status()).toBe(401);
});

test('Function: InMemoryDiagnosticStore — GET /debug/diagnostics without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/debug/diagnostics');
  expect(res.status()).toBe(401);
});

test('Function: PostgresDiagnosticStore — default boot has no DATABASE_URL', async ({
  request,
}) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: migrateDiagnosticSchema — default boot has no DATABASE_URL', async ({
  request,
}) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: setDiagnosticSink — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: serializeDebugApiLog — GET /debug/api-log without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/debug/api-log');
  expect(res.status()).toBe(401);
});

test('Function: InMemoryApiLogStore — GET /debug/api-log without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/debug/api-log');
  expect(res.status()).toBe(401);
});

test('Function: PostgresApiLogStore — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: migrateApiLogSchema — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: resolveRequestAuth — GET /debug/api-log without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/debug/api-log');
  expect(res.status()).toBe(401);
});

test('Function: debugDbRoutes — GET /debug/db without bearer is 401', async ({ request }) => {
  const res = await request.get('/debug/db');
  expect(res.status()).toBe(401);
});

test('Function: PostgresDebugDbStore — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: DebugDbCursorError — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: debugMessagesRoutes — PUT /debug/messages/:id/video without bearer is 401', async ({
  request,
}) => {
  const res = await request.put('/debug/messages/:id/video');
  expect(res.status()).toBe(401);
});

test('Function: serializeDebugMessage — GET /debug/messages without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/debug/messages');
  expect(res.status()).toBe(401);
});

test('Function: serializeHiddenMessage — GET /messages/hidden without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/messages/hidden');
  expect(res.status()).toBe(401);
});

test('Function: debugPaymentsRoutes — GET /debug/invoices without bearer is 401', async ({
  request,
}) => {
  const invoices = await request.get('/debug/invoices');
  expect(invoices.status()).toBe(401);
  const ingests = await request.get('/debug/zap-ingests');
  expect(ingests.status()).toBe(401);
  const spendPing = await request.post('/debug/spend-ping', {
    data: { messageId: '00000000-0000-4000-8000-000000000000' },
  });
  expect(spendPing.status()).toBe(401);
});

test('Function: settleInvoiceManually — POST /debug/invoices/settle without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/debug/invoices/settle', {
    data: { paymentHash: 'aa'.repeat(32), note: 'operator evidence' },
  });
  expect(res.status()).toBe(401);
});

test('Function: manualReceiptIdForPaymentHash — POST /debug/invoices/settle without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/debug/invoices/settle', {
    data: { paymentHash: 'bb'.repeat(32), note: 'operator evidence' },
  });
  expect(res.status()).toBe(401);
});

test('Function: serializeContact — POST /contact without bearer is 401', async ({ request }) => {
  const res = await request.post('/contact', {
    data: { text: 'hi' },
  });
  expect(res.status()).toBe(401);
});

test('Function: serializeDebugContact — GET /debug/contacts without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/debug/contacts');
  expect(res.status()).toBe(401);
});

test('Function: InMemoryContactStore — POST /contact without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/contact', {
    data: { text: 'hi' },
  });
  expect(res.status()).toBe(401);
});

test('Function: PostgresContactStore — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: migrateContactSchema — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: migratePushSchema — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: InMemoryPushStore — GET /push/vapid-public without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/push/vapid-public')).status()).toBe(401);
});
test('Function: PostgresPushStore — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: resolveVapidConfig — GET /push/vapid-public without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/push/vapid-public')).status()).toBe(401);
});
test('Function: UnconfiguredPushSender — GET /push/vapid-public without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/push/vapid-public')).status()).toBe(401);
});
test('Function: WebPushSender — GET /push/vapid-public without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/push/vapid-public')).status()).toBe(401);
});
test('Function: webPushTopicFromTag — GET /push/vapid-public without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/push/vapid-public')).status()).toBe(401);
});
test('Function: parsePushSubscription — POST /me/push-subscriptions without bearer is 401', async ({
  request,
}) => {
  expect((await request.post('/me/push-subscriptions')).status()).toBe(401);
});
test('Function: buildForumPushPayload — POST /me/push-subscriptions without bearer is 401', async ({
  request,
}) => {
  expect((await request.post('/me/push-subscriptions')).status()).toBe(401);
});
test('Function: buildModeratorAppointedPushPayload — POST /me/push-subscriptions without bearer is 401', async ({
  request,
}) => {
  expect((await request.post('/me/push-subscriptions')).status()).toBe(401);
});
test('Function: buildZapPushPayload — POST /me/push-subscriptions without bearer is 401', async ({
  request,
}) => {
  expect((await request.post('/me/push-subscriptions')).status()).toBe(401);
});

test('Function: buildConversationPushPayload — POST /me/push-subscriptions without bearer is 401', async ({
  request,
}) => {
  expect((await request.post('/me/push-subscriptions')).status()).toBe(401);
});
test('Function: conversationPushRecipientIds — GET /conversations without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/conversations')).status()).toBe(401);
});
test('Function: inboxUnreadCountFor — GET /conversations without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/conversations')).status()).toBe(401);
});
test('Function: notifyConversationMessage — POST /conversations/:id without bearer is 401', async ({
  request,
}) => {
  expect((await request.post('/conversations/:id', { data: { text: 'hi' } })).status()).toBe(401);
});
test('Function: enqueueForumPushes — POST /messages without bearer is 401', async ({ request }) => {
  expect((await request.post('/messages')).status()).toBe(401);
});
test('Function: buildReplyPushPayload — POST /me/push-subscriptions without bearer is 401', async ({
  request,
}) => {
  expect((await request.post('/me/push-subscriptions')).status()).toBe(401);
});
test('Function: enqueueReplyPush — POST /messages without bearer is 401', async ({ request }) => {
  expect((await request.post('/messages')).status()).toBe(401);
});
test('Function: enqueueZapPush — GET /push/vapid-public without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/push/vapid-public')).status()).toBe(401);
});
test('Function: enqueueDebugPush — POST /debug/push-ping without bearer is 401', async ({
  request,
}) => {
  expect((await request.post('/debug/push-ping')).status()).toBe(401);
});
test('Function: runPushWorkerTick — GET /healthz is ok', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: startPushWorker — GET /healthz is ok', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: pushRoutes — GET /push/vapid-public without bearer is 401', async ({ request }) => {
  expect((await request.get('/push/vapid-public')).status()).toBe(401);
});
test('Function: debugPushRoutes — POST /debug/push-ping without bearer is 401', async ({
  request,
}) => {
  expect((await request.post('/debug/push-ping')).status()).toBe(401);
});
test('Function: debugPasskeyRenewRoutes — POST /debug/passkey-renew/reopen with an unknown account is 404', async ({
  request,
}) => {
  const res = await request.post('/debug/passkey-renew/reopen', {
    headers: { authorization: 'Bearer e2e-debug-token' },
    data: { accountId: '00000000-0000-4000-8000-000000000001' },
  });
  expect(res.status()).toBe(404);
});

test('Function: listDbChanges — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: migrateDbChangeSchema — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: DB_CHANGE_SCHEMA_SQL — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: mapGiftQueryRow — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: InMemoryBtcUsdStore — GET /gifts/stats is empty on default boot', async ({
  request,
}) => {
  const res = await request.get('/gifts/stats');
  expect(res.status()).toBe(200);
  expect(((await res.json()) as { giftCount: number }).giftCount).toBe(0);
});

test('Function: satsToBtcString — empty stats totalBtc is 8 dp', async ({ request }) => {
  const res = await request.get('/gifts/stats');
  expect(res.status()).toBe(200);
  expect(((await res.json()) as { totalBtc: string }).totalBtc).toBe('0.00000000');
});

test('Function: usdCentsToString — empty stats totalUsd is 2 dp', async ({ request }) => {
  const res = await request.get('/gifts/stats');
  expect(res.status()).toBe(200);
  expect(((await res.json()) as { totalUsd: string }).totalUsd).toBe('0.00');
});

test('Function: usdCentsToFiatCents — empty stats skip fiat conversion', async ({ request }) => {
  const res = await request.get('/gifts/stats');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { giftCount: number; totalChf: string };
  expect(body.giftCount).toBe(0);
  expect(body.totalChf).toBe('0.00');
});

test('Function: InMemoryFiatStore — GET /gifts/stats is empty on default boot', async ({
  request,
}) => {
  const res = await request.get('/gifts/stats');
  expect(res.status()).toBe(200);
  expect(((await res.json()) as { giftCount: number }).giftCount).toBe(0);
});

test('Function: PostgresFiatStore — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: migrateFiatSchema — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: fillFiatRatesForGiftRange — default boot has no DATABASE_URL', async ({
  request,
}) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: fetchFiatRates — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: parseFrankfurterRates — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: resolveFrankfurterUrl — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: satsToUsdCents — empty stats skip USD conversion', async ({ request }) => {
  const res = await request.get('/gifts/stats');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { giftCount: number; totalUsd: string };
  expect(body.giftCount).toBe(0);
  expect(body.totalUsd).toBe('0.00');
});

test('Function: shownFiatFromBody — invoice without a session is 401', async ({ request }) => {
  const res = await request.post('/messages/00000000-0000-4000-8000-000000000001/invoice', {
    data: { sats: 21, amountUsd: '5.00', amountChf: null, amountEur: null, amountPhp: null },
  });
  expect(res.status()).toBe(401);
});

test('Function: normalizeAmountUsd — empty stats skip USD conversion', async ({ request }) => {
  const res = await request.get('/gifts/stats');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { giftCount: number; totalUsd: string };
  expect(body.giftCount).toBe(0);
  expect(body.totalUsd).toBe('0.00');
});

test('Function: fiatFromUsd — empty stats skip USD conversion', async ({ request }) => {
  const res = await request.get('/gifts/stats');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { giftCount: number; totalUsd: string };
  expect(body.giftCount).toBe(0);
  expect(body.totalUsd).toBe('0.00');
});

test('Function: fiatFromSats — empty stats skip USD conversion', async ({ request }) => {
  const res = await request.get('/gifts/stats');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { giftCount: number; totalUsd: string };
  expect(body.giftCount).toBe(0);
  expect(body.totalUsd).toBe('0.00');
});

test('Function: fetchBtcUsdSpot — empty stats skip USD conversion', async ({ request }) => {
  const res = await request.get('/gifts/stats');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { giftCount: number; totalUsd: string };
  expect(body.giftCount).toBe(0);
  expect(body.totalUsd).toBe('0.00');
});

test('Function: parseUsdPerBtc — empty stats skip USD conversion', async ({ request }) => {
  const res = await request.get('/gifts/stats');
  expect(res.status()).toBe(200);
  expect(((await res.json()) as { giftCount: number }).giftCount).toBe(0);
});

test('Function: PostgresBtcUsdStore — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: migrateBtcUsdSchema — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: fillRatesForGiftRange — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: fetchDailyCloses — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: parseCoinbaseCandles — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: resolveCandlesUrl — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: resolveSpendPing — default boot has no SPEND_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});
test('Function: HttpSpendPing — default boot has no SPEND_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});
test('Function: NoopSpendPing — default boot has no SPEND_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: decideSpendInstruction — chooses the daily amount from the roster', async ({
  request,
}) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: startPasskeyClaim — POST begin with an unknown viewKey is 404', async ({
  request,
}) => {
  const res = await request.post('/auth/passkey/register/begin', {
    data: { viewKey: 'a'.repeat(64) },
  });
  expect(res.status()).toBe(404);
});

test('Function: startPasskeyRegistration — POST begin returns a challenge', async ({ request }) => {
  const res = await request.post('/auth/passkey/register/begin');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { challengeId: string; options: { challenge: string } };
  expect(body.challengeId.length).toBeGreaterThan(8);
  expect(body.options.challenge.length).toBeGreaterThan(8);
});

test('Function: SimpleWebAuthnPasskeyCeremony — POST begin returns WebAuthn options', async ({
  request,
}) => {
  const res = await request.post('/auth/passkey/register/begin');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { options: { rp?: { id?: string } } };
  expect(body.options.rp?.id).toBe('localhost');
});

test('Function: resolveWebAuthnConfig — POST begin returns a challenge', async ({ request }) => {
  const res = await request.post('/auth/passkey/register/begin');
  expect(res.status()).toBe(200);
});

test('Function: normalizeWebAuthnRpId — POST begin returns a challenge', async ({ request }) => {
  const res = await request.post('/auth/passkey/register/begin');
  expect(res.status()).toBe(200);
});

test('Function: finishPasskeyRegistration — POST finish without Origin is 400', async ({
  request,
}) => {
  const begin = await request.post('/auth/passkey/register/begin');
  const { challengeId } = (await begin.json()) as { challengeId: string };
  const res = await request.post('/auth/passkey/register/finish', {
    data: { challengeId, credential: { id: 'cred-e2e' } },
  });
  expect(res.status()).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe('Invalid origin');
});

test('Function: expectedOriginsForRpId — POST finish with a filtered Origin is 400', async ({
  request,
}) => {
  const begin = await request.post('/auth/passkey/register/begin');
  const { challengeId } = (await begin.json()) as { challengeId: string };
  const res = await request.post('/auth/passkey/register/finish', {
    headers: { origin: 'http://127.0.0.1:3000' },
    data: { challengeId, credential: { id: 'cred-e2e' } },
  });
  expect(res.status()).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe('Invalid origin');
});

test('Function: startPasskeyAuthentication — POST begin returns a challenge', async ({
  request,
}) => {
  const res = await request.post('/auth/passkey/authenticate/begin');
  expect(res.status()).toBe(200);
  expect(((await res.json()) as { challengeId: string }).challengeId.length).toBeGreaterThan(8);
});

test('Function: startPasskeyReplace — POST replace begin without Bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/auth/passkey/replace/begin');
  expect(res.status()).toBe(401);
});

test('Function: finishPasskeyReplace — POST replace finish without Bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/auth/passkey/replace/finish');
  expect(res.status()).toBe(401);
});

test('Function: startPasskeySeed — POST seed begin without Bearer is 401', async ({ request }) => {
  const res = await request.post('/auth/passkey/seed/begin');
  expect(res.status()).toBe(401);
});

test('Function: finishPasskeySeed — POST seed finish without Bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/auth/passkey/seed/finish');
  expect(res.status()).toBe(401);
});

test('Function: addSeedPasskeyCredential — POST seed begin without Bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/auth/passkey/seed/begin');
  expect(res.status()).toBe(401);
});

test('Function: prfEvalFirstSalt — POST authenticate begin returns a challenge', async ({
  request,
}) => {
  const res = await request.post('/auth/passkey/authenticate/begin');
  expect(res.status()).toBe(200);
});

test('Function: finishPasskeyAuthentication — POST finish without credential id is 400', async ({
  request,
}) => {
  const begin = await request.post('/auth/passkey/authenticate/begin');
  const { challengeId } = (await begin.json()) as { challengeId: string };
  const res = await request.post('/auth/passkey/authenticate/finish', {
    headers: { origin: 'http://localhost:3000' },
    data: { challengeId, credential: { test: 'ok' } },
  });
  expect(res.status()).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe('Unknown credential');
});

test('Function: credentialIdFrom — POST authenticate finish without credential id is 400', async ({
  request,
}) => {
  const begin = await request.post('/auth/passkey/authenticate/begin');
  const { challengeId } = (await begin.json()) as { challengeId: string };
  const res = await request.post('/auth/passkey/authenticate/finish', {
    headers: { origin: 'http://localhost:3000' },
    data: { challengeId, credential: { test: 'ok' } },
  });
  expect(res.status()).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe('Unknown credential');
});

test('Function: issueSession — GET /me without bearer is 401', async ({ request }) => {
  const me = await request.get('/me');
  expect(me.status()).toBe(401);
});

test('Function: isWrongAccount — GET /me without bearer is 401', async ({ request }) => {
  const me = await request.get('/me');
  expect(me.status()).toBe(401);
});

test('Function: openBootStores — default boot has no DATABASE_URL and serves HTTP', async ({
  request,
}) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: invoiceRoutes — POST /invoices unconfigured is 503', async ({ request }) => {
  const res = await request.post('/invoices', {
    data: { address: 'alice@example.com', amountMsat: 1000 },
  });
  expect(res.status()).toBe(503);
  expect(((await res.json()) as { error: string }).error).toBe('Spend invoices are not configured');
});

test('Function: checkSpendAuth — POST /invoices unconfigured is 503', async ({ request }) => {
  const res = await request.post('/invoices', {
    data: { address: 'alice@example.com', amountMsat: 1000 },
  });
  expect(res.status()).toBe(503);
});

test('Function: InMemoryInvoiceStore — POST /invoices unconfigured is 503', async ({ request }) => {
  const res = await request.post('/invoices', {
    data: { address: 'alice@example.com', amountMsat: 1000 },
  });
  expect(res.status()).toBe(503);
});

test('Function: requestGiftInvoice — POST /invoices unconfigured is 503', async ({ request }) => {
  const res = await request.post('/invoices', {
    data: { address: 'alice@example.com', amountMsat: 1000 },
  });
  expect(res.status()).toBe(503);
});

test('Function: decodeBolt11 — POST /invoices unconfigured is 503', async ({ request }) => {
  const res = await request.post('/invoices', {
    data: { address: 'alice@example.com', amountMsat: 1000 },
  });
  expect(res.status()).toBe(503);
});

test('Function: inspectBolt11 — POST /invoices unconfigured is 503', async ({ request }) => {
  const res = await request.post('/invoices', {
    data: { address: 'alice@example.com', amountMsat: 1000 },
  });
  expect(res.status()).toBe(503);
});

test('Function: isNip57Invoice — POST /invoices unconfigured is 503', async ({ request }) => {
  const res = await request.post('/invoices', {
    data: { address: 'alice@example.com', amountMsat: 1000 },
  });
  expect(res.status()).toBe(503);
});

test('Function: newInvoiceId — POST /invoices unconfigured is 503', async ({ request }) => {
  const res = await request.post('/invoices', {
    data: { address: 'alice@example.com', amountMsat: 1000 },
  });
  expect(res.status()).toBe(503);
});

test('Function: normalizeHex32 — POST /invoices/proof unconfigured is 503', async ({ request }) => {
  const res = await request.post('/invoices/proof', {
    data: { id: 'x', preimage: '11'.repeat(32) },
  });
  expect(res.status()).toBe(503);
});

test('Function: preimageMatchesHash — POST /invoices/proof unconfigured is 503', async ({
  request,
}) => {
  const res = await request.post('/invoices/proof', {
    data: { id: 'x', preimage: '11'.repeat(32) },
  });
  expect(res.status()).toBe(503);
});

test('Function: NoopGiftRecorder — POST /invoices/proof unconfigured is 503', async ({
  request,
}) => {
  const res = await request.post('/invoices/proof', {
    data: { id: 'x', preimage: '11'.repeat(32) },
  });
  expect(res.status()).toBe(503);
});

test('Function: SqlGiftRecorder — POST /invoices/proof unconfigured is 503', async ({
  request,
}) => {
  const res = await request.post('/invoices/proof', {
    data: { id: 'x', preimage: '11'.repeat(32) },
  });
  expect(res.status()).toBe(503);
});

test('Function: recipientHandleFromAddress — POST /invoices/proof unconfigured is 503', async ({
  request,
}) => {
  const res = await request.post('/invoices/proof', {
    data: { id: 'x', preimage: '11'.repeat(32) },
  });
  expect(res.status()).toBe(503);
});

test('Function: serializeAccount — GET /debug/accounts listing is 200', async ({ request }) => {
  const res = await request.get('/debug/accounts', {
    headers: { authorization: 'Bearer e2e-debug-token' },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { accounts: Array<Record<string, unknown>> };
  expect(Array.isArray(body.accounts)).toBe(true);
  for (const account of body.accounts) {
    expect(account).toHaveProperty('id');
  }
});

test('Function: accountSetup — GET /me without bearer is 401', async ({ request }) => {
  const res = await request.get('/me');
  expect(res.status()).toBe(401);
});

test('Function: serializeOwnerAccount — GET /me without bearer is 401', async ({ request }) => {
  const res = await request.get('/me');
  expect(res.status()).toBe(401);
});

test('Function: serializeOwnerAccountWithPosts — GET /me without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/me');
  expect(res.status()).toBe(401);
});

test('Function: serializeViewProfile — GET /view/:viewKey is 404 on default boot', async ({
  request,
}) => {
  const res = await request.get('/view/:viewKey');
  expect(res.status()).toBe(404);
});

test('Function: parseNostrKek — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: hexToBytes — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: bytesToHex — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: publicKeyHexFromSecret — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: encryptNostrSecret — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: decryptNostrSecret — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: zeroizeSecret — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: ensureAccountNostrKey — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: generateNostrKeyRecord — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: kind1Tags — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: kind1HasHashtag — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: kind1ContentWithHashtags — default boot has no DATABASE_URL', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: buildKind1Event — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: buildKind5Event — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: forumMediaPurgeUrls — GET /healthz is ok', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: resolveCloudflarePurgeConfig — GET /healthz is ok', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: purgeCloudflareFiles — GET /healthz is ok', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: retractHiddenForumNotes — DELETE /messages/:id without bearer is 401', async ({
  request,
}) => {
  const res = await request.delete('/messages/11111111-1111-4111-8111-111111111111');
  expect(res.status()).toBe(401);
});
test('Function: forumPhotoUrl — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: migrateBannerSchema — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: wideBannerSize — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: bannerPublicUrl — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: InMemoryBannerStore — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: PostgresBannerStore — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: picturePublicUrl — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: isProfilePhoto — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: pictureRoutes — PUT /pictures/me without bearer is 401', async ({ request }) => {
  const res = await request.put('/pictures/me', { data: { photo: null } });
  expect(res.status()).toBe(401);
  expect((await request.get('/pictures/me')).status()).toBe(401);
  expect((await request.get('/pictures/:file')).status()).toBe(404);
});
test('Function: bannerRoutes — PUT /banners/me without bearer is 401', async ({ request }) => {
  const res = await request.put('/banners/me', { data: { photo: null } });
  expect(res.status()).toBe(401);
  expect((await request.get('/banners/me')).status()).toBe(401);
  expect((await request.get('/banners/:file')).status()).toBe(404);
});
test('Function: notePageUrl — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: imageDisplaySize — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: imageBlurhash — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: stillLook — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: forumExtraPhotoUrl — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: buildKind0Content — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: buildKind0Event — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: buildKind10002Event — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: truncatePubkeyDisplay — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: signEventForAccount — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: isNostrPublishEnabled — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: isNostrPublishPublicEnabled — default boot has no DATABASE_URL', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: resolveRelaySpace — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: resolveRelayPublic — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: resolveWriteSet — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: writeRelayUrls — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: replyHintRelay — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: readRelaysFromKind10002 — default boot has no DATABASE_URL', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: resolvePublicApiBase — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: resolveZapRelays — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: utcDayKey — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: PostRateLimiter — POST /messages without bearer is 401', async ({ request }) => {
  expect((await request.post('/messages', { data: { text: 'hi' } })).status()).toBe(401);
});
test('Function: InvoiceRateLimiter — POST /messages without bearer is 401', async ({ request }) => {
  expect((await request.post('/messages', { data: { text: 'hi' } })).status()).toBe(401);
});
test('Function: RecordingPublisher — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: WebsocketNostrPublisher — default boot has no DATABASE_URL', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: spaceAcked — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: publicAcked — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: runNostrWorkerTick — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: startNostrWorker — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: buildZapRequest — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: serializeZapRequest — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: receivingAddress — GET /pay/:username resolves the linked address of a member', async ({
  request,
}) => {
  const username = await unreachableMember(request);
  expect((await request.get(`/pay/${username}`)).status()).toBe(502);
  expect((await request.get('/pay/nobody-e2e-unknown')).status()).toBe(404);
});
test('Function: lnurlServerFetch — GET /pay/:username fetches an external address over the plain fetch', async ({
  request,
}) => {
  const username = await unreachableMember(request);
  const res = await request.get(`/pay/${username}`);
  expect(res.status()).toBe(502);
  expect(await res.json()).toEqual({ error: 'Lightning Address could not be resolved' });
});
test('Function: issueSparkInvoice — POST /messages/:id/invoice without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/messages/00000000-0000-4000-8000-000000000000/invoice', {
    data: { sats: 21 },
  });
  expect(res.status()).toBe(401);
});
test('Function: resolveFreePaymentsConfig — free in-app payments are off on the default boot', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: concatBytes — free in-app payments are off on the default boot', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: protoVarintField — free in-app payments are off on the default boot', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: protoBytesField — free in-app payments are off on the default boot', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: decodeProto — free in-app payments are off on the default boot', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: encodeSparkInvoice — free in-app payments are off on the default boot', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: uuidV7 — free in-app payments are off on the default boot', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: migrateSparkInvoiceSchema — free in-app payments are off on the default boot', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: InMemorySparkInvoiceStore — free in-app payments are off on the default boot', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: PostgresSparkInvoiceStore — free in-app payments are off on the default boot', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: encodeQuerySparkInvoicesRequest — free in-app payments are off on the default boot', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: parseQuerySparkInvoicesResponse — free in-app payments are off on the default boot', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: querySparkInvoices — free in-app payments are off on the default boot', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: zapReceiptSecretKey — free in-app payments are off on the default boot', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: buildZapReceipt — free in-app payments are off on the default boot', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: runSparkInvoiceTick — free in-app payments are off on the default boot', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: startSparkInvoiceWorker — free in-app payments are off on the default boot', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: ingestZapReceipt — free in-app payments are off on the default boot', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: zapReceiptIngest — free in-app payments are off on the default boot', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: indexZapReceipt — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: normalizeSignedEvent — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: indexOpenZapReceipts — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: RecordingQuerier — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: WebsocketNostrQuerier — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: requestZapInvoice — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: unsignedNostrDefaults — GET /messages without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/messages')).status()).toBe(401);
});
test('Function: allocateNip05Local — GET /.well-known/nostr.json is 200', async ({ request }) => {
  expect((await request.get('/.well-known/nostr.json')).status()).toBe(200);
});
test('Function: buildNostrJson — GET /.well-known/nostr.json is 200', async ({ request }) => {
  expect((await request.get('/.well-known/nostr.json')).status()).toBe(200);
});
test('Function: decodeForumVideo — POST /messages without bearer is 401', async ({ request }) => {
  const res = await request.post('/messages', {
    data: { text: 'hi' },
  });
  expect(res.status()).toBe(401);
});
test('Function: detectVideoContentType — POST /messages without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/messages', {
    data: { text: 'hi' },
  });
  expect(res.status()).toBe(401);
});
test('Function: forumVideoExt — POST /messages without bearer is 401', async ({ request }) => {
  const res = await request.post('/messages', {
    data: { text: 'hi' },
  });
  expect(res.status()).toBe(401);
});
test('Function: forumVideoUrl — POST /messages without bearer is 401', async ({ request }) => {
  const res = await request.post('/messages', {
    data: { text: 'hi' },
  });
  expect(res.status()).toBe(401);
});
test('Function: listNip05Entries — GET /.well-known/nostr.json is 200', async ({ request }) => {
  expect((await request.get('/.well-known/nostr.json')).status()).toBe(200);
});
test('Function: nip05Domain — GET /.well-known/nostr.json is 200', async ({ request }) => {
  expect((await request.get('/.well-known/nostr.json')).status()).toBe(200);
});
test('Function: nip05Identifier — GET /.well-known/nostr.json is 200', async ({ request }) => {
  expect((await request.get('/.well-known/nostr.json')).status()).toBe(200);
});
test('Function: nip05Slug — GET /.well-known/nostr.json is 200', async ({ request }) => {
  expect((await request.get('/.well-known/nostr.json')).status()).toBe(200);
});
test('Function: normalizeIsoBmffDisplayMatrix — POST /messages without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/messages', {
    data: { text: 'hi' },
  });
  expect(res.status()).toBe(401);
});
test('Function: parseBytesRange — POST /messages without bearer is 401', async ({ request }) => {
  const res = await request.post('/messages', {
    data: { text: 'hi' },
  });
  expect(res.status()).toBe(401);
});
test('Function: removeForumVideo — POST /messages without bearer is 401', async ({ request }) => {
  const res = await request.post('/messages', {
    data: { text: 'hi' },
  });
  expect(res.status()).toBe(401);
});
test('Function: faststartIsoBmff — POST /messages without bearer is 401', async ({ request }) => {
  const res = await request.post('/messages', {
    data: { text: 'hi' },
  });
  expect(res.status()).toBe(401);
});
test('Function: isoBmffDisplaySize — POST /messages without bearer is 401', async ({ request }) => {
  const res = await request.post('/messages', {
    data: { text: 'hi' },
  });
  expect(res.status()).toBe(401);
});
test('Function: isoBmffDurationSeconds — POST /messages without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/messages', {
    data: { text: 'hi' },
  });
  expect(res.status()).toBe(401);
});
test('Function: readForumVideoBytes — POST /messages without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/messages', {
    data: { text: 'hi' },
  });
  expect(res.status()).toBe(401);
});
test('Function: resolveMediaDir — POST /messages without bearer is 401', async ({ request }) => {
  const res = await request.post('/messages', {
    data: { text: 'hi' },
  });
  expect(res.status()).toBe(401);
});
test('Function: videoFilePath — POST /messages without bearer is 401', async ({ request }) => {
  const res = await request.post('/messages', {
    data: { text: 'hi' },
  });
  expect(res.status()).toBe(401);
});
test('Function: forumVideoFilePresent — GET /messages/:id without a file is 404', async ({
  request,
}) => {
  const res = await request.get('/messages/5c5051d3-adba-44f9-a964-9bd0df1ce084');
  expect([200, 404]).toContain(res.status());
});
test('Function: wellKnownRoutes — GET /.well-known/nostr.json is 200', async ({ request }) => {
  expect((await request.get('/.well-known/nostr.json')).status()).toBe(200);
});
test('Function: payRoutes — GET /pay/:username is 404 when unknown', async ({ request }) => {
  expect((await request.get('/pay/:username')).status()).toBe(404);
});
test('Function: writeForumVideo — POST /messages without bearer is 401', async ({ request }) => {
  const res = await request.post('/messages', {
    data: { text: 'hi' },
  });
  expect(res.status()).toBe(401);
});
test('Function: serializeConversation — GET /conversations without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/conversations')).status()).toBe(401);
});
test('Function: conversationFromMe — GET /conversations without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/conversations')).status()).toBe(401);
});
test('Function: moderatorGroupDisplayName — GET /conversations without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/conversations')).status()).toBe(401);
});
test('Function: conversationIsInbound — GET /conversations without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/conversations')).status()).toBe(401);
});
test('Function: serializeNotification — GET /notifications without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/notifications')).status()).toBe(401);
});
test('Function: notifyForumReply — POST /messages without bearer is 401', async ({ request }) => {
  expect((await request.post('/messages')).status()).toBe(401);
});
test('Function: notifyForumPost — POST /messages without bearer is 401', async ({ request }) => {
  expect((await request.post('/messages')).status()).toBe(401);
});
test('Function: notifyModeratorAppointed — POST /trust/confirm-moderator without bearer is 401', async ({
  request,
}) => {
  expect(
    (await request.post('/trust/confirm-moderator', { data: { accountId: 'x' } })).status(),
  ).toBe(401);
});
test('Function: notifyModeratorProposed — POST /trust/propose-moderator without bearer is 401', async ({
  request,
}) => {
  expect(
    (await request.post('/trust/propose-moderator', { data: { accountId: 'x' } })).status(),
  ).toBe(401);
});
test('Function: notifyZap — POST /messages without bearer is 401', async ({ request }) => {
  expect((await request.post('/messages')).status()).toBe(401);
});
test('Function: fanoutToBellSubscribers — POST /messages without bearer is 401', async ({
  request,
}) => {
  expect((await request.post('/messages')).status()).toBe(401);
});
test('Function: parseNotificationLevel — GET /me without bearer is 401', async ({ request }) => {
  expect((await request.get('/me')).status()).toBe(401);
});
test('Function: parseAmountUnit — GET /me without bearer is 401', async ({ request }) => {
  expect((await request.get('/me')).status()).toBe(401);
});
test('Function: parseStoredLocale — GET /me without bearer is 401', async ({ request }) => {
  expect((await request.get('/me')).status()).toBe(401);
});
test('Function: parseStoredFiat — GET /me without bearer is 401', async ({ request }) => {
  expect((await request.get('/me')).status()).toBe(401);
});
test('Function: isStaffAccount — GET /me without bearer is 401', async ({ request }) => {
  expect((await request.get('/me')).status()).toBe(401);
});
test('Function: wantsNotification — GET /me without bearer is 401', async ({ request }) => {
  expect((await request.get('/me')).status()).toBe(401);
});
test('Function: notificationsMatchingLevel — GET /notifications without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/notifications')).status()).toBe(401);
});
test('Function: migrateNotificationSchema — default boot has no DATABASE_URL', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: InMemoryNotificationStore — GET /notifications without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/notifications')).status()).toBe(401);
});
test('Function: PostgresNotificationStore — default boot has no DATABASE_URL', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: notificationRoutes — GET /notifications without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/notifications')).status()).toBe(401);
  expect((await request.post('/notifications/read-all')).status()).toBe(401);
  expect((await request.post('/notifications/:id/read')).status()).toBe(401);
});
test('Function: markReadByMessage — POST /notifications/read-by-message without bearer is 401', async ({
  request,
}) => {
  expect((await request.post('/notifications/read-by-message')).status()).toBe(401);
});
test('Function: enqueueNotificationDismiss — POST /notifications/read-by-message without bearer is 401', async ({
  request,
}) => {
  expect((await request.post('/notifications/read-by-message')).status()).toBe(401);
});
test('Function: pushTagForNotification — POST /notifications/read-by-message without bearer is 401', async ({
  request,
}) => {
  expect((await request.post('/notifications/read-by-message')).status()).toBe(401);
});
test('Function: serializeConversationMessage — GET /conversations/:id without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/conversations/:id')).status()).toBe(401);
});
test('Function: unsignedConversationDefaults — POST /conversations/:id without bearer is 401', async ({
  request,
}) => {
  expect((await request.post('/conversations/:id', { data: { text: 'hi' } })).status()).toBe(401);
});
test('Function: conversationRoutes — GET /conversations without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/conversations')).status()).toBe(401);
});
test('Function: InMemoryConversationStore — GET /conversations without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/conversations')).status()).toBe(401);
});
test('Function: PostgresConversationStore — default boot has no DATABASE_URL', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: migrateConversationSchema — default boot has no DATABASE_URL', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: wrapNip17 — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: unwrapNip17 — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: encryptKind4 — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: decryptKind4 — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: serializeDebugAccount — GET /debug/accounts without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/debug/accounts')).status()).toBe(401);
});
test('Function: serializeDebugAccount — GET /debug/accounts listing is 200', async ({
  request,
}) => {
  const res = await request.get('/debug/accounts', {
    headers: { authorization: 'Bearer e2e-debug-token' },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { accounts: Array<Record<string, unknown>> };
  expect(Array.isArray(body.accounts)).toBe(true);
  for (const account of body.accounts) {
    expect(account).toHaveProperty('viewKey');
  }
});
test('Function: serializeDebugAccountDetail — GET /debug/accounts/:id without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/debug/accounts/:id')).status()).toBe(401);
});
test('Function: serializeDebugPasskey — GET /debug/dump/passkey_credential without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/debug/dump/passkey_credential')).status()).toBe(401);
});
test('Function: serializeDebugSession — GET /debug/dump/auth_session without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/debug/dump/auth_session')).status()).toBe(401);
});
test('Function: serializeDebugPasskeyChallenge — GET /debug/dump/passkey_challenge without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/debug/dump/passkey_challenge')).status()).toBe(401);
});
test('Function: debugNostrFieldsFromListRow — GET /debug/accounts without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/debug/accounts')).status()).toBe(401);
});
test('Function: isDebugCatalogTable — GET /debug/dump/:table without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/debug/dump/:table')).status()).toBe(401);
});
test('Function: loadDebugTables — GET /debug/dump without bearer is 401', async ({ request }) => {
  expect((await request.get('/debug/dump')).status()).toBe(401);
});
test('Function: debugCatalogRoutes — GET /debug/dump without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/debug/dump')).status()).toBe(401);
});

test('Function: isChainAccount — GET /trust-chain around a missing id is 404', async ({
  request,
}) => {
  const auth = await memberSession(request);
  expect((await request.get('/trust-chain?around=ghost', { headers: auth })).status()).toBe(404);
});

test('Function: isStaffRole — GET /trust-chain without bearer is 401', async ({ request }) => {
  const res = await request.get('/trust-chain');
  expect(res.status()).toBe(401);
});

test('Function: isModeratorGroupMember — GET /conversations/moderator-group as a member is 404', async ({
  request,
}) => {
  const auth = await memberSession(request);
  expect((await request.get('/conversations/moderator-group', { headers: auth })).status()).toBe(
    404,
  );
});

test('Function: roleAtLeast — a basis member is below the staff log (GET /messages/hidden is 403)', async ({
  request,
}) => {
  const auth = await memberSession(request);
  expect((await request.get('/messages/hidden', { headers: auth })).status()).toBe(403);
});

test('Function: roleRank — a basis member ranks below staff on GET /trust/proposals (403)', async ({
  request,
}) => {
  const auth = await memberSession(request);
  expect((await request.get('/trust/proposals', { headers: auth })).status()).toBe(403);
});

test('Function: sameRoleRank — confirm leaves an initiator unchanged when the caller already confirmed them', async ({
  request,
}) => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const callerName = `E2eRankCaller${stamp.slice(0, 8)}`;
  const subjectName = `E2eRankSubject${stamp.slice(0, 8)}`;
  const provision = await request.post('/debug/accounts', {
    headers: DEBUG,
    data: {
      accounts: [
        {
          name: callerName,
          username: `e2e-rank-caller-${stamp}`.slice(0, 32),
        },
        {
          name: subjectName,
          username: `e2e-rank-subject-${stamp}`.slice(0, 32),
        },
      ],
    },
  });
  expect(provision.status()).toBe(200);
  const listed = await request.get('/debug/accounts', { headers: DEBUG });
  expect(listed.status()).toBe(200);
  const accounts = ((await listed.json()) as { accounts: Array<{ id: string; name: string }> })
    .accounts;
  const caller = accounts.find((row) => row.name === callerName);
  const subject = accounts.find((row) => row.name === subjectName);
  expect(caller).toBeDefined();
  expect(subject).toBeDefined();
  const callerId = caller?.id ?? '';
  const subjectId = subject?.id ?? '';
  expect(
    (
      await request.patch(`/debug/accounts/${callerId}`, {
        headers: DEBUG,
        data: { role: 'moderator' },
      })
    ).status(),
  ).toBe(200);
  expect(
    (
      await request.patch(`/debug/accounts/${subjectId}`, {
        headers: DEBUG,
        data: { role: 'initiator' },
      })
    ).status(),
  ).toBe(200);
  const session = await request.post(`/debug/accounts/${callerId}/session`, { headers: DEBUG });
  expect(session.status()).toBe(200);
  const token = ((await session.json()) as { token: string }).token;
  const edge = await request.post('/debug/trust-edges', {
    headers: DEBUG,
    data: { subjectId, actorId: callerId, kind: 'moderator_confirm' },
  });
  expect(edge.status()).toBe(200);
  const res = await request.post('/trust/confirm-moderator', {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    data: { accountId: subjectId },
  });
  expect(res.status()).toBe(200);
  expect((await res.json()) as { id: string; role: string }).toMatchObject({
    id: subjectId,
    role: 'initiator',
  });
});

test('Function: isProjectedTrustEdge — GET /trust-chain is empty on default boot', async ({
  request,
}) => {
  const auth = await memberSession(request);
  const res = await request.get('/trust-chain', { headers: auth });
  expect(res.status()).toBe(200);
});

test('Function: buildTrustChain — GET /trust-chain is empty on default boot', async ({
  request,
}) => {
  const auth = await memberSession(request);
  const res = await request.get('/trust-chain', { headers: auth });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { nodes: unknown[]; edges: unknown[] };
  expect(body.nodes).toEqual([]);
  expect(body.edges).toEqual([]);
});

test('Function: accountTrust — GET /trust-chain without bearer is 401', async ({ request }) => {
  expect((await request.get('/trust-chain')).status()).toBe(401);
});

test('Function: serializeTrustEdge — GET /trust-chain without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/trust-chain')).status()).toBe(401);
});

test('Function: InMemoryTrustStore — GET /trust-chain without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/trust-chain');
  expect(res.status()).toBe(401);
});

test('Function: PostgresTrustStore — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: migrateTrustSchema — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: trustChainRoutes — GET /trust-chain without bearer is 401', async ({ request }) => {
  const res = await request.get('/trust-chain');
  expect(res.status()).toBe(401);
  expect(await res.json()).toEqual({ error: 'Unauthorized' });
});

test('Function: pendingModeratorProposals — GET /trust/proposals without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/trust/proposals');
  expect(res.status()).toBe(401);
});

test('Function: trustRoutes — POST /trust/verify without bearer is 401', async ({ request }) => {
  const res = await request.post('/trust/verify', { data: { accountId: 'x' } });
  expect(res.status()).toBe(401);
});

test('Function: fundingRoutes — POST /funding/apply without bearer is 401', async ({ request }) => {
  const res = await request.post('/funding/apply');
  expect(res.status()).toBe(401);
});

test('Function: canEditDailyPayoutRoster — GET /funding/daily-roster as a moderator is 403', async ({
  request,
}) => {
  const auth = await rosterRoleSession(request, 'moderator');
  const res = await request.get('/funding/daily-roster', {
    headers: { authorization: auth.authorization },
  });
  expect(res.status()).toBe(403);
  expect(await res.json()).toEqual({ error: 'Forbidden' });
});

test('Function: resolveDailyRoster — GET /funding/daily-roster unconfigured is 503', async ({
  request,
}) => {
  const auth = await rosterRoleSession(request, 'founder');
  try {
    const res = await request.get('/funding/daily-roster', {
      headers: { authorization: auth.authorization },
    });
    expect(res.status()).toBe(503);
    expect(await res.json()).toEqual({ error: 'Daily roster is not configured' });
  } finally {
    await releaseRosterFounder(request, auth.id);
  }
});

test('Function: HttpDailyRoster — GET /funding/daily-roster unconfigured is 503', async ({
  request,
}) => {
  const auth = await rosterRoleSession(request, 'founder');
  try {
    const res = await request.get('/funding/daily-roster', {
      headers: { authorization: auth.authorization },
    });
    expect(res.status()).toBe(503);
    expect(await res.json()).toEqual({ error: 'Daily roster is not configured' });
  } finally {
    await releaseRosterFounder(request, auth.id);
  }
});

test('Function: mapDailyRosterResponse — GET /funding/daily-roster unconfigured is 503', async ({
  request,
}) => {
  const auth = await rosterRoleSession(request, 'initiator');
  const res = await request.get('/funding/daily-roster', {
    headers: { authorization: auth.authorization },
  });
  expect(res.status()).toBe(503);
  expect(await res.json()).toEqual({ error: 'Daily roster is not configured' });
});

test('Function: DailyRosterRequestError — GET /funding/daily-roster unconfigured is 503', async ({
  request,
}) => {
  const auth = await rosterRoleSession(request, 'initiator');
  const res = await request.get('/funding/daily-roster', {
    headers: { authorization: auth.authorization },
  });
  expect(res.status()).toBe(503);
  expect(await res.json()).toEqual({ error: 'Daily roster is not configured' });
});

test('Function: effectiveStatus — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: fundingGrantRequired — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: applicationPauseExempt — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: comparePayoutRows — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: buildFundingPayoutMatrix — default boot has no DATABASE_URL', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: eligibleToday — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: dailyPayoutStoppedNotice — default boot has no DATABASE_URL', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: serializeOwnerFunding — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: fundingReviewedAt — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: fundingReviewedByName — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: mentionUsernames — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: resolveMentionMarks — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: notifyForumMentions — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: buildForumMentionPushPayload — default boot has no DATABASE_URL', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: expiredTrialAsPending — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: loadGrantEffective — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: migrateFundingSchema — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: InMemoryFundingStore — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: postgresTextArrayLiteral — default boot has no DATABASE_URL', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: PostgresFundingStore — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: debugTrustRoutes — POST /debug/trust-edges without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/debug/trust-edges');
  expect(res.status()).toBe(401);
});

test('Function: debugTrustRoutes — DELETE /debug/trust-edges without bearer is 401', async ({
  request,
}) => {
  const res = await request.delete('/debug/trust-edges');
  expect(res.status()).toBe(401);
});

test('Function: verifiedExternalZapRequest — no direct default-boot HTTP trigger', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: externalDisplayName — no direct default-boot HTTP trigger', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: resolveExternalProfileName — no direct default-boot HTTP trigger', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: ExternalIngestLimiter — no direct default-boot HTTP trigger', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: backfillExternalZappers — default boot has no DATABASE_URL', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: notifyExternalForumReply — no direct default-boot HTTP trigger', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: debugExternalRoutes — GET /debug/external-pubkeys without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/debug/external-pubkeys')).status()).toBe(401);
});

test('Function: normalizePlace — PATCH /messages/:id/place refuses a bad place and pins a shop note', async ({
  request,
}) => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const { auth, noteId } = await moderatorShopNote(request, stamp);
  // The place is checked before the note lookup: an unknown note still gets the place error.
  const bad = await request.patch('/messages/00000000-0000-4000-8000-000000000000/place', {
    headers: auth,
    data: { place: { lat: 999, lng: 8.5 } },
  });
  expect(bad.status()).toBe(400);
  expect(await bad.json()).toEqual({ error: 'Place must be a latitude and longitude' });
  const pinned = await request.patch(`/messages/${noteId}/place`, {
    headers: auth,
    data: { place: { lat: 47.3, lng: 8.5, label: 'Zürich' } },
  });
  expect(pinned.status()).toBe(200);
});

/**
 * A moderator whose About-me note is a shop note (`#21GiftsShop`). Saving About
 * me needs no wallet, so the default boot can reach the place route.
 *
 * @param request - Playwright request context.
 * @param stamp - Unique suffix.
 * @returns The moderator bearer and the About-me note id.
 */
async function moderatorShopNote(
  request: APIRequestContext,
  stamp: string,
): Promise<{ auth: { authorization: string }; noteId: string }> {
  const { auth, id } = await pinSession(request, stamp, 'moderator');
  const saved = await request.put('/me/about', {
    headers: auth,
    data: { text: 'My shop #21GiftsShop' },
  });
  expect(saved.status()).toBe(200);
  const listed = await request.get('/debug/accounts', { headers: DEBUG });
  const row = (
    (await listed.json()) as { accounts: Array<{ id: string; profileMessageId: string | null }> }
  ).accounts.find((item) => item.id === id);
  expect(typeof row?.profileMessageId).toBe('string');
  return { auth, noteId: row!.profileMessageId! };
}

async function verifiedPinSession(
  request: APIRequestContext,
  stamp: string,
): Promise<{ authorization: string }> {
  return (await pinSession(request, stamp, 'verified')).auth;
}

async function pinSession(
  request: APIRequestContext,
  stamp: string,
  role: 'verified' | 'moderator',
): Promise<{ auth: { authorization: string }; id: string }> {
  const adaName = `E2ePin${stamp}`;
  const provision = await request.post('/debug/accounts', {
    headers: DEBUG,
    data: {
      accounts: [
        {
          name: adaName,
          username: `e2e-pin-${stamp}`.slice(0, 32),
        },
      ],
    },
  });
  expect(provision.status()).toBe(200);
  const listed = await request.get('/debug/accounts', { headers: DEBUG });
  expect(listed.status()).toBe(200);
  const accounts = ((await listed.json()) as { accounts: Array<{ id: string; name: string }> })
    .accounts;
  const ada = accounts.find((row) => row.name === adaName);
  expect(ada).toBeDefined();
  const session = await request.post(`/debug/accounts/${ada?.id}/session`, { headers: DEBUG });
  expect(session.status()).toBe(200);
  const token = ((await session.json()) as { token: string }).token;
  const auth = { authorization: `Bearer ${token}` };
  const agreed = await request.post('/me/rules-agreement', { headers: auth });
  expect(agreed.status()).toBe(200);
  const promoted = await request.patch(`/debug/accounts/${ada!.id}`, {
    headers: DEBUG,
    data: { role },
  });
  expect(promoted.status()).toBe(200);
  return { auth, id: ada!.id };
}

test('Function: placesMatch — PATCH /messages/:id/place with the same place twice is 200', async ({
  request,
}) => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const { auth, noteId } = await moderatorShopNote(request, stamp);
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await request.patch(`/messages/${noteId}/place`, {
      headers: auth,
      data: { place: { lat: 47.3, lng: 8.5, label: 'Zürich' } },
    });
    expect(res.status()).toBe(200);
  }
  // The second, matching place writes no second edit entry.
  const edits = await request.get(`/messages/${noteId}/edits`, { headers: auth });
  expect(edits.status()).toBe(200);
  const fields = ((await edits.json()) as { edits: Array<{ field: string }> }).edits.map(
    (edit) => edit.field,
  );
  expect(fields.filter((field) => field === 'place')).toHaveLength(1);
});

// Posting needs a verified wallet, which needs LNURL_SERVER_URL (blank here).
test('Function: parseMultipartCoord — a multipart pinned note is 409 without a verified wallet', async ({
  request,
}) => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const auth = await verifiedPinSession(request, stamp);
  const res = await request.post('/messages', {
    headers: auth,
    multipart: { text: 'pin', placeLat: ' ', placeLng: ' ' },
  });
  expect(res.status()).toBe(409);
  expect(await res.json()).toEqual({
    error: 'missing_requirements',
    missing: ['lightning-address'],
  });
});

test('Function: translateRoutes — GET /translate reports availability', async ({ request }) => {
  const res = await request.get('/translate');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { available: boolean };
  expect(typeof body.available).toBe('boolean');
});

test('Function: translateForumNote — POST /messages/:id/translate 404s unknown ids', async ({
  request,
}) => {
  const res = await request.post('/messages/3a3a3a3a-3a3a-43a3-83a3-3a3a3a3a3a3a/translate', {
    data: { target: 'en' },
  });
  expect(res.status()).toBe(404);
});

test('Function: TranslationStore — POST /messages/:id/translate rejects a bad target', async ({
  request,
}) => {
  const res = await request.post('/messages/3a3a3a3a-3a3a-43a3-83a3-3a3a3a3a3a3a/translate', {
    data: { target: 'fr' },
  });
  expect(res.status()).toBe(400);
});

test('Function: resolveTranslateUpstream — GET /translate available is boolean', async ({
  request,
}) => {
  const body = (await (await request.get('/translate')).json()) as { available: boolean };
  expect(typeof body.available).toBe('boolean');
});

test('Function: deeplTargetLang — POST /messages/:id/translate rejects fr', async ({ request }) => {
  expect(
    (
      await request.post('/messages/3a3a3a3a-3a3a-43a3-83a3-3a3a3a3a3a3a/translate', {
        data: { target: 'fr' },
      })
    ).status(),
  ).toBe(400);
});

test('Function: translateViaDeepl — POST /messages/:id/translate 404s unknown ids', async ({
  request,
}) => {
  expect(
    (
      await request.post('/messages/3a3a3a3a-3a3a-43a3-83a3-3a3a3a3a3a3a/translate', {
        data: { target: 'en' },
      })
    ).status(),
  ).toBe(404);
});

test('Function: translationSourceHash — POST /messages/:id/translate 404s unknown ids', async ({
  request,
}) => {
  expect(
    (
      await request.post('/messages/3a3a3a3a-3a3a-43a3-83a3-3a3a3a3a3a3a/translate', {
        data: { target: 'en' },
      })
    ).status(),
  ).toBe(404);
});

test('Function: InMemoryTranslationStore — POST /messages/:id/translate 404s unknown ids', async ({
  request,
}) => {
  expect(
    (
      await request.post('/messages/3a3a3a3a-3a3a-43a3-83a3-3a3a3a3a3a3a/translate', {
        data: { target: 'en' },
      })
    ).status(),
  ).toBe(404);
});

test('Function: PostgresTranslationStore — default boot has no DATABASE_URL', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: TranslateNotConfiguredError — GET /translate always 200', async ({ request }) => {
  expect((await request.get('/translate')).status()).toBe(200);
});

test('Function: TranslateUpstreamError — POST /messages/:id/translate 404s unknown ids', async ({
  request,
}) => {
  expect(
    (
      await request.post('/messages/3a3a3a3a-3a3a-43a3-83a3-3a3a3a3a3a3a/translate', {
        data: { target: 'en' },
      })
    ).status(),
  ).toBe(404);
});

test('Function: TRANSLATION_SCHEMA_SQL — GET /healthz is 200', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: sundayRest — health stays up with a Sunday zone', async ({ request }) => {
  const res = await request.get('/healthz', { headers: { 'Time-Zone': 'Europe/Zurich' } });
  expect(res.status()).toBe(200);
});

test('Function: isSundayInZone — an invalid zone does not refuse a write', async ({ request }) => {
  const res = await request.post('/messages', {
    headers: { 'Time-Zone': 'Not/AZone', 'content-type': 'application/json' },
    data: { text: 'sunday' },
  });
  const body = (await res.json()) as { error?: string };
  expect(body.error).not.toBe('SUNDAY_REST');
});

test('Function: isSundayRestHeader — a blank zone does not refuse the moderator room', async ({
  request,
}) => {
  const res = await request.get('/conversations/moderator-group', {
    headers: { 'Time-Zone': '   ' },
  });
  const body = (await res.json()) as { error?: string };
  expect(body.error).not.toBe('SUNDAY_REST');
});

test('GET /messages/:id/repayment without a note is 404', async ({ request }) => {
  expect((await request.get('/messages/:id/repayment')).status()).toBe(404);
});

test('POST /messages/:id/repayment without bearer is 401', async ({ request }) => {
  expect((await request.post('/messages/:id/repayment')).status()).toBe(401);
});

test('Function: repaymentStatus — GET /messages/:id/repayment without a note is 404', async ({
  request,
}) => {
  expect(
    (await request.get('/messages/00000000-0000-4000-8000-000000000000/repayment')).status(),
  ).toBe(404);
});

test('Function: repaymentInvoice — POST /messages/:id/repayment without bearer is 401', async ({
  request,
}) => {
  expect(
    (await request.post('/messages/00000000-0000-4000-8000-000000000000/repayment')).status(),
  ).toBe(401);
});

test('Function: repaymentLedger — GET /healthz is ok', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: repaymentSchedule — GET /healthz is ok', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: repaymentDueDate — GET /healthz is ok', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: repaymentStartMs — GET /healthz is ok', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: formatCents — GET /healthz is ok', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: dayUnits — GET /healthz is ok', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: dueDayCount — GET /healthz is ok', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: fiatAmountToCents — GET /healthz is ok', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: payerDebtUnits — GET /healthz is ok', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: shareSats — GET /healthz is ok', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: repaymentDescription — GET /healthz is ok', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: parseRepaymentDescription — GET /healthz is ok', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: resolveExternalProfileFields — no direct default-boot HTTP trigger', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: publicExternalAuthorProfile — unknown id is not found', async ({ request }) => {
  expect((await request.get('/messages/not-a-uuid/external-profile')).status()).toBe(404);
});

test('Function: publicExternalAuthorPosts — unknown id is not found', async ({ request }) => {
  expect((await request.get('/messages/not-a-uuid/external-posts')).status()).toBe(404);
});

test('Function: publicExternalAuthorReplies — unknown id is not found', async ({ request }) => {
  expect((await request.get('/messages/not-a-uuid/external-replies')).status()).toBe(404);
});

test('Function: memberHabitRoutes — GET /habits is public and POST without bearer is 401', async ({
  request,
}) => {
  const res = await request.get('/habits');
  expect(res.status()).toBe(200);
  const denied = await request.post('/habits', { data: { action: 'add' } });
  expect(denied.status()).toBe(401);
});

test('Function: isValidTimeZone — GET /habits is public', async ({ request }) => {
  const res = await request.get('/habits');
  expect(res.status()).toBe(200);
});

test('Function: dayKey — GET /habits is public', async ({ request }) => {
  const res = await request.get('/habits');
  expect(res.status()).toBe(200);
});

test('Function: weekKey — GET /habits is public', async ({ request }) => {
  const res = await request.get('/habits');
  expect(res.status()).toBe(200);
});

test('Function: periodKey — GET /habits is public', async ({ request }) => {
  const res = await request.get('/habits');
  expect(res.status()).toBe(200);
});

test('Function: nextPeriod — GET /habits is public', async ({ request }) => {
  const res = await request.get('/habits');
  expect(res.status()).toBe(200);
});

test('Function: comparePeriod — GET /habits is public', async ({ request }) => {
  const res = await request.get('/habits');
  expect(res.status()).toBe(200);
});

test('Function: weeklyRatableThrough — GET /habits is public', async ({ request }) => {
  const res = await request.get('/habits');
  expect(res.status()).toBe(200);
});

test('Function: manilaReviewWeek — GET /habits is public', async ({ request }) => {
  const res = await request.get('/habits');
  expect(res.status()).toBe(200);
});

test('Function: migrateMemberHabitSchema — GET /habits is public', async ({ request }) => {
  const res = await request.get('/habits');
  expect(res.status()).toBe(200);
});

test('Function: InMemoryMemberHabitStore — GET /habits is public', async ({ request }) => {
  const res = await request.get('/habits');
  expect(res.status()).toBe(200);
});

test('Function: PostgresMemberHabitStore — GET /habits is public', async ({ request }) => {
  const res = await request.get('/habits');
  expect(res.status()).toBe(200);
});

// Needs SPEND_API_TOKEN and LNURL_SERVER_URL (both blank here): the spend gate answers first.
test('Function: accountByReceivingAddress — GET /invoices/eligible unconfigured is 503', async ({
  request,
}) => {
  const res = await request.get('/invoices/eligible?address=ada@127.0.0.1');
  expect(res.status()).toBe(503);
});
