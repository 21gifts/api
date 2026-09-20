import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { SqlClient } from '@/lib/auth/sql';
import {
  forumContentFingerprint,
  unsignedNostrDefaults,
  type ForumPhoto,
  type MessageRow,
} from '@/lib/message';
import {
  InMemoryMessageStore,
  MESSAGE_SCHEMA_SQL,
  migrateMessageSchema,
  PostgresMessageStore,
  type MessageInvoiceAttempt,
  type ZapIngestRow,
} from '@/lib/message-store';
import { resolveMediaDir, videoFilePath } from '@/lib/video';

class MockSql implements SqlClient {
  executes: { text: string; params: readonly unknown[] }[] = [];
  queries: { text: string; params: readonly unknown[] }[] = [];
  nextRows: unknown[] = [];
  queryQueue: unknown[][] = [];
  queryError: unknown | undefined;
  executeError: unknown | undefined;

  async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    this.queries.push({ text, params });
    if (this.queryError !== undefined) {
      throw this.queryError;
    }
    if (this.queryQueue.length > 0) {
      return this.queryQueue.shift() as T[];
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

const EARLY: MessageRow = {
  id: 'a',
  accountId: 'acc',
  name: 'Ada',
  text: 'first',
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  hasPhoto: false,
  ...unsignedNostrDefaults(),
};

const LATE: MessageRow = {
  id: 'b',
  accountId: 'acc',
  name: 'Ada',
  text: 'second',
  createdAt: new Date('2026-08-02T00:00:00.000Z'),
  hasPhoto: false,
  ...unsignedNostrDefaults(),
};

const TIE_HIGH: MessageRow = {
  id: 'z',
  accountId: 'acc',
  name: 'Ada',
  text: 'tie-high',
  createdAt: new Date('2026-08-03T00:00:00.000Z'),
  hasPhoto: false,
  ...unsignedNostrDefaults(),
};

const TIE_LOW: MessageRow = {
  id: 'm',
  accountId: 'acc',
  name: 'Ada',
  text: 'tie-low',
  createdAt: new Date('2026-08-03T00:00:00.000Z'),
  hasPhoto: false,
  ...unsignedNostrDefaults(),
};

const JPEG: ForumPhoto = {
  contentType: 'image/jpeg',
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
};
const JPEG2: ForumPhoto = {
  contentType: 'image/jpeg',
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
};

describe('MESSAGE_SCHEMA_SQL', () => {
  it('creates message with photo columns, Nostr columns, index, and additive ALTERs', () => {
    expect(MESSAGE_SCHEMA_SQL).toHaveLength(53);
    expect(MESSAGE_SCHEMA_SQL[0]).toMatch(/CREATE TABLE IF NOT EXISTS message/i);
    expect(MESSAGE_SCHEMA_SQL[0]).toMatch(/account_id uuid NOT NULL REFERENCES account/i);
    expect(MESSAGE_SCHEMA_SQL[0]).toMatch(/photo bytea/i);
    expect(MESSAGE_SCHEMA_SQL[0]).toMatch(/photo_content_type text/i);
    expect(MESSAGE_SCHEMA_SQL[1]).toMatch(/CREATE INDEX IF NOT EXISTS message_created_at_idx/i);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE message ADD COLUMN IF NOT EXISTS photo bytea/i,
    );
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE message ADD COLUMN IF NOT EXISTS photo_content_type text/i,
    );
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/event_id/);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/nostr_zap_receipt/);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/payer_account_id uuid/);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/payer_pubkey text/);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/zap_request_id text/);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/nostr_zap_receipt_request_uidx/);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/CREATE TABLE IF NOT EXISTS nostr_zapper/);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(
      /CREATE TABLE IF NOT EXISTS nostr_blocked_pubkey/,
    );
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/gift_reply_id uuid REFERENCES message/);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE nostr_zap_receipt ADD COLUMN IF NOT EXISTS comment text NOT NULL DEFAULT ''/,
    );
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/nostr_zap_receipt_gift_reply_id_uidx/);
    const zapPaymentDdl = MESSAGE_SCHEMA_SQL.find((statement) =>
      statement.includes('CREATE TABLE IF NOT EXISTS nostr_zap_payment'),
    );
    expect(zapPaymentDdl).toMatch(/payment_hash text PRIMARY KEY/);
    expect(zapPaymentDdl).toMatch(/receipt_event_id text NOT NULL/);
    expect(zapPaymentDdl).toMatch(/created_at timestamptz NOT NULL/);
    expect(zapPaymentDdl).not.toMatch(/REFERENCES message/);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/CREATE TABLE IF NOT EXISTS message_invoice/i);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/CREATE TABLE IF NOT EXISTS nostr_zap_ingest/i);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/message_invoice_created_at_idx/i);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/nostr_zap_ingest_receipt_id_idx/i);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/parent_id/);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/author_pubkey/);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE message ALTER COLUMN account_id DROP NOT NULL/i,
    );
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/message_parent_id_idx/);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/lnurl_response/);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/account_profile_message_id_fkey/);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/ON DELETE SET NULL/);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/account_profile_message_uidx/);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE message ADD COLUMN IF NOT EXISTS deleted_at timestamptz/,
    );
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(
      /ALTER TABLE message ADD COLUMN IF NOT EXISTS deleted_by uuid/,
    );
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/message_nostr_event_unrepaired_idx/);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/content_fp/);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/CREATE EXTENSION IF NOT EXISTS pgcrypto/);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/digest\(photo, 'sha256'\)/);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(
      /digest\(photo, 'sha256'\)[\s\S]*?video_content_type IS NULL/,
    );
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/content_fp \|\| ':' \|\| message\.id::text/);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).not.toMatch(/content_fp \|\| ':' \|\| id::text/);
    expect(
      MESSAGE_SCHEMA_SQL.filter((s) => s.includes('WITH ranked')).every((s) =>
        s.includes('message.id::text'),
      ),
    ).toBe(true);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/message_live_top_content_fp_uidx/);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/message_live_reply_content_fp_uidx/);
    expect(MESSAGE_SCHEMA_SQL.at(-1)).toContain('FROM pg_trigger');
    expect(MESSAGE_SCHEMA_SQL.at(-1)).toContain("tgname = 'trg_db_change'");
    expect(MESSAGE_SCHEMA_SQL.at(-1)).toContain("jsonb_typeof(nostr_event) = 'string'");
    expect(MESSAGE_SCHEMA_SQL.at(-1)).not.toContain('EXCEPTION WHEN others');
    expect(MESSAGE_SCHEMA_SQL.at(-1)).not.toContain('EXCEPTION WHEN invalid_text_representation');
    expect(MESSAGE_SCHEMA_SQL.at(-1)).toContain(
      'EXCEPTION WHEN data_exception OR statement_too_complex THEN',
    );
    expect(MESSAGE_SCHEMA_SQL.at(-1)).toContain(
      "unwrapped := (repair_row.nostr_event #>> '{}')::jsonb;",
    );
    expect(MESSAGE_SCHEMA_SQL.at(-1)).toContain('SET nostr_event = unwrapped');
    expect(MESSAGE_SCHEMA_SQL.at(-1)).toContain('nostr_attempts = 0');
    expect(MESSAGE_SCHEMA_SQL.at(-1)).toContain('CONTINUE;');
    expect(MESSAGE_SCHEMA_SQL.at(-1)).toContain('AND nostr_event = repair_row.nostr_event');
    expect(MESSAGE_SCHEMA_SQL.at(-1)).toMatch(
      /WHERE id = repair_row\.id[\s\S]*?jsonb_typeof\(nostr_event\) = 'string'[\s\S]*?AND nostr_event = repair_row\.nostr_event;/,
    );
    expect(MESSAGE_SCHEMA_SQL.at(-1)).toMatch(
      /unwrapped := \(repair_row\.nostr_event #>> '\{\}'\)::jsonb;[\s\S]*?EXCEPTION WHEN data_exception OR statement_too_complex THEN[\s\S]*?CONTINUE;[\s\S]*?END;[\s\S]*?UPDATE message/,
    );
    expect(MESSAGE_SCHEMA_SQL.at(-1)).not.toContain('repair_row.unwrapped_event');
  });
});

describe('migrateMessageSchema', () => {
  it('runs every MESSAGE_SCHEMA_SQL statement', async () => {
    const sql = new MockSql();
    await migrateMessageSchema(sql);
    expect(sql.executes.map((e) => e.text)).toEqual([...MESSAGE_SCHEMA_SQL]);
  });
});

describe('InMemoryMessageStore', () => {
  it('lists nothing when constructed empty', async () => {
    expect(await new InMemoryMessageStore().listLatest(10)).toEqual([]);
  });

  it('create returns the existing row when the id is already stored', async () => {
    const store = new InMemoryMessageStore();
    await store.create(EARLY);
    const again = await store.create({ ...EARLY, text: 'other' });
    expect(again.text).toBe('first');
    expect(await store.listDebug(10)).toHaveLength(1);
  });

  it('accountHasLivePost is false on an empty store', async () => {
    expect(await new InMemoryMessageStore().accountHasLivePost('acc', null)).toBe(false);
  });

  it('accountHasLivePost is true for a live top-level row by that account', async () => {
    expect(await new InMemoryMessageStore([EARLY]).accountHasLivePost('acc', null)).toBe(true);
  });

  it('accountHasLivePost is true for a live reply by that account', async () => {
    const store = new InMemoryMessageStore([{ ...EARLY, parentId: 'parent' }]);
    expect(await store.accountHasLivePost('acc', null)).toBe(true);
  });

  it('accountHasLivePost is false when only the excluded profile id is live', async () => {
    expect(await new InMemoryMessageStore([EARLY]).accountHasLivePost('acc', 'a')).toBe(false);
  });

  it('accountHasLivePost is true when the profile id plus a second live row exist', async () => {
    const store = new InMemoryMessageStore([EARLY, LATE]);
    expect(await store.accountHasLivePost('acc', 'a')).toBe(true);
  });

  it('accountHasLivePost is false when only a soft-deleted row exists', async () => {
    const store = new InMemoryMessageStore([
      { ...EARLY, deletedAt: new Date('2026-08-02T00:00:00.000Z') },
    ]);
    expect(await store.accountHasLivePost('acc', null)).toBe(false);
  });

  it('accountHasLivePost is false for a Damus-only row', async () => {
    const store = new InMemoryMessageStore([{ ...EARLY, accountId: null }]);
    expect(await store.accountHasLivePost('acc', null)).toBe(false);
    expect(await store.accountHasLivePost('other', null)).toBe(false);
  });

  it('accountHasLivePost is false for another account live row', async () => {
    expect(await new InMemoryMessageStore([EARLY]).accountHasLivePost('other', null)).toBe(false);
  });

  it('accountHasLiveTopLevelPost is false on an empty store', async () => {
    expect(await new InMemoryMessageStore().accountHasLiveTopLevelPost('acc', null)).toBe(false);
  });

  it('accountHasLiveTopLevelPost is true for a live top-level row by that account', async () => {
    expect(await new InMemoryMessageStore([EARLY]).accountHasLiveTopLevelPost('acc', null)).toBe(
      true,
    );
  });

  it('accountHasLiveTopLevelPost is false when only a live reply exists', async () => {
    const store = new InMemoryMessageStore([{ ...EARLY, parentId: 'parent' }]);
    expect(await store.accountHasLiveTopLevelPost('acc', null)).toBe(false);
  });

  it('accountHasLiveTopLevelPost is false when only the excluded profile id is live', async () => {
    expect(await new InMemoryMessageStore([EARLY]).accountHasLiveTopLevelPost('acc', 'a')).toBe(
      false,
    );
  });

  it('accountHasLiveTopLevelPost is true when the profile id plus a second live top-level row exist', async () => {
    const store = new InMemoryMessageStore([EARLY, LATE]);
    expect(await store.accountHasLiveTopLevelPost('acc', 'a')).toBe(true);
  });

  it('accountHasLiveTopLevelPost is false when the profile id plus only a live reply exist', async () => {
    const store = new InMemoryMessageStore([EARLY, { ...LATE, parentId: 'a' }]);
    expect(await store.accountHasLiveTopLevelPost('acc', 'a')).toBe(false);
  });

  it('accountHasLiveTopLevelPost is false when only a soft-deleted top-level row exists', async () => {
    const store = new InMemoryMessageStore([
      { ...EARLY, deletedAt: new Date('2026-08-02T00:00:00.000Z') },
    ]);
    expect(await store.accountHasLiveTopLevelPost('acc', null)).toBe(false);
  });

  it('accountHasLiveTopLevelPost is false for a Damus-only row', async () => {
    const store = new InMemoryMessageStore([{ ...EARLY, accountId: null }]);
    expect(await store.accountHasLiveTopLevelPost('acc', null)).toBe(false);
    expect(await store.accountHasLiveTopLevelPost('other', null)).toBe(false);
  });

  it('accountHasLiveTopLevelPost is false for another account live top-level row', async () => {
    expect(await new InMemoryMessageStore([EARLY]).accountHasLiveTopLevelPost('other', null)).toBe(
      false,
    );
  });

  it('countByAccount and member feeds are empty on an empty store', async () => {
    const store = new InMemoryMessageStore();
    expect(await store.countByAccount('acc')).toEqual({ postCount: 0, replyCount: 0 });
    expect(await store.listPostsByAccount('acc', 10)).toEqual([]);
    expect(await store.listRepliesByAccount('acc', 10)).toEqual([]);
  });

  it('countByAccount and member feeds keep only live rows for the asked account', async () => {
    const store = new InMemoryMessageStore([
      EARLY,
      { ...LATE, id: 'r-acc', parentId: 'a', text: 'reply' },
      { ...LATE, id: 'other-post', accountId: 'other', text: 'other' },
      { ...LATE, id: 'other-reply', accountId: 'other', parentId: 'a', text: 'other-reply' },
      {
        ...LATE,
        id: 'dead',
        text: 'hidden',
        deletedAt: new Date('2026-09-01T00:00:00.000Z'),
        deletedBy: 'staff',
      },
      { ...LATE, id: 'damus', accountId: null, name: 'aabbccdd…8899', text: 'damus' },
    ]);
    expect(await store.countByAccount('acc')).toEqual({ postCount: 1, replyCount: 1 });
    expect((await store.listPostsByAccount('acc', 10)).map((row) => row.id)).toEqual(['a']);
    expect((await store.listRepliesByAccount('acc', 10)).map((row) => row.id)).toEqual(['r-acc']);
  });

  it('counts a profile note as a post', async () => {
    const store = new InMemoryMessageStore([{ ...EARLY, id: 'profile', parentId: null }]);
    expect(await store.countByAccount('acc')).toEqual({ postCount: 1, replyCount: 0 });
    expect((await store.listPostsByAccount('acc', 10)).map((row) => row.id)).toEqual(['profile']);
  });

  it('listPostsByAccount is newest-first and honors limit', async () => {
    const store = new InMemoryMessageStore([EARLY, LATE, TIE_LOW, TIE_HIGH]);
    expect((await store.listPostsByAccount('acc', 10)).map((row) => row.id)).toEqual([
      'z',
      'm',
      'b',
      'a',
    ]);
    expect((await store.listPostsByAccount('acc', 1)).map((row) => row.id)).toEqual(['z']);
  });

  it('listRepliesByAccount is newest-first and honors limit', async () => {
    const store = new InMemoryMessageStore([EARLY]);
    await store.create({
      ...LATE,
      id: 'r-early',
      parentId: 'a',
      text: 'early',
      createdAt: new Date('2026-08-01T12:00:00.000Z'),
    });
    await store.create({
      ...LATE,
      id: 'r-late',
      parentId: 'a',
      text: 'late',
      createdAt: new Date('2026-08-01T13:00:00.000Z'),
    });
    const same = new Date('2026-08-01T14:00:00.000Z');
    await store.create({ ...LATE, id: 'rb', parentId: 'a', text: 'tie-b', createdAt: same });
    await store.create({ ...LATE, id: 'ra', parentId: 'a', text: 'tie-a', createdAt: same });
    expect((await store.listRepliesByAccount('acc', 10)).map((row) => row.id)).toEqual([
      'rb',
      'ra',
      'r-late',
      'r-early',
    ]);
    expect((await store.listRepliesByAccount('acc', 1)).map((row) => row.id)).toEqual(['rb']);
  });

  it('listPostsByAccount includes replyCount of live attributed children only', async () => {
    const store = new InMemoryMessageStore([EARLY]);
    await store.create({ ...LATE, id: 'r-member', parentId: 'a', text: 'member child' });
    await store.create({
      ...LATE,
      id: 'r-damus',
      parentId: 'a',
      accountId: null,
      name: 'aabbccdd…8899',
      text: 'damus child',
    });
    await store.create({
      ...LATE,
      id: 'r-external',
      parentId: 'a',
      accountId: null,
      authorPubkey: 'aa'.repeat(32),
      name: 'External',
      text: 'external child',
    });
    await store.create({
      ...LATE,
      id: 'r-hidden',
      parentId: 'a',
      text: 'hidden member',
      deletedAt: new Date('2026-09-01T00:00:00.000Z'),
      deletedBy: 'staff',
    });
    await store.recordZapper('aa'.repeat(32), 'receipt-aa', new Date('2026-09-18T10:00:00Z'));
    const listed = await store.listPostsByAccount('acc', 10);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.replyCount).toBe(2);
  });

  it('listPostsByAccount and listRepliesByAccount copy photo and video flags', async () => {
    const store = new InMemoryMessageStore();
    await store.create({ ...EARLY, text: '' }, JPEG);
    const mp4 = new Uint8Array(32);
    mp4.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    await store.create({ ...LATE, id: 'vid', text: 'clip' }, undefined, {
      contentType: 'video/mp4',
      bytes: mp4,
    });
    await store.create({ ...LATE, id: 'r-photo', parentId: 'vid', text: 're' }, JPEG);
    const posts = await store.listPostsByAccount('acc', 10);
    expect(posts.find((row) => row.id === 'a')?.hasPhoto).toBe(true);
    expect(posts.find((row) => row.id === 'vid')?.hasVideo).toBe(true);
    const replies = await store.listRepliesByAccount('acc', 10);
    expect(replies[0]?.hasPhoto).toBe(true);
  });

  it('deleteById removes the row and returns false when missing', async () => {
    const store = new InMemoryMessageStore([EARLY, LATE]);
    expect(await store.deleteById('missing')).toBe(false);
    expect(await store.deleteById('a')).toBe(true);
    expect(await store.getById('a')).toBeUndefined();
    expect((await store.listLatest(10)).map((row) => row.id)).toEqual(['b']);
  });

  it('markDeleted returns false when missing and tags the row plus direct replies', async () => {
    const store = new InMemoryMessageStore();
    await store.create({ ...EARLY, id: 'p-hide', text: 'parent' }, JPEG);
    await store.create({ ...LATE, id: 'c-hide', parentId: 'p-hide', text: 'child' });
    await store.create({ ...EARLY, id: 'other', text: 'other-parent' });
    await store.create({ ...LATE, id: 'c2-live', parentId: 'other', text: 'other-child' });
    const invoice: MessageInvoiceAttempt = {
      id: 'inv-hide',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      messageId: 'p-hide',
      payerAccountId: 'payer',
      authorAccountId: 'author',
      amountSats: 21,
      lightningAddress: 'a@b.com',
      zapRequest: { kind: 9734 },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc1',
      paymentHash: 'aa'.repeat(32),
      description: null,
      descriptionHash: 'bb'.repeat(32),
      isNip57Invoice: true,
      lnurlResponse: null,
    };
    await store.recordInvoiceAttempt(invoice);
    expect(await store.recordZapReceipt('receipt-hide', 'p-hide', 21)).toBe(true);
    const at = new Date('2026-09-01T12:00:00.000Z');
    expect(await store.markDeleted('missing', at, 'staff')).toBe(false);
    expect(await store.markDeleted('p-hide', at, 'staff')).toBe(true);
    const parent = await store.getById('p-hide');
    const child = await store.getById('c-hide');
    expect(parent?.deletedAt?.toISOString()).toBe(at.toISOString());
    expect(parent?.deletedBy).toBe('staff');
    expect(child?.deletedAt?.toISOString()).toBe(at.toISOString());
    expect(child?.deletedBy).toBe('staff');
    expect(await store.getPhoto('p-hide')).toEqual(JPEG);
    expect((await store.listInvoiceAttempts(10)).map((row) => row.id)).toContain('inv-hide');
    expect(await store.recordZapReceipt('receipt-hide', 'p-hide', 1)).toBe(false);
    expect((await store.listLatest(10)).map((row) => row.id)).not.toContain('p-hide');
    expect(await store.listReplies('p-hide')).toEqual([]);
  });

  it('listDirectChildren includes hidden, Damus-only, and gift-only in createdAt then id order', async () => {
    const store = new InMemoryMessageStore();
    const at = new Date('2026-09-01T00:00:00.000Z');
    await store.create({ ...EARLY, id: 'parent', text: 'p' });
    await store.create({
      ...LATE,
      id: 'z-gift',
      parentId: 'parent',
      text: '',
      eventId: null,
      nostrPublishState: 'skipped',
    });
    await store.create({
      ...EARLY,
      id: 'a-damus',
      parentId: 'parent',
      accountId: null,
      name: 'npub',
      createdAt: new Date('2026-08-02T00:00:00.000Z'),
    });
    await store.create({
      ...LATE,
      id: 'm-live',
      parentId: 'parent',
      createdAt: new Date('2026-08-02T00:00:00.000Z'),
    });
    expect(await store.markDeleted('parent', at, 'staff')).toBe(true);
    expect(await store.listDirectChildren('missing')).toEqual([]);
    const listed = await store.listDirectChildren('parent');
    expect(listed.map((row) => row.id)).toEqual(['a-damus', 'm-live', 'z-gift']);
    expect(listed.every((row) => row.deletedAt?.toISOString() === at.toISOString())).toBe(true);
    listed[0]!.text = 'mutated';
    expect((await store.getById('a-damus'))?.text).toBe('first');
  });

  it('markDeleted keeps original stamps on an already-tagged target and stamps live children', async () => {
    const firstAt = new Date('2026-08-01T00:00:00.000Z');
    const secondAt = new Date('2026-09-01T00:00:00.000Z');
    const store = new InMemoryMessageStore([
      {
        ...EARLY,
        id: 'p-retag',
        deletedAt: firstAt,
        deletedBy: 'first-staff',
      },
      { ...LATE, id: 'c-retag', parentId: 'p-retag', text: 'child' },
    ]);
    expect(await store.markDeleted('p-retag', secondAt, 'second-staff')).toBe(true);
    const parent = await store.getById('p-retag');
    const child = await store.getById('c-retag');
    expect(parent?.deletedAt?.toISOString()).toBe(firstAt.toISOString());
    expect(parent?.deletedBy).toBe('first-staff');
    expect(child?.deletedAt?.toISOString()).toBe(secondAt.toISOString());
    expect(child?.deletedBy).toBe('second-staff');
  });

  it('markUndeleted returns false when missing and clears matching direct children', async () => {
    const at = new Date('2026-09-01T12:00:00.000Z');
    const later = new Date('2026-09-02T00:00:00.000Z');
    const store = new InMemoryMessageStore();
    await store.create({ ...EARLY, id: 'p-unhide', text: 'parent' }, JPEG);
    await store.create({ ...LATE, id: 'c-match', parentId: 'p-unhide', text: 'child' });
    await store.create({ ...LATE, id: 'c-mismatch', parentId: 'p-unhide', text: 'later' });
    await store.create({
      ...LATE,
      id: 'g-unhide',
      parentId: 'c-match',
      text: 'grandchild',
    });
    await store.create({ ...EARLY, id: 'other-unhide', text: 'other-parent' });
    const invoice: MessageInvoiceAttempt = {
      id: 'inv-unhide',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      messageId: 'p-unhide',
      payerAccountId: 'payer',
      authorAccountId: 'author',
      amountSats: 21,
      lightningAddress: 'a@b.com',
      zapRequest: { kind: 9734 },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc1',
      paymentHash: 'aa'.repeat(32),
      description: null,
      descriptionHash: 'bb'.repeat(32),
      isNip57Invoice: true,
      lnurlResponse: null,
    };
    await store.recordInvoiceAttempt(invoice);
    expect(await store.recordZapReceipt('receipt-unhide', 'p-unhide', 21)).toBe(true);
    expect(await store.markDeleted('c-mismatch', later, 'other-staff')).toBe(true);
    expect(await store.markDeleted('g-unhide', later, 'other-staff')).toBe(true);
    expect(await store.markDeleted('p-unhide', at, 'staff')).toBe(true);
    expect(await store.markUndeleted('missing')).toBe(false);
    expect(await store.markUndeleted('p-unhide')).toBe(true);
    const parent = await store.getById('p-unhide');
    const matched = await store.getById('c-match');
    const mismatched = await store.getById('c-mismatch');
    const grandchild = await store.getById('g-unhide');
    const other = await store.getById('other-unhide');
    expect(parent?.deletedAt).toBeNull();
    expect(parent?.deletedBy).toBeNull();
    expect(matched?.deletedAt).toBeNull();
    expect(matched?.deletedBy).toBeNull();
    expect(mismatched?.deletedAt?.toISOString()).toBe(later.toISOString());
    expect(mismatched?.deletedBy).toBe('other-staff');
    expect(grandchild?.deletedAt?.toISOString()).toBe(later.toISOString());
    expect(grandchild?.deletedBy).toBe('other-staff');
    expect(other?.deletedAt).toBeNull();
    expect(await store.getPhoto('p-unhide')).toEqual(JPEG);
    expect((await store.listInvoiceAttempts(10)).map((row) => row.id)).toContain('inv-unhide');
    expect(await store.recordZapReceipt('receipt-unhide', 'p-unhide', 1)).toBe(false);
    expect((await store.listLatest(10)).map((row) => row.id)).toContain('p-unhide');
    expect((await store.listReplies('p-unhide')).map((row) => row.id)).toEqual(['c-match']);
  });

  it('markUndeleted is a no-op for children when the target is already live', async () => {
    const at = new Date('2026-09-01T12:00:00.000Z');
    const store = new InMemoryMessageStore();
    await store.create({ ...EARLY, id: 'p-live', text: 'parent' });
    await store.create({ ...LATE, id: 'c-hidden', parentId: 'p-live', text: 'child' });
    expect(await store.markDeleted('c-hidden', at, 'staff')).toBe(true);
    expect(await store.markUndeleted('p-live')).toBe(true);
    const parent = await store.getById('p-live');
    const child = await store.getById('c-hidden');
    expect(parent?.deletedAt).toBeNull();
    expect(parent?.deletedBy).toBeNull();
    expect(child?.deletedAt?.toISOString()).toBe(at.toISOString());
    expect(child?.deletedBy).toBe('staff');
  });

  it('replyCount and worker scans omit soft-deleted rows', async () => {
    const store = new InMemoryMessageStore();
    const eventId = '11'.repeat(32);
    await store.create({
      ...EARLY,
      id: 'p-scan',
      eventId,
      nostrPublishState: 'published',
      hasPhoto: true,
      text: 'live parent',
    });
    await store.create({
      ...LATE,
      id: 'c-scan',
      parentId: 'p-scan',
      text: 'live child',
    });
    await store.create({
      ...LATE,
      id: 'c-dead',
      parentId: 'p-scan',
      text: 'dead child',
      deletedAt: new Date('2026-09-01T00:00:00.000Z'),
      deletedBy: 'staff',
    });
    await store.create({
      ...LATE,
      id: 'c-external',
      parentId: 'p-scan',
      accountId: null,
      authorPubkey: 'bb'.repeat(32),
      text: 'live external child',
    });
    await store.create({
      ...LATE,
      id: 'c-orphan',
      parentId: 'p-scan',
      accountId: null,
      authorPubkey: null,
      text: 'unattributed child',
    });
    await store.recordZapper('bb'.repeat(32), 'receipt-bb', new Date('2026-09-18T10:00:00Z'));
    const listed = await store.listLatest(10);
    expect(listed.find((row) => row.id === 'p-scan')?.replyCount).toBe(2);
    expect((await store.listReplies('p-scan')).map((row) => row.id)).toEqual([
      'c-external',
      'c-scan',
    ]);
    expect(await store.listPublishedEventIds(10)).toEqual([eventId]);
    await store.markDeleted('p-scan', new Date('2026-09-02T00:00:00.000Z'), 'staff');
    expect(await store.listPublishedEventIds(10)).toEqual([]);
    expect(await store.listPendingSigned(10)).toEqual([]);
    expect(await store.listSignedMissingPhoto(10)).toEqual([]);
    expect(await store.listSignedMissingVideo(10)).toEqual([]);
    expect(await store.listSignedMissingHashtags(10)).toEqual([]);
    expect(await store.claimUnsigned(10, 1_000, 60_000)).toEqual([]);
    expect(await store.claimUnpublished(10, 1_000, 60_000)).toEqual([]);
  });

  it('deleteById cascades replies, invoices, zap receipts, photo, and video', async () => {
    const store = new InMemoryMessageStore();
    const mp4 = new Uint8Array(32);
    mp4.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    await store.create({ ...EARLY, id: 'p-del', text: 'parent' }, JPEG, {
      contentType: 'video/mp4',
      bytes: mp4,
    });
    await store.create({
      ...LATE,
      id: 'c-del',
      parentId: 'p-del',
      text: 'child',
    });
    const invoice: MessageInvoiceAttempt = {
      id: 'inv-del',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      messageId: 'p-del',
      payerAccountId: 'payer',
      authorAccountId: 'author',
      amountSats: 21,
      lightningAddress: 'a@b.com',
      zapRequest: { kind: 9734 },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc1',
      paymentHash: 'aa'.repeat(32),
      description: null,
      descriptionHash: 'bb'.repeat(32),
      isNip57Invoice: true,
      lnurlResponse: null,
    };
    await store.recordInvoiceAttempt(invoice);
    expect(await store.recordZapReceipt('receipt-del', 'p-del', 21)).toBe(true);
    expect(await store.recordZapReceipt('receipt-del', 'p-del', 21)).toBe(false);
    expect(await store.claimZapPayment('AB'.repeat(32), 'receipt-del', new Date(0))).toBe(true);
    await store.create({ ...LATE });
    expect(await store.recordZapReceipt('receipt-keep', LATE.id, 1)).toBe(true);
    const videoPath = videoFilePath(resolveMediaDir(), 'p-del', 'video/mp4');
    await readFile(videoPath);
    expect(await store.deleteById('p-del')).toBe(true);
    expect(await store.getById('p-del')).toBeUndefined();
    expect(await store.getById('c-del')).toBeUndefined();
    expect(
      (await store.listInvoiceAttempts(10)).filter((row) => row.messageId === 'p-del'),
    ).toEqual([]);
    expect(await store.recordZapReceipt('receipt-del', 'p-del', 7)).toBe(true);
    expect(await store.recordZapReceipt('receipt-keep', 'b', 1)).toBe(false);
    expect(await store.claimZapPayment('ab'.repeat(32), 'receipt-other', new Date(1))).toBe(false);
    expect(await store.getPhoto('p-del')).toBeNull();
    await expect(readFile(videoPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('copies the seed and listed rows so callers cannot mutate store state', async () => {
    const seed: MessageRow[] = [EARLY, LATE];
    const store = new InMemoryMessageStore(seed);
    seed.pop();
    seed[0] = { ...LATE, text: 'mutated-seed' };
    const listed = await store.listLatest(10);
    expect(listed).toHaveLength(2);
    listed.pop();
    if (listed[0] !== undefined) {
      listed[0].text = 'mutated-listed';
    }
    const again = await store.listLatest(10);
    expect(again).toHaveLength(2);
    expect(again.map((r) => r.text).sort()).toEqual(['first', 'second']);
  });

  it('returns newest createdAt first', async () => {
    const store = new InMemoryMessageStore([EARLY, LATE]);
    const listed = await store.listLatest(10);
    expect(listed.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('breaks equal createdAt ties by id descending', async () => {
    const store = new InMemoryMessageStore([TIE_LOW, TIE_HIGH]);
    const listed = await store.listLatest(10);
    expect(listed.map((r) => r.id)).toEqual(['z', 'm']);
  });

  it('keeps equal id and createdAt as a sort tie', async () => {
    const dup: MessageRow = {
      ...TIE_HIGH,
      createdAt: new Date(TIE_HIGH.createdAt.getTime()),
    };
    const store = new InMemoryMessageStore([TIE_HIGH, dup]);
    const listed = await store.listLatest(10);
    expect(listed.map((r) => r.id)).toEqual(['z', 'z']);
  });

  it('caps the list at limit', async () => {
    const store = new InMemoryMessageStore([EARLY, LATE, TIE_HIGH]);
    expect((await store.listLatest(1)).map((r) => r.id)).toEqual(['z']);
  });

  it('returns the existing row when create repeats a non-null eventId', async () => {
    const store = new InMemoryMessageStore();
    const eventId = 'ee'.repeat(32);
    const first = await store.create({ ...EARLY, id: 'm1', eventId });
    const second = await store.create({ ...EARLY, id: 'm2', eventId, text: 'other' });
    expect(second.id).toBe(first.id);
    expect(second.text).toBe(first.text);
    expect(await store.listLatest(10)).toHaveLength(1);
  });

  it('findLiveByAccountContent hits, misses, skips deleted, and scopes parentId', async () => {
    const store = new InMemoryMessageStore();
    const fp = forumContentFingerprint('cap', JPEG.bytes);
    const first = await store.create({ ...EARLY, id: 'm-photo', text: 'cap' }, JPEG);
    expect(await store.findLiveByAccountContent('acc', null, fp)).toMatchObject({ id: first.id });
    expect(await store.findLiveByAccountContent('acc', null, 'ff'.repeat(32))).toBeUndefined();
    expect(await store.findLiveByAccountContent('other', null, fp)).toBeUndefined();
    await store.create(
      {
        ...LATE,
        id: 'm-reply',
        parentId: 'm-photo',
        text: 'cap',
      },
      JPEG,
    );
    const replyFp = forumContentFingerprint('cap', JPEG.bytes);
    expect((await store.findLiveByAccountContent('acc', 'm-photo', replyFp))?.id).toBe('m-reply');
    expect(await store.findLiveByAccountContent('acc', null, replyFp)).toMatchObject({
      id: first.id,
    });
    await store.markDeleted('m-photo', new Date('2026-09-01T00:00:00.000Z'), 'staff');
    expect(await store.findLiveByAccountContent('acc', null, fp)).toBeUndefined();
  });

  it('create collapses the same live media to the first row', async () => {
    const store = new InMemoryMessageStore();
    const first = await store.create({ ...EARLY, id: 'm1', text: 'same' }, JPEG);
    const second = await store.create({ ...EARLY, id: 'm2', text: 'same' }, JPEG);
    expect(second.id).toBe(first.id);
    expect(await store.listLatest(10)).toHaveLength(1);
  });

  it('create does not write a second video file on media collapse', async () => {
    const store = new InMemoryMessageStore();
    const mp4 = new Uint8Array(32);
    mp4.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    const video = { contentType: 'video/mp4' as const, bytes: mp4 };
    const first = await store.create({ ...EARLY, id: 'v1', text: 'clip' }, undefined, video);
    const path = videoFilePath(resolveMediaDir(), first.id, 'video/mp4');
    await readFile(path);
    const second = await store.create({ ...EARLY, id: 'v2', text: 'clip' }, undefined, video);
    expect(second.id).toBe(first.id);
    expect(await store.listLatest(10)).toHaveLength(1);
    await readFile(path);
    await expect(
      readFile(videoFilePath(resolveMediaDir(), 'v2', 'video/mp4')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('create keeps text-only posts as separate rows', async () => {
    const store = new InMemoryMessageStore();
    await store.create({ ...EARLY, id: 't1', text: 'hi' });
    await store.create({ ...EARLY, id: 't2', text: 'hi' });
    expect(await store.listLatest(10)).toHaveLength(2);
  });

  it('create with accountId null and a photo does not collapse', async () => {
    const store = new InMemoryMessageStore();
    const first = await store.create(
      {
        ...EARLY,
        id: 'damus-1',
        accountId: null,
        text: 'pic',
      },
      JPEG,
    );
    const second = await store.create(
      {
        ...EARLY,
        id: 'damus-2',
        accountId: null,
        text: 'pic',
      },
      JPEG,
    );
    expect(second.id).not.toBe(first.id);
    expect(await store.getById('damus-1')).toBeDefined();
    expect(await store.getById('damus-2')).toBeDefined();
  });

  it('create with distinct non-null eventIds does not collapse the same media', async () => {
    const store = new InMemoryMessageStore();
    const first = await store.create(
      {
        ...EARLY,
        id: 'n',
        text: 'same',
        eventId: '11'.repeat(32),
      },
      JPEG,
    );
    const second = await store.create(
      {
        ...EARLY,
        id: 'z',
        text: 'same',
        eventId: '22'.repeat(32),
      },
      JPEG,
    );
    expect(first.id).toBe('n');
    expect(second.id).toBe('z');
    expect(await store.getById('n')).toBeDefined();
    expect(await store.getById('z')).toBeDefined();
    expect(await store.listLatest(10)).toHaveLength(2);
  });

  it('lists only top-level notes with replyCount and lists replies oldest-first', async () => {
    const store = new InMemoryMessageStore([EARLY]);
    await store.create({
      ...LATE,
      id: 'r1',
      parentId: 'a',
      text: 'reply-early',
      createdAt: new Date('2026-08-01T12:00:00.000Z'),
    });
    await store.create({
      ...LATE,
      id: 'r2',
      parentId: 'a',
      text: 'reply-late',
      createdAt: new Date('2026-08-01T13:00:00.000Z'),
    });
    await store.create({
      ...LATE,
      id: 'r-external',
      parentId: 'a',
      accountId: null,
      authorPubkey: 'cc'.repeat(32),
      text: 'external reply',
      createdAt: new Date('2026-08-01T12:30:00.000Z'),
    });
    await store.create({
      ...LATE,
      id: 'r-orphan',
      parentId: 'a',
      accountId: null,
      authorPubkey: null,
      text: 'unattributed reply',
      createdAt: new Date('2026-08-01T12:45:00.000Z'),
    });
    await store.recordZapper('cc'.repeat(32), 'receipt-cc', new Date('2026-09-18T10:00:00Z'));
    const listed = await store.listLatest(10);
    expect(listed.map((r) => r.id)).toEqual(['a']);
    expect(listed[0]?.replyCount).toBe(3);
    const replies = await store.listReplies('a');
    expect(replies.map((r) => r.id)).toEqual(['r1', 'r-external', 'r2']);
  });

  it('listReplies and replyCount include external children but omit unattributed rows', async () => {
    const store = new InMemoryMessageStore([EARLY]);
    await store.create({
      ...LATE,
      id: 'r-member',
      parentId: 'a',
      text: 'member child',
    });
    await store.create({
      ...LATE,
      id: 'r-damus',
      parentId: 'a',
      accountId: null,
      name: 'aabbccdd…8899',
      text: 'damus child',
    });
    await store.create({
      ...LATE,
      id: 'r-external',
      parentId: 'a',
      accountId: null,
      authorPubkey: 'aa'.repeat(32),
      name: 'External',
      text: 'external child',
    });
    await store.create({
      ...LATE,
      id: 'r-hidden',
      parentId: 'a',
      text: 'hidden member',
      deletedAt: new Date('2026-09-01T00:00:00.000Z'),
      deletedBy: 'staff',
    });
    await store.recordZapper('aa'.repeat(32), 'receipt-aa', new Date('2026-09-18T10:00:00Z'));
    const listed = await store.listLatest(10);
    expect(listed.find((row) => row.id === 'a')?.replyCount).toBe(2);
    expect((await store.listReplies('a')).map((row) => row.id)).toEqual(['r-external', 'r-member']);
  });

  it('omits legacy external replies until their pubkey is recorded as a zapper', async () => {
    const pubkey = 'ee'.repeat(32);
    const store = new InMemoryMessageStore([EARLY]);
    await store.create({
      ...LATE,
      id: 'r-legacy',
      parentId: 'a',
      accountId: null,
      authorPubkey: pubkey,
      text: 'legacy external',
    });
    await store.create({
      ...LATE,
      id: 'r-member',
      parentId: 'a',
      text: 'member child',
    });
    await store.create({
      ...LATE,
      id: 'r-orphan',
      parentId: 'a',
      accountId: null,
      authorPubkey: null,
      text: 'orphan',
    });
    expect((await store.listLatest(10))[0]?.replyCount).toBe(1);
    expect((await store.listPostsByAccount('acc', 10))[0]?.replyCount).toBe(1);
    expect((await store.listReplies('a')).map((row) => row.id)).toEqual(['r-member']);
    expect(await store.isZapperPubkey(pubkey)).toBe(false);
    await store.recordZapper(
      pubkey.toUpperCase(),
      'receipt-legacy',
      new Date('2026-09-18T10:00:00Z'),
    );
    expect(await store.isZapperPubkey(pubkey)).toBe(true);
    expect((await store.listLatest(10))[0]?.replyCount).toBe(2);
    expect((await store.listPostsByAccount('acc', 10))[0]?.replyCount).toBe(2);
    expect((await store.listReplies('a')).map((row) => row.id)).toEqual(['r-legacy', 'r-member']);
  });

  it('listDebug includes hidden rows and replies newest-first', async () => {
    const store = new InMemoryMessageStore([EARLY]);
    await store.create({
      ...LATE,
      id: 'hidden-top',
      text: 'hidden',
      deletedAt: new Date('2026-09-01T00:00:00.000Z'),
      deletedBy: 'staff',
    });
    await store.create({
      ...LATE,
      id: 'r-debug',
      parentId: 'a',
      text: 'reply',
      createdAt: new Date('2026-08-04T00:00:00.000Z'),
    });
    const debugListed = await store.listDebug(10);
    expect(debugListed.map((row) => row.id)).toEqual(['r-debug', 'hidden-top', 'a']);
    expect(debugListed.find((row) => row.id === 'hidden-top')?.deletedAt?.toISOString()).toBe(
      '2026-09-01T00:00:00.000Z',
    );
    expect(debugListed.find((row) => row.id === 'r-debug')?.parentId).toBe('a');
    expect((await store.listLatest(10)).map((row) => row.id)).toEqual(['a']);
    expect((await store.listDebug(1)).map((row) => row.id)).toEqual(['r-debug']);
  });

  it('listDebug copies photo and video flags without exposing bytes', async () => {
    const store = new InMemoryMessageStore();
    await store.create({ ...EARLY, text: '' }, JPEG);
    const mp4 = new Uint8Array(32);
    mp4.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    await store.create({ ...LATE, id: 'vid', text: 'clip' }, undefined, {
      contentType: 'video/mp4',
      bytes: mp4,
    });
    const listed = await store.listDebug(10);
    const photoRow = listed.find((row) => row.id === 'a');
    const videoRow = listed.find((row) => row.id === 'vid');
    expect(photoRow?.hasPhoto).toBe(true);
    expect(videoRow?.hasVideo).toBe(true);
    expect(videoRow?.videoContentType).toBe('video/mp4');
    expect(photoRow).not.toHaveProperty('bytes');
    expect(photoRow).not.toHaveProperty('photo');
  });

  it('listDebug breaks equal createdAt ties by id descending', async () => {
    const same = new Date('2026-08-01T12:00:00.000Z');
    const store = new InMemoryMessageStore([
      { ...EARLY, id: 'za', createdAt: same },
      { ...EARLY, id: 'zb', createdAt: same },
    ]);
    expect((await store.listDebug(10)).map((row) => row.id)).toEqual(['zb', 'za']);
  });

  it('listHidden returns [] when empty', async () => {
    expect(await new InMemoryMessageStore().listHidden(10)).toEqual([]);
  });

  it('listHidden returns only rows with deletedAt set', async () => {
    const hiddenAt = new Date('2026-09-01T00:00:00.000Z');
    const store = new InMemoryMessageStore([
      EARLY,
      {
        ...LATE,
        id: 'hidden-top',
        text: 'hidden',
        deletedAt: hiddenAt,
        deletedBy: 'staff',
      },
      {
        ...LATE,
        id: 'r-hidden',
        parentId: 'a',
        text: 'hidden reply',
        deletedAt: hiddenAt,
        deletedBy: 'staff',
      },
    ]);
    const listed = await store.listHidden(10);
    expect(listed.map((row) => row.id)).toEqual(['r-hidden', 'hidden-top']);
    expect(listed.every((row) => row.deletedAt !== null)).toBe(true);
    expect((await store.listLatest(10)).map((row) => row.id)).toEqual(['a']);
  });

  it('listHidden sorts deletedAt descending then id descending and caps at limit', async () => {
    const earlier = new Date('2026-09-01T00:00:00.000Z');
    const later = new Date('2026-09-02T00:00:00.000Z');
    const store = new InMemoryMessageStore([
      { ...EARLY, id: 'old', deletedAt: earlier, deletedBy: 'staff' },
      { ...EARLY, id: 'za', deletedAt: later, deletedBy: 'staff' },
      { ...EARLY, id: 'zb', deletedAt: later, deletedBy: 'staff' },
    ]);
    expect((await store.listHidden(10)).map((row) => row.id)).toEqual(['zb', 'za', 'old']);
    expect((await store.listHidden(1)).map((row) => row.id)).toEqual(['zb']);
  });

  it('listHidden copies photo and video flags without exposing bytes', async () => {
    const store = new InMemoryMessageStore();
    await store.create({ ...EARLY, text: '' }, JPEG);
    const mp4 = new Uint8Array(32);
    mp4.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    await store.create({ ...LATE, id: 'vid', text: 'clip' }, undefined, {
      contentType: 'video/mp4',
      bytes: mp4,
    });
    await store.markDeleted('a', new Date('2026-09-01T00:00:00.000Z'), 'staff');
    await store.markDeleted('vid', new Date('2026-09-01T00:00:00.000Z'), 'staff');
    const listed = await store.listHidden(10);
    const photoRow = listed.find((row) => row.id === 'a');
    const videoRow = listed.find((row) => row.id === 'vid');
    expect(photoRow?.hasPhoto).toBe(true);
    expect(videoRow?.hasVideo).toBe(true);
    expect(videoRow?.videoContentType).toBe('video/mp4');
    expect(photoRow).not.toHaveProperty('bytes');
    expect(photoRow).not.toHaveProperty('photo');
  });

  it('breaks reply ties by id when createdAt matches', async () => {
    const store = new InMemoryMessageStore([EARLY]);
    const same = new Date('2026-08-01T12:00:00.000Z');
    await store.create({ ...LATE, id: 'rb', parentId: 'a', text: 'b', createdAt: same });
    await store.create({ ...LATE, id: 'ra', parentId: 'a', text: 'a', createdAt: same });
    await store.create({
      ...LATE,
      id: 'rc',
      parentId: 'a',
      accountId: null,
      authorPubkey: 'dd'.repeat(32),
      text: 'external',
      createdAt: same,
    });
    await store.create({
      ...LATE,
      id: 'rd',
      parentId: 'a',
      accountId: null,
      authorPubkey: null,
      text: 'unattributed',
      createdAt: same,
    });
    await store.recordZapper('dd'.repeat(32), 'receipt-dd', new Date('2026-09-18T10:00:00Z'));
    expect((await store.listReplies('a')).map((r) => r.id)).toEqual(['ra', 'rb', 'rc']);
  });

  it('listPublishedEventIds returns top-level non-null event ids newest-first', async () => {
    const store = new InMemoryMessageStore();
    await store.create({
      ...EARLY,
      id: 'p1',
      eventId: '11'.repeat(32),
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    await store.create({
      ...EARLY,
      id: 'p2',
      eventId: '22'.repeat(32),
      createdAt: new Date('2026-08-02T00:00:00.000Z'),
    });
    await store.create({
      ...EARLY,
      id: 'reply',
      parentId: 'p1',
      eventId: '33'.repeat(32),
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    expect(await store.listPublishedEventIds(10)).toEqual(['22'.repeat(32), '11'.repeat(32)]);
  });

  it('claimUnsigned skips Damus-only rows and replies whose parent has no eventId', async () => {
    const store = new InMemoryMessageStore();
    await store.create({ ...EARLY, id: 'damus', accountId: null });
    expect(await store.claimUnsigned(10, 1_000, 60_000)).toEqual([]);
    await store.create({ ...EARLY, id: 'parent' });
    await store.create({ ...LATE, id: 'child', parentId: 'parent' });
    const first = await store.claimUnsigned(10, 1_000, 60_000);
    expect(first.map((row) => row.id)).toEqual(['parent']);
    expect(await store.claimUnsigned(10, 1_000, 60_000)).toEqual([]);
    await store.updateSignedEvent('parent', 'ee'.repeat(32), { id: 'ee'.repeat(32) });
    const claimed = await store.claimUnsigned(10, 2_000_000, 60_000);
    expect(claimed.map((row) => row.id)).toEqual(['child']);
  });

  it('create then list returns the new row', async () => {
    const store = new InMemoryMessageStore();
    const created = await store.create(EARLY);
    expect(created.text).toBe('first');
    expect(created.hasPhoto).toBe(false);
    expect(created).not.toBe(EARLY);
    expect((await store.listLatest(10))[0]?.id).toBe('a');
  });

  it('create with non-null parentId when the parent is missing throws and does not append', async () => {
    const store = new InMemoryMessageStore();
    await expect(
      store.create({ ...LATE, id: 'orphan', parentId: 'missing', text: 'reply' }),
    ).rejects.toThrow('parent missing or deleted');
    expect(await store.getById('orphan')).toBeUndefined();
    expect(await store.listDebug(10)).toEqual([]);
  });

  it('create with non-null parentId when the parent has deletedAt set throws and does not append a live child', async () => {
    const store = new InMemoryMessageStore();
    await store.create({ ...EARLY, id: 'p-dead', text: 'parent' });
    await store.markDeleted('p-dead', new Date('2026-09-01T00:00:00.000Z'), 'staff');
    await expect(
      store.create({ ...LATE, id: 'c-dead', parentId: 'p-dead', text: 'reply' }),
    ).rejects.toThrow('parent missing or deleted');
    expect(await store.getById('c-dead')).toBeUndefined();
    expect((await store.listDebug(10)).map((row) => row.id)).toEqual(['p-dead']);
  });

  it('create with non-null parentId when the parent is live inserts', async () => {
    const store = new InMemoryMessageStore();
    await store.create(EARLY);
    const child = await store.create({ ...LATE, id: 'child-live', parentId: 'a', text: 'reply' });
    expect(child.parentId).toBe('a');
    expect((await store.getById('child-live'))?.id).toBe('child-live');
    expect((await store.listReplies('a')).map((row) => row.id)).toEqual(['child-live']);
  });

  it('create id-hit returns the stored reply after the parent is deleted', async () => {
    const store = new InMemoryMessageStore();
    await store.create({ ...EARLY, id: 'p-hit', text: 'parent' });
    const first = await store.create({ ...LATE, id: 'c-hit', parentId: 'p-hit', text: 'reply' });
    await store.markDeleted('p-hit', new Date('2026-09-01T00:00:00.000Z'), 'staff');
    const stored = await store.getById('c-hit');
    const again = await store.create({ ...LATE, id: 'c-hit', parentId: 'p-hit', text: 'other' });
    expect(again.id).toBe(first.id);
    expect(again.text).toBe('reply');
    expect(again).toEqual(stored);
    expect((await store.listDebug(10)).filter((row) => row.id === 'c-hit')).toHaveLength(1);
  });

  it('create with parentId null or undefined inserts a top-level row', async () => {
    const store = new InMemoryMessageStore();
    const withNull = await store.create({ ...EARLY, id: 'top-null', parentId: null });
    expect(withNull.parentId).toBeNull();
    expect((await store.getById('top-null'))?.id).toBe('top-null');
    const withUndef = await store.create({
      ...EARLY,
      id: 'top-undef',
      parentId: undefined as unknown as string | null,
    });
    expect(withUndef.parentId).toBeNull();
    expect((await store.listLatest(10)).map((row) => row.id).sort()).toEqual([
      'top-null',
      'top-undef',
    ]);
  });

  it('updates signed events, publish state, and sats', async () => {
    const store = new InMemoryMessageStore();
    await store.create(EARLY);
    expect(await store.updateSignedEvent('a', 'ee'.repeat(32), { id: 'ee'.repeat(32) })).toBe(true);
    await store.create(LATE);
    expect(await store.updateSignedEvent('b', 'ee'.repeat(32), { id: 'ee'.repeat(32) })).toBe(
      false,
    );
    expect(await store.updateSignedEvent('missing', 'ff'.repeat(32), {})).toBe(false);
    await store.updatePublishState('a', 'published', 'public');
    await store.addSats('a', 21);
    const row = await store.getById('a');
    expect(row?.eventId).toBe('ee'.repeat(32));
    expect(row?.nostrPublishState).toBe('published');
    expect(row?.sats).toBe(21);
    const unpublished = await store.claimUnpublished(10, 1_000, 60_000);
    expect(unpublished).toEqual([]);
  });

  it('updateText rewrites text and leaves sats and eventId unchanged', async () => {
    const store = new InMemoryMessageStore();
    await store.create({ ...EARLY, eventId: 'ee'.repeat(32), sats: 21 });
    const updated = await store.updateText('a', 'bio');
    expect(updated?.text).toBe('bio');
    expect(updated?.sats).toBe(21);
    expect(updated?.eventId).toBe('ee'.repeat(32));
    const stored = await store.getById('a');
    expect(stored?.text).toBe('bio');
    expect(stored?.sats).toBe(21);
    expect(stored?.eventId).toBe('ee'.repeat(32));
    expect(updated).not.toBe(stored);
    expect(await store.updateText('missing', 'x')).toBeUndefined();
  });

  it('updatePhoto sets and clears bytes without changing sats or eventId', async () => {
    const store = new InMemoryMessageStore();
    await store.create({ ...EARLY, eventId: 'ee'.repeat(32), sats: 21 });
    const updated = await store.updatePhoto('a', JPEG);
    expect(updated?.hasPhoto).toBe(true);
    expect(updated?.sats).toBe(21);
    expect(updated?.eventId).toBe('ee'.repeat(32));
    expect(updated?.text).toBe('first');
    const photo = await store.getPhoto('a');
    expect(photo).toEqual(JPEG);
    expect(photo?.bytes).not.toBe(JPEG.bytes);
    const stored = await store.getById('a');
    expect(stored?.hasPhoto).toBe(true);
    expect(stored?.sats).toBe(21);
    expect(stored?.eventId).toBe('ee'.repeat(32));
    expect(updated).not.toBe(stored);
    const cleared = await store.updatePhoto('a', null);
    expect(cleared?.hasPhoto).toBe(false);
    expect(cleared?.sats).toBe(21);
    expect(cleared?.eventId).toBe('ee'.repeat(32));
    expect(await store.getPhoto('a')).toBeNull();
    expect((await store.getById('a'))?.hasPhoto).toBe(false);
    expect(await store.updatePhoto('missing', JPEG)).toBeUndefined();
  });

  it('getById and claimUnsigned lease a row', async () => {
    const store = new InMemoryMessageStore();
    await store.create(EARLY);
    expect((await store.getById('a'))?.text).toBe('first');
    const claimed = await store.claimUnsigned(10, 1_000, 60_000);
    expect(claimed.map((row) => row.id)).toEqual(['a']);
    const again = await store.claimUnsigned(10, 1_000, 60_000);
    expect(again).toEqual([]);
    await store.create(LATE);
    const one = await store.claimUnsigned(1, 2_000_000, 60_000);
    expect(one).toHaveLength(1);
  });

  it('reclaims an unsigned row at the exact lease expiry', async () => {
    const store = new InMemoryMessageStore();
    await store.create(EARLY);
    expect((await store.claimUnsigned(10, 1_000, 60_000)).map((row) => row.id)).toEqual(['a']);
    expect(await store.claimUnsigned(10, 60_999, 60_000)).toEqual([]);
    expect((await store.claimUnsigned(10, 61_000, 60_000)).map((row) => row.id)).toEqual(['a']);
  });

  it('claimUnsigned skips published rows even when eventId is null', async () => {
    const store = new InMemoryMessageStore();
    await store.create({ ...EARLY, nostrPublishState: 'published' });
    expect(await store.claimUnsigned(10, 1_000, 60_000)).toEqual([]);
  });

  it('getByEventId returns the row for a stored eventId and undefined when missing', async () => {
    const store = new InMemoryMessageStore();
    const eventId = 'ee'.repeat(32);
    await store.create({ ...EARLY, eventId });
    expect((await store.getByEventId(eventId))?.id).toBe('a');
    expect(await store.getByEventId('ff'.repeat(32))).toBeUndefined();
  });

  it('recordZapReceipt adds sats once per receiptEventId', async () => {
    const store = new InMemoryMessageStore();
    await store.create(EARLY);
    expect(await store.recordZapReceipt('r1', 'a', 21)).toBe(true);
    expect((await store.getById('a'))?.sats).toBe(21);
    expect(await store.recordZapReceipt('r1', 'a', 21)).toBe(false);
    expect((await store.getById('a'))?.sats).toBe(21);
  });

  it('claimZapPayment allows idempotent re-claims and rejects another receipt id', async () => {
    const store = new InMemoryMessageStore();
    const at = new Date('2026-09-18T12:00:00.000Z');
    const paymentHash = 'AB'.repeat(32);
    expect(await store.claimZapPayment(paymentHash, 'receipt-a', at)).toBe(true);
    expect(await store.claimZapPayment(paymentHash, 'receipt-a', at)).toBe(true);
    expect(await store.claimZapPayment(paymentHash.toLowerCase(), 'receipt-b', at)).toBe(false);
  });

  it('tracks gift-reply receipts and finds ok invoices', async () => {
    const store = new InMemoryMessageStore();
    await store.create(EARLY);
    await store.recordZapReceipt('r-gift', 'a', 21);
    await store.updateZapReceiptGift('r-gift', { payerAccountId: 'payer' });
    expect(await store.listZapReceiptsAwaitingGiftReply(10)).toEqual([
      {
        receiptEventId: 'r-gift',
        messageId: 'a',
        sats: 21,
        payerAccountId: 'payer',
        payerPubkey: null,
        zapRequestId: null,
        receiptCreatedAt: null,
        comment: '',
      },
    ]);
    expect(await store.getZapReceiptGift('r-gift')).toEqual({
      receiptEventId: 'r-gift',
      messageId: 'a',
      sats: 21,
      payerAccountId: 'payer',
      payerPubkey: null,
      zapRequestId: null,
      giftReplyId: null,
      comment: '',
    });
    await store.updateZapReceiptGift('r-gift', { comment: 'hi' });
    expect((await store.getZapReceiptGift('r-gift'))?.comment).toBe('hi');
    expect(await store.getZapReceiptGift('missing')).toBeUndefined();
    await store.updateZapReceiptGift('r-gift', { giftReplyId: 'reply-1' });
    expect(await store.listZapReceiptsAwaitingGiftReply(10)).toEqual([]);
    await store.updateZapReceiptGift('missing', { payerAccountId: 'x' });
    const invoice: MessageInvoiceAttempt = {
      id: 'inv-ok',
      createdAt: new Date('2026-08-28T12:00:00.000Z'),
      messageId: 'a',
      payerAccountId: 'payer',
      authorAccountId: 'a',
      amountSats: 21,
      lightningAddress: null,
      zapRequest: { content: 'hi' },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc21',
      paymentHash: '11'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
    };
    await store.recordInvoiceAttempt({ ...invoice, result: 'not_zap', id: 'inv-bad' });
    await store.recordInvoiceAttempt({
      ...invoice,
      id: 'inv-newer',
      createdAt: new Date('2026-08-29T12:00:00.000Z'),
    });
    await store.recordInvoiceAttempt(invoice);
    const olderSameTime: MessageInvoiceAttempt = {
      ...invoice,
      id: 'inv-older',
      createdAt: invoice.createdAt,
      paymentHash: '11'.repeat(32),
      pr: 'lnbc21',
    };
    await store.recordInvoiceAttempt(olderSameTime);
    expect((await store.findOkInvoiceByPaymentHash('11'.repeat(32)))?.id).toBe('inv-newer');
    expect((await store.findOkInvoiceByPr('lnbc21'))?.id).toBe('inv-newer');
    expect(await store.findOkInvoiceByPaymentHash('22'.repeat(32))).toBeUndefined();
    expect(await store.findOkInvoiceByPr('lnbc-miss')).toBeUndefined();
  });

  it('lists an external payer receipt awaiting its gift reply', async () => {
    const store = new InMemoryMessageStore();
    const receiptCreatedAtSeconds = 1_758_196_800;
    await store.create(EARLY);
    await store.recordZapReceipt('r-external-gift', 'a', 21);
    await store.updateZapReceiptGift('r-external-gift', { payerPubkey: '81'.repeat(32) });
    await store.recordZapIngest({
      id: 'ingest-external-gift',
      createdAt: new Date('2026-09-18T10:00:00Z'),
      receiptId: 'r-external-gift',
      noteEventId: '82'.repeat(32),
      messageId: 'a',
      outcome: 'indexed',
      reason: null,
      amountSats: 21,
      receiptPubkey: '83'.repeat(32),
      receipt: { id: 'r-external-gift', created_at: receiptCreatedAtSeconds },
    });
    expect(await store.listZapReceiptsAwaitingGiftReply(10)).toEqual([
      {
        receiptEventId: 'r-external-gift',
        messageId: 'a',
        sats: 21,
        payerAccountId: null,
        payerPubkey: '81'.repeat(32),
        zapRequestId: null,
        receiptCreatedAt: new Date(receiptCreatedAtSeconds * 1000),
        comment: '',
      },
    ]);
  });

  it('derives awaiting gift-reply receiptCreatedAt from the newest indexed ingest', async () => {
    const store = new InMemoryMessageStore();
    const oldestSeconds = 1_758_193_200;
    const olderSeconds = 1_758_196_800;
    const newerSeconds = 1_758_200_400;
    await store.create(EARLY);
    await store.recordZapReceipt('r-gift-newest', 'a', 21);
    await store.updateZapReceiptGift('r-gift-newest', { payerAccountId: 'payer' });
    await store.recordZapIngest({
      id: 'ingest-gift-older',
      createdAt: new Date('2026-09-18T10:00:00Z'),
      receiptId: 'r-gift-newest',
      noteEventId: '82'.repeat(32),
      messageId: 'a',
      outcome: 'indexed',
      reason: null,
      amountSats: 21,
      receiptPubkey: '83'.repeat(32),
      receipt: { id: 'older', created_at: olderSeconds },
    });
    await store.recordZapIngest({
      id: 'ingest-gift-newer',
      createdAt: new Date('2026-09-18T11:00:00Z'),
      receiptId: 'r-gift-newest',
      noteEventId: '82'.repeat(32),
      messageId: 'a',
      outcome: 'indexed',
      reason: null,
      amountSats: 21,
      receiptPubkey: '83'.repeat(32),
      receipt: { id: 'newer', created_at: newerSeconds },
    });
    await store.recordZapIngest({
      id: 'ingest-gift-oldest',
      createdAt: new Date('2026-09-18T09:00:00Z'),
      receiptId: 'r-gift-newest',
      noteEventId: '82'.repeat(32),
      messageId: 'a',
      outcome: 'indexed',
      reason: null,
      amountSats: 21,
      receiptPubkey: '83'.repeat(32),
      receipt: { id: 'oldest', created_at: oldestSeconds },
    });
    expect(await store.listZapReceiptsAwaitingGiftReply(10)).toEqual([
      {
        receiptEventId: 'r-gift-newest',
        messageId: 'a',
        sats: 21,
        payerAccountId: 'payer',
        payerPubkey: null,
        zapRequestId: null,
        receiptCreatedAt: new Date(newerSeconds * 1000),
        comment: '',
      },
    ]);
  });

  it('attributes external receipts once and keeps entitlement through dequeue', async () => {
    const store = new InMemoryMessageStore();
    await store.create(EARLY);
    await store.recordZapReceipt('receipt-a', 'a', 21);
    await store.recordZapReceipt('receipt-b', 'a', 1);
    expect(
      await store.attributeZapReceipt('receipt-a', {
        payerPubkey: 'AA',
        zapRequestId: 'request-1',
        comment: 'thanks',
      }),
    ).toBe(true);
    expect(
      await store.attributeZapReceipt('receipt-b', {
        payerPubkey: 'bb',
        zapRequestId: 'request-1',
        comment: 'replay',
      }),
    ).toBe(false);
    expect(
      await store.attributeZapReceipt('missing', {
        payerPubkey: 'bb',
        zapRequestId: 'request-2',
        comment: '',
      }),
    ).toBe(false);
    await store.recordZapper('AA', 'receipt-a', new Date('2026-09-18T10:00:00Z'));
    await store.recordZapper('aa', 'receipt-b', new Date('2026-09-18T11:00:00Z'));
    await store.updateZapReceiptGift('receipt-a', { payerPubkey: null });
    expect(await store.listZapperPubkeys()).toEqual(['aa']);
    expect(await store.listZappers(10)).toEqual([
      {
        pubkey: 'aa',
        receiptEventId: 'receipt-a',
        createdAt: new Date('2026-09-18T10:00:00Z'),
      },
    ]);
    expect((await store.getZapReceiptGift('receipt-a'))?.zapRequestId).toBe('request-1');
  });

  it('isZapperPubkey is true after recordZapper and compares pubkeys case-insensitively', async () => {
    const store = new InMemoryMessageStore();
    expect(await store.isZapperPubkey('AA')).toBe(false);
    await store.recordZapper('AA', 'receipt-a', new Date('2026-09-18T10:00:00Z'));
    expect(await store.isZapperPubkey('AA')).toBe(true);
    expect(await store.isZapperPubkey('aa')).toBe(true);
    expect(await store.isZapperPubkey('bb')).toBe(false);
  });

  it('allows idempotent re-attribution of an in-memory receipt and refreshes payer details', async () => {
    const store = new InMemoryMessageStore();
    await store.create(EARLY);
    await store.recordZapReceipt('receipt-a', 'a', 21);
    await store.attributeZapReceipt('receipt-a', {
      payerPubkey: 'AA',
      zapRequestId: 'request-1',
      comment: 'first',
    });

    expect(
      await store.attributeZapReceipt('receipt-a', {
        payerPubkey: 'BB',
        zapRequestId: 'request-1',
        comment: 'updated',
      }),
    ).toBe(true);
    expect(await store.getZapReceiptGift('receipt-a')).toEqual({
      receiptEventId: 'receipt-a',
      messageId: 'a',
      sats: 21,
      payerAccountId: null,
      payerPubkey: 'bb',
      zapRequestId: 'request-1',
      giftReplyId: null,
      comment: 'updated',
    });
  });

  it('rejects a different request id for an attributed in-memory receipt without changes', async () => {
    const store = new InMemoryMessageStore();
    await store.create(EARLY);
    await store.recordZapReceipt('receipt-a', 'a', 21);
    await store.attributeZapReceipt('receipt-a', {
      payerPubkey: 'AA',
      zapRequestId: 'request-1',
      comment: 'first',
    });
    const before = await store.getZapReceiptGift('receipt-a');
    expect(before).toMatchObject({
      payerPubkey: 'aa',
      zapRequestId: 'request-1',
      comment: 'first',
    });

    expect(
      await store.attributeZapReceipt('receipt-a', {
        payerPubkey: 'BB',
        zapRequestId: 'request-2',
        comment: 'replacement',
      }),
    ).toBe(false);
    expect(await store.getZapReceiptGift('receipt-a')).toEqual(before);
  });

  it('lists unattributed indexed receipts and manages external blocks', async () => {
    const store = new InMemoryMessageStore();
    await store.create(EARLY);
    await store.recordZapReceipt('receipt-a', 'a', 21);
    await store.recordZapIngest({
      id: 'ingest-a',
      createdAt: new Date('2026-09-18T10:00:00Z'),
      receiptId: 'receipt-a',
      noteEventId: 'ee'.repeat(32),
      messageId: 'a',
      outcome: 'indexed',
      reason: null,
      amountSats: 21,
      receiptPubkey: 'ff'.repeat(32),
      receipt: { id: 'receipt-a' },
    });
    await store.recordZapReceipt('receipt-attributed', 'a', 2);
    await store.updateZapReceiptGift('receipt-attributed', { payerAccountId: 'payer' });
    await store.recordZapIngest({
      id: 'ingest-attributed',
      createdAt: new Date('2026-09-18T10:01:00Z'),
      receiptId: 'receipt-attributed',
      noteEventId: '93'.repeat(32),
      messageId: 'a',
      outcome: 'indexed',
      reason: null,
      amountSats: 2,
      receiptPubkey: '94'.repeat(32),
      receipt: { id: 'receipt-attributed' },
    });
    await store.recordZapReceipt('receipt-rejected', 'a', 1);
    await store.recordZapIngest({
      id: 'ingest-rejected',
      createdAt: new Date('2026-09-18T10:02:00Z'),
      receiptId: 'receipt-rejected',
      noteEventId: '95'.repeat(32),
      messageId: 'a',
      outcome: 'rejected',
      reason: 'invalid',
      amountSats: 1,
      receiptPubkey: '96'.repeat(32),
      receipt: { id: 'receipt-rejected' },
    });
    expect(await store.listUnattributedIndexedReceipts(10)).toEqual([
      {
        receiptEventId: 'receipt-a',
        messageId: 'a',
        sats: 21,
        createdAt: new Date('2026-09-18T10:00:00Z'),
        receipt: { id: 'receipt-a' },
      },
    ]);
    await store.blockPubkeyAndHideRows(
      'AA',
      new Date('2026-09-18T11:00:00Z'),
      'staff',
      'external-1',
    );
    await store.blockPubkeyAndHideRows(
      'aa',
      new Date('2026-09-18T12:00:00Z'),
      'other',
      'external-2',
    );
    expect(await store.isPubkeyBlocked('AA')).toBe(true);
    expect(await store.isPubkeyBlocked('bb')).toBe(false);
    expect(await store.listBlockedPubkeys()).toEqual(['aa']);
    expect(await store.listBlockedPubkeyRows(1)).toEqual([
      {
        pubkey: 'aa',
        blockedAt: new Date('2026-09-18T11:00:00Z'),
        blockedBy: 'staff',
        messageId: 'external-1',
      },
    ]);
    expect(await store.unblockPubkeyByMessage('other')).toBe(false);
    expect(await store.unblockPubkeyByMessage('external-1')).toBe(true);
    expect(await store.isPubkeyBlocked('aa')).toBe(false);
    expect(await store.listBlockedPubkeys()).toEqual([]);
  });

  it('lists one unattributed indexed receipt from the newest ingest', async () => {
    const store = new InMemoryMessageStore();
    await store.create(EARLY);
    await store.recordZapReceipt('receipt-dup', 'a', 21);
    await store.recordZapIngest({
      id: 'ingest-older',
      createdAt: new Date('2026-09-18T10:00:00Z'),
      receiptId: 'receipt-dup',
      noteEventId: 'ee'.repeat(32),
      messageId: 'a',
      outcome: 'indexed',
      reason: null,
      amountSats: 21,
      receiptPubkey: 'ff'.repeat(32),
      receipt: { id: 'older' },
    });
    await store.recordZapIngest({
      id: 'ingest-newer',
      createdAt: new Date('2026-09-18T11:00:00Z'),
      receiptId: 'receipt-dup',
      noteEventId: 'ee'.repeat(32),
      messageId: 'a',
      outcome: 'indexed',
      reason: null,
      amountSats: 21,
      receiptPubkey: 'ff'.repeat(32),
      receipt: { id: 'newer' },
    });
    await store.recordZapReceipt('receipt-tie', 'a', 7);
    const tiedAt = new Date('2026-09-18T10:00:00Z');
    await store.recordZapIngest({
      id: 'ingest-tie-a',
      createdAt: tiedAt,
      receiptId: 'receipt-tie',
      noteEventId: 'ee'.repeat(32),
      messageId: 'a',
      outcome: 'indexed',
      reason: null,
      amountSats: 7,
      receiptPubkey: 'ff'.repeat(32),
      receipt: { id: 'lower-id' },
    });
    await store.recordZapIngest({
      id: 'ingest-tie-z',
      createdAt: tiedAt,
      receiptId: 'receipt-tie',
      noteEventId: 'ee'.repeat(32),
      messageId: 'a',
      outcome: 'indexed',
      reason: null,
      amountSats: 7,
      receiptPubkey: 'ff'.repeat(32),
      receipt: { id: 'higher-id' },
    });
    await store.recordZapIngest({
      id: 'ingest-oldest',
      createdAt: new Date('2026-09-18T09:00:00Z'),
      receiptId: 'receipt-dup',
      noteEventId: 'ee'.repeat(32),
      messageId: 'a',
      outcome: 'indexed',
      reason: null,
      amountSats: 21,
      receiptPubkey: 'ff'.repeat(32),
      receipt: { id: 'oldest' },
    });
    await store.recordZapIngest({
      id: 'ingest-tie-0',
      createdAt: tiedAt,
      receiptId: 'receipt-tie',
      noteEventId: 'ee'.repeat(32),
      messageId: 'a',
      outcome: 'indexed',
      reason: null,
      amountSats: 7,
      receiptPubkey: 'ff'.repeat(32),
      receipt: { id: 'lowest-id' },
    });
    expect(await store.listUnattributedIndexedReceipts(10)).toEqual([
      {
        receiptEventId: 'receipt-dup',
        messageId: 'a',
        sats: 21,
        createdAt: new Date('2026-09-18T11:00:00Z'),
        receipt: { id: 'newer' },
      },
      {
        receiptEventId: 'receipt-tie',
        messageId: 'a',
        sats: 7,
        createdAt: tiedAt,
        receipt: { id: 'higher-id' },
      },
    ]);
  });

  it('uses secondary keys for strict receipt cursors on timestamp ties', async () => {
    const store = new InMemoryMessageStore();
    await store.create(EARLY);
    const tiedAt = new Date('2026-09-18T10:00:00Z');
    for (const receiptId of ['receipt-a', 'receipt-z']) {
      await store.recordZapReceipt(receiptId, 'a', 21);
      await store.recordZapIngest({
        id: `ingest-${receiptId}`,
        createdAt: tiedAt,
        receiptId,
        noteEventId: 'ee'.repeat(32),
        messageId: 'a',
        outcome: 'indexed',
        reason: null,
        amountSats: 21,
        receiptPubkey: 'ff'.repeat(32),
        receipt: { id: receiptId },
      });
    }
    await store.recordZapper('aa', 'receipt-a', tiedAt);
    await store.recordZapper('bb', 'receipt-z', tiedAt);
    await store.blockPubkeyAndHideRows('cc', tiedAt, 'staff', 'external-c');
    await store.blockPubkeyAndHideRows('dd', tiedAt, 'staff', 'external-d');

    const firstPage = await store.listUnattributedIndexedReceipts(1);
    expect(firstPage[0]?.receiptEventId).toBe('receipt-z');
    const first = firstPage[0];
    expect(first).toBeDefined();
    if (first === undefined) {
      throw new Error('expected first receipt page');
    }
    expect(
      (
        await store.listUnattributedIndexedReceipts(1, {
          createdAt: first.createdAt,
          eventId: first.receiptEventId,
        })
      )[0]?.receiptEventId,
    ).toBe('receipt-a');
    expect((await store.listZappers(1))[0]?.pubkey).toBe('bb');
    expect((await store.listBlockedPubkeyRows(1))[0]?.pubkey).toBe('dd');
  });

  it('atomically blocks an external pubkey and hides only its live external rows', async () => {
    const pubkey = 'ab'.repeat(32);
    const firstAt = new Date('2026-09-18T00:00:00Z');
    const secondAt = new Date('2026-09-19T00:00:00Z');
    const store = new InMemoryMessageStore();
    await store.create({ ...EARLY, id: 'external-a', accountId: null, authorPubkey: pubkey });
    await store.create({ ...LATE, id: 'external-b', accountId: null, authorPubkey: pubkey });
    await store.create({
      ...LATE,
      id: 'external-hidden',
      accountId: null,
      authorPubkey: pubkey,
      deletedAt: new Date('2026-09-17T00:00:00Z'),
      deletedBy: 'older',
    });
    await store.create({
      ...LATE,
      id: 'external-other',
      accountId: null,
      authorPubkey: 'cd'.repeat(32),
    });
    await store.create({
      ...LATE,
      id: 'external-anonymous',
      accountId: null,
      authorPubkey: null,
    });
    await store.create({ ...LATE, id: 'member-signed', authorPubkey: pubkey });

    expect(
      await store.blockPubkeyAndHideRows(pubkey.toUpperCase(), firstAt, 'staff', 'external-a'),
    ).toBe(2);
    expect((await store.getById('external-a'))?.deletedAt).toEqual(firstAt);
    expect((await store.getById('external-b'))?.deletedAt).toEqual(firstAt);
    expect((await store.getById('external-b'))?.deletedBy).toBe('staff');
    expect((await store.getById('external-hidden'))?.deletedBy).toBe('older');
    expect((await store.getById('external-other'))?.deletedAt).toBeNull();
    expect((await store.getById('external-anonymous'))?.deletedAt).toBeNull();
    expect((await store.getById('member-signed'))?.deletedAt).toBeNull();

    await store.create({
      ...LATE,
      id: 'external-later',
      accountId: null,
      authorPubkey: pubkey.toUpperCase(),
    });
    expect(await store.blockPubkeyAndHideRows(pubkey, secondAt, 'other', 'external-later')).toBe(1);
    expect((await store.getById('external-later'))?.deletedAt).toEqual(secondAt);
    expect(await store.listBlockedPubkeyRows(1)).toEqual([
      {
        pubkey,
        blockedAt: firstAt,
        blockedBy: 'staff',
        messageId: 'external-a',
      },
    ]);
  });

  it('listOpenConversationZapEventIds reads e-tags from ok conversation invoices', async () => {
    const store = new InMemoryMessageStore();
    const base: MessageInvoiceAttempt = {
      id: 'inv-pn',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: 'm1',
      payerAccountId: 'payer',
      authorAccountId: 'author',
      amountSats: 21,
      lightningAddress: null,
      zapRequest: { tags: [['e', 'ab'.repeat(32)]] },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc',
      paymentHash: '11'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
      conversationId: 'c1',
      conversationMessageId: 'cm1',
    };
    await store.recordInvoiceAttempt(base);
    await store.recordInvoiceAttempt({
      ...base,
      id: 'inv-empty-tags',
      zapRequest: { tags: [] },
      conversationMessageId: 'cm2',
    });
    await store.recordInvoiceAttempt({
      ...base,
      id: 'inv-no-tags',
      zapRequest: { kind: 9734 },
      conversationMessageId: 'cm3',
    });
    await store.recordInvoiceAttempt({
      ...base,
      id: 'inv-forum',
      conversationId: null,
      conversationMessageId: null,
    });
    await store.recordInvoiceAttempt({
      ...base,
      id: 'inv-no-cm',
      conversationMessageId: null,
    });
    await store.recordInvoiceAttempt({
      ...base,
      id: 'inv-dup-e',
      conversationMessageId: 'cm-later',
    });
    expect(await store.listOpenConversationZapEventIds()).toEqual([
      { eventId: 'ab'.repeat(32), conversationMessageId: 'cm1' },
      { eventId: 'ab'.repeat(32), conversationMessageId: 'cm-later' },
    ]);
  });

  it('listPendingSigned and clearSignedEvent round-trip in memory', async () => {
    const store = new InMemoryMessageStore();
    await store.create(EARLY);
    await store.updateSignedEvent('a', 'ab'.repeat(32), { id: 'x' });
    expect((await store.listPendingSigned(10)).map((row) => row.id)).toEqual(['a']);
    await store.clearSignedEvent('a', 'ab'.repeat(32));
    expect(await store.listPendingSigned(10)).toEqual([]);
    expect((await store.getById('a'))?.eventId).toBeNull();
    await store.clearSignedEvent('missing', 'ff'.repeat(32));
    await store.updateSignedEvent('a', 'cd'.repeat(32), {
      tags: [
        ['t', 'bitcoin'],
        ['t', '21gifts'],
      ],
    });
    await store.clearSignedEvent('a', 'ab'.repeat(32));
    expect((await store.getById('a'))?.eventId).toBe('cd'.repeat(32));
    await store.updatePublishState('a', 'published', 'space');
    await store.clearSignedEvent('a', 'cd'.repeat(32));
    expect((await store.getById('a'))?.eventId).toBe('cd'.repeat(32));
  });

  it('listSignedMissingPhoto excludes rows at the publish-attempt cap', async () => {
    const store = new InMemoryMessageStore([
      {
        ...EARLY,
        id: 'below-cap',
        hasPhoto: true,
        eventId: '11'.repeat(32),
        nostrEvent: { content: '' },
        nostrPublishState: 'published',
        nostrAttempts: 4,
      },
      {
        ...EARLY,
        id: 'at-cap',
        hasPhoto: true,
        eventId: '22'.repeat(32),
        nostrEvent: { content: '' },
        nostrPublishState: 'published',
        nostrAttempts: 5,
      },
    ]);

    expect((await store.listSignedMissingPhoto(10)).map((row) => row.id)).toEqual(['below-cap']);
  });

  it('listSignedMissingVideo excludes rows at the publish-attempt cap', async () => {
    const store = new InMemoryMessageStore([
      {
        ...EARLY,
        id: 'below-cap',
        hasVideo: true,
        videoContentType: 'video/mp4',
        eventId: '11'.repeat(32),
        nostrEvent: { content: '' },
        nostrPublishState: 'published',
        nostrAttempts: 4,
      },
      {
        ...EARLY,
        id: 'at-cap',
        hasVideo: true,
        videoContentType: 'video/mp4',
        eventId: '22'.repeat(32),
        nostrEvent: { content: '' },
        nostrPublishState: 'published',
        nostrAttempts: 5,
      },
    ]);

    expect((await store.listSignedMissingVideo(10)).map((row) => row.id)).toEqual(['below-cap']);
  });

  it('listSignedMissingHashtags excludes rows at the publish-attempt cap', async () => {
    const store = new InMemoryMessageStore([
      {
        ...EARLY,
        id: 'below-cap',
        eventId: '11'.repeat(32),
        nostrEvent: { content: 'missing hashtags' },
        nostrPublishState: 'published',
        nostrAttempts: 4,
      },
      {
        ...EARLY,
        id: 'at-cap',
        eventId: '22'.repeat(32),
        nostrEvent: { content: 'missing hashtags' },
        nostrPublishState: 'published',
        nostrAttempts: 5,
      },
    ]);

    expect((await store.listSignedMissingHashtags(10)).map((row) => row.id)).toEqual(['below-cap']);
  });

  it('resetSignedEvent counts attempts and preserves the first-attempt time', async () => {
    const existingFirstAttemptAt = 1_234_567;
    const store = new InMemoryMessageStore([
      {
        ...EARLY,
        id: 'without-first-attempt',
        eventId: '11'.repeat(32),
        nostrEvent: { content: '' },
        nostrPublishState: 'published',
        nostrAttempts: 2,
        nostrFirstAttemptAt: null,
      },
      {
        ...EARLY,
        id: 'with-first-attempt',
        eventId: '22'.repeat(32),
        nostrEvent: { content: '' },
        nostrPublishState: 'published',
        nostrAttempts: 3,
        nostrFirstAttemptAt: existingFirstAttemptAt,
      },
    ]);

    await store.resetSignedEvent('without-first-attempt', '11'.repeat(32));
    await store.resetSignedEvent('with-first-attempt', '22'.repeat(32));

    const withoutFirstAttempt = await store.getById('without-first-attempt');
    expect(withoutFirstAttempt?.nostrAttempts).toBe(3);
    expect(withoutFirstAttempt?.nostrFirstAttemptAt).toEqual(expect.any(Number));
    const withFirstAttempt = await store.getById('with-first-attempt');
    expect(withFirstAttempt?.nostrAttempts).toBe(4);
    expect(withFirstAttempt?.nostrFirstAttemptAt).toBe(existingFirstAttemptAt);
  });

  it('listSignedMissingPhoto and resetSignedEvent re-queue photo posts', async () => {
    const store = new InMemoryMessageStore();
    const jpeg: ForumPhoto = {
      contentType: 'image/jpeg',
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    };
    await store.create({ ...EARLY, text: '', hasPhoto: true }, jpeg);
    await store.updateSignedEvent('a', 'ab'.repeat(32), { content: '' });
    await store.updatePublishState('a', 'published', 'space');
    await store.create(
      {
        ...EARLY,
        id: 'n',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        hasPhoto: true,
        eventId: '11'.repeat(32),
        nostrEvent: null,
      },
      jpeg,
    );
    await store.create(
      {
        ...EARLY,
        id: 'z',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        hasPhoto: true,
        eventId: '22'.repeat(32),
        nostrEvent: { content: 1 },
      },
      jpeg,
    );
    const tiedAt = new Date('2026-08-15T00:00:00.000Z');
    await store.create(
      {
        ...EARLY,
        id: 'q',
        createdAt: tiedAt,
        hasPhoto: true,
        eventId: '33'.repeat(32),
        nostrEvent: { content: '' },
      },
      jpeg,
    );
    await store.create(
      {
        ...EARLY,
        id: 'p',
        createdAt: tiedAt,
        hasPhoto: true,
        eventId: '44'.repeat(32),
        nostrEvent: { content: '' },
      },
      jpeg,
    );
    await store.updatePublishState('n', 'published', 'space');
    await store.updatePublishState('p', 'published', 'space');
    await store.updatePublishState('q', 'published', 'space');
    await store.updatePublishState('z', 'published', 'space');
    expect((await store.listSignedMissingPhoto(10)).map((row) => row.id)).toEqual([
      'n',
      'a',
      'p',
      'q',
      'z',
    ]);
    await store.create(
      {
        ...EARLY,
        id: 'pending-photo',
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        hasPhoto: true,
        eventId: '55'.repeat(32),
        nostrEvent: { content: '' },
      },
      jpeg,
    );
    expect((await store.listSignedMissingPhoto(10)).map((row) => row.id)).not.toContain(
      'pending-photo',
    );
    await store.addSats('z', 21);
    expect((await store.listSignedMissingPhoto(10)).map((row) => row.id)).toEqual([
      'n',
      'a',
      'p',
      'q',
    ]);
    await store.resetSignedEvent('z', '22'.repeat(32));
    expect((await store.getById('z'))?.eventId).toBe('22'.repeat(32));
    await store.resetSignedEvent('a', 'ab'.repeat(32));
    expect((await store.getById('a'))?.eventId).toBeNull();
    expect((await store.getById('a'))?.nostrPublishState).toBe('pending');
    await store.updateSignedEvent('a', 'cd'.repeat(32), {
      content: 'http://127.0.0.1:3000/messages/a/photo.jpg',
    });
    expect((await store.listSignedMissingPhoto(10)).map((row) => row.id)).toEqual(['n', 'p', 'q']);
    await store.resetSignedEvent('a', 'ff'.repeat(32));
    expect((await store.getById('a'))?.eventId).toBe('cd'.repeat(32));
  });

  it('listSignedMissingVideo and resetSignedEvent re-queue video posts', async () => {
    const store = new InMemoryMessageStore();
    const mp4 = new Uint8Array(32);
    mp4.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    const video = { contentType: 'video/mp4' as const, bytes: mp4 };
    await store.create(
      { ...EARLY, text: 'clip', hasVideo: true, videoContentType: 'video/mp4' },
      undefined,
      video,
    );
    await store.updateSignedEvent('a', 'ab'.repeat(32), { content: '' });
    await store.updatePublishState('a', 'published', 'space');
    await store.create(
      {
        ...EARLY,
        id: 'n',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        hasVideo: true,
        videoContentType: 'video/mp4',
        eventId: '11'.repeat(32),
        nostrEvent: null,
      },
      undefined,
      video,
    );
    await store.create(
      {
        ...EARLY,
        id: 'z',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        hasVideo: true,
        videoContentType: 'video/mp4',
        eventId: '22'.repeat(32),
        nostrEvent: { content: 1 },
      },
      undefined,
      video,
    );
    const tiedAt = new Date('2026-08-15T00:00:00.000Z');
    await store.create(
      {
        ...EARLY,
        id: 'q',
        createdAt: tiedAt,
        hasVideo: true,
        videoContentType: 'video/mp4',
        eventId: '33'.repeat(32),
        nostrEvent: { content: '' },
      },
      undefined,
      video,
    );
    await store.create(
      {
        ...EARLY,
        id: 'p',
        createdAt: tiedAt,
        hasVideo: true,
        videoContentType: 'video/mp4',
        eventId: '44'.repeat(32),
        nostrEvent: { content: '' },
      },
      undefined,
      video,
    );
    await store.updatePublishState('n', 'published', 'space');
    await store.updatePublishState('p', 'published', 'space');
    await store.updatePublishState('q', 'published', 'space');
    await store.updatePublishState('z', 'published', 'space');
    expect((await store.listSignedMissingVideo(10)).map((row) => row.id)).toEqual([
      'n',
      'a',
      'p',
      'q',
      'z',
    ]);
    await store.create(
      {
        ...EARLY,
        id: 'pending-video',
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        hasVideo: true,
        videoContentType: 'video/mp4',
        eventId: '55'.repeat(32),
        nostrEvent: { content: '' },
      },
      undefined,
      video,
    );
    expect((await store.listSignedMissingVideo(10)).map((row) => row.id)).not.toContain(
      'pending-video',
    );
    await store.addSats('z', 21);
    expect((await store.listSignedMissingVideo(10)).map((row) => row.id)).toEqual([
      'n',
      'a',
      'p',
      'q',
    ]);
    await store.resetSignedEvent('z', '22'.repeat(32));
    expect((await store.getById('z'))?.eventId).toBe('22'.repeat(32));
    await store.resetSignedEvent('a', 'ab'.repeat(32));
    expect((await store.getById('a'))?.eventId).toBeNull();
    expect((await store.getById('a'))?.nostrPublishState).toBe('pending');
    await store.updateSignedEvent('a', 'cd'.repeat(32), {
      content: 'http://127.0.0.1:3000/messages/a/video.mp4',
    });
    expect((await store.listSignedMissingVideo(10)).map((row) => row.id)).toEqual(['n', 'p', 'q']);
    await store.resetSignedEvent('a', 'ff'.repeat(32));
    expect((await store.getById('a'))?.eventId).toBe('cd'.repeat(32));
  });

  it('does not re-queue a published video poster as a missing photo', async () => {
    const store = new InMemoryMessageStore();
    const jpeg: ForumPhoto = {
      contentType: 'image/jpeg',
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    };
    const mp4 = new Uint8Array(32);
    mp4.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    await store.create(
      { ...EARLY, id: 'clip', text: 'clip', hasPhoto: true, hasVideo: true },
      jpeg,
      { contentType: 'video/mp4', bytes: mp4 },
    );
    await store.updateSignedEvent('clip', 'ab'.repeat(32), {
      content: 'clip\nhttp://127.0.0.1:3000/messages/clip/video.mp4',
    });
    await store.updatePublishState('clip', 'published', 'space');
    expect((await store.listSignedMissingPhoto(10)).map((row) => row.id)).not.toContain('clip');
    expect((await store.listSignedMissingVideo(10)).map((row) => row.id)).not.toContain('clip');
  });

  it('listSignedMissingPhoto skips replies', async () => {
    const store = new InMemoryMessageStore();
    const jpeg: ForumPhoto = {
      contentType: 'image/jpeg',
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    };
    await store.create(EARLY);
    await store.create({ ...EARLY, id: 'reply', parentId: 'a', text: '' }, jpeg);
    await store.updateSignedEvent('reply', '99'.repeat(32), { content: 'no url' });
    await store.updatePublishState('reply', 'published', 'space');
    expect((await store.listSignedMissingPhoto(10)).map((row) => row.id)).not.toContain('reply');
  });

  it('listSignedMissingVideo skips replies', async () => {
    const store = new InMemoryMessageStore();
    const mp4 = new Uint8Array(32);
    mp4.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    await store.create(EARLY);
    await store.create(
      { ...EARLY, id: 'reply', parentId: 'a', text: 'clip', hasPhoto: false },
      undefined,
      { contentType: 'video/mp4', bytes: mp4 },
    );
    await store.updateSignedEvent('reply', '99'.repeat(32), { content: 'no url' });
    await store.updatePublishState('reply', 'published', 'space');
    expect((await store.listSignedMissingVideo(10)).map((row) => row.id)).not.toContain('reply');
  });

  it('clearSignedEvent is a no-op when the note already has replies', async () => {
    const store = new InMemoryMessageStore();
    await store.create({
      ...EARLY,
      eventId: 'aa'.repeat(32),
      nostrEvent: { content: 'parent' },
      nostrPublishState: 'pending',
    });
    await store.create({
      ...EARLY,
      id: 'child',
      parentId: 'a',
      eventId: 'bb'.repeat(32),
      text: 'child',
    });
    await store.clearSignedEvent('a', 'aa'.repeat(32));
    const again = await store.getById('a');
    expect(again?.eventId).toBe('aa'.repeat(32));
  });

  it('resetSignedEvent is a no-op when the note already has replies', async () => {
    const store = new InMemoryMessageStore();
    await store.create({
      ...EARLY,
      eventId: 'aa'.repeat(32),
      nostrEvent: { content: 'parent' },
    });
    await store.updatePublishState('a', 'published', 'space');
    await store.create({
      ...EARLY,
      id: 'child',
      parentId: 'a',
      eventId: 'bb'.repeat(32),
      text: 'child',
    });
    await store.resetSignedEvent('a', 'aa'.repeat(32));
    const again = await store.getById('a');
    expect(again?.eventId).toBe('aa'.repeat(32));
    expect(again?.nostrPublishState).toBe('published');
  });

  it('listSignedMissingHashtags skips parents that already have replies', async () => {
    const store = new InMemoryMessageStore();
    await store.create({
      ...EARLY,
      eventId: 'aa'.repeat(32),
      nostrEvent: { content: 'parent without tags' },
    });
    await store.updatePublishState('a', 'published', 'space');
    await store.create({
      ...EARLY,
      id: 'child',
      parentId: 'a',
      eventId: 'bb'.repeat(32),
      text: 'child',
    });
    expect((await store.listSignedMissingHashtags(10)).map((row) => row.id)).not.toContain('a');
  });

  it('listSignedMissingHashtags skips replies', async () => {
    const store = new InMemoryMessageStore();
    await store.create(EARLY);
    await store.create({
      ...EARLY,
      id: 'reply',
      parentId: 'a',
      eventId: '99'.repeat(32),
      nostrEvent: { content: 'child without tags' },
    });
    await store.updatePublishState('reply', 'published', 'space');
    expect((await store.listSignedMissingHashtags(10)).map((row) => row.id)).not.toContain('reply');
  });

  it('listSignedMissingHashtags finds unpaid notes missing Damus hashtags', async () => {
    const store = new InMemoryMessageStore();
    const jpeg: ForumPhoto = {
      contentType: 'image/jpeg',
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    };
    await store.create({ ...EARLY, text: 'ohne foto funktioniert es' });
    await store.updateSignedEvent('a', 'ab'.repeat(32), {
      content: 'ohne foto funktioniert es',
    });
    await store.updatePublishState('a', 'published', 'space');
    await store.create({
      ...EARLY,
      id: 'n',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      eventId: '11'.repeat(32),
      nostrEvent: null,
    });
    await store.updatePublishState('n', 'published', 'space');
    await store.create({
      ...EARLY,
      id: 'z',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      eventId: '22'.repeat(32),
      nostrEvent: { content: 1 },
    });
    await store.updatePublishState('z', 'published', 'space');
    const tiedAt = new Date('2026-08-15T00:00:00.000Z');
    await store.create({
      ...EARLY,
      id: 'q',
      text: 'only bitcoin',
      createdAt: tiedAt,
      eventId: '33'.repeat(32),
      nostrEvent: { content: 'only bitcoin\n\n#bitcoin' },
    });
    await store.updatePublishState('q', 'published', 'space');
    await store.create({
      ...EARLY,
      id: 'p',
      text: 'only 21gifts',
      createdAt: tiedAt,
      eventId: '44'.repeat(32),
      nostrEvent: { content: 'only 21gifts\n\n#21gifts' },
    });
    await store.updatePublishState('p', 'published', 'space');
    await store.create(
      {
        ...EARLY,
        id: 'c',
        text: 'complete',
        createdAt: new Date('2026-08-20T00:00:00.000Z'),
        hasPhoto: true,
        eventId: '55'.repeat(32),
        nostrEvent: {
          content: 'complete\nhttp://127.0.0.1:3000/messages/c/photo\n\n#bitcoin #21gifts',
        },
      },
      jpeg,
    );
    await store.create({
      ...EARLY,
      id: 'pend',
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      eventId: '66'.repeat(32),
      nostrEvent: { content: 'pending without hashtags' },
    });
    await store.create({
      ...EARLY,
      id: 'prefix',
      createdAt: new Date('2026-08-16T00:00:00.000Z'),
      eventId: '77'.repeat(32),
      nostrEvent: { content: 'hello #bitcoiners' },
    });
    await store.updatePublishState('prefix', 'published', 'space');
    expect((await store.listSignedMissingHashtags(10)).map((row) => row.id)).toEqual([
      'n',
      'a',
      'p',
      'q',
      'prefix',
      'z',
    ]);
    expect((await store.listSignedMissingHashtags(2)).map((row) => row.id)).toEqual(['n', 'a']);
    await store.addSats('z', 21);
    expect((await store.listSignedMissingHashtags(10)).map((row) => row.id)).toEqual([
      'n',
      'a',
      'p',
      'q',
      'prefix',
    ]);
    await store.resetSignedEvent('a', 'ab'.repeat(32));
    expect((await store.getById('a'))?.eventId).toBeNull();
    expect((await store.getById('a'))?.nostrPublishState).toBe('pending');
    await store.updateSignedEvent('a', 'cd'.repeat(32), {
      content: 'ohne foto funktioniert es\n\n#bitcoin #21gifts',
    });
    expect((await store.listSignedMissingHashtags(10)).map((row) => row.id)).toEqual([
      'n',
      'p',
      'q',
      'prefix',
    ]);
  });

  it('listSignedMissingHashtags lists notes missing an extra location hashtag', async () => {
    const store = new InMemoryMessageStore();
    await store.create({
      ...EARLY,
      text: 'x',
      eventId: 'ab'.repeat(32),
      nostrEvent: { content: 'x\n\n#bitcoin #21gifts' },
    });
    await store.updatePublishState('a', 'published', 'space');
    await store.create({
      ...EARLY,
      id: 'damus',
      accountId: null,
      text: 'x',
      eventId: 'cc'.repeat(32),
      nostrEvent: { content: 'x\n\n#bitcoin #21gifts' },
    });
    await store.updatePublishState('damus', 'published', 'space');
    expect((await store.listSignedMissingHashtags(10)).map((row) => row.id)).not.toContain('a');
    expect(
      (await store.listSignedMissingHashtags(10, new Map([['acc', ['Berlin']]]))).map(
        (row) => row.id,
      ),
    ).toEqual(['a']);
    await store.updateSignedEvent('a', 'ab'.repeat(32), {
      content: 'x\n\n#bitcoin #21gifts #Berlin',
    });
    expect(
      (await store.listSignedMissingHashtags(10, new Map([['acc', ['Berlin']]]))).map(
        (row) => row.id,
      ),
    ).not.toContain('a');
  });

  it('listSignedMissingHashtags applies excludeIds before the limit', async () => {
    const store = new InMemoryMessageStore();
    await store.create({
      ...EARLY,
      id: 'profile',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      text: 'x',
      eventId: 'aa'.repeat(32),
      nostrEvent: { content: 'x\n\n#bitcoin #21gifts' },
    });
    await store.updatePublishState('profile', 'published', 'space');
    await store.create({
      ...EARLY,
      text: 'x',
      eventId: 'ab'.repeat(32),
      nostrEvent: { content: 'x\n\n#bitcoin #21gifts' },
    });
    await store.updatePublishState('a', 'published', 'space');
    expect(
      (await store.listSignedMissingHashtags(10, new Map([['acc', ['Berlin']]]))).map(
        (row) => row.id,
      ),
    ).toEqual(['profile', 'a']);
    expect(
      (
        await store.listSignedMissingHashtags(
          1,
          new Map([['acc', ['Berlin']]]),
          new Set(['profile']),
        )
      ).map((row) => row.id),
    ).toEqual(['a']);
  });

  it('listPendingSigned skips pending rows that already have t=bitcoin', async () => {
    const store = new InMemoryMessageStore();
    await store.create(LATE);
    await store.create(EARLY);
    await store.create(TIE_HIGH);
    await store.create(TIE_LOW);
    await store.updateSignedEvent('b', '11'.repeat(32), {
      tags: [
        ['t', 'bitcoin'],
        ['t', '21gifts'],
      ],
    });
    await store.updateSignedEvent('a', '22'.repeat(32), {
      tags: [['t', '21gifts']],
    });
    await store.updateSignedEvent('z', '33'.repeat(32), {
      tags: [['t', '21gifts']],
    });
    await store.updateSignedEvent('m', '44'.repeat(32), {
      tags: [['t', '21gifts']],
    });
    expect((await store.listPendingSigned(10)).map((row) => row.id)).toEqual(['a', 'm', 'z']);
  });

  it('create with photo lists hasPhoto true without exposing bytes', async () => {
    const store = new InMemoryMessageStore();
    const created = await store.create({ ...EARLY, text: '' }, JPEG);
    expect(created.hasPhoto).toBe(true);
    const listed = await store.listLatest(10);
    expect(listed[0]?.hasPhoto).toBe(true);
    expect(listed[0]).not.toHaveProperty('bytes');
    expect(listed[0]).not.toHaveProperty('photo');
    const photo = await store.getPhoto('a');
    expect(photo).toEqual(JPEG);
    if (photo !== null) {
      photo.bytes[0] = 0;
    }
    const again = await store.getPhoto('a');
    expect(again?.bytes[0]).toBe(0xff);
  });

  it('create with two stills stores photo 0 and extra index 1', async () => {
    const store = new InMemoryMessageStore();
    const created = await store.create({ ...EARLY, text: '' }, JPEG, undefined, [JPEG2]);
    expect(created.photoCount).toBe(2);
    expect(created.hasPhoto).toBe(true);
    expect(await store.getPhoto('a')).toEqual(JPEG);
    expect(await store.getExtraPhoto('a', 1)).toEqual(JPEG2);
    expect(await store.getExtraPhoto('a', 0)).toBeNull();
    expect(await store.getExtraPhoto('a', 10)).toBeNull();
    const listed = await store.listExtraPhotos('a');
    expect(listed).toEqual([JPEG2]);
    listed[0]!.bytes[0] = 0;
    expect((await store.getExtraPhoto('a', 1))?.bytes[0]).toBe(0xff);
  });

  it('deleteById clears extra stills', async () => {
    const store = new InMemoryMessageStore();
    await store.create({ ...EARLY, text: '' }, JPEG, undefined, [JPEG2]);
    expect(await store.deleteById('a')).toBe(true);
    expect(await store.getExtraPhoto('a', 1)).toBeNull();
    expect(await store.listExtraPhotos('a')).toEqual([]);
  });

  it('throws when extras are set without photo 0', async () => {
    const store = new InMemoryMessageStore();
    await expect(
      store.create({ ...EARLY, id: 'no-zero', text: '' }, undefined, undefined, [JPEG2]),
    ).rejects.toThrow('extra photos require photo 0');
  });

  it('ignores extras when a video is set', async () => {
    const store = new InMemoryMessageStore();
    const mp4 = new Uint8Array(32);
    mp4.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    const created = await store.create(
      { ...EARLY, id: 'clip-x', text: 'clip' },
      JPEG,
      { contentType: 'video/mp4', bytes: mp4 },
      [JPEG2],
    );
    expect(created.hasPhoto).toBe(true);
    expect(created.photoCount).toBe(1);
    expect(await store.listExtraPhotos('clip-x')).toEqual([]);
  });

  it('create with text and photo keeps both', async () => {
    const store = new InMemoryMessageStore();
    const created = await store.create({ ...EARLY, hasPhoto: true }, JPEG);
    expect(created.text).toBe('first');
    expect(created.hasPhoto).toBe(true);
    expect((await store.listLatest(10))[0]).toMatchObject({
      id: 'a',
      text: 'first',
      hasPhoto: true,
    });
    expect(await store.getPhoto('a')).toEqual(JPEG);
  });

  it('getPhoto returns null for an unknown id', async () => {
    expect(await new InMemoryMessageStore().getPhoto('missing')).toBeNull();
  });

  it('recordInvoiceAttempt lists newest-first and copies rows', async () => {
    const store = new InMemoryMessageStore();
    const early: MessageInvoiceAttempt = {
      id: 'inv-a',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      messageId: 'm1',
      payerAccountId: 'payer',
      authorAccountId: 'author',
      amountSats: 21,
      lightningAddress: 'a@b.com',
      zapRequest: { kind: 9734 },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc1',
      paymentHash: 'aa'.repeat(32),
      description: null,
      descriptionHash: 'bb'.repeat(32),
      isNip57Invoice: true,
      lnurlResponse: { pr: 'lnbc1', status: 'OK' },
    };
    const late: MessageInvoiceAttempt = {
      ...early,
      id: 'inv-b',
      createdAt: new Date('2026-08-02T00:00:00.000Z'),
      result: 'noZap',
      httpStatus: 400,
      pr: null,
      isNip57Invoice: false,
      lnurlResponse: null,
    };
    const tieHigh: MessageInvoiceAttempt = {
      ...early,
      id: 'inv-z',
      createdAt: new Date('2026-08-02T00:00:00.000Z'),
      result: 'unreachable',
      lnurlResponse: { error: 'down' },
    };
    await store.recordInvoiceAttempt(early);
    await store.recordInvoiceAttempt(late);
    await store.recordInvoiceAttempt(tieHigh);
    const listed = await store.listInvoiceAttempts(2);
    expect(listed.map((row) => row.id)).toEqual(['inv-z', 'inv-b']);
    if (listed[0] !== undefined) {
      listed[0].result = 'bad_body';
      listed[0].zapRequest = { mutated: true };
      if (listed[0].lnurlResponse !== null) {
        listed[0].lnurlResponse['mutated'] = true;
      }
    }
    const again = await store.listInvoiceAttempts(10);
    expect(again.map((row) => row.id)).toEqual(['inv-z', 'inv-b', 'inv-a']);
    expect(again[0]?.result).toBe('unreachable');
    expect(again[0]?.zapRequest).toEqual({ kind: 9734 });
    expect(again[0]?.lnurlResponse).toEqual({ error: 'down' });
    expect(again[2]?.lnurlResponse).toEqual({ pr: 'lnbc1', status: 'OK' });
  });

  it('recordZapIngest lists newest-first and copies rows', async () => {
    const store = new InMemoryMessageStore();
    const early: ZapIngestRow = {
      id: 'zi-a',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      receiptId: 'r1',
      noteEventId: 'ee'.repeat(32),
      messageId: 'm1',
      outcome: 'rejected',
      reason: 'sig',
      amountSats: null,
      receiptPubkey: 'aa'.repeat(32),
      receipt: { id: 'r1', kind: 9735 },
    };
    const late: ZapIngestRow = {
      ...early,
      id: 'zi-b',
      createdAt: new Date('2026-08-02T00:00:00.000Z'),
      outcome: 'indexed',
      reason: null,
      amountSats: 21,
      receipt: { id: 'r2', kind: 9735 },
    };
    const tieHigh: ZapIngestRow = {
      ...late,
      id: 'zi-z',
      receipt: { id: 'r3', kind: 9735 },
    };
    await store.recordZapIngest(early);
    await store.recordZapIngest(late);
    await store.recordZapIngest(tieHigh);
    const listed = await store.listZapIngests(1);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe('zi-z');
    if (listed[0] !== undefined) {
      listed[0].outcome = 'rejected';
      listed[0].receipt['mutated'] = true;
    }
    const again = await store.listZapIngests(10);
    expect(again.map((row) => row.id)).toEqual(['zi-z', 'zi-b', 'zi-a']);
    expect(again[0]?.outcome).toBe('indexed');
    expect(again[0]?.receipt).toEqual({ id: 'r3', kind: 9735 });
  });

  it('listInvoiceAttemptsForPayer filters the payer and returns every matching row', async () => {
    const store = new InMemoryMessageStore();
    const base: MessageInvoiceAttempt = {
      id: 'inv-a',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      messageId: 'm1',
      payerAccountId: 'payer',
      authorAccountId: 'author',
      amountSats: 21,
      lightningAddress: 'a@b.com',
      zapRequest: null,
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc1',
      paymentHash: 'aa'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
    };
    await store.recordInvoiceAttempt(base);
    await store.recordInvoiceAttempt({
      ...base,
      id: 'inv-b',
      createdAt: new Date('2026-08-02T00:00:00.000Z'),
    });
    await store.recordInvoiceAttempt({
      ...base,
      id: 'inv-c',
      createdAt: new Date('2026-08-03T00:00:00.000Z'),
    });
    await store.recordInvoiceAttempt({ ...base, id: 'inv-other', payerAccountId: 'other' });
    const listed = await store.listInvoiceAttemptsForPayer('payer');
    expect(listed.map((row) => row.id)).toEqual(['inv-c', 'inv-b', 'inv-a']);
    expect(listed).toHaveLength(3);
  });

  it('listInvoiceAttemptsForPayer ties on createdAt are ordered by id desc', async () => {
    const store = new InMemoryMessageStore();
    const at = new Date('2026-08-01T00:00:00.000Z');
    const base: MessageInvoiceAttempt = {
      id: 'inv-a',
      createdAt: at,
      messageId: 'm1',
      payerAccountId: 'payer',
      authorAccountId: 'author',
      amountSats: 21,
      lightningAddress: 'a@b.com',
      zapRequest: null,
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc1',
      paymentHash: 'aa'.repeat(32),
      description: null,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
    };
    await store.recordInvoiceAttempt({ ...base, id: 'inv-a' });
    await store.recordInvoiceAttempt({ ...base, id: 'inv-b' });
    const listed = await store.listInvoiceAttemptsForPayer('payer');
    expect(listed.map((row) => row.id)).toEqual(['inv-b', 'inv-a']);
  });

  it('listIndexedZapIngests returns indexed rows only, uncapped', async () => {
    const store = new InMemoryMessageStore();
    const base: ZapIngestRow = {
      id: 'zi-a',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      receiptId: 'r1',
      noteEventId: 'ee'.repeat(32),
      messageId: 'm1',
      outcome: 'indexed',
      reason: null,
      amountSats: 21,
      receiptPubkey: 'aa'.repeat(32),
      receipt: { id: 'r1' },
    };
    await store.recordZapIngest(base);
    await store.recordZapIngest({
      ...base,
      id: 'zi-b',
      createdAt: new Date('2026-08-02T00:00:00.000Z'),
      receiptId: 'r2',
    });
    await store.recordZapIngest({
      ...base,
      id: 'zi-rej',
      outcome: 'rejected',
      reason: 'sig',
      receiptId: 'r3',
    });
    const listed = await store.listIndexedZapIngests();
    expect(listed.map((row) => row.id)).toEqual(['zi-b', 'zi-a']);
    expect(listed.every((row) => row.outcome === 'indexed')).toBe(true);
  });

  it('listIndexedZapIngests ties on createdAt are ordered by id desc', async () => {
    const store = new InMemoryMessageStore();
    const at = new Date('2026-08-01T00:00:00.000Z');
    const base: ZapIngestRow = {
      id: 'zi-a',
      createdAt: at,
      receiptId: 'r1',
      noteEventId: 'ee'.repeat(32),
      messageId: 'm1',
      outcome: 'indexed',
      reason: null,
      amountSats: 21,
      receiptPubkey: 'aa'.repeat(32),
      receipt: { id: 'r1' },
    };
    await store.recordZapIngest({ ...base, id: 'zi-a', receiptId: 'r1' });
    await store.recordZapIngest({ ...base, id: 'zi-b', receiptId: 'r2' });
    const listed = await store.listIndexedZapIngests();
    expect(listed.map((row) => row.id)).toEqual(['zi-b', 'zi-a']);
  });

  it('listAuthoredMessages includes hidden rows, excludes other accounts, and has no cap', async () => {
    const store = new InMemoryMessageStore();
    await store.create({ ...EARLY, id: 'live' });
    await store.create({ ...LATE, id: 'hidden' });
    await store.create({ ...TIE_HIGH, id: 'other', accountId: 'other' });
    await store.create({ ...EARLY, id: 'reply', parentId: 'live', text: 'child' });
    expect(await store.markDeleted('hidden', new Date('2026-09-01T00:00:00.000Z'), 'staff')).toBe(
      true,
    );
    const listed = await store.listAuthoredMessages('acc');
    expect(listed.map((row) => row.id)).toEqual(['hidden', 'reply', 'live']);
    expect(listed.find((row) => row.id === 'hidden')?.deletedAt).not.toBeNull();
    expect(listed.some((row) => row.accountId === 'other')).toBe(false);
  });
});

describe('PostgresMessageStore', () => {
  it('listDirectChildren selects every child of parent_id including hidden', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    expect(await new PostgresMessageStore(sql).listDirectChildren('parent')).toEqual([]);
    expect(sql.queries[0]?.text).toMatch(/SELECT /);
    expect(sql.queries[0]?.text).toMatch(/FROM message WHERE parent_id = \$1/);
    expect(sql.queries[0]?.text).toMatch(/ORDER BY created_at ASC, id ASC/);
    expect(sql.queries[0]?.text).not.toMatch(/deleted_at IS NULL/);
    expect(sql.queries[0]?.params).toEqual(['parent']);
  });

  it('accountHasLivePost queries live message rows for the account', async () => {
    const sql = new MockSql();
    const store = new PostgresMessageStore(sql);
    sql.nextRows = [];
    expect(await store.accountHasLivePost('acc', null)).toBe(false);
    expect(sql.queries[0]?.text).toMatch(/FROM message/);
    expect(sql.queries[0]?.text).toMatch(/account_id = \$1/);
    expect(sql.queries[0]?.text).toMatch(/deleted_at IS NULL/);
    expect(sql.queries[0]?.params).toEqual(['acc', null]);
    sql.nextRows = [{ '?column?': 1 }];
    expect(await store.accountHasLivePost('acc', null)).toBe(true);
    expect(await store.accountHasLivePost('acc', 'prof')).toBe(true);
    expect(sql.queries[2]?.params).toEqual(['acc', 'prof']);
  });

  it('accountHasLiveTopLevelPost queries live top-level message rows for the account', async () => {
    const sql = new MockSql();
    const store = new PostgresMessageStore(sql);
    sql.nextRows = [];
    expect(await store.accountHasLiveTopLevelPost('acc', null)).toBe(false);
    expect(sql.queries[0]?.text).toMatch(/FROM message/);
    expect(sql.queries[0]?.text).toMatch(/account_id = \$1/);
    expect(sql.queries[0]?.text).toMatch(/deleted_at IS NULL/);
    expect(sql.queries[0]?.text).toMatch(/parent_id IS NULL/);
    expect(sql.queries[0]?.text).toMatch(/\$2::uuid IS NULL OR id <> \$2::uuid/);
    expect(sql.queries[0]?.params).toEqual(['acc', null]);
    sql.nextRows = [{ '?column?': 1 }];
    expect(await store.accountHasLiveTopLevelPost('acc', null)).toBe(true);
    expect(await store.accountHasLiveTopLevelPost('acc', 'prof')).toBe(true);
    expect(sql.queries[2]?.params).toEqual(['acc', 'prof']);
  });

  it('countByAccount aggregates live posts and replies for the account', async () => {
    const sql = new MockSql();
    const store = new PostgresMessageStore(sql);
    sql.nextRows = [];
    expect(await store.countByAccount('acc')).toEqual({ postCount: 0, replyCount: 0 });
    expect(sql.queries[0]?.text).toMatch(/account_id = \$1/);
    expect(sql.queries[0]?.text).toMatch(/deleted_at IS NULL/);
    expect(sql.queries[0]?.text).toMatch(/FILTER \(WHERE parent_id IS NULL\)/);
    expect(sql.queries[0]?.text).toMatch(/FILTER \(WHERE parent_id IS NOT NULL\)/);
    expect(sql.queries[0]?.params).toEqual(['acc']);
    sql.nextRows = [{ post_count: '3', reply_count: '12' }];
    expect(await store.countByAccount('acc')).toEqual({ postCount: 3, replyCount: 12 });
  });

  it('listPostsByAccount selects live top-level notes for the account with replyCount', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'm1',
        account_id: 'acc',
        name: 'Ada',
        text: 'hi',
        created_at: new Date('2026-08-28T12:00:00.000Z'),
        has_photo: false,
        reply_count: '2',
      },
    ];
    const store = new PostgresMessageStore(sql);
    const listed = await store.listPostsByAccount('acc', 50);
    expect(sql.queries[0]?.text).toMatch(/account_id = \$1/);
    expect(sql.queries[0]?.text).toMatch(/deleted_at IS NULL/);
    expect(sql.queries[0]?.text).toMatch(/parent_id IS NULL/);
    expect(sql.queries[0]?.text).toMatch(/reply_count/);
    expect(sql.queries[0]?.text).toMatch(
      /child\.account_id IS NOT NULL OR \(child\.author_pubkey IS NOT NULL AND EXISTS \(SELECT 1 FROM nostr_zapper/,
    );
    expect(sql.queries[0]?.text).toMatch(/ORDER BY created_at DESC, id DESC/);
    expect(sql.queries[0]?.params).toEqual(['acc', 50]);
    expect(listed[0]?.id).toBe('m1');
    expect(listed[0]?.replyCount).toBe(2);
    sql.nextRows = [
      {
        id: 'm2',
        account_id: 'acc',
        name: 'Ada',
        text: 'no count',
        created_at: new Date('2026-08-28T12:00:00.000Z'),
        has_photo: false,
      },
    ];
    const listedNull = await store.listPostsByAccount('acc', 10);
    expect(listedNull[0]?.replyCount).toBe(0);
  });

  it('listRepliesByAccount selects live replies for the account newest-first', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'r1',
        account_id: 'acc',
        name: 'Ada',
        text: 'hi',
        created_at: new Date(0),
        has_photo: false,
        parent_id: 'm1',
      },
    ];
    const store = new PostgresMessageStore(sql);
    const listed = await store.listRepliesByAccount('acc', 50);
    expect(sql.queries[0]?.text).toMatch(/account_id = \$1/);
    expect(sql.queries[0]?.text).toMatch(/deleted_at IS NULL/);
    expect(sql.queries[0]?.text).toMatch(/parent_id IS NOT NULL/);
    expect(sql.queries[0]?.text).toMatch(/ORDER BY created_at DESC, id DESC/);
    expect(sql.queries[0]?.params).toEqual(['acc', 50]);
    expect(listed[0]?.id).toBe('r1');
    expect(listed[0]?.parentId).toBe('m1');
    expect(listed[0]).not.toHaveProperty('replyCount');
  });

  it('maps rows with has_photo and uses list SQL without selecting photo bytes', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'm1',
        account_id: 'acc',
        name: 'Ada',
        text: 'hi',
        created_at: new Date('2026-08-28T12:00:00.000Z'),
        has_photo: true,
        video_content_type: 'video/mp4',
      },
      {
        id: 'm2',
        account_id: 'acc',
        name: 'Bob',
        text: 'yo',
        created_at: '2026-08-27T12:00:00.000Z',
        has_photo: false,
        video_content_type: '',
      },
    ];
    const store = new PostgresMessageStore(sql);
    const listed = await store.listLatest(50);
    expect(sql.queries[0]?.text).toMatch(/has_photo/);
    expect(sql.queries[0]?.text).toMatch(/event_id/);
    expect(sql.queries[0]?.text).toMatch(/parent_id IS NULL AND deleted_at IS NULL/);
    expect(sql.queries[0]?.text).toMatch(/reply_count/);
    expect(sql.queries[0]?.text).toMatch(/child\.deleted_at IS NULL/);
    expect(sql.queries[0]?.text).toMatch(
      /child\.account_id IS NOT NULL OR \(child\.author_pubkey IS NOT NULL AND EXISTS \(SELECT 1 FROM nostr_zapper/,
    );
    expect(sql.queries[0]?.text).toMatch(/ORDER BY created_at DESC, id DESC\s+LIMIT \$1/);
    expect(sql.queries[0]?.text).not.toMatch(/SELECT[^;]*\bphoto\b(?!\s+IS\s+NOT\s+NULL)/i);
    expect(sql.queries[0]?.params).toEqual([50]);
    expect(listed[0]?.id).toBe('m1');
    expect(listed[0]?.hasPhoto).toBe(true);
    expect(listed[0]?.hasVideo).toBe(true);
    expect(listed[0]?.sats).toBe(0);
    expect(listed[0]?.replyCount).toBe(0);
    expect(listed[1]?.id).toBe('m2');
    expect(listed[1]?.hasPhoto).toBe(false);
    expect(listed[1]?.hasVideo).toBe(false);
  });

  it('listDebug selects all rows newest-first including hidden and replies', async () => {
    const sql = new MockSql();
    const hiddenAt = new Date('2026-09-01T00:00:00.000Z');
    sql.nextRows = [
      {
        id: 'reply',
        account_id: 'acc',
        name: 'Ada',
        text: 'child',
        created_at: new Date('2026-08-03T00:00:00.000Z'),
        has_photo: false,
        parent_id: 'hidden',
        deleted_at: null,
        deleted_by: null,
      },
      {
        id: 'hidden',
        account_id: 'acc',
        name: 'Ada',
        text: 'hidden',
        created_at: new Date('2026-08-02T00:00:00.000Z'),
        has_photo: false,
        parent_id: null,
        deleted_at: hiddenAt,
        deleted_by: 'staff',
      },
    ];
    const store = new PostgresMessageStore(sql);
    const listed = await store.listDebug(200);
    expect(sql.queries[0]?.text).toMatch(
      /FROM message ORDER BY created_at DESC, id DESC LIMIT \$1/,
    );
    expect(sql.queries[0]?.text).not.toMatch(/FROM message WHERE/);
    expect(sql.queries[0]?.text).not.toMatch(/SELECT[^;]*\bphoto\b(?!\s+IS\s+NOT\s+NULL)/i);
    expect(sql.queries[0]?.params).toEqual([200]);
    expect(listed.map((row) => row.id)).toEqual(['reply', 'hidden']);
    expect(listed[0]?.parentId).toBe('hidden');
    expect(listed[1]?.deletedAt?.toISOString()).toBe(hiddenAt.toISOString());
    expect(listed[1]?.deletedBy).toBe('staff');
  });

  it('listHidden returns [] when empty', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    const listed = await new PostgresMessageStore(sql).listHidden(200);
    expect(sql.queries[0]?.text).toMatch(
      /FROM message WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC LIMIT \$1/,
    );
    expect(sql.queries[0]?.params).toEqual([200]);
    expect(listed).toEqual([]);
  });

  it('listHidden selects only hidden rows newest-hidden-first including replies', async () => {
    const sql = new MockSql();
    const later = new Date('2026-09-02T00:00:00.000Z');
    const earlier = new Date('2026-09-01T00:00:00.000Z');
    sql.nextRows = [
      {
        id: 'zb',
        account_id: 'acc',
        name: 'Ada',
        text: 'newer',
        created_at: new Date('2026-08-02T00:00:00.000Z'),
        has_photo: false,
        parent_id: null,
        deleted_at: later,
        deleted_by: 'staff',
      },
      {
        id: 'za',
        account_id: 'acc',
        name: 'Ada',
        text: 'tie',
        created_at: new Date('2026-08-02T00:00:00.000Z'),
        has_photo: false,
        parent_id: null,
        deleted_at: later,
        deleted_by: 'staff',
      },
      {
        id: 'reply',
        account_id: 'acc',
        name: 'Ada',
        text: 'child',
        created_at: new Date('2026-08-03T00:00:00.000Z'),
        has_photo: false,
        parent_id: 'zb',
        deleted_at: earlier,
        deleted_by: 'staff',
      },
    ];
    const store = new PostgresMessageStore(sql);
    const listed = await store.listHidden(200);
    expect(sql.queries[0]?.text).toMatch(
      /FROM message WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC LIMIT \$1/,
    );
    expect(sql.queries[0]?.text).not.toMatch(/SELECT[^;]*\bphoto\b(?!\s+IS\s+NOT\s+NULL)/i);
    expect(sql.queries[0]?.params).toEqual([200]);
    expect(listed.map((row) => row.id)).toEqual(['zb', 'za', 'reply']);
    expect(listed[2]?.parentId).toBe('zb');
    expect(listed[0]?.deletedAt?.toISOString()).toBe(later.toISOString());
    expect(listed[0]?.deletedBy).toBe('staff');
  });

  it('listHidden caps at limit', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'only',
        account_id: 'acc',
        name: 'Ada',
        text: 'hidden',
        created_at: new Date('2026-08-02T00:00:00.000Z'),
        has_photo: false,
        deleted_at: new Date('2026-09-01T00:00:00.000Z'),
        deleted_by: 'staff',
      },
    ];
    const listed = await new PostgresMessageStore(sql).listHidden(1);
    expect(sql.queries[0]?.params).toEqual([1]);
    expect(listed.map((row) => row.id)).toEqual(['only']);
  });

  it('listHidden copies photo and video flags without selecting photo bytes', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'photo',
        account_id: 'acc',
        name: 'Ada',
        text: '',
        created_at: new Date('2026-08-01T00:00:00.000Z'),
        has_photo: true,
        video_content_type: null,
        deleted_at: new Date('2026-09-01T00:00:00.000Z'),
        deleted_by: 'staff',
      },
      {
        id: 'vid',
        account_id: 'acc',
        name: 'Ada',
        text: 'clip',
        created_at: new Date('2026-08-02T00:00:00.000Z'),
        has_photo: false,
        video_content_type: 'video/mp4',
        deleted_at: new Date('2026-09-01T00:00:00.000Z'),
        deleted_by: 'staff',
      },
    ];
    const listed = await new PostgresMessageStore(sql).listHidden(10);
    expect(sql.queries[0]?.text).not.toMatch(/SELECT[^;]*\bphoto\b(?!\s+IS\s+NOT\s+NULL)/i);
    expect(listed[0]?.hasPhoto).toBe(true);
    expect(listed[0]).not.toHaveProperty('bytes');
    expect(listed[0]).not.toHaveProperty('photo');
    expect(listed[1]?.hasVideo).toBe(true);
    expect(listed[1]?.videoContentType).toBe('video/mp4');
  });

  it('create binds fifteen params including content_fp, video_content_type, parent_id and author_pubkey', async () => {
    const sql = new MockSql();
    const store = new PostgresMessageStore(sql);
    const row: MessageRow = {
      id: 'm1',
      accountId: 'acc',
      name: 'Ada',
      text: 'hello',
      createdAt: new Date('2026-08-28T12:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    };
    const created = await store.create(row);
    expect(sql.executes[0]?.text).toMatch(
      /INSERT INTO message \(\s*id, account_id, name, text, photo, photo_content_type, video_content_type, created_at,\s*nostr_publish_state, sats, parent_id, author_pubkey, event_id, nostr_event, content_fp\s*\)/,
    );
    expect(sql.executes[0]?.text).toMatch(/\$14::jsonb,\$15/);
    expect(sql.executes[0]?.text).not.toMatch(/ON CONFLICT/i);
    expect(sql.executes[0]?.params).toEqual([
      'm1',
      'acc',
      'Ada',
      'hello',
      null,
      null,
      null,
      row.createdAt,
      'pending',
      0,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(sql.executes[0]?.params).toHaveLength(15);
    expect(created.id).toBe(row.id);
    expect(created.hasVideo).toBe(false);
    expect(created).not.toBe(row);
  });

  it('create with non-null parentId uses INSERT SELECT WHERE EXISTS on a live parent', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ id: 'child-1' }];
    const store = new PostgresMessageStore(sql);
    const row: MessageRow = {
      id: 'child-1',
      accountId: 'acc',
      name: 'Ada',
      text: 'reply',
      createdAt: new Date('2026-08-28T12:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: 'parent-1',
    };
    const created = await store.create(row);
    expect(sql.executes).toEqual([]);
    expect(sql.queries[0]?.text).toMatch(
      /INSERT INTO message \(\s*id, account_id, name, text, photo, photo_content_type, video_content_type, created_at,\s*nostr_publish_state, sats, parent_id, author_pubkey, event_id, nostr_event, content_fp\s*\)/,
    );
    expect(sql.queries[0]?.text).toMatch(
      /SELECT \$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,\$9,\$10,\$11,\$12,\$13,\$14::jsonb,\$15/,
    );
    expect(sql.queries[0]?.text).toMatch(
      /WHERE EXISTS \(SELECT 1 FROM message p WHERE p\.id = \$11 AND p\.deleted_at IS NULL\)/,
    );
    expect(sql.queries[0]?.text).toMatch(/RETURNING id/);
    expect(sql.queries[0]?.text).not.toMatch(/ON CONFLICT/i);
    expect(sql.queries[0]?.params).toEqual([
      'child-1',
      'acc',
      'Ada',
      'reply',
      null,
      null,
      null,
      row.createdAt,
      'pending',
      0,
      'parent-1',
      null,
      null,
      null,
      null,
    ]);
    expect(sql.queries[0]?.params).toHaveLength(15);
    expect(created.id).toBe('child-1');
    expect(created.parentId).toBe('parent-1');
  });

  it('create with non-null parentId throws when the query returns zero rows and unlinks video', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    const mp4 = new Uint8Array(32);
    mp4.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    await expect(
      new PostgresMessageStore(sql).create(
        {
          id: 'm-reply-dead-parent',
          accountId: 'acc',
          name: 'Ada',
          text: 'clip',
          createdAt: new Date(0),
          hasPhoto: false,
          ...unsignedNostrDefaults(),
          parentId: 'missing-parent',
        },
        undefined,
        { contentType: 'video/mp4', bytes: mp4 },
      ),
    ).rejects.toThrow('parent missing or deleted');
    expect(sql.executes).toEqual([]);
    expect(sql.queries[0]?.text).toMatch(
      /WHERE EXISTS \(SELECT 1 FROM message p WHERE p\.id = \$11 AND p\.deleted_at IS NULL\)/,
    );
    await expect(
      readFile(videoFilePath(resolveMediaDir(), 'm-reply-dead-parent', 'video/mp4')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('create with non-null parentId returns getById on a 0-row insert when the id exists', async () => {
    const sql = new MockSql();
    sql.queryQueue = [
      [],
      [
        {
          id: 'c-hit',
          account_id: 'acc',
          name: 'Ada',
          text: 'reply',
          created_at: new Date(0),
          has_photo: false,
          parent_id: 'p-hit',
          event_id: null,
          nostr_publish_state: 'pending',
          sats: 0,
        },
      ],
    ];
    const created = await new PostgresMessageStore(sql).create({
      id: 'c-hit',
      accountId: 'acc',
      name: 'Ada',
      text: 'other',
      createdAt: new Date(0),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: 'p-hit',
    });
    expect(created.id).toBe('c-hit');
    expect(created.text).toBe('reply');
    expect(created.parentId).toBe('p-hit');
    expect(sql.queries).toHaveLength(2);
    expect(sql.executes).toEqual([]);
  });

  it('create binds Uint8Array photo bytes', async () => {
    const sql = new MockSql();
    const store = new PostgresMessageStore(sql);
    const row: MessageRow = {
      id: 'm1',
      accountId: 'acc',
      name: 'Ada',
      text: '',
      createdAt: new Date('2026-08-28T12:00:00.000Z'),
      hasPhoto: true,
      ...unsignedNostrDefaults(),
    };
    await store.create(row, JPEG);
    expect(sql.executes[0]?.params[4]).toEqual(JPEG.bytes);
    expect(sql.executes[0]?.params[5]).toBe('image/jpeg');
    expect(sql.executes[0]?.params[14]).toBe(forumContentFingerprint('', JPEG.bytes));
  });

  it('findLiveByAccountContent SQL matches account, parent, and content_fp', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    const store = new PostgresMessageStore(sql);
    expect(await store.findLiveByAccountContent('acc', null, 'ab'.repeat(32))).toBeUndefined();
    expect(sql.queries[0]?.text).toMatch(/content_fp = \$3/);
    expect(sql.queries[0]?.text).toMatch(/\$2::uuid IS NULL AND parent_id IS NULL/);
    expect(sql.queries[0]?.text).toMatch(/parent_id IS NOT DISTINCT FROM \$2/);
    expect(sql.queries[0]?.text).toMatch(/ORDER BY created_at ASC, id ASC/);
    expect(sql.queries[0]?.params).toEqual(['acc', null, 'ab'.repeat(32)]);
  });

  it('create on 23505 returns the existing live row and unlinks the new video', async () => {
    const sql = new MockSql();
    const existingId = 'existing-id';
    sql.executeError = Object.assign(new Error('duplicate key'), { code: '23505' });
    sql.nextRows = [
      {
        id: existingId,
        account_id: 'acc',
        name: 'Ada',
        text: 'clip',
        created_at: new Date('2026-08-28T12:00:00.000Z'),
        has_photo: false,
        video_content_type: 'video/mp4',
        event_id: null,
        nostr_publish_state: 'pending',
        sats: 0,
      },
    ];
    const mp4 = new Uint8Array(32);
    mp4.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    const created = await new PostgresMessageStore(sql).create(
      {
        id: 'm-new',
        accountId: 'acc',
        name: 'Ada',
        text: 'clip',
        createdAt: new Date(0),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      undefined,
      { contentType: 'video/mp4', bytes: mp4 },
    );
    expect(created.id).toBe(existingId);
    await expect(
      readFile(videoFilePath(resolveMediaDir(), 'm-new', 'video/mp4')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('create on 23505 returns the row when getById finds the same id', async () => {
    const sql = new MockSql();
    sql.executeError = Object.assign(new Error('duplicate key'), { code: '23505' });
    sql.nextRows = [
      {
        id: 'm1',
        account_id: 'acc',
        name: 'Ada',
        text: 'hi',
        created_at: new Date(0),
        has_photo: false,
        event_id: null,
        nostr_publish_state: 'pending',
        sats: 0,
      },
    ];
    const created = await new PostgresMessageStore(sql).create({
      id: 'm1',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(0),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    expect(created.id).toBe('m1');
  });

  it('create on 23505 does not INSERT extras when getById finds the same id', async () => {
    const sql = new MockSql();
    sql.executeError = Object.assign(new Error('duplicate key'), { code: '23505' });
    sql.nextRows = [
      {
        id: 'm1',
        account_id: 'acc',
        name: 'Ada',
        text: 'hi',
        created_at: new Date(0),
        has_photo: true,
        event_id: null,
        nostr_publish_state: 'pending',
        sats: 0,
      },
    ];
    const row: MessageRow = {
      id: 'm1',
      accountId: 'acc',
      name: 'Ada',
      text: '',
      createdAt: new Date(0),
      hasPhoto: true,
      ...unsignedNostrDefaults(),
    };
    const created = await new PostgresMessageStore(sql).create(row, JPEG, undefined, [JPEG2]);
    expect(created.id).toBe('m1');
    expect(sql.executes).toHaveLength(1);
    expect(sql.executes[0]?.text).toMatch(/INSERT INTO message \(/);
    expect(sql.executes.some((item) => /INSERT INTO message_extra_photo/.test(item.text))).toBe(
      false,
    );
  });

  it('create on Bun errno 23505 returns the row when getById finds the same id', async () => {
    const sql = new MockSql();
    sql.executeError = Object.assign(new Error('duplicate key'), { errno: '23505' });
    sql.nextRows = [
      {
        id: 'm1',
        account_id: 'acc',
        name: 'Ada',
        text: 'hi',
        created_at: new Date(0),
        has_photo: false,
        event_id: null,
        nostr_publish_state: 'pending',
        sats: 0,
      },
    ];
    const created = await new PostgresMessageStore(sql).create({
      id: 'm1',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(0),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    expect(created.id).toBe('m1');
  });

  it('create on 23505 rethrows when findLiveByAccountContent misses', async () => {
    const sql = new MockSql();
    sql.executeError = Object.assign(new Error('duplicate key'), { code: '23505' });
    sql.nextRows = [];
    await expect(
      new PostgresMessageStore(sql).create(
        {
          id: 'm1',
          accountId: 'acc',
          name: 'Ada',
          text: '',
          createdAt: new Date(0),
          hasPhoto: true,
          ...unsignedNostrDefaults(),
        },
        JPEG,
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('create binds the nostrEvent object when present', async () => {
    const sql = new MockSql();
    const store = new PostgresMessageStore(sql);
    const nostrEvent = { id: 'evt', kind: 1 };
    const row: MessageRow = {
      id: 'm1',
      accountId: 'acc',
      name: 'Ada',
      text: 'signed',
      createdAt: new Date('2026-08-28T12:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      nostrEvent,
    };
    await store.create(row);
    expect(typeof sql.executes[0]?.params[13]).not.toBe('string');
    expect(sql.executes[0]?.params[13]).toStrictEqual(nostrEvent);
  });

  it('create writes video bytes then binds video_content_type', async () => {
    const sql = new MockSql();
    const store = new PostgresMessageStore(sql);
    const mp4 = new Uint8Array(32);
    mp4.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    const row: MessageRow = {
      id: 'm-vid-pg',
      accountId: 'acc',
      name: 'Ada',
      text: 'clip',
      createdAt: new Date('2026-08-28T12:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    };
    const created = await store.create(row, undefined, { contentType: 'video/mp4', bytes: mp4 });
    expect(created.hasVideo).toBe(true);
    expect(sql.executes[0]?.params[6]).toBe('video/mp4');
  });

  it('create binds text together with photo bytes', async () => {
    const sql = new MockSql();
    const row: MessageRow = {
      id: 'm1',
      accountId: 'acc',
      name: 'Ada',
      text: 'hello with photo',
      createdAt: new Date('2026-08-28T12:00:00.000Z'),
      hasPhoto: true,
      ...unsignedNostrDefaults(),
    };
    await new PostgresMessageStore(sql).create(row, JPEG);
    expect(sql.executes[0]?.params[3]).toBe('hello with photo');
    expect(sql.executes[0]?.params[4]).toEqual(JPEG.bytes);
    expect(sql.executes[0]?.params[5]).toBe('image/jpeg');
  });

  it('create extras without photo 0 throws before insert', async () => {
    const sql = new MockSql();
    const row: MessageRow = {
      id: 'm-no-zero',
      accountId: 'acc',
      name: 'Ada',
      text: '',
      createdAt: new Date('2026-08-28T12:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    };
    await expect(
      new PostgresMessageStore(sql).create(row, undefined, undefined, [JPEG2]),
    ).rejects.toThrow('extra photos require photo 0');
    expect(sql.executes).toEqual([]);
  });

  it('create extras INSERT binds message_extra_photo after the message row', async () => {
    const sql = new MockSql();
    const row: MessageRow = {
      id: 'm1',
      accountId: 'acc',
      name: 'Ada',
      text: '',
      createdAt: new Date('2026-08-28T12:00:00.000Z'),
      hasPhoto: true,
      ...unsignedNostrDefaults(),
    };
    await new PostgresMessageStore(sql).create(row, JPEG, undefined, [JPEG2]);
    expect(sql.executes[0]?.text).toMatch(/INSERT INTO message \(/);
    expect(sql.executes[1]?.text).toMatch(/INSERT INTO message_extra_photo/);
    expect(sql.executes[1]?.text).toMatch(/\(message_id, idx, photo, photo_content_type\)/);
    expect(sql.executes[1]?.text).toMatch(/VALUES \(\s*\$1\s*,\s*\$2\s*,\s*\$3\s*,\s*\$4\s*\)/);
    expect(sql.executes[1]?.params).toEqual([row.id, 1, JPEG2.bytes, JPEG2.contentType]);
  });

  it('create deletes the row and rethrows when an extra INSERT fails', async () => {
    const extraError = new Error('extra insert boom');
    const sql = new MockSql();
    const execute = sql.execute.bind(sql);
    sql.execute = async (text: string, params: readonly unknown[] = []): Promise<void> => {
      await execute(text, params);
      if (/INSERT INTO message_extra_photo/.test(text)) {
        throw extraError;
      }
    };
    const row: MessageRow = {
      id: 'm1',
      accountId: 'acc',
      name: 'Ada',
      text: '',
      createdAt: new Date('2026-08-28T12:00:00.000Z'),
      hasPhoto: true,
      ...unsignedNostrDefaults(),
    };
    await expect(new PostgresMessageStore(sql).create(row, JPEG, undefined, [JPEG2])).rejects.toBe(
      extraError,
    );
    expect(sql.executes.some((item) => /INSERT INTO message_extra_photo/.test(item.text))).toBe(
      true,
    );
    expect(sql.queries[0]?.text).toMatch(/WITH/);
    expect(sql.queries[0]?.text).toMatch(/targets AS/);
    expect(sql.queries[0]?.text).toMatch(/DELETE FROM message/);
    expect(sql.queries[0]?.text).toMatch(/id = \$1 OR parent_id = \$1/);
  });

  it('getPhoto maps a bytea row', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ photo: JPEG.bytes, photo_content_type: 'image/jpeg' }];
    const store = new PostgresMessageStore(sql);
    const photo = await store.getPhoto('m1');
    expect(sql.queries[0]?.text).toMatch(
      /SELECT photo, photo_content_type FROM message WHERE id = \$1/,
    );
    expect(sql.queries[0]?.params).toEqual(['m1']);
    expect(photo).toEqual(JPEG);
  });

  it('getPhoto maps a number[] bytea payload', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ photo: [0xff, 0xd8, 0xff, 0xd9], photo_content_type: 'image/jpeg' }];
    const photo = await new PostgresMessageStore(sql).getPhoto('m1');
    expect(photo).toEqual(JPEG);
  });

  it('getPhoto returns null for an empty result', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    expect(await new PostgresMessageStore(sql).getPhoto('missing')).toBeNull();
  });

  it('getPhoto returns null when photo is null', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ photo: null, photo_content_type: null }];
    expect(await new PostgresMessageStore(sql).getPhoto('m1')).toBeNull();
  });

  it('getPhoto returns null when content type is missing', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ photo: JPEG.bytes, photo_content_type: null }];
    expect(await new PostgresMessageStore(sql).getPhoto('m1')).toBeNull();
  });

  it('getPhoto returns null for an unrecognized content type', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ photo: JPEG.bytes, photo_content_type: 'image/gif' }];
    expect(await new PostgresMessageStore(sql).getPhoto('m1')).toBeNull();
  });

  it('getExtraPhoto returns null outside 1–9 and when the row is empty or null', async () => {
    const sql = new MockSql();
    const store = new PostgresMessageStore(sql);
    expect(await store.getExtraPhoto('m1', 0)).toBeNull();
    expect(await store.getExtraPhoto('m1', 10)).toBeNull();
    expect(sql.queries).toEqual([]);
    sql.nextRows = [];
    expect(await store.getExtraPhoto('m1', 1)).toBeNull();
    sql.nextRows = [{ photo: null, photo_content_type: 'image/jpeg' }];
    expect(await store.getExtraPhoto('m1', 1)).toBeNull();
    sql.nextRows = [{ photo: JPEG2.bytes, photo_content_type: null }];
    expect(await store.getExtraPhoto('m1', 1)).toBeNull();
  });

  it('getExtraPhoto maps a bytea row', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ photo: JPEG2.bytes, photo_content_type: 'image/jpeg' }];
    const store = new PostgresMessageStore(sql);
    const photo = await store.getExtraPhoto('m1', 1);
    expect(sql.queries[0]?.text).toMatch(
      /SELECT photo, photo_content_type FROM message_extra_photo WHERE message_id = \$1 AND idx = \$2/,
    );
    expect(sql.queries[0]?.params).toEqual(['m1', 1]);
    expect(photo).toEqual(JPEG2);
  });

  it('getExtraPhoto maps a number[] bytea payload', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ photo: [0xff, 0xd8, 0xff, 0x00], photo_content_type: 'image/jpeg' }];
    const photo = await new PostgresMessageStore(sql).getExtraPhoto('m1', 1);
    expect(photo).toEqual(JPEG2);
  });

  it('listExtraPhotos maps extra rows in idx order', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ idx: 1, photo: JPEG2.bytes, photo_content_type: 'image/jpeg' }];
    const listed = await new PostgresMessageStore(sql).listExtraPhotos('m1');
    expect(sql.queries[0]?.text).toMatch(
      /SELECT idx, photo, photo_content_type FROM message_extra_photo WHERE message_id = \$1 ORDER BY idx ASC/,
    );
    expect(sql.queries[0]?.params).toEqual(['m1']);
    expect(listed).toEqual([JPEG2]);
  });

  it('listExtraPhotos skips null bytes, missing type, and unrecognized type', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      { idx: 1, photo: null, photo_content_type: 'image/jpeg' },
      { idx: 2, photo: JPEG2.bytes, photo_content_type: null },
      { idx: 3, photo: JPEG2.bytes, photo_content_type: 'image/gif' },
      { idx: 4, photo: JPEG2.bytes, photo_content_type: 'image/jpeg' },
    ];
    expect(await new PostgresMessageStore(sql).listExtraPhotos('m1')).toEqual([JPEG2]);
  });

  it('getExtraPhoto returns null for an unrecognized content type', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ photo: JPEG2.bytes, photo_content_type: 'image/gif' }];
    expect(await new PostgresMessageStore(sql).getExtraPhoto('m1', 1)).toBeNull();
  });

  it('propagates list query errors', async () => {
    const sql = new MockSql();
    sql.queryError = new Error('list boom');
    await expect(new PostgresMessageStore(sql).listLatest(10)).rejects.toThrow('list boom');
  });

  it('getById maps a row and claim SQL runs', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'm1',
        account_id: 'acc',
        name: 'Ada',
        text: 'hi',
        created_at: new Date(0),
        has_photo: false,
        event_id: null,
        nostr_publish_state: 'pending',
        sats: 0,
      },
    ];
    const store = new PostgresMessageStore(sql);
    expect((await store.getById('m1'))?.id).toBe('m1');
    sql.nextRows = [];
    expect(await store.getById('missing')).toBeUndefined();
    sql.nextRows = [
      {
        id: 'm2',
        account_id: 'acc',
        name: 'Ada',
        text: 'hi',
        created_at: '2026-08-28T00:00:00.000Z',
        has_photo: false,
        claimed_until: new Date('2026-08-28T00:01:00.000Z'),
        nostr_first_attempt_at: '2026-08-28T00:00:30.000Z',
        nostr_publish_state: 'weird',
      },
    ];
    const mapped = await store.getById('m2');
    expect(mapped?.nostrPublishState).toBe('pending');
    sql.nextRows = [
      {
        id: 'm-skipped',
        account_id: 'acc',
        name: 'Ada',
        text: '',
        created_at: new Date(0),
        has_photo: false,
        event_id: null,
        nostr_publish_state: 'skipped',
        sats: 21,
      },
    ];
    expect((await store.getById('m-skipped'))?.nostrPublishState).toBe('skipped');
    expect(mapped?.claimedUntil).toBe(Date.parse('2026-08-28T00:01:00.000Z'));
    sql.nextRows = [];
    expect(await store.claimUnsigned(5, 1_000, 60_000)).toEqual([]);
    expect(await store.claimUnpublished(5, 1_000, 60_000)).toEqual([]);
    expect(sql.queries.some((q) => /claimed_until <= \$2/.test(q.text))).toBe(true);
    const nostrEvent = { id: 'x' };
    expect(await store.updateSignedEvent('m1', 'ee'.repeat(32), nostrEvent)).toBe(false);
    expect(typeof sql.queries.at(-1)?.params[2]).not.toBe('string');
    expect(sql.queries.at(-1)?.params[2]).toStrictEqual(nostrEvent);
    await store.updatePublishState('m1', 'published', 'public');
    await store.addSats('m1', 7);
    expect(sql.executes.some((e) => e.text.includes('sats = sats +'))).toBe(true);
  });

  it('getById maps deleted_at Date and ISO string', async () => {
    const sql = new MockSql();
    const deletedAtDate = new Date('2026-09-01T12:00:00.000Z');
    sql.nextRows = [
      {
        id: 'm1',
        account_id: 'acc',
        name: 'Ada',
        text: 'hi',
        created_at: new Date(0),
        has_photo: false,
        event_id: null,
        nostr_publish_state: 'pending',
        sats: 0,
        deleted_at: deletedAtDate,
        deleted_by: 'staff-acc',
      },
    ];
    const store = new PostgresMessageStore(sql);
    const mappedDate = await store.getById('m1');
    expect(mappedDate?.deletedAt?.getTime()).toBe(deletedAtDate.getTime());
    expect(mappedDate?.deletedBy).toBe('staff-acc');

    const deletedAtIso = '2026-09-02T00:00:00.000Z';
    sql.nextRows = [
      {
        id: 'm2',
        account_id: 'acc',
        name: 'Ada',
        text: 'hi',
        created_at: new Date(0),
        has_photo: false,
        event_id: null,
        nostr_publish_state: 'pending',
        sats: 0,
        deleted_at: deletedAtIso,
      },
    ];
    const mappedIso = await store.getById('m2');
    expect(mappedIso?.deletedAt?.getTime()).toBe(Date.parse(deletedAtIso));
    expect(mappedIso?.deletedBy).toBeNull();
  });

  it('deleteById issues one CTE query for receipts, invoices, and rows', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      { id: 'm1', video_content_type: 'video/mp4' },
      { id: 'm1-child', video_content_type: null },
    ];
    expect(await new PostgresMessageStore(sql).deleteById('m1')).toBe(true);
    expect(sql.executes).toEqual([]);
    expect(sql.queries).toHaveLength(1);
    const text = sql.queries[0]?.text ?? '';
    expect(text).toMatch(/WITH/);
    expect(text).toMatch(/DELETE FROM nostr_zap_receipt/);
    expect(text).toMatch(/DELETE FROM message_invoice/);
    expect(text).toMatch(/DELETE FROM message/);
    expect(text).not.toMatch(/nostr_zap_payment/);
    expect(text).toMatch(/parent_id = \$1/);
    expect(sql.queries[0]?.params).toEqual(['m1']);
  });

  it('deleteById returns false when the CTE finds no rows', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    expect(await new PostgresMessageStore(sql).deleteById('missing')).toBe(false);
    expect(sql.executes).toEqual([]);
    expect(sql.queries).toHaveLength(1);
    expect(sql.queries[0]?.text).toMatch(/WITH/);
  });

  it('markDeleted issues an UPDATE CTE and returns false when missing', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ id: 'm1' }];
    const at = new Date('2026-09-01T12:00:00.000Z');
    expect(await new PostgresMessageStore(sql).markDeleted('m1', at, 'staff')).toBe(true);
    expect(sql.executes).toEqual([]);
    expect(sql.queries).toHaveLength(1);
    const text = sql.queries[0]?.text ?? '';
    expect(text).toMatch(/UPDATE message SET deleted_at = \$2, deleted_by = \$3/);
    expect(text).toMatch(/deleted_at IS NULL AND \(id = \$1 OR parent_id = \$1\)/);
    expect(text).not.toMatch(/DELETE FROM message/);
    expect(sql.queries[0]?.params).toEqual(['m1', at, 'staff']);

    const missing = new MockSql();
    missing.nextRows = [];
    expect(await new PostgresMessageStore(missing).markDeleted('gone', at, 'staff')).toBe(false);
  });

  it('markUndeleted issues an UPDATE CTE and returns false when missing', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ id: 'm1' }];
    expect(await new PostgresMessageStore(sql).markUndeleted('m1')).toBe(true);
    expect(sql.executes).toEqual([]);
    expect(sql.queries).toHaveLength(1);
    const text = sql.queries[0]?.text ?? '';
    expect(text).toMatch(/WITH target AS \(/);
    expect(text).toMatch(/SELECT id, deleted_at, deleted_by FROM message WHERE id = \$1/);
    expect(text).toMatch(/UPDATE message m/);
    expect(text).toMatch(/SET deleted_at = NULL, deleted_by = NULL/);
    expect(text).toMatch(/t\.deleted_at IS NOT NULL/);
    expect(text).toMatch(/m\.parent_id = t\.id/);
    expect(text).toMatch(/m\.deleted_at IS NOT DISTINCT FROM t\.deleted_at/);
    expect(text).toMatch(/m\.deleted_by IS NOT DISTINCT FROM t\.deleted_by/);
    expect(text).toMatch(/SELECT id FROM target/);
    expect(text).not.toMatch(/DELETE FROM message/);
    expect(sql.queries[0]?.params).toEqual(['m1']);

    const missing = new MockSql();
    missing.nextRows = [];
    expect(await new PostgresMessageStore(missing).markUndeleted('gone')).toBe(false);
  });

  it('list and claim SQL require deleted_at IS NULL', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    const store = new PostgresMessageStore(sql);
    await store.listLatest(10);
    await store.listReplies('p1', 10);
    await store.countByAccount('acc');
    await store.listPostsByAccount('acc', 10);
    await store.listRepliesByAccount('acc', 10);
    await store.listPublishedEventIds(10);
    await store.listPendingSigned(10);
    await store.listSignedMissingPhoto(10);
    await store.listSignedMissingVideo(10);
    await store.listSignedMissingHashtags(10);
    await store.claimUnsigned(5, 1_000, 60_000);
    await store.claimUnpublished(5, 1_000, 60_000);
    for (const query of sql.queries) {
      expect(query.text).toMatch(/deleted_at IS NULL/);
    }
  });

  it('propagates create execute errors', async () => {
    const sql = new MockSql();
    sql.executeError = new Error('create boom');
    await expect(
      new PostgresMessageStore(sql).create({
        id: 'm1',
        accountId: 'acc',
        name: 'Ada',
        text: 'hi',
        createdAt: new Date(0),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      }),
    ).rejects.toThrow('create boom');
  });

  it('unlinks a written video when the insert fails', async () => {
    const sql = new MockSql();
    sql.executeError = new Error('create boom');
    const mp4 = new Uint8Array(32);
    mp4.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    await expect(
      new PostgresMessageStore(sql).create(
        {
          id: 'm-vid-fail',
          accountId: 'acc',
          name: 'Ada',
          text: 'clip',
          createdAt: new Date(0),
          hasPhoto: false,
          ...unsignedNostrDefaults(),
        },
        undefined,
        { contentType: 'video/mp4', bytes: mp4 },
      ),
    ).rejects.toThrow('create boom');
  });

  it('getByEventId SQL matches event_id and the same SELECT column list as getById', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'm1',
        account_id: 'acc',
        name: 'Ada',
        text: 'hi',
        created_at: new Date(0),
        has_photo: true,
        event_id: 'ee'.repeat(32),
        nostr_publish_state: 'pending',
        sats: 0,
      },
    ];
    const store = new PostgresMessageStore(sql);
    const found = await store.getByEventId('ee'.repeat(32));
    expect(found?.id).toBe('m1');
    expect(found?.hasPhoto).toBe(true);
    expect(sql.queries[0]?.text).toMatch(/event_id = \$1/);
    expect(sql.queries[0]?.text).toMatch(/\(photo IS NOT NULL\) AS has_photo/);
    expect(sql.queries[0]?.text).toMatch(
      /nostr_event, claimed_until, nostr_first_attempt_at, nostr_publish_epoch, nostr_attempts/,
    );
    expect(sql.queries[0]?.text).not.toMatch(/SELECT[^;]*\bphoto\b(?!\s+IS\s+NOT\s+NULL)/i);
    sql.nextRows = [];
    expect(await store.getByEventId('missing')).toBeUndefined();
  });

  it('recordZapReceipt success inserts then adds sats', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ event_id: 'r1' }];
    const store = new PostgresMessageStore(sql);
    expect(await store.recordZapReceipt('r1', 'm1', 21)).toBe(true);
    expect(sql.queries[0]?.text).toMatch(/nostr_zap_receipt/);
    expect(sql.queries[0]?.text).toMatch(/ON CONFLICT/);
    expect(sql.queries[0]?.text).toMatch(/message\.sats \+ inserted\.sats/);
    expect(sql.executes).toEqual([]);
  });

  it('claimZapPayment lowercases the hash and accepts the stored receipt owner', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ receipt_event_id: 'receipt-a' }];
    const at = new Date('2026-09-18T12:00:00.000Z');
    const paymentHash = 'AB'.repeat(32);
    const store = new PostgresMessageStore(sql);
    expect(await store.claimZapPayment(paymentHash, 'receipt-a', at)).toBe(true);
    expect(await store.claimZapPayment(paymentHash.toLowerCase(), 'receipt-a', at)).toBe(true);
    expect(sql.executes).toHaveLength(2);
    expect(sql.executes[0]?.text).toMatch(/INSERT INTO nostr_zap_payment/);
    expect(sql.executes[0]?.text).toMatch(/ON CONFLICT \(payment_hash\) DO NOTHING/);
    expect(sql.executes[0]?.params).toEqual([paymentHash.toLowerCase(), 'receipt-a', at]);
    expect(sql.queries).toHaveLength(2);
    expect(sql.queries[0]?.text).toMatch(/SELECT receipt_event_id/);
    expect(sql.queries[0]?.text).toMatch(/WHERE payment_hash = \$1/);
    expect(sql.queries[0]?.params).toEqual([paymentHash.toLowerCase()]);
  });

  it('claimZapPayment rejects a receipt id that does not own the hash', async () => {
    const sql = new MockSql();
    sql.nextRows = [{ receipt_event_id: 'receipt-a' }];
    const store = new PostgresMessageStore(sql);
    expect(await store.claimZapPayment('ab'.repeat(32), 'receipt-b', new Date(0))).toBe(false);
  });

  it('claimZapPayment returns false when the ownership row is unavailable', async () => {
    const sql = new MockSql();
    const store = new PostgresMessageStore(sql);
    expect(await store.claimZapPayment('ab'.repeat(32), 'receipt-a', new Date(0))).toBe(false);
  });

  it('recordZapReceipt conflict returns false without sats update', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    const store = new PostgresMessageStore(sql);
    expect(await store.recordZapReceipt('r1', 'm1', 21)).toBe(false);
    expect(sql.executes).toEqual([]);
  });

  it('updateText issues UPDATE … RETURNING and maps the row', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'm1',
        account_id: 'acc',
        name: 'Ada',
        text: 'bio',
        created_at: new Date(0),
        has_photo: false,
        event_id: 'ee'.repeat(32),
        nostr_publish_state: 'published',
        sats: 21,
      },
    ];
    const store = new PostgresMessageStore(sql);
    const updated = await store.updateText('m1', 'bio');
    expect(updated?.text).toBe('bio');
    expect(updated?.sats).toBe(21);
    expect(updated?.eventId).toBe('ee'.repeat(32));
    expect(sql.queries[0]?.text).toMatch(/UPDATE message SET text = \$2 WHERE id = \$1 RETURNING/);
    expect(sql.queries[0]?.text).toMatch(/\(photo IS NOT NULL\) AS has_photo/);
    expect(sql.queries[0]?.params).toEqual(['m1', 'bio']);
    sql.nextRows = [];
    expect(await store.updateText('missing', 'x')).toBeUndefined();
  });

  it('updatePhoto issues UPDATE … RETURNING and maps the row', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'm1',
        account_id: 'acc',
        name: 'Ada',
        text: 'bio',
        created_at: new Date(0),
        has_photo: true,
        event_id: 'ee'.repeat(32),
        nostr_publish_state: 'published',
        sats: 21,
      },
    ];
    const store = new PostgresMessageStore(sql);
    const updated = await store.updatePhoto('m1', JPEG);
    expect(updated?.hasPhoto).toBe(true);
    expect(updated?.sats).toBe(21);
    expect(updated?.eventId).toBe('ee'.repeat(32));
    expect(sql.queries[0]?.text).toMatch(
      /UPDATE message SET photo = \$2, photo_content_type = \$3 WHERE id = \$1 RETURNING/,
    );
    expect(sql.queries[0]?.params).toEqual(['m1', JPEG.bytes, 'image/jpeg']);
    sql.nextRows = [
      {
        id: 'm1',
        account_id: 'acc',
        name: 'Ada',
        text: 'bio',
        created_at: new Date(0),
        has_photo: false,
        event_id: 'ee'.repeat(32),
        nostr_publish_state: 'published',
        sats: 21,
      },
    ];
    const cleared = await store.updatePhoto('m1', null);
    expect(cleared?.hasPhoto).toBe(false);
    expect(sql.queries[1]?.params).toEqual(['m1', null, null]);
    sql.nextRows = [];
    expect(await store.updatePhoto('missing', JPEG)).toBeUndefined();
  });

  it('getById maps nostr_event JSON string', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'm1',
        account_id: 'acc',
        name: 'Ada',
        text: 'hi',
        created_at: new Date(0),
        event_id: 'abc123',
        nostr_publish_state: 'pending',
        sats: 0,
        nostr_event: JSON.stringify({ id: 'abc123', kind: 1 }),
      },
    ];
    const mapped = await new PostgresMessageStore(sql).getById('m1');
    expect(mapped?.nostrEvent?.['id']).toBe('abc123');
  });

  it('listPendingSigned and clearSignedEvent hit Postgres', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'm1',
        account_id: 'acc',
        name: 'Ada',
        text: 'hi',
        created_at: new Date(0),
        has_photo: true,
        event_id: 'ab'.repeat(32),
        nostr_publish_state: 'pending',
        sats: 0,
      },
    ];
    const store = new PostgresMessageStore(sql);
    const pending = await store.listPendingSigned(7);
    expect(pending[0]?.id).toBe('m1');
    expect(pending[0]?.hasPhoto).toBe(true);
    const listSql = sql.queries.at(-1)?.text ?? '';
    expect(listSql).toMatch(/event_id IS NOT NULL/);
    expect(listSql).toMatch(/tag->>1 = 'bitcoin'/);
    expect(listSql).toMatch(/ORDER BY created_at ASC,\s*id ASC/);
    expect(listSql).toMatch(/\(photo IS NOT NULL\) AS has_photo/);
    expect(listSql).toMatch(/has_photo/);
    expect(listSql).not.toMatch(/SELECT[^;]*\bphoto\b(?!\s+IS\s+NOT\s+NULL)/i);
    await store.clearSignedEvent('m1', 'ab'.repeat(32));
    expect(sql.executes.at(-1)?.text).toMatch(/event_id = NULL/);
    expect(sql.executes.at(-1)?.text).toMatch(/event_id IS NOT DISTINCT FROM/);
    expect(sql.executes.at(-1)?.text).toMatch(/nostr_publish_state = 'pending'/);
    expect(sql.executes.at(-1)?.text).toMatch(/NOT EXISTS/);
  });

  it('listSignedMissingPhoto and resetSignedEvent hit Postgres', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'm1',
        account_id: 'acc',
        name: 'Ada',
        text: '',
        created_at: new Date(0),
        has_photo: true,
        event_id: 'ab'.repeat(32),
        nostr_publish_state: 'published',
        sats: 0,
      },
    ];
    const store = new PostgresMessageStore(sql);
    const missing = await store.listSignedMissingPhoto(4);
    expect(missing[0]?.id).toBe('m1');
    const listSql = sql.queries.at(-1)?.text ?? '';
    expect(listSql).toMatch(/parent_id IS NULL/);
    expect(listSql).toMatch(/NOT EXISTS/);
    expect(listSql).toMatch(/photo IS NOT NULL/);
    expect(listSql).toMatch(/sats = 0/);
    expect(listSql).toMatch(/nostr_publish_state = 'published'/);
    expect(listSql).toMatch(/nostr_attempts < 5/);
    expect(listSql).toMatch(/\/messages\/' \|\| id::text \|\| '\/photo\./);
    await store.resetSignedEvent('m1', 'ab'.repeat(32));
    expect(sql.executes.at(-1)?.text).toMatch(/nostr_publish_state = 'pending'/);
    expect(sql.executes.at(-1)?.text).toMatch(/nostr_attempts = message\.nostr_attempts \+ 1/);
    expect(sql.executes.at(-1)?.text).toMatch(
      /nostr_first_attempt_at = COALESCE\(message\.nostr_first_attempt_at, now\(\)\)/,
    );
    expect(sql.executes.at(-1)?.text).toMatch(/event_id IS NOT DISTINCT FROM/);
    expect(sql.executes.at(-1)?.text).toMatch(/sats = 0/);
    expect(sql.executes.at(-1)?.text).toMatch(/NOT EXISTS/);
    expect(sql.executes.at(-1)?.params).toEqual(['m1', 'ab'.repeat(32)]);
  });

  it('listSignedMissingVideo hits Postgres', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'm1',
        account_id: 'acc',
        name: 'Ada',
        text: 'clip',
        created_at: new Date(0),
        has_photo: false,
        video_content_type: 'video/mp4',
        event_id: 'ab'.repeat(32),
        nostr_publish_state: 'published',
        sats: 0,
      },
    ];
    const store = new PostgresMessageStore(sql);
    const missing = await store.listSignedMissingVideo(4);
    expect(missing[0]?.id).toBe('m1');
    const listSql = sql.queries.at(-1)?.text ?? '';
    expect(listSql).toMatch(/parent_id IS NULL/);
    expect(listSql).toMatch(/NOT EXISTS/);
    expect(listSql).toMatch(
      /video_content_type IN \('video\/mp4', 'video\/webm', 'video\/quicktime'\)/,
    );
    expect(listSql).toMatch(/sats = 0/);
    expect(listSql).toMatch(/nostr_publish_state = 'published'/);
    expect(listSql).toMatch(/nostr_attempts < 5/);
    expect(listSql).toMatch(/\/messages\/' \|\| id::text \|\| '\/video\./);
  });

  it('listSignedMissingHashtags hits Postgres', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'm1',
        account_id: 'acc',
        name: 'Ada',
        text: 'ohne foto funktioniert es',
        created_at: new Date(0),
        has_photo: false,
        event_id: 'ab'.repeat(32),
        nostr_publish_state: 'published',
        sats: 0,
      },
    ];
    const store = new PostgresMessageStore(sql);
    const missing = await store.listSignedMissingHashtags(4);
    expect(missing[0]?.id).toBe('m1');
    const listSql = sql.queries.at(-1)?.text ?? '';
    expect(listSql).toMatch(/sats = 0/);
    expect(listSql).toMatch(/NOT EXISTS/);
    expect(listSql).toMatch(/nostr_publish_state = 'published'/);
    expect(listSql).toMatch(/nostr_attempts < 5/);
    expect(listSql).toMatch(/jsonb_typeof\(nostr_event->'content'\) IS DISTINCT FROM 'string'/);
    expect(listSql).toContain('#21gifts([^a-z0-9_]|$)');
    expect(listSql).toContain('#bitcoin([^a-z0-9_]|$)');
    expect(listSql).toMatch(/ORDER BY created_at ASC,\s*id ASC/);
  });

  it('listSignedMissingHashtags extras map extends the Postgres hashtag scan', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'm1',
        account_id: 'acc',
        name: 'Ada',
        text: 'x',
        created_at: new Date(0),
        has_photo: false,
        event_id: 'ab'.repeat(32),
        nostr_publish_state: 'published',
        sats: 0,
      },
    ];
    const store = new PostgresMessageStore(sql);
    await store.listSignedMissingHashtags(4, new Map());
    const emptySql = sql.queries.at(-1)?.text ?? '';
    expect(emptySql).toContain('#21gifts([^a-z0-9_]|$)');
    expect(emptySql).toContain('#bitcoin([^a-z0-9_]|$)');
    expect(emptySql).not.toMatch(/unnest/i);
    expect(sql.queries.at(-1)?.params).toEqual([4]);
    const missing = await store.listSignedMissingHashtags(4, new Map([['acc', ['Berlin']]]));
    expect(missing[0]?.id).toBe('m1');
    const extraSql = sql.queries.at(-1)?.text ?? '';
    expect(extraSql).toContain('#21gifts([^a-z0-9_]|$)');
    expect(extraSql).toContain('#bitcoin([^a-z0-9_]|$)');
    expect(extraSql).toMatch(/unnest/i);
    expect(extraSql).toMatch(/extra\.pattern/);
    expect(sql.queries.at(-1)?.params).toEqual([4, '{"acc"}', `{"#berlin([^a-z0-9_]|$)"}`]);
    await store.listSignedMissingHashtags(4, new Map([['acc', ['St.Gallen']]]));
    expect(sql.queries.at(-1)?.params).toEqual([4, '{"acc"}', `{"#st\\\\.gallen([^a-z0-9_]|$)"}`]);
  });

  it('listSignedMissingHashtags excludeIds binds before LIMIT', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    const store = new PostgresMessageStore(sql);
    const profileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    await store.listSignedMissingHashtags(4);
    expect(sql.queries.at(-1)?.text ?? '').not.toMatch(/ANY/);
    expect(sql.queries.at(-1)?.params).toEqual([4]);

    await store.listSignedMissingHashtags(4, new Map(), new Set());
    expect(sql.queries.at(-1)?.text ?? '').not.toMatch(/ANY/);
    expect(sql.queries.at(-1)?.params).toEqual([4]);

    await store.listSignedMissingHashtags(4, new Map([['acc', ['Berlin']]]));
    expect(sql.queries.at(-1)?.text ?? '').not.toMatch(/ANY/);
    expect(sql.queries.at(-1)?.params).toEqual([4, '{"acc"}', `{"#berlin([^a-z0-9_]|$)"}`]);

    await store.listSignedMissingHashtags(4, undefined, new Set([profileId]));
    const excludeOnlySql = sql.queries.at(-1)?.text ?? '';
    expect(excludeOnlySql).toMatch(/ANY/);
    expect(excludeOnlySql).toMatch(/\$2::text\[\]/);
    expect(sql.queries.at(-1)?.params).toEqual([4, `{"${profileId}"}`]);

    await store.listSignedMissingHashtags(4, new Map([['acc', ['Berlin']]]), new Set([profileId]));
    const extraExcludeSql = sql.queries.at(-1)?.text ?? '';
    expect(extraExcludeSql).toMatch(/ANY/);
    expect(extraExcludeSql).toMatch(/unnest/i);
    expect(extraExcludeSql).toMatch(/\$4::text\[\]/);
    expect(sql.queries.at(-1)?.params).toEqual([
      4,
      '{"acc"}',
      `{"#berlin([^a-z0-9_]|$)"}`,
      `{"${profileId}"}`,
    ]);

    await store.listSignedMissingHashtags(4, undefined, new Set(['id"quote', 'id\\slash']));
    expect(sql.queries.at(-1)?.text ?? '').toMatch(/\$2::text\[\]/);
    expect(sql.queries.at(-1)?.params).toEqual([4, '{"id\\"quote","id\\\\slash"}']);
  });

  it('propagates getPhoto query errors', async () => {
    const sql = new MockSql();
    sql.queryError = new Error('photo boom');
    await expect(new PostgresMessageStore(sql).getPhoto('m1')).rejects.toThrow('photo boom');
  });

  it('listReplies and listPublishedEventIds hit Postgres filters', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'r1',
        account_id: 'acc',
        name: 'Ada',
        text: 'hi',
        created_at: new Date(0),
        has_photo: false,
        parent_id: 'm1',
        author_pubkey: 'aa'.repeat(32),
      },
    ];
    const store = new PostgresMessageStore(sql);
    const replies = await store.listReplies('m1', 50);
    expect(replies[0]?.parentId).toBe('m1');
    expect(replies[0]?.accountId).toBe('acc');
    expect(sql.queries[0]?.text).toMatch(/WHERE parent_id = \$1/);
    expect(sql.queries[0]?.text).toMatch(/deleted_at IS NULL/);
    expect(sql.queries[0]?.text).toMatch(
      /account_id IS NOT NULL OR \(author_pubkey IS NOT NULL AND EXISTS \(SELECT 1 FROM nostr_zapper/,
    );
    expect(sql.queries[0]?.text).toMatch(/ORDER BY created_at ASC, id ASC/);
    expect(sql.queries[0]?.params).toEqual(['m1', 50]);
    sql.nextRows = [{ event_id: 'ee'.repeat(32) }];
    expect(await store.listPublishedEventIds(7)).toEqual(['ee'.repeat(32)]);
    expect(sql.queries[1]?.text).toMatch(/event_id IS NOT NULL AND parent_id IS NULL/);
    expect(sql.queries[1]?.params).toEqual([7]);
  });

  it('recordInvoiceAttempt inserts into message_invoice with jsonb zap_request and lnurl_response', async () => {
    const sql = new MockSql();
    const store = new PostgresMessageStore(sql);
    const row: MessageInvoiceAttempt = {
      id: 'inv-1',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: 'm1',
      payerAccountId: 'payer',
      authorAccountId: 'author',
      amountSats: 21,
      lightningAddress: 'a@b.com',
      zapRequest: { kind: 9734 },
      result: 'ok',
      httpStatus: 200,
      pr: 'lnbc1',
      paymentHash: 'aa'.repeat(32),
      description: null,
      descriptionHash: 'bb'.repeat(32),
      isNip57Invoice: true,
      lnurlResponse: { pr: 'lnbc1', status: 'OK' },
    };
    await store.recordInvoiceAttempt(row);
    expect(sql.executes).toHaveLength(1);
    expect(sql.executes[0]?.text).toMatch(/INSERT INTO message_invoice/);
    expect(sql.executes[0]?.text).toMatch(/zap_request/);
    expect(sql.executes[0]?.text).toMatch(/lnurl_response/);
    expect(typeof sql.executes[0]?.params[7]).not.toBe('string');
    expect(sql.executes[0]?.params[7]).toStrictEqual(row.zapRequest);
    expect(sql.executes[0]?.params[14]).toBe(true);
    expect(typeof sql.executes[0]?.params[15]).not.toBe('string');
    expect(sql.executes[0]?.params[15]).toStrictEqual(row.lnurlResponse);
  });

  it('recordInvoiceAttempt binds null zap_request when the attempt has none', async () => {
    const sql = new MockSql();
    const store = new PostgresMessageStore(sql);
    const row: MessageInvoiceAttempt = {
      id: 'inv-null',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      messageId: 'm1',
      payerAccountId: 'payer',
      authorAccountId: 'author',
      amountSats: 21,
      lightningAddress: null,
      zapRequest: null,
      result: 'not_found',
      httpStatus: 404,
      pr: null,
      paymentHash: null,
      description: null,
      descriptionHash: null,
      isNip57Invoice: false,
      lnurlResponse: null,
    };
    await store.recordInvoiceAttempt(row);
    expect(sql.executes[0]?.params[7]).toBeNull();
    expect(sql.executes[0]?.params[15]).toBeNull();
  });

  it('listInvoiceAttempts maps Date/string created_at, numeric amount, and JSON zap_request', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'inv-1',
        created_at: new Date('2026-08-28T12:00:00.000Z'),
        message_id: 'm1',
        payer_account_id: 'payer',
        author_account_id: 'author',
        amount_sats: '21',
        lightning_address: 'a@b.com',
        zap_request: { kind: 9734 },
        result: 'ok',
        http_status: 200,
        pr: 'lnbc1',
        payment_hash: 'aa'.repeat(32),
        description: null,
        description_hash: 'bb'.repeat(32),
        is_nip57_invoice: true,
        lnurl_response: { pr: 'lnbc1' },
      },
      {
        id: 'inv-2',
        created_at: '2026-08-27T12:00:00.000Z',
        message_id: 'm2',
        payer_account_id: 'payer',
        author_account_id: 'author',
        amount_sats: 7,
        lightning_address: null,
        zap_request: JSON.stringify({ kind: 9734, content: 'x' }),
        result: 'noZap',
        http_status: 400,
        pr: null,
        payment_hash: null,
        description: 'plain',
        description_hash: null,
        is_nip57_invoice: 0,
        lnurl_response: JSON.stringify({ error: 'noZap' }),
      },
      {
        id: 'inv-3',
        created_at: new Date('2026-08-26T12:00:00.000Z'),
        message_id: 'm3',
        payer_account_id: 'payer',
        author_account_id: 'author',
        amount_sats: 0,
        lightning_address: null,
        zap_request: 'not-json',
        result: 'bad_body',
        http_status: 400,
        pr: null,
        payment_hash: null,
        description: null,
        description_hash: null,
        is_nip57_invoice: null,
        lnurl_response: 'not-json',
      },
      {
        id: 'inv-4',
        created_at: new Date('2026-08-25T12:00:00.000Z'),
        message_id: 'm4',
        payer_account_id: 'payer',
        author_account_id: 'author',
        amount_sats: 0,
        lightning_address: null,
        zap_request: null,
        result: 'not_found',
        http_status: 404,
        pr: null,
        payment_hash: null,
        description: null,
        description_hash: null,
        is_nip57_invoice: false,
        lnurl_response: null,
      },
      {
        id: 'inv-5',
        created_at: new Date('2026-08-24T12:00:00.000Z'),
        message_id: 'm5',
        payer_account_id: 'payer',
        author_account_id: 'author',
        amount_sats: 0,
        lightning_address: null,
        zap_request: '[1,2]',
        result: 'bad_body',
        http_status: 400,
        pr: null,
        payment_hash: null,
        description: null,
        description_hash: null,
        is_nip57_invoice: false,
        lnurl_response: '[1,2]',
      },
    ];
    const store = new PostgresMessageStore(sql);
    const listed = await store.listInvoiceAttempts(50);
    expect(sql.queries[0]?.text).toMatch(/FROM message_invoice/);
    expect(sql.queries[0]?.text).toMatch(/lnurl_response/);
    expect(sql.queries[0]?.text).toMatch(/ORDER BY created_at DESC, id DESC/);
    expect(sql.queries[0]?.text).toMatch(/LIMIT \$1/);
    expect(sql.queries[0]?.params).toEqual([50]);
    expect(listed[0]?.amountSats).toBe(21);
    expect(listed[0]?.zapRequest).toEqual({ kind: 9734 });
    expect(listed[0]?.isNip57Invoice).toBe(true);
    expect(listed[0]?.lnurlResponse).toEqual({ pr: 'lnbc1' });
    expect(listed[1]?.createdAt.toISOString()).toBe('2026-08-27T12:00:00.000Z');
    expect(listed[1]?.zapRequest).toEqual({ kind: 9734, content: 'x' });
    expect(listed[1]?.isNip57Invoice).toBe(false);
    expect(listed[1]?.lnurlResponse).toEqual({ error: 'noZap' });
    expect(listed[2]?.zapRequest).toBeNull();
    expect(listed[2]?.lnurlResponse).toBeNull();
    expect(listed[3]?.zapRequest).toBeNull();
    expect(listed[3]?.lnurlResponse).toBeNull();
    expect(listed[4]?.zapRequest).toBeNull();
    expect(listed[4]?.lnurlResponse).toBeNull();
  });

  it('recordZapIngest inserts into nostr_zap_ingest', async () => {
    const sql = new MockSql();
    const store = new PostgresMessageStore(sql);
    const row: ZapIngestRow = {
      id: 'zi-1',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      receiptId: 'r1',
      noteEventId: 'ee'.repeat(32),
      messageId: 'm1',
      outcome: 'indexed',
      reason: null,
      amountSats: 21,
      receiptPubkey: 'aa'.repeat(32),
      receipt: { id: 'r1', kind: 9735 },
    };
    await store.recordZapIngest(row);
    expect(sql.executes).toHaveLength(1);
    expect(sql.executes[0]?.text).toMatch(/INSERT INTO nostr_zap_ingest/);
    expect(typeof sql.executes[0]?.params[9]).not.toBe('string');
    expect(sql.executes[0]?.params[9]).toStrictEqual(row.receipt);
  });

  it('listZapIngests maps receipt JSON string, non-indexed outcome, and null amount', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'zi-1',
        created_at: new Date('2026-08-28T12:00:00.000Z'),
        receipt_id: 'r1',
        note_event_id: 'ee'.repeat(32),
        message_id: 'm1',
        outcome: 'indexed',
        reason: null,
        amount_sats: '21',
        receipt_pubkey: 'aa'.repeat(32),
        receipt: JSON.stringify({ id: 'r1', kind: 9735 }),
      },
      {
        id: 'zi-2',
        created_at: '2026-08-27T12:00:00.000Z',
        receipt_id: 'r2',
        note_event_id: null,
        message_id: null,
        outcome: 'weird',
        reason: 'sig',
        amount_sats: null,
        receipt_pubkey: null,
        receipt: 'not-json',
      },
      {
        id: 'zi-3',
        created_at: new Date('2026-08-26T12:00:00.000Z'),
        receipt_id: 'r3',
        note_event_id: null,
        message_id: null,
        outcome: 'rejected',
        reason: 'error',
        amount_sats: null,
        receipt_pubkey: null,
        receipt: null,
      },
      {
        id: 'zi-4',
        created_at: new Date('2026-08-25T12:00:00.000Z'),
        receipt_id: 'r4',
        note_event_id: null,
        message_id: null,
        outcome: 'rejected',
        reason: 'error',
        amount_sats: null,
        receipt_pubkey: null,
        receipt: '[1]',
      },
    ];
    const store = new PostgresMessageStore(sql);
    const listed = await store.listZapIngests(10);
    expect(sql.queries[0]?.text).toMatch(/FROM nostr_zap_ingest/);
    expect(sql.queries[0]?.text).toMatch(/ORDER BY created_at DESC, id DESC/);
    expect(listed[0]?.outcome).toBe('indexed');
    expect(listed[0]?.amountSats).toBe(21);
    expect(listed[0]?.receipt).toEqual({ id: 'r1', kind: 9735 });
    expect(listed[1]?.outcome).toBe('rejected');
    expect(listed[1]?.amountSats).toBeNull();
    expect(listed[1]?.receipt).toEqual({});
    expect(listed[2]?.receipt).toEqual({});
    expect(listed[3]?.receipt).toEqual({});
  });

  it('findOkInvoiceByPaymentHash queries ok rows newest first', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'inv-1',
        created_at: new Date('2026-08-28T12:00:00.000Z'),
        message_id: 'm1',
        payer_account_id: 'payer',
        author_account_id: 'auth',
        amount_sats: 21,
        lightning_address: null,
        zap_request: null,
        result: 'ok',
        http_status: 200,
        pr: 'lnbc',
        payment_hash: '11'.repeat(32),
        description: null,
        description_hash: null,
        is_nip57_invoice: true,
        lnurl_response: null,
      },
    ];
    const store = new PostgresMessageStore(sql);
    const found = await store.findOkInvoiceByPaymentHash('11'.repeat(32));
    expect(sql.queries[0]?.text).toMatch(/payment_hash = \$1 AND result = 'ok'/);
    expect(found?.id).toBe('inv-1');
    expect(
      await new PostgresMessageStore(new MockSql()).findOkInvoiceByPaymentHash('x'),
    ).toBeUndefined();
  });

  it('listOpenConversationZapEventIds maps zap_request e-tags', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      { zap_request: { tags: [['e', 'ab'.repeat(32)]] }, conversation_message_id: 'cm1' },
      {
        zap_request: JSON.stringify({ tags: [['p', 'cc'.repeat(32)]] }),
        conversation_message_id: 'cm2',
      },
      { zap_request: null, conversation_message_id: 'cm3' },
      { zap_request: { tags: [['e', 'ab'.repeat(32)]] }, conversation_message_id: 'cm-dup' },
      { zap_request: { tags: [['e', 'ef'.repeat(32)]] }, conversation_message_id: null },
    ];
    const store = new PostgresMessageStore(sql);
    expect(await store.listOpenConversationZapEventIds()).toEqual([
      { eventId: 'ab'.repeat(32), conversationMessageId: 'cm1' },
    ]);
    expect(sql.queries[0]?.text).toMatch(/conversation_id IS NOT NULL/);
    expect(sql.queries[0]?.text).toMatch(/conversation_message_id IS NOT NULL/);
    expect(sql.queries[0]?.text).toMatch(/NOT EXISTS/);
    expect(sql.queries[0]?.text).toMatch(/conversation_message/);
  });

  it('findOkInvoiceByPr queries ok rows newest first', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        id: 'inv-pr',
        created_at: new Date('2026-08-28T12:00:00.000Z'),
        message_id: 'm1',
        payer_account_id: 'payer',
        author_account_id: 'auth',
        amount_sats: 21,
        lightning_address: null,
        zap_request: null,
        result: 'ok',
        http_status: 200,
        pr: 'lnbc',
        payment_hash: '11'.repeat(32),
        description: null,
        description_hash: null,
        is_nip57_invoice: true,
        lnurl_response: null,
      },
    ];
    const store = new PostgresMessageStore(sql);
    const found = await store.findOkInvoiceByPr('lnbc');
    expect(sql.queries[0]?.text).toMatch(/pr = \$1 AND result = 'ok'/);
    expect(found?.id).toBe('inv-pr');
    expect(await new PostgresMessageStore(new MockSql()).findOkInvoiceByPr('lnbc')).toBeUndefined();
  });

  it('updateZapReceiptGift and listZapReceiptsAwaitingGiftReply talk to SQL', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        event_id: 'r1',
        message_id: 'm1',
        sats: '21',
        payer_account_id: 'payer',
        payer_pubkey: null,
        zap_request_id: null,
        receipt_created_at: null,
        comment: null,
      },
    ];
    const store = new PostgresMessageStore(sql);
    await store.updateZapReceiptGift('r1', { payerAccountId: 'payer', giftReplyId: 'g1' });
    expect(sql.executes).toHaveLength(1);
    expect(sql.executes[0]?.text).toBe(
      'UPDATE nostr_zap_receipt SET payer_account_id = $2, gift_reply_id = $3 WHERE event_id = $1',
    );
    expect(sql.executes[0]?.params).toEqual(['r1', 'payer', 'g1']);
    await store.updateZapReceiptGift('r1', { payerAccountId: null, comment: 'thanks' });
    expect(sql.executes).toHaveLength(2);
    expect(sql.executes[1]?.text).toBe(
      'UPDATE nostr_zap_receipt SET payer_account_id = $2, comment = $3 WHERE event_id = $1',
    );
    expect(sql.executes[1]?.params).toEqual(['r1', null, 'thanks']);
    await store.updateZapReceiptGift('r1', { payerPubkey: '85'.repeat(32) });
    expect(sql.executes).toHaveLength(3);
    expect(sql.executes[2]?.text).toBe(
      'UPDATE nostr_zap_receipt SET payer_pubkey = $2 WHERE event_id = $1',
    );
    expect(sql.executes[2]?.params).toEqual(['r1', '85'.repeat(32)]);
    const listed = await store.listZapReceiptsAwaitingGiftReply(10);
    expect(listed).toEqual([
      {
        receiptEventId: 'r1',
        messageId: 'm1',
        sats: 21,
        payerAccountId: 'payer',
        payerPubkey: null,
        zapRequestId: null,
        receiptCreatedAt: null,
        comment: '',
      },
    ]);
    sql.nextRows = [
      {
        event_id: 'r1',
        message_id: 'm1',
        sats: '21',
        payer_account_id: 'payer',
        payer_pubkey: null,
        zap_request_id: null,
        gift_reply_id: null,
        comment: null,
      },
    ];
    expect(await store.getZapReceiptGift('r1')).toEqual({
      receiptEventId: 'r1',
      messageId: 'm1',
      sats: 21,
      payerAccountId: 'payer',
      payerPubkey: null,
      zapRequestId: null,
      giftReplyId: null,
      comment: '',
    });
    sql.nextRows = [
      {
        event_id: 'r1',
        message_id: 'm1',
        sats: '21',
        payer_account_id: 'payer',
        payer_pubkey: null,
        zap_request_id: null,
        gift_reply_id: null,
        comment: 'thanks',
      },
    ];
    expect(await store.getZapReceiptGift('r1')).toEqual({
      receiptEventId: 'r1',
      messageId: 'm1',
      sats: 21,
      payerAccountId: 'payer',
      payerPubkey: null,
      zapRequestId: null,
      giftReplyId: null,
      comment: 'thanks',
    });
    expect(await new PostgresMessageStore(new MockSql()).getZapReceiptGift('x')).toBeUndefined();
    await store.updateZapReceiptGift('r1', { comment: 'thanks' });
    expect(sql.executes.some((e) => e.text.includes('SET comment = $2'))).toBe(true);
    const executesBeforeEmptyPatch = sql.executes.length;
    await store.updateZapReceiptGift('r1', {});
    expect(sql.executes).toHaveLength(executesBeforeEmptyPatch);
  });

  it('lists an external payer receipt awaiting its gift reply through Postgres', async () => {
    const sql = new MockSql();
    sql.nextRows = [
      {
        event_id: 'r-external-gift',
        message_id: 'm1',
        sats: '21',
        payer_account_id: null,
        payer_pubkey: 'aa'.repeat(32),
        zap_request_id: 'request-a',
        receipt_created_at: null,
        comment: 'thanks',
      },
    ];
    const listed = await new PostgresMessageStore(sql).listZapReceiptsAwaitingGiftReply(10);
    expect(sql.queries[0]?.text).toContain(
      'payer_account_id IS NOT NULL OR payer_pubkey IS NOT NULL',
    );
    expect(listed).toEqual([
      {
        receiptEventId: 'r-external-gift',
        messageId: 'm1',
        sats: 21,
        payerAccountId: null,
        payerPubkey: 'aa'.repeat(32),
        zapRequestId: 'request-a',
        receiptCreatedAt: null,
        comment: 'thanks',
      },
    ]);
  });

  it('maps string and Date receipt creation times for pending Postgres gift replies', async () => {
    const sql = new MockSql();
    const dateValue = new Date('2026-09-18T11:00:00Z');
    sql.nextRows = [
      {
        event_id: 'r-created-string',
        message_id: 'm1',
        sats: '21',
        payer_account_id: 'payer',
        payer_pubkey: null,
        zap_request_id: null,
        receipt_created_at: '2026-09-18T10:00:00Z',
        comment: '',
      },
      {
        event_id: 'r-created-date',
        message_id: 'm1',
        sats: '1',
        payer_account_id: null,
        payer_pubkey: '84'.repeat(32),
        zap_request_id: 'request-date',
        receipt_created_at: dateValue,
        comment: 'thanks',
      },
    ];
    const listed = await new PostgresMessageStore(sql).listZapReceiptsAwaitingGiftReply(10);
    expect(listed[0]?.receiptCreatedAt).toEqual(new Date('2026-09-18T10:00:00Z'));
    expect(listed[1]?.receiptCreatedAt).toBe(dateValue);
  });

  it('listInvoiceAttemptsForPayer filters payer_account_id without LIMIT', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    const store = new PostgresMessageStore(sql);
    await store.listInvoiceAttemptsForPayer('payer');
    expect(sql.queries[0]?.text).toContain('WHERE payer_account_id = $1');
    expect(sql.queries[0]?.text).not.toContain('LIMIT');
    expect(sql.queries[0]?.params).toEqual(['payer']);
  });

  it('listIndexedZapIngests filters outcome indexed without LIMIT', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    const store = new PostgresMessageStore(sql);
    await store.listIndexedZapIngests();
    expect(sql.queries[0]?.text).toContain("WHERE outcome = 'indexed'");
    expect(sql.queries[0]?.text).not.toContain('LIMIT');
  });

  it('queries and mutates external attribution state through Postgres', async () => {
    const sql = new MockSql();
    const store = new PostgresMessageStore(sql);
    sql.queryQueue = [
      [{ event_id: 'receipt-a' }],
      [
        {
          event_id: 'receipt-a',
          message_id: 'm1',
          sats: '21',
          created_at: '2026-09-18T10:00:00Z',
          receipt: '{"id":"receipt-a"}',
        },
      ],
      [{ pubkey: 'aa' }],
      [
        {
          pubkey: '86'.repeat(32),
          receipt_event_id: 'receipt-a',
          created_at: '2026-09-18T10:00:00Z',
        },
      ],
      [],
      [{ pubkey: 'aa' }],
      [{ blocked: 1 }],
      [],
      [{ pubkey: 'aa' }],
      [
        {
          pubkey: '87'.repeat(32),
          blocked_at: '2026-09-18T11:00:00Z',
          blocked_by: 'staff',
          message_id: 'm-external',
        },
      ],
    ];
    expect(
      await store.attributeZapReceipt('receipt-a', {
        payerPubkey: 'AA',
        zapRequestId: 'request-a',
        comment: 'thanks',
      }),
    ).toBe(true);
    expect(sql.queries[0]?.text).toContain('SET payer_pubkey = lower($2)');
    expect(sql.queries[0]?.text).toMatch(
      /NOT EXISTS \([\s\S]*other\.zap_request_id = \$3 AND other\.event_id <> \$1/,
    );
    expect(await store.listUnattributedIndexedReceipts(10)).toEqual([
      {
        receiptEventId: 'receipt-a',
        messageId: 'm1',
        sats: 21,
        createdAt: new Date('2026-09-18T10:00:00Z'),
        receipt: { id: 'receipt-a' },
      },
    ]);
    expect(sql.queries[1]?.params).toEqual([10]);
    expect(sql.queries[1]?.text).not.toContain('(i.created_at, r.event_id) <');
    expect(sql.queries[1]?.text).not.toContain('OFFSET');
    await store.recordZapper('AA', 'receipt-a', new Date('2026-09-18T10:00:00Z'));
    expect(sql.executes[0]?.text).toContain('ON CONFLICT (pubkey) DO NOTHING');
    expect(await store.listZapperPubkeys()).toEqual(['aa']);
    expect((await store.listZappers(1))[0]?.receiptEventId).toBe('receipt-a');
    expect(
      await store.blockPubkeyAndHideRows(
        'AA',
        new Date('2026-09-18T11:00:00Z'),
        'staff',
        'm-external',
      ),
    ).toBe(0);
    expect(sql.queries[4]?.text).toContain('ON CONFLICT (pubkey) DO NOTHING');
    expect(sql.queries[4]?.text).toContain('INSERT INTO nostr_blocked_pubkey');
    expect(await store.listBlockedPubkeys()).toEqual(['aa']);
    expect(await store.isPubkeyBlocked('AA')).toBe(true);
    expect(sql.queries[6]?.text).toContain(
      'SELECT 1 FROM nostr_blocked_pubkey WHERE pubkey = $1 LIMIT 1',
    );
    expect(sql.queries[6]?.params).toEqual(['aa']);
    expect(await store.isPubkeyBlocked('BB')).toBe(false);
    expect(await store.unblockPubkeyByMessage('m-external')).toBe(true);
    expect(sql.queries[8]?.text).toContain(
      'DELETE FROM nostr_blocked_pubkey WHERE message_id = $1 RETURNING pubkey',
    );
    expect((await store.listBlockedPubkeyRows(1))[0]?.blockedBy).toBe('staff');
    expect(sql.executes.some((entry) => entry.text.includes('INSERT INTO nostr_zapper'))).toBe(
      true,
    );
    expect(
      sql.queries.some((entry) => entry.text.includes('INSERT INTO nostr_blocked_pubkey')),
    ).toBe(true);
  });

  it('isZapperPubkey queries nostr_zapper by lower-cased pubkey', async () => {
    const sql = new MockSql();
    sql.nextRows = [{}];
    const store = new PostgresMessageStore(sql);
    expect(await store.isZapperPubkey('AA')).toBe(true);
    expect(sql.queries[0]?.text).toContain('SELECT 1 FROM nostr_zapper WHERE pubkey = $1 LIMIT 1');
    expect(sql.queries[0]?.params).toEqual(['aa']);
    sql.nextRows = [];
    expect(await store.isZapperPubkey('bb')).toBe(false);
  });

  it('blocks and hides external rows in one Postgres statement', async () => {
    const sql = new MockSql();
    const at = new Date('2026-09-18T12:00:00Z');
    sql.queryQueue = [[{ id: 'external-a' }, { id: 'external-b' }], [{ id: 'external-c' }]];
    const store = new PostgresMessageStore(sql);

    await expect(store.blockPubkeyAndHideRows('AA', at, 'staff', 'external-a')).resolves.toBe(2);
    await expect(store.blockPubkeyAndHideRows('aa', at, 'other', 'external-c')).resolves.toBe(1);
    expect(sql.queries).toHaveLength(2);
    for (const query of sql.queries) {
      expect(query.text).toContain('INSERT INTO nostr_blocked_pubkey');
      expect(query.text).toContain('ON CONFLICT (pubkey) DO NOTHING');
      expect(query.text).toContain('UPDATE message');
      expect(query.text).toContain('RETURNING id');
      expect(query.text).toContain('SELECT id FROM hidden');
    }
    expect(sql.queries[0]?.params).toEqual(['AA', at, 'staff', 'external-a']);
    expect(sql.queries[1]?.params).toEqual(['aa', at, 'other', 'external-c']);
    expect(sql.executes).toHaveLength(0);
  });

  it('preserves Postgres Date instances in external attribution rows', async () => {
    const sql = new MockSql();
    const receiptCreatedAt = new Date('2026-09-18T10:00:00Z');
    const zapperCreatedAt = new Date('2026-09-18T11:00:00Z');
    const blockedAt = new Date('2026-09-18T12:00:00Z');
    sql.queryQueue = [
      [
        {
          event_id: 'receipt-date',
          message_id: 'm1',
          sats: '21',
          created_at: receiptCreatedAt,
          receipt: 'invalid-json',
        },
      ],
      [
        {
          pubkey: 'aa',
          receipt_event_id: 'receipt-date',
          created_at: zapperCreatedAt,
        },
      ],
      [
        {
          pubkey: 'aa',
          blocked_at: blockedAt,
          blocked_by: 'staff',
          message_id: 'm-external-date',
        },
      ],
    ];
    const store = new PostgresMessageStore(sql);
    const receipts = await store.listUnattributedIndexedReceipts(1);
    expect(receipts[0]?.createdAt).toBe(receiptCreatedAt);
    expect(receipts[0]?.receipt).toEqual({});
    expect((await store.listZappers(1))[0]?.createdAt).toBe(zapperCreatedAt);
    expect((await store.listBlockedPubkeyRows(1))[0]?.blockedAt).toBe(blockedAt);
  });

  it('uses a strict keyset cursor for tied Postgres receipt listings', async () => {
    const sql = new MockSql();
    const tiedAt = new Date('2026-09-18T10:00:00Z');
    sql.queryQueue = [
      [
        {
          event_id: 'receipt-a',
          message_id: 'm1',
          sats: '21',
          created_at: tiedAt,
          receipt: { id: 'receipt-a' },
        },
      ],
      [{ pubkey: 'bb', receipt_event_id: 'receipt-z', created_at: tiedAt }],
      [
        {
          pubkey: 'dd',
          blocked_at: tiedAt,
          blocked_by: 'staff',
          message_id: 'external-d',
        },
      ],
    ];
    const store = new PostgresMessageStore(sql);

    expect(
      (
        await store.listUnattributedIndexedReceipts(1, {
          createdAt: tiedAt,
          eventId: 'receipt-z',
        })
      )[0]?.receiptEventId,
    ).toBe('receipt-a');
    expect((await store.listZappers(1))[0]?.pubkey).toBe('bb');
    expect((await store.listBlockedPubkeyRows(1))[0]?.pubkey).toBe('dd');
    expect(sql.queries[0]?.text).toContain('ORDER BY i.created_at DESC, r.event_id DESC');
    expect(sql.queries[0]?.text).toContain('(i.created_at, r.event_id) < ($2, $3)');
    expect(sql.queries[0]?.text).toContain('LIMIT $1');
    expect(sql.queries[0]?.text).not.toContain('OFFSET');
    expect(sql.queries[0]?.params).toEqual([1, tiedAt, 'receipt-z']);
    expect(sql.queries[1]?.text).toContain('ORDER BY created_at DESC, pubkey DESC');
    expect(sql.queries[2]?.text).toContain('ORDER BY blocked_at DESC, pubkey DESC');
  });

  it('allows idempotent re-attribution of a Postgres receipt and refreshes payer details', async () => {
    const sql = new MockSql();
    const original = {
      event_id: 'receipt-a',
      message_id: 'm1',
      sats: '21',
      payer_account_id: null,
      payer_pubkey: 'aa',
      zap_request_id: 'request-1',
      gift_reply_id: null,
      comment: 'first',
    };
    const updated = {
      ...original,
      payer_pubkey: 'bb',
      comment: 'updated',
    };
    sql.queryQueue = [[original], [{ event_id: 'receipt-a' }], [updated]];
    const store = new PostgresMessageStore(sql);
    expect((await store.getZapReceiptGift('receipt-a'))?.zapRequestId).toBe('request-1');

    await expect(
      store.attributeZapReceipt('receipt-a', {
        payerPubkey: 'BB',
        zapRequestId: 'request-1',
        comment: 'updated',
      }),
    ).resolves.toBe(true);
    expect(sql.queries[1]?.text).toContain('AND (zap_request_id IS NULL OR zap_request_id = $3)');
    expect(sql.queries[1]?.params).toEqual(['receipt-a', 'BB', 'request-1', 'updated']);
    expect(await store.getZapReceiptGift('receipt-a')).toEqual({
      receiptEventId: 'receipt-a',
      messageId: 'm1',
      sats: 21,
      payerAccountId: null,
      payerPubkey: 'bb',
      zapRequestId: 'request-1',
      giftReplyId: null,
      comment: 'updated',
    });
  });

  it('rejects a different request id for an attributed Postgres receipt without changes', async () => {
    const sql = new MockSql();
    const original = {
      event_id: 'receipt-a',
      message_id: 'm1',
      sats: '21',
      payer_account_id: null,
      payer_pubkey: 'aa',
      zap_request_id: 'request-1',
      gift_reply_id: null,
      comment: 'first',
    };
    sql.queryQueue = [[original], [], [original]];
    const store = new PostgresMessageStore(sql);
    const before = await store.getZapReceiptGift('receipt-a');
    expect(before).toMatchObject({
      payerPubkey: 'aa',
      zapRequestId: 'request-1',
      comment: 'first',
    });

    await expect(
      store.attributeZapReceipt('receipt-a', {
        payerPubkey: 'BB',
        zapRequestId: 'request-2',
        comment: 'replacement',
      }),
    ).resolves.toBe(false);
    expect(sql.queries[1]?.text).toContain('AND (zap_request_id IS NULL OR zap_request_id = $3)');
    expect(sql.queries[1]?.params).toEqual(['receipt-a', 'BB', 'request-2', 'replacement']);
    expect(await store.getZapReceiptGift('receipt-a')).toEqual(before);
  });

  it('returns false without attributing when another receipt holds the request id', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    const store = new PostgresMessageStore(sql);
    await expect(
      store.attributeZapReceipt('receipt-b', {
        payerPubkey: 'bb',
        zapRequestId: 'replayed',
        comment: '',
      }),
    ).resolves.toBe(false);
    expect(sql.queries).toHaveLength(1);
    expect(sql.queries[0]?.text).toMatch(
      /NOT EXISTS \([\s\S]*other\.zap_request_id = \$3 AND other\.event_id <> \$1/,
    );
    expect(sql.executes).toEqual([]);
  });

  it('returns false when the attribution update hits a unique violation', async () => {
    const sql = new MockSql();
    sql.queryError = { code: '23505' };
    const store = new PostgresMessageStore(sql);
    await expect(
      store.attributeZapReceipt('receipt-b', {
        payerPubkey: 'bb',
        zapRequestId: 'replayed',
        comment: '',
      }),
    ).resolves.toBe(false);
  });

  it('propagates a non-unique attribution update error', async () => {
    const sql = new MockSql();
    sql.queryError = new Error('attribute boom');
    const store = new PostgresMessageStore(sql);
    await expect(
      store.attributeZapReceipt('receipt-b', {
        payerPubkey: 'bb',
        zapRequestId: 'request-b',
        comment: '',
      }),
    ).rejects.toThrow('attribute boom');
  });

  it('listAuthoredMessages filters account_id without LIMIT', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    const store = new PostgresMessageStore(sql);
    await store.listAuthoredMessages('acc');
    expect(sql.queries[0]?.text).toContain('WHERE account_id = $1');
    expect(sql.queries[0]?.text).not.toContain('LIMIT');
    expect(sql.queries[0]?.params).toEqual(['acc']);
  });
});
