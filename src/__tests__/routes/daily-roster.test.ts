import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import {
  DailyRosterRequestError,
  type DailyRoster,
  type DailyRosterClient,
} from '@/lib/daily-roster';
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
  defaultAmountUsd: 3,
  recipients: [{ address: 'ada@example.com', amountUsd: 1 }],
};

const POSTS = [
  '/funding/daily-roster/comment',
  '/funding/daily-roster/payments',
  '/funding/daily-roster/recipients',
  '/funding/daily-roster/recipients/update',
  '/funding/daily-roster/recipients/delete',
] as const;

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

function fakeRoster(overrides: Partial<DailyRosterClient> = {}): DailyRosterClient {
  return {
    get: overrides.get ?? (async () => ROSTER),
    setComment: overrides.setComment ?? (async () => ROSTER),
    setPaymentsEnabled: overrides.setPaymentsEnabled ?? (async () => ROSTER),
    addRecipient: overrides.addRecipient ?? (async () => ROSTER),
    updateRecipient: overrides.updateRecipient ?? (async () => ROSTER),
    deleteRecipient: overrides.deleteRecipient ?? (async () => ROSTER),
  };
}

function mount(authStore: InMemoryAuthStore, dailyRoster?: DailyRosterClient): Hono {
  return new Hono().route(
    '/funding',
    fundingRoutes({
      authStore,
      fundingStore: new InMemoryFundingStore(),
      messageStore: new InMemoryMessageStore(),
      now,
      gifts: new InMemoryGiftStore(),
      ...(dailyRoster === undefined ? {} : { dailyRoster }),
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
    const res = await get(mount(authStore, fakeRoster()), '/funding/daily-roster', 'founder');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ROSTER);
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
        fakeRoster({
          setComment: async (comment) => {
            seen = comment;
            return { ...ROSTER, comment };
          },
        }),
      ),
      '/funding/daily-roster/comment',
      'initiator',
      { comment: 'hush-comment' },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...ROSTER, comment: 'hush-comment' });
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
    const res = await get(mount(authStore, fakeRoster()), '/funding/daily-roster', 'verified');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('returns 403 for a basis member', async () => {
    const authStore = await seeded();
    const res = await get(mount(authStore, fakeRoster()), '/funding/daily-roster', 'basis');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('returns 401 for an anonymous caller', async () => {
    const authStore = await seeded();
    const app = mount(authStore, fakeRoster());
    const res = await get(app, '/funding/daily-roster', undefined);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    for (const path of POSTS) {
      const posted = await post(app, path, undefined, {});
      expect(posted.status).toBe(401);
      expect(await posted.json()).toEqual({ error: 'Unauthorized' });
    }
  });

  it('returns 503 for a founder when spend is not configured', async () => {
    const authStore = await seeded();
    const app = mount(authStore);
    const res = await get(app, '/funding/daily-roster', 'founder');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Daily roster is not configured' });
    const posted = await post(app, '/funding/daily-roster/comment', 'founder');
    expect(posted.status).toBe(503);
    expect(await posted.json()).toEqual({ error: 'Daily roster is not configured' });
  });

  it('forwards spend 400 Address already listed', async () => {
    let seen: { address: string; amountUsd: number } | undefined;
    const authStore = await seeded();
    const res = await post(
      mount(
        authStore,
        fakeRoster({
          addRecipient: async (address, amountUsd) => {
            seen = { address, amountUsd };
            throw new DailyRosterRequestError(400, 'Address already listed');
          },
        }),
      ),
      '/funding/daily-roster/recipients',
      'founder',
      { address: 'hide-me@example.com', amountUsd: 5 },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Address already listed' });
    expect(seen).toEqual({ address: 'hide-me@example.com', amountUsd: 5 });
    expect(JSON.stringify(parsedEvents(warn))).not.toContain('hide-me@example.com');
    expect(JSON.stringify(parsedEvents(warn))).not.toContain('test-token');
  });

  it('proxies each founder edit to the matching client method', async () => {
    const calls: string[] = [];
    const authStore = await seeded();
    const app = mount(
      authStore,
      fakeRoster({
        setPaymentsEnabled: async (enabled) => {
          calls.push(`payments:${String(enabled)}`);
          return ROSTER;
        },
        updateRecipient: async (address, amountUsd) => {
          calls.push(`update:${address}:${amountUsd}`);
          return ROSTER;
        },
        deleteRecipient: async (address) => {
          calls.push(`delete:${address}`);
          return ROSTER;
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
        fakeRoster({
          setComment: async () => {
            called = true;
            return ROSTER;
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
    const client = fakeRoster({
      setComment: async (comment) => {
        seen = comment;
        return { ...ROSTER, comment };
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
        fakeRoster({
          setComment: async () => {
            called = true;
            return ROSTER;
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
        fakeRoster({
          setComment: async (comment) => {
            seen = comment;
            return { ...ROSTER, comment };
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
      dailyRoster: fakeRoster(),
    });
    const res = await app.request('/funding/daily-roster', {
      headers: { authorization: 'Bearer founder' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ROSTER);
  });

  it('returns 400 and does not call spend when the body is not the documented JSON', async () => {
    let called = false;
    const authStore = await seeded();
    const app = mount(
      authStore,
      fakeRoster({
        setComment: async () => {
          called = true;
          return ROSTER;
        },
        setPaymentsEnabled: async () => {
          called = true;
          return ROSTER;
        },
        addRecipient: async () => {
          called = true;
          return ROSTER;
        },
        updateRecipient: async () => {
          called = true;
          return ROSTER;
        },
        deleteRecipient: async () => {
          called = true;
          return ROSTER;
        },
      }),
    );
    const cases = [
      ['/funding/daily-roster/comment', 'Invalid comment'],
      ['/funding/daily-roster/payments', 'Invalid payments switch'],
      ['/funding/daily-roster/recipients', 'Invalid address or amount'],
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
      fakeRoster({
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
});
