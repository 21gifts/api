import { describe, it, expect } from 'vitest';
import { AUTH_SCHEMA_SQL } from '@/lib/auth/schema';

describe('AUTH_SCHEMA_SQL', () => {
  it('creates the auth tables and backfills account.name idempotently', () => {
    expect(AUTH_SCHEMA_SQL.length).toBeGreaterThanOrEqual(8);
    expect(AUTH_SCHEMA_SQL[0]).toMatch(/CREATE TABLE IF NOT EXISTS account/i);
    expect(AUTH_SCHEMA_SQL[0]).toMatch(/\bname text\b/i);
    expect(AUTH_SCHEMA_SQL[0]).not.toMatch(/linking_key text NOT NULL/i);
    expect(AUTH_SCHEMA_SQL[0]).not.toMatch(/view_key/i);
    expect(AUTH_SCHEMA_SQL[1]).toMatch(/ALTER TABLE account ADD COLUMN IF NOT EXISTS name text/i);
    expect(AUTH_SCHEMA_SQL[2]).toMatch(
      /ALTER TABLE account ALTER COLUMN linking_key DROP NOT NULL/i,
    );
    expect(AUTH_SCHEMA_SQL[3]).toMatch(/DROP TABLE IF EXISTS auth_challenge/i);
    expect(AUTH_SCHEMA_SQL[4]).toMatch(/CREATE TABLE IF NOT EXISTS auth_session/i);
    expect(AUTH_SCHEMA_SQL[5]).toMatch(/CREATE TABLE IF NOT EXISTS address_verification/i);
    expect(AUTH_SCHEMA_SQL[6]).toMatch(/CREATE TABLE IF NOT EXISTS passkey_challenge/i);
    expect(AUTH_SCHEMA_SQL[7]).toMatch(/CREATE TABLE IF NOT EXISTS passkey_credential/i);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(/nostr_pubkey/);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(/forum_laws_dismissed/);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE account ADD COLUMN IF NOT EXISTS view_key text/i,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /UPDATE account SET view_key = replace\(gen_random_uuid\(\)::text \|\| gen_random_uuid\(\)::text, '-', ''\) WHERE view_key IS NULL/i,
    );
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS account_view_key_uidx ON account \(view_key\) WHERE view_key IS NOT NULL/i,
    );
    expect(AUTH_SCHEMA_SQL[0]).toMatch(/\brules_agreed_at timestamptz\b/i);
    expect(AUTH_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE account ADD COLUMN IF NOT EXISTS rules_agreed_at timestamptz/i,
    );
  });
});
