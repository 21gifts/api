import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import { ensureAccountNostrKey } from '@/lib/nostr/keys';
import { parseNostrKek } from '@/lib/nostr/kek';
import { InvoiceRateLimiter, PostRateLimiter } from '@/lib/nostr/rate-limit';
import { messagesRoutes } from '@/routes/messages';
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
      { accountId: GIVER, name: 'Bea', username: 'bea', givenSats: 21, givenAmount: null },
    ]);
    expect(body.repayments[0]).toMatchObject({
      dueOn: '2026-09-27',
      sats: 21,
      status: 'due',
      via: 'lightning',
      amount: null,
      name: 'Bea',
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
