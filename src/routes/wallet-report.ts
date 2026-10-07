/** Authenticated wallet report ingestion route. */

import { Hono } from 'hono';
import { resolveSession } from '@/lib/auth/service';
import type { AuthStore } from '@/lib/auth/store';
import { readCappedText } from '@/lib/capped-body';
import type { LnurlServerConfig } from '@/lib/config';
import { IpRateLimiter } from '@/lib/ip-rate-limit';
import { logEvent } from '@/lib/log';
import type { MessageStore } from '@/lib/message-store';
import type { PosStore } from '@/lib/pos-store';
import { walletPaymentClassifier } from '@/lib/wallet-category';
import { parseWalletReport } from '@/lib/wallet-report';
import type { WalletPaymentRecord, WalletStore } from '@/lib/wallet-store';
import { bearerToken } from '@/routes/me';

/** Largest accepted wallet report body, in bytes. */
export const WALLET_REPORT_BODY_LIMIT_BYTES = 1024 * 1024;

/** Per-account wallet report cap inside the shared one-minute limiter window. */
export const WALLET_REPORTS_PER_MINUTE = 60;

/** Collaborators required by the wallet report route. */
export interface WalletReportRouteDeps {
  /** Session and wallet-counterparty account store. */
  authStore: AuthStore;
  /** Balance and reported-payment persistence. */
  walletStore: WalletStore;
  /** Forum invoice, zap, message, and shop lookups. */
  messages: MessageStore;
  /** Point-of-sale charge lookup. */
  posStore: PosStore;
  /** Self-hosted receiving-address configuration, when enabled. */
  lnurlServer?: LnurlServerConfig;
  /** Clock returning epoch milliseconds. */
  now: () => number;
  /** Optional injected per-account limiter. */
  limiter?: IpRateLimiter;
}

/**
 * Build the authenticated wallet report route mounted at `/`.
 *
 * @param deps - Auth, persistence, classification, clock, and optional limiter dependencies.
 * @returns A Hono app serving `POST /me/wallet/report`.
 */
export function walletReportRoutes(deps: WalletReportRouteDeps): Hono {
  const limiter = deps.limiter ?? new IpRateLimiter(WALLET_REPORTS_PER_MINUTE);
  return new Hono().post('/me/wallet/report', async (c) => {
    const nowMs = deps.now();
    const token = bearerToken(c.req.header('authorization'));
    const account = token === null ? null : await resolveSession(deps.authStore, nowMs, token);
    if (account === null) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (!limiter.allow(account.id, nowMs)) {
      return c.json({ error: 'Too many requests' }, 429);
    }
    const text = await readCappedText(c.req.raw, WALLET_REPORT_BODY_LIMIT_BYTES);
    if (text === null) {
      return c.json({ error: 'Request body is too large' }, 413);
    }
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      return c.json({ error: 'Invalid wallet report' }, 400);
    }
    const parsed = parseWalletReport(body, nowMs);
    if (!parsed.ok) {
      return c.json({ error: 'Invalid wallet report' }, 400);
    }

    try {
      const byId = new Map<string, (typeof parsed.report.payments)[number]>();
      for (const payment of parsed.report.payments) {
        byId.delete(payment.paymentId);
        byId.set(payment.paymentId, payment);
      }
      const classify = walletPaymentClassifier(deps, account.id);
      const seenAt = new Date(nowMs);
      // Payments are classified concurrently; the database pool bounds the parallel lookups.
      const records: WalletPaymentRecord[] = await Promise.all(
        [...byId.values()].map(async (payment) => ({
          ...payment,
          ...(await classify(payment)),
          accountId: account.id,
          firstSeenAt: new Date(seenAt.getTime()),
          updatedAt: new Date(seenAt.getTime()),
        })),
      );
      await deps.walletStore.recordBalance({
        id: crypto.randomUUID(),
        accountId: account.id,
        balanceSats: parsed.report.balanceSats,
        syncedAt: parsed.report.syncedAt,
        receivedAt: seenAt,
      });
      await deps.walletStore.upsertPayments(records);
      return c.json({ acknowledgedIds: records.map((row) => row.paymentId) }, 200);
    } catch {
      logEvent('wallet_report.write.failed', { accountId: account.id });
      return c.json({ error: 'Wallet data is unavailable' }, 503);
    }
  });
}
