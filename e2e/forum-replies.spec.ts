import { expect, test, type APIRequestContext } from '@playwright/test';

const DEBUG = { authorization: 'Bearer e2e-debug-token' };

/**
 * Provision one member through the debug route and mint a session.
 *
 * The default boot has no LNURL server, so the member has no verified wallet:
 * reading the forum works, posting answers `missing: ['lightning-address']`.
 */
async function memberSession(
  request: APIRequestContext,
  prefix: string,
): Promise<{ id: string; name: string; username: string; auth: { authorization: string } }> {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const name = `${prefix}${stamp.slice(0, 8)}`;
  const username = `${prefix.toLowerCase()}-${stamp}`.slice(0, 32);
  const provision = await request.post('/debug/accounts', {
    headers: DEBUG,
    data: { accounts: [{ name, username }] },
  });
  expect(provision.status()).toBe(200);
  const listed = await request.get('/debug/accounts', { headers: DEBUG });
  expect(listed.status()).toBe(200);
  const accounts = ((await listed.json()) as { accounts: Array<{ id: string; name: string }> })
    .accounts;
  const row = accounts.find((item) => item.name === name);
  expect(row).toBeDefined();
  const session = await request.post(`/debug/accounts/${row?.id}/session`, { headers: DEBUG });
  expect(session.status()).toBe(200);
  const token = ((await session.json()) as { token: string }).token;
  return { id: row!.id, name, username, auth: { authorization: `Bearer ${token}` } };
}

/**
 * Promote an account through the debug route.
 *
 * @param request - Playwright request context.
 * @param accountId - Account id.
 * @param role - New role.
 */
async function promote(
  request: APIRequestContext,
  accountId: string,
  role: 'verified' | 'moderator',
): Promise<void> {
  const promoted = await request.patch(`/debug/accounts/${accountId}`, {
    headers: DEBUG,
    data: { role },
  });
  expect(promoted.status()).toBe(200);
}

test.describe.configure({ mode: 'serial' });

test('e2e: a member without a verified wallet reads the forum but cannot post', async ({
  request,
}) => {
  const member = await memberSession(request, 'E2eAda');
  const agreed = await request.post('/me/rules-agreement', { headers: member.auth });
  expect(agreed.status()).toBe(200);
  await promote(request, member.id, 'verified');

  const me = await request.get('/me', { headers: member.auth });
  expect(me.status()).toBe(200);
  const owner = (await me.json()) as {
    lightningAddress: string | null;
    lightningAddressVerified: boolean;
    missing: string[];
  };
  expect(owner.lightningAddress).toBeNull();
  expect(owner.lightningAddressVerified).toBe(false);
  expect(owner.missing).toEqual(['lightning-address']);

  const posted = await request.post('/messages', {
    headers: { ...member.auth, 'content-type': 'application/json' },
    data: { text: 'e2e parent note' },
  });
  expect(posted.status()).toBe(409);
  expect(await posted.json()).toEqual({
    error: 'missing_requirements',
    missing: ['lightning-address'],
  });

  const list = await request.get('/messages', { headers: member.auth });
  expect(list.status()).toBe(200);

  const pay = await request.get(`/pay/${member.username}`);
  expect(pay.status()).toBe(404);
});

test('Function: issueSession — POST /debug/accounts/:id/session with the e2e token is 200', async ({
  request,
}) => {
  const member = await memberSession(request, 'E2eSess');
  const me = await request.get('/me', { headers: member.auth });
  expect(me.status()).toBe(200);
});

test('Function: markDeleted — DELETE /messages/:id of an unknown note is 404 for a moderator', async ({
  request,
}) => {
  const member = await memberSession(request, 'E2eHide');
  const agreed = await request.post('/me/rules-agreement', { headers: member.auth });
  expect(agreed.status()).toBe(200);
  const missing = '00000000-0000-4000-8000-000000000000';

  const basisDenied = await request.delete(`/messages/${missing}`, { headers: member.auth });
  expect(basisDenied.status()).toBe(403);

  await promote(request, member.id, 'moderator');
  const unknown = await request.delete(`/messages/${missing}`, { headers: member.auth });
  expect(unknown.status()).toBe(404);
});

test('Function: listHidden — GET /messages/hidden is 200 for a moderator', async ({ request }) => {
  const member = await memberSession(request, 'E2eHidden');
  const agreed = await request.post('/me/rules-agreement', { headers: member.auth });
  expect(agreed.status()).toBe(200);
  await promote(request, member.id, 'moderator');

  const staffList = await request.get('/messages/hidden', { headers: member.auth });
  expect(staffList.status()).toBe(200);
  const hiddenBody = (await staffList.json()) as { messages: unknown[] };
  expect(Array.isArray(hiddenBody.messages)).toBe(true);
});

test('Function: markUndeleted — POST /debug/messages/:id/restore of an unknown note is 404', async ({
  request,
}) => {
  const restored = await request.post(
    '/debug/messages/00000000-0000-4000-8000-000000000000/restore',
    {
      headers: DEBUG,
    },
  );
  expect(restored.status()).toBe(404);
});
