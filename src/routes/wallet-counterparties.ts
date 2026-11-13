/** Authenticated wallet counterparty lookup route. */
import { Hono } from 'hono';
import { resolveSession } from '@/lib/auth/service';
import type { AuthStore } from '@/lib/auth/store';
import { readCappedText } from '@/lib/capped-body';
import { IpRateLimiter } from '@/lib/ip-rate-limit';
import { logEvent } from '@/lib/log';
import type { SparkInvoiceStore } from '@/lib/spark-invoice-store';
import type { WalletStore } from '@/lib/wallet-store';
import { bearerToken } from '@/routes/me';

/** Dependencies of the counterparty lookup route. */
export interface WalletCounterpartyRouteDeps {
  /** Session and counterparty accounts. */
  authStore: AuthStore;
  /** Payment lookup. */
  walletStore: Pick<WalletStore, 'findPaymentCounterparties'>;
  /** Issued member invoices, when free payments are enabled. */
  memberInvoices?: Pick<SparkInvoiceStore, 'memberInvoiceAccountId'>;
  /** Epoch millisecond clock. */
  now: () => number;
  /** Optional per-account limiter. */
  limiter?: IpRateLimiter;
}

type Key = {
  id: string;
  direction: 'in' | 'out';
};

/** Largest accepted counterparty lookup body, in bytes. */
const COUNTERPARTY_LOOKUP_BODY_LIMIT_BYTES = 16384;

function parsePayments(body: unknown): Key[] | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const payments = (body as { payments?: unknown }).payments;
  if (!Array.isArray(payments) || payments.length < 1 || payments.length > 32) return null;
  const keys: Key[] = [];
  const seen = new Set<string>();
  for (const item of payments) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const { id, direction } = item as { id?: unknown; direction?: unknown };
    if (typeof id !== 'string') return null;
    const paymentId = id.trim();
    if (paymentId.length < 1 || paymentId.length > 256) return null;
    if (direction !== 'in' && direction !== 'out') return null;
    if (seen.has(paymentId)) continue;
    seen.add(paymentId);
    keys.push({ id: paymentId, direction });
  }
  return keys;
}

/**
 * Build the authenticated counterparty lookup route for completed reported payments.
 * @param deps - Auth, wallet store, clock, optional member invoices and limiter.
 * @returns A Hono app serving `POST /me/wallet/counterparties`.
 */
export function walletCounterpartyRoutes(deps: WalletCounterpartyRouteDeps): Hono {
  const limiter = deps.limiter ?? new IpRateLimiter(60);
  return new Hono().post('/me/wallet/counterparties', async (c) => {
    const nowMs = deps.now();
    const token = bearerToken(c.req.header('authorization'));
    const account = token === null ? null : await resolveSession(deps.authStore, nowMs, token);
    if (account === null) return c.json({ error: 'Unauthorized' }, 401);
    if (!limiter.allow(account.id, nowMs)) return c.json({ error: 'Too many requests' }, 429);
    const text = await readCappedText(c.req.raw, COUNTERPARTY_LOOKUP_BODY_LIMIT_BYTES);
    if (text === null) return c.json({ error: 'Request body is too large' }, 413);
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      return c.json({ error: 'Invalid counterparty lookup' }, 400);
    }
    const keys = parsePayments(body);
    if (keys === null) return c.json({ error: 'Invalid counterparty lookup' }, 400);
    try {
      const memberInvoices = deps.memberInvoices;
      const matches = await deps.walletStore.findPaymentCounterparties(
        account.id,
        keys,
        memberInvoices === undefined
          ? undefined
          : (invoice) => memberInvoices.memberInvoiceAccountId(invoice),
      );
      const counterparties: Array<{ id: string; accountId: string; username: string }> = [];
      for (const key of keys) {
        const ids = matches.get(key.id);
        const counterpartyId = ids?.length === 1 ? ids[0] : undefined;
        if (counterpartyId === undefined) continue;
        const counterparty = await deps.authStore.getAccount(counterpartyId);
        if (
          counterparty === undefined ||
          counterparty.isPlatform === true ||
          !counterparty.username?.trim()
        )
          continue;
        counterparties.push({
          id: key.id,
          accountId: counterparty.id,
          username: counterparty.username,
        });
      }
      return c.json({ counterparties }, 200);
    } catch {
      logEvent('wallet_counterparties.lookup.failed', { accountId: account.id });
      return c.json({ error: 'Counterparty lookup is unavailable' }, 503);
    }
  });
}
