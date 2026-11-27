import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@buildonspark/spark-sdk', () => ({
  SparkReadonlyClient: { createWithViewerKey: vi.fn(async () => ({})) },
  deriveViewerIdentityPublicKey: vi.fn(
    async () => new Uint8Array([2, ...Array<number>(32).fill(7)]),
  ),
}));

import * as aesGcm from '@/lib/aes-gcm-envelope';
import { envelopeKekId, openAesGcmEnvelope, sealAesGcmEnvelope } from '@/lib/aes-gcm-envelope';
import type { SqlClient } from '@/lib/auth/sql';
import { encryptRecoveryShare } from '@/lib/auth/recovery-share';
import { rotateKeks, type KekRotationConfig } from '@/lib/kek-rotation';
import { bindKekId } from '@/lib/nostr/kek';
import { decryptNostrSecret, encryptNostrSecret, publicKeyHexFromSecret } from '@/lib/nostr/keys';

const LOCK = 21_499_031;
const SHARE = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 'acid' : 'brave')).join(' ');

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** An envelope header under `kekId` followed by bytes no key opens. */
function opaqueEnvelope(kekId: number): Uint8Array {
  const bytes = new Uint8Array(65).fill(9);
  bytes[0] = 1;
  new DataView(bytes.buffer).setUint32(1, kekId, false);
  return bytes;
}

interface KeyRow {
  pubkey: string;
  ciphertext: Uint8Array | null;
  kekId: number;
  placePending?: boolean;
}

interface ShareRow {
  accountId: string;
  sparkPubkey: string;
  ciphertext: Uint8Array;
}

interface Db {
  accounts: Map<string, KeyRow>;
  shops: Map<string, KeyRow>;
  viewer: { publicKey: string; ciphertext: Uint8Array; kekId: number } | undefined;
  shares: ShareRow[];
}

interface Fake {
  sql: SqlClient;
  db: Db;
  statements: string[];
  locks: unknown[][];
  transactions: number;
  /** Runs right before the UPDATE of a row is applied (key: table:id). */
  beforeUpdate: Map<string, () => void>;
  /** Make the pending-share count answer no row. */
  emptyCount: boolean;
  /** Share page reads so far (read-only pass and write batches). */
  sharePages: number;
  /** Runs right before the n-th share page (1-based) is read. */
  beforeSharePage: Map<number, () => void>;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function idBytesOf(envelope: Uint8Array): Uint8Array {
  return envelope.slice(1, 5);
}

function clone(db: Db): Db {
  const copy = (rows: Map<string, KeyRow>): Map<string, KeyRow> =>
    new Map([...rows].map(([id, row]): [string, KeyRow] => [id, { ...row }]));
  return {
    accounts: copy(db.accounts),
    shops: copy(db.shops),
    viewer: db.viewer === undefined ? undefined : { ...db.viewer },
    shares: db.shares.map((row) => ({ ...row })),
  };
}

function fake(db: Db): Fake {
  const state: Fake = {
    sql: undefined as unknown as SqlClient,
    db,
    statements: [],
    locks: [],
    transactions: 0,
    beforeUpdate: new Map(),
    emptyCount: false,
    sharePages: 0,
    beforeSharePage: new Map(),
  };
  const hook = (key: string): void => {
    state.beforeUpdate.get(key)?.();
    state.beforeUpdate.delete(key);
  };
  const query = async <T>(text: string, params: readonly unknown[] = []): Promise<T[]> => {
    state.statements.push(text);
    const d = state.db;
    if (text.includes('pg_advisory_xact_lock')) {
      state.locks.push([...params]);
      return [];
    }
    if (text.startsWith('SELECT id::text AS account_id, nostr_nsec_ciphertext FROM account')) {
      const [current] = params as [number];
      return [...d.accounts]
        .filter(([, row]) => row.ciphertext !== null && row.kekId === current)
        .slice(0, 1)
        .map(([id, row]) => ({ account_id: id, nostr_nsec_ciphertext: row.ciphertext })) as T[];
    }
    if (
      text.startsWith(
        'SELECT message_id::text AS message_id, nostr_nsec_ciphertext FROM shop_identity',
      )
    ) {
      const [current] = params as [number];
      return [...d.shops]
        .filter(([, row]) => row.kekId === current)
        .slice(0, 1)
        .map(([id, row]) => ({ message_id: id, nostr_nsec_ciphertext: row.ciphertext })) as T[];
    }
    if (text.startsWith('SELECT viewer_mnemonic_ciphertext FROM spark_viewer_key')) {
      const [current] = params as [number];
      const viewer = d.viewer;
      if (viewer === undefined || viewer.kekId !== current) return [];
      return [{ viewer_mnemonic_ciphertext: viewer.ciphertext }] as T[];
    }
    if (
      text.startsWith(
        'SELECT account_id::text AS account_id, recovery_share_ciphertext FROM recovery_share',
      )
    ) {
      const [current] = params as [Uint8Array];
      return d.shares
        .filter((row) => sameBytes(idBytesOf(row.ciphertext), current))
        .slice(0, 1)
        .map((row) => ({
          account_id: row.accountId,
          recovery_share_ciphertext: row.ciphertext,
        })) as T[];
    }
    if (text.startsWith('SELECT id::text AS id, nostr_kek_id FROM account')) {
      const [current, after, limit] = params as [number, string | null, number];
      return [...d.accounts]
        .filter(([, row]) => row.ciphertext !== null && row.kekId !== current)
        .filter(([id]) => after === null || id > after)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .slice(0, limit)
        .map(([id, row]) => ({ id, nostr_kek_id: row.kekId })) as T[];
    }
    if (text.startsWith('UPDATE account')) {
      const [id, pubkey, ciphertext, kekId, previous] = params as [
        string,
        string,
        Uint8Array,
        number,
        number,
      ];
      hook(`account:${id}`);
      const row = d.accounts.get(id);
      if (row === undefined || row.kekId !== previous || row.ciphertext === null) return [];
      Object.assign(row, { pubkey, ciphertext, kekId });
      return [{ id }] as T[];
    }
    if (text.startsWith('SELECT message_id::text AS message_id, nostr_kek_id FROM shop_identity')) {
      const [current, after, limit] = params as [number, string | null, number];
      return [...d.shops]
        .filter(([, row]) => row.kekId !== current)
        .filter(([id]) => after === null || id > after)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .slice(0, limit)
        .map(([id, row]) => ({ message_id: id, nostr_kek_id: row.kekId })) as T[];
    }
    if (text.startsWith('UPDATE shop_identity')) {
      const [id, pubkey, ciphertext, kekId, previous] = params as [
        string,
        string,
        Uint8Array,
        number,
        number,
      ];
      hook(`shop:${id}`);
      const row = d.shops.get(id);
      if (row === undefined || row.kekId !== previous) return [];
      Object.assign(row, { pubkey, ciphertext, kekId, placePending: true });
      return [{ message_id: id }] as T[];
    }
    if (text.startsWith('SELECT viewer_kek_id FROM spark_viewer_key')) {
      return (d.viewer === undefined ? [] : [{ viewer_kek_id: d.viewer.kekId }]) as T[];
    }
    if (text.startsWith('UPDATE spark_viewer_key')) {
      const [publicKey, ciphertext, kekId, previous] = params as [
        string,
        Uint8Array,
        number,
        number,
      ];
      if (d.viewer === undefined || d.viewer.kekId !== previous) return [];
      d.viewer = { publicKey, ciphertext, kekId };
      return [{ singleton: true }] as T[];
    }
    if (text.startsWith('SELECT count(*)::int AS pending FROM recovery_share')) {
      if (state.emptyCount) return [];
      const [current] = params as [Uint8Array];
      const pending = d.shares.filter((row) => !sameBytes(idBytesOf(row.ciphertext), current));
      return [{ pending: pending.length }] as T[];
    }
    if (text.startsWith('SELECT account_id::text AS account_id, spark_pubkey')) {
      const [current, afterAccount, afterSpark, limit] = params as [
        Uint8Array,
        string | null,
        string | null,
        number,
      ];
      state.sharePages += 1;
      state.beforeSharePage.get(state.sharePages)?.();
      return state.db.shares
        .filter((row) => !sameBytes(idBytesOf(row.ciphertext), current))
        .filter(
          (row) =>
            afterAccount === null ||
            row.accountId > afterAccount ||
            (row.accountId === afterAccount && row.sparkPubkey > (afterSpark ?? '')),
        )
        .sort((a, b) =>
          a.accountId === b.accountId
            ? a.sparkPubkey < b.sparkPubkey
              ? -1
              : 1
            : a.accountId < b.accountId
              ? -1
              : 1,
        )
        .slice(0, limit)
        .map((row) => ({
          account_id: row.accountId,
          spark_pubkey: row.sparkPubkey,
          recovery_share_ciphertext: row.ciphertext.slice(),
        })) as T[];
    }
    if (text.startsWith('UPDATE recovery_share')) {
      const [accountId, sparkPubkey, next, previous] = params as [
        string,
        string,
        Uint8Array,
        Uint8Array,
      ];
      hook(`share:${accountId}:${sparkPubkey}`);
      const row = d.shares.find(
        (item) => item.accountId === accountId && item.sparkPubkey === sparkPubkey,
      );
      if (row === undefined || !sameBytes(row.ciphertext, previous)) return [];
      row.ciphertext = next;
      return [{ account_id: accountId }] as T[];
    }
    throw new Error(`unexpected SQL: ${text}`);
  };
  const tx: SqlClient = { query, execute: async () => undefined };
  state.sql = {
    query,
    execute: async () => undefined,
    transaction: async <T>(run: (client: SqlClient) => Promise<T>): Promise<T> => {
      state.transactions += 1;
      const snapshot = clone(state.db);
      try {
        return await run(tx);
      } catch (error) {
        state.db = snapshot;
        throw error;
      }
    },
  };
  return state;
}

const nostrKek = bindKekId(new Uint8Array(32).fill(0x21), 2);
const recoveryKek = bindKekId(new Uint8Array(32).fill(0x31), 2);
const previousRecoveryKek = new Uint8Array(32).fill(0x41);

function config(overrides: Partial<KekRotationConfig> = {}): KekRotationConfig {
  return {
    nostrKek,
    recoveryShareKek: recoveryKek,
    previousRecoveryShareKek: previousRecoveryKek,
    ...overrides,
  };
}

async function seed(): Promise<Db> {
  return {
    accounts: new Map<string, KeyRow>([
      [uuid(1), { pubkey: 'a'.repeat(64), ciphertext: opaqueEnvelope(1), kekId: 1 }],
      [uuid(2), { pubkey: 'b'.repeat(64), ciphertext: opaqueEnvelope(1), kekId: 1 }],
      [uuid(3), { pubkey: 'c'.repeat(64), ciphertext: null, kekId: 1 }],
      [
        uuid(4),
        {
          pubkey: 'd'.repeat(64),
          ciphertext: await encryptNostrSecret(new Uint8Array(32).fill(4), nostrKek, uuid(4)),
          kekId: 2,
        },
      ],
    ]),
    shops: new Map<string, KeyRow>([
      [uuid(11), { pubkey: 'e'.repeat(64), ciphertext: opaqueEnvelope(1), kekId: 1 }],
      [
        uuid(12),
        {
          pubkey: 'f'.repeat(64),
          ciphertext: await encryptNostrSecret(
            new Uint8Array(32).fill(5),
            nostrKek,
            `shop:${uuid(12)}`,
          ),
          kekId: 2,
        },
      ],
    ]),
    viewer: { publicKey: `03${'08'.repeat(32)}`, ciphertext: opaqueEnvelope(1), kekId: 1 },
    shares: [
      {
        accountId: uuid(1),
        sparkPubkey: `02${'11'.repeat(32)}`,
        ciphertext: await encryptRecoveryShare(SHARE, previousRecoveryKek, uuid(1)),
      },
      {
        accountId: uuid(1),
        sparkPubkey: `02${'22'.repeat(32)}`,
        ciphertext: await encryptRecoveryShare(SHARE, previousRecoveryKek, uuid(1)),
      },
      {
        accountId: uuid(2),
        sparkPubkey: `02${'33'.repeat(32)}`,
        ciphertext: await encryptRecoveryShare(SHARE, recoveryKek, uuid(2)),
      },
    ],
  };
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

function events(name: string): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
    .filter((event) => event['event'] === name);
}

describe('rotateKeks', () => {
  it('renews accounts, shops and the viewer key and re-seals shares under the current ids', async () => {
    const db = await seed();
    const before = clone(db);
    const state = fake(db);
    const result = await rotateKeks(state.sql, config());
    expect(result).toEqual({
      accounts: 2,
      shops: 1,
      sparkViewer: 1,
      recoveryShares: 2,
      recoverySharesPending: 0,
      rotatedAccountIds: [uuid(1), uuid(2)],
      rotatedShopMessageIds: [uuid(11)],
    });
    const after = state.db;
    for (const id of [uuid(1), uuid(2)]) {
      const row = after.accounts.get(id)!;
      expect(row.kekId).toBe(2);
      expect(row.pubkey).not.toBe(before.accounts.get(id)!.pubkey);
      const secret = await decryptNostrSecret(row.ciphertext!, nostrKek, id);
      expect(publicKeyHexFromSecret(secret)).toBe(row.pubkey);
    }
    // No key, or already under the current id: untouched.
    expect(after.accounts.get(uuid(3))).toEqual(before.accounts.get(uuid(3)));
    expect(after.accounts.get(uuid(4))).toEqual(before.accounts.get(uuid(4)));
    const shop = after.shops.get(uuid(11))!;
    expect(shop.kekId).toBe(2);
    expect(shop.placePending).toBe(true);
    const shopSecret = await decryptNostrSecret(shop.ciphertext!, nostrKek, `shop:${uuid(11)}`);
    expect(publicKeyHexFromSecret(shopSecret)).toBe(shop.pubkey);
    expect(after.shops.get(uuid(12))).toEqual(before.shops.get(uuid(12)));
    expect(after.viewer?.kekId).toBe(2);
    expect(after.viewer?.publicKey).toBe(`02${'07'.repeat(32)}`);
    expect(envelopeKekId(after.viewer!.ciphertext)).toBe(2);
    for (const [index, share] of after.shares.entries()) {
      expect(envelopeKekId(share.ciphertext)).toBe(2);
      const opened = await openAesGcmEnvelope(
        share.ciphertext,
        recoveryKek,
        new TextEncoder().encode(share.accountId),
      );
      expect(new TextDecoder().decode(opened)).toBe(SHARE);
      expect(share.sparkPubkey).toBe(before.shares[index]!.sparkPubkey);
    }
    expect(sameBytes(after.shares[2]!.ciphertext, before.shares[2]!.ciphertext)).toBe(true);
    // Every rotation transaction took the rotation lock first.
    expect(state.locks.filter(([key]) => key === LOCK).length).toBe(state.transactions - 1);
    expect(state.locks.filter(([key]) => key === 21_499_021)).toHaveLength(1);
    expect(events('kek.rotation.recovery_share.pending')).toEqual([]);
    // Nothing in the logs carries key material.
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SHARE);
  });

  it('changes nothing on a second run (idempotent)', async () => {
    const state = fake(await seed());
    await rotateKeks(state.sql, config());
    const rotated = clone(state.db);
    state.statements.length = 0;
    const again = await rotateKeks(state.sql, config());
    expect(again).toEqual({
      accounts: 0,
      shops: 0,
      sparkViewer: 0,
      recoveryShares: 0,
      recoverySharesPending: 0,
      rotatedAccountIds: [],
      rotatedShopMessageIds: [],
    });
    expect(state.statements.filter((text) => text.startsWith('UPDATE'))).toEqual([]);
    expect(state.db).toEqual(rotated);
  });

  it('walks every row in batches and continues after the last row of a full batch', async () => {
    const db = await seed();
    for (let n = 20; n < 25; n += 1) {
      db.accounts.set(uuid(n), { pubkey: '0'.repeat(64), ciphertext: opaqueEnvelope(1), kekId: 1 });
    }
    db.shops.set(uuid(13), { pubkey: '1'.repeat(64), ciphertext: opaqueEnvelope(1), kekId: 1 });
    const state = fake(db);
    const result = await rotateKeks(state.sql, config({ batchSize: 2 }));
    expect(result.accounts).toBe(7);
    expect(result.shops).toBe(2);
    expect(result.recoveryShares).toBe(2);
    expect([...state.db.accounts.values()].filter((row) => row.kekId === 1)).toEqual([
      expect.objectContaining({ ciphertext: null }),
    ]);
  });

  it('skips a row another process changed between the read and the write (compare-and-set)', async () => {
    const state = fake(await seed());
    const other = { pubkey: '9'.repeat(64), ciphertext: opaqueEnvelope(2), kekId: 2 };
    state.beforeUpdate.set(`account:${uuid(1)}`, () => {
      state.db.accounts.set(uuid(1), { ...other });
    });
    state.beforeUpdate.set(`shop:${uuid(11)}`, () => {
      state.db.shops.set(uuid(11), { ...other });
    });
    const replaced = await encryptRecoveryShare(SHARE, recoveryKek, uuid(1));
    state.beforeUpdate.set(`share:${uuid(1)}:02${'11'.repeat(32)}`, () => {
      state.db.shares[0]!.ciphertext = replaced;
    });
    const result = await rotateKeks(state.sql, config());
    expect(result.rotatedAccountIds).toEqual([uuid(2)]);
    expect(result.rotatedShopMessageIds).toEqual([]);
    expect(result.recoveryShares).toBe(1);
    expect(state.db.accounts.get(uuid(1))).toEqual(other);
    expect(state.db.shops.get(uuid(11))).toEqual(other);
    expect(state.db.shares[0]!.ciphertext).toBe(replaced);
  });

  it('leaves shares untouched and warns with the count only without the previous key', async () => {
    const db = await seed();
    const before = clone(db);
    const state = fake(db);
    const result = await rotateKeks(state.sql, config({ previousRecoveryShareKek: undefined }));
    expect(result.recoveryShares).toBe(0);
    expect(result.recoverySharesPending).toBe(2);
    expect(state.db.shares).toEqual(before.shares);
    expect(result.accounts).toBe(2);
    const [warning, ...more] = events('kek.rotation.recovery_share.pending');
    expect(more).toEqual([]);
    expect(Object.keys(warning ?? {}).sort()).toEqual(['count', 'event', 'ts']);
    expect(warning?.['count']).toBe(2);
    // Nothing pending: no warning.
    state.emptyCount = true;
    const quiet = await rotateKeks(state.sql, config({ previousRecoveryShareKek: undefined }));
    expect(quiet.recoverySharesPending).toBe(0);
    expect(events('kek.rotation.recovery_share.pending')).toHaveLength(1);
  });

  it('stops fail-loud with only the count when the previous key opens no share, changing none', async () => {
    const db = await seed();
    const before = clone(db);
    const state = fake(db);
    const wrong = new Uint8Array(32).fill(0x51);
    let message = '';
    try {
      await rotateKeks(state.sql, config({ previousRecoveryShareKek: wrong }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(
      'KEK rotation stopped: 2 recovery share(s) did not open with RECOVERY_SHARE_KEK_PREVIOUS',
    );
    expect(state.db.shares).toEqual(before.shares);
    expect(state.statements.some((text) => text.startsWith('UPDATE recovery_share'))).toBe(false);
  });

  it('opens every share before the first write: with batches of 1 a bad second share keeps the first', async () => {
    const db = await seed();
    db.shares[1]!.ciphertext = await sealAesGcmEnvelope(
      new Uint8Array([1, 2, 3]),
      new Uint8Array(32).fill(0x61),
      new TextEncoder().encode(uuid(1)),
      1,
    );
    const before = clone(db);
    const state = fake(db);
    await expect(rotateKeks(state.sql, config({ batchSize: 1 }))).rejects.toThrow(
      'KEK rotation stopped: 1 recovery share(s) did not open with RECOVERY_SHARE_KEK_PREVIOUS',
    );
    expect(state.db.shares).toEqual(before.shares);
    expect(sameBytes(state.db.shares[0]!.ciphertext, before.shares[0]!.ciphertext)).toBe(true);
    expect(state.statements.some((text) => text.startsWith('UPDATE recovery_share'))).toBe(false);
    // The read-only pass walked both pages of one share each (and the empty third).
    expect(state.sharePages).toBe(3);
  });

  it('changes no share of a batch when one of its shares stops opening after the read-only pass', async () => {
    const db = await seed();
    const before = clone(db);
    const state = fake(db);
    const unopenable = await sealAesGcmEnvelope(
      new Uint8Array([1, 2, 3]),
      new Uint8Array(32).fill(0x61),
      new TextEncoder().encode(uuid(1)),
      1,
    );
    // Page 1 is the read-only pass; page 2 is the first write batch.
    state.beforeSharePage.set(2, () => {
      state.db.shares[1]!.ciphertext = unopenable;
    });
    await expect(rotateKeks(state.sql, config())).rejects.toThrow(
      'KEK rotation stopped: 1 recovery share(s) did not open with RECOVERY_SHARE_KEK_PREVIOUS',
    );
    expect(state.statements.some((text) => text.startsWith('UPDATE recovery_share'))).toBe(false);
    expect(state.db.shares).toEqual(before.shares);
  });

  it('zeroes every opened plaintext', async () => {
    const open = vi.spyOn(aesGcm, 'openAesGcmEnvelope');
    const state = fake(await seed());
    await rotateKeks(state.sql, config());
    // Boot check: one Nostr key and one share under the current ids; then the
    // read-only pass and the re-seal open each of the two old shares.
    expect(open).toHaveBeenCalledTimes(6);
    const lengths: number[] = [];
    for (const call of open.mock.results) {
      const plaintext = (await call.value) as Uint8Array;
      lengths.push(plaintext.length);
      expect(plaintext.every((byte) => byte === 0)).toBe(true);
    }
    expect(lengths).toEqual([32, ...Array<number>(5).fill(SHARE.length)]);
    open.mockRestore();
  });

  describe('boot check of the current keys', () => {
    const wrongNostrKek = bindKekId(new Uint8Array(32).fill(0x22), 2);
    const wrongRecoveryKek = bindKekId(new Uint8Array(32).fill(0x32), 2);
    const nostrFailure =
      'NOSTR_NSEC_KEK does not open the keys stored under NOSTR_NSEC_KEK_ID 2; a new key value needs a new id';
    const recoveryFailure =
      'RECOVERY_SHARE_KEK does not open the recovery shares stored under RECOVERY_SHARE_KEK_ID 2; a new key value needs a new id';

    async function viewerUnder(kek: Uint8Array): Promise<Db['viewer']> {
      return {
        publicKey: `02${'07'.repeat(32)}`,
        ciphertext: await sealAesGcmEnvelope(
          new TextEncoder().encode('abandon ability able'),
          kek,
          new TextEncoder().encode('spark_viewer_key'),
          2,
        ),
        kekId: 2,
      };
    }

    async function expectRefused(db: Db, overrides: Partial<KekRotationConfig>, message: string) {
      const before = clone(db);
      const state = fake(db);
      let error: unknown;
      try {
        await rotateKeks(state.sql, config(overrides));
      } catch (caught) {
        error = caught;
      }
      expect((error as Error).message).toBe(message);
      expect(state.transactions).toBe(0);
      expect(state.statements.filter((text) => text.startsWith('UPDATE'))).toEqual([]);
      expect(state.db).toEqual(before);
    }

    it('passes when the current keys open a stored account key and share', async () => {
      const state = fake(await seed());
      await expect(rotateKeks(state.sql, config())).resolves.toMatchObject({ accounts: 2 });
      expect(state.statements[0]).toMatch(/^SELECT id::text AS account_id, nostr_nsec/);
    });

    it('stops the boot when NOSTR_NSEC_KEK does not open an account key under its id', async () => {
      await expectRefused(await seed(), { nostrKek: wrongNostrKek }, nostrFailure);
    });

    it('falls back to a shop key when no account key is under the current id', async () => {
      const db = await seed();
      db.accounts.delete(uuid(4));
      await expectRefused(clone(db), { nostrKek: wrongNostrKek }, nostrFailure);
      await expect(rotateKeks(fake(db).sql, config())).resolves.toMatchObject({ shops: 1 });
    });

    it('falls back to the Spark viewer key when no account or shop key is under the current id', async () => {
      const db = await seed();
      db.accounts.delete(uuid(4));
      db.shops.delete(uuid(12));
      const foreign = clone(db);
      db.viewer = await viewerUnder(nostrKek);
      await expectRefused(clone(db), { nostrKek: wrongNostrKek }, nostrFailure);
      await expect(rotateKeks(fake(db).sql, config())).resolves.toMatchObject({
        sparkViewer: 0,
        accounts: 2,
      });
      foreign.viewer = await viewerUnder(new Uint8Array(32).fill(0x23));
      await expectRefused(foreign, {}, nostrFailure);
    });

    it('stops the boot when RECOVERY_SHARE_KEK does not open a share under its id', async () => {
      await expectRefused(await seed(), { recoveryShareKek: wrongRecoveryKek }, recoveryFailure);
    });

    it('checks nothing when no row is under the current ids', async () => {
      const db = await seed();
      db.accounts.delete(uuid(4));
      db.shops.delete(uuid(12));
      db.shares.splice(2, 1);
      const open = vi.spyOn(aesGcm, 'openAesGcmEnvelope');
      const state = fake(db);
      // Any key passes: nothing is stored under its id yet.
      const result = await rotateKeks(
        state.sql,
        config({ nostrKek: wrongNostrKek, recoveryShareKek: wrongRecoveryKek }),
      );
      expect(result).toMatchObject({ accounts: 2, shops: 1, sparkViewer: 1, recoveryShares: 2 });
      // Only the read-only pass and the re-seal opened shares (with the previous key).
      expect(open).toHaveBeenCalledTimes(4);
      for (const call of open.mock.calls) {
        expect(call[1]).toBe(previousRecoveryKek);
      }
      open.mockRestore();
    });

    it('never names a key in its error', async () => {
      const db = await seed();
      const state = fake(db);
      let message = '';
      try {
        await rotateKeks(state.sql, config({ nostrKek: wrongNostrKek }));
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe(nostrFailure);
      expect(message).not.toContain('22'.repeat(32));
      expect(message).not.toContain('21'.repeat(32));
    });
  });

  it('needs SQL transactions', async () => {
    await expect(
      rotateKeks({ query: async () => [], execute: async () => undefined }, config()),
    ).rejects.toThrow('KEK rotation needs SQL transactions');
  });
});
