import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import {
  migrateNostrRetiredKeySchema,
  NOSTR_RETIRED_KEY_SCHEMA_SQL,
  nostrRetiredKeyAad,
  PostgresNostrRetiredKeyStore,
} from '@/lib/nostr/retired-key';

describe('NOSTR_RETIRED_KEY_SCHEMA_SQL', () => {
  it('creates the table, the pubkey index, and both cleanup triggers under the migration lock', () => {
    expect(NOSTR_RETIRED_KEY_SCHEMA_SQL).toHaveLength(6);
    for (const statement of NOSTR_RETIRED_KEY_SCHEMA_SQL) {
      expect(statement).toMatch(
        /^DO \$nostr_retired_key\$\nBEGIN\n {2}PERFORM pg_advisory_xact_lock\(21499041\);/,
      );
    }
    const [table, index, accountFn, accountTrigger, shopFn, shopTrigger] =
      NOSTR_RETIRED_KEY_SCHEMA_SQL;
    expect(table).toContain("owner_type text NOT NULL CHECK (owner_type IN ('account', 'shop'))");
    expect(table).toContain('owner_id text NOT NULL');
    expect(table).toContain("pubkey text NOT NULL CHECK (pubkey ~ '^[0-9a-f]{64}$')");
    expect(table).toContain('nsec_ciphertext bytea NOT NULL');
    expect(table).toContain('kek_id integer NOT NULL CHECK (kek_id >= 1)');
    expect(table).toContain('retired_at timestamptz NOT NULL DEFAULT now()');
    expect(table).toContain('PRIMARY KEY (owner_type, owner_id, pubkey)');
    expect(index).toContain('nostr_retired_key_pubkey_idx ON nostr_retired_key (pubkey)');
    expect(accountFn).toContain(
      "DELETE FROM nostr_retired_key WHERE owner_type = 'account' AND owner_id = OLD.id::text",
    );
    expect(accountTrigger).toContain("tgrelid = 'public.account'::regclass");
    expect(accountTrigger).toContain(
      'CREATE TRIGGER trg_account_nostr_retired_key AFTER DELETE ON account',
    );
    expect(shopFn).toContain(
      "DELETE FROM nostr_retired_key WHERE owner_type = 'shop' AND owner_id = OLD.message_id::text",
    );
    expect(shopTrigger).toContain(
      'CREATE TRIGGER trg_shop_identity_nostr_retired_key AFTER DELETE ON shop_identity',
    );
  });

  it('matches docs/schema/nostr_retired_key.sql', () => {
    const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();
    const doc = flat(
      readFileSync(join(process.cwd(), 'docs/schema/nostr_retired_key.sql'), 'utf8').replace(
        /--.*$/gm,
        '',
      ),
    );
    for (const body of [
      /CREATE TABLE IF NOT EXISTS nostr_retired_key \([\s\S]*?\n {3}\)/,
      /CREATE INDEX IF NOT EXISTS nostr_retired_key_pubkey_idx[^\n]*/,
    ]) {
      const statement = NOSTR_RETIRED_KEY_SCHEMA_SQL.join('\n').match(body)?.[0] ?? '';
      expect(statement).not.toBe('');
      expect(doc).toContain(flat(statement));
    }
  });
});

describe('migrateNostrRetiredKeySchema', () => {
  it('executes every statement in order', async () => {
    const execute = vi.fn(async (_text: string): Promise<void> => undefined);
    await migrateNostrRetiredKeySchema({ query: async () => [], execute });
    expect(execute.mock.calls.map((call) => call[0])).toEqual(NOSTR_RETIRED_KEY_SCHEMA_SQL);
  });
});

describe('nostrRetiredKeyAad', () => {
  it('binds owner kind, owner id, and pubkey', () => {
    expect(nostrRetiredKeyAad('account', 'acc', 'ab'.repeat(32))).toBe(
      `nostr_retired_key:account:acc:${'ab'.repeat(32)}`,
    );
    expect(nostrRetiredKeyAad('shop', 'note', 'cd'.repeat(32))).toBe(
      `nostr_retired_key:shop:note:${'cd'.repeat(32)}`,
    );
  });
});

describe('PostgresNostrRetiredKeyStore', () => {
  it('reads one retired key by owner and pubkey, or undefined', async () => {
    const calls: Array<{ text: string; params: readonly unknown[] }> = [];
    let rows: unknown[] = [{ nsec_ciphertext: new Uint8Array([1, 2, 3]), kek_id: '2' }];
    const sql: SqlClient = {
      query: async <T>(text: string, params: readonly unknown[] = []): Promise<T[]> => {
        calls.push({ text, params });
        return rows as T[];
      },
      execute: async () => undefined,
    };
    const store = new PostgresNostrRetiredKeyStore(sql);
    await expect(store.getRetiredKey('account', 'acc', 'ab'.repeat(32))).resolves.toEqual({
      ciphertext: new Uint8Array([1, 2, 3]),
      kekId: 2,
    });
    expect(calls[0]?.text).toContain('FROM nostr_retired_key');
    expect(calls[0]?.text).toContain('WHERE owner_type = $1 AND owner_id = $2 AND pubkey = $3');
    expect(calls[0]?.params).toEqual(['account', 'acc', 'ab'.repeat(32)]);
    rows = [];
    await expect(store.getRetiredKey('shop', 'note', 'ab'.repeat(32))).resolves.toBeUndefined();
  });
});
