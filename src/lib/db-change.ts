/**
 * Append-only Postgres row-change log (`db_change`) and its migrate.
 *
 * On UPDATE, every bytea column (found via `pg_attribute` on `TG_RELID`) whose
 * value is unchanged and was not hashed by `db_change_redact` is stored in both
 * `before` and `after` as an object with `unchanged` true, `sha256` as the hex
 * digest of the column text, and `bytes` as the `octet_length` of that text.
 * INSERT, DELETE, and the UPDATE that changes the bytes keep the full value, so
 * any row state is reconstructable by chaining to the latest earlier full image.
 * Secret columns keep their sha256 hash. The no-op comparison still happens on
 * the raw images before redaction.
 */

import type { SqlClient } from '@/lib/auth/sql';

/** Idempotent SQL for the append-only change log (DDL, the `log_db_change` trigger body that stores an unchanged bytea column as a `sha256` reference instead of the full value, and the one-time live `view_key` rewrite; matches `docs/schema/db_change.sql`). */
export const DB_CHANGE_SCHEMA_SQL: readonly string[] = [
  `CREATE EXTENSION IF NOT EXISTS pgcrypto;`,
  `CREATE TABLE IF NOT EXISTS db_change (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  table_name text NOT NULL,
  op text NOT NULL CHECK (op IN ('INSERT', 'UPDATE', 'DELETE')),
  before jsonb,
  after jsonb
);`,
  `CREATE INDEX IF NOT EXISTS db_change_at_idx ON db_change (at);`,
  `CREATE INDEX IF NOT EXISTS db_change_table_at_idx ON db_change (table_name, at);`,
  `CREATE OR REPLACE FUNCTION db_change_redact(j jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $dbch$
DECLARE
  k text;
  outj jsonb := j;
BEGIN
  IF j IS NULL THEN
    RETURN NULL;
  END IF;
  FOREACH k IN ARRAY ARRAY['token', 'challenge', 'nostr_nsec_ciphertext', 'nonce', 'view_key', 'endpoint', 'p256dh', 'auth', 'delivered_endpoints']
  LOOP
    IF outj ? k AND jsonb_typeof(outj -> k) IS DISTINCT FROM 'null' THEN
      outj := jsonb_set(
        outj,
        ARRAY[k],
        to_jsonb(encode(digest(convert_to(outj ->> k, 'UTF8'), 'sha256'), 'hex'))
      );
    END IF;
  END LOOP;
  RETURN outj;
END;
$dbch$;`,
  `CREATE OR REPLACE FUNCTION log_db_change() RETURNS trigger
LANGUAGE plpgsql AS $dbch$
DECLARE
  rawold jsonb;
  rawnew jsonb;
  beforej jsonb;
  afterj jsonb;
  k text;
  ref jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO db_change (table_name, op, before, after)
      VALUES (TG_TABLE_NAME, 'INSERT', NULL, db_change_redact(to_jsonb(NEW)));
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    rawold := to_jsonb(OLD);
    rawnew := to_jsonb(NEW);
    IF rawold IS NOT DISTINCT FROM rawnew THEN
      RETURN NEW;
    END IF;
    beforej := db_change_redact(rawold);
    afterj := db_change_redact(rawnew);
    -- A bytea column whose value did not change is logged once, on the
    -- INSERT/UPDATE/DELETE that carries a different value. In between, both
    -- images hold {unchanged, sha256, bytes} so the row stays reconstructable
    -- by chaining. Columns db_change_redact hashed keep their hash.
    FOR k IN
      SELECT a.attname::text
      FROM pg_attribute a
      WHERE a.attrelid = TG_RELID
        AND a.atttypid = 'bytea'::regtype
        AND a.attnum > 0
        AND NOT a.attisdropped
    LOOP
      IF jsonb_typeof(rawold -> k) = 'string'
         AND rawold -> k = rawnew -> k
         AND beforej -> k = rawold -> k THEN
        ref := jsonb_build_object(
          'unchanged', true,
          'sha256', encode(digest(convert_to(rawold ->> k, 'UTF8'), 'sha256'), 'hex'),
          'bytes', octet_length(rawold ->> k)
        );
        beforej := jsonb_set(beforej, ARRAY[k], ref);
        afterj := jsonb_set(afterj, ARRAY[k], ref);
      END IF;
    END LOOP;
    INSERT INTO db_change (table_name, op, before, after)
      VALUES (TG_TABLE_NAME, 'UPDATE', beforej, afterj);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO db_change (table_name, op, before, after)
      VALUES (TG_TABLE_NAME, 'DELETE', db_change_redact(to_jsonb(OLD)), NULL);
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$dbch$;`,
  `CREATE OR REPLACE FUNCTION db_change_immutable() RETURNS trigger
LANGUAGE plpgsql AS $dbch$
BEGIN
  RAISE EXCEPTION 'db_change is append-only';
END;
$dbch$;`,
  `DO $guard$
BEGIN
  DROP TRIGGER IF EXISTS db_change_immutable ON db_change;
  UPDATE db_change AS d
  SET after = jsonb_set(
    d.after,
    '{view_key}',
    to_jsonb(encode(digest(convert_to(d.after ->> 'view_key', 'UTF8'), 'sha256'), 'hex'))
  )
  WHERE d.table_name = 'account'
    AND d.after ? 'view_key'
    AND jsonb_typeof(d.after -> 'view_key') IS DISTINCT FROM 'null'
    AND EXISTS (
      SELECT 1 FROM account a
      WHERE a.view_key IS NOT NULL AND a.view_key = d.after ->> 'view_key'
    );
  UPDATE db_change AS d
  SET before = jsonb_set(
    d.before,
    '{view_key}',
    to_jsonb(encode(digest(convert_to(d.before ->> 'view_key', 'UTF8'), 'sha256'), 'hex'))
  )
  WHERE d.table_name = 'account'
    AND d.before ? 'view_key'
    AND jsonb_typeof(d.before -> 'view_key') IS DISTINCT FROM 'null'
    AND EXISTS (
      SELECT 1 FROM account a
      WHERE a.view_key IS NOT NULL AND a.view_key = d.before ->> 'view_key'
    );
  CREATE TRIGGER db_change_immutable BEFORE UPDATE OR DELETE ON db_change FOR EACH ROW EXECUTE PROCEDURE db_change_immutable();
  DROP TRIGGER IF EXISTS db_change_no_truncate ON db_change;
  CREATE TRIGGER db_change_no_truncate BEFORE TRUNCATE ON db_change FOR EACH STATEMENT EXECUTE PROCEDURE db_change_immutable();
END;
$guard$;`,
  `DO $attach$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'db_change'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_db_change ON %I', r.tablename);
    EXECUTE format('CREATE TRIGGER trg_db_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE PROCEDURE log_db_change()', r.tablename);
  END LOOP;
END;
$attach$;`,
];

/**
 * Apply {@link DB_CHANGE_SCHEMA_SQL} in order. Idempotent.
 *
 * @param sql - Parameter-bound SQL client.
 * @returns Resolves when every statement has executed.
 */
export async function migrateDbChangeSchema(sql: SqlClient): Promise<void> {
  for (const statement of DB_CHANGE_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}
