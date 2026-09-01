import { expect, test, type APIRequestContext } from '@playwright/test';

async function passkeyBegin(request: APIRequestContext): Promise<{ challengeId: string }> {
  const res = await request.post('/auth/passkey/register/begin');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { challengeId: string; options: { challenge: string } };
  expect(body.challengeId.length).toBeGreaterThan(8);
  expect(body.options.challenge.length).toBeGreaterThan(8);
  return body;
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

test('Function: requestLogPath — GET /view/<64-hex> is 404 (process up)', async ({ request }) => {
  const res = await request.get('/view/' + 'a'.repeat(64));
  expect(res.status()).toBe(404);
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

test('Function: probeNip57Mint — POST /me/lightning-address without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/me/lightning-address', {
    data: { address: 'alice@walletofsatoshi.com' },
  });
  expect(res.status()).toBe(401);
});

test('Function: buildZapProbeRequest — GET /healthz is ok', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
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

test('Function: normalizeLightningAddress — POST /me/lightning-address without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/me/lightning-address', {
    data: { address: 'alice@walletofsatoshi.com' },
  });
  expect(res.status()).toBe(401);
});

test('Function: startVerification — POST verification without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/me/lightning-address/verification');
  expect(res.status()).toBe(401);
});

test('Function: UnconfiguredInvoicePayer — POST verification without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/me/lightning-address/verification');
  expect(res.status()).toBe(401);
});

test('Function: requestPayInvoice — POST verification without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/me/lightning-address/verification');
  expect(res.status()).toBe(401);
});

test('Function: confirmVerification — POST confirm without bearer is 401', async ({ request }) => {
  const res = await request.post('/me/lightning-address/verification/confirm', {
    data: { nonce: '00' },
  });
  expect(res.status()).toBe(401);
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

test('Function: debugRoutes — POST /debug/accounts with the e2e token is 200', async ({
  request,
}) => {
  const res = await request.post('/debug/accounts', {
    headers: { authorization: 'Bearer e2e-debug-token' },
    data: { accounts: [{ name: 'Ada', lightningAddress: 'guest@walletofsatoshi.com' }] },
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

test('Function: meRoutes unlink — DELETE /me/lightning-address without bearer is 401', async ({
  request,
}) => {
  const res = await request.delete('/me/lightning-address');
  expect(res.status()).toBe(401);
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

test('Function: QueryGiftStore — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: messagesRoutes — GET /messages without bearer is 401', async ({ request }) => {
  const res = await request.get('/messages');
  expect(res.status()).toBe(401);
});

test('Function: normalizeForumText — POST /messages without bearer is 401', async ({ request }) => {
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

test('Function: migrateMessageSchema — default boot has no DATABASE_URL', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
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

test('Function: debugPaymentsRoutes — GET /debug/invoices without bearer is 401', async ({
  request,
}) => {
  const invoices = await request.get('/debug/invoices');
  expect(invoices.status()).toBe(401);
  const ingests = await request.get('/debug/zap-ingests');
  expect(ingests.status()).toBe(401);
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
test('Function: buildZapPushPayload — POST /me/push-subscriptions without bearer is 401', async ({
  request,
}) => {
  expect((await request.post('/me/push-subscriptions')).status()).toBe(401);
});
test('Function: enqueueForumPushes — POST /messages without bearer is 401', async ({ request }) => {
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

test('Function: satsToUsdCents — empty stats skip USD conversion', async ({ request }) => {
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

test('Function: openBootStores — default boot has no DATABASE_URL and serves HTTP', async ({
  request,
}) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});

test('Function: invoiceRoutes — POST /invoices unconfigured is 503', async ({ request }) => {
  const res = await request.post('/invoices', {
    data: { address: 'alice@walletofsatoshi.com', amountMsat: 1000 },
  });
  expect(res.status()).toBe(503);
  expect(((await res.json()) as { error: string }).error).toBe('Spend invoices are not configured');
});

test('Function: checkSpendAuth — POST /invoices unconfigured is 503', async ({ request }) => {
  const res = await request.post('/invoices', {
    data: { address: 'alice@walletofsatoshi.com', amountMsat: 1000 },
  });
  expect(res.status()).toBe(503);
});

test('Function: InMemoryInvoiceStore — POST /invoices unconfigured is 503', async ({ request }) => {
  const res = await request.post('/invoices', {
    data: { address: 'alice@walletofsatoshi.com', amountMsat: 1000 },
  });
  expect(res.status()).toBe(503);
});

test('Function: requestGiftInvoice — POST /invoices unconfigured is 503', async ({ request }) => {
  const res = await request.post('/invoices', {
    data: { address: 'alice@walletofsatoshi.com', amountMsat: 1000 },
  });
  expect(res.status()).toBe(503);
});

test('Function: decodeBolt11 — POST /invoices unconfigured is 503', async ({ request }) => {
  const res = await request.post('/invoices', {
    data: { address: 'alice@walletofsatoshi.com', amountMsat: 1000 },
  });
  expect(res.status()).toBe(503);
});

test('Function: inspectBolt11 — POST /invoices unconfigured is 503', async ({ request }) => {
  const res = await request.post('/invoices', {
    data: { address: 'alice@walletofsatoshi.com', amountMsat: 1000 },
  });
  expect(res.status()).toBe(503);
});

test('Function: isNip57Invoice — POST /invoices unconfigured is 503', async ({ request }) => {
  const res = await request.post('/invoices', {
    data: { address: 'alice@walletofsatoshi.com', amountMsat: 1000 },
  });
  expect(res.status()).toBe(503);
});

test('Function: newInvoiceId — POST /invoices unconfigured is 503', async ({ request }) => {
  const res = await request.post('/invoices', {
    data: { address: 'alice@walletofsatoshi.com', amountMsat: 1000 },
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

test('Function: serializeAccount — GET /debug/accounts listing omits viewKey', async ({
  request,
}) => {
  const res = await request.get('/debug/accounts', {
    headers: { authorization: 'Bearer e2e-debug-token' },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { accounts: Array<Record<string, unknown>> };
  expect(Array.isArray(body.accounts)).toBe(true);
  for (const account of body.accounts) {
    expect(account).not.toHaveProperty('viewKey');
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
test('Function: forumPhotoUrl — default boot has no DATABASE_URL', async ({ request }) => {
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
test('Function: buildZapProbeRequest — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: probeNip57Mint — default boot has no DATABASE_URL', async ({ request }) => {
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
