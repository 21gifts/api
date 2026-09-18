import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import {
  InMemoryMessageStore,
  type MessageInvoiceAttempt,
  type ZapIngestRow,
} from '@/lib/message-store';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryNotificationStore } from '@/lib/notification-store';
import { InMemoryPushStore } from '@/lib/push-store';
import { debugPaymentsRoutes } from '@/routes/debug-payments';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

function mount(store: InMemoryMessageStore, debugToken: string | undefined): Hono {
  return new Hono().route(
    '/debug',
    debugPaymentsRoutes({
      store,
      auth: new InMemoryAuthStore(),
      now: () => Date.parse('2026-09-18T12:00:00.000Z'),
      debugToken,
    }),
  );
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
    const app = mount(store, 'secret');
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
});
