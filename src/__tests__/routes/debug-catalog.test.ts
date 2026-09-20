import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { InMemoryContactStore } from '@/lib/contact-store';
import { InMemoryConversationStore } from '@/lib/conversation-store';
import { InMemoryGiftStore } from '@/lib/gift-store';
import { InMemoryMessageStore } from '@/lib/message-store';
import { InMemoryNotificationStore } from '@/lib/notification-store';
import { InMemoryPushStore } from '@/lib/push-store';
import { InMemoryTrustStore } from '@/lib/trust-store';
import { debugCatalogRoutes } from '@/routes/debug-catalog';

function mount(debugToken: string | undefined, auth = new InMemoryAuthStore()): Hono {
  return new Hono().route(
    '/debug/dump',
    debugCatalogRoutes({
      auth,
      messages: new InMemoryMessageStore(),
      contacts: new InMemoryContactStore(),
      conversations: new InMemoryConversationStore(),
      notifications: new InMemoryNotificationStore(),
      push: new InMemoryPushStore(),
      trust: new InMemoryTrustStore(),
      gifts: new InMemoryGiftStore(),
      debugToken,
    }),
  );
}

describe('debugCatalogRoutes', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns 503 when debug is not configured', async () => {
    const res = await mount(undefined).request('/debug/dump');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Debug is not configured' });
  });

  it('returns 401 without a matching bearer', async () => {
    const res = await mount('secret').request('/debug/dump');
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown table', async () => {
    const res = await mount('secret').request('/debug/dump/not_a_table', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(404);
  });

  it('dumps passkey_credential rows', async () => {
    const auth = new InMemoryAuthStore();
    await auth.createAccount({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await auth.createPasskeyCredential({
      credentialId: 'cred-dump',
      publicKey: new Uint8Array([15]),
      signCount: 1,
      accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createdAt: 2,
    });
    const res = await mount('secret', auth).request('/debug/dump/passkey_credential', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      table: string;
      rows: Array<{ credentialId: string; publicKey: string }>;
    };
    expect(body.table).toBe('passkey_credential');
    expect(body.rows).toEqual([
      expect.objectContaining({ credentialId: 'cred-dump', publicKey: '0f' }),
    ]);
  });

  it('lists every allowlisted table on GET /', async () => {
    const res = await mount('secret').request('/debug/dump', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tables: Record<string, unknown[]> };
    expect(body.tables['account']).toEqual([]);
    expect(body.tables['db_change']).toEqual([]);
    expect(body.tables['auth_session']).toEqual([]);
  });

  it('dumps wired rate and db_change list ports', async () => {
    const res = await new Hono()
      .route(
        '/debug/dump',
        debugCatalogRoutes({
          auth: new InMemoryAuthStore(),
          messages: new InMemoryMessageStore(),
          contacts: new InMemoryContactStore(),
          debugToken: 'secret',
          listBtcUsdDaily: async () => [{ day: '2026-09-01' }],
          listUsdFiatDaily: async () => [{ quote: 'CHF' }],
          listDbChange: async () => [{ id: 1 }],
        }),
      )
      .request('/debug/dump/btc_usd_daily', {
        headers: { authorization: 'Bearer secret' },
      });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      table: 'btc_usd_daily',
      rows: [{ day: '2026-09-01' }],
    });
  });

  it('returns 503 when a store throw escapes the dump', async () => {
    const auth = new InMemoryAuthStore();
    vi.spyOn(auth, 'listAccounts').mockRejectedValue(new Error('boom'));
    const res = await mount('secret', auth).request('/debug/dump', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(503);
    const tableRes = await mount('secret', auth).request('/debug/dump/account', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(tableRes.status).toBe(503);
  });
});
