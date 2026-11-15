import { createHash } from 'node:crypto';
import { earnsModeratorGroupPay, isModeratorGroupMember } from '@/lib/auth/roles';
import type { Account, AuthStore } from '@/lib/auth/store';
import { decodeBolt11 } from '@/lib/bolt11';
import { fetchBtcUsdSpot } from '@/lib/btc-usd-spot';
import {
  GIFT_INVOICE_MAX_MSAT,
  GIFT_INVOICE_MIN_MSAT,
  GIFT_INVOICE_TTL_MS,
  type LnurlServerConfig,
} from '@/lib/config';
import type { ConversationStore } from '@/lib/conversation-store';
import { WELCOME_GIFT_DESCRIPTION, type GiftKind } from '@/lib/gift';
import { requestGiftInvoice } from '@/lib/gift-invoice';
import type { GiftStore } from '@/lib/gift-store';
import { newInvoiceId, type GiftInvoice, type InvoiceStore } from '@/lib/invoice-store';
import { normalizeLightningAddress } from '@/lib/lightning-address';
import type { FetchFn } from '@/lib/lnurlp';
import {
  accountByReceivingAddress,
  lnurlServerFetch,
  receivingAddress,
} from '@/lib/receiving-address';
import { unsignedNostrDefaults } from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import { normalizeAmountUsd, usdToMsat, type FiatAmounts } from '@/lib/money';
import type { FundingStore } from '@/lib/funding-store';
import { loadPayoutEligibility } from '@/lib/payout-eligibility';
import type { WalletTransferStore } from '@/lib/wallet-transfer-store';
import { welcomeGiftPaidOnUtcDay } from '@/lib/spend-instruction';
import {
  NoopGiftRecorder,
  recipientHandleFromAddress,
  type GiftRecorder,
} from '@/lib/gift-recorder';
import { logEvent } from '@/lib/log';
import { accountWelcomed, isWelcomeRecipient } from '@/lib/welcome-media';
import {
  InMemoryWelcomeInvoiceReservationStore,
  type WelcomeInvoiceReservationStore,
} from '@/lib/welcome-reservation';
import { MESSAGE_ID_RE } from '@/routes/messages';

/**
 * Gift invoice actions the Fond routes and the Fond paid worker share: check
 * passkey eligibility, a funding grant with the member's 21.gifts recovery
 * share (`loadPayoutEligibility`, which applies `eligibleToday`), and a live
 * top-level forum post, fetch a recipient BOLT11 via LNURL-pay, then settle a
 * proven payment. A settled gift with `messageId` attaches a platform
 * gift-reply when that message is a top-level post. If `messageId` is already
 * a reply, settlement persists a deterministic `spendGiftReplyId` marker under
 * that reply, `markDeleted` so live `listReplies` omits it, then
 * `addReceivedSats`s the reply. A live existing marker is `markDeleted` only
 * and does not `addReceivedSats`. Platform gift-replies do not notify. The api
 * does not pay.
 */

/** Auth lookups the gift actions read: receiving address, passkey, platform, and recovery share. */
type GiftActionAuthStore = Pick<
  AuthStore,
  | 'getAccountByUsername'
  | 'accountHasPasskey'
  | 'listAccounts'
  | 'getNostrPublicKey'
  | 'hasRecoveryShareForVerifiedWallet'
>;

/** Forum lookups and writes the gift actions use: posts, welcome, and gift replies. */
type GiftActionMessageStore = Pick<
  MessageStore,
  | 'accountHasLiveTopLevelPost'
  | 'accountHasWelcomeGift'
  | 'getById'
  | 'addSats'
  | 'addReceivedSats'
  | 'create'
  | 'markDeleted'
  | 'withMessageLock'
>;

/** 502 text when the recipient Lightning Address did not issue an invoice. */
const ISSUE_ERROR = 'Lightning Address did not issue an invoice';

/**
 * Maximum drift above the server's current USD 1.00 conversion that may still
 * use the one-time welcome exception. This absorbs spot movement between the
 * caller's conversion and the API's own lookup; a missing spot fails closed.
 */
const WELCOME_AMOUNT_SPOT_TOLERANCE_PERCENT = 10;

/**
 * Format a SHA-256 hex digest as a version-5-style UUID.
 *
 * @param hex - 64-character SHA-256 hex digest.
 * @returns UUID string.
 */
function deterministicUuidFromHex(hex: string): string {
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Deterministic gift-reply id for a gift invoice so a retry of the same
 * settlement is idempotent on `message.id`.
 *
 * @param invoiceId - Gift invoice id.
 * @returns UUID derived from SHA-256 of the spend-gift prefix and invoice id.
 */
function spendGiftReplyId(invoiceId: string): string {
  const hex = createHash('sha256').update(`21gifts-spend-gift:${invoiceId}`).digest('hex');
  return deterministicUuidFromHex(hex);
}

/**
 * Deterministic Moderators-group stipend message id for a gift invoice so
 * a repeated settlement is idempotent on `conversation_message.id`.
 *
 * @param invoiceId - Gift invoice id.
 * @returns UUID derived from SHA-256 of `21gifts-spend-group-gift:` and invoice id.
 */
function spendGroupGiftId(invoiceId: string): string {
  const hex = createHash('sha256').update(`21gifts-spend-group-gift:${invoiceId}`).digest('hex');
  return deterministicUuidFromHex(hex);
}

/** Local part of a Lightning Address, as `normalizeLightningAddress` accepts it. */
const LOCAL_PART = /^[a-zA-Z0-9._%+-]+$/;

/**
 * Validate a payout recipient address. Any `local@domain.tld` passes, and so does
 * an address with exactly one `@`, a valid local part, and the configured
 * wallet host, whose `PUBLIC_BASE_URL` host may carry a port or be an IP
 * address that the general check refuses.
 *
 * @param raw - The recipient address from the issue request.
 * @param lnurlServer - LNURL server config, or `undefined` when off.
 * @returns The trimmed address, or `null` when it is not valid.
 */
function spendLookupAddress(
  raw: string,
  lnurlServer: LnurlServerConfig | undefined,
): string | null {
  const valid = normalizeLightningAddress(raw);
  if (valid !== null || lnurlServer === undefined) {
    return valid;
  }
  const trimmed = raw.trim();
  const at = trimmed.lastIndexOf('@');
  return trimmed.length <= 255 &&
    at > 0 &&
    LOCAL_PART.test(trimmed.slice(0, at)) &&
    trimmed.slice(at + 1).toLowerCase() === lnurlServer.host.toLowerCase()
    ? trimmed
    : null;
}

/**
 * The member who receives on `address` (their verified wallet), if any.
 *
 * @param deps - Auth store and LNURL server config.
 * @param address - Normalised `local@domain`.
 * @returns The account, or `undefined` for another domain or no verified wallet.
 */
async function receiverOf(
  deps: Pick<GiftActionDeps, 'authStore' | 'lnurlServer'>,
  address: string,
): Promise<Account | undefined> {
  return (await accountByReceivingAddress(deps.authStore, address, deps.lnurlServer))?.account;
}

/**
 * Whether `address` is a wallet address whose member has a passkey but no
 * verified wallet yet, so it cannot receive.
 *
 * @param deps - Account and credential lookup, LNURL server config.
 * @param address - Normalised `local@domain`.
 * @returns `true` only for such a member; another domain, an unknown
 *   username, or the LNURL server off is `false`.
 */
async function passkeyWithoutWallet(
  deps: Pick<GiftActionDeps, 'authStore' | 'lnurlServer'>,
  address: string,
): Promise<boolean> {
  const at = address.lastIndexOf('@');
  if (
    deps.lnurlServer === undefined ||
    address.slice(at + 1).toLowerCase() !== deps.lnurlServer.host.toLowerCase()
  ) {
    return false;
  }
  const account = await deps.authStore.getAccountByUsername(address.slice(0, at).toLowerCase());
  return (
    account !== undefined &&
    receivingAddress(account, deps.lnurlServer) === null &&
    (await deps.authStore.accountHasPasskey(account.id))
  );
}

type WelcomeExceptionRequest = Pick<
  IssueGiftInvoiceInput,
  'amountMsat' | 'amountUsd' | 'comment' | 'messageId' | 'groupMessageId'
>;

function canonicalWelcomeRequest(input: WelcomeExceptionRequest): boolean {
  return (
    input.comment === 'Welcome' &&
    input.messageId === undefined &&
    input.groupMessageId === undefined &&
    input.amountUsd === '1.00'
  );
}

/** Shared fail-closed shop-payment exception for welcome preflight and issue. */
async function welcomeShopPaymentException(
  fetchImpl: FetchFn,
  welcomeOwed: () => Promise<boolean>,
  input?: WelcomeExceptionRequest,
): Promise<boolean> {
  if (input !== undefined && !canonicalWelcomeRequest(input)) return false;
  if (!(await welcomeOwed())) return false;
  let spot: string | null;
  try {
    spot = await fetchBtcUsdSpot(fetchImpl);
  } catch {
    spot = null;
  }
  const oneDollarMsat = spot === null ? null : usdToMsat('1.00', spot);
  if (oneDollarMsat === null) return false;
  return (
    input === undefined ||
    BigInt(input.amountMsat) * 100n <=
      BigInt(oneDollarMsat) * BigInt(100 + WELCOME_AMOUNT_SPOT_TOLERANCE_PERCENT)
  );
}

/**
 * Whether an account has at least one live top-level forum row that is not
 * the auto-created profile note. Replies do not count.
 *
 * @param messageStore - Live top-level post lookup.
 * @param account - Receiving account.
 * @returns `true` only when the account has a live top-level non-profile forum row.
 */
async function accountHasPosted(
  messageStore: GiftActionMessageStore,
  account: Account,
): Promise<boolean> {
  return messageStore.accountHasLiveTopLevelPost(account.id, account.profileMessageId ?? null);
}

/** Collaborators of the issue and settle actions. */
export interface GiftActionDeps {
  /** Server-verified wallet transfers for the shop-payment payout gate. */
  walletTransfers?: Pick<WalletTransferStore, 'hasShopPayment'>;
  /** Issued-invoice store. */
  store: InvoiceStore;
  /** Atomic welcome-exception entitlement leases. */
  welcomeReservations?: WelcomeInvoiceReservationStore;
  /** Auth store for receiving address, passkey, platform, and recovery lookups. */
  authStore: GiftActionAuthStore;
  /** Forum store for post, media, gift-reply, and group lookups. */
  messageStore: GiftActionMessageStore;
  /** Clock, epoch milliseconds. */
  now: () => number;
  /** Injected fetch for LNURL-pay. */
  fetchImpl: FetchFn;
  /** LNURL server config; omitted → no wallet member is found. */
  lnurlServer?: LnurlServerConfig;
  /** Proven-gift persistence; omitted → {@link NoopGiftRecorder}. */
  giftRecorder?: GiftRecorder;
  /** Moderator-group stipend lookup and insert. */
  conversationStore?: Pick<ConversationStore, 'getById' | 'getMessageById' | 'appendMessage'>;
  /** Funding grants for the payout gate. */
  fundingStore: FundingStore;
  /** Outbound gifts for the same-UTC-day welcome veto. */
  gifts?: Pick<GiftStore, 'listOutbound'>;
  /**
   * House gifts for the once-per-account welcome check. Omitted → only the
   * platform `Welcome` reply counts.
   */
  giftStore?: Pick<
    GiftStore,
    'listOutbound' | 'listLegacyWelcomeAccountIds' | 'hasOutboundInvoice'
  >;
  /** First UTC day the 21.gifts recovery share is required for a payout. */
  recoveryShareRequiredFrom?: string | null;
}

/** Body fields the issue action reads. */
export interface IssueGiftInvoiceInput {
  /** Raw recipient Lightning Address. */
  address: string;
  /** Amount in millisatoshis. */
  amountMsat: number;
  /** Optional LUD-12 comment. */
  comment?: string;
  /** Daily trigger post id; canonical welcome payouts deliberately omit it. */
  messageId?: string;
  /** Moderator trigger message id. */
  groupMessageId?: string;
  /** Raw USD amount string. */
  amountUsd?: string;
  /** Server-decided payout provenance; never copied from the public request body. */
  serverPayoutKind?: 'welcome';
  /** Trusted booked UTC payout day for the shop-payment window. */
  shopPaymentUtcDay?: string;
}

/** Issue action result: an invoice, or the HTTP error to return. */
export type IssueGiftInvoiceResult =
  | { ok: true; invoice: GiftInvoice }
  | { ok: false; status: 400 | 403 | 409 | 502 | 503; error: string; code?: 'credit_closed' };

const inMemoryWelcomeReservations = new WeakMap<
  InvoiceStore,
  InMemoryWelcomeInvoiceReservationStore
>();

function welcomeReservationsFor(deps: GiftActionDeps): WelcomeInvoiceReservationStore {
  if (deps.welcomeReservations !== undefined) return deps.welcomeReservations;
  const existing = inMemoryWelcomeReservations.get(deps.store);
  if (existing !== undefined) return existing;
  const created = new InMemoryWelcomeInvoiceReservationStore();
  inMemoryWelcomeReservations.set(deps.store, created);
  return created;
}

/**
 * Persist a proven gift with the paying wallet label.
 *
 * @param deps - Action collaborators.
 * @param invoice - Proven invoice.
 * @param paidAtMs - Settlement clock.
 * @param fiat - Snapshot for the gift row.
 * @param sourceWallet - Paying wallet label (the Fond username).
 * @param kindOverride - Decided kind that overrides the invoice-derived kind.
 * @returns Resolves after the recorder call; recorder failures are logged and swallowed.
 */
export async function persistProvenGift(
  deps: GiftActionDeps,
  invoice: GiftInvoice,
  paidAtMs: number,
  fiat: FiatAmounts | null,
  sourceWallet: string,
  kindOverride?: GiftKind,
): Promise<void> {
  const giftRecorder = deps.giftRecorder ?? new NoopGiftRecorder();
  const kind =
    kindOverride ??
    (invoice.groupMessageId !== undefined
      ? 'moderator'
      : invoice.comment === 'Welcome'
        ? 'welcome'
        : 'daily');
  try {
    await giftRecorder.recordOutbound({
      paidAt: new Date(paidAtMs),
      amountSats: Math.floor(invoice.amountMsat / 1000),
      feeSats: 0,
      recipientWosUser: recipientHandleFromAddress(invoice.address),
      lightningInvoice: invoice.pr,
      description:
        kind === 'moderator'
          ? '21gifts moderator'
          : kind === 'welcome'
            ? WELCOME_GIFT_DESCRIPTION
            : '21gifts daily',
      kind,
      sourceWallet,
      fiat,
    });
  } catch {
    logEvent('gifts.record_failed', { id: invoice.id });
  }
}

/**
 * Attach the platform gift reply under the triggering post.
 *
 * @param deps - Action collaborators.
 * @param invoice - Proven invoice.
 * @param paidAtMs - Settlement clock.
 * @param fiat - Same snapshot as the gift row and forum credit.
 */
async function attachSpendGiftReply(
  deps: GiftActionDeps,
  invoice: GiftInvoice,
  paidAtMs: number,
  fiat: FiatAmounts | null,
): Promise<void> {
  if (invoice.messageId === undefined) {
    return;
  }
  try {
    const replyId = spendGiftReplyId(invoice.id);
    const existing = await deps.messageStore.getById(replyId);
    if (existing !== undefined && existing.deletedAt !== null) {
      return;
    }
    const parent = await deps.messageStore.getById(invoice.messageId);
    const accounts = await deps.authStore.listAccounts();
    const platform = accounts.find((item) => item.isPlatform === true);
    if (parent === undefined || parent.deletedAt !== null || platform === undefined) {
      logEvent('invoice.gift_reply.failed');
      return;
    }
    const sats = Math.floor(invoice.amountMsat / 1000);
    const nameTrim = platform.name?.trim() ?? '';
    const name = nameTrim !== '' ? nameTrim : '21.gifts';
    const text = invoice.comment ?? '';
    const authorPubkey = (await deps.authStore.getNostrPublicKey(platform.id)) ?? null;
    if (parent.parentId !== null) {
      if (existing !== undefined) {
        await deps.messageStore.markDeleted(replyId, new Date(paidAtMs), platform.id);
        return;
      }
      await deps.messageStore.create(
        {
          id: replyId,
          accountId: platform.id,
          name,
          text,
          createdAt: new Date(paidAtMs),
          hasPhoto: false,
          hasVideo: false,
          videoContentType: null,
          contentFp: null,
          ...unsignedNostrDefaults(),
          parentId: invoice.messageId,
          sats,
          nostrPublishState: 'skipped',
          authorPubkey,
        },
        undefined,
        undefined,
        undefined,
        fiat,
      );
      await deps.messageStore.markDeleted(replyId, new Date(paidAtMs), platform.id);
      await deps.messageStore.addReceivedSats(invoice.messageId, sats, fiat);
      return;
    }
    if (existing !== undefined) {
      return;
    }
    await deps.messageStore.create(
      {
        id: replyId,
        accountId: platform.id,
        name,
        text,
        createdAt: new Date(paidAtMs),
        hasPhoto: false,
        hasVideo: false,
        videoContentType: null,
        contentFp: null,
        ...unsignedNostrDefaults(),
        parentId: invoice.messageId,
        sats,
        nostrPublishState: text === '' ? 'skipped' : 'pending',
        authorPubkey,
      },
      undefined,
      undefined,
      undefined,
      fiat,
    );
    await deps.messageStore.addSats(invoice.messageId, sats, fiat);
  } catch {
    logEvent('invoice.gift_reply.failed');
  }
}

/**
 * Insert a platform stipend message in the closed Moderators group after
 * the triggering group message. No-op without `groupMessageId` or a
 * conversation store. Idempotent on the deterministic message id.
 *
 * @param deps - Action collaborators.
 * @param invoice - Proven gift invoice.
 * @param paidAtMs - Settlement clock, epoch milliseconds.
 * @param fiat - Same snapshot as the gift row and forum credit.
 */
async function attachSpendGroupGift(
  deps: GiftActionDeps,
  invoice: GiftInvoice,
  paidAtMs: number,
  fiat: FiatAmounts | null,
): Promise<void> {
  if (invoice.groupMessageId === undefined || deps.conversationStore === undefined) {
    return;
  }
  const conversationStore = deps.conversationStore;
  try {
    const id = spendGroupGiftId(invoice.id);
    const existing = await conversationStore.getMessageById(id);
    if (existing !== undefined) {
      return;
    }
    const row = await conversationStore.getMessageById(invoice.groupMessageId);
    const thread =
      row === undefined ? undefined : await conversationStore.getById(row.conversationId);
    const accounts = await deps.authStore.listAccounts();
    const platform = accounts.find((item) => item.isPlatform === true);
    if (
      row === undefined ||
      thread === undefined ||
      thread.kind !== 'moderator_group' ||
      platform === undefined
    ) {
      logEvent('invoice.group_gift.failed');
      return;
    }
    const recipient = await receiverOf(deps, invoice.address);
    const recipientName = recipient?.name?.trim() ?? '';
    const comment = invoice.comment ?? '';
    const text =
      comment !== '' && recipientName !== ''
        ? `${comment} · ${recipientName}`
        : comment !== ''
          ? comment
          : recipientName;
    const platformNameTrim = platform.name?.trim() ?? '';
    const platformName = platformNameTrim !== '' ? platformNameTrim : '21.gifts';
    await conversationStore.appendMessage(
      {
        id,
        conversationId: thread.id,
        text,
        createdAt: new Date(paidAtMs),
        senderAccountId: platform.id,
        senderPubkey: (await deps.authStore.getNostrPublicKey(platform.id)) ?? null,
        name: platformName,
        sats: Math.floor(invoice.amountMsat / 1000),
        eventId: null,
        nostrPublishState: 'skipped',
        nostrEvent: null,
        claimedUntil: null,
        giftForMessageId: invoice.groupMessageId,
      },
      undefined,
      undefined,
      fiat,
    );
    logEvent('invoice.group_gift.attached', { id: invoice.id });
  } catch {
    logEvent('invoice.group_gift.failed');
  }
}

/**
 * Persist every side effect of a proven invoice (gift row, forum credit,
 * moderator-group stipend). Attach failures are logged inside the helpers and
 * never block the settlement.
 *
 * @param deps - Action collaborators.
 * @param invoice - Proven invoice fields from the stored row.
 * @param paidAtMs - Settlement clock.
 * @param sourceWallet - Paying wallet label.
 * @param fiat - Payment-time snapshot shared by all three writes.
 * @param kindOverride - Durable payout kind when the caller stores one.
 */
export async function settleProvenGift(
  deps: GiftActionDeps,
  invoice: GiftInvoice,
  paidAtMs: number,
  sourceWallet: string,
  fiat: FiatAmounts | null,
  kindOverride?: GiftKind,
): Promise<void> {
  await persistProvenGift(deps, invoice, paidAtMs, fiat, sourceWallet, kindOverride);
  await attachSpendGiftReply(deps, invoice, paidAtMs, fiat);
  await attachSpendGroupGift(deps, invoice, paidAtMs, fiat);
}

/**
 * Issue one gift invoice for a decided payout (`POST /fond/payouts/:id/invoice`).
 * Unpaid invoices past their sweep window are dropped from the store first.
 * After validation, a locked live top-level closed
 * credit is refused before passkey/funding/welcome/post/platform gates.
 * LNURL-pay fetch, BOLT11 check, and invoice persistence follow those gates.
 *
 * @param deps - Action collaborators.
 * @param input - Request fields.
 * @returns The issued invoice, or the HTTP error to return.
 */
export async function issueGiftInvoice(
  deps: GiftActionDeps,
  input: IssueGiftInvoiceInput,
): Promise<IssueGiftInvoiceResult> {
  deps.store.sweep(deps.now());
  const messageId = input.messageId;
  if (messageId !== undefined && MESSAGE_ID_RE.test(messageId)) {
    const canonicalInput = { ...input, messageId: messageId.toLowerCase() };
    return deps.messageStore.withMessageLock(messageId, (lockedStore) =>
      issueGiftInvoiceLocked({ ...deps, messageStore: lockedStore }, canonicalInput),
    );
  }
  return issueGiftInvoiceLocked(deps, input);
}

/** Issue an invoice after the optional forum message lock has been acquired. */
async function issueGiftInvoiceLocked(
  deps: GiftActionDeps,
  input: IssueGiftInvoiceInput,
): Promise<IssueGiftInvoiceResult> {
  const fundingStore = deps.fundingStore;
  let amountUsd: string | undefined;
  if (input.amountUsd !== undefined) {
    const normalized = normalizeAmountUsd(input.amountUsd);
    if (normalized === null) {
      return { ok: false, status: 400, error: 'Expected a JSON body with address and amountMsat' };
    }
    amountUsd = normalized;
  }
  if (
    (input.messageId !== undefined && !MESSAGE_ID_RE.test(input.messageId)) ||
    (input.messageId !== undefined && input.groupMessageId !== undefined) ||
    (input.groupMessageId !== undefined && !MESSAGE_ID_RE.test(input.groupMessageId))
  ) {
    return { ok: false, status: 400, error: 'Expected a JSON body with address and amountMsat' };
  }

  const address = spendLookupAddress(input.address, deps.lnurlServer);
  if (address === null) {
    return {
      ok: false,
      status: 400,
      error: 'Not a valid Lightning Address (expected name@domain)',
    };
  }
  const amountMsat = input.amountMsat;
  if (amountMsat < GIFT_INVOICE_MIN_MSAT || amountMsat > GIFT_INVOICE_MAX_MSAT) {
    return { ok: false, status: 400, error: 'Expected a JSON body with address and amountMsat' };
  }

  const forumMessage =
    input.messageId === undefined ? undefined : await deps.messageStore.getById(input.messageId);
  if (
    forumMessage !== undefined &&
    forumMessage.deletedAt === null &&
    forumMessage.parentId === null &&
    forumMessage.goalClosedAt instanceof Date
  ) {
    logEvent('invoice.credit_closed', { messageId: forumMessage.id });
    return {
      ok: false,
      status: 409,
      error: 'This credit no longer collects',
      code: 'credit_closed',
    };
  }

  const receiver = await accountByReceivingAddress(deps.authStore, address, deps.lnurlServer);
  if (receiver === undefined && (await passkeyWithoutWallet(deps, address))) {
    logEvent('invoice.wallet_required', { address });
    return { ok: false, status: 403, error: 'Wallet required' };
  }
  if (receiver === undefined || !(await deps.authStore.accountHasPasskey(receiver.account.id))) {
    logEvent('invoice.passkey_required', { address });
    return { ok: false, status: 403, error: 'Passkey required' };
  }
  const account = receiver.account;

  let welcomed: Promise<boolean> | undefined;
  const welcomeRefused = (): Promise<boolean> => {
    if (input.comment !== 'Welcome') return Promise.resolve(false);
    welcomed ??= accountWelcomed({
      auth: deps.authStore,
      messages: deps.messageStore,
      gifts: deps.giftStore,
      account,
    });
    return welcomed;
  };
  const welcomeRequest: WelcomeExceptionRequest = {
    amountMsat,
    ...(amountUsd === undefined ? {} : { amountUsd }),
    ...(input.comment === undefined ? {} : { comment: input.comment }),
    ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
    ...(input.groupMessageId === undefined ? {} : { groupMessageId: input.groupMessageId }),
  };
  const canonicalWelcome = canonicalWelcomeRequest(welcomeRequest);
  const welcomeReservations = welcomeReservationsFor(deps);
  const reservedAt = deps.now();
  const reservationId = newInvoiceId();
  let welcomeReservationAccountId: string | undefined;
  let serverPayoutKind: 'welcome' | undefined;
  if (
    await welcomeShopPaymentException(
      deps.fetchImpl,
      async () => isWelcomeRecipient(account) && !(await welcomeRefused()),
      welcomeRequest,
    )
  ) {
    try {
      const reserved = await welcomeReservations.reserve(
        account.id,
        reservationId,
        new Date(reservedAt),
        new Date(reservedAt + GIFT_INVOICE_TTL_MS),
      );
      if (!reserved) {
        return { ok: false, status: 409, error: 'Welcome invoice already open' };
      }
      welcomeReservationAccountId = account.id;
      serverPayoutKind = input.serverPayoutKind ?? 'welcome';
    } catch {
      return { ok: false, status: 503, error: 'Welcome invoice reservation unavailable' };
    }
  }
  const genuineWelcome = serverPayoutKind === 'welcome' && canonicalWelcome;
  let keepWelcomeReservation = false;

  try {
    const { eligible } = await loadPayoutEligibility(
      fundingStore,
      deps.authStore,
      account,
      deps.now(),
      deps.recoveryShareRequiredFrom ?? null,
      genuineWelcome ? undefined : deps.walletTransfers,
      input.shopPaymentUtcDay,
    );
    if (!eligible) {
      logEvent('invoice.funding_required', { address });
      return { ok: false, status: 403, error: 'Funding grant required' };
    }

    // With a groupMessageId the check waits until it is resolved: a resolved
    // moderator payout is recorded as `moderator`, not as a welcome.
    if (input.groupMessageId === undefined && (await welcomeRefused())) {
      logEvent('invoice.welcome_already_paid', { address });
      return { ok: false, status: 409, error: 'Welcome gift already paid' };
    }

    let resolvedGroupMessageId: string | undefined;
    if (input.messageId !== undefined) {
      const message = forumMessage;
      if (
        message === undefined ||
        message.deletedAt !== null ||
        message.parentId !== null ||
        message.accountId === null ||
        message.accountId !== account.id
      ) {
        logEvent('invoice.forum_post_required', { address });
        return { ok: false, status: 403, error: 'Forum post required' };
      }
      if (
        message.hasPhoto !== true &&
        message.hasVideo !== true &&
        !(Number(message.photoCount) > 0)
      ) {
        logEvent('invoice.forum_post_required', { address });
        return { ok: false, status: 403, error: 'Forum post required' };
      }
      const accounts = await deps.authStore.listAccounts();
      const platform = accounts.find((item) => item.isPlatform === true);
      if (platform === undefined) {
        return { ok: false, status: 503, error: 'Platform account is not configured' };
      }
    } else {
      const hasPosted = await accountHasPosted(deps.messageStore, account);
      if (!hasPosted) {
        logEvent('invoice.forum_post_required', { address });
        return { ok: false, status: 403, error: 'Forum post required' };
      }
      if (input.groupMessageId !== undefined) {
        // Display only: a failing lookup must never block the payout.
        try {
          const conversationStore = deps.conversationStore;
          const row =
            conversationStore === undefined
              ? undefined
              : await conversationStore.getMessageById(input.groupMessageId);
          const thread =
            conversationStore === undefined || row === undefined
              ? undefined
              : await conversationStore.getById(row.conversationId);
          const accounts = await deps.authStore.listAccounts();
          const platform = accounts.find((item) => item.isPlatform === true);
          if (
            conversationStore !== undefined &&
            row !== undefined &&
            thread !== undefined &&
            thread.kind === 'moderator_group' &&
            row.senderAccountId === account.id &&
            !(isModeratorGroupMember(account) && !earnsModeratorGroupPay(account)) &&
            platform !== undefined
          ) {
            resolvedGroupMessageId = input.groupMessageId;
          }
        } catch {
          resolvedGroupMessageId = undefined;
        }
        if (resolvedGroupMessageId === undefined) {
          logEvent('invoice.group_message_ignored', { address });
        }
      }
    }

    if (
      input.groupMessageId !== undefined &&
      resolvedGroupMessageId === undefined &&
      (await welcomeRefused())
    ) {
      logEvent('invoice.welcome_already_paid', { address });
      return { ok: false, status: 409, error: 'Welcome gift already paid' };
    }

    if (
      input.comment !== 'Welcome' &&
      resolvedGroupMessageId === undefined &&
      deps.gifts !== undefined
    ) {
      let outbound: Awaited<ReturnType<GiftStore['listOutbound']>>;
      try {
        outbound = await deps.gifts.listOutbound();
      } catch {
        return { ok: false, status: 503, error: 'Gift ledger unreadable' };
      }
      if (
        welcomeGiftPaidOnUtcDay(outbound, address, new Date(deps.now()).toISOString().slice(0, 10))
      ) {
        logEvent('invoice.welcome_paid', { address });
        return { ok: false, status: 403, error: 'Welcome gift already paid' };
      }
    }

    const fetchArgs: {
      address: string;
      amountMsat: number;
      comment?: string;
      fetchImpl: FetchFn;
    } = {
      address: receiver.receiving.address,
      amountMsat,
      fetchImpl: lnurlServerFetch(deps.lnurlServer, deps.fetchImpl, deps.authStore),
    };
    if (input.comment !== undefined) {
      fetchArgs.comment = input.comment;
    }
    const fetched = await requestGiftInvoice(fetchArgs);
    if (!fetched.ok) {
      logEvent('invoice.issue_failed', { address });
      return { ok: false, status: 502, error: ISSUE_ERROR };
    }

    const decoded = decodeBolt11(fetched.pr);
    if (decoded === null || decoded.amountMsat !== amountMsat) {
      logEvent('invoice.issue_failed', { address });
      return { ok: false, status: 502, error: ISSUE_ERROR };
    }

    const now = genuineWelcome ? reservedAt : deps.now();
    const id = genuineWelcome ? reservationId : newInvoiceId();
    const invoice: GiftInvoice = {
      id,
      address: receiver.receiving.address,
      pr: fetched.pr,
      paymentHash: decoded.paymentHash,
      amountMsat,
      createdAt: now,
      expiresAt: now + GIFT_INVOICE_TTL_MS,
      ...(input.comment === undefined ? {} : { comment: input.comment }),
      ...(input.messageId === undefined
        ? {}
        : { messageId: input.messageId, comment: input.comment ?? '' }),
      ...(resolvedGroupMessageId === undefined
        ? {}
        : { groupMessageId: resolvedGroupMessageId, comment: input.comment ?? '' }),
      ...(input.comment === 'Welcome' &&
      input.messageId === undefined &&
      resolvedGroupMessageId === undefined
        ? { comment: 'Welcome' }
        : {}),
      ...(amountUsd === undefined ? {} : { amountUsd }),
      ...(welcomeReservationAccountId === undefined ? {} : { welcomeReservationAccountId }),
    };
    deps.store.put(invoice);
    keepWelcomeReservation = true;
    logEvent('invoice.issued', { id, address, amountMsat });
    return { ok: true, invoice };
  } finally {
    if (welcomeReservationAccountId !== undefined && !keepWelcomeReservation) {
      await welcomeReservations.release(welcomeReservationAccountId, reservationId);
    }
  }
}
