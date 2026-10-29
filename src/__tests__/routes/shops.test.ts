import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { nip19 } from 'nostr-tools';
import { countingBytes } from '@/__tests__/helpers/counting-bytes';
import { InMemoryAuthStore, type Account, type AuthStore } from '@/lib/auth/store';
import { unsignedNostrDefaults, type ForumPhoto, type MessageRow } from '@/lib/message';
import { InMemoryMessageStore, type MessageStore } from '@/lib/message-store';
import { InMemoryShopIdentityStore, shopNpub, type ShopIdentityStore } from '@/lib/shop-identity';
import { NIP05_DIRECTORY_REFRESH_MS, NIP05_DIRECTORY_TTL_MS } from '@/lib/nip05';
import { shopRoutes } from '@/routes/shops';
import { LNURL_SERVER, WALLET_PUBKEY } from '@/__tests__/helpers/wallet-lnurl';
import { wellKnownRoutes } from '@/routes/well-known';

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
    walletRequired: true,
    sparkPubkey: WALLET_PUBKEY,
    sparkPubkeyVerifiedAt: 1,
    forumLawsDismissed: false,
    location: null,
    viewKey: '11'.repeat(32),
    createdAt: 1,
    rulesAgreedAt: null,
    ...overrides,
  } as Account;
}

/**
 * Store the till account; a wallet key in the fixture is claimed and, with
 * `sparkPubkeyVerifiedAt`, verified as the app does (`createAccount` keeps no wallet).
 */
async function addTill(auth: InMemoryAuthStore, till: Account): Promise<void> {
  const { sparkPubkey, sparkPubkeyVerifiedAt, ...rest } = till;
  await auth.createAccount(rest);
  if (typeof sparkPubkey !== 'string') return;
  await auth.claimSparkPubkey(till.id, sparkPubkey);
  if (typeof sparkPubkeyVerifiedAt === 'number') {
    await auth.markSparkPubkeyVerified(
      till.id,
      sparkPubkey,
      till.username ?? '',
      sparkPubkeyVerifiedAt,
    );
  }
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
    /** LNURL server for the till's receiving check; `null` leaves it off. Default {@link LNURL_SERVER}. */
    lnurlServer?: typeof LNURL_SERVER | null;
    photos?: ForumPhoto[];
    row?: Partial<MessageRow>;
    now?: () => number;
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
  if (options.till !== null) await addTill(auth, options.till ?? account());
  const identities = new InMemoryShopIdentityStore(messages);
  const identity = (await identities.ensureListed(ID, KEK, {
    generateSecretKey: () => SECRET.slice(),
  }))!;
  const app = new Hono().route(
    '/shops',
    shopRoutes({
      authStore: auth,
      messages,
      identities,
      env: options.env ?? {},
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.lnurlServer === null ? {} : { lnurlServer: options.lnurlServer ?? LNURL_SERVER }),
    }),
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
    // Built before the identity store, so its own reads are counted too.
    const messages = countingBytes(base, reads);
    const identities = new InMemoryShopIdentityStore(messages);
    let created: string | undefined;
    for (const [n, id] of ids.entries()) {
      const identity = (await identities.ensureListed(id, KEK, {
        generateSecretKey: () => Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n + 2 : 1)),
      }))!;
      created ??= shopNpub(identity);
    }
    const auth = new InMemoryAuthStore();
    await addTill(auth, account());
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

  it('answers payUsername null without a username, a verified wallet, the LNURL server, or the account', async () => {
    for (const [till, lnurlServer] of [
      [account({ username: null }), LNURL_SERVER],
      [account({ sparkPubkeyVerifiedAt: null }), LNURL_SERVER],
      [account({ sparkPubkey: null }), LNURL_SERVER],
      [account(), null],
      [null, LNURL_SERVER],
    ] as const) {
      const { app, npub } = await setup({ till, lnurlServer });
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
   * Route over `messages` whose bulk note read (a NIP-05 directory computation) runs
   * `beforeAllocation` with the 1-based call number first and
   * `afterAllocation` with it after reading, whose photo set
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
    afterAllocation: (call: number) => Promise<void> = () => Promise.resolve(),
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
        await afterAllocation(allocations);
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

  it('refreshes the directory and re-reads the note once when the shop is renamed between the note read and the directory', async () => {
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

  it('answers 503 when the name still changes after the forced refresh and the re-read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = await setup();
    // Each directory reads one name, and the note moves on right after it.
    const { app, noteReads } = racingApp(
      ctx,
      (call) => rename(ctx, `Roastery ${String(call)}`),
      false,
      undefined,
      undefined,
      (call) => rename(ctx, `Bakery ${String(call)}`),
    );
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

  it('answers 410 when the shop is unlisted between the note read and the directory', async () => {
    const ctx = await setup();
    const { app, noteReads } = racingApp(ctx, async (call) => {
      if (call === 1) await ctx.messages.markDeleted(ID, new Date(0), 'staff');
    });
    const response = await app.request(`/shops/${ctx.npub}`);
    // The re-read sees the hidden note: 410, never a listed shop with a null NIP-05.
    expect(response.status).toBe(410);
    expect(noteReads()).toBe(2);
  });

  it('answers 503 when every directory misses a shop that its note read still lists', async () => {
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

  describe('shared NIP-05 directory', () => {
    const ENV = { PUBLIC_BASE_URL: 'https://21.gifts' };

    /** A listed shop on a clock the test moves, with counted directory reads. */
    async function counted(): Promise<{
      ctx: Awaited<ReturnType<typeof setup>>;
      clock: { now: number };
      reads: () => { accounts: number; identities: number; notes: number };
    }> {
      const clock = { now: 1_000 };
      const ctx = await setup({ env: ENV, now: () => clock.now });
      const listAccounts = vi.spyOn(ctx.auth, 'listAccounts');
      const listAll = vi.spyOn(ctx.identities, 'listAll');
      const getByIds = vi.spyOn(ctx.messages, 'getByIds');
      return {
        ctx,
        clock,
        reads: () => ({
          accounts: listAccounts.mock.calls.length,
          identities: listAll.mock.calls.length,
          notes: getByIds.mock.calls.length,
        }),
      };
    }

    it('computes the directory once for many concurrent requests inside the TTL', async () => {
      const { ctx, reads } = await counted();
      const responses = await Promise.all(
        Array.from({ length: 30 }, () => ctx.app.request(`/shops/${ctx.npub}`)),
      );
      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(((await response.json()) as { shop: { nip05: unknown } }).shop.nip05).toBe(
          'coffee-lab@21.gifts',
        );
      }
      expect(reads()).toEqual({ accounts: 1, identities: 1, notes: 1 });
    });

    it('recomputes the directory once the TTL ends', async () => {
      const { ctx, clock, reads } = await counted();
      expect((await ctx.app.request(`/shops/${ctx.npub}`)).status).toBe(200);
      clock.now += NIP05_DIRECTORY_TTL_MS - 1;
      expect((await ctx.app.request(`/shops/${ctx.npub}`)).status).toBe(200);
      expect(reads().accounts).toBe(1);
      clock.now += 1;
      expect((await ctx.app.request(`/shops/${ctx.npub}`)).status).toBe(200);
      expect(reads()).toEqual({ accounts: 2, identities: 2, notes: 2 });
    });

    it('forces at most one fresh directory per refresh gap for a renamed shop', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { ctx, clock, reads } = await counted();
      expect((await ctx.app.request(`/shops/${ctx.npub}`)).status).toBe(200);
      await ctx.messages.setPlace(ID, { ...note().place!, label: 'Roastery' });
      // A burst for the renamed shop shares one forced refresh.
      clock.now += 1;
      const burst = await Promise.all(
        Array.from({ length: 10 }, () => ctx.app.request(`/shops/${ctx.npub}`)),
      );
      for (const response of burst) {
        expect(response.status).toBe(200);
        expect(((await response.json()) as { shop: { nip05: unknown } }).shop.nip05).toBe(
          'roastery@21.gifts',
        );
      }
      expect(reads().accounts).toBe(2);
      // Renamed again inside the gap: no further computation, so the route
      // answers per its rules with 503 nip05_stale.
      await ctx.messages.setPlace(ID, { ...note().place!, label: 'Bakery' });
      clock.now += NIP05_DIRECTORY_REFRESH_MS - 1;
      for (let n = 0; n < 5; n += 1) {
        const stale = await ctx.app.request(`/shops/${ctx.npub}`);
        expect(stale.status).toBe(503);
        expect(stale.headers.get('cache-control')).toBe('no-store');
      }
      expect(reads().accounts).toBe(2);
      expect(
        warn.mock.calls.some((call) => String(call[0]).includes('"reason":"nip05_stale"')),
      ).toBe(true);
      // After the gap one request refreshes and the shop answers again.
      clock.now += 1;
      const fresh = await ctx.app.request(`/shops/${ctx.npub}`);
      expect(fresh.status).toBe(200);
      expect(((await fresh.json()) as { shop: { nip05: unknown } }).shop.nip05).toBe(
        'bakery@21.gifts',
      );
      expect(reads()).toEqual({ accounts: 3, identities: 3, notes: 3 });
      warn.mockRestore();
    });

    it('answers the same NIP-05 name as nostr.json from one shared directory', async () => {
      const { ctx, clock, reads } = await counted();
      const app = new Hono().route('/shops', ctx.app).route(
        '/.well-known',
        wellKnownRoutes({
          auth: ctx.auth,
          env: ENV,
          now: () => clock.now,
          shops: { identities: ctx.identities, messages: ctx.messages },
        }),
      );
      const json = (await (await app.request('/.well-known/nostr.json')).json()) as {
        names: Record<string, string>;
      };
      const shop = (await (await app.request(`/shops/shops/${ctx.npub}`)).json()) as {
        shop: { nip05: string };
      };
      const local = shop.shop.nip05.split('@')[0]!;
      expect(json.names).toEqual({ [local]: ctx.hex });
      expect(reads().accounts).toBe(1);
    });
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

describe('GET /shops', () => {
  const PLACE = {
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
  };

  function directoryId(n: number): string {
    return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  }

  function token(value: unknown): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  }

  function routes(identities: ShopIdentityStore): Hono {
    return new Hono().route(
      '/shops',
      shopRoutes({
        authStore: new InMemoryAuthStore(),
        messages: new InMemoryMessageStore(),
        identities,
      }),
    );
  }

  async function directoryOf(
    specs: ReadonlyArray<{ id: string; createdAt: Date; key: number | null; label?: string }>,
  ): Promise<{ app: Hono; messages: InMemoryMessageStore }> {
    const messages = new InMemoryMessageStore();
    const identities = new InMemoryShopIdentityStore(messages);
    for (const spec of specs) {
      await messages.create(
        note({
          id: spec.id,
          createdAt: spec.createdAt,
          place: PLACE,
        }),
      );
      if (spec.key !== null) {
        const key = spec.key;
        await identities.ensureListed(spec.id, KEK, {
          generateSecretKey: () =>
            Uint8Array.from({ length: 32 }, (_, index) => (index === 31 ? key : 1)),
        });
      }
      if (spec.label === '') {
        expect(await messages.setPlace(spec.id, { ...PLACE, label: '' })).toBe(true);
      }
    }
    const app = new Hono().route(
      '/shops',
      shopRoutes({
        authStore: new InMemoryAuthStore(),
        messages,
        identities,
        env: {},
      }),
    );
    return { app, messages };
  }

  it('returns the keyed shop, ignores a bearer, and leaves GET /shops/:npub unchanged', async () => {
    const { app, npub } = await setup();
    const response = await app.request('/shops', { headers: { authorization: 'Bearer nope' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    const body = (await response.json()) as { shops: unknown[]; nextCursor?: string };
    expect(body).toEqual({ shops: [{ npub, name: 'Coffee Lab', place: PLACE }] });
    expect(body.nextCursor).toBeUndefined();
    const redacted = JSON.stringify(body).replace(/npub1[0-9a-z]+/g, '');
    expect(redacted).not.toContain('nsec');
    expect(redacted).not.toContain(TILL);
    expect(redacted).not.toContain('ciphertext');
    expect(redacted).not.toContain('Fresh coffee');
    const detail = await app.request(`/shops/${npub}`);
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { shop: { name: string; npub: string } }).shop).toMatchObject({
      name: 'Coffee Lab',
      npub,
    });
  });

  it('uses 20 when limit is omitted, accepts 100, and rejects a bad limit before the cursor', async () => {
    const seen: number[] = [];
    const identities = {
      listDirectory: (_cursor: unknown, limit: number) => {
        seen.push(limit);
        return Promise.resolve({ shops: [], next: null });
      },
    } as unknown as ShopIdentityStore;
    const app = routes(identities);
    expect(await (await app.request('/shops')).json()).toEqual({ shops: [] });
    expect(seen).toEqual([20]);
    expect((await app.request('/shops?limit=100')).status).toBe(200);
    expect(seen).toEqual([20, 100]);
    const down = routes({
      listDirectory: () => Promise.reject(new Error('down')),
    } as unknown as ShopIdentityStore);
    for (const limit of [
      '0',
      '101',
      '20.0',
      '+20',
      '020',
      '',
      ' 20',
      '1e1',
      '20\n',
      '20\r',
      '100\u2028',
    ]) {
      const response = await down.request(`/shops?limit=${encodeURIComponent(limit)}&cursor=%%%`);
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('public, max-age=60');
      expect(await response.json()).toEqual({ error: 'Invalid limit' });
    }
  });

  it('rejects a bad cursor without reading the store', async () => {
    const down = routes({
      listDirectory: () => Promise.reject(new Error('down')),
    } as unknown as ShopIdentityStore);
    const iso = '2026-10-01T00:00:00.000Z';
    const cursors = [
      '',
      'A',
      'bad+cursor',
      token(null),
      token(1),
      token([]),
      token({ c: iso }),
      token({ c: iso, i: ID, extra: true }),
      token({ i: ID, x: iso }),
      token({ c: iso, x: ID }),
      token({ c: 1, i: ID }),
      token({ c: iso, i: 1 }),
      token({ c: 'not-a-date', i: ID }),
      token({ c: '2026-10-01T00:00:00Z', i: ID }),
      token({ c: iso, i: 'not-a-uuid' }),
      Buffer.from('{', 'utf8').toString('base64url'),
      token({ c: iso, i: ID + '\n' }),
      token({ c: iso, i: ID + '\r' }),
      token({ c: iso, i: ID + '\u2028' }),
    ];
    for (const cursor of cursors) {
      const response = await down.request(`/shops?cursor=${encodeURIComponent(cursor)}`);
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('public, max-age=60');
      expect(await response.json()).toEqual({ error: 'Invalid cursor' });
    }
  });

  it('includes nextCursor when the page stops early and the next call can be empty', async () => {
    const newer = new Date('2026-10-02T00:00:00.000Z');
    const older = new Date('2026-10-01T00:00:00.000Z');
    const { app } = await directoryOf([
      { id: directoryId(2), createdAt: newer, key: 2 },
      { id: directoryId(1), createdAt: older, key: null },
    ]);
    const first = await app.request('/shops?limit=1');
    expect(first.status).toBe(200);
    const body = (await first.json()) as {
      shops: Array<{ npub: string; name: string }>;
      nextCursor?: string;
    };
    expect(body.shops).toHaveLength(1);
    expect(body.shops[0]?.name).toBe('Coffee Lab');
    expect(typeof body.nextCursor).toBe('string');
    const upper = token({
      c: newer.toISOString(),
      i: directoryId(2).toUpperCase(),
    });
    const second = await app.request(`/shops?limit=1&cursor=${encodeURIComponent(upper)}`);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ shops: [] });
  });

  it('returns the keyed shop after more than 20 unkeyed shops', async () => {
    const good = directoryId(1);
    const specs = [
      { id: good, createdAt: new Date('2026-10-01T00:00:00.000Z'), key: 1, label: 'Coffee Lab' },
      ...Array.from({ length: 21 }, (_, index) => ({
        id: directoryId(index + 2),
        createdAt: new Date(Date.UTC(2026, 9, 2, 0, index)),
        key: null,
      })),
    ];
    const { app } = await directoryOf(specs);
    const first = await app.request('/shops?limit=1');
    const firstBody = (await first.json()) as { shops: unknown[]; nextCursor?: string };
    expect(firstBody.shops).toEqual([]);
    expect(typeof firstBody.nextCursor).toBe('string');
    const second = await app.request(
      `/shops?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor ?? '')}`,
    );
    const secondBody = (await second.json()) as { shops: Array<{ name: string }> };
    expect(secondBody.shops.map((shop) => shop.name)).toEqual(['Coffee Lab']);
  });

  it('answers 503 with no-store and logs shops.list.failed when the store throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = routes({
      listDirectory: () => Promise.reject(new Error('down')),
    } as unknown as ShopIdentityStore);
    const response = await app.request('/shops');
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'Shops are unavailable' });
    expect(warn.mock.calls.some((call) => String(call[0]).includes('shops.list.failed'))).toBe(
      true,
    );
    expect(warn.mock.calls.some((call) => String(call[0]).includes('down'))).toBe(false);
    warn.mockRestore();
  });
});
