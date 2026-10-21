import { SQL } from 'bun';
import { describe, expect, test } from 'bun:test';
import { migrateAuthSchema, PostgresAuthStore } from '@/lib/auth/postgres-store';
import { sqlState, type SqlClient } from '@/lib/auth/sql';
import { migrateDailyRosterSchema, PostgresDailyRosterStore } from '@/lib/daily-roster-store';
import type { FundingGrant } from '@/lib/funding';
import { migrateFundingSchema, PostgresFundingStore } from '@/lib/funding-store';
import { migrateMemberHabitSchema, PostgresMemberHabitStore } from '@/lib/member-habit-store';
import { postgresTextArrayLiteral } from '@/lib/postgres-text-array';
import { migrateBtcUsdSchema } from '@/lib/btc-usd-store';
import { migrateFiatSchema } from '@/lib/usd-fiat-store';
import { serializeMessage, unsignedNostrDefaults } from '@/lib/message';
import { migrateMessageSchema, PostgresMessageStore } from '@/lib/message-store';
import {
  migrateShopIdentitySchema,
  PostgresShopIdentityStore,
  shopNpub,
} from '@/lib/shop-identity';
import { isListedShop } from '@/lib/shop-place';
import { runOcpPhotoOutboxPass, runOcpPlaceOutboxPass } from '@/lib/ocp-outbox';
import { signEventForShop } from '@/lib/nostr/sign';
import type { ForumPhoto, MessageRow } from '@/lib/message';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined || databaseUrl === '') {
  throw new Error('DATABASE_URL is required');
}

/**
 * `query` / `execute` body matches `createBunDatabase(...).client` in `src/index.ts`.
 * `sql` is that same instance so the test can close it.
 */
function createBunSqlClient(
  databaseUrl: string,
  options: { max?: number } = {},
): { client: SqlClient; sql: SQL } {
  const sql = new SQL({ url: databaseUrl, ...options });
  const client: SqlClient = {
    async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      const rows = (await sql.unsafe(text, [...params])) as T[];
      return rows;
    },
    async execute(text: string, params: readonly unknown[] = []): Promise<void> {
      await sql.unsafe(text, [...params]);
    },
    async transaction<T>(run: (tx: SqlClient) => Promise<T>): Promise<T> {
      return sql.begin(async (tx) =>
        run({
          query: async <R>(text: string, params: readonly unknown[] = []): Promise<R[]> =>
            (await tx.unsafe(text, [...params])) as R[],
          execute: async (text: string, params: readonly unknown[] = []): Promise<void> => {
            await tx.unsafe(text, [...params]);
          },
        }),
      );
    },
  };
  return { client, sql };
}

async function closeIfPossible(sql: SQL): Promise<void> {
  if (typeof sql.close === 'function') {
    await sql.close();
  }
}

describe('Bun SQL text[] binding', () => {
  test('driver rejects a JavaScript array', async () => {
    const sql = new SQL(databaseUrl);
    try {
      let thrown: unknown;
      try {
        await sql.unsafe('SELECT $1::text[] AS tags', [['rejected']]);
      } catch (error) {
        thrown = error;
      }
      if (thrown === undefined) {
        throw new Error('expected sql.unsafe to reject a JavaScript array');
      }
      const message = String(thrown);
      if (!message.includes('malformed array literal')) {
        throw thrown;
      }
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('driver accepts the literal', async () => {
    const sql = new SQL(databaseUrl);
    try {
      const rows = (await sql.unsafe('SELECT $1::text[] AS tags', [
        postgresTextArrayLiteral(['rejected']),
      ])) as { tags: unknown }[];
      const tags = rows[0]?.tags;
      if (Array.isArray(tags)) {
        expect(tags.includes('rejected')).toBe(true);
      } else if (typeof tags === 'string') {
        expect(tags.includes('rejected')).toBe(true);
      } else {
        throw new Error(`unexpected tags shape: ${typeof tags}`);
      }
    } finally {
      await closeIfPossible(sql);
    }
  });

  test('funding apply through PostgresFundingStore', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateAuthSchema(client);
      await migrateFundingSchema(client);

      const accountId = crypto.randomUUID();
      await client.execute(
        `INSERT INTO account (id, role, lightning_address_verified, forum_laws_dismissed, created_at)
VALUES ($1, 'verified', false, false, $2)`,
        [accountId, new Date()],
      );

      const store = new PostgresFundingStore(client);
      const appliedAt = Date.now();
      const pending: FundingGrant = {
        accountId,
        status: 'pending',
        appliedAt,
        decidedAt: null,
        decidedBy: null,
        trialUtcDate: null,
        admittedAt: null,
        note: null,
      };

      const created = await store.transition(pending, ['none', 'rejected']);
      expect(created?.status).toBe('pending');

      const second = await store.transition(
        {
          accountId,
          status: 'pending',
          appliedAt: appliedAt + 1,
          decidedAt: null,
          decidedBy: null,
          trialUtcDate: null,
          admittedAt: null,
          note: null,
        },
        ['none', 'rejected'],
      );
      expect(second).toBeUndefined();

      const stillPending = await store.getByAccountId(accountId);
      expect(stillPending?.status).toBe('pending');

      const decidedAt = Date.now();
      const admitted = await store.transition(
        {
          accountId,
          status: 'admitted',
          appliedAt,
          decidedAt,
          decidedBy: null,
          trialUtcDate: null,
          admittedAt: decidedAt,
          note: null,
        },
        ['pending', 'trial'],
      );
      expect(admitted?.status).toBe('admitted');
    } finally {
      await closeIfPossible(sql);
    }
  });
});

describe('member habit revision checks', () => {
  test('a reused table gains char_length checks and a bad comment id is missing', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    const habitSql = {
      async query(text: string, params?: unknown[]) {
        const rows = await client.query<Record<string, unknown>>(text, params);
        return { rows };
      },
    };
    const accountId = crypto.randomUUID();
    const habitId = crypto.randomUUID();
    let ready = false;
    try {
      await migrateAuthSchema(client);
      await migrateMemberHabitSchema(habitSql);
      ready = true;
      // A table created before the length checks has no char_length constraint.
      // CREATE TABLE IF NOT EXISTS does not add one, so only the DO block can.
      await client.execute(
        `DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint AS con
    WHERE con.conrelid = 'member_habit_revision'::regclass
      AND con.contype = 'c'
      AND (
        pg_get_constraintdef(con.oid) LIKE '%char_length(name)%'
        OR pg_get_constraintdef(con.oid) LIKE '%char_length(description)%'
      )
  LOOP
    EXECUTE format('ALTER TABLE member_habit_revision DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;`,
      );
      const revisionChecks = async (): Promise<{ name: string; def: string }[]> => {
        return client.query<{ name: string; def: string }>(
          `SELECT conname AS name, pg_get_constraintdef(oid) AS def
           FROM pg_constraint
           WHERE conrelid = 'member_habit_revision'::regclass AND contype = 'c'`,
        );
      };
      const dropped = await revisionChecks();
      expect(dropped.map((row) => row.def).join('\n')).not.toContain('char_length(');
      await migrateMemberHabitSchema(habitSql);
      const added = await revisionChecks();
      expect(added.map((row) => row.name).sort()).toEqual([
        'member_habit_revision_description_len',
        'member_habit_revision_name_len',
      ]);
      expect(added.map((row) => row.def).join('\n')).toContain('char_length(name)');
      expect(added.map((row) => row.def).join('\n')).toContain('char_length(description)');
      await migrateMemberHabitSchema(habitSql);
      const again = await revisionChecks();
      expect(again.map((row) => row.name).sort()).toEqual([
        'member_habit_revision_description_len',
        'member_habit_revision_name_len',
      ]);

      await client.execute(
        `INSERT INTO account (id, role, lightning_address_verified, forum_laws_dismissed, created_at)
VALUES ($1, 'basis', false, false, $2)`,
        [accountId, new Date()],
      );
      const store = new PostgresMemberHabitStore(habitSql, {
        get: async () => null,
        set: async () => {
          return;
        },
      });
      await store.add({
        id: habitId,
        accountId,
        ownerName: 'Owner',
        role: 'basis',
        name: 'Walk',
        description: '',
        notes: '',
        cadence: 'daily',
        timeZone: 'Asia/Manila',
        firstPeriod: '2026-10-01',
        lastPeriod: null,
      });
      expect(
        await store.edit(
          habitId,
          accountId,
          { name: 'Run', description: 'Out', notes: 'n' },
          '2026-10-05',
        ),
      ).toBe('ok');
      expect(await store.archive(habitId, accountId, '2026-10-05')).toBe('ok');
      expect(
        await store.edit(
          habitId,
          accountId,
          { name: 'Later', description: 'Out', notes: 'n' },
          '2026-10-06',
        ),
      ).toBe('closed');
      const kept = await store.listPublic(accountId, Date.parse('2026-10-07T04:00:00.000Z'));
      expect(kept.find((row) => row.id === habitId)?.name).toBe('Run');
      await client.execute(
        `INSERT INTO member_habit_revision (habit_id, period, name, description)
VALUES ($1, '2026-10-02', $2, 'ok')`,
        [habitId, 'a'.repeat(80)],
      );

      let tooLongName: unknown;
      try {
        await client.execute(
          `INSERT INTO member_habit_revision (habit_id, period, name, description)
VALUES ($1, '2026-10-03', $2, 'ok')`,
          [habitId, 'a'.repeat(81)],
        );
      } catch (error) {
        tooLongName = error;
      }
      expect(sqlState(tooLongName)).toBe('23514');

      let tooLongDescription: unknown;
      try {
        await client.execute(
          `INSERT INTO member_habit_revision (habit_id, period, name, description)
VALUES ($1, '2026-10-04', 'ok', $2)`,
          [habitId, 'b'.repeat(2001)],
        );
      } catch (error) {
        tooLongDescription = error;
      }
      expect(sqlState(tooLongDescription)).toBe('23514');

      expect(await store.findComment('nope')).toBeNull();
      expect(await store.deleteComment('nope', 1)).toBe(false);
      expect(await store.findComment(crypto.randomUUID())).toBeNull();
    } finally {
      if (ready) {
        await client.execute(`DELETE FROM member_habit_revision WHERE habit_id = $1`, [habitId]);
        await client.execute(`DELETE FROM member_habit_log WHERE habit_id = $1`, [habitId]);
        await client.execute(`DELETE FROM member_habit_comment WHERE habit_id = $1`, [habitId]);
        await client.execute(`DELETE FROM member_habit WHERE id = $1`, [habitId]);
        await client.execute(`DELETE FROM account WHERE id = $1`, [accountId]);
      }
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresDailyRosterStore importDocument', () => {
  test('writes once on real Postgres and no-ops a second import', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    try {
      await migrateDailyRosterSchema(client);
      await client.execute('DELETE FROM daily_roster_entry');
      await client.execute('DELETE FROM daily_roster');
      const store = new PostgresDailyRosterStore(client);
      const first = await store.importDocument({
        comment: 'kept',
        paymentsEnabled: false,
        moderatorPaymentsEnabled: true,
        recipients: [{ address: 'roster-import@example.com', amountUsd: 2.5 }],
        moderators: [{ address: 'roster-mod@example.com', amountUsd: 3 }],
      });
      expect(first.comment).toBe('kept');
      expect(first.paymentsEnabled).toBe(false);
      expect(first.moderatorPaymentsEnabled).toBe(true);
      expect(first.defaultAmountUsd).toBe(1);
      expect(first.recipients).toEqual([{ address: 'roster-import@example.com', amountUsd: 2.5 }]);
      expect(first.moderators).toEqual([{ address: 'roster-mod@example.com', amountUsd: 3 }]);
      const second = await store.importDocument({ comment: 'other' });
      expect(second).toEqual(first);
      expect(second.comment).toBe('kept');
    } finally {
      await client.execute('DELETE FROM daily_roster_entry');
      await client.execute('DELETE FROM daily_roster');
      await closeIfPossible(sql);
    }
  });
});

describe('PostgresMessageStore deleteById on a credit', () => {
  test('a credit with sats survives a hard delete and a plain note does not', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    const accountId = crypto.randomUUID();
    const creditId = crypto.randomUUID();
    const plainId = crypto.randomUUID();
    let ready = false;
    try {
      await migrateAuthSchema(client);
      await migrateBtcUsdSchema(client);
      await migrateFiatSchema(client);
      await migrateMessageSchema(client);
      await migrateShopIdentitySchema(client);
      ready = true;
      await new PostgresAuthStore(client).createAccount({
        id: accountId,
        linkingKey: `02${accountId.replaceAll('-', '').padEnd(64, '0')}`,
        role: 'verified',
        name: 'Ada',
        lightningAddress: null,
        lightningAddressVerified: false,
        forumLawsDismissed: false,
        location: null,
        viewKey: accountId.replaceAll('-', '').padEnd(64, 'a'),
        createdAt: 1,
        rulesAgreedAt: null,
      });
      const store = new PostgresMessageStore(client);
      const base = {
        accountId,
        name: 'Ada',
        createdAt: new Date(),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      };
      await store.create({
        ...base,
        id: creditId,
        text: 'credit',
        goalSats: 10,
        goalRepayable: true,
      });
      await store.create({ ...base, id: plainId, text: 'plain' });
      await client.execute('UPDATE message SET sats = 5 WHERE id = $1', [creditId]);
      expect(await store.deleteById(creditId)).toBe(false);
      expect((await store.getById(creditId))?.sats).toBe(5);
      expect(await store.deleteById(plainId)).toBe(true);
      expect(await store.getById(plainId)).toBeUndefined();
    } finally {
      if (ready) {
        await client.execute('DELETE FROM message WHERE account_id = $1', [accountId]);
        await client.execute('DELETE FROM account WHERE id = $1', [accountId]);
      }
      await closeIfPossible(sql);
    }
  });

  test('a payment committed during a hide or a hard delete wins over both', async () => {
    const { client, sql } = createBunSqlClient(databaseUrl);
    const accountId = crypto.randomUUID();
    const creditId = crypto.randomUUID();
    const replyId = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    let ready = false;
    const settled = async (pending: Promise<boolean>): Promise<boolean> => {
      const marker = Symbol('pending');
      const first = await Promise.race([pending, Bun.sleep(300).then(() => marker)]);
      return first !== marker;
    };
    try {
      await migrateAuthSchema(client);
      await migrateBtcUsdSchema(client);
      await migrateFiatSchema(client);
      await migrateMessageSchema(client);
      await migrateShopIdentitySchema(client);
      ready = true;
      await new PostgresAuthStore(client).createAccount({
        id: accountId,
        linkingKey: `02${accountId.replaceAll('-', '').padEnd(64, '1')}`,
        role: 'verified',
        name: 'Ada',
        lightningAddress: null,
        lightningAddressVerified: false,
        forumLawsDismissed: false,
        location: null,
        viewKey: accountId.replaceAll('-', '').padEnd(64, 'b'),
        createdAt: 1,
        rulesAgreedAt: null,
      });
      const store = new PostgresMessageStore(client);
      const base = {
        accountId,
        name: 'Ada',
        createdAt: new Date(),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      };
      await store.create({
        ...base,
        id: creditId,
        text: 'credit',
        goalSats: 10,
        goalRepayable: true,
      });
      await store.create({ ...base, id: replyId, parentId: creditId, text: 'reply' });
      await store.create({
        ...base,
        id: otherId,
        text: 'other',
        goalSats: 10,
        goalRepayable: true,
      });

      const payer = await sql.reserve();
      try {
        await payer.unsafe('BEGIN');
        await payer.unsafe('UPDATE message SET sats = 5 WHERE id = $1', [creditId]);
        const hide = store.markDeleted(creditId, new Date(), accountId, 0);
        expect(await settled(hide)).toBe(false);
        await payer.unsafe('COMMIT');
        expect(await hide).toBe(false);
      } finally {
        payer.release();
      }
      expect((await store.getById(creditId))?.deletedAt).toBeNull();
      expect((await store.getById(replyId))?.deletedAt).toBeNull();

      const second = await sql.reserve();
      try {
        await second.unsafe('BEGIN');
        await second.unsafe('UPDATE message SET sats = 5 WHERE id = $1', [otherId]);
        const remove = store.deleteById(otherId);
        expect(await settled(remove)).toBe(false);
        await second.unsafe('COMMIT');
        expect(await remove).toBe(false);
      } finally {
        second.release();
      }
      expect((await store.getById(otherId))?.sats).toBe(5);
    } finally {
      if (ready) {
        await client.execute('DELETE FROM message WHERE parent_id = $1', [creditId]);
        await client.execute('DELETE FROM message WHERE account_id = $1', [accountId]);
        await client.execute('DELETE FROM account WHERE id = $1', [accountId]);
      }
      await closeIfPossible(sql);
    }
  });
});

describe('shop identity on Postgres', () => {
  const KEK = new Uint8Array(32).fill(7);
  const TEXT = 'Fresh coffee roasted here every morning. #21GiftsShop';
  const PLACE = {
    lat: 47.3769,
    lng: 8.5417,
    label: 'Coffee Lab',
    address: {
      street: 'Main Street',
      houseNumber: '1',
      postalCode: '8001',
      city: 'Zürich',
      country: 'CH',
    },
  };
  const PNG = { contentType: 'image/png' as const, bytes: new Uint8Array([1, 2, 3]) };

  async function setup(): Promise<{
    client: SqlClient;
    sql: SQL;
    accountId: string;
    messages: PostgresMessageStore;
    shops: PostgresShopIdentityStore;
    note: (overrides?: Partial<MessageRow>) => MessageRow;
    cleanup: () => Promise<void>;
  }> {
    const { client, sql } = createBunSqlClient(String(databaseUrl));
    await migrateAuthSchema(client);
    await migrateBtcUsdSchema(client);
    await migrateFiatSchema(client);
    await migrateMessageSchema(client);
    await migrateShopIdentitySchema(client);
    await migrateShopIdentitySchema(client);
    const accountId = crypto.randomUUID();
    await new PostgresAuthStore(client).createAccount({
      id: accountId,
      linkingKey: `02${accountId.replaceAll('-', '').padEnd(64, '2')}`,
      role: 'verified',
      name: 'Coffee',
      username: `c${accountId.replaceAll('-', '').slice(0, 12)}`,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: accountId.replaceAll('-', '').padEnd(64, 'c'),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const messages = new PostgresMessageStore(client);
    const shops = new PostgresShopIdentityStore(client, messages);
    const note = (overrides: Partial<MessageRow> = {}): MessageRow => ({
      id: crypto.randomUUID(),
      accountId,
      name: 'Coffee',
      text: TEXT,
      createdAt: new Date(),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      place: PLACE,
      shopAccount: { id: accountId, username: 'coffee', name: 'Coffee' },
      ...overrides,
    });
    const cleanup = async (): Promise<void> => {
      await client.execute(
        'DELETE FROM shop_identity WHERE message_id IN (SELECT id FROM message WHERE account_id = $1)',
        [accountId],
      );
      await client.execute('DELETE FROM message WHERE account_id = $1', [accountId]);
      await client.execute('DELETE FROM account WHERE id = $1', [accountId]);
      await closeIfPossible(sql);
    };
    return { client, sql, accountId, messages, shops, note, cleanup };
  }

  test('a failed extra photo leaves neither the note nor a key while the backfill runs', async () => {
    const ctx = await setup();
    try {
      const row = ctx.note({ hasPhoto: true });
      const failing = ctx.messages.create(row, PNG, undefined, [
        PNG,
        { contentType: null as unknown as 'image/png', bytes: PNG.bytes },
      ]);
      const backfill = (async () => {
        for (let round = 0; round < 20; round += 1) {
          for (const candidate of await ctx.shops.listCandidates(null, 50)) {
            if (candidate.id === row.id) await ctx.shops.ensureListed(candidate.id, KEK);
          }
        }
      })();
      let thrown: unknown;
      try {
        await failing;
      } catch (error) {
        thrown = error;
      }
      await backfill;
      expect(thrown).toBeDefined();
      expect(await ctx.messages.getById(row.id)).toBeUndefined();
      expect(await ctx.shops.getByMessageId(row.id)).toBeUndefined();
      expect(
        await ctx.client.query('SELECT 1 FROM message_extra_photo WHERE message_id = $1', [row.id]),
      ).toEqual([]);
    } finally {
      await ctx.cleanup();
    }
  });

  test('18 concurrent migrations from scratch all succeed and leave each object once', async () => {
    const ctx = await setup();
    try {
      // From scratch: the duplicate-key race of CREATE TABLE / CREATE INDEX IF
      // NOT EXISTS and of a new function is only open while the objects are
      // new; the queued boots then replace the existing functions one after
      // another, which also covers "tuple concurrently updated".
      await ctx.client.execute('DROP TABLE shop_identity');
      await ctx.client.execute(
        `DROP FUNCTION queue_shop_identity_place(), queue_shop_identity_cover(),
           queue_shop_identity_photo() CASCADE`,
      );
      await ctx.client.execute('DROP INDEX message_shop_candidate_idx');
      // One connection per boot, as 18 processes would open.
      const boots = Array.from({ length: 18 }, () =>
        createBunSqlClient(String(databaseUrl), { max: 1 }),
      );
      try {
        const results = await Promise.allSettled(
          boots.map(({ client }) => migrateShopIdentitySchema(client)),
        );
        expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
      } finally {
        await Promise.all(boots.map(({ sql }) => closeIfPossible(sql)));
      }
      expect(
        await ctx.client.query<{ tgname: string; n: string }>(
          `SELECT tgname, count(*)::text AS n FROM pg_trigger
           WHERE tgname IN ('trg_shop_identity_place', 'trg_shop_identity_cover',
             'trg_shop_identity_extra_photo')
           GROUP BY tgname ORDER BY tgname`,
        ),
      ).toEqual([
        { tgname: 'trg_shop_identity_cover', n: '1' },
        { tgname: 'trg_shop_identity_extra_photo', n: '1' },
        { tgname: 'trg_shop_identity_place', n: '1' },
      ]);
      expect(
        await ctx.client.query<{ proname: string; n: string }>(
          `SELECT proname, count(*)::text AS n FROM pg_proc
           WHERE proname IN ('queue_shop_identity_place', 'queue_shop_identity_cover',
             'queue_shop_identity_photo')
           GROUP BY proname ORDER BY proname`,
        ),
      ).toEqual([
        { proname: 'queue_shop_identity_cover', n: '1' },
        { proname: 'queue_shop_identity_photo', n: '1' },
        { proname: 'queue_shop_identity_place', n: '1' },
      ]);
      expect(
        await ctx.client.query<{ name: string; n: string }>(
          `SELECT relname AS name, count(*)::text AS n FROM pg_class
           WHERE relname IN ('shop_identity', 'shop_identity_key_order_idx',
             'message_shop_candidate_idx')
           GROUP BY relname ORDER BY relname`,
        ),
      ).toEqual([
        { name: 'message_shop_candidate_idx', n: '1' },
        { name: 'shop_identity', n: '1' },
        { name: 'shop_identity_key_order_idx', n: '1' },
      ]);
    } finally {
      await ctx.cleanup();
    }
  });

  test('the backfill candidate read walks message_shop_candidate_idx', async () => {
    const ctx = await setup();
    try {
      expect(
        await ctx.client.query<{ indexdef: string }>(
          `SELECT indexdef FROM pg_indexes WHERE indexname = 'message_shop_candidate_idx'`,
        ),
      ).toEqual([
        {
          indexdef:
            'CREATE INDEX message_shop_candidate_idx ON public.message USING btree (created_at, id) WHERE ((parent_id IS NULL) AND (deleted_at IS NULL) AND (shop_account_id IS NOT NULL) AND (place_lat IS NOT NULL))',
        },
      ]);
      // Many live top-level notes that are not shops, a few that are.
      for (let index = 0; index < 300; index += 1) {
        await ctx.messages.create(
          ctx.note({ text: `Plain note number ${index}.`, place: null, shopAccount: null }),
        );
      }
      for (let index = 0; index < 3; index += 1) {
        await ctx.messages.create(ctx.note({ text: `${TEXT} Shop ${index}.` }));
      }
      await ctx.client.execute('ANALYZE message');
      const seen: { text: string; params: readonly unknown[] }[] = [];
      const spy: SqlClient = {
        query: <T>(text: string, params: readonly unknown[] = []): Promise<T[]> => {
          seen.push({ text, params });
          return ctx.client.query<T>(text, params);
        },
        execute: (text, params) => ctx.client.execute(text, params),
      };
      const store = new PostgresShopIdentityStore(spy, ctx.messages);
      expect(await store.listCandidates(null, 50)).toHaveLength(3);
      const [read] = seen;
      const plan = await ctx.client.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON) ${read!.text}`,
        read!.params,
      );
      expect(JSON.stringify(plan)).toContain('"Index Name":"message_shop_candidate_idx"');
    } finally {
      await ctx.cleanup();
    }
  });

  test('the backfill pages past keyed candidates one bounded raw page at a time', async () => {
    const ctx = await setup();
    try {
      for (let index = 0; index < 300; index += 1) {
        await ctx.messages.create(
          ctx.note({ text: `Plain note number ${index}.`, place: null, shopAccount: null }),
        );
      }
      const base = Date.UTC(2031, 0, 1);
      const keyed: string[] = [];
      for (let index = 0; index < 25; index += 1) {
        const row = ctx.note({ createdAt: new Date(base + index * 1000) });
        await ctx.messages.create(row);
        await ctx.shops.ensureListed(row.id, KEK);
        keyed.push(row.id);
      }
      const unkeyed = ctx.note({ createdAt: new Date(base + 25 * 1000) });
      await ctx.messages.create(unkeyed);
      await ctx.client.execute('ANALYZE message');
      const seen: { text: string; params: readonly unknown[] }[] = [];
      const spy: SqlClient = {
        query: <T>(text: string, params: readonly unknown[] = []): Promise<T[]> => {
          seen.push({ text, params });
          return ctx.client.query<T>(text, params);
        },
        execute: (text, params) => ctx.client.execute(text, params),
      };
      const store = new PostgresShopIdentityStore(spy, ctx.messages);
      // The worker's walk: advance on the raw page, key only unkeyed rows,
      // stop after a short raw page.
      let cursor = { createdAt: new Date(base - 1), id: unkeyed.id };
      const pages: { id: string; keyed: boolean }[][] = [];
      for (;;) {
        const page = await store.listCandidates(cursor, 20);
        expect(page.length).toBeLessThanOrEqual(20);
        pages.push(page.map((row) => ({ id: row.id, keyed: row.keyed })));
        for (const candidate of page) {
          if (!candidate.keyed) await ctx.shops.ensureListed(candidate.id, KEK);
        }
        const last = page[page.length - 1];
        if (page.length < 20 || last === undefined) break;
        cursor = { createdAt: last.createdAt, id: last.id };
      }
      const ids = [...keyed, unkeyed.id];
      expect(pages.flat().filter((row) => ids.includes(row.id))).toEqual([
        ...keyed.map((id) => ({ id, keyed: true })),
        { id: unkeyed.id, keyed: false },
      ]);
      expect(pages.length).toBeGreaterThanOrEqual(2);
      expect(await ctx.shops.getByMessageId(unkeyed.id)).toBeDefined();
      // The bounded raw page reads the partial index.
      const [read] = seen;
      expect(read!.text).toContain('LIMIT $3');
      const plan = await ctx.client.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON) ${read!.text}`,
        read!.params,
      );
      expect(JSON.stringify(plan)).toContain('"Index Name":"message_shop_candidate_idx"');
    } finally {
      await ctx.cleanup();
    }
  });

  test('the operator dump read of shop identities is limited', async () => {
    const ctx = await setup();
    try {
      for (let index = 0; index < 3; index += 1) {
        const row = ctx.note();
        await ctx.messages.create(row);
        await ctx.shops.ensureListed(row.id, KEK);
      }
      const all = await ctx.shops.listAll();
      expect(all.length).toBeGreaterThanOrEqual(3);
      const limited = await ctx.shops.listDebug(2);
      expect(limited.map((row) => row.messageId)).toEqual(
        all.slice(0, 2).map((row) => row.messageId),
      );
    } finally {
      await ctx.cleanup();
    }
  });

  test('creates one key per listed note, keeps it, and queues every write by trigger', async () => {
    const ctx = await setup();
    try {
      const row = ctx.note({ hasPhoto: true });
      await ctx.messages.create(row, PNG, undefined, [PNG]);
      const [left, right] = await Promise.all([
        ctx.shops.ensureListed(row.id, KEK),
        ctx.shops.ensureListed(row.id, KEK),
      ]);
      expect(left?.nostrPubkey).toBe(right?.nostrPubkey ?? '');
      expect(left).toMatchObject({ ocpPlacePending: true, ocpPlaceGeneration: 1 });
      expect((await ctx.messages.getById(row.id))?.shopNpub).toMatch(/^npub1/);
      expect(
        (await ctx.messages.listPlaces(1000)).find((place) => place.id === row.id)?.shopNpub,
      ).toMatch(/^npub1/);

      const [claim] = await ctx.shops.claimPlaces(20, 60_000);
      expect(claim).toEqual({ messageId: row.id, generation: 1, claim: 1 });
      expect(await ctx.shops.claimPlaces(20, 60_000)).toEqual([]);
      expect(await ctx.shops.leaseHasTime('place', claim!, 15_000)).toBe(true);
      expect(await ctx.shops.leaseHasTime('place', claim!, 120_000)).toBe(false);
      expect(await ctx.shops.nextRevision('place', claim!)).toBe(1);
      await ctx.shops.finishPlace(claim!, 'put');
      let identity = (await ctx.shops.getByMessageId(row.id))!;
      expect(identity).toMatchObject({
        ocpPlacePending: false,
        ocpPlaceClaimedUntil: null,
        ocpPhotosPending: true,
        ocpPhotosGeneration: 1,
        ocpRevision: 1,
      });

      await ctx.messages.updateText(row.id, `${TEXT} More beans.`);
      identity = (await ctx.shops.getByMessageId(row.id))!;
      expect(identity).toMatchObject({ ocpPlacePending: true, ocpPlaceGeneration: 2 });

      await ctx.messages.replacePhotos(row.id, [PNG]);
      expect((await ctx.shops.getByMessageId(row.id))!.ocpPhotosGeneration).toBeGreaterThan(1);
      const photoGeneration = (await ctx.shops.getByMessageId(row.id))!.ocpPhotosGeneration;

      await ctx.messages.markDeleted(row.id, new Date(), ctx.accountId);
      identity = (await ctx.shops.getByMessageId(row.id))!;
      expect(identity.ocpPlaceGeneration).toBe(3);
      await ctx.messages.replacePhotos(row.id, []);
      expect((await ctx.shops.getByMessageId(row.id))!.ocpPhotosGeneration).toBe(photoGeneration);
      expect((await ctx.messages.getById(row.id))?.shopNpub).toMatch(/^npub1/);

      expect(await ctx.messages.deleteById(row.id)).toBe(false);
      expect(await ctx.messages.getById(row.id)).toBeDefined();

      await ctx.messages.markUndeleted(row.id);
      expect((await ctx.shops.getByMessageId(row.id))!.ocpPlaceGeneration).toBe(4);
      expect(await ctx.shops.queueAllPlacePage(null, 200)).toContain(row.id);
    } finally {
      await ctx.cleanup();
    }
  });

  test('creates no key for an incomplete or changed note', async () => {
    const ctx = await setup();
    try {
      const incomplete = ctx.note({ text: 'Too short #21GiftsShop' });
      await ctx.messages.create(incomplete);
      expect(await ctx.shops.ensureListed(incomplete.id, KEK)).toBeUndefined();
      expect(
        (await ctx.shops.listCandidates(null, 1000)).some((row) => row.id === incomplete.id),
      ).toBe(true);
      const moved = ctx.note();
      await ctx.messages.create(moved);
      const stale = new PostgresShopIdentityStore(ctx.client, {
        getById: async (id: string) => ({
          ...(await ctx.messages.getById(id))!,
          text: `${TEXT} Older text.`,
        }),
      } as unknown as PostgresMessageStore);
      expect(await stale.ensureListed(moved.id, KEK)).toBeUndefined();
      expect(await ctx.shops.ensureListed(moved.id, KEK)).toBeDefined();
    } finally {
      await ctx.cleanup();
    }
  });

  test('keeps a shop listed when its till account has no username', async () => {
    const ctx = await setup();
    try {
      const row = ctx.note();
      await ctx.messages.create(row);
      // An account merge keeps the survivor's username, which can be empty.
      await ctx.client.execute('UPDATE account SET username = NULL WHERE id = $1', [ctx.accountId]);
      const stored = (await ctx.messages.getById(row.id))!;
      expect(stored.shopAccount).toEqual({ id: ctx.accountId, username: null, name: 'Coffee' });
      expect(isListedShop(stored)).toBe(true);
      const identity = (await ctx.shops.ensureListed(row.id, KEK))!;
      expect(identity.ocpPlacePending).toBe(true);
      const body = serializeMessage((await ctx.messages.getById(row.id))!, false, 'basis');
      expect(body.shopNpub).toBe(shopNpub(identity));
      expect(body).not.toHaveProperty('shopAccount');
      const sent: string[] = [];
      await runOcpPlaceOutboxPass({
        identities: ctx.shops,
        messages: ctx.messages,
        mapPush: {
          baseUrl: 'https://map.test',
          token: 't',
          fetchImpl: async (_url: string, init: RequestInit): Promise<Response> => {
            sent.push(String(init.method));
            return new Response('{}', { status: 201 });
          },
        },
      });
      expect(sent).toEqual(['PUT']);
    } finally {
      await ctx.cleanup();
    }
  });

  test('a rename from an older note snapshot does not overwrite a newer one', async () => {
    const ctx = await setup();
    try {
      const row = ctx.note();
      await ctx.messages.create(row);
      await ctx.shops.ensureListed(row.id, KEK);
      const older = (await ctx.messages.getById(row.id))!;
      await ctx.messages.setPlace(row.id, { ...PLACE, label: 'Roastery' });
      expect((await ctx.shops.ensureListed(row.id, KEK))?.profileName).toBe('Roastery');
      // An overlapping request that read the note before the rename comes last.
      const stale = new PostgresShopIdentityStore(ctx.client, {
        getById: async () => older,
      } as unknown as PostgresMessageStore);
      expect((await stale.ensureListed(row.id, KEK))?.profileName).toBe('Roastery');
      expect((await ctx.shops.getByMessageId(row.id))?.profileName).toBe('Roastery');
    } finally {
      await ctx.cleanup();
    }
  });

  test('a worker rename from an older note snapshot does not overwrite a newer one', async () => {
    const ctx = await setup();
    try {
      const row = ctx.note();
      await ctx.messages.create(row);
      await ctx.shops.ensureListed(row.id, KEK);
      const older = (await ctx.messages.getById(row.id))!;
      await ctx.messages.setPlace(row.id, { ...PLACE, label: 'Roastery' });
      const newer = (await ctx.messages.getById(row.id))!;
      // The tick that read the renamed note writes the new name.
      await ctx.shops.renameIfListed(newer);
      expect((await ctx.shops.getByMessageId(row.id))?.profileName).toBe('Roastery');
      // An overlapping tick that read the note before the rename writes last.
      await ctx.shops.renameIfListed(older);
      expect((await ctx.shops.getByMessageId(row.id))?.profileName).toBe('Roastery');
      // Unlisted before the next tick: the stored name is still the newest.
      await ctx.messages.setShopAccount(row.id, null);
      await ctx.shops.renameIfListed(older);
      expect((await ctx.shops.getByMessageId(row.id))?.profileName).toBe('Roastery');
    } finally {
      await ctx.cleanup();
    }
  });

  test('runs both outboxes against the real statements', async () => {
    const ctx = await setup();
    try {
      const row = ctx.note({ hasPhoto: true });
      await ctx.messages.create(row, PNG, undefined, [PNG]);
      const identity = (await ctx.shops.ensureListed(row.id, KEK))!;
      expect((await ctx.shops.getByPubkey(identity.nostrPubkey))?.messageId).toBe(row.id);
      const signed = await signEventForShop(ctx.shops, row.id, KEK, {
        kind: 0,
        content: '{}',
        tags: [],
        created_at: 1,
      });
      expect(signed.pubkey).toBe(identity.nostrPubkey);
      expect((await ctx.shops.listAll()).find((r) => r.messageId === row.id)?.profileName).toBe(
        'Coffee Lab',
      );

      const answers: Array<{ status: number; body: string }> = [];
      const sent: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
      const mapPush = {
        baseUrl: 'https://map.test',
        token: 't',
        fetchImpl: async (url: string, init: RequestInit): Promise<Response> => {
          sent.push({
            url,
            method: String(init.method),
            body: JSON.parse(String(init.body)) as Record<string, unknown>,
          });
          const next = answers.shift()!;
          return new Response(next.body, { status: next.status });
        },
      };
      const deps = { identities: ctx.shops, messages: ctx.messages, mapPush };
      const state = async () => (await ctx.shops.getByMessageId(row.id))!;
      const releasePlace = () =>
        ctx.client.execute(
          'UPDATE shop_identity SET ocp_place_claimed_until = NULL WHERE message_id = $1',
          [row.id],
        );
      const releasePhotos = () =>
        ctx.client.execute(
          'UPDATE shop_identity SET ocp_photos_claimed_until = NULL WHERE message_id = $1',
          [row.id],
        );

      answers.push({ status: 201, body: '{}' });
      await runOcpPlaceOutboxPass(deps);
      expect(sent.at(-1)).toMatchObject({ method: 'PUT', body: { revision: 1 } });
      expect(await state()).toMatchObject({
        ocpPlacePending: false,
        ocpPhotosPending: true,
        ocpRevision: 1,
      });

      answers.push({ status: 200, body: '{"photos":[],"skipped":[]}' });
      await runOcpPhotoOutboxPass(deps);
      expect(sent.at(-1)).toMatchObject({
        url: 'https://map.test/map/places/photos',
        body: { revision: 2 },
      });
      const stored = await state();
      expect(stored.ocpPhotosPending).toBe(false);
      expect(stored.ocpPhotosHash).toMatch(/^[0-9a-f]{64}$/);

      await ctx.client.execute(
        'UPDATE shop_identity SET ocp_photos_pending = true, ocp_photos_generation = ocp_photos_generation + 1 WHERE message_id = $1',
        [row.id],
      );
      await runOcpPhotoOutboxPass(deps);
      expect(sent).toHaveLength(2);
      expect((await state()).ocpPhotosPending).toBe(false);

      await ctx.messages.replacePhotos(row.id, [PNG, PNG, PNG]);
      answers.push({ status: 404, body: '404 Not Found' });
      await runOcpPhotoOutboxPass(deps);
      const deferred = await state();
      expect(deferred).toMatchObject({
        ocpPhotosHash: null,
        ocpPhotosPending: true,
        ocpPlacePending: true,
      });
      expect(deferred.ocpPhotosClaimedUntil).not.toBeNull();
      expect(deferred.ocpPlaceClaimedUntil).toEqual(deferred.ocpPhotosClaimedUntil);
      const beforeLease = sent.length;
      await runOcpPlaceOutboxPass(deps);
      await runOcpPhotoOutboxPass(deps);
      expect(sent).toHaveLength(beforeLease);
      await releasePlace();
      answers.push({ status: 200, body: '{}' });
      await runOcpPlaceOutboxPass(deps);
      expect(await state()).toMatchObject({ ocpPlacePending: false, ocpPhotosPending: true });
      await releasePhotos();

      answers.push({ status: 404, body: '{"error":"Place not found"}' });
      await runOcpPhotoOutboxPass(deps);
      expect(await state()).toMatchObject({
        ocpPhotosHash: null,
        ocpPhotosPending: false,
        ocpPlacePending: true,
      });

      answers.push({ status: 409, body: '{"error":"Stale revision"}' });
      await runOcpPlaceOutboxPass(deps);
      expect(await state()).toMatchObject({ ocpPlacePending: true, ocpPlaceClaimedUntil: null });

      answers.push({ status: 200, body: '{}' });
      await runOcpPlaceOutboxPass(deps);
      expect(await state()).toMatchObject({ ocpPlacePending: false, ocpPhotosPending: true });

      answers.push({ status: 413, body: '{"error":"too large"}' });
      await runOcpPhotoOutboxPass(deps);
      expect((await state()).ocpPhotosPending).toBe(false);

      await ctx.messages.markDeleted(row.id, new Date(), ctx.accountId);
      answers.push({ status: 503, body: '' });
      await runOcpPlaceOutboxPass(deps);
      expect(sent.at(-1)).toMatchObject({ method: 'DELETE' });
      expect(await state()).toMatchObject({ ocpPlacePending: true, ocpPhotosHash: null });
      await releasePlace();
      answers.push({ status: 200, body: '{"deleted":true}' });
      await runOcpPlaceOutboxPass(deps);
      expect((await state()).ocpPlacePending).toBe(false);

      await ctx.messages.markUndeleted(row.id);
      answers.push({ status: 400, body: '{"error":"bad"}' });
      await runOcpPlaceOutboxPass(deps);
      expect((await state()).ocpPlacePending).toBe(false);
      await releasePhotos();
      expect((await state()).ocpRevision).toBe(sent.length);
    } finally {
      await ctx.cleanup();
    }
  });

  /**
   * A listed shop with a confirmed place and pending photos, and outbox deps
   * whose `getPhotoSet` runs `between` once, after the photo pass
   * claimed the row and read the photos and before it reserves a revision.
   */
  async function photoRace(
    ctx: Awaited<ReturnType<typeof setup>>,
    between: (deps: Parameters<typeof runOcpPlaceOutboxPass>[0], id: string) => Promise<void>,
  ): Promise<{
    id: string;
    sent: Array<{ url: string; method: string; revision: unknown }>;
    deps: Parameters<typeof runOcpPlaceOutboxPass>[0];
  }> {
    const row = ctx.note({ hasPhoto: true });
    await ctx.messages.create(row, PNG, undefined, [PNG]);
    await ctx.shops.ensureListed(row.id, KEK);
    const sent: Array<{ url: string; method: string; revision: unknown }> = [];
    let hooked = false;
    const messages = new Proxy(ctx.messages, {
      get(target, key) {
        if (key === 'getPhotoSet') {
          return async (id: string) => {
            const set = await target.getPhotoSet(id);
            if (!hooked) {
              hooked = true;
              await between(deps, id);
            }
            return set;
          };
        }
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const deps = {
      identities: ctx.shops,
      messages,
      mapPush: {
        baseUrl: 'https://map.test',
        token: 't',
        fetchImpl: async (url: string, init: RequestInit): Promise<Response> => {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          sent.push({ url, method: String(init.method), revision: body['revision'] });
          return new Response('{}', { status: 200 });
        },
      },
    };
    await runOcpPlaceOutboxPass(deps);
    expect(await ctx.shops.getByMessageId(row.id)).toMatchObject({
      ocpPlacePending: false,
      ocpPhotosPending: true,
      ocpRevision: 1,
    });
    expect(hooked).toBe(false);
    return { id: row.id, sent, deps };
  }

  test('a photo pass that read the photos before a hide sends nothing and reserves no revision', async () => {
    const ctx = await setup();
    try {
      const race = await photoRace(ctx, async (_deps, id) => {
        await ctx.messages.markDeleted(id, new Date(), ctx.accountId);
      });
      await runOcpPhotoOutboxPass(race.deps);
      expect(race.sent).toEqual([
        { url: 'https://map.test/map/places', method: 'PUT', revision: 1 },
      ]);
      expect(await ctx.shops.getByMessageId(race.id)).toMatchObject({
        ocpRevision: 1,
        ocpPlacePending: true,
        ocpPhotosPending: true,
        ocpPhotosClaimedUntil: null,
      });
      await runOcpPlaceOutboxPass(race.deps);
      await runOcpPhotoOutboxPass(race.deps);
      expect(race.sent.map((request) => [request.method, request.revision])).toEqual([
        ['PUT', 1],
        ['DELETE', 2],
      ]);
      expect(await ctx.shops.getByMessageId(race.id)).toMatchObject({
        ocpRevision: 2,
        ocpPlacePending: false,
        ocpPhotosPending: false,
      });
    } finally {
      await ctx.cleanup();
    }
  });

  test('a photo pass that read the photos before the place lane deleted the shop sends nothing', async () => {
    const ctx = await setup();
    try {
      const race = await photoRace(ctx, async (deps, id) => {
        await ctx.messages.markDeleted(id, new Date(), ctx.accountId);
        await runOcpPlaceOutboxPass(deps);
      });
      await runOcpPhotoOutboxPass(race.deps);
      expect(race.sent.map((request) => [request.method, request.revision])).toEqual([
        ['PUT', 1],
        ['DELETE', 2],
      ]);
      expect(await ctx.shops.getByMessageId(race.id)).toMatchObject({
        ocpRevision: 2,
        ocpPlacePending: false,
        ocpPhotosPending: false,
        ocpPhotosClaimedUntil: null,
      });
    } finally {
      await ctx.cleanup();
    }
  });

  test('reads the photo content types of a shop note without its bytes', async () => {
    const ctx = await setup();
    try {
      const row = ctx.note({ hasPhoto: true });
      await ctx.messages.create(row, PNG, undefined, [
        { contentType: 'image/jpeg', bytes: new Uint8Array([4, 5]) },
        { contentType: 'image/webp', bytes: new Uint8Array([6]) },
      ]);
      expect(await ctx.messages.getPhotoContentTypes(row.id)).toEqual({
        photo: 'image/png',
        extras: ['image/jpeg', 'image/webp'],
      });
      // Same answer as the byte reads it replaces in shop kind 0.
      expect((await ctx.messages.getPhoto(row.id))?.contentType).toBe('image/png');
      expect((await ctx.messages.listExtraPhotos(row.id)).map((p) => p.contentType)).toEqual([
        'image/jpeg',
        'image/webp',
      ]);
      const plain = ctx.note();
      await ctx.messages.create(plain);
      expect(await ctx.messages.getPhotoContentTypes(plain.id)).toEqual({
        photo: null,
        extras: [],
      });
      expect(await ctx.messages.getPhotoContentTypes(crypto.randomUUID())).toEqual({
        photo: null,
        extras: [],
      });
    } finally {
      await ctx.cleanup();
    }
  });

  test('reads the whole photo set of a note in one statement, never a mixed set', async () => {
    const ctx = await setup();
    try {
      const row = ctx.note({ hasPhoto: true });
      const jpeg = { contentType: 'image/jpeg' as const, bytes: new Uint8Array([4, 5]) };
      const webp = { contentType: 'image/webp' as const, bytes: new Uint8Array([6]) };
      const first = [PNG, jpeg, webp];
      const second = [webp, PNG];
      await ctx.messages.create(row, PNG, undefined, [jpeg, webp]);
      // The same stills as the two separate reads.
      expect(await ctx.messages.getPhotoSet(row.id)).toEqual({
        photo: await ctx.messages.getPhoto(row.id),
        extras: await ctx.messages.listExtraPhotos(row.id),
      });
      // Plain arrays, so Bun's Buffer and a Uint8Array compare by content.
      const plainStills = (photos: readonly ForumPhoto[]): unknown =>
        photos.map((photo) => ({ contentType: photo.contentType, bytes: [...photo.bytes] }));
      const asList = (set: Awaited<ReturnType<PostgresMessageStore['getPhotoSet']>>): unknown =>
        plainStills(set.photo === null ? [] : [set.photo, ...set.extras]);
      // replacePhotos swaps photo 0 and the extras in one transaction: every
      // read during the swaps is one whole set.
      for (let round = 0; round < 10; round += 1) {
        const reads = await Promise.all([
          ctx.messages.replacePhotos(row.id, round % 2 === 0 ? second : first),
          ctx.messages.getPhotoSet(row.id),
          ctx.messages.getPhotoSet(row.id),
        ]);
        for (const set of reads.slice(1) as Array<
          Awaited<ReturnType<PostgresMessageStore['getPhotoSet']>>
        >) {
          expect([plainStills(first), plainStills(second)]).toContainEqual(asList(set));
        }
      }
      const plain = ctx.note();
      await ctx.messages.create(plain);
      expect(await ctx.messages.getPhotoSet(plain.id)).toEqual({ photo: null, extras: [] });
      expect(await ctx.messages.getPhotoSet(crypto.randomUUID())).toEqual({
        photo: null,
        extras: [],
      });
    } finally {
      await ctx.cleanup();
    }
  });

  test('pages the round robin with bounded keyset reads and wraps at the end', async () => {
    const ctx = await setup();
    try {
      const ids: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const row = ctx.note();
        await ctx.messages.create(row);
        await ctx.shops.ensureListed(row.id, KEK);
        ids.push(row.id);
      }
      expect(
        await ctx.client.query<{ n: string }>('SELECT count(*)::text AS n FROM shop_identity'),
      ).toEqual([{ n: '5' }]);
      // Rows 0 and 1 share a key time, so the message id orders them.
      const order = [...ids.slice(0, 2)].sort().concat(ids.slice(2));
      for (const [index, id] of order.entries()) {
        await ctx.client.execute(
          `UPDATE shop_identity SET nostr_key_created_at = $2 WHERE message_id = $1`,
          [id, new Date(Date.UTC(2026, 9, 1, 0, 0, 0, Math.max(index, 1)))],
        );
      }
      expect((await ctx.shops.listAll()).map((row) => row.messageId)).toEqual(order);
      const rows = await ctx.shops.listAll();
      const at = (index: number): { createdAt: Date; messageId: string } => ({
        createdAt: rows[index]!.nostrKeyCreatedAt,
        messageId: rows[index]!.messageId,
      });
      const round = async (
        cursor: { createdAt: Date; messageId: string } | null,
        limit: number,
      ): Promise<string[]> =>
        (await ctx.shops.listRound(cursor, limit)).map((row) => row.messageId);
      expect(await round(null, 2)).toEqual(order.slice(0, 2));
      expect(await round(at(0), 1)).toEqual([order[1]!]);
      expect(await round(at(1), 2)).toEqual(order.slice(2, 4));
      expect(await round(at(3), 3)).toEqual([order[4]!, order[0]!, order[1]!]);
      expect(await round(at(2), 20)).toEqual([
        order[3]!,
        order[4]!,
        order[0]!,
        order[1]!,
        order[2]!,
      ]);
      const gone = { createdAt: rows[4]!.nostrKeyCreatedAt, messageId: crypto.randomUUID() };
      expect((await round(gone, 5)).length).toBe(5);
      expect(
        await ctx.client.query<{ indexdef: string }>(
          `SELECT indexdef FROM pg_indexes WHERE indexname = 'shop_identity_key_order_idx'`,
        ),
      ).toEqual([
        {
          indexdef:
            'CREATE INDEX shop_identity_key_order_idx ON public.shop_identity USING btree (nostr_key_created_at, message_id)',
        },
      ]);
      // The NIP-05 allocation reads every shop note with one uuid[] statement.
      const notes = await ctx.messages.getByIds([...ids, crypto.randomUUID()]);
      expect(notes.map((note) => note.id).sort()).toEqual([...ids].sort());
      expect(await ctx.messages.getByIds([])).toEqual([]);
    } finally {
      await ctx.cleanup();
    }
  });
});
