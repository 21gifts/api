# Functions

## Function: posRoutes

- **Purpose:** Hono routes `GET /pos`, `POST /pos`, and `DELETE /pos` for one open point-of-sale amount in whole sats. Pins nothing itself; the well-known route reads the store. `GET /pos` returns the pending charge as `charge`, or else the newest row when it is `paid` with `paidAt` less than `POS_PAID_SHOW_MS` (60 s) ago, so the till can show the confirmation after a late poll.
- **Inputs:** `PosRouteDeps` (`store`, `authStore`, `now`, and `fetchImpl` required; optional `messageStore` with `listLiveAssignedShops`, optional `activity`, optional `lnurlServer`, optional `spot`). The LNURL `fetchImpl` is not the map fetch. `POST /pos` checks the amount against the member's receiving address (`receivingAddress`; a verified wallet through `lnurlServerFetch`). `spot` freezes the three currencies that were not typed; omitted, empty, or unreadable, the typed string is still stored and those three stay null.
- **Returns / side effects:** A Hono app. Writes charges through `PosStore`. The paid status is set by `runPosPaidTick`, not by these routes. After a successful `POST /pos` `store.create`, when both optional collaborators are set, lists live assigned shop notes and best-effort POSTs each matching `#21GiftsShop` note for this account to the OpenCryptoPay map (`pingShopActivity`). GET and DELETE do not ping. A map failure logs `ocp.activity.failed` and does not change 201.
- **Shop payment:** With optional `shopPayments`, `POST /pos` takes `now()` as its first statement and writes through `ShopPayments.createCharge` with that arrival (charge insert and end of the account's `open` shop payment in one transaction under the account row lock, then the background creation; `false` is the existing 409), `DELETE /pos` through `ShopPayments.cancelCharge` (also ends the charge's `open` shop payment with `cancelled`), and `GET /pos` adds `charge.shopPayment` (`shopPaymentOfCharge`: `{ id, status }` or `null`).
- **Used by:** `createApp`.

## Function: activeShopDays

- **Purpose:** Count how many qualifying shop notes were used on each of the last 30 UTC days ending on `today`. A shop note is a live top-level forum note whose text has the `#21GiftsShop` token (via `textHasHashtagToken`) and whose current `shop_account_id` is set. It counts on a UTC day when that currently assigned account has at least one `pos_charge` `created_at` on that day (any status). Current assignment, not assignment history.
- **Inputs:** `notes` (`ShopNoteRef[]`), `charges` (`PosChargeRef[]`), and `today` (`YYYY-MM-DD`). Duplicate note ids count once. Charges before the window or on the next UTC day are ignored.
- **Returns / side effects:** Exactly 30 `{ day, shopCount }` rows, oldest first. Missing days are `shopCount: 0`. No I/O.
- **Used by:** `shopActivityRoutes` (`GET /shops/activity`).

## Function: shopActivityRoutes

- **Purpose:** Hono sub-app for `GET /shops/activity`. No bearer. Any caller, including no session, gets `{ days }`. Loads live assigned shop notes and POS charges in the 30-UTC-day window, then returns `{ days }` from `activeShopDays`. Does not log account ids, note ids, or charge rows. No Sunday-rest gate on this GET.
- **Inputs:** `{ authStore, now, messages: { listLiveAssignedShops }, pos: { listCreatedBetween } }`.
- **Returns / side effects:** Hono app mounted at `/shops/activity`. 200 `{ days }`. Store throw → 503 `{ error: 'Shop activity is unavailable' }` and `shops.activity.failed`.
- **Used by:** `createApp`.

## Function: measureGrantContinuation

- **Purpose:** Count qualifying shop notes on each of the last 7 UTC days ending on `today`, and how many of those notes have a charge on at least 5 of those days. A shop note is a live top-level forum note whose text has the `#21GiftsShop` token (via `textHasHashtagToken`) and whose current `shop_account_id` is set. It counts on a UTC day when that currently assigned account has at least one `pos_charge` `created_at` on that day (any status). The 5 days need not be consecutive. This does not call `activeShopDays` and is not the public 30-day series.
- **Inputs:** `notes` (`ShopNoteRef[]`), `charges` (`PosChargeRef[]`), and `today` (`YYYY-MM-DD`). Duplicate note ids count once. An empty `accountId` and a note without the shop hashtag are skipped. Charges before the window or on the next UTC day are ignored.
- **Returns / side effects:** `{ days, qualifyingShops }`. `days` is exactly 7 `{ day, shopCount }` rows, oldest first, missing days `shopCount: 0`. `qualifyingShops` counts notes, not accounts. No I/O.
- **Used by:** `grantContinuationRoutes` (`GET /funding/goal`).

## Function: grantContinuationRoutes

- **Purpose:** Hono sub-app for `GET /funding/goal`. Any signed-in role, including `basis`, gets the body. The operator `DEBUG_TOKEN` or `DEBUG_READ_TOKEN` gets the same body without a session (checked first via `isOperatorBearer`); the body holds only counts. No bearer or a bearer that is neither an operator token nor a session is 401. Loads live assigned shop notes and POS charges in the 7-UTC-day window, then returns `measureGrantContinuation`. Does not call `activeShopDays` or read `GET /shops/activity`. Does not log account ids, note ids, or charge rows. No Sunday-rest gate on this GET.
- **Inputs:** `{ authStore, now, messages: { listLiveAssignedShops }, pos: { listCreatedBetween }, debugToken, debugReadToken? }`. Both tokens unset keeps the session-only path.
- **Returns / side effects:** Hono app mounted at `/funding/goal`. 200 `{ days, qualifyingShops }`. 401 `{ error: 'Unauthorized' }`. Store throw → 503 `{ error: 'Funding goal is unavailable' }` and `funding.goal.failed` with only `event` and `ts`.
- **Used by:** `createApp`.

## Function: serializePosCharge

- **Purpose:** Public JSON for a charge without `accountId` or `sparkInvoice`: `id`, `amountSats`, `status` (`pending`, `paid`, `cancelled`, or `expired`), `createdAt`, `expiresAt`, `paidAt` (`null` until paid), and the six fiat fields `amountCurrency`, `amount`, `amountUsd`, `amountChf`, `amountEur`, and `amountPhp`. A sats-only charge stores all six as null. The typed currency's `amountXxx` is the stored `amount` string, not the numeric column. Timestamps are ISO-8601.
- **Inputs:** A `PosCharge` row.
- **Returns / side effects:** `PublicPosCharge`. No I/O.
- **Used by:** `posRoutes`.

## Function: parseTypedFiatAmount

- **Purpose:** Accept a typed fiat decimal. Trims, turns every comma into a dot, and keeps the typed fraction, including trailing zeros. Rejects an empty string, a trailing dot, a sign, an exponent, more than eight fractional digits, and a value that is not greater than zero.
- **Inputs:** `raw` string, the operator's text.
- **Returns / side effects:** The stored decimal, or `null` when it is not a typed amount. No I/O.
- **Used by:** `POST /pos` when the body carries `amountCurrency` and `amount`.

## Function: isPosFiatCode

- **Purpose:** True when the value is exactly `USD`, `CHF`, `EUR`, or `PHP`. Does not trim.
- **Inputs:** A string.
- **Returns / side effects:** Boolean. No I/O.
- **Used by:** The till body parse and `freezePosFiatCrosses`.

## Function: freezePosFiatCrosses

- **Purpose:** Freeze the three currencies that were not typed, from one spot quote. The other amount is the typed amount times the other rate divided by the typed rate, then half-up to cents. The typed currency's numeric column stays null. A missing rate, a rate that cannot be parsed, or a result that does not fit numeric(20,2) is null for that currency. A throw while pricing one other currency does not leave the function; that currency stays null. amountSats is not an input. A null quote freezes nothing.
- **Inputs:** `typed` (USD, CHF, EUR, or PHP), `amountText` already accepted by `parseTypedFiatAmount`, and the latest spot quote or null.
- **Returns / side effects:** fiatUsd, fiatChf, fiatEur, and fiatPhp, each a two-decimal string or null. No I/O.
- **Used by:** `POST /pos` at insert.

## Function: serializePosFiat

- **Purpose:** The six JSON fiat fields. The typed currency's field is amountText, not the numeric column. Each other currency is the numeric formatted with two decimals, or null.
- **Inputs:** A PosCharge row.
- **Returns / side effects:** amountCurrency, amount, amountUsd, amountChf, amountEur, and amountPhp. No I/O.
- **Used by:** `serializePosCharge`.

## Function: serializeDebugPosCharge

- **Purpose:** Operator JSON for a charge including `accountId`, the `paid` status, `paidAt` (ISO-8601 or `null`), the stored `sparkInvoice` (or `null`), and the same six fiat fields as `serializePosCharge`.
- **Inputs:** A `PosCharge` row.
- **Returns / side effects:** `DebugPosCharge`. No I/O.
- **Used by:** Debug catalog table `pos_charge`.

## Function: migratePosSchema

- **Purpose:** Apply the idempotent `POS_SCHEMA_SQL`: `pos_charge` with `paid_at`, `spark_invoice`, and the `paid` status (an existing table gains the columns, and `pos_charge_status_check` is dropped and re-added with `paid`), the watch index on `expires_at` for pending and expired rows, `pos_charge_invoice` (payment hash primary key, charge id, issue time), and nullable `amount_currency`, `amount_text`, `fiat_usd`, `fiat_chf`, `fiat_eur`, and `fiat_php`. `pos_charge_amount_currency_check` is dropped and re-added so `amount_currency` is null or one of `USD`, `CHF`, `EUR`, `PHP`.
- **Inputs:** A `SqlClient`.
- **Returns / side effects:** Resolves when the statements have run.
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: InMemoryPosStore

- **Purpose:** Process-local `PosStore` used in tests and when no database URL is set. Always starts empty. `create` refuses a second unexpired pending row for the same account. `cancelPending` cancels every remaining pending row. `issueSparkInvoice` keeps the first Spark invoice of a charge that was open at the given issue time (`pending` or `expired`, `expiresAt` after it); `recordInvoice` records a payment hash once under the same rule, so the issue time decides, not the write time (a charge open then and expired since still records), and decides one of four `RecordInvoiceOutcome`s from its `paymentHashClaims` map: `other_payment` (with `holderChargeId` and `holderPaymentId`) when another charge's invoice row or another payment's shop payment holds the hash, `this_charge` when only this charge or its shop payment holds it, otherwise `not_open` or `recorded`; it reads the map and adds its entry in one synchronous step, without an `await` in between; `listWatched` lists pending and expired charges whose `expiresAt` is after the window start, oldest first, with their hashes; `markPaid` flips a pending or expired charge to `paid` once and logs `pos.paid` with the account id only.
- **Inputs:** None.
- **Returns / side effects:** Pending, cancel, expire, list, and paid-tracking methods. Mutates its private arrays. `create` throws `A payment is already open` when one is already open.
- **Payment lookup:** `findChargeForPayment({ paymentHash })` returns the charge whose recorded BOLT11 hash matches, and `findChargeForPayment({ chargeId })` the charge with that id; `undefined` otherwise. Used by `walletPaymentClassifier` for the `shop` category.
- **deleteInvoice:** `deleteInvoice(paymentHash)` removes the recorded BOLT11 payment hash, if present, and releases the charge side of its entry in `paymentHashClaims`; an unknown hash is a no-op and the charge itself is unchanged. `InMemoryShopPaymentStore` delegates `ShopTx.deleteChargeInvoice` to it.
- **Payment hash claim:** The public `paymentHashClaims` (`PaymentHashClaims`) is the payment hash claim of a memory boot. An `InMemoryShopPaymentStore` built on this store uses the same map, so a charge's invoice row and a shop payment never hold one hash for two payments.
- **Used by:** `createApp` default and unit tests.

## Function: PostgresPosStore

- **Purpose:** `PosStore` against the `pos_charge` and `pos_charge_invoice` tables. Pending inserts are one per account via `pos_charge_account_pending_idx`. `create` expires due rows first so a finished charge does not block the next one. `cancelPending` cancels every remaining pending row. `issueSparkInvoice` is one conditional `UPDATE … COALESCE(spark_invoice, $2)` on a `pending` or `expired` row whose `expires_at` is after the issue time; `recordInvoice` is one transaction on the `MergeDb` port: first the payment hash claim (`SELECT pg_advisory_xact_lock($1, $2)` with `PAYMENT_HASH_LOCK_NAMESPACE` and `paymentHashLockKey`), then the `pos_charge_invoice` and `shop_payment` rows of the hash (`other_payment` with the holder when another charge or payment holds it, `this_charge` when only this charge or its shop payment does), and only then one `INSERT … SELECT` gated the same way, with `ON CONFLICT (payment_hash) DO NOTHING` (`recorded` when it inserted, `not_open` when not); it takes no other lock before the insert, and a statement error (for example a foreign-key error after an account merge deleted the charge) propagates as an error, never as an outcome; `listWatched` joins the recorded hashes; `markPaid` is one conditional `UPDATE … WHERE status IN ('pending', 'expired')`, so the first confirmation wins.
- **Inputs:** A `SqlClient` (migrated, with `shop_payment`, which every SQL boot migrates) and the optional `MergeDb` transaction port for `recordInvoice` (without it `recordInvoice` throws `pos transactions are not configured`).
- **Returns / side effects:** Same port as the in-memory store, persisted in Postgres. A concurrent second pending insert raises unique violation `23505` for the route to map to 409. `markPaid` logs `pos.paid` only when it changed the row. Every write lands in `db_change` through `trg_db_change`.
- **Payment lookup:** `findChargeForPayment({ paymentHash })` joins `pos_charge_invoice` to `pos_charge` on the recorded hash; `findChargeForPayment({ chargeId })` reads one charge by id, and a non-UUID id answers `undefined` without a query (no uuid cast error). Used by `walletPaymentClassifier` for the `shop` category.
- **deleteInvoice:** `deleteInvoice(paymentHash)` runs `DELETE FROM pos_charge_invoice WHERE payment_hash = $1`; a hash that is not recorded deletes nothing. The delete lands in `db_change`. `PostgresShopPaymentStore` calls it on the transaction connection (`ShopTx.deleteChargeInvoice`). The `UUID` shape check is `UUID_PATTERN` from `src/lib/uuid.ts`.
- **Used by:** `openBootStores` when `DATABASE_URL` is set (with the boot's transaction port).

## Function: duplicateInvoiceLogFields

- **Purpose:** The fields of `shop.alert.duplicate_invoice` that the invoice routes log when `recordInvoice` returned `other_payment` for the pending charge.
- **Inputs:** The pending charge id and the `other_payment` result (`holderChargeId`, `holderPaymentId`).
- **Returns / side effects:** `{ chargeId, holderChargeId?, paymentId? }`: `holderChargeId` when a charge holds the hash (its invoice row or its shop payment), and `paymentId` only when a shop payment holds it. Pure; logs nothing itself.
- **Used by:** `payRoutes` (`POST /pay/:username/invoice`) and `lnurlServerRoutes` (`GET /lnurlp/:username/invoice`).

## Function: paymentHashLockKey

- **Purpose:** Second key of the payment hash claim (`docs/shop-stablecoin-payment.md`, Payment hash claim): the first 32 bits of the payment hash as a signed 32-bit integer (`parseInt(hash.slice(0, 8), 16) | 0`). The first key is the fixed `PAYMENT_HASH_LOCK_NAMESPACE`, and the statement is `PAYMENT_HASH_CLAIM_SQL` (`SELECT pg_advisory_xact_lock($1, $2)`), the two-key form, which never meets the one-key lock of `admitWithinPlaces`.
- **Inputs:** A payment hash (lowercase hex).
- **Returns / side effects:** A signed 32-bit integer; `ffffffff…` is `-1`, `00000000…` is `0`, and text that is not hex gives `0`. Two hashes that share their first 32 bits only wait for each other. Pure.
- **Used by:** `PostgresPosStore.recordInvoice` and `ShopTx.claimPaymentHash` of `PostgresShopPaymentStore` (step 8 of the creation procedure).

## Function: PaymentHashClaims

- **Purpose:** The payment hash claim of a memory boot: one in-process map from payment hash to the charge whose `pos_charge_invoice` row holds it and the shop payment that holds it (with that payment's `pos_charge_id`). Every method is synchronous, so a writer that reads the map and adds its entry without an `await` in between claims the hash atomically.
- **Inputs:** None.
- **Returns / side effects:** `holder(hash)` returns a copy of `{ chargeId, paymentId, paymentChargeId }` or `null`; `claimCharge(hash, chargeId)` and `claimShop(hash, paymentId, paymentChargeId)` set one side; `release(hash, side)` clears the `charge` or `shop` side and drops the entry once neither side holds it.
- **Used by:** `InMemoryPosStore` (its `paymentHashClaims`, read and written by `recordInvoice` and `deleteInvoice`) and `InMemoryShopPaymentStore` (`insertPayment`, and the release of a rolled-back insert).

## Function: buildGiftDay

- **Purpose:** Pure list of outbound gifts that fall on one UTC calendar day. Each currency is that row's stored string. A missing USD does not discard a stored CHF, EUR, or PHP. A missing currency stays null. No daily rate is read.
- **Inputs:** `day` (`YYYY-MM-DD`), `readonly GiftRow[]` (other days ignored), ignored UTC day → USD-per-BTC map, optional `ReadonlyMap` of UTC day → USD→CHF/EUR/PHP used only for `fx.quotes`. Empty matching set needs no rates.
- **Returns / side effects:** `GiftDay` (`gifts` sorted by `paidAt` then `recipient`) with `totalChf`/`totalEur`/`totalPhp` and `fx.quotes`. Empty day is `"0.00"` fiat and USD-only `quotes`. A missing stored amount is JSON `null`, never a throw. One null does not null the day's other figures. No I/O.
- **Used by:** `giftsRoutes`.

## Function: buildAccountActivity

- **Purpose:** Aggregate donation given and received sats for one account, plus outstanding loan balances on the same object. Given is confirmed forum zaps paid on notes that are not loans, excluding repay: repayment invoices, plus outbound house gifts of kind daily and welcome when `isPlatform` is true. Moderator stipends (`kind === 'moderator'`) are omitted. Received is indexed zaps on authored notes that are not loans (including hidden notes and replies) plus `message.sats` remainder on top-level non-loan notes only (a loan note is omitted entirely, including a hidden one; gift-as-reply `sats` are not Received) plus house gifts of kind daily and welcome to the recipient handle (its username, only once the wallet is verified). A loan is a note with `goalRepayable === true`. Loans stay out of `donatedSats` / `receivedSats`. Loan series are not `buildGiftStats`: balances can fall, only movement days are emitted, and every fiat field is JSON `null` because a loan movement stores no fiat figure. Does not change `GET /gifts/stats`. Donation series (`donatedOverTime` / `receivedOverTime`) are the same `spendOverTime` day objects as `GET /gifts/stats` including additive CHF/EUR/PHP. Each currency is its own stored string. A missing USD does not discard a stored CHF, EUR, or PHP. No daily close is copied onto a null amount.
- **Inputs:** `{ account, gifts, messages, rates, now, fiatRates? }`. Uses `listInvoiceAttemptsForPayer`, `listIndexedZapIngests`, `listAuthoredMessages`, `listLoanLedger`, `listOutbound`, and `giftsForRecipient`. Non-repayment invoice message ids are loaded with `getById` to read `goalRepayable`. `rates` and `fiatRates` are not read.
- **Returns / side effects:** `AccountActivity` (`donatedSats`, `receivedSats`, `donatedOverTime`, `receivedOverTime`, `owedSats`, `creditSats`, `owedOverTime`, `creditOverTime`, `fx`). Empty input (no donations and no loan movements) is zeros with USD-only `fx.quotes`, without Coinbase and without Frankfurter. A missing stored amount stays JSON `null` and does not throw. One null does not null the day, the other currencies, or a later cumulative.
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

- **Purpose:** Pure aggregation of outbound gifts into the public stats JSON (UTC daily series with gap days and per-day `giftCount` plus `officialCount`, months with gap months, recipients) including BTC strings. `officialCount` is the distinct case-insensitive recipient handles that UTC day with kind `daily` or `welcome` (one person once; moderator excluded; gap days 0). `giftCount` remains every outbound row. Each currency is its own stored string. A missing USD does not discard a stored CHF, EUR, or PHP. A missing currency stays null. No daily close is read. One null does not null the day, the other currencies, or a later cumulative. A day where every row lacks a currency is null for that currency.
- **Inputs:** `readonly GiftRow[]` (`paidAt`, `amountSats`, `recipientWosUser`, `kind`), ignored `ReadonlyMap<string, string>` of UTC day → USD-per-BTC, optional `ReadonlyMap` of UTC day → USD→CHF/EUR/PHP used only for `fx.quotes`. Empty rows need no rates.
- **Returns / side effects:** `GiftStats` with `totalBtc`, `totalUsd`, `totalChf`/`totalEur`/`totalPhp`, `fx` (including `fx.quotes`), BTC/USD/fiat on series/buckets, and `spendOverTime[].officialCount` (not on recipient or month buckets). A missing stored amount is JSON `null`, never a throw. Gap days and gap months are zero sats/BTC/`officialCount` and `"0.00"` fiat and do not change a running cumulative. An empty selection stays zeros. No I/O.
- **Used by:** `giftsStatsRoutes`.

## Function: giftsForRecipient

- **Purpose:** Filter outbound gift rows to one recipient handle (the local part of the receiving address; case-insensitive). Used by `GET /gifts/stats?recipient=` so stats reflect that handle's gifts only.
- **Inputs:** `readonly GiftRow[]` and `recipient` string. Trims `recipient`; when `indexOf('@') > 0` compares the local-part before `@`, otherwise the whole trimmed string. Empty after trim matches nothing — never "all gifts".
- **Returns / side effects:** Matching `GiftRow[]` in input order, or `[]`. No I/O.
- **Used by:** `giftsStatsRoutes`.

## Function: giftsRoutes

- **Purpose:** Hono sub-app for `GET /gifts?day=YYYY-MM-DD`. Invalid/missing `day` → 400. Amounts are the stored strings. A missing stored amount stays null. The rate books are not read. A missing stored amount is never 503.
- **Inputs:** `{ store: GiftStore; rates?: BtcUsdRateBook; fiatRates?: FiatRateBook; now?: () => number }`. The rate books and the clock are accepted and not read.
- **Returns / side effects:** Hono app mounted at `/gifts`. Empty day is 200 without Coinbase or Frankfurter. A store throw logs `gifts.day.failed` and answers 503. No I/O to a rate book.
- **Used by:** `createApp`.

## Function: buildPostStats

- **Purpose:** Turn per-day living note counts into the public posts series. Notes and replies are already combined by the store.
- **Inputs:** Day rows (any order) and a clock in epoch milliseconds.
- **Returns / side effects:** `{ postCount, postsOverTime }`. Empty input stays empty. Otherwise every UTC day from the earliest row through today, or through a later row, is present. Missing days are 0. No I/O.
- **Used by:** `GET /messages/stats`.

## Function: giftsStatsRoutes

- **Purpose:** Hono sub-app for `GET /gifts/stats`. Optional `?recipient=` filters via `giftsForRecipient` before aggregation. Amounts are the stored strings. A missing stored amount stays null. The rate books are not read. A missing stored amount is never 503.
- **Inputs:** `{ store: GiftStore; rates?: BtcUsdRateBook; fiatRates?: FiatRateBook; now?: () => number }`. The rate books and the clock are accepted and not read. Query `recipient` is optional (missing/blank = unfiltered).
- **Returns / side effects:** Hono app mounted at `/gifts/stats`. Empty selection (no gifts, or unknown handle) is empty stats 200 without Coinbase or Frankfurter. A store throw logs `gifts.stats.failed` and answers 503. No I/O to a rate book.
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

## Function: paymentRateDays

- **Purpose:** UTC days to load when freezing a payment, newest first. The first day is the payment day. Each following day is the previous UTC date.
- **Inputs:** `day` (`YYYY-MM-DD`) and optional `count` (default 10, clamped to 1..10).
- **Returns / side effects:** That many days, or an empty list when `day` is not a real calendar date. No I/O.
- **Used by:** `invoiceRoutes`.

## Function: crossForPaymentDay

- **Purpose:** Fill CHF, EUR, and PHP independently from the nearest loaded day on or before the payment day. A quote missing on the payment day comes from an earlier day. A later day is ignored. A quote that is not a positive decimal is skipped.
- **Inputs:** A map of UTC day to optional CHF/EUR/PHP per 1 USD, and the payment `day`.
- **Returns / side effects:** The crosses that could be filled. Missing quotes are omitted. No I/O.
- **Used by:** `invoiceRoutes`.

## Function: quoteFromLargestSibling

- **Purpose:** Scale one stored CHF, EUR, or PHP amount onto another USD amount at the rate of the largest same-day gift. The rate is that gift's quote divided by its USD, rounded half up to integer cents. A zero, missing, or unusable amount is skipped. Equal USD amounts keep the first reference.
- **Inputs:** `amountUsd` text and references `{ usd, quote }`. Both amounts are integer cents (`"5"`, `"5.1"`, `"5.00"`).
- **Returns / side effects:** A two-decimal quote string, or `null` when nothing can scale, including when the rounded cents exceed `Number.MAX_SAFE_INTEGER`. Does not throw. No I/O.
- **Used by:** No production caller. Gift aggregation and `migrateGiftSchema` do not scale one stored amount from another row.

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

## Function: fetchSparkAddressBalance

- **Purpose:** Balance of a Spark address from the public Sparkscan explorer, read anonymously and without ever throwing: `GET https://api.sparkscan.io/v1/address/<address>?network=MAINNET` (`SPARK_EXPLORER_BASE_URL`, the address percent-encoded) with only `accept: application/json`, no `authorization` header and no API key, `redirect: 'error'`, and a 5 s timeout (`SPARK_EXPLORER_TIMEOUT_MS`). It reads `balance.btcSoftBalanceSats`, which includes incoming transfers that are not claimed yet; `btcHardBalanceSats` is not read. The value is information only and can lag behind the wallet.
- **Inputs:** `fetchImpl` (`FetchFn`) and the Spark address (`spark1…`).
- **Returns / side effects:** The soft balance when it is a safe non-negative integer, else `null`: a throw, a timeout, a non-2xx answer (a bad address answers 400 `{"message":"Invalid address: …"}`), a body that is not JSON, or another shape. Each `null` logs `spark_explorer.unavailable` with the HTTP `status` when there was an answer, never the address.
- **Used by:** `meRoutes` `GET /me/previous-wallets`, once per previous wallet in parallel.

## Function: fxRoutes

- **Purpose:** Hono sub-app for public `GET /fx/spot`: the stored BTC price in USD, CHF, EUR, and PHP. It only reads the spot store and never calls the provider.
- **Inputs:** `{ store: FxSpotStore }` (`createApp` passes `fxSpotStore`, default empty `InMemoryFxSpotStore`).
- **Returns / side effects:** Hono app mounted at `/fx`. A stored quote answers 200 `{ asOf, source, rates }` with `Cache-Control: public, max-age=60`. No quote, or a store that throws (logs `fx.spot.read_failed`), answers 200 `{ asOf: null, source: null, rates: {} }` with `Cache-Control: no-store`.
- **Used by:** `createApp`.

## Function: resolveFxSpotUrl

- **Purpose:** Resolve the provider URL for the BTC spot quote from `BTC_FIAT_SPOT_URL`.
- **Inputs:** Process environment slice.
- **Returns / side effects:** The trimmed override, or `https://api.coinbase.com/v2/exchange-rates?currency=BTC` when unset or blank. Pure; the process still boots without the variable.
- **Used by:** Boot (`src/index.ts`) before `startFxSpotWorker`.

## Function: fetchFxSpot

- **Purpose:** Fetch the current price of 1 BTC in USD, CHF, EUR, and PHP from one Coinbase exchange-rates response, without ever throwing.
- **Inputs:** `{ fetchImpl, url, now }`. The body must be `{ data: { currency: "BTC", rates: { … } } }`.
- **Returns / side effects:** `{ asOf, source: 'coinbase-exchange-rates', rates }` with `asOf` from `now`, read when the request starts (so of two overlapping fetches the later request is the newer quote). A currency whose rate is missing, not a decimal string (a JSON number is refused because parsing may have rounded it; no exponent), or not positive is omitted. `null` for a non-ok response, a wrong shape, no usable currency, a thrown fetch, or a fetch that aborts after `BTC_USD_SPOT_TIMEOUT_MS` (10 seconds).
- **Used by:** `runFxSpotTick`.

## Function: runFxSpotTick

- **Purpose:** One refresh of the stored BTC spot quote.
- **Inputs:** `FxSpotWorkerDeps` (`store`, `fetchImpl`, `url`, `now`).
- **Returns / side effects:** `true` once a fetched quote was handed to `store.save`, which may keep a newer stored quote instead (see `PostgresFxSpotStore` for a stored `as_of` in the future). When `fetchFxSpot` returns `null` it logs `fx.spot.fetch_failed`, keeps the stored quote, and returns `false`. A store write failure throws.
- **Used by:** `startFxSpotWorker`.

## Function: startFxSpotWorker

- **Purpose:** Keep the BTC spot quote fresh in the background so `GET /fx/spot` never calls the provider per request.
- **Inputs:** `FxSpotWorkerDeps` and an optional interval (default `FX_SPOT_REFRESH_MS`, 5 minutes).
- **Returns / side effects:** Runs `runFxSpotTick` at once and then every interval; ticks never overlap. A throwing tick logs `fx.spot.tick.failed` and the next interval retries. Returns `{ stop }`, which clears the interval.
- **Used by:** Boot (`src/index.ts`), on every boot (memory and Postgres).

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

- **Purpose:** Adds nullable `fiat_usd`, `fiat_chf`, `fiat_eur`, and `fiat_php` on `gift`, and nullable `kind text`. The migrate does not copy `btc_usd_daily`, `usd_fiat_daily`, sats, or another row onto a null committed amount. Classifying existing rows is `repairGiftKind`, after `trg_db_change` is attached. No HTTP. `'other'` is not a database value.
- **Inputs:** `SqlClient`.
- **Returns / side effects:** Void; idempotent DDL. Does not UPDATE a fiat column. Does not UPDATE `kind`.
- **Used by:** `openBootStores` when SQL opens.

## Function: repairGiftKind

- **Purpose:** Classifies `gift.kind` where it is still null, then adds `gift_kind_check` if absent and sets the column NOT NULL. Skips the whole repair when `trg_db_change` is not yet attached to `gift`, so the UPDATEs are audited and the next boot retries.
- **Inputs:** `SqlClient`.
- **Returns / side effects:** Void. `description = '21gifts moderator'` becomes `moderator`. Remaining null rows are matched one-to-one only to platform replies whose trimmed text is `Welcome` or `21gifts daily` (same sats, lightning local-part, within 3 seconds); only an assigned `Welcome` becomes `welcome`. That assignment and every other still-null row are one `UPDATE` (`'{id,…}'` bound as `bigint[]`, because the driver rejects a JavaScript array). A stopped boot therefore cannot attach the same Welcome reply to a different still-null gift. The check allows only `daily`, `welcome`, and `moderator`, and it is recognized only as a check constraint on `gift` (`conrelid = 'gift'::regclass` and `contype = 'c'`).
- **Used by:** `openBootStores` immediately after `migrateDbChangeSchema`.

## Function: migrateMessageSchema

- **Purpose:** Applies `MESSAGE_SCHEMA_SQL` in order (`CREATE TABLE IF NOT EXISTS message` with nullable `photo`/`photo_content_type`, newest-first index, additive `ALTER … ADD COLUMN IF NOT EXISTS` for existing databases including `video_content_type` (MIME in Postgres; video bytes on disk under `MEDIA_DIR`, not bytea), `parent_id uuid REFERENCES message (id)`, `author_pubkey text`, then `ALTER TABLE message ALTER COLUMN account_id DROP NOT NULL` and immediately `CREATE INDEX IF NOT EXISTS message_parent_id_idx ON message (parent_id, created_at ASC, id ASC)`). Later, immediately after `CREATE TABLE message_extra_photo`, an additive `goal_sats bigint` (nullable; SQL null means no ask), then `photo_taken_at text` and `video_taken_at text` on `message` (civil time, not timestamptz) and `photo_taken_at text` on `message_extra_photo`, then `place_lat double precision`, `place_lng double precision`, and `place_label text`, then nullable `goal_currency` (null or BTC/USD/CHF/EUR/PHP), `goal_amount numeric(20, 8)`, and `goal_fiat_usd` / `goal_fiat_chf` / `goal_fiat_eur` / `goal_fiat_php numeric(20, 2)` (null when there is no currency ask; not backfilled), then nullable `goal_repayable boolean`, nullable `goal_term_days integer`, and nullable `goal_funded_at timestamptz`. The `recorded_at` column on `nostr_zap_receipt` is added with the other receipt columns, but an already full repayable ask is stamped `goal_funded_at = now()` immediately after that column is added, and the backfill that sets a null `recorded_at` to `COALESCE(message.goal_funded_at, now())` runs only after that stamp, and then `message_repayment` is created, with checks `goal_repayable IS NOT TRUE OR (parent_id IS NULL AND goal_sats IS NOT NULL)` and `goal_term_days IS NULL OR (goal_repayable IS TRUE AND goal_term_days BETWEEN 1 AND 3650)`, then the feed indexes `message_feed_created_idx` and `message_feed_popular_idx`, then `message_external_author_idx` on `(lower(author_pubkey), created_at DESC, id DESC)` where `account_id` is null, `deleted_at` is null, and `author_pubkey` is present (after `deleted_at` exists), then `TRANSLATION_SCHEMA_SQL` (`CREATE TABLE IF NOT EXISTS message_translation`), and only then the last unwrap `DO $unwrap$`. It next creates `nostr_zap_receipt`, additively adds `payer_account_id`, `payer_pubkey`, `zap_request_id`, `gift_reply_id`, and `comment`, and creates partial unique indexes including `nostr_zap_receipt_request_uidx` on non-null `zap_request_id`; this is followed by `nostr_zapper`, `nostr_blocked_pubkey`, and `nostr_zap_payment`, then `message_invoice` and `nostr_zap_ingest` without FKs plus `ALTER TABLE message_invoice ADD COLUMN IF NOT EXISTS lnurl_response jsonb`, `conversation_id uuid`, `conversation_message_id uuid`, `fiat_pinned boolean NOT NULL DEFAULT false`, and `fiat_usd`, `fiat_chf`, `fiat_eur`, `fiat_php` numeric(20, 2), and their `created_at`/`message_id` and `receipt_id` indexes. After `message` exists, adds `account_profile_message_id_fkey` (`ON DELETE SET NULL`) and unique partial index `account_profile_message_uidx`, then soft-hide columns `deleted_at timestamptz` and `deleted_by uuid`. Then additive `content_fp text`, `DROP INDEX IF EXISTS` on `message_live_top_content_fp_uidx` and `message_live_reply_content_fp_uidx` before the photo-only backfill via `digest(photo, 'sha256')` (`video_content_type` IS NULL), salt of extra live duplicates (`content_fp || ':' || message.id`), and recreation of those partial unique indexes (live rows with non-null account + fingerprint). The partial index `message_nostr_event_unrepaired_idx` supports the boot repair's predicate so a converged table can be confirmed without a sequential scan. On every boot, the array also runs an idempotent repair unwrapping `nostr_event` values stored as jsonb string scalars (`jsonb_typeof(nostr_event) = 'string'`), which matches no rows once complete. It is skipped while the `db_change` audit trigger is not attached and retried on the next boot; a row whose value cannot be parsed is skipped with a warning instead of failing the migration. Successfully repaired rows have `nostr_attempts` cleared for a fresh repair budget. After the unwrap `DO $unwrap$` (that block stays only in `MESSAGE_SCHEMA_SQL`), `CREATE TABLE message_edit` and its index are followed by `first_post_free` and its unique index, then `ALTER TABLE message_invoice ADD COLUMN IF NOT EXISTS heart boolean NOT NULL DEFAULT false`. The last statements in `MESSAGE_SCHEMA_SQL` are the additive `place_street`, `place_house_number`, `place_postal_code`, `place_city`, and `place_country` columns and the check `message_place_address_chk` (all five null or all five non-null), appended after the heart column. The statements are mirrored in `docs/schema/message.sql`. It also adds nullable `fiat_usd`, `fiat_chf`, `fiat_eur`, and `fiat_php` on `message` and `nostr_zap_ingest`. The migrate does not copy a daily close onto a null committed amount.
- **Payment hash lookups:** The statement immediately before the heart column creates the partial index `message_invoice_ok_payment_hash_idx` on `message_invoice (payment_hash, created_at DESC, id DESC) WHERE result = 'ok'`, which serves `findOkInvoiceByPaymentHash` when a wallet report classifies every payment by its hash.
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

- **Purpose:** Applies `CONVERSATION_SCHEMA_SQL` in order (`conversation` + `conversation_message` + `conversation_read` tables and unique indexes, including `conversation_read_conversation_id_idx`). CREATE CHECK includes `moderator_group`; ALTER DROP/ADD `conversation_kind_check`; unique partial index `conversation_moderator_group_uidx`. Additive `ALTER TABLE conversation_message ADD COLUMN IF NOT EXISTS sats bigint NOT NULL DEFAULT 0`, `actor_account_id uuid REFERENCES account (id)`, and `actor_name text NOT NULL DEFAULT ''` (logged-in staff on a platform send; sender stays the platform account), and `gift_for_message_id uuid` (no foreign key; id of the group message a paid moderator stipend belongs to). Additive `ALTER TABLE conversation_message ADD COLUMN IF NOT EXISTS mentions jsonb NOT NULL DEFAULT '[]'::jsonb` (profile marks on an inbox or moderator-room message; empty when the text marks nobody; not a notification). Additive `ALTER TABLE conversation_message ADD COLUMN IF NOT EXISTS photo bytea` and `photo_content_type text`, then `CREATE TABLE IF NOT EXISTS conversation_message_extra_photo` (idx 1–9, ON DELETE CASCADE). Then `CREATE TABLE IF NOT EXISTS conversation_message_translation` (PK `(message_id, target_lang)`, FK `conversation_message(id)` ON DELETE CASCADE). Unwrap `DO` block is followed by a last stipend-repair `DO` that backfills `gift_for_message_id` on `moderator_group` house stipend rows written before the column existed (idempotent; links a row only when exactly one message of someone else precedes it within five minutes, leaves an ambiguous row `NULL` without writing it, and never touches a row that already has the column set; skipped until the `db_change` audit trigger is attached; the partial index `conversation_message_gift_unlinked_idx` keeps its per-boot check off a sequential scan). The partial index `conversation_message_nostr_event_unrepaired_idx` supports the nostr-event boot repair's predicate so a converged table can be confirmed without a sequential scan. On every boot, the array runs an idempotent repair unwrapping `conversation_message.nostr_event` values stored as jsonb string scalars (`jsonb_typeof(nostr_event) = 'string'`); it matches no rows once complete. The unwrap is skipped while the `db_change` audit trigger is not attached and retried on the next boot; a row whose value cannot be parsed is skipped with a warning instead of failing the migration. `db_change` attach runs later and covers the new public tables.
- **Inputs:** `SqlClient`.
- **Returns / side effects:** Void; idempotent SQL execute; `docs/schema/conversation.sql` mirrors the DDL and documents the boot repair statements by comment (the `DO $unwrap$` and stipend-repair `DO` blocks live only in `CONVERSATION_SCHEMA_SQL`). The migrate adds the fiat columns and does not copy `btc_usd_daily` or `usd_fiat_daily` onto a null `conversation_message` amount. No HTTP. Idempotent.
- **Used by:** `openBootStores` when SQL opens, after `migrateContactSchema` and before `migrateDbChangeSchema`.

## Function: migratePushSchema

- **Purpose:** Applies `PUSH_SCHEMA_SQL` in order: `CREATE TABLE IF NOT EXISTS push_subscription` and its account index, `ALTER TABLE push_subscription ADD COLUMN IF NOT EXISTS session_token text` (null on rows stored before it; those rows are never sent to and the sweep deletes them), `CREATE TABLE IF NOT EXISTS push_outbox` (with `delivered_endpoints`, `skip_endpoints text NOT NULL DEFAULT '[]'`, and `type` CHECK `('forum', 'zap', 'conversation', 'dismiss')`) and its pending index, `ALTER TABLE … ADD COLUMN IF NOT EXISTS delivered_endpoints`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS skip_endpoints`, `ALTER TABLE push_outbox ADD COLUMN IF NOT EXISTS finished_at timestamptz` (null on rows finished before it; retention ages them from `created_at`), then an idempotent `DO` that drops/adds `push_outbox_type_check` so live CHECKs accept `'conversation'` and `'dismiss'`).
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
- **Returns / side effects:** Statement texts only; executed by `migrateDbChangeSchema`. Secrets `token`, `challenge`, `nostr_nsec_ciphertext`, `nonce`, `view_key`, `endpoint`, `p256dh`, `auth`, `delivered_endpoints`, `skip_endpoints`, `session_token`, and `recovery_share_ciphertext` become SHA-256 hex in logged JSON; other columns including `name` stay plaintext except unchanged bytea columns on UPDATE. The guard `DO` hashes JSON `view_key` that still equals a live `account.view_key` and leaves other rows unchanged.
- **Used by:** `migrateDbChangeSchema`; documented mirror in `docs/schema/db_change.sql`.

## Function: InMemoryBtcUsdStore

- **Purpose:** In-memory `BtcUsdRateBook` seeded at construction; never HTTP.
- **Inputs:** Optional `ReadonlyMap` or `Record` of day → rate. `ensureDays(days, nowMs)` returns the seed subset for valid requested days. `listDebug(limit)` dumps seeded `{ day, usdPerBtc, source: null, fetchedAt: null }` newest day first.
- **Returns / side effects:** Map of available rates; missing days omitted. No network.
- **Used by:** `createApp` / `giftsStatsRoutes` defaults; memory `openBootStores`.

## Function: migrateFxSpotSchema

- **Purpose:** Applies `BTC_FIAT_SPOT_SCHEMA_SQL` (`CREATE TABLE IF NOT EXISTS btc_fiat_spot`, one row with `id = 1`).
- **Inputs:** `SqlClient`.
- **Returns / side effects:** Void; idempotent DDL execute matching `docs/schema/btc_fiat_spot.sql`.
- **Used by:** `openBootStores` when SQL opens, after `migrateFiatSchema` and before `migrateDbChangeSchema`, so `trg_db_change` attaches.

## Function: InMemoryFxSpotStore

- **Purpose:** In-memory `FxSpotStore` for memory boots and tests; the quote is lost on restart.
- **Inputs:** Optional seed `FxSpotQuote`.
- **Returns / side effects:** `latest()` returns a copy of the saved quote or `null`; `save(quote)` replaces it unless the stored quote has a later `asOf`. Only `USD`, `CHF`, `EUR`, and `PHP` are kept. No HTTP.
- **Used by:** `createApp` default, `openBootStores` when `DATABASE_URL` is unset, tests.

## Function: PostgresFxSpotStore

- **Purpose:** Durable `FxSpotStore` on the single `btc_fiat_spot` row, so a restart or a provider outage still serves the last good quote with its `asOf`.
- **Inputs:** `SqlClient`.
- **Returns / side effects:** `save(quote)` upserts row `id = 1` with every currency (a missing one becomes `NULL`), `source`, and `as_of`, only when the stored `as_of` is not later (a delayed write from another replica never replaces a newer quote) or lies in the future of the database clock (a replica with a fast clock cannot block newer quotes). `trg_db_change` logs an INSERT for the first quote and an UPDATE for each later refresh. `latest()` reads `numeric::text`, so the provider's decimal value comes back with its fractional digits; a missing row or a row without any rate is `null`.
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

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

- **Shop methods:** `countShopsByAccount` is the uncapped live shop count using assigned shop-account ownership first and author ownership when unassigned; `listShopsByAccount` is the corresponding newest-first capped list with attributed `replyCount`; `countShopsByPubkey` is the uncapped live unassigned external-shop count for a case-insensitive pubkey; `listShopsByPubkey` is its newest-first capped list with attributed `replyCount`.
- **Credit methods:** `countCreditsByAccount` is the uncapped live credit count (`goalRepayable` exactly true) owned by the author via `account_id` (no hashtag, no `shop_account_id`); `listCreditsByAccount` is the corresponding newest-first capped list with attributed `replyCount`; `countCreditsByPubkey` is the uncapped live external-credit count for a case-insensitive pubkey (`account_id` null, no hashtag, no `shop_account_id`); `listCreditsByPubkey` is its newest-first capped list with attributed `replyCount`. Empty SQL maps to 0.

- **Purpose:** Durable `MessageStore` over Postgres (`message` table plus `message_invoice` and `nostr_zap_ingest`). Nullable `goal_sats` (optional whole-sat ask; SQL null means no goal), nullable `goal_repayable` (`true` or SQL null, never false), and nullable `goal_term_days` (a whole number from 1 to 3650, or SQL null), plus nullable `goal_currency`, `goal_amount`, and `goal_fiat_usd` / `goal_fiat_chf` / `goal_fiat_eur` / `goal_fiat_php` (null on a reply and on a legacy sats-only ask). `addSats` / `addReceivedSats` / `recordZapReceipt` leave a fiat column unchanged when extra sats are 0 or that delta is null, assign a non-null delta onto a null column, and add when both sides are set. `addReceivedSats` folds `received_sats` / `received_fiat_*` and does not change `sats`, `fiat_*`, or `goal_funded_at`. `recordZapReceipt` credits a reply onto `received_*` (join on `message_id`, never `gift_reply_id`) and a top-level note onto `sats` / `fiat_*` / `goal_funded_at`. The boot repair moves `nostr_zap_receipt` sums off reply `sats` onto `received_sats`; it does not read `message_invoice`, so historical spend-proof credits that never became a `nostr_zap_receipt` stay inside reply `sats`. Nullable `place_lat` / `place_lng` / `place_label` (both coordinates or neither; a reply stores null coordinates) and nullable `place_street` / `place_house_number` / `place_postal_code` / `place_city` / `place_country` (all-or-nothing; `address` on the pin). `listPlaces` returns live top-level rows that have both coordinates, newest first, including `address`. `listLiveAssignedShops` returns live top-level rows (`parent_id` null, `deleted_at` null) with `shop_account_id` set, and does not filter the shop hashtag. Nullable place columns are selected with the other message columns and inserted on both `create` INSERT shapes (top-level `VALUES` and reply `INSERT … SELECT … WHERE EXISTS`); a non-null `parentId` binds `goal_sats`, `goal_repayable`, and `goal_term_days` SQL null even if the row carried a positive `goalSats`, `goalRepayable` true, or a term; `mapMessageRow` maps it to `goalSats` (`null` when SQL null). `deleteById` removes zap receipts, invoices, child replies, and the row in **one** parameterised data-modifying CTE `query`, then unlinks on-disk videos from the returned rows. `markDeleted` soft-hides via a single UPDATE CTE (`deleted_at` / `deleted_by` on the untagged target and untagged direct replies; never `DELETE FROM message`). `markUndeleted` unhides via a single UPDATE CTE (clears `deleted_at` / `deleted_by` on the hidden target and stamp-matched direct replies; already-live target is a no-op for children; never `DELETE FROM message`). Live-only lists/claims require `deleted_at IS NULL`: `listLatest` is **top-level only** (`WHERE parent_id IS NULL AND deleted_at IS NULL`) with subquery `replyCount` (live attributed direct children, `(child.account_id IS NOT NULL OR (child.author_pubkey IS NOT NULL AND EXISTS (SELECT 1 FROM nostr_zapper z WHERE z.pubkey = lower(child.author_pubkey))))`), selecting Nostr columns plus `(photo IS NOT NULL) AS has_photo`, `deleted_at`, `deleted_by`, and never the `photo` bytea column (HTTP window newest-first; product UX is a messenger group — clients reverse); `listFeed` is the GET `/messages` keyset page (`mode` all/active/unpaid/popular, exclusive cursor, optional `hashtag` token filter on `text`, cap 1–200, same live `replyCount`; WHERE also has the name-copy NOT EXISTS (no photo, no video content type, no extra still, non-empty trim, case-insensitive equality with account.name or message.name), not every profile note; a real About me stays; `active` is paid rows (`sats > 0`) or staff unpaid rows; a positive `goal_sats` with `sats = 0` is not active; `popular` is sats-desc); `listReplies` is oldest-first attributed children (`WHERE parent_id = $1` plus the account-or-zapper predicate; `deleted_at IS NULL` unless `includeHidden === true`); `listRecentReplies(limit)` (newest live replies that have a non-empty event id, even when the parent is outside listLatest; no zapper filter; copies; no photo bytes); `listChildIds` is `SELECT id FROM message WHERE parent_id = $1` (any `deleted_at`); `listDebug` is operator newest-first **all** rows (`SELECT … FROM message ORDER BY created_at DESC, id DESC LIMIT $1`, no `deleted_at` / `parent_id` filter; never `photo` bytea); `postCountsByUtcDay` groups living rows (`deleted_at IS NULL`) by UTC day, notes and replies together (no `parent_id` filter), omits days with no rows, and returns no media bytes; `listHidden` is staff newest-hidden-first **soft-hidden** rows (`SELECT … FROM message WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC LIMIT $1`; never `photo` bytea); `listDirectChildren` is every direct child including hidden (`SELECT … FROM message WHERE parent_id = $1 ORDER BY created_at ASC, id ASC`); `listPublishedEventIds` returns non-null live top-level `event_id`s newest-first for inbound reply REQ; `findLiveByAccountContent` returns the oldest live row for account+parent+`content_fp`; `accountHasLiveTopLevelPost` (`parent_id IS NULL`, exclude profile id, replies do not count); `accountHasLiveTopLevelMediaPost` (same live/top-level/exclude plus photo 0, extra stills, or video); `latestLiveTopLevelMediaId` (newest live top-level photo or video id, including About me, `ORDER BY created_at DESC, id DESC LIMIT 1`; an empty id is null); `countByAccount` is one `COUNT(*) FILTER` query of live posts (`parent_id IS NULL`) vs replies (`parent_id IS NOT NULL`) for `account_id = $1` and `deleted_at IS NULL` (uncapped; not derived from a list); `countByPubkey` is one `COUNT(*) FILTER` query for `account_id IS NULL`, `deleted_at IS NULL`, `author_pubkey IS NOT NULL`, and `lower(author_pubkey) = $1` (posts always; replies only when `EXISTS (SELECT 1 FROM nostr_zapper z WHERE z.pubkey = $1)`, else 0); `countAttributedReplies(parentId)` is that uncapped count of live direct children with an account or a recorded zapper pubkey (0 when the id is unknown); `listPostsByAccount` is newest-first live top-level notes for one account (`WHERE parent_id IS NULL AND deleted_at IS NULL AND account_id = $1`, `LIMIT`, subquery `replyCount` of live direct children matching `(child.account_id IS NOT NULL OR (child.author_pubkey IS NOT NULL AND EXISTS (SELECT 1 FROM nostr_zapper z WHERE z.pubkey = lower(child.author_pubkey))))`); `listRepliesByAccount` is newest-first live replies for one account (`WHERE parent_id IS NOT NULL AND deleted_at IS NULL AND account_id = $1`, `LIMIT`, no `replyCount`); `listPostsByPubkey` is the same shape as `listPostsByAccount` for an external pubkey (`account_id IS NULL`, `author_pubkey IS NOT NULL`, `lower(author_pubkey) = $1`, same child `replyCount` subquery); `listRepliesByPubkey` is newest-first live replies for that pubkey and returns no rows unless `EXISTS (SELECT 1 FROM nostr_zapper z WHERE z.pubkey = $1)` (no `replyCount`); `create(row, photo?, video?, extraPhotos?)` inserts optional photo bytes, optional extra stills into `message_extra_photo` (indices 1..n max 9, ignored when `video` is set, require photo 0 when non-empty), optional `video_content_type` (disk write via `writeForumVideo`; `removeForumVideo` unlink on INSERT failure), and `content_fp` when media is present and `account_id` is not null; `photoCount` is (photo 0 ? 1 : 0) + extras length; a non-null `parent_id` requires a live parent (`deleted_at` null) via `INSERT … SELECT … WHERE EXISTS`; a 0-row insert calls `getById` and returns that row when the id already exists (gift-reply retry after the parent was later deleted), otherwise throws without inserting; on unique violation `23505` it returns the existing row when `getById` matches the inserted id (no video unlink; gift-reply retry), otherwise unlinks the new video and returns the existing live row from `findLiveByAccountContent` when the pin matches; a different pin throws `place conflicts with live media` (the route maps that to 409); `getPhoto` loads bytes by id; `getExtraPhoto(id, index)` / `listExtraPhotos(id)` load extras from `message_extra_photo`; `getById` / `getByEventId` still return soft-hidden rows; `listIdsByPrefix(prefix)` returns at most two stored ids whose lowercase text starts with the prefix (prefix lowercased, not trimmed), including soft-hidden rows, `SELECT id::text AS id … WHERE lower(id::text) LIKE $1 || '%' LIMIT 2`, never photo bytes; `claimUnsigned`/`claimUnpublished` lease live rows (`deleted_at IS NULL`; `claimed_until <= now` is expired; unsigned requires `pending` + null `event_id`); `listPendingSigned` returns live pending rows whose kind:1 lacks `t=bitcoin` (`created_at ASC, id ASC`); `clearSignedEvent` nulls `event_id` / `nostr_event` / `claimed_until` only while `pending` and `event_id` still matches the listed id and no child reply exists (`NOT EXISTS`); `listSignedMissingPhoto` returns published **top-level** live rows (`parent_id IS NULL`, `deleted_at IS NULL`) with a photo whose kind:1 content lacks `/messages/:id/photo.` plus an image extension (`sats = 0`, `nostr_attempts < MAX_PUBLISH_ATTEMPTS` (5, preventing a row that can never satisfy a repair scan from being reset forever), pending excluded so fan-out is not starved, video rows / `video_content_type` excluded so posters are not treated as missing photos, parents with children skipped via `NOT EXISTS`, `created_at ASC, id ASC`); `listSignedMissingVideo` returns published **top-level** live rows (`parent_id IS NULL`, `deleted_at IS NULL`) with `video_content_type` set whose kind:1 content lacks `/messages/:id/video.` (`sats = 0`, `nostr_attempts < MAX_PUBLISH_ATTEMPTS` (5, preventing a row that can never satisfy a repair scan from being reset forever), pending excluded, parents with children skipped via `NOT EXISTS`, `created_at ASC, id ASC`); `listSignedMissingHashtags` returns published unpaid **top-level** live rows (`parent_id IS NULL`, `deleted_at IS NULL`, parents with children skipped via `NOT EXISTS`) whose kind:1 content lacks a `#bitcoin` or `#21gifts` token (next character must not be `[A-Za-z0-9_]`; `sats = 0`, `nostr_attempts < MAX_PUBLISH_ATTEMPTS` (5, preventing a row that can never satisfy a repair scan from being reset forever), pending excluded so fan-out is not starved, includes null / non-string content, `created_at ASC, id ASC`; optional extras map lists rows whose kind:1 also lacks that account's location token; one-arg still bitcoin/21gifts only; optional `excludeIds` applied before the limit so profile notes cannot fill the batch); `resetSignedEvent` nulls `event_id` / `nostr_event` / `claimed_until`, parks `pending`, clears the epoch, increments `nostr_attempts`, and stamps `nostr_first_attempt_at` once, only when `event_id` still matches, `sats` is 0, and no child reply exists (`NOT EXISTS`); `updateSignedEvent` (false on `event_id` collision); `updatePublishState`; `addSats`; `recordZapReceipt` (one statement: `INSERT nostr_zap_receipt ON CONFLICT DO NOTHING` plus `UPDATE` of `received_*` when `parent_id` is set, else `sats` / `fiat_*` / `goal_funded_at`; join on `message_id`); `recordInvoiceAttempt` / `listInvoiceAttempts` (each attempt includes `lnurlResponse`: raw LNURL callback JSON object or null); `listRecentOkInvoiceAttempts` (`result = 'ok'` and `created_at >= $1`, same `ORDER BY created_at DESC, id DESC` and `LIMIT` as `listInvoiceAttempts`); `findOkInvoiceByPaymentHash` / `findOkInvoiceByPr` / `findOkInvoiceByDescription` (newest `result = 'ok'` row; description is one message plus the stored invoice description); `listCreditPayers` (positive zap sats per 21.gifts payer; external payers omitted); `sumUnassignedCreditSats` (sats with no payer account); `listRepayments` and `markRepaymentPaid` (table `message_repayment`; a repeat of the same day and giver is a no-op and does not change `message.sats`); `listLoanLedger` (one `UNION ALL`: identified payer receipts on `goal_repayable` notes that count toward the credit, anonymous receipts excluded, paid `message_repayment` rows with no freeze, each row sets `owed` when the account authored the note and `credit` when the account paid or receives the repayment, both flags may be true on one row, caller sorts); `addSats` and `recordZapReceipt` set `goal_funded_at` once, when a repayable ask with `goal_sats` first reaches that ask, and the schema stamps `goal_funded_at = now()` on an ask that is already full when the column is added; `listOpenConversationZapEventIds` (returns `{ eventId, conversationMessageId }[]`, one row per ok invoice so the same event id may repeat; SQL requires non-null `conversation_id` and `conversation_message_id` and `NOT EXISTS` on `conversation_message`); `updateZapReceiptGift` (`UPDATE nostr_zap_receipt` payer / gift-reply / `comment` columns; omitted patch fields are left unchanged; missing event id is a no-op); `getZapReceiptGift` (one receipt by `event_id`); `listZapReceiptsAwaitingGiftReply` (`(payer_account_id IS NOT NULL OR payer_pubkey IS NOT NULL) AND gift_reply_id IS NULL`, `ORDER BY event_id ASC`, includes `comment`); `recordZapIngest` / `listZapIngests`; `listInvoiceAttemptsForPayer` (uncapped `WHERE payer_account_id = $1`, newest-first); `listIndexedZapIngests` (uncapped `WHERE outcome = 'indexed'`); `updateText` without a history row is `UPDATE message SET text = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING` the message columns (sats / photos / event ids unchanged; a missing or hidden id → no row); with a history row the statement locks the living row (`WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`), updates the text only when it differs, inserts `message_edit` only then, and returns only `id` (`SELECT id FROM locked`). When `SqlClient.transaction` is present, `updateText` first locks the living row with `SELECT text, place_lat, place_lng, place_label, place_street, place_house_number, place_postal_code, place_city, place_country FROM message WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, with or without `edit`. A complete pin whose new text fails `shopTextProblem` returns that error and runs no `UPDATE`. The history statement still selects only `id, text` and does not read the pin. Without `edit`, the row comes from `UPDATE … RETURNING` and `getById` is not called. With `edit` and a found id, and when `transaction` is present, the fresh row is read with `SELECT` on the same transaction. Without `transaction`, the pair rule is not applied; with `edit` and a found id, `getById` reads the fresh row, and a missing id returns undefined and does not call `getById`. `setPlace` writes the pin only where `deleted_at IS NULL`, and when `transaction` is present it locks the living text first and returns the description error when the new pin is complete and that text fails `shopTextProblem`, otherwise reporting existence only (`RETURNING id` without a history row; `SELECT id` after the write when a history row is requested) and not returning message columns. `setShopAccount` writes `shop_account_id` only where `deleted_at IS NULL` (the same existence report, with `deleted_at IS NULL` on the locked CTE), has no pair check, and does not return message columns; `appendEdit` inserts one `message_edit` row and does not change the message; `listEdits` returns that message's rows newest `created_at`, then `id`; `replacePhotos` replaces stills in one data-modifying CTE (primary photo update returning only `id`, video columns untouched, up to nine extra upserts with null bytea slots skipped, then delete extras whose `idx` is above the new count minus one) and, because that statement cannot see its own update, calls `getById` only when that id came back; `create` binds `shop_account_id` on both INSERT shapes and binds null for a reply; `listAuthoredMessages` (`WHERE account_id = $1`, including hidden, no LIMIT). `mapMessageRow` maps a set `shop_account_id` to `shopAccount` even when the joined username is null or blank (`username` is then `null`, so the shop stays listed and only the pay fields need the username). `mapMessageRow` keeps `nostr_publish_state` `skipped` (gift-only replies).- **External-zapper storage:** `nostr_zap_receipt` adds nullable `payer_pubkey text` and `zap_request_id text`, with partial unique index `nostr_zap_receipt_request_uidx` on `zap_request_id WHERE zap_request_id IS NOT NULL`. `nostr_zapper` stores durable visibility entitlement as `pubkey` (primary key), `receipt_event_id`, and `created_at`; it is independent of receipt queue state and is not cleared by `deleteById`. `nostr_blocked_pubkey` is the staff kill-switch table with `pubkey` (primary key), `blocked_at`, `blocked_by`, and `message_id`.
- **Bulk read:** `getByIds(ids)` reads the rows of several ids in one statement (`WHERE id = ANY($1::uuid[])`, the ids as one array-literal string), with the same column list and mapping as `getById`; an empty list sends no query, missing ids are left out and the order is not defined. `listShopNip05Entries` uses it to read every shop note at once.
- **Photo types:** `getPhotoContentTypes(id)` reads the content type of photo 0 (`message.photo_content_type`) and of the extra stills (`message_extra_photo`, `idx` ascending) in one `UNION ALL` statement that selects no `bytea` column (`photo IS NOT NULL` only checks for null); a null photo or an unrecognized type is left out, as in `getPhoto` / `listExtraPhotos`. Returns `{ photo, extras }` with `extras` as `{ index, contentType }` and `index` the stored `idx` (1–9), so a left-out still never shifts the ones after it (`photo` null and `extras` empty when there is none). The shop kind 0 uses it for its `picture` (photo 0) and `banner` (the extra with `index` 1) URLs, so a pass never loads photo bytes.
- **Photo set:** `getPhotoSet(id)` reads photo 0 (`message.photo`, `photo_content_type`, `photo_taken_at`) and the extra stills (`message_extra_photo`, `idx` ascending) with their bytes in one `UNION ALL` statement, so the set comes from one snapshot and a concurrent `replacePhotos` (which swaps photo 0 and the extras in one transaction) is seen completely or not at all; a null photo, a null type or an unrecognized type is left out, as in `getPhoto` / `listExtraPhotos`. Returns `{ photo, extras }` with `extras` as `{ index, photo }` and `index` the stored `idx` (1–9), so a left-out still never shifts the ones after it (`photo` null and `extras` empty when there is none). Used by `GET /shops/:npub` (`shopRoutes`), the OpenCryptoPay photo push (`runOcpPhotoOutboxPass`) and the photo fingerprint of an `InMemoryShopIdentityStore` built over a message store that is not an `InMemoryMessageStore` (over an `InMemoryMessageStore` it uses `photoRevision` and reads no bytes).
- **External-zapper methods:** `attributeZapReceipt(receiptEventId, { payerPubkey, zapRequestId, comment })` lowercases and stores the payer pubkey, request id, and comment only when the receipt exists, its current request id is null or the same id, and a `NOT EXISTS` check finds no other receipt with that request id. A retry with the same request id on the same receipt is idempotent `true`; a different request id on an already-attributed receipt, reuse by another receipt, or a concurrent partial-index unique violation returns `false`. `recordZapper(pubkey, receiptEventId, at)` lowercases and inserts an entitlement with `ON CONFLICT (pubkey) DO NOTHING`; `listZapperPubkeys()` returns every entitled pubkey; `listZappers(limit)` returns entitlement rows by `created_at DESC, pubkey DESC`. `blockPubkeyAndHideRows(pubkey, at, byAccountId, messageId)` performs that insert-or-skip and case-insensitively updates every live null-account row from the pubkey in one data-modifying CTE query, returning the number hidden; `unblockPubkeyByMessage(messageId)` deletes block rows with that `message_id` and reports whether any row was deleted; `isPubkeyBlocked(pubkey)` lowercases its input and performs a single-row `SELECT 1` lookup; `isZapperPubkey(pubkey)` lowercases its input and performs a single-row `SELECT 1 FROM nostr_zapper` lookup; `listBlockedPubkeys()` returns every blocked pubkey; `listBlockedPubkeyRows(limit)` returns block rows by `blocked_at DESC, pubkey DESC`. `listUnattributedIndexedReceipts(limit, before?)` joins each otherwise-unattributed receipt to its newest indexed `nostr_zap_ingest` frame (`payer_account_id`, `payer_pubkey`, `zap_request_id`, and `gift_reply_id` all null), orders by immutable ingest `created_at DESC, event_id DESC`, and applies an optional strict `{ createdAt, eventId }` keyset cursor. Unlike an `OFFSET` over a result set whose membership changes as receipts are attributed, the cursor cannot skip or repeat rows for that reason.
- **Payment claims:** `claimZapPayment` inserts into `nostr_zap_payment` with `ON CONFLICT (payment_hash) DO NOTHING` and then compares the stored `receipt_event_id`: a new row or the same owner returns `true`, another owner `false`. The table has no foreign key to `message` and is not part of the `deleteById` statement, so the claim outlives the forum row. Insert and lookup failures propagate. `zapPaymentReceiptId` reads the owning receipt id of a lowercased payment hash without claiming it (`undefined` when unclaimed).
- **Credit hard delete:** `deleteById` locks the target row (`SELECT … FOR UPDATE`) and removes nothing when it is a credit note (`goal_repayable IS TRUE`) with `sats > 0`, checked after the lock so a payment that commits first wins; it returns `false` and its invoices, zap receipts, replies, and media stay. Forum reads that drop a note with a missing video then read the row again and serve it only while it is live.
- **Free first post:** `accountHasTopLevelPost(accountId, excludeId)` selects any top-level `message` row of the account other than `excludeId`, with no `deleted_at` filter (hidden rows count). `createFirstPost(row, excludeId)` is one `INSERT … SELECT … WHERE NOT EXISTS (…) ON CONFLICT DO NOTHING RETURNING id` that stores `first_post_free = true`. The partial unique index `message_first_post_free_uidx` on `account_id` (where `first_post_free` is true) makes a concurrent second first post wait for the first and then insert nothing, so it returns `undefined`. A reply or a row without `accountId` throws `first post must be a top-level note of an account` before any SQL.
- **Backfill interaction:** The schema backfill clears `nostr_attempts` only for rows whose double-encoded `nostr_event` it successfully unwraps, because that repair removes the root cause and grants a fresh repair budget; successful publishing does not clear the cap.
- **Inputs:** Constructor takes a shared boot `SqlClient` (already migrated). Operator dump: `listExtraPhotoMeta(limit)`, `listZapReceipts(limit)`, and `listZapPayments(limit)` newest-first (cap 200). `countAttributedReplies(parentId)` is that uncapped count of live direct children with an account or a recorded zapper pubkey (0 when the id is unknown).
- **Returns / side effects:** Parameter-bound SQL; maps snake_case rows to `MessageRow` / `ForumPhoto` / invoice and ingest rows. Claim uses `FOR UPDATE SKIP LOCKED`. Errors propagate to the route (503) except invoice/ingest persist failures which are caught by callers.
- **Used by:** `openBootStores` when `DATABASE_URL` is set.
- **Welcome gift:** `accountHasWelcomeGift(accountId, platformAccountId)` is true when a platform reply whose trimmed text is `Welcome` exists under one of the account's notes, live or soft-hidden. One `SELECT … FROM message reply JOIN message parent` query (`reply.account_id = $2`, `parent.account_id = $1`, `trim(reply.text) = 'Welcome'`, no `deleted_at` filter). Used by the welcome ping and the spend invoice routes so the welcome gift is paid once per account.
- **Shop identity:** Row reads select `shop_identity.nostr_pubkey` as `shopNpub` (npub-encoded); `listPlaces` returns it only for a listed shop (`isListedShop` in code). `create` writes the note, its mentions and its extra photos in one data-modifying CTE (photo rows insert from the note insert's `RETURNING`), so a failed statement leaves nothing a concurrent key backfill could see. With `SqlClient.transaction`, `deleteById` locks the note, checks the credit rule and then `shop_identity` in their own statements and deletes nothing when a key exists; without it, one CTE with the same checks runs.

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

## Function: SetUsernameResult

- **Purpose:** Discriminated union returned by `AuthStore.setUsername`: `{ ok: true, previous }` with the username the write replaced (`null` when none was set), or `{ ok: false, reason }` with `'frozen'`, `'taken'`, or `'missing'`.
- **Inputs:** None. Result type of the atomic username write.
- **Returns / side effects:** Type only. No I/O.
- **Used by:** `InMemoryAuthStore.setUsername`, `PostgresAuthStore.setUsername`, `POST /me/username`.

## Function: InMemoryAuthStore

- **Purpose:** Process-local AuthStore: passkey challenges/credentials, accounts, sessions, and custodial Nostr keys (`getNostrPublicKey` / `getNostrSecret` / `setNostrKeyIfAbsent` / `listAccountIdsWithoutNostrKey` / `listStaffAccountIds`). `listStaffAccountIds` returns ids at the moderator rank or above (`verified` and `basis` omitted, order unspecified). Evicts expired challenges/sessions on write. Indexes `linkingKey` only when non-null. Maintains an O(1) `viewKey` index; `getAccountByViewKey` looks it up. `getAccountByPubkey` scans `#nostrKeys` for a case-insensitive hex match (`trim`; empty → `undefined`). `listIdsByPrefix(prefix)` returns at most two stored ids whose lowercase form starts with the prefix (prefix not trimmed). `listAccountsByUsernamePrefix` keeps accounts `mentionAccountMatches` accepts for an already-normalised prefix (empty prefix means every non-blank username; a later `.` `_` `-` segment of the username, or a display-name word split on space `.` `_` `-`, also matches). It orders by `lower(trim(username))` then `id`, and returns at most `limit` rows. `name` is the trimmed display name, or the stored username when that name is blank. `markWalletBackupSeen(accountId, now)` sets only `walletBackupSeenAt` when it is still null (other columns unchanged; unknown id → `undefined`; returns `{ account, wrote }` with `wrote` true only on that first write). `setAccountLocale` and `setAccountFiat` write only that field; `onlyIfUnset` returns the stored row with `wrote` false when it is already set, and writes when it is null or omitted; unknown id → `undefined`. `accountHasPasskey` is true when any credential maps to the account id. `getPasskeyCredentialForAccount` returns the newest credential for the account (`createdAt` desc, then `credentialId` desc) or `undefined`. `addSeedPasskeyCredential` inserts a second credential, sets `walletRequired` true, and does not delete or change `walletBackupSeenAt`. `replacePasskeyCredential` deletes the current row and inserts the new one (false when none exists or the new id belongs to another account). `createAccount` is a no-op when `viewKey` is already stored, a non-null `linkingKey` already exists, or `username` (`lower(trim)`) belongs to another id. `updateAccount` reindexes `viewKey` when it changes and refuses a `viewKey`, non-null `linkingKey`, or `username` owned by another id; it never writes `sessionRefused`, `walletRequired`, `walletBackupSeenAt`, `hadExternalWallet`, `locale`, `fiat`, `sparkPubkey`, or `sparkPubkeyVerifiedAt` from the incoming object (the stored values stay). `walletIntroSeen` is stored as the stored value OR the incoming value, so a stale `false` never clears a stored `true`. `tryCreateSession` writes only when the account exists and `sessionRefused` is not true. `setSessionRefused` writes only that flag. `claimProfileMessageId(accountId, expectedId, nextId)` sets only `profileMessageId` when `(stored ?? null) === (expectedId ?? null)` (`undefined` and `null` both match `expectedId === null`); does not touch viewKey/linkingKey indexes; returns true on win, false on unknown id or mismatch. `createAccount` / `updateAccount` with `isPlatform: true` call `#clearPlatformExcept` so every other account's `isPlatform` is false (at most one platform account). `createAccount` stores `sparkPubkey: null` and `sparkPubkeyVerifiedAt: null` regardless of input. `claimSparkPubkey` writes the key only while `walletRequired` is true, username is non-blank, and `sparkPubkeyVerifiedAt` is null (unverified keys are not exclusive). `markSparkPubkeyVerified` stores the timestamp once when id/key/username match and no other account is verified on that key. `getAccountByVerifiedSparkPubkey` / `isSparkPubkeyClaimed` look up claimed or verified keys. `updateAccount` keeps a stored non-blank username, and the stored username of an account with `sparkPubkeyVerifiedAt` set, while writing the other incoming fields (it only fills a blank username, so a write from an older snapshot cannot undo a rename), and it always keeps the stored wallet columns. `setUsername(accountId, username)` is one atomic write for an unverified wallet: missing id → `{ ok: false, reason: 'missing' }`; `sparkPubkeyVerifiedAt` a number → `'frozen'`; `#usernameTaken` → `'taken'`; else stores a copy with the new username and returns `{ ok: true, previous }` (`previous` is the replaced handle or `null`). `deleteAccount` drops the row and its linking-key and viewKey indexes. `listAccounts` returns every account oldest-first. `listNostrKeys` returns one row per stored account. Missing `#nostrKeys` entry → `pubkey` null, empty ciphertext, `kekId` 1, custody `custodial`, `createdAt` null. `insertPasskeyRenewAttempt` pushes one row and does not change the account. It stores `redactPasskeyRenewField` on `errorName` (80), `errorCode` (80), `message` (500), and `userAgent` (300), with `acknowledgedAt` null, and `sanitizePasskeyRenewDebug` on the public authenticator facts (invalid values become null). `latestUnacknowledgedPasskeyRenewErrorName` is that account's newest `outcome === 'failed'` and `acknowledgedAt === null` row's `errorName` (`createdAt` desc, then `id` desc), or null. `acknowledgePasskeyRenewFailures` sets `acknowledgedAt` only where `accountId` matches, `outcome === 'failed'`, and `acknowledgedAt === null`. `hasUnacknowledgedPasskeyRenewFailure` is true when a matching failed row still has `acknowledgedAt === null`. `hasAcknowledgedPasskeyRenewFailure` is true when a matching failed row has `acknowledgedAt !== null`. `deleteFailedPasskeyRenewAttempts` removes rows where `accountId` matches and `outcome === 'failed'` (acknowledged or not) and returns how many were removed. Succeeded and cancelled rows stay. The account row is unchanged.
- **Inputs:** Constructor none. Methods take domain objects (`PasskeyChallenge`, `PasskeyCredential`, `Account`, `Session`). `createAccount` is a no-op when a non-null `linkingKey` already exists, when `viewKey` is already stored, or when `username` (`lower(trim)`) is taken. `updateAccount` refuses a `linkingKey` / `viewKey` / `username` owned by another account and keeps the viewKey index consistent. `setUsername(accountId, username)` writes only `username` while the wallet is unverified and returns `{ ok: true, previous }` or `{ ok: false, reason }`. `claimProfileMessageId(accountId, expectedId, nextId)` sets only `profileMessageId` when `(stored ?? null) === (expectedId ?? null)` (`undefined` and `null` both match `expectedId === null`); does not touch viewKey/linkingKey indexes; returns true on win, false on unknown id or mismatch. `deleteAccount` drops the row and its linking-key and viewKey indexes. `createPasskeyCredential` returns false when this account already has a credential or the id is taken. `createFirstPasskeyCredential` returns false when this account already has a credential, the id is taken, the account is missing, or `sessionRefused`; on success it stores the credential and sets `walletRequired: true` in the same method. `updatePasskeyCredential` returns false unless `(newCount === 0 && stored === 0)` or `newCount > stored`; missing id is false; does not rebind `accountId` / `publicKey`. `updatePasskeyChallenge` returns false when the row is missing or already consumed.
- **Returns / side effects:** Lookups return the object or `undefined`. Writes resolve when persisted. `listAccounts` returns `Account[]`. `getAccounts(ids)` returns the known accounts among `ids`, each once in first-seen order; unknown ids are left out. Operator dump lists: `listPasskeyCredentials`, `listSessions`, `listPasskeyChallenges`, `listNostrKeys`. `deleteAllSessions()` clears every session and returns how many there were.
- **Social recovery:** Keeps pending recoveries by account id and previous wallets and recovery share envelopes by `accountId:sparkPubkey` (byte arrays by reference, as the credential methods do). Every recovery method reads and writes its maps in one synchronous run with no `await`, so each is atomic in the process. An unforwarded pending recovery older than `CHALLENGE_TTL_MS` counts as absent; a forwarded one never expires. `startRecoveryChallenge` answers `changed` unless the account holds that verified key and is not session-refused, `forwarded` while a forwarded pending remains, and otherwise drops an unforwarded pending, consumes open `recovery` challenges, evicts expired challenges, and stores the new one (`started`). `storePendingRecovery` answers, in order, `changed`, `challenge` (missing, foreign, other type, or expired), `same` (a consumed challenge whose pending has the same credential id and new key) or `challenge`, `pending`, `key` (the new key is any account's key, a previous wallet, or another pending's new key), `credential`, else consumes the challenge and stores the row with `forwardedAt` null (`stored`). `markRecoveryForwarded` sets `forwardedAt` only for an unforwarded, unexpired pending of that old key whose account still holds it verified, is not session-refused, and has that `lower(trim)` username. `commitRecovery` answers `gone` without a forwarded pending of that new key, drops the pending and answers `changed` when the account left the old verified key, throws with no write (as the Postgres unique index and primary key roll back) when another account verified the new key or holds the pending credential id, and otherwise adds the previous wallet (`encodeSparkAddress(old)`), replaces every credential with the pending one, deletes every session, removes the account's push subscriptions through the store linked by `usePushStore(push)`, sets the new key with `walletRequired` true (keeping `sparkPubkeyVerifiedAt`, username, and shares), consumes open `recovery` challenges, and deletes the pending (`committed`). `dropPreviousWallet` also deletes that key's share; `putRecoveryShare` answers `changed` unless the key is the account's verified key, else `stored` or `replaced`; `hasRecoveryShareForVerifiedWallet` is true only for a share of the current verified key.
- **Used by:** `createApp` default store; all auth/me/debug/view routes.

## Function: PostgresAuthStore

- **Purpose:** Durable AuthStore over Postgres (`SqlClient`). Same eviction-on-write semantics as the in-memory adapter, including passkey challenges, credentials, custodial Nostr key columns, and the `view_key` column. `listNostrKeys` is `SELECT id, nostr_pubkey, nostr_nsec_ciphertext, nostr_kek_id, nostr_key_custody, nostr_key_created_at FROM account` with **no** `WHERE nostr_pubkey IS NOT NULL`; maps null pubkey; `kekId` `?? 1`; custody ternary `'user'` else `'custodial'`. `getAccountByViewKey` is `WHERE view_key = $1`. `getAccounts(ids)` is one `WHERE id = ANY($1::uuid[])` query with the distinct ids as one array-literal string (`postgresTextArrayLiteral`), no query for an empty list, and rows without a view key left out as in `listAccounts`. `getAccountByPubkey` is `WHERE lower(nostr_pubkey) = lower(trim($1))`. `listIdsByPrefix` is `SELECT id::text AS id FROM account WHERE lower(id::text) LIKE $1 || '%' LIMIT 2` (prefix lowercased, not trimmed; at most two ids). `listAccountsByUsernamePrefix` binds the escaped prefix (`\`, `%`, and `_` are literals, no trailing `%`) as `$1` and `limit` as `$2`. `$3` is `'1'` when the prefix contains `.`, `_`, or `-`, and then only the whole-string starts-with arms apply; otherwise `$3` is `'0'` and the boundary arms apply. A row matches when `$1 = ''`, or `lower(trim(username))` or `lower(trim(coalesce(name, '')))` starts with `$1`, or, when `$3 = '0'`, either contains `$1` immediately after `-`, `.`, or `_`, or the name contains `$1` immediately after a space. Each `LIKE` uses `ESCAPE '\'`. It orders by `lower(trim(username))` then `id::text`, and returns at most `limit` rows. A blank display name falls back to the stored username. `listStaffAccountIds` is `SELECT id FROM account WHERE role IN ('founder', 'moderator', 'initiator')`. The `lightning_address` and `lightning_address_verified` columns are neither inserted nor updated, and their values are not selected (new rows take `lightning_address_verified` from its `DEFAULT false`; existing data stays). The account select reads only `(lightning_address IS NOT NULL AND btrim(lightning_address) <> '') AS had_external_wallet`, mapped to `hadExternalWallet`. `wallet_intro_seen` is selected and mapped to `walletIntroSeen`; `createAccount` inserts it as `$21`. `markWalletBackupSeen` is `UPDATE account SET wallet_backup_seen_at = to_timestamp($2::double precision / 1000.0) WHERE id = $1 AND wallet_backup_seen_at IS NULL RETURNING …`; empty `RETURNING` then `SELECT … WHERE id = $1`; returns `{ account, wrote }` or `undefined` (unknown id or unmappable `view_key`). `setAccountLocale` is `UPDATE account SET locale = $2 WHERE id = $1` plus `AND locale IS NULL` when `onlyIfUnset` is true, then the same empty-`RETURNING` `SELECT`; `setAccountFiat` is the same for `fiat`. Both return `{ account, wrote }` or `undefined`. `accountHasPasskey` is `SELECT 1 FROM passkey_credential WHERE account_id = $1 LIMIT 1`. Methods match `AuthStore` including `getAccountByViewKey`, `getAccountByPubkey`, `accountHasPasskey`, `getPasskeyCredentialForAccount` (`ORDER BY created_at DESC, credential_id COLLATE "C" DESC LIMIT 1`), `markWalletBackupSeen` then `replacePasskeyCredential`, `claimProfileMessageId`, `tryCreateSession`, and `setSessionRefused`. `replacePasskeyCredential` is one statement: `WITH deleted AS (DELETE … WHERE account_id = $4 RETURNING credential_id) INSERT … SELECT … WHERE EXISTS (SELECT 1 FROM deleted) RETURNING credential_id`. `mapAccount` skips null `view_key` (`getAccount` / `getAccountByViewKey` / `getAccountByPubkey` return undefined; `listAccounts` omits those rows) and sets `isPlatform` true only when `is_platform` is true. Passkey `signCount` advances with an atomic `WHERE` (`0/0` or `new > stored`) `RETURNING`, not `GREATEST`; duplicate credential ids are `ON CONFLICT DO NOTHING`. `createPasskeyCredential` inserts only when that account has no credential yet (`WHERE NOT EXISTS`) and `ON CONFLICT (credential_id) DO NOTHING`; a duplicate credential id does not raise `23505`. There is no unique index on `account_id`. `createFirstPasskeyCredential` locks the account row (`FOR UPDATE` where `session_refused IS NOT TRUE` and `wallet_required IS NOT TRUE`, so a waiter sees the first claim's flag and inserts nothing), inserts only when that account has no credential (`WHERE NOT EXISTS`), then `UPDATE account SET wallet_required = TRUE` from the inserted row; empty `RETURNING` or unique_violation is false. `createAccount` INSERT unique_violation `23505` is a no-op. `updateAccount` refuses a `linkingKey` owned by another id (`UPDATE` matches no row; unique_violation `23505` is a no-op). `claimProfileMessageId` is `UPDATE account SET profile_message_id = $3 WHERE id = $1 AND profile_message_id IS NOT DISTINCT FROM $2 RETURNING id` via `query` (not `execute`); true iff a row is returned. `updateAccount` writes the other columns including `amount_unit` (`$16`), `notify_hearts = $17`, and `wallet_intro_seen = wallet_intro_seen OR $18` (never cleared) and does not set `session_refused`, `wallet_required`, `wallet_backup_seen_at`, `locale`, `fiat`, `spark_pubkey`, or `spark_pubkey_verified_at`; its username item is `username = CASE WHEN spark_pubkey_verified_at IS NULL AND trim(coalesce(username, '')) = '' THEN $15 ELSE username END`, so a stored non-blank username, and the username of an account with a verified wallet, stays while the other fields of the update are written (a write from an older snapshot cannot undo a rename). `setUsername` is one `UPDATE account AS a SET username = $2 FROM (SELECT id, username AS previous FROM account WHERE id = $1 FOR UPDATE) AS before WHERE a.id = before.id AND a.spark_pubkey_verified_at IS NULL RETURNING before.previous`: one row → `{ ok: true, previous }`; unique_violation → `'taken'`; zero rows then `SELECT spark_pubkey_verified_at FROM account WHERE id = $1` → no row `'missing'`, else `'frozen'`. Other errors rethrow. The existing `trg_db_change` row trigger records the username write. `claimSparkPubkey` / `markSparkPubkeyVerified` / `getAccountByVerifiedSparkPubkey` / `isSparkPubkeyClaimed` implement the wallet-key bind (unique verified index; unique violation → false). `claimSparkPubkey` writes `spark_pubkey = $2, spark_address = $3` in one statement, with `$3` = `encodeSparkAddress($2)`. `spark_address` is not selected or mapped onto `Account`. `tryCreateSession` is `INSERT … SELECT … WHERE session_refused IS NOT TRUE RETURNING token`. `setSessionRefused` is `UPDATE account SET session_refused = $2 WHERE id = $1 RETURNING …`. Before `createAccount` / `updateAccount` when `isPlatform === true`, `UPDATE account SET is_platform = false WHERE is_platform AND id <> $1` so at most one platform account remains (partial unique `account_is_platform_uidx`). INSERT/UPDATE write `is_platform`. `deleteAccount` is `DELETE FROM account WHERE id = $1`. The legacy unique index on `lower(trim(lightning_address))` stays; that column is no longer written. `insertPasskeyRenewAttempt` calls `sanitizePasskeyRenewDebug`, then `INSERT INTO passkey_renew_attempt` with `$1`–`$10` (id, account, created_at, stage, outcome, error name, error code, http status, message, user agent) and `$11`–`$22` (`authenticator_attachment`, `transports`, `aaguid`, `prf_enabled`, `prf_present`, `extensions`, `authenticator_flags`, `public_key_algorithm`, `resident_key`, `hmac_secret`, `cred_protect`, `client_capabilities`) after `redactPasskeyRenewField` on error name (80), error code (80), message (500), and user agent (300). It does not update `account`. `acknowledgePasskeyRenewFailures` is `UPDATE passkey_renew_attempt SET acknowledged_at = to_timestamp($2::double precision / 1000.0) WHERE account_id = $1 AND outcome = 'failed' AND acknowledged_at IS NULL`. `hasUnacknowledgedPasskeyRenewFailure` is `SELECT 1 AS exists FROM passkey_renew_attempt WHERE account_id = $1 AND outcome = 'failed' AND acknowledged_at IS NULL LIMIT 1`. `hasAcknowledgedPasskeyRenewFailure` is the same select with `acknowledged_at IS NOT NULL`. `latestUnacknowledgedPasskeyRenewErrorName` is `SELECT error_name … WHERE account_id = $1 AND outcome = 'failed' AND acknowledged_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`, or null when no row. `deleteFailedPasskeyRenewAttempts` is `DELETE FROM passkey_renew_attempt WHERE account_id = $1 AND outcome = 'failed' RETURNING id` via `query` (not `execute`); the count is the returned row length. Succeeded and cancelled rows stay. The account row is unchanged. The existing `trg_db_change` row trigger records that delete.
- **Inputs:** Constructor takes a `SqlClient`. Methods match `AuthStore` including `getAccountByViewKey`, `getAccountByPubkey`, `accountHasPasskey`, `setUsername`, `claimProfileMessageId`, `tryCreateSession`, `setSessionRefused`, and operator dump lists (`listPasskeyCredentials`, `listSessions`, `listPasskeyChallenges`, `listNostrKeys`). `claimProfileMessageId` is `UPDATE account SET profile_message_id = $3 WHERE id = $1 AND profile_message_id IS NOT DISTINCT FROM $2 RETURNING id` via `query` (not `execute`); true iff a row is returned. `updateAccount` writes `amount_unit` (`$16`), `notify_hearts = $17`, and `wallet_intro_seen = wallet_intro_seen OR $18` and does not write `session_refused`, `wallet_required`, `wallet_backup_seen_at`, `locale`, `fiat`, `spark_pubkey`, or `spark_pubkey_verified_at`. `setAccountLocale` and `setAccountFiat` are the only writers of `locale` and `fiat`; `claimSparkPubkey`, `markSparkPubkeyVerified`, and `commitRecovery` are the only writers of `spark_pubkey` and `spark_pubkey_verified_at`; `claimSparkPubkey`, `commitRecovery`, and `backfillSparkAddresses` are the only writers of `spark_address`.
- **Returns / side effects:** Parameter-bound SQL; maps snake_case rows to domain objects. `deleteAllSessions()` runs `DELETE FROM auth_session` in one statement and returns the deleted row count (`trg_db_change` logs each row with the token hashed).
- **Social recovery:** The constructor takes an optional `MergeDb` transaction port as its second argument; boot passes it. `startRecoveryChallenge`, `storePendingRecovery`, `markRecoveryForwarded`, `commitRecovery`, and `putRecoveryShare` each run in one `transactions.begin` whose first query is `SELECT id, username, spark_pubkey, spark_address, spark_pubkey_verified_at, session_refused FROM account WHERE id = $1 FOR UPDATE`; without the port they throw `auth transactions are not configured` before any query. The results match the in-memory adapter. `markRecoveryForwarded` first reads the pending row's account id without a lock, then locks the account and runs one conditional `UPDATE pending_recovery SET forwarded_at … RETURNING`. `commitRecovery` inserts `previous_wallet` (address `account.spark_address`, else `encodeSparkAddress(old)`), deletes every `passkey_credential`, inserts the pending credential, deletes every `auth_session` and `push_subscription` of the account, sets `spark_pubkey`, `spark_address`, and `wallet_required = TRUE`, consumes open `recovery` challenges, and deletes the pending row, all in that transaction. A unique violation (for example from the `storePendingRecovery` insert) is not mapped: it propagates and rolls back. `dropPendingRecovery` is one conditional `DELETE … RETURNING`; `dropPreviousWallet` is one CTE that deletes the previous wallet and that key's `recovery_share` row; `hasRecoveryShareForVerifiedWallet` is one `EXISTS` join of `account` and `recovery_share` that never selects the ciphertext. No method returns a share's ciphertext. `parsePasskeyChallengeType` accepts `recovery`.
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
- **Returns / side effects:** Void; creates `account`, `auth_session`, `address_verification` (legacy; no longer read or written), `passkey_challenge`, `passkey_credential`, and `passkey_renew_attempt` plus index `passkey_renew_attempt_account_idx` on `(account_id, created_at DESC)`; drops leftover `auth_challenge`; backfills `account.name` / nullable `linking_key`; adds `nostr_pubkey` / nsec ciphertext / kek id / custody plus unique index and CHECK; adds `view_key` ALTER, uuid-concat backfill, and unique index; adds nullable `rules_agreed_at`; unique index `account_lightning_address_uidx` on `lower(trim(lightning_address))` where not null; `ALTER COLUMN lightning_address_verified SET DEFAULT false` (the column is kept as data and no longer written); `DROP INDEX IF EXISTS passkey_credential_account_uidx` so a login passkey may stay beside one later seed passkey; adds `is_platform boolean NOT NULL DEFAULT false` and unique index `account_is_platform_uidx` on `(is_platform) WHERE is_platform`; adds nullable `name_skipped_at`, `lightning_address_skipped_at`, and `profile_message_id uuid` (**no** FK to `message` here — message migrates later); adds nullable `location text` (no unique index, same as `name`); adds `notification_level text NOT NULL DEFAULT 'all'` plus `DROP`/`ADD` `account_notification_level_chk` (`all` / `active` / `mentions` / `none`); adds `amount_unit text NOT NULL DEFAULT 'btc'` plus `DROP`/`ADD` `account_amount_unit_chk` (`btc` / `fiat`); adds nullable `locale text` and `fiat text` with no value backfill, plus `DROP`/`ADD` `account_locale_chk` (`en` / `de` / `es` / `fil`, or null) and `account_fiat_chk` (`CHF` / `EUR` / `USD` / `PHP`, or null); adds nullable `username text`; `DROP INDEX IF EXISTS account_username_uidx` then `CREATE UNIQUE INDEX IF NOT EXISTS account_username_uidx` on `lower(trim(username))` WHERE username IS NOT NULL AND trim(username) <> '' (expression unique index); adds `session_refused boolean NOT NULL DEFAULT false`; adds `wallet_required boolean NOT NULL DEFAULT false` and nullable `wallet_backup_seen_at timestamptz`; adds `wallet_intro_seen boolean NOT NULL DEFAULT false` right after `forum_laws_dismissed` (existing rows are false); then `UPDATE account SET role = 'initiator' WHERE lower(trim(username)) = 'pater-severin' AND role = 'moderator'` (no-op unless that row is still moderator). Adds nullable `passkey_renew_attempt` columns with `ADD COLUMN IF NOT EXISTS`: `authenticator_attachment`, `transports`, `aaguid`, `prf_enabled`, `prf_present`, `extensions`, `authenticator_flags`, `public_key_algorithm`, `resident_key`, `hmac_secret`, `cred_protect`, `client_capabilities`. Drops and re-adds CHECKs for attachment (`platform` / `cross-platform` or null), aaguid (32 lowercase hex or null), flags (0–255 or null), algorithm (−65536–65535 or null), credProtect (the three policy names or null), and client capabilities (length ≤ 1200 and the name pattern, or null). Adds nullable `passkey_challenge.requested_name` text via `ADD COLUMN IF NOT EXISTS`. Adds nullable `spark_pubkey text` and `spark_pubkey_verified_at timestamptz` with CHECK (`spark_pubkey` matches `^0[23][0-9a-f]{64}$` or null; verified requires a key), partial index on `spark_pubkey`, and unique index on verified `spark_pubkey`. The array then adds `notify_hearts boolean NOT NULL DEFAULT true`, nullable `spark_address text`, and `DROP`/`ADD` `account_spark_address_chk` (`spark_address` is null, or `spark_pubkey` is set and `spark_address` matches `^spark1[02-9ac-hj-np-z]{62}$`). Existing rows keep `spark_address` null until `backfillSparkAddresses`. For social recovery it then creates `recovery_share` (`account_id` references `account`, PK `(account_id, spark_pubkey)`, `recovery_share_spark_pubkey_chk` on the key pattern, `recovery_share_ciphertext_chk` with `octet_length(recovery_share_ciphertext) BETWEEN 34 AND 1024`); `pending_recovery` (PK `account_id` referencing `account`, nullable `forwarded_at`, `pending_recovery_keys_chk` with both keys on the key pattern and `old_spark_pubkey <> new_spark_pubkey`, `pending_recovery_sign_count_chk` with `sign_count >= 0`) plus unique indexes `pending_recovery_new_spark_pubkey_uidx` on `new_spark_pubkey` and `pending_recovery_credential_id_uidx` on `credential_id`; `previous_wallet` (`account_id` references `account`, PK `(account_id, spark_pubkey)`, `previous_wallet_spark_pubkey_chk` on the key pattern, `previous_wallet_spark_address_chk` with `^spark1[02-9ac-hj-np-z]{62}$`) plus index `previous_wallet_spark_pubkey_idx` on `spark_pubkey`; and the partial index `passkey_challenge_open_account_type_idx` on `passkey_challenge (account_id, type) WHERE consumed = false`.
- **Used by:** `openAuthStore`.

## Function: backfillSparkAddresses

- **Purpose:** Store the Spark address of every account that has a wallet key, so `account.spark_address` holds `encodeSparkAddress(spark_pubkey)` on every row with a key.
- **Inputs:** `SqlClient` (auth schema already migrated).
- **Returns / side effects:** `SELECT id, spark_pubkey, spark_address FROM account WHERE spark_pubkey IS NOT NULL`; for each row whose stored address is null or differs, `UPDATE account SET spark_address = $3 WHERE id = $1 AND spark_pubkey = $2 RETURNING id`, so a key claimed in the meantime keeps the address its claim wrote. Returns the number of rows written and logs `account.spark_address.backfill` with `{ count }`. A second run writes nothing. The existing `trg_db_change` row trigger records each write.
- **Used by:** `openAuthStore`, right after `migrateAuthSchema`.

## Function: capPasskeyRenewText

- **Purpose:** Trim a passkey-renew text field, treat a blank string as null, and cap the stored length so client and header values cannot grow without bound.
- **Inputs:** `value` (`string | null`) and `max` (maximum stored length after trim).
- **Returns / side effects:** The trimmed string, sliced to `max` when longer, or `null` when the value is null or blank. No I/O.
- **Used by:** `redactPasskeyRenewField` after a value is not a secret dump.

## Function: redactPasskeyRenewMessage

- **Purpose:** Inspect the trimmed passkey-renew message before any length cap. Twelve or more whitespace-separated tokens, or a base64url/hex run of 64 or more characters, become `"[redacted]"`; otherwise the trimmed string is capped at 500 characters.
- **Inputs:** `value` (`string | null`).
- **Returns / side effects:** `"[redacted]"`, the trimmed message, the first 500 characters, or `null` when blank. Does not call `capPasskeyRenewText`. No I/O.
- **Used by:** `redactPasskeyRenewField` for every stored renew text field.

## Function: redactPasskeyRenewField

- **Purpose:** Redact a renew text field, then cap it. A 12-word phrase or a 64-character secret run becomes `"[redacted]"` before the field cap.
- **Inputs:** `value` (`string | null`) and `max` (stored length after redaction).
- **Returns / side effects:** `"[redacted]"`, the capped trimmed string, or `null` when blank. No I/O.
- **Used by:** `insertPasskeyRenewAttempt` for `error_name`, `error_code`, `message`, and `user_agent`.

## Function: sanitizePasskeyRenewDebug

- **Purpose:** Keep only public authenticator facts on a passkey-renew row. A wrong type or a value outside the allowlist becomes null, so the failure row is still stored.
- **Inputs:** Attachment, transports, AAGUID, PRF booleans, extension names, flags byte, COSE algorithm, resident-key and hmac-secret booleans, credProtect, and browser capability names.
- **Returns / side effects:** The twelve safe fields. No credential id, attestation, challenge, or PRF output. No I/O.
- **Used by:** `insertPasskeyRenewAttempt` in the in-memory and Postgres auth stores.

## Function: openAuthStore

- **Purpose:** Chooses in-memory vs Postgres AuthStore from `DATABASE_URL`.
- **Inputs:** URL or blank/undefined; `createClient` factory required when the URL is set (boot supplies Bun SQL; tests inject a mock); optional `transactions` (`MergeDb`) passed to `PostgresAuthStore` for the locked social recovery steps.
- **Returns / side effects:** `InMemoryAuthStore` if unset (no username or Spark address backfill); otherwise migrate the auth schema, `backfillSparkAddresses`, `backfillAccountUsernames`, then return `PostgresAuthStore`. Throws if the URL is set without a factory.
- **Used by:** `openBootStores`.

## Function: openBootStores

- **Purpose:** Shared `DATABASE_URL` wiring: one `SqlClient` for durable auth, FX tables, `QueryGiftStore`, `SqlGiftRecorder`, `PostgresBtcUsdStore`, `PostgresFiatStore`, `migrateFxSpotSchema`, `PostgresFxSpotStore`, `migrateMessageSchema`, `PostgresMessageStore`, `PostgresTranslationStore` (forum `message_translation`) plus a second `PostgresTranslationStore` aimed at `conversation_message_translation` (`conversationTranslationStore`; never the forum store instance), `migrateContactSchema`, `PostgresContactStore`, `migrateMemberHabitSchema`, `PostgresMemberHabitStore`, `migratePosSchema`, `PostgresPosStore`, `migrateConversationSchema`, `PostgresConversationStore`, `migratePushSchema`, `PostgresPushStore`, `migrateNotificationSchema`, `PostgresNotificationStore`, `migrateTrustSchema`, `migrateFundingSchema`, `migrateDailyRosterSchema`, `PostgresTrustStore`, `PostgresFundingStore`, `PostgresDailyRosterStore`, `migrateApiLogSchema`, `PostgresApiLogStore`, `PostgresDebugDbStore`, `migrateBannerSchema`, `PostgresBannerStore`, `migrateDiagnosticSchema`, `PostgresDiagnosticStore`, `migrateSparkInvoiceSchema`, `PostgresSparkInvoiceStore` (`sparkInvoiceStore`), `migrateLoginGateSchema`, `PostgresLoginGateStore` (`loginGateStore`), `migrateDbChangeSchema`, `migrateShopIdentitySchema` with `PostgresShopIdentityStore` (`shopIdentityStore`), and parsed `NOSTR_NSEC_KEK`; or in-memory auth, `giftStore`/`giftRecorder`/`messageStore`/`translationStore`/`conversationTranslationStore`/`contactStore`/`memberHabitStore`/`conversationStore`/`notificationStore`/`pushStore`/`trustStore`/`fundingStore`/`bannerStore`/`apiLogStore`/`diagnosticStore`/`listDbChange`/`debugDbStore`/`sparkInvoiceStore`/`loginGateStore`/`shopIdentityStore` undefined, a fresh `InMemoryDailyRosterStore` as `rosterStore`, `nostrKek` undefined, empty `InMemoryBtcUsdStore`, and empty `InMemoryFiatStore` when unset. When `fx.logSql` is passed, `PostgresApiLogStore` and `PostgresDiagnosticStore` use that client and migrations stay on the primary client.
- **Inputs:** `databaseUrl`; optional `createClient` (required when URL set); optional `fx: { fetchImpl, candlesUrl, frankfurterUrl, now, nostrQuerier, zapRelayUrls, nostrRelayTimeoutMs, lnurlServer, logSql }` so tests avoid the network (`candlesUrl` defaults via `resolveCandlesUrl(process.env)`; `frankfurterUrl` defaults via `resolveFrankfurterUrl(process.env)`; `nostrQuerier`, `zapRelayUrls` and `nostrRelayTimeoutMs` feed `backfillExternalZappers` and default to a `WebsocketNostrQuerier`, `resolveZapRelays(process.env)` and a 5000 ms per-relay timeout; `lnurlServer` defaults via `resolveLnurlServerConfig(process.env)`, and `null` makes `linkDailyRosterAccounts` match the legacy `lightning_address` only; `logSql` is the client for `PostgresApiLogStore` and `PostgresDiagnosticStore` when passed, and the primary client otherwise, while migrations stay on the primary client). SQL path reads `process.env.NOSTR_NSEC_KEK` and then `process.env.RECOVERY_SHARE_KEK` (`parseRecoveryShareKek`, right after the auth migration). Optional fourth argument `transactions` (`MergeDb`) is passed to `openAuthStore` (the `PostgresAuthStore` social recovery steps) and to `PostgresFundingStore` for the locked admission count.
- **Returns / side effects:** `{ authStore, giftStore, giftRecorder, btcUsdRates, fiatRates, fxSpotStore, messageStore, translationStore, conversationTranslationStore, contactStore, memberHabitStore, posStore, conversationStore, notificationStore, pushStore, trustStore, fundingStore, rosterStore, bannerStore, apiLogStore, diagnosticStore, nostrKek, recoveryShareKek, listDbChange, debugDbStore, sparkInvoiceStore, loginGateStore, shopIdentityStore }` (`sparkInvoiceStore` is a `PostgresSparkInvoiceStore` on SQL boots after `migrateSparkInvoiceSchema` ran before the `db_change` migrate, `undefined` on memory boots). `fxSpotStore` is a `PostgresFxSpotStore` on SQL boots and an empty `InMemoryFxSpotStore` on memory boots. `shopIdentityStore` is the `PostgresShopIdentityStore` on the SQL path and `undefined` on the memory path. Migrates `btc_usd_daily` then `usd_fiat_daily`, then `btc_fiat_spot` (via `migrateFxSpotSchema`, before the `db_change` migrate so `trg_db_change` attaches), `message`, `shop_identity` (via `migrateShopIdentitySchema`), `contact`, `member_habit` (via `migrateMemberHabitSchema`), `pos_charge` and `pos_charge_invoice` (via `migratePosSchema`), `conversation` (via `migrateConversationSchema`), `push_subscription`/`push_outbox` (via `migratePushSchema`), `notification` (via `migrateNotificationSchema` after push before `db_change`), then `trust_edge` (via `migrateTrustSchema`) after notification, then `funding_grant` (via `migrateFundingSchema`), then `daily_roster` (via `migrateDailyRosterSchema`), then `api_log` (via `migrateApiLogSchema`), then `account_image` (via `migrateBannerSchema`), then `diagnostic_event` (via `migrateDiagnosticSchema`), then `spark_invoice` (via `migrateSparkInvoiceSchema`); `shop_payment`, `shop_quote`, `shop_offer`, `shop_proof`, and `shop_proof_lookup` are migrated by `migrateShopPaymentSchema` right after `migratePosSchema`, also before `migrateDbChangeSchema`; the diagnostic sink is installed on that store before the FX fill and the zap backfills, immediately before `migrateDbChangeSchema` so `trg_db_change` attaches to `shop_identity`, `trust_edge`, `funding_grant`, `daily_roster`, `daily_roster_entry`, `api_log`, `account_image`, `diagnostic_event`, and `spark_invoice`, then `db_change` after auth migrate; after the `db_change` migrate and `repairGiftKind`, `linkDailyRosterAccounts` runs with the host of `fx.lnurlServer` (default `resolveLnurlServerConfig(process.env)`), or null when that is null, so `trg_db_change` records each linked row, and one `daily_roster.accounts_linked` log line with `linked` and `unlinked` follows; `PostgresDailyRosterStore` gets the same host; best-effort `fillRatesForGiftRange` logs `gifts.fx.boot_fill.failed` and does not throw; best-effort `fillFiatRatesForGiftRange` logs `gifts.fx.fiat_boot_fill.failed` and does not throw. Throws if the URL is set without a factory, or if the SQL path has a missing/malformed `NOSTR_NSEC_KEK` or `RECOVERY_SHARE_KEK`, or a `RECOVERY_SHARE_KEK` equal to `NOSTR_NSEC_KEK` (`recoveryShareKek` is `undefined` on memory boots). SQL path returns `SqlGiftRecorder`, `PostgresMessageStore`, `PostgresShopIdentityStore`, `PostgresTranslationStore` (forum) plus a second `PostgresTranslationStore` on `conversation_message_translation`, `PostgresContactStore`, `PostgresMemberHabitStore`, `PostgresPosStore`, `PostgresConversationStore`, `PostgresNotificationStore`, `PostgresPushStore`, `PostgresFiatStore`, `PostgresTrustStore`, `PostgresFundingStore`, `PostgresDailyRosterStore`, `PostgresBannerStore`, `PostgresApiLogStore`, `PostgresDiagnosticStore`, `PostgresDebugDbStore`, and `PostgresSparkInvoiceStore` (`PostgresApiLogStore` and `PostgresDiagnosticStore` use `fx.logSql` when that client is passed, and the primary client otherwise; migrations stay on the primary client); memory path returns `giftRecorder`/`messageStore`/`translationStore`/`conversationTranslationStore`/`contactStore`/`memberHabitStore`/`conversationStore`/`notificationStore`/`pushStore`/`trustStore`/`fundingStore`/`bannerStore`/`apiLogStore`/`diagnosticStore`/`listDbChange`/`debugDbStore`/`sparkInvoiceStore`/`nostrKek` undefined, returns a fresh `InMemoryPosStore` as `posStore`, a fresh `InMemoryDailyRosterStore` as `rosterStore`, and skips migrates including `migrateMemberHabitSchema` / `migratePosSchema` / `migrateConversationSchema` / `migratePushSchema` / `migrateNotificationSchema` / `migrateTrustSchema` / `migrateFundingSchema` / `migrateDailyRosterSchema` / `migrateApiLogSchema` / `migrateBannerSchema` / `migrateDiagnosticSchema` / `migrateSparkInvoiceSchema` / `migrateDbChangeSchema`. SQL path calls `migrateMemberHabitSchema` for `member_habit` before `PostgresMemberHabitStore`, and `migratePosSchema` for `pos_charge` before `PostgresPosStore`, which gets the `transactions` port for the payment hash claim of `recordInvoice` (the same port as `PostgresFundingStore`). SQL boots also run `migrateLoginGateSchema` after `migrateMemberEventSchema` and before `migrateDbChangeSchema`, so `trg_db_change` attaches to `app_setting` and `login_allowlist`, and return `loginGateStore` (`PostgresLoginGateStore`); memory boots return `loginGateStore: undefined`.
- **Payment and external-zapper backfills:** Only after `migrateDbChangeSchema` has attached `trg_db_change` to every public table (so the payment backfill's `nostr_zap_payment` inserts are logged), constructs `PostgresMessageStore`, runs `backfillZapPayments`, and immediately runs `backfillExternalZappers` before constructing the remaining Postgres stores and returning. The external-zapper backfill pages through unattributed receipts with a 10,000-row ceiling and logs `nostr.zapper.backfill.done` with its aggregate counts; a failure logs `nostr.zapper.backfill.failed` and boot continues. Payment-backfill failures still propagate. In-memory boots call neither backfill.
- **Member data:** A SQL boot runs `migrateWalletSchema` and then `migrateMemberEventSchema` after `migrateSparkInvoiceSchema` and before `migrateDbChangeSchema`, so `trg_db_change` attaches to `wallet_balance_snapshot`, `wallet_payment`, and `member_event`, and returns `walletStore: PostgresWalletStore` and `memberEventStore: PostgresMemberEventStore`. A memory boot returns `undefined` for both, and `createApp` falls back to the in-memory stores.
- **Used by:** `src/index.ts` boot.
- **Shop identities:** Runs `migrateShopIdentitySchema` right after `migrateMessageSchema` (before `migrateDbChangeSchema` attaches `trg_db_change`) and returns `shopIdentityStore` (`PostgresShopIdentityStore` over the shared client and the Postgres message store); memory boots return `undefined`.

## Function: bearerMatchesDebugToken

- **Purpose:** Constant-time compare of `DEBUG_TOKEN` against `Authorization: Bearer`.
- **Inputs:** Configured token (non-empty) and raw header or `undefined`.
- **Returns / side effects:** `true` only on an exact Bearer match (trim on the presented token).
- **Used by:** `debugRoutes`, `debugContactsRoutes`, `debugApiLogRoutes`, `debugDiagnosticsRoutes`, `debugDbRoutes`, `debugMessagesRoutes`, `debugPaymentsRoutes`, `debugPushRoutes`, `debugPasskeyRenewRoutes`, `debugTrustRoutes`, `debugCatalogRoutes`, `debugLoginsRoutes`, `resolveRequestAuth`.

## Function: assertDistinctDebugTokens

- **Purpose:** Refuse boot when the write and read debug tokens are the same secret. Trim first. An empty token after trim is not compared. Differing UTF-8 lengths return. Equal length and `timingSafeEqual` throw without printing either value.
- **Inputs:** Write token and read token, each `string | undefined`.
- **Returns / side effects:** `void`. Returns when either trimmed token is empty or the UTF-8 lengths differ. Throws `Error('DEBUG_READ_TOKEN matches DEBUG_TOKEN')` when both trimmed tokens are non-empty, the same UTF-8 length, and `timingSafeEqual` is true. The message does not include either value.
- **Used by:** `createApp`, before routes mount.

## Function: classifyDebugDbBearer

- **Purpose:** Classify a Bearer header for `GET /debug/db` and, through `isOperatorBearer`, for the operator reads on the staff GET routes. The read token opens no write route.
- **Inputs:** Write token and read token (each `string | undefined`, both trimmed) and the raw `Authorization` header or `undefined`.
- **Returns / side effects:** `'unconfigured'` when both trimmed tokens are empty. Otherwise the write token is tried first, then the read token. No match returns `'unauthorized'`. No I/O.
- **Used by:** `debugDbRoutes` for `GET /debug/db`. HEAD uses that same GET handler. `isOperatorBearer` for the operator reads on staff GET routes.

## Function: isOperatorBearer

- **Purpose:** Whether an `Authorization` header carries the operator write or read token, so a staff GET route can serve the same body without a session. True only when `classifyDebugDbBearer` returns `'write'` or `'read'`. Both tokens unset, a missing header, or a bearer that matches neither is false, and the route falls through to its normal session and role check.
- **Inputs:** Write token and read token (each `string | undefined`) and the raw `Authorization` header or `undefined`.
- **Returns / side effects:** `boolean`. No I/O.
- **Used by:** `grantContinuationRoutes` (`GET /funding/goal`), `fundingRoutes` (`GET /funding/applications`, `GET /funding/applications/:accountId`, `GET /funding/payout-days`, `GET /funding/daily-roster`), `trustRoutes` (`GET /trust/proposals`), `membersRoutes` (`GET /members/:accountId/activity`), and `messagesRoutes` (`GET /messages/hidden`, `GET /messages/:id/edits`).

## Function: compareAccountsForList

- **Purpose:** Sort key for `listAccounts`: older `createdAt` first, then `id` ascending.
- **Inputs:** Two `Account` values.
- **Returns / side effects:** Negative / positive / 0.
- **Used by:** `InMemoryAuthStore.listAccounts`.

## Function: mergeAccounts

- **Purpose:** Fold account `from` into account `into` on one reserved transaction (`MergeDb.begin`). Moves every single-column foreign key that the catalog says references `public.account(id)`, keeps one verify edge, copies the earlier join time and the consent that must not get worse onto the survivor, and deletes `from`. Clears `first_post_free` on the source note before the move when the survivor already has a free first post, so the per-account unique index holds. The same id returns before a transaction is opened. Name, username, location, and in-app wallet key (`spark_pubkey`, `spark_pubkey_verified_at`) of the survivor are not written.
- **Inputs:** `MergeDb` and `{ from, into, verify }` where `verify` is `'from'` or `'into'`.
- **Returns / side effects:** `{ ok: true, messages }` with the source message count, or `{ ok: false, error }` of `not_found`, `same_account`, `platform`, `both_grants`, or `shop_payment_open` (checked after `both_grants`, under both account locks and before any write: the source account has a `shop_payment` row that is neither `paid` nor closed, whose BOLT11 still pays the source wallet; or the source account has an unexpired pending charge (`expires_at > now()`) while the survivor has an `open` shop payment and no unexpired pending charge of its own, which `POST /pos` never lets coexist; nothing changes). When the survivor has a pending charge (expired or not), the source's pending charges are deleted (Till rows) and the merge goes on. Does not catch driver errors, so a throw rolls the transaction back. Does not log tokens, text, or keys. A `daily_roster_entry` row of `from` in a bucket where `into` is listed too is deleted before the foreign-key move, so `daily_roster_entry_account_bucket_uidx` cannot fail the merge; its other roster rows move to `into`.
- **Social recovery rows:** Before the `passkey_challenge` repoint and the catalog loop, deletes the source's `recovery_share`, `pending_recovery`, and `previous_wallet` rows and its `recovery` passkey challenges (`DELETE … WHERE account_id = $1`, with `type = 'recovery'` for the challenges). They belong to the source's wallets, which go with the source row, and a share's additional data is the source id.
- **Wallet data:** Before the catalog repoint, deletes each source `wallet_payment` row whose `payment_id` the survivor already has (the primary key is `(account_id, payment_id)`), then sets `counterparty_account_id` to `NULL` on payments of either account whose counterparty is one of the two, so no payment ends up with its own account as counterparty.
- **Till rows:** After the refusal checks and before its first write to a charge or payment row, locks all of the source's `pos_charge` rows in the order of their ids (`SELECT id FROM pos_charge WHERE account_id = $1 ORDER BY id FOR UPDATE`), then its `shop_payment` rows in the order of their ids (`SELECT id FROM shop_payment WHERE account_id = $1 ORDER BY id FOR UPDATE`): charge rows before payment rows, the order of every transaction that writes both, and payment rows in the order `lockPaymentsForProofs` takes them in, so a submit answer that holds one of them never waits for the merge in opposite order. Between the two locks it reads the source's pending charges (`ORDER BY id`, rows already held) when the survivor has a pending charge. After the payment lock it deletes those charges' `pos_charge_invoice` rows (their `charge_id` has no cascade) and the charges, both by the read ids (`= ANY($1::uuid[])`); the charge delete's `ON DELETE SET NULL` writes a payment row already held. A concurrent `recordInvoice` for a source charge waits on the row lock in its foreign-key check and, when the charge was deleted, then fails, which the invoice routes log as `pos.invoice.record_failed`. The catalog repoint then moves the source's remaining charges and its paid and closed shop payments like every other row, all already held.
- **Used by:** `POST /debug/accounts/merge` in `debugRoutes`.

## Function: debugRoutes

- **Purpose:** Operator listing, provisioning, role assignment, official platform-flag retarget, session-refusal (`sessionRefused`), and minting a member bearer via `POST /:id/session`. `POST /merge` folds one account into another.
- **Inputs:** `DebugRouteDeps`: store, optional debugToken, optional `lnurlServer` (account JSON `lightningAddress` is the wallet-backed receiving address), optional `conversationStore` (`PATCH platform: true` calls `retargetMemberPlatform`), optional `messageStore`, `pushStore`, and `notificationStore` (POST provision calls `ensureProfileMessage` when `messageStore` is set), optional `now` for minted debug sessions, optional `mergeDb`.
- **Returns / side effects:** Hono app (`GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `POST /:id/session`, `POST /merge`). A body that is not `{ from, into }` is 400; when `mergeDb` is omitted the valid body is 503 `{ error: 'Merge is unavailable' }`; a `shop_payment_open` merge result is 409 `{ error: 'A payment is already open' }`. Shared 503 if token unset; 401 if bearer mismatches. GET 200 `{ accounts }` via `serializeDebugAccount` (includes `isPlatform`, `sessionRefused`, `viewKey`, `walletRequired`, `walletBackupSeenAt`, and Nostr debug fields) logs `debug.accounts.listed` with count. GET `/:id` 200 `serializeDebugAccountDetail` or 404. POST body `{ accounts: [{ name, username? }] }` (strict rows; a `lightningAddress` key is 400) → 400 invalid body (including C0/DEL names or an invalid username; no row is written); with `username`, an existing account with that username gets only its `name` updated (`updateAccount`, created false), otherwise a new `basis` row with that username is created; without `username`, every row creates a new `basis` row with a derived username (`provisionUsername`); 500 `{ error: 'Could not save the account' }` when a created row cannot be read back; when `messageStore` is set, POST then calls `ensureProfileMessage` (optional `pushStore` and `notificationStore`; no note without a verified wallet); returns `{ accounts: [{ name, username, viewKey, created }] }`; logs `debug.accounts.provisioned` with created/updated counts (never viewKeys or the token). PATCH strict body `{ role }` and/or `{ platform: true|false }` and/or `{ sessionRefused: true|false }` → 400 unknown key or missing; 404 missing account; 200 `serializeDebugAccount` of the updated row (includes `isPlatform`, `sessionRefused`, `viewKey`, `walletRequired`, `walletBackupSeenAt`, and Nostr debug fields); role changes log `debug.accounts.role_set` with account id and role; `platform: true` uniquely retargets (store clears any other `isPlatform`), points every member→platform thread at the new account via `retargetMemberPlatform` when `conversationStore` is set, and logs `debug.accounts.platform_set`; `sessionRefused` is written only via `setSessionRefused` (not `updateAccount`) and logs `debug.accounts.session_refused_set`. POST `/:id/session` 404 unknown id; 403 `{ error: 'You signed in with the wrong account. Please try again with the correct account.' }` when `sessionRefused` is true or `tryCreateSession` writes no row, with no `debug.accounts.session_minted` and no member bearer; otherwise 200 `{ token }` and `debug.accounts.session_minted`. Never logs the token.
- **Used by:** `createApp` at `/debug/accounts`.

## Function: debugContactsRoutes

- **Purpose:** Operator listing of private in-app contacts (includes `accountId`).
- **Inputs:** `DebugContactsRouteDeps`: contact store, optional debugToken.
- **Returns / side effects:** Hono app. 503 if token unset; 401 if bearer mismatches; 200 `{ contacts }` newest-first (cap 200); 503 on store throw (`contact.list.failed`). Logs `debug.contacts.listed` with count, never the token.
- **Used by:** `createApp` at `/debug/contacts`.

## Function: debugMessagesRoutes

- **Purpose:** Operator read of every persisted forum row (including soft-hidden notes and replies) plus hidden photo bytes and extra stills (`GET /:id/photo/:file`, indices 1–9; hidden with that extra is 200), restore of a missing forum-video file for an already-existing message with `hasVideo` (raw body under `MEDIA_DIR`; no new message id, no DB create), and unhide of a soft-hidden row (`POST /:id/restore` via `markUndeleted`, followed by `unblockPubkeyByMessage`; 204 empty body; cascade inverse of `markDeleted`; already-live id is still 204). Restoring the source row whose hide created an external-pubkey block lifts that block; restoring another row hidden by the block's cascade only unhides that row, leaves the pubkey blocked, and must be repeated for each cascaded row. Public hide does not apply to the GETs. Unhide is `DEBUG_TOKEN` only — not a moderator session.
- **Inputs:** `DebugMessagesRouteDeps`: message store, optional debugToken, optional `shopIdentities` and `shopKek` (after a restore, `ensureListed` creates the key of a note that is now a public shop; a failure logs `shop.nostr_key.failed` and the response stays 204).
- **Returns / side effects:** Hono app exposing `GET /`, `GET /:id`, `GET /:id/photo`, `GET /:id/photo/:file`, `PUT /:id/video`, and `POST /:id/restore`. Shared 503 if token unset/blank; 401 if bearer mismatches. GET `/` 200 `{ messages }` via `listDebug` / `serializeDebugMessage` (cap 200) logs `debug.messages.listed` with count. GET `/:id` 200 debug JSON (hidden is 200) logs `debug.messages.get` with `messageId`; non-UUID or missing 404 `{ error: 'Not found' }`. GET `/:id/photo` 200 image bytes (hidden with a photo is 200; same Content-Type / Content-Disposition / CORS as public photo) logs `debug.messages.photo.get` with `messageId`; missing row / no photo / bad id 404 `{ error: 'Photo not found' }`. GET `/:id/photo/:file` 200 extra still (indices 1–9; hidden with that extra is 200); missing/no extra/non-UUID/bad file 404 `{ error: 'Photo not found' }`. PUT 404 for non-UUID or unknown id; 409 when the row has no video or the decoded MIME extension does not match the stored type; 400 for empty/oversize/unrecognized body; 204 after `writeForumVideo`. POST `/:id/restore` 404 for non-UUID or missing id; 204 empty body after `markUndeleted` (hidden or already live); logs `debug.messages.restored` with `{ messageId }` only (never text, never `deletedBy`). 503 `{ error: 'Messages are unavailable' }` when a store call or `writeForumVideo` throws (`debug.messages.list_failed` / `debug.messages.get_failed` / `debug.messages.photo.get_failed` / `debug.messages.video.put_failed` / `debug.messages.restore_failed`). Logs `debug.messages.video.put` with `messageId` and `bytes`, never the token, nsec, or raw bytes.
- **Used by:** `createApp` at `/debug/messages`.

## Function: debugPaymentsRoutes

- **Purpose:** Operator listing of all `message_invoice` attempts (forum and conversation invoices; JSON includes `conversationId` and `conversationMessageId`), manual forum-invoice settlement, kind:9735 ingest decisions (`nostr_zap_ingest`), and `POST /spend-ping` to replay one qualifying top-level post onto that post's UTC day and return accepted or skipped. An earlier day does not use the clock day's slot. It is not limited to the clock day.
- **Inputs:** `DebugPaymentsRouteDeps`: message store, auth store, clock, optional push/notification stores, optional `lnurlServer` (receiving address for spend pings, also forwarded to `settleInvoiceManually`), optional `spendPing` and optional `fundingStore` (forwarded to `settleInvoiceManually` for platform-note compose and used by `POST /spend-ping`; spend pings use the same payout gate as `POST /messages` on the clock (`loadPayoutEligibility`: grant and, from the grant gate day, the recovery share; a share read throw is the same 503 as a grant read throw), and `pingOnDay` books the post's UTC day), and optional debugToken. Does not take `postLimiter`; DEBUG_TOKEN settle is not the shared post burst limiter.
- **Returns / side effects:** Hono app. 503 if token unset; 401 if bearer mismatches; 200 `{ invoices }` on `GET /invoices`, `{ receiptId, messageId, amountSats, resumed }` on `POST /invoices/settle`, `{ ingests }` on `GET /zap-ingests`, and on `POST /spend-ping` either 202 `{ messageId, status: 'accepted' }`, 200 `{ messageId, status: 'skipped', reason }` when that post day is skipped, 409 `{ error: 'Message is not from today' }` when the post UTC day is after the clock, or 503 when `pingOnDay` is missing, the ping fails, or a collaborator throws (the address is the member's verified wallet, `409 { error: 'No Lightning address' }` without one; never returns the address). Manual settle accepts `{ paymentHash, note, preimage? }` and delegates to `settleInvoiceManually`; store throws, including the direct ingest write, map to 503. Listing is newest-first (cap 200). Logs list/settle/spend-ping results without token, note, preimage, nsec, or Lightning address.
- **Used by:** `createApp` at `/debug`.

## Function: debugShopProofsRoutes

- **Purpose:** Operator route group mounted at `/debug/shop-proofs` when the LNURL server resolves: `POST /:id/retry` moves a `stuck` shop payment proof back to unresolved through `retryStuckProof`.
- **Inputs:** `{ shop: ShopPayments, debugToken }`.
- **Returns / side effects:** Hono app. 503 `{ error: 'Debug is not configured' }` when the token is unset or blank; 401 `{ error: 'Unauthorized' }` on a Bearer mismatch; 404 `{ error: 'Not found' }` for a non-UUID or unknown id; 409 `{ error: 'The proof is not stuck' }`; 200 `{ id, result: null }`.
- **Used by:** `createApp`.

## Function: inspectBolt11

- **Purpose:** Decode BOLT11 payment hash, amount, plaintext description, description_hash, and expiry for operator debug (does not change `decodeBolt11`).
- **Inputs:** BOLT11 string; optional decoder inject for tests.
- **Returns / side effects:** `InspectedBolt11` or `null` when malformed, zero-amount, or the amount is not a safe integer.
- **Used by:** `POST /messages/:id/invoice` for the NIP-57 gate (reject before returning `pr`) and when persisting ok / `not_zap` attempts; `POST /messages/:id/repayment` and `POST /messages/:id/repayment/due` for the same gate, the attempt row, and the expiry of an open bill.

## Function: isNip57Invoice

- **Purpose:** True when `descriptionHash` equals `sha256(utf8(zapRequestJson))`.
- **Inputs:** description hash (or null) and zap request JSON string (or null).
- **Returns / side effects:** boolean.
- **Used by:** `POST /messages/:id/invoice` for the NIP-57 gate (reject before returning `pr`); `POST /messages/:id/repayment` and `POST /messages/:id/repayment/due` for the same gate.

## Function: bolt11ExpiresAtMs

- **Purpose:** When a BOLT11 stops being payable: the given issue time plus its `expiry` tag, or plus `DEFAULT_INVOICE_EXPIRY_MS` (3 600 000 ms, the BOLT11 default) when the tag is absent or the invoice does not decode (`inspectBolt11`). Callers pass the time they requested the invoice, so the result is at or before the real expiry. `DEFAULT_INVOICE_EXPIRY_MS` moved here from `src/routes/repayment.ts`.
- **Inputs:** BOLT11 string and the issue time (epoch ms).
- **Returns / side effects:** Expiry instant (epoch ms). No I/O.
- **Used by:** `invoiceStillOpen` and the shop payment mint (`shop_payment.bolt11_expires_at`).

## Function: invoiceStillOpen

- **Purpose:** Whether a stored BOLT11 can still be paid, so repayment and the shop payment compute an invoice's expiry one way. Moved from `src/routes/repayment.ts`.
- **Inputs:** Stored invoice, the time the attempt was recorded, and the clock (epoch ms).
- **Returns / side effects:** `nowMs < bolt11ExpiresAtMs(pr, createdAtMs)`. No I/O.
- **Used by:** `src/routes/repayment.ts` (whether an outstanding repayment bill can still be paid).

## Function: resolveVapidConfig

- **Purpose:** Resolve self-hosted Web Push VAPID credentials from an environment slice without failing boot when keys are missing or unusable.
- **Inputs:** `env` record (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, optional `VAPID_SUBJECT`).
- **Returns / side effects:** `{ publicKey, privateKey, subject }` when both keys decode (URL-safe base64) to 65-byte uncompressed P-256 public and 32-byte private, and `subject` is `https:` or `mailto:` (default `https://21.gifts`). Otherwise `null`. Never logs the private key. `src/index.ts` still try/catches `WebPushSender` construction so a library throw cannot kill listen.
- **Used by:** `createApp` (public key for HTTP), `src/index.ts` (sender; the push worker starts on every boot, with or without VAPID).

## Function: resolveLnurlServerConfig

- **Purpose:** Resolve the self-hosted LNURL server from `LNURL_SERVER_URL` and `PUBLIC_BASE_URL`. Both values are trimmed and one trailing `/` is removed. Returns `null` when `LNURL_SERVER_URL` is unset or blank, when either value fails `new URL()`, or when either protocol is not `http:` / `https:`. When set, `createApp` mounts the forwarded LNURL routes and `PUT /me/wallet`.
- **Inputs:** `env` record (`LNURL_SERVER_URL`, `PUBLIC_BASE_URL`).
- **Returns / side effects:** `{ baseUrl, publicBaseUrl, host }` (`host` is `new URL(publicBaseUrl).host`) or `null`. No I/O. Not a secret.
- **Used by:** `createApp`.

## Function: resolveShopPaymentConfig

- **Purpose:** Resolve the shop payment configuration from the environment, following `resolveLnurlServerConfig`: any missing or invalid value turns the stablecoin rows off and the process still boots. `ORCHESTRA_BASE_URL` must be an absolute `https` origin without path, query, fragment, or user info (one trailing `/` is trimmed); `ORCHESTRA_API_KEY` a server key starting `fn_` (a client key `fnp_…` is refused); `SHOP_EVM_RPC` a non-empty JSON object from a decimal chain id (no sign, no leading zero) to an absolute `https` URL without user info; `SHOP_REFUND_ADDRESS` `0x` and 40 hexadecimal characters. Values are trimmed. Never logs a value.
- **Inputs:** `env` record.
- **Returns / side effects:** `{ orchestraBaseUrl (origin), orchestraApiKey, evmRpc: Map<chainId, url>, refundAddress (lowercase) }` or `null`. No I/O.
- **Used by:** `createApp` and `src/index.ts`.

## Function: IpRateLimiter

- **Purpose:** In-process per-address sliding window (`IP_RATE_WINDOW_MS` = 60_000). At most `limit` hits inside the window are allowed. `clientIp === null` (no validated client address on the request) is always allowed and never counted. Expired buckets are swept at most once per window so the map stays bounded.
- **Inputs:** Constructor `limit: number`. `allow(clientIp, nowMs)` records one request when under the limit.
- **Returns / side effects:** `allow` is `true` when allowed, `false` when over the limit (not recorded). Process-local only.
- **Used by:** `lnurlServerRoutes` (one limiter per route) and the wallet-backed branch of `wellKnownRoutes`.

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
- **Inputs:** Constructor none. Methods match `PushStore` (`upsertSubscription` keeps original `createdAt` on endpoint conflict and replaces account, keys, and `sessionToken`; `deleteStaleSubscription(sub)` removes the endpoint only while account and `sessionToken` still equal the listed row, so a rebind after the read survives; `claimPending` leases oldest pending; `markSent(id, nowMs)` stamps `finishedAt`; `markFailed(id, nowMs)` fails at 8 attempts and then stamps `finishedAt`; `deleteFinishedOutbox(beforeMs)` removes `sent`/`failed` rows whose `finishedAt`, else `createdAt`, is before the cutoff and never a pending row; `recordDelivered` unions unique endpoint URLs onto the outbox row; `countBroadcastOutbox` counts the rows of one broadcast (`messageId` and payload tag `broadcast:<id>`) as queued, pending, delivered (sent or failed with at least one delivered endpoint), dropped (sent with none), and failed (failed with none)). Operator dump: `listAllSubscriptions()` newest `createdAt` then `endpoint` DESC; `listAllOutbox(limit)` newest `createdAt` then `id` DESC.
- **Returns / side effects:** Caller-owned copies including `deliveredEndpoints` slices; mutating results does not change the store. No I/O.
- **Recovery commit:** `removeAccountSubscriptions(accountId)` deletes every subscription of one account synchronously and returns how many it removed; `InMemoryAuthStore.commitRecovery` calls it through `usePushStore`.
- **Used by:** `createApp` default `pushStore`; memory `src/index.ts` when boot omits SQL push.

## Function: InMemoryNotificationStore

- **Purpose:** Process-local `NotificationStore` for in-app forum post, reply, zap, moderator appointment, and open moderator-proposal notifications. Default empty so the process boots without a database. `deleteByMessageIds` removes rows whose `parentId` or `replyId` is in the id list (any type). `deleteByTypeAndReplyId` removes rows whose `type` and `replyId` both match. `deleteForRecipient` splices rows whose `id` is in the id list and whose recipient is that account (empty `ids` is a no-op; never another recipient). Mark-read and mark-all skip `moderator_proposal`. `markReadByMessage` stamps unread `forum_post`, `forum_reply`, `forum_mention`, `zap`, and `heart` for that account when `parentId` or `replyId` equals the message id, returns those rows sorted by id, and returns `[]` on a second call. It does not stamp `moderator_appointed` or another account. `markReadForVisibleMessage` stamps unread `forum_post`, `forum_reply`, and `forum_mention` for that account when `replyId` equals the message id, returns those rows sorted by id, and returns `[]` on a second call. It does not match `parentId`, and it does not stamp `zap`, `moderator_appointed`, or another account. `markRead` returns `{ row, stamped }` and `stamped` is true only when this call changed `readAt` from null.
- **Inputs:** Optional seed `NotificationRow[]` (copied). `create` is unique on `(recipientAccountId, type, replyId)` and returns the existing row on duplicate. `listByRecipient(accountId, limit)` is newest `createdAt` then `id` DESC. `unreadCount` is total unread (`readAt === null`), not page length. `markRead` returns `{ row, stamped }` and `stamped` is true only when this call changed `readAt` from null. `markAllRead` stamps unread rows only except `moderator_proposal` (left unread). `deleteByMessageIds(ids)` is a no-op for empty `ids`. `deleteByTypeAndReplyId(type, replyId)` returns the removed count. `deleteForRecipient(accountId, ids)` is a no-op for empty `ids`. Operator dump: `listAll(limit)` newest-first (cap 200).
- **Returns / side effects:** Promise of row copies; mutating results does not change the store. No I/O.
- **Used by:** `createApp` default `notificationStore`; memory `openBootStores` omits it.

## Function: PostgresPushStore

- **Purpose:** Durable `PushStore` over Postgres (`push_subscription`, `push_outbox`). Same port semantics as the in-memory adapter, including claim leases, attempt counting, and `recordDelivered` for successful endpoint URLs. `claimPending` returns the leased rows oldest `createdAt` then `id`, because `RETURNING` does not keep the subquery order.
- **Inputs:** Constructor takes a shared boot `SqlClient` (already migrated via `migratePushSchema`). `upsertSubscription` sets `session_token = EXCLUDED.session_token` on endpoint conflict. `deleteStaleSubscription` deletes `WHERE account_id = $1 AND endpoint = $2 AND session_token IS NOT DISTINCT FROM $3`. `markSent` / terminal `markFailed` set `finished_at`. `deleteFinishedOutbox` runs `DELETE FROM push_outbox WHERE status IN ('sent', 'failed') AND COALESCE(finished_at, created_at) < $1 RETURNING id`. `countBroadcastOutbox(broadcastId)` runs `SELECT status, count(*), count(*) FILTER (WHERE delivered_endpoints <> '[]') FROM push_outbox WHERE message_id = $1 AND payload::jsonb ->> 'tag' = $2 GROUP BY status` with `$2` = `broadcast:<broadcastId>`, then adds pending rows to `pending` and, per finished status, the rows with a delivered endpoint to `delivered` and the rest to `failed` or `dropped`. Operator dump: `listAllSubscriptions` (`ORDER BY created_at DESC, endpoint DESC`); `listAllOutbox(limit)` newest `created_at` then `id`.
- **Returns / side effects:** Parameter-bound SQL; maps snake_case rows to domain objects including `delivered_endpoints` JSON. Errors propagate to callers.
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: PostgresNotificationStore

- **Purpose:** Durable `NotificationStore` over Postgres (`notification`). Same port as the in-memory adapter: unique create, newest-first list, total unread count, get/mark-one/mark-all for the recipient only (mark-read / mark-all skip `type = 'moderator_proposal'`), `markReadByMessage` (`UPDATE … RETURNING` via `sql.query`, not `sql.execute`, for unread `forum_post` / `forum_reply` / `forum_mention` / `zap` / `heart` where `parent_id` or `reply_id` matches, sorted by id in JS; a second call returns `[]`), `markReadForVisibleMessage` (`UPDATE … RETURNING` via `sql.query` for unread `forum_post` / `forum_reply` / `forum_mention` where `reply_id` matches, not `parent_id`, not `zap`, sorted by id in JS; a second call returns `[]`), `deleteByMessageIds` (`parent_id` or `reply_id` in the id list; the ids are bound as one `uuid[]` array-literal string built from well-formed UUIDs only, because the driver does not encode a JavaScript array for `$1::uuid[]`), `deleteByTypeAndReplyId` (`DELETE FROM notification WHERE type = $1 AND reply_id = $2 RETURNING id`), and `deleteForRecipient` (`DELETE FROM notification WHERE recipient_account_id = $1 AND id = ANY($2::uuid[]) RETURNING id`; `$2` is the same `{uuid,uuid}` array-literal string; empty `ids` or no well-formed UUID skips SQL and returns 0). `markAllRead` also uses `sql.query` because it returns the stamped rows. `markRead` returns `{ row, stamped }` and `stamped` is true only when this call changed `readAt` from null, which is only when `UPDATE … RETURNING` yields a row, never on the fallback select.
- **Inputs:** Constructor takes a shared boot `SqlClient` (already migrated via `migrateNotificationSchema`). Operator dump: `listAll(limit)` newest-first (cap 200).
- **Returns / side effects:** Parameter-bound SQL; maps snake_case rows to `NotificationRow`. `markRead` returns `{ row, stamped }`; `stamped` is true only when this call changed `readAt` from null, and only when `UPDATE … RETURNING` yields a row, never on the fallback select. Unique violation re-selects the existing row. Errors propagate to the route (503).
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: markReadByMessage

- **Purpose:** Store method on `InMemoryNotificationStore` and `PostgresNotificationStore`. Stamps `readAt` on unread `forum_post`, `forum_reply`, `forum_mention`, `zap`, and `heart` rows for one account when `parentId` or `replyId` equals the message id. Does not stamp `moderator_appointed`, `moderator_proposal`, another account, or an already-read row.
- **Inputs:** `accountId`, `messageId`, and `readAt`. Postgres runs `UPDATE … RETURNING` via `sql.query`, not `sql.execute`.
- **Returns / side effects:** Newly stamped row copies, sorted by `id` ascending. A second call returns `[]`.
- **Used by:** `POST /notifications/read-by-message`.

## Function: enqueueNotificationDismiss

- **Purpose:** Enqueue dismiss Web Push rows so other devices close banners for tags this account just marked read. Empty `tags` is a no-op and does not throw. Tags are uniqued first-seen, then written in chunks of 30. Each row has type `dismiss`, `messageId` null, and `skipEndpoints` `[endpoint]` or `[]`.
- **Inputs:** `pushStore`, `accountId`, `tags`, `nowMs`, `unreadCount`, and optional `skipEndpoint`.
- **Returns / side effects:** Resolves after every chunk is attempted. A throwing `enqueue` logs `push.dismiss.failed` and does not throw. The payload is `{ type: 'dismiss', tags, unreadCount }` and does not contain an endpoint.
- **Used by:** `notificationRoutes` after read-all, read-by-message, read-visible, and a freshly stamped single read.

## Function: enqueueForumPushes

- **Purpose:** Enqueue one forum notification per bell subscriber except the skip id (`authorId`). Payload URL is `/messages/<messageId>`; tag is `forum_post:<messageId>`.
- **Inputs:** `PushStore`, `authorId` (skip id / post actor), `messageId` (forum post id; outbox id and payload tag), `nowMs`. Payload from `buildForumPushPayload` with name `Someone`, text `''`, and no media flags.
- **Returns / side effects:** One pending `type: 'forum'` outbox row per other subscriber account. Does not send HTTP push itself.
- **Used by:** Unit tests; production path is `notifyForumPost`.

## Function: enqueueReplyPush

- **Purpose:** Enqueue one reply notification per bell subscriber except the skip id. Payload URL is `/messages/<messageId>`; tag is `forum_reply:<messageId>` (the reply id, not the parent).
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

## Function: enqueueBroadcastPush

- **Purpose:** Enqueue one operator broadcast row per distinct account on the push outbox, so the push worker delivers it with the same batch, lease, and retry rules as every other notification.
- **Inputs:** `PushStore`, recipient `accountIds` (duplicates enqueued once), `BroadcastPushMessage` (`broadcastId`, `title`, `body`, `url`), `nowMs`. Payload `{ type: 'zap', title, body, url, tag: 'broadcast:<broadcastId>' }` (the debug ping's type).
- **Returns / side effects:** Number of rows enqueued. Each row has outbox type `zap` and `messageId` = `broadcastId`, and payload tag `broadcast:<broadcastId>`, which `countBroadcastOutbox` reads back. Does not deliver.
- **Used by:** `debugPushBroadcastRoutes` (`POST /debug/push-broadcast`).

## Function: runPushWorkerTick

- **Purpose:** Claim a batch of pending outbox rows and deliver each payload to every subscription for the recipient account except endpoints listed in `skipEndpoints`. A skipped endpoint is not sent and is not recorded as delivered. Before each send the subscription's `sessionToken` must still pass `resolveSession` for the subscription's account (known, not past `SESSION_TTL_MS`, account not session-refused); otherwise the subscription is deleted (`deleteStaleSubscription`, so a concurrent rebind survives) and not sent to, so a device whose login ended stops receiving notification text. When every subscription is skipped, or none remain, the row is `markSent`.
- **Inputs:** `PushWorkerDeps` (`store`, `sender`, `now`, `authStore`). Batch size and lease from module constants.
- **Returns / side effects:** No-op when `sender.isConfigured()` is false. Records successful endpoints via `recordDelivered` and does not resend them on retry; deletes gone subscriptions without recording them (`deleteStaleSubscription`, so an endpoint rebound to another session meanwhile stays); logs `push.send.failed` with optional numeric `status` (HTTP status from the sender) and no endpoint/keys/payload, then `markFailed` on fail after recording successes, except a failed send is `markSent` (not `markFailed`) when the same claim includes a dismiss whose tags include that row's payload tag for the same account; `markSent` when remaining sends succeed / all gone / no subs left to try.
- **Used by:** `startPushWorker` interval; unit tests.

## Function: startPushWorker

- **Purpose:** Start a periodic `setInterval` that runs `runPushWorkerTick` until stopped, and run `sweepPushStore` once at start and then every `PUSH_SWEEP_INTERVAL_MS` (1 hour).
- **Inputs:** `PushWorkerDeps` and optional `intervalMs` (default `PUSH_WORKER_INTERVAL_MS` = 2s).
- **Returns / side effects:** `{ stop }` clears both intervals. A tick still running skips the next interval. A rejected tick logs `push.tick.failed` with `errorLogFields` only (a tick queries by session token, and an unhandled rejection would reach the process handler, which prints the raw error and exits); the next tick still runs. A rejected sweep logs `push.sweep.failed` with `errorLogFields` only (name and driver code, never the message, which can embed bound values such as a session token), and the next sweep runs on schedule.
- **Used by:** `src/index.ts` on every boot. Without VAPID the ticks send nothing, but the sweep still runs.

## Function: listAccountIdsWithLiveSubscriptions

- **Purpose:** Account ids the push worker would send to: each account with at least one subscription whose session still authenticates it (same rule as `runPushWorkerTick` and `sweepPushStore`: a session token, not expired, account not refused, same account).
- **Inputs:** `PushStore`, `AuthStore`, `nowMs` (session expiry clock).
- **Returns / side effects:** Distinct account ids. Read-only: stale subscriptions stay until the worker or `sweepPushStore` removes them.
- **Used by:** `debugPushBroadcastRoutes` (recipient selection and dry run of `POST /debug/push-broadcast`).

## Function: sweepPushStore

- **Purpose:** Delete every push subscription whose session no longer authenticates its account (unknown or removed session, past `SESSION_TTL_MS`, session-refused account, a session of another account, or a row stored without a session), then every `sent` or `failed` outbox row that finished more than `PUSH_OUTBOX_RETENTION_MS` (7 days) ago. Pending rows are never deleted.
- **Inputs:** `store`, `authStore`, and `now` from `PushWorkerDeps`; the sender is not used.
- **Returns / side effects:** `{ subscriptions, outbox }` deleted counts. Logs `push.sweep` with those counts when either is above zero; no endpoint, token, or payload is logged. Deletes use `deleteStaleSubscription`, so a subscription that another caller removed first, or that a re-POST rebound to a new session after the scan read it, is neither deleted nor counted.
- **Used by:** `startPushWorker`; unit tests.

## Function: parsePushSubscription

- **Purpose:** Validate a browser PushSubscription JSON body into stored endpoint/key fields.
- **Inputs:** Unknown request body expecting `{ endpoint, keys: { p256dh, auth } }`.
- **Returns / side effects:** Parsed fields, or `null` when invalid (blank endpoint, bad url-safe base64 keys, non-https endpoint except localhost http).
- **Used by:** `pushRoutes` `POST /me/push-subscriptions`.

## Function: pushTagForNotification

- **Purpose:** Collapse tag for one notification row: `forum_post:<parentId>`, `forum_reply:<replyId>`, `forum_mention:<replyId>`, `zap:<replyId>`, `heart:<replyId>`, `moderator_appointed:<parentId>`. `moderator_proposal` returns null.
- **Inputs:** `type`, `parentId`, and `replyId` from the row. A zap tag uses `replyId` (the receipt id), not the note id.
- **Returns / side effects:** Tag string or `null`. No I/O.
- **Used by:** `notificationRoutes` when it builds dismiss tags.

## Function: buildForumPushPayload

- **Purpose:** English forum-post payload for every bell subscriber except the actor (`type: 'forum'`, title the collapsed display name or `Someone` when blank, at most 80 code points, body the note text on one line at most 180 code points, or `Posted a photo and a video.` / `Posted a photo.` / `Posted a video.` / `Posted in the living room.` when the text is empty, url `/messages/<postId>` (URI-encoded), tag `forum_post:<postId>`). Shared template: omits optional `unreadCount` (fan-out adds notification unread + listed inbox unread per recipient).
- **Inputs:** `{ postId, name, text, hasPhoto?, hasVideo? }`. `postId` is the tag id. Blank `name` becomes `Someone`. Empty `text` uses the photo/video sentence (`hasPhoto` / `hasVideo` count only when `=== true`; omitted means false). Non-empty text wins over media flags.
- **Returns / side effects:** `PushPayload` object without `unreadCount`; callers `JSON.stringify` before enqueue/send.
- **Used by:** `enqueueForumPushes`, `notifyForumPost`.

## Function: buildReplyPushPayload

- **Purpose:** English forum-reply payload for every bell subscriber except the actor (`type: 'forum'`, same title rule as a forum post, body the reply text on one line at most 180 code points, or `Replied with a photo and a video.` / `Replied with a photo.` / `Replied with a video.` / `Replied in the living room.` when the text is empty, url `/messages/<replyId>` (URI-encoded), tag `forum_reply:<replyId>`; not the parent id). Shared template: omits optional `unreadCount` (fan-out adds it per recipient).
- **Inputs:** `{ replyId, name, text, hasPhoto?, hasVideo? }`. `replyId` is the reply forum message id (`tag` / collapse key). Omitted media flags are false (`=== true` only). Non-empty text wins over media flags.
- **Returns / side effects:** `PushPayload` object without `unreadCount`; callers `JSON.stringify`.
- **Used by:** `enqueueReplyPush`, `notifyForumReply`.

## Function: buildZapPushPayload

- **Purpose:** English zap payload for every bell subscriber except the payer skip id (`type: 'zap'`, title the collapsed payer name or `Someone` when blank, body `Sent <amountSats> sats.` with no thousands separator, url `/messages/<noteId>` when `noteId` is a non-empty string, otherwise `/messages/<messageId>` (URI-encoded), tag `zap:<messageId>`). Shared template: omits optional `unreadCount` (fan-out adds it per recipient).
- **Inputs:** `{ messageId, name, amountSats, noteId? }`. `messageId` is used only in `tag` (receipt UUID on the `notifyZap` path). Optional `noteId` is the forum note to open; a missing or empty value falls back to `messageId`. `amountSats` is rendered with `String` and no thousands separator.
- **Returns / side effects:** `PushPayload` object without `unreadCount`; callers `JSON.stringify` before enqueue/send.
- **Used by:** `enqueueZapPush`, `notifyZap`.

## Function: buildHeartPushPayload

- **Purpose:** English heart-tip payload for the note author only (`type: 'zap'`, title the collapsed payer name or `Someone` when blank, body exactly `Sent you a heart.`, url `/messages/<noteId>` (URI-encoded), tag `heart:<replyId>`). Shared template: omits optional `unreadCount` (notifyHeart adds it per recipient).
- **Inputs:** `{ replyId, name, noteId }`. `replyId` is the receipt-derived UUID used in `tag`. `noteId` is the forum note to open.
- **Returns / side effects:** `PushPayload` object without `unreadCount`; callers `JSON.stringify`.
- **Used by:** `notifyHeart`.

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
- **Returns / side effects:** Hono app with full path literals `/push/vapid-public` and `/me/push-subscriptions`. Session 401 before unconfigured 503. `POST /me/push-subscriptions` stores the bearer token of the request as the subscription's `sessionToken`; a re-POST from another session rebinds the endpoint to it. The push worker sends only while that session resolves for the account and deletes the subscription once it does not.
- **Used by:** `createApp` mounted at `/`.

## Function: debugPushRoutes

- **Purpose:** Operator debug ping that enqueues a test Web Push for one account via `DEBUG_TOKEN` (not an end-user session). Body `{ accountId }`. Returns `{ enqueued }` (`0` or `1`).
- **Inputs:** `DebugPushRouteDeps` (`authStore`, `pushStore`, `now`, `debugToken`, `vapidPublicKey`).
- **Returns / side effects:** Hono app `POST /` mounted at `/debug/push-ping`. Debug 503/401 before JSON; then unconfigured 503; unknown account 404. Calls `enqueueDebugPush`.
- **Used by:** `createApp`.

## Function: debugPushBroadcastRoutes

- **Purpose:** Operator Web Push broadcast via `DEBUG_TOKEN` (not an end-user session): `POST /` queues a title, body, and same-site link for every account with a live push subscription or for listed usernames; `GET /:id` reports the delivery counts.
- **Inputs:** `DebugPushBroadcastRouteDeps` (`authStore`, `pushStore`, `now`, `debugToken`, `vapidPublicKey`). Body `{ title, body, link?, usernames?, dryRun? }` (strict keys; title 1-64 and body 1-240 characters (code points) after trim, no C0 control character or DEL except a newline in the body; link up to 200 characters, one leading `/`, no `//`, backslash, or whitespace; 1-200 usernames).
- **Returns / side effects:** Hono app mounted at `/debug/push-broadcast`. Debug 503/401 before JSON. Accounts with notification level `none` and listed accounts without a live subscription (`listAccountIdsWithLiveSubscriptions`) are counted, not queued; a dry run counts the same live subscriptions. A dry run answers `{ dryRun: true, recipients }` and writes nothing; a send needs VAPID (else 503), calls `enqueueBroadcastPush`, logs `debug.push.broadcast`, and answers 202 `{ id, targeted, queued, optedOut, noSubscription }`. `GET /:id` answers `countBroadcastOutbox` or 404.
- **Used by:** `createApp`.

## Function: resolveLoginsOpenDefault

- **Purpose:** Reads `LOGINS_OPEN_DEFAULT`, the login switch value used until the operator stores one with `PUT /debug/logins`, so a deploy can boot with logins already closed.
- **Inputs:** Environment record.
- **Returns / side effects:** `true` for unset, blank, or `open`; `false` for `closed` (trimmed, any case). Throws `LOGINS_OPEN_DEFAULT must be "open" or "closed"` for any other value, so a typo cannot open logins.
- **Used by:** `createApp`.

## Function: resolveRequiredAppBuild

- **Purpose:** Reads `APP_BUILD_REQUIRED`, the app build id that register, authenticate, and social recovery begin and finish must carry in `X-App-Build`.
- **Inputs:** Environment record.
- **Returns / side effects:** The trimmed value, or `null` when unset or blank (no build check, so staging and local keep working). Pure.
- **Used by:** `createApp`.

## Function: appBuildAccepted

- **Purpose:** Decides whether a request passes the build check.
- **Inputs:** Required build (`string | null`) and the raw `X-App-Build` header (`string | undefined`).
- **Returns / side effects:** `true` when no build is required or the trimmed header equals the required build exactly (case-sensitive); `false` for a missing or different header. Pure.
- **Used by:** `authRoutes` build check on register, authenticate, and social recovery begin and finish.

## Function: LoginGate

- **Purpose:** Decides whether an account may start a session under the operator login switch. Existing sessions are never checked.
- **Inputs:** `LoginGateStore` (exposed as `store`) and the boot default from `resolveLoginsOpenDefault`.
- **Returns / side effects:** `state()` returns `{ open, source, defaultOpen }` (the stored value with `source: 'stored'`, else the default with `source: 'default'`). `admits(account | null)` is `true` while open; while closed `false` for `null` (a new registration), `true` for the platform account (`isPlatform`), otherwise `store.isAllowlisted(account.id)`.
- **Used by:** `createApp` (one instance shared by `authRoutes` and `debugLoginsRoutes`).

## Function: migrateLoginGateSchema

- **Purpose:** Applies `LOGIN_GATE_SCHEMA_SQL`: `app_setting` (`key` primary key, `value`, `updated_at`) and `login_allowlist` (`account_id` primary key referencing `account` with `ON DELETE CASCADE`, `created_at`).
- **Inputs:** `SqlClient`.
- **Returns / side effects:** Void; idempotent DDL execute matching `docs/schema/login_gate.sql`.
- **Used by:** `openBootStores` when SQL opens, after `migrateMemberEventSchema` and before `migrateDbChangeSchema`, so `trg_db_change` attaches to both tables.

## Function: InMemoryLoginGateStore

- **Purpose:** In-memory `LoginGateStore` for memory boots and tests; the switch and allowlist are lost on restart, so a memory boot starts from `LOGINS_OPEN_DEFAULT`.
- **Inputs:** None.
- **Returns / side effects:** `loginsOpen()` is `null` until `setLoginsOpen`; `listAllowlist()` is oldest first, then account id; `addToAllowlist` returns `false` for a listed account and keeps its first `createdAt`; `removeFromAllowlist` returns whether a row was removed. No HTTP.
- **Used by:** `createApp` default, tests.

## Function: PostgresLoginGateStore

- **Purpose:** Durable `LoginGateStore`: the switch is the `app_setting` row `logins_open` (`open` or `closed`), the allowlist is `login_allowlist`.
- **Inputs:** `SqlClient`.
- **Returns / side effects:** `setLoginsOpen` upserts the row with `updated_at`; `loginsOpen()` is `null` without a row, `true` only for `open`. `addToAllowlist` inserts with `ON CONFLICT DO NOTHING` and reports whether a row was returned; `removeFromAllowlist` deletes and reports the same. Every write is logged by `trg_db_change`.
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: debugLoginsRoutes

- **Purpose:** Operator login controls via `DEBUG_TOKEN` (not an end-user session): read and set the login switch, manage the allowlist, and end every session.
- **Inputs:** `DebugLoginsRouteDeps` (`authStore`, `loginGate`, `now`, `debugToken`).
- **Returns / side effects:** Hono app mounted at `/debug` with `GET /logins`, `PUT /logins`, `POST /logins/allowlist`, `DELETE /logins/allowlist/:accountId`, and `DELETE /sessions`. Debug 503/401 before JSON; body 400; unknown account 404. Logs `debug.logins.set`, `debug.logins.allowlist.add`, `debug.logins.allowlist.remove`, and `debug.sessions.deleted`.
- **Used by:** `createApp`.

## Function: debugPasskeyRenewRoutes

- **Purpose:** Operator reopen of the blocking passkey-renew dialog via `DEBUG_TOKEN` (not an end-user session). Body `{ accountId }` UUID. Deletes that account's failed renew rows and returns `{ deleted }`. Refuses when `walletRequired` is true.
- **Inputs:** `DebugPasskeyRenewRouteDeps` (`authStore`, `debugToken`).
- **Returns / side effects:** Hono app `POST /reopen` mounted at `/debug/passkey-renew`. 503/401 before a successful auth check; 400 invalid account; 404 unknown account; 409 when a seed is stored. Calls `deleteFailedPasskeyRenewAttempts` only after those checks. Logs `debug.passkey_renew.reopened` with the account id and the deleted count.
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
- **Inputs:** `id` (message id string), `at` (`Date`, cloned onto newly tagged rows), `byAccountId` (staff account id recorded as `deletedBy`), optional `expectedSats`. With `expectedSats` the call hides only a live target whose `sats` still equals that value, and tags its direct replies only when the target was tagged, in one atomic step; a payment that commits first wins.
- **Returns / side effects:** `Promise<boolean>` — `false` when no row has that id; `true` when the id exists (already tagged or newly tagged). With `expectedSats`, `false` also means nothing changed because the target was already tagged or its `sats` moved. In-memory mutates store rows; Postgres uses one UPDATE CTE (`deleted_at IS NULL` on the target and direct children; with `expectedSats` the target UPDATE also requires `sats = $4` and the reply UPDATE runs only when it returned a row).
- **Used by:** `messagesRoutes` (`DELETE /messages/:id`).

## Function: markUndeleted

- **Purpose:** Unhide a forum note by clearing `deletedAt` / `deletedBy` (Postgres columns `deleted_at` / `deleted_by`). Inverse of `markDeleted`'s cascade: when the target is hidden, also clears every **direct** child whose stamps match the target's (same instant and same staff) before the target is cleared. Already-live targets are a no-op for children. Does not hard-delete rows, media, invoices, zap receipts, or gifts; does not call `deleteById`; does not recreate via `POST /messages`. Live public JSON never exposes the stamps; staff GET of a hidden row may include them.
- **Inputs:** `id` (message id string).
- **Returns / side effects:** `Promise<boolean>` — `false` when no row has that id; `true` when the id exists (hidden or already live). In-memory mutates store rows; Postgres uses one UPDATE CTE (`IS NOT DISTINCT FROM` stamp match on direct children).
- **Used by:** `debugMessagesRoutes` (`POST /debug/messages/:id/restore`).

## Function: setPlace

- **Purpose:** Write the place columns (`place_lat` / `place_lng` / `place_label` plus `place_street` / `place_house_number` / `place_postal_code` / `place_city` / `place_country`) on an existing forum row. The five address columns are all null or all set. Does not change text, event ids, hide stamps, sats, media, or publish state.
- **Inputs:** `id` (message id string), `place` (`ForumPlace | null`), and optional `edit` (`MessageEditRow`). `message_edit` for field `place` stores the full place JSON including `address`.
- **Returns / side effects:** `Promise<boolean | string>` — the shop-pair error string when a complete pin is rejected against the stored description and nothing is written; `false` when no living row has that id (missing or hidden); `true` when the place columns were written or the living pin is unchanged. `null` stores SQL NULL / in-memory `place: null`. No other message column changes. When `edit` is set and the pin changes, a `message_edit` row is written in the same step. An unchanged pin writes no history. A pair-rule rejection writes no history. The in-memory store always applies the pair rule. Postgres applies it only when `SqlClient.transaction` is present.
- **Used by:** `messagesRoutes` (`PATCH /messages/:id/place`).

## Function: textHasHashtagToken

- **Purpose:** Whether `text` contains a `#name` hashtag token. Match is case-insensitive and the token must not be followed by `[A-Za-z0-9_]`, so `#21GiftsShopper` does not match `21GiftsShop`.
- **Inputs:** `text` string and `name` (token without the leading `#`).
- **Returns / side effects:** `boolean`. No I/O. `#21giftsshop` matches `21GiftsShop`; `#21GiftsShopper` does not.
- **Used by:** `messagesRoutes` (`PATCH /messages/:id/place`), `activeShopDays` (`GET /shops/activity`), `InMemoryMessageStore.listPlaces` (`shop` flag), `InMemoryShopIdentityStore.listCandidates`.

## Function: isPubkeyBlocked

- **Purpose:** Check the current external-pubkey kill switch without loading the complete block list. Input is lowercased before lookup in both stores.
- **Inputs:** External Nostr `pubkey` string.
- **Returns / side effects:** `Promise<boolean>` with no writes. In-memory checks one map key; Postgres performs `SELECT 1 FROM nostr_blocked_pubkey WHERE pubkey = $1 LIMIT 1`.
- **Used by:** `indexInboundForumReplies` after external profile lookup and immediately before limiter acquisition, so a concurrent block wins without consuming ingest budget.

## Function: InMemoryMessageStore

- **Shop methods:** `countShopsByAccount` is the uncapped live shop count using assigned shop-account ownership first and author ownership when unassigned; `listShopsByAccount` is the corresponding newest-first capped list with attributed `replyCount`; `countShopsByPubkey` is the uncapped live unassigned external-shop count for a case-insensitive pubkey; `listShopsByPubkey` is its newest-first capped list with attributed `replyCount`.
- **Credit methods:** `countCreditsByAccount` is the uncapped live credit count (`goalRepayable` exactly true) owned by the author via `account_id` (no hashtag, no `shop_account_id`); `listCreditsByAccount` is the corresponding newest-first capped list with attributed `replyCount`; `countCreditsByPubkey` is the uncapped live external-credit count for a case-insensitive pubkey (`account_id` null, no hashtag, no `shop_account_id`); `listCreditsByPubkey` is its newest-first capped list with attributed `replyCount`.

- **Purpose:** Process-local `MessageStore` for the public member forum. Default empty so the process boots without a database. Optional `place` is `{ lat, lng, label, address }` or null (`address` is `{ street, houseNumber, postalCode, city, country }` or null, stored all-or-nothing as `place_street` / `place_house_number` / `place_postal_code` / `place_city` / `place_country`); a reply stores `place: null`. A live media match with the same pin returns the existing row; a different pin throws `place conflicts with live media` (the route maps that to 409). `listPlaces` returns live top-level rows that have both coordinates, newest first, including `address`. `listLiveAssignedShops` returns live top-level rows (`parent_id` null, `deleted_at` null) with `shop_account_id` set, and does not filter the shop hashtag. Photos live in a private map, not on listed rows. Extra stills (indices 1–9) live in a second private map (`getExtraPhoto` / `listExtraPhotos`); `create(row, photo?, video?, extraPhotos?)` stores extras (indices 1..n max 9, ignored when `video` is set, require photo 0 when non-empty); `photoCount` is (photo 0 ? 1 : 0) + extras length. Same port as Postgres: `getById` (still returns soft-hidden rows), `listIdsByPrefix(prefix)` (at most two stored ids whose lowercase form starts with the prefix, prefix not trimmed, including soft-hidden rows), `deleteById` (row, direct replies, photos, invoices, zap receipt ids, on-disk videos, and edit history for those ids), `markDeleted` (stamps `deletedAt` / `deletedBy` on the target and untagged direct replies; never removes media/invoices), `markUndeleted` (clears `deletedAt` / `deletedBy` on the hidden target and stamp-matched direct children; already-live is a no-op for children; never removes media/invoices), `listDirectChildren` (direct children including hidden, createdAt then id), `getByEventId`, `findLiveByAccountContent` (oldest live account+parent+`contentFp`), `accountHasLiveTopLevelPost` (`parentId === null`, exclude profile id, replies do not count), `accountHasLiveTopLevelMediaPost` (same live/top-level/exclude plus photo 0, extra stills, or video; seed `hasPhoto: true` alone is not media), `latestLiveTopLevelMediaId` (newest live top-level id with a stored photo, extra stills, or video, including About me; replies, hidden rows, and other accounts do not count), live-only `listLatest` (top-level, `parentId` null and `deletedAt` null, each row has live `replyCount` of children with an account or a recorded zapper pubkey), live-only `listFeed` (GET `/messages` keyset page, optional `hashtag`; `createApp` calls `useProfileNoteIds` so `listFeed` omits name-copy ids returned by that provider (a real About me id is not included; `account.profileMessageId`, trimmed, blank ignored); a store with no provider does not omit them), `listReplies` (children with an account or a recorded zapper pubkey; live-only unless `includeHidden === true`), `listChildIds` (direct child ids, any `deletedAt`), `countByAccount` (uncapped live post/reply totals for one account), `countByPubkey` (uncapped live external posts, and replies only when the pubkey is a recorded zapper), `countAttributedReplies(parentId)` is that uncapped count of live direct children with an account or a recorded zapper pubkey (0 when the id is unknown), live-only `listPostsByAccount` (newest-first top-level for one account, cap, live `replyCount` of children with an account or a recorded zapper pubkey), live-only `listPostsByPubkey` (same for one external pubkey, case-insensitive, `accountId` null), live-only `listRepliesByAccount` (newest-first replies for one account, cap, no `replyCount`), live-only `listRepliesByPubkey` (same for one external pubkey, empty unless that pubkey is a recorded zapper), `listDebug` (operator newest-first **all** rows: top-level and replies, live and soft-hidden), `postCountsByUtcDay` (living rows only, `deletedAt` null, notes and replies together, grouped by UTC day, days with no rows omitted, no media bytes), `listHidden` (staff newest-hidden-first hidden rows only, `deletedAt` desc then `id` desc), `listDirectChildren` (direct children including hidden, createdAt then id), live-only `listPublishedEventIds`, claim/sign/publish (`claimUnsigned` / `claimUnpublished` skip soft-hidden; unsigned is pending + null `eventId`; lease expires at `claimedUntil`), live-only `listPendingSigned` (pending, no `t=bitcoin`, oldest-first), `clearSignedEvent` (pending and `eventId` still matches `expectedEventId` and the note has no child replies, then nulls `eventId` / `nostrEvent` / `claimedUntil`), live-only `listSignedMissingPhoto` (top-level only, no children, published + photo, kind:1 content lacks `/messages/:id/photo.` plus extension, oldest-first, `sats === 0`, `nostrAttempts < MAX_PUBLISH_ATTEMPTS` (5, preventing a row that can never satisfy a repair scan from being reset forever), pending excluded, video rows excluded so posters are not treated as missing photos), live-only `listSignedMissingVideo` (top-level only, no children, published + video MIME, kind:1 content lacks `/messages/:id/video.`, oldest-first, `sats === 0`, `nostrAttempts < MAX_PUBLISH_ATTEMPTS` (5, preventing a row that can never satisfy a repair scan from being reset forever), pending excluded), live-only `listSignedMissingHashtags` (top-level only, no children, published unpaid, kind:1 content lacks a `#bitcoin` or `#21gifts` token, oldest-first, `sats === 0`, `nostrAttempts < MAX_PUBLISH_ATTEMPTS` (5, preventing a row that can never satisfy a repair scan from being reset forever), pending excluded so fan-out is not starved; optional extras map lists rows whose kind:1 also lacks that account's location token; one-arg still bitcoin/21gifts only; optional `excludeIds` applied before the limit so profile notes cannot fill the batch), `resetSignedEvent` (nulls `eventId` / `nostrEvent` / `claimedUntil`, parks `pending`, clears `nostrPublishEpoch`, increments `nostrAttempts`, and stamps `nostrFirstAttemptAt` once, no-op unless `eventId` still matches, `sats` is 0, and the note has no child replies), `addSats` / `addReceivedSats` / `recordZapReceipt` leave a fiat column unchanged when extra sats are 0 or that delta is null, assign a non-null delta onto a null column, and add when both sides are set; `addReceivedSats` folds `receivedSats` and the four `receivedAmount*` fields and does not change `sats`, the sent fiat amounts, or `goalFundedAt` (missing id is a no-op); `recordZapReceipt` (a reply credits `receivedSats`; a top-level note credits `sats`; duplicate receipt id does not add; ids are released on `deleteById` so the same receipt can be recorded again), `recordInvoiceAttempt` / `listInvoiceAttempts` (each attempt includes `lnurlResponse` object or null), `listRecentOkInvoiceAttempts` (same filter and order as the Postgres query: `result === 'ok'` and `createdAt >= since`, newest-first with `id` descending tie-break), `findOkInvoiceByPaymentHash` / `findOkInvoiceByPr` / `findOkInvoiceByDescription` (newest `result === 'ok'` by payment hash, BOLT11 `pr`, or one message plus description), `listCreditPayers` (positive zap sats per 21.gifts payer; external payers omitted), `sumUnassignedCreditSats` (sats with no payer account), `listRepayments` and `markRepaymentPaid` (in-memory shares; a repeat of the same day and giver is a no-op and does not change `sats`), `listLoanLedger` (identified payer receipts on `goalRepayable` notes that count toward the credit, anonymous receipts excluded, in-memory repayment shares with no freeze, each row sets `owed` when the account authored the note and `credit` when the account paid or receives the repayment, both flags may be true on one row, caller sorts), and `goalFundedAt` set once when a repayable ask first reaches `goalSats`, `listOpenConversationZapEventIds` (returns `{ eventId, conversationMessageId }[]`, one row per ok invoice with both conversation id and conversation message id so the same event id may repeat; no `conversation_message` join — existence filter is in `indexOpenZapReceipts`), `updateZapReceiptGift` (patch payer / gift-reply id / comment; missing receipt is a no-op; omitted patch fields stay), `getZapReceiptGift` (one receipt including comment and gift-reply id), `listZapReceiptsAwaitingGiftReply` (`payerAccountId` or `payerPubkey` set and no gift reply yet, cap, `receiptEventId` ASC, includes `comment`), `recordZapIngest` / `listZapIngests`, `listInvoiceAttemptsForPayer` (uncapped payer filter, newest-first), `listIndexedZapIngests` (uncapped, `outcome = indexed` only), `listAuthoredMessages` (all rows for one account including hidden, no cap), `updateText(id, text)` (mutates `text` only and returns a copy when the shop pair allows it; a hidden or missing id → `undefined`; a complete pin whose new text fails `shopTextProblem` returns that error and writes nothing; sats / photos / event ids unchanged); `create` returns the existing row when `id` is already stored (including after that row's parent was later deleted); a non-null `parentId` requires a live parent (`deletedAt` null), stores `goalSats`, `goalRepayable`, `goalTermDays`, `goalCurrency`, `goalAmount`, and the four goal fiat snapshots null even if the row carried an ask, and throws without appending when the parent is missing or soft-hidden; `updateSignedEvent` returns false on duplicate `eventId`. Store/HTTP order is newest-first; product UX is a messenger group (clients reverse). `create` keeps a top-level `shopAccount` and stores null on a reply. `updateText`, `setPlace`, and `setShopAccount` refuse a hidden row before any mutation (`updateText` → `undefined`, the other two → `false`). `updateText` and `setPlace` return the shop-pair error and write nothing when a complete pin fails `shopTextProblem`. They take an optional history row and push it only when the value changes. `appendEdit` stores a copy and does not change the message. `listEdits` returns copies, newest `createdAt` then `id`, or `[]` when the message has none. `replacePhotos` builds the next stills and then swaps the private maps before it returns, so a failure leaves the previous stills.- **External-zapper methods:** `attributeZapReceipt(receiptEventId, { payerPubkey, zapRequestId, comment })` returns `false` when the receipt is missing, when that receipt already has a different request id, or when another receipt in the map already has that request id. A retry with the same request id on the same receipt is idempotent `true`; otherwise it lowercases and stores the payer pubkey, request id, and comment. `recordZapper(pubkey, receiptEventId, at)` lowercases the pubkey and stores the first row in a private map that `deleteById` and receipt queue updates do not clear; `listZapperPubkeys()` returns its keys; `listZappers(limit)` sorts copied rows by `createdAt DESC, pubkey DESC` and caps them. `blockPubkeyAndHideRows(pubkey, at, byAccountId, messageId)` performs the same insert-or-skip and synchronously scans every live null-account row for a case-insensitive author match, stamps it, and returns the hidden count as one store operation; `unblockPubkeyByMessage(messageId)` removes the first matching map entry and reports whether one was found; `isPubkeyBlocked(pubkey)` lowercases its input and checks that map; `isZapperPubkey(pubkey)` lowercases its input and checks the zapper map; `listBlockedPubkeys()` returns the map keys; `listBlockedPubkeyRows(limit)` sorts copied rows by `blockedAt DESC, pubkey DESC` and caps them. `listUnattributedIndexedReceipts(limit, before?)` returns one row per receipt-map entry whose `payerAccountId`, `payerPubkey`, `zapRequestId`, and `giftReplyId` are all null, paired with its newest indexed ingest frame (`createdAt` DESC, then `id` DESC, matching the SQL `JOIN LATERAL … LIMIT 1`), sorts by immutable ingest `createdAt DESC, receiptEventId DESC`, applies an optional strict `{ createdAt, eventId }` keyset cursor and the cap, and returns copies. Unlike an offset over a changing unattributed set, the cursor cannot skip or repeat rows as attribution removes entries.
- **Bulk read:** `getByIds(ids)` returns a copy of each stored row whose id is in `ids`, as `getById` returns it (listed media flags included); missing ids are left out.
- **Photo types:** `getPhotoContentTypes(id)` returns `{ photo, extras }`: the content type of the stored photo 0 (or null) and of the extra stills in index order as `{ index, contentType }` (`index` = list position + 1), without copying any bytes. An unrecognized type is left out without shifting the indices, as in the Postgres adapter.
- **Photo set:** `getPhotoSet(id)` returns `{ photo, extras }`: copies of the stored photo 0 (or null) and of the extra stills in index order as `{ index, photo }` (`index` = list position + 1), taken in one synchronous step, so no other call can swap the set between photo 0 and the extras. An unrecognized type is left out without shifting the indices, as in the Postgres adapter.
- **Payment claims:** `claimZapPayment` keeps one owner receipt id per lowercase payment hash in a process-local map. The same receipt id may claim again; another id is refused. `deleteById` does not remove the claim, so a re-created message id cannot be credited twice for one payment. `zapPaymentReceiptId` reads the owner from that map without claiming (`undefined` when unclaimed).
- **Credit hard delete:** `deleteById` returns `false` and changes nothing when the target is a credit note (`goalRepayable === true`) with `sats > 0`, the same rule as the Postgres store. Rows are removed before any video file is unlinked, so no payment can land between the check and the removal.
- **Inputs:** Optional seed `MessageRow[]` (copied; `hasPhoto` defaults false; missing `deletedAt` / `deletedBy` become null). Operator dump: `listExtraPhotoMeta(limit)`, `listZapReceipts(limit)`, and `listZapPayments(limit)` newest-first (cap 200). `listLatest(limit)` is live top-level only with live `replyCount` of children with an `accountId`, or with an `authorPubkey` that is a recorded zapper. `listFeed(query)` is a live top-level keyset page (`mode` / `limit` / exclusive `cursor` / `staffAccountIds` (`active` only) / optional `hashtag` token filter on `text`, cap 1–200, same live `replyCount` as `listLatest`; `createApp` calls `useProfileNoteIds` so `listFeed` omits name-copy ids returned by that provider (a real About me id is not included; `account.profileMessageId`, trimmed, blank ignored). A store with no provider does not omit them. `active` keeps paid rows (`sats > 0`) and staff unpaid rows; a top-level row with `goalSats` > 0 and `sats = 0` is not active). `listReplies(parentId, limit?, includeHidden?)` is oldest-first children with an `accountId`, or with an `authorPubkey` that is a recorded zapper (default 200; live-only unless `includeHidden === true`). `listRecentReplies(limit)` (newest live replies that have a non-empty event id, even when the parent is outside listLatest; no zapper filter; copies; no photo bytes). `listChildIds(parentId)` returns direct child ids (any `deletedAt`). `countByAccount(accountId)` is uncapped live `{ postCount, replyCount }` for that author. `countByPubkey(pubkey)` is uncapped live `{ postCount, replyCount }` for an external pubkey (`accountId` null, case-insensitive); `replyCount` is 0 unless the pubkey is a recorded zapper. `countAttributedReplies(parentId)` is that uncapped count of live direct children with an account or a recorded zapper pubkey (0 when the id is unknown). `listPostsByAccount(accountId, limit)` is newest-first live top-level for that author with live `replyCount` of children with an `accountId`, or with an `authorPubkey` that is a recorded zapper (cap). `listPostsByPubkey(pubkey, limit)` is the same list for an external pubkey. `listRepliesByAccount(accountId, limit)` is newest-first live replies for that author (cap, no `replyCount`). `listRepliesByPubkey(pubkey, limit)` is the same list for an external pubkey and is empty unless that pubkey is a recorded zapper. `listDebug(limit)` is newest-first all rows including hidden and replies. `postCountsByUtcDay()` groups living rows (`deletedAt` null), notes and replies together, by UTC day and omits empty days. `listHidden(limit)` is newest-hidden-first hidden rows only (`deletedAt` desc, then `id` desc). `listPublishedEventIds(limit)` is newest-first non-null live top-level `eventId`s. `create(row, photo?, video?, extraPhotos?)` returns the stored row when `id` is already present (no append, no second video write) even if that row's parent was later deleted; a non-null `parentId` requires a live parent (`deletedAt` null), stores `goalSats`, `goalRepayable`, `goalTermDays`, `goalCurrency`, `goalAmount`, and the four goal fiat snapshots null even if the row carried an ask, and throws without appending when the parent is missing or soft-hidden; otherwise appends a copy, or returns the existing live media match without a second video write when the pin matches; a different pin throws `place conflicts with live media`; extras indices 1..n max 9, ignored when `video` is set, require photo 0 when non-empty; `getPhoto(id)` returns a photo copy or null; `getExtraPhoto(id, index)` / `listExtraPhotos(id)` return extra stills from the private map; `photoCount` is (photo 0 ? 1 : 0) + extras length; `markDeleted(id, at, byAccountId)` returns false when missing; `markUndeleted(id)` returns false when missing.
- **Returns / side effects:** Promise of row/photo copies; mutating results does not change the store. Listed objects never expose bytes or `contentFp`. When `id` is new, `video` is set, and no live fingerprint match exists, `create` awaits `writeForumVideo` (disk under `MEDIA_DIR`); if that write throws, the row is never pushed (no unlink).
- **Used by:** `createApp` default `messageStore`.
- **Free first post:** `accountHasTopLevelPost(accountId, excludeId)` is true when the account has a top-level row other than `excludeId` (the profile note), live or soft-hidden; replies do not count. `createFirstPost(row, excludeId)` stores a text-only top-level row through `create` only when that check is false, and returns `undefined` otherwise. A process-local claim set per account makes a second concurrent call return `undefined` while the first is still storing. A reply or a row without `accountId` throws `first post must be a top-level note of an account`.
- **Welcome gift:** `accountHasWelcomeGift(accountId, platformAccountId)` is true when a platform reply whose trimmed text is `Welcome` exists under one of the account's notes, live or soft-hidden. Used by the welcome ping and the spend invoice routes so the welcome gift is paid once per account.
- **Photo revision:** `photoRevision(id)` returns a per-note counter, `0` until a write changes the stills `getPhotoSet` returns (photo 0 or an extra: stored index, content type or bytes), then raised by one per such write (`create`, `updatePhoto`, `replacePhotos`, `deleteById`; unknown ids are `0`). A write that stores the same stills (an unrecognized type is not part of the set) leaves it unchanged; the comparison runs once per write, and the read copies and hashes no bytes. The counter is never removed, so it never goes back. `InMemoryShopIdentityStore` uses it as its photo fingerprint.
- **Shop identity:** `setShopNpub(id, npub)` attaches the npub of a shop key to the row (called by `InMemoryShopIdentityStore`); `deleteById` returns `false` for a row with one, so the identity never dangles. `listPlaces` rows carry `shopNpub` only while `isListedShop` holds, otherwise `null`.

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
- **Inputs:** Optional seed threads and messages (copied). Optional third constructor seed of last-read rows is copied. Open helpers are idempotent per unique counterpart. `openMemberPlatform` updates `accountB` when the stored platform id differs. `retargetMemberPlatform` points every member→platform thread at the new official account except rows whose member is that account. `listVisible(accountId, staff, platformId, limit, moderator = false)` is newest `lastMessageAt` then `id` DESC. `hasInboundMessage` is true when any message on that conversation id is inbound for the viewer (`conversationIsInbound`). `countUnread` is the inbound unread message count on that conversation id (`0` when none). `unreadCount(accountId, staff, platformId, moderator = false)` does not keep a thread only because its latest message is from the viewer (`moderator_group` is still included when the 4th arg is true). The number still matches the GET `/conversations` envelope because those extra rows are `unread: false`. `appendMessage(row, photo?, extraPhotos?)` copies stills; `getPhoto(id)` and `getExtraPhoto(id, index 1–9)` look up those copies (index outside 1–9 is null). Operator dump: `listAll(limit)` / `listAllMessages(limit)` / `listAllReads(limit)` (cap 200).
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

- **Purpose:** Maps a SQL `gift` row (`paid_at`, `amount_sats`, `recipient_wos_user`, `kind`, optional `description`) onto a `GiftRow`. An unknown or missing `kind`, including `'other'`, throws `Error('invalid gift kind')` and is not treated as `daily`.
- **Inputs:** `GiftQueryRow` (Date or string timestamp; numeric/string/bigint sats; `kind` text; `description` when the query selects it, as the production outbound query does).
- **Returns / side effects:** `{ paidAt, amountSats, recipientWosUser, kind, description }` (`description` is `undefined` when not selected) with `kind` one of `daily`, `welcome`, or `moderator`. No I/O.
- **Used by:** Production `QueryGiftStore` query in `openBootStores`.

## Function: QueryGiftStore

- **Purpose:** GiftStore that delegates `listOutbound` to an injected stats query and optional `listDebug` to a full-column dump query (Postgres in production).
- **Inputs:** `() => Promise<GiftRow[]>` plus optional `() => Promise<GiftDebugRow[]>`.
- **Returns / side effects:** `listOutbound` is the stats query result. `listDebug(limit)` uses the dump query when set (full `gift` columns, newest `paidAt` first, then sliced to `limit`); otherwise it maps `listOutbound` onto debug rows. Errors propagate to the route (503).
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: checkSpendAuth

- **Purpose:** Timing-safe compare of the spend-worker Bearer token to `SPEND_API_TOKEN`.
- **Inputs:** Configured token (may be unset) and the raw `Authorization` header.
- **Returns / side effects:** `unconfigured` | `unauthorized` | `ok`. Does not throw on length mismatch.
- **Used by:** `invoiceRoutes`.

## Function: syncWelcomePing

- **Purpose:** Tell spend a verified account is owed the one-time 1 USD welcome gift. The note is the newest live top-level photo or video, including About me. Pass one account after a top-level post, an About-me save, or a verification. Pass the auth store with no account to catch up every already verified account that has a live top-level photo or video, whether that note is About me or a living-room post. The process does that on boot and every 15 minutes. Omitted spend ping, a role other than `verified`, no receiving address (no verified wallet, or `lnurlServer` omitted), or no media is a no-op. The pinged address is the wallet-backed receiving address. The welcome gift is once per account: an account that already has a platform `Welcome` reply under one of its notes (`accountHasWelcomeGift`, live or hidden), or a recorded `welcome` gift with description `21gifts welcome` under its username at or after its wallet verification in `gifts`, is not pinged again (`spend.ping.skipped` / `welcomed`), whichever address it went to.
- **Inputs:** `{ spendPing?, messages, auth, gifts?, account?, lnurlServer? }`. `auth` is always required (it finds the platform account); with `account` only that account is pinged, without it every verified account is caught up. A failing platform or gift lookup logs `spend.ping.failed` and pings nothing.
- **Returns / side effects:** `Promise<void>`. May POST spend `kind: "welcome"`. Failures log `spend.ping.failed` and do not throw.
- **Used by:** `POST /messages`, `PUT /me/about`, `POST /trust/verify`, and the process catch-up on boot and every 15 minutes.

## Function: resolveSpendPing

- **Purpose:** Resolve a spend ping collaborator from env. Unset or blank `SPEND_URL` or `SPEND_API_TOKEN` → `undefined` (caller skips). Trims both values and strips trailing slashes from the URL. The process still boots. When both env values are set, `opts.rosterStore` is required and a missing store throws `Daily roster store is required`. An optional third argument also forwards a gift ledger, a clock, an account lookup, and the LNURL server config.
- **Inputs:** `env` (`Record<string, string | undefined>`), `fetchImpl` (`FetchFn`), and optional `{ rosterStore?, gifts?, now?, accounts?, lnurlServer? }`.
- **Returns / side effects:** `HttpSpendPing` when both env values are set; otherwise `undefined`. No HTTP.
- **Used by:** `createApp`, and the process entry `src/index.ts`, which forwards the boot gift store, the auth store as `accounts`, and the LNURL server config. A zap-composed daily ping then uses the same welcome-paid skip. Welcome kind does not read the ledger.

## Function: decideSpendInstruction

- **Purpose:** Choose the USD amount and memo for one spend ping from a live roster object and, for daily, an optional grant status and an optional same-UTC-day welcome flag. No I/O. Daily, in this order: (1) `paymentsEnabled === false` is `{ skip: 'payments_disabled' }` before the welcome flag, the row lookup, and the grant, including a listed row and an unlisted admitted address; (2) the pay-or-skip computation, unchanged aside from happening before the flag: a countable listed row (finite `amountUsd > 0`, first countable match; a row with a string `accountId`, as in the stored roster, matches only `input.accountId`, a row without one, as in spend's live roster, matches the address case-insensitively without trim) returns that `amountUsd` and the roster comment and ignores `grantStatus`, including `'rejected'` and an omitted status; not listed, `grantStatus` `'admitted'` or `'trial'`: `amountUsd` is `roster.defaultAmountUsd` when that value is a finite number `> 0`, otherwise `1`, and the comment is the roster comment (`''` when missing or not a string); not listed, `grantStatus` `'none'`, `'pending'`, or `'rejected'`: `{ skip: 'not_listed' }`; not listed and `grantStatus` omitted: `{ skip: 'undecided' }`; (3) `{ skip: 'welcome_paid' }` only when that result is a pay and the computed comment is not exactly `Welcome`. A computed comment of exactly `Welcome` is returned as the pay even when the flag is true. A computed skip is returned unchanged. Welcome ignores `grantStatus` and the welcome flag. `paymentsEnabled === false` is `{ skip: 'payments_disabled' }` before the amount; otherwise Welcome is `amountUsd` 1 and comment exactly `"Welcome"`. Moderator logic is unchanged and ignores `grantStatus` and the welcome flag; a missing `moderators` field is still undecided even if `grantStatus` is present.
- **Inputs:** `{ address, accountId?, kind: 'daily' | 'moderator' | 'welcome', roster, grantStatus?: SpendGrantStatus, welcomePaidOnUtcDay?: boolean }`. `accountId` is the account that receives on `address`, when known.
- **Returns / side effects:** `{ amountUsd, comment }` or `{ skip: 'payments_disabled' | 'not_listed' | 'undecided' | 'welcome_paid' }`. No I/O.
- **Used by:** `HttpSpendPing` and `decideCliDailyInstruction`.

## Function: decideCliDailyInstruction

- **Purpose:** Choose the daily spend amount, comment, and optional forum message id from already-known facts so the spend worker only signs. Early skips are no passkey, no live top-level non-profile post, no media, then not eligible. Remaining cases call `decideSpendInstruction` for kind `daily` and forward that skip, or copy the pay amount and comment and include `messageId` only when it is a non-empty string. A computed comment of exactly `Welcome` is a pay even when the same-UTC-day welcome flag is true. No I/O.
- **Inputs:** `{ address, accountId?, hasPasskey, hasPosted, hasMedia, eligible, messageId, roster, grantStatus?: SpendGrantStatus, welcomePaidOnUtcDay?: boolean }`. `accountId`, `grantStatus`, and the welcome flag are passed through only when provided.
- **Returns / side effects:** `{ action: 'skip', reason }` or `{ action: 'pay', amountUsd, comment }` plus `messageId` only when the decision includes it. No I/O.
- **Used by:** `spendInstructionRoutes`.

## Function: welcomeGiftPaidOnUtcDay

- **Purpose:** Whether outbound gifts already record a welcome gift for this handle on a UTC day. Matches `kind === 'welcome'` only. The handle is the trimmed local part before the first `@`, or the whole trimmed string when there is no `@`, compared case-insensitively. Empty handles and an invalid `paidAt` do not match. `utcDay` is the caller's `YYYY-MM-DD` and is not recomputed.
- **Inputs:** `gifts` (outbound gift rows), `address` (Lightning Address or handle), `utcDay` (`YYYY-MM-DD`).
- **Returns / side effects:** `true` when at least one gift matches kind, handle, and day. No I/O.
- **Used by:** `HttpSpendPing`, `POST /invoices`, and `spendInstructionRoutes`.

## Function: HttpSpendPing

- **Purpose:** Read the daily roster from `DailyRosterStore`, then POST `{spendUrl}/ping` with Bearer `SPEND_API_TOKEN`. For a daily ping, a configured gift ledger is read after that store read and before the decision; `welcomeGiftPaidOnUtcDay` sets the same-UTC-day flag. A list throw logs `spend.ping.failed` and does not POST. Omitted gifts leave the flag unset. A decided daily body is `{ address, messageId, amountUsd, comment }` (no `kind` key); welcome is `{ address, messageId, kind: "welcome", amountUsd, comment }`; moderator is `{ address, kind: "moderator", groupMessageId, amountUsd, comment }` (no `messageId` key). Skipped reasons `payments_disabled`, `not_listed`, `undecided`, and `welcome_paid` log `spend.ping.skipped` and do not POST. For `ping`, 2xx (including 200 skipped and 202 accepted) logs `spend.ping.ok`. Network, abort, non-2xx, a store read throw, a live GET failure, and a gift-ledger throw log `spend.ping.failed` and resolve. Never throws. Never logs the token. When `rosterStore.hasBeenWritten()` is false, GET `{spendUrl}/daily-roster` with the Bearer token, decide from that JSON object, and do not import it. A non-2xx response, a throw, null, an array, or any other non-object logs `spend.ping.failed` and does not POST. When the store has been written, read only the store and do not GET; its rows name accounts, so the pinged address is resolved with `accountByReceivingAddress` (configured `accounts` and `lnurlServer`) and the row of that account counts. Without `accounts`, or for an address no verified wallet receives on, no stored row matches. A throw of that lookup logs `spend.ping.failed` and does not POST (`pingOnDay`: `{ status: 'failed' }`). `pingOnDay` books a daily ping on the caller-supplied UTC day `YYYY-MM-DD` instead of the clock day. Kind is always daily. The POST body is `{ address, messageId, amountUsd, comment, day }`. The welcome-paid check uses that day. A decided skip logs `spend.ping.skipped` and returns `{ status: 'skipped', reason }` without posting. HTTP 202, and HTTP 200 whose JSON `status` is `accepted`, log `spend.ping.ok` and return `{ status: 'accepted' }`. HTTP 200 whose JSON `status` is `skipped` with a non-empty string `reason` logs `spend.ping.skipped` and returns `{ status: 'skipped', reason }`. Any other HTTP status, a non-object JSON body, a JSON parse failure, a roster read failure, a gift-ledger failure, and a throw log `spend.ping.failed` and return `{ status: 'failed' }`. `pingOnDay` never throws and never returns a Lightning address.
- **Inputs:** Constructor `{ spendUrl, token, fetchImpl, rosterStore, timeoutMs?, gifts?, now?, accounts?, lnurlServer? }` (already-trimmed base URL, no trailing slash; default timeout 5000 ms; `now` defaults to `Date.now`). `ping(address, messageId, kind?: 'daily' | 'moderator' | 'welcome', grantStatus?: SpendGrantStatus)`. The optional fourth argument `grantStatus` is passed into `decideSpendInstruction` only when the resolved kind is daily (kind omitted or `'daily'`). Welcome and moderator do not pass it. The welcome flag is passed only when the ledger read returned a boolean. `pingOnDay(address, messageId, day, grantStatus?: SpendGrantStatus)` posts that `day` and forwards `grantStatus` into the daily decision.
- **Returns / side effects:** `ping` returns `Promise<void>`. Unwritten store: GET `{spendUrl}/daily-roster`, then maybe POST. Written store: store read, then maybe POST. Logs `spend.ping.ok`, `spend.ping.skipped`, or `spend.ping.failed`. Each passes `address` to `logEvent`; the console line carries `addressRef` instead, the diagnostic row keeps `address`. `pingOnDay` returns `Promise<SpendPingOutcome>`: `{ status: 'accepted' }`, `{ status: 'skipped', reason }`, or `{ status: 'failed' }`.
- **Used by:** `resolveSpendPing`.

## Function: NoopSpendPing

- **Purpose:** `SpendPing` that ignores address, `messageId`, and optional kind — used when tests inject a collaborator that must not call HTTP.
- **Inputs:** `ping(_address, _messageId, _kind?: 'daily' | 'moderator' | 'welcome', _grantStatus?: SpendGrantStatus)`. The optional fourth argument is ignored.
- **Returns / side effects:** Resolves immediately. No HTTP.
- **Used by:** Tests.

## Function: DailyRosterRequestError

- **Purpose:** Thrown by `DailyRosterStore` when a change is rejected (400) or by routes when the roster cannot be read (502). `error` is the client-facing string. It is never the token, the comment text, or a Lightning address.
- **Inputs:** `status` (`400` or `502`) and `error` (the JSON `error` string).
- **Returns / side effects:** `Error` with `status` and `error`. No I/O.
- **Used by:** `InMemoryDailyRosterStore`, `PostgresDailyRosterStore`, `fundingRoutes`, `spendInstructionRoutes`.

## Function: normalizeDailyRosterComment

- **Purpose:** Fold a daily payment comment before it is stored. Newlines (`\n`, `\r`, `\r\n`) become spaces, then trim. Empty after trim is valid. Longer than 500 characters is `undefined` and is not cut.
- **Inputs:** `raw` (comment string).
- **Returns / side effects:** The folded comment, or `undefined` when it is too long. No I/O.
- **Used by:** `fundingRoutes` comment POST and `DailyRosterStore` writes.

## Function: InMemoryDailyRosterStore

- **Purpose:** Process-local `DailyRosterStore`. Rows are keyed by account id (trimmed; blank is `Invalid address or amount`). A never-written store is `{ comment: '', paymentsEnabled: true, moderatorPaymentsEnabled: true, recipients: [], moderators: [] }` with `defaultAmountUsd` always 1 on read; each listed row is `{ accountId, amountUsd }`. `hasBeenWritten` is false only before the first write. A constructor seed and a saved empty roster are written. The five 400 texts stay `Invalid comment`, `Invalid payments switch`, `Invalid address or amount`, `Address already listed` (account already in the bucket), and `Unknown address` (account not in the bucket). `importDocument` writes only while the store is still that empty start; a second call returns the stored document unchanged. It has no accounts, so imported `{ address, amountUsd }` rows stay without an account: they are kept for `linkReport` and left out of every document.
- **Inputs:** Optional seed document. Methods `get`, `hasBeenWritten`, `setComment`, `setPaymentsEnabled`, `setModeratorPaymentsEnabled`, `addRecipient`, `updateRecipient`, `deleteRecipient`, `addModerator`, `updateModerator`, `deleteModerator` (each by account id), `linkReport`, `importDocument`.
- **Returns / side effects:** Caller-owned copies. Throws `DailyRosterRequestError` 400. `linkReport` returns `{ rows, linked, unlinked, buckets }` (`DailyRosterLinkReport`). No HTTP.
- **Used by:** `openBootStores` memory boots, `createApp` default, `fundingRoutes`, `spendInstructionRoutes`.

## Function: PostgresDailyRosterStore

- **Purpose:** Durable `DailyRosterStore` over `daily_roster` and `daily_roster_entry`. Listed rows are keyed by `account_id` (`UNIQUE (account_id, bucket)`); rows with a null `account_id` are left out of every document and are never paid. No settings row is the empty start document, and `hasBeenWritten` is false only then. A saved empty roster still has the settings row, so `hasBeenWritten` is true. On add, unique violation `23505` is `Address already listed`. On `importDocument`, that same violation is a lost race for the first write and returns the stored document. `defaultAmountUsd` is not a column; every read sets 1. `importDocument` inserts the address rows only when no settings row exists, then runs `linkDailyRosterAccounts` with the constructor host. Comment, both switches, add, update, and delete each run as one SQL statement, so a failed write does not leave a new settings row that would block that first import.
- **Inputs:** Constructor takes a shared boot `SqlClient` (already migrated) and an optional host of `PUBLIC_BASE_URL` (default `null`) for the link after an import. Add, update, and delete take an account id.
- **Returns / side effects:** Parameter-bound SQL; copies on return. Throws `DailyRosterRequestError` 400 for the five roster texts. `linkReport` reads every row in `id` order and returns `{ rows, linked, unlinked, buckets }` (`DailyRosterLinkReport`).
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: migrateDailyRosterSchema

- **Purpose:** Apply `DAILY_ROSTER_SCHEMA_SQL` in order (`daily_roster`, `daily_roster_entry`, then `account_id uuid REFERENCES account (id)`, `address` nullable, and the unique index `daily_roster_entry_account_bucket_uidx` on `(account_id, bucket)`). Idempotent. Needs `account`.
- **Inputs:** `sql` (`SqlClient`).
- **Returns / side effects:** Executes each DDL statement. No rows.
- **Used by:** `openBootStores` after `migrateFundingSchema` and before `migrateDbChangeSchema`.

## Function: linkDailyRosterAccounts

- **Purpose:** Link every `daily_roster_entry` row without an account to the account it names. A row's trimmed address is compared case-insensitively with the legacy `account.lightning_address` (unique per account) and, when `host` is given, with `<username>@<host>`; the legacy address wins. Per account and bucket one row is linked: none when the bucket already holds a row of that account, else the lowest `id`. Rows that match no account keep a null `account_id`: they are in no document and are never paid. Amounts, buckets, and addresses are not changed and no row is deleted. A second run changes nothing.
- **Inputs:** `sql` (`SqlClient`) and `host` (`LnurlServerConfig.host`, or `null` when the LNURL server is off).
- **Returns / side effects:** Runs `DAILY_ROSTER_ACCOUNT_LINK_SQL` with the lower-cased host (or null) as `$1`: one UPDATE statement, so `db_change` records each linked row in one transaction. Returns `{ linked, unlinked }` (`DailyRosterAccountLink`): rows linked by this run and rows still without an account; zero for both when the statement returns no row.
- **Used by:** `openBootStores` after `migrateDbChangeSchema` and `repairGiftKind` (logs `daily_roster.accounts_linked` with both counts, no addresses), and `PostgresDailyRosterStore.importDocument` after the first import.

## Function: withRecipientIdentities

- **Purpose:** Copy a stored daily roster for the editor and attach to each recipient and each moderator its `username` (trimmed, lower-cased), its trimmed display `name`, and `address`, the row's edit key: `<username>@<host of PUBLIC_BASE_URL>`, the bare username when the LNURL server is off, or the account id when the account has no username. The edit key is not a payout address. Lookup runs once per row by account id, in parallel. A missing account has null identity fields and its account id as edit key. Lookup errors are not caught and are not logged here. Moderator rows stay out of `recipients`.
- **Inputs:** `roster` (`DailyRosterDocument`), `lookup` (`DailyRosterAccountLookup`: account id → `{ name, username, sparkPubkey, sparkPubkeyVerifiedAt }` or `undefined`), and `lnurlServer` (or `undefined`).
- **Returns / side effects:** `Promise<DailyRosterPublic>` including `moderatorPaymentsEnabled` and `moderators`. Order, `accountId`, and `amountUsd` stay. No I/O of its own.
- **Used by:** `fundingRoutes` after every successful session daily-roster call and the operator read.

## Function: withPayoutAddresses

- **Purpose:** Copy a stored daily roster for spend and attach to each row its `username` and `address`, the address it is paid on, resolved at read time from the account through `receivingAddress` (`<username>@<host of PUBLIC_BASE_URL>` with a verified wallet). A missing account, an account without a verified wallet, or the LNURL server being off gives `address: null`: the row has no wallet and is not payable. Lookup runs once per row, in parallel. Lookup errors are not caught.
- **Inputs:** `roster` (`DailyRosterDocument`), `lookup` (`DailyRosterAccountLookup`), and `lnurlServer` (or `undefined`).
- **Returns / side effects:** `Promise<DailyRosterPayoutDocument>`: the switches, comment, `defaultAmountUsd`, and rows `{ accountId, username, address, amountUsd }` in stored order. No I/O of its own.
- **Used by:** `fundingRoutes` for `GET`/`POST /funding/daily-roster/document` and every `/funding/daily-roster/worker/*` write.

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

- **Purpose:** Hono sub-app for spend-worker passkey eligibility (`GET /passkey`), funding-grant eligibility (`GET /eligible`), live top-level forum-post eligibility (`GET /posted`), invoice issue (`POST /`, optional `messageId` or `groupMessageId`), and preimage proof (`POST /proof`). Every `address` is looked up with `accountByReceivingAddress`: only the wallet-backed `<username>@<host of PUBLIC_BASE_URL>` (case-insensitive) of a member with a verified wallet is found; any other domain is the not-found answer. The invoice is fetched for the canonical wallet address through `lnurlServerFetch` (the LNURL server, never the public URL) and stored under that address. Issue refuses addresses without a passkey-backed account (403 before LNURL), and those that fail the payout gate (`loadPayoutEligibility`: `eligibleToday` with the grant and, from the grant gate day, a 21.gifts recovery share for the current verified wallet; 403 `Funding grant required` after passkey, before the living-room post check). `GET /eligible` reads the same gate, so a member in the program without the share is `{ eligible: false, status: 'admitted' }` (or `'trial'`). When `messageId` is omitted, it also refuses an address with no live top-level non-profile forum post (403 after grant, before LNURL). Replies do not count. After that gate, a configured gift store refuses a request whose `comment` is not exactly `Welcome` and that does not store a resolved moderator `groupMessageId` when today's welcome gift is already recorded (403 `Welcome gift already paid`) and returns 503 `Gift ledger unreadable` if that list throws. An omitted gift store does not apply that refusal. When `messageId` is set, that note must be that author's live top-level note, including About me, and have a photo or video (else 403 Forum post required; a text-only profile note stays 403). With `comment` exactly `Welcome` (with or without `messageId`), an account that already has a platform `Welcome` reply under one of its notes (`accountHasWelcomeGift`, live or hidden) or a recorded `welcome` gift with description `21gifts welcome` under its username at or after its wallet verification (`giftStore`) is refused with 409 `Welcome gift already paid` (after the passkey and grant checks, before LNURL; a resolved moderator `groupMessageId` is recorded as `moderator` and not refused); the welcome gift is once per account. A profile photo with `messageId` set does not also need a separate living-room post. Omitted `messageId` stays any live top-level non-profile post (no media requirement). `groupMessageId` is display-only (stored only for that address's `moderator_group` message when a platform account exists; otherwise ignored, and the invoice still issues unless the welcome-paid refusal applies). When `invoice.messageId` is set, a matching proof inserts a platform-account gift-reply first, then `addSats` (idempotent). Platform gift-replies do not notify (no in-app rows, no Web Push; `messages.reply.notify.failed` is not logged on this path; the nested gift-reply still persists); when that message is already a reply (`parentId` set), persists a deterministic `spendGiftReplyId` marker under that reply, `markDeleted` so live `listReplies` omits it, then `addReceivedSats`s the reply (a live existing marker is `markDeleted` only and does not `addReceivedSats`; no `notifyForumReply`). When `invoice.groupMessageId` is set, a matching proof inserts a platform stipend message in that closed Moderators group (`attachSpendGroupGift`; `giftForMessageId` set to the triggering message's id; idempotent).
- **Inputs:** `InvoiceRouteDeps`: spend token, invoice `store`, `authStore` (`listAccounts`, `getNostrPublicKey`, `getAccountByUsername`, `accountHasPasskey`, `hasRecoveryShareForVerifiedWallet`), optional `lnurlServer` (omitted → no member is found), optional `giftStore` (`listOutbound`; a recorded `welcome` gift with description `21gifts welcome` under the username at or after its wallet verification counts as a paid welcome gift), `messageStore` (`getById`, `addSats`, `addReceivedSats`, `create`, `markDeleted`, `listPostsByAccount`, `latestLiveTopLevelMediaId`, `accountHasWelcomeGift`, plus live-post and live-media lookup), clock, fetch, optional `giftRecorder` (default `NoopGiftRecorder`), optional `conversationStore` (`getById`, `getMessageById`, `appendMessage`; omitted → `groupMessageId` ignored), optional `fundingStore` (default empty `InMemoryFundingStore`; grant lookup for `GET /eligible` and `POST /`), optional `gifts` (`listOutbound`; omitted → the welcome-paid refusal is not applied).
- **Returns / side effects:** Hono app mounted at `/invoices`. `GET /passkey` returns `{ hasPasskey }` (200 even when false). `GET /eligible` returns `{ eligible, status }` (200 even when false); `status` is `effectiveStatus` (`'none'` for unknown address and `basis`; do not look up a grant for `basis`). `GET /posted` returns `{ hasPosted, messageId, postedAt, hasMedia, welcomeHasMedia, welcomeMessageId }` (`hasMedia` excludes About me; `welcomeHasMedia` is true exactly when `welcomeMessageId` is set, and that id is the newest live top-level photo or video, including About me; an account that already received the welcome gift, by `Welcome` reply or `welcome` gift with description `21gifts welcome` recorded at or after its wallet verification, reports `false` / `null`) (200 even when false). `hasPosted` is any live top-level non-profile post; `hasMedia` is true only when such a post has photo 0, extra stills, or video. `messageId` is the newest live top-level non-profile id, or null. `postedAt` is that row's `createdAt` ISO-8601, or null whenever `messageId` is null (including `hasPosted: true` with `messageId: null`). A matching proof (including the same-preimage idempotent 200) calls `recordOutbound` (description `21gifts moderator` when `groupMessageId` is stored, else `21gifts welcome` when `comment` is exactly `Welcome`, else `21gifts daily`; `kind` is `moderator` when `groupMessageId` is set, else `welcome` when `comment` is exactly `Welcome`, else `daily` — older welcome gifts kept description `21gifts daily` and do not count for the welcome checks), inserts the platform gift-reply first, then `addSats` (or `addReceivedSats` when `messageId` is already a reply), then the Moderators-group stipend message when `groupMessageId` is set (`giftForMessageId` = that triggering id). When `messageId` is already a reply (`parentId` set), attach persists a deterministic `spendGiftReplyId` marker under that reply, `markDeleted` so live `listReplies` omits it, then `addReceivedSats`s the reply (a live existing marker is `markDeleted` only and does not `addReceivedSats`). Insert failures log `gifts.record_failed` and still return 200. Gift-reply attach skips and logs `invoice.gift_reply.failed` when the parent or platform account is missing; still 200. Group-stipend attach skips and logs `invoice.group_gift.failed` when the triggering row, thread, or platform is missing; still 200.
  Proof stores a supplied amountUsd as that USD string and stores CHF, EUR, and PHP null. It does not read the daily rate book. An omitted amountUsd stores null for all four. A string that is not a normalized amount stores null.
- **Used by:** `createApp`.

## Function: spendInstructionRoutes

- **Purpose:** Hono sub-app for the spend-worker daily instruction (`POST /daily-instruction`). Auth is the same three-way spend-token check as invoice routes and runs before JSON parsing and before gifts or roster. The body needs only a Lightning Address; extra keys are ignored and the kind is always daily. Facts come from the auth store, forum store, funding store, optional gift ledger, and daily roster. A pay's `messageId` is the newest listed live top-level non-profile post with a photo, a video, or `photoCount` > 0, or null when that capped list has none. A skip is not logged. The token, comments, and Lightning addresses are not logged.
- **Inputs:** `SpendInstructionRouteDeps`: spend token, `authStore` (receiving address → account by username, passkey lookup, and `hasRecoveryShareForVerifiedWallet`), `messageStore` (live top-level post, media, and `listPostsByAccount`), `fundingStore` (grant lookup; with the share read through `loadPayoutEligibility`, skipped for `basis`), clock, optional `gifts` (`listOutbound`; omitted → the welcome-paid flag is not applied), optional `rosterStore` (omitted → a fresh `InMemoryDailyRosterStore`), optional `lnurlServer` (omitted → no member is found).
- **Returns / side effects:** Hono app mounted at `/spend`. Success is always 200 `{ action: 'skip', reason }` or `{ action: 'pay', amountUsd, comment }` plus `messageId` only when the decision includes it. No logging.
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

- **Purpose:** Stats handle from a receiving address (the member's wallet address, so the username): local-part before `@`, or the whole string if there is no `@`.
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

- **Purpose:** LNURL-pay fetch for gift amounts: comment optional, amount not raised to minSendable.
- **Inputs:** Normalised address, amountMsat, optional comment, fetchImpl, optional `deadlineMs` (absolute epoch ms for both calls, the pay-request resolve and the callback; each call is aborted at the time left, and a call at or after it fails like an unreachable provider) and optional `now` (default `Date.now`).
- **Returns / side effects:** `{ ok: true, pr }` or `{ ok: false, reason: 'unreachable' }`.
- **Used by:** `POST /invoices`, `POST /pay/:username/invoice`, and the shop payment mint (`ShopPayments`, 4 s deadline).

## Function: authRoutes

- **Purpose:** Hono sub-app for passkey register, authenticate, seed add, and replace refusal. Register begin accepts an optional `{ viewKey }` to claim a provisioned account; empty begin still mints a pending new account. Register begin also accepts optional `{ name }`. A non-string name is 400 with error `Expected a JSON body with an optional "name" string`. A name that does not normalize is 400 with error `Username must be 1–32 characters of a-z, 0-9, hyphen, underscore, or dot`. A taken normalized name is 409 with error `Username is already in use`. Those failures write no challenge row. On success the normalized name is stored on the challenge and is both WebAuthn `user.name` and `user.displayName`, while `user.id` stays the new account UUID. Replace begin/finish, after a valid Bearer, return 409 and do not create a challenge or delete a credential. Seed begin/finish add one extra passkey, set `walletRequired` true, and keep the login passkey and the existing session. Begin 409 stores a failed renew row, logs `auth.passkey.seed.fail` with the account id and error, and does not change the account. Begin 200 and 401 store no row. Begin 500 stores no renew row and logs `auth.passkey.seed.fail`. Finish 400 or 409 after the session is known stores a failed renew row, logs `auth.passkey.seed.fail` with the account id, and does not change the account. Finish 401 stores no renew row and no diagnostic row. Finish 500 stores no renew row and logs `auth.passkey.seed.fail`. Finish success stores `succeeded`, then acknowledges open failed rows, so owner JSON has `walletRequired` true and `passkeyRenewClosed` false. Passes optional `nostrKek` / `nostrKeygen` into register/authenticate finish so new logins get a custodial nsec. A missing finish body logs that same error with `json` `absent` and `bodyBytes`. Invalid JSON logs `Finish body is not valid JSON` with `json` `invalid` and `bodyBytes`, and does not log the text. A parsed body that is not `{ challengeId, credential }` logs the expected-body error plus `json` `parsed`, `bodyKind`, and, for an object, `hasCredential` and `challengeIdKind`. The challenge id is included only when it is 64 lowercase hex. The credential, token, view key, and raw body are never logged. Seed also keeps the failed renew row and adds the account id. Register begin with invalid JSON is 400 `Begin body is not valid JSON`, logs `auth.passkey.register.fail` with `json` `invalid` and `bodyBytes`, and does not open a challenge. Unconfigured WebAuthn logs the same fail event, or `auth.passkey.replace.refused` on replace, with `Server auth is not configured` and no account id. A register begin whose `viewKey` is not a string, and a failed claim, log `auth.passkey.register.fail` with the error and not the view key.
- **Inputs:** `AuthRouteDeps`: store, `messages`, now, allowedOrigins, webAuthnRpId, webAuthnRpName, passkeyCeremony, optional `nostrKek` and `nostrKeygen`, optional `fundingStore` (default empty `InMemoryFundingStore`; owner JSON `funding` on finish), optional `lnurlServer` (owner JSON `lightningAddress`, and the social recovery lookup; omitted → recovery begin answers 503), optional `fetchImpl` (the recovery lookup's `fetch`, default `globalThis.fetch`), optional `loginGate` (login switch for register begin, register finish, authenticate finish, and recovery begin and finish; omitted → no switch), optional `requiredAppBuild` (`APP_BUILD_REQUIRED`; `null` or omitted → no build check).
- **Returns / side effects:** Hono app mounted at `/auth`. Begin with viewKey maps claim errors to 404/409; unwraps `{ challengeId, options }` on success. With `requiredAppBuild` set, register, authenticate, and recovery begin and finish answer 403 `app_outdated` first when `X-App-Build` is missing or different. With `loginGate`, register begin (new and claim), register finish, and authenticate finish answer 503 `logins_closed` when `LoginGate.admits` refuses: begin before a challenge is stored, finish after the passkey is verified and before any account, credential, sign-count, or session write (the challenge is already consumed and stays single-use). Authenticate finish answers 409 `{ error: 'Recovery is not finished', code: 'recovery_pending' }` for the new passkey of a pending social recovery.
- **Social recovery:** `POST /passkey/recovery/begin` and `POST /passkey/recovery/finish` each have their own `IpRateLimiter(30)` (429 `Too many requests`). Begin checks WebAuthn (500), the LNURL server (503 `Lightning address service is unavailable`), the limit, then the body (400 `Begin body is not valid JSON` or `Expected a JSON body with sparkPubkey and lookup`), and maps `startPasskeyRecovery`: 200 `{ challengeId, options, accountId, username }`, 404 `Not found`, 409 `recovery_done`, 409 `recovery_operator`, 403 wrong account, 503 `logins_closed`, 503 unavailable. Finish checks WebAuthn, the limit, then the body (400 `Expected a JSON body with challengeId, credential, newSparkPubkey and signature` or `Finish body is not valid JSON`; both keys must normalize), and maps `finishPasskeyRecovery`: 200 `{ status: 'pending' }` with no session, 403 wrong account, 503 `logins_closed`, 409 `A recovery is already pending` and `Wallet key is already in use`, 400 for every other refusal. A store throw on either route is 503 `Lightning address service is unavailable`. Every refusal except 429 and the build-check 403 (logged as `auth.app.outdated`) logs `auth.passkey.recovery.fail` with `stage` (`begin` or `finish`) and the error (begin: the refusal reason; `operator` is logged by `startPasskeyRecovery` with the account id), plus the body shape fields for a 400, `errorLogFields` for a throw, and on finish the account id once known and the challenge id only when it is 64 lowercase hex. Never logs a wallet key, signature, lookup timestamp, credential, or body.
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

## Function: createApp

- **Purpose:** Wires CORS (`allowHeaders` includes `Time-Zone` and `X-App-Build`), requestLog, sundayRest, brand, health, info, auth, me, `/pictures`, `/banners`, `/view`, `/pay`, `/lnurl` (pay-request / invoice), lightning-address, `/debug/accounts`, `/debug/contacts`, `/debug/api-log`, `/diagnostics`, `/debug/diagnostics`, `/debug/db`, `/debug/external-pubkeys`, `/debug/messages`, `/debug/invoices`, `/debug/invoices/settle`, `/debug/zap-ingests`, `/debug/push-ping`, `/debug/push-broadcast` (`POST /` and `GET /:id`), `/debug/trust-edges`, `/debug/dump`, `/debug/logins` (GET / PUT, allowlist POST / DELETE) and `DELETE /debug/sessions` (`debugLoginsRoutes`, `DEBUG_TOKEN` only), `/trust-chain`, `/trust` (verify / propose-moderator / confirm-moderator / reject-moderator / appoint-moderator), `/funding` (apply / applications / trial / admit / reject / daily-roster / daily-roster/document), Web Push subscription routes, `GET /me/loans` (`myLoansRoutes`), `/gifts`, `/gifts/stats`, `/fx` (`GET /fx/spot`), `/messages` (incl. invoice and `/messages/stats`), `GET /translate` (DeepL availability), `/members/:accountId`, `GET /mentions`, `GET /accounts/by-username/:username`, `/.well-known` NIP-05 `nostr.json` (CORS `*`), `/contact`, `/habits` (`memberHabitRoutes`), `/pos`, `/conversations`, `/notifications`, `/spend` (`POST /daily-instruction`), and invoices. When `resolveLnurlServerConfig(env)` is non-null, also mounts `lnurlServerRoutes` at `/`, enables `PUT /me/wallet`, passes `lnurlServer` into `wellKnownRoutes`, adds CORS `*` for `/lnurlp/*` and `/verify/*`, and extends allow-list CORS on `/lnurlpay/*` with `X-Breez-Signature` / `X-Breez-Timestamp`. Unset or blank `LNURL_SERVER_URL` leaves the wallet bind and the forwarded LNURL routes unmounted; no member can receive or newly verify a wallet, and only an account verified while the server was configured can still post.
- **Inputs:** Optional `AppDeps` (store, clock, fetch, cache, readBrand, origins, `debugToken`, optional `debugReadToken` (default `process.env.DEBUG_READ_TOKEN`), giftStore (gift statistics, and the once-per-account welcome check of the invoice, trust, me and messages routes), `giftRecorder`, `btcUsdRates`, `fiatRates`, optional `fxSpotStore` (default empty `InMemoryFxSpotStore`; boot injects the store its spot worker refreshes), optional `loginGateStore` (default empty `InMemoryLoginGateStore`; SQL boot injects `PostgresLoginGateStore`), `messageStore`, optional `translationStore` (default `InMemoryTranslationStore`; SQL boot injects `PostgresTranslationStore`), optional `conversationTranslationStore` (passed to `conversationRoutes.translationStore`; omitted so that factory constructs one `InMemoryTranslationStore`; SQL boot injects a second `PostgresTranslationStore` on `conversation_message_translation`, never the forum store), `contactStore`, optional `memberHabitStore` (default `InMemoryMemberHabitStore`; SQL boot injects `PostgresMemberHabitStore`), optional `conversationStore` (default `InMemoryConversationStore`), optional `notificationStore` (default `InMemoryNotificationStore`), optional `apiLogStore` (default `InMemoryApiLogStore`), optional `diagnosticStore` (default `InMemoryDiagnosticStore`), optional `debugDbStore` (omitted on a memory boot; `GET /debug/db` then 503 after the token matches), optional `mergeDb` (omitted on a memory boot; after a matching debug token and a valid body, `POST /debug/accounts/merge` is 503 `{ error: 'Merge is unavailable' }`; SQL boot injects it from `createBunDatabase`), `pushStore`, `trustStore`, optional `fundingStore` (default `InMemoryFundingStore`; also forwarded to `debugPaymentsRoutes`), optional `sparkInvoiceStore` (default `InMemorySparkInvoiceStore` when free in-app payments are on; boot injects `PostgresSparkInvoiceStore` when `DATABASE_URL` is set), optional `bannerStore` (default `InMemoryBannerStore`; SQL boot injects `PostgresBannerStore`; the About me photo is neither slot; mounted at `/pictures` and `/banners` and passed to the Nostr worker), optional `listDbChange`, `vapidPublicKey`, `nostrKek`, optional `nostrPublisher` (without `nostrKek` staff hide skips NIP-09), optional `env` (default `process.env`; relays / `PUBLIC_BASE_URL` / Cloudflare on `DELETE /messages/:id`; forwarded to `conversationRoutes` and `wellKnownRoutes` (`nostr.json` relays come from `resolveWriteSet(env)`); also forwarded to `lnurlRoutes`, which refuses the `PUBLIC_BASE_URL` host as a relay target), spendApiToken, `spendPing` (default `resolveSpendPing(process.env, fetchImpl, { gifts: giftStore, now, rosterStore, accounts, lnurlServer })` with the auth store as `accounts`; unset/blank `SPEND_URL` or `SPEND_API_TOKEN` omits it; `POST /messages` still 200; daily calls `spendPing.ping(address, messageId, 'daily', effectiveStatus(grant, now))`; `conversationRoutes` gets the same `spendPing` and calls `spendPing.ping(address, created.id, 'moderator')`; forum `POST /messages` calls `spendPing.ping(address, messageId, 'daily', effectiveStatus(grant, now))`; a verified account with any live top-level photo or video, including About me, also calls `spendPing.ping(address, messageId, 'welcome')` even when the new row has no media; `spendPing` is also passed to `meRoutes` and, with `messages`, to `trustRoutes`; `fundingRoutes` receives the same optional `spendPing`), optional `postLimiter` (default a new `PostRateLimiter`; passed to `messagesRoutes`; boot shares one instance with the Nostr worker), optional `invoiceRateCaps` (default `resolveTestInvoiceRateCaps` on env; `null` keeps the process-wide gift and repayment limiters at 1 per 10 s and 20 per hour; non-null builds one `InvoiceRateLimiter` each for gift and repayment invoices and logs a warning), invoiceStore, `webAuthnRpId`, `webAuthnRpName`, `passkeyCeremony`). `debugPaymentsRoutes` receives the same optional `spendPing`. Omitted `giftRecorder` → `invoiceRoutes` uses `NoopGiftRecorder`; omitted `messageStore` → `InMemoryMessageStore`; omitted `translationStore` → `InMemoryTranslationStore`; omitted `conversationTranslationStore` → `conversationRoutes` constructs one `InMemoryTranslationStore`; omitted `contactStore` → `InMemoryContactStore`; omitted `memberHabitStore` → `InMemoryMemberHabitStore`; omitted `posStore` → `InMemoryPosStore`; omitted `conversationStore` → `InMemoryConversationStore`; omitted `notificationStore` → `InMemoryNotificationStore`; omitted `pushStore` → `InMemoryPushStore`; omitted `trustStore` → `InMemoryTrustStore`; omitted `fundingStore` → `InMemoryFundingStore`; omitted `apiLogStore` → `InMemoryApiLogStore`; omitted `diagnosticStore` → `InMemoryDiagnosticStore`; omitted/blank `vapidPublicKey` → push HTTP 503 after session; omitted `nostrKek` → unsigned forum + invoice 503; SQL boot injects `SqlGiftRecorder`, `PostgresMessageStore`, `PostgresTranslationStore`, a second `PostgresTranslationStore` on `conversation_message_translation`, `PostgresContactStore`, `PostgresMemberHabitStore`, `PostgresPosStore`, `PostgresConversationStore`, `PostgresNotificationStore`, `PostgresPushStore`, `PostgresTrustStore`, `PostgresFundingStore`, `PostgresBannerStore`, `PostgresApiLogStore`, `PostgresDiagnosticStore`, `PostgresDebugDbStore`, and parsed KEK. `messagesRoutes`, `meRoutes`, `invoiceRoutes`, and `trustRoutes` receive `conversationStore`. `fundingRoutes`, `invoiceRoutes`, `messagesRoutes`, `conversationRoutes`, `meRoutes`, `membersRoutes`, and auth finish receive `fundingStore`. `invoiceRoutes` also receives `gifts: giftStore`. `contactRoutes` and `conversationRoutes` receive `pushStore` plus `notificationStore`. Mounts `notificationRoutes` at `/notifications`. Does not take a push sender (worker owns delivery).
- **Returns / side effects:** Hono app. Default `btcUsdRates` is an empty `InMemoryBtcUsdStore`. Default `fiatRates` is an empty `InMemoryFiatStore`. Default `fxSpotStore` is an empty `InMemoryFxSpotStore`, passed to `fxRoutes` at `/fx`. `createApp` passes the same `fiatRates` object into `/gifts`, `/gifts/stats`, `/me`, `/members`, and `/view`, and the same `now` into `/mentions` and `/accounts`. Used by Bun.serve in `index.ts` and by tests via `app.request()`. Before routes mount, equal trimmed tokens throw `DEBUG_READ_TOKEN matches DEBUG_TOKEN` and neither value is printed; an empty or missing read token does not fail boot. Builds one `LoginGate` from `loginGateStore` (default `InMemoryLoginGateStore`) and `resolveLoginsOpenDefault(env)`, passes it with `resolveRequiredAppBuild(env)` to `authRoutes`, and mounts `debugLoginsRoutes` at `/debug`. An unknown `LOGINS_OPEN_DEFAULT` throws before routes mount.
- **Social recovery:** When both the auth store and the push store are the in-memory adapters (the `createApp` defaults or injected `InMemoryAuthStore` and `InMemoryPushStore`), `createApp` links them with `store.usePushStore(pushStore)`, so a recovery commit also deletes the account's push subscriptions. Optional `recoveryShareKek` (`RECOVERY_SHARE_KEK`, from `openBootStores`) is the key of the recovery share; memory boots omit it. `meRoutes` receives it with `fetchImpl` (the anonymous explorer balance of previous wallets); without it `PUT /me/recovery-share` answers 503. `authRoutes` receives `fetchImpl` and, when it resolves, `lnurlServer`, for the recovery begin's lookup; `lnurlServerRoutes` carries the address transfer and the recover pass-through of a pending recovery's new key.
- **Used by:** Boot path and every HTTP test.
- **Daily roster:** Optional `rosterStore` defaults to a fresh `InMemoryDailyRosterStore`. The same instance is passed to `fundingRoutes`, `spendInstructionRoutes`, and the default `resolveSpendPing` (with the auth store as `accounts` and the LNURL server config). `HttpDailyRoster` is not built. `SPEND_URL` is the ping POST base. Until the roster store has been written, it is also the base of `GET /daily-roster`.
- **Shops:** Optional `shopIdentityStore` (default `InMemoryShopIdentityStore` over the same `messageStore` and `now`) is passed to `/messages`, `/me`, `/debug/messages`, `/debug/dump`, `/debug/shop-keys`, `/debug/shop-notes`, `/.well-known` (NIP-05 shop locals) and `shopRoutes` at `/shops`, mounted after `/shops/activity`. Optional `shopKek` (default `nostrKek`) is the KEK for new shop keys in `/messages`, `/me`, `/debug/messages` and `/debug/shop-notes`; `/debug/shop-keys` encrypts an existing secret with the same KEK and does not mint a key. A memory boot passes a random process-ephemeral key, so public shops get an npub without Postgres. The app does not send to OpenCryptoPay; `src/index.ts` starts the outbox senders.
- **Shop payment:** When `resolveLnurlServerConfig` resolves, `createApp` uses `AppDeps.shopPayments` or builds one `ShopPayments` over an `InMemoryShopPaymentStore` on `posStore`, with `resolveShopPaymentConfig(env)` and an `OrchestraClient` when that resolves (`null` otherwise). It passes the service to `/pos`, `lnurlServerRoutes`, `/pay`, `/.well-known`, and mounts `debugShopProofsRoutes` at `/debug/shop-proofs`. Boot (`src/index.ts`) builds the service with `PostgresShopPaymentStore` when `DATABASE_URL` is set and shares it with `startPosPaidWorker`.
- **Member data:** Optional `walletStore` (default `InMemoryWalletStore`) and `memberEventStore` (default `InMemoryMemberEventStore`); SQL boot injects `PostgresWalletStore` and `PostgresMemberEventStore`. Mounts `walletReportRoutes` (`POST /me/wallet/report`, with the message store, POS store, and LNURL server config when it resolves), `walletHeartRoutes` (`POST /me/wallet/hearts`, with the message store), and `memberEventRoutes` (`POST /me/events`) at `/`.
- **Free in-app payments:** When `resolveLnurlServerConfig` resolves, `lnurlServer` is passed to `/auth`, `/me`, `/view`, `/members`, `/messages`, `/conversations`, `/funding`, `/habits`, `/trust`, `/invoices`, `/pay`, `/pos`, `GET /me/loans` (`myLoansRoutes`), `/debug/accounts`, the debug payment routes, and `/debug/dump`, so each resolves the member's receiving address. When `resolveFreePaymentsConfig` also resolves, `sparkInvoices` (`AppDeps.sparkInvoiceStore`, default `InMemorySparkInvoiceStore`) is passed to `/messages` and `/conversations`, and `/pay` gets `freePayments: true`, so `POST /pay/:username/invoice` returns a Spark invoice for an open till, or without a charge one for the posted amount; otherwise every invoice response has `sparkInvoice: null`.

## Function: healthRoute

- **Purpose:** Builds the Hono app for GET `/` → `{ status: 'ok', service, version, wallet }`. The body is fixed when the app is built; a request does no I/O.
- **Inputs:** `wallet` — the flags from `walletFeatures`, copied once.
- **Returns / side effects:** A Hono app mounted at `/healthz`. Always 200.
- **Used by:** Probes; operators checking which wallet features a deploy has on.

## Function: walletFeatures

- **Purpose:** Resolves the in-app wallet flags once at `createApp`, with the same resolvers that mount the wallet routes. `lnurlServer`: `resolveLnurlServerConfig` is not null. `zapSigning`: `resolveFreePaymentsConfig` is not null (`LNURL_ZAP_NSEC_HEX` is 64 hex characters and `SPARK_OPERATOR_URL` is unset, blank, or http(s)). `freePayments`: both. `passkey`: `resolveWebAuthnConfig` over the RP ID and the CORS origins is not null, the same check the passkey routes make (false when the RP ID is unknown or no allowed origin matches it).
- **Inputs:** `env` (the slice `createApp` uses), the raw WebAuthn RP ID, and the allowed CORS origins the auth routes get.
- **Returns / side effects:** `{ lnurlServer, zapSigning, freePayments, passkey }`, booleans only. No env value, key, or URL is returned. No I/O.
- **Used by:** `createApp` for `GET /healthz`.

## Function: infoRoute

- **Purpose:** Hono app: GET `/` → service name, version, description, repo.
- **Inputs:** None.
- **Returns / side effects:** Mounted at `/info`.
- **Used by:** Service discovery.

## Function: lightningAddressRoutes

- **Purpose:** Public LUD-16 resolve with cache. A member's wallet address resolves to the api's own forwarded callback `/lnurlp/:username/invoice`; any other domain keeps its provider's callback.
- **Inputs:** `LightningAddressRouteDeps` cache, now, fetchImpl.
- **Returns / side effects:** Hono GET `/`.
- **Used by:** `GET /lightning-address`.

## Function: logEvent

- **Purpose:** One JSON line on `console.warn` (`ts` + `event` + fields). During a request, validated client fields from `readClientRequestMeta` are merged underneath the explicit fields, and explicit fields win. Absent client fields are omitted. Outside a request, only the explicit fields are written. Never log secrets. The console line never carries a Lightning Address: an explicit string field named `address` is printed as `addressRef` (the reference `setAddressRefKey` describes) and the `address` key is left out; with no key installed it is printed as `address: "[address]"`. In every other explicit string field, each email-shaped part (`local@domain.tld`, the `@` literal or written `%40`) is printed as `[address]`. Numbers, booleans, and the request client fields are printed unchanged.
- **Inputs:** `event` string, optional `LogFields`. Call sites pass the recipient as `address` (`spend.ping.ok`, `spend.ping.skipped`, `spend.ping.failed`, the `invoice.*` events of `POST /invoices`, `lightning_address.resolved`, `lightning_address.resolve_failed`).
- **Returns / side effects:** void. The diagnostic sink runs after the console line and receives the fields exactly as passed, including `address`; only the console line differs.
- **Used by:** every non-test `src/` file below (`.ts` omitted). routes: `auth`, `contact`, `conversations`, `debug`, `debug-api-log`, `debug-catalog`, `debug-contacts`, `debug-db`, `debug-diagnostics`, `debug-external`, `debug-messages`, `debug-passkey-renew`, `debug-payments`, `debug-trust`, `funding`, `gifts`, `grant-continuation`, `invoices`, `lightning-address`, `me`, `members`, `messages`, `notifications`, `pay`, `repayment`, `shop-activity`, `shops`, `stats`, `trust`, `trust-chain`, `view`, `well-known`; lib: `account-activity`, `boot-stores`, `conversation-push`, `dev-shop-places`, `log` (`requestLog`), `nip05`, `notification`, `ocp-activity`, `ocp-outbox`, `pos-store`, `push-worker`, `spend-ping`, `username`, `video`, `welcome-media`; lib/auth: `passkey`; lib/nostr: `external-profile`, `keys`, `retract`, `worker`, `zap-index`.

## Function: setAddressRefKey

- **Purpose:** Install or clear the process-wide key `logEvent` uses to print `addressRef` in place of `address` on the console line. `addressRef` is the first 12 lower-case hex characters of HMAC-SHA256 over the lower-cased address (UTF-8), keyed with the trimmed key (UTF-8). The reference is stable for one address and one key and cannot be turned back into the address without the key. The key is `SPEND_API_TOKEN`, the Bearer the spend process shares, so the same derivation there gives the same reference.
- **Inputs:** `string | null | undefined`. The value is trimmed. `undefined`, `null`, and a blank value clear the key.
- **Returns / side effects:** void. Replaces the module-level key only. With no key, `logEvent` prints the fixed marker `[address]` for `address` and never an unkeyed hash. The key is never logged.
- **Used by:** `createApp` (with `deps.spendApiToken`, default `process.env.SPEND_API_TOKEN`).

## Function: setDiagnosticSink

- **Purpose:** Install or clear the process-wide hook that `logEvent` calls only after the `console.warn` JSON line is written. `null` stops later events from reaching a previous hook. A hook that calls `logEvent` prints the inner line but does not re-enter. A throwing hook does not escape `logEvent`.
- **Inputs:** `DiagnosticSink | null`. The sink receives the event name and the optional allowlisted scalar fields. It is not the store itself.
- **Returns / side effects:** void. Replaces the module-level hook only. Does not write a row and does not store secrets (no PRF bytes, mnemonic, session token, view key, nsec, Authorization, Cookie, WebAuthn challenge, attestation, signatures, or request bodies).

## Function: errorLogFields

- **Purpose:** Allowlisted scalar fields for a caught error so a log line never carries free text. Database messages embed offending values (`invalid input syntax for type uuid: "…"`) and fetch errors can embed a callback URL; a length cut is not redaction.
- **Inputs:** Any caught value.
- **Returns / side effects:** `LogFields` with optional `name` (an `Error` name of 1–40 ASCII letters), `code` and `errno` (strings of 1–40 ASCII alphanumerics or underscores, e.g. `ERR_POSTGRES_SERVER_ERROR` and `23505`). Primitives, `null`, and values outside the patterns yield `{}`. Never reads `message`, `detail`, or `cause`. Pure.
- **Used by:** `indexOpenZapReceipts` (per-receipt catch, `nostr.zap.rejected`), `startNostrWorker` (`nostr.worker.tick.failed`, `nostr.worker.ingest.failed`), and the OpenCryptoPay outbox (`runOcpPlaceOutboxPass` per claim (in `sendPlace` and for a claim whose handling throws), `runOcpPhotoOutboxPass` per row, `startOcpOutboxWorker` per pass and per failed start-up attempt; `ocp.place.failed`, `ocp.photos.failed`), `mapPlacesCatchFields` in `src/lib/ocp-activity.ts` (the outer error and its `cause`), `startPushWorker` (a rejected tick or sweep, `push.tick.failed` / `push.sweep.failed`), and the closed-connection handler in `src/lib/postgres-connection-closed.ts` (`sql.connection.closed`).

## Function: meRoutes

- **Purpose:** Authenticated account routes (`GET /`, `GET /activity`, `POST /wallet-backup-seen`, optional `PUT /wallet` when `lnurlServer` is set (binds `sparkPubkey` while unverified; 409 once verified, without username, or without `walletRequired`), `POST /passkey-renew/report`, `POST /passkey-renew/ack`, `POST /setup/skip`, name with `ensureProfileMessage` (no-op without a verified wallet) and username auto-assign from the display name when the handle is blank and free, `POST /username` (LUD-16 local-part, 409 when taken or when the wallet is already verified), `POST /location` (optional free-text; empty/whitespace stores `null`; does not call `ensureProfileMessage`), PUT `/about` About me on the profile note (`{ text, photo? }`: omitted photo keeps, `null` clears, object sets the same JPEG/PNG/WebP as a forum post; creates with or without a verified wallet, including photo-only empty text), `GET /about/photo` (Bearer profile-note bytes), forum-laws dismiss, `POST /wallet-intro-seen` (no body, idempotent, 200 owner JSON, log `account.wallet_intro.seen` only on the first write), `POST /notification-level` (`{ level: all|active|mentions|none }`, 200 owner JSON, log `account.notification_level.set`), `POST /heart-notifications` (`{ enabled: boolean }`, log `account.heart_notifications.set`), `POST /amount-unit` (`{ unit: btc|fiat }`, 200 owner JSON, log `account.amount_unit.set`), `POST /locale` (`{ locale: en|de|es|fil, onlyIfUnset?: boolean }`, 200 owner JSON, log `account.locale.set`), `POST /fiat` (`{ fiat: CHF|EUR|USD|PHP, onlyIfUnset?: boolean }`, 200 owner JSON, log `account.fiat.set`), living-room rules agreement). There is no route to link, change, verify, or remove an external Lightning address: a member receives only on their verified in-app wallet, and owner JSON `lightningAddress` is that wallet address or `null`. `GET /activity` is Bearer-only (no rules gate) and returns the same activity JSON as `GET /me/activity` (given and received sats plus outstanding `owedSats` and `creditSats`) for the session account. After About me is saved, optional `spendPing` welcome-pings a verified account that has a live top-level photo or video, including that note. With `lnurlServer` it also mounts the social recovery routes: `PUT /recovery-share` (strict `{ sparkPubkey, share }`; 503 `Social recovery is unavailable` without `recoveryShareKek`, before the body; 400 `Expected a JSON body with sparkPubkey and a recovery share`; 409 `Wallet is not connected` or `Wallet changed`; encrypts with `encryptRecoveryShare` and stores with `putRecoveryShare`; 200 owner JSON with `socialRecoverySetUp: true`; a store or crypto throw is 503 `Social recovery is unavailable`), `GET /previous-wallets` (`{ wallets: [{ sparkPubkey, sparkAddress, replacedAt, balanceSats }] }`, the balance read anonymously with `fetchSparkAddressBalance` for all wallets in parallel, `null` when unknown; a store throw is 503 `Wallet data is unavailable`), and `DELETE /previous-wallets/:sparkPubkey` (`dropPreviousWallet`, which also deletes that wallet's share; 204; 404 `Not found` for a bad or unknown key; a store throw is 503 `Wallet data is unavailable`). `PUT /wallet` and these three routes are not mounted without `lnurlServer`.
- **Inputs:** `MeRouteDeps` store, `messages`, now, optional `lnurlServer` (set when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve; mounts `PUT /wallet`, `PUT /recovery-share`, `GET /previous-wallets`, and `DELETE /previous-wallets/:sparkPubkey` and resolves the receiving address for owner JSON and the welcome ping), optional `pushStore`, optional `notificationStore` (profile-note `notifyForumPost`), optional `conversationStore` (inbox unread on profile-note push), optional `giftStore`, `rates`, and `fiatRates` (defaults empty in-memory; used by `GET /activity`; missing fiat never 503; `giftStore` is also read by the About-me welcome ping, where a `welcome` gift with description `21gifts welcome` recorded under the username at or after the wallet verification stops a second ping), optional `fundingStore` (default empty `InMemoryFundingStore`; owner JSON `funding` and the grant read of the first-share ping), optional `spendPing` (after About me is saved, welcome-ping when `role === 'verified'` and a live top-level photo or video exists, including that note; after the first share of the current wallet is stored, read the grant and, when `eligibleToday` holds with that share, `pingTodayMedia` with `requireShare: false`; a grant read or ping failure logs `funding.daily_ping.failed` and still returns 200), optional `recoveryShareKek` (`RECOVERY_SHARE_KEK`; omitted on a memory boot), optional `fetchImpl` (default `globalThis.fetch`; the explorer balance).- **Returns / side effects:** Hono at `/me`. Owner JSON includes `setup` + `missing` + `hasPosted` + `aboutMe` + `aboutMeHasPhoto` + `notificationLevel` + `notifyHearts` + `amountUnit` + `locale` + `fiat` + `funding` + `walletRequired` + `walletBackupSeenAt` + `walletIntroSeen` + `hadExternalWallet` + `sparkPubkey` + `sparkWalletVerified` + `passkeyCredentialId` + `passkeyRenewFailed` + `passkeyRenewClosed` + `passkeyRenewPrfUnsupported` + `socialRecoverySetUp`. `GET /activity` is 200 activity JSON (zeros without Coinbase / Frankfurter when empty) or 503 `{ error: 'Gift stats are unavailable' }` when the activity build throws. Missing fiat never 503. Logs `account.setup.skipped` with `{ accountId, step }`. Logs `account.about.set` / `account.about.failed` on PUT `/about`; `GET /about/photo` 503 logs `account.about.photo.failed`. A won PUT `/about` inline claim create calls `notifyForumPost` after the text/photo writes (best-effort; no-op when the actor is the official platform account). PUT `/about` does not call `ensureProfileMessage`. Updating an already-live note does not notify. Activity 503 logs `account.activity.fx_incomplete` when the thrown error message is exactly `fx.rate.missing`, and `account.activity.failed` otherwise. Logs `account.wallet.backup_seen` `{ accountId }` only when `markWalletBackupSeen` returned `wrote: true`. Logs `account.wallet.claimed` `{ accountId }` on a successful `PUT /wallet` (never the key). Logs `account.recovery_share.stored` `{ accountId, replaced }` (never the share or the key) and, on its 503, `account.recovery_share.failed` `{ accountId }` with the error name and code; logs `account.previous_wallet.dropped` `{ accountId }` and, on a previous-wallet 503, `account.previous_wallets.failed` `{ accountId }`.
- **Used by:** `createApp`.
- **Shop key:** Optional `shopIdentities`; with `shopKek` (default `nostrKek`), `PUT /about` calls `ensureListed` on the profile note after the write, so a profile note that became a public shop gets its key. A failure logs `shop.nostr_key.failed` and does not fail the 200.

## Function: viewRoutes

- **Purpose:** Hono sub-app for public `GET /:viewKey`, `GET /:viewKey/about/photo`, `GET /:viewKey/activity`, and `GET /:viewKey/posts`, `GET /:viewKey/shops`, `GET /:viewKey/credits`, `GET /:viewKey/replies`. Param not 64 lowercase hex or unknown key → 404 `{ error: 'Not found' }`. Identity hit → `store.accountHasPasskey(account.id)`, `loadMemberProfileNote` (viewer null) for `aboutMe`, `aboutMeHasPhoto`, and `profileMessage`, then the same counts and funding mark as the member card, then `serializeViewProfile` (`lightningAddress` is `null` without `lnurlServer` or a verified wallet). The four lists call `memberPublicMessages` with `viewerAccountId` null. Photo hit → `forumPhotoResponse` bytes for the live profile note (404 `{ error: 'Photo not found' }` when missing). Activity hit → the same activity JSON as `GET /me/activity` (given and received sats plus outstanding `owedSats` and `creditSats`). No auth; not a session. The moderator `trust` graph is not on this URL.
- **Inputs:** `ViewRouteDeps`: `store`, optional `lnurlServer` (card `lightningAddress`), optional `messageStore`, `giftStore`, `rates`, `fiatRates`, `now` (defaults empty in-memory / `Date.now`), and optional `fundingStore` (default empty `InMemoryFundingStore`). Missing fiat never 503.
- **Returns / side effects:** Hono app mounted at `/view` so the public paths are `GET /view/:viewKey`, `GET /view/:viewKey/about/photo`, `GET /view/:viewKey/activity`, and the four lists. Identity 503 logs `view.get.failed`. Photo 503 logs `view.photo.failed`. List 503 logs `view.posts.failed`, `view.shops.failed`, `view.credits.failed`, or `view.replies.failed`. Activity is 200 JSON or 503 `{ error: 'Gift stats are unavailable' }` when the activity build throws. Missing fiat never 503. Activity 503 logs `account.activity.fx_incomplete` when the thrown error message is exactly `fx.rate.missing`, and `account.activity.failed` otherwise.
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

## Function: isSundayRestHeader

- **Purpose:** True when a non-empty `Time-Zone` header names an IANA zone that is in Sunday at `nowMs`. A blank header is false. An invalid zone is false.
- **Inputs:** `nowMs` epoch milliseconds and the raw `Time-Zone` header.
- **Returns / side effects:** boolean. No I/O.
- **Used by:** conversation routes for a `moderator_group` thread, `memberHabitRoutes` for `comment`, `deleteComment`, and `invoice`, and `myLoansRoutes` for `sundayRest` on `GET /me/loans`.

## Function: isSundayInZone

- **Purpose:** True when `nowMs` falls on Sunday 00:00 inclusive through Monday 00:00 exclusive in the given IANA zone (`Intl` weekday `Sun`). Invalid `timeZone` (RangeError) is false. Does not default to Asia/Manila.
- **Inputs:** `nowMs` epoch milliseconds and `timeZone` IANA name.
- **Returns / side effects:** boolean. No I/O.
- **Used by:** `sundayRest`.

## Function: sundayRest

- **Purpose:** Hono middleware. A trimmed `Time-Zone` header naming the device IANA zone makes the listed public writes return 403 `{ error: 'SUNDAY_REST' }` while that zone is in Sunday on the injected clock: `POST /messages`, `DELETE /messages/:id` (one segment), `PATCH /messages/:id/place`, `PATCH /messages/:id/shop-account`, `PATCH /messages/:id/text`, `PATCH /messages/:id/photos`, `POST /funding/apply|trial|admit|reject`, `POST /me/name|username|location`, `PUT /me/about`, `PUT /pictures/me`, `PUT /banners/me`, the trust verify/moderator writes, and `POST /messages/:id/invoice` (a zap on a forum note) `POST /messages/:id/repayment` (the author's next giver share), and `POST /messages/:id/repayment/due` (every payable share at once). `GET /messages/:id/repayment` stays open. `GET /conversations/moderator-group` is refused the same way, and opening, reading, or sending in a moderator-group thread is refused once that thread is known. Ordinary private messages, contact, pay links, the till, and conversation invoices are not refused. Missing or invalid zone does not refuse. Never 503; does not pause `/healthz`, boot, or workers.
- **Inputs:** `now` epoch-ms callback (the same clock `createApp` already uses).
- **Returns / side effects:** Middleware. JSON 403 or `next()`.
- **Used by:** `createApp`.

## Function: messagesRoutes

- **Purpose:** Hono sub-app for the public member forum. Public `POST /:id/translate` (`{ target }`) loads the stored `message.text`, returns a `message_translation` hit when `source_sha256` matches, otherwise one DeepL POST coalesced per (id, locale, hash), then upserts (first writer for a hash wins). Empty text 400. Same visibility as `GET /:id`. `{ translatedText, cached }`. 503 when DeepL is unset, 502 when DeepL fails. Public `GET /stats` (no session) counts living notes and replies together as `postCount`, with `postsOverTime` filled through today UTC (gap days are 0; soft-hidden rows are omitted; `posts.stats.failed` → 503). After Bearer auth, `requireAction` gates `GET /` (`forum.read` → rules), `POST /` (`forum.post` → rules + name + username + a verified wallet (`lightning-address`)), `GET /compose-target` (`forum.post`), and `POST /:id/invoice` (`forum.pay` → payer rules only). Public `GET /:id/repayment` needs no session and lists who gave and each repayment. Bearer `POST /:id/repayment` (`forum.pay`) issues the next giver share. Bearer `GET /` lists **live top-level** notes via `listFeed` (query `mode`/`limit`/`cursor`/optional `hashtag` (name without `#`; token match on `text`), default cap 200, optional `nextCursor` when the page is full; `hasPhoto`, `hasVideo`, `videoContentType`, `sats`, `payable`, `authorCanReceive` (the author has a receiving address, signed or not), live `role`, live `replyCount` of children with an account or a recorded zapper pubkey); soft-hidden rows are omitted; missing-file `hasVideo` rows are deleted (`messages.video.dropped`) unless the row is a credit note with sats, which `deleteById` keeps and the route reads again and serves while it is live; `POST /` creates text/photo/video after parse/normalize/decode — JSON `photos` max 10, non-empty wins over singular `photo`, `photos.length > 10` is 400 `{ error: 'At most 10 photos' }`; optional `goalSats` alone is a legacy whole-sat ask (1..10_000_000) on a top-level note (JSON number or multipart digits; omitted/null/empty = no goal); alternatively both `goalCurrency` (`BTC`/`USD`/`CHF`/`EUR`/`PHP`) and `goalAmount` (one canonical decimal) and not `goalSats` — half a pair or both styles is 400 `{ error: 'Send either goalSats or both goalCurrency and goalAmount' }`; any goal field on a reply is 400 `{ error: 'A reply cannot ask for a goal' }`; `goalRepayable` other than JSON `true` or multipart `"true"` is 400 `{ error: 'Ask obligation must be true' }` (JSON `""` is rejected; a multipart empty field is absent); `goalRepayable` true without an ask is 400 `{ error: 'A repayment obligation needs an ask' }`; `goalTermDays` outside 1..3650 is 400 `{ error: 'Ask term must be a whole number of days from 1 to 3650' }`; a term without `goalRepayable: true` is 400 `{ error: 'A repayment term needs a repayable ask' }`; `goalRepayable` true without a term is 400 `{ error: 'A repayable ask needs a term in days' }`; `BTC` stores that whole-sat count as `goal_sats` and freezes the four fiat snapshots (`null` when there is no gift-day); fiat stores the typed amount, freezes `goal_sats` from the gift-day proportion, and the four snapshots; no usable rate or sats outside 1..10_000_000 is 400 `{ error: 'Ask amount is unavailable' }`; a thrown `goalRateDay` is 503 `{ error: 'Messages are unavailable' }` for a fiat ask, and a BTC ask still stores the typed sats; public JSON omits the key when unset; optional `place` is `{ lat, lng, label, address }` where `address` is `{ street, houseNumber, postalCode, city, country }` or null (JSON and multipart `placeLat` / `placeLng` / `placeLabel` / `placeStreet` / `placeHouseNumber` / `placePostalCode` / `placeCity` / `placeCountry`; both empty coordinates means no pin; any address field without a coordinate pair is 400 `{ error: 'Place must be a latitude and longitude' }`; exactly one coordinate is 400; a reply with a place is 400 `{ error: 'A reply cannot include a place' }`; public JSON omits `place` when unset; a top-level `#21GiftsShop` note with no pin is 400 `{ error: 'Shop name is required' }` and stores nothing, before the shop-account check); required `shopUsername` (JSON string or multipart field) assigns a 21.gifts account on a new top-level shop note (`#21GiftsShop`): omitted, null, blank, or only `@` on that note is 400 `A shop note needs a shop account` after the shop pin checks pass and stores nothing; the same blank value on a note that is not a shop stores nothing; a non-string is 400 `Username is not valid`; a reply or a note that is not a shop, with a non-blank handle, is 400 `Only a shop note can set a shop account`; a handle `normalizeUsername` rejects is 400 `Username is not valid`; an unknown username, or a stored username that is missing or blank, is 404 `No account with that username`; the account id is stored on the same insert and that first assignment does not write `message_edit`; a media replay of an existing live note does not change its shop account; `GET /places` lists live pins (`forum.read`, limit 1–1000) and is registered before `GET /:id`; `GET /:id/photo/:file` serves extras 1–9; identical live media from the same account+parent with the same pin collapses to the existing row (200, no limiter, no second push); a different pin is 409 `{ error: 'A live note with this media already exists' }`; text-only still uses the 1/10s burst then inserts; unpaid text-only replies from anyone below `verified` are 403 (`A reply needs a Bitcoin payment`) unless the caller wrote the parent note (`ownParent`; such a reply is free for every role, because a wallet cannot pay itself, and still passes the burst limiter); an unpaid text-only top-level post from anyone below `verified` is 403 (`A post needs a Bitcoin payment`) unless it is the account's free first post (no top-level note of its own other than `profileMessageId`, live or hidden, via `accountHasTopLevelPost`; stored through `createFirstPost`, so of two concurrent first posts one is stored and the other is 403; a throwing check is 503); photo or video posts and replies from basis are allowed; pay 1 sat to 21.gifts via `GET /compose-target` then `POST /:id/invoice` on the platform profile note; `verified` stays unpaid-write exempt; soft-hidden `inReplyTo` parents are 404; public `GET /:id` stays open without a session and includes `accountId` whenever the stored author id is non-null, with or without a session, and omits it for an external author on a live row (a reply with null `accountId` is 200 with `via: 'nostr'` only when `authorPubkey` is set and recorded as a zapper (`isZapperPubkey`); otherwise (no `authorPubkey`, or one that is not yet a recorded zapper) it is 404; external top-level notes stay 200); optional `?sinceSats=` (non-negative integer) long-polls until `sats` is strictly greater; optional `?sinceReceivedSats=` (non-negative integer) on a live reply also waits until `receivedSats` is strictly greater (both parameters set means wait until both are exceeded; a top-level note ignores `sinceReceivedSats`; timeout still 200 with the current body; a value that is not a non-negative integer is 400); unsigned/non-staff GET of a hidden row is still 404 `{ error: 'Not found' }` (no `deletedAt` in the 404 body); a founder/moderator Bearer (`roleAtLeast(..., 'moderator')`, no `forum.read`) is 200 public JSON plus `deletedAt` ISO, `deletedBy.{id,name,role}`, `payable: false`, `authorCanReceive: false`, and `accountId` for 21gifts authors (skip missing-video drop; do not long-poll `sinceSats` or `sinceReceivedSats` on hidden rows); a top-level note on GET `/:id`, live or staff-hidden, includes that `replyCount`, and a reply omits `replyCount`; live public JSON still omits hide stamps; public `GET /:id/replies` lists children with an account or a recorded zapper pubkey (live replies include `accountId` whenever the stored author id is non-null, with or without a session; rows with neither identity are skipped); unsigned/non-staff 404s hidden/missing parents; staff Bearer is 200 `{ messages }` from `listReplies(id, limit, true)` including hidden attributed children with hide stamps, `payable: false`, and `authorCanReceive: false` (live children stay live serialize); a child whose author lookup or serialize throws (invalid `createdAt`, author lookup) is omitted and siblings still 200 `{ messages }`; 503 `messages.replies.failed` only for `getById` / `listReplies` throws and for `dropMissingVideoRow` store/I/O (non-ENOENT video I/O or `deleteById`); missing-file drop (`null` → omit) still 200; photo/video byte routes 404 hidden ids for public/Damus (no staff bearer); founder/moderator Bearer serves hidden-row bytes with `Cache-Control: private, no-store` and `Vary: Authorization`; staff `DELETE /:id` soft-hides via `markDeleted` (moderator → 204; basis/verified → 403; a live open credit note → 409 `{ error: 'An open credit cannot be deleted' }` without calling `markDeleted`, see `creditStillOpen`; a live credit note is hidden with `markDeleted(…, expectedSats)`, and when its `sats` moved in between the reread live row is 409, a row hidden in between is 204, and a vanished row is 404; an already-hidden credit note is 204 like any tagged target) then best-effort `retractHiddenForumNotes` when `nostrPublisher` and `nostrKek` are set (NIP-09 + optional Cloudflare purge; failure still 204) and best-effort retracts in-app notifications whose `parentId` or `replyId` is the note or a direct child (`listChildIds` + `deleteByMessageIds`; failure logs `messages.delete.notifications_failed` and still 204, never 503); staff `GET /hidden` lists soft-hidden notes newest-hidden-first (moderator session or operator token, no `forum.read`; 200 `{ messages }` via `listHidden` / `serializeHiddenMessage`; logs `messages.hidden.listed` with `count` only); invoice returns `{ pr, amountSats, sparkInvoice }` only for NIP-57 invoices and 404s soft-hidden notes (no author receiving address / unsigned stay 400 resource errors, never 409 `lightning-address` for the payer). Optional `notificationStore` fans out via `notifyForumPost` / `notifyForumReply` to every account except the actor and except mention account ids on the created row (no-op when the actor is the official platform account), then filtered by each account's `notificationLevel` (no inbox copy; missing `pushStore` still writes in-app rows; Web Push only to bell subscribers, same filter). A marked account is notified once with `forum_mention` (`notifyForumMentions`); they are excluded from the post/reply fan-out. Optional `spendPing`: after a **new** top-level persist the route calls `spendPing.ping(address, messageId, 'daily', effectiveStatus(grant, now))` when the payout gate passes (`loadPayoutEligibility`: `eligibleToday` with the grant and, from the grant gate day, the recovery share of the current verified wallet) and the new row has media (`hasPhoto` / `hasVideo` / `photoCount > 0`) (fire-and-await, errors logged, POST still 200; ineligible logs `spend.ping.skipped` / `not_eligible`; eligible text-only logs `spend.ping.skipped` / `no_media`). When `role === 'verified'` and any live top-level photo or video exists, including About me, the route also calls `spendPing.ping(address, messageId, 'welcome')` for that note, independently of `eligibleToday` and of whether the new row has media (`spend.ping.failed` on throw). Replies, and any role other than `verified`, skip welcome. Replies and media replays skip. Omitted `spendPing` skips. Notification or push failure still returns 200.
- **Sunday rest:** A `Time-Zone` header naming the device IANA zone makes `POST /`, staff `DELETE /:id`, `PATCH /:id/place`, `PATCH /:id/shop-account`, `PATCH /:id/text`, `PATCH /:id/photos`, `POST /:id/invoice`, `POST /:id/repayment`, and `POST /:id/repayment/due` return 403 `{ error: 'SUNDAY_REST' }` while that zone is in Sunday. `GET /:id/repayment` stays open. Pay links, the till, and private messages are not refused. Missing or invalid zone does not refuse.
- **External DELETE cascade:** When the target has `accountId === null` and a recorded `authorPubkey`, a successful `markDeleted` is followed by the single atomic `blockPubkeyAndHideRows` operation, which records the block and hides that pubkey's other live external rows. It logs `messages.external.blocked` with `{ messageId, hidden: cascaded + 1 }`; deleting a member row does not trigger this author-wide cascade.

- **Inputs:** `MessagesRouteDeps`: message `store`, shared `authStore`, `now`, optional `nostrKek`, optional `nostrPublisher`, optional `env` (relays / `PUBLIC_BASE_URL` / Cloudflare / DeepL; default `{}` on the retract path), optional `translationStore` (default empty `InMemoryTranslationStore`), `fetchImpl`, `postLimiter`, `invoiceLimiter`, optional `repaymentLimiter` (test-only override passed to `repaymentInvoice`; omitted → the module limiter in `repayment.ts`), `heartLimiter` (default a process-wide `HeartRateLimiter`), optional `pushStore`, optional `spendPing`, optional `shopIdentities` and `shopKek` (default `nostrKek`; with a KEK, `ensureListed` after a committed `POST /`, `PATCH /:id/place`, `PATCH /:id/shop-account` or `PATCH /:id/text` creates a public shop's key; the response carries `shopNpub` only when the note is a listed shop, and otherwise `shopNpub` is null; a failure logs `shop.nostr_key.failed` and never fails the request; the OpenCryptoPay outboxes are queued by the store writes themselves, and the place sender decides from the note at send time: PUT for a listed shop, nothing for a public shop that is not listed, DELETE for a keyed shop that is no longer public, whether its tag was removed, its till account was cleared, or it was hidden or is gone), optional `fundingStore` (default empty `InMemoryFundingStore`), optional `giftStore` (a recorded `welcome` gift with description `21gifts welcome` under the author's username at or after its wallet verification stops a second welcome ping), optional `notificationStore`, optional `conversationStore`, optional `waitSatsSleep` (test inject; default `defaultWaitSatsSleep`), optional `waitSatsTimeoutMs` (test inject; default `WAIT_SATS_TIMEOUT_MS`), optional `waitSatsPollMs` (test inject; default `WAIT_SATS_POLL_MS`), optional `goalRateDay` (`createApp` passes `bindGoalRateDay`; when omitted a fiat ask is 400 `Ask amount is unavailable`, a throw is 503 for a fiat ask, and a BTC ask still stores the typed sats when the loader throws or returns null). Optional `debugToken` and `debugReadToken`: either one as Bearer reads `GET /hidden` and `GET /:id/edits` without a session (`isOperatorBearer`); every other route keeps its session rule.
- **Returns / side effects:** Hono app mounted at `/messages`. 401 without a live session on create/compose-target/DELETE/GET `/hidden`/invoice/POST `/:id/repayment`/POST `/:id/repayment/due`, and on the list except the unsigned `mode=active` window with no hashtag (that window is 200); 403 on DELETE and GET `/hidden` when not at least moderator and on unpaid text-only replies on a note the caller did not write and, after the account's free first post, unpaid text-only top-level posts from anyone below `verified` (a text reply on the caller's own note is free for every role); photo or video posts and replies from basis are allowed; 409 `{ error: 'A live note with this media already exists' }` when the same live media fingerprint has a different pin; 409 `{ error: 'missing_requirements', missing }` when action gates fail (GET `/hidden` and staff GET of a hidden permalink / replies / photo / video have no `forum.read` gate); 400 on bad body / invalid text / bad media / unpaid note / author's-wallet / LNURL failures / reply+goal field / non-integer multipart `goalSats` / currency-ask pair errors / `Ask amount is unavailable`; 404 for bad `inReplyTo` / missing rows / unsigned or non-staff GET of a hidden row; 204 empty body on successful DELETE (NIP-09 / purge / notification retract failure still 204); 200 staff hidden log `{ messages }` (no `forum.read`); 200 staff GET of a hidden permalink / replies / photo / video; 429 rate limits; 503 on store/KEK/sign failure. Live list, `GET /:id`, and replies include `accountId` whenever the stored author id is non-null, with or without a session, and omit it for an external row; create may include `accountId` for a 21.gifts author; live JSON omits `deletedAt` and `deletedBy`; staff hidden GET includes hide stamps and `accountId` for 21gifts authors. Post and reply notify call `notifyForumPost` / `notifyForumReply` best-effort (in-app rows for every account except the actor and except mention account ids on the created row (no-op when the actor is the official platform account), then filtered by each account's `notificationLevel`; Web Push for bell subscribers, same filter; failure still 200. An operator `DEBUG_TOKEN` or `DEBUG_READ_TOKEN` reads `GET /hidden` and `GET /:id/edits` without a session or role check.

- **Used by:** `createApp`.
- **Receiving address and Spark invoice:** The payable flag and `POST /:id/invoice` (forum gift and the compose-target posting fee) use `receivingAddress` with optional `lnurlServer`, so a member with a verified wallet receives on `<username>@<host>` resolved internally through `lnurlServerFetch`. With optional `sparkInvoices` (free in-app payments on) a wallet-backed recipient whose `pr` is for exactly the requested amount gets `sparkInvoice` from `issueSparkInvoice` next to `pr`; otherwise `sparkInvoice` is `null`. A heart (`heart: true`) never falls back to `pr` alone: without `sparkInvoices` it is 503 `HEART_UNAVAILABLE` before the limiter and LNURL, and a `null` Spark invoice after the mint is the same 503 with no `pr` in the body (attempt `heart_unavailable`, no `ok` row). `POST /:id/repayment` and `POST /:id/repayment/due` use the same two deps for the giver.

## Function: contactRoutes

- **Purpose:** Hono sub-app for the private in-app contact mailbox: `POST /` only (no member GET). After auth, `requireAction(account, 'contact.post')` (rules + name + username). After the platform account exists, persists the contact row first, then opens/appends the member→platform conversation thread. Conversation append failure logs `conversations.contact_sync.failed` and still 200.
- **Inputs:** `ContactRouteDeps`: contact `store`, `conversationStore`, shared `authStore`, `now`, optional `pushStore` and `notificationStore`.
- **Returns / side effects:** Hono app mounted at `/contact`. 401 without session; 409 `{ error: 'missing_requirements', missing }` when rules/name/username are missing; 400 on bad body / invalid text; 503 `{ error: 'Platform account is not configured' }` when no `isPlatform` account (no writes); 503 Contact is unavailable on contact-store failure (`contact.create.failed`). After a successful conversation append, `notifyConversationMessage` is void-caught (`conversations.push.failed`); contact 200 is unchanged. Public JSON omits `accountId`.
- **Used by:** `createApp`.

## Function: conversationRoutes

- **Purpose:** Hono sub-app for the signed-in PN channel: `GET /` lists `{ conversations, unreadCount }` (`unreadCount` = listed rows with `unread` true) for visible inbox threads and always passes `moderator: false` into `listVisible` (never ensures, pins, or returns `moderator_group`); each list/open row gets `unreadMessageCount` from `countUnread` (`unread` = count > 0; those paths do not also call `hasUnread`) and `lastMessageId` of the newest row (`created_at DESC, id DESC`, else `null`; the list does not translate); `POST /` opens a thread from `{ forumMessageId }`; `GET /moderator-group` (before `GET /:id`) is the closed-group tool for `roleAtLeast(..., 'moderator')`: `ensureModeratorGroup` then `{ conversation }` (with `unread` / `unreadMessageCount` from `countUnread`, `canReceive: false` because the group has no counterpart); verified/basis 404; missing platform / store failure 503 `conversations.moderator_group.failed`; `GET /:id` returns a messenger-style newest page (default/max 200) oldest-first within the page, with `?limit=` and an exclusive older keyset `?cursor=` plus optional `nextCursor`, including `hasPhoto` / `photoCount` (never bytes); `?sinceMessageId=` keeps its long-poll and then returns the newest page regardless of a valid cursor; `GET /:id/messages/:messageId/photo` and `GET /:id/messages/:messageId/photo/:file` (indices 1–9, registered before `GET /:id`) serve private stills (`conversations.photo.failed` on store throw); `POST /:id/messages/:messageId/translate` (before `GET /:id`) translates stored `conversation_message.text` via `translateForumNote` and `conversation_message_translation` (not `message_translation`; no client source text) after `canAccess` including `isModeratorGroupMember` for `moderator_group`; `POST /:id/read` stamps last-read (mount before `POST /:id`); `POST /:id` appends `{ text?, photo?, photos? }` (max 10 stills; non-empty `photos` wins over singular `photo`; stills on every kind; empty text allowed when a still is present; photo-bearing rows skip Nostr; text-only Direct/Contact/Damus stay pending); `POST /:id/invoice` issues a NIP-57 gift invoice. Moderators see all platform threads. Staff replies on a platform thread persist the platform sender (worker signs with the platform nsec) and store `actorAccountId`/`actorName` as the logged-in staff. Staff JSON `name`/`accountId` use the actor when set; members still see the sender (`21.gifts`). `fromMe` is the actor, else the sender — no staff-as-platform shortcut. `moderator_group` ACL is `isModeratorGroupMember` (`roleAtLeast(..., 'moderator')` and not the platform account; moderator 200; verified/basis 404). `POST /:id` on this kind persists as the caller (moderator, not staff-as-platform) with `nostrPublishState: 'skipped'`, then `spendPing.ping(address, created.id, 'moderator')` only when the sender has a receiving address (verified wallet, sent as `address`) **and** a live living-room top-level post exists on this UTC day **and** the payout gate passes (`loadPayoutEligibility`: `eligibleToday` with the grant and, from the grant gate day, the recovery share of the current verified wallet); no living-room post today → 200, no ping, `spend.ping.skipped` / `no_public_post`; living-room lookup failure after persist → 200, no ping, `spend.ping.skipped` / `posted_unreachable`; ineligible grant or no recovery share → 200, no ping, `spend.ping.skipped` / `not_eligible`; ping throw still 200.
- **Inputs:** `ConversationRouteDeps`: conversation `store`, shared `authStore`, forum `messageStore`, `now`, optional `spendPing`, optional `fundingStore` (default empty `InMemoryFundingStore`), optional `fetchImpl` / `nostrKek` / `invoiceLimiter` / wait injects, optional `pushStore` and `notificationStore`, optional `translationStore` (default one empty `InMemoryTranslationStore` per factory call, never the forum store; SQL boot injects a second `PostgresTranslationStore` on `conversation_message_translation`), optional `env` (DeepL; default `{}`).
- **Returns / side effects:** Hono app mounted at `/conversations`. 401 without session; 400 on bad body / self-PM / missing name / invalid text / author wallet / invalid still / empty trimmed translate text; 404 when not allowed; 429 Too many payments; 403 `{ error: 'SUNDAY_REST' }` for the moderator group on Sunday (see Sunday rest); 503 `{ error: 'Messages are unavailable' }` for missing KEK / sign failure; 503 `{ error: 'Translate is not configured' }`; 502 `{ error: 'Translate upstream failed' }`; 503 `{ error: 'Conversations are unavailable' }` for store/catch including ok-path `recordInvoiceAttempt` throw (`conversations.list.failed` / `conversations.read.failed` / `conversations.photo.failed` / `conversations.translate.failed` without API key or text). After a successful `POST /:id` append, `notifyConversationMessage` is void-caught (`conversations.push.failed`) so 200 is unchanged. Public list/open JSON includes `unread`, `unreadMessageCount`, `lastSats`, `lastMessageId`, and `canReceive` (true when the counterpart has a receiving address; false for a Damus-only counterpart, a missing account, and the moderator group) and may include optional counterpart `accountId`; thread messages may include optional `accountId` (actor for staff when set, otherwise sender), `hasPhoto`, and `photoCount` (0–10; never bytes). Omits event ids and npubs (Damus-only `name` may be a truncated npub; Damus-only counterparts and Damus inbound omit `accountId`). List rows include `lastSats`; messages include `sats`. Envelope `unreadCount` remains the number of listed rows with `unread` true. Translate 200 is `{ translatedText, cached }`.
- **Sunday rest:** `GET /moderator-group` returns 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names an IANA zone in Sunday on the injected clock. `GET /:id`, `POST /:id`, and `POST /:id/read` return that 403 only after the thread is loaded and its kind is `moderator_group`. Ordinary private threads, `POST /:id/invoice`, contact, pay links, and the till are not refused. A missing, blank, or invalid zone does not refuse. Never 503.
- **Used by:** `createApp`.
- **Receiving address and Spark invoice:** `POST /:id/invoice` resolves the counterpart with `receivingAddress` (optional `lnurlServer`; LNURL calls through `lnurlServerFetch`) and returns `sparkInvoice` from `issueSparkInvoice` when optional `sparkInvoices` is set, the counterpart is wallet-backed, and `pr` is for exactly the requested amount, else `null`.

## Function: notificationRoutes

- **Purpose:** Hono sub-app for signed-in in-app notifications: `GET /` lists `{ notifications, unreadCount }` (scan newest 1000; if a `forum_mention` has `replyId` R, drop every `forum_post` and `forum_reply` in that scan with the same `replyId` before the level filter and the hidden-message filter, then best-effort `deleteForRecipient` of those dropped ids (`notifications.duplicate.purged`; throw logs `notifications.duplicate.purge_failed` and still 200 with the filtered list); then `notificationsMatchingLevel` for the owner's `notificationLevel`, then drop rows whose parent **message** is missing or `deletedAt !== null` (`forum_reply` also checks the child `replyId` message; `zap` or `heart` `replyId` is a receipt UUID and is not looked up), then cap 200; `unreadCount` is matching unread among kept rows after this drop and the hidden filter, before the 200 cap; each item `type` is `'forum_post' | 'forum_reply' | 'forum_mention' | 'zap' | 'heart' | 'moderator_appointed' | 'moderator_proposal'`; `moderator_appointed` and `moderator_proposal` always stay through the level filter and the hidden filter; `heart` always stays through the level filter; do not drop `zap`, `heart`, or `forum_mention` in the duplicate drop), `POST /read-all` marks all read except `moderator_proposal`, `POST /:id/read` marks one UUID (`moderator_proposal` stays unread). Mount `read-all`, `read-by-message`, and `read-visible` before `/:id/read`. `POST /read-all` returns `{ ok: true, tags }` for rows this call stamped. `POST /read-by-message` stamps unread `forum_post`, `forum_reply`, `forum_mention`, `zap`, and `heart` for this account when `parentId` or `replyId` equals the message id and returns the same `{ ok: true, tags }`. `POST /read-visible` stamps unread `forum_post`, `forum_reply`, and `forum_mention` for this account when `replyId` equals the message id (not `parentId`, not `zap`) and returns the same `{ ok: true, tags }`. `POST /:id/read` still returns the public notification; a fresh stamp enqueues that row's dismiss tag, and a proposal or an already-read row does not. Never exposes recipient or actor account ids. `DEBUG_TOKEN` cannot read this list. `createApp` always passes `messages` (`getById`). Hidden/missing forum rows are then best-effort `deleteByMessageIds` (`notifications.hidden.purged`). Appointed/proposal `parentId`/`replyId` are account ids in prod, so a purge of hidden **message** ids does not remove them. If purge throws, count kept unread rows (do not 503 the list).
- **Inputs:** `NotificationRouteDeps`: notification `store`, shared `authStore`, `messages` (`getById`), `now`, optional `pushStore`, and optional `inboxUnreadCount`.
- **Returns / side effects:** Hono app mounted at `/notifications`. 401 without session; 404 `{ error: 'Not found' }` for unknown / other-account / non-uuid `:id` and for a bad `read-by-message` or `read-visible` body; 503 `{ error: 'Notifications are unavailable' }` (`notifications.list.failed` / `notifications.read_all.failed` / `notifications.read.failed` / `notifications.read_message.failed` / `notifications.read_visible.failed`). `POST /read-all`, `POST /read-by-message`, and `POST /read-visible` are 200 `{ ok: true, tags }`. A fresh single-read stamp enqueues dismiss; proposals and already-read rows do not. Dismiss enqueue failure is still 200. Hidden-row purge failure and duplicate-row purge failure are not 503.
- **Used by:** `createApp`.

## Function: normalizeDisplayName

- **Purpose:** Trim and validate an account display name (1–80 characters, no C0/DEL controls).
- **Inputs:** `raw` string.
- **Returns / side effects:** Trimmed name or `null`.
- **Used by:** `POST /me/name`.

## Function: normalizeUsername

- **Purpose:** Trim, lowercase, and validate a LUD-16 / NIP-05 local-part (`a-z0-9-_.`, 1–32 characters, must start with a letter or digit). Rejects a trailing `.`, two dots in a row (`..`), and `_` alone because LUD-16 uses `_` as the default identifier. Does not allow `+` (tags are not stored). Routes that look an account up by a normalised username (`GET /.well-known/lnurlp/:username`, `GET /pay/:username`, `@` mentions and the username lookups in `/messages`) apply the same rule, so a stored username of that shape is not matched until it is renamed; existing accounts are not migrated.
- **Inputs:** `raw` string.
- **Returns / side effects:** Normalised username or `null`. No I/O.
- **Used by:** `POST /me/username`, `usernameFromDisplayName`, `backfillAccountUsernames`, debug provision, LNURL registration gate.

## Function: normalizeSparkPubkey

- **Purpose:** Trim, lowercase, and validate a wallet identity public key (compressed secp256k1): exactly 66 hex characters matching `/^0[23][0-9a-f]{64}$/`.
- **Inputs:** `raw` string.
- **Returns / side effects:** Normalised lowercase hex string, or `null` when the shape is wrong. No I/O.
- **Used by:** `PUT /me/wallet`, `lnurlServerRoutes` registration/recover/metadata gates.

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

- **Purpose:** Validate an optional map pin for a top-level forum note. `undefined` or `null` is no pin. Otherwise a plain object with finite numeric `lat` in [-90, 90] and `lng` in [-180, 180], rounded to 6 decimal places (`Math.round(n * 1e6) / 1e6`), with `-0` collapsed to `0`. Label absent, null, or trim-empty becomes null. A label never removes the pin. Optional `address` absent, undefined, or null becomes `address: null`. Otherwise a plain object with exactly the five string keys `street`, `houseNumber`, `postalCode`, `city`, and `country`, each trimmed and checked with the OpenCryptoPay rules (street 1–120 no C0/DEL; houseNumber `^[0-9][0-9A-Za-z/ .&–-]{0,31}$`; country assigned ISO 3166-1 alpha-2 uppercased; postal CH/LI `^[0-9]{4}$`; other countries `^[A-Za-z0-9][A-Za-z0-9 -]{1,15}$`; city 1–80 with a letter and no C0/DEL). House number, postal code, and city are rejected when they contain a control character, before trimming (deliberate, same as the OpenCryptoPay API for house number and postal code).
- **Inputs:** `input` unknown (JSON `place` or a multipart-derived object).
- **Returns / side effects:** `{ ok: true, value: ForumPlace | null }` or `{ ok: false, error }` where error is `Place must be a latitude and longitude` (missing/non-numeric/NaN/Infinity/out of range, or a non-string label), `Place label must be at most 80 characters` (trimmed length > 80, or any charCode < 32 or === 127), or `Place address is invalid`. No I/O.
- **Used by:** `POST /messages` and `PATCH /messages/:id/place`.

## Function: parseMultipartCoord

- **Purpose:** Read one multipart coordinate. Blank or missing is no coordinate. A value that is not an explicit decimal is invalid, so whitespace cannot become a pin at zero.
- **Inputs:** `raw` unknown from a multipart field (`placeLat` or `placeLng`).
- **Returns / side effects:** `'missing'`, `'invalid'`, or a finite number. No I/O.
- **Used by:** `POST /messages` multipart parsing, then `normalizePlace`.

## Function: placesMatch

- **Purpose:** Compare two optional pins. Both absent matches. One absent does not. Otherwise latitude, longitude, label, and structured address must all be equal.
- **Inputs:** Two `ForumPlace | null` values.
- **Returns / side effects:** `true` when the pins are the same, otherwise `false`. No I/O.
- **Used by:** `POST /messages` and `MessageStore.create`, which reject a repeated live photo when the pin differs.

## Function: placeCountryCode

Reads the country of a map pin from its coordinates with the offline boundary dataset of `@rapideditor/country-coder` at territory level, so Hong Kong is `HK` and Puerto Rico is `PR`. Coastal waters count as that country. Ceuta and Melilla, the one territory the dataset returns with a code ISO 3166-1 does not assign (`EA`), take their country's code (`ES`); smaller reserved areas such as Ascension already roll up to an assigned code (`SH`). Kosovo stays `XK`. The free-text label is never read. Nothing is stored: the code is derived again on every read, so a moved pin or a newer dataset never leaves a stale country behind, and existing pins need no backfill.

- **Purpose:** ISO 3166-1 alpha-2 code of the country or territory that contains a pin.
- **Inputs:** `{ lat, lng }` of a stored pin.
- **Returns / side effects:** Two upper-case letters, or `null` for a point in the open sea or outside every boundary. No I/O and no network call.
- **Used by:** `GET /messages/places` (`countryCode` on each pin) and `MessageStore.listFeed` (the `country` filter of `GET /messages`).

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

## Function: repaymentDescription

- **Purpose:** Build `repay:<dayIndex>:<recipientAccountId>` for an invoice attempt.
- **Inputs:** Day index and giver account id.
- **Returns / side effects:** That string. No I/O.

## Function: parseRepaymentDescription

- **Purpose:** Read a repayment marker.
- **Inputs:** Invoice description, or null.
- **Returns / side effects:** `{ dayIndex, recipientAccountId }`, or null. No I/O.

## Function: repaymentStartMs

- **Purpose:** First repayment day as a UTC midnight: the day after the credit filled, but never before 2026-11-10. A credit that filled on or before 2026-11-09 starts on 2026-11-10. A credit that filled later starts the next UTC day. Every due date and due-day count uses this start.
- **Inputs:** Epoch milliseconds when the credit filled.
- **Returns / side effects:** That midnight in epoch milliseconds. No I/O.

## Function: dueDayCount

- **Purpose:** How many term days are due at a clock. Counting starts at `repaymentStartMs`, so nothing is due before 2026-11-10.
- **Inputs:** Funded time, now, term days.
- **Returns / side effects:** A count from 0 through the term. No I/O.

## Function: dayUnits

- **Purpose:** Equal daily units. The last day keeps the remainder.
- **Inputs:** Total, day count, zero-based index.
- **Returns / side effects:** That day's units, or null. No I/O.

## Function: fiatAmountToCents

- **Purpose:** Cents of a typed fiat amount.
- **Inputs:** Canonical amount text.
- **Returns / side effects:** Cents, or null. No I/O.

## Function: repaymentSchedule

- **Purpose:** Plan every repayment so each giver gets back exactly the sats or cents they paid. A fraction below one unit carries to a later day.
- **Inputs:** Term in days, and each giver's positive units.
- **Returns / side effects:** The non-zero payments in day order. No I/O.
- **Used by:** `repaymentStatus`, `repaymentInvoice`, `repaymentDueBills`, `myLoansRoutes`.

## Function: repaymentDueDate

- **Purpose:** UTC calendar day of one repayment. Day 0 is `repaymentStartMs`: the day after the credit filled, never before 2026-11-10.
- **Inputs:** Funded time in epoch milliseconds, and the zero-based day.
- **Returns / side effects:** `YYYY-MM-DD`. No I/O.

## Function: formatCents

- **Purpose:** Write whole cents as a two-decimal amount.
- **Inputs:** A non-negative cent total.
- **Returns / side effects:** `whole.frac`. No I/O.

## Function: repaymentLedger

- **Purpose:** List every repayment share in day order. Each row is one bitcoin payment. A date is set only after the credit has filled. Status is paid, due, or scheduled.
- **Inputs:** Term, giver units, shares already paid, funded time or null, and the clock.
- **Returns / side effects:** The rows. No I/O.
- **Used by:** `repaymentStatus`.

## Function: payerDebtUnits

- **Purpose:** Units each giver is owed. Bitcoin asks use sats. Fiat asks use recorded cents of the goal currency, so one cent is owed as one cent. A missing snapshot splits the typed amount by sat weight. Sats with no account are weight that is then dropped, so they are not repaid to someone else.
- **Inputs:** Goal currency, typed amount, and each giver's sats plus recorded fiat.
- **Returns / side effects:** Units per giver, or `unavailable`. No I/O.
- **Used by:** `repaymentStatus`, `repaymentInvoice`, `repaymentDueBills`, `myLoansRoutes`.

## Function: shareSats

- **Purpose:** Split a day's sats across givers in proportion to what they paid.
- **Inputs:** Due sats and payer totals.
- **Returns / side effects:** Shares that add up to the due sats. No I/O.

## Function: repaymentStatus

- **Purpose:** `GET /messages/:id/repayment` with no session. The public ledger of who gave and each repayment. Each giver carries `canReceive` (`receivingAddress(account, lnurlServer) !== null`; a missing account is false). Each line carries `waiting` (a `due` line whose giver cannot receive) and `dueSats`: on a `due` line the share in sats (bitcoin: the share; fiat: priced at the rate the pay route uses now), null on any other line. The rate loader is read once per request (`dueSats` and `next.sats` share it); a due fiat share without a rate, or a rate loader that fails while a due fiat share has to be priced, is 503 `Ask amount is unavailable`, also when every due giver waits. `next` is the oldest due, unpaid share whose giver can receive. `waitingShares` counts the `waiting` lines. A due, unpaid share whose giver cannot receive is waiting: it does not hold back `daysPaid` and is not behind. When the giver's wallet is verified, the share can be paid from that day. A share whose day is before the UTC repayment day of the giver's `sparkPubkeyVerifiedAt` is still owed and payable, but never counts against `daysPaid` or as behind, so the waiting days do not become days behind later. `daysDue` counts the term days that have begun, today included; `daysPaid` counts the leading due days that have no other unpaid share.
- **Inputs:** Route deps and the request.
- **Returns / side effects:** The due schedule JSON.

## Function: repaymentInvoice

- **Purpose:** `POST /messages/:id/repayment`. BOLT11 for the oldest due, unpaid share whose giver can receive; shares of a giver who cannot receive (`receivingAddress` is null) are skipped, the order is otherwise unchanged (oldest day first, then schedule order). When every due share waits for such a giver the answer is 400 `{ error: 'A giver has no Lightning address', code: 'cannot_receive' }`, and the pay-time address check stays as the safety net. Every due share is priced first, so a fiat loan without a rate, or whose rate loader fails, is 503 `Ask amount is unavailable` before that 400. A second request for the same unpaid share returns the outstanding invoice instead of minting another, including when the sat price of that fiat share has moved, but only while it was minted for the giver's current wallet address; while an open invoice minted for another address is still payable it answers 409 `A payment for this share is still open`, and after it expires a new one is minted. The bill itself is made by the same internal bill helper as `repaymentDueBills`.
- **Inputs:** Route deps and the request.
- **Returns / side effects:** `{ pr, amountSats, sparkInvoice }` or an error. `sparkInvoice` is `null` when free in-app payments are off or `pr` is not for exactly the share amount; a giver without a verified wallet is the 400 `cannot_receive` instead. Records the invoice attempt only when a new invoice is minted, and only then takes one hit of the repayment invoice limiter.

## Function: repaymentDueBills

- **Purpose:** `POST /messages/:id/repayment/due`. Same author session and guards as `repaymentInvoice` (Bearer, `forum.pay`, a live funded repayable ask of the caller, Sunday rest through `sundayRest`, the repayment invoice limiter). Walks every due, unpaid share oldest first. A share whose giver can receive gets a bill made by the same internal bill helper as the single route (zap request, `repay:<day>:<accountId>` description, BOLT11 from the giver's wallet, stored invoice attempt, Spark invoice when free in-app payments are on); an open, still-payable bill for that share is returned instead, never a second one. A share whose giver cannot receive, or whose wallet refuses the zap (`cannot_receive`), is listed in `waiting` with no bill; a giver whose wallet refused is not asked again in the same call, and that giver's other due shares wait too. Each giver's name is read once per call.
- **Bounds and limits:** At most `REPAYMENT_BILLS_MAX` (60) bills per call; later payable shares come on the next call; they are not priced and get no bill, while deciding who can receive still reads each giver once per call. The repayment invoice limiter is asked once per call, by the first bill that has to be minted; reused bills do not ask it. A denied limiter answers 429 `Too many payments` with `Retry-After: 10`.
- **Inputs:** Route deps and the request.
- **Returns / side effects:** 200 `{ bills, waiting }`. A bill is `{ dayIndex, recipientAccountId, name, username, amountSats, amount, pr, sparkInvoice }`, a waiting line the same without `pr` and `sparkInvoice`. `amount` is the two-decimal share in the ask currency for a fiat loan, else null. Nothing due is 200 with both lists empty, without reading the rate. Any other bill error (an unsigned note, a giver without a Nostr key, a share still open on another address, an unreachable wallet, missing signing keys, a failed store write) is the single route's answer for the whole call; bills already minted stay stored and are reused on the next call. 503 `Ask amount is unavailable` when the debt or a fiat share cannot be priced, including when the rate loader fails while a due fiat share has to be priced. Settlement is unchanged.
- **Used by:** `messagesRoutes`.

## Function: myLoansRoutes

- **Purpose:** Hono sub-app for `GET /me/loans`, mounted at `/` by `createApp`. Bearer session required. Lists the caller's live (not hidden) top-level repayable asks with a term from `listAuthoredMessages`, newest first, that are still collecting or not fully repaid; a funded loan whose every scheduled share is paid is left out.
- **Per loan:** `messageId`, the first 160 characters of the text, `createdAt`, `goalSats`, collected `sats`, `goalCurrency` (`BTC` when none is stored) and `goalAmount` (the goal sats as text when none is stored), the four `goalAmount*` snapshots and the four collected `amount*` totals, `termDays`, `fundedAt`, `daysDue`, `daysPaid`, `repaidSats` (sum of settled shares), and `totalSats` (`repaidSats` plus every unpaid share priced in sats; for a fiat loan at the rate the pay route uses now, read once per request for every loan and only for a loan with something to price, null without a rate; sats with no account are not counted). `due` covers every due, unpaid share: `payableSats` / `payableAmount` / `payablePeople` for givers who can receive, `waitingSats` / `waitingAmount` / `waitingPeople` / `waitingShares` for the others, `behindDays` (due days before the current UTC repayment day that still have an unpaid share that is not waiting and did not fall due before its giver's wallet was verified), and `lastPayment` (paying `payable` would finish the loan). `next` is the first later repayment day `{ dueOn, sats, amount }`, or null. Amounts are two-decimal strings for a fiat loan and null for bitcoin; fiat sats are null without a rate. A loan still collecting has zeros in `due` and `next: null`.
- **Inputs:** `{ store, authStore, now, goalRateDay?, lnurlServer? }`.
- **Lender waiting:** `lenderWaiting` `{ shares, loans, sats }`: when the caller cannot receive (`receivingAddress` is null), the due, unpaid shares owed to the caller over every live funded repayable ask named by the caller's own invoice attempts (`listInvoiceAttemptsForPayer`, `repay:` attempts left out) whose `listCreditPayers` includes the caller, with the number of those loans and their sats (fiat priced at the same one rate read; null when one has no rate). All zero, without reading invoices, when the caller can receive.
- **Returns / side effects:** 200 `{ sundayRest, loans, lenderWaiting }`. `sundayRest` is `isSundayRestHeader(now, Time-Zone)`, the rule that refuses repayments today. 401 without a session; 503 `Ask amount is unavailable` when the debt of a loan of the caller, or of a loan the caller gave to, cannot be computed, or the rate loader fails; 503 `Messages are unavailable` and a `me.loans.failed` log line when the store throws. Read-only.
- **Used by:** `createApp`.

## Function: serializeMessage

- **Purpose:** Project a stored forum row to its public JSON shape including zap totals (`sats` is the amount sent with a reply and the collected total on a top-level note; a reply always includes `receivedSats` and the four `receivedAmount*` keys for later payments, omitted on a note), payability, `hasPhoto`, `photoCount` (0–10; from `row.photoCount` or `hasPhoto ? 1 : 0`), `hasVideo`, `videoContentType`, live author role, optional `via`, optional `replyCount`, optional `accountId`, optional `mentions` (`{ username, accountId }[]` only when `accountId` is included and the stored list is non-empty), optional `parentId`, optional `goalSats` (included when the stored value is a positive integer on a top-level note; omitted on replies and when unset, null, or 0), optional `goalRepayable: true` only when the stored column is true (omitted when null; never false; omitted on replies), optional `goalTermDays` when the stored column is not null (omitted when null; omitted on replies), optional `goalCurrency` / `goalAmount` / `goalAmountUsd` / `goalAmountChf` / `goalAmountEur` / `goalAmountPhp` (only when `goalCurrency` is set and `goalAmount` is a string; snapshot keys stay present when null; omitted entirely for legacy rows), optional `place` (included only when both coordinates are stored; omitted when unset; `address` is the structured postal address or JSON `null`), optional `shopAccount` (`{ id, username, name }`, included when stored and omitted when unset or when the till account has no username, including when `accountId` is omitted), and optional hide stamps. When stored `name` is empty after trim, JSON `name` is `truncatePubkeyDisplay(row.authorPubkey ?? '')` (`'npub'` when the pubkey is missing); non-empty names are unchanged. Invalid `createdAt` is not guarded here: `toISOString()` still throws. `GET /messages/:id/replies` and `GET /members/:accountId/replies` omit that child (200, siblings remain); `GET /messages` (list), `GET /members/:accountId/posts`, and public `GET /messages/:id` return 503. Member feeds reuse this: `GET /members/:accountId/posts` is newest-first like signed-in `GET /messages`; `GET /members/:accountId/replies` is newest-first with `authorCanReceive` (author has a receiving address) and `payable` when a non-empty `eventId` and a receiving address (`receivingAddress`: a verified wallet with the LNURL server configured) are set. Callers that serve list/GET/replies delete a `hasVideo` row when the file is missing or empty on disk (`forumVideoFilePresent`) so no empty note remains. Optional `hidden?: { deletedAt: Date; deletedBy: { id, name, role } }`: when set, JSON `deletedAt` is ISO, `deletedBy` is copied, and `payable` and `authorCanReceive` are false (ignore the pay arg). When omitted, do not set those keys (live JSON has no `deletedAt` / `deletedBy`). Last optional argument `staffTag`: JSON `staffTag` is `"software_developer"` only when that argument is exactly that string, otherwise the key is omitted (never JSON `null`). Store-internal `contentFp` is never included.
- **Inputs:** `MessageRow` (includes `accountId` and private `authorPubkey`; never photo/video bytes), `pay` (`MessagePay` from `messagePay`, or `NOT_PAYABLE`), optional `role` (`AccountRole`; omitted for external Nostr authors), optional `replyCount` (top-level `GET /messages` and `GET /members/:accountId/posts` list rows, and single-note `GET /messages/:id` for a top-level note), optional `includeAccountId` (live list, single-note GET, and replies pass true with or without a session, as do signed-in create, member feeds, and staff hidden GET), optional `hidden?: { deletedAt: Date; deletedBy: { id, name, role } }`, and last optional `staffTag` (`StaffTag | null`).
- **Returns / side effects:** `{ id, name, text, createdAt, sats, amountUsd, amountChf, amountEur, amountPhp, payable, authorCanReceive, hasPhoto, photoCount, photoTakenAts, hasVideo, videoContentType, shopNpub }` with ISO-8601 `createdAt`; `shopNpub` is `row.shopNpub` while the row is a listed shop (`isListedShop`), otherwise `null`; the four amounts are always present (string or null); a reply also includes `receivedSats` (`row.receivedSats ?? 0`) and `receivedAmountUsd` / `receivedAmountChf` / `receivedAmountEur` / `receivedAmountPhp` (stored string or null); a top-level note omits those five keys; `photoTakenAts` length equals `photoCount` (null slots when unknown, `[]` when there are no stills); `photoTakenAt` is included only when `photoCount === 1` and equals `photoTakenAts[0]`; `name` uses the blank-name fallback when stored `name` trims empty; `photoCount` is 0–10 (from `row.photoCount` or `hasPhoto ? 1 : 0`); `videoContentType` is null when `hasVideo` is false; `via: 'nostr'` is set exactly when `row.accountId === null && row.authorPubkey !== null`; those external rows have `payable` and `authorCanReceive` false and omit `role`; the pubkey itself is private and never appears in public JSON. `role` is otherwise omitted when undefined; `replyCount` is omitted when undefined; `accountId` is set only when `includeAccountId` is true and `row.accountId !== null` (live list, single-note GET, and replies include it whenever the stored author id is non-null, with or without a session, and still omit it for an external row); `mentions` is set only when `includeAccountId` is true and the stored list is non-empty; `parentId` is set only when `row.parentId !== null` (omitted on top-level notes); `goalSats` included only when the stored value is a positive integer on a top-level note (omitted on replies and when unset, null, or 0); `goalRepayable` is included only when stored true (omitted when null, never false, omitted on replies); `goalTermDays` is included only when stored (omitted when null, omitted on replies); `goalCurrency`, `goalAmount`, and `goalAmountUsd` / `goalAmountChf` / `goalAmountEur` / `goalAmountPhp` included only when `goalCurrency` is set and `goalAmount` is a string (snapshot keys stay present when null; omitted entirely for legacy rows); `place` included only when both coordinates are stored (omitted when unset; JSON `address` is the structured postal address or `null`); `shopAccount` included only when stored (omitted when unset or without a username, including when `accountId` is omitted); when `hidden` is set, `deletedAt` ISO, `deletedBy` copied, `payable` and `authorCanReceive` false; when omitted, those keys are not set; never photo/video bytes or `contentFp`. JSON `staffTag` is `"software_developer"` only when that argument is exactly that string, otherwise the key is omitted (never JSON `null`). No I/O.
- **Used by:** `messagesRoutes`, `membersRoutes`.

## Function: messagePay

- **Purpose:** Pay flags of one forum row for `serializeMessage`. `authorCanReceive` is `receivingAddress` of the author being non-null (a verified wallet with the LNURL server configured). `payable` adds the mint gate: a non-empty signed `eventId`. Every route that serializes a member-authored note uses it, so `payable` and `authorCanReceive` never drift apart. `NOT_PAYABLE` (both false) is the value for external rows and soft-hidden staff views.
- **Inputs:** `{ eventId }` of the row, the author account (`username`, `sparkPubkey`, `sparkPubkeyVerifiedAt`) or `undefined`, and the `LnurlServerConfig` or `undefined`.
- **Returns / side effects:** `{ payable, authorCanReceive }`; both false without an author. No I/O.
- **Used by:** `messagesRoutes`, `membersRoutes`, `fundingRoutes`.

## Function: attachHeartStats

- **Purpose:** Attach `heartCount` and `hearted` to each public forum message JSON without changing `serializeMessage`. Missing stats are `heartCount` 0 and `hearted` false. Calls `statsFor` once with every id in this response, never once per row.
- **Inputs:** `statsFor` (`MessageStore.heartStats` or the same shape), `viewerAccountId` (`string | null`), and the already serialized messages (`{ id: string }[]`).
- **Returns / side effects:** New objects in the same order, each with both keys. Input objects are not mutated. One `statsFor` call per `attachHeartStats` call.
- **Used by:** `messagesRoutes`, `membersRoutes`, `fundingRoutes`.

## Function: heartStats

- **Purpose:** Count claimed 1-sat hearts on forum messages. A heart counts only when the invoice is a heart, `result` is `ok`, the payment hash is set, and that lowercase hash is claimed in `nostr_zap_payment`. An unpaid invoice and a paid gift that is not a heart do not count. Empty `messageIds` returns an empty map without a query. Ids with no matching heart are omitted. `hearted` is true only when `viewerAccountId` is set and that account paid at least one counted heart.
- **Inputs:** `messageIds` and `viewerAccountId` (`string | null`) on `MessageStore`.
- **Returns / side effects:** `Map` of `{ heartCount, hearted }` per matching message id. Postgres uses one query; in-memory scans invoice attempts and zap payment claims. No look at the message table.
- **Used by:** `attachHeartStats`.

## Function: serializeDebugMessage

- **Purpose:** Project a stored forum row to operator debug JSON, including soft-hide stamps, Damus-only `accountId: null`, `photoCount`, every `MessageRow` Nostr column (`nostrEvent`, `claimedUntil`, `nostrFirstAttemptAt`, `nostrPublishEpoch`, `contentFp`), photo MIME/byte lengths, stored `goalSats` (JSON `null` when unset), `goalRepayable` true only when stored true (omitted when null, never false), `goalTermDays` when stored (omitted when null), currency-ask keys only when `goalCurrency` and `goalAmount` are stored, and `placeLat` / `placeLng` / `placeLabel` / `placeStreet` / `placeHouseNumber` / `placePostalCode` / `placeCity` / `placeCountry` / `shopAccountId` (JSON `null` when unset). Public hide does not apply: hidden rows keep `text` and ISO `deletedAt`. Never includes nsec or photo/video payloads.
- **Inputs:** `MessageRow` (includes hidden rows and replies; never photo/video bytes) and optional `DebugMessagePhotoMeta` (`photoContentType`, `photoBytes`, `extraPhotos`; omitted → `null` / `0` / `[]`).
- **Returns / side effects:** `{ id, name, text, createdAt, sats, amountUsd, amountChf, amountEur, amountPhp, hasPhoto, photoCount, photoTakenAts, hasVideo, videoContentType, parentId, eventId, nostrPublishState, nostrEvent, claimedUntil, nostrFirstAttemptAt, nostrPublishEpoch, contentFp, deletedAt, deletedBy, authorPubkey, nostrAttempts, accountId, goalSats, goalRepayable, goalTermDays, placeLat, placeLng, placeLabel, placeStreet, placeHouseNumber, placePostalCode, placeCity, placeCountry, shopAccountId, photoContentType, photoBytes, extraPhotos }` (`photoTakenAts` length equals `photoCount`; `photoTakenAt` only when `photoCount === 1`; each extra still includes `photoTakenAt`) with ISO-8601 `createdAt` / `deletedAt`; the four amounts are always present (string or null); (`deletedAt` JSON `null` when live); `photoCount` is 0–10 (from `row.photoCount` or `hasPhoto ? 1 : 0`); `accountId` is a string or JSON `null` (never omitted); `goalSats` is the stored column (JSON `null` when unset); `goalRepayable` is included only when stored true (omitted when null, never false); `goalTermDays` is included only when stored (omitted when null); `goalCurrency`, `goalAmount`, and the four `goalAmount*` snapshots are included only when `goalCurrency` and `goalAmount` are stored (snapshots may be null; omitted on legacy rows); `placeLat`, `placeLng`, `placeLabel`, `placeStreet`, `placeHouseNumber`, `placePostalCode`, `placeCity`, `placeCountry`, and `shopAccountId` are JSON `null` when unset. `shopAccountId` is the assigned shop account id, not the author. Invalid `createdAt` / `deletedAt` still throws from `toISOString()`. No I/O.
- **Used by:** `debugMessagesRoutes`, `loadDebugTables`.

## Function: serializeHiddenMessage

- **Purpose:** Project a stored forum row to staff hidden-log JSON (who hid it and when). JSON `name` is the stored `row.name` (no empty-name pubkey fallback). Always includes `parentId` (JSON `null` on top-level notes), ISO `deletedAt` (JSON `null` when live), and `photoCount` (0–10; from `row.photoCount` or `hasPhoto ? 1 : 0`). Optional `goalSats` when the stored value is a positive integer on a top-level note (omitted on replies and when unset, null, or 0). Optional `goalRepayable: true` only when stored true (omitted when null, never false, omitted on replies). Optional `goalTermDays` when stored (omitted when null, omitted on replies). Optional currency-ask keys when `goalCurrency` and `goalAmount` are stored (omitted on legacy rows; snapshot keys may be null). Optional `place` when both coordinates are stored (omitted when unset; `address` is the structured postal address or JSON `null`). Optional `shopAccount` (`{ id, username, name }`) when a shop account is stored (omitted when unset or without a username). Optional `via: 'nostr'` is set exactly when `row.accountId === null && row.authorPubkey !== null`; the pubkey itself is private and never appears in this JSON. Includes `accountId` for a 21.gifts author and omits it for an external row. Never includes `eventId`, `nostrPublishState`, `payable`, `authorCanReceive`, author `role`, `nostrEvent`, `claimedUntil`, `contentFp`, nsec, or photo/video bytes. Deleter `{ id, name, role }` is resolved in `messagesRoutes`, not here.
- **Inputs:** `MessageRow` (includes hidden rows and replies; never photo/video bytes) and `deletedBy: { id, name, role }` (`AccountRole | null`; `id` / `name` may be null).
- **Returns / side effects:** `{ id, name, text, createdAt, sats, amountUsd, amountChf, amountEur, amountPhp, hasPhoto, photoCount, photoTakenAts, hasVideo, videoContentType, parentId, accountId?, deletedAt, deletedBy, via? }` (`photoTakenAts` length equals `photoCount`; `photoTakenAt` only when `photoCount === 1`) with ISO-8601 `createdAt` / `deletedAt`; the four amounts are always present (string or null); (`deletedAt` JSON `null` when live); `photoCount` is 0–10 (from `row.photoCount` or `hasPhoto ? 1 : 0`); `via: 'nostr'` is set exactly when `row.accountId === null && row.authorPubkey !== null`, while the pubkey itself is never included; optional `goalSats` when the stored value is a positive integer on a top-level note (omitted on replies and when unset, null, or 0); optional `goalRepayable: true` only when stored true (omitted when null, never false, omitted on replies); optional `goalTermDays` when stored (omitted when null, omitted on replies); optional `goalCurrency`, `goalAmount`, and the four `goalAmount*` snapshots when `goalCurrency` and `goalAmount` are stored (omitted on legacy rows; snapshots may be null); optional `place` when both coordinates are stored (omitted when unset; JSON `address` is the structured postal address or `null`); optional `shopAccount` when a shop account is stored (omitted when unset or when the till account has no username). Invalid `createdAt` / `deletedAt` still throws from `toISOString()`. No I/O.
- **Used by:** `messagesRoutes` (`GET /messages/hidden`).

## Function: serializeConversation

- **Purpose:** Project a stored thread to its public list JSON shape.
- **Inputs:** `ConversationThread` with resolved `name` / `lastText`, `lastFromMe` boolean, `unread` boolean, `unreadMessageCount` number, optional counterpart `accountId` (`string | null`), and optional `canReceive` (default `false`).
- **Returns / side effects:** `{ id, kind, name, lastText, lastMessageId, lastAt, lastFromMe, lastSats, amountUsd, amountChf, amountEur, amountPhp, unread, unreadMessageCount, accountId?, canReceive }`. `canReceive` is always present: whether the counterpart has a receiving address. The four amounts are always present (string or null; the last message's stored payment-time fiat). `unreadMessageCount` is always present (inbound messages after last-read; `0` when none). `lastSats` is the last message's sats (`0` when unpaid or the thread is empty). `lastMessageId` is the id of the newest message (`created_at DESC, id DESC`) or `null` when the thread is empty; always present; the list does not translate. Includes `accountId` only when the counterpart id is a non-empty string. Omits event ids, npubs, `accountA` / `accountB`. No I/O.
- **Used by:** `conversationRoutes`.

## Function: serializeNotification

- **Purpose:** Project a stored notification row to its public JSON shape. `type` is `'forum_post' | 'forum_reply' | 'forum_mention' | 'zap' | 'heart' | 'moderator_appointed' | 'moderator_proposal'`.
- **Inputs:** `NotificationRow` (includes recipient/actor account ids).
- **Returns / side effects:** `{ id, type, parentId, replyId, name, text, createdAt, readAt }` with ISO-8601 dates; `readAt` null stays null. Omits recipient and actor account ids. No I/O.
- **Used by:** `notificationRoutes`.

## Function: fanoutToBellSubscribers

- **Purpose:** Fan out in-app rows and optional Web Push outbox rows except `skipAccountId`. In-app recipients are the union of `auth.listAccounts()` (when `auth` is set) and `push_subscription` account ids. Web Push outbox rows go only to `push_subscription` accounts. Optional `onlyAccountIds` restricts both recipient sets before notification-level matching. Optional `excludeAccountIds` then drops those ids from both the in-app list and the push list (after skip and after `onlyAccountIds`), even when `auth` is omitted; unknown ids are a no-op. Optional `match` `{ isActive, mentionedAccountId }` then filters when `auth` is also set: drop recipients whose `wantsNotification` is false (level from `listAccounts()`, omitted → `all`; push-only ids not in that list are `all`). When `auth` is unset, do not filter by level even if `match` is passed. Omitted `match` keeps every-id-except-skip behaviour. Missing both `auth` and `pushStore` is a no-op. Unique duplicate `create` is fine. Outbox JSON may include optional `unreadCount` for the home-screen badge: notification unread + listed inbox unread when `inboxUnreadCount` is passed. Either source alone still writes `unreadCount` (missing source is 0).
- **Inputs:** `{ notifications?, pushStore?, auth?, skipAccountId, onlyAccountIds?, excludeAccountIds?, match?, template, outboxType, outboxMessageId, payload, nowMs, inboxUnreadCount? }`. `skipAccountId` `null` skips nobody. `onlyAccountIds` is an allowlist for in-app and push recipients. `excludeAccountIds` is a denylist applied after skip and after `onlyAccountIds`. `match` is applied only when `auth` is also set. `template` is copied to each in-app recipient (`id` / `recipientAccountId` filled here). `payload` is the shared JSON template (no `unreadCount`).
- **Returns / side effects:** Void. Logs `push.fanout` with `inApp` and `push` counts. Writes a notification row per in-app id when `notifications` is set, then enqueues one pending outbox row per push id when `pushStore` is set. When `notifications` or `inboxUnreadCount` is set, each outbox JSON is the parsed template plus `unreadCount` (invalid JSON or a non-object template becomes `{ unreadCount }`). When both are omitted, the payload is unchanged. Per-recipient `create`/`unreadCount`/inbox/`enqueue` failures log `push.fanout.failed`, continue, then throw after the loops. Does not copy DMs into notification rows.
- **Used by:** `notifyForumPost`, `notifyForumReply`, `notifyExternalForumReply`, `notifyZap`.

## Function: notifyForumPost

- **Purpose:** Notify living-room members of a new top-level forum post except the actor. No-op when the actor is the official platform account (`isPlatform === true` via `auth.listAccounts()`). Missing auth / missing id / missing account / `isPlatform` not true still fans out. Persist a `forum_post` row when `notifications` is set (`parentId` and `replyId` are the post id) for every matching account when `auth` is set (otherwise bell subscribers) and enqueue a `/messages/<postId>` Web Push (`tag` `forum_post:<postId>`) when `pushStore` is set. Matching uses `wantsNotification`: `isActive` is `created.sats > 0`, `mentionedAccountId` is null (top-level posts are never personal). A staff or platform actor does not satisfy mentions. When `auth` is unset, do not filter by level. Missing `pushStore` still writes in-app rows when `auth` is set. Optional `excludeAccountIds` is forwarded to fan-out (omitted means today's recipients). May throw; callers wrap so persist still succeeds.
- **Inputs:** `{ notifications?, pushStore?, auth?, account, created, inboxUnreadCount?, excludeAccountIds? }`.
- **Returns / side effects:** Void. Calls `fanoutToBellSubscribers` with skip id `account.id`, optional `excludeAccountIds`, match from the post, and payload from `buildForumPushPayload` (id, name, text, and media flags from `created`). Forwards `inboxUnreadCount`. Outbox JSON `unreadCount` is notification unread + listed inbox unread when either source is passed.
- **Used by:** `messagesRoutes` after a successful top-level `POST /messages` create; `meRoutes` after a won `PUT /me/about` create (`notifyForumPost` after `updateText` with the bio); `settleInvoiceManually` / `indexOpenZapReceipts` after a platform-note compose creates a top-level post (`insertGiftReply`).

## Function: notifyForumReply

- **Purpose:** Notify living-room members of a forum reply except the actor. Persist a `forum_reply` row when `notifications` is set and enqueue a `/messages/<replyId>` Web Push (`tag` `forum_reply:<replyId>`, not the parent id) when `pushStore` is set. No-op when the parent is missing. No-op when the actor is the official platform account (`isPlatform === true` via `auth.listAccounts()`). Missing auth / missing id / missing account / `isPlatform` not true still fans out. Damus-only parents and self-replies still fan out (the actor is skipped). Photo-only empty text still notifies. Matching uses `wantsNotification`: `isActive` is `parent.sats > 0`, `mentionedAccountId` is `parent.accountId` (null when the parent has no account). A staff or platform actor does not satisfy mentions. When `auth` is unset, do not filter by level. Missing `pushStore` still writes in-app rows when `auth` is set. Optional `excludeAccountIds` is forwarded to fan-out (omitted means today's recipients). Unique duplicate create is fine. May throw; callers wrap so persist still succeeds.
- **Inputs:** `{ messages, notifications?, pushStore?, auth?, account, created, parentId, inboxUnreadCount?, excludeAccountIds? }`.
- **Returns / side effects:** Void. After parent lookup, calls `fanoutToBellSubscribers` with skip id `account.id`, optional `excludeAccountIds`, match from the parent/actor, and payload from `buildReplyPushPayload` (id, name, text, and media flags from `created`). Forwards `inboxUnreadCount`. Outbox JSON `unreadCount` is notification unread + listed inbox unread when either source is passed. Does not copy DMs into notification rows.
- **Used by:** `messagesRoutes` after a 21.gifts-author reply `POST /messages`; `runNostrWorkerTick` after inbound member reply persist; `settleInvoiceManually` / `indexOpenZapReceipts` after a platform-note compose creates a reply (`insertGiftReply`).

## Function: notifyZap

- **Purpose:** Notify living-room members of a newly indexed zap/payment except the payer. Persist a `zap` row when `notifications` is set (`text` is `String(amountSats)`, name default `'Someone'`, `replyId` is the first 32 hex of the 64-hex receipt id hyphenated 8-4-4-4-12) and enqueue a `/messages/<noteId>` Web Push (`tag` `zap:<replyId>`) when `pushStore` is set. No-op when the note has no `accountId`. No-op when `payerAccountId` is the official platform account (`isPlatform === true` via `auth.listAccounts()`). Do not skip when `payerAccountId` is omitted. Missing auth / missing account / `isPlatform` not true still fans out. Does not skip the note author unless they are also `payerAccountId`. Matching uses `wantsNotification`: `isActive` is `note.sats > 0` or `amountSats > 0` (first gift still counts), `mentionedAccountId` is `note.accountId`. A staff or platform actor does not satisfy mentions. When `auth` is unset, do not filter by level. Missing `pushStore` still writes in-app rows when `auth` is set. May throw; callers wrap so persist still succeeds.
- **Inputs:** `{ notifications?, pushStore?, auth?, note, receiptId, amountSats, nowMs, payerAccountId?, payerName?, inboxUnreadCount? }`.
- **Returns / side effects:** Void. Calls `fanoutToBellSubscribers` with skip id `payerAccountId ?? null`, match from the note/payer, and payload from `buildZapPushPayload` (`replyId`, `noteId` `note.id`, payer name or `Someone`, and `amountSats`). Forwards `inboxUnreadCount`. Outbox JSON `unreadCount` is notification unread + listed inbox unread when either source is passed.
- **Used by:** Zap ingest in `indexOpenZapReceipts` when `indexZapReceipt` newly indexed a member-note receipt (not the official platform profile note, and not a heart invoice).

## Function: notifyHeart

- **Purpose:** Notify only the author of a newly indexed heart tip. Persist one `heart` row when `notifications` is set (`text` `"1"`, name default `'Someone'`, `parentId` the note id, `replyId` the same receipt-derived UUID as `notifyZap`) and enqueue a `/messages/<noteId>` Web Push (`tag` `heart:<replyId>`, body exactly `Sent you a heart.`) when `pushStore` is set. No-op when the note has no `accountId`, when `payerAccountId` is the author, when the author account is missing, or when the author's `notifyHearts` is false. Does not fan out to the living room. Does not consult `wantsNotification` or `notificationLevel`. Missing both stores is a no-op. May throw; callers wrap so persist still succeeds.
- **Inputs:** `{ notifications?, pushStore?, auth?, note, receiptId, nowMs, payerAccountId, payerName?, inboxUnreadCount? }`. `auth` must provide `getAccount` so the author's `notifyHearts` can be read.
- **Returns / side effects:** Void. Writes one in-app row for the author when `notifications` is set. When `pushStore` is set, enqueues one outbox row (`type: 'zap'`, `messageId` the note id) with payload from `buildHeartPushPayload`. Outbox JSON `unreadCount` is notification unread + listed inbox unread when either source is passed.
- **Used by:** Zap ingest in `indexOpenZapReceipts` and `settleInvoiceManually` when the ok invoice for the payment hash has `heart === true`.

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

- **Purpose:** Map a stored or request value to the owner fan-out enum so omitted and unknown strings keep current every-account behaviour. Accepts `all`, `active`, `mentions`, and `none`; any other input (number, null, undefined, object, unknown string) becomes `all`.
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

## Function: staffTagOf

- **Purpose:** Map stored text to the staff label. Only the exact string `software_developer` is kept. It is not a permission role and does not change `role`.
- **Inputs:** `raw` unknown.
- **Returns / side effects:** `StaffTag | null`. No I/O. Never throws.
- **Used by:** `mapAccount`, `serializeAccount`, `serializeMessage` callers, and `GET /members/:accountId`.

## Function: isStaffAccount

- **Purpose:** Role and platform predicate, not a mentions shortcut. True when `isPlatform === true` or `roleAtLeast(role, 'moderator')` for a known role (`basis` and `verified` are false unless `isPlatform`). Unknown role strings are not staff. A staff or platform actor does not satisfy mentions. Does not parse display names or @mentions out of post text.
- **Inputs:** `{ role: string; isPlatform?: boolean }`.
- **Returns / side effects:** boolean. No I/O.
- **Used by:** Exported. Not called by `wantsNotification`, `notifyForumPost`, `notifyForumReply`, or `notifyZap`. `actorIsStaffFromAuth` does not exist.

## Function: wantsNotification

- **Purpose:** Whether a recipient at `level` should receive this living-room event for in-app rows and Web Push. `none` is always false. `all` is always true. `active` is `isActive`. `mentions` is only `mentionedAccountId !== null && mentionedAccountId === recipientAccountId`. A staff or platform actor does not satisfy mentions.
- **Inputs:** `{ level: NotificationLevel; isActive: boolean; mentionedAccountId: string | null; recipientAccountId: string }`.
- **Returns / side effects:** boolean. No I/O.
- **Used by:** `fanoutToBellSubscribers` after skip when `auth` and `match` are set.

## Function: notificationsMatchingLevel

- **Purpose:** Keep stored in-app rows the owner's current `notificationLevel` would still accept, same rules as `wantsNotification`. `all` returns the rows unchanged. `moderator_appointed`, `moderator_proposal`, and `heart` always stay. `forum_post` is never personal (`mentionedAccountId` null). `forum_mention` is personal for the marked recipient and active only when the parent exists and `parent.sats > 0` (a missing parent is not active and still personal). Level `none` drops stream rows and `forum_mention` and still keeps `heart`, `moderator_appointed`, and `moderator_proposal`. `forum_reply` / `zap` use the parent note's `accountId` and `sats` from `parentById`; a missing parent is unpaid and not personal. Zap `text` is the amount string and still counts as active when `> 0`. A staff or platform actor does not satisfy mentions. The `accounts` argument stays on the signature and is not read.
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
- **Returns / side effects:** `{ id, name, text, createdAt, fromMe, sats, amountUsd, amountChf, amountEur, amountPhp, hasPhoto, photoCount, accountId?, giftFor?, mentions? }`. The four amounts are always present (string or null). Always includes `hasPhoto` (boolean) and `photoCount` (0–10); never photo bytes. `sats` is the message amount (`0` when unpaid). Staff with `actorAccountId` get actor `name`/`accountId`; members get sender fields. `giftFor` is set from `giftForMessageId` when that id is a non-empty string (paid moderator stipend). `mentions` is `{ accountId, username }[]` when the stored list is non-empty, and omitted when the message marks nobody. A mark is a profile link and does not notify. Omits event ids, `senderAccountId`, and `senderPubkey`. No I/O.
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
- **Used by:** public resolve (`GET /lightning-address`) and the spend lookups (`GET /invoices/passkey|eligible|posted`, `POST /invoices`) before `accountByReceivingAddress`.

## Function: parseBindAddr

- **Purpose:** Parses `host:port` bind spec.
- **Inputs:** `addr` string.
- **Returns / side effects:** `{ host, port }`. Throws on garbage.
- **Used by:** `index.ts` boot.

## Function: randomHex

- **Purpose:** CSPRNG hex for session tokens, passkey challenge ids, and view keys.
- **Inputs:** `byteLength`.
- **Returns / side effects:** Lowercase hex.
- **Used by:** `issueSession`, passkey begin, debug provisioning (`viewKey`).

## Function: presentClientFields

- **Purpose:** Copies the non-null fields of a validated client-request record, in `clientIp`, `clientCountry`, `cfRay`, `userAgent`, `acceptLanguage`, `origin` order. Absent headers stay omitted so a log line does not print nulls.
- **Inputs:** `ClientRequestMeta`.
- **Returns / side effects:** A string map. No I/O.
- **Used by:** `requestLog` (the request-scoped log fields) and `diagnosticsRoutes`.

## Function: readClientRequestMeta

- **Purpose:** Reads `cf-connecting-ip`, `cf-ipcountry`, `cf-ray`, `user-agent`, `accept-language`, and `origin`. Keeps an IPv4 address with no leading zeros, or an IPv6 address including compressed and IPv4-mapped forms, unchanged. Keeps a country code of two letters or digits after trim and uppercase, so `T1` stays. Keeps a Cloudflare ray id of 16 hex digits, a hyphen, and three letters. Strips controls from the user agent and accept-language and cuts each at 200 characters. Keeps an `https` origin, or `http://localhost` or `http://127.0.0.1`, with an optional port. Drops a port or zone id on the IP, a hostname, `x-forwarded-for`, userinfo, a path, a query, or any other `http` host. Does not read the socket.
- **Inputs:** A headers object with `get(name)`.
- **Returns / side effects:** `ClientRequestMeta`. Each field is the original text or `null`. No I/O.
- **Used by:** `requestLog` and `diagnosticsRoutes`.

## Function: readPublicBrandFile

- **Purpose:** Reads `public/<name>` relative to a root directory.
- **Inputs:** `BrandFileName` and optional `root` (default `process.cwd()`).
- **Returns / side effects:** `Uint8Array` or `null` if missing. Does not change the process cwd.
- **Used by:** Default `brandRoutes` reader.

## Function: logPoolOptions

- **Purpose:** Options for the Bun SQL pool that serves `api_log` and `diagnostic_event`. `max` is 4. `connection.statement_timeout` and `connection.lock_timeout` are Postgres startup parameters in milliseconds (`5000` and `2000`) and apply only to that pool. Request queries and boot migrations use the other client, so a stuck log insert cannot occupy a request connection and cannot hold the HTTP response.
- **Inputs:** None.
- **Returns / side effects:** `{ max, connection }` for `new SQL(databaseUrl, options)`. No I/O.
- **Used by:** `createBunDatabase` in `src/index.ts`.

## Function: requestLog

- **Purpose:** Hono middleware: `http.request` JSON after the handler, then one `api_log` row. Skips `/healthz` and OPTIONS. Never logs the query string, body, or Authorization. Path is passed through `requestLogPath` so `/view/<segment>` is redacted. `ms` is handler duration (captured once after `next`). Auth-classification failure still stores `authKind: 'none'` with `accountId` null. The row always includes `clientIp`, `clientCountry`, `cfRay`, `userAgent`, `acceptLanguage`, and `origin`, each null when that header is missing or invalid. `logEvent` during the request merges the present values underneath the explicit fields, and explicit fields win. The audit write starts after `http.request` and does not delay the response unless `awaitWrite` is true, so a stuck insert cannot hold the client open. Store write failure logs `api_log.write.failed` and does not replace the response.
- **Inputs:** `{ apiLogStore, authStore, debugToken, spendApiToken, now?, awaitWrite? }`.
- **Returns / side effects:** `MiddlewareHandler`.
- **Used by:** `createApp`.

## Function: serializeDebugApiLog

- **Purpose:** Project an `api_log` row to operator JSON (`createdAt` ISO-8601).
- **Inputs:** `ApiLogRow`.
- **Returns / side effects:** `DebugApiLog`. No I/O.
- **Used by:** `debugApiLogRoutes`, `loadDebugTables`.

## Function: InMemoryApiLogStore

- **Purpose:** Process-local `ApiLogStore` (newest `createdAt` then `id` desc; `listPage` keyset).
- **Inputs:** Optional seed rows.
- **Returns / side effects:** `append` / `listLatest` / `listPage` copies.
- **Used by:** `createApp` default; tests.

## Function: PostgresApiLogStore

- **Purpose:** Durable `ApiLogStore` over `api_log` (`append`, `listLatest`, `listPage`).
- **Inputs:** Parameter-bound `SqlClient` (already migrated).
- **Returns / side effects:** `append` inserts; `listLatest` / `listPage` newest-first selects. No UPDATE/DELETE.
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: migrateApiLogSchema

- **Purpose:** Idempotent DDL for `api_log`. Must run after `account` exists and before `migrateDbChangeSchema`.
- **Inputs:** `SqlClient`.
- **Returns / side effects:** Executes `API_LOG_SCHEMA_SQL` in order.
- **Used by:** `openBootStores`.

## Function: migrateDiagnosticSchema

- **Purpose:** Apply the `diagnostic_event` DDL from `DIAGNOSTIC_SCHEMA_SQL` in order (table, then the newest-first index). Every statement uses `IF NOT EXISTS`. Rows are kept forever; there is no TTL and no `DELETE`.
- **Inputs:** A `SqlClient`. Statements are executed with no interpolated identifiers.
- **Returns / side effects:** `Promise<void>`. If `execute` throws, later statements are not run. Does not store secrets.

## Function: InMemoryDiagnosticStore

- **Purpose:** Process-local diagnostic store. `append` keeps a defensive copy. `listLatest` returns newest `createdAt` first, breaks ties with `id` descending (`localeCompare`), truncates to `limit`, and returns copies so a caller cannot mutate stored `fields` or `createdAt`. Rows are kept forever (no TTL, no DELETE).
- **Inputs:** `append` takes a `DiagnosticEvent`. `listLatest` takes a numeric limit. No constructor arguments.
- **Returns / side effects:** Promises of void and of copied rows. Fields stay allowlisted scalars. Secrets are not stored (no PRF bytes, mnemonic, session token, view key, nsec, Authorization, Cookie, WebAuthn challenge, attestation, signatures, or request bodies).

## Function: PostgresDiagnosticStore

- **Purpose:** Postgres-backed `diagnostic_event` store. `append` inserts id, createdAt, source, event, and `JSON.stringify(fields)` as jsonb. `listLatest` reads newest-first up to `limit`, keeps only source `server` or `client`, parses JSON fields, and drops non-scalar values. Rows are kept forever (no TTL, no DELETE).
- **Inputs:** Constructor takes a `SqlClient`. `append` takes a `DiagnosticEvent`. `listLatest` takes a limit.
- **Returns / side effects:** Query and execute failures propagate. Unparseable, null, or array `fields` become `{}`. Secrets are not stored.

## Function: serializeDebugDiagnostic

- **Purpose:** Shape one stored diagnostic row for `GET /debug/diagnostics`. `createdAt` is that date's `toISOString()`. `fields` is a shallow copy of allowlisted scalars so the caller cannot mutate the stored row. Rows themselves are kept forever.
- **Inputs:** A `DiagnosticEvent` with id, createdAt, source, event, and fields.
- **Returns / side effects:** A plain object. No I/O. Does not add secret fields (no PRF bytes, mnemonic, session token, view key, nsec, Authorization, Cookie, WebAuthn challenge, attestation, or signatures).

## Function: resolveRequestAuth

- **Purpose:** Classify Authorization as `debug`, `spend`, `session`, or `none`. Debug and spend use the constant-time debug-token compare. Session goes through `resolveSession`. Never returns the token.
- **Inputs:** Header, `AuthStore`, `now`, optional debug and spend tokens.
- **Returns / side effects:** `{ accountId, authKind }`.
- **Used by:** `requestLog`.

## Function: debugDbRoutes

- **Purpose:** Hono app for `GET /debug/db`.
- **Inputs:** Optional `DebugDbStore`, optional `debugToken`, and optional `debugReadToken` (`debugReadToken?: string`; `undefined` is left unset).
- **Returns / side effects:** 503 `{ error: 'Debug is not configured' }` only when both tokens are empty after trim; 401 `{ error: 'Unauthorized' }` when the bearer matches no configured token. Write and read both continue into the existing handler: 400 if `cursor` has no `table`; 503 if the store is omitted; 200 `{ tables }` or one page; 404 for an unknown table; 400 on `DebugDbCursorError`; 503 `Database is unavailable` on any other throw. Omits `nextCursor` when it is null.
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

- **Purpose:** Hono app for `GET /debug/api-log` (`listPage`, `hasMore`).
- **Inputs:** `ApiLogStore` and optional `debugToken`.
- **Returns / side effects:** 503 if token blank; 401 if bearer mismatches; 400 `Invalid account` / `Invalid cursor`; 200 `{ logs, hasMore }` via `listPage` (page cap 200); 503 `Log is unavailable` on store throw.
- **Used by:** `createApp` at `/debug/api-log`.

## Function: diagnosticsRoutes

- **Purpose:** Public `POST /` ingest mounted at `/diagnostics`. No auth. Only allowlisted scalar keys are stored on a `client` row, then the response is 204 with an empty body. The per-IP cap (60) and the global cap (600) per 60_000 ms are reserved before the insert await, so two overlapping requests cannot share one slot, and released if that insert throws. Expired per-IP buckets are dropped on the first request of a new minute, so a one-off address does not stay for the process lifetime. Rows are kept forever (no TTL, no DELETE). Secrets and raw bodies are not stored.
- **Inputs:** `{ store: DiagnosticStore, now?: () => number }`. Optional `cf-connecting-ip` is the per-IP key only when it matches a short IP token; any other value is ignored for the cap. Validated `clientIp`, `clientCountry`, `cfRay`, `userAgent`, `acceptLanguage`, and `origin` from `readClientRequestMeta` are stored when present. `User-Agent` and `Accept-Language` have controls stripped, are truncated to 200, and are omitted when nothing remains. A body key named `clientIp` is rejected.
- **Returns / side effects:** 204 empty on accept; 400 `{ error: 'Invalid diagnostics' }` when JSON or a field fails the allowlist; 429 `{ error: 'Too many diagnostics' }` over the cap, without recording an accept timestamp (at most one `diagnostics.rate_limited` server row per window, and only after that append resolves); 500 `{ error: 'Log is unavailable' }` when the client-row insert throws. No PRF bytes, mnemonic, session token, view key, nsec, Authorization, Cookie, WebAuthn challenge, attestation, signatures, or raw body are stored.

## Function: debugDiagnosticsRoutes

- **Purpose:** Operator `GET /` mounted at `/debug/diagnostics`. Bearer `DEBUG_TOKEN`, not an end-user session. Returns `{ logs }` through `serializeDebugDiagnostic` with ISO-8601 `createdAt`, newest-first, capped by the store. Rows are kept forever (no TTL, no DELETE). Fields are allowlisted scalars. Secrets are not stored.
- **Inputs:** `{ store: DiagnosticStore, debugToken: string | undefined }`.
- **Returns / side effects:** 503 `{ error: 'Debug is not configured' }` when the token is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 200 `{ logs }` on success; 503 `{ error: 'Log is unavailable' }` when `listLatest` throws. No PRF bytes, mnemonic, session token, view key, nsec, Authorization, Cookie, WebAuthn challenge, attestation, signatures, or request bodies are stored.

## Function: requestLogPath

- **Purpose:** Redact the first `/view/<segment>` to `/view/:viewKey` so request logs never print the durable capability secret. Trailing slashes and extra segments keep the suffix. `/view` alone and unrelated routes are unchanged.
- **Inputs:** Path string without the query string.
- **Returns / side effects:** Redacted or original string. No I/O.
- **Used by:** `requestLog`.

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
- **Used by:** `lightningAddressRoutes`, `requestGiftInvoice`, `requestZapInvoice`, `indexOpenZapReceipts` (provider-pubkey check via `resolveProviderPubkey`), `payRoutes`, `posRoutes`.

## Function: callLnurlServer

- **Purpose:** One HTTP call to the self-hosted LNURL server. Builds `${baseUrl}/${segments.join('/')}${search ?? ''}` with a fixed `Host` from config (`PUBLIC_BASE_URL` host) and no percent-encoding. Forwards only `content-type`, `x-breez-signature`, and `x-breez-timestamp` from inbound headers. A segment is forwarded only when it matches `/^[A-Za-z0-9._~-]+$/` and is neither `.` nor `..`; anything else refuses without a fetch. Timeouts use `AbortSignal.timeout`. Never logs the URL, query string, header values, or body.
- **Inputs:** `LnurlServerConfig`, injected `fetchImpl`, and `LnurlServerCall` (`method`, `segments`, optional `search` / `headers` / `body`, `timeoutMs`).
- **Returns / side effects:** `{ ok: true, status, body, headers }` with only upstream `content-type` / `cache-control` kept; `{ ok: false, reason: 'segment' }` when a path segment is refused; `{ ok: false, reason: 'unreachable' }` on network/timeout/redirect/`text()` failure.
- **Used by:** `lnurlServerRoutes`, wallet-backed `GET /.well-known/lnurlp/:username`, `forwardRecoveryLookup` (social recovery begin).

## Function: walletPayRequest

- **Purpose:** Validate an upstream LNURL-pay document for the wallet-backed well-known route. Accepts only a non-null non-array object with `tag === 'payRequest'`, `callback === expectedCallback`, string `metadata`, and safe-integer `minSendable` / `maxSendable` with `1 <= minSendable <= maxSendable`.
- **Inputs:** `body: unknown`, `expectedCallback: string`.
- **Returns / side effects:** The same object when valid, otherwise `null`. No I/O.
- **Used by:** Wallet-backed branch of `wellKnownRoutes`.

## Function: readLookupAnswer

- **Purpose:** Reads what the LNURL server's answer to a signed lookup (`POST lnurlpay/<key>/recover`) proves for social recovery. Only two answers come after a verified signature: 200 with a JSON object whose string `username` normalizes (`normalizeUsername`), which is `{ kind: 'holds', username }` with the normalized name, and 404 whose body is the JSON string `"user not found"`, which is `{ kind: 'not_found' }`. Everything else is `{ kind: 'unverified' }`: an unreachable server or refused segment, a 404 with any other body (the empty body of an unserved domain, a plain-text 404), 400 for a bad or stale signature, 5xx, another 2xx status, bad JSON, or a 200 without a valid `username`.
- **Inputs:** `LnurlServerResult` from `callLnurlServer`.
- **Returns / side effects:** `LookupAnswer`. No I/O, no log.
- **Used by:** `forwardRecoveryLookup` (begin), `settleAfterLookup` (the recover route).

## Function: recoveryMessage

- **Purpose:** Builds the five-line recovery message the old wallet signs to finish a social recovery (docs/social-recovery.md, The recovery message): `21gifts-account-recovery-v1`, the account id, the ceremony's WebAuthn challenge as issued, the new passkey's credential id, and the new wallet's identity key, joined by LF with no trailing LF.
- **Inputs:** `{ accountId, challenge, credentialId, newSparkPubkey }`.
- **Returns / side effects:** The message string. No I/O.
- **Used by:** `finishPasskeyRecovery`, with the credential id `verifyRegistration` returned (never the browser's `credential.id`).

## Function: verifyRecoverySignature

- **Purpose:** Verifies the old wallet's signature over the recovery message: compact low-S ECDSA on secp256k1 over one SHA-256 of the UTF-8 message, as Breez SDK 0.26.0 `signMessage({ compact: true })` makes it (`@noble/curves` 2.0.1, `prehash: true`, `lowS: true`, `format: 'compact'`). The tests pin one message, key and signature made by that SDK and refuse its high-S twin.
- **Inputs:** `message`, `pubkeyHex` (66 lowercase hex, `02`/`03`), `signatureHex` (128 lowercase hex `r || s`).
- **Returns / side effects:** `true` only for a valid low-S signature by that key. `false`, without a throw, for a malformed key or signature (uppercase, wrong length), a point off the curve, another key, or a high S. No I/O.
- **Used by:** `finishPasskeyRecovery`.

## Function: lnurlTransferFromMessage

- **Purpose:** Rebuilds the Breez SDK's `breez-lnurl:v2` `transfer-from` message, which the current owner of a Lightning address signs to hand the name over: version, `transfer-from`, domain, username, from key, to key, and the timestamp in decimal seconds, joined by LF. Matches the SDK golden vector byte for byte.
- **Inputs:** `domain`, normalized `username`, `fromPubkey`, `toPubkey`, `timestamp` (Unix seconds).
- **Returns / side effects:** The message string. No I/O.
- **Used by:** `POST /lnurlpay/:pubkey/transfer` (`lnurlServerRoutes`), which checks the old wallet's signature before it admits a claim.

## Function: lnurlTransferToMessage

- **Purpose:** Rebuilds the Breez SDK's `breez-lnurl:v2` `transfer-to` message, which the new owner signs to take the name over: as `lnurlTransferFromMessage` with role `transfer-to` and the lowercase SHA-256 hex of the exact description bytes before the timestamp. Matches the SDK golden vector byte for byte.
- **Inputs:** `domain`, normalized `username`, `fromPubkey`, `toPubkey`, `description`, `timestamp` (Unix seconds).
- **Returns / side effects:** The message string. No I/O.
- **Used by:** `POST /lnurlpay/:pubkey/transfer` (`lnurlServerRoutes`), for the new wallet's signature.

## Function: verifyLnurlDerSignature

- **Purpose:** The LNURL server's own signature check, run by the api before it forwards an address transfer: DER low-S ECDSA on secp256k1 over one SHA-256 of the UTF-8 message (`@noble/curves` 2.0.1, `format: 'der'`).
- **Inputs:** `message`, `pubkeyHex` (66 lowercase hex), `derHex` (lowercase hex, 16 to 144 characters, even length).
- **Returns / side effects:** `true` only for a valid low-S signature by that key. `false`, without a throw, for a malformed key, bad or odd-length hex, bytes that are not DER, another key, or a high S. No I/O.
- **Used by:** `POST /lnurlpay/:pubkey/transfer` (`lnurlServerRoutes`).

## Function: forwardRecoveryLookup

- **Purpose:** Forwards the old wallet's signed lookup of a social recovery begin to the LNURL server and reads the answer. Sends `POST lnurlpay/<key>/recover` with the JSON body `{ signature, timestamp }`, `content-type: application/json`, the fixed `Host` and the `LNURL_SERVER_TIMEOUT_MS` timeout (`callLnurlServer`). An unreachable server logs `lnurl_server.unreachable` with `route: 'recovery'`; a refused segment logs nothing. Never logs the key, signature, or timestamp.
- **Inputs:** `LnurlServerConfig`, `fetchImpl`, clock `now`, normalized old key, `{ signature, timestamp }`.
- **Returns / side effects:** `{ sentAt, answer }`: `sentAt` is read from the clock once, before the call, and `answer` is `readLookupAnswer` of the result.
- **Used by:** `startPasskeyRecovery`.

## Function: settleDecision

- **Purpose:** Decides what a signed lookup means for a pending social recovery (docs/social-recovery.md, rule 5). Keeps an unforwarded recovery, and a forwarded one unless the lookup was sent more than `RECOVERY_SETTLE_AFTER_MS` (twice `LNURL_SERVER_TIMEOUT_MS`, 30 s) after `forwardedAt`; exactly at the boundary still keeps. After the window: the new key holding the account's username (both normalized) commits; a verified `not_found` for the old key commits; the old key holding the username drops; anything else keeps.
- **Inputs:** `PendingRecovery`, `{ role: 'old' | 'new', sentAt, answer }`, the account's username (`null` or `undefined` never matches).
- **Returns / side effects:** `'commit'`, `'drop'`, or `'keep'`. Pure.
- **Used by:** `startPasskeyRecovery` (begin settles a forwarded recovery with the old key's lookup), `settleAfterLookup`.

## Function: settleAfterLookup

- **Purpose:** Settles a forwarded pending social recovery after the recover route forwarded a lookup. With `pendingNew` the lookup was of that recovery's new key (`role: 'new'`). Otherwise it was of `pubkey` as an account's verified key, and only that account's pending recovery whose old key is `pubkey` is considered (`role: 'old'`). Runs `settleDecision` with the account's username; `commit` runs `commitRecovery` and logs `account.recovery.committed` with `via: 'lookup'` when it committed, `drop` runs `dropPendingRecovery` and logs `account.recovery.dropped` with `via: 'lookup'` when it dropped.
- **Inputs:** `{ auth, now }`, `{ pubkey, pendingNew, sentAt, result }` (`result` is the upstream `LnurlServerResult`).
- **Returns / side effects:** Resolves; never throws. A store failure logs `account.recovery.settle_failed` with `errorLogFields` only. Never logs a key, a signature, or a body. The answer to the wallet is not changed.
- **Used by:** `POST /lnurlpay/:pubkey/recover` (`lnurlServerRoutes`).

## Function: receivingAddress

- **Purpose:** The one place that decides where an account receives in-app payments. A member receives only on their in-app wallet: with the LNURL server configured and a verified wallet (`sparkPubkeyVerifiedAt` a number, `sparkPubkey` and `username` set), the address is the wallet-backed `<username>@<host of PUBLIC_BASE_URL>`. Without a verified wallet, or with the LNURL server off, the account cannot receive (`null`). It never reads the stored external `lightning_address` column; only the legacy boot repair `repairGiftKind` still matches old gift rows by it.
- **Inputs:** Account fields `username`, `sparkPubkey`, `sparkPubkeyVerifiedAt`, and the `LnurlServerConfig` or `undefined` when that feature is off.
- **Returns / side effects:** `{ address, sparkPubkey }` or `null`. No I/O.
- **Used by:** `POST /messages/:id/invoice` (forum gift and the compose-target posting fee), `POST /conversations/:id/invoice`, `POST /messages/:id/repayment` and `POST /messages/:id/repayment/due`, `canReceive` on `GET /messages/:id/repayment`, `GET /me/loans`, `GET /pay/:username`, `POST /pay/:username/invoice`, `POST /pos`, the `payable` and `authorCanReceive` flags on forum and member feeds (through `messagePay`), `canReceive` on `GET /conversations` and on `GET /habits` comments, owner/public/debug account JSON `lightningAddress`, spend pings, the zap receipt ingest (provider pubkey of the recipient), the Nostr worker for the account kind:0 `lud16`, `payUsername` on `GET /shops/:npub` (with `lnurlServer` from `shopRoutes`), and the shop kind 0 `lud16` in the Nostr worker (S2).

## Function: accountByReceivingAddress

- **Purpose:** Spend-worker lookup of the member behind a receiving address. The address must be `<username>@<host of PUBLIC_BASE_URL>` (trimmed, case-insensitive). The username is looked up and the account must resolve to that same address through `receivingAddress`, so a member without a verified wallet is not found.
- **Inputs:** An auth store with `getAccountByUsername`, the address as sent, and the `LnurlServerConfig` or `undefined`.
- **Returns / side effects:** `{ account, receiving }`, or `undefined` for another domain, a blank local part, an unknown username, no verified wallet, or the LNURL server off. Reads the auth store only.
- **Used by:** `POST /invoices`, `GET /invoices/eligible`, `GET /invoices/passkey`, `GET /invoices/posted`, and the moderator-group gift recipient name on `POST /invoices/proof`.

## Function: lnurlServerFetch

- **Purpose:** Keeps LNURL traffic for wallet-backed addresses inside the deployment. A request whose URL host equals the host of `PUBLIC_BASE_URL` (the LUD-16 document of `<username>@<host>` and its pay callback) is sent as a `GET` to the LNURL server through `callLnurlServer` (path segments and query kept, fixed `Host`, 15 s timeout) instead of over the public URL. Any other host goes to the wrapped fetch unchanged. A LUD-16 document request for a username without a verified wallet also goes to the wrapped fetch, like the public `GET /.well-known/lnurlp/:username`, which answers it with 404.
- **Inputs:** `LnurlServerConfig` or `undefined`, the fetch to wrap, a username lookup (`getAccountByUsername`), and an optional `{ deadlineMs, now }`: each LNURL server call then gets the time left until `deadlineMs` instead of the 15 s default, and a call at or after it rejects without a request.
- **Returns / side effects:** A `FetchFn`. With `undefined` config it is the wrapped fetch itself. A refused path segment or an unreachable LNURL server rejects like a failed `fetch`, which the LNURL helpers already map to `unreachable`.
- **Used by:** The same routes as `receivingAddress`, the receipt ingest provider lookup, and the shop payment mint (with the deadline).

## Function: resolveFreePaymentsConfig

- **Purpose:** Resolve the configuration of free in-app payments between members. `LNURL_ZAP_NSEC_HEX` must be 64 hex characters (any case); it is the server secret the per-member zap receipt keys are derived from. `SPARK_OPERATOR_URL` is the Spark coordinator base URL; unset or blank uses `https://0.spark.lightspark.com`, and a trailing slash is removed.
- **Inputs:** Environment slice.
- **Returns / side effects:** `{ zapNsec, operatorUrl }`, or `null` (feature off) when the secret is unset, blank, or malformed, or the operator URL is not `http:` / `https:`. No I/O. The feature additionally needs `resolveLnurlServerConfig`.
- **Used by:** `createApp` (whether invoice routes issue Spark invoices) and the entry point (whether the Spark invoice worker runs).

## Function: concatBytes

- **Purpose:** Join byte arrays in order into one new array. Small helper for the hand-written protobuf and gRPC-web framing.
- **Inputs:** Any number of `Uint8Array` parts.
- **Returns / side effects:** A new `Uint8Array` with every part copied in order. No I/O.
- **Used by:** `protoVarintField`, `protoBytesField`, `encodeSparkInvoice`, `encodeQuerySparkInvoicesRequest`.

## Function: protoVarintField

- **Purpose:** Encode one protobuf varint field (wire type 0): tag `field << 3`, then the value as a little-endian base-128 varint. Covers `uint32`, `uint64`, non-negative `int64`, and enums.
- **Inputs:** Field number and a non-negative integer (`number` that is a safe integer, or `bigint` up to 2^64 - 1).
- **Returns / side effects:** Tag and value bytes. Throws `RangeError` for a negative, fractional, unsafe, or too large value. No I/O.
- **Used by:** `encodeSparkInvoice`, `encodeQuerySparkInvoicesRequest`.

## Function: protoBytesField

- **Purpose:** Encode one length-delimited protobuf field (wire type 2): tag, varint length, then the bytes. Strings are written as UTF-8; embedded messages are passed as their serialised bytes.
- **Inputs:** Field number and a `Uint8Array` or string.
- **Returns / side effects:** Tag, length, and value bytes. No I/O.
- **Used by:** `encodeSparkInvoice`, `encodeQuerySparkInvoicesRequest`, `encodeSparkAddress`.

## Function: decodeProto

- **Purpose:** Decode the top-level fields of a protobuf message in wire order. Varint fields come back as `bigint`, length-delimited fields as raw bytes (the caller decodes strings and embedded messages). Fixed 64-bit and 32-bit fields are skipped.
- **Inputs:** Serialised message bytes.
- **Returns / side effects:** `ProtoField[]`. Throws on a truncated varint or field, a varint longer than 64 bits, field number 0, or wire types 3, 4, 6, 7. No I/O.
- **Used by:** `parseQuerySparkInvoicesResponse` and `decodeSparkAddress` (which `walletPaymentClassifier` calls for `POST /me/wallet/report` on the default boot).

## Function: encodeSparkInvoice

- **Purpose:** Serialise a Spark invoice: protobuf `SparkAddress { 1: identity_public_key (33 bytes), 2: spark_invoice_fields }` with no signature field, where `SparkInvoiceFields` is written in the canonical order `1: version = 1`, `2: id (16 bytes)`, `5: memo` (left out when `memo` is omitted), `4: SatsPayment { 1: amount }` (not field-number order), then bech32m with prefix `spark` and no length limit.
- **Inputs:** `{ identityPublicKey (66 hex), id (16 bytes), memo?, amountSats }`.
- **Returns / side effects:** The `spark1…` string. Throws when the key is not 33 bytes or the id not 16 bytes, and `RangeError` when `amountSats` is negative or not a safe integer. No I/O.
- **Used by:** `issueSparkInvoice`, `payRoutes`.

## Function: uuidV7

- **Purpose:** Build an RFC 9562 UUIDv7 as 16 bytes: 48-bit Unix milliseconds big-endian, version nibble 7, variant bits `10`, and the remaining bits from the given random bytes. Used as the Spark invoice id.
- **Inputs:** Clock in epoch milliseconds and 10 random bytes.
- **Returns / side effects:** 16 bytes. Throws `RangeError` when `nowMs` is not an integer. No I/O.
- **Used by:** `issueSparkInvoice`, `payRoutes`.

## Function: issueSparkInvoice

- **Purpose:** Issue the Spark invoice that stands next to a member-to-member zap invoice: same amount, addressed to the recipient's verified wallet key, memo `zap:<payment hash of pr>`. Stores it with the zap invoice and the exact zap request string so the worker can later build the receipt. One payment hash has one Spark invoice; asking again returns the stored string and, while it is open, restarts its watch window.
- **Inputs:** `{ sparkInvoices?, now, randomBytes? }`, the recipient's `ReceivingAddress`, and `{ pr, paymentHash, prAmountMsat, amountSats, zapRequestJson }` (`paymentHash` and `prAmountMsat` decoded from `pr`, `null` when it does not decode).
- **Returns / side effects:** `spark1…` string, or `null` when the feature is off (`sparkInvoices` omitted) or the payment hash is unknown, or `pr` is not for exactly `amountSats` (the receipt credits the amount of `pr`). A store failure logs `spark.invoice.issue_failed` and resolves `null`, so the route still returns `pr` for a gift; a heart on `POST /messages/:id/invoice` is refused with 503 `HEART_UNAVAILABLE` instead.
- **Used by:** `POST /messages/:id/invoice`, `POST /conversations/:id/invoice`, `POST /messages/:id/repayment` and `POST /messages/:id/repayment/due`.

## Function: migrateSparkInvoiceSchema

- **Purpose:** Apply the idempotent DDL for `spark_invoice` (`docs/schema/spark_invoice.sql`): one row per zap invoice payment hash with the Spark invoice, receiver key, amount, zap BOLT11, zap request string, `created_at`, `status` (`open` / `settled`), transfer id, and receipt event id, plus a partial index on open rows by `created_at`.
- **Inputs:** A `SqlClient`.
- **Returns / side effects:** Resolves when the statements have run. Runs before `migrateDbChangeSchema` so `trg_db_change` attaches.
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: InMemorySparkInvoiceStore

- **Purpose:** Process-local `SparkInvoiceStore` for tests and memory boots. `issue` keeps the first invoice per payment hash and moves an open row's `createdAt` forward when it is handed out again; `listOpen` returns open rows issued at or after a time, oldest first; `markSettled` flips an open row once.
- **Inputs:** None.
- **Returns / side effects:** The store port; mutates a private map and returns copies.
- **Used by:** `createApp` default when free in-app payments are on, the entry point on memory boots, and unit tests.

## Function: PostgresSparkInvoiceStore

- **Purpose:** `SparkInvoiceStore` against `spark_invoice`. `issue` inserts with `ON CONFLICT (payment_hash)` that only moves an open row's `created_at` forward and then reads the stored invoice string back; `listOpen` selects open rows in the window ordered by `created_at`; `markSettled` is one conditional `UPDATE … WHERE status = 'open'`, so two ticks cannot settle the same row twice.
- **Inputs:** A migrated `SqlClient`.
- **Returns / side effects:** Same port as the in-memory store, persisted in Postgres. Every write is logged in `db_change` by the table trigger.
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: encodeQuerySparkInvoicesRequest

- **Purpose:** Build the gRPC-web request body for `spark.SparkService/query_spark_invoices`: `QuerySparkInvoicesRequest { 1: int64 limit = 100, 3: repeated string invoice }` wrapped in one data frame (flags byte 0, 4-byte big-endian length, message).
- **Inputs:** Up to 100 Spark invoice strings.
- **Returns / side effects:** Framed request bytes. No I/O.
- **Used by:** `querySparkInvoices`.

## Function: parseQuerySparkInvoicesResponse

- **Purpose:** Parse a gRPC-web `QuerySparkInvoicesResponse { 2: repeated InvoiceResponse { 1: invoice, 2: status, 3: SatsTransfer { 1: transfer_id } } }`. Status `0` (omitted on the wire) is `not_found`, `1` `pending`, `2` `finalized`, `4` `returned`, `5`/`6`/`7` `mismatched`, anything else `unknown`. `grpc-status` comes from the response header (trailers-only) or the trailer frame (flag `0x80`).
- **Inputs:** Response body bytes and the `grpc-status` header or `null`.
- **Returns / side effects:** `{ ok: true, invoices }` with transfer ids as lower-case hex; `{ ok: false, reason: 'grpc', grpcStatus }` for a status other than `0` (`-1` when not numeric); `{ ok: false, reason: 'malformed' }` for a missing status, a compressed or truncated frame, or undecodable protobuf. No I/O.
- **Used by:** `querySparkInvoices`.

## Function: querySparkInvoices

- **Purpose:** Ask the Spark coordinator for the status of up to 100 invoices: `POST <operatorUrl>/spark.SparkService/query_spark_invoices` (the RPC path appended to the URL path, a query kept, a fragment dropped) with `content-type: application/grpc-web+proto` and `x-grpc-web: 1`, no authentication, no redirects, 10 s timeout. Never logs an invoice.
- **Inputs:** Operator base URL, injected fetch, invoice strings.
- **Returns / side effects:** The parsed result, `{ ok: false, reason: 'unreachable' }` when the fetch or body read fails, or `{ ok: false, reason: 'http' }` for an HTTP status other than 200.
- **Used by:** `runSparkInvoiceTick`.

## Function: zapReceiptSecretKey

- **Purpose:** Derive the per-member key that signs zap receipts: HMAC-SHA256 keyed with the server secret (`LNURL_ZAP_NSEC_HEX`) over `lnurl-zap-receipt-key:` followed by the lower-case hex of the member's wallet key and one counter byte starting at 0, taking the first digest that is a valid secp256k1 secret key. Its public key is the `nostrPubkey` the LNURL server advertises for that member, so the receipt ingest accepts the receipt.
- **Inputs:** 32-byte server secret and the member's wallet identity key (66 hex).
- **Returns / side effects:** 32-byte secret key. No I/O.
- **Used by:** `runSparkInvoiceTick`.

## Function: buildZapReceipt

- **Purpose:** Build and sign the NIP-57 kind 9735 receipt for a zap invoice paid by a Spark transfer. Tags: `p` (recipient from the zap request), `P` (zap request pubkey), `e` (zapped event, when present), `bolt11` (the zap `pr`), `description` (the exact zap request string the invoice commits to). No `preimage` tag; content is empty. `created_at` is the zap request's `created_at`, so the same zap invoice and signing key always give the same receipt id.
- **Inputs:** `{ secretKey, bolt11, zapRequestJson }`.
- **Returns / side effects:** `{ event, relays }` with the deduplicated relays named in the zap request's `relays` tag, or `null` when the zap request is not a kind 9734 object with a pubkey, a non-negative integer `created_at`, and a `p` tag. Throws when the secret key is not a valid secp256k1 key. No I/O.
- **Used by:** `runSparkInvoiceTick`.

## Function: runSparkInvoiceTick

- **Purpose:** One pass of the Spark invoice worker. Lists the open Spark invoices issued in the last 60 minutes, queries the coordinator in batches of up to 100, and for each invoice reported `finalized` signs the receipt for its zap invoice with the receiver's receipt key and feeds it into the receipt ingest. When the ingest credited this receipt and it holds the payment hash claim, it is published to the zap request's relays (if any) and the row is marked settled with the transfer id and receipt id; when another receipt owns the payment hash (`claims.zapPaymentReceiptId`), the row is settled without publishing. Otherwise (for example the LNURL server was briefly unreachable, or crediting failed after the claim) it logs `spark.receipt.not_credited` and leaves the row open; the next tick ingests the same receipt id again, so a claim it already holds lets the retry complete the credit. `not_found`, `pending`, `returned`, `mismatched`, and unknown statuses leave the row open.
- **Inputs:** `SparkWorkerDeps` (`store`, `config`, `fetchImpl`, `publisher`, `ingest`, `claims`, `now`).
- **Returns / side effects:** Resolves when every batch is handled. A failed batch logs `spark.query.failed` (`reason`, `grpcStatus`) and the next batch runs; a publish that no relay accepts (or that throws) logs `spark.receipt.publish_failed` and the row is still settled, since the credit is done; an unusable stored zap request logs `spark.receipt.invalid`; a settled row logs `spark.invoice.settled`. A second receipt for the same payment hash is a no-op in the ingest (payment hash claimed once).
- **Used by:** `startSparkInvoiceWorker`.

## Function: startSparkInvoiceWorker

- **Purpose:** Run `runSparkInvoiceTick` once immediately and then every 2 s. A tick does not start while the previous one is still running, so a slow coordinator cannot stack requests.
- **Inputs:** `SparkWorkerDeps` and an optional interval in milliseconds.
- **Returns / side effects:** `{ stop }`, which clears the interval. A rejecting tick logs `spark.worker.tick.failed` with the error fields.
- **Used by:** The entry point when `resolveLnurlServerConfig` and `resolveFreePaymentsConfig` both resolve (`LNURL_SERVER_URL`, `PUBLIC_BASE_URL`, `LNURL_ZAP_NSEC_HEX`, and a usable or unset `SPARK_OPERATOR_URL`).

## Function: runPosPaidTick

- **Purpose:** One pass of the point-of-sale paid watcher. Lists the charges still watched (`listWatched` from `now − POS_PAID_WATCH_MS`, ten minutes: pending, or expired within that window; paid and cancelled charges are never listed). With `operatorUrl`, asks the Spark coordinator (`querySparkInvoices`, batches of up to 100) about every stored charge Spark invoice; `finalized` marks that charge paid. Then, for each charge still unpaid, calls the LNURL server's LUD-21 `GET /verify/<paymentHash>` (5 s) for each recorded BOLT11 hash in order; a 200 JSON body with `settled: true` marks the charge paid and its remaining hashes are skipped. Marking paid goes through `markPaid` with the current clock, which changes a row once only; with `shop` it goes through `ShopPayments.chargePaid` instead, which marks the charge paid and settles its shop payment in one transaction under the account row lock (the payment's own hash → `paid`; the Spark invoice or another BOLT11 → an `open` payment ends with `charge_paid`). The LUD-21 read is `verifyLightningPayment`. No zap receipt, gift, or message is written.
- **Inputs:** `PosPaidWorkerDeps` (`store`, `lnurlServer`, optional `operatorUrl`, `fetchImpl`, `now`, optional `shop`).
- **Returns / side effects:** Resolves when every watched charge is checked. A failed Spark batch logs `pos.spark.query_failed` (`reason`, `grpcStatus`) and the next batch runs. Unreachable, non-200, or unreadable verify answers are counted and logged once per tick as `pos.verify.failed` (`failures`). `markPaid` logs `pos.paid` with the account id. Store failures propagate.
- **Used by:** `startPosPaidWorker`.

## Function: startPosPaidWorker

- **Purpose:** Run `runPosPaidTick` once immediately and then on the same 2 s cadence as the Spark invoice worker (`SPARK_WORKER_INTERVAL_MS`). A tick does not start while the previous one is still running.
- **Inputs:** `PosPaidWorkerDeps` and an optional interval in milliseconds.
- **Returns / side effects:** `{ stop }`, which clears the interval and stops the shop payment tick. With `deps.shop`, also starts `startShopPaymentWorker`, a separate tick, so a slow shop call never delays a till confirmation. A rejecting tick logs `pos.worker.tick.failed` with the error fields.
- **Used by:** The entry point when `resolveLnurlServerConfig` resolves; `operatorUrl` is passed only when `resolveFreePaymentsConfig` resolves too, so Spark invoices are polled only when they are issued.

## Function: verifyLightningPayment

- **Purpose:** Ask the LNURL server whether one payment hash has settled (LUD-21 `GET /verify/<paymentHash>`), the one read the charge watch and the shop payment settlement share.
- **Inputs:** LNURL server config, fetch, payment hash (64 lowercase hex), optional timeout (default `LNURL_PAY_REQUEST_TIMEOUT_MS`, 5 s).
- **Returns / side effects:** `settled` when the 200 JSON body says `settled: true`, `open` for any other 200 JSON body, otherwise `failed`. No store writes.
- **Used by:** `runPosPaidTick` and the settlement duty of `runShopPaymentTick`.

## Function: ingestZapReceipt

- **Purpose:** Run the existing receipt ingest for one kind 9735 event, exactly as a relay pass does: signature check, recipient's receiving address and its LNURL `nostrPubkey`, conversation or forum or repayment crediting, and the "payment hash claimed once" rule, so a second receipt for the same payment hash credits nothing.
- **Inputs:** The event and the `indexOpenZapReceipts` collaborators (`eventIds` and `since` are ignored).
- **Returns / side effects:** `true` when this receipt is credited: its latest ingest decision on the store is `indexed`, or `rejected` / `duplicate` (already recorded under the same receipt id). `false` for any other rejection, or when a step threw: that logs `nostr.zap.rejected` and, for an event with a non-empty id, persists a `rejected` / `error` ingest row instead of rejecting.
- **Used by:** `queryAndIngestZapReceipts` (each queried receipt) and the Spark invoice worker through `zapReceiptIngest`.

## Function: zapReceiptIngest

- **Purpose:** Bind `ingestZapReceipt` to the Nostr worker's collaborators (forum, auth, querier, fetch, clock, stores, LNURL server, zap read relays from `env`), so the Spark invoice worker credits a receipt it signs the same way as one read from a relay, without waiting for a relay round trip.
- **Inputs:** `ZapIngestDeps` (the subset of `NostrWorkerDeps` the ingest reads; no key, no publisher).
- **Returns / side effects:** A function that ingests one event and resolves `true` when that receipt is credited. No I/O until called.
- **Used by:** The entry point when the Spark invoice worker runs.

## Function: resolveSession

- **Purpose:** Looks up a bearer session; rejects expired tokens and accounts with `sessionRefused` (`isWrongAccount`).
- **Inputs:** `store`, `now`, `token`.
- **Returns / side effects:** `Account` or `null` when unknown, expired, or refused.
- **Used by:** `meRoutes`.

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
- **Inputs:** store, ceremony, config, now, Origin, challengeId, credential, optional `nostr`, optional `admit` (`SessionAdmit`, the login switch; refusal is checked before sign count or session).
- **Returns / side effects:** `{ ok: true, value: { token, account } }` or `{ ok: false, error }`. A credential id that is no stored passkey but the new passkey of a pending social recovery (`getPendingRecoveryByCredentialId`, unexpired) is `{ ok: false, error: 'Recovery is not finished' }` (`RECOVERY_PENDING_ERROR`), so the app keeps that passkey instead of asking the authenticator to delete it as unknown. Without a pending recovery the credential is read once more, because the recovery commit stores the credential and deletes the pending row in one transaction: a commit between the two reads signs in with the new passkey. An id that is still unknown then is `Unknown credential`. CAS failure is `{ ok: false, error: 'Invalid passkey' }`. `sessionRefused`: `{ ok: false, error: 'You signed in with the wrong account. Please try again with the correct account.' }`. Optional `admit` runs after the assertion is verified and before the sign count or a session is written; `false` is `{ ok: false, error: 'Logins are paused for an update. Try again later.' }`.
- **Used by:** `POST /auth/passkey/authenticate/finish`.

## Function: finishPasskeyRegistration

- **Purpose:** Verifies an attestation and issues a session. When the challenge account id already exists (claim path), `sessionRefused` is refused before `accountHasPasskey` / `createFirstPasskeyCredential`; a concurrent refuse during that insert is the same wrong-account error and does not leave a bound credential. Otherwise binds the credential to that provisioned row without `createAccount` and never `deleteAccount` on failure, and sets `walletRequired: true` without clearing `walletBackupSeenAt`. When the account is new, creates a `linkingKey: null` account plus credential with `walletRequired: true` and `walletBackupSeenAt: null`; optional `nostr` mints a custodial nsec (rollback on keygen failure) and a duplicate credential id rolls the new account back. A string `requestedName` on the challenge is stored as account `name` and `username` after a second normalisation and uniqueness check. A stored name that no longer normalizes returns the same charset error and creates no credential and no session. A taken handle, or a named `createAccount` that inserts no row, returns `Username is already in use` with no credential and no session. Concurrent `tryCreateSession` failure is the same wrong-account error, not an uncaught throw.
- **Inputs:** store, ceremony, config, now, Origin, challengeId, credential, optional `nostr`, optional `admit` (`SessionAdmit`, the login switch; `null` for a new account; refusal is checked before any account, credential, or session write).
- **Returns / side effects:** `{ ok: true, value: { token, account } }` or `{ ok: false, error }`. Claim-path credential race → `{ ok: false, error: 'Invalid passkey' }` with the provisioned account left intact. Nostr keygen failure on claim is best-effort (same as authenticate): session still issues. `sessionRefused`: `{ ok: false, error: 'You signed in with the wrong account. Please try again with the correct account.' }` and no bearer. A string `requestedName` on the challenge is stored as account `name` and `username` after a second normalisation and uniqueness check. A stored name that no longer normalizes returns the same charset error and creates no credential and no session. A taken handle, or a named `createAccount` that inserts no row, returns `Username is already in use` with no credential and no session. Optional `admit` runs after the attestation is verified and before any account, credential, or session write (a new account is passed as `null`, a claimed profile as its account); `false` is the logins-closed error with no account, credential, or session written (the challenge is already consumed and stays single-use).
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

- **Purpose:** Trims `WEBAUTHN_RP_ID`; missing/blank/unknown is `null` (only `21.gifts` / `dev.21.gifts` / `staging.21.gifts` / `localhost`; fail closed on passkey routes).
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

- **Purpose:** Mints WebAuthn creation options and a pending account UUID (row created only on finish). A normalized `requestedName` is both `user.name` and `user.displayName` and is stored on the challenge. Without it, `user.name` is the new UUID and the display name is `21.gifts`.
- **Inputs:** store, ceremony, config, now, optional `requestedName`.
- **Returns / side effects:** `{ challengeId, options }`; persists a passkey challenge.
- **Used by:** `POST /auth/passkey/register/begin` when the body has no string `viewKey`.

## Function: startPasskeyClaim

- **Purpose:** Mints WebAuthn creation options for an existing operator-provisioned account identified by `viewKey`. Uses the stored account id and `account.name` (or `21.gifts` when null) as the WebAuthn user entity.
- **Inputs:** store, ceremony, config, now, viewKey, optional `admit` (`SessionAdmit`, the login switch; refusal is checked after the 404/409 checks and before the challenge is written).
- **Returns / side effects:** `{ ok: true, value: { challengeId, options } }` or `{ ok: false, error }` (`This profile could not be found.` / `This profile already has a passkey`). Persists a register challenge bound to the existing account id. Optional `admit` runs after the 404/409 checks and before a challenge is stored; `false` is the logins-closed error.
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

## Function: startPasskeyRecovery

- **Purpose:** Starts a social recovery ceremony for the account whose verified wallet key is the old key, after the LNURL server verified that wallet's signed lookup (docs/social-recovery.md, rules 1 to 3 and 5). Issues creation options as for a seed passkey (user id and user name the account id, display name `account.name ?? '21.gifts'`, no `excludeCredentials`), so the new passkey replaces an earlier one of this account in the authenticator.
- **Inputs:** deps `{ store, ceremony, config, lnurlServer, fetchImpl, now, admit? }` (`now` is a clock); input `{ sparkPubkey, lookup: { signature, timestamp } }` with a normalized key.
- **Returns / side effects:** `RecoveryBeginResult`: `{ ok: true, challengeId, options, accountId, username }` or `{ ok: false, reason }`. No account on the key: a previous wallet's key is `done` once its lookup is verified (`unavailable` otherwise), any other key `not_found` without an upstream call. A session-refused account is `wrong_account` and a refusal of `admit` `logins_closed`, both before the lookup. A forwarded pending recovery is settled first with `settleDecision`: `commit` runs `commitRecovery` and answers `done` (log `account.recovery.committed`, `via: 'begin'`), or `unavailable` when it did not commit; `drop` runs `dropPendingRecovery` (log `account.recovery.dropped`, `via: 'begin'`) and goes on; `keep` is `unavailable`. Then an unverified lookup is `unavailable`, and a key that no longer holds the account's username (verified `not_found`, another name, or no username) is `operator` (log `auth.passkey.recovery.fail` with `stage: 'begin'`, `accountId`, `error: 'operator'`), unless a commit (the transfer's claim or a settling lookup) landed while the lookup ran: when `getAccountByVerifiedSparkPubkey` no longer finds an account on the key and `getPreviousWalletBySparkPubkey` does find it, the answer is `done`. Otherwise `startRecoveryChallenge` stores the `recovery` challenge in one locked step, which consumes earlier ones and drops an unforwarded pending recovery; `forwarded` or `changed` from it is `unavailable`. Success logs `auth.passkey.recovery.begin` with `accountId` and `challengeId`. Never logs the key or the lookup. A store failure throws.
- **Used by:** `POST /auth/passkey/recovery/begin`.

## Function: finishPasskeyRecovery

- **Purpose:** Finishes a social recovery ceremony: verifies the new passkey and the old wallet's signature over the recovery message, then stores a pending recovery. Mints no session and changes nothing on the account; the commit comes with the address transfer.
- **Inputs:** deps `{ store, ceremony, config, now, admit? }` (`now` is a clock, read once); input `{ origin, challengeId, credential, newSparkPubkey, signature: { pubkey, signature } }` with normalized keys.
- **Returns / side effects:** `{ ok: true, accountId }` or `{ ok: false, error, accountId? }` (the account id once the challenge's account is known). Checks in order: `Invalid origin`; a `recovery` challenge inside `CHALLENGE_TTL_MS` (`Unknown or expired challenge`, `Challenge expired`, `Wrong challenge type`; a consumed challenge is allowed here so the store can recognize a repeat); the challenge's account exists (`Unknown or expired challenge`), is not session-refused (wrong-account error) and passes `admit` (logins-closed error); `signature.pubkey` is the account's verified wallet key (`Invalid recovery signature`); the new key differs from it (`Wallet key is already in use`); `verifyRegistration` (`Invalid passkey`); `verifyRecoverySignature` over `recoveryMessage` with the credential id `verifyRegistration` returned (`Invalid recovery signature`). Then `storePendingRecovery` consumes the challenge and stores the row in one locked step: `stored` is ok and logs `auth.passkey.recovery.finish` with `accountId`; `same` (a repeat of the finish that stored it, with the same challenge, credential id and new key) is ok again with no write; `challenge` is `Challenge already used`; `changed` is `Invalid recovery signature`; `pending` is `A recovery is already pending`; `key` is `Wallet key is already in use`; `credential` is `Invalid passkey`. A store failure, including an unmapped unique violation, throws.
- **Used by:** `POST /auth/passkey/recovery/finish`.

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

- **Purpose:** Next owner wizard step from stored account fields. Order is name → username (not skippable) → lightning-address → rules. The recovery phrase is not a setup step and does not change `setup` or `missing`. Wallet backup is not a setup step. Skip timestamps count as done for name and the receiving-wallet step (`lightning-address`) only. The api is the source of truth; clients only route.
- **Inputs:** `Account`.
- **Returns / side effects:** `'name'` when name is null/blank and `nameSkippedAt` is unset, else `'username'` when username is null/undefined/blank (cannot skip), else `'lightning-address'` when the wallet is not verified (`sparkPubkeyVerifiedAt` not a number) and `lightningAddressSkippedAt` is unset, else `'rules'` when `rulesAgreedAt` is null, else `null`. Never `'wallet'`. No I/O.
- **Used by:** `serializeOwnerAccount`.

## Function: accountMissing

- **Purpose:** Factually unset account fields for action gates. Skip timestamps do not clear a field from this list. Only a verified wallet (`sparkPubkeyVerifiedAt` a number) clears `lightning-address`, the same rule `accountSetup` uses for that step, so a member without one cannot post.
- **Inputs:** `Account`.
- **Returns / side effects:** `AccountMissingField[]` in order `name`, `username`, `lightning-address`, `rules` (name/username null or blank, `lightning-address` while `sparkPubkeyVerifiedAt` is not a number, rules unset). Never includes `wallet`. Skip timestamps still do not clear name/username/lightning-address/rules. No I/O.
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

- **Purpose:** Ensure a named account with a verified wallet (`sparkPubkeyVerifiedAt` set) has exactly one live top-level profile forum note. No-ops when the name is null/blank after trim, or when there is no verified wallet. When both are set, the first insert creates one message (kind:1 pipeline defaults, frozen tags only) and claims `profileMessageId` via `claimProfileMessageId` (set only while the pointer still matches the missing/hidden read). Rename is idempotent and does not change note text. Recreates when the stored id is missing or the row is soft-hidden (`deletedAt` set). A live `profileMessageId` winner is adopted and the insert is deleted; a hidden winner is missing — the created live note is kept and `profileMessageId` is claimed onto it. A lost claim deletes the insert and adopts a live winner when one exists. Rolls back the insert if the claim throws. A successful won claim whose confirmation still points at the created note does not call `notifyForumPost` (the note text is the display name, not a living-room post).
- **Inputs:** `{ auth, messages, account, now, pushStore?, notifications?, conversations? }`.
- **Returns / side effects:** The account (possibly with `profileMessageId` set). May insert a message and claim the pointer; may delete an orphaned insert on claim failure, a vanished row, or a later live `profileMessageId` winner.
- **Used by:** `meRoutes` (`POST /me/name`), `messagesRoutes` (`GET /compose-target`), `debugRoutes` provision, Nostr worker backfill.

## Function: serializeAccount

- **Purpose:** Project an account to the eleven-field dump without `viewKey` or `isPlatform` (no Nostr fields).
  `lightningAddress` is the receiving address (the verified in-app wallet `<username>@<host of PUBLIC_BASE_URL>` from `receivingAddress`, or `null`) and `lightningAddressVerified` is true iff it is set; the stored external address is never read.
- **Inputs:** `Account` and optional `lnurlServer` (`LnurlServerConfig`).
- **Returns / side effects:** Eleven public fields (`id`, `linkingKey`, `role`, `name`, `username`, `location`, `lightningAddress`, `lightningAddressVerified`, `forumLawsDismissed`, `createdAt`, `rulesAgreedAt`). `username` is `string | null` (LUD-16 / NIP-05 local-part). `location` is `string | null` (never omitted, never `""`). The eleven public fields stay always present; `staffTag` is included only when set to `software_developer` and is omitted otherwise (never JSON `null`). No I/O. No Nostr key material.
- **Used by:** `serializeOwnerAccount` (member `/me`) and `serializeDebugAccount`.

## Function: serializeDebugAccount

- **Purpose:** Operator account JSON: the stored account columns except the legacy `lightning_address` and `lightning_address_verified` (no longer output; `repairGiftKind` still reads them, and the account select reads only whether `lightning_address` is set, as `hadExternalWallet`) and the derived `spark_address` (it follows from `spark_pubkey` and is not mapped onto `Account`), plus Nostr debug fields. Never used by member `GET /me`.
- **Inputs:** `Account`, optional `DebugNostrFields` (defaults to all-null), and optional `lnurlServer` (`lightningAddress` is the wallet-backed receiving address; the stored external address is never read).
- **Returns / side effects:** `DebugAccountResponse` including `username`, `viewKey`, `sessionRefused`, skip stamps, `profileMessageId`, `notificationLevel`, `notifyHearts` (boolean, default true), `amountUnit`, `locale`, `fiat`, `walletRequired`, `walletBackupSeenAt`, `walletIntroSeen` (default `false`), `sparkPubkey` (`string | null`), `sparkPubkeyVerifiedAt` (`number | null` epoch ms), and envelope hex `nostrNsecCiphertext`. Never decrypts. No I/O.
- **Used by:** `GET /debug/accounts`, `PATCH /debug/accounts/:id`, and the operator dump.

## Function: serializeDebugAccountDetail

- **Purpose:** Operator one-account JSON with nested passkeys, sessions, and passkey challenges.
- **Inputs:** `Account`, `DebugNostrFields`, nested credential/session/challenge rows, optional `lnurlServer`.
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

## Function: serializeDebugPasskeyChallenge

- **Purpose:** Operator JSON for one `passkey_challenge` row.
- **Inputs:** `PasskeyChallenge`.
- **Returns / side effects:** `{ id, type, challenge, accountId, consumed, createdAt, requestedName }` (`requestedName` is `null` when absent). No I/O.
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

- **Purpose:** Load operator dump rows for one table or every allowlisted table (cap 200). The forum `message` dump includes stored still metadata as lengths/MIME only (`photoContentType`, `photoBytes`, nested `extraPhotos: [{ idx, photoContentType, bytes, photoTakenAt }]`). The `conversation_message` dump uses that length/MIME shape without `photoTakenAt`. No media payloads; missing photo is `null` / `0` / `[]`. A `push_subscription` dump row includes `sessionToken` (string or null, like the `auth_session` token in the same dump); the `push_outbox` dump row includes `finishedAt` (ISO or null), `deliveredEndpoints`, and `skipEndpoints`; `shop_identity` rows carry the key metadata (`messageId`, `nostrPubkey`, `nostrKekId`, `nostrKeyCustody`, `nostrKeyCreatedAt`, `profileName`) and every outbox field, read with `ShopIdentityStore.listDebug(200)` (the first 200 identities in the `listAll()` order, `LIMIT $1` on Postgres); the encrypted secret is never dumped.
- **Inputs:** `DebugCatalogDeps` (including optional shop identities; optional `lnurlServer` for the `account` dump's `lightningAddress`) and optional table name.
- **Returns / side effects:** `Record<DebugCatalogTable, unknown[]>`. Missing optional stores dump as `[]`.
- **Used by:** `debugCatalogRoutes`.

## Function: debugCatalogRoutes

- **Purpose:** GET-only operator catalog at `/debug/dump` and `/debug/dump/:table`.
- **Inputs:** `DebugCatalogRouteDeps` (auth, messages, contacts, optional `shops`, optional `pos` and other stores, optional `lnurlServer` for each account's `lightningAddress`, debugToken). `address_verification` is not dumped. Missing `pos` dumps `pos_charge` as `[]`; missing `shops` dumps `shop_identity` as `[]`.
- **Returns / side effects:** Hono app. 503 if token unset; 401 if bearer mismatches; 404 unknown table; 200 dump JSON (GET `/` is `{ tables }` with each allowlisted name → row array, cap 200; GET `/:table` is `{ table, rows }`); 503 `{ error: 'Dump is unavailable' }` on store throw.
- **Used by:** `createApp` at `/debug/dump`.

## Function: aboutMeFromNote

- **Purpose:** Map profile-note text to the public About me field. Empty text is not a bio. When the trimmed text equals the trimmed display name case-insensitively, the auto name-copy is not a bio (`null`). When the trimmed text equals the profile note's stored `name` case-insensitively (and that stored name is non-empty), it is also unfilled — so Ada→Grace with note text still `Ada` stays `null`.
- **Inputs:** `name` (`string | null`), `text` (`string | null`), optional `storedNoteName` (`string | null`, default `null`). Production serializers that have a live `MessageRow` pass `row.name`.
- **Returns / side effects:** Trimmed bio string, or `null`. No I/O.
- **Used by:** `serializeOwnerAccountWithPosts`, `viewRoutes`, `membersRoutes`.

## Function: serializeOwnerAccount

- **Purpose:** Owner JSON for authenticated account responses. `lightningAddress` is the receiving address (the verified in-app wallet `<username>@<host of PUBLIC_BASE_URL>` from `receivingAddress`, or `null`) and `lightningAddressVerified` is true iff it is set; the stored external address is never read. Then the eleven public fields (including username and location) plus `viewKey`, `setup`, `missing`, `hasPosted`, `aboutMe`, `aboutMeHasPhoto`, `aboutMessageId` (live profile-note id only when `aboutMe !== null`, else `null`; never `profileMessageId` under another name), `notificationLevel` (`all` / `active` / `mentions` / `none`, default `all`, owner-only), `notifyHearts` (boolean, default `true`, owner-only), `amountUnit` (`btc` / `fiat`, default `btc`, owner-only), `locale` (`en` / `de` / `es` / `fil`, nullable, null when unset, owner-only), `fiat` (`CHF` / `EUR` / `USD` / `PHP`, nullable, null when unset, owner-only), `funding` (`null` for `basis`), `walletRequired` (false when omitted), `walletBackupSeenAt` (null when omitted), `walletIntroSeen` (false when omitted), `hadExternalWallet` (false when omitted; true when the account has a stored legacy external payout address), `sparkPubkey` (`account.sparkPubkey ?? null`), `sparkWalletVerified` (`sparkPubkeyVerifiedAt` is a number), `passkeyCredentialId` (base64url or null; null when `walletRequired` is not true even if a login passkey exists, and the newest id when `walletRequired` is true), and `passkeyRenewFailed` (true only for an unacknowledged failed renew), and `passkeyRenewClosed` (true only when `walletRequired` is not true and an acknowledged failed renew exists; the account still has no seed), and `passkeyRenewPrfUnsupported` (true only when the newest unacknowledged failed renew is `prfUnsupported`), and `socialRecoverySetUp` (true when a 21.gifts recovery share is stored for the current verified wallet; no grant or date check; owner-only), so the owner can copy the capability URL and the client can route onboarding, action gates, the introduce-yourself popup, About me photo display, living-room notify filter, amount-entry unit, funding status, wallet bind, and recovery-phrase reveal. Used by `GET /me`, `/me` writes including `POST /me/username`, `PUT /me/wallet`, `POST /me/rules-agreement`, `POST /me/setup/skip`, `POST /me/wallet-backup-seen`, `POST /me/wallet-intro-seen`, `POST /me/location`, `POST /me/notification-level`, `POST /me/heart-notifications`, `POST /me/amount-unit`, `POST /me/locale`, `POST /me/fiat`, and `PUT /me/about`, and passkey finish — never by the debug listing. Does not expose `profileMessageId`. Public `AccountResponse` and `ViewProfileResponse` do not get the wallet fields.
- **Inputs:** `Account` plus `hasPosted: boolean` plus `aboutMe: string | null` plus `aboutMeHasPhoto: boolean` plus optional `funding` (`OwnerFundingJson | null`, default `null`) plus optional `passkeyCredentialId` (`string | null`, default `null`) plus optional `passkeyRenewFailed` (`boolean`, default `false`) plus optional `passkeyRenewClosed` (`boolean`, default `false`) plus optional `passkeyRenewPrfUnsupported` (`boolean`, default `false`) plus optional `lnurlServer` (`LnurlServerConfig`) plus optional `socialRecoverySetUp` (`boolean`, default `false`).
- **Returns / side effects:** `OwnerAccountResponse` (thirty-five fields: eleven public + `viewKey`, `setup`, `missing`, `hasPosted`, `aboutMe`, `aboutMeHasPhoto`, `aboutMessageId`, `notificationLevel`, `notifyHearts`, `amountUnit`, `locale`, `fiat`, `funding`, `walletRequired`, `walletBackupSeenAt`, `walletIntroSeen`, `hadExternalWallet`, `sparkPubkey`, `sparkWalletVerified`, `passkeyCredentialId`, `passkeyRenewFailed`, `passkeyRenewClosed`, `passkeyRenewPrfUnsupported`, `socialRecoverySetUp`). No I/O. Does not expose `profileMessageId`. `aboutMessageId` is the live profile-note id only when `aboutMe !== null`, else `null`.
- **Used by:** `serializeOwnerAccountWithPosts` (`meRoutes` including `POST /me/username`, `PUT /me/wallet`, `PUT /me/recovery-share`, and `POST /me/heart-notifications`).

## Function: serializeOwnerAccountWithPosts

- **Purpose:** Async owner JSON with live-post lookup and profile-note About me. Calls `accountHasLivePost(account.id, account.profileMessageId ?? null)`, loads the profile note via `getById` when `profileMessageId` is non-blank, then `serializeOwnerAccount` so HTTP callers cannot drift. `aboutMe` is `null` when the profile note is missing or `deletedAt` is set (`getById` still returns soft-hidden rows; the serializer requires `row.deletedAt === null` — see `src/lib/auth/account-json.ts` 686: `if (row !== undefined && row.deletedAt === null)`). A live row passes `aboutMeFromNote(account.name, row.text, row.name)` so auto name-copy stays unfilled after a display-name rename, and `aboutMeHasPhoto` from `row.hasPhoto === true`. Overlay `hasPosted` is `accountHasLivePost` OR a real bio (`aboutMe !== null`) and is **not** the spend/invoice predicate. Spend eligibility is `accountHasLiveTopLevelPost` / `GET /invoices/posted`. When funding is passed, both renew predicates run even if `walletRequired` is false. `passkeyRenewFailed` is the unacknowledged predicate. `passkeyRenewClosed` is true only when `walletRequired` is not true and the acknowledged predicate is true. `passkeyRenewPrfUnsupported` is true only when `latestUnacknowledgedPasskeyRenewErrorName` is `prfUnsupported`. `walletRequired` is read after that predicate, so a seed that already acknowledged the failure is not closed. Owner JSON also carries `sparkPubkey` and `sparkWalletVerified` from the account row. Optional funding lookup loads the grant via `getByAccountId` and admitted `reviewedByName`, and, only when `walletRequired === true`, `authStore.getPasskeyCredentialForAccount` for `passkeyCredentialId` (the newest id by `createdAt` desc, then `credentialId` desc / `COLLATE "C"`; omitted lookup or `walletRequired` not true leaves that field `null`). With the lookup, `socialRecoverySetUp` is `authStore.hasRecoveryShareForVerifiedWallet` of the re-read account, so a previous wallet's share or an unverified claim gives `false`; without the lookup it is `false` and the share is not read.
- **Inputs:** `Account`, `Pick<MessageStore, 'accountHasLivePost' | 'getById'>`, optional `OwnerFundingLookup` (`store`, `nowMs`, `authStore` with `getAccount`, `getPasskeyCredentialForAccount`, `hasUnacknowledgedPasskeyRenewFailure`, `hasAcknowledgedPasskeyRenewFailure`, `latestUnacknowledgedPasskeyRenewErrorName`, and `hasRecoveryShareForVerifiedWallet`), optional `lnurlServer` forwarded to `serializeOwnerAccount`.
- **Returns / side effects:** `OwnerAccountResponse` including `hasPosted`, `aboutMe`, `aboutMeHasPhoto`, `aboutMessageId` (live profile-note id only when `aboutMe !== null`, else `null`; never `profileMessageId` under another name), `notificationLevel`, `notifyHearts`, `amountUnit` (`btc` / `fiat`, default `btc`, owner-only), `locale`, `fiat`, `funding`, `walletRequired`, `walletBackupSeenAt`, `walletIntroSeen`, `hadExternalWallet`, `sparkPubkey`, `sparkWalletVerified`, `passkeyCredentialId`, `passkeyRenewFailed`, `passkeyRenewClosed`, `passkeyRenewPrfUnsupported` (true only when the newest unacknowledged failed renew is `prfUnsupported`), and `socialRecoverySetUp`. Overlay `hasPosted` is `accountHasLivePost` OR a real bio (`aboutMe !== null`); spend/invoice lookup is `accountHasLiveTopLevelPost`. Omitted funding lookup is `basis` `null` or `{ status: 'none', … }` and `passkeyCredentialId` null. Store throw is unhandled.
- **Used by:** `meRoutes`, `authRoutes`, and `fundingRoutes` (POST /apply).

## Function: membersRoutes

- **Shops:** The profile card always includes uncapped `shopCount` from `countShopsByAccount`. `GET /members/:accountId/shops` lists the member's newest live shops with attributed `replyCount`, the posts `payable` and `authorCanReceive` rules (`messagePay`), and `heartCount` / `hearted`; failures return 503 and log `members.shops.failed` while the existing posts and replies behavior stays unchanged.
- **Credits:** The profile card always includes uncapped `creditCount` from `countCreditsByAccount`. `GET /members/:accountId/credits` lists the member's newest live credits with attributed `replyCount`, the posts `payable` and `authorCanReceive` rules (`messagePay`), and `heartCount` / `hearted`; failures return 503 and log `members.credits.failed` while the existing posts, shops, and replies behavior stays unchanged.

- **Purpose:** Hono sub-app for `GET /members/:accountId`, `GET /members/:accountId/activity`, `GET /members/:accountId/posts`, and `GET /members/:accountId/replies`. Bearer + `requireAction(forum.read)` on all, except that an operator token also reads `GET /:accountId/activity`; UUID path. Posts, shops, credits, and replies call `memberPublicMessages`. The profile note calls `loadMemberProfileNote`. Profile card is live identity plus optional `profileMessage` via `serializeMessage`, derived `aboutMe`, `aboutMeHasPhoto` (true when the live profile note has a stored photo; false when `profileMessage` is null), uncapped live `postCount` / `replyCount` from `countByAccount`, and `trust` via `accountTrust`, and `fundingReviewedAt` (`grant.admittedAt` when effective admitted, else `null`) and `fundingReviewedByName` (the reviewer's display name, or `null` when that name is missing). The profile card includes `staffTag` only when set; posts, replies, and `profileMessage` pass the author's tag into `serializeMessage` and omit the key when unset. Activity is the same activity JSON as `GET /me/activity` for that member (`buildAccountActivity`), including outstanding `owedSats` and `creditSats`. Posts is live-only top-level notes newest-first (cap 200, same serialize as signed-in `GET /messages` including `accountId` / `replyCount` / `payable` / `authorCanReceive`, optional `goalSats` omitted when unset, `goalRepayable: true` only when stored true (omitted when null, never false) and `goalTermDays` only when stored (omitted when null), `goalCurrency` / `goalAmount` / the four `goalAmount*` snapshots only when `goalCurrency` is stored (omitted on a legacy row; a snapshot may be null), and optional `place` omitted when unset; omits `parentId`; missing-file `hasVideo` direct replies are deleted and subtracted from `replyCount`). Replies is live-only member replies newest-first (cap 200, `authorCanReceive` when the author has a receiving address, `payable` when a non-empty `eventId` and a receiving address (`receivingAddress`: a verified wallet with the LNURL server configured) are set, optional `parentId`, no `replyCount`; replies never include `goalSats`, `goalRepayable`, or `goalTermDays`; a child that cannot serialize is omitted, siblings still 200).
- **Inputs:** `MembersRouteDeps` (`authStore`, optional `lnurlServer` (the payable flag uses `receivingAddress`, so a wallet-only member's notes are payable), `messageStore`, required `trustStore`, optional `fundingStore` default empty `InMemoryFundingStore`, `now`, optional `giftStore`, `rates`, and `fiatRates` used by `GET /:accountId/activity`; missing fiat never 503). Optional `debugToken` and `debugReadToken`: either one as Bearer reads `GET /:accountId/activity` without a session (`isOperatorBearer`); the other member GETs still need a session.
- **Returns / side effects:** Hono app mounted at `/members`. Activity is 200 JSON or 503 `{ error: 'Gift stats are unavailable' }` when the activity build throws. Missing fiat never 503. Logs `members.get.failed`, `members.posts.failed`, `members.replies.failed`, or `account.activity.failed` on 503. Activity 503 logs `account.activity.fx_incomplete` when the thrown error message is exactly `fx.rate.missing`, and `account.activity.failed` otherwise. GET JSON includes `aboutMe` and `aboutMeHasPhoto`.
- **Used by:** `createApp`.

## Function: mentionsRoutes

- **Purpose:** Hono sub-app for `GET /mentions`. Bearer session plus `requireAction(forum.read)`. Optional `q` matches the start of the username, the start of a username segment (`.` `_` `-`), or the start of the display name or one of its words (space, `.` `_` `-`), as soon as someone types `@` in a forum post. Empty `q` returns the first usernames. At most 20 rows, ordered by `lower(trim(username))` then `id`. Blank usernames are skipped. Each account is `{ id, username, name }`; `name` falls back to the stored username when the display name is null or blank. A token that itself contains `.`, `_`, or `-` matches only a whole-string start. Does not change stored `@username` marks.
- **Inputs:** `{ auth: AuthStore, now: () => number }`. `createApp` passes its clock. Query `q` is optional.
- **Returns / side effects:** Hono app mounted at `/mentions`. 200 `{ accounts }` or 401 `{ error: 'Unauthorized' }` / 409 `missing_requirements` / 400 `{ error: 'Invalid query' }`. No logging.
- **Used by:** `createApp`.

## Function: accountsByUsernameRoutes

- **Purpose:** Hono sub-app for `GET /accounts/by-username/:username`. Bearer session plus `requireAction(forum.read)`. The path param is an exact username (`normalizeUsername`). One account or 404. The body is exactly `{ id, username, name }`; `username` is the stored string and `name` is the stored display name, including null. Does not fall back a blank name to the username. Does not suggest prefixes.
- **Inputs:** `{ auth: AuthStore, now: () => number }`. `createApp` passes its clock. Path `:username`.
- **Returns / side effects:** Hono app mounted at `/accounts`. 200 `{ id, username, name }` or 401 `{ error: 'Unauthorized' }` / 409 `missing_requirements` / 400 `{ error: 'Username is not valid' }` / 404 `{ error: 'No account with that username' }`. No logging.
- **Used by:** `createApp`.

## Function: memberPublicMessages

- **Purpose:** One loader for a member's public post, shop, credit, or reply list. `GET /members/:accountId/posts|shops|credits|replies` and `GET /view/:viewKey/posts|shops|credits|replies` both call it. Drops a `hasVideo` row whose file is missing or empty (`messages.video.dropped`), except a credit note with sats, which is read again and kept while live. A reply that cannot serialize is skipped. Shops look up the row author; an external author has no role.
- **Inputs:** `kind` (`posts` | `shops` | `credits` | `replies`), `account`, `messageStore`, `authStore`, optional `lnurlServer`, `viewerAccountId` (`string` or `null`).
- **Returns / side effects:** `HeartedPublicMessage[]` in list order. When a listed note's video file is missing or empty, deletes that note with `deleteById` (the note, its direct replies, invoice attempts, zap receipts, photos, and on-disk videos). For posts, shops, and credits, each direct reply of a listed note whose own video file is missing or empty is deleted the same way, even when the listed note's video is present. Both happen from the member lists and the view-key lists alike. No other writes.
- **Used by:** `membersRoutes`, `viewRoutes`.

## Function: loadMemberProfileNote

- **Purpose:** One loader for the live profile note on the member card and the view-key card. Missing, blank, and soft-hidden notes are `null`. `aboutMe` is the real bio, else `null`. `hearted` follows `viewerAccountId`.
- **Inputs:** `account`, `messageStore`, optional `lnurlServer`, `viewerAccountId` (`string` or `null`).
- **Returns / side effects:** `{ profileMessage, aboutMe, aboutMeHasPhoto }` or `null`. No writes.
- **Used by:** `membersRoutes`, `viewRoutes`.

## Function: serializeViewProfile

- **Purpose:** Public profile card for the capability URL. Same visible identity as the member card: `id`, `role`, uncapped post/reply/shop/credit counts, the funding mark (`fundingReviewedAt`, `fundingReviewedByName`), and `profileMessage` (the live note, or `null`). `lightningAddress` is the receiving address (the verified in-app wallet `<username>@<host of PUBLIC_BASE_URL>` from `receivingAddress`, or `null`) and `lightningAddressVerified` is true iff it is set; the stored external address is never read. `aboutMessageId` is the live profile-note id only when `aboutMe !== null`, else `null`. `staffTag` is present only for `software_developer`. Omits `linkingKey`, `viewKey`, the moderator `trust` graph, and owner-only settings. `username` and `location` are `string | null` (location never `""`). `createdAt` stays epoch milliseconds.
- **Inputs:** `Account`, `hasPasskey: boolean`, `aboutMe: string | null`, `aboutMeHasPhoto: boolean`, optional `lnurlServer`, optional `facts` (counts and funding; omitted facts are zeros and nulls), optional `profileMessage` (omitted means `null`).
- **Returns / side effects:** `ViewProfileResponse`. No I/O.
- **Used by:** `viewRoutes`.

## Function: parseNostrKek

- **Purpose:** Parse `NOSTR_NSEC_KEK` as 32-byte AES key (64 lowercase hex). Delegates to `parseKekHex('NOSTR_NSEC_KEK', raw)`, so its messages stay `NOSTR_NSEC_KEK is required when DATABASE_URL is set` and `NOSTR_NSEC_KEK must be 64 lowercase hex characters`.
- **Inputs:** Env string or `undefined`.
- **Returns / side effects:** `Uint8Array` or throw.
- **Used by:** `openBootStores`.

## Function: parseKekHex

- **Purpose:** Parse a 32-byte AES key given as 64 lowercase hex characters (surrounding whitespace is trimmed). It is the shared body of the two boot keys, `NOSTR_NSEC_KEK` and `RECOVERY_SHARE_KEK`.
- **Inputs:** `name`, the environment variable name used in the messages, and the env string or `undefined`.
- **Returns / side effects:** 32-byte `Uint8Array`. Throws `<name> is required when DATABASE_URL is set` for a missing or blank value and `<name> must be 64 lowercase hex characters` for anything else that is not 64 lowercase hex. No I/O; never logs the value.
- **Used by:** `parseNostrKek` and `parseRecoveryShareKek`, both on the SQL path of `openBootStores`.

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
- **Used by:** `ensureAccountNostrKey` and the shop key creation of `InMemoryShopIdentityStore.ensureListed` / `PostgresShopIdentityStore.ensureListed`.

## Function: encryptNostrSecret

- **Purpose:** AES-256-GCM envelope for a 32-byte nsec. Checks the 32-byte secret, then seals it with `sealAesGcmEnvelope` and the UTF-8 account id (or `shop:{messageId}` for a shop key) as additional data; `NOSTR_ENVELOPE_VERSION` is `AES_GCM_ENVELOPE_VERSION`.
- **Inputs:** secret, kek, accountId (the AAD: an account id, or `shop:{messageId}` for a shop key), optional kekId.
- **Returns / side effects:** Envelope bytes. Throws `Nostr secret must be 32 bytes` or `KEK must be 32 bytes`.
- **Used by:** `ensureAccountNostrKey` and the shop key creation of `InMemoryShopIdentityStore.ensureListed` / `PostgresShopIdentityStore.ensureListed` (AAD `shop:{messageId}`).

## Function: decryptNostrSecret

- **Purpose:** Decrypt a v1 envelope (`kek_id=1` only).
- **Inputs:** envelope, kek, accountId (the AAD: an account id, or `shop:{messageId}` for a shop key).
- **Returns / side effects:** 32-byte secret.
- **Used by:** `signEventForAccount` and `signEventForShop` (AAD `shop:{messageId}`).

## Function: zeroizeSecret

- **Purpose:** Overwrite a secret buffer with zeros.
- **Inputs:** `Uint8Array`.
- **Returns / side effects:** In-place fill.
- **Used by:** `ensureAccountNostrKey`, `signEventForAccount`, `signEventForShop`, the shop key creation of `InMemoryShopIdentityStore.ensureListed` / `PostgresShopIdentityStore.ensureListed`, and `encryptRecoveryShare`.

## Function: sealAesGcmEnvelope

- **Purpose:** Encrypt bytes into the v1 AES-256-GCM envelope shared by the custodial Nostr secret and the 21.gifts recovery share: `version(1) = 0x01 || kek_id uint32 big-endian || nonce(12) || ciphertext + tag(16)`.
- **Inputs:** `plaintext` (at least one byte), a 32-byte `kek`, the AES-GCM `additionalData` bound to the ciphertext, and the `kekId` written into the envelope.
- **Returns / side effects:** Envelope bytes, `17 + plaintext.length + 16` long, with a fresh `crypto.getRandomValues` nonce; the key is imported non-extractable for `encrypt` only. Throws `KEK must be 32 bytes` for another key length and `Plaintext must not be empty` for empty plaintext. The module has no open function; `decryptNostrSecret` opens Nostr envelopes only, and nothing in the api opens a recovery share.
- **Used by:** `encryptNostrSecret` and `encryptRecoveryShare`.

## Function: parseRecoveryShareKek

- **Purpose:** Parse `RECOVERY_SHARE_KEK`, the 32-byte AES key of the 21.gifts recovery share, with `parseKekHex('RECOVERY_SHARE_KEK', raw)`, and refuse a key equal to `NOSTR_NSEC_KEK` (compared with `timingSafeEqual`), because the share has its own key.
- **Inputs:** The env string or `undefined`, and the already parsed `NOSTR_NSEC_KEK` bytes.
- **Returns / side effects:** 32-byte `Uint8Array`. Throws `RECOVERY_SHARE_KEK is required when DATABASE_URL is set`, `RECOVERY_SHARE_KEK must be 64 lowercase hex characters`, or `RECOVERY_SHARE_KEK must differ from NOSTR_NSEC_KEK`. Never logs the value.
- **Used by:** `openBootStores` on the SQL path, right after `parseNostrKek`; a memory boot never reads it and returns `recoveryShareKek: undefined`.

## Function: encryptRecoveryShare

- **Purpose:** Encrypt one 21.gifts recovery share (the 20 SLIP-39 words of member index 2 of the owner's 2-of-3 set) for storage in `recovery_share.recovery_share_ciphertext`.
- **Inputs:** The share text, which must match `RECOVERY_SHARE_TEXT` (20 lowercase words of 4 to 8 letters separated by single spaces), the 32-byte `RECOVERY_SHARE_KEK`, and the account id.
- **Returns / side effects:** A `sealAesGcmEnvelope` envelope with the UTF-8 account id as additional data and kek id `RECOVERY_SHARE_KEK_ID_V1` (1). Throws `Invalid recovery share` for text that does not match and `KEK must be 32 bytes` for another key length. The UTF-8 plaintext buffer is zeroed after sealing; the share is never logged, returned, or stored outside the envelope, and the api has no function that decrypts it.
- **Used by:** The recovery share route (`PUT /me/recovery-share`).

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

## Function: migrateBannerSchema

- **Purpose:** Create `account_image` if it is missing. One row per account for `picture` and one for `banner`. Idempotent.
- **Inputs:** SQL client.
- **Returns / side effects:** Resolves when the statement has run.
- **Used by:** SQL boot, before `db_change` attach.

## Function: wideBannerSize

- **Purpose:** Width and height of a JPEG, PNG, or WebP that is at least 640 px wide and at least 1.5 times as wide as it is tall. Anything else, including a missing header, returns null.
- **Inputs:** image bytes, MIME.
- **Returns / side effects:** `{ width, height }` or null. No I/O.
- **Used by:** `PUT /banners/me`.

## Function: picturePublicUrl

- **Purpose:** Absolute public URL for one account's profile photo. Not the wide image and not an About me note photo.
- **Inputs:** API origin, account id, MIME.
- **Returns / side effects:** URL string under `/pictures/`. No I/O.
- **Used by:** Worker sign path for kind:0 `picture`.

## Function: isProfilePhoto

- **Purpose:** Whether JPEG, PNG, or WebP bytes have a readable size. A portrait is allowed. This is not the wide-image rule.
- **Inputs:** image bytes, MIME.
- **Returns / side effects:** boolean. No I/O.
- **Used by:** `PUT /pictures/me`.

## Function: pictureRoutes

- **Purpose:** `PUT /pictures/me` stores or clears the signed-in account's profile photo. It does not change the wide image or the About me note. `GET /pictures/me` returns the stored bytes. `GET /pictures/:accountId.jpg|.png|.webp` is public and 404s when the extension does not match or the account id is not a UUID. On the device's local Sunday, that PUT is 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names the zone. GET stays open. A missing, blank, or invalid zone does not refuse.
- **Inputs:** Auth store, optional image store, optional clock.
- **Returns / side effects:** Hono app mounted at `/pictures`.
- **Used by:** `createApp`.

## Function: bannerPublicUrl

- **Purpose:** Absolute public URL for one account's wide image. The extension matches the stored MIME.
- **Inputs:** API origin, account id, MIME.
- **Returns / side effects:** URL string. No I/O.
- **Used by:** Worker sign path for kind:0 `banner`.

## Function: InMemoryBannerStore

- **Purpose:** Process-local store for the round profile photo and the wide image. The two slots never share bytes. The About me photo is neither. Default empty so the process boots without a database.
- **Inputs:** `get(accountId, slot)` and `set(accountId, slot, photo | null)`. `slot` is `picture` or `banner`.
- **Returns / side effects:** A byte copy of that slot, or null. No I/O.
- **Used by:** `createApp` when no image store is injected; `/pictures` and `/banners`.

## Function: PostgresBannerStore

- **Purpose:** `account_image` rows, one per slot. `get` returns null for a missing, non-image, or non-byte row, and when Postgres rejects the account id as a UUID (`22P02`). `set(null)` deletes that slot only. `set(photo)` upserts that slot only. The About me photo is neither slot. A write still uses the session account id, which is already a UUID.
- **Inputs:** SQL client. `get(accountId, slot)` and `set(accountId, slot, photo | null)`.
- **Returns / side effects:** Stored image or null. Writes one row of that slot.
- **Used by:** SQL boot, shared by `/pictures`, `/banners`, and the Nostr worker.

## Function: bannerRoutes

- **Purpose:** `PUT /banners/me` stores or clears the signed-in account's wide image. A portrait, a square, a thin strip, and bytes that are not a JPEG, PNG, or WebP are rejected. `GET /banners/me` returns the stored bytes. `GET /banners/:accountId.jpg|.png|.webp` is public and 404s when the extension does not match the stored MIME or the account id is not a UUID. The profile photo and the About me photo are not this image. On the device's local Sunday, that PUT is 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names the zone. GET stays open. A missing, blank, or invalid zone does not refuse.
- **Inputs:** Auth store, optional banner store, optional clock.
- **Returns / side effects:** Hono app mounted at `/banners`.
- **Used by:** `createApp`.

## Function: notePageUrl

- **Purpose:** Public `/l/<8 hex>` URL for one forum message, same shape as the app copy link. Empty origin or a non-UUID id returns null so the worker leaves the homepage reference.
- **Inputs:** site origin (`PUBLIC_BASE_URL`), message id.
- **Returns / side effects:** Absolute URL, or null. No I/O.
- **Used by:** Worker sign path.

## Function: imageDisplaySize

- **Purpose:** Read `WIDTHxHEIGHT` from a PNG, JPEG, or WebP header. Video MIME returns null. JPEG and WebP return null when the dimension header is missing or truncated, or when the size is outside 1..20000. A complete JPEG or WebP header still sets the size when later bytes are cut off. A PNG returns the size the decoder reports; a decoder throw is null.
- **Inputs:** image bytes, MIME.
- **Returns / side effects:** `dim` string or null. No I/O.
- **Used by:** `stillLook`.

## Function: imageBlurhash

- **Purpose:** BlurHash for a JPEG or PNG, sampled to at most 32 px on the long side. WebP, video, and bytes that do not decode return null.
- **Inputs:** image bytes, MIME.
- **Returns / side effects:** BlurHash string or null. No I/O.
- **Used by:** `stillLook`.

## Function: stillLook

- **Purpose:** Optional `dim` and `blurhash` for one still. A readable header can set `dim` alone when the pixels do not decode. The object is empty only when neither field is produced. Does not throw.
- **Inputs:** image bytes, MIME.
- **Returns / side effects:** Object with the fields that decoded.
- **Used by:** Worker sign path.

## Function: forumPhotoUrl

- **Purpose:** Absolute `GET /messages/:id/photo.jpg` (or `.png` / `.webp`) URL for kind:1 content and `imeta`, the shop kind 0 `picture` and the photos of `GET /shops/:npub`. The extension matches the stored MIME so Damus treats the URL as an image, not a website.
- **Inputs:** API origin, message id, optional MIME (default JPEG).
- **Returns / side effects:** URL string.
- **Used by:** Worker sign path; shop kind 0 `picture` (`shopKind0Args`); `GET /shops/:npub` photo URLs.

## Function: forumExtraPhotoUrl

- **Purpose:** Absolute extra-still URL `/messages/:id/photo/:index.jpg|.png|.webp` for indices 1–9 so Damus treats the URL as an image. Extension from MIME (default JPEG).
- **Inputs:** API origin, message id, extra still index (1–9), optional MIME (default JPEG).
- **Returns / side effects:** URL string `{apiBase}/messages/{id}/photo/{index}.{ext}`.
- **Used by:** Worker sign path (still branch, `listExtraPhotos` mapped with `i+1`); shop kind 0 `banner` (`shopKind0Args`); `GET /shops/:npub` photo URLs.

## Function: buildKind1Event

- **Purpose:** Unsigned kind:1 for a forum line (top-level or NIP-10 reply). Optional media (`Kind1Photo`: image or video MIME) appends the public URL to content and a NIP-92 `imeta` tag (`url`, `m`, optional `blurhash`, optional `dim`, optional `size`, optional `image` from `posterUrl`). Always ensures Damus-visible `#bitcoin` / `#21gifts` via `kind1ContentWithHashtags`, appending only missing tokens (forum row `text` is not modified). Optional fifth `location?: string | null`: when `locationHashtagName` is non-null, extra content token and `t` tag. Optional sixth `extraPhotos?: readonly Kind1Photo[]`: empty/omitted extras are bit-identical to the five-arg form; non-empty extras append extra URL lines after the first photo URL plus one `imeta` per extra (`url`, `m`, optional blurhash/dim/size; no poster). Optional seventh `pageUrl`: when a non-empty string, the homepage `r` tag becomes that URL and the URL is appended to the content unless that exact URL is already its own token (the next character is missing or not a letter, digit, or underscore). Null, omitted, or empty keeps the homepage `r` tag. Profile notes are skipped by the worker, not this function. When `replyTo` is set, adds NIP-10 `e` (root + reply) and `p` tags after the frozen tags (and optional `imeta`); top-level notes never get `e`/`p`/`q`. Each `imeta` may also include `x` (64 lowercase hex hash) and `duration` (integer seconds from 1 to 86400). A `blurhash` value that is not BlurHash text is omitted.
- **Inputs:** content, unix created_at, optional `{ url, mime, posterUrl?, dim?, size?, hash?, durationSeconds?, blurhash? }` (`Kind1Photo`), optional `replyTo?: Kind1ReplyTo` (`noteEventId`, `spaceRelay`, `noteAuthorPubkey`), optional fifth `location?: string | null`, optional sixth `extraPhotos?: readonly Kind1Photo[]`, optional seventh `pageUrl?: string | null`.
- **Returns / side effects:** Unsigned fields (`kind`, `content`, `tags`, `created_at`).
- **Used by:** Worker sign path.

## Function: buildKind0Content

- **Purpose:** Kind:0 JSON without extra whitespace (`name`, `display_name`, `website`, `banner`, `picture`, `about`, optional `lud16`, optional `nip05`).
- **Inputs:** name, receiving address (verified wallet) or null, optional nip05 or null, optional `about` (default `'21.gifts'`; worker passes profile-note text when present, and for a shop profile `shopDescription` of the note for a public shop, or `This shop is no longer listed on 21.gifts.` for a shop that is no longer public), optional `images` with personal `picture` and `banner` URLs, optional `website` (default `https://21.gifts`), and optional `includeImages` (default true).
- **Returns / side effects:** JSON string. `picture` and `banner` are the passed URLs when non-blank, otherwise the 21.gifts icon and `https://21.gifts/og.png`; both are omitted when `includeImages` is false. The worker passes the account's own profile photo only as `picture` and the account's own wide image only as `banner`. The About me note photo is neither. `lud16` only when address set. `nip05` only when a public identifier is passed.
- **Used by:** `buildKind0Event`, worker `publishProfiles` and the shop kind 0 (`website` = `<site origin>/{npub}`; `includeImages` false for a shop that is no longer public).

## Function: buildKind0Event

- **Purpose:** Unsigned replaceable kind:0, including optional `nip05`, optional `about`, and optional personal `picture` and `banner`.
- **Inputs:** name, receiving address (verified wallet) or null, unix created_at, optional nip05, optional about (default `'21.gifts'`), optional images, optional website, and optional image-inclusion flag; forwards profile content arguments unchanged, so the signed content equals `buildKind0Content` with the same arguments.
- **Returns / side effects:** Unsigned fields.
- **Used by:** Worker `publishProfiles` and the shop kind 0.

## Function: buildKind10002Event

- **Purpose:** Unsigned NIP-65 relay list.
- **Inputs:** relay URLs, unix created_at.
- **Returns / side effects:** Unsigned fields.
- **Used by:** Worker `publishRelayLists` and `publishShopRelayLists` (shop kind 10002).

## Function: truncatePubkeyDisplay

- **Purpose:** Short npub-style label for Damus authors without a 21.gifts account. Also the public JSON `name` fallback when a stored forum `name` is blank. Empty input → `'npub'`.
- **Inputs:** hex pubkey.
- **Returns / side effects:** Truncated display string.
- **Used by:** Inbound forum replies; conversation display names (`GET /conversations` Damus-only counterparts); `serializeMessage`.

## Function: signEventForAccount

- **Purpose:** Decrypt nsec, `finalizeEvent`, zeroize.
- **Inputs:** store, accountId, kek, unsigned template.
- **Returns / side effects:** Signed event. Never logs the secret.
- **Used by:** Worker, `POST /messages/:id/invoice`, `POST /messages/:id/repayment` and `POST /messages/:id/repayment/due` (the author signs each repayment zap request).

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
- **Used by:** Worker publish, including `publishShopProfiles` and `publishShopRelayLists`.

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

- **Purpose:** HTTP origin for photo URLs (kind:1, shop kind 0, `GET /shops/:npub`). Maps `https://21.gifts` → `https://api.21.gifts`, `https://dev.21.gifts` → `https://dev-api.21.gifts`, and `https://staging.21.gifts` → `https://staging-api.21.gifts`; otherwise the trimmed `PUBLIC_BASE_URL`.
- **Inputs:** env slice.
- **Returns / side effects:** Origin without trailing slash, or empty.
- **Used by:** Worker sign path; shop kind 0 `picture` / `banner` (`shopKind0Args`); `shopRoutes` (photo URLs of `GET /shops/:npub`).

## Function: resolveZapRelays

- **Purpose:** Relays for the kind 9734 `relays` tag, kind 9735 receipt reads, and inbound kind 1 replies and direct messages (space plus the public list, independent of `NOSTR_PUBLISH_PUBLIC`). Receipts are published only to the relays a zap request names, so the read set equals this list, and every zap request the api builds names it (at least the space relay).
- **Inputs:** env slice.
- **Returns / side effects:** Space URL first, then unique `resolveRelayPublic` entries.
- **Used by:** Invoice routes (`POST /messages/:id/invoice`); conversation invoices; repayment invoices; the boot external-zapper backfill default; external-profile lookups; `runNostrWorkerTick` receipt ingest, hot lane, inbound replies and DMs.

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

- **Purpose:** In-process invoice caps (1/10s, 20/h by default) for gifts and repayment invoices. A heart does not check or consume this budget. The constructor takes optional `InvoiceRateCaps` (`burstCap`, `hourCap`); omitted caps are `INVOICE_BURST_CAP` / `INVOICE_HOUR_CAP`. A local test boot may pass raised caps from `resolveTestInvoiceRateCaps`.
- **Inputs:** Optional `caps: InvoiceRateCaps`. `allow(accountId, nowMs)`.
- **Returns / side effects:** boolean; idle eviction 48h.
- **Used by:** `POST /messages/:id/invoice` (gifts, not hearts), `POST /messages/:id/repayment`, and `POST /messages/:id/repayment/due`.

## Function: resolveTestInvoiceRateCaps

- **Purpose:** Resolve test-only per-account invoice caps from `TEST_INVOICE_BURST_CAP` and `TEST_INVOICE_HOUR_CAP`. Both unset or blank yields `null` (the default 1/10s and 20/h stay). Production never sets them. The values are honoured only when the host of `BIND_ADDR` (text before the last `:`; unset or blank is `0.0.0.0` and fails the gate) is `127.0.0.1`, `localhost`, `::1`, or `[::1]`, and `WEBAUTHN_RP_ID` trims to `localhost`. A gate miss returns `null` without parsing, so a malformed value on a non-local boot is ignored. On a gated boot a blank value keeps that cap's default; any other value must be an integer from the default through 100000 or boot throws `TEST_INVOICE_BURST_CAP must be an integer from 1 to 100000` / `TEST_INVOICE_HOUR_CAP must be an integer from 20 to 100000`. Used by `scripts/loan-e2e` to mint several hundred invoices per hour.
- **Inputs:** Environment slice (`TEST_INVOICE_BURST_CAP`, `TEST_INVOICE_HOUR_CAP`, `BIND_ADDR`, `WEBAUTHN_RP_ID`).
- **Returns / side effects:** `{ burstCap, hourCap }` or `null`. No I/O. Throws on a gated boot with a malformed or out-of-range value. `createApp` passes non-null caps into `InvoiceRateLimiter` for gift and repayment minting and `console.warn`s `test invoice rate caps burst=<n>/10s hour=<n>/h` once.
- **Used by:** `createApp` (default `AppDeps.invoiceRateCaps`).

## Function: HeartRateLimiter

- **Purpose:** In-process heart caps, separate from `InvoiceRateLimiter`: one heart per account and note per 10 seconds (`HEART_NOTE_COOLDOWN_MS`), and at most 60 hearts per account per sliding hour across all notes (`HEART_HOUR_CAP`). Hearts and gifts never share a budget.
- **Inputs:** `allow(accountId, noteId, nowMs)`.
- **Returns / side effects:** `true` when allowed and recorded; `false` when over either cap (not recorded). Per-note stamps older than the cooldown are dropped on each call; account keys idle for 48 hours are evicted.
- **Used by:** `POST /messages/:id/invoice` with `heart: true`, after the self-heart and free-payments checks; over limit is 429 `Too many payments` with `Retry-After: 10`.

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
- **Used by:** Worker, including `publishShopProfiles` and `publishShopRelayLists`.

## Function: publicAcked

- **Purpose:** Whether a non-space relay ACK'd OK.
- **Inputs:** acks, spaceUrl.
- **Returns / side effects:** boolean.
- **Used by:** Worker, including `publishShopProfiles` and `publishShopRelayLists`.

## Function: runNostrWorkerTick

- **Purpose:** Runs one worker pass in mode `'all'` (default), `'fast'`, or `'ingest'`. Mode `'all'` keeps today's full sequence: full `indexOpenZapReceipts`, resign/sign/publish when enabled, inbound replies, inbound DMs, then `backfillProfileMessages`. Mode `'fast'` starts with hot zap ingest (recent in-app invoice e-tags only; see `indexOpenZapReceipts` hot mode), then the same resign/sign/publish/`backfillProfileMessages` path, without full zap enumeration, inbound replies, or inbound DMs. Mode `'fast'` selects hot targets via `listRecentOkInvoiceAttempts(now − HOT_ZAP_WINDOW_MS (1 h), HOT_ZAP_INVOICE_LIMIT (50))`, takes the first `e` tag of each returned zap request, deduplicates them keeping first-seen order, queries relays with `since` = the oldest contributing attempt's `createdAt` minus `HOT_ZAP_SINCE_SLACK_S` (600 s), and makes no relay query when there is no target (i.e. no attempt yields an `e` tag). Mode `'ingest'` runs full `indexOpenZapReceipts` (including `retryGiftReplies`), then inbound kind:1 replies and kind:4/1059 DMs, with no sign, publish, or profile backfill. On `'all'` / `'fast'`, zap work runs before resign/sign/publish so receipt indexing is not delayed by relay publish timeouts; `nowMs` for sign/publish leases is sampled only after that zap work returns, so an overlapping fast tick cannot reclaim with a later clock while this tick still signs/publishes under a stale lease time. Full ingest and the hot lane query kind 9735 on `resolveZapRelays` (space plus the public list, even when `NOSTR_PUBLISH_PUBLIC` is off) — the same relays every kind 9734 request names and inbound kind 1 replies and direct messages are read from — and index validated forum receipts onto `sats`, even when `NOSTR_PUBLISH` is off. Then `'all'` / `'fast'` signs unsigned rows and fans out when `NOSTR_PUBLISH=1`. Space-only ACK is terminal `published`/`space`. With `NOSTR_PUBLISH_PUBLIC=1`, space-only parks `pending` until a public ACK. Pending kind:1 JSON without `t=bitcoin` is dropped and re-signed, then unsigned rows are signed. After that, published unpaid notes missing a photo URL, a video URL, or Damus `#bitcoin`/`#21gifts` (and, when `account.location` is set, the location hashtag) in content are reset for the next tick (`PUBLIC_BASE_URL` set for media URLs; video posters are not treated as missing photos; `profileMessageId` rows are skipped so a name note is not rewritten with those hashtags; location is never applied to profile notes). Pending rows EVENT as-is so a reset cannot renew the 60s sign lease. Zapped rows keep `eventId`. An empty API base skips photo/video-URL resign. Sign looks up photo bytes even when `hasPhoto` is stale. Modes `'all'` / `'fast'` run `backfillProfileMessages` for named accounts with a verified wallet missing a profile note. When publishing, also fans out kind:0 profiles (`name` / `display_name` / `picture` / `banner` / optional `nip05`, optional `lud16` = the receiving address from `receivingAddress` (the wallet-backed address when `lnurlServer` is set and the wallet is verified; no `lud16` without one), `about` from the profile-note text or `21.gifts`) and NIP-65 kind:10002 relay lists. `picture` is only the account's own profile photo. `banner` is only the account's own wide image. The About me note photo is neither. A missing profile photo stays the shared icon. A missing wide image stays `https://21.gifts/og.png`. Unsigned non-profile kind:1 notes get `notePageUrl(PUBLIC_BASE_URL)` as their page link. Already published kind:1 rows are not rewritten for that link. Kind:1 photo/video posts include the public media URL and `imeta`. Extra `imeta` only on the still branch via `listExtraPhotos` mapped with `forumExtraPhotoUrl(..., i+1, mime)` as the 6th `buildKind1Event` arg; video stays exclusive (poster = photo 0, no extras). Modes `'all'` / `'fast'` also run `signConversationBatch` (NIP-17 wraps when a conversation store is present) and, when `NOSTR_PUBLISH=1`, `publishConversationBatch`. Zap ingest (`indexOpenZapReceipts`) calls `notifyZap` after a newly indexed **member-note** forum receipt (not the official platform profile note). It inserts a payer gift-reply after parent `sats` only when the paid row is a top-level member note (`parentId` null) that is not the official platform profile note. A member/invoice zap (`payerAccountId`) on that platform note is a compose fee (payer post/reply, `sats` 0) that skips `notifyZap` and fans out `notifyForumPost` / `notifyForumReply` plus a top-level `spendPing` only when `eligibleToday` (same gate as `POST /messages`; ineligible logs `spend.ping.skipped` / `not_eligible`). An external zap (`payerPubkey`) on that same note still inserts `insertExternalGiftReply` (gift-reply under the profile note, paid sats, no `notifyForumPost`). A zap on a signed reply credits that reply; no nested gift-reply. A member-note gift-reply does not call `notifyForumReply`. PN / conversation-invoice receipts hit `appendConversationGift` without addSats, without a forum gift-reply, and without `notifyZap`. Modes `'all'` / `'ingest'` run `indexInboundForumReplies` (REQ kind:1 `#e` our published note ids, even when publish is off; persists replies through either a member-account pubkey match or an external-zapper entitlement whose pubkey is not blocked and whose `ExternalIngestLimiter` acquisition succeeds; inbound authors satisfying neither path are skipped; after a member reply is stored, `notifyForumReply` always runs with `auth` (in-app every account except the actor (no-op when the actor is the official platform account), then filtered by each account's `notificationLevel`; Web Push only to bell subscribers, same filter); failures log `nostr.reply.notify.failed` and do not undo persist) and `indexInboundDirectMessages` (REQ kind:1059 / kind:4 to member and platform pubkeys when a conversation store is present). Fast-lane ticks are not serialised, except the S1 shop key backfill and the shop kind 0 and kind 10002 passes, each skipped while its previous pass for the same store is in flight; the ingest lane waits for each pass to settle before scheduling the next. When public publish is on and the space ACK succeeded, kind:1 is also fan-out best-effort to the search relay and reply inbox relays, and a successful kind:0 or kind:10002 is also sent to the indexer; a NACK from that fan-out does not change publish state.
- **Inbound forum replies:** After basic kind/id/pubkey checks, the pubkey is classified as a member or as an entitled, unblocked external zapper before kind:1 signature verification and before any event-specific message-store read; failures at that gate are silent. External event ids are held in a per-store in-flight set while an accepted event is processed, so overlapping ticks do not concurrently persist the same reply. The event time is clamped with `Math.min(eventMs, nowMs)`, retaining the existing `nowMs` fallback when `created_at` is missing or non-numeric. For external replies, the verified kind:0 display name is resolved first, then `isPubkeyBlocked` rechecks the kill switch inside the in-flight `try` and before the limiter is acquired immediately ahead of `messages.create`; a concurrent block writes nothing, consumes no budget, and still releases the in-flight id in `finally`. A rejected acquisition also writes nothing, and a failed create releases that acquisition. A stored external reply calls `notifyExternalForumReply` only when `created_at` is numeric, no more than ten minutes in the future, and no more than one hour old; missing/non-numeric, farther-future, and older replies remain stored without notification. That helper targets only the parent member author and uses the generic actor name `Someone`. Member replies keep the existing `notifyForumReply` fan-out.
- **Zap ingest dedupe:** One `nostr_zap_ingest` row is written per receipt per decision change per process (the memory is per store instance and empty after a restart, so the first ingest pass after boot may write one `rejected`/`duplicate` row per receipt that pass still queries (`listLatest` plus non-null `listReplies` children of those rows, plus the newest MESSAGE_LIST_LIMIT live replies that have an event id (`listRecentReplies`) even when their parent is not in `listLatest`, unioned with the official platform profile note's `eventId` even after it ages out of `listLatest`)). A repeated identical `outcome:reason` is normally not written again, because the memory is consulted before the write; that is not a guarantee, since the memory is set only after the write resolves, fast-lane ticks are not serialised, and a failed write leaves it untouched. Receipts whose remembered decision is terminal (`indexed` or `rejected`/`duplicate`) skip note lookup, account/LNURL/amount validation, and ingest persist. They still run `verifyReceipt` before `tryEnsureGiftReply` (see `indexOpenZapReceipts` Terminal skip).
- **Kind:0 cache:** Unchanged content is not resent for the life of the AuthStore instance. After the live account row is read, the worker stores a reservation object and treats only that object as owner after each await. A nack or throw deletes the reservation only when it is still that object; the last issued `created_at` watermark is kept so a retry in the same second still increments. Kind:0 `created_at` is `max(wall clock, last issued + 1)` so an in-flight older profile cannot win a same-second replaceable-event tie.
- **Kind:0 batch:** At most `WORKER_BATCH` keyed attempts run per tick, including nacks. With public fan-out on, a space-only ACK is a nack and the profile is retried.
- **Inputs:** worker deps; optional `mode` (`'all'` \| `'fast'` \| `'ingest'`, default `'all'`).
- **Returns / side effects:** Store updates; logs `nostr.sign.failed` / `nostr.publish.*` / `nostr.profile.ok` / `nostr.profile.nack` / `nostr.relays.ok` / `nostr.relays.nack` / `nostr.dm.sign.failed` / `nostr.dm.publish.*` / `nostr.dm.push.failed` / `nostr.reply.notify.failed`. Event-id collision retries once with `created_at + 1`.
- **Used by:** `startNostrWorker`.
- **Shop keys (S1):** With `shopIdentities`, every `'all'`/`'fast'` tick reads one raw page of at most `WORKER_BATCH` key candidates (`listCandidates`: live, top-level `#21GiftsShop` notes with a till account, pinned or not, keyed or not, read on the partial index `message_shop_directory_idx`) after a per-store keyset cursor by (`created_at`, `id`), advances the cursor to the last row of that raw page, and calls `ensureListed` only for the candidates without a key (`keyed` false), which mints a key when `publicShop` accepts the note. The cursor moves past keyed notes and resets to the start only after a short raw page, so a lap where every candidate has a key reads one page per tick and generates no key. A new key queues the place push and the photo push. A failure logs `shop.nostr_key.failed` with the message id. While a backfill for the same store is still in flight (a per-store in-flight mark, cleared also when the page read throws), a tick skips it without reading, so overlapping ticks never stack scans or key generation and an older pass cannot set the cursor back.
- **Shop profiles (S2):** While publishing is on, after the account kind 0 and kind 10002, the worker publishes kind 0 and kind 10002 for every shop identity, public or not, signed by `signEventForShop`, with the same cache, `created_at` watermark, ack rules (space required; public required when public fan-out is on), `WORKER_BATCH` limit and best-effort `wss://purplepag.es` copy as accounts, except that each kind walks the `listAll()` order as a round robin with bounded reads: per tick and kind it reads one page of at most `WORKER_BATCH` identities with `ShopIdentityStore.listRound` after that kind's in-process cursor (by `nostr_key_created_at`, then `message_id`; the store wraps to the first rows with a second bounded read when fewer follow the cursor), so the page never reads the whole table (only the shared NIP-05 directory reads every identity, at most once per 60 s plus one forced refresh per 10 s per store set, not per tick), and the cursor moves to every shop of the page before its visit, so shops that keep failing never hold the slots of the shops behind them (a shop whose reads throw or whose content is unchanged also uses a slot, for kind 0 and for kind 10002, so a lap visits every shop). A shop pass of one kind does not start while the previous pass of that kind for the same store is still in flight (the fast lane does not wait for a tick), so two ticks never work on one shop's reservation at once; a nack, or an error after the reservation, clears the shop's cache entry (a kind 0 read that throws before it leaves the entry as it was). A public shop's kind 0 has `name`/`display_name` = shop name, `about` = `shopDescription`, `picture` = photo 0 (`photo.<ext>`) and `banner` = the extra still stored at index 1 (`photo/1.<ext>`), each on its own (an unrecognized photo 0 keeps the banner; an unrecognized still 1 is not replaced by still 2), as absolute API URLs (fallback icons without a public API base; built from `MessageStore.getPhotoContentTypes`, so the worker's own reads in the shop kind 0 pass load no photo bytes, also for a shop whose content is unchanged, and `PostgresShopIdentityStore` reads none either; a memory boot runs no Nostr worker, so the in-memory shop store is never on this path), `website` = `PUBLIC_BASE_URL` without trailing slash (or `https://21.gifts`) + `/{npub}`, `nip05` from the shared directory `nip05Directory` when `nip05Domain` is set (the same names as `nostr.json` and `GET /shops/:npub`; read only once a visited shop is public and computed at most once per `NIP05_DIRECTORY_TTL_MS` (60 s) on expiry, whatever the number of shops; each shop reads its note fresh, so when the directory has no entry for a public shop or one whose `name` differs from the note's public name, the shop asks for a forced refresh before any write, which computes at most once per `NIP05_DIRECTORY_REFRESH_MS` (10 s) per store set and otherwise gives the cached directory; when the entry still does not match, that shop gets no kind 0, no cache entry and no `renameIfListed`, the tick logs `nostr.profile.nack` with `reason: 'nip05_stale'` and the shop is tried again on its next turn; after the last read of the build (directory, rename, till account, photo types) a public shop's note is read again right before the reservation, and when its `shopListingFingerprint` differs from the first read (a rename, text or pin change or staff hide during the build) the shop gets no kind 0 and no cache entry, the tick logs `nostr.profile.nack` with `reason: 'note_changed'` and the next turn publishes the new state; when a directory read throws, the tick logs `nostr.profile.nack` with `reason: 'nip05'`, publishes no further shop kind 0 in that tick (shops already published in that tick keep theirs) and goes on with kind 10002, kind 1 and conversations), and `lud16` = the till account's receiving address (`receivingAddress`) when that account has a name, a non-blank username and a verified wallet with the LNURL server configured (the `payUsername` rule of `GET /shops/:npub` plus a name, so a till account without a username gives no `lud16`). It also rewrites `profile_name` through `renameIfListed` with the note it read, so a tick holding an older snapshot than a committed rename changes nothing. A shop that is no longer public publishes `profile_name` (or `Shop` when the note is hidden or gone), `about` `This shop is no longer listed on 21.gifts.` and `website` only. Logs `nostr.profile.ok|nack` and `nostr.relays.ok|nack` with `messageId`.

## Function: startNostrWorker

- **Purpose:** Two-lane handle around `runNostrWorkerTick`. The fast lane uses `setInterval(intervalMs)` (default `WORKER_INTERVAL_MS` = 2 s) to run mode `'fast'` with no in-flight guard — overlapping ticks stay safe via sign/publish leases, and a guard would couple unpaid latency to 5 s publish timeouts. Only the S1 shop key backfill and the shop kind 0 and kind 10002 passes inside a tick skip while their previous pass for the same store is still in flight. A rejecting fast tick logs `nostr.worker.tick.failed`. The ingest lane starts one mode `'ingest'` pass immediately on call (before the handle returns); when that pass settles (success or failure) and the handle was not stopped, it schedules the next with `setTimeout(ingestIntervalMs)` (default `WORKER_INGEST_INTERVAL_MS` = 30 s). At most one ingest pass is ever in flight. A rejecting ingest pass logs `nostr.worker.ingest.failed` and still reschedules. `stop()` clears the fast interval, clears a pending ingest timeout, and marks the handle stopped so an in-flight ingest pass that settles later does not schedule another one.
- **Inputs:** deps; optional `intervalMs` (fast lane); optional `ingestIntervalMs` (pause after an ingest pass settles).
- **Returns / side effects:** `{ stop }`; schedules both lanes; may log `nostr.worker.tick.failed` / `nostr.worker.ingest.failed`.
- **Used by:** Process entry `src/index.ts` when KEK + message store present (passes `WORKER_INTERVAL_MS` as `intervalMs`; ingest default applies).

## Function: buildZapRequest

- **Purpose:** Unsigned kind:9734 for a forum event.
- **Inputs:** recipient pubkey, event id, amountMsat, relays, optional `content` (NIP-57 comment, default empty).
- **Returns / side effects:** EventTemplate.
- **Used by:** `POST /messages/:id/invoice`, `POST /messages/:id/repayment` and `POST /messages/:id/repayment/due`.

## Function: serializeZapRequest

- **Purpose:** Serialise a signed kind:9734 with the NIP-01 field order `id, pubkey, created_at, kind, tags, content, sig`, so the LNURL `nostr=` value and the `description_hash` check use the same string.
- **Inputs:** Signed zap-request event.
- **Returns / side effects:** Compact JSON string with exactly those seven keys in that order; any other property on the event is dropped.
- **Used by:** `POST /messages/:id/invoice`, `POST /conversations/:id/invoice`, `POST /messages/:id/repayment` and `POST /messages/:id/repayment/due`, the Spark invoice worker.

## Function: manualReceiptIdForPaymentHash

- **Purpose:** Derive the synthetic kind:9735 event id used for an operator manual settlement.
- **Inputs:** Payment-hash text; case is ignored by lowercasing before hashing.
- **Returns / side effects:** Lowercase 64-hex `sha256('21gifts-manual-settle:' + paymentHash.toLowerCase())`; no writes.
- **Used by:** `settleInvoiceManually` and relay ingest's later-receipt double-count guard.

## Function: settleInvoiceManually

- **Purpose:** Settle a successful forum invoice by payment hash after its LNURL provider failed to publish a kind:9735 receipt. The required trimmed `note` (1–8000 characters, no C0/DEL controls) is durable operator evidence. `DEBUG_TOKEN` is the route authority; an optional preimage adds cryptographic evidence only when it is 32-byte hex and hashes to the payment hash. It is intentionally optional because some wallet-internal payments expose a wallet “preimage” that does not match the invoice hash.
- **Inputs:** `{ store, auth, now, paymentHash, note, preimage?, pushStore?, notificationStore?, spendPing?, postLimiter?, fundingStore?, conversations?, lnurlServer?, fetchImpl?, fiatRates? }`. `lnurlServer` gives the spend ping its receiving address, `receivingAddress(payer, lnurlServer)`; without it, or for a payer without a verified wallet, a compose post sends no spend ping.
- **Checks:** Normalises the payment hash, validates the note and optional preimage, requires an `ok` invoice with positive whole sats and non-empty BOLT11, rejects conversation invoices and missing/hidden messages, loads the note author (`auth.getAccount(message.accountId)`) **before** claiming, checks historical indexed ingests, and claims the lowercase payment hash through `claimZapPayment`. A thrown author lookup propagates (no claim, no receipt, no ingest). A claim owned by another receipt is `duplicate`.
- **Returns / side effects:** On a fresh success returns `{ ok: true, receiptId, messageId, amountSats, resumed: false }`. A `repay:` invoice is stored as a paid share and does not credit the ask. Any other invoice credits via `recordZapReceipt`. Both write an indexed synthetic 9735 ingest directly through `store.recordZapIngest`. If the synthetic receipt was already credited but its indexed ingest is missing, the current request's note/preimage rebuilds that ingest without another credit, notification and gift-reply processing run, and the result has `resumed: true`. An already complete settle returns `duplicate`.
- **Durability / errors:** The payment-hash claim is a durable tombstone that protects against a second credit even if a prior ingest write failed or the forum message was later deleted. Claim, lookup, credit, and direct ingest-write failures propagate (the route maps them to 503); the decision memory is updated only after the ingest write succeeds. The claim and credit are not one transaction, but the payment-hash primary key serialises competing receipt ids.
- **Post-credit effects:** On a member note, fans out `notifyZap` and attempts the payer gift-reply from the original zap request, except a heart invoice (`heart === true`): sats are still credited, `notifyZap` and the gift-reply are skipped, and `notifyHeart` notifies only the note author. On the platform profile note, skips `notifyZap` and treats the zap comment as a compose post/reply (`sats` 0) gated by `forum.post` and optional `postLimiter`; a created top-level post fans out `notifyForumPost` and `spendPing` only when the payout gate passes (`loadPayoutEligibility`, same gate as `POST /messages`; ineligible, including no recovery share, logs `spend.ping.skipped` / `not_eligible`), a reply fans out `notifyForumReply`. Missing `forum.post` fields or a limiter denial dequeue the receipt without creating a row. A throwing **payer** `auth.getAccount` after credit is logged as `nostr.zap.gift_reply.failed`, omits payer fields from the notification, skips the gift-reply, and still returns success. A throwing **note-author** `auth.getAccount` happens before claim and fails the settle. Notification, spend-ping, and gift-reply failures are likewise logged and suppressed. Logs and responses never contain the note or preimage.
- **Resume on a hidden note:** A fresh settle refuses a missing or hidden note. A retry that finds its synthetic receipt already credited is a resume: it completes the missing `indexed` ingest row even when staff hid the note in the meantime, and in that case skips `notifyZap` and the gift-reply.
- **Used by:** `POST /debug/invoices/settle` after `DEBUG_TOKEN` authentication.

## Function: indexZapReceipt

- **Purpose:** Validate provider pubkey (case-insensitive hex) and add sats once per receipt id. Callers verify the Nostr signature first. Persists a `nostr_zap_ingest` row (`indexed`, or `rejected` with reason `pubkey` / `amount` / `duplicate`); store throw logs `nostr.zap.ingest.record_failed` and does not change the boolean result.
- **Ingest dedupe:** One `nostr_zap_ingest` row is written per receipt per decision change per process (memory is per store instance and empty after a restart, so the first ingest pass after boot may write one `rejected`/`duplicate` row per receipt that pass still queries (`listLatest` plus non-null `listReplies` children of those rows, plus the newest MESSAGE_LIST_LIMIT live replies that have an event id (`listRecentReplies`) even when their parent is not in `listLatest`, unioned with the official platform profile note's `eventId` even after it ages out of `listLatest`)). A repeated identical `outcome:reason` is normally not written again, because the memory is consulted before the write; that is not a guarantee, since the memory is set only after the write resolves, fast-lane ticks are not serialised, and a failed write leaves it untouched. Receipts whose remembered decision is already terminal never reach this function: `indexOpenZapReceipts` skips note lookup, account/LNURL validation, and ingest persist, but still runs `verifyReceipt` then `tryEnsureGiftReply`.
- **Inputs:** store, messageId, receipt, providerPubkey, amountSats; optional receiptEvent / noteEventId for debug rows.
- **Returns / side effects:** boolean; logs indexed/rejected; records ingest.
- **Used by:** `indexOpenZapReceipts` (worker tick).

## Function: indexOpenZapReceipts

- **Purpose:** On the full (non-hot) pass — used by mode `'all'` and the ingest lane — query zap relays for kind:9735 on recent notes (chunks of 20 event ids from `listLatest` plus non-null `listReplies` children of those rows, plus the newest MESSAGE_LIST_LIMIT live replies that have an event id (`listRecentReplies`) even when their parent is not in `listLatest`) unioned with the official platform profile note's `eventId` (via `auth.listAccounts` `isPlatform` + `profileMessageId`, even after that row ages out of `listLatest`) and with e-tags from `listOpenConversationZapEventIds` (ok invoices with a conversation id and a conversation message id). When `conversations` is set, skip each open-conversation pair whose `getMessageById(conversationMessageId)` hits, then add the remaining distinct e-tags, so a second unpaid gift that shares an e-tag is still queried. This query-side skip applies only when that e-tag is not already in the forum list from `listLatest`: a PN e-tag is the recipient's profile note, itself a top-level forum note, so while that note is among the latest notes the e-tag stays in the relay query through the forum list, and `listOpenConversationZapEventIds` supplies it otherwise. Optional `since` (Unix seconds), when provided, is added to every kind:9735 receipt filter; the key stays absent when undefined so existing filter assertions stay exact. Then verify the Nostr signature, validate provider pubkey via LNURL (module TTL cache, lowercased), bolt11 amount, e-tag, and index via `indexZapReceipt` unless the payment hash matches a conversation invoice. Before the author-provider check, `settleRepaymentReceipt` handles an ok invoice whose description is `repay:<day>:<accountId>` for this note: the giver's provider must sign the receipt, `markRepaymentPaid` stores the share, `addSats` is not called, and a success logs `nostr.zap.repaid`. A repay invoice for another note or a different sat amount is rejected and does not credit the ask. A receipt that is not that invoice continues. Before provider lookup, a forum payment hash already represented by `manualReceiptIdForPaymentHash` is persisted as `rejected`/`settled`, so a late real receipt cannot add sats twice. A conversation invoice appends the predetermined `conversation_message` row (gift-only `nostrPublishState` `skipped`) and does not `addSats`, insert a forum gift-reply, or `notifyZap`. After address/provider/pubkey checks and before `claimZapPayment`, an existing PN gift is persisted `indexed` without claim/append/`nostr.zap.rejected`. Without `conversations`, that receipt is `rejected`/`conversation`. A thrown payment-hash lookup is treated as not a PN invoice so forum ingest still runs. Persists an ingest decision (`indexed` / `rejected` with reason) when it differs from the last remembered decision for that receipt on this store instance; that skip is not a guarantee, because the memory is set only after the write resolves, fast-lane ticks are not serialised, and a failed write leaves it untouched. One throwing receipt does not skip the rest of the pass. A newly indexed **member-note** forum receipt calls `notifyZap` with `auth` (in-app every account except the payer (no-op when the payer is the official platform account), then filtered by each account's `notificationLevel`; Web Push only to bell subscribers, same filter; `push.enqueue.failed` on throw, ingest continues), except a heart invoice (`heart === true`): sats are still credited, `notifyZap` and the gift-reply are skipped, and `notifyHeart` notifies only the note author. A thrown `findOkInvoiceByPaymentHash` is retried once; a second throw keeps the credit and treats the receipt as a gift (not a heart), the same as `tryEnsureGiftReply` does: `notifyZap` runs as for any member-note gift, `notifyHeart` does not, and `tryEnsureGiftReply` still runs. After parent `sats` are committed, ingest inserts a payer gift-reply (invoice `payment_hash`/`pr` first, else verified 9734 pubkey) only when the paid message is a top-level member note (`parentId` null) that is not the official platform profile note. A member/invoice zap (`payerAccountId`) on that platform note is a compose fee (payer post/reply, `sats` 0) gated by `forum.post` and optional `postLimiter`; it skips `notifyZap` and fans out `notifyForumPost` / `notifyForumReply` plus a top-level `spendPing` only when `eligibleToday` (same gate as `POST /messages`; ineligible logs `spend.ping.skipped` / `not_eligible`). An external zap (`payerPubkey`) on that same note still inserts `insertExternalGiftReply` (gift-reply under the profile note, paid sats, no `notifyForumPost`). A zap on a signed reply credits that reply via `recordZapReceipt` onto `received_*` (`sats` and sent fiat stay unchanged) and does not create a nested gift-reply. Ingest sets that receipt's `payerAccountId` to null so it never occupies `listZapReceiptsAwaitingGiftReply`, even before retry; retry still drops any already-queued reply receipts. A member-note gift-reply insert does not call `notifyForumReply`. An invoice match whose payer account is missing does not fall through to 9734. Gift-only replies are `nostrPublishState` `skipped`. Gift-reply `id` is deterministic per receipt. Lookup/create failures log `nostr.zap.gift_reply.failed` and do not persist ingest `rejected`. Receipts with a payer and no `gift_reply_id` are retried on each full pass using the stored comment; deleted parents, missing payers, and paid messages that are themselves replies are dropped from that queue.
- **Hot mode:** When `eventIds` is set, skip the whole note/conversation enumeration (`listLatest`, `listAccounts` platform profile note, `listOpenConversationZapEventIds`, `listReplies`). Deduplicate the given ids, dropping empty strings and keeping first-seen order. Empty `urls` or no remaining ids return immediately. Otherwise query in chunks of 20 with the same kind:9735 filter plus optional `since`, run the same per-receipt ingest and catch/persist path, and **do not** call `retryGiftReplies` (the worker ingest lane does that on the full pass).
- **Payer resolution:** `resolveZapPayer` returns `{ kind: 'account', payer, text }`, `{ kind: 'external', pubkey, requestId, text }`, or `undefined`. It prefers an ok invoice matched by payment hash and then BOLT11, and a matched invoice with a missing account does not fall through. A signed embedded request that maps to an account stays on the account path; only an unowned request passing `verifiedExternalZapRequest`'s signature, exact description-hash, target-event, and optional amount checks enters the external path.
- **External attribution:** The first verified external zap of at least one sat for a pubkey in this process calls `recordZapper`; a per-store lowercase-pubkey memo skips that durable write on later zaps while still running `attributeZapReceipt` and the remaining gift flow. Attribution happens before the block check, so entitlement and attribution are retained even when the payer is blocked. A blocked payer is durably dequeued by clearing `payerPubkey` while retaining `zapRequestId`, and the helper returns `{ attributed: true, gift: false }`; sats stay credited, no row is shown, and a later unblock does not resurrect the zap. This successful-attribution return keeps `backfillExternalZappers` paging past the row. Attribution returns `true` for a retry of the same request id on the same receipt, but `false` for a different request id on an already-attributed receipt, for the same request id already attached to another receipt, or for a missing receipt; only a successful, unblocked attribution can create the deterministic external gift-reply.
- **Terminal external outcomes:** Replayed request ids and credited receipts below the external minimum enter a process-local `WeakMap<MessageStore, Set<string>>` receipt-id memo. `tryEnsureGiftReply` checks it before the receipt lookup, invoice decode, or embedded kind:9734 verification, so later ticks make no repeated store write (including `recordZapper`). Each store's insertion-ordered set evicts its oldest id above 10,000; the memo is empty after restart. Blocked receipts instead use their durable `payerPubkey: null` plus non-null `zapRequestId` terminal guard.
- **Gift-reply retries:** `listZapReceiptsAwaitingGiftReply` retries both account (`payerAccountId`) and external (`payerPubkey`) receipts with no `giftReplyId`; missing/hidden/reply parents and missing or blocked payers are dequeued by clearing the applicable payer field. Separately, Postgres boot pages indexed-but-unattributed receipts from `listUnattributedIndexedReceipts` into `backfillExternalZappers`, up to 10,000 rows per boot; strict verified external requests are attributed and retried there, while account-owned requests remain on the member path. For an external payer, `insertExternalGiftReply` re-checks `isPubkeyBlocked` immediately before `store.create` — after `listAccounts()` and the profile-name lookup — on the live path, the retry queue and the boot backfill; a block added in that window dequeues the receipt (`payerPubkey: null`) without a row while the sats stay credited.
- **Payment-hash claim:** Before a validated forum or conversation receipt is credited, the tick claims its bolt11 payment hash with `claimZapPayment`. A conversation receipt whose PN gift row already exists is instead persisted as `indexed` before the claim, so a second receipt event for that PN payment is `indexed`, not `rejected` / `settled`. Otherwise, a hash already owned by another receipt id (a second receipt event for the same payment, or an operator settle) is persisted as `rejected` / `settled` and adds no sats, no gift-reply and no notification. A forum receipt claims only after the provider-pubkey check, so a foreign receipt cannot block the provider's real one. The same receipt id may re-claim its hash, which lets a tick that failed after the claim continue.
- **Terminal skip:** Remembered `indexed` and `rejected`/`duplicate` skip note lookup, account/LNURL validation, and ingest persist. This is the branch that still runs `verifyReceipt` (default `verifyEvent`), excludes a matching conversation invoice, and calls `tryEnsureGiftReply`. There, blocked receipts stop on the durable cleared-payer guard, while replayed and below-minimum external receipts stop on the bounded process-local memo before their embedded kind:9734 is re-verified. Other remembered decisions (for example `rejected`/`address` or `rejected`/`error`) keep the full path so a receipt can still transition later. `rejected`/`error` is not a terminal skip.
- **Inputs:** store, auth, querier, urls, timeoutMs, now, fetchImpl; optional `eventIds` / `since` (hot mode); optional `verifyReceipt` (default: nostr-tools `verifyEvent`); optional `pushStore`; optional `notificationStore`; optional `conversations` (PN append; omitted → conversation invoices `rejected`/`conversation`); optional `spendPing` (top-level platform compose, only when `eligibleToday`); optional `postLimiter` (platform compose); optional `fundingStore` (same `eligibleToday` gate as `POST /messages`; omitted → empty `InMemoryFundingStore`).
- **Returns / side effects:** void; logs `nostr.zap.rejected` / `indexed`; the per-receipt catch logs `nostr.zap.rejected` with `reason: 'error'` plus the `errorLogFields` allowlist (`name`: ASCII letters, `code` / `errno`: ASCII alphanumerics and underscore, each 1–40 characters) and never the message text; a failure outside that catch (store list, relay query) reaches `nostr.worker.tick.failed` or `nostr.worker.ingest.failed`, which log the same allowlist; records ingest rows; may append a conversation message, create a forum reply, and fan out `notifyZap` in-app on a **member-note** receipt to every account except skip (no-op when the payer is the official platform account), then filtered by each account's `notificationLevel` (Web Push to bell subscribers, same filter), except a heart invoice which credits sats, skips `notifyZap` and the gift-reply, and calls `notifyHeart`; a member/invoice platform-note compose fee skips `notifyZap` and fans out `notifyForumPost` / `notifyForumReply` plus a top-level `spendPing` only when `eligibleToday` (same gate as `POST /messages`; ineligible logs `spend.ping.skipped` / `not_eligible`); an external zap on that note stays `insertExternalGiftReply`; never logs full bolt11. Memory is per store instance and empty after a restart, so the first full ingest pass after boot may write one `rejected`/`duplicate` row per receipt that pass still queries (`listLatest` plus non-null `listReplies` children of those rows, plus the newest MESSAGE_LIST_LIMIT live replies that have an event id (`listRecentReplies`) even when their parent is not in `listLatest`, unioned with the official platform profile note's `eventId` even after it ages out of `listLatest`).
- **Used by:** `runNostrWorkerTick` (modes `'all'`, `'fast'` hot path, and `'ingest'`).
- **Wallet-backed recipients:** With optional `lnurlServer`, the forum author's and the repayment giver's address come from `receivingAddress`, and every provider-pubkey lookup goes through `lnurlServerFetch`, so `<username>@<host>` (also when stored on a conversation invoice) is resolved against the LNURL server internally. One receipt can be fed directly through `ingestZapReceipt`.

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
- **Used by:** `POST /messages/:id/invoice`, `POST /messages/:id/repayment` and `POST /messages/:id/repayment/due`, `POST /conversations/:id/invoice`.

## Function: unsignedNostrDefaults

- **Purpose:** Unsigned/pending defaults for a new forum row.
- **Inputs:** none.
- **Returns / side effects:** Column defaults including `sats: 0`, `goalSats: null`, `goalRepayable: null`, `goalTermDays: null`, `parentId: null`, `authorPubkey: null`, plus unsigned/pending Nostr columns (`eventId` / `nostrEvent` / `claimedUntil` / `nostrFirstAttemptAt` / `nostrPublishEpoch` null, `nostrPublishState: 'pending'`, `nostrAttempts: 0`).
- **Used by:** `POST /messages`, stores.

## Function: allocateNip05Local

- **Purpose:** Unique NIP-05 local-part; first slug wins, collisions append account-id hex (a shop passes its message id).
- **Inputs:** name, account id (or shop message id), taken set.
- **Returns / side effects:** local-part string.
- **Used by:** `nip05Identifier`, `listNip05Entries`, `listShopNip05Entries` (shop locals, seeded with the account locals), `backfillAccountUsernames`, `debugRoutes` through `provisionUsername` (`POST /` provisioning).

## Function: buildNostrJson

- **Purpose:** NIP-05 `names` + `relays` map for `GET /.well-known/nostr.json`, with account locals allocated before listed-shop locals. With shops it reads the shared directory (`nip05Directory`, cached 60 s per store set, the same names as `GET /shops/:npub` and the shop kind 0), whose one computation reads every account once and passes that one snapshot to `listNip05Entries` and `listShopNip05Entries`, so a username change or merge between two reads cannot give a shop the local part of an account in the same body. A `?name=` that the cached directory does not hold forces one fresh directory (at most one computation per 10 s per store set; inside that gap the cached one answers), so a new username or shop is found without waiting for the TTL. A `?name=` that the cached directory gives a shop while `auth.getAccountByUsername` finds an account with that username forces the same refresh, since accounts win and the cached shop entry is stale. With shops a `?name=` reads only the directory's lookup maps by local part (`accountsByLocal`, `shopsByLocal`) for the hold check, the account-claim check and the answer, so its cost does not grow with the number of accounts or shops; the full body walks the cached entries without copying them. Without shops (accounts only) every call reads every account itself.
- **Inputs:** auth store, env, optional name filter, optional `{ identities, messages }` (shop identities and the forum store), optional clock reading in epoch milliseconds for the cache (default `Date.now()`).
- **Returns / side effects:** JSON body; with shops the full body may be up to 60 s old (`NIP05_DIRECTORY_TTL_MS`, the `max-age=60` the route already sends). With shops, the locals of `listShopNip05Entries` follow the account locals of `listNip05Entries`; `?name=` filters both kinds. Account entries are written first and a shop entry never overwrites one: a shop whose local an account already holds is skipped and logged as `nip05.shop.collision` with its `messageId` (defensive; the shared snapshot already prevents it). Reads only.
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
- **Inputs:** auth store, optional snapshot of every account. Without the snapshot it reads the accounts once with `auth.listAccounts()`; `nip05Directory` passes the snapshot it also gives `listShopNip05Entries`.
- **Returns / side effects:** `Nip05Entry[]`. Reads only (the accounts unless given, and one pubkey read per eligible account).
- **Used by:** `nip05Directory` (the cached directory of `buildNostrJson` with shops) and `buildNostrJson` without shops.

## Function: normalizeIsoBmffDisplayMatrix

- **Purpose:** Put a 90°, 180°, or 270° picture back inside the video frame. Some phone files rotate the track and leave the translation at zero, so players draw every pixel outside the element and the picture stays black. An already-correct matrix, a non-video track, or a translation that does not fit in a signed 32-bit field is left untouched.
- **Inputs:** ISO-BMFF bytes. The buffer is not modified.
- **Returns / side effects:** A new copy with the `tkhd` translation and display size corrected, or the same `bytes` reference when nothing changes. No I/O.
- **Used by:** `decodeForumVideo`; `readForumVideoBytes`.

## Function: nip05Domain

- **Purpose:** Hostname from `PUBLIC_BASE_URL`; null for loopback/IP.
- **Inputs:** env.
- **Returns / side effects:** hostname or null.
- **Used by:** account kind 0 `nip05` (worker `publishProfiles`), shop kind 0 `nip05` (`publishShopProfiles`), `shopRoutes` (`nip05` of `GET /shops/:npub`).

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

- **Purpose:** Hono `GET /nostr.json` (NIP-05, CORS `*`) and `GET /lnurlp/:username` (LUD-16 payRequest). A member receives only on their verified in-app wallet, so only the wallet-backed branch serves a pay request; there is no pass-through to another provider. While an unexpired pending point-of-sale charge exists, both `minSendable` and `maxSendable` become that amount in millisats. `GET /lnurlp/:username` is `Cache-Control: no-store`; `GET /nostr.json` keeps `Cache-Control: public, max-age=60`. When `lnurlServer` is set and the account has a verified wallet key, a wallet-backed branch uses `callLnurlServer` and `walletPayRequest` to serve the pay request.
- **Inputs:** auth store, env, optional fetchImpl (default `globalThis.fetch`; used for the LNURL server), optional posStore (default empty in-memory store), optional now (default `Date.now`; pending charges and the clock of the shared NIP-05 directory cache), optional `shops` (`{ identities, messages }`; public shops join `nostr.json` after the accounts, read from `nip05Directory`). Optional `lnurlServer` (`LnurlServerConfig`, omitted when the feature is off) enables the wallet-backed branch.
- **Returns / side effects:** Hono app mounted at `/.well-known`. LNURL-pay 404 when the username is invalid or unknown, the account has no verified wallet, or `lnurlServer` is omitted; 502 when the store throws. A wallet-backed upstream 404 returns 404, an over-limit request returns 429, and an unreachable LNURL server or invalid document returns 503.
- **Shop payment:** With optional `shopPayments`, the wallet-backed branch hands the resolved pay request's `metadata`, the query (`timeout`, `method`, `asset`, repeated `quote`/`method`/`asset`), and the fetch's arrival (`now()` taken as the handler's first statement, before the wallet's pay request resolves) to `ShopPayments.payLink`: a full response (the OpenCryptoPay pay request, the simplified-flow detail, or the 404 `noPendingPaymentBody`) is returned as is; otherwise today's pay request is returned, pinned to the charge amount when `payLink` says so. Without it the pin comes from `currentPending`. Every error body on `GET /lnurlp/:username` is `shopErrorBody`.
- **Used by:** `createApp`.

## Function: lnurlServerRoutes

- **Purpose:** Forwarded LNURL routes mounted at `/` only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve: `POST /lnurlpay/:pubkey` (register; marks verified on upstream 2xx; body forwarded as parsed JSON re-serialised; `body.username` must consist only of printable ASCII characters, otherwise the gate returns 404 and the LNURL server is not contacted; another key that equals `username` after NFKC normalisation and lower-casing (for example `Username`) fails the gate; 409 when upstream accepted but the account is not verified on that key afterwards), `POST /lnurlpay/:pubkey/transfer` (social recovery address claim; see below), `POST /lnurlpay/:pubkey/recover` (raw body; a pending social recovery's new key also passes the gate, and a forwarded recovery is settled after the answer), `GET /lnurlpay/:pubkey/metadata`, `GET /lnurlp/:username/invoice`, `GET /verify/:paymentHash` (LUD-21). Each route has an `IpRateLimiter`. A `HEAD` request is answered 404 and the LNURL server is not contacted. A request without a validated `cf-connecting-ip` is not counted by the per-address limits. Store gates refuse with 404 before contacting upstream (except verify). Path segments are only `A-Z a-z 0-9 . _ ~ -`, never `.` or `..`; a refused segment is 404 without an unreachable log. Registration acceptance is the proof of the key; only an account's own wallet can take that account's username. Body cap 1 MB (1 048 576 bytes); a larger body gets 413 `{ error: 'Request body is too large' }` and the upstream is not contacted.
- **Social recovery:** `POST /lnurlpay/:pubkey/transfer` (path key = the new wallet key, own `IpRateLimiter(30)`) reads the Breez SDK body `{ username, description, from_pubkey, from_signature, to_signature, timestamp }` and answers 404 `Not found` without forwarding unless: the body is one JSON object; no other key NFKC-lowercases to one of those six fields; `username` is printable ASCII and normalizes; `description` is a string of at most 255 code points; `from_pubkey` normalizes; both signatures are strings; `timestamp` is a safe non-negative integer within 600 s of the clock (`LNURL_SIGNED_MESSAGE_VALIDITY_SECS`); both DER signatures verify for the domain `config.host` lowercased (`lnurlTransferFromMessage` by the old key, `lnurlTransferToMessage` by the new key, `verifyLnurlDerSignature`); and `markRecoveryForwarded` admits it (an unforwarded, unexpired pending recovery with that new key and old key, on an account that still holds the old key verified, is not session-refused, and has that username), which marks it forwarded in the same step (log `account.recovery.forwarded`). The body is forwarded re-serialized. Upstream 2xx runs `commitRecovery`: committed logs `account.recovery.committed` (`via: 'claim'`) and passes the answer through; otherwise (the forwarded pending recovery is already gone, or the account no longer holds the old key verified, and then the commit deletes the pending recovery) logs `account.recovery.unconfirmed` and answers 409 `Wallet registration could not be confirmed`; no account changes, and no pending recovery remains to settle. Upstream 4xx passes through, 5xx or unreachable is 503, a store throw logs `lnurl_server.failed` (`route: 'transfer'`) and is 503. After an upstream 4xx, 5xx or timeout, and after a store throw in the commit, the pending recovery stays forwarded and the account unchanged. A store throw at admission (`markRecoveryForwarded`) leaves the pending recovery unforwarded and contacts no upstream. On `POST /lnurlpay/:pubkey/recover`, a key that no account claims still passes when it is the new key of an unexpired pending recovery; after the upstream answer `settleAfterLookup` runs with the send time, and the answer to the wallet is unchanged.
- **Inputs:** `LnurlServerRouteDeps` (`auth`, `config`, `fetchImpl`, `now`, `posStore`). On `GET /lnurlp/:username/invoice` the account's open point-of-sale charge is read before the upstream call; after an upstream 2xx, a `pr` that decodes to exactly that charge's millisat amount is recorded against it with the pre-mint issue time (`recordInvoice`), so an invoice never lands on a charge opened during the mint. When `recordInvoice` returns `other_payment` (another charge or shop payment holds the hash), the route logs `shop.alert.duplicate_invoice` (`duplicateInvoiceLogFields`: `chargeId`, `holderChargeId`, and `paymentId` only when a shop payment holds it) and answers 503 `{ error: 'Lightning address service is unavailable' }` instead of the upstream body, so that BOLT11 is not handed out; every other outcome forwards it. A store failure logs `pos.invoice.record_failed` and the invoice is still returned unchanged.
- **Returns / side effects:** Hono app. Over limit → 429; refused segment → 404; unreachable, store throw, or an unexpected upstream status → 503 `{ error: 'Lightning address service is unavailable' }` (registration: any status outside 2xx and 4xx, for example 5xx; recover / metadata / invoice / verify: any status other than 2xx and 404, so other 4xx and 5xx). Upstream 2xx passed through with its status, body and only the `content-type` / `cache-control` headers (a 204 stays a 204); upstream 404 → 404 (registration passes 4xx body/status through without verifying). Registration or an address transfer that is not confirmed on the account → 409 `{ error: 'Wallet registration could not be confirmed' }`. Logs `account.wallet.verified`, `account.wallet.unconfirmed`, `account.recovery.forwarded`, `account.recovery.committed`, `account.recovery.unconfirmed`, `lnurl_server.failed`, `lnurl_server.unreachable` without query/body/signature fields.
- **Shop payment:** With optional `shopPayments`, also registers, after the invoice forward, `GET /lnurlp/cb/:username` (`ShopPayments.callback`), `GET /lnurlp/tx/:username` (`handleShopProof`), and `GET /lnurlp/wait/:payment` (`ShopPayments.wait`, hold limit `waitTimeoutMs`, default `WAIT_SATS_TIMEOUT_MS`), each with its own 120/min `IpRateLimiter`. The callback and proof gate on a normalised username that is not `invoice` with a verified wallet (404 `Not found`); the callback answers 503 and the wait route 429 `Too many requests` over the limit; the proof route hands the over-limit flag to `handleShopProof`. A store or service throw logs `lnurl_server.failed` with `route` (`callback`, `proof`, `wait`) and `errorLogFields`, and answers 503 `Payment is being confirmed` on the proof route and 503 `Lightning address service is unavailable` on the other two. A `HEAD` request is 404. All bodies are `shopResponse` / `shopError`.
- **Used by:** `createApp` when the LNURL server config resolves.

## Function: lnurlRoutes

- **Purpose:** Hono sub-app for `POST /pay-request` and `POST /invoice`, mounted at `/lnurl`. Both need a Bearer session and share one `LnurlRelayRateLimiter` instance per app. The own host is the hostname of `PUBLIC_BASE_URL` without a trailing dot (none when unset or not a URL).
- **Inputs:** `{ auth: AuthStore, fetchImpl: FetchFn, now: () => number, env, lookupImpl? }`. `createApp` passes its store, the shared fetch, its clock, and its env; `lookupImpl` is omitted there so the system resolver is used.
- **Returns / side effects:** Hono app. Logs `lnurl.pay_request.ok` (domain), `lnurl.pay_request.failed`, `lnurl.invoice.ok` (amount), and `lnurl.invoice.failed` (reason and status). Never logs the target, its query string, the comment, or the invoice.
- **Used by:** `createApp`.

## Function: resolveRelayPayRequest

- **Purpose:** Normalises a Lightning Address or bech32 LNURL, checks the URL as input (`https`, a DNS name of at most 253 characters with two or more labels, no address literal, no `localhost` / `.local` / `.internal` / `.localhost`, no port other than the default 443, no user name or password, not the own host, a name that is not only dots), requires every resolved address of the host (and of the callback host) to pass `isPublicIp` and, for IPv6, to lie in `2000::/3` or `64:ff9b::/96` and not in `2001::/23`, fetches it without redirects within 5 s and 64 KB, and validates the LNURL pay request.
- **Inputs:** `{ target, fetchImpl, ownHost, timeoutMs?, totalMs?, lookupImpl? }`. `timeoutMs` defaults to 5000 and is the longest wait for each host lookup and each fetch, cut to the time left before `totalMs` (default 8000) for the whole call (an answer that comes too late gives 502; the system resolver may still finish in the background); `lookupImpl` defaults to the system resolver (`dns.lookup` with `all`).
- **Returns / side effects:** `{ ok: true, payRequest }` with `target`, `minSendableMsat`, `maxSendableMsat`, `commentAllowed`, `description`, `domain`, or `{ ok: false, status: 400 | 404 | 502, error, reason }`. One outbound GET at most.
- **Used by:** `POST /lnurl/pay-request`.

## Function: requestRelayInvoice

- **Purpose:** Resolves the target like `resolveRelayPayRequest`, refuses a non-whole amount and a comment that is over 2000 UTF-16 code units or not well-formed Unicode before any outbound request, then checks the amount against the bounds and the comment against `commentAllowed` characters, calls the callback with `amount` and an optional `comment`, and checks that the BOLT11 amount equals the request and its description hash equals SHA-256 of the metadata.
- **Inputs:** `{ target, amountMsat, comment?, fetchImpl, ownHost, timeoutMs?, totalMs?, lookupImpl? }`.
- **Returns / side effects:** `{ ok: true, pr }` or `{ ok: false, status, error, reason }` (`Amount out of range`, `Comment too long`, or the pay-request errors). Two outbound GETs at most.
- **Used by:** `POST /lnurl/invoice`.

## Function: LnurlRelayRateLimiter

- **Purpose:** In-process per-member cap for the relay routes: 30 requests per sliding minute. Members with no request in the last minute are dropped from the map.
- **Inputs:** `allow(accountId, nowMs)`.
- **Returns / side effects:** `true` and records the hit, or `false` without recording. Single process only.
- **Used by:** `lnurlRoutes`.

## Function: payRoutes

- **Purpose:** Hono sub-app for the public pay link: `GET /charges/:id` and `GET /:username/charges/:id` (both `serializePosCharge`, nothing secret, including a paid charge; 404 when missing), `GET /:username` (name, username, minSats, maxSats, and charge), and `POST /:username/invoice` (one BOLT11 via `requestGiftInvoice`; rejects any other amount while a charge is open). The two receipt reads are registered before `/:username`. `charge` is `null`, or `{ id, amountSats, expiresAt }` plus the six fiat fields when an unexpired pending point-of-sale charge exists; then both sat bounds are that amount. A sats-only charge carries the six fiat fields as null. Mounted at `/pay`. No auth and no extra CORS headers.
- **Inputs:** `{ auth: AuthStore, fetchImpl: FetchFn, posStore: PosStore, now: () => number, lnurlServer?, freePayments?, randomBytes? }`. The first four are required; there is no default store and no default clock inside `payRoutes`. `createApp` passes the same `posStore` and `now` already used by `/.well-known` and `/pos`, the shared LNURL-pay fetch as `fetchImpl`, and `freePayments: true` when free in-app payments are on (the same condition that issues Spark invoices for gifts). `randomBytes` defaults to `crypto.getRandomValues`.
- **Returns / side effects:** Hono app. The invoice response is `{ pr, amountSats, sparkInvoice }`. While a charge is open, the minted BOLT11's payment hash is recorded against it with the issue time taken before the mint, and with `freePayments` the charge's Spark invoice (`encodeSparkInvoice` to the shop's verified wallet key, the charge amount, memo `pos:<chargeId>`, id `uuidV7`) is issued once and returned again on later calls, and `comment` is ignored. Without an open charge and with `freePayments`, a Spark invoice for exactly the posted amount to the member's verified wallet key (id `uuidV7`) is minted after `pr` and not stored; its memo is the trimmed `comment` cut to the member's `commentAllowed` characters (missing is 0) and then to 120 UTF-8 bytes on a character boundary, and a blank, non-string, or not-allowed comment leaves the memo out. Without `freePayments` `sparkInvoice` is `null`. Logs `pay.unknown`, `pay.unreachable`, `pay.failed`, `pay.invoice_failed`, `pay.invoice`, `pos.invoice.record_failed`, and `pos.spark_invoice.issue_failed` (a store failure never fails the BOLT11 response). When `recordInvoice` returns `other_payment` for the pending charge, the invoice route logs `shop.alert.duplicate_invoice` (`duplicateInvoiceLogFields`), issues no Spark invoice, and answers 502 `Lightning Address could not be resolved` without the BOLT11. `POST /:username/payment` takes `now()` as its first statement and hands it and the request's abort signal to `ShopPayments.createForPayer`. Resolves the member with `receivingAddress`: a verified wallet (with `lnurlServer`) is resolved and invoiced through the LNURL server internally via `lnurlServerFetch`, never over the public URL; a member without a verified wallet is not found.
- **Shop payment:** `POST /:username/payment` opens a shop payment for a payer's amount: same lookup (404 / 502), body `{ amountSats }` (400 `Enter a whole number of sats` unless an integer ≥ 1), 409 `{ error: 'A payment is already open', code: 'payment_open' }` while a charge is pending, the range check (400), then `ShopPayments.offersStablecoins` (503 `stablecoin_unavailable`) and `createForPayer`: 200 `{ payment, expiresAt }`, 409 `payment_open`, 502 `Lightning Address could not be resolved` on a failed mint (logs `pay.invoice_failed`), or 503 `{ error: 'Stablecoin payment is unavailable', code: 'stablecoin_unavailable' }`; a throw from `createForPayer` (a store failure) is 502 `Lightning Address could not be resolved` and logs `pay.failed` with `errorLogFields`. Without optional `shopPayments` the lookup already answers 404.
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

- **Purpose:** Whether a caller's live role meets a minimum, including equal rank. Initiator has the same rank as moderator; founder stays strictly above. True when `roleRank(role)` is ≥ `roleRank(min)`. Every permission names a minimum role; an equality test on the caller's role is a defect. Subject rank equality uses `sameRoleRank`, not this caller check. The single permission that is not a rank check is `canEditDailyPayoutRoster`.
- **Inputs:** `role` (caller's live `AccountRole`), `min` (minimum `AccountRole` that may proceed).
- **Returns / side effects:** boolean. No I/O.
- **Used by:** `isStaffRole`, `isStaffAccount`, `isChainAccount`, `conversationRoutes`, `messagesRoutes`, `trustRoutes` (`POST /trust/appoint-moderator`), `inboxUnreadCountFor`, `isModeratorGroupMember`.

## Function: canEditDailyPayoutRoster

- **Purpose:** Whether the caller may read and edit the daily payout roster. Not a rank check: initiator and moderator share rank 2, so `roleAtLeast` cannot close the surface to moderators. True only for `initiator` and `founder`. This is the single non-rank permission; rank permissions stay on `roleAtLeast`.
- **Inputs:** `role` (caller's live `AccountRole`).
- **Returns / side effects:** boolean. No I/O.
- **Used by:** `fundingRoutes` daily-roster routes.

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
- **Inputs:** `TrustRouteDeps`: `authStore`, `trustStore`, `now`, optional `notificationStore`, `pushStore`, and `conversationStore` (appointed and propose push `unreadCount` include listed inbox unread), optional `lnurlServer` (the welcome ping's receiving address; omitted → no ping), optional `giftStore` (a recorded `welcome` gift with description `21gifts welcome` under the username at or after its wallet verification stops a second welcome ping), optional `messages` and `spendPing` (after a 200 that leaves the subject `verified`, welcome-ping a live top-level photo or video, including About me; omitted skips; a ping failure still returns 200). Optional `debugToken` and `debugReadToken`: either one as Bearer reads `GET /proposals` without a session (`isOperatorBearer`); the POSTs still need a staff session.
- **Returns / side effects:** Hono app mounted at `/trust`. 401/403/400/404/409/503 with the documented `{ error }` strings; GET `/proposals` 200 `{ proposals }` (empty list included); POST 200 `{ id, name, role }`.
- **Used by:** `createApp`.

## Function: fundingRoutes

- **Purpose:** Hono sub-app for member `POST /apply`, public `GET /places`, and staff `GET /applications`, `GET /applications/:accountId`, `POST /trial`, `POST /admit`, `POST /reject`, and `GET /payout-days`. Apply is open: `basis` is 403 `{ error: 'Forbidden' }`; `verified` and above run the About me, photo, location, and grant write and receive 400 `{ error: 'About me is required' }`, `{ error: 'About me photo is required' }`, `{ error: 'Location is required' }`, 409 `{ error: 'Conflict' }`, or 200 `{ funding }`. `POST /admit` admits only while the round (`grantRound`, default `CURRENT_GRANT_ROUND`) has a free place via `FundingStore.admitWithinPlaces`; a full round is 409 `{ error: 'All grant places are taken' }`. Public `GET /places` returns `grantPlaces` for the round. Staff list is effective pending (expired trials after `loadGrantEffective`). Trial from pending; admit from pending or trial; reject from pending or trial. Trial (from pending) and reject (from pending or trial) write through `FundingStore.transition`; admit (from pending or trial) writes only through `FundingStore.admitWithinPlaces`, which also checks the round places. 0 matching rows is 409 so a concurrent decision cannot overwrite. Staff cannot target themselves (409). UUID check reuses `MESSAGE_ID_RE`. Logs `funding.applied` / `funding.trial` / `funding.admitted` / `funding.admit.full` / `funding.places.failed` / `funding.rejected` / `funding.applications.listed` / `funding.payouts.listed` / `funding.payouts.failed`. `GET /payout-days` returns `{ days, rows }` for the last seven UTC days (staff session or operator token; daily gifts set `paid`, welcome gifts set `welcome`, moderator stipends ignored; no lazy trial expiry). Store throw → 503 `{ error: 'Funding is unavailable' }`. After a 200 on `POST /trial`, when `spendPing` is configured, ping it once with the member's receiving address (verified wallet; no wallet → no ping) and the newest live top-level photo or video (including About me) whose `createdAt` falls on today's UTC day. The ping is `spendPing.ping(address, id, 'daily', grantStatus)`, where grantStatus is the effective status of the grant just written, sent by `pingTodayMedia` with `requireShare`: from the grant gate day the member also needs a 21.gifts recovery share for the current verified wallet, else `spend.ping.skipped` `{ reason: 'not_eligible' }` and no ping. A blank address, no such post, or a post from an earlier UTC day does not ping. A thrown share read, lookup, or ping logs `funding.daily_ping.failed` and the HTTP status stays 200 (never `funding.write.failed` after the committed write). A 200 on `POST /admit` from effective pending uses that same daily ping. A 200 from an active trial does not ping. Initiator or founder `GET /daily-roster` and `POST /daily-roster/comment`, `/payments`, `/recipients`, `/recipients/update`, `/recipients/delete`, `/moderators`, `/moderators/update`, `/moderators/delete`, and `/moderators/payments` read and write the API roster store (`canEditDailyPayoutRoster`). Moderator, verified, and basis are 403. No session is 401, except that an operator `DEBUG_*_TOKEN` reads `GET /daily-roster` without one. The store is always present (no 503 for missing spend). Success 200 is the public roster JSON and nothing else. Each recipient and each moderator is a listed account with `accountId`, `amountUsd`, its `username` and `name` (null when missing or blank), and `address`, the row's edit key (`withRecipientIdentities`). Moderator rows stay out of `recipients` and are returned on `moderators` with `moderatorPaymentsEnabled`. POST /recipients and POST /moderators take `{ accountId, amountUsd }` or `{ username, amountUsd }`. accountId must match MESSAGE_ID_RE. A body without either, a non-uuid id, or a non-finite amount is 400 Invalid person or amount. An unknown account is 400 Unknown person; the wallet does not matter. A store failure on that load is 502 Daily roster is unavailable. The store receives the account id and the amount. Update and delete name the row by `username` or by `address` (the edit key); no matching account is 400 Unknown address. The spend document and worker write answers carry each row's payout address (`withPayoutAddresses`). `GET /daily-roster/links` is the operator-only link check (`linkReport`). Comment text replaces newlines with spaces, then trims; empty after trim is valid; longer than 500 is 400 `Invalid comment` and is not cut. Store 400 texts stay `Invalid comment`, `Invalid payments switch`, `Invalid address or amount`, `Address already listed`, and `Unknown address`. Any other store throw is 502 `Daily roster is unavailable`. Success 200 is only `{ comment, paymentsEnabled, defaultAmountUsd, recipients: [{ address, amountUsd, accountId, name }], moderatorPaymentsEnabled, moderators: [{ address, amountUsd, accountId, name }] }`. `defaultAmountUsd` is always 1. Spend-bearer `GET /daily-roster/document` and `POST /daily-roster/document` read and import the full document including `moderators` and `moderatorPaymentsEnabled`. Spend-bearer `POST /funding/daily-roster/worker/comment`, `POST /funding/daily-roster/worker/payments`, `POST /funding/daily-roster/worker/recipients`, `POST /funding/daily-roster/worker/recipients/update`, `POST /funding/daily-roster/worker/recipients/delete`, `POST /funding/daily-roster/worker/moderators`, `POST /funding/daily-roster/worker/moderators/update`, `POST /funding/daily-roster/worker/moderators/delete`, and `POST /funding/daily-roster/worker/moderators/payments` write that same store. Success 200 is the full stored document. Those nine posts do not log the token, a comment, or a Lightning address.
- **Inputs:** `FundingRouteDeps`: `authStore`, `fundingStore`, `messageStore`, `gifts`, `now`, optional `spendPing`, optional `grantRound` (omitted → `CURRENT_GRANT_ROUND`), optional `rosterStore` (omitted → a fresh `InMemoryDailyRosterStore`), optional `spendApiToken` (full-document routes and the nine `POST /funding/daily-roster/worker/…` routes), optional `lnurlServer` (application-detail notes are `payable` when the applicant has a receiving address per `receivingAddress`). Optional `debugToken` and `debugReadToken`: either one as Bearer reads `GET /applications`, `GET /applications/:accountId`, `GET /payout-days`, and `GET /daily-roster` without a session (`isOperatorBearer`), and only they read `GET /daily-roster/links`; writes still need a session. `lnurlServer` also gives the edit key host and the payout addresses of the roster rows.
- **Returns / side effects:** Hono app mounted at `/funding`. 401/403/400/404/409/502/503 with the documented `{ error }` strings; 502 `{ error: 'Daily roster is unavailable' }`; apply 200 `{ funding }`; admit 409 `{ error: 'All grant places are taken' }` when the round is full; places 200 `{ round, startsAt, places, admitted, placesLeft, nextGoalShops }`; list 200 `{ applications }`; detail 200 `{ account, grant, messages }`; staff POSTs 200 `{ id, name, role, funding }`. Daily-roster success is 200 roster JSON.
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

## Function: resolveExternalProfileFields

Looks up kind 0 display name, nip05, and lud16 for one external pubkey.

- **Query:** Requests kind 0 for that lowercase pubkey, keeps a verified event from that author whose content is at most 64 KiB, and reads the newest one.
- **Fields:** `displayName` is trimmed `display_name`, otherwise trimmed `name`, capped at the member-name limit. `nip05` and `lud16` are trimmed strings or null. The display name is not passed through `externalDisplayName`.
- **Resilience:** Never throws. A found event is cached for one hour, including when every field is null. A miss or a querier failure is cached for five minutes. The cache is separate from `resolveExternalProfileName` and uses the same 5,000-entry cap.

## Function: isPublicIp

- **Purpose:** Decides whether one resolved address may be contacted. IPv4 (dotted, IPv4-mapped `::ffff:`, IPv4-compatible `::x:x`, IPv4-translated `::ffff:0:x:x`, 6to4 `2002::/16`, and NAT64 `64:ff9b::/96`) must lie outside `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, and `224/3`. Other IPv6 must be globally reachable unicast: unique-local (`fc00::/7`), link-local (`fe80::/10`), site-local (`fec0::/10`), multicast (`ff00::/8`), discard (`100::/64`), `5f00::/16`, documentation (`2001:db8::/32`, `3fff::/20`), Teredo (`2001::/32`), `2001:1::/32`, `2001:2::/48` benchmarking, ORCHID (`2001:10::/28`, `2001:20::/28`), and local NAT64 (`64:ff9b:1::/48`) are refused.
- **Inputs:** `address` text as returned by the resolver (trimmed and lowercased first).
- **Returns / side effects:** `true` for a public unicast address; `false` otherwise, including text that is not an address. Pure.
- **Used by:** the external author profile NIP-05 lookup and `resolveRelayPayRequest` / `requestRelayInvoice`.

## Function: publicExternalAuthorProfile

Builds the public JSON for a forum author who has no 21.gifts account.

- **Gate:** 404 unless the id is a UUID, the row exists, `deletedAt` is null (staff included), the row is not withheld the way `GET /messages/:id` withholds a reply, `accountId` is null, and `authorPubkey` is 64 hex. Store or account failures are 503 `messages.external_profile.failed` with no pubkey and no profile text.
- **Name:** The stored name, or a truncated pubkey when that is blank. A live kind 0 name replaces it only when `externalDisplayName` accepts it against current member names.
- **Fields:** `npub` is the bech32 form of the stored pubkey. `nip05` is included only after a guarded HTTPS well-known fetch whose `names` entry matches the pubkey; private, loopback, and link-local answers are dropped. `lud16` is included only when it is `user@host`, with no fetch. Picture, about, callback, and the hex pubkey are omitted.
- **Counts:** 200 always includes uncapped `postCount` and `replyCount` from `countByPubkey`, uncapped `shopCount` from `countShopsByPubkey`, and uncapped `creditCount` from `countCreditsByPubkey`, including 0. `replyCount` is 0 when the pubkey is not a recorded zapper; a shop assigned to a member is not an external shop. A count throw uses the existing 503 `messages.external_profile.failed`.

## Function: publicExternalAuthorPosts

Lists live top-level notes for the external author of one forum message.

- **Gate:** Same 404 gate as `publicExternalAuthorProfile`.
- **List:** 200 from `listPostsByPubkey` at `MESSAGE_LIST_LIMIT`, newest-first. Posts carry `replyCount` of live attributed children.
- **Failure:** 503 and `messages.external_posts.failed` with no pubkey and no profile text.

## Function: publicExternalAuthorShops

Lists live, unassigned top-level shops for the external author of one forum message.

- **Gate:** Same 404 gate as `publicExternalAuthorProfile`, including withheld replies and deleted or member-authored seed rows.
- **List:** 200 from `listShopsByPubkey` at `MESSAGE_LIST_LIMIT`, newest-first, with `replyCount` of live attributed children.
- **Failure:** 503 and `messages.external_shops.failed` with no pubkey and no profile text.

## Function: publicExternalAuthorCredits

Lists live top-level credits for the external author of one forum message.

- **Gate:** Same 404 gate as `publicExternalAuthorProfile`, including withheld replies and deleted or member-authored seed rows.
- **List:** 200 from `listCreditsByPubkey` at `MESSAGE_LIST_LIMIT`, newest-first, with `replyCount` of live attributed children.
- **Failure:** 503 and `messages.external_credits.failed` with no pubkey and no profile text.

## Function: publicExternalAuthorReplies

Lists live public replies for the external author of one forum message.

- **Gate:** Same 404 gate as `publicExternalAuthorProfile`.
- **List:** 200 from `listRepliesByPubkey` at `MESSAGE_LIST_LIMIT`, newest-first. Empty unless the author is a recorded zapper. Replies include `parentId` and omit `replyCount`.
- **Failure:** 503 and `messages.external_replies.failed` with no pubkey and no profile text.

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

- **Purpose:** Whether the funding-grant gate is in force on this UTC day. True on and after `FUNDING_REQUIRED_FROM_UTC` (`2026-10-01`). The 21.gifts recovery share condition of payouts holds on the same days; it has no date of its own.
- **Inputs:** `nowMs` epoch milliseconds.
- **Returns / side effects:** `boolean`. No I/O.
- **Used by:** `eligibleToday`, `loadPayoutEligibility` (whether the share is read), `pingTodayMedia` (whether `requireShare` reads the share).

## Function: inGrantProgramToday

- **Purpose:** Whether the member is in the grant program on this UTC day: an admitted grant, or a trial whose `trialUtcDate` equals today's UTC key (`utcDayKey(nowMs)`). Expired and future trials, pending, rejected, and missing grants are not. It does not look at the role or the gate day.
- **Inputs:** `grant` (`FundingGrant | undefined`), `nowMs` epoch milliseconds.
- **Returns / side effects:** `boolean`. No I/O.
- **Used by:** `eligibleToday` (from the gate day, together with the recovery share).

## Function: countRoundAdmissions

- **Purpose:** How many stored grants are admissions of a grant round: status `admitted` and `admittedAt` at or after `round.startsAtMs`. Admissions before the round start (earlier rounds) do not count.
- **Inputs:** `grants` (`FundingGrant[]`) and `round` (`GrantRound`).
- **Returns / side effects:** Integer count. No I/O.
- **Used by:** `fundingRoutes` `GET /places`, `InMemoryFundingStore.admitWithinPlaces`.

## Function: grantPlaces

- **Purpose:** Public places JSON for a grant round and its admission count.
- **Inputs:** `round` (`GrantRound`) and `admitted` (from `countRoundAdmissions`).
- **Returns / side effects:** `{ round, startsAt, places, admitted, placesLeft, nextGoalShops }`; `startsAt` is ISO-8601, `placesLeft` is `places - admitted` and never below 0. No I/O.
- **Used by:** `fundingRoutes` `GET /places`.

## Function: comparePayoutRows

- **Purpose:** Sort key for the staff payout matrix. Named rows come before unnamed ones. Names use base English comparison. When names tie, a row with an account id comes before an unmatched handle, then account ids ascending.
- **Inputs:** Two {@link PayoutMatrixRow} values.
- **Returns / side effects:** Negative when the first row comes first, positive when the second does, otherwise 0. No I/O.
- **Used by:** `buildFundingPayoutMatrix`.

## Function: buildFundingPayoutMatrix

- **Purpose:** Staff matrix of theoretical grant entitlement versus collected daily payouts for seven UTC days ending on `nowMs` (oldest first). `basis` is never entitled. Admitted is entitled from `admittedAt`'s UTC day, or every day when `admittedAt` is null. A stored `trialUtcDate` entitles that one day even if status is no longer `trial`. A `gift.kind === 'daily'` on that UTC day, matched by the local part of the account's receiving address (its verified wallet), is `paid` and wins over entitlement. A `gift.kind === 'welcome'` on that UTC day, matched by the same local-part rule, sets `welcome[i]`. Both `paid` and `welcome[i]` can be true the same day. Moderator stipends are ignored. This is the post-gate grant rule: it does not use `eligibleToday`, and it does not reconstruct a cleared trial, a cleared admission, the spend roster, or whether a 21.gifts recovery share was stored on a day (an entitled day not paid for lack of a share is `missed`). A row is included when some day is `missed` or `paid`, or some `welcome` flag is true.
- **Inputs:** `nowMs`, live accounts (`id`, `name`, `role`, `lightningAddress` = the receiving address from `receivingAddress`, or null without a verified wallet), stored grants, and outbound gifts.
- **Returns / side effects:** `{ days, rows }` where each row is `accountId`, trimmed `name`, seven cells `blocked` | `missed` | `paid`, and `welcome` (seven booleans). No I/O. Named rows sort first (`en`, base), then account id. An unmatched daily or welcome handle is its own row (`accountId` null).
- **Used by:** `fundingRoutes` `GET /funding/payout-days`.

## Function: eligibleToday

- **Purpose:** Whether the account may receive a spend ping / spend invoice today. `basis` is always false. Before UTC `2026-10-01` (`FUNDING_REQUIRED_FROM_UTC`), every other role is true (passkey and living-room post still gate issue). From that UTC day, true iff `inGrantProgramToday` (admitted, or a trial whose `trialUtcDate` equals today's UTC key) **and** `recoveryShareStored`. Expired, future, pending, rejected, and missing grants are then false, and so is a grant without the 21.gifts recovery share. The share condition has no start date of its own: it holds wherever the grant gate holds.
- **Inputs:** `role` (`AccountRole`), `grant` (`FundingGrant | undefined`), `nowMs`, `recoveryShareStored` (required boolean: whether a 21.gifts recovery share is stored for the account's current verified wallet, `AuthStore.hasRecoveryShareForVerifiedWallet`), so every caller decides.
- **Returns / side effects:** `boolean`. No I/O.
- **Used by:** `loadPayoutEligibility` (which serves `messagesRoutes` spend ping, `conversationRoutes` moderator ping, `invoiceRoutes` `GET /eligible` and `POST /`, `spendInstructionRoutes`, `debugPaymentsRoutes` `POST /spend-ping`, and the zap compose ping of `settleInvoiceManually` and the Nostr worker), and the first-share ping of `PUT /me/recovery-share` (`meRoutes`, with the share just stored). Domain tests cover the matrix.

## Function: loadPayoutEligibility

- **Purpose:** The payout gate as one read, so every payout path decides the same way, except two pings that follow a write: the staff trial and admit ping checks the share inside `pingTodayMedia` (`requireShare: true`), and the first-share ping of `PUT /me/recovery-share` calls `eligibleToday` directly with the share just stored. Reads the grant with `getByAccountId` (no lazy trial persist) and then the 21.gifts recovery share (`hasRecoveryShareForVerifiedWallet`) only when it can change the answer: on a day the grant gate is in force, for a non-`basis` account that is in the grant program today. Returns `eligibleToday` with that share fact.
- **Inputs:** `fundingStore` (`Pick<FundingStore, 'getByAccountId'>`), `auth` (`Pick<AuthStore, 'hasRecoveryShareForVerifiedWallet'>`), `account` (`id`, live `role`), `nowMs`.
- **Returns / side effects:** `{ grant, eligible }`; `grant` is the stored grant for `effectiveStatus`. At most two reads, no writes. A throw of either store propagates, so each caller's existing error handling covers both reads.
- **Used by:** `invoiceRoutes` (`GET /eligible`, `POST /`), `spendInstructionRoutes`, `messagesRoutes` and `conversationRoutes` spend pings, `debugPaymentsRoutes` `POST /spend-ping`, and the zap compose ping (`settleInvoiceManually`, Nostr worker).

## Function: pingTodayMedia

- **Purpose:** Daily spend ping for a member who just became payable today: the newest live top-level photo or video (About me included) whose `createdAt` falls on today's UTC day, sent as `spendPing.ping(address, id, 'daily', grantStatus)` to the member's receiving address (verified wallet). No-op without `spendPing`, without a receiving address, or without such a post. With `requireShare` on a day the grant gate is in force, a member without a 21.gifts recovery share for the current verified wallet is not pinged and `spend.ping.skipped` `{ address, reason: 'not_eligible' }` is logged (the address as `addressRef`).
- **Inputs:** `deps` (`spendPing?`, `lnurlServer?`, `messageStore` with `latestLiveTopLevelMediaId` and `getById`, `authStore` with `hasRecoveryShareForVerifiedWallet`), `account` (read after the write that made it payable), `nowMs` (clock of that write), `grantStatus` (effective status after the write), `requireShare` (required: `true` when the caller has not checked the share, `false` when the share was just stored).
- **Returns / side effects:** Resolves `void` and never throws: a share read, media lookup, or ping failure logs `funding.daily_ping.failed` `{ accountId }`. The share read runs inside that same catch, so a failing share read never turns a committed grant write into an error.
- **Used by:** `fundingRoutes` `POST /trial` and `POST /admit` from effective pending (`requireShare: true`), and `meRoutes` `PUT /me/recovery-share` after the first share of the current wallet when the member is eligible today with it (`requireShare: false`).

## Function: dailyPayoutStoppedNotice

- **Purpose:** Whether the owner funding JSON should show the legacy daily-payout stopped notice. True only for the six listed accounts (vincent, joey-rosima, pat-armstrong, jewel-bacolbas, angel-abayle, ruben-mahinay) when effective status is `'none'` (no stored grant row). Any pending, trial, admitted, or rejected row makes it false.
- **Inputs:** `accountId` (string; empty when the grant was not loaded), `grant` (`FundingGrant | undefined`), `nowMs`.
- **Returns / side effects:** `boolean`. No I/O.
- **Used by:** `serializeOwnerFunding`.

## Function: serializeOwnerFunding

- **Purpose:** Owner `funding` JSON for `GET /me` / passkey finish. `basis` is `null` (do not leak grants). Otherwise always an object; missing row is `'none'`. Trial date and admission fields follow the effective status. Always includes `dailyPayoutStoppedNotice`.
- **Inputs:** `role`, observed `grant`, `nowMs`, live `reviewerName` (used only when admitted), `accountId` (for `dailyPayoutStoppedNotice`).
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
- **Used by:** `persistForumPost` and `resolveMentionMarks`.

## Function: resolveMentionMarks

- **Purpose:** Resolve `@username` tokens in an inbox message, a paid inbox gift, or a moderator-room message to `{ accountId, username }` at send time. Uses `mentionUsernames`, then one lookup per name. An unknown name is skipped. An address such as `name@21.gifts` is not a mark. Does not notify the marked account.
- **Inputs:** Message text and `lookup(username)` returning an account with `id`, or undefined.
- **Returns / side effects:** The mark list, possibly empty. One account read per distinct username. No notification write.
- **Used by:** `POST /conversations/:id` and a paid inbox gift.

## Function: mentionAccountMatches

- **Purpose:** Decide whether an already-normalised mention token hits one account. An empty token matches. Otherwise the token must start the trimmed username, a username segment split on `.` `_` `-`, the trimmed display name, or a display-name word split on space `.` `_` `-`. A null or blank display name does not match by name. The username fallback used for the returned `name` is not a display name. Comparison is lowercase. `_` is a literal separator, not a wildcard.
- **Inputs:** Stored `username`, stored display `name` (`string | null | undefined`), normalised `query` (`""` or a token).
- **Returns / side effects:** `boolean`. No I/O.
- **Used by:** in-memory `listAccountsByUsernamePrefix`. Postgres uses the same boundaries in SQL.

## Function: mentionQueryPrefix

- **Purpose:** Normalise the optional `q` on `GET /mentions` into a username prefix for `@` suggestions. Empty, whitespace, or a lone `@` become `""`. Otherwise trim, strip one leading `@`, and lowercase. Longer than 32 characters or outside `a-z0-9._-` with a leading letter or digit is `null` (the route maps that to 400 `{ error: 'Invalid query' }`). Does not store `@username` marks. The route treats that token as a handle prefix and as a word or segment start, not only as the start of the whole username.
- **Inputs:** `string | undefined` query value.
- **Returns / side effects:** Prefix string, `""`, or `null`. No I/O.
- **Used by:** `mentionsRoutes`.

## Function: notifyForumMentions

- **Purpose:** One `forum_mention` notification per mentioned account except the author. Level `all` always, `active` only when `isActive`, `mentions` because the recipient is the mark. Level `none` does not. Push body uses that account's locale. Push url `/messages/<messageId>`.
- **Inputs:** Author, created row (with `mentions`), top-level `parentId`, `isActive`, optional notification, push, and auth stores.
- **Returns / side effects:** Writes in-app rows and push outbox rows. No-op when every mark is the author.
- **Used by:** `persistForumPost`.

## Function: buildForumMentionPushPayload

- **Purpose:** Web Push payload for one `@username` mark. Body is `{name} marked you`, `{name} hat dich markiert`, `{name} te marcó`, or `Minarkahan ka ni {name}`. Tag `forum_mention:<messageId>`. URL `/messages/<messageId>` (URI-encoded).
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

- **Purpose:** Process-local `FundingStore` for funding-program grants. Default empty so the process boots without a database. `createApp` uses this when boot leaves `fundingStore` undefined (memory `DATABASE_URL`). `getByAccountId` / `listGrants` / `upsert` / `transition` / `expireTrialIfUnchanged` copy on read and write. `listGrants` sorts oldest `appliedAt` then `accountId` ASC. Second `upsert` for the same account replaces the row. `transition` writes only when the in-memory status is in `from` (`'none'` = no row); otherwise `undefined`. `expireTrialIfUnchanged` writes pending only when the map row is still `status='trial'` with the same `trialUtcDate` (no await between check and set). `admitWithinPlaces` counts the round (`countRoundAdmissions`) and writes in one synchronous step, so it returns `'full'` when no place is left and `undefined` on a status miss.
- **Inputs:** Optional seed `FundingGrant[]` (copied into a private `Map` keyed by `accountId`).
- **Returns / side effects:** Promise of grant copies; mutating results or the seed does not change the store. No I/O.
- **Used by:** `createApp` default `fundingStore`.

## Function: postgresTextArrayLiteral

- **Purpose:** Encodes strings as one Postgres text-array literal (`{}` when empty; each value double-quoted; a backslash or double quote inside a value is escaped). Bun SQL does not encode a JavaScript array (`malformed array literal`).
- **Inputs:** `readonly string[]`.
- **Returns / side effects:** One text-array literal string. No I/O.
- **Used by:** `PostgresFundingStore.transition` and `PostgresMessageStore` (active feed staff ids, missing-hashtag unnest, exclude ids, `getByIds`).

## Function: PostgresFundingStore

- **Purpose:** Durable `FundingStore` over Postgres (`funding_grant` table). `getByAccountId` binds `$1`. `listGrants` is `ORDER BY applied_at ASC, account_id ASC`. `upsert` is `INSERT … ON CONFLICT (account_id) DO UPDATE SET` every grant column. `transition` is `INSERT … ON CONFLICT DO UPDATE WHERE status = ANY($9::text[])` when `from` includes `'none'`, else `UPDATE … WHERE account_id=$1 AND status = ANY($9::text[]) RETURNING *` (0 rows → `undefined`). `expireTrialIfUnchanged` is `UPDATE … WHERE account_id=$1 AND status='trial' AND trial_utc_date=$2 RETURNING *` (0 rows → `getByAccountId`). Maps `timestamptz` (Date or ISO string) to epoch ms and `trial_utc_date` Date/string to `YYYY-MM-DD`; `null` stays `null`. `$9` is one `postgresTextArrayLiteral` string, not a JavaScript array. `admitWithinPlaces` runs in one transaction on the injected transaction port: `pg_advisory_xact_lock`, then `count(*)` of `status = 'admitted' AND admitted_at >= round start`, then the status-CAS `UPDATE` only while a place is free (`'full'` otherwise). Without a transaction port it throws `Error('funding transactions are not configured')`.
- **Inputs:** Constructor takes a shared boot `SqlClient` (already migrated) and an optional transaction port (`MergeDb`) that boot passes for `admitWithinPlaces`.
- **Returns / side effects:** Parameter-bound SQL; copies on return. Query and execute errors propagate.
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: linksRoutes

- **Purpose:** Public `GET /links/:code`. An 8-hex prefix maps to exactly one forum-message id or account id.
- **Inputs:** Path param `code` (lowercased, not trimmed). Collaborators `messages.listIdsByPrefix` and `accounts.listIdsByPrefix`.
- **Returns / side effects:** 400 `{ error: 'invalid_code' }` when `code` is not eight hex digits; 404 `{ error: 'not_found' }` when nothing matches; 409 `{ error: 'ambiguous' }` when two or more ids match (no ids in the body); 200 `{ kind: 'message' | 'member', id }` for exactly one match. No new log event. Soft-hidden messages are included.
- **Used by:** Website short-link redirect (`/l/<8 hex>` calls this). `createApp`.

## Function: canonicalDecimal

- **Purpose:** The canonical decimal form (`src/lib/decimal.ts`) shared by stored ask amounts and the shop payment amounts: trim, accept a comma or a dot, then write a dot decimal with no exponent, no leading zeros, no trailing fractional zeros, and no point for a whole number (`00010.10` → `10.1`, `10.` → `10`). String editing only, never `parseFloat`.
- **Inputs:** The raw string and `maxDecimals`, the most fractional digits accepted (8 for an ask and for BTC, 6 or 18 for a stablecoin, 0 for whole units).
- **Returns / side effects:** The canonical string, or `null` when the grammar fails (sign, exponent, blank, bare fraction) or the fraction has more than `maxDecimals` digits. No I/O.
- **Used by:** `canonicalGoalAmount` (eight decimals), and `decimalAmount` and `btcAmount` in `src/lib/shop-payment.ts` (`transferAmountsFor`, `requestedAmount.amount`).

## Function: canonicalGoalAmount

- **Purpose:** Turn a typed ask amount into the canonical stored string (trim, comma or dot, at most eight fractional digits, no exponent, no leading zeros, no trailing fractional zeros). It is `canonicalDecimal(raw, 8)`; the trimming lives in `src/lib/decimal.ts`.
- **Inputs:** Raw `goalAmount` string from JSON or multipart.
- **Returns / side effects:** Canonical dot-decimal string, or `null` when the grammar fails. No I/O.
- **Used by:** `messagesRoutes` and `PostgresMessageStore` row mapping.

## Function: fiatToSats

- **Purpose:** Convert a fiat amount to whole sats with the gift-day proportion (`Math.round(amount * day.sats / dayFiat)`). Amount 0 is 0. A product that rounds to 0 becomes 1. Unusable day or quote returns null. Not the spot BigInt helper.
- **Inputs:** Finite amount, gift-day or null, and `USD` / `CHF` / `EUR` / `PHP`.
- **Returns / side effects:** Whole sats, or `null` when unusable. No I/O.
- **Used by:** `messagesRoutes` when freezing a fiat ask; the repayment routes when pricing a fiat share in sats (`repaymentStatus` for `dueSats` and `next`, `repaymentInvoice`, `repaymentDueBills`, and `myLoansRoutes` for the sat figures of `GET /me/loans`).

## Function: satsToFiatAmount

- **Purpose:** Convert whole sats to a two-decimal fiat string on the same gift-day proportion (`Math.round(dayFiat * 100 * sats / day.sats)`).
- **Inputs:** Sats, gift-day or null, and `USD` / `CHF` / `EUR` / `PHP`.
- **Returns / side effects:** Two-decimal string, or `null` when the day, quote, or negative sats are unusable. No I/O.
- **Used by:** `messagesRoutes` for the four frozen ask snapshots.

## Function: loadGiftStatsSnapshot

- **Purpose:** Build the same gift stats object as `GET /gifts/stats` for one row set. Amounts are the stored strings. The rate books and the clock are accepted and not read. A missing stored amount stays null and is never `fx-incomplete`.
- **Inputs:** Outbound `GiftRow[]`, BTC-USD book, fiat book, and `nowMs`. The books and the clock are not read.
- **Returns / side effects:** `{ ok: true, stats }`. No I/O to a rate book. Does not log `gifts.stats.fiat_failed`.
- **Used by:** `giftsStatsRoutes`, `loadLatestGoalRateDay`.

## Function: SHOP_DESCRIPTION_MIN

- **Purpose:** Lower bound of a shop description after `shopDescription` strips the shop tag. A shorter description fails `shopTextProblem` and is not sent to the map.
- **Value:** The integer `20`.
- **Used by:** `shopTextProblem` when it checks that the stripped description is at least this long and strictly longer than the shop name.

The constant is the lower bound of the 20–1000 character rule on a shop with a pin. `POST /messages`, `PATCH /messages/:id/place` when a non-null pin is complete, and `PATCH /messages/:id/text` when the stored pin is complete return that error when the description is below it.

## Function: SHOP_DESCRIPTION_MAX

- **Purpose:** Upper bound of a shop description after `shopDescription` strips the shop tag. A longer description fails `shopTextProblem` and is not sent to the map.
- **Value:** The integer `1000`.
- **Used by:** `shopTextProblem` when it checks that the stripped description is at most this long and strictly longer than the shop name.

The constant is the upper bound of the 20–1000 character rule on a shop with a pin. `POST /messages`, `PATCH /messages/:id/place` when a non-null pin is complete, and `PATCH /messages/:id/text` when the stored pin is complete return that error when the description is above it.

## Function: shopDescription

- **Purpose:** Note text without the shop tag, same rule as the app's `stripShopHashtag`. Converts CRLF to LF, removes every case-insensitive `#21GiftsShop` token not followed by `[A-Za-z0-9_]`, collapses 3+ newlines to 2, and trims.
- **Inputs:** Stored or submitted note text.
- **Returns / side effects:** Description string for the OpenCryptoPay map, the shop kind 0 `about`, and the `description` of `GET /shops/:npub`. No I/O.
- **Used by:** `shopTextProblem`, `shopOcpPlaceInput`, shop kind 0 `about` (`shopKind0Args`), and `shopRoutes` (`description`).

## Function: SHOP_NAME_REQUIRED

- **Purpose:** Caller-visible error when a shop note has no shop name. The shop name is the pin label. One string serves every check that rejects a missing name.
- **Value:** The text `Shop name is required`.
- **Used by:** `shopPlaceProblem` when the label is missing or blank, `POST /messages` when a top-level shop has no pin, and `PATCH /messages/:id/place` when `place` is null.

A missing pin and an empty label tell the caller the same thing. The create and place routes import this export instead of keeping a second copy of the sentence.

## Function: shopPlaceProblem

- **Purpose:** Name and address problems of a shop pin, or null when both are complete. Order: name required, then address required, then the label must not contain the street or postal code as a standalone token.
- **Inputs:** A `ForumPlace` on a shop note.
- **Returns / side effects:** A fixed English error (`Shop name is required`, `Shop address is required`, or `Shop name must not contain the address`), or `null`. No I/O.
- **Used by:** `POST /messages` (JSON and multipart) for a top-level shop with a pin, `PATCH /messages/:id/place` when the place is non-null, `PATCH /messages/:id/text` when deciding whether the stored pin is complete, `shopOcpPlaceInput`, and `listedShop`.

## Function: shopTextProblem

- **Purpose:** Description problem of a shop note, or null when it is complete. The description is `shopDescription` of the text (CRLF already folded to LF). It must be 20–1000 characters, strictly longer than the pin label, and not equal to the label case-insensitively. A missing label is compared as the empty string.
- **Inputs:** Stored or submitted note text, and the forum pin or `null` when the note has none.
- **Returns / side effects:** `Shop description must be 20 to 1000 characters and longer than the shop name`, or `null`. No I/O.
- **Used by:** `POST /messages` for a top-level shop with a pin, `PATCH /messages/:id/place` when the place is non-null (after `shopPlaceProblem` passes), `PATCH /messages/:id/text` when the stored place is complete, `shopOcpPlaceInput`, and `listedShop`.

## Function: shopOcpPlaceInput

- **Purpose:** Map a complete shop pin onto an OpenCryptoPay place with origin `21gifts`, techProvider `21.gifts`, category `shopping`, payment methods `lightning`, shopType `Others`, description from `shopDescription`, name from the pin label, and the five structured address fields. An incomplete shop is not mapped.
- **Inputs:** Message id (`externalId`), stored note text, and forum place.
- **Returns / side effects:** An `OcpPlaceInput`, or `null` when `shopPlaceProblem` or `shopTextProblem` reports a problem. No I/O.
- **Used by:** `runOcpPlaceOutboxPass` (per claim in `sendPlace`, after `listedShop` passes).

## Function: isDevShopSeedTarget

- **Purpose:** True only when `PUBLIC_BASE_URL` is exactly `https://dev.21.gifts` after trim and trailing-slash strip. Does not case-fold and does not use prefix matching. Missing or blank is false.
- **Inputs:** Environment slice with `PUBLIC_BASE_URL`.
- **Returns / side effects:** `boolean`. No I/O.
- **Used by:** `seedDevShopPlaces`.

## Function: seedDevShopPlaces

- **Purpose:** On the dev 21.gifts API only, insert four public shop pins into `message` with production message ids, `account_id` null, `nostr_publish_state` skipped, and `event_id` null. Idempotent via `ON CONFLICT (id) DO NOTHING`. Stored text is the public label or name plus `#21GiftsShop`, not the production note body. The seeds have no structured address, so `shopPlaceProblem` reports a problem and `shopOcpPlaceInput` stays null. They stay off the OpenCryptoPay map until name, address, and a description that satisfies `shopTextProblem` are all set. Does not create accounts and does not publish to Nostr.
- **Inputs:** `{ env, sql? }`. Seeds only when `isDevShopSeedTarget(env)` is true and `sql` is set.
- **Returns / side effects:** Resolves after one parameterised INSERT of all four rows, or immediately on a no-op. A failed insert logs `dev.shop.places.failed` and does not stop boot. Success does not log.
- **Used by:** `src/index.ts`, awaited after `welcomeCatchUp` and before the outbox start-up queue pass.

## Function: resolveMapPush

- **Purpose:** Return undefined while `SHOP_PLACE_PUSH_ENABLED` is false, even when both environment variables are set. When that constant is true, build the push from `OCP_MAP_BASE_URL` and `OCP_PLACE_INGEST_TOKEN`. A blank URL or token still means no push. The process still boots. Turning the push on is a change to that constant, not an environment variable.
- **Inputs:** Environment slice and fetch.
- **Returns / side effects:** `{ baseUrl, token, fetchImpl }` or `undefined`. Trims both values and strips trailing slashes from the URL.
- **Used by:** `src/index.ts` to configure only the durable outbox senders.

## Function: resolveActivityPing

- **Purpose:** Build the OpenCryptoPay map activity ping from `OCP_MAP_BASE_URL` and `OCP_PLACE_INGEST_TOKEN`. Unlike `resolveMapPush`, this ping ignores `SHOP_PLACE_PUSH_ENABLED`. A missing or blank URL or token means no ping. The process still boots.
- **Inputs:** Environment slice and fetch (`MapFetch`).
- **Returns / side effects:** `{ baseUrl, token, fetchImpl }` or `undefined`. Trims both values and strips trailing slashes from the URL with `/\/+$/u`.
- **Used by:** `createApp` when wiring `posRoutes` (`activity`).

## Function: pingShopActivity

- **Purpose:** POST each unique shop note id to `{baseUrl}/map/places/transactions` so the OpenCryptoPay map can record a till charge. Failures log `ocp.activity.failed` and do not throw. Non-2xx logs only numeric `status`. A thrown fetch logs the allowlisted name plus `code` or `errno` from the error or its cause and never the message, the address, or the bearer. Each request uses `AbortSignal.timeout(5000)` so a hung map cannot hold `POST /pos`.
- **Inputs:** Optional `ActivityPing`, shop note ids (empty strings skipped, first occurrence kept), and `occurredAt` ISO-8601 from the stored charge `createdAt`.
- **Returns / side effects:** `Promise<void>`. Sequential POSTs with body `{ origin: '21gifts', externalId, occurredAt }`. No-op when ping is undefined or no ids remain. Does not read the response body. A failure does not skip later ids.
- **Used by:** `posRoutes` after a successful `POST /pos` `store.create`.

## Function: logActivityFailure

- **Purpose:** Log `ocp.activity.failed` for a thrown map ping or a thrown `listLiveAssignedShops`, using allowlisted fields only. Never logs the message, the address, or the bearer. Empty allowlist logs the event with no second argument.
- **Inputs:** The thrown value.
- **Returns / side effects:** Calls `logEvent('ocp.activity.failed')` or `logEvent('ocp.activity.failed', fields)`. Does not throw.
- **Used by:** `pingShopActivity` for thrown fetches and `posRoutes` when `listLiveAssignedShops` throws.

## Function: loadLatestGoalRateDay

- **Purpose:** Latest gift-day proportion for a currency ask: last `spendOverTime` day with `sats > 0` from `loadGiftStatsSnapshot` (no recipient filter). Empty history is null. `sats` is that public day total. A currency field stays that public sum only when every outbound gift on that UTC day stored a string for it. If any gift on that day lacks the string, that field is null, even when the public series shows a partial sum. The public series is unchanged. Does not invent a rate.
- **Inputs:** `{ store, rates, fiatRates, now }` — the same collaborators as `GET /gifts/stats`.
- **Returns / side effects:** `{ sats, usd, chf, eur, php }` or `null`. A missing or incomplete currency is null and does not throw. The rate books are not read.
- **Used by:** `bindGoalRateDay`.

## Function: bindGoalRateDay

- **Purpose:** Return the `goalRateDay` callback `createApp` passes to `messagesRoutes`.
- **Inputs:** `{ store, rates, fiatRates, now }` — the same collaborators as {@link loadLatestGoalRateDay}.
- **Returns / side effects:** A function that calls `loadLatestGoalRateDay` with those collaborators.
- **Used by:** `createApp`.

## Function: memberHabitRoutes

- **Purpose:** Hono routes `GET /habits` and `POST /habits` for member habits, comments, and a Lightning invoice. `invoice` uses the same Sunday rest as `POST /messages/:id/invoice`: 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names a Sunday, before the amount check. A missing, blank, or invalid zone does not refuse. Success is `{ pr, amountSats }`. A missing, non-numeric, non-integer, or over-cap `amountSats` is 400 `{ error: 'Expected a JSON body with an integer "amountSats"' }` (ceiling 10_000_000). The limiter answer is 429 `{ error: 'Too many payments' }`. A failed mint, or a BOLT11 that does not decode to exactly `amountSats * 1000` millisatoshis, is 502 `{ error: 'Lightning Address could not be resolved' }`. A comment id that is not a UUID is 404 `{ error: 'Not found' }` on `deleteComment` and `invoice`, not 503. Does not pay. Add, edit, archive, and log stay open on Sunday. An edit whose current period is after `lastPeriod` is 409 `{ error: 'Period is closed' }` and does not change the stored wording. An edit of another member's habit is 404, including when that period is already closed.
- **Inputs:** `{ store, authStore, now, fetchImpl }`, optional `lnurlServer` and `resolve`. `authStore` needs `getAccount`, `getAccounts` (one bulk lookup of all distinct comment authors for their `canReceive` on `GET /habits`), and `getAccountByUsername`. `invoice` mints on `receivingAddress(author, lnurlServer)` through `lnurlServerFetch`; no receiving address (no verified wallet, or `lnurlServer` omitted) is 409 `{ error: "The author's wallet cannot receive this Bitcoin payment", code: 'cannot_receive' }`.
- **Returns / side effects:** Hono app. Writes through `MemberHabitStore`. Logs only `{ event: 'habits.failed', ts }` on failure.
- **Used by:** `createApp`.

## Function: isValidTimeZone

- **Purpose:** Accept a non-empty IANA time zone and reject an empty string or a name `Intl` does not know.
- **Inputs:** A time-zone string from the `Time-Zone` header.
- **Returns / side effects:** `true` or `false`. No writes.
- **Used by:** `POST /habits` action `add`.

## Function: dayKey

- **Purpose:** Calendar date `YYYY-MM-DD` of an instant in a time zone.
- **Inputs:** Epoch milliseconds and an IANA time zone.
- **Returns / side effects:** The date string. No writes.
- **Used by:** daily habit periods and the daily log bound.

## Function: weekKey

- **Purpose:** Monday `YYYY-MM-DD` of the week that contains `dayKey` for that instant. Weeks start Monday.
- **Inputs:** Epoch milliseconds and an IANA time zone.
- **Returns / side effects:** The Monday string. No writes.
- **Used by:** weekly periods and the weekly log check.

## Function: periodKey

- **Purpose:** `dayKey` when the cadence is daily, `weekKey` when it is weekly.
- **Inputs:** Epoch milliseconds, cadence `daily` or `weekly`, and an IANA time zone.
- **Returns / side effects:** The period string. No writes.
- **Used by:** `add`, `edit`, and `archive` when they stamp the current period.

## Function: nextPeriod

- **Purpose:** The next calendar day, or the Monday seven days later.
- **Inputs:** A `YYYY-MM-DD` key and a cadence.
- **Returns / side effects:** The following period key. Throws when the key is not `YYYY-MM-DD`.
- **Used by:** period ranges.

## Function: comparePeriod

- **Purpose:** Lexical compare of `YYYY-MM-DD`, which is chronological.
- **Inputs:** Two period keys.
- **Returns / side effects:** `-1`, `0`, or `1`. No writes.
- **Used by:** the closed-period check and period ranges.

## Function: weeklyRatableThrough

- **Purpose:** Latest Monday that is ratable at this instant. A week becomes ratable at 08:00 on the following Monday in the habit time zone.
- **Inputs:** Epoch milliseconds and an IANA time zone.
- **Returns / side effects:** A Monday `YYYY-MM-DD`. No writes.
- **Used by:** weekly logs and `manilaReviewWeek`.

## Function: manilaReviewWeek

- **Purpose:** The Manila review week, which is `weeklyRatableThrough` in `Asia/Manila`.
- **Inputs:** Epoch milliseconds.
- **Returns / side effects:** `{ start }` with that Monday. No writes.
- **Used by:** `GET /habits` and comment creation.

## Function: migrateMemberHabitSchema

- **Purpose:** Run the idempotent statements for `member_habit`, `member_habit_revision`, `member_habit_log`, and `member_habit_comment`. Revision `name` is `char_length` 1–80 and `description` is at most 2000, the same limits as the habit row. A table created before those checks receives them on the next run.
- **Inputs:** A SQL client whose `query` returns `{ rows }`.
- **Returns / side effects:** Resolves when the five statements have run. Safe to call more than once.
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: InMemoryMemberHabitStore

- **Purpose:** Process-local `MemberHabitStore` for tests and for boot without a database URL. Notes stay on the row and are copied onto the public view only for the owner.
- **Inputs:** None. Starts empty.
- **Returns / side effects:** Add, edit, archive, log, list, comment, delete, and Lightning methods. Mutates private maps.
- **Used by:** unit tests and `createApp` when no database URL is set.

## Function: PostgresMemberHabitStore

- **Purpose:** `MemberHabitStore` against the `member_habit*` tables. Lightning addresses go through the injected address port, not a habit column.
- **Inputs:** A SQL client whose `query` returns `{ rows }`, and a Lightning address port.
- **Returns / side effects:** Same port as the in-memory store, persisted in Postgres. Adding a habit inserts the row and its first revision in one statement. Editing the wording updates the owned row and upserts that period's revision in one statement, matching the habit id and the owner together. A missing or unowned habit writes nothing. A failed statement leaves both unchanged. A comment id Postgres rejects as uuid text is missing, not an error. Revision `name` and `description` use the same `char_length` checks as the habit row.
- **Used by:** `openBootStores` when `DATABASE_URL` is set.

## Function: readCappedText

- **Purpose:** Read a request body as UTF-8 text without buffering more than a byte cap. A declared `Content-Length` above the cap is refused before anything is read; otherwise the stream is read chunk by chunk and cancelled as soon as the total passes the cap. Shared by the forwarded LNURL routes (`LNURL_BODY_LIMIT_BYTES`), `POST /me/wallet/report` (1 MiB), and `POST /me/events` (64 KiB).
- **Inputs:** The incoming `Request` and the largest accepted body in bytes.
- **Returns / side effects:** The decoded text, `''` when the request has no body, or `null` when the body is larger than the cap (the caller answers 413 `{ error: 'Request body is too large' }`). Never logs the body.
- **Used by:** `lnurlServerRoutes`, `walletReportRoutes`, `memberEventRoutes`.

## Function: isSecretFieldName

- **Purpose:** Tell whether a body or prop key names secret material, so the member-data ingest never reads or stores it. The name is lower-cased and stripped of every non-alphanumeric character (so `spending_key`, `priv-key`, and `x.prv` count), then matched as a substring against `seed`, `mnemonic`, `phrase`, `preimage`, `private`, `privkey`, `secret`, `prf`, `nsec`, `xprv`, `password`, `passphrase`, `spendingkey`, `spendkey`, `token`, `authorization`, `bearer`, `cookie`, `credential`, and `session`.
- **Inputs:** One key name.
- **Returns / side effects:** `true` when the key contains one of those tokens. Pure; no logging.
- **Used by:** `parseMemberEventBatch` (prop keys are skipped). `parseWalletReport` reads only its named fields, so a secret-named key in a wallet report is never read at all.

## Function: looksLikeSecretValue

- **Purpose:** Tell whether a string value contains secret material anywhere: a token that starts (case-insensitive) with `nsec1`, `xprv`, `tprv`, `yprv`, `zprv`, `uprv`, or `vprv`, or a run of at least 12 consecutive recovery-phrase-shaped words in any official BIP-39 language (3–9 letters of a script other than Han, Hiragana, Katakana, or Hangul, or 1–8 Han, Hiragana, Katakana, or Hangul characters), whatever non-alphanumeric characters separate them (the ideographic space included); the text is NFC-normalised first, so the decomposed form of the official wordlists counts (a recovery phrase, also inside a sentence or spread over path segments). A word with a digit or of another length breaks the run, so ordinary sentences with short words are kept.
- **Inputs:** One string.
- **Returns / side effects:** `true` for a secret-shaped value. Pure; no logging. Defence in depth: the app never sends such values, and the ingest drops them if it does.
- **Used by:** `parseMemberEventBatch` (prop values) and `parseWalletReport` (description, comment, and other detail fields become `null`).

## Function: parseClientInstant

- **Purpose:** Parse a timestamp sent by the app: an ISO-8601 instant string (date, time to the minute or finer, and `Z` or a numeric offset, checked field by field, so a date alone, a locale string, or an impossible calendar date, time, or offset such as February 30 is refused instead of rolled over) or a finite number, where a number below `1e11` is epoch seconds and anything else epoch milliseconds. Bounds are `CLIENT_INSTANT_MIN_MS` (2009-01-03T00:00:00Z) and now plus `CLIENT_INSTANT_FUTURE_SKEW_MS` (5 minutes).
- **Inputs:** The raw value and the server clock in epoch milliseconds.
- **Returns / side effects:** A `Date`, or `null` for any other type, an unparseable string, a non-finite number, or an instant outside the bounds. Pure.
- **Used by:** `parseMemberEventBatch` (`at`) and `parseWalletReport` (`syncedAt`, payment `timestamp`).

## Function: parseMemberEventBatch

- **Purpose:** Validate a `POST /me/events` body `{ events: [...] }` against the allow-list. The batch is refused when the body is not a plain object, `events` is not an array, or it has more than `MEMBER_EVENT_BATCH_MAX` (50) entries. Each entry needs a `name` in `MEMBER_EVENT_NAMES` and an `at` that `parseClientInstant` accepts; `path` is cut at `?` / `#` and must start with `/` (1–256 characters, no control characters, no key token or recovery-phrase run anywhere as written and with runs of `%XX` escapes decoded as UTF-8); `props` must be a plain object of at most `MEMBER_EVENT_PROPS_MAX` (20) keys. Inside `props`, keys that fail `[A-Za-z][A-Za-z0-9_]{0,39}`, secret-named keys, strings that `containsEncodedSecret` flags, strings over 200 characters or with control characters, non-finite numbers, and nested values are skipped without dropping the event.
- **Inputs:** The parsed JSON body and the server clock in epoch milliseconds.
- **Returns / side effects:** `{ ok: false }` for a refused batch, otherwise `{ ok: true, events, dropped }` where `dropped` counts entries that failed a rule. Unknown keys are ignored and never copied. Pure.
- **Used by:** `memberEventRoutes`.

## Function: migrateMemberEventSchema

- **Purpose:** Apply `MEMBER_EVENT_SCHEMA_SQL` in order: `member_event (id, account_id → account, name, at, path, props jsonb, received_at)` and the index `member_event_account_at_idx (account_id, at DESC, id DESC)`. Idempotent; the same text is in `docs/schema/member_event.sql`.
- **Inputs:** A `SqlClient`.
- **Returns / side effects:** Resolves after every statement ran. Runs at a SQL boot before `migrateDbChangeSchema`, so `trg_db_change` attaches to the table. Needs `DATABASE_URL`; not reached on the default boot.
- **Used by:** `openBootStores`.

## Function: InMemoryMemberEventStore

- **Purpose:** Process-local `MemberEventStore` for boots without `DATABASE_URL` and for tests. `appendMany` keeps defensive copies of each row; `listForAccount` returns one account's rows newest `at` first (ties by `id` descending), capped at `limit`, as copies.
- **Inputs:** No constructor arguments. `appendMany` takes `MemberEvent` rows; `listForAccount` takes an account id and a limit.
- **Returns / side effects:** Promises of void and of row copies. Rows live for the process lifetime. Only allow-listed fields are stored; no secret material.
- **Used by:** `createApp` default; route and store tests.

## Function: PostgresMemberEventStore

- **Purpose:** Postgres `member_event` store. `appendMany` writes all rows in one multi-row `INSERT` (props as `jsonb`); an empty array runs nothing. `listForAccount` reads one account newest-first with `LIMIT`, maps `Date` or string timestamps, and keeps only scalar or `null` prop values (unparseable props become `{}`).
- **Inputs:** Constructor takes a migrated `SqlClient`.
- **Returns / side effects:** Query failures propagate (the route answers 503). Every insert is logged by `trg_db_change`. Needs `DATABASE_URL`; not reached on the default boot.
- **Used by:** `openBootStores` → `createApp` → `memberEventRoutes`.

## Function: memberEventRoutes

- **Purpose:** Hono group mounted at `/` that serves `POST /me/events`. Order: bearer session (401), per-account rate limit with `IpRateLimiter` keyed by the account id, `MEMBER_EVENTS_PER_MINUTE` (30) per 60 seconds (429), body cap `MEMBER_EVENTS_BODY_LIMIT_BYTES` (64 KiB) via `readCappedText` (413), JSON and `parseMemberEventBatch` (400), then one `appendMany` with a fresh id, the account id, and the receive time per event.
- **Inputs:** `authStore`, `store` (`MemberEventStore`), `now`, optional `limiter`.
- **Returns / side effects:** 200 `{ accepted, dropped }`. A store failure logs `member_event.write.failed` with `accountId` only and answers 503 `{ error: 'Log is unavailable' }`. Never logs the body, props, or path.
- **Used by:** `createApp`.

## Function: decodeSparkAddress

- **Purpose:** Decode a Spark address or Spark invoice (bech32m with a Spark prefix such as `spark`, `sparkrt`, `sp`, or `sprt`, no length limit) into the receiver's identity public key (protobuf field 1, 33 bytes) and the invoice memo (field 5 of field 2), for example `zap:<payment hash>` or `pos:<charge id>`. The input is trimmed and lower-cased first.
- **Inputs:** One candidate string (the reported `invoice` or `destination`).
- **Returns / side effects:** `{ identityPublicKey, memo }` (66 lower-case hex, memo or `null`), or `null` for any decoding failure. Never throws and never logs.
- **Used by:** `walletPaymentClassifier` (identity key and the `zap:` / `pos:` memo). Secret screening of encoded memos is `containsEncodedSecret`, which reads every memo, not only the first.

## Function: encodeSparkAddress

- **Purpose:** Encode a wallet identity public key as its mainnet Spark address: bech32m with prefix `spark` over protobuf `SparkAddress { 1: identity_public_key }`, with no invoice fields and no signature. The address depends only on the key.
- **Inputs:** Compressed identity public key, 66 hex characters (callers pass the lower-case key that the route and the `account_spark_pubkey_chk` CHECK enforce; `hex.decode` also accepts upper case).
- **Returns / side effects:** The `spark1…` address (68 characters). Throws when the key is not 33 bytes of hex. No I/O.
- **Used by:** `PostgresAuthStore.claimSparkPubkey` (writes `account.spark_address` with the key), `PostgresAuthStore.commitRecovery` (the previous wallet's address when `account.spark_address` is null, and the new `account.spark_address`), `InMemoryAuthStore.commitRecovery` (the previous wallet's `sparkAddress`), and `backfillSparkAddresses`.

## Function: parseWalletReport

- **Purpose:** Validate a `POST /me/wallet/report` body. `balanceSats` must be a safe integer from 0 to `MAX_SATS` (21 million BTC) and `syncedAt` must pass `parseClientInstant`; `payments` is optional and at most `WALLET_REPORT_PAYMENTS_MAX` (200). A payment needs `id` (1–256 characters, no control characters, not secret-shaped), `direction` `in` / `out`, `status` `pending` / `completed` / `failed`, `amountSats`, `timestamp`, and a `method` that is lower-cased and must then match `[a-z][a-z0-9_]{0,31}`; `feeSats` missing or `null` is 0. Detail fields `paymentHash` (64 hex), `invoice` (≤ 4096), `destination` (≤ 512), `description` (≤ 640), and `lnurlComment` (≤ 640) become `null` when missing, too long, holding control characters, or secret-shaped (`looksLikeSecretValue`). Every detail field and the payment id are screened with `containsEncodedSecret`, so an encoded Spark memo, BOLT11 description, or bech32 payload that holds secret material also makes the field `null` (the payment is skipped for a secret-shaped id). A raw 32-byte value is not screened by shape: it looks like the hashes, ids and NIP-57 zap requests the route collects.
- **Inputs:** The parsed JSON body and the server clock in epoch milliseconds.
- **Returns / side effects:** `{ ok: false }` for a refused report, otherwise `{ ok: true, report }` with `payments` in request order and `skipped` for invalid entries. Output objects are built field by field, so unknown fields such as `preimage` are never copied. Pure.
- **Used by:** `walletReportRoutes`.

## Function: walletPaymentClassifier

- **Purpose:** Build a per-request classifier that gives each reported payment a `category` (`member`, `shop`, `platform`, `gift`, `outside_lightning`, `onchain`, `unknown`) and a `counterpartyAccountId`. First match wins: a forum or conversation invoice the api issued (`findOkInvoiceByPaymentHash`, hash from the field, the BOLT11, or a `zap:` Spark memo) or an indexed zap receipt → `gift`, or `platform` when the other side is the platform account; a point-of-sale charge by recorded BOLT11 hash or `pos:` memo (`findChargeForPayment`) → `shop`; an own-host Lightning address (`accountByReceivingAddress`), a Spark identity key, or a raw Spark public key of a verified wallet → `platform`, `shop` (live `#21GiftsShop` note, loaded once per request), or `member`; otherwise `onchain`, `outside_lightning`, or `unknown` from the method, a foreign address, or an `ln…` invoice. The reporting account itself never counts as the counterparty.
- **Inputs:** `WalletCategoryDeps` (auth store, message store, POS store, optional LNURL server config) and the reporting account id.
- **Returns / side effects:** An async function from `ReportedWalletPayment` to `{ category, counterpartyAccountId }`. Read-only; a lookup failure propagates (the route answers 503).
- **Used by:** `walletReportRoutes`.

## Function: migrateWalletSchema

- **Purpose:** Apply `WALLET_SCHEMA_SQL` in order: `wallet_balance_snapshot` with index `wallet_balance_snapshot_account_received_idx`, `wallet_payment` (primary key `(account_id, payment_id)`, CHECKs on direction, status, category, and non-negative amounts, `counterparty_account_id → account`), an `ADD COLUMN IF NOT EXISTS invoice` and an `ADD COLUMN IF NOT EXISTS last_observed_at` (the staleness watermark), and index `wallet_payment_account_paid_idx`. Idempotent; the same text is in `docs/schema/wallet.sql`.
- **Inputs:** A `SqlClient`.
- **Returns / side effects:** Resolves after every statement ran. Runs at a SQL boot before `migrateDbChangeSchema`, so `trg_db_change` attaches to both tables. Needs `DATABASE_URL`; not reached on the default boot.
- **Used by:** `openBootStores`.

## Function: InMemoryWalletStore

- **Purpose:** Process-local `WalletStore` for boots without `DATABASE_URL` and for tests. `recordBalance` appends a snapshot; `upsertPayments` inserts or updates by `(accountId, paymentId)` with the same rules as the Postgres store (overwrite status, amounts, method, time, category, counterparty; keep stored detail fields when the new value is `null`; keep `firstSeenAt`, the observation time of the row that first stored the payment; move `updatedAt` only on a change; ignore a row observed before the latest accepted observation of that payment, which every accepted row advances even when it changes nothing (the staleness watermark); keep a resolved category and its counterparty when the new row only has a fallback category `outside_lightning`, `onchain`, or `unknown`). `latestBalance` and `listPayments` (newest `paidAt` first, ties by `paymentId` in UTF-8 byte order, the same as Postgres `COLLATE "C"`) return copies.
- **Inputs:** No constructor arguments.
- **Returns / side effects:** Promises of void, of the latest snapshot, and of payment copies. Rows live for the process lifetime. Only allow-listed fields are stored.
- **Used by:** `createApp` default; route and store tests.

## Function: PostgresWalletStore

- **Purpose:** Postgres store for `wallet_balance_snapshot` and `wallet_payment`. `recordBalance` inserts one snapshot. `upsertPayments` runs one `INSERT … ON CONFLICT (account_id, payment_id) DO UPDATE` per row (distinct payments eight at a time; a payment repeated in one call in order) that `COALESCE`s the detail fields and accepts a row only when its observation is not older than the stored `last_observed_at` (falling back to `updated_at` for rows written before that column existed), so an older observation never overwrites newer state. An accepted row always advances `last_observed_at`; `updated_at` moves only when a value changes (`IS DISTINCT FROM`); a resolved category and counterparty are kept when the new row only has a fallback category. An identical re-send with an older or equal observation writes nothing; one with a newer observation updates only `last_observed_at` (one `db_change` UPDATE). `latestBalance` and `listPayments` read newest-first (`ORDER BY paid_at DESC, payment_id COLLATE "C" DESC`, the same order as the in-memory store) and map `bigint` and timestamp columns.
- **Inputs:** Constructor takes a migrated `SqlClient`.
- **Returns / side effects:** Query failures propagate (the route answers 503). Every insert and update is logged by `trg_db_change`. Needs `DATABASE_URL`; not reached on the default boot.
- **Used by:** `openBootStores` → `createApp` → `walletReportRoutes`.

## Function: walletReportRoutes

- **Purpose:** Hono group mounted at `/` that serves `POST /me/wallet/report`. Order: bearer session (401), per-account rate limit with `IpRateLimiter` keyed by the account id, `WALLET_REPORTS_PER_MINUTE` (60) per 60 seconds (429), body cap `WALLET_REPORT_BODY_LIMIT_BYTES` (1 MiB) via `readCappedText` (413), JSON and `parseWalletReport` (400), then classification with `walletPaymentClassifier` (payments `WALLET_REPORT_CONCURRENCY`, 8, at a time) under one observation time that is strictly increasing per account (a later report of the same account in the same millisecond gets the next millisecond; idle accounts are dropped after the one-minute rate-limit window), one `recordBalance`, and one `upsertPayments` (a later duplicate id in the same report wins).
- **Inputs:** `authStore`, `walletStore`, `messages`, `posStore`, optional `lnurlServer`, `now`, optional `limiter`.
- **Returns / side effects:** 200 `{ acknowledgedIds }`. A lookup or write failure logs `wallet_report.write.failed` with `accountId` only and answers 503 `{ error: 'Wallet data is unavailable' }`. Never logs the body, amounts, addresses, invoices, or memos.
- **Used by:** `createApp`.

## Function: walletHeartRoutes

- **Purpose:** Hono group mounted at `/` that serves `POST /me/wallet/hearts`. Order: bearer session (401), per-account rate limit with its own `IpRateLimiter` keyed by the account id, `HEART_LOOKUPS_PER_MINUTE` (60) per 60 seconds (429), body cap `HEART_LOOKUP_BODY_LIMIT_BYTES` (8192) via `readCappedText` (413), JSON and `{ hashes: string[] }` of 1 to 32 hashes of 64 hex digits (400), then sequential `findOkInvoiceByPaymentHash` (lowercase) and `getById` lookups. Duplicates collapse in first-seen order. A row is kept only when `heart` is true and the caller is the payer or the author; otherwise it is omitted. A missing or empty `messageId` is skipped. `authorName` and `text` are trimmed, then clipped to 80 and 240 Unicode code points with a trailing `…` when characters are dropped. `deleted` is true when the note is missing or `deletedAt` is set.
- **Inputs:** `authStore`, `messages` (`findOkInvoiceByPaymentHash`, `getById`), `now`, optional `limiter`.
- **Returns / side effects:** 200 `{ hearts }`. A lookup failure logs `wallet_hearts.lookup.failed` with `accountId` only and answers 503 `{ error: 'Heart lookup is unavailable' }` with no partial list. Never logs hashes, memos, or note text.
- **Used by:** `createApp`.

## Function: bolt11Descriptions

- **Purpose:** Read every plaintext `description` tag of any decodable BOLT11, zero-amount invoices included (unlike `inspectBolt11`, which needs an amount and reads only the first). An invoice that carries only a description hash, or that does not decode, has none.
- **Inputs:** A BOLT11 string and an optional decoder (tests inject a fake).
- **Returns / side effects:** All string descriptions in tag order, or an empty list. Pure; never logs a description.
- **Used by:** `containsEncodedSecret`, so a second description tag cannot hide a recovery phrase.

## Function: containsEncodedSecret

- **Purpose:** Tell whether a value holds secret material, also inside an encoded token. Flags a key token, a recovery-phrase run (`looksLikeSecretValue`), or a WIF private key token (Base58Check, version `0x80` or `0xef`, 32-byte key, optional `0x01` flag, valid checksum) in the value itself and in every text decoded from it, each read as written and percent-decoded (runs of `%XX` as UTF-8, `+` as a space, as in LNURL query strings): for every bech32 or bech32m token (alphanumeric runs, and chunks split only at whitespace and common delimiters such as `/`, brackets, quotes, and commas, with trailing punctuation also stripped, since a prefix may hold other punctuation; lower-cased first, as case-folding decoders read it) it screens the whole payload twice, as printable ASCII (so the text of an LNURL is covered) and as UTF-8 (so a phrase in any language carried without protobuf framing is read), plus every length-delimited protobuf field in it on its own, decoded as UTF-8 so memos in any language are read, repeated and nested fields included at any depth, read leniently so a malformed later field cannot hide the fields before it (a token whose nesting would cost more than eight times its payload to walk counts as secret, fail-closed), so every memo of a Spark address or invoice is read without its length byte, and every description tag of a BOLT11 token (`bolt11Descriptions`). Tokens shorter than 20 characters or without the separator `1` are only screened by their visible text.
- **Inputs:** One string: a wallet detail field, a payment id, a decoded event path, or an event prop value.
- **Returns / side effects:** `true` when anything visible or encoded looks like secret material. Pure; never logs. A raw 32-byte value is not screened by shape (it looks like the hashes, ids and NIP-57 zap requests that are collected).
- **Used by:** `parseWalletReport` (payment id and detail fields) and `parseMemberEventBatch` (path and prop strings).

## Function: normalizeUuid

- **Purpose:** Shape check for ids from `crypto.randomUUID()` (`src/lib/uuid.ts`), shared by stores and routes that must not hand a malformed id to a Postgres `uuid` cast. `UUID_PATTERN` (eight-four-four-four-twelve hexadecimal characters, any letter case) moved here from `src/lib/pos-store.ts`.
- **Inputs:** A candidate id, for example a path or query parameter.
- **Returns / side effects:** The lowercase id when it has the UUID shape, otherwise `null`. No I/O.
- **Used by:** `GET /lnurlp/wait/:payment`, `POST /debug/shop-proofs/:id/retry`, `handleShopProof` (the `quote` value), `retryStuckProof`; `UUID_PATTERN` by `PostgresPosStore` and `PostgresShopPaymentStore`.

## Function: shopPairOrder

- **Purpose:** Request order of the shop payment method table (`SHOP_METHODS`: `Ethereum` 1, `Arbitrum` 42161, `Optimism` 10, `Polygon` 137, `Base` 8453, `BinanceSmartChain` 56; USDT and USDC contracts in lowercase; 6 decimals, 18 on `BinanceSmartChain`). USDT on `Ethereum`, `Arbitrum`, and `Polygon` come first, because Tether Wallet 1.11.0 pays those, then the remaining pairs in table order, USDT before USDC.
- **Inputs:** None.
- **Returns / side effects:** Every `{ method, asset }` pair of the table, in that order. No I/O.
- **Used by:** `candidatePairs`.

## Function: shopMethodByName

- **Purpose:** Find the method table row of an OpenCryptoPay method name, matched without regard to case, as DFX matches requests.
- **Inputs:** Method name from a request.
- **Returns / side effects:** The `ShopMethod` row, or `undefined`. No I/O.
- **Used by:** `handleShopProof` and the lookup duty of the shop payment watcher.

## Function: candidatePairs

- **Purpose:** Select the pairs a quote may request: in the table, named by Orchestra's route list (`chain` equals the row's `sourceChain`, `asset` the asset) with `exactOutTo` admitting `lightning:BTC`, the table contract and decimals, and an RPC endpoint for the chain. A route-list pair whose contract or decimals differ from the table is skipped and logs `shop.route.mismatch` (`paymentId`, `method`, `asset`).
- **Inputs:** Orchestra route assets, the configured RPC endpoints by chain id, and the id of the payment being created or whose quote is replaced (the creation picks it before its route-list read).
- **Returns / side effects:** Candidate pairs in `shopPairOrder` order. Logs only.
- **Used by:** The creation procedure and the quote replacement in `ShopPayments`.

## Function: decimalAmount

- **Purpose:** Write `units / 10^decimals` as a plain decimal string built from integers: no exponent, no trailing zero after the point, and no point for a whole number. It builds the fixed string `whole.fraction` (the fraction padded to `decimals` digits; no point for 0 decimals) and puts it through `canonicalDecimal(fixed, decimals)`, so the 6 and 18 decimals of the stablecoins share the trimming of `canonicalGoalAmount`.
- **Inputs:** A non-negative `bigint` amount in base units and the decimal places.
- **Returns / side effects:** For example `0.00001`, `1.5`, or `12`. No I/O.
- **Used by:** `btcAmount` and `transferAmountsFor` (stablecoin `amount` from `amountIn` and the token decimals).

## Function: btcAmount

- **Purpose:** Bitcoin amount of a whole sat count (`sats / SATS_PER_BTC`) as a plain decimal string.
- **Inputs:** Whole sats.
- **Returns / side effects:** `satsToBtcString(sats)` (always eight decimals) put through `canonicalDecimal(…, 8)`, for example `0.00001`; throws like `satsToBtcString` for a negative or fractional count. No I/O.
- **Used by:** `lightningTransferAmount` and `shopPayRequest` (`requestedAmount.amount`).

## Function: PlainJsonNumber

- **Purpose:** Marker class for a JSON number that must be written in plain notation, never `1e-8`, which `JSON.stringify` would write for a small number.
- **Inputs:** Constructor `text`: the digits in plain notation, for example `0.00000001`.
- **Returns / side effects:** An object with the read-only `text`. `shopJson` replaces it with the bare digits.
- **Used by:** `shopPayRequest` for `requestedAmount.amount`.

## Function: shopJson

- **Purpose:** Serialise a shop response body. Every `PlainJsonNumber` becomes a JSON number written as its plain digits; everything else is `JSON.stringify` output.
- **Inputs:** Any JSON-serialisable body.
- **Returns / side effects:** JSON text. No I/O.
- **Used by:** `shopResponse`.

## Function: shopResponse

- **Purpose:** JSON response of the pay link's shop answers and the LNURL shop routes, with the shop headers `SHOP_LNURL_HEADERS`: `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET, OPTIONS`, `Cache-Control: no-store`, plus `Content-Type: application/json`.
- **Inputs:** Body and HTTP status.
- **Returns / side effects:** A `Response` whose body is `shopJson(body)`.
- **Used by:** `ShopPayments` (pay link, callback), `shopError`, `proofResponse`, `GET /lnurlp/wait/:payment`.

## Function: shopErrorBody

- **Purpose:** The one error body of the callback, proof, and wait routes and of every pay-link error, readable by LUD-06 wallets (`status`, `reason`), DFX-built wallets (`statusCode`, `message`), Tether Wallet (`message`), and this repository's clients (`error`).
- **Inputs:** HTTP status and the error text.
- **Returns / side effects:** `{ statusCode, message: text, error: text, status: 'ERROR', reason: text }`. No I/O.
- **Used by:** `shopError` and `wellKnownRoutes` (`GET /lnurlp/:username` errors).

## Function: shopError

- **Purpose:** Error response with the shared shop error body and the shop headers.
- **Inputs:** HTTP status and the error text.
- **Returns / side effects:** `shopResponse(shopErrorBody(status, text), status)`.
- **Used by:** `ShopPayments.callback`, `handleShopProof`, `proofResponse`, and the callback, proof, and wait routes in `lnurlServerRoutes`.

## Function: noPendingPaymentBody

- **Purpose:** The OpenCryptoPay standard's 404 body for "no pending payment". Tether Wallet reads a 404 as "nothing is waiting" only when `standard` is `OpenCryptoPay` or `possibleStandards` contains it.
- **Inputs:** Pay-link username and shop name.
- **Returns / side effects:** `{ id, displayName, standard: 'OpenCryptoPay', possibleStandards: ['OpenCryptoPay'], displayQr: false, recipient: { name }, statusCode: 404, message: 'No pending payment found', error: 'Not Found', status: 'ERROR', reason: 'No pending payment found' }`.
- **Used by:** `ShopPayments.payLink` (`timeout` with nothing waiting, `method` without an open amount).

## Function: isExcludedShopUsername

- **Purpose:** Usernames that never get stablecoin rows: `invoice` collides with the invoice forward `GET /lnurlp/:username/invoice`, `cb` with Tether Wallet's `cb` → `tx` path rewrite, and a final `.` is cut off a hint URL by Tether Wallet.
- **Inputs:** Stored username.
- **Returns / side effects:** `true` for `invoice`, `cb`, or a name ending in `.`. No I/O.
- **Used by:** `ShopPayments.offersStablecoins` and `ShopPayments.payLink` (today's request for these usernames).

## Function: lightningTransferAmount

- **Purpose:** The Lightning entry of a quote's `transferAmounts`.
- **Inputs:** Payment sats.
- **Returns / side effects:** `{ method: 'Lightning', minFee: 0, assets: [{ asset: 'BTC', amount: btcAmount(sats) }], available: true }`.
- **Used by:** `transferAmountsFor` and the first and Lightning-only quote rows in `ShopPayments`.

## Function: transferAmountsFor

- **Purpose:** Build the `transferAmounts` array a quote serves and stores (`shop_quote.transfer_amounts`): Lightning first, then each offered method in method-table order, with one asset per offer, USDT before USDC.
- **Inputs:** Payment sats and the offers stored on the quote.
- **Returns / side effects:** The array. A stablecoin entry's `minFee` is the first offer's `min_fee` in wei as a number; each `amount` is `decimalAmount(amountIn, decimals)`; `available` is true. No I/O.
- **Used by:** `ShopPayments` when it inserts a quote.

## Function: quoteExpiration

- **Purpose:** Compute `quote.expiration`: the earliest of `window_ends_at` and every offer's `expiresAt` minus the 30 s funding margin (`SHOP_FUNDING_MARGIN_MS`); a quote without offers ends at `window_ends_at`.
- **Inputs:** Window end and the quote's offers.
- **Returns / side effects:** The expiry `Date`. No I/O.
- **Used by:** `ShopPayments` when it inserts a quote.

## Function: offerUri

- **Purpose:** The EIP-681 ERC-20 transfer URI of an offer's detail. `BinanceSmartChain` also uses `ethereum:` with chain id 56, as the standard states.
- **Inputs:** A stored offer.
- **Returns / side effects:** `ethereum:<token>@<chainId>/transfer?address=<deposit>&uint256=<amountIn>` with the lowercase contract and deposit address and decimal values.
- **Used by:** `offerDetail`.

## Function: proofUrl

- **Purpose:** The proof URL of a username, named in the detail's hint so that Tether Wallet finds it without the `cb` rewrite.
- **Inputs:** `PUBLIC_BASE_URL` without a trailing slash and the username.
- **Returns / side effects:** `<PUBLIC_BASE_URL>/lnurlp/tx/<username>`. No I/O.
- **Used by:** `offerDetail`.

## Function: offerDetail

- **Purpose:** The stablecoin detail of one offer, the four fields the standard and DFX return for an EVM chain.
- **Inputs:** Offer, its quote, `PUBLIC_BASE_URL`, and the username.
- **Returns / side effects:** `{ expiryDate: <quote expiry>, blockchain: <method>, uri: offerUri(offer), hint }`, where the hint reads `Pay this URI. Then send the transaction hash as tx, or the signed raw transaction as hex, with quote and method, to <proof URL>` with no punctuation after the URL.
- **Used by:** `ShopPayments.callback`.

## Function: shopPayRequest

- **Purpose:** The OpenCryptoPay pay request of an open amount; the contract's table is the complete body (no `commentAllowed`, `allowsNostr`, `nostrPubkey`, or `payerData`).
- **Inputs:** `ShopPayRequestInput`: username, shop name, today's metadata, `PUBLIC_BASE_URL`, the open payment, and its current quote.
- **Returns / side effects:** `{ id, tag: 'payRequest', callback: <base>/lnurlp/cb/<username>, minSendable, maxSendable (both sats × 1000), metadata, displayName, standard: 'OpenCryptoPay', possibleStandards, displayQr: false, recipient: { name }, quote: { id, expiration, payment }, requestedAmount: { asset: 'BTC', amount: PlainJsonNumber }, transferAmounts }`. Serialise it with `shopJson`.
- **Used by:** `ShopPayments.payLink`.

## Function: shopName

- **Purpose:** Shop display name, the same rule as `GET /pay/:username`.
- **Inputs:** The account (its `name`) and its username.
- **Returns / side effects:** The trimmed account name, or the username when the name is blank or missing.
- **Used by:** `ShopPayments.payLink` (`displayName`, `recipient.name`, the 404 body).

## Function: checkOffer

- **Purpose:** Apply the contract's offer checks to one committed Orchestra quote, in this order: `target` (`targetAmountOut` equals the sats), `amount` (`amountIn` a positive integer string), `bounds` (`amountIn` within `requiredAmountIn` and `maxAcceptedAmountIn` when present), `chain` (calldata present and `transaction.chainId` equals the table), `token` (`transaction.to` equals the table contract, lowercase), `value` (zero), `data` (exactly `transfer(depositAddress, amountIn)`, 68 bytes), `deposit_shared` (deposit address already used in the batch), `expiry` (`expiresAt` minus 30 s at least 45 s ahead), `bolt11_margin` (BOLT11 at least 600 s after `expiresAt`), `price` (a spot rate under 10 minutes old is present, and `amountIn` in USD is at most 5 % above the sats' value at it: the rate goes through `parseUsdPerBtc`, and the check is `amountIn × 10^16 × 100 ≤ sats × rate × 10^decimals × 105` in BigInt with no rounding; a `null` rate or one `parseUsdPerBtc` refuses fails it).
- **Inputs:** `OfferCheckInput`: pair, Orchestra quote, sats, BOLT11 expiry, batch deposit addresses, USD per BTC or `null` (no fresh spot), clock.
- **Returns / side effects:** `null` when every check holds, otherwise the name of the failed check. No I/O.
- **Used by:** `ShopPayments` (creation and replacement), which logs `shop.offer.rejected` with the check name.

## Function: proofWithinBounds

- **Purpose:** Whether a proof's transferred value lies within its offer's bounds: `requiredAmountIn` (or `amountIn`) up to `maxAcceptedAmountIn` (or `amountIn`). A dust transfer to a public deposit address therefore cannot take acceptance away from the payer.
- **Inputs:** Stored proof and its offer.
- **Returns / side effects:** `false` while the value is unknown; otherwise the bound check. No I/O.
- **Used by:** `evaluateProof`.

## Function: evaluateProof

- **Purpose:** Re-evaluate one proof after its order status, value, or payment changed (the contract's proof state table), inside a transaction whose caller holds the payment row and its proof rows (`lockPaymentForProofs`); it takes no lock itself. A final order status maps to a result: `completed` → `accepted` (a previously accepted proof of the payment moves to `superseded` first), `refunded` → `refunded`, `failed` and `fallback_delivered` → `failed` (`shop.alert.order_failed`), `expired` → `refused` with `expired_order`. Each final result moves only from the results the States table allows (`FINAL_FROM`): `accepted` from unresolved, `superseded`, `late`, `refused`, or `stuck`; `refunded` and `failed` from those or `accepted`; `refused` from unresolved, `accepted`, `superseded`, `late`, or `stuck`; any other result leaves the proof unchanged. A progressing status (`ORCHESTRA_PROGRESSING_STATUSES`) moves an unresolved, `refused`, `stuck`, or `superseded` proof (`PROGRESS_FROM`, States row 1): it makes an unresolved, `refused`, or `stuck` one `late` after the payment closed (`shop.alert.late_deposit`; a `superseded` one stays), leaves it held while the payment is `paid` or the value is unknown or out of bounds, and otherwise makes it `accepted` when no other proof of the payment is `accepted`, so a `superseded` proof whose order resumed takes the place once none is. While another proof is `accepted`, an open proof becomes `superseded` and a `superseded` one stays as it is, without a second log line.
- **Inputs:** `ShopTx`, proof id, clock.
- **Returns / side effects:** The proof as it is now, or `null` when it does not exist. Acceptance moves the payment from `open` or `ended` (not closed) to `accepted` (`shop.payment.accepted`). An accepted proof that becomes `refunded`, `failed`, or `refused` while the payment is neither `paid` nor closed is replaced in the same transaction by the oldest `superseded` proof of the payment (earliest `created_at`, then `id`) whose order is progressing and whose amount is known and within the bounds (States row 3; the payment stays `accepted`, `shop.proof.accepted`); only when none qualifies does the `accepted` payment end with `orchestra_refunded`, `orchestra_failed`, or `proof_refused`. Logs `shop.proof.<result>` with `paymentId`, `proofId`, `offerId`, `quoteId`, `providerRef`, and `orderId` when the proof holds an order.
- **Used by:** `recordProofOrder` and the proof module's fill and merge steps.

## Function: refuseProof

- **Purpose:** Record a proof `refused`, because its `hex` transaction was rejected or reverted (`hex_rejected`), Orchestra refused the submit with `xchain_deposit_mismatch` (`mismatch`), or it is the row being filled in (the later fill) when another offer's row already holds that deposit's log index or order, or the newer of two rows of different offers, of the same payment or of two payments, when a submit or status answer returns an order the other row holds (`tx_used`). Moves only from the results the States table allows for `refused` (unresolved, `accepted`, `superseded`, `late`, or `stuck`); any other result leaves the proof's result unchanged; with an heir its order is then handed to the heir, unless the order already ended this proof (the heir is then refused `tx_used`). An `accepted` proof that is refused hands its place to an heir of the same payment only when the heir's evaluation accepts it (a progressing order or `completed`, States row 1); otherwise, and always for an heir of another payment (which is evaluated on its own payment), the oldest eligible `superseded` proof of the refused proof's payment takes its place, else the `accepted` payment ends with `proof_refused`. An heir that is not accepted (`refunding`, `unfulfilled`, an unknown status) stays held until the States table accepts it or its order is final; acceptance is never inherited.
- **Inputs:** `ShopTx` (the caller holds the payment row and its proof rows, `lockPaymentForProofs`; for an heir of another payment both payment rows and their proof rows, `lockPaymentsForProofs`), proof id, refusal (`mismatch`, `hex_rejected`, or `tx_used`), clock, optional `heir` (`{ proofId, order: { orderId, status }, foundAt }`, default `null`): the older row of the same deposit that takes the refused row's order (step 3), the status it records, and the `order_found_at` it keeps (`null` for now).
- **Returns / side effects:** The refused proof (`refusal`, `resolved_at` set, next submit and next receipt read cleared; for `tx_used` also the next status read, so the order-status duty stops following a deposit Orchestra counted on another offer, while `provider_order` is kept), the proof with its result unchanged when its result does not allow the move (with an heir: when its order ended it, that is `refunded`, `failed`, `refused` with `expired_order`, or a stored final status, the order stays with this proof and the heir is refused `tx_used` instead, its next submit cleared whatever its result; a proof `refused` for another reason whose order is not final gives up `provider_order` and `order_status`, guarded on `refused`, and the heir records the order through `recordProofOrder`), or `null` when it does not exist. With an heir, the refused row then gives up `provider_order` and `order_status`, the heir records the order through `recordProofOrder` with the given status and `foundAt` (its submits stop, its status reads start) and is evaluated; an `accepted` refused row hands its place to an heir of the same payment only when that evaluation accepts it; whenever the heir is not `accepted` afterwards, or belongs to another payment (a `refunding`, `unfulfilled`, or unknown status holds it, its amount is out of the bounds, or a final status other than `completed`), the oldest eligible `superseded` proof takes the place, else the payment ends with `proof_refused`; a later `completed` order accepts the held heir and moves an `ended` payment that is not closed back to `accepted`. Logs `shop.proof.refused` with the refusal and the proof's `paymentId`, `proofId`, `offerId`, `quoteId`, `providerRef`, and `orderId` when it holds one.
- **Used by:** `refuseHexProof`, `submitProofAttempt`, and the private `mergeDeposit` and `mergeOrderHolder` (`tx_used`, the latter with an heir) in `src/lib/shop-proof.ts`.

## Function: recordProofOrder

- **Purpose:** Store an Orchestra order on a proof (`provider_order`, `order_status`, the submits stop) and re-evaluate the proof with `evaluateProof`. A proof without an order also gets `order_found_at` (the given found time, or now) and its first status read 10 s ahead; a final status (`completed`, `refunded`, `failed`, `fallback_delivered`, `expired`) clears `next_status_at`. A status that is neither final, progressing, `refunding`, nor `unfulfilled` logs `shop.orchestra.error` with `reason: unknown_status` once per order per process. A proof that already holds this order with a final status keeps it: a final status is terminal (as `mergeDeposit` keeps one), so a status of the same order read before it, in progress or another final one, writes nothing, does not re-evaluate the proof, and leaves `next_status_at` empty; a different order id is recorded as before. It does not check whether a status read may still be applied: the order-status duty decides that under the locks before it calls here (`followsOrderStatus`), so a proof the duty stopped, a `refused` `tx_used` one included, is never moved by a late read. A `tx_used` refusal is not final in the States table (`evaluateProof` is unchanged), so the other callers (a submit answer, a merge, an heir's hand-off) record as before.
- **Inputs:** `ShopTx` (the caller holds the payment row and its proof rows, `lockPaymentForProofs`), proof id, `{ orderId, status }`, clock, optional found time (`Date | null`, default `null`: now), which `refuseProof` passes for an heir so the holder's `order_found_at` carries over.
- **Returns / side effects:** The proof after `evaluateProof`, the proof unchanged when it already holds this order with a final status, `null` when it does not exist, or `'conflict'` when another row already holds that order id (nothing changed; the caller merges). The unknown-status line carries `paymentId`, `proofId`, `offerId`, `quoteId`, `providerRef`, and `orderId`.
- **Used by:** `applyProofOrder` and `refuseProof` (for an heir).

## Function: dfxPaymentStatus

- **Purpose:** Map a shop payment to DFX's `PaymentLinkPaymentStatus`. As at DFX, every status except `Pending` is final.
- **Inputs:** A stored payment.
- **Returns / side effects:** `Completed` when `paid`; for an `ended` payment with `closed_at` set, `Cancelled` when `end_reason` is `superseded`, `replaced`, or `cancelled`, otherwise `Expired`; else `Pending`.
- **Used by:** `waitBody` and `ShopPayments.wait`.

## Function: waitBody

- **Purpose:** Body of `GET /lnurlp/wait/:payment`.
- **Inputs:** A stored payment.
- **Returns / side effects:** `{ status: dfxPaymentStatus(payment), paymentStatus: payment.status, invoiceExpiresAt: <BOLT11 expiry, ISO> }`. No I/O.
- **Used by:** `ShopPayments.wait`.

## Function: ShopPayments

- **Purpose:** Shop payment service in USDT and USDC, one instance per process, built when the LNURL server resolves (`createApp`, `src/index.ts`). Holds the per-account in-process creation locks, the two creation counters (`IpRateLimiter`: 60 per minute for the api under one fixed key, asked first, then 10 per minute per account), the 60 s no-pair waits, the cached route list (reused only until Orchestra's `validForMs` has passed since the request started, fetched with a 1 s timeout), and the count of waiting pay-link requests (at most 50). Every row change goes through `ShopPaymentStore.transaction`; every external call (LNURL server, Orchestra, EVM RPC) runs outside a transaction.
- **Inputs:** `ShopPaymentsDeps`: `store`, `posStore` (the charge store the shop store's charge calls reach; step 4's `recordInvoice` and the payer's `findChargeForPayment`), `auth`, `lnurlServer`, `config` (`resolveShopPaymentConfig` or `null`), `orchestra` (`OrchestraClient` or `null`), `fxSpot` (the `FxSpotStore` that `startFxSpotWorker` refreshes; without a USD rate younger than 10 minutes no stablecoin pair is offered), `fetchImpl`, `now`, optional `newId` (default `crypto.randomUUID`) and `sleep`.
- **Creation:** `createForCharge(account, username, charge, requestArrivedMs)` and `createForPayer(account, username, amountSats, requestArrivedMs, signal?)` run the procedure under the account lock (queued behind the account's running creation or quote replacement). `createForCharge` goes through the private `#chargeCreation`, which keeps one in-flight creation promise per charge id from the moment it is queued until it ends, also on a throw, like the in-flight map of `translate-note.ts`: a caller for a charge that already has one joins it instead of queueing another run, and the run keeps the arrival of the request that started it. The procedure (lock order: account row, then `pos_charge` rows, then `shop_payment` rows, in every transaction that takes both kinds): the re-check transaction (`#createLocked`) takes the account row lock first, then the charge row lock for a charge, or for a payer `pendingCharge`, which expires the account's overdue pending charges, and only then ends a lapsed `open` payment (`window`); a charge with a shop payment returns it, a charge no longer pending is `skipped`, a payer with a pending charge is `pending_charge`; `offersStablecoins`, the no-pair wait, and the counters give `unavailable`; the route list (reused only until its `validForMs` has passed since the request started; a failed fetch, or one the routes budget refuses, → `unavailable` without the wait) and `candidatePairs` (none → `unavailable` and the 60 s wait); one mint with `requestGiftInvoice` and a 4 s deadline (`mint_failed` on failure or another amount); a payment hash a shop payment already holds is `mint_failed` with `shop.alert.duplicate_invoice` (`paymentId` of this creation, and `holderPaymentId` and `holderChargeId` when known), except that the charge's own shop payment is returned and the procedure ends; for a charge `posStore.recordInvoice` in its own claim transaction, outside any shop transaction (`other_payment` → `mint_failed` with the alert, `not_open` → `skipped` without it, `recorded` or `this_charge` goes on; an error logs `pos.invoice.record_failed` with `accountId` and `paymentId`, writes nothing, and is `skipped`, so a fetch answers today's pinned request); for a payer `posStore.findChargeForPayment({ paymentHash })` (a hit → `mint_failed` with the alert, an error → `unavailable`, order 9, nothing written); the stored spot (`fxSpot.latest()`, never a fetch): without a USD rate whose `asOf` is younger than `SHOP_SPOT_MAX_AGE_MS` (10 minutes) no gas price or quote is requested and each pair `quoteBudgetLeft()` allows logs `shop.offer.rejected` with `check` `price`; otherwise gas prices and Orchestra quotes in parallel within 3 s for as many pairs as `quoteBudgetLeft()` allows, kept by `checkOffer` (with the rate while it is still younger than 10 minutes at the check, else `null`) and a readable gas price (`minFee` = `recommendedMinFee`); a failed quote logs `shop.offer.rejected` with `check` `body` (an HTTP 200 whose body does not parse), `http` (a request sent without an HTTP 200), or `budget` (no request could be sent); none → `unavailable` and the 60 s wait; then one transaction that takes `ShopTx.claimPaymentHash`, then the account row lock, then the charge row lock; after the locks it writes nothing and answers `unavailable` (order 9) when the request arrived `SHOP_CREATION_INSERT_LIMIT_MS` (16 s) or longer ago or, for a payer, its abort signal is set; a `pos_charge_invoice` row of another charge (always for a payer) stops it before anything is ended or inserted (`mint_failed`, `shop.alert.duplicate_invoice`); it then reads the payment holding the BOLT11's hash (this charge's own payment is used; any other holder rolls the whole transaction back, logs `shop.alert.duplicate_invoice`, deletes the charge invoice row only when this attempt recorded it, and answers `mint_failed`, so an `open` payment it ended stays `open`), ends the account's `open` payment (`window`, `superseded`, or `replaced`), inserts the payment (window = charge `expiresAt`, or five minutes for a payer), its first quote, and its offers (`ON CONFLICT (deposit_address)` drops an offer and logs `shop.alert.shared_deposit_address`), and resolves a lost insert on the payment hash; when the insert is refused because another charge's invoice row claimed the hash after the check (a memory boot's `InMemoryPosStore.recordInvoice` does not wait for the transaction), the whole transaction rolls back, so nothing stays ended or inserted, and it answers `mint_failed` with `shop.alert.duplicate_invoice`. `startForCharge(account, charge, requestArrivedMs)` runs the charge creation in the background through `createForCharge`, so it registers the charge's in-flight creation and a scan right after `POST /pos` joins it (`#chargeCreation` logs `shop.creation.failed` once with `accountId`, `chargeId`, and the error's `name`, `code`, and `errno` when the run throws, whether `POST /pos` or a pay-link fetch started it or joined it; the fetch then answers from the state). Logs `shop.payment.opened`, `shop.mint.failed`.
- **Pay link and quotes:** `payLink(account, username, metadata, query, arrivedMs)` answers an excluded username (`isExcludedShopUsername`) with `{ kind: 'today', pinSats }` at once, pinned to its pending charge's amount when it has one, so `timeout` and `method`/`asset` never reach the 404 there. Otherwise it applies the `timeout` wait (digits only, at most 10 s, every `WAIT_SATS_POLL_MS`), starts or joins the charge's in-flight creation (`#chargeCreation`, which keeps the arrival of the request that started it) for a pending charge without a shop payment and races it against one sleep that ends `SHOP_PAY_LINK_CREATION_WAIT_MS` (8 s, as long as `SHOP_CREATION_BUDGET_MS` and separate from it) after `arrivedMs`, the fetch's arrival that `wellKnownRoutes` takes as the route's first statement. The wait therefore counts the wallet pay request, the `timeout` wait, lock waits (a creation queued behind a payer creation, another charge's creation, a quote replacement, or a holder that does not finish), and whatever else the creation waits for. A creation that outlasts the wait goes on in the background; one that ends earlier (payment exists, charge no longer pending, a failure) ends the wait right away. A request that reaches this point 8 s or more after `arrivedMs` (a `timeout` wait) still starts or joins the creation but does not wait and answers today's pinned request from the charge it found. The 50-request cap applies only to the `timeout` wait. After a wait it reads the state again whatever the creation's outcome; when the open payment left `open` during the request (before its quote was read, or, with `method`, before the callback read the state: the private `#callback` with the payment id answers `null` instead of 404 `Quote expired` when that payment is no longer the open amount), it also reads the state again: another payment that is the open amount now is answered as the open amount, once per request (the private `#openAmountAnswer` with `retried`), and otherwise, or when that one also left `open`, a charge still waiting keeps its pin. It answers `{ kind: 'response' }` (pay request, simplified-flow detail, or 404 `noPendingPaymentBody`) or `{ kind: 'today', pinSats }`. `currentQuote` replaces a quote under the creation lock (stablecoin entry, under 45 s left, at least 45 s of window left, fewer than 4 replacements; route list, gas prices, and quotes until `SHOP_REPLACEMENT_COMMIT_MARGIN_MS` (500 ms) before its 4 s `SHOP_REPLACEMENT_BUDGET_MS`, so its transaction normally commits inside the fetch's wait; then, under the account row lock and only while the payment's newest quote is still the one it started from, one conditional `replacements` increment and the quote, Lightning-only when no offer passes; when no quote request was sent (no route list, no candidate pair, no fresh spot, or no budget) the same conditional update leaves `replacements` unchanged, because a Lightning-only row made without an Orchestra call is not a replacement; a newer quote, such as a fetch's Lightning-only row, is answered as it stands; a run that throws logs `shop.creation.failed` once with `accountId`, `paymentId`, and the error) and inserts a Lightning-only quote row for an expired quote. Both transactions read the clock after the account row lock. It starts or joins the payment's in-flight replacement through the private `#replacement`, which keeps one per payment id (`{ promise, startMs }`, `startMs` `null` while queued, reported by `#replace`'s `onStart`) until it ends, also on a throw, and races it against one sleep that ends at the earlier of `SHOP_REPLACEMENT_BUDGET_MS` (4 s) after the fetch reached this step and 4 s after the replacement took the lock (no wait once that is used up). A replacement that outlasts the wait (one that took the lock after the fetch arrived, or whose transaction queues on the account row), or throws, leaves the fetch to read the payment again: the current quote while it is valid, else the Lightning-only row; the replacement goes on in the background and, when its transaction lands after that row, inserts nothing. `callback` serves `GET /lnurlp/cb/:username` through `#callback` without a payment id, so its answers do not change (amount path and detail table; a `quote` that is not a UUID, or one of a payment that is not the open amount, is 404 `Quote expired`; first detail sets `detail_issued_at` and, when unset, `next_history_at` 10 s ahead). `wait` serves `GET /lnurlp/wait/:payment`. `offersStablecoins(username)` is true when config and Orchestra are set and the username is not excluded.
- **Till and settlement:** `createCharge(account, row, requestArrivedMs)` (`POST /pos`; `false` when a pending charge exists; the background creation counts its 16 s from the request's arrival), `cancelCharge` (`DELETE /pos`), `chargePaid` (charge watch: locks the charge's current account row, reading the charge again after each account lock and following an account merge that moved it, at most two account locks (a charge gone or still moving changes nothing and is read again on the next tick), then the charge row, whose state before the update it keeps, then marks the charge paid and locks the `shop_payment` row; the payment's own hash → `markPaymentPaid` with that earlier charge state, so a charge already paid by another invoice logs `shop.alert.double_settled` and a cancelled one `shop.alert.cancelled_settled`; Spark or another BOLT11 → an `open` payment ends `charge_paid`), and `shopPaymentOfCharge` (`GET /pos`) run under the account row lock. `applySettlement(paymentId, settled, nowMs)` locks a charge-backed payment's account with `lockAccountOf` (a payment still moving after two locks is left for the next tick), then its `pos_charge` row, then its `shop_payment` row; a payer's payment locks only its `shop_payment` row; no proof row is locked. It then applies one settlement read: settled → `paid` and `markPaid` of the charge; unpaid at or after the final read (10 minutes after the BOLT11 expiry) → closed (`accepted` ends `expired_unpaid` with `shop.alert.accepted_unpaid`, `open` ends `window`, both log `shop.payment.ended` with the reason, then `shop.payment.closed`); otherwise the next read in 5 s (`SHOP_SETTLE_FAST_INTERVAL_MS`, also the first read after creation) during the first 15 minutes (`SHOP_FAST_SETTLE_MS`), then 30 s (`SHOP_SETTLE_SLOW_INTERVAL_MS`), never past the final read. Getters `store` and `deps` and `newId()` serve the proof and watcher modules.
- **Used by:** `createApp`, `src/index.ts`, `wellKnownRoutes`, `lnurlServerRoutes`, `payRoutes`, `posRoutes`, `debugShopProofsRoutes`, `runPosPaidTick`, `startShopPaymentWorker`, and `src/lib/shop-proof.ts`.

## Function: lockAccountOf

- **Purpose:** Lock the account a shop payment belongs to when that account id came from a read without a lock. An account merge can move a paid or closed payment between that read and the lock.
- **Inputs:** `ShopTx`, the payment id, and the account id from the unlocked read.
- **Returns / side effects:** Locks the account, reads the payment again, and when it moved, locks the account it moved to and reads again: at most two account locks. `true` when the payment's current account is locked (no merge can move it while that lock is held, because a merge locks both accounts first); `false` when the payment is gone or moved again after the second lock. It never locks the payment row while waiting for an account lock.
- **Used by:** `ShopPayments.applySettlement` for a charge-backed payment. Proof transactions lock no account row (`lockPaymentForProofs`).

## Function: lockPaymentForProofs

- **Purpose:** Take the locks every transaction that changes a proof's result needs, as its first statements (Storing and submitting): the payment's `shop_payment` row (`lockPayment`, `SELECT … FOR UPDATE`), then every proof row of the payment with one `SELECT … FOR UPDATE` ordered by id (`lockProofs`). Two decisions about one payment therefore never run at the same time, also across two containers.
- **Inputs:** `ShopTx` and the payment id.
- **Returns / side effects:** `{ payment, proofs }` (the proofs ordered by id), or `null` when the payment does not exist, in which case no proof row is locked. No account row is locked, so a proof transaction never waits for an account while it holds a payment row, and the settlement step (account, `pos_charge`, `shop_payment`) locks no proof row: the two never wait for each other in opposite order. All proof rows of the payment are locked, a superset of the rows the transaction changes, because the evaluation and the replacement by a `superseded` proof decide which rows change only after reading them.
- **Used by:** `src/lib/shop-proof.ts` (`storeProof`, the answer of `submitProofAttempt`, `refuseHexProof`, `readProofReceipt`, `retryStuckProof`) and `src/lib/shop-payment-worker.ts` (`patchProof`: the schedule writes of the receipts and submits duties and the order-status duty's stops; the stuck duty, the order-status duty with its step for a replaced order, and the orders duty's `next_history_at` decision).

## Function: lockPaymentsForProofs

- **Purpose:** The locks of a transaction that changes proofs of two payments (step 3: a submit answered with an order that a newer row of another payment holds): every named payment's `shop_payment` row (`lockPayment`, `SELECT … FOR UPDATE`) one by one in the order of their ids, then every proof row of those payments with one `SELECT … WHERE payment_id = ANY($1::uuid[]) ORDER BY id FOR UPDATE` (`lockProofsOf`).
- **Inputs:** `ShopTx` and the payment ids, in any order; a payment named twice is locked once.
- **Returns / side effects:** `{ payments, proofs }`: the payments that exist, by id, and their proofs, by id. A payment that does not exist is left out and its proof rows are not locked; with none left, no proof row is locked. Two such transactions on the same two payments take the payment rows in the same order, so they never wait for each other in opposite order; a transaction that locks one payment (`lockPaymentForProofs`) waits for at most that row before its proof rows, and proof rows are locked only after their payment row. No account or `pos_charge` row is locked, so the settlement step (account, `pos_charge`, `shop_payment`) and a proof transaction never wait for each other in opposite order. The two statements that write several existing `shop_payment` rows lock them in the same id order: `endLapsedWindows` (`SELECT … ORDER BY id FOR UPDATE`, then one `UPDATE` of the locked ids) and `mergeAccounts` (the merged account's payment rows, `SELECT … ORDER BY id FOR UPDATE`, after both account rows and all of the merged account's charge rows (`SELECT … ORDER BY id FOR UPDATE`) and before the charge delete and the catalog update); every other transaction locks or writes at most one existing `shop_payment` row.
- **Used by:** The answer of `submitProofAttempt` in `src/lib/shop-proof.ts`, when the answered order is held by a row of another payment.

## Function: endPayment

- **Purpose:** End an `open` shop payment with a reason, as one conditional update on `status = 'open'`.
- **Inputs:** `ShopTx`, the payment, the end reason (`window`, `superseded`, `replaced`, `cancelled`, `charge_paid`, …), clock.
- **Returns / side effects:** The ended row (`ended_at`, `end_reason` set), or `null` when it was no longer `open`. Logs `shop.payment.ended` with the reason when it changed the row.
- **Used by:** `ShopPayments` (creation, `createCharge`, `cancelCharge`, `chargePaid`).

## Function: markPaymentPaid

- **Purpose:** Move a shop payment to `paid` because its BOLT11 settled: one conditional update from `open`, `ended`, or `accepted` on a payment that is not closed, clearing `ended_at`, `end_reason`, and `next_settle_at`.
- **Inputs:** `ShopTx` (the caller holds the account row, then the charge row, then the payment row; a payer's payment only its row), the payment, clock, and `{ before, marked }`: `before` is the payment's charge as the caller locked it before any change in this transaction (`null` for a payer's payment), `marked` is `true` when the caller (the charge watch) already marked that charge paid.
- **Returns / side effects:** The `paid` row, or `null` when this call did not move the payment (already paid, closed, or gone; then nothing else happens). Logs `shop.payment.paid`. Then, from `before`: a `cancelled` charge logs `shop.alert.cancelled_settled` and stays cancelled; a charge already `paid` (by another invoice, since this payment was still unpaid) logs `shop.alert.double_settled`; otherwise, unless `marked`, `markChargePaid`. Both alerts carry `paymentId` and `chargeId`.
- **Used by:** `ShopPayments.chargePaid` and `ShopPayments.applySettlement`.

## Function: migrateShopPaymentSchema

- **Purpose:** Apply the idempotent `SHOP_PAYMENT_SCHEMA_SQL` in order: `shop_payment` (one row per shop BOLT11, with the status, end-reason, and timestamp checks of the contract), its partial unique index `shop_payment_account_open_idx` (one `open` payment per account) and the history and settle watch indexes; `shop_quote` with `transfer_amounts jsonb` and its `(payment_id, created_at)` index; `shop_offer` with `numeric(78, 0)` amounts, `UNIQUE (quote_id, method, asset)` and the unique `shop_offer_deposit_idx`; `shop_proof` with its source/result checks, the unique `shop_proof_log_idx`, `shop_proof_unlogged_idx`, `shop_proof_order_idx`, and `shop_proof_payment_accepted_idx`, plus the user-operation and watcher indexes and the partial `shop_proof_superseded_idx` on `payment_id` where `superseded_by_order` is set; `shop_payment.successor_wait_until` and `shop_proof.superseded_by_order` are nullable columns; and `shop_proof_lookup` with `UNIQUE (chain_id, hash, quote_id)` and its due index. Every statement is `CREATE … IF NOT EXISTS`; `docs/schema/shop_payment.sql` mirrors the DDL byte for byte apart from its header comment.
- **Inputs:** A `SqlClient`. `account` and `pos_charge` must exist first (`migrateAuthSchema`, `migratePosSchema`).
- **Returns / side effects:** Resolves when every statement has run. Runs before `migrateDbChangeSchema`, so `trg_db_change` covers the five new tables and every write lands in `db_change`. No column holds a secret.
- **Used by:** `openBootStores` when `DATABASE_URL` is set, and the Postgres driver test.

## Function: followsOrderStatus

- **Purpose:** Tell whether the order-status duty (duty 8) follows a proof: it holds an order (`provider_order`), its next status read (`next_status_at`) is set, and it is not `refused` with `refusal` `tx_used`. Every stop of the duty (a final status, the 24 h stop, a replaced order, a `tx_used` refusal) clears `next_status_at` or the order, so a stopped proof fails it. The in-memory `dueProofs('status', …)` selects the proofs it admits whose `next_status_at` is due; the Postgres `WHERE` states the same conditions in SQL, and the Postgres driver test pins the two equal over every combination of order, `next_status_at`, and result.
- **Inputs:** A proof (`providerOrder`, `nextStatusAt`, `result`, `refusal`).
- **Returns / side effects:** `true` while the duty follows the proof. Pure.
- **Used by:** `InMemoryShopPaymentStore.dueProofs` (status duty) and the worker's status read (`runShopPaymentTick`, duty 8), which applies a read only while the proof, read again under its locks, still meets it.

## Function: InMemoryShopPaymentStore

- **Purpose:** Process-local `ShopPaymentStore` for unit tests and boots without `DATABASE_URL`. Always starts empty. `transaction` runs whole callbacks one at a time in call order (a promise chain), so locks are not needed and `lockAccount` is a no-op; `lockProofs` and `lockProofsOf` return copies of the payment's (payments') proofs ordered by `id`; a rejected callback restores all five shop tables to the snapshot taken before it ran, releases the shop side of every payment hash its inserts claimed, and rethrows. Charge calls delegate to the given `PosStore`: `pendingCharge` → `currentPending`, `insertCharge` → `create` (its `A payment is already open` refusal becomes `false`, other failures propagate), `cancelPendingCharge` → `cancelPending`, `markChargePaid` → `markPaid`, `chargeIdForInvoice`, `lockCharge`, and `getCharge` (an unlocked read) → `findChargeForPayment`, `deleteChargeInvoice` → `deleteInvoice`. Charge changes are not undone by a rollback.
- **Inputs:** A `PosStore` (the boot's in-memory charge store) and an optional `PaymentHashClaims` map (default: the `paymentHashClaims` of an `InMemoryPosStore`, else a new map).
- **Payment hash claim:** The claim is the shared in-process map, so `claimPaymentHash` is a no-op. `insertPayment` reads the map and adds its entry in the same synchronous step as the insert: a hash held by another payment, or by the invoice row of a charge other than the row's `pos_charge_id`, answers `false`; the charge's own invoice row (step 4) does not.
- **Unique rules:** Enforces the same unique indexes as the DDL: `insertPayment`, `insertProof`, and `insertLookup` answer `false` on a duplicate id, `payment_hash`, `pos_charge_id`, second `open` payment of an account, proof log / unlogged / order / accepted-per-payment index, or `(chain_id, hash, quote_id)`; `insertOffers` drops an offer whose deposit address is taken; `updateProof` answers `'conflict'` and changes nothing when the patch would hit a proof index. `insertQuote`, a duplicate `(quote_id, method, asset)` offer, and an `updatePayment` that would open a second payment of the account throw an error with code `23505`, as Postgres does.
- **Returns / side effects:** Every row handed out or stored is a `structuredClone` copy (dates and `transferAmounts` included). Lists order as the Postgres store does: quotes, proofs, offers, and unsettled payments by `createdAt` then `id`; duty scans by their own next-try column then `id` (settlement puts `accepted`, then charge-backed payments first). Calling `transaction` inside a transaction never resolves.
- **Used by:** The boot in `src/index.ts` without `DATABASE_URL` (the store of its `ShopPayments`), the `ShopPayments` default in `createApp` (`src/server.ts`), and unit tests.

## Function: PostgresShopPaymentStore

- **Purpose:** Durable `ShopPaymentStore` on the five shop tables. `transaction` is one `MergeDb.begin` (a reserved connection, `sql.begin` in Bun); every `ShopTx` call runs on that connection, and a rejected callback rolls the whole transaction back. Charge calls run through a `PostgresPosStore` bound to the same connection, so expire-due, `pos.create` / `pos.expired` / `pos.cancel` / `pos.paid` logging and the conditional statements are exactly those of the till store; `lockCharge` first takes `SELECT id FROM pos_charge … FOR UPDATE`; `getCharge` reads the charge through the same `findChargeForPayment` without a lock.
- **Inputs:** The boot's `SqlClient` (unused by the store; kept for boot symmetry) and the `MergeDb` transaction port.
- **Locks and conflicts:** `claimPaymentHash` runs `SELECT pg_advisory_xact_lock($1, $2)` with `PAYMENT_HASH_LOCK_NAMESPACE` and `paymentHashLockKey(hash)`, held until the transaction ends. `lockAccount`, `lockCharge`, `lockPayment`, and `lockQuote` use `SELECT … FOR UPDATE`, held until the transaction ends; `lockProofs` locks every proof row of a payment in one `SELECT … ORDER BY id FOR UPDATE`, and `lockProofsOf` every proof row of several payments in one `SELECT … WHERE payment_id = ANY($1::uuid[]) ORDER BY id FOR UPDATE` (the ids bound as one `uuid[]` literal; malformed ids are skipped, none left queries nothing). `insertPayment`, `insertProof`, and `insertLookup` are `INSERT … ON CONFLICT DO NOTHING RETURNING id` (`false` when nothing was inserted); `insertOffers` runs one `INSERT … ON CONFLICT (deposit_address) DO NOTHING` per offer and returns the inserted ones in input order. `updateProof` and `insertCharge` run under `SAVEPOINT shop_store_guard`: a unique violation (`isUniqueViolation`) rolls back to it and answers `'conflict'` / `false`, so a lost race never aborts the transaction; any other error propagates.
- **Updates:** `updatePayment`, `updateProof`, and `updateLookup` are one `UPDATE … WHERE id = $1 AND <conditions> RETURNING …` that writes only the patch keys that are present (from a fixed key-to-column map; an explicit `null` writes `NULL`, an empty patch writes `id = id`). `statuses` and `results` bind one text-array literal (`= ANY($n::text[])`, with `result IS NULL OR …` when `null` is listed). `updateQuote` replaces `expires_at` and `transfer_amounts`; `endLapsedWindows` ends lapsed `open` payments in one statement that first locks them in the order of their ids (`WITH due AS MATERIALIZED (SELECT id … ORDER BY id FOR UPDATE) UPDATE … WHERE id IN (SELECT id FROM due) AND status = 'open' AND window_ends_at <= $1 RETURNING …`), the order `lockPaymentsForProofs` takes payment rows in.
- **Returns / side effects:** `numeric(78, 0)` columns map to decimal strings, integer columns to numbers, `transfer_amounts` to the array (parsed jsonb or JSON text), timestamps to fresh `Date`s; instants are bound as ISO strings. A malformed UUID passed to a get, lock, find, list, or update method answers `null`, `[]`, `0`, or `false` without a query (`UUID_PATTERN`); an upper-case UUID is accepted. `offersOf` orders by `created_at, id` (the table has no insertion-sequence column). Every write lands in `db_change` through `trg_db_change`.
- **Used by:** The boot in `src/index.ts` when `DATABASE_URL` is set (the store of its `ShopPayments`).

## Function: OrchestraClient

- **Purpose:** Client for the Orchestra calls of the shop stablecoin payment (`src/lib/orchestra.ts`): `routes` (`GET /v2/orchestration/routes`), `quote` (`POST /v1/orchestration/quote`, exact out to the payment's BOLT11), `submit` (`POST /v1/orchestration/submit` with `{ quoteId, txHash }` only), `history` (`GET /v1/orchestration/history?address=<BOLT11>&limit=200&offset=…`, one page per call), and `status` (`GET /v1/orchestration/status?id=<orderId>`). It also exports the budgets (`ORCHESTRA_QUOTES_PER_MINUTE` 240, `ORCHESTRA_SUBMITS_PER_MINUTE` 30, `ORCHESTRA_PROOF_SUBMITS_PER_MINUTE` 20, `ORCHESTRA_STATUS_READS_PER_MINUTE` 50, `ORCHESTRA_ROUTES_PER_MINUTE` 25) and the status sets `ORCHESTRA_FINAL_STATUSES` (`completed`, `refunded`, `failed`, `fallback_delivered`, `expired`) and `ORCHESTRA_PROGRESSING_STATUSES` (`processing`, `confirming`, `awaiting_approval`, `swapping`, `bridging`, `delivering`).
- **Inputs:** `OrchestraClientDeps` (`baseUrl` = `ORCHESTRA_BASE_URL` origin, `apiKey` = `ORCHESTRA_API_KEY`, `fetchImpl`, `now`, optional `sleep`, default `setTimeout`). Every call sends `Authorization: Bearer <apiKey>`, uses `redirect: 'error'`, and aborts after its timeout; `quote` and `submit` add `Content-Type: application/json` and `X-Idempotency-Key`. The quote body is `sourceChain`, `sourceAsset`, `destinationChain` `lightning`, `destinationAsset` `BTC`, `amount` (sats as an integer string), `amountMode` `exact_out`, `recipientAddress` (BOLT11), `tag`, `refundAddress`, and `includeCalldata` true, without `slippageBps`. `quote` takes an absolute `deadlineMs`; each attempt's timeout is the time left. `submit` takes the caller (`proof-first`, `proof-repeat`, or `watcher`).
- **Returns / side effects:** `routes` → `{ ok, assets, validForMs }` (`exactOutToLightning` true for `all`, an array with `lightning:BTC`, or `{ except }` without it; contract addresses lowercase; ill-typed assets left out) or `{ ok: false }`. `quote` → the flat quote of an HTTP 200 with lowercase `depositAddress`, `transaction.to`, and `transaction.data`, or a failure with `reason` `body` (a 200 whose body does not parse), `refused` (any other final answer, another 2xx included), `unavailable`, `budget`, or `paused`, and `sent` (whether any attempt was sent). `submit` → `order` (200 with `orderId`; `status` `''` when missing), `mismatch` (400 `xchain_deposit_mismatch`), `quote_expired` (409 `quote_expired`), `budget`, or `unresolved` for everything else; `unresolved` carries `retryable`, true for a transport error or timeout, any 5xx, HTTP 429, and HTTP 409 `idempotency_in_progress` (the same key may be sent again), false for a 2xx without `orderId` and every other answer. `history` → `{ orders, full }` (`full` when the page had 200 entries) or `budget` / `error`. `status` → the order, `order: null` for 404 `not_found`, or `budget` / `error`. Logs `shop.orchestra.error` (`endpoint`, `status`), `shop.orchestra.rate_limited`, `shop.orchestra.budget_exhausted`, and `shop.alert.orchestra_request` (`endpoint`, `status`, `code`), each with the ids the caller passes as the last argument of `routes`, `submit`, `history`, and `status` (`paymentId`, and `proofId`, `offerId`, `quoteId`, `providerRef`, or `orderId` where they apply) or, for `quote`, the request's `tag` as `paymentId`; never the key, a URL, a body, or a BOLT11.
- **Used by:** the shop payment creation, quote, and proof code and the shop watcher duties (orders, submits, order status).

Retries follow Orchestra's key rule. A quote is retried once, with the same key and body, after a transport error or timeout, HTTP 429, HTTP 409 `idempotency_in_progress`, or any 5xx, and only while the deadline has not passed. When the 429 paused quotes, the retry waits for the pause to end if it ends before the deadline, and otherwise is not sent (`paused`). Any other answer refuses the pair. `submit`, `history`, and `status` never retry; the caller decides the next attempt.

Budgets are in-process sliding 60 s windows per endpoint group, and every attempt sent counts, retries included. Quotes have 240; `quoteBudgetLeft()` tells a creation or replacement how many quote calls are still allowed, and is 0 while quotes are paused. Status and history share 50. Submits have 30: proof requests together use at most 20, and the watcher may use whatever the window has left, so it always keeps at least 10. A first submit of a new proof goes before a repeat: a `proof-repeat` is sent only while fewer than 19 proof submits and fewer than 29 submits in all are in the window, so a first submit still finds a slot after it. Route-list fetches have 25 per container, so two containers stay below Orchestra's 60 per address for routes and limits; a refused fetch is `{ ok: false }`, so the creation offers no stablecoin until a fetch succeeds. A call its budget refuses is not sent and logs `shop.orchestra.budget_exhausted`.

An HTTP 429 pauses only the endpoint that answered it (status and history pause separately, although they share one budget) until `Retry-After` (seconds) or else `X-RateLimit-Reset` (absolute epoch ms) and logs `shop.orchestra.rate_limited`; while paused, calls are not sent (`paused` for a quote, `budget` for submit, history, and status, `{ ok: false }` for routes). A 429 with neither usable header does not pause. HTTP 401 and 403, and a 400 other than `xchain_deposit_mismatch` on submit, also log `shop.alert.orchestra_request`, because they point at a key or request problem.

## Function: evmGetTransactionReceipt

- **Purpose:** Read an EVM transaction receipt with `eth_getTransactionReceipt` for the `tx` proof.
- **Inputs:** JSON-RPC URL (secret), fetch implementation, transaction hash, timeout in milliseconds.
- **Returns / side effects:** `{ ok: true, value }` with `transactionHash`, `status` (`0x1` / `0x0`, or `null` when absent) and the logs in lowercase, `value: null` when the node knows no receipt; `transport` or `rpc` on failure.
- **Used by:** Shop stablecoin proof (`GET /lnurlp/tx/:username`) and its watcher.

The call is one JSON-RPC 2.0 POST (`Content-Type: application/json`, `redirect: 'error'`, AbortSignal timeout). A thrown fetch, a non-2xx status, a body that is not JSON, a body with neither `result` nor `error`, and a result of the wrong shape are all `transport`; a JSON-RPC `error` object is `rpc` with its message. The URL may hold a provider key and is never logged or returned.

## Function: evmGetUserOperationReceipt

- **Purpose:** Read an ERC-4337 user operation receipt with `eth_getUserOperationReceipt` when no transaction receipt exists for the hash the wallet sent.
- **Inputs:** JSON-RPC URL (secret), fetch implementation, user operation hash, timeout in milliseconds.
- **Returns / side effects:** `success` (`null` when absent), the bundle hash from `receipt.transactionHash`, and the user operation's own top-level `logs`; `value: null` when unknown.
- **Used by:** Shop stablecoin proof, step 1 of the verification of `tx`.

A node that does not implement the bundler method answers with a JSON-RPC error, which is returned as `rpc` like any other error. The nested bundle `status` is not read, because a bundle can succeed while one of its user operations fails. Transport and error mapping are the same as for `evmGetTransactionReceipt`.

## Function: evmGetTransactionByHash

- **Purpose:** Check whether the node knows a transaction (`eth_getTransactionByHash`).
- **Inputs:** JSON-RPC URL (secret), fetch implementation, transaction hash, timeout in milliseconds.
- **Returns / side effects:** `true` when the result is an object, `false` when it is `null`, `transport` for any other result.
- **Used by:** The `hex` proof after an `already known` or `nonce too low` broadcast error.

Only presence is reported; the transaction fields are not parsed. Transport and error mapping are the same as for the other EVM JSON-RPC calls.

## Function: evmGasPrice

- **Purpose:** Read the node's gas price with `eth_gasPrice`.
- **Inputs:** JSON-RPC URL (secret), fetch implementation, timeout in milliseconds.
- **Returns / side effects:** The gas price in wei as a `bigint`; a result that is not a `0x` hex quantity is `transport`.
- **Used by:** Quote creation (`minFee`) and the fee check of the `hex` proof, through `recommendedMinFee`.

The params array is empty. Transport and error mapping are the same as for the other EVM JSON-RPC calls.

## Function: evmSendRawTransaction

- **Purpose:** Broadcast a signed transaction from a `hex` proof with `eth_sendRawTransaction`.
- **Inputs:** JSON-RPC URL (secret), fetch implementation, signed bytes as hex without `0x`, timeout in milliseconds.
- **Returns / side effects:** The transaction hash the node returns, lowercase; a result that is not a 32-byte hash is `transport`. The transaction is broadcast.
- **Used by:** The `hex` proof route and the watcher's resubmission.

The call sends `0x` plus the given hex as the single param. A JSON-RPC error is returned as `rpc` with its message, so the caller can tell `already known`, `nonce too low`, `insufficient funds`, `invalid`, and `intrinsic gas` apart as the shop stablecoin document requires.

## Function: normalizeEvmAddress

- **Purpose:** Accept an EVM address in any case.
- **Inputs:** A string.
- **Returns / side effects:** The lowercase address when the input is exactly `0x` plus 40 hexadecimal characters, otherwise `null`.
- **Used by:** `erc20TransferData`, `decodeTransferLog`, and the shop payment configuration and offer checks.

No whitespace is trimmed and no EIP-55 checksum is checked; a mixed-case address is accepted as is and lowercased.

## Function: erc20TransferData

- **Purpose:** Build the calldata of an ERC-20 `transfer(recipient, amount)`.
- **Inputs:** Recipient address (any case) and the amount in base units.
- **Returns / side effects:** 68 bytes as lowercase hex: `0xa9059cbb`, 12 zero bytes, the 20-byte recipient, and the 32-byte amount. Throws `RangeError` for a malformed recipient or an amount outside `0 … 2^256 − 1`.
- **Used by:** Offer checks (Orchestra `transaction.data`) and the `hex` proof, which compares the signed transaction's data byte for byte.

The output is deterministic, so two encodings of the same transfer compare equal as strings.

## Function: parseErc20TransferData

- **Purpose:** Read the recipient and amount from ERC-20 `transfer` calldata.
- **Inputs:** Calldata hex with `0x`, any case.
- **Returns / side effects:** `{ recipient, amount }` with a lowercase recipient, or `null` unless the data is exactly 68 bytes with selector `a9059cbb` and 12 zero padding bytes before the address.
- **Used by:** Offer checks on the Orchestra quote transaction.

It is the inverse of `erc20TransferData`. Data with extra bytes, another selector, or a non-zero padding byte is refused, as the offer check requires exactly 68 bytes.

## Function: decodeTransferLog

- **Purpose:** Decode an ERC-20 `Transfer` event log from a receipt.
- **Inputs:** One `EvmLog`.
- **Returns / side effects:** `{ token, from, to, value, logIndex }` in lowercase, or `null` unless topic 0 is `ERC20_TRANSFER_TOPIC`, there are exactly three topics whose address topics carry 12 zero bytes, and the data is one 32-byte word.
- **Used by:** Step 4 of the verification of `tx`, which matches the token contract and the deposit address of an offer.

The three-topic rule excludes ERC-721 `Transfer` logs, which index the token id as a fourth topic.

## Function: decodeSignedEvmTransaction

- **Purpose:** Decode the signed EVM transaction of a `hex` proof.
- **Inputs:** Signed transaction bytes as hex without `0x`, any case.
- **Returns / side effects:** `hash` (`0x` + Keccak-256 of the signed bytes), `type` (`legacy`, `eip2930`, `eip1559`), `chainId` (`null` for a legacy transaction without EIP-155), `to`, `value`, `data`, and the fee fields; `null` for anything else.
- **Used by:** Verification of `hex` (step 1 and 2) before the api stores and broadcasts the transaction.

Unsigned transactions, a zero `r` or `s`, EIP-4844 and EIP-7702 envelopes, malformed RLP, and encodings that do not re-encode to the same bytes (non-canonical integers, trailing bytes) give `null`, so the hash always belongs to exactly the decoded fields. The sender is not recovered; the node checks the signature on broadcast. A fee field that is absent in the encoding is `0n`; fields that do not belong to the type are `null`.

## Function: recommendedMinFee

- **Purpose:** Compute DFX's recommended gas price, the `minFee` of a stablecoin method.
- **Inputs:** The `eth_gasPrice` result `g` in wei and the method's chain id.
- **Returns / side effects:** `floor(g × 12 / 10)`; on chain 56 (BNB Smart Chain) `floor(floor(g × 12 / 10) × 20 / 12)`.
- **Used by:** Quote creation (`transferAmounts[].minFee`) and the fee check of the `hex` proof.

Integer arithmetic on `bigint` performs the floors exactly.

## Function: hexFeeReaches

- **Purpose:** Check that a signed transaction's fee reaches an offer's `minFee` the way DFX checks it.
- **Inputs:** The decoded transaction, the offer's `minFee`, and `recommendedMinFee` of the current `eth_gasPrice`.
- **Returns / side effects:** `true` when the effective fee is at least `minFee`.
- **Used by:** Verification of `hex`, step 2.

For a legacy or EIP-2930 transaction the effective fee is its gas price. For EIP-1559 it is the lower of `maxFeePerGas` and the current recommended gas price plus `maxPriorityFeePerGas`. A missing fee field counts as 0.

## Function: proofResponse

- **Purpose:** Turn a stored proof into the response the proof route sends, following the response table in the "Storing and submitting" section of `docs/shop-stablecoin-payment.md`.
- **Inputs:** One `ShopProof` row.
- **Returns / side effects:** `accepted` → **200** `{ "txId": <tx_hash> }`. `superseded` → **400** `Another transfer is paying this payment`. `late` → **400** `Invoice expired`. `refunded` → **400** `The transfer was refunded`. `failed` → **400** `The transfer was not completed`. `refused` → **400** `Transaction already used` when `refusal` is `tx_used`, otherwise `Payment was not accepted`. Unresolved, held, or `stuck` → **503** `Payment is being confirmed`. It writes nothing.
- **Used by:** `handleShopProof`.

The 400 and 503 bodies use the shared OpenCryptoPay error body (`shopError`), and the 200 uses `shopResponse`, so CORS and `Cache-Control: no-store` are always set.

## Function: shopProofContext

- **Purpose:** Read one quote with its payment and every offer of it in one store transaction.
- **Inputs:** `ShopPayments` and a lowercase quote id.
- **Returns / side effects:** `{ quote, payment, offers }`, or `null` when the quote does not exist. It is read-only.
- **Used by:** `handleShopProof`, which also checks that the payment belongs to the username's account, and the lookups duty of `runShopPaymentTick`.

The offers are listed in insertion order, so the method's offers are matched in the same order the quote served them.

## Function: verifyTxProof

- **Purpose:** Run the "Verification of `tx`" steps for one hash: read `eth_getTransactionReceipt`. When it returns null, read `eth_getUserOperationReceipt` with the same hash. Then select the ERC-20 `Transfer` log to an offer's deposit address.
- **Inputs:** `ShopPayments`; the quote's offers; the method's table row; the requested asset or `null`; the RPC endpoint; the normalised hash; an absolute deadline; the per-call limit; and an optional `fetchImpl` for the RPC calls (default the service's; the watcher passes one that counts its calls).
- **Returns / side effects:** `found` with the offer, the bundle or transaction hash, the log index, the transferred value, and the user-operation hash (only when the user-operation receipt was used). `not_found` when neither receipt exists, an RPC call failed, or the deadline passed before the user-operation read. `failed` when the transfer did not succeed (`status` other than `0x1`, or `success` other than `true`). `no_log` when no log reaches an offer of this method (and asset). `used` when every matching log is held by a proof of another quote. It writes nothing.
- **Used by:** `handleShopProof` (3 s calls) and the lookups duty of `runShopPaymentTick` (5 s calls).

A log whose value equals the offer's `amountIn` is preferred. Otherwise the first matching log in receipt (log-index) order is used, because only Orchestra can fill or refund a different amount.

## Function: verifyHexProof

- **Purpose:** Run step 2 of "Verification of `hex`" on a decoded signed transaction before anything is stored or broadcast.
- **Inputs:** `ShopPayments`, the quote's offers, the method's table row, the requested asset or `null`, the RPC endpoint, the decoded transaction (`decodeSignedEvmTransaction`), and the request deadline.
- **Returns / side effects:** `valid` with the offer when all of these hold: the chain id equals the method's, `to` is an offer contract of this method, the asset (when given) matches, the value is zero, the data equals `erc20TransferData(deposit, amountIn)` byte for byte, and the fee reaches the offer's `minFee` (`hexFeeReaches`). `invalid` otherwise. `unavailable` when an EIP-1559 transaction needs the current `eth_gasPrice` and that read fails.
- **Used by:** `handleShopProof`.

A legacy or EIP-2930 transaction needs no RPC call. An EIP-1559 transaction compares the lower of `maxFeePerGas` and the current recommended gas price plus `maxPriorityFeePerGas`.

## Function: applyProofOrder

- **Purpose:** Record an Orchestra order on a proof (`recordProofOrder`) and handle the case where another row already holds that order id.
- **Inputs:** An open store transaction that holds the payment row and its proof rows (`lockPaymentForProofs`, or `lockPaymentsForProofs` for two payments), the proof, `{ orderId, status }`, the clock, the collision rule (`ShopOrderCollision`): `filling` for the storing step (step 4), `newer` for a submit or status answer (step 3), and optionally the ids of the payments whose rows the caller locked (default: the proof's payment).
- **Returns / side effects:** The proof after `evaluateProof`, or the row it was merged into. When the order id is taken, a row of the same offer merges with this proof, and a final status of either row for that order wins, because a final status is terminal, and ends the status reads; without one the kept row keeps its own status, so it takes the given status only when this proof is the kept row. Two rows that hold different orders never merge. A row of another offer refuses one row with `tx_used` through `refuseProof`, an `accepted` one included, and that row is no longer followed: with `filling` this proof, with `newer` the newer of the two rows (later `created_at`, then the greater id); when that is the other row, the order moves to this proof in the same transaction (`refuseProof` with this proof as heir), which records it with the holder's final status if it stored one and the holder's `order_found_at`, stops its submits, is read by the order-status duty, and takes an `accepted` holder's place only when it belongs to the same payment and its evaluation accepts it (otherwise a `superseded` proof of the holder's payment takes the place or that payment ends with `proof_refused`; acceptance never passes from one payment to another). A newer holder of another payment is refused the same way when its payment is among the locked ones (`submitProofAttempt` locks it); a newer holder of a payment the caller did not lock is left unchanged and this proof keeps no order, nothing written. A holder its order already ended (`refunded`, `failed`, `refused` with `expired_order`, or a stored final status) keeps the order, and this proof is refused `tx_used` with its submits stopped; a holder `refused` for another reason with an order that is not final keeps its result and hands the order to this proof.
- **Used by:** `storeProof`, `submitProofAttempt`, and the order-status duty of `runShopPaymentTick` (a status read, and the step for a replaced order, which records its `unfulfilled` status).

The first order found sets `order_found_at` and the first status read 10 s later.

## Function: storeProof

- **Purpose:** The one storing step of "Storing and submitting" (steps 1, 3 and 4), shared by the proof route, the lookups duty, and the orders duty.
- **Inputs:** `ShopPayments` and a candidate: offer, payment id, source (`tx`, `hex`, `detected`), transaction hash, log index or `null`, user-operation hash, raw hex, transferred value, and the order the orders duty found, or `null`.
- **Returns / side effects:** `{ proof, created }`. Under the payment row and its proof rows (`lockPaymentForProofs`) it reuses a row that already holds the order, or a row of the same offer and transaction. An order goes only to a row without one: a second order of the same transaction and offer gets its own unlogged row, and while another unlogged row of that offer and transaction exists (the unlogged index admits one), the order is not stored yet and that row is returned, so the orders duty stores the order on a later read once the receipts duty filled the row's log index. It fills in a missing log index, value, user-operation hash, or order and re-evaluates the row (`evaluateProof`); a fill that makes a row without a scheduled submit submittable (an unlogged `hex` row) sets its `next_submit_at` to 10 s after the fill, as an inserted row with a log index gets 10 s after its insert. Otherwise it inserts a row with `give_up_at` 24 h ahead, the first watcher submit after 10 s when it has a log index and no order (none for `hex` or `detected`), and the first receipt read after 30 s when the log index is unknown. The orders duty stores every order no proof holds this way, an order recovered from an order a proof holds included, so every row keeps its own transaction and order. It logs `shop.proof.stored` or `shop.proof.detected` with `paymentId`, `proofId`, `offerId`, `quoteId`, `providerRef`, `source`, and the order's `orderId` when one was found. A lost insert answers from the winning row.
- **Used by:** `handleShopProof` and `runShopPaymentTick`.

When a fill collides with another row on the log index or order index, the rows are one deposit. A row of another offer leaves the filled row `refused` with `tx_used` through `refuseProof` (an `accepted` row included, which lets a `superseded` proof take its place or ends the payment with `proof_refused`); its order is kept but no duty follows it any more, and nothing is deleted. On a submit or status answer (`newer`) whose other row is the newer one, of the same payment or of another one, that row is refused instead and its order moves to the filled row (see `applyProofOrder`); a row of another payment changes only under that payment's row lock. A row of the same offer is merged: the kept row is the `accepted` one, else the one with an order, else the older one. The other row is deleted before the values are written. The submit itself (step 2) is the caller's.

## Function: submitProofAttempt

- **Purpose:** One Orchestra submit of a proof (`POST /v1/orchestration/submit` with the offer's `provider_ref` and the proof's `tx_hash`), following the key rule and the answer mapping in "Orchestra › Calls".
- **Inputs:** `ShopPayments`, the proof id, the caller (`proof-first`, `proof-repeat`, or `watcher`), and an absolute deadline. The call's timeout is the time left, at most 10 s.
- **Returns / side effects:** `{ proof, sent }`. It submits only an unresolved proof with a log index: no result, no order, not stopped (a `hex` proof gets its log index only once its receipt is found, so Orchestra can see the deposit). It first claims the 2 s slot with a conditional update of `last_submit_at`. A budget refusal returns `sent: false`. An order is recorded through `applyProofOrder`. `xchain_deposit_mismatch` refuses the proof through `refuseProof` (`mismatch`) and gives it a new idempotency key. `409 quote_expired` makes it `late`, sets `submit_stopped`, and logs `shop.alert.late_deposit`. Any other answer leaves the proof unresolved (`shop.proof.unresolved`), and an answer with `retryable: false` gives it a new idempotency key (the key rule); a retryable one (timeout, 5xx, 429, `409 idempotency_in_progress`) keeps the key. Every sent submit logs `shop.proof.submitted`. The submit passes `paymentId`, `proofId`, `offerId`, `quoteId`, and `providerRef` to `OrchestraClient.submit` for its log lines, and `shop.proof.submitted` (with `answer`, and `orderId` for an order), `shop.proof.late`, `shop.alert.late_deposit`, and `shop.proof.unresolved` carry the same ids. The answer's transaction first reads, without a lock, which row holds an answered order; when no row or a row of the same payment holds it, it locks the payment row and its proof rows (`lockPaymentForProofs`), and when a row of another payment holds it, both payment rows in the order of their ids, then their proof rows ordered by id (`lockPaymentsForProofs`), so that step 3 can refuse that newer row and run `paymentLostAcceptance` on its payment under that payment's lock. It then reads the holder again under the locks: a holder that moved to a payment not locked (a hand-off between the two reads) writes nothing and applies the answer once more in a new transaction; on that second run such a holder is left unchanged and the proof keeps no order until a later submit. No account or charge row is locked.
- **Used by:** `submitProof` and the submits duty of `runShopPaymentTick`.

When a proof changes while its submit is in flight (it gets an order, a result, or is merged away), a mismatch, `quote_expired`, or unresolved answer does not overwrite that change. An order answer is still recorded (`applyProofOrder`) on a row without an order, also when that row got a result meanwhile; when an order was recorded meanwhile, only a final status of that same order is applied, because a final status is terminal and so never older than the stored one; a final status already stored for that order stays (`recordProofOrder`).

## Function: submitProof

- **Purpose:** Submit a proof once and return only the row (`submitProofAttempt` without the `sent` flag).
- **Inputs:** `ShopPayments`, the proof id, the caller (`proof-first`, `proof-repeat`, `watcher`), and the deadline.
- **Returns / side effects:** The proof after the attempt, or `null` when it does not exist. Its side effects are those of `submitProofAttempt`.
- **Used by:** The proof route's first submit and its repeat resubmit.

A proof request that gets no submit call answers **503** and leaves the submit to the watcher.

## Function: refuseHexProof

- **Purpose:** Record a `hex` transaction that the node rejected or that reverted. A transaction the node does not know is never refused for that: it stays unresolved until `give_up_at`.
- **Inputs:** `ShopPayments` and the proof id.
- **Returns / side effects:** The proof afterwards, or `null` when it does not exist. Through `refuseProof`, the proof becomes `refused` with `hex_rejected` from any result the States table allows (`accepted`, `superseded`, `late`, `stuck`, or unresolved). An `accepted` proof's payment ends with `proof_refused` unless another proof takes its place. `refuseProof` clears the next submit and the next receipt read and logs `shop.proof.refused`. A `refunded` or `failed` proof is left unchanged.
- **Used by:** `sendHexProof`, `readProofReceipt`, and the receipts duty of `runShopPaymentTick`.

It runs under the payment row and its proof rows (`lockPaymentForProofs`); no account row is locked.

## Function: sendHexProof

- **Purpose:** Broadcast a stored `hex` proof with `eth_sendRawTransaction`.
- **Inputs:** `ShopPayments`, the stored proof, the RPC endpoint of its chain, the per-call timeout, and an optional `fetchImpl` for the RPC calls (default the service's; the watcher passes one that counts its calls).
- **Returns / side effects:** `sent`, `rejected`, or `retry`. An error whose message contains `already known` or `nonce too low` counts as sent only when `eth_getTransactionByHash` then finds the hash. `insufficient funds`, `invalid`, or `intrinsic gas` refuse the proof (`refuseHexProof`). Any other error, and a transport error, is `retry`. The first successful send sets `sent_at` and the next receipt read (30 s); it schedules no submit, because a `hex` proof is submitted only after its receipt filled the log index.
- **Used by:** `handleShopProof` (first send and the repeat path) and the receipts duty of `runShopPaymentTick` (send again).

Only transactions that passed `verifyHexProof` are ever stored, so the api does not act as an open relay.

## Function: readProofReceipt

- **Purpose:** Read the receipt of a proof without a log index (a `hex` or `detected` proof) and fill in its log index and value.
- **Inputs:** `ShopPayments`, the proof, the RPC endpoint of its chain, the call timeout, and an optional `fetchImpl` for the RPC call (default the service's; the watcher passes one that counts its calls).
- **Returns / side effects:** Possible outcomes:
  - `filled`: the log was written. The row is re-evaluated, and it merges with another row of the same deposit when the log index clashes. A `hex` row that may now be submitted (no result, no order) and has no submit scheduled gets `next_submit_at` 10 s after the fill; each watcher submit schedules the next one 20 s, then 30 s later, then every 5 min, so a `hex` proof is submitted 10 s, 30 s, and 60 s after its fill, then every 5 min, as a `tx` proof is after its storing.
  - `pending`: no receipt yet.
  - `error`: the RPC call failed.
  - `failed`: a reverted `hex` transaction, which is refused.
  - `mismatch`: a failed receipt, or a successful one without a transfer to the offer's deposit address. The proof stays held, its receipt reads stop, and `shop.alert.detected_mismatch` is logged.
  - `held`: every matching transfer log is held by another row of the same offer and transaction with a different order (a successor or recovered order paid by the same transaction). Two rows with different orders never merge, so the proof stays without a log index as its own proof and its receipt reads stop.
- **Used by:** `handleShopProof` (one read after the first send of a new `hex` proof, and one on the repeat path) and the receipts duty of `runShopPaymentTick`.

Its write runs under the payment row and its proof rows (`lockPaymentForProofs`). The mismatch alert carries `quoteId`, `providerRef`, and the `orderId` of a `detected` proof. Logs to the deposit address whose index another row of the same offer and transaction already holds are skipped, so a second order paid by the same transaction keeps its own row. Among the free logs, the one whose value equals the offer's `amountIn` is preferred, otherwise the first one. Only when no free log remains is a held log used (same preference), and the rows merge as one deposit.

## Function: handleShopProof

- **Purpose:** Serve `GET /lnurlp/tx/:username` after the route has checked the username and account and counted the 120-per-minute limit. It verifies a wallet's `tx` (transaction or ERC-4337 user-operation hash) or `hex` (signed raw transaction), stores it as a `shop_proof` row, and submits it to Orchestra, all within 18 s (`SHOP_PROOF_BUDGET_MS`).
- **Inputs:** `ShopPayments`, the username's account, the username, the parsed query (`quote`, `method`, `asset`, `tx`, `hex`, `repeated`), and `overLimit` (true when the limiter refused the request).
- **Returns / side effects:** A repeated key is **400** `Payment was not accepted`. A quote that does not belong to a shop payment of this account (malformed, unknown, or foreign) is **404** `Quote expired`. A missing or unknown method, or a missing or malformed `tx`/`hex`, is **400**. A stored proof of this quote's offers with the same hash is a repeat: the request reads its missing receipt once, sends an unsent `hex`, resubmits it when it is unresolved (at most once per 2 s slot and five times per minute), and answers from the row (`proofResponse`). Otherwise `tx` reads the receipt, with the user-operation receipt as fallback. When neither is found it stores a lookup row (at most 4 rows per quote, done ones included) and answers **503** `Transfer not found yet`. A failed transfer or a transfer without a matching log is **400**, and a log that a proof of another quote already holds is **400** `Transaction already used`. `hex` checks the chain, contract, value, data and fee; it stores the row with `raw_hex`, broadcasts it, and refuses it (**400**) when the node rejects it. After a send it reads the receipt once within the budget and submits the proof only when that receipt filled its log index; otherwise it answers **503** `Payment is being confirmed`, and the receipts duty and then the submits duty carry it on (a reverted receipt refuses it, **400**). Over the limit, only a stored row answers; anything else is **503** `Too many requests`. Without shop config, or without an RPC endpoint for the chain, a stored row answers as it stands and a new proof is **503** `Payment is being confirmed`, with nothing stored (the quote is this account's; only its verification cannot run now, so the wallet retries).
- **Used by:** `GET /lnurlp/tx/:username` in `src/routes/lnurl-server.ts`.

Each RPC call times out after 3 s (`SHOP_RPC_TIMEOUT_MS`), and the Orchestra submit gets at most 10 s (`SHOP_PROOF_ORCHESTRA_MS`). A new proof is submitted as `proof-first`, and a repeat's resubmit as `proof-repeat`. Every event carries the payment, proof and offer ids. No key, RPC URL, raw hex or BOLT11 is logged.

## Function: retryStuckProof

- **Purpose:** Run the operator retry behind `POST /debug/shop-proofs/:id/retry`.
- **Inputs:** `ShopPayments` and the proof id (any letter case; a malformed id is unknown).
- **Returns / side effects:** `retried`, `not_stuck`, or `not_found`. A `stuck` proof moves back to unresolved (result `null`), `give_up_at` moves 24 h ahead, the watcher tries counter is reset, and `shop.proof.retried` is logged with `paymentId`, `proofId`, `offerId`, `quoteId`, `providerRef`, and `orderId` when the proof holds one. For a `hex` proof without a log index (sent or not) `next_receipt_at` is set to now, so the receipts duty reads and sends its transaction again, and the submits duty submits it once the receipt filled the log index; any other proof's next watcher submit is due now.
- **Used by:** `debugShopProofsRoutes` (**404** for `not_found`, **409** for `not_stuck`).

The change is one conditional update on `result = 'stuck'` under the payment row and its proof rows (`lockPaymentForProofs`), so a concurrent change wins cleanly.

## Function: runShopPaymentTick

- **Purpose:** Run the eight watcher duties of `docs/shop-stablecoin-payment.md` once, in order, each with its own budget of calls per tick. Every external call times out after 5 s (`SHOP_WORKER_CALL_TIMEOUT_MS`).
- **Inputs:** `ShopPayments` and the tick number. Odd ticks read Orchestra history (duty 3), and even ticks read order status (duty 8).
- **Returns / side effects:** The eight duties:
  - (1) Ends `open` payments whose window passed, logging `shop.payment.ended`.
  - (2) Runs up to 8 LUD-21 settlement reads in parallel and applies each with `applySettlement` (settled → paid, open → the next read, failed → retried). The final read, 10 minutes after the BOLT11 expiry, closes an unpaid payment (`closePayment`): an `accepted` one ends `expired_unpaid` (`shop.alert.accepted_unpaid`), an `open` one ends `window`, and either logs `shop.payment.ended` with its reason. The duty waits until every read and its write have ended, then rethrows the first failure, so a failing tick never lets the next one start while a read still runs. It logs `shop.alert.accepted_long` once per payment per process when a payment has been `accepted` for more than an hour.
  - (3) Reads one history page of a payment whose `next_history_at` is due (paid and closed payments included). It stores every order no proof holds as a `detected` proof through `storeProof`, an order recovered from one a proof holds included (its own proof, with its own `sourceTxHash`; an order without one stores nothing yet), pages on a full page, and keeps the offset when a read fails. Whether the order watch of the last offer with an issued detail has ended is decided from the offers alone: while it runs, or while a full page is read on, the next read is due after 10 s; once it has ended, every read, a failed one included, decides `next_history_at` under the payment row and its proof rows (`lockPaymentForProofs`): while a proof's `superseded_by_order` is held by no proof and `successor_wait_until` has not passed, it reads again after 60 s (`SHOP_SUCCESSOR_HISTORY_INTERVAL_MS`); when that wait has passed, it logs `shop.alert.successor_missing` (`paymentId`, `proofId`, `offerId`, `quoteId`, `providerRef`, the replaced `orderId`, and `successorOrderId`) and clears `next_history_at` and `successor_wait_until` together; otherwise it clears `next_history_at`.
  - (4) Handles lookup rows within 4 RPC calls per tick: every call counts, and a row is taken only while at least 2 calls are left (its transaction receipt, then the user-operation receipt), so the duty never makes more than 4. Reads after 10 s, 30 s and 60 s, then every 2 min, and expires a row after one hour (`shop.proof.lookup_expired`). A quote holds at most 4 lookup rows, done ones included.
  - (5) Handles receipt rows within 4 RPC calls per tick: every call counts, and a row is taken only while the calls it may make are left (1 for a `detected` proof, 2 for an unsent `hex` proof, 3 for a sent one), so the duty never makes more than 4. It sends unsent `hex` transactions, resends unmined ones however long the node does not know them (so a transaction mined late is still submitted), and fills log indexes (a filled `hex` proof that may still be submitted and has no submit scheduled gets `next_submit_at` 10 s after the fill), until the proof's `give_up_at` (24 h after it was stored, or after `retryStuckProof`; after it, the stuck duty marks an unresolved proof `stuck`), and for a `hex` proof only while it has neither a result nor an order. A row whose only matching transfer log another row of the same offer and transaction holds with a different order (a successor or recovered order paid by the same transaction) is its own proof: it stays without a log index and is no longer read.
  - (6) Makes one watcher submit of an unresolved proof with a log index. A proof stored with its log index is first due 10 s after storing, and a proof whose log index is filled later 10 s after the fill; each watcher submit schedules the next one 20 s, then 30 s later, then every 5 min, so either is submitted after 10 s, 30 s, and 60 s, then every 5 min. A retried proof is submitted at its retry, then about 20 s and 50 s later, then every 5 min.
  - (7) Marks unresolved proofs past `give_up_at` as `stuck` (`shop.alert.proof_stuck` with `paymentId`, `proofId`, `offerId`, `quoteId`, `providerRef`, and `orderId` when the proof holds one), each under the payment row and its proof rows, and only while the proof read again under those locks is still past `give_up_at` (an operator retry since the selection moved it ahead).
  - (8) Makes one status read of a non-final order (not of a proof refused as `tx_used`): every 10 s for 10 min, then every 60 s, applied under the payment row and its proof rows. The read passes `paymentId`, `proofId`, `offerId`, `quoteId`, `providerRef`, and `orderId` to `OrchestraClient.status` for its log lines. It stops after a final status, or after 24 h (`shop.alert.order_stuck` with `paymentId`, `proofId`, `offerId`, `quoteId`, `providerRef`, and `orderId`), or at an `unfulfilled` status with a `supersededByOperationId` of another order (a replaced order, no alert): the proof keeps its order with that status (held, or still `accepted`), stores the successor's id as `superseded_by_order`, and the payment's `successor_wait_until` moves 24 h ahead (`SHOP_SUCCESSOR_WAIT_MS`) when it is empty or earlier and its `next_history_at` is set to now when it is empty, so duty 3 stores the successor as its own proof. Every other status, a superseding id with another status included, is applied as a status. The stops at a stored final status and after 24 h cost no call and are decided on the row the duty selected without a lock: each re-reads the proof under the payment row and its proof rows and clears `next_status_at` only while the proof still holds the same order, status, and `next_status_at` (for the 24 h stop, its order still found 24 h ago), so a final status, a replaced order, or another container's stop in between is kept and logs nothing; the fields of `shop.alert.order_stuck` are read in the transaction that cleared `next_status_at`, and it is logged after that commit, only by that transaction, so two containers that selected the same row log it once and a failing read rolls the stop back. A status read is applied only while the proof, read again under the payment row and its proof rows, still holds the order it was read for and is still followed by the duty (`followsOrderStatus`, the selection's own conditions): a proof the duty stopped during the call (a final status another container's read stored, the 24 h stop, a replaced order, or a `tx_used` refusal, for example by duty 5 when the log index it fills is another offer's) keeps its result, refusal, status, and stopped schedule, its payment does not change, and nothing is logged; a final status of that order is terminal, so the read writes nothing either. A status read sets the next `next_status_at` only while it is still the value the duty selected, so a row another container's read rescheduled in between keeps that schedule, and this read's status is still applied.
  - Every proof-result transaction of the duties locks the payment row, then its proof rows; the duties' schedule writes (`patchProof`) take the payment row and its proof rows too, re-read the proof, and write only while the column the duty decided on is unchanged (`next_receipt_at` for duty 5, `next_submit_at` for duty 6, the order, status, and `next_status_at` for duty 8), so an operator retry, a merge, or another container's write in between is kept; the first send of a `hex` proof writes `sent_at` and `next_receipt_at` without a lock, and the status reschedule and the receipt-mismatch stop take the payment row and its proof rows. No duty locks an account row except the settlement step of a charge-backed payment.
- **Used by:** `startShopPaymentWorker`.

A duty whose Orchestra call the budget refused leaves its row for the next tick. Duties 3, 6, and 8 do nothing without an Orchestra client. A store failure rejects the tick.

## Function: startShopPaymentWorker

- **Purpose:** Run `runShopPaymentTick` once at once and then every 2 s (`SHOP_WORKER_INTERVAL_MS`), separate from the charge watch's tick, so that a slow shop call never delays a till confirmation.
- **Inputs:** `ShopPayments` and an optional interval in milliseconds.
- **Returns / side effects:** `{ stop }`, which clears the interval. A tick does not start while the previous one is still running. Ticks are numbered from 1 in the order they start, so duty 3 and duty 8 alternate. A rejecting tick logs `shop.worker.tick.failed` with the error fields (`errorLogFields`).
- **Used by:** `startPosPaidWorker` when it is given a `ShopPayments` service.

The two containers of a deploy each run their own ticks. Their per-process Orchestra budgets together stay below Orchestra's limits.

## Function: installPostgresConnectionClosedGuard

- **Purpose:** Keep the process alive when Bun SQL reports `PostgresError` with code `ERR_POSTGRES_CONNECTION_CLOSED` on `uncaughtException` or `unhandledRejection`. That is the driver error for a closed Postgres connection. The event `sql.connection.closed` is written through `logEvent` with `errorLogFields` (name and code only, never the message). Any other uncaught exception or unhandled rejection is written to stderr and exits with status 1. A second call does nothing. The handler does not throw.
- **Inputs:** None.
- **Returns / side effects:** void. Registers the two process listeners the first time. Does not open a connection and does not retry a write.
- **Used by:** Process boot in `src/index.ts`, before the first SQL call.

## Function: retryWhilePostgresConnectionClosed

- **Purpose:** Call `open` until it resolves. When `open` rejects with `PostgresError` / `ERR_POSTGRES_CONNECTION_CLOSED`, log `sql.connection.closed` and wait `delayMs` via `wait`, then try again. Any other rejection propagates, so a failed write is not repeated. `sqlState` does not match this driver code; this function does not classify SQLSTATE `23505`.
- **Inputs:** `open` returns the value to keep. `wait` receives the delay in milliseconds. `delayMs` is that delay.
- **Returns / side effects:** The resolved value of `open`. One `sql.connection.closed` line per closed attempt. No connection of its own.
- **Used by:** Process boot in `src/index.ts` when `DATABASE_URL` is set. A blank URL keeps the in-memory boot and does not call this function.

# Shop identity

## Function: listedShop

- **Purpose:** A map-complete shop, not the directory rule in `docs/shop-identity.md`: a live (`deletedAt` null), top-level note with the `#21GiftsShop` token (same rule as `GET /shops/activity`), a pin, a till account, and complete under `shopPlaceProblem` and `shopTextProblem`.
- **Inputs:** A note with `parentId`, `deletedAt`, `text`, optional `place` and optional `shopAccount`, or `undefined`.
- **Returns / side effects:** `{ name, place: { lat, lng, label, address }, tillAccountId }` with the address always present, or `null`. No I/O.
- **Used by:** `listedShopName`, `isListedShop`, and the place outbox sender. The directory, the shop page, NIP-05 and the shop kind 0 use `publicShop`.

## Function: shopListingFingerprint

- **Purpose:** One comparable string of the note fields a shop's public state is built from: text (listing tag, description), pin (name and place), till account id and `deletedAt`. Two reads with the same fingerprint give the same listing, name, description and till account; `parentId`, `createdAt` and the id do not change, so they are not part of it.
- **Inputs:** Note fields as for `listedShop` (`text`, `place`, `shopAccount`, `deletedAt`), or `undefined`.
- **Returns / side effects:** `'missing'` for `undefined`, otherwise the JSON of `[text, place, shopAccount?.id, deletedAt]`. No I/O.
- **Used by:** `shopRoutes` (`GET /shops/:npub` compares the note read after the photo set with the round's note), the Nostr worker's shop kind 0 (a re-read right before the reservation; a changed note is skipped with `nostr.profile.nack` `reason: 'note_changed'`), and `InMemoryShopIdentityStore` (the place fingerprint of its queue sync, the fields the Postgres place trigger compares).

## Function: listedShopName

- **Purpose:** Shop name (the pin label) of a listed shop.
- **Inputs:** Note fields as for `listedShop`, or `undefined`.
- **Returns / side effects:** The label, or `null` when the note is not listed. No I/O.
- **Used by:** tests of the map-complete name. Key creation, `profile_name`, `renameIfListed` and `listShopNip05Entries` use `publicShop`.

## Function: publicShopName

- **Purpose:** Public name of a shop note. A non-blank pin label is kept. Otherwise the first non-blank line of `shopDescription`, cut at 80 characters, or `Shop` when that line is empty.
- **Inputs:** Note text and the pin, or null.
- **Returns / side effects:** A non-empty name. No I/O.
- **Used by:** `publicShop`.

## Function: publicShop

- **Purpose:** The public directory rule: a live top-level note with the `#21GiftsShop` token and a till account. A pin and a structured address are optional. This is not `listedShop`. The map still requires a complete pin and description.
- **Inputs:** A note with `parentId`, `deletedAt`, `text`, optional `place` and optional `shopAccount`, or `undefined`.
- **Returns / side effects:** `{ name, place, tillAccountId }`, or `null`. `place` is null without finite coordinates. `address` is null unless street, house number, postal code, city and country are all non-blank. No I/O.
- **Used by:** `ShopIdentityStore.ensureListed`, `ShopIdentityStore.renameIfListed`, `listShopNip05Entries`, `shopRoutes`, the shop kind 0, and the place outbox sender (a public shop that is not listed clears the place flag and sends no request).

## Function: isListedShop

- **Purpose:** Whether a note is a listed shop (`listedShop` is not null).
- **Inputs:** Note fields as for `listedShop`, or `undefined`.
- **Returns / side effects:** `boolean`. No I/O.
- **Used by:** `serializeMessage` and `listPlaces` (`shopNpub`), and the photo outbox sender (a 404 requeues the place only while the shop is listed).

## Function: migrateShopIdentitySchema

- **Purpose:** Create `shop_identity` (one custodial key per shop note plus the place and photo outbox columns; see `docs/schema/shop_identity.sql`), its keyset index `shop_identity_key_order_idx` on (`nostr_key_created_at`, `message_id`), the order `listRound` pages in, the partial index `message_shop_candidate_idx` on `message` (`created_at`, `id`) `WHERE parent_id IS NULL AND deleted_at IS NULL AND shop_account_id IS NOT NULL AND place_lat IS NOT NULL` (pin-present notes; the directory query does not use it) and the partial index `message_shop_directory_idx` on `message` (`created_at`, `id`) `WHERE parent_id IS NULL AND deleted_at IS NULL AND shop_account_id IS NOT NULL AND text ~* '#21giftsshop([^a-z0-9_]|$)'` that `listCandidates` and `listDirectory` page on, and its queue triggers: `trg_shop_identity_place` (`AFTER UPDATE OF` text, pin, till account or `deleted_at` on `message`, only when a value changed) sets `ocp_place_pending` and raises `ocp_place_generation`, and when the updated note is a public shop also sets `ocp_photos_pending` and raises `ocp_photos_generation` once without raising `ocp_revision`; `trg_shop_identity_cover` (photo 0 on `message`) and `trg_shop_identity_extra_photo` (`message_extra_photo` insert, update, delete) set `ocp_photos_pending` and raise `ocp_photos_generation` while the note is a public shop (live, top-level, till account, shop tag; a pin is not required). The triggers run inside the writing transaction after its row lock, so every store write queues itself, including `blockPubkeyAndHideRows`, `replacePhotos` and `updatePhoto`.
- **Inputs:** Shared `SqlClient`, after `migrateMessageSchema`.
- **Returns / side effects:** Runs `SHOP_IDENTITY_SCHEMA_SQL` in order. Idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS shop_identity_key_order_idx`, `CREATE INDEX IF NOT EXISTS message_shop_candidate_idx`, `CREATE INDEX IF NOT EXISTS message_shop_directory_idx`, and one step per trigger that takes `ACCESS EXCLUSIVE` on its table and then runs `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS` and `CREATE TRIGGER`, so no writer sees the table without the trigger). Every statement is one `DO` block that first takes `pg_advisory_xact_lock(21499001)`, so concurrent boots run each statement one after the other instead of failing with `tuple concurrently updated` or a duplicate catalog key.
- **Used by:** `openBootStores`.

## Function: shopNpub

- **Purpose:** NIP-19 npub of a stored shop key.
- **Inputs:** `{ nostrPubkey }` (64 lowercase hex).
- **Returns / side effects:** `npub1…`. No I/O.
- **Used by:** `shopRoutes`, `messagesRoutes` (`shopNpub` in a write response), the shop kind 0 `website`, `InMemoryShopIdentityStore`.

## Function: shopKeyMustBeAdopted

- **Purpose:** True when this shop note already has a Nostr key at OpenCryptoPay, so `ensureListed` must not mint a different one. The private key is stored later by `adoptKnownSecret`. The set is the forum message id, which is the OpenCryptoPay `externalId`. It holds no key material.
- **Inputs:** Message id.
- **Returns / side effects:** Boolean. No I/O.
- **Used by:** `InMemoryShopIdentityStore.ensureListed`, `PostgresShopIdentityStore.ensureListed`, `POST /debug/shop-keys`.

## Function: debugShopNoteRoutes

- **Purpose:** `POST /debug/shop-notes`. Stores one live top-level shop note that has a till account and no pin. Body `{ text, shopUsername, authorId }`. The pin is stored null. Returns `{ id, shopNpub }`. Does not accept a secret.
- **Inputs:** Auth store, message store, shop identity store, optional 32-byte KEK, optional debug token, and a clock.
- **Returns / side effects:** Hono app. Inserts the note and calls `ensureListed`, so a public shop gets its key. A new key queues the place push and the photo push.
- **Used by:** `createApp` at `/debug/shop-notes`.

## Function: debugShopKeyRoutes

- **Purpose:** `POST /debug/shop-keys`. Stores the existing 32-byte shop secret for a note `shopKeyMustBeAdopted` names. Body `{ messageId, secret }` where `secret` is 64 hex characters. Returns `{ messageId, npub }`. Does not log or return the secret.
- **Inputs:** Shop identity store, message store, optional 32-byte KEK, optional debug token.
- **Returns / side effects:** Hono app. Writes one `shop_identity` row when the note has none and the public key is new. The insert does not queue a place push. A public shop queues the photo push; any other note leaves the photo flags clear.
- **Used by:** `createApp` at `/debug/shop-keys`.

## Function: InMemoryShopIdentityStore

- **Purpose:** `ShopIdentityStore` for memory boots and tests. `adoptKnownSecret` stores a supplied 32-byte secret (envelope AAD `shop:<messageId>`, place not pending, generation 0; a public shop also sets `ocp_photos_pending` true and generation 1, any other note leaves the photo flags false and 0) for an existing note, returns the row when the public key matches, and throws when the note is missing or the key differs. `ensureListed` does not mint a note `shopKeyMustBeAdopted` names. `listRound(cursor, limit)` returns at most `limit` rows in the `listAll()` order after the cursor, then wraps to the rows at or before it from the start (the cursor is a key, so it works when no row has it any more). `listDebug(limit)` slices the first `limit` rows of that order before copying them (the operator dump). `listCandidates(cursor, limit)` returns the raw page of at most `limit` shape candidates after the cursor, keyed or not, each with `keyed` (the same semantics as the Postgres adapter). `nextRevision('photos', claim)` reserves nothing while the place is pending or the photo generation is not the claim's, so a place change after a photo claim (a hide, for example) is not followed by a photo request with a newer revision. `ensureListed` creates one key (random `generateSecretKey`, envelope with AAD `shop:<messageId>`, custody `custodial`, place queued with generation 1 and photos queued with `ocp_photos_pending` true and generation 1) for a public shop (`publicShop`), keeps it forever, refuses a pubkey another shop holds, attaches the npub to an `InMemoryMessageStore` row (`setShopNpub`) and, for an existing key, rewrites `profile_name` with the rule of `renameIfListed` (only while the note read again still shows the snapshot this call read, so an older snapshot cannot put back a name that a newer rename stored) and returns the stored row. A new key takes its name and fingerprints from a read of the note after key generation and is not created when that read is no longer a public shop. `renameIfListed(note)` writes the snapshot's name only while the snapshot is a public shop and the note read again shows the same text and pin. Without triggers, it compares each identity's note (text, pin, till account, `deletedAt`) and photo fingerprint with the last fingerprint before every call that syncs its queue and queues a change as the Postgres triggers do (a place change always queues the place; when the note is a public shop the same sync queues the photos once; a photo change queues photos only while `publicShop` is set; both fingerprints changing in one sync raise the photo generation by 1). Over an `InMemoryMessageStore` (every memory boot) the photo fingerprint is `photoRevision(messageId)`, so the sync behind `getByPubkey`, `listAll`, `listRound`, `listDebug` and `GET /shops/:npub` reads no photo bytes, and the route itself reads only the requested shop's set (`getPhotoSet`); a change and its exact revert between two syncs queue once, as the triggers queue each write. Over another message store it hashes the set from one `getPhotoSet` read per shop (index, content type, length and bytes). Claims, leases, tokens, generations and the shared revision follow the Postgres adapter, with the injected clock as lease clock; `claimPlaces` and `claimPhoto` take the least recently claimed rows first in the same order (a null lease, never claimed, first, then the earliest lease end, then the message id; `claimPhoto` does not require `ocp_revision` greater than 0); `release` sets the lease end to the injected clock's now, so a released row is claimable at once but goes behind rows never claimed and behind leases that ended earlier, and `leaseHasTime` is false for it; `finishPlace`, `clearPhotoWithoutSend`, `finishPhotos` and `missingPhotoPlace` do the same whether the row settles or stays pending, so a null lease means never claimed.
- **Inputs:** Constructor `(messages, now = Date.now)`.
- **Returns / side effects:** Process-local rows; every read returns copies.
- **Used by:** `createApp` default, `src/index.ts` memory boot, tests.

## Function: PostgresShopIdentityStore

- **Purpose:** `ShopIdentityStore` over `shop_identity`. `adoptKnownSecret` inserts a supplied secret in one statement that locks the note by id (`SELECT … FOR UPDATE`) and inserts from that locked row. `ocp_place_pending` stays false and generation 0 as SQL literals. `ocp_photos_pending` and `ocp_photos_generation` are derived from the locked row with the public-shop condition (true and 1 when that row is a public shop, otherwise false and 0). It returns the stored row when the public key matches. `ensureListed` does not mint a note `shopKeyMustBeAdopted` names. `ensureListed` checks `publicShop` in code, then inserts the key in one statement that locks the note (`SELECT … FOR UPDATE`) and inserts only while every column the check read is unchanged, with `ON CONFLICT (message_id) DO NOTHING` (compare-and-set like `ensureAccountNostrKey`); a lost race or a changed note returns the stored row or `undefined`. A new row sets `ocp_place_pending` true and generation 1 and `ocp_photos_pending` true and generation 1 as SQL literals, without renumbering `$1`–`$16`. An existing key gets `profile_name` rewritten while the note is a public shop, in one statement under the same note lock and unchanged-columns condition (`UPDATE … FROM` the locked note), so a request with an older snapshot changes nothing. `renameIfListed(note)` (the worker's shop kind 0 rename) runs that same statement for the caller's snapshot and is a no-op when the snapshot is not a public shop. `listCandidates` is a raw keyset page by (`created_at`, `id`) of at most `limit` live, top-level `#21GiftsShop` notes with a till account, pinned or not, keyed or not, read on the partial index `message_shop_directory_idx` (`created_at`, `id`) `WHERE parent_id IS NULL AND deleted_at IS NULL AND shop_account_id IS NOT NULL AND text ~* '#21giftsshop([^a-z0-9_]|$)'`; the key check is an `EXISTS` on `shop_identity` in the select list (`keyed`), evaluated only for the rows the `LIMIT` returns, so a page returns at most `limit` rows even when every candidate already has a key; the first page has no cursor predicate and every later page is a separate statement with only `(created_at, id) > ($1, $2)`, so the cursor is always an index condition on `message_shop_directory_idx`. `listDebug(limit)` reads the first `limit` identities by (`nostr_key_created_at`, `message_id`) with `LIMIT $1` for the operator dump. `queueAllPlacePage` queues one page by `message_id` (the first page and the pages after a cursor are separate statements, so the cursor is always an index condition on the primary key). `queueAllPhotoPage` queues one photo page the same way, setting `ocp_photos_pending` and raising `ocp_photos_generation`. `claimPlaces` (up to `limit`) and `claimPhoto` (one row that is photo-pending and not place-pending; `ocp_revision` may still be 0) use `FOR UPDATE SKIP LOCKED`, pick the least recently claimed rows first (`ORDER BY ocp_place_claimed_until ASC NULLS FIRST, message_id`, and the same on `ocp_photos_claimed_until`: never claimed first, then the earliest lease end, then the message id, so rows whose sends keep failing and keep their claims until the lease ends never hold the place of later shops), set `claimed_until = now() + lease` by the database clock, raise the claim token and return `{ messageId, generation, claim }`. `listRound(cursor, limit)` is the shop publishers' round-robin page: one keyset read of at most `limit` rows after the cursor by (`nostr_key_created_at`, `message_id`) and, when fewer follow it, a second read of the rest of the limit from the start up to and including the cursor, both on the index `shop_identity_key_order_idx` (without a cursor, one read with no predicate, so every cursor is an index condition). `nextRevision` for the photo lane also requires, in the same `UPDATE`, `NOT ocp_place_pending` and `ocp_photos_generation` equal to the claim's generation, so a place write that came in after the photo claim read the photos wins and the photo pass sends nothing. `release` sets `claimed_until = now()` instead of null, so a released row (409 `Stale revision`, say) is claimable at once but goes behind rows never claimed and behind leases that ended earlier, and a row released on every pass never holds the photo lane or a place batch; the claim-ending writes (`finishPlace`, `clearPhotoWithoutSend`, `finishPhotos`, `missingPhotoPlace`) also set it to `now()`, whether the row settles (the generation is still the claim's, so the flag is cleared) or a newer change keeps it pending; queue writes (triggers, `queueAllPlacePage`) leave the lease alone, so a settled row queued again keeps that past end and goes behind rows that waited longer, and a shop whose photos or place change once per pass never holds its lane. A null lease means only that the row was never claimed. `leaseHasTime` requires `claimed_until > now()` as well as the requested time left, so a released claim never has time. `leaseHasTime`, `nextRevision` (cap 2^53 − 1), `release`, `resetPhotosForDelete`, `finishPlace`, `clearPhotoWithoutSend`, `clearPhotoHash`, `finishPhotos`, `missingPhotoPlace` and `deferPhotos` are conditional on the claim token; clearing a flag or storing a hash is also conditional on the generation.
- **Inputs:** Constructor `(sql, messages)`.
- **Returns / side effects:** SQL reads and writes on `shop_identity` (and the locked `message` row on insert).
- **Used by:** `openBootStores`.

## Function: listShopNip05Entries

- **Purpose:** NIP-05 locals of public shops. Allocates the account locals first with the set and order of `listNip05Entries` (every account with a stored username or a name, oldest first, stored usernames reserved first), then each public shop in `nostr_key_created_at`, then `message_id` order with `allocateNip05Local(shopName, messageId, taken)`. An account never loses its local to a shop; a rename or a new account that takes the slug gives the shop a new local.
- **Inputs:** Auth store, shop identity store, message store, optional snapshot of every account. A caller that combines the result with the account entries of `listNip05Entries` passes both the same snapshot (`nip05Directory` does); without it the accounts are read once with `auth.listAccounts()`.
- **Returns / side effects:** `[{ messageId, name, pubkey, local }]` for public shops with a key. Reads only: every call reads every account (not when the snapshot is given) and every shop identity, and then every shop note in one bulk read (`MessageStore.getByIds`), not one read per shop. Callers do not run it per request or tick: they read the cached directory of `nip05Directory`, which runs it once per computation (at most once per 60 s on expiry plus once per 10 s on a forced refresh, per store set).
- **Used by:** `nip05Directory` (for `buildNostrJson`, the shop kind 0 `nip05` and the `nip05` of `shopRoutes`).

## Function: nip05Directory

- **Purpose:** The NIP-05 directory of one store set from a shared in-process cache: account entries (`listNip05Entries`) and public shop entries by message id (`listShopNip05Entries`), both from one account read. Kept per auth store, shop identity store and message store (a `WeakMap`, so each boot, memory or Postgres, has one per process) for `NIP05_DIRECTORY_TTL_MS` = 60 s, the `max-age=60` that `nostr.json` and `GET /shops/:npub` already send. Concurrent callers share one computation in flight (single flight), so a burst of reads computes at most once per TTL. `refresh` asks for a fresh computation that bypasses and replaces the cache, for a caller whose note does not match the cached entry; forced computations are single flight too and start at most once per `NIP05_DIRECTORY_REFRESH_MS` = 10 s per store set, and inside that gap a forced read gets the forced computation in flight or the cached directory (computed as a plain read when it expired). While computations succeed, a store set computes the directory at most once per 60 s on expiry plus once per 10 s on demand, however many requests and worker ticks ask.
- **Inputs:** auth store, `{ identities, messages }`, clock reading in epoch milliseconds, optional `refresh` (default `false`).
- **Returns / side effects:** `{ accounts, shops, accountsByLocal, shopsByLocal }` (`shops` a `Map` by message id in allocation order; `accountsByLocal` and `shopsByLocal` the same entries by local part, built once per computation so a `nostr.json?name=` is answered with map lookups). Reads only; a computation reads every account, every shop identity and the notes of every shop in one bulk read. A failed computation is not cached: its callers get the error and the next read computes again. A later computation's result is never replaced by an earlier one that finishes after it (ordered by start, not by the clock). A cached directory or forced start whose clock reading is more than the refresh gap after `now` (the clock stepped back) counts as expired, so a clock step never freezes the cache; a `now` read shortly before an await still gets the cache and the gap.
- **Used by:** `buildNostrJson` (`GET /.well-known/nostr.json`), `shopRoutes` (`nip05` of `GET /shops/:npub`) and the shop kind 0 of the Nostr worker (`nip05`), so the three carry the same names.

## Function: signEventForShop

- **Purpose:** Sign an event with a shop's custodial key: reads `nostr_nsec_ciphertext`, decrypts with `NOSTR_NSEC_KEK` and the AAD `shop:<messageId>` (so a shop ciphertext never decrypts as an account key or as another shop's key), finalizes, and zeroes the secret.
- **Inputs:** Shop identity store, message id, 32-byte KEK, unsigned event template.
- **Returns / side effects:** Signed NIP-01 event. Throws when the shop has no key or decryption fails.
- **Used by:** Worker shop kind 0 and kind 10002.

## Function: imageHeaderSize

- **Purpose:** Width and height of a stored still from its header only, never decoding pixels: PNG `IHDR` (after the 8-byte signature), JPEG `SOF0`–`SOF2`, WebP `VP8 `/`VP8L`/`VP8X`. For a JPEG whose EXIF orientation (IFD0 tag `0x0112` in an `APP1` `Exif` segment before the scan, read only from a TIFF header `II` or `MM` with the magic 42 in that byte order and an entry of type `SHORT` with count 1, otherwise orientation 1) is 5 to 8 the two are swapped. The `SOF` and the `Exif` lookups share one JPEG marker walk: any number of `0xFF` fill bytes before a marker is skipped and the length-less markers (`TEM`, `SOI`, `EOI`, `RST0`–`RST7`) carry no segment. `imageDisplaySize` stays unchanged.
- **Inputs:** Bytes and stored MIME.
- **Returns / side effects:** `{ width, height }`, both `null` when the header cannot be read or a side is outside 1–20000. No I/O.
- **Used by:** `shopRoutes` (`photos[].width` / `height`).

## Function: runOcpPlaceOutboxPass

- **Purpose:** Claim up to `WORKER_BATCH` pending places (lease `WORKER_LEASE_MS`, least recently claimed first, so places whose sends keep failing never starve later shops) and send each, deciding from the note as it is then: a listed shop gets `PUT /map/places` with the `shopOcpPlaceInput` body plus `nostrPubkey` and `revision`; a public shop that is not listed clears the place flag and sends nothing; a key this outbox has never sent (`ocpRevision` 0) also clears the flag and sends nothing, so an adopted OpenCryptoPay place is not deleted; anything that is no longer public and whose `ocpRevision` is already greater than 0 first resets the photo outbox (`resetPhotosForDelete`) and gets `DELETE /map/places` `{ origin, externalId, revision }`. The revision is raised under the claim before the request, and right before sending the lease must still have the 5 s timeout plus 10 s, otherwise the claim is released.
- **Inputs:** `{ identities, messages, mapPush }`.
- **Returns / side effects:** `PUT` 2xx clears the flag (generation-checked) and queues the photos; 201 also nulls the photo hash and queues the photos regardless of the generation; `DELETE` 2xx clears the flag; 409 `Stale revision` only releases (the row goes behind never-claimed rows and leases that ended earlier, so a row that gets it on every pass never holds the batch); a 409 whose body is empty, only whitespace or cannot be read logs `ocp.place.failed` and keeps the flag and the claim, so the next attempt follows when the lease ends; 400 `Place field is not allowed: nostrPubkey` or `: revision` (the `develop` OpenCryptoPay API without openCryptoPay/api#26) logs `ocp.place.deferred` with the error and keeps the flag and the claim, so the place is sent again when the lease ends (about once a minute); a 400 whose body is empty, only whitespace or cannot be read logs `ocp.place.failed` with status 400 and keeps the flag and the claim, like the empty 409; `main` without #26 answers 200 or 201 and drops `nostrPubkey`, which the photo pass detects (`ocp.photos.deferred`); any other 400 or another 409 with a readable body logs `ocp.place.rejected` and clears the flag; any other answer, error or timeout logs `ocp.place.failed` and keeps the flag until the lease ends. A row whose identity vanished is released. The pass resolves only once every claimed row has settled (each row's failure is caught and logged per row), so none of its requests is still in flight when the lane starts the next pass; a row whose handling throws (for example a store read before the request) logs `ocp.place.failed` with its message id and the safe error fields and keeps the flag until the lease ends, without affecting the other rows. Only a failed claim read rejects the pass.
- **Used by:** `startOcpOutboxWorker`.

## Function: ocpPhotoSetHash

- **Purpose:** SHA-256 over a photo set in note order (content type, 4-byte big-endian byte length, bytes for each photo), stored as `ocp_photos_hash`.
- **Inputs:** Photos in note order.
- **Returns / side effects:** Lowercase hex digest. No I/O.
- **Used by:** `runOcpPhotoOutboxPass`.

## Function: runOcpPhotoOutboxPass

- **Purpose:** Claim one pending photo set whose place is not pending (least recently claimed first, so sets whose sends keep failing never starve later shops; `ocp_revision` may still be 0) and send it with `PUT /map/places/photos` (up to 10 photos in note order, base64, 30 s timeout; every still the set returns by stored index, so a still with an unrecognized type drops only itself, photo 0 included). The lease must have the timeout plus 10 s left before the bytes are read and again before the request. The set is read in one statement (`MessageStore.getPhotoSet`), so the hash and the request never mix photo 0 of one set with the extras of another. A missing identity, a note `publicShop` rejects, or a set whose hash equals `ocp_photos_hash`, is cleared without a request. The listed-shop check is not this gate. An empty set whose stored hash is null, or an empty set while `ocp_revision` is still 0, is cleared without a request, because an empty list would delete covers this outbox did not write. A non-empty set at revision 0 does not call `nextRevision` and does not change `ocp_revision`. Immediately before the request it reads the identity and the note again, and when the place is pending, the photo generation is not the claim's, or the note is no longer a public shop, it releases the claim, sends nothing and leaves the stored hash unchanged. Otherwise the body is `origin`, `nostrPubkey` and `photos` only, with no `revision` key, and the stored hash is nulled before the request. When `ocp_revision` is already greater than 0, the revision is reserved first, only while the place is not pending and the photo generation is still the claim's (`nextRevision`), including an empty list when the stored hash is non-null; when nothing is reserved the pass releases the claim without a request and keeps the stored hash. After that reservation a non-empty set nulls the hash before the request, and an empty set does not, so a lost empty delete keeps the hash and the next pass sends the empty list again. The body includes `revision`.
- **Inputs:** `{ identities, messages, mapPush }`.
- **Returns / side effects:** 200 stores the hash and clears the flag while the generation matches and logs `ocp.photos.skipped` for skipped photos; 409 `Stale revision` nulls the hash when the set is non-empty, leaves the stored hash when the set is empty, and releases (the set goes behind never-claimed sets and leases that ended earlier, so a set that gets it on every pass never holds the lane); 400 or 413 on a non-empty set store the hash, clear the flag and log `ocp.photos.rejected`; an empty set logs `ocp.photos.failed`, keeps the stored hash and the flag, does not release the claim, and sends the empty list when the lease ends; 404 `{"error":"Place not found"}` (openCryptoPay/api#26 does not know the place by key) nulls the hash, clears the flag and queues the place again while the shop is listed, so the photos follow the next confirmed place `PUT`; any other 404 (the plain `404 Not Found` of an OpenCryptoPay API without openCryptoPay/api#26, which has no photo route and, on `main`, stores the place without the key) logs `ocp.photos.deferred` with the status, `reason: 'route_missing'` and `bodyLength` (never the body), keeps the flag and the claim (`deferPhotos`), and while the shop is listed queues the place with its lease held until the photo lease ends, so the place is re-sent at most once a minute and stores the key once #26 is live; any other answer, error or timeout logs `ocp.photos.failed` and keeps the flag until the lease ends.
- **Used by:** `startOcpOutboxWorker`.

## Function: queueAllShopPlaces

- **Purpose:** Start-up pass: queue the place push of every `shop_identity` row with keyset pages of 200 by `message_id`. It decides nothing; the place sender does at send time.
- **Inputs:** Shop identity store, optional message id to resume after (default `null`, the first page), optional `onPage` callback that receives the last message id of each queued page.
- **Returns / side effects:** Number of rows queued by this call. Rejects when a page read fails; the rows of earlier pages stay queued and `onPage` has reported the last of them, so a caller resumes at the failed page instead of queueing the earlier pages again (which would re-send their places, reserve new revisions and hold their photos back again).
- **Used by:** `startOcpOutboxWorker` (runs it at start and, after a failed page, retries it from the last queued page until one attempt succeeds).

## Function: queueAllShopPhotos

- **Purpose:** Start-up pass: queue the photo push of every `shop_identity` row with keyset pages of 200 by `message_id`. It decides nothing; the photo sender does at send time. Its cursor and its retry are separate from the place start-up pass.
- **Inputs:** Shop identity store, optional message id to resume after (default `null`, the first page), optional `onPage` callback that receives the last message id of each queued page.
- **Returns / side effects:** Number of rows queued by this call. Rejects when a page read fails; the rows of earlier pages stay queued and `onPage` has reported the last of them, so a caller resumes at the failed page instead of queueing the earlier pages again.
- **Used by:** `startOcpOutboxWorker` (runs it at start, with its own cursor, and retries it from the last queued page until one attempt succeeds).

## Function: startOcpOutboxWorker

- **Purpose:** Run both start-up passes and start both senders. Each start-up pass (`queueAllShopPlaces`, `queueAllShopPhotos`) starts at once with its own cursor. When the place pass fails it logs `ocp.place.failed` with `pass: 'startup'`, `attempt`, `retryInMs` and the safe error fields (`errorLogFields`), and runs again after `intervalMs`, doubling the delay per failed attempt up to `WORKER_LEASE_MS`, until one attempt succeeds, so a transient database error on a later page does not leave the remaining identities unqueued until the next restart. It keeps the last message id that `onPage` reported across attempts and passes it as the resume cursor, so a retry starts at the failed page and each earlier page is queued once. The photo pass does the same and logs `ocp.photos.failed` with `pass: 'startup'`; a photo start-up failure does not change the place start-up. The place pass and the photo pass are each scheduled `intervalMs` after that lane's previous pass settled (also after a failure), so each instance has at most one place pass and one photo upload in flight and a slow pass never stacks database or HTTP work (a place pass settles only after all its claimed rows settled, also when one of them throws). Pass failures log `ocp.place.failed` / `ocp.photos.failed`.
- **Inputs:** `{ identities, messages, mapPush }`, optional interval (default `WORKER_INTERVAL_MS`; also the first start-up retry delay).
- **Returns / side effects:** `{ stop }`, which clears both pending start-up retries and both pending lane timers; a pass still in flight settles without scheduling another, so no pass starts after `stop` (a start-up attempt that fails after `stop` is logged without `retryInMs` and not retried).
- **Used by:** `src/index.ts` when `resolveMapPush` returns a target.

## Function: shopRoutes

- **Purpose:** Hono group mounted at `/shops` after `/shops/activity`, with `GET /` and `GET /:npub`. `GET /:npub` takes any single segment and validates it in the handler: the npub of a public shop is 200 `{ shop }`; the 64-lowercase-hex form of a known key is 301 to `/shops/{npub}`; a known key whose note is not public is 410 `{ error: 'Shop is no longer listed', npub }` (no name); anything else is 404 `{ error: 'Not found' }`; a store failure is 503 `{ error: 'Shops are unavailable' }` and logs `shops.detail.failed`. The photos come from one read of the whole set (`MessageStore.getPhotoSet`); each URL is built from the still's stored index (photo 0 `photo.<ext>`, extra `n` `photo/<n>.<ext>`), so a still with an unrecognized type drops only its own entry, photo 0 included. While `nip05Domain` is set, the entry of the shared NIP-05 directory (`nip05Directory`, cached 60 s per store set, the same names as `nostr.json` and the shop kind 0) must carry the name of the note this request read: on the first missing entry or other name the request asks once for a forced refresh of the directory (at most one computation per 10 s per store set; inside that gap the cached directory answers) and checks again; when it still does not match it re-reads the note (410 when the note is no longer public), and a mismatch on the last round (`READ_ROUNDS`) is the same 503 with `shops.detail.failed` and `reason: 'nip05_stale'`. After the photo set it reads the note again and compares text, pin, till account id and `deletedAt` (the fields the answer is built from, as in the in-memory place fingerprint); a difference goes round once more with that re-read, and a difference on the last round is the same 503 with `reason: 'note_changed'`, so one answer comes from one state of the note. A photo-only change between the reads needs no round. Bound: at most two rounds (`READ_ROUNDS`), so at most three note reads, two photo set reads and one forced directory refresh per request; a burst of requests inside the TTL computes the directory once.
- **List:** `GET /` is the public directory of keyed public shops, newest note first. 200 `{ shops, nextCursor? }` and each shop is `{ npub, name, place }`. `place` is null without coordinates, and `address` is null unless every structured part is non-blank. `limit` defaults to 20 and is at most 100. A bad limit or cursor is 400 `Invalid limit` or `Invalid cursor` and does not read the store. A store throw is 503 `{ error: 'Shops are unavailable' }` and logs `shops.list.failed` with `Cache-Control: no-store`. A bearer is ignored. The ciphertext is not selected. `GET /:npub` uses `publicShop`.
- **Inputs:** `{ authStore, messages, identities, env?, now?, lnurlServer? }` (`env` default `process.env`, `now` default `Date.now`, the clock of the directory cache; without `lnurlServer` no till account can receive, so `payUsername` is `null`).
- **Returns / side effects:** `Shop` = `{ npub, messageId, name, description, place: { lat, lng, label, address } | null, photos: [{ url, width, height }], payUsername, nip05, createdAt }`. `address` is null unless every structured part is non-blank. Photo URLs are absolute from `resolvePublicApiBase` (path only when empty); dimensions from `imageHeaderSize`. `payUsername` is the till account's username when it has a username and a receiving address (`receivingAddress`: a verified wallet with the LNURL server configured), otherwise `null`; `nip05` is `null` without `nip05Domain`. `Cache-Control: public, max-age=60` on 200, 301, 404 and 410; `no-store` on 503. No session; a bearer changes nothing.
- **Used by:** `createApp`.
