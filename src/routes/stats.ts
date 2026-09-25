import { Hono } from 'hono';
import { buildGiftStats, giftsForRecipient, type GiftRow, type GiftStats } from '@/lib/gift';
import type { GiftStore } from '@/lib/gift-store';
import { InMemoryBtcUsdStore, type BtcUsdRateBook } from '@/lib/btc-usd-store';
import { InMemoryFiatStore, type FiatCross, type FiatRateBook } from '@/lib/usd-fiat-store';
import type { GoalRateDay } from '@/lib/goal-rate';
import { logEvent } from '@/lib/log';

/** Collaborators the public gift-stats route needs. */
export interface GiftsStatsRouteDeps {
  /** Outbound gift source. */
  store: GiftStore;
  /**
   * Historical BTC-USD rates (default: empty {@link InMemoryBtcUsdStore}).
   * Empty boots stay empty 200 without calling Coinbase.
   */
  rates?: BtcUsdRateBook;
  /**
   * Historical USD→CHF/EUR/PHP crosses (default: empty {@link InMemoryFiatStore}).
   * Missing fiat never 503s the page.
   */
  fiatRates?: FiatRateBook;
  /** Clock for rate refresh / "today" (default: `Date.now`). */
  now?: () => number;
}

/**
 * Same aggregation as `GET /gifts/stats`: legacy days (no stored USD) load
 * BTC-USD, then fiat crosses. A missing BTC-USD day is `fx-incomplete`.
 * A fiat-book throw is logged and does not fail the snapshot.
 *
 * @param rows - Outbound gifts to aggregate.
 * @param rates - BTC-USD book for legacy days.
 * @param fiatRates - USD-cross book for those same days.
 * @param nowMs - Clock passed to both books.
 * @returns The stats, or `fx-incomplete` when a legacy day has no BTC-USD rate.
 */
export async function loadGiftStatsSnapshot(
  rows: readonly GiftRow[],
  rates: BtcUsdRateBook,
  fiatRates: FiatRateBook,
  nowMs: number,
): Promise<{ ok: true; stats: GiftStats } | { ok: false; reason: 'fx-incomplete' }> {
  if (rows.length === 0) {
    return { ok: true, stats: buildGiftStats([], new Map()) };
  }
  const legacyDays = [
    ...new Set(
      rows
        .filter((row) => row.amountUsd === undefined)
        .map((row) => row.paidAt.toISOString().slice(0, 10)),
    ),
  ];
  const rateMap = legacyDays.length === 0 ? new Map() : await rates.ensureDays(legacyDays, nowMs);
  for (const day of legacyDays) {
    if (!rateMap.has(day)) {
      return { ok: false, reason: 'fx-incomplete' };
    }
  }
  let fiatMap: ReadonlyMap<string, FiatCross> = new Map();
  try {
    if (legacyDays.length > 0) {
      fiatMap = await fiatRates.ensureDays(legacyDays, nowMs);
    }
  } catch {
    logEvent('gifts.stats.fiat_failed');
  }
  return { ok: true, stats: buildGiftStats(rows, rateMap, fiatMap) };
}

/**
 * Last `spendOverTime` day with `sats > 0`, using the gift-stats FX path.
 * Empty history is `null`. A missing BTC-USD legacy day throws.
 *
 * @param deps - Gift store, both rate books, and the clock.
 * @returns That day's sats and four fiat totals, or `null` when no day has sats.
 * @throws Error `fx.rate.missing` when a legacy day has no BTC-USD rate.
 */
export async function loadLatestGoalRateDay(deps: {
  store: GiftStore;
  rates: BtcUsdRateBook;
  fiatRates: FiatRateBook;
  now: () => number;
}): Promise<GoalRateDay | null> {
  const rows = await deps.store.listOutbound();
  const loaded = await loadGiftStatsSnapshot(rows, deps.rates, deps.fiatRates, deps.now());
  if (!loaded.ok) {
    throw new Error('fx.rate.missing');
  }
  const day = [...loaded.stats.spendOverTime].reverse().find((item) => item.sats > 0);
  if (day === undefined) {
    return null;
  }
  return { sats: day.sats, usd: day.usd, chf: day.chf, eur: day.eur, php: day.php };
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
 * Optional `?recipient=` filters outbound gifts to one Wallet of Satoshi
 * handle before aggregation (see {@link giftsForRecipient}).
 *
 * @param deps - Gift store, optional BTC-USD book, optional fiat book, and clock.
 * @returns A Hono app with `GET /`.
 */

export function giftsStatsRoutes(deps: GiftsStatsRouteDeps): Hono {
  const rates = deps.rates ?? new InMemoryBtcUsdStore();
  const fiatRates = deps.fiatRates ?? new InMemoryFiatStore();
  const now = deps.now ?? Date.now;

  return new Hono().get('/', async (c) => {
    try {
      const raw = (c.req.query('recipient') ?? '').trim();
      const rows = await deps.store.listOutbound();
      const selected = raw === '' ? rows : giftsForRecipient(rows, raw);
      const loaded = await loadGiftStatsSnapshot(selected, rates, fiatRates, now());
      if (!loaded.ok) {
        logEvent('gifts.stats.fx_incomplete');
        return c.json({ error: 'Gift stats are unavailable' }, 503);
      }
      return c.json(loaded.stats, 200);
    } catch {
      logEvent('gifts.stats.failed');
      return c.json({ error: 'Gift stats are unavailable' }, 503);
    }
  });
}
