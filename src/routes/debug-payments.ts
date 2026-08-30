import { Hono } from 'hono';
import { bearerMatchesDebugToken } from '@/lib/debug-token';
import { logEvent } from '@/lib/log';
import type { MessageInvoiceAttempt, MessageStore, ZapIngestRow } from '@/lib/message-store';

/**
 * Operator debug surface for forum invoice attempts and zap ingest rows.
 * Authenticated by `DEBUG_TOKEN` (Bearer), not by an end-user session.
 */

/** Collaborators the debug payment routes need. */
export interface DebugPaymentsRouteDeps {
  /** Forum persistence port. */
  store: MessageStore;
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
 * Build the `/debug` payment debug routes (`/invoices`, `/zap-ingests`).
 *
 * @param deps - Message store and optional debug token.
 * @returns A Hono app exposing `GET /invoices` and `GET /zap-ingests`.
 */
export function debugPaymentsRoutes(deps: DebugPaymentsRouteDeps): Hono {
  return new Hono()
    .get('/invoices', async (c) => {
      const gate = gateDebugToken(deps.debugToken, c.req.header('authorization'));
      if (!gate.ok) {
        return c.json(gate.body, gate.status);
      }
      const invoices = await deps.store.listInvoiceAttempts(DEBUG_LIST_LIMIT);
      logEvent('debug.invoices.listed', { count: invoices.length });
      return c.json({ invoices: invoices.map(serializeInvoice) }, 200);
    })
    .get('/zap-ingests', async (c) => {
      const gate = gateDebugToken(deps.debugToken, c.req.header('authorization'));
      if (!gate.ok) {
        return c.json(gate.body, gate.status);
      }
      const ingests = await deps.store.listZapIngests(DEBUG_LIST_LIMIT);
      logEvent('debug.zap_ingests.listed', { count: ingests.length });
      return c.json({ ingests: ingests.map(serializeIngest) }, 200);
    });
}
