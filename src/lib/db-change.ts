/**
 * Append-only Postgres row-change log (`db_change`) and its migrate.
 */

import type { SqlClient } from '@/lib/auth/sql';

/** Idempotent DDL for the append-only change log (matches `docs/schema/db_change.sql`). */
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
  FOREACH k IN ARRAY ARRAY['token', 'challenge', 'nostr_nsec_ciphertext', 'nonce']
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
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO db_change (table_name, op, before, after)
      VALUES (TG_TABLE_NAME, 'INSERT', NULL, db_change_redact(to_jsonb(NEW)));
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF to_jsonb(OLD) IS NOT DISTINCT FROM to_jsonb(NEW) THEN
      RETURN NEW;
    END IF;
    INSERT INTO db_change (table_name, op, before, after)
      VALUES (TG_TABLE_NAME, 'UPDATE', db_change_redact(to_jsonb(OLD)), db_change_redact(to_jsonb(NEW)));
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
  `DROP TRIGGER IF EXISTS db_change_immutable ON db_change;`,
  `CREATE TRIGGER db_change_immutable BEFORE UPDATE OR DELETE ON db_change FOR EACH ROW EXECUTE PROCEDURE db_change_immutable();`,
  `DROP TRIGGER IF EXISTS db_change_no_truncate ON db_change;`,
  `CREATE TRIGGER db_change_no_truncate BEFORE TRUNCATE ON db_change FOR EACH STATEMENT EXECUTE PROCEDURE db_change_immutable();`,
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
