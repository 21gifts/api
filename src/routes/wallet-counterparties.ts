/** Authenticated wallet counterparty lookup route. */
import { Hono } from 'hono';
import { resolveSession } from '@/lib/auth/service';
import type { AuthStore } from '@/lib/auth/store';
import { readCappedText } from '@/lib/capped-body';
import { IpRateLimiter } from '@/lib/ip-rate-limit';
import { logEvent } from '@/lib/log';
import type { WalletStore } from '@/lib/wallet-store';
import { bearerToken } from '@/routes/me';

/** Dependencies of the counterparty lookup route. */
export interface WalletCounterpartyRouteDeps {
  /** Session and counterparty accounts. */
  authStore: AuthStore;
  /** Payment lookup. */
  walletStore: Pick<WalletStore, 'findPaymentCounterparties'>;
  /** Epoch millisecond clock. */
  now: () => number;
  /** Optional per-account limiter. */
  limiter?: IpRateLimiter;
}

type Key = {
  id: string;
  direction: 'in' | 'out';
  invoice: string | null;
  paymentHash: string | null;
};

function parsePayments(body: unknown): Key[] | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const payments = (body as { payments?: unknown }).payments;
  if (!Array.isArray(payments) || payments.length < 1 || payments.length > 32) return null;
  const keys: Key[] = [];
  const seen = new Set<string>();
  for (const item of payments) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const {
      id,
      direction,
      invoice: rawInvoice,
      paymentHash: rawPaymentHash,
    } = item as {
      id?: unknown;
      direction?: unknown;
      invoice?: unknown;
      paymentHash?: unknown;
    };
    const invoice = typeof rawInvoice === 'string' ? rawInvoice.trim() || null : rawInvoice;
    const paymentHash = typeof rawPaymentHash === 'string' ? rawPaymentHash.trim() : rawPaymentHash;
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) return null;
    if (direction !== 'in' && direction !== 'out') return null;
    if (
      invoice !== null &&
      invoice !== undefined &&
      (typeof invoice !== 'string' || invoice.length > 4096 || invoice.includes('\u0000'))
    )
      return null;
    if (
      paymentHash !== null &&
      paymentHash !== undefined &&
      (typeof paymentHash !== 'string' || !/^[0-9a-f]{64}$/i.test(paymentHash))
    )
      return null;
    if (
      (invoice === null || invoice === undefined) &&
      (paymentHash === null || paymentHash === undefined)
    )
      return null;
    if (seen.has(id)) continue;
    seen.add(id);
    keys.push({
      id,
      direction,
      invoice: (invoice as string | null | undefined) ?? null,
      paymentHash: typeof paymentHash === 'string' ? paymentHash.toLowerCase() : null,
    });
  }
  return keys;
}

/**
 * Build the authenticated counterparty lookup route.
 * @param deps - Auth, wallet store, clock, and optional limiter.
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
    const text = await readCappedText(c.req.raw, 8192);
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
      const matches = await deps.walletStore.findPaymentCounterparties(account.id, keys);
      const counterparties: Array<{ id: string; accountId: string; username: string }> = [];
      for (const key of keys) {
        const ids = matches.get(key.id);
        const senderId = ids?.length === 1 ? ids[0] : undefined;
        if (senderId === undefined) continue;
        const sender = await deps.authStore.getAccount(senderId);
        if (sender === undefined || sender.isPlatform === true || !sender.username?.trim())
          continue;
        counterparties.push({ id: key.id, accountId: sender.id, username: sender.username });
      }
      return c.json({ counterparties }, 200);
    } catch {
      logEvent('wallet_counterparties.lookup.failed', { accountId: account.id });
      return c.json({ error: 'Counterparty lookup is unavailable' }, 503);
    }
  });
}
