import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import { createApp } from '@/server';

const now = (): number => 1_700_000_000_000;
const AUTH = { authorization: 'Bearer tok' };
const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VIEW_KEY = 'b'.repeat(64);
const EMPTY = {
  donatedSats: 0,
  receivedSats: 0,
  donatedOverTime: [],
  receivedOverTime: [],
  fx: {
    quote: 'BTC-USD',
    dayBasis: 'utc',
    source: 'coinbase-exchange-daily-close',
  },
};

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

async function seedSession(
  overrides: { rulesAgreedAt?: number | null; viewKey?: string } = {},
): Promise<InMemoryAuthStore> {
  const store = new InMemoryAuthStore();
  await store.createAccount({
    id: 'acc',
    linkingKey: null,
    role: 'basis',
    name: 'Ada',
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    viewKey: overrides.viewKey ?? 'a'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: overrides.rulesAgreedAt === undefined ? now() : overrides.rulesAgreedAt,
  });
  await store.createSession({ token: 'tok', accountId: 'acc', createdAt: now() });
  return store;
}

async function seedMember(
  authStore: InMemoryAuthStore,
  extra: { sats?: number } = {},
): Promise<InMemoryMessageStore> {
  await authStore.createAccount({
    id: ACCOUNT_ID,
    linkingKey: null,
    role: 'basis',
    name: 'Ada',
    lightningAddress: 'ada@walletofsatoshi.com',
    lightningAddressVerified: true,
    forumLawsDismissed: false,
    viewKey: VIEW_KEY,
    createdAt: now(),
    rulesAgreedAt: now(),
  });
  return new InMemoryMessageStore([
    {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      accountId: ACCOUNT_ID,
      name: 'Ada',
      text: 'Ada',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      sats: extra.sats ?? 0,
    },
  ]);
}

describe('account activity routes', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('GET /me/activity returns 401 without a bearer', async () => {
    const res = await createApp({ now }).request('/me/activity');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('GET /me/activity returns empty activity for a seeded session', async () => {
    const authStore = await seedSession();
    const res = await createApp({ authStore, now }).request('/me/activity', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(EMPTY);
  });

  it('GET /members/:accountId/activity returns 401 without a bearer', async () => {
    const res = await createApp({ now }).request(`/members/${ACCOUNT_ID}/activity`);
    expect(res.status).toBe(401);
  });

  it('GET /members/:accountId/activity returns 409 when the caller lacks rules', async () => {
    const authStore = await seedSession({ rulesAgreedAt: null });
    const res = await createApp({ authStore, now }).request(`/members/${ACCOUNT_ID}/activity`, {
      headers: AUTH,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'missing_requirements',
      missing: ['rules'],
    });
  });

  it('GET /members/:accountId/activity returns 404 for a non-uuid id', async () => {
    const authStore = await seedSession();
    const res = await createApp({ authStore, now }).request('/members/not-a-uuid/activity', {
      headers: AUTH,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('GET /members/:accountId/activity returns 404 when the account is unknown', async () => {
    const authStore = await seedSession();
    const res = await createApp({ authStore, now }).request(`/members/${ACCOUNT_ID}/activity`, {
      headers: AUTH,
    });
    expect(res.status).toBe(404);
  });

  it('GET /members/:accountId/activity returns 200 empty activity', async () => {
    const authStore = await seedSession();
    const messageStore = await seedMember(authStore);
    const res = await createApp({ authStore, messageStore, now }).request(
      `/members/${ACCOUNT_ID}/activity`,
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual(EMPTY);
    expect(JSON.stringify(body)).not.toMatch(/nsec|paymentHash|invoice/i);
  });

  it('GET /view/:viewKey/activity returns 404 for a short key', async () => {
    const res = await createApp({ now }).request('/view/abcd/activity');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('GET /view/:viewKey/activity returns 404 for an unknown key', async () => {
    const res = await createApp({ now }).request(`/view/${VIEW_KEY}/activity`);
    expect(res.status).toBe(404);
  });

  it('GET /view/:viewKey/activity returns 200 for a seeded view key', async () => {
    const authStore = await seedSession();
    const messageStore = await seedMember(authStore);
    const res = await createApp({ authStore, messageStore, now }).request(
      `/view/${VIEW_KEY}/activity`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(EMPTY);
  });

  it('GET /members/:accountId/activity returns 503 when a remainder day has no FX rate', async () => {
    const authStore = await seedSession();
    const messageStore = await seedMember(authStore, { sats: 21 });
    const res = await createApp({ authStore, messageStore, now }).request(
      `/members/${ACCOUNT_ID}/activity`,
      { headers: AUTH },
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Gift stats are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'account.activity.fx_incomplete')).toBe(
      true,
    );
  });

  it('GET /view/:viewKey/activity returns 503 when a remainder day has no FX rate', async () => {
    const authStore = await seedSession();
    const messageStore = await seedMember(authStore, { sats: 21 });
    const res = await createApp({ authStore, messageStore, now }).request(
      `/view/${VIEW_KEY}/activity`,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Gift stats are unavailable' });
  });

  it('GET /members/:accountId/activity returns 503 when the gift store throws', async () => {
    const authStore = await seedSession();
    await seedMember(authStore);
    const giftStore = {
      listOutbound: async () => {
        throw new Error('boom');
      },
    };
    const res = await createApp({ authStore, giftStore, now }).request(
      `/members/${ACCOUNT_ID}/activity`,
      { headers: AUTH },
    );
    expect(res.status).toBe(503);
    expect(parsedEvents(warn).some((e) => e['event'] === 'account.activity.failed')).toBe(true);
  });

  it('GET /view/:viewKey/activity returns 503 when the gift store throws', async () => {
    const authStore = await seedSession();
    await seedMember(authStore);
    const giftStore = {
      listOutbound: async () => {
        throw new Error('boom');
      },
    };
    const res = await createApp({ authStore, giftStore, now }).request(
      `/view/${VIEW_KEY}/activity`,
    );
    expect(res.status).toBe(503);
    expect(parsedEvents(warn).some((e) => e['event'] === 'account.activity.failed')).toBe(true);
  });

  it('GET /me/activity returns 503 when the gift store throws', async () => {
    const authStore = await seedSession();
    const giftStore = {
      listOutbound: async () => {
        throw new Error('boom');
      },
    };
    const res = await createApp({ authStore, giftStore, now }).request('/me/activity', {
      headers: AUTH,
    });
    expect(res.status).toBe(503);
    expect(parsedEvents(warn).some((e) => e['event'] === 'account.activity.failed')).toBe(true);
  });

  it('returns 503 when a remainder day has no FX rate', async () => {
    const authStore = await seedSession();
    const messageStore = new InMemoryMessageStore([
      {
        id: 'cccccccccccccccc-cccc-4ccc-8ccc-cccccccccccc'.slice(0, 36),
        accountId: 'acc',
        name: 'Ada',
        text: 'note',
        createdAt: new Date(now()),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        sats: 21,
      },
    ]);
    const res = await createApp({ authStore, messageStore, now }).request('/me/activity', {
      headers: AUTH,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Gift stats are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'account.activity.fx_incomplete')).toBe(
      true,
    );
  });
});
