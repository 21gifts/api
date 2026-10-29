import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Account, AuthStore } from '@/lib/auth/store';
import { decodeBolt11 } from '@/lib/bolt11';
import {
  GIFT_INVOICE_MAX_MSAT,
  GIFT_INVOICE_MIN_MSAT,
  GIFT_INVOICE_TTL_MS,
  type LnurlServerConfig,
} from '@/lib/config';
import type { ConversationStore } from '@/lib/conversation-store';
import { WELCOME_GIFT_DESCRIPTION } from '@/lib/gift';
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

const ISSUE_ERROR = 'Lightning Address did not issue an invoice';

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

/**
 * Build the `/invoices` route group.
 *
 * @param deps - Token, invoice store, auth store, message store, clock, fetch,
 *   optional LNURL server config, optional gift recorder, optional
 *   conversation store, optional funding store.
 * @returns Hono app mounted at `/invoices`.
 */
export function invoiceRoutes(deps: InvoiceRouteDeps): Hono {
  const giftRecorder = deps.giftRecorder ?? new NoopGiftRecorder();
  const fundingStore = deps.fundingStore ?? new InMemoryFundingStore();

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

  async function persistProvenGift(
    invoice: GiftInvoice,
    paidAtMs: number,
    fiat: FiatAmounts | null,
  ): Promise<void> {
    try {
      await giftRecorder.recordOutbound({
        paidAt: new Date(paidAtMs),
        amountSats: Math.floor(invoice.amountMsat / 1000),
        feeSats: 0,
        recipientWosUser: recipientHandleFromAddress(invoice.address),
        lightningInvoice: invoice.pr,
        description:
          invoice.groupMessageId !== undefined
            ? '21gifts moderator'
            : invoice.comment === 'Welcome'
              ? WELCOME_GIFT_DESCRIPTION
              : '21gifts daily',
        kind:
          invoice.groupMessageId !== undefined
            ? 'moderator'
            : invoice.comment === 'Welcome'
              ? 'welcome'
              : 'daily',
        sourceWallet: 'lightning.space',
        fiat,
      });
    } catch {
      logEvent('gifts.record_failed', { id: invoice.id });
    }
  }

  async function attachSpendGiftReply(
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
   * @param invoice - Proven gift invoice.
   * @param paidAtMs - Proof clock, epoch milliseconds.
   * @param fiat - Same snapshot as the gift row and forum credit.
   */
  async function attachSpendGroupGift(
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

  async function finishPaid(invoice: GiftInvoice, paidAtMs: number): Promise<void> {
    const fiat = await paymentFiat(invoice);
    await persistProvenGift(invoice, paidAtMs, fiat);
    await attachSpendGiftReply(invoice, paidAtMs, fiat);
    await attachSpendGroupGift(invoice, paidAtMs, fiat);
  }

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
      let amountUsd: string | undefined;
      if (parsed.data.amountUsd !== undefined) {
        const normalized = normalizeAmountUsd(parsed.data.amountUsd);
        if (normalized === null) {
          return c.json({ error: 'Expected a JSON body with address and amountMsat' }, 400);
        }
        amountUsd = normalized;
      }
      if (
        (parsed.data.messageId !== undefined && !MESSAGE_ID_RE.test(parsed.data.messageId)) ||
        (parsed.data.messageId !== undefined && parsed.data.groupMessageId !== undefined) ||
        (parsed.data.groupMessageId !== undefined &&
          !MESSAGE_ID_RE.test(parsed.data.groupMessageId))
      ) {
        return c.json({ error: 'Expected a JSON body with address and amountMsat' }, 400);
      }

      const address = spendLookupAddress(parsed.data.address, deps.lnurlServer);
      if (address === null) {
        return c.json({ error: 'Not a valid Lightning Address (expected name@domain)' }, 400);
      }
      const amountMsat = parsed.data.amountMsat;
      if (amountMsat < GIFT_INVOICE_MIN_MSAT || amountMsat > GIFT_INVOICE_MAX_MSAT) {
        return c.json({ error: 'Expected a JSON body with address and amountMsat' }, 400);
      }

      const receiver = await accountByReceivingAddress(deps.authStore, address, deps.lnurlServer);
      if (receiver === undefined && (await passkeyWithoutWallet(deps, address))) {
        logEvent('invoice.wallet_required', { address });
        return c.json({ error: 'Wallet required' }, 403);
      }
      if (
        receiver === undefined ||
        !(await deps.authStore.accountHasPasskey(receiver.account.id))
      ) {
        logEvent('invoice.passkey_required', { address });
        return c.json({ error: 'Passkey required' }, 403);
      }
      const account = receiver.account;

      const { eligible } = await loadPayoutEligibility(
        fundingStore,
        deps.authStore,
        account,
        deps.now(),
      );
      if (!eligible) {
        logEvent('invoice.funding_required', { address });
        return c.json({ error: 'Funding grant required' }, 403);
      }

      const welcomeRefused = async (): Promise<boolean> =>
        parsed.data.comment === 'Welcome' &&
        (await accountWelcomed({
          auth: deps.authStore,
          messages: deps.messageStore,
          gifts: deps.giftStore,
          account,
        }));
      // With a groupMessageId the check waits until it is resolved: a resolved
      // moderator payout is recorded as `moderator`, not as a welcome.
      if (parsed.data.groupMessageId === undefined && (await welcomeRefused())) {
        logEvent('invoice.welcome_already_paid', { address });
        return c.json({ error: 'Welcome gift already paid' }, 409);
      }

      let resolvedGroupMessageId: string | undefined;
      if (parsed.data.messageId !== undefined) {
        const message = await deps.messageStore.getById(parsed.data.messageId);
        if (
          message === undefined ||
          message.deletedAt !== null ||
          message.parentId !== null ||
          message.accountId === null ||
          message.accountId !== account.id
        ) {
          logEvent('invoice.forum_post_required', { address });
          return c.json({ error: 'Forum post required' }, 403);
        }
        if (
          message.hasPhoto !== true &&
          message.hasVideo !== true &&
          !(Number(message.photoCount) > 0)
        ) {
          logEvent('invoice.forum_post_required', { address });
          return c.json({ error: 'Forum post required' }, 403);
        }
        const accounts = await deps.authStore.listAccounts();
        const platform = accounts.find((item) => item.isPlatform === true);
        if (platform === undefined) {
          return c.json({ error: 'Platform account is not configured' }, 503);
        }
      } else {
        const hasPosted = await accountHasPosted(deps.messageStore, account);
        if (!hasPosted) {
          logEvent('invoice.forum_post_required', { address });
          return c.json({ error: 'Forum post required' }, 403);
        }
        if (parsed.data.groupMessageId !== undefined) {
          // Display only: a failing lookup must never block the payout.
          try {
            const conversationStore = deps.conversationStore;
            const row =
              conversationStore === undefined
                ? undefined
                : await conversationStore.getMessageById(parsed.data.groupMessageId);
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
              platform !== undefined
            ) {
              resolvedGroupMessageId = parsed.data.groupMessageId;
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
        parsed.data.groupMessageId !== undefined &&
        resolvedGroupMessageId === undefined &&
        (await welcomeRefused())
      ) {
        logEvent('invoice.welcome_already_paid', { address });
        return c.json({ error: 'Welcome gift already paid' }, 409);
      }

      if (
        parsed.data.comment !== 'Welcome' &&
        resolvedGroupMessageId === undefined &&
        deps.gifts !== undefined
      ) {
        let outbound: Awaited<ReturnType<GiftStore['listOutbound']>>;
        try {
          outbound = await deps.gifts.listOutbound();
        } catch {
          return c.json({ error: 'Gift ledger unreadable' }, 503);
        }
        if (
          welcomeGiftPaidOnUtcDay(
            outbound,
            address,
            new Date(deps.now()).toISOString().slice(0, 10),
          )
        ) {
          logEvent('invoice.welcome_paid', { address });
          return c.json({ error: 'Welcome gift already paid' }, 403);
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
      if (parsed.data.comment !== undefined) {
        fetchArgs.comment = parsed.data.comment;
      }
      const fetched = await requestGiftInvoice(fetchArgs);
      if (!fetched.ok) {
        logEvent('invoice.issue_failed', { address });
        return c.json({ error: ISSUE_ERROR }, 502);
      }

      const decoded = decodeBolt11(fetched.pr);
      if (decoded === null || decoded.amountMsat !== amountMsat) {
        logEvent('invoice.issue_failed', { address });
        return c.json({ error: ISSUE_ERROR }, 502);
      }

      const now = deps.now();
      const id = newInvoiceId();
      deps.store.put({
        id,
        address: receiver.receiving.address,
        pr: fetched.pr,
        paymentHash: decoded.paymentHash,
        amountMsat,
        createdAt: now,
        expiresAt: now + GIFT_INVOICE_TTL_MS,
        ...(parsed.data.comment === undefined ? {} : { comment: parsed.data.comment }),
        ...(parsed.data.messageId === undefined
          ? {}
          : {
              messageId: parsed.data.messageId,
              comment: parsed.data.comment ?? '',
            }),
        ...(resolvedGroupMessageId === undefined
          ? {}
          : { groupMessageId: resolvedGroupMessageId, comment: parsed.data.comment ?? '' }),
        ...(parsed.data.comment === 'Welcome' &&
        parsed.data.messageId === undefined &&
        resolvedGroupMessageId === undefined
          ? { comment: 'Welcome' }
          : {}),
        ...(amountUsd === undefined ? {} : { amountUsd }),
      });
      logEvent('invoice.issued', { id, address, amountMsat });
      return c.json(
        {
          id,
          pr: fetched.pr,
          paymentHash: decoded.paymentHash,
          amountMsat,
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

      const invoice = deps.store.get(parsed.data.id);
      if (invoice === undefined) {
        return c.json({ error: 'Invoice not found' }, 404);
      }
      const now = deps.now();
      if (invoice.paidAt !== undefined) {
        if (
          invoice.preimage !== undefined &&
          invoice.preimage === parsed.data.preimage.trim().toLowerCase() &&
          preimageMatchesHash(parsed.data.preimage, invoice.paymentHash)
        ) {
          await finishPaid(invoice, invoice.paidAt);
          return c.json({ status: 'paid', id: invoice.id, paymentHash: invoice.paymentHash }, 200);
        }
        return c.json({ error: 'Invoice already paid' }, 409);
      }
      if (preimageMatchesHash(parsed.data.preimage, invoice.paymentHash)) {
        const preimage = parsed.data.preimage.trim().toLowerCase();
        deps.store.markPaid(invoice.id, preimage, now);
        logEvent('invoice.paid', { id: invoice.id, paymentHash: invoice.paymentHash });
        await finishPaid(invoice, now);
        return c.json({ status: 'paid', id: invoice.id, paymentHash: invoice.paymentHash }, 200);
      }
      if (now >= invoice.expiresAt) {
        return c.json({ error: 'Invoice expired' }, 409);
      }
      return c.json({ error: 'Proof does not match invoice' }, 400);
    });
}
