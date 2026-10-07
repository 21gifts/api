import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import {
  InMemoryMemberDataStore,
  type MemberEventRow,
  type TeamAccessRow,
  type WalletBalanceSnapshotRow,
} from '@/lib/member-data-store';
import { debugTeamRoutes } from '@/routes/debug-team';

const NOW = Date.UTC(2026, 9, 7);
const MEMBER = '11111111-1111-4111-8111-111111111111';
const TOKEN = { authorization: 'Bearer secret' };

class FailingStore extends InMemoryMemberDataStore {
  override latestBalance(): Promise<WalletBalanceSnapshotRow | null> {
    return Promise.reject(new Error('down'));
  }

  override listEvents(): Promise<MemberEventRow[]> {
    return Promise.reject(new Error('down'));
  }

  override listAccess(): Promise<TeamAccessRow[]> {
    return Promise.reject(new Error('down'));
  }
}

async function accounts(): Promise<InMemoryAuthStore> {
  const auth = new InMemoryAuthStore();
  await auth.createAccount({
    id: MEMBER,
    linkingKey: null,
    role: 'basis',
    name: 'Mia',
    forumLawsDismissed: false,
    location: null,
    viewKey: 'a'.repeat(64),
    createdAt: NOW,
    rulesAgreedAt: NOW,
  });
  return auth;
}

function mount(
  auth: InMemoryAuthStore,
  debugToken: string | undefined,
  memberDataStore = new InMemoryMemberDataStore(),
): Hono {
  return new Hono().route(
    '/debug/team',
    debugTeamRoutes({ authStore: auth, memberDataStore, debugToken, now: () => NOW }),
  );
}

const PATHS = [
  `/debug/team/members/${MEMBER}/wallet`,
  `/debug/team/members/${MEMBER}/events`,
  '/debug/team/audit',
];

describe('debugTeamRoutes', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('answers 503 when debug is off or blank', async () => {
    const auth = await accounts();
    for (const token of [undefined, '  ']) {
      for (const path of PATHS) {
        const res = await mount(auth, token).request(path, { headers: TOKEN });
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: 'Debug is not configured' });
      }
    }
  });

  it('answers 401 for a missing or wrong bearer', async () => {
    const app = mount(await accounts(), 'secret');
    for (const path of PATHS) {
      expect((await app.request(path)).status).toBe(401);
      const res = await app.request(path, { headers: { authorization: 'Bearer wrong' } });
      expect(res.status).toBe(401);
    }
  });

  it('reads wallet, events, and audit without writing an audit row', async () => {
    const store = new InMemoryMemberDataStore();
    const app = mount(await accounts(), 'secret', store);
    const wallet = await app.request(`/debug/team/members/${MEMBER}/wallet?period=all`, {
      headers: TOKEN,
    });
    expect(wallet.status).toBe(200);
    expect(await wallet.json()).toMatchObject({ member: { id: MEMBER }, period: 'all' });
    const evts = await app.request(`/debug/team/members/${MEMBER}/events`, { headers: TOKEN });
    expect(await evts.json()).toMatchObject({ events: [], nextCursor: null });
    const audit = await app.request('/debug/team/audit', { headers: TOKEN });
    expect(await audit.json()).toEqual({ entries: [], nextCursor: null });
    expect(await store.listAccess(null, 10)).toEqual([]);
    const missing = await app.request('/debug/team/members/x/wallet', { headers: TOKEN });
    expect(missing.status).toBe(404);
  });

  it('answers 503 when the store fails', async () => {
    const app = mount(await accounts(), 'secret', new FailingStore());
    for (const path of PATHS) {
      const res = await app.request(path, { headers: TOKEN });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Member data is unavailable' });
    }
    const logged = warn.mock.calls.map((call) => String(call[0]));
    for (const event of [
      'debug.team.wallet_failed',
      'debug.team.events_failed',
      'debug.team.audit_failed',
    ]) {
      expect(logged.some((line) => line.includes(event))).toBe(true);
    }
  });
});
