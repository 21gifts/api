import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore, type Account } from '@/lib/auth/store';
import {
  InMemoryMessageStore,
  type MessageInvoiceAttempt,
  type ZapIngestRow,
} from '@/lib/message-store';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryNotificationStore } from '@/lib/notification-store';
import { InMemoryPushStore } from '@/lib/push-store';
import { InMemoryFundingStore } from '@/lib/funding-store';
import { InMemoryGiftStore } from '@/lib/gift-store';
import { InMemoryConversationStore } from '@/lib/conversation-store';
import { InMemoryTrustStore } from '@/lib/trust-store';
import type { WelcomeSweepSwitch } from '@/lib/welcome-media';
import { debugPaymentsRoutes } from '@/routes/debug-payments';
import { storeRecoveryShare } from '@/__tests__/helpers/recovery';
import { LNURL_SERVER } from '@/__tests__/helpers/wallet-lnurl';
import type { WalletTransferStore } from '@/lib/wallet-transfer-store';
import type { OperatorLogin } from '@/lib/operator-login';
import { seededOperatorLogin } from '@/__tests__/helpers/operator-key-token';
import type { DailyRosterStore } from '@/lib/daily-roster-store';
import type { FxSpotStore } from '@/lib/fx-spot-store';

const OP_KEYS = await seededOperatorLogin();
const OP_LOGIN = OP_KEYS.operatorLogin;
const READ_AUTH = `Bearer ${OP_KEYS.tokens.read}`;
const WRITE_AUTH = `Bearer ${OP_KEYS.tokens.write}`;
const ADMIN_AUTH = `Bearer ${OP_KEYS.tokens.admin}`;

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

function mount(
  store: InMemoryMessageStore,
  operatorLogin: OperatorLogin | undefined,
  extra: {
    spendPing?: {
      ping: (
        address: string,
        messageId: string,
        kind?: 'daily' | 'moderator' | 'welcome',
        grantStatus?: 'none' | 'pending' | 'trial' | 'admitted' | 'rejected',
      ) => Promise<void>;
      pingOnDay?: (
        address: string,
        messageId: string,
        day: string,
        grantStatus?: 'none' | 'pending' | 'trial' | 'admitted' | 'rejected',
        kind?: 'daily' | 'moderator',
      ) => Promise<
        { status: 'accepted' } | { status: 'skipped'; reason: string } | { status: 'failed' }
      >;
    };
    fundingStore?: InMemoryFundingStore;
    recoveryShareRequiredFrom?: string | null;
    auth?: InMemoryAuthStore;
    now?: () => number;
    giftStore?: InMemoryGiftStore;
    welcomeSweep?: WelcomeSweepSwitch;
    walletTransfers?: Pick<WalletTransferStore, 'hasShopPayment'>;
    rosterStore?: Pick<DailyRosterStore, 'get'>;
    fxSpotStore?: Pick<FxSpotStore, 'latest'>;
  } = {},
): Hono {
  return new Hono().route(
    '/debug',
    debugPaymentsRoutes({
      store,
      auth: extra.auth ?? new InMemoryAuthStore(),
      now: extra.now ?? (() => Date.parse('2026-09-18T12:00:00.000Z')),
      operatorLogin,
      ...(extra.spendPing === undefined ? {} : { spendPing: extra.spendPing }),
      ...(extra.fundingStore === undefined ? {} : { fundingStore: extra.fundingStore }),
      ...(extra.recoveryShareRequiredFrom === undefined
        ? {}
        : { recoveryShareRequiredFrom: extra.recoveryShareRequiredFrom }),
      conversationStore: new InMemoryConversationStore(),
      trustStore: new InMemoryTrustStore(),
      giftStore: extra.giftStore ?? new InMemoryGiftStore(),
      lnurlServer: LNURL_SERVER,
      welcomeSweep: extra.welcomeSweep ?? { enabled: false },
      ...(extra.walletTransfers === undefined ? {} : { walletTransfers: extra.walletTransfers }),
      ...(extra.rosterStore === undefined ? {} : { rosterStore: extra.rosterStore }),
      ...(extra.fxSpotStore === undefined ? {} : { fxSpotStore: extra.fxSpotStore }),
    }),
  );
}

/**
 * Create a verified account with the username `ada` and a verified wallet, so
 * it receives on `ada@example.test`.
 */
async function createReceiver(
  auth: InMemoryAuthStore,
  partial: Pick<Account, 'id' | 'role'> & Partial<Account>,
): Promise<void> {
  await auth.createAccount(account({ username: 'ada', walletRequired: true, ...partial }));
  const pubkey = `02${partial.id.replace(/-/g, '').padEnd(64, '0').slice(0, 64)}`;
  await auth.claimSparkPubkey(partial.id, pubkey);
  await auth.markSparkPubkeyVerified(partial.id, pubkey, 'ada', 1);
}

function account(partial: Pick<Account, 'id' | 'role'> & Partial<Account>): Account {
  return {
    linkingKey: null,
    name: partial.name ?? partial.id,
    forumLawsDismissed: false,
    location: null,
    viewKey: `${partial.id.replace(/-/g, '')}${'a'.repeat(64)}`.slice(0, 64),
    createdAt: 1,
    rulesAgreedAt: 1,
    ...partial,
  };
}

const SPEND_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const SPEND_PHOTO = { contentType: 'image/jpeg' as const, bytes: SPEND_JPEG };
const SPEND_NOW = (): number => Date.parse('2026-09-30T12:00:00.000Z');
const SPEND_CREATED_AT = new Date('2026-09-30T08:00:00.000Z');
const READ_HEADERS = { authorization: READ_AUTH };
const SPEND_HEADERS = {
  authorization: WRITE_AUTH,
  'content-type': 'application/json',
};

function spendPingMock(): {
  ping: ReturnType<typeof vi.fn>;
  pingOnDay: ReturnType<typeof vi.fn>;
} {
  return {
    ping: vi.fn(async () => undefined),
    pingOnDay: vi.fn(async () => ({ status: 'accepted' as const })),
  };
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

  it('returns 401 without a matching bearer on both paths', async () => {
    const app = mount(new InMemoryMessageStore(), OP_LOGIN);
    const invoices = await app.request('/debug/invoices');
    expect(invoices.status).toBe(401);
    expect(await invoices.json()).toEqual({ error: 'Unauthorized' });
    const ingests = await app.request('/debug/zap-ingests');
    expect(ingests.status).toBe(401);
    expect(await ingests.json()).toEqual({ error: 'Unauthorized' });
    const settle = await app.request('/debug/invoices/settle', { method: 'POST' });
    expect(settle.status).toBe(401);
    const unknown = await app.request('/debug/invoices', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(unknown.status).toBe(401);
  });

  it('returns 403 for a key token below the route level', async () => {
    const app = mount(new InMemoryMessageStore(), OP_LOGIN);
    const settle = await app.request('/debug/invoices/settle', {
      method: 'POST',
      headers: { authorization: WRITE_AUTH, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(settle.status).toBe(403);
    expect(await settle.json()).toEqual({ error: 'Forbidden' });
    const spend = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: { authorization: READ_AUTH, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(spend.status).toBe(403);
    const sweep = await app.request('/debug/welcome-sweep', {
      method: 'PUT',
      headers: { authorization: READ_AUTH, 'content-type': 'application/json' },
      body: '{"enabled":true}',
    });
    expect(sweep.status).toBe(403);
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
    const app = mount(store, OP_LOGIN);
    const res = await app.request('/debug/invoices', {
      headers: { authorization: READ_AUTH },
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
    const app = mount(store, OP_LOGIN);
    const res = await app.request('/debug/zap-ingests', {
      headers: { authorization: READ_AUTH },
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
    const app = mount(new InMemoryMessageStore(), OP_LOGIN);
    const headers = { authorization: ADMIN_AUTH, 'content-type': 'application/json' };
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
    const headers = { authorization: ADMIN_AUTH, 'content-type': 'application/json' };
    const emptyApp = mount(new InMemoryMessageStore(), OP_LOGIN);
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
    const conversation = await mount(conversationStore, OP_LOGIN).request(
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
    const missingMessage = await mount(missingMessageStore, OP_LOGIN).request(
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
    const app = mount(store, OP_LOGIN, { fundingStore: new InMemoryFundingStore() });
    const request = {
      method: 'POST',
      headers: { authorization: ADMIN_AUTH, 'content-type': 'application/json' },
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

  it('does not spendPing on an ineligible debug settle', async () => {
    const store = new InMemoryMessageStore();
    const paymentHash = 'ab'.repeat(32);
    await seedSettleInvoice(store, paymentHash);
    const spendPing = { ping: vi.fn(async () => undefined) };
    const app = mount(store, OP_LOGIN, { spendPing });
    const settled = await app.request('/debug/invoices/settle', {
      method: 'POST',
      headers: { authorization: ADMIN_AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ paymentHash, note: 'Wallet evidence' }),
    });
    expect(settled.status).toBe(200);
    expect(spendPing.ping).not.toHaveBeenCalled();
  });

  it('retries atomically after a failed ingest write', async () => {
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
    const app = mount(store, OP_LOGIN);
    const request = {
      method: 'POST',
      headers: { authorization: ADMIN_AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ paymentHash, note: 'Wallet evidence' }),
    };

    const failed = await app.request('/debug/invoices/settle', request);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: 'Messages are unavailable' });
    expect((await store.getById('settle-message'))?.sats).toBe(0);

    const resumed = await app.request('/debug/invoices/settle', request);
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({
      messageId: 'settle-message',
      amountSats: 210_000,
      resumed: false,
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
        operatorLogin: OP_LOGIN,
        pushStore: new InMemoryPushStore(),
        notificationStore: new InMemoryNotificationStore(),
        conversationStore: new InMemoryConversationStore(),
        trustStore: new InMemoryTrustStore(),
        giftStore: new InMemoryGiftStore(),
        welcomeSweep: { enabled: false },
      }),
    );
    const settled = await app.request('/debug/invoices/settle', {
      method: 'POST',
      headers: { authorization: ADMIN_AUTH, 'content-type': 'application/json' },
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
    const app = mount(new ThrowingStore(), OP_LOGIN);
    const res = await app.request('/debug/invoices/settle', {
      method: 'POST',
      headers: { authorization: ADMIN_AUTH, 'content-type': 'application/json' },
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
      postCountsByUtcDay: boom,
    } as unknown as InMemoryMessageStore;
    const app = mount(store, OP_LOGIN);
    const invoices = await app.request('/debug/invoices', {
      headers: { authorization: READ_AUTH },
    });
    expect(invoices.status).toBe(503);
    expect(await invoices.json()).toEqual({ error: 'Messages are unavailable' });
    const ingests = await app.request('/debug/zap-ingests', {
      headers: { authorization: READ_AUTH },
    });
    expect(ingests.status).toBe(503);
    expect(await ingests.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.invoices.list_failed')).toBe(true);
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.zap_ingests.list_failed')).toBe(
      true,
    );
  });

  it('replays today daily spend ping for a qualifying top-level photo post', async () => {
    const messageId = '11111111-1111-4111-8111-111111111111';
    const accountId = 'a1111111-1111-4111-8111-111111111111';
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await createReceiver(auth, {
      id: accountId,
      role: 'verified',
      name: 'Ada',
    });
    await store.create(
      {
        id: messageId,
        accountId,
        name: 'Ada',
        text: 'photo',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    const spendPing = spendPingMock();
    const app = mount(store, OP_LOGIN, { spendPing, auth, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(202);
    const json: unknown = await res.json();
    expect(json).toEqual({ messageId, status: 'accepted' });
    expect(JSON.stringify(json)).not.toContain('ada@example.test');
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(spendPing.pingOnDay).toHaveBeenCalledTimes(1);
    expect(spendPing.pingOnDay.mock.calls[0]).toEqual([
      'ada@example.test',
      messageId,
      '2026-09-30',
      'none',
    ]);
    const sent = parsedEvents(warn).find((e) => e['event'] === 'debug.spend_ping.sent');
    expect(sent?.['messageId']).toBe(messageId);
    expect(sent).not.toHaveProperty('address');
    expect(JSON.stringify(sent)).not.toContain('ada@example.test');
  });

  it('returns 503 for spend-ping when debug is not configured', async () => {
    const spendPing = spendPingMock();
    const app = mount(new InMemoryMessageStore(), undefined, { spendPing });
    const res = await app.request('/debug/spend-ping', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Debug is not configured' });
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(spendPing.pingOnDay).not.toHaveBeenCalled();
  });

  it('returns 401 for spend-ping without a bearer', async () => {
    const spendPing = spendPingMock();
    const app = mount(new InMemoryMessageStore(), OP_LOGIN, { spendPing });
    const res = await app.request('/debug/spend-ping', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(spendPing.pingOnDay).not.toHaveBeenCalled();
  });

  it('returns 503 when spend ping is not configured', async () => {
    const app = mount(new InMemoryMessageStore(), OP_LOGIN);
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId: '22222222-2222-4222-8222-222222222222' }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Spend ping is not configured' });
  });

  it('rejects malformed spend-ping bodies', async () => {
    const spendPing = spendPingMock();
    const app = mount(new InMemoryMessageStore(), OP_LOGIN, { spendPing });
    for (const body of ['{', '"x"', '[1]', '{"messageId":1}', '{"messageId":"not-a-uuid"}']) {
      const res = await app.request('/debug/spend-ping', {
        method: 'POST',
        headers: SPEND_HEADERS,
        body,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid body' });
    }
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(spendPing.pingOnDay).not.toHaveBeenCalled();
  });

  it('returns 404 when the spend-ping message is missing', async () => {
    const spendPing = spendPingMock();
    const app = mount(new InMemoryMessageStore(), OP_LOGIN, { spendPing });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId: '33333333-3333-4333-8333-333333333333' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(spendPing.pingOnDay).not.toHaveBeenCalled();
  });

  it('returns 409 when the spend-ping message is hidden', async () => {
    const messageId = '44444444-4444-4444-8444-444444444444';
    const store = new InMemoryMessageStore();
    await store.create(
      {
        id: messageId,
        accountId: 'hidden-author',
        name: 'Ada',
        text: 'photo',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    await store.markDeleted(messageId, new Date(), 'staff');
    const spendPing = spendPingMock();
    const app = mount(store, OP_LOGIN, { spendPing, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Message is hidden' });
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(spendPing.pingOnDay).not.toHaveBeenCalled();
  });

  it('returns 409 when the spend-ping target is a reply', async () => {
    const parentId = '55555555-5555-4555-8555-555555555555';
    const messageId = '66666666-6666-4666-8666-666666666666';
    const store = new InMemoryMessageStore();
    await store.create({
      id: parentId,
      accountId: 'reply-author',
      name: 'Ada',
      text: 'parent',
      createdAt: SPEND_CREATED_AT,
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await store.create(
      {
        id: messageId,
        accountId: 'reply-author',
        name: 'Ada',
        text: 'reply',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        parentId,
      },
      SPEND_PHOTO,
    );
    const spendPing = spendPingMock();
    const app = mount(store, OP_LOGIN, { spendPing, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Replies are not paid' });
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(spendPing.pingOnDay).not.toHaveBeenCalled();
  });

  it('returns 404 when the spend-ping row has a null accountId', async () => {
    const messageId = '77777777-7777-4777-8777-777777777777';
    class NullAccountIdStore extends InMemoryMessageStore {
      override async getById(id: string): ReturnType<InMemoryMessageStore['getById']> {
        const row = await super.getById(id);
        return row === undefined ? undefined : { ...row, accountId: null };
      }
    }
    const store = new NullAccountIdStore();
    await store.create(
      {
        id: messageId,
        accountId: 'null-account',
        name: 'Ada',
        text: 'photo',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    const spendPing = spendPingMock();
    const app = mount(store, OP_LOGIN, { spendPing, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Account not found' });
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(spendPing.pingOnDay).not.toHaveBeenCalled();
  });

  it('returns 404 when the spend-ping account was never inserted', async () => {
    const messageId = '88888888-8888-4888-8888-888888888888';
    const store = new InMemoryMessageStore();
    await store.create(
      {
        id: messageId,
        accountId: 'b1111111-1111-4111-8111-111111111111',
        name: 'Ada',
        text: 'photo',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    const spendPing = spendPingMock();
    const app = mount(store, OP_LOGIN, { spendPing, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Account not found' });
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(spendPing.pingOnDay).not.toHaveBeenCalled();
  });

  it('returns 503 when spend-ping getById throws', async () => {
    const messageId = '99999999-9999-4999-8999-999999999999';
    class ThrowingGetByIdStore extends InMemoryMessageStore {
      override getById(): ReturnType<InMemoryMessageStore['getById']> {
        return Promise.reject(new Error('get boom'));
      }
    }
    const spendPing = spendPingMock();
    const app = mount(new ThrowingGetByIdStore(), OP_LOGIN, { spendPing });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.spend_ping.failed')).toBe(true);
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(spendPing.pingOnDay).not.toHaveBeenCalled();
  });

  it('returns 503 when spend-ping getAccount throws', async () => {
    const messageId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const accountId = 'c1111111-1111-4111-8111-111111111111';
    class ThrowingAuthStore extends InMemoryAuthStore {
      override getAccount(): ReturnType<InMemoryAuthStore['getAccount']> {
        return Promise.reject(new Error('auth boom'));
      }
    }
    const store = new InMemoryMessageStore();
    await store.create(
      {
        id: messageId,
        accountId,
        name: 'Ada',
        text: 'photo',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    const spendPing = spendPingMock();
    const app = mount(store, OP_LOGIN, {
      spendPing,
      auth: new ThrowingAuthStore(),
      now: SPEND_NOW,
    });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.spend_ping.failed')).toBe(true);
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(spendPing.pingOnDay).not.toHaveBeenCalled();
  });

  it('returns 409 when the spend-ping target is the profile note', async () => {
    const messageId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const accountId = 'd1111111-1111-4111-8111-111111111111';
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await createReceiver(auth, {
      id: accountId,
      role: 'verified',
      name: 'Ada',
      profileMessageId: messageId,
    });
    await store.create(
      {
        id: messageId,
        accountId,
        name: 'Ada',
        text: 'about',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    const spendPing = spendPingMock();
    const app = mount(store, OP_LOGIN, { spendPing, auth, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Profile notes are not paid' });
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(spendPing.pingOnDay).not.toHaveBeenCalled();
  });

  it('replays spend ping when the message is from an earlier UTC day', async () => {
    const messageId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const accountId = 'e1111111-1111-4111-8111-111111111111';
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await createReceiver(auth, {
      id: accountId,
      role: 'verified',
      name: 'Ada',
    });
    await store.create(
      {
        id: messageId,
        accountId,
        name: 'Ada',
        text: 'photo',
        createdAt: new Date('2026-09-29T08:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    const spendPing = spendPingMock();
    const app = mount(store, OP_LOGIN, { spendPing, auth, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ messageId, status: 'accepted' });
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(spendPing.pingOnDay).toHaveBeenCalledTimes(1);
    expect(spendPing.pingOnDay.mock.calls[0]).toEqual([
      'ada@example.test',
      messageId,
      '2026-09-29',
      'none',
    ]);
  });

  it('returns 409 when the spend-ping account has no verified wallet', async () => {
    const messageId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const accountId = 'f1111111-1111-4111-8111-111111111111';
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await auth.createAccount(account({ id: accountId, role: 'verified', name: 'Ada' }));
    await store.create(
      {
        id: messageId,
        accountId,
        name: 'Ada',
        text: 'photo',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    const spendPing = spendPingMock();
    const app = mount(store, OP_LOGIN, { spendPing, auth, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'No Lightning address' });
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(spendPing.pingOnDay).not.toHaveBeenCalled();
  });

  it('returns 403 when the spend-ping account is not eligible', async () => {
    const messageId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const accountId = 'b2222222-2222-4222-8222-222222222222';
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await createReceiver(auth, {
      id: accountId,
      role: 'basis',
      name: 'Ada',
    });
    await store.create(
      {
        id: messageId,
        accountId,
        name: 'Ada',
        text: 'photo',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    const spendPing = spendPingMock();
    const app = mount(store, OP_LOGIN, { spendPing, auth, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(403);
    const json: unknown = await res.json();
    expect(json).toEqual({ error: 'Not eligible' });
    expect(JSON.stringify(json)).not.toContain('ada@example.test');
    const skipped = parsedEvents(warn).find((e) => e['event'] === 'debug.spend_ping.skipped');
    expect(skipped?.['reason']).toBe('not_eligible');
    expect(skipped?.['messageId']).toBe(messageId);
    expect(skipped).not.toHaveProperty('address');
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(spendPing.pingOnDay).not.toHaveBeenCalled();
  });

  it('returns 409 when the spend-ping message has no media', async () => {
    const messageId = '12121212-1212-4121-8121-121212121212';
    const accountId = 'c2222222-2222-4222-8222-222222222222';
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await createReceiver(auth, {
      id: accountId,
      role: 'verified',
      name: 'Ada',
    });
    await store.create({
      id: messageId,
      accountId,
      name: 'Ada',
      text: 'text only',
      createdAt: SPEND_CREATED_AT,
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const spendPing = spendPingMock();
    const app = mount(store, OP_LOGIN, { spendPing, auth, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Message has no media' });
    const skipped = parsedEvents(warn).find((e) => e['event'] === 'debug.spend_ping.skipped');
    expect(skipped?.['reason']).toBe('no_media');
    expect(skipped?.['messageId']).toBe(messageId);
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(spendPing.pingOnDay).not.toHaveBeenCalled();
  });

  it('replays spend ping when getById reports video without a photo', async () => {
    const messageId = '13131313-1313-4131-8131-131313131313';
    const accountId = 'd2222222-2222-4222-8222-222222222222';
    class VideoRowStore extends InMemoryMessageStore {
      override async getById(id: string): ReturnType<InMemoryMessageStore['getById']> {
        const row = await super.getById(id);
        return row === undefined
          ? undefined
          : { ...row, hasPhoto: false, hasVideo: true, photoCount: 0 };
      }
    }
    const store = new VideoRowStore();
    const auth = new InMemoryAuthStore();
    await createReceiver(auth, {
      id: accountId,
      role: 'verified',
      name: 'Ada',
    });
    await store.create({
      id: messageId,
      accountId,
      name: 'Ada',
      text: 'video',
      createdAt: SPEND_CREATED_AT,
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const spendPing = spendPingMock();
    const app = mount(store, OP_LOGIN, { spendPing, auth, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ messageId, status: 'accepted' });
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(spendPing.pingOnDay).toHaveBeenCalledTimes(1);
    expect(spendPing.pingOnDay.mock.calls[0]).toEqual([
      'ada@example.test',
      messageId,
      '2026-09-30',
      'none',
    ]);
  });

  it('replays spend ping when getById reports photoCount without hasPhoto', async () => {
    const messageId = '14141414-1414-4141-8141-141414141414';
    const accountId = 'e2222222-2222-4222-8222-222222222222';
    class PhotoCountStore extends InMemoryMessageStore {
      override async getById(id: string): ReturnType<InMemoryMessageStore['getById']> {
        const row = await super.getById(id);
        return row === undefined
          ? undefined
          : { ...row, hasPhoto: false, hasVideo: false, photoCount: 1 };
      }
    }
    const store = new PhotoCountStore();
    const auth = new InMemoryAuthStore();
    await createReceiver(auth, {
      id: accountId,
      role: 'verified',
      name: 'Ada',
    });
    await store.create({
      id: messageId,
      accountId,
      name: 'Ada',
      text: 'stills',
      createdAt: SPEND_CREATED_AT,
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const spendPing = spendPingMock();
    const app = mount(store, OP_LOGIN, { spendPing, auth, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ messageId, status: 'accepted' });
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(spendPing.pingOnDay).toHaveBeenCalledTimes(1);
    expect(spendPing.pingOnDay.mock.calls[0]).toEqual([
      'ada@example.test',
      messageId,
      '2026-09-30',
      'none',
    ]);
  });

  it('replays spend ping when fundingStore has no grant', async () => {
    const messageId = '15151515-1515-4151-8151-151515151515';
    const accountId = 'f2222222-2222-4222-8222-222222222222';
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await createReceiver(auth, {
      id: accountId,
      role: 'verified',
      name: 'Ada',
    });
    await store.create(
      {
        id: messageId,
        accountId,
        name: 'Ada',
        text: 'photo',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    const spendPing = spendPingMock();
    const app = mount(store, OP_LOGIN, {
      spendPing,
      auth,
      now: SPEND_NOW,
      fundingStore: new InMemoryFundingStore(),
    });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ messageId, status: 'accepted' });
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(spendPing.pingOnDay).toHaveBeenCalledTimes(1);
    expect(spendPing.pingOnDay.mock.calls[0]).toEqual([
      'ada@example.test',
      messageId,
      '2026-09-30',
      'none',
    ]);
  });

  it('returns 503 when fundingStore getByAccountId throws', async () => {
    const messageId = '16161616-1616-4161-8161-161616161616';
    const accountId = 'a3333333-3333-4333-8333-333333333333';
    class ThrowingFundingStore extends InMemoryFundingStore {
      override getByAccountId(): ReturnType<InMemoryFundingStore['getByAccountId']> {
        return Promise.reject(new Error('grant boom'));
      }
    }
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await createReceiver(auth, {
      id: accountId,
      role: 'verified',
      name: 'Ada',
    });
    await store.create(
      {
        id: messageId,
        accountId,
        name: 'Ada',
        text: 'photo',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    const spendPing = spendPingMock();
    const app = mount(store, OP_LOGIN, {
      spendPing,
      auth,
      now: SPEND_NOW,
      fundingStore: new ThrowingFundingStore(),
    });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.spend_ping.failed')).toBe(true);
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(spendPing.pingOnDay).not.toHaveBeenCalled();
  });

  it('returns 503 when spend ping rejects', async () => {
    const messageId = '17171717-1717-4171-8171-171717171717';
    const accountId = 'b3333333-3333-4333-8333-333333333333';
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await createReceiver(auth, {
      id: accountId,
      role: 'verified',
      name: 'Ada',
    });
    await store.create(
      {
        id: messageId,
        accountId,
        name: 'Ada',
        text: 'photo',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    const spendPing = {
      ping: vi.fn(async () => undefined),
      pingOnDay: vi.fn(async () => Promise.reject(new Error('ping boom'))),
    };
    const app = mount(store, OP_LOGIN, { spendPing, auth, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(503);
    expect(res.status).not.toBe(202);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.spend_ping.failed')).toBe(true);
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.spend_ping.sent')).toBe(false);
    expect(spendPing.ping).not.toHaveBeenCalled();
  });

  it('returns 200 skipped when pingOnDay skips the post day', async () => {
    const messageId = '18181818-1818-4181-8181-181818181818';
    const accountId = 'c3333333-3333-4333-8333-333333333333';
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await createReceiver(auth, {
      id: accountId,
      role: 'verified',
      name: 'Ada',
    });
    await store.create(
      {
        id: messageId,
        accountId,
        name: 'Ada',
        text: 'photo',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    const spendPing = {
      ping: vi.fn(async () => undefined),
      pingOnDay: vi.fn(async () => ({ status: 'skipped' as const, reason: 'paid' })),
    };
    const app = mount(store, OP_LOGIN, { spendPing, auth, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(200);
    const json: unknown = await res.json();
    expect(json).toEqual({ messageId, status: 'skipped', reason: 'paid' });
    expect(JSON.stringify(json)).not.toContain('ada@example.test');
    expect(spendPing.ping).not.toHaveBeenCalled();
  });

  it('returns 503 when pingOnDay fails', async () => {
    const messageId = '19191919-1919-4191-8191-191919191919';
    const accountId = 'd3333333-3333-4333-8333-333333333333';
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await createReceiver(auth, {
      id: accountId,
      role: 'verified',
      name: 'Ada',
    });
    await store.create(
      {
        id: messageId,
        accountId,
        name: 'Ada',
        text: 'photo',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    const spendPing = {
      ping: vi.fn(async () => undefined),
      pingOnDay: vi.fn(async () => ({ status: 'failed' as const })),
    };
    const app = mount(store, OP_LOGIN, { spendPing, auth, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.spend_ping.failed')).toBe(true);
    expect(parsedEvents(warn).some((e) => e['event'] === 'debug.spend_ping.sent')).toBe(false);
    expect(spendPing.ping).not.toHaveBeenCalled();
  });

  it('returns 503 when pingOnDay is missing', async () => {
    const messageId = '1a1a1a1a-1a1a-41a1-81a1-1a1a1a1a1a1a';
    const accountId = 'e3333333-3333-4333-8333-333333333333';
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await createReceiver(auth, {
      id: accountId,
      role: 'verified',
      name: 'Ada',
    });
    await store.create(
      {
        id: messageId,
        accountId,
        name: 'Ada',
        text: 'photo',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    const spendPing = { ping: vi.fn(async () => undefined) };
    const app = mount(store, OP_LOGIN, { spendPing, auth, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Spend ping is not configured' });
    expect(spendPing.ping).not.toHaveBeenCalled();
  });

  it('returns 409 when the spend-ping message day is in the future', async () => {
    const messageId = '1b1b1b1b-1b1b-41b1-81b1-1b1b1b1b1b1b';
    const accountId = 'f3333333-3333-4333-8333-333333333333';
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await createReceiver(auth, {
      id: accountId,
      role: 'verified',
      name: 'Ada',
    });
    await store.create(
      {
        id: messageId,
        accountId,
        name: 'Ada',
        text: 'photo',
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    const spendPing = spendPingMock();
    const app = mount(store, OP_LOGIN, { spendPing, auth, now: SPEND_NOW });
    const res = await app.request('/debug/spend-ping', {
      method: 'POST',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ messageId }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Message is not from today' });
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(spendPing.pingOnDay).not.toHaveBeenCalled();
  });

  describe('spend-ping replay from the grant gate day', () => {
    const GATE_NOW = (): number => Date.parse('2026-10-29T12:00:00.000Z');
    const messageId = '18181818-1818-4181-8181-181818181818';
    const accountId = 'c4444444-4444-4444-8444-444444444444';

    /** An admitted receiver with today's photo post, and optionally the recovery share. */
    async function gated(share: boolean): Promise<{
      store: InMemoryMessageStore;
      auth: InMemoryAuthStore;
      fundingStore: InMemoryFundingStore;
    }> {
      const store = new InMemoryMessageStore();
      const auth = new InMemoryAuthStore();
      await createReceiver(auth, { id: accountId, role: 'verified', name: 'Ada' });
      if (share) {
        const receiver = await auth.getAccount(accountId);
        await storeRecoveryShare(auth, accountId, receiver!.sparkPubkey!);
      }
      await store.create(
        {
          id: messageId,
          accountId,
          name: 'Ada',
          text: 'photo',
          createdAt: new Date('2026-10-29T08:00:00.000Z'),
          hasPhoto: false,
          ...unsignedNostrDefaults(),
        },
        SPEND_PHOTO,
      );
      const fundingStore = new InMemoryFundingStore([
        {
          accountId,
          status: 'admitted',
          appliedAt: 1,
          decidedAt: 2,
          decidedBy: 'staff',
          trialUtcDate: null,
          admittedAt: 2,
          note: null,
        },
      ]);
      return { store, auth, fundingStore };
    }

    async function replay(
      deps: Awaited<ReturnType<typeof gated>>,
      spendPing: ReturnType<typeof spendPingMock>,
      requiredFrom: string | null = '2026-10-29',
    ): Promise<Response> {
      const app = mount(deps.store, OP_LOGIN, {
        spendPing,
        auth: deps.auth,
        fundingStore: deps.fundingStore,
        recoveryShareRequiredFrom: requiredFrom,
        now: GATE_NOW,
        walletTransfers: {
          // Only the daily minimum of the 1 USD default grant at 100 000 USD/BTC
          // passes, so a call that dropped the 50 % minimum fails the test.
          hasShopPayment: async (_id, _from, _to, minSats = 1) => minSats === 500,
        },
        rosterStore: { get: async () => ({ paymentsEnabled: true, recipients: [] }) as never },
        fxSpotStore: { latest: async () => ({ rates: { USD: '100000' } }) as never },
      });
      return app.request('/debug/spend-ping', {
        method: 'POST',
        headers: SPEND_HEADERS,
        body: JSON.stringify({ messageId }),
      });
    }

    it('answers 403 Not eligible for an admitted member without a recovery share', async () => {
      const spendPing = spendPingMock();
      const res = await replay(await gated(false), spendPing);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Not eligible' });
      expect(parsedEvents(warn)).toContainEqual(
        expect.objectContaining({
          event: 'debug.spend_ping.skipped',
          messageId,
          reason: 'not_eligible',
        }),
      );
      expect(spendPing.pingOnDay).not.toHaveBeenCalled();
    });

    it.each([
      ['the day before the start day', '2026-10-30'],
      ['an unset start day', null],
    ])('replays for an admitted member without a share on %s', async (_label, requiredFrom) => {
      const spendPing = spendPingMock();
      const res = await replay(await gated(false), spendPing, requiredFrom);
      expect(res.status).toBe(202);
      expect(spendPing.pingOnDay).toHaveBeenCalledTimes(1);
    });

    it('replays for an admitted member with a recovery share', async () => {
      const spendPing = spendPingMock();
      const res = await replay(await gated(true), spendPing);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ messageId, status: 'accepted' });
      expect(spendPing.pingOnDay.mock.calls[0]).toEqual([
        'ada@example.test',
        messageId,
        '2026-10-29',
        'admitted',
      ]);
    });

    it.each([
      ['the start day', '2026-10-29', true, false],
      ['the day before the start day', '2026-10-30', true, true],
      ['the day before the start day without media', '2026-10-30', false, false],
    ])('settling a platform-note zap on %s', async (_label, requiredFrom, hasMedia, pinged) => {
      const store = new InMemoryMessageStore();
      const auth = new InMemoryAuthStore();
      await auth.createAccount(
        account({
          id: 'settle-author',
          role: 'founder',
          isPlatform: true,
          profileMessageId: 'settle-message',
        }),
      );
      await createReceiver(auth, {
        id: 'settle-payer',
        role: 'verified',
        name: 'Ada',
        forumLawsDismissed: false,
      });
      if (hasMedia) {
        await store.create(
          {
            id: '19191919-1919-4191-8191-191919191919',
            accountId: 'settle-payer',
            name: 'Ada',
            text: 'today photo',
            createdAt: new Date('2026-10-29T08:00:00.000Z'),
            hasPhoto: false,
            ...unsignedNostrDefaults(),
          },
          SPEND_PHOTO,
        );
      }
      const preimage = '16'.repeat(32);
      const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
      await seedSettleInvoice(store, paymentHash);
      const fundingStore = new InMemoryFundingStore([
        {
          accountId: 'settle-payer',
          status: 'admitted',
          appliedAt: 1,
          decidedAt: 2,
          decidedBy: 'staff',
          trialUtcDate: null,
          admittedAt: 2,
          note: null,
        },
      ]);
      const spendPing = { ping: vi.fn(async () => undefined) };
      const res = await mount(store, OP_LOGIN, {
        spendPing,
        auth,
        fundingStore,
        recoveryShareRequiredFrom: requiredFrom,
        now: GATE_NOW,
        walletTransfers: {
          // Only the daily minimum of the 1 USD default grant at 100 000 USD/BTC
          // passes, so a call that dropped the 50 % minimum fails the test.
          hasShopPayment: async (_id, _from, _to, minSats = 1) => minSats === 500,
        },
        rosterStore: { get: async () => ({ paymentsEnabled: true, recipients: [] }) as never },
        fxSpotStore: { latest: async () => ({ rates: { USD: '100000' } }) as never },
      }).request('/debug/invoices/settle', {
        method: 'POST',
        headers: { authorization: ADMIN_AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ paymentHash, note: 'evidence', preimage }),
      });
      expect(res.status).toBe(200);
      expect(spendPing.ping).toHaveBeenCalledTimes(pinged ? 1 : 0);
    });

    it('answers 503 when the share read throws', async () => {
      const deps = await gated(true);
      vi.spyOn(deps.auth, 'hasRecoveryShareForVerifiedWallet').mockRejectedValue(
        new Error('share down'),
      );
      const spendPing = spendPingMock();
      const res = await replay(deps, spendPing);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
      expect(parsedEvents(warn)).toContainEqual(
        expect.objectContaining({ event: 'debug.spend_ping.failed', messageId }),
      );
      expect(spendPing.pingOnDay).not.toHaveBeenCalled();
    });
  });

  describe('window replay', () => {
    const WINDOW = { from: '2026-09-29T23:00:00.000Z', to: '2026-09-30T01:00:00.000Z' };
    const WINDOW_NOW = (): number => Date.parse('2026-09-30T01:30:00.000Z');
    const ACCOUNT_ID = 'a7777777-7777-4777-8777-777777777777';
    const MESSAGE_ID = '17171717-1717-4171-8171-171717171717';

    async function seeded(): Promise<{
      store: InMemoryMessageStore;
      auth: InMemoryAuthStore;
      fundingStore: InMemoryFundingStore;
    }> {
      const store = new InMemoryMessageStore();
      const auth = new InMemoryAuthStore();
      await createReceiver(auth, { id: ACCOUNT_ID, role: 'verified', name: 'Ada' });
      await store.create(
        {
          id: MESSAGE_ID,
          accountId: ACCOUNT_ID,
          name: 'Ada',
          text: 'photo',
          createdAt: new Date('2026-09-29T23:30:00.000Z'),
          hasPhoto: false,
          ...unsignedNostrDefaults(),
        },
        SPEND_PHOTO,
      );
      const fundingStore = new InMemoryFundingStore([
        {
          accountId: ACCOUNT_ID,
          status: 'admitted',
          appliedAt: 1,
          decidedAt: 2,
          decidedBy: null,
          trialUtcDate: null,
          admittedAt: 2,
          note: null,
        },
      ]);
      return { store, auth, fundingStore };
    }

    async function post(app: Hono, body: unknown): Promise<Response> {
      return app.request('/debug/spend-ping', {
        method: 'POST',
        headers: SPEND_HEADERS,
        body: JSON.stringify(body),
      });
    }

    it('replays every event of the window onto its own day', async () => {
      const { store, auth, fundingStore } = await seeded();
      const spendPing = spendPingMock();
      const hasShopPayment = vi.fn(
        async (_id: string, _from: string, _to: string, minSats = 1) => minSats <= 500,
      );
      const app = mount(store, OP_LOGIN, {
        spendPing,
        auth,
        fundingStore,
        now: WINDOW_NOW,
        walletTransfers: { hasShopPayment },
        rosterStore: { get: async () => ({ paymentsEnabled: true, recipients: [] }) as never },
        fxSpotStore: { latest: async () => ({ rates: { USD: '100000' } }) as never },
      });
      const res = await post(app, WINDOW);
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json).toMatchObject({
        ...WINDOW,
        dryRun: false,
        totals: { events: 2, paid: 1, sent: 1 },
      });
      expect(json['events']).toEqual([
        expect.objectContaining({ trigger: 'post', day: '2026-09-29', status: 'paid' }),
        expect.objectContaining({ trigger: 'welcome', status: 'sent' }),
      ]);
      expect(JSON.stringify(json)).not.toContain('ada@example.test');
      expect(spendPing.pingOnDay.mock.calls).toEqual([
        ['ada@example.test', MESSAGE_ID, '2026-09-29', 'admitted', 'daily'],
      ]);
      expect(hasShopPayment).toHaveBeenCalledWith(ACCOUNT_ID, '2026-09-28', '2026-09-29', 500);
      const replayed = parsedEvents(warn).find((e) => e['event'] === 'debug.spend_ping.replayed');
      expect(replayed).toMatchObject({ dryRun: false, events: 2, paid: 1 });
    });

    it('replays without a funding store or LNURL server', async () => {
      const app = new Hono().route(
        '/debug',
        debugPaymentsRoutes({
          store: new InMemoryMessageStore(),
          auth: new InMemoryAuthStore(),
          now: WINDOW_NOW,
          operatorLogin: OP_LOGIN,
          spendPing: spendPingMock(),
          conversationStore: new InMemoryConversationStore(),
          trustStore: new InMemoryTrustStore(),
          giftStore: new InMemoryGiftStore(),
          welcomeSweep: { enabled: false },
        }),
      );
      const res = await post(app, WINDOW);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ events: [], totals: { events: 0 } });
    });

    it('dry-run pings nothing', async () => {
      const { store, auth, fundingStore } = await seeded();
      const spendPing = spendPingMock();
      const app = mount(store, OP_LOGIN, { spendPing, auth, fundingStore, now: WINDOW_NOW });
      const res = await post(app, { ...WINDOW, dryRun: true });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        dryRun: true,
        totals: { events: 2, wouldPay: 1, wouldSend: 1, paid: 0, sent: 0 },
      });
      expect(spendPing.ping).not.toHaveBeenCalled();
      expect(spendPing.pingOnDay).not.toHaveBeenCalled();
    });

    it('counts a payout in the gift ledger on that day as already paid', async () => {
      const { store, auth, fundingStore } = await seeded();
      const spendPing = spendPingMock();
      const giftStore = new InMemoryGiftStore([
        {
          paidAt: new Date('2026-09-29T10:00:00.000Z'),
          amountSats: 1000,
          recipientWosUser: 'ada',
          kind: 'daily',
        },
      ]);
      const app = mount(store, OP_LOGIN, {
        spendPing,
        auth,
        fundingStore,
        giftStore,
        now: WINDOW_NOW,
      });
      const json = (await (await post(app, WINDOW)).json()) as { events: unknown[] };
      expect(json.events[0]).toMatchObject({ reason: 'already_paid', detail: 'ledger' });
      expect(spendPing.pingOnDay).not.toHaveBeenCalled();
    });

    it.each([
      [{ from: WINDOW.from }],
      [{ ...WINDOW, from: 1 }],
      [{ ...WINDOW, dryRun: 'yes' }],
      [{ ...WINDOW, from: 'yesterday' }],
      [{ ...WINDOW, to: WINDOW.from }],
      [{ from: '2026-09-27T00:00:00.000Z', to: '2026-09-29T00:00:01.000Z' }],
      [{ from: '2026-09-30T02:00:00.000Z', to: '2026-09-30T03:00:00.000Z' }],
      [{ ...WINDOW, messageId: MESSAGE_ID }],
    ])('returns 400 for the window body %j', async (body) => {
      const spendPing = spendPingMock();
      const app = mount(new InMemoryMessageStore(), OP_LOGIN, { spendPing, now: WINDOW_NOW });
      const res = await post(app, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid body' });
      expect(spendPing.pingOnDay).not.toHaveBeenCalled();
    });

    it('returns 503 when pingOnDay is missing', async () => {
      const app = mount(new InMemoryMessageStore(), OP_LOGIN, {
        spendPing: { ping: vi.fn(async () => undefined) },
        now: WINDOW_NOW,
      });
      const res = await post(app, WINDOW);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Spend ping is not configured' });
    });

    it('returns 503 when a store read throws', async () => {
      const { store, auth } = await seeded();
      const fundingStore = new InMemoryFundingStore();
      vi.spyOn(fundingStore, 'listGrants').mockRejectedValue(new Error('down'));
      const app = mount(store, OP_LOGIN, {
        spendPing: spendPingMock(),
        auth,
        fundingStore,
        now: WINDOW_NOW,
      });
      const res = await post(app, WINDOW);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
      expect(parsedEvents(warn).some((e) => e['event'] === 'debug.spend_ping.replay_failed')).toBe(
        true,
      );
    });
  });
});

describe('/debug/welcome-sweep', () => {
  const accountId = 'a1111111-1111-4111-8111-111111111111';
  const messageId = 'b1111111-1111-4111-8111-111111111111';

  async function seedOwed(): Promise<{ store: InMemoryMessageStore; auth: InMemoryAuthStore }> {
    const store = new InMemoryMessageStore();
    const auth = new InMemoryAuthStore();
    await createReceiver(auth, { id: accountId, role: 'verified', name: 'Ada' });
    await store.create(
      {
        id: messageId,
        accountId,
        name: 'Ada',
        text: 'photo',
        createdAt: SPEND_CREATED_AT,
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      SPEND_PHOTO,
    );
    return { store, auth };
  }

  it('answers 503 without a key login and 401 without the bearer', async () => {
    const store = new InMemoryMessageStore();
    expect((await mount(store, undefined).request('/debug/welcome-sweep')).status).toBe(503);
    const app = mount(store, OP_LOGIN);
    expect((await app.request('/debug/welcome-sweep')).status).toBe(401);
    expect((await app.request('/debug/welcome-sweep', { method: 'PUT' })).status).toBe(401);
  });

  it('lists the accounts the sweep would ping without pinging', async () => {
    const { store, auth } = await seedOwed();
    const spendPing = spendPingMock();
    const app = mount(store, OP_LOGIN, { spendPing, auth });
    const res = await app.request('/debug/welcome-sweep', { headers: READ_HEADERS });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: false,
      spendPing: true,
      wouldPing: [{ accountId, username: 'ada', messageId }],
    });
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(spendPing.pingOnDay).not.toHaveBeenCalled();
    expect(await store.listInvoiceAttempts(10)).toEqual([]);
  });

  it('leaves out an account welcomed at its legacy external address', async () => {
    const { store, auth } = await seedOwed();
    const gifts = new InMemoryGiftStore([], [accountId]);
    const app = mount(store, OP_LOGIN, { auth, giftStore: gifts });
    const res = await app.request('/debug/welcome-sweep', { headers: READ_HEADERS });
    expect(await res.json()).toEqual({ enabled: false, spendPing: false, wouldPing: [] });
  });

  it('answers 503 when the accounts cannot be read', async () => {
    const auth = new InMemoryAuthStore();
    vi.spyOn(auth, 'listAccounts').mockRejectedValue(new Error('down'));
    const app = mount(new InMemoryMessageStore(), OP_LOGIN, { auth });
    const res = await app.request('/debug/welcome-sweep', { headers: READ_HEADERS });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
  });

  it('turns the switch on and off', async () => {
    const welcomeSweep = { enabled: false };
    const app = mount(new InMemoryMessageStore(), OP_LOGIN, { welcomeSweep });
    const on = await app.request('/debug/welcome-sweep', {
      method: 'PUT',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ enabled: true }),
    });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ enabled: true });
    expect(welcomeSweep.enabled).toBe(true);
    const listed = await app.request('/debug/welcome-sweep', { headers: READ_HEADERS });
    expect(((await listed.json()) as { enabled: boolean }).enabled).toBe(true);
    const off = await app.request('/debug/welcome-sweep', {
      method: 'PUT',
      headers: SPEND_HEADERS,
      body: JSON.stringify({ enabled: false }),
    });
    expect(await off.json()).toEqual({ enabled: false });
    expect(welcomeSweep.enabled).toBe(false);
  });

  it('rejects a body without an enabled boolean', async () => {
    const welcomeSweep = { enabled: false };
    const app = mount(new InMemoryMessageStore(), OP_LOGIN, { welcomeSweep });
    for (const body of ['{"enabled":"yes"}', '{"enabled":true,"x":1}', 'nope']) {
      const res = await app.request('/debug/welcome-sweep', {
        method: 'PUT',
        headers: SPEND_HEADERS,
        body,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Expected a JSON body with an "enabled" boolean' });
    }
    expect(welcomeSweep.enabled).toBe(false);
  });
});
