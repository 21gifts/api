import { describe, expect, it } from 'vitest';
import { InMemoryMemberHabitStore, type MemberHabit } from '@/lib/member-habit-store';
import { memberHabitRoutes } from '@/routes/member-habits';
import type { FetchFn } from '@/lib/lnurlp';
import { InMemoryAuthStore, type AccountRole } from '@/lib/auth/store';

const NOW_OPEN = Date.parse('2026-10-05T08:00:00.000Z');
const SUNDAY_ZURICH = Date.parse('2026-09-27T12:00:00.000Z');
const AUTH = { Authorization: 'Bearer tok' };

type AccountView = {
  id: string;
  role: AccountRole;
  name: string | null;
  lightningAddress: string | null;
};

const BASIS: AccountView = {
  id: 'acc-basis',
  role: 'basis',
  name: 'Basis',
  lightningAddress: 'basis@wallet.example',
};

const INITIATOR: AccountView = {
  id: 'acc-init',
  role: 'initiator',
  name: 'Initiator',
  lightningAddress: null,
};

const ALICE: AccountView = {
  id: 'acc-alice',
  role: 'basis',
  name: 'Alice',
  lightningAddress: 'alice@wallet.example',
};

const unusedFetch: FetchFn = async () => new Response(null, { status: 500 });

/** BOLT11 spec example: 2500 uBTC = 250_000 sats = 250_000_000 msat. */
const MATCHING_PR =
  'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';
const MATCHING_SATS = 250_000;

function invoiceFetch(pr: string): FetchFn {
  return async (input) => {
    const url = String(input);
    if (url.includes('/.well-known/lnurlp/')) {
      return Response.json({
        callback: 'https://wallet.example/callback',
        minSendable: 1000,
        maxSendable: 100000000000,
        metadata: '[]',
      });
    }
    return Response.json({ pr });
  };
}

const successFetch = invoiceFetch(MATCHING_PR);

const throwingFetch: FetchFn = async () => {
  throw new Error('network');
};

function sampleHabit(
  patch: Partial<MemberHabit> & Pick<MemberHabit, 'id' | 'accountId' | 'role'>,
): MemberHabit {
  return {
    ownerName: 'Owner',
    name: 'Walk',
    description: '',
    notes: 'secret',
    cadence: 'daily',
    timeZone: 'Asia/Manila',
    firstPeriod: '2026-10-01',
    lastPeriod: null,
    ...patch,
  };
}

function mount(opts: {
  store?: InMemoryMemberHabitStore;
  account?: { id: string; role: AccountRole; name: string | null } | null;
  accounts?: Record<string, AccountView>;
  now?: () => number;
  fetchImpl?: FetchFn;
}) {
  const account = opts.account === undefined ? null : opts.account;
  const accounts = opts.accounts ?? {};
  return memberHabitRoutes({
    store: opts.store ?? new InMemoryMemberHabitStore(),
    now: opts.now ?? (() => NOW_OPEN),
    fetchImpl: opts.fetchImpl ?? unusedFetch,
    resolve: async () => account,
    authStore: {
      async getAccount(id: string) {
        return accounts[id];
      },
    },
  });
}

async function post(
  app: ReturnType<typeof memberHabitRoutes>,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('memberHabitRoutes', () => {
  it('anonymous GET omits notes and sorts founder before initiator before basis', async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add(
      sampleHabit({
        id: 'h-basis',
        accountId: 'a-basis',
        role: 'basis',
        ownerName: 'Mmm',
        name: 'Basis habit',
        notes: 'basis-secret',
      }),
    );
    await store.add(
      sampleHabit({
        id: 'h-founder',
        accountId: 'a-founder',
        role: 'founder',
        ownerName: 'Zed',
        name: 'Founder habit',
        notes: 'founder-secret',
      }),
    );
    await store.add(
      sampleHabit({
        id: 'h-initiator',
        accountId: 'a-init',
        role: 'initiator',
        ownerName: 'Aaa',
        name: 'Initiator habit',
        notes: 'initiator-secret',
      }),
    );
    const res = await mount({ store, account: null }).request('/');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      reviewWeek: { start: string };
      habits: Array<{ id: string; role: string; notes?: string }>;
    };
    expect(body.reviewWeek).toEqual({ start: '2026-09-28' });
    expect(body.habits.map((habit) => habit.role)).toEqual(['founder', 'initiator', 'basis']);
    for (const habit of body.habits) {
      expect('notes' in habit).toBe(false);
    }
  });

  it('owner GET includes notes', async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add(
      sampleHabit({
        id: 'h-owner',
        accountId: BASIS.id,
        role: 'basis',
        notes: 'keep a secret',
      }),
    );
    const res = await mount({ store, account: BASIS }).request('/', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { habits: Array<{ id: string; notes?: string }> };
    const habit = body.habits.find((row) => row.id === 'h-owner');
    expect(habit?.notes).toBe('keep a secret');
  });

  it('POST without bearer is 401', async () => {
    const res = await post(mount({ account: BASIS }), { action: 'archive', id: 'x' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('malformed JSON is 400', async () => {
    const res = await post(mount({ account: BASIS }), '{', AUTH);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid body' });
  });

  it('add without Time-Zone is 400', async () => {
    const res = await post(
      mount({ account: BASIS }),
      { action: 'add', name: 'Walk', cadence: 'daily' },
      AUTH,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid time zone' });
  });

  it('add with an unknown Time-Zone is 400', async () => {
    const res = await post(
      mount({ account: BASIS }),
      { action: 'add', name: 'Walk', cadence: 'daily' },
      { ...AUTH, 'Time-Zone': 'Not/AZone' },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid time zone' });
  });

  it('add with an empty name is 400', async () => {
    const res = await post(
      mount({ account: BASIS }),
      { action: 'add', name: '', cadence: 'daily' },
      { ...AUTH, 'Time-Zone': 'Asia/Manila' },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid name' });
  });

  it('add of a daily habit returns 201 and a later owner GET shows it', async () => {
    const store = new InMemoryMemberHabitStore();
    const app = mount({ store, account: BASIS });
    const created = await post(
      app,
      { action: 'add', name: 'Walk', cadence: 'daily' },
      { ...AUTH, 'Time-Zone': 'Asia/Manila' },
    );
    expect(created.status).toBe(201);
    const added = (await created.json()) as { ok: boolean; id: string };
    expect(added.ok).toBe(true);
    expect(typeof added.id).toBe('string');
    const listed = await app.request('/', { headers: AUTH });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      habits: Array<{ id: string; name: string; notes?: string }>;
    };
    const habit = body.habits.find((row) => row.id === added.id);
    expect(habit?.name).toBe('Walk');
    expect(habit?.notes).toBe('');
  });

  it('edit of a missing id is 404', async () => {
    const res = await post(
      mount({ account: BASIS }),
      { action: 'edit', id: 'missing', name: 'Walk' },
      AUTH,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('archive of that habit returns 200', async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add(sampleHabit({ id: 'h-archive', accountId: BASIS.id, role: 'basis' }));
    const res = await post(
      mount({ store, account: BASIS }),
      { action: 'archive', id: 'h-archive' },
      AUTH,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('log of a future period is 409', async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add(sampleHabit({ id: 'h-log', accountId: BASIS.id, role: 'basis' }));
    const res = await post(
      mount({ store, account: BASIS }),
      { action: 'log', id: 'h-log', period: '2026-10-06', status: 'achieved' },
      AUTH,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Period is closed' });
  });

  it('log of the current daily period with status achieved returns 200', async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add(sampleHabit({ id: 'h-log', accountId: BASIS.id, role: 'basis' }));
    const res = await post(
      mount({ store, account: BASIS }),
      { action: 'log', id: 'h-log', period: '2026-10-05', status: 'achieved' },
      AUTH,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('comment on Sunday in Europe/Zurich is 403 SUNDAY_REST', async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add(sampleHabit({ id: 'h-comment', accountId: BASIS.id, role: 'basis' }));
    const res = await post(
      mount({ store, account: BASIS, now: () => SUNDAY_ZURICH }),
      { action: 'comment', habitId: 'h-comment', text: 'nice' },
      { ...AUTH, 'Time-Zone': 'Europe/Zurich' },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'SUNDAY_REST' });
  });

  it('comment on Sunday without Time-Zone is 201', async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add(sampleHabit({ id: 'h-comment', accountId: BASIS.id, role: 'basis' }));
    const res = await post(
      mount({ store, account: BASIS, now: () => SUNDAY_ZURICH }),
      { action: 'comment', habitId: 'h-comment', text: 'nice' },
      AUTH,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('comment on Sunday with an invalid Time-Zone is 201', async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add(sampleHabit({ id: 'h-comment', accountId: BASIS.id, role: 'basis' }));
    const res = await post(
      mount({ store, account: BASIS, now: () => SUNDAY_ZURICH }),
      { action: 'comment', habitId: 'h-comment', text: 'nice' },
      { ...AUTH, 'Time-Zone': 'Not/AZone' },
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('comment at 2026-10-05T08:00:00.000Z by a basis account is 201', async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add(sampleHabit({ id: 'h-comment', accountId: INITIATOR.id, role: 'initiator' }));
    const res = await post(
      mount({ store, account: BASIS }),
      { action: 'comment', habitId: 'h-comment', text: 'nice' },
      AUTH,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('deleteComment by basis is 403', async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add(sampleHabit({ id: 'h-comment', accountId: BASIS.id, role: 'basis' }));
    await store.comment({
      id: '11111111-1111-4111-8111-111111111111',
      habitId: 'h-comment',
      accountId: BASIS.id,
      name: 'Basis',
      text: 'nice',
      week: '2026-09-28',
      createdAt: NOW_OPEN,
      deletedAt: null,
    });
    const res = await post(
      mount({ store, account: BASIS }),
      { action: 'deleteComment', id: '11111111-1111-4111-8111-111111111111' },
      AUTH,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('deleteComment by initiator on Sunday in Europe/Zurich is 403 SUNDAY_REST', async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add(sampleHabit({ id: 'h-comment', accountId: BASIS.id, role: 'basis' }));
    await store.comment({
      id: '11111111-1111-4111-8111-111111111111',
      habitId: 'h-comment',
      accountId: BASIS.id,
      name: 'Basis',
      text: 'nice',
      week: '2026-09-28',
      createdAt: NOW_OPEN,
      deletedAt: null,
    });
    const res = await post(
      mount({ store, account: INITIATOR, now: () => SUNDAY_ZURICH }),
      { action: 'deleteComment', id: '11111111-1111-4111-8111-111111111111' },
      { ...AUTH, 'Time-Zone': 'Europe/Zurich' },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'SUNDAY_REST' });
  });

  it('deleteComment by initiator is 200', async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add(sampleHabit({ id: 'h-comment', accountId: BASIS.id, role: 'basis' }));
    await store.comment({
      id: '11111111-1111-4111-8111-111111111111',
      habitId: 'h-comment',
      accountId: BASIS.id,
      name: 'Basis',
      text: 'nice',
      week: '2026-09-28',
      createdAt: NOW_OPEN,
      deletedAt: null,
    });
    const res = await post(
      mount({ store, account: INITIATOR }),
      { action: 'deleteComment', id: '11111111-1111-4111-8111-111111111111' },
      AUTH,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("invoice of the caller's own comment is 400", async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add(sampleHabit({ id: 'h-comment', accountId: BASIS.id, role: 'basis' }));
    await store.comment({
      id: '22222222-2222-4222-8222-222222222222',
      habitId: 'h-comment',
      accountId: BASIS.id,
      name: 'Basis',
      text: 'nice',
      week: '2026-09-28',
      createdAt: NOW_OPEN,
      deletedAt: null,
    });
    const res = await post(
      mount({ store, account: BASIS }),
      { action: 'invoice', commentId: '22222222-2222-4222-8222-222222222222', amountSats: 1 },
      AUTH,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Cannot donate to yourself' });
  });

  it('invoice when getAccount returns lightningAddress null is 409', async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add(sampleHabit({ id: 'h-comment', accountId: ALICE.id, role: 'basis' }));
    await store.comment({
      id: '33333333-3333-4333-8333-333333333333',
      habitId: 'h-comment',
      accountId: ALICE.id,
      name: 'Alice',
      text: 'nice',
      week: '2026-09-28',
      createdAt: NOW_OPEN,
      deletedAt: null,
    });
    const res = await post(
      mount({
        store,
        account: BASIS,
        accounts: { [ALICE.id]: { ...ALICE, lightningAddress: null } },
      }),
      { action: 'invoice', commentId: '33333333-3333-4333-8333-333333333333', amountSats: 1 },
      AUTH,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "The author's wallet cannot receive this Bitcoin payment",
    });
  });

  it('invoice when fetchImpl throws is 502', async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add(sampleHabit({ id: 'h-comment', accountId: ALICE.id, role: 'basis' }));
    await store.comment({
      id: '33333333-3333-4333-8333-333333333333',
      habitId: 'h-comment',
      accountId: ALICE.id,
      name: 'Alice',
      text: 'nice',
      week: '2026-09-28',
      createdAt: NOW_OPEN,
      deletedAt: null,
    });
    const res = await post(
      mount({
        store,
        account: BASIS,
        accounts: { [ALICE.id]: ALICE },
        fetchImpl: throwingFetch,
      }),
      { action: 'invoice', commentId: '33333333-3333-4333-8333-333333333333', amountSats: 1 },
      AUTH,
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Lightning Address could not be resolved' });
  });

  it('invoice when fetchImpl succeeds is 200 { pr, amountSats }', async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add(sampleHabit({ id: 'h-comment', accountId: ALICE.id, role: 'basis' }));
    await store.comment({
      id: '33333333-3333-4333-8333-333333333333',
      habitId: 'h-comment',
      accountId: ALICE.id,
      name: 'Alice',
      text: 'nice',
      week: '2026-09-28',
      createdAt: NOW_OPEN,
      deletedAt: null,
    });
    const res = await post(
      mount({
        store,
        account: BASIS,
        accounts: { [ALICE.id]: ALICE },
        fetchImpl: successFetch,
      }),
      {
        action: 'invoice',
        commentId: '33333333-3333-4333-8333-333333333333',
        amountSats: MATCHING_SATS,
      },
      AUTH,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pr: MATCHING_PR, amountSats: MATCHING_SATS });
  });

  it('invoice when the BOLT11 does not decode is 502', async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add(sampleHabit({ id: 'h-comment', accountId: ALICE.id, role: 'basis' }));
    await store.comment({
      id: '33333333-3333-4333-8333-333333333333',
      habitId: 'h-comment',
      accountId: ALICE.id,
      name: 'Alice',
      text: 'nice',
      week: '2026-09-28',
      createdAt: NOW_OPEN,
      deletedAt: null,
    });
    const res = await post(
      mount({
        store,
        account: BASIS,
        accounts: { [ALICE.id]: ALICE },
        fetchImpl: invoiceFetch('not-an-invoice'),
      }),
      { action: 'invoice', commentId: '33333333-3333-4333-8333-333333333333', amountSats: 1 },
      AUTH,
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Lightning Address could not be resolved' });
  });

  it('invoice when the BOLT11 amount is not the requested amount is 502', async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add(sampleHabit({ id: 'h-comment', accountId: ALICE.id, role: 'basis' }));
    await store.comment({
      id: '33333333-3333-4333-8333-333333333333',
      habitId: 'h-comment',
      accountId: ALICE.id,
      name: 'Alice',
      text: 'nice',
      week: '2026-09-28',
      createdAt: NOW_OPEN,
      deletedAt: null,
    });
    const res = await post(
      mount({
        store,
        account: BASIS,
        accounts: { [ALICE.id]: ALICE },
        fetchImpl: successFetch,
      }),
      { action: 'invoice', commentId: '33333333-3333-4333-8333-333333333333', amountSats: 1 },
      AUTH,
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Lightning Address could not be resolved' });
  });

  it('invoice on Sunday in Europe/Zurich is 403 SUNDAY_REST before the amount check', async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add(sampleHabit({ id: 'h-comment', accountId: ALICE.id, role: 'basis' }));
    await store.comment({
      id: '33333333-3333-4333-8333-333333333333',
      habitId: 'h-comment',
      accountId: ALICE.id,
      name: 'Alice',
      text: 'nice',
      week: '2026-09-28',
      createdAt: NOW_OPEN,
      deletedAt: null,
    });
    const res = await post(
      mount({
        store,
        account: BASIS,
        accounts: { [ALICE.id]: ALICE },
        fetchImpl: successFetch,
        now: () => SUNDAY_ZURICH,
      }),
      { action: 'invoice', commentId: '33333333-3333-4333-8333-333333333333', amountSats: 0 },
      { ...AUTH, 'Time-Zone': 'Europe/Zurich' },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'SUNDAY_REST' });
  });

  it('invoice on Sunday without Time-Zone is 200', async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add(sampleHabit({ id: 'h-comment', accountId: ALICE.id, role: 'basis' }));
    await store.comment({
      id: '33333333-3333-4333-8333-333333333333',
      habitId: 'h-comment',
      accountId: ALICE.id,
      name: 'Alice',
      text: 'nice',
      week: '2026-09-28',
      createdAt: NOW_OPEN,
      deletedAt: null,
    });
    const res = await post(
      mount({
        store,
        account: BASIS,
        accounts: { [ALICE.id]: ALICE },
        fetchImpl: successFetch,
        now: () => SUNDAY_ZURICH,
      }),
      {
        action: 'invoice',
        commentId: '33333333-3333-4333-8333-333333333333',
        amountSats: MATCHING_SATS,
      },
      AUTH,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pr: MATCHING_PR, amountSats: MATCHING_SATS });
  });

  it('invoice on Sunday with an invalid Time-Zone is 200', async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add(sampleHabit({ id: 'h-comment', accountId: ALICE.id, role: 'basis' }));
    await store.comment({
      id: '33333333-3333-4333-8333-333333333333',
      habitId: 'h-comment',
      accountId: ALICE.id,
      name: 'Alice',
      text: 'nice',
      week: '2026-09-28',
      createdAt: NOW_OPEN,
      deletedAt: null,
    });
    const res = await post(
      mount({
        store,
        account: BASIS,
        accounts: { [ALICE.id]: ALICE },
        fetchImpl: successFetch,
        now: () => SUNDAY_ZURICH,
      }),
      {
        action: 'invoice',
        commentId: '33333333-3333-4333-8333-333333333333',
        amountSats: MATCHING_SATS,
      },
      { ...AUTH, 'Time-Zone': 'Not/AZone' },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pr: MATCHING_PR, amountSats: MATCHING_SATS });
  });

  it('a store whose listPublic throws returns 503 and the body error Habits are unavailable', async () => {
    const store = new InMemoryMemberHabitStore();
    store.listPublic = async () => {
      throw new Error('down');
    };
    const res = await mount({ store, account: null }).request('/');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Habits are unavailable' });
  });

  it('GET returns live comments without deletedAt', async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add(sampleHabit({ id: 'h-comment', accountId: BASIS.id, role: 'basis' }));
    const app = mount({ store, account: BASIS });
    const created = await post(
      app,
      { action: 'comment', habitId: 'h-comment', text: 'nice' },
      AUTH,
    );
    expect(created.status).toBe(201);
    const listed = await app.request('/');
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      habits: Array<{ comments: Array<{ text: string; deletedAt?: number }> }>;
    };
    expect(body.habits[0]?.comments[0]?.text).toBe('nice');
    expect(body.habits[0]?.comments[0]?.deletedAt).toBeUndefined();
  });

  it('sorts the same role by owner name and habit name, and keeps a moderator with everyone else', async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add(
      sampleHabit({ id: 'mona', accountId: '1', role: 'basis', ownerName: 'Mona', name: 'Beta' }),
    );
    await store.add(
      sampleHabit({ id: 'adam', accountId: '2', role: 'basis', ownerName: 'Adam', name: 'Alpha' }),
    );
    await store.add(
      sampleHabit({ id: 'sam-b', accountId: '3', role: 'basis', ownerName: 'Sam', name: 'Beta' }),
    );
    await store.add(
      sampleHabit({ id: 'sam-a', accountId: '4', role: 'basis', ownerName: 'Sam', name: 'Alpha' }),
    );
    await store.add(
      sampleHabit({ id: 'same-1', accountId: '5', role: 'basis', ownerName: 'Sam', name: 'Same' }),
    );
    await store.add(
      sampleHabit({ id: 'same-2', accountId: '6', role: 'basis', ownerName: 'Sam', name: 'Same' }),
    );
    await store.add(
      sampleHabit({ id: 'mod', accountId: '7', role: 'moderator', ownerName: 'Zed', name: 'Mod' }),
    );
    const res = await mount({ store, account: null }).request('/');
    const body = (await res.json()) as { habits: Array<{ id: string }> };
    expect(body.habits.map((habit) => habit.id)).toEqual([
      'adam',
      'mona',
      'sam-a',
      'sam-b',
      'same-1',
      'same-2',
      'mod',
    ]);
  });

  it('add rejects a long name, a long description, and long notes', async () => {
    const app = mount({ account: BASIS });
    const headers = { ...AUTH, 'Time-Zone': 'Asia/Manila' };
    const longName = await post(
      app,
      { action: 'add', name: 'n'.repeat(81), cadence: 'daily' },
      headers,
    );
    expect(longName.status).toBe(400);
    expect(await longName.json()).toEqual({ error: 'Invalid name' });
    const longDescription = await post(
      app,
      { action: 'add', name: 'Walk', description: 'd'.repeat(2001), cadence: 'daily' },
      headers,
    );
    expect(longDescription.status).toBe(400);
    expect(await longDescription.json()).toEqual({ error: 'Invalid description' });
    const longNotes = await post(
      app,
      { action: 'add', name: 'Walk', notes: 'n'.repeat(2001), cadence: 'daily' },
      headers,
    );
    expect(longNotes.status).toBe(400);
    expect(await longNotes.json()).toEqual({ error: 'Invalid notes' });
  });

  it('add and comment count Unicode code points, not UTF-16 units', async () => {
    const emoji = '😀';
    expect(emoji.length).toBe(2);
    expect([...emoji].length).toBe(1);
    const app = mount({ account: BASIS });
    const headers = { ...AUTH, 'Time-Zone': 'Asia/Manila' };
    const name = emoji.repeat(80);
    const description = emoji.repeat(2000);
    const notes = emoji.repeat(2000);
    const created = await post(
      app,
      { action: 'add', name, description, notes, cadence: 'daily' },
      headers,
    );
    expect(created.status).toBe(201);
    const added = (await created.json()) as { ok: boolean; id: string };
    expect(added.ok).toBe(true);
    const listed = await app.request('/', { headers: AUTH });
    const body = (await listed.json()) as {
      habits: Array<{ id: string; name: string; description: string; notes?: string }>;
    };
    const habit = body.habits.find((row) => row.id === added.id);
    expect(habit?.name).toBe(name);
    expect(habit?.description).toBe(description);
    expect(habit?.notes).toBe(notes);

    const longName = await post(
      app,
      { action: 'add', name: emoji.repeat(81), cadence: 'daily' },
      headers,
    );
    expect(longName.status).toBe(400);
    expect(await longName.json()).toEqual({ error: 'Invalid name' });
    const longDescription = await post(
      app,
      { action: 'add', name: 'Walk', description: emoji.repeat(2001), cadence: 'daily' },
      headers,
    );
    expect(longDescription.status).toBe(400);
    expect(await longDescription.json()).toEqual({ error: 'Invalid description' });
    const longNotes = await post(
      app,
      { action: 'add', name: 'Walk', notes: emoji.repeat(2001), cadence: 'daily' },
      headers,
    );
    expect(longNotes.status).toBe(400);
    expect(await longNotes.json()).toEqual({ error: 'Invalid notes' });

    const comment = await post(
      app,
      { action: 'comment', habitId: added.id, text: emoji.repeat(2000) },
      headers,
    );
    expect(comment.status).toBe(201);
    const longComment = await post(
      app,
      { action: 'comment', habitId: added.id, text: emoji.repeat(2001) },
      headers,
    );
    expect(longComment.status).toBe(400);
    expect(await longComment.json()).toEqual({ error: 'Invalid comment' });
  });

  it('add with a null account name stores an empty owner name', async () => {
    const store = new InMemoryMemberHabitStore();
    const app = mount({ store, account: { id: 'acc-noname', role: 'basis', name: null } });
    const res = await post(
      app,
      { action: 'add', name: 'Walk', cadence: 'daily' },
      { ...AUTH, 'Time-Zone': 'Asia/Manila' },
    );
    expect(res.status).toBe(201);
    const listed = await app.request('/', { headers: AUTH });
    const body = (await listed.json()) as { habits: Array<{ ownerName: string; notes?: string }> };
    expect(body.habits[0]?.ownerName).toBe('');
    expect(body.habits[0]?.notes).toBe('');
  });

  it('edit updates the owner habit and rejects another person, a missing id, and a long name', async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add(sampleHabit({ id: 'mine', accountId: BASIS.id, role: 'basis' }));
    await store.add(sampleHabit({ id: 'theirs', accountId: ALICE.id, role: 'basis' }));
    const app = mount({ store, account: BASIS });
    const ok = await post(
      app,
      { action: 'edit', id: 'mine', name: 'Run', description: 'Out', notes: 'n' },
      AUTH,
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    const other = await post(
      app,
      { action: 'edit', id: 'theirs', name: 'Run', description: '', notes: '' },
      AUTH,
    );
    expect(other.status).toBe(404);
    const missing = await post(
      app,
      { action: 'edit', id: 'nope', name: 'Run', description: '', notes: '' },
      AUTH,
    );
    expect(missing.status).toBe(404);
    const longName = await post(
      app,
      { action: 'edit', id: 'mine', name: 'n'.repeat(81), description: '', notes: '' },
      AUTH,
    );
    expect(longName.status).toBe(400);
    expect(await longName.json()).toEqual({ error: 'Invalid name' });
  });

  it('archive of an unknown id is 404 and archive of another person is 404', async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add(sampleHabit({ id: 'theirs', accountId: ALICE.id, role: 'basis' }));
    const app = mount({ store, account: BASIS });
    const missing = await post(app, { action: 'archive', id: 'nope' }, AUTH);
    expect(missing.status).toBe(404);
    const other = await post(app, { action: 'archive', id: 'theirs' }, AUTH);
    expect(other.status).toBe(404);
  });

  it('log covers partial, missed, a bad status, a bad day, a weekly Tuesday, and a closed past day', async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add(sampleHabit({ id: 'daily', accountId: BASIS.id, role: 'basis' }));
    await store.add(
      sampleHabit({
        id: 'weekly',
        accountId: BASIS.id,
        role: 'basis',
        cadence: 'weekly',
        firstPeriod: '2026-09-28',
      }),
    );
    await store.add(sampleHabit({ id: 'theirs', accountId: ALICE.id, role: 'basis' }));
    await store.add(
      sampleHabit({
        id: 'theirs-week',
        accountId: ALICE.id,
        role: 'basis',
        cadence: 'weekly',
        firstPeriod: '2026-09-28',
      }),
    );
    const app = mount({ store, account: BASIS });
    const partial = await post(
      app,
      { action: 'log', id: 'daily', period: '2026-10-02', status: 'partial' },
      AUTH,
    );
    expect(partial.status).toBe(200);
    const missed = await post(
      app,
      { action: 'log', id: 'daily', period: '2026-10-03', status: 'missed' },
      AUTH,
    );
    expect(missed.status).toBe(200);
    const badStatus = await post(
      app,
      { action: 'log', id: 'daily', period: '2026-10-01', status: 'nope' },
      AUTH,
    );
    expect(badStatus.status).toBe(400);
    expect(await badStatus.json()).toEqual({ error: 'Invalid status' });
    const badDay = await post(
      app,
      { action: 'log', id: 'daily', period: '2026-02-31', status: 'achieved' },
      AUTH,
    );
    expect(badDay.status).toBe(400);
    expect(await badDay.json()).toEqual({ error: 'Invalid period' });
    const notYmd = await post(
      app,
      { action: 'log', id: 'daily', period: 'nope', status: 'achieved' },
      AUTH,
    );
    expect(notYmd.status).toBe(400);
    const tuesday = await post(
      app,
      { action: 'log', id: 'weekly', period: '2026-09-29', status: 'achieved' },
      AUTH,
    );
    expect(tuesday.status).toBe(400);
    expect(await tuesday.json()).toEqual({ error: 'Invalid period' });
    const impossibleWeek = await post(
      app,
      { action: 'log', id: 'weekly', period: '2026-13-01', status: 'achieved' },
      AUTH,
    );
    expect(impossibleWeek.status).toBe(400);
    expect(await impossibleWeek.json()).toEqual({ error: 'Invalid period' });
    const monday = await post(
      app,
      { action: 'log', id: 'weekly', period: '2026-09-28', status: 'achieved' },
      AUTH,
    );
    expect(monday.status).toBe(200);
    const past = await post(
      app,
      { action: 'log', id: 'daily', period: '2026-09-01', status: 'achieved' },
      AUTH,
    );
    expect(past.status).toBe(409);
    expect(await past.json()).toEqual({ error: 'Period is closed' });
    const other = await post(
      app,
      { action: 'log', id: 'theirs', period: '2026-10-01', status: 'achieved' },
      AUTH,
    );
    expect(other.status).toBe(404);
    const otherFuture = await post(
      app,
      { action: 'log', id: 'theirs', period: '2026-10-06', status: 'achieved' },
      AUTH,
    );
    expect(otherFuture.status).toBe(404);
    expect(await otherFuture.json()).toEqual({ error: 'Not found' });
    const otherTuesday = await post(
      app,
      { action: 'log', id: 'theirs-week', period: '2026-09-29', status: 'achieved' },
      AUTH,
    );
    expect(otherTuesday.status).toBe(404);
    const unknown = await post(
      app,
      { action: 'log', id: 'missing', period: '2026-10-01', status: 'achieved' },
      AUTH,
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'Not found' });
  });

  it('comment rejects blank text, text over 2000, a missing habit, and a null author name', async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add(sampleHabit({ id: 'h-comment', accountId: ALICE.id, role: 'basis' }));
    const app = mount({ store, account: { id: BASIS.id, role: 'basis', name: null } });
    const blank = await post(app, { action: 'comment', habitId: 'h-comment', text: '   ' }, AUTH);
    expect(blank.status).toBe(400);
    expect(await blank.json()).toEqual({ error: 'Invalid comment' });
    const longText = await post(
      app,
      { action: 'comment', habitId: 'h-comment', text: 'c'.repeat(2001) },
      AUTH,
    );
    expect(longText.status).toBe(400);
    const missing = await post(app, { action: 'comment', habitId: 'nope', text: 'hi' }, AUTH);
    expect(missing.status).toBe(404);
    const ok = await post(app, { action: 'comment', habitId: 'h-comment', text: 'hi' }, AUTH);
    expect(ok.status).toBe(201);
    const listed = await store.listPublic(null, NOW_OPEN);
    expect(listed[0]?.comments[0]?.name).toBe('');
  });

  it('deleteComment allows moderator and founder, rejects verified and an unknown role, and 404s when missing', async () => {
    async function seed(role: AccountRole): Promise<Response> {
      const store = new InMemoryMemberHabitStore();
      await store.add(sampleHabit({ id: 'h', accountId: 'owner', role: 'basis' }));
      await store.comment({
        id: '11111111-1111-4111-8111-111111111111',
        habitId: 'h',
        accountId: 'owner',
        name: 'Owner',
        text: 'nice',
        week: '2026-09-28',
        createdAt: NOW_OPEN,
        deletedAt: null,
      });
      return post(
        mount({ store, account: { id: 'staff', role, name: 'Staff' } }),
        { action: 'deleteComment', id: '11111111-1111-4111-8111-111111111111' },
        AUTH,
      );
    }
    expect((await seed('verified')).status).toBe(403);
    expect((await seed('moderator')).status).toBe(200);
    expect((await seed('founder')).status).toBe(200);
    expect((await seed('guest' as AccountRole)).status).toBe(403);
    const store = new InMemoryMemberHabitStore();
    const missing = await post(
      mount({ store, account: INITIATOR }),
      { action: 'deleteComment', id: 'nope' },
      AUTH,
    );
    expect(missing.status).toBe(404);
    const unknownId = await post(
      mount({ store, account: INITIATOR }),
      { action: 'deleteComment', id: '55555555-5555-4555-8555-555555555555' },
      AUTH,
    );
    expect(unknownId.status).toBe(404);
    expect(await unknownId.json()).toEqual({ error: 'Not found' });
    const malformed = new InMemoryMemberHabitStore();
    malformed.findComment = async () => {
      throw new Error('uuid syntax');
    };
    const refused = await post(
      mount({ store: malformed, account: INITIATOR }),
      { action: 'deleteComment', id: 'nope' },
      AUTH,
    );
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: 'Not found' });
    await store.add(sampleHabit({ id: 'h', accountId: 'owner', role: 'basis' }));
    await store.comment({
      id: '44444444-4444-4444-8444-444444444444',
      habitId: 'h',
      accountId: 'owner',
      name: 'Owner',
      text: 'nice',
      week: '2026-09-28',
      createdAt: NOW_OPEN,
      deletedAt: null,
    });
    store.deleteComment = async () => false;
    const stuck = await post(
      mount({ store, account: INITIATOR }),
      { action: 'deleteComment', id: '44444444-4444-4444-8444-444444444444' },
      AUTH,
    );
    expect(stuck.status).toBe(404);
  });

  it('invoice rejects a bad amount, a missing comment, an empty wallet, a second burst, and a failed lookup', async () => {
    const store = new InMemoryMemberHabitStore();
    await store.add(sampleHabit({ id: 'h', accountId: ALICE.id, role: 'basis' }));
    await store.comment({
      id: '33333333-3333-4333-8333-333333333333',
      habitId: 'h',
      accountId: ALICE.id,
      name: 'Alice',
      text: 'nice',
      week: '2026-09-28',
      createdAt: NOW_OPEN,
      deletedAt: null,
    });
    const app = mount({
      store,
      account: BASIS,
      accounts: { [ALICE.id]: { ...ALICE, lightningAddress: '' } },
      fetchImpl: successFetch,
    });
    const zero = await post(
      app,
      { action: 'invoice', commentId: '33333333-3333-4333-8333-333333333333', amountSats: 0 },
      AUTH,
    );
    expect(zero.status).toBe(400);
    expect(await zero.json()).toEqual({
      error: 'Expected a JSON body with an integer "amountSats"',
    });
    const fraction = await post(
      app,
      { action: 'invoice', commentId: '33333333-3333-4333-8333-333333333333', amountSats: 1.5 },
      AUTH,
    );
    expect(fraction.status).toBe(400);
    const huge = await post(
      app,
      {
        action: 'invoice',
        commentId: '33333333-3333-4333-8333-333333333333',
        amountSats: 10_000_001,
      },
      AUTH,
    );
    expect(huge.status).toBe(400);
    expect(await huge.json()).toEqual({
      error: 'Expected a JSON body with an integer "amountSats"',
    });
    const missing = await post(app, { action: 'invoice', commentId: 'nope', amountSats: 1 }, AUTH);
    expect(missing.status).toBe(404);
    const unknownComment = await post(
      app,
      { action: 'invoice', commentId: '55555555-5555-4555-8555-555555555555', amountSats: 1 },
      AUTH,
    );
    expect(unknownComment.status).toBe(404);
    expect(await unknownComment.json()).toEqual({ error: 'Not found' });
    const malformed = new InMemoryMemberHabitStore();
    malformed.findComment = async () => {
      throw new Error('uuid syntax');
    };
    const refused = await post(
      mount({ store: malformed, account: BASIS, fetchImpl: successFetch }),
      { action: 'invoice', commentId: 'nope', amountSats: 1 },
      AUTH,
    );
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: 'Not found' });
    const emptyWallet = await post(
      app,
      { action: 'invoice', commentId: '33333333-3333-4333-8333-333333333333', amountSats: 1 },
      AUTH,
    );
    expect(emptyWallet.status).toBe(409);
    expect(await emptyWallet.json()).toEqual({
      error: "The author's wallet cannot receive this Bitcoin payment",
    });
    const stillNoWallet = await post(
      app,
      { action: 'invoice', commentId: '33333333-3333-4333-8333-333333333333', amountSats: 1 },
      AUTH,
    );
    expect(stillNoWallet.status).toBe(409);
    expect(await stillNoWallet.json()).toEqual({
      error: "The author's wallet cannot receive this Bitcoin payment",
    });
    const atCeiling = await post(
      mount({
        store,
        account: BASIS,
        accounts: { [ALICE.id]: { ...ALICE, lightningAddress: '' } },
        fetchImpl: successFetch,
      }),
      {
        action: 'invoice',
        commentId: '33333333-3333-4333-8333-333333333333',
        amountSats: 10_000_000,
      },
      AUTH,
    );
    expect(atCeiling.status).toBe(409);

    const paying = mount({
      store,
      account: BASIS,
      accounts: { [ALICE.id]: ALICE },
      fetchImpl: successFetch,
    });
    const first = await post(
      paying,
      {
        action: 'invoice',
        commentId: '33333333-3333-4333-8333-333333333333',
        amountSats: MATCHING_SATS,
      },
      AUTH,
    );
    expect(first.status).toBe(200);
    const second = await post(
      paying,
      { action: 'invoice', commentId: '33333333-3333-4333-8333-333333333333', amountSats: 1 },
      AUTH,
    );
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ error: 'Too many payments' });

    const failFetch: FetchFn = async () => new Response('no', { status: 500 });
    const failed = await post(
      mount({
        store,
        account: BASIS,
        accounts: { [ALICE.id]: ALICE },
        fetchImpl: failFetch,
      }),
      { action: 'invoice', commentId: '33333333-3333-4333-8333-333333333333', amountSats: 1 },
      AUTH,
    );
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: 'Lightning Address could not be resolved' });
    const textAmount = await post(
      mount({
        store,
        account: BASIS,
        accounts: { [ALICE.id]: ALICE },
        fetchImpl: successFetch,
      }),
      { action: 'invoice', commentId: '33333333-3333-4333-8333-333333333333', amountSats: '21' },
      AUTH,
    );
    expect(textAmount.status).toBe(400);
    expect(await textAmount.json()).toEqual({
      error: 'Expected a JSON body with an integer "amountSats"',
    });
    const missingAmount = await post(
      mount({
        store,
        account: BASIS,
        accounts: { [ALICE.id]: ALICE },
        fetchImpl: successFetch,
      }),
      { action: 'invoice', commentId: '33333333-3333-4333-8333-333333333333' },
      AUTH,
    );
    expect(missingAmount.status).toBe(400);
    expect(await missingAmount.json()).toEqual({
      error: 'Expected a JSON body with an integer "amountSats"',
    });
  });

  it('a store whose add throws returns 503', async () => {
    const store = new InMemoryMemberHabitStore();
    store.add = async () => {
      throw new Error('down');
    };
    const res = await post(
      mount({ store, account: BASIS }),
      { action: 'add', name: 'Walk', cadence: 'daily' },
      { ...AUTH, 'Time-Zone': 'Asia/Manila' },
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Habits are unavailable' });
  });

  it('uses resolveSession when resolve is omitted', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount({
      id: 'acc-session',
      linkingKey: null,
      role: 'basis',
      name: 'Sam',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await authStore.createSession({ token: 'tok', accountId: 'acc-session', createdAt: NOW_OPEN });
    const app = memberHabitRoutes({
      store: new InMemoryMemberHabitStore(),
      authStore,
      now: () => NOW_OPEN,
      fetchImpl: unusedFetch,
    });
    const res = await post(
      app,
      { action: 'add', name: 'Walk', cadence: 'daily' },
      { Authorization: 'Bearer tok', 'Time-Zone': 'Asia/Manila' },
    );
    expect(res.status).toBe(201);
    const unknown = await post(
      app,
      { action: 'archive', id: 'x' },
      { Authorization: 'Bearer other' },
    );
    expect(unknown.status).toBe(401);
    const expiredStore = new InMemoryAuthStore();
    await expiredStore.createAccount({
      id: 'acc-old',
      linkingKey: null,
      role: 'basis',
      name: 'Old',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await expiredStore.createSession({ token: 'old', accountId: 'acc-old', createdAt: 1 });
    const expired = memberHabitRoutes({
      store: new InMemoryMemberHabitStore(),
      authStore: expiredStore,
      now: () => NOW_OPEN,
      fetchImpl: unusedFetch,
    });
    const stale = await post(
      expired,
      { action: 'archive', id: 'x' },
      { Authorization: 'Bearer old' },
    );
    expect(stale.status).toBe(401);
    const publicGet = await app.request('/');
    expect(publicGet.status).toBe(200);
  });

  it('a throwing resolve returns 503', async () => {
    const app = memberHabitRoutes({
      store: new InMemoryMemberHabitStore(),
      authStore: {
        async getAccount() {
          return undefined;
        },
      },
      now: () => NOW_OPEN,
      fetchImpl: unusedFetch,
      resolve: async () => {
        throw new Error('boom');
      },
    });
    const res = await post(app, { action: 'archive', id: 'x' }, AUTH);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Habits are unavailable' });
  });
});
