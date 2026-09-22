import { Hono } from 'hono';
import type { AuthStore } from '@/lib/auth/store';
import { bearerMatchesDebugToken } from '@/lib/debug-token';
import { logEvent } from '@/lib/log';
import type { MessageInvoiceAttempt, MessageStore, ZapIngestRow } from '@/lib/message-store';
import type { NotificationStore } from '@/lib/notification-store';
import { settleInvoiceManually } from '@/lib/nostr/zap-index';
import type { PushStore } from '@/lib/push-store';
import type { FundingStore } from '@/lib/funding-store';
import type { SpendPing } from '@/lib/spend-ping';

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
  /** Configured operator token, or `undefined` when debug is disabled. */
  debugToken: string | undefined;
}

const DEBUG_LIST_LIMIT = 200;

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
 *   compose (same `eligibleToday` gate as `POST /messages`). Does not take
 *   `postLimiter`; DEBUG_TOKEN settle is not the shared post burst limiter.
 * @returns A Hono app exposing invoice list/manual settle (including whether a
 *   successful settle resumed) and zap-ingest list.
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
