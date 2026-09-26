# Functions

## Function: posRoutes

- **Purpose:** Hono routes `GET /pos`, `POST /pos`, and `DELETE /pos` for one open point-of-sale amount in whole sats. Pins nothing itself; the well-known route reads the store.
- **Inputs:** `PosRouteDeps` (`store`, `authStore`, `now`, `fetchImpl`).
- **Returns / side effects:** A Hono app. Writes charges through `PosStore`. No paid status.
- **Used by:** `createApp`.

## Function: serializePosCharge

- **Purpose:** Public JSON for a charge without `accountId`. Timestamps are ISO-8601.
- **Inputs:** A `PosCharge` row.
- **Returns / side effects:** `PublicPosCharge`. No I/O.
- **Used by:** `posRoutes`.

## Function: serializeDebugPosCharge

- **Purpose:** Operator JSON for a charge including `accountId`.
- **Inputs:** A `PosCharge` row.
- **Returns / side effects:** `DebugPosCharge`. No I/O.
- **Used by:** Debug catalog table `pos_charge`.

## Function: migratePosSchema

- **Purpose:** Apply idempotent `CREATE TABLE pos_charge` DDL.
- **Inputs:** A `SqlClient`.
- **Returns / side effects:** Resolves when the statements have run.
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: InMemoryPosStore

- **Purpose:** Process-local `PosStore` used in tests and when no database URL is set. Always starts empty. `create` refuses a second unexpired pending row for the same account. `cancelPending` cancels every remaining pending row.
- **Inputs:** None.
- **Returns / side effects:** Pending, cancel, expire, and list methods. Mutates its private array. `create` throws `A payment is already open` when one is already open.
- **Used by:** `createApp` default and unit tests.

## Function: PostgresPosStore

- **Purpose:** `PosStore` against the `pos_charge` table. Pending inserts are one per account via `pos_charge_account_pending_idx`. `create` expires due rows first so a finished charge does not block the next one. `cancelPending` cancels every remaining pending row.
- **Inputs:** A `SqlClient`.
- **Returns / side effects:** Same port as the in-memory store, persisted in Postgres. A concurrent second pending insert raises unique violation `23505` for the route to map to 409.
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: buildGiftDay

- **Purpose:** Pure list of outbound gifts that fall on one UTC calendar day. The stored payment-time USD/CHF/EUR/PHP is what is returned; a legacy row with no snapshot still uses that day's close.
- **Inputs:** `day` (`YYYY-MM-DD`), `readonly GiftRow[]` (other days ignored), `ReadonlyMap` of UTC day → USD-per-BTC, optional `ReadonlyMap` of UTC day → USD→CHF/EUR/PHP. Empty matching set needs no rates.
- **Returns / side effects:** `GiftDay` (`gifts` sorted by `paidAt` then `recipient`) with `totalChf`/`totalEur`/`totalPhp` and `fx.quotes`. Empty day is `"0.00"` fiat and USD-only `quotes`. Throws `Error('fx.rate.missing')` when a listed gift has no BTC-USD rate. Missing CHF/EUR/PHP is JSON `null`, never a throw. No I/O.
- **Used by:** `giftsRoutes`.

## Function: buildAccountActivity

- **Purpose:** Aggregate given and received sats for one account: confirmed forum zaps paid by the account, indexed zaps on notes it authored including hidden, plus `message.sats` remainder on **top-level** notes only (gift-as-reply `sats` are not Received), house gifts to its Lightning handle, and every outbound house gift when `isPlatform` is true. Does not change `GET /gifts/stats`. Activity series (`donatedOverTime` / `receivedOverTime`) are the same `spendOverTime` day objects as `GET /gifts/stats` including additive CHF/EUR/PHP. The stored payment-time USD/CHF/EUR/PHP is what is returned.
- **Inputs:** `{ account, gifts, messages, rates, now, fiatRates? }`. Uses `listInvoiceAttemptsForPayer`, `listIndexedZapIngests`, `listAuthoredMessages`, `listOutbound`, and `giftsForRecipient`. Optional `fiatRates` defaults to an empty `InMemoryFiatStore`.
- **Returns / side effects:** `AccountActivity` (`donatedSats`, `receivedSats`, `donatedOverTime`, `receivedOverTime`, `fx`). Empty input is zeros with USD-only `fx.quotes`, without Coinbase and without Frankfurter. Throws `Error('fx.rate.missing')` only when a row omits `amountUsd` and that UTC day has no BTC-USD rate after `ensureDays`. A set `amountUsd` (including `null`) is the stored snapshot: it is not recomputed and it does not throw. Missing CHF/EUR/PHP is JSON `null`, never a throw (`account.activity.fiat_failed` still returns USD).
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

- **Purpose:** Pure aggregation of outbound gifts into the public stats JSON (UTC daily series with gap days and per-day `giftCount` plus `officialCount`, months with gap months, recipients) including BTC strings. `officialCount` is the distinct case-insensitive recipient handles that UTC day with kind `daily` or `welcome` (one person once; moderator excluded; gap days 0). `giftCount` remains every outbound row. The stored payment-time USD/CHF/EUR/PHP is what is returned; a legacy row with no snapshot still uses that day's close.
- **Inputs:** `readonly GiftRow[]` (`paidAt`, `amountSats`, `recipientWosUser`, `kind`), `ReadonlyMap<string, string>` of UTC day → USD-per-BTC, optional `ReadonlyMap` of UTC day → USD→CHF/EUR/PHP. Empty rows need no rates.
- **Returns / side effects:** `GiftStats` with `totalBtc`, `totalUsd`, `totalChf`/`totalEur`/`totalPhp`, `fx` (including `fx.quotes`), BTC/USD/fiat on series/buckets, and `spendOverTime[].officialCount` (not on recipient or month buckets). Throws `Error('fx.rate.missing')` when a gift day has no BTC-USD rate. Missing CHF/EUR/PHP is JSON `null`, never a throw. Gap days and gap months are zero sats/BTC/USD/`officialCount` and `"0.00"` fiat without a rate. No I/O.
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

## Function: buildPostStats

- **Purpose:** Turn per-day living note counts into the public posts series. Notes and replies are already combined by the store.
- **Inputs:** Day rows (any order) and a clock in epoch milliseconds.
- **Returns / side effects:** `{ postCount, postsOverTime }`. Empty input stays empty. Otherwise every UTC day from the earliest row through today, or through a later row, is present. Missing days are 0. No I/O.
- **Used by:** `GET /messages/stats`.

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

## Function: normalizeAmountUsd

- **Purpose:** Normalize a spend-worker USD amount to a two-decimal string without IEEE float.
- **Inputs:** Caller text such as `"5"`, `"5.1"`, or `"5.00"`. Value must be `> 0` and `<= 100000`, integer cents only.
- **Returns / side effects:** `"5.00"`-style string, or `null` when the value is unusable. No I/O.
- **Used by:** `invoiceRoutes`.

## Function: shownFiatFromBody

- **Purpose:** Read the four fiat amounts the payer was shown, so a later payment stores those amounts instead of converting sats again.
- **Inputs:** Optional `amountUsd`, `amountChf`, `amountEur`, and `amountPhp`. No key means the client did not pin a price. A present key may be null, `"0"` / `"0.0"` / `"0.00"` (stored as `"0.00"`), or a positive two-decimal amount. USD stays within the spend ceiling. CHF, EUR, and PHP accept any safe positive two-decimal amount. An unusable string makes the whole result `null`.
- **Returns / side effects:** `{ pinned: false }`, `{ pinned: true, fiat }`, or `null` when a string is unusable. No I/O.
- **Used by:** `messageRoutes`, `conversationRoutes`.

## Function: fiatFromUsd

- **Purpose:** Freeze CHF/EUR/PHP from an already-normalized USD amount. The USD string is the amount stored at payment time, not a later UTC-day close.
- **Inputs:** `amountUsd` (`"5.00"`) and optional CHF/EUR/PHP per 1 USD. A missing cross stays null.
- **Returns / side effects:** `FiatAmounts` whose `usd` is `amountUsd`. Throws `amountUsd must be normalized` on a bad USD string. No I/O.
- **Used by:** `invoiceRoutes`.

## Function: fiatFromSats

- **Purpose:** Freeze USD/CHF/EUR/PHP from whole sats at one Coinbase spot. The USD is that spot, not a later UTC-day close.
- **Inputs:** Positive whole `sats`, Coinbase `data.amount` text, and optional CHF/EUR/PHP per 1 USD. A missing cross stays null.
- **Returns / side effects:** `FiatAmounts` at this spot. Throws on a bad rate. No I/O.
- **Used by:** `invoiceRoutes`, message create, zap indexing.

## Function: fetchBtcUsdSpot

- **Purpose:** Fetch the current positive BTC-USD spot used to freeze fiat at payment time, without ever throwing.
- **Inputs:** Optional fetch implementation and optional URL (blank falls through to `BTC_USD_SPOT_URL`, then the Coinbase default).
- **Returns / side effects:** Coinbase decimal text, or `null` for every transport, shape, or value failure, including a fetch that aborts after 10 seconds (`BTC_USD_SPOT_TIMEOUT_MS`). Does not throw.
- **Used by:** `invoiceRoutes`, message create, zap indexing, conversation message append (`InMemoryConversationStore` / `PostgresConversationStore` `appendMessage`).

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

## Function: migrateGiftSchema

- **Purpose:** Adds nullable `fiat_usd`, `fiat_chf`, `fiat_eur`, and `fiat_php` on `gift`, then backfills rows with `amount_sats > 0` and `fiat_usd IS NULL` from `btc_usd_daily` and `usd_fiat_daily` for `paid_at`'s UTC day. Also adds nullable `kind text`. Classifying existing rows is `repairGiftKind`, after `trg_db_change` is attached. No HTTP. A missing BTC day leaves the fiat row null. Rows that already have `fiat_usd` are not rewritten. `'other'` is not a database value.
- **Inputs:** `SqlClient`.
- **Returns / side effects:** Void; idempotent DDL plus a one-time historical fiat freeze. Does not UPDATE `kind`.
- **Used by:** `openBootStores` when SQL opens.

## Function: repairGiftKind

- **Purpose:** Classifies `gift.kind` where it is still null, then adds `gift_kind_check` if absent and sets the column NOT NULL. Skips the whole repair when `trg_db_change` is not yet attached to `gift`, so the UPDATEs are audited and the next boot retries.
- **Inputs:** `SqlClient`.
- **Returns / side effects:** Void. `description = '21gifts moderator'` becomes `moderator`. Remaining null rows are matched one-to-one only to platform replies whose trimmed text is `Welcome` or `21gifts daily` (same sats, lightning local-part, within 3 seconds); only an assigned `Welcome` becomes `welcome`. That assignment and every other still-null row are one `UPDATE` (`'{id,…}'` bound as `bigint[]`, because the driver rejects a JavaScript array). A stopped boot therefore cannot attach the same Welcome reply to a different still-null gift. The check allows only `daily`, `welcome`, and `moderator`, and it is recognized only as a check constraint on `gift` (`conrelid = 'gift'::regclass` and `contype = 'c'`).
- **Used by:** `openBootStores` immediately after `migrateDbChangeSchema`.

## Function: migrateMessageSchema

- **Purpose:** Applies `MESSAGE_SCHEMA_SQL` in order (`CREATE TABLE IF NOT EXISTS message` with nullable `photo`/`photo_content_type`, newest-first index, additive `ALTER … ADD COLUMN IF NOT EXISTS` for existing databases including `video_content_type` (MIME in Postgres; video bytes on disk under `MEDIA_DIR`, not bytea), `parent_id uuid REFERENCES message (id)`, `author_pubkey text`, then `ALTER TABLE message ALTER COLUMN account_id DROP NOT NULL` and immediately `CREATE INDEX IF NOT EXISTS message_parent_id_idx ON message (parent_id, created_at ASC, id ASC)`). Later, immediately after `CREATE TABLE message_extra_photo`, an additive `goal_sats bigint` (nullable; SQL null means no ask), then `photo_taken_at text` and `video_taken_at text` on `message` (civil time, not timestamptz) and `photo_taken_at text` on `message_extra_photo`, then `place_lat double precision`, `place_lng double precision`, and `place_label text`, then nullable `goal_currency` (null or BTC/USD/CHF/EUR/PHP), `goal_amount numeric(20, 8)`, and `goal_fiat_usd` / `goal_fiat_chf` / `goal_fiat_eur` / `goal_fiat_php numeric(20, 2)` (null when there is no currency ask; not backfilled), then nullable `goal_repayable boolean` and nullable `goal_term_days integer`, with checks `goal_repayable IS NOT TRUE OR (parent_id IS NULL AND goal_sats IS NOT NULL)` and `goal_term_days IS NULL OR (goal_repayable IS TRUE AND goal_term_days BETWEEN 1 AND 3650)`, then the feed indexes `message_feed_created_idx` and `message_feed_popular_idx`, then `TRANSLATION_SCHEMA_SQL` (`CREATE TABLE IF NOT EXISTS message_translation`), and only then the last unwrap `DO $unwrap$`. It next creates `nostr_zap_receipt`, additively adds `payer_account_id`, `payer_pubkey`, `zap_request_id`, `gift_reply_id`, and `comment`, and creates partial unique indexes including `nostr_zap_receipt_request_uidx` on non-null `zap_request_id`; this is followed by `nostr_zapper`, `nostr_blocked_pubkey`, and `nostr_zap_payment`, then `message_invoice` and `nostr_zap_ingest` without FKs plus `ALTER TABLE message_invoice ADD COLUMN IF NOT EXISTS lnurl_response jsonb`, `conversation_id uuid`, `conversation_message_id uuid`, `fiat_pinned boolean NOT NULL DEFAULT false`, and `fiat_usd`, `fiat_chf`, `fiat_eur`, `fiat_php` numeric(20, 2), and their `created_at`/`message_id` and `receipt_id` indexes. After `message` exists, adds `account_profile_message_id_fkey` (`ON DELETE SET NULL`) and unique partial index `account_profile_message_uidx`, then soft-hide columns `deleted_at timestamptz` and `deleted_by uuid`. Then additive `content_fp text`, `DROP INDEX IF EXISTS` on `message_live_top_content_fp_uidx` and `message_live_reply_content_fp_uidx` before the photo-only backfill via `digest(photo, 'sha256')` (`video_content_type` IS NULL), salt of extra live duplicates (`content_fp || ':' || message.id`), and recreation of those partial unique indexes (live rows with non-null account + fingerprint). The partial index `message_nostr_event_unrepaired_idx` supports the boot repair's predicate so a converged table can be confirmed without a sequential scan. On every boot, the array also runs an idempotent repair unwrapping `nostr_event` values stored as jsonb string scalars (`jsonb_typeof(nostr_event) = 'string'`), which matches no rows once complete. It is skipped while the `db_change` audit trigger is not attached and retried on the next boot; a row whose value cannot be parsed is skipped with a warning instead of failing the migration. Successfully repaired rows have `nostr_attempts` cleared for a fresh repair budget. The unwrap `DO $unwrap$` block remains last in `MESSAGE_SCHEMA_SQL` only (not mirrored in `docs/schema/message.sql`). It also adds nullable `fiat_usd`, `fiat_chf`, `fiat_eur`, and `fiat_php` on `message` and `nostr_zap_ingest`, then backfills rows with a positive sat amount and `fiat_usd IS NULL` from that row's UTC-day close. A missing rate leaves the row null. Rows that already have `fiat_usd` are not rewritten.
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

- **Purpose:** Applies `CONVERSATION_SCHEMA_SQL` in order (`conversation` + `conversation_message` + `conversation_read` tables and unique indexes, including `conversation_read_conversation_id_idx`). CREATE CHECK includes `moderator_group`; ALTER DROP/ADD `conversation_kind_check`; unique partial index `conversation_moderator_group_uidx`. Additive `ALTER TABLE conversation_message ADD COLUMN IF NOT EXISTS sats bigint NOT NULL DEFAULT 0`, `actor_account_id uuid REFERENCES account (id)`, and `actor_name text NOT NULL DEFAULT ''` (logged-in staff on a platform send; sender stays the platform account), and `gift_for_message_id uuid` (no foreign key; id of the group message a paid moderator stipend belongs to). Additive `ALTER TABLE conversation_message ADD COLUMN IF NOT EXISTS photo bytea` and `photo_content_type text`, then `CREATE TABLE IF NOT EXISTS conversation_message_extra_photo` (idx 1–9, ON DELETE CASCADE). Then `CREATE TABLE IF NOT EXISTS conversation_message_translation` (PK `(message_id, target_lang)`, FK `conversation_message(id)` ON DELETE CASCADE). Unwrap `DO` block is followed by a last stipend-repair `DO` that backfills `gift_for_message_id` on `moderator_group` house stipend rows written before the column existed (idempotent; links a row only when exactly one message of someone else precedes it within five minutes, leaves an ambiguous row `NULL` without writing it, and never touches a row that already has the column set; skipped until the `db_change` audit trigger is attached; the partial index `conversation_message_gift_unlinked_idx` keeps its per-boot check off a sequential scan). The partial index `conversation_message_nostr_event_unrepaired_idx` supports the nostr-event boot repair's predicate so a converged table can be confirmed without a sequential scan. On every boot, the array runs an idempotent repair unwrapping `conversation_message.nostr_event` values stored as jsonb string scalars (`jsonb_typeof(nostr_event) = 'string'`); it matches no rows once complete. The unwrap is skipped while the `db_change` audit trigger is not attached and retried on the next boot; a row whose value cannot be parsed is skipped with a warning instead of failing the migration. `db_change` attach runs later and covers the new public tables.
- **Inputs:** `SqlClient`.
- **Returns / side effects:** Void; idempotent SQL execute; `docs/schema/conversation.sql` mirrors the DDL and documents the boot repair statements by comment (the `DO $unwrap$` and stipend-repair `DO` blocks live only in `CONVERSATION_SCHEMA_SQL`). After the DDL, rows with `sats > 0` and `fiat_usd IS NULL` are backfilled from `btc_usd_daily` / `usd_fiat_daily` for `created_at`'s UTC day (`satsToUsdCents` / `usdCentsToFiatCents`). No HTTP. Idempotent.
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

## Function: listDbChanges

- **Purpose:** Operator dump of `db_change` newest `at` then `id` first (cap applied by the caller).
- **Inputs:** `SqlClient` and maximum row count.
- **Returns / side effects:** Rows with `id`, ISO `at`, `txid` string, `tableName`, `op`, `before`, `after`. No writes.
- **Used by:** `openBootStores` → `createApp` dump table `db_change`.

## Function: migrateDbChangeSchema

- **Purpose:** Applies `DB_CHANGE_SCHEMA_SQL` in order so durable Postgres row changes are append-logged in `db_change` via AFTER INSERT/UPDATE/DELETE triggers (not from application store methods). On UPDATE, every bytea column (found via `pg_attribute` on `TG_RELID`) whose value is unchanged and was not hashed by `db_change_redact` is stored in both `before` and `after` as an object with `unchanged` true, `sha256` as the hex digest of the column text, and `bytes` as the `octet_length` of that text; INSERT, DELETE and the UPDATE that changes the bytes keep the full value, so any row state is reconstructable by chaining to the latest earlier full image; secret columns keep their sha256 hash; the no-op comparison still happens on the raw images before redaction.
- **Inputs:** `SqlClient`.
- **Returns / side effects:** Void; idempotent SQL matching `docs/schema/db_change.sql` (pgcrypto, table, redact/log/immutable functions, triggers, attach loop). The immutability-guard `DO` drops the append-only trigger once, hashes `view_key` values that still match a live `account.view_key`, leaves non-matches unchanged, then recreates the trigger.
- **Used by:** `openBootStores` when SQL opens, immediately after `migrateFundingSchema` (notification → trust → funding → `db_change`).

## Function: DB_CHANGE_SCHEMA_SQL

- **Purpose:** Ordered idempotent SQL that creates the append-only `db_change` log, secret-redacting helpers, immutability guard (including a one-time live `view_key` rewrite in that same `DO`), and per-table `trg_db_change` triggers on every public table except `db_change`. On UPDATE, every bytea column (found via `pg_attribute` on `TG_RELID`) whose value is unchanged and was not hashed by `db_change_redact` is stored in both `before` and `after` as an object with `unchanged` true, `sha256` as the hex digest of the column text, and `bytes` as the `octet_length` of that text; INSERT, DELETE and the UPDATE that changes the bytes keep the full value, so any row state is reconstructable by chaining to the latest earlier full image; secret columns keep their sha256 hash; the no-op comparison still happens on the raw images before redaction.
- **Inputs:** None (readonly string array constant).
- **Returns / side effects:** Statement texts only; executed by `migrateDbChangeSchema`. Secrets `token`, `challenge`, `nostr_nsec_ciphertext`, `nonce`, `view_key`, `endpoint`, `p256dh`, `auth`, and `delivered_endpoints` become SHA-256 hex in logged JSON; other columns including `name` stay plaintext except unchanged bytea columns on UPDATE. The guard `DO` hashes JSON `view_key` that still equals a live `account.view_key` and leaves other rows unchanged.
- **Used by:** `migrateDbChangeSchema`; documented mirror in `docs/schema/db_change.sql`.

## Function: InMemoryBtcUsdStore

- **Purpose:** In-memory `BtcUsdRateBook` seeded at construction; never HTTP.
- **Inputs:** Optional `ReadonlyMap` or `Record` of day → rate. `ensureDays(days, nowMs)` returns the seed subset for valid requested days. `listDebug(limit)` dumps seeded `{ day, usdPerBtc, source: null, fetchedAt: null }` newest day first.
- **Returns / side effects:** Map of available rates; missing days omitted. No network.
- **Used by:** `createApp` / `giftsStatsRoutes` defaults; memory `openBootStores`.

## Function: InMemoryFiatStore

- **Purpose:** In-memory `FiatRateBook` seeded at construction; never HTTP.
- **Inputs:** Optional `ReadonlyMap` or `Record` of UTC day → `{ CHF?, EUR?, PHP? }`. `ensureDays(days, nowMs)` returns the seed subset for valid requested days. `listDebug(limit)` dumps one `{ day, quote, rate, asOfDay: null, source: null, fetchedAt: null }` per seeded quote, newest day first.
- **Returns / side effects:** Map of available crosses; missing days and empty crosses omitted. No network.
- **Used by:** `createApp` / `giftsRoutes` / `giftsStatsRoutes` defaults; memory `openBootStores`.

## Function: PostgresBtcUsdStore

- **Purpose:** Durable `BtcUsdRateBook` over Postgres: SELECT requested days; fetch+upsert gaps, stale UTC-today (`fetched_at` older than 1h), and after-midnight finalize of an intraday print; skip candle days not requested; still-missing omitted (no throw).
- **Inputs:** Constructor `{ sql, fetchImpl, candlesUrl, source? }`. `ensureDays(days, nowMs)`. `listDebug(limit)` dumps `btc_usd_daily` newest day first (`day`, `usdPerBtc`, `source`, `fetchedAt`).
- **Returns / side effects:** Day → rate map; still-missing days omitted (no throw). Writes `btc_usd_daily`.
- **Used by:** `openBootStores` when SQL opens.

## Function: PostgresFiatStore

- **Purpose:** Durable `FiatRateBook` over Postgres: SELECT requested days; fetch+upsert gaps, stale UTC-today (`fetched_at` older than 1h), and after-midnight finalize of an intraday print from Frankfurter ECB; carry last business-day quote onto closed days (up to 10-day lookback); still-missing quotes omitted (no throw — callers never 503 on fiat).
- **Inputs:** Constructor `{ sql, fetchImpl, ratesUrl, source? }`. `ensureDays(days, nowMs)`. `listDebug(limit)` dumps `usd_fiat_daily` newest day first.
- **Returns / side effects:** Day → USD-cross map; still-missing quotes omitted (no throw). Writes `usd_fiat_daily`.
- **Used by:** `openBootStores` when SQL opens.

## Function: PostgresMessageStore

- **Purpose:** Durable `MessageStore` over Postgres (`message` table plus `message_invoice` and `nostr_zap_ingest`). Nullable `goal_sats` (optional whole-sat ask; SQL null means no goal), nullable `goal_repayable` (`true` or SQL null, never false), and nullable `goal_term_days` (a whole number from 1 to 3650, or SQL null), plus nullable `goal_currency`, `goal_amount`, and `goal_fiat_usd` / `goal_fiat_chf` / `goal_fiat_eur` / `goal_fiat_php` (null on a reply and on a legacy sats-only ask). `addSats` / `recordZapReceipt` leave a fiat column unchanged when extra sats are 0 or that delta is null, assign a non-null delta onto a null column, and add when both sides are set. Nullable `place_lat` / `place_lng` / `place_label` (both coordinates or neither; a reply stores null coordinates). `listPlaces` returns live top-level rows that have both coordinates, newest first. Nullable place columns are selected with the other message columns and inserted on both `create` INSERT shapes (top-level `VALUES` and reply `INSERT … SELECT … WHERE EXISTS`); a non-null `parentId` binds `goal_sats`, `goal_repayable`, and `goal_term_days` SQL null even if the row carried a positive `goalSats`, `goalRepayable` true, or a term; `mapMessageRow` maps it to `goalSats` (`null` when SQL null). `deleteById` removes zap receipts, invoices, child replies, and the row in **one** parameterised data-modifying CTE `query`, then unlinks on-disk videos from the returned rows. `markDeleted` soft-hides via a single UPDATE CTE (`deleted_at` / `deleted_by` on the untagged target and untagged direct replies; never `DELETE FROM message`). `markUndeleted` unhides via a single UPDATE CTE (clears `deleted_at` / `deleted_by` on the hidden target and stamp-matched direct replies; already-live target is a no-op for children; never `DELETE FROM message`). Live-only lists/claims require `deleted_at IS NULL`: `listLatest` is **top-level only** (`WHERE parent_id IS NULL AND deleted_at IS NULL`) with subquery `replyCount` (live attributed direct children, `(child.account_id IS NOT NULL OR (child.author_pubkey IS NOT NULL AND EXISTS (SELECT 1 FROM nostr_zapper z WHERE z.pubkey = lower(child.author_pubkey))))`), selecting Nostr columns plus `(photo IS NOT NULL) AS has_photo`, `deleted_at`, `deleted_by`, and never the `photo` bytea column (HTTP window newest-first; product UX is a messenger group — clients reverse); `listFeed` is the GET `/messages` keyset page (`mode` all/active/unpaid/popular, exclusive cursor, optional `hashtag` token filter on `text`, cap 1–200, same live `replyCount`; WHERE also has the name-copy NOT EXISTS (no photo, no video content type, no extra still, non-empty trim, case-insensitive equality with account.name or message.name), not every profile note; a real About me stays; `active` is paid rows, staff unpaid rows, or `COALESCE(goal_sats, 0) > 0`; `popular` is sats-desc); `listReplies` is oldest-first attributed children (`WHERE parent_id = $1` plus the account-or-zapper predicate; `deleted_at IS NULL` unless `includeHidden === true`); `listChildIds` is `SELECT id FROM message WHERE parent_id = $1` (any `deleted_at`); `listDebug` is operator newest-first **all** rows (`SELECT … FROM message ORDER BY created_at DESC, id DESC LIMIT $1`, no `deleted_at` / `parent_id` filter; never `photo` bytea); `postCountsByUtcDay` groups living rows (`deleted_at IS NULL`) by UTC day, notes and replies together (no `parent_id` filter), omits days with no rows, and returns no media bytes; `listHidden` is staff newest-hidden-first **soft-hidden** rows (`SELECT … FROM message WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC LIMIT $1`; never `photo` bytea); `listDirectChildren` is every direct child including hidden (`SELECT … FROM message WHERE parent_id = $1 ORDER BY created_at ASC, id ASC`); `listPublishedEventIds` returns non-null live top-level `event_id`s newest-first for inbound reply REQ; `findLiveByAccountContent` returns the oldest live row for account+parent+`content_fp`; `accountHasLiveTopLevelPost` (`parent_id IS NULL`, exclude profile id, replies do not count); `accountHasLiveTopLevelMediaPost` (same live/top-level/exclude plus photo 0, extra stills, or video); `latestLiveTopLevelMediaId` (newest live top-level photo or video id, including About me, `ORDER BY created_at DESC, id DESC LIMIT 1`; an empty id is null); `countByAccount` is one `COUNT(*) FILTER` query of live posts (`parent_id IS NULL`) vs replies (`parent_id IS NOT NULL`) for `account_id = $1` and `deleted_at IS NULL` (uncapped; not derived from a list); `countAttributedReplies(parentId)` is that uncapped count of live direct children with an account or a recorded zapper pubkey (0 when the id is unknown); `listPostsByAccount` is newest-first live top-level notes for one account (`WHERE parent_id IS NULL AND deleted_at IS NULL AND account_id = $1`, `LIMIT`, subquery `replyCount` of live direct children matching `(child.account_id IS NOT NULL OR (child.author_pubkey IS NOT NULL AND EXISTS (SELECT 1 FROM nostr_zapper z WHERE z.pubkey = lower(child.author_pubkey))))`); `listRepliesByAccount` is newest-first live replies for one account (`WHERE parent_id IS NOT NULL AND deleted_at IS NULL AND account_id = $1`, `LIMIT`, no `replyCount`); `create(row, photo?, video?, extraPhotos?)` inserts optional photo bytes, optional extra stills into `message_extra_photo` (indices 1..n max 9, ignored when `video` is set, require photo 0 when non-empty), optional `video_content_type` (disk write via `writeForumVideo`; `removeForumVideo` unlink on INSERT failure), and `content_fp` when media is present and `account_id` is not null; `photoCount` is (photo 0 ? 1 : 0) + extras length; a non-null `parent_id` requires a live parent (`deleted_at` null) via `INSERT … SELECT … WHERE EXISTS`; a 0-row insert calls `getById` and returns that row when the id already exists (gift-reply retry after the parent was later deleted), otherwise throws without inserting; on unique violation `23505` it returns the existing row when `getById` matches the inserted id (no video unlink; gift-reply retry), otherwise unlinks the new video and returns the existing live row from `findLiveByAccountContent` when the pin matches; a different pin throws `place conflicts with live media` (the route maps that to 409); `getPhoto` loads bytes by id; `getExtraPhoto(id, index)` / `listExtraPhotos(id)` load extras from `message_extra_photo`; `getById` / `getByEventId` still return soft-hidden rows; `listIdsByPrefix(prefix)` returns at most two stored ids whose lowercase text starts with the prefix (prefix lowercased, not trimmed), including soft-hidden rows, `SELECT id::text AS id … WHERE lower(id::text) LIKE $1 || '%' LIMIT 2`, never photo bytes; `claimUnsigned`/`claimUnpublished` lease live rows (`deleted_at IS NULL`; `claimed_until <= now` is expired; unsigned requires `pending` + null `event_id`); `listPendingSigned` returns live pending rows whose kind:1 lacks `t=bitcoin` (`created_at ASC, id ASC`); `clearSignedEvent` nulls `event_id` / `nostr_event` / `claimed_until` only while `pending` and `event_id` still matches the listed id and no child reply exists (`NOT EXISTS`); `listSignedMissingPhoto` returns published **top-level** live rows (`parent_id IS NULL`, `deleted_at IS NULL`) with a photo whose kind:1 content lacks `/messages/:id/photo.` plus an image extension (`sats = 0`, `nostr_attempts < MAX_PUBLISH_ATTEMPTS` (5, preventing a row that can never satisfy a repair scan from being reset forever), pending excluded so fan-out is not starved, video rows / `video_content_type` excluded so posters are not treated as missing photos, parents with children skipped via `NOT EXISTS`, `created_at ASC, id ASC`); `listSignedMissingVideo` returns published **top-level** live rows (`parent_id IS NULL`, `deleted_at IS NULL`) with `video_content_type` set whose kind:1 content lacks `/messages/:id/video.` (`sats = 0`, `nostr_attempts < MAX_PUBLISH_ATTEMPTS` (5, preventing a row that can never satisfy a repair scan from being reset forever), pending excluded, parents with children skipped via `NOT EXISTS`, `created_at ASC, id ASC`); `listSignedMissingHashtags` returns published unpaid **top-level** live rows (`parent_id IS NULL`, `deleted_at IS NULL`, parents with children skipped via `NOT EXISTS`) whose kind:1 content lacks a `#bitcoin` or `#21gifts` token (next character must not be `[A-Za-z0-9_]`; `sats = 0`, `nostr_attempts < MAX_PUBLISH_ATTEMPTS` (5, preventing a row that can never satisfy a repair scan from being reset forever), pending excluded so fan-out is not starved, includes null / non-string content, `created_at ASC, id ASC`; optional extras map lists rows whose kind:1 also lacks that account's location token; one-arg still bitcoin/21gifts only; optional `excludeIds` applied before the limit so profile notes cannot fill the batch); `resetSignedEvent` nulls `event_id` / `nostr_event` / `claimed_until`, parks `pending`, clears the epoch, increments `nostr_attempts`, and stamps `nostr_first_attempt_at` once, only when `event_id` still matches, `sats` is 0, and no child reply exists (`NOT EXISTS`); `updateSignedEvent` (false on `event_id` collision); `updatePublishState`; `addSats`; `recordZapReceipt` (one statement: `INSERT nostr_zap_receipt ON CONFLICT DO NOTHING` plus `UPDATE message.sats`); `recordInvoiceAttempt` / `listInvoiceAttempts` (each attempt includes `lnurlResponse`: raw LNURL callback JSON object or null); `listRecentOkInvoiceAttempts` (`result = 'ok'` and `created_at >= $1`, same `ORDER BY created_at DESC, id DESC` and `LIMIT` as `listInvoiceAttempts`); `findOkInvoiceByPaymentHash` / `findOkInvoiceByPr` (newest `result = 'ok'` row, `ORDER BY created_at DESC, id DESC LIMIT 1`); `listOpenConversationZapEventIds` (returns `{ eventId, conversationMessageId }[]`, one row per ok invoice so the same event id may repeat; SQL requires non-null `conversation_id` and `conversation_message_id` and `NOT EXISTS` on `conversation_message`); `updateZapReceiptGift` (`UPDATE nostr_zap_receipt` payer / gift-reply / `comment` columns; omitted patch fields are left unchanged; missing event id is a no-op); `getZapReceiptGift` (one receipt by `event_id`); `listZapReceiptsAwaitingGiftReply` (`(payer_account_id IS NOT NULL OR payer_pubkey IS NOT NULL) AND gift_reply_id IS NULL`, `ORDER BY event_id ASC`, includes `comment`); `recordZapIngest` / `listZapIngests`; `listInvoiceAttemptsForPayer` (uncapped `WHERE payer_account_id = $1`, newest-first); `listIndexedZapIngests` (uncapped `WHERE outcome = 'indexed'`); `updateText` (`UPDATE message SET text = $2 WHERE id = $1 RETURNING …`; sats / photos / event ids unchanged; missing id → no row); `listAuthoredMessages` (`WHERE account_id = $1`, including hidden, no LIMIT). `mapMessageRow` keeps `nostr_publish_state` `skipped` (gift-only replies).
- **External-zapper storage:** `nostr_zap_receipt` adds nullable `payer_pubkey text` and `zap_request_id text`, with partial unique index `nostr_zap_receipt_request_uidx` on `zap_request_id WHERE zap_request_id IS NOT NULL`. `nostr_zapper` stores durable visibility entitlement as `pubkey` (primary key), `receipt_event_id`, and `created_at`; it is independent of receipt queue state and is not cleared by `deleteById`. `nostr_blocked_pubkey` is the staff kill-switch table with `pubkey` (primary key), `blocked_at`, `blocked_by`, and `message_id`.
- **External-zapper methods:** `attributeZapReceipt(receiptEventId, { payerPubkey, zapRequestId, comment })` lowercases and stores the payer pubkey, request id, and comment only when the receipt exists, its current request id is null or the same id, and a `NOT EXISTS` check finds no other receipt with that request id. A retry with the same request id on the same receipt is idempotent `true`; a different request id on an already-attributed receipt, reuse by another receipt, or a concurrent partial-index unique violation returns `false`. `recordZapper(pubkey, receiptEventId, at)` lowercases and inserts an entitlement with `ON CONFLICT (pubkey) DO NOTHING`; `listZapperPubkeys()` returns every entitled pubkey; `listZappers(limit)` returns entitlement rows by `created_at DESC, pubkey DESC`. `blockPubkeyAndHideRows(pubkey, at, byAccountId, messageId)` performs that insert-or-skip and case-insensitively updates every live null-account row from the pubkey in one data-modifying CTE query, returning the number hidden; `unblockPubkeyByMessage(messageId)` deletes block rows with that `message_id` and reports whether any row was deleted; `isPubkeyBlocked(pubkey)` lowercases its input and performs a single-row `SELECT 1` lookup; `isZapperPubkey(pubkey)` lowercases its input and performs a single-row `SELECT 1 FROM nostr_zapper` lookup; `listBlockedPubkeys()` returns every blocked pubkey; `listBlockedPubkeyRows(limit)` returns block rows by `blocked_at DESC, pubkey DESC`. `listUnattributedIndexedReceipts(limit, before?)` joins each otherwise-unattributed receipt to its newest indexed `nostr_zap_ingest` frame (`payer_account_id`, `payer_pubkey`, `zap_request_id`, and `gift_reply_id` all null), orders by immutable ingest `created_at DESC, event_id DESC`, and applies an optional strict `{ createdAt, eventId }` keyset cursor. Unlike an `OFFSET` over a result set whose membership changes as receipts are attributed, the cursor cannot skip or repeat rows for that reason.
- **Payment claims:** `claimZapPayment` inserts into `nostr_zap_payment` with `ON CONFLICT (payment_hash) DO NOTHING` and then compares the stored `receipt_event_id`: a new row or the same owner returns `true`, another owner `false`. The table has no foreign key to `message` and is not part of the `deleteById` statement, so the claim outlives the forum row. Insert and lookup failures propagate.
- **Backfill interaction:** The schema backfill clears `nostr_attempts` only for rows whose double-encoded `nostr_event` it successfully unwraps, because that repair removes the root cause and grants a fresh repair budget; successful publishing does not clear the cap.
- **Inputs:** Constructor takes a shared boot `SqlClient` (already migrated). Operator dump: `listExtraPhotoMeta(limit)`, `listZapReceipts(limit)`, and `listZapPayments(limit)` newest-first (cap 200). `countAttributedReplies(parentId)` is that uncapped count of live direct children with an account or a recorded zapper pubkey (0 when the id is unknown).
- **Returns / side effects:** Parameter-bound SQL; maps snake_case rows to `MessageRow` / `ForumPhoto` / invoice and ingest rows. Claim uses `FOR UPDATE SKIP LOCKED`. Errors propagate to the route (503) except invoice/ingest persist failures which are caught by callers.
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: PostgresContactStore

- **Purpose:** Durable `ContactStore` over Postgres (`contact` table). `listLatest` is newest-first with a limit; `create` inserts the row.
- **Inputs:** Constructor takes a shared boot `SqlClient` (already migrated).
- **Returns / side effects:** Parameter-bound SQL; maps snake_case rows to `ContactRow`. Errors propagate to the route (503).
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: PostgresConversationStore

- **Purpose:** Durable `ConversationStore` over Postgres (`conversation` + `conversation_message` + `conversation_read` + `conversation_message_extra_photo`). Open-or-create per counterpart kind, list visible threads, `hasInboundMessage` (EXISTS matching inbound = `conversationIsInbound`), `hasUnread` (parameter-bound EXISTS over `conversation_message` joined to `conversation_read`: `created_at` strictly greater than `last_read_at`, or no last-read row), `countUnread` (parameter-bound `COUNT(*)::bigint` with the same JOIN and inbound/last-read rules; maps bigint/string/number, else 0), `markRead` (`INSERT … ON CONFLICT … DO UPDATE` on `(account_id, conversation_id)`), `appendMessage(row, photo?, extraPhotos?)`, `getPhoto(id)`, `getExtraPhoto(id, index 1–9)`, claim unsigned/unpublished wraps, unique `event_id`. `listThreadPage` selects the newest page with `created_at DESC, id DESC`, applies an exclusive older `created_at` + `id` cursor when present, then reverses a copy so the page is returned oldest-first. `listMessages` remains oldest-first. `openMemberPlatform` updates `account_b` when an existing member→platform thread points at a different platform id. `retargetMemberPlatform` bulk-updates `account_b` on every `member_platform` row whose `account_a` is not the new platform id. `ensureModeratorGroup` opens or inserts the closed `moderator_group` singleton. Unique partial index `conversation_moderator_group_uidx`. `listVisible` binds `$5` moderator flag. `mapMessage` keeps `skipped`. `MESSAGE_SELECT` uses computed `has_photo` / `photo_count` (never lists photo bytea). Extra stills live in `conversation_message_extra_photo`.
- **Inputs:** Constructor takes a shared boot `SqlClient` (already migrated). `hasInboundMessage(conversationId, viewerId, staff, platformId)` is parameter-bound EXISTS over `conversation_message`. `countUnread(conversationId, viewerId, staff, platformId)` is parameter-bound `COUNT(*)::bigint` with the same JOIN as `hasUnread`. `listVisible(accountId, staff, platformId, limit, moderator = false)` passes `$5` as the moderator flag. `getModeratorGroup` selects `kind = 'moderator_group'`. `unreadCount` forwards the optional 4th `moderator` flag to `listVisible` and pins an existing `moderator_group` first. `appendMessage(row, photo?, extraPhotos?)` binds photo 0 on the message row and extras at indices 1–9. `getPhoto(id)` / `getExtraPhoto(id, index 1–9)` return byte copies or null (index outside 1–9 is null with no query). Operator dump: `listAll(limit)` / `listAllMessages(limit)` / `listAllReads(limit)` (cap 200).
- **Returns / side effects:** Parameter-bound SQL; maps snake_case rows to `ConversationThread` / `ConversationMessageRow`. Unique violations on open/append are swallowed as idempotent (duplicate `id` / `eventId` returns the existing row without inserting extras). Extra-photo insert failure after a successful message insert `DELETE`s that message and rethrows. Errors otherwise propagate to the route (503). `mapMessage` keeps `nostr_publish_state` `skipped` (does not remap to `pending`).
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

- **Purpose:** Process-local AuthStore: passkey challenges/credentials, accounts, sessions, verifications, and custodial Nostr keys (`getNostrPublicKey` / `getNostrSecret` / `setNostrKeyIfAbsent` / `listAccountIdsWithoutNostrKey` / `listStaffAccountIds`). `listStaffAccountIds` returns ids at the moderator rank or above (`verified` and `basis` omitted, order unspecified). Evicts expired challenges/sessions on write. Indexes `linkingKey` only when non-null. Maintains an O(1) `viewKey` index; `getAccountByViewKey` looks it up. `getAccountByLightningAddress` scans for a `lower(trim)` match and skips null addresses. `getAccountByPubkey` scans `#nostrKeys` for a case-insensitive hex match (`trim`; empty → `undefined`). `listIdsByPrefix(prefix)` returns at most two stored ids whose lowercase form starts with the prefix (prefix not trimmed). `updateAccountNameByLightningAddress` mutates only `name` on the matched account (`lower(trim)`); other fields stay unchanged; unknown address → `undefined`. `markWalletBackupSeen(accountId, now)` sets only `walletBackupSeenAt` when it is still null (other columns unchanged; unknown id → `undefined`; returns `{ account, wrote }` with `wrote` true only on that first write). `setAccountLocale` and `setAccountFiat` write only that field; `onlyIfUnset` returns the stored row with `wrote` false when it is already set, and writes when it is null or omitted; unknown id → `undefined`. `accountHasPasskey` is true when any credential maps to the account id. `getPasskeyCredentialForAccount` returns the newest credential for the account (`createdAt` desc, then `credentialId` desc) or `undefined`. `addSeedPasskeyCredential` inserts a second credential, sets `walletRequired` true, and does not delete or change `walletBackupSeenAt`. `replacePasskeyCredential` deletes the current row and inserts the new one (false when none exists or the new id belongs to another account). `createAccount` is a no-op when `viewKey` is already stored, a non-null `linkingKey` already exists, or `lightningAddress` (`lower(trim)`) belongs to another id. `updateAccount` reindexes `viewKey` when it changes and refuses a `viewKey`, non-null `linkingKey`, or `lightningAddress` owned by another id; it never writes `sessionRefused`, `walletRequired`, `walletBackupSeenAt`, `locale`, or `fiat` from the incoming object (the stored values stay). `tryCreateSession` writes only when the account exists and `sessionRefused` is not true. `setSessionRefused` writes only that flag. `claimProfileMessageId(accountId, expectedId, nextId)` sets only `profileMessageId` when `(stored ?? null) === (expectedId ?? null)` (`undefined` and `null` both match `expectedId === null`); does not touch viewKey/linkingKey indexes; returns true on win, false on unknown id or mismatch. `createAccount` / `updateAccount` with `isPlatform: true` call `#clearPlatformExcept` so every other account's `isPlatform` is false (at most one platform account). `deleteAccount` drops the row and its linking-key and viewKey indexes. `listAccounts` returns every account oldest-first. `listNostrKeys` returns one row per stored account. Missing `#nostrKeys` entry → `pubkey` null, empty ciphertext, `kekId` 1, custody `custodial`, `createdAt` null.
- **Inputs:** Constructor none. Methods take domain objects (`PasskeyChallenge`, `PasskeyCredential`, `Account`, `Session`, `AddressVerification`). `createAccount` is a no-op when a non-null `linkingKey` already exists, when `viewKey` is already stored, or when `lightningAddress` (`lower(trim)`) is taken. `updateAccount` refuses a `linkingKey` / `viewKey` / `lightningAddress` owned by another account and keeps the viewKey index consistent. `claimProfileMessageId(accountId, expectedId, nextId)` sets only `profileMessageId` when `(stored ?? null) === (expectedId ?? null)` (`undefined` and `null` both match `expectedId === null`); does not touch viewKey/linkingKey indexes; returns true on win, false on unknown id or mismatch. `updateAccountNameByLightningAddress(lightningAddress, name)` takes the address and new display name. `deleteAccount` drops the row and its linking-key and viewKey indexes. `createPasskeyCredential` returns false when this account already has a credential or the id is taken. `createFirstPasskeyCredential` returns false when this account already has a credential, the id is taken, the account is missing, or `sessionRefused`; on success it stores the credential and sets `walletRequired: true` in the same method. `updatePasskeyCredential` returns false unless `(newCount === 0 && stored === 0)` or `newCount > stored`; missing id is false; does not rebind `accountId` / `publicKey`. `updatePasskeyChallenge` returns false when the row is missing or already consumed.
- **Returns / side effects:** Lookups return the object or `undefined`. Writes resolve when persisted. `listAccounts` returns `Account[]`. Operator dump lists: `listPasskeyCredentials`, `listSessions`, `listPasskeyChallenges`, `listAddressVerifications`, `listNostrKeys`.
- **Used by:** `createApp` default store; all auth/me/debug/view routes.

## Function: PostgresAuthStore

- **Purpose:** Durable AuthStore over Postgres (`SqlClient`). Same eviction-on-write semantics as the in-memory adapter, including passkey challenges, credentials, custodial Nostr key columns, and the `view_key` column. `listNostrKeys` is `SELECT id, nostr_pubkey, nostr_nsec_ciphertext, nostr_kek_id, nostr_key_custody, nostr_key_created_at FROM account` with **no** `WHERE nostr_pubkey IS NOT NULL`; maps null pubkey; `kekId` `?? 1`; custody ternary `'user'` else `'custodial'`. `getAccountByViewKey` is `WHERE view_key = $1`. `getAccountByLightningAddress` is `WHERE lower(trim(lightning_address)) = lower(trim($1))` (null addresses do not match). `getAccountByPubkey` is `WHERE lower(nostr_pubkey) = lower(trim($1))`. `listIdsByPrefix` is `SELECT id::text AS id FROM account WHERE lower(id::text) LIKE $1 || '%' LIMIT 2` (prefix lowercased, not trimmed; at most two ids). `listStaffAccountIds` is `SELECT id FROM account WHERE role IN ('founder', 'moderator', 'initiator')`. `updateAccountNameByLightningAddress` is `UPDATE account SET name = $2 WHERE lower(trim(lightning_address)) = lower(trim($1)) RETURNING …` (other columns unchanged; empty `RETURNING` → `undefined`). `markWalletBackupSeen` is `UPDATE account SET wallet_backup_seen_at = to_timestamp($2::double precision / 1000.0) WHERE id = $1 AND wallet_backup_seen_at IS NULL RETURNING …`; empty `RETURNING` then `SELECT … WHERE id = $1`; returns `{ account, wrote }` or `undefined` (unknown id or unmappable `view_key`). `setAccountLocale` is `UPDATE account SET locale = $2 WHERE id = $1` plus `AND locale IS NULL` when `onlyIfUnset` is true, then the same empty-`RETURNING` `SELECT`; `setAccountFiat` is the same for `fiat`. Both return `{ account, wrote }` or `undefined`. `accountHasPasskey` is `SELECT 1 FROM passkey_credential WHERE account_id = $1 LIMIT 1`. Methods match `AuthStore` including `getAccountByViewKey`, `getAccountByLightningAddress`, `getAccountByPubkey`, `updateAccountNameByLightningAddress`, `accountHasPasskey`, `getPasskeyCredentialForAccount` (`ORDER BY created_at DESC, credential_id COLLATE "C" DESC LIMIT 1`), `markWalletBackupSeen` then `replacePasskeyCredential`, `claimProfileMessageId`, `tryCreateSession`, and `setSessionRefused`. `replacePasskeyCredential` is one statement: `WITH deleted AS (DELETE … WHERE account_id = $4 RETURNING credential_id) INSERT … SELECT … WHERE EXISTS (SELECT 1 FROM deleted) RETURNING credential_id`. `mapAccount` skips null `view_key` (`getAccount` / `getAccountByViewKey` / `getAccountByLightningAddress` / `getAccountByPubkey` / `updateAccountNameByLightningAddress` return undefined; `listAccounts` omits those rows) and sets `isPlatform` true only when `is_platform` is true. Passkey `signCount` advances with an atomic `WHERE` (`0/0` or `new > stored`) `RETURNING`, not `GREATEST`; duplicate credential ids are `ON CONFLICT DO NOTHING`. `createPasskeyCredential` inserts only when that account has no credential yet (`WHERE NOT EXISTS`) and `ON CONFLICT (credential_id) DO NOTHING`; a duplicate credential id does not raise `23505`. There is no unique index on `account_id`. `createFirstPasskeyCredential` locks the account row (`FOR UPDATE` where `session_refused IS NOT TRUE` and `wallet_required IS NOT TRUE`, so a waiter sees the first claim's flag and inserts nothing), inserts only when that account has no credential (`WHERE NOT EXISTS`), then `UPDATE account SET wallet_required = TRUE` from the inserted row; empty `RETURNING` or unique_violation is false. `createAccount` INSERT unique_violation `23505` is a no-op. `updateAccount` refuses a `linkingKey` owned by another id (`UPDATE` matches no row; unique_violation `23505` is a no-op). `claimProfileMessageId` is `UPDATE account SET profile_message_id = $3 WHERE id = $1 AND profile_message_id IS NOT DISTINCT FROM $2 RETURNING id` via `query` (not `execute`); true iff a row is returned. `updateAccount` writes the other columns including `amount_unit` (`$18`) and does not set `session_refused`, `wallet_required`, `wallet_backup_seen_at`, `locale`, or `fiat`. `tryCreateSession` is `INSERT … SELECT … WHERE session_refused IS NOT TRUE RETURNING token`. `setSessionRefused` is `UPDATE account SET session_refused = $2 WHERE id = $1 RETURNING …`. Before `createAccount` / `updateAccount` when `isPlatform === true`, `UPDATE account SET is_platform = false WHERE is_platform AND id <> $1` so at most one platform account remains (partial unique `account_is_platform_uidx`). INSERT/UPDATE write `is_platform`. `deleteAccount` is `DELETE FROM account WHERE id = $1`. Unique index on `lower(trim(lightning_address))` where the address is not null.
- **Inputs:** Constructor takes a `SqlClient`. Methods match `AuthStore` including `getAccountByViewKey`, `getAccountByLightningAddress`, `getAccountByPubkey`, `updateAccountNameByLightningAddress`, `accountHasPasskey`, `claimProfileMessageId`, `tryCreateSession`, `setSessionRefused`, and operator dump lists (`listPasskeyCredentials`, `listSessions`, `listPasskeyChallenges`, `listAddressVerifications`, `listNostrKeys`). `claimProfileMessageId` is `UPDATE account SET profile_message_id = $3 WHERE id = $1 AND profile_message_id IS NOT DISTINCT FROM $2 RETURNING id` via `query` (not `execute`); true iff a row is returned. `updateAccount` writes `amount_unit` (`$18`) and does not write `session_refused`, `wallet_required`, `wallet_backup_seen_at`, `locale`, or `fiat`. `setAccountLocale` and `setAccountFiat` are the only writers of those columns.
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
- **Returns / side effects:** Void; creates `account`, `auth_session`, `address_verification`, `passkey_challenge`, `passkey_credential`; drops leftover `auth_challenge`; backfills `account.name` / nullable `linking_key`; adds `nostr_pubkey` / nsec ciphertext / kek id / custody plus unique index and CHECK; adds `view_key` ALTER, uuid-concat backfill, and unique index; adds nullable `rules_agreed_at`; unique index `account_lightning_address_uidx` on `lower(trim(lightning_address))` where not null; `DROP INDEX IF EXISTS passkey_credential_account_uidx` so a login passkey may stay beside one later seed passkey; adds `is_platform boolean NOT NULL DEFAULT false` and unique index `account_is_platform_uidx` on `(is_platform) WHERE is_platform`; adds nullable `name_skipped_at`, `lightning_address_skipped_at`, and `profile_message_id uuid` (**no** FK to `message` here — message migrates later); adds nullable `location text` (no unique index, same as `name`); adds `notification_level text NOT NULL DEFAULT 'all'` plus `DROP`/`ADD` `account_notification_level_chk` (`all` / `active` / `mentions`); adds `amount_unit text NOT NULL DEFAULT 'btc'` plus `DROP`/`ADD` `account_amount_unit_chk` (`btc` / `fiat`); adds nullable `locale text` and `fiat text` with no value backfill, plus `DROP`/`ADD` `account_locale_chk` (`en` / `de` / `es` / `fil`, or null) and `account_fiat_chk` (`CHF` / `EUR` / `USD` / `PHP`, or null); adds nullable `username text`; `DROP INDEX IF EXISTS account_username_uidx` then `CREATE UNIQUE INDEX IF NOT EXISTS account_username_uidx` on `lower(trim(username))` WHERE username IS NOT NULL AND trim(username) <> '' (expression unique index); adds `session_refused boolean NOT NULL DEFAULT false`; adds `wallet_required boolean NOT NULL DEFAULT false` and nullable `wallet_backup_seen_at timestamptz`; then `UPDATE account SET role = 'initiator' WHERE lower(trim(username)) = 'pater-severin' AND role = 'moderator'` (no-op unless that row is still moderator).
- **Used by:** `openAuthStore`.

## Function: openAuthStore

- **Purpose:** Chooses in-memory vs Postgres AuthStore from `DATABASE_URL`.
- **Inputs:** URL or blank/undefined; `createClient` factory required when the URL is set (boot supplies Bun SQL; tests inject a mock).
- **Returns / side effects:** `InMemoryAuthStore` if unset (no username backfill); otherwise migrate the auth schema, `backfillAccountUsernames`, then return `PostgresAuthStore`. Throws if the URL is set without a factory.
- **Used by:** `openBootStores`.

## Function: openBootStores

- **Purpose:** Shared `DATABASE_URL` wiring: one `SqlClient` for durable auth, FX tables, `QueryGiftStore`, `SqlGiftRecorder`, `PostgresBtcUsdStore`, `PostgresFiatStore`, `migrateMessageSchema`, `PostgresMessageStore`, `PostgresTranslationStore` (forum `message_translation`) plus a second `PostgresTranslationStore` aimed at `conversation_message_translation` (`conversationTranslationStore`; never the forum store instance), `migrateContactSchema`, `PostgresContactStore`, `migratePosSchema`, `PostgresPosStore`, `migrateConversationSchema`, `PostgresConversationStore`, `migratePushSchema`, `PostgresPushStore`, `migrateNotificationSchema`, `PostgresNotificationStore`, `migrateTrustSchema`, `migrateFundingSchema`, `PostgresTrustStore`, `PostgresFundingStore`, `migrateApiLogSchema`, `PostgresApiLogStore`, `PostgresDebugDbStore`, `migrateDbChangeSchema`, and parsed `NOSTR_NSEC_KEK`; or in-memory auth, `giftStore`/`giftRecorder`/`messageStore`/`translationStore`/`conversationTranslationStore`/`contactStore`/`conversationStore`/`notificationStore`/`pushStore`/`trustStore`/`fundingStore`/`apiLogStore`/`listDbChange`/`debugDbStore` undefined, `nostrKek` undefined, empty `InMemoryBtcUsdStore`, and empty `InMemoryFiatStore` when unset.
- **Inputs:** `databaseUrl`; optional `createClient` (required when URL set); optional `fx: { fetchImpl, candlesUrl, frankfurterUrl, now, nostrQuerier, zapRelayUrls, nostrRelayTimeoutMs }` so tests avoid the network (`candlesUrl` defaults via `resolveCandlesUrl(process.env)`; `frankfurterUrl` defaults via `resolveFrankfurterUrl(process.env)`; the last three feed `backfillExternalZappers` and default to a `WebsocketNostrQuerier`, `resolveZapRelays(process.env)` and a 5000 ms per-relay timeout). SQL path reads `process.env.NOSTR_NSEC_KEK`.
- **Returns / side effects:** `{ authStore, giftStore, giftRecorder, btcUsdRates, fiatRates, messageStore, translationStore, conversationTranslationStore, contactStore, posStore, conversationStore, notificationStore, pushStore, trustStore, fundingStore, apiLogStore, nostrKek, listDbChange, debugDbStore }`. Migrates `btc_usd_daily` then `usd_fiat_daily`, `message`, `contact`, `pos_charge` (via `migratePosSchema`), `conversation` (via `migrateConversationSchema`), `push_subscription`/`push_outbox` (via `migratePushSchema`), `notification` (via `migrateNotificationSchema` after push before `db_change`), then `trust_edge` (via `migrateTrustSchema`) after notification, then `funding_grant` (via `migrateFundingSchema`), then `api_log` (via `migrateApiLogSchema`) immediately before `migrateDbChangeSchema` so `trg_db_change` attaches to `trust_edge`, `funding_grant`, and `api_log`, then `db_change` after auth migrate; best-effort `fillRatesForGiftRange` logs `gifts.fx.boot_fill.failed` and does not throw; best-effort `fillFiatRatesForGiftRange` logs `gifts.fx.fiat_boot_fill.failed` and does not throw. Throws if the URL is set without a factory, or if the SQL path has a missing/malformed KEK. SQL path returns `SqlGiftRecorder`, `PostgresMessageStore`, `PostgresTranslationStore` (forum) plus a second `PostgresTranslationStore` on `conversation_message_translation`, `PostgresContactStore`, `PostgresPosStore`, `PostgresConversationStore`, `PostgresNotificationStore`, `PostgresPushStore`, `PostgresFiatStore`, `PostgresTrustStore`, `PostgresFundingStore`, `PostgresApiLogStore`, and `PostgresDebugDbStore`; memory path returns `giftRecorder`/`messageStore`/`translationStore`/`conversationTranslationStore`/`contactStore`/`conversationStore`/`notificationStore`/`pushStore`/`trustStore`/`fundingStore`/`apiLogStore`/`listDbChange`/`debugDbStore`/`nostrKek` undefined, returns a fresh `InMemoryPosStore` as `posStore`, and skips migrates including `migratePosSchema` / `migrateConversationSchema` / `migratePushSchema` / `migrateNotificationSchema` / `migrateTrustSchema` / `migrateFundingSchema` / `migrateApiLogSchema` / `migrateDbChangeSchema`. SQL path calls `migratePosSchema` for `pos_charge` before `PostgresPosStore`.
- **Payment and external-zapper backfills:** Only after `migrateDbChangeSchema` has attached `trg_db_change` to every public table (so the payment backfill's `nostr_zap_payment` inserts are logged), constructs `PostgresMessageStore`, runs `backfillZapPayments`, and immediately runs `backfillExternalZappers` before constructing the remaining Postgres stores and returning. The external-zapper backfill pages through unattributed receipts with a 10,000-row ceiling and logs `nostr.zapper.backfill.done` with its aggregate counts; a failure logs `nostr.zapper.backfill.failed` and boot continues. Payment-backfill failures still propagate. In-memory boots call neither backfill.
- **Used by:** `src/index.ts` boot.

## Function: bearerMatchesDebugToken

- **Purpose:** Constant-time compare of `DEBUG_TOKEN` against `Authorization: Bearer`.
- **Inputs:** Configured token (non-empty) and raw header or `undefined`.
- **Returns / side effects:** `true` only on an exact Bearer match (trim on the presented token).
- **Used by:** `debugRoutes`, `debugContactsRoutes`, `debugApiLogRoutes`, `debugDbRoutes`, `debugMessagesRoutes`, `debugPaymentsRoutes`, `debugPushRoutes`, `debugTrustRoutes`, `debugCatalogRoutes`, `resolveRequestAuth`.

## Function: compareAccountsForList

- **Purpose:** Sort key for `listAccounts`: older `createdAt` first, then `id` ascending.
- **Inputs:** Two `Account` values.
- **Returns / side effects:** Negative / positive / 0.
- **Used by:** `InMemoryAuthStore.listAccounts`.

## Function: debugRoutes

- **Purpose:** Operator listing, provisioning, role assignment, Lightning Address unlink, official platform-flag retarget, session-refusal (`sessionRefused`), and minting a member bearer via `POST /:id/session`.
- **Inputs:** `DebugRouteDeps`: store, optional debugToken, required `fetchImpl` (NIP-57 mint probe on new POST addresses), optional `conversationStore` (`PATCH platform: true` calls `retargetMemberPlatform`), optional `messageStore`, `pushStore`, and `notificationStore` (POST provision calls `ensureProfileMessage` when `messageStore` is set), optional `now` for minted debug sessions.
- **Returns / side effects:** Hono app (`GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `POST /:id/session`). Shared 503 if token unset; 401 if bearer mismatches. GET 200 `{ accounts }` via `serializeDebugAccount` (includes `isPlatform`, `sessionRefused`, `viewKey`, `walletRequired`, `walletBackupSeenAt`, and Nostr debug fields) logs `debug.accounts.listed` with count. GET `/:id` 200 `serializeDebugAccountDetail` or 404. POST body `{ accounts: [{ name, lightningAddress }] }` → 400 invalid body (including C0/DEL names or non-LUD-16 addresses after the shape check; no row is written); probes **all** new addresses first (`probeNip57Mint`) unless `NIP57_PROBE=0` (Playwright e2e skip; production must not set this); any `not_zap` / `unreachable` is 400 and no new address in that request is saved; name-only updates run only after every probe has passed; 500 `{ error: 'Could not save the account' }` when create does not persist the address, the name-only update matches no row, or the name-only update returns a row whose `name` is not the requested name; creates by Lightning Address, or for an existing address updates **only** `name` via `updateAccountNameByLightningAddress`; when `messageStore` is set, POST then calls `ensureProfileMessage` (optional `pushStore` and `notificationStore`) (keeps `viewKey` / `role` / other columns); returns `{ accounts: [{ name, lightningAddress, viewKey, created }] }`; logs `debug.accounts.provisioned` with created/updated counts (never viewKeys or the token). PATCH body `{ role }` and/or `{ lightningAddress: null }` and/or `{ platform: true|false }` and/or `{ sessionRefused: true|false }` → 400 unknown/missing; 404 missing account; 200 `serializeDebugAccount` of the updated row (includes `isPlatform`, `sessionRefused`, `viewKey`, `walletRequired`, `walletBackupSeenAt`, and Nostr debug fields); unlink also `deleteVerification` and logs `debug.accounts.lightning_address.cleared`; role changes log `debug.accounts.role_set` with account id and role; `platform: true` uniquely retargets (store clears any other `isPlatform`), points every member→platform thread at the new account via `retargetMemberPlatform` when `conversationStore` is set, and logs `debug.accounts.platform_set`; `sessionRefused` is written only via `setSessionRefused` (not `updateAccount`) and logs `debug.accounts.session_refused_set`. POST `/:id/session` 404 unknown id; 403 `{ error: 'You signed in with the wrong account. Please try again with the correct account.' }` when `sessionRefused` is true or `tryCreateSession` writes no row, with no `debug.accounts.session_minted` and no member bearer; otherwise 200 `{ token }` and `debug.accounts.session_minted`. Never logs the token or the previous address.
- **Used by:** `createApp` at `/debug/accounts`.

## Function: debugContactsRoutes

- **Purpose:** Operator listing of private in-app contacts (includes `accountId`).
- **Inputs:** `DebugContactsRouteDeps`: contact store, optional debugToken.
- **Returns / side effects:** Hono app. 503 if token unset; 401 if bearer mismatches; 200 `{ contacts }` newest-first (cap 200); 503 on store throw (`contact.list.failed`). Logs `debug.contacts.listed` with count, never the token.
- **Used by:** `createApp` at `/debug/contacts`.

## Function: debugMessagesRoutes

- **Purpose:** Operator read of every persisted forum row (including soft-hidden notes and replies) plus hidden photo bytes and extra stills (`GET /:id/photo/:file`, indices 1–9; hidden with that extra is 200), restore of a missing forum-video file for an already-existing message with `hasVideo` (raw body under `MEDIA_DIR`; no new message id, no DB create), and unhide of a soft-hidden row (`POST /:id/restore` via `markUndeleted`, followed by `unblockPubkeyByMessage`; 204 empty body; cascade inverse of `markDeleted`; already-live id is still 204). Restoring the source row whose hide created an external-pubkey block lifts that block; restoring another row hidden by the block's cascade only unhides that row, leaves the pubkey blocked, and must be repeated for each cascaded row. Public hide does not apply to the GETs. Unhide is `DEBUG_TOKEN` only — not a moderator session.
- **Inputs:** `DebugMessagesRouteDeps`: message store, optional debugToken.
- **Returns / side effects:** Hono app exposing `GET /`, `GET /:id`, `GET /:id/photo`, `GET /:id/photo/:file`, `PUT /:id/video`, and `POST /:id/restore`. Shared 503 if token unset/blank; 401 if bearer mismatches. GET `/` 200 `{ messages }` via `listDebug` / `serializeDebugMessage` (cap 200) logs `debug.messages.listed` with count. GET `/:id` 200 debug JSON (hidden is 200) logs `debug.messages.get` with `messageId`; non-UUID or missing 404 `{ error: 'Not found' }`. GET `/:id/photo` 200 image bytes (hidden with a photo is 200; same Content-Type / Content-Disposition / CORS as public photo) logs `debug.messages.photo.get` with `messageId`; missing row / no photo / bad id 404 `{ error: 'Photo not found' }`. GET `/:id/photo/:file` 200 extra still (indices 1–9; hidden with that extra is 200); missing/no extra/non-UUID/bad file 404 `{ error: 'Photo not found' }`. PUT 404 for non-UUID or unknown id; 409 when the row has no video or the decoded MIME extension does not match the stored type; 400 for empty/oversize/unrecognized body; 204 after `writeForumVideo`. POST `/:id/restore` 404 for non-UUID or missing id; 204 empty body after `markUndeleted` (hidden or already live); logs `debug.messages.restored` with `{ messageId }` only (never text, never `deletedBy`). 503 `{ error: 'Messages are unavailable' }` when a store call or `writeForumVideo` throws (`debug.messages.list_failed` / `debug.messages.get_failed` / `debug.messages.photo.get_failed` / `debug.messages.video.put_failed` / `debug.messages.restore_failed`). Logs `debug.messages.video.put` with `messageId` and `bytes`, never the token, nsec, or raw bytes.
- **Used by:** `createApp` at `/debug/messages`.

## Function: debugPaymentsRoutes

- **Purpose:** Operator listing of all `message_invoice` attempts (forum and conversation invoices; JSON includes `conversationId` and `conversationMessageId`), manual forum-invoice settlement, and kind:9735 ingest decisions (`nostr_zap_ingest`).
- **Inputs:** `DebugPaymentsRouteDeps`: message store, auth store, clock, optional push/notification stores, optional `spendPing` and optional `fundingStore` (forwarded to `settleInvoiceManually` for platform-note compose; spend pings use the same `eligibleToday` gate as `POST /messages`), and optional debugToken. Does not take `postLimiter`; DEBUG_TOKEN settle is not the shared post burst limiter.
- **Returns / side effects:** Hono app. 503 if token unset; 401 if bearer mismatches; 200 `{ invoices }` on `GET /invoices`, `{ receiptId, messageId, amountSats, resumed }` on `POST /invoices/settle`, and `{ ingests }` on `GET /zap-ingests`. Manual settle accepts `{ paymentHash, note, preimage? }` and delegates to `settleInvoiceManually`; store throws, including the direct ingest write, map to 503. Listing is newest-first (cap 200). Logs list/settle results without token, note, preimage, or nsec.
- **Used by:** `createApp` at `/debug`.

## Function: inspectBolt11

- **Purpose:** Decode BOLT11 payment hash, amount, plaintext description, description_hash, and expiry for operator debug (does not change `decodeBolt11`).
- **Inputs:** BOLT11 string; optional decoder inject for tests.
- **Returns / side effects:** `InspectedBolt11` or `null` when malformed, zero-amount, or the amount is not a safe integer.
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
- **Inputs:** Constructor none. Methods match `PushStore` (`upsertSubscription` keeps original `createdAt` on endpoint conflict; `claimPending` leases oldest pending; `markFailed` fails at 8 attempts; `recordDelivered` unions unique endpoint URLs onto the outbox row). Operator dump: `listAllSubscriptions()` newest `createdAt` then `endpoint` DESC; `listAllOutbox(limit)` newest `createdAt` then `id` DESC.
- **Returns / side effects:** Caller-owned copies including `deliveredEndpoints` slices; mutating results does not change the store. No I/O.
- **Used by:** `createApp` default `pushStore`; memory `src/index.ts` when boot omits SQL push.

## Function: InMemoryNotificationStore

- **Purpose:** Process-local `NotificationStore` for in-app forum post, reply, zap, moderator appointment, and open moderator-proposal notifications. Default empty so the process boots without a database. `deleteByMessageIds` removes rows whose `parentId` or `replyId` is in the id list (any type). `deleteByTypeAndReplyId` removes rows whose `type` and `replyId` both match. Mark-read skips `moderator_proposal`.
- **Inputs:** Optional seed `NotificationRow[]` (copied). `create` is unique on `(recipientAccountId, type, replyId)` and returns the existing row on duplicate. `listByRecipient(accountId, limit)` is newest `createdAt` then `id` DESC. `unreadCount` is total unread (`readAt === null`), not page length. `markRead` / `markAllRead` stamp unread rows only except `moderator_proposal` (left unread). `deleteByMessageIds(ids)` is a no-op for empty `ids`. `deleteByTypeAndReplyId(type, replyId)` returns the removed count. Operator dump: `listAll(limit)` newest-first (cap 200).
- **Returns / side effects:** Promise of row copies; mutating results does not change the store. No I/O.
- **Used by:** `createApp` default `notificationStore`; memory `openBootStores` omits it.

## Function: PostgresPushStore

- **Purpose:** Durable `PushStore` over Postgres (`push_subscription`, `push_outbox`). Same port semantics as the in-memory adapter, including claim leases, attempt counting, and `recordDelivered` for successful endpoint URLs.
- **Inputs:** Constructor takes a shared boot `SqlClient` (already migrated via `migratePushSchema`). Operator dump: `listAllSubscriptions` (`ORDER BY created_at DESC, endpoint DESC`); `listAllOutbox(limit)` newest `created_at` then `id`.
- **Returns / side effects:** Parameter-bound SQL; maps snake_case rows to domain objects including `delivered_endpoints` JSON. Errors propagate to callers.
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: PostgresNotificationStore

- **Purpose:** Durable `NotificationStore` over Postgres (`notification`). Same port as the in-memory adapter: unique create, newest-first list, total unread count, get/mark-one/mark-all for the recipient only (mark-read / mark-all skip `type = 'moderator_proposal'`), `deleteByMessageIds` (`parent_id` or `reply_id` in the id list; the ids are bound as one `uuid[]` array-literal string built from well-formed UUIDs only, because the driver does not encode a JavaScript array for `$1::uuid[]`), and `deleteByTypeAndReplyId` (`DELETE FROM notification WHERE type = $1 AND reply_id = $2 RETURNING id`).
- **Inputs:** Constructor takes a shared boot `SqlClient` (already migrated via `migrateNotificationSchema`). Operator dump: `listAll(limit)` newest-first (cap 200).
- **Returns / side effects:** Parameter-bound SQL; maps snake_case rows to `NotificationRow`. Unique violation re-selects the existing row. Errors propagate to the route (503).
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: enqueueForumPushes

- **Purpose:** Enqueue one forum notification per bell subscriber except the skip id (`authorId`). Payload URL is `/notifications`; tag is `forum_post:<messageId>`.
- **Inputs:** `PushStore`, `authorId` (skip id / post actor), `messageId` (forum post id; outbox id and payload tag), `nowMs`. Payload from `buildForumPushPayload` with name `Someone`, text `''`, and no media flags.
- **Returns / side effects:** One pending `type: 'forum'` outbox row per other subscriber account. Does not send HTTP push itself.
- **Used by:** Unit tests; production path is `notifyForumPost`.

## Function: enqueueReplyPush

- **Purpose:** Enqueue one reply notification per bell subscriber except the skip id. Payload URL is `/notifications`; tag is `forum_reply:<messageId>` (the reply id, not the parent).
- **Inputs:** `PushStore`, `authorId` (skip id / reply actor), `messageId` (reply row; outbox id and payload tag), `parentId` (unused; kept for call-site compatibility), `nowMs`. Payload from `buildReplyPushPayload` with name `Someone`, text `''`, and no media flags.
- **Returns / side effects:** One pending `type: 'forum'` outbox row per other subscriber account. No-op when nobody else is subscribed.
- **Used by:** Unit tests; production path is `notifyForumReply`.

## Function: enqueueZapPush

- **Purpose:** Enqueue one zap notification per bell subscriber except the skip id. `authorId` is the payer skip id, not “notify only this author”. The note author is notified unless they are the skip id.
- **Inputs:** `PushStore`, `authorId` (skip id / payer), `messageId` (tag id; also stored as outbox `messageId`), `nowMs`. Payload from `buildZapPushPayload` with name `Someone` and `amountSats: 0`.
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

- **Purpose:** English forum-post payload for every bell subscriber except the actor (`type: 'forum'`, title the collapsed display name or `Someone` when blank, at most 80 code points, body the note text on one line at most 180 code points, or `Posted a photo and a video.` / `Posted a photo.` / `Posted a video.` / `Posted in the living room.` when the text is empty, url `/notifications`, tag `forum_post:<postId>`). Shared template: omits optional `unreadCount` (fan-out adds notification unread + listed inbox unread per recipient).
- **Inputs:** `{ postId, name, text, hasPhoto?, hasVideo? }`. `postId` is the tag id. Blank `name` becomes `Someone`. Empty `text` uses the photo/video sentence (`hasPhoto` / `hasVideo` count only when `=== true`; omitted means false). Non-empty text wins over media flags.
- **Returns / side effects:** `PushPayload` object without `unreadCount`; callers `JSON.stringify` before enqueue/send.
- **Used by:** `enqueueForumPushes`, `notifyForumPost`.

## Function: buildReplyPushPayload

- **Purpose:** English forum-reply payload for every bell subscriber except the actor (`type: 'forum'`, same title rule as a forum post, body the reply text on one line at most 180 code points, or `Replied with a photo and a video.` / `Replied with a photo.` / `Replied with a video.` / `Replied in the living room.` when the text is empty, url `/notifications`, tag `forum_reply:<replyId>`; not the parent id). Shared template: omits optional `unreadCount` (fan-out adds it per recipient).
- **Inputs:** `{ replyId, name, text, hasPhoto?, hasVideo? }`. `replyId` is the reply forum message id (`tag` / collapse key). Omitted media flags are false (`=== true` only). Non-empty text wins over media flags.
- **Returns / side effects:** `PushPayload` object without `unreadCount`; callers `JSON.stringify`.
- **Used by:** `enqueueReplyPush`, `notifyForumReply`.

## Function: buildZapPushPayload

- **Purpose:** English zap payload for every bell subscriber except the payer skip id (`type: 'zap'`, title the collapsed payer name or `Someone` when blank, body `Sent <amountSats> sats.` with no thousands separator, url `/notifications`, tag `zap:<messageId>`). Shared template: omits optional `unreadCount` (fan-out adds it per recipient).
- **Inputs:** `{ messageId, name, amountSats }`. `messageId` is used only in `tag` (receipt UUID on the `notifyZap` path). `amountSats` is rendered with `String` and no thousands separator.
- **Returns / side effects:** `PushPayload` object without `unreadCount`; callers `JSON.stringify` before enqueue/send.
- **Used by:** `enqueueZapPush`, `notifyZap`.

## Function: buildModeratorAppointedPushPayload

- **Purpose:** English payload for the appointed subject only (not a living-room fan-out). `type: 'forum'` (outbox CHECK is forum|zap|conversation), title `You are a moderator`, body `You were appointed a moderator in the living room.`, url `/welcome`, tag `moderator_appointed:<subjectId>`. Shared template omits optional `unreadCount` (`notifyModeratorAppointed` merges notification unread + listed inbox unread when either source is passed).
- **Inputs:** `subjectId` string used in `tag`.
- **Returns / side effects:** `PushPayload` object without `unreadCount`; callers `JSON.stringify`.
- **Used by:** `notifyModeratorAppointed`.

## Function: buildConversationPushPayload

- **Purpose:** English private-message payload for one 21.gifts bell subscriber (`type: 'conversation'`, title sender `name` or `21.gifts` when empty, body message text, url `/messages?c=<conversationId>` when `url` is omitted or empty, tag `conversation:<conversationId>`). Optional `url` (non-empty) overrides the inbox path (`notifyConversationMessage` passes `/moderate/group` for `moderator_group`). Shared template: omits optional `unreadCount` (`notifyConversationMessage` adds notification unread + listed inbox unread).
- **Inputs:** `{ conversationId, name, text, url? }`.
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

## Function: buildKind5Event

- **Purpose:** Unsigned NIP-09 `kind: 5` template for one kind:1 event id (`content` empty; tags exactly `e` then `k=1`). One event id per event so different authors cannot share a deletion.
- **Inputs:** `eventId` (hex), `createdAtUnix` (unix seconds from the hide clock).
- **Returns / side effects:** `{ kind: 5, content: '', tags: [['e', eventId], ['k', '1']], created_at }`. No I/O.
- **Used by:** `retractHiddenForumNotes`.

## Function: listDirectChildren

- **Purpose:** Direct children of one parent (`parent_id` match), including hidden, Damus-only (`accountId` null), and gift-only rows. Oldest `createdAt` then `id`. Missing parent → `[]`.
- **Inputs:** `parentId` (message id).
- **Returns / side effects:** `Promise<MessageRow[]>` copies (InMemory `copyRow`; Postgres `SELECT … FROM message WHERE parent_id = $1 ORDER BY created_at ASC, id ASC`). No `deleted_at` filter.
- **Used by:** `retractHiddenForumNotes`.

## Function: retractHiddenForumNotes

- **Purpose:** After staff hide, best-effort NIP-09 for the target and each direct child with a non-empty `eventId` and non-null `accountId` (signed with that row's custodial nsec), then one combined Cloudflare files purge of public media URLs. Missing target is a no-op. Relays are durability space first plus unique public URLs, not gated on `NOSTR_PUBLISH*`. Gift-only and Damus-only rows skip kind:5. Sign/publish/purge failures log `messages.delete.nostr_failed` / `messages.delete.purge_failed` with `{ messageId }` only (never nsec, token, or post text) and do not throw.
- **Inputs:** `RetractHiddenForumNotesDeps` (`store`, `authStore`, `publisher`, `kek`, `now`, `env`, `fetchImpl`) and `targetId`.
- **Returns / side effects:** `Promise<void>`. Publishes via `NostrPublisher.publish` (`RELAY_TIMEOUT_MS`). Purges when `CLOUDFLARE_ZONE_ID` + `CLOUDFLARE_API_TOKEN` resolve and `PUBLIC_BASE_URL` is non-empty (`forumMediaPurgeUrls` + `purgeCloudflareFiles` in chunks of 30).
- **Used by:** `messagesRoutes` (`DELETE /messages/:id`).

## Function: resolveCloudflarePurgeConfig

- **Purpose:** Optional Cloudflare purge credentials. Both `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_API_TOKEN` must be non-empty after trim; otherwise `null`. Does not throw; missing values skip purge and do not fail boot.
- **Inputs:** `env` record.
- **Returns / side effects:** `{ zoneId, token }` or `null`. No I/O.
- **Used by:** `retractHiddenForumNotes`.

## Function: forumMediaPurgeUrls

- **Purpose:** Absolute public photo/video URLs to purge for one forum row. Empty `apiBase` → `[]`. Trailing slash stripped. Photo 0 (`hasPhoto` or `photoCount > 0`) includes `/photo` plus `.jpg` / `.jpeg` / `.png` / `.webp`. Extra stills when `photoCount >= 2` are indices `1 .. photoCount-1` with those four extensions. Video adds `.mp4` / `.webm` / `.mov`. Dedupe keeps first-seen order.
- **Inputs:** `apiBase` (already resolved public API origin), `row` (`MessageRow`; bytes never read).
- **Returns / side effects:** `string[]`. No I/O.
- **Used by:** `retractHiddenForumNotes`.

## Function: purgeCloudflareFiles

- **Purpose:** POST Cloudflare `purge_cache` for `urls` in chunks of 30. Empty list is a no-op. HTTP not 200, non-JSON body, or JSON `success !== true` throws a generic `Cloudflare purge failed` (never includes the token).
- **Inputs:** `fetchImpl`, `{ zoneId, token }`, `urls`.
- **Returns / side effects:** `Promise<void>`. POST `https://api.cloudflare.com/client/v4/zones/{zoneId}/purge_cache` with `Authorization: Bearer {token}`.
- **Used by:** `retractHiddenForumNotes`.

## Function: markDeleted

- **Purpose:** Soft-hide a forum note and every untagged **direct** reply by stamping `deletedAt` / `deletedBy` (Postgres columns `deleted_at` / `deleted_by`). Does not hard-delete rows, media, invoices, zap receipts, or gifts; does not call `deleteById`. An already-tagged target keeps its original stamps; untagged direct replies get this call's `at` / `byAccountId`. Live public JSON never exposes the stamps; staff GET of a hidden row may include them.
- **Inputs:** `id` (message id string), `at` (`Date`, cloned onto newly tagged rows), `byAccountId` (staff account id recorded as `deletedBy`).
- **Returns / side effects:** `Promise<boolean>` — `false` when no row has that id; `true` when the id exists (already tagged or newly tagged). In-memory mutates store rows; Postgres uses one UPDATE CTE (`deleted_at IS NULL` on the target and direct children).
- **Used by:** `messagesRoutes` (`DELETE /messages/:id`).

## Function: markUndeleted

- **Purpose:** Unhide a forum note by clearing `deletedAt` / `deletedBy` (Postgres columns `deleted_at` / `deleted_by`). Inverse of `markDeleted`'s cascade: when the target is hidden, also clears every **direct** child whose stamps match the target's (same instant and same staff) before the target is cleared. Already-live targets are a no-op for children. Does not hard-delete rows, media, invoices, zap receipts, or gifts; does not call `deleteById`; does not recreate via `POST /messages`. Live public JSON never exposes the stamps; staff GET of a hidden row may include them.
- **Inputs:** `id` (message id string).
- **Returns / side effects:** `Promise<boolean>` — `false` when no row has that id; `true` when the id exists (hidden or already live). In-memory mutates store rows; Postgres uses one UPDATE CTE (`IS NOT DISTINCT FROM` stamp match on direct children).
- **Used by:** `debugMessagesRoutes` (`POST /debug/messages/:id/restore`).

## Function: setPlace

- **Purpose:** Write only the three place columns (`place_lat` / `place_lng` / `place_label`) on an existing forum row. Does not change text, event ids, hide stamps, sats, media, or publish state.
- **Inputs:** `id` (message id string) and `place` (`ForumPlace | null`).
- **Returns / side effects:** `Promise<boolean>` — `true` when the id existed and the three columns were written; `false` when no row has that id. `null` stores SQL NULL / in-memory `place: null`. No other column changes.
- **Used by:** `messagesRoutes` (`PATCH /messages/:id/place`).

## Function: textHasHashtagToken

- **Purpose:** Whether `text` contains a `#name` hashtag token. Match is case-insensitive and the token must not be followed by `[A-Za-z0-9_]`, so `#21GiftsShopper` does not match `21GiftsShop`.
- **Inputs:** `text` string and `name` (token without the leading `#`).
- **Returns / side effects:** `boolean`. No I/O. `#21giftsshop` matches `21GiftsShop`; `#21GiftsShopper` does not.
- **Used by:** `messagesRoutes` (`PATCH /messages/:id/place`).

## Function: isPubkeyBlocked

- **Purpose:** Check the current external-pubkey kill switch without loading the complete block list. Input is lowercased before lookup in both stores.
- **Inputs:** External Nostr `pubkey` string.
- **Returns / side effects:** `Promise<boolean>` with no writes. In-memory checks one map key; Postgres performs `SELECT 1 FROM nostr_blocked_pubkey WHERE pubkey = $1 LIMIT 1`.
- **Used by:** `indexInboundForumReplies` after external profile lookup and immediately before limiter acquisition, so a concurrent block wins without consuming ingest budget.

## Function: InMemoryMessageStore

- **Purpose:** Process-local `MessageStore` for the public member forum. Default empty so the process boots without a database. Optional `place` is `{ lat, lng, label }` or null; a reply stores `place: null`. A live media match with the same pin returns the existing row; a different pin throws `place conflicts with live media` (the route maps that to 409). `listPlaces` returns live top-level rows that have both coordinates, newest first. Photos live in a private map, not on listed rows. Extra stills (indices 1–9) live in a second private map (`getExtraPhoto` / `listExtraPhotos`); `create(row, photo?, video?, extraPhotos?)` stores extras (indices 1..n max 9, ignored when `video` is set, require photo 0 when non-empty); `photoCount` is (photo 0 ? 1 : 0) + extras length. Same port as Postgres: `getById` (still returns soft-hidden rows), `listIdsByPrefix(prefix)` (at most two stored ids whose lowercase form starts with the prefix, prefix not trimmed, including soft-hidden rows), `deleteById` (row, direct replies, photos, invoices, zap receipt ids, on-disk videos), `markDeleted` (stamps `deletedAt` / `deletedBy` on the target and untagged direct replies; never removes media/invoices), `markUndeleted` (clears `deletedAt` / `deletedBy` on the hidden target and stamp-matched direct children; already-live is a no-op for children; never removes media/invoices), `listDirectChildren` (direct children including hidden, createdAt then id), `getByEventId`, `findLiveByAccountContent` (oldest live account+parent+`contentFp`), `accountHasLiveTopLevelPost` (`parentId === null`, exclude profile id, replies do not count), `accountHasLiveTopLevelMediaPost` (same live/top-level/exclude plus photo 0, extra stills, or video; seed `hasPhoto: true` alone is not media), `latestLiveTopLevelMediaId` (newest live top-level id with a stored photo, extra stills, or video, including About me; replies, hidden rows, and other accounts do not count), live-only `listLatest` (top-level, `parentId` null and `deletedAt` null, each row has live `replyCount` of children with an account or a recorded zapper pubkey), live-only `listFeed` (GET `/messages` keyset page, optional `hashtag`; `createApp` calls `useProfileNoteIds` so `listFeed` omits name-copy ids returned by that provider (a real About me id is not included; `account.profileMessageId`, trimmed, blank ignored); a store with no provider does not omit them), `listReplies` (children with an account or a recorded zapper pubkey; live-only unless `includeHidden === true`), `listChildIds` (direct child ids, any `deletedAt`), `countByAccount` (uncapped live post/reply totals for one account), `countAttributedReplies(parentId)` is that uncapped count of live direct children with an account or a recorded zapper pubkey (0 when the id is unknown), live-only `listPostsByAccount` (newest-first top-level for one account, cap, live `replyCount` of children with an account or a recorded zapper pubkey), live-only `listRepliesByAccount` (newest-first replies for one account, cap, no `replyCount`), `listDebug` (operator newest-first **all** rows: top-level and replies, live and soft-hidden), `postCountsByUtcDay` (living rows only, `deletedAt` null, notes and replies together, grouped by UTC day, days with no rows omitted, no media bytes), `listHidden` (staff newest-hidden-first hidden rows only, `deletedAt` desc then `id` desc), `listDirectChildren` (direct children including hidden, createdAt then id), live-only `listPublishedEventIds`, claim/sign/publish (`claimUnsigned` / `claimUnpublished` skip soft-hidden; unsigned is pending + null `eventId`; lease expires at `claimedUntil`), live-only `listPendingSigned` (pending, no `t=bitcoin`, oldest-first), `clearSignedEvent` (pending and `eventId` still matches `expectedEventId` and the note has no child replies, then nulls `eventId` / `nostrEvent` / `claimedUntil`), live-only `listSignedMissingPhoto` (top-level only, no children, published + photo, kind:1 content lacks `/messages/:id/photo.` plus extension, oldest-first, `sats === 0`, `nostrAttempts < MAX_PUBLISH_ATTEMPTS` (5, preventing a row that can never satisfy a repair scan from being reset forever), pending excluded, video rows excluded so posters are not treated as missing photos), live-only `listSignedMissingVideo` (top-level only, no children, published + video MIME, kind:1 content lacks `/messages/:id/video.`, oldest-first, `sats === 0`, `nostrAttempts < MAX_PUBLISH_ATTEMPTS` (5, preventing a row that can never satisfy a repair scan from being reset forever), pending excluded), live-only `listSignedMissingHashtags` (top-level only, no children, published unpaid, kind:1 content lacks a `#bitcoin` or `#21gifts` token, oldest-first, `sats === 0`, `nostrAttempts < MAX_PUBLISH_ATTEMPTS` (5, preventing a row that can never satisfy a repair scan from being reset forever), pending excluded so fan-out is not starved; optional extras map lists rows whose kind:1 also lacks that account's location token; one-arg still bitcoin/21gifts only; optional `excludeIds` applied before the limit so profile notes cannot fill the batch), `resetSignedEvent` (nulls `eventId` / `nostrEvent` / `claimedUntil`, parks `pending`, clears `nostrPublishEpoch`, increments `nostrAttempts`, and stamps `nostrFirstAttemptAt` once, no-op unless `eventId` still matches, `sats` is 0, and the note has no child replies), `addSats` / `recordZapReceipt` leave a fiat column unchanged when extra sats are 0 or that delta is null, assign a non-null delta onto a null column, and add when both sides are set; `recordZapReceipt` (duplicate receipt id does not add sats; ids are released on `deleteById` so the same receipt can be recorded again), `recordInvoiceAttempt` / `listInvoiceAttempts` (each attempt includes `lnurlResponse` object or null), `listRecentOkInvoiceAttempts` (same filter and order as the Postgres query: `result === 'ok'` and `createdAt >= since`, newest-first with `id` descending tie-break), `findOkInvoiceByPaymentHash` / `findOkInvoiceByPr` (newest `result === 'ok'` by payment hash / BOLT11 `pr`), `listOpenConversationZapEventIds` (returns `{ eventId, conversationMessageId }[]`, one row per ok invoice with both conversation id and conversation message id so the same event id may repeat; no `conversation_message` join — existence filter is in `indexOpenZapReceipts`), `updateZapReceiptGift` (patch payer / gift-reply id / comment; missing receipt is a no-op; omitted patch fields stay), `getZapReceiptGift` (one receipt including comment and gift-reply id), `listZapReceiptsAwaitingGiftReply` (`payerAccountId` or `payerPubkey` set and no gift reply yet, cap, `receiptEventId` ASC, includes `comment`), `recordZapIngest` / `listZapIngests`, `listInvoiceAttemptsForPayer` (uncapped payer filter, newest-first), `listIndexedZapIngests` (uncapped, `outcome = indexed` only), `listAuthoredMessages` (all rows for one account including hidden, no cap), `updateText(id, text)` (mutates `text` only and returns a copy; sats / photos / event ids unchanged; missing id → `undefined`); `create` returns the existing row when `id` is already stored (including after that row's parent was later deleted); a non-null `parentId` requires a live parent (`deletedAt` null), stores `goalSats`, `goalRepayable`, `goalTermDays`, `goalCurrency`, `goalAmount`, and the four goal fiat snapshots null even if the row carried an ask, and throws without appending when the parent is missing or soft-hidden; `updateSignedEvent` returns false on duplicate `eventId`. Store/HTTP order is newest-first; product UX is a messenger group (clients reverse).
- **External-zapper methods:** `attributeZapReceipt(receiptEventId, { payerPubkey, zapRequestId, comment })` returns `false` when the receipt is missing, when that receipt already has a different request id, or when another receipt in the map already has that request id. A retry with the same request id on the same receipt is idempotent `true`; otherwise it lowercases and stores the payer pubkey, request id, and comment. `recordZapper(pubkey, receiptEventId, at)` lowercases the pubkey and stores the first row in a private map that `deleteById` and receipt queue updates do not clear; `listZapperPubkeys()` returns its keys; `listZappers(limit)` sorts copied rows by `createdAt DESC, pubkey DESC` and caps them. `blockPubkeyAndHideRows(pubkey, at, byAccountId, messageId)` performs the same insert-or-skip and synchronously scans every live null-account row for a case-insensitive author match, stamps it, and returns the hidden count as one store operation; `unblockPubkeyByMessage(messageId)` removes the first matching map entry and reports whether one was found; `isPubkeyBlocked(pubkey)` lowercases its input and checks that map; `isZapperPubkey(pubkey)` lowercases its input and checks the zapper map; `listBlockedPubkeys()` returns the map keys; `listBlockedPubkeyRows(limit)` sorts copied rows by `blockedAt DESC, pubkey DESC` and caps them. `listUnattributedIndexedReceipts(limit, before?)` returns one row per receipt-map entry whose `payerAccountId`, `payerPubkey`, `zapRequestId`, and `giftReplyId` are all null, paired with its newest indexed ingest frame (`createdAt` DESC, then `id` DESC, matching the SQL `JOIN LATERAL … LIMIT 1`), sorts by immutable ingest `createdAt DESC, receiptEventId DESC`, applies an optional strict `{ createdAt, eventId }` keyset cursor and the cap, and returns copies. Unlike an offset over a changing unattributed set, the cursor cannot skip or repeat rows as attribution removes entries.
- **Payment claims:** `claimZapPayment` keeps one owner receipt id per lowercase payment hash in a process-local map. The same receipt id may claim again; another id is refused. `deleteById` does not remove the claim, so a re-created message id cannot be credited twice for one payment.
- **Inputs:** Optional seed `MessageRow[]` (copied; `hasPhoto` defaults false; missing `deletedAt` / `deletedBy` become null). Operator dump: `listExtraPhotoMeta(limit)`, `listZapReceipts(limit)`, and `listZapPayments(limit)` newest-first (cap 200). `listLatest(limit)` is live top-level only with live `replyCount` of children with an `accountId`, or with an `authorPubkey` that is a recorded zapper. `listFeed(query)` is a live top-level keyset page (`mode` / `limit` / exclusive `cursor` / `staffAccountIds` (`active` only) / optional `hashtag` token filter on `text`, cap 1–200, same live `replyCount` as `listLatest`; `createApp` calls `useProfileNoteIds` so `listFeed` omits name-copy ids returned by that provider (a real About me id is not included; `account.profileMessageId`, trimmed, blank ignored). A store with no provider does not omit them. `active` keeps paid rows, staff unpaid rows, and top-level rows with `goalSats` > 0). `listReplies(parentId, limit?, includeHidden?)` is oldest-first children with an `accountId`, or with an `authorPubkey` that is a recorded zapper (default 200; live-only unless `includeHidden === true`). `listChildIds(parentId)` returns direct child ids (any `deletedAt`). `countByAccount(accountId)` is uncapped live `{ postCount, replyCount }` for that author. `countAttributedReplies(parentId)` is that uncapped count of live direct children with an account or a recorded zapper pubkey (0 when the id is unknown). `listPostsByAccount(accountId, limit)` is newest-first live top-level for that author with live `replyCount` of children with an `accountId`, or with an `authorPubkey` that is a recorded zapper (cap). `listRepliesByAccount(accountId, limit)` is newest-first live replies for that author (cap, no `replyCount`). `listDebug(limit)` is newest-first all rows including hidden and replies. `postCountsByUtcDay()` groups living rows (`deletedAt` null), notes and replies together, by UTC day and omits empty days. `listHidden(limit)` is newest-hidden-first hidden rows only (`deletedAt` desc, then `id` desc). `listPublishedEventIds(limit)` is newest-first non-null live top-level `eventId`s. `create(row, photo?, video?, extraPhotos?)` returns the stored row when `id` is already present (no append, no second video write) even if that row's parent was later deleted; a non-null `parentId` requires a live parent (`deletedAt` null), stores `goalSats`, `goalRepayable`, `goalTermDays`, `goalCurrency`, `goalAmount`, and the four goal fiat snapshots null even if the row carried an ask, and throws without appending when the parent is missing or soft-hidden; otherwise appends a copy, or returns the existing live media match without a second video write when the pin matches; a different pin throws `place conflicts with live media`; extras indices 1..n max 9, ignored when `video` is set, require photo 0 when non-empty; `getPhoto(id)` returns a photo copy or null; `getExtraPhoto(id, index)` / `listExtraPhotos(id)` return extra stills from the private map; `photoCount` is (photo 0 ? 1 : 0) + extras length; `markDeleted(id, at, byAccountId)` returns false when missing; `markUndeleted(id)` returns false when missing.
- **Returns / side effects:** Promise of row/photo copies; mutating results does not change the store. Listed objects never expose bytes or `contentFp`. When `id` is new, `video` is set, and no live fingerprint match exists, `create` awaits `writeForumVideo` (disk under `MEDIA_DIR`); if that write throws, the row is never pushed (no unlink).
- **Used by:** `createApp` default `messageStore`.

## Function: accountHasLiveTopLevelMediaPost

- **Purpose:** Whether `accountId` has at least one live top-level forum row that is not `excludeId` and has media (photo 0, extra stills, or video). Same live / top-level / exclude / Damus-null-account rules as `accountHasLiveTopLevelPost`. InMemory: `#photos.has(id)` or extras length > 0 or `row.hasVideo === true` (seed `hasPhoto: true` alone is not media). Postgres: `photo IS NOT NULL` or non-empty `video_content_type` or `EXISTS` extra still. Replies do not count.
- **Inputs:** `accountId` (author account id), `excludeId` (auto profile note id, or `null` to exclude nothing extra).
- **Returns / side effects:** `Promise<boolean>`. InMemory scans rows; Postgres `SELECT 1 … LIMIT 1` with params `[$1 accountId, $2 excludeId]`.
- **Used by:** `invoiceRoutes` (`GET /posted` `hasMedia`).

## Function: latestLiveTopLevelMediaId

- **Purpose:** Newest live top-level photo or video id for one account, including the About-me note. Not capped by the public list size. Replies, soft-hidden rows, and other accounts do not count. InMemory matches a stored photo, extra stills, or `hasVideo` (seed `hasPhoto: true` alone is not media) and sorts `createdAt` then `id` descending. Postgres selects `photo IS NOT NULL`, a non-empty `video_content_type`, or an extra still, `ORDER BY created_at DESC, id DESC LIMIT 1`.
- **Inputs:** `accountId` (author account id).
- **Returns / side effects:** `Promise<string | null>`. Empty or missing id is `null`. No writes.
- **Used by:** `syncWelcomePing`, `invoiceRoutes` (`GET /posted` `welcomeHasMedia` / `welcomeMessageId`), and `fundingRoutes` (`POST /funding/trial` and `POST /funding/admit` from effective pending).

## Function: InMemoryContactStore

- **Purpose:** Process-local `ContactStore` for the private in-app mailbox. Default empty so the process boots without a database.
- **Inputs:** Optional seed `ContactRow[]` (copied). `listLatest(limit)` sorts newest `createdAt` then `id` DESC and caps at `limit`. `create(row)` appends a copy.
- **Returns / side effects:** Promise of row copies; mutating results does not change the store. No I/O.
- **Used by:** `createApp` default `contactStore`.

## Function: InMemoryConversationStore

- **Purpose:** Process-local `ConversationStore` for member↔member, member↔platform, member↔Damus, and closed `moderator_group` singleton threads. Default empty so the process boots without a database. `listThreadPage` takes the newest page in descending `createdAt` + `id` order, applies an exclusive older cursor when present, then reverses it so the returned page is oldest-first; `listMessages` remains oldest-first. `hasInboundMessage` is inbound = `conversationIsInbound`. `hasUnread` is inbound `conversationIsInbound` with `createdAt` strictly greater than last-read (missing stamp = never read). `countUnread` uses the same inbound/last-read predicate and returns the matching message count (`0` when none). `markRead` upserts a private last-read map keyed by accountId + conversationId (Dates copied on construct and store). `ensureModeratorGroup` opens or inserts the singleton (`accountA` = platform; `accountB` and `counterpartPubkey` null). `listVisible` 5th arg `moderator` defaults false. `visibleTo` returns `moderator === true` for that kind first (the `moderator` flag decides, not the staff/platform-id branch; callers pass `roleAtLeast(role, 'moderator')`). `appendMessage(row, photo?, extraPhotos?)` stores photo 0 and extras (indices 1–9, max 9; extras require photo 0). `getPhoto(id)` / `getExtraPhoto(id, index 1–9)` return copies from private maps (bytes never on listed rows).
- **Inputs:** Optional seed threads and messages (copied). Optional third constructor seed of last-read rows is copied. Open helpers are idempotent per unique counterpart. `openMemberPlatform` updates `accountB` when the stored platform id differs. `retargetMemberPlatform` points every member→platform thread at the new official account except rows whose member is that account. `listVisible(accountId, staff, platformId, limit, moderator = false)` is newest `lastMessageAt` then `id` DESC. `hasInboundMessage` is true when any message on that conversation id is inbound for the viewer (`conversationIsInbound`). `countUnread` is the inbound unread message count on that conversation id (`0` when none). `unreadCount(accountId, staff, platformId, moderator = false)` uses the same list filter as GET `/conversations` (including `moderator_group` when the 4th arg is true). `appendMessage(row, photo?, extraPhotos?)` copies stills; `getPhoto(id)` and `getExtraPhoto(id, index 1–9)` look up those copies (index outside 1–9 is null). Operator dump: `listAll(limit)` / `listAllMessages(limit)` / `listAllReads(limit)` (cap 200).
- **Returns / side effects:** Promise of copies; mutating results does not change the store. Duplicate `id` or `eventId` append returns the existing row without inserting extras. Listed rows expose `hasPhoto` / `photoCount` (0–10), never photo bytes. No I/O.
- **Used by:** `createApp` default `conversationStore`.

## Function: InMemoryLnAddressCache

- **Purpose:** TTL cache for successful LUD-16 metadata resolves.
- **Inputs:** `get(address, now)`, `put(entry, now)`. TTL from `LN_ADDRESS_CACHE_TTL_MS`.
- **Returns / side effects:** `get` returns `CachedLnAddress` or `null`.
- **Used by:** `lightningAddressRoutes`.

## Function: InMemoryGiftStore

- **Purpose:** Process-local GiftStore seeded at construction. Default empty so the process boots without a database.
- **Inputs:** Optional `GiftRow[]`. `listOutbound()` copies and sorts by `paidAt`. `listDebug(limit)` dumps stored gift fields newest `paidAt` first (cap).
- **Returns / side effects:** Promise of rows. Does not mutate the seed array.
- **Used by:** `createApp` default `giftStore`.

## Function: mapGiftQueryRow

- **Purpose:** Maps a SQL `gift` row (`paid_at`, `amount_sats`, `recipient_wos_user`, `kind`) onto a `GiftRow`. An unknown or missing `kind`, including `'other'`, throws `Error('invalid gift kind')` and is not treated as `daily`.
- **Inputs:** `GiftQueryRow` (Date or string timestamp; numeric/string/bigint sats; `kind` text).
- **Returns / side effects:** `{ paidAt, amountSats, recipientWosUser, kind }` with `kind` one of `daily`, `welcome`, or `moderator`. No I/O.
- **Used by:** Production `QueryGiftStore` query in `openBootStores`.

## Function: QueryGiftStore

- **Purpose:** GiftStore that delegates `listOutbound` to an injected stats query and optional `listDebug` to a full-column dump query (Postgres in production).
- **Inputs:** `() => Promise<GiftRow[]>` plus optional `() => Promise<GiftDebugRow[]>`.
- **Returns / side effects:** `listOutbound` is the stats query result. `listDebug(limit)` uses the dump query when set (full `gift` columns, newest `paidAt` first, then sliced to `limit`); otherwise it maps `listOutbound` onto debug rows. Errors propagate to the route (503).
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

## Function: syncWelcomePing

- **Purpose:** Tell spend a verified account is owed the one-time 1 USD welcome gift. The note is the newest live top-level photo or video, including About me. Pass one account after a top-level post, an About-me save, or a verification. Pass the auth store with no account to catch up every already verified account that has a live top-level photo or video, whether that note is About me or a living-room post. The process does that on boot and every 15 minutes. Omitted spend ping, a role other than `verified`, a blank Lightning Address, or no media is a no-op. Spend pays once per address.
- **Inputs:** `{ spendPing?, messages, account?, auth? }`. `account` wins over `auth`.
- **Returns / side effects:** `Promise<void>`. May POST spend `kind: "welcome"`. Failures log `spend.ping.failed` and do not throw.
- **Used by:** `POST /messages`, `PUT /me/about`, `POST /trust/verify`, and the process catch-up on boot and every 15 minutes.

## Function: resolveSpendPing

- **Purpose:** Resolve a spend ping collaborator from env. Unset or blank `SPEND_URL` or `SPEND_API_TOKEN` → `undefined` (caller skips). Trims both values and strips trailing slashes from the URL. The process still boots.
- **Inputs:** `env` (`Record<string, string | undefined>`) and `fetchImpl` (`FetchFn`).
- **Returns / side effects:** `HttpSpendPing` when both env values are set; otherwise `undefined`. No HTTP.
- **Used by:** `createApp`.

## Function: HttpSpendPing

- **Purpose:** POST `{ address, messageId }` (omitted/`daily`), `{ address, messageId, kind: "welcome" }` (`'welcome'`), or `{ address, kind: "moderator", groupMessageId }` (no `messageId` key) to `{spendUrl}/ping` with Bearer `SPEND_API_TOKEN`. 2xx logs `spend.ping.ok`. Network, abort, and non-2xx log `spend.ping.failed` and resolve. Never throws. Never logs the token.
- **Inputs:** Constructor `{ spendUrl, token, fetchImpl, timeoutMs? }` (already-trimmed base URL, no trailing slash; default timeout 5000 ms). `ping(address, messageId, kind?: 'daily' | 'moderator' | 'welcome')`. omitted/`daily` → `{ address, messageId }` (no `kind` key); `'welcome'` → `{ address, messageId, kind: "welcome" }`; `'moderator'` → `{ address, kind: "moderator", groupMessageId: messageId }` without a `messageId` key.
- **Returns / side effects:** `Promise<void>`. HTTP POST; logs `spend.ping.ok` or `spend.ping.failed`.
- **Used by:** `resolveSpendPing`.

## Function: NoopSpendPing

- **Purpose:** `SpendPing` that ignores address, `messageId`, and optional kind — used when tests inject a collaborator that must not call HTTP.
- **Inputs:** `ping(_address, _messageId, _kind?: 'daily' | 'moderator' | 'welcome')`. Accepts optional 3rd arg, ignores it.
- **Returns / side effects:** Resolves immediately. No HTTP.
- **Used by:** Tests.

## Function: decodeBolt11

- **Purpose:** Read payment hash and millisat amount from a BOLT11 string via `light-bolt11-decoder`.
- **Inputs:** `pr` string; optional test decoder.
- **Returns / side effects:** `{ paymentHash, amountMsat }` or `null` on any decode failure (malformed, zero-amount, or an amount that is not a safe integer).
- **Used by:** `invoiceRoutes` after LNURL-pay returns `pr`.

## Function: InMemoryInvoiceStore

- **Purpose:** Process-local store of gift invoices issued for the spend worker. `GiftInvoice` may include optional `messageId`, `groupMessageId`, and `comment`; `markPaid` preserves them.
- **Inputs:** `put`, `get(id)`, `markPaid(id, preimage, now)`, `sweep(now)`.
- **Returns / side effects:** Lookups return the row or `undefined`. `sweep` drops unpaid rows after expiry plus one extra TTL (409 tombstone window); paid rows stay for proof idempotency. Restart clears the map.
- **Used by:** Default `createApp` `invoiceStore`; `invoiceRoutes`.

## Function: invoiceRoutes

- **Purpose:** Hono sub-app for spend-worker passkey eligibility (`GET /passkey`), funding-grant eligibility (`GET /eligible`), live top-level forum-post eligibility (`GET /posted`), invoice issue (`POST /`, optional `messageId` or `groupMessageId`), and preimage proof (`POST /proof`). Issue refuses addresses without a passkey-backed account (403 before LNURL), without `eligibleToday` (403 after passkey, before the living-room post check). When `messageId` is omitted, it also refuses an address with no live top-level non-profile forum post (403 after grant, before LNURL). Replies do not count. When `messageId` is set, that note must be that author's live top-level note, including About me, and have a photo or video (else 403 Forum post required; a text-only profile note stays 403). A profile photo with `messageId` set does not also need a separate living-room post. Omitted `messageId` stays any live top-level non-profile post (no media requirement). `groupMessageId` is display-only (stored only for that address's `moderator_group` message when a platform account exists; otherwise ignored and the invoice still issues). When `invoice.messageId` is set, a matching proof inserts a platform-account gift-reply first, then `addSats` (idempotent). Platform gift-replies do not notify (no in-app rows, no Web Push; `messages.reply.notify.failed` is not logged on this path; the nested gift-reply still persists); when that message is already a reply (`parentId` set), persists a deterministic `spendGiftReplyId` marker under that reply, `markDeleted` so live `listReplies` omits it, then `addSats`s the reply (a live existing marker is `markDeleted` only and does not `addSats`; no `notifyForumReply`). When `invoice.groupMessageId` is set, a matching proof inserts a platform stipend message in that closed Moderators group (`attachSpendGroupGift`; `giftForMessageId` set to the triggering message's id; idempotent).
- **Inputs:** `InvoiceRouteDeps`: spend token, invoice `store`, `authStore` (`listAccounts`, `getAccount`, `getNostrPublicKey`, plus account + passkey lookup), `messageStore` (`getById`, `addSats`, `create`, `markDeleted`, `listPostsByAccount`, `latestLiveTopLevelMediaId`, plus live-post and live-media lookup), clock, fetch, optional `giftRecorder` (default `NoopGiftRecorder`), optional `conversationStore` (`getById`, `getMessageById`, `appendMessage`; omitted → `groupMessageId` ignored), optional `fundingStore` (default empty `InMemoryFundingStore`; grant lookup for `GET /eligible` and `POST /`).
- **Returns / side effects:** Hono app mounted at `/invoices`. `GET /passkey` returns `{ hasPasskey }` (200 even when false). `GET /eligible` returns `{ eligible, status }` (200 even when false); `status` is `effectiveStatus` (`'none'` for unknown address and `basis`; do not look up a grant for `basis`). `GET /posted` returns `{ hasPosted, messageId, postedAt, hasMedia, welcomeHasMedia, welcomeMessageId }` (`hasMedia` excludes About me; `welcomeHasMedia` is true exactly when `welcomeMessageId` is set, and that id is the newest live top-level photo or video, including About me) (200 even when false). `hasPosted` is any live top-level non-profile post; `hasMedia` is true only when such a post has photo 0, extra stills, or video. `messageId` is the newest live top-level non-profile id, or null. `postedAt` is that row's `createdAt` ISO-8601, or null whenever `messageId` is null (including `hasPosted: true` with `messageId: null`). A matching proof (including the same-preimage idempotent 200) calls `recordOutbound` (description `21gifts moderator` when `groupMessageId` is stored, else `21gifts daily`; `kind` is `moderator` when `groupMessageId` is set, else `welcome` when `comment` is exactly `Welcome`, else `daily` — a welcome gift keeps description `21gifts daily`), inserts the platform gift-reply first, then `addSats`, then the Moderators-group stipend message when `groupMessageId` is set (`giftForMessageId` = that triggering id). When `messageId` is already a reply (`parentId` set), attach persists a deterministic `spendGiftReplyId` marker under that reply, `markDeleted` so live `listReplies` omits it, then `addSats`s the reply (a live existing marker is `markDeleted` only and does not `addSats`). Insert failures log `gifts.record_failed` and still return 200. Gift-reply attach skips and logs `invoice.gift_reply.failed` when the parent or platform account is missing; still 200. Group-stipend attach skips and logs `invoice.group_gift.failed` when the triggering row, thread, or platform is missing; still 200.
- **Used by:** `createApp`.

## Function: NoopGiftRecorder

- **Purpose:** `GiftRecorder` that ignores the row — used when `DATABASE_URL` is unset so proof still returns 200.
- **Inputs:** `recordOutbound(record)` with a `GiftRecord`.
- **Returns / side effects:** Resolves immediately. No SQL.
- **Used by:** `invoiceRoutes` default when `giftRecorder` is omitted.

## Function: SqlGiftRecorder

- **Purpose:** Persist a proven outbound gift into Postgres `gift` for `GET /gifts` and `GET /gifts/stats`.
- **Inputs:** Shared boot `SqlClient`. `recordOutbound` inserts `paid_at`, sats, recipient handle, BOLT11 `pr`, description, `kind` (`daily`, `welcome`, or `moderator`), `source_wallet`, and stored `fiat_usd` / `fiat_chf` / `fiat_eur` / `fiat_php` (null when the snapshot is null).
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

- **Purpose:** Hono sub-app for passkey register, authenticate, seed add, and replace refusal. Register begin accepts an optional `{ viewKey }` to claim a provisioned account; empty begin still mints a pending new account. Replace begin/finish, after a valid Bearer, return 409 and do not create a challenge or delete a credential. Seed begin/finish add one extra passkey, set `walletRequired` true, and keep the login passkey and the existing session. Passes optional `nostrKek` / `nostrKeygen` into register/authenticate finish so new logins get a custodial nsec.
- **Inputs:** `AuthRouteDeps`: store, `messages`, now, allowedOrigins, webAuthnRpId, webAuthnRpName, passkeyCeremony, optional `nostrKek` and `nostrKeygen`, optional `fundingStore` (default empty `InMemoryFundingStore`; owner JSON `funding` on finish).
- **Returns / side effects:** Hono app mounted at `/auth`. Begin with viewKey maps claim errors to 404/409; unwraps `{ challengeId, options }` on success.
- **Used by:** `createApp`.

## Function: bearerToken

- **Purpose:** Parses `Authorization: Bearer <token>`.
- **Inputs:** Header string or undefined.
- **Returns / side effects:** Token or `null`.
- **Used by:** `meRoutes`, `messagesRoutes`, `authRoutes` (passkey replace).

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

- **Purpose:** Wires CORS, requestLog, brand, health, info, auth, me, `/view`, `/pay`, lightning-address, `/debug/accounts`, `/debug/contacts`, `/debug/api-log`, `/debug/db`, `/debug/external-pubkeys`, `/debug/messages`, `/debug/invoices`, `/debug/invoices/settle`, `/debug/zap-ingests`, `/debug/push-ping`, `/debug/trust-edges`, `/debug/dump`, `/trust-chain`, `/trust` (verify / propose-moderator / confirm-moderator / reject-moderator / appoint-moderator), `/funding` (apply / applications / trial / admit / reject), Web Push subscription routes, `/gifts`, `/gifts/stats`, `/messages` (incl. invoice and `/messages/stats`), `GET /translate` (DeepL availability), `/members/:accountId`, `/.well-known` NIP-05 `nostr.json` (CORS `*`), `/contact`, `/pos`, `/conversations`, `/notifications`, and invoices.
- **Inputs:** Optional `AppDeps` (store, clock, payer, fetch, cache, readBrand, origins, `debugToken`, giftStore, `giftRecorder`, `btcUsdRates`, `fiatRates`, `messageStore`, optional `translationStore` (default `InMemoryTranslationStore`; SQL boot injects `PostgresTranslationStore`), optional `conversationTranslationStore` (passed to `conversationRoutes.translationStore`; omitted so that factory constructs one `InMemoryTranslationStore`; SQL boot injects a second `PostgresTranslationStore` on `conversation_message_translation`, never the forum store), `contactStore`, optional `conversationStore` (default `InMemoryConversationStore`), optional `notificationStore` (default `InMemoryNotificationStore`), optional `apiLogStore` (default `InMemoryApiLogStore`), optional `debugDbStore` (omitted on a memory boot; `GET /debug/db` then 503 after the token matches), `pushStore`, `trustStore`, optional `fundingStore` (default `InMemoryFundingStore`; also forwarded to `debugPaymentsRoutes`), optional `listDbChange`, `vapidPublicKey`, `nostrKek`, optional `nostrPublisher` (without `nostrKek` staff hide skips NIP-09), optional `env` (default `process.env`; relays / `PUBLIC_BASE_URL` / Cloudflare on `DELETE /messages/:id`; forwarded to `conversationRoutes`), spendApiToken, `spendPing` (default `resolveSpendPing(process.env, fetchImpl)`; unset/blank `SPEND_URL` or `SPEND_API_TOKEN` omits it; `POST /messages` still 200; daily/omitted kind body `{ address, messageId }`; `conversationRoutes` gets the same `spendPing`; moderator-group POST body `{ address, kind: "moderator", groupMessageId }` without `messageId`; forum `POST /messages` still two-arg daily ping; a verified account with any live top-level photo or video, including About me, also three-arg `'welcome'` even when the new row has no media; `spendPing` is also passed to `meRoutes` and, with `messages`, to `trustRoutes`; `fundingRoutes` receives the same optional `spendPing`), optional `postLimiter` (default a new `PostRateLimiter`; passed to `messagesRoutes`; boot shares one instance with the Nostr worker), invoiceStore, `webAuthnRpId`, `webAuthnRpName`, `passkeyCeremony`). `debugPaymentsRoutes` receives the same optional `spendPing`. Omitted `giftRecorder` → `invoiceRoutes` uses `NoopGiftRecorder`; omitted `messageStore` → `InMemoryMessageStore`; omitted `translationStore` → `InMemoryTranslationStore`; omitted `conversationTranslationStore` → `conversationRoutes` constructs one `InMemoryTranslationStore`; omitted `contactStore` → `InMemoryContactStore`; omitted `posStore` → `InMemoryPosStore`; omitted `conversationStore` → `InMemoryConversationStore`; omitted `notificationStore` → `InMemoryNotificationStore`; omitted `pushStore` → `InMemoryPushStore`; omitted `trustStore` → `InMemoryTrustStore`; omitted `fundingStore` → `InMemoryFundingStore`; omitted `apiLogStore` → `InMemoryApiLogStore`; omitted/blank `vapidPublicKey` → push HTTP 503 after session; omitted `nostrKek` → unsigned forum + invoice 503; SQL boot injects `SqlGiftRecorder`, `PostgresMessageStore`, `PostgresTranslationStore`, a second `PostgresTranslationStore` on `conversation_message_translation`, `PostgresContactStore`, `PostgresPosStore`, `PostgresConversationStore`, `PostgresNotificationStore`, `PostgresPushStore`, `PostgresTrustStore`, `PostgresFundingStore`, `PostgresApiLogStore`, `PostgresDebugDbStore`, and parsed KEK. `messagesRoutes`, `meRoutes`, `invoiceRoutes`, and `trustRoutes` receive `conversationStore`. `fundingRoutes`, `invoiceRoutes`, `messagesRoutes`, `conversationRoutes`, `meRoutes`, `membersRoutes`, and auth finish receive `fundingStore`. `contactRoutes` and `conversationRoutes` receive `pushStore` plus `notificationStore`. Mounts `notificationRoutes` at `/notifications`. Does not take a push sender (worker owns delivery).
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
- **Used by:** `indexOpenZapReceipts` (per-receipt catch, `nostr.zap.rejected`) and `startNostrWorker` (`nostr.worker.tick.failed`, `nostr.worker.ingest.failed`).

## Function: meRoutes

- **Purpose:** Authenticated account routes (`GET /`, `GET /activity`, `POST /wallet-backup-seen`, `POST /setup/skip`, name with `ensureProfileMessage` (no-op without LN) and username auto-assign from the display name when the handle is blank and free, `POST /username` (LUD-16 local-part, 409 when taken), `POST /location` (optional free-text; empty/whitespace stores `null`; does not call `ensureProfileMessage`), PUT `/about` About me on the profile note (`{ text, photo? }`: omitted photo keeps, `null` clears, object sets the same JPEG/PNG/WebP as a forum post; creates without LN, including photo-only empty text), `GET /about/photo` (Bearer profile-note bytes), forum-laws dismiss, `POST /notification-level` (`{ level: all|active|mentions }`, 200 owner JSON, log `account.notification_level.set`), `POST /amount-unit` (`{ unit: btc|fiat }`, 200 owner JSON, log `account.amount_unit.set`), `POST /locale` (`{ locale: en|de|es|fil, onlyIfUnset?: boolean }`, 200 owner JSON, log `account.locale.set`), `POST /fiat` (`{ fiat: CHF|EUR|USD|PHP, onlyIfUnset?: boolean }`, 200 owner JSON, log `account.fiat.set`), living-room rules agreement, Lightning Address link with live LNURL resolve + zap metadata check then NIP-57 mint probe `probeNip57Mint` then `ensureProfileMessage`, verification). Unlink clears `lightningAddressSkippedAt`. `POST /lightning-address` returns 409 `{ error: 'Lightning Address is already in use' }` when another account owns the address. `GET /activity` is Bearer-only (no rules gate) and returns given/received sats for the session account. After About me is saved, optional `spendPing` welcome-pings a verified account that has a live top-level photo or video, including that note.
- **Inputs:** `MeRouteDeps` store, `messages`, now, payer, fetchImpl, optional `pushStore`, optional `notificationStore` (profile-note `notifyForumPost`), optional `conversationStore` (inbox unread on profile-note push), optional `nostrKek` (required to sign the mint probe), optional `giftStore`, `rates`, and `fiatRates` (defaults empty in-memory; used by `GET /activity`; missing fiat never 503), optional `fundingStore` (default empty `InMemoryFundingStore`; owner JSON `funding`), optional `spendPing` (after About me is saved, welcome-ping when `role === 'verified'` and a live top-level photo or video exists, including that note; a ping failure still returns 200).
- **Returns / side effects:** Hono at `/me`. Owner JSON includes `setup` + `missing` + `hasPosted` + `aboutMe` + `aboutMeHasPhoto` + `notificationLevel` + `amountUnit` + `locale` + `fiat` + `funding` + `walletRequired` + `walletBackupSeenAt` + `passkeyCredentialId`. `GET /activity` is 200 activity JSON (zeros without Coinbase / Frankfurter when empty) or 503 `{ error: 'Gift stats are unavailable' }` on store throw or missing BTC-USD. Missing fiat never 503. Successful `POST /lightning-address` needs zap metadata (`allowsNostr` + non-empty `nostrPubkey`) plus KEK + `ensureAccountNostrKey` + probe `ok`. Probe `not_zap` → 400 `{ error: LIGHTNING_ADDRESS_NOT_ZAP }`; probe `unreachable` (and missing zap metadata) → 400 `{ error: 'Lightning Address could not be resolved' }`; missing/malformed KEK or key ensure failure → 503 with the same resolve string (account unchanged). Logs `account.setup.skipped` with `{ accountId, step }`. Logs `account.about.set` / `account.about.failed` on PUT `/about`; `GET /about/photo` 503 logs `account.about.photo.failed`. A won PUT `/about` inline claim create calls `notifyForumPost` after the text/photo writes (best-effort; no-op when the actor is the official platform account). PUT `/about` does not call `ensureProfileMessage`. Updating an already-live note does not notify. Activity 503 logs `account.activity.failed` / `account.activity.fx_incomplete`. Logs `account.wallet.backup_seen` `{ accountId }` only when `markWalletBackupSeen` returned `wrote: true`.
- **Used by:** `createApp`.

## Function: viewRoutes

- **Purpose:** Hono sub-app for public `GET /:viewKey`, `GET /:viewKey/about/photo`, and `GET /:viewKey/activity`. Param not 64 lowercase hex or unknown key → 404 `{ error: 'Not found' }`. Identity hit → `store.accountHasPasskey(account.id)`, load live profile-note text (`deletedAt` null) for `aboutMe` and `aboutMeHasPhoto`, then `serializeViewProfile(account, hasPasskey, aboutMe, aboutMeHasPhoto)`. Photo hit → `forumPhotoResponse` bytes for the live profile note (404 `{ error: 'Photo not found' }` when missing). Activity hit → given/received sats for that account. No auth; not a session.
- **Inputs:** `ViewRouteDeps`: `store`, optional `messageStore`, `giftStore`, `rates`, `fiatRates`, and `now` (defaults empty in-memory / `Date.now`; used by About me and `GET /:viewKey/activity`). Missing fiat never 503.
- **Returns / side effects:** Hono app mounted at `/view` so the public paths are `GET /view/:viewKey`, `GET /view/:viewKey/about/photo`, and `GET /view/:viewKey/activity`. Identity 503 logs `view.get.failed`. Photo 503 logs `view.photo.failed`. Activity is 200 JSON or 503 `{ error: 'Gift stats are unavailable' }` on store throw or missing BTC-USD. Missing fiat never 503. Activity 503 logs `account.activity.failed` / `account.activity.fx_incomplete`.
- **Used by:** `createApp`.

## Function: resolveTranslateUpstream

- **Purpose:** Parse `TRANSLATE_URL` + `TRANSLATE_API_KEY`. Missing/blank/invalid → `null` so boot continues.
- **Inputs:** env slice.
- **Returns / side effects:** `{ url, apiKey }` or `null`.
- **Used by:** `translateRoutes`, `translateForumNote`.

## Function: deeplTargetLang

- **Purpose:** Map UI locale to DeepL `target_lang` (`fil` → `TL`).
- **Inputs:** `en` / `de` / `es` / `fil`.
- **Returns / side effects:** `EN` / `DE` / `ES` / `TL`.
- **Used by:** `translateViaDeepl`.

## Function: translateViaDeepl

- **Purpose:** POST DeepL API v2 for one body. 15s timeout. `DeepL-Auth-Key`.
- **Inputs:** upstream, text, target, fetch.
- **Returns / side effects:** Translated string. Throws `TranslateUpstreamError`.
- **Used by:** `translateForumNote`.

## Function: translationSourceHash

- **Purpose:** SHA-256 hex of UTF-8 `message.text`.
- **Inputs:** source text.
- **Returns / side effects:** 64-char hex.
- **Used by:** `translateForumNote`.

## Function: InMemoryTranslationStore

- **Purpose:** Process-local `message_translation` map. First writer for a hash wins.
- **Inputs:** message id, locale, hash, text.
- **Returns / side effects:** Cached row.
- **Used by:** memory boots and tests.

## Function: PostgresTranslationStore

- **Purpose:** SQL translation get/put with `ON CONFLICT` first-writer-wins. Default table `message_translation`; conversation boot passes `conversation_message_translation`. Empty upsert throws `<table> upsert returned no row` (forum default remains `message_translation upsert returned no row`).
- **Inputs:** `SqlClient`, optional `table` (`TranslationTable`, default `message_translation`).
- **Returns / side effects:** Cached row from that table.
- **Used by:** `openBootStores` when `DATABASE_URL` is set (forum store and a second instance for conversations).

## Function: TranslateNotConfiguredError

- **Purpose:** Thrown when DeepL URL/key are missing so the route can answer 503.
- **Inputs:** none.
- **Returns / side effects:** Error.
- **Used by:** `translateForumNote`, `POST /messages/:id/translate`.

## Function: TranslateUpstreamError

- **Purpose:** Thrown when DeepL is unreachable or returns a bad body so the route can answer 502.
- **Inputs:** optional message.
- **Returns / side effects:** Error.
- **Used by:** `translateViaDeepl`, `POST /messages/:id/translate`.

## Function: TRANSLATION_SCHEMA_SQL

- **Purpose:** Idempotent `CREATE TABLE message_translation`.
- **Inputs:** none.
- **Returns / side effects:** SQL string applied in `MESSAGE_SCHEMA_SQL`.
- **Used by:** `migrateMessageSchema`.

## Function: translateRoutes

- **Purpose:** Public `GET /` `{ available }` from `resolveTranslateUpstream`. No DeepL call.
- **Inputs:** `env`.
- **Returns / side effects:** Always 200.
- **Used by:** `createApp` at `/translate`.

## Function: translateForumNote

- **Purpose:** Cache-first translation of one stored body in the given store. A matching hash returns without DeepL. Concurrent misses on the same store share one DeepL POST. A different store does not share that call, so the forum cache and the conversation cache each record the result. Upsert keeps the first writer for a hash.
- **Inputs:** `TranslationStore`, env, message id, source text, target locale, fetch.
- **Returns / side effects:** `{ translatedText, cached }`. Throws `TranslateNotConfiguredError` or `TranslateUpstreamError`.
- **Used by:** `POST /messages/:id/translate` and `POST /conversations/:id/messages/:messageId/translate`.

## Function: TranslationStore

- **Purpose:** `get` / `put` for `message_translation`. Memory and Postgres. `put` first-writer-wins on the same `source_sha256`.
- **Inputs:** message id, target locale, source hash, translated text.
- **Returns / side effects:** Cached row or stored text. Postgres uses `ON CONFLICT (message_id, target_lang)`.
- **Used by:** `translateForumNote`.

## Function: messagesRoutes

- **Purpose:** Hono sub-app for the public member forum. Public `POST /:id/translate` (`{ target }`) loads the stored `message.text`, returns a `message_translation` hit when `source_sha256` matches, otherwise one DeepL POST coalesced per (id, locale, hash), then upserts (first writer for a hash wins). Empty text 400. Same visibility as `GET /:id`. `{ translatedText, cached }`. 503 when DeepL is unset, 502 when DeepL fails. Public `GET /stats` (no session) counts living notes and replies together as `postCount`, with `postsOverTime` filled through today UTC (gap days are 0; soft-hidden rows are omitted; `posts.stats.failed` → 503). After Bearer auth, `requireAction` gates `GET /` (`forum.read` → rules), `POST /` (`forum.post` → rules + name + username + Lightning Address), `GET /compose-target` (`forum.post`), and `POST /:id/invoice` (`forum.pay` → payer rules only). Bearer `GET /` lists **live top-level** notes via `listFeed` (query `mode`/`limit`/`cursor`/optional `hashtag` (name without `#`; token match on `text`), default cap 200, optional `nextCursor` when the page is full; `hasPhoto`, `hasVideo`, `videoContentType`, `sats`, `payable`, live `role`, live `replyCount` of children with an account or a recorded zapper pubkey); soft-hidden rows are omitted; missing-file `hasVideo` rows are deleted (`messages.video.dropped`); `POST /` creates text/photo/video after parse/normalize/decode — JSON `photos` max 10, non-empty wins over singular `photo`, `photos.length > 10` is 400 `{ error: 'At most 10 photos' }`; optional `goalSats` alone is a legacy whole-sat ask (1..10_000_000) on a top-level note (JSON number or multipart digits; omitted/null/empty = no goal); alternatively both `goalCurrency` (`BTC`/`USD`/`CHF`/`EUR`/`PHP`) and `goalAmount` (one canonical decimal) and not `goalSats` — half a pair or both styles is 400 `{ error: 'Send either goalSats or both goalCurrency and goalAmount' }`; any goal field on a reply is 400 `{ error: 'A reply cannot ask for a goal' }`; `goalRepayable` other than JSON `true` or multipart `"true"` is 400 `{ error: 'Ask obligation must be true' }` (JSON `""` is rejected; a multipart empty field is absent); `goalRepayable` true without an ask is 400 `{ error: 'A repayment obligation needs an ask' }`; `goalTermDays` outside 1..3650 is 400 `{ error: 'Ask term must be a whole number of days from 1 to 3650' }`; a term without `goalRepayable: true` is 400 `{ error: 'A repayment term needs a repayable ask' }`; `goalRepayable` true without a term is 400 `{ error: 'A repayable ask needs a term in days' }`; `BTC` stores that whole-sat count as `goal_sats` and freezes the four fiat snapshots (`null` when there is no gift-day); fiat stores the typed amount, freezes `goal_sats` from the gift-day proportion, and the four snapshots; no usable rate or sats outside 1..10_000_000 is 400 `{ error: 'Ask amount is unavailable' }`; a thrown `goalRateDay` is 503 `{ error: 'Messages are unavailable' }` for a fiat ask, and a BTC ask still stores the typed sats; public JSON omits the key when unset; optional `place` is `{ lat, lng, label }` on a top-level note (multipart `placeLat` / `placeLng` / `placeLabel`; both empty means no pin; exactly one coordinate is 400; a reply with a place is 400 `{ error: 'A reply cannot include a place' }`; public JSON omits `place` when unset); `GET /places` lists live pins (`forum.read`, limit 1–1000) and is registered before `GET /:id`; `GET /:id/photo/:file` serves extras 1–9; identical live media from the same account+parent with the same pin collapses to the existing row (200, no limiter, no second push); a different pin is 409 `{ error: 'A live note with this media already exists' }`; text-only still uses the 1/10s burst then inserts; unpaid text-only posts and replies from anyone below `verified` (including the parent author) are 403 (`A post needs a Bitcoin payment` / `A reply needs a Bitcoin payment`); photo or video posts and replies from basis are allowed; pay 1 sat to 21.gifts via `GET /compose-target` then `POST /:id/invoice` on the platform profile note; `verified` stays unpaid-write exempt; soft-hidden `inReplyTo` parents are 404; public `GET /:id` stays open without a session and then omits `accountId`; a session sets `accountId` for a 21.gifts author and omits it for an external author on a live row (a reply with null `accountId` is 200 with `via: 'nostr'` only when `authorPubkey` is set and recorded as a zapper (`isZapperPubkey`); otherwise (no `authorPubkey`, or one that is not yet a recorded zapper) it is 404; external top-level notes stay 200); optional `?sinceSats=` (non-negative integer) long-polls until `sats` is strictly greater (timeout still 200 with the current body; invalid value 400); unsigned/non-staff GET of a hidden row is still 404 `{ error: 'Not found' }` (no `deletedAt` in the 404 body); a founder/moderator Bearer (`roleAtLeast(..., 'moderator')`, no `forum.read`) is 200 public JSON plus `deletedAt` ISO, `deletedBy.{id,name,role}`, `payable: false`, and `accountId` for 21gifts authors (skip missing-video drop; do not long-poll `sinceSats` on hidden rows); a top-level note on GET `/:id`, live or staff-hidden, includes that `replyCount`, and a reply omits `replyCount`; live public JSON still omits hide stamps; public `GET /:id/replies` lists children with an account or a recorded zapper pubkey (optional Bearer for `accountId`; rows with neither identity are skipped); unsigned/non-staff 404s hidden/missing parents; staff Bearer is 200 `{ messages }` from `listReplies(id, limit, true)` including hidden attributed children with hide stamps and `payable: false` (live children stay live serialize); a child whose author lookup or serialize throws (invalid `createdAt`, author lookup) is omitted and siblings still 200 `{ messages }`; 503 `messages.replies.failed` only for `getById` / `listReplies` throws and for `dropMissingVideoRow` store/I/O (non-ENOENT video I/O or `deleteById`); missing-file drop (`null` → omit) still 200; photo/video byte routes 404 hidden ids for public/Damus (no staff bearer); founder/moderator Bearer serves hidden-row bytes with `Cache-Control: private, no-store` and `Vary: Authorization`; staff `DELETE /:id` soft-hides via `markDeleted` (moderator → 204; basis/verified → 403) then best-effort `retractHiddenForumNotes` when `nostrPublisher` and `nostrKek` are set (NIP-09 + optional Cloudflare purge; failure still 204) and best-effort retracts in-app notifications whose `parentId` or `replyId` is the note or a direct child (`listChildIds` + `deleteByMessageIds`; failure logs `messages.delete.notifications_failed` and still 204, never 503); staff `GET /hidden` lists soft-hidden notes newest-hidden-first (moderator session, not `DEBUG_TOKEN`, no `forum.read`; 200 `{ messages }` via `listHidden` / `serializeHiddenMessage`; logs `messages.hidden.listed` with `count` only); invoice returns `{ pr, amountSats }` only for NIP-57 invoices and 404s soft-hidden notes (author LN / unsigned stay 400 resource errors, never 409 `lightning-address` for the payer). Optional `notificationStore` fans out via `notifyForumPost` / `notifyForumReply` to every account except the actor (no-op when the actor is the official platform account), then filtered by each account's `notificationLevel` (no inbox copy; missing `pushStore` still writes in-app rows; Web Push only to bell subscribers, same filter). Optional `spendPing`: after a **new** top-level persist the route POSTs `{ address, messageId }` to `{SPEND_URL}/ping` with Bearer `SPEND_API_TOKEN` only when `eligibleToday` and the new row has media (`hasPhoto` / `hasVideo` / `photoCount > 0`) (fire-and-await, errors logged, POST still 200; ineligible logs `spend.ping.skipped` / `not_eligible`; eligible text-only logs `spend.ping.skipped` / `no_media`). When `role === 'verified'` and any live top-level photo or video exists, including About me, the route also POSTs `{ address, messageId, kind: "welcome" }` for that note, independently of `eligibleToday` and of whether the new row has media (`spend.ping.failed` on throw). Replies, and any role other than `verified`, skip welcome. Replies and media replays skip. Omitted `spendPing` skips. Notification or push failure still returns 200.
- **External DELETE cascade:** When the target has `accountId === null` and a recorded `authorPubkey`, a successful `markDeleted` is followed by the single atomic `blockPubkeyAndHideRows` operation, which records the block and hides that pubkey's other live external rows. It logs `messages.external.blocked` with `{ messageId, hidden: cascaded + 1 }`; deleting a member row does not trigger this author-wide cascade.

- **Inputs:** `MessagesRouteDeps`: message `store`, shared `authStore`, `now`, optional `nostrKek`, optional `nostrPublisher`, optional `env` (relays / `PUBLIC_BASE_URL` / Cloudflare / DeepL; default `{}` on the retract path), optional `translationStore` (default empty `InMemoryTranslationStore`), `fetchImpl`, `postLimiter`, `invoiceLimiter`, optional `pushStore`, optional `spendPing`, optional `fundingStore` (default empty `InMemoryFundingStore`), optional `notificationStore`, optional `conversationStore`, optional `waitSatsSleep` (test inject; default `defaultWaitSatsSleep`), optional `waitSatsTimeoutMs` (test inject; default `WAIT_SATS_TIMEOUT_MS`), optional `waitSatsPollMs` (test inject; default `WAIT_SATS_POLL_MS`), optional `goalRateDay` (`createApp` passes `bindGoalRateDay`; when omitted a fiat ask is 400 `Ask amount is unavailable`, a throw is 503 for a fiat ask, and a BTC ask still stores the typed sats when the loader throws or returns null).
- **Returns / side effects:** Hono app mounted at `/messages`. 401 without a live session on create/compose-target/DELETE/GET `/hidden`/invoice, and on the list except the unsigned `mode=active` window with no hashtag (that window is 200); 403 on DELETE and GET `/hidden` when not at least moderator and on unpaid text-only posts and replies from anyone below `verified` (including the parent author); photo or video posts and replies from basis are allowed; 409 `{ error: 'A live note with this media already exists' }` when the same live media fingerprint has a different pin; 409 `{ error: 'missing_requirements', missing }` when action gates fail (GET `/hidden` and staff GET of a hidden permalink / replies / photo / video have no `forum.read` gate); 400 on bad body / invalid text / bad media / unpaid note / author's-wallet / LNURL failures / reply+goal field / non-integer multipart `goalSats` / currency-ask pair errors / `Ask amount is unavailable`; 404 for bad `inReplyTo` / missing rows / unsigned or non-staff GET of a hidden row; 204 empty body on successful DELETE (NIP-09 / purge / notification retract failure still 204); 200 staff hidden log `{ messages }` (no `forum.read`); 200 staff GET of a hidden permalink / replies / photo / video; 429 rate limits; 503 on store/KEK/sign failure. Signed-in list, `GET /:id`, replies, and create may include `accountId` for a 21.gifts author; unsigned live JSON and an external author omit `accountId`, `deletedAt`, and `deletedBy`; staff hidden GET includes hide stamps and `accountId` for 21gifts authors. Post and reply notify call `notifyForumPost` / `notifyForumReply` best-effort (in-app rows for every account except the actor (no-op when the actor is the official platform account), then filtered by each account's `notificationLevel`; Web Push for bell subscribers, same filter; failure still 200.

- **Used by:** `createApp`.

## Function: contactRoutes

- **Purpose:** Hono sub-app for the private in-app contact mailbox: `POST /` only (no member GET). After auth, `requireAction(account, 'contact.post')` (rules + name + username). After the platform account exists, persists the contact row first, then opens/appends the member→platform conversation thread. Conversation append failure logs `conversations.contact_sync.failed` and still 200.
- **Inputs:** `ContactRouteDeps`: contact `store`, `conversationStore`, shared `authStore`, `now`, optional `pushStore` and `notificationStore`.
- **Returns / side effects:** Hono app mounted at `/contact`. 401 without session; 409 `{ error: 'missing_requirements', missing }` when rules/name/username are missing; 400 on bad body / invalid text; 503 `{ error: 'Platform account is not configured' }` when no `isPlatform` account (no writes); 503 Contact is unavailable on contact-store failure (`contact.create.failed`). After a successful conversation append, `notifyConversationMessage` is void-caught (`conversations.push.failed`); contact 200 is unchanged. Public JSON omits `accountId`.
- **Used by:** `createApp`.

## Function: conversationRoutes

- **Purpose:** Hono sub-app for the signed-in PN channel: `GET /` lists `{ conversations, unreadCount }` (`unreadCount` = listed rows with `unread` true) for visible inbox threads and always passes `moderator: false` into `listVisible` (never ensures, pins, or returns `moderator_group`); each list/open row gets `unreadMessageCount` from `countUnread` (`unread` = count > 0; those paths do not also call `hasUnread`) and `lastMessageId` of the newest row (`created_at DESC, id DESC`, else `null`; the list does not translate); `POST /` opens a thread from `{ forumMessageId }`; `GET /moderator-group` (before `GET /:id`) is the closed-group tool for `roleAtLeast(..., 'moderator')`: `ensureModeratorGroup` then `{ conversation }` (with `unread` / `unreadMessageCount` from `countUnread`); verified/basis 404; missing platform / store failure 503 `conversations.moderator_group.failed`; `GET /:id` returns a messenger-style newest page (default/max 200) oldest-first within the page, with `?limit=` and an exclusive older keyset `?cursor=` plus optional `nextCursor`, including `hasPhoto` / `photoCount` (never bytes); `?sinceMessageId=` keeps its long-poll and then returns the newest page regardless of a valid cursor; `GET /:id/messages/:messageId/photo` and `GET /:id/messages/:messageId/photo/:file` (indices 1–9, registered before `GET /:id`) serve private stills (`conversations.photo.failed` on store throw); `POST /:id/messages/:messageId/translate` (before `GET /:id`) translates stored `conversation_message.text` via `translateForumNote` and `conversation_message_translation` (not `message_translation`; no client source text) after `canAccess` including `isModeratorGroupMember` for `moderator_group`; `POST /:id/read` stamps last-read (mount before `POST /:id`); `POST /:id` appends `{ text?, photo?, photos? }` (max 10 stills; non-empty `photos` wins over singular `photo`; stills on every kind; empty text allowed when a still is present; photo-bearing rows skip Nostr; text-only Direct/Contact/Damus stay pending); `POST /:id/invoice` issues a NIP-57 gift invoice. Moderators see all platform threads. Staff replies on a platform thread persist the platform sender (worker signs with the platform nsec) and store `actorAccountId`/`actorName` as the logged-in staff. Staff JSON `name`/`accountId` use the actor when set; members still see the sender (`21.gifts`). `fromMe` is the actor, else the sender — no staff-as-platform shortcut. `moderator_group` ACL is `isModeratorGroupMember` (`roleAtLeast(..., 'moderator')` and not the platform account; moderator 200; verified/basis 404). `POST /:id` on this kind persists as the caller (moderator, not staff-as-platform) with `nostrPublishState: 'skipped'`, then `spendPing.ping(address, created.id, 'moderator')` only when Lightning Address is non-empty after trim **and** a live living-room top-level post exists on this UTC day **and** `eligibleToday`; no living-room post today → 200, no ping, `spend.ping.skipped` / `no_public_post`; living-room lookup failure after persist → 200, no ping, `spend.ping.skipped` / `posted_unreachable`; ineligible grant → 200, no ping, `spend.ping.skipped` / `not_eligible`; ping throw still 200.
- **Inputs:** `ConversationRouteDeps`: conversation `store`, shared `authStore`, forum `messageStore`, `now`, optional `spendPing`, optional `fundingStore` (default empty `InMemoryFundingStore`), optional `fetchImpl` / `nostrKek` / `invoiceLimiter` / wait injects, optional `pushStore` and `notificationStore`, optional `translationStore` (default one empty `InMemoryTranslationStore` per factory call, never the forum store; SQL boot injects a second `PostgresTranslationStore` on `conversation_message_translation`), optional `env` (DeepL; default `{}`).
- **Returns / side effects:** Hono app mounted at `/conversations`. 401 without session; 400 on bad body / self-PM / missing name / invalid text / author wallet / invalid still / empty trimmed translate text; 404 when not allowed; 429 Too many payments; 503 `{ error: 'Messages are unavailable' }` for missing KEK / sign failure; 503 `{ error: 'Translate is not configured' }`; 502 `{ error: 'Translate upstream failed' }`; 503 `{ error: 'Conversations are unavailable' }` for store/catch including ok-path `recordInvoiceAttempt` throw (`conversations.list.failed` / `conversations.read.failed` / `conversations.photo.failed` / `conversations.translate.failed` without API key or text). After a successful `POST /:id` append, `notifyConversationMessage` is void-caught (`conversations.push.failed`) so 200 is unchanged. Public list/open JSON includes `unread`, `unreadMessageCount`, `lastSats`, and `lastMessageId` and may include optional counterpart `accountId`; thread messages may include optional `accountId` (actor for staff when set, otherwise sender), `hasPhoto`, and `photoCount` (0–10; never bytes). Omits event ids and npubs (Damus-only `name` may be a truncated npub; Damus-only counterparts and Damus inbound omit `accountId`). List rows include `lastSats`; messages include `sats`. Envelope `unreadCount` remains the number of listed rows with `unread` true. Translate 200 is `{ translatedText, cached }`.
- **Used by:** `createApp`.

## Function: notificationRoutes

- **Purpose:** Hono sub-app for signed-in in-app notifications: `GET /` lists `{ notifications, unreadCount }` (scan newest 1000, `notificationsMatchingLevel` for the owner's `notificationLevel`, then drop rows whose parent **message** is missing or `deletedAt !== null` (`forum_reply` also checks the child `replyId` message; `zap` `replyId` is a receipt UUID and is not looked up), then cap 200; `unreadCount` is matching unread among kept rows; each item `type` is `'forum_post' | 'forum_reply' | 'forum_mention' | 'zap' | 'moderator_appointed' | 'moderator_proposal'`; `moderator_appointed` and `moderator_proposal` always stay through the level filter and the hidden filter), `POST /read-all` marks all read except `moderator_proposal`, `POST /:id/read` marks one UUID (`moderator_proposal` stays unread). Mount `read-all` before `/:id/read`. Never exposes recipient or actor account ids. `DEBUG_TOKEN` cannot read this list. `createApp` always passes `messages` (`getById`). Hidden/missing forum rows are then best-effort `deleteByMessageIds` (`notifications.hidden.purged`). Appointed/proposal `parentId`/`replyId` are account ids in prod, so a purge of hidden **message** ids does not remove them. If purge throws, count kept unread rows (do not 503 the list).
- **Inputs:** `NotificationRouteDeps`: notification `store`, shared `authStore`, `messages` (`getById`), `now`.
- **Returns / side effects:** Hono app mounted at `/notifications`. 401 without session; 404 `{ error: 'Not found' }` for unknown / other-account / non-uuid `:id`; 503 `{ error: 'Notifications are unavailable' }` (`notifications.list.failed` / `notifications.read_all.failed` / `notifications.read.failed`). Hidden-row purge failure is not 503.
- **Used by:** `createApp`.

## Function: normalizeDisplayName

- **Purpose:** Trim and validate an account display name (1–80 characters, no C0/DEL controls).
- **Inputs:** `raw` string.
- **Returns / side effects:** Trimmed name or `null`.
- **Used by:** `POST /me/name`.

## Function: normalizeUsername

- **Purpose:** Trim, lowercase, and validate a LUD-16 / NIP-05 local-part (`a-z0-9-_.`, 1–32 characters, must start with a letter or digit). Rejects `_` because LUD-16 uses it as the default identifier. Does not allow `+` (tags are not stored).
- **Inputs:** `raw` string.
- **Returns / side effects:** Normalised username or `null`. No I/O.
- **Used by:** `POST /me/username`, `usernameFromDisplayName`, `backfillAccountUsernames`, debug provision.

## Function: usernameFromDisplayName

- **Purpose:** Derive a username from a display name via `nip05Slug`. Returns `null` when the slug is the punctuation fallback `user` or fails `normalizeUsername`. Does not add collision suffixes.
- **Inputs:** Display `name` string.
- **Returns / side effects:** Normalised handle or `null`. No I/O.
- **Used by:** `POST /me/name` auto-assign, debug provision.

## Function: backfillAccountUsernames

- **Purpose:** Assign unique usernames to named accounts that still have none, oldest first, using `allocateNip05Local` so existing NIP-05 locals including suffixes stay stable. Nameless accounts stay unset. Logs `account.username.backfill` with `{ count }`.
- **Inputs:** `AuthStore`.
- **Returns / side effects:** Number of accounts updated. Writes via `updateAccount`.
- **Used by:** `openAuthStore` after auth schema migrate on Postgres boots.

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
- **Inputs:** `raw` string; optional `maxLength` (default `MESSAGE_MAX_LENGTH` 8000). Inbound Nostr worker passes `MESSAGE_INBOUND_REPLY_MAX_LENGTH` (8192) for Damus kind:1 replies and NIP-17/kind:4 plaintext.
- **Returns / side effects:** Trimmed text (possibly empty) or `null`. No I/O.
- **Used by:** `POST /messages`, `POST /contact`, `POST /conversations/:id`, `PUT /me/about`, `runNostrWorkerTick` inbound indexing.

## Function: normalizePlace

- **Purpose:** Validate an optional map pin for a top-level forum note. `undefined` or `null` is no pin. Otherwise a plain object with finite numeric `lat` in [-90, 90] and `lng` in [-180, 180], rounded to 6 decimal places (`Math.round(n * 1e6) / 1e6`), with `-0` collapsed to `0`. Label absent, null, or trim-empty becomes null. A label never removes the pin.
- **Inputs:** `input` unknown (JSON `place` or a multipart-derived object).
- **Returns / side effects:** `{ ok: true, value: ForumPlace | null }` or `{ ok: false, error }` where error is `Place must be a latitude and longitude` (missing/non-numeric/NaN/Infinity/out of range, or a non-string label) or `Place label must be at most 80 characters` (trimmed length > 80, or any charCode < 32 or === 127). No I/O.
- **Used by:** `POST /messages`.

## Function: parseMultipartCoord

- **Purpose:** Read one multipart coordinate. Blank or missing is no coordinate. A value that is not an explicit decimal is invalid, so whitespace cannot become a pin at zero.
- **Inputs:** `raw` unknown from a multipart field (`placeLat` or `placeLng`).
- **Returns / side effects:** `'missing'`, `'invalid'`, or a finite number. No I/O.
- **Used by:** `POST /messages` multipart parsing, then `normalizePlace`.

## Function: placesMatch

- **Purpose:** Compare two optional pins. Both absent matches. One absent does not. Otherwise latitude, longitude, and label must all be equal.
- **Inputs:** Two `ForumPlace | null` values.
- **Returns / side effects:** `true` when the pins are the same, otherwise `false`. No I/O.
- **Used by:** `POST /messages` and `MessageStore.create`, which reject a repeated live photo when the pin differs.

## Function: detectImageContentType

- **Purpose:** Detect JPEG / PNG / WebP from magic bytes for forum photo storage.
- **Inputs:** Raw `Uint8Array` candidate bytes.
- **Returns / side effects:** `'image/jpeg' | 'image/png' | 'image/webp'`, or `null` for empty/SVG/GIF/HEIC/unrecognized. No I/O.
- **Used by:** `decodeForumPhoto`.

## Function: decodeForumPhoto

- **Purpose:** Decode a base64 forum photo, enforce the 1 MiB cap, and set MIME from magic bytes (declared `contentType` is ignored).
- **Inputs:** Declared `contentType` string (non-authoritative) and standard base64 `data`.
- **Returns / side effects:** `{ contentType, bytes }` with a copied `Uint8Array`, or `null` on invalid base64, empty, oversize, or unrecognized magic. No I/O.
- **Used by:** `POST /messages`, `PUT /me/about`, `POST /conversations/:id`.

## Function: encodeMessageFeedCursor

- **Purpose:** Encode a keyset cursor as base64url JSON for `GET /messages?cursor=`. Time pages use `{ k: 't', c, i }`; popular pages use `{ k: 's', s, c, i }`.
- **Inputs:** `MessageFeedCursorJson`.
- **Returns / side effects:** Opaque cursor string. No I/O.
- **Used by:** `messagesRoutes` GET `/`.

## Function: decodeMessageFeedCursor

- **Purpose:** Decode `GET /messages?cursor=`. Returns `null` when the payload is not valid base64url JSON of the expected shape (including invalid ISO `c` / non-finite `s`). Does not interpret `mode`; the GET handler rejects the wrong `k` for the mode.
- **Inputs:** Raw query string.
- **Returns / side effects:** `MessageFeedCursorJson` or `null`. No I/O.
- **Used by:** `messagesRoutes` GET `/`.

## Function: forumPhotoResponse

- **Purpose:** Build the public photo HTTP response used by `GET /messages/:id/photo`, `GET /me/about/photo`, and `GET /view/:viewKey/about/photo`. Sets jpeg/png/webp `Content-Type`, `Cache-Control: public, max-age=86400`, `Access-Control-Allow-Origin: *`, and inline `Content-Disposition` `photo.jpg|png|webp`. Conversation photo GETs reuse this helper then override to `Cache-Control: private, no-store` and drop `Access-Control-Allow-Origin`.
- **Inputs:** `ForumPhoto` (`contentType` plus `bytes`).
- **Returns / side effects:** `200` `Response` whose body is `photo.bytes`. No I/O.
- **Used by:** `serveForumPhoto`, `meRoutes` GET `/about/photo`, `viewRoutes` GET `/:viewKey/about/photo`, `conversationRoutes` GET `/:id/messages/:messageId/photo` and `/:id/messages/:messageId/photo/:file`.

## Function: updatePhoto

- **Purpose:** `MessageStore` port method: replace or clear stored photo bytes and `photo_taken_at` without changing text, sats, or event ids, and without recomputing `content_fp` (same as `updateText`). In-memory copies bytes into a private map and sets still 0's capture time (null when the photo has none, or when the photo is cleared). Postgres `UPDATE message SET photo = $2, photo_content_type = $3, photo_taken_at = $4 WHERE id = $1 RETURNING` list columns.
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

## Function: normalizePhotoTakenAt

- **Purpose:** Keep a client-sent civil camera time, or drop it. Not converted to UTC. A bad value does not reject the post.
- **Inputs:** Unknown JSON (`takenAt` on a forum photo).
- **Returns / side effects:** The original string when it is `YYYY-MM-DDTHH:MM:SS` with an optional `±HH:MM` offset, a real calendar date, and a year from 1990 through the current UTC year + 1. Otherwise null. No I/O.
- **Used by:** `POST /messages`.

## Function: serializeMessage

- **Purpose:** Project a stored forum row to its public JSON shape including zap totals, payability, `hasPhoto`, `photoCount` (0–10; from `row.photoCount` or `hasPhoto ? 1 : 0`), `hasVideo`, `videoContentType`, live author role, optional `via`, optional `replyCount`, optional `accountId`, optional `mentions` (`{ username, accountId }[]` only when `accountId` is included and the stored list is non-empty), optional `parentId`, optional `goalSats` (included when the stored value is a positive integer on a top-level note; omitted on replies and when unset, null, or 0), optional `goalRepayable: true` only when the stored column is true (omitted when null; never false; omitted on replies), optional `goalTermDays` when the stored column is not null (omitted when null; omitted on replies), optional `goalCurrency` / `goalAmount` / `goalAmountUsd` / `goalAmountChf` / `goalAmountEur` / `goalAmountPhp` (only when `goalCurrency` is set and `goalAmount` is a string; snapshot keys stay present when null; omitted entirely for legacy rows), optional `place` (included only when both coordinates are stored; omitted when unset), and optional hide stamps. When stored `name` is empty after trim, JSON `name` is `truncatePubkeyDisplay(row.authorPubkey ?? '')` (`'npub'` when the pubkey is missing); non-empty names are unchanged. Invalid `createdAt` is not guarded here: `toISOString()` still throws. `GET /messages/:id/replies` and `GET /members/:accountId/replies` omit that child (200, siblings remain); `GET /messages` (list), `GET /members/:accountId/posts`, and public `GET /messages/:id` return 503. Member feeds reuse this: `GET /members/:accountId/posts` is newest-first like signed-in `GET /messages`; `GET /members/:accountId/replies` is newest-first with `payable` when a non-empty `eventId` and a non-blank Lightning Address are set. Callers that serve list/GET/replies delete a `hasVideo` row when the file is missing or empty on disk (`forumVideoFilePresent`) so no empty note remains. Last optional `hidden?: { deletedAt: Date; deletedBy: { id, name, role } }`: when set, JSON `deletedAt` is ISO, `deletedBy` is copied, and `payable` is false (ignore the payable arg). When omitted, do not set those keys (live JSON has no `deletedAt` / `deletedBy`). Store-internal `contentFp` is never included.
- **Inputs:** `MessageRow` (includes `accountId` and private `authorPubkey`; never photo/video bytes), `payable` boolean, optional `role` (`AccountRole`; omitted for external Nostr authors), optional `replyCount` (top-level `GET /messages` and `GET /members/:accountId/posts` list rows, and single-note `GET /messages/:id` for a top-level note), optional `includeAccountId` (signed-in list, `GET /messages/:id`, replies/create, member feeds, and staff hidden GET pass true; an unsigned live GET omits), and last optional `hidden?: { deletedAt: Date; deletedBy: { id, name, role } }`.
- **Returns / side effects:** `{ id, name, text, createdAt, sats, amountUsd, amountChf, amountEur, amountPhp, payable, hasPhoto, photoCount, photoTakenAts, hasVideo, videoContentType }` with ISO-8601 `createdAt`; the four amounts are always present (string or null); `photoTakenAts` length equals `photoCount` (null slots when unknown, `[]` when there are no stills); `photoTakenAt` is included only when `photoCount === 1` and equals `photoTakenAts[0]`; `name` uses the blank-name fallback when stored `name` trims empty; `photoCount` is 0–10 (from `row.photoCount` or `hasPhoto ? 1 : 0`); `videoContentType` is null when `hasVideo` is false; `via: 'nostr'` is set exactly when `row.accountId === null && row.authorPubkey !== null`; those external rows have `payable` false and omit `role`; the pubkey itself is private and never appears in public JSON. `role` is otherwise omitted when undefined; `replyCount` is omitted when undefined; `accountId` is set only when `includeAccountId` is true and `row.accountId !== null` (external rows and an unsigned live GET omit it; a session on `GET /messages/:id` sets it for a 21.gifts author); `mentions` is set only when `includeAccountId` is true and the stored list is non-empty; `parentId` is set only when `row.parentId !== null` (omitted on top-level notes); `goalSats` included only when the stored value is a positive integer on a top-level note (omitted on replies and when unset, null, or 0); `goalRepayable` is included only when stored true (omitted when null, never false, omitted on replies); `goalTermDays` is included only when stored (omitted when null, omitted on replies); `goalCurrency`, `goalAmount`, and `goalAmountUsd` / `goalAmountChf` / `goalAmountEur` / `goalAmountPhp` included only when `goalCurrency` is set and `goalAmount` is a string (snapshot keys stay present when null; omitted entirely for legacy rows); `place` included only when both coordinates are stored (omitted when unset); when `hidden` is set, `deletedAt` ISO, `deletedBy` copied, `payable` false; when omitted, those keys are not set; never photo/video bytes or `contentFp`. No I/O.
- **Used by:** `messagesRoutes`, `membersRoutes`.

## Function: serializeDebugMessage

- **Purpose:** Project a stored forum row to operator debug JSON, including soft-hide stamps, Damus-only `accountId: null`, `photoCount`, every `MessageRow` Nostr column (`nostrEvent`, `claimedUntil`, `nostrFirstAttemptAt`, `nostrPublishEpoch`, `contentFp`), photo MIME/byte lengths, stored `goalSats` (JSON `null` when unset), `goalRepayable` true only when stored true (omitted when null, never false), `goalTermDays` when stored (omitted when null), currency-ask keys only when `goalCurrency` and `goalAmount` are stored, and `placeLat` / `placeLng` / `placeLabel` (JSON `null` when unset). Public hide does not apply: hidden rows keep `text` and ISO `deletedAt`. Never includes nsec or photo/video payloads.
- **Inputs:** `MessageRow` (includes hidden rows and replies; never photo/video bytes) and optional `DebugMessagePhotoMeta` (`photoContentType`, `photoBytes`, `extraPhotos`; omitted → `null` / `0` / `[]`).
- **Returns / side effects:** `{ id, name, text, createdAt, sats, amountUsd, amountChf, amountEur, amountPhp, hasPhoto, photoCount, photoTakenAts, hasVideo, videoContentType, parentId, eventId, nostrPublishState, nostrEvent, claimedUntil, nostrFirstAttemptAt, nostrPublishEpoch, contentFp, deletedAt, deletedBy, authorPubkey, nostrAttempts, accountId, goalSats, goalRepayable, goalTermDays, placeLat, placeLng, placeLabel, photoContentType, photoBytes, extraPhotos }` (`photoTakenAts` length equals `photoCount`; `photoTakenAt` only when `photoCount === 1`; each extra still includes `photoTakenAt`) with ISO-8601 `createdAt` / `deletedAt`; the four amounts are always present (string or null); (`deletedAt` JSON `null` when live); `photoCount` is 0–10 (from `row.photoCount` or `hasPhoto ? 1 : 0`); `accountId` is a string or JSON `null` (never omitted); `goalSats` is the stored column (JSON `null` when unset); `goalRepayable` is included only when stored true (omitted when null, never false); `goalTermDays` is included only when stored (omitted when null); `goalCurrency`, `goalAmount`, and the four `goalAmount*` snapshots are included only when `goalCurrency` and `goalAmount` are stored (snapshots may be null; omitted on legacy rows); `placeLat`, `placeLng`, and `placeLabel` are JSON `null` when unset. Invalid `createdAt` / `deletedAt` still throws from `toISOString()`. No I/O.
- **Used by:** `debugMessagesRoutes`, `loadDebugTables`.

## Function: serializeHiddenMessage

- **Purpose:** Project a stored forum row to staff hidden-log JSON (who hid it and when). JSON `name` is the stored `row.name` (no empty-name pubkey fallback). Always includes `parentId` (JSON `null` on top-level notes), ISO `deletedAt` (JSON `null` when live), and `photoCount` (0–10; from `row.photoCount` or `hasPhoto ? 1 : 0`). Optional `goalSats` when the stored value is a positive integer on a top-level note (omitted on replies and when unset, null, or 0). Optional `goalRepayable: true` only when stored true (omitted when null, never false, omitted on replies). Optional `goalTermDays` when stored (omitted when null, omitted on replies). Optional currency-ask keys when `goalCurrency` and `goalAmount` are stored (omitted on legacy rows; snapshot keys may be null). Optional `place` when both coordinates are stored (omitted when unset). Optional `via: 'nostr'` is set exactly when `row.accountId === null && row.authorPubkey !== null`; the pubkey itself is private and never appears in this JSON. Includes `accountId` for a 21.gifts author and omits it for an external row. Never includes `eventId`, `nostrPublishState`, `payable`, author `role`, `nostrEvent`, `claimedUntil`, `contentFp`, nsec, or photo/video bytes. Deleter `{ id, name, role }` is resolved in `messagesRoutes`, not here.
- **Inputs:** `MessageRow` (includes hidden rows and replies; never photo/video bytes) and `deletedBy: { id, name, role }` (`AccountRole | null`; `id` / `name` may be null).
- **Returns / side effects:** `{ id, name, text, createdAt, sats, amountUsd, amountChf, amountEur, amountPhp, hasPhoto, photoCount, photoTakenAts, hasVideo, videoContentType, parentId, accountId?, deletedAt, deletedBy, via? }` (`photoTakenAts` length equals `photoCount`; `photoTakenAt` only when `photoCount === 1`) with ISO-8601 `createdAt` / `deletedAt`; the four amounts are always present (string or null); (`deletedAt` JSON `null` when live); `photoCount` is 0–10 (from `row.photoCount` or `hasPhoto ? 1 : 0`); `via: 'nostr'` is set exactly when `row.accountId === null && row.authorPubkey !== null`, while the pubkey itself is never included; optional `goalSats` when the stored value is a positive integer on a top-level note (omitted on replies and when unset, null, or 0); optional `goalRepayable: true` only when stored true (omitted when null, never false, omitted on replies); optional `goalTermDays` when stored (omitted when null, omitted on replies); optional `goalCurrency`, `goalAmount`, and the four `goalAmount*` snapshots when `goalCurrency` and `goalAmount` are stored (omitted on legacy rows; snapshots may be null); optional `place` when both coordinates are stored (omitted when unset). Invalid `createdAt` / `deletedAt` still throws from `toISOString()`. No I/O.
- **Used by:** `messagesRoutes` (`GET /messages/hidden`).

## Function: serializeConversation

- **Purpose:** Project a stored thread to its public list JSON shape.
- **Inputs:** `ConversationThread` with resolved `name` / `lastText`, `lastFromMe` boolean, `unread` boolean, `unreadMessageCount` number, and optional counterpart `accountId` (`string | null`).
- **Returns / side effects:** `{ id, kind, name, lastText, lastMessageId, lastAt, lastFromMe, lastSats, amountUsd, amountChf, amountEur, amountPhp, unread, unreadMessageCount, accountId? }`. The four amounts are always present (string or null; the last message's stored payment-time fiat). `unreadMessageCount` is always present (inbound messages after last-read; `0` when none). `lastSats` is the last message's sats (`0` when unpaid or the thread is empty). `lastMessageId` is the id of the newest message (`created_at DESC, id DESC`) or `null` when the thread is empty; always present; the list does not translate. Includes `accountId` only when the counterpart id is a non-empty string. Omits event ids, npubs, `accountA` / `accountB`. No I/O.
- **Used by:** `conversationRoutes`.

## Function: serializeNotification

- **Purpose:** Project a stored notification row to its public JSON shape. `type` is `'forum_post' | 'forum_reply' | 'forum_mention' | 'zap' | 'moderator_appointed' | 'moderator_proposal'`.
- **Inputs:** `NotificationRow` (includes recipient/actor account ids).
- **Returns / side effects:** `{ id, type, parentId, replyId, name, text, createdAt, readAt }` with ISO-8601 dates; `readAt` null stays null. Omits recipient and actor account ids. No I/O.
- **Used by:** `notificationRoutes`.

## Function: fanoutToBellSubscribers

- **Purpose:** Fan out in-app rows and optional Web Push outbox rows except `skipAccountId`. In-app recipients are the union of `auth.listAccounts()` (when `auth` is set) and `push_subscription` account ids. Web Push outbox rows go only to `push_subscription` accounts. Optional `onlyAccountIds` restricts both recipient sets before notification-level matching. Optional `match` `{ actorIsStaff, isActive, mentionedAccountId }` then filters when `auth` is also set: drop recipients whose `wantsNotification` is false (level from `listAccounts()`, omitted → `all`; push-only ids not in that list are `all`). When `auth` is unset, do not filter by level even if `match` is passed. Omitted `match` keeps every-id-except-skip behaviour. Missing both `auth` and `pushStore` is a no-op. Unique duplicate `create` is fine. Outbox JSON may include optional `unreadCount` for the home-screen badge: notification unread + listed inbox unread when `inboxUnreadCount` is passed. Either source alone still writes `unreadCount` (missing source is 0).
- **Inputs:** `{ notifications?, pushStore?, auth?, skipAccountId, onlyAccountIds?, match?, template, outboxType, outboxMessageId, payload, nowMs, inboxUnreadCount? }`. `skipAccountId` `null` skips nobody. `onlyAccountIds` is an allowlist for in-app and push recipients. `match` is applied only when `auth` is also set. `template` is copied to each in-app recipient (`id` / `recipientAccountId` filled here). `payload` is the shared JSON template (no `unreadCount`).
- **Returns / side effects:** Void. Logs `push.fanout` with `inApp` and `push` counts. Writes a notification row per in-app id when `notifications` is set, then enqueues one pending outbox row per push id when `pushStore` is set. When `notifications` or `inboxUnreadCount` is set, each outbox JSON is the parsed template plus `unreadCount` (invalid JSON or a non-object template becomes `{ unreadCount }`). When both are omitted, the payload is unchanged. Per-recipient `create`/`unreadCount`/inbox/`enqueue` failures log `push.fanout.failed`, continue, then throw after the loops. Does not copy DMs into notification rows.
- **Used by:** `notifyForumPost`, `notifyForumReply`, `notifyExternalForumReply`, `notifyZap`.

## Function: notifyForumPost

- **Purpose:** Notify living-room members of a new top-level forum post except the actor. No-op when the actor is the official platform account (`isPlatform === true` via `auth.listAccounts()`). Missing auth / missing id / missing account / `isPlatform` not true still fans out. Persist a `forum_post` row when `notifications` is set (`parentId` and `replyId` are the post id) for every matching account when `auth` is set (otherwise bell subscribers) and enqueue a `/notifications` Web Push (`tag` `forum_post:<postId>`) when `pushStore` is set. Matching uses `wantsNotification`: `isActive` is `created.sats > 0`, `mentionedAccountId` is null (top-level posts are never personal), `actorIsStaff` from the actor in `auth.listAccounts()` (false if missing). When `auth` is unset, do not filter by level. Missing `pushStore` still writes in-app rows when `auth` is set. May throw; callers wrap so persist still succeeds.
- **Inputs:** `{ notifications?, pushStore?, auth?, account, created, inboxUnreadCount? }`.
- **Returns / side effects:** Void. Calls `fanoutToBellSubscribers` with skip id `account.id`, match from the post, and payload from `buildForumPushPayload` (id, name, text, and media flags from `created`). Forwards `inboxUnreadCount`. Outbox JSON `unreadCount` is notification unread + listed inbox unread when either source is passed.
- **Used by:** `messagesRoutes` after a successful top-level `POST /messages` create; `meRoutes` after a won `PUT /me/about` create (`notifyForumPost` after `updateText` with the bio); `settleInvoiceManually` / `indexOpenZapReceipts` after a platform-note compose creates a top-level post (`insertGiftReply`).

## Function: notifyForumReply

- **Purpose:** Notify living-room members of a forum reply except the actor. Persist a `forum_reply` row when `notifications` is set and enqueue a `/notifications` Web Push (`tag` `forum_reply:<replyId>`, not the parent id) when `pushStore` is set. No-op when the parent is missing. No-op when the actor is the official platform account (`isPlatform === true` via `auth.listAccounts()`). Missing auth / missing id / missing account / `isPlatform` not true still fans out. Damus-only parents and self-replies still fan out (the actor is skipped). Photo-only empty text still notifies. Matching uses `wantsNotification`: `isActive` is `parent.sats > 0`, `mentionedAccountId` is `parent.accountId` (null when the parent has no account), `actorIsStaff` from the reply actor. When `auth` is unset, do not filter by level. Missing `pushStore` still writes in-app rows when `auth` is set. Unique duplicate create is fine. May throw; callers wrap so persist still succeeds.
- **Inputs:** `{ messages, notifications?, pushStore?, auth?, account, created, parentId, inboxUnreadCount? }`.
- **Returns / side effects:** Void. After parent lookup, calls `fanoutToBellSubscribers` with skip id `account.id`, match from the parent/actor, and payload from `buildReplyPushPayload` (id, name, text, and media flags from `created`). Forwards `inboxUnreadCount`. Outbox JSON `unreadCount` is notification unread + listed inbox unread when either source is passed. Does not copy DMs into notification rows.
- **Used by:** `messagesRoutes` after a 21.gifts-author reply `POST /messages`; `runNostrWorkerTick` after inbound member reply persist; `settleInvoiceManually` / `indexOpenZapReceipts` after a platform-note compose creates a reply (`insertGiftReply`).

## Function: notifyZap

- **Purpose:** Notify living-room members of a newly indexed zap/payment except the payer. Persist a `zap` row when `notifications` is set (`text` is `String(amountSats)`, name default `'Someone'`, `replyId` is the first 32 hex of the 64-hex receipt id hyphenated 8-4-4-4-12) and enqueue a `/notifications` Web Push (`tag` `zap:<replyId>`) when `pushStore` is set. No-op when the note has no `accountId`. No-op when `payerAccountId` is the official platform account (`isPlatform === true` via `auth.listAccounts()`). Do not skip when `payerAccountId` is omitted. Missing auth / missing account / `isPlatform` not true still fans out. Does not skip the note author unless they are also `payerAccountId`. Matching uses `wantsNotification`: `isActive` is `note.sats > 0` or `amountSats > 0` (first gift still counts), `mentionedAccountId` is `note.accountId`, `actorIsStaff` from the payer when `payerAccountId` is found (otherwise false). When `auth` is unset, do not filter by level. Missing `pushStore` still writes in-app rows when `auth` is set. May throw; callers wrap so persist still succeeds.
- **Inputs:** `{ notifications?, pushStore?, auth?, note, receiptId, amountSats, nowMs, payerAccountId?, payerName?, inboxUnreadCount? }`.
- **Returns / side effects:** Void. Calls `fanoutToBellSubscribers` with skip id `payerAccountId ?? null`, match from the note/payer, and payload from `buildZapPushPayload` (`replyId`, payer name or `Someone`, and `amountSats`). Forwards `inboxUnreadCount`. Outbox JSON `unreadCount` is notification unread + listed inbox unread when either source is passed.
- **Used by:** Zap ingest in `indexOpenZapReceipts` when `indexZapReceipt` newly indexed a member-note receipt (not the official platform profile note).

## Function: notifyModeratorAppointed

- **Purpose:** Targeted to the **subject only**, not a living-room fan-out. Does not call `fanoutToBellSubscribers`. Persist a `moderator_appointed` row when `notifications` is set (`parentId` and `replyId` = `subject.id`, `text` `''`, `name` is `actor.name ?? 'Someone'`, `actorAccountId` is `actor.id`, `readAt` null) and enqueue a `/welcome` Web Push (`type: 'forum'`, `messageId: subject.id`, tag `moderator_appointed:<subjectId>`) when `pushStore` is set. Missing both stores is a no-op. Unique duplicate create is fine (store returns existing). May throw (`push.fanout.failed`); callers wrap so persist still succeeds.
- **Inputs:** `{ notifications?, pushStore?, subject, actor, nowMs, inboxUnreadCount? }`.
- **Returns / side effects:** Void. Writes one in-app row for the subject when `notifications` is set. When `pushStore` is set, enqueues one outbox row with payload from `buildModeratorAppointedPushPayload(subject.id)` (url `/welcome`, tag `moderator_appointed:<subjectId>`). Outbox JSON `unreadCount` is notification unread + listed inbox unread when either source is passed.
- **Used by:** `trustRoutes` `POST /trust/confirm-moderator` and `POST /trust/appoint-moderator` after every 200 that leaves/keeps the subject as `moderator` (new grant **and** idempotent already-moderator same-actor 200). Failure logs `push.enqueue.failed`; HTTP still 200.

## Function: notifyModeratorProposed

- **Purpose:** Notify other staff of an open moderator proposal (not a living-room fan-out). Recipients are staff from the live account list except the proposing actor and anyone with `isPlatform === true`; founder is included; basis and verified are skipped. Persist a `moderator_proposal` row when `notifications` is set (`parentId` and `replyId` = `subject.id`, `name` is `actor.name ?? 'Someone'`, `text` is `subject.name ?? ''`, `readAt` null) and enqueue a Web Push (`type: 'forum'`, url `/moderate/proposals`, tag `moderator_proposal:<subjectId>`) when `pushStore` is set. Missing both stores is a no-op. Unique duplicate create is fine. Mark-read does not dismiss these rows. May throw (`push.fanout.failed`); callers wrap so persist still succeeds.
- **Inputs:** `{ notifications?, pushStore?, inboxUnreadCount?, recipients, subject, actor, nowMs }`. Recipients are filtered here to other staff.
- **Returns / side effects:** Void. Writes one in-app row per other staff member when `notifications` is set. When `pushStore` is set, enqueues one outbox row per recipient (`type: 'forum'`, `messageId: subject.id`). Outbox JSON `unreadCount` is notification unread + listed inbox unread when either source is passed.
- **Used by:** `trustRoutes` `POST /trust/propose-moderator` after every 200, and `POST /trust/reject-moderator` when a re-list after dropping `moderator_proposal` rows shows a new pending propose (not for the reject itself). Failure logs `push.enqueue.failed`; HTTP still 200.

## Function: parseNotificationLevel

- **Purpose:** Map a stored or request value to the owner fan-out enum so omitted and unknown strings keep current every-account behaviour. Accepts only the strings `all`, `active`, and `mentions`; any other input (number, null, undefined, object, unknown string) becomes `all`.
- **Inputs:** `raw` unknown (DB text, JSON body, omitted field).
- **Returns / side effects:** `NotificationLevel`. No I/O.
- **Used by:** `mapAccount`, `serializeOwnerAccount`, `fanoutToBellSubscribers` via `filterIdsByMatch`.

## Function: parseAmountUnit

- **Purpose:** Map a stored or request value to the owner amount-entry unit so omitted and unknown strings keep the default `btc`. Accepts only the strings `btc` and `fiat`; any other input (number, null, undefined, object, unknown string) becomes `btc`.
- **Inputs:** `raw` unknown (DB text, JSON body, omitted field on the account row). Fail-open: only exact `btc` or exact `fiat` are kept.
- **Returns / side effects:** `AmountUnit` (`btc` or `fiat`). No I/O. Never throws; garbage text and null become `btc`.
- **Used by:** `mapAccount` in `PostgresAuthStore` and `serializeOwnerAccount` so owner JSON always has `amountUnit`.

## Function: parseStoredLocale

- **Purpose:** Map a stored account locale so unknown, null, and undefined become null and do not default to a language. Accepts only the exact strings `en`, `de`, `es`, and `fil`; any other input (number, null, undefined, object, unknown string) becomes `null`.
- **Inputs:** `raw` unknown (DB text, JSON, omitted field on the account row). Fail-closed: only exact `en`, `de`, `es`, or `fil` are kept; nothing else becomes a language.
- **Returns / side effects:** `AccountLocale | null`. No I/O. Never throws; garbage text, null, and undefined become `null` rather than a default language.
- **Used by:** `mapAccount`, `serializeOwnerAccount`, and `serializeDebugAccount` so owner and debug JSON always include `locale` (null when unset).

## Function: parseStoredFiat

- **Purpose:** Map a stored account fiat currency so unknown, null, and undefined become null and do not default to a currency. Accepts only the exact strings `CHF`, `EUR`, `USD`, and `PHP`; any other input (number, null, undefined, object, unknown string) becomes `null`.
- **Inputs:** `raw` unknown (DB text, JSON, omitted field on the account row). Fail-closed: only exact `CHF`, `EUR`, `USD`, or `PHP` are kept; nothing else becomes a currency.
- **Returns / side effects:** `AccountFiat | null`. No I/O. Never throws; garbage text, null, and undefined become `null` rather than a default currency.
- **Used by:** `mapAccount`, `serializeOwnerAccount`, and `serializeDebugAccount` so owner and debug JSON always include `fiat` (null when unset).

## Function: isStaffAccount

- **Purpose:** True when this account is a staff/admin actor for `mentions` fan-out. Delegates to `roleAtLeast(role, 'moderator')` for known roles (`basis` / `verified` false). `isPlatform === true` is staff even when `role` is `basis`. Unknown role strings are not found in `ROLE_ORDER` and are therefore not staff. Does not parse display names or @mentions out of post text.
- **Inputs:** `{ role: string; isPlatform?: boolean }`.
- **Returns / side effects:** boolean. No I/O.
- **Used by:** `notifyForumPost`, `notifyForumReply`, `notifyZap` via `actorIsStaffFromAuth`.

## Function: wantsNotification

- **Purpose:** Whether a recipient at `level` should receive this living-room event for in-app rows and Web Push. `all` is always true. `active` is `isActive`. `mentions` is a staff actor or `mentionedAccountId === recipientAccountId` when the mention id is non-null.
- **Inputs:** `{ level: NotificationLevel; actorIsStaff: boolean; isActive: boolean; mentionedAccountId: string | null; recipientAccountId: string }`.
- **Returns / side effects:** boolean. No I/O.
- **Used by:** `fanoutToBellSubscribers` after skip when `auth` and `match` are set.

## Function: notificationsMatchingLevel

- **Purpose:** Keep stored in-app rows the owner's current `notificationLevel` would still accept, same rules as `wantsNotification`. `all` returns the rows unchanged. `moderator_appointed` and `moderator_proposal` always stay. `forum_post` is never personal (`mentionedAccountId` null). `forum_mention` is personal for the marked recipient and active only when the parent exists and `parent.sats > 0` (a missing parent is not active and still personal). `forum_reply` / `zap` use the parent note's `accountId` and `sats` from `parentById`; a missing parent is unpaid and not personal. Zap `text` is the amount string and still counts as active when `> 0`. Zap actor staff is the stored actor via `isStaffAccount` only when that actor is not the parent note author (missing payer is not staff).
- **Inputs:** `{ rows, level, recipientAccountId, accounts, parentById }`.
- **Returns / side effects:** Matching rows in the same order. No I/O.
- **Used by:** `notificationRoutes` `GET /notifications` after scanning the newest `NOTIFICATION_FILTER_SCAN_LIMIT` rows.

## Function: conversationPushRecipientIds

- **Purpose:** 21.gifts account ids to Web-Push for a private-message (unique, no null, never the sender). Damus inbound (`senderAccountId === null`) notifies `accountA`; a member send on `member_damus` notifies nobody. `member_member` / `member_platform` notify the other of `accountA` / `accountB` when that id is a string and not the sender. `moderator_group` notifies `moderatorIds` except the sender (not `accountA` / platform).
- **Inputs:** `ConversationThread`, `senderAccountId` (`string | null`), optional `moderatorIds` (`readonly string[]`, default `[]`; used only for `moderator_group`).
- **Returns / side effects:** `string[]`. No I/O.
- **Used by:** `notifyConversationMessage`.

## Function: inboxUnreadCountFor

- **Purpose:** Build the fan-out `inboxUnreadCount` callback: listed GET `/conversations` unread for one account. Staff comes from `getAccount` + `roleAtLeast(role, 'moderator')`, the `moderator` flag from `isModeratorGroupMember` (at least moderator and not the platform account). GET `/conversations` never lists `moderator_group` (fifth argument always false); this helper still pins that thread in the badge unread count for every group member. Platform id from `listAccounts` / `isPlatform`. Lookup failure yields staff false, moderator false, and `platformId` null.
- **Inputs:** `ConversationStore`, `Pick<AuthStore, 'getAccount' | 'listAccounts'>`.
- **Returns / side effects:** `(accountId) => Promise<number>` calling `conversations.unreadCount`.
- **Used by:** `notifyConversationMessage`; `notifyForumPost` / `notifyForumReply` / `notifyZap` / `notifyModeratorAppointed` / `notifyModeratorProposed` callers that have a conversation store (`messagesRoutes`, `meRoutes`, `indexOpenZapReceipts`, `runNostrWorkerTick`, `trustRoutes`).

## Function: notifyConversationMessage

- **Purpose:** Enqueue one `type: 'conversation'` Web Push per 21.gifts recipient with at least one `push_subscription`. No-op when `pushStore` is omitted. Does not write in-app Notification rows. Payload from `buildConversationPushPayload` plus `unreadCount` = notification unread + listed inbox unread (missing source 0). `messageId` is the conversation message UUID. For `moderator_group`, recipients are every account with `roleAtLeast(role, 'moderator')` and `isPlatform !== true` from `listAccounts` (the platform account is omitted) and the payload URL is `/moderate/group`; other kinds keep `/messages?c=<conversationId>`. Per-recipient failures log `conversations.push.failed` and continue; throws after the loop when any failed. Callers still catch so HTTP/Nostr ingest stays 200.
- **Inputs:** `{ pushStore?, notifications?, conversations, authStore, thread, message, nowMs }`.
- **Returns / side effects:** Void. Skip recipients with zero subscriptions. Title is `message.name` or `21.gifts` when empty. URL `/messages?c=<conversationId>` for member threads; `/moderate/group` when `thread.kind` is `moderator_group`. Tag `conversation:<conversationId>`.
- **Used by:** `conversationRoutes` `POST /:id`; `contactRoutes` after conversation append; `indexInboundDirectMessages` after inbound persist.

## Function: serializeConversationMessage

- **Purpose:** Project a stored conversation message to its public JSON shape.
- **Inputs:** `ConversationMessageRow`, `fromMe` boolean, optional `{ staff: true }`.
- **Returns / side effects:** `{ id, name, text, createdAt, fromMe, sats, amountUsd, amountChf, amountEur, amountPhp, hasPhoto, photoCount, accountId?, giftFor? }`. The four amounts are always present (string or null). Always includes `hasPhoto` (boolean) and `photoCount` (0–10); never photo bytes. `sats` is the message amount (`0` when unpaid). Staff with `actorAccountId` get actor `name`/`accountId`; members get sender fields. `giftFor` is set from `giftForMessageId` when that id is a non-empty string (paid moderator stipend). Omits event ids, `senderAccountId`, and `senderPubkey`. No I/O.
- **Used by:** `conversationRoutes`.

## Function: conversationFromMe

- **Purpose:** Viewer-relative direction for a stored message: true when the actor (else sender) is the session account. No staff-as-platform shortcut.
- **Inputs:** `{ senderAccountId, actorAccountId, viewerId }`. Null actor and sender is false.
- **Returns / side effects:** boolean. No I/O.
- **Used by:** `conversationRoutes` (list `lastFromMe`, thread `fromMe`); `conversationIsInbound`.

## Function: conversationIsInbound

- **Purpose:** Whether a stored message is inbound for the viewer (not the actor). Null Damus sender/actor is inbound.
- **Inputs:** `{ senderAccountId, actorAccountId, viewerId }`.
- **Returns / side effects:** `!conversationFromMe(args)`. No I/O.
- **Used by:** `InMemoryConversationStore.hasInboundMessage`.

## Function: unsignedConversationDefaults

- **Purpose:** Unsigned/pending defaults for a locally persisted conversation message.
- **Inputs:** none.
- **Returns / side effects:** `{ sats: 0, eventId: null, nostrPublishState: 'pending', nostrEvent: null, claimedUntil: null, actorAccountId: null, actorName: '' }`.
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
- **Used by:** `debugContactsRoutes` and dump table `contact` (`loadDebugTables`).

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

- **Purpose:** Hono middleware: `http.request` JSON after the handler, then one `api_log` row. Skips `/healthz` and OPTIONS. Never logs the query string, body, or Authorization. Path is passed through `requestLogPath` so `/view/<segment>` is redacted. `ms` is handler duration (captured once after `next`). Auth-classification failure still stores `authKind: 'none'` with `accountId` null. Store write failure logs `api_log.write.failed` and does not replace the response.
- **Inputs:** `{ apiLogStore, authStore, debugToken, spendApiToken, now? }`.
- **Returns / side effects:** `MiddlewareHandler`.
- **Used by:** `createApp`.

## Function: serializeDebugApiLog

- **Purpose:** Project an `api_log` row to operator JSON (`createdAt` ISO-8601).
- **Inputs:** `ApiLogRow`.
- **Returns / side effects:** `DebugApiLog`. No I/O.
- **Used by:** `debugApiLogRoutes`, `loadDebugTables`.

## Function: InMemoryApiLogStore

- **Purpose:** Process-local `ApiLogStore` (newest `createdAt` then `id` desc).
- **Inputs:** Optional seed rows.
- **Returns / side effects:** `append` / `listLatest` copies.
- **Used by:** `createApp` default; tests.

## Function: PostgresApiLogStore

- **Purpose:** Durable `ApiLogStore` over `api_log`.
- **Inputs:** Parameter-bound `SqlClient` (already migrated).
- **Returns / side effects:** Inserts and newest-first selects. No UPDATE/DELETE.
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: migrateApiLogSchema

- **Purpose:** Idempotent DDL for `api_log`. Must run after `account` exists and before `migrateDbChangeSchema`.
- **Inputs:** `SqlClient`.
- **Returns / side effects:** Executes `API_LOG_SCHEMA_SQL` in order.
- **Used by:** `openBootStores`.

## Function: resolveRequestAuth

- **Purpose:** Classify Authorization as `debug`, `spend`, `session`, or `none`. Debug and spend use the constant-time debug-token compare. Session goes through `resolveSession`. Never returns the token.
- **Inputs:** Header, `AuthStore`, `now`, optional debug and spend tokens.
- **Returns / side effects:** `{ accountId, authKind }`.
- **Used by:** `requestLog`.

## Function: debugDbRoutes

- **Purpose:** Hono app for `GET /debug/db`.
- **Inputs:** Optional `DebugDbStore` and optional `debugToken`.
- **Returns / side effects:** 503 if the token is blank; 401 if the bearer mismatches; 400 if `cursor` has no `table`; 503 if the store is omitted; 200 `{ tables }` or one page; 404 for an unknown table; 400 on `DebugDbCursorError`; 503 `Database is unavailable` on any other throw. Omits `nextCursor` when it is null.
- **Used by:** `createApp` at `/debug/db`.

## Function: PostgresDebugDbStore

- **Purpose:** Read every ordinary `public` table through a `SqlClient`, one keyset page at a time. No primary key, or a primary key that is a secret column, uses `ctid` so the cursor is not the secret.
- **Inputs:** `SqlClient`. `listTables()` takes none. `readPage(table, cursor)` takes a catalog name and a cursor or null.
- **Returns / side effects:** Table counts, or a page whose `bytea` cells are lengths and whose secret text cells are `"redacted"`. `undefined` for an unknown table. Throws `DebugDbCursorError` for a bad cursor. Does not cache the catalog.
- **Used by:** `debugDbRoutes` via `openBootStores` when `DATABASE_URL` is set.

## Function: DebugDbCursorError

- **Purpose:** Signal that a `GET /debug/db` cursor does not decode or does not match the table key.
- **Inputs:** Optional message. The HTTP body stays `Invalid cursor`.
- **Returns / side effects:** An `Error` subclass. No I/O.
- **Used by:** `PostgresDebugDbStore.readPage` and `debugDbRoutes`.

## Function: debugApiLogRoutes

- **Purpose:** Hono app for `GET /debug/api-log`.
- **Inputs:** `ApiLogStore` and optional `debugToken`.
- **Returns / side effects:** 503 if token blank; 401 if bearer mismatches; 200 `{ logs }` cap 200; 503 `Log is unavailable` on store throw.
- **Used by:** `createApp` at `/debug/api-log`.

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

- **Purpose:** GET `https://domain/.well-known/lnurlp/local` and parse metadata. The well-known metadata fetch aborts after 10 seconds (`LNURLP_METADATA_TIMEOUT_MS`); the abort collapses into `{ ok: false, reason: 'unreachable' }` like any other unreachable failure.
- **Inputs:** address + fetchImpl.
- **Returns / side effects:** Callback URL, min/max sendable, optional NIP-57 `allowsNostr` / `nostrPubkey`, or `{ ok: false, reason: 'unreachable' }` (including timeout).
- **Used by:** `lightningAddressRoutes`, `POST /me/lightning-address` (`meRoutes`), `requestPayInvoice`, `requestGiftInvoice`, `requestZapInvoice`, `indexOpenZapReceipts` (provider-pubkey check via `resolveProviderPubkey`), `probeNip57Mint`, `payRoutes`, `posRoutes`.

## Function: resolveLnurlpDocument

- **Purpose:** Same well-known fetch as `resolveLnurlp`, but returns the provider JSON object so `GET /.well-known/lnurlp/:username` can pass Wallet of Satoshi through unchanged (invoice hashes stay valid; settlement stays at WoS). The well-known metadata fetch aborts after 10 seconds (`LNURLP_METADATA_TIMEOUT_MS`); the abort collapses into `{ ok: false, reason: 'unreachable' }` like any other unreachable failure.
- **Inputs:** address + fetchImpl.
- **Returns / side effects:** `{ ok: true, body }` or `{ ok: false, reason: 'unreachable' }` (including timeout). No I/O besides the injected fetch.
- **Used by:** `wellKnownRoutes`.

## Function: resolveSession

- **Purpose:** Looks up a bearer session; rejects expired tokens and accounts with `sessionRefused` (`isWrongAccount`).
- **Inputs:** `store`, `now`, `token`.
- **Returns / side effects:** `Account` or `null` when unknown, expired, or refused.
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

- **Purpose:** Verifies a discoverable-credential assertion, CAS-updates signCount, issues a session only when the CAS succeeds. Optional `nostr` best-effort backfills a missing nsec. After the account is loaded, `sessionRefused` returns `{ ok: false, error }` with the wrong-account copy and never issues a token.
- **Inputs:** store, ceremony, config, now, Origin, challengeId, credential, optional `nostr`.
- **Returns / side effects:** `{ ok: true, value: { token, account } }` or `{ ok: false, error }`. CAS failure is `{ ok: false, error: 'Invalid passkey' }`. `sessionRefused`: `{ ok: false, error: 'You signed in with the wrong account. Please try again with the correct account.' }`.
- **Used by:** `POST /auth/passkey/authenticate/finish`.

## Function: finishPasskeyRegistration

- **Purpose:** Verifies an attestation and issues a session. When the challenge account id already exists (claim path), `sessionRefused` is refused before `accountHasPasskey` / `createFirstPasskeyCredential`; a concurrent refuse during that insert is the same wrong-account error and does not leave a bound credential. Otherwise binds the credential to that provisioned row without `createAccount` and never `deleteAccount` on failure, and sets `walletRequired: true` without clearing `walletBackupSeenAt`. When the account is new, creates a `linkingKey: null` account plus credential with `walletRequired: true` and `walletBackupSeenAt: null`; optional `nostr` mints a custodial nsec (rollback on keygen failure) and a duplicate credential id rolls the new account back. Concurrent `tryCreateSession` failure is the same wrong-account error, not an uncaught throw.
- **Inputs:** store, ceremony, config, now, Origin, challengeId, credential, optional `nostr`.
- **Returns / side effects:** `{ ok: true, value: { token, account } }` or `{ ok: false, error }`. Claim-path credential race → `{ ok: false, error: 'Invalid passkey' }` with the provisioned account left intact. Nostr keygen failure on claim is best-effort (same as authenticate): session still issues. `sessionRefused`: `{ ok: false, error: 'You signed in with the wrong account. Please try again with the correct account.' }` and no bearer.
- **Used by:** `POST /auth/passkey/register/finish`.

## Function: isWrongAccount

- **Purpose:** Whether a stored account must not receive a session (`account.sessionRefused`).
- **Inputs:** Account (or `{ sessionRefused }`).
- **Returns / side effects:** `true` when `sessionRefused` is true. No I/O. No hardcoded ids.
- **Used by:** `issueSession`, `resolveSession`, `finishPasskeyAuthentication`, `finishPasskeyRegistration`, `GET /me`, `POST /debug/accounts/:id/session`.

## Function: issueSession

- **Purpose:** Mints a bearer session token for an already-authenticated account. Accounts with `sessionRefused` (`isWrongAccount`) throw `Error` whose message is the wrong-account copy and do not write a session row. Insert uses `tryCreateSession` so a concurrent flag flip cannot mint a bearer.
- **Inputs:** `store`, `now`, `account`.
- **Returns / side effects:** `{ token, account }` with the current account row. Throws `Error` with message `You signed in with the wrong account. Please try again with the correct account.` when `sessionRefused` is true or `tryCreateSession` writes no row.
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

- **Purpose:** Production `PasskeyCeremony` wrapping `@simplewebauthn/server` (residentKey + userVerification required). Registration options set `extensions.prf: {}` and optional `excludeCredentials`. Authentication options set `extensions.prf.eval.first` to the base64url PRF salt.
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

## Function: startPasskeyReplace

- **Purpose:** Mints WebAuthn creation options that exclude the signed-in account's current credential (`type: 'replace'` challenge bound to that account id).
- **Inputs:** store, ceremony, config, now, account.
- **Returns / side effects:** `{ challengeId, options }` or `{ ok: false, error: 'No passkey to replace' }`. Persists a replace challenge. Does not mint a session.
- **Actions:** Load the account credential; refuse when missing; generate registration options with `excludeCredentials`; store a `replace` challenge with the signed-in account id.
- **Used by:** Domain tests. The HTTP route `POST /auth/passkey/replace/begin` returns 409 and does not create a challenge.

## Function: finishPasskeyReplace

- **Purpose:** Verifies a new attestation and replaces the account's one passkey. Does not mint a session.
- **Inputs:** store, ceremony, config, now, origin, challengeId, credential, account.
- **Returns / side effects:** `{ ok: true, account }` or `{ ok: false, error }`. Old credential row is gone on success. Challenge is consume-once.
- **Actions:** Check origin; load a `replace` challenge; require challenge `accountId` to match the Bearer account; verify registration; refuse same id or an id owned by another account; `replacePasskeyCredential`.
- **Used by:** Domain tests. The HTTP route `POST /auth/passkey/replace/finish` does not call it and deletes nothing.

## Function: startPasskeySeed

- **Purpose:** Mints WebAuthn creation options for one extra seed passkey. Does not set `excludeCredentials`. Does not delete a credential. `walletRequired: true` means a seed passkey already exists. `walletBackupSeenAt` is not read.
- **Inputs:** store, ceremony, config, now, account.
- **Returns / side effects:** `{ challengeId, options }` or `{ ok: false, error: 'This account already has a recovery phrase' }`. Persists a `seed` challenge bound to the account id only when `walletRequired` is not true. Does not mint a session.
- **Actions:** Refuse when `account.walletRequired === true`. Otherwise generate registration options with the account id as user id and user name (`userDisplayName` is `account.name ?? '21.gifts'`) and store a `seed` challenge.
- **Used by:** `POST /auth/passkey/seed/begin`.

## Function: finishPasskeySeed

- **Purpose:** Verifies a new attestation and inserts an additional passkey. Sets `walletRequired` true. Does not delete the login passkey, does not change `walletBackupSeenAt`, and does not mint a session. A recovery phrase is never replaced.
- **Inputs:** store, ceremony, config, now, origin, challengeId, credential, account.
- **Returns / side effects:** `{ ok: true, account }` with the reloaded account (`walletRequired` true) or `{ ok: false, error }`. Ceremony failures use the same 400 strings as replace finish. A taken credential id, a refused or missing account, or a failed insert uses `'This account already has a recovery phrase'`.
- **Actions:** Check origin; refuse when `walletRequired` or `sessionRefused`; load a `seed` challenge; require `accountId` to match; verify registration; refuse an id that is already stored; `addSeedPasskeyCredential`; reload the account.
- **Used by:** `POST /auth/passkey/seed/finish`.

## Function: addSeedPasskeyCredential

- **Purpose:** Insert one more passkey_credential and set `walletRequired` true in the same write. Allowed when the account already has a login passkey. Refuses when the account is missing, `sessionRefused`, `walletRequired` is already true, or the credential id exists. Does not delete. Does not change `walletBackupSeenAt`.
- **Inputs:** `credential` (`PasskeyCredential`) on `AuthStore`.
- **Returns / side effects:** `true` when the row landed and `walletRequired` is true. `false` with no write otherwise. Postgres is one CTE (`FOR UPDATE` on the account, insert, then `SET wallet_required = TRUE`). No `DELETE`.
- **Used by:** `finishPasskeySeed`.

## Function: prfEvalFirstSalt

- **Purpose:** SHA-256 of the frozen label `21gifts-nostr-v1` as the WebAuthn PRF `eval.first` salt (32 bytes).
- **Inputs:** None.
- **Returns / side effects:** `Uint8Array` of length 32. The api never sees PRF output or a mnemonic.
- **Actions:** Hash `PRF_EVAL_FIRST_LABEL` with SHA-256 and return the digest bytes.
- **Used by:** `SimpleWebAuthnPasskeyCeremony.generateAuthenticationOptions`.

## Function: accountSetup

- **Purpose:** Next owner wizard step from stored account fields. Order is name → username (not skippable) → lightning-address → rules. The recovery phrase is not a setup step and does not change `setup` or `missing`. Wallet backup is not a setup step. Skip timestamps count as done for name and Lightning Address only. The api is the source of truth; clients only route.
- **Inputs:** `Account`.
- **Returns / side effects:** `'name'` when name is null/blank and `nameSkippedAt` is unset, else `'username'` when username is null/undefined/blank (cannot skip), else `'lightning-address'` when Lightning Address is null/blank and `lightningAddressSkippedAt` is unset, else `'rules'` when `rulesAgreedAt` is null, else `null`. Never `'wallet'`. No I/O.
- **Used by:** `serializeOwnerAccount`.

## Function: accountMissing

- **Purpose:** Factually unset account fields for action gates. Skip timestamps do not clear a field from this list.
- **Inputs:** `Account`.
- **Returns / side effects:** `AccountMissingField[]` in order `name`, `username`, `lightning-address`, `rules` (only those that are null/blank or rules unset). Never includes `wallet`. Skip timestamps still do not clear name/username/lightning-address/rules. No I/O.
- **Used by:** `serializeOwnerAccount`, `requireAction`.

## Function: actionRequirements

- **Purpose:** Declare which account fields an action needs before it may proceed.
- **Inputs:** `AccountAction` (`forum.read` \| `forum.post` \| `contact.post` \| `forum.pay`).
- **Returns / side effects:** Readonly list in 409 order: `forum.read` → `rules`; `forum.post` → `rules`, `name`, `username`, `lightning-address`; `contact.post` → `rules`, `name`, `username`; `forum.pay` → `rules`. No I/O.
- **Used by:** `requireAction`.

## Function: requireAction

- **Purpose:** Gate a signed-in action on factual account fields (skip does not satisfy). Filters `accountMissing` to the action's needs, preserving `actionRequirements` order. Wallet backup is neither a setup step nor an action requirement.
- **Inputs:** `Account`, `AccountAction`.
- **Returns / side effects:** `{ ok: true }` or `{ ok: false, missing }` (never empty). No I/O. Routes respond 409 `{ error: 'missing_requirements', missing }` when `ok` is false.
- **Used by:** `messagesRoutes`, `contactRoutes`, `membersRoutes`.

## Function: ensureProfileMessage

- **Purpose:** Ensure a named account with a non-blank Lightning Address has exactly one live top-level profile forum note. No-ops when name or Lightning Address is null/blank after trim. When both are set, the first insert creates one message (kind:1 pipeline defaults, frozen tags only) and claims `profileMessageId` via `claimProfileMessageId` (set only while the pointer still matches the missing/hidden read). Rename is idempotent and does not change note text. Recreates when the stored id is missing or the row is soft-hidden (`deletedAt` set). A live `profileMessageId` winner is adopted and the insert is deleted; a hidden winner is missing — the created live note is kept and `profileMessageId` is claimed onto it. A lost claim deletes the insert and adopts a live winner when one exists. Rolls back the insert if the claim throws. A successful won claim whose confirmation still points at the created note does not call `notifyForumPost` (the note text is the display name, not a living-room post).
- **Inputs:** `{ auth, messages, account, now, pushStore?, notifications?, conversations? }`.
- **Returns / side effects:** The account (possibly with `profileMessageId` set). May insert a message and claim the pointer; may delete an orphaned insert on claim failure, a vanished row, or a later live `profileMessageId` winner.
- **Used by:** `meRoutes` (`POST /me/name`, `POST /me/lightning-address`), `messagesRoutes` (`GET /compose-target`), `debugRoutes` provision, Nostr worker backfill.

## Function: serializeAccount

- **Purpose:** Project an account to the eleven-field dump without `viewKey` or `isPlatform` (no Nostr fields).
- **Inputs:** `Account`.
- **Returns / side effects:** Eleven public fields (`id`, `linkingKey`, `role`, `name`, `username`, `location`, `lightningAddress`, `lightningAddressVerified`, `forumLawsDismissed`, `createdAt`, `rulesAgreedAt`). `username` is `string | null` (LUD-16 / NIP-05 local-part). `location` is `string | null` (never omitted, never `""`). No I/O. No Nostr key material.
- **Used by:** `serializeOwnerAccount` (member `/me`) and `serializeDebugAccount`.

## Function: serializeDebugAccount

- **Purpose:** Operator account JSON: every stored account column plus Nostr debug fields. Never used by member `GET /me`.
- **Inputs:** `Account` and optional `DebugNostrFields` (defaults to all-null).
- **Returns / side effects:** `DebugAccountResponse` including `username`, `viewKey`, `sessionRefused`, skip stamps, `profileMessageId`, `notificationLevel`, `amountUnit`, `locale`, `fiat`, `walletRequired`, `walletBackupSeenAt`, and envelope hex `nostrNsecCiphertext`. Never decrypts. No I/O.
- **Used by:** `GET /debug/accounts`, `PATCH /debug/accounts/:id`, and the operator dump.

## Function: serializeDebugAccountDetail

- **Purpose:** Operator one-account JSON with nested passkeys, sessions, address verification, and passkey challenges.
- **Inputs:** `Account`, `DebugNostrFields`, nested credential/session/verification/challenge rows.
- **Returns / side effects:** `DebugAccountDetailResponse`. Passkey `publicKey` is lowercase COSE hex. `nostrNsecCiphertext` is envelope hex, never decrypted. Nested `sessions[].token` is the stored plaintext token. No I/O.
- **Used by:** `GET /debug/accounts/:id`.

## Function: serializeDebugPasskey

- **Purpose:** Operator JSON for one `passkey_credential` row.
- **Inputs:** `PasskeyCredential`.
- **Returns / side effects:** `{ credentialId, publicKey, signCount, accountId, createdAt }` with hex `publicKey`. No I/O.
- **Used by:** `serializeDebugAccountDetail` and dump table `passkey_credential`.

## Function: serializeDebugSession

- **Purpose:** Operator JSON for one `auth_session` row (plaintext stored token).
- **Inputs:** `Session`.
- **Returns / side effects:** `{ token, accountId, createdAt }`. No I/O.
- **Used by:** `serializeDebugAccountDetail` and dump table `auth_session`.

## Function: serializeDebugAddressVerification

- **Purpose:** Operator JSON for one `address_verification` row.
- **Inputs:** `AddressVerification`.
- **Returns / side effects:** `{ accountId, address, nonce, createdAt }`. No I/O.
- **Used by:** `serializeDebugAccountDetail` and dump table `address_verification`.

## Function: serializeDebugPasskeyChallenge

- **Purpose:** Operator JSON for one `passkey_challenge` row.
- **Inputs:** `PasskeyChallenge`.
- **Returns / side effects:** `{ id, type, challenge, accountId, consumed, createdAt }`. No I/O.
- **Used by:** `serializeDebugAccountDetail` and dump table `passkey_challenge`.

## Function: debugNostrFieldsFromListRow

- **Purpose:** Map a `NostrKeyListRow` (or missing row) to `DebugNostrFields`. Missing row → all-null `EMPTY_DEBUG_NOSTR`. Listed row with `pubkey === null` still emits stored `kekId` and `custody`. Never decrypts. No I/O.
- **Inputs:** Optional list row from `AuthStore.listNostrKeys` (`undefined` when the account is absent from the list).
- **Returns / side effects:** Missing row → all-null `EMPTY_DEBUG_NOSTR`. Listed row emits stored kek/custody even when pubkey is null; ciphertext is envelope hex or `null` if empty. Never decrypts. No I/O.
- **Used by:** Debug account listing, GET `/:id`, PATCH `/:id`, and dump table `account`.

## Function: isDebugCatalogTable

- **Purpose:** Guard the `/debug/dump/:table` path segment.
- **Inputs:** Table name string.
- **Returns / side effects:** True when the name is in `DEBUG_CATALOG_TABLES`. No I/O.
- **Used by:** `debugCatalogRoutes`.

## Function: loadDebugTables

- **Purpose:** Load operator dump rows for one table or every allowlisted table (cap 200). The forum `message` dump includes stored still metadata as lengths/MIME only (`photoContentType`, `photoBytes`, nested `extraPhotos: [{ idx, photoContentType, bytes, photoTakenAt }]`). The `conversation_message` dump uses that length/MIME shape without `photoTakenAt`. No payloads; missing photo is `null` / `0` / `[]`.
- **Inputs:** `DebugCatalogDeps` and optional table name.
- **Returns / side effects:** `Record<DebugCatalogTable, unknown[]>`. Missing optional stores dump as `[]`.
- **Used by:** `debugCatalogRoutes`.

## Function: debugCatalogRoutes

- **Purpose:** GET-only operator catalog at `/debug/dump` and `/debug/dump/:table`.
- **Inputs:** `DebugCatalogRouteDeps` (auth, messages, contacts, optional `pos` and other stores, debugToken). Missing `pos` dumps `pos_charge` as `[]`.
- **Returns / side effects:** Hono app. 503 if token unset; 401 if bearer mismatches; 404 unknown table; 200 dump JSON (GET `/` is `{ tables }` with each allowlisted name → row array, cap 200; GET `/:table` is `{ table, rows }`); 503 `{ error: 'Dump is unavailable' }` on store throw.
- **Used by:** `createApp` at `/debug/dump`.

## Function: aboutMeFromNote

- **Purpose:** Map profile-note text to the public About me field. Empty text is not a bio. When the trimmed text equals the trimmed display name case-insensitively, the auto name-copy is not a bio (`null`). When the trimmed text equals the profile note's stored `name` case-insensitively (and that stored name is non-empty), it is also unfilled — so Ada→Grace with note text still `Ada` stays `null`.
- **Inputs:** `name` (`string | null`), `text` (`string | null`), optional `storedNoteName` (`string | null`, default `null`). Production serializers that have a live `MessageRow` pass `row.name`.
- **Returns / side effects:** Trimmed bio string, or `null`. No I/O.
- **Used by:** `serializeOwnerAccountWithPosts`, `viewRoutes`, `membersRoutes`.

## Function: serializeOwnerAccount

- **Purpose:** Owner JSON for authenticated account responses: the eleven public fields (including username and location) plus `viewKey`, `setup`, `missing`, `hasPosted`, `aboutMe`, `aboutMeHasPhoto`, `aboutMessageId` (live profile-note id only when `aboutMe !== null`, else `null`; never `profileMessageId` under another name), `notificationLevel` (`all` / `active` / `mentions`, default `all`, owner-only), `amountUnit` (`btc` / `fiat`, default `btc`, owner-only), `locale` (`en` / `de` / `es` / `fil`, nullable, null when unset, owner-only), `fiat` (`CHF` / `EUR` / `USD` / `PHP`, nullable, null when unset, owner-only), `funding` (`null` for `basis`), `walletRequired` (false when omitted), `walletBackupSeenAt` (null when omitted), and `passkeyCredentialId` (base64url or null; null when `walletRequired` is not true even if a login passkey exists, and the newest id when `walletRequired` is true), so the owner can copy the capability URL and the client can route onboarding, action gates, the introduce-yourself popup, About me photo display, living-room notify filter, amount-entry unit, funding status, and recovery-phrase reveal. Used by `GET /me`, `/me` writes including `POST /me/username`, `POST /me/rules-agreement`, `POST /me/setup/skip`, `POST /me/wallet-backup-seen`, `POST /me/location`, `POST /me/notification-level`, `POST /me/amount-unit`, `POST /me/locale`, `POST /me/fiat`, and `PUT /me/about`, and passkey finish — never by the debug listing. Does not expose `profileMessageId`.
- **Inputs:** `Account` plus `hasPosted: boolean` plus `aboutMe: string | null` plus `aboutMeHasPhoto: boolean` plus optional `funding` (`OwnerFundingJson | null`, default `null`) plus optional `passkeyCredentialId` (`string | null`, default `null`).
- **Returns / side effects:** `OwnerAccountResponse` (twenty-six fields: eleven public + `viewKey`, `setup`, `missing`, `hasPosted`, `aboutMe`, `aboutMeHasPhoto`, `aboutMessageId`, `notificationLevel`, `amountUnit`, `locale`, `fiat`, `funding`, `walletRequired`, `walletBackupSeenAt`, `passkeyCredentialId`). No I/O. Does not expose `profileMessageId`. `aboutMessageId` is the live profile-note id only when `aboutMe !== null`, else `null`.
- **Used by:** `serializeOwnerAccountWithPosts` (`meRoutes` including `POST /me/username`).

## Function: serializeOwnerAccountWithPosts

- **Purpose:** Async owner JSON with live-post lookup and profile-note About me. Calls `accountHasLivePost(account.id, account.profileMessageId ?? null)`, loads the profile note via `getById` when `profileMessageId` is non-blank, then `serializeOwnerAccount` so HTTP callers cannot drift. `aboutMe` is `null` when the profile note is missing or `deletedAt` is set (`getById` still returns soft-hidden rows; the serializer requires `row.deletedAt === null` — see `src/lib/auth/account-json.ts` 267: `if (row !== undefined && row.deletedAt === null)`). A live row passes `aboutMeFromNote(account.name, row.text, row.name)` so auto name-copy stays unfilled after a display-name rename, and `aboutMeHasPhoto` from `row.hasPhoto === true`. Overlay `hasPosted` is `accountHasLivePost` OR a real bio (`aboutMe !== null`) and is **not** the spend/invoice predicate. Spend eligibility is `accountHasLiveTopLevelPost` / `GET /invoices/posted`. Optional funding lookup loads the grant via `getByAccountId` and admitted `reviewedByName`, and, only when `walletRequired === true`, `authStore.getPasskeyCredentialForAccount` for `passkeyCredentialId` (the newest id by `createdAt` desc, then `credentialId` desc / `COLLATE "C"`; omitted lookup or `walletRequired` not true leaves that field `null`).
- **Inputs:** `Account`, `Pick<MessageStore, 'accountHasLivePost' | 'getById'>`, optional `OwnerFundingLookup` (`store`, `nowMs`, `authStore` with `getAccount` and `getPasskeyCredentialForAccount`).
- **Returns / side effects:** `OwnerAccountResponse` including `hasPosted`, `aboutMe`, `aboutMeHasPhoto`, `aboutMessageId` (live profile-note id only when `aboutMe !== null`, else `null`; never `profileMessageId` under another name), `notificationLevel`, `amountUnit` (`btc` / `fiat`, default `btc`, owner-only), `locale`, `fiat`, `funding`, `walletRequired`, `walletBackupSeenAt`, and `passkeyCredentialId`. Overlay `hasPosted` is `accountHasLivePost` OR a real bio (`aboutMe !== null`); spend/invoice lookup is `accountHasLiveTopLevelPost`. Omitted funding lookup is `basis` `null` or `{ status: 'none', … }` and `passkeyCredentialId` null. Store throw is unhandled.
- **Used by:** `meRoutes`, `authRoutes`, and `fundingRoutes` (POST /apply).

## Function: membersRoutes

- **Purpose:** Hono sub-app for `GET /members/:accountId`, `GET /members/:accountId/activity`, `GET /members/:accountId/posts`, and `GET /members/:accountId/replies`. Bearer + `requireAction(forum.read)` on all; UUID path. Profile card is live identity plus optional `profileMessage` via `serializeMessage`, derived `aboutMe`, `aboutMeHasPhoto` (true when the live profile note has a stored photo; false when `profileMessage` is null), uncapped live `postCount` / `replyCount` from `countByAccount`, and `trust` via `accountTrust`, and `fundingReviewedAt` (`grant.admittedAt` when effective admitted, else `null`) and `fundingReviewedByName` (the reviewer's display name, or `null` when that name is missing). Activity is given/received sats for that member (`buildAccountActivity`). Posts is live-only top-level notes newest-first (cap 200, same serialize as signed-in `GET /messages` including `accountId` / `replyCount` / `payable`, optional `goalSats` omitted when unset, `goalRepayable: true` only when stored true (omitted when null, never false) and `goalTermDays` only when stored (omitted when null), `goalCurrency` / `goalAmount` / the four `goalAmount*` snapshots only when `goalCurrency` is stored (omitted on a legacy row; a snapshot may be null), and optional `place` omitted when unset; omits `parentId`; missing-file `hasVideo` direct replies are deleted and subtracted from `replyCount`). Replies is live-only member replies newest-first (cap 200, `payable` when a non-empty `eventId` and a non-blank Lightning Address are set, optional `parentId`, no `replyCount`; replies never include `goalSats`, `goalRepayable`, or `goalTermDays`; a child that cannot serialize is omitted, siblings still 200).
- **Inputs:** `MembersRouteDeps` (`authStore`, `messageStore`, required `trustStore`, optional `fundingStore` default empty `InMemoryFundingStore`, `now`, optional `giftStore`, `rates`, and `fiatRates` used by `GET /:accountId/activity`; missing fiat never 503).
- **Returns / side effects:** Hono app mounted at `/members`. Activity is 200 JSON or 503 `{ error: 'Gift stats are unavailable' }` on store throw or missing BTC-USD. Missing fiat never 503. Logs `members.get.failed`, `members.posts.failed`, `members.replies.failed`, or `account.activity.failed` on 503. Activity 503 logs `account.activity.failed` / `account.activity.fx_incomplete`. GET JSON includes `aboutMe` and `aboutMeHasPhoto`.
- **Used by:** `createApp`.

## Function: serializeViewProfile

- **Purpose:** Public profile card for the capability URL. Ten fields (`name`, `username`, `location`, `lightningAddress`, `lightningAddressVerified`, `createdAt`, `hasPasskey`, `aboutMe`, `aboutMeHasPhoto`, `aboutMessageId`). `aboutMessageId` is the live profile-note id only when `aboutMe !== null`, else `null` (never `profileMessageId` under another name). Omits `id`, `linkingKey`, `role`, and `viewKey`. `username` is `string | null` (LUD-16 / NIP-05 local-part). `location` is `string | null` (never omitted, never `""`).
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
- **Used by:** Tests, `debugNostrFieldsFromListRow`, and `serializeDebugPasskey`.

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

- **Purpose:** Unsigned kind:1 for a forum line (top-level or NIP-10 reply). Optional media (`Kind1Photo`: image or video MIME) appends the public URL to content and a NIP-92 `imeta` tag (`url`, `m`, optional `dim`, optional `size`, optional `image` from `posterUrl`). Always ensures Damus-visible `#bitcoin` / `#21gifts` via `kind1ContentWithHashtags`, appending only missing tokens (forum row `text` is not modified). Optional fifth `location?: string | null`: when `locationHashtagName` is non-null, extra content token and `t` tag. Optional sixth `extraPhotos?: readonly Kind1Photo[]`: empty/omitted extras are bit-identical to the five-arg form; non-empty extras append extra URL lines after the first photo URL plus one `imeta` per extra (`url`, `m`, optional dim/size; no poster). Profile notes are skipped by the worker, not this function. When `replyTo` is set, adds NIP-10 `e` (root + reply) and `p` tags after the frozen tags (and optional `imeta`); top-level notes never get `e`/`p`/`q`. Each `imeta` may also include `x` (64 lowercase hex hash) and `duration` (integer seconds from 1 to 86400).
- **Inputs:** content, unix created_at, optional `{ url, mime, posterUrl?, dim?, size?, hash?, durationSeconds? }` (`Kind1Photo`), optional `replyTo?: Kind1ReplyTo` (`noteEventId`, `spaceRelay`, `noteAuthorPubkey`), optional fifth `location?: string | null`, optional sixth `extraPhotos?: readonly Kind1Photo[]`.
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

## Function: replyHintRelay

- **Purpose:** NIP-10 `e`-tag relay hint. The first public write relay when public publish is on and that list is non-empty; otherwise the durability (space) relay.
- **Inputs:** resolved write set (`publicEnabled`, `publicUrls`, `spaceUrl`).
- **Returns / side effects:** One relay URL. No I/O.
- **Used by:** Worker `signBatch` (`Kind1ReplyTo.spaceRelay`).

## Function: readRelaysFromKind10002

- **Purpose:** Read relays from one kind:10002 tag list. Keeps `r` whose marker is omitted or `read`, skips `write` and any other marker, requires `wss://` after trim, dedupes, and caps at `max` (default four). The worker asks for 32 so relays it already writes do not crowd out an inbox URL; the inbox fan-out still stops at 16.
- **Inputs:** event tags; optional `max`.
- **Returns / side effects:** Up to `max` unique `wss://` URLs. No I/O.
- **Used by:** Worker reply inbox fan-out.

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
- **Used by:** `PostRateLimiter`; funding-grant `effectiveStatus` / `eligibleToday` / trial writes.

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

- **Purpose:** Runs one worker pass in mode `'all'` (default), `'fast'`, or `'ingest'`. Mode `'all'` keeps today's full sequence: full `indexOpenZapReceipts`, resign/sign/publish when enabled, inbound replies, inbound DMs, then `backfillProfileMessages`. Mode `'fast'` starts with hot zap ingest (recent in-app invoice e-tags only; see `indexOpenZapReceipts` hot mode), then the same resign/sign/publish/`backfillProfileMessages` path, without full zap enumeration, inbound replies, or inbound DMs. Mode `'fast'` selects hot targets via `listRecentOkInvoiceAttempts(now − HOT_ZAP_WINDOW_MS (1 h), HOT_ZAP_INVOICE_LIMIT (50))`, takes the first `e` tag of each returned zap request, deduplicates them keeping first-seen order, queries relays with `since` = the oldest contributing attempt's `createdAt` minus `HOT_ZAP_SINCE_SLACK_S` (600 s), and makes no relay query when there is no target (i.e. no attempt yields an `e` tag). Mode `'ingest'` runs full `indexOpenZapReceipts` (including `retryGiftReplies`), then inbound kind:1 replies and kind:4/1059 DMs, with no sign, publish, or profile backfill. On `'all'` / `'fast'`, zap work runs before resign/sign/publish so receipt indexing is not delayed by relay publish timeouts; `nowMs` for sign/publish leases is sampled only after that zap work returns, so an overlapping fast tick cannot reclaim with a later clock while this tick still signs/publishes under a stale lease time. Full ingest queries zap relays (space plus the public list, even when `NOSTR_PUBLISH_PUBLIC` is off) for kind:9735 and indexes validated forum receipts onto `sats`, even when `NOSTR_PUBLISH` is off. Then `'all'` / `'fast'` signs unsigned rows and fans out when `NOSTR_PUBLISH=1`. Space-only ACK is terminal `published`/`space`. With `NOSTR_PUBLISH_PUBLIC=1`, space-only parks `pending` until a public ACK. Pending kind:1 JSON without `t=bitcoin` is dropped and re-signed, then unsigned rows are signed. After that, published unpaid notes missing a photo URL, a video URL, or Damus `#bitcoin`/`#21gifts` (and, when `account.location` is set, the location hashtag) in content are reset for the next tick (`PUBLIC_BASE_URL` set for media URLs; video posters are not treated as missing photos; `profileMessageId` rows are skipped so a name note is not rewritten with those hashtags; location is never applied to profile notes). Pending rows EVENT as-is so a reset cannot renew the 60s sign lease. Zapped rows keep `eventId`. An empty API base skips photo/video-URL resign. Sign looks up photo bytes even when `hasPhoto` is stale. Modes `'all'` / `'fast'` run `backfillProfileMessages` for named accounts with a non-blank Lightning Address missing a profile note. When publishing, also fans out kind:0 profiles (`name` / `display_name` / `picture` / optional `nip05`, `about` from the profile-note text or `21.gifts`) and NIP-65 kind:10002 relay lists. Kind:1 photo/video posts include the public media URL and `imeta`. Extra `imeta` only on the still branch via `listExtraPhotos` mapped with `forumExtraPhotoUrl(..., i+1, mime)` as the 6th `buildKind1Event` arg; video stays exclusive (poster = photo 0, no extras). Modes `'all'` / `'fast'` also run `signConversationBatch` (NIP-17 wraps when a conversation store is present) and, when `NOSTR_PUBLISH=1`, `publishConversationBatch`. Zap ingest (`indexOpenZapReceipts`) calls `notifyZap` after a newly indexed **member-note** forum receipt (not the official platform profile note). It inserts a payer gift-reply after parent `sats` only when the paid row is a top-level member note (`parentId` null) that is not the official platform profile note. A member/invoice zap (`payerAccountId`) on that platform note is a compose fee (payer post/reply, `sats` 0) that skips `notifyZap` and fans out `notifyForumPost` / `notifyForumReply` plus a top-level `spendPing` only when `eligibleToday` (same gate as `POST /messages`; ineligible logs `spend.ping.skipped` / `not_eligible`). An external zap (`payerPubkey`) on that same note still inserts `insertExternalGiftReply` (gift-reply under the profile note, paid sats, no `notifyForumPost`). A zap on a signed reply credits that reply; no nested gift-reply. A member-note gift-reply does not call `notifyForumReply`. PN / conversation-invoice receipts hit `appendConversationGift` without addSats, without a forum gift-reply, and without `notifyZap`. Modes `'all'` / `'ingest'` run `indexInboundForumReplies` (REQ kind:1 `#e` our published note ids, even when publish is off; persists replies through either a member-account pubkey match or an external-zapper entitlement whose pubkey is not blocked and whose `ExternalIngestLimiter` acquisition succeeds; inbound authors satisfying neither path are skipped; after a member reply is stored, `notifyForumReply` always runs with `auth` (in-app every account except the actor (no-op when the actor is the official platform account), then filtered by each account's `notificationLevel`; Web Push only to bell subscribers, same filter); failures log `nostr.reply.notify.failed` and do not undo persist) and `indexInboundDirectMessages` (REQ kind:1059 / kind:4 to member and platform pubkeys when a conversation store is present). Fast-lane ticks are not serialised; the ingest lane waits for each pass to settle before scheduling the next. When public publish is on and the space ACK succeeded, kind:1 is also fan-out best-effort to the search relay and reply inbox relays, and a successful kind:0 or kind:10002 is also sent to the indexer; a NACK from that fan-out does not change publish state.
- **Inbound forum replies:** After basic kind/id/pubkey checks, the pubkey is classified as a member or as an entitled, unblocked external zapper before kind:1 signature verification and before any event-specific message-store read; failures at that gate are silent. External event ids are held in a per-store in-flight set while an accepted event is processed, so overlapping ticks do not concurrently persist the same reply. The event time is clamped with `Math.min(eventMs, nowMs)`, retaining the existing `nowMs` fallback when `created_at` is missing or non-numeric. For external replies, the verified kind:0 display name is resolved first, then `isPubkeyBlocked` rechecks the kill switch inside the in-flight `try` and before the limiter is acquired immediately ahead of `messages.create`; a concurrent block writes nothing, consumes no budget, and still releases the in-flight id in `finally`. A rejected acquisition also writes nothing, and a failed create releases that acquisition. A stored external reply calls `notifyExternalForumReply` only when `created_at` is numeric, no more than ten minutes in the future, and no more than one hour old; missing/non-numeric, farther-future, and older replies remain stored without notification. That helper targets only the parent member author and uses the generic actor name `Someone`. Member replies keep the existing `notifyForumReply` fan-out.
- **Zap ingest dedupe:** One `nostr_zap_ingest` row is written per receipt per decision change per process (the memory is per store instance and empty after a restart, so the first ingest pass after boot may write one `rejected`/`duplicate` row per receipt that pass still queries (`listLatest` plus non-null `listReplies` children of those rows, unioned with the official platform profile note's `eventId` even after it ages out of `listLatest`)). A repeated identical `outcome:reason` is normally not written again, because the memory is consulted before the write; that is not a guarantee, since the memory is set only after the write resolves, fast-lane ticks are not serialised, and a failed write leaves it untouched. Receipts whose remembered decision is terminal (`indexed` or `rejected`/`duplicate`) skip note lookup, account/LNURL/amount validation, and ingest persist. They still run `verifyReceipt` before `tryEnsureGiftReply` (see `indexOpenZapReceipts` Terminal skip).
- **Kind:0 cache:** Unchanged content is not resent for the life of the AuthStore instance. After the live account row is read, the worker stores a reservation object and treats only that object as owner after each await. A nack or throw deletes the reservation only when it is still that object; the last issued `created_at` watermark is kept so a retry in the same second still increments. Kind:0 `created_at` is `max(wall clock, last issued + 1)` so an in-flight older profile cannot win a same-second replaceable-event tie.
- **Kind:0 batch:** At most `WORKER_BATCH` keyed attempts run per tick, including nacks. With public fan-out on, a space-only ACK is a nack and the profile is retried.
- **Inputs:** worker deps; optional `mode` (`'all'` \| `'fast'` \| `'ingest'`, default `'all'`).
- **Returns / side effects:** Store updates; logs `nostr.sign.failed` / `nostr.publish.*` / `nostr.profile.ok` / `nostr.profile.nack` / `nostr.relays.ok` / `nostr.relays.nack` / `nostr.dm.sign.failed` / `nostr.dm.publish.*` / `nostr.dm.push.failed` / `nostr.reply.notify.failed`. Event-id collision retries once with `created_at + 1`.
- **Used by:** `startNostrWorker`.

## Function: startNostrWorker

- **Purpose:** Two-lane handle around `runNostrWorkerTick`. The fast lane uses `setInterval(intervalMs)` (default `WORKER_INTERVAL_MS` = 2 s) to run mode `'fast'` with no in-flight guard — overlapping ticks stay safe via sign/publish leases, and a guard would couple unpaid latency to 5 s publish timeouts. A rejecting fast tick logs `nostr.worker.tick.failed`. The ingest lane starts one mode `'ingest'` pass immediately on call (before the handle returns); when that pass settles (success or failure) and the handle was not stopped, it schedules the next with `setTimeout(ingestIntervalMs)` (default `WORKER_INGEST_INTERVAL_MS` = 30 s). At most one ingest pass is ever in flight. A rejecting ingest pass logs `nostr.worker.ingest.failed` and still reschedules. `stop()` clears the fast interval, clears a pending ingest timeout, and marks the handle stopped so an in-flight ingest pass that settles later does not schedule another one.
- **Inputs:** deps; optional `intervalMs` (fast lane); optional `ingestIntervalMs` (pause after an ingest pass settles).
- **Returns / side effects:** `{ stop }`; schedules both lanes; may log `nostr.worker.tick.failed` / `nostr.worker.ingest.failed`.
- **Used by:** Process entry `src/index.ts` when KEK + message store present (passes `WORKER_INTERVAL_MS` as `intervalMs`; ingest default applies).

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

- **Purpose:** Settle a successful forum invoice by payment hash after its LNURL provider failed to publish a kind:9735 receipt. The required trimmed `note` (1–8000 characters, no C0/DEL controls) is durable operator evidence. `DEBUG_TOKEN` is the route authority; an optional preimage adds cryptographic evidence only when it is 32-byte hex and hashes to the payment hash. It is intentionally optional because some wallet-internal payments expose a wallet “preimage” that does not match the invoice hash.
- **Checks:** Normalises the payment hash, validates the note and optional preimage, requires an `ok` invoice with positive whole sats and non-empty BOLT11, rejects conversation invoices and missing/hidden messages, loads the note author (`auth.getAccount(message.accountId)`) **before** claiming, checks historical indexed ingests, and claims the lowercase payment hash through `claimZapPayment`. A thrown author lookup propagates (no claim, no receipt, no ingest). A claim owned by another receipt is `duplicate`.
- **Returns / side effects:** On a fresh success returns `{ ok: true, receiptId, messageId, amountSats, resumed: false }`, credits via `recordZapReceipt`, and writes an indexed synthetic 9735 ingest directly through `store.recordZapIngest`. If the synthetic receipt was already credited but its indexed ingest is missing, the current request's note/preimage rebuilds that ingest without another credit, notification and gift-reply processing run, and the result has `resumed: true`. An already complete settle returns `duplicate`.
- **Durability / errors:** The payment-hash claim is a durable tombstone that protects against a second credit even if a prior ingest write failed or the forum message was later deleted. Claim, lookup, credit, and direct ingest-write failures propagate (the route maps them to 503); the decision memory is updated only after the ingest write succeeds. The claim and credit are not one transaction, but the payment-hash primary key serialises competing receipt ids.
- **Post-credit effects:** On a member note, fans out `notifyZap` and attempts the payer gift-reply from the original zap request. On the platform profile note, skips `notifyZap` and treats the zap comment as a compose post/reply (`sats` 0) gated by `forum.post` and optional `postLimiter`; a created top-level post fans out `notifyForumPost` and `spendPing` only when `eligibleToday` (same gate as `POST /messages`; ineligible logs `spend.ping.skipped` / `not_eligible`), a reply fans out `notifyForumReply`. Missing `forum.post` fields or a limiter denial dequeue the receipt without creating a row. A throwing **payer** `auth.getAccount` after credit is logged as `nostr.zap.gift_reply.failed`, omits payer fields from the notification, skips the gift-reply, and still returns success. A throwing **note-author** `auth.getAccount` happens before claim and fails the settle. Notification, spend-ping, and gift-reply failures are likewise logged and suppressed. Logs and responses never contain the note or preimage.
- **Resume on a hidden note:** A fresh settle refuses a missing or hidden note. A retry that finds its synthetic receipt already credited is a resume: it completes the missing `indexed` ingest row even when staff hid the note in the meantime, and in that case skips `notifyZap` and the gift-reply.
- **Used by:** `POST /debug/invoices/settle` after `DEBUG_TOKEN` authentication.

## Function: indexZapReceipt

- **Purpose:** Validate provider pubkey (case-insensitive hex) and add sats once per receipt id. Callers verify the Nostr signature first. Persists a `nostr_zap_ingest` row (`indexed`, or `rejected` with reason `pubkey` / `amount` / `duplicate`); store throw logs `nostr.zap.ingest.record_failed` and does not change the boolean result.
- **Ingest dedupe:** One `nostr_zap_ingest` row is written per receipt per decision change per process (memory is per store instance and empty after a restart, so the first ingest pass after boot may write one `rejected`/`duplicate` row per receipt that pass still queries (`listLatest` plus non-null `listReplies` children of those rows, unioned with the official platform profile note's `eventId` even after it ages out of `listLatest`)). A repeated identical `outcome:reason` is normally not written again, because the memory is consulted before the write; that is not a guarantee, since the memory is set only after the write resolves, fast-lane ticks are not serialised, and a failed write leaves it untouched. Receipts whose remembered decision is already terminal never reach this function: `indexOpenZapReceipts` skips note lookup, account/LNURL validation, and ingest persist, but still runs `verifyReceipt` then `tryEnsureGiftReply`.
- **Inputs:** store, messageId, receipt, providerPubkey, amountSats; optional receiptEvent / noteEventId for debug rows.
- **Returns / side effects:** boolean; logs indexed/rejected; records ingest.
- **Used by:** `indexOpenZapReceipts` (worker tick).

## Function: indexOpenZapReceipts

- **Purpose:** On the full (non-hot) pass — used by mode `'all'` and the ingest lane — query zap relays for kind:9735 on recent notes (chunks of 20 event ids from `listLatest` plus non-null `listReplies` children of those rows) unioned with the official platform profile note's `eventId` (via `auth.listAccounts` `isPlatform` + `profileMessageId`, even after that row ages out of `listLatest`) and with e-tags from `listOpenConversationZapEventIds` (ok invoices with a conversation id and a conversation message id). When `conversations` is set, skip each open-conversation pair whose `getMessageById(conversationMessageId)` hits, then add the remaining distinct e-tags, so a second unpaid gift that shares an e-tag is still queried. This query-side skip applies only when that e-tag is not already in the forum list from `listLatest`: a PN e-tag is the recipient's profile note, itself a top-level forum note, so while that note is among the latest notes the e-tag stays in the relay query through the forum list, and `listOpenConversationZapEventIds` supplies it otherwise. Optional `since` (Unix seconds), when provided, is added to every kind:9735 receipt filter; the key stays absent when undefined so existing filter assertions stay exact. Then verify the Nostr signature, validate provider pubkey via LNURL (module TTL cache, lowercased), bolt11 amount, e-tag, and index via `indexZapReceipt` unless the payment hash matches a conversation invoice. Before provider lookup, a forum payment hash already represented by `manualReceiptIdForPaymentHash` is persisted as `rejected`/`settled`, so a late real receipt cannot add sats twice. A conversation invoice appends the predetermined `conversation_message` row (gift-only `nostrPublishState` `skipped`) and does not `addSats`, insert a forum gift-reply, or `notifyZap`. After address/provider/pubkey checks and before `claimZapPayment`, an existing PN gift is persisted `indexed` without claim/append/`nostr.zap.rejected`. Without `conversations`, that receipt is `rejected`/`conversation`. A thrown payment-hash lookup is treated as not a PN invoice so forum ingest still runs. Persists an ingest decision (`indexed` / `rejected` with reason) when it differs from the last remembered decision for that receipt on this store instance; that skip is not a guarantee, because the memory is set only after the write resolves, fast-lane ticks are not serialised, and a failed write leaves it untouched. One throwing receipt does not skip the rest of the pass. A newly indexed **member-note** forum receipt calls `notifyZap` with `auth` (in-app every account except the payer (no-op when the payer is the official platform account), then filtered by each account's `notificationLevel`; Web Push only to bell subscribers, same filter; `push.enqueue.failed` on throw, ingest continues). After parent `sats` are committed, ingest inserts a payer gift-reply (invoice `payment_hash`/`pr` first, else verified 9734 pubkey) only when the paid message is a top-level member note (`parentId` null) that is not the official platform profile note. A member/invoice zap (`payerAccountId`) on that platform note is a compose fee (payer post/reply, `sats` 0) gated by `forum.post` and optional `postLimiter`; it skips `notifyZap` and fans out `notifyForumPost` / `notifyForumReply` plus a top-level `spendPing` only when `eligibleToday` (same gate as `POST /messages`; ineligible logs `spend.ping.skipped` / `not_eligible`). An external zap (`payerPubkey`) on that same note still inserts `insertExternalGiftReply` (gift-reply under the profile note, paid sats, no `notifyForumPost`). A zap on a signed reply credits that reply via `addSats` and does not create a nested gift-reply. Ingest sets that receipt's `payerAccountId` to null so it never occupies `listZapReceiptsAwaitingGiftReply`, even before retry; retry still drops any already-queued reply receipts. A member-note gift-reply insert does not call `notifyForumReply`. An invoice match whose payer account is missing does not fall through to 9734. Gift-only replies are `nostrPublishState` `skipped`. Gift-reply `id` is deterministic per receipt. Lookup/create failures log `nostr.zap.gift_reply.failed` and do not persist ingest `rejected`. Receipts with a payer and no `gift_reply_id` are retried on each full pass using the stored comment; deleted parents, missing payers, and paid messages that are themselves replies are dropped from that queue.
- **Hot mode:** When `eventIds` is set, skip the whole note/conversation enumeration (`listLatest`, `listAccounts` platform profile note, `listOpenConversationZapEventIds`, `listReplies`). Deduplicate the given ids, dropping empty strings and keeping first-seen order. Empty `urls` or no remaining ids return immediately. Otherwise query in chunks of 20 with the same kind:9735 filter plus optional `since`, run the same per-receipt ingest and catch/persist path, and **do not** call `retryGiftReplies` (the worker ingest lane does that on the full pass).
- **Payer resolution:** `resolveZapPayer` returns `{ kind: 'account', payer, text }`, `{ kind: 'external', pubkey, requestId, text }`, or `undefined`. It prefers an ok invoice matched by payment hash and then BOLT11, and a matched invoice with a missing account does not fall through. A signed embedded request that maps to an account stays on the account path; only an unowned request passing `verifiedExternalZapRequest`'s signature, exact description-hash, target-event, and optional amount checks enters the external path.
- **External attribution:** The first verified external zap of at least one sat for a pubkey in this process calls `recordZapper`; a per-store lowercase-pubkey memo skips that durable write on later zaps while still running `attributeZapReceipt` and the remaining gift flow. Attribution happens before the block check, so entitlement and attribution are retained even when the payer is blocked. A blocked payer is durably dequeued by clearing `payerPubkey` while retaining `zapRequestId`, and the helper returns `{ attributed: true, gift: false }`; sats stay credited, no row is shown, and a later unblock does not resurrect the zap. This successful-attribution return keeps `backfillExternalZappers` paging past the row. Attribution returns `true` for a retry of the same request id on the same receipt, but `false` for a different request id on an already-attributed receipt, for the same request id already attached to another receipt, or for a missing receipt; only a successful, unblocked attribution can create the deterministic external gift-reply.
- **Terminal external outcomes:** Replayed request ids and credited receipts below the external minimum enter a process-local `WeakMap<MessageStore, Set<string>>` receipt-id memo. `tryEnsureGiftReply` checks it before the receipt lookup, invoice decode, or embedded kind:9734 verification, so later ticks make no repeated store write (including `recordZapper`). Each store's insertion-ordered set evicts its oldest id above 10,000; the memo is empty after restart. Blocked receipts instead use their durable `payerPubkey: null` plus non-null `zapRequestId` terminal guard.
- **Gift-reply retries:** `listZapReceiptsAwaitingGiftReply` retries both account (`payerAccountId`) and external (`payerPubkey`) receipts with no `giftReplyId`; missing/hidden/reply parents and missing or blocked payers are dequeued by clearing the applicable payer field. Separately, Postgres boot pages indexed-but-unattributed receipts from `listUnattributedIndexedReceipts` into `backfillExternalZappers`, up to 10,000 rows per boot; strict verified external requests are attributed and retried there, while account-owned requests remain on the member path. For an external payer, `insertExternalGiftReply` re-checks `isPubkeyBlocked` immediately before `store.create` — after `listAccounts()` and the profile-name lookup — on the live path, the retry queue and the boot backfill; a block added in that window dequeues the receipt (`payerPubkey: null`) without a row while the sats stay credited.
- **Payment-hash claim:** Before a validated forum or conversation receipt is credited, the tick claims its bolt11 payment hash with `claimZapPayment`. A conversation receipt whose PN gift row already exists is instead persisted as `indexed` before the claim, so a second receipt event for that PN payment is `indexed`, not `rejected` / `settled`. Otherwise, a hash already owned by another receipt id (a second receipt event for the same payment, or an operator settle) is persisted as `rejected` / `settled` and adds no sats, no gift-reply and no notification. A forum receipt claims only after the provider-pubkey check, so a foreign receipt cannot block the provider's real one. The same receipt id may re-claim its hash, which lets a tick that failed after the claim continue.
- **Terminal skip:** Remembered `indexed` and `rejected`/`duplicate` skip note lookup, account/LNURL validation, and ingest persist. This is the branch that still runs `verifyReceipt` (default `verifyEvent`), excludes a matching conversation invoice, and calls `tryEnsureGiftReply`. There, blocked receipts stop on the durable cleared-payer guard, while replayed and below-minimum external receipts stop on the bounded process-local memo before their embedded kind:9734 is re-verified. Other remembered decisions (for example `rejected`/`address` or `rejected`/`error`) keep the full path so a receipt can still transition later. `rejected`/`error` is not a terminal skip.
- **Inputs:** store, auth, querier, urls, timeoutMs, now, fetchImpl; optional `eventIds` / `since` (hot mode); optional `verifyReceipt` (default: nostr-tools `verifyEvent`); optional `pushStore`; optional `notificationStore`; optional `conversations` (PN append; omitted → conversation invoices `rejected`/`conversation`); optional `spendPing` (top-level platform compose, only when `eligibleToday`); optional `postLimiter` (platform compose); optional `fundingStore` (same `eligibleToday` gate as `POST /messages`; omitted → empty `InMemoryFundingStore`).
- **Returns / side effects:** void; logs `nostr.zap.rejected` / `indexed`; the per-receipt catch logs `nostr.zap.rejected` with `reason: 'error'` plus the `errorLogFields` allowlist (`name`: ASCII letters, `code` / `errno`: ASCII alphanumerics and underscore, each 1–40 characters) and never the message text; a failure outside that catch (store list, relay query) reaches `nostr.worker.tick.failed` or `nostr.worker.ingest.failed`, which log the same allowlist; records ingest rows; may append a conversation message, create a forum reply, and fan out `notifyZap` in-app on a **member-note** receipt to every account except skip (no-op when the payer is the official platform account), then filtered by each account's `notificationLevel` (Web Push to bell subscribers, same filter); a member/invoice platform-note compose fee skips `notifyZap` and fans out `notifyForumPost` / `notifyForumReply` plus a top-level `spendPing` only when `eligibleToday` (same gate as `POST /messages`; ineligible logs `spend.ping.skipped` / `not_eligible`); an external zap on that note stays `insertExternalGiftReply`; never logs full bolt11. Memory is per store instance and empty after a restart, so the first full ingest pass after boot may write one `rejected`/`duplicate` row per receipt that pass still queries (`listLatest` plus non-null `listReplies` children of those rows, unioned with the official platform profile note's `eventId` even after it ages out of `listLatest`).
- **Used by:** `runNostrWorkerTick` (modes `'all'`, `'fast'` hot path, and `'ingest'`).

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
- **Returns / side effects:** Column defaults including `sats: 0`, `goalSats: null`, `goalRepayable: null`, `goalTermDays: null`, `parentId: null`, `authorPubkey: null`, plus unsigned/pending Nostr columns (`eventId` / `nostrEvent` / `claimedUntil` / `nostrFirstAttemptAt` / `nostrPublishEpoch` null, `nostrPublishState: 'pending'`, `nostrAttempts: 0`).
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

## Function: readVideoTakenAt

- **Purpose:** Read the capture time already stored in an uploaded video file. Does not change the file.
- **Inputs:** Container bytes.
- **Returns / side effects:** `YYYY-MM-DDTHH:MM:SS+00:00` from an MP4/MOV `mvhd` creation time, or null when the file has none. No I/O.
- **Used by:** `decodeForumVideo`.

## Function: decodeForumVideo

- **Purpose:** Size + magic-byte check for MP4/WebM/MOV (32 MiB cap). MP4/MOV bytes are passed through `faststartIsoBmff` (`moov` before `mdat` only when remux succeeds; abort cases keep the original bytes) and then `normalizeIsoBmffDisplayMatrix`.
- **Inputs:** raw bytes.
- **Returns / side effects:** `{ contentType, bytes, takenAt }` or null. `takenAt` is `YYYY-MM-DDTHH:MM:SS+00:00` or null. Bytes stay as faststart and display-matrix repair left them.
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

- **Purpose:** Integer width/height from the first non-zero `tkhd` (16.16 fixed) under `moov`/`trak`. Playback seconds are `isoBmffDurationSeconds`, not this function.
- **Inputs:** ISO-BMFF bytes.
- **Returns / side effects:** `{ width, height }` or null.
- **Used by:** Worker kind:1 video `imeta` `dim`.

## Function: isoBmffDurationSeconds

- **Purpose:** Whole seconds from the first `mvhd` (version 0 or 1), found the same way as `readVideoTakenAt`. WebM and any buffer without a usable `mvhd` return null. The rounded quotient is returned only when it is an integer from 1 through 86400.
- **Inputs:** container bytes.
- **Returns / side effects:** Integer seconds, or null. Does not modify the buffer.
- **Used by:** Worker kind:1 video `imeta` `duration`.

## Function: listNip05Entries

- **Purpose:** Named accounts with pubkeys, oldest first, unique locals.
- **Inputs:** auth store.
- **Returns / side effects:** `Nip05Entry[]`.
- **Used by:** `buildNostrJson`.

## Function: normalizeIsoBmffDisplayMatrix

- **Purpose:** Put a 90°, 180°, or 270° picture back inside the video frame. Some phone files rotate the track and leave the translation at zero, so players draw every pixel outside the element and the picture stays black. An already-correct matrix, a non-video track, or a translation that does not fit in a signed 32-bit field is left untouched.
- **Inputs:** ISO-BMFF bytes. The buffer is not modified.
- **Returns / side effects:** A new copy with the `tkhd` translation and display size corrected, or the same `bytes` reference when nothing changes. No I/O.
- **Used by:** `decodeForumVideo`; `readForumVideoBytes`.

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

- **Purpose:** Read video bytes from disk, remux with `faststartIsoBmff`, correct a broken display matrix with `normalizeIsoBmffDisplayMatrix`, and rewrite the file when either change applies (heal-on-read, including clips stored before this repair). Heal writes a sibling temp file named with `crypto.randomUUID()` in the same directory as `path`, then `rename`s that temp onto `path`. After a change, purges the public API and site video URL when Cloudflare credentials and `PUBLIC_BASE_URL` are set. Missing credentials are a no-op. A purge failure is logged as `messages.video.purge_failed` and does not fail the read.
- **Inputs:** absolute path; optional `io` disk ops (tests); optional env; optional `fetch`.
- **Returns / side effects:** Bytes to serve. On write/rename failure the original file is left in place and the corrected buffer is still returned.
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

- **Purpose:** Hono `GET /nostr.json` (NIP-05, CORS `*`) and `GET /lnurlp/:username` (LUD-16 payRequest). Passes through the linked Wallet of Satoshi JSON so callback and metadata stay there. While an unexpired pending point-of-sale charge exists, both `minSendable` and `maxSendable` become that amount in millisats. `GET /lnurlp/:username` is `Cache-Control: no-store`; `GET /nostr.json` keeps `Cache-Control: public, max-age=60`.
- **Inputs:** auth store, env, optional fetchImpl (default `globalThis.fetch`), optional posStore (default empty in-memory store), optional now (default `Date.now`).
- **Returns / side effects:** Hono app mounted at `/.well-known`. LNURL-pay 404 when the username is invalid, unknown, or unlinked; 502 when WoS is unreachable or the store throws.
- **Used by:** `createApp`.

## Function: payRoutes

- **Purpose:** Hono sub-app for the public pay link: `GET /:username` (name, username, minSats, maxSats, and charge) and `POST /:username/invoice` (one BOLT11 via `requestGiftInvoice`; rejects any other amount while a charge is open). `charge` is `null`, or `{ amountSats, expiresAt }` when an unexpired pending point-of-sale charge exists; then both sat bounds are that amount. Mounted at `/pay`. No auth and no extra CORS headers.
- **Inputs:** `{ auth: AuthStore, fetchImpl: FetchFn, posStore: PosStore, now: () => number }`. All four are required; there is no default store and no default clock inside `payRoutes`. `createApp` passes the same `posStore` and `now` already used by `/.well-known` and `/pos`, and the shared LNURL-pay fetch as `fetchImpl`.
- **Returns / side effects:** Hono app. Logs `pay.unknown`, `pay.unreachable`, `pay.failed`, `pay.invoice_failed`, and `pay.invoice`. Never calls `username@21.gifts`.
- **Used by:** `createApp`.

## Function: writeForumVideo

- **Purpose:** Persist video bytes under `MEDIA_DIR` (caller should already faststart MP4/MOV via `decodeForumVideo`).
- **Inputs:** message id, video, env.
- **Returns / side effects:** mkdir, write UUID sibling temp, `rename` onto the public path so readers never see a partial file.
- **Used by:** `MessageStore.create`; `debugMessagesRoutes`.

## Function: roleRank

- **Purpose:** Integer rank of a live `AccountRole` from the rank map (`basis` = 0, `verified` = 1, `moderator` = 2, `initiator` = 2, `founder` = 3). `ROLE_ORDER` is the identity list, not the rank.
- **Inputs:** `role` (`AccountRole`).
- **Returns / side effects:** Integer 0–3. No I/O.
- **Used by:** `roleAtLeast`, `sameRoleRank`.

## Function: roleAtLeast

- **Purpose:** Whether a caller's live role meets a minimum, including equal rank. Initiator has the same rank as moderator; founder stays strictly above. True when `roleRank(role)` is ≥ `roleRank(min)`. Every permission names a minimum role; an equality test on the caller's role is a defect. Subject rank equality uses `sameRoleRank`, not this caller check.
- **Inputs:** `role` (caller's live `AccountRole`), `min` (minimum `AccountRole` that may proceed).
- **Returns / side effects:** boolean. No I/O.
- **Used by:** `isStaffRole`, `isStaffAccount`, `isChainAccount`, `conversationRoutes`, `messagesRoutes`, `trustRoutes` (`POST /trust/appoint-moderator`), `inboxUnreadCountFor`, `isModeratorGroupMember`.

## Function: sameRoleRank

- **Purpose:** Whether two live roles share a numeric rank. True when `roleRank(role)` equals `roleRank(other)`. The moderator rank matches initiator and does not match founder. Used for subject state on confirm and appoint so a stored role at that rank is left unchanged.
- **Inputs:** `role` and `other`, both `AccountRole`.
- **Returns / side effects:** boolean. No I/O.
- **Used by:** `trustRoutes` confirm and appoint, when deciding whether the subject is already at the moderator rank.

## Function: isModeratorGroupMember

- **Purpose:** Whether an account belongs to the closed Moderators group: at least a moderator on the role hierarchy and not the platform account. The platform account is a house identity, not a person in the staff room, whatever role it carries.
- **Inputs:** `{ role: AccountRole, isPlatform?: boolean }`.
- **Returns / side effects:** boolean (`isPlatform !== true && roleAtLeast(role, 'moderator')`). No I/O.
- **Used by:** `conversationRoutes` (`canAccess` on `moderator_group`, `GET /conversations/moderator-group`), `inboxUnreadCountFor` (group pin in the badge count), `notifyConversationMessage` (group push recipients).

## Function: isStaffRole

- **Purpose:** True when `account.role` may run staff trust routes. Delegates to `roleAtLeast(role, 'moderator')`. `basis` and `verified` return false. Used before `GET /trust/proposals`, `POST /trust/verify`, `POST /trust/propose-moderator`, `POST /trust/confirm-moderator`, and `POST /trust/reject-moderator` (appoint requires founder separately via `roleAtLeast(..., 'founder')`).
- **Inputs:** `AccountRole` (`basis` \| `verified` \| `moderator` \| `initiator` \| `founder`).
- **Returns / side effects:** boolean. No I/O.
- **Used by:** `trustRoutes`.

## Function: isChainAccount

- **Purpose:** True when `account.role` appears on the public Trust Chain. Delegates to `roleAtLeast(account.role, 'verified')`. `basis` is false.
- **Inputs:** `Account`.
- **Returns / side effects:** boolean. No I/O.
- **Used by:** `trustChainRoutes` (`GET /trust-chain?around=`).

## Function: isProjectedTrustEdge

- **Purpose:** Whether a stored edge appears on the public Trust Chain. True iff `edge` is the oldest eligible sibling among `subjectEdges` (`createdAt` then `id`). When `chainActorIds` is set, skip siblings whose actor is not in that set and take the oldest remaining eligible edge. Eligible: `verify`, `moderator_appoint`, and `moderator_propose` only when the live subject is a `moderator`. `moderator_confirm` and `moderator_reject` never. Later appoint, confirm, or propose do not replace an earlier eligible contact. At most one public incoming edge per subject, even when several rows share the winning kind.
- **Inputs:** `edge` (`TrustEdge`), `subject` (`Account | undefined`), `subjectEdges` (`readonly TrustEdge[]`, default `[edge]`), optional `chainActorIds` (`ReadonlySet<string>`) so a non-chain oldest sibling does not hide a later displayable contact.
- **Returns / side effects:** boolean. No I/O.
- **Used by:** `buildTrustChain`, `trustChainRoutes` (`GET /trust-chain?around=`).

## Function: buildTrustChain

- **Purpose:** Project live accounts and stored trust edges to the public graph. Nodes are accounts at least verified (never `basis`), sorted founder, then the moderator rank, then verified, then oldest `createdAt`, then `id`. Groups stored edges by `subjectId` and projects at most one incoming edge per subject: the oldest eligible sibling (`createdAt` then `id`), skipping a non-chain oldest sibling so a later displayable contact can show. Eligible: `verify`, `moderator_appoint`, and `moderator_propose` only when the live subject is a `moderator`. Never invents edges; `moderator_confirm` and `moderator_reject` are omitted; a pending propose (subject still `verified`) stays private; later appoint, confirm, or propose do not replace an earlier eligible contact; omits lightning addresses, view keys, and linking keys. A node with no stored incoming edge stays disconnected.
- **Inputs:** `accounts` (`readonly Account[]`), `edges` (`readonly TrustEdge[]`).
- **Returns / side effects:** `{ nodes, edges }` (`TrustChain`). No I/O.
- **Used by:** `trustChainRoutes` (`GET /trust-chain`).

## Function: accountTrust

- **Purpose:** Latest grant actors for one subject (`verifiedBy`, `proposedBy`, `confirmedBy`, `appointedBy`). When several edges share a kind, highest `createdAt` wins, then `id`. Actor names come from the live account map; a missing actor is `{ id, name: null }`. All four slots are `null` when the subject has no edges of that kind.
- **Inputs:** `subjectId`, `accounts` (name lookup), `edges` (any subjects; filtered to `subjectId`).
- **Returns / side effects:** `AccountTrust`. No I/O.
- **Used by:** `membersRoutes` (`GET /members/:accountId` always includes `trust`).

## Function: pendingModeratorProposals

- **Purpose:** Pure helper for the staff moderator-proposal queue. A row is pending when the latest `moderator_propose` / `moderator_reject` edge is `moderator_propose`, the live subject is `verified`, and that subject has no `moderator_confirm` and no `moderator_appoint`. A later reject closes the queue; a later propose re-opens it; confirm/appoint close forever. Missing subject accounts are omitted. Several propose/reject edges for one subject keep the latest by `createdAt` then `id` (same tie-break as `accountTrust`). `id` is that latest propose-edge id. `proposedBy` uses live actor names; a missing actor is `{ id, name: null }`. Sorted oldest `createdAt` first, then propose-edge `id` (FIFO). Never includes `basis` / `moderator` / `founder` subjects.
- **Inputs:** `accounts` (`readonly Account[]`), `edges` (`readonly TrustEdge[]`).
- **Returns / side effects:** `ModeratorProposal[]` (`id` plus epoch-ms `createdAt`; subject `role` is always `"verified"`). No I/O.
- **Used by:** `trustRoutes` (`GET /trust/proposals`, `POST /trust/propose-moderator`, `POST /trust/confirm-moderator`, `POST /trust/reject-moderator`).

## Function: serializeTrustEdge

- **Purpose:** JSON projection of a stored trust edge for operator GET/POST/DELETE `/debug/trust-edges` and dump table `trust_edge`. Emits `id`, `subjectId`, `actorId`, `kind`, and `createdAt` as ISO-8601. Does not include account role or extra columns.
- **Inputs:** `TrustEdge` (epoch-ms `createdAt`).
- **Returns / side effects:** `TrustEdgeJson`. No I/O.
- **Used by:** `debugTrustRoutes` (`GET`/`POST`/`DELETE` `/debug/trust-edges`) and dump table `trust_edge` (`loadDebugTables`).

## Function: migrateTrustSchema

- **Purpose:** Applies `TRUST_SCHEMA_SQL` in order (six statements: `CREATE TABLE IF NOT EXISTS trust_edge` with FKs to `account`, kind CHECK including `moderator_reject`, `subject_id <> actor_id`; `DROP CONSTRAINT IF EXISTS trust_edge_kind_check`; `ADD CONSTRAINT` kind check including `moderator_reject`; `DROP INDEX IF EXISTS trust_edge_subject_kind_uidx`; live unique index `trust_edge_subject_kind_live_uidx` on `(subject_id, kind) WHERE kind IN ('verify', 'moderator_confirm', 'moderator_appoint')`; actor index). Idempotent. Runs after auth/`account` exists and before `migrateDbChangeSchema` so `trg_db_change` attaches to `trust_edge`.
- **Inputs:** `SqlClient`.
- **Returns / side effects:** Void; idempotent DDL execute matching `docs/schema/trust_edge.sql` (comment header allowed in the `.sql` file only).
- **Used by:** `openBootStores` when SQL opens.

## Function: InMemoryTrustStore

- **Purpose:** Process-local `TrustStore` for who granted which staff status. Default empty so the process boots without a database. `createApp` uses this when boot leaves `trustStore` undefined (memory `DATABASE_URL`).
- **Inputs:** Optional seed `TrustEdge[]` (copied). `listEdges` / `listEdgesForSubject` / `listEdgesTouching` sort oldest `createdAt` then `id` ASC. `insertEdge` copies on write and throws `Error('duplicate trust edge')` only for live-unique kinds (`verify` / `moderator_confirm` / `moderator_appoint`); propose and reject may repeat. `deleteEdge(subjectId, kind)` removes the latest matching row (`createdAt` desc, then `id` desc) or returns `undefined`. `deleteEdgeById(id)` removes that row or returns `undefined`.
- **Returns / side effects:** Promise of edge copies; mutating results does not change the store. No I/O.
- **Used by:** `createApp` default `trustStore`.

## Function: PostgresTrustStore

- **Purpose:** Durable `TrustStore` over Postgres (`trust_edge` table). `listEdges` / `listEdgesForSubject` / `listEdgesTouching` are oldest-first; `insertEdge` binds columns without `ON CONFLICT` and maps unique violation `23505` to `Error('duplicate trust edge')` (live-unique kinds only at the index). `deleteEdge` selects the latest `(subject_id, kind)` (`ORDER BY created_at DESC, id DESC LIMIT 1`) then `DELETE FROM trust_edge WHERE id = $1 RETURNING …`; empty SELECT returns `undefined` with no delete. `deleteEdgeById` is `DELETE FROM trust_edge WHERE id = $1 RETURNING …`; empty RETURNING is `undefined`.
- **Inputs:** Constructor takes a shared boot `SqlClient` (already migrated). Maps `subject_id` / `actor_id` / `created_at` (Date or ISO string) onto `TrustEdge`.
- **Returns / side effects:** Parameter-bound SQL; copies on return. Non-unique errors propagate to the route (409/503).
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: trustChainRoutes

- **Purpose:** Hono sub-app for `GET /trust-chain`. Bearer session required (any role). Missing or invalid Bearer → 401 `{ error: 'Unauthorized' }`. Bare GET (no `around`, or empty) returns founder seeds (no edges). `?around=<id>` loads all edges for each subject in the touching set (`listEdgesForSubject`) then `isProjectedTrustEdge` with that sibling list and chain actor ids so a non-touching older eligible edge still wins over a touching newer one, and a non-chain oldest sibling does not hide a later displayable contact. One hop of the oldest eligible public edge (`createdAt` then `id`); pending-propose verified neighbors are not nodes; confirm and reject never. Empty arrays when none. Invalid uuid (Postgres `22P02`), unknown, or basis `around` → 404 after a valid session. Other store throw → 503 `{ error: 'Trust chain is unavailable' }` and log `trust.chain.failed`.
- **Inputs:** `TrustChainRouteDeps`: `authStore`, `trustStore`, `now`.
- **Returns / side effects:** Hono app mounted at `/trust-chain` (`GET /`).
- **Used by:** `createApp`.

## Function: trustRoutes

- **Purpose:** Hono sub-app for staff Bearer `GET /proposals` (pending via `pendingModeratorProposals`: latest propose/reject is propose, verified, no confirm/appoint; JSON includes propose-edge `id` plus ISO `createdAt`; empty list is 200; logs `trust.proposals.listed` `{ count }` only) and five POSTs: `/verify` (role `verified` + `verify` edge; idempotent when the caller already verified; a 200 that leaves the subject verified welcome-pings a live top-level photo or video, including About me), `/propose-moderator` (new propose after reject; 409 while currently pending, any confirm/appoint, or after insert this row is not the oldest open propose (the insert is deleted; remaining pending is then best-effort cleared and fan-out for that propose-edge id, failure stays 409); extras deleted when this insert is oldest; role unchanged; wrap `notifyModeratorProposed`; after notify, re-list and drop or refresh `moderator_proposal` rows when this insert is no longer pending; a refresh fan-out re-lists immediately before and after so a concurrent reject cannot leave stale rows; a pending-id change during that extra round clears `moderator_proposal` first so unique create cannot keep the previous actor, and a second pending-id change at that depth drops the rows), `/confirm-moderator` (independent second staff member vs the latest pending propose; after insert, undo 409 unless `pendingModeratorProposals` ignoring this confirm still has that propose-edge `id` and it is the oldest open propose; else role `moderator` + confirm edge), `/reject-moderator` (append-only `moderator_reject`; after insert, a concurrent confirm/appoint undoes the reject with 409; same pending propose-edge `id` after insert is also 409; a different pending id including same-actor same-ms re-propose keeps the reject; empty pending re-lists once more before dropping `moderator_proposal` rows and fans out if a re-list after that delete shows a new pending propose; role stays `verified`; proposer may reject), `/appoint-moderator` (founder only; role `moderator` + appoint edge). UUID check reuses `MESSAGE_ID_RE`. Logs `trust.verified` / `trust.moderator_proposed` / `trust.moderator_confirmed` / `trust.moderator_rejected` / `trust.moderator_appointed`. Propose/confirm/appoint delete `moderator_proposal` rows (`replyId === subject.id`). Reject deletes those rows only when pending is empty after insert; if a newer propose already reopened the queue, the reject stays in history and those rows stay. Propose then wraps `notifyModeratorProposed`; confirm/appoint then wrap `notifyModeratorAppointed`; reject does not notify for the reject itself. After every confirm/appoint 200 that leaves/keeps the subject as `moderator` (new grant and idempotent already-moderator same-actor 200), wraps `notifyModeratorAppointed` for the subject only.
- **Inputs:** `TrustRouteDeps`: `authStore`, `trustStore`, `now`, optional `notificationStore`, `pushStore`, and `conversationStore` (appointed and propose push `unreadCount` include listed inbox unread), optional `messages` and `spendPing` (after a 200 that leaves the subject `verified`, welcome-ping a live top-level photo or video, including About me; omitted skips; a ping failure still returns 200).
- **Returns / side effects:** Hono app mounted at `/trust`. 401/403/400/404/409/503 with the documented `{ error }` strings; GET `/proposals` 200 `{ proposals }` (empty list included); POST 200 `{ id, name, role }`.
- **Used by:** `createApp`.

## Function: fundingRoutes

- **Purpose:** Hono sub-app for member `POST /apply` and staff `GET /applications`, `GET /applications/:accountId`, `POST /trial`, `POST /admit`, and `POST /reject`. `basis` cannot apply (403). Apply requires a filled About me (real bio, not empty/name-only), an About me photo, and a non-empty location; missing fields are 400 `{ error: 'About me is required' }`, `{ error: 'About me photo is required' }`, `{ error: 'Location is required' }` in that order. Apply from effective none/rejected only. Staff list is effective pending (expired trials after `loadGrantEffective`). Trial from pending; admit from pending or trial; reject from pending or trial. Writes go through `FundingStore.transition` (apply `from` none/rejected; trial pending; admit/reject pending or trial); 0 matching rows is 409 so a concurrent decision cannot overwrite. Staff cannot target themselves (409). UUID check reuses `MESSAGE_ID_RE`. Logs `funding.applied` / `funding.trial` / `funding.admitted` / `funding.rejected` / `funding.applications.listed`. Store throw → 503 `{ error: 'Funding is unavailable' }`. After a 200 on `POST /trial`, when `spendPing` is configured, ping it once with the trimmed Lightning address and the newest live top-level photo or video (including About me) whose `createdAt` falls on today's UTC day. Two arguments, daily kind. A blank address, no such post, or a post from an earlier UTC day does not ping. A thrown lookup or ping logs `funding.daily_ping.failed` and the HTTP status stays 200. A 200 on `POST /admit` from effective pending uses that same daily ping. A 200 from an active trial does not ping.
- **Inputs:** `FundingRouteDeps`: `authStore`, `fundingStore`, `messageStore`, `now`, optional `spendPing`.
- **Returns / side effects:** Hono app mounted at `/funding`. 401/403/400/404/409/503 with the documented `{ error }` strings; apply 200 `{ funding }`; list 200 `{ applications }`; detail 200 `{ account, grant, messages }`; staff POSTs 200 `{ id, name, role, funding }`.
- **Used by:** `createApp`.

## Function: debugTrustRoutes

- **Purpose:** Operator list `GET /debug/trust-edges`, backfill `POST /debug/trust-edges`, and undo `DELETE /debug/trust-edges`. Same 503/401 `DEBUG_TOKEN` gate as other debug routes. GET returns `{ edges }` newest-first. POST body `{ subjectId, actorId, kind }` with kind `verify` / `moderator_propose` / `moderator_confirm` / `moderator_appoint` / `moderator_reject` inserts (409 duplicate only for live-unique kinds; propose/reject may repeat); DELETE body `{ subjectId, kind }` removes the latest `(subjectId, kind)` row (`createdAt` desc, then `id` desc). POST/DELETE return `serializeTrustEdge` (ISO `createdAt`) and do **not** change `account.role`. `PATCH /debug/accounts/:id` remains role-only.
- **Inputs:** `DebugTrustRouteDeps`: auth `store`, `trustStore`, optional `debugToken`, optional `now` (default `Date.now`; unused by DELETE).
- **Returns / side effects:** Hono app mounted at `/debug/trust-edges`. POST success logs `debug.trust_edges.inserted` `{ subjectId, actorId, kind }`. DELETE success logs `debug.trust_edges.deleted` `{ subjectId, kind }`. POST 400/404/409/503 as before. DELETE 400 bad body; 404 missing UUID or missing row; 503 on unexpected store throw (`debug.trust_edges.delete_failed`). GET 503 `{ error: 'Trust chain is unavailable' }` on unexpected `listEdges` throw (`debug.trust_edges.failed`).
- **Used by:** `createApp`; operator `gifts-debug trust-edges` / `gifts-debug trust-edge` / `gifts-debug trust-edge-delete`.

## Function: verifiedExternalZapRequest

Strictly attributes a zap receipt to the signer of its embedded NIP-57 request.

- **Input:** Receipt tags, the invoice description hash and amount, and the target note event id.
- **Verification:** Requires a valid signed kind 9734 whose exact JSON hash, `e` tag, and optional `amount` tag match the receipt and invoice.
- **Output:** Returns a lowercase pubkey, signed request id, and normalized comment, or `null` without partial attribution.

## Function: externalDisplayName

Creates a safe display-name snapshot for a visible external Nostr author.

- **Preference:** Uses the trimmed profile `display_name` or `name` supplied by the caller.
- **Protection:** Rejects control characters, explicit Unicode bidirectional controls (RLO/LRO/RLE/LRE/PDF/RLM/LRM/RLI/LRI/FSI/PDI/ALM), names containing a default-ignorable Unicode code point (checked on the name and its NFKD form), except the ZWNJ/ZWJ joiners and the emoji variation selectors U+FE00-U+FE0F, which stay allowed, names without any letter or digit, names mixing more than one of the Latin, Cyrillic and Greek scripts, names equal to a member name (case-insensitive after compatibility normalisation), and names that impersonate a member or reserved project/staff identity after diacritic and common Cyrillic/Greek look-alike folding or after a by-sound transliteration of Cyrillic (so the Russian spelling of a reserved word or of a member name is caught too). Look-alike-fold and transliteration comparisons with member names apply only when every candidate letter is ASCII or substituted by the respective mapping, so unmapped non-Latin letters cannot create a spurious member collision. Reserved-word substring matching still uses both folds unconditionally. Names written entirely in one non-Latin script remain eligible when none of these comparisons collides.
- **Fallback:** Uses a truncated pubkey display; accepted profile names are capped at the member-name limit.

## Function: resolveExternalProfileName

Looks up the newest kind 0 profile name without making ingest depend on relay availability.

- **Query:** Requests kind 0 events for one lowercase pubkey from the configured zap relay set.
- **Selection:** Discards events whose signature is invalid, whose author differs, or whose content exceeds 64 KiB; chooses the newest remaining event and prefers `display_name` over `name`.
- **Resilience:** Never throws; successful names are cached for one hour and misses or failures for five minutes. The cache stores only the already-trimmed name cut to the member name-length limit, never raw profile content; it is capped at 5,000 entries with oldest-first insertion-order eviction, and an expired entry is deleted when read.

## Function: ExternalIngestLimiter

Applies in-process sliding limits before an entitled external reply is persisted.

- **Per author:** Allows six replies per hour and twenty per UTC day for each external pubkey.
- **Global:** Allows thirty replies per hour and one hundred per UTC day across all external pubkeys.
- **Retry behavior:** A rejected acquisition stores nothing, so the relay event can be considered again on a later worker tick. When `messages.create` fails, release removes the specific per-author and global hourly acquisition whose timestamp equals the value passed to the successful `tryAcquire` call and restores its UTC-day budget. Releasing an older acquisition cannot disturb a newer one's bookkeeping; no matching acquisition is a no-op.

## Function: backfillExternalZappers

Rechecks stored indexed zap receipts that predate external-payer attribution.

- **Scope:** Reads newest-first 200-row pages with no account payer, external payer, request id, or gift reply until the page is short or 10,000 receipts have been scanned. A strict keyset cursor advances past every row the batch returned, using the last row's immutable ingest `createdAt` and receipt `eventId`, regardless of whether that row becomes attributed; changing result-set membership therefore cannot cause offset-style skips or repeats.
- **Safety:** Applies the same strict request verification, account exclusion, block, replay, and top-level-parent rules as live ingest.
- **Result:** Records durable zapper entitlement and eligible gift replies, logs aggregate counts, logs `nostr.zapper.backfill.ceiling` when the 10,000-row ceiling is reached, and remains safe to run on every boot.

## Function: notifyExternalForumReply

Targets an external Nostr reply notification only to the member who authored the parent note.

- **Audience:** Restricts both in-app and Web Push recipients to the parent account before notification-level filtering.
- **Identity:** Always uses the generic actor name `'Someone'`, never the external reply's stored or visitor-chosen display name, while keeping its pubkey out of notification payloads.
- **Timing:** The caller invokes it only for a numeric inbound `created_at` no more than ten minutes in the future and no more than one hour old; unknown-age, farther-future, and older replies remain stored without notification.
- **No-op:** Returns without writes when the parent has no account; caller-owned failures do not undo the persisted reply.

## Function: debugExternalRoutes

Builds the operator-only external-pubkey inspection route.

- **Authentication:** Requires a bearer equal to `DEBUG_TOKEN`; missing configuration returns 503 and a bad bearer returns 401.
- **Response:** Lists entitled zappers and blocked pubkeys newest first with receipt, block, staff, message, and timestamp metadata.
- **Bound:** Caps each list at the standard message debug limit and returns 503 when the store cannot be read.

## Function: effectiveStatus

- **Purpose:** Effective funding-grant status after lazy trial expiry. A stored `trial` whose `trialUtcDate` is a string strictly before today UTC (`utcDayKey`) becomes `'pending'`. Today's and future trial dates stay `'trial'`. A trial with `trialUtcDate === null` is not expired via the date comparison. Missing grant is `'none'`. Non-trial statuses return `grant.status`.
- **Inputs:** `grant` (`FundingGrant | undefined`) and `nowMs` epoch milliseconds.
- **Returns / side effects:** `EffectiveFundingStatus`. No I/O.
- **Used by:** `serializeOwnerFunding`, `fundingReviewedAt`, `loadGrantEffective`, `invoiceRoutes` `GET /eligible`.

## Function: fundingGrantRequired

- **Purpose:** Whether the funding-grant gate is in force on this UTC day. True on and after `FUNDING_REQUIRED_FROM_UTC` (`2026-09-30`).
- **Inputs:** `nowMs` epoch milliseconds.
- **Returns / side effects:** `boolean`. No I/O.
- **Used by:** `eligibleToday`.

## Function: eligibleToday

- **Purpose:** Whether the account may receive a spend ping / spend invoice today. `basis` is always false. Before UTC `2026-09-30` (`FUNDING_REQUIRED_FROM_UTC`), every other role is true (passkey and living-room post still gate issue). From that UTC day, true iff admitted, or a trial whose `trialUtcDate` equals today's UTC key. Expired, future, pending, rejected, and missing grants are then false.
- **Inputs:** `role` (`AccountRole`), `grant` (`FundingGrant | undefined`), `nowMs`.
- **Returns / side effects:** `boolean`. No I/O.
- **Used by:** `messagesRoutes` spend ping, `conversationRoutes` moderator ping, `invoiceRoutes` `GET /eligible` and `POST /`. Domain tests cover the matrix.

## Function: serializeOwnerFunding

- **Purpose:** Owner `funding` JSON for `GET /me` / passkey finish. `basis` is `null` (do not leak grants). Otherwise always an object; missing row is `'none'`. Trial date and admission fields follow the effective status.
- **Inputs:** `role`, observed `grant`, `nowMs`, live `reviewerName` (used only when admitted).
- **Returns / side effects:** `OwnerFundingJson | null`. No I/O.
- **Used by:** `serializeOwnerAccountWithPosts`, `fundingRoutes`.

## Function: fundingReviewedAt

- **Purpose:** Member-card admission stamp: `grant.admittedAt` when effective status is admitted, else `null`. Does not expose pending, trial, or rejected.
- **Inputs:** `grant` (`FundingGrant | undefined`), `nowMs`.
- **Returns / side effects:** Admission epoch ms, or `null`. No I/O.
- **Used by:** `membersRoutes` `GET /:accountId`.

## Function: fundingReviewedByName

- **Purpose:** Member-card reviewer name. The live display name of `decidedBy` when `fundingReviewedAt` is a number and the trimmed name is non-empty. Otherwise `null`. Does not expose pending, trial, or rejected.
- **Inputs:** `grant`, `nowMs`, and `lookup(accountId)`.
- **Returns / side effects:** Display name, or `null`. One account read when a decider id is set.
- **Used by:** `membersRoutes` `GET /:accountId`.

## Function: mentionUsernames

- **Purpose:** Unique `@username` tokens in forum text, first-seen order, normalised lowercase. A mark starts at `@` only when the previous character is not a username character. The longest run is kept only when `normalizeUsername` accepts it. `name@21.gifts` is not a mark.
- **Inputs:** Forum body text.
- **Returns / side effects:** `string[]`. No I/O.
- **Used by:** `persistForumPost`.

## Function: notifyForumMentions

- **Purpose:** One `forum_mention` notification per mentioned account except the author. Level `all` always, `active` only when `isActive`, `mentions` because the recipient is the mark. Push body uses that account's locale.
- **Inputs:** Author, created row (with `mentions`), top-level `parentId`, `isActive`, optional notification, push, and auth stores.
- **Returns / side effects:** Writes in-app rows and push outbox rows. No-op when every mark is the author.
- **Used by:** `persistForumPost`.

## Function: buildForumMentionPushPayload

- **Purpose:** Web Push payload for one `@username` mark. Body is `{name} marked you`, `{name} hat dich markiert`, `{name} te marcó`, or `Minarkahan ka ni {name}`. Tag `forum_mention:<messageId>`. URL `/notifications`.
- **Inputs:** `messageId`, author `name`, recipient `locale` (`de`, `es`, `fil`, or anything else including null for English).
- **Returns / side effects:** `PushPayload`. No I/O.
- **Used by:** `notifyForumMentions`.

## Function: expiredTrialAsPending

- **Purpose:** Pending projection of an expired trial. Keeps `appliedAt` and the last decision actor/time/note; sets `status: 'pending'`, `trialUtcDate: null`, `admittedAt: null`.
- **Inputs:** Stored trial grant (possibly expired).
- **Returns / side effects:** Pending `FundingGrant` to persist. No I/O.
- **Used by:** `loadGrantEffective`.

## Function: loadGrantEffective

- **Purpose:** Load one grant and lazily persist expired trials via compare-and-set. Missing row is `undefined` (no upsert). When `effectiveStatus` is `'pending'` and the stored status is still `'trial'`, rewrites pending only if the row is still `status='trial'` with the same expired `trialUtcDate` (InMemory re-read then upsert; Postgres `UPDATE … WHERE account_id AND status='trial' AND trial_utc_date RETURNING *`; 0 rows → `getByAccountId`). Today's and future trials are returned unchanged.
- **Inputs:** `FundingStore`, `accountId`, `nowMs`.
- **Returns / side effects:** Observed grant, or `undefined`. May write pending over an expired trial that still matches.
- **Used by:** `fundingRoutes`.

## Function: migrateFundingSchema

- **Purpose:** Applies `FUNDING_SCHEMA_SQL` in order (`CREATE TABLE IF NOT EXISTS funding_grant` with PK/FK to `account`, status CHECK, trial date, decision and admission timestamps). Idempotent. Runs after `migrateTrustSchema` and before `migrateDbChangeSchema` so `trg_db_change` attaches to `funding_grant`.
- **Inputs:** `SqlClient`.
- **Returns / side effects:** Void; idempotent DDL execute matching `docs/schema/funding_grant.sql` (comment header allowed in the `.sql` file only).
- **Used by:** `openBootStores` when SQL opens.

## Function: InMemoryFundingStore

- **Purpose:** Process-local `FundingStore` for funding-program grants. Default empty so the process boots without a database. `createApp` uses this when boot leaves `fundingStore` undefined (memory `DATABASE_URL`). `getByAccountId` / `listGrants` / `upsert` / `transition` / `expireTrialIfUnchanged` copy on read and write. `listGrants` sorts oldest `appliedAt` then `accountId` ASC. Second `upsert` for the same account replaces the row. `transition` writes only when the in-memory status is in `from` (`'none'` = no row); otherwise `undefined`. `expireTrialIfUnchanged` writes pending only when the map row is still `status='trial'` with the same `trialUtcDate` (no await between check and set).
- **Inputs:** Optional seed `FundingGrant[]` (copied into a private `Map` keyed by `accountId`).
- **Returns / side effects:** Promise of grant copies; mutating results or the seed does not change the store. No I/O.
- **Used by:** `createApp` default `fundingStore`.

## Function: postgresTextArrayLiteral

- **Purpose:** Encodes strings as one Postgres text-array literal (`{}` when empty; each value double-quoted; a backslash or double quote inside a value is escaped). Bun SQL does not encode a JavaScript array (`malformed array literal`).
- **Inputs:** `readonly string[]`.
- **Returns / side effects:** One text-array literal string. No I/O.
- **Used by:** `PostgresFundingStore.transition` and `PostgresMessageStore` (active feed staff ids, missing-hashtag unnest, exclude ids).

## Function: PostgresFundingStore

- **Purpose:** Durable `FundingStore` over Postgres (`funding_grant` table). `getByAccountId` binds `$1`. `listGrants` is `ORDER BY applied_at ASC, account_id ASC`. `upsert` is `INSERT … ON CONFLICT (account_id) DO UPDATE SET` every grant column. `transition` is `INSERT … ON CONFLICT DO UPDATE WHERE status = ANY($9::text[])` when `from` includes `'none'`, else `UPDATE … WHERE account_id=$1 AND status = ANY($9::text[]) RETURNING *` (0 rows → `undefined`). `expireTrialIfUnchanged` is `UPDATE … WHERE account_id=$1 AND status='trial' AND trial_utc_date=$2 RETURNING *` (0 rows → `getByAccountId`). Maps `timestamptz` (Date or ISO string) to epoch ms and `trial_utc_date` Date/string to `YYYY-MM-DD`; `null` stays `null`. `$9` is one `postgresTextArrayLiteral` string, not a JavaScript array.
- **Inputs:** Constructor takes a shared boot `SqlClient` (already migrated).
- **Returns / side effects:** Parameter-bound SQL; copies on return. Query and execute errors propagate.
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: linksRoutes

- **Purpose:** Public `GET /links/:code`. An 8-hex prefix maps to exactly one forum-message id or account id.
- **Inputs:** Path param `code` (lowercased, not trimmed). Collaborators `messages.listIdsByPrefix` and `accounts.listIdsByPrefix`.
- **Returns / side effects:** 400 `{ error: 'invalid_code' }` when `code` is not eight hex digits; 404 `{ error: 'not_found' }` when nothing matches; 409 `{ error: 'ambiguous' }` when two or more ids match (no ids in the body); 200 `{ kind: 'message' | 'member', id }` for exactly one match. No new log event. Soft-hidden messages are included.
- **Used by:** Website short-link redirect (`/l/<8 hex>` calls this). `createApp`.

## Function: canonicalGoalAmount

- **Purpose:** Turn a typed ask amount into the canonical stored string (trim, comma or dot, at most eight fractional digits, no exponent, no leading zeros, no trailing fractional zeros).
- **Inputs:** Raw `goalAmount` string from JSON or multipart.
- **Returns / side effects:** Canonical dot-decimal string, or `null` when the grammar fails. No I/O.
- **Used by:** `messagesRoutes` and `PostgresMessageStore` row mapping.

## Function: fiatToSats

- **Purpose:** Convert a fiat amount to whole sats with the gift-day proportion (`Math.round(amount * day.sats / dayFiat)`). Amount 0 is 0. A product that rounds to 0 becomes 1. Unusable day or quote returns null. Not the spot BigInt helper.
- **Inputs:** Finite amount, gift-day or null, and `USD` / `CHF` / `EUR` / `PHP`.
- **Returns / side effects:** Whole sats, or `null` when unusable. No I/O.
- **Used by:** `messagesRoutes` when freezing a fiat ask.

## Function: satsToFiatAmount

- **Purpose:** Convert whole sats to a two-decimal fiat string on the same gift-day proportion (`Math.round(dayFiat * 100 * sats / day.sats)`).
- **Inputs:** Sats, gift-day or null, and `USD` / `CHF` / `EUR` / `PHP`.
- **Returns / side effects:** Two-decimal string, or `null` when the day, quote, or negative sats are unusable. No I/O.
- **Used by:** `messagesRoutes` for the four frozen ask snapshots.

## Function: loadGiftStatsSnapshot

- **Purpose:** Build the same gift stats object as `GET /gifts/stats` for one row set. Legacy days (no stored USD) load BTC-USD then fiat crosses. A missing BTC-USD day is `fx-incomplete`. A fiat-book throw logs `gifts.stats.fiat_failed` and continues.
- **Inputs:** Outbound `GiftRow[]`, BTC-USD book, fiat book, and `nowMs`.
- **Returns / side effects:** `{ ok: true, stats }` or `{ ok: false, reason: 'fx-incomplete' }`. Logs `gifts.stats.fiat_failed` when fiat `ensureDays` throws.
- **Used by:** `giftsStatsRoutes`, `loadLatestGoalRateDay`.

## Function: loadLatestGoalRateDay

- **Purpose:** Latest gift-day proportion for a currency ask: last `spendOverTime` day with `sats > 0` from `loadGiftStatsSnapshot` (no recipient filter). Empty history is null. Does not invent a rate.
- **Inputs:** `{ store, rates, fiatRates, now }` — the same collaborators as `GET /gifts/stats`.
- **Returns / side effects:** `{ sats, usd, chf, eur, php }` or `null`. Throws `Error('fx.rate.missing')` when a legacy day has no BTC-USD rate.
- **Used by:** `bindGoalRateDay`.

## Function: bindGoalRateDay

- **Purpose:** Return the `goalRateDay` callback `createApp` passes to `messagesRoutes`.
- **Inputs:** `{ store, rates, fiatRates, now }` — the same collaborators as {@link loadLatestGoalRateDay}.
- **Returns / side effects:** A function that calls `loadLatestGoalRateDay` with those collaborators.
- **Used by:** `createApp`.
