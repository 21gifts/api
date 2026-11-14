import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore, type Account, type AccountRole } from '@/lib/auth/store';
import type { MessageRow } from '@/lib/message';
import type { ShopNoteRef } from '@/lib/message-store';
import { InMemoryPosStore, type PosChargeRef } from '@/lib/pos-store';
import { shopNpub, type ShopIdentityRow } from '@/lib/shop-identity';
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
      messages: {
        listLiveAssignedShops: () => Promise.resolve(messages),
        getByIds: () => Promise.resolve([]),
      },
      pos: {
        listCreatedBetween: () => Promise.resolve(charges),
        listLatestCreatedByAccount: () => Promise.resolve([]),
      },
      identities: { listAll: () => Promise.resolve([]) },
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

  it('returns 200 without a session', async () => {
    const res = await get(mount(await staffed()), undefined);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: Array<{ day: string; shopCount: number }> };
    expect(body.days).toHaveLength(30);
  });

  it('returns 200 for an invalid bearer session', async () => {
    const res = await get(mount(await staffed()), 'missing');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: Array<{ day: string; shopCount: number }> };
    expect(body.days).toHaveLength(30);
  });

  it.each(['verified', 'basis'] as const)(
    'returns 200 for a %s account',
    async (role: AccountRole) => {
      const res = await get(mount(await staffed()), role);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { days: Array<{ day: string; shopCount: number }> };
      expect(body.days).toHaveLength(30);
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
          getByIds: () => Promise.resolve([]),
        },
        pos: {
          listCreatedBetween: () => Promise.resolve([]),
          listLatestCreatedByAccount: () => Promise.resolve([]),
        },
        identities: { listAll: () => Promise.resolve([]) },
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

type ShopRow = {
  noteId: string;
  name: string;
  npub: string | null;
  accountId: string;
  username: string | null;
  activeDays: number;
  lastChargeDay: string | null;
};

type ListBody = { windowDays: number; today: string; shops: ShopRow[] };

const PUBKEY = 'a'.repeat(64);

function identity(messageId: string): ShopIdentityRow {
  return { messageId, nostrPubkey: PUBKEY } as ShopIdentityRow;
}

function noteRow(id: string, label: string): MessageRow {
  return {
    id,
    place: { lat: 47, lng: 8, label, address: null },
  } as MessageRow;
}

interface ListFixture {
  notes?: ShopNoteRef[];
  charges?: PosChargeRef[];
  latest?: PosChargeRef[];
  rows?: MessageRow[];
  identities?: ShopIdentityRow[];
  failing?: 'notes' | 'charges' | 'latest' | 'rows' | 'identities' | 'accounts';
}

function mountList(authStore: InMemoryAuthStore, fixture: ListFixture = {}): Hono {
  const fail = (key: ListFixture['failing']): Promise<never> | undefined =>
    fixture.failing === key ? Promise.reject(new Error('down')) : undefined;
  if (fixture.failing === 'accounts') {
    vi.spyOn(authStore, 'getAccounts').mockRejectedValue(new Error('down'));
  }
  return new Hono().route(
    '/shops/activity',
    shopActivityRoutes({
      authStore,
      now: () => NOW_MS,
      messages: {
        listLiveAssignedShops: () => fail('notes') ?? Promise.resolve(fixture.notes ?? []),
        getByIds: () => fail('rows') ?? Promise.resolve(fixture.rows ?? []),
      },
      pos: {
        listCreatedBetween: () => fail('charges') ?? Promise.resolve(fixture.charges ?? []),
        listLatestCreatedByAccount: () => fail('latest') ?? Promise.resolve(fixture.latest ?? []),
      },
      identities: {
        listAll: () => fail('identities') ?? Promise.resolve(fixture.identities ?? []),
      },
    }),
  );
}

function getList(app: Hono, token: string | undefined): Promise<Response> {
  return Promise.resolve(
    app.request('/shops/activity/shops', {
      method: 'GET',
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    }),
  );
}

describe('GET /shops/activity/shops', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it.each([undefined, 'missing'])('returns 401 for bearer %s', async (token) => {
    const res = await getList(mountList(await staffed()), token);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it.each(['verified', 'basis'])('returns 403 for a %s account', async (token) => {
    const res = await getList(mountList(await staffed()), token);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it.each(['mod', 'founder'])('returns 200 for %s', async (token) => {
    const res = await getList(mountList(await staffed()), token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ windowDays: 30, today: TODAY, shops: [] });
  });

  it('lists every active shop with its details, zero-charge shops first', async () => {
    const authStore = await staffed();
    await authStore.createAccount(account({ id: 'till', role: 'verified', username: 'cafe' }));
    await authStore.createAccount(account({ id: 'idle', role: 'basis' }));
    const notes: ShopNoteRef[] = [
      { id: 'n1', accountId: 'till', text: 'Cafe #21GiftsShop' },
      { id: 'n1', accountId: 'till', text: 'Cafe #21GiftsShop' },
      { id: 'n2', accountId: 'idle', text: 'Bakery #21GiftsShop' },
      { id: 'n3', accountId: 'till', text: 'No tag' },
    ];
    const app = mountList(authStore, {
      notes,
      charges: [
        { accountId: 'till', createdAtMs: NOW_MS },
        { accountId: 'till', createdAtMs: Date.parse('2026-02-14T00:00:00.000Z') },
      ],
      latest: [{ accountId: 'till', createdAtMs: NOW_MS }],
      rows: [noteRow('n1', 'Corner Cafe'), { id: 'n2' } as MessageRow],
      identities: [identity('n1')],
    });
    const res = await getList(app, 'mod');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body).toEqual({
      windowDays: 30,
      today: TODAY,
      shops: [
        {
          noteId: 'n2',
          name: 'Bakery',
          npub: null,
          accountId: 'idle',
          username: null,
          activeDays: 0,
          lastChargeDay: null,
        },
        {
          noteId: 'n1',
          name: 'Corner Cafe',
          npub: shopNpub({ nostrPubkey: PUBKEY }),
          accountId: 'till',
          username: 'cafe',
          activeDays: 2,
          lastChargeDay: TODAY,
        },
      ],
    });
  });

  it('reports lastChargeDay from a charge before the window', async () => {
    const app = mountList(await staffed(), {
      notes: [{ id: 'n1', accountId: 'till', text: 'Cafe #21GiftsShop' }],
      latest: [{ accountId: 'till', createdAtMs: Date.parse('2025-01-02T03:00:00.000Z') }],
    });
    const body = (await (await getList(app, 'mod')).json()) as ListBody;
    expect(body.shops[0]).toMatchObject({ activeDays: 0, lastChargeDay: '2025-01-02' });
  });

  it('asks the stores for each active shop note and account once', async () => {
    const pos = new InMemoryPosStore();
    const latestSpy = vi.spyOn(pos, 'listLatestCreatedByAccount');
    const authStore = await staffed();
    const accountsSpy = vi.spyOn(authStore, 'getAccounts');
    const getByIds = vi.fn((_ids: readonly string[]) => Promise.resolve([] as MessageRow[]));
    const app = new Hono().route(
      '/shops/activity',
      shopActivityRoutes({
        authStore,
        now: () => NOW_MS,
        messages: {
          listLiveAssignedShops: () =>
            Promise.resolve([
              { id: 'n1', accountId: 'till', text: 'A #21GiftsShop' },
              { id: 'n1', accountId: 'till', text: 'A #21GiftsShop' },
              { id: 'n2', accountId: 'till', text: 'B #21GiftsShop' },
            ]),
          getByIds,
        },
        pos,
        identities: { listAll: () => Promise.resolve([]) },
      }),
    );
    const res = await getList(app, 'mod');
    expect(res.status).toBe(200);
    expect(getByIds).toHaveBeenCalledWith(['n1', 'n2']);
    expect(latestSpy).toHaveBeenCalledWith(['till']);
    expect(accountsSpy).toHaveBeenCalledWith(['till']);
  });

  it.each(['notes', 'charges', 'latest', 'rows', 'identities', 'accounts'] as const)(
    'returns 503 when the %s read throws',
    async (failing) => {
      const app = mountList(await staffed(), {
        notes: [{ id: 'n1', accountId: 'till', text: 'Cafe #21GiftsShop' }],
        failing,
      });
      const res = await getList(app, 'mod');
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Shop activity is unavailable' });
      const failed = parsedEvents(warn).filter(
        (entry) => entry['event'] === 'shops.activity.list.failed',
      );
      expect(failed).toHaveLength(1);
      expect(Object.keys(failed[0]!).sort()).toEqual(['event', 'ts']);
    },
  );

  it('does not read the stores for a 403', async () => {
    const listLiveAssignedShops = vi.fn(() => Promise.resolve([] as ShopNoteRef[]));
    const app = new Hono().route(
      '/shops/activity',
      shopActivityRoutes({
        authStore: await staffed(),
        now: () => NOW_MS,
        messages: { listLiveAssignedShops, getByIds: () => Promise.resolve([]) },
        pos: new InMemoryPosStore(),
        identities: { listAll: () => Promise.resolve([]) },
      }),
    );
    expect((await getList(app, 'basis')).status).toBe(403);
    expect(listLiveAssignedShops).not.toHaveBeenCalled();
  });
});
