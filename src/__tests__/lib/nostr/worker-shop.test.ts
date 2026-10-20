import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyEvent, type NostrEvent } from 'nostr-tools/pure';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import { unsignedNostrDefaults, type ForumPhoto, type MessageRow } from '@/lib/message';
import { InMemoryMessageStore, type MessageStore } from '@/lib/message-store';
import { buildNostrJson } from '@/lib/nip05';
import { KIND0_BANNER_URL, KIND0_PICTURE_URL } from '@/lib/nostr/event';
import { parseNostrKek } from '@/lib/nostr/kek';
import { RecordingPublisher } from '@/lib/nostr/publish';
import { RecordingQuerier } from '@/lib/nostr/query';
import { runNostrWorkerTick, type NostrWorkerDeps } from '@/lib/nostr/worker';
import {
  InMemoryShopIdentityStore,
  shopNpub,
  type ShopIdentityRow,
  type ShopIdentityStore,
} from '@/lib/shop-identity';

const KEK = parseNostrKek('cd'.repeat(32));
const TILL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TEXT = 'Fresh coffee roasted here every morning. #21GiftsShop';
const ENV = {
  NOSTR_PUBLISH: '1',
  NOSTR_RELAY_SPACE: 'wss://relay.nostr.space',
  PUBLIC_BASE_URL: 'https://21.gifts',
};
const PUBLIC_ENV = {
  ...ENV,
  NOSTR_PUBLISH_PUBLIC: '1',
  NOSTR_RELAY_PUBLIC: 'wss://relay.damus.io',
};

function uuid(n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

function shopNote(id: string, overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id,
    accountId: 'author',
    name: 'Ada',
    text: TEXT,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    hasPhoto: false,
    ...unsignedNostrDefaults(),
    place: {
      lat: 47.3,
      lng: 8.5,
      label: 'Coffee Lab',
      address: {
        street: 'Main Street',
        houseNumber: '1',
        postalCode: '8001',
        city: 'Zürich',
        country: 'CH',
      },
    },
    shopAccount: { id: TILL, username: 'coffee', name: 'Coffee' },
    ...overrides,
  };
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: TILL,
    linkingKey: null,
    role: 'basis',
    name: 'Coffee',
    username: 'coffee',
    lightningAddress: 'coffee@example.com',
    lightningAddressVerified: true,
    forumLawsDismissed: false,
    location: null,
    viewKey: '11'.repeat(32),
    createdAt: 1,
    rulesAgreedAt: null,
    ...overrides,
  } as Account;
}

const PNG: ForumPhoto = { contentType: 'image/png', bytes: new Uint8Array([1, 2, 3]) };
const JPEG: ForumPhoto = { contentType: 'image/jpeg', bytes: new Uint8Array([4, 5]) };

interface Ctx {
  auth: InMemoryAuthStore;
  messages: InMemoryMessageStore;
  shops: InMemoryShopIdentityStore;
  publisher: RecordingPublisher;
}

async function context(
  notes: Array<{ row: MessageRow; photos?: ForumPhoto[] }>,
  till: Account | null = account(),
): Promise<Ctx> {
  const auth = new InMemoryAuthStore();
  if (till !== null) await auth.createAccount(till);
  const messages = new InMemoryMessageStore();
  for (const { row, photos = [] } of notes) {
    await messages.create(row, photos[0], undefined, photos.slice(1));
  }
  return {
    auth,
    messages,
    shops: new InMemoryShopIdentityStore(messages),
    publisher: new RecordingPublisher(),
  };
}

let clock = 1_700_000_000_000;

async function tick(
  ctx: Ctx,
  env: Record<string, string> = ENV,
  overrides: Partial<NostrWorkerDeps> = {},
): Promise<void> {
  clock += 60_000;
  const now = clock;
  await runNostrWorkerTick({
    messages: ctx.messages,
    auth: ctx.auth,
    kek: KEK,
    publisher: ctx.publisher,
    querier: new RecordingQuerier(),
    fetchImpl: async () => new Response('{}', { status: 500 }),
    now: () => now,
    env,
    shopIdentities: ctx.shops,
    ...overrides,
  });
}

function shopEvents(ctx: Ctx, identity: ShopIdentityRow, kind: number): NostrEvent[] {
  return ctx.publisher.calls
    .filter(
      (call) =>
        call.event['pubkey'] === identity.nostrPubkey &&
        call.event['kind'] === kind &&
        call.urls.includes('wss://relay.nostr.space'),
    )
    .map((call) => call.event as unknown as NostrEvent);
}

function content(event: NostrEvent | undefined): Record<string, unknown> {
  return JSON.parse(String(event?.content)) as Record<string, unknown>;
}

/** Same object with some methods replaced; other methods stay bound to the original. */
function override<T extends object>(target: T, replaced: Partial<T>): T {
  return new Proxy(target, {
    get(object, key) {
      if (Object.hasOwn(replaced, key)) return (replaced as Record<PropertyKey, unknown>)[key];
      const value: unknown = Reflect.get(object, key, object);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(object)
        : value;
    },
  });
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
});

function logged(event: string): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line['event'] === event);
}

describe('shop key backfill', () => {
  it('creates the key of a listed shop and queues its place push', async () => {
    const ctx = await context([{ row: shopNote(uuid(1)) }]);
    await tick(ctx);
    const identity = await ctx.shops.getByMessageId(uuid(1));
    expect(identity).toMatchObject({ ocpPlacePending: true, ocpPlaceGeneration: 1 });
  });

  it('walks past incomplete notes and wraps around', async () => {
    const notes = Array.from({ length: 21 }, (_, index) => ({
      row: shopNote(uuid(index + 1), {
        text: 'Too short #21GiftsShop',
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
      }),
    }));
    notes.push({ row: shopNote(uuid(99), { createdAt: new Date(Date.UTC(2026, 0, 2)) }) });
    const ctx = await context(notes);
    await tick(ctx);
    expect(await ctx.shops.getByMessageId(uuid(99))).toBeUndefined();
    await tick(ctx);
    expect(await ctx.shops.getByMessageId(uuid(99))).toBeDefined();
    await ctx.messages.updateText(uuid(1), TEXT);
    await tick(ctx);
    expect(await ctx.shops.getByMessageId(uuid(1))).toBeDefined();
  });

  it('logs shop.nostr_key.failed and continues', async () => {
    const ctx = await context([{ row: shopNote(uuid(1)) }, { row: shopNote(uuid(2)) }]);
    let calls = 0;
    const failing = override<ShopIdentityStore>(ctx.shops, {
      ensureListed: (id, kek) => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('db')) : ctx.shops.ensureListed(id, kek);
      },
    });
    await tick(ctx, {}, { shopIdentities: failing });
    expect(logged('shop.nostr_key.failed')).toEqual([
      expect.objectContaining({ messageId: uuid(1) }),
    ]);
    expect(await ctx.shops.getByMessageId(uuid(2))).toBeDefined();
  });

  it('does nothing without a shop store', async () => {
    const ctx = await context([{ row: shopNote(uuid(1)) }]);
    await tick(ctx, ENV, { shopIdentities: undefined as unknown as ShopIdentityStore });
    expect(await ctx.shops.listAll()).toEqual([]);
  });
});

describe('shop kind 0', () => {
  it('publishes the listed profile signed by the shop key, once per content', async () => {
    const ctx = await context([
      { row: shopNote(uuid(1), { hasPhoto: true }), photos: [PNG, JPEG] },
    ]);
    await tick(ctx);
    const identity = (await ctx.shops.getByMessageId(uuid(1)))!;
    const events = shopEvents(ctx, identity, 0);
    expect(events).toHaveLength(1);
    expect(verifyEvent(events[0]!)).toBe(true);
    expect(content(events[0])).toEqual({
      name: 'Coffee Lab',
      display_name: 'Coffee Lab',
      website: `https://21.gifts/${shopNpub(identity)}`,
      about: 'Fresh coffee roasted here every morning.',
      banner: `https://api.21.gifts/messages/${uuid(1)}/photo/1.jpg`,
      picture: `https://api.21.gifts/messages/${uuid(1)}/photo.png`,
      lud16: 'coffee@example.com',
      nip05: 'coffee-lab@21.gifts',
    });
    expect(logged('nostr.profile.ok')).toContainEqual(
      expect.objectContaining({ messageId: uuid(1) }),
    );
    await tick(ctx);
    expect(shopEvents(ctx, identity, 0)).toHaveLength(1);
  });

  it('follows a rename with a new local part and profile_name', async () => {
    const ctx = await context([{ row: shopNote(uuid(1)) }]);
    await tick(ctx);
    await ctx.messages.setPlace(uuid(1), { ...shopNote(uuid(1)).place!, label: 'Roastery' });
    await tick(ctx);
    const identity = (await ctx.shops.getByMessageId(uuid(1)))!;
    const events = shopEvents(ctx, identity, 0);
    expect(events).toHaveLength(2);
    expect(content(events[1])).toMatchObject({ name: 'Roastery', nip05: 'roastery@21.gifts' });
    expect(events[1]!.created_at).toBeGreaterThan(events[0]!.created_at);
    expect(identity.profileName).toBe('Roastery');
  });

  it('keeps the last listed name for an unlisted shop and uses Shop once it is hidden', async () => {
    const ctx = await context([{ row: shopNote(uuid(1), { hasPhoto: true }), photos: [PNG] }]);
    await tick(ctx);
    const identity = (await ctx.shops.getByMessageId(uuid(1)))!;
    await ctx.messages.updateText(uuid(1), 'Too short #21GiftsShop');
    await tick(ctx);
    await ctx.messages.markDeleted(uuid(1), new Date(0), 'staff');
    await tick(ctx);
    const events = shopEvents(ctx, identity, 0);
    expect(events).toHaveLength(3);
    const website = `https://21.gifts/${shopNpub(identity)}`;
    expect(content(events[1])).toEqual({
      name: 'Coffee Lab',
      display_name: 'Coffee Lab',
      website,
      about: 'This shop is no longer listed on 21.gifts.',
    });
    expect(content(events[2])).toEqual({
      name: 'Shop',
      display_name: 'Shop',
      website,
      about: 'This shop is no longer listed on 21.gifts.',
    });
  });

  it('uses Shop when the note is gone', async () => {
    const ctx = await context([{ row: shopNote(uuid(1)) }]);
    await ctx.shops.ensureListed(uuid(1), KEK);
    const gone = override<MessageStore>(ctx.messages, {
      getById: () => Promise.resolve(undefined),
    });
    await tick(ctx, ENV, { messages: gone });
    const identity = (await ctx.shops.getByMessageId(uuid(1)))!;
    expect(content(shopEvents(ctx, identity, 0)[0])).toMatchObject({ name: 'Shop' });
  });

  it('falls back like an account profile without a public origin', async () => {
    const ctx = await context([{ row: shopNote(uuid(1), { hasPhoto: true }), photos: [PNG] }]);
    const env = { NOSTR_PUBLISH: '1', NOSTR_RELAY_SPACE: 'wss://relay.nostr.space' };
    await tick(ctx, env);
    const identity = (await ctx.shops.getByMessageId(uuid(1)))!;
    const body = content(shopEvents(ctx, identity, 0)[0]);
    expect(body).toMatchObject({
      website: `https://21.gifts/${shopNpub(identity)}`,
      picture: KIND0_PICTURE_URL,
      banner: KIND0_BANNER_URL,
    });
    expect(body['nip05']).toBeUndefined();
  });

  it('links a dev shop to its own site and uses the banner fallback for one photo', async () => {
    const ctx = await context([{ row: shopNote(uuid(1), { hasPhoto: true }), photos: [PNG] }]);
    await tick(ctx, { ...ENV, PUBLIC_BASE_URL: 'https://dev.21.gifts/' });
    const identity = (await ctx.shops.getByMessageId(uuid(1)))!;
    expect(content(shopEvents(ctx, identity, 0)[0])).toMatchObject({
      website: `https://dev.21.gifts/${shopNpub(identity)}`,
      picture: `https://dev-api.21.gifts/messages/${uuid(1)}/photo.png`,
      banner: KIND0_BANNER_URL,
      nip05: 'coffee-lab@dev.21.gifts',
    });
  });

  it('omits lud16 when the till account has no kind 0 address', async () => {
    for (const till of [
      account({ lightningAddress: null }),
      account({ lightningAddress: ' ' }),
      account({ name: null }),
      null,
    ]) {
      const ctx = await context([{ row: shopNote(uuid(1)) }], till);
      await tick(ctx);
      const identity = (await ctx.shops.getByMessageId(uuid(1)))!;
      expect(content(shopEvents(ctx, identity, 0)[0])['lud16']).toBeUndefined();
    }
  });

  it('matches the nostr.json entry when a nameless account holds the slug', async () => {
    const ctx = await context([{ row: shopNote(uuid(1)) }]);
    await ctx.auth.createAccount(
      account({
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        name: null,
        username: 'coffee-lab',
        lightningAddress: null,
        viewKey: '22'.repeat(32),
        createdAt: 2,
      }),
    );
    await tick(ctx);
    const identity = (await ctx.shops.getByMessageId(uuid(1)))!;
    const nip05 = String(content(shopEvents(ctx, identity, 0)[0])['nip05']);
    const json = await buildNostrJson(ctx.auth, ENV, undefined, {
      identities: ctx.shops,
      messages: ctx.messages,
    });
    const local = nip05.split('@')[0]!;
    expect(local).toBe(`coffee-lab-${uuid(1).replace(/-/g, '').slice(0, 8)}`);
    expect(json.names[local]).toBe(identity.nostrPubkey);
    expect(json.names['coffee-lab']).not.toBe(identity.nostrPubkey);
  });

  it('clears the cache on a nack and retries on the next tick', async () => {
    const ctx = await context([{ row: shopNote(uuid(1)) }]);
    ctx.publisher.ok = false;
    await tick(ctx);
    const identity = (await ctx.shops.getByMessageId(uuid(1)))!;
    expect(logged('nostr.profile.nack')).toContainEqual(
      expect.objectContaining({ messageId: uuid(1) }),
    );
    expect(logged('nostr.relays.nack')).toContainEqual(
      expect.objectContaining({ messageId: uuid(1) }),
    );
    ctx.publisher.ok = true;
    await tick(ctx);
    expect(shopEvents(ctx, identity, 0)).toHaveLength(2);
    expect(shopEvents(ctx, identity, 10002)).toHaveLength(2);
  });

  it('requires the public ack and copies to the indexer when public publishing is on', async () => {
    const ctx = await context([{ row: shopNote(uuid(1)) }]);
    const publisher = ctx.publisher;
    let publicOk = false;
    publisher.publish = (event, urls) => {
      publisher.calls.push({ event, urls: [...urls] });
      return Promise.resolve(
        urls.map((url) => ({
          url,
          ok: url === 'wss://relay.damus.io' ? publicOk : url !== 'wss://purplepag.es',
        })),
      );
    };
    await tick(ctx, PUBLIC_ENV);
    expect(logged('nostr.profile.nack')).toContainEqual(
      expect.objectContaining({ messageId: uuid(1) }),
    );
    publicOk = true;
    await tick(ctx, PUBLIC_ENV);
    expect(logged('nostr.profile.indexer_nack')).toContainEqual({
      ts: expect.any(String),
      event: 'nostr.profile.indexer_nack',
      messageId: uuid(1),
    });
    expect(logged('nostr.relays.indexer_nack')).toContainEqual(
      expect.objectContaining({ messageId: uuid(1) }),
    );
    const identity = (await ctx.shops.getByMessageId(uuid(1)))!;
    expect(
      publisher.calls.some(
        (call) =>
          call.event['pubkey'] === identity.nostrPubkey && call.urls[0] === 'wss://purplepag.es',
      ),
    ).toBe(true);
  });

  it('logs a nack when signing fails', async () => {
    const ctx = await context([{ row: shopNote(uuid(1)) }]);
    await ctx.shops.ensureListed(uuid(1), KEK);
    const broken = override<ShopIdentityStore>(ctx.shops, {
      getNostrCiphertext: () => Promise.resolve(undefined),
    });
    await tick(ctx, ENV, { shopIdentities: broken });
    expect(logged('nostr.profile.nack')).toContainEqual(
      expect.objectContaining({ messageId: uuid(1) }),
    );
    expect(logged('nostr.relays.nack')).toContainEqual(
      expect.objectContaining({ messageId: uuid(1) }),
    );
  });

  it('publishes a new relay list when the write relays change', async () => {
    const ctx = await context([{ row: shopNote(uuid(1)) }]);
    await tick(ctx);
    const identity = (await ctx.shops.getByMessageId(uuid(1)))!;
    const first = shopEvents(ctx, identity, 10002);
    await tick(ctx, PUBLIC_ENV);
    const both = shopEvents(ctx, identity, 10002);
    expect(first).toHaveLength(1);
    expect(both).toHaveLength(2);
    expect(both[1]!.created_at).toBeGreaterThan(both[0]!.created_at);
    expect(both[1]!.tags).toEqual([
      ['r', 'wss://relay.nostr.space'],
      ['r', 'wss://relay.damus.io'],
    ]);
  });

  it('attempts at most 20 shops per tick', async () => {
    const notes = Array.from({ length: 21 }, (_, index) => ({ row: shopNote(uuid(index + 1)) }));
    const ctx = await context(notes);
    for (const { row } of notes) await ctx.shops.ensureListed(row.id, KEK);
    const keys = new Set((await ctx.shops.listAll()).map((row) => row.nostrPubkey));
    const count = (kind: number): number =>
      ctx.publisher.calls.filter(
        (call) =>
          call.event['kind'] === kind &&
          keys.has(String(call.event['pubkey'])) &&
          call.urls.includes('wss://relay.nostr.space'),
      ).length;
    await tick(ctx);
    expect(count(0)).toBe(20);
    expect(count(10002)).toBe(20);
    await tick(ctx);
    expect(count(0)).toBe(21);
    expect(count(10002)).toBe(21);
  });
});
