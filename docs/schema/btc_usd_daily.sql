-- BTC-USD daily closes used by GET /gifts/stats (historical FX per gift day).
-- Populated from Coinbase Exchange daily candles; historical days are insert-only.

CREATE TABLE IF NOT EXISTS btc_usd_daily (
  day date PRIMARY KEY,
  usd_per_btc numeric NOT NULL,
  source text NOT NULL,
  fetched_at timestamptz NOT NULL
);
