import { Hono } from 'hono';
import { resolveSession } from '@/lib/auth/service';
import { isUniqueViolation } from '@/lib/auth/sql';
import type { Account, AuthStore } from '@/lib/auth/store';
import type { LnurlServerConfig } from '@/lib/config';
import type { FetchFn } from '@/lib/lnurlp';
import { resolveLnurlp } from '@/lib/lnurlp';
import { textHasHashtagToken, type ShopNoteRef } from '@/lib/message-store';
import { logActivityFailure, pingShopActivity, type ActivityPing } from '@/lib/ocp-activity';
import type { FxSpotQuote } from '@/lib/fx-spot';
import type { FxSpotStore } from '@/lib/fx-spot-store';
import {
  POS_CHARGE_TTL_MS,
  POS_PAID_SHOW_MS,
  freezePosFiatCrosses,
  isPosFiatCode,
  parseTypedFiatAmount,
  serializePosCharge,
  type PosCharge,
  type PosFiatCode,
  type PosFiatNumbers,
} from '@/lib/pos-charge';
import type { PosStore } from '@/lib/pos-store';
import { WALLET_REQUIRED, lnurlServerFetch, receivingAddress } from '@/lib/receiving-address';
import type { ShopPayments } from '@/lib/shop-payment';
import { bearerToken } from '@/routes/me';

/**
 * `/pos` — signed-in member point-of-sale amount in whole sats.
 * Settlement goes to the member's receiving address (their verified wallet;
 * without one a charge is refused). The paid watcher marks a charge `paid`;
 * `GET /pos` keeps returning it as `charge` for {@link POS_PAID_SHOW_MS}.
 * Shares the {@link AuthStore} with `/auth` and `/me`.
 */

/**
 * Collaborators the `/pos` routes need. `store`, `authStore`, `now`, and
 * `fetchImpl` are required. The LNURL `fetchImpl` is not the map fetch.
 */
export interface PosRouteDeps {
  /** Charge persistence. */
  store: PosStore;
  /** Shared auth persistence port. */
  authStore: AuthStore;
  /** Clock returning epoch milliseconds (injected for testability). */
  now: () => number;
  /** Injected `fetch` for LNURL-pay range checks. */
  fetchImpl: FetchFn;
  /** Live assigned shop notes. Omitted → `POST /pos` does not ping the map. */
  messageStore?: { listLiveAssignedShops(): Promise<ShopNoteRef[]> };
  /** Map activity ping. Omitted → `POST /pos` does not ping the map. */
  activity?: ActivityPing;
  /** LNURL server; omitted when off. A verified wallet is checked against it. */
  lnurlServer?: LnurlServerConfig;
  /**
   * Shop payments in USDT and USDC; omitted when the LNURL server is off.
   * With it, `POST /pos` and `DELETE /pos` change the charge and its shop
   * payment in one transaction, and `GET /pos` adds `charge.shopPayment`.
   */
  shopPayments?: ShopPayments;
  /**
   * Spot quote `GET /fx/spot` serves. Omitted, empty, or unreadable: the
   * typed string is still stored and the other three currencies stay null.
   */
  spot?: FxSpotStore;
}

/** Resolve the account behind a request's bearer session, or `null`. */
async function authedAccount(
  deps: PosRouteDeps,
  header: string | undefined,
): Promise<Account | null> {
  const token = bearerToken(header);
  if (token === null) {
    return null;
  }
  return resolveSession(deps.authStore, deps.now(), token);
}

/**
 * Build the `/pos` route group.
 *
 * Mounted at `/pos` so the public paths are `GET /pos`, `POST /pos`,
 * and `DELETE /pos`.
 *
 * @param deps - Charge store, auth store, clock, LNURL fetch, and optional LNURL server.
 *   Optional `messageStore` and `activity` enable a best-effort map ping
 *   after a successful charge create. GET and DELETE do not ping.
 * @returns A Hono app with `GET /`, `POST /`, and `DELETE /`.
 */
export function posRoutes(deps: PosRouteDeps): Hono {
  return new Hono()
    .get('/', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const nowMs = deps.now();
      const pending = await deps.store.currentPending(account.id, nowMs);
      const history = await deps.store.listForAccount(account.id, 20);
      const latest = history[0];
      const recentlyPaid =
        latest !== undefined &&
        latest.status === 'paid' &&
        latest.paidAt !== null &&
        latest.paidAt.getTime() > nowMs - POS_PAID_SHOW_MS
          ? latest
          : null;
      const charge = pending ?? recentlyPaid;
      const shown =
        charge === null
          ? null
          : {
              ...serializePosCharge(charge),
              ...(deps.shopPayments === undefined
                ? {}
                : { shopPayment: await deps.shopPayments.shopPaymentOfCharge(charge.id) }),
            };
      return c.json(
        {
          charge: shown,
          history: history.map((row) => serializePosCharge(row)),
        },
        200,
      );
    })
    .post('/', async (c) => {
      // The request's arrival: the charge's background creation counts its 16 s limit from here.
      const arrivedMs = deps.now();
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const body: unknown = await c.req.json().catch(() => null);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return c.json({ error: 'Expected a JSON body with an integer "amountSats"' }, 400);
      }
      const amountSats = (body as { amountSats?: unknown }).amountSats;
      if (typeof amountSats !== 'number' || !Number.isInteger(amountSats) || amountSats < 1) {
        return c.json({ error: 'Expected a JSON body with an integer "amountSats"' }, 400);
      }
      const typed = readTypedFiat(body);
      if (!typed.ok) {
        return c.json({ error: typed.error }, 400);
      }
      const username = (account.username ?? '').trim();
      if (username === '') {
        return c.json({ error: 'Set a username first' }, 400);
      }
      const receiving = receivingAddress(account, deps.lnurlServer);
      if (receiving === null) {
        return c.json({ error: 'Set up your wallet first', code: WALLET_REQUIRED }, 400);
      }
      const open = await deps.store.currentPending(account.id, deps.now());
      if (open !== null) {
        return c.json({ error: 'A payment is already open' }, 409);
      }
      const resolved = await resolveLnurlp({
        address: receiving.address,
        fetchImpl: lnurlServerFetch(deps.lnurlServer, deps.fetchImpl, deps.authStore),
      });
      if (!resolved.ok) {
        return c.json({ error: 'Lightning Address could not be resolved' }, 502);
      }
      const millisats = amountSats * 1000;
      if (millisats < resolved.metadata.minSendable || millisats > resolved.metadata.maxSendable) {
        return c.json({ error: 'Amount is outside the wallet range' }, 400);
      }
      const createdMs = deps.now();
      const crosses = await frozenCrosses(deps.spot, typed.currency, typed.amount);
      const row: PosCharge = {
        id: crypto.randomUUID(),
        accountId: account.id,
        amountSats,
        status: 'pending',
        createdAt: new Date(createdMs),
        expiresAt: new Date(createdMs + POS_CHARGE_TTL_MS),
        paidAt: null,
        sparkInvoice: null,
        amountCurrency: typed.currency,
        amountText: typed.amount,
        ...crosses,
      };
      try {
        let created: PosCharge;
        if (deps.shopPayments === undefined) {
          created = await deps.store.create(row);
        } else {
          if (!(await deps.shopPayments.createCharge(account, row, arrivedMs))) {
            return c.json({ error: 'A payment is already open' }, 409);
          }
          created = row;
        }
        if (deps.messageStore !== undefined && deps.activity !== undefined) {
          try {
            const notes = await deps.messageStore.listLiveAssignedShops();
            const ids = notes
              .filter(
                (note) =>
                  note.accountId === account.id && textHasHashtagToken(note.text, '21GiftsShop'),
              )
              .map((note) => note.id);
            await pingShopActivity(deps.activity, ids, created.createdAt.toISOString());
          } catch (error) {
            logActivityFailure(error);
          }
        }
        return c.json({ charge: serializePosCharge(created) }, 201);
      } catch (error) {
        if (
          isUniqueViolation(error) ||
          (error instanceof Error && error.message === 'A payment is already open')
        ) {
          return c.json({ error: 'A payment is already open' }, 409);
        }
        throw error;
      }
    })
    .delete('/', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const cancelled =
        deps.shopPayments === undefined
          ? await deps.store.cancelPending(account.id, deps.now())
          : await deps.shopPayments.cancelCharge(account.id, deps.now());
      if (cancelled === null) {
        return c.json({ error: 'No open payment' }, 404);
      }
      return c.json({ charge: null }, 200);
    });
}

/** Sats-only body, or a typed currency together with its decimal string. */
type TypedFiatResult =
  { ok: true; currency: PosFiatCode | null; amount: string | null } | { ok: false; error: string };

/**
 * Read `amountCurrency` and `amount`.
 *
 * Absent together is sats-only. One without the other, or a bad pair, is 400.
 *
 * @param body - JSON object that already has an integer `amountSats`.
 * @returns The typed pair, sats-only nulls, or the 400 error text.
 */
function readTypedFiat(body: object): TypedFiatResult {
  const hasCurrency = Object.prototype.hasOwnProperty.call(body, 'amountCurrency');
  const hasAmount = Object.prototype.hasOwnProperty.call(body, 'amount');
  if (hasCurrency !== hasAmount) {
    return { ok: false, error: 'Expected amountCurrency and amount together' };
  }
  if (!hasCurrency) {
    return { ok: true, currency: null, amount: null };
  }
  const currency = (body as { amountCurrency?: unknown }).amountCurrency;
  const amount = (body as { amount?: unknown }).amount;
  if (typeof currency !== 'string' || typeof amount !== 'string' || !isPosFiatCode(currency)) {
    return { ok: false, error: 'Expected a typed fiat amount' };
  }
  const text = parseTypedFiatAmount(amount);
  if (text === null) {
    return { ok: false, error: 'Expected a typed fiat amount' };
  }
  return { ok: true, currency, amount: text };
}

/**
 * Freeze the other three currencies once. A missing store, a null quote, or a
 * failed read leaves them null and does not fail the charge.
 *
 * @param spot - Spot store, or omitted.
 * @param currency - Typed currency, or `null` for a sats-only body.
 * @param amount - Typed decimal, or `null` for a sats-only body.
 * @returns Numeric columns. All null when nothing was typed.
 */
async function frozenCrosses(
  spot: FxSpotStore | undefined,
  currency: PosFiatCode | null,
  amount: string | null,
): Promise<PosFiatNumbers> {
  const empty: PosFiatNumbers = { fiatUsd: null, fiatChf: null, fiatEur: null, fiatPhp: null };
  if (currency === null || amount === null || spot === undefined) {
    return empty;
  }
  let quote: FxSpotQuote | null;
  try {
    quote = await spot.latest();
  } catch {
    return empty;
  }
  return freezePosFiatCrosses(currency, amount, quote);
}
