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
import { unsignedNostrDefaults } from '@/lib/message';
import { migrateMessageSchema, PostgresMessageStore } from '@/lib/message-store';
import {
  migrateShopIdentitySchema,
  PostgresShopIdentityStore,
  SHOP_IDENTITY_SCHEMA_SQL,
} from '@/lib/shop-identity';
import { runOcpPhotoOutboxPass, runOcpPlaceOutboxPass } from '@/lib/ocp-outbox';
import { signEventForShop } from '@/lib/nostr/sign';
import type { MessageRow } from '@/lib/message';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined || databaseUrl === '') {
  throw new Error('DATABASE_URL is required');
}

/**
 * `query` / `execute` body matches `createBunDatabase(...).client` in `src/index.ts`.
 * `sql` is that same instance so the test can close it.
 */
function createBunSqlClient(databaseUrl: string): { client: SqlClient; sql: SQL } {
  const sql = new SQL(databaseUrl);
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

  test('concurrent trigger installs all succeed and leave each trigger exactly once', async () => {
    const ctx = await setup();
    try {
      const installs = SHOP_IDENTITY_SCHEMA_SQL.filter((statement) =>
        statement.startsWith('DO $trigger$'),
      );
      expect(installs).toHaveLength(3);
      await Promise.all(
        Array.from({ length: 6 }, () => installs).flatMap((batch) =>
          batch.map((statement) => ctx.client.execute(statement)),
        ),
      );
      const rows = await ctx.client.query<{ tgname: string; n: string }>(
        `SELECT tgname, count(*)::text AS n FROM pg_trigger
         WHERE tgname IN ('trg_shop_identity_place', 'trg_shop_identity_cover',
           'trg_shop_identity_extra_photo')
         GROUP BY tgname ORDER BY tgname`,
      );
      expect(rows).toEqual([
        { tgname: 'trg_shop_identity_cover', n: '1' },
        { tgname: 'trg_shop_identity_extra_photo', n: '1' },
        { tgname: 'trg_shop_identity_place', n: '1' },
      ]);
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
      await ctx.shops.setProfileName(row.id, 'Other');
      expect((await ctx.shops.listAll()).find((r) => r.messageId === row.id)?.profileName).toBe(
        'Other',
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
});
