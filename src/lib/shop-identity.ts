/**
 * Durable Nostr identities and OpenCryptoPay outboxes for shop notes
 * (`docs/shop-identity.md` S1 and S5).
 *
 * One custodial key per shop note, stored in `shop_identity` and encrypted
 * with the account KEK under the AAD `shop:<messageId>`. A new shop gets a
 * random key. A note that already has a Nostr key at OpenCryptoPay keeps
 * that key (`shopKeyMustBeAdopted`, `adoptKnownSecret`); it is not minted
 * again. The same row carries the place and photo outboxes. On Postgres, the
 * row
 * triggers `trg_shop_identity_place`, `trg_shop_identity_cover` and
 * `trg_shop_identity_extra_photo` queue every store write that changes a
 * shop note, in the writing transaction and after its row lock; the
 * in-memory adapter derives the same queue from note fingerprints before
 * each call.
 */

import { createHash } from 'node:crypto';
import { nip19 } from 'nostr-tools';
import type { SqlClient } from '@/lib/auth/sql';
import { InMemoryMessageStore, textHasHashtagToken, type MessageStore } from '@/lib/message-store';
import type { MessageRow } from '@/lib/message';
import {
  NOSTR_KEK_ID_V1,
  defaultNostrKeygen,
  encryptNostrSecret,
  publicKeyHexFromSecret,
  zeroizeSecret,
  type NostrKeygen,
} from '@/lib/nostr/keys';
import {
  publicShop,
  shopListingFingerprint,
  type PublicShop,
  type ShopListingFields,
} from '@/lib/shop-place';

/** One persisted shop key and its two OpenCryptoPay outboxes. */
export interface ShopIdentityRow {
  /** Shop note id (`message.id`), also the AAD suffix and the OCP `externalId`. */
  messageId: string;
  /** 64 lowercase hex x-only public key. */
  nostrPubkey: string;
  /** AES-256-GCM envelope of the secret key. */
  nostrNsecCiphertext: Uint8Array;
  /** Key-encryption key id (only `1`). */
  nostrKekId: number;
  /** Custody of the key (`custodial` in v1). */
  nostrKeyCustody: 'custodial' | 'user';
  /** Insert time of the key. */
  nostrKeyCreatedAt: Date;
  /** Shop name while it was last public. */
  profileName: string;
  /** SHA-256 of the photo set OpenCryptoPay last answered, or `null`. */
  ocpPhotosHash: string | null;
  /** A photo push is due. */
  ocpPhotosPending: boolean;
  /** Raised by every photo trigger. */
  ocpPhotosGeneration: number;
  /** Photo lease end, or `null`. */
  ocpPhotosClaimedUntil: Date | null;
  /** Photo claim token, raised by every photo claim. */
  ocpPhotosClaim: number;
  /** A place push is due. */
  ocpPlacePending: boolean;
  /** Raised by every place change. */
  ocpPlaceGeneration: number;
  /** Place lease end, or `null`. */
  ocpPlaceClaimedUntil: Date | null;
  /** Place claim token, raised by every place claim. */
  ocpPlaceClaim: number;
  /** Last revision sent to OpenCryptoPay (shared by place and photo requests). */
  ocpRevision: number;
}

/** A claimed outbox row: claim token `claim` (c) and generation `generation` (g). */
export interface ShopOcpClaim {
  /** Shop note id. */
  messageId: string;
  /** Generation read by the claim. */
  generation: number;
  /** Claim token returned by the claim. */
  claim: number;
}

/** Keyset cursor of the key backfill, by note `created_at` then `id`. */
export interface ShopCandidateCursor {
  /** Note creation time. */
  createdAt: Date;
  /** Note id. */
  id: string;
}

/**
 * One raw key-backfill candidate: its keyset cursor and whether the note
 * already has a key, so the caller can advance past it without generating one.
 */
export interface ShopCandidate extends ShopCandidateCursor {
  /** The note already has a row in `shop_identity`. */
  keyed: boolean;
}

/** Keyset cursor of the public directory, by note `created_at` then `id`. */
export interface ShopDirectoryCursor {
  /** Note creation time. */
  createdAt: Date;
  /** Note id. */
  id: string;
}

/** One keyed public shop. `id` and `createdAt` stay on the cursor, not the JSON. */
export interface ShopDirectoryItem {
  /** Note id. */
  id: string;
  /** Note creation time. */
  createdAt: Date;
  /** Canonical npub ({@link shopNpub}). */
  npub: string;
  /** Pin label, or the description line when the pin has no label. */
  name: string;
  /** Pin when the note has coordinates. Null when it has none. */
  place: PublicShop['place'];
}

/** One directory page of at most `limit` keyed public shops. */
export interface ShopDirectoryPage {
  /** Keyed public shops, newest note first. */
  shops: ShopDirectoryItem[];
  /**
   * Last examined note, when another structural row may exist. Null when the
   * keyset is exhausted.
   */
  next: ShopDirectoryCursor | null;
}

/**
 * Keyset cursor of the shop publishers' round robin, in the `listAll()` order:
 * `nostr_key_created_at`, then `message_id`. It is a key, not a row, so it
 * still works when no row has it any more.
 */
export interface ShopIdentityCursor {
  /** Key creation time of the last visited shop. */
  createdAt: Date;
  /** Note id of the last visited shop. */
  messageId: string;
}

/** Outbox lane: the place request or the photo request. */
export type ShopOcpLane = 'place' | 'photos';

/** Persistence port for shop identities and their OpenCryptoPay outboxes. */
export interface ShopIdentityStore {
  /**
   * Create the key of a public shop once, or return the existing one.
   *
   * A public shop is live, top-level, tagged `#21GiftsShop`, and has a till
   * account. A pin is optional. A new key queues the place push and the photo
   * push. An existing
   * key gets its `profile_name` rewritten while the note is still a public
   * shop and still matches the snapshot this call read (the rule of
   * {@link renameIfListed}), so a call with an older snapshot than a stored
   * rename changes nothing. A note whose key must be adopted is left without
   * a row.
   *
   * @param messageId - Shop note id.
   * @param kek - Key-encryption key for the new secret.
   * @param keygen - Secret key source (default {@link defaultNostrKeygen}).
   * @returns The identity, or `undefined` when there is no key yet and the
   *   note is not a public shop, or when its key must be adopted.
   */
  ensureListed(
    messageId: string,
    kek: Uint8Array,
    keygen?: NostrKeygen,
  ): Promise<ShopIdentityRow | undefined>;
  /**
   * Store a shop's existing 32-byte secret, once.
   *
   * The same public key is returned unchanged. A different key for this
   * note, or this key on another note, throws. The insert does not queue
   * a place push. When the note is a public shop it queues the photo push;
   * otherwise the photo flags stay clear.
   *
   * @param messageId - Shop note id. The note must exist.
   * @param secret - 32-byte secp256k1 secret. Not retained and not zeroized.
   * @param kek - Key-encryption key.
   * @returns The stored identity.
   */
  adoptKnownSecret(
    messageId: string,
    secret: Uint8Array,
    kek: Uint8Array,
  ): Promise<ShopIdentityRow>;
  /**
   * Identity of one note.
   *
   * @param messageId - Shop note id.
   * @returns The identity, or `undefined`.
   */
  getByMessageId(messageId: string): Promise<ShopIdentityRow | undefined>;
  /**
   * Identity by public key.
   *
   * @param pubkey - 64 lowercase hex x-only public key.
   * @returns The identity, or `undefined`.
   */
  getByPubkey(pubkey: string): Promise<ShopIdentityRow | undefined>;
  /**
   * Encrypted secret of one shop.
   *
   * @param messageId - Shop note id.
   * @returns The AES-256-GCM envelope, or `undefined`.
   */
  getNostrCiphertext(messageId: string): Promise<Uint8Array | undefined>;
  /**
   * Every identity.
   *
   * @returns Rows by `nostr_key_created_at`, then `message_id`.
   */
  listAll(): Promise<ShopIdentityRow[]>;
  /**
   * The first `limit` identities for the operator dump (`GET /debug/dump`).
   *
   * @param limit - Most rows to return.
   * @returns At most `limit` rows in the `listAll()` order.
   */
  listDebug(limit: number): Promise<ShopIdentityRow[]>;
  /**
   * One bounded page of a lap over every identity in the `listAll()` order:
   * up to `limit` rows after `cursor`, and when fewer than `limit` follow it,
   * the lap wraps with a second bounded read of the rows at or before
   * `cursor` from the start, so a call returns at most `limit` rows and,
   * when there are at most `limit` identities, each of them exactly once.
   *
   * @param cursor - Last visited shop, or `null` to start at the first row.
   * @param limit - Most rows to return.
   * @returns Rows after the cursor, then the wrapped rows from the start.
   */
  listRound(cursor: ShopIdentityCursor | null, limit: number): Promise<ShopIdentityRow[]>;
  /**
   * Write `profile_name` from a note snapshot, only while that snapshot is
   * a public shop and the stored note still shows it (the same note lock and
   * unchanged-columns condition as the rename in {@link ensureListed}). A
   * caller holding an older snapshot than a committed rename changes
   * nothing, so it cannot put an older name back.
   *
   * @param note - The note as the caller read it.
   * @returns Resolves when done (no key, a snapshot that is not a public
   *   shop, a changed note, or an unchanged name is a no-op).
   */
  renameIfListed(note: MessageRow): Promise<void>;
  /**
   * One raw page of key-backfill candidates: live top-level `#21GiftsShop`
   * notes with a till account, whether or not they have a pin or a key.
   * The page is bounded before the key check, so a lap where every candidate
   * has a key still returns at most `limit` rows per call; the caller
   * advances its cursor on this raw page and skips `keyed` rows.
   * With a cursor, the Postgres read is a separate statement whose cursor is
   * always an index condition on `message_shop_directory_idx`.
   *
   * @param cursor - Last row of the previous page, or `null` for the first page.
   * @param limit - Page size.
   * @returns Up to `limit` candidates after `cursor`, by `created_at` then `id`.
   */
  listCandidates(cursor: ShopCandidateCursor | null, limit: number): Promise<ShopCandidate[]>;
  /**
   * One page of up to `limit` keyed public shops, newest note first.
   * A note without a key and a note {@link publicShop} rejects are omitted,
   * but each one is examined. The read examines at most `20 * limit`
   * structural rows. `next` is the last kept shop when the page fills in
   * the middle of that read, the last examined note when the cap is hit
   * first, and null when the read is shorter than the cap.
   *
   * @param cursor - Last examined note, or `null` for the newest page.
   * @param limit - Most shops to return.
   * @returns The page. `next` is null when the keyset is exhausted.
   */
  listDirectory(cursor: ShopDirectoryCursor | null, limit: number): Promise<ShopDirectoryPage>;
  /**
   * Queue the place push of one page of identities.
   *
   * @param afterMessageId - Last id of the previous page, or `null`.
   * @param limit - Page size.
   * @returns The queued note ids, by `message_id`.
   */
  queueAllPlacePage(afterMessageId: string | null, limit: number): Promise<string[]>;
  /**
   * Queue the photo push of one page of identities.
   *
   * @param afterMessageId - Last id of the previous page, or `null`.
   * @param limit - Page size.
   * @returns The queued note ids, by `message_id`.
   */
  queueAllPhotoPage(afterMessageId: string | null, limit: number): Promise<string[]>;
  /**
   * Claim pending places (lease by the database clock), least recently
   * claimed first: `ocp_place_claimed_until` null (never claimed) first, then
   * by the stored end of the last claim, then by `message_id`. Every claim
   * stores an end: a failed send keeps its lease end, and every other end of
   * a claim (a result, a settle, a release, a change during the claim) stores
   * its own time. A queue write keeps that end, so the next claims take the
   * rows that waited longer first, and rows that keep failing, keep being
   * released or keep changing never hold the place of later shops.
   *
   * @param limit - Most rows to claim.
   * @param leaseMs - Lease length.
   * @returns The claims, possibly empty.
   */
  claimPlaces(limit: number, leaseMs: number): Promise<ShopOcpClaim[]>;
  /**
   * Claim one pending photo set whose place is not pending, least recently
   * claimed first (`ocp_photos_claimed_until` null, never claimed, first,
   * then by the stored end of the last claim: the lease end of a failed
   * send, the time of every other end of a claim; then by `message_id`), so
   * a set that keeps failing, keeps being released or keeps changing never
   * holds the place of later shops. `ocp_revision` is not required. A public
   * shop whose place this outbox has never sent is still claimed; the photo
   * sender does not raise a revision that is still 0.
   *
   * @param leaseMs - Lease length.
   * @returns The claim, or `undefined` when nothing is due.
   */
  claimPhoto(leaseMs: number): Promise<ShopOcpClaim | undefined>;
  /**
   * Whether the claim still holds and its lease has time left.
   *
   * @param lane - Place or photo lane.
   * @param claim - Claim to check.
   * @param minimumMs - Lease time the next request needs.
   * @returns `true` when the lease has not ended (a released lease ended at
   *   the release) and the claim holds at least `minimumMs` longer.
   */
  leaseHasTime(lane: ShopOcpLane, claim: ShopOcpClaim, minimumMs: number): Promise<boolean>;
  /**
   * Raise `ocp_revision` under the claim. For the photo lane, the same
   * atomic write also requires that the place is not pending and that the
   * photo generation is still the claim's: a place change (hide, delete,
   * new pin) or a newer photo change that came in after the claim read the
   * photos makes it reserve nothing, so stale photos never get a revision
   * after a newer place request.
   *
   * @param lane - Place or photo lane.
   * @param claim - Claim that must still hold.
   * @returns The new revision, or `undefined` when the claim was taken over
   *   (or, for photos, the place is pending or the generation moved on).
   */
  nextRevision(lane: ShopOcpLane, claim: ShopOcpClaim): Promise<number | undefined>;
  /**
   * Release the lease (conditional on the claim token): its end becomes the
   * current time, so the row is claimable at once but goes behind rows
   * never claimed and behind leases that ended earlier.
   *
   * @param lane - Place or photo lane.
   * @param claim - Claim to release.
   * @returns Resolves when released (a lost claim is a no-op).
   */
  release(lane: ShopOcpLane, claim: ShopOcpClaim): Promise<void>;
  /**
   * Before a place `DELETE`: null the hash, clear and raise the photo outbox.
   *
   * @param claim - Place claim.
   * @returns Resolves when written.
   */
  resetPhotosForDelete(claim: ShopOcpClaim): Promise<void>;
  /**
   * Record a place result and end the claim at the current time (as
   * `release`), also when the place settles, so a place queued again goes
   * behind never-claimed rows and leases that ended earlier.
   *
   * @param claim - Place claim.
   * @param result - OpenCryptoPay outcome of the request.
   * @returns Resolves when written.
   */
  finishPlace(claim: ShopOcpClaim, result: 'put' | 'created' | 'delete' | 'reject'): Promise<void>;
  /**
   * Clear the photo flag (generation-checked) without a request and end the
   * claim at the current time (as `release`), also when the set settles.
   *
   * @param claim - Photo claim.
   * @returns Resolves when written.
   */
  clearPhotoWithoutSend(claim: ShopOcpClaim): Promise<void>;
  /**
   * Null the stored photo hash (claim-checked).
   *
   * @param claim - Photo claim.
   * @returns Resolves when written.
   */
  clearPhotoHash(claim: ShopOcpClaim): Promise<void>;
  /**
   * Store the sent hash, clear the flag (generation-checked) and end the
   * claim at the current time (as `release`), also when the set settles.
   *
   * @param claim - Photo claim.
   * @param hash - `ocpPhotoSetHash` of the sent set.
   * @returns Resolves when written.
   */
  finishPhotos(claim: ShopOcpClaim, hash: string): Promise<void>;
  /**
   * Photo 404: null the hash, clear the flag (generation-checked), queue the
   * place when still listed, and end the photo claim at the current time (as
   * `release`), also when the set settles.
   *
   * @param claim - Photo claim.
   * @param listed - Whether the note is still a listed shop.
   * @returns Resolves when written.
   */
  missingPhotoPlace(claim: ShopOcpClaim, listed: boolean): Promise<void>;
  /**
   * Photo route missing (OpenCryptoPay without openCryptoPay/api#26): keep the
   * photo flag, hash and lease; when still listed, queue the place and hold
   * its lease until the photo lease ends (claim-checked, the place claim token
   * is left alone). A shop then costs at most one place and one photo request
   * per lease until the photo route answers.
   *
   * @param claim - Photo claim.
   * @param listed - Whether the note is still a listed shop.
   * @returns Resolves when written.
   */
  deferPhotos(claim: ShopOcpClaim, listed: boolean): Promise<void>;
}

/**
 * SQL condition of a public shop: live, top-level, a till account, and the
 * shop tag. A pin is not required. Used by the key backfill, `GET /shops`,
 * and the photo queue triggers.
 */
const DIRECTORY_SQL = (m: string): string =>
  `${m}.parent_id IS NULL AND ${m}.deleted_at IS NULL AND ${m}.shop_account_id IS NOT NULL
   AND ${m}.text ~* '#21giftsshop([^a-z0-9_]|$)'`;

/**
 * Fixed `pg_advisory_xact_lock` key of the shop identity migration. Every
 * statement of {@link SHOP_IDENTITY_SCHEMA_SQL} takes it first, so the
 * statements of concurrent boots run one at a time.
 */
const SHOP_IDENTITY_MIGRATION_LOCK = 21_499_001;

/**
 * Wrap one migration statement in a `DO` block that first takes the
 * transaction-scoped advisory lock {@link SHOP_IDENTITY_MIGRATION_LOCK}.
 * Concurrent boots queue behind each other instead of failing with
 * "tuple concurrently updated" (`CREATE OR REPLACE FUNCTION`) or a duplicate
 * catalog key (`CREATE TABLE` / `CREATE INDEX IF NOT EXISTS`). Each step is
 * its own transaction, so no lock on one table is held while another is
 * locked.
 *
 * @param body - Statements to run under the lock, without the final `;`.
 * @returns The `DO` statement.
 */
function serializedStep(body: string): string {
  return `DO $shop_identity$
BEGIN
  PERFORM pg_advisory_xact_lock(${SHOP_IDENTITY_MIGRATION_LOCK});
  ${body};
END;
$shop_identity$`;
}

/**
 * Body of one migration step that replaces a trigger function and drops and
 * recreates its trigger. It first takes `ACCESS EXCLUSIVE` on the table, the
 * lock `DROP TRIGGER` needs, so no writer sees the table without the trigger
 * and the step never upgrades a weaker lock it already holds.
 *
 * @param table - Table the trigger is on.
 * @param fn - `CREATE OR REPLACE FUNCTION …` statement of the trigger function.
 * @param drop - `DROP TRIGGER IF EXISTS …` statement.
 * @param create - `CREATE TRIGGER …` statement.
 * @returns Statements for {@link serializedStep}.
 */
function replaceTrigger(table: string, fn: string, drop: string, create: string): string {
  return `LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE;
  ${fn};
  ${drop};
  ${create}`;
}

/**
 * Idempotent SQL for `shop_identity`, its keyset index, the shop candidate
 * index on `message` and the queue triggers (matches
 * `docs/schema/shop_identity.sql`). Every entry is one {@link serializedStep}.
 */
export const SHOP_IDENTITY_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS shop_identity (
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
   )`,
  `CREATE INDEX IF NOT EXISTS shop_identity_key_order_idx
     ON shop_identity (nostr_key_created_at, message_id)`,
  `CREATE INDEX IF NOT EXISTS message_shop_candidate_idx
     ON message (created_at, id)
     WHERE parent_id IS NULL AND deleted_at IS NULL AND shop_account_id IS NOT NULL
       AND place_lat IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS message_shop_directory_idx
     ON message (created_at, id)
     WHERE parent_id IS NULL AND deleted_at IS NULL AND shop_account_id IS NOT NULL
       AND text ~* '#21giftsshop([^a-z0-9_]|$)'`,
  replaceTrigger(
    'message',
    `CREATE OR REPLACE FUNCTION queue_shop_identity_place() RETURNS trigger AS $$
   BEGIN
     UPDATE shop_identity SET ocp_place_pending = true,
       ocp_place_generation = ocp_place_generation + 1
     WHERE message_id = NEW.id;
     IF ${DIRECTORY_SQL('NEW')} THEN
       UPDATE shop_identity SET ocp_photos_pending = true,
         ocp_photos_generation = ocp_photos_generation + 1
       WHERE message_id = NEW.id;
     END IF;
     RETURN NEW;
   END
   $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS trg_shop_identity_place ON message`,
    `CREATE TRIGGER trg_shop_identity_place
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
   EXECUTE FUNCTION queue_shop_identity_place()`,
  ),
  replaceTrigger(
    'message',
    `CREATE OR REPLACE FUNCTION queue_shop_identity_cover() RETURNS trigger AS $$
   BEGIN
     IF ${DIRECTORY_SQL('NEW')} THEN
       UPDATE shop_identity SET ocp_photos_pending = true,
         ocp_photos_generation = ocp_photos_generation + 1
       WHERE message_id = NEW.id;
     END IF;
     RETURN NEW;
   END
   $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS trg_shop_identity_cover ON message`,
    `CREATE TRIGGER trg_shop_identity_cover
   AFTER UPDATE OF photo, photo_content_type ON message
   FOR EACH ROW WHEN (
     OLD.photo IS DISTINCT FROM NEW.photo OR
     OLD.photo_content_type IS DISTINCT FROM NEW.photo_content_type
   )
   EXECUTE FUNCTION queue_shop_identity_cover()`,
  ),
  replaceTrigger(
    'message_extra_photo',
    `CREATE OR REPLACE FUNCTION queue_shop_identity_photo() RETURNS trigger AS $$
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
       SELECT 1 FROM message m WHERE m.id = target AND ${DIRECTORY_SQL('m')}
     );
     IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
     RETURN NEW;
   END
   $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS trg_shop_identity_extra_photo ON message_extra_photo`,
    `CREATE TRIGGER trg_shop_identity_extra_photo AFTER INSERT OR UPDATE OR DELETE ON message_extra_photo
   FOR EACH ROW EXECUTE FUNCTION queue_shop_identity_photo()`,
  ),
].map(serializedStep);

/**
 * Apply {@link SHOP_IDENTITY_SCHEMA_SQL} in order. Idempotent.
 *
 * @param sql - Parameter-bound SQL client.
 * @returns Resolves when every statement has run.
 */
export async function migrateShopIdentitySchema(sql: SqlClient): Promise<void> {
  for (const statement of SHOP_IDENTITY_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}

/**
 * Canonical npub of one stored shop identity.
 *
 * @param identity - Row with the 64-hex public key.
 * @returns NIP-19 `npub1…`.
 */
export function shopNpub(identity: Pick<ShopIdentityRow, 'nostrPubkey'>): string {
  return nip19.npubEncode(identity.nostrPubkey);
}

/**
 * Forum notes whose Nostr key already exists at OpenCryptoPay.
 *
 * `ensureListed` must not mint a second key for these message ids. The
 * matching private key is stored with `adoptKnownSecret`. The ids are the
 * OpenCryptoPay `externalId` values. This list holds no key material.
 */
const ADOPTED_SHOP_MESSAGE_IDS: ReadonlySet<string> = new Set([
  '01234513-9ed1-4bf1-ac19-2cc59ba6ae3b',
  '0a8bb5d4-32d2-4316-8f0a-f40e09ccb57e',
  '0cc5c2eb-aaf1-4f36-be26-f1b967e7bbe5',
  '0e54d662-e955-4c66-94d6-1d5f895506eb',
  '23d08047-df13-4f59-a541-99703e1e8fbc',
  '2e5c0aaf-a2f1-4d3a-8640-4463cba227f6',
  '4ba2c157-76a9-460f-9335-dc0ee8177b90',
  '5732c809-562e-4df3-b804-f287be068314',
  '61f13589-f04b-4319-9677-7e6b3dbab24a',
  '746b992c-ee86-4c27-b36e-8f661e27a3d0',
  '764288f2-2ac9-4758-9506-eb81a6f8bcbf',
  '7eebacb2-cd04-46af-8d3d-fa761a4b4905',
  '83a72d54-7070-4a8a-b3f4-9f0ca8d0dc30',
  '8a7d0c1a-1428-4d32-b28c-665b75dd8313',
  '8cb805cd-3fbe-4d19-8a51-8d2e36d169ab',
  '96ecd063-94e9-4866-bd97-a7dcfba7e5d9',
  '9980925c-42cb-4fe6-bbd9-1ddb27c9936f',
  '9e6642fd-3a62-497d-bcbc-9b9daa9d55c7',
  'd9ec7a6a-d4e0-43bc-95a4-dbfccebccbe2',
  'e942dd1c-1fc4-4ce9-8252-8922f7e93fdf',
  'ed3c5451-57c2-41c2-9450-b4e92df8d8db',
]);

/**
 * Whether this shop note already has a Nostr key at OpenCryptoPay.
 *
 * @param messageId - Forum note id, the OpenCryptoPay `externalId`.
 * @returns `true` when `ensureListed` must not mint a key for it.
 */
export function shopKeyMustBeAdopted(messageId: string): boolean {
  return ADOPTED_SHOP_MESSAGE_IDS.has(messageId);
}

/**
 * Structural rows read per returned shop. The directory stops after
 * `20 * limit` of them, including rows it then drops.
 */
const DIRECTORY_SCAN_PER_SHOP = 20;

/** One structural note plus the pubkey of its identity, if it has one. */
interface DirectoryStructuralRow {
  /** Note id. */
  id: string;
  /** Note creation time. */
  createdAt: Date;
  /** Fields {@link publicShop} reads. */
  note: ShopListingFields;
  /** Hex pubkey, or null when `shop_identity` has no row. */
  nostrPubkey: string | null;
}

/**
 * Whether `row` is a public shop the directory can read: the same columns as
 * {@link DIRECTORY_SQL}. A missing pin still matches.
 *
 * @param row - Forum note.
 * @returns `true` when the note would match the directory `WHERE`.
 */
function listedShape(row: MessageRow): boolean {
  if (row.parentId !== null) return false;
  if (row.deletedAt !== null) return false;
  if (row.shopAccount === undefined || row.shopAccount === null) return false;
  return textHasHashtagToken(row.text, '21GiftsShop');
}

/**
 * Whether `row` is strictly older than `cursor` in directory order
 * (`createdAt` descending, then `id` descending).
 *
 * @param row - A structural note.
 * @param cursor - Last examined note.
 * @returns `true` when the note belongs on a later page.
 */
function directoryOlder(
  row: { createdAt: Date; id: string },
  cursor: ShopDirectoryCursor,
): boolean {
  const time = row.createdAt.getTime();
  const cursorTime = cursor.createdAt.getTime();
  if (time < cursorTime) return true;
  if (time > cursorTime) return false;
  return row.id < cursor.id;
}

/**
 * Newest note first, then `id` descending.
 *
 * @param a - A structural note.
 * @param b - A structural note.
 * @returns A sort delta.
 */
function byDirectoryOrder(
  a: { createdAt: Date; id: string },
  b: { createdAt: Date; id: string },
): number {
  const time = b.createdAt.getTime() - a.createdAt.getTime();
  if (time !== 0) return time;
  return a.id < b.id ? 1 : -1;
}

/**
 * A kept shop, or null when the row has no key or {@link publicShop} rejects it.
 * A null result was still examined by the caller.
 *
 * @param row - One structural note.
 * @returns The directory item, or null.
 */
function directoryItem(row: DirectoryStructuralRow): ShopDirectoryItem | null {
  if (row.nostrPubkey === null) return null;
  const shop = publicShop(row.note);
  if (shop === null) return null;
  return {
    id: row.id,
    createdAt: row.createdAt,
    npub: shopNpub({ nostrPubkey: row.nostrPubkey }),
    name: shop.name,
    place: shop.place,
  };
}

/**
 * Turn one structural page into directory shops. `requested` is the cap
 * (`20 * limit`). Filling `limit` before the last row stops on the last kept
 * shop and leaves the rest of the page unread. A short page that was read
 * to the end has no `next`, even when it filled `limit`. A full page that
 * did not fill `limit` continues at the last examined row.
 *
 * @param rows - Structural rows, newest first, at most `requested`.
 * @param requested - How many rows the page asked for.
 * @param limit - Most shops to keep.
 * @returns The directory page.
 */
function directoryPage(
  rows: readonly DirectoryStructuralRow[],
  requested: number,
  limit: number,
): ShopDirectoryPage {
  const shops: ShopDirectoryItem[] = [];
  let lastExamined: ShopDirectoryCursor | null = null;
  for (const [index, row] of rows.entries()) {
    lastExamined = { createdAt: row.createdAt, id: row.id };
    const shop = directoryItem(row);
    if (shop !== null) {
      shops.push(shop);
      if (shops.length === limit && index + 1 < rows.length) {
        return { shops, next: { createdAt: shop.createdAt, id: shop.id } };
      }
    }
  }
  if (lastExamined === null || rows.length < requested) return { shops, next: null };
  return { shops, next: lastExamined };
}

function copyIdentity(row: ShopIdentityRow): ShopIdentityRow {
  return {
    ...row,
    nostrNsecCiphertext: row.nostrNsecCiphertext.slice(),
    nostrKeyCreatedAt: new Date(row.nostrKeyCreatedAt),
    ocpPhotosClaimedUntil:
      row.ocpPhotosClaimedUntil === null ? null : new Date(row.ocpPhotosClaimedUntil),
    ocpPlaceClaimedUntil:
      row.ocpPlaceClaimedUntil === null ? null : new Date(row.ocpPlaceClaimedUntil),
  };
}

/**
 * Profile name stored with an adopted key.
 *
 * A public shop keeps {@link publicShop}'s name. Another note keeps a
 * non-blank pin label, or `Shop` when it has none.
 *
 * @param note - The forum note the key belongs to.
 * @returns A non-empty name.
 */
function adoptedProfileName(note: MessageRow): string {
  const shop = publicShop(note);
  if (shop !== null) return shop.name;
  const label = note.place?.label?.trim() ?? '';
  return label === '' ? 'Shop' : label;
}

/**
 * Build an identity row from a known 32-byte secret.
 *
 * The place outbox stays idle (`ocpPlacePending` false, generation 0): the
 * OpenCryptoPay place already exists under this key, and a pending flag
 * would queue a push. The caller zeroizes its own buffer; this function
 * zeroizes only its copy.
 *
 * @param messageId - Shop note id, also the AAD suffix.
 * @param secret - Raw secp256k1 secret. Not retained.
 * @param kek - Key-encryption key.
 * @param profileName - Name stored on the row.
 * @param createdAt - Insert time.
 * @returns The row to insert. Throws when the secret is not a usable
 *   secp256k1 secret. The caller rejects a secret that is not 32 bytes.
 */
async function knownShopIdentity(
  messageId: string,
  secret: Uint8Array,
  kek: Uint8Array,
  profileName: string,
  createdAt: Date,
): Promise<ShopIdentityRow> {
  const owned = secret.slice();
  try {
    let nostrPubkey: string;
    try {
      nostrPubkey = publicKeyHexFromSecret(owned);
    } catch {
      throw new Error('Invalid Nostr secret');
    }
    return {
      messageId,
      nostrPubkey,
      nostrNsecCiphertext: await encryptNostrSecret(owned, kek, `shop:${messageId}`),
      nostrKekId: NOSTR_KEK_ID_V1,
      nostrKeyCustody: 'custodial',
      nostrKeyCreatedAt: createdAt,
      profileName,
      ocpPhotosHash: null,
      ocpPhotosPending: false,
      ocpPhotosGeneration: 0,
      ocpPhotosClaimedUntil: null,
      ocpPhotosClaim: 0,
      ocpPlacePending: false,
      ocpPlaceGeneration: 0,
      ocpPlaceClaimedUntil: null,
      ocpPlaceClaim: 0,
      ocpRevision: 0,
    };
  } finally {
    zeroizeSecret(owned);
  }
}

async function freshIdentity(
  messageId: string,
  profileName: string,
  kek: Uint8Array,
  keygen: NostrKeygen,
  createdAt: Date,
): Promise<ShopIdentityRow> {
  const secret = keygen.generateSecretKey();
  try {
    return {
      messageId,
      nostrPubkey: publicKeyHexFromSecret(secret),
      nostrNsecCiphertext: await encryptNostrSecret(secret, kek, `shop:${messageId}`),
      nostrKekId: NOSTR_KEK_ID_V1,
      nostrKeyCustody: 'custodial',
      nostrKeyCreatedAt: createdAt,
      profileName,
      ocpPhotosHash: null,
      ocpPhotosPending: true,
      ocpPhotosGeneration: 1,
      ocpPhotosClaimedUntil: null,
      ocpPhotosClaim: 0,
      ocpPlacePending: true,
      ocpPlaceGeneration: 1,
      ocpPlaceClaimedUntil: null,
      ocpPlaceClaim: 0,
      ocpRevision: 0,
    };
  } finally {
    zeroizeSecret(secret);
  }
}

/**
 * Photo fingerprint of one note for the queue sync.
 *
 * With an {@link InMemoryMessageStore} (every memory boot) it is the store's
 * photo revision, so the sync reads no photo bytes. Another message store
 * (a test double, or a store a caller passes to `createApp` without a shop
 * store) has no revision, so the set is hashed from one `getPhotoSet` read.
 */
async function photoFingerprint(messages: MessageStore, messageId: string): Promise<string> {
  if (messages instanceof InMemoryMessageStore) {
    return `revision:${String(messages.photoRevision(messageId))}`;
  }
  // One read of the whole set: two reads could mix photo 0 of one set with
  // the extras of another.
  const { photo: first, extras } = await messages.getPhotoSet(messageId);
  const hash = createHash('sha256');
  const stills = [...(first === null ? [] : [{ index: 0, photo: first }]), ...extras];
  for (const { index, photo } of stills) {
    hash.update(`${String(index)}:${photo.contentType}:${String(photo.bytes.byteLength)}:`);
    hash.update(photo.bytes);
  }
  return hash.digest('hex');
}

/**
 * In-memory shop identity and outbox adapter for memory boots and tests.
 *
 * Postgres queues through row triggers inside each writing transaction. This
 * adapter has no transactions, so before every call that syncs it compares each
 * identity's note (text, pin, till account, `deletedAt`) and photo set with
 * the last fingerprint it saw and queues a change the same way the triggers
 * do: a place change always queues the place; when the note is a public shop
 * the same sync queues the photos once; a photo-fingerprint change queues
 * photos only while the note is a public shop; when both fingerprints change
 * in one sync the photo generation rises by 1, not by 2.
 * Neither this sync nor the place trigger raises `ocp_revision`.
 * The photo fingerprint of an {@link InMemoryMessageStore} is its
 * `photoRevision`, so a sync reads no photo bytes; another message store is
 * hashed from one `getPhotoSet` read per shop.
 * The lease clock is the process clock.
 */
export class InMemoryShopIdentityStore implements ShopIdentityStore {
  readonly #messages: MessageStore;
  readonly #now: () => number;
  readonly #rows = new Map<string, ShopIdentityRow>();
  readonly #seen = new Map<string, { place: string; photos: string }>();

  /**
   * @param messages - Forum store. Keys follow `publicShop`. Photo
   *   queueing follows `publicShop`.
   * @param now - Lease clock in epoch ms (default `Date.now`).
   */
  constructor(messages: MessageStore, now: () => number = Date.now) {
    this.#messages = messages;
    this.#now = now;
  }

  async #sync(): Promise<void> {
    for (const row of this.#rows.values()) {
      const note = await this.#messages.getById(row.messageId);
      const seen = this.#seen.get(row.messageId) as { place: string; photos: string };
      const place = shopListingFingerprint(note);
      const placeChanged = place !== seen.place;
      if (placeChanged) {
        seen.place = place;
        row.ocpPlacePending = true;
        row.ocpPlaceGeneration += 1;
      }
      const photos = await photoFingerprint(this.#messages, row.messageId);
      const photosChanged = photos !== seen.photos;
      if (photosChanged) seen.photos = photos;
      if (publicShop(note) !== null && (placeChanged || photosChanged)) {
        row.ocpPhotosPending = true;
        row.ocpPhotosGeneration += 1;
      }
    }
  }

  async ensureListed(
    messageId: string,
    kek: Uint8Array,
    keygen: NostrKeygen = defaultNostrKeygen,
  ): Promise<ShopIdentityRow | undefined> {
    await this.#sync();
    const note = await this.#messages.getById(messageId);
    const name = note === undefined ? null : (publicShop(note)?.name ?? null);
    const existing = this.#rows.get(messageId);
    if (existing !== undefined) {
      // The same conditional rename as `renameIfListed` (and the locked
      // rename of the Postgres adapter): a snapshot older than a stored
      // rename changes nothing, so it cannot put an older name back.
      // `existing` is the stored row object, so the copy shows what is stored.
      if (note !== undefined) await this.renameIfListed(note);
      return copyIdentity(existing);
    }
    // A note that already has a key at OpenCryptoPay stays unkeyed until
    // adoptKnownSecret stores that same secret.
    if (shopKeyMustBeAdopted(messageId)) return undefined;
    if (name === null) return undefined;
    const created = await freshIdentity(messageId, name, kek, keygen, new Date(this.#now()));
    // The note can change while the key is generated. Take the name and the
    // fingerprints from a snapshot read after the last await, so the
    // synchronous insert below matches the note it records.
    const photos = await photoFingerprint(this.#messages, messageId);
    const latest = await this.#messages.getById(messageId);
    const won = this.#rows.get(messageId);
    if (won !== undefined) return copyIdentity(won);
    const latestName = latest === undefined ? null : (publicShop(latest)?.name ?? null);
    if (latestName === null) return undefined;
    if ([...this.#rows.values()].some((row) => row.nostrPubkey === created.nostrPubkey)) {
      throw new Error('shop nostr pubkey already exists');
    }
    created.profileName = latestName;
    this.#rows.set(messageId, created);
    this.#seen.set(messageId, { place: shopListingFingerprint(latest), photos });
    if (this.#messages instanceof InMemoryMessageStore) {
      this.#messages.setShopNpub(messageId, shopNpub(created));
    }
    return copyIdentity(created);
  }

  /**
   * Store a shop's existing secret, once.
   *
   * The same public key is returned unchanged, including its outbox flags.
   * A different key for this note, or this key on another note, throws.
   * The insert does not queue a place push. A public shop queues its photos.
   *
   * @param messageId - Shop note id. The note must exist.
   * @param secret - 32-byte secp256k1 secret. Not retained and not zeroized.
   * @param kek - Key-encryption key.
   * @returns The stored identity.
   */
  async adoptKnownSecret(
    messageId: string,
    secret: Uint8Array,
    kek: Uint8Array,
  ): Promise<ShopIdentityRow> {
    if (secret.length !== 32) {
      throw new Error('Nostr secret must be 32 bytes');
    }
    const note = await this.#messages.getById(messageId);
    if (note === undefined) {
      throw new Error('shop note not found');
    }
    const created = await knownShopIdentity(
      messageId,
      secret,
      kek,
      adoptedProfileName(note),
      new Date(this.#now()),
    );
    if (publicShop(note) !== null) {
      created.ocpPhotosPending = true;
      created.ocpPhotosGeneration = 1;
    }
    await this.#sync();
    const existing = this.#rows.get(messageId);
    if (existing !== undefined) {
      if (existing.nostrPubkey !== created.nostrPubkey) {
        throw new Error('shop nostr pubkey already exists');
      }
      return copyIdentity(existing);
    }
    if ([...this.#rows.values()].some((row) => row.nostrPubkey === created.nostrPubkey)) {
      throw new Error('shop nostr pubkey already exists');
    }
    const photos = await photoFingerprint(this.#messages, messageId);
    const won = this.#rows.get(messageId);
    if (won !== undefined) {
      if (won.nostrPubkey !== created.nostrPubkey) {
        throw new Error('shop nostr pubkey already exists');
      }
      return copyIdentity(won);
    }
    this.#rows.set(messageId, created);
    this.#seen.set(messageId, { place: shopListingFingerprint(note), photos });
    if (this.#messages instanceof InMemoryMessageStore) {
      this.#messages.setShopNpub(messageId, shopNpub(created));
    }
    return copyIdentity(created);
  }

  async getByMessageId(messageId: string): Promise<ShopIdentityRow | undefined> {
    await this.#sync();
    const row = this.#rows.get(messageId);
    return row === undefined ? undefined : copyIdentity(row);
  }

  async getByPubkey(pubkey: string): Promise<ShopIdentityRow | undefined> {
    await this.#sync();
    const row = [...this.#rows.values()].find((item) => item.nostrPubkey === pubkey);
    return row === undefined ? undefined : copyIdentity(row);
  }

  getNostrCiphertext(messageId: string): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.#rows.get(messageId)?.nostrNsecCiphertext.slice());
  }

  async listAll(): Promise<ShopIdentityRow[]> {
    await this.#sync();
    return this.#byKeyOrder().map(copyIdentity);
  }

  async listDebug(limit: number): Promise<ShopIdentityRow[]> {
    await this.#sync();
    return this.#byKeyOrder().slice(0, limit).map(copyIdentity);
  }

  async listRound(cursor: ShopIdentityCursor | null, limit: number): Promise<ShopIdentityRow[]> {
    await this.#sync();
    const rows = this.#byKeyOrder();
    const after = rows
      .filter((row) => cursor === null || keyOrder(row, cursor) > 0)
      .slice(0, limit);
    const wrapped =
      cursor === null || after.length >= limit
        ? []
        : rows.filter((row) => keyOrder(row, cursor) <= 0).slice(0, limit - after.length);
    return [...after, ...wrapped].map(copyIdentity);
  }

  async renameIfListed(note: MessageRow): Promise<void> {
    const row = this.#rows.get(note.id);
    const shop = listedSnapshot(note);
    if (row === undefined || shop === null) return;
    const latest = await this.#messages.getById(note.id);
    const current = latest === undefined ? null : listedSnapshot(latest);
    if (current === null || JSON.stringify(current.params) !== JSON.stringify(shop.params)) return;
    row.profileName = shop.name;
  }

  async listCandidates(
    cursor: ShopCandidateCursor | null,
    limit: number,
  ): Promise<ShopCandidate[]> {
    const refs = await this.#messages.listLiveAssignedShops();
    const notes = await Promise.all(refs.map((ref) => this.#messages.getById(ref.id)));
    return notes
      .filter((row): row is MessageRow => row !== undefined)
      .filter((row) => textHasHashtagToken(row.text, '21GiftsShop'))
      .filter(
        (row) =>
          cursor === null ||
          row.createdAt.getTime() > cursor.createdAt.getTime() ||
          (row.createdAt.getTime() === cursor.createdAt.getTime() && row.id > cursor.id),
      )
      .sort((a, b) => {
        const time = a.createdAt.getTime() - b.createdAt.getTime();
        return time !== 0 ? time : a.id < b.id ? -1 : 1;
      })
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        createdAt: new Date(row.createdAt),
        keyed: this.#rows.has(row.id),
      }));
  }

  async listDirectory(
    cursor: ShopDirectoryCursor | null,
    limit: number,
  ): Promise<ShopDirectoryPage> {
    const requested = DIRECTORY_SCAN_PER_SHOP * limit;
    const refs = await this.#messages.listLiveAssignedShops();
    const notes = await Promise.all(refs.map((ref) => this.#messages.getById(ref.id)));
    const rows = notes
      .filter((row): row is MessageRow => row !== undefined)
      .filter((row) => listedShape(row))
      .filter((row) => cursor === null || directoryOlder(row, cursor))
      .sort(byDirectoryOrder)
      .slice(0, requested)
      .map((row) => {
        const identity = this.#rows.get(row.id);
        return {
          id: row.id,
          createdAt: new Date(row.createdAt),
          note: row,
          nostrPubkey: identity === undefined ? null : identity.nostrPubkey,
        };
      });
    return directoryPage(rows, requested, limit);
  }

  async queueAllPlacePage(afterMessageId: string | null, limit: number): Promise<string[]> {
    await this.#sync();
    const rows = this.#byMessageId()
      .filter((row) => afterMessageId === null || row.messageId > afterMessageId)
      .slice(0, limit);
    for (const row of rows) {
      row.ocpPlacePending = true;
      row.ocpPlaceGeneration += 1;
    }
    return rows.map((row) => row.messageId);
  }

  async queueAllPhotoPage(afterMessageId: string | null, limit: number): Promise<string[]> {
    await this.#sync();
    const rows = this.#byMessageId()
      .filter((row) => afterMessageId === null || row.messageId > afterMessageId)
      .slice(0, limit);
    for (const row of rows) {
      row.ocpPhotosPending = true;
      row.ocpPhotosGeneration += 1;
    }
    return rows.map((row) => row.messageId);
  }

  async claimPlaces(limit: number, leaseMs: number): Promise<ShopOcpClaim[]> {
    await this.#sync();
    const nowMs = this.#now();
    const claims: ShopOcpClaim[] = [];
    for (const row of this.#leastRecentlyClaimed((item) => item.ocpPlaceClaimedUntil)) {
      if (claims.length >= limit) break;
      if (!row.ocpPlacePending || !leaseFree(row.ocpPlaceClaimedUntil, nowMs)) continue;
      row.ocpPlaceClaim += 1;
      row.ocpPlaceClaimedUntil = new Date(nowMs + leaseMs);
      claims.push({
        messageId: row.messageId,
        generation: row.ocpPlaceGeneration,
        claim: row.ocpPlaceClaim,
      });
    }
    return claims;
  }

  async claimPhoto(leaseMs: number): Promise<ShopOcpClaim | undefined> {
    await this.#sync();
    const nowMs = this.#now();
    const row = this.#leastRecentlyClaimed((item) => item.ocpPhotosClaimedUntil).find(
      (item) =>
        item.ocpPhotosPending &&
        !item.ocpPlacePending &&
        leaseFree(item.ocpPhotosClaimedUntil, nowMs),
    );
    if (row === undefined) return undefined;
    row.ocpPhotosClaim += 1;
    row.ocpPhotosClaimedUntil = new Date(nowMs + leaseMs);
    return {
      messageId: row.messageId,
      generation: row.ocpPhotosGeneration,
      claim: row.ocpPhotosClaim,
    };
  }

  leaseHasTime(lane: ShopOcpLane, claim: ShopOcpClaim, minimumMs: number): Promise<boolean> {
    const row = this.#claimed(lane, claim);
    if (row === undefined) return Promise.resolve(false);
    const until = lane === 'place' ? row.ocpPlaceClaimedUntil : row.ocpPhotosClaimedUntil;
    const nowMs = this.#now();
    return Promise.resolve(
      until !== null && until.getTime() > nowMs && until.getTime() >= nowMs + minimumMs,
    );
  }

  async nextRevision(lane: ShopOcpLane, claim: ShopOcpClaim): Promise<number | undefined> {
    await this.#sync();
    const row = this.#claimed(lane, claim);
    if (row === undefined) return undefined;
    if (
      lane === 'photos' &&
      (row.ocpPlacePending || row.ocpPhotosGeneration !== claim.generation)
    ) {
      return undefined;
    }
    row.ocpRevision += 1;
    return row.ocpRevision;
  }

  release(lane: ShopOcpLane, claim: ShopOcpClaim): Promise<void> {
    const row = this.#claimed(lane, claim);
    if (row !== undefined) {
      const now = new Date(this.#now());
      if (lane === 'place') row.ocpPlaceClaimedUntil = now;
      else row.ocpPhotosClaimedUntil = now;
    }
    return Promise.resolve();
  }

  async resetPhotosForDelete(claim: ShopOcpClaim): Promise<void> {
    await this.#sync();
    const row = this.#claimed('place', claim);
    if (row !== undefined) {
      row.ocpPhotosHash = null;
      row.ocpPhotosPending = false;
      row.ocpPhotosGeneration += 1;
    }
  }

  async finishPlace(
    claim: ShopOcpClaim,
    result: 'put' | 'created' | 'delete' | 'reject',
  ): Promise<void> {
    await this.#sync();
    const row = this.#claimed('place', claim);
    if (row === undefined) return;
    const current = row.ocpPlaceGeneration === claim.generation;
    if (result === 'created') {
      row.ocpPhotosHash = null;
    }
    if (result === 'created' || (result === 'put' && current)) {
      row.ocpPhotosPending = true;
      row.ocpPhotosGeneration += 1;
    }
    if (current) row.ocpPlacePending = false;
    row.ocpPlaceClaimedUntil = new Date(this.#now());
  }

  async clearPhotoWithoutSend(claim: ShopOcpClaim): Promise<void> {
    await this.#sync();
    const row = this.#claimed('photos', claim);
    if (row === undefined) return;
    row.ocpPhotosClaimedUntil = this.#endPhotoClaim(row, claim);
  }

  clearPhotoHash(claim: ShopOcpClaim): Promise<void> {
    const row = this.#claimed('photos', claim);
    if (row !== undefined) row.ocpPhotosHash = null;
    return Promise.resolve();
  }

  async finishPhotos(claim: ShopOcpClaim, hash: string): Promise<void> {
    await this.#sync();
    const row = this.#claimed('photos', claim);
    if (row === undefined) return;
    if (row.ocpPhotosGeneration === claim.generation) row.ocpPhotosHash = hash;
    row.ocpPhotosClaimedUntil = this.#endPhotoClaim(row, claim);
  }

  async missingPhotoPlace(claim: ShopOcpClaim, listed: boolean): Promise<void> {
    await this.#sync();
    const row = this.#claimed('photos', claim);
    if (row === undefined) return;
    row.ocpPhotosHash = null;
    row.ocpPhotosClaimedUntil = this.#endPhotoClaim(row, claim);
    if (listed) {
      row.ocpPlacePending = true;
      row.ocpPlaceGeneration += 1;
    }
  }

  async deferPhotos(claim: ShopOcpClaim, listed: boolean): Promise<void> {
    await this.#sync();
    const row = this.#claimed('photos', claim);
    if (row === undefined || !listed) return;
    row.ocpPlacePending = true;
    row.ocpPlaceGeneration += 1;
    const photoUntil = row.ocpPhotosClaimedUntil;
    const placeUntil = row.ocpPlaceClaimedUntil;
    if (photoUntil !== null && (placeUntil === null || placeUntil < photoUntil)) {
      row.ocpPlaceClaimedUntil = new Date(photoUntil);
    }
  }

  #byKeyOrder(): ShopIdentityRow[] {
    return [...this.#rows.values()].sort((a, b) =>
      keyOrder(a, { createdAt: b.nostrKeyCreatedAt, messageId: b.messageId }),
    );
  }

  #byMessageId(): ShopIdentityRow[] {
    return [...this.#rows.values()].sort((a, b) => a.messageId.localeCompare(b.messageId));
  }

  /**
   * Rows in claim order (the `ORDER BY … claimed_until ASC NULLS FIRST,
   * message_id` of the Postgres adapter): a null lease (never claimed)
   * first, then the earliest stored end of the last claim (the lease end of
   * a failed send, the time of every other end of a claim), then the message
   * id (the sort is stable).
   */
  #leastRecentlyClaimed(until: (row: ShopIdentityRow) => Date | null): ShopIdentityRow[] {
    const key = (row: ShopIdentityRow): number => until(row)?.getTime() ?? Number.MIN_SAFE_INTEGER;
    return this.#byMessageId().sort((a, b) => key(a) - key(b));
  }

  /**
   * End a photo claim: clear the flag while the generation is still the
   * claim's and return the new lease end, the current time either way (as
   * `release`), so a set changed again goes behind sets that waited longer.
   */
  #endPhotoClaim(row: ShopIdentityRow, claim: ShopOcpClaim): Date {
    if (row.ocpPhotosGeneration === claim.generation) row.ocpPhotosPending = false;
    return new Date(this.#now());
  }

  #claimed(lane: ShopOcpLane, claim: ShopOcpClaim): ShopIdentityRow | undefined {
    const row = this.#rows.get(claim.messageId);
    if (row === undefined) return undefined;
    return (lane === 'place' ? row.ocpPlaceClaim : row.ocpPhotosClaim) === claim.claim
      ? row
      : undefined;
  }
}

/** Sign of `row` against `cursor` in the `listAll()` order (key time, then message id). */
function keyOrder(row: ShopIdentityRow, cursor: ShopIdentityCursor): number {
  const time = row.nostrKeyCreatedAt.getTime() - cursor.createdAt.getTime();
  if (time !== 0) return time;
  return row.messageId < cursor.messageId ? -1 : row.messageId > cursor.messageId ? 1 : 0;
}

function leaseFree(until: Date | null, nowMs: number): boolean {
  return until === null || until.getTime() <= nowMs;
}

type IdentitySqlRow = {
  message_id: string;
  nostr_pubkey: string;
  nostr_nsec_ciphertext: Uint8Array;
  nostr_kek_id: number;
  nostr_key_custody: 'custodial' | 'user';
  nostr_key_created_at: Date | string;
  profile_name: string;
  ocp_photos_hash: string | null;
  ocp_photos_pending: boolean;
  ocp_photos_generation: number;
  ocp_photos_claimed_until: Date | string | null;
  ocp_photos_claim: number;
  ocp_place_pending: boolean;
  ocp_place_generation: number;
  ocp_place_claimed_until: Date | string | null;
  ocp_place_claim: number;
  ocp_revision: number | string | bigint;
};

const IDENTITY_COLUMNS = `message_id, nostr_pubkey, nostr_nsec_ciphertext, nostr_kek_id,
  nostr_key_custody, nostr_key_created_at, profile_name, ocp_photos_hash,
  ocp_photos_pending, ocp_photos_generation, ocp_photos_claimed_until, ocp_photos_claim,
  ocp_place_pending, ocp_place_generation, ocp_place_claimed_until, ocp_place_claim,
  ocp_revision`;

function sqlDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function mapIdentity(row: IdentitySqlRow): ShopIdentityRow {
  return {
    messageId: row.message_id,
    nostrPubkey: row.nostr_pubkey,
    nostrNsecCiphertext: new Uint8Array(row.nostr_nsec_ciphertext),
    nostrKekId: Number(row.nostr_kek_id),
    nostrKeyCustody: row.nostr_key_custody,
    nostrKeyCreatedAt: sqlDate(row.nostr_key_created_at),
    profileName: row.profile_name,
    ocpPhotosHash: row.ocp_photos_hash,
    ocpPhotosPending: row.ocp_photos_pending,
    ocpPhotosGeneration: Number(row.ocp_photos_generation),
    ocpPhotosClaimedUntil:
      row.ocp_photos_claimed_until === null ? null : sqlDate(row.ocp_photos_claimed_until),
    ocpPhotosClaim: Number(row.ocp_photos_claim),
    ocpPlacePending: row.ocp_place_pending,
    ocpPlaceGeneration: Number(row.ocp_place_generation),
    ocpPlaceClaimedUntil:
      row.ocp_place_claimed_until === null ? null : sqlDate(row.ocp_place_claimed_until),
    ocpPlaceClaim: Number(row.ocp_place_claim),
    ocpRevision: Number(row.ocp_revision),
  };
}

/**
 * Locks the note `$1` (`FOR UPDATE`) only while every column the public-shop
 * check read is unchanged: top-level, live, a till account, the text `$3`
 * and the pin. `$2` is the stored label (null when the note has none) and is
 * not the public name. `$4`–`$5` are the coordinates and `$6`–`$10` the
 * address. Nullable pin columns use `IS NOT DISTINCT FROM`, because `=`
 * never matches NULL. Shared by the key insert and the rename
 * (`ensureListed`, `renameIfListed`) in `PostgresShopIdentityStore`.
 */
const LOCK_LISTED_NOTE_SQL = `SELECT id FROM message
         WHERE id = $1 AND parent_id IS NULL AND deleted_at IS NULL
           AND shop_account_id IS NOT NULL
           AND text = $3
           AND place_label IS NOT DISTINCT FROM $2
           AND place_lat IS NOT DISTINCT FROM $4 AND place_lng IS NOT DISTINCT FROM $5
           AND place_street IS NOT DISTINCT FROM $6
           AND place_house_number IS NOT DISTINCT FROM $7
           AND place_postal_code IS NOT DISTINCT FROM $8
           AND place_city IS NOT DISTINCT FROM $9 AND place_country IS NOT DISTINCT FROM $10
         FOR UPDATE`;

/**
 * Public shop name and the parameters `$2`–`$10` of {@link LOCK_LISTED_NOTE_SQL}
 * for one note snapshot, or `null` when that snapshot is not a public shop.
 * The name is not one of those parameters: a shop with no label still has a name.
 */
function listedSnapshot(note: MessageRow): { name: string; params: unknown[] } | null {
  const shop = publicShop(note);
  if (shop === null) return null;
  const place = note.place ?? null;
  const address = place?.address ?? null;
  return {
    name: shop.name,
    params: [
      place?.label ?? null,
      note.text,
      place?.lat ?? null,
      place?.lng ?? null,
      address?.street ?? null,
      address?.houseNumber ?? null,
      address?.postalCode ?? null,
      address?.city ?? null,
      address?.country ?? null,
    ],
  };
}

function lanePrefix(lane: ShopOcpLane): 'ocp_place' | 'ocp_photos' {
  return lane === 'place' ? 'ocp_place' : 'ocp_photos';
}

/**
 * Postgres shop identity and outbox adapter. Leases are set and compared
 * with the database clock (`now()`), and every write after a claim is
 * conditional on its token.
 */
export class PostgresShopIdentityStore implements ShopIdentityStore {
  readonly #sql: SqlClient;
  readonly #messages: MessageStore;

  /**
   * @param sql - Shared SQL client.
   * @param messages - Forum store. Keys follow `publicShop` in code.
   *   Photo queueing follows `publicShop`.
   */
  constructor(sql: SqlClient, messages: MessageStore) {
    this.#sql = sql;
    this.#messages = messages;
  }

  async ensureListed(
    messageId: string,
    kek: Uint8Array,
    keygen: NostrKeygen = defaultNostrKeygen,
  ): Promise<ShopIdentityRow | undefined> {
    const note = await this.#messages.getById(messageId);
    const shop = note === undefined ? null : listedSnapshot(note);
    const existing = await this.getByMessageId(messageId);
    if (existing !== undefined) {
      if (shop === null || shop.name === existing.profileName) return existing;
      return (await this.#renameLocked(messageId, shop)) ?? existing;
    }
    // A note that already has a key at OpenCryptoPay stays unkeyed until
    // adoptKnownSecret stores that same secret.
    if (shopKeyMustBeAdopted(messageId)) return undefined;
    if (shop === null) return undefined;
    const generated = await freshIdentity(messageId, shop.name, kek, keygen, new Date());
    // One statement: lock the note (FOR UPDATE) and insert only while every
    // column the public-shop check read above is unchanged. A concurrent edit
    // either committed before the lock (the values differ, no key; the edit's
    // own write path or the backfill mints it) or waits and then queues
    // itself through the trigger, which sees the committed row.
    const rows = await this.#sql.query<IdentitySqlRow>(
      `WITH locked AS (${LOCK_LISTED_NOTE_SQL})
       INSERT INTO shop_identity (
         message_id, nostr_pubkey, nostr_nsec_ciphertext, nostr_kek_id,
         nostr_key_custody, nostr_key_created_at, profile_name,
         ocp_place_pending, ocp_place_generation,
         ocp_photos_pending, ocp_photos_generation
       )
       SELECT $1, $11, $12, $13, $14, $15, $16, true, 1, true, 1 FROM locked
       ON CONFLICT (message_id) DO NOTHING
       RETURNING ${IDENTITY_COLUMNS}`,
      [
        messageId,
        ...shop.params,
        generated.nostrPubkey,
        generated.nostrNsecCiphertext,
        generated.nostrKekId,
        generated.nostrKeyCustody,
        generated.nostrKeyCreatedAt,
        shop.name,
      ],
    );
    const inserted = rows[0];
    return inserted === undefined ? this.getByMessageId(messageId) : mapIdentity(inserted);
  }

  /**
   * Store a shop's existing secret, once.
   *
   * The same public key is returned unchanged, including its outbox flags.
   * A different key for this note, or this key on another note, throws.
   * The insert does not queue a place push (`ocp_place_pending` stays false,
   * generation 0, SQL literals). Photo flags come from the note locked in
   * the same INSERT (`SELECT … FROM message WHERE id = $1 FOR UPDATE`),
   * using the public-shop condition: pending true and generation 1 when
   * that locked row is a public shop, otherwise false and 0. They are not
   * taken from the earlier note snapshot.
   *
   * @param messageId - Shop note id. The note must exist.
   * @param secret - 32-byte secp256k1 secret. Not retained and not zeroized.
   * @param kek - Key-encryption key.
   * @returns The stored identity.
   */
  async adoptKnownSecret(
    messageId: string,
    secret: Uint8Array,
    kek: Uint8Array,
  ): Promise<ShopIdentityRow> {
    if (secret.length !== 32) {
      throw new Error('Nostr secret must be 32 bytes');
    }
    const note = await this.#messages.getById(messageId);
    if (note === undefined) {
      throw new Error('shop note not found');
    }
    const created = await knownShopIdentity(
      messageId,
      secret,
      kek,
      adoptedProfileName(note),
      new Date(),
    );
    const existing = await this.getByMessageId(messageId);
    if (existing !== undefined) {
      if (existing.nostrPubkey !== created.nostrPubkey) {
        throw new Error('shop nostr pubkey already exists');
      }
      return existing;
    }
    const holder = await this.getByPubkey(created.nostrPubkey);
    if (holder !== undefined) {
      throw new Error('shop nostr pubkey already exists');
    }
    const rows = await this.#sql.query<IdentitySqlRow>(
      `WITH locked AS (
         SELECT id, parent_id, deleted_at, shop_account_id, text
         FROM message
         WHERE id = $1
         FOR UPDATE
       )
       INSERT INTO shop_identity (
         message_id, nostr_pubkey, nostr_nsec_ciphertext, nostr_kek_id,
         nostr_key_custody, nostr_key_created_at, profile_name,
         ocp_place_pending, ocp_place_generation,
         ocp_photos_pending, ocp_photos_generation
       )
       SELECT $1, $2, $3, $4, $5, $6, $7, false, 0,
         CASE WHEN ${DIRECTORY_SQL('locked')} THEN true ELSE false END,
         CASE WHEN ${DIRECTORY_SQL('locked')} THEN 1 ELSE 0 END
       FROM locked
       ON CONFLICT (message_id) DO NOTHING
       RETURNING ${IDENTITY_COLUMNS}`,
      [
        messageId,
        created.nostrPubkey,
        created.nostrNsecCiphertext,
        created.nostrKekId,
        created.nostrKeyCustody,
        created.nostrKeyCreatedAt,
        created.profileName,
      ],
    );
    const inserted = rows[0];
    if (inserted !== undefined) return mapIdentity(inserted);
    const stored = await this.getByMessageId(messageId);
    if (stored === undefined) {
      throw new Error('shop note not found');
    }
    if (stored.nostrPubkey !== created.nostrPubkey) {
      throw new Error('shop nostr pubkey already exists');
    }
    return stored;
  }

  /**
   * Rename only while the note still shows this snapshot, under the same
   * note lock as the insert: an older snapshot read before a newer rename
   * committed matches nothing and cannot overwrite it.
   *
   * @returns The renamed identity, or `undefined` when nothing changed.
   */
  async #renameLocked(
    messageId: string,
    shop: { name: string; params: unknown[] },
  ): Promise<ShopIdentityRow | undefined> {
    const renamed = await this.#sql.query<IdentitySqlRow>(
      `WITH locked AS (${LOCK_LISTED_NOTE_SQL})
       UPDATE shop_identity SET profile_name = $11
       FROM locked
       WHERE shop_identity.message_id = locked.id
         AND shop_identity.profile_name IS DISTINCT FROM $11
       RETURNING ${IDENTITY_COLUMNS}`,
      [messageId, ...shop.params, shop.name],
    );
    return renamed[0] === undefined ? undefined : mapIdentity(renamed[0]);
  }

  async getByMessageId(messageId: string): Promise<ShopIdentityRow | undefined> {
    const rows = await this.#sql.query<IdentitySqlRow>(
      `SELECT ${IDENTITY_COLUMNS} FROM shop_identity WHERE message_id = $1`,
      [messageId],
    );
    return rows[0] === undefined ? undefined : mapIdentity(rows[0]);
  }

  async getByPubkey(pubkey: string): Promise<ShopIdentityRow | undefined> {
    const rows = await this.#sql.query<IdentitySqlRow>(
      `SELECT ${IDENTITY_COLUMNS} FROM shop_identity WHERE nostr_pubkey = $1`,
      [pubkey],
    );
    return rows[0] === undefined ? undefined : mapIdentity(rows[0]);
  }

  async getNostrCiphertext(messageId: string): Promise<Uint8Array | undefined> {
    const rows = await this.#sql.query<{ nostr_nsec_ciphertext: Uint8Array }>(
      `SELECT nostr_nsec_ciphertext FROM shop_identity WHERE message_id = $1`,
      [messageId],
    );
    return rows[0] === undefined ? undefined : new Uint8Array(rows[0].nostr_nsec_ciphertext);
  }

  async listAll(): Promise<ShopIdentityRow[]> {
    const rows = await this.#sql.query<IdentitySqlRow>(
      `SELECT ${IDENTITY_COLUMNS} FROM shop_identity
       ORDER BY nostr_key_created_at ASC, message_id ASC`,
    );
    return rows.map(mapIdentity);
  }

  async listDebug(limit: number): Promise<ShopIdentityRow[]> {
    const rows = await this.#sql.query<IdentitySqlRow>(
      `SELECT ${IDENTITY_COLUMNS} FROM shop_identity
       ORDER BY nostr_key_created_at ASC, message_id ASC
       LIMIT $1`,
      [limit],
    );
    return rows.map(mapIdentity);
  }

  async listRound(cursor: ShopIdentityCursor | null, limit: number): Promise<ShopIdentityRow[]> {
    // Every read walks shop_identity_key_order_idx and stops after `limit`
    // rows. Without a cursor the read has no predicate; with one it has only
    // the row comparison, so even a cached generic plan of a prepared
    // statement keeps the cursor as an index condition. Keys are written from
    // a JavaScript Date, so millisecond cursors compare exactly.
    if (cursor === null) {
      const first = await this.#sql.query<IdentitySqlRow>(
        `SELECT ${IDENTITY_COLUMNS} FROM shop_identity
         ORDER BY nostr_key_created_at ASC, message_id ASC
         LIMIT $1`,
        [limit],
      );
      return first.map(mapIdentity);
    }
    const after = await this.#sql.query<IdentitySqlRow>(
      `SELECT ${IDENTITY_COLUMNS} FROM shop_identity
       WHERE (nostr_key_created_at, message_id) > ($1::timestamptz, $2::uuid)
       ORDER BY nostr_key_created_at ASC, message_id ASC
       LIMIT $3`,
      [cursor.createdAt, cursor.messageId, limit],
    );
    if (after.length >= limit) return after.map(mapIdentity);
    const wrapped = await this.#sql.query<IdentitySqlRow>(
      `SELECT ${IDENTITY_COLUMNS} FROM shop_identity
       WHERE (nostr_key_created_at, message_id) <= ($1::timestamptz, $2::uuid)
       ORDER BY nostr_key_created_at ASC, message_id ASC
       LIMIT $3`,
      [cursor.createdAt, cursor.messageId, limit - after.length],
    );
    return [...after, ...wrapped].map(mapIdentity);
  }

  async renameIfListed(note: MessageRow): Promise<void> {
    const shop = listedSnapshot(note);
    if (shop !== null) await this.#renameLocked(note.id, shop);
  }

  async listCandidates(
    cursor: ShopCandidateCursor | null,
    limit: number,
  ): Promise<ShopCandidate[]> {
    // Walks the partial index message_shop_directory_idx: the WHERE implies
    // its predicate, and LIMIT bounds the raw page before the key check (an
    // EXISTS in the select list, evaluated per returned row only), so a page
    // returns at most `limit` rows even when every candidate has a key. The
    // first page has no cursor predicate; every later page has only the row
    // comparison, so even a cached generic plan of a prepared statement keeps
    // the cursor as an index condition and never reads the rows before it.
    type CandidateSqlRow = { id: string; created_at: Date | string; keyed: boolean };
    const select = `SELECT m.id, m.created_at,
         EXISTS (SELECT 1 FROM shop_identity s WHERE s.message_id = m.id) AS keyed
       FROM message m
       WHERE ${DIRECTORY_SQL('m')}`;
    const rows =
      cursor === null
        ? await this.#sql.query<CandidateSqlRow>(
            `${select}
       ORDER BY m.created_at ASC, m.id ASC
       LIMIT $1`,
            [limit],
          )
        : await this.#sql.query<CandidateSqlRow>(
            `${select}
         AND (m.created_at, m.id) > ($1::timestamptz, $2::uuid)
       ORDER BY m.created_at ASC, m.id ASC
       LIMIT $3`,
            [cursor.createdAt, cursor.id, limit],
          );
    return rows.map((row) => ({
      id: row.id,
      createdAt: sqlDate(row.created_at),
      keyed: row.keyed,
    }));
  }

  async listDirectory(
    cursor: ShopDirectoryCursor | null,
    limit: number,
  ): Promise<ShopDirectoryPage> {
    // The WHERE implies message_shop_directory_idx, and LIMIT bounds the page
    // before the pubkey lookup. Two statements keep the cursor an index
    // condition under a cached generic plan of a prepared statement. The
    // pubkey subquery must not become a join: a join would let that plan turn
    // the cursor into a filter and re-read every newer candidate.
    type DirectorySqlRow = {
      id: string;
      created_at: Date | string;
      text: string;
      parent_id: string | null;
      deleted_at: Date | string | null;
      place_lat: number | string | null;
      place_lng: number | string | null;
      place_label: string | null;
      place_street: string | null;
      place_house_number: string | null;
      place_postal_code: string | null;
      place_city: string | null;
      place_country: string | null;
      shop_account_id: string;
      nostr_pubkey: string | null;
    };
    const requested = DIRECTORY_SCAN_PER_SHOP * limit;
    const select = `SELECT m.id, m.created_at, m.text, m.parent_id, m.deleted_at,
         m.place_lat, m.place_lng, m.place_label, m.place_street,
         m.place_house_number, m.place_postal_code, m.place_city, m.place_country,
         m.shop_account_id,
         (SELECT s.nostr_pubkey FROM shop_identity s WHERE s.message_id = m.id) AS nostr_pubkey
       FROM message m
       WHERE ${DIRECTORY_SQL('m')}`;
    const rows =
      cursor === null
        ? await this.#sql.query<DirectorySqlRow>(
            `${select}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $1`,
            [requested],
          )
        : await this.#sql.query<DirectorySqlRow>(
            `${select}
         AND (m.created_at, m.id) < ($1::timestamptz, $2::uuid)
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $3`,
            [cursor.createdAt, cursor.id, requested],
          );
    return directoryPage(
      rows.map((row) => ({
        id: row.id,
        createdAt: sqlDate(row.created_at),
        nostrPubkey: row.nostr_pubkey,
        note: {
          parentId: row.parent_id,
          deletedAt: row.deleted_at === null ? null : sqlDate(row.deleted_at),
          text: row.text,
          place:
            row.place_lat === null || row.place_lng === null
              ? null
              : {
                  lat: Number(row.place_lat),
                  lng: Number(row.place_lng),
                  label: row.place_label,
                  address:
                    row.place_street === null ||
                    row.place_house_number === null ||
                    row.place_postal_code === null ||
                    row.place_city === null ||
                    row.place_country === null
                      ? null
                      : {
                          street: row.place_street,
                          houseNumber: row.place_house_number,
                          postalCode: row.place_postal_code,
                          city: row.place_city,
                          country: row.place_country,
                        },
                },
          shopAccount: { id: row.shop_account_id },
        },
      })),
      requested,
      limit,
    );
  }

  async queueAllPlacePage(afterMessageId: string | null, limit: number): Promise<string[]> {
    // Two statements, so the cursor is always an index condition on the
    // primary key, also under a cached generic plan.
    const page =
      afterMessageId === null
        ? 'SELECT message_id FROM shop_identity ORDER BY message_id LIMIT $1'
        : 'SELECT message_id FROM shop_identity WHERE message_id > $2::uuid ORDER BY message_id LIMIT $1';
    const rows = await this.#sql.query<{ message_id: string }>(
      `WITH page AS (${page})
       UPDATE shop_identity s SET ocp_place_pending = true,
         ocp_place_generation = s.ocp_place_generation + 1
       FROM page WHERE s.message_id = page.message_id
       RETURNING s.message_id`,
      afterMessageId === null ? [limit] : [limit, afterMessageId],
    );
    return rows.map((row) => row.message_id).sort();
  }

  async queueAllPhotoPage(afterMessageId: string | null, limit: number): Promise<string[]> {
    // Two statements, so the cursor is always an index condition on the
    // primary key, also under a cached generic plan.
    const page =
      afterMessageId === null
        ? 'SELECT message_id FROM shop_identity ORDER BY message_id LIMIT $1'
        : 'SELECT message_id FROM shop_identity WHERE message_id > $2::uuid ORDER BY message_id LIMIT $1';
    const rows = await this.#sql.query<{ message_id: string }>(
      `WITH page AS (${page})
       UPDATE shop_identity s SET ocp_photos_pending = true,
         ocp_photos_generation = s.ocp_photos_generation + 1
       FROM page WHERE s.message_id = page.message_id
       RETURNING s.message_id`,
      afterMessageId === null ? [limit] : [limit, afterMessageId],
    );
    return rows.map((row) => row.message_id).sort();
  }

  async claimPlaces(limit: number, leaseMs: number): Promise<ShopOcpClaim[]> {
    const rows = await this.#sql.query<{
      message_id: string;
      ocp_place_generation: number;
      ocp_place_claim: number;
    }>(
      `WITH picked AS (
         SELECT message_id FROM shop_identity
         WHERE ocp_place_pending
           AND (ocp_place_claimed_until IS NULL OR ocp_place_claimed_until <= now())
         ORDER BY ocp_place_claimed_until ASC NULLS FIRST, message_id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE shop_identity s SET
         ocp_place_claimed_until = now() + ($2::bigint * interval '1 millisecond'),
         ocp_place_claim = s.ocp_place_claim + 1
       FROM picked WHERE s.message_id = picked.message_id
       RETURNING s.message_id, s.ocp_place_generation, s.ocp_place_claim`,
      [limit, leaseMs],
    );
    return rows.map((row) => ({
      messageId: row.message_id,
      generation: Number(row.ocp_place_generation),
      claim: Number(row.ocp_place_claim),
    }));
  }

  async claimPhoto(leaseMs: number): Promise<ShopOcpClaim | undefined> {
    const rows = await this.#sql.query<{
      message_id: string;
      ocp_photos_generation: number;
      ocp_photos_claim: number;
    }>(
      `WITH picked AS (
         SELECT message_id FROM shop_identity
         WHERE ocp_photos_pending AND NOT ocp_place_pending
           AND (ocp_photos_claimed_until IS NULL OR ocp_photos_claimed_until <= now())
         ORDER BY ocp_photos_claimed_until ASC NULLS FIRST, message_id
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE shop_identity s SET
         ocp_photos_claimed_until = now() + ($1::bigint * interval '1 millisecond'),
         ocp_photos_claim = s.ocp_photos_claim + 1
       FROM picked WHERE s.message_id = picked.message_id
       RETURNING s.message_id, s.ocp_photos_generation, s.ocp_photos_claim`,
      [leaseMs],
    );
    const row = rows[0];
    return row === undefined
      ? undefined
      : {
          messageId: row.message_id,
          generation: Number(row.ocp_photos_generation),
          claim: Number(row.ocp_photos_claim),
        };
  }

  async leaseHasTime(lane: ShopOcpLane, claim: ShopOcpClaim, minimumMs: number): Promise<boolean> {
    const prefix = lanePrefix(lane);
    const rows = await this.#sql.query<{ ok: number }>(
      `SELECT 1 AS ok FROM shop_identity
       WHERE message_id = $1 AND ${prefix}_claim = $2
         AND ${prefix}_claimed_until > now()
         AND ${prefix}_claimed_until >= now() + ($3::bigint * interval '1 millisecond')`,
      [claim.messageId, claim.claim, minimumMs],
    );
    return rows.length > 0;
  }

  async nextRevision(lane: ShopOcpLane, claim: ShopOcpClaim): Promise<number | undefined> {
    const prefix = lanePrefix(lane);
    // Photos: the same statement checks that the place is not pending and
    // the generation is the claim's, so a place write that came in after
    // the claim read the photos (and every revision it reserves) wins.
    const photos = lane === 'photos';
    const photoGuard = photos ? 'AND NOT ocp_place_pending AND ocp_photos_generation = $3' : '';
    const rows = await this.#sql.query<{ ocp_revision: number | string | bigint }>(
      `UPDATE shop_identity SET ocp_revision = ocp_revision + 1
       WHERE message_id = $1 AND ${prefix}_claim = $2
         AND ocp_revision < 9007199254740991 ${photoGuard}
       RETURNING ocp_revision`,
      photos ? [claim.messageId, claim.claim, claim.generation] : [claim.messageId, claim.claim],
    );
    return rows[0] === undefined ? undefined : Number(rows[0].ocp_revision);
  }

  async release(lane: ShopOcpLane, claim: ShopOcpClaim): Promise<void> {
    const prefix = lanePrefix(lane);
    await this.#sql.execute(
      `UPDATE shop_identity SET ${prefix}_claimed_until = now()
       WHERE message_id = $1 AND ${prefix}_claim = $2`,
      [claim.messageId, claim.claim],
    );
  }

  async resetPhotosForDelete(claim: ShopOcpClaim): Promise<void> {
    await this.#sql.execute(
      `UPDATE shop_identity SET ocp_photos_hash = NULL, ocp_photos_pending = false,
         ocp_photos_generation = ocp_photos_generation + 1
       WHERE message_id = $1 AND ocp_place_claim = $2`,
      [claim.messageId, claim.claim],
    );
  }

  async finishPlace(
    claim: ShopOcpClaim,
    result: 'put' | 'created' | 'delete' | 'reject',
  ): Promise<void> {
    const created = result === 'created';
    const put = result === 'put';
    await this.#sql.execute(
      `UPDATE shop_identity SET
         ocp_photos_hash = CASE WHEN $4::boolean THEN NULL ELSE ocp_photos_hash END,
         ocp_photos_pending = CASE
           WHEN $4::boolean OR ($5::boolean AND ocp_place_generation = $3) THEN true
           ELSE ocp_photos_pending
         END,
         ocp_photos_generation = ocp_photos_generation + CASE
           WHEN $4::boolean OR ($5::boolean AND ocp_place_generation = $3) THEN 1 ELSE 0
         END,
         ocp_place_pending = CASE WHEN ocp_place_generation = $3 THEN false ELSE ocp_place_pending END,
         ocp_place_claimed_until = now()
       WHERE message_id = $1 AND ocp_place_claim = $2`,
      [claim.messageId, claim.claim, claim.generation, created, put],
    );
  }

  async clearPhotoWithoutSend(claim: ShopOcpClaim): Promise<void> {
    await this.#sql.execute(
      `UPDATE shop_identity SET
         ocp_photos_pending = CASE WHEN ocp_photos_generation = $3 THEN false ELSE ocp_photos_pending END,
         ocp_photos_claimed_until = now()
       WHERE message_id = $1 AND ocp_photos_claim = $2`,
      [claim.messageId, claim.claim, claim.generation],
    );
  }

  async clearPhotoHash(claim: ShopOcpClaim): Promise<void> {
    await this.#sql.execute(
      `UPDATE shop_identity SET ocp_photos_hash = NULL
       WHERE message_id = $1 AND ocp_photos_claim = $2`,
      [claim.messageId, claim.claim],
    );
  }

  async finishPhotos(claim: ShopOcpClaim, hash: string): Promise<void> {
    await this.#sql.execute(
      `UPDATE shop_identity SET
         ocp_photos_hash = CASE WHEN ocp_photos_generation = $3 THEN $4 ELSE ocp_photos_hash END,
         ocp_photos_pending = CASE WHEN ocp_photos_generation = $3 THEN false ELSE ocp_photos_pending END,
         ocp_photos_claimed_until = now()
       WHERE message_id = $1 AND ocp_photos_claim = $2`,
      [claim.messageId, claim.claim, claim.generation, hash],
    );
  }

  async missingPhotoPlace(claim: ShopOcpClaim, listed: boolean): Promise<void> {
    await this.#sql.execute(
      `UPDATE shop_identity SET
         ocp_photos_hash = NULL,
         ocp_photos_pending = CASE WHEN ocp_photos_generation = $3 THEN false ELSE ocp_photos_pending END,
         ocp_photos_claimed_until = now(),
         ocp_place_pending = CASE WHEN $4::boolean THEN true ELSE ocp_place_pending END,
         ocp_place_generation = ocp_place_generation + CASE WHEN $4::boolean THEN 1 ELSE 0 END
       WHERE message_id = $1 AND ocp_photos_claim = $2`,
      [claim.messageId, claim.claim, claim.generation, listed],
    );
  }

  async deferPhotos(claim: ShopOcpClaim, listed: boolean): Promise<void> {
    if (!listed) return;
    await this.#sql.execute(
      `UPDATE shop_identity SET
         ocp_place_pending = true,
         ocp_place_generation = ocp_place_generation + 1,
         ocp_place_claimed_until = GREATEST(ocp_place_claimed_until, ocp_photos_claimed_until)
       WHERE message_id = $1 AND ocp_photos_claim = $2`,
      [claim.messageId, claim.claim],
    );
  }
}
