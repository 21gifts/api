import { Hono } from 'hono';
import {
  buildGiftStats,
  giftsForRecipient,
  utcDayFromPaidAt,
  type GiftRow,
  type GiftStats,
} from '@/lib/gift';
import type { GiftStore } from '@/lib/gift-store';
import type { BtcUsdRateBook } from '@/lib/btc-usd-store';
import type { FiatRateBook } from '@/lib/usd-fiat-store';
import type { GoalRateDay } from '@/lib/goal-rate';
import { logEvent } from '@/lib/log';

/** Collaborators the public gift-stats route needs. */
export interface GiftsStatsRouteDeps {
  /** Outbound gift source. */
  store: GiftStore;
  /**
   * Accepted so existing callers still type-check. This route does not read it.
   * A missing stored amount stays null.
   */
  rates?: BtcUsdRateBook;
  /**
   * Accepted so existing callers still type-check. This route does not read it.
   * A missing stored amount stays null.
   */
  fiatRates?: FiatRateBook;
  /** Accepted so existing callers still type-check. This route does not read it. */
  now?: () => number;
}

/**
 * Same aggregation as `GET /gifts/stats`. Stored figures only. A missing
 * amount stays null. The rate books are not read.
 *
 * @param rows - Outbound gifts to aggregate.
 * @param _rates - Ignored. A daily close does not price a stored amount.
 * @param _fiatRates - Ignored. A daily close does not price a stored amount.
 * @param _nowMs - Ignored.
 * @returns The stats.
 */
export async function loadGiftStatsSnapshot(
  rows: readonly GiftRow[],
  _rates?: BtcUsdRateBook,
  _fiatRates?: FiatRateBook,
  _nowMs?: number,
): Promise<{ ok: true; stats: GiftStats }> {
  return { ok: true, stats: buildGiftStats(rows, new Map()) };
}

/**
 * Latest gift-day proportion for a currency ask. Last `spendOverTime` day
 * with `sats > 0` from {@link loadGiftStatsSnapshot} (no recipient filter).
 * Empty history is `null`. `sats` is that public day total. A currency field
 * stays that public sum only when every outbound gift on that UTC day stored
 * a string for it. If any gift on that day lacks the string, that field is
 * `null`, even when the public series shows a partial sum. The public series
 * is unchanged. Does not invent a rate.
 *
 * @param deps - Gift store, both rate books, and the clock. The books are not read.
 * @returns `{ sats, usd, chf, eur, php }`, or `null`. A missing or incomplete
 * currency is `null` and does not throw.
 */
export async function loadLatestGoalRateDay(deps: {
  store: GiftStore;
  rates: BtcUsdRateBook;
  fiatRates: FiatRateBook;
  now: () => number;
}): Promise<GoalRateDay | null> {
  const rows = await deps.store.listOutbound();
  const loaded = await loadGiftStatsSnapshot(rows, deps.rates, deps.fiatRates, deps.now());
  const day = [...loaded.stats.spendOverTime].reverse().find((item) => item.sats > 0);
  if (day === undefined) {
    return null;
  }
  const onDay = rows.filter((row) => utcDayFromPaidAt(row.paidAt) === day.day);
  return {
    sats: day.sats,
    usd: onDay.every((row) => typeof row.amountUsd === 'string') ? day.usd : null,
    chf: onDay.every((row) => typeof row.amountChf === 'string') ? day.chf : null,
    eur: onDay.every((row) => typeof row.amountEur === 'string') ? day.eur : null,
    php: onDay.every((row) => typeof row.amountPhp === 'string') ? day.php : null,
  };
}

/**
 * `goalRateDay` for `messagesRoutes`: one call of {@link loadLatestGoalRateDay}.
 *
 * @param deps - The same collaborators as {@link loadLatestGoalRateDay}.
 * @returns A function that loads the latest gift-day on each call.
 */
export function bindGoalRateDay(deps: {
  store: GiftStore;
  rates: BtcUsdRateBook;
  fiatRates: FiatRateBook;
  now: () => number;
}): () => Promise<GoalRateDay | null> {
  return () => loadLatestGoalRateDay(deps);
}

/**
 * Build the `/gifts/stats` route group.
 *
 * Mounted at `/gifts/stats` so the public path is `GET /gifts/stats`.
 * Optional `?recipient=` filters outbound gifts to one recipient handle (the
 * local part of the receiving address) before aggregation (see {@link giftsForRecipient}).
 *
 * @param deps - Gift store, optional BTC-USD book, optional fiat book, and clock.
 * @returns A Hono app with `GET /`.
 */

export function giftsStatsRoutes(deps: GiftsStatsRouteDeps): Hono {
  return new Hono().get('/', async (c) => {
    try {
      const raw = (c.req.query('recipient') ?? '').trim();
      const rows = await deps.store.listOutbound();
      const selected = raw === '' ? rows : giftsForRecipient(rows, raw);
      const loaded = await loadGiftStatsSnapshot(
        selected,
        deps.rates,
        deps.fiatRates,
        deps.now === undefined ? undefined : deps.now(),
      );
      return c.json(loaded.stats, 200);
    } catch {
      logEvent('gifts.stats.failed');
      return c.json({ error: 'Gift stats are unavailable' }, 503);
    }
  });
}
