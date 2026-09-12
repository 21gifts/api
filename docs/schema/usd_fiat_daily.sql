-- USD→CHF/EUR/PHP daily ECB rates used by GET /gifts and GET /gifts/stats.
-- Populated from Frankfurter (ECB). `day` is the gift UTC lookup day;
-- `as_of_day` is the ECB publication day (may be earlier when the market was closed).
-- Source tag is `frankfurter-ecb`. Missing fiat must not 503 the public pages.

CREATE TABLE IF NOT EXISTS usd_fiat_daily (
  day date NOT NULL,
  quote text NOT NULL,
  rate numeric NOT NULL,
  as_of_day date NOT NULL,
  source text NOT NULL,
  fetched_at timestamptz NOT NULL,
  PRIMARY KEY (day, quote)
);
