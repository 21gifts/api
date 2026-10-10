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

const now = (): number => Date.UTC(2026, 8, 28, 12);
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
      options?.fundedAt === undefined ? new Date(Date.UTC(2026, 8, 26, 12)) : options.fundedAt,
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
      unassignedSats: number;
      givers: { name: string; givenSats: number }[];
      repayments: { dueOn: string; sats: number; status: string; via: string }[];
    };
    expect(body.currency).toBe('BTC');
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
      dueOn: '2026-09-27',
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
  /** Monday 2026-09-28 12:00 UTC: a credit funded 2026-09-26 has days 0 and 1 due. */
  const MONDAY = Date.UTC(2026, 8, 28, 12);
  const SUNDAY = Date.UTC(2026, 8, 27, 12);

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
  }): (input: string | URL | Request) => Promise<Response> {
    return async (input) => {
      const url = String(input);
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
  }> {
    const clock = { now: options?.now ?? MONDAY };
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
      createdAt: new Date(Date.UTC(2026, 8, 20)),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: options?.eventId === undefined ? 'ee'.repeat(32) : options.eventId,
      sats: 0,
      goalSats: options?.fundedAt === null ? total * 2 : total,
      goalRepayable: true,
      goalTermDays: options?.termDays ?? 2,
      goalFundedAt:
        options?.fundedAt === undefined ? new Date(Date.UTC(2026, 8, 26, 12)) : options.fundedAt,
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
      options?.rate === true
        ? async () => ({
            sats: 100_000_000,
            usd: '100000.00',
            chf: null,
            eur: null,
            php: null,
          })
        : async () => null;
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
    return { app, messages, auth, clock };
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

  it('leaves dueSats null on lines that are not due and on a fiat line without a rate', async () => {
    const early = await loanSetup({ now: Date.UTC(2026, 8, 26, 20) });
    const scheduled = (await (await early.app.request(`/messages/${CREDIT}/repayment`)).json()) as {
      repayments: { status: string; dueSats: number | null }[];
    };
    expect(scheduled.repayments.every((line) => line.status === 'scheduled')).toBe(true);
    expect(scheduled.repayments.every((line) => line.dueSats === null)).toBe(true);
    const fiat = await loanSetup({
      goalCurrency: 'USD',
      givers: [{ id: NO_WALLET, sats: 500, wallet: false }],
    });
    const res = await fiat.app.request(`/messages/${CREDIT}/repayment`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repayments: { status: string; amount: string; dueSats: number | null }[];
      next: unknown;
    };
    expect(body.repayments[0]).toMatchObject({ status: 'due', amount: '4.00', dueSats: null });
    expect(body.next).toBeNull();
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
        fundedAt: new Date(Date.UTC(2026, 5, 1, 12)),
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
    const today = await loanSetup({ now: Date.UTC(2026, 8, 26, 20) });
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
        now: Date.UTC(2026, 8, 27, 12),
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

  it('moves a share whose wallet refuses the zap to waiting', async () => {
    const { app, messages } = await loanSetup({ allowsNostr: false });
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
    expect(await messages.listInvoiceAttempts(5)).toEqual([]);
  });

  it('lists the member loans with what is due now', async () => {
    const { app, messages } = await loanSetup();
    await messages.create({
      id: SECOND_CREDIT,
      accountId: AUTHOR,
      name: 'Ada',
      text: 'second loan',
      createdAt: new Date(Date.UTC(2026, 8, 25)),
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
      createdAt: new Date(Date.UTC(2026, 8, 26)),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      goalSats: 1000,
    });
    await messages.create({
      id: '88888888-8888-4888-8888-888888888888',
      accountId: AUTHOR,
      name: 'Ada',
      text: 'a hidden loan',
      createdAt: new Date(Date.UTC(2026, 8, 27)),
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
      createdAt: new Date(Date.UTC(2026, 8, 27)),
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
    expect((await app.request('/me/loans')).status).toBe(401);
    const res = await loans(app);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sundayRest: boolean; loans: Record<string, unknown>[] };
    expect(body.sundayRest).toBe(false);
    expect(body.loans.map((loan) => loan['messageId'])).toEqual([SECOND_CREDIT, CREDIT]);
    expect(body.loans[0]).toMatchObject({
      text: 'second loan',
      goalSats: 1000,
      sats: 0,
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
        behindDays: 0,
        lastPayment: false,
      },
      next: null,
    });
    const stored = await messages.getById(CREDIT);
    expect(body.loans[1]).toEqual({
      messageId: CREDIT,
      text: 'x'.repeat(160),
      createdAt: '2026-09-20T00:00:00.000Z',
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
      fundedAt: '2026-09-26T12:00:00.000Z',
      daysDue: 2,
      daysPaid: 0,
      repaidSats: 150,
      totalSats: 800,
      due: {
        payableSats: 150,
        payableAmount: null,
        payablePeople: 1,
        waitingSats: 500,
        waitingAmount: null,
        waitingPeople: 1,
        behindDays: 1,
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
      fundedAt: new Date(Date.UTC(2026, 8, 27, 12)),
    });
    const first = ((await (await loans(app)).json()) as { loans: Record<string, unknown>[] })
      .loans[0];
    expect(first).toMatchObject({
      daysDue: 1,
      due: { payableSats: 400, payablePeople: 2, behindDays: 0, lastPayment: false },
      next: { dueOn: '2026-09-29', sats: 400, amount: null },
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
    clock.now = Date.UTC(2026, 8, 29, 12);
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
    expect(await (await loans(app)).json()).toEqual({ sundayRest: false, loans: [] });
  });

  it('counts the days behind after the term has ended', async () => {
    const { app } = await loanSetup({ now: Date.UTC(2026, 9, 5, 12) });
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
});
