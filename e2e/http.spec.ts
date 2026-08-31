import { expect, test } from '@playwright/test';

test('GET /healthz is ok', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { status: string };
  expect(body.status).toBe('ok');
});

test('GET /info names the service', async ({ request }) => {
  const res = await request.get('/info');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { service: string };
  expect(body.service).toBe('21gifts-api');
});

test('GET /favicon.ico is an image', async ({ request }) => {
  const res = await request.get('/favicon.ico');
  expect(res.status()).toBe(200);
  const contentType = res.headers()['content-type'] ?? '';
  expect(contentType.startsWith('image/x-icon')).toBe(true);
  const cacheControl = res.headers()['cache-control'] ?? '';
  expect(cacheControl).toMatch(/public/);
  expect(cacheControl).toMatch(/max-age=86400/);
});

test('GET /favicon.svg is svg', async ({ request }) => {
  const res = await request.get('/favicon.svg');
  expect(res.status()).toBe(200);
  const contentType = res.headers()['content-type'] ?? '';
  expect(contentType.startsWith('image/svg+xml')).toBe(true);
  const cacheControl = res.headers()['cache-control'] ?? '';
  expect(cacheControl).toMatch(/public/);
  expect(cacheControl).toMatch(/max-age=86400/);
});

test('GET /apple-touch-icon.png is png', async ({ request }) => {
  const res = await request.get('/apple-touch-icon.png');
  expect(res.status()).toBe(200);
  const contentType = res.headers()['content-type'] ?? '';
  expect(contentType.startsWith('image/png')).toBe(true);
  const cacheControl = res.headers()['cache-control'] ?? '';
  expect(cacheControl).toMatch(/public/);
  expect(cacheControl).toMatch(/max-age=86400/);
});

test('GET /auth/lnurl is gone', async ({ request }) => {
  const res = await request.get('/auth/lnurl');
  expect(res.status()).toBe(404);
});

test('GET /auth/session is gone', async ({ request }) => {
  const res = await request.get('/auth/session');
  expect(res.status()).toBe(404);
});

test('POST /auth/passkey/register/begin issues a challenge', async ({ request }) => {
  const res = await request.post('/auth/passkey/register/begin');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { challengeId: string; options: unknown };
  expect(body.challengeId.length).toBeGreaterThan(8);
  expect(body.options).toBeTruthy();
});

test('GET /me without bearer is 401', async ({ request }) => {
  const res = await request.get('/me');
  expect(res.status()).toBe(401);
});

test('GET /view/not-a-key is 404', async ({ request }) => {
  const res = await request.get('/view/not-a-key');
  expect(res.status()).toBe(404);
});

test('GET /view/:viewKey is 404 on default boot', async ({ request }) => {
  const res = await request.get('/view/:viewKey');
  expect(res.status()).toBe(404);
});

test('GET /view/<64-hex> is 404 on default boot', async ({ request }) => {
  const res = await request.get('/view/' + 'a'.repeat(64));
  expect(res.status()).toBe(404);
});

test('GET /messages without bearer is 401', async ({ request }) => {
  const res = await request.get('/messages');
  expect(res.status()).toBe(401);
});

test('GET /messages/:id without bearer is 404 on default boot', async ({ request }) => {
  const res = await request.get('/messages/:id');
  expect(res.status()).toBe(404);
});

test('GET /messages/:id/replies without bearer is 401', async ({ request }) => {
  const res = await request.get('/messages/:id/replies');
  expect(res.status()).toBe(401);
});

test('POST /messages without bearer is 401', async ({ request }) => {
  const res = await request.post('/messages', {
    data: { text: 'hi' },
  });
  expect(res.status()).toBe(401);
});

test('POST /messages/:id/invoice without bearer is 401', async ({ request }) => {
  const res = await request.post('/messages/:id/invoice', { data: { sats: 21 } });
  expect(res.status()).toBe(401);
});

test('POST /contact without bearer is 401', async ({ request }) => {
  const res = await request.post('/contact', {
    data: { text: 'hi' },
  });
  expect(res.status()).toBe(401);
});

test('GET /conversations without bearer is 401', async ({ request }) => {
  const res = await request.get('/conversations');
  expect(res.status()).toBe(401);
});

test('POST /conversations without bearer is 401', async ({ request }) => {
  const res = await request.post('/conversations', {
    data: { forumMessageId: '00000000-0000-0000-0000-000000000001' },
  });
  expect(res.status()).toBe(401);
});

test('GET /conversations/:id without bearer is 401', async ({ request }) => {
  const res = await request.get('/conversations/:id');
  expect(res.status()).toBe(401);
});

test('POST /conversations/:id without bearer is 401', async ({ request }) => {
  const res = await request.post('/conversations/:id', {
    data: { text: 'hi' },
  });
  expect(res.status()).toBe(401);
});

test('POST /messages with a photo without bearer is 401', async ({ request }) => {
  const res = await request.post('/messages', {
    data: {
      photo: { contentType: 'image/jpeg', data: '/9j/4AAQ' },
    },
  });
  expect(res.status()).toBe(401);
  expect(await res.json()).toEqual({ error: 'Unauthorized' });
});

test('GET /messages/:id/photo without bearer is 404', async ({ request }) => {
  const res = await request.get('/messages/:id/photo');
  expect(res.status()).toBe(404);
});

test('GET /messages/:id/photo UUID path without bearer is 404', async ({ request }) => {
  const res = await request.get('/messages/00000000-0000-0000-0000-000000000000/photo');
  expect(res.status()).toBe(404);
});
test('GET /messages/:id/photo.jpg UUID path without bearer is 404', async ({ request }) => {
  const res = await request.get('/messages/:id/photo.jpg');
  expect(res.status()).toBe(404);
});
test('GET /messages/:id/photo.jpeg without bearer is 404', async ({ request }) => {
  const res = await request.get('/messages/:id/photo.jpeg');
  expect(res.status()).toBe(404);
});
test('GET /messages/:id/photo.png without bearer is 404', async ({ request }) => {
  const res = await request.get('/messages/:id/photo.png');
  expect(res.status()).toBe(404);
});
test('GET /messages/:id/photo.webp without bearer is 404', async ({ request }) => {
  const res = await request.get('/messages/:id/photo.webp');
  expect(res.status()).toBe(404);
});
test('GET /messages/:id/video.mp4 without bearer is 404', async ({ request }) => {
  const res = await request.get('/messages/:id/video.mp4');
  expect(res.status()).toBe(404);
});
test('GET /messages/:id/video.webm without bearer is 404', async ({ request }) => {
  const res = await request.get('/messages/:id/video.webm');
  expect(res.status()).toBe(404);
});
test('GET /messages/:id/video.mov without bearer is 404', async ({ request }) => {
  const res = await request.get('/messages/:id/video.mov');
  expect(res.status()).toBe(404);
});
test('GET /.well-known/nostr.json is 200', async ({ request }) => {
  const res = await request.get('/.well-known/nostr.json');
  expect(res.status()).toBe(200);
});

test('POST /me/name without bearer is 401', async ({ request }) => {
  const res = await request.post('/me/name', {
    data: { name: 'Ada' },
  });
  expect(res.status()).toBe(401);
});

test('POST /me/forum-laws-dismissed without bearer is 401', async ({ request }) => {
  const res = await request.post('/me/forum-laws-dismissed');
  expect(res.status()).toBe(401);
});

test('POST /me/rules-agreement without bearer is 401', async ({ request }) => {
  const res = await request.post('/me/rules-agreement');
  expect(res.status()).toBe(401);
});

test('POST /me/lightning-address without bearer is 401', async ({ request }) => {
  const res = await request.post('/me/lightning-address', {
    data: { address: 'a@b.com' },
  });
  expect(res.status()).toBe(401);
});

test('DELETE /me/lightning-address without bearer is 401', async ({ request }) => {
  const res = await request.delete('/me/lightning-address');
  expect(res.status()).toBe(401);
});

test('POST /me/lightning-address/verification without bearer is 401', async ({ request }) => {
  const res = await request.post('/me/lightning-address/verification');
  expect(res.status()).toBe(401);
});

test('POST /me/lightning-address/verification/confirm without bearer is 401', async ({
  request,
}) => {
  const res = await request.post('/me/lightning-address/verification/confirm', {
    data: { nonce: '00' },
  });
  expect(res.status()).toBe(401);
});

test('GET /debug/accounts without bearer is 401', async ({ request }) => {
  const res = await request.get('/debug/accounts');
  expect(res.status()).toBe(401);
});

test('POST /debug/accounts without bearer is 401', async ({ request }) => {
  const res = await request.post('/debug/accounts', {
    data: { accounts: [{ name: 'Ada', lightningAddress: 'guest@walletofsatoshi.com' }] },
  });
  expect(res.status()).toBe(401);
});

test('POST /debug/accounts with the e2e token provisions a guest', async ({ request }) => {
  const res = await request.post('/debug/accounts', {
    headers: { authorization: 'Bearer e2e-debug-token' },
    data: { accounts: [{ name: 'Ada', lightningAddress: 'guest@walletofsatoshi.com' }] },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    accounts: Array<{ name: string; lightningAddress: string; viewKey: string; created: boolean }>;
  };
  expect(body.accounts).toHaveLength(1);
  expect(body.accounts[0]?.name).toBe('Ada');
  expect(body.accounts[0]?.viewKey).toMatch(/^[0-9a-f]{64}$/);
});

test('GET /debug/accounts with the e2e token lists accounts', async ({ request }) => {
  const res = await request.get('/debug/accounts', {
    headers: { authorization: 'Bearer e2e-debug-token' },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { accounts: unknown[] };
  expect(Array.isArray(body.accounts)).toBe(true);
});

test('PATCH /debug/accounts/:id without bearer is 401', async ({ request }) => {
  const res = await request.patch('/debug/accounts/:id', {
    data: { role: 'basis' },
  });
  expect(res.status()).toBe(401);
});

test('GET /debug/contacts without bearer is 401', async ({ request }) => {
  const res = await request.get('/debug/contacts');
  expect(res.status()).toBe(401);
});

test('GET /debug/contacts with the e2e token lists contacts', async ({ request }) => {
  const res = await request.get('/debug/contacts', {
    headers: { authorization: 'Bearer e2e-debug-token' },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { contacts: unknown[] };
  expect(Array.isArray(body.contacts)).toBe(true);
});

test('GET /lightning-address without address is 400', async ({ request }) => {
  const res = await request.get('/lightning-address');
  expect(res.status()).toBe(400);
});

test('GET /gifts without a day is 400', async ({ request }) => {
  const res = await request.get('/gifts');
  expect(res.status()).toBe(400);
});

test('GET /gifts/stats is empty without a database', async ({ request }) => {
  const res = await request.get('/gifts/stats');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toEqual({
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
    fx: { quote: 'BTC-USD', dayBasis: 'utc', source: 'coinbase-exchange-daily-close' },
  });
});

test('GET /gifts/stats?recipient=alice is empty without a database', async ({ request }) => {
  const res = await request.get('/gifts/stats?recipient=alice');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toEqual({
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
    fx: { quote: 'BTC-USD', dayBasis: 'utc', source: 'coinbase-exchange-daily-close' },
  });
});

test('POST /auth/passkey/register/begin issues options', async ({ request }) => {
  const res = await request.post('/auth/passkey/register/begin');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { challengeId: string; options: { challenge: string } };
  expect(body.challengeId.length).toBeGreaterThan(8);
  expect(body.options.challenge.length).toBeGreaterThan(8);
});

test('POST /auth/passkey/register/finish without body is 400', async ({ request }) => {
  const res = await request.post('/auth/passkey/register/finish');
  expect(res.status()).toBe(400);
});

test('POST /auth/passkey/authenticate/begin issues options', async ({ request }) => {
  const res = await request.post('/auth/passkey/authenticate/begin');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { challengeId: string };
  expect(body.challengeId.length).toBeGreaterThan(8);
});

test('POST /auth/passkey/authenticate/finish without body is 400', async ({ request }) => {
  const res = await request.post('/auth/passkey/authenticate/finish');
  expect(res.status()).toBe(400);
});

test('POST /invoices unconfigured is 503', async ({ request }) => {
  const res = await request.post('/invoices', {
    data: { address: 'alice@walletofsatoshi.com', amountMsat: 1000 },
  });
  expect(res.status()).toBe(503);
});

test('POST /invoices/proof unconfigured is 503', async ({ request }) => {
  const res = await request.post('/invoices/proof', {
    data: { id: 'x', preimage: '11'.repeat(32) },
  });
  expect(res.status()).toBe(503);
});

test('GET /push/vapid-public without bearer is 401', async ({ request }) => {
  const res = await request.get('/push/vapid-public');
  expect(res.status()).toBe(401);
});

test('POST /me/push-subscriptions without bearer is 401', async ({ request }) => {
  const res = await request.post('/me/push-subscriptions');
  expect(res.status()).toBe(401);
});

test('DELETE /me/push-subscriptions without bearer is 401', async ({ request }) => {
  const res = await request.delete('/me/push-subscriptions');
  expect(res.status()).toBe(401);
});

test('POST /debug/push-ping without bearer is 401', async ({ request }) => {
  const res = await request.post('/debug/push-ping');
  expect(res.status()).toBe(401);
});

test('POST /debug/push-ping with the e2e token and no VAPID is 503', async ({ request }) => {
  const res = await request.post('/debug/push-ping', {
    headers: { authorization: 'Bearer e2e-debug-token' },
    data: { accountId: '00000000-0000-0000-0000-000000000001' },
  });
  expect(res.status()).toBe(503);
});
