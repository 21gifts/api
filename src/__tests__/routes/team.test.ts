import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore, type AccountRole } from '@/lib/auth/store';
import { InMemoryMemberDataStore, type TeamAccessRow } from '@/lib/member-data-store';
import { teamRoutes } from '@/routes/team';

const NOW = Date.UTC(2026, 9, 7);
const now = (): number => NOW;
const MEMBER = '11111111-1111-4111-8111-111111111111';
const CALLER = '22222222-2222-4222-8222-222222222222';
const GONE = '44444444-4444-4444-8444-444444444444';
const AUTH = { authorization: 'Bearer tok' };

class FailingStore extends InMemoryMemberDataStore {
  override appendAccess(): Promise<void> {
    return Promise.reject(new Error('audit down'));
  }

  override listAccess(): Promise<TeamAccessRow[]> {
    return Promise.reject(new Error('audit down'));
  }
}

async function setup(role: AccountRole): Promise<InMemoryAuthStore> {
  const auth = new InMemoryAuthStore();
  const add = async (id: string, name: string, accountRole: AccountRole, username: string) => {
    await auth.createAccount({
      id,
      linkingKey: null,
      role: accountRole,
      name,
      username,
      forumLawsDismissed: false,
      location: null,
      viewKey: id.replaceAll('-', '').padEnd(64, '0'),
      createdAt: NOW,
      rulesAgreedAt: NOW,
    });
  };
  await add(MEMBER, 'Mia', 'basis', 'mia');
  await add(CALLER, 'Cara', role, 'cara');
  await auth.createSession({ token: 'tok', accountId: CALLER, createdAt: NOW });
  return auth;
}

function mount(auth: InMemoryAuthStore, memberDataStore = new InMemoryMemberDataStore()): Hono {
  return new Hono().route('/team', teamRoutes({ authStore: auth, memberDataStore, now }));
}

function events(warn: ReturnType<typeof vi.spyOn>): string[] {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => (JSON.parse(arg) as { event: string }).event);
}

describe('teamRoutes', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  const paths = [
    '/team/members?query=mi',
    `/team/members/${MEMBER}/wallet`,
    `/team/members/${MEMBER}/events`,
    '/team/audit',
  ];

  it('answers 401 without a session or with an unknown token', async () => {
    const app = mount(await setup('founder'));
    for (const path of paths) {
      expect((await app.request(path)).status).toBe(401);
      const res = await app.request(path, { headers: { authorization: 'Bearer other' } });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
    }
  });

  it('answers 403 below moderator on every route', async () => {
    for (const role of ['basis', 'verified'] as const) {
      const store = new InMemoryMemberDataStore();
      const app = mount(await setup(role), store);
      for (const path of paths) {
        const res = await app.request(path, { headers: AUTH });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'Forbidden' });
      }
      expect(await store.listAccess(null, 10)).toEqual([]);
    }
  });

  it('searches members by name or username with their role', async () => {
    const app = mount(await setup('moderator'));
    const res = await app.request('/team/members?query=mi', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      members: [{ id: MEMBER, username: 'mia', name: 'Mia', role: 'basis' }],
    });
    const all = await app.request('/team/members', { headers: AUTH });
    expect(((await all.json()) as { members: unknown[] }).members).toHaveLength(2);
    const bad = await app.request('/team/members?query=%21%21', { headers: AUTH });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Invalid query' });
  });

  it('keeps a role of null when the account vanished between search and lookup', async () => {
    const auth = await setup('moderator');
    const realGet = auth.getAccount.bind(auth);
    auth.getAccount = (id: string) => (id === MEMBER ? Promise.resolve(undefined) : realGet(id));
    const res = await mount(auth).request('/team/members?query=mia', { headers: AUTH });
    expect(await res.json()).toEqual({
      members: [{ id: MEMBER, username: 'mia', name: 'Mia', role: null }],
    });
  });

  it('answers 503 when the search fails', async () => {
    const auth = await setup('moderator');
    auth.listAccountsByUsernamePrefix = () => Promise.reject(new Error('down'));
    const res = await mount(auth).request('/team/members?query=mi', { headers: AUTH });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Member data is unavailable' });
    expect(events(warn)).toContain('team.members.search_failed');
  });

  it('audits a wallet read, then returns the wallet view', async () => {
    const store = new InMemoryMemberDataStore();
    const app = mount(await setup('moderator'), store);
    const res = await app.request(`/team/members/${MEMBER.toUpperCase()}/wallet?period=7`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      member: { id: MEMBER, role: 'basis' },
      balance: null,
      period: '7',
      payments: [],
      nextCursor: null,
    });
    expect(await store.listAccess(null, 10)).toEqual([
      {
        id: expect.any(String) as string,
        viewerAccountId: CALLER,
        memberAccountId: MEMBER,
        what: 'wallet',
        at: new Date(NOW),
      },
    ]);
    expect(events(warn)).toContain('team.member_wallet.read');
  });

  it('writes no audit row for a 404 or 400 wallet read', async () => {
    const store = new InMemoryMemberDataStore();
    const app = mount(await setup('initiator'), store);
    expect((await app.request(`/team/members/${GONE}/wallet`, { headers: AUTH })).status).toBe(404);
    const bad = await app.request(`/team/members/${MEMBER}/wallet?direction=sideways`, {
      headers: AUTH,
    });
    expect(bad.status).toBe(400);
    expect(await store.listAccess(null, 10)).toEqual([]);
    expect(events(warn)).not.toContain('team.member_wallet.read');
  });

  it('answers 503 and reads nothing when the audit write fails', async () => {
    const app = mount(await setup('founder'), new FailingStore());
    const wallet = await app.request(`/team/members/${MEMBER}/wallet`, { headers: AUTH });
    expect(wallet.status).toBe(503);
    expect(await wallet.json()).toEqual({ error: 'Member data is unavailable' });
    const evts = await app.request(`/team/members/${MEMBER}/events`, { headers: AUTH });
    expect(evts.status).toBe(503);
    expect(events(warn)).toEqual(
      expect.arrayContaining(['team.member_wallet.failed', 'team.member_events.failed']),
    );
  });

  it('audits an events read, then returns the events view', async () => {
    const store = new InMemoryMemberDataStore({
      events: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          accountId: MEMBER,
          name: 'search',
          at: new Date(NOW - 1000),
          path: '/search',
          props: { query: 'bread', mnemonic: 'never' },
          receivedAt: new Date(NOW),
        },
      ],
    });
    const app = mount(await setup('moderator'), store);
    const res = await app.request(`/team/members/${MEMBER}/events`, { headers: AUTH });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('mnemonic');
    expect(JSON.parse(text)).toMatchObject({
      events: [{ name: 'search', path: '/search', props: { query: 'bread' } }],
      nextCursor: null,
    });
    expect((await store.listAccess(null, 10)).map((row) => row.what)).toEqual(['events']);
    expect(events(warn)).toContain('team.member_events.read');
    const bad = await app.request(`/team/members/${MEMBER}/events?cursor=x`, { headers: AUTH });
    expect(bad.status).toBe(400);
    expect(await store.listAccess(null, 10)).toHaveLength(1);
  });

  it('lists the audit log for initiator and founder, not for a moderator', async () => {
    const moderator = mount(await setup('moderator'));
    expect((await moderator.request('/team/audit', { headers: AUTH })).status).toBe(403);
    for (const role of ['initiator', 'founder'] as const) {
      const store = new InMemoryMemberDataStore();
      const app = mount(await setup(role), store);
      await app.request(`/team/members/${MEMBER}/wallet`, { headers: AUTH });
      const res = await app.request('/team/audit', { headers: AUTH });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        entries: [
          {
            viewer: { id: CALLER, name: 'Cara', username: 'cara' },
            member: { id: MEMBER, name: 'Mia', username: 'mia' },
            what: 'wallet',
            at: new Date(NOW).toISOString(),
          },
        ],
        nextCursor: null,
      });
    }
  });

  it('answers 503 when the audit log cannot be listed', async () => {
    const app = mount(await setup('founder'), new FailingStore());
    const res = await app.request('/team/audit', { headers: AUTH });
    expect(res.status).toBe(503);
    expect(events(warn)).toContain('team.audit.failed');
  });
});
