-- Retired custodial Nostr keys kept by KEK rotation (rotateKeks): the key a
-- member account or a shop identity had before the rotation. Used only to
-- sign the NIP-09 kind 5 deletion of an event that key signed
-- (signDeletionForAccount); never to sign anything else and never to
-- attribute an inbound event.
--
-- owner_type / owner_id: 'account' and the account id, or 'shop' and the shop
-- note id (shop_identity.message_id), as text.
-- pubkey: 64 lowercase hex x-only public key of the retired key.
-- nsec_ciphertext: the account envelope layout (version 0x01 || kek_id u32 BE
-- || nonce || ciphertext+tag) under NOSTR_NSEC_KEK, with the AES-GCM
-- additional data 'nostr_retired_key:<owner_type>:<owner_id>:<pubkey>'. A
-- secret column: db_change stores only its SHA-256, GET /debug/db its length.
-- kek_id: NOSTR_NSEC_KEK_ID the envelope is sealed under; a later rotation
-- seals it again under the new id.
--
-- Every statement runs inside a DO block that first takes
-- pg_advisory_xact_lock(21499041), so concurrent boots run them one at a time.
CREATE TABLE IF NOT EXISTS nostr_retired_key (
  owner_type text NOT NULL CHECK (owner_type IN ('account', 'shop')),
  owner_id text NOT NULL,
  pubkey text NOT NULL CHECK (pubkey ~ '^[0-9a-f]{64}$'),
  nsec_ciphertext bytea NOT NULL,
  kek_id integer NOT NULL CHECK (kek_id >= 1),
  retired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_type, owner_id, pubkey)
);

CREATE INDEX IF NOT EXISTS nostr_retired_key_pubkey_idx ON nostr_retired_key (pubkey);

-- Deleting an account or a shop identity deletes its retired keys in the same
-- statement. An account merge also deletes the source's rows explicitly.
CREATE OR REPLACE FUNCTION drop_account_nostr_retired_keys() RETURNS trigger AS $$
BEGIN
  DELETE FROM nostr_retired_key WHERE owner_type = 'account' AND owner_id = OLD.id::text;
  RETURN OLD;
END
$$ LANGUAGE plpgsql;

-- Created only when missing:
CREATE TRIGGER trg_account_nostr_retired_key AFTER DELETE ON account
  FOR EACH ROW EXECUTE FUNCTION drop_account_nostr_retired_keys();

CREATE OR REPLACE FUNCTION drop_shop_nostr_retired_keys() RETURNS trigger AS $$
BEGIN
  DELETE FROM nostr_retired_key WHERE owner_type = 'shop' AND owner_id = OLD.message_id::text;
  RETURN OLD;
END
$$ LANGUAGE plpgsql;

-- Created only when missing:
CREATE TRIGGER trg_shop_identity_nostr_retired_key AFTER DELETE ON shop_identity
  FOR EACH ROW EXECUTE FUNCTION drop_shop_nostr_retired_keys();
