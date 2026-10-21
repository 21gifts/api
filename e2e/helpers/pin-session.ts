import { expect, type APIRequestContext } from '@playwright/test';

/** Operator headers configured by the Playwright web server. */
export const DEBUG = { authorization: 'Bearer e2e-debug-token' };

async function pinSession(
  request: APIRequestContext,
  stamp: string,
  role: 'verified' | 'moderator',
): Promise<{ authorization: string }> {
  const name = `E2ePin${stamp}`;
  const provision = await request.post('/debug/accounts', {
    headers: DEBUG,
    data: {
      accounts: [
        {
          name,
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
    data: { role },
  });
  expect(promoted.status()).toBe(200);
  return auth;
}

/**
 * Create a verified account and return its authenticated request headers.
 *
 * @param request - Playwright request context for the booted API.
 * @param stamp - Unique suffix for the debug account and Lightning Address.
 * @returns Bearer headers for the verified account session.
 */
export async function verifiedPinSession(
  request: APIRequestContext,
  stamp: string,
): Promise<{ authorization: string }> {
  return pinSession(request, stamp, 'verified');
}
