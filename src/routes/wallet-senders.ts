/** Authenticated wallet sender lookup route. */
import { Hono } from 'hono';
import { resolveSession } from '@/lib/auth/service';
import type { AuthStore } from '@/lib/auth/store';
import { readCappedText } from '@/lib/capped-body';
import { IpRateLimiter } from '@/lib/ip-rate-limit';
import { logEvent } from '@/lib/log';
import type { WalletStore } from '@/lib/wallet-store';
import { bearerToken } from '@/routes/me';

/** Dependencies of the sender lookup route. */
export interface WalletSenderRouteDeps {
  /** Session and sender accounts. */
  authStore: AuthStore;
  /** Payment lookup. */
  walletStore: Pick<WalletStore, 'findPaymentSenders'>;
  /** Epoch millisecond clock. */
  now: () => number;
  /** Optional per-account limiter. */
  limiter?: IpRateLimiter;
}

type Key = { id: string; invoice: string | null; paymentHash: string | null };

function parsePayments(body: unknown): Key[] | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const payments = (body as { payments?: unknown }).payments;
  if (!Array.isArray(payments) || payments.length < 1 || payments.length > 32) return null;
  const keys: Key[] = [];
  const seen = new Set<string>();
  for (const item of payments) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const { id, invoice, paymentHash } = item as {
      id?: unknown;
      invoice?: unknown;
      paymentHash?: unknown;
    };
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) return null;
    if (
      invoice !== null &&
      invoice !== undefined &&
      (typeof invoice !== 'string' ||
        invoice.length === 0 ||
        invoice.length > 4096 ||
        invoice.includes('\u0000'))
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
      invoice: (invoice as string | null | undefined) ?? null,
      paymentHash: typeof paymentHash === 'string' ? paymentHash.toLowerCase() : null,
    });
  }
  return keys;
}

/**
 * Build the authenticated sender lookup route.
 * @param deps - Auth, wallet store, clock, and optional limiter.
 * @returns A Hono app serving `POST /me/wallet/senders`.
 */
export function walletSenderRoutes(deps: WalletSenderRouteDeps): Hono {
  const limiter = deps.limiter ?? new IpRateLimiter(60);
  return new Hono().post('/me/wallet/senders', async (c) => {
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
      return c.json({ error: 'Invalid sender lookup' }, 400);
    }
    const keys = parsePayments(body);
    if (keys === null) return c.json({ error: 'Invalid sender lookup' }, 400);
    try {
      const matches = await deps.walletStore.findPaymentSenders(account.id, keys);
      const senders: Array<{ id: string; accountId: string; username: string }> = [];
      for (const key of keys) {
        const ids = matches.get(key.id);
        const senderId = ids?.length === 1 ? ids[0] : undefined;
        if (senderId === undefined) continue;
        const sender = await deps.authStore.getAccount(senderId);
        if (sender === undefined || sender.isPlatform === true || !sender.username?.trim())
          continue;
        senders.push({ id: key.id, accountId: sender.id, username: sender.username });
      }
      return c.json({ senders }, 200);
    } catch {
      logEvent('wallet_senders.lookup.failed', { accountId: account.id });
      return c.json({ error: 'Sender lookup is unavailable' }, 503);
    }
  });
}
