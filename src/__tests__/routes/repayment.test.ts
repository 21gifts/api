import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import { ensureAccountNostrKey } from '@/lib/nostr/keys';
import { parseNostrKek } from '@/lib/nostr/kek';
import { InvoiceRateLimiter, PostRateLimiter } from '@/lib/nostr/rate-limit';
import { messagesRoutes } from '@/routes/messages';
import { REPAYMENT_BILLS_MAX, myLoansRoutes } from '@/routes/repayment';
import type { GoalRateDay } from '@/lib/goal-rate';
import { InMemorySparkInvoiceStore } from '@/lib/spark-invoice-store';
import type { MessageInvoiceAttempt } from '@/lib/message-store';
import { resolveZapRelays } from '@/lib/nostr/relays';
import {
  BOLT11,
  LNURL_SERVER,
  WALLET_PUBKEY,
  allInternal,
  createWalletAccount,
  walletLnurlFetch,
  type SeenRequest,
} from '@/__tests__/helpers/wallet-lnurl';

const now = (): number => Date.UTC(2026, 10, 13, 12);
const CREDIT = '55555555-5555-4555-8555-555555555555';
const GIVER = '11111111-1111-4111-8111-111111111111';

async function readyCredit(options?: {
  rules?: boolean;
  eventId?: string | null;
  /** `false` leaves the default giver without a verified wallet. */
  giverWallet?: boolean;
  giverKey?: boolean;
  kek?: boolean;
  fundedAt?: Date | null;
  termDays?: number | null;
  goalCurrency?: 'USD';
  goalAmount?: string | null;
  rate?: boolean;
  /** When set with `rate`, each quote reads `current` so a test can move the price. */
  rateUsd?: { current: string };
  authorId?: string;
  giverAccount?: boolean;
  giverName?: string | null;
  giverUsername?: string | null;
  fetch?: boolean;
  pr?: string;
  /** Giver from `createWalletAccount`, answered by `walletLnurlFetch`, with the Spark store mounted. */
  walletGiver?: boolean;
  /** Test-only repayment limiter override. */
  repaymentLimiter?: InvoiceRateLimiter;
}): Promise<{
  app: Hono;
  messages: InMemoryMessageStore;
  auth: InMemoryAuthStore;
  seen: SeenRequest[];
}> {
  const kek = parseNostrKek('11'.repeat(32));
  const authorId = options?.authorId ?? 'acc';
  const auth = new InMemoryAuthStore();
  await auth.createAccount({
    id: authorId,
    linkingKey: `02${'ab'.repeat(32)}`,
    role: 'verified',
    name: 'Ada',
    forumLawsDismissed: false,
    location: null,
    viewKey: 'a'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: options?.rules === false ? null : now(),
    username: 'ada',
  });
  if (options?.walletGiver === true) {
    await createWalletAccount(auth, GIVER, 'bea');
  } else if (options?.giverAccount !== false) {
    await auth.createAccount({
      id: GIVER,
      linkingKey: `02${'cd'.repeat(32)}`,
      role: 'verified',
      name: options?.giverName === undefined ? 'Bea' : options.giverName,
      walletRequired: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: now(),
      username: options?.giverUsername === undefined ? 'bea' : options.giverUsername,
    });
    const giverUsername = options?.giverUsername === undefined ? 'bea' : options.giverUsername;
    if (options?.giverWallet !== false && giverUsername !== null) {
      await auth.claimSparkPubkey(GIVER, WALLET_PUBKEY);
      await auth.markSparkPubkeyVerified(GIVER, WALLET_PUBKEY, giverUsername, 2);
    }
  }
  await auth.createSession({ token: authorId, accountId: authorId, createdAt: now() });
  await ensureAccountNostrKey(auth, authorId, kek);
  if (options?.giverAccount !== false && options?.giverKey !== false) {
    await ensureAccountNostrKey(auth, GIVER, kek);
  }
  const messages = new InMemoryMessageStore();
  await messages.create({
    id: CREDIT,
    accountId: authorId,
    name: 'Ada',
    text: 'need a ticket',
    createdAt: new Date(now()),
    hasPhoto: false,
    ...unsignedNostrDefaults(),
    eventId: options?.eventId === undefined ? 'ee'.repeat(32) : options.eventId,
    sats: 21,
    goalSats: options?.fundedAt === null ? 1000 : 21,
    goalRepayable: true,
    goalTermDays: options?.termDays === undefined ? 1 : options.termDays,
    goalFundedAt:
      options?.fundedAt === undefined ? new Date(Date.UTC(2026, 10, 11, 12)) : options.fundedAt,
    ...(options?.goalCurrency === undefined
      ? {}
      : {
          goalCurrency: options.goalCurrency,
          goalAmount: options.goalAmount === undefined ? '0.21' : options.goalAmount,
        }),
  });
  await messages.recordZapReceipt('r1', CREDIT, 21, null);
  await messages.updateZapReceiptGift('r1', { payerAccountId: GIVER });
  const lnurlFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.includes('/.well-known/lnurlp/')) {
      return new Response(
        JSON.stringify({
          callback: `${LNURL_SERVER.publicBaseUrl}/lnurlp/bea/invoice`,
          minSendable: 1000,
          maxSendable: 10_000_000_000,
          allowsNostr: true,
          nostrPubkey: 'aa'.repeat(32),
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ pr: options?.pr ?? 'lnbc21n1repay' }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  const wallet = walletLnurlFetch('bea');
  const fetchImpl = options?.walletGiver === true ? wallet.fetchImpl : lnurlFetch;
  const app = new Hono().route(
    '/messages',
    messagesRoutes({
      store: messages,
      authStore: auth,
      now,
      ...(options?.kek === false ? {} : { nostrKek: kek }),
      ...(options?.rate
        ? {
            goalRateDay: async () => ({
              sats: 100_000_000,
              usd: options.rateUsd?.current ?? '100000.00',
              chf: null,
              eur: null,
              php: null,
            }),
          }
        : {}),
      ...(options?.fetch === false ? {} : { fetchImpl }),
      lnurlServer: LNURL_SERVER,
      ...(options?.walletGiver === true ? { sparkInvoices: new InMemorySparkInvoiceStore() } : {}),
      postLimiter: new PostRateLimiter(),
      invoiceLimiter: new InvoiceRateLimiter(),
      ...(options?.repaymentLimiter === undefined
        ? {}
        : { repaymentLimiter: options.repaymentLimiter }),
    }),
  );
  return { app, messages, auth, seen: wallet.seen };
}

describe('credit repayment', () => {
  it('lists the public ledger without a session', async () => {
    const { app, messages } = await readyCredit();
    await messages.recordZapReceipt('r-anon', CREDIT, 5, null);
    const res = await app.request(`/messages/${CREDIT}/repayment`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      currency: string;
      startsOn: string | null;
      unassignedSats: number;
      givers: { name: string; givenSats: number }[];
      repayments: { dueOn: string; sats: number; status: string; via: string }[];
    };
    expect(body.currency).toBe('BTC');
    expect(body.startsOn).toBe('2026-11-12');
    expect(body.unassignedSats).toBe(5);
    expect(body.givers).toEqual([
      {
        accountId: GIVER,
        name: 'Bea',
        username: 'bea',
        givenSats: 21,
        givenAmount: null,
        canReceive: true,
      },
    ]);
    expect(body.repayments[0]).toMatchObject({
      dueOn: '2026-11-12',
      sats: 21,
      status: 'due',
      via: 'lightning',
      amount: null,
      name: 'Bea',
      dueSats: 21,
    });
    const post = await app.request(`/messages/${CREDIT}/repayment`, { method: 'POST' });
    expect(post.status).toBe(401);
    const badPost = await app.request(`/messages/${CREDIT}/repayment`, {
      method: 'POST',
      headers: { authorization: 'Bearer nope' },
    });
    expect(badPost.status).toBe(401);
    const badId = await app.request('/messages/not-a-uuid/repayment', {
      method: 'POST',
      headers: { authorization: 'Bearer acc' },
    });
    expect(badId.status).toBe(404);
  });

  it('starts a credit filled before November 10, 2026 on 2026-11-10', async () => {
    const { app } = await readyCredit({ fundedAt: new Date(Date.UTC(2026, 9, 9, 6)) });
    const res = await app.request(`/messages/${CREDIT}/repayment`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      startsOn: string | null;
      repayments: { dueOn: string | null }[];
    };
    expect(body.startsOn).toBe('2026-11-10');
    expect(body.repayments[0]?.dueOn).toBe('2026-11-10');
  });

  it('shows the due share and invoices the giver wallet address', async () => {
    const bolt11 = await import('@/lib/bolt11');
    const lnurlPay = await import('@/lib/lnurl-pay');
    const nip57 = vi.spyOn(bolt11, 'isNip57Invoice').mockReturnValue(true);
    const requestSpy = vi.spyOn(lnurlPay, 'requestZapInvoice');
    try {
      const { app, messages } = await readyCredit();
      const status = await app.request(`/messages/${CREDIT}/repayment`, {
        headers: { authorization: 'Bearer acc' },
      });
      expect(status.status).toBe(200);
      const body = (await status.json()) as { daysDue: number; next: { sats: number } };
      expect(body.daysDue).toBeGreaterThan(0);
      expect(body.next.sats).toBe(21);
      const pay = await app.request(`/messages/${CREDIT}/repayment`, {
        method: 'POST',
        headers: { authorization: 'Bearer acc' },
      });
      expect(pay.status).toBe(200);
      expect(await pay.json()).toEqual({ pr: 'lnbc21n1repay', amountSats: 21, sparkInvoice: null });
      const attempt = (await messages.listInvoiceAttempts(5))[0];
      expect(attempt?.lightningAddress).toBe('bea@example.test');
      expect(attempt?.description).toBe(`repay:0:${GIVER}`);
      const zapRequestJson = requestSpy.mock.calls[0]?.[0]?.zapRequestJson;
      expect(typeof zapRequestJson).toBe('string');
      const relays = (JSON.parse(zapRequestJson ?? '') as { tags: string[][] }).tags
        .find((tag) => tag[0] === 'relays')
        ?.slice(1);
      expect(relays?.length).toBeGreaterThan(0);
      const read = resolveZapRelays(process.env);
      expect(relays?.every((url) => read.includes(url))).toBe(true);
      expect(nip57.mock.calls[0]?.[1]).toBe(zapRequestJson);
      expect(Object.keys(JSON.parse(zapRequestJson ?? ''))).toEqual([
        'id',
        'pubkey',
        'created_at',
        'kind',
        'tags',
        'content',
        'sig',
      ]);
      const again = await app.request(`/messages/${CREDIT}/repayment`, {
        method: 'POST',
        headers: { authorization: 'Bearer acc' },
      });
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({
        pr: 'lnbc21n1repay',
        amountSats: 21,
        sparkInvoice: null,
      });
      expect(await messages.listInvoiceAttempts(5)).toHaveLength(1);
    } finally {
      nip57.mockRestore();
      requestSpy.mockRestore();
    }
  });

  it('returns the open repayment invoice when the fiat price moves', async () => {
    const bolt11 = await import('@/lib/bolt11');
    const nip57 = vi.spyOn(bolt11, 'isNip57Invoice').mockReturnValue(true);
    const rate = { current: '100000.00' };
    try {
      const { app, messages } = await readyCredit({
        authorId: 'acc-reprice',
        goalCurrency: 'USD',
        goalAmount: '0.01',
        rate: true,
        rateUsd: rate,
      });
      await messages.recordZapIngest({
        id: '11111111-1111-4111-8111-111111111113',
        createdAt: new Date(now()),
        receiptId: 'r1',
        noteEventId: null,
        messageId: CREDIT,
        outcome: 'indexed',
        reason: null,
        amountSats: 21,
        amountUsd: '0.01',
        amountChf: '0.01',
        amountEur: '0.01',
        amountPhp: '0.01',
        receiptPubkey: null,
        receipt: {},
      });
      const first = await app.request(`/messages/${CREDIT}/repayment`, {
        method: 'POST',
        headers: { authorization: 'Bearer acc-reprice' },
      });
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({
        pr: 'lnbc21n1repay',
        amountSats: 10,
        sparkInvoice: null,
      });
      rate.current = '50000.00';
      const second = await app.request(`/messages/${CREDIT}/repayment`, {
        method: 'POST',
        headers: { authorization: 'Bearer acc-reprice' },
      });
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({
        pr: 'lnbc21n1repay',
        amountSats: 10,
        sparkInvoice: null,
      });
      expect(await messages.listInvoiceAttempts(5)).toHaveLength(1);
    } finally {
      nip57.mockRestore();
    }
  });

  it('mints again when the outstanding repayment invoice has expired', async () => {
    const bolt11 = await import('@/lib/bolt11');
    const nip57 = vi.spyOn(bolt11, 'isNip57Invoice').mockReturnValue(true);
    const inspected = vi.spyOn(bolt11, 'inspectBolt11').mockReturnValue({
      paymentHash: 'ab'.repeat(32),
      amountMsat: 21_000,
      description: null,
      descriptionHash: null,
      expirySeconds: 0,
    });
    // `invoiceStillOpen` lives next to `inspectBolt11`, so the spy above does
    // not reach its internal call; expire the stored invoice through it.
    const stillOpen = vi.spyOn(bolt11, 'invoiceStillOpen').mockReturnValue(false);
    try {
      const { app } = await readyCredit({ authorId: 'acc-expire' });
      const first = await app.request(`/messages/${CREDIT}/repayment`, {
        method: 'POST',
        headers: { authorization: 'Bearer acc-expire' },
      });
      expect(first.status).toBe(200);
      const second = await app.request(`/messages/${CREDIT}/repayment`, {
        method: 'POST',
        headers: { authorization: 'Bearer acc-expire' },
      });
      expect(second.status).toBe(429);
    } finally {
      nip57.mockRestore();
      inspected.mockRestore();
      stillOpen.mockRestore();
    }
  });

  it('returns 429 when the injected repayment limiter denies', async () => {
    const repaymentLimiter = new InvoiceRateLimiter();
    vi.spyOn(repaymentLimiter, 'allow').mockReturnValue(false);
    const { app } = await readyCredit({ authorId: 'acc-lim', repaymentLimiter });
    const res = await app.request(`/messages/${CREDIT}/repayment`, {
      method: 'POST',
      headers: { authorization: 'Bearer acc-lim' },
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Too many payments' });
    expect(res.headers.get('Retry-After')).toBe('10');
  });

  it('refuses an author who has not agreed to the rules', async () => {
    const { app } = await readyCredit({ rules: false, authorId: 'acc-rules' });
    const res = await app.request(`/messages/${CREDIT}/repayment`, {
      method: 'POST',
      headers: { authorization: 'Bearer acc-rules' },
    });
    expect(res.status).toBe(409);
  });

  it('says nothing is due on the funding day', async () => {
    const { app } = await readyCredit({
      authorId: 'acc-today',
      fundedAt: new Date(now()),
    });
    const res = await app.request(`/messages/${CREDIT}/repayment`, {
      method: 'POST',
      headers: { authorization: 'Bearer acc-today' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Nothing is due' });
    const status = await app.request(`/messages/${CREDIT}/repayment`, {
      headers: { authorization: 'Bearer acc-today' },
    });
    expect(status.status).toBe(200);
    expect((await status.json()) as { next: null }).toMatchObject({ next: null });
  });

  it('refuses a note that is not signed yet', async () => {
    const { app } = await readyCredit({ authorId: 'acc-unsigned', eventId: null });
    const res = await app.request(`/messages/${CREDIT}/repayment`, {
      method: 'POST',
      headers: { authorization: 'Bearer acc-unsigned' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'This message cannot be paid yet' });
    const blank = await readyCredit({ authorId: 'acc-blank-event', eventId: '' });
    const empty = await blank.app.request(`/messages/${CREDIT}/repayment`, {
      method: 'POST',
      headers: { authorization: 'Bearer acc-blank-event' },
    });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: 'This message cannot be paid yet' });
  });

  it('refuses a giver without a verified wallet or key', async () => {
    const missingAddress = await readyCredit({
      authorId: 'acc-noaddr',
      giverWallet: false,
    });
    const noAddress = await missingAddress.app.request(`/messages/${CREDIT}/repayment`, {
      method: 'POST',
      headers: { authorization: 'Bearer acc-noaddr' },
    });
    expect(noAddress.status).toBe(400);
    expect(await noAddress.json()).toEqual({
      error: 'A giver has no Lightning address',
      code: 'cannot_receive',
    });
    const missingKey = await readyCredit({ authorId: 'acc-nokey', giverKey: false });
    const noKey = await missingKey.app.request(`/messages/${CREDIT}/repayment`, {
      method: 'POST',
      headers: { authorization: 'Bearer acc-nokey' },
    });
    expect(noKey.status).toBe(400);
    expect(await noKey.json()).toEqual({ error: 'A giver has no Lightning address' });
  });

  it('is unavailable without a signing key', async () => {
    const { app } = await readyCredit({ authorId: 'acc-kek', kek: false });
    const res = await app.request(`/messages/${CREDIT}/repayment`, {
      method: 'POST',
      headers: { authorization: 'Bearer acc-kek' },
    });
    expect(res.status).toBe(503);
    const sign = await import('@/lib/nostr/sign');
    const broken = vi.spyOn(sign, 'signEventForAccount').mockRejectedValue(new Error('sign'));
    const signed = await readyCredit({ authorId: 'acc-sign' });
    const signRes = await signed.app.request(`/messages/${CREDIT}/repayment`, {
      method: 'POST',
      headers: { authorization: 'Bearer acc-sign' },
    });
    broken.mockRestore();
    expect(signRes.status).toBe(503);
  });

  it('reports a wallet that cannot take a zap', async () => {
    const { app } = await readyCredit({ authorId: 'acc-nozap' });
    const original = globalThis.fetch;
    const routes = await import('@/lib/lnurl-pay');
    const spy = vi.spyOn(routes, 'requestZapInvoice').mockResolvedValue({
      ok: false,
      reason: 'noZap',
      lnurlResponse: null,
    });
    void original;
    const res = await app.request(`/messages/${CREDIT}/repayment`, {
      method: 'POST',
      headers: { authorization: 'Bearer acc-nozap' },
    });
    spy.mockRestore();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "The recipient's wallet cannot receive this Bitcoin payment",
      code: 'cannot_receive',
    });
  });

  it('reports an unreachable wallet and a non-zap invoice', async () => {
    const unreachable = await readyCredit({ authorId: 'acc-down' });
    const down = vi.spyOn(await import('@/lib/lnurl-pay'), 'requestZapInvoice').mockResolvedValue({
      ok: false,
      reason: 'unreachable',
      lnurlResponse: null,
    });
    const downRes = await unreachable.app.request(`/messages/${CREDIT}/repayment`, {
      method: 'POST',
      headers: { authorization: 'Bearer acc-down' },
    });
    down.mockRestore();
    expect(downRes.status).toBe(400);
    expect(await downRes.json()).toEqual({ error: 'Could not start the Bitcoin payment' });
    const plain = await readyCredit({ authorId: 'acc-plain' });
    const plainRes = await plain.app.request(`/messages/${CREDIT}/repayment`, {
      method: 'POST',
      headers: { authorization: 'Bearer acc-plain' },
    });
    expect(plainRes.status).toBe(400);
    expect(await plainRes.json()).toEqual({
      error: "The recipient's wallet cannot receive this Bitcoin payment",
      code: 'cannot_receive',
    });
  });

  it('does not hand out an invoice when recording the attempt throws', async () => {
    const bolt11 = await import('@/lib/bolt11');
    const nip57 = vi.spyOn(bolt11, 'isNip57Invoice').mockReturnValue(true);
    try {
      const { app, messages } = await readyCredit({ authorId: 'acc-disk' });
      messages.recordInvoiceAttempt = () => Promise.reject(new Error('disk'));
      const res = await app.request(`/messages/${CREDIT}/repayment`, {
        method: 'POST',
        headers: { authorization: 'Bearer acc-disk' },
      });
      expect(res.status).toBe(503);
    } finally {
      nip57.mockRestore();
    }
  });

  it('counts a paid day and ignores an unknown note', async () => {
    const { app, messages } = await readyCredit({ authorId: 'acc-paid' });
    await messages.markRepaymentPaid({
      messageId: CREDIT,
      dayIndex: 1,
      recipientAccountId: GIVER,
      dueSats: 21,
      paidAt: new Date(now()),
    });
    await messages.markRepaymentPaid({
      messageId: CREDIT,
      dayIndex: 0,
      recipientAccountId: '77777777-7777-4777-8777-777777777777',
      dueSats: 21,
      paidAt: new Date(now()),
    });
    await messages.markRepaymentPaid({
      messageId: CREDIT,
      dayIndex: 0,
      recipientAccountId: GIVER,
      dueSats: 21,
      paidAt: new Date(now()),
    });
    const status = await app.request(`/messages/${CREDIT}/repayment`, {
      headers: { authorization: 'Bearer acc-paid' },
    });
    expect(status.status).toBe(200);
    expect((await status.json()) as { next: null }).toMatchObject({ next: null, daysPaid: 1 });
    const missing = await app.request('/messages/22222222-2222-4222-8222-222222222222/repayment', {
      headers: { authorization: 'Bearer acc-paid' },
    });
    expect(missing.status).toBe(404);
    await messages.create({
      id: '33333333-3333-4333-8333-333333333333',
      accountId: 'acc-paid',
      name: 'Ada',
      text: 'plain',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const plain = await app.request('/messages/33333333-3333-4333-8333-333333333333/repayment');
    expect(plain.status).toBe(404);
    const badToken = await app.request(`/messages/${CREDIT}/repayment`, {
      headers: { authorization: 'Bearer nope' },
    });
    expect(badToken.status).toBe(200);
    await messages.markDeleted(CREDIT, new Date(now()), 'acc-paid');
    const hidden = await app.request(`/messages/${CREDIT}/repayment`);
    expect(hidden.status).toBe(404);
  });

  it('looks past a paid first day when the term has a later day', async () => {
    const { app, messages } = await readyCredit({ authorId: 'acc-twoday', termDays: 2 });
    await messages.markRepaymentPaid({
      messageId: CREDIT,
      dayIndex: 0,
      recipientAccountId: GIVER,
      dueSats: 10,
      paidAt: new Date(now()),
    });
    const status = await app.request(`/messages/${CREDIT}/repayment`, {
      headers: { authorization: 'Bearer acc-twoday' },
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      daysPaid: 1,
      next: { dayIndex: 1, recipientAccountId: GIVER, sats: 11 },
    });
  });

  it('prices a fiat day and rejects a bad id', async () => {
    const { app } = await readyCredit({
      authorId: 'acc-fiat',
      goalCurrency: 'USD',
      goalAmount: '0.21',
      rate: true,
    });
    const status = await app.request(`/messages/${CREDIT}/repayment`, {
      headers: { authorization: 'Bearer acc-fiat' },
    });
    expect(status.status).toBe(200);
    const missing = await app.request('/messages/not-a-uuid/repayment', {
      headers: { authorization: 'Bearer acc-fiat' },
    });
    expect(missing.status).toBe(404);
    const unavailable = await readyCredit({
      authorId: 'acc-norate',
      goalCurrency: 'USD',
      goalAmount: '0.21',
    });
    const blocked = await unavailable.app.request(`/messages/${CREDIT}/repayment`, {
      method: 'POST',
      headers: { authorization: 'Bearer acc-norate' },
    });
    expect(blocked.status).toBe(503);
    const looked = await unavailable.app.request(`/messages/${CREDIT}/repayment`, {
      headers: { authorization: 'Bearer acc-norate' },
    });
    expect(looked.status).toBe(503);
    const blank = await readyCredit({
      authorId: 'acc-blank',
      goalCurrency: 'USD',
      goalAmount: null,
      rate: true,
    });
    const blankRes = await blank.app.request(`/messages/${CREDIT}/repayment`, {
      headers: { authorization: 'Bearer acc-blank' },
    });
    expect(blankRes.status).toBe(503);
    const blankPost = await blank.app.request(`/messages/${CREDIT}/repayment`, {
      method: 'POST',
      headers: { authorization: 'Bearer acc-blank' },
    });
    expect(blankPost.status).toBe(503);
  });

  it('refuses a missing giver, rejects an undecodable invoice, and returns a payable one', async () => {
    const ghost = await readyCredit({ authorId: 'acc-ghost', giverAccount: false });
    const listed = await ghost.app.request(`/messages/${CREDIT}/repayment`);
    expect(listed.status).toBe(200);
    expect((await listed.json()) as { givers: { name: string }[] }).toMatchObject({
      givers: [{ name: '', username: null }],
    });
    const missingGiver = await ghost.app.request(`/messages/${CREDIT}/repayment`, {
      method: 'POST',
      headers: { authorization: 'Bearer acc-ghost' },
    });
    expect(missingGiver.status).toBe(400);
    const unnamed = await readyCredit({
      authorId: 'acc-noname',
      giverName: null,
      giverUsername: null,
    });
    const blankName = await unnamed.app.request(`/messages/${CREDIT}/repayment`);
    expect((await blankName.json()) as { givers: { name: string }[] }).toMatchObject({
      givers: [{ name: '', username: null }],
    });
    const bolt11 = await import('@/lib/bolt11');
    const nip57 = vi.spyOn(bolt11, 'isNip57Invoice').mockReturnValue(true);
    const decoded = vi.spyOn(bolt11, 'inspectBolt11').mockReturnValue({
      paymentHash: 'ab'.repeat(32),
      amountMsat: 21_000,
      description: null,
      descriptionHash: 'cd'.repeat(32),
      expirySeconds: null,
    });
    const offline = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    try {
      const native = await readyCredit({ authorId: 'acc-native', fetch: false });
      const nativeRes = await native.app.request(`/messages/${CREDIT}/repayment`, {
        method: 'POST',
        headers: { authorization: 'Bearer acc-native' },
      });
      expect(nativeRes.status).toBe(400);
      const blank = await readyCredit({ authorId: 'acc-blankpr' });
      const blankRes = await blank.app.request(`/messages/${CREDIT}/repayment`, {
        method: 'POST',
        headers: { authorization: 'Bearer acc-blankpr' },
      });
      expect(blankRes.status).toBe(200);
      expect(await blankRes.json()).toEqual({
        pr: 'lnbc21n1repay',
        amountSats: 21,
        sparkInvoice: null,
      });
    } finally {
      nip57.mockRestore();
      decoded.mockRestore();
      offline.mockRestore();
    }
  });

  it('shows an open credit and refuses payment until it is funded', async () => {
    const unfunded = await readyCredit({ authorId: 'acc-open', fundedAt: null });
    const open = await unfunded.app.request(`/messages/${CREDIT}/repayment`, {
      headers: { authorization: 'Bearer acc-open' },
    });
    expect(open.status).toBe(200);
    expect((await open.json()) as { fundedAt: null; next: null }).toMatchObject({
      fundedAt: null,
      startsOn: null,
      next: null,
      repayments: [{ dueOn: null, status: 'scheduled', sats: 21 }],
    });
    const pay = await unfunded.app.request(`/messages/${CREDIT}/repayment`, {
      method: 'POST',
      headers: { authorization: 'Bearer acc-open' },
    });
    expect(pay.status).toBe(404);
    const closed = await readyCredit({ authorId: 'acc-closed' });
    const unknown = await closed.app.request(
      '/messages/22222222-2222-4222-8222-222222222222/repayment',
      { method: 'POST', headers: { authorization: 'Bearer acc-closed' } },
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'Not found' });
    await closed.messages.create({
      id: '33333333-3333-4333-8333-333333333334',
      accountId: 'acc-closed',
      name: 'Ada',
      text: 'plain',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const plain = await closed.app.request(
      '/messages/33333333-3333-4333-8333-333333333334/repayment',
      { method: 'POST', headers: { authorization: 'Bearer acc-closed' } },
    );
    expect(plain.status).toBe(404);
    await closed.auth.createSession({ token: 'giver-closed', accountId: GIVER, createdAt: now() });
    const stranger = await closed.app.request(`/messages/${CREDIT}/repayment`, {
      method: 'POST',
      headers: { authorization: 'Bearer giver-closed' },
    });
    expect(stranger.status).toBe(404);
    await closed.messages.markDeleted(CREDIT, new Date(now()), 'acc-closed');
    const hidden = await closed.app.request(`/messages/${CREDIT}/repayment`, {
      method: 'POST',
      headers: { authorization: 'Bearer acc-closed' },
    });
    expect(hidden.status).toBe(404);
    const noTermPost = await readyCredit({ authorId: 'acc-noterm-post', termDays: null });
    const missingTermPost = await noTermPost.app.request(`/messages/${CREDIT}/repayment`, {
      method: 'POST',
      headers: { authorization: 'Bearer acc-noterm-post' },
    });
    expect(missingTermPost.status).toBe(404);
    const noTerm = await readyCredit({ authorId: 'acc-noterm', termDays: null });
    const missingTerm = await noTerm.app.request(`/messages/${CREDIT}/repayment`, {
      headers: { authorization: 'Bearer acc-noterm' },
    });
    expect(missingTerm.status).toBe(404);
  });

  it('repays the recorded cent, not a rounded-away share', async () => {
    const { app, messages } = await readyCredit({
      authorId: 'acc-cent',
      goalCurrency: 'USD',
      goalAmount: '0.01',
      rate: true,
    });
    await messages.recordZapIngest({
      id: '11111111-1111-4111-8111-111111111112',
      createdAt: new Date(now()),
      receiptId: 'r1',
      noteEventId: null,
      messageId: CREDIT,
      outcome: 'indexed',
      reason: null,
      amountSats: 21,
      amountUsd: '0.01',
      amountChf: '0.01',
      amountEur: '0.01',
      amountPhp: '0.01',
      receiptPubkey: null,
      receipt: {},
    });
    const payers = await messages.listCreditPayers(CREDIT);
    expect(payers[0]?.usd).toBe('0.01');
    const status = await app.request(`/messages/${CREDIT}/repayment`, {
      headers: { authorization: 'Bearer acc-cent' },
    });
    expect(status.status).toBe(200);
    expect((await status.json()) as { next: { sats: number } }).toMatchObject({
      next: { sats: 10, recipientAccountId: GIVER },
      givers: [{ givenAmount: '0.01' }],
      repayments: [{ amount: '0.01', sats: null, status: 'due' }],
    });
    await messages.markRepaymentPaid({
      messageId: CREDIT,
      dayIndex: 0,
      recipientAccountId: GIVER,
      dueSats: 10,
      paidAt: new Date(now()),
    });
    const again = await app.request(`/messages/${CREDIT}/repayment`, {
      headers: { authorization: 'Bearer acc-cent' },
    });
    expect((await again.json()) as { repayments: { sats: number }[] }).toMatchObject({
      repayments: [{ amount: '0.01', sats: 10, status: 'paid' }],
      next: null,
    });
  });

  it('drops account-less sat weight from a fiat split when the snapshot is missing', async () => {
    const bolt11 = await import('@/lib/bolt11');
    const nip57 = vi.spyOn(bolt11, 'isNip57Invoice').mockReturnValue(true);
    try {
      const { app, messages } = await readyCredit({
        authorId: 'acc-open-weight',
        goalCurrency: 'USD',
        goalAmount: '1.00',
        rate: true,
      });
      await messages.recordZapReceipt('r-anon-weight', CREDIT, 21, null);
      const status = await app.request(`/messages/${CREDIT}/repayment`, {
        headers: { authorization: 'Bearer acc-open-weight' },
      });
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({
        unassignedSats: 21,
        givers: [{ accountId: GIVER, givenAmount: '0.50' }],
        repayments: [{ amount: '0.50', accountId: GIVER }],
        next: { sats: 500, recipientAccountId: GIVER },
      });
      const pay = await app.request(`/messages/${CREDIT}/repayment`, {
        method: 'POST',
        headers: { authorization: 'Bearer acc-open-weight' },
      });
      expect(pay.status).toBe(200);
      expect(await pay.json()).toEqual({
        pr: 'lnbc21n1repay',
        amountSats: 500,
        sparkInvoice: null,
      });
    } finally {
      nip57.mockRestore();
    }
  });
});

describe('credit repayment to a wallet-backed giver', () => {
  async function postRepay(app: Hono, payer: string): Promise<Response> {
    return app.request(`/messages/${CREDIT}/repayment`, {
      method: 'POST',
      headers: { authorization: `Bearer ${payer}` },
    });
  }

  function outstandingAttempt(overrides: Partial<MessageInvoiceAttempt>): MessageInvoiceAttempt {
    return {
      id: crypto.randomUUID(),
      createdAt: new Date(now()),
      messageId: CREDIT,
      payerAccountId: 'acc',
      authorAccountId: GIVER,
      amountSats: 21,
      lightningAddress: 'bea@example.test',
      zapRequest: null,
      result: 'ok',
      httpStatus: 200,
      pr: BOLT11,
      paymentHash: null,
      description: `repay:0:${GIVER}`,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
      conversationId: null,
      conversationMessageId: null,
      fiatPinned: false,
      amountUsd: null,
      amountChf: null,
      amountEur: null,
      amountPhp: null,
      ...overrides,
    };
  }

  it('invoices the wallet internally and hands out the same Spark invoice again', async () => {
    const bolt11 = await import('@/lib/bolt11');
    const nip57 = vi.spyOn(bolt11, 'isNip57Invoice').mockReturnValue(true);
    try {
      const { app, messages, seen } = await readyCredit({ walletGiver: true, authorId: 'wal-1' });
      const first = await postRepay(app, 'wal-1');
      expect(first.status).toBe(200);
      const body = (await first.json()) as { pr: string; amountSats: number; sparkInvoice: string };
      expect(body.pr).toBe(BOLT11);
      expect(body.amountSats).toBe(21);
      expect(body.sparkInvoice.startsWith('spark1')).toBe(true);
      expect(allInternal(seen)).toBe(true);
      const attempt = (await messages.listInvoiceAttempts(5))[0];
      expect(attempt?.lightningAddress).toBe('bea@example.test');
      const again = await postRepay(app, 'wal-1');
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual(body);
      expect(await messages.listInvoiceAttempts(5)).toHaveLength(1);
    } finally {
      nip57.mockRestore();
    }
  });

  it('reuses an open invoice without a Spark invoice when its zap request is unusable', async () => {
    const { app, messages } = await readyCredit({ walletGiver: true, authorId: 'wal-3' });
    await messages.recordInvoiceAttempt(outstandingAttempt({ zapRequest: null }));
    const res = await postRepay(app, 'wal-3');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pr: BOLT11, amountSats: 21, sparkInvoice: null });
  });

  it('waits for an open invoice minted for another address, then mints for the wallet', async () => {
    const bolt11 = await import('@/lib/bolt11');
    const nip57 = vi.spyOn(bolt11, 'isNip57Invoice').mockReturnValue(true);
    try {
      const earlier = await readyCredit({ pr: BOLT11, authorId: 'wal-4' });
      expect((await postRepay(earlier.app, 'wal-4')).status).toBe(200);
      const stored = (await earlier.messages.listInvoiceAttempts(5))[0];
      expect(stored?.lightningAddress).toBe('bea@example.test');
      const open = await readyCredit({ walletGiver: true, authorId: 'wal-5' });
      await open.messages.recordInvoiceAttempt(
        outstandingAttempt({
          lightningAddress: 'bea@example.com',
          zapRequest: stored?.zapRequest ?? null,
        }),
      );
      const refused = await postRepay(open.app, 'wal-5');
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: 'A payment for this share is still open' });
      expect(await open.messages.listInvoiceAttempts(5)).toHaveLength(1);

      const expired = await readyCredit({ walletGiver: true, authorId: 'wal-6' });
      await expired.messages.recordInvoiceAttempt(
        outstandingAttempt({
          lightningAddress: 'bea@example.com',
          zapRequest: stored?.zapRequest ?? null,
          createdAt: new Date(now() - 30 * 24 * 60 * 60 * 1000),
        }),
      );
      expect((await postRepay(expired.app, 'wal-6')).status).toBe(200);
      const attempts = await expired.messages.listInvoiceAttempts(5);
      expect(attempts.map((row) => row.lightningAddress).sort()).toEqual([
        'bea@example.com',
        'bea@example.test',
      ]);
    } finally {
      nip57.mockRestore();
    }
  });
});

describe('repayment from the in-app wallet', () => {
  const AUTHOR = 'loan-author';
  const WALLET_GIVER = '22222222-2222-4222-8222-222222222222';
  const NO_WALLET = '33333333-3333-4333-8333-333333333333';
  const SECOND_CREDIT = '66666666-6666-4666-8666-666666666666';
  /** Monday 2027-03-01 12:00 UTC: a credit funded 2027-02-27 has days 0 and 1 due. */
  const MONDAY = Date.UTC(2027, 2, 1, 12);
  const SUNDAY = Date.UTC(2027, 1, 28, 12);

  interface Giver {
    id: string;
    sats: number;
    /** A verified wallet: the giver can receive. */
    wallet: boolean;
    /** Stored identity key; defaults to a per-giver key. */
    sparkPubkey?: string;
  }

  /** Answers any wallet-backed username on the LNURL server with a zap-capable pay request. */
  function anyWalletFetch(options?: {
    pr?: string;
    allowsNostr?: boolean;
    seen?: string[];
  }): (input: string | URL | Request) => Promise<Response> {
    return async (input) => {
      const url = String(input);
      options?.seen?.push(url);
      const lud16 = /\/\.well-known\/lnurlp\/([^/?]+)$/.exec(url);
      if (lud16 !== null) {
        return Response.json({
          tag: 'payRequest',
          callback: `${LNURL_SERVER.publicBaseUrl}/lnurlp/${lud16[1] ?? ''}/invoice`,
          metadata: '[["text/plain","x"]]',
          minSendable: 1000,
          maxSendable: 1_000_000_000,
          allowsNostr: options?.allowsNostr ?? true,
          nostrPubkey: 'bb'.repeat(32),
        });
      }
      return Response.json({ pr: options?.pr ?? BOLT11 });
    };
  }

  async function loanSetup(options?: {
    givers?: Giver[];
    now?: number;
    termDays?: number;
    fundedAt?: Date | null;
    goalCurrency?: 'USD';
    goalAmount?: string | null;
    rate?: boolean;
    /** Rate loader; overrides `rate`. */
    rates?: () => Promise<GoalRateDay | null>;
    eventId?: string | null;
    rules?: boolean;
    limiter?: InvoiceRateLimiter;
    allowsNostr?: boolean;
    sparkInvoices?: boolean;
  }): Promise<{
    app: Hono;
    messages: InMemoryMessageStore;
    auth: InMemoryAuthStore;
    clock: { now: number };
    fetched: string[];
  }> {
    const clock = { now: options?.now ?? MONDAY };
    const fetched: string[] = [];
    const now = (): number => clock.now;
    const kek = parseNostrKek('11'.repeat(32));
    const auth = new InMemoryAuthStore();
    await auth.createAccount({
      id: AUTHOR,
      linkingKey: `02${'ab'.repeat(32)}`,
      role: 'verified',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: options?.rules === false ? null : 1,
      username: 'ada',
    });
    await auth.createSession({ token: AUTHOR, accountId: AUTHOR, createdAt: clock.now });
    await ensureAccountNostrKey(auth, AUTHOR, kek);
    const givers = options?.givers ?? [
      { id: WALLET_GIVER, sats: 300, wallet: true },
      { id: NO_WALLET, sats: 500, wallet: false },
    ];
    for (const [index, giver] of givers.entries()) {
      const username = `giver${index}`;
      await auth.createAccount({
        id: giver.id,
        linkingKey: null,
        role: 'verified',
        name: `Giver ${index}`,
        username,
        forumLawsDismissed: false,
        location: null,
        viewKey: `${index}`.repeat(64).slice(0, 64),
        createdAt: 1,
        rulesAgreedAt: 1,
        walletRequired: true,
      });
      if (giver.wallet) {
        const key = giver.sparkPubkey ?? `02${String(index + 1).padStart(64, '0')}`;
        await auth.claimSparkPubkey(giver.id, key);
        expect(await auth.markSparkPubkeyVerified(giver.id, key, username, 2)).toBe(true);
      }
      await ensureAccountNostrKey(auth, giver.id, kek);
    }
    const messages = new InMemoryMessageStore();
    const total = givers.reduce((sum, giver) => sum + giver.sats, 0);
    await messages.create({
      id: CREDIT,
      accountId: AUTHOR,
      name: 'Ada',
      text: `${'x'.repeat(170)}`,
      createdAt: new Date(Date.UTC(2027, 1, 21)),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: options?.eventId === undefined ? 'ee'.repeat(32) : options.eventId,
      sats: 0,
      goalSats: options?.fundedAt === null ? total * 2 : total,
      goalRepayable: true,
      goalTermDays: options?.termDays ?? 2,
      goalFundedAt:
        options?.fundedAt === undefined ? new Date(Date.UTC(2027, 1, 27, 12)) : options.fundedAt,
      ...(options?.goalCurrency === undefined
        ? {}
        : {
            goalCurrency: options.goalCurrency,
            goalAmount: options.goalAmount === undefined ? '8.00' : options.goalAmount,
          }),
    });
    for (const giver of givers) {
      await messages.recordZapReceipt(`r-${giver.id}`, CREDIT, giver.sats, null);
      await messages.updateZapReceiptGift(`r-${giver.id}`, { payerAccountId: giver.id });
    }
    const goalRateDay =
      options?.rates ??
      (options?.rate === true
        ? async () => ({
            sats: 100_000_000,
            usd: '100000.00',
            chf: null,
            eur: null,
            php: null,
          })
        : async () => null);
    const app = new Hono()
      .route(
        '/messages',
        messagesRoutes({
          store: messages,
          authStore: auth,
          now,
          nostrKek: kek,
          goalRateDay,
          fetchImpl: anyWalletFetch({
            seen: fetched,
            ...(options?.allowsNostr === undefined ? {} : { allowsNostr: options.allowsNostr }),
          }),
          lnurlServer: LNURL_SERVER,
          ...(options?.sparkInvoices === true
            ? { sparkInvoices: new InMemorySparkInvoiceStore() }
            : {}),
          postLimiter: new PostRateLimiter(),
          invoiceLimiter: new InvoiceRateLimiter(),
          repaymentLimiter:
            options?.limiter ?? new InvoiceRateLimiter({ burstCap: 1000, hourCap: 1000 }),
        }),
      )
      .route(
        '/',
        myLoansRoutes({
          store: messages,
          authStore: auth,
          now,
          goalRateDay,
          lnurlServer: LNURL_SERVER,
        }),
      );
    return { app, messages, auth, clock, fetched };
  }

  function post(app: Hono, path: string, token = AUTHOR): Promise<Response> {
    return Promise.resolve(
      app.request(path, { method: 'POST', headers: { authorization: `Bearer ${token}` } }),
    );
  }

  function loans(app: Hono, headers: Record<string, string> = {}): Promise<Response> {
    return Promise.resolve(
      app.request('/me/loans', { headers: { authorization: `Bearer ${AUTHOR}`, ...headers } }),
    );
  }

  async function withNip57<T>(run: () => Promise<T>): Promise<T> {
    const bolt11 = await import('@/lib/bolt11');
    const nip57 = vi.spyOn(bolt11, 'isNip57Invoice').mockReturnValue(true);
    try {
      return await run();
    } finally {
      nip57.mockRestore();
    }
  }

  it('marks who can receive and prices each due line on the public ledger', async () => {
    const { app } = await loanSetup();
    const res = await app.request(`/messages/${CREDIT}/repayment`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      daysDue: number;
      daysPaid: number;
      givers: { accountId: string; canReceive: boolean }[];
      repayments: { dayIndex: number; accountId: string; status: string; dueSats: number }[];
      next: { dayIndex: number; recipientAccountId: string; sats: number } | null;
    };
    expect(body.givers.map((giver) => [giver.accountId, giver.canReceive])).toEqual([
      [WALLET_GIVER, true],
      [NO_WALLET, false],
    ]);
    expect(
      body.repayments.map((line) => [line.dayIndex, line.accountId, line.status, line.dueSats]),
    ).toEqual([
      [0, NO_WALLET, 'due', 250],
      [0, WALLET_GIVER, 'due', 150],
      [1, NO_WALLET, 'due', 250],
      [1, WALLET_GIVER, 'due', 150],
    ]);
    expect(body.daysDue).toBe(2);
    expect(body.daysPaid).toBe(0);
    expect(body.next).toEqual({ dayIndex: 0, recipientAccountId: WALLET_GIVER, sats: 150 });
  });

  it('leaves dueSats null on lines that are not due and refuses a due fiat share without a rate', async () => {
    const early = await loanSetup({ now: Date.UTC(2027, 1, 27, 20) });
    const scheduled = (await (await early.app.request(`/messages/${CREDIT}/repayment`)).json()) as {
      repayments: { status: string; dueSats: number | null }[];
    };
    expect(scheduled.repayments.every((line) => line.status === 'scheduled')).toBe(true);
    expect(scheduled.repayments.every((line) => line.dueSats === null)).toBe(true);
    const fiat = await loanSetup({
      goalCurrency: 'USD',
      givers: [{ id: NO_WALLET, sats: 500, wallet: false }],
    });
    // Every due share waits for a giver without a wallet; the missing rate still answers 503.
    const res = await fiat.app.request(`/messages/${CREDIT}/repayment`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Ask amount is unavailable' });
    const single = await post(fiat.app, `/messages/${CREDIT}/repayment`);
    expect(single.status).toBe(503);
    expect(await single.json()).toEqual({ error: 'Ask amount is unavailable' });
    const priced = await loanSetup({
      goalCurrency: 'USD',
      rate: true,
      givers: [{ id: NO_WALLET, sats: 500, wallet: false }],
    });
    const pricedBody = (await (
      await priced.app.request(`/messages/${CREDIT}/repayment`)
    ).json()) as { repayments: { dueSats: number | null }[] };
    expect(pricedBody.repayments[0]?.dueSats).toBe(4000);
  });

  it('prices every figure of one response at one read of the rate', async () => {
    let reads = 0;
    // Each read halves the rate, so a second read would show in the figures.
    const rates = async (): Promise<GoalRateDay> => {
      reads += 1;
      return {
        sats: 100_000_000,
        usd: reads === 1 ? '100000.00' : '50000.00',
        chf: null,
        eur: null,
        php: null,
      };
    };
    const { app, messages } = await loanSetup({ goalCurrency: 'USD', rates });
    const body = (await (await app.request(`/messages/${CREDIT}/repayment`)).json()) as {
      repayments: { dayIndex: number; accountId: string; dueSats: number | null }[];
      next: { dayIndex: number; recipientAccountId: string; sats: number };
    };
    expect(reads).toBe(1);
    expect(body.next).toEqual({ dayIndex: 0, recipientAccountId: WALLET_GIVER, sats: 1500 });
    const line = body.repayments.find(
      (item) => item.dayIndex === 0 && item.accountId === WALLET_GIVER,
    );
    expect(line?.dueSats).toBe(1500);
    await messages.create({
      id: SECOND_CREDIT,
      accountId: AUTHOR,
      name: 'Ada',
      text: 'second loan',
      createdAt: new Date(Date.UTC(2027, 1, 28)),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      sats: 0,
      goalSats: 1000,
      goalRepayable: true,
      goalTermDays: 10,
      goalCurrency: 'USD',
      goalAmount: '10.00',
    });
    reads = 0;
    const listed = await loans(app);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { loans: unknown[] }).loans).toHaveLength(2);
    expect(reads).toBe(1);
  });

  it('reads no rate when nothing needs pricing', async () => {
    const rates = async (): Promise<GoalRateDay> => {
      throw new Error('fx.rate.missing');
    };
    // Funding day: nothing is due yet.
    const today = await loanSetup({
      goalCurrency: 'USD',
      rates,
      now: Date.UTC(2027, 1, 27, 20),
    });
    const due = await post(today.app, `/messages/${CREDIT}/repayment/due`);
    expect(due.status).toBe(200);
    expect(await due.json()).toEqual({ bills: [], waiting: [] });
    expect((await today.app.request(`/messages/${CREDIT}/repayment`)).status).toBe(200);
    const single = await post(today.app, `/messages/${CREDIT}/repayment`);
    expect(single.status).toBe(400);
    expect(await single.json()).toEqual({ error: 'Nothing is due' });
    // A repaid fiat loan is left out, and a collecting one with no giver totals 0.
    const repaid = await loanSetup({ goalCurrency: 'USD', rates });
    for (const dayIndex of [0, 1]) {
      for (const recipientAccountId of [WALLET_GIVER, NO_WALLET]) {
        await repaid.messages.markRepaymentPaid({
          messageId: CREDIT,
          dayIndex,
          recipientAccountId,
          dueSats: 1,
          paidAt: new Date(MONDAY),
        });
      }
    }
    await repaid.messages.create({
      id: SECOND_CREDIT,
      accountId: AUTHOR,
      name: 'Ada',
      text: 'second loan',
      createdAt: new Date(Date.UTC(2027, 1, 28)),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      sats: 0,
      goalSats: 1000,
      goalRepayable: true,
      goalTermDays: 10,
      goalCurrency: 'USD',
      goalAmount: '10.00',
    });
    const listed = await loans(repaid.app);
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { loans: Record<string, unknown>[] };
    expect(body.loans.map((loan) => [loan['messageId'], loan['totalSats']])).toEqual([
      [SECOND_CREDIT, 0],
    ]);
  });

  it('answers 503 when the rate loader fails while a due fiat share needs a price', async () => {
    const rates = async (): Promise<GoalRateDay> => {
      throw new Error('fx.rate.missing');
    };
    const { app } = await loanSetup({ goalCurrency: 'USD', rates });
    const due = await post(app, `/messages/${CREDIT}/repayment/due`);
    expect(due.status).toBe(503);
    expect(await due.json()).toEqual({ error: 'Ask amount is unavailable' });
    const single = await post(app, `/messages/${CREDIT}/repayment`);
    expect(single.status).toBe(503);
    expect(await single.json()).toEqual({ error: 'Ask amount is unavailable' });
    const ledger = await app.request(`/messages/${CREDIT}/repayment`);
    expect(ledger.status).toBe(503);
    expect(await ledger.json()).toEqual({ error: 'Ask amount is unavailable' });
  });

  it('skips a giver who cannot receive and bills the next share', async () => {
    await withNip57(async () => {
      const { app, messages } = await loanSetup();
      const res = await post(app, `/messages/${CREDIT}/repayment`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ pr: BOLT11, amountSats: 150, sparkInvoice: null });
      const [attempt] = await messages.listInvoiceAttempts(5);
      expect(attempt?.description).toBe(`repay:0:${WALLET_GIVER}`);
      expect(attempt?.authorAccountId).toBe(WALLET_GIVER);
    });
  });

  it('answers cannot_receive when every due share waits for a giver without a wallet', async () => {
    const { app } = await loanSetup({ givers: [{ id: NO_WALLET, sats: 500, wallet: false }] });
    const res = await post(app, `/messages/${CREDIT}/repayment`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'A giver has no Lightning address',
      code: 'cannot_receive',
    });
    const bills = await post(app, `/messages/${CREDIT}/repayment/due`);
    expect(bills.status).toBe(200);
    expect(((await bills.json()) as { bills: unknown[] }).bills).toEqual([]);
  });

  it('bills every payable share at once and lists the shares that wait', async () => {
    await withNip57(async () => {
      const limiter = new InvoiceRateLimiter({ burstCap: 1, hourCap: 20 });
      const { app, messages } = await loanSetup({ limiter });
      const res = await post(app, `/messages/${CREDIT}/repayment/due`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { bills: unknown[]; waiting: unknown[] };
      const bill = {
        recipientAccountId: WALLET_GIVER,
        name: 'Giver 0',
        username: 'giver0',
        amountSats: 150,
        amount: null,
        pr: BOLT11,
        sparkInvoice: null,
      };
      expect(body.bills).toEqual([
        { dayIndex: 0, ...bill },
        { dayIndex: 1, ...bill },
      ]);
      const wait = {
        recipientAccountId: NO_WALLET,
        name: 'Giver 1',
        username: 'giver1',
        amountSats: 250,
        amount: null,
      };
      expect(body.waiting).toEqual([
        { dayIndex: 0, ...wait },
        { dayIndex: 1, ...wait },
      ]);
      const attempts = await messages.listInvoiceAttempts(10);
      expect(attempts.map((row) => row.description).sort()).toEqual([
        `repay:0:${WALLET_GIVER}`,
        `repay:1:${WALLET_GIVER}`,
      ]);
      // Both bills are open: a second call reuses them and needs no limiter hit.
      const again = await post(app, `/messages/${CREDIT}/repayment/due`);
      expect(again.status).toBe(200);
      expect(((await again.json()) as { bills: unknown[] }).bills).toEqual(body.bills);
      expect(await messages.listInvoiceAttempts(10)).toHaveLength(2);
      const single = await post(app, `/messages/${CREDIT}/repayment`);
      expect(await single.json()).toEqual({ pr: BOLT11, amountSats: 150, sparkInvoice: null });
      expect(await messages.listInvoiceAttempts(10)).toHaveLength(2);
    });
  });

  it('hands out the Spark invoice with each bill for a wallet-backed giver', async () => {
    await withNip57(async () => {
      const { app } = await loanSetup({
        sparkInvoices: true,
        givers: [{ id: WALLET_GIVER, sats: 42, wallet: true, sparkPubkey: WALLET_PUBKEY }],
      });
      const res = await post(app, `/messages/${CREDIT}/repayment/due`);
      const body = (await res.json()) as { bills: { amountSats: number; sparkInvoice: string }[] };
      expect(body.bills.map((bill) => bill.amountSats)).toEqual([21, 21]);
      expect(body.bills.every((bill) => bill.sparkInvoice.startsWith('spark1'))).toBe(true);
    });
  });

  it('caps one call at 60 bills and leaves the rest for the next call', async () => {
    await withNip57(async () => {
      const { app, messages } = await loanSetup({
        termDays: 65,
        fundedAt: new Date(Date.UTC(2026, 10, 2, 12)),
        givers: [{ id: WALLET_GIVER, sats: 65, wallet: true }],
      });
      const first = (await (await post(app, `/messages/${CREDIT}/repayment/due`)).json()) as {
        bills: { dayIndex: number; amountSats: number }[];
      };
      expect(first.bills).toHaveLength(REPAYMENT_BILLS_MAX);
      expect(first.bills[0]?.dayIndex).toBe(0);
      expect(first.bills[59]?.dayIndex).toBe(59);
      for (const bill of first.bills) {
        await messages.markRepaymentPaid({
          messageId: CREDIT,
          dayIndex: bill.dayIndex,
          recipientAccountId: WALLET_GIVER,
          dueSats: bill.amountSats,
          paidAt: new Date(MONDAY),
        });
      }
      const rest = (await (await post(app, `/messages/${CREDIT}/repayment/due`)).json()) as {
        bills: { dayIndex: number }[];
      };
      expect(rest.bills.map((bill) => bill.dayIndex)).toEqual([60, 61, 62, 63, 64]);
    });
  });

  it('skips payable shares past the cap before looking anything up', async () => {
    await withNip57(async () => {
      const lookups: number[] = [];
      for (const termDays of [REPAYMENT_BILLS_MAX, REPAYMENT_BILLS_MAX + 5]) {
        const { app, auth } = await loanSetup({
          termDays,
          fundedAt: new Date(Date.UTC(2026, 10, 2, 12)),
          givers: [{ id: WALLET_GIVER, sats: termDays, wallet: true }],
        });
        const getAccount = vi.spyOn(auth, 'getAccount');
        const res = await post(app, `/messages/${CREDIT}/repayment/due`);
        expect(((await res.json()) as { bills: unknown[] }).bills).toHaveLength(
          REPAYMENT_BILLS_MAX,
        );
        lookups.push(getAccount.mock.calls.length);
      }
      expect(lookups[1]).toBe(lookups[0]);
    });
  });

  it('prices fiat bills at the current rate and refuses them without one', async () => {
    await withNip57(async () => {
      const priced = await loanSetup({ goalCurrency: 'USD', rate: true });
      const body = (await (await post(priced.app, `/messages/${CREDIT}/repayment/due`)).json()) as {
        bills: { amount: string; amountSats: number }[];
        waiting: { amount: string; amountSats: number }[];
      };
      expect(body.bills[0]).toMatchObject({ amount: '1.50', amountSats: 1500 });
      expect(body.waiting[0]).toMatchObject({ amount: '2.50', amountSats: 2500 });
      const unpriced = await loanSetup({ goalCurrency: 'USD' });
      const res = await post(unpriced.app, `/messages/${CREDIT}/repayment/due`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Ask amount is unavailable' });
      const noAmount = await loanSetup({ goalCurrency: 'USD', goalAmount: null });
      const missing = await post(noAmount.app, `/messages/${CREDIT}/repayment/due`);
      expect(missing.status).toBe(503);
      expect(await missing.json()).toEqual({ error: 'Ask amount is unavailable' });
    });
  });

  it('keeps the guards of the single pay route', async () => {
    const { app } = await loanSetup();
    expect(
      (await app.request(`/messages/${CREDIT}/repayment/due`, { method: 'POST' })).status,
    ).toBe(401);
    expect((await post(app, `/messages/${SECOND_CREDIT}/repayment/due`)).status).toBe(404);
    const rules = await loanSetup({ rules: false });
    const refused = await post(rules.app, `/messages/${CREDIT}/repayment/due`);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'missing_requirements' });
    const open = await loanSetup({ fundedAt: null });
    expect((await post(open.app, `/messages/${CREDIT}/repayment/due`)).status).toBe(404);
    const today = await loanSetup({ now: Date.UTC(2027, 1, 27, 20) });
    const nothing = await post(today.app, `/messages/${CREDIT}/repayment/due`);
    expect(nothing.status).toBe(200);
    expect(await nothing.json()).toEqual({ bills: [], waiting: [] });
    const unsigned = await loanSetup({ eventId: null });
    const notYet = await post(unsigned.app, `/messages/${CREDIT}/repayment/due`);
    expect(notYet.status).toBe(400);
    expect(await notYet.json()).toEqual({ error: 'This message cannot be paid yet' });
    const limited = await loanSetup({
      limiter: new InvoiceRateLimiter({ burstCap: 0, hourCap: 0 }),
    });
    const tooMany = await post(limited.app, `/messages/${CREDIT}/repayment/due`);
    expect(tooMany.status).toBe(429);
    expect(tooMany.headers.get('Retry-After')).toBe('10');
    expect(await tooMany.json()).toEqual({ error: 'Too many payments' });
    const single = await post(limited.app, `/messages/${CREDIT}/repayment`);
    expect(single.status).toBe(429);
    expect(single.headers.get('Retry-After')).toBe('10');
  });

  it('checks the wallet again when billing a share that was payable a moment ago', async () => {
    for (const [path, gone] of [
      [`/messages/${CREDIT}/repayment`, false],
      [`/messages/${CREDIT}/repayment/due`, false],
      [`/messages/${CREDIT}/repayment`, true],
    ] as const) {
      const { app, auth } = await loanSetup({
        givers: [{ id: WALLET_GIVER, sats: 300, wallet: true }],
        now: Date.UTC(2027, 1, 28, 12),
      });
      const getAccount = auth.getAccount.bind(auth);
      let reads = 0;
      vi.spyOn(auth, 'getAccount').mockImplementation(async (id) => {
        const account = await getAccount(id);
        if (id !== WALLET_GIVER || account === undefined) {
          return account;
        }
        reads += 1;
        // The first read decides the plan; the wallet or the account is gone at billing.
        if (reads === 1) {
          return account;
        }
        return gone ? undefined : { ...account, sparkPubkeyVerifiedAt: null };
      });
      const res = await post(app, path);
      const body = (await res.json()) as Record<string, unknown>;
      if (path.endsWith('/due')) {
        expect(res.status).toBe(200);
        expect(body).toMatchObject({ bills: [], waiting: [{ recipientAccountId: WALLET_GIVER }] });
      } else {
        expect(res.status).toBe(400);
        expect(body).toEqual({ error: 'A giver has no Lightning address', code: 'cannot_receive' });
      }
    }
  });

  it('moves a share whose wallet refuses the zap to waiting and asks that wallet once', async () => {
    const { app, messages, fetched } = await loanSetup({ allowsNostr: false });
    const res = await post(app, `/messages/${CREDIT}/repayment/due`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bills: unknown[];
      waiting: { dayIndex: number; recipientAccountId: string }[];
    };
    expect(body.bills).toEqual([]);
    expect(body.waiting.map((line) => [line.dayIndex, line.recipientAccountId])).toEqual([
      [0, NO_WALLET],
      [0, WALLET_GIVER],
      [1, NO_WALLET],
      [1, WALLET_GIVER],
    ]);
    expect(fetched.filter((url) => url.includes('/.well-known/lnurlp/'))).toHaveLength(1);
    expect(await messages.listInvoiceAttempts(5)).toEqual([]);
  });

  it('lists the member loans with what is due now', async () => {
    const { app, messages } = await loanSetup();
    await messages.create({
      id: SECOND_CREDIT,
      accountId: AUTHOR,
      name: 'Ada',
      text: 'second loan',
      createdAt: new Date(Date.UTC(2027, 1, 26)),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ff'.repeat(32),
      sats: 0,
      goalSats: 1000,
      goalRepayable: true,
      goalTermDays: 10,
      goalFundedAt: null,
    });
    await messages.create({
      id: '77777777-7777-4777-8777-777777777777',
      accountId: AUTHOR,
      name: 'Ada',
      text: 'a gift ask',
      createdAt: new Date(Date.UTC(2027, 1, 27)),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      goalSats: 1000,
    });
    await messages.create({
      id: '88888888-8888-4888-8888-888888888888',
      accountId: AUTHOR,
      name: 'Ada',
      text: 'a hidden loan',
      createdAt: new Date(Date.UTC(2027, 1, 28)),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      goalSats: 1000,
      goalRepayable: true,
      goalTermDays: 10,
    });
    await messages.markDeleted('88888888-8888-4888-8888-888888888888', new Date(MONDAY), AUTHOR);
    await messages.create({
      id: '99999999-9999-4999-8999-999999999999',
      accountId: AUTHOR,
      name: 'Ada',
      text: 'a reply',
      createdAt: new Date(Date.UTC(2027, 1, 28)),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: CREDIT,
    });
    await messages.markRepaymentPaid({
      messageId: CREDIT,
      dayIndex: 0,
      recipientAccountId: WALLET_GIVER,
      dueSats: 150,
      paidAt: new Date(MONDAY),
    });
    await messages.recordZapReceipt('r-anon-second', SECOND_CREDIT, 7, null);
    expect((await app.request('/me/loans')).status).toBe(401);
    const res = await loans(app);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sundayRest: boolean; loans: Record<string, unknown>[] };
    expect(body.sundayRest).toBe(false);
    expect(body.loans.map((loan) => loan['messageId'])).toEqual([SECOND_CREDIT, CREDIT]);
    expect(body.loans[0]).toMatchObject({
      text: 'second loan',
      goalSats: 1000,
      sats: 7,
      goalCurrency: 'BTC',
      goalAmount: '1000',
      termDays: 10,
      fundedAt: null,
      daysDue: 0,
      daysPaid: 0,
      repaidSats: 0,
      totalSats: 0,
      due: {
        payableSats: 0,
        payableAmount: null,
        payablePeople: 0,
        waitingSats: 0,
        waitingAmount: null,
        waitingPeople: 0,
        waitingShares: 0,
        behindDays: 0,
        lastPayment: false,
      },
      next: null,
    });
    const stored = await messages.getById(CREDIT);
    expect(body.loans[1]).toEqual({
      messageId: CREDIT,
      text: 'x'.repeat(160),
      createdAt: '2027-02-21T00:00:00.000Z',
      goalSats: 800,
      sats: 800,
      goalCurrency: 'BTC',
      goalAmount: '800',
      goalAmountUsd: null,
      goalAmountChf: null,
      goalAmountEur: null,
      goalAmountPhp: null,
      amountUsd: stored?.amountUsd ?? null,
      amountChf: stored?.amountChf ?? null,
      amountEur: stored?.amountEur ?? null,
      amountPhp: stored?.amountPhp ?? null,
      termDays: 2,
      fundedAt: '2027-02-27T12:00:00.000Z',
      daysDue: 2,
      daysPaid: 1,
      repaidSats: 150,
      totalSats: 800,
      due: {
        payableSats: 150,
        payableAmount: null,
        payablePeople: 1,
        waitingSats: 500,
        waitingAmount: null,
        waitingPeople: 1,
        waitingShares: 2,
        // Day 0 is short only of the share that waits for a giver without a wallet.
        behindDays: 0,
        lastPayment: false,
      },
      next: null,
    });
  });

  it('shows the next day, the last payment, and drops a repaid loan', async () => {
    const both = [
      { id: WALLET_GIVER, sats: 300, wallet: true },
      { id: NO_WALLET, sats: 500, wallet: true },
    ];
    const { app, messages, clock } = await loanSetup({
      givers: both,
      fundedAt: new Date(Date.UTC(2027, 1, 28, 12)),
    });
    const first = ((await (await loans(app)).json()) as { loans: Record<string, unknown>[] })
      .loans[0];
    expect(first).toMatchObject({
      daysDue: 1,
      due: { payableSats: 400, payablePeople: 2, behindDays: 0, lastPayment: false },
      next: { dueOn: '2027-03-02', sats: 400, amount: null },
    });
    for (const giver of [
      { id: NO_WALLET, sats: 250 },
      { id: WALLET_GIVER, sats: 150 },
    ]) {
      await messages.markRepaymentPaid({
        messageId: CREDIT,
        dayIndex: 0,
        recipientAccountId: giver.id,
        dueSats: giver.sats,
        paidAt: new Date(MONDAY),
      });
    }
    clock.now = Date.UTC(2027, 2, 2, 12);
    const last = ((await (await loans(app)).json()) as { loans: Record<string, unknown>[] })
      .loans[0];
    expect(last).toMatchObject({
      daysDue: 2,
      daysPaid: 1,
      repaidSats: 400,
      totalSats: 800,
      due: { payableSats: 400, behindDays: 0, lastPayment: true },
      next: null,
    });
    for (const giver of [
      { id: NO_WALLET, sats: 250 },
      { id: WALLET_GIVER, sats: 150 },
    ]) {
      await messages.markRepaymentPaid({
        messageId: CREDIT,
        dayIndex: 1,
        recipientAccountId: giver.id,
        dueSats: giver.sats,
        paidAt: new Date(clock.now),
      });
    }
    expect(await (await loans(app)).json()).toEqual({
      sundayRest: false,
      loans: [],
      lenderWaiting: { shares: 0, loans: 0, sats: 0 },
    });
  });

  it('counts the days behind after the term has ended', async () => {
    const { app } = await loanSetup({ now: Date.UTC(2027, 2, 8, 12) });
    const loan = ((await (await loans(app)).json()) as { loans: Record<string, unknown>[] })
      .loans[0];
    expect(loan).toMatchObject({ daysDue: 2, due: { behindDays: 2 } });
  });

  it('gives fiat amounts and leaves sats null without a rate', async () => {
    const unpriced = await loanSetup({ goalCurrency: 'USD' });
    const loan = (
      (await (await loans(unpriced.app)).json()) as { loans: Record<string, unknown>[] }
    ).loans[0];
    expect(loan).toMatchObject({
      goalCurrency: 'USD',
      goalAmount: '8.00',
      totalSats: null,
      due: {
        payableSats: null,
        payableAmount: '3.00',
        waitingSats: null,
        waitingAmount: '5.00',
      },
      next: null,
    });
    const priced = await loanSetup({ goalCurrency: 'USD', rate: true, fundedAt: null });
    const open = ((await (await loans(priced.app)).json()) as { loans: Record<string, unknown>[] })
      .loans[0];
    expect(open).toMatchObject({
      totalSats: 8000,
      due: { payableSats: 0, payableAmount: '0.00', waitingAmount: '0.00' },
    });
  });

  it('mirrors Sunday rest and answers 503 when a loan cannot be computed', async () => {
    const sunday = await loanSetup({ now: SUNDAY });
    const rest = (await (await loans(sunday.app, { 'Time-Zone': 'UTC' })).json()) as {
      sundayRest: boolean;
    };
    expect(rest.sundayRest).toBe(true);
    for (const fundedAt of [undefined, null]) {
      const broken = await loanSetup({
        goalCurrency: 'USD',
        goalAmount: null,
        ...(fundedAt === null ? { fundedAt } : {}),
      });
      const res = await loans(broken.app);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Ask amount is unavailable' });
    }
    const failing = await loanSetup();
    vi.spyOn(failing.messages, 'listAuthoredMessages').mockRejectedValue(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const res = await loans(failing.app);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
      expect(String(warn.mock.calls[0]?.[0])).toContain('me.loans.failed');
    } finally {
      warn.mockRestore();
    }
  });

  function lenderInvoice(
    id: string,
    messageId: string,
    payerAccountId: string,
    description: string | null = null,
  ): MessageInvoiceAttempt {
    return {
      id,
      createdAt: new Date(Date.UTC(2027, 1, 22)),
      messageId,
      payerAccountId,
      authorAccountId: AUTHOR,
      amountSats: 500,
      lightningAddress: 'ada@example.test',
      zapRequest: { kind: 9734 },
      result: 'ok',
      httpStatus: 200,
      pr: BOLT11,
      paymentHash: null,
      description,
      descriptionHash: null,
      isNip57Invoice: true,
      lnurlResponse: null,
    };
  }

  async function markPaid(
    messages: InMemoryMessageStore,
    accountId: string,
    days: readonly number[],
    dueSats: number,
  ): Promise<void> {
    for (const dayIndex of days) {
      await messages.markRepaymentPaid({
        messageId: CREDIT,
        dayIndex,
        recipientAccountId: accountId,
        dueSats,
        paidAt: new Date(MONDAY),
      });
    }
  }

  interface Ledger {
    daysDue: number;
    daysPaid: number;
    waitingShares: number;
    repayments: { dayIndex: number; accountId: string; status: string; waiting: boolean }[];
    next: { dayIndex: number; recipientAccountId: string } | null;
  }

  it('keeps a share that waits for a giver without a wallet out of due and behind', async () => {
    const { app, messages } = await loanSetup({ now: Date.UTC(2027, 2, 2, 12), termDays: 4 });
    await markPaid(messages, WALLET_GIVER, [0, 1, 2], 75);
    const ledger = (await (await app.request(`/messages/${CREDIT}/repayment`)).json()) as Ledger;
    expect(ledger.daysDue).toBe(3);
    expect(ledger.daysPaid).toBe(3);
    expect(ledger.waitingShares).toBe(3);
    expect(
      ledger.repayments.map((line) => [line.dayIndex, line.accountId, line.status, line.waiting]),
    ).toEqual([
      [0, NO_WALLET, 'due', true],
      [0, WALLET_GIVER, 'paid', false],
      [1, NO_WALLET, 'due', true],
      [1, WALLET_GIVER, 'paid', false],
      [2, NO_WALLET, 'due', true],
      [2, WALLET_GIVER, 'paid', false],
      [3, NO_WALLET, 'scheduled', false],
      [3, WALLET_GIVER, 'scheduled', false],
    ]);
    expect(ledger.next).toBeNull();
    const loan = ((await (await loans(app)).json()) as { loans: Record<string, unknown>[] })
      .loans[0];
    expect(loan).toMatchObject({
      daysDue: 3,
      daysPaid: 3,
      due: { payableSats: 0, waitingSats: 375, waitingShares: 3, behindDays: 0 },
    });
  });

  it('makes a waiting share payable once the wallet is verified, without days behind before it', async () => {
    const { app, auth, messages, clock } = await loanSetup({ termDays: 5 });
    await markPaid(messages, WALLET_GIVER, [0, 1, 2, 3], 60);
    const key = `02${'7'.repeat(64)}`;
    await auth.claimSparkPubkey(NO_WALLET, key);
    // Verified on day 1 (2027-03-01): day 0 never counts as behind, day 1 onwards does.
    expect(await auth.markSparkPubkeyVerified(NO_WALLET, key, 'giver1', clock.now)).toBe(true);
    const sameDay = (await (await app.request(`/messages/${CREDIT}/repayment`)).json()) as Ledger;
    expect(sameDay).toMatchObject({ daysDue: 2, daysPaid: 1, waitingShares: 0 });
    expect(sameDay.next).toMatchObject({ dayIndex: 0, recipientAccountId: NO_WALLET });
    expect(sameDay.repayments.every((line) => !line.waiting)).toBe(true);
    clock.now = Date.UTC(2027, 2, 3, 12);
    const later = (await (await app.request(`/messages/${CREDIT}/repayment`)).json()) as Ledger;
    expect(later).toMatchObject({ daysDue: 4, daysPaid: 1, waitingShares: 0 });
    const loan = ((await (await loans(app)).json()) as { loans: Record<string, unknown>[] })
      .loans[0];
    expect(loan).toMatchObject({
      daysDue: 4,
      daysPaid: 1,
      due: { payableSats: 400, payablePeople: 1, waitingShares: 0, behindDays: 2 },
    });
  });

  it('keeps the due figures of givers who all had a wallet before the start', async () => {
    const { app } = await loanSetup({
      givers: [
        { id: WALLET_GIVER, sats: 300, wallet: true },
        { id: NO_WALLET, sats: 500, wallet: true },
      ],
      now: Date.UTC(2027, 2, 3, 12),
      termDays: 5,
    });
    const ledger = (await (await app.request(`/messages/${CREDIT}/repayment`)).json()) as Ledger;
    expect(ledger).toMatchObject({ daysDue: 4, daysPaid: 0, waitingShares: 0 });
    expect(ledger.repayments.every((line) => !line.waiting)).toBe(true);
    const loan = ((await (await loans(app)).json()) as { loans: Record<string, unknown>[] })
      .loans[0];
    expect(loan).toMatchObject({
      daysDue: 4,
      daysPaid: 0,
      due: { payableSats: 640, waitingShares: 0, behindDays: 3 },
    });
  });

  it('tells a lender without a wallet how many repayments wait for them', async () => {
    const { app, messages, auth } = await loanSetup({ termDays: 4 });
    await auth.createSession({ token: NO_WALLET, accountId: NO_WALLET, createdAt: MONDAY });
    await auth.createSession({ token: WALLET_GIVER, accountId: WALLET_GIVER, createdAt: MONDAY });
    const unfunded = '12121212-1212-4212-8212-121212121212';
    const hidden = '13131313-1313-4313-8313-131313131313';
    const gift = '14141414-1414-4414-8414-141414141414';
    for (const [id, extra] of [
      [unfunded, { goalRepayable: true, goalTermDays: 4 }],
      [hidden, { goalRepayable: true, goalTermDays: 4, goalFundedAt: new Date(MONDAY) }],
      [gift, {}],
    ] as const) {
      await messages.create({
        id,
        accountId: AUTHOR,
        name: 'Ada',
        text: 'other note',
        createdAt: new Date(Date.UTC(2027, 1, 22)),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        goalSats: 1000,
        ...extra,
      });
    }
    await messages.markDeleted(hidden, new Date(MONDAY), AUTHOR);
    for (const invoice of [
      lenderInvoice('inv-credit', CREDIT, NO_WALLET),
      lenderInvoice('inv-credit-again', CREDIT, NO_WALLET),
      lenderInvoice('inv-repay', SECOND_CREDIT, NO_WALLET, `repay:0:${NO_WALLET}`),
      lenderInvoice('inv-unfunded', unfunded, NO_WALLET),
      lenderInvoice('inv-hidden', hidden, NO_WALLET),
      lenderInvoice('inv-gift', gift, NO_WALLET),
      lenderInvoice('inv-unknown', '15151515-1515-4515-8515-151515151515', NO_WALLET),
      lenderInvoice('inv-wallet', CREDIT, WALLET_GIVER),
    ]) {
      await messages.recordInvoiceAttempt(invoice);
    }
    const lender = (token: string): Promise<Response> =>
      Promise.resolve(app.request('/me/loans', { headers: { authorization: `Bearer ${token}` } }));
    expect(await (await lender(NO_WALLET)).json()).toEqual({
      sundayRest: false,
      loans: [],
      lenderWaiting: { shares: 2, loans: 1, sats: 250 },
    });
    await markPaid(messages, NO_WALLET, [0], 125);
    expect(
      ((await (await lender(NO_WALLET)).json()) as Record<string, unknown>)['lenderWaiting'],
    ).toEqual({
      shares: 1,
      loans: 1,
      sats: 125,
    });
    await markPaid(messages, NO_WALLET, [1], 125);
    expect(
      ((await (await lender(NO_WALLET)).json()) as Record<string, unknown>)['lenderWaiting'],
    ).toEqual({
      shares: 0,
      loans: 0,
      sats: 0,
    });
    const listed = vi.spyOn(messages, 'listInvoiceAttemptsForPayer');
    expect(
      ((await (await lender(WALLET_GIVER)).json()) as Record<string, unknown>)['lenderWaiting'],
    ).toEqual({
      shares: 0,
      loans: 0,
      sats: 0,
    });
    expect(listed).not.toHaveBeenCalled();
  });

  it('leaves the lender sum null without a rate and answers 503 when a lent loan cannot be computed', async () => {
    const fiat = await loanSetup({ goalCurrency: 'USD', termDays: 4 });
    await fiat.auth.createSession({ token: NO_WALLET, accountId: NO_WALLET, createdAt: MONDAY });
    await fiat.messages.recordInvoiceAttempt(lenderInvoice('inv-fiat', CREDIT, NO_WALLET));
    const request = (app: Hono): Promise<Response> =>
      Promise.resolve(
        app.request('/me/loans', { headers: { authorization: `Bearer ${NO_WALLET}` } }),
      );
    const unpriced = await request(fiat.app);
    expect(((await unpriced.json()) as Record<string, unknown>)['lenderWaiting']).toEqual({
      shares: 2,
      loans: 1,
      sats: null,
    });
    const broken = await loanSetup({ goalCurrency: 'USD', goalAmount: null, termDays: 4 });
    await broken.auth.createSession({ token: NO_WALLET, accountId: NO_WALLET, createdAt: MONDAY });
    await broken.messages.recordInvoiceAttempt(lenderInvoice('inv-broken', CREDIT, NO_WALLET));
    const res = await request(broken.app);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Ask amount is unavailable' });
  });

  it('leaves out a loan the lender only tried to give to', async () => {
    const { app, messages, auth } = await loanSetup({ termDays: 4 });
    await auth.createSession({ token: NO_WALLET, accountId: NO_WALLET, createdAt: MONDAY });
    await messages.create({
      id: SECOND_CREDIT,
      accountId: AUTHOR,
      name: 'Ada',
      text: 'other loan',
      createdAt: new Date(Date.UTC(2027, 1, 22)),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      goalSats: 1000,
      goalRepayable: true,
      goalTermDays: 4,
      goalFundedAt: new Date(Date.UTC(2027, 1, 27, 12)),
      goalCurrency: 'USD',
      goalAmount: null,
    });
    await messages.recordInvoiceAttempt(lenderInvoice('inv-credit', CREDIT, NO_WALLET));
    await messages.recordInvoiceAttempt({
      ...lenderInvoice('inv-tried', SECOND_CREDIT, NO_WALLET),
      result: 'unreachable',
    });
    const res = await app.request('/me/loans', {
      headers: { authorization: `Bearer ${NO_WALLET}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>)['lenderWaiting']).toEqual({
      shares: 2,
      loans: 1,
      sats: 250,
    });
  });

  it('answers 503 Ask amount is unavailable when the rate cannot be read', async () => {
    const rates = (): Promise<GoalRateDay | null> => Promise.reject(new Error('rate down'));
    for (const fundedAt of [undefined, null]) {
      const failing = await loanSetup({
        goalCurrency: 'USD',
        rates,
        termDays: 4,
        ...(fundedAt === null ? { fundedAt } : {}),
      });
      const res = await loans(failing.app);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Ask amount is unavailable' });
    }
    const lent = await loanSetup({ goalCurrency: 'USD', rates, termDays: 4 });
    await lent.auth.createSession({ token: NO_WALLET, accountId: NO_WALLET, createdAt: MONDAY });
    await lent.messages.recordInvoiceAttempt(lenderInvoice('inv-fiat', CREDIT, NO_WALLET));
    const res = await lent.app.request('/me/loans', {
      headers: { authorization: `Bearer ${NO_WALLET}` },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Ask amount is unavailable' });
  });
});

describe('DELETE /messages/:id on a credit', () => {
  const OTHER = '66666666-6666-4666-8666-666666666666';

  async function staffCredit(
    options?: Parameters<typeof readyCredit>[0],
  ): Promise<Awaited<ReturnType<typeof readyCredit>>> {
    const ready = await readyCredit(options);
    const account = await ready.auth.getAccount('acc');
    if (account === undefined) {
      throw new Error('expected account');
    }
    await ready.auth.updateAccount({ ...account, role: 'founder' });
    return ready;
  }

  async function del(app: Hono, id: string): Promise<Response> {
    return app.request(`/messages/${id}`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer acc' },
    });
  }

  it('refuses a funded credit with an unpaid share, even for the founder', async () => {
    const { app, messages } = await staffCredit();
    const res = await del(app, CREDIT);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'An open credit cannot be deleted' });
    expect((await messages.getById(CREDIT))?.deletedAt).toBeNull();
  });

  it('refuses a repaid credit that still holds sats without a giver account', async () => {
    const { app, messages } = await staffCredit();
    await messages.markRepaymentPaid({
      messageId: CREDIT,
      dayIndex: 0,
      recipientAccountId: GIVER,
      dueSats: 21,
      paidAt: new Date(now()),
    });
    await messages.recordZapReceipt('r-later', CREDIT, 5, null);
    expect((await del(app, CREDIT)).status).toBe(409);
  });

  it('refuses a repaid credit when a receipt is assigned to a giver between the reads', async () => {
    const { app, messages } = await staffCredit();
    await messages.markRepaymentPaid({
      messageId: CREDIT,
      dayIndex: 0,
      recipientAccountId: GIVER,
      dueSats: 21,
      paidAt: new Date(now()),
    });
    await messages.recordZapReceipt('r-late', CREDIT, 5, null);
    let assigned = false;
    const assignAfterFirstRead = async <T>(read: Promise<T>): Promise<T> => {
      const value = await read;
      if (!assigned) {
        assigned = true;
        await messages.updateZapReceiptGift('r-late', { payerAccountId: 'acc' });
      }
      return value;
    };
    const listCreditPayers = messages.listCreditPayers.bind(messages);
    const sumUnassignedCreditSats = messages.sumUnassignedCreditSats.bind(messages);
    messages.listCreditPayers = (id) => assignAfterFirstRead(listCreditPayers(id));
    messages.sumUnassignedCreditSats = (id) => assignAfterFirstRead(sumUnassignedCreditSats(id));
    expect((await del(app, CREDIT)).status).toBe(409);
    expect(assigned).toBe(true);
  });

  it('refuses a funded credit whose plan has no payable share', async () => {
    const { app } = await staffCredit({ goalCurrency: 'USD', goalAmount: '0.00' });
    expect((await del(app, CREDIT)).status).toBe(409);
  });

  it('hides a credit once every share is repaid', async () => {
    const { app, messages } = await staffCredit();
    await messages.markRepaymentPaid({
      messageId: CREDIT,
      dayIndex: 0,
      recipientAccountId: GIVER,
      dueSats: 21,
      paidAt: new Date(now()),
    });
    expect((await del(app, CREDIT)).status).toBe(204);
    expect((await messages.getById(CREDIT))?.deletedAt).toBeInstanceOf(Date);
  });

  it('keeps returning 204 for an open credit that is already hidden', async () => {
    const { app, messages } = await staffCredit();
    const at = new Date(Date.UTC(2026, 8, 27));
    expect(await messages.markDeleted(CREDIT, at, 'acc')).toBe(true);
    expect((await del(app, CREDIT)).status).toBe(204);
    expect((await messages.getById(CREDIT))?.deletedAt?.getTime()).toBe(at.getTime());
  });

  it('refuses a credit that received sats but never filled', async () => {
    const { app } = await staffCredit({ fundedAt: null });
    expect((await del(app, CREDIT)).status).toBe(409);
  });

  it('refuses a funded credit without a term', async () => {
    const { app } = await staffCredit({ termDays: null });
    expect((await del(app, CREDIT)).status).toBe(409);
  });

  it('refuses a funded credit whose debt cannot be priced', async () => {
    const { app } = await staffCredit({ goalCurrency: 'USD', goalAmount: null });
    expect((await del(app, CREDIT)).status).toBe(409);
  });

  it('refuses a funded credit paid only by zaps without an account', async () => {
    const { app, messages } = await staffCredit();
    await messages.create({
      id: OTHER,
      accountId: 'acc',
      name: 'Ada',
      text: 'external only',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      sats: 21,
      goalSats: 21,
      goalRepayable: true,
      goalTermDays: 1,
      goalFundedAt: new Date(Date.UTC(2026, 8, 26, 12)),
    });
    await messages.recordZapReceipt('r-ext', OTHER, 21, null);
    expect((await del(app, OTHER)).status).toBe(409);
  });

  async function emptyCredit(messages: InMemoryMessageStore): Promise<void> {
    await messages.create({
      id: OTHER,
      accountId: 'acc',
      name: 'Ada',
      text: 'empty ask',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      sats: 0,
      goalSats: 1000,
      goalRepayable: true,
      goalTermDays: 10,
    });
  }

  it('refuses when sats arrive between the check and the hide', async () => {
    const { app, messages } = await staffCredit();
    await emptyCredit(messages);
    const markDeleted = messages.markDeleted.bind(messages);
    messages.markDeleted = async (id, at, by, expectedSats) => {
      await messages.addSats(id, 5, null);
      return markDeleted(id, at, by, expectedSats);
    };
    const res = await del(app, OTHER);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'An open credit cannot be deleted' });
    expect((await messages.getById(OTHER))?.deletedAt).toBeNull();
  });

  it('returns 204 when another hide lands between the check and the hide', async () => {
    const { app, messages } = await staffCredit();
    await emptyCredit(messages);
    const markDeleted = messages.markDeleted.bind(messages);
    messages.markDeleted = async (id, at, by, expectedSats) => {
      await markDeleted(id, new Date(1), 'other');
      return markDeleted(id, at, by, expectedSats);
    };
    expect((await del(app, OTHER)).status).toBe(204);
    expect((await messages.getById(OTHER))?.deletedBy).toBe('other');
  });

  it('returns 404 when the credit disappears between the check and the hide', async () => {
    const { app, messages } = await staffCredit();
    await emptyCredit(messages);
    const markDeleted = messages.markDeleted.bind(messages);
    messages.markDeleted = async (id, at, by, expectedSats) => {
      await messages.deleteById(id);
      return markDeleted(id, at, by, expectedSats);
    };
    expect((await del(app, OTHER)).status).toBe(404);
  });

  it('hides a credit that never received sats', async () => {
    const { app, messages } = await staffCredit();
    await messages.create({
      id: OTHER,
      accountId: 'acc',
      name: 'Ada',
      text: 'empty ask',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      sats: 0,
      goalSats: 1000,
      goalRepayable: true,
      goalTermDays: 10,
    });
    expect((await del(app, OTHER)).status).toBe(204);
  });
});
