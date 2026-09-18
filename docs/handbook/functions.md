# Functions

## Function: buildGiftDay

- **Purpose:** Pure list of outbound gifts that fall on one UTC calendar day, with BTC/USD at that day's close and additive CHF/EUR/PHP from that UTC day's USD cross.
- **Inputs:** `day` (`YYYY-MM-DD`), `readonly GiftRow[]` (other days ignored), `ReadonlyMap` of UTC day → USD-per-BTC, optional `ReadonlyMap` of UTC day → USD→CHF/EUR/PHP. Empty matching set needs no rates.
- **Returns / side effects:** `GiftDay` (`gifts` sorted by `paidAt` then `recipient`) with `totalChf`/`totalEur`/`totalPhp` and `fx.quotes`. Empty day is `"0.00"` fiat and USD-only `quotes`. Throws `Error('fx.rate.missing')` when a listed gift has no BTC-USD rate. Missing CHF/EUR/PHP is JSON `null`, never a throw. No I/O.
- **Used by:** `giftsRoutes`.

## Function: buildAccountActivity

- **Purpose:** Aggregate given and received sats for one account: confirmed forum zaps paid by the account, indexed zaps on notes it authored including hidden, plus `message.sats` remainder on **top-level** notes only (gift-as-reply `sats` are not Received), house gifts to its Lightning handle, and every outbound house gift when `isPlatform` is true. Does not change `GET /gifts/stats`. Activity series (`donatedOverTime` / `receivedOverTime`) are the same `spendOverTime` day objects as `GET /gifts/stats` including additive CHF/EUR/PHP. USD = per-gift UTC-day Coinbase BTC-USD close. CHF/EUR/PHP = USD × that UTC day's Frankfurter ECB cross.
- **Inputs:** `{ account, gifts, messages, rates, now, fiatRates? }`. Uses `listInvoiceAttemptsForPayer`, `listIndexedZapIngests`, `listAuthoredMessages`, `listOutbound`, and `giftsForRecipient`. Optional `fiatRates` defaults to an empty `InMemoryFiatStore`.
- **Returns / side effects:** `AccountActivity` (`donatedSats`, `receivedSats`, `donatedOverTime`, `receivedOverTime`, `fx`). Empty input is zeros with USD-only `fx.quotes`, without Coinbase and without Frankfurter. Throws `Error('fx.rate.missing')` when a gift day has no BTC-USD rate after `ensureDays`. Missing CHF/EUR/PHP is JSON `null`, never a throw (`account.activity.fiat_failed` still returns USD).
- **Used by:** `GET /me/activity`, `GET /members/:accountId/activity`, `GET /view/:viewKey/activity`.

## Function: matchConfirmedGivenZaps

- **Purpose:** Join `result === 'ok'` invoices to indexed zap ingests by payment hash. A hashed invoice that misses the ingest map is skipped (no tuple fallback). Hashless invoices may match a unique `(messageId, amountSats)` ingest. Skip unmatched and non-ok invoices. Each ingest is used at most once.
- **Inputs:** `readonly MessageInvoiceAttempt[]` and `readonly ZapIngestRow[]`.
- **Returns / side effects:** `GiftRow[]` with `paidAt` from the ingest. No I/O.
- **Used by:** `buildAccountActivity`.

## Function: paymentHashFromReceipt

- **Purpose:** Read a kind:9735 receipt's `bolt11` tag and return the decoded lowercase payment hash.
- **Inputs:** `Record<string, unknown>` receipt JSON (`tags` must be an array of string arrays).
- **Returns / side effects:** 64-hex hash, or `null` when tags/bolt11/decode fail. No I/O.
- **Used by:** `matchConfirmedGivenZaps`.

## Function: buildGiftStats

- **Purpose:** Pure aggregation of outbound gifts into the public stats JSON (UTC daily series with gap days, months with gap months, recipients) including BTC strings, historical USD from per-gift day rates, and additive CHF/EUR/PHP from each gift day's USD cross.
- **Inputs:** `readonly GiftRow[]` (`paidAt`, `amountSats`, `recipientWosUser`), `ReadonlyMap<string, string>` of UTC day → USD-per-BTC, optional `ReadonlyMap` of UTC day → USD→CHF/EUR/PHP. Empty rows need no rates.
- **Returns / side effects:** `GiftStats` with `totalBtc`, `totalUsd`, `totalChf`/`totalEur`/`totalPhp`, `fx` (including `fx.quotes`), and BTC/USD/fiat on series/buckets. Throws `Error('fx.rate.missing')` when a gift day has no BTC-USD rate. Missing CHF/EUR/PHP is JSON `null`, never a throw. Gap days and gap months are zero sats/BTC/USD and `"0.00"` fiat without a rate. No I/O.
- **Used by:** `giftsStatsRoutes`.

## Function: giftsForRecipient

- **Purpose:** Filter outbound gift rows to one Wallet of Satoshi handle (case-insensitive). Used by `GET /gifts/stats?recipient=` so stats reflect that handle's gifts only.
- **Inputs:** `readonly GiftRow[]` and `recipient` string. Trims `recipient`; when `indexOf('@') > 0` compares the local-part before `@`, otherwise the whole trimmed string. Empty after trim matches nothing — never "all gifts".
- **Returns / side effects:** Matching `GiftRow[]` in input order, or `[]`. No I/O.
- **Used by:** `giftsStatsRoutes`.

## Function: giftsRoutes

- **Purpose:** Hono sub-app for `GET /gifts?day=YYYY-MM-DD`. Invalid/missing `day` → 400. Empty day → 200 without Coinbase or Frankfurter. Gifts present → BTC-USD `ensureDays([day])` then fiat `ensureDays([day])`; missing BTC-USD → 503. Missing CHF/EUR/PHP is JSON `null`, never 503.
- **Inputs:** `{ store: GiftStore; rates?: BtcUsdRateBook; fiatRates?: FiatRateBook; now?: () => number }` (defaults: empty `InMemoryBtcUsdStore`, empty `InMemoryFiatStore`, `Date.now`).
- **Returns / side effects:** Hono app mounted at `/gifts`. Logs `gifts.day.fx_incomplete` or `gifts.day.failed` on 503 paths; logs `gifts.day.fiat_failed` when fiat ensure throws (still 200 with null CHF/EUR/PHP).
- **Used by:** `createApp`.

## Function: giftsStatsRoutes

- **Purpose:** Hono sub-app for `GET /gifts/stats`. Optional `?recipient=` filters via `giftsForRecipient` before aggregation. Empty selection (no gifts, or unknown handle) → empty stats 200 without Coinbase or Frankfurter. Otherwise BTC-USD then fiat `ensureDays` for unique selected gift days; missing BTC-USD → 503. Missing CHF/EUR/PHP is JSON `null`, never 503.
- **Inputs:** `{ store: GiftStore; rates?: BtcUsdRateBook; fiatRates?: FiatRateBook; now?: () => number }` (defaults: empty `InMemoryBtcUsdStore`, empty `InMemoryFiatStore`, `Date.now`). Query `recipient` is optional (missing/blank = unfiltered).
- **Returns / side effects:** Hono app mounted at `/gifts/stats`. Logs `gifts.stats.fx_incomplete` or `gifts.stats.failed` on 503 paths; logs `gifts.stats.fiat_failed` when fiat ensure throws (still 200 with null CHF/EUR/PHP).
- **Used by:** `createApp`.

## Function: isUtcDay

- **Purpose:** Validate a UTC calendar day string `YYYY-MM-DD` (rejects `2026-02-31` and non-shape input).
- **Inputs:** Candidate `day` string.
- **Returns / side effects:** `true` only for a real UTC date. No I/O.
- **Used by:** `giftsRoutes`.

## Function: utcDayFromPaidAt

- **Purpose:** UTC calendar day `YYYY-MM-DD` from a `Date` (`toISOString` slice).
- **Inputs:** `paidAt` instant.
- **Returns / side effects:** Day string. No I/O.
- **Used by:** `buildGiftDay`, `giftsRoutes`.

## Function: satsToBtcString

- **Purpose:** Format non-negative integer sats as an eight-decimal BTC string.
- **Inputs:** `sats` number (non-negative integer).
- **Returns / side effects:** e.g. `"0.00001000"`. Throws on invalid sats. No I/O.
- **Used by:** `buildGiftStats`.

## Function: parseUsdPerBtc

- **Purpose:** Parse a USD-per-BTC decimal string into an 8-decimal scaled `bigint`.
- **Inputs:** Rate string (e.g. `"95000.12"`). Extra fractional digits round half-up.
- **Returns / side effects:** `rate * 10^8` as `bigint`. Throws if invalid or `<= 0`. No I/O.
- **Used by:** `satsToUsdCents`.

## Function: satsToUsdCents

- **Purpose:** Convert sats to USD cents at a USD-per-BTC rate using BigInt half-up (`sats * usd_scaled_8 / 10^14`).
- **Inputs:** Non-negative integer `sats` and rate string.
- **Returns / side effects:** Integer cents. Throws on bad sats/rate or if rounded cents exceed `Number.MAX_SAFE_INTEGER`. No I/O.
- **Used by:** `buildGiftStats`.

## Function: usdCentsToString

- **Purpose:** Format non-negative integer cents as a two-decimal dollar string.
- **Inputs:** `cents` number (non-negative integer).
- **Returns / side effects:** e.g. `"1234.56"`. Throws on invalid cents. No I/O.
- **Used by:** `buildGiftStats`.

## Function: usdCentsToFiatCents

- **Purpose:** Convert USD cents to quote cents (CHF/EUR/PHP) at a quote-per-USD rate using BigInt half-up (`usdCents * rate_scaled_8 / 10^8`).
- **Inputs:** Non-negative integer `usdCents` and quote-per-USD decimal string (same grammar as `parseUsdPerBtc`).
- **Returns / side effects:** Integer quote cents. Throws on bad cents/rate or if rounded cents exceed `Number.MAX_SAFE_INTEGER`. No I/O.
- **Used by:** `buildGiftStats`, `buildGiftDay`.

## Function: resolveCandlesUrl

- **Purpose:** Resolve the Coinbase (or override) candles HTTP URL from env.
- **Inputs:** `NodeJS.ProcessEnv` (`BTC_USD_CANDLES_URL`).
- **Returns / side effects:** Trimmed override or `DEFAULT_BTC_USD_CANDLES_URL` when unset/blank. No I/O.
- **Used by:** `openBootStores`.

## Function: resolveFrankfurterUrl

- **Purpose:** Resolve the Frankfurter ECB (or override) USD→CHF/EUR/PHP rates HTTP URL from env.
- **Inputs:** `NodeJS.ProcessEnv` (`FRANKFURTER_RATES_URL`).
- **Returns / side effects:** Trimmed override or `DEFAULT_FRANKFURTER_RATES_URL` when unset/blank. No I/O.
- **Used by:** `openBootStores`.

## Function: parseCoinbaseCandles

- **Purpose:** Parse Coinbase candles JSON (`[time, low, high, open, close, volume]`) into `{ day, usdPerBtc }` rows.
- **Inputs:** Parsed JSON body (must be an array).
- **Returns / side effects:** Close rows; skips bad shape / non-positive close. Throws if body is not an array. No I/O.
- **Used by:** `fetchDailyCloses`.

## Function: parseFrankfurterRates

- **Purpose:** Parse Frankfurter ECB rates JSON (`{ date, base, quote, rate }`) into `{ day, quote, rate }` USD-cross candles.
- **Inputs:** Parsed JSON body (must be an array).
- **Returns / side effects:** Candle rows; skips non-objects, invalid `date`, non-USD `base`, quotes other than CHF/EUR/PHP, or non-positive `rate`. Throws if body is not an array. No I/O.
- **Used by:** `fetchFiatRates`.

## Function: fetchDailyCloses

- **Purpose:** HTTP GET daily BTC-USD closes for an inclusive UTC day range (chunks of 300 days, `User-Agent: 21.gifts-api`, AbortSignal timeout).
- **Inputs:** `{ fetchImpl, url, fromDay, toDay, timeoutMs? }` (`timeoutMs` default 8000).
- **Returns / side effects:** `CandleClose[]`. Throws on invalid range, non-OK HTTP, or invalid JSON.
- **Used by:** `PostgresBtcUsdStore.ensureDays`.

## Function: fetchFiatRates

- **Purpose:** HTTP GET daily USD→CHF/EUR/PHP ECB rates for an inclusive UTC day range (chunks of 300 days, query `base=usd` and `quotes=chf,eur,php`, `User-Agent: 21.gifts-api`, AbortSignal timeout).
- **Inputs:** `{ fetchImpl, url, fromDay, toDay, timeoutMs? }` (`timeoutMs` default 8000).
- **Returns / side effects:** `FiatCandle[]`. Throws on invalid range, non-OK HTTP, or invalid JSON. Weekend publication days may be omitted by ECB.
- **Used by:** `PostgresFiatStore.ensureDays`.

## Function: migrateBtcUsdSchema

- **Purpose:** Applies `BTC_USD_DAILY_SCHEMA_SQL` (`CREATE TABLE IF NOT EXISTS btc_usd_daily`).
- **Inputs:** `SqlClient`.
- **Returns / side effects:** Void; idempotent DDL execute.
- **Used by:** `openBootStores` when SQL opens.

## Function: migrateFiatSchema

- **Purpose:** Applies `USD_FIAT_DAILY_SCHEMA_SQL` (`CREATE TABLE IF NOT EXISTS usd_fiat_daily`).
- **Inputs:** `SqlClient`.
- **Returns / side effects:** Void; idempotent DDL execute matching `docs/schema/usd_fiat_daily.sql`.
- **Used by:** `openBootStores` when SQL opens, after `migrateBtcUsdSchema` and before `migrateDbChangeSchema`.

## Function: migrateMessageSchema

- **Purpose:** Applies `MESSAGE_SCHEMA_SQL` in order (`CREATE TABLE IF NOT EXISTS message` with nullable `photo`/`photo_content_type`, newest-first index, additive `ALTER … ADD COLUMN IF NOT EXISTS` for existing databases including `video_content_type` (MIME in Postgres; video bytes on disk under `MEDIA_DIR`, not bytea), `parent_id uuid REFERENCES message (id)`, `author_pubkey text`, then `ALTER TABLE message ALTER COLUMN account_id DROP NOT NULL` and `CREATE INDEX IF NOT EXISTS message_parent_id_idx ON message (parent_id, created_at ASC, id ASC)`, then `message_invoice` and `nostr_zap_ingest` without FKs plus `ALTER TABLE message_invoice ADD COLUMN IF NOT EXISTS lnurl_response jsonb`, `conversation_id uuid`, `conversation_message_id uuid` and their `created_at`/`message_id` and `receipt_id` indexes). After `message` exists, adds `account_profile_message_id_fkey` (`ON DELETE SET NULL`) and unique partial index `account_profile_message_uidx`, then soft-hide columns `deleted_at timestamptz` and `deleted_by uuid`. Then additive `content_fp text`, photo-only backfill via `digest(photo, 'sha256')` (`video_content_type` IS NULL), salt of extra live duplicates (`content_fp || ':' || message.id`), and partial unique indexes `message_live_top_content_fp_uidx` / `message_live_reply_content_fp_uidx` (live rows with non-null account + fingerprint). The partial index `message_nostr_event_unrepaired_idx` supports the boot repair's predicate so a converged table can be confirmed without a sequential scan. On every boot, the array also runs an idempotent repair unwrapping `nostr_event` values stored as jsonb string scalars (`jsonb_typeof(nostr_event) = 'string'`), which matches no rows once complete. It is skipped while the `db_change` audit trigger is not attached and retried on the next boot; a row whose value cannot be parsed is skipped with a warning instead of failing the migration. Successfully repaired rows have `nostr_attempts` cleared for a fresh repair budget. The unwrap `DO $unwrap$` block remains last in `MESSAGE_SCHEMA_SQL` only (not mirrored in `docs/schema/message.sql`).
- **Payment claims table:** Also creates `nostr_zap_payment` (`payment_hash` primary key, `receipt_event_id`, `created_at`) without a foreign key to `message`; it is the durable tombstone that dedupes zap credits by payment hash. Like every public table it is attached to the `db_change` row trigger by `migrateDbChangeSchema`, which boots after this migration.
- **Inputs:** `SqlClient`.
- **Returns / side effects:** Void; idempotent SQL execute; `docs/schema/message.sql` mirrors the DDL and documents the boot repair statement by comment (the `DO $unwrap$` block lives only in `MESSAGE_SCHEMA_SQL`).
- **Used by:** `openBootStores` when SQL opens.

## Function: migrateContactSchema

- **Purpose:** Applies `CONTACT_SCHEMA_SQL` in order (`CREATE TABLE IF NOT EXISTS contact` plus the newest-first index).
- **Inputs:** `SqlClient`.
- **Returns / side effects:** Void; idempotent DDL execute matching `docs/schema/contact.sql`.
- **Used by:** `openBootStores` when SQL opens.

## Function: migrateConversationSchema

- **Purpose:** Applies `CONVERSATION_SCHEMA_SQL` in order (`conversation` + `conversation_message` + `conversation_read` tables and unique indexes, including `conversation_read_conversation_id_idx`). CREATE CHECK includes `moderator_group`; ALTER DROP/ADD `conversation_kind_check`; unique partial index `conversation_moderator_group_uidx`. Additive `ALTER TABLE conversation_message ADD COLUMN IF NOT EXISTS sats bigint NOT NULL DEFAULT 0`. Unwrap `DO` block still last. The partial index `conversation_message_nostr_event_unrepaired_idx` supports the boot repair's predicate so a converged table can be confirmed without a sequential scan. On every boot, the array runs an idempotent repair unwrapping `conversation_message.nostr_event` values stored as jsonb string scalars (`jsonb_typeof(nostr_event) = 'string'`); it matches no rows once complete. The repair is skipped while the `db_change` audit trigger is not attached and retried on the next boot; a row whose value cannot be parsed is skipped with a warning instead of failing the migration. `db_change` attach runs later and covers the new public tables.
- **Inputs:** `SqlClient`.
- **Returns / side effects:** Void; idempotent SQL execute; `docs/schema/conversation.sql` mirrors the DDL and documents the boot repair statement by comment (the `DO $unwrap$` block lives only in `CONVERSATION_SCHEMA_SQL`).
- **Used by:** `openBootStores` when SQL opens, after `migrateContactSchema` and before `migrateDbChangeSchema`.

## Function: migratePushSchema

- **Purpose:** Applies `PUSH_SCHEMA_SQL` in order (`CREATE TABLE IF NOT EXISTS` for `push_subscription` and `push_outbox` with `delivered_endpoints` and `type` CHECK `('forum', 'zap', 'conversation')`, supporting indexes, `ALTER TABLE … ADD COLUMN IF NOT EXISTS delivered_endpoints`, then an idempotent `DO` that drops/adds `push_outbox_type_check` so live two-value CHECKs accept `'conversation'`).
- **Inputs:** `SqlClient` already opened by boot.
- **Returns / side effects:** Void; idempotent DDL matching `docs/schema/push.sql`. Does not attach `db_change` triggers (that runs later via `migrateDbChangeSchema`).
- **Used by:** `openBootStores` when SQL opens, after `migrateConversationSchema` and before `migrateDbChangeSchema`.

## Function: migrateNotificationSchema

- **Purpose:** Applies `NOTIFICATION_SCHEMA_SQL` in order (`CREATE TABLE IF NOT EXISTS notification` with recipient/actor FKs, unique `(recipient_account_id, type, reply_id)`, and newest-first recipient index).
- **Inputs:** `SqlClient` already opened by boot.
- **Returns / side effects:** Void; idempotent DDL matching `docs/schema/notification.sql`. Does not attach `db_change` triggers (that runs later via `migrateDbChangeSchema`).
- **Used by:** `openBootStores` when SQL opens, after `migratePushSchema` and before `migrateDbChangeSchema`.

## Function: migrateDbChangeSchema

- **Purpose:** Applies `DB_CHANGE_SCHEMA_SQL` in order so durable Postgres row changes are append-logged in `db_change` via AFTER INSERT/UPDATE/DELETE triggers (not from application store methods). On UPDATE, every bytea column (found via `pg_attribute` on `TG_RELID`) whose value is unchanged and was not hashed by `db_change_redact` is stored in both `before` and `after` as an object with `unchanged` true, `sha256` as the hex digest of the column text, and `bytes` as the `octet_length` of that text; INSERT, DELETE and the UPDATE that changes the bytes keep the full value, so any row state is reconstructable by chaining to the latest earlier full image; secret columns keep their sha256 hash; the no-op comparison still happens on the raw images before redaction.
- **Inputs:** `SqlClient`.
- **Returns / side effects:** Void; idempotent SQL matching `docs/schema/db_change.sql` (pgcrypto, table, redact/log/immutable functions, triggers, attach loop). The immutability-guard `DO` drops the append-only trigger once, hashes `view_key` values that still match a live `account.view_key`, leaves non-matches unchanged, then recreates the trigger.
- **Used by:** `openBootStores` when SQL opens, immediately after `migrateTrustSchema` (notification → trust → `db_change`).

## Function: DB_CHANGE_SCHEMA_SQL

- **Purpose:** Ordered idempotent SQL that creates the append-only `db_change` log, secret-redacting helpers, immutability guard (including a one-time live `view_key` rewrite in that same `DO`), and per-table `trg_db_change` triggers on every public table except `db_change`. On UPDATE, every bytea column (found via `pg_attribute` on `TG_RELID`) whose value is unchanged and was not hashed by `db_change_redact` is stored in both `before` and `after` as an object with `unchanged` true, `sha256` as the hex digest of the column text, and `bytes` as the `octet_length` of that text; INSERT, DELETE and the UPDATE that changes the bytes keep the full value, so any row state is reconstructable by chaining to the latest earlier full image; secret columns keep their sha256 hash; the no-op comparison still happens on the raw images before redaction.
- **Inputs:** None (readonly string array constant).
- **Returns / side effects:** Statement texts only; executed by `migrateDbChangeSchema`. Secrets `token`, `challenge`, `nostr_nsec_ciphertext`, `nonce`, `view_key`, `endpoint`, `p256dh`, `auth`, and `delivered_endpoints` become SHA-256 hex in logged JSON; other columns including `name` stay plaintext except unchanged bytea columns on UPDATE. The guard `DO` hashes JSON `view_key` that still equals a live `account.view_key` and leaves other rows unchanged.
- **Used by:** `migrateDbChangeSchema`; documented mirror in `docs/schema/db_change.sql`.

## Function: InMemoryBtcUsdStore

- **Purpose:** In-memory `BtcUsdRateBook` seeded at construction; never HTTP.
- **Inputs:** Optional `ReadonlyMap` or `Record` of day → rate. `ensureDays(days, nowMs)` returns the seed subset for valid requested days.
- **Returns / side effects:** Map of available rates; missing days omitted. No network.
- **Used by:** `createApp` / `giftsStatsRoutes` defaults; memory `openBootStores`.

## Function: InMemoryFiatStore

- **Purpose:** In-memory `FiatRateBook` seeded at construction; never HTTP.
- **Inputs:** Optional `ReadonlyMap` or `Record` of UTC day → `{ CHF?, EUR?, PHP? }`. `ensureDays(days, nowMs)` returns the seed subset for valid requested days.
- **Returns / side effects:** Map of available crosses; missing days and empty crosses omitted. No network.
- **Used by:** `createApp` / `giftsRoutes` / `giftsStatsRoutes` defaults; memory `openBootStores`.

## Function: PostgresBtcUsdStore

- **Purpose:** Durable `BtcUsdRateBook` over Postgres: SELECT requested days; fetch+upsert gaps, stale UTC-today (`fetched_at` older than 1h), and after-midnight finalize of an intraday print; skip candle days not requested; still-missing omitted (no throw).
- **Inputs:** Constructor `{ sql, fetchImpl, candlesUrl, source? }`. `ensureDays(days, nowMs)`.
- **Returns / side effects:** Day → rate map; still-missing days omitted (no throw). Writes `btc_usd_daily`.
- **Used by:** `openBootStores` when SQL opens.

## Function: PostgresFiatStore

- **Purpose:** Durable `FiatRateBook` over Postgres: SELECT requested days; fetch+upsert gaps, stale UTC-today (`fetched_at` older than 1h), and after-midnight finalize of an intraday print from Frankfurter ECB; carry last business-day quote onto closed days (up to 10-day lookback); still-missing quotes omitted (no throw — callers never 503 on fiat).
- **Inputs:** Constructor `{ sql, fetchImpl, ratesUrl, source? }`. `ensureDays(days, nowMs)`.
- **Returns / side effects:** Day → USD-cross map; still-missing quotes omitted (no throw). Writes `usd_fiat_daily`.
- **Used by:** `openBootStores` when SQL opens.

## Function: PostgresMessageStore

- **Purpose:** Durable `MessageStore` over Postgres (`message` table plus `message_invoice` and `nostr_zap_ingest`). `deleteById` removes zap receipts, invoices, child replies, and the row in **one** parameterised data-modifying CTE `query`, then unlinks on-disk videos from the returned rows. `markDeleted` soft-hides via a single UPDATE CTE (`deleted_at` / `deleted_by` on the untagged target and untagged direct replies; never `DELETE FROM message`). `markUndeleted` unhides via a single UPDATE CTE (clears `deleted_at` / `deleted_by` on the hidden target and stamp-matched direct replies; already-live target is a no-op for children; never `DELETE FROM message`). Live-only lists/claims require `deleted_at IS NULL`: `listLatest` is **top-level only** (`WHERE parent_id IS NULL AND deleted_at IS NULL`) with subquery `replyCount` (live attributed direct children, `(child.account_id IS NOT NULL OR child.author_pubkey IS NOT NULL)`), selecting Nostr columns plus `(photo IS NOT NULL) AS has_photo`, `deleted_at`, `deleted_by`, and never the `photo` bytea column (HTTP window newest-first; product UX is a messenger group — clients reverse); `listReplies` is oldest-first live attributed children (`WHERE parent_id = $1 AND deleted_at IS NULL AND (account_id IS NOT NULL OR author_pubkey IS NOT NULL)`); `listDebug` is operator newest-first **all** rows (`SELECT … FROM message ORDER BY created_at DESC, id DESC LIMIT $1`, no `deleted_at` / `parent_id` filter; never `photo` bytea); `listHidden` is staff newest-hidden-first **soft-hidden** rows (`SELECT … FROM message WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC LIMIT $1`; never `photo` bytea); `listPublishedEventIds` returns non-null live top-level `event_id`s newest-first for inbound reply REQ; `findLiveByAccountContent` returns the oldest live row for account+parent+`content_fp`; `accountHasLiveTopLevelPost` (`parent_id IS NULL`, exclude profile id, replies do not count); `countByAccount` is one `COUNT(*) FILTER` query of live posts (`parent_id IS NULL`) vs replies (`parent_id IS NOT NULL`) for `account_id = $1` and `deleted_at IS NULL` (uncapped; not derived from a list); `listPostsByAccount` is newest-first live top-level notes for one account (`WHERE parent_id IS NULL AND deleted_at IS NULL AND account_id = $1`, `LIMIT`, subquery `replyCount` of live direct children matching `(child.account_id IS NOT NULL OR child.author_pubkey IS NOT NULL)`); `listRepliesByAccount` is newest-first live replies for one account (`WHERE parent_id IS NOT NULL AND deleted_at IS NULL AND account_id = $1`, `LIMIT`, no `replyCount`); `create(row, photo?, video?, extraPhotos?)` inserts optional photo bytes, optional extra stills into `message_extra_photo` (indices 1..n max 9, ignored when `video` is set, require photo 0 when non-empty), optional `video_content_type` (disk write via `writeForumVideo`; `removeForumVideo` unlink on INSERT failure), and `content_fp` when media is present and `account_id` is not null; `photoCount` is (photo 0 ? 1 : 0) + extras length; a non-null `parent_id` requires a live parent (`deleted_at` null) via `INSERT … SELECT … WHERE EXISTS`; a 0-row insert calls `getById` and returns that row when the id already exists (gift-reply retry after the parent was later deleted), otherwise throws without inserting; on unique violation `23505` it returns the existing row when `getById` matches the inserted id (no video unlink; gift-reply retry), otherwise unlinks the new video and returns the existing live row from `findLiveByAccountContent`; `getPhoto` loads bytes by id; `getExtraPhoto(id, index)` / `listExtraPhotos(id)` load extras from `message_extra_photo`; `getById` / `getByEventId` still return soft-hidden rows; `claimUnsigned`/`claimUnpublished` lease live rows (`deleted_at IS NULL`; `claimed_until <= now` is expired; unsigned requires `pending` + null `event_id`); `listPendingSigned` returns live pending rows whose kind:1 lacks `t=bitcoin` (`created_at ASC, id ASC`); `clearSignedEvent` nulls `event_id` / `nostr_event` / `claimed_until` only while `pending` and `event_id` still matches the listed id and no child reply exists (`NOT EXISTS`); `listSignedMissingPhoto` returns published **top-level** live rows (`parent_id IS NULL`, `deleted_at IS NULL`) with a photo whose kind:1 content lacks `/messages/:id/photo.` plus an image extension (`sats = 0`, `nostr_attempts < MAX_PUBLISH_ATTEMPTS` (5, preventing a row that can never satisfy a repair scan from being reset forever), pending excluded so fan-out is not starved, video rows / `video_content_type` excluded so posters are not treated as missing photos, parents with children skipped via `NOT EXISTS`, `created_at ASC, id ASC`); `listSignedMissingVideo` returns published **top-level** live rows (`parent_id IS NULL`, `deleted_at IS NULL`) with `video_content_type` set whose kind:1 content lacks `/messages/:id/video.` (`sats = 0`, `nostr_attempts < MAX_PUBLISH_ATTEMPTS` (5, preventing a row that can never satisfy a repair scan from being reset forever), pending excluded, parents with children skipped via `NOT EXISTS`, `created_at ASC, id ASC`); `listSignedMissingHashtags` returns published unpaid **top-level** live rows (`parent_id IS NULL`, `deleted_at IS NULL`, parents with children skipped via `NOT EXISTS`) whose kind:1 content lacks a `#bitcoin` or `#21gifts` token (next character must not be `[A-Za-z0-9_]`; `sats = 0`, `nostr_attempts < MAX_PUBLISH_ATTEMPTS` (5, preventing a row that can never satisfy a repair scan from being reset forever), pending excluded so fan-out is not starved, includes null / non-string content, `created_at ASC, id ASC`; optional extras map lists rows whose kind:1 also lacks that account's location token; one-arg still bitcoin/21gifts only; optional `excludeIds` applied before the limit so profile notes cannot fill the batch); `resetSignedEvent` nulls `event_id` / `nostr_event` / `claimed_until`, parks `pending`, clears the epoch, increments `nostr_attempts`, and stamps `nostr_first_attempt_at` once, only when `event_id` still matches, `sats` is 0, and no child reply exists (`NOT EXISTS`); `updateSignedEvent` (false on `event_id` collision); `updatePublishState`; `addSats`; `recordZapReceipt` (one statement: `INSERT nostr_zap_receipt ON CONFLICT DO NOTHING` plus `UPDATE message.sats`); `recordInvoiceAttempt` / `listInvoiceAttempts` (each attempt includes `lnurlResponse`: raw LNURL callback JSON object or null); `findOkInvoiceByPaymentHash` / `findOkInvoiceByPr` (newest `result = 'ok'` row, `ORDER BY created_at DESC, id DESC LIMIT 1`); `listOpenConversationZapEventIds` (returns `{ eventId, conversationMessageId }[]`; SQL requires non-null `conversation_id` and `conversation_message_id` and `NOT EXISTS` on `conversation_message`, then keeps one row per event id; unique-violation 23505 is `code` or `errno`); `updateZapReceiptGift` (`UPDATE nostr_zap_receipt` payer / gift-reply / `comment` columns; omitted patch fields are left unchanged; missing event id is a no-op); `getZapReceiptGift` (one receipt by `event_id`); `listZapReceiptsAwaitingGiftReply` (`(payer_account_id IS NOT NULL OR payer_pubkey IS NOT NULL) AND gift_reply_id IS NULL`, `ORDER BY event_id ASC`, includes `comment`); `recordZapIngest` / `listZapIngests`; `listInvoiceAttemptsForPayer` (uncapped `WHERE payer_account_id = $1`, newest-first); `listIndexedZapIngests` (uncapped `WHERE outcome = 'indexed'`); `updateText` (`UPDATE message SET text = $2 WHERE id = $1 RETURNING …`; sats / photos / event ids unchanged; missing id → no row); `listAuthoredMessages` (`WHERE account_id = $1`, including hidden, no LIMIT). `mapMessageRow` keeps `nostr_publish_state` `skipped` (gift-only replies).
- **External-zapper storage:** `nostr_zap_receipt` adds nullable `payer_pubkey text` and `zap_request_id text`, with partial unique index `nostr_zap_receipt_request_uidx` on `zap_request_id WHERE zap_request_id IS NOT NULL`. `nostr_zapper` stores durable visibility entitlement as `pubkey` (primary key), `receipt_event_id`, and `created_at`; it is independent of receipt queue state and is not cleared by `deleteById`. `nostr_blocked_pubkey` is the staff kill-switch table with `pubkey` (primary key), `blocked_at`, `blocked_by`, and `message_id`.
- **External-zapper methods:** `attributeZapReceipt(receiptEventId, { payerPubkey, zapRequestId, comment })` lowercases and stores the payer pubkey, request id, and comment only when the receipt exists and a `NOT EXISTS` check finds no other receipt with that request id; a concurrent partial-index unique violation is also caught, and either replay path returns `false`. `recordZapper(pubkey, receiptEventId, at)` lowercases and inserts an entitlement with `ON CONFLICT (pubkey) DO NOTHING`; `listZapperPubkeys()` returns every entitled pubkey; `listZappers(limit)` returns entitlement rows by `created_at DESC, pubkey DESC`. `blockPubkey(pubkey, at, byAccountId, messageId)` lowercases and inserts with `ON CONFLICT (pubkey) DO NOTHING`; `unblockPubkeyByMessage(messageId)` deletes block rows with that `message_id` and reports whether any row was deleted; `listBlockedPubkeys()` returns every blocked pubkey; `listBlockedPubkeyRows(limit)` returns block rows by `blocked_at DESC, pubkey DESC`. `markDeletedByExternalPubkey(pubkey, at, byAccountId)` stamps `deleted_at` / `deleted_by` on every row matching `WHERE deleted_at IS NULL AND account_id IS NULL AND lower(author_pubkey) = lower($1)` and returns the updated-row count. `listUnattributedIndexedReceipts(limit)` joins each otherwise-unattributed receipt to its newest indexed `nostr_zap_ingest` frame (`payer_account_id`, `payer_pubkey`, `zap_request_id`, and `gift_reply_id` all null), orders by ingest `created_at DESC, event_id DESC`, and applies the limit.
- **Payment claims:** `claimZapPayment` inserts into `nostr_zap_payment` with `ON CONFLICT (payment_hash) DO NOTHING` and then compares the stored `receipt_event_id`: a new row or the same owner returns `true`, another owner `false`. The table has no foreign key to `message` and is not part of the `deleteById` statement, so the claim outlives the forum row. Insert and lookup failures propagate.
- **Backfill interaction:** The schema backfill clears `nostr_attempts` only for rows whose double-encoded `nostr_event` it successfully unwraps, because that repair removes the root cause and grants a fresh repair budget; successful publishing does not clear the cap.
- **Inputs:** Constructor takes a shared boot `SqlClient` (already migrated).
- **Returns / side effects:** Parameter-bound SQL; maps snake_case rows to `MessageRow` / `ForumPhoto` / invoice and ingest rows. Claim uses `FOR UPDATE SKIP LOCKED`. Errors propagate to the route (503) except invoice/ingest persist failures which are caught by callers.
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: PostgresContactStore

- **Purpose:** Durable `ContactStore` over Postgres (`contact` table). `listLatest` is newest-first with a limit; `create` inserts the row.
- **Inputs:** Constructor takes a shared boot `SqlClient` (already migrated).
- **Returns / side effects:** Parameter-bound SQL; maps snake_case rows to `ContactRow`. Errors propagate to the route (503).
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: PostgresConversationStore

- **Purpose:** Durable `ConversationStore` over Postgres (`conversation` + `conversation_message` + `conversation_read`). Open-or-create per counterpart kind, list visible threads, `hasInboundMessage` (EXISTS matching inbound = `conversationIsInbound`), `hasUnread` (parameter-bound EXISTS over `conversation_message` joined to `conversation_read`: `created_at` strictly greater than `last_read_at`, or no last-read row), `markRead` (`INSERT … ON CONFLICT … DO UPDATE` on `(account_id, conversation_id)`), append messages, claim unsigned/unpublished wraps, unique `event_id`. `openMemberPlatform` updates `account_b` when an existing member→platform thread points at a different platform id. `retargetMemberPlatform` bulk-updates `account_b` on every `member_platform` row whose `account_a` is not the new platform id. `ensureModeratorGroup` opens or inserts the closed `moderator_group` singleton. Unique partial index `conversation_moderator_group_uidx`. `listVisible` binds `$5` moderator flag. `mapMessage` keeps `skipped`.
- **Inputs:** Constructor takes a shared boot `SqlClient` (already migrated). `hasInboundMessage(conversationId, viewerId, staff, platformId)` is parameter-bound EXISTS over `conversation_message`. `listVisible(accountId, staff, platformId, limit, moderator = false)` passes `$5` as the moderator flag. `getModeratorGroup` selects `kind = 'moderator_group'`. `unreadCount` forwards the optional 4th `moderator` flag to `listVisible` and pins an existing `moderator_group` first.
- **Returns / side effects:** Parameter-bound SQL; maps snake_case rows to `ConversationThread` / `ConversationMessageRow`. Unique violations on open/append are swallowed as idempotent. Errors otherwise propagate to the route (503). `mapMessage` keeps `nostr_publish_state` `skipped` (does not remap to `pending`).
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: fillRatesForGiftRange

- **Purpose:** Boot helper: `SELECT min/max(paid_at)` for outbound gifts, then `ensureDays` for every UTC day from min through max.
- **Inputs:** `SqlClient`, `BtcUsdRateBook`, `nowMs`.
- **Returns / side effects:** Void. No-op when no outbound gifts. Does not catch — boot logs failures.
- **Used by:** `openBootStores`.

## Function: fillFiatRatesForGiftRange

- **Purpose:** Boot helper: `SELECT min/max(paid_at)` for outbound gifts, then fiat `ensureDays` for every UTC day from min through max.
- **Inputs:** `SqlClient`, `FiatRateBook`, `nowMs`.
- **Returns / side effects:** Void. No-op when no outbound gifts. Does not catch — boot logs failures.
- **Used by:** `openBootStores`.

## Function: InMemoryAuthStore

- **Purpose:** Process-local AuthStore: passkey challenges/credentials, accounts, sessions, verifications, and custodial Nostr keys (`getNostrPublicKey` / `getNostrSecret` / `setNostrKeyIfAbsent` / `listAccountIdsWithoutNostrKey`). Evicts expired challenges/sessions on write. Indexes `linkingKey` only when non-null. Maintains an O(1) `viewKey` index; `getAccountByViewKey` looks it up. `getAccountByLightningAddress` scans for a `lower(trim)` match and skips null addresses. `getAccountByPubkey` scans `#nostrKeys` for a case-insensitive hex match (`trim`; empty → `undefined`). `updateAccountNameByLightningAddress` mutates only `name` on the matched account (`lower(trim)`); other fields stay unchanged; unknown address → `undefined`. `accountHasPasskey` is true when any credential maps to the account id. `createAccount` is a no-op when `viewKey` is already stored, a non-null `linkingKey` already exists, or `lightningAddress` (`lower(trim)`) belongs to another id. `updateAccount` reindexes `viewKey` when it changes and refuses a `viewKey`, non-null `linkingKey`, or `lightningAddress` owned by another id. `claimProfileMessageId(accountId, expectedId, nextId)` sets only `profileMessageId` when `(stored ?? null) === (expectedId ?? null)` (`undefined` and `null` both match `expectedId === null`); does not touch viewKey/linkingKey indexes; returns true on win, false on unknown id or mismatch. `createAccount` / `updateAccount` with `isPlatform: true` call `#clearPlatformExcept` so every other account's `isPlatform` is false (at most one platform account). `deleteAccount` drops the row and its linking-key and viewKey indexes. `listAccounts` returns every account oldest-first.
- **Inputs:** Constructor none. Methods take domain objects (`PasskeyChallenge`, `PasskeyCredential`, `Account`, `Session`, `AddressVerification`). `createAccount` is a no-op when a non-null `linkingKey` already exists, when `viewKey` is already stored, or when `lightningAddress` (`lower(trim)`) is taken. `updateAccount` refuses a `linkingKey` / `viewKey` / `lightningAddress` owned by another account and keeps the viewKey index consistent. `claimProfileMessageId(accountId, expectedId, nextId)` sets only `profileMessageId` when `(stored ?? null) === (expectedId ?? null)` (`undefined` and `null` both match `expectedId === null`); does not touch viewKey/linkingKey indexes; returns true on win, false on unknown id or mismatch. `updateAccountNameByLightningAddress(lightningAddress, name)` takes the address and new display name. `deleteAccount` drops the row and its linking-key and viewKey indexes. `createPasskeyCredential` returns false when this account already has a credential or the id is taken. `createFirstPasskeyCredential` returns false when this account already has a credential or the id is taken. `updatePasskeyCredential` returns false unless `(newCount === 0 && stored === 0)` or `newCount > stored`; missing id is false; does not rebind `accountId` / `publicKey`. `updatePasskeyChallenge` returns false when the row is missing or already consumed.
- **Returns / side effects:** Lookups return the object or `undefined`. Writes resolve when persisted. `listAccounts` returns `Account[]`.
- **Used by:** `createApp` default store; all auth/me/debug/view routes.

## Function: PostgresAuthStore

- **Purpose:** Durable AuthStore over Postgres (`SqlClient`). Same eviction-on-write semantics as the in-memory adapter, including passkey challenges, credentials, custodial Nostr key columns, and the `view_key` column. `getAccountByViewKey` is `WHERE view_key = $1`. `getAccountByLightningAddress` is `WHERE lower(trim(lightning_address)) = lower(trim($1))` (null addresses do not match). `getAccountByPubkey` is `WHERE lower(nostr_pubkey) = lower(trim($1))`. `updateAccountNameByLightningAddress` is `UPDATE account SET name = $2 WHERE lower(trim(lightning_address)) = lower(trim($1)) RETURNING …` (other columns unchanged; empty `RETURNING` → `undefined`). `accountHasPasskey` is `SELECT 1 FROM passkey_credential WHERE account_id = $1 LIMIT 1`. `mapAccount` skips null `view_key` (`getAccount` / `getAccountByViewKey` / `getAccountByLightningAddress` / `getAccountByPubkey` / `updateAccountNameByLightningAddress` return undefined; `listAccounts` omits those rows) and sets `isPlatform` true only when `is_platform` is true. Passkey `signCount` advances with an atomic `WHERE` (`0/0` or `new > stored`) `RETURNING`, not `GREATEST`; duplicate credential ids are `ON CONFLICT DO NOTHING`. `createPasskeyCredential` also returns false on unique_violation `23505` for `passkey_credential_account_uidx` (one credential per account). `createFirstPasskeyCredential` inserts only when the account has no credential (`WHERE NOT EXISTS` plus unique `account_id`); unique_violation is false. `createAccount` INSERT unique_violation `23505` is a no-op. `updateAccount` refuses a `linkingKey` owned by another id (`UPDATE` matches no row; unique_violation `23505` is a no-op). `claimProfileMessageId` is `UPDATE account SET profile_message_id = $3 WHERE id = $1 AND profile_message_id IS NOT DISTINCT FROM $2 RETURNING id` via `query` (not `execute`); true iff a row is returned. `updateAccount` stays an unconditional full-row write. Before `createAccount` / `updateAccount` when `isPlatform === true`, `UPDATE account SET is_platform = false WHERE is_platform AND id <> $1` so at most one platform account remains (partial unique `account_is_platform_uidx`). INSERT/UPDATE write `is_platform`. `deleteAccount` is `DELETE FROM account WHERE id = $1`. Unique index on `lower(trim(lightning_address))` where the address is not null.
- **Inputs:** Constructor takes a `SqlClient`. Methods match `AuthStore` including `getAccountByViewKey`, `getAccountByLightningAddress`, `getAccountByPubkey`, `updateAccountNameByLightningAddress`, `accountHasPasskey`, and `claimProfileMessageId`. `claimProfileMessageId` is `UPDATE account SET profile_message_id = $3 WHERE id = $1 AND profile_message_id IS NOT DISTINCT FROM $2 RETURNING id` via `query` (not `execute`); true iff a row is returned. `updateAccount` stays an unconditional full-row write.
- **Returns / side effects:** Parameter-bound SQL; maps snake_case rows to domain objects.
- **Used by:** `openAuthStore` when `DATABASE_URL` is set.

## Function: isUniqueViolation

- **Purpose:** True when `sqlState(error)` returns the Postgres unique-violation SQLSTATE `23505`, including Bun SQL `errno === '23505'` and node-postgres `code === '23505'`; a matching valid `errno` takes precedence over `code`. `{ code: 'ERR_POSTGRES_SERVER_ERROR' }` with no `errno` is false.
- **Inputs:** `error: unknown`.
- **Returns / side effects:** `boolean`. No I/O. Non-objects are false.
- **Used by:** `PostgresAuthStore`, `PostgresMessageStore`, `PostgresConversationStore`, `PostgresNotificationStore`, `PostgresTrustStore`.

## Function: sqlState

- **Purpose:** Read a five-character SQLSTATE from a caught driver error, preferring a string Bun SQL `errno` matching `/^[0-9A-Z]{5}$/`, then a string node-postgres `code` matching the same pattern.
- **Inputs:** `error: unknown`.
- **Returns / side effects:** The matching SQLSTATE string, otherwise `null`. A numeric `errno` (including negative Node system-error numbers) is ignored, and non-objects return `null`. No I/O.
- **Used by:** `isUniqueViolation` and `isInvalidUuid` in `src/routes/trust-chain.ts`.

## Function: migrateAuthSchema

- **Purpose:** Applies `AUTH_SCHEMA_SQL` in order (`CREATE TABLE IF NOT EXISTS` plus `ALTER` backfills for existing databases).
- **Inputs:** `SqlClient`.
- **Returns / side effects:** Void; creates `account`, `auth_session`, `address_verification`, `passkey_challenge`, `passkey_credential`; drops leftover `auth_challenge`; backfills `account.name` / nullable `linking_key`; adds `nostr_pubkey` / nsec ciphertext / kek id / custody plus unique index and CHECK; adds `view_key` ALTER, uuid-concat backfill, and unique index; adds nullable `rules_agreed_at`; unique index `account_lightning_address_uidx` on `lower(trim(lightning_address))` where not null; unique index `passkey_credential_account_uidx` on `account_id`; adds `is_platform boolean NOT NULL DEFAULT false` and unique index `account_is_platform_uidx` on `(is_platform) WHERE is_platform`; adds nullable `name_skipped_at`, `lightning_address_skipped_at`, and `profile_message_id uuid` (**no** FK to `message` here — message migrates later); adds nullable `location text` (no unique index, same as `name`); adds `notification_level text NOT NULL DEFAULT 'all'` plus `DROP`/`ADD` `account_notification_level_chk` (`all` / `active` / `mentions`).
- **Used by:** `openAuthStore`.

## Function: openAuthStore

- **Purpose:** Chooses in-memory vs Postgres AuthStore from `DATABASE_URL`.
- **Inputs:** URL or blank/undefined; `createClient` factory required when the URL is set (boot supplies Bun SQL; tests inject a mock).
- **Returns / side effects:** `InMemoryAuthStore` if unset; otherwise migrate then `PostgresAuthStore`. Throws if the URL is set without a factory.
- **Used by:** `openBootStores`.

## Function: openBootStores

- **Purpose:** Shared `DATABASE_URL` wiring: one `SqlClient` for durable auth, FX tables, `QueryGiftStore`, `SqlGiftRecorder`, `PostgresBtcUsdStore`, `PostgresFiatStore`, `migrateMessageSchema`, `PostgresMessageStore`, `migrateContactSchema`, `PostgresContactStore`, `migrateConversationSchema`, `PostgresConversationStore`, `migratePushSchema`, `PostgresPushStore`, `migrateNotificationSchema`, `PostgresNotificationStore`, `migrateTrustSchema`, `PostgresTrustStore`, `migrateDbChangeSchema`, and parsed `NOSTR_NSEC_KEK`; or in-memory auth, `giftStore`/`giftRecorder`/`messageStore`/`contactStore`/`conversationStore`/`notificationStore`/`pushStore`/`trustStore` undefined, `nostrKek` undefined, empty `InMemoryBtcUsdStore`, and empty `InMemoryFiatStore` when unset.
- **Inputs:** `databaseUrl`; optional `createClient` (required when URL set); optional `fx: { fetchImpl, candlesUrl, frankfurterUrl, now }` so tests avoid the network (`candlesUrl` defaults via `resolveCandlesUrl(process.env)`; `frankfurterUrl` defaults via `resolveFrankfurterUrl(process.env)`). SQL path reads `process.env.NOSTR_NSEC_KEK`.
- **Returns / side effects:** `{ authStore, giftStore, giftRecorder, btcUsdRates, fiatRates, messageStore, contactStore, conversationStore, notificationStore, pushStore, trustStore, nostrKek }`. Migrates `btc_usd_daily` then `usd_fiat_daily`, `message`, `contact`, `conversation` (via `migrateConversationSchema`), `push_subscription`/`push_outbox` (via `migratePushSchema`), `notification` (via `migrateNotificationSchema` after push before `db_change`), then `trust_edge` (via `migrateTrustSchema`) after notification and before `migrateDbChangeSchema` so `trg_db_change` attaches to `trust_edge`, then `db_change` after auth migrate; best-effort `fillRatesForGiftRange` logs `gifts.fx.boot_fill.failed` and does not throw; best-effort `fillFiatRatesForGiftRange` logs `gifts.fx.fiat_boot_fill.failed` and does not throw. Throws if the URL is set without a factory, or if the SQL path has a missing/malformed KEK. SQL path returns `SqlGiftRecorder`, `PostgresMessageStore`, `PostgresContactStore`, `PostgresConversationStore`, `PostgresNotificationStore`, `PostgresPushStore`, `PostgresFiatStore`, and `PostgresTrustStore`; memory path returns `giftRecorder`/`messageStore`/`contactStore`/`conversationStore`/`notificationStore`/`pushStore`/`trustStore`/`nostrKek` undefined and skips migrates including `migrateConversationSchema` / `migratePushSchema` / `migrateNotificationSchema` / `migrateTrustSchema` / `migrateDbChangeSchema`.
- **Payment-claim backfill:** Only after `migrateDbChangeSchema` has attached `trg_db_change` to every public table (so the backfill's `nostr_zap_payment` inserts are logged), constructs `PostgresMessageStore` and runs `backfillZapPayments` before constructing the remaining Postgres stores and returning. In-memory boots never call the backfill.
- **Used by:** `src/index.ts` boot.

## Function: bearerMatchesDebugToken

- **Purpose:** Constant-time compare of `DEBUG_TOKEN` against `Authorization: Bearer`.
- **Inputs:** Configured token (non-empty) and raw header or `undefined`.
- **Returns / side effects:** `true` only on an exact Bearer match (trim on the presented token).
- **Used by:** `debugRoutes`, `debugContactsRoutes`, `debugMessagesRoutes`, `debugPaymentsRoutes`, `debugPushRoutes`.

## Function: compareAccountsForList

- **Purpose:** Sort key for `listAccounts`: older `createdAt` first, then `id` ascending.
- **Inputs:** Two `Account` values.
- **Returns / side effects:** Negative / positive / 0.
- **Used by:** `InMemoryAuthStore.listAccounts`.

## Function: debugRoutes

- **Purpose:** Operator listing, provisioning, role assignment, Lightning Address unlink, official platform-flag retarget, and minting a member bearer via `POST /:id/session`.
- **Inputs:** `DebugRouteDeps`: store, optional debugToken, required `fetchImpl` (NIP-57 mint probe on new POST addresses), optional `conversationStore` (`PATCH platform: true` calls `retargetMemberPlatform`), optional `messageStore`, `pushStore`, and `notificationStore` (POST provision calls `ensureProfileMessage` when `messageStore` is set), optional `now` for minted debug sessions.
- **Returns / side effects:** Hono app (`GET /`, `POST /`, `PATCH /:id`, `POST /:id/session`). Shared 503 if token unset; 401 if bearer mismatches. GET 200 `{ accounts }` via `serializeDebugAccount` (includes `isPlatform`; no `viewKey`) logs `debug.accounts.listed` with count. POST body `{ accounts: [{ name, lightningAddress }] }` → 400 invalid body (including C0/DEL names or non-LUD-16 addresses after the shape check; no row is written); probes **all** new addresses first (`probeNip57Mint`) unless `NIP57_PROBE=0` (Playwright e2e skip; production must not set this); any `not_zap` / `unreachable` is 400 and no new address in that request is saved; name-only updates run only after every probe has passed; 500 `{ error: 'Could not save the account' }` when create does not persist the address, the name-only update matches no row, or the name-only update returns a row whose `name` is not the requested name; creates by Lightning Address, or for an existing address updates **only** `name` via `updateAccountNameByLightningAddress`; when `messageStore` is set, POST then calls `ensureProfileMessage` (optional `pushStore` and `notificationStore`) (keeps `viewKey` / `role` / other columns); returns `{ accounts: [{ name, lightningAddress, viewKey, created }] }`; logs `debug.accounts.provisioned` with created/updated counts (never viewKeys or the token). PATCH body `{ role }` and/or `{ lightningAddress: null }` and/or `{ platform: true|false }` → 400 unknown/missing; 404 missing account; 200 `serializeDebugAccount` of the updated row (includes `isPlatform`; no `viewKey`); unlink also `deleteVerification` and logs `debug.accounts.lightning_address.cleared`; role changes log `debug.accounts.role_set` with account id and role; `platform: true` uniquely retargets (store clears any other `isPlatform`), points every member→platform thread at the new account via `retargetMemberPlatform` when `conversationStore` is set, and logs `debug.accounts.platform_set`. Never logs the token or the previous address.
- **Used by:** `createApp` at `/debug/accounts`.

## Function: debugContactsRoutes

- **Purpose:** Operator listing of private in-app contacts (includes `accountId`).
- **Inputs:** `DebugContactsRouteDeps`: contact store, optional debugToken.
- **Returns / side effects:** Hono app. 503 if token unset; 401 if bearer mismatches; 200 `{ contacts }` newest-first (cap 200); 503 on store throw (`contact.list.failed`). Logs `debug.contacts.listed` with count, never the token.
- **Used by:** `createApp` at `/debug/contacts`.

## Function: debugMessagesRoutes

- **Purpose:** Operator read of every persisted forum row (including soft-hidden notes and replies) plus hidden photo bytes and extra stills (`GET /:id/photo/:file`, indices 1–9; hidden with that extra is 200), restore of a missing forum-video file for an already-existing message with `hasVideo` (raw body under `MEDIA_DIR`; no new message id, no DB create), and unhide of a soft-hidden row (`POST /:id/restore` via `markUndeleted`; 204 empty body; cascade inverse of `markDeleted`; already-live id is still 204). Public hide does not apply to the GETs. Unhide is `DEBUG_TOKEN` only — not a founder/moderator session.
- **Inputs:** `DebugMessagesRouteDeps`: message store, optional debugToken.
- **Returns / side effects:** Hono app exposing `GET /`, `GET /:id`, `GET /:id/photo`, `GET /:id/photo/:file`, `PUT /:id/video`, and `POST /:id/restore`. Shared 503 if token unset/blank; 401 if bearer mismatches. GET `/` 200 `{ messages }` via `listDebug` / `serializeDebugMessage` (cap 200) logs `debug.messages.listed` with count. GET `/:id` 200 debug JSON (hidden is 200) logs `debug.messages.get` with `messageId`; non-UUID or missing 404 `{ error: 'Not found' }`. GET `/:id/photo` 200 image bytes (hidden with a photo is 200; same Content-Type / Content-Disposition / CORS as public photo) logs `debug.messages.photo.get` with `messageId`; missing row / no photo / bad id 404 `{ error: 'Photo not found' }`. GET `/:id/photo/:file` 200 extra still (indices 1–9; hidden with that extra is 200); missing/no extra/non-UUID/bad file 404 `{ error: 'Photo not found' }`. PUT 404 for non-UUID or unknown id; 409 when the row has no video or the decoded MIME extension does not match the stored type; 400 for empty/oversize/unrecognized body; 204 after `writeForumVideo`. POST `/:id/restore` 404 for non-UUID or missing id; 204 empty body after `markUndeleted` (hidden or already live); logs `debug.messages.restored` with `{ messageId }` only (never text, never `deletedBy`). 503 `{ error: 'Messages are unavailable' }` when a store call or `writeForumVideo` throws (`debug.messages.list_failed` / `debug.messages.get_failed` / `debug.messages.photo.get_failed` / `debug.messages.video.put_failed` / `debug.messages.restore_failed`). Logs `debug.messages.video.put` with `messageId` and `bytes`, never the token, nsec, or raw bytes.
- **Used by:** `createApp` at `/debug/messages`.

## Function: debugPaymentsRoutes

- **Purpose:** Operator listing of all `message_invoice` attempts (forum and conversation invoices; `serializeInvoice` omits `conversationId` and `conversationMessageId`), manual forum-invoice settlement, and kind:9735 ingest decisions (`nostr_zap_ingest`).
- **Inputs:** `DebugPaymentsRouteDeps`: message store, auth store, clock, optional push/notification stores, and optional debugToken.
- **Returns / side effects:** Hono app. 503 if token unset; 401 if bearer mismatches; 200 `{ invoices }` on `GET /invoices`, `{ receiptId, messageId, amountSats, resumed }` on `POST /invoices/settle`, and `{ ingests }` on `GET /zap-ingests`. Manual settle accepts `{ paymentHash, note, preimage? }` and delegates to `settleInvoiceManually`; store throws, including the direct ingest write, map to 503. Listing is newest-first (cap 200). Logs list/settle results without token, note, preimage, or nsec.
- **Used by:** `createApp` at `/debug`.

## Function: inspectBolt11

- **Purpose:** Decode BOLT11 payment hash, amount, plaintext description, description_hash, and expiry for operator debug (does not change `decodeBolt11`).
- **Inputs:** BOLT11 string; optional decoder inject for tests.
- **Returns / side effects:** `InspectedBolt11` or `null` when malformed / zero-amount.
- **Used by:** `POST /messages/:id/invoice` for the NIP-57 gate (reject before returning `pr`) and when persisting ok / `not_zap` attempts.

## Function: isNip57Invoice

- **Purpose:** True when `descriptionHash` equals `sha256(utf8(zapRequestJson))`.
- **Inputs:** description hash (or null) and zap request JSON string (or null).
- **Returns / side effects:** boolean.
- **Used by:** `POST /messages/:id/invoice` for the NIP-57 gate (reject before returning `pr`).

## Function: resolveVapidConfig

- **Purpose:** Resolve self-hosted Web Push VAPID credentials from an environment slice without failing boot when keys are missing or unusable.
- **Inputs:** `env` record (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, optional `VAPID_SUBJECT`).
- **Returns / side effects:** `{ publicKey, privateKey, subject }` when both keys decode (URL-safe base64) to 65-byte uncompressed P-256 public and 32-byte private, and `subject` is `https:` or `mailto:` (default `https://21.gifts`). Otherwise `null`. Never logs the private key. `src/index.ts` still try/catches `WebPushSender` construction so a library throw cannot kill listen.
- **Used by:** `createApp` (public key for HTTP), `src/index.ts` (sender + worker gate).

## Function: UnconfiguredPushSender

- **Purpose:** No-op `PushSender` used when VAPID env is missing so the process still boots and HTTP can return 503 without attempting delivery.
- **Inputs:** Constructor none. `send(sub, payload)` ignores arguments.
- **Returns / side effects:** `isConfigured()` is always `false`; `send` resolves `{ ok: false, reason: 'not_configured' }` and never calls `web-push`.
- **Used by:** `src/index.ts` when `resolveVapidConfig` returns `null`.

## Function: webPushTopicFromTag

- **Purpose:** Sanitize a Web Push payload `tag` into an RFC 8030 Topic header value: URL-and-filename-safe Base64 alphabet `A-Za-z0-9_-`, at most 32 characters. Production tags (`forum_post:<uuid>`, `forum_reply:<uuid>`, `zap:<id>`, `moderator_appointed:<subjectId>`) drop the colon so push services accept the request.
- **Inputs:** `tag` string from the JSON payload.
- **Returns / side effects:** Sanitized string, or `undefined` when empty after stripping disallowed characters (omit the Topic header). No I/O. Never logs.
- **Used by:** `WebPushSender.send`.

## Function: WebPushSender

- **Purpose:** VAPID Web Push delivery via the `web-push` package to one browser subscription endpoint.
- **Inputs:** Constructor takes resolved `VapidConfig`. `send(sub, payload)` takes a `PushSubscriptionRecord` and a JSON string body.
- **Returns / side effects:** `isConfigured()` is `true`. Maps HTTP 404/410 to `gone`; other errors `{ ok: false, reason: 'fail', status? }` when HTTP status is numeric; success `{ ok: true }`. Optional RFC 8030 Topic (`A-Za-z0-9_-`, max 32) via `webPushTopicFromTag` from payload `tag`; omit Topic when empty. TTL 86400. `urgency` `high`.
- **Used by:** `src/index.ts` when VAPID resolves; drained by `runPushWorkerTick`.

## Function: InMemoryPushStore

- **Purpose:** Process-local `PushStore` for Web Push subscriptions and the outbox. Default empty so the process boots without a database.
- **Inputs:** Constructor none. Methods match `PushStore` (`upsertSubscription` keeps original `createdAt` on endpoint conflict; `claimPending` leases oldest pending; `markFailed` fails at 8 attempts; `recordDelivered` unions unique endpoint URLs onto the outbox row).
- **Returns / side effects:** Caller-owned copies including `deliveredEndpoints` slices; mutating results does not change the store. No I/O.
- **Used by:** `createApp` default `pushStore`; memory `src/index.ts` when boot omits SQL push.

## Function: InMemoryNotificationStore

- **Purpose:** Process-local `NotificationStore` for in-app forum post, reply, zap, and moderator appointment notifications. Default empty so the process boots without a database.
- **Inputs:** Optional seed `NotificationRow[]` (copied). `create` is unique on `(recipientAccountId, type, replyId)` and returns the existing row on duplicate. `listByRecipient(accountId, limit)` is newest `createdAt` then `id` DESC. `unreadCount` is total unread (`readAt === null`), not page length. `markRead` / `markAllRead` stamp unread rows only.
- **Returns / side effects:** Promise of row copies; mutating results does not change the store. No I/O.
- **Used by:** `createApp` default `notificationStore`; memory `openBootStores` omits it.

## Function: PostgresPushStore

- **Purpose:** Durable `PushStore` over Postgres (`push_subscription`, `push_outbox`). Same port semantics as the in-memory adapter, including claim leases, attempt counting, and `recordDelivered` for successful endpoint URLs.
- **Inputs:** Constructor takes a shared boot `SqlClient` (already migrated via `migratePushSchema`).
- **Returns / side effects:** Parameter-bound SQL; maps snake_case rows to domain objects including `delivered_endpoints` JSON. Errors propagate to callers.
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: PostgresNotificationStore

- **Purpose:** Durable `NotificationStore` over Postgres (`notification`). Same port as the in-memory adapter: unique create, newest-first list, total unread count, get/mark-one/mark-all for the recipient only.
- **Inputs:** Constructor takes a shared boot `SqlClient` (already migrated via `migrateNotificationSchema`).
- **Returns / side effects:** Parameter-bound SQL; maps snake_case rows to `NotificationRow`. Unique violation re-selects the existing row. Errors propagate to the route (503).
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: enqueueForumPushes

- **Purpose:** Enqueue one forum notification per bell subscriber except the skip id (`authorId`). Payload URL is `/notifications`; tag is `forum_post:<messageId>`.
- **Inputs:** `PushStore`, `authorId` (skip id / post actor), `messageId` (forum post id; outbox id and payload tag), `nowMs`. Payload from `buildForumPushPayload(messageId)`.
- **Returns / side effects:** One pending `type: 'forum'` outbox row per other subscriber account. Does not send HTTP push itself.
- **Used by:** Unit tests; production path is `notifyForumPost`.

## Function: enqueueReplyPush

- **Purpose:** Enqueue one reply notification per bell subscriber except the skip id. Payload URL is `/notifications`; tag is `forum_reply:<messageId>` (the reply id, not the parent).
- **Inputs:** `PushStore`, `authorId` (skip id / reply actor), `messageId` (reply row; outbox id and payload tag), `parentId` (unused; kept for call-site compatibility), `nowMs`. Payload from `buildReplyPushPayload(messageId)`.
- **Returns / side effects:** One pending `type: 'forum'` outbox row per other subscriber account. No-op when nobody else is subscribed.
- **Used by:** Unit tests; production path is `notifyForumReply`.

## Function: enqueueZapPush

- **Purpose:** Enqueue one zap notification per bell subscriber except the skip id. `authorId` is the payer skip id, not “notify only this author”. The note author is notified unless they are the skip id.
- **Inputs:** `PushStore`, `authorId` (skip id / payer), `messageId` (tag id; also stored as outbox `messageId`), `nowMs`. Payload from `buildZapPushPayload(messageId)`.
- **Returns / side effects:** One pending `type: 'zap'` outbox row per other subscriber account. No-op when nobody else is subscribed.
- **Used by:** Unit tests; production path is `notifyZap`.

## Function: enqueueDebugPush

- **Purpose:** Enqueue a single operator test notification for one account when it has a subscription.
- **Inputs:** `PushStore`, `accountId`, `nowMs`. Uses a fixed zap-typed debug payload (`tag: 'debug'`).
- **Returns / side effects:** `0` or `1` (rows enqueued). Does not deliver; the push worker drains the outbox.
- **Used by:** `debugPushRoutes` (`POST /debug/push-ping`).

## Function: runPushWorkerTick

- **Purpose:** Claim a batch of pending outbox rows and deliver each payload to every subscription for the recipient account.
- **Inputs:** `PushWorkerDeps` (`store`, `sender`, `now`). Batch size and lease from module constants.
- **Returns / side effects:** No-op when `sender.isConfigured()` is false. Records successful endpoints via `recordDelivered` and does not resend them on retry; deletes gone subscriptions without recording them; logs `push.send.failed` with optional numeric `status` (HTTP status from the sender) and no endpoint/keys/payload, then `markFailed` on fail after recording successes; `markSent` when remaining sends succeed / all gone / no subs left to try.
- **Used by:** `startPushWorker` interval; unit tests.

## Function: startPushWorker

- **Purpose:** Start a periodic `setInterval` that runs `runPushWorkerTick` until stopped.
- **Inputs:** `PushWorkerDeps` and optional `intervalMs` (default `PUSH_WORKER_INTERVAL_MS` = 2s).
- **Returns / side effects:** `{ stop }` clears the interval. Does not throw on tick failures inside the timer callback.
- **Used by:** `src/index.ts` when VAPID resolves.

## Function: parsePushSubscription

- **Purpose:** Validate a browser PushSubscription JSON body into stored endpoint/key fields.
- **Inputs:** Unknown request body expecting `{ endpoint, keys: { p256dh, auth } }`.
- **Returns / side effects:** Parsed fields, or `null` when invalid (blank endpoint, bad url-safe base64 keys, non-https endpoint except localhost http).
- **Used by:** `pushRoutes` `POST /me/push-subscriptions`.

## Function: buildForumPushPayload

- **Purpose:** English forum-post payload for every bell subscriber except the actor (`type: 'forum'`, title `New post on 21.gifts`, url `/notifications`, tag `forum_post:<postId>`). Shared template: omits optional `unreadCount` (fan-out adds notification unread + listed inbox unread per recipient).
- **Inputs:** `postId` string used in `tag`.
- **Returns / side effects:** `PushPayload` object without `unreadCount`; callers `JSON.stringify` before enqueue/send.
- **Used by:** `enqueueForumPushes`, `notifyForumPost`.

## Function: buildReplyPushPayload

- **Purpose:** English forum-reply payload for every bell subscriber except the actor (`type: 'forum'`, title `New reply on 21.gifts`, url `/notifications`, tag `forum_reply:<replyId>`; not the parent id). Shared template: omits optional `unreadCount` (fan-out adds it per recipient).
- **Inputs:** `replyId` string (reply forum message id; `tag` / collapse key).
- **Returns / side effects:** `PushPayload` object without `unreadCount`; callers `JSON.stringify`.
- **Used by:** `enqueueReplyPush`, `notifyForumReply`.

## Function: buildZapPushPayload

- **Purpose:** English zap payload for every bell subscriber except the payer skip id (`type: 'zap'`, title `Bitcoin on 21.gifts`, body `Someone sent sats.`, url `/notifications`, tag `zap:<id>`). Shared template: omits optional `unreadCount` (fan-out adds it per recipient).
- **Inputs:** `messageId` string used only in `tag` (receipt UUID on the `notifyZap` path).
- **Returns / side effects:** `PushPayload` object without `unreadCount`; callers `JSON.stringify` before enqueue/send.
- **Used by:** `enqueueZapPush`, `notifyZap`.

## Function: buildModeratorAppointedPushPayload

- **Purpose:** English payload for the appointed subject only (not a living-room fan-out). `type: 'forum'` (outbox CHECK is forum|zap|conversation), title `You are a moderator`, body `You were appointed a moderator in the living room.`, url `/welcome`, tag `moderator_appointed:<subjectId>`. Shared template omits optional `unreadCount` (`notifyModeratorAppointed` merges notification unread + listed inbox unread when either source is passed).
- **Inputs:** `subjectId` string used in `tag`.
- **Returns / side effects:** `PushPayload` object without `unreadCount`; callers `JSON.stringify`.
- **Used by:** `notifyModeratorAppointed`.

## Function: buildConversationPushPayload

- **Purpose:** English private-message payload for one 21.gifts bell subscriber (`type: 'conversation'`, title sender `name` or `21.gifts` when empty, body message text, url `/messages?c=<conversationId>`, tag `conversation:<conversationId>`). Shared template: omits optional `unreadCount` (`notifyConversationMessage` adds notification unread + listed inbox unread).
- **Inputs:** `{ conversationId, name, text }`.
- **Returns / side effects:** `PushPayload` object without `unreadCount`; callers `JSON.stringify` and merge `unreadCount`.
- **Used by:** `notifyConversationMessage`.

## Function: pushRoutes

- **Purpose:** Member Web Push HTTP: public VAPID key plus subscription upsert/delete for the signed-in account.
- **Inputs:** `PushRouteDeps` (`authStore`, `pushStore`, `now`, optional `vapidPublicKey`).
- **Returns / side effects:** Hono app with full path literals `/push/vapid-public` and `/me/push-subscriptions`. Session 401 before unconfigured 503.
- **Used by:** `createApp` mounted at `/`.

## Function: debugPushRoutes

- **Purpose:** Operator debug ping that enqueues a test Web Push for one account via `DEBUG_TOKEN` (not an end-user session). Body `{ accountId }`. Returns `{ enqueued }` (`0` or `1`).
- **Inputs:** `DebugPushRouteDeps` (`authStore`, `pushStore`, `now`, `debugToken`, `vapidPublicKey`).
- **Returns / side effects:** Hono app `POST /` mounted at `/debug/push-ping`. Debug 503/401 before JSON; then unconfigured 503; unknown account 404. Calls `enqueueDebugPush`.
- **Used by:** `createApp`.

## Function: markDeleted

- **Purpose:** Soft-hide a forum note and every untagged **direct** reply by stamping `deletedAt` / `deletedBy` (Postgres columns `deleted_at` / `deleted_by`). Does not hard-delete rows, media, invoices, zap receipts, or gifts; does not call `deleteById`. An already-tagged target keeps its original stamps; untagged direct replies get this call's `at` / `byAccountId`. Public JSON never exposes the stamps.
- **Inputs:** `id` (message id string), `at` (`Date`, cloned onto newly tagged rows), `byAccountId` (staff account id recorded as `deletedBy`).
- **Returns / side effects:** `Promise<boolean>` — `false` when no row has that id; `true` when the id exists (already tagged or newly tagged). In-memory mutates store rows; Postgres uses one UPDATE CTE (`deleted_at IS NULL` on the target and direct children).
- **Used by:** `messagesRoutes` (`DELETE /messages/:id`).

## Function: markUndeleted

- **Purpose:** Unhide a forum note by clearing `deletedAt` / `deletedBy` (Postgres columns `deleted_at` / `deleted_by`). Inverse of `markDeleted`'s cascade: when the target is hidden, also clears every **direct** child whose stamps match the target's (same instant and same staff) before the target is cleared. Already-live targets are a no-op for children. Does not hard-delete rows, media, invoices, zap receipts, or gifts; does not call `deleteById`; does not recreate via `POST /messages`. Public JSON never exposes the stamps.
- **Inputs:** `id` (message id string).
- **Returns / side effects:** `Promise<boolean>` — `false` when no row has that id; `true` when the id exists (hidden or already live). In-memory mutates store rows; Postgres uses one UPDATE CTE (`IS NOT DISTINCT FROM` stamp match on direct children).
- **Used by:** `debugMessagesRoutes` (`POST /debug/messages/:id/restore`).

## Function: InMemoryMessageStore

- **Purpose:** Process-local `MessageStore` for the public member forum. Default empty so the process boots without a database. Photos live in a private map, not on listed rows. Extra stills (indices 1–9) live in a second private map (`getExtraPhoto` / `listExtraPhotos`); `create(row, photo?, video?, extraPhotos?)` stores extras (indices 1..n max 9, ignored when `video` is set, require photo 0 when non-empty); `photoCount` is (photo 0 ? 1 : 0) + extras length. Same port as Postgres: `getById` (still returns soft-hidden rows), `deleteById` (row, direct replies, photos, invoices, zap receipt ids, on-disk videos), `markDeleted` (stamps `deletedAt` / `deletedBy` on the target and untagged direct replies; never removes media/invoices), `markUndeleted` (clears `deletedAt` / `deletedBy` on the hidden target and stamp-matched direct children; already-live is a no-op for children; never removes media/invoices), `getByEventId`, `findLiveByAccountContent` (oldest live account+parent+`contentFp`), `accountHasLiveTopLevelPost` (`parentId === null`, exclude profile id, replies do not count), live-only `listLatest` (top-level, `parentId` null and `deletedAt` null, each row has live `replyCount` of children with an account or recorded external author pubkey), live-only `listReplies` (children with an account or recorded external author pubkey), `countByAccount` (uncapped live post/reply totals for one account), live-only `listPostsByAccount` (newest-first top-level for one account, cap, live `replyCount` of children with an account or recorded external author pubkey), live-only `listRepliesByAccount` (newest-first replies for one account, cap, no `replyCount`), `listDebug` (operator newest-first **all** rows: top-level and replies, live and soft-hidden), `listHidden` (staff newest-hidden-first hidden rows only, `deletedAt` desc then `id` desc), live-only `listPublishedEventIds`, claim/sign/publish (`claimUnsigned` / `claimUnpublished` skip soft-hidden; unsigned is pending + null `eventId`; lease expires at `claimedUntil`), live-only `listPendingSigned` (pending, no `t=bitcoin`, oldest-first), `clearSignedEvent` (pending and `eventId` still matches `expectedEventId` and the note has no child replies, then nulls `eventId` / `nostrEvent` / `claimedUntil`), live-only `listSignedMissingPhoto` (top-level only, no children, published + photo, kind:1 content lacks `/messages/:id/photo.` plus extension, oldest-first, `sats === 0`, `nostrAttempts < MAX_PUBLISH_ATTEMPTS` (5, preventing a row that can never satisfy a repair scan from being reset forever), pending excluded, video rows excluded so posters are not treated as missing photos), live-only `listSignedMissingVideo` (top-level only, no children, published + video MIME, kind:1 content lacks `/messages/:id/video.`, oldest-first, `sats === 0`, `nostrAttempts < MAX_PUBLISH_ATTEMPTS` (5, preventing a row that can never satisfy a repair scan from being reset forever), pending excluded), live-only `listSignedMissingHashtags` (top-level only, no children, published unpaid, kind:1 content lacks a `#bitcoin` or `#21gifts` token, oldest-first, `sats === 0`, `nostrAttempts < MAX_PUBLISH_ATTEMPTS` (5, preventing a row that can never satisfy a repair scan from being reset forever), pending excluded so fan-out is not starved; optional extras map lists rows whose kind:1 also lacks that account's location token; one-arg still bitcoin/21gifts only; optional `excludeIds` applied before the limit so profile notes cannot fill the batch), `resetSignedEvent` (nulls `eventId` / `nostrEvent` / `claimedUntil`, parks `pending`, clears `nostrPublishEpoch`, increments `nostrAttempts`, and stamps `nostrFirstAttemptAt` once, no-op unless `eventId` still matches, `sats` is 0, and the note has no child replies), `addSats`, `recordZapReceipt` (duplicate receipt id does not add sats; ids are released on `deleteById` so the same receipt can be recorded again), `recordInvoiceAttempt` / `listInvoiceAttempts` (each attempt includes `lnurlResponse` object or null), `findOkInvoiceByPaymentHash` / `findOkInvoiceByPr` (newest `result === 'ok'` by payment hash / BOLT11 `pr`), `listOpenConversationZapEventIds` (returns `{ eventId, conversationMessageId }[]` from ok invoices with both conversation id and conversation message id; no `conversation_message` join — existence filter is in `indexOpenZapReceipts`), `updateZapReceiptGift` (patch payer / gift-reply id / comment; missing receipt is a no-op; omitted patch fields stay), `getZapReceiptGift` (one receipt including comment and gift-reply id), `listZapReceiptsAwaitingGiftReply` (`payerAccountId` or `payerPubkey` set and no gift reply yet, cap, `receiptEventId` ASC, includes `comment`), `recordZapIngest` / `listZapIngests`, `listInvoiceAttemptsForPayer` (uncapped payer filter, newest-first), `listIndexedZapIngests` (uncapped, `outcome = indexed` only), `listAuthoredMessages` (all rows for one account including hidden, no cap), `updateText(id, text)` (mutates `text` only and returns a copy; sats / photos / event ids unchanged; missing id → `undefined`); `create` returns the existing row when `id` is already stored (including after that row's parent was later deleted); a non-null `parentId` requires a live parent (`deletedAt` null) and throws without appending when the parent is missing or soft-hidden; `updateSignedEvent` returns false on duplicate `eventId`. Store/HTTP order is newest-first; product UX is a messenger group (clients reverse).
- **External-zapper methods:** `attributeZapReceipt(receiptEventId, { payerPubkey, zapRequestId, comment })` returns `false` when the receipt is missing or another receipt in the map already has that request id; otherwise it lowercases and stores the payer pubkey, request id, and comment. `recordZapper(pubkey, receiptEventId, at)` lowercases the pubkey and stores the first row in a private map that `deleteById` and receipt queue updates do not clear; `listZapperPubkeys()` returns its keys; `listZappers(limit)` sorts copied rows by `createdAt` descending and caps them. `blockPubkey(pubkey, at, byAccountId, messageId)` likewise lowercases the pubkey and keeps the first block in a private map; `unblockPubkeyByMessage(messageId)` removes the first matching map entry and reports whether one was found; `listBlockedPubkeys()` returns the map keys; `listBlockedPubkeyRows(limit)` sorts copied rows by `blockedAt` descending and caps them. `markDeletedByExternalPubkey(pubkey, at, byAccountId)` case-insensitively stamps every live row with `accountId === null` and the matching `authorPubkey`, returning the number newly hidden. `listUnattributedIndexedReceipts(limit)` pairs indexed ingest frames with their receipt-map entry only while `payerAccountId`, `payerPubkey`, `zapRequestId`, and `giftReplyId` are all null, then sorts by ingest `createdAt` descending, caps, and returns copies.
- **Payment claims:** `claimZapPayment` keeps one owner receipt id per lowercase payment hash in a process-local map. The same receipt id may claim again; another id is refused. `deleteById` does not remove the claim, so a re-created message id cannot be credited twice for one payment.
- **Inputs:** Optional seed `MessageRow[]` (copied; `hasPhoto` defaults false; missing `deletedAt` / `deletedBy` become null). `listLatest(limit)` is live top-level only with live `replyCount` of children whose `accountId` or `authorPubkey` is not null. `listReplies(parentId, limit?)` is oldest-first live children whose `accountId` or `authorPubkey` is not null (default 200). `countByAccount(accountId)` is uncapped live `{ postCount, replyCount }` for that author. `listPostsByAccount(accountId, limit)` is newest-first live top-level for that author with live `replyCount` of children whose `accountId` or `authorPubkey` is not null (cap). `listRepliesByAccount(accountId, limit)` is newest-first live replies for that author (cap, no `replyCount`). `listDebug(limit)` is newest-first all rows including hidden and replies. `listHidden(limit)` is newest-hidden-first hidden rows only (`deletedAt` desc, then `id` desc). `listPublishedEventIds(limit)` is newest-first non-null live top-level `eventId`s. `create(row, photo?, video?, extraPhotos?)` returns the stored row when `id` is already present (no append, no second video write) even if that row's parent was later deleted; a non-null `parentId` requires a live parent (`deletedAt` null) and throws without appending when the parent is missing or soft-hidden; otherwise appends a copy, or returns the existing live media match without a second video write; extras indices 1..n max 9, ignored when `video` is set, require photo 0 when non-empty; `getPhoto(id)` returns a photo copy or null; `getExtraPhoto(id, index)` / `listExtraPhotos(id)` return extra stills from the private map; `photoCount` is (photo 0 ? 1 : 0) + extras length; `markDeleted(id, at, byAccountId)` returns false when missing; `markUndeleted(id)` returns false when missing.
- **Returns / side effects:** Promise of row/photo copies; mutating results does not change the store. Listed objects never expose bytes or `contentFp`. When `id` is new, `video` is set, and no live fingerprint match exists, `create` awaits `writeForumVideo` (disk under `MEDIA_DIR`); if that write throws, the row is never pushed (no unlink).
- **Used by:** `createApp` default `messageStore`.

## Function: InMemoryContactStore

- **Purpose:** Process-local `ContactStore` for the private in-app mailbox. Default empty so the process boots without a database.
- **Inputs:** Optional seed `ContactRow[]` (copied). `listLatest(limit)` sorts newest `createdAt` then `id` DESC and caps at `limit`. `create(row)` appends a copy.
- **Returns / side effects:** Promise of row copies; mutating results does not change the store. No I/O.
- **Used by:** `createApp` default `contactStore`.

## Function: InMemoryConversationStore

- **Purpose:** Process-local `ConversationStore` for member↔member, member↔platform, member↔Damus, and closed `moderator_group` singleton threads. Default empty so the process boots without a database. `hasInboundMessage` is inbound = `conversationIsInbound`. `hasUnread` is inbound `conversationIsInbound` with `createdAt` strictly greater than last-read (missing stamp = never read). `markRead` upserts a private last-read map keyed by accountId + conversationId (Dates copied on construct and store). `ensureModeratorGroup` opens or inserts the singleton (`accountA` = platform; `accountB` and `counterpartPubkey` null). `listVisible` 5th arg `moderator` defaults false. `visibleTo` returns `moderator === true` for that kind first (staff founder never sees it via platform-id).
- **Inputs:** Optional seed threads and messages (copied). Optional third constructor seed of last-read rows is copied. Open helpers are idempotent per unique counterpart. `openMemberPlatform` updates `accountB` when the stored platform id differs. `retargetMemberPlatform` points every member→platform thread at the new official account except rows whose member is that account. `listVisible(accountId, staff, platformId, limit, moderator = false)` is newest `lastMessageAt` then `id` DESC. `hasInboundMessage` is true when any message on that conversation id is inbound for the viewer (`conversationIsInbound`). `unreadCount(accountId, staff, platformId, moderator = false)` uses the same list filter as GET `/conversations` (including `moderator_group` when the 4th arg is true).
- **Returns / side effects:** Promise of copies; mutating results does not change the store. Duplicate `id` or `eventId` append returns the existing row. No I/O.
- **Used by:** `createApp` default `conversationStore`.

## Function: InMemoryLnAddressCache

- **Purpose:** TTL cache for successful LUD-16 metadata resolves.
- **Inputs:** `get(address, now)`, `put(entry, now)`. TTL from `LN_ADDRESS_CACHE_TTL_MS`.
- **Returns / side effects:** `get` returns `CachedLnAddress` or `null`.
- **Used by:** `lightningAddressRoutes`.

## Function: InMemoryGiftStore

- **Purpose:** Process-local GiftStore seeded at construction. Default empty so the process boots without a database.
- **Inputs:** Optional `GiftRow[]`. `listOutbound()` copies and sorts by `paidAt`.
- **Returns / side effects:** Promise of rows. Does not mutate the seed array.
- **Used by:** `createApp` default `giftStore`.

## Function: mapGiftQueryRow

- **Purpose:** Maps a SQL `gift` row (`paid_at`, `amount_sats`, `recipient_wos_user`) onto a `GiftRow`.
- **Inputs:** `GiftQueryRow` (Date or string timestamp; numeric/string/bigint sats).
- **Returns / side effects:** `{ paidAt, amountSats, recipientWosUser }`. No I/O.
- **Used by:** Production `QueryGiftStore` query in `openBootStores`.

## Function: QueryGiftStore

- **Purpose:** GiftStore that delegates `listOutbound` to an injected query (Postgres in production).
- **Inputs:** `() => Promise<GiftRow[]>`.
- **Returns / side effects:** The query result. Errors propagate to the route (503).
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: UnconfiguredInvoicePayer

- **Purpose:** InvoicePayer that always fails — process boots without a payer so verification returns 503 until wired.
- **Inputs:** `isConfigured()` is always false. `payInvoice(bolt11)` is the pay method.
- **Returns / side effects:** `{ ok: false, reason: 'not_configured' }` — it does not throw.
- **Used by:** Default `createApp` `invoicePayer`.

## Function: checkSpendAuth

- **Purpose:** Timing-safe compare of the spend-worker Bearer token to `SPEND_API_TOKEN`.
- **Inputs:** Configured token (may be unset) and the raw `Authorization` header.
- **Returns / side effects:** `unconfigured` | `unauthorized` | `ok`. Does not throw on length mismatch.
- **Used by:** `invoiceRoutes`.

## Function: resolveSpendPing

- **Purpose:** Resolve a spend ping collaborator from env. Unset or blank `SPEND_URL` or `SPEND_API_TOKEN` → `undefined` (caller skips). Trims both values and strips trailing slashes from the URL. The process still boots.
- **Inputs:** `env` (`Record<string, string | undefined>`) and `fetchImpl` (`FetchFn`).
- **Returns / side effects:** `HttpSpendPing` when both env values are set; otherwise `undefined`. No HTTP.
- **Used by:** `createApp`.

## Function: HttpSpendPing

- **Purpose:** POST `{ address, messageId }` (omitted/`daily`) or `{ address, kind: "moderator" }` without `messageId` to `{spendUrl}/ping` with Bearer `SPEND_API_TOKEN`. 2xx logs `spend.ping.ok`. Network, abort, and non-2xx log `spend.ping.failed` and resolve. Never throws. Never logs the token.
- **Inputs:** Constructor `{ spendUrl, token, fetchImpl, timeoutMs? }` (already-trimmed base URL, no trailing slash; default timeout 5000 ms). `ping(address, messageId, kind?: 'daily' | 'moderator')`. omitted/`daily` → `{ address, messageId }`; `'moderator'` → `{ address, kind: "moderator" }` without `messageId`.
- **Returns / side effects:** `Promise<void>`. HTTP POST; logs `spend.ping.ok` or `spend.ping.failed`.
- **Used by:** `resolveSpendPing`.

## Function: NoopSpendPing

- **Purpose:** `SpendPing` that ignores address, `messageId`, and optional kind — used when tests inject a collaborator that must not call HTTP.
- **Inputs:** `ping(_address, _messageId, _kind?)`. Accepts optional 3rd arg, ignores it.
- **Returns / side effects:** Resolves immediately. No HTTP.
- **Used by:** Tests.

## Function: decodeBolt11

- **Purpose:** Read payment hash and millisat amount from a BOLT11 string via `light-bolt11-decoder`.
- **Inputs:** `pr` string; optional test decoder.
- **Returns / side effects:** `{ paymentHash, amountMsat }` or `null` on any decode failure.
- **Used by:** `invoiceRoutes` after LNURL-pay returns `pr`.

## Function: InMemoryInvoiceStore

- **Purpose:** Process-local store of gift invoices issued for the spend worker. `GiftInvoice` may include optional `messageId` and `comment`; `markPaid` preserves them.
- **Inputs:** `put`, `get(id)`, `markPaid(id, preimage, now)`, `sweep(now)`.
- **Returns / side effects:** Lookups return the row or `undefined`. `sweep` drops unpaid rows after expiry plus one extra TTL (409 tombstone window); paid rows stay for proof idempotency. Restart clears the map.
- **Used by:** Default `createApp` `invoiceStore`; `invoiceRoutes`.

## Function: invoiceRoutes

- **Purpose:** Hono sub-app for spend-worker passkey eligibility (`GET /passkey`), live top-level forum-post eligibility (`GET /posted`), invoice issue (`POST /`, optional `messageId`), and preimage proof (`POST /proof`). Issue refuses addresses without a passkey-backed account (403 before LNURL) and without a live top-level non-profile forum post (403 after passkey, before LNURL). Replies do not count. When `invoice.messageId` is set, a matching proof inserts a platform-account gift-reply first, then `addSats` (idempotent), then `notifyForumReply` with `auth` (in-app every account except the platform actor, then filtered by each account's `notificationLevel`; Web Push only to bell subscribers, same filter; missing `pushStore` still writes in-app rows; notify failure logs `messages.reply.notify.failed` and still 200); when that message is already a reply (`parentId` set), persists a deterministic `spendGiftReplyId` marker under that reply, `markDeleted` so live `listReplies` omits it, then `addSats`s the reply (a live existing marker is `markDeleted` only and does not `addSats`; no `notifyForumReply`).
- **Inputs:** `InvoiceRouteDeps`: spend token, invoice `store`, `authStore` (`listAccounts`, `getAccount`, `getNostrPublicKey`, plus account + passkey lookup), `messageStore` (`getById`, `addSats`, `create`, `markDeleted`, `listPostsByAccount`, plus live-post lookup), clock, fetch, optional `giftRecorder` (default `NoopGiftRecorder`), optional `notificationStore` / `pushStore` / `conversationStore`.
- **Returns / side effects:** Hono app mounted at `/invoices`. `GET /passkey` returns `{ hasPasskey }` (200 even when false). `GET /posted` returns `{ hasPosted, messageId, postedAt }` (200 even when false). `messageId` is the newest live top-level non-profile id, or null. `postedAt` is that row's `createdAt` ISO-8601, or null whenever `messageId` is null (including `hasPosted: true` with `messageId: null`). A matching proof (including the same-preimage idempotent 200) calls `recordOutbound`, inserts the platform gift-reply first, then `addSats`. When `messageId` is already a reply (`parentId` set), attach persists a deterministic `spendGiftReplyId` marker under that reply, `markDeleted` so live `listReplies` omits it, then `addSats`s the reply (a live existing marker is `markDeleted` only and does not `addSats`). Insert failures log `gifts.record_failed` and still return 200. Gift-reply attach skips and logs `invoice.gift_reply.failed` when the parent or platform account is missing; still 200.
- **Used by:** `createApp`.

## Function: NoopGiftRecorder

- **Purpose:** `GiftRecorder` that ignores the row — used when `DATABASE_URL` is unset so proof still returns 200.
- **Inputs:** `recordOutbound(record)` with a `GiftRecord`.
- **Returns / side effects:** Resolves immediately. No SQL.
- **Used by:** `invoiceRoutes` default when `giftRecorder` is omitted.

## Function: SqlGiftRecorder

- **Purpose:** Persist a proven outbound gift into Postgres `gift` for `GET /gifts` and `GET /gifts/stats`.
- **Inputs:** Shared boot `SqlClient`. `recordOutbound` inserts `paid_at`, sats, recipient handle, BOLT11 `pr`, description, `source_wallet`.
- **Returns / side effects:** `INSERT … ON CONFLICT (lightning_invoice) DO NOTHING`. Errors propagate to the route, which logs and still returns 200.
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: recipientHandleFromAddress

- **Purpose:** Stats handle from a Lightning Address: local-part before `@`, or the whole string if there is no `@`.
- **Inputs:** Normalised `local@domain` (or a bare handle).
- **Returns / side effects:** `recipient_wos_user` string. No I/O.
- **Used by:** `invoiceRoutes` when recording a proven gift.

## Function: newInvoiceId

- **Purpose:** 16 random bytes as 32 lowercase hex characters.
- **Inputs:** None (uses `crypto.getRandomValues`).
- **Returns / side effects:** Unguessable invoice id string.
- **Used by:** `POST /invoices`.

## Function: normalizeHex32

- **Purpose:** Accept a 32-byte hex string (any case, trimmed).
- **Inputs:** Raw hex string.
- **Returns / side effects:** Lowercase 64-char hex or `null`.
- **Used by:** `preimageMatchesHash`.

## Function: preimageMatchesHash

- **Purpose:** Lightning proof-of-payment: `sha256(preimage)` equals the invoice payment hash.
- **Inputs:** Preimage hex and payment-hash hex.
- **Returns / side effects:** `true` only on a 32-byte match.
- **Used by:** `POST /invoices/proof`.

## Function: requestGiftInvoice

- **Purpose:** LNURL-pay fetch for gift amounts: no 10-sat cap, comment optional, amount not raised to minSendable.
- **Inputs:** Normalised address, amountMsat, optional comment, fetchImpl.
- **Returns / side effects:** `{ ok: true, pr }` or `{ ok: false, reason: 'unreachable' }`.
- **Used by:** `POST /invoices`.

## Function: authRoutes

- **Purpose:** Hono sub-app for passkey register and authenticate. Register begin accepts an optional `{ viewKey }` to claim a provisioned account; empty begin still mints a pending new account. Passes optional `nostrKek` / `nostrKeygen` into finish so new logins get a custodial nsec.
- **Inputs:** `AuthRouteDeps`: store, `messages`, now, allowedOrigins, webAuthnRpId, webAuthnRpName, passkeyCeremony, optional `nostrKek` and `nostrKeygen`.
- **Returns / side effects:** Hono app mounted at `/auth`. Begin with viewKey maps claim errors to 404/409; unwraps `{ challengeId, options }` on success.
- **Used by:** `createApp`.

## Function: bearerToken

- **Purpose:** Parses `Authorization: Bearer <token>`.
- **Inputs:** Header string or undefined.
- **Returns / side effects:** Token or `null`.
- **Used by:** `meRoutes`, `messagesRoutes`.

## Function: brandRoutes

- **Purpose:** Serves favicon.ico, favicon.svg, apple-touch-icon.png from `public/`.
- **Inputs:** `BrandRouteDeps.read`.
- **Returns / side effects:** Hono app with three GETs; 404 empty body if bytes missing.
- **Used by:** `createApp` at `/`.

## Function: confirmVerification

- **Purpose:** Checks the nonce the user read from the wallet payment comment (`21gifts <hex>`), not a nonce returned by startVerification.
- **Inputs:** `store`, `now`, `account`, `nonceRaw`.
- **Returns / side effects:** Success marks the address verified, or a `ConfirmVerificationCode`.
- **Used by:** `POST /me/lightning-address/verification/confirm`.

## Function: createApp

- **Purpose:** Wires CORS, requestLog, brand, health, info, auth, me, `/view`, lightning-address, `/debug/accounts`, `/debug/contacts`, `/debug/messages`, `/debug/invoices`, `/debug/invoices/settle`, `/debug/zap-ingests`, `/debug/push-ping`, `/debug/trust-edges`, `/trust-chain`, `/trust` (verify / propose-moderator / confirm-moderator / appoint-moderator), Web Push subscription routes, `/gifts`, `/gifts/stats`, `/messages` (incl. invoice), `/members/:accountId`, `/.well-known` NIP-05 `nostr.json` (CORS `*`), `/contact`, `/conversations`, `/notifications`, and invoices.
- **Inputs:** Optional `AppDeps` (store, clock, payer, fetch, cache, readBrand, origins, `debugToken`, giftStore, `giftRecorder`, `btcUsdRates`, `fiatRates`, `messageStore`, `contactStore`, optional `conversationStore` (default `InMemoryConversationStore`), optional `notificationStore` (default `InMemoryNotificationStore`), `pushStore`, `trustStore`, `vapidPublicKey`, `nostrKek`, spendApiToken, `spendPing` (default `resolveSpendPing(process.env, fetchImpl)`; unset/blank `SPEND_URL` or `SPEND_API_TOKEN` omits it; `POST /messages` still 200; daily/omitted kind body `{ address, messageId }`; `conversationRoutes` gets the same `spendPing`; moderator-group POST body `{ address, kind: "moderator" }` without `messageId`; forum `POST /messages` still two-arg daily ping), invoiceStore, `webAuthnRpId`, `webAuthnRpName`, `passkeyCeremony`). Omitted `giftRecorder` → `invoiceRoutes` uses `NoopGiftRecorder`; omitted `messageStore` → `InMemoryMessageStore`; omitted `contactStore` → `InMemoryContactStore`; omitted `conversationStore` → `InMemoryConversationStore`; omitted `notificationStore` → `InMemoryNotificationStore`; omitted `pushStore` → `InMemoryPushStore`; omitted `trustStore` → `InMemoryTrustStore`; omitted/blank `vapidPublicKey` → push HTTP 503 after session; omitted `nostrKek` → unsigned forum + invoice 503; SQL boot injects `SqlGiftRecorder`, `PostgresMessageStore`, `PostgresContactStore`, `PostgresConversationStore`, `PostgresNotificationStore`, `PostgresPushStore`, `PostgresTrustStore`, and parsed KEK. `messagesRoutes`, `meRoutes`, `invoiceRoutes`, and `trustRoutes` receive `conversationStore`. `contactRoutes` and `conversationRoutes` receive `pushStore` plus `notificationStore`. Mounts `notificationRoutes` at `/notifications`. Does not take a push sender (worker owns delivery).
- **Returns / side effects:** Hono app. Default `btcUsdRates` is an empty `InMemoryBtcUsdStore`. Default `fiatRates` is an empty `InMemoryFiatStore`. `createApp` passes the same `fiatRates` object into `/gifts`, `/gifts/stats`, `/me`, `/members`, and `/view`. Used by Bun.serve in `index.ts` and by tests via `app.request()`.
- **Used by:** Boot path and every HTTP test.

## Function: healthRoute

- **Purpose:** Hono app: GET `/` → `{ status: 'ok', service, version }`.
- **Inputs:** None.
- **Returns / side effects:** Mounted at `/healthz`.
- **Used by:** Probes.

## Function: infoRoute

- **Purpose:** Hono app: GET `/` → service name, version, description, repo.
- **Inputs:** None.
- **Returns / side effects:** Mounted at `/info`.
- **Used by:** Service discovery.

## Function: lightningAddressRoutes

- **Purpose:** Public LUD-16 resolve with cache.
- **Inputs:** `LightningAddressRouteDeps` cache, now, fetchImpl.
- **Returns / side effects:** Hono GET `/`.
- **Used by:** `GET /lightning-address`.

## Function: logEvent

- **Purpose:** One JSON line on `console.warn` (`ts` + `event` + fields). Never log secrets.
- **Inputs:** `event` string, optional `LogFields`.
- **Returns / side effects:** void.
- **Used by:** Auth, me, lightning-address, requestLog.

## Function: errorLogFields

- **Purpose:** Allowlisted scalar fields for a caught error so a log line never carries free text. Database messages embed offending values (`invalid input syntax for type uuid: "…"`) and fetch errors can embed a callback URL; a length cut is not redaction.
- **Inputs:** Any caught value.
- **Returns / side effects:** `LogFields` with optional `name` (an `Error` name of 1–40 ASCII letters), `code` and `errno` (strings of 1–40 ASCII alphanumerics or underscores, e.g. `ERR_POSTGRES_SERVER_ERROR` and `23505`). Primitives, `null`, and values outside the patterns yield `{}`. Never reads `message`, `detail`, or `cause`. Pure.
- **Used by:** `indexOpenZapReceipts` (per-receipt catch, `nostr.zap.rejected`) and `startNostrWorker` (`nostr.worker.tick.failed`).

## Function: meRoutes

- **Purpose:** Authenticated account routes (`GET /`, `GET /activity`, `POST /setup/skip`, name with `ensureProfileMessage` (no-op without LN), `POST /location` (optional free-text; empty/whitespace stores `null`; does not call `ensureProfileMessage`), PUT `/about` About me on the profile note (`{ text, photo? }`: omitted photo keeps, `null` clears, object sets the same JPEG/PNG/WebP as a forum post; creates without LN, including photo-only empty text), `GET /about/photo` (Bearer profile-note bytes), forum-laws dismiss, `POST /notification-level` (`{ level: all|active|mentions }`, 200 owner JSON, log `account.notification_level.set`), living-room rules agreement, Lightning Address link with live LNURL resolve + zap metadata check then NIP-57 mint probe `probeNip57Mint` then `ensureProfileMessage`, verification). Unlink clears `lightningAddressSkippedAt`. `POST /lightning-address` returns 409 `{ error: 'Lightning Address is already in use' }` when another account owns the address. `GET /activity` is Bearer-only (no rules gate) and returns given/received sats for the session account.
- **Inputs:** `MeRouteDeps` store, `messages`, now, payer, fetchImpl, optional `pushStore`, optional `notificationStore` (profile-note `notifyForumPost`), optional `conversationStore` (inbox unread on profile-note push), optional `nostrKek` (required to sign the mint probe), optional `giftStore`, `rates`, and `fiatRates` (defaults empty in-memory; used by `GET /activity`; missing fiat never 503).
- **Returns / side effects:** Hono at `/me`. Owner JSON includes `setup` + `missing` + `hasPosted` + `aboutMe` + `aboutMeHasPhoto` + `notificationLevel`. `GET /activity` is 200 activity JSON (zeros without Coinbase / Frankfurter when empty) or 503 `{ error: 'Gift stats are unavailable' }` on store throw or missing BTC-USD. Missing fiat never 503. Successful `POST /lightning-address` needs zap metadata (`allowsNostr` + non-empty `nostrPubkey`) plus KEK + `ensureAccountNostrKey` + probe `ok`. Probe `not_zap` → 400 `{ error: LIGHTNING_ADDRESS_NOT_ZAP }`; probe `unreachable` (and missing zap metadata) → 400 `{ error: 'Lightning Address could not be resolved' }`; missing/malformed KEK or key ensure failure → 503 with the same resolve string (account unchanged). Logs `account.setup.skipped` with `{ accountId, step }`. Logs `account.about.set` / `account.about.failed` on PUT `/about`; `GET /about/photo` 503 logs `account.about.photo.failed`. A won PUT `/about` inline claim create calls `notifyForumPost` after the text/photo writes (best-effort). PUT `/about` does not call `ensureProfileMessage`. Updating an already-live note does not notify. Activity 503 logs `account.activity.failed` / `account.activity.fx_incomplete`.
- **Used by:** `createApp`.

## Function: viewRoutes

- **Purpose:** Hono sub-app for public `GET /:viewKey`, `GET /:viewKey/about/photo`, and `GET /:viewKey/activity`. Param not 64 lowercase hex or unknown key → 404 `{ error: 'Not found' }`. Identity hit → `store.accountHasPasskey(account.id)`, load live profile-note text (`deletedAt` null) for `aboutMe` and `aboutMeHasPhoto`, then `serializeViewProfile(account, hasPasskey, aboutMe, aboutMeHasPhoto)`. Photo hit → `forumPhotoResponse` bytes for the live profile note (404 `{ error: 'Photo not found' }` when missing). Activity hit → given/received sats for that account. No auth; not a session.
- **Inputs:** `ViewRouteDeps`: `store`, optional `messageStore`, `giftStore`, `rates`, `fiatRates`, and `now` (defaults empty in-memory / `Date.now`; used by About me and `GET /:viewKey/activity`). Missing fiat never 503.
- **Returns / side effects:** Hono app mounted at `/view` so the public paths are `GET /view/:viewKey`, `GET /view/:viewKey/about/photo`, and `GET /view/:viewKey/activity`. Identity 503 logs `view.get.failed`. Photo 503 logs `view.photo.failed`. Activity is 200 JSON or 503 `{ error: 'Gift stats are unavailable' }` on store throw or missing BTC-USD. Missing fiat never 503. Activity 503 logs `account.activity.failed` / `account.activity.fx_incomplete`.
- **Used by:** `createApp`.

## Function: messagesRoutes

- **Purpose:** Hono sub-app for the public member forum. After Bearer auth, `requireAction` gates `GET /` (`forum.read` → rules), `POST /` (`forum.post` → rules + name + Lightning Address), and `POST /:id/invoice` (`forum.pay` → payer rules only). Bearer `GET /` lists **live top-level** notes only newest-first (cap 200, `hasPhoto`, `hasVideo`, `videoContentType`, `sats`, `payable`, live `role`, live `replyCount` of children with an account or recorded external author pubkey); soft-hidden rows are omitted; missing-file `hasVideo` rows are deleted (`messages.video.dropped`); `POST /` creates text/photo/video after parse/normalize/decode — JSON `photos` max 10, non-empty wins over singular `photo`, `photos.length > 10` is 400 `{ error: 'At most 10 photos' }`; `GET /:id/photo/:file` serves extras 1–9; identical live media from the same account+parent collapses to the existing row (200, no limiter, no second push); text-only still uses the 1/10s burst then inserts; unpaid replies from anyone except the parent author or `moderator`/`founder`/`verified` are 403 `A reply needs a Bitcoin payment`; soft-hidden `inReplyTo` parents are 404; public `GET /:id` stays unauthenticated without `accountId` (a reply with null `accountId` and a recorded `authorPubkey` is 200 with `via: 'nostr'`; only a reply with neither identity is 404; external top-level notes stay 200); optional `?sinceSats=` (non-negative integer) long-polls until `sats` is strictly greater (timeout still 200 with the current body; invalid value 400); soft-hidden rows still 404; public `GET /:id/replies` lists children with an account or recorded external author pubkey (optional Bearer for `accountId`; rows with neither identity are skipped); 404s soft-hidden/missing parents; a child whose author lookup or serialize throws (invalid `createdAt`, author lookup) is omitted and siblings still 200 `{ messages }`; 503 `messages.replies.failed` only for `getById` / `listReplies` throws and for `dropMissingVideoRow` store/I/O (non-ENOENT video I/O or `deleteById`); missing-file drop (`null` → omit) still 200; photo/video byte routes 404 soft-hidden ids; staff `DELETE /:id` soft-hides via `markDeleted` (founder/moderator → 204; basis/verified → 403); staff `GET /hidden` lists soft-hidden notes newest-hidden-first (founder/moderator session, not `DEBUG_TOKEN`, no `forum.read`; 200 `{ messages }` via `listHidden` / `serializeHiddenMessage`; logs `messages.hidden.listed` with `count` only); invoice returns `{ pr, amountSats }` only for NIP-57 invoices and 404s soft-hidden notes (author LN / unsigned stay 400 resource errors, never 409 `lightning-address` for the payer). Optional `notificationStore` fans out via `notifyForumPost` / `notifyForumReply` to every account except the actor, then filtered by each account's `notificationLevel` (no inbox copy; missing `pushStore` still writes in-app rows; Web Push only to bell subscribers, same filter). Optional `spendPing`: after a **new** top-level persist the route POSTs `{ address, messageId }` to `{SPEND_URL}/ping` with Bearer `SPEND_API_TOKEN` (fire-and-await, errors logged, POST still 200). Replies and media replays skip. Omitted `spendPing` skips. Notification or push failure still returns 200.
- **Inputs:** `MessagesRouteDeps`: message `store`, shared `authStore`, `now`, optional `nostrKek`, `fetchImpl`, `postLimiter`, `invoiceLimiter`, optional `pushStore`, optional `spendPing`, optional `notificationStore`, optional `conversationStore`, optional `waitSatsSleep` (test inject; default `defaultWaitSatsSleep`), optional `waitSatsTimeoutMs` (test inject; default `WAIT_SATS_TIMEOUT_MS`), optional `waitSatsPollMs` (test inject; default `WAIT_SATS_POLL_MS`).
- **Returns / side effects:** Hono app mounted at `/messages`. 401 without session on list/create/DELETE/GET `/hidden`/invoice; 403 on DELETE and GET `/hidden` when not founder/moderator and on unpaid `inReplyTo` from basis non-authors; 409 `{ error: 'missing_requirements', missing }` when action gates fail (GET `/hidden` has no `forum.read` gate); 400 on bad body / invalid text / bad media / unpaid note / author's-wallet / LNURL failures; 404 for bad `inReplyTo` / missing or soft-hidden rows; 204 empty body on successful DELETE; 200 staff hidden log `{ messages }` (no `forum.read`); 429 rate limits; 503 on store/KEK/sign failure. Signed-in list/replies/create may include `accountId`; public JSON never includes `accountId`, `deletedAt`, or `deletedBy`. Post and reply notify call `notifyForumPost` / `notifyForumReply` best-effort (in-app rows for every account except the actor, then filtered by each account's `notificationLevel`; Web Push for bell subscribers, same filter; failure still 200).
- **Used by:** `createApp`.

## Function: contactRoutes

- **Purpose:** Hono sub-app for the private in-app contact mailbox: `POST /` only (no member GET). After auth, `requireAction(account, 'contact.post')` (rules + name). After the platform account exists, persists the contact row first, then opens/appends the member→platform conversation thread. Conversation append failure logs `conversations.contact_sync.failed` and still 200.
- **Inputs:** `ContactRouteDeps`: contact `store`, `conversationStore`, shared `authStore`, `now`, optional `pushStore` and `notificationStore`.
- **Returns / side effects:** Hono app mounted at `/contact`. 401 without session; 409 `{ error: 'missing_requirements', missing }` when rules/name are missing; 400 on bad body / invalid text; 503 `{ error: 'Platform account is not configured' }` when no `isPlatform` account (no writes); 503 Contact is unavailable on contact-store failure (`contact.create.failed`). After a successful conversation append, `notifyConversationMessage` is void-caught (`conversations.push.failed`); contact 200 is unchanged. Public JSON omits `accountId`.
- **Used by:** `createApp`.

## Function: conversationRoutes

- **Purpose:** Hono sub-app for the signed-in PN channel: `GET /` lists `{ conversations, unreadCount }` (`unreadCount` = listed rows with `unread` true) for visible inbox threads and always passes `moderator: false` into `listVisible` (never ensures, pins, or returns `moderator_group`); `POST /` opens a thread from `{ forumMessageId }`; `GET /moderator-group` (before `GET /:id`) is the moderator-only tool: `ensureModeratorGroup` then `{ conversation }` (with `unread` from `hasUnread`); non-moderator 404; missing platform / store failure 503 `conversations.moderator_group.failed`; `GET /:id` lists messages oldest-first (`?sinceMessageId=` long-poll); `POST /:id/read` stamps last-read (mount before `POST /:id`); `POST /:id` appends `{ text }`; `POST /:id/invoice` issues a NIP-57 gift invoice. Staff (founder/moderator) see all platform threads and reply as the platform nsec. `moderator_group` ACL is `role === 'moderator'` only (founder 404). `POST /:id` on this kind persists as the moderator (not staff-as-platform) with `nostrPublishState: 'skipped'`, then `spendPing.ping(address, created.id, 'moderator')` only when Lightning Address is non-empty after trim **and** a live living-room top-level post exists on this UTC day; no living-room post today → 200, no ping, `spend.ping.skipped` / `no_public_post`; living-room lookup failure after persist → 200, no ping, `spend.ping.skipped` / `posted_unreachable`; ping throw still 200.
- **Inputs:** `ConversationRouteDeps`: conversation `store`, shared `authStore`, forum `messageStore`, `now`, optional `spendPing`, optional `fetchImpl` / `nostrKek` / `invoiceLimiter` / wait injects, optional `pushStore` and `notificationStore`.
- **Returns / side effects:** Hono app mounted at `/conversations`. 401 without session; 400 on bad body / self-PM / missing name / invalid text / author wallet; 404 when not allowed; 429 Too many payments; 503 `{ error: 'Messages are unavailable' }` for missing KEK / sign failure; 503 `{ error: 'Conversations are unavailable' }` for store/catch including ok-path `recordInvoiceAttempt` throw (`conversations.list.failed` / `conversations.read.failed`). After a successful `POST /:id` append, `notifyConversationMessage` is void-caught (`conversations.push.failed`) so 200 is unchanged. Public list/open JSON includes `unread` and `lastSats` and may include optional counterpart `accountId`; thread messages may include optional sender `accountId`. Omits event ids and npubs (Damus-only `name` may be a truncated npub; Damus-only counterparts and Damus inbound omit `accountId`). List rows include `lastSats`; messages include `sats`.
- **Used by:** `createApp`.

## Function: notificationRoutes

- **Purpose:** Hono sub-app for signed-in in-app notifications: `GET /` lists `{ notifications, unreadCount }` (cap 200; `unreadCount` is total unread, not page length; each item `type` is `'forum_post' | 'forum_reply' | 'zap' | 'moderator_appointed'`), `POST /read-all` marks all read, `POST /:id/read` marks one UUID. Mount `read-all` before `/:id/read`. Never exposes recipient or actor account ids. `DEBUG_TOKEN` cannot read this list.
- **Inputs:** `NotificationRouteDeps`: notification `store`, shared `authStore`, `now`.
- **Returns / side effects:** Hono app mounted at `/notifications`. 401 without session; 404 `{ error: 'Not found' }` for unknown / other-account / non-uuid `:id`; 503 `{ error: 'Notifications are unavailable' }` (`notifications.list.failed` / `notifications.read_all.failed` / `notifications.read.failed`).
- **Used by:** `createApp`.

## Function: normalizeDisplayName

- **Purpose:** Trim and validate an account display name (1–80 characters, no C0/DEL controls).
- **Inputs:** `raw` string.
- **Returns / side effects:** Trimmed name or `null`.
- **Used by:** `POST /me/name`.

## Function: normalizeLocation

- **Purpose:** Trim and validate an optional free-text profile location (at most 80 characters after trim, no C0/DEL controls). Empty or whitespace-only input is a valid clear (`null`), unlike `normalizeDisplayName` which rejects empty. Internal spaces are kept.
- **Inputs:** `raw` string. Cap is `LOCATION_MAX_LENGTH` (80).
- **Returns / side effects:** `{ ok: true, value: string | null }` when empty-after-trim (clear) or a valid stored string; `{ ok: false }` when over-long (`> 80` after trim) or any character has `charCode < 32` or `=== 127`. No I/O.
- **Used by:** `POST /me/location`.

## Function: locationHashtagName

- **Purpose:** Turn a stored profile location into a Damus hashtag name without `#`. Null or empty-after-strip returns `null` so callers add no tag. Strips leading `#` characters then all whitespace (`New York` → `NewYork`). Unicode letters and original case are kept (`Zürich`).
- **Inputs:** `location` (`string | null`).
- **Returns / side effects:** Hashtag name without `#`, or `null`. No I/O.
- **Used by:** `buildKind1Event`, `runNostrWorkerTick` (`signBatch` / `resignHashtagKind1`).

## Function: normalizeForumText

- **Purpose:** Trim and validate forum message text. Empty/whitespace becomes `''` (valid for photo-only or video-only posts). Over-long (after trim, longer than `maxLength`) or disallowed C0/DEL still reject; newlines `\n`/`\r` allowed.
- **Inputs:** `raw` string; optional `maxLength` (default `MESSAGE_MAX_LENGTH` 500). Inbound Nostr worker passes `MESSAGE_INBOUND_REPLY_MAX_LENGTH` (8192) for Damus kind:1 replies and NIP-17/kind:4 plaintext.
- **Returns / side effects:** Trimmed text (possibly empty) or `null`. No I/O.
- **Used by:** `POST /messages`, `POST /contact`, `POST /conversations/:id`, `PUT /me/about`, `runNostrWorkerTick` inbound indexing.

## Function: detectImageContentType

- **Purpose:** Detect JPEG / PNG / WebP from magic bytes for forum photo storage.
- **Inputs:** Raw `Uint8Array` candidate bytes.
- **Returns / side effects:** `'image/jpeg' | 'image/png' | 'image/webp'`, or `null` for empty/SVG/GIF/HEIC/unrecognized. No I/O.
- **Used by:** `decodeForumPhoto`.

## Function: decodeForumPhoto

- **Purpose:** Decode a base64 forum photo, enforce the 1 MiB cap, and set MIME from magic bytes (declared `contentType` is ignored).
- **Inputs:** Declared `contentType` string (non-authoritative) and standard base64 `data`.
- **Returns / side effects:** `{ contentType, bytes }` with a copied `Uint8Array`, or `null` on invalid base64, empty, oversize, or unrecognized magic. No I/O.
- **Used by:** `POST /messages`, `PUT /me/about`.

## Function: forumPhotoResponse

- **Purpose:** Build the public photo HTTP response used by `GET /messages/:id/photo`, `GET /me/about/photo`, and `GET /view/:viewKey/about/photo`. Sets jpeg/png/webp `Content-Type`, `Cache-Control: public, max-age=86400`, `Access-Control-Allow-Origin: *`, and inline `Content-Disposition` `photo.jpg|png|webp`.
- **Inputs:** `ForumPhoto` (`contentType` plus `bytes`).
- **Returns / side effects:** `200` `Response` whose body is `photo.bytes`. No I/O.
- **Used by:** `serveForumPhoto`, `meRoutes` GET `/about/photo`, `viewRoutes` GET `/:viewKey/about/photo`.

## Function: updatePhoto

- **Purpose:** `MessageStore` port method: replace or clear stored photo bytes without changing text, sats, or event ids, and without recomputing `content_fp` (same as `updateText`). In-memory copies bytes into a private map; Postgres `UPDATE message SET photo = $2, photo_content_type = $3 WHERE id = $1 RETURNING` list columns.
- **Inputs:** Message `id` and `ForumPhoto | null` (`null` clears).
- **Returns / side effects:** Updated row copy with `hasPhoto` true iff photo is non-null, or `undefined` when no row has that id.
- **Used by:** `PUT /me/about` when the `photo` key is present on an already-live profile note.

## Function: forumContentFingerprint

- **Purpose:** Build the store-internal content fingerprint for live forum media dedupe so the same account+parent+text+bytes collapse to one note. Optional third arg `extraMedia` (readonly extra still bytes, index order); omitted or empty keeps the two-arg formula unchanged. Video paths must not pass extras.
- **Inputs:** Already-normalised `text` string (may be empty), required `mediaBytes` (`Uint8Array` photo or video; video wins when both exist), and optional `extraMedia` (readonly extra still bytes in index order).
- **Returns / side effects:** Lowercase hex SHA-256 (64 chars) of `utf8(text) || 0x00 || sha256(mediaBytes) || sha256(extra1) || …` in index order 1..n when extras are present. Video paths omit extras (two-arg formula). Empty or omitted extras keep the two-arg formula (`utf8(text) || 0x00 || sha256(mediaBytes)`). No I/O. Never appears on public JSON.
- **Used by:** `MessageStore.create`, `POST /messages` (JSON and multipart collapse path).

## Function: findLiveByAccountContent

- **Purpose:** Look up the oldest live forum row for the same account, parent (top-level vs reply), and content fingerprint before inserting a duplicate media note.
- **Inputs:** `accountId` string, `parentId` (`string | null`; null matches top-level `parent_id IS NULL`), and `contentFp` hex from `forumContentFingerprint`.
- **Returns / side effects:** Promise of the oldest matching live `MessageRow` (`deletedAt` null), or `undefined`. Soft-deleted matches are ignored. No public JSON.
- **Used by:** `POST /messages` media collapse; Postgres `create` on unique violation `23505`.

## Function: serializeMessage

- **Purpose:** Project a stored forum row to its public JSON shape including zap totals, payability, `hasPhoto`, `photoCount` (0–10; from `row.photoCount` or `hasPhoto ? 1 : 0`), `hasVideo`, `videoContentType`, live author role, optional `via`, optional `replyCount`, optional `accountId`, and optional `parentId`. When stored `name` is empty after trim, JSON `name` is `truncatePubkeyDisplay(row.authorPubkey ?? '')` (`'npub'` when the pubkey is missing); non-empty names are unchanged. Invalid `createdAt` is not guarded here: `toISOString()` still throws. `GET /messages/:id/replies` and `GET /members/:accountId/replies` omit that child (200, siblings remain); `GET /messages` (list), `GET /members/:accountId/posts`, and public `GET /messages/:id` return 503. Member feeds reuse this: `GET /members/:accountId/posts` is newest-first like signed-in `GET /messages`; `GET /members/:accountId/replies` is newest-first with `payable` when a non-empty `eventId` and a non-blank Lightning Address are set. Callers that serve list/GET/replies delete a `hasVideo` row when the file is missing or empty on disk (`forumVideoFilePresent`) so no empty note remains. Store-internal `contentFp` is never included.
- **Inputs:** `MessageRow` (includes `accountId` and private `authorPubkey`; never photo/video bytes), `payable` boolean, optional `role` (`AccountRole`; omitted for external Nostr authors), optional `replyCount` (top-level `GET /messages` and `GET /members/:accountId/posts` list rows), and optional `includeAccountId` (signed-in list/replies/create and member feeds pass true; public GET omits).
- **Returns / side effects:** `{ id, name, text, createdAt, sats, payable, hasPhoto, photoCount, hasVideo, videoContentType }` with ISO-8601 `createdAt`; `name` uses the blank-name fallback when stored `name` trims empty; `photoCount` is 0–10 (from `row.photoCount` or `hasPhoto ? 1 : 0`); `videoContentType` is null when `hasVideo` is false; `via: 'nostr'` is set exactly when `row.accountId === null && row.authorPubkey !== null`; those external rows have `payable` false and omit `role`; the pubkey itself is private and never appears in public JSON. `role` is otherwise omitted when undefined; `replyCount` is omitted when undefined; `accountId` is set only when `includeAccountId` is true and `row.accountId !== null` (external rows and public GET omit it); `parentId` is set only when `row.parentId !== null` (omitted on top-level notes); never photo/video bytes or `contentFp`. No I/O.
- **Used by:** `messagesRoutes`, `membersRoutes`.

## Function: serializeDebugMessage

- **Purpose:** Project a stored forum row to operator debug JSON, including soft-hide stamps, Damus-only `accountId: null`, and `photoCount` (0–10; from `row.photoCount` or `hasPhoto ? 1 : 0`). Public hide does not apply: hidden rows keep `text` and ISO `deletedAt`. Never includes `nostrEvent`, `claimedUntil`, `contentFp`, nsec, or photo/video bytes.
- **Inputs:** `MessageRow` (includes hidden rows and replies; never photo/video bytes).
- **Returns / side effects:** `{ id, name, text, createdAt, sats, hasPhoto, photoCount, hasVideo, videoContentType, parentId, eventId, nostrPublishState, deletedAt, deletedBy, authorPubkey, nostrAttempts, accountId }` with ISO-8601 `createdAt` / `deletedAt` (`deletedAt` JSON `null` when live); `photoCount` is 0–10 (from `row.photoCount` or `hasPhoto ? 1 : 0`); `accountId` is a string or JSON `null` (never omitted). Invalid `createdAt` / `deletedAt` still throws from `toISOString()`. No I/O.
- **Used by:** `debugMessagesRoutes`.

## Function: serializeHiddenMessage

- **Purpose:** Project a stored forum row to staff hidden-log JSON (who hid it and when). JSON `name` is the stored `row.name` (no empty-name pubkey fallback). Always includes `parentId` (JSON `null` on top-level notes), ISO `deletedAt` (JSON `null` when live), and `photoCount` (0–10; from `row.photoCount` or `hasPhoto ? 1 : 0`). Optional `via: 'nostr'` is set exactly when `row.accountId === null && row.authorPubkey !== null`; the pubkey itself is private and never appears in this JSON. Never includes `accountId`, `eventId`, `nostrPublishState`, `payable`, author `role`, `nostrEvent`, `claimedUntil`, `contentFp`, nsec, or photo/video bytes. Deleter `{ id, name, role }` is resolved in `messagesRoutes`, not here.
- **Inputs:** `MessageRow` (includes hidden rows and replies; never photo/video bytes) and `deletedBy: { id, name, role }` (`AccountRole | null`; `id` / `name` may be null).
- **Returns / side effects:** `{ id, name, text, createdAt, sats, hasPhoto, photoCount, hasVideo, videoContentType, parentId, deletedAt, deletedBy, via? }` with ISO-8601 `createdAt` / `deletedAt` (`deletedAt` JSON `null` when live); `photoCount` is 0–10 (from `row.photoCount` or `hasPhoto ? 1 : 0`); `via: 'nostr'` is set exactly when `row.accountId === null && row.authorPubkey !== null`, while the pubkey itself is never included. Invalid `createdAt` / `deletedAt` still throws from `toISOString()`. No I/O.
- **Used by:** `messagesRoutes` (`GET /messages/hidden`).

## Function: serializeConversation

- **Purpose:** Project a stored thread to its public list JSON shape.
- **Inputs:** `ConversationThread` with resolved `name` / `lastText`, `lastFromMe` boolean, `unread` boolean, and optional counterpart `accountId` (`string | null`).
- **Returns / side effects:** `{ id, kind, name, lastText, lastAt, lastFromMe, lastSats, unread, accountId? }`. `lastSats` is the last message's sats (`0` when unpaid or the thread is empty). Includes `accountId` only when the counterpart id is a non-empty string. Omits event ids, npubs, `accountA` / `accountB`. No I/O.
- **Used by:** `conversationRoutes`.

## Function: serializeNotification

- **Purpose:** Project a stored notification row to its public JSON shape. `type` is `'forum_post' | 'forum_reply' | 'zap' | 'moderator_appointed'`.
- **Inputs:** `NotificationRow` (includes recipient/actor account ids).
- **Returns / side effects:** `{ id, type, parentId, replyId, name, text, createdAt, readAt }` with ISO-8601 dates; `readAt` null stays null. Omits recipient and actor account ids. No I/O.
- **Used by:** `notificationRoutes`.

## Function: fanoutToBellSubscribers

- **Purpose:** Fan out in-app rows and optional Web Push outbox rows except `skipAccountId`. In-app recipients are the union of `auth.listAccounts()` (when `auth` is set) and `push_subscription` account ids. Web Push outbox rows go only to `push_subscription` accounts. Optional `match` `{ actorIsStaff, isActive, mentionedAccountId }` filters after skip when `auth` is also set: drop recipients whose `wantsNotification` is false (level from `listAccounts()`, omitted → `all`; push-only ids not in that list are `all`). When `auth` is unset, do not filter by level even if `match` is passed. Omitted `match` keeps every-id-except-skip behaviour. Missing both `auth` and `pushStore` is a no-op. Unique duplicate `create` is fine. Outbox JSON may include optional `unreadCount` for the home-screen badge: notification unread + listed inbox unread when `inboxUnreadCount` is passed. Either source alone still writes `unreadCount` (missing source is 0).
- **Inputs:** `{ notifications?, pushStore?, auth?, skipAccountId, match?, template, outboxType, outboxMessageId, payload, nowMs, inboxUnreadCount? }`. `skipAccountId` `null` skips nobody. `match` is applied only when `auth` is also set. `template` is copied to each in-app recipient (`id` / `recipientAccountId` filled here). `payload` is the shared JSON template (no `unreadCount`).
- **Returns / side effects:** Void. Logs `push.fanout` with `inApp` and `push` counts. Writes a notification row per in-app id when `notifications` is set, then enqueues one pending outbox row per push id when `pushStore` is set. When `notifications` or `inboxUnreadCount` is set, each outbox JSON is the parsed template plus `unreadCount` (invalid JSON or a non-object template becomes `{ unreadCount }`). When both are omitted, the payload is unchanged. Per-recipient `create`/`unreadCount`/inbox/`enqueue` failures log `push.fanout.failed`, continue, then throw after the loops. Does not copy DMs into notification rows.
- **Used by:** `notifyForumPost`, `notifyForumReply`, `notifyZap`.

## Function: notifyForumPost

- **Purpose:** Notify living-room members of a new top-level forum post except the actor. Persist a `forum_post` row when `notifications` is set (`parentId` and `replyId` are the post id) for every matching account when `auth` is set (otherwise bell subscribers) and enqueue a `/notifications` Web Push (`tag` `forum_post:<postId>`) when `pushStore` is set. Matching uses `wantsNotification`: `isActive` is `created.sats > 0`, `mentionedAccountId` is null (top-level posts are never personal), `actorIsStaff` from the actor in `auth.listAccounts()` (false if missing). When `auth` is unset, do not filter by level. Missing `pushStore` still writes in-app rows when `auth` is set. May throw; callers wrap so persist still succeeds.
- **Inputs:** `{ notifications?, pushStore?, auth?, account, created, inboxUnreadCount? }`.
- **Returns / side effects:** Void. Calls `fanoutToBellSubscribers` with skip id `account.id`, match from the post, and payload from `buildForumPushPayload(created.id)`. Forwards `inboxUnreadCount`. Outbox JSON `unreadCount` is notification unread + listed inbox unread when either source is passed.
- **Used by:** `messagesRoutes` after a successful top-level `POST /messages` create; `ensureProfileMessage` after a profile-note insert; `meRoutes` after a won `PUT /me/about` create (`notifyForumPost` after `updateText` with the bio).

## Function: notifyForumReply

- **Purpose:** Notify living-room members of a forum reply except the actor. Persist a `forum_reply` row when `notifications` is set and enqueue a `/notifications` Web Push (`tag` `forum_reply:<replyId>`, not the parent id) when `pushStore` is set. No-op when the parent is missing. Damus-only parents and self-replies still fan out (the actor is skipped). Photo-only empty text still notifies. Matching uses `wantsNotification`: `isActive` is `parent.sats > 0`, `mentionedAccountId` is `parent.accountId` (null when the parent has no account), `actorIsStaff` from the reply actor. When `auth` is unset, do not filter by level. Missing `pushStore` still writes in-app rows when `auth` is set. Unique duplicate create is fine. May throw; callers wrap so persist still succeeds.
- **Inputs:** `{ messages, notifications?, pushStore?, auth?, account, created, parentId, inboxUnreadCount? }`.
- **Returns / side effects:** Void. After parent lookup, calls `fanoutToBellSubscribers` with skip id `account.id`, match from the parent/actor, and payload from `buildReplyPushPayload(created.id)`. Forwards `inboxUnreadCount`. Outbox JSON `unreadCount` is notification unread + listed inbox unread when either source is passed. Does not copy DMs into notification rows.
- **Used by:** `messagesRoutes` after a 21.gifts-author reply `POST /messages`; `runNostrWorkerTick` after inbound member reply persist; `invoiceRoutes` / `POST /invoices/proof` platform gift-reply.

## Function: notifyZap

- **Purpose:** Notify living-room members of a newly indexed zap/payment except the payer. Persist a `zap` row when `notifications` is set (`text` is `String(amountSats)`, name default `'Someone'`, `replyId` is the first 32 hex of the 64-hex receipt id hyphenated 8-4-4-4-12) and enqueue a `/notifications` Web Push (`tag` `zap:<replyId>`) when `pushStore` is set. No-op when the note has no `accountId`. Does not skip the note author unless they are also `payerAccountId`. Matching uses `wantsNotification`: `isActive` is `note.sats > 0` or `amountSats > 0` (first gift still counts), `mentionedAccountId` is `note.accountId`, `actorIsStaff` from the payer when `payerAccountId` is found (otherwise false). When `auth` is unset, do not filter by level. Missing `pushStore` still writes in-app rows when `auth` is set. May throw; callers wrap so persist still succeeds.
- **Inputs:** `{ notifications?, pushStore?, auth?, note, receiptId, amountSats, nowMs, payerAccountId?, payerName?, inboxUnreadCount? }`.
- **Returns / side effects:** Void. Calls `fanoutToBellSubscribers` with skip id `payerAccountId ?? null`, match from the note/payer, and payload from `buildZapPushPayload(replyId)`. Forwards `inboxUnreadCount`. Outbox JSON `unreadCount` is notification unread + listed inbox unread when either source is passed.
- **Used by:** Zap ingest in `indexOpenZapReceipts` when `indexZapReceipt` newly indexed a receipt.

## Function: notifyModeratorAppointed

- **Purpose:** Targeted to the **subject only**, not a living-room fan-out. Does not call `fanoutToBellSubscribers`. Persist a `moderator_appointed` row when `notifications` is set (`parentId` and `replyId` = `subject.id`, `text` `''`, `name` is `actor.name ?? 'Someone'`, `actorAccountId` is `actor.id`, `readAt` null) and enqueue a `/welcome` Web Push (`type: 'forum'`, `messageId: subject.id`, tag `moderator_appointed:<subjectId>`) when `pushStore` is set. Missing both stores is a no-op. Unique duplicate create is fine (store returns existing). May throw (`push.fanout.failed`); callers wrap so persist still succeeds.
- **Inputs:** `{ notifications?, pushStore?, subject, actor, nowMs, inboxUnreadCount? }`.
- **Returns / side effects:** Void. Writes one in-app row for the subject when `notifications` is set. When `pushStore` is set, enqueues one outbox row with payload from `buildModeratorAppointedPushPayload(subject.id)` (url `/welcome`, tag `moderator_appointed:<subjectId>`). Outbox JSON `unreadCount` is notification unread + listed inbox unread when either source is passed.
- **Used by:** `trustRoutes` `POST /trust/confirm-moderator` and `POST /trust/appoint-moderator` after every 200 that leaves/keeps the subject as `moderator` (new grant **and** idempotent already-moderator same-actor 200). Failure logs `push.enqueue.failed`; HTTP still 200.

## Function: parseNotificationLevel

- **Purpose:** Map a stored or request value to the owner fan-out enum so omitted and unknown strings keep current every-account behaviour. Accepts only the strings `all`, `active`, and `mentions`; any other input (number, null, undefined, object, unknown string) becomes `all`.
- **Inputs:** `raw` unknown (DB text, JSON body, omitted field).
- **Returns / side effects:** `NotificationLevel`. No I/O.
- **Used by:** `mapAccount`, `serializeOwnerAccount`, `fanoutToBellSubscribers` via `filterIdsByMatch`.

## Function: isStaffAccount

- **Purpose:** True when this account is a staff/admin actor for `mentions` fan-out. `role` `founder` or `moderator` is staff. `isPlatform === true` is staff even when `role` is `basis`. `verified` is not staff. Does not parse display names or @mentions out of post text.
- **Inputs:** `{ role: string; isPlatform?: boolean }`.
- **Returns / side effects:** boolean. No I/O.
- **Used by:** `notifyForumPost`, `notifyForumReply`, `notifyZap` via `actorIsStaffFromAuth`.

## Function: wantsNotification

- **Purpose:** Whether a recipient at `level` should receive this living-room event for in-app rows and Web Push. `all` is always true. `active` is `isActive`. `mentions` is a staff actor or `mentionedAccountId === recipientAccountId` when the mention id is non-null.
- **Inputs:** `{ level: NotificationLevel; actorIsStaff: boolean; isActive: boolean; mentionedAccountId: string | null; recipientAccountId: string }`.
- **Returns / side effects:** boolean. No I/O.
- **Used by:** `fanoutToBellSubscribers` after skip when `auth` and `match` are set.

## Function: conversationPushRecipientIds

- **Purpose:** 21.gifts account ids to Web-Push for a private-message (unique, no null, never the sender). Damus inbound (`senderAccountId === null`) notifies `accountA`; a member send on `member_damus` notifies nobody. `member_member` / `member_platform` notify the other of `accountA` / `accountB` when that id is a string and not the sender. `moderator_group` notifies `moderatorIds` except the sender (not `accountA` / platform).
- **Inputs:** `ConversationThread`, `senderAccountId` (`string | null`), optional `moderatorIds` (`readonly string[]`, default `[]`; used only for `moderator_group`).
- **Returns / side effects:** `string[]`. No I/O.
- **Used by:** `notifyConversationMessage`.

## Function: inboxUnreadCountFor

- **Purpose:** Build the fan-out `inboxUnreadCount` callback: listed GET `/conversations` unread for one account. Staff from `getAccount` + `isStaffRole`; `moderator` when `role === 'moderator'` (so `moderator_group` counts); platform id from `listAccounts` / `isPlatform`. Lookup failure yields staff false, moderator false, and `platformId` null.
- **Inputs:** `ConversationStore`, `Pick<AuthStore, 'getAccount' | 'listAccounts'>`.
- **Returns / side effects:** `(accountId) => Promise<number>` calling `conversations.unreadCount`.
- **Used by:** `notifyConversationMessage`; `notifyForumPost` / `notifyForumReply` / `notifyZap` / `notifyModeratorAppointed` callers that have a conversation store (`messagesRoutes`, `meRoutes`, `invoiceRoutes`, `ensureProfileMessage`, `indexOpenZapReceipts`, `runNostrWorkerTick`, `trustRoutes`).

## Function: notifyConversationMessage

- **Purpose:** Enqueue one `type: 'conversation'` Web Push per 21.gifts recipient with at least one `push_subscription`. No-op when `pushStore` is omitted. Does not write in-app Notification rows. Payload from `buildConversationPushPayload` plus `unreadCount` = notification unread + listed inbox unread (missing source 0). `messageId` is the conversation message UUID. For `moderator_group`, recipients are other `role === 'moderator'` accounts from `listAccounts`. Per-recipient failures log `conversations.push.failed` and continue; throws after the loop when any failed. Callers still catch so HTTP/Nostr ingest stays 200.
- **Inputs:** `{ pushStore?, notifications?, conversations, authStore, thread, message, nowMs }`.
- **Returns / side effects:** Void. Skip recipients with zero subscriptions. Title is `message.name` or `21.gifts` when empty. URL `/messages?c=<conversationId>`. Tag `conversation:<conversationId>`.
- **Used by:** `conversationRoutes` `POST /:id`; `contactRoutes` after conversation append; `indexInboundDirectMessages` after inbound persist.

## Function: serializeConversationMessage

- **Purpose:** Project a stored conversation message to its public JSON shape.
- **Inputs:** `ConversationMessageRow`, `fromMe` boolean.
- **Returns / side effects:** `{ id, name, text, createdAt, fromMe, sats, accountId? }`. `sats` is the message amount (`0` when unpaid). Includes `accountId` from `senderAccountId` when that value is a non-empty string; omits the key when it is null or empty. Omits event ids, `senderAccountId`, and `senderPubkey`. No I/O.
- **Used by:** `conversationRoutes`.

## Function: conversationFromMe

- **Purpose:** Viewer-relative direction for a stored sender: true when the sender is the session account, or when staff is acting as the platform identity that sent the message.
- **Inputs:** `{ senderAccountId, viewerId, staff, platformId }`. `senderAccountId` null (empty thread / Damus inbound) is false.
- **Returns / side effects:** boolean. No I/O.
- **Used by:** `conversationRoutes` (list `lastFromMe`, thread `fromMe`); `conversationIsInbound`.

## Function: conversationIsInbound

- **Purpose:** Whether a stored sender is inbound for the viewer (not the viewer, and not staff-as-platform). Null Damus sender is inbound.
- **Inputs:** `{ senderAccountId, viewerId, staff, platformId }`.
- **Returns / side effects:** `!conversationFromMe(args)`. No I/O.
- **Used by:** `InMemoryConversationStore.hasInboundMessage`.

## Function: unsignedConversationDefaults

- **Purpose:** Unsigned/pending defaults for a locally persisted conversation message.
- **Inputs:** none.
- **Returns / side effects:** `{ sats: 0, eventId: null, nostrPublishState: 'pending', nostrEvent: null, claimedUntil: null }`.
- **Used by:** `contactRoutes`, `conversationRoutes`, `indexOpenZapReceipts`, `runNostrWorkerTick` (inbound conversation persist).

## Function: moderatorGroupDisplayName

- **Purpose:** Fixed display name for the closed moderator-group thread.
- **Inputs:** `kind` (`ConversationKind`).
- **Returns / side effects:** `'Moderators'` when `kind === 'moderator_group'`; otherwise `null`. No I/O.
- **Used by:** `counterpartName` in `conversationRoutes`.

## Function: wrapNip17

- **Purpose:** Wrap plaintext as a NIP-17 kind:1059 gift wrap (rumor kind:14) using `nostr-tools`.
- **Inputs:** sender 32-byte secret, recipient hex pubkey, text.
- **Returns / side effects:** Signed kind:1059 event. Never logs the secret.
- **Used by:** Nostr worker outbound DMs.

## Function: unwrapNip17

- **Purpose:** Unwrap a NIP-17 kind:1059 wrap to sender pubkey, plaintext, and rumor `created_at`.
- **Inputs:** wrap event, recipient 32-byte secret.
- **Returns / side effects:** `{ senderPubkey, text, createdAt }` or `null` on failure / non-kind-14 rumor / missing rumor `created_at`. `createdAt` is the rumor unix time (not the wrap). Never logs the secret.
- **Used by:** Nostr worker inbound DMs.

## Function: encryptKind4

- **Purpose:** NIP-04 encrypt plaintext for a legacy kind:4 DM.
- **Inputs:** sender secret, recipient hex pubkey, text.
- **Returns / side effects:** Ciphertext string. Never logs the secret.
- **Used by:** Tests; inbound path uses `decryptKind4`.

## Function: decryptKind4

- **Purpose:** NIP-04 decrypt kind:4 content.
- **Inputs:** recipient secret, sender hex pubkey, ciphertext.
- **Returns / side effects:** Plaintext or `null` on failure. Never logs the secret.
- **Used by:** Nostr worker inbound kind:4 DMs.

## Function: serializeContact

- **Purpose:** Project a stored contact row to its public JSON shape.
- **Inputs:** `ContactRow` (includes `accountId`).
- **Returns / side effects:** `{ id, name, text, createdAt }` with ISO-8601 `createdAt`; `accountId` omitted. No I/O.
- **Used by:** `contactRoutes`.

## Function: serializeDebugContact

- **Purpose:** Project a stored contact row to its operator debug JSON shape.
- **Inputs:** `ContactRow`.
- **Returns / side effects:** `{ id, accountId, name, text, createdAt }` with ISO-8601 `createdAt`. No I/O.
- **Used by:** `debugContactsRoutes`.

## Function: normalizeLightningAddress

- **Purpose:** Trims and validates `local@domain` LUD-16 shape. Case is preserved.
- **Inputs:** `raw` string.
- **Returns / side effects:** Trimmed address or `null`.
- **Used by:** me lightning-address POST, public resolve, GET /invoices/passkey, and POST /invoices.

## Function: parseBindAddr

- **Purpose:** Parses `host:port` bind spec.
- **Inputs:** `addr` string.
- **Returns / side effects:** `{ host, port }`. Throws on garbage.
- **Used by:** `index.ts` boot.

## Function: randomHex

- **Purpose:** CSPRNG hex for session tokens, passkey challenge ids, and verification nonces.
- **Inputs:** `byteLength`.
- **Returns / side effects:** Lowercase hex.
- **Used by:** `issueSession`, passkey begin, verification nonce.

## Function: readPublicBrandFile

- **Purpose:** Reads `public/<name>` relative to a root directory.
- **Inputs:** `BrandFileName` and optional `root` (default `process.cwd()`).
- **Returns / side effects:** `Uint8Array` or `null` if missing. Does not change the process cwd.
- **Used by:** Default `brandRoutes` reader.

## Function: requestLog

- **Purpose:** Hono middleware: `http.request` JSON after the handler. Skips `/healthz` and OPTIONS. Never logs the query string. Path is passed through `requestLogPath` so `/view/<segment>` is redacted.
- **Inputs:** None.
- **Returns / side effects:** `MiddlewareHandler`.
- **Used by:** `createApp`.

## Function: requestLogPath

- **Purpose:** Redact the first `/view/<segment>` to `/view/:viewKey` so request logs never print the durable capability secret. Trailing slashes and extra segments keep the suffix. `/view` alone and unrelated routes are unchanged.
- **Inputs:** Path string without the query string.
- **Returns / side effects:** Redacted or original string. No I/O.
- **Used by:** `requestLog`.

## Function: requestPayInvoice

- **Purpose:** LNURL-pay: fetch metadata, then GET the callback with `amount` and optional `comment` query params (LUD-06), return bolt11.
- **Inputs:** `RequestPayInvoiceArgs`.
- **Returns / side effects:** `LnurlPayResult`.
- **Used by:** Verification payer path when a real InvoicePayer is wired; app donate uses the browser equivalent.

## Function: resolveAllowedOrigins

- **Purpose:** CORS allow-list from `CORS_ALLOWED_ORIGINS` or the built-in apex, transitional app-subdomain, and localhost origins.
- **Inputs:** `env` record.
- **Returns / side effects:** string[] of origins.
- **Used by:** `createApp` CORS.

## Function: resolveBindAddr

- **Purpose:** BIND_ADDR from env with default `0.0.0.0:3000`.
- **Inputs:** optional override, env.
- **Returns / side effects:** Address string.
- **Used by:** `index.ts`.

## Function: resolveLnurlp

- **Purpose:** GET `https://domain/.well-known/lnurlp/local` and parse metadata.
- **Inputs:** address + fetchImpl.
- **Returns / side effects:** Callback URL, min/max sendable, optional NIP-57 `allowsNostr` / `nostrPubkey`, or error.
- **Used by:** `lightningAddressRoutes`, `POST /me/lightning-address` (`meRoutes`), `requestPayInvoice`, `requestGiftInvoice`, `requestZapInvoice`.

## Function: resolveSession

- **Purpose:** Looks up a bearer session; rejects expired.
- **Inputs:** `store`, `now`, `token`.
- **Returns / side effects:** `Account` or `null`.
- **Used by:** `meRoutes`.

## Function: startVerification

- **Purpose:** Pays a 1-sat LNURL-pay invoice to the linked address and stores a nonce.
- **Inputs:** `StartVerificationArgs` (store, payer, fetch, accountId, now).
- **Returns / side effects:** Sent result or a `StartVerificationCode` (no address, payer down, …).
- **Used by:** `POST /me/lightning-address/verification`.

## Function: credentialIdFrom

- **Purpose:** Reads the WebAuthn credential `id` from an untyped finish body.
- **Inputs:** Unknown `credential` JSON.
- **Returns / side effects:** Non-empty string id, or `null`.
- **Used by:** `finishPasskeyAuthentication`.

## Function: expectedOriginsForRpId

- **Purpose:** Filters CORS origins to those whose hostname equals the RP ID, or `app.<rpId>` (no general subdomain suffix).
- **Inputs:** `rpId`, `allowedOrigins`.
- **Returns / side effects:** Matching origin strings; invalid URLs dropped.
- **Used by:** `resolveWebAuthnConfig`.

## Function: finishPasskeyAuthentication

- **Purpose:** Verifies a discoverable-credential assertion, CAS-updates signCount, issues a session only when the CAS succeeds. Optional `nostr` best-effort backfills a missing nsec.
- **Inputs:** store, ceremony, config, now, Origin, challengeId, credential, optional `nostr`.
- **Returns / side effects:** `{ ok: true, value: { token, account } }` or `{ ok: false, error }`. CAS failure is `{ ok: false, error: 'Invalid passkey' }`.
- **Used by:** `POST /auth/passkey/authenticate/finish`.

## Function: finishPasskeyRegistration

- **Purpose:** Verifies an attestation and issues a session. When the challenge account id already exists (claim path), binds the credential to that provisioned row without `createAccount` and never `deleteAccount` on failure. When the account is new, creates a `linkingKey: null` account plus credential; optional `nostr` mints a custodial nsec (rollback on keygen failure) and a duplicate credential id rolls the new account back.
- **Inputs:** store, ceremony, config, now, Origin, challengeId, credential, optional `nostr`.
- **Returns / side effects:** `{ ok: true, value: { token, account } }` or `{ ok: false, error }`. Claim-path credential race → `{ ok: false, error: 'Invalid passkey' }` with the provisioned account left intact. Nostr keygen failure on claim is best-effort (same as authenticate): session still issues.
- **Used by:** `POST /auth/passkey/register/finish`.

## Function: issueSession

- **Purpose:** Mints a bearer session token for an already-authenticated account.
- **Inputs:** `store`, `now`, `account`.
- **Returns / side effects:** `{ token, account }`; writes the session row.
- **Used by:** passkey finish paths and `POST /debug/accounts/:id/session`.

## Function: normalizeWebAuthnRpId

- **Purpose:** Trims `WEBAUTHN_RP_ID`; missing/blank/unknown is `null` (only `21.gifts` / `dev.21.gifts` / `localhost`; fail closed on passkey routes).
- **Inputs:** Raw env string or `undefined`.
- **Returns / side effects:** Trimmed RP ID or `null`.
- **Used by:** `resolveWebAuthnConfig`.

## Function: resolveWebAuthnConfig

- **Purpose:** Builds RP ID, RP name, and expected origins for passkey ceremonies.
- **Inputs:** env slice (`WEBAUTHN_RP_ID`, optional `WEBAUTHN_RP_NAME`) and CORS origins.
- **Returns / side effects:** `WebAuthnRuntimeConfig` or `null` when unconfigured.
- **Used by:** `authRoutes` passkey handlers.

## Function: SimpleWebAuthnPasskeyCeremony

- **Purpose:** Production `PasskeyCeremony` wrapping `@simplewebauthn/server` (residentKey + userVerification required).
- **Inputs:** Generate/verify methods take RP/user fields or browser JSON plus stored credential material.
- **Returns / side effects:** Options JSON + challenge, or `{ ok: false, reason }` on verify failure.
- **Used by:** `createApp` default `passkeyCeremony`.

## Function: startPasskeyAuthentication

- **Purpose:** Mints discoverable-credential request options (`allowCredentials` empty).
- **Inputs:** store, ceremony, config, now.
- **Returns / side effects:** `{ challengeId, options }`; persists a passkey challenge.
- **Used by:** `POST /auth/passkey/authenticate/begin`.

## Function: startPasskeyRegistration

- **Purpose:** Mints WebAuthn creation options and a pending account UUID (row created only on finish). Display name is always `21.gifts`.
- **Inputs:** store, ceremony, config, now.
- **Returns / side effects:** `{ challengeId, options }`; persists a passkey challenge.
- **Used by:** `POST /auth/passkey/register/begin` when the body has no string `viewKey`.

## Function: startPasskeyClaim

- **Purpose:** Mints WebAuthn creation options for an existing operator-provisioned account identified by `viewKey`. Uses the stored account id and `account.name` (or `21.gifts` when null) as the WebAuthn user entity.
- **Inputs:** store, ceremony, config, now, viewKey.
- **Returns / side effects:** `{ ok: true, value: { challengeId, options } }` or `{ ok: false, error }` (`This profile could not be found.` / `This profile already has a passkey`). Persists a register challenge bound to the existing account id.
- **Used by:** `POST /auth/passkey/register/begin` when the body includes a string `viewKey`.

## Function: accountSetup

- **Purpose:** Next owner wizard step from stored account fields. Skip timestamps count as completing that step. The api is the source of truth; clients only route.
- **Inputs:** `Account`.
- **Returns / side effects:** `'name'` when name is null/blank and `nameSkippedAt` is unset, else `'lightning-address'` when Lightning Address is null/blank and `lightningAddressSkippedAt` is unset, else `'rules'` when `rulesAgreedAt` is null, else `null`. No I/O.
- **Used by:** `serializeOwnerAccount`.

## Function: accountMissing

- **Purpose:** Factually unset account fields for action gates. Skip timestamps do not clear a field from this list.
- **Inputs:** `Account`.
- **Returns / side effects:** `AccountMissingField[]` in order `name`, `lightning-address`, `rules` (only those that are null/blank or rules unset). No I/O.
- **Used by:** `serializeOwnerAccount`, `requireAction`.

## Function: actionRequirements

- **Purpose:** Declare which account fields an action needs before it may proceed.
- **Inputs:** `AccountAction` (`forum.read` \| `forum.post` \| `contact.post` \| `forum.pay`).
- **Returns / side effects:** Readonly list in 409 order: `forum.read` → `rules`; `forum.post` → `rules`, `name`, `lightning-address`; `contact.post` → `rules`, `name`; `forum.pay` → `rules`. No I/O.
- **Used by:** `requireAction`.

## Function: requireAction

- **Purpose:** Gate a signed-in action on factual account fields (skip does not satisfy). Filters `accountMissing` to the action's needs, preserving `actionRequirements` order.
- **Inputs:** `Account`, `AccountAction`.
- **Returns / side effects:** `{ ok: true }` or `{ ok: false, missing }` (never empty). No I/O. Routes respond 409 `{ error: 'missing_requirements', missing }` when `ok` is false.
- **Used by:** `messagesRoutes`, `contactRoutes`, `membersRoutes`.

## Function: ensureProfileMessage

- **Purpose:** Ensure a named account with a non-blank Lightning Address has exactly one live top-level profile forum note. No-ops when name or Lightning Address is null/blank after trim. When both are set, the first insert creates one message (kind:1 pipeline defaults, frozen tags only) and claims `profileMessageId` via `claimProfileMessageId` (set only while the pointer still matches the missing/hidden read). Rename is idempotent and does not change note text. Recreates when the stored id is missing or the row is soft-hidden (`deletedAt` set). A live `profileMessageId` winner is adopted and the insert is deleted; a hidden winner is missing — the created live note is kept and `profileMessageId` is claimed onto it. A lost claim deletes the insert and adopts a live winner when one exists. Rolls back the insert if the claim throws. A successful won claim whose confirmation still points at the created note calls `notifyForumPost` (in-app rows via `auth.listAccounts()` except the actor, then filtered by each account's `notificationLevel`; Web Push via `pushStore` when set, same filter).
- **Inputs:** `{ auth, messages, account, now, pushStore?, notifications?, conversations? }`.
- **Returns / side effects:** The account (possibly with `profileMessageId` set). May insert a message and claim the pointer; may delete an orphaned insert on claim failure, a vanished row, or a later live `profileMessageId` winner.
- **Used by:** `meRoutes` (`POST /me/name`, `POST /me/lightning-address`), `debugRoutes` provision, Nostr worker backfill.

## Function: serializeAccount

- **Purpose:** Project an account to the ten-field dump without `viewKey` or `isPlatform` (no Nostr fields).
- **Inputs:** `Account`.
- **Returns / side effects:** Ten public fields (`id`, `linkingKey`, `role`, `name`, `location`, `lightningAddress`, `lightningAddressVerified`, `forumLawsDismissed`, `createdAt`, `rulesAgreedAt`). `location` is `string | null` (never omitted, never `""`). No I/O. No Nostr key material.
- **Used by:** `serializeOwnerAccount` (member `/me`) and `serializeDebugAccount`.

## Function: serializeDebugAccount

- **Purpose:** Operator account JSON: the ten public fields plus `isPlatform`. Never used by member `GET /me`.
- **Inputs:** `Account`.
- **Returns / side effects:** `DebugAccountResponse`. `isPlatform` is true only when the stored flag is true. No `viewKey`. No I/O.
- **Used by:** `GET /debug/accounts` and `PATCH /debug/accounts/:id`.

## Function: aboutMeFromNote

- **Purpose:** Map profile-note text to the public About me field. Empty text is not a bio. When the trimmed text equals the trimmed display name case-insensitively, the auto name-copy is not a bio (`null`). When the trimmed text equals the profile note's stored `name` case-insensitively (and that stored name is non-empty), it is also unfilled — so Ada→Grace with note text still `Ada` stays `null`.
- **Inputs:** `name` (`string | null`), `text` (`string | null`), optional `storedNoteName` (`string | null`, default `null`). Production serializers that have a live `MessageRow` pass `row.name`.
- **Returns / side effects:** Trimmed bio string, or `null`. No I/O.
- **Used by:** `serializeOwnerAccountWithPosts`, `viewRoutes`, `membersRoutes`.

## Function: serializeOwnerAccount

- **Purpose:** Owner JSON for authenticated account responses: the ten public fields (including location) plus `viewKey`, `setup`, `missing`, `hasPosted`, `aboutMe`, `aboutMeHasPhoto`, and `notificationLevel` (`all` / `active` / `mentions`, default `all`, owner-only), so the owner can copy the capability URL and the client can route onboarding, action gates, the introduce-yourself popup, About me photo display, and living-room notify filter. Used by `GET /me`, `/me` writes including `POST /me/rules-agreement`, `POST /me/setup/skip`, `POST /me/location`, `POST /me/notification-level`, and `PUT /me/about`, and passkey finish — never by the debug listing. Does not expose `profileMessageId`.
- **Inputs:** `Account` plus `hasPosted: boolean` plus `aboutMe: string | null` plus `aboutMeHasPhoto: boolean`.
- **Returns / side effects:** `OwnerAccountResponse` (seventeen fields including `hasPosted`, `location`, `aboutMe`, `aboutMeHasPhoto`, and `notificationLevel`). No I/O. Does not expose `profileMessageId`.
- **Used by:** `serializeOwnerAccountWithPosts`.

## Function: serializeOwnerAccountWithPosts

- **Purpose:** Async owner JSON with live-post lookup and profile-note About me. Calls `accountHasLivePost(account.id, account.profileMessageId ?? null)`, loads the profile note via `getById` when `profileMessageId` is non-blank, then `serializeOwnerAccount` so HTTP callers cannot drift. `aboutMe` is `null` when the profile note is missing or `deletedAt` is set (`getById` still returns soft-hidden rows; the serializer requires `row.deletedAt === null` — see `src/lib/auth/account-json.ts` 221: `if (row !== undefined && row.deletedAt === null)`). A live row passes `aboutMeFromNote(account.name, row.text, row.name)` so auto name-copy stays unfilled after a display-name rename, and `aboutMeHasPhoto` from `row.hasPhoto === true`. Overlay `hasPosted` (`GET /me`) uses `accountHasLivePost` (replies count) and is **not** the spend/invoice predicate. Spend eligibility is `accountHasLiveTopLevelPost` / `GET /invoices/posted`.
- **Inputs:** `Account`, `Pick<MessageStore, 'accountHasLivePost' | 'getById'>`.
- **Returns / side effects:** `OwnerAccountResponse` including `hasPosted`, `aboutMe`, `aboutMeHasPhoto`, and `notificationLevel`. Overlay lookup is `accountHasLivePost`; spend/invoice lookup is `accountHasLiveTopLevelPost`. Store throw is unhandled.
- **Used by:** `meRoutes` and `authRoutes`.

## Function: membersRoutes

- **Purpose:** Hono sub-app for `GET /members/:accountId`, `GET /members/:accountId/activity`, `GET /members/:accountId/posts`, and `GET /members/:accountId/replies`. Bearer + `requireAction(forum.read)` on all; UUID path. Profile card is live identity plus optional `profileMessage` via `serializeMessage`, derived `aboutMe`, `aboutMeHasPhoto` (true when the live profile note has a stored photo; false when `profileMessage` is null), uncapped live `postCount` / `replyCount` from `countByAccount`, and `trust` via `accountTrust`. Activity is given/received sats for that member (`buildAccountActivity`). Posts is live-only top-level notes newest-first (cap 200, same serialize as signed-in `GET /messages` including `accountId` / `replyCount` / `payable`; omits `parentId`; missing-file `hasVideo` direct replies are deleted and subtracted from `replyCount`). Replies is live-only member replies newest-first (cap 200, `payable` when a non-empty `eventId` and a non-blank Lightning Address are set, optional `parentId`, no `replyCount`; a child that cannot serialize is omitted, siblings still 200).
- **Inputs:** `MembersRouteDeps` (`authStore`, `messageStore`, required `trustStore`, `now`, optional `giftStore`, `rates`, and `fiatRates` used by `GET /:accountId/activity`; missing fiat never 503).
- **Returns / side effects:** Hono app mounted at `/members`. Activity is 200 JSON or 503 `{ error: 'Gift stats are unavailable' }` on store throw or missing BTC-USD. Missing fiat never 503. Logs `members.get.failed`, `members.posts.failed`, `members.replies.failed`, or `account.activity.failed` on 503. Activity 503 logs `account.activity.failed` / `account.activity.fx_incomplete`. GET JSON includes `aboutMe` and `aboutMeHasPhoto`.
- **Used by:** `createApp`.

## Function: serializeViewProfile

- **Purpose:** Public profile card for the capability URL. Eight fields (`name`, `location`, `lightningAddress`, `lightningAddressVerified`, `createdAt`, `hasPasskey`, `aboutMe`, `aboutMeHasPhoto`). Omits `id`, `linkingKey`, `role`, and `viewKey`. `location` is `string | null` (never omitted, never `""`).
- **Inputs:** `Account`, `hasPasskey: boolean`, `aboutMe: string | null`, `aboutMeHasPhoto: boolean`.
- **Returns / side effects:** `ViewProfileResponse`. No I/O.
- **Used by:** `viewRoutes`.

## Function: parseNostrKek

- **Purpose:** Parse `NOSTR_NSEC_KEK` as 32-byte AES key (64 lowercase hex).
- **Inputs:** Env string or `undefined`.
- **Returns / side effects:** `Uint8Array` or throw.
- **Used by:** `openBootStores`.

## Function: hexToBytes

- **Purpose:** Decode lowercase hex.
- **Inputs:** Even-length hex string.
- **Returns / side effects:** Bytes or throw.
- **Used by:** Tests and KEK helpers.

## Function: bytesToHex

- **Purpose:** Encode bytes as lowercase hex.
- **Inputs:** `Uint8Array`.
- **Returns / side effects:** Hex string.
- **Used by:** Tests.

## Function: publicKeyHexFromSecret

- **Purpose:** Derive NIP-01 hex pubkey.
- **Inputs:** 32-byte secret.
- **Returns / side effects:** 64-char hex.
- **Used by:** `ensureAccountNostrKey`.

## Function: encryptNostrSecret

- **Purpose:** AES-256-GCM envelope for a 32-byte nsec.
- **Inputs:** secret, kek, accountId, optional kekId.
- **Returns / side effects:** Envelope bytes.
- **Used by:** `ensureAccountNostrKey`.

## Function: decryptNostrSecret

- **Purpose:** Decrypt a v1 envelope (`kek_id=1` only).
- **Inputs:** envelope, kek, accountId.
- **Returns / side effects:** 32-byte secret.
- **Used by:** `signEventForAccount`.

## Function: zeroizeSecret

- **Purpose:** Overwrite a secret buffer with zeros.
- **Inputs:** `Uint8Array`.
- **Returns / side effects:** In-place fill.
- **Used by:** `ensureAccountNostrKey`, `signEventForAccount`.

## Function: ensureAccountNostrKey

- **Purpose:** Generate and store a custodial keypair if missing (CAS).
- **Inputs:** AuthStore, accountId, kek, optional keygen.
- **Returns / side effects:** Hex pubkey. Logs `nostr.keygen`.
- **Used by:** Worker, authenticate-finish.

## Function: generateNostrKeyRecord

- **Purpose:** Build a `NostrKeyRecord` for register-finish.
- **Inputs:** accountId, kek, optional keygen.
- **Returns / side effects:** Record for `setNostrKeyIfAbsent`.
- **Used by:** `finishPasskeyRegistration`.

## Function: kind1Tags

- **Purpose:** Copy frozen kind:1 tags. Optional extra lowercase `t` names are inserted after `t=21gifts` and before `r`. `bitcoin` / `21gifts` and duplicate extras are skipped. No-arg call still returns the original three tags.
- **Inputs:** optional `extraT` (readonly string array, default empty; already lowercase, no `#`).
- **Returns / side effects:** `[["t","bitcoin"],["t","21gifts"],["r","https://21.gifts"]]` plus any extra `t` rows.
- **Used by:** `buildKind1Event`.

## Function: kind1HasHashtag

- **Purpose:** Case-insensitive check that kind:1 content already contains `#name` as a hashtag token (next character must not be `[A-Za-z0-9_]`; the `#` prefix distinguishes `#21gifts` from `https://21.gifts`).
- **Inputs:** content string, hashtag name without `#`.
- **Returns / side effects:** True when the token is present; otherwise false.
- **Used by:** `kind1ContentWithHashtags`.

## Function: kind1ContentWithHashtags

- **Purpose:** Append any missing Damus-visible `#bitcoin` / `#21gifts` tokens to Nostr kind:1 content (forum DB `text` stays unchanged), plus optional extra hashtag names without `#` after `#bitcoin #21gifts` when missing. Empty → `"#bitcoin #21gifts"`; non-empty strips trailing newlines then appends `\n\n` + missing tags in fixed order; a tag is present when `kind1HasHashtag` matches (`#bitcoiners` is not `#bitcoin`). One-arg behaviour is unchanged.
- **Inputs:** content string; optional `extraHashtags` (readonly string array of names without `#`).
- **Returns / side effects:** content with missing hashtags appended.
- **Used by:** `buildKind1Event`; `listSignedMissingHashtags` (in-memory helper).

## Function: forumPhotoUrl

- **Purpose:** Absolute `GET /messages/:id/photo.jpg` (or `.png` / `.webp`) URL for kind:1 content and `imeta`. The extension matches the stored MIME so Damus treats the URL as an image, not a website.
- **Inputs:** API origin, message id, optional MIME (default JPEG).
- **Returns / side effects:** URL string.
- **Used by:** Worker sign path.

## Function: forumExtraPhotoUrl

- **Purpose:** Absolute extra-still URL `/messages/:id/photo/:index.jpg|.png|.webp` for indices 1–9 so Damus treats the URL as an image. Extension from MIME (default JPEG).
- **Inputs:** API origin, message id, extra still index (1–9), optional MIME (default JPEG).
- **Returns / side effects:** URL string `{apiBase}/messages/{id}/photo/{index}.{ext}`.
- **Used by:** Worker sign path (still branch, `listExtraPhotos` mapped with `i+1`).

## Function: buildKind1Event

- **Purpose:** Unsigned kind:1 for a forum line (top-level or NIP-10 reply). Optional media (`Kind1Photo`: image or video MIME) appends the public URL to content and a NIP-92 `imeta` tag (`url`, `m`, optional `dim`, optional `size`, optional `image` from `posterUrl`). Always ensures Damus-visible `#bitcoin` / `#21gifts` via `kind1ContentWithHashtags`, appending only missing tokens (forum row `text` is not modified). Optional fifth `location?: string | null`: when `locationHashtagName` is non-null, extra content token and `t` tag. Optional sixth `extraPhotos?: readonly Kind1Photo[]`: empty/omitted extras are bit-identical to the five-arg form; non-empty extras append extra URL lines after the first photo URL plus one `imeta` per extra (`url`, `m`, optional dim/size; no poster). Profile notes are skipped by the worker, not this function. When `replyTo` is set, adds NIP-10 `e` (root + reply) and `p` tags after the frozen tags (and optional `imeta`); top-level notes never get `e`/`p`/`q`.
- **Inputs:** content, unix created_at, optional `{ url, mime, posterUrl?, dim?, size? }` (`Kind1Photo`), optional `replyTo?: Kind1ReplyTo` (`noteEventId`, `spaceRelay`, `noteAuthorPubkey`), optional fifth `location?: string | null`, optional sixth `extraPhotos?: readonly Kind1Photo[]`.
- **Returns / side effects:** Unsigned fields (`kind`, `content`, `tags`, `created_at`).
- **Used by:** Worker sign path.

## Function: buildKind0Content

- **Purpose:** Kind:0 JSON without extra whitespace (`name`, `display_name`, `website`, `picture`, `about`, optional `lud16`, optional `nip05`).
- **Inputs:** name, lightningAddress or null, optional nip05 or null, optional `about` (default `'21.gifts'`; worker passes profile-note text when present).
- **Returns / side effects:** JSON string; `picture` is always the 21.gifts icon; `about` is the fourth argument; `lud16` only when address set; `nip05` only when a public identifier is passed.
- **Used by:** `buildKind0Event`, worker `publishProfiles`.

## Function: buildKind0Event

- **Purpose:** Unsigned replaceable kind:0, including optional `nip05` and optional `about`.
- **Inputs:** name, lightningAddress, unix created_at, optional nip05, optional about (default `'21.gifts'`).
- **Returns / side effects:** Unsigned fields.
- **Used by:** Worker `publishProfiles`.

## Function: buildKind10002Event

- **Purpose:** Unsigned NIP-65 relay list.
- **Inputs:** relay URLs, unix created_at.
- **Returns / side effects:** Unsigned fields.
- **Used by:** Worker `publishRelayLists`.

## Function: buildZapProbeRequest

- **Purpose:** Unsigned kind:9734 used only to probe whether a Lightning Address mints a NIP-57 invoice.
- **Inputs:** recipient pubkey, amount msat, relay URLs.
- **Returns / side effects:** Unsigned event template (`p` / `amount` / `relays` only).
- **Used by:** `probeNip57Mint`.

## Function: probeNip57Mint

- **Purpose:** Request a throwaway zap invoice and accept the address only when `description_hash` matches the signed 9734 JSON.
- **Inputs:** LUD-16 address, signer pubkey, sign helper, fetch, optional env.
- **Returns / side effects:** `'ok' | 'not_zap' | 'unreachable'`. Never pays. Never writes `message_invoice`.
- **Used by:** `POST /me/lightning-address`, `POST /debug/accounts`.

## Function: truncatePubkeyDisplay

- **Purpose:** Short npub-style label for Damus authors without a 21.gifts account. Also the public JSON `name` fallback when a stored forum `name` is blank. Empty input → `'npub'`.
- **Inputs:** hex pubkey.
- **Returns / side effects:** Truncated display string.
- **Used by:** Inbound forum replies; conversation display names (`GET /conversations` Damus-only counterparts); `serializeMessage`.

## Function: signEventForAccount

- **Purpose:** Decrypt nsec, `finalizeEvent`, zeroize.
- **Inputs:** store, accountId, kek, unsigned template.
- **Returns / side effects:** Signed event. Never logs the secret.
- **Used by:** Worker, `POST /messages/:id/invoice`.

## Function: isNostrPublishEnabled

- **Purpose:** `NOSTR_PUBLISH === "1"`.
- **Inputs:** env slice.
- **Returns / side effects:** boolean.
- **Used by:** `resolveWriteSet`.

## Function: isNostrPublishPublicEnabled

- **Purpose:** `NOSTR_PUBLISH_PUBLIC === "1"`.
- **Inputs:** env slice.
- **Returns / side effects:** boolean.
- **Used by:** `resolveWriteSet`.

## Function: resolveRelaySpace

- **Purpose:** Durability relay URL.
- **Inputs:** env slice.
- **Returns / side effects:** Trimmed `NOSTR_RELAY_SPACE`, else `NOSTR_RELAY_URL`, else PRD default.
- **Used by:** `resolveWriteSet`, `resolveZapRelays`.

## Function: resolveRelayPublic

- **Purpose:** Public write relay list.
- **Inputs:** env slice.
- **Returns / side effects:** Split `NOSTR_RELAY_PUBLIC` or default three.
- **Used by:** `resolveWriteSet`, `resolveZapRelays`.

## Function: resolveWriteSet

- **Purpose:** Combine flags + URLs for one worker tick.
- **Inputs:** env slice.
- **Returns / side effects:** `{ spaceUrl, publicUrls, publishEnabled, publicEnabled }`.
- **Used by:** Worker publish (`runNostrWorkerTick` / `publishProfiles` / `publishRelayLists` / `publishBatch`).

## Function: writeRelayUrls

- **Purpose:** Space URL plus public URLs when public write is on.
- **Inputs:** resolved write set.
- **Returns / side effects:** URL list for EVENT fan-out.
- **Used by:** Worker publish.

## Function: resolvePublicApiBase

- **Purpose:** HTTP origin for kind:1 photo URLs. Maps `https://21.gifts` → `https://api.21.gifts` and `https://dev.21.gifts` → `https://dev-api.21.gifts`; otherwise the trimmed `PUBLIC_BASE_URL`.
- **Inputs:** env slice.
- **Returns / side effects:** Origin without trailing slash, or empty.
- **Used by:** Worker sign path.

## Function: resolveZapRelays

- **Purpose:** Relays for zap receipt ingest and kind:9734 invoice `relays` tags (space plus public list, independent of `NOSTR_PUBLISH_PUBLIC`).
- **Inputs:** env slice.
- **Returns / side effects:** Space URL first, then unique `resolveRelayPublic` entries.
- **Used by:** `runNostrWorkerTick` ingest; `POST /messages/:id/invoice`.

## Function: utcDayKey

- **Purpose:** UTC `YYYY-MM-DD` from epoch ms.
- **Inputs:** nowMs.
- **Returns / side effects:** Day key.
- **Used by:** `PostRateLimiter`.

## Function: PostRateLimiter

- **Purpose:** In-process post caps (1/10s, 6/h, 20/UTC-day).
- **Inputs:** `allow(accountId, nowMs)`.
- **Returns / side effects:** boolean; idle eviction 48h.
- **Used by:** `POST /messages`.

## Function: InvoiceRateLimiter

- **Purpose:** In-process invoice caps (1/10s, 20/h).
- **Inputs:** `allow(accountId, nowMs)`.
- **Returns / side effects:** boolean.
- **Used by:** `POST /messages/:id/invoice`.

## Function: RecordingPublisher

- **Purpose:** Test fake that records EVENT publishes.
- **Inputs:** event, urls, timeout.
- **Returns / side effects:** ACK list; `ok` flag.
- **Used by:** Worker tests.

## Function: RecordingQuerier

- **Purpose:** Test fake `NostrQuerier` that records REQ calls and returns configured events.
- **Inputs:** `query(filter, urls, timeoutMs)`; tests set `events`.
- **Returns / side effects:** Copied event list; fills `calls`.
- **Used by:** Worker unit tests.

## Function: normalizeSignedEvent

- **Purpose:** Coerce stored/wire signed events (object, JSON string, double-encoded jsonb string) into a plain object so EVENT frames never send a string payload.
- **Inputs:** Unknown value.
- **Returns / side effects:** Shallow-copied object or `null` (arrays, primitives, invalid JSON).
- **Used by:** `WebsocketNostrPublisher.publishOne`; `mapMessageRow`.

## Function: WebsocketNostrPublisher

- **Purpose:** Production `NostrPublisher` that opens one WebSocket per relay URL, runs `normalizeSignedEvent` so the EVENT second element is an object, sends `["EVENT", event]`, and waits for a matching `["OK", id, true|false]` (or timeout/error) before closing.
- **Inputs:** Optional `WebSocketFactory` (default `new WebSocket(url)`); `publish(event, urls, timeoutMs)`.
- **Returns / side effects:** One `RelayAck` per URL in input order; never leaves sockets open after settle. Injectable factory keeps unit tests off the network.
- **Used by:** Process entry `src/index.ts` when KEK + durable message store present.

## Function: WebsocketNostrQuerier

- **Purpose:** Production `NostrQuerier`: one WebSocket per URL, send `["REQ", subId, filter]`, collect EVENT object payloads (id, pubkey, kind, tags, plus content/created_at/sig when present), stop on EOSE/timeout, CLOSE and close socket. Factory throw / error / timeout contribute no events. Dedup by id; first URL in the list wins.
- **Inputs:** Optional `WebSocketFactory`; `query(filter, urls, timeoutMs)`.
- **Returns / side effects:** `NostrEventFrame[]`; never throws; no live subscription past the call.
- **Used by:** `src/index.ts` worker wiring.

## Function: spaceAcked

- **Purpose:** Whether the space relay ACK'd OK.
- **Inputs:** acks, spaceUrl.
- **Returns / side effects:** boolean.
- **Used by:** Worker.

## Function: publicAcked

- **Purpose:** Whether a non-space relay ACK'd OK.
- **Inputs:** acks, spaceUrl.
- **Returns / side effects:** boolean.
- **Used by:** Worker.

## Function: runNostrWorkerTick

- **Purpose:** Each tick starts with zap ingest (`indexOpenZapReceipts`) before resign/sign/publish, so receipt indexing is not delayed by relay publish timeouts: queries zap relays (space plus the public list, even when `NOSTR_PUBLISH_PUBLIC` is off) for kind:9735 and indexes validated forum receipts onto `sats`, even when `NOSTR_PUBLISH` is off. `nowMs` for sign/publish leases is sampled only after `indexOpenZapReceipts` returns, so an overlapping tick cannot reclaim with a later clock while this tick still signs/publishes under a stale lease time. Then signs unsigned rows and fans out when `NOSTR_PUBLISH=1`. Space-only ACK is terminal `published`/`space`. With `NOSTR_PUBLISH_PUBLIC=1`, space-only parks `pending` until a public ACK. Pending kind:1 JSON without `t=bitcoin` is dropped and re-signed, then unsigned rows are signed. After that, published unpaid notes missing a photo URL, a video URL, or Damus `#bitcoin`/`#21gifts` (and, when `account.location` is set, the location hashtag) in content are reset for the next tick (`PUBLIC_BASE_URL` set for media URLs; video posters are not treated as missing photos; `profileMessageId` rows are skipped so a name note is not rewritten with those hashtags; location is never applied to profile notes). Pending rows EVENT as-is so a reset cannot renew the 60s sign lease. Zapped rows keep `eventId`. An empty API base skips photo/video-URL resign. Sign looks up photo bytes even when `hasPhoto` is stale. Each tick runs `backfillProfileMessages` for named accounts with a non-blank Lightning Address missing a profile note. When publishing, also fans out kind:0 profiles (`name` / `display_name` / `picture` / optional `nip05`, `about` from the profile-note text or `21.gifts`) and NIP-65 kind:10002 relay lists. Kind:1 photo/video posts include the public media URL and `imeta`. Extra `imeta` only on the still branch via `listExtraPhotos` mapped with `forumExtraPhotoUrl(..., i+1, mime)` as the 6th `buildKind1Event` arg; video stays exclusive (poster = photo 0, no extras). Each tick also runs `signConversationBatch` (NIP-17 wraps when a conversation store is present) and, when `NOSTR_PUBLISH=1`, `publishConversationBatch`. Zap ingest (`indexOpenZapReceipts`) calls `notifyZap` after every newly indexed forum receipt. It inserts a payer gift-reply after parent `sats` only when the paid row is top-level (`parentId` null). A zap on a signed reply credits that reply; no nested gift-reply. It does not call `notifyForumReply` for that gift-reply. PN / conversation-invoice receipts hit `appendConversationGift` without addSats, without a forum gift-reply, and without `notifyZap`. After publish, `indexInboundForumReplies` (REQ kind:1 `#e` our published note ids, even when publish is off; persists replies through either a member-account pubkey match or an external-zapper entitlement whose pubkey is not blocked and whose `ExternalIngestLimiter` acquisition succeeds; inbound authors satisfying neither path are skipped; after a member reply is stored, `notifyForumReply` always runs with `auth` (in-app every account except the actor, then filtered by each account's `notificationLevel`; Web Push only to bell subscribers, same filter); failures log `nostr.reply.notify.failed` and do not undo persist) and `indexInboundDirectMessages` (REQ kind:1059 / kind:4 to member and platform pubkeys when a conversation store is present).
- **Zap ingest dedupe:** One `nostr_zap_ingest` row is written per receipt per decision change per process (the memory is per store instance and empty after a restart, so the first tick after boot may write one `rejected`/`duplicate` row per receipt that tick still queries (`listLatest` plus non-null `listReplies` children of those rows)). A repeated identical `outcome:reason` is normally not written again, because the memory is consulted before the write; that is not a guarantee, since the memory is set only after the write resolves, worker ticks are not serialised, and a failed write leaves it untouched. Receipts whose remembered decision is terminal (`indexed` or `rejected`/`duplicate`) skip note lookup, account/LNURL/amount validation, and ingest persist. They still run `verifyReceipt` before `tryEnsureGiftReply` (see `indexOpenZapReceipts` Terminal skip).
- **Kind:0 cache:** Unchanged content is not resent for the life of the AuthStore instance. After the live account row is read, the worker stores a reservation object and treats only that object as owner after each await. A nack or throw deletes the reservation only when it is still that object; the last issued `created_at` watermark is kept so a retry in the same second still increments. Kind:0 `created_at` is `max(wall clock, last issued + 1)` so an in-flight older profile cannot win a same-second replaceable-event tie.
- **Kind:0 batch:** At most `WORKER_BATCH` keyed attempts run per tick, including nacks. With public fan-out on, a space-only ACK is a nack and the profile is retried.
- **Inputs:** worker deps.
- **Returns / side effects:** Store updates; logs `nostr.sign.failed` / `nostr.publish.*` / `nostr.profile.ok` / `nostr.profile.nack` / `nostr.relays.ok` / `nostr.relays.nack` / `nostr.dm.sign.failed` / `nostr.dm.publish.*` / `nostr.dm.push.failed` / `nostr.reply.notify.failed`. Event-id collision retries once with `created_at + 1`.
- **Used by:** `startNostrWorker`.

## Function: startNostrWorker

- **Purpose:** Interval handle around `runNostrWorkerTick`.
- **Inputs:** deps, intervalMs.
- **Returns / side effects:** `{ stop }`.
- **Used by:** Process entry `src/index.ts` when KEK + message store present.

## Function: buildZapRequest

- **Purpose:** Unsigned kind:9734 for a forum event.
- **Inputs:** recipient pubkey, event id, amountMsat, relays, optional `content` (NIP-57 comment, default empty).
- **Returns / side effects:** EventTemplate.
- **Used by:** `POST /messages/:id/invoice`.

## Function: manualReceiptIdForPaymentHash

- **Purpose:** Derive the synthetic kind:9735 event id used for an operator manual settlement.
- **Inputs:** Payment-hash text; case is ignored by lowercasing before hashing.
- **Returns / side effects:** Lowercase 64-hex `sha256('21gifts-manual-settle:' + paymentHash.toLowerCase())`; no writes.
- **Used by:** `settleInvoiceManually` and relay ingest's later-receipt double-count guard.

## Function: settleInvoiceManually

- **Purpose:** Settle a successful forum invoice by payment hash after its LNURL provider failed to publish a kind:9735 receipt. The required trimmed `note` (1–500 characters, no C0/DEL controls) is durable operator evidence. `DEBUG_TOKEN` is the route authority; an optional preimage adds cryptographic evidence only when it is 32-byte hex and hashes to the payment hash. It is intentionally optional because some wallet-internal payments expose a wallet “preimage” that does not match the invoice hash.
- **Checks:** Normalises the payment hash, validates the note and optional preimage, requires an `ok` invoice with positive whole sats and non-empty BOLT11, rejects conversation invoices and missing/hidden messages, checks historical indexed ingests, and claims the lowercase payment hash through `claimZapPayment`. A claim owned by another receipt is `duplicate`.
- **Returns / side effects:** On a fresh success returns `{ ok: true, receiptId, messageId, amountSats, resumed: false }`, credits via `recordZapReceipt`, and writes an indexed synthetic 9735 ingest directly through `store.recordZapIngest`. If the synthetic receipt was already credited but its indexed ingest is missing, the current request's note/preimage rebuilds that ingest without another credit, notification and gift-reply processing run, and the result has `resumed: true`. An already complete settle returns `duplicate`.
- **Durability / errors:** The payment-hash claim is a durable tombstone that protects against a second credit even if a prior ingest write failed or the forum message was later deleted. Claim, lookup, credit, and direct ingest-write failures propagate (the route maps them to 503); the decision memory is updated only after the ingest write succeeds. The claim and credit are not one transaction, but the payment-hash primary key serialises competing receipt ids.
- **Post-credit effects:** Fans out `notifyZap` and attempts the payer gift-reply from the original zap request. A throwing `auth.getAccount` is logged as `nostr.zap.gift_reply.failed`, omits payer fields from the notification, skips the gift-reply, and still returns success. Notification and gift-reply failures are likewise logged and suppressed. Logs and responses never contain the note or preimage.
- **Resume on a hidden note:** A fresh settle refuses a missing or hidden note. A retry that finds its synthetic receipt already credited is a resume: it completes the missing `indexed` ingest row even when staff hid the note in the meantime, and in that case skips `notifyZap` and the gift-reply.
- **Used by:** `POST /debug/invoices/settle` after `DEBUG_TOKEN` authentication.

## Function: indexZapReceipt

- **Purpose:** Validate provider pubkey (case-insensitive hex) and add sats once per receipt id. Callers verify the Nostr signature first. Persists a `nostr_zap_ingest` row (`indexed`, or `rejected` with reason `pubkey` / `amount` / `duplicate`); store throw logs `nostr.zap.ingest.record_failed` and does not change the boolean result.
- **Ingest dedupe:** One `nostr_zap_ingest` row is written per receipt per decision change per process (memory is per store instance and empty after a restart, so the first tick after boot may write one `rejected`/`duplicate` row per receipt that tick still queries (`listLatest` plus non-null `listReplies` children of those rows)). A repeated identical `outcome:reason` is normally not written again, because the memory is consulted before the write; that is not a guarantee, since the memory is set only after the write resolves, worker ticks are not serialised, and a failed write leaves it untouched. Receipts whose remembered decision is already terminal never reach this function: `indexOpenZapReceipts` skips note lookup, account/LNURL validation, and ingest persist, but still runs `verifyReceipt` then `tryEnsureGiftReply`.
- **Inputs:** store, messageId, receipt, providerPubkey, amountSats; optional receiptEvent / noteEventId for debug rows.
- **Returns / side effects:** boolean; logs indexed/rejected; records ingest.
- **Used by:** `indexOpenZapReceipts` (worker tick).

## Function: indexOpenZapReceipts

- **Purpose:** Each worker tick, query zap relays for kind:9735 on recent notes (chunks of 20 event ids from `listLatest` plus non-null `listReplies` children of those rows) unioned with e-tags from `listOpenConversationZapEventIds` (ok invoices with a conversation id and a conversation message id). When `conversations` is set, skip adding an open-conversation e-tag whose `getMessageById(conversationMessageId)` hits, so relays are not re-queried for an already-stored PN gift. This query-side skip applies only when that e-tag is not already in the forum list from `listLatest`: a PN e-tag is the recipient's profile note, itself a top-level forum note, so while that note is among the latest notes the e-tag stays in the relay query through the forum list, and `listOpenConversationZapEventIds` supplies it otherwise. Then verify the Nostr signature, validate provider pubkey via LNURL (module TTL cache, lowercased), bolt11 amount, e-tag, and index via `indexZapReceipt` unless the payment hash matches a conversation invoice. Before provider lookup, a forum payment hash already represented by `manualReceiptIdForPaymentHash` is persisted as `rejected`/`settled`, so a late real receipt cannot add sats twice. A conversation invoice appends the predetermined `conversation_message` row (gift-only `nostrPublishState` `skipped`) and does not `addSats`, insert a forum gift-reply, or `notifyZap`. After address/provider/pubkey checks and before `claimZapPayment`, an existing PN gift is persisted `indexed` without claim/append/`nostr.zap.rejected`. Without `conversations`, that receipt is `rejected`/`conversation`. A thrown payment-hash lookup is treated as not a PN invoice so forum ingest still runs. Persists an ingest decision (`indexed` / `rejected` with reason) when it differs from the last remembered decision for that receipt on this store instance; that skip is not a guarantee, because the memory is set only after the write resolves, ticks are not serialised, and a failed write leaves it untouched. One throwing receipt does not skip the rest of the tick. A newly indexed **forum** receipt calls `notifyZap` with `auth` (in-app every account except the payer, then filtered by each account's `notificationLevel`; Web Push only to bell subscribers, same filter; `push.enqueue.failed` on throw, ingest continues). After parent `sats` are committed, ingest inserts a payer gift-reply (invoice `payment_hash`/`pr` first, else verified 9734 pubkey) only when the paid message is top-level (`parentId` null). A zap on a signed reply credits that reply via `addSats` and does not create a nested gift-reply. Ingest sets that receipt's `payerAccountId` to null so it never occupies `listZapReceiptsAwaitingGiftReply`, even before retry; retry still drops any already-queued reply receipts. The gift-reply insert does not call `notifyForumReply`. An invoice match whose payer account is missing does not fall through to 9734. Gift-only replies are `nostrPublishState` `skipped`. Gift-reply `id` is deterministic per receipt. Lookup/create failures log `nostr.zap.gift_reply.failed` and do not persist ingest `rejected`. Receipts with a payer and no `gift_reply_id` are retried each tick using the stored comment; deleted parents, missing payers, and paid messages that are themselves replies are dropped from that queue.
- **Payment-hash claim:** Before a validated forum or conversation receipt is credited, the tick claims its bolt11 payment hash with `claimZapPayment`. A conversation receipt whose PN gift row already exists is instead persisted as `indexed` before the claim, so a second receipt event for that PN payment is `indexed`, not `rejected` / `settled`. Otherwise, a hash already owned by another receipt id (a second receipt event for the same payment, or an operator settle) is persisted as `rejected` / `settled` and adds no sats, no gift-reply and no notification. A forum receipt claims only after the provider-pubkey check, so a foreign receipt cannot block the provider's real one. The same receipt id may re-claim its hash, which lets a tick that failed after the claim continue.
- **Terminal skip:** Remembered `indexed` and `rejected`/`duplicate` skip note lookup, account/LNURL validation, and ingest persist. They still run `verifyReceipt` (default `verifyEvent`) before `tryEnsureGiftReply`, unless the receipt matches a conversation invoice (then gift-reply is skipped). An `indexed` (or `rejected`/`duplicate`) forum receipt with `gift_reply_id` null still runs `tryEnsureGiftReply` after a passing signature check. Other remembered decisions (for example `rejected`/`address` or `rejected`/`error`) keep the full path so a receipt can still transition later. `rejected`/`error` is not a terminal skip.
- **Inputs:** store, auth, querier, urls, timeoutMs, now, fetchImpl; optional `verifyReceipt` (default: nostr-tools `verifyEvent`); optional `pushStore`; optional `notificationStore`; optional `conversations` (PN append; omitted → conversation invoices `rejected`/`conversation`).
- **Returns / side effects:** void; logs `nostr.zap.rejected` / `indexed`; the per-receipt catch logs `nostr.zap.rejected` with `reason: 'error'` plus the `errorLogFields` allowlist (`name`: ASCII letters, `code` / `errno`: ASCII alphanumerics and underscore, each 1–40 characters) and never the message text; a failure outside that catch (store list, relay query) reaches `nostr.worker.tick.failed`, which logs the same allowlist; records ingest rows; may append a conversation message, create a forum reply, and fan out `notifyZap` in-app to every account except skip, then filtered by each account's `notificationLevel` (Web Push to bell subscribers, same filter); never logs full bolt11. Memory is per store instance and empty after a restart, so the first tick after boot may write one `rejected`/`duplicate` row per receipt that tick still queries (`listLatest` plus non-null `listReplies` children of those rows).
- **Used by:** `runNostrWorkerTick`.

## Function: backfillZapPayments

- **Purpose:** Populate durable payment-hash claims for zap receipts credited before `nostr_zap_payment` existed, preventing a later receipt event for the same payment from adding sats again.
- **Ordering / idempotency:** Reads indexed zap ingests newest-first but processes them oldest-first, so the earliest credited receipt owns the hash. Repeating the backfill is safe because a claim by the same receipt id succeeds.
- **Claims / conflicts:** Skips receipts without a decodable BOLT11 payment hash. For each remaining receipt, calls `claimZapPayment` with its hash, receipt id and ingest creation time; another receipt's existing claim logs `nostr.zap.backfill.conflict` and is left unchanged, without un-crediting anything. Conversation ingests are claimed the same way.
- **Returns / side effects:** Returns the number of new or same-owner claims accepted, at a boot cost of one insert-or-skip per indexed ingest with a payment hash, then logs `nostr.zap.backfill.done` with `claimed` and the total indexed-ingest count.
- **Errors / use:** Store read and claim errors propagate so Postgres boot fails rather than continuing with incomplete dedupe state. `openBootStores` runs it after constructing `PostgresMessageStore`; in-memory boots do not run it.

## Function: requestZapInvoice

- **Purpose:** LNURL-pay callback with `nostr=` (not `comment=`). Captures raw LNURL callback JSON so callers can persist it on invoice-attempt rows. Never pays. When the first attempt is `{ ok: false, reason: 'unreachable' }`, the same attempt runs once more and that second result is returned; `ok` and `noZap` are not retried.
- **Inputs:** address, amountMsat, zapRequestJson, fetchImpl.
- **Returns / side effects:** Every path includes `lnurlResponse` (`Record<string, unknown>` when the callback body was a JSON object, else `null`). Success: `{ ok: true, pr, amountSats, lnurlResponse }`. Failure: `{ ok: false, reason: 'noZap' | 'unreachable', lnurlResponse }` — `noZap` when `allowsNostr` is not true or `nostrPubkey` is missing; `unreachable` on resolve/amount/callback/schema failure (`lnurlResponse` is the raw object when a JSON body was received, otherwise `null`).
- **Used by:** `POST /messages/:id/invoice`, `probeNip57Mint`.

## Function: unsignedNostrDefaults

- **Purpose:** Unsigned/pending defaults for a new forum row.
- **Inputs:** none.
- **Returns / side effects:** Column defaults including `sats: 0`, `parentId: null`, `authorPubkey: null`, plus unsigned/pending Nostr columns (`eventId` / `nostrEvent` / `claimedUntil` / `nostrFirstAttemptAt` / `nostrPublishEpoch` null, `nostrPublishState: 'pending'`, `nostrAttempts: 0`).
- **Used by:** `POST /messages`, stores.

## Function: allocateNip05Local

- **Purpose:** Unique NIP-05 local-part; first slug wins, collisions append account-id hex.
- **Inputs:** name, account id, taken set.
- **Returns / side effects:** local-part string.
- **Used by:** `nip05Identifier`, `listNip05Entries`.

## Function: buildNostrJson

- **Purpose:** NIP-05 `names` + `relays` map for `GET /.well-known/nostr.json`.
- **Inputs:** auth store, env, optional name filter.
- **Returns / side effects:** JSON body.
- **Used by:** `wellKnownRoutes`.

## Function: decodeForumVideo

- **Purpose:** Size + magic-byte check for MP4/WebM/MOV (32 MiB cap). MP4/MOV bytes are passed through `faststartIsoBmff` (`moov` before `mdat` only when remux succeeds; abort cases keep the original bytes).
- **Inputs:** raw bytes.
- **Returns / side effects:** `{ contentType, bytes }` or null.
- **Used by:** `POST /messages` multipart.

## Function: detectVideoContentType

- **Purpose:** `ftyp` / WebM magic → MIME.
- **Inputs:** bytes.
- **Returns / side effects:** MIME or null.
- **Used by:** `decodeForumVideo`.

## Function: faststartIsoBmff

- **Purpose:** Rearrange ISO-BMFF so `moov` precedes `mdat` (qt-faststart), patching `stco`/`co64` chunk offsets. Aborts to the original `bytes` reference (no remux) when already faststart (`moov` already before `mdat`), truncated / invalid box tree, truncated or oversized `stco`/`co64` tables, top-level `moof`, `cmov`, not exactly one top-level `moov` and one top-level `mdat`, missing `stco` / `co64` (no chunk-offset box visited), or `stco` overflow (uint32 chunk offset would exceed `0xffffffff`).
- **Inputs:** container bytes.
- **Returns / side effects:** Same-length remuxed copy with `moov` before `mdat` and patched `stco`/`co64`, or the original `bytes` reference on abort.
- **Used by:** `decodeForumVideo`; `readForumVideoBytes`.

## Function: forumVideoExt

- **Purpose:** Damus path extension for a video MIME.
- **Inputs:** MIME.
- **Returns / side effects:** `mp4` / `webm` / `mov`.
- **Used by:** public video URLs.

## Function: forumVideoUrl

- **Purpose:** Absolute `GET /messages/:id/video.mp4` (or `.webm` / `.mov`) URL.
- **Inputs:** API origin, message id, MIME.
- **Returns / side effects:** URL string.
- **Used by:** Worker sign path.

## Function: isoBmffDisplaySize

- **Purpose:** Integer width/height from the first non-zero `tkhd` (16.16 fixed) under `moov`/`trak`.
- **Inputs:** ISO-BMFF bytes.
- **Returns / side effects:** `{ width, height }` or null.
- **Used by:** Worker kind:1 video `imeta` `dim`.

## Function: listNip05Entries

- **Purpose:** Named accounts with pubkeys, oldest first, unique locals.
- **Inputs:** auth store.
- **Returns / side effects:** `Nip05Entry[]`.
- **Used by:** `buildNostrJson`.

## Function: nip05Domain

- **Purpose:** Hostname from `PUBLIC_BASE_URL`; null for loopback/IP.
- **Inputs:** env.
- **Returns / side effects:** hostname or null.
- **Used by:** kind:0 `nip05`.

## Function: nip05Identifier

- **Purpose:** `local@domain` for one account matching `nostr.json`.
- **Inputs:** account, named accounts oldest-first, domain.
- **Returns / side effects:** identifier string.
- **Used by:** Worker kind:0.

## Function: nip05Slug

- **Purpose:** Display name → `a-z0-9-` local-part (`user` if empty).
- **Inputs:** name.
- **Returns / side effects:** slug.
- **Used by:** `allocateNip05Local`.

## Function: parseBytesRange

- **Purpose:** Parse `bytes=start-end` for 200 / 206 / 416 responses (RFC 7233).
- **Inputs:** header, file size.
- **Returns / side effects:** `{ type: 'full' }` | `{ type: 'partial'; start; end }` | `{ type: 'unsatisfiable' }`.
- **Used by:** `GET /messages/:id/video.*`.

## Function: readForumVideoBytes

- **Purpose:** Read video bytes from disk, remux with `faststartIsoBmff`, and rewrite the file when boxes move (heal-on-read for clips stored before faststart). Heal writes a sibling temp file named with `crypto.randomUUID()` in the same directory as `path`, then `rename`s that temp onto `path`.
- **Inputs:** absolute path; optional `io` disk ops (tests).
- **Returns / side effects:** Bytes to serve. On write/rename failure the original file is left in place and the remuxed buffer is still returned.
- **Used by:** `GET /messages/:id/video.*`.

## Function: removeForumVideo

- **Purpose:** Best-effort unlink of a stored video file.
- **Inputs:** message id, MIME, env.
- **Returns / side effects:** void.
- **Used by:** tests; create rollback.

## Function: resolveMediaDir

- **Purpose:** Trimmed `MEDIA_DIR` for forum video files on disk; no temp fallback.
- **Inputs:** env (defaults to `process.env`).
- **Returns / side effects:** Trimmed path. Throws `Error` (`MEDIA_DIR must be a non-empty path`) when missing, not a string, or blank after trim. Boot calls it before stores / `Bun.serve`.
- **Used by:** video read/write; `index.ts` boot.

## Function: videoFilePath

- **Purpose:** `{dir}/{id}.{ext}` on disk.
- **Inputs:** dir, id, MIME.
- **Returns / side effects:** path.
- **Used by:** write/read/serve.

## Function: forumVideoFilePresent

- **Purpose:** True when the stored video file exists, is a regular file, and is non-empty.
- **Inputs:** media dir, message id, MIME or `null`, optional `stat` inject.
- **Returns / side effects:** `false` when MIME is null, the path is missing (`ENOENT`), not a file, or size 0; non-ENOENT `stat` errors propagate (callers must not delete the row). Stats disk.
- **Used by:** `messagesRoutes` list, public GET, and replies.

## Function: wellKnownRoutes

- **Purpose:** Hono `GET /nostr.json` (CORS `*`).
- **Inputs:** auth store, env.
- **Returns / side effects:** Hono app mounted at `/.well-known`.
- **Used by:** `createApp`.

## Function: writeForumVideo

- **Purpose:** Persist video bytes under `MEDIA_DIR` (caller should already faststart MP4/MOV via `decodeForumVideo`).
- **Inputs:** message id, video, env.
- **Returns / side effects:** mkdir, write UUID sibling temp, `rename` onto the public path so readers never see a partial file.
- **Used by:** `MessageStore.create`; `debugMessagesRoutes`.

## Function: isStaffRole

- **Purpose:** True when `account.role` may run staff trust routes. Founder and moderator return true; `basis` and `verified` return false. Used before `GET /trust/proposals`, `POST /trust/verify`, `POST /trust/propose-moderator`, and `POST /trust/confirm-moderator` (appoint requires founder separately).
- **Inputs:** `AccountRole` (`basis` \| `verified` \| `moderator` \| `founder`).
- **Returns / side effects:** boolean. No I/O.
- **Used by:** `trustRoutes`.

## Function: isChainAccount

- **Purpose:** True when `account.role` appears on the public Trust Chain (`founder`, `moderator`, or `verified`). `basis` is false.
- **Inputs:** `Account`.
- **Returns / side effects:** boolean. No I/O.
- **Used by:** `trustChainRoutes` (`GET /trust-chain?around=`).

## Function: isProjectedTrustEdge

- **Purpose:** Whether a stored edge appears on the public Trust Chain. True iff `edge.kind` equals the oldest eligible sibling among `subjectEdges` (`createdAt` then `id`). Eligible: `verify`, `moderator_appoint`, and `moderator_propose` only when the live subject is a `moderator`. `moderator_confirm` never. Later appoint, confirm, or propose do not replace an earlier eligible contact.
- **Inputs:** `edge` (`TrustEdge`), `subject` (`Account | undefined`), `subjectEdges` (`readonly TrustEdge[]`, default `[edge]`).
- **Returns / side effects:** boolean. No I/O.
- **Used by:** `buildTrustChain`, `trustChainRoutes` (`GET /trust-chain?around=`).

## Function: buildTrustChain

- **Purpose:** Project live accounts and stored trust edges to the public graph. Nodes are founder/moderator/verified only (never `basis`), sorted founder then moderator then verified, then oldest `createdAt`, then `id`. Groups stored edges by `subjectId` and projects at most one incoming kind per subject: the oldest eligible sibling (`createdAt` then `id`). Eligible: `verify`, `moderator_appoint`, and `moderator_propose` only when the live subject is a `moderator`. Never invents edges; `moderator_confirm` is omitted; a pending propose (subject still `verified`) stays private; later appoint, confirm, or propose do not replace an earlier eligible contact; omits lightning addresses, view keys, and linking keys. A node with no stored incoming edge stays disconnected.
- **Inputs:** `accounts` (`readonly Account[]`), `edges` (`readonly TrustEdge[]`).
- **Returns / side effects:** `{ nodes, edges }` (`TrustChain`). No I/O.
- **Used by:** `trustChainRoutes` (`GET /trust-chain`).

## Function: accountTrust

- **Purpose:** Latest grant actors for one subject (`verifiedBy`, `proposedBy`, `confirmedBy`, `appointedBy`). When several edges share a kind, highest `createdAt` wins, then `id`. Actor names come from the live account map; a missing actor is `{ id, name: null }`. All four slots are `null` when the subject has no edges of that kind.
- **Inputs:** `subjectId`, `accounts` (name lookup), `edges` (any subjects; filtered to `subjectId`).
- **Returns / side effects:** `AccountTrust`. No I/O.
- **Used by:** `membersRoutes` (`GET /members/:accountId` always includes `trust`).

## Function: pendingModeratorProposals

- **Purpose:** Pure helper for the staff moderator-proposal queue. A row is pending when a `moderator_propose` edge exists, the live subject is `verified`, and that subject has no `moderator_confirm` and no `moderator_appoint`. Missing subject accounts are omitted. Several proposes for one subject keep the latest by `createdAt` then `id` (same tie-break as `accountTrust`). `proposedBy` uses live actor names; a missing actor is `{ id, name: null }`. Sorted oldest `createdAt` first, then propose-edge `id` (FIFO). Never includes `basis` / `moderator` / `founder` subjects.
- **Inputs:** `accounts` (`readonly Account[]`), `edges` (`readonly TrustEdge[]`).
- **Returns / side effects:** `ModeratorProposal[]` (epoch-ms `createdAt`; subject `role` is always `"verified"`). No I/O.
- **Used by:** `trustRoutes` (`GET /trust/proposals`).

## Function: serializeTrustEdge

- **Purpose:** JSON projection of a stored trust edge for operator POST and DELETE `/debug/trust-edges` responses. Emits `id`, `subjectId`, `actorId`, `kind`, and `createdAt` as ISO-8601. Does not include account role or extra columns.
- **Inputs:** `TrustEdge` (epoch-ms `createdAt`).
- **Returns / side effects:** `TrustEdgeJson`. No I/O.
- **Used by:** `debugTrustRoutes` (`POST /debug/trust-edges` and `DELETE /debug/trust-edges` 200 body).

## Function: migrateTrustSchema

- **Purpose:** Applies `TRUST_SCHEMA_SQL` in order (`CREATE TABLE IF NOT EXISTS trust_edge` with FKs to `account`, kind CHECK, `subject_id <> actor_id`, unique `(subject_id, kind)` index, actor index). Idempotent. Runs after auth/`account` exists and before `migrateDbChangeSchema` so `trg_db_change` attaches to `trust_edge`.
- **Inputs:** `SqlClient`.
- **Returns / side effects:** Void; idempotent DDL execute matching `docs/schema/trust_edge.sql` (comment header allowed in the `.sql` file only).
- **Used by:** `openBootStores` when SQL opens.

## Function: InMemoryTrustStore

- **Purpose:** Process-local `TrustStore` for who granted which staff status. Default empty so the process boots without a database. `createApp` uses this when boot leaves `trustStore` undefined (memory `DATABASE_URL`).
- **Inputs:** Optional seed `TrustEdge[]` (copied). `listEdges` / `listEdgesForSubject` / `listEdgesTouching` sort oldest `createdAt` then `id` ASC. `insertEdge` copies on write and throws `Error('duplicate trust edge')` when `(subjectId, kind)` exists. `deleteEdge(subjectId, kind)` removes that unique row or returns `undefined`.
- **Returns / side effects:** Promise of edge copies; mutating results does not change the store. No I/O.
- **Used by:** `createApp` default `trustStore`.

## Function: PostgresTrustStore

- **Purpose:** Durable `TrustStore` over Postgres (`trust_edge` table). `listEdges` / `listEdgesForSubject` / `listEdgesTouching` are oldest-first; `insertEdge` binds columns without `ON CONFLICT` and maps unique violation `23505` to `Error('duplicate trust edge')`. `deleteEdge` is `DELETE … RETURNING` on `(subject_id, kind)` and returns `undefined` when no row matches.
- **Inputs:** Constructor takes a shared boot `SqlClient` (already migrated). Maps `subject_id` / `actor_id` / `created_at` (Date or ISO string) onto `TrustEdge`.
- **Returns / side effects:** Parameter-bound SQL; copies on return. Non-unique errors propagate to the route (409/503).
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: trustChainRoutes

- **Purpose:** Hono sub-app for `GET /trust-chain`. Bearer session required (any role). Missing or invalid Bearer → 401 `{ error: 'Unauthorized' }`. Bare GET (no `around`, or empty) returns founder seeds (no edges). `?around=<id>` loads all edges for each subject in the touching set (`listEdgesForSubject`) then `isProjectedTrustEdge` with that sibling list so a non-touching older eligible edge still wins over a touching newer one. One hop of the oldest eligible public kind (`createdAt` then `id`); pending-propose verified neighbors are not nodes; confirm never. Empty arrays when none. Invalid uuid (Postgres `22P02`), unknown, or basis `around` → 404 after a valid session. Other store throw → 503 `{ error: 'Trust chain is unavailable' }` and log `trust.chain.failed`.
- **Inputs:** `TrustChainRouteDeps`: `authStore`, `trustStore`, `now`.
- **Returns / side effects:** Hono app mounted at `/trust-chain` (`GET /`).
- **Used by:** `createApp`.

## Function: trustRoutes

- **Purpose:** Hono sub-app for staff Bearer `GET /proposals` (pending `moderator_propose` via `pendingModeratorProposals`; ISO `createdAt`; empty list is 200; logs `trust.proposals.listed` `{ count }` only) and four POSTs: `/verify` (role `verified` + `verify` edge; idempotent when the caller already verified), `/propose-moderator` (pending propose, role unchanged), `/confirm-moderator` (independent second staff member; role `moderator` + confirm edge), `/appoint-moderator` (founder only; role `moderator` + appoint edge). UUID check reuses `MESSAGE_ID_RE`. Logs `trust.verified` / `trust.moderator_proposed` / `trust.moderator_confirmed` / `trust.moderator_appointed`. After every confirm/appoint 200 that leaves/keeps the subject as `moderator` (new grant and idempotent already-moderator same-actor 200), wraps `notifyModeratorAppointed` for the subject only.
- **Inputs:** `TrustRouteDeps`: `authStore`, `trustStore`, `now`, optional `notificationStore`, `pushStore`, and `conversationStore` (appointed push `unreadCount` includes listed inbox unread).
- **Returns / side effects:** Hono app mounted at `/trust`. 401/403/400/404/409/503 with the documented `{ error }` strings; GET `/proposals` 200 `{ proposals }` (empty list included); POST 200 `{ id, name, role }`.
- **Used by:** `createApp`.

## Function: debugTrustRoutes

- **Purpose:** Operator backfill `POST /debug/trust-edges` and undo `DELETE /debug/trust-edges`. Same 503/401 `DEBUG_TOKEN` gate as other debug routes. POST body `{ subjectId, actorId, kind }` inserts; DELETE body `{ subjectId, kind }` removes the unique `(subjectId, kind)` row. Both return `serializeTrustEdge` (ISO `createdAt`) and do **not** change `account.role`. `PATCH /debug/accounts/:id` remains role-only.
- **Inputs:** `DebugTrustRouteDeps`: auth `store`, `trustStore`, optional `debugToken`, optional `now` (default `Date.now`; unused by DELETE).
- **Returns / side effects:** Hono app mounted at `/debug/trust-edges`. POST success logs `debug.trust_edges.inserted` `{ subjectId, actorId, kind }`. DELETE success logs `debug.trust_edges.deleted` `{ subjectId, kind }`. POST 400/404/409/503 as before. DELETE 400 bad body; 404 missing UUID or missing row; 503 on unexpected store throw (`debug.trust_edges.delete_failed`).
- **Used by:** `createApp`; operator `gifts-debug trust-edge` / `gifts-debug trust-edge-delete`.

## Function: verifiedExternalZapRequest

Strictly attributes a zap receipt to the signer of its embedded NIP-57 request.

- **Input:** Receipt tags, the invoice description hash and amount, and the target note event id.
- **Verification:** Requires a valid signed kind 9734 whose exact JSON hash, `e` tag, and optional `amount` tag match the receipt and invoice.
- **Output:** Returns a lowercase pubkey, signed request id, and normalized comment, or `null` without partial attribution.

## Function: externalDisplayName

Creates a safe display-name snapshot for a visible external Nostr author.

- **Preference:** Uses the trimmed profile `display_name` or `name` supplied by the caller.
- **Protection:** Rejects control characters and names that impersonate a member or reserved project/staff identity.
- **Fallback:** Uses a truncated pubkey display; accepted profile names are capped at the member-name limit.

## Function: resolveExternalProfileName

Looks up the newest kind 0 profile name without making ingest depend on relay availability.

- **Query:** Requests kind 0 events for one lowercase pubkey from the configured zap relay set.
- **Selection:** Chooses the newest event and prefers `display_name` over `name`.
- **Resilience:** Never throws; successful names are cached for one hour and misses or failures for five minutes.

## Function: ExternalIngestLimiter

Applies in-process sliding limits before an entitled external reply is persisted.

- **Per author:** Allows six replies per hour and twenty per UTC day for each external pubkey.
- **Global:** Allows thirty replies per hour and one hundred per UTC day across all external pubkeys.
- **Retry behavior:** A rejected acquisition stores nothing, so the relay event can be considered again on a later worker tick.

## Function: backfillExternalZappers

Rechecks stored indexed zap receipts that predate external-payer attribution.

- **Scope:** Reads a bounded newest-first batch with no account payer, external payer, request id, or gift reply.
- **Safety:** Applies the same strict request verification, account exclusion, block, replay, and top-level-parent rules as live ingest.
- **Result:** Records durable zapper entitlement and eligible gift replies, logs aggregate counts, and remains safe to run on every boot.

## Function: notifyExternalForumReply

Targets an external Nostr reply notification only to the member who authored the parent note.

- **Audience:** Restricts both in-app and Web Push recipients to the parent account before notification-level filtering.
- **Identity:** Always uses the generic actor name `'Someone'`, never the external reply's stored or visitor-chosen display name, while keeping its pubkey out of notification payloads.
- **No-op:** Returns without writes when the parent has no account; caller-owned failures do not undo the persisted reply.

## Function: debugExternalRoutes

Builds the operator-only external-pubkey inspection route.

- **Authentication:** Requires a bearer equal to `DEBUG_TOKEN`; missing configuration returns 503 and a bad bearer returns 401.
- **Response:** Lists entitled zappers and blocked pubkeys newest first with receipt, block, staff, message, and timestamp metadata.
- **Bound:** Caps each list at the standard message debug limit and returns 503 when the store cannot be read.
