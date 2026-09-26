-- Public OpenCryptoPay places (GET/POST /ocp/places).
-- Unique on (origin, external_id). A second insert returns the existing row;
-- coordinates and name are never overwritten. BTC Map is notified only once
-- when the row is new and BTCMAP_ACCESS_TOKEN is set.

CREATE TABLE IF NOT EXISTS ocp_place (
  id uuid PRIMARY KEY,
  origin text NOT NULL,
  external_id text NOT NULL,
  name text NOT NULL,
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  category text NOT NULL,
  payment_methods text,
  created_at timestamptz NOT NULL,
  UNIQUE (origin, external_id)
);
