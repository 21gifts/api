# 21.gifts — API Specification

> Canonical description of the HTTP surface implemented by this service.
> Product decisions live in [`CONCEPT.md`](./CONCEPT.md); this file owns
> request/response contracts for routes that exist in code today.

[docs/fiat-amounts.md](docs/fiat-amounts.md) is binding for every amount. A committed
amount keeps the fiat figures fixed when it was created. A typed amount is that
exact decimal string. A missing string stays null. A daily close, a later spot,
or a round trip through sats does not fill or replace it. This file does not
describe a backfill or a read that fills a committed figure that way.

**Status**: living document. Last revised 2026-10-29 (social recovery per [docs/social-recovery.md](docs/social-recovery.md): `POST /auth/passkey/recovery/begin` and `POST /auth/passkey/recovery/finish`, behind the app build check and the login switch, store a pending recovery for a new passkey and wallet key, proven by the old wallet's verified lookup and its signature; `POST /lnurlpay/:pubkey/transfer` forwards the Lightning address transfer and commits it; `PUT /me/recovery-share` stores the encrypted 21.gifts share; `GET /me/previous-wallets` and `DELETE /me/previous-wallets/:sparkPubkey` list and drop the previous wallets; these four are mounted when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve; `POST /lnurlpay/:pubkey/recover` also passes a pending recovery's new key and settles a forwarded recovery; `POST /auth/passkey/authenticate/finish` answers 409 `recovery_pending` for the new passkey of a pending recovery; owner JSON `socialRecoverySetUp`; from the grant gate day `eligibleToday` also requires a 21.gifts recovery share for the current verified wallet, with no start date of its own; `POST /me/events` accepts `recovery_done`; `RECOVERY_SHARE_KEK` is required with `DATABASE_URL`; an account merge deletes the source's recovery rows). Before that, 2026-10-21 (`GET /accounts/by-username/:username` is an exact username lookup: 200 `{ id, username, name }`, stored `username` and stored `name` including null). Before that, 2026-10-20 (`GET /view/:viewKey` returns the same public profile card as the member page, including `profileMessage` and the post, shop, credit, and reply lists; the moderator trust graph stays off that URL; `createdAt` stays epoch milliseconds). Before that, 2026-10-20 (shop payment in USDT and USDC after the contract revision of #491: `recordInvoice` and step 8 take one payment hash claim across `pos_charge_invoice` and `shop_payment`, and `POST /pay/:username/invoice` (502) and `GET /lnurlp/:username/invoice` (503) hand out no BOLT11 that another payment holds; a creation inserts nothing 16 s after its request arrived or for a disconnected payer; the pay link waits at most until 8 s after its fetch arrived; the route list is reused until `validForMs` with its own budget; no stablecoin is offered without a USD spot younger than 10 minutes; a `hex` proof is submitted only after its receipt; a replaced order's successor is its own proof and the payment waits up to 24 h for it (`shop.alert.successor_missing`); a proof refused as `tx_used` is no longer followed; `POST /debug/accounts/merge` locks the deleted pending charge and answers 409 when a pending charge would land next to the survivor's open payment). Before that, 2026-10-17 (shop payment in USDT and USDC per [docs/shop-stablecoin-payment.md](docs/shop-stablecoin-payment.md): `POST /pay/:username/payment`, `GET /lnurlp/cb/:username`, `GET /lnurlp/tx/:username`, `GET /lnurlp/wait/:payment`, and `POST /debug/shop-proofs/:id/retry` are mounted when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve; `GET /.well-known/lnurlp/:username` serves the OpenCryptoPay pay request of an open amount, honours `timeout`, `method`, and `asset`, and every error there carries `statusCode`, `message`, `error`, `status`, and `reason`; `POST /pos` and `DELETE /pos` end the account's open shop payment in the same transaction; `GET /pos` adds `charge.shopPayment`; `POST /debug/accounts/merge` answers 409 while the merged account has a shop payment that is neither paid nor closed). Before that, 2026-10-16 (a member who cannot receive is visible before paying: public message JSON carries `authorCanReceive`, `GET /conversations` rows and `GET /habits` comments carry `canReceive`, each from `receivingAddress`; every "cannot receive" answer on the conversation invoice and the habit donation carries `code` `cannot_receive`). Before that, 2026-10-10 (repayment from the in-app wallet: `GET /messages/:id/repayment` gives each giver `canReceive` and each due line `dueSats`; the next share skips a giver who cannot receive, so that giver does not block the others; `POST /messages/:id/repayment/due` makes every payable bill of a loan at once; `GET /me/loans` lists the member's own loans with what is due). Before that, 2026-10-07 (`POST /me/wallet/report` stores the wallet balance and payments with a server-side category; `POST /me/events` stores the first-party interaction log; never a recovery phrase, seed, PRF output, preimage, or private key). Before that, 2026-10-05 (`PUT /me/about` never stores an empty profile note: empty text on a live note that keeps no photo, extra still, or video restores the auto name-copy, so the bio clears; with no live note it is 400 `Write something about yourself`. 2026-10-02: a 400 that means "needs a wallet" or "cannot receive" carries `code` `wallet_required` or `cannot_receive`; a member's only receiving address is the verified in-app wallet `<username>@<host>`: linking, verifying, or removing an external Lightning address is gone, money routes, spend lookups, `GET /.well-known/lnurlp/:username`, and kind 0 `lud16` are wallet-only, posting needs a verified wallet, `POST /pos` without one is `Set up your wallet first`, debug provisioning takes `{ name, username? }`, receipts are read only on the relays every zap request names. Earlier the same day: one receiving address per account: a verified wallet receives on `<username>@<host>` resolved internally against the LNURL server; `sparkInvoice` on `POST /messages/:id/invoice`, `POST /conversations/:id/invoice`, and `POST /messages/:id/repayment` when `LNURL_ZAP_NSEC_HEX` is also set; Spark invoice worker publishes and ingests the zap receipt; `spark_invoice` table. 2026-10-01: `PUT /me/wallet` and forwarded LNURL routes when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve; owner `sparkPubkey` / `sparkWalletVerified`; wallet-backed `GET /.well-known/lnurlp/:username`; username fixed once verified; trailing/double-dot username reject. 2026-09-30: `GET /mentions` matches the start of the username, a `.` `_` `-` segment, or the start of the display name or one of its words; a token containing `.` `_` `-` matches only a whole-string start. 2026-09-28: `GET /mentions` username prefix suggestions. GET /mentions returns at most 20 username-prefix suggestions for a signed-in forum reader. 2026-09-24: `POST /conversations/:id/messages/:messageId/translate`; owner and view JSON include `aboutMessageId`; conversation rows include `lastMessageId`. 2026-09-23: `eligibleToday` does not require a grant until UTC 2026-10-10; funding-program grants independent of `account.role`; spend ping and `POST /invoices` require `eligibleToday`; verified top-level media also welcome-pings independent of `eligibleToday`; `GET /invoices/eligible`; `GET /conversations` list/open rows include per-row `unreadMessageCount`; envelope `unreadCount` remains unread thread count; `GET /trust-chain` requires a member Bearer session; public graph uses at most one incoming edge per subject: the oldest eligible sibling (`createdAt` then `id`), skipping a non-chain oldest sibling so a later displayable contact can show; eligible `verify`, `moderator_appoint`, and `moderator_propose` only when the subject is a moderator; `moderator_confirm` and `moderator_reject` never; later appoint/confirm/propose do not replace the first eligible contact; staff may reject an open proposal (`POST /trust/reject-moderator`, append-only `moderator_reject`, role stays `verified`) and re-propose after reject (new `moderator_propose`; 409 while currently pending, any confirm/appoint, or a concurrent older open propose wins after insert); confirm/reject re-list after insert and undo when the other grant already closed; pending = latest propose/reject is propose, verified, no confirm/appoint; live-unique kinds are verify/confirm/appoint only; open proposal fans out in-app `moderator_proposal` plus Web Push to other staff until confirm, until reject when pending is then empty, or until appoint; GET `/notifications` keeps `moderator_appointed` and `moderator_proposal` (mark-read / read-all do not stamp the proposal); owner `notificationLevel` on GET `/me` and `POST /me/notification-level`; fan-out filters in-app and Web Push by `all` / `active` / `mentions`; GET `/notifications` applies the same filter to stored rows (`moderator_appointed` always stays; `unreadCount` is unread among kept rows after the hidden filter (before the 200 cap), not `store.unreadCount()` and not the unfiltered matching unread of the newest 1000); a zap that inserts a gift-reply fans out only `notifyZap`, not a second `forum_reply`; gift-reply row still lands in the thread; confirm/appoint notify the subject only with `moderator_appointed` and Web Push url `/welcome`; official platform account (`isPlatform`) never fans out living-room `forum_post` / `forum_reply` / `zap`; house daily gift-replies still persist; GET /messages omits name-copy profile notes and About me text stays). 2026-10-01: opening a forum note, translating it, or opening Notifications stamps the matching unread forum and zap rows and tells the account's other devices to close those banners (`POST /notifications/read-by-message`; read-all and read-by-message return tags; a freshly stamped `POST /notifications/:id/read` only enqueues the dismiss tag and still returns the public notification). `moderator_proposal` stays unread. Private-message pushes are not dismissed. 2026-10-02: `GET /messages?mode=active` is paid notes plus unpaid founder/moderator notes. An ask with `sats = 0` is not active. 2026-10-09: the API stores the daily roster; initiator or founder edit it and a moderator is refused. Until that store has been written, a spend ping reads the live spend roster and does not import it. 2026-10-09: GET /me/activity, GET /members/:accountId/activity, and GET /view/:viewKey/activity count only donations. Loans (goalRepayable === true, including hidden notes), repay: repayment invoices, and moderator stipends are omitted. Daily and welcome gifts stay. An unknown note still counts as a donation. 2026-10-09: the activity JSON also returns outstanding loan balances that rise when an identified credit is given and fall on each repayment. The loan balances carry sats and BTC only; their fiat fields are null.
---

## Implemented HTTP surface (normative)

Auth state uses `InMemoryAuthStore` when `DATABASE_URL` is unset (tests and
local boots). When `DATABASE_URL` is set, the process migrates the auth
schema and uses `PostgresAuthStore` — accounts, passkey challenges,
passkey credentials, and sessions survive a
restart. `account.linking_key` is nullable for passkey-created rows. A missing or unreachable
database URL that is set is fail-loud at boot. On the SQL path,
`NOSTR_NSEC_KEK` (64 lowercase hex) is also required; missing or malformed
KEK throws at boot. So is `RECOVERY_SHARE_KEK` (64 lowercase hex), the key
of the 21.gifts recovery share, which must differ from `NOSTR_NSEC_KEK`; a
missing or malformed value, or one equal to `NOSTR_NSEC_KEK`, throws at
boot. Public gift statistics
(`GET /gifts/stats` and `GET /gifts?day=`) read the `gift` table when `DATABASE_URL` is set;
without it the process still boots and returns empty stats. Amounts are
also expressed as BTC and as the USD/CHF/EUR/PHP stored at payment time
(that stored value is what is returned). A USD stipend keeps the USD amount
that was sent. A SQL row stores those four amounts as text or SQL NULL.
SQL NULL is JSON `null` on read: it is not recomputed from the day's close
and it is not **503**. The migrate does not write a historical close onto a
null row. A null row stays null. An in-memory gift row that omits the field
entirely (`undefined`, not SQL NULL) is the same missing string. It stays null.
The read does not fill that omission from the UTC-calendar-day BTC-USD close
in `btc_usd_daily`, and it does not build CHF, EUR, or PHP from `usd_fiat_daily`.
A missing currency stays null. A missing USD does not discard a stored CHF, EUR,
or PHP on that row. One null does not null the day, the other currencies, or a
later cumulative. A day where every row lacks that currency is null. A gap day
stays `"0.00"` and does not change a running cumulative.

A member receives only on their in-app wallet, at the wallet-backed
`<username>@<host of PUBLIC_BASE_URL>` (`receivingAddress`). There is no route
to link, change, verify, or remove an external Lightning address. Without a
verified wallet a member cannot receive and cannot post (`missing` contains
`lightning-address` until the wallet is verified). The `lightning_address`
column and its data are kept but are not read or written by the api (new rows
take `lightning_address_verified` from its `DEFAULT false`); only the legacy
boot repair of unclassified `gift.kind` rows still matches by it. Public
`GET /lightning-address` resolves LUD-16 metadata with an in-memory cache; it
does not fetch or pay invoices.

Spend-worker invoice routes: `GET /invoices/passkey` and `GET /invoices/posted`
report those gates; `GET /invoices/eligible` reports `{ eligible, status }` (`eligibleToday` plus `effectiveStatus`; grant, and with it a 21.gifts recovery share for the current verified wallet, required from UTC 2026-10-01);
`POST /invoices` requires passkey and `eligibleToday` (grant and recovery share required from UTC 2026-10-01), then fetches a BOLT11 via LNURL-pay through the internal LNURL-server resolver.
Every `address` is matched only as the wallet-backed `<username>@<host of PUBLIC_BASE_URL>` (case-insensitive) of a member with a verified wallet; any other domain, or a member without one, gets the existing not-found answer. An address must look like `local@domain.tld`, except that an address on the configured wallet host also passes when that host has a port or is an IP address; anything else is **400** `Not a valid Lightning Address (expected name@domain)`.
When `messageId` is set, that note must be the address's live top-level note, including About me, and have a photo or video.
When `messageId` is omitted, issue requires at least one live **top-level** forum message that is not the auto-created profile note.
`POST /invoices/proof` accepts a preimage without re-checking the grant. Replies do not count. They require `SPEND_API_TOKEN`;
when it is unset the
routes return **503** and the process still boots. This service does not pay
invoices (no LNDHub client). A matching proof inserts an outbound row into
`gift` when `DATABASE_URL` is set (no-op without it) so `GET /gifts/stats` and
`GET /gifts?day=` include the payment. Insert failure logs
`gifts.record_failed` and still returns **200**. When the issued invoice stored a **top-level** `messageId`, proof inserts a
platform-account gift-reply first, then `addSats` (idempotent). That path does
not notify (no in-app rows, no Web Push). When that
`messageId` is a reply, proof persists a hidden `spendGiftReplyId` marker
under the reply, then `addSats` the reply (a live existing marker is hidden
only and does not `addSats`; no `notifyForumReply`). Optional `messageId` on
`POST /invoices`. `GET /invoices/posted` returns `{ hasPosted, messageId, postedAt, hasMedia, welcomeHasMedia, welcomeMessageId }`.

CORS allows the configured origins (`CORS_ALLOWED_ORIGINS`, or the default
surfaces `https://21.gifts`, `https://dev.21.gifts`, `https://staging.21.gifts`, `https://app.21.gifts`,
`https://dev-app.21.gifts`, `https://staging-app.21.gifts`, and `http://localhost:3000`) and methods `GET`,
`POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, with headers `Authorization`, `Content-Type`, `Time-Zone`, and `X-App-Build`.
Sessions are sent as `Authorization: Bearer` headers — no cookies,
credentials not enabled.

Public base URLs used in examples:

| Environment | API                            | App                        |
| ----------- | ------------------------------ | -------------------------- |
| PRD         | `https://api.21.gifts`         | `https://21.gifts`         |
| DEV         | `https://dev-api.21.gifts`     | `https://dev.21.gifts`     |
| STAGING     | `https://staging-api.21.gifts` | `https://staging.21.gifts` |

| Method | Path                                                 | Auth                                         | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------ | ---------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/healthz`                                           | none                                         | Liveness                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| GET    | `/info`                                              | none                                         | Service identity                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| GET    | `/.well-known/lnurlp/:username`                      | none                                         | LUD-16 payRequest served from the LNURL server for a verified wallet (needs `LNURL_SERVER_URL` and `PUBLIC_BASE_URL`); anything else is 404; an open till charge pins both sendable bounds; an open shop payment answers the OpenCryptoPay pay request; `timeout` waits up to 10 s, then 404 with the OpenCryptoPay body                                                                                                                                                                                                                                                                                       |
| PUT    | `/me/wallet`                                         | Bearer                                       | Bind wallet identity pubkey while unverified (mounted only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| PUT    | `/me/recovery-share`                                 | Bearer                                       | Store the encrypted 21.gifts share of social recovery for the verified wallet; 200 owner JSON with `socialRecoverySetUp: true`; 503 without `RECOVERY_SHARE_KEK` (mounted only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve)                                                                                                                                                                                                                                                                                                                                                                          |
| GET    | `/me/previous-wallets`                               | Bearer                                       | Wallets the account had before a social recovery commit, each with its explorer soft balance or `null` (information only) (mounted only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve)                                                                                                                                                                                                                                                                                                                                                                                                                 |
| DELETE | `/me/previous-wallets/:sparkPubkey`                  | Bearer                                       | Drop one previous wallet together with its 21.gifts share; 204 (mounted only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve)                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| POST   | `/lnurlpay/:pubkey`                                  | none                                         | Forward wallet name registration (mounted only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| POST   | `/lnurlpay/:pubkey/transfer`                         | none                                         | Forward the Lightning address transfer of a social recovery and commit the recovery on upstream 2xx (mounted only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve)                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| POST   | `/lnurlpay/:pubkey/recover`                          | none                                         | Forward signed recover, also for the new key of a pending social recovery, and settle a forwarded recovery (mounted only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve)                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GET    | `/lnurlpay/:pubkey/metadata`                         | none                                         | Forward signed payment metadata (mounted only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| GET    | `/lnurlp/:username/invoice`                          | none                                         | Forward LNURL-pay invoice for a wallet-backed username (mounted only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| GET    | `/verify/:paymentHash`                               | none                                         | LUD-21 verify forward (mounted only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| GET    | `/pay/charges/:id`                                   | none                                         | Public till receipt. `serializePosCharge`. No `accountId` and no `sparkInvoice`. 404 when missing. A paid charge is returned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| GET    | `/pay/:username/charges/:id`                         | none                                         | Same receipt when that charge belongs to `:username`. 404 when missing or owned by someone else                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GET    | `/lnurlp/cb/:username`                               | none                                         | Shop payment callback: the BOLT11 of the open amount, or the detail of one offered method and asset (mounted only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve)                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| GET    | `/lnurlp/tx/:username`                               | none                                         | Shop payment proof: `tx` or `hex` of a stablecoin transfer, checked on chain and submitted to Orchestra (mounted only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve)                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| GET    | `/lnurlp/wait/:payment`                              | none                                         | Shop payment status for the payment page, held up to 25 s with `since` (mounted only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve)                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| GET    | `/pay/:username`                                     | none                                         | Public pay-link card: display name, satoshi bounds, and the open charge (`id`, `amountSats`, `expiresAt`, and the six fiat fields) or `charge: null`                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| POST   | `/pay/:username/invoice`                             | none                                         | One BOLT11 invoice for an exact satoshi amount on the member's receiving address, plus `sparkInvoice` (or `null`) when free in-app payments are on: the open till's, or one for the posted amount                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/pay/:username/payment`                             | none                                         | Open a shop payment for an amount the payer entered (USDT and USDC through Orchestra, or its BOLT11); 404 unless `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/lnurl/pay-request`                                 | Bearer                                       | Fetch and check the LNURL pay request of an address on another host                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| POST   | `/lnurl/invoice`                                     | Bearer                                       | Fetch and check a BOLT11 from an address on another host for an exact amount                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| GET    | `/favicon.ico`                                       | none                                         | Brand mark (favicon)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| GET    | `/favicon.svg`                                       | none                                         | Brand mark (SVG favicon)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| GET    | `/apple-touch-icon.png`                              | none                                         | Brand mark (Apple touch icon)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| POST   | `/auth/passkey/register/begin`                       | none                                         | Issue WebAuthn creation options; 403 `app_outdated` when `APP_BUILD_REQUIRED` is set and `X-App-Build` differs; 503 `logins_closed` while the login switch is closed (always for a new account; a claim passes for the platform account or an allowlisted account)                                                                                                                                                                                                                                                                                                                                             |
| POST   | `/auth/passkey/register/finish`                      | none                                         | Verify attestation, issue session; 403 `app_outdated` when `APP_BUILD_REQUIRED` is set and `X-App-Build` differs; 503 `logins_closed` while the login switch is closed (platform and allowlisted accounts pass)                                                                                                                                                                                                                                                                                                                                                                                                |
| POST   | `/auth/passkey/authenticate/begin`                   | none                                         | Issue WebAuthn request options; 403 `app_outdated` when `APP_BUILD_REQUIRED` is set and `X-App-Build` differs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| POST   | `/auth/passkey/authenticate/finish`                  | none                                         | Verify assertion, issue session; 403 `app_outdated` when `APP_BUILD_REQUIRED` is set and `X-App-Build` differs; 503 `logins_closed` while the login switch is closed (platform and allowlisted accounts pass); 409 `recovery_pending` for the new passkey of a pending social recovery                                                                                                                                                                                                                                                                                                                         |
| POST   | `/auth/passkey/replace/begin`                        | Bearer                                       | 409 refusal after a valid Bearer (a recovery phrase cannot be replaced; no challenge)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| POST   | `/auth/passkey/replace/finish`                       | Bearer                                       | 409 refusal that deletes nothing and keeps the session                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| POST   | `/auth/passkey/seed/begin`                           | Bearer                                       | Creation options for one extra seed passkey; 409 when walletRequired is already true stores a failed renew row and does not change the account; a 200 stores no row; no excludeCredentials.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| POST   | `/auth/passkey/seed/finish`                          | Bearer                                       | Verify attestation, insert an additional passkey, set walletRequired true, keep the login passkey and the session. Failure stores a failed renew row. Success stores succeeded, acknowledges open failures, and returns passkeyRenewClosed false.                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/auth/passkey/recovery/begin`                       | none                                         | Social recovery: forward the old wallet's signed lookup, then issue WebAuthn creation options for a new passkey on that account; 403 `app_outdated` when `APP_BUILD_REQUIRED` is set and `X-App-Build` differs; 503 `logins_closed` while the login switch is closed (platform and allowlisted accounts pass); 503 without the LNURL server                                                                                                                                                                                                                                                                    |
| POST   | `/auth/passkey/recovery/finish`                      | none                                         | Verify the new passkey's attestation and the old wallet's signature, store a pending recovery, issue no session; same 403 `app_outdated` and 503 `logins_closed` as begin                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| GET    | `/me`                                                | `Authorization: Bearer`                      | Account (`setup` + factual `missing` + `hasPosted` + `aboutMe` + `aboutMeHasPhoto` + `aboutMessageId` + `notificationLevel` + `amountUnit` + `locale` + `fiat` + `sparkPubkey` + `sparkWalletVerified`)                                                                                                                                                                                                                                                                                                                                                                                                        |
| POST   | `/me/amount-unit`                                    | Bearer                                       | Set owner amount-entry unit (`btc` or `fiat`, default `btc`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| POST   | `/me/locale`                                         | Bearer                                       | Set owner UI language (`en`, `de`, `es`, or `fil`). Null until set. `onlyIfUnset` does not overwrite a stored value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| POST   | `/me/fiat`                                           | Bearer                                       | Set owner fiat (`CHF`, `EUR`, `USD`, or `PHP`). Null until set. `onlyIfUnset` does not overwrite a stored value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| GET    | `/me/activity`                                       | Bearer                                       | Donation given + received series (non-loan forum zaps plus daily and welcome gifts; loans, repayments, and moderator stipends omitted) plus outstanding owedSats and creditSats                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GET    | `/me/loans`                                          | Bearer                                       | The member's own loans still collecting or being repaid, with what is due now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| POST   | `/me/wallet-backup-seen`                             | Bearer                                       | Records that this account can show a recovery phrase. Not a confirmation and not a setup step. Empty body. Does not change `walletRequired`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| POST   | `/me/passkey-renew/report`                           | Bearer                                       | Client `failed` or `cancelled` renew attempt. Stores a row; does not change the account. `succeeded` is 400. Returns owner JSON including `passkeyRenewFailed`, `passkeyRenewClosed`, and `passkeyRenewPrfUnsupported`. `passkeyRenewClosed` is true only while `walletRequired` is false.                                                                                                                                                                                                                                                                                                                     |
| POST   | `/me/passkey-renew/ack`                              | Bearer                                       | Acknowledges failed unacknowledged renew rows only. Empty body. Returns owner JSON including `passkeyRenewFailed`, `passkeyRenewClosed`, and `passkeyRenewPrfUnsupported`. `passkeyRenewPrfUnsupported` is true only when the newest unacknowledged failed row is `prfUnsupported`. `passkeyRenewClosed` is true only while `walletRequired` is false.                                                                                                                                                                                                                                                         |
| GET    | `/view/:viewKey`                                     | none                                         | Public profile card by view key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GET    | `/view/:viewKey/about/photo`                         | none                                         | Profile-note photo bytes for the view-key card                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| GET    | `/view/:viewKey/activity`                            | none                                         | Public activity payload for the account behind the view key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| GET    | `/view/:viewKey/posts`                               | none                                         | Same post list as the member card, for the account behind the view key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| GET    | `/view/:viewKey/shops`                               | none                                         | Same shop list as the member card, for the account behind the view key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| GET    | `/view/:viewKey/credits`                             | none                                         | Same credit list as the member card, for the account behind the view key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| GET    | `/view/:viewKey/replies`                             | none                                         | Same reply list as the member card, for the account behind the view key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| POST   | `/me/setup/skip`                                     | Bearer                                       | Skip name or receiving-wallet (`lightning-address`) wizard step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| POST   | `/me/name`                                           | Bearer                                       | Set/replace display name (profile note when name + a verified wallet are set); auto-assign username when free                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| POST   | `/me/username`                                       | Bearer                                       | Set unique LUD-16 / NIP-05 local-part (cannot skip; fixed once wallet verified; no trailing/double dot)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| POST   | `/me/location`                                       | Bearer                                       | Set, change, or clear free-text profile location                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| PUT    | `/me/about`                                          | Bearer                                       | Set/clear About me text and optional photo on the profile note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| GET    | `/me/about/photo`                                    | Bearer                                       | Owner profile-note photo bytes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| GET    | `/pictures/me`                                       | Bearer                                       | Owner profile-photo bytes. Not the wide image and not the About me photo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| PUT    | `/pictures/me`                                       | Bearer                                       | Set or clear the round profile photo. Not the wide image and not the About me photo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GET    | `/pictures/:file`                                    | none                                         | Public profile photo when the extension matches. Kind:0 `picture`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| GET    | `/banners/me`                                        | Bearer                                       | Owner wide-image bytes. Not the About me photo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| PUT    | `/banners/me`                                        | Bearer                                       | Set or clear the wide image. A portrait is rejected. Not the About me photo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| GET    | `/banners/:file`                                     | none                                         | Public wide image when the extension matches. Kind:0 `banner`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| POST   | `/me/forum-laws-dismissed`                           | Bearer                                       | Dismiss welcome-forum living-room laws                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| POST   | `/me/wallet-intro-seen`                              | Bearer                                       | Mark the in-app wallet intro as seen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| POST   | `/me/notification-level`                             | Bearer                                       | Set owner fan-out filter (`all` / `active` / `mentions` / `none`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/me/rules-agreement`                                | Bearer                                       | Record living-room rules agreement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| GET    | `/members/:accountId`                                | Bearer                                       | Live member identity + profile note + `aboutMeHasPhoto` + counts + `trust`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| GET    | `/members/:accountId/activity`                       | Bearer or `DEBUG_*_TOKEN`                    | Same activity payload as `/me/activity` for that member                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| GET    | `/members/:accountId/posts`                          | Bearer                                       | Live member top-level notes (latest 200)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| GET    | `/members/:accountId/shops`                          | Bearer                                       | Live member shop notes (latest 200)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GET    | `/members/:accountId/credits`                        | Bearer                                       | Live member credit notes (latest 200)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| GET    | `/members/:accountId/replies`                        | Bearer                                       | Live member replies (latest 200)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| GET    | `/mentions`                                          | Bearer                                       | Suggestions for `@` (`q` empty = first 20 alphabetical). A token matches the start of the username, a `.` `_` `-` segment, or the start of the display name or one of its words; a token containing `.` `_` `-` is whole-string only. Does not store `@` marks                                                                                                                                                                                                                                                                                                                                                 |
| GET    | `/accounts/by-username/:username`                    | Bearer                                       | Exact account `{ id, username, name }`. `username` is the stored string. `name` is the stored display name, including null                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| GET    | `/trust-chain`                                       | Bearer                                       | Founder seeds (empty edges); `?around=<id>` one hop of stored public edges                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| POST   | `/trust/verify`                                      | Bearer (moderator+)                          | Staff: confirm a person in real life (`verified`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/trust/propose-moderator`                           | Bearer (moderator+)                          | Staff: propose a verified member as moderator                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| GET    | `/trust/proposals`                                   | Bearer (moderator+) or `DEBUG_*_TOKEN`       | Staff: list pending moderator proposals                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| POST   | `/trust/confirm-moderator`                           | Bearer (moderator+)                          | Staff: second, independent confirmation → `moderator`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| POST   | `/trust/reject-moderator`                            | Bearer (moderator+)                          | Staff: reject an open proposal (subject stays verified)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| POST   | `/trust/appoint-moderator`                           | Bearer (founder)                             | Founder: appoint a moderator directly                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| POST   | `/funding/apply`                                     | Bearer                                       | Open to verified and above: 400 About me / photo / location, 409 already pending, trial, or admitted, 200 pending, 503. Basis 403.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| GET    | `/funding/applications`                              | Bearer (moderator+) or `DEBUG_*_TOKEN`       | Staff pending grant queue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| GET    | `/funding/applications/:accountId`                   | Bearer (moderator+) or `DEBUG_*_TOKEN`       | Staff grant review                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| POST   | `/funding/trial`                                     | Bearer (moderator+)                          | One-UTC-day trial                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/funding/admit`                                     | Bearer (moderator+)                          | Admit grant while the round has a free place; full round → 409 `All grant places are taken`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| GET    | `/funding/places`                                    | none                                         | Public: grant round places (`round`, `startsAt`, `places`, `admitted`, `placesLeft`, `nextGoalShops`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| POST   | `/funding/reject`                                    | Bearer (moderator+)                          | Reject grant                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| GET    | `/funding/daily-roster`                              | Initiator/founder Bearer or `DEBUG_*_TOKEN`  | Operator token skips the gate; else 401 no session, then 403, then the store. Success 200 is only `{ comment, paymentsEnabled, defaultAmountUsd, recipients: [{ address, amountUsd, accountId, name }], moderatorPaymentsEnabled, moderators: [{ address, amountUsd, accountId, name }] }`. `defaultAmountUsd` is always 1. Moderator rows stay out of `recipients`. 502 Daily roster is unavailable.                                                                                                                                                                                                          |
| POST   | `/funding/daily-roster/comment`                      | Bearer, initiator or founder (moderator 403) | 401 no session, then 403, then the store. Success 200 is only `{ comment, paymentsEnabled, defaultAmountUsd, recipients: [{ address, amountUsd, accountId, name }], moderatorPaymentsEnabled, moderators: [{ address, amountUsd, accountId, name }] }`. `defaultAmountUsd` is always 1. 502 Daily roster is unavailable.                                                                                                                                                                                                                                                                                       |
| POST   | `/funding/daily-roster/payments`                     | Bearer, initiator or founder (moderator 403) | 401 no session, then 403, then the store. Success 200 is only `{ comment, paymentsEnabled, defaultAmountUsd, recipients: [{ address, amountUsd, accountId, name }], moderatorPaymentsEnabled, moderators: [{ address, amountUsd, accountId, name }] }`. `defaultAmountUsd` is always 1. 502 Daily roster is unavailable.                                                                                                                                                                                                                                                                                       |
| POST   | `/funding/daily-roster/recipients`                   | Bearer, initiator or founder (moderator 403) | 401 no session, then 403, then `{ accountId, amountUsd }`. Route loads the account. Unknown account → 400 Unknown person. No receiving address (no verified wallet) → 400 Person has no Lightning address. Store load failure → 502 Daily roster is unavailable. The API store receives `{ address, amountUsd }` with the person's receiving address. Success 200 is only `{ comment, paymentsEnabled, defaultAmountUsd, recipients: [{ address, amountUsd, accountId, name }], moderatorPaymentsEnabled, moderators: [{ address, amountUsd, accountId, name }] }`. Local bad body → Invalid person or amount. |
| POST   | `/funding/daily-roster/recipients/update`            | Bearer, initiator or founder (moderator 403) | 401 no session, then 403, then the store. Success 200 is only `{ comment, paymentsEnabled, defaultAmountUsd, recipients: [{ address, amountUsd, accountId, name }], moderatorPaymentsEnabled, moderators: [{ address, amountUsd, accountId, name }] }`. `defaultAmountUsd` is always 1. 502 Daily roster is unavailable. String address + bad amount → Invalid address or amount; otherwise Unknown address.                                                                                                                                                                                                   |
| POST   | `/funding/daily-roster/recipients/delete`            | Bearer, initiator or founder (moderator 403) | 401 no session, then 403, then the store. Success 200 is only `{ comment, paymentsEnabled, defaultAmountUsd, recipients: [{ address, amountUsd, accountId, name }], moderatorPaymentsEnabled, moderators: [{ address, amountUsd, accountId, name }] }`. `defaultAmountUsd` is always 1. 502 Daily roster is unavailable. Local bad body → Unknown address.                                                                                                                                                                                                                                                     |
| POST   | `/funding/daily-roster/moderators`                   | Bearer, initiator or founder (moderator 403) | 401 no session, then 403, then `{ accountId, amountUsd }`. Route loads the account. Unknown account → 400 Unknown person. No receiving address (no verified wallet) → 400 Person has no Lightning address. Store load failure → 502 Daily roster is unavailable. The API store receives the person's receiving address. Success 200 includes `moderatorPaymentsEnabled` and `moderators`. Moderator rows stay out of `recipients`. Local bad body → Invalid person or amount.                                                                                                                                  |
| POST   | `/funding/daily-roster/moderators/update`            | Bearer, initiator or founder (moderator 403) | 401 no session, then 403, then `{ address, amountUsd }` updates a stipend. Success 200 includes `moderatorPaymentsEnabled` and `moderators`. String address + bad amount → Invalid address or amount; otherwise Unknown address.                                                                                                                                                                                                                                                                                                                                                                               |
| POST   | `/funding/daily-roster/moderators/delete`            | Bearer, initiator or founder (moderator 403) | 401 no session, then 403, then `{ address }` deletes a stipend. Success 200 includes `moderatorPaymentsEnabled` and `moderators`. Local bad body → Unknown address.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| POST   | `/funding/daily-roster/moderators/payments`          | Bearer, initiator or founder (moderator 403) | 401 no session, then 403, then `{ enabled: boolean }` sets `moderatorPaymentsEnabled` only. Success 200 includes `moderatorPaymentsEnabled` and `moderators`. Non-boolean enabled → Invalid payments switch.                                                                                                                                                                                                                                                                                                                                                                                                   |
| GET    | `/funding/daily-roster/document`                     | Spend Bearer (invoices)                      | 503 if the token env is unset; 401 wrong/missing Bearer. Success 200 is the full document including `moderators` and `moderatorPaymentsEnabled`. `defaultAmountUsd` is always 1.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| POST   | `/funding/daily-roster/document`                     | Spend Bearer (invoices)                      | Import of the full document. 503 if the token env is unset; 401 wrong/missing Bearer. Writes only while the store is still the empty start document; a saved empty roster is already written; a second import returns 200 with the stored document. `defaultAmountUsd` in the body is ignored.                                                                                                                                                                                                                                                                                                                 |
| POST   | `/funding/daily-roster/worker/comment`               | Spend Bearer (invoices)                      | Spend Bearer. Body `{ comment: string }`. Newlines become spaces, then trim. Empty after trim is valid. Longer than 500 is 400 Invalid comment and is not cut. Success 200 is the full document. 503 if the token env is unset; 401 wrong/missing Bearer.                                                                                                                                                                                                                                                                                                                                                      |
| POST   | `/funding/daily-roster/worker/payments`              | Spend Bearer (invoices)                      | Spend Bearer. Body `{ enabled: boolean }` sets paymentsEnabled. Non-boolean enabled is 400 Invalid payments switch. Success 200 is the full document. 503 if the token env is unset; 401 wrong/missing Bearer.                                                                                                                                                                                                                                                                                                                                                                                                 |
| POST   | `/funding/daily-roster/worker/recipients`            | Spend Bearer (invoices)                      | Spend Bearer. Body `{ address, amountUsd }` adds a daily recipient. 400 Invalid address or amount, or Address already listed. Success 200 is the full document. 503 if the token env is unset; 401 wrong/missing Bearer.                                                                                                                                                                                                                                                                                                                                                                                       |
| POST   | `/funding/daily-roster/worker/recipients/update`     | Spend Bearer (invoices)                      | Spend Bearer. Body `{ address, amountUsd }` updates a daily amount. A string address with a bad amount is 400 Invalid address or amount; otherwise Unknown address. Success 200 is the full document. 503 if the token env is unset; 401 wrong/missing Bearer.                                                                                                                                                                                                                                                                                                                                                 |
| POST   | `/funding/daily-roster/worker/recipients/delete`     | Spend Bearer (invoices)                      | Spend Bearer. Body `{ address: string }` deletes a daily recipient. A bad body is 400 Unknown address. Success 200 is the full document. 503 if the token env is unset; 401 wrong/missing Bearer.                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/funding/daily-roster/worker/moderators`            | Spend Bearer (invoices)                      | Spend Bearer. Body `{ address, amountUsd }` adds a moderator stipend. 400 Invalid address or amount, or Address already listed. Success 200 is the full document. 503 if the token env is unset; 401 wrong/missing Bearer.                                                                                                                                                                                                                                                                                                                                                                                     |
| POST   | `/funding/daily-roster/worker/moderators/update`     | Spend Bearer (invoices)                      | Spend Bearer. Body `{ address, amountUsd }` updates a stipend. A string address with a bad amount is 400 Invalid address or amount; otherwise Unknown address. Success 200 is the full document. 503 if the token env is unset; 401 wrong/missing Bearer.                                                                                                                                                                                                                                                                                                                                                      |
| POST   | `/funding/daily-roster/worker/moderators/delete`     | Spend Bearer (invoices)                      | Spend Bearer. Body `{ address: string }` deletes a stipend. A bad body is 400 Unknown address. Success 200 is the full document. 503 if the token env is unset; 401 wrong/missing Bearer.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| POST   | `/funding/daily-roster/worker/moderators/payments`   | Spend Bearer (invoices)                      | Spend Bearer. Body `{ enabled: boolean }` sets moderatorPaymentsEnabled. Non-boolean enabled is 400 Invalid payments switch. Success 200 is the full document. 503 if the token env is unset; 401 wrong/missing Bearer.                                                                                                                                                                                                                                                                                                                                                                                        |
| GET    | `/funding/payout-days`                               | Bearer (moderator+) or `DEBUG_*_TOKEN`       | Staff seven-UTC-day grant payout matrix (`days`: `blocked` / `missed` / `paid`; `welcome`: seven booleans, same order)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| GET    | `/shops/activity`                                    | none                                         | 30-UTC-day shop till-charge counts (`days`: `{ day, shopCount }`, oldest first, zeros included)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GET    | `/funding/goal`                                      | Bearer (any role) or `DEBUG_*_TOKEN`         | 7-UTC-day shop till-charge counts plus how many shops had a charge on 5 of those days (`days`, `qualifyingShops`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| GET    | `/messages`                                          | none for active / Bearer                     | Public active window with no header; otherwise Bearer. List top-level notes (+ visible `replyCount`); 409 if rules missing; name-copy notes without photo, extra stills, or video are omitted; About me text stays                                                                                                                                                                                                                                                                                                                                                                                             |
| GET    | `/messages/compose-target`                           | Bearer                                       | Platform profile note `{ messageId, sats, firstPostFree }` for a 1-sat compose fee to 21.gifts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| GET    | `/messages/places`                                   | Bearer                                       | Live top-level forum pins; 409 if rules missing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GET    | `/shops`                                             | Public                                       | Public. shops of { npub, name, place }, optional nextCursor, limit default 20 max 100, 400 Invalid limit / Invalid cursor, 503 Shops are unavailable.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| GET    | `/shops/:npub`                                       | Public                                       | Public shop by npub; known hex redirects; a shop that is no longer public is 410                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| POST   | `/messages`                                          | Bearer                                       | Post text/photo; 409 if rules/name/username/verified wallet missing; 403 text-only below verified, except the free first post and a reply on the own note                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| GET    | `/messages/hidden`                                   | Bearer (moderator+) or `DEBUG_*_TOKEN`       | Staff log of soft-hidden notes (session or DEBUG_*_TOKEN)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| GET    | `/messages/:id`                                      | none / Bearer (moderator+)                   | Live public JSON; staff hidden GET includes `deletedAt`/`deletedBy`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GET    | `/messages/:id/external-shops`                       | none                                         | Public external shop list                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| GET    | `/messages/:id/external-credits`                     | none                                         | Public external credit list                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| GET    | `/links/:code`                                       | none                                         | Public 8-hex prefix of exactly one message or account id                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| GET    | `/messages/:id/replies`                              | none / Bearer (moderator+)                   | Live replies; staff `listReplies(..., true)` includes hidden children even under a live parent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| GET    | `/messages/:id/photo`                                | none / Bearer (moderator+)                   | Live photo bytes; staff hidden bytes `Cache-Control: private, no-store`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| GET    | `/messages/:id/video.*`                              | none / Bearer (moderator+)                   | Live video bytes; staff hidden bytes `Cache-Control: private, no-store`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| DELETE | `/messages/:id`                                      | Bearer (moderator+)                          | Soft-hide note + direct replies; retract in-app notifications; external target also blocks that pubkey                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| PATCH  | `/messages/:id/place`                                | Bearer (moderator+)                          | Set or replace the map pin on a live top-level shop note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| PATCH  | `/messages/:id/shop-account`                         | Bearer (moderator+)                          | Set or replace the 21.gifts account on a live top-level shop note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| PATCH  | `/messages/:id/text`                                 | Bearer (moderator+)                          | Replace the text of a live top-level shop note; the shop tag stays                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| PATCH  | `/messages/:id/photos`                               | Bearer (moderator+)                          | Replace the stills of a live top-level shop note; a video stays; no edit history                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| GET    | `/messages/:id/edits`                                | Bearer (moderator+) or `DEBUG_*_TOKEN`       | Staff edit history of a shop note, newest first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| POST   | `/messages/:id/invoice`                              | Bearer                                       | NIP-57 zap / BOLT11 plus `sparkInvoice` (or `null`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GET    | `/habits`                                            | none                                         | Public member habits. A bearer includes private notes only on the caller's own rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| POST   | `/habits`                                            | Bearer                                       | Add, edit, archive, or log a habit; comment; delete a comment; or mint `{ pr, amountSats }` for a comment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| GET    | `/messages/:id/repayment`                            | none                                         | Public credit ledger: who gave, and each repayment share                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| POST   | `/messages/:id/repayment`                            | Bearer                                       | Author pays the next giver share from their own wallet. A repeat for that unpaid share returns the outstanding invoice. Includes `sparkInvoice` (or `null`).                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| POST   | `/messages/:id/repayment/due`                        | Bearer                                       | Author gets every payable repayment bill of the loan at once (at most 60), plus the due shares that wait for a giver who cannot receive                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| POST   | `/contact`                                           | Bearer                                       | Send private in-app contact `{ text }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| GET    | `/pos`                                               | Bearer                                       | Open till charge or null, plus up to 20 history rows; `charge.shopPayment` when the LNURL server resolves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| POST   | `/pos`                                               | Bearer                                       | Pin one whole-sat amount for five minutes; ends the account's open shop payment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| DELETE | `/pos`                                               | Bearer                                       | Cancel every unexpired pending till charge and its open shop payment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| GET    | `/conversations`                                     | Bearer                                       | List visible private threads (per-row `unreadMessageCount`; envelope `unreadCount` is thread count)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GET    | `/conversations/moderator-group`                     | Bearer (moderator+)                          | Open/ensure closed moderator-group tool                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| POST   | `/conversations`                                     | Bearer                                       | Open thread from a forum note (`forumMessageId`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| GET    | `/conversations/:id`                                 | Bearer                                       | Oldest-first messages (`?sinceMessageId=` long-polls until that id exists)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| GET    | `/conversations/:id/messages/:messageId/photo`       | Bearer                                       | Private photo 0 bytes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| GET    | `/conversations/:id/messages/:messageId/photo/:file` | Bearer                                       | Private extra stills 1–9 (`{1-9}.{jpg, jpeg, png, webp}`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| POST   | `/conversations/:id`                                 | Bearer                                       | Send `{ text?, photo?, photos? }` (stills on every kind; photo rows skip Nostr)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| POST   | `/conversations/:id/invoice`                         | Bearer                                       | NIP-57 zap / BOLT11 for a private gift (`{ sats, text? }` → `{ pr, amountSats, messageId, sparkInvoice }`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| POST   | `/conversations/:id/read`                            | Bearer                                       | Stamp last-read for the viewer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| POST   | `/conversations/:id/messages/:messageId/translate`   | Bearer                                       | Translate stored conversation text (`{ target }` → `{ translatedText, cached }`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| GET    | `/notifications`                                     | Bearer                                       | List + unreadCount; drop leftover hidden forum_post/forum_reply (zap checks parent only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| POST   | `/notifications/read-all`                            | Bearer                                       | Mark all notifications read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| POST   | `/notifications/read-by-message`                     | Bearer                                       | Mark forum and zap notifications for one opened note read and return dismiss tags                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/notifications/read-visible`                        | Bearer                                       | Mark forum notifications whose event is the fully shown note read and return dismiss tags                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| POST   | `/notifications/:id/read`                            | Bearer                                       | Mark one notification read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| GET    | `/lightning-address`                                 | none                                         | Resolve LUD-16 metadata (cached)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| POST   | `/diagnostics`                                       | none                                         | `{ event }` plus optional `name`, `message`, `prfPresent`, `challengeId`, `accountId`, `stage`, `status`, `path` → `204`; 60/IP and 600 global per minute                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| GET    | `/debug/accounts`                                    | `Authorization: Bearer`                      | Operator account listing (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| GET    | `/debug/accounts/:id`                                | `Authorization: Bearer`                      | Operator one-account detail (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| POST   | `/debug/accounts`                                    | `Authorization: Bearer`                      | Operator provision name + optional username (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| PATCH  | `/debug/accounts/:id`                                | `Authorization: Bearer`                      | Operator set `role` / `platform` / `sessionRefused`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| POST   | `/debug/accounts/:id/session`                        | `Authorization: Bearer`                      | Operator mint of a member bearer (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| POST   | `/debug/accounts/merge`                              | `Authorization: Bearer`                      | Operator merge of one account into another (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| POST   | `/debug/shop-proofs/:id/retry`                       | `Authorization: Bearer`                      | Operator retry of a `stuck` shop payment proof (`DEBUG_TOKEN`; mounted only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| GET    | `/debug/api-log`                                     | `Authorization: Bearer`                      | Operator HTTP audit log (`DEBUG_TOKEN`); follow `before`/`beforeId`; no query string, body, or Authorization stored                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GET    | `/debug/diagnostics`                                 | `Authorization: Bearer`                      | Operator diagnostic log (`DEBUG_TOKEN`); newest 200; no secrets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GET    | `/debug/db`                                          | `Authorization: Bearer`                      | Operator page through every public table (`DEBUG_TOKEN`); follow `nextCursor`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| GET    | `/debug/contacts`                                    | `Authorization: Bearer`                      | Operator contact listing (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| GET    | `/debug/invoices`                                    | `Authorization: Bearer`                      | Operator invoice attempts, forum and conversation (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/debug/invoices/settle`                             | `Authorization: Bearer`                      | Resumable operator settlement of a paid forum invoice (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| POST   | `/debug/spend-ping`                                  | `Authorization: Bearer`                      | Replay one qualifying top-level forum post onto that post's UTC day and return accepted or skipped; not limited to the clock day (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| GET    | `/debug/zap-ingests`                                 | `Authorization: Bearer`                      | Operator kind:9735 ingest log (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| GET    | `/debug/messages`                                    | `Authorization: Bearer`                      | Operator forum listing including hidden rows and replies (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| GET    | `/debug/messages/:id`                                | `Authorization: Bearer`                      | Operator single-note fetch including hidden rows (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| GET    | `/debug/messages/:id/photo`                          | `Authorization: Bearer`                      | Operator photo bytes including hidden notes (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| PUT    | `/debug/messages/:id/video`                          | `Authorization: Bearer`                      | Operator restore of missing forum-video bytes (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| POST   | `/debug/messages/:id/restore`                        | `Authorization: Bearer`                      | Operator unhide of a soft-hidden forum note (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| GET    | `/debug/external-pubkeys`                            | `Authorization: Bearer`                      | Operator lists entitled and blocked external pubkeys (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| GET    | `/debug/trust-edges`                                 | `Authorization: Bearer`                      | Operator trust-edge listing (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| POST   | `/debug/trust-edges`                                 | `Authorization: Bearer`                      | Operator trust-edge backfill (`DEBUG_TOKEN`); does not change `role`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| DELETE | `/debug/trust-edges`                                 | `Authorization: Bearer`                      | Operator trust-edge delete (`DEBUG_TOKEN`); does not change `role`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| GET    | `/push/vapid-public`                                 | Bearer                                       | VAPID public key for Web Push subscribe                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| POST   | `/me/push-subscriptions`                             | Bearer                                       | Upsert a browser PushSubscription                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| DELETE | `/me/push-subscriptions`                             | Bearer                                       | Remove a browser PushSubscription                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/me/wallet/report`                                  | Bearer                                       | `{ balanceSats, syncedAt, payments }` → `{ acknowledgedIds }`; balance snapshot plus idempotent payment upsert with a server-side category; 60/account/min; 1 MiB                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/me/events`                                         | Bearer                                       | `{ events: [{ name, at, path, props }] }` (at most 50) → `{ accepted, dropped }`; allow-listed interaction log; 30/account/min; 64 KiB                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| POST   | `/debug/push-ping`                                   | Bearer `DEBUG_TOKEN`                         | Enqueue a test push for one account                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| POST   | `/debug/shop-keys`                                   | Bearer `DEBUG_TOKEN`                         | Store the existing OpenCryptoPay private key of one named shop note. Body `{ messageId, secret }`. Returns `{ messageId, npub }`. Does not log or return the secret. The same key again is success. A different stored key is 409.                                                                                                                                                                                                                                                                                                                                                                             |
| POST   | `/debug/shop-notes`                                  | Bearer `DEBUG_TOKEN`                         | Store one live top-level shop note that has a till account and no pin. Body `{ text, shopUsername, authorId }`. The pin is not accepted. Returns `{ id, shopNpub }`. `POST /messages` still refuses a shop without a pin.                                                                                                                                                                                                                                                                                                                                                                                      |
| POST   | `/debug/push-broadcast`                              | Bearer `DEBUG_TOKEN`                         | `{ title, body, link?, usernames?, dryRun? }` → 202 `{ id, targeted, queued, optedOut, noSubscription }` (dry run 200 `{ dryRun: true, recipients }`); queued on the push outbox                                                                                                                                                                                                                                                                                                                                                                                                                               |
| GET    | `/debug/push-broadcast/:id`                          | Bearer `DEBUG_TOKEN`                         | Delivery counts of one broadcast `{ id, queued, pending, delivered, dropped, failed }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| POST   | `/debug/passkey-renew/reopen`                        | Bearer `DEBUG_TOKEN`                         | Delete one account's failed passkey-renew rows so the blocking dialog opens again. Refuses when a seed is already stored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| GET    | `/debug/logins`                                      | Bearer `DEBUG_TOKEN`                         | Login switch `{ open, source, defaultOpen, allowlist }`; `source` is `stored` or `default` (`LOGINS_OPEN_DEFAULT`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| PUT    | `/debug/logins`                                      | Bearer `DEBUG_TOKEN`                         | Body `{ open }`. Stored value wins over `LOGINS_OPEN_DEFAULT`. Existing sessions are not touched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| POST   | `/debug/logins/allowlist`                            | Bearer `DEBUG_TOKEN`                         | Body `{ accountId }`. Account may start a session while logins are closed. 404 for an unknown account                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| DELETE | `/debug/logins/allowlist/:accountId`                 | Bearer `DEBUG_TOKEN`                         | Remove one account from the login allowlist                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| DELETE | `/debug/sessions`                                    | Bearer `DEBUG_TOKEN`                         | Delete every `auth_session` row → `{ deleted }`; those bearers answer 401                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| GET    | `/debug/dump`                                        | `Authorization: Bearer`                      | Operator catalog of allowlisted tables (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| GET    | `/debug/dump/:table`                                 | `Authorization: Bearer`                      | Operator catalog of one allowlisted table (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| GET    | `/gifts`                                             | none                                         | Outbound gifts for one UTC day (`?day=`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| GET    | `/gifts/stats`                                       | none                                         | Aggregated outbound gift statistics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GET    | `/fx/spot`                                           | none                                         | Current BTC price in USD, CHF, EUR, PHP (stored quote, refreshed every 5 minutes)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| GET    | `/messages/stats`                                    | none                                         | Living forum notes and replies counted together, by UTC day                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| GET    | `/invoices/passkey`                                  | Bearer `SPEND_API_TOKEN`                     | Whether a wallet address has a passkey-backed account                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| GET    | `/invoices/posted`                                   | Bearer `SPEND_API_TOKEN`                     | Live top-level post flag plus welcome media (`welcomeHasMedia` includes About me)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| GET    | `/invoices/eligible`                                 | Bearer `SPEND_API_TOKEN`                     | Whether the address is funding-eligible today, plus effective grant `status`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| POST   | `/invoices`                                          | Bearer `SPEND_API_TOKEN`                     | Fetch a recipient BOLT11 (LNURL-pay; passkey, funding grant with the 21.gifts recovery share, and forum post required)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| POST   | `/invoices/proof`                                    | Bearer `SPEND_API_TOKEN`                     | Accept payment preimage as proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| POST   | `/spend/daily-instruction`                           | Bearer `SPEND_API_TOKEN`                     | Spend Bearer. Body `{ address }`. The kind is always daily. 503 if the token env is unset; 401 wrong/missing Bearer. Success 200 is `{ action: skip, reason }` or `{ action: pay, amountUsd, comment }`, plus messageId only when the decision includes it.                                                                                                                                                                                                                                                                                                                                                    |

Auth column: "Bearer (X+)" means minimum role X — X or any higher role.

### Login controls

Two server-side request checks and one operator action for a release. The
two checks only apply to the passkey steps that lead to a session:
`POST /auth/passkey/register/begin` (new account and claim),
`POST /auth/passkey/register/finish`, `POST /auth/passkey/authenticate/begin`
(build check only), `POST /auth/passkey/authenticate/finish`, and the social
recovery ceremony `POST /auth/passkey/recovery/begin` and
`POST /auth/passkey/recovery/finish`, whose new passkey later signs in to the
recovered account. The operator mint `POST /debug/accounts/:id/session` is
exempt from both checks. Refusals are JSON `{ error, code }` with a stable
`code`:

| Check       | Status | `code`          | `error`                                             |
| ----------- | ------ | --------------- | --------------------------------------------------- |
| App build   | 403    | `app_outdated`  | `A new app version is ready. Reload the page.`      |
| Logins open | 503    | `logins_closed` | `Logins are paused for an update. Try again later.` |

- **App build.** When `APP_BUILD_REQUIRED` is set (trimmed, non-empty), the
  request must carry the header `X-App-Build` with exactly that value
  (trimmed, case-sensitive). The check runs before every other check. Unset
  or blank → no check.
- **Login switch.** `open` is the stored `app_setting` row `logins_open` once
  `PUT /debug/logins` ran, otherwise `LOGINS_OPEN_DEFAULT` (`open` | `closed`,
  default `open`; any other value stops the boot). While closed, only the
  platform account (`isPlatform`) and accounts on `login_allowlist` may start a
  session; a new registration is always refused. Finish steps check after the
  passkey is verified and before any account, credential, or session write.
  Recovery begin checks once the account of the old wallet key is found,
  before the LNURL server is contacted; recovery finish checks once the
  challenge's account is loaded, before the passkey is verified. Neither
  writes anything when refused. Existing sessions are not checked.
- **End all sessions.** `DELETE /debug/sessions` deletes every `auth_session`
  row and returns `{ deleted }`. Every bearer that held one answers 401 on its
  next request.

Storage: `app_setting` and `login_allowlist` (`docs/schema/login_gate.sql`),
migrated at boot when `DATABASE_URL` is set and covered by `db_change`; in
memory otherwise (a memory boot always starts from `LOGINS_OPEN_DEFAULT`).

## Role hierarchy

Roles have explicit ranks: `basis` 0, `verified` 1, `moderator` 2, `initiator`
2, `founder` 3. Initiator has the same rank as moderator; founder stays
strictly above. A higher rank can always do and see everything a lower rank
can; equal ranks can do the same things. Every route that names a role names
the **minimum** role: "Bearer (moderator+)" means that rank or higher,
"Bearer (verified+)" means that rank or higher. Permission text names the
minimum rank only. Do not write "moderator or initiator" or „Moderator oder
Initiator“. Permission checks use `roleAtLeast` (`src/lib/auth/roles.ts`); an
equality test on the caller's role is a defect. The single named exception is `canEditDailyPayoutRoster`: initiator and moderator share rank 2, so `roleAtLeast` cannot exclude moderators; true only for initiator and founder. Checks on the _subject_ of an
action (for example "only a verified member can be proposed as moderator") are
state rules, not permissions, and stay exact. A subject already at the
moderator rank is `sameRoleRank(role, 'moderator')`, which does not include
founder. Initiator is not created by
propose, confirm, or appoint. Only the boot UPDATE and operator
`PATCH /debug/accounts/:id` set it.

### `GET /healthz`

Liveness probe. No I/O; always succeeds when the process is up.

**Response** `200`:

```json
{
  "status": "ok",
  "service": "21gifts-api",
  "version": "0.1.0",
  "wallet": {
    "lnurlServer": true,
    "zapSigning": true,
    "freePayments": true,
    "passkey": true
  }
}
```

`version` is `SERVICE_VERSION` (env) or `"0.1.0"` when unset.

`wallet` reports which in-app wallet features this process has configured.
Each field is a boolean resolved once at boot; the response never contains an
env value, key, or URL, and `wallet` never changes `status` or the HTTP code.

| Field          | `true` when                                                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lnurlServer`  | `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` are http(s) URLs (`resolveLnurlServerConfig`)                                                                                  |
| `zapSigning`   | `LNURL_ZAP_NSEC_HEX` is 64 hex characters and `SPARK_OPERATOR_URL` is unset, blank, or http(s)                                                                          |
| `freePayments` | `lnurlServer` and `zapSigning`: free in-app payments between members are on                                                                                             |
| `passkey`      | `WEBAUTHN_RP_ID` is a known RP ID and an allowed CORS origin matches it (`resolveWebAuthnConfig`, the check the passkey routes make); otherwise those routes answer 500 |

### `GET /info`

Service identity for clients. Does not expose runtime configuration.

**Response** `200`:

```json
{
  "service": "21gifts-api",
  "version": "0.1.0",
  "description": "Backend for 21.gifts — peer-to-peer Bitcoin Lightning donations with NOSTR-native communication.",
  "repository": "https://github.com/21gifts/api"
}
```

### `GET /.well-known/lnurlp/:username`

Public LUD-16 payRequest for `<username>@<host of PUBLIC_BASE_URL>` (in
production `username@21.gifts`). No auth. Looks up the
stored username via `getAccountByUsername` after `normalizeUsername` on
the path param. A member receives only on their in-app wallet: when
`LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve and the account has a
verified wallet key (`sparkPubkeyVerifiedAt` is a number), the pay request
comes from the self-hosted LNURL server (`GET /.well-known/lnurlp/<username>`,
5 s timeout, fixed `Host`, 120 requests per minute per client address); it is
returned only when `walletPayRequest` accepts it with callback
`<PUBLIC_BASE_URL>/lnurlp/<username>/invoice`. There is no pass-through to
any other provider. The LNURL server is asked first on every request, also
when the answer below is the OpenCryptoPay pay request of a shop payment;
its `metadata` is the metadata of that pay request.

CORS origin and methods match `/.well-known/nostr.json`
(`Access-Control-Allow-Origin: *`, methods `GET` / `OPTIONS`).
The pay request itself is `Cache-Control: no-store`. `public, max-age=60`
stays on `GET /.well-known/nostr.json` only.

Every error body on this route has the five fields of the shop payment
error body ([Shop payment in USDT and USDC](#shop-payment-in-usdt-and-usdc)):
`statusCode`, `message`, `error`, `status` (`ERROR`), and `reason`, the
last four except `status` carrying the same text. The one exception is the
404 for no pending payment (under `timeout` below): it adds the shop's
OpenCryptoPay fields, and its `error` is `Not Found` while `message` and
`reason` are `No pending payment found`, as in the standard's example.

Username invalid (`normalizeUsername` returns null), unknown
(`getAccountByUsername` undefined), an account without a verified wallet,
or the LNURL server not configured → **Response** `404`:

```json
{
  "statusCode": 404,
  "message": "Not found",
  "error": "Not found",
  "status": "ERROR",
  "reason": "Not found"
}
```

For a verified wallet key, an upstream 404 → **Response** `404` with the
same body.

The store throws → **Response** `502` with the text
`Lightning Address could not be resolved`.

For a verified wallet key, over the limit → **Response** `429` with the
text `Too many requests`.

For a verified wallet key, the LNURL server being unreachable, another
non-2xx status, unparsable JSON, or a document `walletPayRequest` rejects
→ **Response** `503` with the text `Lightning Address could not be resolved`.

Success → **Response** `200`. When the LNURL server is not configured, the
route is the 404 above. When it resolves, the shop payment rules below
decide between today's pay request and the OpenCryptoPay pay request.

**Today's pay request.** The provider payRequest JSON. Callback and
metadata are not rewritten. A waiting charge rewrites only `minSendable`
and `maxSendable`, both to the charge amount in millisats. A waiting charge
is an unexpired pending till charge with no shop payment, or whose shop
payment is `ended`. A charge whose shop payment is `open` is answered as
the open amount below. A pending charge whose shop payment is `accepted` or `paid` does not pin, so
the response is the unpinned pay request, and any LNURL wallet can still
pay the sticker.

**Open amount.** The account's open amount is its shop payment whose
status is `open` while `now` is before its `window_ends_at`. An account has
at most one. While it exists, the response is the OpenCryptoPay pay request
for it, with or without `timeout`, written with `Content-Type:
application/json`, CORS `*`, methods `GET, OPTIONS`, and
`Cache-Control: no-store`. The table is the complete body:

| Field               | Value                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `id`                | the username                                                                                                             |
| `tag`               | `payRequest`                                                                                                             |
| `callback`          | `<PUBLIC_BASE_URL>/lnurlp/cb/<username>`                                                                                 |
| `minSendable`       | the payment's sats times 1000                                                                                            |
| `maxSendable`       | the same value                                                                                                           |
| `metadata`          | the metadata of today's pay request, unchanged                                                                           |
| `displayName`       | the trimmed account name, or the username when it is blank (as `GET /pay/:username`)                                     |
| `standard`          | `OpenCryptoPay`                                                                                                          |
| `possibleStandards` | `["OpenCryptoPay"]`                                                                                                      |
| `displayQr`         | `false`                                                                                                                  |
| `recipient`         | `{ "name": <the same shop name> }`                                                                                       |
| `quote`             | `{ "id": <current quote id>, "expiration": <quote expiry>, "payment": <shop payment id> }`                               |
| `requestedAmount`   | `{ "asset": "BTC", "amount": <sats / 100000000> }`, a JSON number in plain notation (never `1e-8`)                       |
| `transferAmounts`   | the stored array of the current quote: Lightning first, then each offered method in method-table order, USDT before USDC |

A `transferAmounts` entry is
`{ "method", "minFee", "assets": [{ "asset", "amount" }], "available": true }`.
Lightning has `minFee` 0 and one asset `BTC` whose `amount` is the sats
divided by `SATS_PER_BTC` (`satsToBtcString`, put through the canonical
form). A stablecoin method has `minFee` in wei as a JSON
number and one asset per offer, whose `amount` is the offer's `amountIn`
divided by 10 to the power of its decimals. Every `amount` string has no
exponent, no trailing zero after the point, and no point for a whole
number (`0.00001`, `1.5`, `12`): the canonical decimal form of
`canonicalDecimal` (`src/lib/decimal.ts`), which `canonicalGoalAmount`
uses with eight decimals and the stablecoin amounts with 6 or 18.
Timestamps are `toISOString` output.

A fetch returns the current quote unchanged unless it is replaced. A quote
is replaced when it has a stablecoin entry, less than 45 s remain before
its expiry, at least 45 s remain before `window_ends_at`, the payment has
had fewer than 4 replacements, and stablecoin rows are on for the
username. The replacement runs under the account's creation lock, within
4 s: route list, Orchestra quotes, and offer checks for the same sats and
the same BOLT11. Its external calls (route list, gas prices, quotes) end
`SHOP_REPLACEMENT_COMMIT_MARGIN_MS` (500 ms) before those 4 s, so the
transaction below normally commits inside a fetch's 4 s wait. Under the
account row lock it then reads the payment's
newest quote: when that is no longer the quote the replacement started
from (a fetch's Lightning-only row, or another container's replacement,
came first), it inserts nothing and answers with that newest quote.
Otherwise it increments `shop_payment.replacements` with one
conditional update (`status` `open`, `replacements` unchanged, at least
45 s left in the window) and inserts the new quote only when that update
changed the row; otherwise it answers with the quote that is current then.
A replacement that sent no quote request (no route list, no candidate
pair, no fresh spot, or no quote budget) runs the same conditional update
without the increment and inserts its Lightning-only row, because a
Lightning-only row made without an Orchestra call is not a replacement.
The replacement and the Lightning-only fallback read the clock after the
account row lock.
A second fetch in the same process joins the running replacement. A fetch
waits for the replacement at most until the earlier of 4 s after it
arrived and 4 s after the replacement took the lock; a replacement still
queued behind a creation or a stalled lock holder therefore costs the
fetch at most 4 s. After that wait the fetch answers from the state then
(the current quote while it is valid, else the Lightning-only row below),
and the replacement finishes in the background; when its transaction lands
after that Lightning-only row, it inserts nothing.
When no new offer passes, the new quote is Lightning-only (its expiry is
`window_ends_at`); a Lightning-only quote is never replaced. A current quote
whose expiry has passed and that is not replaced gets a new Lightning-only
quote row, which is not a replacement. `quote.payment` never changes for a
payment. When the payment stops being `open` between these steps, the api
reads the account's state again. When another payment is the open amount
now (a new payer amount replaced it, or a charge's creation inserted one),
the request answers that open amount as above, once per request. Otherwise,
and when that payment also stops being `open` before it is answered, it
answers as without an open amount from the state: a charge that is still
waiting keeps today's pinned pay request, and anything else gets today's
unpinned one (or, with `timeout` or `method`, the 404 for no pending
payment).

**Waiting for a pending charge.** A pending charge with no shop payment
first starts or joins the creation procedure when stablecoin rows are on
for the username, and waits for it at most until 8 s after the fetch
arrived (`SHOP_PAY_LINK_CREATION_WAIT_MS`, as long as the procedure's 8 s
budget and separate from it), with or without `timeout`, whatever the
creation is still waiting for, lock waits and the wallet's own pay request
included. The arrival is taken as the route's first statement. A charge
has at most one creation in flight, from the moment it is queued until it
ends: requests for the same charge (and the creation `POST /pos` starts)
share it instead of queueing another run, and a joining request's wait
still ends 8 s after its own arrival. A creation that outlasts the wait
goes on in the background. A creation that ends earlier (it re-reads and
stops at once because the charge already has a payment or is no longer
pending, or it fails) ends the wait right away, and the next request starts
a new one. Whatever the outcome (a payment, a skipped or failed creation, a
charge cancelled, paid, or expired meanwhile, or the wait used up), the api
then reads the account's state again and answers from it: the open-amount
pay request when the payment is open by then, today's pinned pay request
while the charge is still waiting, and otherwise today's unpinned one. A
request with `timeout` that reaches this point only 8 s or more after it
arrived (after its `timeout` wait) still starts or joins the creation, but
does not wait for it and answers today's pinned pay request; the creation
goes on in the background.

**`timeout`.** When the query has `timeout` (any value, also empty), the
value is a whole number of seconds: only digits count, values above 10
count as 10, and anything else counts as 0. Until the time is up the api
re-reads every `WAIT_SATS_POLL_MS` (250 ms) until it finds an open amount
or a pending charge whose shop payment is missing or `open`. At most 50
requests per process wait at the same time; a further request checks once
and answers at once. With an open amount or such a charge the answer is as
without `timeout`. With neither (a pending charge whose shop payment is
`accepted`, `paid`, or `ended` counts as nothing waiting) →
**Response** `404`:

```json
{
  "id": "<username>",
  "displayName": "<shop name>",
  "standard": "OpenCryptoPay",
  "possibleStandards": ["OpenCryptoPay"],
  "displayQr": false,
  "recipient": { "name": "<shop name>" },
  "statusCode": 404,
  "message": "No pending payment found",
  "error": "Not Found",
  "status": "ERROR",
  "reason": "No pending payment found"
}
```

**Simplified flow.** A request with `method` first applies the rules
above, including `timeout` and replacement. With an open amount it then
answers exactly as `GET /lnurlp/cb/:username` with that `method`, the
request's `asset`, and the current quote id; a repeated `quote`,
`method`, or `asset` key is the callback's 400. When the payment stops
being `open` after its current quote was read and before that answer
reads the account's state (for example, a new payer amount replaced it),
the request reads the state again as under **Open amount** above:
another open amount is answered the same way, once per request, and
otherwise it is the 404 above, never the callback's 404 `Quote expired`.
Without an open amount it is the 404 above.

Usernames `invoice` and `cb`, and any username that ends in `.`, never get
stablecoin rows: no shop payment is created for them, and they keep
today's pay request, pinned while a till charge is pending, also with
`timeout`, `method`, or `asset` (no wait and no 404).

### `PUT /me/wallet`

Bearer session. Mounted only when `LNURL_SERVER_URL` and
`PUBLIC_BASE_URL` resolve; otherwise Hono's default 404.
`LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve when both are http or
https URLs (`resolveLnurlServerConfig`); otherwise the feature is off.
Body:

```json
{ "sparkPubkey": "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
```

`sparkPubkey` must normalise to 66 lowercase hex matching
`/^0[23][0-9a-f]{64}$/`. Claims the key via `claimSparkPubkey` while the
account is unverified. A second PUT overwrites freely until verification.
Requires a non-blank username and `walletRequired: true`.

Missing/invalid bearer → **Response** `401` `{ "error": "Unauthorized" }`.

Bad body or key → **Response** `400`
`{ "error": "Expected a JSON body with a \"sparkPubkey\" of 66 hex characters" }`.

Blank/null username → **Response** `409`
`{ "error": "missing_requirements", "missing": ["username"] }`.

`walletRequired` not true → **Response** `409`
`{ "error": "Wallet is not set up" }`.

Already verified (or concurrent verification) → **Response** `409`
`{ "error": "Wallet is already connected" }`.

Success → **Response** `200` with the owner JSON (includes `sparkPubkey`
and `sparkWalletVerified`). Logs `account.wallet.claimed` `{ accountId }`
(never the key).

### `PUT /me/recovery-share`

Bearer session. Stores the 21.gifts share of social recovery
([docs/social-recovery.md](docs/social-recovery.md), The 21.gifts share).
Mounted only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve;
otherwise Hono's default 404. Body (strict):

```json
{
  "sparkPubkey": "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "share": "<20 lowercase words of 4 to 8 letters, single spaces>"
}
```

`share` is the raw SLIP-39 mnemonic of member index 2, not the app's QR
payload. The api encrypts it with `RECOVERY_SHARE_KEK` (AES-256-GCM, the
account id as additional data) and stores the envelope for that wallet key in
one locked step under the account row; a second PUT for the same wallet
replaces it. No route returns it, and nothing in the api decrypts it.

Missing/invalid bearer → **Response** `401` `{ "error": "Unauthorized" }`.

No `RECOVERY_SHARE_KEK` (a memory boot), checked before the body →
**Response** `503` `{ "error": "Social recovery is unavailable" }`.

Bad JSON, another shape, a `sparkPubkey` that does not normalise to 66
lowercase hex, or a share that is not 20 lowercase words → **Response** `400`
`{ "error": "Expected a JSON body with sparkPubkey and a recovery share" }`.

Wallet not verified → **Response** `409`
`{ "error": "Wallet is not connected" }`.

`sparkPubkey` is not the account's verified wallet key, also when the wallet
changes before the locked write → **Response** `409`
`{ "error": "Wallet changed" }`.

Encryption or store throw → **Response** `503`
`{ "error": "Social recovery is unavailable" }` and
`account.recovery_share.failed` `{ accountId }` with the error name and code.

Success → **Response** `200` with the owner JSON, now with
`socialRecoverySetUp: true`. Logs `account.recovery_share.stored`
`{ accountId, replaced }`; never the share, the key, or the body. The first
share of the current wallet (not a replacement) reads the grant and, when the
member is eligible today with that share, sends the daily ping of today's
newest live top-level photo or video, as `POST /funding/trial` does, without
a second share read. A failed grant read or ping logs
`funding.daily_ping.failed` `{ accountId }` and the answer stays 200.

**Storage.** `recovery_share` (`docs/schema/recovery_share.sql`): primary key
`(account_id, spark_pubkey)`, `recovery_share_ciphertext`, `stored_at`.
`recovery_share_ciphertext` is a secret column: `db_change` keeps only its
SHA-256 and `GET /debug/db` only its length. Migrated with the auth schema
when `DATABASE_URL` is set and covered by `db_change`; in memory otherwise.

### `GET /me/previous-wallets`

Bearer session. The wallets the account had before a social recovery commit,
newest first. Mounted only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL`
resolve; otherwise Hono's default 404.

**Response** `200`:

```json
{
  "wallets": [
    {
      "sparkPubkey": "0281363910b0dc0015a4a25e758da30f0e28388ea5252c0e3713936f2d4ef7d3d5",
      "sparkAddress": "spark1…",
      "replacedAt": 1761700000000,
      "balanceSats": 1234
    }
  ]
}
```

`wallets` is empty when there is none. `replacedAt` is the commit time (epoch
ms). `balanceSats` is the soft balance (`btcSoftBalanceSats`, incoming
transfers that are not claimed yet included), which the api reads for every
wallet in parallel, anonymously and without an API key, from the public
explorer `GET https://api.sparkscan.io/v1/address/<sparkAddress>?network=MAINNET`
(5 s timeout, no redirects). Any failure or another shape gives `null`
(unknown) and logs `spark_explorer.unavailable` (with the explorer's HTTP
status when there is one, never the address). The value is information
only: no route and no app action depends on it.

Missing/invalid bearer → **Response** `401` `{ "error": "Unauthorized" }`.

Store throw → **Response** `503` `{ "error": "Wallet data is unavailable" }`
and `account.previous_wallets.failed` `{ accountId }`; the explorer is not
called.

**Storage.** `previous_wallet` (`docs/schema/previous_wallet.sql`): primary
key `(account_id, spark_pubkey)`, `spark_address`, `replaced_at`, written by
the recovery commit. Migrated with the auth schema when `DATABASE_URL` is set
and covered by `db_change`; in memory otherwise.

### `DELETE /me/previous-wallets/:sparkPubkey`

Bearer session. Drops one previous wallet of the account and, in the same
statement, the account's 21.gifts recovery share of that key. The app offers
it only once that wallet, opened with its words, reads a balance of 0.
Mounted only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve;
otherwise Hono's default 404.

Missing/invalid bearer → **Response** `401` `{ "error": "Unauthorized" }`.

`:sparkPubkey` does not normalise, or is not a previous wallet of the
account (also on a repeat) → **Response** `404` `{ "error": "Not found" }`.

Store throw → **Response** `503` `{ "error": "Wallet data is unavailable" }`
and `account.previous_wallets.failed` `{ accountId }`.

Success → **Response** `204` with no body. Logs
`account.previous_wallet.dropped` `{ accountId }`, never the key.

**Storage.** Deletes the `previous_wallet` row
(`docs/schema/previous_wallet.sql`) and the account's `recovery_share` row of
that key (`docs/schema/recovery_share.sql`) in one statement. Migrated with
the auth schema when `DATABASE_URL` is set and covered by `db_change`; in
memory otherwise.

### `POST /lnurlpay/:pubkey`

Forward wallet name registration to the self-hosted LNURL server.
Mounted only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve. No api
session; the wallet sends signature data in the body or
`x-breez-signature` / `x-breez-timestamp` headers. Rate limit
30/min/client. Body cap 1 MB (1 048 576 bytes); a
larger body gets 413 `{ "error": "Request body is too large" }` and the
upstream is not contacted. A request without a validated
`cf-connecting-ip` is not counted by the per-address limits.

**Gate** (fail → 404 `{ "error": "Not found" }`, upstream not contacted):
`normalizeSparkPubkey(:pubkey)` not null; body is a JSON object with
string `username`; `body.username` must consist only of printable ASCII
characters; the body has no other key that equals `username` after NFKC
normalisation and lower-casing (for example `Username`);
`normalizeUsername(username)` not null; the
account for that name exists with `sparkPubkey === pubkey`; no other
account is verified on that key.

Upstream `POST /lnurlpay/<pubkey>` with the parsed JSON re-serialised as
the body (15 s), so the LNURL server receives exactly one `username`
member — the one the gate checked. Path segments forwarded to the LNURL
server are only `A-Z a-z 0-9 . _ ~ -` and never `.` or `..`; a refused
segment is 404 without contacting upstream. On upstream 2xx,
`markSparkPubkeyVerified` runs before the response
(`account.wallet.verified` when it stores the timestamp). When that write
does not store a timestamp, the account is re-read: if it still holds
this key with `sparkPubkeyVerifiedAt` a number (a repeat of an already
verified registration), the upstream response is passed through;
otherwise **Response** `409`
`{ "error": "Wallet registration could not be confirmed" }` and
`account.wallet.unconfirmed` `{ accountId }`. Upstream 2xx passed through
with its status, body and only the `content-type` / `cache-control`
headers (a 204 stays a 204). Upstream 4xx passes body and status through
without verifying. Unreachable, store throw, or any other upstream status
outside 2xx and 4xx (for example 5xx) → **Response** `503`
`{ "error": "Lightning address service is unavailable" }`. Over limit → 429. Body too large → 413.

On `/lnurlpay/*`, the allow-list CORS (same origins) additionally allows
the request headers `X-Breez-Signature` and `X-Breez-Timestamp`.

### `POST /lnurlpay/:pubkey/transfer`

Forward the Lightning address transfer of a social recovery
([docs/social-recovery.md](docs/social-recovery.md)) to the self-hosted
LNURL server, and commit the recovery when the server moves the name.
Mounted only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve. No api
session: the Breez SDK (`claimLightningAddressTransfer`) sends both wallets'
signatures in the body. `:pubkey` is the **new** wallet key. Rate limit
30/min/client. Body cap 1 MB (1 048 576 bytes); a larger body gets 413
`{ "error": "Request body is too large" }` and the upstream is not contacted.

Body (Breez SDK 0.26.0):

```json
{
  "username": "alice",
  "description": "Pay to alice@21.gifts",
  "from_pubkey": "0281363910b0dc0015a4a25e758da30f0e28388ea5252c0e3713936f2d4ef7d3d5",
  "from_signature": "<lowercase hex DER>",
  "to_signature": "<lowercase hex DER>",
  "timestamp": 1761700000
}
```

**Gate** (fail → 404 `{ "error": "Not found" }`, upstream not contacted):
`normalizeSparkPubkey(:pubkey)` not null; the body is one JSON object with
no other key that equals one of those six names after NFKC normalisation and
lower-casing; `username` consists only of printable ASCII characters and
normalises (`normalizeUsername`); `description` is a string of at most 255
code points; `from_pubkey` normalises; both signatures are strings;
`timestamp` is a safe non-negative integer within 600 s of the api clock
(Unix seconds); and both signatures verify as the LNURL server checks them:
lowercase hex DER, low S, over one SHA-256 of the UTF-8 message, for the
host of `PUBLIC_BASE_URL` (lower-cased) as `<domain>`. `from_pubkey` signs
`breez-lnurl:v2\ntransfer-from\n<domain>\n<username>\n<from_pubkey>\n<:pubkey>\n<timestamp>`
and `:pubkey` signs
`breez-lnurl:v2\ntransfer-to\n<domain>\n<username>\n<from_pubkey>\n<:pubkey>\n<lowercase SHA-256 hex of description>\n<timestamp>`.
So malformed or unsigned bodies never use up a pending recovery.

**Admission** (fail → 404, upstream not contacted). One locked step under
the account row marks the account's pending recovery forwarded
(`forwardedAt`, the time after the body and the checks). It needs a pending
recovery whose new key is `:pubkey`, that is not forwarded yet and not
expired (`CHALLENGE_TTL_MS` after the finish), and whose old key is
`from_pubkey`, still the account's verified `sparkPubkey`, on an account
that is not session-refused and whose normalised username is `username`.
Logs `account.recovery.forwarded` `{ accountId }`.

Upstream `POST /lnurlpay/<:pubkey>/transfer` with the parsed JSON
re-serialised as the body (15 s). On upstream 2xx the recovery commits in one
transaction under the account row, only while the account still holds the old
key verified and the forwarded pending recovery: the old key and its
`spark_address` go to `previous_wallet`; every passkey
credential, session, and push subscription of the account is deleted and the
new passkey inserted; `spark_pubkey` becomes the new key with its
`spark_address` and `wallet_required` true, keeping
`spark_pubkey_verified_at`; open `recovery` challenges are consumed and the
pending row is deleted. Username, `session_refused`, the Nostr key, and
recovery shares stay. Logs `account.recovery.committed`
`{ accountId, via: "claim" }`. When the commit does not land, because the
forwarded pending recovery is already gone, or because the account no longer
holds the old key verified (then the commit deletes the pending recovery) →
**Response** `409` `{ "error": "Wallet registration could not be confirmed" }`
and `account.recovery.unconfirmed` `{ accountId }`; this request changes no
account, and no pending recovery remains to settle.

Upstream 2xx (after the commit) and every upstream 4xx (for example 409
`"signature has already been used"`) pass through with their status, body
and only the `content-type` / `cache-control` headers. Unreachable (including
the 15 s abort) or any other upstream status → **Response** `503`
`{ "error": "Lightning address service is unavailable" }`
(`lnurl_server.unreachable` `{ route: "transfer" }`). A store throw →
the same 503 (`lnurl_server.failed` `{ route: "transfer" }`). After an
upstream 4xx, 5xx or abort, and after a throw in the commit, the pending
recovery stays forwarded and the account unchanged; a throw at admission
leaves it unforwarded and contacts no upstream. Over limit → 429. Body too
large → 413.

**Storage.** `pending_recovery` (`docs/schema/pending_recovery.sql`): at most
one row per account (`account_id` primary key; `new_spark_pubkey` and
`credential_id` unique) with the old and new wallet keys, the new passkey's
credential id, public key and sign count, `created_at`, and `forwarded_at`.
It holds no secret. The commit also writes `previous_wallet`,
`passkey_credential`, `auth_session`, `push_subscription`, `account`, and
`passkey_challenge` in the same transaction. Migrated with the auth schema
when `DATABASE_URL` is set and covered by `db_change`; in memory otherwise.

### `POST /lnurlpay/:pubkey/recover`

Forward signed recover. Mounted only when `LNURL_SERVER_URL` and
`PUBLIC_BASE_URL` resolve. Rate limit 30/min/client. Body cap 1 MB
(1 048 576 bytes); a larger body gets 413
`{ "error": "Request body is too large" }` and the upstream is not contacted.

**Gate:** pubkey normalises; `auth.isSparkPubkeyClaimed(pubkey)`, or, for a
key no account claims, the key is the new key of a pending social recovery
that is forwarded or not expired. Fail → 404. Upstream
`POST /lnurlpay/<pubkey>/recover` (15 s). Status mapping:
upstream 2xx passed through with its status, body and only the
`content-type` / `cache-control` headers (a 204 stays a 204); upstream
404 → 404; unreachable, store throw, or any other upstream status (other
4xx and 5xx) → 503 as above.

**Settling** (rule 5 of [docs/social-recovery.md](docs/social-recovery.md)).
After the upstream answer and before the response, the api reads what the
lookup proves: 200 with a JSON object whose `username` normalises means the
key holds that name; 404 with the JSON string `"user not found"` means the
server verified the signature and the key holds no name; anything else
proves nothing. The lookup settles a forwarded pending recovery whose new
key is the path key, or, for the verified key of an account, that account's
forwarded pending recovery from that key, but only when it was sent more
than 30 s (twice the 15 s upstream timeout) after the recovery's
`forwardedAt`. Then the new key holding the account's username commits the
recovery (as `POST /lnurlpay/:pubkey/transfer` does on upstream 2xx), the old
key's verified `"user not found"` commits it too, and the old key holding the
username drops it; logs `account.recovery.committed` or
`account.recovery.dropped` `{ accountId, via: "lookup" }`. Every other case
keeps it. Settling never changes the answer to the wallet. A settling failure
logs `account.recovery.settle_failed` and is swallowed.

### `GET /lnurlpay/:pubkey/metadata`

Forward signed metadata for received payments. Mounted only when
`LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve. Rate limit
120/min/client. Raw query string forwarded unchanged. A `HEAD` request is
answered 404 and the LNURL server is not contacted.

**Gate:** pubkey normalises; `getAccountByVerifiedSparkPubkey(pubkey)`
exists. Fail → 404. Upstream `GET /lnurlpay/<pubkey>/metadata` + query
(15 s). Status mapping as recover.

### `GET /lnurlp/:username/invoice`

Forward LNURL-pay invoice for a wallet-backed username. Mounted only when
`LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve. Rate limit 20/min/client.
CORS `*`
(`Access-Control-Allow-Origin: *`, methods `GET` / `OPTIONS`). Raw query
string forwarded unchanged. A `HEAD` request is answered 404 and the LNURL
server is not contacted.

**Gate:** `normalizeUsername(:username)` not null; account exists and
`sparkPubkeyVerifiedAt` is a number. Fail → 404. Upstream
`GET /lnurlp/<username>/invoice` + query (15 s). Status mapping as
recover. Upstream may return HTTP 200 with
`{ "status": "ERROR", "reason": … }`. Unreachable → 503 as above.

The account's pending point-of-sale charge is read before the upstream
call. After an upstream 2xx whose JSON `pr` decodes to exactly
`amountSats * 1000` of that charge, the payment hash is recorded against that charge for
[paid detection](#point-of-sale-paid-detection), under the payment hash
claim (see Creation). When another charge's invoice row or another shop
payment already holds that hash (`recordInvoice` returns
`other_payment`), the BOLT11 is not handed out: the route logs
`shop.alert.duplicate_invoice` (`chargeId`, `holderChargeId`, and
`paymentId` only when a shop payment holds it) and answers **503**
`{ "error": "Lightning address service is unavailable" }`. Otherwise the
response is unchanged; a store failure logs `pos.invoice.record_failed`
and the invoice is still handed out.

### `GET /verify/:paymentHash`

LUD-21 payment verification forward. Mounted only when
`LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve. Forwarded for a payment
hash whose path segment is only
`A-Z a-z 0-9 . _ ~ -` and is neither `.` nor `..` (for example
`a%2Fb` decoded to `a/b` is refused). A refused segment → 404
`{ "error": "Not found" }` without contacting upstream and without an
`lnurl_server.unreachable` log. No query string. Rate limit
120/min/client. CORS `*`. A `HEAD` request is answered 404 and the LNURL
server is not contacted. Upstream `GET /verify/<paymentHash>` (15 s) with
the segment joined as-is (no percent-encoding). Status mapping as recover
for reachable outcomes; network / timeout / redirect / body-read failure →
503 as above.

### Shop payment in USDT and USDC

Implements [docs/shop-stablecoin-payment.md](docs/shop-stablecoin-payment.md).
A payer settles a shop payment in USDT or USDC. Orchestra takes the coin
and pays one BOLT11 for the shop's sats, minted on the shop's verified
in-app wallet by the mint `POST /pay/:username/invoice` uses
(`requestGiftInvoice`). The shop receives an ordinary bitcoin payment and
never holds USDT or USDC.

The routes `POST /pay/:username/payment` (answers 404 otherwise),
`GET /lnurlp/cb/:username`, `GET /lnurlp/tx/:username`,
`GET /lnurlp/wait/:payment`, and `POST /debug/shop-proofs/:id/retry` are
mounted, and the shop payment cases of `GET /.well-known/lnurlp/:username`
and `/pos` apply, only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL`
resolve. Stablecoin rows are offered only when `resolveShopPaymentConfig`
also resolves all four of `ORCHESTRA_BASE_URL` (absolute `https` origin
without path, query, or user info), `ORCHESTRA_API_KEY` (a server key
`fn_…`; a client key `fnp_…` is refused), `SHOP_EVM_RPC` (a non-empty JSON
object from decimal chain id to an absolute `https` URL), and
`SHOP_REFUND_ADDRESS` (`0x` and 40 hexadecimal characters). An invalid
value turns the stablecoin rows off and the process still boots. Without
them no shop payment is created, so the pay link answers today's pay
request (or, with `timeout` and nothing waiting, the 404 for no pending
payment), and `POST /pay/:username/payment` answers 503
`stablecoin_unavailable`.
Rows live in `shop_payment`, `shop_quote`, `shop_offer`, `shop_proof`, and
`shop_proof_lookup` (`docs/schema/shop_payment.sql`) when `DATABASE_URL` is
set, and in memory otherwise.

**Methods.** `Ethereum` (1), `Arbitrum` (42161), `Optimism` (10),
`Polygon` (137), `Base` (8453), and `BinanceSmartChain` (56), each with
USDT and USDC at the contracts and decimals of the contract's method
table. Pairs are requested in this order: USDT on `Ethereum`,
`Arbitrum`, and `Polygon`, then the remaining pairs in table order, USDT
before USDC. A pair is a candidate only when Orchestra's route list
(`GET /v2/orchestration/routes`, 1 s timeout, reused only until its
`validForMs` has passed since the request started; at most 25 fetches per
minute per process, `ORCHESTRA_ROUTES_PER_MINUTE`) names it with `exactOutTo` admitting `lightning:BTC`, its
contract and decimals equal the table (otherwise `shop.route.mismatch`),
and `SHOP_EVM_RPC` has an endpoint for the chain. Request matching of
method and asset ignores case; responses write the table names.

**Creation.** A till charge (after `POST /pos`, or the first pay-link
fetch) or `POST /pay/:username/payment` runs one procedure under the
account's in-process creation lock; a second caller for the same account
waits for the first:

1. In one transaction, end a lapsed `open` payment of the account with
   `end_reason` `window`. For a charge, stop with its existing shop
   payment, or when the charge is no longer pending or has expired. For a
   payer, stop with 409 `payment_open` when a charge is pending. The
   transaction first takes the account row lock (`SELECT … FOR UPDATE`),
   then the charge row lock for a charge, or for a payer the account's
   overdue pending charges, which it expires, and only then ends the lapsed
   payment, the order the settlement step and the charge watch take.
2. Stop unless stablecoin rows are on for the username, unless the
   account's 60 s no-pair wait has passed, and unless the api-wide counter
   (60 creations per minute) and then the account counter (10 per minute)
   allow it. The counters are per process.
3. Read the route list and select the candidate pairs. A failed route-list
   fetch, or one the route-list budget refuses → stop (no stablecoin until
   a fetch succeeds; the next creation fetches again). No candidate pair → stop and start the account's 60 s
   no-pair wait.
4. Mint one BOLT11 for the sats with one 4 s deadline for both LNURL calls.
   A failed mint or a BOLT11 of another amount stops the procedure as a
   failed mint. A payment hash that another charge's or a payer's shop
   payment already holds stops it the same way and logs
   `shop.alert.duplicate_invoice`; when the charge's own shop payment holds
   it, that payment is used and the procedure ends. Its expiry is the
   request time plus the `expiry` tag, or plus 3600 s without one
   (`bolt11ExpiresAtMs`). For a charge, the hash is then recorded against
   the charge with `recordInvoice`, which runs as its own claim transaction
   and returns `recorded`, `this_charge`, `other_payment`, or `not_open`:
   `other_payment` stops as a failed mint with the alert, `not_open` stops
   quietly, and the other two go on. When `recordInvoice` fails with an
   error, `pos.invoice.record_failed` is logged and nothing is written, so
   a fetch answers today's pinned Lightning request. A payer creation never
   records against a charge; it reads `findChargeForPayment({ paymentHash })`
   instead: a hit stops as a failed mint with the alert, and an error writes
   nothing and answers order 9.
5. Within 3 s, read `eth_gasPrice` per chain and request one Orchestra
   exact-out quote per candidate pair in parallel, for as many pairs as the
   quote budget (240 per minute) allows. Each quote pays the BOLT11, is
   tagged with the payment id, and sends `SHOP_REFUND_ADDRESS`. Without a
   stored spot quote whose USD rate has an `asOf` younger than 10 minutes
   (the creation never waits for a spot fetch), no gas price or quote is
   requested and each of those pairs logs `shop.offer.rejected` with
   `check` `price`.
6. Keep each quote that passes the offer checks: `targetAmountOut` equals
   the sats; `amountIn` is a positive integer within `requiredAmountIn` and
   `maxAcceptedAmountIn` when present; the transaction's chain id and token
   contract equal the table; its value is zero; its data is exactly the
   ERC-20 `transfer(depositAddress, amountIn)`; the deposit address is not
   used by another offer of the batch; `expiresAt` minus 30 s is at least
   45 s ahead; the BOLT11 expires at least 600 s after `expiresAt`; and
   the stored BTC spot quote has a USD rate with an `asOf` younger than 10
   minutes, and `amountIn` in USD is at most 5 % above the sats' value at
   it: the rate is parsed with `parseUsdPerBtc` (USD per BTC times 10^8),
   and the check runs in BigInt with no rounding,
   `amountIn × 10^16 × 100 ≤ sats × rate × 10^decimals × 105`. Without a
   fresh rate the check fails. A quote whose chain's gas price
   could not be read is not kept either. A failed check logs
   `shop.offer.rejected` with the check name. A quote that failed logs it
   too: `check` `body` for an HTTP 200 whose body does not parse, `http`
   for a request sent without an HTTP 200 answer (another 2xx included),
   and `budget` when no request could be sent.
7. None kept → stop and start the 60 s no-pair wait.
8. In one transaction that first takes the payment hash claim
   (`SELECT pg_advisory_xact_lock($1, $2)`: a fixed namespace and the first
   32 bits of the hash as a signed integer; an in-process map shared with
   the charge store on a memory boot), then the account row lock
   (`SELECT … FOR UPDATE`), and for a charge then the charge row lock.
   Holding them, it writes nothing and answers order 9 when its request
   arrived 16 s ago or longer (`SHOP_CREATION_INSERT_LIMIT_MS`; the
   arrival of `POST /pay/:username/payment`, of the `POST /pos` that started
   the charge's creation, or of the pay-link fetch that started it) or,
   for a payer, when the client disconnected (the request's abort signal is
   set). A `pos_charge_invoice` row of another charge for the hash stops it
   before anything is ended or inserted, as a failed mint with
   `shop.alert.duplicate_invoice`. A charge that is no longer
   pending or has expired gets nothing; a payer with a pending charge gets
   409 `payment_open`. When the account's `open` payment is this charge's
   own payment, it is used and nothing is inserted. Before anything is
   ended, the payment that holds the BOLT11's payment hash is read: this
   charge's own payment is used; any other holder rolls the whole
   transaction back, logs `shop.alert.duplicate_invoice`, deletes the
   charge invoice row only when step 4 of this attempt inserted it, and
   ends as a failed mint, so nothing else is written and an `open` payment
   stays `open`. Otherwise an `open` payment of the account ends (`window`
   when its window passed, else `superseded` for a charge or `replaced` for
   a payer), then the payment is inserted with its first quote and offers.
   The window ends at the charge's `expiresAt`, or five minutes after
   creation for a payer. An offer whose deposit address another offer holds
   is dropped (`shop.alert.shared_deposit_address`) and the quote holds only
   the inserted offers. A lost insert on the payment hash that the charge's
   own payment holds uses that payment; a holder that appeared after the
   check rolls back as above, including the end of the `open` payment.

Every external call runs outside a database transaction. The quote expiry
(`quote.expiration`) is the earliest of `window_ends_at` and every offer's
`expiresAt` minus 30 s; a Lightning-only quote ends at `window_ends_at`.

**States.** `shop_payment.status` is `open`, `accepted`, `paid`, or
`ended`; every change is one conditional update. `open` → `ended` when the
window ends, `POST /pos` supersedes it, a new payer amount replaces it, the
charge is cancelled, or the charge is paid by another invoice
(`charge_paid`). `open` or `ended` (not closed) → `accepted` when one of
its proofs is accepted. `open`, `ended`, or `accepted` (not closed) →
`paid` when its BOLT11 settles. `accepted` → `ended` when the accepted
proof is refunded, fails, or is refused without another proof taking its
place (`orchestra_refunded`, `orchestra_failed`, `proof_refused`), or when
the final settlement read finds the BOLT11 unpaid (`expired_unpaid`). The
final settlement read, 10 minutes after the BOLT11 expiry, sets
`closed_at` on a payment that is not paid; a paid or closed payment never
changes again.

**Error body.** Every error on the callback, the proof, and the wait route,
and every error on the pay link, is:

```json
{
  "statusCode": 400,
  "message": "<text>",
  "error": "<text>",
  "status": "ERROR",
  "reason": "<text>"
}
```

`POST /pay/:username/payment` uses `{ "error", "code" }` instead.

### `GET /lnurlp/cb/:username`

Shop payment callback. No auth. Mounted only when `LNURL_SERVER_URL` and
`PUBLIC_BASE_URL` resolve. Registered after `GET /lnurlp/:username/invoice`,
so `GET /lnurlp/cb/invoice` stays the invoice forward of the username
`cb`. CORS `*`, methods `GET, OPTIONS`, `Cache-Control: no-store`. A `HEAD`
request is answered 404. Rate limit 120/min/client; over it →
**Response** `503` with the text `Too many requests` (not 429, because
Tether Wallet reads a 4xx here as final). All errors use the shop payment
error body. A store or service failure → **Response** `503` `Lightning
address service is unavailable` (logs `lnurl_server.failed` with `route`
`callback`).

Invalid username, the username `invoice`, unknown account, or no verified
wallet → **Response** `404` `Not found`.

**LNURL amount path** (no `method`): when the account has an open amount
and `amount` equals its sats times 1000 → **Response** `200`
`{ "pr": "<bolt11>", "routes": [] }` with the payment's BOLT11. Otherwise
→ **Response** `400` `Amount does not match this payment`. This path never
mints.

**Detail** (with `method`), checked in this order:

| Order | Condition                                                                                                                                    | Response                                 |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1     | `quote` or `asset` is missing, or `quote`, `method`, `asset`, or `amount` is repeated.                                                       | **400** `That payment is not offered`    |
| 2     | No open amount, `quote` is not a UUID or (in lowercase) neither the current nor the previous quote of the open amount, or its expiry passed. | **404** `Quote expired`                  |
| 3     | `method` `Lightning` and `asset` `BTC` (any case).                                                                                           | **200** `{ "pr": "<bolt11>" }`           |
| 4     | A stablecoin method and asset that the quote offers with `available` true.                                                                   | **200** with the stablecoin detail below |
| 5     | Anything else.                                                                                                                               | **400** `That payment is not offered`    |

Stablecoin detail:

```json
{
  "expiryDate": "<quote expiry>",
  "blockchain": "<method>",
  "uri": "ethereum:<token>@<chainId>/transfer?address=<deposit address>&uint256=<amountIn>",
  "hint": "Pay this URI. Then send the transaction hash as tx, or the signed raw transaction as hex, with quote and method, to <PUBLIC_BASE_URL>/lnurlp/tx/<username>"
}
```

The URI carries the lowercase contract, the decimal chain id (also 56 for
`BinanceSmartChain`), the lowercase deposit address, and `amountIn` in
decimal. The first detail of an offer sets `shop_offer.detail_issued_at`
and, when the payment has none yet, `shop_payment.next_history_at` 10 s
ahead, which starts the watcher's order reads. A repeat returns the same
detail while the quote is valid.

### `GET /lnurlp/tx/:username`

Shop payment proof. No auth. Mounted only when `LNURL_SERVER_URL` and
`PUBLIC_BASE_URL` resolve. CORS `*`, methods `GET, OPTIONS`,
`Cache-Control: no-store`. A `HEAD` request is answered 404. Rate limit
120/min/client. All errors use the shop payment error body. A store or
service failure → **Response** `503` `Payment is being confirmed` (logs
`lnurl_server.failed` with `route` `proof`), so the wallet repeats the
proof as after any 5xx.

Invalid username, the username `invoice`, unknown account, or no verified
wallet → **Response** `404` `Quote expired`, because no quote of a shop
payment of that username exists.

Query: `quote`, `method`, an optional `asset`, and exactly one of `tx` or
`hex`; unknown keys are ignored. Checked in this order: a repeated
`quote`, `method`, `asset`, `tx`, or `hex` → **Response** `400`
`Payment was not accepted`; `quote` that is not a UUID or not a quote of a
shop payment of this username (current or earlier, any status) →
**Response** `404` `Quote expired`; a missing or unknown `method`
(matched without case), neither or both of `tx` and `hex`, or a malformed
value → **Response** `400` `Payment was not accepted`. A request over the
rate limit gets **Response** `503` `Too many requests` for every case
above and for a proof that is not stored yet; a stored proof is answered
from its row as it stands. Without the stablecoin configuration or without
an RPC endpoint for the method's chain, a stored proof is answered as it
stands and a new one → **Response** `503` `Payment is being confirmed`,
with nothing stored or sent: the quote is this username's, only its
verification cannot run now, and the wallet retries. 404 `Quote expired`
stays bound to quote membership.

The whole request stays within 18 s; each RPC call times out after 3 s and
Orchestra gets at most 10 s. A step the budget no longer allows is left to
the watcher, and the stored row answers (**503** while unresolved).

- `tx`: 64 hexadecimal characters with or without `0x`, stored as `0x`
  plus the lowercase hash (`normalizeHex32`). The hash of a published
  transaction or of an ERC-4337 user operation.
- `hex`: optional `0x`, then an even number of 100 to 4096 hexadecimal
  characters: a signed EVM transaction the wallet did not publish.

**Repeat.** Before any chain read, a stored proof of this quote's offers
whose `tx_hash` or `user_op_hash` equals the `tx`, or whose `tx_hash`
equals the hash of `hex`, answers from that row (the `accepted` row first,
then the row of the request's `asset`, then the oldest). Within the budget
a row without a log index reads its receipt once, a `hex` row that was
never sent is sent, and an unresolved row with a log index whose last
submit is empty or at least 2 s old is submitted again (at most 5 times per
minute per proof).
A hash only proofs of other quotes hold is not a repeat.

**Verification of `tx`.** `eth_getTransactionReceipt`, else
`eth_getUserOperationReceipt` with the same hash; a failed RPC call counts
as not found. Neither found → a lookup row (at most 4 rows per quote, done
ones included, counted under the quote's row lock) and **Response** `503`
`Transfer not found yet`; the watcher keeps looking. A receipt that did not succeed (`status` not
`0x1`, or a user operation whose `success` is not `true`) → **Response**
`400` `Payment was not accepted`. The ERC-20 `Transfer` logs to an offer's
deposit address from that offer's contract (only offers of `asset` when it
is given) select the offer, a log with the offer's `amountIn` first. No
such log → **Response** `400` `Payment was not accepted`, or
`Transaction already used` when every such log belongs to a proof of
another quote. One proof is one log (`chain_id`, `tx_hash`, `log_index`);
its value is stored, and a different amount is still submitted.

**Verification of `hex`.** A legacy (EIP-155), EIP-2930, or EIP-1559
transaction whose chain id is the method's, whose `to` is an offer
contract of this quote and method (of `asset` when given), whose value is
zero, whose data equals that offer's transfer data byte for byte, and
whose fee reaches the offer's `minFee` (`hexFeeReaches`; for EIP-1559 the
current `eth_gasPrice` is read). A failed check → **Response** `400`
`Payment was not accepted`, nothing stored or sent. A gas price that cannot
be read → **Response** `503` `Payment is being confirmed`, nothing stored.
Otherwise the proof is stored with `raw_hex` and sent with
`eth_sendRawTransaction`. `already known` or `nonce too low` counts as
sent when `eth_getTransactionByHash` finds the hash; `insufficient funds`,
`invalid`, or `intrinsic gas` records the proof `refused` and answers 400;
any other error answers 503 and the watcher sends it again. Within the
budget the request then reads the receipt once. A `hex` proof is submitted
only once its receipt with status `0x1` is found and has filled the log
index, so that Orchestra can see the deposit (a `xchain_deposit_mismatch`
is then definitive for it too); without a receipt yet the request answers
**503** `Payment is being confirmed`, the receipts duty reads and sends the
transaction again, and the submits duty submits it after the fill. A
receipt with another status records the proof `refused`. A transaction
the node still does not know keeps the proof unresolved until its
`give_up_at`, after which it becomes `stuck` like any unresolved proof.

**Submit.** Every verified proof with a log index is submitted to Orchestra
(`POST /v1/orchestration/submit` with `{ quoteId, txHash }`), also when the
payment is `ended`, `paid`, or already `accepted`, and after the quote
expired. An order makes the proof follow its status; `400
xchain_deposit_mismatch` refuses it; `409 quote_expired` makes it `late`;
anything else leaves it unresolved for the watcher.

Responses by stored result:

| Stored result                | Response                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `accepted`                   | **200** `{ "txId": "<tx_hash>" }`                                                                    |
| `superseded`                 | **400** `Another transfer is paying this payment`                                                    |
| `late`                       | **400** `Invoice expired`                                                                            |
| `refunded`                   | **400** `The transfer was refunded`                                                                  |
| `failed`                     | **400** `The transfer was not completed`                                                             |
| `refused`                    | **400** `Transaction already used` when `refusal` is `tx_used`, otherwise `Payment was not accepted` |
| unresolved, held, or `stuck` | **503** `Payment is being confirmed`                                                                 |

A proof becomes `accepted` when its Orchestra order is progressing
(`processing`, `confirming`, `awaiting_approval`, `swapping`, `bridging`,
`delivering`) and its transferred value lies within the offer's
`requiredAmountIn` (or `amountIn`) and `maxAcceptedAmountIn` (or
`amountIn`), while the payment is neither paid nor closed and no other
proof of it is `accepted` (otherwise `superseded`; a `superseded` proof
whose order resumed is accepted the same way once no proof is `accepted`),
or when its order `completed`. A proof whose amount is unknown or outside those bounds, whose
order is `refunding`, `unfulfilled`, or unknown, or whose payment is
already paid, is held and answers 503 until its order is final. Acceptance
moves the payment to `accepted`, so it stops being the open amount and the
next pay-link poll with `timeout` is the 404 for no pending payment.
`txId` is the transaction hash; Orchestra's order id is never sent.

A `completed` order makes its proof `accepted` (from unresolved,
`superseded`, `late`, `refused`, or `stuck`) and, in the same transaction,
makes the proof that was accepted first `superseded`. The other final
statuses map as follows: `refunded` → `refunded`, `failed` and
`fallback_delivered` → `failed` (`shop.alert.order_failed`), and `expired`
→ `refused` with `refusal` `expired_order`; each moves only from the
results the States table allows. A progressing order of a proof whose
payment is already closed makes the proof `late`
(`shop.alert.late_deposit`). When the proof that was `accepted` becomes
`refunded`, `failed`, or `refused` while the payment is neither paid nor
closed, the oldest `superseded` proof of the payment (earliest
`created_at`, then `id`) whose order is progressing and whose amount is
known and within the bounds becomes `accepted` in the same transaction and
the payment stays `accepted`; only when none qualifies does the payment end
(`orchestra_refunded`, `orchestra_failed`, or `proof_refused`).

**Locks.** Every transaction that changes a proof's result, the merge of
two rows of one deposit, the order-status duty's step for a replaced
order, and the orders duty's `next_history_at` decision first lock the
payment's `shop_payment` row, then every proof row of the payment with one
`SELECT … FOR UPDATE` ordered by id (`lockPaymentForProofs`); none of them
locks an account row. A submit answer whose order a row of another payment
holds (step 3 below) reads that row's payment without a lock first, then
locks both `shop_payment` rows in the order of their ids, then the proof
rows of both payments with one `SELECT … FOR UPDATE` ordered by id
(`lockPaymentsForProofs`), and reads the holder again under the locks; a
holder that moved to a payment not locked applies the answer once more in
a new transaction. The two statements that write several existing
`shop_payment` rows take them in the order of their ids too: the
watcher's lapsed-window end (`endLapsedWindows`, `SELECT … ORDER BY id
FOR UPDATE`, then one `UPDATE` of the locked ids) and
`POST /debug/accounts/merge`, which locks the merged account's payment
rows (`SELECT … ORDER BY id FOR UPDATE`) after both account rows and all
its charge rows and before it moves them. Every other transaction locks or
writes at most one existing `shop_payment` row. The settlement step locks the account,
`pos_charge`, and `shop_payment` rows (a payer's payment only its
`shop_payment` row) and no proof row, so no two of these wait for each
other in opposite order. Every transaction that locks or writes both
`pos_charge` and `shop_payment` rows takes the account row lock first, then
the `pos_charge` rows, then the `shop_payment` rows: the settlement step,
the charge watch, `POST /pos`, `DELETE /pos`, the creation's step 1
re-check and its step 8 insert (after the payment hash claim), and the
merge (both account rows, then all of the merged account's charge rows in
the order of their ids, then its payment rows, before it deletes or moves
any of them). The amount of a `hex` proof is the amount in its
verified transfer `data`; a `tx` or `detected` proof's is the value of its
`Transfer` log.

**One deposit, two rows.** Every path that stores a proof (the route, the
lookup duty, and the order duty) first reuses a stored row of the same
offer and transaction, which takes a missing log index, value,
user-operation hash, or order. An order goes only to a row that has none:
a second order of the same transaction and offer gets its own row, and
while an unlogged row of that offer and transaction still exists, the
order is stored on a later history read, once that row has its log index.
When a submit or a filled-in log index or order shows that two rows hold
one deposit, rows of the same offer merge in one transaction: the
`accepted` row is kept, else the row that holds an order, else the older
one; it takes the log index,
value, and order of the other row that it lacks, and the order's status
travels with `provider_order`. Two rows that hold different orders are
never merged: a row whose only matching transfer log another row of the
same offer and transaction holds with another order (a successor or
recovered order paid by the same transaction) keeps no log index, stays
its own proof, and is no longer read. When the other row belongs to another offer, the
row whose log index or order is being filled in (the later fill) is
recorded `refused` with `refusal` `tx_used` when the collision comes from
storing a proof (step 4); when it comes from a submit or a status read
that returned an order another row holds (step 3), the newer of the two
rows (later `created_at`, then the greater id) is, from any result the
States table allows for `refused`; an `accepted` one included, which lets
a `superseded` proof take its place or ends the payment with
`proof_refused`. A proof refused as `tx_used` keeps its order but is no
longer followed: its submits, receipt reads, and status reads stop, and a
status read already in flight when it is refused applies nothing. When
step 3 refuses the row that held the order (it is the newer one), the
order moves in the same transaction to the submitted proof, the older row
that survives: the refused row gives up `provider_order` and
`order_status`, the survivor records the order (its submits stop and the
status duty reads it) with the refused row's `order_found_at`, so the fast
reads and the 24 h status limit do not restart, and with a final status the
refused row stored rather than the submit's answer, and is evaluated. An
`accepted` refused row hands its place to a survivor of the same payment
only when that evaluation accepts it (a progressing order or `completed`,
as the States table states); otherwise, and always when the survivor
belongs to another payment (it is evaluated on its own payment), the
oldest qualifying `superseded` proof of the refused row's payment takes
the place, or that payment ends with `proof_refused`. While the order is
`refunding`, `unfulfilled`, or an unknown status the survivor is held, is
not `accepted`, and answers 503 until the States table accepts it (a later
`completed` moves it to `accepted` and an `ended` payment that is not
closed back to `accepted`) or its order is final. The newer row that holds
the order may belong to another payment: it is refused and hands the order
over the same way, under both payment rows' locks, and every change to
that payment (its proof's refusal, `shop.proof.refused`, and the loss of
its accepted proof) happens under its row lock. When the newer row that
holds the order was already ended by that order (`refunded`, `failed`,
`refused` with `expired_order`, or a stored final status), it cannot be
refused and keeps the order (Orchestra counted the deposit on its offer);
the submitted row is then recorded `refused` with `tx_used` instead, and
its submits stop. A newer row already `refused` for another reason
(`mismatch`, `hex_rejected`) whose order is not final keeps its result and
hands the order to the survivor as above.

**Replaced orders.** A status read that answers `unfulfilled` with a
`supersededByOperationId` of another order does not move the proof: it
keeps its order with the `unfulfilled` status (held, or still `accepted`),
its status reads stop without `shop.alert.order_stuck`, the successor's id
is stored as its `superseded_by_order`, and the payment's
`successor_wait_until` moves 24 h ahead (`SHOP_SUCCESSOR_WAIT_MS`) when it
is empty or earlier and its `next_history_at` is set to now when it is
empty. The orders duty then stores the successor order, which carries its
own `sourceTxHash`, as its own `detected` proof, so every row keeps its own
transaction and order; an order recovered from an order a proof holds is
stored the same way. A replaced proof that was never accepted answers a
repeat with 503.

**Log fields.** Each shop event is one `logEvent` line with `paymentId`,
and with `quoteId`, `offerId`, `proofId`, `providerRef` (Orchestra's quote
id), or `orderId` where it applies: the proof events carry the proof's
offer, quote, provider reference, and order (`shop.alert.proof_stuck`,
`shop.alert.order_stuck`, and `shop.proof.retried` included); the
Orchestra client's
`shop.orchestra.error`, `shop.orchestra.rate_limited`,
`shop.orchestra.budget_exhausted`, and `shop.alert.orchestra_request`
carry the ids of the payment or proof the call is for. The creation picks
the payment's id before its route-list read, so `shop.route.mismatch`,
`shop.mint.failed`, and `shop.alert.duplicate_invoice` carry it too.
`shop.alert.duplicate_invoice` of a creation carries that `paymentId`, and
`holderPaymentId` and `holderChargeId` when they are known (a payer's
`findChargeForPayment` hit and a `pos_charge_invoice` row of another charge
in step 8 carry only `holderChargeId`); from the invoice routes it carries
`chargeId` (the pending charge), `holderChargeId` when a charge holds the
hash, and `paymentId` (the holding payment) only when a shop payment holds
it. `shop.creation.failed` is logged once by a charge's creation that
throws, whether `POST /pos` or a pay-link fetch started or joined it, with
`accountId`, `chargeId`, and the error's `name`, `code`, and `errno`, and
once by a quote replacement that throws, with `accountId` and
`paymentId`; the fetch is answered from the state.

### `GET /lnurlp/wait/:payment`

Shop payment status for the payment page. No auth. Mounted only when
`LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve. CORS `*`,
`Cache-Control: no-store`. A `HEAD` request is answered 404. Rate limit
120/min/client; over it → **Response** `429` `Too many requests` with the
shop payment error body. A store failure → **Response** `503` `Lightning
address service is unavailable` with that body (logs `lnurl_server.failed`
with `route` `wait`).

`:payment` that is not a UUID (`normalizeUuid`; any letter case, looked up
in lowercase) or no shop payment → **Response** `404` `Not found` with the
shop payment error body.

**Response** `200`:

```json
{ "status": "Pending", "paymentStatus": "accepted", "invoiceExpiresAt": "2026-10-17T12:20:00.000Z" }
```

`paymentStatus` is the stored status. `status` is DFX's
`PaymentLinkPaymentStatus`: `Completed` when `paid`; for an `ended`
payment with `closed_at` set, `Cancelled` when `end_reason` is
`superseded`, `replaced`, or `cancelled` and `Expired` otherwise; else
`Pending`. `invoiceExpiresAt` is the BOLT11 expiry. Without `since`, or
when `status` is not `Pending`, the answer is immediate. With
`?since=<paymentStatus>`, the request waits while the stored status still
equals `since` and `status` is `Pending`, re-reading every
`WAIT_SATS_POLL_MS` (250 ms) for up to `WAIT_SATS_TIMEOUT_MS` (25 s), both
from `src/lib/message.ts`, then answers with the state on hand.

### Point-of-sale paid detection

No HTTP route. A background worker (`startPosPaidWorker`, every 2 s like
the Spark invoice worker) runs when `LNURL_SERVER_URL` and
`PUBLIC_BASE_URL` resolve. It watches charges that are `pending`, or
`expired` less than ten minutes ago; it stops watching a charge once it is
paid or cancelled.

- **Spark:** with free in-app payments on, the Spark invoice stored for a
  charge (`POST /pay/:username/invoice`) is queried through
  `query_spark_invoices` on the Spark coordinator. `FINALIZED` marks the
  charge paid.
- **Lightning:** every BOLT11 the api hands out for the shop at exactly the
  charge amount while the charge is pending (the forwarded
  `GET /lnurlp/:username/invoice` and `POST /pay/:username/invoice`) is
  recorded with its payment hash in `pos_charge_invoice`. The worker asks
  the LNURL server's LUD-21 `GET /verify/<paymentHash>`; `settled: true`
  marks the charge paid.

Marking paid is one conditional update: the first confirmation wins and
later ones change nothing. A charge can become paid only from `pending` or
`expired`, never from `cancelled`. The api reads the open charge
before it mints an invoice and records the invoice against that charge
only when the charge's `expiresAt` is after that issue time (and it is not
cancelled or paid). So the issue time decides, not the write or poll time:
a payment confirmed after the five minutes for an invoice issued inside
them still marks the charge paid, and an invoice is never attached to a
charge opened while it was being minted. No
zap receipt, gift, or message is written for a till payment. Logs:
`pos.paid` (account id only), `pos.spark.query_failed`,
`pos.verify.failed` (count only), `pos.worker.tick.failed`.

**Shop payment of the charge.** With the LNURL server resolved, marking a
charge paid runs in one transaction together with its shop payment
([Shop payment in USDT and USDC](#shop-payment-in-usdt-and-usdc)), locking
the account row, then the `pos_charge` row, then the `shop_payment` row.
The account is the charge's current one: the charge is read again after
the account lock, and when an account merge moved it meanwhile, the
account it moved to is locked instead (at most two account locks; a
charge gone or still moving changes nothing and is read again on the next
tick). When the settled hash is the shop payment's `payment_hash`, the shop
payment moves to `paid`; when the charge was already paid by another
invoice before, that logs `shop.alert.double_settled`, and when it was
cancelled before, `shop.alert.cancelled_settled` (the charge stays
cancelled). When the Spark invoice or another BOLT11 settled,
an `open` shop payment ends with `end_reason` `charge_paid`. The shop
payment's BOLT11 is recorded against the charge, so Orchestra paying it is
one of the BOLT11s above.

**Shop payment tick.** `startPosPaidWorker` also starts a second tick
(`startShopPaymentWorker`) for the shop payment duties, every 2 s, without
overlap, separate from the charge watch's tick so that a slow Orchestra or
RPC call never delays a till confirmation. Its duties run in this order,
each with its own call budget per tick and a 5 s timeout per call, taking
rows by their own next-try column, oldest first:

1. **End lapsed windows:** `open` payments whose `window_ends_at` passed
   end with `window`.
2. **Settlement:** the LUD-21 `GET /verify/<paymentHash>` read of the
   charge watch (`verifyLightningPayment`) for payments that are neither
   paid nor closed, `accepted` and charge-backed payments first, every 5 s
   for 15 minutes after creation, then every 30 s, and a final read 10
   minutes after the BOLT11 expiry. Each read is applied under the lock of
   locks of a charge-backed payment: the account row, then the
   `pos_charge` row, then the `shop_payment` row; when an account merge
   moved the payment between the unlocked read and the lock, the account
   it moved to is locked instead (`lockAccountOf`, at most two locks; a
   payment still moving is left for the next tick). A payer's payment locks
   only its `shop_payment` row. Settled → `paid`, and `markPaid` for its
   charge (a charge already paid by another invoice logs
   `shop.alert.double_settled`; a cancelled charge logs
   `shop.alert.cancelled_settled` and stays cancelled). Only a successful
   final read that reports the invoice unpaid closes the payment; an
   `accepted` payment then ends with `expired_unpaid` and logs
   `shop.alert.accepted_unpaid`, an `open` one ends with `window`, and
   both log `shop.payment.ended` with the reason. The duty waits until
   every read of the tick and its write have ended before it rethrows the
   first failure. A payment `accepted` for more than one
   hour logs `shop.alert.accepted_long` once per process.
3. **Orders** (odd ticks): Orchestra history by the payment's BOLT11 every
   10 s, one page per read, from the first issued detail until 30 minutes
   after its last offer's `expiresAt`, also after the payment is paid or
   closed. An order no proof holds is stored as a `detected` proof, an
   order recovered from one a proof holds included. A failed read keeps
   the offset. The offers alone decide whether that watch has ended: while
   it runs, or while a full page is read on, the next read is after 10 s;
   once it has ended, every read, a failed one included, decides the next
   one under the payment row and its proof rows: while some proof's
   `superseded_by_order` is held by no proof and `successor_wait_until` has
   not passed, the payment is read every 60 s
   (`SHOP_SUCCESSOR_HISTORY_INTERVAL_MS`) instead; when the wait passes
   first, the duty logs `shop.alert.successor_missing` and clears
   `next_history_at` and `successor_wait_until` together.
4. **Lookups:** `tx` hashes not yet found, after 10 s, 30 s, and 60 s, then
   every 2 min for one hour (`shop.proof.lookup_expired`).
5. **Receipts:** `hex` proofs without a receipt and `detected` proofs
   without a log index, after 30 s, then every 2 min, until `give_up_at`
   (24 h after it was stored, or after an operator retry; a `detected`
   proof's is never moved), and a `hex` proof only while it has neither a
   result nor an order. A `hex` transaction without a receipt is sent
   again, however long the node does not know it, so a transaction mined
   late is still submitted. A receipt that fills the log index of a `hex`
   proof sets its `next_submit_at` to 10 s after the fill when none is
   scheduled and the proof may still be submitted (no result, no order).
6. **Submits:** unresolved proofs that may still be submitted and have a
   log index. A proof stored with its log index is first due 10 s after it
   was stored, and a proof whose log index is filled later 10 s after the
   fill; each watcher submit schedules the next one 20 s, then 30 s later,
   then every 5 min, so either is submitted after 10 s, 30 s, and 60 s,
   then every 5 min. A retried proof is submitted at its retry, then about
   20 s and 50 s later, then every 5 min.
7. **Stuck proofs:** an unresolved proof past its `give_up_at` (24 h after
   it was stored, or after an operator retry) becomes `stuck`
   (`shop.alert.proof_stuck`); `POST /debug/shop-proofs/:id/retry` moves it
   back.
8. **Order status** (even ticks): Orchestra status by order id every 10 s
   for 10 minutes, then every 60 s, until a final status or 24 h after the
   order was found (`shop.alert.order_stuck`), or an `unfulfilled` status
   with `supersededByOperationId` (see Replaced orders; no alert). A proof
   refused as `tx_used` is not read. The stop at a stored final status and
   the 24 h stop clear `next_status_at` only while the proof, read again
   under its payment row and proof rows, still holds the order, status,
   and `next_status_at` the duty selected; the alert is logged once, by the
   container whose transaction cleared it, with fields read in that
   transaction. A status read is applied only while the proof, read again
   under its payment row and proof rows, still holds that order and the
   duty still follows it: it has an order and a set `next_status_at` and
   is not refused as `tx_used`, the selection's own conditions. A proof
   the duty stopped during the call (a final status, the 24 h stop, a
   replaced order, a `tx_used` refusal) keeps its result, refusal,
   status, and schedule, its payment does not change, and nothing is
   logged. A status read sets the next read only while `next_status_at`
   is still the one the duty selected, so a row another container's read
   rescheduled meanwhile keeps that schedule; the status is still
   applied, unless the proof holds a final status of that order by then.
   A final status is terminal: no later write of the same order replaces
   it (a status in progress or another final one), re-evaluates the
   proof, or restarts the reads, as the same-offer merge keeps a final
   status.

A rejecting tick logs `shop.worker.tick.failed`.

Orchestra calls also count against the in-process budgets per minute:
quotes 240, submits 30 (proof requests at most 20), status and history
reads 50 together, route-list fetches 25. An HTTP 429 pauses only the endpoint that answered it,
until its `Retry-After` (seconds) or else its `X-RateLimit-Reset` (epoch
ms): status and history pause separately although they share one budget.
A quote that got the 429 sends its one retry once that pause ends, when it
ends inside the step's time; otherwise the retry is not sent.

### `GET /pos`

Bearer session. Returns the signed-in member's open point-of-sale charge,
or `charge: null`, plus up to 20 newest rows of any status. A pending row
whose `expiresAt` is not in the future is marked `expired` before the
response and is not `charge`. Amounts are whole sats. TTL is five minutes.

Status is `pending`, `paid`, `cancelled`, or `expired`. Every charge object
carries `paidAt` (ISO-8601, or `null` until paid). The api marks a charge
`paid` once a payment for an invoice it handed out for that charge is
confirmed (see [Point-of-sale paid detection](#point-of-sale-paid-detection)).
`charge` is the pending charge, or else the newest row when it was paid less
than 60 s ago, so the till can show the confirmation after a late poll.
`history` includes paid rows. A paid charge no longer pins the LNURL-pay
bounds.

When `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve, `charge` also
carries `shopPayment`: `{ "id": "<uuid>", "status": "open" | "accepted" | "paid" | "ended" }`
for the charge's shop payment, or `null` when it has none. The till shows
`accepted` as "on its way" and the charge as paid only when the charge is
`paid`. `history` rows never carry it, and without the LNURL server the key
is absent.

The currency the operator typed and that exact decimal string are stored on
the charge at creation. This response returns that string to the shop.
`GET /pay/:username` returns the same string to the payer. Both show it.
Typing 12.00 stores 12.00. Both sides show 12.00, never 12.01 or 11.99.
Paying in bitcoin does not replace it. The payer's own display currency does
not replace it. A body that carries only `amountSats` is valid. It stores
`amountCurrency`, `amount`, `amountUsd`, `amountChf`, `amountEur`, and
`amountPhp` as null. It does not price those sats from a spot or a daily close.

**Response** `200`:

```json
{ "charge": null, "history": [] }
```

Every charge object carries `id`, `amountSats`, `status`, `createdAt`,
`expiresAt`, `paidAt`, and the six fiat fields `amountCurrency`, `amount`,
`amountUsd`, `amountChf`, `amountEur`, and `amountPhp`.

**Response** `200` (paid 10 s ago, sats-only):

```json
{
  "charge": {
    "id": "0b6f…",
    "amountSats": 21,
    "status": "paid",
    "createdAt": "2026-10-04T12:00:00.000Z",
    "expiresAt": "2026-10-04T12:05:00.000Z",
    "paidAt": "2026-10-04T12:01:00.000Z",
    "amountCurrency": null,
    "amount": null,
    "amountUsd": null,
    "amountChf": null,
    "amountEur": null,
    "amountPhp": null
  },
  "history": [
    {
      "id": "0b6f…",
      "amountSats": 21,
      "status": "paid",
      "createdAt": "2026-10-04T12:00:00.000Z",
      "expiresAt": "2026-10-04T12:05:00.000Z",
      "paidAt": "2026-10-04T12:01:00.000Z",
      "amountCurrency": null,
      "amount": null,
      "amountUsd": null,
      "amountChf": null,
      "amountEur": null,
      "amountPhp": null
    }
  ]
}
```

**Response** `401`: `{ "error": "Unauthorized" }`.

### `POST /pos`

Bearer session. `{ "amountSats" }` alone, an integer ≥ 1, is 201. `amountCurrency`,
`amount`, `amountUsd`, `amountChf`, `amountEur`, and `amountPhp` are null.
`amountCurrency` without `amount`, or `amount` without `amountCurrency`, is
400 `{ "error": "Expected amountCurrency and amount together" }`. A bad amount
or a bad currency is 400 `{ "error": "Expected a typed fiat amount" }`. A fiat
body is `{ "amountSats", "amountCurrency", "amount" }`. `amountSats` is the
integer the client sent. It is not recomputed from the string. `amount` is that
string after trim and one comma-to-dot, with the fraction kept (`"12.00"` stays
`"12.00"`). The typed currency's numeric column stays null. JSON `amount` and
the matching `amountXxx` are that string. The other three are the frozen
two-decimal strings, or null when that spot leg is missing or cannot be parsed.
The freeze is `other = typedAmount * (spot[other] / spot[typed])`, half-up to
cents, from the spot quote `GET /fx/spot` serves. It is never taken from
`amountSats` and never from a daily table. A throw while pricing one other
currency stays inside the freeze and leaves that currency null. A missing quote
or a spot read that throws does not fail the charge. The typed string is still
stored. Requires a username
and a receiving address (see [Receiving address](#receiving-address); the
error for none is `Set up your wallet first`). Resolves
that address and rejects
amounts whose millisats fall outside inclusive `minSendable`..`maxSendable`.
One unexpired pending charge at a time. The insert enforces that again
(`pos_charge_account_pending_idx`; the in-memory store rejects before
append), so a second request that already passed the earlier read is still 409. `201` `{ "charge" }` with `expiresAt` five minutes after `now`. While
pending, `GET /.well-known/lnurlp/:username` keeps the wallet pay request's
callback and metadata and sets both sendable bounds to that millisat amount.

When `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve, the charge is
inserted, and the account's `open` shop payment ended (`end_reason`
`superseded`, or `window` when its window already passed), in one
transaction that first locks the account row (`SELECT … FOR UPDATE`).
It does not wait for the in-process creation lock. After that transaction,
when stablecoin rows are on for the username, the creation procedure of
[Shop payment in USDT and USDC](#shop-payment-in-usdt-and-usdc) starts in
the background for the charge; its failure logs `shop.creation.failed` and
never changes the response. A shop payment never makes this route answer 409.

**Response** `400`: `{ "error": "Expected a JSON body with an integer \"amountSats\"" }`,
`{ "error": "Expected amountCurrency and amount together" }`,
`{ "error": "Expected a typed fiat amount" }`,
`{ "error": "Set a username first" }`,
`{ "error": "Set up your wallet first", "code": "wallet_required" }`, or
`{ "error": "Amount is outside the wallet range" }`.

**Response** `409`: `{ "error": "A payment is already open" }`.

**Response** `502`: `{ "error": "Lightning Address could not be resolved" }`.

### `DELETE /pos`

Bearer session. Cancels every unexpired pending charge for the account,
not only the newest. An already expired row is not cancelled. When
`LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve, the cancel and the end of
the charge's `open` shop payment (`end_reason` `cancelled`) run in one
transaction that first locks the account row. A shop payment never makes
this route answer 409.

**Response** `200`: `{ "charge": null }` when at least one row was cancelled.

**Response** `404`: `{ "error": "No open payment" }`.

### `GET /pay/:username`

Public pay-link card. No auth. Normalises `:username`, loads the account,
and returns the trimmed display name (or the normalised username when the
name is blank) plus `minSats`, `maxSats`, and `charge` from the member's
receiving address (see [Receiving address](#receiving-address)). No open charge → `charge` is `null` and the bounds stay
the wallet sat range. An unexpired pending point-of-sale charge → both
bounds equal that amount and `charge` carries `id`, `amountSats`, `expiresAt`
(ISO-8601), and the six fiat fields from
[docs/fiat-amounts.md](docs/fiat-amounts.md). The shop and the payer both show
that typed string. Typing 12.00 shows 12.00 on both sides, never 12.01 or 11.99.
A sats-only charge carries those six fields as null. A bad wallet window is
still 502 before any pin. `currentPending` throwing is the existing 502. Does
not return the callback, the address, or provider metadata.

**Response** `200` (no open charge):

```json
{ "name": "Ada", "username": "ada", "minSats": 1, "maxSats": 100000000, "charge": null }
```

**Response** `200` (unexpired pending charge):

```json
{
  "name": "Ada",
  "username": "ada",
  "minSats": 21,
  "maxSats": 21,
  "charge": {
    "id": "0b6f…",
    "amountSats": 21,
    "expiresAt": "2026-09-01T12:05:00.000Z",
    "amountCurrency": null,
    "amount": null,
    "amountUsd": null,
    "amountChf": null,
    "amountEur": null,
    "amountPhp": null
  }
}
```

Invalid username, unknown account, or no receiving address (no verified
wallet, or the LNURL server not configured) →
**Response** `404` `{ "error": "Not found" }`.

The LNURL server is unreachable, the store throws, `currentPending` throws, `minSendable` or `maxSendable`
is not a safe integer, or `maxSats < minSats` → **Response** `502`
`{ "error": "Lightning Address could not be resolved" }`.

### `GET /pay/charges/:id`

Public till receipt. No auth. Returns `serializePosCharge` and nothing secret:
`id`, `amountSats`, `status`, `createdAt`, `expiresAt`, `paidAt`, and the six
fiat fields. `accountId` and `sparkInvoice` are omitted. A paid charge is
returned. Missing → **Response** `404` `{ "error": "Not found" }`.

### `GET /pay/:username/charges/:id`

Same receipt when the charge belongs to the normalised username. Registered
before `/:username`. Unknown username, a missing charge, or a charge owned by
someone else → **Response** `404` `{ "error": "Not found" }`. A paid charge is
returned. The body is `serializePosCharge` and nothing secret.

### `POST /pay/:username/invoice`

One BOLT11 invoice for an exact satoshi amount. No auth. Same account
lookup as `GET /pay/:username` (including the till pin). Body
`{ "amountSats": <integer>, "comment"?: <string> }` (amount) must sit inside `[minSats, maxSats]` and the
millisatoshi value must sit inside the provider window. A different amount
while a charge is open is the existing 400 and does not call the invoice
callback. The charge amount must still sit in the provider millisatoshi
window or that same 400 is returned and the callback is not called.
Settlement calls the member's receiving address: their verified wallet
through the LNURL server (internally, never over the public URL). `comment`
is never sent to the invoice callback; it only becomes the memo of a Spark
invoice without a charge (below). No spend token.

**Response** `200`:

```json
{ "pr": "lnbc...", "amountSats": 21, "sparkInvoice": null }
```

The `pr` is returned only when it decodes to exactly `amountSats * 1000`
millisatoshis.

While a point-of-sale charge is pending, the payment hash of `pr` is
recorded against that charge, under the payment hash claim (see
Creation). When another charge's invoice row or another shop payment
already holds that hash (`recordInvoice` returns `other_payment`), the
BOLT11 is not handed out: the route logs `shop.alert.duplicate_invoice`
(`chargeId`, `holderChargeId`, and `paymentId` only when a shop payment
holds it) and answers **502**
`{ "error": "Lightning Address could not be resolved" }`. While that charge is pending,
`sparkInvoice` is non-null when `amountSats` equals its amount (the till
pin already enforces that) and free in-app payments are on (the same
condition that issues Spark invoices for gifts). It is then a `spark1…`
invoice for exactly `amountSats` to the shop's verified wallet key with
memo `pos:<chargeId>`; one per charge, so a repeat call returns the stored
string. A 21.gifts in-app wallet pays it without a fee. A store failure
while recording or issuing is logged (`pos.invoice.record_failed`,
`pos.spark_invoice.issue_failed`) and does not fail the response: the
invoice is still handed out. While
a charge is open, `comment` is ignored.

Without a pending charge, `sparkInvoice` is non-null when free in-app
payments are on: a `spark1…` invoice for exactly `amountSats` to the
member's verified wallet key, so a 21.gifts in-app wallet sending to a
member pays it without a fee. Its memo is the optional `comment`, trimmed,
cut to the member's `commentAllowed` characters (missing is 0) and then to
120 UTF-8 bytes without splitting a character; a blank, non-string, or
not-allowed comment leaves the memo out. It is minted after `pr`, is not
stored, and nothing watches it (no zap receipt, no gift record). Free
in-app payments off → `sparkInvoice` is `null`.

Invalid username, unknown account, or no receiving address (no verified
wallet with the LNURL server configured) → **Response** `404`
`{ "error": "Not found" }`. Missing or invalid JSON, a non-integer, or an
amount outside the window → **Response** `400`
`{ "error": "Enter a whole number of sats" }`. Resolve or store failure, an
empty or non-safe-integer window, a failed invoice fetch, or a BOLT11 that
is missing, not a safe integer amount, or not the requested amount →
**Response** `502` `{ "error": "Lightning Address could not be resolved" }`.

### `POST /pay/:username/payment`

Opens a shop payment for an amount the payer entered on the payment page
([Shop payment in USDT and USDC](#shop-payment-in-usdt-and-usdc)). No auth,
no spend token. CORS is the allow-list of the other `/pay` routes. The
route group is always mounted; it opens a payment only when
`LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve. Body
`{ "amountSats": <integer> }` (a `comment` key is accepted and ignored).
Same account lookup as `GET /pay/:username`. Checks run in this order:

| Order | Condition                                                                                                                                                                                                                            | Response                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 1     | Invalid username, unknown account, or no receiving address (no verified wallet, or the LNURL server not configured).                                                                                                                 | **404** `{ "error": "Not found" }`                                                           |
| 2     | The wallet's pay request cannot be resolved, the store throws, or its window is empty or not a safe integer.                                                                                                                         | **502** `{ "error": "Lightning Address could not be resolved" }`                             |
| 3     | Missing or invalid JSON, or `amountSats` is not an integer of at least 1.                                                                                                                                                            | **400** `{ "error": "Enter a whole number of sats" }`                                        |
| 4     | A till charge is pending.                                                                                                                                                                                                            | **409** `{ "error": "A payment is already open", "code": "payment_open" }`                   |
| 5     | The amount is outside the pay request's sat range or millisatoshi window.                                                                                                                                                            | **400** `{ "error": "Enter a whole number of sats" }`                                        |
| 6     | The username is `invoice`, `cb`, or ends in `.`, or `ORCHESTRA_BASE_URL`, `ORCHESTRA_API_KEY`, `SHOP_EVM_RPC`, or `SHOP_REFUND_ADDRESS` does not resolve.                                                                            | **503** `{ "error": "Stablecoin payment is unavailable", "code": "stablecoin_unavailable" }` |
| 7     | The account's 60 s no-pair wait is running, or the api started 60 creations in the last minute, or this account started 10 (per process).                                                                                            | **503** `stablecoin_unavailable` as in order 6                                               |
| 8     | The mint fails, the BOLT11 is for another amount, or its payment hash is already held by a shop payment or recorded against a charge (logs `pay.invoice_failed`).                                                                    | **502** `{ "error": "Lightning Address could not be resolved" }`                             |
| 9     | The route list cannot be read or names no candidate pair, no Orchestra quote passes the offer checks, `findChargeForPayment` fails with an error, or the insert step finds the request at least 16 s old or its client disconnected. | **503** `stablecoin_unavailable` as in order 6                                               |

Orders 4 and 6 run again under the account's creation lock (order 4 also
inside the insert transaction); order 7 runs only there, once per creation.
A store failure during the creation → **Response** `502` `{ "error":
"Lightning Address could not be resolved" }` (logs `pay.failed`), the
answer of order 2: the page cannot tell whether a payment opened, so it
repeats the request as after any other 5xx.
The route list is read before the mint, so an unreadable route list or one
without a candidate pair answers order 9 before order 8 can apply; "no
Orchestra quote passes the offer checks", a `findChargeForPayment` error,
the insert step at 16 s or later, and a disconnected client come after the
mint.
The api-wide counter is asked first and the account counter only when it
allows. Orders 7 and 9 do not depend on the client address.

An `open` payer-opened payment of the account is always replaced: it ends
with `end_reason` `replaced` and the new payment is created. Its window
ends five minutes after creation.

**Response** `200`:

```json
{ "payment": "<uuid>", "expiresAt": "2026-10-17T12:05:00.000Z" }
```

`expiresAt` is the payment's `window_ends_at`. The page then fetches the
pay link and checks that `quote.payment` is this id.

### `POST /lnurl/pay-request`

Bearer session. Fetches the LNURL pay request of a Lightning Address or a
bech32 LNURL on another host, so the app can pay addresses whose server sends
no CORS headers. Body `{ "target": "<user@domain>" | "<bech32 LNURL>" }`. An
optional `lightning:` prefix (any case) is dropped and the target is lowercased.
A bech32 LNURL written in mixed case is refused.

The pay-request URL (`https://<domain>/.well-known/lnurlp/<user>`, or the
decoded LNURL) must use `https`, have no port other than the default 443 and no user name or
password, and its host
must be a DNS name of at most 253 characters with at least two labels: no
address literal, no
`localhost`, no `.local`, `.internal`, or `.localhost` name, no trailing dot.
Every address the host resolves to must pass the public address check: no
loopback, private, shared, link-local, benchmark, documentation, 6to4 relay
(`192.88.99/24`), multicast, or reserved IPv4 (also when carried as IPv4-mapped, IPv4-compatible,
IPv4-translated, 6to4, or NAT64 IPv6). IPv6 unique-local, link-local, site-local, multicast,
documentation, Teredo, `2001:1::/32`, benchmarking, ORCHID, `5f00::/16`,
discard, and local NAT64 ranges
are refused, and any other IPv6 answer must lie in global unicast `2000::/3` or
the well-known NAT64 prefix `64:ff9b::/96` and not in the IETF special-purpose
block `2001::/23`. A Lightning Address whose name is only dots is refused. A
target on the host of `PUBLIC_BASE_URL` (compared without a trailing dot) is
refused (the app pays those itself). The fetch does not follow redirects and reads at most 64 KB. Each host lookup
and each fetch waits at most 5 seconds, and one relay call waits at most 8
seconds in total (below the server's 10-second idle timeout), so the client
always gets an answer.

The response must be a pay request: `tag` `payRequest`, an `https` `callback`
that passes the same host checks, a string `metadata`, safe-integer
`minSendable` of at least 1 and `maxSendable` not below it, and an optional
non-negative integer `commentAllowed` (missing or null means 0).

**Response** `200`:

```json
{
  "target": "bob@example.com",
  "minSendableMsat": 1000,
  "maxSendableMsat": 100000000,
  "commentAllowed": 255,
  "description": "Pay bob",
  "domain": "example.com"
}
```

`description` is the metadata's `text/plain` entry, or an empty string.

No session → **Response** `401` `{ "error": "Unauthorized" }`. More than 30
requests to `/lnurl/pay-request` and `/lnurl/invoice` together within one
minute for the same member → **Response** `429`
`{ "error": "Too many requests" }` with `Retry-After: 60`. Missing or malformed
target (including one over 2048 characters), a target that fails the URL or address checks, a target on this app's
host, or a response that is not a valid pay request (including a callback host
that resolves to a non-public address) → **Response** `400`
`{ "error": "Not a payable address" }`. HTTP 404 or 410, or an LNURL
`{ "status": "ERROR" }` body → **Response** `404`
`{ "error": "Address not found" }`. A host that does not resolve in time, network failure, timeout (per step or
for the whole call), redirect, any
other non-2xx status, a body over 64 KB, or a body that is not a JSON object →
**Response** `502` `{ "error": "Address could not be reached" }`.

Logs carry a short reason and the status on failure, the domain on a
pay-request success, and `amountMsat` on an invoice success. The target, its
query string, the comment, and the invoice are never logged.

### `POST /lnurl/invoice`

Bearer session. Body
`{ "target": "...", "amountMsat": <integer>, "comment"?: "<string>" }`.
Resolves `target` again with the same checks as `POST /lnurl/pay-request`
(the client never sends a callback URL). `amountMsat` must be a whole number
of millisatoshis within `[minSendable, maxSendable]`. `comment` may be absent,
null, or a string of at most `commentAllowed` characters. The callback is
called with `amount` and, when the comment is not empty, `comment`, under the
same fetch limits. The returned BOLT11 must decode to exactly `amountMsat`
and carry a description hash equal to SHA-256 of the pay request's
`metadata`.

**Response** `200`:

```json
{ "pr": "lnbc..." }
```

Errors as for `POST /lnurl/pay-request`, plus: `amountMsat` not a number, not
a whole number, or outside the bounds → **Response** `400`
`{ "error": "Amount out of range" }`; `comment` neither absent, null, nor a
string, not well-formed Unicode, longer than 2000 UTF-16 code units, or longer than `commentAllowed` → **Response** `400` `{ "error": "Comment too long" }`; the
invoice fetch fails, or the invoice is missing, undecodable, for another
amount, or for another description hash → **Response** `502`
`{ "error": "Address could not be reached" }`.

### `GET /favicon.ico`

Brand mark for browsers that request `/favicon.ico` without HTML. No auth.
No JSON. No env vars. No Open Graph tags.

**Response** `200`: binary body, `Content-Type: image/x-icon`,
`Cache-Control: public, max-age=86400`.

**Response** `404`: empty body when the file is missing.

### `GET /favicon.svg`

SVG brand mark at the origin root. No auth. No JSON. No env vars. No Open
Graph tags.

**Response** `200`: binary body, `Content-Type: image/svg+xml`,
`Cache-Control: public, max-age=86400`.

**Response** `404`: empty body when the file is missing.

### `GET /apple-touch-icon.png`

Apple touch icon at the origin root. No auth. No JSON. No env vars. No Open
Graph tags.

**Response** `200`: binary body, `Content-Type: image/png`,
`Cache-Control: public, max-age=86400`.

**Response** `404`: empty body when the file is missing.

### `POST /auth/passkey/register/begin`

Starts a discoverable-credential registration. Empty body, `{}`, or a body
containing neither `name` nor `viewKey` mints a new account id (no row until
finish). `user.name` is that UUID and `user.displayName` is `21.gifts`.
Non-empty invalid JSON is `400` `{ "error": "Begin body is not valid JSON" }`
and does not open a challenge. Empty or whitespace-only body still starts a
new registration. Optional JSON `{ "viewKey": "<64 lowercase hex>" }` claims
an existing provisioned account: `404` when the profile is missing, `409`
when it already has a passkey, `400` when `viewKey` is present but not a
string. A string `viewKey` ignores `name` and does not overwrite the
provisioned account's name or username, and it does not mint an id.

Optional `{ "name": "<handle>" }` (not combined with a claim) validates the
handle with `normalizeUsername` (1–32 characters of a-z, 0-9, hyphen,
underscore, or dot). Non-string `name` (including `null`) is `400`
`{ "error": "Expected a JSON body with an optional \"name\" string" }`. An
invalid handle is `400` with that username charset error. A taken handle is
`409` `{ "error": "Username is already in use" }`. Failed begin writes no
challenge row. On success the challenge stores `requestedName` as the
normalised handle; `user.name` and `user.displayName` are that handle.
`user.id` remains the pending account UUID encoded as UTF-8.

When `APP_BUILD_REQUIRED` is set and `X-App-Build` differs, **Response**
`403` `{ "error": "A new app version is ready. Reload the page.", "code": "app_outdated" }` before every other check (see Login controls). While the login
switch is closed, **Response** `503` `{ "error": "Logins are paused for an update. Try again later.", "code": "logins_closed" }`:
for a new account right after the JSON check, and for a claim after the
`404` / `409` checks unless the provisioned account is the platform account
or on the allowlist. A refused begin writes no challenge row.

When `WEBAUTHN_RP_ID` is unset, blank, not on the allowlist (`21.gifts` /
`dev.21.gifts` / `staging.21.gifts` / `localhost`), or no CORS origin matches that RP ID:

**Response** `500`:

```json
{ "error": "Server auth is not configured" }
```

Otherwise **Response** `200`:

```json
{
  "challengeId": "<64 hex chars>",
  "options": { "challenge": "<base64url>", "rp": { "id": "21.gifts", "name": "21.gifts" } }
}
```

`options` is `PublicKeyCredentialCreationOptionsJSON` (`residentKey` and
`userVerification` required, attestation `none`). `options.extensions.prf`
is `{}` so a capable authenticator enables hmac-secret. The api never sees
PRF output or a mnemonic. `user.id` is the pending account UUID encoded as
UTF-8 (the provisioned account when claiming by `viewKey`). The process
still boots without `WEBAUTHN_RP_ID` — only these routes fail closed.

### `POST /auth/passkey/register/finish`

Verifies the attestation and issues a session immediately (no poll).

Body:

```json
{ "challengeId": "<hex>", "credential": {} }
```

`credential` is the browser `RegistrationResponseJSON`. The request `Origin`
must be in the RP ID's expected origins (CORS allowlist filtered to that RP
ID).

| Status | Body                                                                                              | When                                                                                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 403    | `{ "error": "A new app version is ready. Reload the page.", "code": "app_outdated" }`             | `APP_BUILD_REQUIRED` set and `X-App-Build` differs; checked first                                                                                                                                  |
| 500    | `{ "error": "Server auth is not configured" }`                                                    | RP ID missing, not on the allowlist, or no matching origin                                                                                                                                         |
| 503    | `{ "error": "Logins are paused for an update. Try again later.", "code": "logins_closed" }`       | Login switch closed after the passkey verified: always for a new account, and for a claim unless the account is the platform account or allowlisted; no account, credential, or session is written |
| 400    | `{ "error": "Finish body is not valid JSON" }`                                                    | Body is not JSON                                                                                                                                                                                   |
| 400    | `{ "error": "Expected a JSON body with challengeId and credential" }`                             | Missing body, or JSON that is not `{ challengeId, credential }`                                                                                                                                    |
| 400    | `{ "error": "Unknown or expired challenge" }`                                                     | Unknown `challengeId`                                                                                                                                                                              |
| 400    | `{ "error": "Challenge expired" }`                                                                | Past challenge TTL                                                                                                                                                                                 |
| 400    | `{ "error": "Challenge already used" }`                                                           | Finish already attempted; challenge is consumed before verification                                                                                                                                |
| 400    | `{ "error": "Wrong challenge type" }`                                                             | Challenge is not `register`                                                                                                                                                                        |
| 400    | `{ "error": "Invalid origin" }`                                                                   | Missing or disallowed `Origin`                                                                                                                                                                     |
| 400    | `{ "error": "Invalid passkey" }`                                                                  | Attestation verify failed or duplicate credential                                                                                                                                                  |
| 400    | `{ "error": "Username must be 1–32 characters of a-z, 0-9, hyphen, underscore, or dot" }`         | Stored register name no longer normalizes; no credential and no session                                                                                                                            |
| 403    | `{ "error": "You signed in with the wrong account. Please try again with the correct account." }` | Account with `sessionRefused`; no bearer is persisted                                                                                                                                              |
| 409    | `{ "error": "Username is already in use" }`                                                       | Register-challenge name taken at finish, or the account row was not inserted; no credential, no session                                                                                            |

**Response** `200`:

```json
{
  "token": "<hex>",
  "account": {
    "id": "<uuid>",
    "linkingKey": null,
    "role": "basis",
    "name": null,
    "username": null,
    "location": null,
    "lightningAddress": null,
    "lightningAddressVerified": false,
    "forumLawsDismissed": false,
    "viewKey": "<64-hex>",
    "createdAt": 0,
    "rulesAgreedAt": null,
    "setup": "name",
    "missing": ["name", "username", "lightning-address", "rules"],
    "hasPosted": false,
    "aboutMe": null,
    "aboutMeHasPhoto": false,
    "aboutMessageId": null,
    "notificationLevel": "all",
    "amountUnit": "btc",
    "locale": null,
    "fiat": null,
    "funding": null,
    "walletRequired": true,
    "walletBackupSeenAt": null,
    "walletIntroSeen": false,
    "hadExternalWallet": false,
    "sparkPubkey": null,
    "sparkWalletVerified": false,
    "passkeyCredentialId": "<base64url>",
    "passkeyRenewFailed": false,
    "passkeyRenewClosed": false,
    "passkeyRenewPrfUnsupported": false,
    "socialRecoverySetUp": false
  }
}
```

The `account` object is the same owner JSON as `GET /me` (includes `viewKey`, `setup`, `missing`, `hasPosted`, `aboutMe`, `aboutMeHasPhoto`, `aboutMessageId`, `notificationLevel`, `amountUnit`, `locale`, `fiat`, `walletRequired`, `walletBackupSeenAt`, `walletIntroSeen`, `hadExternalWallet`, `sparkPubkey`, `sparkWalletVerified`, `passkeyCredentialId`, `passkeyRenewFailed`, `passkeyRenewClosed`, `passkeyRenewPrfUnsupported`, and `socialRecoverySetUp`). `passkeyRenewPrfUnsupported` is true only when the newest unacknowledged failed row has error name `prfUnsupported`. `locale` and `fiat` are null until the member's app stores them. The example above is a nameless new register (`name: null`, `username: null`, `setup: "name"`). When begin stored a name, `name` and `username` are that normalised handle (example `ada`), `nameSkippedAt` stays null, there is no profile note, and `setup` is `lightning-address`. Finish does not take `name` from the body. The recovery phrase is not a setup step and does not change `setup` or `missing`. Existing members start with `walletRequired: false`. Seed finish sets `walletRequired: true` and does not change `walletBackupSeenAt`. Replace refuses and changes nothing. `walletBackupSeenAt` does not decide whether a seed exists. The nameless example remains `walletRequired: true` with `setup: "name"` when the name is unset.

A new register row is stored with `walletRequired: true` and `walletBackupSeenAt: null`. First-passkey claim of a provisioned row sets `walletRequired: true` in the same write as the credential (`createFirstPasskeyCredential`: Postgres CTE locks the account row with `FOR UPDATE`, then inserts and sets `wallet_required`; memory store writes both in one method) and does not clear a seen timestamp. Passkey replace refuses and does not change these columns. Seed finish sets `walletRequired: true` without changing `walletBackupSeenAt`. A social recovery commit (`POST /lnurlpay/:pubkey/transfer` or a settling lookup) sets `walletRequired: true` without changing `walletBackupSeenAt`. Operator `POST /debug/accounts` provision leaves `walletRequired` false. The api never stores a mnemonic or PRF output.

### `POST /auth/passkey/authenticate/begin`

Starts a discoverable-credential assertion. `allowCredentials` is empty.
Same 403 `app_outdated` and 500 as register begin. The login switch does not
apply here, because the account is unknown until finish.

**Response** `200`: `{ "challengeId", "options" }` where `options` is
`PublicKeyCredentialRequestOptionsJSON`. `options.extensions.prf.eval.first`
is the base64url SHA-256 of `21gifts-nostr-v1`. The api never sees PRF
output or a mnemonic.

### `POST /auth/passkey/authenticate/finish`

Verifies the assertion against a stored credential, updates `signCount`,
issues a session. A non-increasing `signCount` is refused as
`{ "error": "Invalid passkey" }` except the authenticator `0/0` case.
Body shape matches register finish. Extra 400:
`{ "error": "Unknown credential" }` when the assertion `id` is missing or
not stored. A credential that is not stored but is the new passkey of a
pending social recovery (forwarded, or not older than `CHALLENGE_TTL_MS`) is
**409** `{ "error": "Recovery is not finished", "code": "recovery_pending" }`
instead, so the app keeps that passkey: the recovery may still commit with it
(through `POST /lnurlpay/:pubkey/transfer` or a settling lookup). Without a
pending recovery the credential is read once more: the commit stores the
credential and deletes the pending recovery in one transaction, so a commit
that lands between the two reads signs in instead of answering
`Unknown credential`. An account with `sessionRefused` is **403**
`{ "error": "You signed in with the wrong account. Please try again with the correct account." }`
and does not persist a bearer. Same 403 `app_outdated` as register finish,
checked first. While the login switch is closed, an account that is neither
the platform account nor allowlisted gets **503** `{ "error": "Logins are paused for an update. Try again later.", "code": "logins_closed" }`
after the passkey verified, with no sign-count or session write. Success
body matches register finish (`linkingKey` is whatever the account currently
has).

### `POST /auth/passkey/replace/begin`

After a valid Bearer this returns **409**
`{ "error": "A recovery phrase cannot be replaced" }`.
It does not create a challenge, does not delete or insert a passkey, and
does not mint a session. Social recovery is the only path that gives an
account a different recovery phrase (`POST /auth/passkey/recovery/begin`,
`POST /auth/passkey/recovery/finish`, and the commit through
`POST /lnurlpay/:pubkey/transfer` or a settling lookup).

Missing or invalid Bearer stays **401** `{ "error": "Unauthorized" }`.
Unconfigured WebAuthn stays **500** `{ "error": "Server auth is not configured" }`,
checked before the bearer.

### `POST /auth/passkey/replace/finish`

After a valid Bearer this returns **409**
`{ "error": "A recovery phrase cannot be replaced" }`.
It does not parse a ceremony once the session is valid. It does not create
a challenge, does not delete or insert a passkey, and does not mint a session.

Missing or invalid Bearer stays **401** `{ "error": "Unauthorized" }`.
Unconfigured WebAuthn stays **500** `{ "error": "Server auth is not configured" }`,
checked before the bearer.

### `POST /auth/passkey/seed/begin`

Requires `Authorization: Bearer`. Issues WebAuthn creation options for one
extra seed passkey. No `excludeCredentials`. WebAuthn user id and user name
are the account id.

When `walletRequired` is true → **Response** `409`:
`{ "error": "This account already has a recovery phrase" }` (no challenge).
That 409 stores a failed renew row and does not change the account.
A 200 stores no renew row. 401 and 500 store no row.

Missing or invalid Bearer stays **401** `{ "error": "Unauthorized" }`.
Unconfigured WebAuthn stays **500** `{ "error": "Server auth is not configured" }`,
checked before the bearer.

**Response** `200`: `{ "challengeId", "options" }` like register begin, with
no `excludeCredentials`.

### `POST /auth/passkey/seed/finish`

Body is `challengeId` plus `credential`. Requires `Origin`. Does not mint a
session; the existing Bearer stays valid.

When `walletRequired` is already true (body not parsed), or when the
credential id is taken, the account is missing, or the insert does not
land → **Response** `409`:
`{ "error": "This account already has a recovery phrase" }`.
A `sessionRefused` bearer is **401** `{ "error": "Unauthorized" }` from
session resolution, before finish runs.

Other ceremony failures stay **400** with the same strings as the old
replace finish: Invalid origin, Unknown or expired challenge, Challenge
expired, Challenge already used, Wrong challenge type, Invalid passkey,
`{ "error": "Finish body is not valid JSON" }`, and
`{ "error": "Expected a JSON body with challengeId and credential" }`.

A 400 or 409 after the session is known stores a failed renew row and does
not change the account. Success stores `outcome: "succeeded"` with null
error fields, then acknowledges open failed rows. 401 and 500 store no row.

**Response** `200`: the owner account itself, via
`serializeOwnerAccountWithPosts`, same shape as `GET /me`. No `token` and
no `account` wrapper. `passkeyCredentialId` is the new credential id,
`walletRequired` is true, `passkeyRenewClosed` is false,
`walletBackupSeenAt` is unchanged. Logs `auth.passkey.seed.ok` only on success.

Missing or invalid Bearer stays **401** `{ "error": "Unauthorized" }`.
Unconfigured WebAuthn stays **500** `{ "error": "Server auth is not configured" }`,
checked before the bearer.

### `POST /auth/passkey/recovery/begin`

Starts a social recovery ([docs/social-recovery.md](docs/social-recovery.md)).
No session. The 403 `app_outdated` check of register begin runs first (see
Login controls). Rate limit 30/min/client, a window of its own. Body
(strict):

```json
{
  "sparkPubkey": "0281363910b0dc0015a4a25e758da30f0e28388ea5252c0e3713936f2d4ef7d3d5",
  "lookup": { "signature": "<lowercase hex DER>", "timestamp": 1761700000 }
}
```

`sparkPubkey` is the old wallet's identity key. `lookup` is that wallet's
signed address lookup: `signature` (16 to 144 lowercase hex characters) is the
DER signature by that key over
`breez-lnurl:v2\nrecover\n<app host>\n<sparkPubkey>\n<timestamp>`, and
`timestamp` is Unix seconds. The api forwards it to the LNURL server as
`POST /lnurlpay/<sparkPubkey>/recover` with the body
`{ "signature", "timestamp" }` (15 s) and reads the answer as the recover
route does: the key holds a username, the server verified the signature and
the key holds no name (`"user not found"`), or nothing is proven.

In this order:

1. WebAuthn not configured → **Response** `500`
   `{ "error": "Server auth is not configured" }`.
2. LNURL server off → **Response** `503`
   `{ "error": "Lightning address service is unavailable" }`.
3. Over limit → **Response** `429` `{ "error": "Too many requests" }`.
4. Invalid JSON → **Response** `400`
   `{ "error": "Begin body is not valid JSON" }`. An absent body, another
   shape, or a key that does not normalise → **Response** `400`
   `{ "error": "Expected a JSON body with sparkPubkey and lookup" }`.
5. No account is verified on the key: when no previous wallet has it either →
   **Response** `404` `{ "error": "Not found" }`, without contacting the LNURL
   server. For a previous wallet's key the lookup is forwarded: a verified
   answer → **Response** `409`
   `{ "error": "This account was already recovered. Sign in with the new passkey.", "code": "recovery_done" }`,
   otherwise **Response** `503`
   `{ "error": "Lightning address service is unavailable" }`.
6. Session-refused account → **Response** `403`
   `{ "error": "You signed in with the wrong account. Please try again with the correct account." }`.
   Login switch closed for the account → **Response** `503`
   `{ "error": "Logins are paused for an update. Try again later.", "code": "logins_closed" }`.
   Both answer before the LNURL server is contacted.
7. The lookup is forwarded. A forwarded pending recovery of the account is
   settled with it first, as the lookup of its old key (see
   `POST /lnurlpay/:pubkey/recover`): a commit → `409` `recovery_done` and
   `account.recovery.committed` `{ accountId, via: "begin" }`; a drop goes on
   with `account.recovery.dropped` `{ accountId, via: "begin" }`; a keep (the
   lookup was sent within 30 s of the forward, or its answer neither commits
   nor drops) → `503` `Lightning address service is unavailable`; a commit
   that does not land (the forwarded recovery is already gone, or the account
   no longer holds the old key verified) → `503`
   `Lightning address service is unavailable`.
8. Lookup not verified → `503` `Lightning address service is unavailable`.
   The key no longer holds the account's username (`"user not found"`, or
   another name) → **Response** `409`
   `{ "error": "This account needs an operator to recover it", "code": "recovery_operator" }`,
   unless a commit (the transfer's claim or a settling lookup) landed while
   the lookup ran: when no account holds the key verified any more and a
   previous wallet has it → `409` `recovery_done`.
9. One locked step under the account row consumes the account's open
   `recovery` challenges, drops a pending recovery that was not forwarded, and
   stores the new `recovery` challenge. When the account no longer holds the
   key verified, became session-refused, or has a forwarded pending recovery
   by then → `503` `Lightning address service is unavailable`.

An unreachable LNURL server on the forward of step 5 or 7 (including the 15 s
abort) logs `lnurl_server.unreachable` `{ route: "recovery" }` and answers
`503` `{ "error": "Lightning address service is unavailable" }`. A store
throw at any step → `503`
`{ "error": "Lightning address service is unavailable" }`.

**Response** `200`:

```json
{
  "challengeId": "<64 hex>",
  "options": { "challenge": "<base64url>", "extensions": { "prf": {} } },
  "accountId": "<uuid>",
  "username": "alice"
}
```

`options` is `PublicKeyCredentialCreationOptionsJSON` as for a seed passkey
(`POST /auth/passkey/seed/begin`): user id and user name are the account id,
the display name is the account name or `21.gifts`, and there is no
`excludeCredentials`, so the new passkey replaces an earlier passkey of this
account in the same authenticator. Logs `auth.passkey.recovery.begin`
`{ accountId, challengeId }`. Every refusal except 429 and the build-check
403 (`auth.app.outdated`) logs `auth.passkey.recovery.fail` with
`stage: "begin"`; never the key, the signature, or the timestamp.

**Storage.** The challenge is a `passkey_challenge` row of type `recovery`
with the account id; the partial index
`passkey_challenge_open_account_type_idx` serves the consume of the open
ones.

### `POST /auth/passkey/recovery/finish`

Stores a pending social recovery
([docs/social-recovery.md](docs/social-recovery.md), The recovery message).
No session; requires `Origin`. The 403 `app_outdated` check of register
finish runs first. Rate limit 30/min/client, a window of its own. Body
(strict):

```json
{
  "challengeId": "<64 hex>",
  "credential": {
    "id": "<base64url>",
    "rawId": "<base64url>",
    "type": "public-key",
    "response": { "clientDataJSON": "…", "attestationObject": "…", "transports": [] },
    "clientExtensionResults": {}
  },
  "newSparkPubkey": "0319d6c5d64753556063000ab42725bfe774fe722f00fbc692142eade1fd1ea52f",
  "signature": {
    "pubkey": "0281363910b0dc0015a4a25e758da30f0e28388ea5252c0e3713936f2d4ef7d3d5",
    "signature": "<128 lowercase hex, r then s>"
  }
}
```

`credential` is the new passkey's attestation, without PRF results.
`signature.signature` is the old wallet's compact ECDSA signature (low S,
over one SHA-256 of the UTF-8 message; Breez SDK `signMessage` with
`compact: true`) over five lines joined by LF with no trailing LF:
`21gifts-account-recovery-v1`, the account id, the ceremony's challenge as
issued, the new passkey's credential id, and `newSparkPubkey`. The
credential id is the one the verified attestation carries, never the
browser's `credential.id`. A signature with a high S is refused.

In this order:

1. WebAuthn not configured → **Response** `500`
   `{ "error": "Server auth is not configured" }`.
2. Over limit → **Response** `429` `{ "error": "Too many requests" }`.
3. Absent body, another shape, a missing `credential`, or a key that does
   not normalise → **Response** `400`
   `{ "error": "Expected a JSON body with challengeId, credential, newSparkPubkey and signature" }`.
   Invalid JSON → **Response** `400`
   `{ "error": "Finish body is not valid JSON" }`.
4. `Origin` missing or not allowed → `400` `{ "error": "Invalid origin" }`.
5. The challenge: unknown, or its account is gone → `400`
   `Unknown or expired challenge`; older than `CHALLENGE_TTL_MS` → `400`
   `Challenge expired`; not of type `recovery` → `400` `Wrong challenge type`.
   A consumed challenge passes here, so the locked step can recognise a
   repeat.
6. Session-refused account → `403` wrong account; login switch closed for
   the account → `503` `logins_closed` (see Login controls).
7. `signature.pubkey` is not the account's verified wallet key → `400`
   `{ "error": "Invalid recovery signature" }`. `newSparkPubkey` is that key
   → **Response** `409` `{ "error": "Wallet key is already in use" }`.
8. The attestation does not verify for the challenge → `400`
   `{ "error": "Invalid passkey" }`. The signature does not verify → `400`
   `Invalid recovery signature`.
9. One locked step under the account row: the account must still hold that
   key verified and not be session-refused, else `400`
   `Invalid recovery signature`; the challenge must be the account's and
   inside `CHALLENGE_TTL_MS`, else `400` `Challenge already used`; a consumed
   challenge is a repeat only when the account's pending recovery has the
   same credential id and new key, else `400` `Challenge already used`; any
   other pending recovery of the account → **Response** `409`
   `{ "error": "A recovery is already pending" }` (a forwarded one is never
   replaced); a new key that is any account's wallet key, a previous wallet's
   key, or another pending recovery's new key → `409`
   `Wallet key is already in use`; a credential id that is a stored passkey
   or another pending recovery's → `400` `Invalid passkey`. Then it consumes
   the challenge and stores the pending recovery.

A store throw, including the unique violation of a parallel finish of
another account → **Response** `503`
`{ "error": "Lightning address service is unavailable" }`.

**Response** `200` `{ "status": "pending" }`. It mints no session, and the
account does not change until the address transfer commits
(`POST /lnurlpay/:pubkey/transfer`). A repeat of the finish that stored the
pending recovery, with the same challenge, credential id and new wallet key,
answers 200 again and changes nothing; any other use of a consumed challenge
is refused (`Challenge already used`). Logs `auth.passkey.recovery.finish`
`{ accountId }` when it stores. Every refusal except 429 and the build-check
403 logs `auth.passkey.recovery.fail` with `stage: "finish"`, the account id
once known, and the challenge id only when it is 64 lowercase hex; never the
keys, the signature, the credential, or the body.

**Storage.** `pending_recovery` (`docs/schema/pending_recovery.sql`, see
`POST /lnurlpay/:pubkey/transfer`). A pending recovery that was not
forwarded counts as absent once it is older than `CHALLENGE_TTL_MS`; a
forwarded one never expires.

### `GET /me`

Returns the account bound to the bearer session.

Missing or invalid bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

An account with `sessionRefused` and a still-valid minted token → **Response** `403`:

```json
{ "error": "You signed in with the wrong account. Please try again with the correct account." }
```

**Response** `200`:

```json
{
  "id": "<uuid>",
  "linkingKey": "<hex>",
  "role": "basis",
  "name": null,
  "username": null,
  "location": null,
  "lightningAddress": null,
  "lightningAddressVerified": false,
  "forumLawsDismissed": false,
  "viewKey": "<64-hex>",
  "createdAt": 0,
  "rulesAgreedAt": null,
  "setup": "name",
  "missing": ["name", "username", "lightning-address", "rules"],
  "hasPosted": false,
  "aboutMe": null,
  "aboutMeHasPhoto": false,
  "aboutMessageId": null,
  "notificationLevel": "all",
  "amountUnit": "btc",
  "locale": null,
  "fiat": null,
  "funding": null,
  "walletRequired": false,
  "walletBackupSeenAt": null,
  "walletIntroSeen": false,
  "hadExternalWallet": false,
  "sparkPubkey": null,
  "sparkWalletVerified": false,
  "passkeyCredentialId": null,
  "passkeyRenewFailed": false,
  "passkeyRenewClosed": false,
  "passkeyRenewPrfUnsupported": false,
  "socialRecoverySetUp": false
}
```

The example above is an existing member (`walletRequired: false`,
`walletBackupSeenAt: null`, `walletIntroSeen: false`, `hadExternalWallet: false`,
`sparkPubkey: null`, `sparkWalletVerified: false`).
New register/claim owner JSON has `walletRequired: true` and `setup: "name"`
when the name is unset. The recovery phrase is not a setup step and does not
change `setup` or `missing`. `sparkPubkey` / `sparkWalletVerified` are set
when the member binds a wallet (`PUT /me/wallet`) and when registration is
accepted, and `sparkPubkey` becomes the new verified key on a social recovery
commit; they are owner-only.
`staffTag` is present only as `"software_developer"` when set and is omitted
otherwise (never JSON `null`). It is not a permission and does not change
`role`.

About me is the profile-note text when it is a real bio, else null (auto
name-copy is not a bio, including after a display-name rename when the note
text still equals the stored profile-note `name` (Ada→Grace with text `Ada`
stays `null`)).

| Field                        | Type           | Meaning                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                         | string         | Opaque account id                                                                                                                                                                                                                                                                                                                                                                                 |
| `linkingKey`                 | string \| null | Historical LNURL-auth linking key (hex), or `null` for passkey accounts                                                                                                                                                                                                                                                                                                                           |
| `role`                       | string         | `basis`, `verified`, `moderator`, `initiator`, or `founder`                                                                                                                                                                                                                                                                                                                                       |
| `staffTag`                   | string         | Present only as `"software_developer"` when set; omitted otherwise. Never JSON `null`. Not a permission and does not change `role`.                                                                                                                                                                                                                                                               |
| `name`                       | string \| null | Display name, or `null` until set                                                                                                                                                                                                                                                                                                                                                                 |
| `username`                   | string \| null | Unique LUD-16 / NIP-05 local-part (`a-z0-9-_.`, no trailing `.`, no `..`), or `null` until set. Cannot skip. Fixed once the wallet is verified.                                                                                                                                                                                                                                                   |
| `location`                   | string \| null | Free-text location set by the owner, or `null` when unset. Not unique. Not a setup step.                                                                                                                                                                                                                                                                                                          |
| `lightningAddress`           | string \| null | Receiving address: the verified in-app wallet `<username>@<host of PUBLIC_BASE_URL>`, or `null` without one (or with the LNURL server off). Name kept for app compatibility; the stored external address is never returned.                                                                                                                                                                       |
| `lightningAddressVerified`   | boolean        | `true` exactly when `lightningAddress` is set (verified wallet). Name kept for app compatibility.                                                                                                                                                                                                                                                                                                 |
| `forumLawsDismissed`         | boolean        | `true` after the welcome-forum living-room laws hint was dismissed                                                                                                                                                                                                                                                                                                                                |
| `viewKey`                    | string         | Durable 64 lowercase hex capability secret for GET /view/:viewKey. Owner-only. Not a session.                                                                                                                                                                                                                                                                                                     |
| `createdAt`                  | number         | Creation time (epoch ms)                                                                                                                                                                                                                                                                                                                                                                          |
| `rulesAgreedAt`              | number \| null | Epoch ms of first living-room rules agreement, or `null`                                                                                                                                                                                                                                                                                                                                          |
| `setup`                      | string \| null | Next wizard step: `name`, `username`, `lightning-address` (the receiving-wallet step, done once the wallet is verified), `rules`, or `null` when complete. The union still includes `wallet` for older clients; the api never returns it. Skip timestamps count as done except username, which cannot be skipped. Wallet backup is not a setup step. Clients must not invent a parallel sequence. |
| `missing`                    | string[]       | Factually unset fields (`name`, `username`, `lightning-address`, `rules`) even when skipped. Only a verified wallet clears `lightning-address`. Never includes `wallet`. Does not include `profileMessageId`.                                                                                                                                                                                     |
| hasPosted                    | boolean        | True when there is a live forum row that is not the profile note (replies still count) OR when `aboutMe` is non-null. A profile note that is only the display-name copy, a photo without bio text, a missing note, and a soft-hidden note do not count. Not the same predicate as GET /invoices/posted (that stays top-level non-profile only).                                                   |
| `aboutMe`                    | string \| null | Profile-note text when it is a real bio, else `null` (missing or soft-hidden (`deletedAt` set); auto name-copy is not a bio, including after a display-name rename when the note text still equals the stored profile-note `name` (Ada→Grace with text `Ada` stays `null`))                                                                                                                       |
| `aboutMeHasPhoto`            | boolean        | True when the live profile note has a stored JPEG/PNG/WebP. Independent of `aboutMe` (photo-only and name-copy notes can still have a photo). Bytes are `GET /me/about/photo`. Does not expose `profileMessageId`.                                                                                                                                                                                |
| `aboutMessageId`             | string \| null | Id of the stored About me note when `aboutMe` is non-null. `null` when `aboutMe` is `null` (including a name-copy note). Not a display name.                                                                                                                                                                                                                                                      |
| `notificationLevel`          | string         | Owner fan-out filter: `all`, `active`, `mentions`, or `none`. `none` is none of the living-room stream, including the dedicated `@username` channel. Default `all`. Owner-only; omitted from public `GET /view/:viewKey` and member cards.                                                                                                                                                        |
| `amountUnit`                 | string         | Owner amount-entry unit: `btc` or `fiat`. Default `btc`. Owner-only; omitted from public `GET /view/:viewKey` and member cards. The last unit the member chose on any amount field.                                                                                                                                                                                                               |
| `locale`                     | string \| null | Owner UI language: `en`, `de`, `es`, or `fil`, or `null` when not stored yet. Owner-only; omitted from public `GET /view/:viewKey` and member cards. A stored value wins over the browser.                                                                                                                                                                                                        |
| `fiat`                       | string \| null | Owner fiat: `CHF`, `EUR`, `USD`, or `PHP`, or `null` when not stored yet. Owner-only; omitted from public `GET /view/:viewKey` and member cards. A stored value wins over the language default.                                                                                                                                                                                                   |
| `funding`                    | object \| null | Funding-program grant. `null` for `basis`. Otherwise always an object; no row is `{ status: "none", trialUtcDate: null, admittedAt: null, reviewedByName: null, dailyPayoutStoppedNotice: false }`. `dailyPayoutStoppedNotice` is true only for the six legacy daily accounts while effective status is `none`. Admitted includes live `reviewedByName`.                                          |
| `walletRequired`             | boolean        | True when a seed-bearing passkey exists (new register/claim, seed finish, or a social recovery commit through `POST /lnurlpay/:pubkey/transfer` or a settling lookup). Default false does not mean a seed is present. It does not make `setup` `'wallet'`.                                                                                                                                        |
| `walletBackupSeenAt`         | number \| null | Epoch ms recorded after an existing member activates a passkey that can show a recovery phrase, so the app can offer Show recovery phrase next time instead of Activate. Not a confirmation. Not a seed check; it does not decide whether a seed exists. Null when that has not been recorded.                                                                                                    |
| `walletIntroSeen`            | boolean        | `false` for every account until `POST /me/wallet-intro-seen`, then `true` for good (no reset; a later account write does not clear it). Owner-only; omitted from public member cards and view profiles.                                                                                                                                                                                           |
| `hadExternalWallet`          | boolean        | `true` when the account has a stored legacy external payout address (`account.lightning_address`, kept as data). Read-only; no route sets it. Owner-only; omitted from public member cards and view profiles.                                                                                                                                                                                     |
| `sparkPubkey`                | string \| null | Identity public key of the member's wallet (66 lower-case hex), or `null` until claimed. Owner-only; omitted from public member cards and view profiles.                                                                                                                                                                                                                                          |
| `sparkWalletVerified`        | boolean        | True when `sparkPubkeyVerifiedAt` is a number (LNURL server accepted a registration signed by that key). After a social recovery commit, the new key is verified by the accepted address transfer and `sparkPubkeyVerifiedAt` keeps the first verification time. Owner-only.                                                                                                                      |
| `passkeyCredentialId`        | string \| null | Null when `walletRequired` is not true, even if a login passkey exists. When `walletRequired` is true it is the newest credential id (`created_at` desc, `credential_id` desc with `COLLATE "C"`). Owner-only.                                                                                                                                                                                    |
| `passkeyRenewFailed`         | boolean        | True only when that account has a failed renew row whose `acknowledged_at` is null. Owner-only.                                                                                                                                                                                                                                                                                                   |
| `passkeyRenewClosed`         | boolean        | True only when `walletRequired` is not true and a failed renew row has non-null `acknowledged_at`. A later seed (`walletRequired` true) is not closed. While this is true the account still has no seed. Owner-only.                                                                                                                                                                              |
| `passkeyRenewPrfUnsupported` | boolean        | True only when the newest unacknowledged failed renew row has error name `prfUnsupported`. Owner-only. False when that row is absent, acknowledged, or a different error.                                                                                                                                                                                                                         |
| `socialRecoverySetUp`        | boolean        | True when the api holds a 21.gifts recovery share for the account's current verified wallet (`sparkPubkey` with `sparkWalletVerified`; `PUT /me/recovery-share`). A share of a previous wallet does not count. No grant or date check. Owner-only.                                                                                                                                                |

### `GET /me/activity`

Bearer required (same session as `GET /me`). No living-room-rules gate.

Missing or invalid bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

Store throw → **Response** `503`:

```json
{ "error": "Gift stats are unavailable" }
```

**Response** `200` (empty series when the account has no attributed gifts):

```json
{
  "donatedSats": 0,
  "receivedSats": 0,
  "donatedOverTime": [],
  "receivedOverTime": [],
  "owedSats": 0,
  "creditSats": 0,
  "owedOverTime": [],
  "creditOverTime": [],
  "fx": {
    "quote": "BTC-USD",
    "dayBasis": "utc",
    "source": "coinbase-exchange-daily-close",
    "quotes": [{ "code": "USD", "pair": "BTC-USD", "source": "coinbase-exchange-daily-close" }]
  }
}
```

`donatedOverTime` / `receivedOverTime` reuse the `spendOverTime` day objects from `GET /gifts/stats`, including additive CHF/EUR/PHP. The stored payment-time USD/CHF/EUR/PHP is what is returned. Missing fiat is JSON `null`, never 503. Empty activity is 200 zeros with USD-only `fx.quotes` (no Coinbase / Frankfurter). Given = confirmed forum zaps this account paid on notes that are not loans, excluding repay: repayment invoices, plus outbound house gifts of kind daily and welcome when isPlatform is true. Moderator stipends (kind === 'moderator') are omitted. Received = indexed zaps on authored notes that are not loans (including hidden notes and replies), plus message.sats remainder on top-level non-loan notes only (a loan note is omitted entirely, including a hidden one; gift-as-reply sats are not Received), plus house gifts of kind daily and welcome to the account's recipient handle (its username, matched only once the wallet is verified; the stored external address is not used). A loan is a note with goalRepayable === true. An unknown note (getById undefined) still counts as a donation. Forum zaps are not mixed into GET /gifts/stats.

`owedSats` is what this account still owes; `creditSats` is what others still owe this account; series are SpendDay rows only on days with a movement; `cumulativeSats` is the outstanding balance and may fall; `sats` is that day's net change; an identified credit is a payer receipt on a goalRepayable note that counts toward the plan; anonymous receipts are neither; a repayment subtracts `due_sats`; balances are not clamped; a loan movement stores no fiat figure, so every USD/CHF/EUR/PHP field of the loan series is JSON null and no rate book is read; loans stay out of `donatedSats` and `receivedSats`.

### `GET /me/loans`

Bearer required. The member's own loans in one call: their live repayable asks (top-level notes with `goalRepayable` true and a term, not hidden) that are still collecting or not fully repaid, newest first. A funded loan whose every share is paid is left out. Read-only; a local Sunday does not refuse it.

Success → **Response** `200`:

```json
{
  "sundayRest": false,
  "loans": [
    {
      "messageId": "<uuid>",
      "text": "first 160 characters of the note",
      "createdAt": "2026-09-20T00:00:00.000Z",
      "goalSats": 30000,
      "sats": 30000,
      "goalCurrency": "BTC",
      "goalAmount": "30000",
      "goalAmountUsd": null,
      "goalAmountChf": null,
      "goalAmountEur": null,
      "goalAmountPhp": null,
      "amountUsd": null,
      "amountChf": null,
      "amountEur": null,
      "amountPhp": null,
      "termDays": 30,
      "fundedAt": "2026-09-26T12:00:00.000Z",
      "daysDue": 12,
      "daysPaid": 11,
      "repaidSats": 11000,
      "totalSats": 30000,
      "due": {
        "payableSats": 800,
        "payableAmount": null,
        "payablePeople": 2,
        "waitingSats": 200,
        "waitingAmount": null,
        "waitingPeople": 1,
        "waitingShares": 1,
        "behindDays": 0,
        "lastPayment": false
      },
      "next": { "dueOn": "2026-10-09", "sats": 1000, "amount": null }
    }
  ],
  "lenderWaiting": { "shares": 0, "loans": 0, "sats": 0 }
}
```

- `text` is the first 160 characters of the note. `goalCurrency` is the ask currency (`BTC` when none is stored) and `goalAmount` the typed amount (the goal sats when none is stored). The `goalAmount*` and `amount*` keys are the stored ask snapshots and collected totals, as on the public note.
- `fundedAt` is null while the loan is still collecting; such a loan has `daysDue` 0, `daysPaid` 0, `repaidSats` 0, zero `due` counts, and `next: null`.
- `daysDue` and `daysPaid` are those of `GET /messages/:id/repayment`. `repaidSats` is the sum of settled shares. `totalSats` is `repaidSats` plus every unpaid share in sats; sats with no account are not repaid and not counted.
- `due` covers every due, unpaid share. `payable*` are the shares whose lender can receive (the ones `POST /messages/:id/repayment/due` bills), `waiting*` the shares whose lender cannot. `*People` counts distinct lenders and `waitingShares` the waiting shares. `behindDays` is the number of due days before today that still have an unpaid share that is not waiting and did not fall due before its lender's wallet was verified (the rule of `daysPaid` in `GET /messages/:id/repayment`). `lastPayment` is true when paying `payable` would finish the loan.
- `next` is the next repayment day after the due days: `dueOn` (`YYYY-MM-DD` UTC), its sats, and its amount; null when no later day remains.
- `*Amount` and `amount` are two-decimal strings in the loan's currency for a fiat loan, else `null`. For a fiat loan every sat figure that is not yet paid (`totalSats`, `payableSats`, `waitingSats`, `next.sats`) is priced at the rate `POST /messages/:id/repayment` would use now, read once per request for every loan, and is `null` without a rate.
- `sundayRest` is true when the device `Time-Zone` names a zone that is in Sunday: the existing rule, under which repayments are refused today.
- `lenderWaiting` is the caller's side as a lender. While the caller cannot receive (no verified wallet), `shares` counts the due, unpaid shares owed to the caller on every live funded loan the caller gave to (found through the caller's in-app invoices, counted only when the caller is one of its givers), `loans` the loans they belong to, and `sats` their sum in sats (a fiat share priced like `waitingSats`; `null` when one has no rate). All zero when the caller can receive.

Missing/invalid bearer → **Response** `401` `{ "error": "Unauthorized" }`.
A loan whose debt cannot be computed (one of the caller's, or one the caller gave to), or a rate that cannot be read → **503** `{ "error": "Ask amount is unavailable" }`.
Store failure → **503** `{ "error": "Messages are unavailable" }` (logs `me.loans.failed`).

### `POST /me/wallet-backup-seen`

Bearer required. Records that this account can show a recovery phrase. Not a confirmation and not a setup step. Empty body. Does not change `walletRequired`.

Missing/invalid bearer → **Response** `401` `{ "error": "Unauthorized" }`.

Success → **Response** `200` with the owner JSON (same shape as `GET /me`).
The first successful POST sets `walletBackupSeenAt` to the server clock
(epoch ms). Later POSTs return the original timestamp unchanged
(idempotent; no second write). Logs `account.wallet.backup_seen` with
`{ accountId }` only. Never stores or logs a mnemonic or PRF output.

### `POST /me/passkey-renew/report`

Bearer required. Client report of a passkey renew attempt. Accepts only
`failed` or `cancelled` (`succeeded` is 400). Stores a renew row (server
generates `id` and `createdAt`; User-Agent from the header). Does not
change the account row. Before the length cap, a phrase of 12 or more
whitespace-separated tokens, or a run of 64 or more token characters, is
stored as `[redacted]` on error name (80), error code (80), message (500),
and user agent (300). Optional debug fields are public authenticator facts
only: `authenticatorAttachment` (`platform` or `cross-platform`),
`transports` and `extensions` (allowlisted names; anything else is dropped),
`aaguid` (32 hex, or a hyphenated UUID of those bytes), `prfEnabled` /
`prfPresent` / `residentKey` / `hmacSecret` booleans, `authenticatorFlags`
(WebAuthn flags byte 0–255: UP 0x01, UV 0x04, BE 0x08, BS 0x10, AT 0x40,
ED 0x80), `publicKeyAlgorithm` (COSE integer from -65536 to 65535),
`credProtect` (allowlisted policy name, or numeric code 1–3), and
`clientCapabilities` (sorted names of browser capabilities that were true).
A value that is not in that set is stored as null and does not reject the
row. Credential id, attestation, challenge, and PRF output are not accepted.
Returns owner JSON loaded after the insert,
including `passkeyRenewFailed`, `passkeyRenewClosed`, and
`passkeyRenewPrfUnsupported` (true only when the newest unacknowledged
failed row is `prfUnsupported`). A seed that landed during the request is
not closed. `passkeyRenewClosed` is true only while `walletRequired` is false.

Missing/invalid bearer → **Response** `401` `{ "error": "Unauthorized" }`.

Invalid JSON, unknown keys, or a body that fails the strict schema
(including `outcome: "succeeded"`) → **Response** `400`.

Success → **Response** `200` with the owner JSON (same shape as `GET /me`).

### `POST /me/passkey-renew/ack`

Bearer required. Empty body is fine. Acknowledges failed unacknowledged
renew rows only. Does not change the account row. Returns owner JSON
loaded after the acknowledgement, including `passkeyRenewFailed`,
`passkeyRenewClosed`, and `passkeyRenewPrfUnsupported` (true only when
the newest unacknowledged failed row is `prfUnsupported`). A seed that landed during the request is not closed.
`passkeyRenewClosed` is true only while `walletRequired` is false.

Missing/invalid bearer → **Response** `401` `{ "error": "Unauthorized" }`.

Success → **Response** `200` with the owner JSON (same shape as `GET /me`).

### `POST /me/setup/skip`

Skip a skippable wizard step. Body:

```json
{ "step": "name" }
```

or `{ "step": "lightning-address" }`. Still only `name` or `lightning-address`.
Sets the matching skip timestamp to now; does not clear `name` or the
wallet. `lightning-address` is the receiving-wallet step (token kept for app
compatibility). `step: "wallet"` is **400** with the same copy as an
invalid step: `{ "error": "Expected a JSON body with step \"name\" or \"lightning-address\"" }`.
`step: "rules"` and unknown steps are the same **400**. Success → **200**
owner JSON.

### `GET /members/:accountId`

Bearer required. `:accountId` must be a UUID. After auth,
`requireAction(caller, 'forum.read')` — missing rules → **409**
`{ "error": "missing_requirements", "missing": ["rules"] }`. Unknown id →
**404**. Store throw → **503** `{ "error": "Messages are unavailable" }`.
Success → live `id` / `name` / `username` (`string | null` LUD-16 / NIP-05
local-part) / `location` / `role` / `lightningAddress` (the receiving
address: verified wallet, or `null`) / ISO
`createdAt` plus `profileMessage` (`serializeMessage` with `accountId` /
`replyCount`, or `null`), derived `aboutMe` (profile-note text when it
is a real bio, else `null` when the profile note is missing or
soft-hidden via `deletedAt` (same as `profileMessage`); auto name-copy
is not a bio, including after a display-name rename when the note text
still equals the stored profile-note `name` (Ada→Grace with text `Ada`
stays `null`); keep `profileMessage`), `aboutMeHasPhoto` (true when the
live profile note has a stored photo; false when `profileMessage` is
`null`), uncapped live `postCount` / `replyCount` from `countByAccount`
(not the latest-200 window), `trust` (`verifiedBy` / `proposedBy` /
`confirmedBy` / `appointedBy`, each `{ id, name }` or `null`), and
`fundingReviewedAt` (`grant.admittedAt` when the effective grant is
admitted, else `null`) and `fundingReviewedByName` (the live display name
of `decidedBy` when that time is set and the trimmed name is non-empty,
otherwise `null`). `staffTag` is present only as `"software_developer"`
when set and is omitted otherwise (never JSON `null`). It is not a
permission and does not change `role`. Default
`trust` is all-null when no stored edges exist. Never `viewKey` /
`eventId`. Uncapped `shopCount` from `countShopsByAccount` is always present,
including 0, and is not derived from the capped shop list. A live top-level
`#21GiftsShop` note belongs to its assigned `shopAccount.id` when set and
otherwise to its author account; a shop assigned to someone else does not
belong to the author. Uncapped `creditCount` from `countCreditsByAccount` is
always present, including 0, and is not derived from the capped credit list.
A live top-level note with `goalRepayable === true` belongs to its author
account, not a shop assignment and not a hashtag; funded, unfunded, and
still-live repaid notes all count; deleted notes and replies do not. Never
pending/trial/rejected on the member card.

### `GET /members/:accountId/posts`

Bearer required. Same 401 / 409 / 404 / 503 as `GET /members/:accountId`
(`members.posts.failed` on 503). Live-only top-level notes by the member,
newest-first, capped at 200. Body `{ "messages": [...] }` via
`serializeMessage` like signed-in `GET /messages` (`accountId`,
`replyCount`, `payable` when a non-empty `eventId` and a receiving address are set,
`authorCanReceive` (true when the author has a receiving address, signed or not);
optional `goalSats` omitted when unset, optional `goalRepayable: true` when
the stored column is true (omitted when null; never false), optional
`goalTermDays` when the stored column is not null (omitted when null), and when
`goalCurrency` is stored also `goalCurrency`, `goalAmount`, and the four
`goalAmount*` snapshots — a snapshot may be null, a legacy row omits those
keys).
Omits `parentId`. Replies by that member are not listed.

### `GET /members/:accountId/shops`

Bearer required. Same 401 / 409 / 404 / 503 as `GET /members/:accountId`
(`members.shops.failed` on 503). Lists only live top-level `#21GiftsShop`
notes owned by the member under the assigned-shop rule described above,
newest-first (`createdAt` desc, `id` desc), capped at 200. Body
`{ "messages": [...] }` uses the same `serializeMessage` shape as the posts
route, including `accountId`, attributed `replyCount`, `payable` when a
non-empty `eventId` and a non-blank Lightning Address are set, and
`authorCanReceive` (true when the author has a receiving address, signed or not); it omits
`parentId`.

### `GET /members/:accountId/credits`

Bearer required. Same 401 / 409 / 404 / 503 as `GET /members/:accountId`
(`members.credits.failed` on 503). Lists only live top-level credit notes
owned by the member as author (`goalRepayable` exactly true; no shop
assignment, no hashtag), newest-first (`createdAt` desc, `id` desc),
capped at 200. Funded, unfunded, and still-live repaid notes all count;
deleted notes and replies do not. Body `{ "messages": [...] }` uses the
same `serializeMessage` shape as the posts route, including `accountId`,
attributed `replyCount`, `payable` when a non-empty `eventId` and a
non-blank Lightning Address are set, and `authorCanReceive` (true when the author has a receiving address, signed or not); it omits `parentId`.

### `GET /members/:accountId/replies`

Bearer required. Same 401 / 409 / 404 / 503 as `GET /members/:accountId`
(`members.replies.failed` on 503). Live-only replies by the member,
newest-first, capped at 200. Body `{ "messages": [...] }` via
`serializeMessage` with `payable` when a non-empty `eventId` and a receiving address are set, `authorCanReceive` (true when the author has a receiving address, signed or not), `accountId`, and optional
`parentId` when set; omits `replyCount`. Replies never include `goalSats`,
`goalRepayable`, or `goalTermDays`.
Top-level notes by that member are not listed.

### `GET /members/:accountId/activity`

A session has the same auth and 401 / 409 / 404 as `GET /members/:accountId`.
An operator token skips the session and `forum.read` gate; 404 still
applies. Success is the
same JSON as `GET /me/activity` for **that** member. 503 `{ "error": "Gift
stats are unavailable" }` when the gift store throws.

Operator access: `DEBUG_TOKEN` or `DEBUG_READ_TOKEN` as Bearer returns the same body without a session or role check. A bearer that matches neither token falls through to the session rules above.

### `GET /mentions`

Signed-in suggestions for `@` in a forum post or reply. Bearer session with `forum.read`.
Missing or invalid Bearer → **Response** `401` `{ "error": "Unauthorized" }`.
`forum.read` not yet allowed → **Response** `409` `{ "error": "missing_requirements", "missing": [...] }`.

Query `q` is optional. Omitted, empty, or whitespace, including a lone `@`
after trim, is the first page. Otherwise trim, strip one leading `@`, and
lowercase. The result must match `^[a-z0-9][a-z0-9._-]{0,31}$`. Anything else
→ **Response** `400` `{ "error": "Invalid query" }`.

A valid token matches the start of the stored username, the start of a
username segment split on `.` `_` `-`, the start of the trimmed display
name, or a display-name word split on space, `.`, `_`, or `-`. A token
that itself contains `.`, `_`, or `-` matches only a whole-string start.
Comparison is lowercase. `_` is a literal separator, not a wildcard.

**Response** `200`:

```json
{ "accounts": [{ "id": "…", "username": "ada", "name": "Ada" }] }
```

At most 20 rows, ordered by `lower(trim(username))` then `id`. Blank
usernames are skipped. `name` is the trimmed display name, or the stored
username when that name is blank. Does not store `@username` marks.

### `GET /accounts/by-username/:username`

Exact account lookup. Bearer session with `forum.read`.
Missing or invalid Bearer → **Response** `401` `{ "error": "Unauthorized" }`.
`forum.read` not yet allowed → **Response** `409` `{ "error": "missing_requirements", "missing": [...] }`.

`:username` is trimmed and lowercased. It must match `^[a-z0-9][a-z0-9._-]{0,31}$`
and must not be `_`. Anything else → **Response** `400` `{ "error": "Username is not valid" }`.

**Response** `200`:

```json
{ "id": "…", "username": "Ada", "name": "Ada Lovelace" }
```

`username` is the stored string. `name` is the stored display name, including
`null`. No other fields. No row, or a stored username that is not a non-empty
string → **Response** `404` `{ "error": "No account with that username" }`.

### `GET /trust-chain`

Stored trust graph. Bearer session required (any role, including basis).
Missing or invalid Bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

Bare `GET /trust-chain` returns
**founder seeds only** (`edges` empty) so a large chain is not dumped on
first paint. `GET /trust-chain?around=<id>` returns that chain member plus
one hop of **stored** public edges with at most one incoming edge per
subject: the oldest eligible sibling (`createdAt` then `id`), skipping a
non-chain oldest sibling so a later displayable contact can show. Eligible:
`verify`, `moderator_appoint`, and `moderator_propose` only when the live
subject is a `moderator`; `moderator_confirm` and `moderator_reject`
never. Later appoint,
confirm, or propose do not replace an earlier eligible contact. A pending
propose (subject still `verified`) stays private and is not a hop neighbor.
Neighborhood must consider all stored edges for each subject, not only
edges that touch `around`. Nodes are accounts at least verified (never
`basis`).
No synthetic or inferred edges. Lightning addresses, view keys, and
linking keys are omitted. Omitting `around` (or empty) is founder seeds.
A supplied `around` that is not a uuid (including Postgres `22P02`),
unknown, or `basis` → **404** `{ "error": "Not found" }`. Unauthenticated
`around` is 401, not 404.

Store throw → **Response** `503`:

```json
{ "error": "Trust chain is unavailable" }
```

Logged as `trust.chain.failed`.

**Response** `200` bare GET (or empty `around`; empty arrays when none):

```json
{
  "nodes": [{ "id": "<uuid>", "name": "Cyrill", "role": "founder" }],
  "edges": []
}
```

**Response** `200` `?around=<id>` (one hop of stored public edges; empty `edges` when the member has none):

```json
{
  "nodes": [
    { "id": "<uuid>", "name": "Cyrill", "role": "founder" },
    { "id": "<uuid>", "name": "Ada", "role": "verified" }
  ],
  "edges": [{ "from": "<actor-uuid>", "to": "<subject-uuid>", "kind": "verify" }]
}
```

### `GET /trust/proposals`

Staff pending-moderator queue. Bearer **session** required (moderator),
or an operator token (below). No `forum.read` /
rules gate — a moderator without rules agreement is still **200**.

Operator access: `DEBUG_TOKEN` or `DEBUG_READ_TOKEN` as Bearer returns the same body without a session or role check. A bearer that matches neither token falls through to the session rules above.

Lists pending proposals: the latest `moderator_propose` / `moderator_reject`
edge is `moderator_propose`, the live subject is still `verified`, and
there is no `moderator_confirm` or `moderator_appoint`. Missing
subjects are omitted. Oldest `createdAt` first, then propose-edge `id`
(FIFO). JSON `{ "proposals": [ … ] }` including an empty list. Each item
is `{ id, subject: { id, name, role: "verified" }, proposedBy: { id, name },
createdAt }` with the propose-edge `id` and ISO-8601 `createdAt`. A missing actor is
`{ id, name: null }`. `GET /trust-chain` still omits a pending
`moderator_propose`. Once the subject is a `moderator`, that propose is
eligible as the public incoming edge only when it is the oldest eligible
sibling (`createdAt` then `id`).

Missing/invalid/expired bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

Live role is not at least moderator → **Response** `403`:

```json
{ "error": "Forbidden" }
```

Store or project throw → **Response** `503`:

```json
{ "error": "Trust chain is unavailable" }
```

Success (including an empty list) → **Response** `200`:

```json
{
  "proposals": [
    {
      "id": "<propose-edge-uuid>",
      "subject": { "id": "<uuid>", "name": "Ada", "role": "verified" },
      "proposedBy": { "id": "<uuid>", "name": "Mod" },
      "createdAt": "2026-09-16T00:00:00.000Z"
    }
  ]
}
```

On success the process logs `trust.proposals.listed` with `{ count }`
only. On throw it logs `trust.proposals.failed`.

### `POST /trust/verify`

Bearer session. Body `{ "accountId": "<uuid>", "confirmedName": "<string>" }`. Caller must be at least
`moderator`. Inserts a `verify` edge from the caller to the subject,
then sets `account.role` to `verified`. `verified` is a real-life
confirmation (forum badge), not a verified wallet.

Missing/invalid bearer → **401** `{ "error": "Unauthorized" }`.
Caller not staff → **403** `{ "error": "Forbidden" }`.
Body is not JSON with an `accountId` string → **400**
`{ "error": "Expected a JSON body with an \"accountId\" string" }`.
Body is not JSON with a `confirmedName` string → **400**
`{ "error": "Expected a JSON body with a \"confirmedName\" string" }`.
`accountId` is not a UUID or the subject is missing → **404**
`{ "error": "Not found" }`.
Subject is the caller, a verify edge belongs to someone else, or the
subject is ineligible (`role` is not `basis`, except the caller-owned
retry below) → **409** `{ "error": "Conflict" }`.
Stored `name` is null or empty after trim, or `confirmedName` is not
exactly the stored name, including on the idempotent path → **409**
`{ "error": "Conflict" }`.
Unexpected store throw → **503** `{ "error": "Trust chain is unavailable" }`
logged as `trust.write.failed`.

The `confirmedName` check applies only to verify; the other staff POSTs
still take `{ "accountId" }` and the original accountId 400 sentence.

Idempotent **200** when the existing verify edge's actor is the caller and
the subject is already `verified` (no second insert). If that caller-owned
edge exists and the subject is still `basis`, completes the role write and
returns **200**. After a **200** that leaves the subject `verified` (new
edge, completed role write, or this idempotent repeat), the subject is
welcome-pinged when a live top-level photo or video exists, including About
me. An account without a receiving address (no verified wallet, or the
LNURL server off), or one that already has the welcome gift (once per
account, as for `POST /messages`), is not pinged. Omitted messages or spend
ping skips that ping. A ping failure still returns **200**.

Otherwise insert the edge then update role, log `trust.verified`
`{ subjectId, actorId }`.

**Response** `200`:

```json
{ "id": "<uuid>", "name": "Ada", "role": "verified" }
```

### `POST /trust/propose-moderator`

Bearer session. Body `{ "accountId": "<uuid>" }`. Staff only. Subject role
must be `verified`, not self. **409** when currently pending (latest
propose/reject is propose) or any `moderator_confirm` / `moderator_appoint`
exists, when the subject is not `verified`, or when after insert this row
is not the oldest open propose (the insert is deleted; remaining pending is
then best-effort cleared and fan-out for that propose-edge id, failure stays
**409**; empty open after a concurrent reject is the same **409**). When this
insert is the oldest open propose and extras exist, delete newer extra
proposes and still **200**. **200** inserts a **new**
`moderator_propose` after a reject (history kept; old propose/reject rows
are not deleted). Role is unchanged. Logs `trust.moderator_proposed`.
After **200**, delete `moderator_proposal` rows with
`replyId === subject.id`, then wrap `notifyModeratorProposed` (in-app
`moderator_proposal` plus Web Push to other staff). Then re-list: if
pending is empty or the pending propose-edge `id` is not this insert,
delete those rows again; if a different propose is pending, fan out for
that actor only when a second re-list still shows that same id, and
delete the rows if a re-list after that fan-out no longer matches.
HTTP still **200** if notify (or the purge) fails.
Same 401/403/404/409/503 shapes as `POST /trust/verify`. **400**
`{ "error": "Expected a JSON body with an \"accountId\" string" }`.
**200** `{ id, name, role }` (role unchanged).

### `POST /trust/confirm-moderator`

Bearer session. Body `{ "accountId": "<uuid>" }`. Staff only. A pending
proposal must exist (latest propose/reject is propose); the caller id must
not equal that latest proposer's actor id (independent second staff member).
Subject must still be `verified`. Inserts `moderator_confirm` then re-lists:
if the pending propose-edge `id` from `pendingModeratorProposals`
(ignoring this confirm insert) is no longer the same, or that id is not
also the oldest open propose (an older open propose is still present), delete
that confirm and **409** without promoting. Otherwise sets
role to `moderator`, logs `trust.moderator_confirmed`. If the caller
already stored `moderator_confirm` and the subject is still `verified`,
completes the role write and returns **200**. If the caller already stored
that edge and the subject's rank equals the moderator rank, returns **200**
with the stored role unchanged. A founder subject is **409** and stays
`founder`. Same 401/403/404/409/503 JSON shapes (409 when a confirm
edge belongs to someone else). **400**
`{ "error": "Expected a JSON body with an \"accountId\" string" }`.
A new grant returns **200**
`{ id, name, role }` with `role: "moderator"`. An idempotent **200**
returns the stored role. After a 200 that leaves the subject at the
moderator rank (new grant and idempotent same-actor 200), the api deletes
`moderator_proposal` rows with
`replyId === subject.id`, then notifies the subject only
(`moderator_appointed`, Web Push url `/welcome`). Notify failure does not
fail the POST.

### `POST /trust/reject-moderator`

Bearer session. Same auth as `POST /trust/propose-moderator` (staff,
moderator+). Body `{ "accountId": "<uuid>" }`. **409** self / not pending
(latest propose/reject is not propose, or any confirm/appoint) /
`role !== verified`. The original proposer **may** reject. Inserts
append-only `moderator_reject` then re-lists: if a concurrent confirm or
appoint already closed the grant, or the pending propose-edge `id` is still
the same (this reject lost the same-ms id tie), delete that reject and
**409**. If a newer propose already reopened the queue (including a
same-actor same-ms re-propose with a different edge `id`), **200** keeps
the reject in history and does not drop `moderator_proposal` rows. Role stays
`verified`. Logs
`trust.moderator_rejected` `{ subjectId, actorId }`. When pending is empty
after insert, re-lists once more and deletes `moderator_proposal` rows with
`replyId === subject.id` only if pending is still empty; if a re-list after
that delete shows a new pending propose, fan out for that actor and
re-list again so a concurrent close drops those rows. No notify
for the reject itself. Same 401/403/404/409/503 JSON shapes as
`POST /trust/verify`. **400**
`{ "error": "Expected a JSON body with an \"accountId\" string" }`.
**200** `{ id, name, role }` (role unchanged).

### `POST /trust/appoint-moderator`

Bearer session. Body `{ "accountId": "<uuid>" }`. Caller must be `founder`
(moderators → **403**). Subject must not be self, not `founder`, and not
already at the moderator rank; subject may be `basis` or `verified`. Inserts
`moderator_appoint` then sets role to `moderator`, logs
`trust.moderator_appointed`. If the caller already stored `moderator_appoint`
and the subject's rank equals the moderator rank, returns **200** with the
stored role unchanged. If that edge exists and the subject is not yet at
that rank, completes the role write and returns **200**. A subject already
at the moderator rank with no caller-owned appoint edge is **409**.
Same 401/403/404/409/503 shapes as `POST /trust/verify` (403
when the caller is not a founder). **400**
`{ "error": "Expected a JSON body with an \"accountId\" string" }`.
A new grant returns **200**
`{ id, name, role }` with `role: "moderator"`. An idempotent **200**
returns the stored role. After a 200 that leaves the subject at the
moderator rank (new grant and idempotent same-actor 200), the api deletes
`moderator_proposal` rows for the subject
(`deleteByTypeAndReplyId`) then notifies the subject only
(`moderator_appointed`, Web Push url `/welcome`). Notify failure does
not fail the POST.

### `POST /funding/apply`

Bearer session. Role `basis` → **403** `{ "error": "Forbidden" }`.
Applications are open to `verified` and above; the grant program has
no application pause since round 1 (UTC 2026-10-16). Apply requires a
filled About me (real bio, not empty/name-only), an About me photo, and a
non-empty location, checked in that order: missing About me → **400**
`{ "error": "About me is required" }`; missing photo → **400**
`{ "error": "About me photo is required" }`; missing location → **400**
`{ "error": "Location is required" }`. Effective status `none` or
`rejected` upserts `pending` (`appliedAt` now; trial/admitted/decided
cleared). `pending` / `trial` / `admitted`, or a pending write that
matches no row, → **409** `{ "error": "Conflict" }`. **200**
`{ "funding": OwnerFundingJson }` logs `funding.applied` `{ accountId }`.
Store throw → **503** `{ "error": "Funding is unavailable" }`
(`funding.write.failed`). Missing session → **401**
`{ "error": "Unauthorized" }`.

### `GET /funding/applications`

Staff Bearer (moderator). Lists effective **pending** grants
oldest `appliedAt` first (expired trials included after lazy persist).
JSON `{ "applications": [ { accountId, name, role, appliedAt } ] }`.
Logs `funding.applications.listed`. Same 401/403/503 shapes as
`GET /trust/proposals` with `{ "error": "Funding is unavailable" }`.

Operator access: `DEBUG_TOKEN` or `DEBUG_READ_TOKEN` as Bearer returns the same body without a session or role check. A bearer that matches neither token falls through to the session rules above.

### `GET /funding/applications/:accountId`

Staff Bearer. **404** when the id is not a UUID, the account is missing,
or there is no grant. **200** `{ account: { id, name, role, lightningAddress },
grant: { status, appliedAt, trialUtcDate, admittedAt, decidedAt },
messages }` with **effective** grant status and the same video-drop as
member posts (`MESSAGE_LIST_LIMIT`, `serializeMessage`).
`account.lightningAddress` is the receiving address (verified wallet) or
`null`.

Operator access: `DEBUG_TOKEN` or `DEBUG_READ_TOKEN` as Bearer returns the same body without a session or role check. A bearer that matches neither token falls through to the session rules above.

### `POST /funding/trial`

Staff Bearer. Body `{ "accountId" }`. Target must be effective pending,
not self, not `basis`. Sets `trial`, `trialUtcDate` = today UTC,
`decidedAt`/`decidedBy` now. **200** `{ id, name, role, funding }`.
Self / ineligible → **409**. Same 401/403/400/404/503 as
`POST /trust/verify` with Funding-unavailable 503.

After the write, when the spend ping is configured and the member has a
receiving address, the api pings spend for the member's newest live
top-level photo or video of that UTC day (About me included), as a daily
payout. From the grant gate day (UTC 2026-10-01) that ping also needs a
21.gifts recovery share for the member's current verified wallet
([docs/social-recovery.md](docs/social-recovery.md)); without one it logs
`spend.ping.skipped` / `not_eligible` and does not ping. No such post, or one
from an earlier UTC day, does not ping. A failed share read, lookup, or ping
logs `funding.daily_ping.failed` and the answer stays **200**.

### `POST /funding/admit`

Staff Bearer. Target effective pending **or** trial, not self, not
`basis`. Sets `admitted`, `admittedAt` now, `trialUtcDate` null.
**200** same shape as trial. From effective pending it sends the same ping
as `POST /funding/trial`, including its recovery share condition; from an
active trial it does not ping.

Admission is limited per grant round. Round 1 starts UTC 2026-10-16 and
has 10 places; only grants with status `admitted` and `admittedAt` at or
after the round start count. The store counts and writes in one atomic
step (`admitWithinPlaces`: Postgres transaction with
`pg_advisory_xact_lock`, count, then the status-CAS update), so concurrent
admissions never exceed the round. A full round is **409**
`{ "error": "All grant places are taken" }`, logs `funding.admit.full`
`{ accountId, actorId }`, and leaves the grant unchanged. Applications stay
open while the round is full.

### `GET /funding/places`

No session. Public count of the current grant round:
`{ "round": 1, "startsAt": "2026-10-16T00:00:00.000Z", "places": 10,
"admitted": 0, "placesLeft": 10, "nextGoalShops": 20 }`. `admitted` uses
the same count as `POST /funding/admit`. `placesLeft` is never below 0.
`nextGoalShops` is the fixed goal of active shops that opens the next
round: once `qualifyingShops` from `GET /funding/goal` reaches it, the next
round opens, and that round's size is set when it opens. A store throw → **503** `{ "error": "Funding is
unavailable" }` and log `funding.places.failed`.

### `POST /funding/reject`

Staff Bearer. Target effective pending or trial, not self. Sets
`rejected` and clears trial/admitted. **200** same shape as trial.

### `GET /funding/payout-days`

Staff Bearer (moderator). Seven UTC days ending today, oldest first,
and one row per person who missed a grant day, received a daily
payout, or received a welcome gift in that window, including a person
who was not entitled. Does not use the pre-2026-10-01 open gate and
does not run lazy trial expiry. JSON
`{ "days": [ "YYYY-MM-DD", … ], "rows": [ { accountId, name, days, welcome } ] }`
where each cell is `blocked`, `missed`, or `paid`, and `welcome` is
seven booleans in the same order. A day is `paid` only for
`gift.kind === "daily"`, which does not set `welcome`. A welcome gift
sets `welcome` and does not change `blocked`, `missed`, or `paid`.
Both may be true on the same UTC day. Moderator stipends, blank
handles, gifts outside the window, and other kinds do not count.
Entitlement comes from the grant alone: it does not reconstruct whether a
21.gifts recovery share was stored on a day, so a day an entitled member was
not paid for lack of a share shows as `missed`.
Logs `funding.payouts.listed` `{ count }`.
No session → **401** `{ "error": "Unauthorized" }`. Below moderator →
**403** `{ "error": "Forbidden" }`. Store throw → **503**
`{ "error": "Funding is unavailable" }` (`funding.payouts.failed`).

Operator access: `DEBUG_TOKEN` or `DEBUG_READ_TOKEN` as Bearer returns the same body without a session or role check. A bearer that matches neither token falls through to the session rules above.

### `GET /funding/daily-roster`

Bearer session, then initiator or founder (`canEditDailyPayoutRoster`). No session → 401 `{ "error": "Unauthorized" }`. Any other role, including moderator → 403 `{ "error": "Forbidden" }` and never 503. The API roster store is always present. Success 200 is only `{ comment, paymentsEnabled, defaultAmountUsd, recipients: [{ address, amountUsd, accountId, name }], moderatorPaymentsEnabled, moderators: [{ address, amountUsd, accountId, name }] }`. `defaultAmountUsd` is always 1: the USD paid to an unlisted admitted or trial grant. Moderator rows stay out of `recipients` and are returned on `moderators`. A store 400 whose `error` is exactly `Invalid comment`, `Invalid payments switch`, `Invalid address or amount`, `Address already listed`, or `Unknown address` stays 400 with that text. Any other store throw → 502 `{ "error": "Daily roster is unavailable" }`.

Operator access: `DEBUG_TOKEN` or `DEBUG_READ_TOKEN` as Bearer returns the same body without a session or role check. A bearer that matches neither token falls through to the session rules above. The operator read logs `{ operator: true, action }` instead of an account id.

### `POST /funding/daily-roster/comment`

Same session gate (initiator or founder; operator tokens do not write) and success/502 as GET. Body `{ comment: string }`. A body that is not that object, including a non-string comment → 400 `{ "error": "Invalid comment" }`. Newlines (`\n`, `\r`, `\r\n`) become spaces, then trim. Empty after trim is valid. Longer than 500 characters after that is 400 `{ "error": "Invalid comment" }` and is not cut. The stored `{ comment }` is that normalized string. The store returns any of these five exact texts unchanged: `Invalid comment`, `Invalid payments switch`, `Invalid address or amount`, `Address already listed`, `Unknown address`.

### `POST /funding/daily-roster/payments`

Same session gate (initiator or founder; operator tokens do not write) and success/502 as GET. Body `{ enabled: boolean }` only. Strings, numbers, and missing fields → 400 `{ "error": "Invalid payments switch" }`. Sets `paymentsEnabled` only. Store 400 texts are the same five.

### `POST /funding/daily-roster/recipients`

Same session gate (initiator or founder; operator tokens do not write) and success/502 as GET. Public body `{ accountId: string, amountUsd: number }`. `accountId` must match `MESSAGE_ID_RE`. `amountUsd` must be a finite number; numeric strings are rejected here. A body that is still `{ address, amountUsd }` fails. Local bad body → 400 `{ "error": "Invalid person or amount" }`. The route loads the account. Unknown account → 400 `{ "error": "Unknown person" }`. No receiving address (no verified wallet) → 400 `{ "error": "Person has no Lightning address" }`. Store failure on that load → 502 `{ "error": "Daily roster is unavailable" }`. The API store receives `{ address, amountUsd }` from the stored trimmed address and the amount. Duplicate addresses are case-insensitive (`trim` then `toLowerCase`). Store 400 texts are the same five.

### `POST /funding/daily-roster/recipients/update`

Same session gate (initiator or founder; operator tokens do not write) and success/502 as GET. Body `{ address: string, amountUsd: finite number }`. If the body is an object (not an array) whose `address` is a string but the amount fails → 400 `{ "error": "Invalid address or amount" }`. Any other local failure, including a missing address → 400 `{ "error": "Unknown address" }`. Address match is after trim and lower-case. Other row fields stay. Store 400 strings are the same five.

### `POST /funding/daily-roster/recipients/delete`

Same session gate (initiator or founder; operator tokens do not write) and success/502 as GET. Body `{ address: string }`. Local failure → 400 `{ "error": "Unknown address" }` always. Store 400 texts are the same five.

### `POST /funding/daily-roster/moderators`

Same session gate (initiator or founder; operator tokens do not write) and success/502 as GET. Public body `{ accountId: string, amountUsd: number }`. `accountId` must match `MESSAGE_ID_RE`. `amountUsd` must be a finite number; numeric strings are rejected here. Local bad body → 400 `{ "error": "Invalid person or amount" }`. The route loads the account. Unknown account → 400 `{ "error": "Unknown person" }`. No receiving address (no verified wallet) → 400 `{ "error": "Person has no Lightning address" }`. Store failure on that load → 502 `{ "error": "Daily roster is unavailable" }`, logged as `moderator-add`. The API store receives the person's receiving address and the amount via `addModerator`. Duplicate addresses are case-insensitive (`trim` then `toLowerCase`). Store 400 texts are the same five. Moderator rows stay out of `recipients`.

### `POST /funding/daily-roster/moderators/update`

Same session gate (initiator or founder; operator tokens do not write) and success/502 as GET. Body `{ address: string, amountUsd: finite number }` is passed to `updateModerator`. If the body is an object (not an array) whose `address` is a string but the amount fails → 400 `{ "error": "Invalid address or amount" }`. Any other local failure, including a missing address → 400 `{ "error": "Unknown address" }`. Store 400 strings are the same five.

### `POST /funding/daily-roster/moderators/delete`

Same session gate (initiator or founder; operator tokens do not write) and success/502 as GET. Body `{ address: string }` is passed to `deleteModerator`. Local failure → 400 `{ "error": "Unknown address" }` always. Store 400 texts are the same five.

### `POST /funding/daily-roster/moderators/payments`

Same session gate (initiator or founder; operator tokens do not write) and success/502 as GET. Body `{ enabled: boolean }` only, passed to `setModeratorPaymentsEnabled`. Strings, numbers, and missing fields → 400 `{ "error": "Invalid payments switch" }`. Sets `moderatorPaymentsEnabled` only. Store 400 texts are the same five.

### `GET /funding/daily-roster/document`

Spend Bearer, same as the invoices. Unset or blank token → 503 `{ "error": "Spend invoices are not configured" }`. Wrong or missing Bearer → 401 `{ "error": "Unauthorized" }`. Success 200 is the full document `{ comment, paymentsEnabled, moderatorPaymentsEnabled, defaultAmountUsd, recipients, moderators }`. `defaultAmountUsd` is always 1. A never-written store is empty defaults and two empty lists. A store 400 keeps its `{ "error" }`. Any other store throw → 502 `{ "error": "Daily roster is unavailable" }`. Never logs the token, a comment, or a Lightning address.

### `POST /funding/daily-roster/document`

Same Spend Bearer as GET. Body `{ comment, paymentsEnabled, moderatorPaymentsEnabled, recipients, moderators }`. A missing switch is `true`. `defaultAmountUsd` in the body is ignored. Writes only while the store is still the empty start document. A second import, including an invalid body, returns 200 with the stored document unchanged. Success 200 is the full document with `defaultAmountUsd` always 1. First-write 400 texts are the same five. Any other store throw → 502 `{ "error": "Daily roster is unavailable" }`. Never logs the token, a comment, or a Lightning address.

### `POST /funding/daily-roster/worker/comment`

Spend Bearer, same as the invoices. Body `{ comment: string }`. Newlines (`\n`, `\r`, `\r\n`) become spaces, then trim. Empty after trim is valid. Longer than 500 characters after that is 400 `{ "error": "Invalid comment" }` and is not cut. A body that is not `{ comment: string }`, including a non-JSON body, is that same 400, not 502. Success 200 is the full stored document `{ comment, paymentsEnabled, moderatorPaymentsEnabled, defaultAmountUsd, recipients, moderators }` with `defaultAmountUsd` always 1 and no `accountId` or `name`. Unset or blank token → 503 `{ "error": "Spend invoices are not configured" }`. Wrong or missing Bearer → 401 `{ "error": "Unauthorized" }`. Store 400 `{ "error": "Invalid comment" }` stays 400. Any other store throw → 502 `{ "error": "Daily roster is unavailable" }`. Never logs the token, a comment, or a Lightning address.

### `POST /funding/daily-roster/worker/payments`

Spend Bearer, same as the invoices. Body `{ enabled: boolean }` is passed to `setPaymentsEnabled`. A non-boolean `enabled`, including a non-JSON body, is 400 `{ "error": "Invalid payments switch" }`, not 502. Success 200 is the full stored document `{ comment, paymentsEnabled, moderatorPaymentsEnabled, defaultAmountUsd, recipients, moderators }` with `defaultAmountUsd` always 1 and no `accountId` or `name`. Unset or blank token → 503 `{ "error": "Spend invoices are not configured" }`. Wrong or missing Bearer → 401 `{ "error": "Unauthorized" }`. Store 400 of that text stays 400. Any other store throw → 502 `{ "error": "Daily roster is unavailable" }`. Never logs the token, a comment, or a Lightning address.

### `POST /funding/daily-roster/worker/recipients`

Spend Bearer, same as the invoices. Body `{ address: string, amountUsd: number }` is passed to `addRecipient`. A non-string address, a non-number or non-finite amount, or an amount that is not greater than zero is 400 `{ "error": "Invalid address or amount" }`. A duplicate is 400 `{ "error": "Address already listed" }`. A non-JSON body is 400 `Invalid address or amount`, not 502. Success 200 is the full stored document with `defaultAmountUsd` always 1 and no `accountId` or `name`. Recipients stay `{ address, amountUsd }` only. Unset or blank token → 503 `{ "error": "Spend invoices are not configured" }`. Wrong or missing Bearer → 401 `{ "error": "Unauthorized" }`. Any other store throw → 502 `{ "error": "Daily roster is unavailable" }`. Never logs the token, a comment, or a Lightning address.

### `POST /funding/daily-roster/worker/recipients/update`

Spend Bearer, same as the invoices. Body `{ address, amountUsd }` uses the same address/amount split as the member update route. When `address` is a string and the amount is bad → 400 `{ "error": "Invalid address or amount" }`. When `address` is not a string → 400 `{ "error": "Unknown address" }`. A non-JSON body is 400 `Unknown address`, not 502. Success 200 is the full stored document with `defaultAmountUsd` always 1 and no `accountId` or `name`. Unset or blank token → 503 `{ "error": "Spend invoices are not configured" }`. Wrong or missing Bearer → 401 `{ "error": "Unauthorized" }`. Store 400 of those texts stays 400. Any other store throw → 502 `{ "error": "Daily roster is unavailable" }`. Never logs the token, a comment, or a Lightning address.

### `POST /funding/daily-roster/worker/recipients/delete`

Spend Bearer, same as the invoices. Body `{ address: string }` is passed to `deleteRecipient`. A body that is not `{ address: string }`, including a non-JSON body, is 400 `{ "error": "Unknown address" }`, not 502. Success 200 is the full stored document with `defaultAmountUsd` always 1 and no `accountId` or `name`. Unset or blank token → 503 `{ "error": "Spend invoices are not configured" }`. Wrong or missing Bearer → 401 `{ "error": "Unauthorized" }`. Store 400 `{ "error": "Unknown address" }` stays 400. Any other store throw → 502 `{ "error": "Daily roster is unavailable" }`. Never logs the token, a comment, or a Lightning address.

### `POST /funding/daily-roster/worker/moderators`

Spend Bearer, same as the invoices. Body `{ address: string, amountUsd: number }` is passed to `addModerator`. A non-string address, a non-number or non-finite amount, or an amount that is not greater than zero is 400 `{ "error": "Invalid address or amount" }`. A duplicate is 400 `{ "error": "Address already listed" }`. A non-JSON body is 400 `Invalid address or amount`, not 502. Success 200 is the full stored document with `defaultAmountUsd` always 1 and no `accountId` or `name`. Moderators stay `{ address, amountUsd }` only. Unset or blank token → 503 `{ "error": "Spend invoices are not configured" }`. Wrong or missing Bearer → 401 `{ "error": "Unauthorized" }`. Any other store throw → 502 `{ "error": "Daily roster is unavailable" }`. Never logs the token, a comment, or a Lightning address.

### `POST /funding/daily-roster/worker/moderators/update`

Spend Bearer, same as the invoices. Body `{ address, amountUsd }` uses the same address/amount split as the member recipient update route. When `address` is a string and the amount is bad → 400 `{ "error": "Invalid address or amount" }`. When `address` is not a string → 400 `{ "error": "Unknown address" }`. A non-JSON body is 400 `Unknown address`, not 502. Success 200 is the full stored document with `defaultAmountUsd` always 1 and no `accountId` or `name`. Unset or blank token → 503 `{ "error": "Spend invoices are not configured" }`. Wrong or missing Bearer → 401 `{ "error": "Unauthorized" }`. Store 400 of those texts stays 400. Any other store throw → 502 `{ "error": "Daily roster is unavailable" }`. Never logs the token, a comment, or a Lightning address.

### `POST /funding/daily-roster/worker/moderators/delete`

Spend Bearer, same as the invoices. Body `{ address: string }` is passed to `deleteModerator`. A body that is not `{ address: string }`, including a non-JSON body, is 400 `{ "error": "Unknown address" }`, not 502. Success 200 is the full stored document with `defaultAmountUsd` always 1 and no `accountId` or `name`. Unset or blank token → 503 `{ "error": "Spend invoices are not configured" }`. Wrong or missing Bearer → 401 `{ "error": "Unauthorized" }`. Store 400 `{ "error": "Unknown address" }` stays 400. Any other store throw → 502 `{ "error": "Daily roster is unavailable" }`. Never logs the token, a comment, or a Lightning address.

### `POST /funding/daily-roster/worker/moderators/payments`

Spend Bearer, same as the invoices. Body `{ enabled: boolean }` is passed to `setModeratorPaymentsEnabled`. A non-boolean `enabled`, including a non-JSON body, is 400 `{ "error": "Invalid payments switch" }`, not 502. Success 200 is the full stored document `{ comment, paymentsEnabled, moderatorPaymentsEnabled, defaultAmountUsd, recipients, moderators }` with `defaultAmountUsd` always 1 and no `accountId` or `name`. Unset or blank token → 503 `{ "error": "Spend invoices are not configured" }`. Wrong or missing Bearer → 401 `{ "error": "Unauthorized" }`. Store 400 of that text stays 400. Any other store throw → 502 `{ "error": "Daily roster is unavailable" }`. Never logs the token, a comment, or a Lightning address.

### `GET /funding/goal`

Bearer session. Any signed-in role, including `basis`. The operator
`DEBUG_TOKEN` or `DEBUG_READ_TOKEN` reads the same body without a session;
the body holds only counts. Missing bearer, or a bearer that is neither an
operator token nor a session, is **401** `{ "error": "Unauthorized" }`. Seven UTC days
ending on the server clock's today, oldest first. A shop is a live
top-level forum note (`parent_id` null, `deleted_at` null) whose text
has the hashtag token `21GiftsShop` (case-insensitive, not followed by
`[A-Za-z0-9_]`) and whose `shop_account_id` is set. That note counts on
a UTC day when the account currently assigned to it has at least one
`pos_charge` with `created_at` on that day, any status (`pending`,
`cancelled`, or `expired`). Distinct notes, not accounts. A note
qualifies when that account has a charge on at least 5 distinct UTC
days inside the window. Those 5 days need not be consecutive.
Duplicate note ids count once. Reassigning the account, clearing it,
removing the hashtag, or soft-deleting the note rewrites every past
day. This is not `GET /shops/activity` and not a historical usage log.
JSON `{ "days": [ { "day": "YYYY-MM-DD", "shopCount": 0 } ], "qualifyingShops": 0 }`
with exactly 7 day objects, missing days included as zero. No
Sunday-rest gate. A store throw → **503**
`{ "error": "Funding goal is unavailable" }` and log
`funding.goal.failed` with no account, note, or charge ids.

### `GET /shops/activity`

No session is required. Missing or invalid bearer is still 200 with
the same body. Thirty UTC days ending on the
server clock's today, oldest first. A shop is a live top-level forum
note (`parent_id` null, `deleted_at` null) whose text has the hashtag
token `21GiftsShop` (case-insensitive, not followed by `[A-Za-z0-9_]`)
and whose `shop_account_id` is set. That note counts on a UTC day when
the account currently assigned to it has at least one `pos_charge` with
`created_at` on that day, any status (`pending`, `paid`, `cancelled`, or
`expired`). Distinct notes, not accounts: one account on two notes
counts twice. Duplicate note ids count once. Reassigning the account,
clearing it, removing the hashtag, or soft-deleting the note rewrites
every past day. This is not a historical usage log. JSON
`{ "days": [ { "day": "YYYY-MM-DD", "shopCount": 0 } ] }` with exactly
30 objects, missing days included as zero. No Sunday-rest gate. Does
not create a BOLT11 invoice. A store throw → **503**
`{ "error": "Shop activity is unavailable" }` and log
`shops.activity.failed` with no account, note, or charge ids.

### `GET /shops`

Public directory of public shops
([docs/shop-identity.md](docs/shop-identity.md) S3). A row is returned when
`publicShop` accepts the note and `shop_identity` already holds a key
for that note. Identities that are no longer public are omitted. Newest
note first (`createdAt` descending, then `id` descending). No session; a
bearer is ignored. `place` is null when the note has no coordinates.
`address` is null unless street, house number, postal code, city and
country are all non-blank. `name` is the pin label when that label is
non-blank, otherwise the first non-blank description line (at most 80
characters), otherwise `Shop`.

### `GET /shops/:npub`

Public lookup of a shop by its NOSTR identity
([docs/shop-identity.md](docs/shop-identity.md) S3). No session; a missing
or invalid bearer gets the same answer. Registered after `/shops/activity`,
so `activity` keeps its own handler. The route takes any single path segment
and validates it inside the handler.

| Request                                  | Response                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| npub of a public shop                    | **200** `{ "shop": Shop }`                                                                              |
| 64 lowercase hex of a known shop pubkey  | **301** to `/shops/{npub}` (relative `Location`)                                                        |
| npub of a known shop that is not public  | **410** `{ "error": "Shop is no longer listed", "npub": "npub1…" }`                                     |
| anything else, including an unknown npub | **404** `{ "error": "Not found" }`                                                                      |
| store failure                            | **503** `{ "error": "Shops are unavailable" }`, log `shops.detail.failed`                               |
| NIP-05 entry still stale after a re-read | **503** `{ "error": "Shops are unavailable" }`, log `shops.detail.failed` with `reason: "nip05_stale"`  |
| note still changing after the photo read | **503** `{ "error": "Shops are unavailable" }`, log `shops.detail.failed` with `reason: "note_changed"` |

`Cache-Control: public, max-age=60` on 200, 301, 404 and 410;
`Cache-Control: no-store` on 503. The 410 body carries no name.

`Shop` is
`{ "npub", "messageId", "name", "description", "place": { "lat", "lng", "label", "address": { "street", "houseNumber", "postalCode", "city", "country" } } | null, "photos": [{ "url", "width", "height" }], "payUsername", "nip05", "createdAt" }`.
`name` is the public shop name, `description` the note text without the
`#21GiftsShop` token. `place` is null when the note has no finite
coordinates. When `place` is present, `lat` and `lng` are as in
`GET /messages/places` and `address` is null unless every structured part
is non-blank. `photos` are the
note's photos in note order (at most 10), from one read of the whole set
(`MessageStore.getPhotoSet`), never photo 0 of one set with the extras of
another: photo 0 is
`/messages/:id/photo.<ext>` and extra still n ≥ 1 is
`/messages/:id/photo/<n>.<ext>`, absolute from the public API base or the
path alone when no public origin is set. `n` is the index the still is
stored under, so a still that the set leaves out (an unrecognized type)
drops only its own entry and never shifts the URLs after it; an
unrecognized photo 0 leaves the list with the extras alone. `width` and `height` come from the
image header only (JPEG `SOF`, PNG `IHDR`, WebP `VP8`/`VP8L`/`VP8X`), swapped
for a JPEG with EXIF orientation 5 to 8, and are `null` when the header
cannot be read. `payUsername` is the till account's username when it has a
username and a receiving address (a verified wallet with the LNURL server
configured), otherwise `null`. `nip05` is the
shop's `local@domain` from `/.well-known/nostr.json`, or `null` when
`PUBLIC_BASE_URL` gives no NIP-05 domain. It is read from the NIP-05
directory that `/.well-known/nostr.json` and the shop kind 0 share, cached in
process for 60 s per store set. Its entry must carry the name of the note
this request read; on the first missing entry or other name the request asks
once for a forced refresh of the directory (at most one computation per 10 s
per store set) and checks again, and when it still does not match (renamed
or no longer public in between) the route reads the note again (a note
no longer public is then 410); a mismatch on the last round answers the 503 with
`reason: "nip05_stale"`. After
the photo set the route reads the note again; when its text, pin, till
account id or `deletedAt` differ from the note the answer is built from (a
rename, text or pin change while the photos were read), it goes round once
more with that re-read, and when the note still differs on that last round it
answers the 503 with `reason: "note_changed"`, so a 200 never pairs the old
name with photos set after the change. A request reads the note at most three
times, asks for at most one forced NIP-05 directory refresh and reads the
photo set at most twice
([docs/shop-identity.md](docs/shop-identity.md) S3). `createdAt` is the note's
ISO-8601 creation time.

A **public shop** is a live top-level note with the `#21GiftsShop` token and
a till account (`shop_account_id`). A pin and a structured address are
optional. A **listed shop** is a public shop whose pin and description are
complete (`shopPlaceProblem` and `shopTextProblem` both null); only that
shop is sent to the OpenCryptoPay map. A write that makes a
note a public shop for the first time (`POST /messages`,
`PATCH /messages/:id/text`, `PATCH /messages/:id/place`,
`PATCH /messages/:id/shop-account`, `PUT /me/about`,
`POST /debug/messages/:id/restore`) creates its key after the commit with the
shop KEK (`NOSTR_NSEC_KEK`; a memory boot uses a random process-ephemeral key); a failure logs `shop.nostr_key.failed` and never
fails the request. The worker backfills keys that are missing. The key
belongs to the note forever. Every store write that changes the text, pin,
till account, hide state or photos of a note with a key queues the
OpenCryptoPay outbox in the same transaction; the senders run in the
background ([docs/shop-identity.md](docs/shop-identity.md) S5).

### `GET /view/:viewKey`

Public capability URL for a read-only profile card. No auth. Not a session:
the key cannot write, cannot mint a session, and is not accepted as
`Authorization: Bearer`.

Param not matching `/^[0-9a-f]{64}$/` or an unknown key → **Response** `404`:

```json
{ "error": "Not found" }
```

**Response** `200` (the same visible profile as `GET /members/:accountId`,
plus `hasPasskey` for the activation banner; omits `linkingKey`, `viewKey`,
and owner settings; `staffTag` only when it is `software_developer`):

```json
{
  "id": "account-id",
  "name": null,
  "username": null,
  "location": null,
  "role": "basis",
  "lightningAddress": null,
  "lightningAddressVerified": false,
  "createdAt": 0,
  "hasPasskey": false,
  "aboutMe": null,
  "aboutMeHasPhoto": false,
  "aboutMessageId": null,
  "postCount": 0,
  "replyCount": 0,
  "shopCount": 0,
  "creditCount": 0,
  "fundingReviewedAt": null,
  "fundingReviewedByName": null,
  "profileMessage": null
}
```

`lightningAddress` is the wallet address `<username>@<host of PUBLIC_BASE_URL>`
and `lightningAddressVerified` is `true` when the account has a verified wallet
and the LNURL server is configured; otherwise they are `null` and `false`. A
stored external address is ignored.

`hasPasskey` is `true` when the account has at least one passkey credential,
otherwise `false`. Clients use it to show an activation banner only while the
profile is still unclaimed. `aboutMe` is the profile-note text when it is a
real bio, else `null` (missing or soft-hidden (`deletedAt` set); auto
name-copy is not a bio, including after a display-name rename when the note
text still equals the stored profile-note `name` (Ada→Grace with text `Ada`
stays `null`)). `aboutMeHasPhoto` is true when the live profile note has a
stored photo; bytes are `GET /view/:viewKey/about/photo`. Store throw on the
profile-note read, the post, reply, shop, or credit count, the funding lookup,
or the reviewer account lookup → **503** `{ "error": "Messages are unavailable" }`
(`view.get.failed`). `profileMessage` is the same public note as
`GET /members/:accountId`, or `null`. `hearted` on that note is false.
The moderator `trust` object is not included.

### `GET /view/:viewKey/posts`

### `GET /view/:viewKey/shops`

### `GET /view/:viewKey/credits`

### `GET /view/:viewKey/replies`

Public. Same 404 as `GET /view/:viewKey`. Success is the same `{ messages }`
as the matching `GET /members/:accountId` list. `hearted` is false. 503
`{ "error": "Messages are unavailable" }` when the store throws
(`view.posts.failed`, `view.shops.failed`, `view.credits.failed`, or
`view.replies.failed`).

### `GET /view/:viewKey/activity`

Public. Same 404 as `GET /view/:viewKey` for a bad or unknown key. Success is
the same JSON as `GET /me/activity` for the account behind the key. 503
`{ "error": "Gift stats are unavailable" }` when the gift store throws.

### `POST /me/name`

Set or replace the account display name. Body:

```json
{ "name": "Ada" }
```

Missing/invalid bearer → **Response** `401` `{ "error": "Unauthorized" }`.

Body is not JSON with a `name` string → **Response** `400`:

```json
{ "error": "Expected a JSON body with a \"name\" string" }
```

Name is empty after trim, longer than 80 characters, or contains a C0
control / DEL character (`charCode < 32` or `=== 127`) → **Response** `400`:

```json
{ "error": "Name must be 1–80 characters" }
```

Success → **Response** `200` with the updated account (same shape as
`GET /me`). The stored value is trimmed. Names are not unique. The name
is written without changing username. When username is still blank, a
follow-up write stores `usernameFromDisplayName` if that handle is free.
Collision or a uniqueness race leaves username null (setup stays
`username`) and still returns 200; the display-name write is not rolled
back. `POST /me/name` does not 409 for a taken handle (`POST /me/username`
does). When the wallet is verified, the first persisted non-empty name also creates exactly one top-level profile
forum note and claims `profileMessageId` via `claimProfileMessageId`
(set only while the pointer still matches the missing/hidden read; not
on owner JSON). Without a verified wallet the name is stored and no
profile note is inserted (verifying the wallet later lets the worker
backfill create it). Rename
does not create a second note and does not change the note text.

### `POST /me/username`

Set the unique LUD-16 / NIP-05 local-part. Body:

```json
{ "username": "ada" }
```

Charset is lowercase `a-z0-9-_.`, 1–32 characters, leading letter or
digit. A trailing `.` or two dots in a row (`..`) is rejected. Routes that
look an account up by a normalised username
(`GET /.well-known/lnurlp/:username`, `GET /pay/:username`, `@` mentions
and the username lookups in `/messages`) apply the same rule, so a stored
username of that shape is not matched until it is renamed; existing
accounts are not migrated. `a.b_c-d` is valid. Cannot skip (no
`POST /me/setup/skip` step for username; skip body is only
`"name" | "lightning-address"`). Same handle on the same account is
idempotent **200**. Once the wallet is verified, a request with a valid session, body and handle is 409, including the same handle; a missing session is still 401 and an invalid body or handle still 400.

When the account already had a different username and the LNURL server is
configured, every daily roster row (both buckets) on `<old>@<host>` moves to
`<new>@<host>`, so a fixed amount or moderator stipend follows the new
receiving address; a bucket that already holds the new address drops the old
row. With a database (`mergeDb`, the daily roster and the LNURL server all
wired), the username change and that roster move run in one transaction under
the account row lock (`setUsernameWithRoster`): a concurrent rename of the same
account waits, then sees both the new username and the moved rows; a failure
changes nothing and the request fails with 500. Otherwise the username change
is one atomic `AuthStore.setUsername` step that reports the replaced username,
and the roster move, when it applies, is a second step; if that second step
fails, the request fails with 500 and `daily_roster.address.rename_failed`
names the old and the new username so an operator can rename the roster row
by hand; the new username stays stored.

Missing/invalid bearer → **Response** `401` `{ "error": "Unauthorized" }`.

Body is not JSON with a `username` string → **Response** `400`:

```json
{ "error": "Expected a JSON body with a \"username\" string" }
```

`normalizeUsername` fails (invalid charset / length / leading character /
`_` alone / trailing `.` / `..`) → **Response** `400`:

```json
{ "error": "Username must be 1–32 characters of a-z, 0-9, hyphen, underscore, or dot" }
```

Wallet already verified → **Response** `409`:

```json
{ "error": "Username is fixed once the wallet is connected" }
```

Another account owns the handle, including a unique-index race
(`setUsername` or `setUsernameWithRoster` returns `{ ok: false, reason: 'taken' }`) → **Response** `409`:

```json
{ "error": "Username is already in use" }
```

Success → **Response** `200` with the owner JSON (same shape as
`GET /me`) via `serializeOwnerAccountWithPosts`. Logs
`account.username.set`.

### `POST /me/location`

Set, change, or clear the account free-text location. Body:

```json
{ "location": "Berlin" }
```

Missing/invalid bearer → **Response** `401` `{ "error": "Unauthorized" }`.

Body is not JSON with a `location` string → **Response** `400`:

```json
{ "error": "Expected a JSON body with a \"location\" string" }
```

Location is longer than 80 characters after trim, or contains a C0
control / DEL character (`charCode < 32` or `=== 127`) → **Response** `400`:

```json
{ "error": "Location must be at most 80 characters" }
```

Success → **Response** `200` with the updated account (same shape as
`GET /me`). Empty or whitespace-only input stores `null` (clears). The
stored non-empty value is trimmed. Location is not unique, not a setup
step, and not a posting requirement. It is public on member and view
cards. Does not create or update a profile forum note.

### `PUT /me/about`

Set or clear About me on the profile forum note. Body:

```json
{ "text": "I build on Bitcoin", "photo": { "contentType": "image/jpeg", "data": "<base64>" } }
```

`text` is required. `photo` is optional: omitted leaves a stored photo;
JSON `null` clears it and clears the stored capture time;
`{ contentType, data, takenAt? }` is decoded with
`decodeForumPhoto` (same JPEG/PNG/WebP under 1 MiB as `POST /messages`).
Optional `takenAt` follows the same civil-time rule as `POST /messages`
(invalid or missing is stored null and does not 400).

Missing/invalid bearer → **Response** `401` `{ "error": "Unauthorized" }`.

Body is not JSON with a `text` string → **Response** `400`:

```json
{ "error": "Expected a JSON body with a \"text\" string" }
```

`text` is a string but `photo` is present and neither `null` nor
`{ contentType, data, takenAt? }`, or decode fails → **Response** `400`:

```json
{ "error": "Photo must be a JPEG, PNG, or WebP under 1 MiB" }
```

Text longer than 8000 characters after trim (or containing a disallowed
control character) → **Response** `400`:

```json
{ "error": "About me must be at most 8000 characters" }
```

Display name is blank → **Response** `409`:

```json
{ "error": "missing_requirements", "missing": ["name"] }
```

Text empty after trim, `photo` omitted or `null`, and no live profile
note (missing or soft-hidden) → **Response** `400`; no note is created
and nothing is notified:

```json
{ "error": "Write something about yourself" }
```

A verified wallet is not required. Empty `text` on a live note clears
the bio (`aboutMe` becomes `null`). When the note keeps no photo, extra
still, or video after the write, its text is set back to the auto name-copy (the
stored note `name`, or the display name when that is blank), never to
empty text, so it is omitted from `GET /messages` like any name-copy
note. A live note that keeps a photo, an extra still, or a video stores the
empty text.
Empty text **with** a decoded photo creates a photo-only live note. A non-empty write with no live note (missing or soft-hidden)
creates a new live note even without a verified wallet and claims
`profileMessageId` via `claimProfileMessageId` only while the pointer
still matches the missing/hidden read (not on owner JSON); a lost claim
deletes the insert and adopts a live winner. A won inline create calls
`notifyForumPost` after the writes (best-effort; no-op when the actor is
the official platform account; enqueue failure still 200). Updating an
already-live note does not notify. The hidden row
stays hidden. A published sats=0 note is unsigned (`resetSignedEvent`)
so kind:1 can be rewritten.
Store throw → **503** `{ "error": "Messages are unavailable" }`
(`account.about.failed`).

When the live profile note already has a complete pin and the new text
fails `shopTextProblem`, the response is **400**
`{ "error": "Shop description must be 20 to 1000 characters and longer than the shop name" }`.
The note text stays, and a photo in the same request is not written.
When `updateText` finds that note missing or hidden, the response is
**404** `{ "error": "Not found" }`.

Success → **Response** `200` with the account (same shape as `GET /me`).
About me is the profile-note text when it is a real bio, else null (auto
name-copy is not a bio, including after a display-name rename when the
note text still equals the stored profile-note `name` (Ada→Grace with
text `Ada` stays `null`)). `aboutMeHasPhoto` is true when the live note
has a stored photo. After that successful save, a verified account with a
live top-level photo or video (including this note) is welcome-pinged. An
account without a receiving address (no verified wallet, or the LNURL
server off), or one that already has the welcome gift (once per account, as
for `POST /messages`), is not pinged. Omitted spend ping skips. A ping
failure still returns **200**.

### `GET /me/about/photo`

Bearer. Raw profile-note photo bytes (`forumPhotoResponse`: jpeg/png/webp
`Content-Type`, one-day public cache, CORS `*`, inline filename).

Missing/invalid bearer → **Response** `401` `{ "error": "Unauthorized" }`.

No live profile note or no photo → **Response** `404`
`{ "error": "Photo not found" }`.

Store throw → **Response** `503` `{ "error": "Messages are unavailable" }`
(`account.about.photo.failed`).

### `GET /pictures/me` and `PUT /pictures/me`

The round profile photo. Not the wide image and not the About me note
photo. A missing photo leaves kind:0 `picture` at
`https://21.gifts/apple-touch-icon.png`. These routes never read or write
the other slot.

`GET /pictures/me` is Bearer. Raw bytes (`forumPhotoResponse`).
Missing or invalid bearer → **401** `{ "error": "Unauthorized" }`.
Nothing stored → **404** `{ "error": "Profile photo not found" }`.

`PUT /pictures/me` body is `{ "photo": null }` to clear, or
`{ "photo": { "contentType", "data" } }` for a JPEG, PNG, or WebP under
1 MiB with a readable size. A portrait is allowed. Success → **204**
with an empty body. It does not change the wide image or the About me
note.

Missing or invalid bearer → **401** `{ "error": "Unauthorized" }`.
Body is not JSON with a `photo` field, or `photo` is not `null` and not
`{ contentType, data }` → **400**
`{ "error": "Expected a JSON body with a \"photo\" field" }`.
Bytes that are not a decodable still → **400**
`{ "error": "Profile photo must be a JPEG, PNG, or WebP" }`.
When `Time-Zone` names an IANA zone that is Sunday on the server clock,
the PUT is **403** `{ "error": "SUNDAY_REST" }` before auth. A missing,
blank, or invalid zone does not refuse. GET is not refused.

### `GET /pictures/:file`

Public. `:file` is `{accountId}.jpg`, `.png`, or `.webp`. Returns the
stored profile photo when the extension matches the stored MIME. No auth.
Used as the Nostr kind:0 `picture` URL. Anything else → **404**
`{ "error": "Not found" }`.

### `GET /banners/me` and `PUT /banners/me`

The wide image. Not the profile photo and not the About me note photo.
A missing wide image leaves kind:0 `banner` at `https://21.gifts/og.png`
(1200×630). These routes never read or write the other slot.

`GET /banners/me` is Bearer. Raw bytes (`forumPhotoResponse`).
Missing or invalid bearer → **401** `{ "error": "Unauthorized" }`.
Nothing stored → **404** `{ "error": "Wide image not found" }`.

`PUT /banners/me` body is `{ "photo": null }` to clear, or
`{ "photo": { "contentType", "data" } }` for a JPEG, PNG, or WebP under
1 MiB that is at least 640 px wide and at least 1.5 times as wide as it
is tall. A portrait is rejected. Success → **204** with an empty body.
It does not change the profile photo or the About me note.

Missing or invalid bearer → **401** `{ "error": "Unauthorized" }`.
Body is not JSON with a `photo` field, or `photo` is not `null` and not
`{ contentType, data }` → **400**
`{ "error": "Expected a JSON body with a \"photo\" field" }`.
Bytes that are not a decodable wide image → **400**
`{ "error": "Wide image must be at least 640 px wide and at least 1.5 times as wide as it is tall" }`.
When `Time-Zone` names an IANA zone that is Sunday on the server clock,
the PUT is **403** `{ "error": "SUNDAY_REST" }` before auth. A missing,
blank, or invalid zone does not refuse. GET is not refused.

### `GET /banners/:file`

Public. `:file` is `{accountId}.jpg`, `.png`, or `.webp`. Returns the
stored wide image when the extension matches the stored MIME. No auth.
Used as the Nostr kind:0 `banner` URL. Anything else → **404**
`{ "error": "Not found" }`.

### `GET /view/:viewKey/about/photo`

Public. Same bytes as `GET /me/about/photo` for the account behind the
view key. Invalid or unknown key → **404** `{ "error": "Not found" }`.
No live note or no photo → **404** `{ "error": "Photo not found" }`.
Store throw → **503** `{ "error": "Messages are unavailable" }`
(`view.photo.failed`).

### `POST /me/forum-laws-dismissed`

Mark the welcome-forum living-room laws hint as dismissed. No body.

Missing/invalid bearer → **Response** `401` `{ "error": "Unauthorized" }`.

Success → **Response** `200` with the updated account (same shape as
`GET /me`), with `forumLawsDismissed: true`. Already-dismissed accounts return
the same shape without a second write (idempotent). There is no un-dismiss.

### `POST /me/wallet-intro-seen`

Mark the in-app wallet intro as seen. No body. Same responses as
`POST /me/forum-laws-dismissed`.

Missing/invalid bearer → **Response** `401` `{ "error": "Unauthorized" }`.

Success → **Response** `200` with the updated account (same shape as
`GET /me`), with `walletIntroSeen: true`. Already-seen accounts return the
same shape without a second write (idempotent). There is no reset, and a later
write to the account does not clear it. Logs `account.wallet_intro.seen`
`{ accountId }` on the first write only.

### `POST /me/notification-level`

Set the owner fan-out filter. Bearer session required (same as
`POST /me/forum-laws-dismissed`). Body:

```json
{ "level": "active" }
```

`level` must be `all`, `active`, `mentions`, or `none`.

Missing/invalid bearer → **Response** `401` `{ "error": "Unauthorized" }`.

Body is missing, not JSON, or `level` is not one of those strings
→ **Response** `400`:

```json
{ "error": "Expected a JSON body with a level of all, active, mentions, or none" }
```

Success → **Response** `200` with the updated account (same owner JSON as
`GET /me`), including `notificationLevel`. The same level again is still
**200** (idempotent). Logs `account.notification_level.set` with
`accountId` and `level`.

### `POST /me/amount-unit`

Set the owner amount-entry unit. Bearer session required (same as
`POST /me/notification-level`). Body:

```json
{ "unit": "fiat" }
```

`unit` must be `btc` or `fiat`. Default for a new account, and for a stored
value that is neither, is `btc`. This route does not change invoices.
Payment amounts stay whole sats.

Missing/invalid bearer → **Response** `401` `{ "error": "Unauthorized" }`.

Body is missing, not JSON, or `unit` is not one of those two strings
→ **Response** `400`:

```json
{ "error": "Expected a JSON body with a unit of btc or fiat" }
```

Success → **Response** `200` with the updated account (same owner JSON as
`GET /me`), including `amountUnit`. The same unit again is still **200**.
Public member cards and `GET /view/:viewKey` omit `amountUnit`. Logs
`account.amount_unit.set` with `accountId` and `unit`.

### `POST /me/locale`

Set the owner UI language. Bearer session required. Body:

```json
{ "locale": "de", "onlyIfUnset": true }
```

`locale` must be `en`, `de`, `es`, or `fil`. `onlyIfUnset` is optional and defaults to false. When true, the write happens only while the stored locale is null; a stored value is returned unchanged. When false, the stored value is replaced. New accounts start with null. This route does not backfill existing rows.

Missing/invalid bearer → **Response** `401` `{ "error": "Unauthorized" }`.

Body is missing, not JSON, `locale` is not one of those four strings, or `onlyIfUnset` is present and not a boolean → **Response** `400`:

```json
{ "error": "Expected a JSON body with a locale of en, de, es, or fil" }
```

Success → **Response** `200` with the owner account, including `locale`. `onlyIfUnset` on an already stored locale returns that stored locale and logs `wrote: false`. Public member cards and `GET /view/:viewKey` omit `locale`. Logs `account.locale.set` with `accountId`, `locale`, `onlyIfUnset`, and `wrote`.

### `POST /me/fiat`

Set the owner fiat currency. Bearer session required. Body:

```json
{ "fiat": "CHF", "onlyIfUnset": true }
```

`fiat` must be `CHF`, `EUR`, `USD`, or `PHP`. `onlyIfUnset` is optional and defaults to false. When true, the write happens only while the stored fiat is null. When false, the stored value is replaced. New accounts start with null. This route does not backfill existing rows.

Missing/invalid bearer → **Response** `401` `{ "error": "Unauthorized" }`.

Body is missing, not JSON, `fiat` is not one of those four strings, or `onlyIfUnset` is present and not a boolean → **Response** `400`:

```json
{ "error": "Expected a JSON body with a fiat of CHF, EUR, USD, or PHP" }
```

Success → **Response** `200` with the owner account, including `fiat`. Public member cards and `GET /view/:viewKey` omit `fiat`. Logs `account.fiat.set` with `accountId`, `fiat`, `onlyIfUnset`, and `wrote`.

### `POST /me/rules-agreement`

Record that the signed-in account agreed to the living-room rules. No body
is required; any JSON body is ignored.

Missing/invalid bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

Success → **Response** `200` with the account (same shape as `GET /me`). The
first successful POST sets `rulesAgreedAt` to the server clock (epoch ms).
Later POSTs return the original timestamp unchanged (idempotent; no 409).
New accounts start with `rulesAgreedAt: null`. Name changes and wallet
verification do not clear the timestamp.

### `GET /lightning-address`

Public LUD-16 metadata resolve for a future guest Donate flow. This route
returns cached well-known LNURL-pay metadata only; it never fetches a BOLT11
invoice (`pr`) and never pays. For a member's wallet address
(`<username>@<host of PUBLIC_BASE_URL>`) the callback in that metadata is
served by the api (`/lnurlp/:username/invoice`) and forwarded to the
self-hosted LNURL server, so the api sees the requested amount and the
invoice of a guest payment, but it never pays the invoice or holds the funds.
For any other domain the provider's callback is returned unchanged and the
api is not involved in the payment.

Query parameter:

| Param     | Required | Meaning                               |
| --------- | -------- | ------------------------------------- |
| `address` | yes      | Lightning Address (`name@domain.tld`) |

The value is normalised with the LUD-16 shape check
`normalizeLightningAddress` (trim; length ≤ 255; `local@domain.tld`).

Missing, empty, not LUD-16, or length `> 255` → **Response** `400`:

```json
{ "error": "Not a valid Lightning Address (expected name@domain)" }
```

Well-known fetch / JSON / schema failure, non-HTTPS callback, or network
error → **Response** `502`:

```json
{ "error": "Lightning Address could not be resolved" }
```

Success → **Response** `200`:

```json
{
  "address": "name@domain.tld",
  "callback": "https://…",
  "minSendable": 1000,
  "maxSendable": 100000000000,
  "commentAllowed": 255
}
```

| Field            | Type   | Meaning                                             |
| ---------------- | ------ | --------------------------------------------------- |
| `address`        | string | Normalised query value                              |
| `callback`       | string | LNURL-pay callback URL (`https:` only)              |
| `minSendable`    | number | Minimum sendable amount, millisatoshis              |
| `maxSendable`    | number | Maximum sendable amount, millisatoshis              |
| `commentAllowed` | number | Optional; omitted when the provider did not send it |

**Cache**: successful resolves are stored in process memory for **5 minutes**
(`LN_ADDRESS_CACHE_TTL_MS`). A cache hit does not call the provider. Process
restart clears the cache. There is no durable (Postgres) cache yet. No auth.
No new environment variables for this route; the process still boots with
zero extra config when `DATABASE_URL` and `DEBUG_TOKEN` are unset.

### `GET /debug/db`

Operator read of every ordinary table in schema `public`. Authenticated with
`Authorization: Bearer` matching `DEBUG_TOKEN`. This is not an end-user
session. `DEBUG_TOKEN` unset or blank → **Response** `503`
`{ "error": "Debug is not configured" }`. Missing or non-matching bearer →
**Response** `401` `{ "error": "Unauthorized" }`. Token matches but this
process has no SQL client → **Response** `503`
`{ "error": "Database is not configured" }`. No `table` returns
`{ tables: [{ name, rowCount }] }`. `table` returns 200 rows and
`nextCursor` when another page exists. Follow `nextCursor` until it is
absent. `bytea` cells, including `nostr_nsec_ciphertext` and
`recovery_share_ciphertext`, are octet lengths.
Text in `token`, `challenge`, `nonce`, `view_key`, `endpoint`, `p256dh`,
`auth`, `delivered_endpoints`, `skip_endpoints`, and `session_token` is the string `"redacted"`. A primary key
that is one of those columns is paged by `ctid`, so the cursor is not the
secret. A cursor that does not match the key is **Response** `400`
`{ "error": "Invalid cursor" }`. An unknown table is **Response** `404`
`{ "error": "Not found" }`. A store failure is **Response** `503`
`{ "error": "Database is unavailable" }`.

#### Wallet and interaction tables

`GET /debug/db` lists `wallet_balance_snapshot`, `wallet_payment`, and
`member_event` like every other table; `?table=<name>` pages their rows. They
are filled by `POST /me/wallet/report` and `POST /me/events`
(`docs/schema/wallet.sql`, `docs/schema/member_event.sql`). No column is
redacted. An account merge moves these rows to the surviving account, with the
two `wallet_payment` exceptions under `POST /me/wallet/report` (Storage).

- `wallet_balance_snapshot`: one row per accepted report. `id`, `account_id`
  (reporting member), `balance_sats` (wallet balance at sync), `synced_at`
  (sync time the app reported), `received_at` (server time of the report).
- `wallet_payment`: one row per member and wallet payment id, key
  `(account_id, payment_id)`. `direction` (`in` / `out`, seen from
  `account_id`), `status` (`pending` / `completed` / `failed`), `amount_sats`,
  `fee_sats`, `paid_at` (payment time the app reported), `method` (reported, lower-cased,
  e.g. `lightning`, `spark`, `onchain`), `payment_hash`, `invoice` (BOLT11 or
  Spark invoice), `destination`, `description`, `lnurl_comment` (each `null`
  when not reported or screened out), `category`, `counterparty_account_id`
  (the other member, platform account, or shop account when the category
  resolved one), `first_seen_at` (report that first stored the row),
  `updated_at` (last change of a stored value), `last_observed_at` (last
  accepted report that carried the payment).
- `member_event`: one row per accepted event. `id`, `account_id`, `name` (one
  of `MEMBER_EVENT_NAMES`), `at` (client time), `path` (no query or fragment),
  `props` (flat JSON object of scalars), `received_at` (server time of the
  batch).

`category`, first match wins (full rules under `POST /me/wallet/report`): `gift`
for an invoice the api issued for a forum or conversation note or an indexed zap
receipt (`platform` when the other side is the platform account); `shop` for a
point-of-sale charge; then, for another account of this deployment found by
own-host Lightning address or Spark key, `platform` (platform account), `shop`
(live `#21GiftsShop` note), or `member`; otherwise `onchain`,
`outside_lightning`, or `unknown`.

A payment between two members is reported by both wallets: the payer's row has
`direction` `out`, the payee's row has `direction` `in`, and their `payment_id`
values can differ, so `GET /debug/db` returns two rows for one payment. When the
apps reported it, the two rows share `payment_hash` (Lightning) or `invoice`
(Spark invoice). A total over all members must keep one row per payment, for
example by deduplicating on `payment_hash` or `invoice`; summing every row counts
such a payment twice.

### `GET /debug/accounts`

Operator listing of every stored account. Authenticated with
`Authorization: Bearer` matching `DEBUG_TOKEN`. This is not an end-user
session. Session tokens are never returned.

`DEBUG_TOKEN` unset or blank → **Response** `503`:

```json
{ "error": "Debug is not configured" }
```

Missing or non-matching bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

Success → **Response** `200`:

```json
{
  "accounts": [
    {
      "id": "<uuid>",
      "linkingKey": "<hex>",
      "role": "basis",
      "name": null,
      "username": null,
      "location": null,
      "lightningAddress": null,
      "lightningAddressVerified": false,
      "forumLawsDismissed": false,
      "createdAt": 0,
      "rulesAgreedAt": null,
      "isPlatform": false,
      "sessionRefused": false,
      "viewKey": "<64-hex>",
      "nameSkippedAt": null,
      "lightningAddressSkippedAt": null,
      "profileMessageId": null,
      "notificationLevel": "all",
      "amountUnit": "btc",
      "locale": null,
      "fiat": null,
      "walletRequired": false,
      "walletBackupSeenAt": null,
      "walletIntroSeen": false,
      "sparkPubkey": null,
      "sparkPubkeyVerifiedAt": null,
      "nostrPubkey": "<64-hex>",
      "nostrNsecCiphertext": "<envelope-hex>",
      "nostrKekId": 1,
      "nostrKeyCustody": "custodial",
      "nostrKeyCreatedAt": 0
    }
  ]
}
```

The listing uses `serializeDebugAccount` (public fields plus `isPlatform`,
`sessionRefused`, `viewKey`, `locale`, `fiat`, `walletRequired`,
`walletBackupSeenAt`, `walletIntroSeen`, `sparkPubkey`, `sparkPubkeyVerifiedAt`,
and Nostr debug fields). `locale` and `fiat` are null until stored. `sparkPubkey` /
`sparkPubkeyVerifiedAt` are null until claimed / verified. `staffTag` is
present only as `"software_developer"` when set and is omitted otherwise (never
JSON `null`). It is not a permission and does not change `role`. Member `GET /me`
does not include `isPlatform` or `sessionRefused` (it exposes
`sparkWalletVerified` instead of the raw timestamp). Public member cards omit
`locale`, `fiat`, and the wallet key fields.

Accounts are ordered by `createdAt` ascending, then `id`. An empty store
returns `"accounts": []`.

Environment:

| Variable       | Meaning                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `DATABASE_URL` | When set, auth state is stored in Postgres; when unset, in-memory only. |
| `DEBUG_TOKEN`  | Operator bearer for this route. Unset → 503; process still boots.       |

### `GET /debug/accounts/:id`

Operator detail of one account via `serializeDebugAccountDetail`: the account
columns except the retained legacy `lightning_address` and
`lightning_address_verified` and the derived `spark_address` (it follows from
`sparkPubkey`), plus nested `passkeys`, `sessions`, and matching
`passkeyChallenges`. `lightningAddress` is the receiving address (verified
wallet) when the LNURL server is configured. Session tokens are plaintext. nsec is
envelope hex, never decrypted. Unknown or non-UUID id → **Response** `404`.
Same `DEBUG_TOKEN` gate as `GET /debug/accounts`.

### `POST /debug/accounts`

Operator provision of accounts by display name, with no passkey, no wallet,
and `rulesAgreedAt` null. Same `DEBUG_TOKEN` bearer as GET. A provisioned
member has no verified wallet, so it can read but cannot receive or post until
it sets one up.

**Request** JSON `{ "accounts": [ { "name": string, "username"?: string } ] }`
(1–100 rows; name 1–80 after trim; unknown row keys, including
`lightningAddress`, are refused). Invalid body, an unknown key, C0/DEL in a
name, or a username that `normalizeUsername` rejects → **Response** `400`
`{ "error": "Expected a JSON body with an \"accounts\" array" }` (no row is
written). A created row that cannot be read back → **Response** `500`
`{ "error": "Could not save the account" }`.

With `username`: an existing account with that username (`lower(trim)`) gets
only its `name` updated (other columns stay; `created` is `false`); otherwise a
new `basis` row with that username and a fresh `viewKey` is created (`created`
is `true`). Without `username`: every row creates a new `basis` row with a
username derived from the name (`provisionUsername`).

Success → **Response** `200`:

```json
{
  "accounts": [
    {
      "name": "Ada",
      "username": "ada",
      "viewKey": "<64 lowercase hex>",
      "created": true
    }
  ]
}
```

`GET /debug/accounts` and `GET /debug/accounts/:id` also include `viewKey`
and `username`.

### `PATCH /debug/accounts/:id`

Operator assignment of the account's forum display role, the official
platform flag (`isPlatform`), and/or
session refusal (`sessionRefused`). Authenticated with
`Authorization: Bearer` matching `DEBUG_TOKEN` (same gate as
`GET /debug/accounts`). Body is one or more of `role`, `platform`, and
`sessionRefused`; any other key (including `lightningAddress`) is refused:

```json
{ "role": "basis", "platform": true, "sessionRefused": true }
```

`role` must be one of `basis`, `verified`, `moderator`, `initiator`, or `founder`.
`platform` is a
boolean; `true` clears any other platform flag (at most one `isPlatform`
account) and, when a conversation store is wired, points every
`member_platform` thread at this account except a thread whose member is
already this account. `sessionRefused` is a boolean; `true` makes passkey
finish and this route's session mint return 403 with the wrong-account
copy (`GET /me` too). A receiving address cannot be set here: a member
receives only on their verified in-app wallet. `verified` as a **role** is a
human-identity badge (a moderator physically met the person); it
is not a verified wallet. New passkey accounts stay `basis` until
staff confirm them via `POST /trust/verify` or an operator overrides `role`
here. This route does **not** write trust edges;
use `POST /debug/trust-edges` to backfill stored grants without changing
`role`.

`DEBUG_TOKEN` unset or blank → **Response** `503`:

```json
{ "error": "Debug is not configured" }
```

Missing or non-matching bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

Body is not JSON with a known `role`, `platform` boolean, and/or
`sessionRefused` boolean, or has another key → **Response** `400`:

```json
{
  "error": "Expected a JSON body with a \"role\" string, platform boolean, and/or sessionRefused boolean"
}
```

Unknown account id → **Response** `404`:

```json
{ "error": "Not found" }
```

Success → **Response** `200` with the updated account JSON (same
`serializeDebugAccount` shape as `GET /debug/accounts`, including
`isPlatform`, `sessionRefused`, `viewKey`, `walletRequired`,
`walletBackupSeenAt`, `walletIntroSeen`, `sparkPubkey`, `sparkPubkeyVerifiedAt`,
and Nostr debug fields). Role changes log `debug.accounts.role_set`
with the account id and new role. Platform changes log
`debug.accounts.platform_set` with the account id and the new flag.
Session-refusal changes log `debug.accounts.session_refused_set` with the
account id and the new flag.

### `POST /debug/accounts/:id/session`

Operator mint of a member bearer for the given account id. Authenticated
with `Authorization: Bearer` matching `DEBUG_TOKEN`. Response `{ "token": "<hex>" }`.
Unknown account id → **404** `{ "error": "Not found" }`. An account with
`sessionRefused` is **403**
`{ "error": "You signed in with the wrong account. Please try again with the correct account." }`
with no minted bearer and no `debug.accounts.session_minted` log. Same
503/401 gate as the other debug account routes. Not a member login path;
for e2e and operator debugging.

### `POST /debug/accounts/merge`

Operator merge of one account into another. Authenticated with
`Authorization: Bearer` matching `DEBUG_TOKEN`. Not a member route.
Body is `{ "from": "<uuid>", "into": "<uuid>", "verify": "from" | "into" }`.
`verify` defaults to `"into"`. Success is **200**
`{ "into": "<uuid>", "deleted": "<uuid>", "messages": <count> }`.
`deleted` is the source id. `messages` counts message rows that belonged
to `from` before they moved, including soft-deleted rows.

The account named by `into` remains. The account named by `from` is
deleted at the end of the same transaction. A failure, including a
unique-index collision that this route does not already clear, rolls
every write back. Nothing is half-moved.

The survivor keeps the login the operator chose. Name, username,
location, and the in-app wallet key are not copied from the source, and
neither is the wallet verification. Gifts are stored against
the Wallet of Satoshi username, not the account id, so they are not
reassigned. Nostr keys, the view key, and the linking key stay on the
survivor. `sessionRefused` stays the survivor's: closing an account
does not lock the account that remains. Notification level and amount
unit stay the survivor's. Locale and fiat are copied from the source
only when the survivor's value is empty.

Three stamps record the person, not the replacement login.
`created_at` becomes the earlier of the two times. `rules_agreed_at`
becomes the earlier agreement; one agreement is enough, and neither
agreement leaves the column empty. `wallet_required` becomes true when
either account already has it, so the recovery-phrase prompt is not
opened again. `wallet_backup_seen_at` becomes the earlier seen time.
`forum_laws_dismissed` becomes true when either account dismissed the
laws. `wallet_intro_seen` becomes true when either account saw the wallet
intro. The role stays the survivor's and is never lowered. A basis
survivor becomes verified when a verify edge is still present after
the move. The profile note stays the survivor's when the survivor has
one. It becomes the source profile note only when the survivor has
none.

`verify` chooses which verification remains. `"into"` keeps the
survivor's verify edge and deletes the source's. `"from"` deletes the
survivor's verify edge and moves the source's onto the survivor.
Moderator confirmations and appointments keep the survivor's row when
both accounts have that kind, and otherwise move. Proposals and
rejections move even when they repeat.

Passkeys of both accounts are kept, so both phones can sign in.
Sessions of the source are deleted. The source's social recovery rows are
deleted, not moved: its `recovery_share` rows, its `pending_recovery` row,
its `previous_wallet` rows, and its `recovery` passkey challenges. They
belong to the source's wallets, which go with the source row, and a share's
additional data is the source id. Messages, invoice rows, edit
history, contacts, push subscriptions, and the other foreign keys to
`account(id)` are moved. Those foreign keys are read from the catalog
inside the transaction, so a later table is moved too. A conversation
that exists only between these two accounts is deleted. Two
conversations with the same other person are folded into one, and the
messages are kept. Where a second row would break a unique key, the
survivor's row stays and the source's row is dropped: the same image
slot, the same notification, the same repayment day, a second address
check, and a second open till charge. When both accounts have a free
first post, the source note moves but is no longer marked free, so the
survivor keeps one free first post. Two funding grants are refused
before any of those writes.

An invalid body is **400**
`{ "error": "Expected a JSON body with \"from\" and \"into\"" }`
before the database is required. The same id is **409**
`{ "error": "Cannot merge an account into itself" }`. A missing
account is **404** `{ "error": "Not found" }`. The platform account
is **409** `{ "error": "Cannot merge the platform account" }`. Two
funding grants are **409**
`{ "error": "Both accounts have a funding grant" }`. A source account
with a shop payment that is neither `paid` nor closed is **409**
`{ "error": "A payment is already open" }` and nothing changes, because
that payment's BOLT11 still pays the source account's wallet, which the
merge does not carry over; the merge can be repeated after the final
settlement read, 10 minutes after the BOLT11 expired. A source with an
unexpired pending till charge while the survivor has an `open` shop
payment and no unexpired pending till charge of its own is the same
**409** and nothing changes, so a till charge never lands next to another
payment's open amount. Both refusals are checked under the locks of both
account rows, before any write. When the survivor has a pending till
charge (expired or not), the source's pending charges are deleted (below)
and the merge goes on. The source's paid and closed shop payments move like
every other row. All of the source's charge rows are locked first in the
order of their ids (`SELECT id … ORDER BY id FOR UPDATE`), the pending
charges among them are read, the source's shop payment rows are locked the
same way, and then their `pos_charge_invoice` rows and the charges are
deleted by those ids; a concurrent
`recordInvoice` for such a charge waits on the lock and then fails, which
the invoice routes log as `pos.invoice.record_failed`, and a later one
records nothing (`not_open`). A database that
cannot run the merge, and any thrown write, is **503**
`{ "error": "Merge is unavailable" }`. The same 503/401 debug-token
gate as the other debug account routes applies. Success logs
`debug.accounts.merged` with the two ids and the message count.
Failure logs `debug.accounts.merge_failed` with the two ids and the
SQLSTATE when the driver reported one. The text of a message, a
token, an nsec, and a view key are not logged.

### `POST /debug/shop-proofs/:id/retry`

Operator retry of a shop payment proof that is `stuck`
([Shop payment in USDT and USDC](#shop-payment-in-usdt-and-usdc)).
Mounted only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve;
otherwise Hono's default 404. Authenticated with `Authorization: Bearer`
matching `DEBUG_TOKEN`. No body.

The proof moves from `stuck` back to unresolved, `give_up_at` is set 24 h
ahead, and `shop.proof.retried` is logged. A `hex` proof without a log
index gets `next_receipt_at` now, so the receipts duty reads and sends its
transaction again and the submits duty submits it once the receipt filled
the log index; any other proof gets `next_submit_at` now and the watcher
submits it again. It runs under the payment's `shop_payment` row and its
proof rows.

**Response** `200`: `{ "id": "<uuid>", "result": null }`.

`DEBUG_TOKEN` unset or blank → **Response** `503`
`{ "error": "Debug is not configured" }`. Bearer mismatch →
**Response** `401` `{ "error": "Unauthorized" }`. `:id` not a UUID, or no
such proof → **Response** `404` `{ "error": "Not found" }`. A proof that is
not `stuck` → **Response** `409` `{ "error": "The proof is not stuck" }`.

### `GET /debug/trust-edges`

Operator listing of every stored trust edge (`serializeTrustEdge`), newest
`createdAt` then `id` descending. Success body is
`{ "edges": [ serializeTrustEdge, ... ] }`. Unexpected store throw → **503**
`{ "error": "Trust chain is unavailable" }` logged as `debug.trust_edges.failed`.
Same `DEBUG_TOKEN` gate as the other debug routes.

### `GET /debug/dump`

Operator catalog of every allowlisted table as camelCase JSON (cap 200 per
table). Success body is `{ "tables": { "<table>": [ ... ] } }` with one array
per allowlisted name (cap 200): `account`, `passkey_credential`,
`passkey_challenge`, `auth_session`, `api_log`,
`contact`, `pos_charge`, `conversation`, `conversation_message`, `conversation_read`,
`message`, `message_extra_photo`, `shop_identity`, `message_invoice`,
`nostr_zap_ingest`, `nostr_zap_receipt`, `nostr_zap_payment`, `nostr_zapper`,
`nostr_blocked_pubkey`, `notification`, `push_subscription`, `push_outbox`,
`trust_edge`, `gift`, `btc_usd_daily`, `usd_fiat_daily`, `db_change`. Media bytes stay off JSON. `nostrNsecCiphertext` of an
`account` row is envelope hex. A `shop_identity` row has the key metadata
and the outbox state but never its encrypted secret. `btc_usd_daily`,
`usd_fiat_daily`, and `db_change` dump stored rows when those list ports are
wired (in-memory boots dump `[]` for `db_change`). `api_log` dumps when an
audit store is wired (the newest 200; the full history is `GET /debug/api-log`
following `before` and `beforeId` while `hasMore` is true). Same `DEBUG_TOKEN`
gate as the other debug routes. Unexpected store throw → **503**
`{ "error": "Dump is unavailable" }`.

### `GET /debug/dump/:table`

Same catalog for one allowlisted table. Response `{ "table", "rows" }`.
Unknown table → **Response** `404` unless the path segment is one of
`account`, `passkey_credential`, `passkey_challenge`, `auth_session`,
`api_log`, `contact`, `pos_charge`, `conversation`,
`conversation_message`, `conversation_read`, `message`, `message_extra_photo`,
`shop_identity`, `message_invoice`, `nostr_zap_ingest`, `nostr_zap_receipt`, `nostr_zap_payment`,
`nostr_zapper`, `nostr_blocked_pubkey`, `notification`, `push_subscription`,
`push_outbox`, `trust_edge`, `gift`, `btc_usd_daily`, `usd_fiat_daily`,
`db_change`. Same `DEBUG_TOKEN` gate. Unexpected store throw → **503**
`{ "error": "Dump is unavailable" }`.

### `POST /debug/trust-edges`

Operator backfill of a stored trust edge. Authenticated with
`Authorization: Bearer` matching `DEBUG_TOKEN` (same 503/401 gate as the
other debug routes). Does **not** change `account.role`.

**Request**:

```json
{
  "subjectId": "<uuid>",
  "actorId": "<uuid>",
  "kind": "verify"
}
```

`kind` is one of `verify`, `moderator_propose`, `moderator_confirm`,
`moderator_appoint`, `moderator_reject`. Propose and reject may repeat;
**409** duplicate only for live-unique kinds (`verify`,
`moderator_confirm`, `moderator_appoint`) or `subjectId === actorId`.

Bad body → **400** `{ "error": "Expected a JSON body with \"subjectId\", \"actorId\", and \"kind\" strings" }`.
Missing subject or actor (or a non-UUID id) → **404** `{ "error": "Not found" }`.
Duplicate live-unique `(subjectId, kind)` or `subjectId === actorId` → **409**
`{ "error": "Conflict" }`.
Unexpected store throw → **503** `{ "error": "Trust chain is unavailable" }`
logged as `debug.trust_edges.failed`.
Success logs `debug.trust_edges.inserted` `{ subjectId, actorId, kind }`.

**Response** `200`:

```json
{
  "id": "<uuid>",
  "subjectId": "<uuid>",
  "actorId": "<uuid>",
  "kind": "verify",
  "createdAt": "2026-09-12T00:00:00.000Z"
}
```

`createdAt` is ISO-8601.

### `DELETE /debug/trust-edges`

Operator delete of a stored trust edge. Authenticated with
`Authorization: Bearer` matching `DEBUG_TOKEN` (same 503/401 gate as the
other debug routes). Does **not** change `account.role`. Deletes the
latest stored row of that `(subjectId, kind)` (`createdAt` desc, then
`id` desc).

**Request**:

```json
{
  "subjectId": "<uuid>",
  "kind": "moderator_confirm"
}
```

`kind` is one of `verify`, `moderator_propose`, `moderator_confirm`,
`moderator_appoint`, `moderator_reject`.

Bad body → **400** `{ "error": "Expected a JSON body with \"subjectId\" and \"kind\" strings" }`.
Non-UUID `subjectId` or no matching row → **404** `{ "error": "Not found" }`.
Unexpected store throw → **503** `{ "error": "Trust chain is unavailable" }`
logged as `debug.trust_edges.delete_failed`.
Success logs `debug.trust_edges.deleted` `{ subjectId, kind }`.

**Response** `200` is the deleted edge, same JSON as `POST /debug/trust-edges`.

### `GET /debug/api-log`

Operator listing of HTTP audit rows (`api_log`). Authenticated with
`Authorization: Bearer` matching `DEBUG_TOKEN`. This is not an end-user
session. Rows are newest-first (`createdAt` descending, then `id`). Each
response is one keyset page of at most **200** logs. `hasMore` is true only
when another page exists. Follow `before` (the last log's `createdAt`) and
`beforeId` (its `id`) while `hasMore` is true to read every matching row,
including every row for one account. Omit `accountId` for every account;
when present it is trimmed and must be a UUID (passed lowercased) or the
response is **400** `{ "error": "Invalid account" }`. `before` and
`beforeId` are both absent or both present; a lone one, a `before` that is
not a finite `Date.parse` time, or a `beforeId` that is not a UUID is
**400** `{ "error": "Invalid cursor" }`. `GET /debug/dump` of `api_log` is
the newest 200; the full history is this endpoint. The log never stores
OPTIONS, `/healthz`, the query string, request bodies, or the Authorization
header. Paths pass through `requestLogPath` (`/view/<segment>` →
`/view/:viewKey`). The response is sent without waiting for the insert.
Write failure on the request path logs `api_log.write.failed` and does not
replace the response.

`DEBUG_TOKEN` unset or blank → **Response** `503`:

```json
{ "error": "Debug is not configured" }
```

Missing or non-matching bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

Present `accountId` that is not a UUID → **Response** `400`:

```json
{ "error": "Invalid account" }
```

`before` without `beforeId`, `beforeId` without `before`, a non-date `before`,
or a `beforeId` that is not a UUID → **Response** `400`:

```json
{ "error": "Invalid cursor" }
```

Store failure → **Response** `503`:

```json
{ "error": "Log is unavailable" }
```

Success → **Response** `200`:

```json
{
  "logs": [
    {
      "id": "<uuid>",
      "createdAt": "2026-09-19T15:16:52.530Z",
      "method": "POST",
      "path": "/conversations/<uuid>",
      "status": 200,
      "ms": 8,
      "accountId": "<uuid>",
      "authKind": "session",
      "clientIp": null,
      "clientCountry": null,
      "cfRay": null,
      "userAgent": null,
      "acceptLanguage": null,
      "origin": null
    }
  ],
  "hasMore": false
}
```

`authKind` is `session`, `debug`, `spend`, or `none`. `accountId` is the
session account when `authKind` is `session`; otherwise JSON `null`.
`clientIp`, `clientCountry`, `cfRay`, `userAgent`, `acceptLanguage`, and
`origin` are always present and are JSON `null` when that header is missing
or fails validation. `clientIp` is `CF-Connecting-IP` only when it is an
IPv4 or IPv6 address. `clientCountry` is `CF-IPCountry`, uppercased, when it
is two letters or digits. `cfRay` is `CF-Ray` when it is 16 hex digits, a
hyphen, and three letters. `userAgent` and `acceptLanguage` are those
headers with controls removed and at most 200 characters. `origin` is an
`https` origin, or `http://localhost` or `http://127.0.0.1`, with an
optional port. An empty log returns `"logs": []` and `"hasMore": false`. When `DATABASE_URL` is unset the default
in-memory store starts empty; when set, rows come from Postgres `api_log`.

Environment:

| Variable       | Meaning                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| `DATABASE_URL` | When set, audit rows are stored in Postgres; when unset, in-memory only. |
| `DEBUG_TOKEN`  | Operator bearer for this route. Unset → 503; process still boots.        |

### `POST /diagnostics`

Public ingest of one client diagnostic. No session and no debug bearer.
The body is a JSON object. Any key other than the ones below is rejected.
Required `event` matches `client.` plus 1–60 characters from `a-z`, digits,
and `.`. Optional fields are omitted when absent and rejected when present
but invalid:

- `name` — 1–40 letters (`A-Z` / `a-z`).
- `message` — 1–120 characters from letters, digits, `.`, `_`, `:`, space,
  and `-`. A slash is rejected.
- `prfPresent` — boolean. This is presence only, never the PRF bytes.
- `challengeId` — 64 lowercase hex digits.
- `accountId` — UUID.
- `stage` — `register`, `authenticate`, `seed`, `login`, or `unhandled`.
- `status` — integer from 100 through 599.
- `path` — string. `requestLogPath` rewrites a `/view/<segment>` prefix to
  `/view/:viewKey`. The result is rejected when it contains `?` or 32 or
  more lowercase hex digits (`0-9`, `a-f`) in a row. Uppercase letters are
  not treated as hex.

A valid body is stored as a `client` row and the response is **204** with an
empty body. Rows are kept with no TTL and no DELETE. The stored fields never
include PRF output, the recovery phrase, a session token, a view key, nsec,
Authorization, Cookie, a WebAuthn challenge, attestation, or signatures.
`User-Agent` is not a body field. The server may store it as `userAgent`
after stripping controls and truncating to 200 characters. An empty result
is omitted. The server also stores `clientIp`, `clientCountry`, `cfRay`,
`acceptLanguage`, and `origin` when those request headers validate, using
the same rules as `api_log`. Those names are not body keys. Absent values
are omitted.

Invalid JSON or a field outside the allowlist → **Response** `400`:

```json
{ "error": "Invalid diagnostics" }
```

More than 60 accepted reports from one IP, or 600 globally, in 60 seconds →
**Response** `429`:

```json
{ "error": "Too many diagnostics" }
```

The refused report is not stored. At most one `diagnostics.rate_limited`
server row is written per window. A failed insert does not consume a slot.

Insert failure → **Response** `500`:

```json
{ "error": "Log is unavailable" }
```

When `DATABASE_URL` is set, rows are stored in Postgres `diagnostic_event`.
When unset, the process uses an in-memory store.

### `GET /debug/diagnostics`

Operator listing of diagnostic rows (`diagnostic_event`). Authenticated with
`Authorization: Bearer` matching `DEBUG_TOKEN`. This is not an end-user
session. Rows are newest-first (`createdAt` descending, then `id`), capped
at **200**. `source` is `server` or `client`. `fields` holds allowlisted
scalars only. The same values excluded from `POST /diagnostics` are never
stored. Rows are kept with no TTL and no DELETE.

A `server` row holds the fields as the code passed them, including the
recipient `address` of `spend.ping.ok`, `spend.ping.skipped`,
`spend.ping.failed`, the `invoice.*` events of `POST /invoices`,
`lightning_address.resolved`, and `lightning_address.resolve_failed`. The
JSON line the process prints for the same event does not carry the address.
There `address` is replaced by `addressRef`: the first 12 lower-case hex
characters of HMAC-SHA256 over the lower-cased address, keyed with the
trimmed `SPEND_API_TOKEN`. While `SPEND_API_TOKEN` is unset or blank the line
prints `"address": "[address]"` and no `addressRef`. In every other string
field of the printed line, an email-shaped part (`local@domain.tld`, the `@` literal or written `%40`) is
replaced by `[address]`. The request client fields are printed unchanged.

`DEBUG_TOKEN` unset or blank → **Response** `503`:

```json
{ "error": "Debug is not configured" }
```

Missing or non-matching bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

Store failure → **Response** `503`:

```json
{ "error": "Log is unavailable" }
```

Success → **Response** `200`:

```json
{
  "logs": [
    {
      "id": "<uuid>",
      "createdAt": "2026-09-28T12:22:00.000Z",
      "source": "client",
      "event": "client.passkey.register.begin",
      "fields": { "stage": "register" }
    }
  ]
}
```

An empty log returns `"logs": []`. When `DATABASE_URL` is unset the default
in-memory store starts empty; when set, rows come from Postgres
`diagnostic_event`.

Environment:

| Variable       | Meaning                                                                       |
| -------------- | ----------------------------------------------------------------------------- |
| `DATABASE_URL` | When set, diagnostic rows are stored in Postgres; when unset, in-memory only. |
| `DEBUG_TOKEN`  | Operator bearer for this route. Unset → 503; process still boots.             |

### `GET /debug/contacts`

Operator listing of private in-app contact messages. Authenticated with
`Authorization: Bearer` matching `DEBUG_TOKEN`. This is not an end-user
session. Contacts are never listed on a member-facing route.

`DEBUG_TOKEN` unset or blank → **Response** `503`:

```json
{ "error": "Debug is not configured" }
```

Missing or non-matching bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

Store failure → **Response** `503`:

```json
{ "error": "Contact is unavailable" }
```

Success → **Response** `200`:

```json
{
  "contacts": [
    {
      "id": "<uuid>",
      "accountId": "<uuid>",
      "name": "Ada",
      "text": "Hello",
      "createdAt": "2026-08-29T12:00:00.000Z"
    }
  ]
}
```

Contacts are newest-first (`createdAt` descending, then `id`), capped at
**200**. An empty mailbox returns `"contacts": []`. When `DATABASE_URL` is
unset the default in-memory store starts empty; when set, rows come from
Postgres `contact`.

Environment:

| Variable       | Meaning                                                                |
| -------------- | ---------------------------------------------------------------------- |
| `DATABASE_URL` | When set, contacts are stored in Postgres; when unset, in-memory only. |
| `DEBUG_TOKEN`  | Operator bearer for this route. Unset → 503; process still boots.      |

### `GET /debug/invoices`

Operator listing of all `message_invoice` attempts (forum
`POST /messages/:id/invoice` and conversation `POST /conversations/:id/invoice`).
Authenticated with `Authorization: Bearer` matching `DEBUG_TOKEN`. This is not
an end-user session.

`DEBUG_TOKEN` unset or blank → **Response** `503`:

```json
{ "error": "Debug is not configured" }
```

Missing or non-matching bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

Store failure → **Response** `503`:

```json
{ "error": "Messages are unavailable" }
```

Success → **Response** `200`:

```json
{
  "invoices": [
    {
      "id": "<uuid>",
      "createdAt": "2026-08-30T12:00:00.000Z",
      "messageId": "<uuid>",
      "payerAccountId": "<uuid>",
      "authorAccountId": "<uuid>",
      "amountSats": 21,
      "lightningAddress": "ada@21.gifts",
      "zapRequest": { "kind": 9734 },
      "result": "ok",
      "httpStatus": 200,
      "pr": "lnbc21n1...",
      "paymentHash": "<64-hex>",
      "description": null,
      "descriptionHash": "<64-hex>",
      "isNip57Invoice": true,
      "lnurlResponse": { "pr": "lnbc21n1...", "status": "OK" },
      "conversationId": null,
      "conversationMessageId": null,
      "fiatPinned": false,
      "amountUsd": null,
      "amountChf": null,
      "amountEur": null,
      "amountPhp": null
    }
  ]
}
```

`lnurlResponse` is the raw LNURL callback JSON object, or `null` when none
was stored. Rows are newest-first, capped at **200**. Never includes nsec.
`serializeInvoice` includes `conversationId` and `conversationMessageId`
(`null` on forum invoices), plus `fiatPinned` and `amountUsd`, `amountChf`,
`amountEur`, and `amountPhp` (`null` when unset).
`result` is one of `ok`, `noZap`, `not_zap`, `unreachable`, `no_event`,
`no_author`, `no_key`,
`sign_failed`, `rate_limited`, `bad_body`, `not_found`, `self_heart`,
`self_reply`, `heart_unavailable`. `isNip57Invoice` is
true only when `descriptionHash` equals SHA-256 of the zap-request JSON string
(serialised with NIP-01 field order `id, pubkey, created_at, kind, tags,
content, sig`) sent as LNURL `nostr=`. Failure rows have `pr` null and
`isNip57Invoice` false, except `not_zap` which stores the rejected BOLT11
(`pr` set, `isNip57Invoice` false). When `DATABASE_URL` is unset the in-memory
store starts empty.

Environment:

| Variable       | Meaning                                                           |
| -------------- | ----------------------------------------------------------------- |
| `DATABASE_URL` | When set, attempts are stored in Postgres `message_invoice`.      |
| `DEBUG_TOKEN`  | Operator bearer for this route. Unset → 503; process still boots. |

### `POST /debug/invoices/settle`

Operator-only manual settlement for a successful member-created forum invoice
whose LNURL provider never published its NIP-57 receipt. It does not attribute
or entitle an external payer. The request body is:

```json
{
  "paymentHash": "<64-hex>",
  "note": "Wallet history checked by operator",
  "preimage": "<optional 64-hex>"
}
```

`paymentHash` and `note` are required strings. `note` is trimmed and must be
1–8000 characters without C0/DEL controls. `preimage` must be absent or a
string; when present it must be 32-byte hex whose SHA-256 equals
`paymentHash`. The optional proof reflects production wallet behaviour:
wallet-internal payments can display a “preimage” that does not hash to the
invoice. In that case the matching `DEBUG_TOKEN` plus the durable operator
note is the settlement authority.

Success → **Response** `200` (never includes the note or preimage):

```json
{
  "receiptId": "<64-hex synthetic event id>",
  "messageId": "<uuid>",
  "amountSats": 210000,
  "resumed": false
}
```

The route claims the payment hash, credits the message once, and directly
persists an indexed synthetic kind:9735 ingest with `manual=debug-settle` and
the note (plus `preimage` only when it was supplied and verified). On a member
note it then fans out `notifyZap` and inserts the payer gift-reply from the
original zap request. On the official platform profile note it skips
`notifyZap` and treats the zap comment as a compose post/reply (`sats` 0)
gated by `forum.post` only (`DEBUG_TOKEN` settle does not pass `postLimiter`;
limiter denial applies to worker ingest that shares the `POST /messages`
limiter). Missing `forum.post` fields dequeue the receipt without creating a row.
A created top-level post fans out `notifyForumPost` and `spendPing` only
when `eligibleToday` (same gate as `POST /messages`; ineligible logs
`spend.ping.skipped` / `not_eligible`), a reply fans out `notifyForumReply`. If credit succeeded but the ingest write failed, that
failure returns 503; a retry writes the missing ingest from the current
request, runs the post-credit effects, returns `resumed: true`, and does not
credit again. Fresh success returns `resumed: false`.

The durable payment-hash claim prevents a later real receipt, an ingest-write
failure, or message deletion from allowing another credit. A later real
receipt is persisted as `rejected` / `settled`. A payment hash already owned by
another receipt or represented by any indexed ingest cannot be settled
manually. If payer lookup throws after credit, the route still succeeds: it
logs the gift-reply failure, omits payer fields from the notification, and
skips the gift-reply. Note-author lookup runs **before** `claimZapPayment`;
a throw there fails the settle with no claim, receipt, or ingest.

Failures:

- malformed JSON/body field types → `400 { "error": "Invalid body" }`
- malformed payment hash or supplied preimage → `400 { "error": "Invalid payment hash or preimage" }`
- invalid note → `400 { "error": "Invalid note" }`
- supplied preimage/hash mismatch → `400 { "error": "Preimage does not match payment hash" }`
- no usable successful invoice → `404 { "error": "Invoice not found" }`
- conversation invoice → `409 { "error": "Conversation invoices cannot be settled" }`
- missing/hidden target message → `404 { "error": "Message not found" }`
- already indexed/settled payment → `409 { "error": "Already settled" }`
- store failure, including the direct ingest write, or a thrown note-author lookup → `503 { "error": "Messages are unavailable" }`

`DEBUG_TOKEN` unset/blank returns 503; a missing or bad Bearer returns 401.
The payment-hash claim and credit are not one transaction, but the claim
table's primary key serialises competing receipt ids and remains as the
payment's tombstone.

### `GET /debug/zap-ingests`

Operator listing of kind:9735 ingest decisions (`indexed` or `rejected`).
Authenticated with `Authorization: Bearer` matching `DEBUG_TOKEN`. This is not
an end-user session.

`DEBUG_TOKEN` unset or blank → **Response** `503`:

```json
{ "error": "Debug is not configured" }
```

Missing or non-matching bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

Store failure → **Response** `503`:

```json
{ "error": "Messages are unavailable" }
```

Success → **Response** `200`:

```json
{
  "ingests": [
    {
      "id": "<uuid>",
      "createdAt": "2026-08-30T12:00:00.000Z",
      "receiptId": "<64-hex>",
      "noteEventId": "<64-hex>",
      "messageId": "<uuid>",
      "outcome": "indexed",
      "reason": null,
      "amountSats": 21,
      "receiptPubkey": "<64-hex>",
      "receipt": { "id": "<64-hex>", "kind": 9735 }
    }
  ]
}
```

Rows are newest-first, capped at **200**. Never includes nsec. When
`DATABASE_URL` is unset the in-memory store starts empty.

Environment:

| Variable       | Meaning                                                           |
| -------------- | ----------------------------------------------------------------- |
| `DATABASE_URL` | When set, ingest rows are stored in Postgres `nostr_zap_ingest`.  |
| `DEBUG_TOKEN`  | Operator bearer for this route. Unset → 503; process still boots. |

### `GET /debug/messages`

Operator listing of every persisted forum row (top-level **and** replies,
live **and** soft-hidden). Authenticated with `Authorization: Bearer`
matching `DEBUG_TOKEN`. Public hide does not apply. Cap 200, newest-first.
JSON `{ "messages": [ … ] }` via `serializeDebugMessage`, including
`nostrEvent`, `claimedUntil`, `contentFp`, photo MIME/byte lengths,
stored `goalSats` (JSON `null` when unset), `goalRepayable: true` only when
the stored column is true (omitted when null; never false), `goalTermDays`
only when the stored column is not null (omitted when null), `goalCurrency`,
`goalAmount`, and the four `goalAmount*` snapshots when `goalCurrency` is
stored (omitted on a legacy row; a snapshot may be null), and always-present
`placeLat`, `placeLng`, `placeLabel`, `placeStreet`, `placeHouseNumber`,
`placePostalCode`, `placeCity`, `placeCountry`, and `shopAccountId`
(JSON `null` when unset). Never
includes nsec or photo/video payloads.

`DEBUG_TOKEN` unset or blank → **Response** `503`:

```json
{ "error": "Debug is not configured" }
```

Missing or non-matching bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

Store throw → **Response** `503`:

```json
{ "error": "Messages are unavailable" }
```

### `GET /debug/messages/:id`

Operator single-note fetch. Soft-hidden rows are **200** with `deletedAt` /
`deletedBy` / `text`. Unknown or non-UUID id → **Response** `404`:

```json
{ "error": "Not found" }
```

Same debug token gate as `GET /debug/messages`. Body is the debug object
(not wrapped), including `nostrEvent`, `claimedUntil`, `contentFp`, photo
MIME/byte lengths, stored `goalSats` (JSON `null` when unset),
`goalRepayable: true` only when the stored column is true (omitted when null;
never false), `goalTermDays` only when the stored column is not null (omitted
when null), `goalCurrency`, `goalAmount`, and the four `goalAmount*`
snapshots when `goalCurrency` is stored (omitted on a legacy row; a snapshot
may be null), and always-present `placeLat`, `placeLng`, `placeLabel`,
`placeStreet`, `placeHouseNumber`, `placePostalCode`, `placeCity`,
`placeCountry`, and `shopAccountId` (JSON `null` when unset). Never
includes nsec or photo/video payloads.

Store throw → **Response** `503`:

```json
{ "error": "Messages are unavailable" }
```

### `GET /debug/messages/:id/photo`

Operator JPEG/PNG/WebP bytes, **including** soft-hidden notes. Same
`Content-Type` / `Content-Disposition` / CORS as public
`GET /messages/:id/photo`. Missing row, no photo, or non-UUID id →
**Response** `404`:

```json
{ "error": "Photo not found" }
```

Same debug token gate as `GET /debug/messages`.

Store throw → **Response** `503`:

```json
{ "error": "Messages are unavailable" }
```

### `GET /debug/messages/:id/photo/1.jpg`

Operator extra still (indices 1–9), including `.jpeg` / `.png` / `.webp`.
Same debug token gate as `GET /debug/messages/:id/photo`. Soft-hidden
rows with an extra still are **200**. Missing extra, missing row,
non-UUID id, or a file that does not match
`^([1-9])\.(jpg|jpeg|png|webp)$` → **Response** `404`:

```json
{ "error": "Photo not found" }
```

### `PUT /debug/messages/:id/video`

Operator restore of missing forum-video bytes for an **existing**
`hasVideo` row. Authenticated with `Authorization: Bearer` matching
`DEBUG_TOKEN`. This is not an end-user session. The raw body is
`decodeForumVideo`'d and written under `MEDIA_DIR`; the handler does
not insert a message row or change columns.

`DEBUG_TOKEN` unset or blank → **Response** `503`:

```json
{ "error": "Debug is not configured" }
```

Missing or non-matching bearer → **Response** `401` (checked before the
body is read):

```json
{ "error": "Unauthorized" }
```

Non-UUID or unknown id → **Response** `404`:

```json
{ "error": "Not found" }
```

Row has no video, or stored MIME missing → **Response** `409`:

```json
{ "error": "Message has no video" }
```

Decoded type extension does not match the stored MIME → **Response**
`409`:

```json
{ "error": "Video type does not match" }
```

Empty, oversize, or unrecognized bytes → **Response** `400`:

```json
{ "error": "Expected a video body" }
```

Store or disk write throws → **Response** `503`:

```json
{ "error": "Messages are unavailable" }
```

Success → **Response** `204` with an empty body. Public
`GET /messages/:id/video.mp4` (or `.mov` / `.webm` matching the stored
type) can then serve the file.

Environment:

| Variable      | Meaning                                                           |
| ------------- | ----------------------------------------------------------------- |
| `DEBUG_TOKEN` | Operator bearer for this route. Unset → 503; process still boots. |
| `MEDIA_DIR`   | Directory the bytes are written to. Required at boot.             |

### `POST /debug/messages/:id/restore`

Operator unhide of a soft-hidden forum note. Authenticated with
`Authorization: Bearer` matching `DEBUG_TOKEN`. This is not an end-user
session and not a moderator UNHIDE. Calls `markUndeleted`: the
inverse of `markDeleted`'s cascade (clears `deletedAt` / `deletedBy` on
the hidden target and stamp-matched **direct** children; already-live
target is a no-op for children). Does not recreate the row via
`POST /messages`, does not `DELETE FROM message`, and does not unlink
media, invoices, zap receipts, Nostr, text, or photo. It also removes a
pubkey block whose `message_id` is this restored id. Restoring a different row
hidden by that block's external-author cascade makes that row visible again but
does not remove the block; the pubkey stays blocked and its new gift-replies
and inbound replies keep being rejected. Restoring the original
block-triggering row removes the block but does not automatically unhide rows
hidden by its cascade. Those rows are restored individually.

Same debug token gate as `GET /debug/messages`.

`DEBUG_TOKEN` unset or blank → **Response** `503`:

```json
{ "error": "Debug is not configured" }
```

Missing or non-matching bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

Non-UUID or unknown id → **Response** `404`:

```json
{ "error": "Not found" }
```

Store throw → **Response** `503`:

```json
{ "error": "Messages are unavailable" }
```

Success (hidden or already-live existing id) → **Response** `204` with an
empty body. Public `GET /messages/:id` can then serve the note. Logs
`debug.messages.restored` with `{ messageId }` only (never text, never
`deletedBy`). Store throw logs `debug.messages.restore_failed`. Used by
`gifts-debug restore`.

### `GET /debug/external-pubkeys`

Operator inspection of external Nostr identities. Authenticated with
`Authorization: Bearer` matching `DEBUG_TOKEN`, using the same unset/blank
**503** and missing/mismatched bearer **401** semantics as the other debug
routes. This is the only HTTP response that intentionally exposes these
external pubkeys.

Returns **200** `{ "zappers": [ … ], "blocked": [ … ] }`. `zappers` rows are
`{ pubkey, receiptEventId, createdAt }`; `blocked` rows are
`{ pubkey, blockedAt, blockedBy, messageId }`. Each list is independently
newest-first and capped at 200; equal timestamps are ordered by `pubkey`
descending in both the in-memory and Postgres stores. Store failure returns **503**
`{ "error": "External pubkeys are unavailable" }`. The operator helper is
`gifts-debug external-pubkeys [--raw]`.

### `GET /push/vapid-public`

Bearer session. Returns the VAPID **public** key the browser needs for
`pushManager.subscribe`. Missing VAPID env → **503** after session check
(the process still boots). No cookies.

No/invalid session → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

VAPID not configured → **Response** `503`:

```json
{ "error": "Push is not configured" }
```

Success → **Response** `200`:

```json
{ "publicKey": "<url-safe-base64>" }
```

### `POST /me/push-subscriptions`

Bearer session. Upserts a browser PushSubscription for the account
(`endpoint` unique; rebinds if another account held it) and binds it to the
bearer session of this request (a re-POST from another session rebinds it).
Notifications reach the endpoint only while that session is valid. Once the
session expires, is removed, or its account is refused sessions, the push
worker deletes the subscription instead of sending to it.

No/invalid session → **401** `{ "error": "Unauthorized" }`.
VAPID not configured → **503** `{ "error": "Push is not configured" }`.
Invalid body (`endpoint` not an https URL, or missing `keys.p256dh` /
`keys.auth`) → **400** `{ "error": "Invalid subscription" }`.

Success → **Response** `200`:

```json
{ "endpoint": "https://push.example/device", "createdAt": "2026-08-30T12:00:00.000Z" }
```

### `DELETE /me/push-subscriptions`

Bearer session. Body `{ "endpoint": "https://…" }`. Removes that device
for this account only.

No/invalid session → **401**. VAPID not configured → **503**. Missing or
blank `endpoint` → **400** `{ "error": "Invalid subscription" }`. Unknown
endpoint for this account → **404** `{ "error": "Not found" }`.

Success → **Response** `200`:

```json
{ "ok": true }
```

### `POST /me/wallet/report`

Bearer required. The app sends this after each successful wallet sync while
the member is signed in, at least after login, after a payment, and every few
minutes while the app is open. The first report after install sends the
whole payment history in pages of at most 200; later reports send only
payments the api has not acknowledged yet.

**Request** (`Content-Type: application/json`, at most 1 MiB):

```json
{
  "balanceSats": 12345,
  "syncedAt": "2026-10-07T08:00:00.000Z",
  "payments": [
    {
      "id": "sdk-payment-id",
      "direction": "out",
      "status": "completed",
      "amountSats": 21,
      "feeSats": 0,
      "timestamp": 1791360000,
      "method": "lightning",
      "paymentHash": "<64 hex>",
      "invoice": "lnbc… | spark1…",
      "destination": "alice@21.gifts | domain | Spark address | on-chain address | txid",
      "description": "memo",
      "lnurlComment": "comment"
    }
  ]
}
```

- `balanceSats` (required) and every sat amount: safe integer, `0` to
  `2100000000000000` (21 million BTC).
- `syncedAt` and `timestamp`: ISO-8601 instant string (date, time, and `Z` or a
  numeric offset; a date alone, a locale string, or an impossible calendar
  value such as February 30 is refused, not rolled over), or a number (below `1e11` it is
  epoch seconds, otherwise epoch milliseconds); not before 2009-01-03 and not
  more than 5 minutes in the future.
- `payments` is optional (missing = `[]`), at most 200 entries.
- Per payment, required: `id` (1–256 characters, not secret-shaped), `direction` (`in` / `out`),
  `status` (`pending` / `completed` / `failed`), `amountSats`, `timestamp`,
  `method` (lower-cased, then one word of `[a-z][a-z0-9_]{0,31}`, e.g. `lightning`,
  `spark`, `onchain`, `token`).
  `feeSats` missing or `null` is `0`. A payment that fails a required rule is
  skipped and not acknowledged; the rest of the report is stored.
- Optional detail fields: `paymentHash` (64 hex), `invoice` (≤ 4096),
  `destination` (≤ 512), `description` (≤ 640), `lnurlComment` (≤ 640). A
  value that is missing, too long, holds control characters, or has the shape
  of secret material (a token starting with `nsec1…` or an extended private
  key prefix, or a run of at least 12 consecutive recovery-phrase-shaped words
  in any BIP-39 language (3–9 non-CJK letters, or 1–8 CJK or Hangul characters)
  anywhere in the value) is stored as `null`.
- Every other field is ignored and never stored or logged. A `preimage` is not
  read even when the app sends one; the app does not send it.
- The payment id and every detail field are also screened inside encoded
  tokens: every memo of a Spark address or invoice (each protobuf field on its
  own, repeated and nested fields included at any depth, read leniently so a
  malformed field cannot hide earlier ones; pathological nesting counts as
  secret), every description tag of a BOLT11, the payload
  of any bech32 or bech32m token (read as printable ASCII and as UTF-8), and any WIF private key (Base58Check). A detail field that holds secret
  material there is stored as `null`, and a payment with such an id is skipped,
  so an encoded invoice cannot carry a recovery phrase into storage.
- Screened text is NFC-normalised (so the decomposed form of the official
  wordlists counts) and also read percent-decoded (runs of `%XX` as UTF-8, `+`
  as a space), as in LNURL query strings.
- Limit of the shape screening: it finds key tokens and recovery-phrase word
  runs, also inside canonical encodings (Spark and BOLT11 memos, bech32 and bech32m
  payloads). It is a safety net against accidental exposure (a phrase typed or
  pasted into a memo), not against a client that deliberately obfuscates a
  secret (base64, XOR, protobuf groups, or unusual token boundaries); the
  allow-list and the client contract cover that. A raw 32-byte value (hex or base64) looks exactly like the payment
  hashes, transaction ids, payment ids and NIP-57 zap requests (64-hex keys and
  ids) this route collects, so it is not screened by shape. Such values are
  kept out by the allow-list (secret-named fields are never read) and by the
  app, which never sends a preimage, seed, PRF output or key.

The api stores one row in `wallet_balance_snapshot` per report and upserts
each payment into `wallet_payment` by `(account, id)`. Re-sending a payment
is harmless: status, amounts, method, time, category, and counterparty are
overwritten (so `pending` becomes `completed`), detail fields keep their
stored value when the new report has none, `first_seen_at` (the observation
time of the report that first stored the payment) never changes,
and `updated_at` changes only when a stored value changes. A report observed
before the latest accepted report of that payment (a slower concurrent request,
or a stale second device) does not overwrite it; every accepted report advances
the watermark `last_observed_at`, also when it changes nothing.

**Category** (computed on every insert and update, first match wins; the
reporting account itself never counts as the counterparty):

1. a forum or conversation invoice the api issued (by payment hash, trying the
   field, then the BOLT11, then the `zap:` memo of a Spark invoice) → `gift`, or
   `platform` when the other side is the platform account;
2. a zap receipt the api indexed → `gift` / `platform` the same way;
3. a point-of-sale charge (recorded BOLT11 hash, or the `pos:` memo of a Spark
   invoice) → `shop`;
4. a member of this deployment, by own-host Lightning address
   `<username>@<host of PUBLIC_BASE_URL>`, by the identity key of a Spark
   address or invoice, or by a raw Spark public key → `platform` for the
   platform account, `shop` for a member with a live `#21GiftsShop` note,
   otherwise `member`;
5. otherwise `onchain` (`method` `onchain` / `bitcoin`), `outside_lightning`
   (`method` `lightning` / `bolt11` / `lnurl`, a foreign Lightning address, or
   an `ln…` invoice), or `unknown`.

`counterpartyAccountId` is set whenever one of steps 1–4 resolves an account.
A later report never turns a resolved category (steps 1–4) back into a
fallback one (step 5): a re-send with fewer details keeps the stored category
and counterparty.

**Storage.** `wallet_balance_snapshot` and `wallet_payment` (`docs/schema/wallet.sql`), migrated at boot when `DATABASE_URL` is set and covered by `db_change`; in memory otherwise. A merge deletes a source payment row whose id the surviving account already has, clears a counterparty that is one of the two merged accounts, then moves the rest.

**Response** `200` `{ "acknowledgedIds": ["sdk-payment-id"] }` — every stored
payment id, once each (a later duplicate in the same report wins).

Errors: `401` `{ "error": "Unauthorized" }`; `429` `{ "error": "Too many requests" }`
after 60 reports from one account in 60 seconds; `413`
`{ "error": "Request body is too large" }`; `400`
`{ "error": "Invalid wallet report" }` (bad JSON, bad balance or sync time,
`payments` not an array or longer than 200); `503`
`{ "error": "Wallet data is unavailable" }` when a lookup or write fails
(logs `wallet_report.write.failed` with `{ accountId }` only).

### `POST /me/events`

Bearer required. First-party interaction log, stored only in this api's
database. The app batches events (flush about every 10 seconds and when the
page is hidden). Events before login are not collected.

**Request** (at most 64 KiB): `{ "events": [{ "name", "at", "path", "props" }] }`,
at most 50 events.

- `name`: one of `screen_view`, `post_created`, `reply_created`, `gift_sent`,
  `payment_sent`, `payment_failed`, `payment_received_seen`, `pos_charge_created`,
  `pos_charge_paid_seen`, `search`, `shop_opened`, `profile_opened`, `login`,
  `logout`, `signup_completed`, `wallet_open_failed`, `wallet_tour_shown`, `wallet_tour_step`, `wallet_tour_done`, `wallet_move_opened`, `wallet_move_step`, `wallet_move_copied`, `wallet_move_closed`, `wallet_move_done`, `recovery_done`. `logout` is sent while the session is still
  valid, before the app ends it. `recovery_done` is sent once after a social
  recovery sign-in ([docs/social-recovery.md](docs/social-recovery.md)), with
  no props.
- `at`: same instant rules as `syncedAt` above.
- `path`: optional; cut at the first `?` or `#`; must start with `/`, at most
  256 characters; a path that holds secret material anywhere (as written and with
  runs of `%XX` escapes decoded as UTF-8, a malformed escape not hiding the rest;
  a key token or a recovery-phrase run across segments) drops the event.
- `props`: optional flat object, at most 20 keys; key `[A-Za-z][A-Za-z0-9_]{0,39}`;
  value `null`, boolean, finite number, or string up to 200 characters. Keys
  naming secret material or a credential (seed, mnemonic, phrase, preimage,
  private key, secret, PRF, nsec, password, token, authorization, bearer,
  cookie, credential, session, …) and secret-shaped string values are dropped;
  other invalid keys are dropped too.
  The path and string props are also screened inside encoded tokens, as for the
  wallet report. The same limit as for the wallet report applies: a raw 32-byte value under a
  neutral key is not recognisable by shape (event and payment ids look the
  same); the app never puts secret material into events.

An event that fails a rule is dropped and counted; the rest are stored in
`member_event` with the account and the server receive time.

**Storage.** `member_event` (`docs/schema/member_event.sql`), migrated at boot when `DATABASE_URL` is set and covered by `db_change`; in memory otherwise.

**Response** `200` `{ "accepted": 3, "dropped": 1 }`.

Errors: `401` `{ "error": "Unauthorized" }`; `429` `{ "error": "Too many requests" }`
after 30 batches from one account in 60 seconds; `413`
`{ "error": "Request body is too large" }`; `400` `{ "error": "Invalid events" }`
(bad JSON, `events` not an array, more than 50); `503`
`{ "error": "Log is unavailable" }` when the insert fails.

### `POST /debug/push-ping`

Operator enqueue of a test notification. Authenticated with
`Authorization: Bearer` matching `DEBUG_TOKEN` (not an end-user session).
JSON body `{ "accountId": "<uuid>" }`. Enqueues at most one outbox row
when the account has a stored subscription.

`DEBUG_TOKEN` unset or blank → **503** `{ "error": "Debug is not configured" }`.
Missing or non-matching bearer → **401** `{ "error": "Unauthorized" }`.
VAPID not configured → **503** `{ "error": "Push is not configured" }`.
Missing `accountId` → **400** `{ "error": "Expected a JSON body with an \"accountId\" string" }`.
Unknown account → **404** `{ "error": "Not found" }`.

Success → **Response** `200`:

```json
{ "enqueued": 1 }
```

`enqueued` is `0` when the account has no subscription.

### `POST /debug/push-broadcast`

Operator Web Push broadcast. Authenticated with `Authorization: Bearer`
matching `DEBUG_TOKEN` (not an end-user session). JSON body (no other keys):

```json
{
  "title": "Update",
  "body": "Please log in again.",
  "link": "/welcome",
  "usernames": ["alpha", "bravo"],
  "dryRun": false
}
```

- `title`: 1-64 characters after trim, no C0 control character or DEL.
- `body`: 1-240 characters after trim, no C0 control character other than a
  newline, and no DEL.
- `link` (optional, default `/welcome`): a same-site path of at most 200
  characters: one leading `/`, not `//`, no backslash or whitespace.
- `usernames` (optional): 1-200 usernames. Without it the broadcast targets
  every account with a live push subscription.
- `dryRun` (optional): `true` counts the recipients and queues nothing.

Accounts whose notification level is `none` are not queued (`optedOut`).
A push subscription is live while the session that registered it still
authenticates its account, the same rule the push worker sends by. Listed
accounts without a live subscription are not queued (`noSubscription`), and a
dry run counts only live subscriptions. After every session has ended, a
broadcast reaches no one until members sign in again. Each recipient gets one `push_outbox` row whose
`message_id` is the broadcast id; the push worker delivers it with the same
batch, lease, and retry rules as every other notification. The payload is
`{ "type": "zap", "title", "body", "url": link, "tag": "broadcast:<id>" }`.

`DEBUG_TOKEN` unset or blank → **503** `{ "error": "Debug is not configured" }`.
Missing or non-matching bearer → **401** `{ "error": "Unauthorized" }`.
Invalid body → **400** `{ "error": "Expected a JSON body with \"title\" …" }`.
A listed username without an account → **404**
`{ "error": "No account with that username", "usernames": ["…"] }` (the text
of `GET /accounts/by-username/:username`, plus every unknown username);
nothing is queued.
VAPID not configured and not a dry run → **503** `{ "error": "Push is not configured" }`.

Dry run → **Response** `200`:

```json
{ "dryRun": true, "recipients": 2 }
```

Send → **Response** `202`:

```json
{
  "id": "0b6c3f4e-2a1d-4c5b-9e8f-7a6b5c4d3e2f",
  "targeted": 3,
  "queued": 2,
  "optedOut": 1,
  "noSubscription": 0
}
```

### `GET /debug/push-broadcast/:id`

Operator delivery report of one broadcast, read from its `push_outbox` rows:
the rows whose `message_id` is the broadcast id and whose payload tag is
`broadcast:<id>`. Rows of a forum or conversation message with the same id
are not counted. Same auth errors as `POST /debug/push-broadcast`. An id that
is not a UUID, or that no broadcast row carries (also a broadcast that queued
nothing, or one whose rows the retention removed) → **404**
`{ "error": "Not found" }`.

**Response** `200`:

```json
{
  "id": "0b6c3f4e-2a1d-4c5b-9e8f-7a6b5c4d3e2f",
  "queued": 2,
  "pending": 0,
  "delivered": 1,
  "dropped": 0,
  "failed": 1
}
```

`pending` rows are not finished yet (first try or retry). `delivered` rows
are finished and reached at least one subscription, also when another
subscription of that account failed for good. `dropped` rows were sent to
none because the subscription was removed or gone before the send. `failed`
rows gave up after the retry limit (8 attempts) without reaching any
subscription. Lengths count characters (code points).

### `POST /debug/passkey-renew/reopen`

Operator reopen of the blocking passkey-renew dialog. Authenticated with
`Authorization: Bearer` matching `DEBUG_TOKEN` (not an end-user session).
JSON body `{ "accountId": "<uuid>" }`. Deletes that account's failed
`passkey_renew_attempt` rows, acknowledged or not. Succeeded and cancelled
rows stay. The account row is unchanged. While `walletRequired` is not true,
`passkeyRenewFailed` and `passkeyRenewClosed` are then both false, so the
next signed-in app open starts again at the explanation.

`DEBUG_TOKEN` unset or blank → **503** `{ "error": "Debug is not configured" }`.
Missing or non-matching bearer → **401** `{ "error": "Unauthorized" }`.
Missing, non-string, or non-UUID `accountId` → **400** `{ "error": "Invalid account" }`.
Unknown account → **404** `{ "error": "Not found" }`.
`walletRequired` true → **409** `{ "error": "Account already has a seed" }` and no delete.
The delete is an ordinary `DELETE` on `passkey_renew_attempt`. The existing
`trg_db_change` row trigger records it. This route does not write `db_change` itself.

Success → **Response** `200`:

```json
{ "deleted": 1 }
```

`deleted` is `0` when the account had no failed row.

### `GET /debug/logins`

Operator read of the login switch (see Login controls). Authenticated with `Authorization: Bearer` matching `DEBUG_TOKEN` (not an
end-user session); `DEBUG_READ_TOKEN` is not accepted.

`DEBUG_TOKEN` unset or blank → **503** `{ "error": "Debug is not configured" }`.
Missing or non-matching bearer → **401** `{ "error": "Unauthorized" }`.

Success → **Response** `200`:

```json
{
  "open": false,
  "source": "stored",
  "defaultOpen": true,
  "allowlist": [
    { "accountId": "00000000-0000-4000-8000-000000000001", "createdAt": "2026-06-01T12:00:00.000Z" }
  ]
}
```

`source` is `stored` once `PUT /debug/logins` ran and `default` before that
(then `open` equals `defaultOpen` from `LOGINS_OPEN_DEFAULT`). `allowlist` is
oldest first; `createdAt` is ISO 8601.

### `PUT /debug/logins`

Operator set of the login switch. Authenticated with `Authorization: Bearer` matching `DEBUG_TOKEN` (not an
end-user session); `DEBUG_READ_TOKEN` is not accepted.
JSON body `{ "open": <boolean> }` with no other keys. Stores the value in
`app_setting` (`logins_open`), which wins over `LOGINS_OPEN_DEFAULT` from
then on. Existing sessions are not touched. Logs `debug.logins.set`.

`DEBUG_TOKEN` unset or blank → **503** `{ "error": "Debug is not configured" }`.
Missing or non-matching bearer → **401** `{ "error": "Unauthorized" }`.
Bad JSON, a non-boolean `open`, or another key → **400**
`{ "error": "Expected a JSON body with an \"open\" boolean" }`.

Success → **Response** `200`: the same JSON as `GET /debug/logins`.

### `POST /debug/logins/allowlist`

Operator add of one account to the login allowlist. Authenticated with `Authorization: Bearer` matching `DEBUG_TOKEN` (not an
end-user session); `DEBUG_READ_TOKEN` is not accepted.
JSON body `{ "accountId": "<uuid>" }` with no other keys (any case, stored
lower case). Logs `debug.logins.allowlist.add`.

`DEBUG_TOKEN` unset or blank → **503** `{ "error": "Debug is not configured" }`.
Missing or non-matching bearer → **401** `{ "error": "Unauthorized" }`.
Bad JSON, a missing or non-UUID `accountId`, or another key → **400**
`{ "error": "Expected a JSON body with an \"accountId\" uuid" }`.
Unknown account → **404** `{ "error": "Not found" }`.

Success → **Response** `200`: `{ "added": true, ...GET /debug/logins }`.
`added` is `false` when the account was already listed (its first
`createdAt` stays). Deleting the account removes its row.

### `DELETE /debug/logins/allowlist/:accountId`

Operator removal of one account from the login allowlist. Authenticated with `Authorization: Bearer` matching `DEBUG_TOKEN` (not an
end-user session); `DEBUG_READ_TOKEN` is not accepted.
Does not end the account's sessions. Logs `debug.logins.allowlist.remove`.

`DEBUG_TOKEN` unset or blank → **503** `{ "error": "Debug is not configured" }`.
Missing or non-matching bearer → **401** `{ "error": "Unauthorized" }`.
`:accountId` not a UUID → **404** `{ "error": "Not found" }`.

Success → **Response** `200`: `{ "removed": true, ...GET /debug/logins }`.
`removed` is `false` when the account was not listed.

### `DELETE /debug/sessions`

Operator end of every member session. Authenticated with `Authorization: Bearer` matching `DEBUG_TOKEN` (not an
end-user session); `DEBUG_READ_TOKEN` is not accepted.
Deletes every `auth_session` row in one statement. Every bearer that held one
answers 401 on its next request. The existing `trg_db_change` row trigger
records each deleted row with the token hashed. Logs `debug.sessions.deleted`
with the count.

`DEBUG_TOKEN` unset or blank → **503** `{ "error": "Debug is not configured" }`.
Missing or non-matching bearer → **401** `{ "error": "Unauthorized" }`.

Success → **Response** `200`:

```json
{ "deleted": 12 }
```

`deleted` is `0` when no session existed.

### `GET /gifts`

Public list of outbound gifts for one UTC calendar day. Query `day=YYYY-MM-DD`.
No auth. The body never includes invoices, fees, or wallet identifiers.

Missing, blank, or impossible `day` (`2026-02-31`) → **400**
`{ "error": "Expected a UTC day (YYYY-MM-DD)" }`.

When `DATABASE_URL` is unset the in-memory gift store is empty — **200** with
zeros (`totalUsd` / `totalChf` / `totalEur` / `totalPhp` `"0.00"`), `gifts: []`,
and `fx` with USD-only `quotes` (no Coinbase / Frankfurter). When gifts exist
for that day, the stored payment-time USD/CHF/EUR/PHP is what is returned.
A SQL NULL snapshot is JSON `null` and does not fetch a close. The read does
not price an omitted field from a BTC-USD close. An empty matching set is
200 without Coinbase or Frankfurter. A query failure is **503**. A missing
stored amount is never 503. Each currency is summed from its own stored string.
A missing USD does not discard a stored CHF, EUR, or PHP. One null does not
null the day's other currencies. A currency every listed gift lacks stays null.

**Response** `200` (empty day):

```json
{
  "day": "2026-06-01",
  "giftCount": 0,
  "totalSats": 0,
  "totalBtc": "0.00000000",
  "totalUsd": "0.00",
  "totalChf": "0.00",
  "totalEur": "0.00",
  "totalPhp": "0.00",
  "gifts": [],
  "fx": {
    "quote": "BTC-USD",
    "dayBasis": "utc",
    "source": "coinbase-exchange-daily-close",
    "quotes": [{ "code": "USD", "pair": "BTC-USD", "source": "coinbase-exchange-daily-close" }]
  }
}
```

**Response** `200` (one gift whose stored amounts are those strings):

```json
{
  "day": "2026-06-01",
  "giftCount": 1,
  "totalSats": 1000,
  "totalBtc": "0.00001000",
  "totalUsd": "1.00",
  "totalChf": "0.80",
  "totalEur": "0.90",
  "totalPhp": "50.00",
  "gifts": [
    {
      "paidAt": "2026-06-01T12:00:00.000Z",
      "amountSats": 1000,
      "amountBtc": "0.00001000",
      "amountUsd": "1.00",
      "amountChf": "0.80",
      "amountEur": "0.90",
      "amountPhp": "50.00",
      "recipient": "alice"
    }
  ],
  "fx": {
    "quote": "BTC-USD",
    "dayBasis": "utc",
    "source": "coinbase-exchange-daily-close",
    "quotes": [{ "code": "USD", "pair": "BTC-USD", "source": "coinbase-exchange-daily-close" }]
  }
}
```

`fx.quotes` on this route stays USD-only. The fiat book is not the amount.

| Field       | Type                                                                                         | Meaning                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `day`       | string                                                                                       | UTC `YYYY-MM-DD` of the query                                                                                             |
| `giftCount` | number                                                                                       | Number of gifts that UTC day                                                                                              |
| `totalSats` | number                                                                                       | Sum of gift amounts (sats; fees excluded)                                                                                 |
| `totalBtc`  | string                                                                                       | `totalSats` as BTC with eight decimals                                                                                    |
| `totalUsd`  | string or null                                                                               | Sum of stored USD strings (`"1.00"`); `"0.00"` when the day is empty; `null` only when every listed gift lacks stored USD |
| `totalChf`  | string or null                                                                               | Sum of stored CHF strings; `"0.00"` when the day is empty; `null` only when every listed gift lacks stored CHF            |
| `totalEur`  | string or null                                                                               | Sum of stored EUR strings; `"0.00"` when the day is empty; `null` only when every listed gift lacks stored EUR            |
| `totalPhp`  | string or null                                                                               | Sum of stored PHP strings; `"0.00"` when the day is empty; `null` only when every listed gift lacks stored PHP            |
| `gifts`     | `{ paidAt, amountSats, amountBtc, amountUsd, amountChf, amountEur, amountPhp, recipient }[]` | Ordered by `paidAt` ascending, then `recipient`                                                                           |
| `fx`        | `{ quote, dayBasis, source, quotes }`                                                        | Always present; `quote` is BTC-USD; `quotes` is USD only                                                                  |

`gifts[]` item:

| Field        | Type           | Meaning                                         |
| ------------ | -------------- | ----------------------------------------------- |
| `paidAt`     | string         | ISO-8601 instant (`toISOString`, UTC `Z`)       |
| `amountSats` | number         | Gift amount in sats                             |
| `amountBtc`  | string         | Same amount as BTC with eight decimals          |
| `amountUsd`  | string or null | Stored payment-time USD (`"1.00"`), or `null`   |
| `amountChf`  | string or null | Stored payment-time CHF, or `null` when missing |
| `amountEur`  | string or null | Stored payment-time EUR, or `null` when missing |
| `amountPhp`  | string or null | Stored payment-time PHP, or `null` when missing |
| `recipient`  | string         | Recipient handle (`recipient_wos_user`)         |

**Response** `503`: `{ "error": "Gift stats are unavailable" }` (store failure only; a missing stored amount is never 503).

### `GET /fx/spot`

Public current price of 1 BTC in USD, CHF, EUR, and PHP. No auth. It is
independent of gifts: it does not read `gift`.
`GET /gifts/stats`. Gift stats are stored strings and do not read the daily rate books.

A background worker fetches one Coinbase response with every pair
(`BTC_FIAT_SPOT_URL`, default
`https://api.coinbase.com/v2/exchange-rates?currency=BTC`, aborted after
10 seconds) at boot and then every 5 minutes, and stores the result in
`btc_fiat_spot` (one row; in memory when `DATABASE_URL` is unset). A write
with an earlier `asOf` than the stored quote is skipped, so several replicas
that refresh the same row cannot move it backwards; a stored `asOf` in the
future of the database clock is always replaced, so a replica with a fast clock
cannot block newer quotes. A request
only reads that stored quote and never calls the provider. A failed fetch
keeps the last good quote, so during a provider outage the route keeps serving
it with its original `asOf`. With `DATABASE_URL` set this also holds after a
restart; the in-memory store starts empty and has no quote until its first
successful fetch.

**Response** `200` with a quote, `Cache-Control: public, max-age=60`:

```json
{
  "asOf": "2026-10-07T12:00:00.000Z",
  "source": "coinbase-exchange-rates",
  "rates": { "USD": "62345.12", "CHF": "55000.5", "EUR": "57000", "PHP": "3500000.12" }
}
```

| Field    | Type   | Meaning                                                                               |
| -------- | ------ | ------------------------------------------------------------------------------------- |
| `asOf`   | string | ISO-8601 time the stored quote was fetched                                            |
| `source` | string | Provider tag (`coinbase-exchange-rates`)                                              |
| `rates`  | object | Fiat per 1 BTC as decimal text at provider precision; keys `USD`, `CHF`, `EUR`, `PHP` |

A currency without a usable quote (missing, not decimal text, or not
positive) is **omitted** from `rates`, never `null` or `"0"`. Every stored
refresh replaces the whole quote (an older one is skipped, see above), so all
present rates share one `asOf`.

**Response** `200` without a quote (never fetched, or the store failed;
`fx.spot.read_failed` is logged), `Cache-Control: no-store`:

```json
{ "asOf": null, "source": null, "rates": {} }
```

The app treats `asOf: null` (equivalently an empty `rates`) as "no rate".
This route has no error status. The response shape is stable.

### `GET /gifts/stats`

Public aggregated outbound gift statistics. No auth. The body never includes
invoices, fees, or wallet identifiers.

When `DATABASE_URL` is unset the in-memory gift and FX stores are empty —
**200** with zeros, empty series, `totalBtc` `"0.00000000"`, `totalUsd` /
`totalChf` / `totalEur` / `totalPhp` `"0.00"`, and `fx` with USD-only
`quotes` (no Coinbase / Frankfurter call). When it is set, the process
queries the `gift` table (`paid_at`, `amount_sats`, `recipient_wos_user`,
and the stored payment-time fiat columns) and returns that stored
USD/CHF/EUR/PHP (not recomputed from the day's close). A SQL NULL snapshot
is JSON `null` and does not fetch a close. The read does not price an omitted
field from `btc_usd_daily` or `usd_fiat_daily`. Each currency is summed from
its own stored string. A missing USD does not discard a stored CHF, EUR, or
PHP. One null does not null the day, the other currencies, or a later
cumulative. A day where every row lacks that currency is null. Gap days in
`spendOverTime` are zero `giftCount`/sats/BTC and `"0.00"` fiat, and they do
not change a running cumulative. Gap months in `byMonth` are zero sats/BTC and
`"0.00"` fiat. An empty selection stays zeros.
A query failure is **503**. A missing stored amount is never 503.

Optional query `recipient` filters to one recipient handle (the local part
of the receiving address)
(case-insensitive). The value is trimmed first. When the trimmed value
contains `@` after the first character, the local-part before `@` is used;
otherwise the whole trimmed string is the handle. Missing or blank
(after trim) `recipient` is unfiltered.
An unknown handle is empty **200** (zeros, USD-only `fx.quotes`) without a
Coinbase or Frankfurter call. The rate books are not read.

**Response** `200`:

```json
{
  "totalSats": 0,
  "totalBtc": "0.00000000",
  "totalUsd": "0.00",
  "totalChf": "0.00",
  "totalEur": "0.00",
  "totalPhp": "0.00",
  "giftCount": 0,
  "recipientCount": 0,
  "firstPaidAt": null,
  "lastPaidAt": null,
  "spendOverTime": [],
  "byRecipient": [],
  "byMonth": [],
  "fx": {
    "quote": "BTC-USD",
    "dayBasis": "utc",
    "source": "coinbase-exchange-daily-close",
    "quotes": [{ "code": "USD", "pair": "BTC-USD", "source": "coinbase-exchange-daily-close" }]
  }
}
```

| Field            | Type                                                                                                                                             | Meaning                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `totalSats`      | number                                                                                                                                           | Sum of gift amounts (sats; fees excluded)                                                                                             |
| `totalBtc`       | string                                                                                                                                           | `totalSats` as BTC with eight decimals                                                                                                |
| `totalUsd`       | string or null                                                                                                                                   | Sum of stored USD strings (`"1234.56"`); `"0.00"` when the selection is empty; `null` only when every selected gift lacks stored USD  |
| `totalChf`       | string or null                                                                                                                                   | Sum of stored CHF strings; `"0.00"` when the selection is empty; `null` only when every selected gift lacks stored CHF                |
| `totalEur`       | string or null                                                                                                                                   | Sum of stored EUR strings; `"0.00"` when the selection is empty; `null` only when every selected gift lacks stored EUR                |
| `totalPhp`       | string or null                                                                                                                                   | Sum of stored PHP strings; `"0.00"` when the selection is empty; `null` only when every selected gift lacks stored PHP                |
| `giftCount`      | number                                                                                                                                           | Number of outbound gifts                                                                                                              |
| `recipientCount` | number                                                                                                                                           | Distinct recipient handles                                                                                                            |
| `firstPaidAt`    | string or null                                                                                                                                   | ISO-8601 of the earliest gift                                                                                                         |
| `lastPaidAt`     | string or null                                                                                                                                   | ISO-8601 of the latest gift                                                                                                           |
| `spendOverTime`  | `{ day, giftCount, sats, cumulativeSats, btc, cumulativeBtc, usd, cumulativeUsd, chf, cumulativeChf, eur, cumulativeEur, php, cumulativePhp }[]` | UTC days from first through last; `giftCount` is outbound gifts that day; gaps are zero count/sats/BTC/USD and `"0.00"` fiat          |
| `byRecipient`    | `{ recipient, giftCount, sats, btc, usd, chf, eur, php }[]`                                                                                      | Sorted by sats descending, then name; each fiat field sums stored strings and is `null` only when no gift to that recipient stored it |
| `byMonth`        | `{ month, giftCount, sats, btc, usd, chf, eur, php }[]`                                                                                          | UTC YYYY-MM from first through last; gaps are zero sats/BTC/USD and `"0.00"` fiat                                                     |
| `fx`             | `{ quote, dayBasis, source, quotes }`                                                                                                            | Always present; `quote` is BTC-USD; `quotes` is USD only                                                                              |

**Response** `503`:

```json
{ "error": "Gift stats are unavailable" }
```

503 is a store failure only. A missing stored amount is JSON
`null`, never 503.

### `GET /invoices/passkey`

Spend-worker eligibility check. Query `address=name@domain.tld`. Same
`SPEND_API_TOKEN` Bearer as `POST /invoices` (503 unconfigured / 401
unauthorized).

The address is matched only as a member's wallet-backed
`<username>@<host of PUBLIC_BASE_URL>` (trimmed, case-insensitive, verified
wallet; see [Receiving address](#receiving-address)). Any other domain, a
member without a verified wallet, or the LNURL server being off is treated as
no account for the address.

Missing or invalid Lightning Address → **400**
`{ "error": "Not a valid Lightning Address (expected name@domain)" }`.

Success is always **200** (never 404 for an unknown address):

```json
{ "hasPasskey": true }
```

or `{ "hasPasskey": false }` when there is no account for the address or the
account has no passkey credential.

### `GET /invoices/eligible`

Spend-worker funding-grant check. Query `address=name@domain.tld`. Same
`SPEND_API_TOKEN` Bearer as `GET /invoices/passkey` (503 unconfigured /
401 unauthorized / 400 invalid address).

The address is matched only as a member's wallet-backed
`<username>@<host of PUBLIC_BASE_URL>` (trimmed, case-insensitive, verified
wallet; see [Receiving address](#receiving-address)). Any other domain, a
member without a verified wallet, or the LNURL server being off is treated as
no account for the address.

Success is always **200** (never 404 for an unknown address):

```json
{ "eligible": true, "status": "admitted" }
```

`status` is `effectiveStatus`: `none`, `pending`, `trial`, `admitted`, or
`rejected`. Unknown address and `basis` are always
`{ "eligible": false, "status": "none" }` with no grant lookup. Until UTC
2026-10-01 a missing/pending/rejected grant on a non-`basis` account is
`eligible: true` with `status` still from `effectiveStatus`; from that day
`eligible` is false unless admitted or trial-today **and** a 21.gifts
recovery share is stored for the member's current verified wallet
([docs/social-recovery.md](docs/social-recovery.md)). A member in the grant
program without that share is `{ "eligible": false, "status": "admitted" }`
(or `"trial"`): `status` stays the effective grant status.

### `GET /invoices/posted`

Spend-worker eligibility check. Query `address=name@domain.tld`. Same
`SPEND_API_TOKEN` Bearer as `POST /invoices` (503 unconfigured / 401
unauthorized).

The address is matched only as a member's wallet-backed
`<username>@<host of PUBLIC_BASE_URL>` (trimmed, case-insensitive, verified
wallet; see [Receiving address](#receiving-address)). Any other domain, a
member without a verified wallet, or the LNURL server being off is treated as
no account for the address.

Missing or invalid Lightning Address → **400**
`{ "error": "Not a valid Lightning Address (expected name@domain)" }`.

Success is always **200** (never 404 for an unknown address):

```json
{
  "hasPosted": true,
  "messageId": "<uuid>",
  "postedAt": "<iso-8601>",
  "hasMedia": false,
  "welcomeHasMedia": false,
  "welcomeMessageId": null
}
```

or `{ "hasPosted": false, "messageId": null, "postedAt": null, "hasMedia": false, "welcomeHasMedia": false, "welcomeMessageId": null }` when there is no account for the
address, or the account has no live top-level note other than a text-only profile note.
`hasPosted` is still any live top-level note that is not the profile note, including text-only.
A profile note that has a photo or video keeps `hasPosted: false` and sets `welcomeHasMedia: true` with that note as `welcomeMessageId`. An account that already received the welcome gift (a platform `Welcome` reply under one of its notes (live or hidden), or a recorded `welcome` gift with description `21gifts welcome` under its username at or after its wallet verification) reports `welcomeHasMedia: false` and `welcomeMessageId: null`. Replies do not count. Photo-only / empty-text
top-level notes still count for `hasPosted`. `hasMedia` is true only when such a
post has photo 0, extra stills, or video. `welcomeHasMedia` is true when any live top-level photo or video exists, including the About-me note, even when `hasPosted` is false. `welcomeMessageId` is that newest note's id, or null. When `hasPosted` is true, `messageId` is usually
the newest live top-level non-profile post id; it can still be `null` if
`listPostsByAccount` yields no non-profile row. `postedAt` is that row's
`createdAt` (ISO-8601) or `null` when `messageId` is null. Replies and the auto profile
note never become `messageId`. A text-only newest row can still pair with
`hasMedia: true` when an older live top-level media post exists.

### `POST /invoices`

Spend-worker invoice fetch. After address and amount validation, the api
requires a 21.gifts member whose wallet-backed address is `address`
(`<username>@<host of PUBLIC_BASE_URL>`, case-insensitive, verified wallet;
any other domain or no verified wallet is **403** `Passkey required`) that
already has a passkey
credential and `eligibleToday` (grant required from UTC 2026-10-01, and
with it a 21.gifts recovery share for the current verified wallet).
When `messageId` is omitted, it also requires at least one live **top-level**
forum message that is not the auto-created profile note. When `messageId` is
set, that note must be this address's live top-level note, including About me,
and have a photo or video. Replies do not unlock an invoice. It then resolves
the canonical lower-case wallet address through the internal LNURL-server
resolver (`lnurlServerFetch`; never over the public URL), GETs the LNURL-pay
callback, decodes the BOLT11, and stores `{ id, pr, paymentHash }` in memory
under that address. It does not pay.

**Body:**

```json
{
  "address": "ada@21.gifts",
  "amountMsat": 100000,
  "amountUsd": "5.00",
  "comment": "optional",
  "messageId": "<uuid>"
}
```

Moderator stipend form (never together with `messageId`):

```json
{
  "address": "ada@21.gifts",
  "amountMsat": 100000,
  "amountUsd": "5.00",
  "comment": "optional",
  "groupMessageId": "<uuid>"
}
```

`amountUsd` is optional. When present it is a positive decimal with at most
two fractional digits and at most 100000, normalized to two decimals (`"5"`
becomes `"5.00"`) and stored as that payment's USD. A present value that
cannot be normalized is the same **400** as a bad body. An absent key stays
unset and proof stores null for USD, CHF, EUR, and PHP. `comment` is optional and at most 255 characters. `amountMsat` must be an
integer in `1000..10000000000`. `messageId` is optional (current spend without
the field still works). `groupMessageId` is optional and mutually exclusive
with `messageId` (both set → **400**). Invalid UUID on either field → **400**
`{ "error": "Expected a JSON body with address and amountMsat" }`. When
`messageId` is set, the post must be that address's live top-level note,
including the About-me profile note, **and** have a photo or video (else
**403** `Forum post required` before LNURL). A text-only profile note stays
**403**. Omitted `messageId` stays any live top-level non-profile post (no
media requirement). Missing
`isPlatform` account → **503** `{ "error": "Platform account is not configured" }`
(no LNURL). With `comment` exactly `Welcome` (with or without `messageId`),
an account that already received the welcome gift (a platform `Welcome`
reply under one of its notes, live or hidden, or a recorded `welcome` gift with description `21gifts welcome`
under its username at or after its wallet verification) → **409** `{ "error": "Welcome gift already paid" }`
after the passkey and grant checks and before LNURL (with `groupMessageId`,
after that id is resolved: a resolved moderator payout is recorded as
`moderator` and is not refused; an ignored id is); the welcome gift is once
per account, whichever address it went to. Stores `comment` on the invoice whenever it is sent, so a `Welcome` invoice without `messageId` is still recorded as a welcome gift on proof; with `messageId` it stores `messageId` and `comment` (or `''`).
When `groupMessageId` is set (no `messageId`), the living-room post gate
still applies. The id is display-only: it is stored only when it is that
address's message in the closed `moderator_group` thread and an
`isPlatform` account exists; otherwise the invoice is still issued, the
field is omitted, and `invoice.group_message_ignored` is logged. A missing
conversation store or a failing lookup never blocks the **200**.

When `SPEND_API_TOKEN` is unset or blank:

**Response** `503`:

```json
{ "error": "Spend invoices are not configured" }
```

Missing or wrong `Authorization: Bearer` → **401** `{ "error": "Unauthorized" }`.

Bad JSON, `amountMsat` outside `1000..10000000000`, `comment` longer than
255, invalid `messageId` or `groupMessageId` UUID, or both `messageId` and
`groupMessageId` set → **400**
`{ "error": "Expected a JSON body with address and amountMsat" }`.

Invalid Lightning Address → **400**
`{ "error": "Not a valid Lightning Address (expected name@domain)" }`.

No account for the address, or the account has no passkey credential →
**403** (before any LNURL fetch; no invoice is stored):

```json
{ "error": "Passkey required" }
```

The account has a passkey but is not funding-eligible today (`eligibleToday`,
also for a member in the grant program without a 21.gifts recovery share)
→ **403** (after the passkey check, before the forum-post check; no invoice
is stored):

```json
{ "error": "Funding grant required" }
```

When `messageId` is omitted, the account has a passkey and is eligible but
has no live **top-level** forum message other than the auto-created profile
note. When `messageId` is set, that id is not this address's live top-level
note (About me included) with a photo or video. Either case →
**403** (after the passkey and grant checks, before any LNURL fetch; no
invoice is stored):

```json
{ "error": "Forum post required" }
```

Missing `isPlatform` account (when `messageId` is set) → **503** (before any
LNURL fetch; no invoice is stored):

```json
{ "error": "Platform account is not configured" }
```

LNURL-pay failure, decode failure, or invoice amount mismatch → **502**:

```json
{ "error": "Lightning Address did not issue an invoice" }
```

Success → **Response** `200`:

```json
{
  "id": "<32 hex>",
  "pr": "lnbc…",
  "paymentHash": "<64 hex>",
  "amountMsat": 100000
}
```

Unpaid invoices expire after 15 minutes (`GIFT_INVOICE_TTL_MS`). A later
`POST /invoices` sweeps unpaid rows after expiry plus one extra TTL; until
then a matching preimage still proves payment. Restart clears the store.

### `POST /invoices/proof`

Spend-worker proof. Body `{ "id", "preimage" }`. Proof is the **preimage**;
`sha256(preimage)` must equal the stored payment hash.

Same 503/401 as `POST /invoices` when unconfigured or unauthorized.

Bad JSON or missing `id`/`preimage` → **400**
`{ "error": "Expected a JSON body with id and preimage" }`.

Unknown id → **404** `{ "error": "Invoice not found" }` (including after
sweep/restart). Matching preimage →
**200** even after the 15-minute unpaid TTL, as long as the row is still in
memory. Expired unpaid **without** a matching preimage → **409**
`{ "error": "Invoice expired" }`. Hash mismatch on an unexpired invoice →
**400** `{ "error": "Proof does not match invoice" }`. Already paid with a
different preimage → **409** `{ "error": "Invoice already paid" }`. Same
preimage → **200** idempotent.

A matching proof (including the same-preimage idempotent 200) inserts one
outbound `gift` row when `DATABASE_URL` is set: BOLT11 `pr` as
`lightning_invoice`, amount `floor(msat / 1000)` sats, fee 0, recipient
handle from the invoice address, description `21gifts moderator` when the
invoice has `groupMessageId`, else `21gifts welcome` when `comment` is
exactly `Welcome` (the welcome checks count only these records), else
`21gifts daily`,
`source_wallet` `lightning.space`. Without SQL the recorder is a no-op.
Insert errors log `gifts.record_failed` and do not change the HTTP
response.

When the invoice has `messageId`, the api inserts a platform-account
gift-reply first (name trimmed or `21.gifts`, text = comment, `parentId` =
`messageId`, same visual as a zap gift-reply), then `addSats(floor(msat/1000))`
on that post. That path does not notify (no in-app rows, no Web Push). When `messageId` is already a reply,
attach persists a deterministic `spendGiftReplyId` marker under that reply,
`markDeleted` so live `listReplies` omits it, then `addSats`s the reply (a live
existing marker is `markDeleted` only and does not `addSats`; no nested
gift-reply and no `notifyForumReply`). Repeat proof with the same preimage is
idempotent. Parent missing/deleted or platform missing: skip attach, log
`invoice.gift_reply.failed`, still **200** + gift persist.

When the invoice has `groupMessageId`, the api then inserts one platform
conversation message in that closed `moderator_group` thread (name trimmed
or `21.gifts`, `sats` = `floor(msat/1000)`, text = comment · recipient
name, `giftForMessageId` set to the triggering message's id). Repeat proof
with the same preimage is idempotent on the deterministic id. Triggering
row missing, thread missing or not `moderator_group`, platform missing, or
store throw: skip attach, log `invoice.group_gift.failed`, still **200** +
gift persist.

Success → **Response** `200`:

```json
{ "status": "paid", "id": "<id>", "paymentHash": "<64 hex>" }
```

### `POST /spend/daily-instruction`

Spend-worker daily instruction. Bearer `SPEND_API_TOKEN`. Body `{ "address" }`.
Extra keys are ignored. The kind is always daily. The api collects passkey,
live top-level post, media, funding eligibility (`eligibleToday`: grant and
21.gifts recovery share), the same-UTC-day welcome
flag, and the daily roster, then returns whether to pay and the amount,
comment, and optional `messageId`. Spend does not choose those fields. The
address is matched as a member's receiving address (`<username>@<host of
PUBLIC_BASE_URL>` with a verified wallet); any other address is a missing account.

Auth runs before JSON parsing and before gifts or roster. Unset or blank
token → **503** `{ "error": "Spend invoices are not configured" }`. Missing
or wrong `Authorization: Bearer` → **401** `{ "error": "Unauthorized" }`.

JSON parse failure, a non-object body, or a missing or non-string `address`
→ **400** `{ "error": "Expected a JSON body with address" }`. A string that
is not a Lightning Address → **400**
`{ "error": "Not a valid Lightning Address (expected name@domain)" }`.

A gift-ledger list throw → **503** `{ "error": "Gift ledger unreadable" }`
and does not read the roster. An omitted gift store does not apply the
welcome-paid rule. The roster is read from the API store (a missing
injection is a fresh in-memory store). A
roster request error keeps its status and `{ "error" }`. Any other roster
throw → **502** `{ "error": "Daily roster is unavailable" }`.

Success is always **200**: `{ "action": "skip", "reason" }` or
`{ "action": "pay", "amountUsd", "comment" }` plus `messageId` only when
the decision includes it. A skip is not logged. The token, comments, and
Lightning addresses are not logged.

### `GET /messages`

Public member forum thread. With no `Authorization` header, `mode=active`,
no hashtag, and no country, this is the public window: the first 200 active rows;
includes `accountId` whenever the stored author id is non-null, omits it
for an external row, and includes `mentions` when that flag is on and the
stored list is non-empty; 200 not 401. A present header that is not a
live session is 401 and does not use that window. A session still needs
`requireAction(account, 'forum.read')` (rules). Returns **only
top-level notes** (`parent_id IS NULL`) via `listFeed`. A profile note
is omitted only when its trimmed text equals the display name or the
name stored on the note (case-insensitive) and it has no photo, no
extra stills, and no video. A profile note with other About me text stays. Those rows stay
stored. `GET /messages/:id`, `listLatest`, and `listPostsByAccount` are
unchanged. Query `mode`
(`all` default, `active`, `unpaid`, `popular`), `limit` (1–200, default
**200**), opaque `cursor`, optional `hashtag` (name without `#`;
token match on live top-level `text`; combines with mode/limit/cursor), and
optional `country` (two upper-case letters, ISO 3166-1 alpha-2; only notes
whose pin lies in that country or territory, read from the pin's coordinates
with an offline boundary dataset and never from its label; a note without a
pin, or with a pin in the open sea, never matches; combines with the other
parameters, and the cursor pages only matches; any other value is **400**
`{ "error": "Invalid country" }`).
Response `{ messages }` plus `nextCursor`
only when the page is full. Newest first (`createdAt` descending, then
`id`) except `popular` (sats descending). Replies are never listed here —
use `GET /messages/:id/replies`. The list path does not load reply rows.
Clients must render the thread as a **messenger group** (oldest at
the top, newest at the bottom above the composer), reversing the array for
display. Each message exposes the author **name snapshotted at post time**,
`text` (may be empty when a photo or video is attached), ISO-8601
`createdAt`, `sats` (validated Lightning receipts on that note, default 0),
optional `goalSats` (positive integer on a top-level note; omitted when
unset/null/0), optional `goalRepayable: true` when the stored column is true
(omitted when null; never false), optional `goalTermDays` when the stored
column is not null (omitted when null), and when `goalCurrency` is stored also
`goalCurrency`, `goalAmount`, and `goalAmountUsd` / `goalAmountChf` /
`goalAmountEur` / `goalAmountPhp` (a snapshot may be null; a legacy row omits
those keys),
optional `place` (`{ lat, lng, label, address }` when a pin is stored;
`address` is the structured postal address or JSON `null`;
the key is omitted when unset), always `shopNpub` (the npub of a currently
listed shop with a key in `shop_identity`, otherwise JSON `null`),
`payable` (true when the note has a non-empty signed `eventId` and the author
has a receiving address (see [Receiving address](#receiving-address)); null or empty `eventId` is not payable),
`authorCanReceive` (true when the author has a receiving address, whether or
not the note is signed yet; false for a missing or external author and on a
soft-hidden row; a client shows that the member cannot receive yet instead of
offering a payment that can only fail),
`hasPhoto` (photo 0 exists), `photoCount` (integer 0–10 = photo 0
plus extras 1–9; always present), `photoTakenAts` (always present, length
equals `photoCount`, null when unknown, `[]` when there are no stills) and
`photoTakenAt` only when `photoCount` is 1 (equals `photoTakenAts[0]`, null
allowed), `hasVideo`, `videoContentType` (`null` when
`hasVideo` is false), live `role` (the author's current `account.role`, or
`"basis"` if the author is missing; omitted for external authors),
`staffTag` (present only as `"software_developer"` when set; omitted
otherwise; never JSON `null`; not a permission and does not change `role`), and
`replyCount` of live attributed children (`parent_id` match, `deleted_at`
null, and `account_id` set, or `author_pubkey` set and that pubkey is a
recorded zapper (`nostr_zapper` entitlement, checked via `isZapperPubkey` /
an `EXISTS` subquery)). Visible external rows
include `"via": "nostr"`; their pubkey, `role`, and `accountId` remain omitted,
and `payable` and `authorCanReceive` are false. Rows with neither an account nor an author pubkey stay
invisible. List JSON never includes photo
or video bytes. Live list, single-note GET, and replies include
`accountId` whenever the stored author id is non-null, with or without a
session, and omit it for an external row. `mentions`
(`{ username, accountId }[]`) stay tied to that same inclusion (only when
`accountId` is included and the stored list is non-empty). Nostr event ids are never included in the JSON.

A present Authorization header that is not a live session, a signed-out
request that is not `mode=active` without a hashtag or a country, or a public cursor
outside the window → **Response** `401`. A missing header on that public
window is not 401. Missing/invalid/expired bearer on the signed-in list
→ **Response** `401`:

```json
{ "error": "Unauthorized" }
```

Unknown `mode`, `limit` outside 1–200, a bad/mismatched `cursor`, an invalid `hashtag`, or an invalid `country` → **Response** `400`:

```json
{ "error": "Invalid mode" }
```

```json
{ "error": "Invalid limit" }
```

```json
{ "error": "Invalid cursor" }
```

```json
{ "error": "Invalid hashtag" }
```

```json
{ "error": "Invalid country" }
```

`mode=active` is paid notes (`sats > 0`) plus unpaid founder/moderator notes; a top-level ask with `goalSats` > 0 and `sats = 0` is not active; `unpaid` is `sats = 0`; `popular` is paid notes ordered by sats descending.

Missing rules → **Response** `409`:

```json
{ "error": "missing_requirements", "missing": ["rules"] }
```

Store failure → **Response** `503`:

```json
{ "error": "Messages are unavailable" }
```

Success → **Response** `200`:

```json
{
  "messages": [
    {
      "id": "<uuid>",
      "name": "Ada",
      "text": "Thank you!",
      "createdAt": "2026-08-28T12:00:00.000Z",
      "sats": 0,
      "amountUsd": null,
      "amountChf": null,
      "amountEur": null,
      "amountPhp": null,
      "payable": false,
      "authorCanReceive": true,
      "hasPhoto": false,
      "photoCount": 0,
      "photoTakenAts": [],
      "hasVideo": false,
      "videoContentType": null,
      "shopNpub": null,
      "role": "basis",
      "replyCount": 0
    }
  ]
}
```

`staffTag` is present only as `"software_developer"` when set and is omitted
otherwise (never JSON `null`). It is not a permission and does not change
`role`.

An empty thread is **200** with `"messages": []`. When `DATABASE_URL` is
unset the default in-memory store starts empty; when set, rows come from
Postgres `message`. List queries select top-level rows only
(`parent_id IS NULL`), `(photo IS NOT NULL) AS has_photo`, and a
`replyCount` of live attributed children
(`account_id IS NOT NULL OR (author_pubkey IS NOT NULL AND EXISTS
(SELECT 1 FROM nostr_zapper WHERE pubkey = lower(author_pubkey)))`),
and must not select the `photo` bytea
column.

The hot lane uses the same receipt-read URL set as full ingest
(`resolveZapRelays`: space plus the public list, including when
`NOSTR_PUBLISH_PUBLIC` is unset), but only for recent in-app invoice e-tags,
and it makes no relay query when no target remains. Receipts are published
only to the relays a zap request names, so this read set is exactly the
kind:9734 `relays` tag every zap request the api builds carries (at least the
space relay); inbound kind:1 replies and direct messages are read there too.

The nostr worker's ingest lane, each pass, queries that receipt-read set for
kind:9735
receipts whose `e` tag matches a non-empty `event_id` from `listLatest`
or a non-null `listReplies` child of those rows (unioned with the official
platform profile note's `event_id` even after that note ages out of
`listLatest`, and with open conversation zap event ids). Empty `event_id`
rows are skipped. A receipt is
indexed when the signer pubkey matches the author's LNURL-pay
`nostrPubkey`, the bolt11 amount is at least 1 sat, the receipt id is
new, and the bolt11 payment hash is not already claimed by another
receipt id in `nostr_zap_payment` (a second receipt event for the same
payment, or an operator settle, is recorded as `rejected` / `settled`).
The claim has no foreign key to `message` and survives `deleteById`.
At Postgres boot, receipts credited before the claim table existed are
backfilled so a second real receipt for the same payment cannot double-credit.
The separate external-payer backfill pages through every currently
unattributed indexed receipt newest-first in 200-row batches, stopping at a
hard ceiling of 10,000 scanned receipts per boot. It uses a strict keyset cursor
`(created_at, event_id)` that advances past every returned row, so a row attributed
by another process between two pages is neither skipped nor processed twice.
Equal ingest timestamps are ordered by receipt event id descending
in both message-store implementations. Re-running it is idempotent; reaching
the ceiling is logged, and a read or processing failure is logged without
aborting boot. The payment-hash claim backfill remains boot-critical.
Indexed receipts increment that row's `sats` (GET /messages then
returns the new total). Kind:1 EVENT frames published to relays are JSON
objects, not JSON strings.

For a payer pubkey that does not map to a 21.gifts account, external
attribution is stricter than the member path. The embedded kind:9734 must be a
valid signed event; its exact tagged JSON must match the BOLT11 description
hash; its `e` tag must match the paid note; and an optional decimal `amount`
tag must equal the invoice msat. A verified zap of at least 1 sat permanently
records the pubkey in `nostr_zapper`, including when the paid note is a reply
or cannot receive a gift-reply. Later zaps from the same pubkey skip the repeated
`recordZapper` write through a per-store process-local lowercase-pubkey memo.
Attribution is recorded before the staff block check; a blocked payer is then
durably dequeued by clearing `payer_pubkey` while retaining `zap_request_id`.
Sats stay credited, nothing is shown, a later unblock does not resurrect zaps
made while blocked. A kind:9734 request id may attribute only one receipt;
replay on another receipt creates no second gift-reply.
Replayed requests and credited receipts below the external minimum are remembered
in a per-store process-local set of at most 10,000 receipt ids, so later worker
ticks neither re-verify their embedded kind:9734 nor repeat store writes. An
eligible live top-level note receives a
deterministic external gift-reply (`accountId` null, `via: "nostr"`, comment and
sats from the zap, receipt time clamped to now, Nostr publish skipped). Profile
lookup failure falls back to a non-impersonating truncated-pubkey display name.
Resolved profile names use the same fallback when any of these holds: they contain a
C0 or DEL control character, an explicit bidirectional control character (U+061C,
U+200E, U+200F, U+202A–U+202E, U+2066–U+2069), or no letter or digit at all; they
contain a default-ignorable Unicode code point (checked on the name and on its NFKD
form too, so a compatibility character that decomposes to one is also caught), except
the ZWNJ/ZWJ joiners U+200C/U+200D and the emoji variation selectors U+FE00–U+FE0F
which stay allowed; they mix more than one of the Latin, Cyrillic and Greek
scripts; they equal a member name in a plain comparison (NFKC, trimmed,
case-insensitive); a reserved project/staff word
appears in their look-alike fold or in their by-sound transliteration of Cyrillic
letters (both folds are lossy here: unmapped letters are dropped, so a false positive
only yields the fallback); or their look-alike fold or their transliteration equals
that of a member name — this member comparison applies only when every letter of the
candidate is ASCII or mapped by the respective table. Ordinary right-to-left names and
zero-width-joiner emoji sequences are kept, and names written entirely in one
non-Latin script otherwise remain eligible.

Inbound kind:1 `#e` replies continue unchanged for account-owned pubkeys. An
unowned pubkey is persisted only after it is recorded in `nostr_zapper`, while
unblocked, and within both per-pubkey and global ingest limits. The reply REQ
has no `since`, so older replies become visible on the first ingest pass after the
first verified zap. Member ownership or external zapper entitlement plus
not-blocked status is decided before verifying the inbound kind:1 signature and
before any event-specific message-store read. A per-store in-flight event-id
guard prevents overlapping ticks from concurrently persisting the same external
reply. External profile names come only from signed kind:0 events whose content
is at most 64 KiB. After profile resolution, a fresh single-pubkey block lookup
runs inside the in-flight guard and before the ingest limiter. A block added
while profile lookup is pending therefore wins, consumes no limiter budget, and
the event id is still released by the guard's `finally`. Limiter budget is
consumed immediately before `messages.create` and released when that write
fails. External replies notify only the parent note's member author and only
when `created_at` is numeric, at most one hour old, and no more than ten minutes
in the future. Missing/non-numeric, farther-future, and older timestamps still
persist but do not notify. The notification uses the generic actor name
`Someone`, never the external reply's own display name, so a visitor-chosen name
cannot appear in a notification. All inbound reply timestamps are clamped to
the ingest clock so future-dated events cannot pin thread order; missing or
non-numeric `created_at` retains the existing ingest-time storage fallback.
Other unknown pubkeys remain on Nostr only.

Known limitation: if the payer's wallet publishes no kind:9735 receipt, the
external zapper gains no website visibility. Operator manual settlement
covers member-created forum invoices only; it cannot create an external
zapper entitlement.

### `GET /messages/places`

Bearer session required. After auth, the same `forum.read` gate as
`GET /messages` (401 without a session; 409 `missing_requirements` when
rules are missing). Query `limit` is an integer 1..1000 (default **1000**);
otherwise **400** `{ "error": "Invalid limit" }`. Body
`{ "places": [{ "id", "name", "createdAt", "lat", "lng", "label", "address", "shop", "countryCode", "shopNpub", "accountId?" }] }`.
`shop` is true when the note text contains the shop tag. `countryCode` is the
ISO 3166-1 alpha-2 code of the country or territory that contains the pin,
read from its coordinates on every request (never stored, so existing pins need
no backfill), or `null` for a pin in the open sea. The app counts the shops per
`countryCode` for the Shops country filter and passes the same code to
`GET /messages?country=`. `accountId` is set for a 21gifts author and omitted for an external pin.
`shopNpub` is the npub only when the row is a currently listed shop with a
stored identity; otherwise it is JSON null.
`address` is `{ "street", "houseNumber", "postalCode", "city", "country" }` or JSON `null`.
`createdAt` is ISO-8601. Newest first (`created_at` desc, `id` desc). Only
live top-level rows with both coordinates. Replies and hidden notes are
excluded.

### `GET /messages/compose-target`

Bearer session required. After auth, `requireAction(account, 'forum.post')`
(rules + name + username + a verified wallet). Returns the official platform
profile note so a basis account can invoice 1 sat to 21.gifts before posting
or replying:

```json
{ "messageId": "<uuid>", "sats": 0, "firstPostFree": true }
```

`firstPostFree` is `true` when the caller has no top-level note of its own
other than its profile note (About me), live or soft-hidden. Replies and
conversation messages do not count. It does not reset. While it is `true`, a
text-only top-level `POST /messages` is stored without the 1-sat fee (see
[First post free](#first-post-free)).

Ensures that profile note exists. Unless `firstPostFree` is `true` (then the
client posts directly), the client calls `POST /messages/:id/invoice` on
`messageId`. A later indexed member/invoice zap
on that note turns the zap comment into the payer’s top-level post (`sats` 0
on the new row). An external zap on that same note still inserts a gift-reply
under it. The worker always includes that profile note’s `event_id` in the relay
query, even after the note ages out of `listLatest`. A comment `inReplyTo:<uuid>\n<body>` becomes a reply on that live
top-level parent; a missing, hidden, or nested parent falls back to a
top-level post with the remaining body. An empty comment does not create a
blank living-room post.

Missing/invalid/expired bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

Missing required fields → **Response** `409`:

```json
{ "error": "missing_requirements", "missing": ["rules", "name", "username", "lightning-address"] }
```

Platform account without a receiving address →
**Response** `400`:

```json
{ "error": "This message cannot be paid yet", "code": "cannot_receive" }
```

Platform note not signed yet → **Response** `400`
`{ "error": "This message cannot be paid yet" }` (no `code`).

No platform account, missing or soft-hidden profile note, or store failure → **Response**
`503`:

```json
{ "error": "Messages are unavailable" }
```

### `POST /messages`

Post to the public member forum. Bearer session required. JSON body (not
multipart) with text and/or one photo, optional `photos` (array, max 10,
each `{ contentType, data, takenAt? }` same shape as singular `photo`), an
optional parent UUID, and optional `goalSats` (positive integer 1..10_000_000
on a top-level note only). Required `shopUsername` (JSON string or multipart field) on a top-level shop note stores that account on the same insert as the note and does not write `message_edit`. Omitted, null, blank, or `@` alone on a top-level shop note is 400 `A shop note needs a shop account` after the shop pin checks pass, and nothing is stored. The same blank value on a note that is not a shop stores nothing. A non-string is 400 `Username is not valid`. A reply, or a note that is not a shop, with a non-blank username is 400 `Only a shop note can set a shop account` before the handle is normalised or looked up. After that, a handle `normalizeUsername` rejects is 400 `Username is not valid`. An unknown username, or a stored username that is null or blank, is 404 `No account with that username`. A media replay of an existing live note does not change its shop account. Optional `takenAt` is `YYYY-MM-DDTHH:MM:SS` with an optional `±HH:MM`
offset, a real calendar date, and a year from 1990 through the current UTC
year + 1. `Z`, a fractional second, a leap second, a non-string, or a missing
value is stored null and does not return 400:

Top-level with a goal:

```json
{
  "text": "…",
  "goalSats": 21000,
  "photo": {
    "contentType": "image/jpeg",
    "data": "<base64>",
    "takenAt": "2026-09-22T11:40:00+08:00"
  }
}
```

Reply (no `goalSats`; a positive `goalSats` with `inReplyTo` is 400). `takenAt` may be omitted:

```json
{
  "text": "…",
  "inReplyTo": "<uuid>",
  "photo": { "contentType": "image/jpeg", "data": "<base64>" }
}
```

Non-empty `photos` wins over singular `photo`. Dual-send `{ photo, photos }`
uses `photos` when the array is non-empty. Eleven items → **400**
`{ "error": "At most 10 photos" }`. `{ "text": "hello" }` without
`photo`/`photos` remains valid. Photo-only posts (singular `photo` or
non-empty `photos`) are allowed (`text` may be omitted or empty when a
photo is present). At least one of (non-empty trimmed text, singular photo,
non-empty `photos`) is required. Optional `inReplyTo`
is a **top-level** parent message UUID (JSON only; sets `parentId` for a
one-level NIP-10 reply). Missing or non-UUID `inReplyTo`, a parent that
is not in the store, or a parent that is itself a reply (`parentId` not
null) → **404** `{ "error": "Not found" }`. Anyone below `verified`
posting unpaid **text-only** → **403**
`{ "error": "A post needs a Bitcoin payment" }` or `{ "error": "A reply needs a Bitcoin payment" }`
for `inReplyTo`, except the free first post below and a reply whose parent
note the caller wrote: that reply is free for every role, because a wallet
cannot pay itself. It still passes the post limiter and the Sunday rule. A photo or video body from `basis` is **200**. Pay 1 sat to
21.gifts first (`GET /messages/compose-target`
then `POST /messages/:id/invoice` on that platform profile note). Optional
`goalSats` omitted, JSON `null`, or a missing/empty multipart field means
no goal. Multipart accepts `goalSats` as a decimal digit string. A positive
`goalSats` together with `inReplyTo` → **400** `{ "error": "A reply cannot ask for a goal" }`.
Optional `place` is `{ lat, lng, label?, address? }`. Omitted or null stores no pin
and the 200 JSON omits `place`. `address` omitted or null stores `address: null`.
Invalid place is 400 with `Place must be a latitude and longitude`,
`Place label must be at most 80 characters`, or `Place address is invalid`.
`inReplyTo` together with a non-null place is 400
`{ "error": "A reply cannot include a place" }`. Multipart fields are
`placeLat`, `placeLng`, optional `placeLabel`, and optional
`placeStreet`, `placeHouseNumber`, `placePostalCode`, `placeCity`,
`placeCountry` (always top-level). Both coordinates empty means no pin.
Any of those address fields set while both coordinates are missing is 400
`Place must be a latitude and longitude` and nothing is stored. A missing
or blank label without coordinates still stores no pin. Exactly one
coordinate set is 400 `Place must be a latitude and longitude`.
All five address fields blank means no address; any present field requires
all five (same `Place address is invalid`). A top-level note whose text has
`#21GiftsShop` and that has no pin is **400**
`{ "error": "Shop name is required" }` and nothing is stored, because the
shop name is the pin label. That check runs before the shop-account check.
A pin on that note must pass `shopPlaceProblem` then `shopTextProblem`;
otherwise **400** with that shop error and nothing is stored. A reply, and
a note that is not a shop, may still omit the pin.
An invalid multipart `goalSats` → **400** `{ "error": "Goal must be a positive whole-sat amount" }`.
A post sends either legacy `goalSats` alone, or both `goalCurrency` (`BTC`, `USD`, `CHF`, `EUR`, or `PHP`) and `goalAmount` (trimmed decimal string, comma or dot, at most eight fractional digits). Both styles together, only one of the new pair, a non-string `goalAmount`, or a string that fails that grammar → **400** `{ "error": "Send either goalSats or both goalCurrency and goalAmount" }`. A reply that sends `goalSats`, `goalCurrency`, `goalAmount`, `goalRepayable`, or `goalTermDays` → **400** `{ "error": "A reply cannot ask for a goal" }`. Optional `goalRepayable` (JSON boolean or multipart string) marks a top-level ask as repayable. Absent, JSON `null`, or a missing/empty multipart field stores SQL NULL and the 200 JSON omits the key. JSON `true` or multipart `"true"` stores `true` only when this create also stores an ask (`goalSats`, or both `goalCurrency` and `goalAmount`) and a term; the 200 JSON then includes `goalRepayable: true`. JSON `false`, any other type, or any other string → **400** `{ "error": "Ask obligation must be true" }`. `true` without an ask → **400** `{ "error": "A repayment obligation needs an ask" }`. Stored values are SQL NULL or TRUE, never `false`. Optional `goalTermDays` (JSON number or multipart digits) is the agreed repayment term in whole days. Absent, JSON `null`, or a missing/empty multipart field stores SQL NULL and the 200 JSON omits the key. A whole number from 1 to 3650 stores that integer only when this create also stores `goalRepayable: true` and an ask; the 200 JSON then includes `goalTermDays` as that integer. Anything else, including 0, 3651, a fraction, or a string that is not an integer → **400** `{ "error": "Ask term must be a whole number of days from 1 to 3650" }`. A term without `goalRepayable: true` → **400** `{ "error": "A repayment term needs a repayable ask" }`. `goalRepayable: true` without a term → **400** `{ "error": "A repayable ask needs a term in days" }`. Interest is not stored. When collected sats first reach `goal_sats`, `goal_funded_at` is set. Repayment is due each UTC day starting the day after that, but never before 2026-11-10, for `goal_term_days` days. A credit that filled on or before 2026-11-09 starts on 2026-11-10. `GET /messages/:id/repayment` returns that first day as `startsOn`. Each giver is repaid exactly what they paid: their sats on a bitcoin ask, or the cents of the goal currency recorded on their payments on a fiat ask. A fraction below one sat or one cent carries to a later day until it is one whole unit, so a gift of 1 sat or 1 cent comes back in full. The shares of one day add up to that day's split of the total, with the remainder on the last day. The author pays the next unpaid share at that giver's Lightning address. A fiat share is priced in bitcoin at the rate of the day it is paid. A paid zap whose invoice description is `repay:<day>:<accountId>` is stored in `message_repayment` and does not increase the ask. `GET /messages/:id/repayment` is public on a live repayable ask and lists every giver and every Lightning repayment (who, how much, which UTC day, and whether it is paid, due, or still scheduled). Dates are omitted until the credit is fully given. Sats with no 21.gifts payer are reported separately and are not repaid. The flag and term are not written into Nostr event content or the note text. The canonical stored `goalAmount` uses a dot, no exponent, no leading zeros, and no trailing fractional zeros (`10.` and `10.0` are `10`). `goal_sats` is that integer for `BTC` (1..10_000_000; a missing gift-day does not reject it) or `Math.round(amount * day.sats / dayFiat)` for fiat, with a rounded 0 raised to 1. Fiat needs a usable latest gift-day (`GET /gifts/stats` `spendOverTime`, last day with `sats > 0`) and a result in 1..10_000_000; otherwise **400** `{ "error": "Ask amount is unavailable" }`. If that loader throws for a fiat ask → **503** `{ "error": "Messages are unavailable" }`. A BTC ask still stores the typed sats when the loader throws. Frozen columns `goal_currency`, `goal_amount`, and `goal_fiat_usd` / `goal_fiat_chf` / `goal_fiat_eur` / `goal_fiat_php` are null when there is no currency ask. Legacy rows keep `goal_sats` and leave the new columns null (no backfill). Public, debug, and hidden JSON include `goalRepayable: true` only when the column is true and omit the key when null (never emit `false`). Public and debug JSON omit the currency-ask keys when `goal_currency` is null. When it is set they include `goalCurrency`, `goalAmount` (the typed canonical string, not the two-decimal snapshot), `goalSats`, and `goalAmountUsd` / `goalAmountChf` / `goalAmountEur` / `goalAmountPhp` (two-decimal string or null). Payment progress fiat stays the sum of per-payment gift-day snapshots. A null component on a later payment does not wipe a stored total; a null stored column is assigned the next non-null snapshot and is not rebuilt. One-time and Daily are still not stored. Settlement is not moved onto Coinbase spot.
JSON type/range errors keep **400** `{ "error": "Expected a JSON body with text and/or photo" }`.
Above 10_000_000 is rejected, not clamped. Multipart video posts do not
accept `inReplyTo` (they are always top-level).

After auth, `requireAction(account, 'forum.post')` requires rules agreement,
a non-blank display name, a non-blank username, and a verified in-app
wallet (`lightning-address`; skip timestamps do not satisfy; username cannot be skipped). The api stores a **name snapshot** (trimmed account name at
post time), normalised text (possibly `""` for photo-only), optional
JPEG/PNG/WebP bytes (≤ 1 MiB; MIME from magic bytes), `parentId` (null for
top-level notes), and a timestamp. Text longer than **8000** after trim, or
with disallowed C0/DEL controls, is rejected. Newlines (`\n`, `\r`) are
allowed. The **200** body is the public message object itself (not wrapped
in `{ messages }`), including `sats`, `payable`, `authorCanReceive` (a freshly
created note is not signed yet, so `payable` is false while `authorCanReceive`
is true when the author can receive), `hasPhoto`, `photoCount`
(0–10; always present; `hasPhoto` still means photo 0 exists), `photoTakenAts`
(always; length equals `photoCount`; null when unknown; `[]` when there are no
stills) and `photoTakenAt` only when `photoCount` is 1, `hasVideo`,
`videoContentType`, and always `shopNpub` (the npub of a currently listed
shop with a key, otherwise JSON `null`). May include `goalSats` (positive integer on a top-level
note; omitted when unset). May include `goalRepayable: true` when the stored
column is true (omitted when null; never false). May include `goalTermDays`
when the stored column is not null (omitted when null). May include `accountId` (21gifts author id) and `mentions`
(`{ accountId, username }[]`, only when that list is non-empty). A stored
self mark does not notify the author. Other marks fan out one
`forum_mention` per person. That is the only in-app row and the only Web
Push for that note for that person (`forum_post` / `forum_reply` exclude
them). `GET /notifications` drops and deletes a stored generic row when
the scan also has `forum_mention` for the same `replyId`. No
`replyCount`, and no photo or video bytes in the JSON. `sats` is 0 and
`payable` is false until the worker signs the note (and stays false without
an author receiving address). `role` is the posting session account's live `account.role`. Web Push and in-app rows for a **top-level** note (`notifyForumPost`, kind
`forum_post`, `url` `/messages/<id>`, `tag` `forum_post:<id>`) and for a
**reply** (`notifyForumReply`, kind `forum_reply`, `url` `/messages/<replyId>`,
`tag` `forum_reply:<replyId>`) fan out in-app to every account except the
actor and except each account marked on the created row (no-op when the actor is the official platform account), then filter recipients by each account's `notificationLevel`
(`all` / `active` / `mentions` / `none`). The excluded ids are the created row's mention account ids other than the author, deduped; an empty list omits `excludeAccountIds`. Web Push still goes only to bell subscribers
and uses the same level filter. Damus-only parents still
fan out. A self-reply skips only the actor. The same mark exclusion applies to the reply fan-out. `GET /notifications` applies the
same `notificationLevel` filter to stored rows.
The booted process always has notification and push stores (in-memory without
`DATABASE_URL`, Postgres when it is set). Photo-only empty text still
notifies. Missing `pushStore` still writes in-app rows. Notification or
push failure does not fail the **200**. Over-limit posters
get **429** `{ "error": "Too many messages" }`
with `Retry-After: 10` (1/10s, 6/h, 20/UTC-day). A second **live** photo/video
POST with the same account, parent, normalised text, media bytes, and pin returns
**200** with the existing row (no extra burst slot, no second top-level push).
The same media with a different pin is **409**
`{ "error": "A live note with this media already exists" }`.
Text-only posts are unchanged (still **429** on burst). After a **new**
top-level persist, the welcome POST is sent and awaited before the daily
POST. `address` is the author's wallet-backed receiving address (no verified
wallet → no ping). The api POSTs `{ address, messageId }` to `{SPEND_URL}/ping` with
Bearer `SPEND_API_TOKEN` (fire-and-await; `messageId` is the UUID of the new
top-level row) only when `eligibleToday` for the author's funding grant and
21.gifts recovery share **and** the new row has media (`hasPhoto` /
`hasVideo` / `photoCount > 0`).
Otherwise no ping, log `spend.ping.skipped` / `not_eligible` (ineligible) or
`no_media` (eligible text-only). When `role === 'verified'` and any live
top-level photo or video exists, including the About-me note, the api also
POSTs `{ address, messageId, kind: "welcome" }` for that note, independent
of `eligibleToday` and independent of whether the new row itself has media.
Spend pays the welcome gift and does not also pay the daily gift on that
same UTC day. A later UTC day still pays the daily gift.
The same ping runs when the account becomes verified and when About me is
saved while verified. On boot, and every 15 minutes, every verified account
that already has a live top-level photo or video (About me or a living-room
post) is welcome-pinged, so the gift still goes out when the photo post and
verification happened in either order. The welcome gift is once per
account, not once per address: an account that already has a platform reply
with the text `Welcome` under one of its notes (live or hidden), or a recorded
`welcome` gift with description `21gifts welcome` under its username at or after its wallet verification, is not pinged again (`spend.ping.skipped` / `welcomed`), whichever address the gift went
to, so a member whose receiving address changed is not paid twice. Replies, and any role other than `verified`, do not
welcome-ping. A verified text-only post with no photo or video anywhere does
not welcome-ping.
Errors are logged; the POST still
returns **200**. Replies do not ping. Idempotent media replay does not ping
again. Unset or blank `SPEND_URL` or `SPEND_API_TOKEN` skips the ping; the
process still boots. The worker signs a
top-level kind:1 (content includes Damus-visible `#bitcoin` and `#21gifts`, and when the author's `location` is non-null also `#<locationHashtagName>` plus a `t` tag (not on the profile note);
forum `text` stays the member's words) and fans out when `NOSTR_PUBLISH=1`.

Missing/invalid/expired bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

Missing required fields → **Response** `409`:

```json
{ "error": "missing_requirements", "missing": ["rules", "name", "username", "lightning-address"] }
```

(`missing` is never empty; order is `rules`, then `name`, then `username`,
then `lightning-address`. A named, rules-agreed, username-set account
without a verified wallet yields `["lightning-address"]` only.)

Body is not JSON with `text` and/or `photo` → **Response** `400`:

```json
{ "error": "Expected a JSON body with text and/or photo" }
```

Text longer than 8000 after trim, or contains a disallowed control →
**Response** `400`:

```json
{ "error": "Text must be 1–8000 characters" }
```

Whitespace-only / empty text with no photo and no non-empty `photos` →
**Response** `400`:

```json
{ "error": "Text must be 1–8000 characters or include a photo" }
```

`photo` present but invalid base64, wrong magic (not JPEG/PNG/WebP), empty,
or decoded size `> 1_048_576` → **Response** `400`:

```json
{ "error": "Photo must be a JPEG, PNG, or WebP under 1 MiB" }
```

`photos.length > 10` → **Response** `400`:

```json
{ "error": "At most 10 photos" }
```

`inReplyTo` present but not a UUID, the parent is missing, or the parent
is itself a reply →
**Response** `404`:

```json
{ "error": "Not found" }
```

Anyone below `verified` posting an unpaid text-only top-level note after
their first post →
**Response** `403`:

```json
{ "error": "A post needs a Bitcoin payment" }
```

<a id="first-post-free"></a>
**First post free.** A text-only top-level note from anyone below `verified`
is stored without the fee when the account has no top-level note of its own
other than its profile note (About me), live or soft-hidden. Replies and
conversation messages do not count. An unpaid text-only reply on someone else's
note stays **403** without the fee; a reply on the caller's own note is free and
does not use the free first post.
The rule is checked again inside the insert: the row is written only while it
still holds and is marked `first_post_free`, which is unique per account. Of
two concurrent first posts, one is **200** and the other is **403**
`{ "error": "A post needs a Bitcoin payment" }`, so the client falls back to
the paid flow. `GET /messages/compose-target` reports the rule as
`firstPostFree`. A failing check is **503** `{ "error": "Messages are unavailable" }`.

Anyone below `verified` posting an unpaid text-only reply (`inReplyTo`) to a
note someone else wrote → **Response** `403`:

```json
{ "error": "A reply needs a Bitcoin payment" }
```

Store failure → **Response** `503`:

```json
{ "error": "Messages are unavailable" }
```

Success → **Response** `200`:

```json
{
  "id": "<uuid>",
  "name": "Ada",
  "text": "Thank you!",
  "createdAt": "2026-08-28T12:00:00.000Z",
  "sats": 0,
  "payable": false,
  "authorCanReceive": true,
  "hasPhoto": false,
  "photoCount": 0,
  "photoTakenAts": [],
  "hasVideo": false,
  "videoContentType": null,
  "shopNpub": null,
  "role": "verified"
}
```

A new note that is a public shop when it is read again after the commit gets
its shop key, and creating the key queues its OpenCryptoPay place outbox (see
the public shop rule above); the sender then PUTs a shop that is listed. A
public shop that is not listed clears that flag and sends nothing. A note
gone, hidden, or no longer a shop by that read gets no key, and nothing is
sent. A replay creates no key and queues nothing.

### `POST /messages/:id/invoice`

Signed-in pay-on-note. Bearer session required. `:id` is a UUID (`MESSAGE_ID_RE`).
Body `{ "sats": <int 1..10_000_000>, "text"?: "<string>", "amountUsd"?: "<string>|null", "amountChf"?: "<string>|null", "amountEur"?: "<string>|null", "amountPhp"?: "<string>|null", "heart"?: <boolean> }`. Optional `text` is the
NIP-57 zap-request `content` (same 1–8000 forum rules; omit or whitespace = gift-only).
Optional `heart: true` asks for a 1-sat heart instead of a gift (see
[Hearts](#hearts) below); omitted or `false` is a gift.
Omitting every amount key leaves the invoice unpinned. Any present amount key pins all four; a missing sibling is null. `"0"`, `"0.0"`, and `"0.00"` are stored as `"0.00"`. An unusable amount string is **400** `{ "error": "Expected a JSON body with a positive \"sats\" integer" }`.
Invalid `text` → **400** `{ "error": "Text must be 1–8000 characters" }`.
The api signs a NIP-57 zap request with the
**payer** key and returns a BOLT11 invoice for the **author's** receiving address
(see [Receiving address](#receiving-address))
**only** when the minted invoice's `description_hash` equals SHA-256 of the
zap-request JSON (`isNip57Invoice`). That JSON is serialised with the NIP-01
field order `id, pubkey, created_at, kind, tags, content, sig`, and the exact
string is both the LNURL `nostr=` value and the SHA-256 input. A validated
kind:9735 receipt credits the
paid row (`:id`, which may be a reply). After that increment (never in the same
SQL CTE), the worker inserts a reply from the payer (`text` from the zap-request
comment or `""`, `sats` = this zap) only when the paid row is top-level
(`parentId` null) and is not the official platform profile note. A zap on
that platform note (`GET /messages/compose-target`) instead creates the
payer’s post or `inReplyTo:` reply with `sats` 0 — the sat paid 21.gifts,
not the new row. Member invoices keep the existing relaxed signed-request
attribution. An external payer must pass the strict description-hash, target,
amount, signature, replay, and block checks described under `GET /messages`;
its gift-reply has `accountId` null, `via: "nostr"`, and is never signed by the
platform. A zap on a signed reply is `addSats` only (no nested gift-reply), but
a verified external payer still gains durable zapper entitlement. Gift-only
member replies (`text === ""`) and all external gift-replies stay
`nostrPublishState` `skipped` (no kind:1). Parent `sats` is the aggregate;
reply `sats` is this gift.
After a newly indexed **member-note** receipt, `notifyZap` runs best-effort
(in-app rows for every account except the resolved payer, no-op when that
payer is the official platform account, then filtered by each account's
`notificationLevel`; Web Push only to bell subscribers with the same filter;
missing `pushStore` still writes in-app rows when `auth` is set; enqueue
failure logs `push.enqueue.failed`). A member/invoice zap on the official platform profile
note skips `notifyZap` and fans out `notifyForumPost` / `notifyForumReply`
plus a top-level `spendPing` only when `eligibleToday` (same gate as
`POST /messages`; ineligible logs `spend.ping.skipped` / `not_eligible`).
An external zap on that same note still inserts a gift-reply under it. `GET /notifications` applies the same
`notificationLevel` filter to stored rows. LNURL success with a non-NIP-57 invoice
(plaintext description, missing/mismatched `description_hash`, or malformed
BOLT11) → persist `not_zap` (with rejected `pr` for debug) and **400**
`{ "error": "The author's wallet cannot receive this Bitcoin payment", "code": "cannot_receive" }`
with **no** `pr` in the body. LNURL `noZap` (author wallet does not advertise zap
receive) → same author's-wallet **400** (persist `noZap`, `pr` null). Other
LNURL/zap transport failures (`unreachable`) → **400**
`{ "error": "Could not start the Bitcoin payment" }`. It does **not** increment
`sats` (that happens when a validated kind:9735 receipt is indexed). After auth,
every attempt with a valid UUID is persisted best-effort to `message_invoice`
(result, HTTP status, `pr`, description vs `description_hash`,
`isNip57Invoice`). Store failures log `message.invoice.record_failed` and do
not change the HTTP response. A non-UUID `:id` is **404** without a persist row.

Success → **Response** `200`:

```json
{ "pr": "lnbc…", "amountSats": 21, "sparkInvoice": "spark1…" }
```

`sparkInvoice` is a Spark invoice (`spark1…`) for the same amount to the
recipient's verified wallet with memo `zap:<payment hash of pr>`, or `null`
when `pr` is not for exactly that amount or free in-app payments are off (see
[Free in-app payments](#free-in-app-payments)). A recipient without a
verified wallet never reaches this 200; it is the **400** `cannot_receive`
below. `pr` is unchanged, so a
payer without an in-app wallet still pays over Lightning.

The author's address is the receiving address
(see [Receiving address](#receiving-address)); this applies to the compose-target
posting fee too, whose recipient is the official platform account.

Missing Bearer → **401** `{ "error": "Unauthorized" }`.
Payer missing living-room rules → **409** `{ "error": "missing_requirements", "missing": ["rules"] }`.
Malformed body or `sats` above 10 million → **400** `{ "error": "Expected a JSON body with a positive \"sats\" integer" }`.
Unknown id → **404** `{ "error": "Not found" }`. Author without a receiving
address (no verified wallet with the LNURL server configured) →
**400** `{ "error": "This message cannot be paid yet", "code": "cannot_receive" }`.
A note without a member author (Damus-only) → **400**
`{ "error": "The author's wallet cannot receive this Bitcoin payment", "code": "cannot_receive" }`.
Unsigned note (null or empty `eventId`) or missing recipient pubkey →
**400** `{ "error": "This message cannot be paid yet" }` (no `code`). Missing KEK →
**503** `{ "error": "Messages are unavailable" }` (before the limiter).
Over-limit → **429** `{ "error": "Too many payments" }` (`Retry-After: 10`) —
checked only after auth, amount, payable, and KEK checks succeed, so early
400/404/401/503 do not consume quota. LNURL/zap or sign failure after the
limiter still counts. Author-wallet zap failure (`noZap` or `not_zap`) →
**400** `{ "error": "The author's wallet cannot receive this Bitcoin payment", "code": "cannot_receive" }`.
Other LNURL/zap failure (`unreachable`) →
**400** `{ "error": "Could not start the Bitcoin payment" }`. Keygen/sign failure →
**503** `{ "error": "Messages are unavailable" }`.

#### Hearts

A heart is always fee-free: it is paid only with the in-app Spark invoice,
never over Lightning.

- `heart: true` needs `sats: 1`; any other amount is **400**
  `{ "error": "A heart sends 1 sat" }` (attempt `bad_body`, no LNURL).
- A heart on the payer's own note is **400**
  `{ "error": "You cannot send a heart to yourself" }` (attempt `self_heart`,
  no LNURL).
- A paid reply (non-empty `text`) on the payer's own note is **400**
  `{ "error": "A reply on your own note is free; post it without a payment" }`
  (attempt `self_reply`, no LNURL). That reply is posted unpaid with
  `POST /messages` and `inReplyTo`.
- When free in-app payments are off, a heart is **503**
  `{ "error": "HEART_UNAVAILABLE" }` before the limiter and before LNURL
  (attempt `heart_unavailable`).
- When the Spark invoice cannot be issued for the minted `pr` (store failure,
  or `pr` is not for exactly 1 sat), the heart is the same **503**
  `{ "error": "HEART_UNAVAILABLE" }`. The body has no `pr`, and the attempt is
  `heart_unavailable` with `pr` null, so no `ok` row exists for that payment
  hash. A gift keeps `sparkInvoice: null` and its `pr` in that case.
- Success is the same **200** `{ pr, amountSats: 1, sparkInvoice }` with a
  non-null `sparkInvoice`. The attempt is `ok` with `heart: true`.
- Hearts have their own budget, separate from the gift limiter (1 per 10 s,
  20 per hour per account). A heart neither checks nor consumes it, and a gift
  does not consume the heart budget. Per account: one heart per note per
  10 seconds, and at most 60 hearts per sliding hour across all notes. Over
  either cap → **429** `{ "error": "Too many payments" }` (`Retry-After: 10`,
  attempt `rate_limited` with `heart: true`).
- When the heart is indexed, sats are credited, only the note author is
  notified (`notifyHeart`), and no gift-reply or living-room zap notice is
  written. If the invoice lookup for a receipt fails twice, the receipt is
  handled as a gift for the notice: `notifyZap` runs as for any gift.

### `GET /messages/:id/repayment`

Public credit ledger. No session. `:id` must be a UUID (`MESSAGE_ID_RE`); anything else is **404** `{ "error": "Not found" }`. **404** unless the note is live, top-level, `goalRepayable` true, and has a term. A local Sunday does not refuse this read.

Success → **Response** `200`:

```json
{
  "currency": "BTC",
  "fundedAt": null,
  "startsOn": null,
  "termDays": 30,
  "daysDue": 0,
  "daysPaid": 0,
  "waitingShares": 0,
  "unassignedSats": 0,
  "givers": [
    {
      "accountId": "<uuid>",
      "name": "Ada",
      "username": "ada",
      "givenSats": 21,
      "givenAmount": null,
      "canReceive": true
    }
  ],
  "repayments": [
    {
      "dayIndex": 0,
      "dueOn": null,
      "accountId": "<uuid>",
      "name": "Ada",
      "username": "ada",
      "amount": null,
      "sats": 21,
      "status": "scheduled",
      "waiting": false,
      "via": "lightning",
      "dueSats": null
    }
  ],
  "next": null
}
```

`currency` is `BTC`, `USD`, `CHF`, `EUR`, or `PHP`. `fundedAt` is ISO-8601 or null until collected sats first reach the ask. `startsOn` is the first repayment day as `YYYY-MM-DD` UTC (the `dueOn` of `dayIndex` 0), or null until then; it is the day after `fundedAt`, never before 2026-11-10. `dueOn` is `YYYY-MM-DD` UTC, or null until then. `givenAmount` and `amount` are two-decimal strings in the ask currency, or null for bitcoin. For a fiat ask, `sats` on a repayment is the paid share or null until it is paid. `status` is `paid`, `due`, or `scheduled`. `unassignedSats` is bitcoin with no 21.gifts payer and is not in the plan. `canReceive` is true when the giver has a receiving address (`receivingAddress(account, lnurlServer) !== null`: the LNURL server is configured and the giver has a verified wallet with a username); a giver without an account is false. `dueSats` is set on a line with `status: "due"`: the share in sats for a bitcoin loan, or for a fiat loan the share priced in sats at the rate `POST /messages/:id/repayment` would use now; it is `null` on every other line. The rate is read once per request, so `dueSats` and `next.sats` agree. `next` is the oldest unpaid due share whose giver can receive once the credit has filled, else null. `waiting` is true on a `due` line whose giver cannot receive, and `waitingShares` counts those lines. A due, unpaid share whose giver cannot receive is waiting: it does not hold back `daysPaid` and is not behind. When the giver's wallet is verified, the share can be paid from that day. A share whose day is before the UTC repayment day of the giver's `sparkPubkeyVerifiedAt` is still owed and payable, but never counts against `daysPaid` or as behind, so the waiting days do not become days behind later. `daysDue` counts the term days that have begun, today included; `daysPaid` counts the leading due days that have no other unpaid share. A 1-sat or 1-cent gift is its own row.

Fiat amount or gift-day rate missing, or the rate cannot be read → **503** `{ "error": "Ask amount is unavailable" }`. This holds whenever a fiat share is due, also when every due share waits for a giver who cannot receive.

### `POST /messages/:id/repayment`

Author pays the next giver share from their own wallet. Bearer session required. No body. A missing or invalid Bearer is **401** `{ "error": "Unauthorized" }`, including when `:id` is not a UUID. After a valid session, a non-UUID `:id` is **404** `{ "error": "Not found" }`. The share is the oldest due, unpaid share (oldest day first, then the order of the repayment list) whose giver can receive; a share whose giver cannot receive is skipped, so that giver does not block the others. The author pays the returned BOLT11. The description is `repay:<day>:<accountId>`. When that zap is indexed, the share is stored on `message_repayment` and `message.sats` does not rise. A repeat for the same unpaid share returns the outstanding invoice instead of minting another, including when the sat price of that fiat share has moved.

Success → **Response** `200`:

```json
{ "pr": "lnbc…", "amountSats": 21, "sparkInvoice": null }
```

`sparkInvoice` is a Spark invoice (`spark1…`) for the same amount to the
giver's verified wallet with memo `zap:<payment hash of pr>`, or `null`
when `pr` is not for exactly that amount or free in-app payments are off (see
[Free in-app payments](#free-in-app-payments)). A giver without a verified
wallet never reaches this 200; it is the **400** `cannot_receive` below. `pr` is unchanged, so a
payer without an in-app wallet still pays over Lightning.
The giver's address is the receiving address. An outstanding invoice is
returned for a repeat only while it was minted for that address. While an
open invoice minted for another address is still payable, the route answers
**409** `{ "error": "A payment for this share is still open" }` and mints
nothing, so the share cannot be paid twice; once it has expired, a new invoice
is minted for the wallet. A returned outstanding invoice carries the same Spark invoice
(issued on demand if it was minted before the feature was on).

Missing or invalid Bearer → **401** `{ "error": "Unauthorized" }`, including when `:id` is not a UUID.
Unknown id, a non-UUID after a valid session, a note that is not a live repayable ask, a credit that is not funded yet, or a caller who is not the author → **404** `{ "error": "Not found" }`. GET of that same unfunded credit stays **200**.
Nothing left to pay → **400** `{ "error": "Nothing is due" }`.
Note not payable yet → **400** `{ "error": "This message cannot be paid yet" }`.
Every due share belongs to a giver without a receiving address → **400** `{ "error": "A giver has no Lightning address", "code": "cannot_receive" }`. The same answer comes when the picked giver has lost the receiving address by the time the invoice is made (the pay-time check stays).
Giver without a Nostr key → **400** `{ "error": "A giver has no Lightning address" }` (no `code`).
An open invoice for this share minted for another address → **409** `{ "error": "A payment for this share is still open" }`.
Recipient wallet cannot take the payment → **400** `{ "error": "The recipient's wallet cannot receive this Bitcoin payment", "code": "cannot_receive" }`.
Other payment start failure → **400** `{ "error": "Could not start the Bitcoin payment" }`.
Author missing forum pay → **409** `{ "error": "missing_requirements", "missing": ["rules"] }`.
Device `Time-Zone` in Sunday → **403** `{ "error": "SUNDAY_REST" }`. A missing, blank, or invalid zone does not refuse.
Over-limit → **429** `{ "error": "Too many payments" }`.
Fiat share cannot be priced, including when the rate cannot be read → **503** `{ "error": "Ask amount is unavailable" }`. Any due share is priced first, so a fiat loan without a rate answers this 503 before the `cannot_receive` 400.
Signing keys missing or the invoice attempt cannot be stored → **503** `{ "error": "Messages are unavailable" }`.

### `POST /messages/:id/repayment/due`

Every payable repayment bill of one loan at once, so the author's in-app wallet can pay them without a request per share. Bearer session required. No body. The guards are those of `POST /messages/:id/repayment`: session, `forum.pay`, a live funded repayable ask written by the caller, Sunday rest, and the repayment invoice limiter.

Success → **Response** `200`:

```json
{
  "bills": [
    {
      "dayIndex": 3,
      "recipientAccountId": "<uuid>",
      "name": "Bruno",
      "username": "bruno",
      "amountSats": 500,
      "amount": null,
      "pr": "lnbc…",
      "sparkInvoice": "spark1…"
    }
  ],
  "waiting": [
    {
      "dayIndex": 3,
      "recipientAccountId": "<uuid>",
      "name": "Diego",
      "username": "diego",
      "amountSats": 200,
      "amount": null
    }
  ]
}
```

`bills` has one entry for every due (day index below `daysDue`), unpaid share whose giver can receive, oldest day first, then the order of the repayment list. Each bill is made exactly as `POST /messages/:id/repayment` makes it: a zap request tagging the credit note, description `repay:<day>:<accountId>`, a BOLT11 from the giver's wallet, a stored invoice attempt, and `sparkInvoice` when free in-app payments are on (else `null`, see [Free in-app payments](#free-in-app-payments)). An open, still-payable bill for the same share is returned again, never a second one. `waiting` lists the due, unpaid shares whose giver cannot receive (no verified wallet, or the giver's wallet refuses the zap); no bill is made for them. A giver whose wallet refuses the zap is asked once per call, and that giver's other due shares wait as well. `amountSats` is the share in sats (a fiat share is priced at the rate of `POST /messages/:id/repayment`); `amount` is the share as a two-decimal string in the loan's currency for a fiat loan, else `null`. Nothing due → **200** with both lists empty.

At most **60** bills per call. The remaining payable shares come on the next call. The repayment invoice limiter is asked once per call, by the first bill that has to be minted; a call that only returns open bills does not ask it.

Settlement is unchanged: the zap receipt, or the Spark invoice worker for a paid `sparkInvoice`, stores each paid share on `message_repayment`.

Missing or invalid Bearer → **401** `{ "error": "Unauthorized" }`, including when `:id` is not a UUID.
Unknown id, a non-UUID after a valid session, a note that is not a live repayable ask, a credit that is not funded yet, or a caller who is not the author → **404** `{ "error": "Not found" }`.
Author missing forum pay → **409** `{ "error": "missing_requirements", "missing": ["rules"] }`.
Device `Time-Zone` in Sunday → **403** `{ "error": "SUNDAY_REST" }`. A missing, blank, or invalid zone does not refuse.
Over-limit → **429** `{ "error": "Too many payments" }` (`Retry-After: 10`).
Debt or a fiat share cannot be priced, including when the rate cannot be read → **503** `{ "error": "Ask amount is unavailable" }`.
Any other error of `POST /messages/:id/repayment` while making a bill (`This message cannot be paid yet`, a giver without a Nostr key, `A payment for this share is still open`, `Could not start the Bitcoin payment`, `Messages are unavailable`) answers the whole call with that status and body. Bills minted before it stay stored and are returned again on the next call.

### `GET /messages/:id/photo`

Fetch the optional photo bytes for one forum message. Live rows need **no
bearer** — Damus loads this URL from kind:1 `imeta`. Missing message,
message-without-photo, and a non-UUID `id` are the same **404** (Postgres
would otherwise throw on `uuid` and become 503). A live reply without an
account whose author pubkey is not a recorded zapper (or that has no author
pubkey) is the same **404** on every photo and video route, matching
`GET /messages/:id`. Soft-hidden rows are **404** without a founder/moderator
Bearer. A founder/moderator Bearer serves hidden-row bytes with
`Cache-Control: private, no-store` and `Vary: Authorization` instead of the
live public cache header.

No photo for `id` → **Response** `404`:

```json
{ "error": "Photo not found" }
```

Store failure → **Response** `503`:

```json
{ "error": "Messages are unavailable" }
```

Success → **Response** `200`: raw image body, `Content-Type` one of
`image/jpeg` / `image/png` / `image/webp` (from stored magic-derived type),
`Cache-Control: public, max-age=86400` on a live public GET, or
`Cache-Control: private, no-store` plus `Vary: Authorization` on a staff
hidden GET. Not JSON.

Photo, video, and replies register **before** the public single-note
`GET /messages/:id` so `/photo`, `/video.mp4` (and `.webm` / `.mov`), and
`/replies` are not captured as an `:id`.

### `GET /messages/:id/photo/1.jpg`

Public extra still (no bearer). Same handler for `.jpeg` / `.png` /
`.webp` and indices **1–9**
(`GET /messages/:id/photo/{1-9}.{jpg|jpeg|png|webp}`). There is **no**
`/photo/0.jpg` (photo 0 remains `/photo.jpg`). Soft-hidden rows 404 even
when extra bytes remain, unless a founder/moderator Bearer is present
(then the same staff `Cache-Control: private, no-store` as photo 0).
Same live headers as photo 0 (`Content-Type`
jpeg/png/webp, `Cache-Control: public, max-age=86400`,
`Access-Control-Allow-Origin: *`,
`Content-Disposition: inline; filename="photo.jpg|png|webp"`). Missing
message, missing extra, non-UUID id, index 0, a file that does not
match `^([1-9])\.(jpg|jpeg|png|webp)$`, or a live reply without an account
whose author pubkey is not a recorded zapper → **Response** `404`:

```json
{ "error": "Photo not found" }
```

Store throw → **Response** `503`:

```json
{ "error": "Messages are unavailable" }
```

Success → **Response** `200`: raw image body.

### `GET /messages/:id/video.mp4`

Fetch optional video bytes for one forum message (same handler for
`.webm` and `.mov`). **No bearer** — Damus loads this URL from kind:1
`imeta`. Missing message, message-without-video, extension that does not
match the stored MIME, and a non-UUID `id` are the same **404**. Supports
`Range` / HTTP **206** and **416** (`Content-Range: bytes */SIZE`).

No video for `id` → **Response** `404`:

```json
{ "error": "Video not found" }
```

Store failure → **Response** `503`:

```json
{ "error": "Messages are unavailable" }
```

Success → **Response** `200` or `206`: raw video body,
`Content-Type` one of `video/mp4` / `video/webm` / `video/quicktime`,
`Accept-Ranges: bytes`, `Access-Control-Allow-Origin: *`,
`Cache-Control: public, max-age=86400` on a live public GET, or
`Cache-Control: private, no-store` plus `Vary: Authorization` on a staff
hidden GET. Not JSON.

### `GET /messages/:id/replies`

Public (Bearer optional). Lists **direct live attributed replies**
(`account_id IS NOT NULL OR (author_pubkey IS NOT NULL AND EXISTS
(SELECT 1 FROM nostr_zapper WHERE pubkey = lower(author_pubkey)))`) for parent
`:id` oldest-first (`createdAt` then `id` ascending), capped at **200**. Rows
with no account and no recorded-zapper pubkey are omitted. Each item is the
public message JSON (`photoCount` 0–10 always present;
`photoTakenAts` the same length, null when unknown, `[]` when there are no
stills; `photoTakenAt` only when `photoCount` is 1; `hasPhoto` still means
photo 0 exists) with
`payable` when a member row has a non-empty `eventId` and the author has a
receiving address (see [Receiving address](#receiving-address)),
`authorCanReceive` when the author has a receiving address, signed or not, and no `replyCount`. Items include `accountId` whenever
the stored author id is non-null, with or without a session. External replies
set `via: "nostr"`, keep `payable: false` and `authorCanReceive: false`, and omit `accountId`, `role`, and the
pubkey. Replies never include `goalSats`, `goalRepayable`, or `goalTermDays`.
Photo and video bytes are never included. `:id` is a UUID
(`MESSAGE_ID_RE`).

Unsigned/non-staff: hidden children are omitted. A founder/moderator Bearer
is **200** `{ "messages" }` from `listReplies(id, limit, true)` including
hidden attributed children with hide stamps, `payable: false`, and `authorCanReceive: false`, whether
the parent is live or hidden (live children stay live serialize).

`:id` is not a UUID, the parent is missing, or (unsigned/non-staff) the
parent is soft-hidden
→ **Response** `404`:

```json
{ "error": "Not found" }
```

Store failure → **Response** `503`:

```json
{ "error": "Messages are unavailable" }
```

Success → **Response** `200`:

```json
{
  "messages": [
    {
      "id": "<uuid>",
      "name": "Ada",
      "text": "A reply",
      "createdAt": "2026-08-28T12:01:00.000Z",
      "sats": 0,
      "payable": false,
      "authorCanReceive": true,
      "hasPhoto": false,
      "photoCount": 0,
      "photoTakenAts": [],
      "hasVideo": false,
      "videoContentType": null,
      "role": "basis"
    }
  ]
}
```

An empty reply thread is **200** with `"messages": []`. Soft-hidden and
unattributed null-account children (`accountId` and `authorPubkey` both null)
are omitted from the list, as is a null-account child whose `authorPubkey` is
set but is not a recorded zapper (retroactively included once that pubkey zaps).

### `GET /messages/stats`

Public count of living forum notes and replies as one number. No auth.
`postCount` is every `message` row with `deleted_at` null, including replies
and profile notes. `postsOverTime` is that count for each UTC day from the
earliest living row through today, or through a later row when one exists.
Days with no row are filled with `postCount` 0. The series sums to
`postCount`. An empty forum is **200** `{ "postCount": 0, "postsOverTime": [] }`.

**Response** `200`:

```json
{
  "postCount": 2,
  "postsOverTime": [
    { "day": "2026-08-01", "postCount": 2 },
    { "day": "2026-08-02", "postCount": 0 }
  ]
}
```

**Response** `503`: `{ "error": "Post stats are unavailable" }` when the count
query throws.

### `GET /links/:code`

Public. No Bearer. `:code` is lowercased and not trimmed. Anything other than
exactly eight hex digits is **400** `{ "error": "invalid_code" }` and does not
query the stores. Zero matches is **404** `{ "error": "not_found" }`. Two or
more matches (two messages, two accounts, or one of each) is **409**
`{ "error": "ambiguous" }` and the body does not list ids. Exactly one message
is **200** `{ "kind": "message", "id" }` with the id lowercased. Exactly one
account is **200** `{ "kind": "member", "id" }` with the id lowercased.
Soft-hidden messages count. The prefix match is case-insensitive and stops at
two ids per store.

### `GET /messages/:id/external-profile`

Public profile for an external author. No Bearer. Registered **before**
`GET /messages/:id`. **200**
`{ "name", "npub", "postCount", "replyCount", "shopCount", "creditCount" }`
and, when present, `nip05` and `lud16`. `name` is the stored snapshot
(truncated pubkey when blank). A live kind 0 name replaces it only when
`externalDisplayName` accepts it. `npub` is the NIP-19 bech32 encoding of
the stored 64-hex author pubkey. `postCount` and `replyCount` are always
present, including 0: uncapped live top-level notes, and uncapped live
public replies (`replyCount` is 0 when the pubkey is not a recorded
zapper). `shopCount` is always present, including 0: the uncapped count of
live top-level unassigned `#21GiftsShop` notes for that pubkey. A note assigned
to a member is not counted as an external shop. `creditCount` is always present,
including 0: the uncapped count of live top-level notes with
`goalRepayable` exactly true for that pubkey. `nip05` requires `fetchImpl` and
a guarded HTTPS `/.well-known/nostr.json` whose `names` entry matches the
pubkey. `lud16` must be `user@host` and is not fetched. No hex pubkey,
picture, callback, or invoice. **404** `{ "error": "Not found" }` for a
bad id, a missing or deleted row (staff included), a withheld reply, a
member author, or a pubkey that is not 64 hex. **503**
`{ "error": "Messages are unavailable" }` when the store or account list
throws (`messages.external_profile.failed`). Relay, DNS, and well-known
failures omit the failed field and stay 200.

### `GET /messages/:id/external-posts`

Public list of live top-level notes for an external author. No Bearer.
Registered **before** `GET /messages/:id`. Same 404 gate as
`GET /messages/:id/external-profile`. **200** `{ "messages" }` capped at
200, newest first (`createdAt` desc, `id` desc). Each item includes
`replyCount` of live attributed children, `payable` and `authorCanReceive` false, `via: "nostr"`,
and omits `role`. **503** `{ "error": "Messages are unavailable" }`
(`messages.external_posts.failed`). A serialize failure skips that row
and still returns 200.

### `GET /messages/:id/external-shops`

Public list of live, unassigned top-level `#21GiftsShop` notes for an external
author. No Bearer. Registered **before** `GET /messages/:id`. Same 404 gate as
`GET /messages/:id/external-profile`. **200** `{ "messages" }` capped at 200,
newest first (`createdAt` desc, `id` desc). Each item includes `replyCount` of
live attributed children, `payable` and `authorCanReceive` false, `via: "nostr"`, and omits `role`.
**503** `{ "error": "Messages are unavailable" }`
(`messages.external_shops.failed`). A serialize failure skips that row and
still returns 200.

### `GET /messages/:id/external-credits`

Public list of live top-level credit notes for an external author. No Bearer.
Registered **before** `GET /messages/:id`. Same 404 gate as
`GET /messages/:id/external-profile`. **200** `{ "messages" }` capped at 200,
newest first (`createdAt` desc, `id` desc). Each item includes `replyCount` of
live attributed children, `payable` and `authorCanReceive` false, `via: "nostr"`, and omits `role`.
**503** `{ "error": "Messages are unavailable" }`
(`messages.external_credits.failed`). A serialize failure skips that row and
still returns 200.

### `GET /messages/:id/external-replies`

Public list of live public replies for an external author. No Bearer.
Registered **before** `GET /messages/:id`. Same 404 gate as
`GET /messages/:id/external-profile`. **200** `{ "messages" }` capped at
200, newest first (`createdAt` desc, `id` desc). Each item includes
`parentId`, omits `replyCount`, `payable` and `authorCanReceive` false, `via: "nostr"`, and omits
`role`. A non-zapper author's list is empty. **503**
`{ "error": "Messages are unavailable" }` (`messages.external_replies.failed`).
A serialize failure skips that row and still returns 200.

### `GET /messages/:id`

Public single-note fetch. Live rows need **no Bearer.** `:id` is a UUID.
Registered **after** photo, video, `GET /messages/:id/replies`,
`GET /messages/:id/external-profile`,
`GET /messages/:id/external-posts`, `GET /messages/:id/external-shops`,
`GET /messages/:id/external-credits`, `GET /messages/:id/external-replies`,
`DELETE /messages/:id`, `PATCH /messages/:id/place`, `PATCH /messages/:id/shop-account`, `PATCH /messages/:id/text`, `PATCH /messages/:id/photos`, `GET /messages/:id/edits`, `GET /messages/stats`, `GET /messages/hidden`, and
`GET /messages/places` so
those paths are not captured as `:id`. A live GET returns
the public message JSON (`sats`, optional `goalSats` on a top-level note
when the stored ask is a positive integer, optional `goalRepayable: true`
when the stored column is true (omitted when null; never false), optional
`goalTermDays` when the stored column is not null (omitted when null), and when
`goalCurrency` is stored also `goalCurrency`, `goalAmount`, and the four
`goalAmount*` snapshots — a snapshot may be null, a legacy row omits those
keys — optional `place` (`{ lat, lng, label, address }` when a pin is stored;
`address` is the structured postal address or JSON `null`; omitted when unset),
optional `shopAccount` (`{ id, username, name }`) when a shop account is
stored (omitted when unset or when that account has no username, even when
`accountId` is omitted; a note whose till account has no username can still
be a listed shop), and always
`shopNpub` (the listed-shop npub or JSON null),
`payable`, `authorCanReceive`, `hasPhoto`, `photoCount`
(0–10; always present; `hasPhoto` still means photo 0 exists), `photoTakenAts`
(always; length equals `photoCount`; null when unknown; `[]` when there are no
stills) and `photoTakenAt` only when `photoCount` is 1, `hasVideo`,
`videoContentType`; live `role` for 21gifts authors). Live JSON includes
`accountId` whenever the stored author id is non-null, with or without a
session, and omits it for an external author. Live JSON also omits
`deletedAt` and `deletedBy`. Unsigned and non-staff GET of a
soft-hidden row is still **404** `{ "error": "Not found" }` with no hide
stamps in the body. A founder/moderator Bearer (`roleAtLeast(...,
'moderator')`, no `forum.read`) of a hidden row is **200** public JSON plus
`deletedAt` ISO, `deletedBy.{id,name,role}`, `payable: false`,
`authorCanReceive: false`, and `accountId` for 21gifts authors. A live reply with `accountId` null
returns **200** only when `authorPubkey` is set and that pubkey is a recorded
zapper (checked via `isZapperPubkey` on every read, including during a
`sinceSats` poll loop); that **200** includes `via: "nostr"`, omits `role`,
and sets `payable` and `authorCanReceive` false. Otherwise (no `authorPubkey`, or an `authorPubkey`
that is not yet a recorded zapper) it is **404** `{ "error": "Not found" }`
(same body as missing/hidden). A top-level note (parent id null), on both the
live public body and the founder/moderator hidden body, includes `replyCount`
of live direct children with an account or a recorded zapper pubkey; 0 is
included, not omitted; a reply omits `replyCount`. Photo and video bytes
are never included. Soft-hidden rows
(`deletedAt` set) are treated as missing (404) before any missing-video
hard-delete cleanup.

Optional query `sinceSats` (non-negative integer string, `/^\d+$/`):
long-polls until that note's `sats` is **strictly greater than** `n`, then
returns the same **200** public JSON as an immediate GET. First read may
return immediately when `sats` is already higher. `sats === n` keeps
waiting. Timeout (~25s) still returns **200** with the current body (never
204/202/304); the client retries. Absent `sinceSats` is unchanged
immediate GET. Invalid `sinceSats` (`-1`, `1.5`, `abc`, empty, `+1`,
whitespace) → **400** after the UUID check (non-UUID `:id` stays **404**
even when `sinceSats` is present). Soft-hidden / missing during the wait
(including the first read) → **404**. Store throw on any read → **503**.

Non-UUID `:id`, missing row, soft-hidden row, or a live null-account reply
whose pubkey is missing or not a recorded zapper →
**Response** `404`:

```json
{ "error": "Not found" }
```

Invalid `sinceSats` → **Response** `400`:

```json
{ "error": "Expected sinceSats to be a non-negative integer" }
```

Store failure → **Response** `503`:

```json
{ "error": "Messages are unavailable" }
```

Success (including `sinceSats` timeout with unchanged sats) → **Response**
`200`:

```json
{
  "id": "<uuid>",
  "name": "Ada",
  "text": "Thank you!",
  "createdAt": "2026-08-28T12:00:00.000Z",
  "sats": 0,
  "payable": false,
  "authorCanReceive": true,
  "hasPhoto": false,
  "photoCount": 0,
  "photoTakenAts": [],
  "hasVideo": false,
  "videoContentType": null,
  "role": "basis",
  "replyCount": 0
}
```

### `DELETE /messages/:id`

Staff soft-hide. Bearer session required. Live role must be at least
`moderator` (authors with `basis` / `verified` get 403 even on their own
post). Stamps `deleted_at` / `deleted_by` on the target row and every
**direct** reply that is not yet tagged. Does **not** hard-delete the
Postgres row, photo bytes, on-disk video, invoices, zap receipts, or gift
records; does **not** call `deleteById` / `DELETE FROM message`. Already
tagged targets keep their original stamps and still return 204.
`getById` continues to return tagged rows for workers; public/member HTTP
reads treat them as missing. After a successful stamp (including already
tagged), best-effort `listChildIds` then
`deleteByMessageIds([id, ...childIds])` retracts in-app notifications
whose `parentId` or `replyId` is the note or a direct child. Retract
failure still **204**.

When the target itself is an external Nostr row (`accountId` null and
`authorPubkey` set), the same successful operation also records a durable
staff block for that pubkey and soft-hides every other live external row by
that author. The block prevents later gift-replies and inbound replies but
does not remove `nostr_zapper` entitlement or reverse credited sats. Hiding a
member note that merely has external children does not block those authors.
Restore does not undo this author-wide cascade in bulk; see
`POST /debug/messages/:id/restore` for its source-row unblock and per-row
unhide semantics.

After a successful stamp (including already tagged), the process best-effort
publishes NIP-09 `kind: 5` for the target and each **direct** child that has a
non-empty `eventId` and a non-null `accountId`, signed with **that row's**
custodial nsec (not the staff deleter). Relays are the durability space URL
plus the public list (Damus / Primal / nos.lol) even when
`NOSTR_PUBLISH` / `NOSTR_PUBLISH_PUBLIC` are unset. Gift-only rows
(`eventId` null) and Damus-only rows (`accountId` null) are skipped. Then,
when `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_API_TOKEN` are set and
`PUBLIC_BASE_URL` resolves, it purges cached public photo/video URLs for
those rows (Cloudflare `purge_cache` files, chunks of 30). Sign, publish, or
purge failure logs `messages.delete.nostr_failed` / `messages.delete.purge_failed`
/ `messages.delete.retract_failed` with `messageId` only (never nsec, token,
or post text) and the HTTP status stays **204**. `POST /debug/messages/:id/restore`
does not retract or un-purge.

Missing/invalid/expired bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

Live role is not at least moderator → **Response** `403`:

```json
{ "error": "Forbidden" }
```

`:id` is not a UUID, or no row with that id → **Response** `404`:

```json
{ "error": "Not found" }
```

Success (including already tagged) → **Response** `204` empty body.

Store failure → **Response** `503`:

```json
{ "error": "Messages are unavailable" }
```

On success the process logs `messages.deleted` with `messageId`,
`accountId`, and the staff `role` (never the post text). An external-target
block additionally logs `messages.external.blocked` with only `messageId` and
the hidden-row count, never the pubkey. On store throw it logs
`messages.delete.failed`.

Hiding a shop note that has a key queues its OpenCryptoPay place outbox in
the same write (`trg_shop_identity_place` on `deleted_at`), whatever its pin
was when the route read it, because a pin set concurrently may already be on
the map. The sender sends DELETE to `/map/places` only when this outbox has
already sent the place (`ocp_revision` greater than 0). A key that was never
sent, including one stored from an existing map identity, is not deleted. A
photo update does not raise that revision. A note without a key was never
sent, and nothing is queued.
Delivery is asynchronous; a failure never changes the 204.

### `PATCH /messages/:id/place`

Staff map pin on a live top-level shop note (`#21GiftsShop`). No rules
gate. Checks run in this order: Bearer session required (**401**
`{ "error": "Unauthorized" }`); live role must be at least `moderator`
(**403** `{ "error": "Forbidden" }`); `:id` must match `MESSAGE_ID_RE` or
the response is **404**; body is JSON via `c.req.json()` and a non-JSON
body or an object with no `place` key is **400**
`{ "error": "Invalid body" }`; `normalizePlace` accepts a pin or `null` — a bad coordinate is **400**
`{ "error": "Place must be a latitude and longitude" }`, a label over 80
characters is **400** `{ "error": "Place label must be at most 80 characters" }`,
an invalid structured address is **400**
`{ "error": "Place address is invalid" }`; a missing or hidden row is
**404** `{ "error": "Not found" }` and no write; a reply is **400**
`{ "error": "A reply cannot include a place" }`; a non-shop top-level
note is **400** `{ "error": "Only a shop note can set a place" }`; `null`
on a live shop note is **400** `{ "error": "Shop name is required" }` and
nothing is stored, so this route does not clear a shop name; for a pin
`shopPlaceProblem` is **400** with `Shop name is required`,
`Shop address is required`, or `Shop name must not contain the address`
and nothing is stored; then `shopTextProblem` against the stored text is
**400** `{ "error": "Shop description must be 20 to 1000 characters and longer than the shop name" }`
and nothing is stored.
`setPlace` false → **404**. Store throw → **503**
`{ "error": "Messages are unavailable" }` and `messages.place.failed`.

Success → **200** live public message JSON (optional `place`, reply count,
no hide stamps). Logs `messages.place.updated` with `messageId`,
`accountId`, and `role` only. Text and publish state are unchanged. A real
pin change appends `message_edit`. An identical pin does not. A pin change
on a shop with a key queues its OpenCryptoPay place outbox in the same
write. The sender reads the note when it sends: a listed shop gets PUT to
`/map/places`. A public shop that is not listed clears the place flag and
sends nothing, so a pin that is incomplete leaves the map place as it is.
This route does not accept `place: null`, so it does not queue a clear.
A shop that is no longer public (tag removed, till account cleared, hidden,
or gone, also by a concurrent request) gets DELETE only when this outbox has
already sent the place (revision greater than 0). A key that has never been
sent is not deleted. A later complete pin before the send is one PUT.
Each send carries a new revision, so concurrent edits of one shop reach the
map in order and the last send matches the last write.

### `PATCH /messages/:id/shop-account`

Staff assignment of a 21.gifts account on a live top-level shop note
(`#21GiftsShop`). The assignment is not the note author. Bearer session
required. Live role must be at least `moderator`. No rules gate. `:id`
must match `MESSAGE_ID_RE` or the response is **404**. Body is JSON via
`c.req.json()`; a non-JSON body or an object with no `username` key is
**400** `{ "error": "Invalid body" }`. After the row is a live top-level shop note, `username: null` is **400** `{ "error": "A shop note needs a shop account" }` and nothing is stored. A missing or hidden row with `username: null` stays **404**. A string
is trimmed, one leading `@` is stripped, then `normalizeUsername`. An
invalid username is **400** `{ "error": "Username is not valid" }`.
Missing or hidden row → **404** `{ "error": "Not found" }` and no write,
before the handle is looked up. A reply → **400**
`{ "error": "A reply cannot include a shop account" }`. A non-shop
top-level note → **400**
`{ "error": "Only a shop note can set a shop account" }`. On a live shop
note, an unknown username, or a stored username that is null or blank,
is **404** `{ "error": "No account with that username" }`.
`setShopAccount` false, or a row that disappears before reload, → **404**.
Store throw → **503** `{ "error": "Messages are unavailable" }` and
`messages.shop_account.failed`.

Success → **200** live public message JSON including `shopAccount`
`{ id, username, name }` (reply count, no hide stamps). Logs `messages.shop_account.updated` with `messageId`,
`accountId`, and `role` only. Text, place, and publish state are
unchanged. The write stores only `shop_account_id`. A real change appends `message_edit`. An unchanged account does not. The same account id with a new name or username is unchanged.
A real change on a shop with a key queues its OpenCryptoPay place outbox in
the same write. The sender reads the note when it sends: a listed shop gets
PUT, a public shop that is not map-complete sends nothing, and a note that
is hidden or gone by then (also concurrently), or whose till account was
cleared, gets DELETE only when this outbox has already sent the place
(revision greater than 0).

### `PATCH /messages/:id/text`

Staff replacement of the body of a live top-level shop note (`#21GiftsShop`). Bearer session required. Live role must be at least `moderator`. Checks run in this order: `:id` must match `MESSAGE_ID_RE` or the response is **404**; a non-object body or a missing string `text` is **400** `{ "error": "Invalid body" }`; text outside 1–8000 characters is **400** before the row is read; a missing or hidden row is **404** `{ "error": "Not found" }`; a reply is **400** `{ "error": "A reply cannot be edited" }`; a non-shop note is **400** `{ "error": "Only a shop note can be edited" }`; empty text on a note with no photo and no video is **400** `{ "error": "Text must be 1–8000 characters or include a photo" }`. The shop tag is kept or restored, and if that makes the text longer than 8000 characters the response is **400** `{ "error": "Text must be 1–8000 characters" }`. When the note already has a complete pin (it passes `shopPlaceProblem`), `shopTextProblem` on the new text is **400** `{ "error": "Shop description must be 20 to 1000 characters and longer than the shop name" }` before the identical-body short-circuit; name and address are not re-checked here. An unchanged body is **200** without `message_edit` and without a new outbox generation. A real change writes the body and `message_edit` together, creates the shop identity when needed, queues the durable OpenCryptoPay place outbox, and is **200** public message JSON; delivery is asynchronous. The sender reads the note when it sends: a listed shop gets PUT, a public shop that is not map-complete sends nothing and keeps its key, and a shop that is no longer public gets DELETE only when this outbox has already sent the place (revision greater than 0). A key that has never been sent, including one adopted from OpenCryptoPay and a public shop whose pin never had an address, is not deleted. Store throw → **503** `{ "error": "Messages are unavailable" }` and leaves the previous body with no new history row.

### `PATCH /messages/:id/photos`

Staff replacement of the stills on a live top-level shop note. Bearer session required. Live role must be at least `moderator`. Checks run in this order: `:id` must match `MESSAGE_ID_RE` or the response is **404**; the body must be `{ "photos": [{ "contentType", "data", "takenAt?" }] }` with at most 10 items, and a bad photo is **400** `{ "error": "Photo must be a JPEG, PNG, or WebP under 1 MiB" }`, before the row is read (a missing or hidden row with a bad photo is still that **400**); a missing or hidden row is then **404** `{ "error": "Not found" }`; a reply is **400** `{ "error": "A reply cannot be edited" }`; a non-shop note is **400** `{ "error": "Only a shop note can be edited" }`. An empty list clears stills. A video on the note stays. The stills are replaced in one write. This write does not append `message_edit`. Success is **200** public message JSON. Store throw → **503**.

### `GET /messages/:id/edits`

Staff history for a top-level shop note, newest first, including a hidden shop note. Bearer session required. Live role must be at least `moderator`. GET is not a Sunday write. Success is **200** `{ "edits": [{ "id", "createdAt", "field", "before", "after", "actor" }] }`. `createdAt` is ISO. `field` is `"text"`, `"place"`, or `"shopAccount"` (SQL `shop_account` is published as `shopAccount`). `before` and `after` are the previous and next value: a text string, a place pin or null, or a shop account `{ "id", "username", "name" }` or null (`username` is null when the till account had none). `actor` is `{ "id", "name", "role" }`. A missing account keeps `{ "id", "name": null, "role": null }`. Empty history `{ "edits": [] }` is only for an existing top-level shop note, including a hidden one. A non-UUID `:id`, a missing row, a reply, or a non-shop note is **404** `{ "error": "Not found" }`. Public message JSON does not include `edits`.

Operator access: `DEBUG_TOKEN` or `DEBUG_READ_TOKEN` as Bearer returns the same body without a session or role check. A bearer that matches neither token falls through to the session rules above.

### `GET /messages/hidden`

Staff hidden-note log. Inverse **read** of `DELETE /messages/:id`. Bearer
**session** required (moderator), or an operator token (below). Registered **before** public `GET /messages/:id` so
`"hidden"` is not captured as `:id`. No `forum.read` gate — a
moderator without rules agreement is still **200**. Listed rows
include every hidden row regardless of external-zapper entitlement — the
moderation view is intentionally unaffected by the public read-visibility
rule.

Operator access: `DEBUG_TOKEN` or `DEBUG_READ_TOKEN` as Bearer returns the same body without a session or role check. A bearer that matches neither token falls through to the session rules above.

Lists only rows with `deletedAt` set, newest-hidden first (`deletedAt`
desc, then `id` desc), capped at **200**. JSON `{ "messages": [ … ] }`
via `serializeHiddenMessage`. Each item includes stored `name` (no
empty-name pubkey fallback), ISO `createdAt` / `deletedAt`, `hasPhoto` /
`photoCount` (0–10; always present; `hasPhoto` still means photo 0 exists) /
`photoTakenAts` (always; length equals `photoCount`; null when unknown; `[]`
when there are no stills) and `photoTakenAt` only when `photoCount` is 1 /
`hasVideo` / `videoContentType`, optional `goalSats` (positive integer on a
top-level note; omitted when unset/null/0 or on a reply), optional
`goalRepayable: true` when the stored column is true (omitted when null;
never false), optional `goalTermDays` when the stored column is not null
(omitted when null), and when `goalCurrency` is stored also `goalCurrency`,
`goalAmount`, and the four `goalAmount*` snapshots (a snapshot may be null;
a legacy row omits those keys), optional `place` (`{ lat, lng, label, address }`
when a pin is stored; `address` is the structured postal address or JSON `null`;
omitted when unset), optional `shopAccount`
(`{ id, username, name }`) when a shop account is stored (omitted when
unset or when the till account has no username), always-present `parentId` (JSON `null`
on top-level), optional `via: "nostr"` exactly when `accountId === null &&
authorPubkey !== null` (the same rule as public message JSON), and
`deletedBy: { id, name, role }` resolved from
`authStore.getAccount` (missing account keeps that id with `name` /
`role` null; null `deletedBy` is `{ id: null, name: null, role: null }`).
Includes `accountId` for a 21gifts author and omits it for an external row.
Never includes `authorPubkey`, `eventId`, `nostrPublishState`,
`payable`, `authorCanReceive`, author `role`, `nostrEvent`, `claimedUntil`, `contentFp`, nsec,
or photo/video bytes. Public list/GET/photo stay **404** for hidden rows.
A founder/moderator session may GET the hidden permalink and photo/video.
No staff UNHIDE session route (`POST /debug/messages/:id/restore` remains
`DEBUG_TOKEN` only).

Missing/invalid/expired bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

Live role is not at least moderator → **Response** `403`:

```json
{ "error": "Forbidden" }
```

Store, deleter lookup, or serialize throw → **Response** `503`:

```json
{ "error": "Messages are unavailable" }
```

Success (including an empty list) → **Response** `200`:

```json
{
  "messages": [
    {
      "id": "<uuid>",
      "name": "Ada",
      "text": "hidden",
      "createdAt": "2026-08-28T12:00:00.000Z",
      "sats": 0,
      "hasPhoto": false,
      "photoCount": 0,
      "photoTakenAts": [],
      "hasVideo": false,
      "videoContentType": null,
      "parentId": null,
      "deletedAt": "2026-09-01T12:00:00.000Z",
      "deletedBy": { "id": "<uuid>", "name": "Ada", "role": "moderator" }
    }
  ]
}
```

On success the process logs `messages.hidden.listed` with `{ count }`
only (never post text, never message ids). On throw it logs
`messages.hidden.list_failed`.

### `POST /contact`

Private in-app contact mailbox. Bearer session required. Body:

```json
{ "text": "…" }
```

The account must already have a non-blank display name. The api stores a
**name snapshot** (trimmed account name at post time), the normalised text,
and a timestamp. Text goes through `normalizeForumText` (newlines `\n`/`\r`
allowed; other C0 and DEL rejected), then contact still requires trimmed
length **1–8000**. Forum photo-only empty text is not accepted here. The
**200** body is the public contact object itself (not wrapped). No
`accountId` in the member-facing JSON. Contacts are **never** listed
publicly — operators still read the mailbox via `GET /debug/contacts`
(`DEBUG_TOKEN` must not read member PNs). After the platform account exists,
the contact row is persisted first, then the same text is appended to the
member→platform conversation thread so it is readable via
`GET /conversations`. A successful conversation append enqueues
`type: conversation` Web Push to bell-subscribed counterparts
(`url` `/messages?c=<id>`). DMs are not copied into Notification rows.
Push failure is logged (`conversations.push.failed`) and does not change
**200**. Conversation append failure logs
`conversations.contact_sync.failed` and still returns **200** (contact is
the product surface). When no platform account (`isPlatform`) exists
(neither contact nor thread is written) →
**Response** `503`:

```json
{ "error": "Platform account is not configured" }
```

No email. Outbound Nostr fan-out is the conversation worker (NIP-17 wrap),
not this HTTP handler.

Missing/invalid/expired bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

Body is not JSON with a `text` string → **Response** `400`:

```json
{ "error": "Expected a JSON body with a \"text\" string" }
```

Missing required fields (`requireAction` `contact.post`) → **Response** `409`:

```json
{ "error": "missing_requirements", "missing": ["rules", "name", "username"] }
```

Text empty, longer than 8000 after trim, or contains a disallowed control →
**Response** `400`:

```json
{ "error": "Text must be 1–8000 characters" }
```

Store failure → **Response** `503`:

```json
{ "error": "Contact is unavailable" }
```

Success → **Response** `200`:

```json
{
  "id": "<uuid>",
  "name": "Ada",
  "text": "Hello",
  "createdAt": "2026-08-29T12:00:00.000Z"
}
```

### `GET /conversations`

Bearer session required. Nothing public. Lists threads the session may see:
own member↔member / member↔Damus / member↔platform threads, plus (when
the role is at least `moderator`) every platform thread. A thread is
listed when it has an inbound message for the viewer, or when its latest
message is from the viewer (the actor, else the sender). Empty threads
stay omitted. One-sided rows are `unread: false`. The member's own
`member_platform` contact thread is listed when
it has a message, even if outbound-only. Damus inbound (null sender) is
inbound and listed. This list never includes `moderator_group` regardless of
role. The closed group is `GET /conversations/moderator-group`
only. `GET /conversations/:id` and
`POST` still return/open outbound-only and empty threads. Newest
`lastMessageAt` first. Cap 200. List/open rows may include optional
`accountId` of the counterpart 21.gifts account (omitted for Damus-only
counterparts). Member JSON never includes event ids or npubs; Damus-only
counterpart `name` may be a truncated npub.

Missing/invalid/expired bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

Store failure → **Response** `503`:

```json
{ "error": "Conversations are unavailable" }
```

Success → **Response** `200`:

```json
{
  "conversations": [
    {
      "id": "<uuid>",
      "kind": "member_member",
      "name": "Ada",
      "lastText": "Hello",
      "lastMessageId": "<uuid>",
      "lastAt": "2026-08-29T12:00:00.000Z",
      "lastFromMe": false,
      "lastSats": 0,
      "unread": true,
      "unreadMessageCount": 1,
      "accountId": "<uuid>",
      "canReceive": true
    }
  ],
  "unreadCount": 1
}
```

`lastMessageId` is the id of the same newest row as `lastText` (`created_at`
then `id`, both descending), or `null` when the thread has no message.
`unreadCount` is the number of listed rows with `unread: true` (same
cap, not a second uncapped query). The menu/PWA badge matches that
number because a row kept only because its latest message is from the
viewer is `unread: false`. Per-row
`unreadMessageCount` is the number of inbound messages strictly after
last-read (`0` when none; gift-only inbound counts; outbound does not).
Per-row `unread` is `unreadMessageCount > 0` (outbound-only listed rows,
including contact tickets, are `false`). List GET does not stamp
last-read. `accountId` is the
counterpart 21.gifts account. It is omitted for Damus-only counterparts
(never JSON `null`). `canReceive` is always present: true when that
counterpart has a receiving address (see [Receiving address](#receiving-address)),
false for a counterpart without a 21.gifts account, a missing account, and the moderator group.
The same row shape is returned by `POST /conversations` and
`GET /conversations/moderator-group`.

### `GET /conversations/moderator-group`

Bearer session required. A session that is at least moderator (`roleAtLeast`
`moderator`; the platform account is never a member of the group, whatever
role it carries) opens or inserts the closed singleton and receives it as
`{ "conversation": { ... } }` (same public row as a list item, `kind`
`moderator_group`, `name` `Moderators`, `unread` / `unreadMessageCount` from
`countUnread`). Verified, basis
and the platform account get
**404** `{ "error": "Not found" }` (no existence leak). Missing platform
account or store failure → **503** `{ "error": "Conversations are unavailable" }`.
Unauthenticated → **401**.

### `POST /conversations`

Bearer session required. Open or return the thread with a forum note's
author (`21gifts` account or Damus pubkey). Body:

```json
{ "forumMessageId": "<uuid>" }
```

Unknown / non-UUID note → **404** `{ "error": "Not found" }`. Author is
the session account → **400** `{ "error": "Cannot message yourself" }`.

Success → **Response** `200` (same public conversation object as list
rows, including `unread`, `unreadMessageCount`, and optional counterpart
`accountId`; empty new thread is `unread: false` and `unreadMessageCount: 0`).

### `GET /conversations/:id`

Bearer session required. `:id` is a UUID. Messages oldest-first (cap 200).
The envelope is `{ "messages": [...] }` only (no counterpart `accountId`
on the thread). Each message may include optional `accountId`: members
always see the stored sender; staff see the actor when `actorAccountId`
is set, otherwise the sender. A paid moderator stipend also includes
optional `giftFor`: the id of the group message that triggered it
(omitted on every other row).
**404** `{ "error": "Not found" }` when the id is not a UUID, the thread is
missing, or the session may not see it. Kind includes `moderator_group`;
verified, basis and the platform account get **404**
`{ "error": "Not found" }` on that id (no existence leak). A moderator
(`isModeratorGroupMember`) gets **200**.

A platform stipend row in `moderator_group` (`POST /invoices/proof` with
`groupMessageId`) has no actor and the platform account as sender, so it is
`fromMe: false` and inbound for every member. That row's `giftFor` is the
triggering message id so the app can render it attached under that message.

Optional query `sinceMessageId` (UUID): long-polls until that message id is in
the thread (pay-sheet confirmation). Timeout still **200** with the current
messages (the id may be absent). Invalid value → **400**
`{ "error": "Expected sinceMessageId to be a UUID" }`. Missing/forbidden
thread → **404** immediately.

Success → **Response** `200`:

```json
{
  "messages": [
    {
      "id": "<uuid>",
      "name": "Ada",
      "text": "Hello",
      "createdAt": "2026-08-29T12:00:00.000Z",
      "fromMe": true,
      "sats": 0,
      "amountUsd": null,
      "amountChf": null,
      "amountEur": null,
      "amountPhp": null,
      "hasPhoto": false,
      "photoCount": 0,
      "accountId": "<uuid>"
    },
    {
      "id": "<uuid>",
      "name": "21.gifts",
      "text": "21gifts moderator · Ada",
      "createdAt": "2026-08-29T12:00:02.000Z",
      "fromMe": false,
      "sats": 6158,
      "amountUsd": null,
      "amountChf": null,
      "amountEur": null,
      "amountPhp": null,
      "hasPhoto": false,
      "photoCount": 0,
      "accountId": "<uuid>",
      "giftFor": "<uuid of the message above>"
    }
  ]
}
```

`accountId` is omitted when the projected account is null (Damus inbound;
never JSON `null`). `giftFor` is omitted when the row is not a paid gift
for another message (never JSON `null`). Members always receive the stored
sender (typically `21.gifts` on a platform send). Staff receive the actor
when `actorAccountId` is set. `fromMe` / list `lastFromMe` use the actor
when set, otherwise the sender; there is no staff-as-platform shortcut.
`hasPhoto` / `photoCount` (0–10) flag stills; bytes are never in this JSON.
List rows also include `lastSats` (0 when the last message is unpaid text).

### `GET /conversations/:id/messages/:messageId/photo`

Bearer session required. Private photo 0 bytes after `getById` + `canAccess`.
No Damus `.jpg` alias and no public CDN: success is raw image bytes with
`Content-Type` jpeg/png/webp, `Content-Disposition: inline; filename="photo.{jpg|png|webp}"`,
`Cache-Control: private, no-store`, and **no** `Access-Control-Allow-Origin`.
Missing/forbidden thread → **404** `{ "error": "Not found" }`. Missing still,
non-UUID message id, or a message in another thread → **404**
`{ "error": "Photo not found" }`. No bearer → **401**. Store throw → **503**
`{ "error": "Conversations are unavailable" }` (`conversations.photo.failed`).

These routes register **before** `GET /conversations/:id`.

### `GET /conversations/:id/messages/:messageId/photo/:file`

Bearer session required. Extra stills 1–9. `:file` must match
`^([1-9])\.(jpg|jpeg|png|webp)$`; else **404** `{ "error": "Photo not found" }`.
There is **no** `/photo/0.jpg`. Same auth, belonging, private cache headers,
and 401/404/503 JSON as photo 0.

### `POST /conversations/:id`

Bearer session required. Body `{ "text"?: "…", "photo"?: { "contentType", "data", "takenAt?" }, "photos"?: [{ "contentType", "data", "takenAt?" }] }`
(at most 10 stills; non-empty `photos` wins over singular `photo`). Optional `takenAt` follows the same civil-time rule as `POST /messages` (invalid or missing is stored null and does not 400). Conversation JSON does not return it. Text 1–8000 via
`normalizeForumText`. Empty text is allowed on every kind when a still is present.
Photo-bearing rows persist `nostrPublishState` skipped (never Nostr); text-only
Direct/Contact/Damus stay `pending`. Moderator replies on a
platform thread persist as the platform account (sender + Nostr nsec) and
record the logged-in staff as `actorAccountId` / `actorName`. Staff JSON
uses the actor; members still see `21.gifts`. The worker signs with the
platform nsec. Relay failure does not block local persist. Kind includes
`moderator_group`: persist as the caller account (moderator,
not platform) with `nostrPublishState` skipped (never Nostr). After a new
persist on `moderator_group`, ping
`{ address, kind: "moderator", groupMessageId }` (no `messageId` in the
HTTP body; `groupMessageId` is the new conversation message id) only when
the caller has a receiving address (verified wallet; it is sent as
`address`), `spendPing` is set, **and** the caller has a live
living-room top-level post (not the profile note) whose `createdAt` is on
the same UTC day **and** `eligibleToday` for the author's funding grant and
21.gifts recovery share.
No such post → **200**, no ping, log `spend.ping.skipped` /
`no_public_post`. Public post today but not funding-eligible → **200**, no
ping, log `spend.ping.skipped` / `not_eligible`. Ping throw still **200**.
Living-room lookup failure after persist is still **200**, no ping, log
`spend.ping.skipped` / `posted_unreachable`. Empty or invalid text **without a still**
is **400** and does not ping. Verified, basis and the platform account **404**
on that id.

Same 401 / 404 / 503 shapes as the list/get routes, plus
**400** `{ "error": "Expected a JSON body with text and/or photo" }`
(including any `video` field; stills only),
**400** `{ "error": "At most 10 photos" }`,
**400** `{ "error": "Photo must be a JPEG, PNG, or WebP under 1 MiB" }`,
**400** `{ "error": "Text must be 1–8000 characters or include a photo" }`
(empty text without a still),
**400** `{ "error": "Text must be 1–8000 characters" }`,
**400** `{ "error": "Set a name before posting" }` when the sending member
has no display name.

Success → **Response** `200` (one public conversation message, including
`hasPhoto`, `photoCount` 0–10, and optional `accountId` — actor for staff
when set, otherwise sender; never photo bytes). After persist, the api enqueues one Web Push
(`type: conversation`, url `/messages?c=<conversationId>`) to each
bell-subscribed counterpart. `unreadCount` on that payload (and on forum
and zap payloads) is in-app notification unread plus listed inbox unread.
Push failure is logged and does not change the 200. DMs are not copied
into Notification rows.

### `POST /conversations/:id/invoice`

Bearer session required. Body `{ "sats": <int 1..10_000_000>, "text"?: "<string>", "amountUsd"?: "<string>|null", "amountChf"?: "<string>|null", "amountEur"?: "<string>|null", "amountPhp"?: "<string>|null" }`.
Optional `text` is the NIP-57 comment (empty = gift-only). Omitting every amount key leaves the invoice unpinned. Any present amount key pins all four; a missing sibling is null. `"0"`, `"0.0"`, and `"0.00"` are stored as `"0.00"`. An unusable amount string is **400** `{ "error": "Expected a JSON body with a positive \"sats\" integer" }`. Issues a BOLT11
against the counterpart's receiving address using their profile-note event
id as the zap `e` tag. The conversation row is **not** inserted until the
zap receipt is ingested.

Success → **Response** `200`:

```json
{ "pr": "lnbc…", "amountSats": 21, "messageId": "<uuid>", "sparkInvoice": "spark1…" }
```

`sparkInvoice` is a Spark invoice (`spark1…`) for the same amount to the
counterpart's verified wallet with memo `zap:<payment hash of pr>`, or `null`
when `pr` is not for exactly that amount or free in-app payments are off (see
[Free in-app payments](#free-in-app-payments)). A counterpart without a
verified wallet never reaches this 200; it is the **400** `cannot_receive`
below. `pr` is unchanged, so a
payer without an in-app wallet still pays over Lightning.
The counterpart's address is the receiving address
(see [Receiving address](#receiving-address)).

`messageId` is the predetermined conversation message id. Poll
`GET /conversations/:id?sinceMessageId=` until it appears.

**400** `{ "error": "The author's wallet cannot receive this Bitcoin payment", "code": "cannot_receive" }`
for Damus threads, no counterpart, no counterpart receiving address or profile
note, a profile note that is not signed yet, a counterpart without a Nostr key,
LNURL `noZap`, or a non-NIP-57 invoice. **400** `{ "error": "Could not start the Bitcoin payment" }`
when LNURL is unreachable or another transport failure. **400**
`{ "error": "Cannot message yourself" }`. **429** Too many payments. **503**
`{ "error": "Messages are unavailable" }` without a KEK. **503**
`{ "error": "Conversations are unavailable" }` when the ok-path
`recordInvoiceAttempt` throws after a successful LNURL mint (no `pr` in the
response).

### `POST /conversations/:id/read`

Bearer session required. `:id` is a UUID. Stamps last-read for the session
account via `markRead`. Does not copy DMs into Notifications.
`GET /conversations/:id` does not mark read.

Missing/invalid/expired bearer → **401** `{ "error": "Unauthorized" }`.
Non-uuid `:id`, missing thread, or session may not see it → **404**
`{ "error": "Not found" }`.
Store failure → **503** `{ "error": "Conversations are unavailable" }`.

Success → **Response** `200`:

```json
{ "ok": true }
```

### `POST /conversations/:id/messages/:messageId/translate`

Bearer session required. `:id` and `:messageId` are UUIDs. Body is only
`{ "target": "en" | "de" | "es" | "fil" }`. The server loads the stored
`conversation_message.text`. The client does not send source text. A cache
hit on `conversation_message_translation` for that text returns
`{ "translatedText", "cached": true }` with no upstream call. Access matches
`GET /conversations/:id` (`moderator_group` only for a moderator-group
member; initiator has the same rank as moderator).

Missing or invalid bearer → **401** `{ "error": "Unauthorized" }`.
Non-uuid `:id` or `:messageId`, missing thread, no access, missing message,
or a message from another thread → **404** `{ "error": "Not found" }`.
Malformed JSON, unknown `target`, or stored text that trims empty → **400**
`{ "error": "Invalid body" }`.
Translate not configured → **503** `{ "error": "Translate is not configured" }`.
Upstream failure → **502** `{ "error": "Translate upstream failed" }`.
Store or other unexpected failure → **503**
`{ "error": "Conversations are unavailable" }`. The log line does not include
the API key or the message text.

Success → **Response** `200`:

```json
{ "translatedText": "Hello", "cached": false }
```

### `GET /notifications`

Bearer session required. Lists the recipient's notifications newest-first
plus `unreadCount`. Fan-out already applied the owner's
`notificationLevel` when the row was written; this list applies the same
`notificationLevel` filter to stored rows (`notificationsMatchingLevel`
on the newest 1000). From those scanned rows (this recipient only), if a
`forum_mention` has `replyId` R, drop every `forum_post` and
`forum_reply` in that scan with the same `replyId` before the level
filter and the hidden-message filter. Do not drop `zap`, `forum_mention`,
`moderator_appointed`, or `moderator_proposal`. Best-effort
`deleteForRecipient` of those dropped ids (`notifications.duplicate.purged`;
a throw logs `notifications.duplicate.purge_failed` and still returns 200
with the filtered list). After the level filter, drop `forum_post` /
`forum_reply` / `forum_mention` whose parent message is missing or hidden; also drop
`forum_reply` when the child (`replyId`) is missing or hidden. Never drop
`moderator_appointed` or `moderator_proposal` (do not look up a forum
message; do not add the parent id to the purge set). Zap only checks the
parent (`replyId` is a receipt-derived UUID, not a message id).
Best-effort purge of those message ids. Then cap the kept list at **200**.
`unreadCount` is unread among kept rows after this drop and the existing
hidden filter, before the 200 cap (not the unfiltered matching unread of
the 1000, and not necessarily the page length). A generic row whose
matching mention is outside the 1000-row scan stays. Member JSON never
includes recipient or actor account ids. Each
item `type` is `"forum_post"`, `"forum_reply"`, `"forum_mention"`, `"zap"`,
`"moderator_appointed"`, or `"moderator_proposal"`.

Missing/invalid/expired bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

Store failure → **Response** `503`:

```json
{ "error": "Notifications are unavailable" }
```

Success → **Response** `200`:

```json
{
  "notifications": [
    {
      "id": "<uuid>",
      "type": "forum_reply",
      "parentId": "<uuid>",
      "replyId": "<uuid>",
      "name": "Bob",
      "text": "bob reply",
      "createdAt": "2026-09-12T12:00:00.000Z",
      "readAt": null
    }
  ],
  "unreadCount": 1
}
```

`unreadCount` is unread among kept rows after the hidden filter (before
the 200 cap), not `store.unreadCount()` and not the unfiltered matching
unread of the newest 1000. It is not necessarily the page length.

### `POST /notifications/read-all`

Bearer session required. Marks every unread notification for the session
account read except `moderator_proposal` (mark-read does not stamp them;
rows drop on confirm, on reject when pending is then empty, or on appoint).

Missing/invalid/expired bearer → **401** `{ "error": "Unauthorized" }`.
Store failure → **503** `{ "error": "Notifications are unavailable" }`.

A missing or invalid body is not **404**. An optional `endpoint` string is
recorded as the dismiss skip list only when it exactly matches one push
subscription of this account. The response never contains that endpoint.
Enqueue failure still returns **200**.

Success → **Response** `200`:

```json
{ "ok": true, "tags": [] }
```

`tags` are the collapse tags of rows this call stamped, first-seen unique,
in id order. `moderator_appointed` is included. `moderator_proposal` is
not stamped, so it contributes no tag. An empty `tags` array enqueues
nothing.

### `POST /notifications/read-by-message`

Bearer session required. Body is a JSON object `{ "messageId": "<uuid>", "endpoint"?: "<string>" }`.
Stamps unread `forum_post`, `forum_reply`, `forum_mention`, and `zap` rows
for this account whose `parentId` or `replyId` equals `messageId`. Does not
stamp `moderator_appointed`, `moderator_proposal`, another account, or a
row that already has `readAt`. A second call returns `tags: []`.

Missing JSON, `null`, an array, a string, a missing `messageId`, or a
non-UUID → **404** `{ "error": "Not found" }` (not 400). Missing or invalid
bearer → **401** `{ "error": "Unauthorized" }`. Store failure → **503**
`{ "error": "Notifications are unavailable" }` (`notifications.read_message.failed`).

The optional `endpoint` is skipped on the dismiss push only when it exactly
matches one subscription of this account. It is never echoed. A bad or
unowned `endpoint` does not change the status and does not skip anyone.
Dismiss enqueue failure still returns **200**.

Success → **Response** `200`:

```json
{ "ok": true, "tags": ["forum_post:<id>", "zap:<replyId>"] }
```

Zap tags use `replyId` (the receipt-derived id), not the note id.
`tags` lists only rows this call stamped.

### `POST /notifications/read-visible`

Bearer session required. Body is a JSON object `{ "messageId": "<uuid>", "endpoint"?: "<string>" }`.
Stamps unread `forum_post`, `forum_reply`, and `forum_mention` rows for this
account whose `replyId` equals `messageId`. Does not match `parentId`. Does
not stamp `zap`, a child reply matched only by `parentId`,
`moderator_appointed`, `moderator_proposal`, another account, or a row that
already has `readAt`. A second call returns `tags: []`.

Missing JSON, `null`, an array, a string, a missing `messageId`, or a
non-UUID → **404** `{ "error": "Not found" }` (not 400). Missing or invalid
bearer → **401** `{ "error": "Unauthorized" }`. Store failure → **503**
`{ "error": "Notifications are unavailable" }` (`notifications.read_visible.failed`).

The optional `endpoint` is skipped on the dismiss push only when it exactly
matches one subscription of this account. It is never echoed. A bad or
unowned `endpoint` does not change the status and does not skip anyone.
Dismiss enqueue failure still returns **200**.

Success → **Response** `200`:

```json
{ "ok": true, "tags": ["forum_post:<id>", "forum_mention:<id>"] }
```

`tags` lists only rows this call stamped.

### `POST /notifications/:id/read`

Bearer session required. `:id` is a UUID. Marks one notification read and
returns that `PublicNotification` with `readAt` set. A `moderator_proposal`
row is **200** with `readAt` still `null` (mark-read does not dismiss it).
Unknown id, another account's notification, or a non-uuid `:id` → **404**
`{ "error": "Not found" }`. Same **401** / **503** as list.

Dismiss happens only when this call changes `readAt` from null. The row's
collapse tag is then enqueued as a dismiss push for the account's other
subscriptions. An already-read row does not enqueue, even when its `readAt`
equals the route clock. A proposal does not enqueue. The response stays the
public notification, not `{ "ok", "tags" }`. Enqueue failure still returns
**200**.

Success → **Response** `200` (one public notification with `readAt` set,
or still `null` for `moderator_proposal`).

### `GET /habits`

Public list. No bearer required. `Cache-Control: no-store`. A valid bearer
includes `notes` only on the caller's own habits; everyone else's JSON
omits `notes`. Periods run from `firstPeriod` through the latest ratable
day or week. A daily period is ratable through today in the habit's
stored IANA zone. A weekly period becomes ratable at 08:00 on the
following Monday in that zone. `logged` is false and `status` is null
when the owner has not recorded that period.

Success → **Response** `200` `{ "reviewWeek": { "start" }, "habits" }`.
Each comment carries `canReceive`: true when its author has a receiving
address (see [Receiving address](#receiving-address)); each author is looked
up once per request.
Store failure → **503** `{ "error": "Habits are unavailable" }`.

### `POST /habits`

Bearer session required. One strict JSON action: `add`, `edit`, `archive`,
`log`, `comment`, `deleteComment`, or `invoice`. `Cache-Control: no-store`.
The api does not pay.

`add` stores the device `Time-Zone` and requires a zone `Intl` accepts.
A missing, blank, or unknown zone is **400** `{ "error": "Invalid time zone" }`.
That check is only for `add`: the stored zone is the habit's clock, which
is a different job from Sunday rest. Name is 1–80 characters after trim.
Description and private notes are optional and at most 2000 characters.
Cadence is `daily` or `weekly` and is not changed by `edit`. Notes stay
owner-only.

`comment`, `deleteComment`, and `invoice` use the Sunday rest already
stated for public writing (`POST /messages/:id/repayment`: device
`Time-Zone` in Sunday → **403** `{ "error": "SUNDAY_REST" }`, and a
missing, blank, or invalid zone does not refuse). `add`, `edit`,
`archive`, and `log` do not rest on Sunday. The invoice Sunday check is
before the amount check.

A comment hangs on the habit. It is not a forum post and not a Nostr
note. Text is 1–2000 characters after trim. `deleteComment` requires
initiator rank; a lower role is **403** `{ "error": "Forbidden" }`.

`invoice` mints a BOLT11 invoice for the comment author's Lightning
Address through the existing gift-invoice helper. Body `amountSats` must
be an integer from 1 through 10_000_000 (the whole-sat form of
`GIFT_INVOICE_MAX_MSAT`). A non-integer, a value below 1, or a value
above that ceiling is **400**
`{ "error": "Expected a JSON body with an integer \"amountSats\"" }`.
A missing `amountSats`, or a value that is not a number, is that same
**400**.
Success is the same gift body as `POST /pay/:username/invoice`:

```json
{ "pr": "lnbc...", "amountSats": 21 }
```

The invoice is minted on the comment author's receiving address
(`<username>@<host of PUBLIC_BASE_URL>`, the verified in-app wallet) through
the LNURL server, as for `POST /pay/:username/invoice`. The `pr` is returned
only when it decodes to exactly `amountSats * 1000` millisatoshis, the same
rule as `POST /pay/:username/invoice`.

Donating to the caller's own comment is **400**
`{ "error": "Cannot donate to yourself" }`. An author without a receiving
address (no verified in-app wallet, or the LNURL server is off) is **409** `{ "error": "The author's wallet cannot receive this Bitcoin payment", "code": "cannot_receive" }`. The existing invoice
limiter answers **429** `{ "error": "Too many payments" }`. A failed
mint, or a BOLT11 that is missing, not a safe integer amount, or not the
requested amount, is **502**
`{ "error": "Lightning Address could not be resolved" }`, the same failure
as `POST /pay/:username/invoice`.

Missing bearer → **401** `{ "error": "Unauthorized" }`. A body that is
not one of the actions → **400** `{ "error": "Invalid body" }`. Unknown
habit or comment → **404** `{ "error": "Not found" }`. A period that is
not yet ratable → **409** `{ "error": "Period is closed" }`. Store
failure → **503** `{ "error": "Habits are unavailable" }`.

---

## Receiving address

Every money route resolves an account's receiving address the same way
(`receivingAddress`). A member's only receiving address is their in-app
wallet:

- With `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolving and a verified
  wallet key on the account (`sparkPubkeyVerifiedAt` set), the address is the
  wallet-backed `<username>@<host of PUBLIC_BASE_URL>`. Its LUD-16 document
  and pay callback are fetched from the LNURL server directly
  (`lnurlServerFetch`: same path and query, fixed `Host`), never over the
  public URL.
- Otherwise the account has no receiving address. Every money route answers
  as for a member without an address. There is no fallback to a stored
  external address and no transition mode.

Used by `POST /messages/:id/invoice` (forum gift and compose-target posting
fee), `POST /conversations/:id/invoice`, `POST /messages/:id/repayment`,
`POST /messages/:id/repayment/due`, `canReceive` on `GET /messages/:id/repayment`, `GET /me/loans`,
`GET /pay/:username`, `POST /pay/:username/invoice`, `POST /pos`, the
`payable` and `authorCanReceive` flags on forum and member feeds,
`canReceive` on `GET /conversations` rows and `GET /habits` comments, account JSON `lightningAddress`
(owner, public card, member card, funding detail, debug), spend pings, the
Nostr kind 0 `lud16` (members without a verified wallet publish none), and
the zap receipt ingest (the LNURL `nostrPubkey` that must sign a receipt).
Only a verified wallet clears `lightning-address` from `missing`, so a member
without one cannot post (`POST /messages`, `GET /messages/compose-target`).

A **400** that means "needs a wallet" or "cannot receive" carries a
machine-readable `code` next to `error`, as does the **409** of a habit
donation to an author who cannot receive. Clients decide by `code`, not by the
status or the text:

- `"code": "wallet_required"`: the caller must set up and verify the in-app
  wallet first (`POST /pos`).
- `"code": "cannot_receive"`: the recipient cannot receive. It has no member
  account, no verified wallet, or its wallet refuses the zap (forum gift and
  compose-target posting fee, conversation invoice, repayment, habit
  donation). On `POST /conversations/:id/invoice` it also covers a counterpart
  whose profile note is not signed yet or who has no Nostr key.

Other 400s on the same routes (for example an unsigned forum note on
`POST /messages/:id/invoice`) carry no `code`.

Spend lookups (`POST /invoices`, `GET /invoices/eligible`,
`GET /invoices/passkey`, `GET /invoices/posted`) take the same address form
(`accountByReceivingAddress`): `<username>@<host of PUBLIC_BASE_URL>`,
trimmed and case-insensitive, resolved by username to a member with a
verified wallet. Any other domain, a member without a verified wallet, or the
LNURL server being off gets the existing not-found answer.

## Free in-app payments

On when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve,
`LNURL_ZAP_NSEC_HEX` is 64 hex characters, and `SPARK_OPERATOR_URL` is unset,
blank (both use `https://0.spark.lightspark.com`), or an `http:` / `https:`
URL; any other `SPARK_OPERATOR_URL` turns the feature off
(`resolveFreePaymentsConfig`). Off →
every `sparkInvoice` is `null` and no worker runs, and a heart
(`POST /messages/:id/invoice` with `heart: true`) is refused with **503**
`{ "error": "HEART_UNAVAILABLE" }` instead of falling back to Lightning (see
[Hearts](#hearts)).

**Spark invoice.** For a wallet-backed recipient, when `pr` is for exactly the
invoiced amount, the three invoice routes store and return a Spark invoice next
to `pr` (otherwise `sparkInvoice` is `null`): protobuf
`SparkAddress { 1: identity_public_key, 2: spark_invoice_fields }` without a
signature, where `SparkInvoiceFields` is written in the order
`1: version = 1`, `2: id` (UUIDv7), `5: memo` (`zap:<payment hash of pr>`),
`4: SatsPayment { 1: amount }`, encoded as bech32m with prefix `spark`. One
payment hash has one Spark invoice; handing an open one out again restarts
its 60-minute watch.

**Confirmation.** A worker runs every 2 s (one tick at a time). It lists the
open Spark invoices issued in the last 60 minutes and asks the Spark
coordinator in batches of up to 100
(`POST <SPARK_OPERATOR_URL>/spark.SparkService/query_spark_invoices`, gRPC-web,
no authentication). Only `FINALIZED` settles; not found, pending, returned,
mismatched, and unknown-status invoices stay open until they leave the window. For a
finalized invoice it builds a kind 9735 receipt for the zap invoice: tags
`p`, `P` (zap request pubkey), `e`, `bolt11` (`pr`), `description` (the exact
zap request string sent to the LNURL server), no `preimage`, empty content,
and `created_at` taken from the zap request so a retry yields the same receipt
id.
The receipt is signed with the receiver's receipt key, HMAC-SHA256 keyed with
the `LNURL_ZAP_NSEC_HEX` bytes over `lnurl-zap-receipt-key:`, the lower-case
hex of the wallet key, and a counter byte from 0 (the first valid secp256k1
secret key); its public key is the `nostrPubkey` the LNURL server advertises
for that member. The receipt is fed straight into the receipt ingest. When the ingest credited this receipt and it holds the payment hash claim, it
is published to the relays named in the zap request (if any) and the row is
settled (transfer id and receipt id). Publishing is best effort: when no relay accepts the receipt, the api logs `spark.receipt.publish_failed` and the row is still settled. When another receipt already owns the payment hash of `pr`, the
row is settled without publishing. Otherwise the row stays open and the next
tick ingests the same receipt again. Crediting is the existing
receipt path; the payment hash is claimed once, so a second receipt for the
same payment hash (for example `pr` also paid over Lightning) credits
nothing.

**Storage.** `spark_invoice` (`docs/schema/spark_invoice.sql`): `payment_hash`
(primary key), `invoice`, `receiver_pubkey`, `amount_sats`, `bolt11`,
`zap_request`, `created_at`, `status` (`open` / `settled`), `transfer_id`,
`receipt_event_id`. Covered by `trg_db_change`.

## Not implemented (v1, decided in CONCEPT — no HTTP paths)

The following are decided product capabilities for v1 (see `CONCEPT.md`) but
are **not** exposed as HTTP routes in this codebase yet. Paths and JSON for
these land in the PR that implements them; this file is updated then. Do not
treat the list below as inventing endpoints.

**Donor LNDHub credentials.** Paying uses lightning.space LNDHub in the
external spend worker, not encrypted storage in this api. No `/me/donor`
deposit route.

**Recurring gifts.** Donors will configure fixed USD amounts to
recipients. They are paid by the external spend worker **when the recipient
posts a top-level note**, not on a daily timer. Invoice HTTP (`POST /invoices`
/ `POST /invoices/proof`) is unchanged except proof now attaches a gift-reply
when a top-level `messageId` was stored, or a hidden spend marker when
`messageId` is a reply; do not invent new paths. No `/me/recurring` or
in-process scheduler.

**Feed / discovery / campaign index.** Paginated read endpoints over indexed
NOSTR events (profiles, campaigns, replies). Not wired yet. Custodial nsec
and server-side kind:1 / zap signing ship in this version (KEK + worker).

**Readiness probe.** `/healthz` remains liveness-only. A readiness check of
downstream dependencies is still planned. The LUD-16 metadata cache on
`GET /lightning-address` is in-memory only. Gift statistics read Postgres
when `DATABASE_URL` is set.

**Staff endpoints (moderator+).** Soft-hide is implemented as
`DELETE /messages/:id` (moderator session). The staff hidden log
is implemented as `GET /messages/hidden` (moderator **session**
or operator token; registered before `GET /messages/:id`). Operator debug
restore exists as `POST /debug/messages/:id/restore` (`DEBUG_TOKEN`).
Staff / moderator session unhide is still not a route. Other Moderator
actions are not HTTP routes yet. Role values
exist on the account model; `GET /debug/accounts` and
`PATCH /debug/accounts/:id` are operator token routes, not a moderator session.

---

## Out of scope for v1

- Passkey + PRF + NIP-06 user-owned keys (non-custodial phase)
- Email/password login (or any second login method)
- Internationalization of api response text and push payloads (they stay English). A signed-in account may store `locale` and `fiat`; that is not translated copy.
- Platform custody of **receiver** funds (receiving stays LUD-16 only)
- Arbitrary LNDHub URLs (the external spend worker uses lightning.space only)
