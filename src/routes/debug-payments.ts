import { Hono } from 'hono';
import type { AuthStore } from '@/lib/auth/store';
import type { LnurlServerConfig } from '@/lib/config';
import { InMemoryConversationStore, type ConversationStore } from '@/lib/conversation-store';
import { replayPayoutWindow } from '@/lib/cutover-replay';
import { bearerMatchesDebugToken } from '@/lib/debug-token';
import { logEvent } from '@/lib/log';
import type { MessageInvoiceAttempt, MessageStore, ZapIngestRow } from '@/lib/message-store';
import type { NotificationStore } from '@/lib/notification-store';
import { settleInvoiceManually } from '@/lib/nostr/zap-index';
import type { PushStore } from '@/lib/push-store';
import { receivingAddress } from '@/lib/receiving-address';
import { effectiveStatus, utcDayKey } from '@/lib/funding';
import { InMemoryFundingStore, type FundingStore } from '@/lib/funding-store';
import { loadPayoutEligibility } from '@/lib/payout-eligibility';
import { InMemoryGiftStore, type GiftStore } from '@/lib/gift-store';
import type { SpendPing } from '@/lib/spend-ping';
import { InMemoryTrustStore, type TrustStore } from '@/lib/trust-store';
import { MESSAGE_ID_RE } from '@/routes/messages';

/**
 * Operator debug surface for `message_invoice` attempts (forum and
 * conversation invoices, including `conversationId` and
 * `conversationMessageId`) and zap ingest rows.
 * Authenticated by `DEBUG_TOKEN` (Bearer), not by an end-user session.
 */

/** Collaborators the debug payment routes need. */
export interface DebugPaymentsRouteDeps {
  /** Forum persistence port. */
  store: MessageStore;
  /** Shared account persistence for payer attribution and notifications. */
  auth: AuthStore;
  /** Clock returning epoch milliseconds. */
  now: () => number;
  /** Optional Web Push persistence used by zap notification fan-out. */
  pushStore?: PushStore;
  /** Optional in-app notification persistence. */
  notificationStore?: NotificationStore;
  /** Optional spend ping after a platform-note compose creates a top-level post. */
  spendPing?: SpendPing;
  /** Optional funding grants; compose spend pings use the same `eligibleToday` gate as `POST /messages`. */
  fundingStore?: FundingStore;
  /** LNURL server config for the spend ping's receiving address; omitted → none. */
  lnurlServer?: LnurlServerConfig;
  /** Moderator group messages for the window replay; omitted → empty. */
  conversationStore?: ConversationStore;
  /** Verifications (welcome triggers) for the window replay; omitted → empty. */
  trustStore?: TrustStore;
  /** Gift ledger for the window replay's already-paid check; omitted → empty. */
  giftStore?: Pick<GiftStore, 'listOutbound'>;
  /** Configured operator token, or `undefined` when debug is disabled. */
  debugToken: string | undefined;
}

const DEBUG_LIST_LIMIT = 200;

/** Longest window `POST /spend-ping` replays in one call. */
const REPLAY_WINDOW_MAX_MS = 48 * 60 * 60 * 1000;

/**
 * Parse the window body `{ from, to, dryRun? }` of `POST /spend-ping`.
 *
 * @param body - Request body object.
 * @param nowMs - Clock.
 * @returns Window in epoch ms, or `null` when it is malformed, empty, longer
 *   than 48 hours, or starts after the clock.
 */
function parseReplayWindow(
  body: object,
  nowMs: number,
): { fromMs: number; toMs: number; dryRun: boolean } | null {
  const { from, to, dryRun } = body as { from?: unknown; to?: unknown; dryRun?: unknown };
  if (typeof from !== 'string' || typeof to !== 'string') {
    return null;
  }
  if (dryRun !== undefined && typeof dryRun !== 'boolean') {
    return null;
  }
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return null;
  }
  if (fromMs >= toMs || toMs - fromMs > REPLAY_WINDOW_MAX_MS || fromMs > nowMs) {
    return null;
  }
  return { fromMs, toMs, dryRun: dryRun === true };
}

/** Shared 503/401 gate matching `/debug/accounts`. */
function gateDebugToken(
  debugToken: string | undefined,
  authorization: string | undefined,
): { ok: true } | { ok: false; status: 503 | 401; body: { error: string } } {
  if (debugToken === undefined || debugToken.trim() === '') {
    return { ok: false, status: 503, body: { error: 'Debug is not configured' } };
  }
  if (!bearerMatchesDebugToken(debugToken, authorization)) {
    return { ok: false, status: 401, body: { error: 'Unauthorized' } };
  }
  return { ok: true };
}

/** Public JSON for one invoice attempt (ISO dates; no secrets). */
function serializeInvoice(row: MessageInvoiceAttempt): Record<string, unknown> {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    messageId: row.messageId,
    payerAccountId: row.payerAccountId,
    authorAccountId: row.authorAccountId,
    amountSats: row.amountSats,
    lightningAddress: row.lightningAddress,
    zapRequest: row.zapRequest,
    result: row.result,
    httpStatus: row.httpStatus,
    pr: row.pr,
    paymentHash: row.paymentHash,
    description: row.description,
    descriptionHash: row.descriptionHash,
    isNip57Invoice: row.isNip57Invoice,
    lnurlResponse: row.lnurlResponse,
    conversationId: row.conversationId ?? null,
    conversationMessageId: row.conversationMessageId ?? null,
    fiatPinned: row.fiatPinned === true,
    amountUsd: row.amountUsd ?? null,
    amountChf: row.amountChf ?? null,
    amountEur: row.amountEur ?? null,
    amountPhp: row.amountPhp ?? null,
  };
}

/** Public JSON for one zap ingest row (ISO dates; no secrets). */
function serializeIngest(row: ZapIngestRow): Record<string, unknown> {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    receiptId: row.receiptId,
    noteEventId: row.noteEventId,
    messageId: row.messageId,
    outcome: row.outcome,
    reason: row.reason,
    amountSats: row.amountSats,
    receiptPubkey: row.receiptPubkey,
    receipt: row.receipt,
  };
}

/**
 * Build the `/debug` payment debug routes.
 *
 * @param deps - Stores, clock, optional debug token, and optional `spendPing` /
 *   `fundingStore` forwarded into `settleInvoiceManually` for platform-note
 *   compose (same `eligibleToday` gate as `POST /messages`) and used by
 *   `POST /spend-ping`. Does not take `postLimiter`; DEBUG_TOKEN settle is not
 *   the shared post burst limiter.
 * @returns A Hono app exposing invoice list/manual settle (including whether a
 *   successful settle resumed), zap-ingest list, and `POST /spend-ping` (replay
 *   one qualifying top-level post onto that post's UTC day; 202
 *   `{ messageId, status: 'accepted' }` or 200
 *   `{ messageId, status: 'skipped', reason }`; never returns the Lightning
 *   address).
 */
export function debugPaymentsRoutes(deps: DebugPaymentsRouteDeps): Hono {
  return new Hono()
    .get('/invoices', async (c) => {
      const gate = gateDebugToken(deps.debugToken, c.req.header('authorization'));
      if (!gate.ok) {
        return c.json(gate.body, gate.status);
      }
      try {
        const invoices = await deps.store.listInvoiceAttempts(DEBUG_LIST_LIMIT);
        logEvent('debug.invoices.listed', { count: invoices.length });
        return c.json({ invoices: invoices.map(serializeInvoice) }, 200);
      } catch {
        logEvent('debug.invoices.list_failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    })
    .post('/invoices/settle', async (c) => {
      const gate = gateDebugToken(deps.debugToken, c.req.header('authorization'));
      if (!gate.ok) {
        return c.json(gate.body, gate.status);
      }
      const body: unknown = await c.req.json().catch(() => null);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return c.json({ error: 'Invalid body' }, 400);
      }
      const paymentHash = (body as { paymentHash?: unknown }).paymentHash;
      const note = (body as { note?: unknown }).note;
      const preimage = (body as { preimage?: unknown }).preimage;
      if (
        typeof paymentHash !== 'string' ||
        typeof note !== 'string' ||
        (preimage !== undefined && typeof preimage !== 'string')
      ) {
        return c.json({ error: 'Invalid body' }, 400);
      }
      try {
        const result = await settleInvoiceManually({
          store: deps.store,
          auth: deps.auth,
          now: deps.now,
          paymentHash,
          note,
          ...(preimage === undefined ? {} : { preimage }),
          ...(deps.pushStore === undefined ? {} : { pushStore: deps.pushStore }),
          ...(deps.notificationStore === undefined
            ? {}
            : { notificationStore: deps.notificationStore }),
          ...(deps.spendPing === undefined ? {} : { spendPing: deps.spendPing }),
          ...(deps.fundingStore === undefined ? {} : { fundingStore: deps.fundingStore }),
          ...(deps.lnurlServer === undefined ? {} : { lnurlServer: deps.lnurlServer }),
        });
        if (result.ok) {
          logEvent('debug.invoices.settled', {
            messageId: result.messageId,
            amountSats: result.amountSats,
          });
          return c.json(
            {
              receiptId: result.receiptId,
              messageId: result.messageId,
              amountSats: result.amountSats,
              resumed: result.resumed,
            },
            200,
          );
        }
        switch (result.reason) {
          case 'shape':
            return c.json({ error: 'Invalid payment hash or preimage' }, 400);
          case 'note':
            return c.json({ error: 'Invalid note' }, 400);
          case 'preimage':
            return c.json({ error: 'Preimage does not match payment hash' }, 400);
          case 'invoice':
            return c.json({ error: 'Invoice not found' }, 404);
          case 'conversation':
            return c.json({ error: 'Conversation invoices cannot be settled' }, 409);
          case 'message':
            return c.json({ error: 'Message not found' }, 404);
          case 'duplicate':
            return c.json({ error: 'Already settled' }, 409);
        }
      } catch {
        logEvent('debug.invoices.settle_failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    })
    .post('/spend-ping', async (c) => {
      const gate = gateDebugToken(deps.debugToken, c.req.header('authorization'));
      if (!gate.ok) {
        return c.json(gate.body, gate.status);
      }
      if (deps.spendPing === undefined) {
        return c.json({ error: 'Spend ping is not configured' }, 503);
      }
      const body: unknown = await c.req.json().catch(() => null);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return c.json({ error: 'Invalid body' }, 400);
      }
      if ('from' in body || 'to' in body) {
        const pingOnDay = deps.spendPing.pingOnDay;
        if (pingOnDay === undefined) {
          return c.json({ error: 'Spend ping is not configured' }, 503);
        }
        const window = 'messageId' in body ? null : parseReplayWindow(body, deps.now());
        if (window === null) {
          return c.json({ error: 'Invalid body' }, 400);
        }
        try {
          const result = await replayPayoutWindow(
            {
              auth: deps.auth,
              messages: deps.store,
              conversations: deps.conversationStore ?? new InMemoryConversationStore(),
              funding: deps.fundingStore ?? new InMemoryFundingStore(),
              trust: deps.trustStore ?? new InMemoryTrustStore(),
              gifts: deps.giftStore ?? new InMemoryGiftStore(),
              spendPing: deps.spendPing,
              pingOnDay: pingOnDay.bind(deps.spendPing),
              ...(deps.lnurlServer === undefined ? {} : { lnurlServer: deps.lnurlServer }),
              now: deps.now,
            },
            window,
          );
          logEvent('debug.spend_ping.replayed', { dryRun: window.dryRun, ...result.totals });
          return c.json(
            {
              from: new Date(window.fromMs).toISOString(),
              to: new Date(window.toMs).toISOString(),
              dryRun: window.dryRun,
              ...result,
            },
            200,
          );
        } catch {
          logEvent('debug.spend_ping.replay_failed');
          return c.json({ error: 'Messages are unavailable' }, 503);
        }
      }
      const messageId = (body as { messageId?: unknown }).messageId;
      if (typeof messageId !== 'string' || !MESSAGE_ID_RE.test(messageId)) {
        return c.json({ error: 'Invalid body' }, 400);
      }
      let message;
      try {
        message = await deps.store.getById(messageId);
      } catch {
        logEvent('debug.spend_ping.failed', { messageId });
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
      if (message === undefined) {
        return c.json({ error: 'Not found' }, 404);
      }
      if (message.deletedAt !== null) {
        return c.json({ error: 'Message is hidden' }, 409);
      }
      if (message.parentId !== null) {
        return c.json({ error: 'Replies are not paid' }, 409);
      }
      if (message.accountId === null) {
        return c.json({ error: 'Account not found' }, 404);
      }
      let account;
      try {
        account = await deps.auth.getAccount(message.accountId);
      } catch {
        logEvent('debug.spend_ping.failed', { messageId });
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
      if (account === undefined) {
        return c.json({ error: 'Account not found' }, 404);
      }
      if (account.profileMessageId === message.id) {
        return c.json({ error: 'Profile notes are not paid' }, 409);
      }
      const address = receivingAddress(account, deps.lnurlServer)?.address ?? null;
      if (address === null) {
        return c.json({ error: 'No Lightning address' }, 409);
      }
      let payout;
      try {
        payout = await loadPayoutEligibility(
          deps.fundingStore ?? new InMemoryFundingStore(),
          deps.auth,
          account,
          deps.now(),
        );
      } catch {
        logEvent('debug.spend_ping.failed', { messageId });
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
      const grant = payout.grant;
      if (!payout.eligible) {
        logEvent('debug.spend_ping.skipped', { messageId, reason: 'not_eligible' });
        return c.json({ error: 'Not eligible' }, 403);
      }
      if (!(
        message.hasPhoto === true ||
        message.hasVideo === true ||
        Number(message.photoCount) > 0
      )) {
        logEvent('debug.spend_ping.skipped', { messageId, reason: 'no_media' });
        return c.json({ error: 'Message has no media' }, 409);
      }
      const day = utcDayKey(message.createdAt.getTime());
      if (day > utcDayKey(deps.now())) {
        return c.json({ error: 'Message is not from today' }, 409);
      }
      const pingOnDay = deps.spendPing.pingOnDay;
      if (pingOnDay === undefined) {
        return c.json({ error: 'Spend ping is not configured' }, 503);
      }
      try {
        const outcome = await pingOnDay.call(
          deps.spendPing,
          address,
          message.id,
          day,
          effectiveStatus(grant, deps.now()),
        );
        if (outcome.status === 'accepted') {
          logEvent('debug.spend_ping.sent', { messageId });
          return c.json({ messageId, status: 'accepted' }, 202);
        }
        if (outcome.status === 'skipped') {
          return c.json({ messageId, status: 'skipped', reason: outcome.reason }, 200);
        }
        logEvent('debug.spend_ping.failed', { messageId });
        return c.json({ error: 'Messages are unavailable' }, 503);
      } catch {
        logEvent('debug.spend_ping.failed', { messageId });
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    })
    .get('/zap-ingests', async (c) => {
      const gate = gateDebugToken(deps.debugToken, c.req.header('authorization'));
      if (!gate.ok) {
        return c.json(gate.body, gate.status);
      }
      try {
        const ingests = await deps.store.listZapIngests(DEBUG_LIST_LIMIT);
        logEvent('debug.zap_ingests.listed', { count: ingests.length });
        return c.json({ ingests: ingests.map(serializeIngest) }, 200);
      } catch {
        logEvent('debug.zap_ingests.list_failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    });
}
