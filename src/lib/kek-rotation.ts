/**
 * KEK rotation at boot: renew everything stored under a KEK id other than
 * the configured current one (`NOSTR_NSEC_KEK_ID`, `RECOVERY_SHARE_KEK_ID`).
 *
 * - Member Nostr keys (`account`) and shop Nostr keys (`shop_identity`) get a
 *   fresh key pair under the current Nostr KEK. The old secret is never
 *   decrypted; there is no previous Nostr KEK.
 * - The Spark viewer key gets a fresh mnemonic under the current Nostr KEK.
 * - Recovery shares cannot be renewed without the member, so each one is
 *   opened with `RECOVERY_SHARE_KEK_PREVIOUS` and sealed again under the
 *   current recovery KEK with the same additional data (the account id).
 *
 * Every write is a plain UPDATE (recorded by `trg_db_change`), conditional on
 * the old value (compare-and-set), in transactions of at most
 * {@link KEK_ROTATION_BATCH} rows that each take {@link KEK_ROTATION_LOCK}
 * first, so concurrent boots never rotate at the same time and a rerun after
 * a crash continues where it stopped. A second run changes nothing.
 *
 * Before anything is written, one stored envelope under each current id is
 * opened with the current key: a new key value under an id that is already
 * in use would otherwise leave those rows unreadable and unrotated.
 */

import type { SqlClient } from '@/lib/auth/sql';
import { openAesGcmEnvelope } from '@/lib/aes-gcm-envelope';
import { reencryptRecoveryShare } from '@/lib/auth/recovery-share';
import { logEvent } from '@/lib/log';
import { kekIdOf } from '@/lib/nostr/kek';
import {
  defaultNostrKeygen,
  generateNostrKeyRecord,
  zeroizeSecret,
  type NostrKeygen,
} from '@/lib/nostr/keys';
import { rotateShopIdentityKey } from '@/lib/shop-identity';
import { rotateSparkViewerKey } from '@/lib/spark-viewer';

/**
 * Fixed `pg_advisory_xact_lock` key of KEK rotation. Every rotation batch
 * transaction takes it before it reads its rows.
 */
const KEK_ROTATION_LOCK = 21_499_031;

/** Most rows one rotation transaction reads and rewrites. */
const KEK_ROTATION_BATCH = 200;

/** Keys and collaborators of one rotation run. */
export interface KekRotationConfig {
  /** Current `NOSTR_NSEC_KEK`, bound to `NOSTR_NSEC_KEK_ID`. */
  nostrKek: Uint8Array;
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
  /** Accounts that got a fresh Nostr key pair. */
  accounts: number;
  /** Shops that got a fresh Nostr key pair. */
  shops: number;
  /** 1 when the Spark viewer key was replaced, else 0. */
  sparkViewer: number;
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

/** One stored envelope the boot check opens, with its additional data. */
interface KekSample {
  envelope: Uint8Array;
  additionalData: string;
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
  const additionalData = new TextEncoder().encode(sample.additionalData);
  try {
    zeroizeSecret(await openAesGcmEnvelope(sample.envelope, kek, additionalData));
    return true;
  } catch {
    return false;
  }
}

/**
 * One envelope stored under the current Nostr KEK id: an account key, else a
 * shop key, else the Spark viewer mnemonic (additional data
 * `spark_viewer_key`, as `src/lib/spark-viewer.ts` seals it).
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
      additionalData: account.account_id,
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
      additionalData: `shop:${shop.message_id}`,
    };
  }
  const [viewer] = await sql.query<{ viewer_mnemonic_ciphertext: Uint8Array }>(
    `SELECT viewer_mnemonic_ciphertext FROM spark_viewer_key WHERE singleton = true
       AND viewer_kek_id = $1`,
    [kekId],
  );
  return viewer === undefined
    ? undefined
    : {
        envelope: new Uint8Array(viewer.viewer_mnemonic_ciphertext),
        additionalData: 'spark_viewer_key',
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
        additionalData: share.account_id,
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

/** One account row read by the rotation. */
interface KeyRowRef {
  id: string;
  nostr_kek_id: number | string;
}

/**
 * Give every account whose key is under another KEK id a fresh key pair.
 *
 * @param sql - SQL client.
 * @param kek - Current Nostr KEK.
 * @param keygen - Secret source.
 * @param batch - Rows per transaction.
 * @returns Ids of the rotated accounts.
 */
async function rotateAccountKeys(
  sql: SqlClient,
  kek: Uint8Array,
  keygen: NostrKeygen,
  batch: number,
): Promise<string[]> {
  const kekId = kekIdOf(kek);
  const rotated: string[] = [];
  let after: string | null = null;
  for (;;) {
    const cursor: string | null = after;
    const page: KeyRowRef[] = await inTransaction<KeyRowRef[]>(sql, async (tx) => {
      const rows: KeyRowRef[] = await tx.query<KeyRowRef>(
        `SELECT id::text AS id, nostr_kek_id FROM account
         WHERE nostr_nsec_ciphertext IS NOT NULL AND nostr_kek_id <> $1
           AND ($2::uuid IS NULL OR id > $2::uuid)
         ORDER BY id
         LIMIT $3`,
        [kekId, cursor, batch],
      );
      for (const row of rows) {
        const record = await generateNostrKeyRecord(row.id, kek, keygen);
        const updated = await tx.query<{ id: string }>(
          `UPDATE account
           SET nostr_pubkey = $2, nostr_nsec_ciphertext = $3, nostr_kek_id = $4,
               nostr_key_created_at = now()
           WHERE id = $1::uuid AND nostr_kek_id = $5 AND nostr_nsec_ciphertext IS NOT NULL
           RETURNING id::text AS id`,
          [row.id, record.pubkey, record.ciphertext, record.kekId, Number(row.nostr_kek_id)],
        );
        if (updated.length > 0) rotated.push(row.id);
      }
      return rows;
    });
    const last: KeyRowRef | undefined = page.at(-1);
    if (last === undefined || page.length < batch) return rotated;
    after = last.id;
  }
}

/** One shop row read by the rotation. */
interface ShopRowRef {
  message_id: string;
  nostr_kek_id: number | string;
}

/**
 * Give every shop whose key is under another KEK id a fresh key pair.
 *
 * @param sql - SQL client.
 * @param kek - Current Nostr KEK.
 * @param keygen - Secret source.
 * @param batch - Rows per transaction.
 * @returns Note ids of the rotated shops.
 */
async function rotateShopKeys(
  sql: SqlClient,
  kek: Uint8Array,
  keygen: NostrKeygen,
  batch: number,
): Promise<string[]> {
  const kekId = kekIdOf(kek);
  const rotated: string[] = [];
  let after: string | null = null;
  for (;;) {
    const cursor: string | null = after;
    const page: ShopRowRef[] = await inTransaction<ShopRowRef[]>(sql, async (tx) => {
      const rows: ShopRowRef[] = await tx.query<ShopRowRef>(
        `SELECT message_id::text AS message_id, nostr_kek_id FROM shop_identity
         WHERE nostr_kek_id <> $1 AND ($2::uuid IS NULL OR message_id > $2::uuid)
         ORDER BY message_id
         LIMIT $3`,
        [kekId, cursor, batch],
      );
      for (const row of rows) {
        if (
          await rotateShopIdentityKey(tx, row.message_id, Number(row.nostr_kek_id), kek, keygen)
        ) {
          rotated.push(row.message_id);
        }
      }
      return rows;
    });
    const last: ShopRowRef | undefined = page.at(-1);
    if (last === undefined || page.length < batch) return rotated;
    after = last.message_id;
  }
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
        additionalData: row.account_id,
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
 * Nostr key pairs for accounts and shops, a fresh Spark viewer mnemonic, and
 * recovery shares sealed again under the current recovery KEK (only when
 * `previousRecoveryShareKek` is set; otherwise they stay and
 * `kek.rotation.recovery_share.pending` logs their count). Idempotent: a run
 * with nothing under another id changes nothing.
 *
 * First, before any write, it opens one stored envelope under the current
 * Nostr KEK id (an account key, else a shop key, else the Spark viewer
 * mnemonic) with `nostrKek`, and one recovery share under the current
 * recovery id with `recoveryShareKek`, zeroing the plaintext; with no row
 * under an id there is nothing to check. A new key value always needs a new
 * id. Then, before the first recovery share is written, every share under
 * another id is opened with the previous key in a read-only pass; one that
 * does not open stops the run with the total count and no share changed.
 *
 * @param sql - SQL client with transactions (after every schema migration).
 * @param config - Current keys (bound to their ids), the previous recovery
 *   key, and optional keygen and batch size.
 * @returns Counts per category, and the rotated account and shop ids for the
 *   republish of their announcements.
 * @throws `NOSTR_NSEC_KEK does not open the keys stored under
 *   NOSTR_NSEC_KEK_ID <id>; a new key value needs a new id` or
 *   `RECOVERY_SHARE_KEK does not open the recovery shares stored under
 *   RECOVERY_SHARE_KEK_ID <id>; a new key value needs a new id` (nothing
 *   written); Error('KEK rotation needs SQL transactions') without a
 *   transaction port; `KEK rotation stopped: <n> recovery share(s) did not
 *   open with RECOVERY_SHARE_KEK_PREVIOUS` when the previous key does not open
 *   every share (no share is deleted or overwritten); SQL and key generation
 *   errors.
 */
export async function rotateKeks(
  sql: SqlClient,
  config: KekRotationConfig,
): Promise<KekRotationResult> {
  await assertCurrentKeksOpenStoredRows(sql, config.nostrKek, config.recoveryShareKek);
  const keygen = config.keygen ?? defaultNostrKeygen;
  const batch = config.batchSize ?? KEK_ROTATION_BATCH;
  const rotatedAccountIds = await rotateAccountKeys(sql, config.nostrKek, keygen, batch);
  const rotatedShopMessageIds = await rotateShopKeys(sql, config.nostrKek, keygen, batch);
  const sparkViewer = (await rotateSparkViewerKey(sql, config.nostrKek)) ? 1 : 0;
  const shares = await rotateRecoveryShares(
    sql,
    config.recoveryShareKek,
    config.previousRecoveryShareKek,
    batch,
  );
  return {
    accounts: rotatedAccountIds.length,
    shops: rotatedShopMessageIds.length,
    sparkViewer,
    recoveryShares: shares.rotated,
    recoverySharesPending: shares.pending,
    rotatedAccountIds,
    rotatedShopMessageIds,
  };
}
