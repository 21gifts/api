import { describe, it, expect } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import { unsignedNostrDefaults, type ForumPhoto, type MessageRow } from '@/lib/message';
import {
  InMemoryMessageStore,
  MESSAGE_SCHEMA_SQL,
  migrateMessageSchema,
  PostgresMessageStore,
  type MessageInvoiceAttempt,
  type ZapIngestRow,
} from '@/lib/message-store';

class MockSql implements SqlClient {
  executes: { text: string; params: readonly unknown[] }[] = [];
  queries: { text: string; params: readonly unknown[] }[] = [];
  nextRows: unknown[] = [];
  queryError: unknown | undefined;
  executeError: unknown | undefined;

  async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    this.queries.push({ text, params });
    if (this.queryError !== undefined) {
      throw this.queryError;
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

describe('MESSAGE_SCHEMA_SQL', () => {
  it('creates message with photo columns, Nostr columns, index, and additive ALTERs', () => {
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
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/CREATE TABLE IF NOT EXISTS message_invoice/i);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/CREATE TABLE IF NOT EXISTS nostr_zap_ingest/i);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/message_invoice_created_at_idx/i);
    expect(MESSAGE_SCHEMA_SQL.join('\n')).toMatch(/nostr_zap_ingest_receipt_id_idx/i);
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

  it('create then list returns the new row', async () => {
    const store = new InMemoryMessageStore();
    const created = await store.create(EARLY);
    expect(created.text).toBe('first');
    expect(created.hasPhoto).toBe(false);
    expect(created).not.toBe(EARLY);
    expect((await store.listLatest(10))[0]?.id).toBe('a');
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
    const atExpiry = await store.claimUnsigned(10, 2_000_000 + 60_000, 60_000);
    expect(atExpiry).toHaveLength(1);
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
    };
    const late: MessageInvoiceAttempt = {
      ...early,
      id: 'inv-b',
      createdAt: new Date('2026-08-02T00:00:00.000Z'),
      result: 'noZap',
      httpStatus: 400,
      pr: null,
      isNip57Invoice: false,
    };
    const tieHigh: MessageInvoiceAttempt = {
      ...early,
      id: 'inv-z',
      createdAt: new Date('2026-08-02T00:00:00.000Z'),
      result: 'unreachable',
    };
    await store.recordInvoiceAttempt(early);
    await store.recordInvoiceAttempt(late);
    await store.recordInvoiceAttempt(tieHigh);
    const listed = await store.listInvoiceAttempts(2);
    expect(listed.map((row) => row.id)).toEqual(['inv-z', 'inv-b']);
    if (listed[0] !== undefined) {
      listed[0].result = 'bad_body';
      listed[0].zapRequest = { mutated: true };
    }
    const again = await store.listInvoiceAttempts(10);
    expect(again.map((row) => row.id)).toEqual(['inv-z', 'inv-b', 'inv-a']);
    expect(again[0]?.result).toBe('unreachable');
    expect(again[0]?.zapRequest).toEqual({ kind: 9734 });
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
    await store.recordZapIngest(early);
    await store.recordZapIngest(late);
    const listed = await store.listZapIngests(1);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe('zi-b');
    if (listed[0] !== undefined) {
      listed[0].outcome = 'rejected';
      listed[0].receipt['mutated'] = true;
    }
    const again = await store.listZapIngests(10);
    expect(again.map((row) => row.id)).toEqual(['zi-b', 'zi-a']);
    expect(again[0]?.outcome).toBe('indexed');
    expect(again[0]?.receipt).toEqual({ id: 'r2', kind: 9735 });
  });
});

describe('PostgresMessageStore', () => {
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
      },
      {
        id: 'm2',
        account_id: 'acc',
        name: 'Bob',
        text: 'yo',
        created_at: '2026-08-27T12:00:00.000Z',
        has_photo: false,
      },
    ];
    const store = new PostgresMessageStore(sql);
    const listed = await store.listLatest(50);
    expect(sql.queries[0]?.text).toMatch(/has_photo/);
    expect(sql.queries[0]?.text).toMatch(/event_id/);
    expect(sql.queries[0]?.text).toMatch(
      /FROM message ORDER BY created_at DESC, id DESC LIMIT \$1/,
    );
    expect(sql.queries[0]?.text).not.toMatch(/SELECT[^;]*\bphoto\b(?!\s+IS\s+NOT\s+NULL)/i);
    expect(sql.queries[0]?.params).toEqual([50]);
    expect(listed[0]?.id).toBe('m1');
    expect(listed[0]?.hasPhoto).toBe(true);
    expect(listed[0]?.sats).toBe(0);
    expect(listed[1]?.id).toBe('m2');
    expect(listed[1]?.hasPhoto).toBe(false);
  });

  it('create binds seven params with null photo', async () => {
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
      /INSERT INTO message \(id, account_id, name, text, photo, photo_content_type, created_at, nostr_publish_state, sats\)/,
    );
    expect(sql.executes[0]?.text).not.toMatch(/ON CONFLICT/i);
    expect(sql.executes[0]?.params).toEqual([
      'm1',
      'acc',
      'Ada',
      'hello',
      null,
      null,
      row.createdAt,
    ]);
    expect(created).toEqual(row);
    expect(created).not.toBe(row);
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
    expect(mapped?.claimedUntil).toBe(Date.parse('2026-08-28T00:01:00.000Z'));
    sql.nextRows = [];
    expect(await store.claimUnsigned(5, 1_000, 60_000)).toEqual([]);
    expect(await store.claimUnpublished(5, 1_000, 60_000)).toEqual([]);
    expect(sql.queries.some((q) => /claimed_until <= \$2/.test(q.text))).toBe(true);
    expect(await store.updateSignedEvent('m1', 'ee'.repeat(32), { id: 'x' })).toBe(false);
    await store.updatePublishState('m1', 'published', 'public');
    await store.addSats('m1', 7);
    expect(sql.executes.some((e) => e.text.includes('sats = sats +'))).toBe(true);
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

  it('recordZapReceipt conflict returns false without sats update', async () => {
    const sql = new MockSql();
    sql.nextRows = [];
    const store = new PostgresMessageStore(sql);
    expect(await store.recordZapReceipt('r1', 'm1', 21)).toBe(false);
    expect(sql.executes).toEqual([]);
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
    expect(listSql).toMatch(/photo IS NOT NULL/);
    expect(listSql).toMatch(/sats = 0/);
    expect(listSql).toMatch(/nostr_publish_state = 'published'/);
    expect(listSql).toMatch(/\/messages\/' \|\| id::text \|\| '\/photo\./);
    await store.resetSignedEvent('m1', 'ab'.repeat(32));
    expect(sql.executes.at(-1)?.text).toMatch(/nostr_publish_state = 'pending'/);
    expect(sql.executes.at(-1)?.text).toMatch(/event_id IS NOT DISTINCT FROM/);
    expect(sql.executes.at(-1)?.text).toMatch(/sats = 0/);
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
    expect(listSql).toMatch(/nostr_publish_state = 'published'/);
    expect(listSql).toMatch(/jsonb_typeof\(nostr_event->'content'\) IS DISTINCT FROM 'string'/);
    expect(listSql).toMatch(/#21gifts\(\[^a-z0-9_\]\|\$\)/);
    expect(listSql).toMatch(/#bitcoin\(\[^a-z0-9_\]\|\$\)/);
    expect(listSql).toMatch(/ORDER BY created_at ASC,\s*id ASC/);
  });

  it('propagates getPhoto query errors', async () => {
    const sql = new MockSql();
    sql.queryError = new Error('photo boom');
    await expect(new PostgresMessageStore(sql).getPhoto('m1')).rejects.toThrow('photo boom');
  });

  it('recordInvoiceAttempt inserts into message_invoice with jsonb zap_request', async () => {
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
    };
    await store.recordInvoiceAttempt(row);
    expect(sql.executes).toHaveLength(1);
    expect(sql.executes[0]?.text).toMatch(/INSERT INTO message_invoice/);
    expect(sql.executes[0]?.text).toMatch(/zap_request/);
    expect(sql.executes[0]?.params[7]).toBe(JSON.stringify({ kind: 9734 }));
    expect(sql.executes[0]?.params[14]).toBe(true);
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
    };
    await store.recordInvoiceAttempt(row);
    expect(sql.executes[0]?.params[7]).toBeNull();
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
      },
    ];
    const store = new PostgresMessageStore(sql);
    const listed = await store.listInvoiceAttempts(50);
    expect(sql.queries[0]?.text).toMatch(/FROM message_invoice/);
    expect(sql.queries[0]?.text).toMatch(/ORDER BY created_at DESC, id DESC/);
    expect(sql.queries[0]?.text).toMatch(/LIMIT \$1/);
    expect(sql.queries[0]?.params).toEqual([50]);
    expect(listed[0]?.amountSats).toBe(21);
    expect(listed[0]?.zapRequest).toEqual({ kind: 9734 });
    expect(listed[0]?.isNip57Invoice).toBe(true);
    expect(listed[1]?.createdAt.toISOString()).toBe('2026-08-27T12:00:00.000Z');
    expect(listed[1]?.zapRequest).toEqual({ kind: 9734, content: 'x' });
    expect(listed[1]?.isNip57Invoice).toBe(false);
    expect(listed[2]?.zapRequest).toBeNull();
    expect(listed[3]?.zapRequest).toBeNull();
    expect(listed[4]?.zapRequest).toBeNull();
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
    expect(sql.executes[0]?.params[9]).toBe(JSON.stringify({ id: 'r1', kind: 9735 }));
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
});
