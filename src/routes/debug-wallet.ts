import { Hono } from 'hono';
import type { AuthStore } from '@/lib/auth/store';
import { parseClientInstant } from '@/lib/client-instant';
import { requireOperator } from '@/lib/operator';
import { logEvent } from '@/lib/log';
import type { WalletPaymentCursor, WalletPaymentRecord, WalletStore } from '@/lib/wallet-store';
import { MESSAGE_ID_RE } from '@/routes/messages';

/** Default number of payment rows in one wallet page. */
const WALLET_PAGE_DEFAULT_LIMIT = 50;

/** Decimal digits only: no sign, exponent, or surrounding whitespace. */
const WALLET_LIMIT_RE = /^[0-9]+$/;

/** Unpadded base64url alphabet. */
const WALLET_CURSOR_RE = /^[A-Za-z0-9_-]+$/;

/** Sub-route of the group mounted at `/debug/accounts`. */
const WALLET_ROUTE = '/:id/wallet';

/**
 * Encode a wallet payment page position as an opaque cursor.
 *
 * The cursor is unpadded base64url of JSON `{ paidAt, paymentId }`, with
 * `paidAt` as the ISO-8601 instant. It is a position only; it carries no
 * account id and no amounts.
 *
 * @param cursor - Paid instant and payment id of the last returned row.
 * @returns An opaque cursor string.
 */
export function encodeWalletPaymentCursor(cursor: WalletPaymentCursor): string {
  return Buffer.from(
    JSON.stringify({ paidAt: cursor.paidAt.toISOString(), paymentId: cursor.paymentId }),
    'utf8',
  ).toString('base64url');
}

/**
 * Decode an opaque wallet payment cursor.
 *
 * Accepts only canonical unpadded base64url of a plain JSON object with
 * exactly `paidAt` (a valid ISO-8601 instant) and `paymentId` (a non-empty
 * string). Every other value, including a padded token, an invalid date, or
 * extra keys, is refused.
 *
 * @param raw - Client-supplied cursor query value.
 * @returns The decoded position, or `null` when the cursor is malformed.
 */
export function decodeWalletPaymentCursor(raw: string): WalletPaymentCursor | null {
  if (!WALLET_CURSOR_RE.test(raw)) {
    return null;
  }
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.toString('base64url') !== raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  if (
    Object.keys(parsed).length !== 2 ||
    !Object.hasOwn(parsed, 'paidAt') ||
    !Object.hasOwn(parsed, 'paymentId')
  ) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const paidAtText = record['paidAt'];
  const paymentId = record['paymentId'];
  if (typeof paidAtText !== 'string' || typeof paymentId !== 'string' || paymentId === '') {
    return null;
  }
  const paidAt = parseClientInstant(paidAtText, Number.MAX_SAFE_INTEGER);
  if (paidAt === null) {
    return null;
  }
  return { paidAt, paymentId };
}

/**
 * Parse the optional `limit` query.
 *
 * @param raw - The `limit` query value, or `undefined` when omitted.
 * @returns The page size, or `null` when `raw` is not a decimal integer 1..500.
 */
function walletPageLimit(raw: string | undefined): number | null {
  if (raw === undefined) {
    return WALLET_PAGE_DEFAULT_LIMIT;
  }
  if (!WALLET_LIMIT_RE.test(raw)) {
    return null;
  }
  const limit = Number(raw);
  return limit >= 1 && limit <= 500 ? limit : null;
}

/** Serialized payment shape returned by `GET /debug/accounts/:id/wallet`. */
interface DebugWalletPayment {
  /** Reporting account id. */
  accountId: string;
  /** Wallet-local stable payment id. */
  paymentId: string;
  /** Whether value entered or left the wallet. */
  direction: string;
  /** Current wallet settlement state. */
  status: string;
  /** Payment amount in whole sats. */
  amountSats: number;
  /** Wallet fee in whole sats. */
  feeSats: number;
  /** Paid instant as ISO-8601. */
  paidAt: string;
  /** Lower-case wallet method identifier. */
  method: string;
  /** BOLT11 payment hash, or null. */
  paymentHash: string | null;
  /** Invoice string, or null. */
  invoice: string | null;
  /** Payment destination, or null. */
  destination: string | null;
  /** Wallet description, or null. */
  description: string | null;
  /** LNURL comment, or null. */
  lnurlComment: string | null;
  /** Server-derived payment category. */
  category: string;
  /** Known counterparty account id, or null. */
  counterpartyAccountId: string | null;
  /** First observation instant as ISO-8601. */
  firstSeenAt: string;
  /** Last changed instant as ISO-8601. */
  updatedAt: string;
}

/**
 * Serialize one stored payment with every date as an ISO-8601 string.
 *
 * @param row - Stored payment row.
 * @returns The JSON-safe payment object.
 */
function serializePayment(row: WalletPaymentRecord): DebugWalletPayment {
  return {
    accountId: row.accountId,
    paymentId: row.paymentId,
    direction: row.direction,
    status: row.status,
    amountSats: row.amountSats,
    feeSats: row.feeSats,
    paidAt: row.paidAt.toISOString(),
    method: row.method,
    paymentHash: row.paymentHash,
    invoice: row.invoice,
    destination: row.destination,
    description: row.description,
    lnurlComment: row.lnurlComment,
    category: row.category,
    counterpartyAccountId: row.counterpartyAccountId,
    firstSeenAt: row.firstSeenAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Collaborators the debug wallet routes need. */
export interface DebugWalletRouteDeps {
  /** Wallet persistence port. */
  walletStore: WalletStore;
  /** Shared auth persistence port, used to 404 an unknown account id. */
  authStore: AuthStore;
  /** Configured operator write token, or `undefined` when debug is disabled. */
  debugToken: string | undefined;
  /** Optional read-only operator bearer; both tokens may read this route. */
  debugReadToken?: string;
  /** Clock returning epoch milliseconds (default: `Date.now`). */
  now?: () => number;
}

/**
 * Build the `/debug/accounts/:id/wallet` route group.
 *
 * Read-only. `DEBUG_TOKEN` and `DEBUG_READ_TOKEN` both pass. One page has the
 * newest balance snapshot, at most `limit` payments newest first, and
 * `nextCursor` only when another row exists.
 *
 * @param deps - Wallet store, auth store, debug tokens, and optional clock.
 * @returns A Hono app exposing `GET /:id/wallet`.
 */
export function debugWalletRoutes(deps: DebugWalletRouteDeps): Hono {
  return new Hono().get(WALLET_ROUTE, requireOperator('read', deps), async (c) => {
    const id = c.req.param('id');
    if (!MESSAGE_ID_RE.test(id)) {
      return c.json({ error: 'Not found' }, 404);
    }
    const account = await deps.authStore.getAccount(id);
    if (account === undefined) {
      return c.json({ error: 'Not found' }, 404);
    }
    const limit = walletPageLimit(c.req.query('limit'));
    if (limit === null) {
      return c.json({ error: 'Invalid limit' }, 400);
    }
    const rawCursor = c.req.query('cursor');
    let after: WalletPaymentCursor | undefined;
    if (rawCursor !== undefined) {
      const decoded = decodeWalletPaymentCursor(rawCursor);
      if (decoded === null) {
        return c.json({ error: 'Invalid cursor' }, 400);
      }
      after = decoded;
    }
    try {
      const [balance, rows] = await Promise.all([
        deps.walletStore.latestBalance(
          id,
          typeof account.sparkPubkeyVerifiedAt === 'number' ? account.sparkPubkey! : null,
        ),
        deps.walletStore.listPayments(id, limit + 1, after),
      ]);
      const page = rows.slice(0, limit);
      const nowMs = (deps.now ?? Date.now)();
      const serializedBalance =
        balance === undefined
          ? null
          : {
              balanceSats: balance.balanceSats,
              syncedAt: balance.syncedAt.toISOString(),
              receivedAt: balance.receivedAt.toISOString(),
              ageSeconds: Math.max(0, Math.floor((nowMs - balance.receivedAt.getTime()) / 1000)),
            };
      logEvent('debug.wallet.shown', { accountId: id, count: page.length });
      const nextCursor =
        rows.length > limit ? page.slice(-1).map(encodeWalletPaymentCursor)[0] : undefined;
      const body = {
        accountId: id,
        balance: serializedBalance,
        payments: page.map(serializePayment),
        ...(nextCursor === undefined ? {} : { nextCursor }),
      };
      return c.json(body, 200);
    } catch {
      logEvent('debug.wallet.failed', { accountId: id });
      return c.json({ error: 'Wallet data is unavailable' }, 503);
    }
  });
}
