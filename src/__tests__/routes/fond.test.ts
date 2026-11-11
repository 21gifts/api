import { bech32 } from '@scure/base';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import { fetchBtcUsdSpot } from '@/lib/btc-usd-spot';
import {
  FOND_OVERDUE_MS,
  InMemoryFondPayoutStore,
  type FondPayoutEnqueue,
  type FondPayoutRow,
} from '@/lib/fond-payout-store';
import { InMemoryFundingStore } from '@/lib/funding-store';
import { InMemoryInvoiceStore, type GiftInvoice } from '@/lib/invoice-store';
import type { FetchFn } from '@/lib/lnurlp';
import { InMemoryMessageStore } from '@/lib/message-store';
import { unsignedNostrDefaults, type MessageRow } from '@/lib/message';
import { setDiagnosticSink } from '@/lib/log';
import { encodeSparkInvoice, uuidV7 } from '@/lib/spark-invoice';
import {
  InMemoryWalletStore,
  type WalletPaymentRecord,
  type WalletStore,
} from '@/lib/wallet-store';
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
const YESTERDAY = '2026-11-08';
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
const RECIPIENT_SPARK_PUBKEY = '02' + 'ab'.repeat(32);
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

function walletPayment(partial: Partial<WalletPaymentRecord> = {}): WalletPaymentRecord {
  return {
    accountId: 'fond-account',
    paymentId: 'p',
    direction: 'in',
    status: 'completed',
    amountSats: 21,
    feeSats: 0,
    paidAt: new Date(NOW),
    method: 'spark',
    paymentHash: null,
    invoice: null,
    destination: null,
    description: null,
    lnurlComment: null,
    category: 'unknown',
    counterpartyAccountId: null,
    firstSeenAt: new Date(NOW),
    updatedAt: new Date(NOW),
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
  const recipient = await store.getAccount('ada');
  await store.claimSparkPubkey('ada', RECIPIENT_SPARK_PUBKEY);
  await store.markSparkPubkeyVerified('ada', RECIPIENT_SPARK_PUBKEY, recipient!.username!, 1);
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
  walletStore?: WalletStore;
  messageStore?: InMemoryMessageStore;
  fundingStore?: InMemoryFundingStore;
  fetchImpl?: FetchFn;
  seedPlatform?: boolean;
  seedRecipient?: boolean;
  now?: () => number;
  freePayments?: boolean;
  randomBytes?: (length: number) => Uint8Array;
}

async function makeApp(options: AppOptions = {}): Promise<{
  app: Hono;
  auth: InMemoryAuthStore;
  payouts: InMemoryFondPayoutStore;
  walletStore: WalletStore;
  invoices: InMemoryInvoiceStore;
  messages: InMemoryMessageStore;
}> {
  const auth = new InMemoryAuthStore();
  const now = options.now ?? (() => NOW);
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
  const payouts = options.payoutStore ?? new InMemoryFondPayoutStore(now);
  const walletStore: WalletStore = options.walletStore ?? new InMemoryWalletStore();
  const invoices = options.actionsStore ?? new InMemoryInvoiceStore();
  const messages = options.messageStore ?? new InMemoryMessageStore();
  const fetchImpl = options.fetchImpl ?? (async () => new Response(null, { status: 500 }));
  const app = new Hono().route(
    '/fond',
    fondRoutes({
      authStore: auth,
      fondPayoutStore: payouts,
      walletStore,
      payoutSigner: options.signer ?? 'fond',
      fondUsername: FOND,
      now,
      fetchImpl,
      lnurlServer: LNURL,
      ...(options.freePayments === undefined ? {} : { freePayments: options.freePayments }),
      ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }),
      actions: {
        store: invoices,
        authStore: auth,
        messageStore: messages,
        now,
        fetchImpl,
        fundingStore: options.fundingStore ?? new InMemoryFundingStore(),
        lnurlServer: LNURL,
      },
    }),
  );
  return {
    app,
    auth,
    payouts,
    walletStore,
    invoices,
    messages,
  };
}

function authHeader(token = TOKEN): { authorization: string } {
  return { authorization: `Bearer ${token}` };
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

/** The payout Spark invoice for one payment hash, with id bytes all 1. */
function payoutSparkInvoice(paymentHash: string): string {
  return encodeSparkInvoice({
    identityPublicKey: RECIPIENT_SPARK_PUBKEY,
    id: uuidV7(NOW, new Uint8Array(10).fill(1)),
    memo: `fond:${paymentHash}`,
    amountSats: 1000,
  });
}

const ONES = (length: number): Uint8Array => new Uint8Array(length).fill(1);

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
    expect((await app.request('/fond/health')).status).toBe(404);
    expect((await app.request('/fond/payouts', { headers: authHeader() })).status).toBe(404);
    expect(
      (
        await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
          method: 'POST',
          headers: authHeader(),
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

  it('returns 403 below fond rank or on the platform, and admits fond and above', async () => {
    const { app, auth } = await makeApp({ seedFond: false });
    await auth.createAccount({
      id: 'not-fond',
      linkingKey: null,
      role: 'moderator',
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

    for (const role of ['fond', 'initiator', 'founder'] as const) {
      const admitted = await makeApp({ seedFond: false });
      await fondAccount(admitted.auth, {
        id: `admitted-${role}`,
        role,
        username: FOND,
        sessionToken: `${role}-session`,
        viewKey: 'b'.repeat(64),
      });
      const res = await admitted.app.request('/fond/payouts', {
        headers: authHeader(`${role}-session`),
      });
      expect(res.status).toBe(200);
    }

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
        walletStore: new InMemoryWalletStore(),
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
  it("lists today's open rows with id, kind, status, utcDay, and paymentHash", async () => {
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
        'paymentHash',
        'status',
        'utcDay',
      ]);
      expect(row as Record<string, unknown>).not.toHaveProperty('bolt11');
      expect(row as Record<string, unknown>).not.toHaveProperty('address');
    }
  });

  it('lists today’s owed, issuing, invoiced, and settling rows oldest first', async () => {
    let clock = NOW;
    const { app, payouts } = await makeApp({ now: () => clock });
    await payouts.enqueue(rowInput());
    clock = NOW + 1;
    await payouts.enqueue(rowInput({ id: 'issuing', address: 'i@example.com' }));
    await payouts.claimForInvoice('issuing', TODAY);
    clock = NOW + 2;
    await payouts.enqueue(rowInput({ id: 'invoiced', address: 'v@example.com' }));
    await payouts.claimForInvoice('invoiced', TODAY);
    await payouts.setInvoiced('invoiced', {
      invoiceId: 'i',
      paymentHash: 'h',
      bolt11: 'b',
      sparkInvoice: null,
      amountMsat: 1_000_000,
    });
    clock = NOW + 3;
    await payouts.enqueue(rowInput({ id: 'settling', address: 's@example.com' }));
    await payouts.claimForInvoice('settling', TODAY);
    await payouts.setInvoiced('settling', {
      invoiceId: 'i2',
      paymentHash: 'h2',
      bolt11: 'b2',
      sparkInvoice: null,
      amountMsat: 1_000_000,
    });
    await payouts.claimSettlement('settling');
    clock = NOW + 4;
    await payouts.enqueue(rowInput({ id: 'paid', address: 'p@example.com' }));
    await payouts.claimForInvoice('paid', TODAY);
    await payouts.setInvoiced('paid', {
      invoiceId: 'i3',
      paymentHash: 'h3',
      bolt11: 'b3',
      sparkInvoice: null,
      amountMsat: 1_000_000,
    });
    await payouts.claimSettlement('paid');
    await payouts.markPaid('paid');

    const res = await app.request('/fond/payouts', { headers: authHeader() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { payouts: Array<Record<string, unknown>> };
    expect(body).toEqual({
      payouts: expect.arrayContaining([
        { id: ROW_ID, kind: 'daily', status: 'owed', utcDay: TODAY, paymentHash: null },
        { id: 'issuing', kind: 'daily', status: 'issuing', utcDay: TODAY, paymentHash: null },
        { id: 'invoiced', kind: 'daily', status: 'invoiced', utcDay: TODAY, paymentHash: 'h' },
        { id: 'settling', kind: 'daily', status: 'settling', utcDay: TODAY, paymentHash: 'h2' },
      ]),
    });
    for (const row of body.payouts) {
      expect(row).not.toHaveProperty('bolt11');
      expect(row).not.toHaveProperty('address');
    }
  });

  it('returns null paymentHash for an invoiced row without a stored hash', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput({ id: 'invoiced', address: 'v@example.com' }));
    await payouts.claimForInvoice('invoiced', TODAY);
    await payouts.setInvoiced('invoiced', {
      invoiceId: 'i',
      paymentHash: 'h',
      bolt11: 'b',
      sparkInvoice: null,
      amountMsat: 1_000_000,
    });
    const row = (await payouts.get('invoiced')) as NonNullable<
      Awaited<ReturnType<typeof payouts.get>>
    >;
    vi.spyOn(payouts, 'listOpen').mockResolvedValueOnce([{ ...row, paymentHash: null }]);

    const res = await app.request('/fond/payouts', { headers: authHeader() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      payouts: [
        {
          id: 'invoiced',
          kind: 'daily',
          status: 'invoiced',
          utcDay: TODAY,
          paymentHash: null,
        },
      ],
    });
  });

  it('returns 503 when the store throws', async () => {
    const { app, payouts } = await makeApp();
    vi.spyOn(payouts, 'listOpen').mockRejectedValue(new Error('down'));
    const res = await app.request('/fond/payouts', { headers: authHeader() });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Payouts are unavailable' });
  });
});

describe('GET /fond/health', () => {
  async function markPaid(
    payouts: InMemoryFondPayoutStore,
    id: string,
    utcDay: string,
  ): Promise<void> {
    await payouts.claimForInvoice(id, utcDay);
    await payouts.setInvoiced(id, {
      invoiceId: INVOICE_ID,
      paymentHash: HASH,
      bolt11: BOLT11,
      sparkInvoice: null,
      amountMsat: 1_000_000,
    });
    await payouts.claimSettlement(id);
    await payouts.markPaid(id);
  }

  it('is 404 when PAYOUT_SIGNER is not fond, and does not read the queue', async () => {
    const events = captureEvents();
    const { app, payouts } = await makeApp({ signer: 'spend' });
    await payouts.enqueue(rowInput());
    const listOpen = vi.spyOn(payouts, 'listOpen');
    const res = await app.request('/fond/health');
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(listOpen).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('is ok with no rows and does not need a session', async () => {
    const events = captureEvents();
    const { app, payouts } = await makeApp({ seedFond: false });
    const listOpen = vi.spyOn(payouts, 'listOpen');
    const anonymous = await app.request('/fond/health');
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get('Cache-Control')).toBe('no-store');
    expect(await anonymous.json()).toEqual({ status: 'ok', open: 0 });
    const bearer = await app.request('/fond/health', {
      headers: { authorization: 'Bearer not-a-session' },
    });
    expect(bearer.status).toBe(200);
    expect(bearer.headers.get('Cache-Control')).toBe('no-store');
    expect(await bearer.json()).toEqual({ status: 'ok', open: 0 });
    expect(listOpen).toHaveBeenNthCalledWith(1, TODAY);
    expect(listOpen).toHaveBeenNthCalledWith(2, YESTERDAY);
    expect(listOpen).toHaveBeenCalledTimes(4);
    expect(events).toEqual([]);
  });

  it('is ok with fresh open rows and ignores paid and failed rows', async () => {
    let clock = NOW - FOND_OVERDUE_MS - 1;
    const { app, payouts } = await makeApp({ now: () => clock });
    await payouts.enqueue(rowInput({ id: 'old-failed', address: 'failed@example.com' }));
    await payouts.claimForInvoice('old-failed', TODAY);
    await payouts.markFailed('old-failed', 'no invoice');
    await payouts.enqueue(rowInput({ id: 'old-paid', address: 'paid@example.com' }));
    await markPaid(payouts, 'old-paid', TODAY);
    clock = NOW;
    await payouts.enqueue(rowInput({ id: 'fresh-1', address: 'one@example.com' }));
    await payouts.enqueue(rowInput({ id: 'fresh-2', address: 'two@example.com' }));
    const res = await app.request('/fond/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ status: 'ok', open: 2 });
  });

  it('is ok when an open row is exactly FOND_OVERDUE_MS old', async () => {
    let clock = NOW - FOND_OVERDUE_MS;
    const { app, payouts } = await makeApp({ now: () => clock });
    await payouts.enqueue(rowInput({ id: 'exact', address: 'exact@example.com' }));
    await payouts.claimForInvoice('exact', TODAY);
    await payouts.setInvoiced('exact', {
      invoiceId: INVOICE_ID,
      paymentHash: HASH,
      bolt11: BOLT11,
      sparkInvoice: null,
      amountMsat: 1_000_000,
    });
    clock = NOW;
    const res = await app.request('/fond/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ status: 'ok', open: 1 });
  });

  it('counts today rows only past the threshold, for any open status', async () => {
    const events = captureEvents();
    let clock = NOW - FOND_OVERDUE_MS - 1;
    const { app, payouts } = await makeApp({ now: () => clock });
    await payouts.enqueue(rowInput({ id: 'late-issuing', address: 'late@example.com' }));
    await payouts.claimForInvoice('late-issuing', TODAY);
    clock = NOW;
    await payouts.enqueue(rowInput({ id: 'fresh-settling', address: 'fresh@example.com' }));
    await payouts.claimForInvoice('fresh-settling', TODAY);
    await payouts.setInvoiced('fresh-settling', {
      invoiceId: INVOICE_ID,
      paymentHash: HASH,
      bolt11: BOLT11,
      sparkInvoice: null,
      amountMsat: 1_000_000,
    });
    await payouts.claimSettlement('fresh-settling');
    const res = await app.request('/fond/health');
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ status: 'overdue', open: 2, overdue: 1 });
    expect(events).toEqual([]);
  });

  it('counts every open row of yesterday, including a fresh one, and ignores paid', async () => {
    const events = captureEvents();
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput({ id: 'today-fresh', address: 'today@example.com' }));
    await payouts.enqueue(rowInput({ id: 'y-owed', utcDay: YESTERDAY, address: 'y1@example.com' }));
    await payouts.enqueue(
      rowInput({
        id: 'y-welcome',
        utcDay: YESTERDAY,
        kind: 'welcome',
        address: 'y2@example.com',
      }),
    );
    await payouts.enqueue(rowInput({ id: 'y-paid', utcDay: YESTERDAY, address: 'y3@example.com' }));
    await markPaid(payouts, 'y-paid', YESTERDAY);
    const res = await app.request('/fond/health');
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ status: 'overdue', open: 1, overdue: 2 });
    expect(events).toEqual([]);
  });

  it('is unavailable when the today read throws', async () => {
    const events = captureEvents();
    const { app, payouts } = await makeApp();
    const listOpen = vi.spyOn(payouts, 'listOpen');
    listOpen.mockRejectedValueOnce(new Error('today down'));
    const res = await app.request('/fond/health');
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ status: 'unavailable' });
    expect(listOpen).toHaveBeenCalledTimes(1);
    expect(listOpen).toHaveBeenCalledWith(TODAY);
    expect(events).toEqual(['fond.payouts.failed']);
  });

  it('is unavailable when the yesterday read throws', async () => {
    const events = captureEvents();
    const { app, payouts } = await makeApp();
    const listOpen = vi.spyOn(payouts, 'listOpen');
    listOpen.mockImplementation((day: string): Promise<FondPayoutRow[]> => {
      if (day === YESTERDAY) {
        return Promise.reject(new Error('yesterday down'));
      }
      return Promise.resolve([]);
    });
    const res = await app.request('/fond/health');
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ status: 'unavailable' });
    expect(listOpen).toHaveBeenNthCalledWith(1, TODAY);
    expect(listOpen).toHaveBeenNthCalledWith(2, YESTERDAY);
    expect(events).toEqual(['fond.payouts.failed']);
  });

  it('reads the previous calendar day across a year boundary and a leap day', async () => {
    const cases = [
      {
        now: Date.parse('2026-01-01T00:30:00.000Z'),
        today: '2026-01-01',
        yesterday: '2025-12-31',
      },
      {
        now: Date.parse('2024-03-01T00:00:00.000Z'),
        today: '2024-03-01',
        yesterday: '2024-02-29',
      },
    ];
    for (const item of cases) {
      const { app, payouts } = await makeApp({ now: () => item.now });
      const listOpen = vi.spyOn(payouts, 'listOpen');
      const res = await app.request('/fond/health');
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(await res.json()).toEqual({ status: 'ok', open: 0 });
      expect(listOpen).toHaveBeenNthCalledWith(1, item.today);
      expect(listOpen).toHaveBeenNthCalledWith(2, item.yesterday);
    }
  });
});

describe('GET /fond/summary', () => {
  async function paidRow(
    payouts: InMemoryFondPayoutStore,
    id: string,
    amountUsd: string,
  ): Promise<void> {
    await payouts.enqueue(rowInput({ id, amountUsd, address: `${id}@example.com` }));
    await payouts.claimForInvoice(id, TODAY);
    await payouts.setInvoiced(id, {
      invoiceId: `inv-${id}`,
      paymentHash: (id.charCodeAt(0) % 16).toString(16).repeat(64),
      bolt11: `lnbc-${id}`,
      sparkInvoice: null,
      amountMsat: 1_000_000,
    });
    await payouts.claimSettlement(id);
    await payouts.markPaid(id);
  }

  it('returns 404 unless PAYOUT_SIGNER is fond', async () => {
    const { app } = await makeApp({ signer: 'spend' });
    const res = await app.request('/fond/summary');
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns zeros and null balance when the Fond account is missing', async () => {
    const { app } = await makeApp({ seedFond: false });
    const res = await app.request('/fond/summary');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({
      username: FOND,
      receivedSats: 0,
      paidOutSats: 0,
      feesSats: 0,
      balanceSats: null,
      balanceSyncedAt: null,
      payoutsPaid: 0,
      payoutsPaidUsd: '0.00',
    });
  });

  it('returns zeros and does not read wallet or payouts for a basis account with the Fond username', async () => {
    const { app, auth, payouts, walletStore } = await makeApp({ seedFond: false });
    await fondAccount(auth, { role: 'basis' });
    const paymentTotals = vi.spyOn(walletStore, 'paymentTotals');
    const latestBalance = vi.spyOn(walletStore, 'latestBalance');
    const paidTotals = vi.spyOn(payouts, 'paidTotals');

    const res = await app.request('/fond/summary');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      username: FOND,
      receivedSats: 0,
      paidOutSats: 0,
      feesSats: 0,
      balanceSats: null,
      balanceSyncedAt: null,
      payoutsPaid: 0,
      payoutsPaidUsd: '0.00',
    });
    expect(paymentTotals).not.toHaveBeenCalled();
    expect(latestBalance).not.toHaveBeenCalled();
    expect(paidTotals).not.toHaveBeenCalled();
  });

  it('returns zeros and does not read wallet or payouts for the platform account with the Fond username', async () => {
    const { app, auth, payouts, walletStore } = await makeApp({ seedFond: false });
    await fondAccount(auth, { role: 'founder', isPlatform: true });
    const paymentTotals = vi.spyOn(walletStore, 'paymentTotals');
    const latestBalance = vi.spyOn(walletStore, 'latestBalance');
    const paidTotals = vi.spyOn(payouts, 'paidTotals');

    const res = await app.request('/fond/summary');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      username: FOND,
      receivedSats: 0,
      paidOutSats: 0,
      feesSats: 0,
      balanceSats: null,
      balanceSyncedAt: null,
      payoutsPaid: 0,
      payoutsPaidUsd: '0.00',
    });
    expect(paymentTotals).not.toHaveBeenCalled();
    expect(latestBalance).not.toHaveBeenCalled();
    expect(paidTotals).not.toHaveBeenCalled();
  });

  it('sums completed movements, latest balance, and paid payouts', async () => {
    const { app, payouts, walletStore } = await makeApp();
    await walletStore.upsertPayments([
      walletPayment({ paymentId: 'in-1', amountSats: 1_000 }),
      walletPayment({ paymentId: 'in-2', amountSats: 250 }),
      walletPayment({ paymentId: 'out-1', direction: 'out', amountSats: 40, feeSats: 2 }),
      walletPayment({ paymentId: 'out-2', direction: 'out', amountSats: 1, feeSats: 3 }),
      walletPayment({ paymentId: 'pending', status: 'pending', amountSats: 9_999 }),
      walletPayment({ paymentId: 'failed', status: 'failed', amountSats: 8_888 }),
      walletPayment({ accountId: 'other', paymentId: 'other', amountSats: 7_777 }),
    ]);
    await walletStore.recordBalance({
      id: 'old',
      accountId: 'fond-account',
      balanceSats: 10,
      syncedAt: new Date('2026-11-10T09:00:00.000Z'),
      receivedAt: new Date('2026-11-10T09:00:00.000Z'),
    });
    await walletStore.recordBalance({
      id: 'new',
      accountId: 'fond-account',
      balanceSats: 1_209,
      syncedAt: new Date('2026-11-10T10:00:00.000Z'),
      receivedAt: new Date('2026-11-10T10:00:00.000Z'),
    });
    await paidRow(payouts, 'aaaa', '1.00');
    await paidRow(payouts, 'bbbb', '2.50');
    await payouts.enqueue(rowInput({ id: 'cccc', amountUsd: '9.99', address: 'open@example.com' }));

    const res = await app.request('/fond/summary');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({
      username: FOND,
      receivedSats: 1_250,
      paidOutSats: 41,
      feesSats: 5,
      balanceSats: 1_209,
      balanceSyncedAt: '2026-11-10T10:00:00.000Z',
      payoutsPaid: 2,
      payoutsPaidUsd: '3.50',
    });
  });

  it('keeps the balance null when the account has no snapshot', async () => {
    const { app, walletStore } = await makeApp();
    await walletStore.upsertPayments([walletPayment({ amountSats: 5 })]);
    const res = await app.request('/fond/summary');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      username: FOND,
      receivedSats: 5,
      paidOutSats: 0,
      feesSats: 0,
      balanceSats: null,
      balanceSyncedAt: null,
      payoutsPaid: 0,
      payoutsPaidUsd: '0.00',
    });
  });

  it('returns 503 without PII when the account lookup throws', async () => {
    const events = captureEvents();
    const { app, auth } = await makeApp();
    vi.spyOn(auth, 'getAccountByUsername').mockRejectedValue(new Error('lookup down'));
    const res = await app.request('/fond/summary');
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'Fond summary is unavailable' });
    expect(events).toEqual(['fond.summary.failed']);
  });

  it('returns 503 when a wallet aggregate throws', async () => {
    const events = captureEvents();
    const { app, walletStore } = await makeApp();
    vi.spyOn(walletStore, 'paymentTotals').mockRejectedValue(new Error('wallet down'));
    const res = await app.request('/fond/summary');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Fond summary is unavailable' });
    expect(events).toEqual(['fond.summary.failed']);
  });

  it('returns 503 when the balance read throws', async () => {
    const events = captureEvents();
    const { app, walletStore } = await makeApp();
    vi.spyOn(walletStore, 'latestBalance').mockRejectedValue(new Error('balance down'));
    const res = await app.request('/fond/summary');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Fond summary is unavailable' });
    expect(events).toEqual(['fond.summary.failed']);
  });

  it('returns 503 when the payout aggregate throws', async () => {
    const events = captureEvents();
    const { app, payouts } = await makeApp();
    vi.spyOn(payouts, 'paidTotals').mockRejectedValue(new Error('payouts down'));
    const res = await app.request('/fond/summary');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Fond summary is unavailable' });
    expect(events).toEqual(['fond.summary.failed']);
  });

  it('returns 503 when a sat total exceeds the safe JSON integer range', async () => {
    const events = captureEvents();
    const { app, walletStore } = await makeApp();
    vi.spyOn(walletStore, 'paymentTotals').mockResolvedValue({
      receivedSats: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      paidOutSats: 0n,
      feesSats: 0n,
    });
    const res = await app.request('/fond/summary');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Fond summary is unavailable' });
    expect(events).toEqual(['fond.summary.failed']);
  });

  it('returns 503 for a negative sat total', async () => {
    const events = captureEvents();
    const { app, walletStore } = await makeApp();
    vi.spyOn(walletStore, 'paymentTotals').mockResolvedValue({
      receivedSats: 0n,
      paidOutSats: -1n,
      feesSats: 0n,
    });
    const res = await app.request('/fond/summary');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Fond summary is unavailable' });
    expect(events).toEqual(['fond.summary.failed']);
  });
});

describe('GET /fond/payments', () => {
  const ALICE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const PLATFORM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const MISSING = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const NO_USERNAME = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const PAID_A = new Date('2026-11-11T13:31:01.000Z');
  const PAID_B = new Date('2026-11-11T13:30:01.000Z');
  const PAID_C = new Date('2026-11-11T13:29:01.000Z');
  const PAID_D = new Date('2026-11-11T13:28:01.000Z');
  const PAID_E = new Date('2026-11-11T13:27:01.000Z');

  async function counterparty(
    auth: InMemoryAuthStore,
    id: string,
    username: string | null,
    name: string | null,
    isPlatform = false,
  ): Promise<void> {
    await auth.createAccount({
      id,
      linkingKey: null,
      role: 'verified',
      name,
      forumLawsDismissed: false,
      location: null,
      viewKey: id.replaceAll('-', '').slice(0, 64).padEnd(64, '0'),
      createdAt: 1,
      rulesAgreedAt: null,
      username,
      ...(isPlatform ? { isPlatform: true } : {}),
    });
  }

  async function seedFondPayments(
    auth: InMemoryAuthStore,
    walletStore: WalletStore,
  ): Promise<void> {
    await counterparty(auth, ALICE, 'alice', 'Alice');
    await counterparty(auth, PLATFORM, 'platform', '21.gifts', true);
    await walletStore.upsertPayments([
      walletPayment({
        accountId: 'fond-account',
        paymentId: 'newest',
        direction: 'in',
        status: 'completed',
        amountSats: 1_000,
        feeSats: 0,
        paidAt: PAID_A,
        category: 'member',
        counterpartyAccountId: ALICE,
      }),
      walletPayment({
        accountId: 'fond-account',
        paymentId: 'older',
        direction: 'out',
        status: 'completed',
        amountSats: 21,
        feeSats: 2,
        paidAt: PAID_B,
        category: 'platform',
        counterpartyAccountId: PLATFORM,
      }),
      walletPayment({
        accountId: 'fond-account',
        paymentId: 'pending',
        direction: 'in',
        status: 'pending',
        amountSats: 9_999,
        paidAt: new Date('2026-11-11T14:00:00.000Z'),
      }),
    ]);
  }

  it('returns 404 with no-store unless PAYOUT_SIGNER is fond', async () => {
    const { app } = await makeApp({ signer: 'spend' });
    const res = await app.request('/fond/payments');
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns an empty page for a missing Fond account without reading payments', async () => {
    const { app, walletStore } = await makeApp({ seedFond: false });
    const list = vi.spyOn(walletStore, 'listPayments');
    const res = await app.request('/fond/payments');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ payments: [], next: null });
    expect(list).not.toHaveBeenCalled();
  });

  it('returns an empty page when the Fond username account cannot sign payouts', async () => {
    const { app, auth, walletStore } = await makeApp({ seedFond: false });
    await fondAccount(auth, { role: 'basis' });
    const list = vi.spyOn(walletStore, 'listPayments');
    const res = await app.request('/fond/payments');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ payments: [], next: null });
    expect(list).not.toHaveBeenCalled();
  });

  it('lists completed payments newest first with known, null, platform, and missing counterparties', async () => {
    const { app, auth, walletStore } = await makeApp();
    await seedFondPayments(auth, walletStore);
    await walletStore.upsertPayments([
      walletPayment({
        accountId: 'fond-account',
        paymentId: 'missing',
        status: 'completed',
        amountSats: 3,
        paidAt: PAID_C,
        category: 'member',
        counterpartyAccountId: MISSING,
      }),
      walletPayment({
        accountId: 'fond-account',
        paymentId: 'private',
        status: 'completed',
        amountSats: 4,
        paidAt: PAID_D,
        counterpartyAccountId: null,
      }),
    ]);
    const res = await app.request('/fond/payments');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({
      payments: [
        {
          id: expect.stringMatching(/^[0-9a-f]{16}$/),
          direction: 'in',
          amountSats: 1_000,
          feeSats: 0,
          paidAt: PAID_A.toISOString(),
          counterparty: { accountId: ALICE, username: 'alice', name: 'Alice' },
          storedFiat: null,
        },
        {
          id: expect.stringMatching(/^[0-9a-f]{16}$/),
          direction: 'out',
          amountSats: 21,
          feeSats: 2,
          paidAt: PAID_B.toISOString(),
          counterparty: null,
          storedFiat: null,
        },
        {
          id: expect.stringMatching(/^[0-9a-f]{16}$/),
          direction: 'in',
          amountSats: 3,
          feeSats: 0,
          paidAt: PAID_C.toISOString(),
          counterparty: null,
          storedFiat: null,
        },
        {
          id: expect.stringMatching(/^[0-9a-f]{16}$/),
          direction: 'in',
          amountSats: 4,
          feeSats: 0,
          paidAt: PAID_D.toISOString(),
          counterparty: null,
          storedFiat: null,
        },
      ],
      next: null,
    });
  });

  it('returns a null counterparty username when the account has no username', async () => {
    const { app, auth, walletStore } = await makeApp();
    await counterparty(auth, NO_USERNAME, null, 'No Username');
    await walletStore.upsertPayments([
      walletPayment({
        accountId: 'fond-account',
        paymentId: 'no-username',
        status: 'completed',
        amountSats: 5,
        paidAt: PAID_A,
        category: 'member',
        counterpartyAccountId: NO_USERNAME,
      }),
    ]);
    const res = await app.request('/fond/payments');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      payments: [
        {
          id: expect.stringMatching(/^[0-9a-f]{16}$/),
          direction: 'in',
          amountSats: 5,
          feeSats: 0,
          paidAt: PAID_A.toISOString(),
          counterparty: { accountId: NO_USERNAME, username: null, name: 'No Username' },
          storedFiat: null,
        },
      ],
      next: null,
    });
  });

  async function paidPayout(
    payouts: InMemoryFondPayoutStore,
    id: string,
    paymentHash: string,
    amountUsd: string,
    invoice: { bolt11?: string; sparkInvoice?: string | null } = {},
  ): Promise<void> {
    await payouts.enqueue(rowInput({ id, address: `${id}@example.com`, amountUsd }));
    await payouts.claimForInvoice(id, TODAY);
    await payouts.setInvoiced(id, {
      invoiceId: `inv-${id}`,
      paymentHash,
      bolt11: invoice.bolt11 ?? 'lnbc1',
      sparkInvoice: invoice.sparkInvoice ?? null,
      amountMsat: 1_000_000,
    });
    await payouts.claimSettlement(id);
    await payouts.markPaid(id);
  }

  it('adds the stored USD of the matching paid payout to an outgoing row', async () => {
    const { app, payouts, walletStore } = await makeApp();
    const hash = 'aa'.repeat(32);
    await paidPayout(payouts, 'paid-out', hash, '1.25');
    await walletStore.upsertPayments([
      walletPayment({
        accountId: 'fond-account',
        paymentId: 'outgoing',
        direction: 'out',
        status: 'completed',
        amountSats: 21,
        feeSats: 2,
        paidAt: PAID_A,
        paymentHash: hash,
      }),
    ]);
    const lookup = vi.spyOn(payouts, 'paidUsdByPaymentHashOrInvoice');
    const res = await app.request('/fond/payments');
    expect(res.status).toBe(200);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith([hash], []);
    const body = (await res.json()) as { payments: Array<Record<string, unknown>> };
    expect(body.payments[0]).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{16}$/),
      direction: 'out',
      amountSats: 21,
      feeSats: 2,
      paidAt: PAID_A.toISOString(),
      counterparty: null,
      storedFiat: { currency: 'USD', amount: '1.25' },
    });
    expect(body.payments[0]).not.toHaveProperty('paymentHash');
  });

  it('adds stored USD for Spark-invoice and BOLT11 matches without a wallet hash', async () => {
    const { app, payouts, walletStore } = await makeApp();
    const sparkInvoice = 'spark1fond-paid';
    const bolt11 = 'lnbc1fond-bolt11';
    const unmatchedHash = 'cc'.repeat(32);
    await paidPayout(payouts, 'spark-paid', 'aa'.repeat(32), '1', { sparkInvoice });
    await paidPayout(payouts, 'bolt11-paid', 'bb'.repeat(32), '2.5', { bolt11 });
    await walletStore.upsertPayments([
      walletPayment({
        accountId: 'fond-account',
        paymentId: 'spark-outgoing',
        direction: 'out',
        status: 'completed',
        paidAt: PAID_A,
        paymentHash: null,
        invoice: sparkInvoice,
      }),
      walletPayment({
        accountId: 'fond-account',
        paymentId: 'bolt11-outgoing',
        direction: 'out',
        status: 'completed',
        paidAt: PAID_B,
        paymentHash: unmatchedHash,
        invoice: bolt11,
      }),
    ]);
    const lookup = vi.spyOn(payouts, 'paidUsdByPaymentHashOrInvoice');
    const res = await app.request('/fond/payments');
    expect(res.status).toBe(200);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith([unmatchedHash], [sparkInvoice, bolt11]);
    const body = (await res.json()) as {
      payments: Array<{ id: string; storedFiat: unknown }>;
    };
    expect(body.payments.map((row) => row.storedFiat)).toEqual([
      { currency: 'USD', amount: '1' },
      { currency: 'USD', amount: '2.5' },
    ]);
    expect(body.payments[0]).not.toHaveProperty('invoice');
  });

  it('leaves storedFiat null for unmatched, incoming, hashless, unpaid, and invalid rows', async () => {
    const events = captureEvents();
    const { app, payouts, walletStore } = await makeApp();
    const matchedHash = 'bb'.repeat(32);
    const unmatchedHash = 'cc'.repeat(32);
    const invoicedHash = 'dd'.repeat(32);
    const invalidHash = 'ee'.repeat(32);
    await paidPayout(payouts, 'paid-out', matchedHash, '2.50');
    await paidPayout(payouts, 'invalid-out', invalidHash, '1.000');
    await payouts.enqueue(rowInput({ id: 'invoiced', address: 'invoiced@example.com' }));
    await payouts.claimForInvoice('invoiced', TODAY);
    await payouts.setInvoiced('invoiced', {
      invoiceId: 'inv-invoiced',
      paymentHash: invoicedHash,
      bolt11: 'lnbc2',
      sparkInvoice: null,
      amountMsat: 1_000_000,
    });
    await walletStore.upsertPayments([
      walletPayment({
        accountId: 'fond-account',
        paymentId: 'unmatched',
        direction: 'out',
        status: 'completed',
        paidAt: PAID_A,
        paymentHash: unmatchedHash,
      }),
      walletPayment({
        accountId: 'fond-account',
        paymentId: 'invoiced-payout',
        direction: 'out',
        status: 'completed',
        paidAt: PAID_B,
        paymentHash: invoicedHash,
      }),
      walletPayment({
        accountId: 'fond-account',
        paymentId: 'incoming',
        direction: 'in',
        status: 'completed',
        paidAt: PAID_C,
        paymentHash: matchedHash,
      }),
      walletPayment({
        accountId: 'fond-account',
        paymentId: 'hashless',
        direction: 'out',
        status: 'completed',
        paidAt: PAID_D,
        paymentHash: null,
      }),
      walletPayment({
        accountId: 'fond-account',
        paymentId: 'invalid-payout',
        direction: 'out',
        status: 'completed',
        paidAt: PAID_E,
        paymentHash: invalidHash,
      }),
    ]);
    const lookup = vi.spyOn(payouts, 'paidUsdByPaymentHashOrInvoice');
    const res = await app.request('/fond/payments');
    expect(res.status).toBe(200);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith([unmatchedHash, invoicedHash, invalidHash], []);
    const body = (await res.json()) as {
      payments: Array<{ direction: string; storedFiat: unknown }>;
    };
    expect(body.payments).toHaveLength(5);
    for (const row of body.payments) {
      expect(row.storedFiat).toBeNull();
    }
    expect(events).toEqual([]);
  });

  it('skips the paid payout read when the page has no outgoing hash or invoice', async () => {
    const { app, payouts, walletStore } = await makeApp();
    await walletStore.upsertPayments([
      walletPayment({
        accountId: 'fond-account',
        paymentId: 'incoming',
        direction: 'in',
        status: 'completed',
        paidAt: PAID_A,
        paymentHash: 'ee'.repeat(32),
      }),
      walletPayment({
        accountId: 'fond-account',
        paymentId: 'hashless',
        direction: 'out',
        status: 'completed',
        paidAt: PAID_B,
        paymentHash: null,
      }),
    ]);
    const lookup = vi.spyOn(payouts, 'paidUsdByPaymentHashOrInvoice');
    const res = await app.request('/fond/payments');
    expect(res.status).toBe(200);
    expect(lookup).not.toHaveBeenCalled();
    const body = (await res.json()) as {
      payments: Array<{ storedFiat: unknown }>;
    };
    expect(body.payments.map((row) => row.storedFiat)).toEqual([null, null]);
  });

  it('returns 503 and logs when the paid payout lookup throws', async () => {
    const events = captureEvents();
    const { app, payouts, walletStore } = await makeApp();
    await walletStore.upsertPayments([
      walletPayment({
        accountId: 'fond-account',
        paymentId: 'outgoing',
        direction: 'out',
        status: 'completed',
        paidAt: PAID_A,
        paymentHash: 'ff'.repeat(32),
      }),
    ]);
    vi.spyOn(payouts, 'paidUsdByPaymentHashOrInvoice').mockRejectedValue(new Error('down'));
    const res = await app.request('/fond/payments');
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'Fond payments are unavailable' });
    expect(events).toEqual(['fond.payments.failed']);
  });

  it.each([
    ['member', { accountId: ALICE, username: 'alice', name: 'Alice' }],
    ['shop', null],
    ['platform', null],
    ['gift', null],
    ['outside_lightning', null],
    ['onchain', null],
    ['unknown', null],
  ] as const)('names a counterparty only for %s rows', async (category, expected) => {
    const { app, auth, walletStore } = await makeApp();
    await counterparty(auth, ALICE, 'alice', 'Alice');
    await walletStore.upsertPayments([
      walletPayment({
        accountId: 'fond-account',
        paymentId: `category-${category}`,
        status: 'completed',
        category,
        counterpartyAccountId: ALICE,
      }),
    ]);
    const res = await app.request('/fond/payments');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      payments: Array<{ counterparty: unknown }>;
    };
    expect(body.payments[0]?.counterparty).toEqual(expected);
  });

  it('returns a null counterparty for a member row without one', async () => {
    const { app, walletStore } = await makeApp();
    await walletStore.upsertPayments([
      walletPayment({
        accountId: 'fond-account',
        category: 'member',
        counterpartyAccountId: null,
      }),
    ]);
    const res = await app.request('/fond/payments');
    const body = (await res.json()) as { payments: Array<{ counterparty: unknown }> };
    expect(body.payments[0]?.counterparty).toBeNull();
  });

  it('returns a null counterparty for a member row whose account no longer exists', async () => {
    const { app, walletStore } = await makeApp();
    await walletStore.upsertPayments([
      walletPayment({
        accountId: 'fond-account',
        category: 'member',
        counterpartyAccountId: MISSING,
      }),
    ]);
    const res = await app.request('/fond/payments');
    const body = (await res.json()) as { payments: Array<{ counterparty: unknown }> };
    expect(body.payments[0]?.counterparty).toBeNull();
  });

  it('returns an opaque id that does not expose the stored payment id', async () => {
    const { app, walletStore } = await makeApp();
    await walletStore.upsertPayments([walletPayment({ accountId: 'fond-account' })]);
    const res = await app.request('/fond/payments');
    const body = (await res.json()) as { payments: Array<{ id: string }> };
    expect(body.payments[0]?.id).toMatch(/^[0-9a-f]{16}$/);
    expect(body.payments[0]?.id).not.toContain('p');
  });

  it('returns a next cursor for a full page and follows it without duplicates', async () => {
    const { app, walletStore } = await makeApp();
    const rows = Array.from({ length: 51 }, (_, index) =>
      walletPayment({
        accountId: 'fond-account',
        paymentId: `p-${String(index).padStart(2, '0')}`,
        status: 'completed',
        amountSats: index,
        paidAt: new Date(NOW - index * 1_000),
      }),
    );
    await walletStore.upsertPayments(rows);
    const first = await app.request('/fond/payments');
    const firstBody = (await first.json()) as {
      payments: Array<{ id: string }>;
      next: string | null;
    };
    expect(firstBody.payments).toHaveLength(50);
    expect(firstBody.next).toEqual(expect.any(String));
    const second = await app.request(`/fond/payments?before=${firstBody.next}`);
    const secondBody = (await second.json()) as {
      payments: Array<{ id: string }>;
      next: string | null;
    };
    expect(second.status).toBe(200);
    expect(secondBody.payments).toHaveLength(1);
    expect(secondBody.next).toBeNull();
    expect(secondBody.payments[0]?.id).not.toBe(firstBody.payments[0]?.id);
  });

  it('uses (paidAt, paymentId) as an exclusive keyset with UTF-8 tie order', async () => {
    const { app, walletStore } = await makeApp();
    const ids = ['B', 'a', '\u{10000}', ...Array.from({ length: 48 }, (_, i) => `p-${i}`)];
    await walletStore.upsertPayments(
      ids.map((paymentId) =>
        walletPayment({ accountId: 'fond-account', paymentId, paidAt: PAID_A }),
      ),
    );
    const first = await app.request('/fond/payments');
    const firstBody = (await first.json()) as {
      payments: Array<{ id: string }>;
      next: string | null;
    };
    expect(firstBody.payments).toHaveLength(50);
    expect(firstBody.next).not.toBeNull();
    const second = await app.request(`/fond/payments?before=${firstBody.next}`);
    const secondBody = (await second.json()) as { payments: Array<{ id: string }> };
    expect(second.status).toBe(200);
    expect(secondBody.payments).toHaveLength(1);
    expect(new Set([...firstBody.payments, ...secondBody.payments].map((row) => row.id)).size).toBe(
      51,
    );
  });

  it('carries only the paid time and public id in the cursor', async () => {
    const { app, walletStore } = await makeApp();
    const rows = Array.from({ length: 51 }, (_, index) =>
      walletPayment({
        accountId: 'fond-account',
        paymentId: `private-${index}`,
        status: 'completed',
        paidAt: new Date(NOW - index * 1_000),
      }),
    );
    await walletStore.upsertPayments(rows);
    const res = await app.request('/fond/payments');
    const body = (await res.json()) as { next: string };
    const decoded = JSON.parse(Buffer.from(body.next, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(decoded).sort()).toEqual(['id', 'paidAt']);
    expect(decoded['id']).toMatch(/^[0-9a-f]{16}$/);
    expect(decoded['paidAt']).toEqual(rows[49]?.paidAt.toISOString());
    expect(Buffer.from(body.next, 'base64url').toString('utf8')).not.toContain('private-');

    const list = vi.spyOn(walletStore, 'listPayments');
    const second = await app.request(`/fond/payments?before=${body.next}`);
    const secondBody = (await second.json()) as { payments: Array<{ id: string }> };
    expect(second.status).toBe(200);
    expect(secondBody.payments).toHaveLength(1);
    expect(list).toHaveBeenNthCalledWith(1, 'fond-account', Number.MAX_SAFE_INTEGER, undefined, {
      status: 'completed',
      paidAt: rows[49]?.paidAt,
    });
    expect(list).toHaveBeenNthCalledWith(
      2,
      'fond-account',
      51,
      { paidAt: rows[49]?.paidAt, paymentId: rows[49]?.paymentId },
      { status: 'completed' },
    );
  });

  it('rejects a cursor whose public id is not a completed payment at that time', async () => {
    const { app, walletStore } = await makeApp();
    await walletStore.upsertPayments([
      walletPayment({
        accountId: 'fond-account',
        paymentId: 'known',
        status: 'completed',
        paidAt: PAID_A,
      }),
    ]);
    const unknown = Buffer.from(
      JSON.stringify({ paidAt: PAID_A.toISOString(), id: '0'.repeat(16) }),
      'utf8',
    ).toString('base64url');
    const res = await app.request(`/fond/payments?before=${unknown}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid cursor' });
  });

  it('rejects a valid public id paired with a different paid time', async () => {
    const { app, walletStore } = await makeApp();
    await walletStore.upsertPayments([
      walletPayment({
        accountId: 'fond-account',
        paymentId: 'known',
        status: 'completed',
        paidAt: PAID_A,
      }),
    ]);
    const first = await app.request('/fond/payments');
    const firstBody = (await first.json()) as { payments: Array<{ id: string }> };
    const mismatched = Buffer.from(
      JSON.stringify({ paidAt: PAID_B.toISOString(), id: firstBody.payments[0]?.id }),
      'utf8',
    ).toString('base64url');
    const res = await app.request(`/fond/payments?before=${mismatched}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid cursor' });
  });

  it.each([
    ['not-base64', '%%%'],
    ['non-canonical base64url', 'AB'],
    ['canonical mismatch', Buffer.from('{}', 'utf8').toString('base64url') + '='],
    ['not JSON', Buffer.from('{', 'utf8').toString('base64url')],
    ['array', Buffer.from('[]', 'utf8').toString('base64url')],
    ['wrong keys', Buffer.from('{"a":"b"}', 'utf8').toString('base64url')],
    [
      'missing key',
      Buffer.from(JSON.stringify({ paidAt: PAID_A.toISOString(), extra: 'x' }), 'utf8').toString(
        'base64url',
      ),
    ],
    [
      'non-string time',
      Buffer.from(JSON.stringify({ paidAt: 1, id: 'a'.repeat(16) }), 'utf8').toString('base64url'),
    ],
    [
      'non-ISO time',
      Buffer.from(
        JSON.stringify({ paidAt: '2026-11-11T13:31:01.000X', id: 'a'.repeat(16) }),
        'utf8',
      ).toString('base64url'),
    ],
    [
      'non-string id',
      Buffer.from(JSON.stringify({ paidAt: PAID_A.toISOString(), id: 1 }), 'utf8').toString(
        'base64url',
      ),
    ],
    [
      'empty id',
      Buffer.from(JSON.stringify({ paidAt: PAID_A.toISOString(), id: '' }), 'utf8').toString(
        'base64url',
      ),
    ],
    [
      'uppercase id',
      Buffer.from(
        JSON.stringify({ paidAt: PAID_A.toISOString(), id: 'A'.repeat(16) }),
        'utf8',
      ).toString('base64url'),
    ],
    [
      'non-hex id',
      Buffer.from(
        JSON.stringify({ paidAt: PAID_A.toISOString(), id: 'g'.repeat(16) }),
        'utf8',
      ).toString('base64url'),
    ],
    [
      'short id',
      Buffer.from(
        JSON.stringify({ paidAt: PAID_A.toISOString(), id: 'a'.repeat(15) }),
        'utf8',
      ).toString('base64url'),
    ],
    [
      'legacy paymentId key',
      Buffer.from(
        JSON.stringify({ paidAt: PAID_A.toISOString(), paymentId: 'p' }),
        'utf8',
      ).toString('base64url'),
    ],
  ])('returns 400 Invalid cursor for %s', async (_name, before) => {
    const { app, walletStore } = await makeApp();
    const list = vi.spyOn(walletStore, 'listPayments');
    const res = await app.request(`/fond/payments?before=${encodeURIComponent(before)}`);
    expect(res.status).toBe(400);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'Invalid cursor' });
    expect(list).not.toHaveBeenCalled();
  });

  it('returns 503 and logs when the account lookup throws', async () => {
    const events = captureEvents();
    const { app, auth } = await makeApp();
    vi.spyOn(auth, 'getAccountByUsername').mockRejectedValue(new Error('down'));
    const res = await app.request('/fond/payments');
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'Fond payments are unavailable' });
    expect(events).toEqual(['fond.payments.failed']);
  });

  it('returns 503 and logs when the payment list throws', async () => {
    const events = captureEvents();
    const { app, walletStore } = await makeApp();
    vi.spyOn(walletStore, 'listPayments').mockRejectedValue(new Error('down'));
    const res = await app.request('/fond/payments');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Fond payments are unavailable' });
    expect(events).toEqual(['fond.payments.failed']);
  });

  it('returns 503 and logs when the counterparty lookup throws', async () => {
    const events = captureEvents();
    const { app, auth, walletStore } = await makeApp();
    await seedFondPayments(auth, walletStore);
    vi.spyOn(auth, 'getAccounts').mockRejectedValue(new Error('down'));
    const res = await app.request('/fond/payments');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Fond payments are unavailable' });
    expect(events).toEqual(['fond.payments.failed']);
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
      sparkInvoice: null,
      amountMsat: 1000,
    });
    await payouts.claimSettlement(PAID_ROW_ID);
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
      sparkInvoice: null,
      amountMsat: 1_000_000,
    });
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: ROW_ID,
      bolt11: BOLT11,
      paymentHash: HASH,
      sparkInvoice: null,
    });
  });

  it('returns the stored invoice after restart without the invoice store', async () => {
    const { app, payouts, invoices } = await makeApp();
    await payouts.enqueue(rowInput());
    await payouts.claimForInvoice(ROW_ID, TODAY);
    await payouts.setInvoiced(ROW_ID, {
      invoiceId: INVOICE_ID,
      paymentHash: HASH,
      bolt11: BOLT11,
      sparkInvoice: null,
      amountMsat: 1_000_000,
    });
    invoices.sweep(NOW + 10_000_000);
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: ROW_ID,
      bolt11: BOLT11,
      paymentHash: HASH,
      sparkInvoice: null,
    });
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
        sparkInvoice: null,
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

  it('returns 409 Invoice in progress for a fresh issuing row with a lease timestamp', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput());
    await payouts.claimForInvoice(ROW_ID, TODAY);
    const current = await payouts.get(ROW_ID);
    vi.spyOn(payouts, 'claimStaleIssuing');
    vi.spyOn(payouts, 'get').mockResolvedValueOnce(current);
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Invoice in progress' });
    expect(payouts.claimStaleIssuing).not.toHaveBeenCalled();
  });

  it('re-claims a stale issuing row and issues its invoice once', async () => {
    let clock = NOW;
    const { app, payouts } = await makeApp({ now: () => clock });
    await payouts.enqueue(rowInput());
    await payouts.claimForInvoice(ROW_ID, TODAY);
    clock = NOW + 120_001;
    mockedIssue.mockResolvedValue({ ok: true, invoice: invoice() });
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: ROW_ID,
      bolt11: BOLT11,
      paymentHash: HASH,
      sparkInvoice: null,
    });
    expect(mockedIssue).toHaveBeenCalledTimes(1);
    expect(await payouts.get(ROW_ID)).toMatchObject({ status: 'invoiced', claimedAt: null });
  });

  it('does not issue when the stale issuing re-claim loses the race', async () => {
    let clock = NOW;
    const { app, payouts } = await makeApp({ now: () => clock });
    await payouts.enqueue(rowInput());
    await payouts.claimForInvoice(ROW_ID, TODAY);
    clock = NOW + 120_001;
    vi.spyOn(payouts, 'claimStaleIssuing').mockResolvedValueOnce(undefined);
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Invoice in progress' });
    expect(mockedIssue).not.toHaveBeenCalled();
  });

  it('returns 503 when the stale issuing re-claim throws', async () => {
    const events = captureEvents();
    let clock = NOW;
    const { app, payouts } = await makeApp({ now: () => clock });
    await payouts.enqueue(rowInput());
    await payouts.claimForInvoice(ROW_ID, TODAY);
    clock = NOW + 120_001;
    vi.spyOn(payouts, 'claimStaleIssuing').mockRejectedValueOnce(new Error('down'));
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Payouts are unavailable' });
    expect(events).toContain('fond.invoice.failed');
  });

  it('treats a missing claimedAt as fresh and does not re-claim', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput());
    await payouts.claimForInvoice(ROW_ID, TODAY);
    const current = await payouts.get(ROW_ID);
    vi.spyOn(payouts, 'get').mockResolvedValueOnce(
      current === undefined ? undefined : { ...current, claimedAt: null },
    );
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Invoice in progress' });
  });

  it('returns 409 Not payable for a settling row', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput());
    await payouts.claimForInvoice(ROW_ID, TODAY);
    await payouts.setInvoiced(ROW_ID, {
      invoiceId: INVOICE_ID,
      paymentHash: HASH,
      bolt11: BOLT11,
      sparkInvoice: null,
      amountMsat: 1_000_000,
    });
    await payouts.claimSettlement(ROW_ID);
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Not payable' });
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
      sparkInvoice: null,
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
    expect(await res.json()).toEqual({
      id: ROW_ID,
      bolt11: BOLT11,
      paymentHash: HASH,
      sparkInvoice: null,
    });
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
        sparkInvoice: null,
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

  it('rounds an exact half sat up where float arithmetic would round down', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput({ amountUsd: '1.005' }));
    mockedSpot.mockResolvedValueOnce('67000000');
    mockedIssue.mockResolvedValue({ ok: true, invoice: invoice() });
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    expect(mockedIssue.mock.calls[0]?.[1].amountMsat).toBe(2000);
  });

  it('refuses a spot string that is not a positive decimal', async () => {
    for (const spot of ['abc', '0', '-1', '1.2.3']) {
      const { app, payouts } = await makeApp();
      await payouts.enqueue(rowInput());
      mockedSpot.mockResolvedValueOnce(spot);
      const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
        method: 'POST',
        headers: authHeader(),
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Price unavailable' });
    }
  });

  it('refuses a stored USD string that is not a positive decimal', async () => {
    for (const amountUsd of ['abc', '0', '00.5', '-1']) {
      const { app, payouts } = await makeApp();
      await payouts.enqueue(rowInput({ amountUsd }));
      mockedSpot.mockResolvedValueOnce('67000000');
      const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
        method: 'POST',
        headers: authHeader(),
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Price unavailable' });
    }
  });

  it('refuses a conversion above the safe integer range', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput({ amountUsd: '999999999999999999' }));
    mockedSpot.mockResolvedValueOnce('0.000000000001');
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Price unavailable' });
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
    expect(await res.json()).toEqual({
      id: ROW_ID,
      bolt11: BOLT11,
      paymentHash: HASH,
      sparkInvoice: null,
    });
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

  it('issues one Spark invoice for a wallet and returns it unchanged', async () => {
    const { app, payouts } = await makeApp({
      seedRecipient: true,
      freePayments: true,
      randomBytes: ONES,
    });
    await payouts.enqueue(rowInput({ address: 'ada@gifts.test' }));
    mockedIssue.mockResolvedValue({ ok: true, invoice: invoice() });
    const expected = payoutSparkInvoice(HASH);

    const first = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      id: ROW_ID,
      bolt11: BOLT11,
      paymentHash: HASH,
      sparkInvoice: expected,
    });
    expect(await payouts.get(ROW_ID)).toMatchObject({ sparkInvoice: expected });
    expect(mockedIssue).toHaveBeenCalledTimes(1);

    const second = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      id: ROW_ID,
      bolt11: BOLT11,
      paymentHash: HASH,
      sparkInvoice: expected,
    });
    expect(mockedIssue).toHaveBeenCalledTimes(1);
  });

  it('returns no Spark invoice when free in-app payments are off', async () => {
    const { app, payouts } = await makeApp({ seedRecipient: true });
    await payouts.enqueue(rowInput({ address: 'ada@gifts.test' }));
    mockedIssue.mockResolvedValue({ ok: true, invoice: invoice() });
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: ROW_ID,
      bolt11: BOLT11,
      paymentHash: HASH,
      sparkInvoice: null,
    });
  });

  it('draws the Spark invoice id from crypto randomness by default', async () => {
    const { app, payouts } = await makeApp({ seedRecipient: true, freePayments: true });
    await payouts.enqueue(rowInput({ address: 'ada@gifts.test' }));
    mockedIssue.mockResolvedValue({ ok: true, invoice: invoice() });
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sparkInvoice: string | null };
    expect(body.sparkInvoice?.startsWith('spark1')).toBe(true);
  });

  it('returns no Spark invoice for a recipient without a verified wallet', async () => {
    const { app, payouts } = await makeApp({ freePayments: true });
    await payouts.enqueue(rowInput({ address: 'ada@gifts.test' }));
    mockedIssue.mockResolvedValue({ ok: true, invoice: invoice() });
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: ROW_ID,
      bolt11: BOLT11,
      paymentHash: HASH,
      sparkInvoice: null,
    });
  });

  it('falls back to the BOLT11 and logs when issuing the Spark invoice fails', async () => {
    const events = captureEvents();
    const { app, auth, payouts } = await makeApp({
      seedRecipient: true,
      freePayments: true,
    });
    await payouts.enqueue(rowInput({ address: 'ada@gifts.test' }));
    mockedIssue.mockResolvedValue({ ok: true, invoice: invoice() });
    vi.spyOn(auth, 'getAccountByUsername').mockRejectedValueOnce(new Error('down'));
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: ROW_ID,
      bolt11: BOLT11,
      paymentHash: HASH,
      sparkInvoice: null,
    });
    expect(await payouts.get(ROW_ID)).toMatchObject({ sparkInvoice: null });
    expect(events).toContain('fond.spark_invoice.issue_failed');
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

  it('passes the stored exact USD string unchanged', async () => {
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput({ amountUsd: '0.004' }));
    mockedIssue.mockResolvedValue({ ok: true, invoice: invoice() });
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    expect(mockedIssue.mock.calls[0]?.[1].amountMsat).toBe(4000);
    expect(mockedIssue.mock.calls[0]?.[1]).toMatchObject({ amountUsd: '0.004' });
    expect(await payouts.get(ROW_ID)).toMatchObject({ status: 'invoiced', failure: null });
  });

  it.each(['1.23', '1'])('passes the stored %s USD byte-identically', async (decided) => {
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
      expect.objectContaining({ amountUsd: decided }),
    );
    expect(mockedIssue.mock.calls[0]?.[1].amountMsat).toBe(decided === '1' ? 1_000_000 : 1_230_000);
    expect(await payouts.get(ROW_ID)).toMatchObject({ status: 'invoiced', failure: null });
  });

  it('passes a below-cent stored string unchanged and lets the validator refuse it', async () => {
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
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with address and amountMsat',
    });
    expect(await payouts.get(ROW_ID)).toMatchObject({ status: 'failed' });
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

  it('returns 503 when the row stopped being payable during issue', async () => {
    const events = captureEvents();
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput());
    mockedIssue.mockResolvedValue({ ok: true, invoice: invoice() });
    vi.spyOn(payouts, 'setInvoiced').mockResolvedValue(undefined);
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Payouts are unavailable' });
    expect((await payouts.get(ROW_ID))?.status).toBe('issuing');
    expect(events).toContain('fond.invoice.failed');
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

  it('returns 503 Payouts are unavailable when markFailed misses the transition', async () => {
    const events = captureEvents();
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput());
    mockedIssue.mockResolvedValue({ ok: false, status: 403, error: 'Passkey required' });
    vi.spyOn(payouts, 'markFailed').mockResolvedValueOnce(undefined);
    const res = await app.request(`/fond/payouts/${ROW_ID}/invoice`, {
      method: 'POST',
      headers: authHeader(),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Payouts are unavailable' });
    expect(events).toContain('fond.invoice.failed');
  });

  it('returns 503 Payouts are unavailable when releaseClaim misses the transition', async () => {
    const events = captureEvents();
    const { app, payouts } = await makeApp();
    await payouts.enqueue(rowInput());
    mockedSpot.mockResolvedValueOnce(null);
    vi.spyOn(payouts, 'releaseClaim').mockResolvedValueOnce(undefined);
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
