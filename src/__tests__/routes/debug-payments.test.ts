import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import {
  InMemoryMessageStore,
  type MessageInvoiceAttempt,
  type ZapIngestRow,
} from '@/lib/message-store';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryNotificationStore } from '@/lib/notification-store';
import { InMemoryPushStore } from '@/lib/push-store';
import { InMemoryFundingStore } from '@/lib/funding-store';
import { debugPaymentsRoutes } from '@/routes/debug-payments';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

function mount(
  store: InMemoryMessageStore,
  debugToken: string | undefined,
  extra: {
    spendPing?: {
      ping: (
        address: string,
        messageId: string,
        kind?: 'daily' | 'moderator' | 'welcome',
      ) => Promise<void>;
    };
    fundingStore?: InMemoryFundingStore;
    auth?: InMemoryAuthStore;
    now?: () => number;
  } = {},
): Hono {
  return new Hono().route(
    '/debug',
    debugPaymentsRoutes({
      store,
      auth: extra.auth ?? new InMemoryAuthStore(),
      now: extra.now ?? (() => Date.parse('2026-09-18T12:00:00.000Z')),
      debugToken,
      ...(extra.spendPing === undefined ? {} : { spendPing: extra.spendPing }),
      ...(extra.fundingStore === undefined ? {} : { fundingStore: extra.fundingStore }),
    }),
  );
}

function account(partial: Pick<Account, 'id' | 'role'> & Partial<Account>): Account {
  return {
    linkingKey: null,
    name: partial.name ?? partial.id,
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    location: null,
    viewKey: `${partial.id.replace(/-/g, '')}${'a'.repeat(64)}`.slice(0, 64),
    createdAt: 1,
    rulesAgreedAt: 1,
    ...partial,
  };
}

const SPEND_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const SPEND_PHOTO = { contentType: 'image/jpeg' as const, bytes: SPEND_JPEG };
const SPEND_NOW = (): number => Date.parse('2026-09-30T12:00:00.000Z');
const SPEND_CREATED_AT = new Date('2026-09-30T08:00:00.000Z');
const SPEND_HEADERS = {
  authorization: 'Bearer secret',
  'content-type': 'application/json',
};

function spendPingMock(): { ping: ReturnType<typeof vi.fn> } {
  return { ping: vi.fn(async () => undefined) };
}

async function seedSettleInvoice(
  store: InMemoryMessageStore,
  paymentHash: string,
  overrides: Partial<MessageInvoiceAttempt> = {},
): Promise<void> {
  if (overrides.messageId !== 'missing') {
    await store.create({
      id: overrides.messageId ?? 'settle-message',
      accountId: 'settle-author',
      name: 'Ada',
      text: 'paid note',
      createdAt: new Date('2026-09-18T10:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
  }
  await store.recordInvoiceAttempt({
    id: 'settle-invoice',
    createdAt: new Date('2026-09-18T11:00:00.000Z'),
    messageId: 'settle-message',
    payerAccountId: 'settle-payer',
    authorAccountId: 'settle-author',
    amountSats: 210_000,
    lightningAddress: 'ada@example.com',
    zapRequest: { content: 'Thank you' },
    result: 'ok',
    httpStatus: 200,
    pr: 'lnbc-settle',
    paymentHash,
    description: null,
    descriptionHash: null,
    isNip57Invoice: true,
    lnurlResponse: null,
    ...overrides,
  });
}

describe('debugPaymentsRoutes', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns 503 when debug is not configured', async () => {
    const app = mount(new InMemoryMessageStore(), undefined);
    const invoices = await app.request('/debug/invoices');
    expect(invoices.status).toBe(503);
    expect(await invoices.json()).toEqual({ error: 'Debug is not configured' });
    const ingests = await app.request('/debug/zap-ingests');
    expect(ingests.status).toBe(503);
    expect(await ingests.json()).toEqual({ error: 'Debug is not configured' });
    const settle = await app.request('/debug/invoices/settle', { method: 'POST' });
    expect(settle.status).toBe(503);
  });

  it('returns 503 when the token is blank', async () => {
    const app = mount(new InMemoryMessageStore(), '  ');
    const invoices = await app.request('/debug/invoices', {
      headers: { authorization: 'Bearer   ' },
    });
    expect(invoices.status).toBe(503);
    const ingests = await app.request('/debug/zap-ingests', {
      headers: { authorization: 'Bearer   ' },
    });
    expect(ingests.status).toBe(503);
    const settle = await app.request('/debug/invoices/settle', {
      method: 'POST',
      headers: { authorization: 'Bearer   ' },
    });
    expect(settle.status).toBe(503);
  });

  it('returns 401 without a matching bearer on both paths', async () => {
    const app = mount(new InMemoryMessageStore(), 'secret');
    const invoices = await app.request('/debug/invoices');
    expect(invoices.status).toBe(401);
    expect(await invoices.json()).toEqual({ error: 'Unauthorized' });
    const ingests = await app.request('/debug/zap-ingests');
    expect(ingests.status).toBe(401);
    expect(await ingests.json()).toEqual({ error: 'Unauthorized' });
    const settle = await app.request('/debug/invoices/settle', { method: 'POST' });
    expect(settle.status).toBe(401);
  });

  it('lists invoice attempts newest-first with ISO dates', async () => {
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
      pr: 'lnbc21n1test',
      paymentHash: 'aa'.repeat(32),
      description: null,
      descriptionHash: 'bb'.repeat(32),
      isNip57Invoice: true,
      lnurlResponse: null,
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
    await store.recordInvoiceAttempt(early);
    await store.recordInvoiceAttempt(late);
    const app = mount(store, 'secret');
    const res = await app.request('/debug/invoices', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      invoices: Array<Record<string, unknown>>;
    };
    expect(body.invoices).toHaveLength(2);
    expect(body.invoices[0]?.['id']).toBe('inv-b');
    expect(body.invoices[0]?.['createdAt']).toBe('2026-08-02T00:00:00.000Z');
    expect(body.invoices[0]?.['result']).toBe('noZap');
    expect(body.invoices[0]?.['pr']).toBeNull();
    expect(body.invoices[0]?.['isNip57Invoice']).toBe(false);
    expect(body.invoices[1]?.['pr']).toBe('lnbc21n1test');
    expect(body.invoices[1]?.['isNip57Invoice']).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/nsec/i);
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.invoices.listed')).toBe(true);
  });

  it('lists zap ingest rows newest-first with ISO dates', async () => {
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
    const app = mount(store, 'secret');
    const res = await app.request('/debug/zap-ingests', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ingests: Array<Record<string, unknown>>;
    };
    expect(body.ingests).toHaveLength(2);
    expect(body.ingests[0]?.['id']).toBe('zi-b');
    expect(body.ingests[0]?.['createdAt']).toBe('2026-08-02T00:00:00.000Z');
    expect(body.ingests[0]?.['outcome']).toBe('indexed');
    expect(body.ingests[0]?.['amountSats']).toBe(21);
    expect(body.ingests[1]?.['reason']).toBe('sig');
    expect(JSON.stringify(body)).not.toMatch(/nsec/i);
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.zap_ingests.listed')).toBe(true);
  });

  it('validates the manual-settle body and note', async () => {
    const app = mount(new InMemoryMessageStore(), 'secret');
    const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };
    for (const body of [
      '{',
      '[]',
      '{}',
      '{"paymentHash":1,"note":"proof"}',
      `{"paymentHash":"${'aa'.repeat(32)}","note":1}`,
      `{"paymentHash":"${'aa'.repeat(32)}","note":"proof","preimage":1}`,
    ]) {
      const res = await app.request('/debug/invoices/settle', { method: 'POST', headers, body });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid body' });
    }
    const invalidNote = await app.request('/debug/invoices/settle', {
      method: 'POST',
      headers,
      body: JSON.stringify({ paymentHash: 'aa'.repeat(32), note: '   ' }),
    });
    expect(invalidNote.status).toBe(400);
    expect(await invalidNote.json()).toEqual({ error: 'Invalid note' });
  });

  it('maps manual-settle validation and lookup failures', async () => {
    const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };
    const emptyApp = mount(new InMemoryMessageStore(), 'secret');
    const shape = await emptyApp.request('/debug/invoices/settle', {
      method: 'POST',
      headers,
      body: JSON.stringify({ paymentHash: 'bad', note: 'operator proof' }),
    });
    expect(shape.status).toBe(400);
    expect(await shape.json()).toEqual({ error: 'Invalid payment hash or preimage' });

    const mismatch = await emptyApp.request('/debug/invoices/settle', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        paymentHash: 'aa'.repeat(32),
        note: 'operator proof',
        preimage: 'bb'.repeat(32),
      }),
    });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toEqual({ error: 'Preimage does not match payment hash' });

    const missingInvoice = await emptyApp.request('/debug/invoices/settle', {
      method: 'POST',
      headers,
      body: JSON.stringify({ paymentHash: 'aa'.repeat(32), note: 'operator proof' }),
    });
    expect(missingInvoice.status).toBe(404);
    expect(await missingInvoice.json()).toEqual({ error: 'Invoice not found' });

    const conversationStore = new InMemoryMessageStore();
    await seedSettleInvoice(conversationStore, 'cc'.repeat(32), {
      conversationId: 'conversation',
    });
    const conversation = await mount(conversationStore, 'secret').request(
      '/debug/invoices/settle',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ paymentHash: 'cc'.repeat(32), note: 'operator proof' }),
      },
    );
    expect(conversation.status).toBe(409);
    expect(await conversation.json()).toEqual({
      error: 'Conversation invoices cannot be settled',
    });

    const missingMessageStore = new InMemoryMessageStore();
    await seedSettleInvoice(missingMessageStore, 'dd'.repeat(32), { messageId: 'missing' });
    const missingMessage = await mount(missingMessageStore, 'secret').request(
      '/debug/invoices/settle',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ paymentHash: 'dd'.repeat(32), note: 'operator proof' }),
      },
    );
    expect(missingMessage.status).toBe(404);
    expect(await missingMessage.json()).toEqual({ error: 'Message not found' });
  });

  it('settles with optional preimage and rejects a second settle', async () => {
    const store = new InMemoryMessageStore();
    const preimage = '00'.repeat(32);
    const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
    await seedSettleInvoice(store, paymentHash);
    const app = mount(store, 'secret', { fundingStore: new InMemoryFundingStore() });
    const request = {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ paymentHash, note: ' Wallet evidence ', preimage }),
    };
    const settled = await app.request('/debug/invoices/settle', request);
    expect(settled.status).toBe(200);
    expect(await settled.json()).toMatchObject({
      messageId: 'settle-message',
      amountSats: 210_000,
      resumed: false,
    });
    expect((await store.getById('settle-message'))?.sats).toBe(210_000);
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.invoices.settled')).toBe(true);

    const duplicate = await app.request('/debug/invoices/settle', request);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: 'Already settled' });
  });

  it('does not spendPing on an ineligible debug settle', async () => {
    const store = new InMemoryMessageStore();
    const paymentHash = 'ab'.repeat(32);
    await seedSettleInvoice(store, paymentHash);
    const spendPing = { ping: vi.fn(async () => undefined) };
    const app = mount(store, 'secret', { spendPing });
    const settled = await app.request('/debug/invoices/settle', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ paymentHash, note: 'Wallet evidence' }),
    });
    expect(settled.status).toBe(200);
    expect(spendPing.ping).not.toHaveBeenCalled();
  });

  it('returns resumed true when a failed ingest write is retried', async () => {
    class FailingIngestStore extends InMemoryMessageStore {
      failIngest = true;

      override recordZapIngest(row: ZapIngestRow): Promise<void> {
        if (this.failIngest) {
          this.failIngest = false;
          return Promise.reject(new Error('ingest persist boom'));
        }
        return super.recordZapIngest(row);
      }
    }
    const store = new FailingIngestStore();
    const paymentHash = 'ac'.repeat(32);
    await seedSettleInvoice(store, paymentHash);
    const app = mount(store, 'secret');
    const request = {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ paymentHash, note: 'Wallet evidence' }),
    };

    const failed = await app.request('/debug/invoices/settle', request);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: 'Messages are unavailable' });
    expect((await store.getById('settle-message'))?.sats).toBe(210_000);

    const resumed = await app.request('/debug/invoices/settle', request);
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({
      messageId: 'settle-message',
      amountSats: 210_000,
      resumed: true,
    });
    expect((await store.getById('settle-message'))?.sats).toBe(210_000);
    expect(await store.listZapIngests(10)).toHaveLength(1);
  });

  it('passes the optional push and notification stores to manual settle', async () => {
    const store = new InMemoryMessageStore();
    const paymentHash = 'ab'.repeat(32);
    await seedSettleInvoice(store, paymentHash);
    const app = new Hono().route(
      '/debug',
      debugPaymentsRoutes({
        store,
        auth: new InMemoryAuthStore(),
        now: () => Date.parse('2026-09-18T12:00:00.000Z'),
        debugToken: 'secret',
        pushStore: new InMemoryPushStore(),
        notificationStore: new InMemoryNotificationStore(),
      }),
    );
    const settled = await app.request('/debug/invoices/settle', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ paymentHash, note: 'Wallet evidence' }),
    });
    expect(settled.status).toBe(200);
    expect((await store.getById('settle-message'))?.sats).toBe(210_000);
  });

  it('returns 503 when manual settle throws', async () => {
    class ThrowingStore extends InMemoryMessageStore {
      override findOkInvoiceByPaymentHash(): Promise<never> {
        return Promise.reject(new Error('settle boom'));
      }
    }
    const app = mount(new ThrowingStore(), 'secret');
    const res = await app.request('/debug/invoices/settle', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ paymentHash: 'aa'.repeat(32), note: 'operator proof' }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.invoices.settle_failed')).toBe(
      true,
    );
  });

  it('returns 503 when listing invoices or ingests throws', async () => {
    const boom = async (): Promise<never> => {
      throw new Error('list boom');
    };
    const store = {
      listInvoiceAttempts: boom,
      listZapIngests: boom,
      listDebug: boom,
      postCountsByUtcDay: boom,
    } as unknown as InMemoryMessageStore;
    const app = mount(store, 'secret');
    const invoices = await app.request('/debug/invoices', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(invoices.status).toBe(503);
    expect(await invoices.json()).toEqual({ error: 'Messages are unavailable' });
    const ingests = await app.request('/debug/zap-ingests', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(ingests.status).toBe(503);
    expect(await ingests.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.invoices.list_failed')).toBe(true);
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.zap_ingests.list_failed')).toBe(
      true,
    );
  });

  it('replays today daily spend ping for a qualifying top-level photo post', async () => {
    const messageId = '11111111-1111-4111-8111-111111111111';
    const accountId = 'a1111111-1111-4111-8111-111111111111';
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await auth.createAccount(
      account({
        id: accountId,
        role: 'verified',
        name: 'Ada',
        lightningAddress: 'ada@example.com',
      }),
    );
    await store.create(
      {
        id: messageId,
        accountId,
        name: 'Ada',
        text: 'photo',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    const spendPing = spendPingMock();
    const app = mount(store, 'secret', { spendPing, auth, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(202);
    const json: unknown = await res.json();
    expect(json).toEqual({ messageId });
    expect(JSON.stringify(json)).not.toContain('ada@example.com');
    expect(spendPing.ping).toHaveBeenCalledTimes(1);
    expect(spendPing.ping.mock.calls[0]).toEqual(['ada@example.com', messageId, 'daily', 'none']);
    const sent = parsedEvents(warn).find((e) => e['event'] === 'debug.spend_ping.sent');
    expect(sent?.['messageId']).toBe(messageId);
    expect(sent).not.toHaveProperty('address');
    expect(JSON.stringify(sent)).not.toContain('ada@example.com');
  });

  it('returns 503 for spend-ping when debug is not configured', async () => {
    const spendPing = spendPingMock();
    const app = mount(new InMemoryMessageStore(), undefined, { spendPing });
    const res = await app.request('/debug/spend-ping', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Debug is not configured' });
    expect(spendPing.ping).not.toHaveBeenCalled();
  });

  it('returns 503 for spend-ping when the token is blank', async () => {
    const spendPing = spendPingMock();
    const app = mount(new InMemoryMessageStore(), '  ', { spendPing });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: { authorization: 'Bearer   ' },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Debug is not configured' });
    expect(spendPing.ping).not.toHaveBeenCalled();
  });

  it('returns 401 for spend-ping without a bearer', async () => {
    const spendPing = spendPingMock();
    const app = mount(new InMemoryMessageStore(), 'secret', { spendPing });
    const res = await app.request('/debug/spend-ping', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(spendPing.ping).not.toHaveBeenCalled();
  });

  it('returns 503 when spend ping is not configured', async () => {
    const app = mount(new InMemoryMessageStore(), 'secret');
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId: '22222222-2222-4222-8222-222222222222' }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Spend ping is not configured' });
  });

  it('rejects malformed spend-ping bodies', async () => {
    const spendPing = spendPingMock();
    const app = mount(new InMemoryMessageStore(), 'secret', { spendPing });
    for (const body of ['{', '"x"', '[1]', '{"messageId":1}', '{"messageId":"not-a-uuid"}']) {
      const res = await app.request('/debug/spend-ping', {
        method: 'POST',
        headers: SPEND_HEADERS,
        body,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid body' });
    }
    expect(spendPing.ping).not.toHaveBeenCalled();
  });

  it('returns 404 when the spend-ping message is missing', async () => {
    const spendPing = spendPingMock();
    const app = mount(new InMemoryMessageStore(), 'secret', { spendPing });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId: '33333333-3333-4333-8333-333333333333' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(spendPing.ping).not.toHaveBeenCalled();
  });

  it('returns 409 when the spend-ping message is hidden', async () => {
    const messageId = '44444444-4444-4444-8444-444444444444';
    const store = new InMemoryMessageStore();
    await store.create(
      {
        id: messageId,
        accountId: 'hidden-author',
        name: 'Ada',
        text: 'photo',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    await store.markDeleted(messageId, new Date(), 'staff');
    const spendPing = spendPingMock();
    const app = mount(store, 'secret', { spendPing, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Message is hidden' });
    expect(spendPing.ping).not.toHaveBeenCalled();
  });

  it('returns 409 when the spend-ping target is a reply', async () => {
    const parentId = '55555555-5555-4555-8555-555555555555';
    const messageId = '66666666-6666-4666-8666-666666666666';
    const store = new InMemoryMessageStore();
    await store.create({
      id: parentId,
      accountId: 'reply-author',
      name: 'Ada',
      text: 'parent',
      createdAt: SPEND_CREATED_AT,
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await store.create(
      {
        id: messageId,
        accountId: 'reply-author',
        name: 'Ada',
        text: 'reply',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        parentId,
      },
      SPEND_PHOTO,
    );
    const spendPing = spendPingMock();
    const app = mount(store, 'secret', { spendPing, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Replies are not paid' });
    expect(spendPing.ping).not.toHaveBeenCalled();
  });

  it('returns 404 when the spend-ping row has a null accountId', async () => {
    const messageId = '77777777-7777-4777-8777-777777777777';
    class NullAccountIdStore extends InMemoryMessageStore {
      override async getById(id: string): ReturnType<InMemoryMessageStore['getById']> {
        const row = await super.getById(id);
        return row === undefined ? undefined : { ...row, accountId: null };
      }
    }
    const store = new NullAccountIdStore();
    await store.create(
      {
        id: messageId,
        accountId: 'null-account',
        name: 'Ada',
        text: 'photo',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    const spendPing = spendPingMock();
    const app = mount(store, 'secret', { spendPing, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Account not found' });
    expect(spendPing.ping).not.toHaveBeenCalled();
  });

  it('returns 404 when the spend-ping account was never inserted', async () => {
    const messageId = '88888888-8888-4888-8888-888888888888';
    const store = new InMemoryMessageStore();
    await store.create(
      {
        id: messageId,
        accountId: 'b1111111-1111-4111-8111-111111111111',
        name: 'Ada',
        text: 'photo',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    const spendPing = spendPingMock();
    const app = mount(store, 'secret', { spendPing, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Account not found' });
    expect(spendPing.ping).not.toHaveBeenCalled();
  });

  it('returns 503 when spend-ping getById throws', async () => {
    const messageId = '99999999-9999-4999-8999-999999999999';
    class ThrowingGetByIdStore extends InMemoryMessageStore {
      override getById(): ReturnType<InMemoryMessageStore['getById']> {
        return Promise.reject(new Error('get boom'));
      }
    }
    const spendPing = spendPingMock();
    const app = mount(new ThrowingGetByIdStore(), 'secret', { spendPing });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.spend_ping.failed')).toBe(true);
    expect(spendPing.ping).not.toHaveBeenCalled();
  });

  it('returns 503 when spend-ping getAccount throws', async () => {
    const messageId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const accountId = 'c1111111-1111-4111-8111-111111111111';
    class ThrowingAuthStore extends InMemoryAuthStore {
      override getAccount(): ReturnType<InMemoryAuthStore['getAccount']> {
        return Promise.reject(new Error('auth boom'));
      }
    }
    const store = new InMemoryMessageStore();
    await store.create(
      {
        id: messageId,
        accountId,
        name: 'Ada',
        text: 'photo',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    const spendPing = spendPingMock();
    const app = mount(store, 'secret', {
      spendPing,
      auth: new ThrowingAuthStore(),
      now: SPEND_NOW,
    });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.spend_ping.failed')).toBe(true);
    expect(spendPing.ping).not.toHaveBeenCalled();
  });

  it('returns 409 when the spend-ping target is the profile note', async () => {
    const messageId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const accountId = 'd1111111-1111-4111-8111-111111111111';
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await auth.createAccount(
      account({
        id: accountId,
        role: 'verified',
        name: 'Ada',
        lightningAddress: 'ada@example.com',
        profileMessageId: messageId,
      }),
    );
    await store.create(
      {
        id: messageId,
        accountId,
        name: 'Ada',
        text: 'about',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    const spendPing = spendPingMock();
    const app = mount(store, 'secret', { spendPing, auth, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Profile notes are not paid' });
    expect(spendPing.ping).not.toHaveBeenCalled();
  });

  it('returns 409 when the spend-ping message is not from today', async () => {
    const messageId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const accountId = 'e1111111-1111-4111-8111-111111111111';
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await auth.createAccount(
      account({
        id: accountId,
        role: 'verified',
        name: 'Ada',
        lightningAddress: 'ada@example.com',
      }),
    );
    await store.create(
      {
        id: messageId,
        accountId,
        name: 'Ada',
        text: 'photo',
        createdAt: new Date('2026-09-29T08:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    const spendPing = spendPingMock();
    const app = mount(store, 'secret', { spendPing, auth, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Message is not from today' });
    expect(spendPing.ping).not.toHaveBeenCalled();
  });

  it('returns 409 when the spend-ping account has no Lightning address', async () => {
    const messageId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const accountId = 'f1111111-1111-4111-8111-111111111111';
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await auth.createAccount(account({ id: accountId, role: 'verified', name: 'Ada' }));
    await store.create(
      {
        id: messageId,
        accountId,
        name: 'Ada',
        text: 'photo',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    const spendPing = spendPingMock();
    const app = mount(store, 'secret', { spendPing, auth, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'No Lightning address' });
    expect(spendPing.ping).not.toHaveBeenCalled();
  });

  it('returns 409 when the spend-ping Lightning address is blank', async () => {
    const messageId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const accountId = 'a2222222-2222-4222-8222-222222222222';
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await auth.createAccount(
      account({
        id: accountId,
        role: 'verified',
        name: 'Ada',
        lightningAddress: '   ',
      }),
    );
    await store.create(
      {
        id: messageId,
        accountId,
        name: 'Ada',
        text: 'photo',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    const spendPing = spendPingMock();
    const app = mount(store, 'secret', { spendPing, auth, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'No Lightning address' });
    expect(spendPing.ping).not.toHaveBeenCalled();
  });

  it('returns 403 when the spend-ping account is not eligible', async () => {
    const messageId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const accountId = 'b2222222-2222-4222-8222-222222222222';
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await auth.createAccount(
      account({
        id: accountId,
        role: 'basis',
        name: 'Ada',
        lightningAddress: 'ada@example.com',
      }),
    );
    await store.create(
      {
        id: messageId,
        accountId,
        name: 'Ada',
        text: 'photo',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    const spendPing = spendPingMock();
    const app = mount(store, 'secret', { spendPing, auth, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(403);
    const json: unknown = await res.json();
    expect(json).toEqual({ error: 'Not eligible' });
    expect(JSON.stringify(json)).not.toContain('ada@example.com');
    const skipped = parsedEvents(warn).find((e) => e['event'] === 'debug.spend_ping.skipped');
    expect(skipped?.['reason']).toBe('not_eligible');
    expect(skipped?.['messageId']).toBe(messageId);
    expect(skipped).not.toHaveProperty('address');
    expect(spendPing.ping).not.toHaveBeenCalled();
  });

  it('returns 409 when the spend-ping message has no media', async () => {
    const messageId = '12121212-1212-4121-8121-121212121212';
    const accountId = 'c2222222-2222-4222-8222-222222222222';
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await auth.createAccount(
      account({
        id: accountId,
        role: 'verified',
        name: 'Ada',
        lightningAddress: 'ada@example.com',
      }),
    );
    await store.create({
      id: messageId,
      accountId,
      name: 'Ada',
      text: 'text only',
      createdAt: SPEND_CREATED_AT,
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const spendPing = spendPingMock();
    const app = mount(store, 'secret', { spendPing, auth, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Message has no media' });
    const skipped = parsedEvents(warn).find((e) => e['event'] === 'debug.spend_ping.skipped');
    expect(skipped?.['reason']).toBe('no_media');
    expect(skipped?.['messageId']).toBe(messageId);
    expect(spendPing.ping).not.toHaveBeenCalled();
  });

  it('replays spend ping when getById reports video without a photo', async () => {
    const messageId = '13131313-1313-4131-8131-131313131313';
    const accountId = 'd2222222-2222-4222-8222-222222222222';
    class VideoRowStore extends InMemoryMessageStore {
      override async getById(id: string): ReturnType<InMemoryMessageStore['getById']> {
        const row = await super.getById(id);
        return row === undefined
          ? undefined
          : { ...row, hasPhoto: false, hasVideo: true, photoCount: 0 };
      }
    }
    const store = new VideoRowStore();
    const auth = new InMemoryAuthStore();
    await auth.createAccount(
      account({
        id: accountId,
        role: 'verified',
        name: 'Ada',
        lightningAddress: 'ada@example.com',
      }),
    );
    await store.create({
      id: messageId,
      accountId,
      name: 'Ada',
      text: 'video',
      createdAt: SPEND_CREATED_AT,
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const spendPing = spendPingMock();
    const app = mount(store, 'secret', { spendPing, auth, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ messageId });
    expect(spendPing.ping).toHaveBeenCalledTimes(1);
    expect(spendPing.ping.mock.calls[0]).toEqual(['ada@example.com', messageId, 'daily', 'none']);
  });

  it('replays spend ping when getById reports photoCount without hasPhoto', async () => {
    const messageId = '14141414-1414-4141-8141-141414141414';
    const accountId = 'e2222222-2222-4222-8222-222222222222';
    class PhotoCountStore extends InMemoryMessageStore {
      override async getById(id: string): ReturnType<InMemoryMessageStore['getById']> {
        const row = await super.getById(id);
        return row === undefined
          ? undefined
          : { ...row, hasPhoto: false, hasVideo: false, photoCount: 1 };
      }
    }
    const store = new PhotoCountStore();
    const auth = new InMemoryAuthStore();
    await auth.createAccount(
      account({
        id: accountId,
        role: 'verified',
        name: 'Ada',
        lightningAddress: 'ada@example.com',
      }),
    );
    await store.create({
      id: messageId,
      accountId,
      name: 'Ada',
      text: 'stills',
      createdAt: SPEND_CREATED_AT,
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const spendPing = spendPingMock();
    const app = mount(store, 'secret', { spendPing, auth, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ messageId });
    expect(spendPing.ping).toHaveBeenCalledTimes(1);
  });

  it('replays spend ping when fundingStore has no grant', async () => {
    const messageId = '15151515-1515-4151-8151-151515151515';
    const accountId = 'f2222222-2222-4222-8222-222222222222';
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await auth.createAccount(
      account({
        id: accountId,
        role: 'verified',
        name: 'Ada',
        lightningAddress: 'ada@example.com',
      }),
    );
    await store.create(
      {
        id: messageId,
        accountId,
        name: 'Ada',
        text: 'photo',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    const spendPing = spendPingMock();
    const app = mount(store, 'secret', {
      spendPing,
      auth,
      now: SPEND_NOW,
      fundingStore: new InMemoryFundingStore(),
    });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ messageId });
    expect(spendPing.ping).toHaveBeenCalledTimes(1);
  });

  it('returns 503 when fundingStore getByAccountId throws', async () => {
    const messageId = '16161616-1616-4161-8161-161616161616';
    const accountId = 'a3333333-3333-4333-8333-333333333333';
    class ThrowingFundingStore extends InMemoryFundingStore {
      override getByAccountId(): ReturnType<InMemoryFundingStore['getByAccountId']> {
        return Promise.reject(new Error('grant boom'));
      }
    }
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await auth.createAccount(
      account({
        id: accountId,
        role: 'verified',
        name: 'Ada',
        lightningAddress: 'ada@example.com',
      }),
    );
    await store.create(
      {
        id: messageId,
        accountId,
        name: 'Ada',
        text: 'photo',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    const spendPing = spendPingMock();
    const app = mount(store, 'secret', {
      spendPing,
      auth,
      now: SPEND_NOW,
      fundingStore: new ThrowingFundingStore(),
    });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.spend_ping.failed')).toBe(true);
    expect(spendPing.ping).not.toHaveBeenCalled();
  });

  it('returns 503 when spend ping rejects', async () => {
    const messageId = '17171717-1717-4171-8171-171717171717';
    const accountId = 'b3333333-3333-4333-8333-333333333333';
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await auth.createAccount(
      account({
        id: accountId,
        role: 'verified',
        name: 'Ada',
        lightningAddress: 'ada@example.com',
      }),
    );
    await store.create(
      {
        id: messageId,
        accountId,
        name: 'Ada',
        text: 'photo',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    const spendPing = { ping: vi.fn(async () => Promise.reject(new Error('ping boom'))) };
    const app = mount(store, 'secret', { spendPing, auth, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(503);
    expect(res.status).not.toBe(202);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.spend_ping.failed')).toBe(true);
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.spend_ping.sent')).toBe(false);
  });
});
