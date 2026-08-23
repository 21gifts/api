import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GIFT_INVOICE_MAX_MSAT } from '@/lib/config';
import { InMemoryInvoiceStore, type GiftInvoice } from '@/lib/invoice-store';
import { createApp } from '@/server';
import { decodeBolt11 } from '@/lib/bolt11';
import type { FetchFn } from '@/lib/lnurlp';

vi.mock('@/lib/bolt11', () => ({
  decodeBolt11: vi.fn(),
}));

const TOKEN = 'spend-secret-token';
const ADDRESS = 'alice@walletofsatoshi.com';
const PR = 'lnbc1issued';
const HASH = 'aa'.repeat(32);
const PREIMAGE = '11'.repeat(32);
const MATCHING_HASH = createHash('sha256').update(Buffer.from(PREIMAGE, 'hex')).digest('hex');
const MAX_SENDABLE = 100_000_000_000;

const mockedDecode = vi.mocked(decodeBolt11);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function happyFetch(): FetchFn {
  return async (input) => {
    if (String(input).includes('/.well-known/lnurlp/')) {
      return jsonResponse({
        callback: 'https://walletofsatoshi.com/lnurlp/callback',
        minSendable: 1000,
        maxSendable: MAX_SENDABLE,
        commentAllowed: 255,
      });
    }
    return jsonResponse({ pr: PR });
  };
}

function auth(init?: RequestInit): RequestInit {
  return {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      ...init?.headers,
    },
  };
}

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

describe('POST /invoices', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockedDecode.mockReset();
    mockedDecode.mockReturnValue({ paymentHash: HASH, amountMsat: 1000 });
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns 503 when the spend token is not configured', async () => {
    const res = await createApp().request('/invoices', {
      method: 'POST',
      body: JSON.stringify({ address: ADDRESS, amountMsat: 1000 }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Spend invoices are not configured' });
  });

  it('returns 401 when the bearer is missing', async () => {
    const res = await createApp({ spendApiToken: TOKEN }).request('/invoices', {
      method: 'POST',
      body: JSON.stringify({ address: ADDRESS, amountMsat: 1000 }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 on invalid JSON', async () => {
    const res = await createApp({ spendApiToken: TOKEN }).request(
      '/invoices',
      auth({ method: 'POST', body: 'not-json' }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 on a bad body', async () => {
    const res = await createApp({ spendApiToken: TOKEN }).request(
      '/invoices',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS }) }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 on a bad Lightning Address', async () => {
    const res = await createApp({ spendApiToken: TOKEN }).request(
      '/invoices',
      auth({ method: 'POST', body: JSON.stringify({ address: 'nope', amountMsat: 1000 }) }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Not a valid Lightning Address (expected name@domain)',
    });
  });

  it('returns 400 when amountMsat is below the api minimum', async () => {
    const res = await createApp({ spendApiToken: TOKEN }).request(
      '/invoices',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS, amountMsat: 1 }) }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when amountMsat is above the api maximum', async () => {
    const res = await createApp({ spendApiToken: TOKEN }).request(
      '/invoices',
      auth({
        method: 'POST',
        body: JSON.stringify({ address: ADDRESS, amountMsat: GIFT_INVOICE_MAX_MSAT + 1 }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 502 when LNURL-pay cannot issue an invoice', async () => {
    const fetchImpl: FetchFn = async () => jsonResponse({}, 500);
    const res = await createApp({ spendApiToken: TOKEN, fetchImpl }).request(
      '/invoices',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS, amountMsat: 1000 }) }),
    );
    expect(res.status).toBe(502);
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.issue_failed')).toBe(true);
  });

  it('returns 502 when bolt11 decode fails', async () => {
    mockedDecode.mockReturnValue(null);
    const res = await createApp({ spendApiToken: TOKEN, fetchImpl: happyFetch() }).request(
      '/invoices',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS, amountMsat: 1000 }) }),
    );
    expect(res.status).toBe(502);
  });

  it('returns 502 when the invoice amount does not match', async () => {
    mockedDecode.mockReturnValue({ paymentHash: HASH, amountMsat: 999 });
    const res = await createApp({ spendApiToken: TOKEN, fetchImpl: happyFetch() }).request(
      '/invoices',
      auth({ method: 'POST', body: JSON.stringify({ address: ADDRESS, amountMsat: 1000 }) }),
    );
    expect(res.status).toBe(502);
  });

  it('returns 200 with id, pr, paymentHash, amountMsat', async () => {
    const res = await createApp({ spendApiToken: TOKEN, fetchImpl: happyFetch() }).request(
      '/invoices',
      auth({
        method: 'POST',
        body: JSON.stringify({ address: ADDRESS, amountMsat: 1000, comment: '21gifts daily' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      pr: string;
      paymentHash: string;
      amountMsat: number;
    };
    expect(body.pr).toBe(PR);
    expect(body.paymentHash).toBe(HASH);
    expect(body.amountMsat).toBe(1000);
    expect(body.id).toMatch(/^[0-9a-f]{32}$/);
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.issued')).toBe(true);
  });
});

describe('POST /invoices/proof', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let store: InMemoryInvoiceStore;

  function unpaid(overrides?: Partial<GiftInvoice>): GiftInvoice {
    return {
      id: 'ab'.repeat(16),
      pr: PR,
      paymentHash: MATCHING_HASH,
      amountMsat: 1000,
      createdAt: 1,
      expiresAt: 1_000_000,
      ...overrides,
    };
  }

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    store = new InMemoryInvoiceStore();
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('returns 503 when unconfigured', async () => {
    const res = await createApp().request('/invoices/proof', {
      method: 'POST',
      body: JSON.stringify({ id: 'x', preimage: PREIMAGE }),
    });
    expect(res.status).toBe(503);
  });

  it('returns 401 when unauthorized', async () => {
    const res = await createApp({ spendApiToken: TOKEN }).request('/invoices/proof', {
      method: 'POST',
      body: JSON.stringify({ id: 'x', preimage: PREIMAGE }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 on invalid JSON', async () => {
    const res = await createApp({ spendApiToken: TOKEN, invoiceStore: store }).request(
      '/invoices/proof',
      auth({ method: 'POST', body: 'nope' }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 on a bad body', async () => {
    const res = await createApp({ spendApiToken: TOKEN, invoiceStore: store }).request(
      '/invoices/proof',
      auth({ method: 'POST', body: JSON.stringify({ preimage: PREIMAGE }) }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await createApp({ spendApiToken: TOKEN, invoiceStore: store }).request(
      '/invoices/proof',
      auth({ method: 'POST', body: JSON.stringify({ id: 'missing', preimage: PREIMAGE }) }),
    );
    expect(res.status).toBe(404);
  });

  it('returns 409 when the invoice expired unpaid', async () => {
    store.put(unpaid({ expiresAt: 10 }));
    const res = await createApp({
      spendApiToken: TOKEN,
      invoiceStore: store,
      now: () => 11,
    }).request(
      '/invoices/proof',
      auth({ method: 'POST', body: JSON.stringify({ id: unpaid().id, preimage: PREIMAGE }) }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Invoice expired' });
  });

  it('returns 400 when the preimage does not match', async () => {
    store.put(unpaid());
    const res = await createApp({
      spendApiToken: TOKEN,
      invoiceStore: store,
      now: () => 100,
    }).request(
      '/invoices/proof',
      auth({
        method: 'POST',
        body: JSON.stringify({ id: unpaid().id, preimage: '22'.repeat(32) }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Proof does not match invoice' });
  });

  it('returns 200 and stores the preimage on a matching proof', async () => {
    store.put(unpaid());
    const res = await createApp({
      spendApiToken: TOKEN,
      invoiceStore: store,
      now: () => 100,
    }).request(
      '/invoices/proof',
      auth({ method: 'POST', body: JSON.stringify({ id: unpaid().id, preimage: PREIMAGE }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'paid',
      id: unpaid().id,
      paymentHash: MATCHING_HASH,
    });
    expect(store.get(unpaid().id)?.paidAt).toBe(100);
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.paid')).toBe(true);
  });

  it('returns 200 idempotently for the same preimage', async () => {
    store.put(unpaid({ paidAt: 5, preimage: PREIMAGE }));
    const res = await createApp({
      spendApiToken: TOKEN,
      invoiceStore: store,
      now: () => 100,
    }).request(
      '/invoices/proof',
      auth({ method: 'POST', body: JSON.stringify({ id: unpaid().id, preimage: PREIMAGE }) }),
    );
    expect(res.status).toBe(200);
  });

  it('returns 409 when already paid with a different preimage', async () => {
    store.put(unpaid({ paidAt: 5, preimage: '22'.repeat(32) }));
    const res = await createApp({
      spendApiToken: TOKEN,
      invoiceStore: store,
      now: () => 100,
    }).request(
      '/invoices/proof',
      auth({ method: 'POST', body: JSON.stringify({ id: unpaid().id, preimage: PREIMAGE }) }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Invoice already paid' });
  });
});
