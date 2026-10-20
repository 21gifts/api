import { describe, expect, it } from 'vitest';
import { nip19 } from 'nostr-tools';
import type { SqlClient } from '@/lib/auth/sql';
import { unsignedNostrDefaults, type ForumPhoto, type MessageRow } from '@/lib/message';
import { InMemoryMessageStore, type MessageStore } from '@/lib/message-store';
import { decryptNostrSecret, publicKeyHexFromSecret } from '@/lib/nostr/keys';
import {
  InMemoryShopIdentityStore,
  PostgresShopIdentityStore,
  SHOP_IDENTITY_SCHEMA_SQL,
  migrateShopIdentitySchema,
  shopNpub,
  type ShopIdentityRow,
  type ShopOcpClaim,
} from '@/lib/shop-identity';

const KEK = new Uint8Array(32).fill(7);
const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TEXT = 'Fresh coffee roasted here every morning. #21GiftsShop';

function secret(n: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => (index === 31 ? n : 1));
}

function keygenFrom(...values: number[]): { generateSecretKey: () => Uint8Array } {
  let index = 0;
  return {
    generateSecretKey: () => {
      const value = values[Math.min(index, values.length - 1)] as number;
      index += 1;
      return secret(value);
    },
  };
}

function shopRow(id: string, overrides: Partial<MessageRow> = {}): MessageRow {
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
    shopAccount: { id: 'till', username: 'coffee', name: 'Coffee' },
    ...overrides,
  };
}

const PNG: ForumPhoto = { contentType: 'image/png', bytes: new Uint8Array([1, 2, 3]) };
const JPEG: ForumPhoto = { contentType: 'image/jpeg', bytes: new Uint8Array([4, 5]) };

function setup(rows: MessageRow[] = [shopRow(ID_A)]): {
  messages: InMemoryMessageStore;
  store: InMemoryShopIdentityStore;
  clock: { now: number };
} {
  const messages = new InMemoryMessageStore(rows);
  const clock = { now: 1_000_000 };
  const store = new InMemoryShopIdentityStore(messages, () => clock.now);
  return { messages, store, clock };
}

describe('shopNpub', () => {
  it('encodes the stored hex key as npub', () => {
    const hex = publicKeyHexFromSecret(secret(2));
    expect(shopNpub({ nostrPubkey: hex })).toBe(nip19.npubEncode(hex));
  });
});

describe('migrateShopIdentitySchema', () => {
  it('runs every statement in order', async () => {
    const run: string[] = [];
    const sql = {
      query: () => Promise.resolve([]),
      execute: (text: string) => {
        run.push(text);
        return Promise.resolve();
      },
    } as unknown as SqlClient;
    await migrateShopIdentitySchema(sql);
    expect(run).toEqual([...SHOP_IDENTITY_SCHEMA_SQL]);
    expect(run[0]).toContain('CREATE TABLE IF NOT EXISTS shop_identity');
    expect(run.join('\n')).toContain('trg_shop_identity_place');
    expect(run.join('\n')).toContain('trg_shop_identity_extra_photo');
    expect(run).toContain(
      `CREATE INDEX IF NOT EXISTS shop_identity_key_order_idx
     ON shop_identity (nostr_key_created_at, message_id)`,
    );
  });

  it('drops and recreates each trigger inside one DO block', () => {
    expect(SHOP_IDENTITY_SCHEMA_SQL.some((s) => s.startsWith('DROP TRIGGER'))).toBe(false);
    expect(SHOP_IDENTITY_SCHEMA_SQL.some((s) => s.startsWith('CREATE TRIGGER'))).toBe(false);
    const blocks = SHOP_IDENTITY_SCHEMA_SQL.filter((s) => s.startsWith('DO $trigger$'));
    expect(blocks).toHaveLength(3);
    for (const [index, [name, table]] of [
      ['trg_shop_identity_place', 'message'],
      ['trg_shop_identity_cover', 'message'],
      ['trg_shop_identity_extra_photo', 'message_extra_photo'],
    ].entries()) {
      const block = blocks[index] as string;
      expect(
        block.startsWith(
          `DO $trigger$\nBEGIN\n  LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE;\n  DROP TRIGGER IF EXISTS ${name} ON ${table};\n`,
        ),
      ).toBe(true);
      expect(block).toContain(`CREATE TRIGGER ${name}`);
      expect(block.indexOf('DROP TRIGGER')).toBeLessThan(block.indexOf('CREATE TRIGGER'));
      expect(block).toMatch(/;\nEND;\n\$trigger\$$/);
    }
  });
});

describe('InMemoryShopIdentityStore key creation', () => {
  it('creates one custodial key for a listed shop and keeps it', async () => {
    const { messages, store, clock } = setup();
    const first = await store.ensureListed(ID_A, KEK, keygenFrom(2));
    expect(first).toMatchObject({
      messageId: ID_A,
      nostrPubkey: publicKeyHexFromSecret(secret(2)),
      nostrKekId: 1,
      nostrKeyCustody: 'custodial',
      profileName: 'Coffee Lab',
      ocpPlacePending: true,
      ocpPlaceGeneration: 1,
      ocpPhotosPending: false,
      ocpRevision: 0,
    });
    expect(first?.nostrKeyCreatedAt.getTime()).toBe(clock.now);
    const plain = await decryptNostrSecret(first!.nostrNsecCiphertext, KEK, `shop:${ID_A}`);
    expect([...plain]).toEqual([...secret(2)]);
    await expect(decryptNostrSecret(first!.nostrNsecCiphertext, KEK, ID_A)).rejects.toThrow();
    const again = await store.ensureListed(ID_A, KEK, keygenFrom(3));
    expect(again?.nostrPubkey).toBe(first?.nostrPubkey);
    expect((await messages.getById(ID_A))?.shopNpub).toBe(shopNpub(first!));
    expect(await store.getNostrCiphertext(ID_A)).toEqual(first?.nostrNsecCiphertext);
    expect(await store.getNostrCiphertext(ID_B)).toBeUndefined();
  });

  it('creates nothing for a note that is not listed', async () => {
    const { store } = setup([shopRow(ID_A, { text: 'No tag here, only coffee every day.' })]);
    expect(await store.ensureListed(ID_A, KEK, keygenFrom(2))).toBeUndefined();
    expect(await store.ensureListed(ID_B, KEK)).toBeUndefined();
    expect(await store.listAll()).toEqual([]);
  });

  it('keeps exactly one key for two concurrent creators', async () => {
    const { store } = setup();
    const [left, right] = await Promise.all([
      store.ensureListed(ID_A, KEK, keygenFrom(2)),
      store.ensureListed(ID_A, KEK, keygenFrom(3)),
    ]);
    expect(left?.nostrPubkey).toBe(right?.nostrPubkey);
    expect(await store.listAll()).toHaveLength(1);
  });

  it('records the note as it is after key generation', async () => {
    const { messages, store } = setup();
    const renaming = {
      generateSecretKey: () => {
        void messages.setPlace(ID_A, { ...shopRow(ID_A).place!, label: 'Roastery' });
        return secret(2);
      },
    };
    const created = await store.ensureListed(ID_A, KEK, renaming);
    expect(created?.profileName).toBe('Roastery');
    expect(await store.getByMessageId(ID_A)).toMatchObject({
      profileName: 'Roastery',
      ocpPlaceGeneration: 1,
    });
  });

  it('creates nothing when the note stops being listed during key generation', async () => {
    const { messages, store } = setup();
    const unlisting = {
      generateSecretKey: () => {
        void messages.updateText(ID_A, 'Too short #21GiftsShop');
        return secret(2);
      },
    };
    expect(await store.ensureListed(ID_A, KEK, unlisting)).toBeUndefined();
    expect(await store.listAll()).toEqual([]);
    expect((await messages.getById(ID_A))?.shopNpub ?? null).toBeNull();
  });

  it('refuses a public key that another shop already holds', async () => {
    const { store } = setup([shopRow(ID_A), shopRow(ID_B)]);
    await store.ensureListed(ID_A, KEK, keygenFrom(2));
    await expect(store.ensureListed(ID_B, KEK, keygenFrom(2))).rejects.toThrow(
      'shop nostr pubkey already exists',
    );
  });

  it('rewrites profile_name only while the shop is listed', async () => {
    const { messages, store } = setup();
    await store.ensureListed(ID_A, KEK, keygenFrom(2));
    await messages.setPlace(ID_A, { ...shopRow(ID_A).place!, label: 'Roastery' });
    expect((await store.ensureListed(ID_A, KEK))?.profileName).toBe('Roastery');
    await messages.markDeleted(ID_A, new Date(0), 'staff');
    await messages.setPlace(ID_A, { ...shopRow(ID_A).place!, label: 'Hidden Name' });
    expect((await store.ensureListed(ID_A, KEK))?.profileName).toBe('Roastery');
  });

  it('renames from a snapshot only while the note still shows it', async () => {
    const { messages, store } = setup();
    await store.ensureListed(ID_A, KEK, keygenFrom(2));
    const older = (await messages.getById(ID_A))!;
    await messages.setPlace(ID_A, { ...shopRow(ID_A).place!, label: 'Roastery' });
    const newer = (await messages.getById(ID_A))!;
    await store.renameIfListed(newer);
    expect((await store.getByMessageId(ID_A))?.profileName).toBe('Roastery');
    // A tick that read the note before the rename comes last.
    await store.renameIfListed(older);
    expect((await store.getByMessageId(ID_A))?.profileName).toBe('Roastery');
    // No key, and an unlisted snapshot: nothing to write.
    await store.renameIfListed(shopRow(ID_B, { place: { ...newer.place!, label: 'Other' } }));
    expect(await store.getByMessageId(ID_B)).toBeUndefined();
    await store.renameIfListed({
      ...newer,
      deletedAt: new Date(0),
      place: { ...newer.place!, label: 'Gone' },
    });
    expect((await store.getByMessageId(ID_A))?.profileName).toBe('Roastery');
    // The note was unlisted after the read: the old snapshot does not rename it.
    await messages.markDeleted(ID_A, new Date(0), 'staff');
    await store.renameIfListed({ ...newer, place: { ...newer.place!, label: 'Late' } });
    expect((await store.getByMessageId(ID_A))?.profileName).toBe('Roastery');
  });

  it('does not rename when the note is gone', async () => {
    const messages = new InMemoryMessageStore([shopRow(ID_A)]);
    let gone = false;
    const wrapped = {
      getById: (id: string) => (gone ? Promise.resolve(undefined) : messages.getById(id)),
      getPhoto: (id: string) => messages.getPhoto(id),
      listExtraPhotos: (id: string) => messages.listExtraPhotos(id),
    } as unknown as MessageStore;
    const store = new InMemoryShopIdentityStore(wrapped);
    await store.ensureListed(ID_A, KEK, keygenFrom(2));
    gone = true;
    await store.renameIfListed(
      shopRow(ID_A, { place: { ...shopRow(ID_A).place!, label: 'Late' } }),
    );
    expect((await store.getByMessageId(ID_A))?.profileName).toBe('Coffee Lab');
  });

  it('works with a message store that is not the in-memory class', async () => {
    const messages = new InMemoryMessageStore([shopRow(ID_A)]);
    const wrapped = {
      getById: (id: string) => messages.getById(id),
      getPhoto: (id: string) => messages.getPhoto(id),
      listExtraPhotos: (id: string) => messages.listExtraPhotos(id),
      listLiveAssignedShops: () => messages.listLiveAssignedShops(),
    } as unknown as MessageStore;
    const store = new InMemoryShopIdentityStore(wrapped);
    const created = await store.ensureListed(ID_A, KEK, keygenFrom(2));
    expect(created?.nostrKeyCreatedAt).toBeInstanceOf(Date);
    expect((await messages.getById(ID_A))?.shopNpub ?? null).toBeNull();
  });
});

describe('InMemoryShopIdentityStore reads', () => {
  it('finds by pubkey and lists by key creation then message id', async () => {
    const { store, clock } = setup([shopRow(ID_C), shopRow(ID_B), shopRow(ID_A)]);
    await store.ensureListed(ID_C, KEK, keygenFrom(4));
    clock.now += 1;
    await store.ensureListed(ID_B, KEK, keygenFrom(3));
    await store.ensureListed(ID_A, KEK, keygenFrom(2));
    expect((await store.listAll()).map((row) => row.messageId)).toEqual([ID_C, ID_A, ID_B]);
    expect((await store.getByPubkey(publicKeyHexFromSecret(secret(3))))?.messageId).toBe(ID_B);
    expect(await store.getByPubkey('00'.repeat(32))).toBeUndefined();
    expect(await store.getByMessageId('missing')).toBeUndefined();
  });

  it('lists key candidates by created_at and id after the cursor', async () => {
    const t = (iso: string): Date => new Date(iso);
    const rows = [
      shopRow(ID_C, { createdAt: t('2026-01-02T00:00:00Z') }),
      shopRow(ID_B, { createdAt: t('2026-01-01T00:00:00Z') }),
      shopRow(ID_A, { createdAt: t('2026-01-01T00:00:00Z') }),
      shopRow('dddddddd-dddd-4ddd-8ddd-dddddddddddd', { place: null }),
      shopRow('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', { text: 'No tag in this text at all here.' }),
    ];
    const { store } = setup(rows);
    const all = await store.listCandidates(null, 10);
    expect(all.map((row) => row.id)).toEqual([ID_A, ID_B, ID_C]);
    expect(
      (await store.listCandidates({ createdAt: t('2026-01-01T00:00:00Z'), id: ID_A }, 10)).map(
        (row) => row.id,
      ),
    ).toEqual([ID_B, ID_C]);
    expect(await store.listCandidates(null, 1)).toEqual([
      { id: ID_A, createdAt: t('2026-01-01T00:00:00Z') },
    ]);
    await store.ensureListed(ID_A, KEK, keygenFrom(2));
    expect((await store.listCandidates(null, 10)).map((row) => row.id)).toEqual([ID_B, ID_C]);
  });

  it('skips a candidate whose note vanished between the two reads', async () => {
    const messages = new InMemoryMessageStore([shopRow(ID_A)]);
    const wrapped = {
      listLiveAssignedShops: () => messages.listLiveAssignedShops(),
      getById: () => Promise.resolve(undefined),
    } as unknown as MessageStore;
    expect(await new InMemoryShopIdentityStore(wrapped).listCandidates(null, 10)).toEqual([]);
  });
});

describe('InMemoryShopIdentityStore listRound', () => {
  const IDS = [1, 2, 3, 4, 5].map((n) => `0000000${String(n)}-0000-4000-8000-000000000000`);

  /** Five keys in `listAll()` order: the first two share a key time. */
  async function five(): Promise<{ store: InMemoryShopIdentityStore; rows: ShopIdentityRow[] }> {
    const { store, clock } = setup(IDS.map((id) => shopRow(id)));
    await store.ensureListed(IDS[1]!, KEK, keygenFrom(11));
    await store.ensureListed(IDS[0]!, KEK, keygenFrom(10));
    for (const [index, id] of IDS.slice(2).entries()) {
      clock.now += 1;
      await store.ensureListed(id, KEK, keygenFrom(12 + index));
    }
    const rows = await store.listAll();
    expect(rows.map((row) => row.messageId)).toEqual(IDS);
    return { store, rows };
  }

  const at = (row: ShopIdentityRow | undefined): { createdAt: Date; messageId: string } => ({
    createdAt: row!.nostrKeyCreatedAt,
    messageId: row!.messageId,
  });

  const round = async (
    store: InMemoryShopIdentityStore,
    cursor: { createdAt: Date; messageId: string } | null,
    limit: number,
  ): Promise<string[]> => (await store.listRound(cursor, limit)).map((row) => row.messageId);

  it('pages after the cursor and wraps with the rows at or before it', async () => {
    const { store, rows } = await five();
    expect(await round(store, null, 2)).toEqual(IDS.slice(0, 2));
    expect(await round(store, null, 20)).toEqual(IDS);
    // Same key time: the message id breaks the tie.
    expect(await round(store, at(rows[0]), 1)).toEqual([IDS[1]]);
    expect(await round(store, at(rows[1]), 2)).toEqual(IDS.slice(2, 4));
    expect(await round(store, at(rows[3]), 3)).toEqual([IDS[4], IDS[0], IDS[1]]);
    expect(await round(store, at(rows[4]), 2)).toEqual(IDS.slice(0, 2));
    // Fewer shops than the limit: each exactly once, the cursor's shop last.
    expect(await round(store, at(rows[2]), 20)).toEqual([IDS[3], IDS[4], IDS[0], IDS[1], IDS[2]]);
  });

  it('uses the cursor as a key, also when no row has it any more', async () => {
    const { store, rows } = await five();
    const gone = { createdAt: rows[2]!.nostrKeyCreatedAt, messageId: `${IDS[2]!}x` };
    expect(await round(store, gone, 2)).toEqual(IDS.slice(3, 5));
    const past = {
      createdAt: new Date(rows[4]!.nostrKeyCreatedAt.getTime() + 1),
      messageId: IDS[0]!,
    };
    expect(await round(store, past, 3)).toEqual(IDS.slice(0, 3));
  });

  it('returns nothing for an empty store and copies its rows', async () => {
    const { store } = setup();
    expect(await store.listRound(null, 20)).toEqual([]);
    expect(await store.listRound({ createdAt: new Date(0), messageId: ID_A }, 20)).toEqual([]);
    await store.ensureListed(ID_A, KEK, keygenFrom(2));
    const [row] = await store.listRound(null, 20);
    row!.profileName = 'changed';
    expect((await store.getByMessageId(ID_A))?.profileName).toBe('Coffee Lab');
  });
});

describe('InMemoryShopIdentityStore queueing', () => {
  it('queues a place change of any note with a key and a photo change only while listed', async () => {
    const { messages, store } = setup();
    await store.ensureListed(ID_A, KEK, keygenFrom(2));
    const claim = (await store.claimPlaces(20, 60_000))[0]!;
    await store.finishPlace(claim, 'put');
    let row = (await store.getByMessageId(ID_A))!;
    expect(row).toMatchObject({ ocpPlacePending: false, ocpPhotosPending: true });
    const photoGen = row.ocpPhotosGeneration;

    await messages.updateText(ID_A, `${TEXT} More beans.`);
    row = (await store.getByMessageId(ID_A))!;
    expect(row).toMatchObject({ ocpPlacePending: true, ocpPlaceGeneration: 2 });

    await messages.replacePhotos(ID_A, [PNG, JPEG]);
    row = (await store.getByMessageId(ID_A))!;
    expect(row.ocpPhotosGeneration).toBe(photoGen + 1);

    await messages.markDeleted(ID_A, new Date(0), 'staff');
    await messages.replacePhotos(ID_A, [JPEG]);
    row = (await store.getByMessageId(ID_A))!;
    expect(row.ocpPlaceGeneration).toBe(3);
    expect(row.ocpPhotosGeneration).toBe(photoGen + 1);
  });

  it('treats a vanished note as a place change', async () => {
    const messages = new InMemoryMessageStore([shopRow(ID_A)]);
    let gone = false;
    const wrapped = {
      getById: (id: string) => (gone ? Promise.resolve(undefined) : messages.getById(id)),
      getPhoto: (id: string) => messages.getPhoto(id),
      listExtraPhotos: (id: string) => messages.listExtraPhotos(id),
    } as unknown as MessageStore;
    const store = new InMemoryShopIdentityStore(wrapped);
    await store.ensureListed(ID_A, KEK, keygenFrom(2));
    gone = true;
    expect((await store.getByMessageId(ID_A))?.ocpPlaceGeneration).toBe(2);
  });

  it('queues every identity in pages by message id', async () => {
    const { store } = setup([shopRow(ID_C), shopRow(ID_A), shopRow(ID_B)]);
    for (const [id, n] of [
      [ID_C, 4],
      [ID_A, 2],
      [ID_B, 3],
    ] as const) {
      await store.ensureListed(id, KEK, keygenFrom(n));
    }
    expect(await store.queueAllPlacePage(null, 2)).toEqual([ID_A, ID_B]);
    expect(await store.queueAllPlacePage(ID_B, 2)).toEqual([ID_C]);
    expect((await store.getByMessageId(ID_A))?.ocpPlaceGeneration).toBe(2);
  });
});

describe('InMemoryShopIdentityStore claims', () => {
  async function claimed(): Promise<{
    messages: InMemoryMessageStore;
    store: InMemoryShopIdentityStore;
    clock: { now: number };
    claim: ShopOcpClaim;
  }> {
    const ctx = setup([shopRow(ID_A, { hasPhoto: true }), shopRow(ID_B)]);
    await ctx.store.ensureListed(ID_A, KEK, keygenFrom(2));
    await ctx.store.ensureListed(ID_B, KEK, keygenFrom(3));
    const claims = await ctx.store.claimPlaces(20, 60_000);
    expect(claims.map((c) => c.messageId)).toEqual([ID_A, ID_B]);
    return { ...ctx, claim: claims[0]! };
  }

  it('claims at most the limit, respects leases and raises the token', async () => {
    const { store, clock } = setup([shopRow(ID_A), shopRow(ID_B)]);
    await store.ensureListed(ID_A, KEK, keygenFrom(2));
    await store.ensureListed(ID_B, KEK, keygenFrom(3));
    const first = await store.claimPlaces(1, 60_000);
    expect(first).toEqual([{ messageId: ID_A, generation: 1, claim: 1 }]);
    expect(await store.claimPlaces(5, 60_000)).toEqual([
      { messageId: ID_B, generation: 1, claim: 1 },
    ]);
    expect(await store.claimPlaces(5, 60_000)).toEqual([]);
    clock.now += 60_000;
    expect((await store.claimPlaces(5, 60_000)).map((c) => c.claim)).toEqual([2, 2]);
  });

  it('checks the remaining lease and the token', async () => {
    const { store, clock, claim } = await claimed();
    expect(await store.leaseHasTime('place', claim, 60_000)).toBe(true);
    clock.now += 1;
    expect(await store.leaseHasTime('place', claim, 60_000)).toBe(false);
    expect(await store.leaseHasTime('place', { ...claim, claim: 9 }, 0)).toBe(false);
    expect(await store.leaseHasTime('photos', claim, 0)).toBe(false);
    expect(await store.leaseHasTime('place', { ...claim, messageId: 'missing' }, 0)).toBe(false);
    expect(await store.leaseHasTime('photos', { ...claim, messageId: 'missing' }, 0)).toBe(false);
    await store.release('place', claim);
    expect(await store.leaseHasTime('place', claim, 0)).toBe(false);
  });

  it('raises the shared revision only under the claim', async () => {
    const { store, claim } = await claimed();
    expect(await store.nextRevision('place', claim)).toBe(1);
    expect(await store.nextRevision('place', claim)).toBe(2);
    expect(await store.nextRevision('place', { ...claim, claim: 9 })).toBeUndefined();
    expect(await store.nextRevision('photos', claim)).toBeUndefined();
  });

  it('reserves a photo revision only while the place is confirmed and the generation holds', async () => {
    const { messages, store, claim } = await claimed();
    await store.finishPlace(claim, 'put');
    const photo = (await store.claimPhoto(60_000))!;
    expect(
      await store.nextRevision('photos', { ...photo, generation: photo.generation + 1 }),
    ).toBeUndefined();
    expect(await store.nextRevision('photos', photo)).toBe(1);
    // A hide after the claim queues the place: no further photo revision.
    await messages.markDeleted(ID_A, new Date(), 'staff');
    expect(await store.nextRevision('photos', photo)).toBeUndefined();
    expect((await store.getByMessageId(ID_A))?.ocpRevision).toBe(1);
    // The place lane still gets its revision.
    const [place] = await store.claimPlaces(1, 60_000);
    expect(await store.nextRevision('place', place!)).toBe(2);
  });

  it('releases only with the matching token, for either lane', async () => {
    const { store, claim } = await claimed();
    await store.release('place', { ...claim, claim: 9 });
    expect((await store.getByMessageId(ID_A))?.ocpPlaceClaimedUntil).not.toBeNull();
    await store.release('place', claim);
    expect((await store.getByMessageId(ID_A))?.ocpPlaceClaimedUntil).toBeNull();
    await store.finishPlace((await store.claimPlaces(1, 60_000))[0]!, 'put');
    const photo = (await store.claimPhoto(60_000))!;
    await store.release('photos', photo);
    expect((await store.getByMessageId(ID_A))?.ocpPhotosClaimedUntil).toBeNull();
  });

  it('records each place result', async () => {
    const { messages, store, claim } = await claimed();
    await store.finishPlace({ ...claim, claim: 9 }, 'put');
    expect((await store.getByMessageId(ID_A))?.ocpPlacePending).toBe(true);
    await store.finishPlace(claim, 'put');
    let row = (await store.getByMessageId(ID_A))!;
    expect(row).toMatchObject({
      ocpPlacePending: false,
      ocpPlaceClaimedUntil: null,
      ocpPhotosPending: true,
      ocpPhotosGeneration: 1,
    });

    await messages.updateText(ID_A, `${TEXT} Change one.`);
    const second = (await store.claimPlaces(1, 60_000))[0]!;
    await messages.updateText(ID_A, `${TEXT} Change two.`);
    await store.finishPlace(second, 'put');
    row = (await store.getByMessageId(ID_A))!;
    expect(row).toMatchObject({ ocpPlacePending: true, ocpPhotosGeneration: 1 });

    const third = (await store.claimPlaces(1, 60_000))[0]!;
    await messages.updateText(ID_A, `${TEXT} Change three.`);
    await store.finishPlace(third, 'created');
    row = (await store.getByMessageId(ID_A))!;
    expect(row).toMatchObject({
      ocpPlacePending: true,
      ocpPhotosHash: null,
      ocpPhotosPending: true,
      ocpPhotosGeneration: 2,
    });

    const fourth = (await store.claimPlaces(1, 60_000))[0]!;
    await store.finishPlace(fourth, 'created');
    expect((await store.getByMessageId(ID_A))?.ocpPhotosGeneration).toBe(3);

    await messages.updateText(ID_A, `${TEXT} Change four.`);
    await store.finishPlace((await store.claimPlaces(1, 60_000))[0]!, 'delete');
    row = (await store.getByMessageId(ID_A))!;
    expect(row).toMatchObject({ ocpPlacePending: false, ocpPhotosGeneration: 3 });

    await messages.updateText(ID_A, `${TEXT} Change five.`);
    await store.finishPlace((await store.claimPlaces(1, 60_000))[0]!, 'reject');
    expect((await store.getByMessageId(ID_A))?.ocpPlacePending).toBe(false);
  });

  it('resets the photo outbox before a delete under the place token', async () => {
    const { store, claim } = await claimed();
    await store.resetPhotosForDelete({ ...claim, claim: 9 });
    expect((await store.getByMessageId(ID_A))?.ocpPhotosGeneration).toBe(0);
    await store.resetPhotosForDelete(claim);
    expect(await store.getByMessageId(ID_A)).toMatchObject({
      ocpPhotosHash: null,
      ocpPhotosPending: false,
      ocpPhotosGeneration: 1,
    });
  });

  it('claims one photo set whose place is confirmed', async () => {
    const { store, clock, claim } = await claimed();
    expect(await store.claimPhoto(60_000)).toBeUndefined();
    await store.finishPlace(claim, 'put');
    const photo = await store.claimPhoto(60_000);
    expect(photo).toEqual({ messageId: ID_A, generation: 1, claim: 1 });
    expect(await store.leaseHasTime('photos', photo!, 60_000)).toBe(true);
    expect(await store.leaseHasTime('photos', photo!, 60_001)).toBe(false);
    expect(await store.claimPhoto(60_000)).toBeUndefined();
    clock.now += 60_000;
    expect((await store.claimPhoto(60_000))?.claim).toBe(2);
  });

  it('settles a photo claim by generation', async () => {
    const { messages, store, claim } = await claimed();
    await store.finishPlace(claim, 'put');
    let photo = (await store.claimPhoto(60_000))!;
    await store.clearPhotoHash({ ...photo, claim: 9 });
    await store.clearPhotoWithoutSend({ ...photo, claim: 9 });
    await store.finishPhotos({ ...photo, claim: 9 }, 'h');
    await store.missingPhotoPlace({ ...photo, claim: 9 }, true);
    expect((await store.getByMessageId(ID_A))?.ocpPhotosPending).toBe(true);

    await store.clearPhotoWithoutSend(photo);
    expect((await store.getByMessageId(ID_A))?.ocpPhotosPending).toBe(false);

    await messages.replacePhotos(ID_A, [PNG]);
    photo = (await store.claimPhoto(60_000))!;
    await messages.replacePhotos(ID_A, [JPEG]);
    await store.clearPhotoWithoutSend(photo);
    expect((await store.getByMessageId(ID_A))?.ocpPhotosPending).toBe(true);

    photo = (await store.claimPhoto(60_000))!;
    await store.finishPhotos(photo, 'hash-1');
    expect(await store.getByMessageId(ID_A)).toMatchObject({
      ocpPhotosHash: 'hash-1',
      ocpPhotosPending: false,
    });

    await messages.replacePhotos(ID_A, [PNG]);
    photo = (await store.claimPhoto(60_000))!;
    await store.clearPhotoHash(photo);
    await messages.replacePhotos(ID_A, [JPEG, PNG]);
    await store.finishPhotos(photo, 'hash-2');
    expect(await store.getByMessageId(ID_A)).toMatchObject({
      ocpPhotosHash: null,
      ocpPhotosPending: true,
    });

    photo = (await store.claimPhoto(60_000))!;
    await store.missingPhotoPlace(photo, false);
    expect(await store.getByMessageId(ID_A)).toMatchObject({
      ocpPhotosPending: false,
      ocpPlacePending: false,
    });

    await messages.replacePhotos(ID_A, [PNG]);
    photo = (await store.claimPhoto(60_000))!;
    await messages.replacePhotos(ID_A, [JPEG]);
    await store.missingPhotoPlace(photo, true);
    expect(await store.getByMessageId(ID_A)).toMatchObject({
      ocpPhotosHash: null,
      ocpPhotosPending: true,
      ocpPlacePending: true,
      ocpPhotosClaimedUntil: null,
    });
  });

  it('defers photos: keeps the photo state and holds the queued place until the photo lease ends', async () => {
    const { store, clock, claim } = await claimed();
    await store.finishPlace(claim, 'put');
    const photo = (await store.claimPhoto(60_000))!;
    const photoUntil = new Date(clock.now + 60_000);
    await store.deferPhotos({ ...photo, claim: 9 }, true);
    await store.deferPhotos(photo, false);
    expect(await store.getByMessageId(ID_A)).toMatchObject({
      ocpPlacePending: false,
      ocpPlaceClaimedUntil: null,
    });

    await store.deferPhotos(photo, true);
    const held = await store.getByMessageId(ID_A);
    expect(held).toMatchObject({
      ocpPhotosPending: true,
      ocpPhotosClaimedUntil: photoUntil,
      ocpPhotosClaim: photo.claim,
      ocpPlacePending: true,
      ocpPlaceGeneration: claim.generation + 1,
      ocpPlaceClaimedUntil: photoUntil,
      ocpPlaceClaim: claim.claim,
    });
    expect(await store.claimPlaces(20, 60_000)).toEqual([]);
    expect(await store.claimPhoto(60_000)).toBeUndefined();

    clock.now += 30_000;
    const later = await store.claimPlaces(1, 60_000);
    expect(later).toEqual([]);
    clock.now += 30_000;
    const place = (await store.claimPlaces(20, 60_000)).find((item) => item.messageId === ID_A)!;
    const placeUntil = new Date(clock.now + 60_000);
    await store.deferPhotos(photo, true);
    expect((await store.getByMessageId(ID_A))?.ocpPlaceClaimedUntil).toEqual(placeUntil);

    await store.release('photos', photo);
    await store.release('place', place);
    await store.deferPhotos(photo, true);
    expect(await store.getByMessageId(ID_A)).toMatchObject({
      ocpPlacePending: true,
      ocpPlaceClaimedUntil: null,
      ocpPhotosClaimedUntil: null,
    });
  });
});

type Call = { text: string; params: readonly unknown[] };

function fakeSql(results: unknown[][] = []): { sql: SqlClient; calls: Call[] } {
  const calls: Call[] = [];
  const sql: SqlClient = {
    query: <T>(text: string, params: readonly unknown[] = []) => {
      calls.push({ text, params });
      return Promise.resolve((results.shift() ?? []) as T[]);
    },
    execute: (text: string, params: readonly unknown[] = []) => {
      calls.push({ text, params });
      return Promise.resolve();
    },
  };
  return { sql, calls };
}

function sqlIdentity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: ID_A,
    nostr_pubkey: publicKeyHexFromSecret(secret(2)),
    nostr_nsec_ciphertext: new Uint8Array([1, 2]),
    nostr_kek_id: 1,
    nostr_key_custody: 'custodial',
    nostr_key_created_at: '2026-10-01T00:00:00.000Z',
    profile_name: 'Coffee Lab',
    ocp_photos_hash: null,
    ocp_photos_pending: false,
    ocp_photos_generation: 0,
    ocp_photos_claimed_until: null,
    ocp_photos_claim: 0,
    ocp_place_pending: true,
    ocp_place_generation: 1,
    ocp_place_claimed_until: null,
    ocp_place_claim: 0,
    ocp_revision: '3',
    ...overrides,
  };
}

const SNAPSHOT = ['Coffee Lab', TEXT, 47.3, 8.5, 'Main Street', '1', '8001', 'Zürich', 'CH'];

describe('PostgresShopIdentityStore', () => {
  const messages = new InMemoryMessageStore([
    shopRow(ID_A),
    shopRow(ID_B, { text: 'No tag in this text at all here.' }),
  ]);

  it('maps identity rows with string and Date columns', async () => {
    const until = new Date('2026-10-01T00:01:00Z');
    const { sql } = fakeSql([
      [sqlIdentity()],
      [
        sqlIdentity({
          nostr_key_created_at: new Date('2026-10-02T00:00:00Z'),
          ocp_photos_claimed_until: until,
          ocp_place_claimed_until: '2026-10-01T00:02:00.000Z',
          ocp_revision: 5n,
        }),
      ],
      [],
    ]);
    const store = new PostgresShopIdentityStore(sql, messages);
    const row = (await store.getByMessageId(ID_A))!;
    expect(row).toMatchObject({
      messageId: ID_A,
      nostrKeyCreatedAt: new Date('2026-10-01T00:00:00Z'),
      ocpRevision: 3,
      ocpPhotosClaimedUntil: null,
    });
    const other = (await store.getByPubkey(row.nostrPubkey))!;
    expect(other.ocpPhotosClaimedUntil).toEqual(until);
    expect(other.ocpPlaceClaimedUntil).toEqual(new Date('2026-10-01T00:02:00Z'));
    expect(other.ocpRevision).toBe(5);
    expect(await store.getByPubkey('00'.repeat(32))).toBeUndefined();
  });

  it('reads the ciphertext and lists in key order', async () => {
    const { sql, calls } = fakeSql([
      [{ nostr_nsec_ciphertext: new Uint8Array([9]) }],
      [],
      [sqlIdentity()],
    ]);
    const store = new PostgresShopIdentityStore(sql, messages);
    expect(await store.getNostrCiphertext(ID_A)).toEqual(new Uint8Array([9]));
    expect(await store.getNostrCiphertext(ID_B)).toBeUndefined();
    expect((await store.listAll()).map((row) => row.messageId)).toEqual([ID_A]);
    expect(calls[2]?.text).toContain('ORDER BY nostr_key_created_at ASC, message_id ASC');
  });

  it('reads one bounded round page and wraps with a second bounded read', async () => {
    const { sql, calls } = fakeSql([
      [sqlIdentity()],
      [sqlIdentity(), sqlIdentity({ message_id: ID_B })],
      [sqlIdentity({ message_id: ID_C })],
      [sqlIdentity()],
    ]);
    const store = new PostgresShopIdentityStore(sql, messages);
    const ids = (rows: ShopIdentityRow[]): string[] => rows.map((row) => row.messageId);
    // No cursor: one read, also when it is short.
    expect(ids(await store.listRound(null, 20))).toEqual([ID_A]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual([null, null, 20]);
    expect(calls[0]?.text).toContain(
      '(nostr_key_created_at, message_id) > ($1::timestamptz, $2::uuid)',
    );
    expect(calls[0]?.text).toContain('ORDER BY nostr_key_created_at ASC, message_id ASC');
    expect(calls[0]?.text).toContain('LIMIT $3');
    const cursor = { createdAt: new Date('2026-10-01T00:00:00Z'), messageId: ID_A };
    // A full page after the cursor: no second read.
    expect(ids(await store.listRound(cursor, 2))).toEqual([ID_A, ID_B]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.params).toEqual([cursor.createdAt, ID_A, 2]);
    // A short page: the second read takes only the rest of the limit.
    expect(ids(await store.listRound(cursor, 2))).toEqual([ID_C, ID_A]);
    expect(calls).toHaveLength(4);
    expect(calls[3]?.text).toContain(
      '(nostr_key_created_at, message_id) <= ($1::timestamptz, $2::uuid)',
    );
    expect(calls[3]?.text).toContain('LIMIT $3');
    expect(calls[3]?.params).toEqual([cursor.createdAt, ID_A, 1]);
  });

  it('inserts a new key with a locked, unchanged note and queues its place', async () => {
    const { sql, calls } = fakeSql([[], [sqlIdentity()]]);
    const store = new PostgresShopIdentityStore(sql, messages);
    const created = await store.ensureListed(ID_A, KEK, keygenFrom(2));
    expect(created?.messageId).toBe(ID_A);
    const insert = calls[1]!;
    expect(insert.text).toContain('FOR UPDATE');
    expect(insert.text).toContain('ON CONFLICT (message_id) DO NOTHING');
    expect(insert.text).toContain('true, 1 FROM locked');
    expect(insert.text).toContain('SELECT $1, $11, $12, $13, $14, $15, $2, true, 1 FROM locked');
    expect(insert.params[0]).toBe(ID_A);
    expect(insert.params.slice(1, 10)).toEqual(SNAPSHOT);
    expect(insert.params[10]).toBe(publicKeyHexFromSecret(secret(2)));
    expect(insert.params.slice(12)).toEqual([1, 'custodial', expect.any(Date)]);
    const plain = await decryptNostrSecret(insert.params[11] as Uint8Array, KEK, `shop:${ID_A}`);
    expect([...plain]).toEqual([...secret(2)]);
  });

  it('returns the winner when the insert adds no row', async () => {
    const { sql } = fakeSql([[], [], [sqlIdentity({ nostr_pubkey: 'ab'.repeat(32) })]]);
    const store = new PostgresShopIdentityStore(sql, messages);
    expect((await store.ensureListed(ID_A, KEK, keygenFrom(2)))?.nostrPubkey).toBe('ab'.repeat(32));
  });

  it('creates nothing for a note that is not listed', async () => {
    const { sql, calls } = fakeSql([[]]);
    const store = new PostgresShopIdentityStore(sql, messages);
    expect(await store.ensureListed(ID_B, KEK)).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('rewrites profile_name of an existing listed identity only under an unchanged note', async () => {
    const { sql, calls } = fakeSql([
      [sqlIdentity({ profile_name: 'Old' })],
      [sqlIdentity()],
      [sqlIdentity({ message_id: ID_B, profile_name: 'Old' })],
      [sqlIdentity()],
      [sqlIdentity({ profile_name: 'Old' })],
      [],
      [],
    ]);
    const store = new PostgresShopIdentityStore(sql, messages);
    expect((await store.ensureListed(ID_A, KEK))?.profileName).toBe('Coffee Lab');
    expect(calls[1]?.text).toContain('UPDATE shop_identity SET profile_name = $2');
    expect(calls[1]?.text).toContain('FOR UPDATE');
    expect(calls[1]?.text).toContain('AND text = $3 AND place_lat = $4');
    expect(calls[1]?.params).toEqual([ID_A, ...SNAPSHOT]);
    expect((await store.ensureListed(ID_B, KEK))?.profileName).toBe('Old');
    expect((await store.ensureListed(ID_A, KEK))?.profileName).toBe('Coffee Lab');
    expect(calls).toHaveLength(4);
    // The note changed after the read: the update matches nothing.
    expect((await store.ensureListed(ID_A, KEK))?.profileName).toBe('Old');
    expect(calls).toHaveLength(6);
    expect(await store.ensureListed(ID_C, KEK)).toBeUndefined();
    expect(calls).toHaveLength(7);
  });

  it('lists candidates with the keyset cursor', async () => {
    const created = new Date('2026-01-01T00:00:00Z');
    const { sql, calls } = fakeSql([
      [
        { id: ID_A, created_at: created },
        { id: ID_B, created_at: '2026-01-02T00:00:00.000Z' },
      ],
      [],
    ]);
    const store = new PostgresShopIdentityStore(sql, messages);
    expect(await store.listCandidates(null, 20)).toEqual([
      { id: ID_A, createdAt: created },
      { id: ID_B, createdAt: new Date('2026-01-02T00:00:00Z') },
    ]);
    expect(calls[0]?.params).toEqual([null, null, 20]);
    expect(calls[0]?.text).toContain('NOT EXISTS (SELECT 1 FROM shop_identity');
    expect(calls[0]?.text).toContain("m.text ~* '#21giftsshop([^a-z0-9_]|$)'");
    await store.listCandidates({ createdAt: created, id: ID_A }, 5);
    expect(calls[1]?.params).toEqual([created, ID_A, 5]);
  });

  it('queues a page of identities by message id', async () => {
    const { sql, calls } = fakeSql([[{ message_id: ID_B }, { message_id: ID_A }]]);
    const store = new PostgresShopIdentityStore(sql, messages);
    expect(await store.queueAllPlacePage(null, 200)).toEqual([ID_A, ID_B]);
    expect(calls[0]?.params).toEqual([null, 200]);
    expect(calls[0]?.text).toContain('ocp_place_generation = s.ocp_place_generation + 1');
  });

  it('claims places and photos with the database clock', async () => {
    const { sql, calls } = fakeSql([
      [{ message_id: ID_A, ocp_place_generation: 2, ocp_place_claim: '4' }],
      [{ message_id: ID_A, ocp_photos_generation: 3, ocp_photos_claim: 5 }],
      [],
    ]);
    const store = new PostgresShopIdentityStore(sql, messages);
    expect(await store.claimPlaces(20, 60_000)).toEqual([
      { messageId: ID_A, generation: 2, claim: 4 },
    ]);
    expect(calls[0]?.text).toContain('FOR UPDATE SKIP LOCKED');
    expect(calls[0]?.text).toContain('ocp_place_claimed_until <= now()');
    expect(calls[0]?.params).toEqual([20, 60_000]);
    expect(await store.claimPhoto(60_000)).toEqual({ messageId: ID_A, generation: 3, claim: 5 });
    expect(calls[1]?.text).toContain('NOT ocp_place_pending');
    expect(await store.claimPhoto(60_000)).toBeUndefined();
  });

  it('checks the lease and raises the revision under the claim token', async () => {
    const { sql, calls } = fakeSql([[{ ok: 1 }], [], [{ ocp_revision: '7' }], []]);
    const store = new PostgresShopIdentityStore(sql, messages);
    const claim = { messageId: ID_A, generation: 1, claim: 2 };
    expect(await store.leaseHasTime('place', claim, 15_000)).toBe(true);
    expect(calls[0]?.text).toContain('ocp_place_claimed_until >= now()');
    expect(calls[0]?.params).toEqual([ID_A, 2, 15_000]);
    expect(await store.leaseHasTime('photos', claim, 40_000)).toBe(false);
    expect(calls[1]?.text).toContain('ocp_photos_claim = $2');
    expect(await store.nextRevision('place', claim)).toBe(7);
    expect(calls[2]?.text).toContain('ocp_place_claim = $2');
    expect(calls[2]?.text).not.toContain('ocp_place_pending');
    expect(calls[2]?.params).toEqual([ID_A, 2]);
    expect(await store.nextRevision('photos', claim)).toBeUndefined();
    expect(calls[3]?.text).toContain('ocp_photos_claim = $2');
    expect(calls[3]?.text).toContain('AND NOT ocp_place_pending AND ocp_photos_generation = $3');
    expect(calls[3]?.params).toEqual([ID_A, 2, 1]);
  });

  it('writes every result conditional on the claim token', async () => {
    const { sql, calls } = fakeSql();
    const store = new PostgresShopIdentityStore(sql, messages);
    const claim = { messageId: ID_A, generation: 4, claim: 6 };
    await store.release('place', claim);
    await store.release('photos', claim);
    await store.resetPhotosForDelete(claim);
    await store.finishPlace(claim, 'put');
    await store.finishPlace(claim, 'created');
    await store.finishPlace(claim, 'delete');
    await store.clearPhotoWithoutSend(claim);
    await store.clearPhotoHash(claim);
    await store.finishPhotos(claim, 'hash');
    await store.missingPhotoPlace(claim, true);
    await store.renameIfListed(shopRow(ID_A));
    await store.deferPhotos(claim, false);
    await store.deferPhotos(claim, true);
    expect(calls[0]?.text).toContain('ocp_place_claimed_until = NULL');
    expect(calls[1]?.text).toContain('ocp_photos_claimed_until = NULL');
    expect(calls[2]?.text).toContain('ocp_place_claim = $2');
    expect(calls[3]?.params).toEqual([ID_A, 6, 4, false, true]);
    expect(calls[4]?.params).toEqual([ID_A, 6, 4, true, false]);
    expect(calls[5]?.params).toEqual([ID_A, 6, 4, false, false]);
    expect(calls[6]?.params).toEqual([ID_A, 6, 4]);
    expect(calls[7]?.params).toEqual([ID_A, 6]);
    expect(calls[8]?.params).toEqual([ID_A, 6, 4, 'hash']);
    expect(calls[9]?.params).toEqual([ID_A, 6, 4, true]);
    expect(calls).toHaveLength(12);
    expect(calls[10]?.text).toContain('UPDATE shop_identity SET profile_name = $2');
    expect(calls[10]?.text).toContain('FOR UPDATE');
    expect(calls[10]?.params).toEqual([ID_A, ...SNAPSHOT]);
    // An unlisted snapshot sends nothing.
    await store.renameIfListed(shopRow(ID_B, { text: 'No tag in this text at all here.' }));
    expect(calls).toHaveLength(12);
    expect(calls[11]?.text).toContain(
      'GREATEST(ocp_place_claimed_until, ocp_photos_claimed_until)',
    );
    expect(calls[11]?.text).toContain('ocp_photos_claim = $2');
    expect(calls[11]?.params).toEqual([ID_A, 6]);
    for (const call of calls.slice(0, 10)) {
      expect(call.text).toMatch(/ocp_(place|photos)_claim = \$2/);
    }
  });
});

describe('ShopIdentityRow type', () => {
  it('is structurally complete', () => {
    const row: ShopIdentityRow = {
      messageId: ID_A,
      nostrPubkey: 'ab'.repeat(32),
      nostrNsecCiphertext: new Uint8Array(),
      nostrKekId: 1,
      nostrKeyCustody: 'custodial',
      nostrKeyCreatedAt: new Date(0),
      profileName: 'x',
      ocpPhotosHash: null,
      ocpPhotosPending: false,
      ocpPhotosGeneration: 0,
      ocpPhotosClaimedUntil: null,
      ocpPhotosClaim: 0,
      ocpPlacePending: false,
      ocpPlaceGeneration: 0,
      ocpPlaceClaimedUntil: null,
      ocpPlaceClaim: 0,
      ocpRevision: 0,
    };
    expect(shopNpub(row)).toMatch(/^npub1/);
  });
});
