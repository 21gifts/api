import { describe, expect, it } from 'vitest';
import { nip19 } from 'nostr-tools';
import { countingBytes } from '@/__tests__/helpers/counting-bytes';
import type { SqlClient } from '@/lib/auth/sql';
import { unsignedNostrDefaults, type ForumPhoto, type MessageRow } from '@/lib/message';
import { InMemoryMessageStore, type MessageStore } from '@/lib/message-store';
import { decryptNostrSecret, publicKeyHexFromSecret } from '@/lib/nostr/keys';
import {
  InMemoryShopIdentityStore,
  PostgresShopIdentityStore,
  SHOP_IDENTITY_SCHEMA_SQL,
  migrateShopIdentitySchema,
  shopKeyMustBeAdopted,
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

const ADOPTED_ID = '0cc5c2eb-aaf1-4f36-be26-f1b967e7bbe5';

describe('shopKeyMustBeAdopted', () => {
  it('names only the shops whose key already exists', () => {
    expect(shopKeyMustBeAdopted(ADOPTED_ID)).toBe(true);
    expect(shopKeyMustBeAdopted(ID_A)).toBe(false);
    expect(shopKeyMustBeAdopted(ADOPTED_ID.toUpperCase())).toBe(false);
  });
});

describe('adoptKnownSecret', () => {
  it('stores the supplied secret and does not mint another one', async () => {
    const { messages, store, clock } = setup([shopRow(ADOPTED_ID)]);
    expect(await store.ensureListed(ADOPTED_ID, KEK, keygenFrom(9))).toBeUndefined();
    expect(await store.listAll()).toEqual([]);
    const first = await store.adoptKnownSecret(ADOPTED_ID, secret(4), KEK);
    expect(first).toMatchObject({
      messageId: ADOPTED_ID,
      nostrPubkey: publicKeyHexFromSecret(secret(4)),
      nostrKekId: 1,
      nostrKeyCustody: 'custodial',
      profileName: 'Coffee Lab',
      ocpPlacePending: false,
      ocpPlaceGeneration: 0,
      ocpPhotosPending: true,
      ocpPhotosGeneration: 1,
      ocpRevision: 0,
    });
    expect(first.nostrKeyCreatedAt.getTime()).toBe(clock.now);
    const plain = await decryptNostrSecret(first.nostrNsecCiphertext, KEK, `shop:${ADOPTED_ID}`);
    expect([...plain]).toEqual([...secret(4)]);
    expect((await messages.getById(ADOPTED_ID))?.shopNpub).toBe(shopNpub(first));
    const again = await store.adoptKnownSecret(ADOPTED_ID, secret(4).slice(), KEK);
    expect(again.nostrNsecCiphertext).toEqual(first.nostrNsecCiphertext);
    expect((await store.ensureListed(ADOPTED_ID, KEK, keygenFrom(9)))?.nostrPubkey).toBe(
      first.nostrPubkey,
    );
    expect((await store.getByMessageId(ADOPTED_ID))?.ocpPlacePending).toBe(false);
  });

  it('keeps a pin label when the note is not a public shop', async () => {
    const { store } = setup([
      shopRow(ID_A, { text: 'No shop tag in this long enough note.', shopAccount: null }),
    ]);
    const row = await store.adoptKnownSecret(ID_A, secret(4), KEK);
    expect(row.profileName).toBe('Coffee Lab');
    expect(row.ocpPlacePending).toBe(false);
    expect(row.ocpPhotosPending).toBe(false);
    expect(row.ocpPhotosGeneration).toBe(0);
  });

  it('uses Shop when the note has no public name and no label', async () => {
    const blank = setup([
      shopRow(ID_A, {
        text: 'No shop tag in this long enough note.',
        shopAccount: null,
        place: { lat: 1, lng: 2, label: '   ', address: null },
      }),
    ]);
    expect((await blank.store.adoptKnownSecret(ID_A, secret(4), KEK)).profileName).toBe('Shop');
    const missing = setup([
      shopRow(ID_A, {
        text: 'No shop tag in this long enough note.',
        shopAccount: null,
        place: null,
      }),
    ]);
    expect((await missing.store.adoptKnownSecret(ID_A, secret(4), KEK)).profileName).toBe('Shop');
  });

  it('refuses a missing note, a bad secret, a different key and a shared key', async () => {
    const { store } = setup([shopRow(ID_A), shopRow(ID_B)]);
    await expect(store.adoptKnownSecret(ID_C, secret(4), KEK)).rejects.toThrow(
      'shop note not found',
    );
    await expect(store.adoptKnownSecret(ID_A, secret(4).slice(0, 31), KEK)).rejects.toThrow(
      '32 bytes',
    );
    await expect(store.adoptKnownSecret(ID_A, new Uint8Array(32), KEK)).rejects.toThrow(
      'Invalid Nostr secret',
    );
    await store.adoptKnownSecret(ID_A, secret(4), KEK);
    await expect(store.adoptKnownSecret(ID_A, secret(5), KEK)).rejects.toThrow(
      'shop nostr pubkey already exists',
    );
    expect((await store.getByMessageId(ID_A))?.nostrPubkey).toBe(publicKeyHexFromSecret(secret(4)));
    await expect(store.adoptKnownSecret(ID_B, secret(4), KEK)).rejects.toThrow(
      'shop nostr pubkey already exists',
    );
    expect(await store.getByMessageId(ID_B)).toBeUndefined();
  });

  it('returns the key stored while its own fingerprint was being read', async () => {
    const messages = new InMemoryMessageStore([shopRow(ID_A)]);
    const box: { store: InMemoryShopIdentityStore } = {
      store: undefined as unknown as InMemoryShopIdentityStore,
    };
    let nested = false;
    const wrapped = {
      getById: (id: string) => messages.getById(id),
      getPhotoSet: async (id: string) => {
        const set = await messages.getPhotoSet(id);
        if (!nested) {
          nested = true;
          await box.store.adoptKnownSecret(ID_A, secret(4), KEK);
        }
        return set;
      },
    } as unknown as MessageStore;
    box.store = new InMemoryShopIdentityStore(wrapped);
    const row = await box.store.adoptKnownSecret(ID_A, secret(4), KEK);
    expect(row.nostrPubkey).toBe(publicKeyHexFromSecret(secret(4)));
    expect(await box.store.listAll()).toHaveLength(1);
  });

  it('refuses a different key stored while its own fingerprint was being read', async () => {
    const messages = new InMemoryMessageStore([shopRow(ID_A)]);
    const box: { store: InMemoryShopIdentityStore } = {
      store: undefined as unknown as InMemoryShopIdentityStore,
    };
    let nested = false;
    const wrapped = {
      getById: (id: string) => messages.getById(id),
      getPhotoSet: async (id: string) => {
        const set = await messages.getPhotoSet(id);
        if (!nested) {
          nested = true;
          await box.store.adoptKnownSecret(ID_A, secret(4), KEK);
        }
        return set;
      },
    } as unknown as MessageStore;
    box.store = new InMemoryShopIdentityStore(wrapped);
    await expect(box.store.adoptKnownSecret(ID_A, secret(5), KEK)).rejects.toThrow(
      'shop nostr pubkey already exists',
    );
    expect((await box.store.getByMessageId(ID_A))?.nostrPubkey).toBe(
      publicKeyHexFromSecret(secret(4)),
    );
  });

  it('stores the key without attaching an npub on another message store', async () => {
    const messages = new InMemoryMessageStore([shopRow(ID_A)]);
    const wrapped = {
      getById: (id: string) => messages.getById(id),
      getPhotoSet: (id: string) => messages.getPhotoSet(id),
    } as unknown as MessageStore;
    const store = new InMemoryShopIdentityStore(wrapped);
    const created = await store.adoptKnownSecret(ID_A, secret(4), KEK);
    expect(created.nostrPubkey).toBe(publicKeyHexFromSecret(secret(4)));
    expect((await messages.getById(ID_A))?.shopNpub ?? null).toBeNull();
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
    expect(run[1]).toContain(
      `CREATE INDEX IF NOT EXISTS shop_identity_key_order_idx
     ON shop_identity (nostr_key_created_at, message_id);`,
    );
    expect(run[2]).toContain(
      `CREATE INDEX IF NOT EXISTS message_shop_candidate_idx
     ON message (created_at, id)
     WHERE parent_id IS NULL AND deleted_at IS NULL AND shop_account_id IS NOT NULL
       AND place_lat IS NOT NULL;`,
    );
    expect(run[3]).toContain(
      `CREATE INDEX IF NOT EXISTS message_shop_directory_idx
     ON message (created_at, id)
     WHERE parent_id IS NULL AND deleted_at IS NULL AND shop_account_id IS NOT NULL
       AND text ~* '#21giftsshop([^a-z0-9_]|$)';`,
    );
  });

  it('runs every statement under the migration advisory lock', () => {
    expect(SHOP_IDENTITY_SCHEMA_SQL).toHaveLength(7);
    for (const statement of SHOP_IDENTITY_SCHEMA_SQL) {
      expect(
        statement.startsWith(
          'DO $shop_identity$\nBEGIN\n  PERFORM pg_advisory_xact_lock(21499001);\n',
        ),
      ).toBe(true);
      expect(statement).toMatch(/;\nEND;\n\$shop_identity\$$/);
    }
  });

  it('replaces each trigger function and trigger inside one locked step', () => {
    const steps = SHOP_IDENTITY_SCHEMA_SQL.slice(4);
    for (const [index, [fn, name, table]] of [
      ['queue_shop_identity_place', 'trg_shop_identity_place', 'message'],
      ['queue_shop_identity_cover', 'trg_shop_identity_cover', 'message'],
      ['queue_shop_identity_photo', 'trg_shop_identity_extra_photo', 'message_extra_photo'],
    ].entries()) {
      const step = steps[index] as string;
      const lock = step.indexOf(`  LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE;\n`);
      const replace = step.indexOf(`CREATE OR REPLACE FUNCTION ${fn}()`);
      const drop = step.indexOf(`DROP TRIGGER IF EXISTS ${name} ON ${table};`);
      const create = step.indexOf(`CREATE TRIGGER ${name}`);
      expect(step.indexOf('pg_advisory_xact_lock')).toBeLessThan(lock);
      expect(lock).toBeGreaterThan(0);
      expect(lock).toBeLessThan(replace);
      expect(replace).toBeLessThan(drop);
      expect(drop).toBeLessThan(create);
    }
    const cover = steps[1] as string;
    expect(cover).toContain("NEW.text ~* '#21giftsshop([^a-z0-9_]|$)'");
    expect(cover).not.toContain('NEW.place_lat');
    const extra = steps[2] as string;
    expect(extra).toContain("m.text ~* '#21giftsshop([^a-z0-9_]|$)'");
    expect(extra).not.toContain('m.place_lat');
    expect(
      SHOP_IDENTITY_SCHEMA_SQL.filter((s) => s.includes('CREATE OR REPLACE FUNCTION')),
    ).toHaveLength(3);
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
      ocpPhotosPending: true,
      ocpPhotosGeneration: 1,
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
        void messages.updateText(ID_A, 'Fresh coffee roasted here every morning.');
        return secret(2);
      },
    };
    expect(await store.ensureListed(ID_A, KEK, unlisting)).toBeUndefined();
    expect(await store.listAll()).toEqual([]);
    expect((await messages.getById(ID_A))?.shopNpub ?? null).toBeNull();
  });

  it('creates nothing when the note disappears during key generation', async () => {
    const { messages, store } = setup();
    const disappearing = {
      generateSecretKey: () => {
        void messages.deleteById(ID_A);
        return secret(2);
      },
    };
    expect(await store.ensureListed(ID_A, KEK, disappearing)).toBeUndefined();
    expect(await store.listAll()).toEqual([]);
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

  it('does not put back an older name when a newer rename is stored during the call', async () => {
    const messages = new InMemoryMessageStore([shopRow(ID_A)]);
    let reads = 0;
    let armed = false;
    let gone = false;
    let reached!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => (reached = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const wrapped = {
      getById: async (id: string) => {
        if (gone) return undefined;
        const row = await messages.getById(id);
        // Read 1 of an armed call is the queue sync, read 2 its snapshot.
        if (armed && ++reads === 2) {
          reached();
          await gate;
        }
        return row;
      },
      getPhotoSet: (id: string) => messages.getPhotoSet(id),
    } as unknown as MessageStore;
    const store = new InMemoryShopIdentityStore(wrapped);
    await store.ensureListed(ID_A, KEK, keygenFrom(2));
    armed = true;
    // This call holds the snapshot with the old name 'Coffee Lab'.
    const older = store.ensureListed(ID_A, KEK);
    await paused;
    armed = false;
    await messages.setPlace(ID_A, { ...shopRow(ID_A).place!, label: 'Roastery' });
    await store.renameIfListed((await messages.getById(ID_A))!);
    expect((await store.getByMessageId(ID_A))?.profileName).toBe('Roastery');
    release();
    expect((await older)?.profileName).toBe('Roastery');
    expect((await store.getByMessageId(ID_A))?.profileName).toBe('Roastery');
    // A current snapshot still renames, and a gone note keeps the stored name.
    await messages.setPlace(ID_A, { ...shopRow(ID_A).place!, label: 'Bakery' });
    expect((await store.ensureListed(ID_A, KEK))?.profileName).toBe('Bakery');
    gone = true;
    expect((await store.ensureListed(ID_A, KEK))?.profileName).toBe('Bakery');
  });

  it('does not rename when the note is gone', async () => {
    const messages = new InMemoryMessageStore([shopRow(ID_A)]);
    let gone = false;
    const wrapped = {
      getById: (id: string) => (gone ? Promise.resolve(undefined) : messages.getById(id)),
      getPhotoSet: (id: string) => messages.getPhotoSet(id),
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
      getPhotoSet: (id: string) => messages.getPhotoSet(id),
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
    const unpinned = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    expect(all.map((row) => row.id)).toEqual([ID_A, ID_B, ID_C, unpinned]);
    expect(
      (await store.listCandidates({ createdAt: t('2026-01-01T00:00:00Z'), id: ID_A }, 10)).map(
        (row) => row.id,
      ),
    ).toEqual([ID_B, ID_C, unpinned]);
    expect(await store.listCandidates(null, 1)).toEqual([
      { id: ID_A, createdAt: t('2026-01-01T00:00:00Z'), keyed: false },
    ]);
    // A keyed note stays on the raw page, flagged, so the cursor can pass it.
    await store.ensureListed(ID_A, KEK, keygenFrom(2));
    expect(
      (await store.listCandidates(null, 10)).map((row) => [row.id, row.keyed] as const),
    ).toEqual([
      [ID_A, true],
      [ID_B, false],
      [ID_C, false],
      ['dddddddd-dddd-4ddd-8ddd-dddddddddddd', false],
    ]);
  });

  it('bounds the raw candidate page before the key check', async () => {
    const ids = Array.from(
      { length: 26 },
      (_, index) => `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
    );
    const rows = ids.map((id, index) =>
      shopRow(id, { createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)) }),
    );
    const { store } = setup(rows);
    for (const id of ids.slice(0, 25)) await store.ensureListed(id, KEK);
    const first = await store.listCandidates(null, 20);
    expect(first).toHaveLength(20);
    expect(first.every((row) => row.keyed)).toBe(true);
    const second = await store.listCandidates(first[19]!, 20);
    expect(second.map((row) => [row.id, row.keyed] as const)).toEqual([
      ...ids.slice(20, 25).map((id) => [id, true] as const),
      [ids[25], false],
    ]);
  });

  it('lists at most the limit for the operator dump in key order', async () => {
    const { store, clock } = setup([shopRow(ID_C), shopRow(ID_B), shopRow(ID_A)]);
    await store.ensureListed(ID_C, KEK, keygenFrom(4));
    clock.now += 1;
    await store.ensureListed(ID_B, KEK, keygenFrom(3));
    await store.ensureListed(ID_A, KEK, keygenFrom(2));
    expect((await store.listDebug(2)).map((row) => row.messageId)).toEqual([ID_C, ID_A]);
    expect(await store.listDebug(10)).toHaveLength(3);
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

describe('InMemoryShopIdentityStore listDirectory', () => {
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

  async function keyed(
    store: InMemoryShopIdentityStore,
    id: string,
    secretN: number,
  ): Promise<void> {
    await store.ensureListed(id, KEK, keygenFrom(secretN));
  }

  it('returns a keyed listed shop and omits every note that is not one', async () => {
    const newer = new Date('2026-10-03T00:00:00.000Z');
    const same = new Date('2026-10-02T00:00:00.000Z');
    const older = new Date('2026-10-01T00:00:00.000Z');
    const rows = [
      shopRow(ID_C, { createdAt: newer }),
      shopRow(ID_B, { createdAt: same }),
      shopRow(ID_A, { createdAt: same }),
      shopRow(directoryId(4), { createdAt: older, text: 'No tag in this text at all here.' }),
      shopRow(directoryId(5), { createdAt: older, place: null }),
      shopRow(directoryId(6), { createdAt: older, parentId: ID_A }),
      shopRow(directoryId(7), { createdAt: older, deletedAt: older }),
      shopRow(directoryId(8), { createdAt: older, shopAccount: null }),
      shopRow(directoryId(9), { createdAt: older }),
    ];
    const { messages, store } = setup(rows);
    await keyed(store, ID_C, 4);
    await keyed(store, ID_B, 3);
    await keyed(store, ID_A, 2);
    await keyed(store, directoryId(9), 5);
    expect(await messages.setPlace(directoryId(9), { ...PLACE, label: '' })).toBe(true);
    const page = await store.listDirectory(null, 10);
    expect(page.next).toBeNull();
    expect(page.shops.map((shop) => shop.id)).toEqual([ID_C, ID_B, ID_A, directoryId(9)]);
    expect(page.shops[0]).toMatchObject({
      npub: shopNpub({ nostrPubkey: publicKeyHexFromSecret(secret(4)) }),
      name: 'Coffee Lab',
      place: PLACE,
    });
    const olderPage = await store.listDirectory({ createdAt: same, id: ID_B }, 10);
    expect(olderPage.shops.map((shop) => shop.id)).toEqual([ID_A, directoryId(9)]);
    expect(olderPage.next).toBeNull();
  });

  it('orders the same timestamp by id descending when the lower id is stored first', async () => {
    const same = new Date('2026-10-02T00:00:00.000Z');
    const { store } = setup([
      shopRow(ID_A, { createdAt: same }),
      shopRow(ID_B, { createdAt: same }),
    ]);
    await keyed(store, ID_A, 2);
    await keyed(store, ID_B, 3);
    expect((await store.listDirectory(null, 10)).shops.map((shop) => shop.id)).toEqual([
      ID_B,
      ID_A,
    ]);
  });

  it('stops in the middle of a short structural page and continues after that shop', async () => {
    const { store } = setup([
      shopRow(ID_B, { createdAt: new Date('2026-10-02T00:00:00.000Z') }),
      shopRow(ID_A, { createdAt: new Date('2026-10-01T00:00:00.000Z') }),
    ]);
    await keyed(store, ID_B, 3);
    const first = await store.listDirectory(null, 1);
    expect(first.shops.map((shop) => shop.id)).toEqual([ID_B]);
    expect(first.next).toEqual({ createdAt: new Date('2026-10-02T00:00:00.000Z'), id: ID_B });
    const second = await store.listDirectory(first.next, 1);
    expect(second).toEqual({ shops: [], next: null });
  });

  it('omits next when the only structural page is shorter than the cap and full of shops', async () => {
    const { store } = setup([shopRow(ID_A)]);
    await keyed(store, ID_A, 2);
    const page = await store.listDirectory(null, 1);
    expect(page.shops).toHaveLength(1);
    expect(page.next).toBeNull();
    expect(await store.listDirectory(null, 10)).toMatchObject({ next: null });
  });

  it('returns nothing for an empty directory', async () => {
    const { store } = setup([]);
    expect(await store.listDirectory(null, 20)).toEqual({ shops: [], next: null });
  });

  it('lists a keyed shop whose pin has no label and one with no pin', async () => {
    const labeled = directoryId(8);
    const blank = directoryId(9);
    const unpinned = directoryId(7);
    const { messages, store } = setup([
      shopRow(labeled, {
        place: { lat: 14.6, lng: 120.9, label: 'Stall', address: null },
      }),
      shopRow(blank),
      shopRow(unpinned, { place: null }),
    ]);
    await keyed(store, labeled, 2);
    await keyed(store, blank, 3);
    await keyed(store, unpinned, 4);
    expect(await messages.setPlace(blank, { ...PLACE, label: '' })).toBe(true);
    const page = await store.listDirectory(null, 10);
    expect(page.shops.map((shop) => shop.id)).toEqual([blank, labeled, unpinned]);
    expect(page.shops[0]).toMatchObject({
      name: 'Fresh coffee roasted here every morning.',
      place: { ...PLACE, label: '' },
    });
    expect(page.shops[1]).toMatchObject({
      name: 'Stall',
      place: { lat: 14.6, lng: 120.9, label: 'Stall', address: null },
    });
    expect(page.shops[2]).toMatchObject({
      name: 'Fresh coffee roasted here every morning.',
      place: null,
    });
  });

  it('continues past more than 20 * limit shaped notes that have no key', async () => {
    const good = directoryId(1);
    const keyless = Array.from({ length: 21 }, (_, index) => directoryId(index + 2));
    const rows = [
      shopRow(good, { createdAt: new Date('2026-10-01T00:00:00.000Z') }),
      ...keyless.map((id, index) =>
        shopRow(id, { createdAt: new Date(Date.UTC(2026, 9, 2, 0, index)) }),
      ),
    ];
    const { store } = setup(rows);
    await keyed(store, good, 1);
    const first = await store.listDirectory(null, 1);
    expect(first.shops).toEqual([]);
    expect(first.next?.id).toBe(directoryId(3));
    const second = await store.listDirectory(first.next, 1);
    expect(second.shops.map((shop) => shop.id)).toEqual([good]);
    expect(second.next).toBeNull();
  });

  it('does not examine a note that fails the structural shape', async () => {
    const messages = new InMemoryMessageStore([
      shopRow(ID_A),
      shopRow(ID_B),
      shopRow(ID_C),
      shopRow(directoryId(4)),
      shopRow(directoryId(5)),
      shopRow(directoryId(6)),
      shopRow(directoryId(7)),
      shopRow(directoryId(8)),
      shopRow(directoryId(9)),
      shopRow(directoryId(10)),
    ]);
    const noAccount = shopRow(directoryId(5));
    delete noAccount.shopAccount;
    const noPlace = shopRow(directoryId(7));
    delete noPlace.place;
    const shapes = new Map<string, MessageRow | undefined>([
      [ID_A, undefined],
      [ID_B, shopRow(ID_B, { parentId: ID_A })],
      [ID_C, shopRow(ID_C, { deletedAt: new Date('2026-10-01T00:00:00.000Z') })],
      [directoryId(4), shopRow(directoryId(4), { shopAccount: null })],
      [directoryId(5), noAccount],
      [directoryId(6), shopRow(directoryId(6), { place: null })],
      [directoryId(7), noPlace],
      [directoryId(8), shopRow(directoryId(8), { place: { ...PLACE, label: null } })],
      [directoryId(9), shopRow(directoryId(9), { place: { ...PLACE, address: null } })],
      [directoryId(10), shopRow(directoryId(10), { text: 'No tag in this text at all here.' })],
    ]);
    const wrapped = {
      listLiveAssignedShops: () => messages.listLiveAssignedShops(),
      getById: (id: string) => Promise.resolve(shapes.get(id)),
    } as unknown as MessageStore;
    const store = new InMemoryShopIdentityStore(wrapped);
    expect(await store.listDirectory(null, 10)).toEqual({ shops: [], next: null });
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
  it('queues a place change of any note with a key and a photo change only while public', async () => {
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

  it('queues a photo change of a public shop that is not listed', async () => {
    const { messages, store } = setup([
      shopRow(ID_A, {
        place: { lat: 47.3, lng: 8.5, label: 'Coffee Lab', address: null },
      }),
    ]);
    await store.ensureListed(ID_A, KEK, keygenFrom(2));
    const before = (await store.getByMessageId(ID_A))!.ocpPhotosGeneration;
    await messages.replacePhotos(ID_A, [PNG]);
    const row = (await store.getByMessageId(ID_A))!;
    expect(row.ocpPhotosPending).toBe(true);
    expect(row.ocpPhotosGeneration).toBe(before + 1);
  });

  it('treats a vanished note as a place change', async () => {
    const messages = new InMemoryMessageStore([shopRow(ID_A)]);
    let gone = false;
    const wrapped = {
      getById: (id: string) => (gone ? Promise.resolve(undefined) : messages.getById(id)),
      getPhotoSet: (id: string) => messages.getPhotoSet(id),
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
    expect(await store.queueAllPhotoPage(null, 2)).toEqual([ID_A, ID_B]);
    expect(await store.queueAllPhotoPage(ID_B, 2)).toEqual([ID_C]);
    expect((await store.getByMessageId(ID_A))?.ocpPhotosGeneration).toBe(2);
  });
});

describe('InMemoryShopIdentityStore photo fingerprint', () => {
  it('reads no photo bytes on its reads, with several shops that have photos', async () => {
    const base = new InMemoryMessageStore();
    for (const [n, id] of [ID_A, ID_B, ID_C].entries()) {
      await base.create(shopRow(id, { accountId: `author-${String(n)}` }), PNG, undefined, [JPEG]);
    }
    const reads: string[] = [];
    // The counting store is built before the identity store, so the identity
    // store's own reads go through it.
    const store = new InMemoryShopIdentityStore(countingBytes(base, reads));
    for (const [n, id] of [ID_A, ID_B, ID_C].entries()) {
      await store.ensureListed(id, KEK, keygenFrom(n + 2));
    }
    const first = (await store.getByMessageId(ID_A))!;
    expect(await store.getByPubkey(first.nostrPubkey)).toMatchObject({ messageId: ID_A });
    expect(await store.listAll()).toHaveLength(3);
    expect(await store.listRound(null, 2)).toHaveLength(2);
    expect(await store.listDebug(3)).toHaveLength(3);
    expect(reads).toEqual([]);
    // A photo change is still seen without a byte read and queues once.
    const before = first.ocpPhotosGeneration;
    await base.replacePhotos(ID_A, [JPEG]);
    expect((await store.getByPubkey(first.nostrPubkey))?.ocpPhotosGeneration).toBe(before + 1);
    expect((await store.listAll())[0]?.ocpPhotosGeneration).toBe(before + 1);
    expect(reads).toEqual([]);
  });

  it('queues nothing for a write that stores the same photos, and once for a change and its revert', async () => {
    const messages = new InMemoryMessageStore([shopRow(ID_A)]);
    await messages.replacePhotos(ID_A, [PNG]);
    const store = new InMemoryShopIdentityStore(messages);
    const generation = (await store.ensureListed(ID_A, KEK, keygenFrom(2)))!.ocpPhotosGeneration;
    await messages.replacePhotos(ID_A, [{ ...PNG, bytes: PNG.bytes.slice() }]);
    await messages.updatePhoto(ID_A, PNG);
    expect((await store.getByMessageId(ID_A))?.ocpPhotosGeneration).toBe(generation);
    // Two changes between two syncs queue once, as the triggers queue each
    // write: the revert does not cancel the change.
    await messages.replacePhotos(ID_A, [JPEG]);
    await messages.replacePhotos(ID_A, [PNG]);
    expect((await store.getByMessageId(ID_A))?.ocpPhotosGeneration).toBe(generation + 1);
  });

  it('hashes the photo set of a message store that is not the in-memory class', async () => {
    const messages = new InMemoryMessageStore([shopRow(ID_A)]);
    await messages.replacePhotos(ID_A, [PNG, JPEG]);
    const reads: string[] = [];
    const wrapped = {
      getById: (id: string) => messages.getById(id),
      getPhotoSet: (id: string) => {
        reads.push(id);
        return messages.getPhotoSet(id);
      },
    } as unknown as MessageStore;
    const store = new InMemoryShopIdentityStore(wrapped);
    const generation = (await store.ensureListed(ID_A, KEK, keygenFrom(2)))!.ocpPhotosGeneration;
    expect(reads.length).toBeGreaterThan(0);
    // The same bytes in a new write are no change; other bytes are.
    await messages.replacePhotos(ID_A, [PNG, JPEG]);
    expect((await store.getByMessageId(ID_A))?.ocpPhotosGeneration).toBe(generation);
    await messages.replacePhotos(ID_A, [JPEG]);
    expect((await store.getByMessageId(ID_A))?.ocpPhotosGeneration).toBe(generation + 1);
    await messages.replacePhotos(ID_A, []);
    expect((await store.getByMessageId(ID_A))?.ocpPhotosGeneration).toBe(generation + 2);
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

  it('claims the least recently claimed places first, so failing rows never starve later shops', async () => {
    const { store, clock } = setup([shopRow(ID_A), shopRow(ID_B), shopRow(ID_C)]);
    await store.ensureListed(ID_A, KEK, keygenFrom(2));
    await store.ensureListed(ID_B, KEK, keygenFrom(3));
    await store.ensureListed(ID_C, KEK, keygenFrom(4));
    const round = async (): Promise<string[]> =>
      (await store.claimPlaces(2, 60_000)).map((claim) => claim.messageId);
    // A and B are claimed and fail: they keep their claims until the lease ends.
    expect(await round()).toEqual([ID_A, ID_B]);
    clock.now += 60_000;
    // C, never claimed, goes before both; A and B share a lease end, so the id decides.
    expect(await round()).toEqual([ID_C, ID_A]);
    clock.now += 60_000;
    // B's lease ended a round before those of A and C.
    expect(await round()).toEqual([ID_B, ID_A]);
    clock.now += 60_000;
    expect(await round()).toEqual([ID_C, ID_A]);
    clock.now += 60_000;
    // B's lease ended first; its claim is released a second after the leases of A and C ended.
    const [released] = await store.claimPlaces(1, 60_000);
    expect(released?.messageId).toBe(ID_B);
    clock.now += 1_000;
    await store.release('place', released!);
    expect((await store.getByMessageId(ID_B))?.ocpPlaceClaimedUntil).toEqual(new Date(clock.now));
    // A released claim counts as a lease that ended at the release: A and C, whose
    // leases ended earlier, go first.
    expect(await round()).toEqual([ID_A, ID_C]);
    expect(await round()).toEqual([ID_B]);
  });

  it('still claims the other places when one is released on every pass', async () => {
    const { store, clock } = setup([shopRow(ID_A), shopRow(ID_B)]);
    await store.ensureListed(ID_A, KEK, keygenFrom(2));
    await store.ensureListed(ID_B, KEK, keygenFrom(3));
    const claimed: string[] = [];
    for (let pass = 0; pass < 6; pass += 1) {
      const [claim] = await store.claimPlaces(1, 60_000);
      claimed.push(claim!.messageId);
      // A gets 409 Stale revision on every pass and is released; B fails and keeps its lease.
      if (claim!.messageId === ID_A) await store.release('place', claim!);
      clock.now += 25_000;
    }
    // Pass 2: B, never claimed, goes before the released A. B's lease runs to 85 s, so A goes on
    // passes 3 and 4; on pass 5 (100 s) A's release at 75 s ended before B's lease, on pass 6
    // (125 s) B's lease ended before A's release at 100 s. A null release would give A every pass.
    expect(claimed).toEqual([ID_A, ID_B, ID_A, ID_A, ID_A, ID_B]);
  });

  it('claims the least recently claimed photo set first, so failing sets never starve later shops', async () => {
    const { store, clock } = setup([shopRow(ID_A), shopRow(ID_B), shopRow(ID_C)]);
    await store.ensureListed(ID_A, KEK, keygenFrom(2));
    await store.ensureListed(ID_B, KEK, keygenFrom(3));
    await store.ensureListed(ID_C, KEK, keygenFrom(4));
    for (const claim of await store.claimPlaces(20, 60_000)) {
      await store.nextRevision('place', claim);
      await store.finishPlace(claim, 'put');
    }
    const next = async (): Promise<string | undefined> =>
      (await store.claimPhoto(60_000))?.messageId;
    // A is claimed and fails: it keeps its claim until the lease ends.
    expect(await next()).toBe(ID_A);
    clock.now += 60_000;
    // B and C, never claimed, go before A although A's lease has ended.
    expect(await next()).toBe(ID_B);
    clock.now += 1_000;
    expect(await next()).toBe(ID_C);
    clock.now += 1_000;
    expect(await next()).toBe(ID_A);
    expect(await next()).toBeUndefined();
    clock.now += 60_000;
    // Every lease has ended: the earliest lease end goes first.
    expect(await next()).toBe(ID_B);
    expect(await next()).toBe(ID_C);
    expect(await next()).toBe(ID_A);
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
    // A released lease ends now: the claim still matches but has no time left.
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
    expect(await store.nextRevision('place', claim)).toBe(1);
    await store.finishPlace(claim, 'put');
    const photo = (await store.claimPhoto(60_000))!;
    expect(
      await store.nextRevision('photos', { ...photo, generation: photo.generation + 1 }),
    ).toBeUndefined();
    expect(await store.nextRevision('photos', photo)).toBe(2);
    // A hide after the claim queues the place: no further photo revision.
    await messages.markDeleted(ID_A, new Date(), 'staff');
    expect(await store.nextRevision('photos', photo)).toBeUndefined();
    expect((await store.getByMessageId(ID_A))?.ocpRevision).toBe(2);
    // The place lane still gets its revision.
    const [place] = await store.claimPlaces(1, 60_000);
    expect(await store.nextRevision('place', place!)).toBe(3);
  });

  it('releases only with the matching token, for either lane, ending the lease now', async () => {
    const { store, clock, claim } = await claimed();
    await store.release('place', { ...claim, claim: 9 });
    expect((await store.getByMessageId(ID_A))?.ocpPlaceClaimedUntil).toEqual(
      new Date(clock.now + 60_000),
    );
    clock.now += 1_000;
    await store.release('place', claim);
    expect((await store.getByMessageId(ID_A))?.ocpPlaceClaimedUntil).toEqual(new Date(clock.now));
    const confirmed = (await store.claimPlaces(1, 60_000))[0]!;
    await store.nextRevision('place', confirmed);
    await store.finishPlace(confirmed, 'put');
    const photo = (await store.claimPhoto(60_000))!;
    clock.now += 1_000;
    await store.release('photos', photo);
    expect((await store.getByMessageId(ID_A))?.ocpPhotosClaimedUntil).toEqual(new Date(clock.now));
  });

  it('records each place result', async () => {
    const { messages, store, clock, claim } = await claimed();
    await store.finishPlace({ ...claim, claim: 9 }, 'put');
    expect((await store.getByMessageId(ID_A))?.ocpPlacePending).toBe(true);
    await store.finishPlace(claim, 'put');
    let row = (await store.getByMessageId(ID_A))!;
    // Every end of a claim stores its time as the lease end, also a settle.
    expect(row).toMatchObject({
      ocpPlacePending: false,
      ocpPlaceClaimedUntil: new Date(clock.now),
      ocpPhotosPending: true,
      ocpPhotosGeneration: 2,
    });

    await messages.updateText(ID_A, `${TEXT} Change one.`);
    const second = (await store.claimPlaces(1, 60_000))[0]!;
    await messages.updateText(ID_A, `${TEXT} Change two.`);
    await store.finishPlace(second, 'put');
    row = (await store.getByMessageId(ID_A))!;
    // A newer change keeps the place pending; the lease ends now as well.
    expect(row).toMatchObject({
      ocpPlacePending: true,
      ocpPlaceClaimedUntil: new Date(clock.now),
      ocpPhotosGeneration: 2,
    });

    const third = (await store.claimPlaces(1, 60_000))[0]!;
    await messages.updateText(ID_A, `${TEXT} Change three.`);
    await store.finishPlace(third, 'created');
    row = (await store.getByMessageId(ID_A))!;
    expect(row).toMatchObject({
      ocpPlacePending: true,
      ocpPhotosHash: null,
      ocpPhotosPending: true,
      ocpPhotosGeneration: 3,
    });

    const fourth = (await store.claimPlaces(1, 60_000))[0]!;
    await store.finishPlace(fourth, 'created');
    expect((await store.getByMessageId(ID_A))?.ocpPhotosGeneration).toBe(4);

    await messages.updateText(ID_A, `${TEXT} Change four.`);
    await store.finishPlace((await store.claimPlaces(1, 60_000))[0]!, 'delete');
    row = (await store.getByMessageId(ID_A))!;
    expect(row).toMatchObject({ ocpPlacePending: false, ocpPhotosGeneration: 4 });

    await messages.updateText(ID_A, `${TEXT} Change five.`);
    await store.finishPlace((await store.claimPlaces(1, 60_000))[0]!, 'reject');
    expect((await store.getByMessageId(ID_A))?.ocpPlacePending).toBe(false);
  });

  it('resets the photo outbox before a delete under the place token', async () => {
    const { store, claim } = await claimed();
    await store.resetPhotosForDelete({ ...claim, claim: 9 });
    expect((await store.getByMessageId(ID_A))?.ocpPhotosGeneration).toBe(1);
    await store.resetPhotosForDelete(claim);
    expect(await store.getByMessageId(ID_A)).toMatchObject({
      ocpPhotosHash: null,
      ocpPhotosPending: false,
      ocpPhotosGeneration: 2,
    });
  });

  it('claims photos at revision 0 once the place is not pending', async () => {
    const { store, claim } = await claimed();
    expect(await store.claimPhoto(60_000)).toBeUndefined();
    await store.finishPlace(claim, 'put');
    expect(await store.claimPhoto(60_000)).toEqual({ messageId: ID_A, generation: 2, claim: 1 });
    expect((await store.getByMessageId(ID_A))?.ocpRevision).toBe(0);
    expect((await store.getByMessageId(ID_A))?.ocpPhotosPending).toBe(true);
  });

  it('claims one photo set whose place is confirmed', async () => {
    const { store, clock, claim } = await claimed();
    expect(await store.claimPhoto(60_000)).toBeUndefined();
    await store.nextRevision('place', claim);
    await store.finishPlace(claim, 'put');
    const photo = await store.claimPhoto(60_000);
    expect(photo).toEqual({ messageId: ID_A, generation: 2, claim: 1 });
    expect(await store.leaseHasTime('photos', photo!, 60_000)).toBe(true);
    expect(await store.leaseHasTime('photos', photo!, 60_001)).toBe(false);
    expect(await store.claimPhoto(60_000)).toBeUndefined();
    clock.now += 60_000;
    expect((await store.claimPhoto(60_000))?.claim).toBe(2);
  });

  it('settles a photo claim by generation', async () => {
    const { messages, store, clock, claim } = await claimed();
    await store.nextRevision('place', claim);
    await store.finishPlace(claim, 'put');
    let photo = (await store.claimPhoto(60_000))!;
    await store.clearPhotoHash({ ...photo, claim: 9 });
    await store.clearPhotoWithoutSend({ ...photo, claim: 9 });
    await store.finishPhotos({ ...photo, claim: 9 }, 'h');
    await store.missingPhotoPlace({ ...photo, claim: 9 }, true);
    expect((await store.getByMessageId(ID_A))?.ocpPhotosPending).toBe(true);

    await store.clearPhotoWithoutSend(photo);
    expect(await store.getByMessageId(ID_A)).toMatchObject({
      ocpPhotosPending: false,
      ocpPhotosClaimedUntil: new Date(clock.now),
    });

    // A newer photo change keeps the set pending; every result ends the lease now.
    await messages.replacePhotos(ID_A, [PNG]);
    photo = (await store.claimPhoto(60_000))!;
    await messages.replacePhotos(ID_A, [JPEG]);
    await store.clearPhotoWithoutSend(photo);
    expect(await store.getByMessageId(ID_A)).toMatchObject({
      ocpPhotosPending: true,
      ocpPhotosClaimedUntil: new Date(clock.now),
    });

    photo = (await store.claimPhoto(60_000))!;
    await store.finishPhotos(photo, 'hash-1');
    expect(await store.getByMessageId(ID_A)).toMatchObject({
      ocpPhotosHash: 'hash-1',
      ocpPhotosPending: false,
      ocpPhotosClaimedUntil: new Date(clock.now),
    });

    await messages.replacePhotos(ID_A, [PNG]);
    photo = (await store.claimPhoto(60_000))!;
    await store.clearPhotoHash(photo);
    await messages.replacePhotos(ID_A, [JPEG, PNG]);
    await store.finishPhotos(photo, 'hash-2');
    expect(await store.getByMessageId(ID_A)).toMatchObject({
      ocpPhotosHash: null,
      ocpPhotosPending: true,
      ocpPhotosClaimedUntil: new Date(clock.now),
    });

    photo = (await store.claimPhoto(60_000))!;
    await store.missingPhotoPlace(photo, false);
    expect(await store.getByMessageId(ID_A)).toMatchObject({
      ocpPhotosPending: false,
      ocpPhotosClaimedUntil: new Date(clock.now),
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
      ocpPhotosClaimedUntil: new Date(clock.now),
    });
  });

  it('puts a photo set changed during its claim behind the other pending sets', async () => {
    const { messages, store } = setup([shopRow(ID_A, { hasPhoto: true }), shopRow(ID_B)]);
    await store.ensureListed(ID_A, KEK, keygenFrom(2));
    await store.ensureListed(ID_B, KEK, keygenFrom(3));
    for (const claim of await store.claimPlaces(20, 60_000)) {
      await store.nextRevision('place', claim);
      await store.finishPlace(claim, 'put');
    }
    const photo = (await store.claimPhoto(60_000))!;
    expect(photo.messageId).toBe(ID_A);
    // The shop changes its photos while the set is sent.
    await messages.replacePhotos(ID_A, [JPEG]);
    await store.finishPhotos(photo, 'hash');
    expect((await store.getByMessageId(ID_A))?.ocpPhotosPending).toBe(true);
    // B, never claimed, goes first; a null lease would give A the lane again.
    expect((await store.claimPhoto(60_000))?.messageId).toBe(ID_B);
    expect((await store.claimPhoto(60_000))?.messageId).toBe(ID_A);
  });

  it('puts a place changed during its claim behind the other pending places', async () => {
    const { messages, store } = setup([shopRow(ID_A), shopRow(ID_B)]);
    await store.ensureListed(ID_A, KEK, keygenFrom(2));
    await store.ensureListed(ID_B, KEK, keygenFrom(3));
    const [place] = await store.claimPlaces(1, 60_000);
    expect(place?.messageId).toBe(ID_A);
    // The note changes while the place is sent.
    await messages.updateText(ID_A, `${TEXT} Changed.`);
    await store.finishPlace(place!, 'put');
    expect((await store.getByMessageId(ID_A))?.ocpPlacePending).toBe(true);
    // B, never claimed, goes first; a null lease would give A the batch slot again.
    expect((await store.claimPlaces(1, 60_000)).map((claim) => claim.messageId)).toEqual([ID_B]);
    expect((await store.claimPlaces(1, 60_000)).map((claim) => claim.messageId)).toEqual([ID_A]);
  });

  it('puts a photo set changed after its settle behind a set never claimed', async () => {
    const { messages, store } = setup([shopRow(ID_A, { hasPhoto: true }), shopRow(ID_B)]);
    await store.ensureListed(ID_A, KEK, keygenFrom(2));
    await store.ensureListed(ID_B, KEK, keygenFrom(3));
    for (const claim of await store.claimPlaces(20, 60_000)) {
      await store.nextRevision('place', claim);
      await store.finishPlace(claim, 'put');
    }
    const photo = (await store.claimPhoto(60_000))!;
    expect(photo.messageId).toBe(ID_A);
    await store.finishPhotos(photo, 'hash');
    expect((await store.getByMessageId(ID_A))?.ocpPhotosPending).toBe(false);
    // The shop changes its photos right after the settle: the queue write
    // keeps the lease end, so B goes first; a null lease would give A the lane.
    await messages.replacePhotos(ID_A, [JPEG]);
    expect((await store.getByMessageId(ID_A))?.ocpPhotosPending).toBe(true);
    expect((await store.claimPhoto(60_000))?.messageId).toBe(ID_B);
    expect((await store.claimPhoto(60_000))?.messageId).toBe(ID_A);
  });

  it('puts a place changed after its settle behind a place never claimed', async () => {
    const { messages, store } = setup([shopRow(ID_A), shopRow(ID_B)]);
    await store.ensureListed(ID_A, KEK, keygenFrom(2));
    await store.ensureListed(ID_B, KEK, keygenFrom(3));
    const [place] = await store.claimPlaces(1, 60_000);
    expect(place?.messageId).toBe(ID_A);
    await store.finishPlace(place!, 'put');
    expect((await store.getByMessageId(ID_A))?.ocpPlacePending).toBe(false);
    await messages.updateText(ID_A, `${TEXT} Changed.`);
    expect((await store.getByMessageId(ID_A))?.ocpPlacePending).toBe(true);
    expect((await store.claimPlaces(1, 60_000)).map((claim) => claim.messageId)).toEqual([ID_B]);
    expect((await store.claimPlaces(1, 60_000)).map((claim) => claim.messageId)).toEqual([ID_A]);
  });

  it('defers photos: keeps the photo state and holds the queued place until the photo lease ends', async () => {
    const { store, clock, claim } = await claimed();
    await store.nextRevision('place', claim);
    await store.finishPlace(claim, 'put');
    const photo = (await store.claimPhoto(60_000))!;
    const photoUntil = new Date(clock.now + 60_000);
    await store.deferPhotos({ ...photo, claim: 9 }, true);
    await store.deferPhotos(photo, false);
    // The settled place keeps the lease end of its finish.
    expect(await store.getByMessageId(ID_A)).toMatchObject({
      ocpPlacePending: false,
      ocpPlaceClaimedUntil: new Date(clock.now),
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

    await store.release('place', place);
    clock.now += 1_000;
    await store.release('photos', photo);
    await store.deferPhotos(photo, true);
    // A released lease ends at the release: the place lease is lifted to the later photo release.
    expect(await store.getByMessageId(ID_A)).toMatchObject({
      ocpPlacePending: true,
      ocpPlaceClaimedUntil: new Date(clock.now),
      ocpPhotosClaimedUntil: new Date(clock.now),
    });

    // A settled photo claim ends its lease at the settle: a later end lifts the place lease too.
    clock.now += 1_000;
    await store.clearPhotoWithoutSend(photo);
    await store.deferPhotos(photo, true);
    expect(await store.getByMessageId(ID_A)).toMatchObject({
      ocpPlaceClaimedUntil: new Date(clock.now),
      ocpPhotosClaimedUntil: new Date(clock.now),
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

  it('reads at most the limit for the operator dump', async () => {
    const { sql, calls } = fakeSql([[sqlIdentity()]]);
    const store = new PostgresShopIdentityStore(sql, messages);
    expect((await store.listDebug(200)).map((row) => row.messageId)).toEqual([ID_A]);
    expect(calls[0]?.params).toEqual([200]);
    expect(calls[0]?.text).toContain('ORDER BY nostr_key_created_at ASC, message_id ASC');
    expect(calls[0]?.text).toContain('LIMIT $1');
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
    expect(calls[0]?.params).toEqual([20]);
    expect(calls[0]?.text).not.toContain('WHERE');
    expect(calls[0]?.text).toContain('ORDER BY nostr_key_created_at ASC, message_id ASC');
    expect(calls[0]?.text).toContain('LIMIT $1');
    const cursor = { createdAt: new Date('2026-10-01T00:00:00Z'), messageId: ID_A };
    // A full page after the cursor: no second read.
    expect(ids(await store.listRound(cursor, 2))).toEqual([ID_A, ID_B]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.params).toEqual([cursor.createdAt, ID_A, 2]);
    // Only the row comparison, so the cursor is always an index condition.
    expect(calls[1]?.text).toContain(
      'WHERE (nostr_key_created_at, message_id) > ($1::timestamptz, $2::uuid)',
    );
    expect(calls[1]?.text).not.toContain('IS NULL');
    expect(calls[1]?.text).toContain('LIMIT $3');
    // A short page: the second read takes only the rest of the limit.
    expect(ids(await store.listRound(cursor, 2))).toEqual([ID_C, ID_A]);
    expect(calls).toHaveLength(4);
    expect(calls[3]?.text).toContain(
      '(nostr_key_created_at, message_id) <= ($1::timestamptz, $2::uuid)',
    );
    expect(calls[3]?.text).toContain('LIMIT $3');
    expect(calls[3]?.params).toEqual([cursor.createdAt, ID_A, 1]);
  });

  it('does not mint a key that must be adopted', async () => {
    const adoptedMessages = new InMemoryMessageStore([shopRow(ADOPTED_ID)]);
    const { sql, calls } = fakeSql([[]]);
    const store = new PostgresShopIdentityStore(sql, adoptedMessages);
    expect(await store.ensureListed(ADOPTED_ID, KEK, keygenFrom(2))).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain('WHERE message_id = $1');
    expect(calls[0]?.text).not.toContain('INSERT');
  });

  it('inserts an adopted secret without queueing the place', async () => {
    const { sql, calls } = fakeSql([
      [],
      [],
      [
        sqlIdentity({
          ocp_place_pending: false,
          ocp_place_generation: 0,
          ocp_photos_pending: true,
          ocp_photos_generation: 1,
        }),
      ],
    ]);
    const store = new PostgresShopIdentityStore(sql, messages);
    const created = await store.adoptKnownSecret(ID_A, secret(2), KEK);
    expect(created?.ocpPlacePending).toBe(false);
    expect(created?.ocpPlaceGeneration).toBe(0);
    expect(calls[2]?.text).toContain('VALUES ($1, $2, $3, $4, $5, $6, $7, false, 0, true, 1)');
    expect(created?.ocpPhotosPending).toBe(true);
    expect(created?.ocpPhotosGeneration).toBe(1);
    expect(calls[2]?.text).toContain('ON CONFLICT (message_id) DO NOTHING');
    expect(calls[2]?.params[1]).toBe(publicKeyHexFromSecret(secret(2)));
    const plain = await decryptNostrSecret(calls[2]?.params[2] as Uint8Array, KEK, `shop:${ID_A}`);
    expect([...plain]).toEqual([...secret(2)]);
    expect(calls[2]?.params[6]).toBe('Coffee Lab');
  });

  it('inserts an adopted secret of a note that is not a public shop without queueing photos', async () => {
    const { sql, calls } = fakeSql([
      [],
      [],
      [
        sqlIdentity({
          message_id: ID_B,
          ocp_place_pending: false,
          ocp_place_generation: 0,
          ocp_photos_pending: false,
          ocp_photos_generation: 0,
        }),
      ],
    ]);
    const store = new PostgresShopIdentityStore(sql, messages);
    const created = await store.adoptKnownSecret(ID_B, secret(2), KEK);
    expect(created.ocpPlacePending).toBe(false);
    expect(created.ocpPlaceGeneration).toBe(0);
    expect(created.ocpPhotosPending).toBe(false);
    expect(created.ocpPhotosGeneration).toBe(0);
    expect(calls[2]?.text).toContain('VALUES ($1, $2, $3, $4, $5, $6, $7, false, 0, false, 0)');
  });

  it('returns the stored row when the adopted key is already there', async () => {
    const { sql, calls } = fakeSql([[sqlIdentity()]]);
    const store = new PostgresShopIdentityStore(sql, messages);
    expect((await store.adoptKnownSecret(ID_A, secret(2), KEK)).nostrPubkey).toBe(
      publicKeyHexFromSecret(secret(2)),
    );
    expect(calls).toHaveLength(1);
  });

  it('refuses a different stored key, a key held by another note, and a lost insert', async () => {
    const other = 'ab'.repeat(32);
    const held = fakeSql([[], [sqlIdentity({ message_id: ID_B })]]);
    const heldStore = new PostgresShopIdentityStore(held.sql, messages);
    await expect(heldStore.adoptKnownSecret(ID_A, secret(2), KEK)).rejects.toThrow(
      'shop nostr pubkey already exists',
    );
    const different = fakeSql([[sqlIdentity({ nostr_pubkey: other })]]);
    await expect(
      new PostgresShopIdentityStore(different.sql, messages).adoptKnownSecret(ID_A, secret(2), KEK),
    ).rejects.toThrow('shop nostr pubkey already exists');
    const lostSame = fakeSql([[], [], [], [sqlIdentity()]]);
    expect(
      (
        await new PostgresShopIdentityStore(lostSame.sql, messages).adoptKnownSecret(
          ID_A,
          secret(2),
          KEK,
        )
      ).nostrPubkey,
    ).toBe(publicKeyHexFromSecret(secret(2)));
    const lostDifferent = fakeSql([[], [], [], [sqlIdentity({ nostr_pubkey: other })]]);
    await expect(
      new PostgresShopIdentityStore(lostDifferent.sql, messages).adoptKnownSecret(
        ID_A,
        secret(2),
        KEK,
      ),
    ).rejects.toThrow('shop nostr pubkey already exists');
    const lostMissing = fakeSql([[], [], [], []]);
    await expect(
      new PostgresShopIdentityStore(lostMissing.sql, messages).adoptKnownSecret(
        ID_A,
        secret(2),
        KEK,
      ),
    ).rejects.toThrow('shop note not found');
  });

  it('refuses an adopted key when the note or the secret is unusable', async () => {
    const { sql, calls } = fakeSql([]);
    const store = new PostgresShopIdentityStore(sql, messages);
    await expect(store.adoptKnownSecret(ID_C, secret(2), KEK)).rejects.toThrow(
      'shop note not found',
    );
    await expect(store.adoptKnownSecret(ID_A, secret(2).slice(0, 16), KEK)).rejects.toThrow(
      '32 bytes',
    );
    expect(calls).toHaveLength(0);
  });

  it('inserts a new key with a locked, unchanged note and queues its place', async () => {
    const { sql, calls } = fakeSql([[], [sqlIdentity()]]);
    const store = new PostgresShopIdentityStore(sql, messages);
    const created = await store.ensureListed(ID_A, KEK, keygenFrom(2));
    expect(created?.messageId).toBe(ID_A);
    const insert = calls[1]!;
    expect(insert.text).toContain('FOR UPDATE');
    expect(insert.text).toContain('ON CONFLICT (message_id) DO NOTHING');
    expect(insert.text).toContain(
      'SELECT $1, $11, $12, $13, $14, $15, $16, true, 1, true, 1 FROM locked',
    );
    expect(insert.params[0]).toBe(ID_A);
    expect(insert.params.slice(1, 10)).toEqual(SNAPSHOT);
    expect(insert.params[10]).toBe(publicKeyHexFromSecret(secret(2)));
    expect(insert.params.slice(12, 15)).toEqual([1, 'custodial', expect.any(Date)]);
    expect(insert.params[15]).toBe('Coffee Lab');
    const plain = await decryptNostrSecret(insert.params[11] as Uint8Array, KEK, `shop:${ID_A}`);
    expect([...plain]).toEqual([...secret(2)]);
  });

  it('locks null place columns when a public shop has no pin or no label', async () => {
    const name = 'Fresh coffee roasted here every morning.';
    const unpinned = new InMemoryMessageStore([shopRow(ID_C, { place: null })]);
    const bare = fakeSql([[], [sqlIdentity({ message_id: ID_C, profile_name: name })]]);
    const bareStore = new PostgresShopIdentityStore(bare.sql, unpinned);
    expect((await bareStore.ensureListed(ID_C, KEK, keygenFrom(2)))?.profileName).toBe(name);
    expect(bare.calls[1]?.params.slice(1, 10)).toEqual([
      null,
      TEXT,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(bare.calls[1]?.params[15]).toBe(name);

    const unlabeled = new InMemoryMessageStore([
      shopRow(ID_C, { place: { lat: 47.3, lng: 8.5, label: null, address: null } }),
    ]);
    const pin = fakeSql([[], [sqlIdentity({ message_id: ID_C, profile_name: name })]]);
    const pinStore = new PostgresShopIdentityStore(pin.sql, unlabeled);
    expect((await pinStore.ensureListed(ID_C, KEK, keygenFrom(2)))?.messageId).toBe(ID_C);
    expect(pin.calls[1]?.params.slice(1, 10)).toEqual([
      null,
      TEXT,
      47.3,
      8.5,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(pin.calls[1]?.params[15]).toBe(name);
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
    expect(calls[1]?.text).toContain('UPDATE shop_identity SET profile_name = $11');
    expect(calls[1]?.text).toContain('FOR UPDATE');
    expect(calls[1]?.text).toContain('AND place_label IS NOT DISTINCT FROM $2');
    expect(calls[1]?.params).toEqual([ID_A, ...SNAPSHOT, 'Coffee Lab']);
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
        { id: ID_A, created_at: created, keyed: true },
        { id: ID_B, created_at: '2026-01-02T00:00:00.000Z', keyed: false },
      ],
      [],
    ]);
    const store = new PostgresShopIdentityStore(sql, messages);
    expect(await store.listCandidates(null, 20)).toEqual([
      { id: ID_A, createdAt: created, keyed: true },
      { id: ID_B, createdAt: new Date('2026-01-02T00:00:00Z'), keyed: false },
    ]);
    expect(calls[0]?.params).toEqual([20]);
    expect(calls[0]?.text).not.toContain('(m.created_at, m.id) >');
    expect(calls[0]?.text).toContain('LIMIT $1');
    // The key check is per returned row, after the LIMIT, not a filter.
    expect(calls[0]?.text).toContain(
      'EXISTS (SELECT 1 FROM shop_identity s WHERE s.message_id = m.id) AS keyed',
    );
    expect(calls[0]?.text).not.toContain('NOT EXISTS');
    expect(calls[0]?.text).toContain("m.text ~* '#21giftsshop([^a-z0-9_]|$)'");
    await store.listCandidates({ createdAt: created, id: ID_A }, 5);
    expect(calls[1]?.params).toEqual([created, ID_A, 5]);
    // Only the row comparison, so the cursor is always an index condition.
    expect(calls[1]?.text).toContain('AND (m.created_at, m.id) > ($1::timestamptz, $2::uuid)');
    expect(calls[1]?.text).not.toContain('$1::timestamptz IS NULL');
    expect(calls[1]?.text).toContain('LIMIT $3');
  });

  it('lists a directory page without joining shop_identity', async () => {
    const created = new Date('2026-10-03T00:00:00.000Z');
    const pubkey = publicKeyHexFromSecret(secret(2));
    const row = {
      id: ID_C,
      created_at: created,
      text: TEXT,
      parent_id: null,
      deleted_at: null,
      place_lat: '47.3',
      place_lng: 8.5,
      place_label: 'Coffee Lab',
      place_street: 'Main Street',
      place_house_number: '1',
      place_postal_code: '8001',
      place_city: 'Zürich',
      place_country: 'CH',
      shop_account_id: 'till',
      nostr_pubkey: pubkey,
    };
    const { sql, calls } = fakeSql([
      [
        row,
        { ...row, id: ID_B, deleted_at: '2026-10-02T00:00:00.000Z', nostr_pubkey: pubkey },
        { ...row, id: ID_A, nostr_pubkey: null },
      ],
      [],
    ]);
    const store = new PostgresShopIdentityStore(sql, messages);
    const page = await store.listDirectory(null, 2);
    expect(page.next).toBeNull();
    expect(page.shops).toEqual([
      {
        id: ID_C,
        createdAt: created,
        npub: shopNpub({ nostrPubkey: pubkey }),
        name: 'Coffee Lab',
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
      },
    ]);
    expect(calls[0]?.params).toEqual([40]);
    expect(calls[0]?.text).toContain('ORDER BY m.created_at DESC, m.id DESC');
    expect(calls[0]?.text).toContain('LIMIT $1');
    expect(calls[0]?.text).not.toContain('(m.created_at, m.id) <');
    expect(calls[0]?.text).toContain(
      '(SELECT s.nostr_pubkey FROM shop_identity s WHERE s.message_id = m.id) AS nostr_pubkey',
    );
    expect(calls[0]?.text).not.toContain('JOIN');
    expect(calls[0]?.text).not.toContain('nostr_nsec_ciphertext');
    const cursor = { createdAt: created, id: ID_C };
    expect(await store.listDirectory(cursor, 2)).toEqual({ shops: [], next: null });
    expect(calls[1]?.params).toEqual([created, ID_C, 40]);
    expect(calls[1]?.text).toContain('AND (m.created_at, m.id) < ($1::timestamptz, $2::uuid)');
    expect(calls[1]?.text).toContain('ORDER BY m.created_at DESC, m.id DESC');
    expect(calls[1]?.text).toContain('LIMIT $3');
    expect(calls[1]?.text).not.toContain('$1::timestamptz IS NULL');
    expect(calls[1]?.text).not.toContain('JOIN');
    expect(calls[1]?.text).not.toContain('nostr_nsec_ciphertext');
  });

  it('maps a directory row with no pin and rows whose address is incomplete', async () => {
    const created = new Date('2026-10-04T00:00:00.000Z');
    const pubkey = publicKeyHexFromSecret(secret(4));
    const full = {
      created_at: created,
      text: TEXT,
      parent_id: null,
      deleted_at: null,
      place_lat: '47.3',
      place_lng: 8.5,
      place_label: 'Coffee Lab',
      place_street: 'Main Street',
      place_house_number: '1',
      place_postal_code: '8001',
      place_city: 'Zürich',
      place_country: 'CH',
      shop_account_id: 'till',
      nostr_pubkey: pubkey,
    };
    const none = {
      place_lat: null,
      place_lng: null,
      place_label: null,
      place_street: null,
      place_house_number: null,
      place_postal_code: null,
      place_city: null,
      place_country: null,
    };
    const ids = [
      ID_A,
      ID_B,
      ID_C,
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      '11111111-1111-4111-8111-111111111111',
    ];
    const rows = [
      { ...full, ...none, id: ids[0] },
      { ...full, id: ids[1], place_lng: null },
      { ...full, id: ids[2], place_street: null },
      { ...full, id: ids[3], place_house_number: null },
      { ...full, id: ids[4], place_postal_code: null },
      { ...full, id: ids[5], place_city: null },
      { ...full, id: ids[6], place_country: null, place_label: null },
    ];
    const { sql } = fakeSql([rows]);
    const page = await new PostgresShopIdentityStore(sql, messages).listDirectory(null, 10);
    const description = 'Fresh coffee roasted here every morning.';
    const pin = { lat: 47.3, lng: 8.5, label: 'Coffee Lab', address: null };
    expect(page.next).toBeNull();
    expect(page.shops.map((shop) => shop.place)).toEqual([
      null,
      null,
      pin,
      pin,
      pin,
      pin,
      { lat: 47.3, lng: 8.5, label: '', address: null },
    ]);
    expect(page.shops.map((shop) => shop.name)).toEqual([
      description,
      description,
      'Coffee Lab',
      'Coffee Lab',
      'Coffee Lab',
      'Coffee Lab',
      description,
    ]);
  });

  it('queues a page of identities by message id', async () => {
    const { sql, calls } = fakeSql([[{ message_id: ID_B }, { message_id: ID_A }], []]);
    const store = new PostgresShopIdentityStore(sql, messages);
    expect(await store.queueAllPlacePage(null, 200)).toEqual([ID_A, ID_B]);
    expect(calls[0]?.params).toEqual([200]);
    expect(calls[0]?.text).not.toContain('WHERE message_id >');
    expect(calls[0]?.text).toContain('ocp_place_generation = s.ocp_place_generation + 1');
    expect(await store.queueAllPlacePage(ID_B, 200)).toEqual([]);
    expect(calls[1]?.params).toEqual([200, ID_B]);
    expect(calls[1]?.text).toContain('WHERE message_id > $2::uuid ORDER BY message_id LIMIT $1');
    expect(calls[1]?.text).not.toContain('IS NULL');
  });

  it('queues a photo page of identities by message id', async () => {
    const { sql, calls } = fakeSql([[{ message_id: ID_B }, { message_id: ID_A }], []]);
    const store = new PostgresShopIdentityStore(sql, messages);
    expect(await store.queueAllPhotoPage(null, 200)).toEqual([ID_A, ID_B]);
    expect(calls[0]?.params).toEqual([200]);
    expect(calls[0]?.text).toContain('ocp_photos_pending = true');
    expect(calls[0]?.text).toContain('ocp_photos_generation = s.ocp_photos_generation + 1');
    expect(calls[0]?.text).not.toContain('WHERE message_id >');
    expect(await store.queueAllPhotoPage(ID_B, 200)).toEqual([]);
    expect(calls[1]?.params).toEqual([200, ID_B]);
    expect(calls[1]?.text).toContain('WHERE message_id > $2::uuid ORDER BY message_id LIMIT $1');
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
    expect(calls[0]?.text).toContain(
      'ORDER BY ocp_place_claimed_until ASC NULLS FIRST, message_id',
    );
    expect(calls[0]?.params).toEqual([20, 60_000]);
    expect(await store.claimPhoto(60_000)).toEqual({ messageId: ID_A, generation: 3, claim: 5 });
    expect(calls[1]?.text).toContain('ocp_photos_pending');
    expect(calls[1]?.text).toContain('NOT ocp_place_pending');
    expect(calls[1]?.text).not.toContain('ocp_revision > 0');
    expect(calls[1]?.text).toContain(
      'ORDER BY ocp_photos_claimed_until ASC NULLS FIRST, message_id',
    );
    expect(calls[1]?.text).toContain('FOR UPDATE SKIP LOCKED');
    expect(await store.claimPhoto(60_000)).toBeUndefined();
  });

  it('checks the lease and raises the revision under the claim token', async () => {
    const { sql, calls } = fakeSql([[{ ok: 1 }], [], [{ ocp_revision: '7' }], []]);
    const store = new PostgresShopIdentityStore(sql, messages);
    const claim = { messageId: ID_A, generation: 1, claim: 2 };
    expect(await store.leaseHasTime('place', claim, 15_000)).toBe(true);
    expect(calls[0]?.text).toContain('ocp_place_claimed_until > now()');
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
    expect(calls[0]?.text).toContain('ocp_place_claimed_until = now()');
    expect(calls[1]?.text).toContain('ocp_photos_claimed_until = now()');
    expect(calls[2]?.text).toContain('ocp_place_claim = $2');
    // Every claim-ending write ends the lease now, also when the row settles.
    expect(calls[3]?.text).toContain('ocp_place_claimed_until = now()');
    for (const call of [calls[6], calls[8], calls[9]]) {
      expect(call?.text).toContain('ocp_photos_claimed_until = now()');
    }
    expect(calls[3]?.params).toEqual([ID_A, 6, 4, false, true]);
    expect(calls[4]?.params).toEqual([ID_A, 6, 4, true, false]);
    expect(calls[5]?.params).toEqual([ID_A, 6, 4, false, false]);
    expect(calls[6]?.params).toEqual([ID_A, 6, 4]);
    expect(calls[7]?.params).toEqual([ID_A, 6]);
    expect(calls[8]?.params).toEqual([ID_A, 6, 4, 'hash']);
    expect(calls[9]?.params).toEqual([ID_A, 6, 4, true]);
    expect(calls).toHaveLength(12);
    expect(calls[10]?.text).toContain('UPDATE shop_identity SET profile_name = $11');
    expect(calls[10]?.text).toContain('FOR UPDATE');
    expect(calls[10]?.params).toEqual([ID_A, ...SNAPSHOT, 'Coffee Lab']);
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
