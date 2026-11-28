/**
 * Retired custodial Nostr keys (`nostr_retired_key`).
 *
 * KEK rotation (`rotateKeks`) gives every member and shop a fresh key pair.
 * The old key is kept here, sealed under the current `NOSTR_NSEC_KEK` with
 * additional data bound to its owner and public key
 * ({@link nostrRetiredKeyAad}). A retired ACCOUNT key has exactly one job:
 * signing the NIP-09 kind 5 deletion of a note that this key signed, when
 * staff delete it (relays honour a deletion only from the pubkey of the
 * deleted event). A retired SHOP key is kept only so the shop's old key stays
 * available should a deletion path for shop events be added; today nothing
 * signs with a retired shop key. A retired key never signs anything else, is
 * never used to attribute an inbound event, and is never returned or logged.
 *
 * Deleting an account or a shop identity deletes its retired keys in the
 * same statement (row triggers `trg_account_nostr_retired_key` and
 * `trg_shop_identity_nostr_retired_key`); an account merge deletes the
 * source's retired keys explicitly first.
 */

import type { SqlClient } from '@/lib/auth/sql';

/** Owner kind of a retired key: a member account or a shop identity. */
export type NostrRetiredKeyOwnerType = 'account' | 'shop';

/** One stored retired key (ciphertext only). */
export interface NostrRetiredKey {
  /** AES-256-GCM envelope of the 32-byte secret, under {@link nostrRetiredKeyAad}. */
  ciphertext: Uint8Array;
  /** `NOSTR_NSEC_KEK_ID` the envelope is sealed under. */
  kekId: number;
}

/** Read port of the retired keys (the deletion signer's only access). */
export interface NostrRetiredKeyStore {
  /**
   * The retired key of one owner with one public key.
   *
   * @param ownerType - `account` or `shop`.
   * @param ownerId - Account id, or shop note id.
   * @param pubkey - 64 lowercase hex public key.
   * @returns The stored envelope, or `undefined`.
   */
  getRetiredKey(
    ownerType: NostrRetiredKeyOwnerType,
    ownerId: string,
    pubkey: string,
  ): Promise<NostrRetiredKey | undefined>;
}

/**
 * Fixed `pg_advisory_xact_lock` key of the retired-key migration; every
 * statement of {@link NOSTR_RETIRED_KEY_SCHEMA_SQL} takes it first.
 */
const NOSTR_RETIRED_KEY_MIGRATION_LOCK = 21_499_041;

/**
 * Wrap one migration statement in a `DO` block that takes
 * {@link NOSTR_RETIRED_KEY_MIGRATION_LOCK} first, so concurrent boots run the
 * statements one at a time.
 *
 * @param body - Statements to run under the lock, without the final `;`.
 * @returns The `DO` statement.
 */
function serializedStep(body: string): string {
  return `DO $nostr_retired_key$
BEGIN
  PERFORM pg_advisory_xact_lock(${String(NOSTR_RETIRED_KEY_MIGRATION_LOCK)});
  ${body};
END;
$nostr_retired_key$`;
}

/**
 * Create one AFTER DELETE row trigger when it does not exist yet.
 *
 * @param table - Owner table.
 * @param trigger - Trigger name.
 * @param fn - Trigger function name.
 * @returns Statement body for {@link serializedStep}.
 */
function cleanupTrigger(table: string, trigger: string, fn: string): string {
  return `IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.${table}'::regclass AND tgname = '${trigger}'
  ) THEN
    CREATE TRIGGER ${trigger} AFTER DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION ${fn}();
  END IF`;
}

/**
 * Idempotent SQL for `nostr_retired_key`, its pubkey index and the two
 * cleanup triggers (matches `docs/schema/nostr_retired_key.sql`). Runs after
 * `account` and `shop_identity` exist and before `migrateDbChangeSchema`, so
 * `trg_db_change` attaches to the table.
 */
export const NOSTR_RETIRED_KEY_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS nostr_retired_key (
     owner_type text NOT NULL CHECK (owner_type IN ('account', 'shop')),
     owner_id text NOT NULL,
     pubkey text NOT NULL CHECK (pubkey ~ '^[0-9a-f]{64}$'),
     nsec_ciphertext bytea NOT NULL,
     kek_id integer NOT NULL CHECK (kek_id >= 1),
     retired_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (owner_type, owner_id, pubkey)
   )`,
  `CREATE INDEX IF NOT EXISTS nostr_retired_key_pubkey_idx ON nostr_retired_key (pubkey)`,
  `CREATE OR REPLACE FUNCTION drop_account_nostr_retired_keys() RETURNS trigger AS $$
   BEGIN
     DELETE FROM nostr_retired_key WHERE owner_type = 'account' AND owner_id = OLD.id::text;
     RETURN OLD;
   END
   $$ LANGUAGE plpgsql`,
  cleanupTrigger('account', 'trg_account_nostr_retired_key', 'drop_account_nostr_retired_keys'),
  `CREATE OR REPLACE FUNCTION drop_shop_nostr_retired_keys() RETURNS trigger AS $$
   BEGIN
     DELETE FROM nostr_retired_key WHERE owner_type = 'shop' AND owner_id = OLD.message_id::text;
     RETURN OLD;
   END
   $$ LANGUAGE plpgsql`,
  cleanupTrigger(
    'shop_identity',
    'trg_shop_identity_nostr_retired_key',
    'drop_shop_nostr_retired_keys',
  ),
].map(serializedStep);

/**
 * Apply {@link NOSTR_RETIRED_KEY_SCHEMA_SQL} in order. Idempotent.
 *
 * @param sql - Parameter-bound SQL client (after the auth and shop identity migrations).
 * @returns Resolves when every statement has run.
 */
export async function migrateNostrRetiredKeySchema(sql: SqlClient): Promise<void> {
  for (const statement of NOSTR_RETIRED_KEY_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}

/**
 * AES-GCM additional data of a retired key: it binds the envelope to its
 * owner kind, owner id and public key, so it never opens as a current account
 * or shop key, nor as another owner's or another pubkey's retired key.
 *
 * @param ownerType - `account` or `shop`.
 * @param ownerId - Account id, or shop note id.
 * @param pubkey - 64 lowercase hex public key of the retired key.
 * @returns `nostr_retired_key:<ownerType>:<ownerId>:<pubkey>`.
 */
export function nostrRetiredKeyAad(
  ownerType: NostrRetiredKeyOwnerType,
  ownerId: string,
  pubkey: string,
): string {
  return `nostr_retired_key:${ownerType}:${ownerId}:${pubkey}`;
}

/** Postgres reader of `nostr_retired_key`. */
export class PostgresNostrRetiredKeyStore implements NostrRetiredKeyStore {
  /**
   * @param sql - Migrated SQL client.
   */
  constructor(private readonly sql: SqlClient) {}

  async getRetiredKey(
    ownerType: NostrRetiredKeyOwnerType,
    ownerId: string,
    pubkey: string,
  ): Promise<NostrRetiredKey | undefined> {
    const [row] = await this.sql.query<{ nsec_ciphertext: Uint8Array; kek_id: number | string }>(
      `SELECT nsec_ciphertext, kek_id FROM nostr_retired_key
       WHERE owner_type = $1 AND owner_id = $2 AND pubkey = $3`,
      [ownerType, ownerId, pubkey],
    );
    return row === undefined
      ? undefined
      : { ciphertext: new Uint8Array(row.nsec_ciphertext), kekId: Number(row.kek_id) };
  }
}
