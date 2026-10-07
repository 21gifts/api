-- Last good BTC spot quote served by GET /fx/spot (fiat per 1 BTC).
-- One row (`id = 1`), replaced by the spot worker every 5 minutes from one
-- Coinbase exchange-rates response. A currency without a usable quote is NULL.
-- `as_of` is the fetch time; a failed fetch leaves the row unchanged.
-- Source tag is `coinbase-exchange-rates`. Not used by GET /gifts/stats.

CREATE TABLE IF NOT EXISTS btc_fiat_spot (
  id smallint PRIMARY KEY CHECK (id = 1),
  usd numeric,
  chf numeric,
  eur numeric,
  php numeric,
  source text NOT NULL,
  as_of timestamptz NOT NULL
);
