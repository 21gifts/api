import { createHash } from 'node:crypto';
import { bech32 } from '@scure/base';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import { fetchBtcUsdSpot } from '@/lib/btc-usd-spot';
import { InMemoryConversationStore } from '@/lib/conversation-store';
import { InMemoryFondPayoutStore, type FondPayoutEnqueue } from '@/lib/fond-payout-store';
import { InMemoryFundingStore } from '@/lib/funding-store';
import type { GiftRecord, GiftRecorder } from '@/lib/gift-recorder';
import { InMemoryInvoiceStore, type GiftInvoice } from '@/lib/invoice-store';
import type { FetchFn } from '@/lib/lnurlp';
import { InMemoryMessageStore } from '@/lib/message-store';
import { unsignedNostrDefaults, type MessageRow } from '@/lib/message';
import { setDiagnosticSink } from '@/lib/log';
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
const LETTERED_ROW_ID = 'abcdefab-cdef-4abc-8abc-abcdefabcdef';
const OLD_ROW_ID = '22222222-2222-4222-8222-222222222222';
const PAID_ROW_ID = '33333333-3333-4333-8333-333333333333';
const FAILED_ROW_ID = '44444444-4444-4444-8444-444444444444';
const ISSUING_ROW_ID = '55555555-5555-4555-8555-555555555555';
const PREIMAGE = 'a'.repeat(64);
const PREIMAGE_HASH = createHash('sha256').update(Buffer.from(PREIMAGE, 'hex')).digest('hex');
const LNURL = {
  baseUrl: 'https://lnurl.test',
  publicBaseUrl: 'https://gifts.test',
  host: 'gifts.test',
};

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

function post(partial: Partial<MessageRow> = {}): MessageRow {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    accountId: 'ada',
    name: 'Ada',
    text: 'first',
    createdAt: new Date(1),
    hasPhoto: false,
    ...unsignedNostrDefaults(),
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
    sessionToken?: string;
    viewKey?: string;
    walletRequired?: boolean;
    name?: string;
  } = {},
): Promise<Account> {
  const id = options.id ?? 'fond-account';
  await store.createAccount({
    id,
    linkingKey: null,
    role: options.role ?? 'fond',
    name: options.name ?? 'Fond',
    forumLawsDismissed: false,
    location: null,
    viewKey: options.viewKey ?? 'b'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: null,
    username: options.username === undefined ? FOND : options.username,
    ...(options.isPlatform === undefined ? {} : { isPlatform: options.isPlatform }),
    ...(options.walletRequired === undefined ? {} : { walletRequired: options.walletRequired }),
  });
  await store.tryCreateSession({
    token: options.sessionToken ?? TOKEN,
    accountId: id,
    createdAt: NOW,
  });
  const account = await store.getAccount(id);
  return account as Account;
}

async function verifiedRecipient(store: InMemoryAuthStore): Promise<void> {
  await fondAccount(store, {
    id: 'ada',
    role: 'verified',
    username: 'ada',
    sessionToken: 'ada-session',
    viewKey: 'c'.repeat(64),
    walletRequired: true,
    name: 'Ada',
  });
  const recipientPubkey = '02' + 'ab'.repeat(32);
  const recipient = await store.getAccount('ada');
  await store.claimSparkPubkey('ada', recipientPubkey);
  await store.markSparkPubkeyVerified('ada', recipientPubkey, recipient!.username!, 1);
  await store.createPasskeyCredential({
    credentialId: 'cred-ada',
    publicKey: new Uint8Array([1]),
    signCount: 0,
    accountId: 'ada',
    createdAt: 1,
  });
}

interface AppOptions {
  signer?: 'spend' | 'fond';
  seedFond?: boolean;
  actionsStore?: InMemoryInvoiceStore;
  payoutStore?: InMemoryFondPayoutStore;
  giftRecorder?: GiftRecorder;
  messageStore?: InMemoryMessageStore;
  conversationStore?: InMemoryConversationStore;
  fundingStore?: InMemoryFundingStore;
  fetchImpl?: FetchFn;
  seedPlatform?: boolean;
  seedRecipient?: boolean;
}

async function makeApp(options: AppOptions = {}): Promise<{
  app: Hono;
  auth: InMemoryAuthStore;
  payouts: InMemoryFondPayoutStore;
  invoices: InMemoryInvoiceStore;
  messages: InMemoryMessageStore;
  conversations?: InMemoryConversationStore;
}> {
  const auth = new InMemoryAuthStore();
  if (options.seedFond !== false) {
    await fondAccount(auth);
  }
  if (options.seedRecipient === true) {
    await verifiedRecipient(auth);
  }
  if (options.seedPlatform === true) {
    await auth.createAccount({
      id: 'platform',
      linkingKey: null,
      role: 'founder',
      name: '21.gifts',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'f'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
      isPlatform: true,
    });
  }
  const payouts = options.payoutStore ?? new InMemoryFondPayoutStore(() => NOW);
  const invoices = options.actionsStore ?? new InMemoryInvoiceStore();
  const messages = options.messageStore ?? new InMemoryMessageStore();
  const fetchImpl = options.fetchImpl ?? (async () => new Response(null, { status: 500 }));
  const app = new Hono().route(
    '/fond',
    fondRoutes({
      authStore: auth,
      fondPayoutStore: payouts,
      payoutSigner: options.signer ?? 'fond',
      fondUsername: FOND,
      now: () => NOW,
      fetchImpl,
      lnurlServer: LNURL,
      actions: {
        store: invoices,
        authStore: auth,
        messageStore: messages,
        now: () => NOW,
        fetchImpl,
        fundingStore: options.fundingStore ?? new InMemoryFundingStore(),
        lnurlServer: LNURL,
        ...(options.giftRecorder === undefined ? {} : { giftRecorder: options.giftRecorder }),
        ...(options.conversationStore === undefined
          ? {}
          : { conversationStore: options.conversationStore }),
      },
    }),
  );
  return {
    app,
    auth,
    payouts,
    invoices,
    messages,
    ...(options.conversationStore === undefined
      ? {}
      : { conversations: options.conversationStore }),
  };
}

function authHeader(token = TOKEN): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function spendGiftReplyId(invoiceId: string): string {
  const hex = createHash('sha256').update(`21gifts-spend-gift:${invoiceId}`).digest('hex');
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(18, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function spendGroupGiftId(invoiceId: string): string {
  const hex = createHash('sha256').update(`21gifts-spend-group-gift:${invoiceId}`).digest('hex');
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(18, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function words(value: number, length: number): number[] {
  const out: number[] = [];
  for (let i = length - 1; i >= 0; i -= 1) {
    out.push(Math.floor(value / 32 ** i) % 32);
  }
  return out;
}

function tagged(type: number, data: number[]): number[] {
  return [type, ...words(data.length, 2), ...data];
}

function bolt11ForSats(sats: number, paymentHash: string): string {
  const data = [
    ...words(1_700_000_000, 7),
    ...tagged(1, bech32.toWords(Buffer.from(paymentHash, 'hex'))),
    ...bech32.toWords(new Uint8Array(65)),
  ];
  return bech32.encode(`lnbc${sats * 10}n`, data, false);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  mockedSpot.mockReset();
  mockedSpot.mockResolvedValue('100000');
  mockedIssue.mockReset();
});

afterEach(() => {
  setDiagnosticSink(null);
});

function captureEvents(): string[] {
  const events: string[] = [];
  setDiagnosticSink((event) => {
    events.push(event);
  });
  return events;
}

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

  it('returns 404 Not found for a malformed id without reading the store', async () => {
    const { app, payouts } = await makeApp();
    const get = vi.spyOn(payouts, 'get');
    const res = await app.request('/fond/payouts/not-a-uuid/invoice', {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(get).not.toHaveBeenCalled();
  });

  it('lower-cases a valid upper-case id before the invoice store read', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput({ id: LETTERED_ROW_ID }));
    mockedIssue.mockResolvedValue({ ok: true, invoice: invoice() });
    const get = vi.spyOn(payouts, 'get');
    const res = await app.request(`/fond/payouts/${LETTERED_ROW_ID.toUpperCase()}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    expect(get).toHaveBeenCalledWith(LETTERED_ROW_ID);
  });

  it('returns 409 Not payable for another-day owed, paid, or failed rows', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput({ id: OLD_ROW_ID, utcDay: '2026-11-08' }));
    await payouts.enqueue(rowInput({ id: PAID_ROW_ID }));
    await payouts.claimForInvoice(PAID_ROW_ID, TODAY);
    await payouts.setInvoiced(PAID_ROW_ID, {
      invoiceId: 'x',
      paymentHash: 'h',
      bolt11: 'b',
      amountMsat: 1000,
    });
    await payouts.markPaid(PAID_ROW_ID);
    await payouts.enqueue(rowInput({ id: FAILED_ROW_ID, address: 'fail@example.com' }));
    await payouts.claimForInvoice(FAILED_ROW_ID, TODAY);
    await payouts.markFailed(FAILED_ROW_ID, 'Passkey required');
    for (const id of [OLD_ROW_ID, PAID_ROW_ID, FAILED_ROW_ID]) {
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

  it('omits amountUsd when the exact USD rounds below one cent', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput({ amountUsd: '0.004' }));
    mockedIssue.mockResolvedValue({ ok: true, invoice: invoice() });
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    expect(mockedIssue.mock.calls[0]?.[1].amountMsat).toBe(4000);
    expect(mockedIssue.mock.calls[0]?.[1]).not.toHaveProperty('amountUsd');
    expect(await payouts.get(ROW_ID)).toMatchObject({ status: 'invoiced', failure: null });
  });

  it.each([
    ['1.230', '1.23'],
    ['1', '1.00'],
  ])('passes the exact %s USD as the two-decimal display %s', async (decided, display) => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput({ amountUsd: decided }));
    mockedIssue.mockResolvedValue({ ok: true, invoice: invoice() });
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    expect(mockedIssue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ amountUsd: display }),
    );
    expect(mockedIssue.mock.calls[0]?.[1].amountMsat).toBe(
      Math.round((Number(decided) / 100000) * 1e8) * 1000,
    );
    expect(await payouts.get(ROW_ID)).toMatchObject({ status: 'invoiced', failure: null });
  });

  it('issues a 0.004 payout through the real validator and marks it invoiced', async () => {
    const paymentHash = 'cd'.repeat(32);
    const invoicePr = bolt11ForSats(4, paymentHash);
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).includes('/.well-known/lnurlp/ada')) {
        return jsonResponse({
          callback: `${LNURL.baseUrl}/lnurlp/ada/invoice`,
          minSendable: 1000,
          maxSendable: 100_000_000,
          commentAllowed: 255,
        });
      }
      return jsonResponse({ pr: invoicePr });
    };
    const messages = new InMemoryMessageStore([
      post({ accountId: 'ada', hasVideo: true, videoContentType: 'video/mp4' }),
    ]);
    const fundingStore = new InMemoryFundingStore([
      {
        accountId: 'ada',
        status: 'admitted',
        appliedAt: 1,
        decidedAt: 1,
        decidedBy: 'staff',
        trialUtcDate: null,
        admittedAt: 1,
        note: null,
      },
    ]);
    const { app, payouts } = await makeApp({
      fetchImpl,
      fundingStore,
      messageStore: messages,
      seedPlatform: true,
      seedRecipient: true,
    });
    const actual = await vi.importActual<typeof import('@/routes/invoices')>('@/routes/invoices');
    mockedIssue.mockImplementation(actual.issueGiftInvoice);
    await payouts.enqueue(rowInput({ amountUsd: '0.004', address: 'ada@gifts.test' }));
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: ROW_ID, paymentHash, bolt11: invoicePr });
    expect(await payouts.get(ROW_ID)).toMatchObject({
      status: 'invoiced',
      failure: null,
      amountMsat: 4000,
      paymentHash,
      bolt11: invoicePr,
    });
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

  it('answers 503 Payouts are unavailable when the issue-throw release also throws', async () => {
    const events = captureEvents();
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput());
    mockedIssue.mockRejectedValue(new Error('down'));
    vi.spyOn(payouts, 'releaseClaim').mockRejectedValue(new Error('down'));
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Payouts are unavailable' });
    expect(events).toContain('fond.invoice.failed');
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

  it('returns 503 when setInvoiced throws and leaves the row issuing', async () => {
    const events = captureEvents();
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput());
    mockedIssue.mockResolvedValue({ ok: true, invoice: invoice() });
    vi.spyOn(payouts, 'setInvoiced').mockRejectedValue(new Error('down'));
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Payouts are unavailable' });
    expect((await payouts.get(ROW_ID))?.status).toBe('issuing');
    expect(events).toContain('fond.invoice.failed');
  });

  it('returns 503 Payouts are unavailable when markFailed throws on an issue refusal', async () => {
    const events = captureEvents();
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput());
    mockedIssue.mockResolvedValue({ ok: false, status: 403, error: 'Passkey required' });
    vi.spyOn(payouts, 'markFailed').mockRejectedValue(new Error('down'));
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Payouts are unavailable' });
    expect(events).toContain('fond.invoice.failed');
  });

  it('returns 503 Payouts are unavailable when releasing the claim throws', async () => {
    const events = captureEvents();
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput());
    mockedSpot.mockResolvedValueOnce(null);
    vi.spyOn(payouts, 'releaseClaim').mockRejectedValue(new Error('down'));
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Payouts are unavailable' });
    expect(events).toContain('fond.invoice.failed');
  });

  it('returns 503 Payouts are unavailable when the below-one-sat release throws', async () => {
    const events = captureEvents();
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput({ amountUsd: '0.01' }));
    mockedSpot.mockResolvedValueOnce('1000000000000');
    vi.spyOn(payouts, 'releaseClaim').mockRejectedValue(new Error('down'));
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Payouts are unavailable' });
    expect(events).toContain('fond.invoice.failed');
  });

  it('returns 503 Payouts are unavailable when the transport-failure release throws', async () => {
    const events = captureEvents();
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput());
    mockedIssue.mockResolvedValue({
      ok: false,
      status: 502,
      error: 'Lightning Address did not issue an invoice',
    });
    vi.spyOn(payouts, 'releaseClaim').mockRejectedValue(new Error('down'));
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Payouts are unavailable' });
    expect(events).toContain('fond.invoice.failed');
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

  it('returns 404 Not found for a malformed id without reading the store', async () => {
    const { app, payouts } = await makeApp();
    const get = vi.spyOn(payouts, 'get');
    const res = await app.request('/fond/payouts/not-a-uuid/proof', {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(preimage),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(get).not.toHaveBeenCalled();
  });

  it('lower-cases a valid upper-case id before the proof store read', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput({ id: LETTERED_ROW_ID }));
    await payouts.claimForInvoice(LETTERED_ROW_ID, TODAY);
    await payouts.setInvoiced(LETTERED_ROW_ID, {
      invoiceId: INVOICE_ID,
      paymentHash: PREIMAGE_HASH,
      bolt11: BOLT11,
      amountMsat: 1_000_000,
    });
    const get = vi.spyOn(payouts, 'get');
    const res = await app.request(`/fond/payouts/${LETTERED_ROW_ID.toUpperCase()}/proof`, {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(preimage),
    });
    expect(res.status).toBe(200);
    expect(get).toHaveBeenCalledWith(LETTERED_ROW_ID);
  });

  it('returns 409 Not invoiced for owed, issuing, and failed rows', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput());
    await payouts.enqueue(rowInput({ id: ISSUING_ROW_ID, address: 'i@example.com' }));
    await payouts.claimForInvoice(ISSUING_ROW_ID, TODAY);
    await payouts.enqueue(rowInput({ id: FAILED_ROW_ID, address: 'f@example.com' }));
    await payouts.claimForInvoice(FAILED_ROW_ID, TODAY);
    await payouts.markFailed(FAILED_ROW_ID, 'x');
    for (const id of [ROW_ID, ISSUING_ROW_ID, FAILED_ROW_ID]) {
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

  it('posts the platform gift reply and credits the daily trigger post', async () => {
    const triggerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const messages = new InMemoryMessageStore([post({ id: triggerId })]);
    const { app, payouts } = await makeApp({
      messageStore: messages,
      seedPlatform: true,
      seedRecipient: true,
    });
    await payouts.enqueue(rowInput({ address: 'ada@gifts.test', messageId: triggerId }));
    await payouts.claimForInvoice(ROW_ID, TODAY);
    await payouts.setInvoiced(ROW_ID, {
      invoiceId: INVOICE_ID,
      paymentHash: PREIMAGE_HASH,
      bolt11: BOLT11,
      amountMsat: 1_000_000,
    });
    const res = await app.request(`/fond/payouts/${ROW_ID}/proof`, {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(preimage),
    });
    expect(res.status).toBe(200);
    const reply = await messages.getById(spendGiftReplyId(INVOICE_ID));
    expect(reply).toMatchObject({
      accountId: 'platform',
      parentId: triggerId,
      text: 'thanks',
      sats: 1000,
    });
    const credited = await messages.getById(triggerId);
    expect(credited?.sats).toBe(1000);
    expect((await payouts.get(ROW_ID))?.status).toBe('paid');
  });

  it('appends the moderator stipend line for the durable group message', async () => {
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('platform', new Date(1));
    await conversations.appendMessage({
      id: 'group-id',
      conversationId: thread.id,
      text: 'mod note',
      createdAt: new Date(1),
      senderAccountId: 'ada',
      senderPubkey: null,
      name: 'Ada',
      sats: 0,
      eventId: null,
      nostrPublishState: 'skipped',
      nostrEvent: null,
      claimedUntil: null,
    });
    const { app, payouts } = await makeApp({
      conversationStore: conversations,
      seedPlatform: true,
      seedRecipient: true,
    });
    await payouts.enqueue(
      rowInput({
        address: 'ada@gifts.test',
        kind: 'moderator',
        messageId: null,
        groupMessageId: 'group-id',
      }),
    );
    await payouts.claimForInvoice(ROW_ID, TODAY);
    await payouts.setInvoiced(ROW_ID, {
      invoiceId: INVOICE_ID,
      paymentHash: PREIMAGE_HASH,
      bolt11: BOLT11,
      amountMsat: 2_345_000,
    });
    const res = await app.request(`/fond/payouts/${ROW_ID}/proof`, {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(preimage),
    });
    expect(res.status).toBe(200);
    expect(await conversations.getMessageById(spendGroupGiftId(INVOICE_ID))).toMatchObject({
      conversationId: thread.id,
      text: 'thanks · Ada',
      senderAccountId: 'platform',
      sats: 2345,
      giftForMessageId: 'group-id',
    });
    expect((await payouts.get(ROW_ID))?.status).toBe('paid');
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

  it('returns 503 when markPaid throws after the gift is recorded', async () => {
    const events = captureEvents();
    const records: GiftRecord[] = [];
    const { app, payouts } = await makeApp({
      giftRecorder: {
        recordOutbound: async (record) => {
          records.push(record);
        },
      },
    });
    await invoicedRow(payouts);
    vi.spyOn(payouts, 'markPaid').mockRejectedValue(new Error('down'));
    const res = await app.request(`/fond/payouts/${ROW_ID}/proof`, {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(preimage),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Payouts are unavailable' });
    expect(records).toHaveLength(1);
    expect((await payouts.get(ROW_ID))?.status).toBe('invoiced');
    expect(events).toContain('fond.proof.failed');
  });

  it('answers a repeat proof idempotently after a failed markPaid', async () => {
    const { app, payouts } = await makeApp();
    await invoicedRow(payouts);
    vi.spyOn(payouts, 'markPaid').mockRejectedValueOnce(new Error('down'));
    const first = await app.request(`/fond/payouts/${ROW_ID}/proof`, {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(preimage),
    });
    expect(first.status).toBe(503);
    const second = await app.request(`/fond/payouts/${ROW_ID}/proof`, {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(preimage),
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ status: 'paid', id: ROW_ID });
    expect((await payouts.get(ROW_ID))?.status).toBe('paid');
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

  it('persists the exact decided USD on the gift while accepting the display amount', async () => {
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
