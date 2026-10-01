import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore, type Account, type AccountRole } from '@/lib/auth/store';
import type { ShopNoteRef } from '@/lib/message-store';
import type { PosChargeRef } from '@/lib/pos-store';
import { shopActivityRoutes } from '@/routes/shop-activity';

const NOW_MS = Date.parse('2026-03-15T12:00:00.000Z');
const TODAY = '2026-03-15';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

function account(partial: Pick<Account, 'id' | 'role'> & Partial<Account>): Account {
  return {
    linkingKey: null,
    name: partial.name ?? partial.id,
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    location: null,
    viewKey: `${partial.id.replace(/-/g, '')}${'a'.repeat(64)}`.slice(0, 64),
    createdAt: 1,
    rulesAgreedAt: NOW_MS,
    ...partial,
  };
}

async function staffed(): Promise<InMemoryAuthStore> {
  const store = new InMemoryAuthStore();
  await store.createAccount(account({ id: 'founder', role: 'founder', name: 'Founder' }));
  await store.createAccount(account({ id: 'mod', role: 'moderator', name: 'Mod' }));
  await store.createAccount(account({ id: 'verified', role: 'verified', name: 'Ada' }));
  await store.createAccount(account({ id: 'basis', role: 'basis', name: 'Bob' }));
  await store.createSession({ token: 'founder', accountId: 'founder', createdAt: NOW_MS });
  await store.createSession({ token: 'mod', accountId: 'mod', createdAt: NOW_MS });
  await store.createSession({ token: 'verified', accountId: 'verified', createdAt: NOW_MS });
  await store.createSession({ token: 'basis', accountId: 'basis', createdAt: NOW_MS });
  return store;
}

function mount(
  authStore: InMemoryAuthStore,
  messages: ShopNoteRef[] = [],
  charges: PosChargeRef[] = [],
): Hono {
  return new Hono().route(
    '/shops/activity',
    shopActivityRoutes({
      authStore,
      now: () => NOW_MS,
      messages: { listLiveAssignedShops: () => Promise.resolve(messages) },
      pos: { listCreatedBetween: () => Promise.resolve(charges) },
    }),
  );
}

function get(app: Hono, token: string | undefined): Promise<Response> {
  return Promise.resolve(
    app.request('/shops/activity', {
      method: 'GET',
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    }),
  );
}

describe('GET /shops/activity', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns 401 without a session', async () => {
    const res = await get(mount(await staffed()), undefined);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 for an invalid bearer session', async () => {
    const res = await get(mount(await staffed()), 'missing');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it.each(['verified', 'basis'] as const)(
    'returns 403 for a %s account',
    async (role: AccountRole) => {
      const res = await get(mount(await staffed()), role);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Forbidden' });
    },
  );

  it('returns 200 for a moderator', async () => {
    const res = await get(mount(await staffed()), 'mod');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: Array<{ day: string; shopCount: number }> };
    expect(body.days).toHaveLength(30);
    expect(body.days[29]?.day).toBe(TODAY);
  });

  it('returns 200 for a founder', async () => {
    const res = await get(mount(await staffed()), 'founder');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: Array<{ day: string; shopCount: number }> };
    expect(body.days).toHaveLength(30);
  });

  it('counts two notes sharing one account with a single charge', async () => {
    const notes: ShopNoteRef[] = [
      { id: 'n1', accountId: 'till', text: 'A #21GiftsShop' },
      { id: 'n2', accountId: 'till', text: 'B #21GiftsShop' },
    ];
    const charges: PosChargeRef[] = [{ accountId: 'till', createdAtMs: NOW_MS }];
    const res = await get(mount(await staffed(), notes, charges), 'mod');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: Array<{ day: string; shopCount: number }> };
    expect(body.days).toHaveLength(30);
    expect(body.days[29]).toEqual({ day: TODAY, shopCount: 2 });
    expect(body.days.slice(0, 29).every((row) => row.shopCount === 0)).toBe(true);
  });

  it('counts a note only when the account on the note has the charge', async () => {
    const notes: ShopNoteRef[] = [{ id: 'n1', accountId: 'current', text: 'A #21GiftsShop' }];
    const formerOnly: PosChargeRef[] = [{ accountId: 'former', createdAtMs: NOW_MS }];
    const res = await get(mount(await staffed(), notes, formerOnly), 'mod');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: Array<{ day: string; shopCount: number }> };
    expect(body.days).toHaveLength(30);
    expect(body.days[29]).toEqual({ day: TODAY, shopCount: 0 });
    expect(body.days.slice(0, 29).every((row) => row.shopCount === 0)).toBe(true);

    const charges: PosChargeRef[] = [
      { accountId: 'former', createdAtMs: NOW_MS },
      { accountId: 'current', createdAtMs: NOW_MS },
    ];
    const counted = await get(mount(await staffed(), notes, charges), 'mod');
    expect(counted.status).toBe(200);
    const countedBody = (await counted.json()) as {
      days: Array<{ day: string; shopCount: number }>;
    };
    expect(countedBody.days).toHaveLength(30);
    expect(countedBody.days[29]).toEqual({ day: TODAY, shopCount: 1 });
  });

  it('returns 503 when a store call throws', async () => {
    const app = new Hono().route(
      '/shops/activity',
      shopActivityRoutes({
        authStore: await staffed(),
        now: () => NOW_MS,
        messages: {
          listLiveAssignedShops: () => Promise.reject(new Error('down')),
        },
        pos: { listCreatedBetween: () => Promise.resolve([]) },
      }),
    );
    const res = await get(app, 'mod');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Shop activity is unavailable' });
    const failed = parsedEvents(warn).filter((entry) => entry['event'] === 'shops.activity.failed');
    expect(failed).toHaveLength(1);
    expect(Object.keys(failed[0]!).sort()).toEqual(['event', 'ts']);
  });
});
