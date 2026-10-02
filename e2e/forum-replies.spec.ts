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

/**
 * Save an About-me note for a member (no wallet needed) and return its id.
 *
 * @param request - Playwright request context.
 * @param member - Member id and bearer.
 * @returns The About-me note id.
 */
async function aboutMeNote(
  request: APIRequestContext,
  member: { id: string; auth: { authorization: string } },
): Promise<string> {
  const saved = await request.put('/me/about', {
    headers: member.auth,
    data: { text: 'About me, to be hidden' },
  });
  expect(saved.status()).toBe(200);
  const listed = await request.get('/debug/accounts', { headers: DEBUG });
  expect(listed.status()).toBe(200);
  const row = (
    (await listed.json()) as { accounts: Array<{ id: string; profileMessageId: string | null }> }
  ).accounts.find((item) => item.id === member.id);
  expect(typeof row?.profileMessageId).toBe('string');
  return row!.profileMessageId!;
}

test('Function: markDeleted — DELETE /messages/:id hides the note for a moderator', async ({
  request,
}) => {
  const member = await memberSession(request, 'E2eHide');
  const agreed = await request.post('/me/rules-agreement', { headers: member.auth });
  expect(agreed.status()).toBe(200);
  const noteId = await aboutMeNote(request, member);

  const basisDenied = await request.delete(`/messages/${noteId}`, { headers: member.auth });
  expect(basisDenied.status()).toBe(403);

  await promote(request, member.id, 'moderator');
  const unknown = await request.delete('/messages/00000000-0000-4000-8000-000000000000', {
    headers: member.auth,
  });
  expect(unknown.status()).toBe(404);
  const hidden = await request.delete(`/messages/${noteId}`, { headers: member.auth });
  expect(hidden.status()).toBe(204);
  const staffList = await request.get('/messages/hidden', { headers: member.auth });
  expect(staffList.status()).toBe(200);
  const ids = ((await staffList.json()) as { messages: Array<{ id: string }> }).messages.map(
    (message) => message.id,
  );
  expect(ids).toContain(noteId);
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

test('Function: markUndeleted — POST /debug/messages/:id/restore restores a hidden note', async ({
  request,
}) => {
  const member = await memberSession(request, 'E2eRestore');
  const agreed = await request.post('/me/rules-agreement', { headers: member.auth });
  expect(agreed.status()).toBe(200);
  const noteId = await aboutMeNote(request, member);
  await promote(request, member.id, 'moderator');
  const hidden = await request.delete(`/messages/${noteId}`, { headers: member.auth });
  expect(hidden.status()).toBe(204);

  const restored = await request.post(`/debug/messages/${noteId}/restore`, { headers: DEBUG });
  expect(restored.status()).toBe(204);
  const unknown = await request.post(
    '/debug/messages/00000000-0000-4000-8000-000000000000/restore',
    { headers: DEBUG },
  );
  expect(unknown.status()).toBe(404);
});
