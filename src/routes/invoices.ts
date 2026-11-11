import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { earnsModeratorGroupPay, isModeratorGroupMember } from '@/lib/auth/roles';
import type { Account, AuthStore } from '@/lib/auth/store';
import { decodeBolt11 } from '@/lib/bolt11';
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
import { MESSAGE_LIST_LIMIT, unsignedNostrDefaults } from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import { fiatFromUsd, normalizeAmountUsd, type FiatAmounts } from '@/lib/money';
import { preimageMatchesHash } from '@/lib/proof';
import type { FiatRateBook } from '@/lib/usd-fiat-store';
import { effectiveStatus } from '@/lib/funding';
import { InMemoryFundingStore, type FundingStore } from '@/lib/funding-store';
import { loadPayoutEligibility } from '@/lib/payout-eligibility';
import { checkSpendAuth } from '@/lib/spend-auth';
import { welcomeGiftPaidOnUtcDay } from '@/lib/spend-instruction';
import {
  NoopGiftRecorder,
  recipientHandleFromAddress,
  type GiftRecorder,
} from '@/lib/gift-recorder';
import { logEvent } from '@/lib/log';
import { accountWelcomed } from '@/lib/welcome-media';
import { MESSAGE_ID_RE } from '@/routes/messages';

/**
 * Spend-worker invoice routes: check passkey eligibility, a funding grant
 * with the member's 21.gifts recovery share (`loadPayoutEligibility`, which
 * applies `eligibleToday`), and a live top-level forum post, fetch a recipient
 * BOLT11 via LNURL-pay, then accept the payment preimage as proof. A proof
 * with `messageId` attaches a platform gift-reply when that message is a
 * top-level post. If `messageId` is already a reply, the proof persists a
 * deterministic `spendGiftReplyId` marker under that reply, `markDeleted`
 * so live `listReplies` omits it, then `addReceivedSats`s the reply. A live existing
 * marker is `markDeleted` only and does not `addReceivedSats`. Platform gift-replies
 * do not notify. The api does not pay.
 */

/** Collaborators the invoice routes need. */
export interface InvoiceRouteDeps {
  /** `SPEND_API_TOKEN` (blank/undefined → 503). */
  spendApiToken: string | undefined;
  /** Issued-invoice store. */
  store: InvoiceStore;
  /**
   * Auth store for receiving address → account (by username), passkey,
   * platform, custodial pubkey, and recovery share lookup. Distinct from
   * {@link InvoiceStore} (`store`).
   */
  authStore: Pick<
    AuthStore,
    | 'getAccountByUsername'
    | 'accountHasPasskey'
    | 'listAccounts'
    | 'getNostrPublicKey'
    | 'hasRecoveryShareForVerifiedWallet'
  >;
  /**
   * Forum store for live top-level post lookup, GET `/posted` `hasMedia`,
   * welcome media, gift-reply insert, and GET `/posted` `messageId`. Distinct
   * from {@link InvoiceStore} (`store`).
   */
  messageStore: Pick<
    MessageStore,
    | 'accountHasLiveTopLevelPost'
    | 'accountHasLiveTopLevelMediaPost'
    | 'latestLiveTopLevelMediaId'
    | 'accountHasWelcomeGift'
    | 'getById'
    | 'addSats'
    | 'addReceivedSats'
    | 'create'
    | 'listPostsByAccount'
    | 'markDeleted'
    | 'withMessageLock'
  >;
  /** Clock, epoch milliseconds. */
  now: () => number;
  /** Injected fetch for LNURL-pay (wallet-backed host stays internal). */
  fetchImpl: FetchFn;
  /**
   * LNURL server config. A member is looked up by their wallet-backed
   * `<username>@<host of PUBLIC_BASE_URL>`; omitted → no member is found.
   */
  lnurlServer?: LnurlServerConfig;
  /**
   * Outbound house gifts. A `welcome` gift paid to the member's legacy
   * external address, or one with description `21gifts welcome` recorded under
   * the member's username at or after the wallet verification, counts as a
   * paid welcome gift. Omitted → only the platform `Welcome` reply counts.
   */
  giftStore?: Pick<GiftStore, 'listOutbound' | 'listLegacyWelcomeAccountIds'>;
  /**
   * Persist a proven gift into `gift` for `/gifts/stats`. Default no-op.
   * Insert failures are logged; proof still returns 200.
   */
  giftRecorder?: GiftRecorder;
  /**
   * Conversation store for the moderator-group stipend reference. Optional —
   * when undefined, a `groupMessageId` is accepted but ignored (display only).
   */
  conversationStore?: Pick<ConversationStore, 'getById' | 'getMessageById' | 'appendMessage'>;
  /**
   * Funding grants for spend eligibility (default: empty
   * {@link InMemoryFundingStore}).
   */
  fundingStore?: FundingStore;
  /** First UTC day the 21.gifts recovery share is required for a payout (`RECOVERY_SHARE_REQUIRED_FROM`). Omitted or `null` → not required yet. */
  recoveryShareRequiredFrom?: string | null;
  /**
   * Outbound gifts for the same-UTC-day welcome veto. Omitted → the rule
   * is not applied.
   */
  gifts?: Pick<GiftStore, 'listOutbound'>;
  /**
   * Accepted and not read by proof.
   */
  fiatRates?: FiatRateBook;
}

/** `400` body when a preimage does not hash to the invoice payment hash. */
export const GIFT_PROOF_MISMATCH = 'Proof does not match invoice';

/** 502 text when the recipient Lightning Address did not issue an invoice. */
const ISSUE_ERROR = 'Lightning Address did not issue an invoice';

/** Paying wallet label the legacy Spend bearer routes write. */
const LIGHTNING_SPACE_SOURCE_WALLET = 'lightning.space';

const issueBodySchema = z.object({
  address: z.string(),
  amountMsat: z.number().int(),
  comment: z.string().max(255).optional(),
  messageId: z.string().optional(),
  groupMessageId: z.string().optional(),
  amountUsd: z.string().optional(),
});

const proofBodySchema = z.object({
  id: z.string().min(1),
  preimage: z.string(),
});

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
 * Deterministic gift-reply id for a spend invoice so a retry of the same
 * proof is idempotent on `message.id`.
 *
 * @param invoiceId - Gift invoice id.
 * @returns UUID derived from SHA-256 of the spend-gift prefix and invoice id.
 */
function spendGiftReplyId(invoiceId: string): string {
  const hex = createHash('sha256').update(`21gifts-spend-gift:${invoiceId}`).digest('hex');
  return deterministicUuidFromHex(hex);
}

/**
 * Deterministic Moderators-group stipend message id for a spend invoice so
 * a retry of the same proof is idempotent on `conversation_message.id`.
 *
 * @param invoiceId - Gift invoice id.
 * @returns UUID derived from SHA-256 of `21gifts-spend-group-gift:` and invoice id.
 */
function spendGroupGiftId(invoiceId: string): string {
  const hex = createHash('sha256').update(`21gifts-spend-group-gift:${invoiceId}`).digest('hex');
  return deterministicUuidFromHex(hex);
}

/**
 * Map {@link checkSpendAuth} to a Hono JSON response, or `null` when ok.
 *
 * @param status - Auth check result.
 * @param json - Hono `c.json` bound to the request.
 * @returns 503/401 response, or `null` to continue.
 */
function authGate(
  status: ReturnType<typeof checkSpendAuth>,
  json: (body: { error: string }, status: 401 | 503) => Response,
): Response | null {
  if (status === 'unconfigured') {
    return json({ error: 'Spend invoices are not configured' }, 503);
  }
  if (status === 'unauthorized') {
    return json({ error: 'Unauthorized' }, 401);
  }
  return null;
}

/** Local part of a Lightning Address, as `normalizeLightningAddress` accepts it. */
const LOCAL_PART = /^[a-zA-Z0-9._%+-]+$/;

/**
 * Validate a spend lookup address. Any `local@domain.tld` passes, and so does
 * an address with exactly one `@`, a valid local part, and the configured
 * wallet host, whose `PUBLIC_BASE_URL` host may carry a port or be an IP
 * address that the general check refuses.
 *
 * @param raw - The address as sent by the spend worker.
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
  deps: Pick<InvoiceRouteDeps, 'authStore' | 'lnurlServer'>,
  address: string,
): Promise<Account | undefined> {
  return (await accountByReceivingAddress(deps.authStore, address, deps.lnurlServer))?.account;
}

/**
 * Whether a normalised address belongs to a member with a verified wallet who
 * already has a passkey credential. Missing account → false (fail closed).
 *
 * @param deps - Account and credential lookup, LNURL server config.
 * @param address - Normalised `local@domain`.
 * @returns `true` only when both account and credential exist.
 */
async function addressHasPasskey(
  deps: Pick<InvoiceRouteDeps, 'authStore' | 'lnurlServer'>,
  address: string,
): Promise<boolean> {
  const account = await receiverOf(deps, address);
  return account !== undefined && (await deps.authStore.accountHasPasskey(account.id));
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
  deps: Pick<InvoiceRouteDeps, 'authStore' | 'lnurlServer'>,
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

/**
 * Welcome media flag for `GET /invoices/posted`. Includes the About-me note.
 * Daily `hasMedia` still excludes that note. An account that already received
 * the welcome gift reports no welcome media.
 *
 * @param deps - Auth store, forum store, and optional gift store.
 * @param account - Address owner.
 * @returns `welcomeHasMedia` and the newest media note id (or null).
 */
async function welcomePostedFields(
  deps: Pick<InvoiceRouteDeps, 'authStore' | 'messageStore' | 'giftStore'>,
  account: Pick<Account, 'id' | 'username' | 'sparkPubkeyVerifiedAt'>,
): Promise<{ welcomeHasMedia: boolean; welcomeMessageId: string | null }> {
  if (
    await accountWelcomed({
      auth: deps.authStore,
      messages: deps.messageStore,
      gifts: deps.giftStore,
      account,
    })
  ) {
    return { welcomeHasMedia: false, welcomeMessageId: null };
  }
  const welcomeMessageId = await deps.messageStore.latestLiveTopLevelMediaId(account.id);
  return {
    welcomeHasMedia: welcomeMessageId !== null,
    welcomeMessageId,
  };
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
  messageStore: InvoiceRouteDeps['messageStore'],
  account: Account,
): Promise<boolean> {
  return messageStore.accountHasLiveTopLevelPost(account.id, account.profileMessageId ?? null);
}

/** Collaborators of the extracted issue and proof actions. */
export interface GiftActionDeps {
  /** Issued-invoice store. */
  store: InvoiceStore;
  /** Auth store for receiving address, passkey, platform, and recovery lookups. */
  authStore: InvoiceRouteDeps['authStore'];
  /** Forum store for post, media, gift-reply, and group lookups. */
  messageStore: InvoiceRouteDeps['messageStore'];
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
  /** Daily/welcome trigger post id. */
  messageId?: string;
  /** Moderator trigger message id. */
  groupMessageId?: string;
  /** Raw USD amount string. */
  amountUsd?: string;
}

/** Issue action result: an invoice, or the HTTP error the spend route returned. */
export type IssueGiftInvoiceResult =
  | { ok: true; invoice: GiftInvoice }
  | { ok: false; status: 400 | 403 | 409 | 502 | 503; error: string; code?: 'credit_closed' };

/** Proof action result: a paid body, or the HTTP error the spend route returned. */
export type ProveGiftInvoiceResult =
  | { ok: true; body: { status: 'paid'; id: string; paymentHash: string } }
  | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * One payment-time snapshot for the gift, the forum credit, and the group row.
 *
 * An omitted `amountUsd` is null for USD, CHF, EUR, and PHP. A supplied `amountUsd` is stored as
 * that USD string. CHF, EUR, and PHP stay null. The daily rate book is not read. A string that is
 * not normalized stores null.
 *
 * @param invoice - Proven invoice.
 * @returns Snapshot, or `null` when `amountUsd` was omitted or the string is not normalized.
 */
async function paymentFiat(invoice: GiftInvoice): Promise<FiatAmounts | null> {
  if (invoice.amountUsd === undefined) {
    return null;
  }
  try {
    return fiatFromUsd(invoice.amountUsd, {});
  } catch {
    return null;
  }
}

/**
 * Persist a proven gift with the paying wallet label.
 *
 * @param deps - Action collaborators.
 * @param invoice - Proven invoice.
 * @param paidAtMs - Proof clock.
 * @param fiat - Snapshot for the gift row.
 * @param sourceWallet - Paying wallet label (`lightning.space` or the fond username).
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
 * @param paidAtMs - Proof clock.
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
 * @param paidAtMs - Proof clock, epoch milliseconds.
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
 * never block the paid answer.
 *
 * @param deps - Action collaborators.
 * @param invoice - Proven invoice fields from the stored row.
 * @param paidAtMs - Proof clock.
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
 * Persist every side effect of a proven spend invoice.
 *
 * @param deps - Action collaborators.
 * @param invoice - Proven invoice.
 * @param paidAtMs - Proof clock.
 * @param sourceWallet - Paying wallet label.
 */
async function finishPaid(
  deps: GiftActionDeps,
  invoice: GiftInvoice,
  paidAtMs: number,
  sourceWallet: string,
): Promise<void> {
  const fiat = await paymentFiat(invoice);
  await settleProvenGift(deps, invoice, paidAtMs, sourceWallet, fiat);
}

/**
 * Issue one gift invoice from a request body, exactly as `POST /invoices`
 * did before the extraction. Validation, passkey/funding/post/welcome gates,
 * LNURL-pay fetch, BOLT11 check, and invoice persistence stay in this order.
 *
 * @param deps - Action collaborators.
 * @param input - Request fields.
 * @returns The issued invoice, or the HTTP error to return.
 */
export async function issueGiftInvoice(
  deps: GiftActionDeps,
  input: IssueGiftInvoiceInput,
): Promise<IssueGiftInvoiceResult> {
  const messageId = input.messageId;
  if (messageId !== undefined && MESSAGE_ID_RE.test(messageId)) {
    return deps.messageStore.withMessageLock(messageId, (lockedStore) =>
      issueGiftInvoiceLocked({ ...deps, messageStore: lockedStore }, input),
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

  const { eligible } = await loadPayoutEligibility(
    fundingStore,
    deps.authStore,
    account,
    deps.now(),
    deps.recoveryShareRequiredFrom ?? null,
  );
  if (!eligible) {
    logEvent('invoice.funding_required', { address });
    return { ok: false, status: 403, error: 'Funding grant required' };
  }

  const welcomeRefused = async (): Promise<boolean> =>
    input.comment === 'Welcome' &&
    (await accountWelcomed({
      auth: deps.authStore,
      messages: deps.messageStore,
      gifts: deps.giftStore,
      account,
    }));
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
    if (message.goalClosedAt instanceof Date) {
      logEvent('invoice.credit_closed', { messageId: message.id });
      return {
        ok: false,
        status: 409,
        error: 'This credit no longer collects',
        code: 'credit_closed',
      };
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

  const now = deps.now();
  const id = newInvoiceId();
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
  };
  deps.store.put(invoice);
  logEvent('invoice.issued', { id, address, amountMsat });
  return { ok: true, invoice };
}

/**
 * Prove one issued invoice with its preimage, including idempotent repeats,
 * and run the paid side effects with the given paying wallet label.
 *
 * @param deps - Action collaborators.
 * @param input - Invoice id, preimage, and paying wallet label.
 * @returns A paid body, or the HTTP error to return.
 */
export async function proveGiftInvoice(
  deps: GiftActionDeps,
  input: { id: string; preimage: string; sourceWallet: string },
): Promise<ProveGiftInvoiceResult> {
  const invoice = deps.store.get(input.id);
  if (invoice === undefined) {
    return { ok: false, status: 404, error: 'Invoice not found' };
  }
  const now = deps.now();
  if (invoice.paidAt !== undefined) {
    if (
      invoice.preimage !== undefined &&
      invoice.preimage === input.preimage.trim().toLowerCase() &&
      preimageMatchesHash(input.preimage, invoice.paymentHash)
    ) {
      await finishPaid(deps, invoice, invoice.paidAt, input.sourceWallet);
      return {
        ok: true,
        body: { status: 'paid', id: invoice.id, paymentHash: invoice.paymentHash },
      };
    }
    return { ok: false, status: 409, error: 'Invoice already paid' };
  }
  if (preimageMatchesHash(input.preimage, invoice.paymentHash)) {
    const preimage = input.preimage.trim().toLowerCase();
    deps.store.markPaid(invoice.id, preimage, now);
    logEvent('invoice.paid', { id: invoice.id, paymentHash: invoice.paymentHash });
    await finishPaid(deps, invoice, now, input.sourceWallet);
    return {
      ok: true,
      body: { status: 'paid', id: invoice.id, paymentHash: invoice.paymentHash },
    };
  }
  if (now >= invoice.expiresAt) {
    return { ok: false, status: 409, error: 'Invoice expired' };
  }
  return { ok: false, status: 400, error: GIFT_PROOF_MISMATCH };
}

/**
 * Build the `/invoices` route group.
 *
 * @param deps - Token, invoice store, auth store, message store, clock, fetch,
 *   optional LNURL server config, optional gift recorder, optional
 *   conversation store, optional funding store.
 * @returns Hono app mounted at `/invoices`.
 */
export function invoiceRoutes(deps: InvoiceRouteDeps): Hono {
  const fundingStore = deps.fundingStore ?? new InMemoryFundingStore();
  return new Hono()
    .get('/passkey', async (c) => {
      const denied = authGate(
        checkSpendAuth(deps.spendApiToken, c.req.header('Authorization')),
        (body, status) => c.json(body, status),
      );
      if (denied !== null) {
        return denied;
      }

      const address = spendLookupAddress(c.req.query('address') ?? '', deps.lnurlServer);
      if (address === null) {
        return c.json({ error: 'Not a valid Lightning Address (expected name@domain)' }, 400);
      }

      const hasPasskey = await addressHasPasskey(deps, address);
      return c.json({ hasPasskey }, 200);
    })
    .get('/eligible', async (c) => {
      const denied = authGate(
        checkSpendAuth(deps.spendApiToken, c.req.header('Authorization')),
        (body, status) => c.json(body, status),
      );
      if (denied !== null) {
        return denied;
      }

      const address = spendLookupAddress(c.req.query('address') ?? '', deps.lnurlServer);
      if (address === null) {
        return c.json({ error: 'Not a valid Lightning Address (expected name@domain)' }, 400);
      }

      const account = await receiverOf(deps, address);
      if (account === undefined || account.role === 'basis') {
        return c.json({ eligible: false, status: 'none' }, 200);
      }
      const nowMs = deps.now();
      const { grant, eligible } = await loadPayoutEligibility(
        fundingStore,
        deps.authStore,
        account,
        nowMs,
        deps.recoveryShareRequiredFrom ?? null,
      );
      return c.json({ eligible, status: effectiveStatus(grant, nowMs) }, 200);
    })
    .get('/posted', async (c) => {
      const denied = authGate(
        checkSpendAuth(deps.spendApiToken, c.req.header('Authorization')),
        (body, status) => c.json(body, status),
      );
      if (denied !== null) {
        return denied;
      }

      const address = spendLookupAddress(c.req.query('address') ?? '', deps.lnurlServer);
      if (address === null) {
        return c.json({ error: 'Not a valid Lightning Address (expected name@domain)' }, 400);
      }

      const receiver = await accountByReceivingAddress(deps.authStore, address, deps.lnurlServer);
      if (receiver === undefined) {
        return c.json(
          {
            hasPosted: false,
            messageId: null,
            postedAt: null,
            hasMedia: false,
            welcomeHasMedia: false,
            welcomeMessageId: null,
          },
          200,
        );
      }
      const { account } = receiver;
      const welcome = await welcomePostedFields(deps, account);
      const excludeId = account.profileMessageId ?? null;
      const hasPosted = await deps.messageStore.accountHasLiveTopLevelPost(account.id, excludeId);
      if (!hasPosted) {
        return c.json(
          {
            hasPosted: false,
            messageId: null,
            postedAt: null,
            hasMedia: false,
            ...welcome,
          },
          200,
        );
      }
      const hasMedia = await deps.messageStore.accountHasLiveTopLevelMediaPost(
        account.id,
        excludeId,
      );
      const posts = await deps.messageStore.listPostsByAccount(account.id, MESSAGE_LIST_LIMIT);
      const newest = posts.find((row) => row.id !== excludeId);
      return c.json(
        {
          hasPosted: true,
          messageId: newest === undefined ? null : newest.id,
          postedAt: newest === undefined ? null : newest.createdAt.toISOString(),
          hasMedia,
          ...welcome,
        },
        200,
      );
    })
    .post('/', async (c) => {
      const denied = authGate(
        checkSpendAuth(deps.spendApiToken, c.req.header('Authorization')),
        (body, status) => c.json(body, status),
      );
      if (denied !== null) {
        return denied;
      }
      deps.store.sweep(deps.now());

      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json({ error: 'Expected a JSON body with address and amountMsat' }, 400);
      }
      const parsed = issueBodySchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with address and amountMsat' }, 400);
      }
      const result = await issueGiftInvoice(
        { ...deps, fundingStore: deps.fundingStore ?? fundingStore },
        {
          address: parsed.data.address,
          amountMsat: parsed.data.amountMsat,
          ...(parsed.data.comment === undefined ? {} : { comment: parsed.data.comment }),
          ...(parsed.data.messageId === undefined ? {} : { messageId: parsed.data.messageId }),
          ...(parsed.data.groupMessageId === undefined
            ? {}
            : { groupMessageId: parsed.data.groupMessageId }),
          ...(parsed.data.amountUsd === undefined ? {} : { amountUsd: parsed.data.amountUsd }),
        },
      );
      if (!result.ok) {
        return c.json(
          result.code === undefined
            ? { error: result.error }
            : { error: result.error, code: result.code },
          result.status,
        );
      }
      return c.json(
        {
          id: result.invoice.id,
          pr: result.invoice.pr,
          paymentHash: result.invoice.paymentHash,
          amountMsat: result.invoice.amountMsat,
        },
        200,
      );
    })
    .post('/proof', async (c) => {
      const denied = authGate(
        checkSpendAuth(deps.spendApiToken, c.req.header('Authorization')),
        (body, status) => c.json(body, status),
      );
      if (denied !== null) {
        return denied;
      }

      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json({ error: 'Expected a JSON body with id and preimage' }, 400);
      }
      const parsed = proofBodySchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with id and preimage' }, 400);
      }
      const result = await proveGiftInvoice(
        { ...deps, fundingStore: deps.fundingStore ?? fundingStore },
        {
          id: parsed.data.id,
          preimage: parsed.data.preimage,
          sourceWallet: LIGHTNING_SPACE_SOURCE_WALLET,
        },
      );
      if (!result.ok) {
        return c.json({ error: result.error }, result.status);
      }
      return c.json(result.body, 200);
    });
}
