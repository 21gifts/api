import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import { fetchBtcUsdSpot } from '@/lib/btc-usd-spot';
import { InMemoryFondPayoutStore, type FondPayoutEnqueue } from '@/lib/fond-payout-store';
import { InMemoryFundingStore } from '@/lib/funding-store';
import type { GiftRecord, GiftRecorder } from '@/lib/gift-recorder';
import { InMemoryInvoiceStore, type GiftInvoice } from '@/lib/invoice-store';
import { InMemoryMessageStore } from '@/lib/message-store';
import { fondRoutes } from '@/routes/fond';
import { issueGiftInvoice } from '@/routes/invoices';

vi.mock('@/lib/btc-usd-spot', () => ({
  fetchBtcUsdSpot: vi.fn(async () => '100000'),
}));

vi.mock('@/routes/invoices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/routes/invoices')>();
  return {
    ...actual,
    issueGiftInvoice: vi.fn(),
  };
});

const mockedSpot = vi.mocked(fetchBtcUsdSpot);
const mockedIssue = vi.mocked(issueGiftInvoice);

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const TODAY = '2026-11-09';
const TOKEN = 'fond-session';
const FOND = 'tondo-fond';
const INVOICE_ID = 'inv-1';
const HASH = 'aa'.repeat(32);
const BOLT11 = 'lnbc1fond';
const ROW_ID = '11111111-1111-4111-8111-111111111111';
const PREIMAGE = 'a'.repeat(64);
const PREIMAGE_HASH = createHash('sha256').update(Buffer.from(PREIMAGE, 'hex')).digest('hex');

function rowInput(partial: Partial<FondPayoutEnqueue> = {}): FondPayoutEnqueue {
  return {
    id: ROW_ID,
    utcDay: TODAY,
    kind: 'daily',
    address: 'ada@example.com',
    amountUsd: '1.00',
    comment: 'thanks',
    messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    groupMessageId: null,
    ...partial,
  };
}

function invoice(partial: Partial<GiftInvoice> = {}): GiftInvoice {
  return {
    id: INVOICE_ID,
    address: 'ada@example.com',
    pr: BOLT11,
    paymentHash: HASH,
    amountMsat: 1000,
    createdAt: NOW,
    expiresAt: NOW + 900_000,
    ...partial,
  };
}

async function fondAccount(
  store: InMemoryAuthStore,
  options: {
    id?: string;
    role?: Account['role'];
    username?: string | null;
    isPlatform?: boolean;
  } = {},
): Promise<Account> {
  const id = options.id ?? 'fond-account';
  await store.createAccount({
    id,
    linkingKey: null,
    role: options.role ?? 'fond',
    name: 'Fond',
    forumLawsDismissed: false,
    location: null,
    viewKey: 'b'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: null,
    username: options.username === undefined ? FOND : options.username,
    ...(options.isPlatform === undefined ? {} : { isPlatform: options.isPlatform }),
  });
  await store.tryCreateSession({ token: TOKEN, accountId: id, createdAt: NOW });
  const account = await store.getAccount(id);
  return account as Account;
}

interface AppOptions {
  signer?: 'spend' | 'fond';
  seedFond?: boolean;
  actionsStore?: InMemoryInvoiceStore;
  payoutStore?: InMemoryFondPayoutStore;
  giftRecorder?: GiftRecorder;
}

async function makeApp(options: AppOptions = {}): Promise<{
  app: Hono;
  auth: InMemoryAuthStore;
  payouts: InMemoryFondPayoutStore;
  invoices: InMemoryInvoiceStore;
}> {
  const auth = new InMemoryAuthStore();
  if (options.seedFond !== false) {
    await fondAccount(auth);
  }
  const payouts = options.payoutStore ?? new InMemoryFondPayoutStore(() => NOW);
  const invoices = options.actionsStore ?? new InMemoryInvoiceStore();
  const app = new Hono().route(
    '/fond',
    fondRoutes({
      authStore: auth,
      fondPayoutStore: payouts,
      payoutSigner: options.signer ?? 'fond',
      fondUsername: FOND,
      now: () => NOW,
      fetchImpl: async () => new Response(null, { status: 500 }),
      actions: {
        store: invoices,
        authStore: auth,
        messageStore: new InMemoryMessageStore(),
        now: () => NOW,
        fetchImpl: async () => new Response(null, { status: 500 }),
        fundingStore: new InMemoryFundingStore(),
        ...(options.giftRecorder === undefined ? {} : { giftRecorder: options.giftRecorder }),
      },
    }),
  );
  return { app, auth, payouts, invoices };
}

function authHeader(token = TOKEN): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

beforeEach(() => {
  mockedSpot.mockReset();
  mockedSpot.mockResolvedValue('100000');
  mockedIssue.mockReset();
});

describe('fondRoutes switch and auth', () => {
  it('returns 404 on every route unless PAYOUT_SIGNER is fond', async () => {
    const { app } = await makeApp({ signer: 'spend' });
    expect((await app.request('/fond/payouts', { headers: authHeader() })).status).toBe(404);
    expect(
      (
        await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
          method: 'POST',
          headers: authHeader(),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(`/fond/payouts/${ROW_ID}/proof`, {
          method: 'POST',
          headers: authHeader(),
          body: JSON.stringify({ preimage: 'a'.repeat(64) }),
        })
      ).status,
    ).toBe(404);
  });

  it('returns 401 without a session', async () => {
    const { app } = await makeApp();
    expect((await app.request('/fond/payouts')).status).toBe(401);
    expect((await app.request(`/fond/payouts/${ROW_ID}/invoice`, { method: 'POST' })).status).toBe(
      401,
    );
    expect((await app.request(`/fond/payouts/${ROW_ID}/proof`, { method: 'POST' })).status).toBe(
      401,
    );
  });

  it('returns 401 for a well-formed bearer that resolves to no session', async () => {
    const { app } = await makeApp();
    const res = await app.request('/fond/payouts', { headers: authHeader('missing-session') });
    expect(res.status).toBe(401);
  });

  it('returns 403 Fond only for any account that is not the Fond payer', async () => {
    const { app, auth } = await makeApp();
    await auth.createAccount({
      id: 'other',
      linkingKey: null,
      role: 'verified',
      name: 'Other',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'c'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
      username: 'other',
    });
    await auth.tryCreateSession({ token: 'other-session', accountId: 'other', createdAt: NOW });
    const res = await app.request('/fond/payouts', { headers: authHeader('other-session') });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Fond only' });
  });

  it('returns 403 Fond only when the fond account has no username', async () => {
    const { app, auth } = await makeApp({ seedFond: false });
    await fondAccount(auth, { id: 'no-username', username: null });
    const res = await app.request('/fond/payouts', { headers: authHeader() });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Fond only' });
  });

  it('returns 403 for the configured username without fond or on the platform', async () => {
    const { app, auth } = await makeApp({ seedFond: false });
    await auth.createAccount({
      id: 'not-fond',
      linkingKey: null,
      role: 'founder',
      name: 'Not Fond',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'd'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
      username: FOND,
    });
    await auth.tryCreateSession({
      token: 'not-fond-session',
      accountId: 'not-fond',
      createdAt: NOW,
    });
    expect(
      (await app.request('/fond/payouts', { headers: authHeader('not-fond-session') })).status,
    ).toBe(403);

    const platformAuth = new InMemoryAuthStore();
    await platformAuth.createAccount({
      id: 'platform',
      linkingKey: null,
      role: 'fond',
      name: 'Platform',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'e'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
      username: FOND,
      isPlatform: true,
    });
    await platformAuth.tryCreateSession({
      token: 'platform-session',
      accountId: 'platform',
      createdAt: NOW,
    });
    const platformApp = new Hono().route(
      '/fond',
      fondRoutes({
        authStore: platformAuth,
        fondPayoutStore: new InMemoryFondPayoutStore(),
        payoutSigner: 'fond',
        fondUsername: FOND,
        now: () => NOW,
        fetchImpl: async () => new Response(null, { status: 500 }),
        actions: {
          store: new InMemoryInvoiceStore(),
          authStore: platformAuth,
          messageStore: new InMemoryMessageStore(),
          now: () => NOW,
          fetchImpl: async () => new Response(null, { status: 500 }),
          fundingStore: new InMemoryFundingStore(),
        },
      }),
    );
    const platformRes = await platformApp.request('/fond/payouts', {
      headers: authHeader('platform-session'),
    });
    expect(platformRes.status).toBe(403);
  });
});

describe('GET /fond/payouts', () => {
  it("lists today's open rows oldest first with only id, kind, status, and utcDay", async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput());
    await payouts.enqueue(rowInput({ id: 'older', address: 'bob@example.com' }));
    await payouts.enqueue(rowInput({ id: 'yesterday', utcDay: '2026-11-08', kind: 'welcome' }));
    const res = await app.request('/fond/payouts', { headers: authHeader() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { payouts: unknown[] };
    expect(body.payouts).toHaveLength(2);
    for (const row of body.payouts) {
      expect(row).not.toBeNull();
      expect(typeof row).toBe('object');
      expect(Object.keys(row as Record<string, unknown>).sort()).toEqual([
        'id',
        'kind',
        'status',
        'utcDay',
      ]);
    }
  });

  it('returns 503 when the store throws', async () => {
    const { app, payouts } = await makeApp();
    vi.spyOn(payouts, 'listOpen').mockRejectedValue(new Error('down'));
    const res = await app.request('/fond/payouts', { headers: authHeader() });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Payouts are unavailable' });
  });
});

describe('POST /fond/payouts/:id/invoice', () => {
  it('returns 503 when the row cannot be read', async () => {
    const { app, payouts } = await makeApp();
    vi.spyOn(payouts, 'get').mockRejectedValue(new Error('down'));
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(503);
  });

  it('returns 404 for an unknown id', async () => {
    const { app } = await makeApp();
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(404);
  });

  it('returns 409 Not payable for another-day owed, paid, or failed rows', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput({ id: 'old', utcDay: '2026-11-08' }));
    await payouts.enqueue(rowInput({ id: 'paid' }));
    await payouts.claimForInvoice('paid', TODAY);
    await payouts.setInvoiced('paid', {
      invoiceId: 'x',
      paymentHash: 'h',
      bolt11: 'b',
      amountMsat: 1000,
    });
    await payouts.markPaid('paid');
    await payouts.enqueue(rowInput({ id: 'failed', address: 'fail@example.com' }));
    await payouts.claimForInvoice('failed', TODAY);
    await payouts.markFailed('failed', 'Passkey required');
    for (const id of ['old', 'paid', 'failed']) {
      const res = await app.request(`/fond/payouts/${id}/invoice`, {
        method: 'POST',
        headers: authHeader(),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'Not payable' });
    }
  });

  it('returns a stored invoice for an invoiced row of another day', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput({ utcDay: '2026-11-08' }));
    await payouts.claimForInvoice(ROW_ID, '2026-11-08');
    await payouts.setInvoiced(ROW_ID, {
      invoiceId: INVOICE_ID,
      paymentHash: HASH,
      bolt11: BOLT11,
      amountMsat: 1_000_000,
    });
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: ROW_ID, bolt11: BOLT11, paymentHash: HASH });
  });

  it('returns the stored invoice after restart without the invoice store', async () => {
    const { app, payouts, invoices } = await makeApp();
    await payouts.enqueue(rowInput());
    await payouts.claimForInvoice(ROW_ID, TODAY);
    await payouts.setInvoiced(ROW_ID, {
      invoiceId: INVOICE_ID,
      paymentHash: HASH,
      bolt11: BOLT11,
      amountMsat: 1_000_000,
    });
    invoices.sweep(NOW + 10_000_000);
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: ROW_ID, bolt11: BOLT11, paymentHash: HASH });
    expect(mockedIssue).not.toHaveBeenCalled();
  });

  it('returns 409 Not payable for an invoiced row with a missing stored field', async () => {
    for (const field of ['bolt11', 'paymentHash'] as const) {
      const { app, payouts } = await makeApp();
      await payouts.enqueue(rowInput());
      await payouts.claimForInvoice(ROW_ID, TODAY);
      await payouts.setInvoiced(ROW_ID, {
        invoiceId: INVOICE_ID,
        paymentHash: HASH,
        bolt11: BOLT11,
        amountMsat: 1_000_000,
      });
      const row = (await payouts.get(ROW_ID)) as NonNullable<
        Awaited<ReturnType<typeof payouts.get>>
      >;
      vi.spyOn(payouts, 'get').mockResolvedValueOnce(
        field === 'bolt11' ? { ...row, bolt11: null } : { ...row, paymentHash: null },
      );
      const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
        method: 'POST',
        headers: authHeader(),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'Not payable' });
    }
  });

  it('returns 409 Invoice in progress for an issuing row and never reissues it', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput());
    await payouts.claimForInvoice(ROW_ID, TODAY);
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Invoice in progress' });
    expect(mockedIssue).not.toHaveBeenCalled();
  });

  it('re-reads a lost claim and returns the stored invoice', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput());
    const owed = await payouts.get(ROW_ID);
    await payouts.claimForInvoice(ROW_ID, TODAY);
    await payouts.setInvoiced(ROW_ID, {
      invoiceId: INVOICE_ID,
      paymentHash: HASH,
      bolt11: BOLT11,
      amountMsat: 1_000_000,
    });
    const invoiced = await payouts.get(ROW_ID);
    vi.spyOn(payouts, 'claimForInvoice').mockResolvedValueOnce(null);
    vi.spyOn(payouts, 'get').mockResolvedValueOnce(owed).mockResolvedValueOnce(invoiced);
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: ROW_ID, bolt11: BOLT11, paymentHash: HASH });
    expect(mockedIssue).not.toHaveBeenCalled();
  });

  it('re-reads a lost claim whose stored invoice lacks a field as Not payable', async () => {
    const missingFields = [
      { bolt11: null, paymentHash: HASH },
      { bolt11: BOLT11, paymentHash: null },
    ] as const;
    for (const missing of missingFields) {
      const { app, payouts } = await makeApp();
      await payouts.enqueue(rowInput());
      const owed = await payouts.get(ROW_ID);
      await payouts.claimForInvoice(ROW_ID, TODAY);
      await payouts.setInvoiced(ROW_ID, {
        invoiceId: INVOICE_ID,
        paymentHash: HASH,
        bolt11: BOLT11,
        amountMsat: 1_000_000,
      });
      const row = (await payouts.get(ROW_ID)) as NonNullable<
        Awaited<ReturnType<typeof payouts.get>>
      >;
      vi.spyOn(payouts, 'claimForInvoice').mockResolvedValueOnce(null);
      vi.spyOn(payouts, 'get')
        .mockResolvedValueOnce(owed)
        .mockResolvedValueOnce({ ...row, ...missing });
      const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
        method: 'POST',
        headers: authHeader(),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'Not payable' });
    }
  });

  it('re-reads a lost claim and returns 409 Invoice in progress', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput());
    const owed = await payouts.get(ROW_ID);
    await payouts.claimForInvoice(ROW_ID, TODAY);
    const issuing = await payouts.get(ROW_ID);
    vi.spyOn(payouts, 'claimForInvoice').mockResolvedValueOnce(null);
    vi.spyOn(payouts, 'get').mockResolvedValueOnce(owed).mockResolvedValueOnce(issuing);
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Invoice in progress' });
  });

  it('re-reads a lost claim and returns 409 Not payable for another state', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput());
    const owed = await payouts.get(ROW_ID);
    vi.spyOn(payouts, 'claimForInvoice').mockResolvedValueOnce(null);
    vi.spyOn(payouts, 'get')
      .mockResolvedValueOnce(owed)
      .mockResolvedValueOnce(owed === undefined ? owed : { ...owed, status: 'paid' });
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Not payable' });
  });

  it('releases the claim and returns 503 Price unavailable when the spot fails', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput());
    mockedSpot.mockResolvedValueOnce(null);
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Price unavailable' });
    expect((await payouts.get(ROW_ID))?.status).toBe('owed');
  });

  it('releases the claim and returns 409 Amount below one sat', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput({ amountUsd: '0.01' }));
    mockedSpot.mockResolvedValueOnce('1000000000000');
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Amount below one sat' });
    expect((await payouts.get(ROW_ID))?.status).toBe('owed');
  });

  it('releases the claim and returns 503 when the spot fetch throws', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput());
    mockedSpot.mockRejectedValueOnce(new Error('down'));
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(503);
    expect((await payouts.get(ROW_ID))?.status).toBe('owed');
  });

  it('also refuses a non-positive spot', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput());
    mockedSpot.mockResolvedValueOnce('-1');
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(503);
  });

  it('issues at the spot, passes the decided body, and stores the invoice', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput());
    mockedIssue.mockResolvedValue({ ok: true, invoice: invoice() });
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: ROW_ID, bolt11: BOLT11, paymentHash: HASH });
    expect(mockedIssue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        address: 'ada@example.com',
        amountMsat: 1_000_000,
        comment: 'thanks',
        messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        amountUsd: '1.00',
      }),
    );
    expect(await payouts.get(ROW_ID)).toMatchObject({
      status: 'invoiced',
      invoiceId: INVOICE_ID,
      paymentHash: HASH,
      bolt11: BOLT11,
      amountMsat: 1_000_000,
    });
  });

  it('passes the group message id for a moderator row', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(
      rowInput({ kind: 'moderator', messageId: null, groupMessageId: 'group-id' }),
    );
    mockedIssue.mockResolvedValue({ ok: true, invoice: invoice() });
    await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(mockedIssue.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ groupMessageId: 'group-id' }),
    );
    expect(mockedIssue.mock.calls[0]?.[1]).not.toHaveProperty('messageId');
  });

  it('stores the issue refusal text and answers 409', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput());
    mockedIssue.mockResolvedValue({ ok: false, status: 403, error: 'Passkey required' });
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Passkey required' });
    expect(await payouts.get(ROW_ID)).toMatchObject({
      status: 'failed',
      failure: 'Passkey required',
    });
  });

  it('keeps the row owed on a transport failure and passes the status through', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput());
    mockedIssue.mockResolvedValue({
      ok: false,
      status: 502,
      error: 'Lightning Address did not issue an invoice',
    });
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(502);
    expect((await payouts.get(ROW_ID))?.status).toBe('owed');
  });

  it('releases the claim and returns 503 when issue throws', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput());
    mockedIssue.mockRejectedValue(new Error('down'));
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(503);
    expect((await payouts.get(ROW_ID))?.status).toBe('owed');
  });

  it('returns 409 Not payable when the row stopped being payable during issue', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput());
    mockedIssue.mockResolvedValue({ ok: true, invoice: invoice() });
    vi.spyOn(payouts, 'setInvoiced').mockResolvedValue(undefined);
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Not payable' });
    expect((await payouts.get(ROW_ID))?.status).toBe('issuing');
  });

  it('returns 503 when claiming throws', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput());
    vi.spyOn(payouts, 'claimForInvoice').mockRejectedValueOnce(new Error('down'));
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(503);
  });

  it('returns 503 when re-reading a lost claim throws', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput());
    const owed = await payouts.get(ROW_ID);
    vi.spyOn(payouts, 'claimForInvoice').mockResolvedValueOnce(null);
    vi.spyOn(payouts, 'get').mockResolvedValueOnce(owed).mockRejectedValueOnce(new Error('down'));
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(503);
  });
});

describe('POST /fond/payouts/:id/proof', () => {
  const preimage = { preimage: PREIMAGE };

  async function invoicedRow(
    payouts: InMemoryFondPayoutStore,
    partial: { kind?: 'daily' | 'moderator' | 'welcome'; amountMsat?: number } = {},
  ): Promise<void> {
    await payouts.enqueue(
      rowInput(
        partial.kind === undefined
          ? {}
          : {
              kind: partial.kind,
              messageId: partial.kind === 'moderator' ? null : rowInput().messageId,
              groupMessageId: partial.kind === 'moderator' ? 'group-id' : null,
            },
      ),
    );
    await payouts.claimForInvoice(ROW_ID, TODAY);
    await payouts.setInvoiced(ROW_ID, {
      invoiceId: INVOICE_ID,
      paymentHash: PREIMAGE_HASH,
      bolt11: BOLT11,
      amountMsat: partial.amountMsat ?? 1_000_000,
    });
  }

  it('returns 503 when the row cannot be read', async () => {
    const { app, payouts } = await makeApp();
    vi.spyOn(payouts, 'get').mockRejectedValue(new Error('down'));
    const res = await app.request(`/fond/payouts/${ROW_ID}/proof`, {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(preimage),
    });
    expect(res.status).toBe(503);
  });

  it('returns 400 for a missing or invalid body', async () => {
    const { app } = await makeApp();
    for (const body of ['not json', JSON.stringify({}), JSON.stringify({ preimage: 1 })]) {
      const res = await app.request(`/fond/payouts/${ROW_ID}/proof`, {
        method: 'POST',
        headers: authHeader(),
        body,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Expected a JSON body with preimage' });
    }
  });

  it('returns 404 for an unknown id', async () => {
    const { app } = await makeApp();
    const res = await app.request(`/fond/payouts/${ROW_ID}/proof`, {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(preimage),
    });
    expect(res.status).toBe(404);
  });

  it('returns 409 Not invoiced for owed, issuing, and failed rows', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput());
    await payouts.enqueue(rowInput({ id: 'issuing', address: 'i@example.com' }));
    await payouts.claimForInvoice('issuing', TODAY);
    await payouts.enqueue(rowInput({ id: 'failed', address: 'f@example.com' }));
    await payouts.claimForInvoice('failed', TODAY);
    await payouts.markFailed('failed', 'x');
    for (const id of [ROW_ID, 'issuing', 'failed']) {
      const res = await app.request(`/fond/payouts/${id}/proof`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify(preimage),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'Not invoiced' });
    }
  });

  it('proves from the durable row, persists the gift, and marks the row paid', async () => {
    const records: GiftRecord[] = [];
    const giftRecorder: GiftRecorder = {
      recordOutbound: async (record) => {
        records.push(record);
      },
    };
    const { app, payouts, invoices } = await makeApp({ giftRecorder });
    await invoicedRow(payouts);
    invoices.sweep(NOW + 10_000_000);
    const res = await app.request(`/fond/payouts/${ROW_ID}/proof`, {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(preimage),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'paid', id: ROW_ID });
    expect((await payouts.get(ROW_ID))?.status).toBe('paid');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      amountSats: 1000,
      recipientWosUser: 'ada',
      lightningInvoice: BOLT11,
      description: '21gifts daily',
      kind: 'daily',
      sourceWallet: FOND,
      fiat: { usd: '1.00' },
    });
    expect(records[0]?.paidAt).toEqual(new Date(NOW));
  });

  it('accepts the preimage in upper case and compares lower-case hashes', async () => {
    const { app, payouts } = await makeApp();
    await invoicedRow(payouts);
    const res = await app.request(`/fond/payouts/${ROW_ID}/proof`, {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify({ preimage: PREIMAGE.toUpperCase() }),
    });
    expect(res.status).toBe(200);
    expect((await payouts.get(ROW_ID))?.status).toBe('paid');
  });

  it('uses the durable row kind and amount for the persisted gift', async () => {
    const records: GiftRecord[] = [];
    const { app, payouts } = await makeApp({
      giftRecorder: {
        recordOutbound: async (record) => {
          records.push(record);
        },
      },
    });
    await invoicedRow(payouts, { kind: 'moderator', amountMsat: 2_345_000 });
    const res = await app.request(`/fond/payouts/${ROW_ID}/proof`, {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(preimage),
    });
    expect(res.status).toBe(200);
    expect(records[0]).toMatchObject({
      amountSats: 2345,
      description: '21gifts moderator',
      kind: 'moderator',
    });
  });

  it('returns paid idempotently for a paid row and relies on recorder idempotency', async () => {
    const records: GiftRecord[] = [];
    const byInvoice = new Map<string, GiftRecord>();
    const giftRecorder: GiftRecorder = {
      recordOutbound: async (record) => {
        if (!byInvoice.has(record.lightningInvoice)) {
          byInvoice.set(record.lightningInvoice, record);
          records.push(record);
        }
      },
    };
    const { app, payouts } = await makeApp({ giftRecorder });
    await invoicedRow(payouts);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await app.request(`/fond/payouts/${ROW_ID}/proof`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify(preimage),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'paid', id: ROW_ID });
    }
    expect(records).toHaveLength(1);
    expect((await payouts.get(ROW_ID))?.status).toBe('paid');
  });

  it('returns 400 Proof does not match invoice and leaves the row invoiced', async () => {
    const { app, payouts } = await makeApp();
    await invoicedRow(payouts);
    const res = await app.request(`/fond/payouts/${ROW_ID}/proof`, {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify({ preimage: 'b'.repeat(64) }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Proof does not match invoice' });
    expect((await payouts.get(ROW_ID))?.status).toBe('invoiced');
  });

  it('returns 409 Not invoiced when the row stops being invoiced during proof', async () => {
    const { app, payouts } = await makeApp();
    await invoicedRow(payouts);
    vi.spyOn(payouts, 'markPaid').mockResolvedValue(undefined);
    const res = await app.request(`/fond/payouts/${ROW_ID}/proof`, {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(preimage),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Not invoiced' });
  });

  it('returns 409 Not invoiced for an invoiced row with a missing durable field', async () => {
    const missingFields = [
      { invoiceId: null, paymentHash: PREIMAGE_HASH, bolt11: BOLT11, amountMsat: 1_000_000 },
      { invoiceId: INVOICE_ID, paymentHash: null, bolt11: BOLT11, amountMsat: 1_000_000 },
      { invoiceId: INVOICE_ID, paymentHash: PREIMAGE_HASH, bolt11: null, amountMsat: 1_000_000 },
      { invoiceId: INVOICE_ID, paymentHash: PREIMAGE_HASH, bolt11: BOLT11, amountMsat: null },
    ] as const;
    for (const missing of missingFields) {
      const { app, payouts } = await makeApp();
      await invoicedRow(payouts);
      const row = (await payouts.get(ROW_ID)) as NonNullable<
        Awaited<ReturnType<typeof payouts.get>>
      >;
      vi.spyOn(payouts, 'get').mockResolvedValueOnce({ ...row, ...missing });
      const res = await app.request(`/fond/payouts/${ROW_ID}/proof`, {
        method: 'POST',
        headers: authHeader(),
        body: JSON.stringify(preimage),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'Not invoiced' });
    }
  });

  it('persists the decided USD string exactly on the gift', async () => {
    const records: GiftRecord[] = [];
    const { app, payouts } = await makeApp({
      giftRecorder: {
        recordOutbound: async (record) => {
          records.push(record);
        },
      },
    });
    await payouts.enqueue(rowInput({ amountUsd: '0.004' }));
    await payouts.claimForInvoice(ROW_ID, TODAY);
    await payouts.setInvoiced(ROW_ID, {
      invoiceId: INVOICE_ID,
      paymentHash: PREIMAGE_HASH,
      bolt11: BOLT11,
      amountMsat: 4000,
    });
    const res = await app.request(`/fond/payouts/${ROW_ID}/proof`, {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(preimage),
    });
    expect(res.status).toBe(200);
    expect(records[0]).toMatchObject({
      fiat: { usd: '0.004', chf: null, eur: null, php: null },
    });
  });
});
