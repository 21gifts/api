import { expect, type APIRequestContext } from '@playwright/test';

/** Operator headers configured by the Playwright web server. */
export const DEBUG = { authorization: 'Bearer e2e-debug-token' };

/**
 * Create a moderator account and return its authenticated request headers and id.
 *
 * @param request - Playwright request context for the booted API.
 * @param stamp - Unique suffix for the debug account and its username.
 * @returns Bearer headers and the account id of the moderator session.
 */
async function moderatorSession(
  request: APIRequestContext,
  stamp: string,
): Promise<{ auth: { authorization: string }; id: string }> {
  const name = `E2ePin${stamp}`;
  const provision = await request.post('/debug/accounts', {
    headers: DEBUG,
    data: { accounts: [{ name, username: `e2e-pin-${stamp}`.slice(0, 32) }] },
  });
  expect(provision.status()).toBe(200);
  const listed = await request.get('/debug/accounts', { headers: DEBUG });
  expect(listed.status()).toBe(200);
  const accounts = ((await listed.json()) as { accounts: Array<{ id: string; name: string }> })
    .accounts;
  const account = accounts.find((row) => row.name === name);
  expect(account).toBeDefined();
  const id = account?.id ?? '';
  const session = await request.post(`/debug/accounts/${id}/session`, { headers: DEBUG });
  expect(session.status()).toBe(200);
  const token = ((await session.json()) as { token: string }).token;
  const auth = { authorization: `Bearer ${token}` };
  const agreed = await request.post('/me/rules-agreement', { headers: auth });
  expect(agreed.status()).toBe(200);
  const promoted = await request.patch(`/debug/accounts/${id}`, {
    headers: DEBUG,
    data: { role: 'moderator' },
  });
  expect(promoted.status()).toBe(200);
  return { auth, id };
}

/**
 * A moderator whose About-me note holds `text`. Saving About me needs no
 * wallet, so the default boot (no LNURL server, no member can post) can reach
 * the staff routes that pin and assign a shop note.
 *
 * @param request - Playwright request context for the booted API.
 * @param stamp - Unique suffix for the debug account and its username.
 * @param text - About-me text.
 * @returns Bearer headers of the moderator and the About-me note id.
 */
export async function moderatorAboutNote(
  request: APIRequestContext,
  stamp: string,
  text: string,
): Promise<{ auth: { authorization: string }; noteId: string }> {
  const { auth, id } = await moderatorSession(request, stamp);
  const saved = await request.put('/me/about', { headers: auth, data: { text } });
  expect(saved.status()).toBe(200);
  const listed = await request.get('/debug/accounts', { headers: DEBUG });
  expect(listed.status()).toBe(200);
  const row = (
    (await listed.json()) as { accounts: Array<{ id: string; profileMessageId: string | null }> }
  ).accounts.find((item) => item.id === id);
  expect(typeof row?.profileMessageId).toBe('string');
  return { auth, noteId: row?.profileMessageId as string };
}
