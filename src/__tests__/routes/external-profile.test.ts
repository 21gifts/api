import { lookup } from 'node:dns/promises';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { truncatePubkeyDisplay, unsignedNostrDefaults, type MessageRow } from '@/lib/message';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));
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

function asResponse(partial: {
  status: number;
  headers?: Headers;
  text: () => Promise<string>;
  body?: ReadableStream<Uint8Array> | null;
}): Response {
  return {
    status: partial.status,
    ok: partial.status >= 200 && partial.status < 300,
    headers: partial.headers ?? new Headers(),
    body: partial.body,
    text: partial.text,
  } as Response;
}

function byteStream(chunks: readonly Uint8Array[], fail = false): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (fail) {
        controller.error(new Error('stream'));
        return;
      }
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
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
    expect(await res.json()).toEqual({
      name: 'Ada',
      npub: npubEncode(pubkey),
      postCount: 1,
      replyCount: 0,
    });
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
    expect(body).toEqual({
      name: 'Snapshot',
      npub: npubEncode(pubkey),
      postCount: 1,
      replyCount: 0,
    });
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
      postCount: 1,
      replyCount: 0,
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
    expect(body).toEqual({
      name: 'Robin',
      npub: npubEncode(pubkey),
      postCount: 1,
      replyCount: 0,
    });
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
    expect(body).toEqual({
      name: 'Robin',
      npub: npubEncode(pubkey),
      postCount: 1,
      replyCount: 0,
    });
    expect(lookupHost).not.toHaveBeenCalled();
  });

  it.each([
    ['pay@example.com', 'pay@example.com'],
    ['https://evil.example', null],
    ['not-an-address', null],
    ['pay@1.2.3.4', null],
    ['pay@foo.local', null],
    ['pay@foo.localhost', null],
    ['pay@metadata.google.internal', null],
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
    expect(body['postCount']).toBe(1);
    expect(body['replyCount']).toBe(0);
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

  it('returns 503 when countByPubkey throws and logs no pubkey', async () => {
    const pubkey = 'ab'.repeat(32);
    const store = {
      getById: () => Promise.resolve(row({ id: NOTE, authorPubkey: pubkey, hasVideo: false })),
      countByPubkey: () => Promise.reject(new Error('boom pubkey')),
    } as unknown as MessageStore;
    const res = await mount(store).request(`/messages/${NOTE}/external-profile`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    const events = parsedEvents(warn);
    const line = events.find((event) => event['event'] === 'messages.external_profile.failed');
    expect(line).toEqual({
      ts: expect.any(String),
      event: 'messages.external_profile.failed',
    });
    expect(JSON.stringify(line)).not.toContain('pubkey');
  });

  it('returns 404 for a member reply and for a reply with no pubkey', async () => {
    const store = new InMemoryMessageStore();
    const pubkey = 'ab'.repeat(32);
    await store.create(row({ id: PARENT, accountId: 'acc', name: 'Parent' }));
    await store.create(
      row({
        id: NOTE,
        parentId: PARENT,
        accountId: 'acc',
        authorPubkey: pubkey,
        name: 'Ada',
      }),
    );
    await store.create(
      row({
        id: '18181818-1818-4181-8181-181818181818',
        parentId: PARENT,
        authorPubkey: null,
        name: 'Ada',
      }),
    );
    const app = mount(store);
    const member = await app.request(`/messages/${NOTE}/external-profile`);
    expect(member.status).toBe(404);
    const missingKey = await app.request(
      '/messages/18181818-1818-4181-8181-181818181818/external-profile',
    );
    expect(missingKey.status).toBe(404);
  });

  it('returns a profile for a reply whose pubkey is a recorded zapper', async () => {
    const store = new InMemoryMessageStore();
    const pubkey = 'cd'.repeat(32);
    await store.create(row({ id: PARENT, accountId: 'acc', name: 'Parent' }));
    await store.recordZapper(pubkey, '11'.repeat(32), new Date(NOW));
    await store.create(row({ id: NOTE, parentId: PARENT, authorPubkey: pubkey, name: 'Ada' }));
    const res = await mount(store).request(`/messages/${NOTE}/external-profile`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: 'Ada',
      npub: npubEncode(pubkey),
      postCount: 0,
      replyCount: 1,
    });
  });

  it('shows a truncated pubkey when the stored name is blank and no querier is set', async () => {
    const store = new InMemoryMessageStore();
    const pubkey = 'ef'.repeat(32);
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: '   ' }));
    const res = await mount(store).request(`/messages/${NOTE}/external-profile`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: truncatePubkeyDisplay(pubkey),
      npub: npubEncode(pubkey),
      postCount: 1,
      replyCount: 0,
    });
  });

  it('keeps the stored name when the relay list is empty', async () => {
    const store = new InMemoryMessageStore();
    const pubkey = 'a1'.repeat(32);
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Ada' }));
    const querier = new RecordingQuerier();
    const res = await mount(store, new InMemoryAuthStore(), {
      nostrQuerier: querier,
      nostrRelayUrls: [],
    }).request(`/messages/${NOTE}/external-profile`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: 'Ada',
      npub: npubEncode(pubkey),
      postCount: 1,
      replyCount: 0,
    });
    expect(querier.calls).toHaveLength(0);
  });

  it('uses a live name from the default relay list when the stored name is blank', async () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const store = new InMemoryMessageStore();
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: '' }));
    const querier = new RecordingQuerier();
    querier.events = [profileEvent({ display_name: 'Robin' }, secret)];
    const res = await mount(store, new InMemoryAuthStore(), { nostrQuerier: querier }).request(
      `/messages/${NOTE}/external-profile`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: 'Robin',
      npub: npubEncode(pubkey),
      postCount: 1,
      replyCount: 0,
    });
    expect(querier.calls[0]?.urls.length).toBeGreaterThan(0);
  });

  it('ignores blank member names when the live name collides with a real one', async () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const store = new InMemoryMessageStore();
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Snapshot' }));
    const querier = new RecordingQuerier();
    querier.events = [profileEvent({ display_name: 'Ada' }, secret)];
    const auth = {
      listAccounts: () => Promise.resolve([{ name: null }, { name: '   ' }, { name: 'Ada' }]),
    } as unknown as InMemoryAuthStore;
    const res = await mount(store, auth, {
      nostrQuerier: querier,
      nostrRelayUrls: ['wss://relay.example'],
    }).request(`/messages/${NOTE}/external-profile`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: 'Snapshot',
      npub: npubEncode(pubkey),
      postCount: 1,
      replyCount: 0,
    });
  });

  it.each([
    'lone@foo.local',
    'lone@foo.localhost',
    'lone@metadata.google.internal',
    'lone@1.2.3.4',
    'lone@256.1.1.1',
    'lone@example.256',
    'not-an-address',
    'https://evil.example',
  ])('omits nip05 %s before DNS', async (nip05) => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const store = new InMemoryMessageStore();
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Old' }));
    const querier = new RecordingQuerier();
    querier.events = [profileEvent({ display_name: 'Robin', nip05 }, secret)];
    const fetchImpl = vi.fn(async () => Response.json({ names: { lone: pubkey } }));
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
      postCount: 1,
      replyCount: 0,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lookupHost).not.toHaveBeenCalled();
  });

  it.each([
    ['1.0.0.1', true],
    ['8.8.8.8', true],
    ['100.63.0.1', true],
    ['100.128.0.1', true],
    ['169.253.0.1', true],
    ['172.15.0.1', true],
    ['172.32.0.1', true],
    ['192.0.1.1', true],
    ['192.88.99.1', false],
    ['192.1.0.1', true],
    ['198.50.0.1', true],
    ['198.51.99.1', true],
    ['203.0.1.1', true],
    ['203.1.0.1', true],
    ['  1.1.1.1  ', true],
    ['::ffff:1.1.1.1', true],
    ['::FFFF:8.8.8.8', true],
    ['::ffff:101:101', true],
    ['0:0:0:0:0:ffff:101:101', true],
    ['0:1:0:0:0:ffff:101:101', true],
    ['0:0:1:0:0:ffff:101:101', true],
    ['0:0:0:1:0:ffff:101:101', true],
    ['0:0:0:0:1:ffff:101:101', true],
    ['0:0:0:0:0:0:101:101', true],
    ['2001:4860:4860::8888', true],
    ['2001:4860:4860:0:0:0:0:8888', true],
    ['2001:DB8::1', false],
    ['100::1', false],
    ['100:0:0:1::1', true],
    ['2001:2::1', false],
    ['2001:2:1::1', true],
    ['3fff:1000::1', true],
    ['2001:0:1::1', false],
    ['2001:1::1', false],
    ['2001:10::1', false],
    ['2001:20::1', false],
    ['3fff::1', false],
    ['5f00::1', false],
    ['fec0::1', false],
    ['64:ff9b:1::1', false],
    ['::2', false],
    ['::7f00:1', false],
    ['::a00:1', false],
    ['::808:808', true],
    ['2002:7f00:1::', false],
    ['2002:808:808::', true],
    ['64:ff9b::7f00:1', false],
    ['64:ff9b::808:808', true],
    ['1::', true],
    ['0.0.0.0', false],
    ['224.0.0.1', false],
    ['100.64.0.1', false],
    ['169.254.1.1', false],
    ['172.16.0.1', false],
    ['172.31.255.1', false],
    ['192.168.1.1', false],
    ['192.0.0.8', false],
    ['192.0.1.1', true],
    ['192.0.2.1', false],
    ['198.17.0.1', true],
    ['198.18.0.1', false],
    ['198.19.255.255', false],
    ['198.20.0.1', true],
    ['198.51.100.1', false],
    ['203.0.113.1', false],
    ['::', false],
    ['0:0:0:0:0:0:0:0', false],
    ['fc00::', false],
    ['fd12:3456::1', false],
    ['fe80::1', false],
    ['ff02::1', false],
    ['::ffff:10.0.0.1', false],
    ['::ffff:0a00:1', false],
    ['0:0:0:0:0:ffff:a00:1', false],
    ['::ffff:0:7f00:1', false],
    ['0:0:0:0:ffff:0:a00:1', false],
    ['::ffff:0:808:808', true],
    ['::ffff:999.1.1.1', false],
    ['::ffff:1.2.3', false],
    ['256.1.1.1', false],
    ['01.2.3.4', false],
    ['1.2.3', false],
    ['1.2.3.4.5', false],
    ['not-an-ip', false],
    ['gggg::1', false],
    ['1:2:3:4:5:6:7', false],
    ['1:2:3:4:5:6:7::8', false],
    ['1:2:3:4:5:6:7:8::', false],
    ['1::2::3', false],
    [':::', false],
  ] as const)('nip05 DNS answer %s is public=%s', async (address, isPublic) => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const store = new InMemoryMessageStore();
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Old' }));
    const querier = new RecordingQuerier();
    querier.events = [profileEvent({ display_name: 'Robin', nip05: 'lone@example.com' }, secret)];
    const fetchImpl = vi.fn(async () => Response.json({ names: { lone: pubkey } }));
    const res = await mount(store, new InMemoryAuthStore(), {
      nostrQuerier: querier,
      nostrRelayUrls: ['wss://relay.example'],
      fetchImpl,
      lookupHost: async () => [address],
    }).request(`/messages/${NOTE}/external-profile`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    if (isPublic) {
      expect(body['nip05']).toBe('lone@example.com');
      expect(fetchImpl).toHaveBeenCalled();
    } else {
      expect(body).not.toHaveProperty('nip05');
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('omits nip05 when DNS returns nothing or throws', async () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const store = new InMemoryMessageStore();
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Old' }));
    const querier = new RecordingQuerier();
    querier.events = [profileEvent({ display_name: 'Robin', nip05: 'lone@example.com' }, secret)];
    for (const lookupHost of [
      async () => [] as readonly string[],
      async () => {
        throw new Error('dns');
      },
    ]) {
      const fetchImpl = vi.fn(async () => Response.json({ names: { lone: pubkey } }));
      const res = await mount(store, new InMemoryAuthStore(), {
        nostrQuerier: querier,
        nostrRelayUrls: ['wss://relay.example'],
        fetchImpl,
        lookupHost,
      }).request(`/messages/${NOTE}/external-profile`);
      expect(res.status).toBe(200);
      expect(await res.json()).not.toHaveProperty('nip05');
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it.each([
    'https://localhost/x',
    'https://127.0.0.1/x',
    'https://[::1]/x',
    'https://.',
    'https://foo.local/x',
    'https://foo.localhost/x',
    'https://metadata.google.internal/x',
  ])('omits nip05 when a redirect lands on %s', async (location) => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const store = new InMemoryMessageStore();
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Old' }));
    const querier = new RecordingQuerier();
    querier.events = [profileEvent({ display_name: 'Robin', nip05: 'lone@example.com' }, secret)];
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location } }));
    const lookupHost = vi.fn(async () => ['1.1.1.1']);
    const res = await mount(store, new InMemoryAuthStore(), {
      nostrQuerier: querier,
      nostrRelayUrls: ['wss://relay.example'],
      fetchImpl,
      lookupHost,
    }).request(`/messages/${NOTE}/external-profile`);
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('nip05');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([301, 303, 307, 308])('follows one https %s to a matching document', async (status) => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const store = new InMemoryMessageStore();
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Old' }));
    const querier = new RecordingQuerier();
    querier.events = [profileEvent({ display_name: 'Robin', nip05: 'lone@example.com' }, secret)];
    let calls = 0;
    const fetchImpl: FetchFn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(null, {
          status,
          headers: { location: 'https://cdn.example/.well-known/nostr.json?name=lone' },
        });
      }
      return Response.json({ names: { lone: pubkey } });
    });
    const res = await mount(store, new InMemoryAuthStore(), {
      nostrQuerier: querier,
      nostrRelayUrls: ['wss://relay.example'],
      fetchImpl,
      lookupHost: async () => ['1.1.1.1'],
    }).request(`/messages/${NOTE}/external-profile`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ nip05: 'lone@example.com' });
  });

  it('omits nip05 when redirects never finish on https', async () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const store = new InMemoryMessageStore();
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Old' }));
    const querier = new RecordingQuerier();
    querier.events = [profileEvent({ display_name: 'Robin', nip05: 'lone@example.com' }, secret)];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const current = String(url);
      if (current.includes('third')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://example.com/fourth' },
        });
      }
      const location = current.includes('second')
        ? 'https://example.com/third'
        : 'https://example.com/second';
      return new Response(null, { status: 302, headers: { location } });
    });
    const res = await mount(store, new InMemoryAuthStore(), {
      nostrQuerier: querier,
      nostrRelayUrls: ['wss://relay.example'],
      fetchImpl,
      lookupHost: async () => ['1.1.1.1'],
    }).request(`/messages/${NOTE}/external-profile`);
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('nip05');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('omits nip05 when the redirect target is missing, blank, or not a URL', async () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const store = new InMemoryMessageStore();
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Old' }));
    const querier = new RecordingQuerier();
    querier.events = [profileEvent({ display_name: 'Robin', nip05: 'lone@example.com' }, secret)];
    const redirects = [
      new Response(null, { status: 302 }),
      new Response(null, { status: 302, headers: { location: '   ' } }),
      new Response(null, { status: 302, headers: { location: 'https://[::' } }),
    ];
    for (const redirect of redirects) {
      const fetchImpl = vi.fn(async () => redirect);
      const res = await mount(store, new InMemoryAuthStore(), {
        nostrQuerier: querier,
        nostrRelayUrls: ['wss://relay.example'],
        fetchImpl,
        lookupHost: async () => ['1.1.1.1'],
      }).request(`/messages/${NOTE}/external-profile`);
      expect(res.status).toBe(200);
      expect(await res.json()).not.toHaveProperty('nip05');
    }
  });

  it('omits nip05 when the document is not a matching names map', async () => {
    const bodies = [
      'not-json',
      'null',
      '[]',
      '42',
      '{}',
      '{"names":null}',
      '{"names":[]}',
      '{"names":{"lone":1}}',
      '{"names":{"lone":"00"}}',
    ];
    for (const body of bodies) {
      const secret = generateSecretKey();
      const pubkey = getPublicKey(secret);
      const store = new InMemoryMessageStore();
      await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Old' }));
      const querier = new RecordingQuerier();
      querier.events = [profileEvent({ display_name: 'Robin', nip05: 'lone@example.com' }, secret)];
      const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
      const res = await mount(store, new InMemoryAuthStore(), {
        nostrQuerier: querier,
        nostrRelayUrls: ['wss://relay.example'],
        fetchImpl,
        lookupHost: async () => ['1.1.1.1'],
      }).request(`/messages/${NOTE}/external-profile`);
      expect(res.status).toBe(200);
      expect(await res.json()).not.toHaveProperty('nip05');
    }
  });

  it('omits nip05 when the well-known response is unusable', async () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const store = new InMemoryMessageStore();
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Old' }));
    const querier = new RecordingQuerier();
    querier.events = [profileEvent({ display_name: 'Robin', nip05: 'lone@example.com' }, secret)];
    const failures: FetchFn[] = [
      async () => {
        throw new Error('network');
      },
      async () => new Response('no', { status: 404 }),
      async () =>
        asResponse({
          status: 200,
          headers: new Headers({ 'content-length': '70000' }),
          text: () => Promise.resolve('{}'),
        }),
      async () =>
        asResponse({
          status: 200,
          text: () => Promise.resolve('x'.repeat(65_537)),
        }),
      async () =>
        asResponse({
          status: 200,
          text: () => Promise.reject(new Error('read')),
        }),
    ];
    for (const fetchImpl of failures) {
      const res = await mount(store, new InMemoryAuthStore(), {
        nostrQuerier: querier,
        nostrRelayUrls: ['wss://relay.example'],
        fetchImpl,
        lookupHost: async () => ['1.1.1.1'],
      }).request(`/messages/${NOTE}/external-profile`);
      expect(res.status).toBe(200);
      expect(await res.json()).not.toHaveProperty('nip05');
    }
  });

  it('accepts a matching document with a non-numeric or absent content-length', async () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const store = new InMemoryMessageStore();
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Old' }));
    const querier = new RecordingQuerier();
    querier.events = [profileEvent({ display_name: 'Robin', nip05: 'lone@example.com' }, secret)];
    const document = JSON.stringify({ names: { lone: pubkey } });
    const fetches: FetchFn[] = [
      async () =>
        asResponse({
          status: 200,
          headers: new Headers({ 'content-length': 'abc' }),
          text: () => Promise.resolve(document),
        }),
      async () =>
        asResponse({
          status: 200,
          text: () => Promise.resolve(document),
        }),
    ];
    for (const fetchImpl of fetches) {
      const res = await mount(store, new InMemoryAuthStore(), {
        nostrQuerier: querier,
        nostrRelayUrls: ['wss://relay.example'],
        fetchImpl,
        lookupHost: async () => ['1.1.1.1'],
      }).request(`/messages/${NOTE}/external-profile`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ nip05: 'lone@example.com' });
    }
  });

  it('counts a streamed well-known body and stops when it is too large or unreadable', async () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const store = new InMemoryMessageStore();
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Old' }));
    const querier = new RecordingQuerier();
    querier.events = [profileEvent({ display_name: 'Robin', nip05: 'lone@example.com' }, secret)];
    const document = JSON.stringify({ names: { lone: pubkey } });
    const encoded = new TextEncoder().encode(document);
    const readable = () => Promise.resolve(document);
    const cases: Array<{ response: Response; matched: boolean }> = [
      {
        matched: true,
        response: asResponse({
          status: 200,
          body: null,
          text: readable,
        }),
      },
      {
        matched: true,
        response: asResponse({
          status: 200,
          body: byteStream([encoded.subarray(0, 1), encoded.subarray(1)]),
          text: readable,
        }),
      },
      {
        matched: false,
        response: asResponse({
          status: 200,
          body: byteStream([]),
          text: readable,
        }),
      },
      {
        matched: false,
        response: asResponse({
          status: 200,
          headers: new Headers({ 'content-length': '10' }),
          body: byteStream([new Uint8Array(65_537)]),
          text: readable,
        }),
      },
      {
        matched: false,
        response: asResponse({
          status: 200,
          body: byteStream([], true),
          text: readable,
        }),
      },
    ];
    for (const { response, matched } of cases) {
      const res = await mount(store, new InMemoryAuthStore(), {
        nostrQuerier: querier,
        nostrRelayUrls: ['wss://relay.example'],
        fetchImpl: async () => response,
        lookupHost: async () => ['1.1.1.1'],
      }).request(`/messages/${NOTE}/external-profile`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      if (matched) {
        expect(body['nip05']).toBe('lone@example.com');
      } else {
        expect(body).not.toHaveProperty('nip05');
      }
    }
  });

  it('follows a trailing-dot https host when its addresses are public', async () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const store = new InMemoryMessageStore();
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Old' }));
    const querier = new RecordingQuerier();
    querier.events = [profileEvent({ display_name: 'Robin', nip05: 'lone@example.com' }, secret)];
    let calls = 0;
    const fetchImpl: FetchFn = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://example.com./.well-known/nostr.json?name=lone' },
        });
      }
      return Response.json({ names: { lone: pubkey } });
    };
    const lookupHost = vi.fn(async () => ['1.1.1.1']);
    const res = await mount(store, new InMemoryAuthStore(), {
      nostrQuerier: querier,
      nostrRelayUrls: ['wss://relay.example'],
      fetchImpl,
      lookupHost,
    }).request(`/messages/${NOTE}/external-profile`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ nip05: 'lone@example.com' });
    expect(lookupHost).toHaveBeenCalledWith('example.com.');
  });

  it('resolves nip05 through production DNS when lookup is not injected', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '1.1.1.1', family: 4 }] as never);
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const store = new InMemoryMessageStore();
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Old' }));
    const querier = new RecordingQuerier();
    querier.events = [profileEvent({ display_name: 'Robin', nip05: 'lone@example.com' }, secret)];
    const fetchImpl: FetchFn = async () => Response.json({ names: { lone: pubkey } });
    const res = await mount(store, new InMemoryAuthStore(), {
      nostrQuerier: querier,
      nostrRelayUrls: ['wss://relay.example'],
      fetchImpl,
    }).request(`/messages/${NOTE}/external-profile`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ nip05: 'lone@example.com' });
    expect(lookup).toHaveBeenCalledWith('example.com', { all: true, verbatim: true });
  });

  it('omits nip05 when production DNS throws', async () => {
    vi.mocked(lookup).mockRejectedValue(new Error('dns'));
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const store = new InMemoryMessageStore();
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Old' }));
    const querier = new RecordingQuerier();
    querier.events = [profileEvent({ display_name: 'Robin', nip05: 'lone@example.com' }, secret)];
    const fetchImpl = vi.fn(async () => Response.json({ names: { lone: pubkey } }));
    const res = await mount(store, new InMemoryAuthStore(), {
      nostrQuerier: querier,
      nostrRelayUrls: ['wss://relay.example'],
      fetchImpl,
    }).request(`/messages/${NOTE}/external-profile`);
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('nip05');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('GET /messages/:id/external-posts', () => {
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
    const bad = await app.request('/messages/not-a-uuid/external-posts');
    expect(bad.status).toBe(404);
    expect(await bad.json()).toEqual({ error: 'Not found' });
    const missing = await app.request(
      '/messages/17171717-1717-4171-8171-171717171717/external-posts',
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Not found' });
    const deleted = await app.request(`/messages/${NOTE}/external-posts`, {
      headers: { authorization: 'Bearer staff' },
    });
    expect(deleted.status).toBe(404);
    expect(await deleted.json()).toEqual({ error: 'Not found' });
    const member = await app.request(
      '/messages/16161616-1616-4161-8161-161616161616/external-posts',
    );
    expect(member.status).toBe(404);
    expect(await member.json()).toEqual({ error: 'Not found' });
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
    const res = await mount(store).request(`/messages/${NOTE}/external-posts`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns live posts newest-first with replyCount of attributed children', async () => {
    const store = new InMemoryMessageStore();
    const pubkey = 'ab'.repeat(32);
    const newer = '19191919-1919-4191-8191-191919191919';
    const zapperChild = 'cd'.repeat(32);
    await store.create(
      row({ id: NOTE, authorPubkey: pubkey, name: 'Ada', createdAt: new Date(NOW) }),
    );
    await store.create(
      row({
        id: newer,
        authorPubkey: pubkey,
        name: 'Ada',
        createdAt: new Date(NOW + 1000),
      }),
    );
    await store.create(
      row({
        id: '1b1b1b1b-1b1b-41b1-81b1-1b1b1b1b1b1b',
        parentId: NOTE,
        accountId: 'acc',
        name: 'Member child',
      }),
    );
    await store.recordZapper(zapperChild, '11'.repeat(32), new Date(NOW));
    await store.create(
      row({
        id: '1c1c1c1c-1c1c-41c1-81c1-1c1c1c1c1c1c',
        parentId: NOTE,
        authorPubkey: zapperChild,
        name: 'Zapper child',
      }),
    );
    await store.create(
      row({
        id: '1d1d1d1d-1d1d-41d1-81d1-1d1d1d1d1d1d',
        parentId: NOTE,
        authorPubkey: 'ef'.repeat(32),
        name: 'External child',
      }),
    );
    const res = await mount(store).request(`/messages/${NOTE}/external-posts`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<Record<string, unknown>> };
    expect(body.messages.map((message) => message['id'])).toEqual([newer, NOTE]);
    const seed = body.messages.find((message) => message['id'] === NOTE);
    expect(seed).toMatchObject({
      payable: false,
      via: 'nostr',
      replyCount: 2,
    });
    expect(seed).not.toHaveProperty('role');
    expect(seed).not.toHaveProperty('accountId');
    const later = body.messages.find((message) => message['id'] === newer);
    expect(later).toMatchObject({
      payable: false,
      via: 'nostr',
      replyCount: 0,
    });
    expect(later).not.toHaveProperty('role');
    expect(later).not.toHaveProperty('accountId');
  });

  it('returns 503 and logs no pubkey when listPostsByPubkey throws', async () => {
    const pubkey = 'ab'.repeat(32);
    const store = {
      getById: () => Promise.resolve(row({ id: NOTE, authorPubkey: pubkey, hasVideo: false })),
      listPostsByPubkey: () => Promise.reject(new Error('boom pubkey')),
    } as unknown as MessageStore;
    const res = await mount(store).request(`/messages/${NOTE}/external-posts`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    const events = parsedEvents(warn);
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'messages.external_posts.failed' }),
    );
    const line = events.find((event) => event['event'] === 'messages.external_posts.failed');
    expect(line).toEqual({
      ts: expect.any(String),
      event: 'messages.external_posts.failed',
    });
    expect(JSON.stringify(line)).not.toContain('pubkey');
  });

  it('skips a post whose video file is missing and still returns the other note', async () => {
    const pubkey = 'ab'.repeat(32);
    const clipId = '1e1e1e1e-1e1e-41e1-81e1-1e1e1e1e1e1e';
    const good = row({ id: NOTE, authorPubkey: pubkey, name: 'Ada' });
    const clip = row({
      id: clipId,
      authorPubkey: pubkey,
      name: 'Ada',
      text: 'clip',
      hasVideo: true,
      videoContentType: 'video/mp4',
    });
    const store = {
      getById: () => Promise.resolve(good),
      listPostsByPubkey: () => Promise.resolve([clip, good]),
      deleteById: () => Promise.resolve(true),
      heartStats: () => Promise.resolve(new Map()),
    } as unknown as MessageStore;
    const res = await mount(store).request(`/messages/${NOTE}/external-posts`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ id: string }> };
    expect(body.messages.map((message) => message.id)).toEqual([NOTE]);
    expect(parsedEvents(warn)).toContainEqual(
      expect.objectContaining({ event: 'messages.video.dropped' }),
    );
  });

  it('skips a post that cannot be serialized and still returns the other note', async () => {
    const pubkey = 'ab'.repeat(32);
    const good = row({ id: NOTE, authorPubkey: pubkey, name: 'Ada' });
    const bad = row({
      id: '1f1f1f1f-1f1f-41f1-81f1-1f1f1f1f1f1f',
      authorPubkey: pubkey,
      name: 'Ada',
      createdAt: {
        toISOString() {
          throw new Error('bad date');
        },
      } as unknown as Date,
    });
    const store = {
      getById: () => Promise.resolve(good),
      listPostsByPubkey: () => Promise.resolve([bad, good]),
      heartStats: () => Promise.resolve(new Map()),
    } as unknown as MessageStore;
    const res = await mount(store).request(`/messages/${NOTE}/external-posts`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ id: string }> };
    expect(body.messages.map((message) => message.id)).toEqual([NOTE]);
  });

  it('returns 503 when dropping a missing video throws', async () => {
    const pubkey = 'ab'.repeat(32);
    const clip = row({
      id: '1e1e1e1e-1e1e-41e1-81e1-1e1e1e1e1e1e',
      authorPubkey: pubkey,
      hasVideo: true,
      videoContentType: 'video/mp4',
    });
    const store = {
      getById: () => Promise.resolve(row({ id: NOTE, authorPubkey: pubkey, hasVideo: false })),
      listPostsByPubkey: () => Promise.resolve([clip]),
      deleteById: () => Promise.reject(new Error('disk')),
    } as unknown as MessageStore;
    const res = await mount(store).request(`/messages/${NOTE}/external-posts`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    const line = parsedEvents(warn).find(
      (event) => event['event'] === 'messages.external_posts.failed',
    );
    expect(line).toEqual({
      ts: expect.any(String),
      event: 'messages.external_posts.failed',
    });
    expect(JSON.stringify(line)).not.toContain(pubkey);
  });

  it('passes the signed-in viewer id to heartStats', async () => {
    const pubkey = 'ab'.repeat(32);
    const good = row({ id: NOTE, authorPubkey: pubkey, name: 'Ada' });
    const heartStats = vi.fn((ids: readonly string[], viewer: string | null) => {
      void ids;
      void viewer;
      return Promise.resolve(new Map());
    });
    const store = {
      getById: () => Promise.resolve(good),
      listPostsByPubkey: () => Promise.resolve([good]),
      heartStats,
    } as unknown as MessageStore;
    const auth = new InMemoryAuthStore();
    await auth.createAccount({
      id: 'acc',
      linkingKey: 'ab'.repeat(32),
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1_000_000,
      rulesAgreedAt: null,
      walletRequired: true,
    });
    await auth.createSession({ token: 'tok', accountId: 'acc', createdAt: NOW });
    const res = await mount(store, auth).request(`/messages/${NOTE}/external-posts`, {
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.status).toBe(200);
    expect(heartStats).toHaveBeenCalledWith([NOTE], 'acc');
  });
});

describe('GET /messages/:id/external-replies', () => {
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
    const bad = await app.request('/messages/not-a-uuid/external-replies');
    expect(bad.status).toBe(404);
    expect(await bad.json()).toEqual({ error: 'Not found' });
    const missing = await app.request(
      '/messages/17171717-1717-4171-8171-171717171717/external-replies',
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Not found' });
    const deleted = await app.request(`/messages/${NOTE}/external-replies`, {
      headers: { authorization: 'Bearer staff' },
    });
    expect(deleted.status).toBe(404);
    expect(await deleted.json()).toEqual({ error: 'Not found' });
    const member = await app.request(
      '/messages/16161616-1616-4161-8161-161616161616/external-replies',
    );
    expect(member.status).toBe(404);
    expect(await member.json()).toEqual({ error: 'Not found' });
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
    const res = await mount(store).request(`/messages/${NOTE}/external-replies`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns a zapper reply with parentId and without replyCount', async () => {
    const store = new InMemoryMessageStore();
    const pubkey = 'cd'.repeat(32);
    await store.create(row({ id: PARENT, accountId: 'acc', name: 'Parent' }));
    await store.recordZapper(pubkey, '11'.repeat(32), new Date(NOW));
    await store.create(row({ id: NOTE, parentId: PARENT, authorPubkey: pubkey, name: 'Ada' }));
    const res = await mount(store).request(`/messages/${NOTE}/external-replies`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<Record<string, unknown>> };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({
      id: NOTE,
      parentId: PARENT,
      payable: false,
      via: 'nostr',
    });
    expect(body.messages[0]).not.toHaveProperty('role');
    expect(body.messages[0]).not.toHaveProperty('replyCount');
  });

  it('returns an empty list for a non-zapper top-level author even when replies exist', async () => {
    const store = new InMemoryMessageStore();
    const pubkey = 'ab'.repeat(32);
    await store.create(row({ id: NOTE, authorPubkey: pubkey, name: 'Ada' }));
    await store.create(
      row({
        id: '19191919-1919-4191-8191-191919191919',
        parentId: NOTE,
        authorPubkey: pubkey,
        name: 'Ada',
      }),
    );
    const res = await mount(store).request(`/messages/${NOTE}/external-replies`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
  });

  it('returns 503 and logs no pubkey when listRepliesByPubkey throws', async () => {
    const pubkey = 'ab'.repeat(32);
    const store = {
      getById: () => Promise.resolve(row({ id: NOTE, authorPubkey: pubkey, hasVideo: false })),
      listRepliesByPubkey: () => Promise.reject(new Error('boom pubkey')),
    } as unknown as MessageStore;
    const res = await mount(store).request(`/messages/${NOTE}/external-replies`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    const events = parsedEvents(warn);
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'messages.external_replies.failed' }),
    );
    const line = events.find((event) => event['event'] === 'messages.external_replies.failed');
    expect(line).toEqual({
      ts: expect.any(String),
      event: 'messages.external_replies.failed',
    });
    expect(JSON.stringify(line)).not.toContain('pubkey');
  });

  it('skips a reply whose video file is missing and still returns the other note', async () => {
    const pubkey = 'cd'.repeat(32);
    const clipId = '2e2e2e2e-2e2e-42e2-82e2-2e2e2e2e2e2e';
    const good = row({ id: NOTE, parentId: PARENT, authorPubkey: pubkey, name: 'Ada' });
    const clip = row({
      id: clipId,
      parentId: PARENT,
      authorPubkey: pubkey,
      name: 'Ada',
      text: 'clip',
      hasVideo: true,
      videoContentType: 'video/mp4',
    });
    const store = {
      getById: () => Promise.resolve(good),
      isZapperPubkey: () => Promise.resolve(true),
      listRepliesByPubkey: () => Promise.resolve([clip, good]),
      deleteById: () => Promise.resolve(true),
      heartStats: () => Promise.resolve(new Map()),
    } as unknown as MessageStore;
    const res = await mount(store).request(`/messages/${NOTE}/external-replies`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ id: string }> };
    expect(body.messages.map((message) => message.id)).toEqual([NOTE]);
    expect(parsedEvents(warn)).toContainEqual(
      expect.objectContaining({ event: 'messages.video.dropped' }),
    );
  });

  it('skips a reply that cannot be serialized and still returns the other note', async () => {
    const pubkey = 'cd'.repeat(32);
    const good = row({ id: NOTE, parentId: PARENT, authorPubkey: pubkey, name: 'Ada' });
    const bad = row({
      id: '2f2f2f2f-2f2f-42f2-82f2-2f2f2f2f2f2f',
      parentId: PARENT,
      authorPubkey: pubkey,
      name: 'Ada',
      createdAt: {
        toISOString() {
          throw new Error('bad date');
        },
      } as unknown as Date,
    });
    const store = {
      getById: () => Promise.resolve(good),
      isZapperPubkey: () => Promise.resolve(true),
      listRepliesByPubkey: () => Promise.resolve([bad, good]),
      heartStats: () => Promise.resolve(new Map()),
    } as unknown as MessageStore;
    const res = await mount(store).request(`/messages/${NOTE}/external-replies`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ id: string }> };
    expect(body.messages.map((message) => message.id)).toEqual([NOTE]);
  });

  it('returns 503 when dropping a missing reply video throws', async () => {
    const pubkey = 'cd'.repeat(32);
    const gate = row({ id: NOTE, authorPubkey: pubkey, hasVideo: false });
    const clip = row({
      id: '2e2e2e2e-2e2e-42e2-82e2-2e2e2e2e2e2e',
      parentId: PARENT,
      authorPubkey: pubkey,
      hasVideo: true,
      videoContentType: 'video/mp4',
    });
    const store = {
      getById: () => Promise.resolve(gate),
      listRepliesByPubkey: () => Promise.resolve([clip]),
      deleteById: () => Promise.reject(new Error('disk')),
    } as unknown as MessageStore;
    const res = await mount(store).request(`/messages/${NOTE}/external-replies`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    const line = parsedEvents(warn).find(
      (event) => event['event'] === 'messages.external_replies.failed',
    );
    expect(line).toEqual({
      ts: expect.any(String),
      event: 'messages.external_replies.failed',
    });
    expect(JSON.stringify(line)).not.toContain(pubkey);
  });

  it('passes the signed-in viewer id to heartStats', async () => {
    const pubkey = 'cd'.repeat(32);
    const good = row({ id: NOTE, parentId: PARENT, authorPubkey: pubkey, name: 'Ada' });
    const heartStats = vi.fn((ids: readonly string[], viewer: string | null) => {
      void ids;
      void viewer;
      return Promise.resolve(new Map());
    });
    const store = {
      getById: () => Promise.resolve(good),
      isZapperPubkey: () => Promise.resolve(true),
      listRepliesByPubkey: () => Promise.resolve([good]),
      heartStats,
    } as unknown as MessageStore;
    const auth = new InMemoryAuthStore();
    await auth.createAccount({
      id: 'acc',
      linkingKey: 'ab'.repeat(32),
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1_000_000,
      rulesAgreedAt: null,
      walletRequired: true,
    });
    await auth.createSession({ token: 'tok', accountId: 'acc', createdAt: NOW });
    const res = await mount(store, auth).request(`/messages/${NOTE}/external-replies`, {
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.status).toBe(200);
    expect(heartStats).toHaveBeenCalledWith([NOTE], 'acc');
  });
});
