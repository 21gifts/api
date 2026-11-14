import { expect, test, type APIRequestContext } from '@playwright/test';

test('Function: activeShopDays — GET /shops/activity without bearer is 200', async ({
  request,
}) => {
  const res = await request.get('/shops/activity');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { days: unknown[] };
  expect(body.days).toHaveLength(30);
});

test('Function: shopActivityRoutes — GET /shops/activity without bearer is 200', async ({
  request,
}) => {
  const res = await request.get('/shops/activity');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { days: unknown[] };
  expect(body.days).toHaveLength(30);
});

const DEBUG = { authorization: 'Bearer e2e-debug-token' };

type ListedShopRow = {
  noteId: string;
  name: string;
  npub: string | null;
  accountId: string;
  username: string | null;
  activeDays: number;
  lastChargeDay: string | null;
};

/**
 * Provision accounts through the debug routes and return them by name.
 *
 * @param request - Playwright request context.
 * @param rows - Accounts to create.
 * @returns Created accounts with ids and usernames.
 */
async function provision(
  request: APIRequestContext,
  rows: Array<{ name: string; username: string }>,
): Promise<Array<{ id: string; name: string; username: string | null }>> {
  expect(
    (await request.post('/debug/accounts', { headers: DEBUG, data: { accounts: rows } })).status(),
  ).toBe(200);
  const listed = (await (await request.get('/debug/accounts', { headers: DEBUG })).json()) as {
    accounts: Array<{ id: string; name: string; username: string | null }>;
  };
  return rows.map((row) => listed.accounts.find((account) => account.name === row.name)!);
}

/**
 * Bearer header of a fresh session for one account.
 *
 * @param request - Playwright request context.
 * @param accountId - Account to sign in.
 * @returns The `authorization` header.
 */
async function sessionOf(
  request: APIRequestContext,
  accountId: string,
): Promise<{ authorization: string }> {
  const minted = await request.post(`/debug/accounts/${accountId}/session`, { headers: DEBUG });
  expect(minted.status()).toBe(200);
  return { authorization: `Bearer ${((await minted.json()) as { token: string }).token}` };
}

/**
 * A moderator whose About-me note is a `#21GiftsShop` note with a pin and a
 * till account, and that moderator's session.
 *
 * @param request - Playwright request context.
 * @returns The staff header and the expected list row.
 */
async function shopWithTill(
  request: APIRequestContext,
): Promise<{ staff: { authorization: string }; row: ListedShopRow }> {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 8)}`;
  const [author, till] = await provision(request, [
    { name: `E2eActMod${stamp}`, username: `e2e-actmod-${stamp}`.slice(0, 32) },
    { name: `E2eActTill${stamp}`, username: `e2e-acttill-${stamp}`.slice(0, 32) },
  ]);
  const staff = await sessionOf(request, author!.id);
  expect((await request.post('/me/rules-agreement', { headers: staff })).status()).toBe(200);
  expect(
    (
      await request.patch(`/debug/accounts/${author!.id}`, {
        headers: DEBUG,
        data: { role: 'moderator' },
      })
    ).status(),
  ).toBe(200);
  const saved = await request.put('/me/about', {
    headers: staff,
    data: { text: `Coffee served at the bar every morning.\n\n#21GiftsShop` },
  });
  expect(saved.status()).toBe(200);
  const accounts = (await (await request.get('/debug/accounts', { headers: DEBUG })).json()) as {
    accounts: Array<{ id: string; profileMessageId: string | null }>;
  };
  const noteId = accounts.accounts.find((row) => row.id === author!.id)!.profileMessageId!;
  const name = `Activity Cafe ${stamp}`;
  expect(
    (
      await request.patch(`/messages/${noteId}/place`, {
        headers: staff,
        data: {
          place: {
            lat: 47.3769,
            lng: 8.5417,
            label: name,
            address: {
              street: 'Bahnhofstrasse',
              houseNumber: '1',
              postalCode: '8001',
              city: 'Zürich',
              country: 'CH',
            },
          },
        },
      })
    ).status(),
  ).toBe(200);
  const assigned = await request.patch(`/messages/${noteId}/shop-account`, {
    headers: staff,
    data: { username: till!.username },
  });
  expect(assigned.status()).toBe(200);
  const { shopNpub } = (await assigned.json()) as { shopNpub: string | null };
  return {
    staff,
    row: {
      noteId,
      name,
      npub: shopNpub,
      accountId: till!.id,
      username: till!.username,
      activeDays: 0,
      lastChargeDay: null,
    },
  };
}

test('GET /shops/activity/shops without bearer is 401', async ({ request }) => {
  const res = await request.get('/shops/activity/shops');
  expect(res.status()).toBe(401);
  expect(await res.json()).toEqual({ error: 'Unauthorized' });
});

test('Function: requireStaff — GET /shops/activity/shops is 403 for a basis session and 200 for a moderator', async ({
  request,
}) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 8)}`;
  const [member] = await provision(request, [
    { name: `E2eActBasis${stamp}`, username: `e2e-actbasis-${stamp}`.slice(0, 32) },
  ]);
  const basis = await request.get('/shops/activity/shops', {
    headers: await sessionOf(request, member!.id),
  });
  expect(basis.status()).toBe(403);
  expect(await basis.json()).toEqual({ error: 'Forbidden' });
  const { staff } = await shopWithTill(request);
  expect((await request.get('/shops/activity/shops', { headers: staff })).status()).toBe(200);
});

test('Function: activeShops — GET /shops/activity/shops lists a shop note with no till charge', async ({
  request,
}) => {
  const { staff, row } = await shopWithTill(request);
  const res = await request.get('/shops/activity/shops', { headers: staff });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { shops: ListedShopRow[] };
  expect(body.shops.filter((shop) => shop.noteId === row.noteId)).toEqual([row]);
});

test('Function: activeShopList — GET /shops/activity/shops names the shop and its till', async ({
  request,
}) => {
  const { staff, row } = await shopWithTill(request);
  const res = await request.get('/shops/activity/shops', { headers: staff });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    windowDays: number;
    today: string;
    shops: ListedShopRow[];
  };
  expect(body.windowDays).toBe(30);
  expect(body.today).toBe(new Date().toISOString().slice(0, 10));
  const listed = body.shops.find((shop) => shop.noteId === row.noteId);
  expect(listed).toEqual(row);
  expect(row.npub).toMatch(/^npub1[02-9ac-hj-np-z]{58}$/);
  const firstUsed = body.shops.findIndex((shop) => shop.lastChargeDay !== null);
  expect(firstUsed === -1 || body.shops.indexOf(listed!) < firstUsed).toBe(true);
});
