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
import { nostrRetiredKeyAad } from '@/lib/nostr/retired-key';
import { sparkViewerRetiredKeyAad } from '@/lib/spark-viewer';

const LOCK = 21_499_031;
const SHARE = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 'acid' : 'brave')).join(' ');
const VIEWER_MNEMONIC = 'abandon ability able';
const OLDER_VIEWER_MNEMONIC = 'zoo zone zero';
const OLD_VIEWER_KEY = `03${'08'.repeat(32)}`;
const OLDER_VIEWER_KEY = `02${'09'.repeat(32)}`;

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function secretOf(n: number): Uint8Array {
  return new Uint8Array(32).fill(n);
}

function pubkeyOf(n: number): string {
  return publicKeyHexFromSecret(secretOf(n));
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

interface RetiredRow {
  ownerType: 'account' | 'shop';
  ownerId: string;
  pubkey: string;
  ciphertext: Uint8Array;
  kekId: number;
}

interface RetiredViewerRow {
  identity: string;
  ciphertext: Uint8Array;
  kekId: number;
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
  retired: RetiredRow[];
  retiredViewers: RetiredViewerRow[];
  shares: ShareRow[];
}

interface Fake {
  sql: SqlClient;
  db: Db;
  statements: string[];
  locks: unknown[][];
  transactions: number;
  /** Runs right before the UPDATE of a row is applied (key: kind:id). */
  beforeUpdate: Map<string, () => void>;
  /** Make the pending-share count answer no row. */
  emptyCount: boolean;
  /** Share page reads so far (read-only pass and write batches). */
  sharePages: number;
  /** Runs right before the n-th share page (1-based) is read. */
  beforeSharePage: Map<number, () => void>;
  /** Account key page reads so far (read-only pass and write batches). */
  accountPages: number;
  /** Runs right before the n-th account key page (1-based) is read. */
  beforeAccountPage: Map<number, () => void>;
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
    retired: db.retired.map((row) => ({ ...row })),
    retiredViewers: db.retiredViewers.map((row) => ({ ...row })),
    shares: db.shares.map((row) => ({ ...row })),
  };
}

function byKey<T>(key: (row: T) => string): (a: T, b: T) => number {
  return (a, b) => (key(a) < key(b) ? -1 : 1);
}

function retiredKey(row: Pick<RetiredRow, 'ownerType' | 'ownerId' | 'pubkey'>): string {
  return `${row.ownerType}\u0000${row.ownerId}\u0000${row.pubkey}`;
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
    accountPages: 0,
    beforeAccountPage: new Map(),
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
    // Boot check samples: one row under the current id.
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
      text.startsWith('SELECT owner_type, owner_id, pubkey, nsec_ciphertext FROM nostr_retired_key')
    ) {
      const [current] = params as [number];
      return d.retired
        .filter((row) => row.kekId === current)
        .slice(0, 1)
        .map((row) => ({
          owner_type: row.ownerType,
          owner_id: row.ownerId,
          pubkey: row.pubkey,
          nsec_ciphertext: row.ciphertext,
        })) as T[];
    }
    if (
      text.startsWith(
        'SELECT identity_public_key, mnemonic_ciphertext FROM spark_viewer_retired_key',
      )
    ) {
      const [current] = params as [number];
      return d.retiredViewers
        .filter((row) => row.kekId === current)
        .slice(0, 1)
        .map((row) => ({
          identity_public_key: row.identity,
          mnemonic_ciphertext: row.ciphertext,
        })) as T[];
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
    // Keyset pages of the Nostr-KEK envelopes under another id.
    if (text.startsWith('SELECT id::text AS id, nostr_kek_id AS kek_id')) {
      const [current, after, limit] = params as [number, string | null, number];
      state.accountPages += 1;
      state.beforeAccountPage.get(state.accountPages)?.();
      return [...state.db.accounts]
        .filter(([, row]) => row.ciphertext !== null && row.kekId !== current)
        .filter(([id]) => after === null || id > after)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .slice(0, limit)
        .map(([id, row]) => ({ id, kek_id: row.kekId, envelope: row.ciphertext })) as T[];
    }
    if (text.startsWith('SELECT message_id::text AS message_id, nostr_kek_id AS kek_id')) {
      const [current, after, limit] = params as [number, string | null, number];
      return [...d.shops]
        .filter(([, row]) => row.kekId !== current)
        .filter(([id]) => after === null || id > after)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .slice(0, limit)
        .map(([id, row]) => ({
          message_id: id,
          kek_id: String(row.kekId),
          envelope: row.ciphertext,
        })) as T[];
    }
    if (text.startsWith('SELECT viewer_identity_public_key AS identity')) {
      const [current, after, limit] = params as [number, string | null, number];
      const viewer = d.viewer;
      if (viewer === undefined || viewer.kekId === current) return [];
      if (after !== null && viewer.publicKey <= after) return [];
      return [
        { identity: viewer.publicKey, kek_id: viewer.kekId, envelope: viewer.ciphertext },
      ].slice(0, limit) as T[];
    }
    if (text.startsWith('SELECT owner_type, owner_id, pubkey, kek_id, nsec_ciphertext')) {
      const [current, type, owner, pubkey, limit] = params as [
        number,
        string | null,
        string | null,
        string | null,
        number,
      ];
      const after = type === null ? null : `${type}\u0000${owner ?? ''}\u0000${pubkey ?? ''}`;
      return d.retired
        .filter((row) => row.kekId !== current)
        .filter((row) => after === null || retiredKey(row) > after)
        .sort(byKey(retiredKey))
        .slice(0, limit)
        .map((row) => ({
          owner_type: row.ownerType,
          owner_id: row.ownerId,
          pubkey: row.pubkey,
          kek_id: row.kekId,
          envelope: row.ciphertext,
        })) as T[];
    }
    if (text.startsWith('SELECT identity_public_key, kek_id, mnemonic_ciphertext')) {
      const [current, after, limit] = params as [number, string | null, number];
      return d.retiredViewers
        .filter((row) => row.kekId !== current)
        .filter((row) => after === null || row.identity > after)
        .sort(byKey((row: RetiredViewerRow) => row.identity))
        .slice(0, limit)
        .map((row) => ({
          identity_public_key: row.identity,
          kek_id: row.kekId,
          envelope: row.ciphertext,
        })) as T[];
    }
    // Writes.
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
    if (text.startsWith('INSERT INTO nostr_retired_key')) {
      expect(text).toContain('ON CONFLICT (owner_type, owner_id, pubkey) DO NOTHING');
      const [ownerType, ownerId, pubkey, ciphertext, kekId] = params as [
        'account' | 'shop',
        string,
        string,
        Uint8Array,
        number,
      ];
      const row = { ownerType, ownerId, pubkey, ciphertext, kekId };
      if (!d.retired.some((item) => retiredKey(item) === retiredKey(row))) d.retired.push(row);
      return [];
    }
    if (text.startsWith('UPDATE nostr_retired_key')) {
      const [ownerType, ownerId, pubkey, ciphertext, kekId, previous] = params as [
        string,
        string,
        string,
        Uint8Array,
        number,
        number,
      ];
      hook(`retired:${ownerType}:${ownerId}:${pubkey}`);
      const row = d.retired.find(
        (item) =>
          item.ownerType === ownerType && item.ownerId === ownerId && item.pubkey === pubkey,
      );
      if (row === undefined || row.kekId !== previous) return [];
      Object.assign(row, { ciphertext, kekId });
      return [{ pubkey }] as T[];
    }
    if (text.includes('FROM spark_viewer_key WHERE singleton = true')) {
      const viewer = d.viewer;
      return (
        viewer === undefined
          ? []
          : [
              {
                viewer_identity_public_key: viewer.publicKey,
                viewer_mnemonic_ciphertext: viewer.ciphertext,
                viewer_kek_id: viewer.kekId,
              },
            ]
      ) as T[];
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
    if (text.startsWith('INSERT INTO spark_viewer_retired_key')) {
      const [identity, ciphertext, kekId] = params as [string, Uint8Array, number];
      if (!d.retiredViewers.some((row) => row.identity === identity)) {
        d.retiredViewers.push({ identity, ciphertext, kekId });
      }
      return [];
    }
    if (text.startsWith('UPDATE spark_viewer_retired_key')) {
      const [identity, ciphertext, kekId, previous] = params as [
        string,
        Uint8Array,
        number,
        number,
      ];
      hook(`retiredViewer:${identity}`);
      const row = d.retiredViewers.find((item) => item.identity === identity);
      if (row === undefined || row.kekId !== previous) return [];
      Object.assign(row, { ciphertext, kekId });
      return [{ identity_public_key: identity }] as T[];
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
        .sort(byKey((row: ShareRow) => `${row.accountId}\u0000${row.sparkPubkey}`))
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
  const execute = async (text: string, params: readonly unknown[] = []): Promise<void> => {
    await query(text, params);
  };
  const tx: SqlClient = { query, execute };
  state.sql = {
    query,
    execute,
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
const previousNostrKek = new Uint8Array(32).fill(0x61);
const recoveryKek = bindKekId(new Uint8Array(32).fill(0x31), 2);
const previousRecoveryKek = new Uint8Array(32).fill(0x41);

function config(overrides: Partial<KekRotationConfig> = {}): KekRotationConfig {
  return {
    nostrKek,
    previousNostrKek,
    recoveryShareKek: recoveryKek,
    previousRecoveryShareKek: previousRecoveryKek,
    ...overrides,
  };
}

/** A Nostr key row under the previous key (id 1) or the current key (id 2). */
async function keyRow(n: number, aad: string, kek: Uint8Array): Promise<KeyRow> {
  return {
    pubkey: pubkeyOf(n),
    ciphertext: await encryptNostrSecret(secretOf(n), kek, aad),
    kekId: kek === nostrKek ? 2 : 1,
  };
}

async function retiredRow(
  n: number,
  ownerId: string,
  kek: Uint8Array,
  kekId: number,
): Promise<RetiredRow> {
  const pubkey = pubkeyOf(n);
  return {
    ownerType: 'account',
    ownerId,
    pubkey,
    ciphertext: await sealAesGcmEnvelope(
      secretOf(n),
      kek,
      utf8(nostrRetiredKeyAad('account', ownerId, pubkey)),
      kekId,
    ),
    kekId,
  };
}

async function seed(): Promise<Db> {
  return {
    accounts: new Map<string, KeyRow>([
      [uuid(1), await keyRow(1, uuid(1), previousNostrKek)],
      [uuid(2), await keyRow(2, uuid(2), previousNostrKek)],
      [uuid(3), { pubkey: 'c'.repeat(64), ciphertext: null, kekId: 1 }],
      [uuid(4), await keyRow(4, uuid(4), nostrKek)],
    ]),
    shops: new Map<string, KeyRow>([
      [uuid(11), await keyRow(11, `shop:${uuid(11)}`, previousNostrKek)],
      [uuid(12), await keyRow(12, `shop:${uuid(12)}`, nostrKek)],
    ]),
    viewer: {
      publicKey: OLD_VIEWER_KEY,
      ciphertext: await sealAesGcmEnvelope(
        utf8(VIEWER_MNEMONIC),
        previousNostrKek,
        utf8('spark_viewer_key'),
        1,
      ),
      kekId: 1,
    },
    retired: [
      // Retired by an earlier rotation (under id 1), and one already under id 2.
      await retiredRow(40, uuid(4), previousNostrKek, 1),
      await retiredRow(41, uuid(4), nostrKek, 2),
    ],
    retiredViewers: [
      {
        identity: OLDER_VIEWER_KEY,
        ciphertext: await sealAesGcmEnvelope(
          utf8(OLDER_VIEWER_MNEMONIC),
          previousNostrKek,
          sparkViewerRetiredKeyAad(OLDER_VIEWER_KEY),
          1,
        ),
        kekId: 1,
      },
    ],
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

/** The seed with every Nostr-KEK row under the current id (nothing to rotate). */
async function currentOnly(): Promise<Db> {
  const db = await seed();
  db.accounts.delete(uuid(1));
  db.accounts.delete(uuid(2));
  db.shops.delete(uuid(11));
  db.viewer = undefined;
  db.retired.splice(0, 1);
  db.retiredViewers = [];
  return db;
}

function retiredOf(db: Db, ownerType: 'account' | 'shop', ownerId: string): RetiredRow[] {
  return db.retired.filter((row) => row.ownerType === ownerType && row.ownerId === ownerId);
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
  it('renews accounts, shops and the viewer, retires the old keys, re-seals retired keys and shares', async () => {
    const db = await seed();
    const before = clone(db);
    const state = fake(db);
    const result = await rotateKeks(state.sql, config());
    expect(result).toEqual({
      accounts: 2,
      shops: 1,
      sparkViewer: 1,
      retiredKeys: 2,
      recoveryShares: 2,
      recoverySharesPending: 0,
      rotatedAccountIds: [uuid(1), uuid(2)],
      rotatedShopMessageIds: [uuid(11)],
    });
    const after = state.db;
    for (const [n, id] of [
      [1, uuid(1)],
      [2, uuid(2)],
    ] as const) {
      const row = after.accounts.get(id)!;
      expect(row.kekId).toBe(2);
      expect(row.pubkey).not.toBe(pubkeyOf(n));
      const secret = await decryptNostrSecret(row.ciphertext!, nostrKek, id);
      expect(publicKeyHexFromSecret(secret)).toBe(row.pubkey);
      // The old key is retired under the current key, bound to owner and pubkey.
      const [retired, ...more] = retiredOf(after, 'account', id);
      expect(more).toEqual([]);
      expect(retired?.pubkey).toBe(pubkeyOf(n));
      expect(retired?.kekId).toBe(2);
      const opened = await decryptNostrSecret(
        retired!.ciphertext,
        nostrKek,
        nostrRetiredKeyAad('account', id, pubkeyOf(n)),
      );
      expect(opened).toEqual(secretOf(n));
    }
    // No key, or already under the current id: untouched and not retired.
    expect(after.accounts.get(uuid(3))).toEqual(before.accounts.get(uuid(3)));
    expect(after.accounts.get(uuid(4))).toEqual(before.accounts.get(uuid(4)));
    const shop = after.shops.get(uuid(11))!;
    expect(shop.kekId).toBe(2);
    expect(shop.placePending).toBe(true);
    const shopSecret = await decryptNostrSecret(shop.ciphertext!, nostrKek, `shop:${uuid(11)}`);
    expect(publicKeyHexFromSecret(shopSecret)).toBe(shop.pubkey);
    const [shopRetired] = retiredOf(after, 'shop', uuid(11));
    expect(shopRetired?.pubkey).toBe(pubkeyOf(11));
    expect(
      await decryptNostrSecret(
        shopRetired!.ciphertext,
        nostrKek,
        nostrRetiredKeyAad('shop', uuid(11), pubkeyOf(11)),
      ),
    ).toEqual(secretOf(11));
    expect(after.shops.get(uuid(12))).toEqual(before.shops.get(uuid(12)));
    expect(retiredOf(after, 'shop', uuid(12))).toEqual([]);
    // The retired key of an earlier rotation is sealed again (it stays retired);
    // the one already under the current id is untouched.
    const earlier = after.retired.find((row) => row.pubkey === pubkeyOf(40))!;
    expect(earlier.kekId).toBe(2);
    expect(
      await decryptNostrSecret(
        earlier.ciphertext,
        nostrKek,
        nostrRetiredKeyAad('account', uuid(4), pubkeyOf(40)),
      ),
    ).toEqual(secretOf(40));
    expect(after.retired.find((row) => row.pubkey === pubkeyOf(41))).toEqual(before.retired[1]);
    // The viewer: fresh under the current id, the old one retired under it.
    expect(after.viewer?.kekId).toBe(2);
    expect(after.viewer?.publicKey).toBe(`02${'07'.repeat(32)}`);
    expect(envelopeKekId(after.viewer!.ciphertext)).toBe(2);
    expect(after.retiredViewers.map((row) => [row.identity, row.kekId])).toEqual([
      [OLDER_VIEWER_KEY, 2],
      [OLD_VIEWER_KEY, 2],
    ]);
    for (const [identity, mnemonic] of [
      [OLD_VIEWER_KEY, VIEWER_MNEMONIC],
      [OLDER_VIEWER_KEY, OLDER_VIEWER_MNEMONIC],
    ] as const) {
      const row = after.retiredViewers.find((item) => item.identity === identity)!;
      expect(envelopeKekId(row.ciphertext)).toBe(2);
      const opened = await openAesGcmEnvelope(
        row.ciphertext,
        nostrKek,
        sparkViewerRetiredKeyAad(identity),
      );
      expect(new TextDecoder().decode(opened)).toBe(mnemonic);
    }
    for (const [index, share] of after.shares.entries()) {
      expect(envelopeKekId(share.ciphertext)).toBe(2);
      const opened = await openAesGcmEnvelope(share.ciphertext, recoveryKek, utf8(share.accountId));
      expect(new TextDecoder().decode(opened)).toBe(SHARE);
      expect(share.sparkPubkey).toBe(before.shares[index]!.sparkPubkey);
    }
    expect(sameBytes(after.shares[2]!.ciphertext, before.shares[2]!.ciphertext)).toBe(true);
    // Every rotation transaction took the rotation lock first; the viewer took its own.
    expect(state.locks.filter(([key]) => key === LOCK).length).toBe(state.transactions - 1);
    expect(state.locks.filter(([key]) => key === 21_499_021)).toHaveLength(1);
    expect(events('kek.rotation.recovery_share.pending')).toEqual([]);
    // Nothing in the logs carries key material.
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SHARE);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(VIEWER_MNEMONIC);
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
      retiredKeys: 0,
      recoveryShares: 0,
      recoverySharesPending: 0,
      rotatedAccountIds: [],
      rotatedShopMessageIds: [],
    });
    expect(
      state.statements.filter((text) => text.startsWith('UPDATE') || text.startsWith('INSERT')),
    ).toEqual([]);
    expect(state.db).toEqual(rotated);
  });

  it('walks every row of every place in batches and continues after the last row of a full batch', async () => {
    const db = await seed();
    for (let n = 20; n < 25; n += 1) {
      db.accounts.set(uuid(n), await keyRow(n, uuid(n), previousNostrKek));
    }
    db.shops.set(uuid(13), await keyRow(13, `shop:${uuid(13)}`, previousNostrKek));
    db.retired.push(await retiredRow(42, uuid(1), previousNostrKek, 1));
    const state = fake(db);
    const result = await rotateKeks(state.sql, config({ batchSize: 1 }));
    expect(result.accounts).toBe(7);
    expect(result.shops).toBe(2);
    expect(result.sparkViewer).toBe(1);
    expect(result.retiredKeys).toBe(3);
    expect(result.recoveryShares).toBe(2);
    expect([...state.db.accounts.values()].filter((row) => row.kekId === 1)).toEqual([
      expect.objectContaining({ ciphertext: null }),
    ]);
    expect(state.db.retired.every((row) => row.kekId === 2)).toBe(true);
    // 7 accounts, 2 shops, 2 earlier retired keys, and the one already current.
    expect(state.db.retired).toHaveLength(12);
  });

  it('skips a row another process changed between the read and the write (compare-and-set)', async () => {
    const db = await seed();
    db.retiredViewers.push({ ...db.retiredViewers[0]!, identity: `02${'0a'.repeat(32)}` });
    db.retiredViewers[1]!.ciphertext = await sealAesGcmEnvelope(
      utf8(OLDER_VIEWER_MNEMONIC),
      previousNostrKek,
      sparkViewerRetiredKeyAad(`02${'0a'.repeat(32)}`),
      1,
    );
    const state = fake(db);
    const other = { pubkey: '9'.repeat(64), ciphertext: opaqueEnvelope(2), kekId: 2 };
    state.beforeUpdate.set(`account:${uuid(1)}`, () => {
      state.db.accounts.set(uuid(1), { ...other });
    });
    state.beforeUpdate.set(`shop:${uuid(11)}`, () => {
      state.db.shops.set(uuid(11), { ...other });
    });
    state.beforeUpdate.set(`retired:account:${uuid(4)}:${pubkeyOf(40)}`, () => {
      state.db.retired[0]!.kekId = 3;
    });
    state.beforeUpdate.set(`retiredViewer:${OLDER_VIEWER_KEY}`, () => {
      state.db.retiredViewers[0]!.kekId = 3;
    });
    const replaced = await encryptRecoveryShare(SHARE, recoveryKek, uuid(1));
    state.beforeUpdate.set(`share:${uuid(1)}:02${'11'.repeat(32)}`, () => {
      state.db.shares[0]!.ciphertext = replaced;
    });
    const result = await rotateKeks(state.sql, config());
    expect(result.rotatedAccountIds).toEqual([uuid(2)]);
    expect(result.rotatedShopMessageIds).toEqual([]);
    // Only the second retired viewer was sealed again.
    expect(result.retiredKeys).toBe(1);
    expect(result.recoveryShares).toBe(1);
    expect(state.db.accounts.get(uuid(1))).toEqual(other);
    expect(state.db.shops.get(uuid(11))).toEqual(other);
    // A key that was not replaced is not retired.
    expect(retiredOf(state.db, 'account', uuid(1))).toEqual([]);
    expect(retiredOf(state.db, 'shop', uuid(11))).toEqual([]);
    expect(retiredOf(state.db, 'account', uuid(2))).toHaveLength(1);
    expect(state.db.shares[0]!.ciphertext).toBe(replaced);
  });

  describe('NOSTR_NSEC_KEK_PREVIOUS', () => {
    it('is required when a Nostr key is under another id: the boot stops with the count, nothing written', async () => {
      const db = await seed();
      const before = clone(db);
      const state = fake(db);
      let message = '';
      try {
        await rotateKeks(state.sql, config({ previousNostrKek: undefined }));
      } catch (error) {
        message = (error as Error).message;
      }
      // 2 accounts, 1 shop, the viewer, 1 retired key and 1 retired viewer.
      expect(message).toBe(
        'KEK rotation stopped: 6 Nostr key(s) are stored under another NOSTR_NSEC_KEK_ID; set NOSTR_NSEC_KEK_PREVIOUS to the previous NOSTR_NSEC_KEK',
      );
      expect(state.transactions).toBe(0);
      expect(state.db).toEqual(before);
    });

    it('is not needed when every Nostr key is under the current id', async () => {
      const db = await currentOnly();
      const before = clone(db);
      const state = fake(db);
      const result = await rotateKeks(state.sql, config({ previousNostrKek: undefined }));
      expect(result).toMatchObject({
        accounts: 0,
        shops: 0,
        sparkViewer: 0,
        retiredKeys: 0,
        recoveryShares: 2,
      });
      expect(state.db.accounts).toEqual(before.accounts);
      expect(state.db.retired).toEqual(before.retired);
      // The viewer is not even read.
      expect(state.locks.filter(([key]) => key === 21_499_021)).toEqual([]);
    });

    it('stops fail-loud with only the count when it does not open every key, changing none', async () => {
      const db = await seed();
      const before = clone(db);
      const state = fake(db);
      const wrong = new Uint8Array(32).fill(0x71);
      let message = '';
      try {
        await rotateKeks(state.sql, config({ previousNostrKek: wrong }));
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe(
        'KEK rotation stopped: 6 Nostr key(s) did not open with NOSTR_NSEC_KEK_PREVIOUS',
      );
      expect(message).not.toContain('71'.repeat(32));
      expect(state.transactions).toBe(0);
      expect(state.db).toEqual(before);
    });

    it('changes no key of a batch when one of its keys stops opening after the read-only pass', async () => {
      const db = await seed();
      const before = clone(db);
      const state = fake(db);
      // Page 1 is the read-only pass; page 2 is the first write batch.
      state.beforeAccountPage.set(2, () => {
        state.db.accounts.get(uuid(1))!.ciphertext = opaqueEnvelope(1);
      });
      await expect(rotateKeks(state.sql, config())).rejects.toThrow(
        'KEK rotation stopped: 1 Nostr key(s) did not open with NOSTR_NSEC_KEK_PREVIOUS',
      );
      expect(state.statements.some((text) => text.startsWith('UPDATE account'))).toBe(false);
      expect(state.db).toEqual(before);
    });
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
    const db = await currentOnly();
    db.shares[1]!.ciphertext = await sealAesGcmEnvelope(
      new Uint8Array([1, 2, 3]),
      new Uint8Array(32).fill(0x61),
      utf8(uuid(1)),
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
    const state = fake(db);
    const unopenable = await sealAesGcmEnvelope(
      new Uint8Array([1, 2, 3]),
      new Uint8Array(32).fill(0x61),
      utf8(uuid(1)),
      1,
    );
    // Page 1 is the read-only pass; page 2 is the first write batch.
    state.beforeSharePage.set(2, () => {
      state.db.shares[1]!.ciphertext = unopenable;
    });
    const before = clone(db);
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
    // Boot check: one Nostr key and one share under the current ids (2); the
    // read-only pass over the 6 Nostr envelopes under id 1; the batches
    // opening them again (accounts, shop, viewer, retired key, retired
    // viewer: 6); the read-only pass and the re-seal of the 2 old shares (4).
    expect(open).toHaveBeenCalledTimes(18);
    for (const call of open.mock.results) {
      const plaintext = (await call.value) as Uint8Array;
      expect(plaintext.length).toBeGreaterThan(0);
      expect(plaintext.every((byte) => byte === 0)).toBe(true);
    }
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
          utf8(VIEWER_MNEMONIC),
          kek,
          utf8('spark_viewer_key'),
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
      expect(
        state.statements.filter((text) => text.startsWith('UPDATE') || text.startsWith('INSERT')),
      ).toEqual([]);
      expect(state.db).toEqual(before);
    }

    /** The seed without any Nostr-KEK row under the current id. */
    async function nothingCurrent(): Promise<Db> {
      const db = await seed();
      db.accounts.delete(uuid(4));
      db.shops.delete(uuid(12));
      db.retired.splice(1, 1);
      return db;
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
      const db = await nothingCurrent();
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

    it('falls back to a retired key, then a retired viewer, when nothing else is under the current id', async () => {
      const db = await nothingCurrent();
      db.retired.push(await retiredRow(43, uuid(1), nostrKek, 2));
      await expectRefused(clone(db), { nostrKek: wrongNostrKek }, nostrFailure);
      await expect(rotateKeks(fake(clone(db)).sql, config())).resolves.toMatchObject({
        retiredKeys: 2,
      });
      db.retired.pop();
      db.retiredViewers.push({
        identity: OLD_VIEWER_KEY.replace('03', '02'),
        ciphertext: await sealAesGcmEnvelope(
          utf8(VIEWER_MNEMONIC),
          nostrKek,
          sparkViewerRetiredKeyAad(OLD_VIEWER_KEY.replace('03', '02')),
          2,
        ),
        kekId: 2,
      });
      await expectRefused(clone(db), { nostrKek: wrongNostrKek }, nostrFailure);
      await expect(rotateKeks(fake(db).sql, config())).resolves.toMatchObject({
        retiredKeys: 2,
      });
    });

    it('stops the boot when RECOVERY_SHARE_KEK does not open a share under its id', async () => {
      await expectRefused(await seed(), { recoveryShareKek: wrongRecoveryKek }, recoveryFailure);
    });

    it('checks nothing when no row is under the current ids', async () => {
      const db = await nothingCurrent();
      db.shares.splice(2, 1);
      const open = vi.spyOn(aesGcm, 'openAesGcmEnvelope');
      const state = fake(db);
      // Any key passes: nothing is stored under its id yet.
      const result = await rotateKeks(
        state.sql,
        config({ nostrKek: wrongNostrKek, recoveryShareKek: wrongRecoveryKek }),
      );
      expect(result).toMatchObject({ accounts: 2, shops: 1, sparkViewer: 1, recoveryShares: 2 });
      // Only the previous keys opened anything.
      for (const call of open.mock.calls) {
        expect([previousNostrKek, previousRecoveryKek]).toContain(call[1]);
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
