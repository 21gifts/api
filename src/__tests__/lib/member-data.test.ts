import { describe, expect, it } from 'vitest';
import { InMemoryAuthStore, type AccountRole } from '@/lib/auth/store';
import { encodeMessageFeedCursor } from '@/lib/message';
import {
  COMMUNITY_CATEGORIES,
  decodeMemberDataCursor,
  DEFAULT_MEMBER_DATA_PERIOD,
  encodeMemberDataCursor,
  MEMBER_EVENT_PAGE_LIMIT,
  MEMBER_PAYMENT_PAGE_LIMIT,
  memberDataPeriodSince,
  OUTSIDE_CATEGORIES,
  parseMemberDataPeriod,
  readMemberEvents,
  readMemberWallet,
  readTeamAudit,
  serializeMemberEvent,
  serializeMemberRef,
  serializeTeamAccess,
  serializeWalletPayment,
  summarizeWalletPayments,
  TEAM_AUDIT_PAGE_LIMIT,
} from '@/lib/member-data';
import {
  InMemoryMemberDataStore,
  type MemberEventRow,
  type WalletPaymentRow,
} from '@/lib/member-data-store';

const NOW = Date.UTC(2026, 9, 7);
const MEMBER = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const VIEWER = '33333333-3333-4333-8333-333333333333';
const GONE = '44444444-4444-4444-8444-444444444444';

/** Words that must never appear in a team payload. */
const SECRET_WORDS = /preimage|mnemonic|seed|recovery|prf|private|xprv|nsec|spending/i;

async function accounts(): Promise<InMemoryAuthStore> {
  const store = new InMemoryAuthStore();
  const add = async (id: string, name: string, role: AccountRole, username?: string) => {
    await store.createAccount({
      id,
      linkingKey: null,
      role,
      name,
      forumLawsDismissed: false,
      location: null,
      viewKey: id.replaceAll('-', '').padEnd(64, '0'),
      createdAt: NOW,
      rulesAgreedAt: NOW,
      ...(username === undefined ? {} : { username }),
    });
  };
  await add(MEMBER, 'Mia', 'basis', 'mia');
  await add(PEER, 'Pia', 'verified', 'pia');
  await add(VIEWER, 'Vera', 'moderator');
  return store;
}

function payment(overrides: Partial<WalletPaymentRow> = {}): WalletPaymentRow {
  return {
    accountId: MEMBER,
    paymentId: 'p1',
    direction: 'out',
    status: 'completed',
    amountSats: 100,
    feeSats: 1,
    paidAt: new Date(NOW - 60_000),
    method: 'lightning',
    paymentHash: 'ab'.repeat(32),
    invoice: 'lnbc1test',
    destination: 'pia@21.gifts',
    description: 'bread',
    lnurlComment: 'thanks',
    category: 'member',
    counterpartyAccountId: PEER,
    firstSeenAt: new Date(NOW - 50_000),
    updatedAt: new Date(NOW - 40_000),
    ...overrides,
  };
}

function event(overrides: Partial<MemberEventRow> = {}): MemberEventRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    accountId: MEMBER,
    name: 'screen_view',
    at: new Date(NOW - 60_000),
    path: '/forum',
    props: {},
    receivedAt: new Date(NOW - 50_000),
    ...overrides,
  };
}

describe('periods', () => {
  it('parses the four periods and defaults to 30', () => {
    expect(parseMemberDataPeriod(undefined)).toBe(DEFAULT_MEMBER_DATA_PERIOD);
    expect(DEFAULT_MEMBER_DATA_PERIOD).toBe('30');
    for (const value of ['7', '30', '90', 'all']) {
      expect(parseMemberDataPeriod(value)).toBe(value);
    }
    expect(parseMemberDataPeriod('365')).toBeNull();
    expect(parseMemberDataPeriod('')).toBeNull();
  });

  it('computes the lower bound', () => {
    expect(memberDataPeriodSince('all', NOW)).toBeNull();
    expect(memberDataPeriodSince('7', NOW)?.getTime()).toBe(NOW - 7 * 86_400_000);
    expect(memberDataPeriodSince('90', NOW)?.getTime()).toBe(NOW - 90 * 86_400_000);
  });
});

describe('cursors', () => {
  it('round-trips a cursor and lowercases a UUID id', () => {
    const at = new Date(NOW);
    const raw = encodeMemberDataCursor({ at, id: 'AB-1' });
    expect(decodeMemberDataCursor(raw, false)).toEqual({ at, id: 'AB-1' });
    const upper = encodeMemberDataCursor({ at, id: MEMBER.toUpperCase() });
    expect(decodeMemberDataCursor(upper, true)).toEqual({ at, id: MEMBER });
  });

  it('rejects malformed, popular-feed, empty-id, and non-UUID cursors', () => {
    expect(decodeMemberDataCursor('not-a-cursor', false)).toBeNull();
    expect(
      decodeMemberDataCursor(
        encodeMessageFeedCursor({ k: 's', s: 1, c: new Date(NOW).toISOString(), i: 'x' }),
        false,
      ),
    ).toBeNull();
    expect(
      decodeMemberDataCursor(encodeMemberDataCursor({ at: new Date(NOW), id: '' }), false),
    ).toBeNull();
    expect(
      decodeMemberDataCursor(encodeMemberDataCursor({ at: new Date(NOW), id: 'p1' }), true),
    ).toBeNull();
  });
});

describe('summarizeWalletPayments', () => {
  it('splits community and outside spend and ignores unknown for the share', () => {
    const summary = summarizeWalletPayments('all', null, [
      { category: 'member', direction: 'out', count: 2, amountSats: 300, feeSats: 2 },
      { category: 'shop', direction: 'out', count: 1, amountSats: 100, feeSats: 1 },
      { category: 'onchain', direction: 'out', count: 1, amountSats: 600, feeSats: 50 },
      { category: 'outside_lightning', direction: 'out', count: 1, amountSats: 0, feeSats: 0 },
      { category: 'unknown', direction: 'out', count: 1, amountSats: 999, feeSats: 0 },
      { category: 'gift', direction: 'in', count: 3, amountSats: 2100, feeSats: 0 },
    ]);
    expect(summary).toMatchObject({
      period: 'all',
      since: null,
      inSats: 2100,
      outSats: 1999,
      feeSats: 53,
      inCount: 3,
      outCount: 6,
      communityOutSats: 400,
      outsideOutSats: 600,
      communityShare: 0.4,
    });
    expect(summary.byCategory.gift).toEqual({ inSats: 2100, outSats: 0, count: 3 });
    expect(summary.byCategory.platform).toEqual({ inSats: 0, outSats: 0, count: 0 });
    expect(COMMUNITY_CATEGORIES).toEqual(['member', 'shop', 'platform', 'gift']);
    expect(OUTSIDE_CATEGORIES).toEqual(['outside_lightning', 'onchain']);
  });

  it('has no share without outgoing community or outside spend', () => {
    const since = new Date(NOW);
    const summary = summarizeWalletPayments('7', since, []);
    expect(summary.communityShare).toBeNull();
    expect(summary.since).toBe(since.toISOString());
    expect(Object.keys(summary.byCategory)).toHaveLength(7);
  });
});

describe('serializers', () => {
  it('serializes a member without a username as null', async () => {
    const auth = await accounts();
    const viewer = await auth.getAccount(VIEWER);
    expect(serializeMemberRef(viewer!)).toEqual({ id: VIEWER, name: 'Vera', username: null });
  });

  it('lists payment fields by name only, so a stored secret never reaches the payload', () => {
    const stored = {
      ...payment(),
      preimage: 'cd'.repeat(32),
      seed: 'abandon abandon abandon',
    } as WalletPaymentRow;
    const json = serializeWalletPayment(stored, { id: PEER, name: 'Pia', username: 'pia' });
    expect(Object.keys(json)).toEqual([
      'id',
      'direction',
      'status',
      'amountSats',
      'feeSats',
      'timestamp',
      'method',
      'paymentHash',
      'invoice',
      'destination',
      'description',
      'lnurlComment',
      'category',
      'counterparty',
      'firstSeenAt',
      'updatedAt',
    ]);
    expect(JSON.stringify(json)).not.toMatch(SECRET_WORDS);
    expect(JSON.stringify(json)).not.toContain('cd'.repeat(32));
  });

  it('drops secret-named and non-scalar event props', () => {
    const json = serializeMemberEvent(
      event({
        props: {
          query: 'bread',
          count: 2,
          ok: true,
          none: null,
          recoveryPhrase: 'abandon abandon',
          seedWords: 'x',
          preimage: 'y',
          prfOutput: 'z',
          privateKey: 'k',
          nested: { a: 1 } as unknown as string,
        },
      }),
    );
    expect(json['props']).toEqual({ query: 'bread', count: 2, ok: true, none: null });
    expect(JSON.stringify(json)).not.toMatch(SECRET_WORDS);
  });

  it('serializes an audit row with resolved accounts', async () => {
    const ref = (id: string) => Promise.resolve({ id, name: id.slice(0, 1), username: null });
    expect(
      await serializeTeamAccess(
        {
          id: 'a1',
          viewerAccountId: VIEWER,
          memberAccountId: MEMBER,
          what: 'wallet',
          at: new Date(NOW),
        },
        ref,
      ),
    ).toEqual({
      id: 'a1',
      viewer: { id: VIEWER, name: '3', username: null },
      member: { id: MEMBER, name: '1', username: null },
      what: 'wallet',
      at: new Date(NOW).toISOString(),
    });
  });
});

describe('readMemberWallet', () => {
  it('returns 404 for a malformed or unknown member without calling beforeRead', async () => {
    const auth = await accounts();
    let calls = 0;
    const deps = {
      store: new InMemoryMemberDataStore(),
      auth,
      nowMs: NOW,
      beforeRead: () => {
        calls += 1;
        return Promise.resolve();
      },
    };
    expect(await readMemberWallet(deps, 'nope', {})).toEqual({
      status: 404,
      body: { error: 'Not found' },
    });
    expect((await readMemberWallet(deps, GONE, {})).status).toBe(404);
    expect(calls).toBe(0);
  });

  it('returns 400 for each invalid query value before beforeRead', async () => {
    const auth = await accounts();
    let calls = 0;
    const deps = {
      store: new InMemoryMemberDataStore(),
      auth,
      nowMs: NOW,
      beforeRead: () => {
        calls += 1;
        return Promise.resolve();
      },
    };
    const bad = async (query: Record<string, string>): Promise<unknown> =>
      (await readMemberWallet(deps, MEMBER, query)).body;
    expect(await bad({ period: '1' })).toEqual({ error: 'Invalid period' });
    expect(await bad({ category: 'friends' })).toEqual({ error: 'Invalid category' });
    expect(await bad({ direction: 'both' })).toEqual({ error: 'Invalid direction' });
    expect(await bad({ cursor: '%%%' })).toEqual({ error: 'Invalid cursor' });
    expect(calls).toBe(0);
  });

  it('returns balance, summary, a filtered page, counterparties, and a cursor', async () => {
    const auth = await accounts();
    const payments: WalletPaymentRow[] = [];
    for (let i = 0; i < MEMBER_PAYMENT_PAGE_LIMIT + 2; i += 1) {
      payments.push(
        payment({
          paymentId: `p${String(i).padStart(3, '0')}`,
          paidAt: new Date(NOW - 1000 * (i + 1)),
          counterpartyAccountId: i === 0 ? GONE : i % 2 === 0 ? PEER : null,
        }),
      );
    }
    payments.push(payment({ paymentId: 'old', paidAt: new Date(NOW - 40 * 86_400_000) }));
    const store = new InMemoryMemberDataStore({
      payments,
      balances: [
        {
          id: 'b1',
          accountId: MEMBER,
          balanceSats: 4200,
          syncedAt: new Date(NOW - 5000),
          receivedAt: new Date(NOW - 4000),
        },
      ],
    });
    const order: string[] = [];
    const result = await readMemberWallet(
      {
        store,
        auth,
        nowMs: NOW,
        beforeRead: () => {
          order.push('audit');
          return Promise.resolve();
        },
      },
      MEMBER.toUpperCase(),
      { period: '30', category: 'member', direction: 'out' },
    );
    expect(order).toEqual(['audit']);
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body['member']).toEqual({ id: MEMBER, name: 'Mia', username: 'mia', role: 'basis' });
    expect(body['balance']).toEqual({
      balanceSats: 4200,
      syncedAt: new Date(NOW - 5000).toISOString(),
      receivedAt: new Date(NOW - 4000).toISOString(),
    });
    expect(body['period']).toBe('30');
    const page = body['payments'] as Array<Record<string, unknown>>;
    expect(page).toHaveLength(MEMBER_PAYMENT_PAGE_LIMIT);
    expect(page[0]?.['counterparty']).toBeNull();
    expect(page[1]?.['counterparty']).toBeNull();
    expect(page[2]?.['counterparty']).toEqual({ id: PEER, name: 'Pia', username: 'pia' });
    expect(page[4]?.['counterparty']).toEqual({ id: PEER, name: 'Pia', username: 'pia' });
    expect((body['summary'] as { outCount: number }).outCount).toBe(MEMBER_PAYMENT_PAGE_LIMIT + 2);
    expect(JSON.stringify(body)).not.toMatch(SECRET_WORDS);

    const next = await readMemberWallet({ store, auth, nowMs: NOW }, MEMBER, {
      period: '30',
      cursor: body['nextCursor'] as string,
    });
    const rest = next.body as { payments: unknown[]; nextCursor: unknown };
    expect(rest.payments).toHaveLength(2);
    expect(rest.nextCursor).toBeNull();

    const all = await readMemberWallet({ store, auth, nowMs: NOW }, MEMBER, { period: 'all' });
    expect((all.body as { summary: { outCount: number } }).summary.outCount).toBe(
      MEMBER_PAYMENT_PAGE_LIMIT + 3,
    );
  });

  it('returns a null balance for a member who never reported', async () => {
    const auth = await accounts();
    const result = await readMemberWallet(
      { store: new InMemoryMemberDataStore(), auth, nowMs: NOW },
      MEMBER,
      {},
    );
    expect(result.body).toMatchObject({
      balance: null,
      payments: [],
      nextCursor: null,
      period: '30',
    });
  });

  it('reads nothing when beforeRead throws', async () => {
    const auth = await accounts();
    const store = new InMemoryMemberDataStore();
    await expect(
      readMemberWallet(
        { store, auth, nowMs: NOW, beforeRead: () => Promise.reject(new Error('audit down')) },
        MEMBER,
        {},
      ),
    ).rejects.toThrow('audit down');
  });
});

describe('readMemberEvents', () => {
  it('returns 404 and 400 before beforeRead', async () => {
    const auth = await accounts();
    let calls = 0;
    const deps = {
      store: new InMemoryMemberDataStore(),
      auth,
      nowMs: NOW,
      beforeRead: () => {
        calls += 1;
        return Promise.resolve();
      },
    };
    expect((await readMemberEvents(deps, GONE, undefined)).status).toBe(404);
    expect((await readMemberEvents(deps, MEMBER, 'x')).body).toEqual({ error: 'Invalid cursor' });
    expect(calls).toBe(0);
  });

  it('pages events newest first', async () => {
    const auth = await accounts();
    const events: MemberEventRow[] = [];
    for (let i = 0; i < MEMBER_EVENT_PAGE_LIMIT + 1; i += 1) {
      events.push(
        event({
          id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          at: new Date(NOW - 1000 * (i + 1)),
        }),
      );
    }
    const store = new InMemoryMemberDataStore({ events });
    let calls = 0;
    const first = await readMemberEvents(
      {
        store,
        auth,
        nowMs: NOW,
        beforeRead: () => {
          calls += 1;
          return Promise.resolve();
        },
      },
      MEMBER,
      undefined,
    );
    expect(calls).toBe(1);
    const body = first.body as { events: unknown[]; nextCursor: string; member: unknown };
    expect(body.events).toHaveLength(MEMBER_EVENT_PAGE_LIMIT);
    expect(body.member).toEqual({ id: MEMBER, name: 'Mia', username: 'mia', role: 'basis' });
    const second = await readMemberEvents({ store, auth, nowMs: NOW }, MEMBER, body.nextCursor);
    expect(second.body).toMatchObject({ nextCursor: null });
    expect((second.body as { events: unknown[] }).events).toHaveLength(1);
  });
});

describe('readTeamAudit', () => {
  it('rejects a bad cursor', async () => {
    const auth = await accounts();
    expect(
      (await readTeamAudit({ store: new InMemoryMemberDataStore(), auth }, 'bad')).body,
    ).toEqual({ error: 'Invalid cursor' });
  });

  it('pages audit rows and resolves each account once, unknown ones by id', async () => {
    const auth = await accounts();
    const store = new InMemoryMemberDataStore();
    for (let i = 0; i < TEAM_AUDIT_PAGE_LIMIT + 1; i += 1) {
      await store.appendAccess({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        viewerAccountId: VIEWER,
        memberAccountId: i === 0 ? GONE : MEMBER,
        what: i % 2 === 0 ? 'wallet' : 'events',
        at: new Date(NOW - 1000 * i),
      });
    }
    let lookups = 0;
    const counting = Object.create(auth) as InMemoryAuthStore;
    counting.getAccount = (id: string) => {
      lookups += 1;
      return auth.getAccount(id);
    };
    const first = await readTeamAudit({ store, auth: counting }, undefined);
    const body = first.body as { entries: Array<Record<string, unknown>>; nextCursor: string };
    expect(body.entries).toHaveLength(TEAM_AUDIT_PAGE_LIMIT);
    expect(body.entries[0]).toMatchObject({
      viewer: { id: VIEWER, name: 'Vera', username: null },
      member: { id: GONE, name: null, username: null },
      what: 'wallet',
    });
    expect(body.entries[1]?.['member']).toEqual({ id: MEMBER, name: 'Mia', username: 'mia' });
    expect(lookups).toBe(3);
    const second = await readTeamAudit({ store, auth }, body.nextCursor);
    expect((second.body as { entries: unknown[] }).entries).toHaveLength(1);
    expect(second.body).toMatchObject({ nextCursor: null });
  });
});
