import { expect, test } from '@playwright/test';

const OPERATOR = { authorization: 'Bearer e2e-debug-token' };
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

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
