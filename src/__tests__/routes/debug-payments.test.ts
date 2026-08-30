import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import {
  InMemoryMessageStore,
  type MessageInvoiceAttempt,
  type ZapIngestRow,
} from '@/lib/message-store';
import { debugPaymentsRoutes } from '@/routes/debug-payments';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

function mount(store: InMemoryMessageStore, debugToken: string | undefined): Hono {
  return new Hono().route('/debug', debugPaymentsRoutes({ store, debugToken }));
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
  });

  it('returns 401 without a matching bearer on both paths', async () => {
    const app = mount(new InMemoryMessageStore(), 'secret');
    const invoices = await app.request('/debug/invoices');
    expect(invoices.status).toBe(401);
    expect(await invoices.json()).toEqual({ error: 'Unauthorized' });
    const ingests = await app.request('/debug/zap-ingests');
    expect(ingests.status).toBe(401);
    expect(await ingests.json()).toEqual({ error: 'Unauthorized' });
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

  it('returns 503 when listing invoices or ingests throws', async () => {
    const boom = async (): Promise<never> => {
      throw new Error('list boom');
    };
    const store = {
      listInvoiceAttempts: boom,
      listZapIngests: boom,
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
