import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import { ensureAccountNostrKey } from '@/lib/nostr/keys';
import { parseNostrKek } from '@/lib/nostr/kek';
import { InvoiceRateLimiter, PostRateLimiter } from '@/lib/nostr/rate-limit';
import { messagesRoutes } from '@/routes/messages';

const now = (): number => Date.UTC(2026, 8, 28, 12);
const CREDIT = '55555555-5555-4555-8555-555555555555';
const GIVER = '11111111-1111-4111-8111-111111111111';

async function readyCredit(options?: {
  rules?: boolean;
  eventId?: string | null;
  giverAddress?: string | null;
  giverKey?: boolean;
  kek?: boolean;
  fundedAt?: Date | null;
  termDays?: number | null;
  goalCurrency?: 'USD';
  goalAmount?: string | null;
  rate?: boolean;
  authorId?: string;
  giverAccount?: boolean;
  giverName?: string | null;
  giverUsername?: string | null;
  fetch?: boolean;
  pr?: string;
}): Promise<{
  app: Hono;
  messages: InMemoryMessageStore;
  auth: InMemoryAuthStore;
}> {
  const kek = parseNostrKek('11'.repeat(32));
  const authorId = options?.authorId ?? 'acc';
  const auth = new InMemoryAuthStore();
  await auth.createAccount({
    id: authorId,
    linkingKey: `02${'ab'.repeat(32)}`,
    role: 'verified',
    name: 'Ada',
    lightningAddress: 'ada@walletofsatoshi.com',
    lightningAddressVerified: true,
    forumLawsDismissed: false,
    location: null,
    viewKey: 'a'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: options?.rules === false ? null : now(),
    username: 'ada',
  });
  if (options?.giverAccount !== false) {
    await auth.createAccount({
      id: GIVER,
      linkingKey: `02${'cd'.repeat(32)}`,
      role: 'verified',
      name: options?.giverName === undefined ? 'Bea' : options.giverName,
      lightningAddress:
        options?.giverAddress === undefined ? 'bea@walletofsatoshi.com' : options.giverAddress,
      lightningAddressVerified: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: now(),
      username: options?.giverUsername === undefined ? 'bea' : options.giverUsername,
    });
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
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.includes('/.well-known/lnurlp/')) {
      return new Response(
        JSON.stringify({
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
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
              usd: '100000.00',
              chf: null,
              eur: null,
              php: null,
            }),
          }
        : {}),
      ...(options?.fetch === false ? {} : { fetchImpl }),
      postLimiter: new PostRateLimiter(),
      invoiceLimiter: new InvoiceRateLimiter(),
    }),
  );
  return { app, messages, auth };
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

  it('shows the due share and invoices the giver Wallet of Satoshi address', async () => {
    const bolt11 = await import('@/lib/bolt11');
    const nip57 = vi.spyOn(bolt11, 'isNip57Invoice').mockReturnValue(true);
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
      expect(await pay.json()).toEqual({ pr: 'lnbc21n1repay', amountSats: 21 });
      const attempt = (await messages.listInvoiceAttempts(5))[0];
      expect(attempt?.lightningAddress).toBe('bea@walletofsatoshi.com');
      expect(attempt?.description).toBe(`repay:0:${GIVER}`);
      const again = await app.request(`/messages/${CREDIT}/repayment`, {
        method: 'POST',
        headers: { authorization: 'Bearer acc' },
      });
      expect(again.status).toBe(429);
    } finally {
      nip57.mockRestore();
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
  });

  it('refuses a giver without a Lightning address or key', async () => {
    const missingAddress = await readyCredit({
      authorId: 'acc-noaddr',
      giverAddress: null,
    });
    const noAddress = await missingAddress.app.request(`/messages/${CREDIT}/repayment`, {
      method: 'POST',
      headers: { authorization: 'Bearer acc-noaddr' },
    });
    expect(noAddress.status).toBe(400);
    const missingKey = await readyCredit({ authorId: 'acc-nokey', giverKey: false });
    const noKey = await missingKey.app.request(`/messages/${CREDIT}/repayment`, {
      method: 'POST',
      headers: { authorization: 'Bearer acc-nokey' },
    });
    expect(noKey.status).toBe(400);
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
    const plain = await readyCredit({ authorId: 'acc-plain' });
    const plainRes = await plain.app.request(`/messages/${CREDIT}/repayment`, {
      method: 'POST',
      headers: { authorization: 'Bearer acc-plain' },
    });
    expect(plainRes.status).toBe(400);
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
      expect(await blankRes.json()).toEqual({ pr: 'lnbc21n1repay', amountSats: 21 });
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
});
