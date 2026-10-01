import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { unsignedNostrDefaults, type MessageRow } from '@/lib/message';
import { InMemoryMessageStore, type MessageStore } from '@/lib/message-store';
import type { FetchFn } from '@/lib/lnurlp';
import { RELAY_TIMEOUT_MS } from '@/lib/nostr/worker';
import { RecordingQuerier, type NostrEventFrame } from '@/lib/nostr/query';
import { messagesRoutes, type MessagesRouteDeps } from '@/routes/messages';

const NOW = 1_700_000_000_000;
const now = (): number => NOW;
const PARENT = '15151515-1515-4151-8151-151515151515';
const NOTE = '14141414-1414-4141-8141-141414141414';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((value): value is string => typeof value === 'string' && value.startsWith('{'))
    .map((value) => JSON.parse(value) as Record<string, unknown>);
}

function row(overrides: Partial<MessageRow> & Pick<MessageRow, 'id'>): MessageRow {
  return {
    accountId: null,
    name: 'Ada',
    text: '',
    createdAt: new Date(NOW),
    hasPhoto: false,
    hasVideo: false,
    videoContentType: null,
    ...unsignedNostrDefaults(),
    ...overrides,
  };
}

function mount(
  store: MessageStore,
  auth: InMemoryAuthStore = new InMemoryAuthStore(),
  extra: Partial<MessagesRouteDeps> = {},
): Hono {
  return new Hono().route(
    '/messages',
    messagesRoutes({
      store,
      authStore: auth,
      now,
      ...extra,
    }),
  );
}

function profileEvent(
  content: Record<string, unknown>,
  secret = generateSecretKey(),
): NostrEventFrame {
  return finalizeEvent(
    {
      kind: 0,
      created_at: 1_700_000_000,
      tags: [],
      content: JSON.stringify(content),
    },
    secret,
  );
}

async function authNamed(name: string): Promise<InMemoryAuthStore> {
  const auth = new InMemoryAuthStore();
  await auth.createAccount({
    id: 'acc',
    linkingKey: `02${'ab'.repeat(32)}`,
    role: 'basis',
    name: null,
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    location: null,
    viewKey: 'a'.repeat(64),
    createdAt: 1_000_000,
    rulesAgreedAt: null,
  });
  const existing = await auth.getAccount('acc');
  if (existing === undefined) {
    throw new Error('expected account');
  }
  await auth.updateAccount({ ...existing, name });
  return auth;
}

describe('GET /messages/:id/external-profile', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns 404 for a bad id, a missing row, a deleted row, and a member note', async () => {
    const store = new InMemoryMessageStore();
    const pubkey = 'ab'.repeat(32);
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Ada' }));
    await store.markDeleted(NOTE, new Date(NOW), 'staff');
    await store.create(
      row({
        id: '16161616-1616-4161-8161-161616161616',
        accountId: 'acc',
        authorPubkey: pubkey,
        name: 'Ada',
      }),
    );
    const app = mount(store);
    const bad = await app.request('/messages/not-a-uuid/external-profile');
    expect(bad.status).toBe(404);
    expect(await bad.json()).toEqual({ error: 'Not found' });
    const missing = await app.request(
      '/messages/17171717-1717-4171-8171-171717171717/external-profile',
    );
    expect(missing.status).toBe(404);
    const deleted = await app.request(`/messages/${NOTE}/external-profile`, {
      headers: { authorization: 'Bearer staff' },
    });
    expect(deleted.status).toBe(404);
    expect(await deleted.json()).toEqual({ error: 'Not found' });
    const member = await app.request(
      '/messages/16161616-1616-4161-8161-161616161616/external-profile',
    );
    expect(member.status).toBe(404);
  });

  it('returns 404 for a reply whose pubkey was not recorded as a zapper', async () => {
    const store = new InMemoryMessageStore();
    await store.create(row({ id: PARENT, accountId: 'acc', name: 'Parent' }));
    await store.create(
      row({
        id: NOTE,
        parentId: PARENT,
        authorPubkey: 'ab'.repeat(32),
        name: 'Ada',
      }),
    );
    const res = await mount(store).request(`/messages/${NOTE}/external-profile`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 when the author pubkey is not 64 hex', async () => {
    const store = new InMemoryMessageStore();
    await store.create(row({ id: NOTE, authorPubkey: 'abcd', name: 'Ada' }));
    const res = await mount(store).request(`/messages/${NOTE}/external-profile`);
    expect(res.status).toBe(404);
  });

  it('returns the stored name and npub when the querier fails', async () => {
    const store = new InMemoryMessageStore();
    const pubkey = 'ab'.repeat(32);
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Ada' }));
    const querier = {
      query: () => Promise.reject(new Error('relays down')),
    };
    const res = await mount(store, new InMemoryAuthStore(), {
      nostrQuerier: querier,
      nostrRelayUrls: ['wss://relay.example'],
    }).request(`/messages/${NOTE}/external-profile`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'Ada', npub: npubEncode(pubkey) });
  });

  it('keeps the stored name when the live name collides with a member', async () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const event = profileEvent({ display_name: 'Ada' }, secret);
    const store = new InMemoryMessageStore();
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Snapshot' }));
    const querier = new RecordingQuerier();
    querier.events = [event];
    const res = await mount(store, await authNamed('Ada'), {
      nostrQuerier: querier,
      nostrRelayUrls: ['wss://relay.example'],
    }).request(`/messages/${NOTE}/external-profile`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ name: 'Snapshot', npub: npubEncode(pubkey) });
    expect(body).not.toHaveProperty('pubkey');
    expect(body).not.toHaveProperty('callback');
    expect(querier.calls[0]?.timeoutMs).toBe(RELAY_TIMEOUT_MS);
  });

  it('uses a safe live name and includes nip05 when the well-known document matches', async () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const event = profileEvent(
      { display_name: 'Robin', nip05: 'lone@example.com', lud16: 'pay@ln.example' },
      secret,
    );
    const store = new InMemoryMessageStore();
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Old' }));
    const querier = new RecordingQuerier();
    querier.events = [event];
    const fetchImpl: FetchFn = vi.fn(async () =>
      Response.json({ names: { lone: pubkey.toUpperCase() } }),
    );
    const lookupHost = vi.fn(async () => ['1.1.1.1']);
    const res = await mount(store, new InMemoryAuthStore(), {
      nostrQuerier: querier,
      nostrRelayUrls: ['wss://relay.example'],
      fetchImpl,
      lookupHost,
    }).request(`/messages/${NOTE}/external-profile`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: 'Robin',
      npub: npubEncode(pubkey),
      nip05: 'lone@example.com',
      lud16: 'pay@ln.example',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.com/.well-known/nostr.json?name=lone',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it.each(['127.0.0.1', '10.0.0.1', '::1'])('omits nip05 when DNS answers %s', async (address) => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const event = profileEvent({ display_name: 'Robin', nip05: 'lone@example.com' }, secret);
    const store = new InMemoryMessageStore();
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Old' }));
    const querier = new RecordingQuerier();
    querier.events = [event];
    const fetchImpl = vi.fn(async () => Response.json({ names: { lone: pubkey } }));
    const res = await mount(store, new InMemoryAuthStore(), {
      nostrQuerier: querier,
      nostrRelayUrls: ['wss://relay.example'],
      fetchImpl,
      lookupHost: async () => [address],
    }).request(`/messages/${NOTE}/external-profile`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ name: 'Robin', npub: npubEncode(pubkey) });
    expect(body).not.toHaveProperty('nip05');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('omits nip05 when a public answer is mixed with a private one', async () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const event = profileEvent({ nip05: 'lone@example.com', display_name: 'Robin' }, secret);
    const store = new InMemoryMessageStore();
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Old' }));
    const querier = new RecordingQuerier();
    querier.events = [event];
    const fetchImpl = vi.fn(async () => Response.json({ names: { lone: pubkey } }));
    const res = await mount(store, new InMemoryAuthStore(), {
      nostrQuerier: querier,
      nostrRelayUrls: ['wss://relay.example'],
      fetchImpl,
      lookupHost: async () => ['1.1.1.1', '127.0.0.1'],
    }).request(`/messages/${NOTE}/external-profile`);
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('nip05');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('omits nip05 when the well-known redirect leaves https', async () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const event = profileEvent({ nip05: 'lone@example.com', display_name: 'Robin' }, secret);
    const store = new InMemoryMessageStore();
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Old' }));
    const querier = new RecordingQuerier();
    querier.events = [event];
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://example.com/.well-known/nostr.json?name=lone' },
        }),
    );
    const res = await mount(store, new InMemoryAuthStore(), {
      nostrQuerier: querier,
      nostrRelayUrls: ['wss://relay.example'],
      fetchImpl,
      lookupHost: async () => ['1.1.1.1'],
    }).request(`/messages/${NOTE}/external-profile`);
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('nip05');
  });

  it('omits nip05 when fetch is not injected', async () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const event = profileEvent({ nip05: 'lone@example.com', display_name: 'Robin' }, secret);
    const store = new InMemoryMessageStore();
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Old' }));
    const querier = new RecordingQuerier();
    querier.events = [event];
    const lookupHost = vi.fn(async () => ['1.1.1.1']);
    const res = await mount(store, new InMemoryAuthStore(), {
      nostrQuerier: querier,
      nostrRelayUrls: ['wss://relay.example'],
      lookupHost,
    }).request(`/messages/${NOTE}/external-profile`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ name: 'Robin', npub: npubEncode(pubkey) });
    expect(lookupHost).not.toHaveBeenCalled();
  });

  it.each([
    ['pay@example.com', 'pay@example.com'],
    ['https://evil.example', null],
    ['not-an-address', null],
  ])('lud16 %s is %s', async (lud16, expected) => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const event = profileEvent({ display_name: 'Robin', lud16 }, secret);
    const store = new InMemoryMessageStore();
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Old' }));
    const querier = new RecordingQuerier();
    querier.events = [event];
    const res = await mount(store, new InMemoryAuthStore(), {
      nostrQuerier: querier,
      nostrRelayUrls: ['wss://relay.example'],
    }).request(`/messages/${NOTE}/external-profile`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['name']).toBe('Robin');
    expect(body['npub']).toBe(npubEncode(pubkey));
    if (expected === null) {
      expect(body).not.toHaveProperty('lud16');
    } else {
      expect(body['lud16']).toBe(expected);
    }
    expect(body).not.toHaveProperty('pubkey');
    expect(body).not.toHaveProperty('callback');
  });

  it('returns 503 and logs no profile material when the store throws', async () => {
    const store = {
      getById: () => Promise.reject(new Error('boom pubkey nip05')),
    } as unknown as MessageStore;
    const res = await mount(store).request(`/messages/${NOTE}/external-profile`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    const events = parsedEvents(warn);
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'messages.external_profile.failed' }),
    );
    const line = events.find((event) => event['event'] === 'messages.external_profile.failed');
    expect(line).toEqual({
      ts: expect.any(String),
      event: 'messages.external_profile.failed',
    });
    expect(JSON.stringify(line)).not.toContain('pubkey');
    expect(JSON.stringify(line)).not.toContain('boom');
  });
});
