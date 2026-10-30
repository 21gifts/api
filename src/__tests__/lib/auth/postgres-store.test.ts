import { describe, it, expect, vi } from 'vitest';
import type { MergeDb } from '@/lib/account-merge';
import { AUTH_SCHEMA_SQL } from '@/lib/auth/schema';
import {
  backfillSparkAddresses,
  migrateAuthSchema,
  PostgresAuthStore,
} from '@/lib/auth/postgres-store';
import type { SqlClient } from '@/lib/auth/sql';
import type { PendingRecovery } from '@/lib/auth/store';
import { CHALLENGE_TTL_MS, SESSION_TTL_MS } from '@/lib/config';
import { encodeSparkAddress } from '@/lib/spark-address';

class MockSql implements SqlClient {
  executes: { text: string; params: readonly unknown[] }[] = [];
  queries: { text: string; params: readonly unknown[] }[] = [];
  nextRows: unknown[] = [];
  nextQueryRows: unknown[][] = [];
  executeError: unknown | undefined;
  queryError: unknown | undefined;
  queryErrorAfter = 0;

  async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    this.queries.push({ text, params });
    if (this.queryError !== undefined && this.queries.length > this.queryErrorAfter) {
      throw this.queryError;
    }
    if (this.nextQueryRows.length > 0) {
      return this.nextQueryRows.shift() as T[];
    }
    return this.nextRows as T[];
  }

  async execute(text: string, params: readonly unknown[] = []): Promise<void> {
    this.executes.push({ text, params });
    if (this.executeError !== undefined) {
      throw this.executeError;
    }
  }
}

const VIEW_KEY = 'a'.repeat(64);

const ACCOUNT_ROW = {
  id: 'acc',
  linking_key: `02${'a'.repeat(64)}`,
  role: 'basis',
  name: null as string | null,
  location: null as string | null,
  lightning_address: null as string | null,
  lightning_address_verified: false,
  forum_laws_dismissed: false,
  view_key: VIEW_KEY,
  created_at: new Date(1_000),
  rules_agreed_at: null as Date | string | null,
  name_skipped_at: null as Date | string | null,
  lightning_address_skipped_at: null as Date | string | null,
  profile_message_id: null as string | null,
  username: null as string | null,
};

describe('PostgresAuthStore nostr keys', () => {
  it('reads and writes nostr key material', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    sql.nextRows = [{ nostr_pubkey: null }];
    expect(await store.getNostrPublicKey('acc')).toBeUndefined();
    sql.nextRows = [{ nostr_pubkey: 'aa'.repeat(32) }];
    expect(await store.getNostrPublicKey('acc')).toBe('aa'.repeat(32));
    sql.nextRows = [{ nostr_nsec_ciphertext: null }];
    expect(await store.getNostrSecret('acc')).toBeUndefined();
    sql.nextRows = [{ nostr_nsec_ciphertext: new Uint8Array([1, 2]) }];
    expect(await store.getNostrSecret('acc')).toEqual(new Uint8Array([1, 2]));
    sql.nextRows = [];
    expect(
      await store.setNostrKeyIfAbsent('acc', {
        pubkey: 'aa'.repeat(32),
        ciphertext: new Uint8Array([1]),
        kekId: 1,
        custody: 'custodial',
      }),
    ).toBe('exists');
    sql.nextRows = [{ nostr_pubkey: 'aa'.repeat(32) }];
    expect(
      await store.setNostrKeyIfAbsent('acc', {
        pubkey: 'aa'.repeat(32),
        ciphertext: new Uint8Array([1]),
        kekId: 1,
        custody: 'custodial',
      }),
    ).toBe('inserted');
    sql.nextRows = [{ id: 'acc' }];
    expect(await store.listAccountIdsWithoutNostrKey(5)).toEqual(['acc']);
  });

  it('listStaffAccountIds selects founder and moderator ids', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ id: 'f1' }, { id: 'm1' }];
    const ids = await new PostgresAuthStore(sql).listStaffAccountIds();
    expect(sql.queries[0]?.text).toBe(
      `SELECT id FROM account WHERE role IN ('founder', 'moderator', 'initiator')`,
    );
    expect(sql.queries[0]?.text).toContain('initiator');
    expect(ids).toEqual(['f1', 'm1']);
  });

  it('listLegacyPayoutHandles maps account ids to the legacy address local part', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      { id: 'a1', handle: 'adawos' },
      { id: 'a2', handle: '' },
    ];
    const handles = await new PostgresAuthStore(sql).listLegacyPayoutHandles();
    expect(sql.queries[0]?.text).toContain("split_part(btrim(lightning_address), '@', 1)");
    expect(sql.queries[0]?.text).toContain("btrim(lightning_address) <> ''");
    expect(handles).toEqual(new Map([['a1', 'adawos']]));
  });

  it('listIdsByPrefix selects matching account ids', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ id: 'D70C4763-3033-43da-817a-2c7de9938f27' }];
    const listed = await new PostgresAuthStore(sql).listIdsByPrefix('D70C4763');
    expect(sql.queries[0]?.text).toMatch(/SELECT id::text AS id FROM account/);
    expect(sql.queries[0]?.text).toMatch(/WHERE lower\(id::text\) LIKE \$1 \|\| '%'/);
    expect(sql.queries[0]?.text).toMatch(/LIMIT 2/);
    expect(sql.queries[0]?.params).toEqual(['d70c4763']);
    expect(listed).toEqual(['D70C4763-3033-43da-817a-2c7de9938f27']);
  });

  it('listIdsByPrefix returns [] when empty', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    expect(await new PostgresAuthStore(sql).listIdsByPrefix('d70c4763')).toEqual([]);
  });
});

describe('migrateAuthSchema', () => {
  it('runs every AUTH_SCHEMA_SQL statement', async () => {
    const sql = new MockSql();
    await migrateAuthSchema(sql);
    expect(sql.executes.map((e) => e.text)).toEqual([...AUTH_SCHEMA_SQL]);
  });
});

describe('backfillSparkAddresses', () => {
  const KEY_A = `02${'a'.repeat(64)}`;
  const KEY_B = `03${'b'.repeat(64)}`;
  const KEY_C = `02${'c'.repeat(64)}`;
  const UPDATE =
    'UPDATE account SET spark_address = $3 WHERE id = $1 AND spark_pubkey = $2 RETURNING id';

  it('writes a missing or stale address, skips a current one, and logs the rows written', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sql = new MockSql();
    sql.nextQueryRows = [
      [
        { id: 'a', spark_pubkey: KEY_A, spark_address: null },
        { id: 'b', spark_pubkey: KEY_B, spark_address: encodeSparkAddress(KEY_B) },
        { id: 'c', spark_pubkey: KEY_C, spark_address: encodeSparkAddress(KEY_A) },
      ],
      [{ id: 'a' }],
      [],
    ];
    try {
      expect(await backfillSparkAddresses(sql)).toBe(1);
      expect(sql.queries.map((q) => q.text)).toEqual([
        'SELECT id, spark_pubkey, spark_address FROM account WHERE spark_pubkey IS NOT NULL',
        UPDATE,
        UPDATE,
      ]);
      expect(sql.queries[1]?.params).toEqual(['a', KEY_A, encodeSparkAddress(KEY_A)]);
      expect(sql.queries[2]?.params).toEqual(['c', KEY_C, encodeSparkAddress(KEY_C)]);
      const events = warn.mock.calls
        .map((call) => call[0])
        .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
        .map((arg) => JSON.parse(arg) as Record<string, unknown>);
      expect(
        events.some((e) => e['event'] === 'account.spark_address.backfill' && e['count'] === 1),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('PostgresAuthStore', () => {
  it('maps account rows and lists them', async () => {
    const sql = new MockSql();
    sql.nextRows = [ACCOUNT_ROW];
    const store = new PostgresAuthStore(sql);
    const mapped = await store.getAccount('acc');
    expect(mapped?.linkingKey).toBe(ACCOUNT_ROW.linking_key);
    expect(mapped?.forumLawsDismissed).toBe(false);
    expect(mapped?.rulesAgreedAt).toBeNull();
    expect(mapped?.isPlatform).toBe(false);
    expect(mapped?.nameSkippedAt).toBeNull();
    expect(mapped?.lightningAddressSkippedAt).toBeNull();
    expect(mapped?.profileMessageId).toBeNull();
    expect(mapped?.location).toBeNull();
    expect(mapped?.notificationLevel).toBe('all');
    expect(mapped?.notifyHearts).toBe(true);
    expect(mapped?.amountUnit).toBe('btc');
    expect(mapped?.username).toBeNull();
    expect(mapped?.walletRequired).toBe(false);
    expect(mapped?.walletBackupSeenAt).toBeNull();
    expect(mapped?.walletIntroSeen).toBe(false);
    expect(mapped?.hadExternalWallet).toBe(false);
    const account = await store.getAccount('acc');
    expect(account?.linkingKey).toBe(ACCOUNT_ROW.linking_key);
    expect(account?.viewKey).toBe(VIEW_KEY);
    expect(sql.queries[0]?.text).toMatch(/forum_laws_dismissed/);
    expect(sql.queries[0]?.text).toMatch(/rules_agreed_at/);
    expect(sql.queries[0]?.text).toMatch(/name_skipped_at/);
    expect(sql.queries[0]?.text).toMatch(/profile_message_id/);
    expect(sql.queries[0]?.text).toMatch(/location/);
    expect(sql.queries[0]?.text).toMatch(/notification_level/);
    expect(sql.queries[0]?.text).toMatch(/amount_unit/);
    expect(sql.queries[0]?.text).toMatch(/username/);
    expect(sql.queries[0]?.text).toMatch(/wallet_required/);
    expect(sql.queries[0]?.text).toMatch(/wallet_backup_seen_at/);
    expect(sql.queries[0]?.text).toMatch(/wallet_intro_seen/);
    expect(sql.queries[0]?.text).toMatch(
      /\(lightning_address IS NOT NULL AND btrim\(lightning_address\) <> ''\) AS had_external_wallet/,
    );
    const listed = await store.listAccounts();
    expect(listed).toHaveLength(1);
    expect(sql.queries[2]?.text).toMatch(/ORDER BY created_at ASC, id ASC/);
    expect(sql.queries[2]?.text).toMatch(/rules_agreed_at/);
  });

  it('getAccounts reads the distinct ids in one uuid[] query and skips rows without a view key', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    expect(await store.getAccounts([])).toEqual([]);
    expect(sql.queries).toHaveLength(0);
    sql.nextRows = [ACCOUNT_ROW, { ...ACCOUNT_ROW, id: 'acc-no-key', view_key: null }];
    const found = await store.getAccounts(['acc', 'acc-no-key', 'acc']);
    expect(found.map((row) => row.id)).toEqual(['acc']);
    expect(sql.queries).toHaveLength(1);
    expect(sql.queries[0]?.text).toMatch(/WHERE id = ANY\(\$1::uuid\[\]\)/);
    expect(sql.queries[0]?.params).toEqual(['{"acc","acc-no-key"}']);
  });

  it('maps omitted skip timestamps to null', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: ACCOUNT_ROW.id,
        linking_key: ACCOUNT_ROW.linking_key,
        role: ACCOUNT_ROW.role,
        name: ACCOUNT_ROW.name,
        lightning_address: ACCOUNT_ROW.lightning_address,
        lightning_address_verified: ACCOUNT_ROW.lightning_address_verified,
        forum_laws_dismissed: ACCOUNT_ROW.forum_laws_dismissed,
        view_key: ACCOUNT_ROW.view_key,
        created_at: ACCOUNT_ROW.created_at,
        rules_agreed_at: ACCOUNT_ROW.rules_agreed_at,
        profile_message_id: ACCOUNT_ROW.profile_message_id,
      },
    ];
    const mapped = await new PostgresAuthStore(sql).getAccount('acc');
    expect(mapped?.nameSkippedAt).toBeNull();
    expect(mapped?.lightningAddressSkippedAt).toBeNull();
    expect(mapped?.walletRequired).toBe(false);
    expect(mapped?.walletBackupSeenAt).toBeNull();
  });

  it('maps non-null skip timestamps', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        ...ACCOUNT_ROW,
        name_skipped_at: new Date(2_000),
        lightning_address_skipped_at: new Date(3_000),
      },
    ];
    const mapped = await new PostgresAuthStore(sql).getAccount('acc');
    expect(mapped?.nameSkippedAt).toBe(2_000);
    expect(mapped?.lightningAddressSkippedAt).toBe(3_000);
  });

  it('maps wallet_required and wallet_backup_seen_at', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        ...ACCOUNT_ROW,
        wallet_required: true,
        wallet_backup_seen_at: new Date(4_000),
      },
    ];
    const mapped = await new PostgresAuthStore(sql).getAccount('acc');
    expect(mapped?.walletRequired).toBe(true);
    expect(mapped?.walletBackupSeenAt).toBe(4_000);
  });

  it('maps wallet_intro_seen and had_external_wallet', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ ...ACCOUNT_ROW, wallet_intro_seen: true, had_external_wallet: true }];
    const mapped = await new PostgresAuthStore(sql).getAccount('acc');
    expect(mapped?.walletIntroSeen).toBe(true);
    expect(mapped?.hadExternalWallet).toBe(true);
  });

  it('maps a non-null rules_agreed_at timestamp', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ ...ACCOUNT_ROW, rules_agreed_at: new Date(5_000) }];
    expect((await new PostgresAuthStore(sql).getAccount('acc'))?.rulesAgreedAt).toBe(5_000);
  });

  it('returns undefined for a missing account', async () => {
    expect(await new PostgresAuthStore(new MockSql()).getAccount('x')).toBeUndefined();
  });

  it('inserts and updates accounts without the stored external address', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    const account = {
      id: 'acc',
      linkingKey: ACCOUNT_ROW.linking_key,
      role: 'moderator' as const,
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: VIEW_KEY,
      createdAt: 1,
      rulesAgreedAt: null,
    };
    await store.createAccount(account);
    await store.updateAccount({
      id: 'acc',
      linkingKey: ACCOUNT_ROW.linking_key,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: VIEW_KEY,
      createdAt: 1,
      rulesAgreedAt: 9_000,
    });
    const insert = sql.executes[0]!;
    expect(insert.text).toMatch(/ON CONFLICT \(linking_key\) DO NOTHING/);
    expect(insert.text).not.toMatch(/lightning_address,|lightning_address_verified/);
    expect(insert.text).toMatch(/lightning_address_skipped_at/);
    for (const column of [
      'forum_laws_dismissed',
      'view_key',
      'rules_agreed_at',
      'is_platform',
      'name_skipped_at',
      'profile_message_id',
      'location',
      'notification_level',
      'username',
      'amount_unit',
      'session_refused',
      'wallet_required',
      'wallet_backup_seen_at',
      'notify_hearts',
      'wallet_intro_seen',
    ]) {
      expect(insert.text).toMatch(new RegExp(column));
    }
    expect(insert.params).toEqual([
      'acc',
      ACCOUNT_ROW.linking_key,
      'moderator',
      'Ada',
      false,
      1,
      VIEW_KEY,
      null,
      false,
      null,
      null,
      null,
      null,
      'all',
      null,
      false,
      false,
      null,
      'btc',
      true,
      false,
    ]);
    const update = sql.executes[1]!;
    expect(update.text).toMatch(/UPDATE account/);
    expect(update.text).not.toMatch(/lightning_address =|lightning_address_verified/);
    expect(update.text).not.toMatch(/wallet_required/);
    expect(update.text).not.toMatch(/wallet_backup_seen_at/);
    expect(update.text).not.toMatch(/spark_pubkey =/);
    expect(update.text).not.toMatch(/spark_pubkey_verified_at =/);
    expect(update.text).toMatch(/forum_laws_dismissed = \$5/);
    expect(update.text).toMatch(/view_key = \$7/);
    expect(update.text).toMatch(/is_platform = \$9/);
    expect(update.text).toMatch(/lightning_address_skipped_at = to_timestamp\(\$11/);
    expect(update.text).toMatch(/profile_message_id = \$12/);
    expect(update.text).toMatch(/location = \$13/);
    expect(update.text).toMatch(/notification_level = \$14/);
    expect(update.text).toMatch(
      /username = CASE WHEN spark_pubkey_verified_at IS NULL AND trim\(coalesce\(username, ''\)\) = '' THEN \$15 ELSE username END/,
    );
    expect(update.text).toMatch(/amount_unit = \$16/);
    expect(update.text).toMatch(/notify_hearts = \$17/);
    expect(update.text).toMatch(/wallet_intro_seen = wallet_intro_seen OR \$18/);
    expect(update.text).not.toMatch(/had_external_wallet/);
    expect(update.text).toMatch(/NOT EXISTS/);
    expect(update.text).not.toMatch(/IS NOT DISTINCT FROM/);
    const setClause = update.text.split(/\bWHERE\b/)[0]!;
    expect(
      setClause.replace(
        /username = CASE WHEN spark_pubkey_verified_at IS NULL AND trim\(coalesce\(username, ''\)\) = '' THEN \$15 ELSE username END/,
        '',
      ),
    ).not.toMatch(/spark_pubkey/);
    expect(update.params).toEqual([
      'acc',
      ACCOUNT_ROW.linking_key,
      'basis',
      null,
      false,
      1,
      VIEW_KEY,
      9_000,
      false,
      null,
      null,
      null,
      null,
      'all',
      null,
      'btc',
      true,
      false,
    ]);
    expect(insert.text).not.toMatch(/spark_pubkey/);
  });

  it('selects account rows without the stored external address', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ ...ACCOUNT_ROW, lightning_address: 'old@example.com' }];
    const mapped = await new PostgresAuthStore(sql).getAccount('acc');
    expect(sql.queries[0]?.text).not.toMatch(/lightning_address,|lightning_address_verified/);
    expect(mapped).not.toHaveProperty('lightningAddress');
    expect(mapped).not.toHaveProperty('lightningAddressVerified');
  });

  it('writes a stored notificationLevel as $14', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    const account = {
      id: 'acc',
      linkingKey: ACCOUNT_ROW.linking_key,
      role: 'basis' as const,
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: VIEW_KEY,
      createdAt: 1,
      rulesAgreedAt: null,
      notificationLevel: 'mentions' as const,
    };
    await store.createAccount(account);
    expect(sql.executes[0]?.text).toMatch(/notification_level/);
    expect(sql.executes[0]?.params[13]).toBe('mentions');
    await store.updateAccount({ ...account, notificationLevel: 'active' });
    expect(sql.executes[1]?.text).toMatch(/notification_level = \$14/);
    expect(sql.executes[1]?.text).toMatch(
      /username = CASE WHEN spark_pubkey_verified_at IS NULL AND trim\(coalesce\(username, ''\)\) = '' THEN \$15 ELSE username END/,
    );
    expect(sql.executes[1]?.params[13]).toBe('active');
    expect(sql.executes[1]?.params[14]).toBeNull();
  });

  it('maps amount_unit stored texts via parseAmountUnit', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    sql.nextRows = [{ ...ACCOUNT_ROW, amount_unit: 'btc' }];
    expect((await store.getAccount('acc'))?.amountUnit).toBe('btc');
    sql.nextRows = [{ ...ACCOUNT_ROW, amount_unit: 'fiat' }];
    expect((await store.getAccount('acc'))?.amountUnit).toBe('fiat');
    sql.nextRows = [{ ...ACCOUNT_ROW, amount_unit: 'sats' }];
    expect((await store.getAccount('acc'))?.amountUnit).toBe('btc');
    sql.nextRows = [{ ...ACCOUNT_ROW, amount_unit: null }];
    expect((await store.getAccount('acc'))?.amountUnit).toBe('btc');
    expect(sql.queries[0]?.text).toMatch(/amount_unit/);
  });

  it('writes notifyHearts as $20 on insert and $17 on update', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    const account = {
      id: 'acc',
      linkingKey: ACCOUNT_ROW.linking_key,
      role: 'basis' as const,
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: VIEW_KEY,
      createdAt: 1,
      rulesAgreedAt: null,
      notifyHearts: false,
    };
    await store.createAccount(account);
    expect(sql.executes[0]?.text).toMatch(/notify_hearts/);
    expect(sql.executes[0]?.params[19]).toBe(false);
    await store.updateAccount({ ...account, notifyHearts: true });
    expect(sql.executes[1]?.text).toMatch(/notify_hearts = \$17/);
    expect(sql.executes[1]?.params[16]).toBe(true);
  });

  it('writes a stored amountUnit as $19 on insert and $16 on update', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    const account = {
      id: 'acc',
      linkingKey: ACCOUNT_ROW.linking_key,
      role: 'basis' as const,
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: VIEW_KEY,
      createdAt: 1,
      rulesAgreedAt: null,
      amountUnit: 'fiat' as const,
    };
    await store.createAccount(account);
    expect(sql.executes[0]?.text).toMatch(/amount_unit/);
    expect(sql.executes[0]?.params[18]).toBe('fiat');
    await store.updateAccount({ ...account, amountUnit: 'btc' });
    expect(sql.executes[1]?.text).toMatch(/amount_unit = \$16/);
    expect(sql.executes[1]?.text).toMatch(
      /username = CASE WHEN spark_pubkey_verified_at IS NULL AND trim\(coalesce\(username, ''\)\) = '' THEN \$15 ELSE username END/,
    );
    expect(sql.executes[1]?.params[15]).toBe('btc');
  });

  it('clears other platform flags before inserting or updating is_platform true', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    await store.createAccount({
      id: 'plat',
      linkingKey: null,
      role: 'founder',
      name: '21.gifts',
      forumLawsDismissed: false,
      location: null,
      viewKey: VIEW_KEY,
      createdAt: 1,
      rulesAgreedAt: null,
      isPlatform: true,
    });
    expect(sql.executes[0]?.text).toMatch(/is_platform = false WHERE is_platform/);
    expect(sql.executes[1]?.params[8]).toBe(true);
    expect(sql.executes[1]?.params[11]).toBeNull();
    await store.updateAccount({
      id: 'plat',
      linkingKey: null,
      role: 'founder',
      name: '21.gifts',
      forumLawsDismissed: false,
      location: null,
      viewKey: VIEW_KEY,
      createdAt: 1,
      rulesAgreedAt: null,
      isPlatform: true,
    });
    expect(sql.executes[2]?.text).toMatch(/is_platform = false WHERE is_platform/);
    expect(sql.executes[3]?.params[8]).toBe(true);
  });

  it('looks up an account by view_key', async () => {
    const sql = new MockSql();
    sql.nextRows = [ACCOUNT_ROW];
    const store = new PostgresAuthStore(sql);
    const found = await store.getAccountByViewKey(VIEW_KEY);
    expect(sql.queries[0]?.text).toMatch(/WHERE view_key = \$1/);
    expect(sql.queries[0]?.params).toEqual([VIEW_KEY]);
    expect(found?.viewKey).toBe(VIEW_KEY);
    expect(found?.id).toBe('acc');
  });

  it('returns undefined for a missing view_key', async () => {
    expect(
      await new PostgresAuthStore(new MockSql()).getAccountByViewKey(VIEW_KEY),
    ).toBeUndefined();
  });

  it('looks up an account by nostr_pubkey with lower(trim) SQL', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ ...ACCOUNT_ROW, name: 'Ada' }];
    const store = new PostgresAuthStore(sql);
    const found = await store.getAccountByPubkey('  AA'.repeat(16) + '  ');
    expect(sql.queries[0]?.text).toMatch(/WHERE lower\(nostr_pubkey\) = lower\(trim\(\$1\)\)/);
    expect(found?.id).toBe('acc');
  });

  it('returns undefined when nostr_pubkey lookup has no rows', async () => {
    expect(
      await new PostgresAuthStore(new MockSql()).getAccountByPubkey('aa'.repeat(32)),
    ).toBeUndefined();
  });

  it('looks up an account by username with lower(trim) SQL', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ ...ACCOUNT_ROW, username: 'ada', name: 'Ada' }];
    const store = new PostgresAuthStore(sql);
    const found = await store.getAccountByUsername('  Ada  ');
    expect(sql.queries[0]?.text).toMatch(
      /WHERE username IS NOT NULL AND lower\(trim\(username\)\) = lower\(trim\(\$1\)\)/,
    );
    expect(sql.queries[0]?.params).toEqual(['  Ada  ']);
    expect(found?.id).toBe('acc');
    expect(found?.username).toBe('ada');
  });

  it('returns undefined when username lookup has no rows', async () => {
    expect(
      await new PostgresAuthStore(new MockSql()).getAccountByUsername('missing'),
    ).toBeUndefined();
  });

  it('lists accounts by username prefix with escaped LIKE and mapped name', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ id: 'acc', username: 'A_b', name: '  Ada  ' }];
    const store = new PostgresAuthStore(sql);
    const found = await store.listAccountsByUsernamePrefix('a_b', 20);
    const text = sql.queries[0]?.text ?? '';
    expect(found).toEqual([{ id: 'acc', username: 'A_b', name: 'Ada' }]);
    expect(sql.queries[0]?.params).toEqual(['a\\_b', 20, '1']);
    expect(text).toContain('LIKE');
    expect(text).toContain(`ESCAPE '\\'`);
    expect(text).toContain("$1 = ''");
    expect(text).toContain("$3 = '0'");
    expect(text).toContain("coalesce(name, '')");
    expect(text).toContain("'%-'");
    expect(text).toContain("'%.'");
    expect(text).toContain("'% '");
    expect(text).toContain("'%\\_'");
    expect(text).toContain('username IS NOT NULL');
    expect(text).toContain("trim(username) <> ''");
    expect(text).toContain('ORDER BY lower(trim(username)) ASC, id::text ASC');
    expect(text).toContain('LIMIT $2');
    expect(text).toContain('SELECT id::text AS id, username, name');
    expect(text).not.toMatch(/lightning/i);
    expect(text).not.toMatch(/email/i);
    expect(text).not.toMatch(/\brole\b/i);
    expect(text).not.toMatch(/npub/i);
  });

  it('lists accounts by username prefix with an empty prefix as an empty string', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    const store = new PostgresAuthStore(sql);
    expect(await store.listAccountsByUsernamePrefix('', 20)).toEqual([]);
    expect(sql.queries[0]?.params).toEqual(['', 20, '0']);
    await store.listAccountsByUsernamePrefix('sev', 20);
    expect(sql.queries[1]?.params).toEqual(['sev', 20, '0']);
    await store.listAccountsByUsernamePrefix('a-b', 20);
    expect(sql.queries[2]?.params).toEqual(['a-b', 20, '1']);
  });

  it('escapes % and backslash in the mention LIKE pattern', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    sql.nextRows = [];
    await store.listAccountsByUsernamePrefix('100%', 20);
    expect(sql.queries[0]?.params[0]).toBe('100\\%');
    expect(sql.queries[0]?.params[2]).toBe('0');
    await store.listAccountsByUsernamePrefix('a\\b', 20);
    expect(sql.queries[1]?.params[0]).toBe('a\\\\b');
    expect(sql.queries[1]?.params[2]).toBe('0');
  });

  it('falls back to the stored username when name is null or blank', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    sql.nextRows = [{ id: 'acc', username: 'cara', name: null }];
    expect(await store.listAccountsByUsernamePrefix('cara', 20)).toEqual([
      { id: 'acc', username: 'cara', name: 'cara' },
    ]);
    sql.nextRows = [{ id: 'acc2', username: 'cara2', name: '   ' }];
    expect(await store.listAccountsByUsernamePrefix('cara', 20)).toEqual([
      { id: 'acc2', username: 'cara2', name: 'cara2' },
    ]);
  });

  it('claimProfileMessageId uses query with IS NOT DISTINCT FROM', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    sql.nextRows = [{ id: 'acc' }];
    expect(await store.claimProfileMessageId('acc', null, 'note-1')).toBe(true);
    expect(sql.queries[0]?.text).toMatch(/IS NOT DISTINCT FROM/);
    expect(sql.queries[0]?.text).toMatch(/SET profile_message_id = \$3/);
    expect(sql.queries[0]?.text).toMatch(/RETURNING id/);
    expect(sql.queries[0]?.params).toEqual(['acc', null, 'note-1']);
    expect(sql.executes).toHaveLength(0);
    sql.nextRows = [];
    expect(await store.claimProfileMessageId('acc', null, 'note-1')).toBe(false);
  });

  it('accountHasPasskey queries passkey_credential by account_id', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    sql.nextRows = [];
    expect(await store.accountHasPasskey('acc')).toBe(false);
    expect(sql.queries[0]?.text).toMatch(/FROM passkey_credential/);
    expect(sql.queries[0]?.text).toMatch(/account_id = \$1/);
    expect(sql.queries[0]?.params).toEqual(['acc']);
    sql.nextRows = [{ '?column?': 1 }];
    expect(await store.accountHasPasskey('acc')).toBe(true);
  });

  it('skips rows with a null view_key', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ ...ACCOUNT_ROW, view_key: null }];
    const store = new PostgresAuthStore(sql);
    expect(await store.getAccount('acc')).toBeUndefined();
    expect(await store.getAccountByViewKey(VIEW_KEY)).toBeUndefined();
    expect(await store.listAccounts()).toEqual([]);
  });

  it('createAccount treats a unique_violation as a no-op', async () => {
    const sql = new MockSql();
    sql.executeError = Object.assign(new Error('duplicate key'), { code: '23505' });
    await expect(
      new PostgresAuthStore(sql).createAccount({
        id: 'acc',
        linkingKey: ACCOUNT_ROW.linking_key,
        role: 'basis',
        name: null,
        forumLawsDismissed: false,
        location: null,
        viewKey: VIEW_KEY,
        createdAt: 1,
        rulesAgreedAt: null,
      }),
    ).resolves.toBeUndefined();
  });

  it('createAccount treats a Bun errno unique_violation as a no-op', async () => {
    const sql = new MockSql();
    sql.executeError = Object.assign(new Error('duplicate key'), { errno: '23505' });
    await expect(
      new PostgresAuthStore(sql).createAccount({
        id: 'acc',
        linkingKey: ACCOUNT_ROW.linking_key,
        role: 'basis',
        name: null,
        forumLawsDismissed: false,
        location: null,
        viewKey: VIEW_KEY,
        createdAt: 1,
        rulesAgreedAt: null,
      }),
    ).resolves.toBeUndefined();
  });

  it('createAccount rethrows errors that are not unique_violation', async () => {
    const sql = new MockSql();
    sql.executeError = Object.assign(new Error('canceled'), { code: '57014' });
    await expect(
      new PostgresAuthStore(sql).createAccount({
        id: 'acc',
        linkingKey: ACCOUNT_ROW.linking_key,
        role: 'basis',
        name: null,
        forumLawsDismissed: false,
        location: null,
        viewKey: VIEW_KEY,
        createdAt: 1,
        rulesAgreedAt: null,
      }),
    ).rejects.toMatchObject({ code: '57014' });
  });

  it('updateAccount SQL refuses a linking_key owned by another id', async () => {
    const sql = new MockSql();
    await new PostgresAuthStore(sql).updateAccount({
      id: 'pk',
      linkingKey: ACCOUNT_ROW.linking_key,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: VIEW_KEY,
      createdAt: 1,
      rulesAgreedAt: null,
    });
    expect(sql.executes[0]?.text).toMatch(/other\.linking_key = \$2 AND other\.id <> \$1/);
  });

  it('updateAccount treats a linking_key unique_violation as a no-op', async () => {
    const sql = new MockSql();
    sql.executeError = Object.assign(new Error('duplicate key'), { code: '23505' });
    await expect(
      new PostgresAuthStore(sql).updateAccount({
        id: 'pk',
        linkingKey: ACCOUNT_ROW.linking_key,
        role: 'basis',
        name: null,
        forumLawsDismissed: false,
        location: null,
        viewKey: VIEW_KEY,
        createdAt: 1,
        rulesAgreedAt: null,
      }),
    ).resolves.toBeUndefined();
  });

  it('updateAccount rethrows errors that are not unique_violation', async () => {
    const sql = new MockSql();
    sql.executeError = Object.assign(new Error('canceled'), { code: '57014' });
    await expect(
      new PostgresAuthStore(sql).updateAccount({
        id: 'pk',
        linkingKey: ACCOUNT_ROW.linking_key,
        role: 'basis',
        name: null,
        forumLawsDismissed: false,
        location: null,
        viewKey: VIEW_KEY,
        createdAt: 1,
        rulesAgreedAt: null,
      }),
    ).rejects.toMatchObject({ code: '57014' });
  });

  it('updateAccount rethrows a thrown null', async () => {
    const sql = new MockSql();
    sql.executeError = null;
    await expect(
      new PostgresAuthStore(sql).updateAccount({
        id: 'pk',
        linkingKey: ACCOUNT_ROW.linking_key,
        role: 'basis',
        name: null,
        forumLawsDismissed: false,
        location: null,
        viewKey: VIEW_KEY,
        createdAt: 1,
        rulesAgreedAt: null,
      }),
    ).rejects.toBeNull();
  });

  it('updateAccount rethrows a thrown string', async () => {
    const sql = new MockSql();
    sql.executeError = 'boom';
    await expect(
      new PostgresAuthStore(sql).updateAccount({
        id: 'pk',
        linkingKey: ACCOUNT_ROW.linking_key,
        role: 'basis',
        name: null,
        forumLawsDismissed: false,
        location: null,
        viewKey: VIEW_KEY,
        createdAt: 1,
        rulesAgreedAt: null,
      }),
    ).rejects.toBe('boom');
  });

  it('updateAccount rethrows a plain Error', async () => {
    const sql = new MockSql();
    sql.executeError = new Error('disk full');
    await expect(
      new PostgresAuthStore(sql).updateAccount({
        id: 'pk',
        linkingKey: ACCOUNT_ROW.linking_key,
        role: 'basis',
        name: null,
        forumLawsDismissed: false,
        location: null,
        viewKey: VIEW_KEY,
        createdAt: 1,
        rulesAgreedAt: null,
      }),
    ).rejects.toThrow('disk full');
  });

  it('deletes an account by id', async () => {
    const sql = new MockSql();
    await new PostgresAuthStore(sql).deleteAccount('acc');
    expect(sql.executes[0]?.text).toMatch(/DELETE FROM account WHERE id = \$1/);
    expect(sql.executes[0]?.params).toEqual(['acc']);
  });

  it('evicts expired sessions then inserts', async () => {
    const sql = new MockSql();
    await new PostgresAuthStore(sql).createSession({
      token: 'tok',
      accountId: 'acc',
      createdAt: 9_000,
    });
    expect(sql.executes[0]?.text).toMatch(/DELETE FROM auth_session/);
    expect(sql.executes[0]?.params[0]).toBe(9_000 - SESSION_TTL_MS);
    expect(sql.executes[1]?.text).toMatch(/INSERT INTO auth_session/);
  });

  it('tryCreateSession inserts only when session_refused is not true', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ token: 'tok' }];
    expect(
      await new PostgresAuthStore(sql).tryCreateSession({
        token: 'tok',
        accountId: 'acc',
        createdAt: 9_000,
      }),
    ).toBe(true);
    expect(sql.executes[0]?.text).toMatch(/DELETE FROM auth_session/);
    expect(sql.queries[0]?.text).toMatch(/session_refused IS NOT TRUE/);
    expect(sql.queries[0]?.params).toEqual(['tok', 'acc', 9_000]);
  });

  it('tryCreateSession returns false when the insert matches no row', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    expect(
      await new PostgresAuthStore(sql).tryCreateSession({
        token: 'tok',
        accountId: 'acc',
        createdAt: 9_000,
      }),
    ).toBe(false);
  });

  it('setSessionRefused updates only that column', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ ...ACCOUNT_ROW, session_refused: true }];
    const updated = await new PostgresAuthStore(sql).setSessionRefused('acc', true);
    expect(updated?.sessionRefused).toBe(true);
    expect(sql.queries[0]?.text).toMatch(/SET session_refused = \$2/);
    expect(sql.queries[0]?.params).toEqual(['acc', true]);
  });

  it('setSessionRefused returns undefined when the id is unknown', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    expect(await new PostgresAuthStore(sql).setSessionRefused('missing', true)).toBeUndefined();
  });

  it('maps a session row', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ token: 'tok', account_id: 'acc', created_at: new Date(2_000) }];
    expect(await new PostgresAuthStore(sql).getSession('tok')).toEqual({
      token: 'tok',
      accountId: 'acc',
      createdAt: 2_000,
    });
  });

  it('returns undefined for a missing session', async () => {
    expect(await new PostgresAuthStore(new MockSql()).getSession('x')).toBeUndefined();
  });

  it('deleteAllSessions deletes every auth_session row and returns the count', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ deleted: 3 }];
    expect(await new PostgresAuthStore(sql).deleteAllSessions()).toBe(3);
    expect(sql.queries[0]?.text).toContain('DELETE FROM auth_session RETURNING 1');
    expect(sql.queries[0]?.params).toEqual([]);
    sql.nextRows = [{ deleted: '4' }];
    expect(await new PostgresAuthStore(sql).deleteAllSessions()).toBe(4);
    sql.nextRows = [];
    expect(await new PostgresAuthStore(sql).deleteAllSessions()).toBe(0);
  });

  it('maps verified and founder account roles', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    sql.nextRows = [{ ...ACCOUNT_ROW, role: 'verified' }];
    expect((await store.getAccount('acc'))?.role).toBe('verified');
    sql.nextRows = [{ ...ACCOUNT_ROW, role: 'founder' }];
    expect((await store.getAccount('acc'))?.role).toBe('founder');
    sql.nextRows = [{ ...ACCOUNT_ROW, role: 'initiator' }];
    expect((await store.getAccount('acc'))?.role).toBe('initiator');
  });

  it('rejects an unknown account role', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ ...ACCOUNT_ROW, role: 'admin' }];
    await expect(new PostgresAuthStore(sql).getAccount('acc')).rejects.toThrow(
      /Unknown account role/,
    );
  });

  it('evicts expired passkey challenges then inserts', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    await store.createPasskeyChallenge({
      id: 'ch',
      type: 'register',
      challenge: 'c',
      accountId: 'acc',
      consumed: false,
      createdAt: 5_000,
    });
    expect(sql.executes[0]?.text).toMatch(/DELETE FROM passkey_challenge/);
    expect(sql.executes[0]?.params[0]).toBe(5_000 - CHALLENGE_TTL_MS);
    expect(sql.executes[1]?.text).toMatch(/INSERT INTO passkey_challenge/);
  });

  it('inserts requested_name when the challenge has requestedName', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    await store.createPasskeyChallenge({
      id: 'ch',
      type: 'register',
      challenge: 'c',
      accountId: 'acc',
      consumed: false,
      createdAt: 5_000,
      requestedName: 'ada',
    });
    expect(sql.executes[1]?.text).toMatch(/requested_name/);
    expect(sql.executes[1]?.params[6]).toBe('ada');
  });

  it('inserts NULL requested_name when the field is omitted', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    await store.createPasskeyChallenge({
      id: 'ch',
      type: 'register',
      challenge: 'c',
      accountId: 'acc',
      consumed: false,
      createdAt: 5_000,
    });
    expect(sql.executes[1]?.text).toMatch(/requested_name/);
    expect(sql.executes[1]?.params[6]).toBeNull();
  });

  it('maps a passkey challenge row', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'ch',
        type: 'authenticate',
        challenge: 'c',
        account_id: null,
        consumed: false,
        created_at: new Date(1_000),
      },
    ];
    expect(await new PostgresAuthStore(sql).getPasskeyChallenge('ch')).toEqual({
      id: 'ch',
      type: 'authenticate',
      challenge: 'c',
      accountId: null,
      consumed: false,
      createdAt: 1_000,
      requestedName: null,
    });
  });

  it('maps a replace passkey challenge row', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'ch',
        type: 'replace',
        challenge: 'c',
        account_id: 'acc',
        consumed: false,
        created_at: new Date(1_000),
      },
    ];
    expect(await new PostgresAuthStore(sql).getPasskeyChallenge('ch')).toEqual({
      id: 'ch',
      type: 'replace',
      challenge: 'c',
      accountId: 'acc',
      consumed: false,
      createdAt: 1_000,
      requestedName: null,
    });
  });

  it('maps requested_name ada onto requestedName', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'ch',
        type: 'register',
        challenge: 'c',
        account_id: 'acc',
        consumed: false,
        created_at: new Date(1_000),
        requested_name: 'ada',
      },
    ];
    expect(await new PostgresAuthStore(sql).getPasskeyChallenge('ch')).toMatchObject({
      requestedName: 'ada',
    });
    expect(sql.queries[0]?.text).toMatch(/requested_name/);
  });

  it('maps a null requested_name onto requestedName null', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'ch',
        type: 'register',
        challenge: 'c',
        account_id: 'acc',
        consumed: false,
        created_at: new Date(1_000),
        requested_name: null,
      },
    ];
    expect(await new PostgresAuthStore(sql).getPasskeyChallenge('ch')).toMatchObject({
      requestedName: null,
    });
  });

  it('lists passkey challenges including requested_name', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'ch',
        type: 'register',
        challenge: 'c',
        account_id: 'acc',
        consumed: false,
        created_at: new Date(1_000),
        requested_name: 'ada',
      },
    ];
    expect((await new PostgresAuthStore(sql).listPasskeyChallenges())[0]?.requestedName).toBe(
      'ada',
    );
    expect(sql.queries[0]?.text).toMatch(/requested_name/);
  });

  it('returns undefined for a missing passkey challenge', async () => {
    expect(await new PostgresAuthStore(new MockSql()).getPasskeyChallenge('x')).toBeUndefined();
  });

  it('updates a passkey challenge only while unconsumed', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ id: 'ch' }];
    const ok = await new PostgresAuthStore(sql).updatePasskeyChallenge({
      id: 'ch',
      type: 'register',
      challenge: 'c',
      accountId: 'acc',
      consumed: true,
      createdAt: 1,
    });
    expect(ok).toBe(true);
    expect(sql.queries[0]?.text).toMatch(/consumed = false/);
  });

  it('keeps requestedName on a consume update', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ id: 'ch' }];
    const ok = await new PostgresAuthStore(sql).updatePasskeyChallenge({
      id: 'ch',
      type: 'register',
      challenge: 'c',
      accountId: 'acc',
      consumed: true,
      createdAt: 1,
      requestedName: 'ada',
    });
    expect(ok).toBe(true);
    expect(sql.queries[0]?.text).toMatch(/requested_name = \$7/);
    expect(sql.queries[0]?.params[6]).toBe('ada');
  });

  it('returns false when the passkey challenge CAS matches no row', async () => {
    expect(
      await new PostgresAuthStore(new MockSql()).updatePasskeyChallenge({
        id: 'ch',
        type: 'register',
        challenge: 'c',
        accountId: null,
        consumed: true,
        createdAt: 1,
      }),
    ).toBe(false);
  });

  it('inserts and maps a passkey credential including a bytea key', async () => {
    const sql = new MockSql();
    const key = new Uint8Array([1, 2, 3]);
    const store = new PostgresAuthStore(sql);
    sql.nextRows = [{ credential_id: 'cred' }];
    expect(
      await store.createPasskeyCredential({
        credentialId: 'cred',
        publicKey: key,
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(true);
    expect(sql.queries[0]?.text).toMatch(/INSERT INTO passkey_credential/);
    expect(sql.queries[0]?.text).toMatch(/ON CONFLICT \(credential_id\) DO NOTHING/);
    sql.nextRows = [];
    expect(
      await store.createPasskeyCredential({
        credentialId: 'cred',
        publicKey: key,
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(false);
    sql.queryError = Object.assign(new Error('duplicate key'), { code: '23505' });
    expect(
      await store.createPasskeyCredential({
        credentialId: 'cred-2',
        publicKey: key,
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(false);
    sql.queryError = new Error('disk full');
    await expect(
      store.createPasskeyCredential({
        credentialId: 'cred-3',
        publicKey: key,
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).rejects.toThrow(/disk full/);
    sql.queryError = undefined;
    sql.nextRows = [
      {
        credential_id: 'cred',
        public_key: key,
        sign_count: 4,
        account_id: 'acc',
        created_at: new Date(1),
      },
    ];
    expect(await store.getPasskeyCredential('cred')).toEqual({
      credentialId: 'cred',
      publicKey: key,
      signCount: 4,
      accountId: 'acc',
      createdAt: 1,
    });
    sql.nextRows = [{ credential_id: 'cred' }];
    expect(
      await store.updatePasskeyCredential({
        credentialId: 'cred',
        publicKey: key,
        signCount: 5,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(true);
    const update = sql.queries[sql.queries.length - 1];
    expect(update?.text).toMatch(/SET sign_count = \$2/);
    expect(update?.text).toMatch(/\$2 = 0 AND sign_count = 0/);
    expect(update?.text).toMatch(/\$2 > sign_count/);
    expect(update?.text).toMatch(/RETURNING credential_id/);
    expect(update?.params).toEqual(['cred', 5]);
    sql.nextRows = [];
    expect(
      await store.updatePasskeyCredential({
        credentialId: 'cred',
        publicKey: key,
        signCount: 5,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(false);
  });

  it('inserts a first passkey only when the account has none', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    sql.nextRows = [{ id: 'acc' }];
    expect(
      await store.createFirstPasskeyCredential({
        credentialId: 'cred',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(true);
    expect(sql.queries[0]?.text).toMatch(/WITH locked AS/);
    expect(sql.queries[0]?.text).toMatch(/inserted AS/);
    expect(sql.queries[0]?.text).toMatch(/wallet_required = TRUE/);
    expect(sql.queries[0]?.text).toMatch(/SELECT id FROM flagged/);
    expect(sql.queries[0]?.text).toMatch(/FOR UPDATE/);
    expect(sql.queries[0]?.text).toMatch(/WHERE NOT EXISTS/);
    expect(sql.queries[0]?.text).toMatch(/session_refused IS NOT TRUE/);
    expect(sql.queries[0]?.text).toMatch(/wallet_required IS NOT TRUE/);
    sql.nextRows = [];
    expect(
      await store.createFirstPasskeyCredential({
        credentialId: 'cred-2',
        publicKey: new Uint8Array([2]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(false);
  });

  it('createFirstPasskeyCredential treats a unique_violation as false', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    sql.queryError = Object.assign(new Error('duplicate key'), { code: '23505' });
    expect(
      await store.createFirstPasskeyCredential({
        credentialId: 'cred',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(false);
  });

  it('createFirstPasskeyCredential rethrows errors that are not unique_violation', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    sql.queryError = new Error('disk full');
    await expect(
      store.createFirstPasskeyCredential({
        credentialId: 'cred',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).rejects.toThrow(/disk full/);
  });

  it('addSeedPasskeyCredential inserts without deleting', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    const key = new Uint8Array([1]);
    sql.nextRows = [{ id: 'acc' }];
    expect(
      await store.addSeedPasskeyCredential({
        credentialId: 'cred',
        publicKey: key,
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(true);
    expect(sql.executes).toEqual([]);
    expect(sql.queries).toHaveLength(1);
    const query = sql.queries[0];
    expect(query?.text).toMatch(/WITH locked/);
    expect(query?.text).toMatch(/FOR UPDATE/);
    expect(query?.text).toMatch(/wallet_required IS NOT TRUE/);
    expect(query?.text).toMatch(/session_refused IS NOT TRUE/);
    expect(query?.text).toMatch(/INSERT INTO passkey_credential/);
    expect(query?.text).toMatch(/ON CONFLICT \(credential_id\) DO NOTHING/);
    expect(query?.text).toMatch(/SET wallet_required = TRUE/);
    expect(query?.text).toMatch(/SELECT id FROM flagged/);
    expect(query?.text).not.toMatch(/DELETE/);
    expect(query?.params).toEqual(['cred', key, 0, 'acc', 1]);
  });

  it('addSeedPasskeyCredential returns false when the insert matches no row', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    expect(
      await new PostgresAuthStore(sql).addSeedPasskeyCredential({
        credentialId: 'cred',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(false);
  });

  it('addSeedPasskeyCredential treats a unique_violation as false', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    sql.queryError = Object.assign(new Error('duplicate key'), { code: '23505' });
    expect(
      await store.addSeedPasskeyCredential({
        credentialId: 'cred',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).toBe(false);
  });

  it('addSeedPasskeyCredential rethrows errors that are not unique_violation', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    sql.queryError = new Error('disk full');
    await expect(
      store.addSeedPasskeyCredential({
        credentialId: 'cred',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 1,
      }),
    ).rejects.toThrow(/disk full/);
  });

  it('looks up a passkey credential by account id', async () => {
    const sql = new MockSql();
    const key = new Uint8Array([1, 2, 3]);
    sql.nextRows = [
      {
        credential_id: 'cred',
        public_key: key,
        sign_count: 0,
        account_id: 'acc',
        created_at: new Date(1),
      },
    ];
    expect(await new PostgresAuthStore(sql).getPasskeyCredentialForAccount('acc')).toEqual({
      credentialId: 'cred',
      publicKey: key,
      signCount: 0,
      accountId: 'acc',
      createdAt: 1,
    });
    expect(sql.queries[0]?.text).toMatch(/WHERE account_id = \$1/);
    expect(sql.queries[0]?.text).toMatch(
      /ORDER BY created_at DESC, credential_id COLLATE "C" DESC/,
    );
    expect(sql.queries[0]?.text).toMatch(/LIMIT 1/);
    sql.nextRows = [];
    expect(
      await new PostgresAuthStore(sql).getPasskeyCredentialForAccount('missing'),
    ).toBeUndefined();
  });

  it('replaces a passkey credential in one statement', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    const next = {
      credentialId: 'cred-2',
      publicKey: new Uint8Array([4, 5, 6]),
      signCount: 0,
      accountId: 'acc',
      createdAt: 2,
    };
    sql.nextRows = [{ credential_id: 'cred-2' }];
    expect(await store.replacePasskeyCredential(next)).toBe(true);
    expect(sql.executes).toEqual([]);
    expect(sql.queries).toHaveLength(1);
    const query = sql.queries[0];
    expect(query?.text).toMatch(/WITH deleted AS/);
    expect(query?.text).toMatch(/DELETE FROM passkey_credential WHERE account_id = \$4/);
    expect(query?.text).toMatch(/INSERT INTO passkey_credential/);
    expect(query?.text).toMatch(/WHERE EXISTS \(SELECT 1 FROM deleted\)/);
    expect(query?.text).not.toMatch(/ON CONFLICT/);
    expect(query?.text).toMatch(/RETURNING credential_id/);
    expect(query?.params).toEqual(['cred-2', new Uint8Array([4, 5, 6]), 0, 'acc', 2]);
  });

  it('returns false when replace deletes no credential', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    expect(
      await new PostgresAuthStore(sql).replacePasskeyCredential({
        credentialId: 'cred-2',
        publicKey: new Uint8Array([4]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 2,
      }),
    ).toBe(false);
    expect(sql.executes).toEqual([]);
    expect(sql.queries).toHaveLength(1);
  });

  it('returns false when replace insert lands on no row', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    expect(
      await new PostgresAuthStore(sql).replacePasskeyCredential({
        credentialId: 'cred-2',
        publicKey: new Uint8Array([4]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 2,
      }),
    ).toBe(false);
    expect(sql.executes).toEqual([]);
    expect(sql.queries[0]?.text).not.toMatch(/ON CONFLICT/);
  });

  it('returns false when replace insert hits unique_violation', async () => {
    const sql = new MockSql();
    sql.queryError = Object.assign(new Error('duplicate key'), { code: '23505' });
    expect(
      await new PostgresAuthStore(sql).replacePasskeyCredential({
        credentialId: 'cred-2',
        publicKey: new Uint8Array([4]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 2,
      }),
    ).toBe(false);
    expect(sql.executes).toEqual([]);
  });

  it('rethrows replace errors that are not unique_violation', async () => {
    const sql = new MockSql();
    sql.queryError = new Error('disk full');
    await expect(
      new PostgresAuthStore(sql).replacePasskeyCredential({
        credentialId: 'cred-2',
        publicKey: new Uint8Array([4]),
        signCount: 0,
        accountId: 'acc',
        createdAt: 2,
      }),
    ).rejects.toThrow(/disk full/);
    expect(sql.executes).toEqual([]);
  });

  it('returns undefined for a missing passkey credential', async () => {
    expect(await new PostgresAuthStore(new MockSql()).getPasskeyCredential('x')).toBeUndefined();
  });

  it('rejects an unknown passkey challenge type', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'ch',
        type: 'nope',
        challenge: 'c',
        account_id: null,
        consumed: false,
        created_at: new Date(1),
      },
    ];
    await expect(new PostgresAuthStore(sql).getPasskeyChallenge('ch')).rejects.toThrow(
      /Unknown passkey challenge type/,
    );
  });

  it('maps a seed passkey challenge row', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'ch',
        type: 'seed',
        challenge: 'c',
        account_id: 'acc',
        consumed: false,
        created_at: new Date(1_000),
      },
    ];
    expect(await new PostgresAuthStore(sql).getPasskeyChallenge('ch')).toEqual({
      id: 'ch',
      type: 'seed',
      challenge: 'c',
      accountId: 'acc',
      consumed: false,
      createdAt: 1_000,
      requestedName: null,
    });
  });

  it('maps a passkey challenge timestamp from an ISO string', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'ch',
        type: 'register',
        challenge: 'c',
        account_id: 'acc',
        consumed: false,
        created_at: '1970-01-01T00:00:01.000Z',
      },
    ];
    const row = await new PostgresAuthStore(sql).getPasskeyChallenge('ch');
    expect(row?.createdAt).toBe(1_000);
  });

  it('lists passkeys, sessions, challenges, and nostr keys', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    sql.nextRows = [
      {
        credential_id: 'cred',
        public_key: Array.from(new Uint8Array([1, 2])),
        sign_count: 0,
        account_id: 'acc',
        created_at: new Date(1_000),
      },
    ];
    const listedPasskeys = await store.listPasskeyCredentials();
    expect(listedPasskeys[0]?.credentialId).toBe('cred');
    expect(listedPasskeys[0]?.publicKey).toEqual(new Uint8Array([1, 2]));
    sql.nextRows = [{ token: 'tok', account_id: 'acc', created_at: new Date(2_000) }];
    expect(await store.listSessions()).toEqual([
      { token: 'tok', accountId: 'acc', createdAt: 2_000 },
    ]);
    sql.nextRows = [
      {
        id: 'ch',
        type: 'register',
        challenge: 'c',
        account_id: 'acc',
        consumed: false,
        created_at: new Date(3_000),
      },
    ];
    expect((await store.listPasskeyChallenges())[0]?.id).toBe('ch');
    sql.nextRows = [
      {
        id: 'acc',
        nostr_pubkey: 'aa'.repeat(32),
        nostr_nsec_ciphertext: new Uint8Array([9]),
        nostr_kek_id: 1,
        nostr_key_custody: 'user',
        nostr_key_created_at: new Date(5_000),
      },
      {
        id: 'skip',
        nostr_pubkey: null,
        nostr_nsec_ciphertext: null,
        nostr_kek_id: null,
        nostr_key_custody: null,
        nostr_key_created_at: null,
      },
      {
        id: 'acc2',
        nostr_pubkey: 'bb'.repeat(32),
        nostr_nsec_ciphertext: null,
        nostr_kek_id: null,
        nostr_key_custody: 'custodial',
        nostr_key_created_at: null,
      },
      {
        id: 'undef',
        nostr_pubkey: 'cc'.repeat(32),
        nostr_key_custody: 'other',
      },
    ];
    const keys = await store.listNostrKeys();
    expect(sql.queries[sql.queries.length - 1]?.text).not.toContain(
      'WHERE nostr_pubkey IS NOT NULL',
    );
    expect(keys).toHaveLength(4);
    const skip = keys.find((row) => row.accountId === 'skip');
    expect(skip?.record.pubkey).toBeNull();
    expect(skip?.record.kekId).toBe(1);
    expect(skip?.record.custody).toBe('custodial');
    expect(skip?.record.ciphertext).toEqual(new Uint8Array());
    expect(skip?.createdAt).toBeNull();
    expect(keys[0]?.record.custody).toBe('user');
    expect(keys[0]?.createdAt).toBe(5_000);
    const acc2 = keys.find((row) => row.accountId === 'acc2');
    expect(acc2?.record.ciphertext).toEqual(new Uint8Array());
    expect(acc2?.createdAt).toBeNull();
    const undef = keys.find((row) => row.accountId === 'undef');
    expect(undef?.record.pubkey).toBe('cc'.repeat(32));
    expect(undef?.record.kekId).toBe(1);
    expect(undef?.record.custody).toBe('custodial');
    expect(undef?.record.ciphertext).toEqual(new Uint8Array());
    expect(undef?.createdAt).toBeNull();
  });

  it('markWalletBackupSeen writes only when the timestamp is still null', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ ...ACCOUNT_ROW, wallet_backup_seen_at: new Date(10) }];
    const stored = await new PostgresAuthStore(sql).markWalletBackupSeen('acc', 10);
    expect(sql.queries[0]?.text).toMatch(/wallet_backup_seen_at IS NULL/);
    expect(stored?.wrote).toBe(true);
    expect(stored?.account.walletBackupSeenAt).toBe(10);
  });

  it('markWalletBackupSeen returns undefined when no row is updated', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    expect(await new PostgresAuthStore(sql).markWalletBackupSeen('missing', 10)).toBeUndefined();
  });

  it('markWalletBackupSeen returns the existing row when the timestamp is already set', async () => {
    const sql = new MockSql();
    sql.nextQueryRows = [[], [{ ...ACCOUNT_ROW, wallet_backup_seen_at: new Date(9) }]];
    const stored = await new PostgresAuthStore(sql).markWalletBackupSeen('acc', 10);
    expect(sql.queries).toHaveLength(2);
    expect(sql.queries[1]?.text).toMatch(/SELECT/);
    expect(stored?.wrote).toBe(false);
    expect(stored?.account.walletBackupSeenAt).toBe(9);
  });

  it('markWalletBackupSeen returns undefined when the written row has no view key', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ ...ACCOUNT_ROW, view_key: null, wallet_backup_seen_at: new Date(10) }];
    expect(await new PostgresAuthStore(sql).markWalletBackupSeen('acc', 10)).toBeUndefined();
  });

  it('markWalletBackupSeen returns undefined when the existing row has no view key', async () => {
    const sql = new MockSql();
    sql.nextQueryRows = [
      [],
      [{ ...ACCOUNT_ROW, view_key: null, wallet_backup_seen_at: new Date(9) }],
    ];
    expect(await new PostgresAuthStore(sql).markWalletBackupSeen('acc', 10)).toBeUndefined();
  });

  it('insertPasskeyRenewAttempt binds redacted fields', async () => {
    const sql = new MockSql();
    const twelve = 'one two three four five six seven eight nine ten eleven twelve';
    await new PostgresAuthStore(sql).insertPasskeyRenewAttempt({
      id: 'row-1',
      accountId: 'acc',
      createdAt: 9,
      stage: 'ceremony',
      outcome: 'failed',
      errorName: 'Error',
      errorCode: null,
      httpStatus: 400,
      message: twelve,
      userAgent: 'Mozilla',
    });
    expect(sql.executes[0]?.text).toMatch(/INSERT INTO passkey_renew_attempt/);
    expect(sql.executes[0]?.params).toEqual([
      'row-1',
      'acc',
      9,
      'ceremony',
      'failed',
      'Error',
      null,
      400,
      '[redacted]',
      'Mozilla',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('insertPasskeyRenewAttempt redacts a long secret and caps a long code', async () => {
    const sql = new MockSql();
    const longName = `${'a'.repeat(64)}name`;
    const longCode = `${'c'.repeat(40)}.${'d'.repeat(40)}`;
    const phrase = Array.from({ length: 12 }, () => 'x'.repeat(50)).join(' ');
    await new PostgresAuthStore(sql).insertPasskeyRenewAttempt({
      id: 'row-long',
      accountId: 'acc',
      createdAt: 9,
      stage: 'ceremony',
      outcome: 'failed',
      errorName: longName,
      errorCode: longCode,
      httpStatus: null,
      message: phrase,
      userAgent: 'Mozilla',
    });
    expect(sql.executes[0]?.params).toEqual([
      'row-long',
      'acc',
      9,
      'ceremony',
      'failed',
      '[redacted]',
      longCode.slice(0, 80),
      null,
      '[redacted]',
      'Mozilla',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('insertPasskeyRenewAttempt keeps allowlisted authenticator facts only', async () => {
    const sql = new MockSql();
    await new PostgresAuthStore(sql).insertPasskeyRenewAttempt({
      id: 'row-debug',
      accountId: 'acc',
      createdAt: 9,
      stage: 'ceremony',
      outcome: 'failed',
      errorName: 'prfUnsupported',
      errorCode: null,
      httpStatus: null,
      message: 'wallet.prfUnsupported',
      userAgent: 'Mozilla',
      authenticatorAttachment: 'cross-platform',
      transports: 'internal,usb,not-a-transport',
      aaguid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
      prfEnabled: false,
      prfPresent: false,
      extensions: 'prf,secret,credProps',
      authenticatorFlags: 0x1d,
      publicKeyAlgorithm: -7,
      residentKey: true,
      hmacSecret: false,
      credProtect: 'userVerificationOptional',
      clientCapabilities: 'prf,hybridTransport',
    });
    expect(sql.executes[0]?.params?.slice(10)).toEqual([
      'cross-platform',
      'internal,usb',
      'aaaaaaaabbbbccccddddeeeeeeeeeeee',
      false,
      false,
      'credProps,prf',
      0x1d,
      -7,
      true,
      false,
      'userVerificationOptional',
      'hybridTransport,prf',
    ]);
  });

  it('insertPasskeyRenewAttempt nulls debug values that are not safe to store', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    const base = {
      id: 'row-bad',
      accountId: 'acc',
      createdAt: 9,
      stage: 'ceremony' as const,
      outcome: 'failed' as const,
      errorName: 'Error',
      errorCode: null,
      httpStatus: null,
      message: 'seed failed',
      userAgent: 'Mozilla',
    };
    const none = [null, null, null, null, null, null, null, null, null, null, null, null];
    await store.insertPasskeyRenewAttempt({
      ...base,
      authenticatorAttachment: 1,
      transports: 1,
      aaguid: 2,
      prfEnabled: 'false',
      prfPresent: 0,
      extensions: 3,
      authenticatorFlags: '8',
      publicKeyAlgorithm: 1.5,
      residentKey: 'true',
      hmacSecret: 1,
      credProtect: 1.5,
      clientCapabilities: 4,
    });
    await store.insertPasskeyRenewAttempt({
      ...base,
      id: 'row-range',
      authenticatorAttachment: 'nope',
      transports: '',
      aaguid: 'zz',
      extensions: 'nope',
      authenticatorFlags: -1,
      publicKeyAlgorithm: 65536,
      credProtect: 0,
      clientCapabilities: '!!!',
    });
    await store.insertPasskeyRenewAttempt({
      ...base,
      id: 'row-high',
      authenticatorFlags: 256,
      publicKeyAlgorithm: -65537,
      credProtect: 4,
      clientCapabilities: '',
    });
    await store.insertPasskeyRenewAttempt({
      ...base,
      id: 'row-edge',
      authenticatorAttachment: 'platform',
      transports: 'usb,usb,ble',
      aaguid: 'ab'.repeat(16),
      prfEnabled: false,
      prfPresent: true,
      extensions: 'uvm,prf,uvm',
      authenticatorFlags: 0,
      publicKeyAlgorithm: -65536,
      residentKey: false,
      hmacSecret: true,
      credProtect: 2,
      clientCapabilities: Array.from(
        { length: 25 },
        (_, i) => `c${String(i).padStart(2, '0')}`,
      ).join(','),
    });
    await store.insertPasskeyRenewAttempt({
      ...base,
      id: 'row-policy',
      authenticatorFlags: 255,
      publicKeyAlgorithm: 65535,
      credProtect: 'userVerificationRequired',
      clientCapabilities: 'prf, hybridTransport ,prf',
    });
    await store.insertPasskeyRenewAttempt({
      ...base,
      id: 'row-code',
      credProtect: 3,
    });
    await store.insertPasskeyRenewAttempt({
      ...base,
      id: 'row-policy-bad',
      credProtect: 'nope',
    });
    expect(sql.executes[0]?.params?.slice(10)).toEqual(none);
    expect(sql.executes[1]?.params?.slice(10)).toEqual(none);
    expect(sql.executes[2]?.params?.slice(10)).toEqual(none);
    expect(sql.executes[3]?.params?.slice(10)).toEqual([
      'platform',
      'ble,usb',
      'ab'.repeat(16),
      false,
      true,
      'prf,uvm',
      0,
      -65536,
      false,
      true,
      'userVerificationOptionalWithCredentialIDList',
      Array.from({ length: 24 }, (_, i) => `c${String(i).padStart(2, '0')}`).join(','),
    ]);
    expect(sql.executes[4]?.params?.slice(10)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      255,
      65535,
      null,
      null,
      'userVerificationRequired',
      'hybridTransport,prf',
    ]);
    expect(sql.executes[5]?.params?.slice(10)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'userVerificationRequired',
      null,
    ]);
    expect(sql.executes[6]?.params?.slice(10)).toEqual(none);
  });

  it('latestUnacknowledgedPasskeyRenewErrorName reads the newest failed name', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    sql.nextRows = [{ error_name: 'prfUnsupported' }];
    expect(await store.latestUnacknowledgedPasskeyRenewErrorName('acc')).toBe('prfUnsupported');
    expect(sql.queries[0]?.text).toMatch(/ORDER BY created_at DESC, id DESC/);
    expect(sql.queries[0]?.text).toMatch(/acknowledged_at IS NULL/);
    expect(sql.queries[0]?.params).toEqual(['acc']);
    sql.nextRows = [{ error_name: null }];
    expect(await store.latestUnacknowledgedPasskeyRenewErrorName('acc')).toBeNull();
    sql.nextRows = [];
    expect(await store.latestUnacknowledgedPasskeyRenewErrorName('acc')).toBeNull();
  });

  it('acknowledgePasskeyRenewFailures updates only failed unacknowledged rows', async () => {
    const sql = new MockSql();
    await new PostgresAuthStore(sql).acknowledgePasskeyRenewFailures('acc', 11);
    expect(sql.executes[0]?.text).toMatch(
      /UPDATE passkey_renew_attempt[\s\S]*outcome = 'failed' AND acknowledged_at IS NULL/,
    );
    expect(sql.executes[0]?.params).toEqual(['acc', 11]);
  });

  it('hasUnacknowledgedPasskeyRenewFailure is true when a row exists and false when none', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    sql.nextRows = [{ exists: 1 }];
    expect(await store.hasUnacknowledgedPasskeyRenewFailure('acc')).toBe(true);
    expect(sql.queries[0]?.text).toMatch(/SELECT 1 AS exists/);
    expect(sql.queries[0]?.text).toMatch(/LIMIT 1/);
    expect(sql.queries[0]?.params).toEqual(['acc']);
    sql.nextRows = [];
    expect(await store.hasUnacknowledgedPasskeyRenewFailure('acc')).toBe(false);
    expect(sql.queries[1]?.text).toMatch(/LIMIT 1/);
  });

  it('deleteFailedPasskeyRenewAttempts deletes only failed rows', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ id: 'f1' }, { id: 'f2' }];
    const deleted = await new PostgresAuthStore(sql).deleteFailedPasskeyRenewAttempts('acc');
    expect(deleted).toBe(2);
    expect(sql.queries[0]?.text).toMatch(
      /DELETE FROM passkey_renew_attempt[\s\S]*outcome = 'failed'[\s\S]*RETURNING id/,
    );
    expect(sql.queries[0]?.params).toEqual(['acc']);
    sql.nextRows = [];
    expect(await new PostgresAuthStore(sql).deleteFailedPasskeyRenewAttempts('acc')).toBe(0);
  });

  it('hasAcknowledgedPasskeyRenewFailure requires acknowledged_at', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    sql.nextRows = [{ exists: 1 }];
    expect(await store.hasAcknowledgedPasskeyRenewFailure('acc')).toBe(true);
    expect(sql.queries[0]?.text).toMatch(/acknowledged_at IS NOT NULL/);
    expect(sql.queries[0]?.params).toEqual(['acc']);
    sql.nextRows = [];
    expect(await store.hasAcknowledgedPasskeyRenewFailure('acc')).toBe(false);
  });

  it('setAccountLocale writes only when locale is still null', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ ...ACCOUNT_ROW, locale: 'de' }];
    const stored = await new PostgresAuthStore(sql).setAccountLocale('acc', 'de', true);
    expect(sql.queries[0]?.text).toMatch(/locale IS NULL/);
    expect(sql.queries[0]?.params).toEqual(['acc', 'de']);
    expect(stored?.wrote).toBe(true);
    expect(stored?.account.locale).toBe('de');
  });

  it('setAccountLocale writes unconditionally when onlyIfUnset is false', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ ...ACCOUNT_ROW, locale: 'de' }];
    const stored = await new PostgresAuthStore(sql).setAccountLocale('acc', 'de', false);
    expect(sql.queries[0]?.text).not.toMatch(/IS NULL/);
    expect(sql.queries[0]?.params).toEqual(['acc', 'de']);
    expect(stored?.wrote).toBe(true);
    expect(stored?.account.locale).toBe('de');
  });

  it('setAccountLocale returns undefined when no row is updated', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    expect(
      await new PostgresAuthStore(sql).setAccountLocale('missing', 'de', false),
    ).toBeUndefined();
  });

  it('setAccountLocale returns the existing row when locale is already set', async () => {
    const sql = new MockSql();
    sql.nextQueryRows = [[], [{ ...ACCOUNT_ROW, locale: 'de' }]];
    const stored = await new PostgresAuthStore(sql).setAccountLocale('acc', 'en', true);
    expect(sql.queries).toHaveLength(2);
    expect(sql.queries[1]?.text).toMatch(/SELECT/);
    expect(stored?.wrote).toBe(false);
    expect(stored?.account.locale).toBe('de');
  });

  it('setAccountLocale returns undefined when the written row has no view key', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ ...ACCOUNT_ROW, view_key: null, locale: 'de' }];
    expect(await new PostgresAuthStore(sql).setAccountLocale('acc', 'de', false)).toBeUndefined();
  });

  it('setAccountLocale returns undefined when the existing row has no view key', async () => {
    const sql = new MockSql();
    sql.nextQueryRows = [[], [{ ...ACCOUNT_ROW, view_key: null, locale: 'de' }]];
    expect(await new PostgresAuthStore(sql).setAccountLocale('acc', 'en', true)).toBeUndefined();
  });

  it('setAccountFiat writes only when fiat is still null', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ ...ACCOUNT_ROW, fiat: 'CHF' }];
    const stored = await new PostgresAuthStore(sql).setAccountFiat('acc', 'CHF', true);
    expect(sql.queries[0]?.text).toMatch(/fiat IS NULL/);
    expect(sql.queries[0]?.params).toEqual(['acc', 'CHF']);
    expect(stored?.wrote).toBe(true);
    expect(stored?.account.fiat).toBe('CHF');
  });

  it('setAccountFiat writes unconditionally when onlyIfUnset is false', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ ...ACCOUNT_ROW, fiat: 'CHF' }];
    const stored = await new PostgresAuthStore(sql).setAccountFiat('acc', 'CHF', false);
    expect(sql.queries[0]?.text).not.toMatch(/IS NULL/);
    expect(sql.queries[0]?.params).toEqual(['acc', 'CHF']);
    expect(stored?.wrote).toBe(true);
    expect(stored?.account.fiat).toBe('CHF');
  });

  it('setAccountFiat returns undefined when no row is updated', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    expect(
      await new PostgresAuthStore(sql).setAccountFiat('missing', 'CHF', false),
    ).toBeUndefined();
  });

  it('setAccountFiat returns the existing row when fiat is already set', async () => {
    const sql = new MockSql();
    sql.nextQueryRows = [[], [{ ...ACCOUNT_ROW, fiat: 'CHF' }]];
    const stored = await new PostgresAuthStore(sql).setAccountFiat('acc', 'EUR', true);
    expect(sql.queries).toHaveLength(2);
    expect(sql.queries[1]?.text).toMatch(/SELECT/);
    expect(stored?.wrote).toBe(false);
    expect(stored?.account.fiat).toBe('CHF');
  });

  it('setAccountFiat returns undefined when the written row has no view key', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ ...ACCOUNT_ROW, view_key: null, fiat: 'CHF' }];
    expect(await new PostgresAuthStore(sql).setAccountFiat('acc', 'CHF', false)).toBeUndefined();
  });

  it('setAccountFiat returns undefined when the existing row has no view key', async () => {
    const sql = new MockSql();
    sql.nextQueryRows = [[], [{ ...ACCOUNT_ROW, view_key: null, fiat: 'CHF' }]];
    expect(await new PostgresAuthStore(sql).setAccountFiat('acc', 'EUR', true)).toBeUndefined();
  });
});

describe('PostgresAuthStore spark pubkey', () => {
  const PUBKEY = `02${'a'.repeat(64)}`;

  it('claimSparkPubkey updates with the conditional SQL and returns wrote true', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      { ...ACCOUNT_ROW, spark_pubkey: PUBKEY, wallet_required: true, username: 'ada' },
    ];
    const stored = await new PostgresAuthStore(sql).claimSparkPubkey('acc', PUBKEY);
    expect(sql.queries[0]?.text).toMatch(
      /UPDATE account SET spark_pubkey = \$2, spark_address = \$3/,
    );
    expect(sql.queries[0]?.text).toMatch(/spark_pubkey_verified_at IS NULL/);
    expect(sql.queries[0]?.text).toMatch(/wallet_required IS TRUE/);
    expect(sql.queries[0]?.text).toMatch(/username IS NOT NULL AND trim\(username\) <> ''/);
    expect(sql.queries[0]?.text).toMatch(/RETURNING/);
    expect(sql.queries[0]?.params).toEqual(['acc', PUBKEY, encodeSparkAddress(PUBKEY)]);
    expect(stored?.wrote).toBe(true);
    expect(stored?.account.sparkPubkey).toBe(PUBKEY);
  });

  it('claimSparkPubkey re-selects and returns wrote false when no row is updated', async () => {
    const sql = new MockSql();
    sql.nextQueryRows = [[], [{ ...ACCOUNT_ROW, wallet_required: false }]];
    const stored = await new PostgresAuthStore(sql).claimSparkPubkey('acc', PUBKEY);
    expect(sql.queries).toHaveLength(2);
    expect(sql.queries[1]?.text).toMatch(/SELECT/);
    expect(sql.queries[1]?.params).toEqual(['acc']);
    expect(stored?.wrote).toBe(false);
  });

  it('claimSparkPubkey returns undefined for an unknown id', async () => {
    const sql = new MockSql();
    sql.nextQueryRows = [[], []];
    expect(await new PostgresAuthStore(sql).claimSparkPubkey('missing', PUBKEY)).toBeUndefined();
  });

  it('claimSparkPubkey returns undefined when the written row has no view key', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ ...ACCOUNT_ROW, view_key: null, spark_pubkey: PUBKEY }];
    expect(await new PostgresAuthStore(sql).claimSparkPubkey('acc', PUBKEY)).toBeUndefined();
  });

  it('claimSparkPubkey returns undefined when the existing row has no view key', async () => {
    const sql = new MockSql();
    sql.nextQueryRows = [[], [{ ...ACCOUNT_ROW, view_key: null }]];
    expect(await new PostgresAuthStore(sql).claimSparkPubkey('acc', PUBKEY)).toBeUndefined();
  });

  it('markSparkPubkeyVerified uses the conditional SQL and returns true when a row is updated', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ id: 'acc' }];
    expect(await new PostgresAuthStore(sql).markSparkPubkeyVerified('acc', PUBKEY, 'ada', 10)).toBe(
      true,
    );
    expect(sql.queries[0]?.text).toMatch(
      /UPDATE account SET spark_pubkey_verified_at = to_timestamp\(\$4::double precision \/ 1000\.0\)/,
    );
    expect(sql.queries[0]?.text).toMatch(/spark_pubkey = \$2/);
    expect(sql.queries[0]?.text).toMatch(/spark_pubkey_verified_at IS NULL/);
    expect(sql.queries[0]?.text).toMatch(/lower\(trim\(username\)\) = \$3/);
    expect(sql.queries[0]?.params).toEqual(['acc', PUBKEY, 'ada', 10]);
  });

  it('markSparkPubkeyVerified returns false when no row is updated', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    expect(await new PostgresAuthStore(sql).markSparkPubkeyVerified('acc', PUBKEY, 'ada', 10)).toBe(
      false,
    );
  });

  it('markSparkPubkeyVerified returns false on unique violation', async () => {
    const sql = new MockSql();
    sql.queryError = Object.assign(new Error('duplicate key'), { code: '23505' });
    expect(await new PostgresAuthStore(sql).markSparkPubkeyVerified('acc', PUBKEY, 'ada', 10)).toBe(
      false,
    );
  });

  it('markSparkPubkeyVerified rethrows other errors', async () => {
    const sql = new MockSql();
    sql.queryError = new Error('boom');
    await expect(
      new PostgresAuthStore(sql).markSparkPubkeyVerified('acc', PUBKEY, 'ada', 10),
    ).rejects.toThrow('boom');
  });

  it('getAccountByVerifiedSparkPubkey selects a verified row', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        ...ACCOUNT_ROW,
        spark_pubkey: PUBKEY,
        spark_pubkey_verified_at: new Date(10),
      },
    ];
    const account = await new PostgresAuthStore(sql).getAccountByVerifiedSparkPubkey(PUBKEY);
    expect(sql.queries[0]?.text).toMatch(
      /WHERE spark_pubkey = \$1 AND spark_pubkey_verified_at IS NOT NULL/,
    );
    expect(sql.queries[0]?.params).toEqual([PUBKEY]);
    expect(account?.sparkPubkey).toBe(PUBKEY);
    expect(account?.sparkPubkeyVerifiedAt).toBe(10);
  });

  it('getAccountByVerifiedSparkPubkey returns undefined when no row matches', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    expect(
      await new PostgresAuthStore(sql).getAccountByVerifiedSparkPubkey(PUBKEY),
    ).toBeUndefined();
  });

  it('isSparkPubkeyClaimed returns true when a row holds the key', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ one: 1 }];
    expect(await new PostgresAuthStore(sql).isSparkPubkeyClaimed(PUBKEY)).toBe(true);
    expect(sql.queries[0]?.text).toBe(
      'SELECT 1 AS one FROM account WHERE spark_pubkey = $1 LIMIT 1',
    );
    expect(sql.queries[0]?.params).toEqual([PUBKEY]);
  });

  it('isSparkPubkeyClaimed returns false when no row holds the key', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    expect(await new PostgresAuthStore(sql).isSparkPubkeyClaimed(PUBKEY)).toBe(false);
  });

  it('maps spark_pubkey and spark_pubkey_verified_at', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        ...ACCOUNT_ROW,
        spark_pubkey: PUBKEY,
        spark_pubkey_verified_at: new Date(4_000),
      },
    ];
    const mapped = await new PostgresAuthStore(sql).getAccount('acc');
    expect(mapped?.sparkPubkey).toBe(PUBKEY);
    expect(mapped?.sparkPubkeyVerifiedAt).toBe(4_000);
  });

  it('maps omitted spark columns to null', async () => {
    const sql = new MockSql();
    sql.nextRows = [ACCOUNT_ROW];
    const mapped = await new PostgresAuthStore(sql).getAccount('acc');
    expect(mapped?.sparkPubkey).toBeNull();
    expect(mapped?.sparkPubkeyVerifiedAt).toBeNull();
  });

  it('SELECT columns include spark_pubkey and spark_pubkey_verified_at', async () => {
    const sql = new MockSql();
    sql.nextRows = [ACCOUNT_ROW];
    await new PostgresAuthStore(sql).getAccount('acc');
    expect(sql.queries[0]?.text).toMatch(/spark_pubkey/);
    expect(sql.queries[0]?.text).toMatch(/spark_pubkey_verified_at/);
  });
});

describe('PostgresAuthStore setUsername', () => {
  it('updates with FOR UPDATE and returns the previous username', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ previous: 'ada' }];
    expect(await new PostgresAuthStore(sql).setUsername('acc', 'grace')).toEqual({
      ok: true,
      previous: 'ada',
    });
    expect(sql.queries[0]?.text).toMatch(/UPDATE account AS a SET username = \$2/);
    expect(sql.queries[0]?.text).toMatch(/FOR UPDATE/);
    expect(sql.queries[0]?.text).toMatch(/spark_pubkey_verified_at IS NULL/);
    expect(sql.queries[0]?.text).toMatch(/RETURNING before\.previous/);
    expect(sql.queries[0]?.params).toEqual(['acc', 'grace']);
  });

  it('returns previous null when the row had no username', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ previous: null }];
    expect(await new PostgresAuthStore(sql).setUsername('acc', 'ada')).toEqual({
      ok: true,
      previous: null,
    });
  });

  it('coalesces a missing previous column to null', async () => {
    const sql = new MockSql();
    sql.nextRows = [{}];
    expect(await new PostgresAuthStore(sql).setUsername('acc', 'ada')).toEqual({
      ok: true,
      previous: null,
    });
  });

  it('returns frozen when the update matches no row and the account exists', async () => {
    const sql = new MockSql();
    sql.nextQueryRows = [[], [{ spark_pubkey_verified_at: new Date(10) }]];
    expect(await new PostgresAuthStore(sql).setUsername('acc', 'grace')).toEqual({
      ok: false,
      reason: 'frozen',
    });
    expect(sql.queries[1]?.text).toMatch(
      /SELECT spark_pubkey_verified_at FROM account WHERE id = \$1/,
    );
    expect(sql.queries[1]?.params).toEqual(['acc']);
  });

  it('returns missing when the update matches no row and the account is gone', async () => {
    const sql = new MockSql();
    sql.nextQueryRows = [[], []];
    expect(await new PostgresAuthStore(sql).setUsername('missing', 'ada')).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it('returns taken on unique violation', async () => {
    const sql = new MockSql();
    sql.queryError = Object.assign(new Error('duplicate key'), { code: '23505' });
    expect(await new PostgresAuthStore(sql).setUsername('acc', 'ada')).toEqual({
      ok: false,
      reason: 'taken',
    });
  });

  it('rethrows errors that are not unique_violation', async () => {
    const sql = new MockSql();
    sql.queryError = new Error('boom');
    await expect(new PostgresAuthStore(sql).setUsername('acc', 'ada')).rejects.toThrow('boom');
  });
});

describe('PostgresAuthStore social recovery', () => {
  const OLD = `02${'1'.repeat(64)}`;
  const NEW = `03${'2'.repeat(64)}`;
  const NOW = 50_000_000;
  const CUTOFF = NOW - CHALLENGE_TTL_MS;

  interface Recorded {
    text: string;
    params: readonly unknown[];
  }

  /** Transaction port that records each statement and answers the scripted rows in order. */
  function transactions(script: unknown[][] = []): {
    db: MergeDb;
    queries: Recorded[];
    begins: { n: number };
  } {
    const queries: Recorded[] = [];
    const begins = { n: 0 };
    const db: MergeDb = {
      async begin(run) {
        begins.n += 1;
        return run({
          async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
            queries.push({ text, params });
            const next = script.shift();
            if (next instanceof Error) {
              throw next;
            }
            return (next ?? []) as T[];
          },
        });
      },
    };
    return { db, queries, begins };
  }

  const holder = (overrides: Record<string, unknown> = {}) => ({
    id: 'acc',
    username: 'Ada',
    spark_pubkey: OLD,
    spark_address: encodeSparkAddress(OLD),
    spark_pubkey_verified_at: new Date(10),
    session_refused: false,
    ...overrides,
  });

  const pendingRow = (overrides: Record<string, unknown> = {}) => ({
    account_id: 'acc',
    old_spark_pubkey: OLD,
    new_spark_pubkey: NEW,
    credential_id: 'new-credential',
    public_key: Uint8Array.of(4, 5, 6),
    sign_count: 0,
    created_at: new Date(NOW),
    forwarded_at: null as Date | string | null,
    ...overrides,
  });

  const pending: PendingRecovery = {
    accountId: 'acc',
    oldSparkPubkey: OLD,
    newSparkPubkey: NEW,
    credentialId: 'new-credential',
    publicKey: Uint8Array.of(4, 5, 6),
    signCount: 0,
    createdAt: NOW,
    forwardedAt: null,
  };

  const challenge = {
    id: 'c1',
    type: 'recovery' as const,
    challenge: 'chal',
    accountId: 'acc',
    consumed: false,
    createdAt: NOW,
  };

  it('throws on every locked step without a transaction port', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    const message = 'auth transactions are not configured';
    await expect(
      store.startRecoveryChallenge({ accountId: 'acc', oldSparkPubkey: OLD, challenge, now: NOW }),
    ).rejects.toThrow(message);
    await expect(
      store.storePendingRecovery({ challengeId: 'c1', pending, now: NOW }),
    ).rejects.toThrow(message);
    await expect(
      store.markRecoveryForwarded({
        newSparkPubkey: NEW,
        oldSparkPubkey: OLD,
        username: 'ada',
        now: NOW,
      }),
    ).rejects.toThrow(message);
    await expect(
      store.commitRecovery({ accountId: 'acc', newSparkPubkey: NEW, now: NOW }),
    ).rejects.toThrow(message);
    await expect(
      store.putRecoveryShare({
        accountId: 'acc',
        sparkPubkey: OLD,
        ciphertext: new Uint8Array(40),
        now: NOW,
      }),
    ).rejects.toThrow(message);
    expect(sql.queries).toEqual([]);
  });

  it('reads a live pending recovery by account, new key, or credential id', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    sql.nextQueryRows = [
      [pendingRow()],
      [pendingRow({ forwarded_at: new Date(NOW + 1) })],
      [pendingRow({ forwarded_at: new Date(NOW + 2).toISOString() })],
      [],
    ];
    expect(await store.getPendingRecovery('acc', NOW)).toEqual(pending);
    expect(await store.getPendingRecoveryByNewSparkPubkey(NEW, NOW)).toEqual({
      ...pending,
      forwardedAt: NOW + 1,
    });
    expect(await store.getPendingRecoveryByCredentialId('new-credential', NOW)).toEqual({
      ...pending,
      forwardedAt: NOW + 2,
    });
    expect(await store.getPendingRecovery('acc', NOW)).toBeUndefined();
    const columns = ['account_id', 'new_spark_pubkey', 'credential_id', 'account_id'];
    sql.queries.forEach((query, index) => {
      expect(query.text).toMatch(/FROM pending_recovery/);
      expect(query.text).toContain(
        `WHERE ${columns[index]} = $1 AND (forwarded_at IS NOT NULL OR created_at >= to_timestamp($2::double precision / 1000.0))`,
      );
      expect(query.params[1]).toBe(CUTOFF);
    });
    expect(sql.queries.map((query) => query.params[0])).toEqual([
      'acc',
      NEW,
      'new-credential',
      'acc',
    ]);
  });

  it('reads a stored recovery challenge', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'c1',
        type: 'recovery',
        challenge: 'chal',
        account_id: 'acc',
        consumed: false,
        created_at: new Date(NOW),
        requested_name: null,
      },
    ];
    expect((await new PostgresAuthStore(sql).getPasskeyChallenge('c1'))?.type).toBe('recovery');
  });

  describe('startRecoveryChallenge', () => {
    const start = (script: unknown[][]) => {
      const tx = transactions(script);
      const store = new PostgresAuthStore(new MockSql(), tx.db);
      return {
        tx,
        result: store.startRecoveryChallenge({
          accountId: 'acc',
          oldSparkPubkey: OLD,
          challenge,
          now: NOW,
        }),
      };
    };

    it('locks the account first and answers changed for a missing, moved, unverified, or refused account', async () => {
      for (const lock of [
        [],
        [holder({ spark_pubkey: NEW })],
        [holder({ spark_pubkey_verified_at: null })],
        [holder({ session_refused: true })],
      ]) {
        const { tx, result } = start([lock]);
        expect(await result).toBe('changed');
        expect(tx.queries).toHaveLength(1);
        expect(tx.queries[0]?.text).toMatch(
          /SELECT id, username, spark_pubkey, spark_address, spark_pubkey_verified_at, session_refused\s+FROM account WHERE id = \$1 FOR UPDATE/,
        );
        expect(tx.queries[0]?.params).toEqual(['acc']);
      }
    });

    it('answers forwarded while a forwarded pending recovery remains', async () => {
      const { tx, result } = start([[holder()], [{ forwarded_at: new Date(NOW) }]]);
      expect(await result).toBe('forwarded');
      expect(tx.queries[1]?.text).toBe(
        'SELECT forwarded_at FROM pending_recovery WHERE account_id = $1 FOR UPDATE',
      );
      expect(tx.queries).toHaveLength(2);
    });

    it('drops an unforwarded pending recovery, consumes open recovery challenges, evicts expired ones, and inserts', async () => {
      const { tx, result } = start([[holder()], [{ forwarded_at: null }]]);
      expect(await result).toBe('started');
      expect(tx.queries.map((query) => query.text.replace(/\s+/g, ' ').trim())).toEqual([
        expect.stringContaining('FOR UPDATE'),
        'SELECT forwarded_at FROM pending_recovery WHERE account_id = $1 FOR UPDATE',
        'DELETE FROM pending_recovery WHERE account_id = $1',
        "UPDATE passkey_challenge SET consumed = true WHERE account_id = $1 AND type = 'recovery' AND consumed = false",
        'DELETE FROM passkey_challenge WHERE created_at < to_timestamp($1::double precision / 1000.0)',
        expect.stringMatching(
          /^INSERT INTO passkey_challenge \(id, type, challenge, account_id, consumed, created_at, requested_name\)/,
        ),
      ]);
      expect(tx.queries[4]?.params).toEqual([CUTOFF]);
      expect(tx.queries[5]?.params).toEqual(['c1', 'recovery', 'chal', 'acc', false, NOW, null]);
    });

    it('passes a requested name through', async () => {
      const tx = transactions([[holder()], []]);
      await new PostgresAuthStore(new MockSql(), tx.db).startRecoveryChallenge({
        accountId: 'acc',
        oldSparkPubkey: OLD,
        challenge: { ...challenge, requestedName: 'ada' },
        now: NOW,
      });
      expect(tx.queries[5]?.params[6]).toBe('ada');
    });
  });

  describe('storePendingRecovery', () => {
    const storeWith = (script: unknown[][], value: PendingRecovery = pending) => {
      const tx = transactions(script);
      const store = new PostgresAuthStore(new MockSql(), tx.db);
      return {
        tx,
        result: store.storePendingRecovery({ challengeId: 'c1', pending: value, now: NOW }),
      };
    };
    const open = { consumed: false, created_at: new Date(NOW) };

    it('answers changed for an account that left the old key', async () => {
      const { tx, result } = storeWith([[holder({ spark_pubkey: NEW })]]);
      expect(await result).toBe('changed');
      expect(tx.queries).toHaveLength(1);
    });

    it('answers challenge for a missing or expired challenge', async () => {
      const missing = storeWith([[holder()], []]);
      expect(await missing.result).toBe('challenge');
      expect(missing.tx.queries[1]?.text.replace(/\s+/g, ' ')).toBe(
        "SELECT consumed, created_at FROM passkey_challenge WHERE id = $1 AND type = 'recovery' AND account_id = $2 FOR UPDATE",
      );
      expect(missing.tx.queries[1]?.params).toEqual(['c1', 'acc']);
      const expired = storeWith([
        [holder()],
        [{ consumed: false, created_at: new Date(CUTOFF - 1) }],
      ]);
      expect(await expired.result).toBe('challenge');
      expect(expired.tx.queries).toHaveLength(2);
      const edge = storeWith([
        [holder()],
        [{ consumed: false, created_at: new Date(CUTOFF).toISOString() }],
        [],
        [],
        [],
        [],
      ]);
      expect(await edge.result).toBe('stored');
    });

    it('evicts expired pending recoveries, then answers same, challenge, or pending', async () => {
      const used = { consumed: true, created_at: new Date(NOW) };
      const same = storeWith([
        [holder()],
        [used],
        [],
        [{ credential_id: 'new-credential', new_spark_pubkey: NEW }],
      ]);
      expect(await same.result).toBe('same');
      expect(same.tx.queries[2]?.text.replace(/\s+/g, ' ')).toBe(
        'DELETE FROM pending_recovery WHERE forwarded_at IS NULL AND created_at < to_timestamp($1::double precision / 1000.0)',
      );
      expect(same.tx.queries[2]?.params).toEqual([CUTOFF]);
      expect(same.tx.queries[3]?.text).toBe(
        'SELECT credential_id, new_spark_pubkey FROM pending_recovery WHERE account_id = $1',
      );
      expect(same.tx.queries).toHaveLength(4);
      for (const stored of [
        [],
        [{ credential_id: 'other', new_spark_pubkey: NEW }],
        [{ credential_id: 'new-credential', new_spark_pubkey: OLD }],
      ]) {
        expect(await storeWith([[holder()], [used], [], stored]).result).toBe('challenge');
      }
      expect(
        await storeWith([[holder()], [open], [], [{ credential_id: 'x', new_spark_pubkey: OLD }]])
          .result,
      ).toBe('pending');
    });

    it('answers key or credential when they are in use', async () => {
      const key = storeWith([[holder()], [open], [], [], [{ one: 1 }]]);
      expect(await key.result).toBe('key');
      expect(key.tx.queries[4]?.text.replace(/\s+/g, ' ')).toBe(
        'SELECT 1 AS one FROM account WHERE spark_pubkey = $1 UNION ALL SELECT 1 AS one FROM previous_wallet WHERE spark_pubkey = $1 UNION ALL SELECT 1 AS one FROM pending_recovery WHERE new_spark_pubkey = $1 LIMIT 1',
      );
      expect(key.tx.queries[4]?.params).toEqual([NEW]);
      const credential = storeWith([[holder()], [open], [], [], [], [{ one: 1 }]]);
      expect(await credential.result).toBe('credential');
      expect(credential.tx.queries[5]?.text.replace(/\s+/g, ' ')).toBe(
        'SELECT 1 AS one FROM passkey_credential WHERE credential_id = $1 UNION ALL SELECT 1 AS one FROM pending_recovery WHERE credential_id = $1 LIMIT 1',
      );
      expect(credential.tx.queries[5]?.params).toEqual(['new-credential']);
      expect(credential.tx.queries).toHaveLength(6);
    });

    it('consumes the challenge and inserts the row', async () => {
      const { tx, result } = storeWith([[holder()], [open], [], [], [], [], [], []], {
        ...pending,
        forwardedAt: 5,
      });
      expect(await result).toBe('stored');
      expect(tx.queries[6]?.text).toBe(
        'UPDATE passkey_challenge SET consumed = true WHERE id = $1 AND consumed = false',
      );
      expect(tx.queries[6]?.params).toEqual(['c1']);
      expect(tx.queries[7]?.text).toMatch(
        /^INSERT INTO pending_recovery \(account_id, old_spark_pubkey, new_spark_pubkey, credential_id, public_key, sign_count, created_at\)/,
      );
      expect(tx.queries[7]?.text).not.toContain('forwarded_at');
      expect(tx.queries[7]?.params).toEqual([
        'acc',
        OLD,
        NEW,
        'new-credential',
        pending.publicKey,
        0,
        NOW,
      ]);
    });

    it('lets a unique violation of the insert propagate unmapped', async () => {
      const violation = Object.assign(new Error('duplicate key'), { code: '23505' });
      const { result } = storeWith([
        [holder()],
        [open],
        [],
        [],
        [],
        [],
        [],
        violation as unknown as unknown[],
      ]);
      await expect(result).rejects.toBe(violation);
    });
  });

  describe('markRecoveryForwarded', () => {
    const admit = (rows: unknown[][], script: unknown[][], username = 'ada') => {
      const sql = new MockSql();
      sql.nextQueryRows = rows;
      const tx = transactions(script);
      const store = new PostgresAuthStore(sql, tx.db);
      return {
        sql,
        tx,
        result: store.markRecoveryForwarded({
          newSparkPubkey: NEW,
          oldSparkPubkey: OLD,
          username,
          now: NOW + 1,
        }),
      };
    };

    it('answers undefined without a pending recovery for that new key, before any lock', async () => {
      const { sql, tx, result } = admit([[]], []);
      expect(await result).toBeUndefined();
      expect(sql.queries[0]?.text).toBe(
        'SELECT account_id FROM pending_recovery WHERE new_spark_pubkey = $1',
      );
      expect(sql.queries[0]?.params).toEqual([NEW]);
      expect(tx.begins.n).toBe(0);
    });

    it('answers undefined when the account left the key or the username differs', async () => {
      for (const lock of [
        [],
        [holder({ spark_pubkey: NEW })],
        [holder({ username: null })],
        [holder({ username: 'Bob' })],
      ]) {
        const { tx, result } = admit([[{ account_id: 'acc' }]], [lock]);
        expect(await result).toBeUndefined();
        expect(tx.queries).toHaveLength(1);
        expect(tx.queries[0]?.text).toMatch(/FOR UPDATE/);
      }
    });

    it('marks the pending recovery forwarded in the same step and maps the row', async () => {
      const none = admit([[{ account_id: 'acc' }]], [[holder({ username: ' Ada ' })], []]);
      expect(await none.result).toBeUndefined();
      const update = none.tx.queries[1];
      expect(update?.text.replace(/\s+/g, ' ')).toContain(
        'UPDATE pending_recovery SET forwarded_at = to_timestamp($5::double precision / 1000.0) WHERE account_id = $1 AND new_spark_pubkey = $2 AND old_spark_pubkey = $3 AND forwarded_at IS NULL AND created_at >= to_timestamp($4::double precision / 1000.0) RETURNING',
      );
      expect(update?.params).toEqual(['acc', NEW, OLD, NOW + 1 - CHALLENGE_TTL_MS, NOW + 1]);
      const done = admit(
        [[{ account_id: 'acc' }]],
        [[holder()], [pendingRow({ forwarded_at: new Date(NOW + 1) })]],
      );
      expect(await done.result).toEqual({ ...pending, forwardedAt: NOW + 1 });
    });
  });

  describe('commitRecovery', () => {
    const commit = (script: unknown[][]) => {
      const tx = transactions(script);
      const store = new PostgresAuthStore(new MockSql(), tx.db);
      return {
        tx,
        result: store.commitRecovery({ accountId: 'acc', newSparkPubkey: NEW, now: NOW + 9 }),
      };
    };
    const forwardedRow = pendingRow({ forwarded_at: new Date(NOW + 1) });

    it('answers gone without the account or a forwarded pending recovery with that key', async () => {
      const missing = commit([[]]);
      expect(await missing.result).toBe('gone');
      expect(missing.tx.queries).toHaveLength(1);
      const none = commit([[holder()], []]);
      expect(await none.result).toBe('gone');
      expect(none.tx.queries[1]?.text.replace(/\s+/g, ' ')).toContain(
        'FROM pending_recovery WHERE account_id = $1 AND new_spark_pubkey = $2 AND forwarded_at IS NOT NULL FOR UPDATE',
      );
      expect(none.tx.queries[1]?.params).toEqual(['acc', NEW]);
      expect(none.tx.queries).toHaveLength(2);
    });

    it('deletes the pending row and answers changed when the account left the old verified key', async () => {
      for (const lock of [
        holder({ spark_pubkey: `02${'9'.repeat(64)}` }),
        holder({ spark_pubkey_verified_at: null }),
      ]) {
        const { tx, result } = commit([[lock], [forwardedRow]]);
        expect(await result).toBe('changed');
        expect(tx.queries.slice(2)).toEqual([
          { text: 'DELETE FROM pending_recovery WHERE account_id = $1', params: ['acc'] },
        ]);
      }
    });

    it('commits every write of the recovery in order', async () => {
      const { tx, result } = commit([[holder()], [forwardedRow]]);
      expect(await result).toBe('committed');
      expect(
        tx.queries.slice(2).map((query) => [query.text.replace(/\s+/g, ' ').trim(), query.params]),
      ).toEqual([
        [
          'INSERT INTO previous_wallet (account_id, spark_pubkey, spark_address, replaced_at) VALUES ($1, $2, $3, to_timestamp($4::double precision / 1000.0))',
          ['acc', OLD, encodeSparkAddress(OLD), NOW + 9],
        ],
        ['DELETE FROM passkey_credential WHERE account_id = $1', ['acc']],
        [
          'INSERT INTO passkey_credential (credential_id, public_key, sign_count, account_id, created_at) VALUES ($1, $2, $3, $4, to_timestamp($5::double precision / 1000.0))',
          ['new-credential', Uint8Array.of(4, 5, 6), 0, 'acc', NOW + 9],
        ],
        ['DELETE FROM auth_session WHERE account_id = $1', ['acc']],
        ['DELETE FROM push_subscription WHERE account_id = $1', ['acc']],
        [
          'UPDATE account SET spark_pubkey = $2, spark_address = $3, wallet_required = TRUE WHERE id = $1',
          ['acc', NEW, encodeSparkAddress(NEW)],
        ],
        [
          "UPDATE passkey_challenge SET consumed = true WHERE account_id = $1 AND type = 'recovery' AND consumed = false",
          ['acc'],
        ],
        ['DELETE FROM pending_recovery WHERE account_id = $1', ['acc']],
      ]);
    });

    it('derives the previous address when the account row has none', async () => {
      const { tx, result } = commit([[holder({ spark_address: null })], [forwardedRow]]);
      expect(await result).toBe('committed');
      expect(tx.queries[2]?.params[2]).toBe(encodeSparkAddress(OLD));
    });

    it('lets a failed write propagate', async () => {
      const violation = Object.assign(new Error('duplicate key'), { code: '23505' });
      const { result } = commit([[holder()], [forwardedRow], violation as unknown as unknown[]]);
      await expect(result).rejects.toBe(violation);
    });
  });

  it('drops a pending recovery only by account and new key', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    sql.nextQueryRows = [[{ account_id: 'acc' }], []];
    expect(await store.dropPendingRecovery({ accountId: 'acc', newSparkPubkey: NEW })).toBe(true);
    expect(await store.dropPendingRecovery({ accountId: 'acc', newSparkPubkey: NEW })).toBe(false);
    expect(sql.queries[0]?.text.replace(/\s+/g, ' ')).toBe(
      'DELETE FROM pending_recovery WHERE account_id = $1 AND new_spark_pubkey = $2 RETURNING account_id',
    );
    expect(sql.queries[0]?.params).toEqual(['acc', NEW]);
  });

  it('reads previous wallets newest first and drops one with its share', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    const row = {
      account_id: 'acc',
      spark_pubkey: OLD,
      spark_address: encodeSparkAddress(OLD),
      replaced_at: new Date(NOW),
    };
    const wallet = {
      accountId: 'acc',
      sparkPubkey: OLD,
      sparkAddress: encodeSparkAddress(OLD),
      replacedAt: NOW,
    };
    sql.nextQueryRows = [
      [row],
      [],
      [row, { ...row, spark_pubkey: NEW, replaced_at: '1970-01-01T00:00:01.000Z' }],
      [{ dropped: 1 }],
      [{ dropped: '0' }],
      [],
    ];
    expect(await store.getPreviousWalletBySparkPubkey(OLD)).toEqual(wallet);
    expect(await store.getPreviousWalletBySparkPubkey(NEW)).toBeUndefined();
    expect(await store.listPreviousWallets('acc')).toEqual([
      wallet,
      { ...wallet, sparkPubkey: NEW, replacedAt: 1000 },
    ]);
    expect(await store.dropPreviousWallet('acc', OLD)).toBe(true);
    expect(await store.dropPreviousWallet('acc', OLD)).toBe(false);
    expect(await store.dropPreviousWallet('acc', OLD)).toBe(false);
    expect(sql.queries[0]?.text.replace(/\s+/g, ' ')).toBe(
      'SELECT account_id, spark_pubkey, spark_address, replaced_at FROM previous_wallet WHERE spark_pubkey = $1 ORDER BY replaced_at DESC, account_id DESC LIMIT 1',
    );
    expect(sql.queries[2]?.text.replace(/\s+/g, ' ')).toBe(
      'SELECT account_id, spark_pubkey, spark_address, replaced_at FROM previous_wallet WHERE account_id = $1 ORDER BY replaced_at DESC, spark_pubkey COLLATE "C" ASC',
    );
    expect(sql.queries[3]?.text.replace(/\s+/g, ' ')).toBe(
      'WITH gone AS (DELETE FROM previous_wallet WHERE account_id = $1 AND spark_pubkey = $2 RETURNING spark_pubkey), share AS (DELETE FROM recovery_share WHERE account_id = $1 AND spark_pubkey IN (SELECT spark_pubkey FROM gone)) SELECT count(*)::int AS dropped FROM gone',
    );
    expect(sql.queries[3]?.params).toEqual(['acc', OLD]);
  });

  describe('putRecoveryShare', () => {
    const put = (script: unknown[][]) => {
      const tx = transactions(script);
      const store = new PostgresAuthStore(new MockSql(), tx.db);
      const ciphertext = new Uint8Array(40).fill(9);
      return {
        tx,
        ciphertext,
        result: store.putRecoveryShare({
          accountId: 'acc',
          sparkPubkey: OLD,
          ciphertext,
          now: NOW,
        }),
      };
    };

    it('answers changed unless the key is the account verified wallet key', async () => {
      for (const lock of [
        [],
        [holder({ spark_pubkey: NEW })],
        [holder({ spark_pubkey_verified_at: null })],
      ]) {
        const { tx, result } = put([lock]);
        expect(await result).toBe('changed');
        expect(tx.queries).toHaveLength(1);
      }
      const refused = put([[holder({ session_refused: true })], []]);
      expect(await refused.result).toBe('stored');
    });

    it('upserts the envelope and reports stored or replaced', async () => {
      const first = put([[holder()], []]);
      expect(await first.result).toBe('stored');
      expect(first.tx.queries[1]).toEqual({
        text: 'SELECT 1 AS one FROM recovery_share WHERE account_id = $1 AND spark_pubkey = $2',
        params: ['acc', OLD],
      });
      expect(first.tx.queries[2]?.text.replace(/\s+/g, ' ')).toBe(
        'INSERT INTO recovery_share (account_id, spark_pubkey, recovery_share_ciphertext, stored_at) VALUES ($1, $2, $3, to_timestamp($4::double precision / 1000.0)) ON CONFLICT (account_id, spark_pubkey) DO UPDATE SET recovery_share_ciphertext = EXCLUDED.recovery_share_ciphertext, stored_at = EXCLUDED.stored_at',
      );
      expect(first.tx.queries[2]?.params).toEqual(['acc', OLD, first.ciphertext, NOW]);
      expect(await put([[holder()], [{ one: 1 }]]).result).toBe('replaced');
    });
  });

  it('checks for a share of the current verified wallet without reading the ciphertext', async () => {
    const sql = new MockSql();
    const store = new PostgresAuthStore(sql);
    sql.nextQueryRows = [[{ stored: true }], [{ stored: false }], []];
    expect(await store.hasRecoveryShareForVerifiedWallet('acc')).toBe(true);
    expect(await store.hasRecoveryShareForVerifiedWallet('acc')).toBe(false);
    expect(await store.hasRecoveryShareForVerifiedWallet('acc')).toBe(false);
    expect(sql.queries[0]?.text.replace(/\s+/g, ' ')).toBe(
      'SELECT EXISTS (SELECT 1 FROM account a JOIN recovery_share s ON s.account_id = a.id AND s.spark_pubkey = a.spark_pubkey WHERE a.id = $1 AND a.spark_pubkey_verified_at IS NOT NULL) AS stored',
    );
    expect(sql.queries[0]?.text).not.toContain('recovery_share_ciphertext');
  });

  describe('held-share boxes', () => {
    const BOX = 'a'.repeat(32);
    const put = (script: unknown[][], limit = 50) => {
      const tx = transactions(script);
      const store = new PostgresAuthStore(new MockSql(), tx.db);
      const ciphertext = Uint8Array.of(1, 2, 3);
      return {
        tx,
        ciphertext,
        result: store.putHeldShareBox({ accountId: 'acc', id: BOX, ciphertext, now: NOW, limit }),
      };
    };

    it('throws without a transaction port', async () => {
      const sql = new MockSql();
      await expect(
        new PostgresAuthStore(sql).putHeldShareBox({
          accountId: 'acc',
          id: BOX,
          ciphertext: Uint8Array.of(1),
          now: NOW,
          limit: 50,
        }),
      ).rejects.toThrow('auth transactions are not configured');
      expect(sql.queries).toEqual([]);
    });

    it('locks the account, counts, and creates a box under the limit', async () => {
      const created = put([[holder()], [], [{ boxes: 49 }], [{ id: BOX }]]);
      expect(await created.result).toBe('created');
      const texts = created.tx.queries.map((query) => query.text.replace(/\s+/g, ' '));
      expect(texts[0]).toContain('FROM account WHERE id = $1 FOR UPDATE');
      expect(created.tx.queries[1]).toEqual({
        text: 'SELECT account_id FROM held_share_box WHERE id = $1',
        params: [BOX],
      });
      expect(created.tx.queries[2]).toEqual({
        text: 'SELECT count(*)::int AS boxes FROM held_share_box WHERE account_id = $1',
        params: ['acc'],
      });
      expect(texts[3]).toBe(
        'INSERT INTO held_share_box (id, account_id, ciphertext, created_at, updated_at) VALUES ($1, $2, $3, to_timestamp($4::double precision / 1000.0), to_timestamp($4::double precision / 1000.0)) ON CONFLICT (id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = EXCLUDED.updated_at WHERE held_share_box.account_id = EXCLUDED.account_id RETURNING id',
      );
      expect(created.tx.queries[3]?.params).toEqual([BOX, 'acc', created.ciphertext, NOW]);
      expect(await put([[holder()], [], [], [{ id: BOX }]]).result).toBe('created');
    });

    it('replaces an own box without counting', async () => {
      const replaced = put([[holder()], [{ account_id: 'acc' }], [{ id: BOX }]], 0);
      expect(await replaced.result).toBe('replaced');
      expect(replaced.tx.queries).toHaveLength(3);
    });

    it('answers taken for another account’s id, also when one appears before the write', async () => {
      const other = put([[holder()], [{ account_id: 'other' }]]);
      expect(await other.result).toBe('taken');
      expect(other.tx.queries).toHaveLength(2);
      const raced = put([[holder()], [], [{ boxes: '0' }], []]);
      expect(await raced.result).toBe('taken');
    });

    it('answers full at the limit without a write', async () => {
      const full = put([[holder()], [], [{ boxes: '50' }]]);
      expect(await full.result).toBe('full');
      expect(full.tx.queries).toHaveLength(3);
    });

    it('lists oldest first and deletes only by id and account', async () => {
      const sql = new MockSql();
      const store = new PostgresAuthStore(sql);
      sql.nextQueryRows = [
        [
          {
            id: BOX,
            ciphertext: Uint8Array.of(1, 7),
            created_at: new Date(NOW),
            updated_at: '1970-01-01T00:00:01.000Z',
          },
        ],
      ];
      expect(await store.listHeldShareBoxes('acc')).toEqual([
        { id: BOX, ciphertext: Uint8Array.of(1, 7), createdAt: NOW, updatedAt: 1000 },
      ]);
      expect(sql.queries[0]?.text.replace(/\s+/g, ' ')).toBe(
        'SELECT id, ciphertext, created_at, updated_at FROM held_share_box WHERE account_id = $1 ORDER BY created_at ASC, id COLLATE "C" ASC',
      );
      expect(sql.queries[0]?.params).toEqual(['acc']);
      await store.deleteHeldShareBox('acc', BOX);
      expect(sql.executes).toEqual([
        {
          text: 'DELETE FROM held_share_box WHERE id = $1 AND account_id = $2',
          params: [BOX, 'acc'],
        },
      ]);
    });
  });
});
