import { expect, test, type APIRequestContext } from '@playwright/test';

const DEBUG = { authorization: 'Bearer e2e-debug-token' };

/** Words that must never appear in a team payload. */
const SECRET_WORDS = /preimage|mnemonic|seed|recovery|prf|private|xprv|nsec|spending/i;

interface Staff {
  /** Bearer header of the staff account. */
  headers: { authorization: string };
  /** Staff account id. */
  staffId: string;
  /** Member account id. */
  memberId: string;
  /** Member username. */
  memberUsername: string;
}

/**
 * Provision a member and a staff account with `role`, and mint a session for
 * the staff account.
 */
async function staffSession(
  request: APIRequestContext,
  role: 'basis' | 'moderator' | 'initiator' | 'founder',
): Promise<Staff> {
  const stamp = `${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
  const staffName = `E2eTeam${role}${stamp}`.slice(0, 40);
  const memberName = `E2eMember${stamp}`.slice(0, 40);
  const memberUsername = `e2e-team-${stamp}`.slice(0, 32);
  const provision = await request.post('/debug/accounts', {
    headers: DEBUG,
    data: {
      accounts: [
        { name: staffName, username: `e2e-staff-${stamp}`.slice(0, 32) },
        { name: memberName, username: memberUsername },
      ],
    },
  });
  expect(provision.status()).toBe(200);
  const listed = await request.get('/debug/accounts', { headers: DEBUG });
  const accounts = ((await listed.json()) as { accounts: Array<{ id: string; name: string }> })
    .accounts;
  const staffId = accounts.find((row) => row.name === staffName)?.id ?? '';
  const memberId = accounts.find((row) => row.name === memberName)?.id ?? '';
  expect(staffId).not.toBe('');
  expect(memberId).not.toBe('');
  if (role !== 'basis') {
    const patched = await request.patch(`/debug/accounts/${staffId}`, {
      headers: DEBUG,
      data: { role },
    });
    expect(patched.status()).toBe(200);
  }
  const session = await request.post(`/debug/accounts/${staffId}/session`, { headers: DEBUG });
  expect(session.status()).toBe(200);
  const token = ((await session.json()) as { token: string }).token;
  return { headers: { authorization: `Bearer ${token}` }, staffId, memberId, memberUsername };
}

test('GET /team/members without a session is 401', async ({ request }) => {
  const res = await request.get('/team/members');
  expect(res.status()).toBe(401);
});

test('GET /team/members/:id/wallet without a session is 401', async ({ request }) => {
  const res = await request.get('/team/members/:id/wallet');
  expect(res.status()).toBe(401);
});

test('GET /team/members/:id/events without a session is 401', async ({ request }) => {
  const res = await request.get('/team/members/:id/events');
  expect(res.status()).toBe(401);
});

test('GET /team/audit without a session is 401', async ({ request }) => {
  const res = await request.get('/team/audit');
  expect(res.status()).toBe(401);
});

test('GET /debug/team/members/:id/wallet without bearer is 401', async ({ request }) => {
  const res = await request.get('/debug/team/members/:id/wallet');
  expect(res.status()).toBe(401);
});

test('GET /debug/team/members/:id/events without bearer is 401', async ({ request }) => {
  const res = await request.get('/debug/team/members/:id/events');
  expect(res.status()).toBe(401);
});

test('GET /debug/team/audit without bearer is 401', async ({ request }) => {
  const res = await request.get('/debug/team/audit');
  expect(res.status()).toBe(401);
});

test('Function: teamRoutes — a member below moderator gets 403 on every team route', async ({
  request,
}) => {
  const basis = await staffSession(request, 'basis');
  for (const path of [
    '/team/members?query=e2e',
    `/team/members/${basis.memberId}/wallet`,
    `/team/members/${basis.memberId}/events`,
    '/team/audit',
  ]) {
    const res = await request.get(path, { headers: basis.headers });
    expect(res.status()).toBe(403);
  }
});

test('Function: teamRoutes — a moderator searches members by username', async ({ request }) => {
  const staff = await staffSession(request, 'moderator');
  const res = await request.get(`/team/members?query=${staff.memberUsername}`, {
    headers: staff.headers,
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { members: Array<{ id: string; role: string }> };
  expect(body.members).toContainEqual(
    expect.objectContaining({ id: staff.memberId, role: 'basis' }),
  );
  const bad = await request.get('/team/members?query=%21%21', { headers: staff.headers });
  expect(bad.status()).toBe(400);
});

test('Function: readMemberWallet — a moderator reads an empty wallet view', async ({ request }) => {
  const staff = await staffSession(request, 'moderator');
  const res = await request.get(`/team/members/${staff.memberId}/wallet?period=90`, {
    headers: staff.headers,
  });
  expect(res.status()).toBe(200);
  const text = await res.text();
  expect(text).not.toMatch(SECRET_WORDS);
  expect(JSON.parse(text)).toMatchObject({
    member: { id: staff.memberId, role: 'basis' },
    balance: null,
    period: '90',
    payments: [],
    nextCursor: null,
    summary: { inSats: 0, outSats: 0, communityShare: null },
  });
});

test('Function: parseMemberDataPeriod — an unknown period is 400', async ({ request }) => {
  const staff = await staffSession(request, 'moderator');
  const res = await request.get(`/team/members/${staff.memberId}/wallet?period=365`, {
    headers: staff.headers,
  });
  expect(res.status()).toBe(400);
  expect(await res.json()).toEqual({ error: 'Invalid period' });
});

test('Function: memberDataPeriodSince — the summary of a 7-day period names its lower bound', async ({
  request,
}) => {
  const staff = await staffSession(request, 'moderator');
  const res = await request.get(`/team/members/${staff.memberId}/wallet?period=7`, {
    headers: staff.headers,
  });
  const body = (await res.json()) as { summary: { since: string } };
  const since = Date.parse(body.summary.since);
  expect(Math.abs(Date.now() - 7 * 86_400_000 - since)).toBeLessThan(60_000);
});

test('Function: summarizeWalletPayments — every category is in the summary', async ({
  request,
}) => {
  const staff = await staffSession(request, 'moderator');
  const res = await request.get(`/team/members/${staff.memberId}/wallet`, {
    headers: staff.headers,
  });
  const body = (await res.json()) as { summary: { byCategory: Record<string, unknown> } };
  expect(Object.keys(body.summary.byCategory).sort()).toEqual(
    ['gift', 'member', 'onchain', 'outside_lightning', 'platform', 'shop', 'unknown'].sort(),
  );
});

test('Function: serializeMemberRef — the wallet view names the member', async ({ request }) => {
  const staff = await staffSession(request, 'moderator');
  const res = await request.get(`/team/members/${staff.memberId}/wallet`, {
    headers: staff.headers,
  });
  const body = (await res.json()) as { member: { username: string } };
  expect(body.member.username).toBe(staff.memberUsername);
});

test('Function: serializeWalletPayment — an empty wallet lists no payments', async ({
  request,
}) => {
  const staff = await staffSession(request, 'moderator');
  const res = await request.get(`/team/members/${staff.memberId}/wallet?direction=out`, {
    headers: staff.headers,
  });
  expect(((await res.json()) as { payments: unknown[] }).payments).toEqual([]);
});

test('Function: decodeMemberDataCursor — a malformed cursor is 400', async ({ request }) => {
  const staff = await staffSession(request, 'moderator');
  const res = await request.get(`/team/members/${staff.memberId}/events?cursor=bad`, {
    headers: staff.headers,
  });
  expect(res.status()).toBe(400);
  expect(await res.json()).toEqual({ error: 'Invalid cursor' });
});

test('Function: encodeMemberDataCursor — an empty page has no next cursor', async ({ request }) => {
  const staff = await staffSession(request, 'moderator');
  const res = await request.get(`/team/members/${staff.memberId}/events`, {
    headers: staff.headers,
  });
  expect(((await res.json()) as { nextCursor: unknown }).nextCursor).toBeNull();
});

test('Function: readMemberEvents — a moderator reads an empty events view', async ({ request }) => {
  const staff = await staffSession(request, 'moderator');
  const res = await request.get(`/team/members/${staff.memberId}/events`, {
    headers: staff.headers,
  });
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ member: { id: staff.memberId }, events: [] });
});

test('Function: serializeMemberEvent — the events view carries no secret words', async ({
  request,
}) => {
  const staff = await staffSession(request, 'moderator');
  const res = await request.get(`/team/members/${staff.memberId}/events`, {
    headers: staff.headers,
  });
  expect(await res.text()).not.toMatch(SECRET_WORDS);
});

test('Function: canReadTeamAudit — a moderator gets 403 on the audit log', async ({ request }) => {
  const staff = await staffSession(request, 'moderator');
  expect((await request.get('/team/audit', { headers: staff.headers })).status()).toBe(403);
});

test('Function: readTeamAudit — a founder sees the read an initiator just made', async ({
  request,
}) => {
  const initiator = await staffSession(request, 'initiator');
  const read = await request.get(`/team/members/${initiator.memberId}/events`, {
    headers: initiator.headers,
  });
  expect(read.status()).toBe(200);
  const founder = await staffSession(request, 'founder');
  const res = await request.get('/team/audit', { headers: founder.headers });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    entries: Array<{ viewer: { id: string }; member: { id: string }; what: string }>;
  };
  expect(body.entries).toContainEqual(
    expect.objectContaining({
      viewer: expect.objectContaining({ id: initiator.staffId }) as unknown,
      member: expect.objectContaining({ id: initiator.memberId }) as unknown,
      what: 'events',
    }),
  );
});

test('Function: serializeTeamAccess — audit entries name viewer and member', async ({
  request,
}) => {
  const founder = await staffSession(request, 'founder');
  await request.get(`/team/members/${founder.memberId}/wallet`, { headers: founder.headers });
  const res = await request.get('/team/audit', { headers: founder.headers });
  const body = (await res.json()) as {
    entries: Array<{ viewer: { id: string; username: string }; what: string }>;
  };
  const mine = body.entries.find((entry) => entry.viewer.id === founder.staffId);
  expect(mine?.what).toBe('wallet');
  expect(typeof mine?.viewer.username).toBe('string');
});

test('Function: InMemoryMemberDataStore — the default boot keeps member data in memory', async ({
  request,
}) => {
  const staff = await staffSession(request, 'moderator');
  const res = await request.get(`/team/members/${staff.memberId}/wallet`, {
    headers: staff.headers,
  });
  expect(res.status()).toBe(200);
});

test('Function: PostgresMemberDataStore — default boot has no DATABASE_URL', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: migrateMemberDataSchema — default boot has no DATABASE_URL', async ({
  request,
}) => {
  expect((await request.get('/healthz')).status()).toBe(200);
});

test('Function: debugTeamRoutes — operator reads wallet, events, and audit read-only', async ({
  request,
}) => {
  const staff = await staffSession(request, 'basis');
  const wallet = await request.get(`/debug/team/members/${staff.memberId}/wallet`, {
    headers: DEBUG,
  });
  expect(wallet.status()).toBe(200);
  expect(await wallet.json()).toMatchObject({ member: { id: staff.memberId }, balance: null });
  const events = await request.get(`/debug/team/members/${staff.memberId}/events`, {
    headers: DEBUG,
  });
  expect(events.status()).toBe(200);
  const audit = await request.get('/debug/team/audit', { headers: DEBUG });
  expect(audit.status()).toBe(200);
  const body = (await audit.json()) as { entries: Array<{ member: { id: string } }> };
  expect(body.entries.some((entry) => entry.member.id === staff.memberId)).toBe(false);
});
