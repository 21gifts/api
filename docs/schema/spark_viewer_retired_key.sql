-- Retired Spark viewer keys kept by KEK rotation (rotateSparkViewerKey): the
-- deployment viewer mnemonic before the rotation. Previous wallets cannot
-- grant a new viewer, so the worker reads a previous wallet through the viewer
-- it granted while it was current: first the one current at
-- previous_wallet.replaced_at (by retired_at), then the other retired viewers
-- newest first, then the current viewer; the first that returns data wins
-- (previousWalletSparkViewer). Current wallets grant the new viewer only when
-- the member next opens the app, so while retired viewers exist the worker
-- reads a current wallet through the same reader, current viewer first, then
-- the retired viewers newest first. Read-only use only.
--
-- identity_public_key: 66 hex identity public key of the retired viewer.
-- mnemonic_ciphertext: AES-GCM envelope (version 0x01 || kek_id u32 BE ||
-- nonce || ciphertext+tag) under NOSTR_NSEC_KEK, with the additional data
-- 'spark_viewer_retired_key:<identity_public_key>'. A secret column: db_change
-- stores only its SHA-256, GET /debug/db its length.
-- kek_id: NOSTR_NSEC_KEK_ID the envelope is sealed under; a later rotation
-- seals it again under the new id.
-- Created by migrateSparkViewerSchema (src/lib/spark-viewer.ts).
CREATE TABLE IF NOT EXISTS spark_viewer_retired_key (
  identity_public_key text PRIMARY KEY CHECK (identity_public_key ~ '^0[23][0-9a-f]{64}$'),
  mnemonic_ciphertext bytea NOT NULL,
  kek_id integer NOT NULL CHECK (kek_id >= 1),
  retired_at timestamptz NOT NULL DEFAULT now()
);
