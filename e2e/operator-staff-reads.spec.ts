import { expect, test, type APIRequestContext } from '@playwright/test';

const OPERATOR = { authorization: 'Bearer e2e-debug-token' };
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

async function staffSession(
  request: APIRequestContext,
): Promise<{ id: string; authorization: string }> {
  const name = `E2eDbStaff${Date.now()}`;
  await request.post('/debug/accounts', {
    headers: OPERATOR,
    data: { accounts: [{ name }] },
  });
  const accounts = (
    (await (await request.get('/debug/accounts', { headers: OPERATOR })).json()) as {
      accounts: Array<{ id: string; name: string }>;
    }
  ).accounts;
  const account = accounts.find((row) => row.name === name)!;
  await request.patch(`/debug/accounts/${account.id}`, {
    headers: OPERATOR,
    data: { role: 'software_developer' },
  });
  const minted = await request.post(`/debug/accounts/${account.id}/session`, {
    headers: OPERATOR,
  });
  const token = ((await minted.json()) as { token: string }).token;
  return { id: account.id, authorization: `Bearer ${token}` };
}

test('Function: isOperatorBearer — DEBUG_TOKEN reads the staff GETs without a session', async ({
  request,
}) => {
  for (const path of [
    '/funding/payout-days',
    '/funding/applications',
    '/funding/daily-roster',
    '/funding/daily-roster/links',
    '/trust/proposals',
    '/messages/hidden',
  ]) {
    const res = await request.get(path, { headers: OPERATOR });
    expect(res.status(), path).toBe(200);
  }
  for (const path of [
    `/funding/applications/${UNKNOWN_ID}`,
    `/members/${UNKNOWN_ID}/activity`,
    `/messages/${UNKNOWN_ID}/edits`,
  ]) {
    const res = await request.get(path, { headers: OPERATOR });
    expect(res.status(), path).toBe(404);
  }
});

test('Function: isOperatorBearer — a wrong bearer still gets 401 on the staff GETs', async ({
  request,
}) => {
  for (const path of [
    '/funding/payout-days',
    '/funding/applications',
    '/funding/daily-roster',
    '/funding/daily-roster/links',
    '/trust/proposals',
    '/messages/hidden',
    `/members/${UNKNOWN_ID}/activity`,
    `/messages/${UNKNOWN_ID}/edits`,
  ]) {
    const res = await request.get(path, { headers: { authorization: 'Bearer not-a-token' } });
    expect(res.status(), path).toBe(401);
  }
});

test('GET /debug/db accepts a software-developer session for wallet reads', async ({ request }) => {
  const staff = await staffSession(request);
  const res = await request.get('/debug/db', {
    headers: { authorization: staff.authorization },
  });
  // The default Playwright boot has no DATABASE_URL; 503 proves the session
  // passed authorization and reached the database availability check.
  expect(res.status()).toBe(503);
  expect(await res.json()).toEqual({ error: 'Database is not configured' });
});
