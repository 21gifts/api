import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { InMemoryConversationStore } from '@/lib/conversation-store';
import { InMemoryMessageStore } from '@/lib/message-store';
import { InMemoryNotificationStore } from '@/lib/notification-store';
import { InMemoryPushStore } from '@/lib/push-store';
import * as authService from '@/lib/auth/service';
import { WRONG_ACCOUNT_ERROR } from '@/lib/auth/wrong-account';
import type { MergeDb } from '@/lib/account-merge';
import { debugRoutes } from '@/routes/debug';
import { LNURL_SERVER, createWalletAccount } from '@/__tests__/helpers/wallet-lnurl';

const MERGE_FROM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MERGE_INTO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MERGE_MISSING = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** Account row shape copied from the member-route fixtures. */
async function createMergeAccount(
  store: InMemoryAuthStore,
  id: string,
  viewKey: string,
  extras: { isPlatform?: boolean } = {},
): Promise<void> {
  await store.createAccount({
    id,
    linkingKey: null,
    role: 'verified',
    name: 'Ada',
    forumLawsDismissed: false,
    location: null,
    viewKey,
    createdAt: 1_700_000_000_000,
    rulesAgreedAt: 1_700_000_000_000,
    ...(extras.isPlatform === true ? { isPlatform: true } : {}),
  });
}

/**
 * Fake transaction port. Account rows come from the memory store; funding
 * grants and the message count are scripted the same way as the merge unit tests.
 */
function mergeDbForStore(
  store: InMemoryAuthStore,
  options: { bothGrants?: boolean } = {},
): MergeDb {
  return {
    async begin(run) {
      return run({
        async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
          if (text.includes('FOR UPDATE')) {
            const rows: Array<{
              id: string;
              is_platform: boolean;
              role: string;
              profile_message_id: string | null;
            }> = [];
            for (const id of params) {
              if (typeof id !== 'string') {
                continue;
              }
              const account = await store.getAccount(id);
              if (account === undefined) {
                continue;
              }
              rows.push({
                id: account.id,
                is_platform: account.isPlatform === true,
                role: account.role,
                profile_message_id: account.profileMessageId ?? null,
              });
            }
            return rows as T[];
          }
          if (text.includes('SELECT account_id FROM funding_grant')) {
            if (options.bothGrants !== true) {
              return [];
            }
            return params
              .filter((id): id is string => typeof id === 'string')
              .map((account_id) => ({ account_id })) as T[];
          }
          if (text.includes('count(*)')) {
            return [{ n: 1 }] as T[];
          }
          return [];
        },
      });
    },
  };
}

function mountDebug(
  store: InMemoryAuthStore,
  options: { debugToken?: string; mergeDb?: MergeDb } = {},
): Hono {
  return new Hono().route(
    '/debug/accounts',
    debugRoutes({
      store,
      debugToken: options.debugToken,
      ...(options.mergeDb === undefined ? {} : { mergeDb: options.mergeDb }),
    }),
  );
}

async function postMerge(
  app: Hono,
  body: unknown,
  authorization = 'Bearer debug-token',
): Promise<Response> {
  return app.request('/debug/accounts/merge', {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

describe('debugRoutes', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns 503 when debug is not configured', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store: new InMemoryAuthStore(),
        debugToken: undefined,
      }),
    );
    const res = await app.request('/debug/accounts');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Debug is not configured' });
  });

  it('returns 503 when the token is blank', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store: new InMemoryAuthStore(),
        debugToken: '  ',
      }),
    );
    const res = await app.request('/debug/accounts', { headers: { authorization: 'Bearer   ' } });
    expect(res.status).toBe(503);
  });

  it('returns 401 without a matching bearer', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store: new InMemoryAuthStore(),
        debugToken: 'secret',
      }),
    );
    const res = await app.request('/debug/accounts');
    expect(res.status).toBe(401);
  });

  it('lists accounts for a valid bearer', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: `02${'a'.repeat(64)}`,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await store.setNostrKeyIfAbsent('acc', {
      pubkey: 'cc'.repeat(32),
      ciphertext: new Uint8Array([2]),
      kekId: 1,
      custody: 'custodial',
    });
    const app = new Hono().route('/debug/accounts', debugRoutes({ store, debugToken: 'secret' }));
    const res = await app.request('/debug/accounts', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accounts: Array<{ id: string; lightningAddress: string | null }>;
    };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]?.id).toBe('acc');
    expect(body.accounts[0]?.lightningAddress).toBeNull();
    expect(body.accounts[0]).toHaveProperty('viewKey');
    expect(body.accounts[0]).toHaveProperty('isPlatform');
    expect(body.accounts[0]).toHaveProperty('sessionRefused');
    expect(body.accounts[0]).toEqual(
      expect.objectContaining({
        nostrPubkey: 'cc'.repeat(32),
        nostrNsecCiphertext: '02',
        nostrKekId: 1,
        nostrKeyCustody: 'custodial',
      }),
    );
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.accounts.listed')).toBe(true);
  });

  it('lists stored kek and custody when the account has no Nostr key', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const app = new Hono().route('/debug/accounts', debugRoutes({ store, debugToken: 'secret' }));
    const res = await app.request('/debug/accounts', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accounts: Array<{
        id: string;
        nostrPubkey: string | null;
        nostrKekId: number | null;
        nostrKeyCustody: string | null;
      }>;
    };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toEqual(
      expect.objectContaining({
        id: 'acc',
        nostrPubkey: null,
        nostrKekId: 1,
        nostrKeyCustody: 'custodial',
      }),
    );
  });

  it('lists all-null nostr fields when listNostrKeys returns no row', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    Object.assign(store, { listNostrKeys: async () => [] });
    const app = new Hono().route('/debug/accounts', debugRoutes({ store, debugToken: 'secret' }));
    const res = await app.request('/debug/accounts', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accounts: Array<{
        id: string;
        nostrPubkey: string | null;
        nostrKekId: number | null;
        nostrKeyCustody: string | null;
      }>;
    };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toEqual(
      expect.objectContaining({
        nostrPubkey: null,
        nostrKekId: null,
        nostrKeyCustody: null,
      }),
    );
  });

  it('GET /:id returns nested passkeys and 404 for a non-uuid', async () => {
    const store = new InMemoryAuthStore();
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await store.createAccount({
      id,
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await store.createPasskeyCredential({
      credentialId: 'cred-1',
      publicKey: new Uint8Array([1, 2, 255]),
      signCount: 0,
      accountId: id,
      createdAt: 2,
    });
    await store.createSession({ token: 'tok', accountId: id, createdAt: 3 });
    await store.setNostrKeyIfAbsent(id, {
      pubkey: 'dd'.repeat(32),
      ciphertext: new Uint8Array([1, 2]),
      kekId: 1,
      custody: 'custodial',
    });
    const app = new Hono().route('/debug/accounts', debugRoutes({ store, debugToken: 'secret' }));
    const missing = await app.request('/debug/accounts/not-a-uuid', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(missing.status).toBe(404);
    const unknown = await app.request('/debug/accounts/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(unknown.status).toBe(404);
    const res = await app.request(`/debug/accounts/${id}`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      viewKey: string;
      passkeys: Array<{ credentialId: string; publicKey: string }>;
      sessions: Array<{ token: string }>;
      nostrPubkey: string | null;
    };
    expect(body.id).toBe(id);
    expect(body.viewKey).toHaveLength(64);
    expect(body.passkeys).toEqual([
      expect.objectContaining({ credentialId: 'cred-1', publicKey: '0102ff' }),
    ]);
    expect(body.sessions).toEqual([expect.objectContaining({ token: 'tok' })]);
    expect(body).not.toHaveProperty('addressVerification');
    expect(body.nostrPubkey).toBe('dd'.repeat(32));
    expect(body).toEqual(expect.objectContaining({ nostrNsecCiphertext: '0102' }));
  });

  it('PATCH returns 503 when debug is not configured', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store: new InMemoryAuthStore(),
        debugToken: undefined,
      }),
    );
    const res = await app.request('/debug/accounts/acc', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'moderator' }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Debug is not configured' });
  });

  it('PATCH returns 401 without a matching bearer', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store: new InMemoryAuthStore(),
        debugToken: 'secret',
      }),
    );
    const res = await app.request('/debug/accounts/acc', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'moderator' }),
    });
    expect(res.status).toBe(401);
  });

  it('PATCH returns 400 for a missing role body', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store: new InMemoryAuthStore(),
        debugToken: 'secret',
      }),
    );
    const res = await app.request('/debug/accounts/acc', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        'Expected a JSON body with a "role" string, platform boolean, and/or sessionRefused boolean',
    });
  });

  it('PATCH returns 400 for an unknown role', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store: new InMemoryAuthStore(),
        debugToken: 'secret',
      }),
    );
    const res = await app.request('/debug/accounts/acc', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        'Expected a JSON body with a "role" string, platform boolean, and/or sessionRefused boolean',
    });
  });

  it('PATCH returns 400 for non-JSON', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store: new InMemoryAuthStore(),
        debugToken: 'secret',
      }),
    );
    const res = await app.request('/debug/accounts/acc', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('PATCH returns 404 for a missing account', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store: new InMemoryAuthStore(),
        debugToken: 'secret',
      }),
    );
    const res = await app.request('/debug/accounts/missing', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'verified' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('PATCH sets the role and returns the updated account', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const app = new Hono().route('/debug/accounts', debugRoutes({ store, debugToken: 'secret' }));
    const res = await app.request('/debug/accounts/acc', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'founder' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; role: string };
    expect(body.id).toBe('acc');
    expect(body.role).toBe('founder');
    expect((await store.getAccount('acc'))?.role).toBe('founder');
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'debug.accounts.role_set' && e['role'] === 'founder',
      ),
    ).toBe(true);
    expect(body).toHaveProperty('isPlatform');
    expect(body).toHaveProperty('sessionRefused');
    expect(body).toHaveProperty('viewKey');
    expect(body).toEqual(
      expect.objectContaining({
        nostrPubkey: null,
        nostrNsecCiphertext: null,
        nostrKekId: 1,
        nostrKeyCustody: 'custodial',
      }),
    );
  });

  it('PATCH sets the role to initiator and returns the updated account', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const app = new Hono().route('/debug/accounts', debugRoutes({ store, debugToken: 'secret' }));
    const res = await app.request('/debug/accounts/acc', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'initiator' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; role: string };
    expect(body.id).toBe('acc');
    expect(body.role).toBe('initiator');
    expect((await store.getAccount('acc'))?.role).toBe('initiator');
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'debug.accounts.role_set' && e['role'] === 'initiator',
      ),
    ).toBe(true);
  });

  it('PATCH sets sessionRefused', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const app = new Hono().route('/debug/accounts', debugRoutes({ store, debugToken: 'secret' }));
    const updateAccount = vi.spyOn(store, 'updateAccount');
    const res = await app.request('/debug/accounts/acc', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionRefused: true }),
    });
    expect(res.status).toBe(200);
    expect(updateAccount).not.toHaveBeenCalled();
    const refused = (await res.json()) as { id: string; sessionRefused: boolean };
    expect(refused.sessionRefused).toBe(true);
    expect((await store.getAccount('acc'))?.sessionRefused).toBe(true);
    const off = await app.request('/debug/accounts/acc', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionRefused: false }),
    });
    expect(off.status).toBe(200);
    expect(((await off.json()) as { sessionRefused: boolean }).sessionRefused).toBe(false);
  });

  it('PATCH returns envelope hex when the account has a stored nsec', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await store.setNostrKeyIfAbsent('acc', {
      pubkey: 'ee'.repeat(32),
      ciphertext: new Uint8Array([3, 4]),
      kekId: 1,
      custody: 'custodial',
    });
    const app = new Hono().route('/debug/accounts', debugRoutes({ store, debugToken: 'secret' }));
    const res = await app.request('/debug/accounts/acc', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'verified' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(
      expect.objectContaining({
        id: 'acc',
        role: 'verified',
        viewKey: 'b'.repeat(64),
        nostrPubkey: 'ee'.repeat(32),
        nostrNsecCiphertext: '0304',
      }),
    );
  });

  it('PATCH sets the platform flag and clears any other platform account', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'founder',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await store.createAccount({
      id: 'old',
      linkingKey: null,
      role: 'founder',
      name: 'Old',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'c'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
      isPlatform: true,
    });
    const app = new Hono().route('/debug/accounts', debugRoutes({ store, debugToken: 'secret' }));
    const res = await app.request('/debug/accounts/acc', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ platform: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; isPlatform: boolean };
    expect(body.id).toBe('acc');
    expect(body.isPlatform).toBe(true);
    expect((await store.getAccount('acc'))?.isPlatform).toBe(true);
    expect((await store.getAccount('old'))?.isPlatform).toBe(false);
  });

  it('PATCH platform:true retargets member_platform threads', async () => {
    const store = new InMemoryAuthStore();
    const conversations = new InMemoryConversationStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'founder',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await store.createAccount({
      id: 'old',
      linkingKey: null,
      role: 'founder',
      name: 'Old',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'c'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
      isPlatform: true,
    });
    const opened = await conversations.openMemberPlatform('mem', 'old', new Date(0));
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store,
        debugToken: 'secret',
        conversationStore: conversations,
      }),
    );
    const res = await app.request('/debug/accounts/acc', {
      method: 'PATCH',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ platform: true }),
    });
    expect(res.status).toBe(200);
    expect((await conversations.getById(opened.id))?.accountB).toBe('acc');
  });

  it('POST /:id/session mints a bearer the account can use', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store,
        debugToken: 'secret',
        now: () => 1_700_000_000_000,
      }),
    );
    const missing = await app.request('/debug/accounts/missing/session', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
    });
    expect(missing.status).toBe(404);
    const res = await app.request('/debug/accounts/acc/session', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(body.token.length).toBeGreaterThan(8);
    expect((await store.getSession(body.token))?.accountId).toBe('acc');
    const defaultClock = new Hono().route(
      '/debug/accounts',
      debugRoutes({ store, debugToken: 'secret' }),
    );
    const again = await defaultClock.request('/debug/accounts/acc/session', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
    });
    expect(again.status).toBe(200);
  });

  it('POST /:id/session refuses a sessionRefused account', async () => {
    const store = new InMemoryAuthStore();
    const id = '00000000-0000-4000-8000-0000000000ff';
    await store.createAccount({
      id,
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
      sessionRefused: true,
    });
    const createSession = vi.spyOn(store, 'createSession');
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store,
        debugToken: 'secret',
        now: () => 1_700_000_000_000,
      }),
    );
    const res = await app.request(`/debug/accounts/${id}/session`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: WRONG_ACCOUNT_ERROR });
    expect(createSession).not.toHaveBeenCalled();
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.accounts.session_minted')).toBe(
      false,
    );
  });

  it('POST /:id/session is 403 when tryCreateSession fails concurrently', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    vi.spyOn(store, 'tryCreateSession').mockResolvedValue(false);
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store,
        debugToken: 'secret',
        now: () => 1_700_000_000_000,
      }),
    );
    const res = await app.request('/debug/accounts/acc/session', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: WRONG_ACCOUNT_ERROR });
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.accounts.session_minted')).toBe(
      false,
    );
  });

  it('POST /:id/session rethrows a non-wrong-account issueSession failure', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    vi.spyOn(authService, 'issueSession').mockRejectedValue(new Error('disk'));
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store,
        debugToken: 'secret',
        now: () => 1_700_000_000_000,
      }),
    );
    const res = await app.request('/debug/accounts/acc/session', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(500);
  });

  it('PATCH refuses the removed lightningAddress field', async () => {
    const store = new InMemoryAuthStore();
    await createWalletAccount(store, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ada');
    const app = new Hono().route('/debug/accounts', debugRoutes({ store, debugToken: 'secret' }));
    for (const body of [
      { lightningAddress: null },
      { role: 'moderator', lightningAddress: null },
    ]) {
      const res = await app.request('/debug/accounts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
        method: 'PATCH',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error:
          'Expected a JSON body with a "role" string, platform boolean, and/or sessionRefused boolean',
      });
    }
    expect((await store.getAccount('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))?.role).toBe('verified');
  });

  it('shows the wallet receiving address with the LNURL server configured', async () => {
    const store = new InMemoryAuthStore();
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await createWalletAccount(store, id, 'ada');
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({ store, debugToken: 'secret', lnurlServer: LNURL_SERVER }),
    );
    const headers = { authorization: 'Bearer secret' };
    const list = (await (await app.request('/debug/accounts', { headers })).json()) as {
      accounts: Array<{ lightningAddress: string | null; lightningAddressVerified: boolean }>;
    };
    expect(list.accounts[0]).toMatchObject({
      lightningAddress: 'ada@example.test',
      lightningAddressVerified: true,
    });
    const detail = (await (await app.request(`/debug/accounts/${id}`, { headers })).json()) as {
      lightningAddress: string | null;
    };
    expect(detail.lightningAddress).toBe('ada@example.test');
    const patched = (await (
      await app.request(`/debug/accounts/${id}`, {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'moderator' }),
      })
    ).json()) as { lightningAddress: string | null };
    expect(patched.lightningAddress).toBe('ada@example.test');
    const off = new Hono().route('/debug/accounts', debugRoutes({ store, debugToken: 'secret' }));
    const plain = (await (await off.request(`/debug/accounts/${id}`, { headers })).json()) as {
      lightningAddress: string | null;
    };
    expect(plain.lightningAddress).toBeNull();
  });

  it('POST returns 503 when debug is not configured', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store: new InMemoryAuthStore(),
        debugToken: undefined,
      }),
    );
    const res = await app.request('/debug/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accounts: [{ name: 'Ada' }],
      }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Debug is not configured' });
  });

  it('POST returns 401 without a matching bearer', async () => {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store: new InMemoryAuthStore(),
        debugToken: 'secret',
      }),
    );
    const res = await app.request('/debug/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accounts: [{ name: 'Ada' }],
      }),
    });
    expect(res.status).toBe(401);
  });

  function provisionApp(
    store: InMemoryAuthStore,
    messageStore?: InMemoryMessageStore,
  ): (accounts: unknown) => Promise<Response> {
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({
        store,
        debugToken: 'secret',
        ...(messageStore === undefined ? {} : { messageStore }),
        pushStore: new InMemoryPushStore(),
        notificationStore: new InMemoryNotificationStore(),
      }),
    );
    return async (accounts) =>
      app.request('/debug/accounts', {
        method: 'POST',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: typeof accounts === 'string' ? accounts : JSON.stringify({ accounts }),
      });
  }

  interface ProvisionRow {
    name: string;
    username: string | null;
    viewKey: string;
    created: boolean;
  }

  it('POST returns 400 for an invalid body', async () => {
    const store = new InMemoryAuthStore();
    const post = provisionApp(store);
    const error = { error: 'Expected a JSON body with an "accounts" array' };
    for (const body of ['not json', JSON.stringify({ accounts: [] })]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(error);
    }
    for (const rows of [
      [{ name: 'Ada', lightningAddress: 'ada@example.com' }],
      [{ name: '   ' }],
      [{ name: 'Ada\u0001' }],
      [{ name: 'Ada', username: 'not a handle!' }],
    ]) {
      const res = await post(rows);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(error);
    }
    expect(await store.listAccounts()).toEqual([]);
  });

  it('POST returns 400 without persisting earlier rows when a later row is invalid', async () => {
    const store = new InMemoryAuthStore();
    const res = await provisionApp(store)([{ name: 'Ada' }, { name: 'Bob', username: '!!' }]);
    expect(res.status).toBe(400);
    expect(await store.listAccounts()).toEqual([]);
  });

  it('POST provisions a new account without a passkey or receiving address', async () => {
    const store = new InMemoryAuthStore();
    const messageStore = new InMemoryMessageStore();
    const res = await provisionApp(store, messageStore)([{ name: 'Ada' }]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accounts: ProvisionRow[] };
    expect(body.accounts).toEqual([
      {
        name: 'Ada',
        username: 'ada',
        viewKey: expect.stringMatching(/^[0-9a-f]{64}$/),
        created: true,
      },
    ]);
    const stored = await store.getAccountByUsername('ada');
    expect(stored).toMatchObject({
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      rulesAgreedAt: null,
      viewKey: body.accounts[0]?.viewKey,
    });
    expect(stored).not.toHaveProperty('lightningAddress');
    expect(await store.accountHasPasskey(stored!.id)).toBe(false);
    expect(stored?.profileMessageId).toBeNull();
    expect(await messageStore.listLatest(10)).toEqual([]);
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'debug.accounts.provisioned' && e['created'] === 1 && e['updated'] === 0,
      ),
    ).toBe(true);
  });

  it('POST creates a new account each time without a username, deriving a free one', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'blank',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'c'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
      username: '   ',
    });
    await store.createAccount({
      id: 'none',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'd'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const post = provisionApp(store);
    const first = (await (await post([{ name: 'Ada' }, { name: 'Ada' }])).json()) as {
      accounts: ProvisionRow[];
    };
    const second = (await (await post([{ name: 'Ada' }])).json()) as { accounts: ProvisionRow[] };
    const rows = [...first.accounts, ...second.accounts];
    expect(rows.map((row) => row.created)).toEqual([true, true, true]);
    expect(rows[0]?.username).toBe('ada');
    const names = rows.map((row) => row.username);
    expect(new Set(names).size).toBe(3);
    expect(new Set(rows.map((row) => row.viewKey)).size).toBe(3);
    expect(await store.listAccounts()).toHaveLength(5);
  });

  it('POST creates under a given username, then upserts the name by that username', async () => {
    const store = new InMemoryAuthStore();
    const messageStore = new InMemoryMessageStore();
    const post = provisionApp(store, messageStore);
    const created = (await (await post([{ name: 'Ada', username: 'Lovelace' }])).json()) as {
      accounts: ProvisionRow[];
    };
    expect(created.accounts[0]).toMatchObject({ name: 'Ada', username: 'lovelace', created: true });
    const updated = (await (
      await post([{ name: 'Ada Lovelace', username: '  LOVELACE ' }])
    ).json()) as { accounts: ProvisionRow[] };
    expect(updated.accounts).toEqual([
      {
        name: 'Ada Lovelace',
        username: 'lovelace',
        viewKey: created.accounts[0]?.viewKey,
        created: false,
      },
    ]);
    expect(await store.listAccounts()).toHaveLength(1);
    expect((await store.getAccountByUsername('lovelace'))?.name).toBe('Ada Lovelace');
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'debug.accounts.provisioned' && e['created'] === 0 && e['updated'] === 1,
      ),
    ).toBe(true);
  });

  it('POST updates only the name of an existing moderator and keeps its wallet', async () => {
    const store = new InMemoryAuthStore();
    await createWalletAccount(store, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ada');
    const before = await store.getAccount('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    await store.updateAccount({ ...before!, role: 'moderator' });
    const messageStore = new InMemoryMessageStore();
    const res = await provisionApp(store, messageStore)([{ name: 'Ada L', username: 'ada' }]);
    expect(res.status).toBe(200);
    const after = await store.getAccount('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(after).toMatchObject({
      name: 'Ada L',
      role: 'moderator',
      username: 'ada',
      viewKey: before?.viewKey,
      sparkPubkeyVerifiedAt: before?.sparkPubkeyVerifiedAt,
    });
    expect(typeof after?.profileMessageId).toBe('string');
    expect((await messageStore.getById(after!.profileMessageId as string))?.text).toBe('Ada L');
  });

  it('POST backfills a profile note without push or notification stores', async () => {
    const store = new InMemoryAuthStore();
    await createWalletAccount(store, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ada');
    const messageStore = new InMemoryMessageStore();
    const app = new Hono().route(
      '/debug/accounts',
      debugRoutes({ store, debugToken: 'secret', messageStore }),
    );
    const res = await app.request('/debug/accounts', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ accounts: [{ name: 'Ada', username: 'ada' }] }),
    });
    expect(res.status).toBe(200);
    expect(await messageStore.listLatest(10)).toHaveLength(1);
  });

  it('POST creates a profile note for a new account only once it has a verified wallet', async () => {
    const store = new InMemoryAuthStore();
    const messageStore = new InMemoryMessageStore();
    const ensured = vi.spyOn(messageStore, 'create');
    await provisionApp(store, messageStore)([{ name: 'Ada', username: 'ada' }]);
    expect(ensured).not.toHaveBeenCalled();
  });

  it('POST /debug/accounts/merge returns 503 when debug is not configured', async () => {
    const app = mountDebug(new InMemoryAuthStore());
    const res = await app.request('/debug/accounts/merge', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Debug is not configured' });
  });

  it('POST /debug/accounts/merge returns 401 with a wrong bearer', async () => {
    const app = mountDebug(new InMemoryAuthStore(), { debugToken: 'debug-token' });
    const res = await app.request('/debug/accounts/merge', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('POST /debug/accounts/merge returns 400 for body {}', async () => {
    const store = new InMemoryAuthStore();
    const app = mountDebug(store, {
      debugToken: 'debug-token',
      mergeDb: mergeDbForStore(store),
    });
    const res = await postMerge(app, {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Expected a JSON body with "from" and "into"' });
  });

  it('POST /debug/accounts/merge returns 409 when from and into are the same account', async () => {
    const store = new InMemoryAuthStore();
    await createMergeAccount(store, MERGE_FROM, 'a'.repeat(64));
    const app = mountDebug(store, {
      debugToken: 'debug-token',
      mergeDb: mergeDbForStore(store),
    });
    const res = await postMerge(app, { from: MERGE_FROM, into: MERGE_FROM });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Cannot merge an account into itself' });
  });

  it('POST /debug/accounts/merge returns 404 when one id is not in the store', async () => {
    const store = new InMemoryAuthStore();
    await createMergeAccount(store, MERGE_FROM, 'a'.repeat(64));
    const app = mountDebug(store, {
      debugToken: 'debug-token',
      mergeDb: mergeDbForStore(store),
    });
    const res = await postMerge(app, { from: MERGE_FROM, into: MERGE_MISSING });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('POST /debug/accounts/merge returns 409 when an account is platform', async () => {
    const store = new InMemoryAuthStore();
    await createMergeAccount(store, MERGE_FROM, 'a'.repeat(64), { isPlatform: true });
    await createMergeAccount(store, MERGE_INTO, 'b'.repeat(64));
    const app = mountDebug(store, {
      debugToken: 'debug-token',
      mergeDb: mergeDbForStore(store),
    });
    const res = await postMerge(app, { from: MERGE_FROM, into: MERGE_INTO });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Cannot merge the platform account' });
  });

  it('POST /debug/accounts/merge returns 503 when mergeDb is omitted', async () => {
    const store = new InMemoryAuthStore();
    await createMergeAccount(store, MERGE_FROM, 'a'.repeat(64));
    await createMergeAccount(store, MERGE_INTO, 'b'.repeat(64));
    const app = mountDebug(store, { debugToken: 'debug-token' });
    const res = await postMerge(app, { from: MERGE_FROM, into: MERGE_INTO });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Merge is unavailable' });
  });

  it('POST /debug/accounts/merge returns 409 when both accounts have a funding grant', async () => {
    const store = new InMemoryAuthStore();
    await createMergeAccount(store, MERGE_FROM, 'a'.repeat(64));
    await createMergeAccount(store, MERGE_INTO, 'b'.repeat(64));
    const app = mountDebug(store, {
      debugToken: 'debug-token',
      mergeDb: mergeDbForStore(store, { bothGrants: true }),
    });
    const res = await postMerge(app, { from: MERGE_FROM, into: MERGE_INTO });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Both accounts have a funding grant' });
  });

  it('POST /debug/accounts/merge returns the moved message count', async () => {
    const store = new InMemoryAuthStore();
    await createMergeAccount(store, MERGE_FROM, 'a'.repeat(64));
    await createMergeAccount(store, MERGE_INTO, 'b'.repeat(64));
    const app = mountDebug(store, {
      debugToken: 'debug-token',
      mergeDb: mergeDbForStore(store),
    });
    const res = await postMerge(app, { from: MERGE_FROM, into: MERGE_INTO });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ into: MERGE_INTO, deleted: MERGE_FROM, messages: 1 });
  });

  it('POST /debug/accounts/merge returns 503 when begin reports a sqlState', async () => {
    const store = new InMemoryAuthStore();
    await createMergeAccount(store, MERGE_FROM, 'a'.repeat(64));
    await createMergeAccount(store, MERGE_INTO, 'b'.repeat(64));
    const mergeDb: MergeDb = {
      async begin() {
        throw Object.assign(new Error('disk'), { code: '23505' });
      },
    };
    const app = mountDebug(store, {
      debugToken: 'debug-token',
      mergeDb,
    });
    const res = await postMerge(app, { from: MERGE_FROM, into: MERGE_INTO });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Merge is unavailable' });
    expect(
      parsedEvents(warn).some(
        (e) =>
          e['event'] === 'debug.accounts.merge_failed' &&
          e['from'] === MERGE_FROM &&
          e['into'] === MERGE_INTO &&
          e['sqlState'] === '23505',
      ),
    ).toBe(true);
  });

  it('POST /debug/accounts/merge returns 503 when begin has no sqlState', async () => {
    const store = new InMemoryAuthStore();
    await createMergeAccount(store, MERGE_FROM, 'a'.repeat(64));
    await createMergeAccount(store, MERGE_INTO, 'b'.repeat(64));
    const mergeDb: MergeDb = {
      async begin() {
        throw new Error('disk');
      },
    };
    const app = mountDebug(store, {
      debugToken: 'debug-token',
      mergeDb,
    });
    const res = await postMerge(app, { from: MERGE_FROM, into: MERGE_INTO });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Merge is unavailable' });
    const event = parsedEvents(warn).find(
      (e) =>
        e['event'] === 'debug.accounts.merge_failed' &&
        e['from'] === MERGE_FROM &&
        e['into'] === MERGE_INTO,
    );
    expect(event).toBeDefined();
    expect(event !== undefined && !('sqlState' in event)).toBe(true);
  });
});
