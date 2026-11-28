/**
 * KEK rotation at boot: renew everything stored under a KEK id other than
 * the configured current one (`NOSTR_NSEC_KEK_ID`, `RECOVERY_SHARE_KEK_ID`).
 *
 * - Member Nostr keys (`account`) and shop Nostr keys (`shop_identity`) get a
 *   fresh key pair under the current Nostr KEK. The old secret is opened with
 *   `NOSTR_NSEC_KEK_PREVIOUS` and kept as a retired key (`nostr_retired_key`,
 *   sealed under the current Nostr KEK). A retired member key is used only
 *   to sign NIP-09 deletions of the notes it signed (staff delete); a retired
 *   shop key is kept only so it stays available should a deletion path for
 *   shop events be added, and today nothing signs with it.
 * - The Spark viewer key gets a fresh mnemonic under the current Nostr KEK;
 *   the old mnemonic is kept as a retired viewer (`spark_viewer_retired_key`),
 *   used only to read wallets that have not granted the new viewer: previous
 *   wallets, which cannot grant it, and current wallets until the member's
 *   app grants it.
 * - Retired keys of an earlier rotation are sealed again under the current
 *   Nostr KEK; they stay retired.
 * - Recovery shares cannot be renewed without the member, so each one is
 *   opened with `RECOVERY_SHARE_KEK_PREVIOUS` and sealed again under the
 *   current recovery KEK with the same additional data (the account id).
 *
 * Every write is recorded by `trg_db_change`. Every update is conditional on
 * the old value (compare-and-set); retired keys are inserted
 * (`ON CONFLICT DO NOTHING`) in the same transaction as the update that
 * retires them. Both run in transactions of at most {@link KEK_ROTATION_BATCH}
 * rows that each take {@link KEK_ROTATION_LOCK} first, so concurrent boots
 * never rotate at the same time and a rerun after a crash continues where it
 * stopped. A second run changes nothing.
 *
 * Before anything is written, one stored envelope under each current id is
 * opened with the current key: a new key value under an id that is already
 * in use would otherwise leave those rows unreadable and unrotated. Then a
 * read-only pass opens every Nostr envelope under another id with the
 * previous Nostr key; without that key, or when one does not open, the boot
 * stops and nothing is written.
 */

import type { SqlClient } from '@/lib/auth/sql';
import { openAesGcmEnvelope, sealAesGcmEnvelope } from '@/lib/aes-gcm-envelope';
import { reencryptRecoveryShare } from '@/lib/auth/recovery-share';
import { logEvent } from '@/lib/log';
import { kekIdOf } from '@/lib/nostr/kek';
import {
  defaultNostrKeygen,
  generateNostrKeyRecord,
  publicKeyHexFromSecret,
  zeroizeSecret,
  type NostrKeygen,
} from '@/lib/nostr/keys';
import { nostrRetiredKeyAad, type NostrRetiredKeyOwnerType } from '@/lib/nostr/retired-key';
import { rotateShopIdentityKey } from '@/lib/shop-identity';
import { rotateSparkViewerKey, sparkViewerRetiredKeyAad } from '@/lib/spark-viewer';

/**
 * Fixed `pg_advisory_xact_lock` key of KEK rotation. Every rotation batch
 * transaction takes it before it reads its rows.
 */
const KEK_ROTATION_LOCK = 21_499_031;

/** Most rows one rotation transaction reads and rewrites. */
const KEK_ROTATION_BATCH = 200;

/** Additional data of the current Spark viewer mnemonic (as `src/lib/spark-viewer.ts` seals it). */
const VIEWER_AAD = 'spark_viewer_key';

/** Keys and collaborators of one rotation run. */
export interface KekRotationConfig {
  /** Current `NOSTR_NSEC_KEK`, bound to `NOSTR_NSEC_KEK_ID`. */
  nostrKek: Uint8Array;
  /**
   * `NOSTR_NSEC_KEK_PREVIOUS`, or `undefined` when unset. Required as soon as
   * any Nostr key, the viewer, or a retired key is under another Nostr KEK id.
   */
  previousNostrKek: Uint8Array | undefined;
  /** Current `RECOVERY_SHARE_KEK`, bound to `RECOVERY_SHARE_KEK_ID`. */
  recoveryShareKek: Uint8Array;
  /** `RECOVERY_SHARE_KEK_PREVIOUS`, or `undefined` when unset. */
  previousRecoveryShareKek: Uint8Array | undefined;
  /** Secret source for the fresh Nostr keys (default {@link defaultNostrKeygen}). */
  keygen?: NostrKeygen;
  /** Rows per transaction (default 200). */
  batchSize?: number;
}

/** What one rotation run changed. */
export interface KekRotationResult {
  /** Accounts that got a fresh Nostr key pair (their old key is retired). */
  accounts: number;
  /** Shops that got a fresh Nostr key pair (their old key is retired). */
  shops: number;
  /** 1 when the Spark viewer key was replaced (the old one retired), else 0. */
  sparkViewer: number;
  /** Retired Nostr keys and retired viewers of an earlier rotation sealed again. */
  retiredKeys: number;
  /** Recovery shares sealed again under the current recovery KEK. */
  recoveryShares: number;
  /** Recovery shares left under another id because `RECOVERY_SHARE_KEK_PREVIOUS` is unset. */
  recoverySharesPending: number;
  /** Ids of the rotated accounts (for the republish; never logged). */
  rotatedAccountIds: string[];
  /** Note ids of the rotated shops (for the republish; never logged). */
  rotatedShopMessageIds: string[];
}

/**
 * Run `run` in one transaction.
 *
 * @param sql - SQL client.
 * @param run - Work on the transaction client.
 * @returns What `run` resolved with.
 * @throws Error('KEK rotation needs SQL transactions') without a transaction port.
 */
async function inTransaction<T>(sql: SqlClient, run: (tx: SqlClient) => Promise<T>): Promise<T> {
  if (sql.transaction === undefined) {
    throw new Error('KEK rotation needs SQL transactions');
  }
  return sql.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [KEK_ROTATION_LOCK]);
    return run(tx);
  });
}

/**
 * The 4 big-endian bytes an envelope stores its KEK id in.
 *
 * @param kekId - KEK id.
 * @returns Bytes 1–4 of an envelope under that id.
 */
function kekIdBytes(kekId: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, kekId, false);
  return bytes;
}

/**
 * UTF-8 bytes of an additional-data string.
 *
 * @param text - Additional data.
 * @returns Its bytes.
 */
function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** One stored envelope the boot check opens, with its additional data. */
interface KekSample {
  envelope: Uint8Array;
  additionalData: Uint8Array;
}

/**
 * Whether `kek` opens `sample` (no sample: nothing to check). The opened
 * plaintext is zeroed at once; it is never returned or logged.
 *
 * @param sample - Stored envelope and its additional data, or `undefined`.
 * @param kek - Key to try.
 * @returns `false` only when the envelope does not open with `kek`.
 */
async function opensWith(sample: KekSample | undefined, kek: Uint8Array): Promise<boolean> {
  if (sample === undefined) return true;
  try {
    zeroizeSecret(await openAesGcmEnvelope(sample.envelope, kek, sample.additionalData));
    return true;
  } catch {
    return false;
  }
}

/**
 * One envelope stored under the current Nostr KEK id: an account key, else a
 * shop key, else the Spark viewer mnemonic, else a retired Nostr key, else a
 * retired viewer mnemonic, each with its own additional data.
 *
 * @param sql - SQL client.
 * @param kekId - Current `NOSTR_NSEC_KEK_ID`.
 * @returns The sample, or `undefined` when no row is under that id.
 */
async function nostrKekSample(sql: SqlClient, kekId: number): Promise<KekSample | undefined> {
  const [account] = await sql.query<{ account_id: string; nostr_nsec_ciphertext: Uint8Array }>(
    `SELECT id::text AS account_id, nostr_nsec_ciphertext FROM account
     WHERE nostr_nsec_ciphertext IS NOT NULL AND nostr_kek_id = $1
     LIMIT 1`,
    [kekId],
  );
  if (account !== undefined) {
    return {
      envelope: new Uint8Array(account.nostr_nsec_ciphertext),
      additionalData: utf8(account.account_id),
    };
  }
  const [shop] = await sql.query<{ message_id: string; nostr_nsec_ciphertext: Uint8Array }>(
    `SELECT message_id::text AS message_id, nostr_nsec_ciphertext FROM shop_identity
     WHERE nostr_kek_id = $1
     LIMIT 1`,
    [kekId],
  );
  if (shop !== undefined) {
    return {
      envelope: new Uint8Array(shop.nostr_nsec_ciphertext),
      additionalData: utf8(`shop:${shop.message_id}`),
    };
  }
  const [viewer] = await sql.query<{ viewer_mnemonic_ciphertext: Uint8Array }>(
    `SELECT viewer_mnemonic_ciphertext FROM spark_viewer_key WHERE singleton = true
       AND viewer_kek_id = $1`,
    [kekId],
  );
  if (viewer !== undefined) {
    return {
      envelope: new Uint8Array(viewer.viewer_mnemonic_ciphertext),
      additionalData: utf8(VIEWER_AAD),
    };
  }
  const [retired] = await sql.query<{
    owner_type: NostrRetiredKeyOwnerType;
    owner_id: string;
    pubkey: string;
    nsec_ciphertext: Uint8Array;
  }>(
    `SELECT owner_type, owner_id, pubkey, nsec_ciphertext FROM nostr_retired_key
     WHERE kek_id = $1
     LIMIT 1`,
    [kekId],
  );
  if (retired !== undefined) {
    return {
      envelope: new Uint8Array(retired.nsec_ciphertext),
      additionalData: utf8(
        nostrRetiredKeyAad(retired.owner_type, retired.owner_id, retired.pubkey),
      ),
    };
  }
  const [retiredViewer] = await sql.query<{
    identity_public_key: string;
    mnemonic_ciphertext: Uint8Array;
  }>(
    `SELECT identity_public_key, mnemonic_ciphertext FROM spark_viewer_retired_key
     WHERE kek_id = $1
     LIMIT 1`,
    [kekId],
  );
  return retiredViewer === undefined
    ? undefined
    : {
        envelope: new Uint8Array(retiredViewer.mnemonic_ciphertext),
        additionalData: sparkViewerRetiredKeyAad(retiredViewer.identity_public_key),
      };
}

/**
 * One recovery share stored under the current recovery KEK id.
 *
 * @param sql - SQL client.
 * @param kekId - Current `RECOVERY_SHARE_KEK_ID`.
 * @returns The sample, or `undefined` when no share is under that id.
 */
async function recoveryKekSample(sql: SqlClient, kekId: number): Promise<KekSample | undefined> {
  const [share] = await sql.query<{ account_id: string; recovery_share_ciphertext: Uint8Array }>(
    `SELECT account_id::text AS account_id, recovery_share_ciphertext FROM recovery_share
     WHERE substring(recovery_share_ciphertext FROM 2 FOR 4) = $1::bytea
     LIMIT 1`,
    [kekIdBytes(kekId)],
  );
  return share === undefined
    ? undefined
    : {
        envelope: new Uint8Array(share.recovery_share_ciphertext),
        additionalData: utf8(share.account_id),
      };
}

/**
 * Stop the boot when a current key does not open what is already stored
 * under its id: a new key value always needs a new id, otherwise the rows
 * under the reused id could neither be used nor rotated. Opens exactly one
 * envelope per key (when one exists) and zeroes the plaintext; reads only.
 *
 * @param sql - SQL client.
 * @param nostrKek - Current `NOSTR_NSEC_KEK` (bound to `NOSTR_NSEC_KEK_ID`).
 * @param recoveryShareKek - Current `RECOVERY_SHARE_KEK` (bound to `RECOVERY_SHARE_KEK_ID`).
 * @throws `NOSTR_NSEC_KEK does not open the keys stored under NOSTR_NSEC_KEK_ID <id>; a new key value needs a new id`
 *   or the same for `RECOVERY_SHARE_KEK` / `RECOVERY_SHARE_KEK_ID` and the
 *   recovery shares. The message names the variable and the id, never a key.
 */
async function assertCurrentKeksOpenStoredRows(
  sql: SqlClient,
  nostrKek: Uint8Array,
  recoveryShareKek: Uint8Array,
): Promise<void> {
  const nostrKekId = kekIdOf(nostrKek);
  if (!(await opensWith(await nostrKekSample(sql, nostrKekId), nostrKek))) {
    throw new Error(
      `NOSTR_NSEC_KEK does not open the keys stored under NOSTR_NSEC_KEK_ID ${String(nostrKekId)}; a new key value needs a new id`,
    );
  }
  const recoveryKekId = kekIdOf(recoveryShareKek);
  if (!(await opensWith(await recoveryKekSample(sql, recoveryKekId), recoveryShareKek))) {
    throw new Error(
      `RECOVERY_SHARE_KEK does not open the recovery shares stored under RECOVERY_SHARE_KEK_ID ${String(recoveryKekId)}; a new key value needs a new id`,
    );
  }
}

/** One Nostr-KEK envelope under another id than the current one. */
interface StaleEnvelope extends KekSample {
  /** Keyset position: the primary key columns, in page order. */
  key: readonly string[];
  /** KEK id the row records (the compare-and-set value). */
  kekId: number;
}

/**
 * Reads one keyset page of Nostr-KEK envelopes under another id.
 *
 * @param sql - SQL client (or transaction client).
 * @param kekId - Current `NOSTR_NSEC_KEK_ID`.
 * @param after - Key of the last row of the previous page, or `null`.
 * @param batch - Page size.
 * @returns At most `batch` rows in key order.
 */
type StalePage = (
  sql: SqlClient,
  kekId: number,
  after: readonly string[] | null,
  batch: number,
) => Promise<StaleEnvelope[]>;

/** Raw columns every stale page selects. */
interface StaleRow {
  kek_id: number | string;
  envelope: Uint8Array;
}

/** Account keys under another id, by `id`; additional data: the account id. */
const staleAccounts: StalePage = async (sql, kekId, after, batch) =>
  (
    await sql.query<StaleRow & { id: string }>(
      `SELECT id::text AS id, nostr_kek_id AS kek_id, nostr_nsec_ciphertext AS envelope
       FROM account
       WHERE nostr_nsec_ciphertext IS NOT NULL AND nostr_kek_id <> $1
         AND ($2::uuid IS NULL OR id > $2::uuid)
       ORDER BY id
       LIMIT $3`,
      [kekId, after?.[0] ?? null, batch],
    )
  ).map((row) => ({
    key: [row.id],
    kekId: Number(row.kek_id),
    envelope: new Uint8Array(row.envelope),
    additionalData: utf8(row.id),
  }));

/** Shop keys under another id, by `message_id`; additional data `shop:<id>`. */
const staleShops: StalePage = async (sql, kekId, after, batch) =>
  (
    await sql.query<StaleRow & { message_id: string }>(
      `SELECT message_id::text AS message_id, nostr_kek_id AS kek_id,
              nostr_nsec_ciphertext AS envelope
       FROM shop_identity
       WHERE nostr_kek_id <> $1 AND ($2::uuid IS NULL OR message_id > $2::uuid)
       ORDER BY message_id
       LIMIT $3`,
      [kekId, after?.[0] ?? null, batch],
    )
  ).map((row) => ({
    key: [row.message_id],
    kekId: Number(row.kek_id),
    envelope: new Uint8Array(row.envelope),
    additionalData: utf8(`shop:${row.message_id}`),
  }));

/** The Spark viewer mnemonic when it is under another id. */
const staleViewer: StalePage = async (sql, kekId, after, batch) =>
  (
    await sql.query<StaleRow & { identity: string }>(
      `SELECT viewer_identity_public_key AS identity, viewer_kek_id AS kek_id,
              viewer_mnemonic_ciphertext AS envelope
       FROM spark_viewer_key
       WHERE singleton = true AND viewer_kek_id <> $1
         AND ($2::text IS NULL OR viewer_identity_public_key > $2::text)
       ORDER BY viewer_identity_public_key
       LIMIT $3`,
      [kekId, after?.[0] ?? null, batch],
    )
  ).map((row) => ({
    key: [row.identity],
    kekId: Number(row.kek_id),
    envelope: new Uint8Array(row.envelope),
    additionalData: utf8(VIEWER_AAD),
  }));

/** Retired Nostr keys under another id, by `(owner_type, owner_id, pubkey)`. */
const staleRetiredKeys: StalePage = async (sql, kekId, after, batch) =>
  (
    await sql.query<
      StaleRow & { owner_type: NostrRetiredKeyOwnerType; owner_id: string; pubkey: string }
    >(
      `SELECT owner_type, owner_id, pubkey, kek_id, nsec_ciphertext AS envelope
       FROM nostr_retired_key
       WHERE kek_id <> $1
         AND ($2::text IS NULL OR (owner_type, owner_id, pubkey) > ($2::text, $3::text, $4::text))
       ORDER BY owner_type, owner_id, pubkey
       LIMIT $5`,
      [kekId, after?.[0] ?? null, after?.[1] ?? null, after?.[2] ?? null, batch],
    )
  ).map((row) => ({
    key: [row.owner_type, row.owner_id, row.pubkey],
    kekId: Number(row.kek_id),
    envelope: new Uint8Array(row.envelope),
    additionalData: utf8(nostrRetiredKeyAad(row.owner_type, row.owner_id, row.pubkey)),
  }));

/** Retired viewer mnemonics under another id, by `identity_public_key`. */
const staleRetiredViewers: StalePage = async (sql, kekId, after, batch) =>
  (
    await sql.query<StaleRow & { identity_public_key: string }>(
      `SELECT identity_public_key, kek_id, mnemonic_ciphertext AS envelope
       FROM spark_viewer_retired_key
       WHERE kek_id <> $1 AND ($2::text IS NULL OR identity_public_key > $2::text)
       ORDER BY identity_public_key
       LIMIT $3`,
      [kekId, after?.[0] ?? null, batch],
    )
  ).map((row) => ({
    key: [row.identity_public_key],
    kekId: Number(row.kek_id),
    envelope: new Uint8Array(row.envelope),
    additionalData: sparkViewerRetiredKeyAad(row.identity_public_key),
  }));

/** Every place a Nostr-KEK envelope is stored. */
const STALE_NOSTR_PAGES: readonly StalePage[] = [
  staleAccounts,
  staleShops,
  staleViewer,
  staleRetiredKeys,
  staleRetiredViewers,
];

/**
 * The fail-loud error of Nostr-KEK envelopes that do not open with the
 * previous key.
 *
 * @param failed - How many envelopes did not open.
 * @returns The error; it names only the count.
 */
function nostrKeysDidNotOpen(failed: number): Error {
  return new Error(
    `KEK rotation stopped: ${String(failed)} Nostr key(s) did not open with NOSTR_NSEC_KEK_PREVIOUS`,
  );
}

/**
 * Read-only pass over every Nostr-KEK envelope under another id (accounts,
 * shops, the viewer, retired keys and retired viewers): count them, open
 * each with `previous`, and zero the plaintext.
 *
 * @param sql - SQL client.
 * @param kekId - Current `NOSTR_NSEC_KEK_ID`.
 * @param previous - `NOSTR_NSEC_KEK_PREVIOUS`, or `undefined`.
 * @param batch - Page size.
 * @throws `KEK rotation stopped: <n> Nostr key(s) are stored under another
 *   NOSTR_NSEC_KEK_ID; set NOSTR_NSEC_KEK_PREVIOUS to the previous
 *   NOSTR_NSEC_KEK` when there are such rows and `previous` is unset;
 *   {@link nostrKeysDidNotOpen} with the total count when one does not open.
 */
async function assertStaleNostrEnvelopesOpen(
  sql: SqlClient,
  kekId: number,
  previous: Uint8Array | undefined,
  batch: number,
): Promise<void> {
  let stale = 0;
  let failed = 0;
  for (const read of STALE_NOSTR_PAGES) {
    let after: readonly string[] | null = null;
    for (;;) {
      const page: StaleEnvelope[] = await read(sql, kekId, after, batch);
      stale += page.length;
      if (previous !== undefined) {
        for (const row of page) {
          if (!(await opensWith(row, previous))) failed += 1;
        }
      }
      const last: StaleEnvelope | undefined = page.at(-1);
      if (last === undefined || page.length < batch) break;
      after = last.key;
    }
  }
  if (stale > 0 && previous === undefined) {
    throw new Error(
      `KEK rotation stopped: ${String(stale)} Nostr key(s) are stored under another NOSTR_NSEC_KEK_ID; set NOSTR_NSEC_KEK_PREVIOUS to the previous NOSTR_NSEC_KEK`,
    );
  }
  if (failed > 0) throw nostrKeysDidNotOpen(failed);
}

/**
 * Open every envelope of one batch with `previous` before its first write.
 *
 * @param rows - The batch.
 * @param previous - `NOSTR_NSEC_KEK_PREVIOUS`.
 * @returns The plaintexts in row order (the caller zeroes them).
 * @throws {@link nostrKeysDidNotOpen} when one does not open (every opened
 *   plaintext is zeroed first).
 */
async function openBatch(
  rows: readonly StaleEnvelope[],
  previous: Uint8Array,
): Promise<Uint8Array[]> {
  const opened: Uint8Array[] = [];
  let failed = 0;
  for (const row of rows) {
    try {
      opened.push(await openAesGcmEnvelope(row.envelope, previous, row.additionalData));
    } catch {
      failed += 1;
    }
  }
  if (failed > 0) {
    opened.forEach(zeroizeSecret);
    throw nostrKeysDidNotOpen(failed);
  }
  return opened;
}

/**
 * Rewrite every row one stale page source returns, in locked batches. Each
 * batch opens all its envelopes with `previous` before its first write, and
 * every plaintext is zeroed when the batch ends.
 *
 * @param sql - SQL client.
 * @param read - Page source.
 * @param kekId - Current `NOSTR_NSEC_KEK_ID`.
 * @param previous - `NOSTR_NSEC_KEK_PREVIOUS`.
 * @param batch - Rows per transaction.
 * @param write - Writes one row from its plaintext; `true` when it changed it.
 * @returns The rows `write` changed, in key order.
 */
async function rewriteStale(
  sql: SqlClient,
  read: StalePage,
  kekId: number,
  previous: Uint8Array,
  batch: number,
  write: (tx: SqlClient, row: StaleEnvelope, plaintext: Uint8Array) => Promise<boolean>,
): Promise<StaleEnvelope[]> {
  const changed: StaleEnvelope[] = [];
  let after: readonly string[] | null = null;
  for (;;) {
    const cursor: readonly string[] | null = after;
    const page: StaleEnvelope[] = await inTransaction<StaleEnvelope[]>(sql, async (tx) => {
      const rows = await read(tx, kekId, cursor, batch);
      const opened = await openBatch(rows, previous);
      try {
        for (const [index, row] of rows.entries()) {
          if (await write(tx, row, opened[index]!)) changed.push(row);
        }
      } finally {
        opened.forEach(zeroizeSecret);
      }
      return rows;
    });
    const last: StaleEnvelope | undefined = page.at(-1);
    if (last === undefined || page.length < batch) return changed;
    after = last.key;
  }
}

/**
 * Keep an opened old Nostr secret as a retired key: sealed under `kek` with
 * {@link nostrRetiredKeyAad}, keyed by owner and the pubkey the secret
 * derives. An existing row (a rerun) is left alone.
 *
 * @param tx - Transaction client.
 * @param ownerType - `account` or `shop`.
 * @param ownerId - Account id or shop note id.
 * @param secret - Old 32-byte secret (the caller zeroes it).
 * @param kek - Current `NOSTR_NSEC_KEK`.
 */
async function retireNostrKey(
  tx: SqlClient,
  ownerType: NostrRetiredKeyOwnerType,
  ownerId: string,
  secret: Uint8Array,
  kek: Uint8Array,
): Promise<void> {
  const pubkey = publicKeyHexFromSecret(secret);
  const kekId = kekIdOf(kek);
  const envelope = await sealAesGcmEnvelope(
    secret,
    kek,
    utf8(nostrRetiredKeyAad(ownerType, ownerId, pubkey)),
    kekId,
  );
  await tx.execute(
    `INSERT INTO nostr_retired_key (owner_type, owner_id, pubkey, nsec_ciphertext, kek_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (owner_type, owner_id, pubkey) DO NOTHING`,
    [ownerType, ownerId, pubkey, envelope, kekId],
  );
}

/** What the Nostr part of a rotation changed. */
interface NostrRotation {
  rotatedAccountIds: string[];
  rotatedShopMessageIds: string[];
  sparkViewer: number;
  retiredKeys: number;
}

/**
 * Rotate everything under another Nostr KEK id: retire and renew account and
 * shop keys, retire and renew the viewer, and seal retired keys of an
 * earlier rotation again under the current key.
 *
 * @param sql - SQL client.
 * @param kek - Current `NOSTR_NSEC_KEK`.
 * @param previous - `NOSTR_NSEC_KEK_PREVIOUS`.
 * @param keygen - Secret source.
 * @param batch - Rows per transaction.
 * @returns What changed.
 */
async function rotateNostrKeys(
  sql: SqlClient,
  kek: Uint8Array,
  previous: Uint8Array,
  keygen: NostrKeygen,
  batch: number,
): Promise<NostrRotation> {
  const kekId = kekIdOf(kek);
  const accounts = await rewriteStale(
    sql,
    staleAccounts,
    kekId,
    previous,
    batch,
    async (tx, row, secret) => {
      const id = row.key[0]!;
      const record = await generateNostrKeyRecord(id, kek, keygen);
      const updated = await tx.query<{ id: string }>(
        `UPDATE account
         SET nostr_pubkey = $2, nostr_nsec_ciphertext = $3, nostr_kek_id = $4,
             nostr_key_created_at = now()
         WHERE id = $1::uuid AND nostr_kek_id = $5 AND nostr_nsec_ciphertext IS NOT NULL
         RETURNING id::text AS id`,
        [id, record.pubkey, record.ciphertext, record.kekId, row.kekId],
      );
      if (updated.length === 0) return false;
      await retireNostrKey(tx, 'account', id, secret, kek);
      return true;
    },
  );
  const shops = await rewriteStale(
    sql,
    staleShops,
    kekId,
    previous,
    batch,
    async (tx, row, secret) => {
      const id = row.key[0]!;
      if (!(await rotateShopIdentityKey(tx, id, row.kekId, kek, keygen))) return false;
      await retireNostrKey(tx, 'shop', id, secret, kek);
      return true;
    },
  );
  const sparkViewer = (await rotateSparkViewerKey(sql, kek, previous)) ? 1 : 0;
  const retiredKeys = await rewriteStale(
    sql,
    staleRetiredKeys,
    kekId,
    previous,
    batch,
    async (tx, row, secret) => {
      const [ownerType, ownerId, pubkey] = row.key;
      const envelope = await sealAesGcmEnvelope(secret, kek, row.additionalData, kekId);
      const updated = await tx.query<{ pubkey: string }>(
        `UPDATE nostr_retired_key SET nsec_ciphertext = $4, kek_id = $5
         WHERE owner_type = $1 AND owner_id = $2 AND pubkey = $3 AND kek_id = $6
         RETURNING pubkey`,
        [ownerType, ownerId, pubkey, envelope, kekId, row.kekId],
      );
      return updated.length > 0;
    },
  );
  const retiredViewers = await rewriteStale(
    sql,
    staleRetiredViewers,
    kekId,
    previous,
    batch,
    async (tx, row, mnemonic) => {
      const envelope = await sealAesGcmEnvelope(mnemonic, kek, row.additionalData, kekId);
      const updated = await tx.query<{ identity_public_key: string }>(
        `UPDATE spark_viewer_retired_key SET mnemonic_ciphertext = $2, kek_id = $3
         WHERE identity_public_key = $1 AND kek_id = $4
         RETURNING identity_public_key`,
        [row.key[0], envelope, kekId, row.kekId],
      );
      return updated.length > 0;
    },
  );
  return {
    rotatedAccountIds: accounts.map((row) => row.key[0]!),
    rotatedShopMessageIds: shops.map((row) => row.key[0]!),
    sparkViewer,
    retiredKeys: retiredKeys.length + retiredViewers.length,
  };
}

/** One stored share read by the rotation. */
interface ShareRow {
  account_id: string;
  spark_pubkey: string;
  recovery_share_ciphertext: Uint8Array;
}

/** Keyset position after the last share of a page. */
interface ShareCursor {
  accountId: string;
  sparkPubkey: string;
}

/**
 * One keyset page of the recovery shares under another KEK id.
 *
 * @param sql - SQL client (or transaction client).
 * @param idBytes - Envelope bytes 1–4 of the current recovery KEK id.
 * @param cursor - Position after the previous page, or `null` for the first.
 * @param batch - Page size.
 * @returns At most `batch` shares in `(account_id, spark_pubkey)` order.
 */
async function readSharePage(
  sql: SqlClient,
  idBytes: Uint8Array,
  cursor: ShareCursor | null,
  batch: number,
): Promise<ShareRow[]> {
  return sql.query<ShareRow>(
    `SELECT account_id::text AS account_id, spark_pubkey, recovery_share_ciphertext
     FROM recovery_share
     WHERE substring(recovery_share_ciphertext FROM 2 FOR 4) <> $1::bytea
       AND ($2::uuid IS NULL OR (account_id, spark_pubkey) > ($2::uuid, $3::text))
     ORDER BY account_id, spark_pubkey
     LIMIT $4`,
    [idBytes, cursor?.accountId ?? null, cursor?.sparkPubkey ?? null, batch],
  );
}

/**
 * The fail-loud error of a share that does not open with the previous key.
 *
 * @param failed - How many shares did not open.
 * @returns The error; it names only the count.
 */
function sharesDidNotOpen(failed: number): Error {
  return new Error(
    `KEK rotation stopped: ${String(failed)} recovery share(s) did not open with RECOVERY_SHARE_KEK_PREVIOUS`,
  );
}

/**
 * Read-only pass over every recovery share under another KEK id (same
 * keyset order and page size as the writes): open each with `previous`,
 * zero the plaintext, and count the shares that do not open.
 *
 * @param sql - SQL client.
 * @param idBytes - Envelope bytes 1–4 of the current recovery KEK id.
 * @param previous - Previous recovery KEK.
 * @param batch - Page size.
 * @throws {@link sharesDidNotOpen} with the total count when any share does not open.
 */
async function assertSharesOpen(
  sql: SqlClient,
  idBytes: Uint8Array,
  previous: Uint8Array,
  batch: number,
): Promise<void> {
  let failed = 0;
  let cursor: ShareCursor | null = null;
  for (;;) {
    const page: ShareRow[] = await readSharePage(sql, idBytes, cursor, batch);
    for (const row of page) {
      const sample: KekSample = {
        envelope: new Uint8Array(row.recovery_share_ciphertext),
        additionalData: utf8(row.account_id),
      };
      if (!(await opensWith(sample, previous))) failed += 1;
    }
    const last: ShareRow | undefined = page.at(-1);
    if (last === undefined || page.length < batch) break;
    cursor = { accountId: last.account_id, sparkPubkey: last.spark_pubkey };
  }
  if (failed > 0) throw sharesDidNotOpen(failed);
}

/**
 * Seal every recovery share under another KEK id again under the current
 * recovery KEK, or, without a previous key, count them and warn once.
 * Before the first write, a read-only pass opens EVERY such share with the
 * previous key; when one does not open, nothing is written.
 *
 * @param sql - SQL client.
 * @param current - Current recovery KEK.
 * @param previous - Previous recovery KEK, or `undefined`.
 * @param batch - Rows per transaction.
 * @returns Rotated and pending counts.
 * @throws When a share does not open with `previous`: the error names only
 *   the count, and no share is changed. A share that changes between the
 *   read-only pass and its batch so that it no longer opens stops the run
 *   before that batch writes (earlier batches, all verified, stay rotated).
 */
async function rotateRecoveryShares(
  sql: SqlClient,
  current: Uint8Array,
  previous: Uint8Array | undefined,
  batch: number,
): Promise<{ rotated: number; pending: number }> {
  const idBytes = kekIdBytes(kekIdOf(current));
  if (previous === undefined) {
    const rows = await sql.query<{ pending: number | string }>(
      `SELECT count(*)::int AS pending FROM recovery_share
       WHERE substring(recovery_share_ciphertext FROM 2 FOR 4) <> $1::bytea`,
      [idBytes],
    );
    const pending = Number(rows[0]?.pending ?? 0);
    if (pending > 0) {
      logEvent('kek.rotation.recovery_share.pending', { count: pending });
    }
    return { rotated: 0, pending };
  }
  await assertSharesOpen(sql, idBytes, previous, batch);
  let rotated = 0;
  let after: ShareCursor | null = null;
  for (;;) {
    const cursor: ShareCursor | null = after;
    const page: ShareRow[] = await inTransaction<ShareRow[]>(sql, async (tx) => {
      const rows: ShareRow[] = await readSharePage(tx, idBytes, cursor, batch);
      // Every share passed assertSharesOpen; open the whole batch again before
      // its first write, so a share changed since then changes nothing here.
      const sealed: Array<{ row: ShareRow; envelope: Uint8Array }> = [];
      let failed = 0;
      for (const row of rows) {
        try {
          sealed.push({
            row,
            envelope: await reencryptRecoveryShare(
              new Uint8Array(row.recovery_share_ciphertext),
              previous,
              current,
              row.account_id,
            ),
          });
        } catch {
          failed += 1;
        }
      }
      if (failed > 0) throw sharesDidNotOpen(failed);
      for (const { row, envelope } of sealed) {
        const updated = await tx.query<{ account_id: string }>(
          `UPDATE recovery_share SET recovery_share_ciphertext = $3
           WHERE account_id = $1::uuid AND spark_pubkey = $2 AND recovery_share_ciphertext = $4
           RETURNING account_id::text AS account_id`,
          [row.account_id, row.spark_pubkey, envelope, row.recovery_share_ciphertext],
        );
        if (updated.length > 0) rotated += 1;
      }
      return rows;
    });
    const last: ShareRow | undefined = page.at(-1);
    if (last === undefined || page.length < batch) return { rotated, pending: 0 };
    after = { accountId: last.account_id, sparkPubkey: last.spark_pubkey };
  }
}

/**
 * Rotate every key stored under a KEK id other than the current one: fresh
 * Nostr key pairs for accounts and shops (each old key kept as a retired key
 * in `nostr_retired_key`), a fresh Spark viewer mnemonic (the old one kept in
 * `spark_viewer_retired_key`), retired keys of an earlier rotation sealed
 * again under the current Nostr KEK, and recovery shares sealed again under
 * the current recovery KEK (only when `previousRecoveryShareKek` is set;
 * otherwise they stay and `kek.rotation.recovery_share.pending` logs their
 * count). Idempotent: a run with nothing under another id changes nothing.
 *
 * First, before any write, it opens one stored envelope under the current
 * Nostr KEK id (an account key, else a shop key, else the Spark viewer
 * mnemonic, else a retired key, else a retired viewer) with `nostrKek`, and
 * one recovery share under the current recovery id with `recoveryShareKek`,
 * zeroing the plaintext; with no row under an id there is nothing to check.
 * A new key value always needs a new id. Then a read-only pass opens every
 * Nostr-KEK envelope under another id with `previousNostrKek` (required as
 * soon as one exists). Before the first recovery share is written, every
 * share under another id is opened with the previous recovery key in a
 * read-only pass. Every opened secret is zeroed; none is returned or logged.
 *
 * @param sql - SQL client with transactions (after every schema migration).
 * @param config - Current keys (bound to their ids), the previous Nostr and
 *   recovery keys, and optional keygen and batch size.
 * @returns Counts per category, and the rotated account and shop ids for the
 *   republish of their announcements.
 * @throws `NOSTR_NSEC_KEK does not open the keys stored under
 *   NOSTR_NSEC_KEK_ID <id>; a new key value needs a new id` or
 *   `RECOVERY_SHARE_KEK does not open the recovery shares stored under
 *   RECOVERY_SHARE_KEK_ID <id>; a new key value needs a new id` (nothing
 *   written); `KEK rotation stopped: <n> Nostr key(s) are stored under
 *   another NOSTR_NSEC_KEK_ID; set NOSTR_NSEC_KEK_PREVIOUS to the previous
 *   NOSTR_NSEC_KEK` or `KEK rotation stopped: <n> Nostr key(s) did not open
 *   with NOSTR_NSEC_KEK_PREVIOUS` (nothing written);
 *   Error('KEK rotation needs SQL transactions') without a transaction port;
 *   `KEK rotation stopped: <n> recovery share(s) did not open with
 *   RECOVERY_SHARE_KEK_PREVIOUS` when the previous key does not open every
 *   share (no share is deleted or overwritten); SQL and key generation errors.
 */
export async function rotateKeks(
  sql: SqlClient,
  config: KekRotationConfig,
): Promise<KekRotationResult> {
  await assertCurrentKeksOpenStoredRows(sql, config.nostrKek, config.recoveryShareKek);
  const keygen = config.keygen ?? defaultNostrKeygen;
  const batch = config.batchSize ?? KEK_ROTATION_BATCH;
  const previous = config.previousNostrKek;
  await assertStaleNostrEnvelopesOpen(sql, kekIdOf(config.nostrKek), previous, batch);
  // Without a previous key the read-only pass found no row under another id.
  const nostr: NostrRotation =
    previous === undefined
      ? { rotatedAccountIds: [], rotatedShopMessageIds: [], sparkViewer: 0, retiredKeys: 0 }
      : await rotateNostrKeys(sql, config.nostrKek, previous, keygen, batch);
  const shares = await rotateRecoveryShares(
    sql,
    config.recoveryShareKek,
    config.previousRecoveryShareKek,
    batch,
  );
  return {
    accounts: nostr.rotatedAccountIds.length,
    shops: nostr.rotatedShopMessageIds.length,
    sparkViewer: nostr.sparkViewer,
    retiredKeys: nostr.retiredKeys,
    recoveryShares: shares.rotated,
    recoverySharesPending: shares.pending,
    rotatedAccountIds: nostr.rotatedAccountIds,
    rotatedShopMessageIds: nostr.rotatedShopMessageIds,
  };
}
