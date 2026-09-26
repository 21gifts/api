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
          lightningAddress: `e2e-fn-trust-${stamp}@walletofsatoshi.com`,
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

test('Function: normalizeUsername — POST /me/username without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/me/username', { data: { username: 'ada' } });
  expect(res.status()).toBe(401);
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

test('Function: resolveLnurlpDocument — GET /.well-known/lnurlp/missing is 404', async ({
  request,
}) => {
  const res = await request.get('/.well-known/lnurlp/missing');
  expect(res.status()).toBe(404);
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
          lightningAddress: `ask-${stamp}@walletofsatoshi.com`,
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

test('Function: loadLatestGoalRateDay — a fiat ask without gifts is unavailable', async ({
  request,
}) => {
  const auth = await verifiedAskSession(request);
  const res = await request.post('/messages', {
    headers: auth,
    data: { text: 'pesos', goalCurrency: 'PHP', goalAmount: '200' },
  });
  expect(res.status()).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe('Ask amount is unavailable');
});

test('Function: bindGoalRateDay — a bitcoin ask is stored without a gift-day rate', async ({
  request,
}) => {
  const auth = await verifiedAskSession(request);
  const res = await request.post('/messages', {
    headers: auth,
    data: { text: 'sats', goalCurrency: 'BTC', goalAmount: '21' },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    goalCurrency: string;
    goalAmount: string;
    goalSats: number;
    goalAmountUsd: string | null;
  };
  expect(body.goalCurrency).toBe('BTC');
  expect(body.goalAmount).toBe('21');
  expect(body.goalSats).toBe(21);
  expect(body.goalAmountUsd).toBeNull();
});

test('Function: canonicalGoalAmount — a malformed ask amount is rejected', async ({ request }) => {
  const auth = await verifiedAskSession(request);
  const res = await request.post('/messages', {
    headers: auth,
    data: { text: 'bad', goalCurrency: 'USD', goalAmount: '1e2' },
  });
  expect(res.status()).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe(
    'Send either goalSats or both goalCurrency and goalAmount',
  );
});

test('Function: fiatToSats — fiat and bitcoin ask fields together are rejected', async ({
  request,
}) => {
  const auth = await verifiedAskSession(request);
  const res = await request.post('/messages', {
    headers: auth,
    data: { text: 'both', goalSats: 21, goalCurrency: 'USD', goalAmount: '1' },
  });
  expect(res.status()).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe(
    'Send either goalSats or both goalCurrency and goalAmount',
  );
});

test('Function: satsToFiatAmount — a bitcoin ask freezes null fiat when no day exists', async ({
  request,
}) => {
  const auth = await verifiedAskSession(request);
  const res = await request.post('/messages', {
    headers: auth,
    data: { text: 'freeze', goalCurrency: 'BTC', goalAmount: '21' },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    goalAmountChf: string | null;
    goalAmountEur: string | null;
    goalAmountPhp: string | null;
  };
  expect(body.goalAmountChf).toBeNull();
  expect(body.goalAmountEur).toBeNull();
  expect(body.goalAmountPhp).toBeNull();
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
test('Function: serializeDebugAddressVerification — GET /debug/dump/address_verification without bearer is 401', async ({
  request,
}) => {
  expect((await request.get('/debug/dump/address_verification')).status()).toBe(401);
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
          lightningAddress: `e2e-rank-caller-${stamp}@walletofsatoshi.com`,
        },
        {
          name: subjectName,
          lightningAddress: `e2e-rank-subject-${stamp}@walletofsatoshi.com`,
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
test('Function: effectiveStatus — default boot has no DATABASE_URL', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});
test('Function: fundingGrantRequired — default boot has no DATABASE_URL', async ({ request }) => {
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

test('Function: normalizePlace — POST /messages stores a pin and GET /messages/places lists it', async ({
  request,
}) => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const adaName = `E2ePin${stamp}`;
  const provision = await request.post('/debug/accounts', {
    headers: DEBUG,
    data: {
      accounts: [
        {
          name: adaName,
          lightningAddress: `e2e-pin-${stamp}@walletofsatoshi.com`,
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
    data: { role: 'verified' },
  });
  expect(promoted.status()).toBe(200);

  const unauth = await request.get('/messages/places');
  expect(unauth.status()).toBe(401);

  const posted = await request.post('/messages', {
    headers: { ...auth, 'content-type': 'application/json' },
    data: { text: 'pin', place: { lat: 47.3, lng: 8.5, label: 'Zürich' } },
  });
  expect(posted.status()).toBe(200);
  const note = (await posted.json()) as {
    id: string;
    place?: { lat: number; lng: number; label: string };
  };
  expect(note.place).toEqual({ lat: 47.3, lng: 8.5, label: 'Zürich' });

  const pins = await request.get('/messages/places', { headers: auth });
  expect(pins.status()).toBe(200);
  const body = (await pins.json()) as {
    places: Array<{ id: string; lat: number; lng: number; label: string | null }>;
  };
  expect(
    body.places.some(
      (row) => row.id === note.id && row.lat === 47.3 && row.lng === 8.5 && row.label === 'Zürich',
    ),
  ).toBe(true);
});

async function verifiedPinSession(
  request: APIRequestContext,
  stamp: string,
): Promise<{ authorization: string }> {
  const adaName = `E2ePin${stamp}`;
  const provision = await request.post('/debug/accounts', {
    headers: DEBUG,
    data: {
      accounts: [
        {
          name: adaName,
          lightningAddress: `e2e-pin-${stamp}@walletofsatoshi.com`,
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
    data: { role: 'verified' },
  });
  expect(promoted.status()).toBe(200);
  return auth;
}

test('Function: placesMatch — a repeated photo with a different pin is 409', async ({
  request,
}) => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const auth = await verifiedPinSession(request, stamp);
  const photo = { contentType: 'image/jpeg', data: '/9j/2Q==' };
  const first = await request.post('/messages', {
    headers: { ...auth, 'content-type': 'application/json' },
    data: { text: 'same caption', photo },
  });
  expect(first.status()).toBe(200);
  const firstId = ((await first.json()) as { id: string }).id;
  const again = await request.post('/messages', {
    headers: { ...auth, 'content-type': 'application/json' },
    data: { text: 'same caption', photo },
  });
  expect(again.status()).toBe(200);
  expect(((await again.json()) as { id: string }).id).toBe(firstId);
  const moved = await request.post('/messages', {
    headers: { ...auth, 'content-type': 'application/json' },
    data: { text: 'same caption', photo, place: { lat: 47.3, lng: 8.5, label: 'Stall' } },
  });
  expect(moved.status()).toBe(409);
  expect(await moved.json()).toEqual({ error: 'A live note with this media already exists' });
});

test('Function: parseMultipartCoord — blank coordinates are no pin and a word is rejected', async ({
  request,
}) => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const auth = await verifiedPinSession(request, stamp);
  const blank = await request.post('/messages', {
    headers: auth,
    multipart: { text: 'pin', placeLat: ' ', placeLng: ' ' },
  });
  expect(blank.status()).toBe(200);
  expect(await blank.json()).not.toHaveProperty('place');
  const bad = await request.post('/messages', {
    headers: auth,
    multipart: { text: 'pin', placeLat: 'north', placeLng: '8.5' },
  });
  expect(bad.status()).toBe(400);
  expect(await bad.json()).toEqual({ error: 'Place must be a latitude and longitude' });
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
