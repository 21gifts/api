import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GIFT_INVOICE_MAX_MSAT, GIFT_INVOICE_TTL_MS, type LnurlServerConfig } from '@/lib/config';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { InMemoryConversationStore, type ConversationStore } from '@/lib/conversation-store';
import { InMemoryInvoiceStore, type GiftInvoice } from '@/lib/invoice-store';
import { unsignedNostrDefaults, type ForumPhoto } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import {
  issueGiftInvoice,
  persistProvenGift,
  settleProvenGift,
  type GiftActionDeps,
  type IssueGiftInvoiceResult,
} from '@/routes/invoices';
import { FUNDING_REQUIRED_FROM_UTC, type FundingGrant } from '@/lib/funding';
import { InMemoryFundingStore } from '@/lib/funding-store';
import type { GiftRow } from '@/lib/gift';
import { InMemoryGiftStore } from '@/lib/gift-store';
import type { GiftRecord, GiftRecorder } from '@/lib/gift-recorder';
import { setAddressRefKey, setDiagnosticSink } from '@/lib/log';
import type { FiatAmounts } from '@/lib/money';
import { InMemoryWelcomeInvoiceReservationStore } from '@/lib/welcome-reservation';
import { decodeBolt11 } from '@/lib/bolt11';
import { expectedAddressRef } from '@/__tests__/helpers/address-ref';
import { storeRecoveryShare } from '@/__tests__/helpers/recovery';
import { fetchBtcUsdSpot } from '@/lib/btc-usd-spot';
import type { FetchFn } from '@/lib/lnurlp';
import {
  LNURL_SERVER,
  WALLET_PUBKEY,
  allInternal,
  walletLnurlFetch,
} from '@/__tests__/helpers/wallet-lnurl';
import type { WalletTransferStore } from '@/lib/wallet-transfer-store';
import { InMemoryFxSpotStore } from '@/lib/fx-spot-store';
import { InMemoryDailyRosterStore } from '@/lib/daily-roster-store';

vi.mock('@/lib/bolt11', () => ({
  decodeBolt11: vi.fn(),
}));

vi.mock('@/lib/btc-usd-spot', () => ({
  fetchBtcUsdSpot: vi.fn(async () => null),
}));

function admittedStore(accountId = 'acc-alice'): InMemoryFundingStore {
  return new InMemoryFundingStore([
    {
      accountId,
      status: 'admitted',
      appliedAt: Date.parse('2026-09-01T00:00:00.000Z'),
      decidedAt: Date.parse('2026-09-10T08:00:00.000Z'),
      decidedBy: 'staff',
      trialUtcDate: null,
      admittedAt: Date.parse('2026-09-15T18:00:00.000Z'),
      note: null,
    },
  ]);
}

function fakeWalletTransferStore(shopPayment = true): WalletTransferStore {
  return {
    listWallets: async () => [],
    syncState: async () => ({
      newestCreatedAt: null,
      oldestPendingCreatedAt: null,
      pendingWithoutCreatedAt: false,
      lastFullSyncAt: null,
    }),
    upsertTransfer: async () => ({
      inserted: false,
      updated: false,
      shopPaymentBecameCompleted: false,
    }),
    upsertTokenTransaction: async () => undefined,
    markFullSync: async () => undefined,
    hasShopPayment: async (_id, _from, _to, minSats = 1) => (shopPayment ? 500 : 0) >= minSats,
    shopPaymentSats: async () => (shopPayment ? 500 : 0),
  };
}

/** Fetch that fails the test when a path reaches LNURL-pay unexpectedly. */
const unexpectedFetch: FetchFn = async () => {
  throw new Error('unexpected fetch');
};

/**
 * Gift action collaborators wired from in-memory stores the way `createApp`
 * wires the `/fond` actions: one gift store backs both `gifts` and
 * `giftStore`, the welcome reservations are explicit, the LNURL server makes
 * `alice@example.test` a wallet address, and no gift recorder is set.
 *
 * @param overrides - Per-test collaborators; `giftStore` also becomes `gifts`
 *   unless `gifts` is given.
 * @returns Action dependencies.
 */
function actionDeps(overrides: Partial<GiftActionDeps> = {}): GiftActionDeps {
  const giftStore = overrides.giftStore ?? new InMemoryGiftStore();
  return {
    store: new InMemoryInvoiceStore(),
    welcomeReservations: new InMemoryWelcomeInvoiceReservationStore(),
    walletTransfers: fakeWalletTransferStore(),
    authStore: new InMemoryAuthStore(),
    messageStore: new InMemoryMessageStore(),
    now: Date.now,
    fetchImpl: unexpectedFetch,
    lnurlServer: LNURL_SERVER,
    conversationStore: new InMemoryConversationStore(),
    fundingStore: admittedStore(),
    fxSpotStore: dailySpot(),
    recoveryShareRequiredFrom: null,
    gifts: giftStore,
    giftStore,
    ...overrides,
  };
}

/** One stored spot, so daily payouts can compute their 50 % minimum. */
function dailySpot(): InMemoryFxSpotStore {
  return new InMemoryFxSpotStore({
    asOf: '2026-09-15T00:00:00.000Z',
    source: 'test',
    rates: { USD: '100000' },
  });
}

/** Gift recorder that keeps every recorded row. */
function capturingRecorder(): { giftRecorder: GiftRecorder; recorded: GiftRecord[] } {
  const recorded: GiftRecord[] = [];
  return {
    recorded,
    giftRecorder: {
      recordOutbound: async (row) => {
        recorded.push(row);
      },
    },
  };
}

/**
 * The issued invoice of a successful issue result.
 *
 * @throws Error when the action refused.
 */
function issuedInvoice(result: IssueGiftInvoiceResult): GiftInvoice {
  if (!result.ok) {
    throw new Error(`expected an invoice, got ${result.status} ${result.error}`);
  }
  return result.invoice;
}

/** USD-only fiat snapshot, as the Fond paid worker passes it. */
function usdFiat(usd: string | null): FiatAmounts {
  return { usd, chf: null, eur: null, php: null };
}

/**
 * Claim and verify the wallet of `acc-alice` (username `alice`) and, unless
 * `share` is false, store the 21.gifts recovery share that payouts need from
 * `recoveryShareRequiredFrom` on.
 */
async function verifyWallet(
  authStore: InMemoryAuthStore,
  id = 'acc-alice',
  share = true,
): Promise<void> {
  const account = await authStore.getAccount(id);
  await authStore.claimSparkPubkey(id, WALLET_PUBKEY);
  await authStore.markSparkPubkeyVerified(id, WALLET_PUBKEY, account!.username!, 2);
  if (share) {
    await storeRecoveryShare(authStore, id, WALLET_PUBKEY);
  }
}

const NOW_MS = Date.parse('2026-09-20T12:00:00.000Z');
const GATE_MS = Date.parse(`${FUNDING_REQUIRED_FROM_UTC}T12:00:00.000Z`);
const TOKEN = 'spend-secret-token';
const ADDRESS = 'alice@example.test';
const ADDRESS_REF = expectedAddressRef(ADDRESS, TOKEN);
const PR = 'lnbc1issued';
const HASH = 'aa'.repeat(32);
const MAX_SENDABLE = 100_000_000_000;
const ONE_USD_AT_100K_MSAT = 1_000_000;
/** Paying wallet label the Fond paid worker passes (the Fond username). */
const SOURCE_WALLET = 'fond';
const PAID_AT_MS = 100;
const POST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_POST_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REPLY_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PROFILE_NOTE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const UNKNOWN_POST_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const GROUP_MSG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_GROUP_MSG_ID = '22222222-2222-4222-8222-222222222222';

const mockedDecode = vi.mocked(decodeBolt11);
const mockedSpot = vi.mocked(fetchBtcUsdSpot);

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
        callback: 'https://example.test/lnurlp/alice/invoice',
        minSendable: 1000,
        maxSendable: MAX_SENDABLE,
        commentAllowed: 255,
      });
    }
    return jsonResponse({ pr: PR });
  };
}

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

/**
 * Seed `acc-alice` (wallet `alice@example.test`) with a passkey credential so
 * `issueGiftInvoice` can reach LNURL. `share: false` leaves out the 21.gifts
 * recovery share.
 */
async function seedPasskeyAccount(
  authStore: InMemoryAuthStore,
  { share = true }: { share?: boolean } = {},
): Promise<void> {
  await authStore.createAccount({
    id: 'acc-alice',
    username: 'alice',
    walletRequired: true,
    linkingKey: null,
    role: 'verified',
    name: 'Ada',
    forumLawsDismissed: false,
    location: null,
    viewKey: 'a'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: null,
  });
  await verifyWallet(authStore, 'acc-alice', share);
  await authStore.createPasskeyCredential({
    credentialId: 'cred-alice',
    publicKey: new Uint8Array([1]),
    signCount: 0,
    accountId: 'acc-alice',
    createdAt: 1,
  });
}

function expiredTrialGrant(accountId = 'acc-alice'): FundingGrant {
  return {
    accountId,
    status: 'trial',
    appliedAt: Date.parse('2026-09-01T00:00:00.000Z'),
    decidedAt: Date.parse('2026-09-10T08:00:00.000Z'),
    decidedBy: 'staff',
    trialUtcDate: '2026-09-19',
    admittedAt: null,
    note: 'keep',
  };
}

/**
 * Seed one live non-profile top-level forum row for `accountId`.
 */
function livePostStore(accountId: string = 'acc-alice'): InMemoryMessageStore {
  return new InMemoryMessageStore([
    {
      id: 'post-alice',
      accountId,
      name: 'Ada',
      text: 'first',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    },
  ]);
}

/**
 * Seed one live reply (no top-level row) for `accountId`.
 */
function liveReplyStore(accountId: string = 'acc-alice'): InMemoryMessageStore {
  return new InMemoryMessageStore([
    {
      id: 'reply-alice',
      accountId,
      name: 'Ada',
      text: 'reply',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: 'parent-alice',
    },
  ]);
}

async function seedPasskeyAndPlatform(
  authStore: InMemoryAuthStore,
  options: { share?: boolean } = {},
): Promise<void> {
  await seedPasskeyAccount(authStore, options);
  await authStore.createAccount({
    id: 'plat',
    linkingKey: null,
    role: 'founder',
    name: '21.gifts',
    forumLawsDismissed: false,
    location: null,
    viewKey: 'b'.repeat(64),
    createdAt: 2,
    rulesAgreedAt: null,
    isPlatform: true,
  });
}

/** Seed `acc-alice` with a profile note, wallet, passkey, and the platform account. */
async function seedProfileAccountAndPlatform(authStore: InMemoryAuthStore): Promise<void> {
  await authStore.createAccount({
    id: 'acc-alice',
    username: 'alice',
    walletRequired: true,
    linkingKey: null,
    role: 'verified',
    name: 'Ada',
    forumLawsDismissed: false,
    location: null,
    viewKey: 'a'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: null,
    profileMessageId: PROFILE_NOTE_ID,
  });
  await verifyWallet(authStore);
  await authStore.createPasskeyCredential({
    credentialId: 'cred-alice',
    publicKey: new Uint8Array([1]),
    signCount: 0,
    accountId: 'acc-alice',
    createdAt: 1,
  });
  await authStore.createAccount({
    id: 'plat',
    linkingKey: null,
    role: 'founder',
    name: '21.gifts',
    forumLawsDismissed: false,
    location: null,
    viewKey: 'b'.repeat(64),
    createdAt: 2,
    rulesAgreedAt: null,
    isPlatform: true,
  });
}

/** Seed `acc-alice` (basis, with `name`), wallet, passkey, and the platform account. */
async function seedNamedRecipientAndPlatform(
  authStore: InMemoryAuthStore,
  name: string | null,
): Promise<void> {
  await authStore.createAccount({
    id: 'acc-alice',
    username: 'alice',
    walletRequired: true,
    linkingKey: null,
    role: 'basis',
    name,
    forumLawsDismissed: false,
    location: null,
    viewKey: 'a'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: null,
  });
  await verifyWallet(authStore);
  await authStore.createPasskeyCredential({
    credentialId: 'cred-alice',
    publicKey: new Uint8Array([1]),
    signCount: 0,
    accountId: 'acc-alice',
    createdAt: 1,
  });
  await authStore.createAccount({
    id: 'plat',
    linkingKey: null,
    role: 'founder',
    name: '21.gifts',
    forumLawsDismissed: false,
    location: null,
    viewKey: 'b'.repeat(64),
    createdAt: 2,
    rulesAgreedAt: null,
    isPlatform: true,
  });
}

function uuidPostStore(): InMemoryMessageStore {
  return new InMemoryMessageStore([
    {
      id: POST_ID,
      accountId: 'acc-alice',
      name: 'Ada',
      text: 'first',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    },
  ]);
}

const JPEG: ForumPhoto = {
  contentType: 'image/jpeg',
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
};

async function uuidMediaPostStore(): Promise<InMemoryMessageStore> {
  const store = new InMemoryMessageStore();
  await store.create(
    {
      id: POST_ID,
      accountId: 'acc-alice',
      name: 'Ada',
      text: 'first',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    },
    JPEG,
  );
  return store;
}

function closedCreditStore(): InMemoryMessageStore {
  return new InMemoryMessageStore([
    {
      id: POST_ID,
      accountId: 'acc-alice',
      name: 'Ada',
      text: 'closed credit',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      hasPhoto: false,
      hasVideo: true,
      videoContentType: 'video/mp4',
      ...unsignedNostrDefaults(),
      goalSats: 1000,
      goalRepayable: true,
      goalTermDays: 2,
      goalFundedAt: new Date('2026-08-02T00:00:00.000Z'),
      goalClosedAt: new Date('2026-08-03T00:00:00.000Z'),
    },
  ]);
}

/** Same derivation as production `spendGiftReplyId` (not exported). */
function spendGiftReplyId(invoiceId: string): string {
  const hex = createHash('sha256').update(`21gifts-spend-gift:${invoiceId}`).digest('hex');
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

/** Same derivation as production `spendGroupGiftId` (not exported). */
function spendGroupGiftId(invoiceId: string): string {
  const hex = createHash('sha256').update(`21gifts-spend-group-gift:${invoiceId}`).digest('hex');
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

async function seedGroupTrigger(
  conversations: InMemoryConversationStore,
  senderAccountId: string | null = 'acc-alice',
  messageId: string = GROUP_MSG_ID,
): Promise<string> {
  const thread = await conversations.ensureModeratorGroup('plat', new Date(1));
  await conversations.appendMessage({
    id: messageId,
    conversationId: thread.id,
    text: 'mod note',
    createdAt: new Date(1),
    senderAccountId,
    senderPubkey: null,
    name: 'Ada',
    sats: 0,
    eventId: null,
    nostrPublishState: 'skipped',
    nostrEvent: null,
    claimedUntil: null,
  });
  return thread.id;
}

/** Seed a member-platform thread whose message has the group trigger id. */
async function seedNonGroupTrigger(conversations: InMemoryConversationStore): Promise<void> {
  const thread = await conversations.openMemberPlatform('acc-alice', 'plat', new Date(1));
  await conversations.appendMessage({
    id: GROUP_MSG_ID,
    conversationId: thread.id,
    text: 'mod note',
    createdAt: new Date(1),
    senderAccountId: 'acc-alice',
    senderPubkey: null,
    name: 'Ada',
    sats: 0,
    eventId: null,
    nostrPublishState: 'skipped',
    nostrEvent: null,
    claimedUntil: null,
  });
}

function uuidReplyStore(): InMemoryMessageStore {
  return new InMemoryMessageStore([
    {
      id: POST_ID,
      accountId: 'acc-alice',
      name: 'Ada',
      text: 'first',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    },
    {
      id: REPLY_ID,
      accountId: 'acc-alice',
      name: 'Ada',
      text: 'reply',
      createdAt: new Date('2026-08-01T00:00:01.000Z'),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      parentId: POST_ID,
    },
  ]);
}

/** A welcome gift row already paid to `alice`. */
const PAID_WELCOME: GiftRow = {
  paidAt: new Date(5),
  amountSats: 1,
  recipientWosUser: 'alice',
  kind: 'welcome',
  description: '21gifts welcome',
};

/** A welcome gift paid to `Alice` earlier on the UTC day of {@link NOW_MS}. */
const WELCOME_TODAY: GiftRow = {
  paidAt: new Date('2026-09-20T08:00:00.000Z'),
  amountSats: 1000,
  recipientWosUser: 'Alice',
  kind: 'welcome',
};

describe('issueGiftInvoice', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setAddressRefKey(TOKEN);
    mockedDecode.mockReset();
    mockedDecode.mockReturnValue({ paymentHash: HASH, amountMsat: 1000 });
    mockedSpot.mockReset();
    mockedSpot.mockResolvedValue(null);
  });

  afterEach(() => {
    expect(warn.mock.calls.flat().join('\n')).not.toContain(ADDRESS);
    warn.mockRestore();
    setAddressRefKey(null);
    setDiagnosticSink(null);
  });

  it('returns 400 on a bad Lightning Address', async () => {
    const result = await issueGiftInvoice(actionDeps(), { address: 'nope', amountMsat: 1000 });
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'Not a valid Lightning Address (expected name@domain)',
    });
  });

  it('returns 400 when amountMsat is below the api minimum', async () => {
    const result = await issueGiftInvoice(actionDeps(), { address: ADDRESS, amountMsat: 1 });
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'Expected a JSON body with address and amountMsat',
    });
  });

  it('returns 400 when amountMsat is above the api maximum', async () => {
    const result = await issueGiftInvoice(actionDeps(), {
      address: ADDRESS,
      amountMsat: GIFT_INVOICE_MAX_MSAT + 1,
    });
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'Expected a JSON body with address and amountMsat',
    });
  });

  it('returns 403 when there is no account for the address', async () => {
    const result = await issueGiftInvoice(actionDeps({ fetchImpl: happyFetch() }), {
      address: ADDRESS,
      amountMsat: 1000,
    });
    expect(result).toEqual({ ok: false, status: 403, error: 'Passkey required' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.passkey_required')).toBe(true);
  });

  it('returns 403 when the account has no passkey credential', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount({
      id: 'acc-alice',
      username: 'alice',
      walletRequired: true,
      linkingKey: null,
      role: 'basis',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await verifyWallet(authStore);
    const result = await issueGiftInvoice(actionDeps({ authStore, fetchImpl: happyFetch() }), {
      address: ADDRESS,
      amountMsat: 1000,
    });
    expect(result).toEqual({ ok: false, status: 403, error: 'Passkey required' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.passkey_required')).toBe(true);
  });

  it('returns 403 when the account has a passkey but no funding grant', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const result = await issueGiftInvoice(
      actionDeps({
        authStore,
        messageStore: livePostStore(),
        fundingStore: new InMemoryFundingStore(),
        now: () => GATE_MS,
      }),
      { address: ADDRESS, amountMsat: 1000 },
    );
    expect(result).toEqual({ ok: false, status: 403, error: 'Funding grant required' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.funding_required')).toBe(true);
  });

  it('returns 403 when the account has a passkey but no live forum post', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const result = await issueGiftInvoice(actionDeps({ authStore }), {
      address: ADDRESS,
      amountMsat: 1000,
    });
    expect(result).toEqual({ ok: false, status: 403, error: 'Forum post required' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.forum_post_required')).toBe(true);
  });

  it('returns 403 when the account has a passkey but only a live reply', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const result = await issueGiftInvoice(
      actionDeps({ authStore, messageStore: liveReplyStore() }),
      { address: ADDRESS, amountMsat: 1000 },
    );
    expect(result).toEqual({ ok: false, status: 403, error: 'Forum post required' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.forum_post_required')).toBe(true);
  });

  it('returns 502 when LNURL-pay cannot issue an invoice', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const result = await issueGiftInvoice(
      actionDeps({
        authStore,
        messageStore: livePostStore(),
        fetchImpl: async () => jsonResponse({}, 500),
      }),
      { address: ADDRESS, amountMsat: 1000 },
    );
    expect(result).toEqual({
      ok: false,
      status: 502,
      error: 'Lightning Address did not issue an invoice',
    });
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.issue_failed')).toBe(true);
  });

  it('returns 502 when bolt11 decode fails', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    mockedDecode.mockReturnValue(null);
    const result = await issueGiftInvoice(
      actionDeps({ authStore, messageStore: livePostStore(), fetchImpl: happyFetch() }),
      { address: ADDRESS, amountMsat: 1000 },
    );
    expect(result).toEqual({
      ok: false,
      status: 502,
      error: 'Lightning Address did not issue an invoice',
    });
  });

  it('returns 502 when the invoice amount does not match', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    mockedDecode.mockReturnValue({ paymentHash: HASH, amountMsat: 999 });
    const result = await issueGiftInvoice(
      actionDeps({ authStore, messageStore: livePostStore(), fetchImpl: happyFetch() }),
      { address: ADDRESS, amountMsat: 1000 },
    );
    expect(result).toEqual({
      ok: false,
      status: 502,
      error: 'Lightning Address did not issue an invoice',
    });
  });

  it('returns the issued invoice with id, pr, paymentHash, amountMsat and stores it', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const store = new InMemoryInvoiceStore();
    const invoice = issuedInvoice(
      await issueGiftInvoice(
        actionDeps({ authStore, store, messageStore: livePostStore(), fetchImpl: happyFetch() }),
        { address: ADDRESS, amountMsat: 1000, comment: '21gifts daily' },
      ),
    );
    expect(invoice.pr).toBe(PR);
    expect(invoice.paymentHash).toBe(HASH);
    expect(invoice.amountMsat).toBe(1000);
    expect(invoice.id).toMatch(/^[0-9a-f]{32}$/);
    expect(invoice.address).toBe(ADDRESS);
    expect(invoice.comment).toBe('21gifts daily');
    expect(store.get(invoice.id)).toEqual(invoice);
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.issued')).toBe(true);
  });

  it('drops unpaid invoices past the sweep window before issuing', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const store = new InMemoryInvoiceStore();
    const deps = actionDeps({
      authStore,
      store,
      messageStore: livePostStore(),
      fetchImpl: happyFetch(),
    });
    const first = issuedInvoice(
      await issueGiftInvoice(deps, { address: ADDRESS, amountMsat: 1000 }),
    );
    const later = first.expiresAt + GIFT_INVOICE_TTL_MS;
    const second = issuedInvoice(
      await issueGiftInvoice({ ...deps, now: () => later }, { address: ADDRESS, amountMsat: 1000 }),
    );
    expect(store.get(first.id)).toBeUndefined();
    expect(store.get(second.id)).toEqual(second);
  });

  it('prints invoice.issued with addressRef and no address, and the sink keeps the address', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const sunk: Array<{ event: string; fields: Record<string, unknown> }> = [];
    setDiagnosticSink((event, fields) => {
      sunk.push({ event, fields: { ...fields } });
    });
    const result = await issueGiftInvoice(
      actionDeps({ authStore, messageStore: livePostStore(), fetchImpl: happyFetch() }),
      { address: ADDRESS, amountMsat: 1000 },
    );
    expect(result.ok).toBe(true);
    const line = parsedEvents(warn).find((e) => e['event'] === 'invoice.issued');
    expect(line?.['addressRef']).toBe(ADDRESS_REF);
    expect(line?.['amountMsat']).toBe(1000);
    expect('address' in (line ?? {})).toBe(false);
    const stored = sunk.find((row) => row.event === 'invoice.issued');
    expect(stored?.fields['address']).toBe(ADDRESS);
    expect('addressRef' in (stored?.fields ?? {})).toBe(false);
  });

  it('stores messageId and comment when issuing against a UUID post', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const store = new InMemoryInvoiceStore();
    const invoice = issuedInvoice(
      await issueGiftInvoice(
        actionDeps({
          authStore,
          messageStore: await uuidMediaPostStore(),
          store,
          fetchImpl: happyFetch(),
        }),
        { address: ADDRESS, amountMsat: 1000, messageId: POST_ID, comment: 'gm' },
      ),
    );
    expect(store.get(invoice.id)?.messageId).toBe(POST_ID);
    expect(store.get(invoice.id)?.comment).toBe('gm');
  });

  it('refuses a closed credit before the LNURL invoice is minted', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const messageStore = new InMemoryMessageStore();
    await messageStore.create(
      {
        id: POST_ID,
        accountId: 'acc-alice',
        name: 'Ada',
        text: 'closed credit',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        goalSats: 1000,
        goalRepayable: true,
        goalTermDays: 2,
        goalFundedAt: new Date('2026-08-02T00:00:00.000Z'),
        goalClosedAt: new Date('2026-08-03T00:00:00.000Z'),
      },
      JPEG,
    );
    const fetchImpl = vi.fn<FetchFn>(unexpectedFetch);
    const result = await issueGiftInvoice(actionDeps({ authStore, messageStore, fetchImpl }), {
      address: ADDRESS,
      amountMsat: 1000,
      messageId: POST_ID,
      comment: 'gm',
    });
    expect(result).toEqual({
      ok: false,
      status: 409,
      error: 'This credit no longer collects',
      code: 'credit_closed',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a closed credit before the recipient passkey gate', async () => {
    const authStore = new InMemoryAuthStore();
    await authStore.createAccount({
      id: 'acc-alice',
      username: 'alice',
      walletRequired: true,
      linkingKey: null,
      role: 'verified',
      name: 'Ada',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await verifyWallet(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(
      actionDeps({ authStore, messageStore: closedCreditStore(), fetchImpl }),
      { address: ADDRESS, amountMsat: 1000, messageId: POST_ID },
    );
    expect(result).toEqual({
      ok: false,
      status: 409,
      error: 'This credit no longer collects',
      code: 'credit_closed',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a closed credit before the recipient funding gate', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(
      actionDeps({
        authStore,
        messageStore: closedCreditStore(),
        fundingStore: new InMemoryFundingStore(),
        fetchImpl,
        now: () => GATE_MS,
      }),
      { address: ADDRESS, amountMsat: 1000, messageId: POST_ID },
    );
    expect(result).toEqual({
      ok: false,
      status: 409,
      error: 'This credit no longer collects',
      code: 'credit_closed',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a closed credit before the platform-account gate', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(
      actionDeps({ authStore, messageStore: closedCreditStore(), fetchImpl }),
      { address: ADDRESS, amountMsat: 1000, messageId: POST_ID },
    );
    expect(result).toEqual({
      ok: false,
      status: 409,
      error: 'This credit no longer collects',
      code: 'credit_closed',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('locks an uppercase gift body id until mint storage finishes before close', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const messageStore = new InMemoryMessageStore();
    await messageStore.create(
      {
        id: POST_ID,
        accountId: 'acc-alice',
        name: 'Ada',
        text: 'collecting credit',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        goalSats: 1_000,
        goalRepayable: true,
        goalTermDays: 2,
        goalFundedAt: null,
      },
      JPEG,
    );
    const store = new InMemoryInvoiceStore();
    let entered = (): void => undefined;
    const mintStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release = (): void => undefined;
    const mintGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl: FetchFn = async (input) => {
      if (String(input).includes('/.well-known/lnurlp/')) {
        return jsonResponse({
          callback: 'https://example.test/lnurlp/alice/invoice',
          minSendable: 1000,
          maxSendable: MAX_SENDABLE,
          commentAllowed: 255,
        });
      }
      entered();
      await mintGate;
      return jsonResponse({ pr: PR });
    };
    const issue = issueGiftInvoice(actionDeps({ authStore, messageStore, store, fetchImpl }), {
      address: ADDRESS,
      amountMsat: 1000,
      messageId: POST_ID.toUpperCase(),
    });
    await mintStarted;
    let closeFinished = false;
    const close = messageStore
      .closeCredit(POST_ID, new Date('2026-11-11T12:00:00.000Z'))
      .then((result) => {
        closeFinished = true;
        return result;
      });
    await Promise.resolve();
    expect(closeFinished).toBe(false);
    release();
    const invoice = issuedInvoice(await issue);
    expect(store.get(invoice.id)?.messageId).toBe(POST_ID);
    expect((await close)?.closedAt).toEqual(new Date('2026-11-11T12:00:00.000Z'));
  });

  it('stores an empty comment when messageId is set and comment is omitted', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const store = new InMemoryInvoiceStore();
    const invoice = issuedInvoice(
      await issueGiftInvoice(
        actionDeps({
          authStore,
          messageStore: await uuidMediaPostStore(),
          store,
          fetchImpl: happyFetch(),
        }),
        { address: ADDRESS, amountMsat: 1000, messageId: POST_ID },
      ),
    );
    expect(store.get(invoice.id)?.messageId).toBe(POST_ID);
    expect(store.get(invoice.id)?.comment).toBe('');
  });

  it('returns 200 when messageId is a live top-level photo post', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const store = new InMemoryInvoiceStore();
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const invoice = issuedInvoice(
      await issueGiftInvoice(
        actionDeps({ authStore, messageStore: await uuidMediaPostStore(), store, fetchImpl }),
        { address: ADDRESS, amountMsat: 1000, messageId: POST_ID },
      ),
    );
    expect(fetchImpl).toHaveBeenCalled();
    expect(store.get(invoice.id)?.messageId).toBe(POST_ID);
  });

  it('returns 200 when messageId has extra stills only', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const messageStore = await uuidMediaPostStore();
    const originalGet = messageStore.getById.bind(messageStore);
    messageStore.getById = async (id: string) => {
      const row = await originalGet(id);
      if (row === undefined) {
        return undefined;
      }
      return { ...row, hasPhoto: false, hasVideo: false, photoCount: 2 };
    };
    const result = await issueGiftInvoice(
      actionDeps({ authStore, messageStore, fetchImpl: happyFetch() }),
      { address: ADDRESS, amountMsat: 1000, messageId: POST_ID },
    );
    expect(result.ok).toBe(true);
  });

  it('records a welcome gift issued without messageId as welcome and refuses a second one', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const store = new InMemoryInvoiceStore();
    const { giftRecorder, recorded } = capturingRecorder();
    const deps = actionDeps({
      authStore,
      messageStore: livePostStore(),
      store,
      fetchImpl: happyFetch(),
      now: () => NOW_MS,
      giftRecorder,
    });
    const welcome = { address: ADDRESS, amountMsat: 1000, comment: 'Welcome' };
    const invoice = issuedInvoice(await issueGiftInvoice(deps, welcome));
    expect(store.get(invoice.id)?.comment).toBe('Welcome');
    expect(store.get(invoice.id)?.messageId).toBeUndefined();
    await settleProvenGift(deps, invoice, NOW_MS, SOURCE_WALLET, null);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      recipientWosUser: 'alice',
      kind: 'welcome',
      description: '21gifts welcome',
    });
    const again = await issueGiftInvoice(
      actionDeps({
        authStore,
        messageStore: livePostStore(),
        fetchImpl: happyFetch(),
        now: () => NOW_MS,
        giftStore: new InMemoryGiftStore(
          recorded.map((row) => ({
            paidAt: row.paidAt,
            amountSats: row.amountSats,
            recipientWosUser: row.recipientWosUser,
            kind: row.kind,
            description: row.description,
          })),
        ),
      }),
      welcome,
    );
    expect(again).toEqual({ ok: false, status: 409, error: 'Welcome gift already paid' });
  });

  it('pays a moderator payout with comment Welcome after the welcome gift, but not an ignored group id', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const conversationStore = new InMemoryConversationStore();
    await seedGroupTrigger(conversationStore);
    const { giftRecorder, recorded } = capturingRecorder();
    const deps = actionDeps({
      authStore,
      messageStore: livePostStore(),
      conversationStore,
      fetchImpl: happyFetch(),
      now: () => NOW_MS,
      giftStore: new InMemoryGiftStore([PAID_WELCOME]),
      giftRecorder,
    });
    const issue = (groupMessageId: string): Promise<IssueGiftInvoiceResult> =>
      issueGiftInvoice(deps, {
        address: ADDRESS,
        amountMsat: 1000,
        comment: 'Welcome',
        groupMessageId,
      });
    const invoice = issuedInvoice(await issue(GROUP_MSG_ID));
    await settleProvenGift(deps, invoice, NOW_MS, SOURCE_WALLET, null);
    expect(recorded[0]).toMatchObject({ kind: 'moderator', description: '21gifts moderator' });
    expect(await issue('99999999-9999-4999-8999-999999999999')).toEqual({
      ok: false,
      status: 409,
      error: 'Welcome gift already paid',
    });
  });

  it('stores normalized amountUsd and writes the passed USD snapshot on the proven moderator gift', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const store = new InMemoryInvoiceStore();
    const conversationStore = new InMemoryConversationStore();
    await seedGroupTrigger(conversationStore);
    const { giftRecorder, recorded } = capturingRecorder();
    const paidAt = Date.parse('2026-09-22T15:00:00.000Z');
    const deps = actionDeps({
      authStore,
      messageStore: livePostStore(),
      store,
      conversationStore,
      fetchImpl: happyFetch(),
      now: () => paidAt,
      giftRecorder,
    });
    const invoice = issuedInvoice(
      await issueGiftInvoice(deps, {
        address: ADDRESS,
        amountMsat: 1000,
        amountUsd: '5',
        groupMessageId: GROUP_MSG_ID,
      }),
    );
    expect(store.get(invoice.id)?.amountUsd).toBe('5.00');
    await settleProvenGift(
      deps,
      invoice,
      paidAt,
      SOURCE_WALLET,
      usdFiat(store.get(invoice.id)?.amountUsd ?? null),
    );
    expect(recorded[0]?.fiat?.usd).toBe('5.00');
    expect(recorded[0]?.fiat?.chf).toBeNull();
    const attached = await conversationStore.getMessageById(spendGroupGiftId(invoice.id));
    expect(attached?.amountUsd).toBe('5.00');
    expect(attached?.amountChf).toBeNull();
  });

  it('returns 400 when amountUsd cannot be normalized', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(
      actionDeps({ authStore, messageStore: livePostStore(), fetchImpl }),
      { address: ADDRESS, amountMsat: 1000, amountUsd: 'nope' },
    );
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'Expected a JSON body with address and amountMsat',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns 400 when messageId is not a UUID', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(
      actionDeps({ authStore, messageStore: uuidPostStore(), fetchImpl }),
      { address: ADDRESS, amountMsat: 1000, messageId: 'nope' },
    );
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'Expected a JSON body with address and amountMsat',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns 403 when messageId is an unknown UUID', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(
      actionDeps({ authStore, messageStore: uuidPostStore(), fetchImpl }),
      { address: ADDRESS, amountMsat: 1000, messageId: UNKNOWN_POST_ID },
    );
    expect(result).toEqual({ ok: false, status: 403, error: 'Forum post required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns 403 when messageId is a closed reply', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const messageStore = new InMemoryMessageStore([
      {
        id: POST_ID,
        accountId: 'acc-alice',
        name: 'Ada',
        text: 'first',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      {
        id: REPLY_ID,
        accountId: 'acc-alice',
        name: 'Ada',
        text: 'reply',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        parentId: POST_ID,
        goalClosedAt: new Date('2026-08-03T00:00:00.000Z'),
      },
    ]);
    const result = await issueGiftInvoice(actionDeps({ authStore, messageStore, fetchImpl }), {
      address: ADDRESS,
      amountMsat: 1000,
      messageId: REPLY_ID,
    });
    expect(result).toEqual({ ok: false, status: 403, error: 'Forum post required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns 403 when messageId is the account profile note', async () => {
    const authStore = new InMemoryAuthStore();
    await seedProfileAccountAndPlatform(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const messageStore = new InMemoryMessageStore([
      {
        id: POST_ID,
        accountId: 'acc-alice',
        name: 'Ada',
        text: 'first',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      {
        id: PROFILE_NOTE_ID,
        accountId: 'acc-alice',
        name: 'Ada',
        text: 'Ada',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
    ]);
    const result = await issueGiftInvoice(actionDeps({ authStore, messageStore, fetchImpl }), {
      address: ADDRESS,
      amountMsat: 1000,
      messageId: PROFILE_NOTE_ID,
    });
    expect(result).toEqual({ ok: false, status: 403, error: 'Forum post required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns 200 when messageId is a profile note that has a photo', async () => {
    const authStore = new InMemoryAuthStore();
    await seedProfileAccountAndPlatform(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const messageStore = new InMemoryMessageStore([
      {
        id: PROFILE_NOTE_ID,
        accountId: 'acc-alice',
        name: 'Ada',
        text: 'about',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
    ]);
    const result = await issueGiftInvoice(actionDeps({ authStore, messageStore, fetchImpl }), {
      address: ADDRESS,
      amountMsat: 1000,
      messageId: PROFILE_NOTE_ID,
      comment: 'Welcome',
    });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('returns 409 for a welcome invoice when the account already received the welcome gift', async () => {
    const authStore = new InMemoryAuthStore();
    await seedProfileAccountAndPlatform(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const messageStore = new InMemoryMessageStore([
      {
        id: PROFILE_NOTE_ID,
        accountId: 'acc-alice',
        name: 'Ada',
        text: 'about',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
      {
        id: 'welcome-reply',
        accountId: 'plat',
        name: '21.gifts',
        text: 'Welcome',
        createdAt: new Date('2026-08-02T00:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        parentId: PROFILE_NOTE_ID,
      },
    ]);
    const result = await issueGiftInvoice(actionDeps({ authStore, messageStore, fetchImpl }), {
      address: ADDRESS,
      amountMsat: 1000,
      messageId: PROFILE_NOTE_ID,
      comment: 'Welcome',
    });
    expect(result).toEqual({ ok: false, status: 409, error: 'Welcome gift already paid' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns 409 for a welcome invoice without messageId after a platform Welcome reply', async () => {
    const authStore = new InMemoryAuthStore();
    await seedProfileAccountAndPlatform(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const messageStore = new InMemoryMessageStore([
      {
        id: PROFILE_NOTE_ID,
        accountId: 'acc-alice',
        name: 'Ada',
        text: 'about',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
      {
        id: 'welcome-reply',
        accountId: 'plat',
        name: '21.gifts',
        text: 'Welcome',
        createdAt: new Date('2026-08-02T00:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        parentId: PROFILE_NOTE_ID,
      },
    ]);
    const result = await issueGiftInvoice(actionDeps({ authStore, messageStore, fetchImpl }), {
      address: ADDRESS,
      amountMsat: 1000,
      comment: 'Welcome',
    });
    expect(result).toEqual({ ok: false, status: 409, error: 'Welcome gift already paid' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns credit_closed before associating another account's closed post", async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    await authStore.createAccount({
      id: 'acc-bob',
      linkingKey: null,
      role: 'basis',
      name: 'Bob',
      forumLawsDismissed: false,
      location: null,
      viewKey: 'c'.repeat(64),
      createdAt: 3,
      rulesAgreedAt: null,
    });
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const messageStore = new InMemoryMessageStore([
      {
        id: POST_ID,
        accountId: 'acc-alice',
        name: 'Ada',
        text: 'first',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      },
      {
        id: OTHER_POST_ID,
        accountId: 'acc-bob',
        name: 'Bob',
        text: 'bob',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
        goalClosedAt: new Date('2026-08-03T00:00:00.000Z'),
      },
    ]);
    const result = await issueGiftInvoice(actionDeps({ authStore, messageStore, fetchImpl }), {
      address: ADDRESS,
      amountMsat: 1000,
      messageId: OTHER_POST_ID,
    });
    expect(result).toEqual({
      ok: false,
      status: 409,
      error: 'This credit no longer collects',
      code: 'credit_closed',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns credit_closed before the media gate for a closed text-only post', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const messageStore = new InMemoryMessageStore([
      {
        id: POST_ID,
        accountId: 'acc-alice',
        name: 'Ada',
        text: 'closed text-only credit',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        goalClosedAt: new Date('2026-08-03T00:00:00.000Z'),
      },
    ]);
    const result = await issueGiftInvoice(actionDeps({ authStore, messageStore, fetchImpl }), {
      address: ADDRESS,
      amountMsat: 1000,
      messageId: POST_ID,
    });
    expect(result).toEqual({
      ok: false,
      status: 409,
      error: 'This credit no longer collects',
      code: 'credit_closed',
    });
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.credit_closed')).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not expose credit_closed for a soft-deleted closed post', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const messageStore = closedCreditStore();
    await messageStore.markDeleted(POST_ID, new Date('2026-08-04T00:00:00.000Z'), 'moderator');
    const result = await issueGiftInvoice(actionDeps({ authStore, messageStore, fetchImpl }), {
      address: ADDRESS,
      amountMsat: 1000,
      messageId: POST_ID,
    });
    expect(result).toEqual({ ok: false, status: 403, error: 'Forum post required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns 503 when messageId is set and the platform account is missing', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const store = new InMemoryInvoiceStore();
    const putSpy = vi.spyOn(store, 'put');
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(
      actionDeps({ authStore, messageStore: await uuidMediaPostStore(), store, fetchImpl }),
      { address: ADDRESS, amountMsat: 1000, messageId: POST_ID },
    );
    expect(result).toEqual({
      ok: false,
      status: 503,
      error: 'Platform account is not configured',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('returns 409 for a welcome invoice when a welcome gift is recorded under the username', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const issue = (giftStore: InMemoryGiftStore): Promise<IssueGiftInvoiceResult> =>
      issueGiftInvoice(
        actionDeps({ authStore, messageStore: livePostStore(), giftStore, fetchImpl }),
        { address: ADDRESS, amountMsat: 1000, comment: 'Welcome' },
      );
    const refused = await issue(
      new InMemoryGiftStore([
        {
          paidAt: new Date(5),
          amountSats: 1,
          recipientWosUser: 'Alice',
          kind: 'welcome',
          description: '21gifts welcome',
        },
      ]),
    );
    expect(refused).toEqual({ ok: false, status: 409, error: 'Welcome gift already paid' });
    expect(fetchImpl).not.toHaveBeenCalled();
    const first = await issue(
      new InMemoryGiftStore([
        { paidAt: new Date(5), amountSats: 1, recipientWosUser: 'alice', kind: 'daily' },
        {
          paidAt: new Date(1),
          amountSats: 1,
          recipientWosUser: 'alice',
          kind: 'welcome',
          description: '21gifts welcome',
        },
        // A legacy welcome to another member's external address with the same local part.
        {
          paidAt: new Date(5),
          amountSats: 1,
          recipientWosUser: 'alice',
          kind: 'welcome',
          description: '21gifts daily',
        },
      ]),
    );
    expect(first.ok).toBe(true);
  });

  it('returns 409 for a welcome invoice when the legacy external address got the welcome gift', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(
      actionDeps({
        authStore,
        messageStore: livePostStore(),
        giftStore: new InMemoryGiftStore([], ['acc-alice']),
        fetchImpl,
      }),
      { address: ADDRESS, amountMsat: 1000, comment: 'Welcome' },
    );
    expect(result).toEqual({ ok: false, status: 409, error: 'Welcome gift already paid' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('checks the funding grant before the welcome gift', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const result = await issueGiftInvoice(
      actionDeps({
        authStore,
        messageStore: livePostStore(),
        giftStore: new InMemoryGiftStore([PAID_WELCOME]),
        fetchImpl: happyFetch(),
        fundingStore: new InMemoryFundingStore(),
        now: () => GATE_MS,
      }),
      { address: ADDRESS, amountMsat: 1000, comment: 'Welcome' },
    );
    expect(result).toEqual({ ok: false, status: 403, error: 'Funding grant required' });
  });

  it('returns 200 when messageId is omitted even without a platform account', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(
      actionDeps({ authStore, messageStore: livePostStore(), fetchImpl }),
      { address: ADDRESS, amountMsat: 1000 },
    );
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('stores groupMessageId and comment when issuing against a group message', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const conversationStore = new InMemoryConversationStore();
    await seedGroupTrigger(conversationStore);
    const store = new InMemoryInvoiceStore();
    const invoice = issuedInvoice(
      await issueGiftInvoice(
        actionDeps({
          authStore,
          messageStore: uuidPostStore(),
          store,
          fetchImpl: happyFetch(),
          conversationStore,
        }),
        {
          address: ADDRESS,
          amountMsat: 1000,
          groupMessageId: GROUP_MSG_ID,
          comment: '21gifts moderator',
        },
      ),
    );
    expect(store.get(invoice.id)?.groupMessageId).toBe(GROUP_MSG_ID);
    expect(store.get(invoice.id)?.comment).toBe('21gifts moderator');
  });

  it('ignores a software developer groupMessageId and never records a moderator payout', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const sender = await authStore.getAccount('acc-alice');
    if (sender === undefined) {
      throw new Error('expected seeded sender');
    }
    await authStore.updateAccount({ ...sender, role: 'software_developer' });
    const conversationStore = new InMemoryConversationStore();
    await seedGroupTrigger(conversationStore);
    const store = new InMemoryInvoiceStore();
    const { giftRecorder, recorded } = capturingRecorder();
    const overrides: Partial<GiftActionDeps> = {
      authStore,
      messageStore: uuidPostStore(),
      fetchImpl: happyFetch(),
      conversationStore,
      now: () => NOW_MS,
      giftRecorder,
    };
    const deps = actionDeps({ ...overrides, store });
    const input = {
      address: ADDRESS,
      amountMsat: 1000,
      groupMessageId: GROUP_MSG_ID,
      comment: 'Welcome',
    };
    const invoice = issuedInvoice(await issueGiftInvoice(deps, input));
    expect(store.get(invoice.id)?.groupMessageId).toBeUndefined();
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'invoice.group_message_ignored' && e['addressRef'] === ADDRESS_REF,
      ),
    ).toBe(true);
    await settleProvenGift(deps, invoice, NOW_MS, SOURCE_WALLET, null);
    expect(recorded[0]?.kind).toBe('welcome');
    expect(recorded.some((row) => row.kind === 'moderator')).toBe(false);

    const refused = await issueGiftInvoice(
      actionDeps({ ...overrides, giftStore: new InMemoryGiftStore([PAID_WELCOME]) }),
      input,
    );
    expect(refused).toEqual({ ok: false, status: 409, error: 'Welcome gift already paid' });
    expect(recorded.some((row) => row.kind === 'moderator')).toBe(false);
  });

  it('stores an empty comment when groupMessageId is set and comment is omitted', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const conversationStore = new InMemoryConversationStore();
    await seedGroupTrigger(conversationStore);
    const store = new InMemoryInvoiceStore();
    const invoice = issuedInvoice(
      await issueGiftInvoice(
        actionDeps({
          authStore,
          messageStore: uuidPostStore(),
          store,
          fetchImpl: happyFetch(),
          conversationStore,
        }),
        { address: ADDRESS, amountMsat: 1000, groupMessageId: GROUP_MSG_ID },
      ),
    );
    expect(store.get(invoice.id)?.groupMessageId).toBe(GROUP_MSG_ID);
    expect(store.get(invoice.id)?.comment).toBe('');
  });

  it('returns 400 when groupMessageId is not a UUID', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(
      actionDeps({ authStore, messageStore: uuidPostStore(), fetchImpl }),
      { address: ADDRESS, amountMsat: 1000, groupMessageId: 'nope' },
    );
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'Expected a JSON body with address and amountMsat',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns 400 when both messageId and groupMessageId are set', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(
      actionDeps({ authStore, messageStore: uuidPostStore(), fetchImpl }),
      { address: ADDRESS, amountMsat: 1000, messageId: POST_ID, groupMessageId: GROUP_MSG_ID },
    );
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'Expected a JSON body with address and amountMsat',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe('an unresolved groupMessageId', () => {
    async function issueIgnored(
      overrides: Partial<GiftActionDeps>,
      seedPlatform = true,
    ): Promise<void> {
      const authStore = new InMemoryAuthStore();
      if (seedPlatform) {
        await seedPasskeyAndPlatform(authStore);
      } else {
        await seedPasskeyAccount(authStore);
      }
      const store = new InMemoryInvoiceStore();
      const deps = actionDeps({
        authStore,
        messageStore: uuidPostStore(),
        store,
        fetchImpl: happyFetch(),
        ...overrides,
      });
      if (!('conversationStore' in overrides)) {
        delete deps.conversationStore;
      }
      const invoice = issuedInvoice(
        await issueGiftInvoice(deps, {
          address: ADDRESS,
          amountMsat: 1000,
          groupMessageId: GROUP_MSG_ID,
        }),
      );
      expect(store.get(invoice.id)).toBeDefined();
      expect(store.get(invoice.id)?.groupMessageId).toBeUndefined();
      expect(
        parsedEvents(warn).some(
          (e) => e['event'] === 'invoice.group_message_ignored' && e['addressRef'] === ADDRESS_REF,
        ),
      ).toBe(true);
    }

    it('returns 200 and ignores an unknown groupMessageId', async () => {
      const conversationStore = new InMemoryConversationStore();
      await seedGroupTrigger(conversationStore, 'acc-alice', OTHER_GROUP_MSG_ID);
      await issueIgnored({ conversationStore });
    });

    it('returns 200 and ignores a groupMessageId outside the moderator group', async () => {
      const conversationStore = new InMemoryConversationStore();
      await seedNonGroupTrigger(conversationStore);
      await issueIgnored({ conversationStore });
    });

    it('returns 200 and ignores a groupMessageId from another sender', async () => {
      const conversationStore = new InMemoryConversationStore();
      await seedGroupTrigger(conversationStore, 'someone-else');
      await issueIgnored({ conversationStore });
    });

    it('returns 200 and ignores groupMessageId when no conversation store is wired', async () => {
      await issueIgnored({ now: () => 1 });
    });

    it('returns 200 and ignores groupMessageId when the conversation lookup throws', async () => {
      const conversationStore: Pick<
        ConversationStore,
        'getById' | 'getMessageById' | 'appendMessage'
      > = {
        getById: () => Promise.resolve(undefined),
        getMessageById: () => Promise.reject(new Error('db')),
        appendMessage: () => Promise.reject(new Error('db')),
      };
      await issueIgnored({ conversationStore, now: () => 1 });
    });

    it('returns 200 and ignores groupMessageId when the platform account is missing', async () => {
      const conversationStore = new InMemoryConversationStore();
      await seedGroupTrigger(conversationStore);
      await issueIgnored({ conversationStore }, false);
    });
  });

  it('returns 403 when groupMessageId is set but the account has no live forum post', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const conversationStore = new InMemoryConversationStore();
    await seedGroupTrigger(conversationStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(
      actionDeps({
        authStore,
        messageStore: new InMemoryMessageStore([]),
        fetchImpl,
        conversationStore,
      }),
      { address: ADDRESS, amountMsat: 1000, groupMessageId: GROUP_MSG_ID },
    );
    expect(result).toEqual({ ok: false, status: 403, error: 'Forum post required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns 403 when a welcome gift was already paid today', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(
      actionDeps({
        authStore,
        messageStore: livePostStore(),
        fetchImpl,
        giftStore: new InMemoryGiftStore([WELCOME_TODAY]),
        now: () => NOW_MS,
      }),
      { address: ADDRESS, amountMsat: 1000, comment: '21gifts daily' },
    );
    expect(result).toEqual({ ok: false, status: 403, error: 'Welcome gift already paid' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'invoice.welcome_paid' && e['addressRef'] === ADDRESS_REF,
      ),
    ).toBe(true);
  });

  it('returns 200 when the comment is Welcome even if a welcome gift was paid today', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(
      actionDeps({
        authStore,
        messageStore: livePostStore(),
        fetchImpl,
        giftStore: new InMemoryGiftStore([WELCOME_TODAY]),
        now: () => NOW_MS,
      }),
      { address: ADDRESS, amountMsat: 1000, comment: 'Welcome' },
    );
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('stores comment Welcome without messageId or groupMessageId and records kind welcome', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const store = new InMemoryInvoiceStore();
    const { giftRecorder, recorded } = capturingRecorder();
    const deps = actionDeps({
      authStore,
      messageStore: livePostStore(),
      store,
      fetchImpl: happyFetch(),
      giftStore: new InMemoryGiftStore([WELCOME_TODAY]),
      now: () => NOW_MS,
      giftRecorder,
    });
    const invoice = issuedInvoice(
      await issueGiftInvoice(deps, { address: ADDRESS, amountMsat: 1000, comment: 'Welcome' }),
    );
    const row = store.get(invoice.id);
    expect(row?.comment).toBe('Welcome');
    expect(row?.messageId).toBeUndefined();
    expect(row?.groupMessageId).toBeUndefined();
    await settleProvenGift(deps, invoice, NOW_MS, SOURCE_WALLET, null);
    expect(recorded[0]?.kind).toBe('welcome');
  });

  it('stores comment Welcome when groupMessageId is stored', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const conversationStore = new InMemoryConversationStore();
    await seedGroupTrigger(conversationStore);
    const store = new InMemoryInvoiceStore();
    const invoice = issuedInvoice(
      await issueGiftInvoice(
        actionDeps({
          authStore,
          messageStore: uuidPostStore(),
          store,
          fetchImpl: happyFetch(),
          conversationStore,
        }),
        { address: ADDRESS, amountMsat: 1000, groupMessageId: GROUP_MSG_ID, comment: 'Welcome' },
      ),
    );
    expect(store.get(invoice.id)?.groupMessageId).toBe(GROUP_MSG_ID);
    expect(store.get(invoice.id)?.comment).toBe('Welcome');
    expect(store.get(invoice.id)?.messageId).toBeUndefined();
  });

  it('returns 200 when groupMessageId is set even if a welcome gift was paid today', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const conversationStore = new InMemoryConversationStore();
    await seedGroupTrigger(conversationStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(
      actionDeps({
        authStore,
        messageStore: uuidPostStore(),
        fetchImpl,
        conversationStore,
        giftStore: new InMemoryGiftStore([WELCOME_TODAY]),
        now: () => NOW_MS,
      }),
      {
        address: ADDRESS,
        amountMsat: 1000,
        groupMessageId: GROUP_MSG_ID,
        comment: '21gifts moderator',
      },
    );
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('returns 403 when an unresolved groupMessageId follows a welcome gift paid today', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const conversationStore = new InMemoryConversationStore();
    await seedGroupTrigger(conversationStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(
      actionDeps({
        authStore,
        messageStore: uuidPostStore(),
        fetchImpl,
        conversationStore,
        giftStore: new InMemoryGiftStore([WELCOME_TODAY]),
        now: () => NOW_MS,
      }),
      {
        address: ADDRESS,
        amountMsat: 1000,
        groupMessageId: OTHER_GROUP_MSG_ID,
        comment: '21gifts daily',
      },
    );
    expect(result).toEqual({ ok: false, status: 403, error: 'Welcome gift already paid' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'invoice.welcome_paid' && e['addressRef'] === ADDRESS_REF,
      ),
    ).toBe(true);
  });

  it('returns 200 when the welcome gift was paid on the previous UTC day', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(
      actionDeps({
        authStore,
        messageStore: livePostStore(),
        fetchImpl,
        giftStore: new InMemoryGiftStore([
          { ...WELCOME_TODAY, paidAt: new Date('2026-09-19T08:00:00.000Z') },
        ]),
        now: () => NOW_MS,
      }),
      { address: ADDRESS, amountMsat: 1000, comment: '21gifts daily' },
    );
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('returns 503 when the gift ledger cannot be listed', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(
      actionDeps({
        authStore,
        messageStore: livePostStore(),
        fetchImpl,
        gifts: { listOutbound: () => Promise.reject(new Error('ledger down')) },
        now: () => NOW_MS,
      }),
      { address: ADDRESS, amountMsat: 1000, comment: '21gifts daily' },
    );
    expect(result).toEqual({ ok: false, status: 503, error: 'Gift ledger unreadable' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('settleProvenGift', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  function unpaid(overrides?: Partial<GiftInvoice>): GiftInvoice {
    return {
      id: 'ab'.repeat(16),
      address: ADDRESS,
      pr: PR,
      paymentHash: HASH,
      amountMsat: 1000,
      createdAt: 1,
      expiresAt: 1_000_000,
      ...overrides,
    };
  }

  /** A message store whose `method` is replaced and every other method is bound to `inner`. */
  function overriding<K extends keyof InMemoryMessageStore>(
    inner: InMemoryMessageStore,
    method: K,
    replacement: InMemoryMessageStore[K],
  ): InMemoryMessageStore {
    return new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === method) {
          return replacement;
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...args: never[]) => unknown).bind(target)
          : value;
      },
    });
  }

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    expect(warn.mock.calls.flat().join('\n')).not.toContain(ADDRESS);
    warn.mockRestore();
  });

  it('records a daily gift row with the paying wallet and the passed fiat', async () => {
    const { giftRecorder, recorded } = capturingRecorder();
    await settleProvenGift(
      actionDeps({ giftRecorder }),
      unpaid(),
      PAID_AT_MS,
      SOURCE_WALLET,
      usdFiat('0.50'),
    );
    expect(recorded).toEqual([
      {
        paidAt: new Date(PAID_AT_MS),
        amountSats: 1,
        feeSats: 0,
        recipientWosUser: 'alice',
        lightningInvoice: PR,
        description: '21gifts daily',
        kind: 'daily',
        sourceWallet: SOURCE_WALLET,
        fiat: usdFiat('0.50'),
      },
    ]);
  });

  it('records kind welcome when the comment is Welcome and groupMessageId is unset', async () => {
    const { giftRecorder, recorded } = capturingRecorder();
    await settleProvenGift(
      actionDeps({ giftRecorder }),
      unpaid({ comment: 'Welcome' }),
      PAID_AT_MS,
      SOURCE_WALLET,
      null,
    );
    expect(recorded).toEqual([
      {
        paidAt: new Date(PAID_AT_MS),
        amountSats: 1,
        feeSats: 0,
        recipientWosUser: 'alice',
        lightningInvoice: PR,
        description: '21gifts welcome',
        kind: 'welcome',
        sourceWallet: SOURCE_WALLET,
        fiat: null,
      },
    ]);
  });

  it('records 21gifts moderator as the gift description when groupMessageId is set', async () => {
    const { giftRecorder, recorded } = capturingRecorder();
    await settleProvenGift(
      actionDeps({ giftRecorder }),
      unpaid({ groupMessageId: GROUP_MSG_ID }),
      PAID_AT_MS,
      SOURCE_WALLET,
      null,
    );
    expect(recorded).toEqual([
      {
        paidAt: new Date(PAID_AT_MS),
        amountSats: 1,
        feeSats: 0,
        recipientWosUser: 'alice',
        lightningInvoice: PR,
        description: '21gifts moderator',
        kind: 'moderator',
        sourceWallet: SOURCE_WALLET,
        fiat: null,
      },
    ]);
  });

  it('records the decided kind when a kind override is passed', async () => {
    const { giftRecorder, recorded } = capturingRecorder();
    await settleProvenGift(
      actionDeps({ giftRecorder }),
      unpaid({ comment: '21gifts daily' }),
      PAID_AT_MS,
      SOURCE_WALLET,
      null,
      'welcome',
    );
    expect(recorded[0]).toMatchObject({ kind: 'welcome', description: '21gifts welcome' });
  });

  it('settles without a gift recorder', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const messageStore = uuidPostStore();
    await settleProvenGift(
      actionDeps({ authStore, messageStore }),
      unpaid({ messageId: POST_ID, comment: 'gm' }),
      PAID_AT_MS,
      SOURCE_WALLET,
      null,
    );
    expect((await messageStore.getById(POST_ID))?.sats).toBe(1);
  });

  it('logs gifts.record_failed and still settles when gift recording fails', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const messageStore = uuidPostStore();
    await settleProvenGift(
      actionDeps({
        authStore,
        messageStore,
        giftRecorder: {
          recordOutbound: async () => {
            throw new Error('db');
          },
        },
      }),
      unpaid({ messageId: POST_ID, comment: 'gm' }),
      PAID_AT_MS,
      SOURCE_WALLET,
      null,
    );
    expect(parsedEvents(warn)).toContainEqual(
      expect.objectContaining({ event: 'gifts.record_failed', id: unpaid().id }),
    );
    expect((await messageStore.getById(POST_ID))?.sats).toBe(1);
  });

  it('attaches a platform gift-reply and addSats when the invoice has messageId', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const messageStore = uuidPostStore();
    await settleProvenGift(
      actionDeps({ authStore, messageStore }),
      unpaid({ messageId: POST_ID, comment: 'gm', amountMsat: 1000 }),
      PAID_AT_MS,
      SOURCE_WALLET,
      null,
    );
    expect((await messageStore.getById(POST_ID))?.sats).toBe(1);
    const replies = await messageStore.listReplies(POST_ID, 200);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.id).toBe(spendGiftReplyId(unpaid().id));
    expect(replies[0]?.accountId).toBe('plat');
    expect(replies[0]?.name).toBe('21.gifts');
    expect(replies[0]?.parentId).toBe(POST_ID);
    expect(replies[0]?.sats).toBe(1);
    expect(replies[0]?.text).toBe('gm');
    expect(replies[0]?.createdAt.getTime()).toBe(PAID_AT_MS);
    expect(replies[0]?.nostrPublishState).toBe('pending');
  });

  it('writes the fiat snapshot to the gift row, the gift-reply, and the post credit', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const messageStore = uuidPostStore();
    const { giftRecorder, recorded } = capturingRecorder();
    const fiat: FiatAmounts = { usd: '5.00', chf: '4.00', eur: '4.50', php: '250' };
    await settleProvenGift(
      actionDeps({ authStore, messageStore, giftRecorder }),
      unpaid({ messageId: POST_ID, comment: 'gm' }),
      PAID_AT_MS,
      SOURCE_WALLET,
      fiat,
    );
    expect(recorded[0]?.fiat).toEqual(fiat);
    const reply = await messageStore.getById(spendGiftReplyId(unpaid().id));
    expect(reply?.amountUsd).toBe('5.00');
    expect(reply?.amountChf).toBe('4.00');
    const post = await messageStore.getById(POST_ID);
    expect(post?.amountUsd).toBe('5.00');
    expect(post?.amountEur).toBe('4.50');
  });

  it('addReceivedSats a reply invoice without creating a nested gift-reply', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const messageStore = uuidReplyStore();
    await settleProvenGift(
      actionDeps({ authStore, messageStore }),
      unpaid({ messageId: REPLY_ID, comment: 'gm', amountMsat: 1000 }),
      PAID_AT_MS,
      SOURCE_WALLET,
      usdFiat('0.50'),
    );
    expect((await messageStore.getById(REPLY_ID))?.sats).toBe(0);
    expect((await messageStore.getById(REPLY_ID))?.receivedSats).toBe(1);
    expect((await messageStore.getById(REPLY_ID))?.receivedAmountUsd).toBe('0.50');
    expect(await messageStore.listReplies(REPLY_ID, 200)).toEqual([]);
    expect(await messageStore.listReplies(POST_ID, 200)).toHaveLength(1);
    const marker = await messageStore.getById(spendGiftReplyId(unpaid().id));
    expect(marker).toBeDefined();
    expect(marker?.deletedAt).not.toBeNull();
    expect(marker?.deletedBy).toBe('plat');
    expect(marker?.parentId).toBe(REPLY_ID);
    expect(marker?.nostrPublishState).toBe('skipped');
  });

  it('does not double addSats or create a second gift-reply when settled twice', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const messageStore = uuidPostStore();
    const deps = actionDeps({ authStore, messageStore });
    const invoice = unpaid({ messageId: POST_ID, comment: 'gm', amountMsat: 1000 });
    await settleProvenGift(deps, invoice, PAID_AT_MS, SOURCE_WALLET, null);
    await settleProvenGift(deps, invoice, PAID_AT_MS, SOURCE_WALLET, null);
    expect((await messageStore.getById(POST_ID))?.sats).toBe(1);
    expect(await messageStore.listReplies(POST_ID, 200)).toHaveLength(1);
  });

  it('does not double addReceivedSats or create a gift-reply when a reply invoice is settled twice', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const messageStore = uuidReplyStore();
    const deps = actionDeps({ authStore, messageStore });
    const invoice = unpaid({ messageId: REPLY_ID, comment: 'gm', amountMsat: 1000 });
    await settleProvenGift(deps, invoice, PAID_AT_MS, SOURCE_WALLET, null);
    expect((await messageStore.getById(REPLY_ID))?.sats).toBe(0);
    expect((await messageStore.getById(REPLY_ID))?.receivedSats).toBe(1);
    await settleProvenGift(deps, invoice, PAID_AT_MS, SOURCE_WALLET, null);
    expect((await messageStore.getById(REPLY_ID))?.sats).toBe(0);
    expect((await messageStore.getById(REPLY_ID))?.receivedSats).toBe(1);
    expect(await messageStore.listReplies(REPLY_ID, 200)).toEqual([]);
    expect(await messageStore.listReplies(POST_ID, 200)).toHaveLength(1);
  });

  it('skips nostr publish when the gift-reply comment is empty', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const messageStore = uuidPostStore();
    await settleProvenGift(
      actionDeps({ authStore, messageStore }),
      unpaid({ messageId: POST_ID, comment: '', amountMsat: 1000 }),
      PAID_AT_MS,
      SOURCE_WALLET,
      null,
    );
    const replies = await messageStore.listReplies(POST_ID, 200);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toBe('');
    expect(replies[0]?.nostrPublishState).toBe('skipped');
  });

  it('treats a missing invoice comment as empty gift-reply text', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const messageStore = uuidPostStore();
    await settleProvenGift(
      actionDeps({ authStore, messageStore }),
      unpaid({ messageId: POST_ID, amountMsat: 1000 }),
      PAID_AT_MS,
      SOURCE_WALLET,
      null,
    );
    const replies = await messageStore.listReplies(POST_ID, 200);
    expect(replies[0]?.text).toBe('');
    expect(replies[0]?.nostrPublishState).toBe('skipped');
  });

  it.each([
    ['null', null],
    ['blank', '   '],
  ])('names the gift-reply 21.gifts when the platform name is %s', async (_label, name) => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    await authStore.createAccount({
      id: 'plat',
      linkingKey: null,
      role: 'founder',
      name,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'b'.repeat(64),
      createdAt: 2,
      rulesAgreedAt: null,
      isPlatform: true,
    });
    const messageStore = uuidPostStore();
    await settleProvenGift(
      actionDeps({ authStore, messageStore }),
      unpaid({ messageId: POST_ID, comment: 'gm', amountMsat: 1000 }),
      PAID_AT_MS,
      SOURCE_WALLET,
      null,
    );
    expect((await messageStore.listReplies(POST_ID, 200))[0]?.name).toBe('21.gifts');
  });

  it('logs invoice.gift_reply.failed when the parent is missing', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const messageStore = new InMemoryMessageStore();
    await settleProvenGift(
      actionDeps({ authStore, messageStore }),
      unpaid({ messageId: POST_ID, comment: 'gm', amountMsat: 1000 }),
      PAID_AT_MS,
      SOURCE_WALLET,
      null,
    );
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.gift_reply.failed')).toBe(true);
    expect(await messageStore.listReplies(POST_ID, 200)).toHaveLength(0);
  });

  it('logs invoice.gift_reply.failed when the parent is deleted', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const messageStore = uuidPostStore();
    await messageStore.markDeleted(POST_ID, new Date(50), 'mod');
    await settleProvenGift(
      actionDeps({ authStore, messageStore }),
      unpaid({ messageId: POST_ID, comment: 'gm', amountMsat: 1000 }),
      PAID_AT_MS,
      SOURCE_WALLET,
      null,
    );
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.gift_reply.failed')).toBe(true);
    expect(await messageStore.listReplies(POST_ID, 200)).toHaveLength(0);
  });

  it('logs invoice.gift_reply.failed when the platform is missing at settlement', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const messageStore = uuidPostStore();
    await settleProvenGift(
      actionDeps({ authStore, messageStore }),
      unpaid({ messageId: POST_ID, comment: 'gm', amountMsat: 1000 }),
      PAID_AT_MS,
      SOURCE_WALLET,
      null,
    );
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.gift_reply.failed')).toBe(true);
    expect(await messageStore.listReplies(POST_ID, 200)).toHaveLength(0);
    expect((await messageStore.getById(POST_ID))?.sats).toBe(0);
  });

  it('creates no forum reply when the proven invoice has no messageId', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const messageStore = uuidPostStore();
    await settleProvenGift(
      actionDeps({ authStore, messageStore }),
      unpaid(),
      PAID_AT_MS,
      SOURCE_WALLET,
      null,
    );
    expect(await messageStore.listReplies(POST_ID, 200)).toHaveLength(0);
    expect((await messageStore.getById(POST_ID))?.sats).toBe(0);
  });

  it('logs invoice.gift_reply.failed when addSats throws', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const inner = uuidPostStore();
    const messageStore = overriding(inner, 'addSats', async () => {
      throw new Error('addSats');
    });
    await settleProvenGift(
      actionDeps({ authStore, messageStore }),
      unpaid({ messageId: POST_ID, comment: 'gm', amountMsat: 1000 }),
      PAID_AT_MS,
      SOURCE_WALLET,
      null,
    );
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.gift_reply.failed')).toBe(true);
    expect(await inner.listReplies(POST_ID, 200)).toHaveLength(1);
    expect((await inner.getById(POST_ID))?.sats).toBe(0);
  });

  it('does not addSats when create throws, then credits once on retry', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const inner = uuidPostStore();
    let createCalls = 0;
    const messageStore = overriding(
      inner,
      'create',
      async (row: Parameters<InMemoryMessageStore['create']>[0]) => {
        createCalls += 1;
        if (createCalls === 1) {
          throw new Error('create');
        }
        return inner.create(row);
      },
    );
    const deps = actionDeps({ authStore, messageStore });
    const invoice = unpaid({ messageId: POST_ID, comment: 'gm', amountMsat: 1000 });
    await settleProvenGift(deps, invoice, PAID_AT_MS, SOURCE_WALLET, null);
    expect((await inner.getById(POST_ID))?.sats).toBe(0);
    await settleProvenGift(deps, invoice, PAID_AT_MS, SOURCE_WALLET, null);
    expect((await inner.getById(POST_ID))?.sats).toBe(1);
    expect(await inner.listReplies(POST_ID, 200)).toHaveLength(1);
  });

  it('does not addSats when create throws on a reply invoice, then credits once on retry', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const inner = uuidReplyStore();
    let createCalls = 0;
    const messageStore = overriding(
      inner,
      'create',
      async (row: Parameters<InMemoryMessageStore['create']>[0]) => {
        createCalls += 1;
        if (createCalls === 1) {
          throw new Error('create');
        }
        return inner.create(row);
      },
    );
    const deps = actionDeps({ authStore, messageStore });
    const invoice = unpaid({ messageId: REPLY_ID, comment: 'gm', amountMsat: 1000 });
    await settleProvenGift(deps, invoice, PAID_AT_MS, SOURCE_WALLET, null);
    expect((await inner.getById(REPLY_ID))?.sats).toBe(0);
    expect((await inner.getById(REPLY_ID))?.receivedSats).toBe(0);
    await settleProvenGift(deps, invoice, PAID_AT_MS, SOURCE_WALLET, null);
    expect((await inner.getById(REPLY_ID))?.sats).toBe(0);
    expect((await inner.getById(REPLY_ID))?.receivedSats).toBe(1);
    expect(await inner.listReplies(REPLY_ID, 200)).toEqual([]);
    const marker = await inner.getById(spendGiftReplyId(invoice.id));
    expect(marker).toBeDefined();
    expect(marker?.deletedAt).not.toBeNull();
  });

  it('hides a live reply marker on retry without addSats when markDeleted throws after create', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const inner = uuidReplyStore();
    let markDeletedCalls = 0;
    const messageStore = overriding(
      inner,
      'markDeleted',
      async (id: string, at: Date, byAccountId: string) => {
        markDeletedCalls += 1;
        if (markDeletedCalls === 1) {
          throw new Error('markDeleted');
        }
        return inner.markDeleted(id, at, byAccountId);
      },
    );
    const deps = actionDeps({ authStore, messageStore });
    const invoice = unpaid({ messageId: REPLY_ID, comment: 'gm', amountMsat: 1000 });
    await settleProvenGift(deps, invoice, PAID_AT_MS, SOURCE_WALLET, null);
    expect((await inner.getById(REPLY_ID))?.sats).toBe(0);
    const markerId = spendGiftReplyId(invoice.id);
    const liveMarker = await inner.getById(markerId);
    expect(liveMarker).toBeDefined();
    expect(liveMarker?.deletedAt).toBeNull();
    expect(await inner.listReplies(REPLY_ID, 200)).toHaveLength(1);
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.gift_reply.failed')).toBe(true);
    await settleProvenGift(deps, invoice, PAID_AT_MS, SOURCE_WALLET, null);
    expect((await inner.getById(REPLY_ID))?.sats).toBe(0);
    expect((await inner.getById(REPLY_ID))?.receivedSats).toBe(0);
    expect(await inner.listReplies(REPLY_ID, 200)).toEqual([]);
    const hidden = await inner.getById(markerId);
    expect(hidden?.deletedAt).not.toBeNull();
  });

  it('attaches a platform group stipend with comment and recipient name', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const conversationStore = new InMemoryConversationStore();
    const threadId = await seedGroupTrigger(conversationStore);
    await settleProvenGift(
      actionDeps({ authStore, conversationStore }),
      unpaid({ groupMessageId: GROUP_MSG_ID, comment: '21gifts moderator' }),
      PAID_AT_MS,
      SOURCE_WALLET,
      null,
    );
    const attached = await conversationStore.getMessageById(spendGroupGiftId(unpaid().id));
    expect(attached).toBeDefined();
    expect(attached?.conversationId).toBe(threadId);
    expect(attached?.senderAccountId).toBe('plat');
    expect(attached?.name).toBe('21.gifts');
    expect(attached?.sats).toBe(Math.floor(unpaid().amountMsat / 1000));
    expect(attached?.text).toBe('21gifts moderator · Ada');
    expect(attached?.createdAt.getTime()).toBe(PAID_AT_MS);
    expect(attached?.nostrPublishState).toBe('skipped');
    expect(attached?.eventId).toBeNull();
    expect(attached?.nostrEvent).toBeNull();
    expect(attached?.claimedUntil).toBeNull();
    expect(attached?.giftForMessageId).toBe(GROUP_MSG_ID);
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'invoice.group_gift.attached' && e['id'] === unpaid().id,
      ),
    ).toBe(true);
  });

  it('falls back to 21.gifts when the platform account has no name', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const platform = await authStore.getAccount('plat');
    expect(platform).toBeDefined();
    if (platform === undefined) {
      return;
    }
    const conversationStore = new InMemoryConversationStore();
    await seedGroupTrigger(conversationStore);
    for (const [index, name] of ['  ', null].entries()) {
      await authStore.updateAccount({ ...platform, name });
      const invoice = unpaid({
        id: `${index}`.padStart(32, 'a'),
        groupMessageId: GROUP_MSG_ID,
        comment: '21gifts moderator',
      });
      await settleProvenGift(
        actionDeps({ authStore, conversationStore }),
        invoice,
        PAID_AT_MS,
        SOURCE_WALLET,
        null,
      );
      const attached = await conversationStore.getMessageById(spendGroupGiftId(invoice.id));
      expect(attached?.name).toBe('21.gifts');
    }
  });

  it.each([
    [
      'comment-only text when the recipient name is empty',
      null,
      '21gifts moderator',
      '21gifts moderator',
    ],
    ['recipient-name-only text when comment is empty', 'Ada', undefined, 'Ada'],
    ['empty text when comment and recipient name are empty', '  ', undefined, ''],
  ])('attaches a group stipend with %s', async (_label, recipientName, comment, text) => {
    const authStore = new InMemoryAuthStore();
    await seedNamedRecipientAndPlatform(authStore, recipientName);
    const conversationStore = new InMemoryConversationStore();
    await seedGroupTrigger(conversationStore);
    await settleProvenGift(
      actionDeps({ authStore, conversationStore }),
      unpaid({
        groupMessageId: GROUP_MSG_ID,
        ...(comment === undefined ? {} : { comment }),
      }),
      PAID_AT_MS,
      SOURCE_WALLET,
      null,
    );
    const attached = await conversationStore.getMessageById(spendGroupGiftId(unpaid().id));
    expect(attached?.text).toBe(text);
    expect(attached?.giftForMessageId).toBe(GROUP_MSG_ID);
  });

  it('attaches the group stipend without a recipient on another domain', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const conversationStore = new InMemoryConversationStore();
    await seedGroupTrigger(conversationStore);
    await settleProvenGift(
      actionDeps({ authStore, conversationStore }),
      unpaid({
        address: 'alice@other.test',
        groupMessageId: GROUP_MSG_ID,
        comment: '21gifts moderator',
      }),
      PAID_AT_MS,
      SOURCE_WALLET,
      null,
    );
    const attached = await conversationStore.getMessageById(spendGroupGiftId(unpaid().id));
    expect(attached?.text).toBe('21gifts moderator');
  });

  it('does not attach a second group stipend when settled twice', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const conversationStore = new InMemoryConversationStore();
    const threadId = await seedGroupTrigger(conversationStore);
    const deps = actionDeps({ authStore, conversationStore });
    const invoice = unpaid({ groupMessageId: GROUP_MSG_ID, comment: '21gifts moderator' });
    await settleProvenGift(deps, invoice, PAID_AT_MS, SOURCE_WALLET, null);
    await settleProvenGift(deps, invoice, PAID_AT_MS, SOURCE_WALLET, null);
    const messages = await conversationStore.listMessages(threadId, 200);
    expect(messages).toHaveLength(2);
    expect(messages.filter((row) => row.id === spendGroupGiftId(invoice.id))).toHaveLength(1);
  });

  it('writes the fiat snapshot to the group stipend', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const conversationStore = new InMemoryConversationStore();
    await seedGroupTrigger(conversationStore);
    await settleProvenGift(
      actionDeps({ authStore, conversationStore }),
      unpaid({ groupMessageId: GROUP_MSG_ID, comment: '21gifts moderator' }),
      PAID_AT_MS,
      SOURCE_WALLET,
      { usd: '5.00', chf: '4.00', eur: null, php: null },
    );
    const attached = await conversationStore.getMessageById(spendGroupGiftId(unpaid().id));
    expect(attached?.amountUsd).toBe('5.00');
    expect(attached?.amountChf).toBe('4.00');
  });

  it('attaches no group stipend without a conversation store', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const { giftRecorder, recorded } = capturingRecorder();
    const deps = actionDeps({ authStore, giftRecorder });
    delete deps.conversationStore;
    await settleProvenGift(
      deps,
      unpaid({ groupMessageId: GROUP_MSG_ID, comment: '21gifts moderator' }),
      PAID_AT_MS,
      SOURCE_WALLET,
      null,
    );
    expect(recorded[0]?.kind).toBe('moderator');
    expect(
      parsedEvents(warn).some((e) => String(e['event']).startsWith('invoice.group_gift')),
    ).toBe(false);
  });

  it('logs invoice.group_gift.failed when the triggering group message is missing', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const conversationStore = new InMemoryConversationStore();
    await settleProvenGift(
      actionDeps({ authStore, conversationStore }),
      unpaid({ groupMessageId: GROUP_MSG_ID, comment: '21gifts moderator' }),
      PAID_AT_MS,
      SOURCE_WALLET,
      null,
    );
    expect(await conversationStore.getMessageById(spendGroupGiftId(unpaid().id))).toBeUndefined();
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.group_gift.failed')).toBe(true);
  });

  it('logs invoice.group_gift.failed when the thread is not moderator_group', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const conversationStore = new InMemoryConversationStore();
    await seedNonGroupTrigger(conversationStore);
    await settleProvenGift(
      actionDeps({ authStore, conversationStore }),
      unpaid({ groupMessageId: GROUP_MSG_ID, comment: '21gifts moderator' }),
      PAID_AT_MS,
      SOURCE_WALLET,
      null,
    );
    expect(await conversationStore.getMessageById(spendGroupGiftId(unpaid().id))).toBeUndefined();
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.group_gift.failed')).toBe(true);
  });

  it('logs invoice.group_gift.failed when the platform is missing at settlement', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const conversationStore = new InMemoryConversationStore();
    await seedGroupTrigger(conversationStore);
    await settleProvenGift(
      actionDeps({ authStore, conversationStore }),
      unpaid({ groupMessageId: GROUP_MSG_ID, comment: '21gifts moderator' }),
      PAID_AT_MS,
      SOURCE_WALLET,
      null,
    );
    expect(await conversationStore.getMessageById(spendGroupGiftId(unpaid().id))).toBeUndefined();
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.group_gift.failed')).toBe(true);
  });

  it('logs invoice.group_gift.failed when the conversation store throws', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const conversationStore: Pick<
      ConversationStore,
      'getById' | 'getMessageById' | 'appendMessage'
    > = {
      getById: () => Promise.resolve(undefined),
      getMessageById: () => Promise.reject(new Error('db')),
      appendMessage: () => Promise.reject(new Error('db')),
    };
    await settleProvenGift(
      actionDeps({ authStore, conversationStore }),
      unpaid({ groupMessageId: GROUP_MSG_ID, comment: '21gifts moderator' }),
      PAID_AT_MS,
      SOURCE_WALLET,
      null,
    );
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.group_gift.failed')).toBe(true);
  });
});

describe('persistProvenGift', () => {
  it('records only the gift row with the override kind', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const messageStore = uuidPostStore();
    const { giftRecorder, recorded } = capturingRecorder();
    await persistProvenGift(
      actionDeps({ authStore, messageStore, giftRecorder }),
      {
        id: 'ab'.repeat(16),
        address: ADDRESS,
        pr: PR,
        paymentHash: HASH,
        amountMsat: 2500,
        createdAt: 1,
        expiresAt: 2,
        messageId: POST_ID,
        comment: 'gm',
      },
      PAID_AT_MS,
      usdFiat('1.00'),
      SOURCE_WALLET,
      'moderator',
    );
    expect(recorded).toEqual([
      {
        paidAt: new Date(PAID_AT_MS),
        amountSats: 2,
        feeSats: 0,
        recipientWosUser: 'alice',
        lightningInvoice: PR,
        description: '21gifts moderator',
        kind: 'moderator',
        sourceWallet: SOURCE_WALLET,
        fiat: usdFiat('1.00'),
      },
    ]);
    expect(await messageStore.listReplies(POST_ID, 200)).toHaveLength(0);
  });
});

describe('settleProvenGift reply author', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let invoiceStore: InMemoryInvoiceStore;

  function invoice(overrides?: Partial<GiftInvoice>): GiftInvoice {
    return {
      id: 'ef'.repeat(16),
      address: ADDRESS,
      pr: PR,
      paymentHash: HASH,
      amountMsat: 1000,
      createdAt: 1,
      expiresAt: 1_000_000,
      ...overrides,
    };
  }

  async function fondAuth(name = 'Tondo Fond'): Promise<InMemoryAuthStore> {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    await authStore.createAccount({
      id: 'fond',
      username: 'tondo-fond',
      walletRequired: false,
      linkingKey: null,
      role: 'fond',
      name,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'f'.repeat(64),
      createdAt: 3,
      rulesAgreedAt: null,
    });
    await authStore.setNostrKeyIfAbsent('fond', {
      pubkey: 'cd'.repeat(32),
      ciphertext: new Uint8Array(8),
      kekId: 1,
      custody: 'custodial',
    });
    return authStore;
  }

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    invoiceStore = new InMemoryInvoiceStore();
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('authors the fond gift reply with the Fond account id, name, and pubkey', async () => {
    const authStore = await fondAuth();
    const messageStore = uuidPostStore();
    const target = invoice({ id: 'ef'.repeat(16), messageId: POST_ID, comment: 'thanks' });
    await settleProvenGift(
      {
        store: invoiceStore,
        authStore,
        messageStore,
        now: () => 100,
        fetchImpl: happyFetch(),
        fundingStore: new InMemoryFundingStore(),
      },
      target,
      100,
      'tondo-fond',
      null,
      'daily',
      'tondo-fond',
    );
    const reply = await messageStore.getById(spendGiftReplyId(target.id));
    expect(reply).toMatchObject({
      accountId: 'fond',
      name: 'Tondo Fond',
      authorPubkey: 'cd'.repeat(32),
      text: 'thanks',
    });
    expect(await messageStore.listReplies(POST_ID, 10)).toHaveLength(1);
    expect((await messageStore.getById(POST_ID))?.sats).toBe(1);
  });

  it('falls back to the Fond username when its display name is blank', async () => {
    const authStore = await fondAuth('  ');
    const messageStore = uuidPostStore();
    const target = invoice({ id: 'fa'.repeat(16), messageId: POST_ID });
    await settleProvenGift(
      {
        store: invoiceStore,
        authStore,
        messageStore,
        now: () => 100,
        fetchImpl: happyFetch(),
        fundingStore: new InMemoryFundingStore(),
      },
      target,
      100,
      'tondo-fond',
      null,
      undefined,
      '  Tondo-Fond ',
    );
    expect((await messageStore.getById(spendGiftReplyId(target.id)))?.name).toBe('tondo-fond');
  });

  it('hides the nested-reply marker as the Fond account', async () => {
    const authStore = await fondAuth();
    const messageStore = uuidReplyStore();
    const target = invoice({ id: 'fb'.repeat(16), messageId: REPLY_ID, comment: 'gm' });
    await settleProvenGift(
      {
        store: invoiceStore,
        authStore,
        messageStore,
        now: () => 100,
        fetchImpl: happyFetch(),
        fundingStore: new InMemoryFundingStore(),
      },
      target,
      100,
      'tondo-fond',
      null,
      'daily',
      'tondo-fond',
    );
    const marker = await messageStore.getById(spendGiftReplyId(target.id));
    expect(marker).toMatchObject({ accountId: 'fond', deletedBy: 'fond' });
    expect(marker?.deletedAt).not.toBeNull();
    expect((await messageStore.getById(REPLY_ID))?.receivedSats).toBe(1);
  });

  it('authors the moderator stipend as the Fond account', async () => {
    const authStore = await fondAuth();
    const conversationStore = new InMemoryConversationStore();
    await seedGroupTrigger(conversationStore);
    const target = invoice({ id: 'fc'.repeat(16), groupMessageId: GROUP_MSG_ID, comment: 'gm' });
    await settleProvenGift(
      {
        store: invoiceStore,
        authStore,
        messageStore: uuidPostStore(),
        conversationStore,
        now: () => 100,
        fetchImpl: happyFetch(),
        fundingStore: new InMemoryFundingStore(),
      },
      target,
      100,
      'tondo-fond',
      null,
      'moderator',
      'tondo-fond',
    );
    expect(await conversationStore.getMessageById(spendGroupGiftId(target.id))).toMatchObject({
      senderAccountId: 'fond',
      senderPubkey: 'cd'.repeat(32),
      name: 'Tondo Fond',
      giftForMessageId: GROUP_MSG_ID,
    });
  });

  it('falls back to the Fond username for a blank group-message display name', async () => {
    const authStore = await fondAuth(' ');
    const conversationStore = new InMemoryConversationStore();
    await seedGroupTrigger(conversationStore);
    const target = invoice({ id: 'f0'.repeat(16), groupMessageId: GROUP_MSG_ID });
    await settleProvenGift(
      {
        store: invoiceStore,
        authStore,
        messageStore: uuidPostStore(),
        conversationStore,
        now: () => 100,
        fetchImpl: happyFetch(),
        fundingStore: new InMemoryFundingStore(),
      },
      target,
      100,
      'tondo-fond',
      null,
      'moderator',
      'tondo-fond',
    );
    expect(await conversationStore.getMessageById(spendGroupGiftId(target.id))).toMatchObject({
      senderAccountId: 'fond',
      name: 'tondo-fond',
    });
  });

  it('skips both attachments for an unknown Fond account without platform fallback', async () => {
    const authStore = await fondAuth();
    const messageStore = uuidPostStore();
    const conversationStore = new InMemoryConversationStore();
    await seedGroupTrigger(conversationStore);
    const recorded: GiftRecord[] = [];
    const target = invoice({
      id: 'fd'.repeat(16),
      messageId: POST_ID,
      groupMessageId: GROUP_MSG_ID,
      comment: 'gm',
    });
    await settleProvenGift(
      {
        store: invoiceStore,
        authStore,
        messageStore,
        conversationStore,
        now: () => 100,
        fetchImpl: happyFetch(),
        fundingStore: new InMemoryFundingStore(),
        giftRecorder: {
          recordOutbound: async (row) => {
            recorded.push(row);
          },
        },
      },
      target,
      100,
      'missing-fond',
      null,
      'moderator',
      'missing-fond',
    );
    expect(await messageStore.getById(spendGiftReplyId(target.id))).toBeUndefined();
    expect(await messageStore.listReplies(POST_ID, 10)).toHaveLength(0);
    expect((await messageStore.getById(POST_ID))?.sats).toBe(0);
    expect(await conversationStore.getMessageById(spendGroupGiftId(target.id))).toBeUndefined();
    expect(recorded).toHaveLength(1);
    const events = parsedEvents(warn).map((event) => event['event']);
    expect(events).toContain('invoice.gift_reply.failed');
    expect(events).toContain('invoice.group_gift.failed');
  });

  it('skips both attachments when the Fond account lookup throws', async () => {
    const inner = await fondAuth();
    const authStore = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'getAccountByUsername') {
          return async () => {
            throw new Error('lookup down');
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...args: never[]) => unknown).bind(target)
          : value;
      },
    });
    const messageStore = uuidPostStore();
    const conversationStore = new InMemoryConversationStore();
    await seedGroupTrigger(conversationStore);
    const recorded: GiftRecord[] = [];
    const target = invoice({
      id: 'fe'.repeat(16),
      messageId: POST_ID,
      groupMessageId: GROUP_MSG_ID,
      comment: 'gm',
    });
    await settleProvenGift(
      {
        store: invoiceStore,
        authStore,
        messageStore,
        conversationStore,
        now: () => 100,
        fetchImpl: happyFetch(),
        fundingStore: new InMemoryFundingStore(),
        giftRecorder: {
          recordOutbound: async (row) => {
            recorded.push(row);
          },
        },
      },
      target,
      100,
      'tondo-fond',
      null,
      'moderator',
      'tondo-fond',
    );
    expect(await messageStore.getById(spendGiftReplyId(target.id))).toBeUndefined();
    expect(recorded).toHaveLength(1);
    expect(await conversationStore.getMessageById(spendGroupGiftId(target.id))).toBeUndefined();
    const events = parsedEvents(warn).map((event) => event['event']);
    expect(events).toContain('invoice.gift_reply.failed');
    expect(events).toContain('invoice.group_gift.failed');
  });

  it('skips both attachments when the Fond username belongs to a role below fond', async () => {
    const authStore = await fondAuth();
    const fond = await authStore.getAccountByUsername('tondo-fond');
    await authStore.updateAccount({ ...fond!, role: 'verified' });
    const messageStore = uuidPostStore();
    const conversationStore = new InMemoryConversationStore();
    await seedGroupTrigger(conversationStore);
    const recorded: GiftRecord[] = [];
    const target = invoice({
      id: 'f1'.repeat(16),
      messageId: POST_ID,
      groupMessageId: GROUP_MSG_ID,
      comment: 'gm',
    });
    await settleProvenGift(
      {
        store: invoiceStore,
        authStore,
        messageStore,
        conversationStore,
        now: () => 100,
        fetchImpl: happyFetch(),
        fundingStore: new InMemoryFundingStore(),
        giftRecorder: {
          recordOutbound: async (row) => {
            recorded.push(row);
          },
        },
      },
      target,
      100,
      'tondo-fond',
      null,
      'moderator',
      'tondo-fond',
    );
    expect(await messageStore.getById(spendGiftReplyId(target.id))).toBeUndefined();
    expect(await messageStore.listReplies(POST_ID, 10)).toHaveLength(0);
    expect((await messageStore.getById(POST_ID))?.sats).toBe(0);
    expect(await conversationStore.getMessageById(spendGroupGiftId(target.id))).toBeUndefined();
    expect(recorded).toHaveLength(1);
    const events = parsedEvents(warn).map((event) => event['event']);
    expect(events).toContain('invoice.gift_reply.failed');
    expect(events).toContain('invoice.group_gift.failed');
  });

  it('skips both attachments when the platform account holds the Fond username', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const platform = await authStore.getAccount('plat');
    await authStore.updateAccount({ ...platform!, username: 'tondo-fond' });
    const messageStore = uuidPostStore();
    const conversationStore = new InMemoryConversationStore();
    await seedGroupTrigger(conversationStore);
    const recorded: GiftRecord[] = [];
    const target = invoice({
      id: 'f2'.repeat(16),
      messageId: POST_ID,
      groupMessageId: GROUP_MSG_ID,
      comment: 'gm',
    });
    await settleProvenGift(
      {
        store: invoiceStore,
        authStore,
        messageStore,
        conversationStore,
        now: () => 100,
        fetchImpl: happyFetch(),
        fundingStore: new InMemoryFundingStore(),
        giftRecorder: {
          recordOutbound: async (row) => {
            recorded.push(row);
          },
        },
      },
      target,
      100,
      'tondo-fond',
      null,
      'moderator',
      'tondo-fond',
    );
    expect(await messageStore.getById(spendGiftReplyId(target.id))).toBeUndefined();
    expect(await messageStore.listReplies(POST_ID, 10)).toHaveLength(0);
    expect((await messageStore.getById(POST_ID))?.sats).toBe(0);
    expect(await conversationStore.getMessageById(spendGroupGiftId(target.id))).toBeUndefined();
    expect(recorded).toHaveLength(1);
    const events = parsedEvents(warn).map((event) => event['event']);
    expect(events).toContain('invoice.gift_reply.failed');
    expect(events).toContain('invoice.group_gift.failed');
  });

  it('keeps the platform as author when no Fond username is passed', async () => {
    const authStore = await fondAuth();
    const messageStore = uuidPostStore();
    const conversationStore = new InMemoryConversationStore();
    await seedGroupTrigger(conversationStore);
    const target = invoice({
      id: 'ff'.repeat(16),
      messageId: POST_ID,
      groupMessageId: GROUP_MSG_ID,
      comment: 'gm',
    });
    await settleProvenGift(
      {
        store: invoiceStore,
        authStore,
        messageStore,
        conversationStore,
        now: () => 100,
        fetchImpl: happyFetch(),
        fundingStore: new InMemoryFundingStore(),
      },
      target,
      100,
      'lightning.space',
      null,
    );
    expect(await messageStore.getById(spendGiftReplyId(target.id))).toMatchObject({
      accountId: 'plat',
      name: '21.gifts',
    });
    expect(await conversationStore.getMessageById(spendGroupGiftId(target.id))).toMatchObject({
      senderAccountId: 'plat',
      name: '21.gifts',
    });
  });
});

describe('issueGiftInvoice welcome exception and funding gate', () => {
  beforeEach(() => {
    mockedDecode.mockReset();
    mockedDecode.mockReturnValue({ paymentHash: HASH, amountMsat: 1000 });
    mockedSpot.mockReset();
    mockedSpot.mockResolvedValue(null);
  });

  /** One-dollar canonical welcome request at the 100k USD spot. */
  const ONE_DOLLAR_WELCOME = {
    address: ADDRESS,
    amountMsat: ONE_USD_AT_100K_MSAT,
    amountUsd: '1.00',
    comment: 'Welcome',
  };

  /** Deps for `acc-alice` with an admitted grant at {@link GATE_MS}, no shop payment unless set. */
  async function gateDeps(
    overrides: Partial<GiftActionDeps> = {},
    shopPayment = false,
  ): Promise<GiftActionDeps> {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    return actionDeps({
      authStore,
      messageStore: livePostStore(),
      walletTransfers: fakeWalletTransferStore(shopPayment),
      now: () => GATE_MS,
      ...overrides,
    });
  }

  /** Make `acc-alice` of `deps` a moderator, a basis account, or the platform account. */
  async function reshape(
    deps: GiftActionDeps,
    patch: { role?: 'moderator' | 'basis' | 'verified'; isPlatform?: boolean },
  ): Promise<void> {
    const authStore = deps.authStore as InMemoryAuthStore;
    const account = await authStore.getAccount('acc-alice');
    if (account === undefined) throw new Error('missing seeded account');
    await authStore.updateAccount({ ...account, ...patch });
  }

  it('refuses invoice issue when an admitted member has no recent verified shop payment', async () => {
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(await gateDeps({ fetchImpl }), {
      address: ADDRESS,
      amountMsat: 1000,
    });
    expect(result).toEqual({ ok: false, status: 403, error: 'Funding grant required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('still requires a shop payment when Welcome has another normalized amount', async () => {
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(await gateDeps({ fetchImpl }), {
      address: ADDRESS,
      amountMsat: 1000,
      amountUsd: '2.00',
      comment: 'Welcome',
    });
    expect(result).toEqual({ ok: false, status: 403, error: 'Funding grant required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('issues the one-dollar welcome without a shop payment', async () => {
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    mockedSpot.mockResolvedValueOnce('100000');
    mockedDecode.mockReturnValueOnce({ paymentHash: HASH, amountMsat: ONE_USD_AT_100K_MSAT });
    const result = await issueGiftInvoice(await gateDeps({ fetchImpl }), {
      ...ONE_DOLLAR_WELCOME,
      amountUsd: '1',
    });
    const invoice = issuedInvoice(result);
    expect(invoice.welcomeReservationAccountId).toBe('acc-alice');
    expect(invoice.createdAt).toBe(GATE_MS);
    expect(mockedSpot).toHaveBeenCalledWith(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns 409 for a second live welcome lease even with a qualifying shop payment', async () => {
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    mockedSpot.mockResolvedValue('100000');
    mockedDecode.mockReturnValue({ paymentHash: HASH, amountMsat: ONE_USD_AT_100K_MSAT });
    const deps = await gateDeps({ fetchImpl }, true);
    expect((await issueGiftInvoice(deps, ONE_DOLLAR_WELCOME)).ok).toBe(true);
    const fetchCallsAfterFirst = fetchImpl.mock.calls.length;
    expect(await issueGiftInvoice(deps, ONE_DOLLAR_WELCOME)).toEqual({
      ok: false,
      status: 409,
      error: 'Welcome invoice already open',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(fetchCallsAfterFirst);
  });

  it('reuses the fallback welcome reservation store for the same invoice store', async () => {
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    mockedSpot.mockResolvedValue('100000');
    mockedDecode.mockReturnValue({ paymentHash: HASH, amountMsat: ONE_USD_AT_100K_MSAT });
    const deps = await gateDeps({ fetchImpl });
    delete deps.welcomeReservations;
    expect((await issueGiftInvoice(deps, ONE_DOLLAR_WELCOME)).ok).toBe(true);
    const fetchCallsAfterFirst = fetchImpl.mock.calls.length;
    expect(await issueGiftInvoice({ ...deps }, ONE_DOLLAR_WELCOME)).toEqual({
      ok: false,
      status: 409,
      error: 'Welcome invoice already open',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(fetchCallsAfterFirst);
  });

  it('releases a welcome reservation when a later issue gate fails', async () => {
    const release = vi.fn(async () => undefined);
    mockedSpot.mockResolvedValueOnce('100000');
    const result = await issueGiftInvoice(
      await gateDeps({
        messageStore: new InMemoryMessageStore(),
        welcomeReservations: { reserve: async () => true, release },
      }),
      ONE_DOLLAR_WELCOME,
    );
    expect(result).toEqual({ ok: false, status: 403, error: 'Forum post required' });
    expect(release).toHaveBeenCalledWith('acc-alice', expect.stringMatching(/^[0-9a-f]{32}$/));
  });

  it('returns 503 when durable welcome reservation fails despite a shop payment', async () => {
    mockedSpot.mockResolvedValueOnce('100000');
    const result = await issueGiftInvoice(
      await gateDeps(
        {
          welcomeReservations: {
            reserve: async () => Promise.reject(new Error('unavailable')),
            release: async () => undefined,
          },
        },
        true,
      ),
      ONE_DOLLAR_WELCOME,
    );
    expect(result).toEqual({
      ok: false,
      status: 503,
      error: 'Welcome invoice reservation unavailable',
    });
  });

  it('allows the one-dollar welcome at exactly ten percent above the server conversion', async () => {
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const amountMsat = 1_100_000;
    mockedSpot.mockResolvedValueOnce('100000');
    mockedDecode.mockReturnValueOnce({ paymentHash: HASH, amountMsat });
    const result = await issueGiftInvoice(await gateDeps({ fetchImpl }), {
      ...ONE_DOLLAR_WELCOME,
      amountMsat,
    });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('requires a shop payment above the one-dollar spot tolerance', async () => {
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    mockedSpot.mockResolvedValueOnce('100000');
    const result = await issueGiftInvoice(await gateDeps({ fetchImpl }), {
      ...ONE_DOLLAR_WELCOME,
      amountMsat: 10_000_000_000,
    });
    expect(result).toEqual({ ok: false, status: 403, error: 'Funding grant required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('requires a shop payment when the one-dollar spot is unavailable', async () => {
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(await gateDeps({ fetchImpl }), ONE_DOLLAR_WELCOME);
    expect(result).toEqual({ ok: false, status: 403, error: 'Funding grant required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails the welcome exception closed when the spot lookup unexpectedly throws', async () => {
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    mockedSpot.mockRejectedValueOnce(new Error('down'));
    const result = await issueGiftInvoice(await gateDeps({ fetchImpl }), ONE_DOLLAR_WELCOME);
    expect(result).toEqual({ ok: false, status: 403, error: 'Funding grant required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('requires a shop payment for a second canonical welcome request', async () => {
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(
      await gateDeps({
        fetchImpl,
        giftStore: new InMemoryGiftStore([{ ...PAID_WELCOME, paidAt: new Date(3) }]),
      }),
      { ...ONE_DOLLAR_WELCOME, amountMsat: 1000 },
    );
    expect(result).toEqual({ ok: false, status: 403, error: 'Funding grant required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not treat a basis account as the server welcome exception', async () => {
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const deps = await gateDeps({ fetchImpl });
    await reshape(deps, { role: 'basis' });
    const result = await issueGiftInvoice(deps, { ...ONE_DOLLAR_WELCOME, amountMsat: 1000 });
    expect(result).toEqual({ ok: false, status: 403, error: 'Funding grant required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not give a moderator the server welcome exception', async () => {
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const deps = await gateDeps({ fetchImpl });
    await reshape(deps, { role: 'moderator' });
    mockedSpot.mockResolvedValueOnce('100000');
    const result = await issueGiftInvoice(deps, ONE_DOLLAR_WELCOME);
    expect(result).toEqual({ ok: false, status: 403, error: 'Funding grant required' });
    expect(mockedSpot).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not treat the platform account as the server welcome exception', async () => {
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const deps = await gateDeps({ fetchImpl });
    await reshape(deps, { role: 'verified', isPlatform: true });
    mockedSpot.mockResolvedValueOnce('100000');
    const result = await issueGiftInvoice(deps, ONE_DOLLAR_WELCOME);
    expect(result).toEqual({ ok: false, status: 403, error: 'Funding grant required' });
    expect(mockedSpot).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not let a daily roster comment 'Welcome' bypass the shop payment", async () => {
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(
      await gateDeps({ fetchImpl, recoveryShareRequiredFrom: FUNDING_REQUIRED_FROM_UTC }),
      {
        address: ADDRESS,
        amountMsat: 1000,
        amountUsd: '1.00',
        comment: 'Welcome',
        messageId: POST_ID,
      },
    );
    expect(result).toEqual({ ok: false, status: 403, error: 'Funding grant required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps internal welcome provenance compatible with the same server-side facts', async () => {
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    mockedSpot.mockResolvedValueOnce('100000');
    mockedDecode.mockReturnValueOnce({ paymentHash: HASH, amountMsat: ONE_USD_AT_100K_MSAT });
    const result = await issueGiftInvoice(
      await gateDeps({ fetchImpl, recoveryShareRequiredFrom: FUNDING_REQUIRED_FROM_UTC }),
      { ...ONE_DOLLAR_WELCOME, serverPayoutKind: 'welcome' },
    );
    expect(result.ok).toBe(true);
    // LNURL-pay first discovers the callback, then requests the invoice from it.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not persist when issueGiftInvoice sees an expired trial', async () => {
    const stored = expiredTrialGrant();
    const fundingStore = new InMemoryFundingStore([stored]);
    const result = await issueGiftInvoice(await gateDeps({ fundingStore }, true), {
      address: ADDRESS,
      amountMsat: 1000,
    });
    expect(result).toEqual({ ok: false, status: 403, error: 'Funding grant required' });
    expect(await fundingStore.getByAccountId('acc-alice')).toEqual(stored);
    expect((await fundingStore.getByAccountId('acc-alice'))?.status).toBe('trial');
  });

  /** Transfer store whose every window sums to `sats` qualifying shop sats. */
  function shopSats(sats: number): WalletTransferStore {
    return {
      ...fakeWalletTransferStore(),
      hasShopPayment: async (_id, _from, _to, minSats = 1) => sats >= minSats,
      shopPaymentSats: async () => sats,
    };
  }

  /** Roster listing `acc-alice` at 2 USD, which needs 1000 shop sats at the 100k spot. */
  async function twoDollarRoster(): Promise<InMemoryDailyRosterStore> {
    const rosterStore = new InMemoryDailyRosterStore();
    await rosterStore.addRecipient('acc-alice', 2);
    return rosterStore;
  }

  it('refuses a daily invoice below half of the roster amount', async () => {
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const deps = await gateDeps({
      fetchImpl,
      rosterStore: await twoDollarRoster(),
      walletTransfers: shopSats(999),
    });
    expect(await issueGiftInvoice(deps, { address: ADDRESS, amountMsat: 1000 })).toEqual({
      ok: false,
      status: 403,
      error: 'Funding grant required',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('issues a daily invoice at exactly half of the roster amount', async () => {
    const deps = await gateDeps({
      fetchImpl: vi.fn<FetchFn>(happyFetch()),
      rosterStore: await twoDollarRoster(),
      walletTransfers: shopSats(1000),
    });
    expect((await issueGiftInvoice(deps, { address: ADDRESS, amountMsat: 1000 })).ok).toBe(true);
  });

  it.each([
    ['an empty spot store', new InMemoryFxSpotStore()],
    [
      'a stored quote without a USD rate',
      new InMemoryFxSpotStore({
        asOf: '2026-09-15T00:00:00.000Z',
        source: 'test',
        rates: { EUR: '90000' },
      }),
    ],
    ['no spot store', undefined],
  ])('answers a retryable 503 for a daily invoice with %s', async (_label, fxSpotStore) => {
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const deps = await gateDeps({ fetchImpl }, true);
    if (fxSpotStore === undefined) {
      delete deps.fxSpotStore;
    } else {
      deps.fxSpotStore = fxSpotStore;
    }
    expect(await issueGiftInvoice(deps, { address: ADDRESS, amountMsat: 1000 })).toEqual({
      ok: false,
      status: 503,
      error: 'Price unavailable',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /** Gate deps with the platform account and a moderator-group trigger by `acc-alice`. */
  async function groupDeps(
    overrides: Partial<GiftActionDeps> = {},
  ): Promise<GiftActionDeps & { conversationStore: InMemoryConversationStore }> {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore);
    const conversationStore = new InMemoryConversationStore();
    await seedGroupTrigger(conversationStore);
    return {
      ...actionDeps({
        authStore,
        messageStore: uuidPostStore(),
        fetchImpl: vi.fn<FetchFn>(happyFetch()),
        now: () => GATE_MS,
        rosterStore: await twoDollarRoster(),
        walletTransfers: shopSats(1),
        ...overrides,
      }),
      conversationStore,
    };
  }

  const STIPEND = {
    address: ADDRESS,
    amountMsat: 1000,
    groupMessageId: GROUP_MSG_ID,
    comment: '21gifts moderator',
  };

  it('keeps the 1-sat rule for a resolved moderator-group stipend', async () => {
    expect((await issueGiftInvoice(await groupDeps(), STIPEND)).ok).toBe(true);
  });

  it('needs half the daily grant when the moderator-group reference does not resolve', async () => {
    const deps = await groupDeps();
    deps.conversationStore = new InMemoryConversationStore();
    expect(await issueGiftInvoice(deps, STIPEND)).toEqual({
      ok: false,
      status: 403,
      error: 'Funding grant required',
    });
  });

  it('keeps the 1-sat rule when the moderator-group lookup fails', async () => {
    const deps = await groupDeps();
    vi.spyOn(deps.conversationStore, 'getMessageById').mockRejectedValue(new Error('down'));
    expect((await issueGiftInvoice(deps, STIPEND)).ok).toBe(true);
  });

  it('keeps the 1-sat rule for a welcome row whose exception does not apply', async () => {
    const deps = await gateDeps({
      fetchImpl: vi.fn<FetchFn>(happyFetch()),
      rosterStore: await twoDollarRoster(),
      walletTransfers: shopSats(1),
    });
    const result = await issueGiftInvoice(deps, {
      address: ADDRESS,
      amountMsat: 1000,
      serverPayoutKind: 'welcome',
    });
    expect(result.ok).toBe(true);
  });
});

describe('issueGiftInvoice by wallet address', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockedDecode.mockReset();
    mockedDecode.mockReturnValue({ paymentHash: HASH, amountMsat: 1000 });
  });

  afterEach(() => {
    expect(warn.mock.calls.flat().join('\n')).not.toContain(ADDRESS);
    warn.mockRestore();
  });

  /** `acc-alice` with a passkey (unless `withPasskey` is false) but no verified wallet. */
  async function seedWithoutWallet(
    authStore: InMemoryAuthStore,
    withPasskey = true,
  ): Promise<void> {
    await authStore.createAccount({
      id: 'acc-alice',
      linkingKey: null,
      role: 'verified',
      name: 'Ada',
      username: 'alice',
      walletRequired: true,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    if (!withPasskey) {
      return;
    }
    await authStore.createPasskeyCredential({
      credentialId: 'cred-alice',
      publicKey: new Uint8Array([1]),
      signCount: 0,
      accountId: 'acc-alice',
      createdAt: 1,
    });
  }

  it('resolves the wallet address case-insensitively and fetches the invoice internally', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const { fetchImpl, seen } = walletLnurlFetch('alice');
    const invoice = issuedInvoice(
      await issueGiftInvoice(
        actionDeps({ authStore, messageStore: livePostStore(), fetchImpl, now: () => NOW_MS }),
        { address: ' ALICE@Example.Test ', amountMsat: 1000 },
      ),
    );
    expect(invoice.address).toBe('alice@example.test');
    expect(allInternal(seen)).toBe(true);
  });

  it('accepts a wallet address whose public host carries a port or is an IP address', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    /** Deps whose LNURL server is public at `https://<host>`, with a fake internal LNURL server. */
    function hostDeps(host: string): { deps: GiftActionDeps; seen: string[] } {
      const seen: string[] = [];
      const fetchImpl: FetchFn = async (input) => {
        const url = String(input);
        seen.push(url);
        if (url === 'http://lnurl.test/.well-known/lnurlp/alice') {
          return Response.json({
            tag: 'payRequest',
            callback: `https://${host}/lnurlp/alice/invoice`,
            metadata: '[["text/plain","x"]]',
            minSendable: 1000,
            maxSendable: 1_000_000_000,
          });
        }
        if (url.startsWith('http://lnurl.test/lnurlp/alice/invoice?')) {
          return Response.json({ pr: PR });
        }
        return new Response('unexpected', { status: 500 });
      };
      const publicBaseUrl = `https://${host}`;
      const lnurlServer: LnurlServerConfig = {
        baseUrl: LNURL_SERVER.baseUrl,
        publicBaseUrl,
        host: new URL(publicBaseUrl).host,
      };
      const deps = actionDeps({
        authStore,
        messageStore: livePostStore(),
        fetchImpl,
        lnurlServer,
        now: () => NOW_MS,
      });
      return { deps, seen };
    }
    for (const host of ['example.test:8443', '127.0.0.1', '[::1]:3000']) {
      const { deps, seen } = hostDeps(host);
      const invoice = issuedInvoice(
        await issueGiftInvoice(deps, { address: `Alice@${host.toUpperCase()}`, amountMsat: 1000 }),
      );
      expect(invoice.address).toBe(`alice@${host}`);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((url) => url.startsWith('http://lnurl.test/'))).toBe(true);
      expect(await issueGiftInvoice(deps, { address: host, amountMsat: 1000 })).toMatchObject({
        ok: false,
        status: 400,
      });
    }
    const { deps } = hostDeps('example.test:8443');
    for (const address of [
      'alice@other.test:8443',
      '@example.test:8443',
      'alice@@example.test:8443',
      'al ice@example.test:8443',
      `${'a'.repeat(250)}@example.test:8443`,
    ]) {
      expect(await issueGiftInvoice(deps, { address, amountMsat: 1000 })).toEqual({
        ok: false,
        status: 400,
        error: 'Not a valid Lightning Address (expected name@domain)',
      });
    }
    const off = actionDeps({ authStore });
    delete off.lnurlServer;
    expect(
      await issueGiftInvoice(off, { address: 'alice@example.test:8443', amountMsat: 1000 }),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it('does not find a foreign domain', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(
      actionDeps({ authStore, messageStore: livePostStore(), fetchImpl, now: () => NOW_MS }),
      { address: 'alice@example.com', amountMsat: 1000 },
    );
    expect(result).toEqual({ ok: false, status: 403, error: 'Passkey required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not find a member without a verified wallet', async () => {
    const authStore = new InMemoryAuthStore();
    await seedWithoutWallet(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(
      actionDeps({ authStore, messageStore: livePostStore(), fetchImpl, now: () => NOW_MS }),
      { address: ADDRESS, amountMsat: 1000 },
    );
    expect(result).toEqual({ ok: false, status: 403, error: 'Wallet required' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'invoice.wallet_required')).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers Passkey required for a member with neither a passkey nor a wallet', async () => {
    const authStore = new InMemoryAuthStore();
    await seedWithoutWallet(authStore, false);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(
      actionDeps({ authStore, messageStore: livePostStore(), fetchImpl, now: () => NOW_MS }),
      { address: ADDRESS, amountMsat: 1000 },
    );
    expect(result).toEqual({ ok: false, status: 403, error: 'Passkey required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers Passkey required for a member without a wallet named on another host', async () => {
    const authStore = new InMemoryAuthStore();
    await seedWithoutWallet(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(
      actionDeps({ authStore, messageStore: livePostStore(), fetchImpl, now: () => NOW_MS }),
      { address: 'alice@other.test', amountMsat: 1000 },
    );
    expect(result).toEqual({ ok: false, status: 403, error: 'Passkey required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not find anyone while the LNURL server is off', async () => {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAccount(authStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const deps = actionDeps({
      authStore,
      messageStore: livePostStore(),
      fetchImpl,
      now: () => NOW_MS,
    });
    delete deps.lnurlServer;
    const result = await issueGiftInvoice(deps, { address: ADDRESS, amountMsat: 1000 });
    expect(result).toEqual({ ok: false, status: 403, error: 'Passkey required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('issueGiftInvoice payout gate: the 21.gifts recovery share', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setAddressRefKey(TOKEN);
    mockedDecode.mockReset();
    mockedDecode.mockReturnValue({ paymentHash: HASH, amountMsat: 1000 });
  });

  afterEach(() => {
    warn.mockRestore();
    setAddressRefKey(null);
  });

  /** Deps for `acc-alice` without a share at {@link GATE_MS}, the share required from the gate day. */
  async function shareDeps(overrides: Partial<GiftActionDeps> = {}): Promise<GiftActionDeps> {
    const authStore = new InMemoryAuthStore();
    await seedPasskeyAndPlatform(authStore, { share: false });
    return actionDeps({
      authStore,
      messageStore: livePostStore(),
      fetchImpl: vi.fn<FetchFn>(happyFetch()),
      now: () => GATE_MS,
      recoveryShareRequiredFrom: FUNDING_REQUIRED_FROM_UTC,
      ...overrides,
    });
  }

  it.each([
    ['the day before the start day', '2026-10-02'],
    ['an unset start day', null],
  ])('issues to an admitted member without a share on %s', async (_label, day) => {
    const result = await issueGiftInvoice(await shareDeps({ recoveryShareRequiredFrom: day }), {
      address: ADDRESS,
      amountMsat: 1000,
    });
    expect(result.ok).toBe(true);
  });

  it('keeps the passkey and grant gates while the share is not required', async () => {
    const result = await issueGiftInvoice(
      await shareDeps({
        recoveryShareRequiredFrom: null,
        fundingStore: new InMemoryFundingStore(),
      }),
      { address: ADDRESS, amountMsat: 1000 },
    );
    expect(result).toEqual({ ok: false, status: 403, error: 'Funding grant required' });
  });

  it('refuses an admitted member without a share like a missing grant', async () => {
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(await shareDeps({ fetchImpl }), {
      address: ADDRESS,
      amountMsat: 1000,
    });
    expect(result).toEqual({ ok: false, status: 403, error: 'Funding grant required' });
    expect(parsedEvents(warn)).toContainEqual(
      expect.objectContaining({ event: 'invoice.funding_required', addressRef: ADDRESS_REF }),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses the welcome gift without a share', async () => {
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(await shareDeps({ fetchImpl }), {
      address: ADDRESS,
      amountMsat: 1000,
      comment: 'Welcome',
    });
    expect(result).toEqual({ ok: false, status: 403, error: 'Funding grant required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses the moderator stipend without a share', async () => {
    const conversationStore = new InMemoryConversationStore();
    await seedGroupTrigger(conversationStore);
    const fetchImpl = vi.fn<FetchFn>(happyFetch());
    const result = await issueGiftInvoice(
      await shareDeps({ messageStore: uuidPostStore(), fetchImpl, conversationStore }),
      {
        address: ADDRESS,
        amountMsat: 1000,
        groupMessageId: GROUP_MSG_ID,
        comment: '21gifts moderator',
      },
    );
    expect(result).toEqual({ ok: false, status: 403, error: 'Funding grant required' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not read the share before the gate day', async () => {
    const deps = await shareDeps({ now: () => NOW_MS });
    const shareRead = vi.spyOn(deps.authStore, 'hasRecoveryShareForVerifiedWallet');
    const result = await issueGiftInvoice(deps, { address: ADDRESS, amountMsat: 1000 });
    expect(result.ok).toBe(true);
    expect(shareRead).not.toHaveBeenCalled();
  });
});
