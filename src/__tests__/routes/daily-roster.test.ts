import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import {
  DailyRosterRequestError,
  type DailyRoster,
  type DailyRosterDocument,
  type DailyRosterPublic,
} from '@/lib/daily-roster';
import { InMemoryDailyRosterStore, type DailyRosterStore } from '@/lib/daily-roster-store';
import { InMemoryFundingStore } from '@/lib/funding-store';
import { InMemoryGiftStore } from '@/lib/gift-store';
import { setDiagnosticSink } from '@/lib/log';
import type { FetchFn } from '@/lib/lnurlp';
import { InMemoryMessageStore } from '@/lib/message-store';
import { fundingRoutes } from '@/routes/funding';
import { createApp } from '@/server';

const now = (): number => 1_700_000_000_000;
const FOUNDER = '11111111-1111-4111-8111-111111111111';
const MOD = '22222222-2222-4222-8222-222222222222';
const VERIFIED = '55555555-5555-4555-8555-555555555555';
const INITIATOR = '66666666-6666-4666-8666-666666666666';
const BASIS = '77777777-7777-4777-8777-777777777777';

const ROSTER: DailyRoster = {
  comment: 'thanks',
  paymentsEnabled: true,
  defaultAmountUsd: 1,
  recipients: [{ address: 'ada@example.com', amountUsd: 1 }],
};

const DOCUMENT: DailyRosterDocument = {
  ...ROSTER,
  moderatorPaymentsEnabled: true,
  moderators: [],
};

const PUBLIC_ROSTER: DailyRosterPublic = {
  comment: 'thanks',
  paymentsEnabled: true,
  defaultAmountUsd: 1,
  recipients: [{ address: 'ada@example.com', amountUsd: 1, accountId: null, name: null }],
};

const POSTS = [
  '/funding/daily-roster/comment',
  '/funding/daily-roster/payments',
  '/funding/daily-roster/recipients',
  '/funding/daily-roster/recipients/update',
  '/funding/daily-roster/recipients/delete',
] as const;

const WORKER_POSTS = [
  '/funding/daily-roster/worker/comment',
  '/funding/daily-roster/worker/payments',
  '/funding/daily-roster/worker/recipients',
  '/funding/daily-roster/worker/recipients/update',
  '/funding/daily-roster/worker/recipients/delete',
  '/funding/daily-roster/worker/moderators',
  '/funding/daily-roster/worker/moderators/update',
  '/funding/daily-roster/worker/moderators/delete',
  '/funding/daily-roster/worker/moderators/payments',
] as const;

const EMPTY_DOCUMENT: DailyRosterDocument = {
  comment: '',
  paymentsEnabled: true,
  moderatorPaymentsEnabled: true,
  defaultAmountUsd: 1,
  recipients: [],
  moderators: [],
};

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
    rulesAgreedAt: now(),
    ...partial,
  };
}

async function seeded(): Promise<InMemoryAuthStore> {
  const authStore = new InMemoryAuthStore();
  await authStore.createAccount(account({ id: FOUNDER, role: 'founder', name: 'Founder' }));
  await authStore.createAccount(account({ id: INITIATOR, role: 'initiator', name: 'Initiator' }));
  await authStore.createAccount(account({ id: MOD, role: 'moderator', name: 'Mod' }));
  await authStore.createAccount(account({ id: VERIFIED, role: 'verified', name: 'Ada' }));
  await authStore.createAccount(account({ id: BASIS, role: 'basis', name: 'Basis' }));
  await authStore.createSession({ token: 'founder', accountId: FOUNDER, createdAt: now() });
  await authStore.createSession({ token: 'initiator', accountId: INITIATOR, createdAt: now() });
  await authStore.createSession({ token: 'mod', accountId: MOD, createdAt: now() });
  await authStore.createSession({ token: 'verified', accountId: VERIFIED, createdAt: now() });
  await authStore.createSession({ token: 'basis', accountId: BASIS, createdAt: now() });
  return authStore;
}

function fakeStore(overrides: Partial<DailyRosterStore> = {}): DailyRosterStore {
  const fallback = new InMemoryDailyRosterStore(DOCUMENT);
  return {
    get: overrides.get ?? (async () => DOCUMENT),
    hasBeenWritten: overrides.hasBeenWritten ?? (async () => true),
    setComment: overrides.setComment ?? ((comment) => fallback.setComment(comment)),
    setPaymentsEnabled:
      overrides.setPaymentsEnabled ?? ((enabled) => fallback.setPaymentsEnabled(enabled)),
    setModeratorPaymentsEnabled:
      overrides.setModeratorPaymentsEnabled ??
      ((enabled) => fallback.setModeratorPaymentsEnabled(enabled)),
    addRecipient:
      overrides.addRecipient ?? ((address, amountUsd) => fallback.addRecipient(address, amountUsd)),
    updateRecipient:
      overrides.updateRecipient ??
      ((address, amountUsd) => fallback.updateRecipient(address, amountUsd)),
    deleteRecipient: overrides.deleteRecipient ?? ((address) => fallback.deleteRecipient(address)),
    addModerator:
      overrides.addModerator ?? ((address, amountUsd) => fallback.addModerator(address, amountUsd)),
    updateModerator:
      overrides.updateModerator ??
      ((address, amountUsd) => fallback.updateModerator(address, amountUsd)),
    deleteModerator: overrides.deleteModerator ?? ((address) => fallback.deleteModerator(address)),
    importDocument: overrides.importDocument ?? ((body) => fallback.importDocument(body)),
  };
}

function mount(
  authStore: InMemoryAuthStore,
  rosterStore?: DailyRosterStore,
  spendApiToken?: string,
): Hono {
  return new Hono().route(
    '/funding',
    fundingRoutes({
      authStore,
      fundingStore: new InMemoryFundingStore(),
      messageStore: new InMemoryMessageStore(),
      now,
      gifts: new InMemoryGiftStore(),
      ...(rosterStore === undefined ? {} : { rosterStore }),
      ...(spendApiToken === undefined ? {} : { spendApiToken }),
    }),
  );
}

function post(
  app: Hono,
  path: string,
  token: string | undefined,
  body?: unknown,
): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

function get(app: Hono, path: string, token: string | undefined): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: 'GET',
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    }),
  );
}

describe('daily payout roster routes', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    setDiagnosticSink(null);
  });

  it('returns 200 for a founder and the roster JSON only', async () => {
    const authStore = await seeded();
    const res = await get(mount(authStore, fakeStore()), '/funding/daily-roster', 'founder');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(PUBLIC_ROSTER);
    const events = parsedEvents(warn).filter((event) => event['event'] === 'funding.daily_roster');
    expect(events).toEqual([expect.objectContaining({ accountId: FOUNDER, action: 'read' })]);
    expect(JSON.stringify(events)).not.toContain('ada@example.com');
    expect(JSON.stringify(events)).not.toContain('test-token');
    expect(JSON.stringify(events)).not.toContain('thanks');
  });

  it('returns 200 for an initiator', async () => {
    let seen = '';
    const authStore = await seeded();
    const res = await post(
      mount(
        authStore,
        fakeStore({
          setComment: async (comment) => {
            seen = comment;
            return { ...DOCUMENT, comment };
          },
        }),
      ),
      '/funding/daily-roster/comment',
      'initiator',
      { comment: 'hush-comment' },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...PUBLIC_ROSTER, comment: 'hush-comment' });
    expect(seen).toBe('hush-comment');
    expect(JSON.stringify(parsedEvents(warn))).not.toContain('hush-comment');
    expect(JSON.stringify(parsedEvents(warn))).not.toContain('test-token');
  });

  it('returns 403 for a moderator', async () => {
    const authStore = await seeded();
    const app = mount(authStore);
    const res = await get(app, '/funding/daily-roster', 'mod');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    for (const path of POSTS) {
      const posted = await post(app, path, 'mod', {});
      expect(posted.status).toBe(403);
      expect(await posted.json()).toEqual({ error: 'Forbidden' });
    }
  });

  it('returns 403 for a verified member', async () => {
    const authStore = await seeded();
    const res = await get(mount(authStore, fakeStore()), '/funding/daily-roster', 'verified');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('returns 403 for a basis member', async () => {
    const authStore = await seeded();
    const res = await get(mount(authStore, fakeStore()), '/funding/daily-roster', 'basis');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('returns 401 for an anonymous caller', async () => {
    const authStore = await seeded();
    const app = mount(authStore, fakeStore());
    const res = await get(app, '/funding/daily-roster', undefined);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    for (const path of POSTS) {
      const posted = await post(app, path, undefined, {});
      expect(posted.status).toBe(401);
      expect(await posted.json()).toEqual({ error: 'Unauthorized' });
    }
  });

  it('returns 200 empty public roster for a founder when the store was omitted', async () => {
    const authStore = await seeded();
    const app = mount(authStore);
    const res = await get(app, '/funding/daily-roster', 'founder');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      comment: '',
      paymentsEnabled: true,
      defaultAmountUsd: 1,
      recipients: [],
    });
  });

  it('forwards spend 400 Address already listed', async () => {
    let seen: { address: string; amountUsd: number } | undefined;
    const authStore = await seeded();
    const memberId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await authStore.createAccount(
      account({
        id: memberId,
        role: 'verified',
        lightningAddress: 'hide-me@example.com',
      }),
    );
    const res = await post(
      mount(
        authStore,
        fakeStore({
          addRecipient: async (address, amountUsd) => {
            seen = { address, amountUsd };
            throw new DailyRosterRequestError(400, 'Address already listed');
          },
        }),
      ),
      '/funding/daily-roster/recipients',
      'founder',
      { accountId: memberId, amountUsd: 5 },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Address already listed' });
    expect(seen).toEqual({ address: 'hide-me@example.com', amountUsd: 5 });
    const logged = JSON.stringify(parsedEvents(warn));
    expect(logged).not.toContain('hide-me@example.com');
    expect(logged).not.toContain(memberId);
    expect(logged).not.toContain('test-token');
  });

  it('returns 400 Unknown person and does not call spend when the account is missing', async () => {
    let called = false;
    const authStore = await seeded();
    const missingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const res = await post(
      mount(
        authStore,
        fakeStore({
          addRecipient: async () => {
            called = true;
            return DOCUMENT;
          },
        }),
      ),
      '/funding/daily-roster/recipients',
      'founder',
      { accountId: missingId, amountUsd: 5 },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unknown person' });
    expect(called).toBe(false);
  });

  it('returns 400 Person has no Lightning address and does not call spend when the address is blank', async () => {
    let called = false;
    const authStore = await seeded();
    const noneId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const blankId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await authStore.createAccount(
      account({ id: noneId, role: 'verified', lightningAddress: null }),
    );
    await authStore.createAccount(
      account({ id: blankId, role: 'verified', lightningAddress: '   ' }),
    );
    const app = mount(
      authStore,
      fakeStore({
        addRecipient: async () => {
          called = true;
          return DOCUMENT;
        },
      }),
    );
    for (const accountId of [noneId, blankId]) {
      const res = await post(app, '/funding/daily-roster/recipients', 'founder', {
        accountId,
        amountUsd: 5,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Person has no Lightning address' });
    }
    expect(called).toBe(false);
  });

  it('trims the stored Lightning address and does not lowercase it', async () => {
    let seen: { address: string; amountUsd: number } | undefined;
    const authStore = await seeded();
    const memberId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    await authStore.createAccount(
      account({
        id: memberId,
        role: 'verified',
        lightningAddress: '  Hide-Me@Example.com  ',
      }),
    );
    const res = await post(
      mount(
        authStore,
        fakeStore({
          addRecipient: async (address, amountUsd) => {
            seen = { address, amountUsd };
            return DOCUMENT;
          },
        }),
      ),
      '/funding/daily-roster/recipients',
      'founder',
      { accountId: memberId, amountUsd: 5 },
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual({ address: 'Hide-Me@Example.com', amountUsd: 5 });
  });

  it('returns 502 when loading the person throws and does not call spend', async () => {
    let called = false;
    const authStore = await seeded();
    const memberId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    await authStore.createAccount(
      account({
        id: memberId,
        role: 'verified',
        name: 'Leaked Name',
        lightningAddress: 'hide-me@example.com',
      }),
    );
    const inner = authStore.getAccount.bind(authStore);
    vi.spyOn(authStore, 'getAccount').mockImplementation(async (id) => {
      if (id === memberId) {
        throw new Error('person leaked');
      }
      return inner(id);
    });
    const res = await post(
      mount(
        authStore,
        fakeStore({
          addRecipient: async () => {
            called = true;
            return DOCUMENT;
          },
        }),
      ),
      '/funding/daily-roster/recipients',
      'founder',
      { accountId: memberId, amountUsd: 5 },
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Daily roster is unavailable' });
    expect(called).toBe(false);
    const events = parsedEvents(warn).filter(
      (event) => event['event'] === 'funding.daily_roster.failed',
    );
    expect(events).toEqual([
      expect.objectContaining({ accountId: FOUNDER, action: 'recipient-add' }),
    ]);
    const logged = JSON.stringify(events);
    expect(logged).not.toContain('hide-me@example.com');
    expect(logged).not.toContain(memberId);
    expect(logged).not.toContain('person leaked');
    expect(logged).not.toContain('Leaked Name');
  });

  it('returns 400 Invalid person or amount and does not call spend when the body is still an address', async () => {
    let called = false;
    const authStore = await seeded();
    const res = await post(
      mount(
        authStore,
        fakeStore({
          addRecipient: async () => {
            called = true;
            return DOCUMENT;
          },
        }),
      ),
      '/funding/daily-roster/recipients',
      'founder',
      { address: 'hide-me@example.com', amountUsd: 5 },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid person or amount' });
    expect(called).toBe(false);
  });

  it('returns 400 Invalid person or amount and does not call spend when the account id is not a uuid', async () => {
    let called = false;
    const authStore = await seeded();
    const res = await post(
      mount(
        authStore,
        fakeStore({
          addRecipient: async () => {
            called = true;
            return DOCUMENT;
          },
        }),
      ),
      '/funding/daily-roster/recipients',
      'founder',
      { accountId: 'not-a-uuid', amountUsd: 5 },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid person or amount' });
    expect(called).toBe(false);
  });

  it('returns 400 Invalid person or amount and does not call spend when the amount is a numeric string', async () => {
    let called = false;
    const authStore = await seeded();
    const res = await post(
      mount(
        authStore,
        fakeStore({
          addRecipient: async () => {
            called = true;
            return DOCUMENT;
          },
        }),
      ),
      '/funding/daily-roster/recipients',
      'founder',
      { accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', amountUsd: '1' },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid person or amount' });
    expect(called).toBe(false);
  });

  it('proxies each founder edit to the matching client method', async () => {
    const calls: string[] = [];
    const authStore = await seeded();
    const app = mount(
      authStore,
      fakeStore({
        setPaymentsEnabled: async (enabled) => {
          calls.push(`payments:${String(enabled)}`);
          return DOCUMENT;
        },
        updateRecipient: async (address, amountUsd) => {
          calls.push(`update:${address}:${amountUsd}`);
          return DOCUMENT;
        },
        deleteRecipient: async (address) => {
          calls.push(`delete:${address}`);
          return DOCUMENT;
        },
      }),
    );
    expect(
      (await post(app, '/funding/daily-roster/payments', 'founder', { enabled: false })).status,
    ).toBe(200);
    expect(
      (
        await post(app, '/funding/daily-roster/recipients/update', 'founder', {
          address: 'hide-me@example.com',
          amountUsd: 8,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(app, '/funding/daily-roster/recipients/delete', 'founder', {
          address: 'hide-me@example.com',
        })
      ).status,
    ).toBe(200);
    expect(calls).toEqual([
      'payments:false',
      'update:hide-me@example.com:8',
      'delete:hide-me@example.com',
    ]);
    expect(JSON.stringify(parsedEvents(warn))).not.toContain('hide-me@example.com');
  });

  it('returns 400 Invalid comment and does not call spend for a bad body', async () => {
    let called = false;
    const authStore = await seeded();
    const res = await post(
      mount(
        authStore,
        fakeStore({
          setComment: async () => {
            called = true;
            return DOCUMENT;
          },
        }),
      ),
      '/funding/daily-roster/comment',
      'founder',
      { comment: 1 },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid comment' });
    expect(called).toBe(false);
  });

  it('folds newlines, trims, and proxies an empty comment', async () => {
    let seen = 'unset';
    const authStore = await seeded();
    const client = fakeStore({
      setComment: async (comment) => {
        seen = comment;
        return { ...DOCUMENT, comment };
      },
    });
    const folded = await post(
      mount(authStore, client),
      '/funding/daily-roster/comment',
      'founder',
      { comment: '  a\r\nb\nc\rd  ' },
    );
    expect(folded.status).toBe(200);
    expect(seen).toBe('a b c d');
    expect(JSON.stringify(parsedEvents(warn))).not.toContain('a b c d');
    const empty = await post(mount(authStore, client), '/funding/daily-roster/comment', 'founder', {
      comment: ' \n\r ',
    });
    expect(empty.status).toBe(200);
    expect(seen).toBe('');
  });

  it('returns 400 Invalid comment and does not call spend when the comment is longer than 500', async () => {
    let called = false;
    const authStore = await seeded();
    const tooLong = `  ${'a'.repeat(501)}\n`;
    const res = await post(
      mount(
        authStore,
        fakeStore({
          setComment: async () => {
            called = true;
            return DOCUMENT;
          },
        }),
      ),
      '/funding/daily-roster/comment',
      'founder',
      { comment: tooLong },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid comment' });
    expect(called).toBe(false);
    expect(JSON.stringify(parsedEvents(warn))).not.toContain('a'.repeat(501));
  });

  it('proxies a comment of exactly 500 characters after trim', async () => {
    let seen = '';
    const authStore = await seeded();
    const exact = 'b'.repeat(500);
    const res = await post(
      mount(
        authStore,
        fakeStore({
          setComment: async (comment) => {
            seen = comment;
            return { ...DOCUMENT, comment };
          },
        }),
      ),
      '/funding/daily-roster/comment',
      'founder',
      { comment: ` ${exact} ` },
    );
    expect(res.status).toBe(200);
    expect(seen).toBe(exact);
    expect(JSON.stringify(parsedEvents(warn))).not.toContain(exact);
  });

  it('createApp passes an injected roster client through to the route', async () => {
    const authStore = await seeded();
    const fetchImpl: FetchFn = () => Promise.reject(new Error('network is forbidden'));
    const app = createApp({
      authStore,
      now,
      fetchImpl,
      rosterStore: fakeStore(),
    });
    const res = await app.request('/funding/daily-roster', {
      headers: { authorization: 'Bearer founder' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(PUBLIC_ROSTER);
  });

  it('adds account id and trimmed name for a matching lightning address', async () => {
    const authStore = await seeded();
    const memberId = '88888888-8888-4888-8888-888888888888';
    await authStore.createAccount(
      account({
        id: memberId,
        role: 'verified',
        name: '  Ada  ',
        lightningAddress: '  ADA@example.com  ',
      }),
    );
    const roster: DailyRosterDocument = {
      comment: 'thanks',
      paymentsEnabled: true,
      defaultAmountUsd: 1,
      moderatorPaymentsEnabled: true,
      recipients: [
        { address: 'ada@example.com', amountUsd: 1 },
        { address: 'unknown@example.com', amountUsd: 2 },
      ],
      moderators: [],
    };
    const res = await get(
      mount(authStore, fakeStore({ get: async () => roster })),
      '/funding/daily-roster',
      'founder',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      comment: 'thanks',
      paymentsEnabled: true,
      defaultAmountUsd: 1,
      recipients: [
        { address: 'ada@example.com', amountUsd: 1, accountId: memberId, name: 'Ada' },
        { address: 'unknown@example.com', amountUsd: 2, accountId: null, name: null },
      ],
    });
    const events = parsedEvents(warn).filter((event) => event['event'] === 'funding.daily_roster');
    expect(events).toEqual([expect.objectContaining({ accountId: FOUNDER, action: 'read' })]);
    const logged = JSON.stringify(events);
    expect(logged).not.toContain('ada@example.com');
    expect(logged).not.toContain('unknown@example.com');
    expect(logged).not.toContain(memberId);
    expect(logged).not.toContain('Ada');
  });

  it('returns 400 and does not call spend when the body is not the documented JSON', async () => {
    let called = false;
    const authStore = await seeded();
    const app = mount(
      authStore,
      fakeStore({
        setComment: async () => {
          called = true;
          return DOCUMENT;
        },
        setPaymentsEnabled: async () => {
          called = true;
          return DOCUMENT;
        },
        addRecipient: async () => {
          called = true;
          return DOCUMENT;
        },
        updateRecipient: async () => {
          called = true;
          return DOCUMENT;
        },
        deleteRecipient: async () => {
          called = true;
          return DOCUMENT;
        },
      }),
    );
    const cases = [
      ['/funding/daily-roster/comment', 'Invalid comment'],
      ['/funding/daily-roster/payments', 'Invalid payments switch'],
      ['/funding/daily-roster/recipients', 'Invalid person or amount'],
      ['/funding/daily-roster/recipients/update', 'Unknown address'],
      ['/funding/daily-roster/recipients/delete', 'Unknown address'],
    ] as const;
    for (const [path, error] of cases) {
      const res = await app.request(path, {
        method: 'POST',
        headers: {
          authorization: 'Bearer founder',
          'content-type': 'application/json',
        },
        body: '{',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error });
    }
    const badAmount = await app.request('/funding/daily-roster/recipients/update', {
      method: 'POST',
      headers: {
        authorization: 'Bearer founder',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ address: 'ada@example.com', amountUsd: '1' }),
    });
    expect(badAmount.status).toBe(400);
    expect(await badAmount.json()).toEqual({ error: 'Invalid address or amount' });
    for (const body of ['[]', '1', JSON.stringify({ address: 1, amountUsd: 1 })]) {
      const res = await app.request('/funding/daily-roster/recipients/update', {
        method: 'POST',
        headers: {
          authorization: 'Bearer founder',
          'content-type': 'application/json',
        },
        body,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Unknown address' });
    }
    expect(called).toBe(false);
  });

  it('returns 502 when spend fails and does not log the failure text', async () => {
    const authStore = await seeded();
    const app = mount(
      authStore,
      fakeStore({
        get: async () => {
          throw new DailyRosterRequestError(502, 'Daily roster is unavailable');
        },
        setComment: async () => {
          throw new Error('comment leaked');
        },
      }),
    );
    const read = await get(app, '/funding/daily-roster', 'founder');
    expect(read.status).toBe(502);
    expect(await read.json()).toEqual({ error: 'Daily roster is unavailable' });
    const comment = await post(app, '/funding/daily-roster/comment', 'founder', { comment: 'x' });
    expect(comment.status).toBe(502);
    expect(await comment.json()).toEqual({ error: 'Daily roster is unavailable' });
    const logged = JSON.stringify(parsedEvents(warn));
    expect(logged).toContain('funding.daily_roster.failed');
    expect(logged).not.toContain('comment leaked');
    expect(logged).not.toContain('test-token');
    expect(logged).not.toContain('ada@example.com');
  });

  it('does not mix moderators into the public daily list', async () => {
    const authStore = await seeded();
    const store = new InMemoryDailyRosterStore({
      comment: 'thanks',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
      defaultAmountUsd: 1,
      recipients: [{ address: 'ada@example.com', amountUsd: 1 }],
      moderators: [{ address: 'mod@example.com', amountUsd: 3 }],
    });
    const res = await get(mount(authStore, store), '/funding/daily-roster', 'founder');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(PUBLIC_ROSTER);
  });

  it('returns 503 then 401 on the full document routes like invoices', async () => {
    const authStore = await seeded();
    const omitted = mount(authStore, fakeStore());
    const unconfigured = await omitted.request('/funding/daily-roster/document');
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toEqual({ error: 'Spend invoices are not configured' });
    const posted = await omitted.request('/funding/daily-roster/document', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(posted.status).toBe(503);
    const app = mount(authStore, fakeStore(), 'spend-secret');
    const unauthorized = await app.request('/funding/daily-roster/document', {
      headers: { authorization: 'Bearer nope' },
    });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: 'Unauthorized' });
  });

  it('reads and imports the full document, then ignores a second import', async () => {
    const authStore = await seeded();
    const store = new InMemoryDailyRosterStore();
    const app = mount(authStore, store, 'spend-secret');
    const empty = await app.request('/funding/daily-roster/document', {
      headers: { authorization: 'Bearer spend-secret' },
    });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({
      comment: '',
      paymentsEnabled: true,
      moderatorPaymentsEnabled: true,
      defaultAmountUsd: 1,
      recipients: [],
      moderators: [],
    });
    const imported = await app.request('/funding/daily-roster/document', {
      method: 'POST',
      headers: {
        authorization: 'Bearer spend-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        comment: 'thanks',
        paymentsEnabled: false,
        moderatorPaymentsEnabled: false,
        defaultAmountUsd: 9,
        recipients: [{ address: 'ada@example.com', amountUsd: 2 }],
        moderators: [{ address: 'mod@example.com', amountUsd: 3 }],
      }),
    });
    expect(imported.status).toBe(200);
    const body = await imported.json();
    expect(body).toEqual({
      comment: 'thanks',
      paymentsEnabled: false,
      moderatorPaymentsEnabled: false,
      defaultAmountUsd: 1,
      recipients: [{ address: 'ada@example.com', amountUsd: 2 }],
      moderators: [{ address: 'mod@example.com', amountUsd: 3 }],
    });
    const second = await app.request('/funding/daily-roster/document', {
      method: 'POST',
      headers: {
        authorization: 'Bearer spend-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ comment: 1, paymentsEnabled: true }),
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(body);
    const logged = JSON.stringify(parsedEvents(warn));
    expect(logged).not.toContain('spend-secret');
    expect(logged).not.toContain('thanks');
    expect(logged).not.toContain('ada@example.com');
  });

  it('returns 400 then 502 on the full document write', async () => {
    const authStore = await seeded();
    const bad = await mount(authStore, new InMemoryDailyRosterStore(), 'spend-secret').request(
      '/funding/daily-roster/document',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer spend-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ paymentsEnabled: 'on' }),
      },
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Invalid payments switch' });
    const app = mount(
      authStore,
      fakeStore({
        get: async () => {
          throw new DailyRosterRequestError(400, 'Invalid comment');
        },
        importDocument: async () => {
          throw new Error('import leaked');
        },
      }),
      'spend-secret',
    );
    const read400 = await app.request('/funding/daily-roster/document', {
      headers: { authorization: 'Bearer spend-secret' },
    });
    expect(read400.status).toBe(400);
    expect(await read400.json()).toEqual({ error: 'Invalid comment' });
    const read502 = await mount(
      authStore,
      fakeStore({
        get: async () => {
          throw new Error('read leaked');
        },
      }),
      'spend-secret',
    ).request('/funding/daily-roster/document', {
      headers: { authorization: 'Bearer spend-secret' },
    });
    expect(read502.status).toBe(502);
    const malformed = await mount(
      authStore,
      new InMemoryDailyRosterStore(),
      'spend-secret',
    ).request('/funding/daily-roster/document', {
      method: 'POST',
      headers: {
        authorization: 'Bearer spend-secret',
        'content-type': 'application/json',
      },
      body: '{',
    });
    expect(malformed.status).toBe(400);
    const failed = await app.request('/funding/daily-roster/document', {
      method: 'POST',
      headers: {
        authorization: 'Bearer spend-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: 'Daily roster is unavailable' });
    const logged = JSON.stringify(parsedEvents(warn));
    expect(logged).not.toContain('import leaked');
    expect(logged).not.toContain('spend-secret');
  });

  it('returns 503 then 401 on the worker write routes like invoices', async () => {
    const authStore = await seeded();
    const omitted = mount(authStore, fakeStore());
    for (const path of WORKER_POSTS) {
      const res = await omitted.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Spend invoices are not configured' });
    }
    const app = mount(authStore, fakeStore(), 'spend-secret');
    for (const path of WORKER_POSTS) {
      const missing = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(missing.status).toBe(401);
      expect(await missing.json()).toEqual({ error: 'Unauthorized' });
      const bad = await app.request(path, {
        method: 'POST',
        headers: {
          authorization: 'Bearer nope',
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      expect(bad.status).toBe(401);
      expect(await bad.json()).toEqual({ error: 'Unauthorized' });
    }
  });

  it('writes worker comment, payments, and moderator payments as the full document', async () => {
    const authStore = await seeded();
    const store = new InMemoryDailyRosterStore();
    const app = mount(authStore, store, 'spend-secret');
    const folded = await post(app, '/funding/daily-roster/worker/comment', 'spend-secret', {
      comment: '  hush-comment\nthere  ',
    });
    expect(folded.status).toBe(200);
    expect(await folded.json()).toEqual({
      ...EMPTY_DOCUMENT,
      comment: 'hush-comment there',
    });
    const empty = await post(app, '/funding/daily-roster/worker/comment', 'spend-secret', {
      comment: ' \n\r ',
    });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual(EMPTY_DOCUMENT);
    const payments = await post(app, '/funding/daily-roster/worker/payments', 'spend-secret', {
      enabled: false,
    });
    expect(payments.status).toBe(200);
    expect(await payments.json()).toEqual({ ...EMPTY_DOCUMENT, paymentsEnabled: false });
    const moderatorPayments = await post(
      app,
      '/funding/daily-roster/worker/moderators/payments',
      'spend-secret',
      { enabled: false },
    );
    expect(moderatorPayments.status).toBe(200);
    const body = await moderatorPayments.json();
    expect(body).toEqual({
      ...EMPTY_DOCUMENT,
      paymentsEnabled: false,
      moderatorPaymentsEnabled: false,
    });
    expect(body).not.toHaveProperty('accountId');
    expect(JSON.stringify(body)).not.toContain('"name"');
    const logged = JSON.stringify(parsedEvents(warn));
    expect(logged).not.toContain('spend-secret');
    expect(logged).not.toContain('hush-comment');
    expect(logged).not.toContain('ada@example.com');
  });

  it('returns 400 Invalid comment and Invalid payments switch on worker routes', async () => {
    let called = false;
    const authStore = await seeded();
    const app = mount(
      authStore,
      fakeStore({
        setComment: async () => {
          called = true;
          return DOCUMENT;
        },
        setPaymentsEnabled: async () => {
          called = true;
          return DOCUMENT;
        },
        setModeratorPaymentsEnabled: async () => {
          called = true;
          return DOCUMENT;
        },
      }),
      'spend-secret',
    );
    const comment = await post(app, '/funding/daily-roster/worker/comment', 'spend-secret', {
      comment: 1,
    });
    expect(comment.status).toBe(400);
    expect(await comment.json()).toEqual({ error: 'Invalid comment' });
    const tooLong = await post(app, '/funding/daily-roster/worker/comment', 'spend-secret', {
      comment: `  ${'a'.repeat(501)}\n`,
    });
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toEqual({ error: 'Invalid comment' });
    const payments = await post(app, '/funding/daily-roster/worker/payments', 'spend-secret', {
      enabled: 'on',
    });
    expect(payments.status).toBe(400);
    expect(await payments.json()).toEqual({ error: 'Invalid payments switch' });
    const moderatorPayments = await post(
      app,
      '/funding/daily-roster/worker/moderators/payments',
      'spend-secret',
      { enabled: 1 },
    );
    expect(moderatorPayments.status).toBe(400);
    expect(await moderatorPayments.json()).toEqual({ error: 'Invalid payments switch' });
    expect(called).toBe(false);
    const logged = JSON.stringify(parsedEvents(warn));
    expect(logged).not.toContain('spend-secret');
    expect(logged).not.toContain('a'.repeat(501));
  });

  it('adds, updates, and deletes worker recipients as the full document', async () => {
    const authStore = await seeded();
    await authStore.createAccount(
      account({
        id: '88888888-8888-4888-8888-888888888888',
        role: 'verified',
        name: 'Ada',
        lightningAddress: 'ada@example.com',
      }),
    );
    const store = new InMemoryDailyRosterStore();
    const app = mount(authStore, store, 'spend-secret');
    const added = await post(app, '/funding/daily-roster/worker/recipients', 'spend-secret', {
      address: '  Ada@Example.com  ',
      amountUsd: 2,
    });
    expect(added.status).toBe(200);
    expect(await added.json()).toEqual({
      ...EMPTY_DOCUMENT,
      recipients: [{ address: 'ada@example.com', amountUsd: 2 }],
    });
    const duplicate = await post(app, '/funding/daily-roster/worker/recipients', 'spend-secret', {
      address: 'ADA@example.com',
      amountUsd: 3,
    });
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toEqual({ error: 'Address already listed' });
    const updated = await post(
      app,
      '/funding/daily-roster/worker/recipients/update',
      'spend-secret',
      { address: ' ADA@EXAMPLE.COM ', amountUsd: 8 },
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({
      ...EMPTY_DOCUMENT,
      recipients: [{ address: 'ada@example.com', amountUsd: 8 }],
    });
    const deleted = await post(
      app,
      '/funding/daily-roster/worker/recipients/delete',
      'spend-secret',
      { address: 'Ada@example.com' },
    );
    expect(deleted.status).toBe(200);
    const body = await deleted.json();
    expect(body).toEqual(EMPTY_DOCUMENT);
    expect(JSON.stringify(body)).not.toContain('accountId');
    expect(JSON.stringify(body)).not.toContain('"name"');
    const logged = JSON.stringify(parsedEvents(warn));
    expect(logged).not.toContain('spend-secret');
    expect(logged).not.toContain('ada@example.com');
    expect(logged).not.toContain('Ada@Example.com');
  });

  it('adds, updates, and deletes worker moderators as the full document', async () => {
    const authStore = await seeded();
    const store = new InMemoryDailyRosterStore();
    const app = mount(authStore, store, 'spend-secret');
    const added = await post(app, '/funding/daily-roster/worker/moderators', 'spend-secret', {
      address: 'mod@example.com',
      amountUsd: 3,
    });
    expect(added.status).toBe(200);
    expect(await added.json()).toEqual({
      ...EMPTY_DOCUMENT,
      moderators: [{ address: 'mod@example.com', amountUsd: 3 }],
    });
    const duplicate = await post(app, '/funding/daily-roster/worker/moderators', 'spend-secret', {
      address: 'mod@example.com',
      amountUsd: 4,
    });
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toEqual({ error: 'Address already listed' });
    const updated = await post(
      app,
      '/funding/daily-roster/worker/moderators/update',
      'spend-secret',
      { address: 'mod@example.com', amountUsd: 5 },
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({
      ...EMPTY_DOCUMENT,
      moderators: [{ address: 'mod@example.com', amountUsd: 5 }],
    });
    const deleted = await post(
      app,
      '/funding/daily-roster/worker/moderators/delete',
      'spend-secret',
      { address: 'mod@example.com' },
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual(EMPTY_DOCUMENT);
    const logged = JSON.stringify(parsedEvents(warn));
    expect(logged).not.toContain('spend-secret');
    expect(logged).not.toContain('mod@example.com');
  });

  it('returns 400 Invalid address or amount and Unknown address on worker list writes', async () => {
    let called = false;
    const authStore = await seeded();
    const app = mount(
      authStore,
      fakeStore({
        addRecipient: async () => {
          called = true;
          return DOCUMENT;
        },
        updateRecipient: async () => {
          called = true;
          return DOCUMENT;
        },
        deleteRecipient: async () => {
          called = true;
          return DOCUMENT;
        },
        addModerator: async () => {
          called = true;
          return DOCUMENT;
        },
        updateModerator: async () => {
          called = true;
          return DOCUMENT;
        },
        deleteModerator: async () => {
          called = true;
          return DOCUMENT;
        },
      }),
      'spend-secret',
    );
    const addCases = [
      '/funding/daily-roster/worker/recipients',
      '/funding/daily-roster/worker/moderators',
    ] as const;
    for (const path of addCases) {
      for (const body of [
        { address: 1, amountUsd: 1 },
        { address: 'ada@example.com', amountUsd: '1' },
        { address: 'ada@example.com' },
        { amountUsd: 1 },
      ]) {
        const res = await post(app, path, 'spend-secret', body);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'Invalid address or amount' });
      }
    }
    const store = new InMemoryDailyRosterStore();
    const live = mount(authStore, store, 'spend-secret');
    const zero = await post(live, '/funding/daily-roster/worker/recipients', 'spend-secret', {
      address: 'ada@example.com',
      amountUsd: 0,
    });
    expect(zero.status).toBe(400);
    expect(await zero.json()).toEqual({ error: 'Invalid address or amount' });
    const blank = await post(live, '/funding/daily-roster/worker/moderators', 'spend-secret', {
      address: '   ',
      amountUsd: 1,
    });
    expect(blank.status).toBe(400);
    expect(await blank.json()).toEqual({ error: 'Invalid address or amount' });
    const nan = await live.request('/funding/daily-roster/worker/recipients', {
      method: 'POST',
      headers: {
        authorization: 'Bearer spend-secret',
        'content-type': 'application/json',
      },
      body: '{"address":"ada@example.com","amountUsd":null}',
    });
    expect(nan.status).toBe(400);
    expect(await nan.json()).toEqual({ error: 'Invalid address or amount' });
    for (const path of [
      '/funding/daily-roster/worker/recipients/update',
      '/funding/daily-roster/worker/moderators/update',
    ] as const) {
      const badAmount = await post(app, path, 'spend-secret', {
        address: 'ada@example.com',
        amountUsd: '1',
      });
      expect(badAmount.status).toBe(400);
      expect(await badAmount.json()).toEqual({ error: 'Invalid address or amount' });
      for (const body of [{ address: 1, amountUsd: 1 }, { amountUsd: 1 }, {}]) {
        const res = await post(app, path, 'spend-secret', body);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'Unknown address' });
      }
    }
    for (const path of [
      '/funding/daily-roster/worker/recipients/delete',
      '/funding/daily-roster/worker/moderators/delete',
    ] as const) {
      const res = await post(app, path, 'spend-secret', {});
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Unknown address' });
    }
    const unknownUpdate = await post(
      live,
      '/funding/daily-roster/worker/recipients/update',
      'spend-secret',
      { address: 'missing@example.com', amountUsd: 1 },
    );
    expect(unknownUpdate.status).toBe(400);
    expect(await unknownUpdate.json()).toEqual({ error: 'Unknown address' });
    const unknownDelete = await post(
      live,
      '/funding/daily-roster/worker/moderators/delete',
      'spend-secret',
      { address: 'missing@example.com' },
    );
    expect(unknownDelete.status).toBe(400);
    expect(await unknownDelete.json()).toEqual({ error: 'Unknown address' });
    expect(called).toBe(false);
    const logged = JSON.stringify(parsedEvents(warn));
    expect(logged).not.toContain('spend-secret');
    expect(logged).not.toContain('ada@example.com');
    expect(logged).not.toContain('missing@example.com');
  });

  it('returns 400 of the worker validation text for a non-JSON body', async () => {
    let called = false;
    const authStore = await seeded();
    const app = mount(
      authStore,
      fakeStore({
        setComment: async () => {
          called = true;
          return DOCUMENT;
        },
        setPaymentsEnabled: async () => {
          called = true;
          return DOCUMENT;
        },
        setModeratorPaymentsEnabled: async () => {
          called = true;
          return DOCUMENT;
        },
        addRecipient: async () => {
          called = true;
          return DOCUMENT;
        },
        updateRecipient: async () => {
          called = true;
          return DOCUMENT;
        },
        deleteRecipient: async () => {
          called = true;
          return DOCUMENT;
        },
        addModerator: async () => {
          called = true;
          return DOCUMENT;
        },
        updateModerator: async () => {
          called = true;
          return DOCUMENT;
        },
        deleteModerator: async () => {
          called = true;
          return DOCUMENT;
        },
      }),
      'spend-secret',
    );
    const cases = [
      ['/funding/daily-roster/worker/comment', 'Invalid comment'],
      ['/funding/daily-roster/worker/payments', 'Invalid payments switch'],
      ['/funding/daily-roster/worker/recipients', 'Invalid address or amount'],
      ['/funding/daily-roster/worker/recipients/update', 'Unknown address'],
      ['/funding/daily-roster/worker/recipients/delete', 'Unknown address'],
      ['/funding/daily-roster/worker/moderators', 'Invalid address or amount'],
      ['/funding/daily-roster/worker/moderators/update', 'Unknown address'],
      ['/funding/daily-roster/worker/moderators/delete', 'Unknown address'],
      ['/funding/daily-roster/worker/moderators/payments', 'Invalid payments switch'],
    ] as const;
    for (const [path, error] of cases) {
      const res = await app.request(path, {
        method: 'POST',
        headers: {
          authorization: 'Bearer spend-secret',
          'content-type': 'application/json',
        },
        body: '{',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error });
    }
    expect(called).toBe(false);
  });

  it('returns 502 when a worker store write throws and does not log secrets', async () => {
    const authStore = await seeded();
    const app = mount(
      authStore,
      fakeStore({
        setComment: async () => {
          throw new Error('comment leaked');
        },
        setPaymentsEnabled: async () => {
          throw new Error('payments leaked');
        },
        setModeratorPaymentsEnabled: async () => {
          throw new Error('moderator payments leaked');
        },
        addRecipient: async () => {
          throw new Error('recipient leaked');
        },
        updateRecipient: async () => {
          throw new DailyRosterRequestError(502, 'update leaked');
        },
        deleteRecipient: async () => {
          throw new Error('delete leaked');
        },
        addModerator: async () => {
          throw new Error('moderator leaked');
        },
        updateModerator: async () => {
          throw new Error('moderator update leaked');
        },
        deleteModerator: async () => {
          throw new Error('moderator delete leaked');
        },
      }),
      'spend-secret',
    );
    const cases = [
      ['/funding/daily-roster/worker/comment', { comment: 'hush-comment' }],
      ['/funding/daily-roster/worker/payments', { enabled: true }],
      ['/funding/daily-roster/worker/moderators/payments', { enabled: true }],
      ['/funding/daily-roster/worker/recipients', { address: 'ada@example.com', amountUsd: 1 }],
      [
        '/funding/daily-roster/worker/recipients/update',
        { address: 'ada@example.com', amountUsd: 1 },
      ],
      ['/funding/daily-roster/worker/recipients/delete', { address: 'ada@example.com' }],
      ['/funding/daily-roster/worker/moderators', { address: 'mod@example.com', amountUsd: 3 }],
      [
        '/funding/daily-roster/worker/moderators/update',
        { address: 'mod@example.com', amountUsd: 3 },
      ],
      ['/funding/daily-roster/worker/moderators/delete', { address: 'mod@example.com' }],
    ] as const;
    for (const [path, body] of cases) {
      const res = await post(app, path, 'spend-secret', body);
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'Daily roster is unavailable' });
    }
    const logged = JSON.stringify(parsedEvents(warn));
    expect(logged).not.toContain('spend-secret');
    expect(logged).not.toContain('hush-comment');
    expect(logged).not.toContain('ada@example.com');
    expect(logged).not.toContain('mod@example.com');
    expect(logged).not.toContain('leaked');
  });
});
