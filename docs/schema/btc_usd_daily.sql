-- BTC-USD daily closes used by GET /gifts/stats (historical FX per gift day).
-- Populated from Coinbase Exchange daily candles; settled historical days are not re-fetched; missing days, stale UTC-today, and after-midnight finalize of an intraday print are upserted.

CREATE TABLE IF NOT EXISTS btc_usd_daily (
  day date PRIMARY KEY,
  usd_per_btc numeric NOT NULL,
  source text NOT NULL,
  fetched_at timestamptz NOT NULL
);
