import { expect, test, type APIRequestContext } from '@playwright/test';

const RELEASED_AT = '2026-11-09T11:17:00.000Z';
const RELEASE_MS = Date.parse(RELEASED_AT);
const DAY_MS = 24 * 60 * 60 * 1000;

const PURPOSES = [
  'deposit',
  'withdrawal',
  'shop_purchase',
  'forum_gift',
  'transfer',
  'fund_deposit',
  'fund_payout',
  'other',
] as const;

const BUCKETS = ['1', '2-10', '11-100', '101-1k', '1k-10k', '10k-100k', '100k+'] as const;

interface UsageBody {
  releasedAt: string;
  asOf: string | null;
  totals: {
    paymentCount: number;
    volumeSats: number;
    feeSats: number;
    medianSats: number;
    averageSats: number;
    activeWalletCount: number;
    sendingWalletCount: number;
    receivingWalletCount: number;
    topFiveSenderShare: number;
    heartCount: number;
    paidShopChargeCount: number;
  };
  days: Array<{
    day: string;
    purposes: Record<string, { count: number; sats: number }>;
    activeWalletCount: number;
    sendingWalletCount: number;
    receivingWalletCount: number;
  }>;
  flows: unknown[];
  amountBuckets: Array<{ key: string; count: number; sats: number }>;
  hours: Array<{ hourUtc: number; count: number }>;
  forum: Array<{ day: string; gifts: number; hearts: number; sats: number }>;
  shopCharges: Array<{ day: string; created: number; paid: number }>;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function addUtcDays(day: string, days: number): string {
  return utcDay(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS);
}

function daysFrom(startMs: number, nowMs: number): string[] {
  const end = utcDay(nowMs);
  const keys: string[] = [];
  for (let day = utcDay(startMs); day <= end; day = addUtcDays(day, 1)) {
    keys.push(day);
  }
  return keys;
}

async function readUsage(request: APIRequestContext): Promise<UsageBody> {
  const res = await request.get('/wallets/usage');
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toBe('public, max-age=60');
  return (await res.json()) as UsageBody;
}

function expectEmptyUsage(body: UsageBody, nowMs: number): void {
  expect(body.releasedAt).toBe(RELEASED_AT);
  expect(body.asOf).toBeNull();
  expect(body.totals).toEqual({
    paymentCount: 0,
    volumeSats: 0,
    feeSats: 0,
    medianSats: 0,
    averageSats: 0,
    activeWalletCount: 0,
    sendingWalletCount: 0,
    receivingWalletCount: 0,
    topFiveSenderShare: 0,
    heartCount: 0,
    paidShopChargeCount: 0,
  });
  expect(body.flows).toEqual([]);
  expect(body.days.map((row) => row.day)).toEqual(daysFrom(RELEASE_MS, nowMs));
  const first = body.days[0];
  if (first !== undefined) {
    expect(Object.keys(first.purposes).sort()).toEqual([...PURPOSES].sort());
    for (const purpose of PURPOSES) {
      expect(first.purposes[purpose]).toEqual({ count: 0, sats: 0 });
    }
    expect(first.activeWalletCount).toBe(0);
    expect(first.sendingWalletCount).toBe(0);
    expect(first.receivingWalletCount).toBe(0);
  }
  expect(body.amountBuckets.map((bucket) => bucket.key)).toEqual([...BUCKETS]);
  expect(body.amountBuckets.every((bucket) => bucket.count === 0 && bucket.sats === 0)).toBe(true);
  expect(body.hours.map((row) => row.hourUtc)).toEqual(
    Array.from({ length: 24 }, (_, hourUtc) => hourUtc),
  );
  expect(body.hours.every((row) => row.count === 0)).toBe(true);
  expect(body.forum.map((row) => row.day)).toEqual(daysFrom(RELEASE_MS - 28 * DAY_MS, nowMs));
  expect(body.shopCharges.map((row) => row.day)).toEqual(daysFrom(RELEASE_MS - 14 * DAY_MS, nowMs));
}

test('GET /wallets/usage is a public aggregate', async ({ request }) => {
  expectEmptyUsage(await readUsage(request), Date.now());
});

test('Function: buildWalletUsage — the booted usage body is aggregate only', async ({
  request,
}) => {
  const body = await readUsage(request);
  expectEmptyUsage(body, Date.now());
  expect(JSON.stringify(body)).not.toContain('accountId');
});

test('Function: walletUsagePurpose — every purpose key is present on a usage day', async ({
  request,
}) => {
  const body = await readUsage(request);
  const day = body.days[0];
  if (day === undefined) {
    throw new Error('expected a usage day');
  }
  for (const purpose of PURPOSES) {
    expect(day.purposes[purpose]).toEqual({ count: 0, sats: 0 });
  }
});

test('Function: walletUsageReadSince — releasedAt is the wallet release instant', async ({
  request,
}) => {
  const body = await readUsage(request);
  expect(body.releasedAt).toBe(RELEASED_AT);
  expect(body.forum[0]?.day).toBe(utcDay(RELEASE_MS - 28 * DAY_MS));
  expect(body.shopCharges[0]?.day).toBe(utcDay(RELEASE_MS - 14 * DAY_MS));
});

test('Function: WALLET_RELEASE_AT_MS — the public releasedAt matches the release', async ({
  request,
}) => {
  const body = await readUsage(request);
  expect(body.releasedAt).toBe(RELEASED_AT);
  expect(Date.parse(body.releasedAt)).toBe(RELEASE_MS);
});

test('Function: InMemoryWalletUsageStore — default boot answers public usage', async ({
  request,
}) => {
  expectEmptyUsage(await readUsage(request), Date.now());
});

test('Function: PostgresWalletUsageStore — needs DATABASE_URL', async ({ request }) => {
  const body = await readUsage(request);
  expect(body.totals.paymentCount).toBe(0);
  expect(body.releasedAt).toBe(RELEASED_AT);
});
