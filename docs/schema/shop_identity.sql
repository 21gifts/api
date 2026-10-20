-- One custodial Nostr key per listed shop note (docs/shop-identity.md S1) and
-- the two durable OpenCryptoPay outboxes (S5). migrateShopIdentitySchema
-- (SHOP_IDENTITY_SCHEMA_SQL in src/lib/shop-identity.ts) runs these idempotent
-- statements on every boot, after migrateMessageSchema.
-- nostr_nsec_ciphertext is the account envelope (version 0x01 || kek_id u32 BE
-- || nonce 12 || ciphertext+tag, AES-256-GCM, NOSTR_NSEC_KEK) with the AAD
-- `shop:<message_id>`. A row is never deleted or moved to another note;
-- MessageStore.deleteById keeps a note that has one.
-- Leases (ocp_*_claimed_until) are set and compared with the database clock.
-- Every write after a claim is conditional on its token (ocp_*_claim); writes
-- that clear a flag or store a hash are also conditional on the generation.
-- `migrateDbChangeSchema` attaches `trg_db_change`; the ciphertext is stored
-- there only as its SHA-256 by the central secret-column redaction rule.

CREATE TABLE IF NOT EXISTS shop_identity (
  message_id uuid PRIMARY KEY REFERENCES message (id),
  nostr_pubkey text NOT NULL UNIQUE CHECK (nostr_pubkey ~ '^[0-9a-f]{64}$'),
  nostr_nsec_ciphertext bytea NOT NULL,
  nostr_kek_id integer NOT NULL CHECK (nostr_kek_id = 1),
  nostr_key_custody text NOT NULL CHECK (nostr_key_custody IN ('custodial', 'user')),
  nostr_key_created_at timestamptz NOT NULL,
  profile_name text NOT NULL,
  ocp_photos_hash text NULL,
  ocp_photos_pending boolean NOT NULL DEFAULT false,
  ocp_photos_generation integer NOT NULL DEFAULT 0,
  ocp_photos_claimed_until timestamptz NULL,
  ocp_photos_claim integer NOT NULL DEFAULT 0,
  ocp_place_pending boolean NOT NULL DEFAULT false,
  ocp_place_generation integer NOT NULL DEFAULT 0,
  ocp_place_claimed_until timestamptz NULL,
  ocp_place_claim integer NOT NULL DEFAULT 0,
  ocp_revision bigint NOT NULL DEFAULT 0
    CHECK (ocp_revision >= 0 AND ocp_revision <= 9007199254740991)
);

-- Place outbox: every write that changes the text, pin, till account or
-- deleted_at of a note queues its row, in the writing transaction. A key that
-- a concurrent insert committed is seen because each PL/pgSQL statement takes
-- a fresh snapshot after the message row is locked.
CREATE OR REPLACE FUNCTION queue_shop_identity_place() RETURNS trigger AS $$
BEGIN
  UPDATE shop_identity SET ocp_place_pending = true,
    ocp_place_generation = ocp_place_generation + 1
  WHERE message_id = NEW.id;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_shop_identity_place ON message;
CREATE TRIGGER trg_shop_identity_place
AFTER UPDATE OF text, place_lat, place_lng, place_label, place_street, place_house_number,
  place_postal_code, place_city, place_country, shop_account_id, deleted_at ON message
FOR EACH ROW WHEN (
  OLD.text IS DISTINCT FROM NEW.text OR
  OLD.place_lat IS DISTINCT FROM NEW.place_lat OR OLD.place_lng IS DISTINCT FROM NEW.place_lng OR
  OLD.place_label IS DISTINCT FROM NEW.place_label OR
  OLD.place_street IS DISTINCT FROM NEW.place_street OR
  OLD.place_house_number IS DISTINCT FROM NEW.place_house_number OR
  OLD.place_postal_code IS DISTINCT FROM NEW.place_postal_code OR
  OLD.place_city IS DISTINCT FROM NEW.place_city OR
  OLD.place_country IS DISTINCT FROM NEW.place_country OR
  OLD.shop_account_id IS DISTINCT FROM NEW.shop_account_id OR
  OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
)
EXECUTE FUNCTION queue_shop_identity_place();

-- Photo outbox: a change of photo 1 (message.photo) or of an extra photo
-- (message_extra_photo) queues the row while the note has the listed shape
-- (live, top-level, till account, complete pin columns, shop tag). The text
-- rules of #478 are checked by the photo sender, which clears the flag
-- without a request for a note that is not listed.
CREATE OR REPLACE FUNCTION queue_shop_identity_cover() RETURNS trigger AS $$
BEGIN
  IF NEW.parent_id IS NULL AND NEW.deleted_at IS NULL AND NEW.shop_account_id IS NOT NULL
     AND NEW.place_lat IS NOT NULL AND NEW.place_lng IS NOT NULL AND NEW.place_label IS NOT NULL
     AND NEW.place_street IS NOT NULL AND NEW.place_house_number IS NOT NULL
     AND NEW.place_postal_code IS NOT NULL AND NEW.place_city IS NOT NULL
     AND NEW.place_country IS NOT NULL AND NEW.text ~* '#21giftsshop([^a-z0-9_]|$)' THEN
    UPDATE shop_identity SET ocp_photos_pending = true,
      ocp_photos_generation = ocp_photos_generation + 1
    WHERE message_id = NEW.id;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_shop_identity_cover ON message;
CREATE TRIGGER trg_shop_identity_cover
AFTER UPDATE OF photo, photo_content_type ON message
FOR EACH ROW WHEN (
  OLD.photo IS DISTINCT FROM NEW.photo OR
  OLD.photo_content_type IS DISTINCT FROM NEW.photo_content_type
)
EXECUTE FUNCTION queue_shop_identity_cover();

CREATE OR REPLACE FUNCTION queue_shop_identity_photo() RETURNS trigger AS $$
DECLARE target uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target := OLD.message_id;
  ELSE
    target := NEW.message_id;
  END IF;
  UPDATE shop_identity SET ocp_photos_pending = true,
    ocp_photos_generation = ocp_photos_generation + 1
  WHERE message_id = target AND EXISTS (
    SELECT 1 FROM message m WHERE m.id = target
      AND m.parent_id IS NULL AND m.deleted_at IS NULL AND m.shop_account_id IS NOT NULL
      AND m.place_lat IS NOT NULL AND m.place_lng IS NOT NULL AND m.place_label IS NOT NULL
      AND m.place_street IS NOT NULL AND m.place_house_number IS NOT NULL
      AND m.place_postal_code IS NOT NULL AND m.place_city IS NOT NULL
      AND m.place_country IS NOT NULL AND m.text ~* '#21giftsshop([^a-z0-9_]|$)'
  );
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_shop_identity_extra_photo ON message_extra_photo;
CREATE TRIGGER trg_shop_identity_extra_photo
AFTER INSERT OR UPDATE OR DELETE ON message_extra_photo
FOR EACH ROW EXECUTE FUNCTION queue_shop_identity_photo();
