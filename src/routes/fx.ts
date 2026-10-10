import { Hono } from 'hono';
import type { SpotRates } from '@/lib/fx-spot';
import type { FxSpotStore } from '@/lib/fx-spot-store';
import { logEvent } from '@/lib/log';

/** Collaborators the public spot route needs. */
export interface FxRoutesDeps {
  /** Last good quote, kept fresh by the spot worker. */
  store: FxSpotStore;
}

/**
 * JSON body of `GET /fx/spot`. Without a stored quote, `asOf` and `source` are
 * `null` and `rates` is `{}`.
 */
export interface FxSpotBody {
  /** ISO-8601 fetch time of the quote, or `null` when there is none. */
  asOf: string | null;
  /** Provider tag, or `null` when there is no quote. */
  source: string | null;
  /** Fiat per 1 BTC as decimal text; a currency without a quote is omitted. */
  rates: SpotRates;
}

/** CDN and browser cache for a stored quote (the worker refreshes every 5 minutes). */
const SPOT_CACHE_CONTROL = 'public, max-age=60';

/**
 * Public `GET /fx/spot`: the stored BTC price in USD, CHF, EUR, and PHP.
 *
 * Never calls the provider. No stored quote, or a store that throws
 * (`fx.spot.read_failed`), answers 200 with `rates: {}` and `no-store`.
 *
 * @param deps - Spot store.
 * @returns Hono sub-app mounted at `/fx`.
 */
export function fxRoutes(deps: FxRoutesDeps): Hono {
  const app = new Hono();
  app.get('/spot', async (c) => {
    let body: FxSpotBody = { asOf: null, source: null, rates: {} };
    try {
      const quote = await deps.store.latest();
      if (quote !== null) {
        body = { asOf: quote.asOf, source: quote.source, rates: quote.rates };
      }
    } catch {
      logEvent('fx.spot.read_failed');
    }
    c.header('Cache-Control', body.asOf === null ? 'no-store' : SPOT_CACHE_CONTROL);
    return c.json(body, 200);
  });
  return app;
}
