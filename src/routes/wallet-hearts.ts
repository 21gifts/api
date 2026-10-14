/** Authenticated wallet heart lookup route. */

import { Hono } from 'hono';
import { resolveSession } from '@/lib/auth/service';
import type { AuthStore } from '@/lib/auth/store';
import { readCappedText } from '@/lib/capped-body';
import { IpRateLimiter } from '@/lib/ip-rate-limit';
import { logEvent } from '@/lib/log';
import type { MessageStore } from '@/lib/message-store';
import { bearerToken } from '@/routes/me';

/** Largest accepted heart lookup body, in bytes. */
export const HEART_LOOKUP_BODY_LIMIT_BYTES = 8192;

/** Per-account heart lookup cap inside the shared one-minute limiter window. */
export const HEART_LOOKUPS_PER_MINUTE = 60;

const HEART_LOOKUP_HASHES_MAX = 32;
const AUTHOR_NAME_MAX_CODE_POINTS = 80;
const TEXT_MAX_CODE_POINTS = 240;
const PAYMENT_HASH_PATTERN = /^[0-9a-f]{64}$/i;

/** Collaborators required by the wallet heart lookup route. */
export interface WalletHeartRouteDeps {
  /** Session store used by {@link resolveSession}. */
  authStore: AuthStore;
  /** Forum invoice and note lookups. */
  messages: Pick<MessageStore, 'findOkInvoiceByPaymentHash' | 'getById'>;
  /** Clock returning epoch milliseconds. */
  now: () => number;
  /** Optional injected per-account limiter. */
  limiter?: IpRateLimiter;
}

/** Clip to `max` Unicode code points and append `…` when characters are dropped. */
function clipToCodePoints(value: string, max: number): string {
  const points = Array.from(value);
  if (points.length <= max) {
    return value;
  }
  return `${points.slice(0, max).join('')}…`;
}

/** Unique lowercase hashes in first-seen order, or `null` when the body is invalid. */
function parseHeartLookupHashes(body: unknown): string[] | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }
  const hashes = (body as { hashes?: unknown }).hashes;
  if (!Array.isArray(hashes) || hashes.length < 1 || hashes.length > HEART_LOOKUP_HASHES_MAX) {
    return null;
  }
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const item of hashes) {
    if (typeof item !== 'string' || !PAYMENT_HASH_PATTERN.test(item)) {
      return null;
    }
    const paymentHash = item.toLowerCase();
    if (seen.has(paymentHash)) {
      continue;
    }
    seen.add(paymentHash);
    unique.push(paymentHash);
  }
  return unique;
}

/**
 * Build the authenticated heart lookup route mounted at `/`.
 *
 * @param deps - Auth, message store, clock, and optional limiter dependencies.
 * @returns A Hono app serving `POST /me/wallet/hearts`.
 */
export function walletHeartRoutes(deps: WalletHeartRouteDeps): Hono {
  const limiter = deps.limiter ?? new IpRateLimiter(HEART_LOOKUPS_PER_MINUTE);
  return new Hono().post('/me/wallet/hearts', async (c) => {
    const nowMs = deps.now();
    const token = bearerToken(c.req.header('authorization'));
    const account = token === null ? null : await resolveSession(deps.authStore, nowMs, token);
    if (account === null) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (!limiter.allow(account.id, nowMs)) {
      return c.json({ error: 'Too many requests' }, 429);
    }
    const text = await readCappedText(c.req.raw, HEART_LOOKUP_BODY_LIMIT_BYTES);
    if (text === null) {
      return c.json({ error: 'Request body is too large' }, 413);
    }
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      return c.json({ error: 'Invalid heart lookup' }, 400);
    }
    const hashes = parseHeartLookupHashes(body);
    if (hashes === null) {
      return c.json({ error: 'Invalid heart lookup' }, 400);
    }

    const hearts: Array<{
      paymentHash: string;
      messageId: string;
      authorName: string;
      text: string;
      deleted: boolean;
    }> = [];
    try {
      for (const paymentHash of hashes) {
        const invoice = await deps.messages.findOkInvoiceByPaymentHash(paymentHash);
        if (invoice === undefined) {
          continue;
        }
        if (invoice.heart !== true) {
          continue;
        }
        if (invoice.payerAccountId !== account.id && invoice.authorAccountId !== account.id) {
          continue;
        }
        if (typeof invoice.messageId !== 'string' || invoice.messageId === '') {
          continue;
        }
        const row = await deps.messages.getById(invoice.messageId);
        const authorName =
          row === undefined ? '' : clipToCodePoints(row.name.trim(), AUTHOR_NAME_MAX_CODE_POINTS);
        const noteText =
          row === undefined ? '' : clipToCodePoints(row.text.trim(), TEXT_MAX_CODE_POINTS);
        const deleted = row === undefined || row.deletedAt !== null;
        hearts.push({
          paymentHash,
          messageId: invoice.messageId,
          authorName,
          text: noteText,
          deleted,
        });
      }
    } catch {
      logEvent('wallet_hearts.lookup.failed', { accountId: account.id });
      return c.json({ error: 'Heart lookup is unavailable' }, 503);
    }
    return c.json({ hearts }, 200);
  });
}
