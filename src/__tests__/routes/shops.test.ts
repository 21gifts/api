import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { nip19 } from 'nostr-tools';
import { InMemoryAuthStore, type Account, type AuthStore } from '@/lib/auth/store';
import { unsignedNostrDefaults, type ForumPhoto, type MessageRow } from '@/lib/message';
import { InMemoryMessageStore, type MessageStore } from '@/lib/message-store';
import { InMemoryShopIdentityStore, shopNpub, type ShopIdentityStore } from '@/lib/shop-identity';
import { shopRoutes } from '@/routes/shops';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TILL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEK = new Uint8Array(32).fill(7);
const SECRET = Uint8Array.from({ length: 32 }, (_, index) => (index === 31 ? 2 : 1));

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

function note(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: ID,
    accountId: 'author',
    name: 'Ada',
    text: 'Fresh coffee roasted here every morning. #21GiftsShop',
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

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

async function setup(
  options: {
    env?: Record<string, string | undefined>;
    till?: Account | null;
    photos?: ForumPhoto[];
    row?: Partial<MessageRow>;
  } = {},
): Promise<{
  app: Hono;
  messages: InMemoryMessageStore;
  auth: InMemoryAuthStore;
  identities: InMemoryShopIdentityStore;
  npub: string;
  hex: string;
}> {
  const messages = new InMemoryMessageStore();
  const photos = options.photos ?? [];
  await messages.create(note(options.row), photos[0], undefined, photos.slice(1));
  const auth = new InMemoryAuthStore();
  if (options.till !== null) await auth.createAccount(options.till ?? account());
  const identities = new InMemoryShopIdentityStore(messages);
  const identity = (await identities.ensureListed(ID, KEK, {
    generateSecretKey: () => SECRET.slice(),
  }))!;
  const app = new Hono().route(
    '/shops',
    shopRoutes({ authStore: auth, messages, identities, env: options.env ?? {} }),
  );
  return { app, messages, auth, identities, npub: shopNpub(identity), hex: identity.nostrPubkey };
}

describe('GET /shops/:npub', () => {
  it('returns a listed shop with photos, pay username and NIP-05', async () => {
    const { app, npub } = await setup({
      env: { PUBLIC_BASE_URL: 'https://21.gifts' },
      photos: [
        { contentType: 'image/png', bytes: png(320, 200) },
        { contentType: 'image/webp', bytes: new Uint8Array([1, 2, 3]) },
      ],
    });
    const response = await app.request(`/shops/${npub}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    expect(await response.json()).toEqual({
      shop: {
        npub,
        messageId: ID,
        name: 'Coffee Lab',
        description: 'Fresh coffee roasted here every morning.',
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
        photos: [
          { url: `https://api.21.gifts/messages/${ID}/photo.png`, width: 320, height: 200 },
          { url: `https://api.21.gifts/messages/${ID}/photo/1.webp`, width: null, height: null },
        ],
        payUsername: 'coffee',
        nip05: 'coffee-lab@21.gifts',
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    });
  });

  it('reads the photo bytes of the requested shop only, with several shops', async () => {
    const base = new InMemoryMessageStore();
    const ids = [
      ID,
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    ];
    const photo: ForumPhoto = { contentType: 'image/png', bytes: png(320, 200) };
    const extra: ForumPhoto = { contentType: 'image/webp', bytes: new Uint8Array([1, 2, 3]) };
    for (const [n, id] of ids.entries()) {
      const label = `Coffee Lab ${String(n)}`;
      await base.create(
        note({ id, accountId: `author-${String(n)}`, place: { ...note().place!, label } }),
        photo,
        undefined,
        [extra],
      );
    }
    const reads: string[] = [];
    const byteReads = new Set<PropertyKey>([
      'getPhoto',
      'getExtraPhoto',
      'listExtraPhotos',
      'getPhotoSet',
    ]);
    // Built before the identity store, so its own reads are counted too.
    const messages = new Proxy(base, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        const bound = (value as (...args: unknown[]) => unknown).bind(target);
        if (!byteReads.has(key)) return bound;
        return (id: string, ...rest: unknown[]) => {
          reads.push(`${String(key)}:${id}`);
          return bound(id, ...rest);
        };
      },
    });
    const identities = new InMemoryShopIdentityStore(messages);
    let created: string | undefined;
    for (const [n, id] of ids.entries()) {
      const identity = (await identities.ensureListed(id, KEK, {
        generateSecretKey: () => Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n + 2 : 1)),
      }))!;
      created ??= shopNpub(identity);
    }
    const auth = new InMemoryAuthStore();
    await auth.createAccount(account());
    const app = new Hono().route(
      '/shops',
      shopRoutes({
        authStore: auth,
        messages,
        identities,
        env: { PUBLIC_BASE_URL: 'https://21.gifts' },
      }),
    );
    reads.length = 0;
    const response = await app.request(`/shops/${created!}`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { shop: { nip05: string } }).shop.nip05).toBe(
      'coffee-lab-0@21.gifts',
    );
    expect(reads).toEqual([`getPhotoSet:${ID}`]);
  });

  it('uses bare photo paths and a null NIP-05 without a public origin', async () => {
    const { app, npub } = await setup({
      photos: [{ contentType: 'image/png', bytes: png(1, 2) }],
    });
    const body = (await (await app.request(`/shops/${npub}`)).json()) as {
      shop: { photos: unknown[]; nip05: unknown };
    };
    expect(body.shop.photos).toEqual([{ url: `/messages/${ID}/photo.png`, width: 1, height: 2 }]);
    expect(body.shop.nip05).toBeNull();
  });

  it.each([0, 1, 2])(
    'builds each photo URL from its stored index when the still at index %i has an unrecognized type',
    async (bad) => {
      const stills: ForumPhoto[] = [
        { contentType: 'image/png', bytes: png(10, 1) },
        { contentType: 'image/png', bytes: png(11, 1) },
        { contentType: 'image/png', bytes: png(12, 1) },
        { contentType: 'image/png', bytes: png(13, 1) },
      ];
      stills[bad] = { contentType: 'image/gif', bytes: png(99, 1) } as unknown as ForumPhoto;
      const { app, npub } = await setup({ photos: stills });
      const body = (await (await app.request(`/shops/${npub}`)).json()) as {
        shop: { photos: unknown[] };
      };
      // Only the left-out still is missing; the others keep their own URL,
      // and an unrecognized photo 0 does not drop the extras.
      expect(body.shop.photos).toEqual(
        [0, 1, 2, 3]
          .filter((index) => index !== bad)
          .map((index) => ({
            url:
              index === 0
                ? `/messages/${ID}/photo.png`
                : `/messages/${ID}/photo/${String(index)}.png`,
            width: 10 + index,
            height: 1,
          })),
      );
    },
  );

  it('answers payUsername null without a username, a Lightning address, or the account', async () => {
    for (const till of [
      account({ username: null }),
      account({ lightningAddress: null }),
      account({ lightningAddress: '  ' }),
      null,
    ]) {
      const { app, npub } = await setup({ till });
      const body = (await (await app.request(`/shops/${npub}`)).json()) as {
        shop: { payUsername: unknown; photos: unknown[] };
      };
      expect(body.shop.payUsername).toBeNull();
      expect(body.shop.photos).toEqual([]);
    }
  });

  it('serves a shop whose till account has no username, with payUsername null', async () => {
    const { app, npub } = await setup({
      till: account({ username: null }),
      row: { shopAccount: { id: TILL, username: null, name: 'Coffee' } },
    });
    const response = await app.request(`/shops/${npub}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { shop: { name: unknown; payUsername: unknown } };
    expect(body.shop).toMatchObject({ name: 'Coffee Lab', payUsername: null });
  });

  it('redirects the hex key of a known shop to its npub', async () => {
    const { app, npub, hex } = await setup();
    const response = await app.request(`/shops/${hex}`);
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe(`/shops/${npub}`);
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('answers 410 without a name for a shop that is no longer listed', async () => {
    const { app, messages, npub, hex } = await setup();
    await messages.markDeleted(ID, new Date(0), 'staff');
    const response = await app.request(`/shops/${npub}`);
    expect(response.status).toBe(410);
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    expect(await response.json()).toEqual({ error: 'Shop is no longer listed', npub });
    expect((await app.request(`/shops/${hex}`)).status).toBe(301);
  });

  it('answers 410 when the note is gone', async () => {
    const { identities, npub } = await setup();
    const messages = { getById: () => Promise.resolve(undefined) } as unknown as MessageStore;
    const app = new Hono().route(
      '/shops',
      shopRoutes({ authStore: new InMemoryAuthStore(), messages, identities, env: {} }),
    );
    expect((await app.request(`/shops/${npub}`)).status).toBe(410);
  });

  /**
   * Route over `messages` whose bulk note read (the NIP-05 allocation) runs
   * `beforeAllocation` with the 1-based call number first, whose photo set
   * read runs `afterPhotoRead` with its 1-based call number after reading,
   * and counts the route's note reads. `noteGoneFrom` makes every note read
   * from that 1-based number on answer `undefined`.
   */
  function racingApp(
    ctx: Awaited<ReturnType<typeof setup>>,
    beforeAllocation: (call: number) => Promise<void>,
    hideInAllocation = false,
    afterPhotoRead: (call: number) => Promise<void> = () => Promise.resolve(),
    noteGoneFrom = Number.POSITIVE_INFINITY,
  ): { app: Hono; noteReads: () => number } {
    let allocations = 0;
    let photoReads = 0;
    let noteReads = 0;
    const racing = {
      getById: (id: string) => {
        noteReads += 1;
        return noteReads >= noteGoneFrom ? Promise.resolve(undefined) : ctx.messages.getById(id);
      },
      getByIds: async (ids: readonly string[]) => {
        allocations += 1;
        await beforeAllocation(allocations);
        const rows = await ctx.messages.getByIds(ids);
        return hideInAllocation ? rows.map((row) => ({ ...row, deletedAt: new Date(0) })) : rows;
      },
      getPhotoSet: async (id: string) => {
        photoReads += 1;
        const set = await ctx.messages.getPhotoSet(id);
        await afterPhotoRead(photoReads);
        return set;
      },
    } as unknown as MessageStore;
    const app = new Hono().route(
      '/shops',
      shopRoutes({
        authStore: ctx.auth,
        messages: racing,
        identities: ctx.identities,
        env: { PUBLIC_BASE_URL: 'https://21.gifts' },
      }),
    );
    return { app, noteReads: () => noteReads };
  }

  async function rename(ctx: Awaited<ReturnType<typeof setup>>, label: string): Promise<void> {
    await ctx.messages.setPlace(ID, { ...note().place!, label });
  }

  it('re-reads the note once when the shop is renamed between the note read and the NIP-05 allocation', async () => {
    const ctx = await setup();
    const { app, noteReads } = racingApp(ctx, async (call) => {
      if (call === 1) await rename(ctx, 'Roastery');
    });
    const response = await app.request(`/shops/${ctx.npub}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      shop: { name: unknown; nip05: unknown; place: { label: unknown } };
    };
    // Never the old name with the new name's local part.
    expect(body.shop).toMatchObject({
      name: 'Roastery',
      nip05: 'roastery@21.gifts',
      place: { label: 'Roastery' },
    });
    // First read, the re-read after the allocation, the re-read after the photos.
    expect(noteReads()).toBe(3);
  });

  it('answers 503 when the name still changes between the re-read and the allocation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = await setup();
    const { app, noteReads } = racingApp(ctx, (call) => rename(ctx, `Roastery ${String(call)}`));
    const response = await app.request(`/shops/${ctx.npub}`);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'Shops are unavailable' });
    expect(noteReads()).toBe(2);
    expect(
      warn.mock.calls.some(
        (call) =>
          String(call[0]).includes('"event":"shops.detail.failed"') &&
          String(call[0]).includes('"reason":"nip05_stale"'),
      ),
    ).toBe(true);
    warn.mockRestore();
  });

  it('answers 410 when the shop is unlisted between the note read and the NIP-05 allocation', async () => {
    const ctx = await setup();
    const { app, noteReads } = racingApp(ctx, async (call) => {
      if (call === 1) await ctx.messages.markDeleted(ID, new Date(0), 'staff');
    });
    const response = await app.request(`/shops/${ctx.npub}`);
    // The re-read sees the hidden note: 410, never a listed shop with a null NIP-05.
    expect(response.status).toBe(410);
    expect(noteReads()).toBe(2);
  });

  it('answers 503 when every allocation misses a shop that its note read still lists', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = await setup();
    const { app, noteReads } = racingApp(ctx, () => Promise.resolve(), true);
    const response = await app.request(`/shops/${ctx.npub}`);
    expect(response.status).toBe(503);
    expect(noteReads()).toBe(2);
    warn.mockRestore();
  });

  const AFTER = [
    { contentType: 'image/png' as const, bytes: png(640, 480) },
    { contentType: 'image/png' as const, bytes: png(30, 40) },
  ];

  it('goes round once more when the shop is renamed and its photos replaced inside the photo read', async () => {
    const ctx = await setup({ photos: [{ contentType: 'image/png', bytes: png(320, 200) }] });
    const { app, noteReads } = racingApp(
      ctx,
      () => Promise.resolve(),
      false,
      async (call) => {
        if (call !== 1) return;
        // The old set is already read; the note changes before the re-read.
        await ctx.messages.replacePhotos(ID, AFTER);
        await rename(ctx, 'Roastery');
      },
    );
    const response = await app.request(`/shops/${ctx.npub}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      shop: { name: unknown; nip05: unknown; photos: Array<{ width: unknown; height: unknown }> };
    };
    // Never the old name with either set: the new name with the new photos.
    expect(body.shop).toMatchObject({ name: 'Roastery', nip05: 'roastery@21.gifts' });
    expect(body.shop.photos.map((photo) => [photo.width, photo.height])).toEqual([
      [640, 480],
      [30, 40],
    ]);
    expect(noteReads()).toBe(3);
  });

  it('serves the changed description after one more round when only the text changes inside the photo read', async () => {
    const ctx = await setup();
    const { app, noteReads } = racingApp(
      ctx,
      () => Promise.resolve(),
      false,
      async (call) => {
        if (call === 1) {
          await ctx.messages.updateText(ID, 'Fresh beans roasted here at noon. #21GiftsShop');
        }
      },
    );
    const response = await app.request(`/shops/${ctx.npub}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { shop: { description: unknown } };
    expect(body.shop.description).toBe('Fresh beans roasted here at noon.');
    expect(noteReads()).toBe(3);
  });

  it('serves a photo-only change inside the photo read without another round', async () => {
    const ctx = await setup({ photos: [{ contentType: 'image/png', bytes: png(320, 200) }] });
    const { app, noteReads } = racingApp(
      ctx,
      () => Promise.resolve(),
      false,
      async (call) => {
        if (call === 1) await ctx.messages.replacePhotos(ID, AFTER);
      },
    );
    const response = await app.request(`/shops/${ctx.npub}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      shop: { name: unknown; photos: Array<{ width: unknown }> };
    };
    // The note did not change, so the old set with this note did exist.
    expect(body.shop.name).toBe('Coffee Lab');
    expect(body.shop.photos.map((photo) => photo.width)).toEqual([320]);
    expect(noteReads()).toBe(2);
  });

  it('answers 503 note_changed when the note still changes inside the last photo read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = await setup();
    const { app, noteReads } = racingApp(
      ctx,
      () => Promise.resolve(),
      false,
      (call) => rename(ctx, `Roastery ${String(call)}`),
    );
    const response = await app.request(`/shops/${ctx.npub}`);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'Shops are unavailable' });
    // The bound: three note reads over two rounds.
    expect(noteReads()).toBe(3);
    expect(
      warn.mock.calls.some(
        (call) =>
          String(call[0]).includes('"event":"shops.detail.failed"') &&
          String(call[0]).includes('"reason":"note_changed"'),
      ),
    ).toBe(true);
    warn.mockRestore();
  });

  it('answers 410 when the note is gone after the photo read', async () => {
    const ctx = await setup();
    const { app, noteReads } = racingApp(ctx, () => Promise.resolve(), false, undefined, 2);
    const response = await app.request(`/shops/${ctx.npub}`);
    expect(response.status).toBe(410);
    expect(noteReads()).toBe(2);
  });

  it('serves one whole photo set when the photos are swapped between the former two reads', async () => {
    const before = [
      { contentType: 'image/png' as const, bytes: png(320, 200) },
      { contentType: 'image/png' as const, bytes: png(10, 20) },
    ];
    const after = [
      { contentType: 'image/png' as const, bytes: png(640, 480) },
      { contentType: 'image/png' as const, bytes: png(30, 40) },
      { contentType: 'image/png' as const, bytes: png(50, 60) },
    ];
    const ctx = await setup({ photos: before });
    // Photo 0 and the extras used to be two reads; a swap after the first
    // gave photo 0 of one set and the extras of the other.
    const swapping = {
      getById: (id: string) => ctx.messages.getById(id),
      getPhoto: async (id: string) => {
        const first = await ctx.messages.getPhoto(id);
        await ctx.messages.replacePhotos(id, after);
        return first;
      },
      listExtraPhotos: (id: string) => ctx.messages.listExtraPhotos(id),
      getPhotoSet: async (id: string) => {
        const set = await ctx.messages.getPhotoSet(id);
        await ctx.messages.replacePhotos(id, after);
        return set;
      },
    } as unknown as MessageStore;
    const app = new Hono().route(
      '/shops',
      shopRoutes({ authStore: ctx.auth, messages: swapping, identities: ctx.identities, env: {} }),
    );
    const body = (await (await app.request(`/shops/${ctx.npub}`)).json()) as {
      shop: { photos: Array<{ width: unknown; height: unknown }> };
    };
    expect(body.shop.photos.map((photo) => [photo.width, photo.height])).toEqual([
      [320, 200],
      [10, 20],
    ]);
  });

  it('answers 404 for every other segment', async () => {
    const { app, npub } = await setup();
    const unknownHex = '11'.repeat(32);
    const badChecksum = `${npub.slice(0, -1)}${npub.endsWith('q') ? 'p' : 'q'}`;
    for (const segment of [
      'nobody',
      npub.toUpperCase(),
      unknownHex.toUpperCase(),
      badChecksum,
      nip19.npubEncode(unknownHex),
      unknownHex,
      `${'11'.repeat(31)}1`,
    ]) {
      const response = await app.request(`/shops/${segment}`);
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('public, max-age=60');
      expect(await response.json()).toEqual({ error: 'Not found' });
    }
  });

  it('answers 503 with no-store and logs on a store failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const identities = {
      getByPubkey: () => Promise.reject(new Error('down')),
    } as unknown as ShopIdentityStore;
    const app = new Hono().route(
      '/shops',
      shopRoutes({
        authStore: {} as AuthStore,
        messages: new InMemoryMessageStore(),
        identities,
      }),
    );
    const response = await app.request(`/shops/${'11'.repeat(32)}`);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'Shops are unavailable' });
    expect(warn.mock.calls.some((call) => String(call[0]).includes('shops.detail.failed'))).toBe(
      true,
    );
    warn.mockRestore();
  });
});
