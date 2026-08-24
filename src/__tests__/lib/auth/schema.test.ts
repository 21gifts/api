import { describe, it, expect } from 'vitest';
import { AUTH_SCHEMA_SQL } from '@/lib/auth/schema';

describe('AUTH_SCHEMA_SQL', () => {
  it('creates the auth tables and backfills account.name idempotently', () => {
    expect(AUTH_SCHEMA_SQL).toHaveLength(8);
    expect(AUTH_SCHEMA_SQL[0]).toMatch(/CREATE TABLE IF NOT EXISTS account/i);
    expect(AUTH_SCHEMA_SQL[0]).toMatch(/\bname text\b/i);
    expect(AUTH_SCHEMA_SQL[0]).not.toMatch(/linking_key text NOT NULL/i);
    expect(AUTH_SCHEMA_SQL[1]).toMatch(/ALTER TABLE account ADD COLUMN IF NOT EXISTS name text/i);
    expect(AUTH_SCHEMA_SQL[2]).toMatch(
      /ALTER TABLE account ALTER COLUMN linking_key DROP NOT NULL/i,
    );
    expect(AUTH_SCHEMA_SQL[3]).toMatch(/CREATE TABLE IF NOT EXISTS auth_challenge/i);
    expect(AUTH_SCHEMA_SQL[4]).toMatch(/CREATE TABLE IF NOT EXISTS auth_session/i);
    expect(AUTH_SCHEMA_SQL[5]).toMatch(/CREATE TABLE IF NOT EXISTS address_verification/i);
    expect(AUTH_SCHEMA_SQL[6]).toMatch(/CREATE TABLE IF NOT EXISTS passkey_challenge/i);
    expect(AUTH_SCHEMA_SQL[7]).toMatch(/CREATE TABLE IF NOT EXISTS passkey_credential/i);
  });
});
