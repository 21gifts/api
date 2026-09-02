# Functions

## Function: buildGiftDay

- **Purpose:** Pure list of outbound gifts that fall on one UTC calendar day, with BTC/USD at that day's close.
- **Inputs:** `day` (`YYYY-MM-DD`), `readonly GiftRow[]` (other days ignored), `ReadonlyMap` of UTC day → USD-per-BTC. Empty matching set needs no rates.
- **Returns / side effects:** `GiftDay` (`gifts` sorted by `paidAt` then `recipient`). Throws `Error('fx.rate.missing')` when a listed gift has no rate. No I/O.
- **Used by:** `giftsRoutes`.

## Function: buildGiftStats

- **Purpose:** Pure aggregation of outbound gifts into the public stats JSON (UTC daily series with gap days, months with gap months, recipients) including BTC strings and historical USD from per-gift day rates.
- **Inputs:** `readonly GiftRow[]` (`paidAt`, `amountSats`, `recipientWosUser`) and `ReadonlyMap<string, string>` of UTC day → USD-per-BTC. Empty rows need no rates.
- **Returns / side effects:** `GiftStats` with `totalBtc`, `totalUsd`, `fx`, and BTC/USD on series/buckets. Throws `Error('fx.rate.missing')` when a gift day has no rate. Gap days and gap months are zero sats/BTC/USD without a rate. No I/O.
- **Used by:** `giftsStatsRoutes`.

## Function: giftsForRecipient

- **Purpose:** Filter outbound gift rows to one Wallet of Satoshi handle (case-insensitive). Used by `GET /gifts/stats?recipient=` so stats reflect that handle's gifts only.
- **Inputs:** `readonly GiftRow[]` and `recipient` string. Trims `recipient`; when `indexOf('@') > 0` compares the local-part before `@`, otherwise the whole trimmed string. Empty after trim matches nothing — never "all gifts".
- **Returns / side effects:** Matching `GiftRow[]` in input order, or `[]`. No I/O.
- **Used by:** `giftsStatsRoutes`.

## Function: giftsRoutes

- **Purpose:** Hono sub-app for `GET /gifts?day=YYYY-MM-DD`. Invalid/missing `day` → 400. Empty day → 200 without Coinbase. Gifts present → `ensureDays([day])`; missing rate → 503.
- **Inputs:** `{ store: GiftStore; rates?: BtcUsdRateBook; now?: () => number }` (defaults: empty `InMemoryBtcUsdStore`, `Date.now`).
- **Returns / side effects:** Hono app mounted at `/gifts`. Logs `gifts.day.fx_incomplete` or `gifts.day.failed` on 503 paths.
- **Used by:** `createApp`.

## Function: giftsStatsRoutes

- **Purpose:** Hono sub-app for `GET /gifts/stats`. Optional `?recipient=` filters via `giftsForRecipient` before aggregation. Empty selection (no gifts, or unknown handle) → empty stats 200 without Coinbase. Otherwise `ensureDays` for unique selected gift days; missing rate → 503.
- **Inputs:** `{ store: GiftStore; rates?: BtcUsdRateBook; now?: () => number }` (defaults: empty `InMemoryBtcUsdStore`, `Date.now`). Query `recipient` is optional (missing/blank = unfiltered).
- **Returns / side effects:** Hono app mounted at `/gifts/stats`. Logs `gifts.stats.fx_incomplete` or `gifts.stats.failed` on 503 paths.
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

## Function: resolveCandlesUrl

- **Purpose:** Resolve the Coinbase (or override) candles HTTP URL from env.
- **Inputs:** `NodeJS.ProcessEnv` (`BTC_USD_CANDLES_URL`).
- **Returns / side effects:** Trimmed override or `DEFAULT_BTC_USD_CANDLES_URL` when unset/blank. No I/O.
- **Used by:** `openBootStores`.

## Function: parseCoinbaseCandles

- **Purpose:** Parse Coinbase candles JSON (`[time, low, high, open, close, volume]`) into `{ day, usdPerBtc }` rows.
- **Inputs:** Parsed JSON body (must be an array).
- **Returns / side effects:** Close rows; skips bad shape / non-positive close. Throws if body is not an array. No I/O.
- **Used by:** `fetchDailyCloses`.

## Function: fetchDailyCloses

- **Purpose:** HTTP GET daily BTC-USD closes for an inclusive UTC day range (chunks of 300 days, `User-Agent: 21.gifts-api`, AbortSignal timeout).
- **Inputs:** `{ fetchImpl, url, fromDay, toDay, timeoutMs? }` (`timeoutMs` default 8000).
- **Returns / side effects:** `CandleClose[]`. Throws on invalid range, non-OK HTTP, or invalid JSON.
- **Used by:** `PostgresBtcUsdStore.ensureDays`.

## Function: migrateBtcUsdSchema

- **Purpose:** Applies `BTC_USD_DAILY_SCHEMA_SQL` (`CREATE TABLE IF NOT EXISTS btc_usd_daily`).
- **Inputs:** `SqlClient`.
- **Returns / side effects:** Void; idempotent DDL execute.
- **Used by:** `openBootStores` when SQL opens.

## Function: migrateMessageSchema

- **Purpose:** Applies `MESSAGE_SCHEMA_SQL` in order (`CREATE TABLE IF NOT EXISTS message` with nullable `photo`/`photo_content_type`, newest-first index, additive `ALTER … ADD COLUMN IF NOT EXISTS` for existing databases including `video_content_type` (MIME in Postgres; video bytes on disk under `MEDIA_DIR`, not bytea), `parent_id uuid REFERENCES message (id)`, `author_pubkey text`, then `ALTER TABLE message ALTER COLUMN account_id DROP NOT NULL` and `CREATE INDEX IF NOT EXISTS message_parent_id_idx ON message (parent_id, created_at ASC, id ASC)`, then `message_invoice` and `nostr_zap_ingest` without FKs plus `ALTER TABLE message_invoice ADD COLUMN IF NOT EXISTS lnurl_response jsonb` and their `created_at`/`message_id` and `receipt_id` indexes). After `message` exists, adds `account_profile_message_id_fkey` (`ON DELETE SET NULL`) and unique partial index `account_profile_message_uidx`.
- **Inputs:** `SqlClient`.
- **Returns / side effects:** Void; idempotent DDL execute matching `docs/schema/message.sql`.
- **Used by:** `openBootStores` when SQL opens.

## Function: migrateContactSchema

- **Purpose:** Applies `CONTACT_SCHEMA_SQL` in order (`CREATE TABLE IF NOT EXISTS contact` plus the newest-first index).
- **Inputs:** `SqlClient`.
- **Returns / side effects:** Void; idempotent DDL execute matching `docs/schema/contact.sql`.
- **Used by:** `openBootStores` when SQL opens.

## Function: migrateConversationSchema

- **Purpose:** Applies `CONVERSATION_SCHEMA_SQL` in order (`conversation` + `conversation_message` tables and unique indexes). `db_change` attach runs later and covers the new public tables.
- **Inputs:** `SqlClient`.
- **Returns / side effects:** Void; idempotent DDL matching `docs/schema/conversation.sql`.
- **Used by:** `openBootStores` when SQL opens, after `migrateContactSchema` and before `migrateDbChangeSchema`.

## Function: migratePushSchema

- **Purpose:** Applies `PUSH_SCHEMA_SQL` in order (`CREATE TABLE IF NOT EXISTS` for `push_subscription` and `push_outbox` with `delivered_endpoints`, supporting indexes, then `ALTER TABLE … ADD COLUMN IF NOT EXISTS delivered_endpoints`).
- **Inputs:** `SqlClient` already opened by boot.
- **Returns / side effects:** Void; idempotent DDL matching `docs/schema/push.sql`. Does not attach `db_change` triggers (that runs later via `migrateDbChangeSchema`).
- **Used by:** `openBootStores` when SQL opens, after `migrateConversationSchema` and before `migrateDbChangeSchema`.

## Function: migrateDbChangeSchema

- **Purpose:** Applies `DB_CHANGE_SCHEMA_SQL` in order so durable Postgres row changes are append-logged in `db_change` via AFTER INSERT/UPDATE/DELETE triggers (not from application store methods).
- **Inputs:** `SqlClient`.
- **Returns / side effects:** Void; idempotent SQL matching `docs/schema/db_change.sql` (pgcrypto, table, redact/log/immutable functions, triggers, attach loop). The immutability-guard `DO` drops the append-only trigger once, hashes `view_key` values that still match a live `account.view_key`, leaves non-matches unchanged, then recreates the trigger.
- **Used by:** `openBootStores` when SQL opens, immediately after `migratePushSchema`.

## Function: DB_CHANGE_SCHEMA_SQL

- **Purpose:** Ordered idempotent SQL that creates the append-only `db_change` log, secret-redacting helpers, immutability guard (including a one-time live `view_key` rewrite in that same `DO`), and per-table `trg_db_change` triggers on every public table except `db_change`.
- **Inputs:** None (readonly string array constant).
- **Returns / side effects:** Statement texts only; executed by `migrateDbChangeSchema`. Secrets `token`, `challenge`, `nostr_nsec_ciphertext`, `nonce`, `view_key`, `endpoint`, `p256dh`, `auth`, and `delivered_endpoints` become SHA-256 hex in logged JSON; other columns including `name` stay plaintext. The guard `DO` hashes JSON `view_key` that still equals a live `account.view_key` and leaves other rows unchanged.
- **Used by:** `migrateDbChangeSchema`; documented mirror in `docs/schema/db_change.sql`.

## Function: InMemoryBtcUsdStore

- **Purpose:** In-memory `BtcUsdRateBook` seeded at construction; never HTTP.
- **Inputs:** Optional `ReadonlyMap` or `Record` of day → rate. `ensureDays(days, nowMs)` returns the seed subset for valid requested days.
- **Returns / side effects:** Map of available rates; missing days omitted. No network.
- **Used by:** `createApp` / `giftsStatsRoutes` defaults; memory `openBootStores`.

## Function: PostgresBtcUsdStore

- **Purpose:** Durable `BtcUsdRateBook` over Postgres: SELECT requested days; fetch+upsert gaps, stale UTC-today (`fetched_at` older than 1h), and after-midnight finalize of an intraday print; skip candle days not requested; still-missing omitted (no throw).
- **Inputs:** Constructor `{ sql, fetchImpl, candlesUrl, source? }`. `ensureDays(days, nowMs)`.
- **Returns / side effects:** Day → rate map; still-missing days omitted (no throw). Writes `btc_usd_daily`.
- **Used by:** `openBootStores` when SQL opens.

## Function: PostgresMessageStore

- **Purpose:** Durable `MessageStore` over Postgres (`message` table plus `message_invoice` and `nostr_zap_ingest`). `deleteById` removes zap receipts, invoices, child replies, and the row in **one** parameterised data-modifying CTE `query`, then unlinks on-disk videos from the returned rows. `listLatest` is **top-level only** (`WHERE parent_id IS NULL`) with subquery `replyCount` (direct children), selecting Nostr columns plus `(photo IS NOT NULL) AS has_photo` and never the `photo` bytea column (HTTP window newest-first; product UX is a messenger group — clients reverse); `listReplies` is oldest-first (`WHERE parent_id = $1`, `created_at ASC, id ASC`); `listPublishedEventIds` returns non-null top-level `event_id`s newest-first for inbound reply REQ; `create` inserts optional photo bytes and optional `video_content_type` (disk write via `writeForumVideo`; `removeForumVideo` unlink on INSERT failure); `getPhoto` loads bytes by id; `getById`; `getByEventId` (`WHERE event_id`); `claimUnsigned`/`claimUnpublished` lease rows (`claimed_until <= now` is expired; unsigned requires `pending` + null `event_id`); `listPendingSigned` returns pending rows whose kind:1 lacks `t=bitcoin` (`created_at ASC, id ASC`); `clearSignedEvent` nulls `event_id` / `nostr_event` / `claimed_until` only while `pending` and `event_id` still matches the listed id and no child reply exists (`NOT EXISTS`); `listSignedMissingPhoto` returns published **top-level** rows (`parent_id IS NULL`) with a photo whose kind:1 content lacks `/messages/:id/photo.` plus an image extension (`sats = 0`, pending excluded so fan-out is not starved, video rows / `video_content_type` excluded so posters are not treated as missing photos, parents with children skipped via `NOT EXISTS`, `created_at ASC, id ASC`); `listSignedMissingVideo` returns published **top-level** rows (`parent_id IS NULL`) with `video_content_type` set whose kind:1 content lacks `/messages/:id/video.` (`sats = 0`, pending excluded, parents with children skipped via `NOT EXISTS`, `created_at ASC, id ASC`); `listSignedMissingHashtags` returns published unpaid **top-level** rows (`parent_id IS NULL`, parents with children skipped via `NOT EXISTS`) whose kind:1 content lacks a `#bitcoin` or `#21gifts` token (next character must not be `[A-Za-z0-9_]`; `sats = 0`, pending excluded so fan-out is not starved, includes null / non-string content, `created_at ASC, id ASC`); `resetSignedEvent` nulls `event_id` / `nostr_event` / `claimed_until`, parks `pending`, and clears the epoch only when `event_id` still matches, `sats` is 0, and no child reply exists (`NOT EXISTS`); `updateSignedEvent` (false on `event_id` collision); `updatePublishState`; `addSats`; `recordZapReceipt` (one statement: `INSERT nostr_zap_receipt ON CONFLICT DO NOTHING` plus `UPDATE message.sats`); `recordInvoiceAttempt` / `listInvoiceAttempts` (each attempt includes `lnurlResponse`: raw LNURL callback JSON object or null); `recordZapIngest` / `listZapIngests`.
- **Inputs:** Constructor takes a shared boot `SqlClient` (already migrated).
- **Returns / side effects:** Parameter-bound SQL; maps snake_case rows to `MessageRow` / `ForumPhoto` / invoice and ingest rows. Claim uses `FOR UPDATE SKIP LOCKED`. Errors propagate to the route (503) except invoice/ingest persist failures which are caught by callers.
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: PostgresContactStore

- **Purpose:** Durable `ContactStore` over Postgres (`contact` table). `listLatest` is newest-first with a limit; `create` inserts the row.
- **Inputs:** Constructor takes a shared boot `SqlClient` (already migrated).
- **Returns / side effects:** Parameter-bound SQL; maps snake_case rows to `ContactRow`. Errors propagate to the route (503).
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: PostgresConversationStore

- **Purpose:** Durable `ConversationStore` over Postgres (`conversation` + `conversation_message`). Open-or-create per counterpart kind, list visible threads, append messages, claim unsigned/unpublished wraps, unique `event_id`. `openMemberPlatform` updates `account_b` when an existing member→platform thread points at a different platform id. `retargetMemberPlatform` bulk-updates `account_b` on every `member_platform` row whose `account_a` is not the new platform id.
- **Inputs:** Constructor takes a shared boot `SqlClient` (already migrated).
- **Returns / side effects:** Parameter-bound SQL; maps snake_case rows to `ConversationThread` / `ConversationMessageRow`. Unique violations on open/append are swallowed as idempotent. Errors otherwise propagate to the route (503).
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: fillRatesForGiftRange

- **Purpose:** Boot helper: `SELECT min/max(paid_at)` for outbound gifts, then `ensureDays` for every UTC day from min through max.
- **Inputs:** `SqlClient`, `BtcUsdRateBook`, `nowMs`.
- **Returns / side effects:** Void. No-op when no outbound gifts. Does not catch — boot logs failures.
- **Used by:** `openBootStores`.

## Function: InMemoryAuthStore

- **Purpose:** Process-local AuthStore: passkey challenges/credentials, accounts, sessions, verifications, and custodial Nostr keys (`getNostrPublicKey` / `getNostrSecret` / `setNostrKeyIfAbsent` / `listAccountIdsWithoutNostrKey`). Evicts expired challenges/sessions on write. Indexes `linkingKey` only when non-null. Maintains an O(1) `viewKey` index; `getAccountByViewKey` looks it up. `getAccountByLightningAddress` scans for a `lower(trim)` match and skips null addresses. `updateAccountNameByLightningAddress` mutates only `name` on the matched account (`lower(trim)`); other fields stay unchanged; unknown address → `undefined`. `accountHasPasskey` is true when any credential maps to the account id. `createAccount` is a no-op when `viewKey` is already stored, a non-null `linkingKey` already exists, or `lightningAddress` (`lower(trim)`) belongs to another id. `updateAccount` reindexes `viewKey` when it changes and refuses a `viewKey`, non-null `linkingKey`, or `lightningAddress` owned by another id. `createAccount` / `updateAccount` with `isPlatform: true` call `#clearPlatformExcept` so every other account's `isPlatform` is false (at most one platform account). `deleteAccount` drops the row and its linking-key and viewKey indexes. `listAccounts` returns every account oldest-first.
- **Inputs:** Constructor none. Methods take domain objects (`PasskeyChallenge`, `PasskeyCredential`, `Account`, `Session`, `AddressVerification`). `createAccount` is a no-op when a non-null `linkingKey` already exists, when `viewKey` is already stored, or when `lightningAddress` (`lower(trim)`) is taken. `updateAccount` refuses a `linkingKey` / `viewKey` / `lightningAddress` owned by another account and keeps the viewKey index consistent. `updateAccountNameByLightningAddress(lightningAddress, name)` takes the address and new display name. `deleteAccount` drops the row and its linking-key and viewKey indexes. `createPasskeyCredential` returns false when this account already has a credential or the id is taken. `createFirstPasskeyCredential` returns false when this account already has a credential or the id is taken. `updatePasskeyCredential` returns false unless `(newCount === 0 && stored === 0)` or `newCount > stored`; missing id is false; does not rebind `accountId` / `publicKey`. `updatePasskeyChallenge` returns false when the row is missing or already consumed.
- **Returns / side effects:** Lookups return the object or `undefined`. Writes resolve when persisted. `listAccounts` returns `Account[]`.
- **Used by:** `createApp` default store; all auth/me/debug/view routes.

## Function: PostgresAuthStore

- **Purpose:** Durable AuthStore over Postgres (`SqlClient`). Same eviction-on-write semantics as the in-memory adapter, including passkey challenges, credentials, custodial Nostr key columns, and the `view_key` column. `getAccountByViewKey` is `WHERE view_key = $1`. `getAccountByLightningAddress` is `WHERE lower(trim(lightning_address)) = lower(trim($1))` (null addresses do not match). `updateAccountNameByLightningAddress` is `UPDATE account SET name = $2 WHERE lower(trim(lightning_address)) = lower(trim($1)) RETURNING …` (other columns unchanged; empty `RETURNING` → `undefined`). `accountHasPasskey` is `SELECT 1 FROM passkey_credential WHERE account_id = $1 LIMIT 1`. `mapAccount` skips null `view_key` (`getAccount` / `getAccountByViewKey` / `getAccountByLightningAddress` / `updateAccountNameByLightningAddress` return undefined; `listAccounts` omits those rows) and sets `isPlatform` true only when `is_platform` is true. Passkey `signCount` advances with an atomic `WHERE` (`0/0` or `new > stored`) `RETURNING`, not `GREATEST`; duplicate credential ids are `ON CONFLICT DO NOTHING`. `createPasskeyCredential` also returns false on unique_violation `23505` for `passkey_credential_account_uidx` (one credential per account). `createFirstPasskeyCredential` inserts only when the account has no credential (`WHERE NOT EXISTS` plus unique `account_id`); unique_violation is false. `createAccount` INSERT unique_violation `23505` is a no-op. `updateAccount` refuses a `linkingKey` owned by another id (`UPDATE` matches no row; unique_violation `23505` is a no-op). Before `createAccount` / `updateAccount` when `isPlatform === true`, `UPDATE account SET is_platform = false WHERE is_platform AND id <> $1` so at most one platform account remains (partial unique `account_is_platform_uidx`). INSERT/UPDATE write `is_platform`. `deleteAccount` is `DELETE FROM account WHERE id = $1`. Unique index on `lower(trim(lightning_address))` where the address is not null.
- **Inputs:** Constructor takes a `SqlClient`. Methods match `AuthStore` including `getAccountByViewKey`, `getAccountByLightningAddress`, `updateAccountNameByLightningAddress`, and `accountHasPasskey`.
- **Returns / side effects:** Parameter-bound SQL; maps snake_case rows to domain objects.
- **Used by:** `openAuthStore` when `DATABASE_URL` is set.

## Function: migrateAuthSchema

- **Purpose:** Applies `AUTH_SCHEMA_SQL` in order (`CREATE TABLE IF NOT EXISTS` plus `ALTER` backfills for existing databases).
- **Inputs:** `SqlClient`.
- **Returns / side effects:** Void; creates `account`, `auth_session`, `address_verification`, `passkey_challenge`, `passkey_credential`; drops leftover `auth_challenge`; backfills `account.name` / nullable `linking_key`; adds `nostr_pubkey` / nsec ciphertext / kek id / custody plus unique index and CHECK; adds `view_key` ALTER, uuid-concat backfill, and unique index; adds nullable `rules_agreed_at`; unique index `account_lightning_address_uidx` on `lower(trim(lightning_address))` where not null; unique index `passkey_credential_account_uidx` on `account_id`; adds `is_platform boolean NOT NULL DEFAULT false` and unique index `account_is_platform_uidx` on `(is_platform) WHERE is_platform`; adds nullable `name_skipped_at`, `lightning_address_skipped_at`, and `profile_message_id uuid` (**no** FK to `message` here — message migrates later).
- **Used by:** `openAuthStore`.

## Function: openAuthStore

- **Purpose:** Chooses in-memory vs Postgres AuthStore from `DATABASE_URL`.
- **Inputs:** URL or blank/undefined; `createClient` factory required when the URL is set (boot supplies Bun SQL; tests inject a mock).
- **Returns / side effects:** `InMemoryAuthStore` if unset; otherwise migrate then `PostgresAuthStore`. Throws if the URL is set without a factory.
- **Used by:** `openBootStores`.

## Function: openBootStores

- **Purpose:** Shared `DATABASE_URL` wiring: one `SqlClient` for durable auth, FX table, `QueryGiftStore`, `SqlGiftRecorder`, `PostgresBtcUsdStore`, `migrateMessageSchema`, `PostgresMessageStore`, `migrateContactSchema`, `PostgresContactStore`, `migrateConversationSchema`, `PostgresConversationStore`, `migratePushSchema`, `PostgresPushStore`, `migrateDbChangeSchema`, and parsed `NOSTR_NSEC_KEK`; or in-memory auth, `giftStore`/`giftRecorder`/`messageStore`/`contactStore`/`conversationStore`/`pushStore` undefined, `nostrKek` undefined, and empty `InMemoryBtcUsdStore` when unset.
- **Inputs:** `databaseUrl`; optional `createClient` (required when URL set); optional `fx: { fetchImpl, candlesUrl, now }` so tests avoid the network (`candlesUrl` defaults via `resolveCandlesUrl(process.env)`). SQL path reads `process.env.NOSTR_NSEC_KEK`.
- **Returns / side effects:** `{ authStore, giftStore, giftRecorder, btcUsdRates, messageStore, contactStore, conversationStore, pushStore, nostrKek }`. Migrates `btc_usd_daily`, `message`, `contact`, `conversation` (via `migrateConversationSchema`), `push_subscription`/`push_outbox` (via `migratePushSchema`), then `db_change` after auth migrate; best-effort `fillRatesForGiftRange` logs `gifts.fx.boot_fill.failed` and does not throw. Throws if the URL is set without a factory, or if the SQL path has a missing/malformed KEK. SQL path returns `SqlGiftRecorder`, `PostgresMessageStore`, `PostgresContactStore`, `PostgresConversationStore`, and `PostgresPushStore`; memory path returns `giftRecorder`/`messageStore`/`contactStore`/`conversationStore`/`pushStore`/`nostrKek` undefined and skips migrates including `migrateConversationSchema` / `migratePushSchema` / `migrateDbChangeSchema`.
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
- **Inputs:** `DebugRouteDeps`: store, optional debugToken, required `fetchImpl` (NIP-57 mint probe on new POST addresses), optional `conversationStore` (`PATCH platform: true` calls `retargetMemberPlatform`), optional `messageStore` and `pushStore` (POST provision calls `ensureProfileMessage` when `messageStore` is set), optional `now` for minted debug sessions.
- **Returns / side effects:** Hono app (`GET /`, `POST /`, `PATCH /:id`, `POST /:id/session`). Shared 503 if token unset; 401 if bearer mismatches. GET 200 `{ accounts }` via `serializeDebugAccount` (includes `isPlatform`; no `viewKey`) logs `debug.accounts.listed` with count. POST body `{ accounts: [{ name, lightningAddress }] }` → 400 invalid body (including C0/DEL names or non-LUD-16 addresses after the shape check; no row is written); probes **all** new addresses first (`probeNip57Mint`) unless `NIP57_PROBE=0` (Playwright e2e skip; production must not set this); any `not_zap` / `unreachable` is 400 and no new address in that request is saved; name-only updates run only after every probe has passed; 500 `{ error: 'Could not save the account' }` when create does not persist the address, the name-only update matches no row, or the name-only update returns a row whose `name` is not the requested name; creates by Lightning Address, or for an existing address updates **only** `name` via `updateAccountNameByLightningAddress` (keeps `viewKey` / `role` / other columns); returns `{ accounts: [{ name, lightningAddress, viewKey, created }] }`; logs `debug.accounts.provisioned` with created/updated counts (never viewKeys or the token). PATCH body `{ role }` and/or `{ lightningAddress: null }` and/or `{ platform: true|false }` → 400 unknown/missing; 404 missing account; 200 `serializeDebugAccount` of the updated row (includes `isPlatform`; no `viewKey`); unlink also `deleteVerification` and logs `debug.accounts.lightning_address.cleared`; role changes log `debug.accounts.role_set` with account id and role; `platform: true` uniquely retargets (store clears any other `isPlatform`), points every member→platform thread at the new account via `retargetMemberPlatform` when `conversationStore` is set, and logs `debug.accounts.platform_set`. Never logs the token or the previous address.
- **Used by:** `createApp` at `/debug/accounts`.

## Function: debugContactsRoutes

- **Purpose:** Operator listing of private in-app contacts (includes `accountId`).
- **Inputs:** `DebugContactsRouteDeps`: contact store, optional debugToken.
- **Returns / side effects:** Hono app. 503 if token unset; 401 if bearer mismatches; 200 `{ contacts }` newest-first (cap 200); 503 on store throw (`contact.list.failed`). Logs `debug.contacts.listed` with count, never the token.
- **Used by:** `createApp` at `/debug/contacts`.

## Function: debugMessagesRoutes

- **Purpose:** Operator restore of a missing forum-video file for an already-existing message with `hasVideo` (raw body under `MEDIA_DIR`; no new message id, no DB create).
- **Inputs:** `DebugMessagesRouteDeps`: message store, optional debugToken.
- **Returns / side effects:** Hono app exposing `PUT /:id/video`. 503 if token unset/blank; 401 if bearer mismatches (before the body is read); 404 for non-UUID or unknown id; 409 when the row has no video or the decoded MIME extension does not match the stored type; 400 for empty/oversize/unrecognized body; 204 after `writeForumVideo`; 503 `{ error: 'Messages are unavailable' }` when `getById` or `writeForumVideo` throws (`debug.messages.video.put_failed`). Logs `debug.messages.video.put` with `messageId` and `bytes`, never the token or raw bytes.
- **Used by:** `createApp` at `/debug/messages`.

## Function: debugPaymentsRoutes

- **Purpose:** Operator listing of forum invoice attempts (`message_invoice`) and kind:9735 ingest decisions (`nostr_zap_ingest`).
- **Inputs:** `DebugPaymentsRouteDeps`: message store, optional debugToken.
- **Returns / side effects:** Hono app. 503 if token unset; 401 if bearer mismatches; 200 `{ invoices }` on `GET /invoices` (each row serializes `lnurlResponse` as the raw LNURL callback JSON object or null, plus `pr` / `isNip57Invoice` / description fields; never nsec) and `{ ingests }` on `GET /zap-ingests`, newest-first (cap 200). Store throws → 503 `{ error: 'Messages are unavailable' }` and `debug.invoices.list_failed` / `debug.zap_ingests.list_failed`. Logs `debug.invoices.listed` / `debug.zap_ingests.listed` with count, never the token or nsec.
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

## Function: WebPushSender

- **Purpose:** VAPID Web Push delivery via the `web-push` package to one browser subscription endpoint.
- **Inputs:** Constructor takes resolved `VapidConfig`. `send(sub, payload)` takes a `PushSubscriptionRecord` and a JSON string body.
- **Returns / side effects:** `isConfigured()` is `true`. Maps HTTP 404/410 to `gone`, other errors to `fail`, success to `{ ok: true }`. Optional ASCII `topic` from payload `tag` (max 32). TTL 86400.
- **Used by:** `src/index.ts` when VAPID resolves; drained by `runPushWorkerTick`.

## Function: InMemoryPushStore

- **Purpose:** Process-local `PushStore` for Web Push subscriptions and the outbox. Default empty so the process boots without a database.
- **Inputs:** Constructor none. Methods match `PushStore` (`upsertSubscription` keeps original `createdAt` on endpoint conflict; `claimPending` leases oldest pending; `markFailed` fails at 8 attempts; `recordDelivered` unions unique endpoint URLs onto the outbox row).
- **Returns / side effects:** Caller-owned copies including `deliveredEndpoints` slices; mutating results does not change the store. No I/O.
- **Used by:** `createApp` default `pushStore`; memory `src/index.ts` when boot omits SQL push.

## Function: PostgresPushStore

- **Purpose:** Durable `PushStore` over Postgres (`push_subscription`, `push_outbox`). Same port semantics as the in-memory adapter, including claim leases, attempt counting, and `recordDelivered` for successful endpoint URLs.
- **Inputs:** Constructor takes a shared boot `SqlClient` (already migrated via `migratePushSchema`).
- **Returns / side effects:** Parameter-bound SQL; maps snake_case rows to domain objects including `delivered_endpoints` JSON. Errors propagate to callers.
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: enqueueForumPushes

- **Purpose:** Enqueue one forum notification per account that has at least one subscription, never for the message author.
- **Inputs:** `PushStore`, `authorId`, `messageId`, `nowMs`. Payload from `buildForumPushPayload`.
- **Returns / side effects:** One pending `type: 'forum'` outbox row per other subscriber account. Does not send HTTP push itself.
- **Used by:** `messagesRoutes` after a successful `POST /messages` create.

## Function: enqueueZapPush

- **Purpose:** Enqueue one zap notification for the note author when they have at least one push subscription.
- **Inputs:** `PushStore`, `authorId`, `messageId`, `nowMs`. Payload from `buildZapPushPayload(messageId)`.
- **Returns / side effects:** Zero or one pending `type: 'zap'` outbox row. No-op when the author has no subscriptions.
- **Used by:** Zap ingest in `indexOpenZapReceipts` when `indexZapReceipt` newly indexed a receipt.

## Function: enqueueDebugPush

- **Purpose:** Enqueue a single operator test notification for one account when it has a subscription.
- **Inputs:** `PushStore`, `accountId`, `nowMs`. Uses a fixed zap-typed debug payload (`tag: 'debug'`).
- **Returns / side effects:** `0` or `1` (rows enqueued). Does not deliver; the push worker drains the outbox.
- **Used by:** `debugPushRoutes` (`POST /debug/push-ping`).

## Function: runPushWorkerTick

- **Purpose:** Claim a batch of pending outbox rows and deliver each payload to every subscription for the recipient account.
- **Inputs:** `PushWorkerDeps` (`store`, `sender`, `now`). Batch size and lease from module constants.
- **Returns / side effects:** No-op when `sender.isConfigured()` is false. Records successful endpoints via `recordDelivered` and does not resend them on retry; deletes gone subscriptions without recording them; `markFailed` on fail after recording successes; `markSent` when remaining sends succeed / all gone / no subs left to try.
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

- **Purpose:** Shared English forum notification payload (`type: 'forum'`, collapse tag `forum`, url `/welcome`).
- **Inputs:** None.
- **Returns / side effects:** `PushPayload` object; callers `JSON.stringify` before enqueue/send.
- **Used by:** `enqueueForumPushes`.

## Function: buildZapPushPayload

- **Purpose:** English zap notification payload for a note author (`type: 'zap'`, tag `zap:<messageId>`, url `/welcome`).
- **Inputs:** `messageId` string used only in `tag`.
- **Returns / side effects:** `PushPayload` object; callers `JSON.stringify` before enqueue/send.
- **Used by:** `enqueueZapPush`.

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

## Function: InMemoryMessageStore

- **Purpose:** Process-local `MessageStore` for the public member forum. Default empty so the process boots without a database. Photos live in a private map, not on listed rows. Same port as Postgres: `getById`, `deleteById` (row, direct replies, photos, invoices, zap receipt ids, on-disk videos), `getByEventId`, `listLatest` (top-level only, `parentId` null, each row has `replyCount`), `listReplies` (oldest-first for a parent), `listPublishedEventIds` (non-null top-level `eventId`s newest-first), claim/sign/publish (`claimUnsigned` is pending + null `eventId`; lease expires at `claimedUntil`), `listPendingSigned` (pending, no `t=bitcoin`, oldest-first), `clearSignedEvent` (pending and `eventId` still matches `expectedEventId` and the note has no child replies, then nulls `eventId` / `nostrEvent` / `claimedUntil`), `listSignedMissingPhoto` (top-level only, no children, published + photo, kind:1 content lacks `/messages/:id/photo.` plus extension, oldest-first, `sats === 0`, pending excluded, video rows excluded so posters are not treated as missing photos), `listSignedMissingVideo` (top-level only, no children, published + video MIME, kind:1 content lacks `/messages/:id/video.`, oldest-first, `sats === 0`, pending excluded), `listSignedMissingHashtags` (top-level only, no children, published unpaid, kind:1 content lacks a `#bitcoin` or `#21gifts` token, oldest-first, `sats === 0`, pending excluded so fan-out is not starved), `resetSignedEvent` (nulls `eventId` / `nostrEvent` / `claimedUntil`, parks `pending`, no-op unless `eventId` still matches, `sats` is 0, and the note has no child replies), `addSats`, `recordZapReceipt` (duplicate receipt id does not add sats; ids are released on `deleteById` so the same receipt can be recorded again), `recordInvoiceAttempt` / `listInvoiceAttempts` (each attempt includes `lnurlResponse` object or null), `recordZapIngest` / `listZapIngests`; `updateSignedEvent` returns false on duplicate `eventId`. Store/HTTP order is newest-first; product UX is a messenger group (clients reverse).
- **Inputs:** Optional seed `MessageRow[]` (copied; `hasPhoto` defaults false). `listLatest(limit)` is top-level only (`parentId === null`) with `replyCount`, sorts newest `createdAt` then `id` DESC and caps at `limit`. `listReplies(parentId, limit?)` is oldest-first (default 200). `listPublishedEventIds(limit)` is newest-first non-null top-level `eventId`s. `create(row, photo?, video?)` appends a copy; `getPhoto(id)` returns a photo copy or null.
- **Returns / side effects:** Promise of row/photo copies; mutating results does not change the store. Listed objects never expose bytes. When `video` is set, `create` awaits `writeForumVideo` (disk under `MEDIA_DIR`); if that write throws, the row is never pushed (no unlink).
- **Used by:** `createApp` default `messageStore`.

## Function: InMemoryContactStore

- **Purpose:** Process-local `ContactStore` for the private in-app mailbox. Default empty so the process boots without a database.
- **Inputs:** Optional seed `ContactRow[]` (copied). `listLatest(limit)` sorts newest `createdAt` then `id` DESC and caps at `limit`. `create(row)` appends a copy.
- **Returns / side effects:** Promise of row copies; mutating results does not change the store. No I/O.
- **Used by:** `createApp` default `contactStore`.

## Function: InMemoryConversationStore

- **Purpose:** Process-local `ConversationStore` for member↔member, member↔platform, and member↔Damus threads. Default empty so the process boots without a database.
- **Inputs:** Optional seed threads and messages (copied). Open helpers are idempotent per unique counterpart. `openMemberPlatform` updates `accountB` when the stored platform id differs. `retargetMemberPlatform` points every member→platform thread at the new official account except rows whose member is that account. `listVisible` is newest `lastMessageAt` then `id` DESC.
- **Returns / side effects:** Promise of copies; mutating results does not change the store. Duplicate `eventId` append returns the existing row. No I/O.
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

## Function: decodeBolt11

- **Purpose:** Read payment hash and millisat amount from a BOLT11 string via `light-bolt11-decoder`.
- **Inputs:** `pr` string; optional test decoder.
- **Returns / side effects:** `{ paymentHash, amountMsat }` or `null` on any decode failure.
- **Used by:** `invoiceRoutes` after LNURL-pay returns `pr`.

## Function: InMemoryInvoiceStore

- **Purpose:** Process-local store of gift invoices issued for the spend worker.
- **Inputs:** `put`, `get(id)`, `markPaid(id, preimage, now)`, `sweep(now)`.
- **Returns / side effects:** Lookups return the row or `undefined`. `sweep` drops unpaid rows after expiry plus one extra TTL (409 tombstone window); paid rows stay for proof idempotency. Restart clears the map.
- **Used by:** Default `createApp` `invoiceStore`; `invoiceRoutes`.

## Function: invoiceRoutes

- **Purpose:** Hono sub-app for spend-worker invoice issue and preimage proof.
- **Inputs:** `InvoiceRouteDeps`: spend token, store, clock, fetch, optional `giftRecorder` (default `NoopGiftRecorder`).
- **Returns / side effects:** Hono app mounted at `/invoices`. A matching proof (including the same-preimage idempotent 200) calls `recordOutbound`. Insert failures log `gifts.record_failed` and still return 200.
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
- **Inputs:** `AuthRouteDeps`: store, now, allowedOrigins, webAuthnRpId, webAuthnRpName, passkeyCeremony, optional `nostrKek` and `nostrKeygen`.
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

- **Purpose:** Wires CORS, requestLog, brand, health, info, auth, me, `/view`, lightning-address, `/debug/accounts`, `/debug/contacts`, `/debug/messages`, `/debug/invoices`, `/debug/zap-ingests`, `/debug/push-ping`, Web Push subscription routes, `/gifts`, `/gifts/stats`, `/messages` (incl. invoice), `/members/:accountId`, `/.well-known` NIP-05 `nostr.json` (CORS `*`), `/contact`, `/conversations`, and invoices.
- **Inputs:** Optional `AppDeps` (store, clock, payer, fetch, cache, readBrand, origins, `debugToken`, giftStore, `giftRecorder`, `btcUsdRates`, `messageStore`, `contactStore`, optional `conversationStore` (default `InMemoryConversationStore`), `pushStore`, `vapidPublicKey`, `nostrKek`, spendApiToken, invoiceStore, `webAuthnRpId`, `webAuthnRpName`, `passkeyCeremony`). Omitted `giftRecorder` → `invoiceRoutes` uses `NoopGiftRecorder`; omitted `messageStore` → `InMemoryMessageStore`; omitted `contactStore` → `InMemoryContactStore`; omitted `conversationStore` → `InMemoryConversationStore`; omitted `pushStore` → `InMemoryPushStore`; omitted/blank `vapidPublicKey` → push HTTP 503 after session; omitted `nostrKek` → unsigned forum + invoice 503; SQL boot injects `SqlGiftRecorder`, `PostgresMessageStore`, `PostgresContactStore`, `PostgresConversationStore`, `PostgresPushStore`, and parsed KEK. Does not take a push sender (worker owns delivery).
- **Returns / side effects:** Hono app. Default `btcUsdRates` is an empty `InMemoryBtcUsdStore`. Used by Bun.serve in `index.ts` and by tests via `app.request()`.
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

## Function: meRoutes

- **Purpose:** Authenticated account routes (`GET /`, `POST /setup/skip`, name with `ensureProfileMessage`, forum-laws dismiss, living-room rules agreement, Lightning Address link with live LNURL resolve + zap metadata check then NIP-57 mint probe `probeNip57Mint`, verification). Unlink clears `lightningAddressSkippedAt`. `POST /lightning-address` returns 409 `{ error: 'Lightning Address is already in use' }` when another account owns the address.
- **Inputs:** `MeRouteDeps` store, `messages`, now, payer, fetchImpl, optional `pushStore`, optional `nostrKek` (required to sign the mint probe).
- **Returns / side effects:** Hono at `/me`. Owner JSON includes `setup` + `missing`. Successful `POST /lightning-address` needs zap metadata (`allowsNostr` + non-empty `nostrPubkey`) plus KEK + `ensureAccountNostrKey` + probe `ok`. Probe `not_zap` → 400 `{ error: LIGHTNING_ADDRESS_NOT_ZAP }`; probe `unreachable` (and missing zap metadata) → 400 `{ error: 'Lightning Address could not be resolved' }`; missing/malformed KEK or key ensure failure → 503 with the same resolve string (account unchanged). Logs `account.setup.skipped` with `{ accountId, step }`.
- **Used by:** `createApp`.

## Function: viewRoutes

- **Purpose:** Hono sub-app for public `GET /:viewKey`. Param not 64 lowercase hex or unknown key → 404 `{ error: 'Not found' }`. Hit → `store.accountHasPasskey(account.id)` then `serializeViewProfile(account, hasPasskey)`. No auth; not a session.
- **Inputs:** `{ store: AuthStore }`.
- **Returns / side effects:** Hono app mounted at `/view` so the public path is `GET /view/:viewKey`.
- **Used by:** `createApp`.

## Function: messagesRoutes

- **Purpose:** Hono sub-app for the public member forum. After Bearer auth, `requireAction` gates `GET /` (`forum.read` → rules), `POST /` (`forum.post` → rules + name; LN not required), and `POST /:id/invoice` (`forum.pay` → payer rules only). Bearer `GET /` lists **top-level** notes only newest-first (cap 200, `hasPhoto`, `hasVideo`, `videoContentType`, `sats`, `payable`, live `role`, `replyCount`); missing-file `hasVideo` rows are deleted (`messages.video.dropped`); `POST /` creates text/photo/video; public `GET /:id` stays unauthenticated without `accountId`; Bearer `GET /:id/replies`; photo/video byte routes; invoice returns `{ pr, amountSats }` only for NIP-57 invoices (author LN / unsigned stay 400 resource errors, never 409 `lightning-address` for the payer). Optional `pushStore` enqueues on top-level create.
- **Inputs:** `MessagesRouteDeps`: message `store`, shared `authStore`, `now`, optional `nostrKek`, `fetchImpl`, `postLimiter`, `invoiceLimiter`, optional `pushStore`.
- **Returns / side effects:** Hono app mounted at `/messages`. 401 without session on list/create/replies/invoice; 409 `{ error: 'missing_requirements', missing }` when action gates fail; 400 on bad body / invalid text / bad media / unpaid note / author's-wallet / LNURL failures; 404 for bad `inReplyTo` / missing rows; 429 rate limits; 503 on store/KEK/sign failure. Signed-in list/replies/create may include `accountId`; public `GET /:id` never includes it.
- **Used by:** `createApp`.

## Function: contactRoutes

- **Purpose:** Hono sub-app for the private in-app contact mailbox: `POST /` only (no member GET). After auth, `requireAction(account, 'contact.post')` (rules + name). After the platform account exists, persists the contact row first, then opens/appends the member→platform conversation thread. Conversation append failure logs `conversations.contact_sync.failed` and still 200.
- **Inputs:** `ContactRouteDeps`: contact `store`, `conversationStore`, shared `authStore`, `now`.
- **Returns / side effects:** Hono app mounted at `/contact`. 401 without session; 409 `{ error: 'missing_requirements', missing }` when rules/name are missing; 400 on bad body / invalid text; 503 `{ error: 'Platform account is not configured' }` when no `isPlatform` account (no writes); 503 Contact is unavailable on contact-store failure (`contact.create.failed`). Public JSON omits `accountId`.
- **Used by:** `createApp`.

## Function: conversationRoutes

- **Purpose:** Hono sub-app for the signed-in PN channel: `GET /` lists visible threads; `POST /` opens a thread from `{ forumMessageId }`; `GET /:id` lists messages oldest-first; `POST /:id` appends `{ text }`. Staff (founder/moderator) see all platform threads and reply as the platform nsec.
- **Inputs:** `ConversationRouteDeps`: conversation `store`, shared `authStore`, forum `messageStore`, `now`.
- **Returns / side effects:** Hono app mounted at `/conversations`. 401 without session; 400 on bad body / self-PM / missing name / invalid text; 404 when not allowed; 503 Conversations are unavailable. Public JSON omits `accountId`, event ids, and npubs (Damus-only `name` may be a truncated npub).
- **Used by:** `createApp`.

## Function: normalizeDisplayName

- **Purpose:** Trim and validate an account display name (1–80 characters, no C0/DEL controls).
- **Inputs:** `raw` string.
- **Returns / side effects:** Trimmed name or `null`.
- **Used by:** `POST /me/name`.

## Function: normalizeForumText

- **Purpose:** Trim and validate forum message text. Empty/whitespace becomes `''` (valid for photo-only or video-only posts). Over-long (after trim, longer than `maxLength`) or disallowed C0/DEL still reject; newlines `\n`/`\r` allowed.
- **Inputs:** `raw` string; optional `maxLength` (default `MESSAGE_MAX_LENGTH` 500). Inbound Nostr worker passes `MESSAGE_INBOUND_REPLY_MAX_LENGTH` (8192) for Damus kind:1 replies and NIP-17/kind:4 plaintext.
- **Returns / side effects:** Trimmed text (possibly empty) or `null`. No I/O.
- **Used by:** `POST /messages`, `POST /contact`, `POST /conversations/:id`, `runNostrWorkerTick` inbound indexing.

## Function: detectImageContentType

- **Purpose:** Detect JPEG / PNG / WebP from magic bytes for forum photo storage.
- **Inputs:** Raw `Uint8Array` candidate bytes.
- **Returns / side effects:** `'image/jpeg' | 'image/png' | 'image/webp'`, or `null` for empty/SVG/GIF/HEIC/unrecognized. No I/O.
- **Used by:** `decodeForumPhoto`.

## Function: decodeForumPhoto

- **Purpose:** Decode a base64 forum photo, enforce the 1 MiB cap, and set MIME from magic bytes (declared `contentType` is ignored).
- **Inputs:** Declared `contentType` string (non-authoritative) and standard base64 `data`.
- **Returns / side effects:** `{ contentType, bytes }` with a copied `Uint8Array`, or `null` on invalid base64, empty, oversize, or unrecognized magic. No I/O.
- **Used by:** `POST /messages`.

## Function: serializeMessage

- **Purpose:** Project a stored forum row to its public JSON shape including zap totals, payability, `hasPhoto`, `hasVideo`, `videoContentType`, live author role, optional `replyCount`, and optional `accountId`. Callers that serve list/GET/replies delete a `hasVideo` row when the file is missing or empty on disk (`forumVideoFilePresent`) so no empty note remains.
- **Inputs:** `MessageRow` (includes `accountId`; never photo/video bytes), `payable` boolean, optional `role` (`AccountRole`; omitted for Damus-only authors), optional `replyCount` (top-level `GET /messages` list rows), and optional `includeAccountId` (signed-in list/replies/create pass true; public GET omits).
- **Returns / side effects:** `{ id, name, text, createdAt, sats, payable, hasPhoto, hasVideo, videoContentType }` with ISO-8601 `createdAt`; `videoContentType` is null when `hasVideo` is false; `role` omitted when undefined; `replyCount` omitted when undefined; `accountId` set only when `includeAccountId` is true and `row.accountId !== null` (Damus-only and public GET omit it); never photo/video bytes. No I/O.
- **Used by:** `messagesRoutes`.

## Function: serializeConversation

- **Purpose:** Project a stored thread to its public list JSON shape.
- **Inputs:** `ConversationThread` with resolved `name` / `lastText`.
- **Returns / side effects:** `{ id, name, lastText, lastAt }`. Omits account ids, event ids, npubs. No I/O.
- **Used by:** `conversationRoutes`.

## Function: serializeConversationMessage

- **Purpose:** Project a stored conversation message to its public JSON shape.
- **Inputs:** `ConversationMessageRow`.
- **Returns / side effects:** `{ id, name, text, createdAt }`. Omits account ids and event ids. No I/O.
- **Used by:** `conversationRoutes`.

## Function: unsignedConversationDefaults

- **Purpose:** Unsigned/pending defaults for a locally persisted conversation message.
- **Inputs:** none.
- **Returns / side effects:** `{ eventId: null, nostrPublishState: 'pending', nostrEvent: null, claimedUntil: null }`.
- **Used by:** `contactRoutes`, `conversationRoutes`.

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
- **Used by:** me lightning-address POST, public resolve, and POST /invoices.

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
- **Returns / side effects:** Readonly list in 409 order: `forum.read` → `rules`; `forum.post` / `contact.post` → `rules`, `name`; `forum.pay` → `rules`. No I/O.
- **Used by:** `requireAction`.

## Function: requireAction

- **Purpose:** Gate a signed-in action on factual account fields (skip does not satisfy). Filters `accountMissing` to the action's needs, preserving `actionRequirements` order.
- **Inputs:** `Account`, `AccountAction`.
- **Returns / side effects:** `{ ok: true }` or `{ ok: false, missing }` (never empty). No I/O. Routes respond 409 `{ error: 'missing_requirements', missing }` when `ok` is false.
- **Used by:** `messagesRoutes`, `contactRoutes`, `membersRoutes`.

## Function: ensureProfileMessage

- **Purpose:** Ensure a named account has exactly one top-level profile forum note. First non-blank name inserts one message (kind:1 pipeline defaults, frozen tags only) and stores `profileMessageId`. Rename is idempotent and does not change note text. Recreates when the stored id is missing. Rolls back the insert if `updateAccount` fails. Optional `pushStore` enqueues forum pushes for a new note.
- **Inputs:** `{ auth, messages, account, now, pushStore? }`.
- **Returns / side effects:** The account (possibly with `profileMessageId` set). May insert a message and update the account; may delete an orphaned insert on update failure.
- **Used by:** `meRoutes` (`POST /me/name`), `debugRoutes` provision, Nostr worker backfill.

## Function: serializeAccount

- **Purpose:** Project an account to the nine-field dump without `viewKey` or `isPlatform` (no Nostr fields).
- **Inputs:** `Account`.
- **Returns / side effects:** Nine public fields (`id`, `linkingKey`, `role`, `name`, `lightningAddress`, `lightningAddressVerified`, `forumLawsDismissed`, `createdAt`, `rulesAgreedAt`). No I/O. No Nostr key material.
- **Used by:** `serializeOwnerAccount` (member `/me`) and `serializeDebugAccount`.

## Function: serializeDebugAccount

- **Purpose:** Operator account JSON: the nine public fields plus `isPlatform`. Never used by member `GET /me`.
- **Inputs:** `Account`.
- **Returns / side effects:** `DebugAccountResponse`. `isPlatform` is true only when the stored flag is true. No `viewKey`. No I/O.
- **Used by:** `GET /debug/accounts` and `PATCH /debug/accounts/:id`.

## Function: serializeOwnerAccount

- **Purpose:** Owner JSON for authenticated account responses: the nine public fields plus `viewKey`, `setup`, and `missing`, so the owner can copy the capability URL and the client can route onboarding and action gates. Used by `GET /me`, `/me` writes including `POST /me/rules-agreement` and `POST /me/setup/skip`, and passkey finish — never by the debug listing. Does not expose `profileMessageId`.
- **Inputs:** `Account`.
- **Returns / side effects:** `OwnerAccountResponse` (twelve fields including `setup` and `missing`). No I/O.
- **Used by:** `meRoutes`, `authRoutes`.

## Function: membersRoutes

- **Purpose:** Hono sub-app for `GET /members/:accountId`. Bearer + `requireAction(forum.read)`; UUID path; live identity plus optional `profileMessage` via `serializeMessage`.
- **Inputs:** `MembersRouteDeps` (`authStore`, `messageStore`, `now`).
- **Returns / side effects:** Hono app mounted at `/members`. Logs `members.get.failed` on 503.
- **Used by:** `createApp`.

## Function: serializeViewProfile

- **Purpose:** Public profile card for the capability URL. Five fields (`name`, `lightningAddress`, `lightningAddressVerified`, `createdAt`, `hasPasskey`). Omits `id`, `linkingKey`, `role`, and `viewKey`.
- **Inputs:** `Account`, `hasPasskey: boolean`.
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

- **Purpose:** Copy frozen kind:1 tags.
- **Inputs:** none.
- **Returns / side effects:** `[["t","bitcoin"],["t","21gifts"],["r","https://21.gifts"]]`.
- **Used by:** `buildKind1Event`.

## Function: kind1HasHashtag

- **Purpose:** Case-insensitive check that kind:1 content already contains `#name` as a hashtag token (next character must not be `[A-Za-z0-9_]`; the `#` prefix distinguishes `#21gifts` from `https://21.gifts`).
- **Inputs:** content string, hashtag name without `#`.
- **Returns / side effects:** True when the token is present; otherwise false.
- **Used by:** `kind1ContentWithHashtags`.

## Function: kind1ContentWithHashtags

- **Purpose:** Append any missing Damus-visible `#bitcoin` / `#21gifts` tokens to Nostr kind:1 content (forum DB `text` stays unchanged). Empty → `"#bitcoin #21gifts"`; non-empty strips trailing newlines then appends `\n\n` + missing tags in fixed order; a tag is present when `kind1HasHashtag` matches (`#bitcoiners` is not `#bitcoin`).
- **Inputs:** content string.
- **Returns / side effects:** content with missing hashtags appended.
- **Used by:** `buildKind1Event`; `listSignedMissingHashtags` (in-memory helper).

## Function: forumPhotoUrl

- **Purpose:** Absolute `GET /messages/:id/photo.jpg` (or `.png` / `.webp`) URL for kind:1 content and `imeta`. The extension matches the stored MIME so Damus treats the URL as an image, not a website.
- **Inputs:** API origin, message id, optional MIME (default JPEG).
- **Returns / side effects:** URL string.
- **Used by:** Worker sign path.

## Function: buildKind1Event

- **Purpose:** Unsigned kind:1 for a forum line (top-level or NIP-10 reply). Optional media (`Kind1Photo`: image or video MIME) appends the public URL to content and a NIP-92 `imeta` tag (`url`, `m`, optional `dim`, optional `size`, optional `image` from `posterUrl`). Always ensures Damus-visible `#bitcoin` / `#21gifts` via `kind1ContentWithHashtags`, appending only missing tokens (forum row `text` is not modified). When `replyTo` is set, adds NIP-10 `e` (root + reply) and `p` tags after the frozen tags (and optional `imeta`); top-level notes never get `e`/`p`/`q`.
- **Inputs:** content, unix created_at, optional `{ url, mime, posterUrl?, dim?, size? }` (`Kind1Photo`), optional `replyTo?: Kind1ReplyTo` (`noteEventId`, `spaceRelay`, `noteAuthorPubkey`).
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

- **Purpose:** Short npub-style label for Damus authors without a 21.gifts account.
- **Inputs:** hex pubkey.
- **Returns / side effects:** Truncated display string.
- **Used by:** Inbound forum replies; conversation display names (`GET /conversations` Damus-only counterparts).

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

- **Purpose:** Sign unsigned rows; fan out when `NOSTR_PUBLISH=1`. Space-only ACK is terminal `published`/`space`. With `NOSTR_PUBLISH_PUBLIC=1`, space-only parks `pending` until a public ACK. Pending kind:1 JSON without `t=bitcoin` is dropped and re-signed, then unsigned rows are signed. After that, published unpaid notes missing a photo URL, a video URL, or Damus `#bitcoin`/`#21gifts` in content are reset for the next tick (`PUBLIC_BASE_URL` set for media URLs; video posters are not treated as missing photos). Pending rows EVENT as-is so a reset cannot renew the 60s sign lease. Zapped rows keep `eventId`. An empty API base skips photo/video-URL resign. Sign looks up photo bytes even when `hasPhoto` is stale. Each tick runs `backfillProfileMessages` for named accounts missing a profile note. When publishing, also fans out kind:0 profiles (`name` / `display_name` / `picture` / optional `nip05`, `about` from the profile-note text or `21.gifts`) and NIP-65 kind:10002 relay lists. Kind:1 photo/video posts include the public media URL and `imeta`. Each tick queries zap relays (space plus the public list, even when `NOSTR_PUBLISH_PUBLIC` is off) for kind:9735 and indexes validated receipts onto `sats`, even when `NOSTR_PUBLISH` is off. Each tick also runs `signConversationBatch` (NIP-17 wraps when a conversation store is present) and, when `NOSTR_PUBLISH=1`, `publishConversationBatch`. After zap ingest, `indexInboundForumReplies` (REQ kind:1 `#e` our published note ids; persist Damus/member replies even when publish is off) and `indexInboundDirectMessages` (REQ kind:1059 / kind:4 to member and platform pubkeys when a conversation store is present).
- **Kind:0 cache:** Unchanged content is not resent for the life of the AuthStore instance. After the live account row is read, the worker stores a reservation object and treats only that object as owner after each await. A nack or throw deletes the reservation only when it is still that object; the last issued `created_at` watermark is kept so a retry in the same second still increments. Kind:0 `created_at` is `max(wall clock, last issued + 1)` so an in-flight older profile cannot win a same-second replaceable-event tie.
- **Kind:0 batch:** At most `WORKER_BATCH` keyed attempts run per tick, including nacks. With public fan-out on, a space-only ACK is a nack and the profile is retried.
- **Inputs:** worker deps.
- **Returns / side effects:** Store updates; logs `nostr.sign.failed` / `nostr.publish.*` / `nostr.profile.ok` / `nostr.profile.nack` / `nostr.relays.ok` / `nostr.relays.nack` / `nostr.dm.sign.failed` / `nostr.dm.publish.*`. Event-id collision retries once with `created_at + 1`.
- **Used by:** `startNostrWorker`.

## Function: startNostrWorker

- **Purpose:** Interval handle around `runNostrWorkerTick`.
- **Inputs:** deps, intervalMs.
- **Returns / side effects:** `{ stop }`.
- **Used by:** Process entry `src/index.ts` when KEK + message store present.

## Function: buildZapRequest

- **Purpose:** Unsigned kind:9734 for a forum event.
- **Inputs:** recipient pubkey, event id, amountMsat, relays.
- **Returns / side effects:** EventTemplate.
- **Used by:** `POST /messages/:id/invoice`.

## Function: indexZapReceipt

- **Purpose:** Validate provider pubkey (case-insensitive hex) and add sats once per receipt id. Callers verify the Nostr signature first. Persists a `nostr_zap_ingest` row (`indexed`, or `rejected` with reason `pubkey` / `amount` / `duplicate`); store throw logs `nostr.zap.ingest.record_failed` and does not change the boolean result.
- **Inputs:** store, messageId, receipt, providerPubkey, amountSats; optional receiptEvent / noteEventId for debug rows.
- **Returns / side effects:** boolean; logs indexed/rejected; records ingest.
- **Used by:** `indexOpenZapReceipts` (worker tick).

## Function: indexOpenZapReceipts

- **Purpose:** Each worker tick, query zap relays for kind:9735 on recent notes (chunks of 20 event ids), verify the Nostr signature, validate provider pubkey via LNURL (module TTL cache, lowercased), bolt11 amount, e-tag, and index via `indexZapReceipt`. Persists every ingest decision (`indexed` / `rejected` with reason). One throwing receipt does not skip the rest of the tick. A newly indexed receipt enqueues a zap push when `pushStore` is set (`push.enqueue.failed` on throw, ingest continues).
- **Inputs:** store, auth, querier, urls, timeoutMs, now, fetchImpl; optional `verifyReceipt` (default: nostr-tools `verifyEvent`); optional `pushStore`.
- **Returns / side effects:** void; logs `nostr.zap.rejected` / `indexed`; records ingest rows; never logs full bolt11.
- **Used by:** `runNostrWorkerTick`.

## Function: requestZapInvoice

- **Purpose:** LNURL-pay callback with `nostr=` (not `comment=`). Captures raw LNURL callback JSON so callers can persist it on invoice-attempt rows. Never pays.
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
