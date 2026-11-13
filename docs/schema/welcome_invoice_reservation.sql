-- Applied by migrateAuthSchema / AUTH_SCHEMA_SQL because account merges reconcile
-- reservations, and independently by migrateWelcomeInvoiceReservationSchema.

CREATE TABLE IF NOT EXISTS welcome_invoice_reservation (
  account_id uuid PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  reservation_id text NOT NULL UNIQUE CHECK (reservation_id ~ '^[0-9a-f]{32}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at)
);
