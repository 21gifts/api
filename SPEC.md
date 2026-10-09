# 21.gifts — API Specification

> Canonical description of the HTTP surface implemented by this service.
> Product decisions live in [`CONCEPT.md`](./CONCEPT.md); this file owns
> request/response contracts for routes that exist in code today.

**Status**: living document. Last revised 2026-09-30 (`GET /mentions` matches the start of the username, a `.` `_` `-` segment, or the start of the display name or one of its words; a token containing `.` `_` `-` matches only a whole-string start. 2026-09-28: `GET /mentions` username prefix suggestions. GET /mentions returns at most 20 username-prefix suggestions for a signed-in forum reader. 2026-09-24: `POST /conversations/:id/messages/:messageId/translate`; owner and view JSON include `aboutMessageId`; conversation rows include `lastMessageId`. 2026-09-23: `eligibleToday` does not require a grant until UTC 2026-10-10; funding-program grants independent of `account.role`; spend ping and `POST /invoices` require `eligibleToday`; verified top-level media also welcome-pings independent of `eligibleToday`; `GET /invoices/eligible`; `GET /conversations` list/open rows include per-row `unreadMessageCount`; envelope `unreadCount` remains unread thread count; `GET /trust-chain` requires a member Bearer session; public graph uses at most one incoming edge per subject: the oldest eligible sibling (`createdAt` then `id`), skipping a non-chain oldest sibling so a later displayable contact can show; eligible `verify`, `moderator_appoint`, and `moderator_propose` only when the subject is a moderator; `moderator_confirm` and `moderator_reject` never; later appoint/confirm/propose do not replace the first eligible contact; staff may reject an open proposal (`POST /trust/reject-moderator`, append-only `moderator_reject`, role stays `verified`) and re-propose after reject (new `moderator_propose`; 409 while currently pending, any confirm/appoint, or a concurrent older open propose wins after insert); confirm/reject re-list after insert and undo when the other grant already closed; pending = latest propose/reject is propose, verified, no confirm/appoint; live-unique kinds are verify/confirm/appoint only; open proposal fans out in-app `moderator_proposal` plus Web Push to other staff until confirm, until reject when pending is then empty, or until appoint; GET `/notifications` keeps `moderator_appointed` and `moderator_proposal` (mark-read / read-all do not stamp the proposal); owner `notificationLevel` on GET `/me` and `POST /me/notification-level`; fan-out filters in-app and Web Push by `all` / `active` / `mentions`; GET `/notifications` applies the same filter to stored rows (`moderator_appointed` always stays; `unreadCount` is unread among kept rows after the hidden filter (before the 200 cap), not `store.unreadCount()` and not the unfiltered matching unread of the newest 1000); a zap that inserts a gift-reply fans out only `notifyZap`, not a second `forum_reply`; gift-reply row still lands in the thread; confirm/appoint notify the subject only with `moderator_appointed` and Web Push url `/welcome`; official platform account (`isPlatform`) never fans out living-room `forum_post` / `forum_reply` / `zap`; house daily gift-replies still persist; GET /messages omits name-copy profile notes and About me text stays). 2026-10-01: opening a forum note, translating it, or opening Notifications stamps the matching unread forum and zap rows and tells the account's other devices to close those banners (`POST /notifications/read-by-message`; read-all and read-by-message return tags; a freshly stamped `POST /notifications/:id/read` only enqueues the dismiss tag and still returns the public notification). `moderator_proposal` stays unread. Private-message pushes are not dismissed. 2026-10-02: `GET /messages?mode=active` is paid notes plus unpaid founder/moderator notes. An ask with `sats = 0` is not active. 2026-10-09: the API stores the daily roster; initiator or founder edit it and a moderator is refused. Until that store has been written, a spend ping reads the live spend roster and does not import it. 2026-10-09: GET /me/activity, GET /members/:accountId/activity, and GET /view/:viewKey/activity count only donations. Loans (goalRepayable === true, including hidden notes), repay: repayment invoices, and moderator stipends are omitted. Daily and welcome gifts stay. An unknown note still counts as a donation.

---

## Implemented HTTP surface (normative)

Auth state uses `InMemoryAuthStore` when `DATABASE_URL` is unset (tests and
local boots). When `DATABASE_URL` is set, the process migrates the auth
schema and uses `PostgresAuthStore` — accounts, passkey challenges,
passkey credentials, sessions, and pending address verifications survive a
restart. `account.linking_key` is nullable for passkey-created rows. A missing or unreachable
database URL that is set is fail-loud at boot. On the SQL path,
`NOSTR_NSEC_KEK` (64 lowercase hex) is also required; missing or malformed
KEK throws at boot. Public gift statistics
(`GET /gifts/stats` and `GET /gifts?day=`) read the `gift` table when `DATABASE_URL` is set;
without it the process still boots and returns empty stats. Amounts are
also expressed as BTC and as the USD/CHF/EUR/PHP stored at payment time
(that stored value is what is returned). A USD stipend keeps the USD amount
that was sent. A SQL row stores those four amounts as text or SQL NULL.
SQL NULL is JSON `null` on read: it is not recomputed from the day's close
and it is not **503**. Backfill freezes a historical close once, at migrate
time, and leaves the row null when that day has no rate. Only an in-memory
gift row that omits the field entirely (`undefined`, not SQL NULL) still uses
the UTC-calendar-day BTC-USD daily close from Coinbase Exchange (persisted in
`btc_usd_daily`), plus additive CHF/EUR/PHP (USD × that UTC day's Frankfurter
ECB rate, persisted in `usd_fiat_daily`; last business day if the market is closed).
GET fetches Coinbase only for those omitted-field rows, UTC-today when `fetched_at`
is older than one hour, and a past day whose `fetched_at` is still on that
same UTC calendar day (intraday print not yet the settled close). Settled
stored days are not re-fetched. A missing BTC-USD rate after that ensure is
**503** only for an omitted-field row. A missing CHF/EUR/PHP cross is JSON `null`, never 503.

Lightning Address verification HTTP routes are implemented. A live
verification payment requires an injected invoice payer; the default
`UnconfiguredInvoicePayer` makes start verification return **503**. Public
`GET /lightning-address` resolves LUD-16 metadata with an in-memory cache; it
does not fetch or pay invoices.

Spend-worker invoice routes: `GET /invoices/passkey` and `GET /invoices/posted`
report those gates; `GET /invoices/eligible` reports `{ eligible, status }` (`eligibleToday` plus `effectiveStatus`; grant required from UTC 2026-10-01);
`POST /invoices` requires passkey and `eligibleToday` (grant required from UTC 2026-10-01), then fetches a BOLT11 via LNURL-pay.
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
`POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, with headers `Authorization` and `Content-Type`.
Sessions are sent as `Authorization: Bearer` headers — no cookies,
credentials not enabled.

Public base URLs used in examples:

| Environment | API                            | App                        |
| ----------- | ------------------------------ | -------------------------- |
| PRD         | `https://api.21.gifts`         | `https://21.gifts`         |
| DEV         | `https://dev-api.21.gifts`     | `https://dev.21.gifts`     |
| STAGING     | `https://staging-api.21.gifts` | `https://staging.21.gifts` |

| Method | Path                                                 | Auth                                         | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------ | ---------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/healthz`                                           | none                                         | Liveness                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| GET    | `/info`                                              | none                                         | Service identity                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GET    | `/.well-known/lnurlp/:username`                      | none                                         | LUD-16 payRequest; WoS callback stays; an open till charge pins both sendable bounds                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GET    | `/pay/:username`                                     | none                                         | Public pay-link card: display name and satoshi bounds                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| POST   | `/pay/:username/invoice`                             | none                                         | One BOLT11 invoice for an exact satoshi amount on the linked address                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GET    | `/favicon.ico`                                       | none                                         | Brand mark (favicon)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GET    | `/favicon.svg`                                       | none                                         | Brand mark (SVG favicon)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| GET    | `/apple-touch-icon.png`                              | none                                         | Brand mark (Apple touch icon)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| POST   | `/auth/passkey/register/begin`                       | none                                         | Issue WebAuthn creation options                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| POST   | `/auth/passkey/register/finish`                      | none                                         | Verify attestation, issue session                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| POST   | `/auth/passkey/authenticate/begin`                   | none                                         | Issue WebAuthn request options                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| POST   | `/auth/passkey/authenticate/finish`                  | none                                         | Verify assertion, issue session                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| POST   | `/auth/passkey/replace/begin`                        | Bearer                                       | 409 refusal after a valid Bearer (a recovery phrase cannot be replaced; no challenge)                                                                                                                                                                                                                                                                                                                                                                                                                           |
| POST   | `/auth/passkey/replace/finish`                       | Bearer                                       | 409 refusal that deletes nothing and keeps the session                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| POST   | `/auth/passkey/seed/begin`                           | Bearer                                       | Creation options for one extra seed passkey; 409 when walletRequired is already true stores a failed renew row and does not change the account; a 200 stores no row; no excludeCredentials.                                                                                                                                                                                                                                                                                                                     |
| POST   | `/auth/passkey/seed/finish`                          | Bearer                                       | Verify attestation, insert an additional passkey, set walletRequired true, keep the login passkey and the session. Failure stores a failed renew row. Success stores succeeded, acknowledges open failures, and returns passkeyRenewClosed false.                                                                                                                                                                                                                                                               |
| GET    | `/me`                                                | `Authorization: Bearer`                      | Account (`setup` + factual `missing` + `hasPosted` + `aboutMe` + `aboutMeHasPhoto` + `aboutMessageId` + `notificationLevel` + `amountUnit` + `locale` + `fiat`)                                                                                                                                                                                                                                                                                                                                                 |
| POST   | `/me/amount-unit`                                    | Bearer                                       | Set owner amount-entry unit (`btc` or `fiat`, default `btc`)                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| POST   | `/me/locale`                                         | Bearer                                       | Set owner UI language (`en`, `de`, `es`, or `fil`). Null until set. `onlyIfUnset` does not overwrite a stored value.                                                                                                                                                                                                                                                                                                                                                                                            |
| POST   | `/me/fiat`                                           | Bearer                                       | Set owner fiat (`CHF`, `EUR`, `USD`, or `PHP`). Null until set. `onlyIfUnset` does not overwrite a stored value.                                                                                                                                                                                                                                                                                                                                                                                                |
| GET    | `/me/activity`                                       | Bearer                                       | Donation given + received series (non-loan forum zaps plus daily and welcome gifts; loans, repayments, and moderator stipends omitted)                                                                                                                                                                                                                                                                                                                                                                          |
| POST   | `/me/wallet-backup-seen`                             | Bearer                                       | Records that this account can show a recovery phrase. Not a confirmation and not a setup step. Empty body. Does not change `walletRequired`.                                                                                                                                                                                                                                                                                                                                                                    |
| POST   | `/me/passkey-renew/report`                           | Bearer                                       | Client `failed` or `cancelled` renew attempt. Stores a row; does not change the account. `succeeded` is 400. Returns owner JSON including `passkeyRenewFailed`, `passkeyRenewClosed`, and `passkeyRenewPrfUnsupported`. `passkeyRenewClosed` is true only while `walletRequired` is false.                                                                                                                                                                                                                      |
| POST   | `/me/passkey-renew/ack`                              | Bearer                                       | Acknowledges failed unacknowledged renew rows only. Empty body. Returns owner JSON including `passkeyRenewFailed`, `passkeyRenewClosed`, and `passkeyRenewPrfUnsupported`. `passkeyRenewPrfUnsupported` is true only when the newest unacknowledged failed row is `prfUnsupported`. `passkeyRenewClosed` is true only while `walletRequired` is false.                                                                                                                                                          |
| GET    | `/view/:viewKey`                                     | none                                         | Public profile card by view key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| GET    | `/view/:viewKey/about/photo`                         | none                                         | Profile-note photo bytes for the view-key card                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| GET    | `/view/:viewKey/activity`                            | none                                         | Public given/received payload for the account behind the view key                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| POST   | `/me/setup/skip`                                     | Bearer                                       | Skip name or Lightning Address wizard step                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| POST   | `/me/name`                                           | Bearer                                       | Set/replace display name (profile note when name + LN are both set); auto-assign username when free                                                                                                                                                                                                                                                                                                                                                                                                             |
| POST   | `/me/username`                                       | Bearer                                       | Set unique LUD-16 / NIP-05 local-part (cannot skip)                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| POST   | `/me/location`                                       | Bearer                                       | Set, change, or clear free-text profile location                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| PUT    | `/me/about`                                          | Bearer                                       | Set/clear About me text and optional photo on the profile note                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| GET    | `/me/about/photo`                                    | Bearer                                       | Owner profile-note photo bytes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| GET    | `/pictures/me`                                       | Bearer                                       | Owner profile-photo bytes. Not the wide image and not the About me photo                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| PUT    | `/pictures/me`                                       | Bearer                                       | Set or clear the round profile photo. Not the wide image and not the About me photo                                                                                                                                                                                                                                                                                                                                                                                                                             |
| GET    | `/pictures/:file`                                    | none                                         | Public profile photo when the extension matches. Kind:0 `picture`                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| GET    | `/banners/me`                                        | Bearer                                       | Owner wide-image bytes. Not the About me photo                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| PUT    | `/banners/me`                                        | Bearer                                       | Set or clear the wide image. A portrait is rejected. Not the About me photo                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| GET    | `/banners/:file`                                     | none                                         | Public wide image when the extension matches. Kind:0 `banner`                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| POST   | `/me/forum-laws-dismissed`                           | Bearer                                       | Dismiss welcome-forum living-room laws                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| POST   | `/me/notification-level`                             | Bearer                                       | Set owner fan-out filter (`all` / `active` / `mentions`)                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| POST   | `/me/rules-agreement`                                | Bearer                                       | Record living-room rules agreement                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/me/lightning-address`                              | Bearer                                       | Link/replace after live LNURL resolve + NIP-57 mint probe                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| DELETE | `/me/lightning-address`                              | Bearer                                       | Unlink address (clears LN skip)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| POST   | `/me/lightning-address/verification`                 | Bearer                                       | Start address proof-of-control payment                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| POST   | `/me/lightning-address/verification/confirm`         | Bearer                                       | Confirm nonce from wallet history                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| GET    | `/members/:accountId`                                | Bearer                                       | Live member identity + profile note + `aboutMeHasPhoto` + counts + `trust`                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| GET    | `/members/:accountId/activity`                       | Bearer                                       | Same given/received payload as `/me/activity` for that member                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| GET    | `/members/:accountId/posts`                          | Bearer                                       | Live member top-level notes (latest 200)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| GET    | `/members/:accountId/replies`                        | Bearer                                       | Live member replies (latest 200)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GET    | `/mentions`                                          | Bearer                                       | Suggestions for `@` (`q` empty = first 20 alphabetical). A token matches the start of the username, a `.` `_` `-` segment, or the start of the display name or one of its words; a token containing `.` `_` `-` is whole-string only. Does not store `@` marks                                                                                                                                                                                                                                                  |
| GET    | `/trust-chain`                                       | Bearer                                       | Founder seeds (empty edges); `?around=<id>` one hop of stored public edges                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| POST   | `/trust/verify`                                      | Bearer (moderator+)                          | Staff: confirm a person in real life (`verified`)                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| POST   | `/trust/propose-moderator`                           | Bearer (moderator+)                          | Staff: propose a verified member as moderator                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| GET    | `/trust/proposals`                                   | Bearer (moderator+)                          | Staff: list pending moderator proposals                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| POST   | `/trust/confirm-moderator`                           | Bearer (moderator+)                          | Staff: second, independent confirmation → `moderator`                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| POST   | `/trust/reject-moderator`                            | Bearer (moderator+)                          | Staff: reject an open proposal (subject stays verified)                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| POST   | `/trust/appoint-moderator`                           | Bearer (founder)                             | Founder: appoint a moderator directly                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| POST   | `/funding/apply`                                     | Bearer                                       | Paused except joey-rosima, vincent, jewel-bacolbas, who still get 400/409/200/503. Every other verified caller → 403 Applications are paused, no write. basis → 403 Forbidden.                                                                                                                                                                                                                                                                                                                                  |
| GET    | `/funding/applications`                              | Bearer (moderator+)                          | Staff pending grant queue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| GET    | `/funding/applications/:accountId`                   | Bearer (moderator+)                          | Staff grant review                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/funding/trial`                                     | Bearer (moderator+)                          | One-UTC-day trial                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| POST   | `/funding/admit`                                     | Bearer (moderator+)                          | Admit grant                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| POST   | `/funding/reject`                                    | Bearer (moderator+)                          | Reject grant                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| GET    | `/funding/daily-roster`                              | Bearer, initiator or founder (moderator 403) | 401 no session, then 403, then the store. Success 200 is only `{ comment, paymentsEnabled, defaultAmountUsd, recipients: [{ address, amountUsd, accountId, name }] }`. `defaultAmountUsd` is always 1. Moderators stay off this list. 502 Daily roster is unavailable.                                                                                                                                                                                                                                          |
| POST   | `/funding/daily-roster/comment`                      | Bearer, initiator or founder (moderator 403) | 401 no session, then 403, then the store. Success 200 is only `{ comment, paymentsEnabled, defaultAmountUsd, recipients: [{ address, amountUsd, accountId, name }] }`. `defaultAmountUsd` is always 1. 502 Daily roster is unavailable.                                                                                                                                                                                                                                                                         |
| POST   | `/funding/daily-roster/payments`                     | Bearer, initiator or founder (moderator 403) | 401 no session, then 403, then the store. Success 200 is only `{ comment, paymentsEnabled, defaultAmountUsd, recipients: [{ address, amountUsd, accountId, name }] }`. `defaultAmountUsd` is always 1. 502 Daily roster is unavailable.                                                                                                                                                                                                                                                                         |
| POST   | `/funding/daily-roster/recipients`                   | Bearer, initiator or founder (moderator 403) | 401 no session, then 403, then `{ accountId, amountUsd }`. Route loads the account. Unknown account → 400 Unknown person. No Lightning address after trim → 400 Person has no Lightning address. Store load failure → 502 Daily roster is unavailable. The API store receives `{ address, amountUsd }` from the stored trimmed address. Success 200 is only `{ comment, paymentsEnabled, defaultAmountUsd, recipients: [{ address, amountUsd, accountId, name }] }`. Local bad body → Invalid person or amount. |
| POST   | `/funding/daily-roster/recipients/update`            | Bearer, initiator or founder (moderator 403) | 401 no session, then 403, then the store. Success 200 is only `{ comment, paymentsEnabled, defaultAmountUsd, recipients: [{ address, amountUsd, accountId, name }] }`. `defaultAmountUsd` is always 1. 502 Daily roster is unavailable. String address + bad amount → Invalid address or amount; otherwise Unknown address.                                                                                                                                                                                     |
| POST   | `/funding/daily-roster/recipients/delete`            | Bearer, initiator or founder (moderator 403) | 401 no session, then 403, then the store. Success 200 is only `{ comment, paymentsEnabled, defaultAmountUsd, recipients: [{ address, amountUsd, accountId, name }] }`. `defaultAmountUsd` is always 1. 502 Daily roster is unavailable. Local bad body → Unknown address.                                                                                                                                                                                                                                       |
| GET    | `/funding/daily-roster/document`                     | Spend Bearer (invoices)                      | 503 if the token env is unset; 401 wrong/missing Bearer. Success 200 is the full document including `moderators` and `moderatorPaymentsEnabled`. `defaultAmountUsd` is always 1.                                                                                                                                                                                                                                                                                                                                |
| POST   | `/funding/daily-roster/document`                     | Spend Bearer (invoices)                      | Import of the full document. 503 if the token env is unset; 401 wrong/missing Bearer. Writes only while the store is still the empty start document; a saved empty roster is already written; a second import returns 200 with the stored document. `defaultAmountUsd` in the body is ignored.                                                                                                                                                                                                                  |
| POST   | `/funding/daily-roster/worker/comment`               | Spend Bearer (invoices)                      | Spend Bearer. Body `{ comment: string }`. Newlines become spaces, then trim. Empty after trim is valid. Longer than 500 is 400 Invalid comment and is not cut. Success 200 is the full document. 503 if the token env is unset; 401 wrong/missing Bearer.                                                                                                                                                                                                                                                       |
| POST   | `/funding/daily-roster/worker/payments`              | Spend Bearer (invoices)                      | Spend Bearer. Body `{ enabled: boolean }` sets paymentsEnabled. Non-boolean enabled is 400 Invalid payments switch. Success 200 is the full document. 503 if the token env is unset; 401 wrong/missing Bearer.                                                                                                                                                                                                                                                                                                  |
| POST   | `/funding/daily-roster/worker/recipients`            | Spend Bearer (invoices)                      | Spend Bearer. Body `{ address, amountUsd }` adds a daily recipient. 400 Invalid address or amount, or Address already listed. Success 200 is the full document. 503 if the token env is unset; 401 wrong/missing Bearer.                                                                                                                                                                                                                                                                                        |
| POST   | `/funding/daily-roster/worker/recipients/update`     | Spend Bearer (invoices)                      | Spend Bearer. Body `{ address, amountUsd }` updates a daily amount. A string address with a bad amount is 400 Invalid address or amount; otherwise Unknown address. Success 200 is the full document. 503 if the token env is unset; 401 wrong/missing Bearer.                                                                                                                                                                                                                                                  |
| POST   | `/funding/daily-roster/worker/recipients/delete`     | Spend Bearer (invoices)                      | Spend Bearer. Body `{ address: string }` deletes a daily recipient. A bad body is 400 Unknown address. Success 200 is the full document. 503 if the token env is unset; 401 wrong/missing Bearer.                                                                                                                                                                                                                                                                                                               |
| POST   | `/funding/daily-roster/worker/moderators`            | Spend Bearer (invoices)                      | Spend Bearer. Body `{ address, amountUsd }` adds a moderator stipend. 400 Invalid address or amount, or Address already listed. Success 200 is the full document. 503 if the token env is unset; 401 wrong/missing Bearer.                                                                                                                                                                                                                                                                                      |
| POST   | `/funding/daily-roster/worker/moderators/update`     | Spend Bearer (invoices)                      | Spend Bearer. Body `{ address, amountUsd }` updates a stipend. A string address with a bad amount is 400 Invalid address or amount; otherwise Unknown address. Success 200 is the full document. 503 if the token env is unset; 401 wrong/missing Bearer.                                                                                                                                                                                                                                                       |
| POST   | `/funding/daily-roster/worker/moderators/delete`     | Spend Bearer (invoices)                      | Spend Bearer. Body `{ address: string }` deletes a stipend. A bad body is 400 Unknown address. Success 200 is the full document. 503 if the token env is unset; 401 wrong/missing Bearer.                                                                                                                                                                                                                                                                                                                       |
| POST   | `/funding/daily-roster/worker/moderators/payments`   | Spend Bearer (invoices)                      | Spend Bearer. Body `{ enabled: boolean }` sets moderatorPaymentsEnabled. Non-boolean enabled is 400 Invalid payments switch. Success 200 is the full document. 503 if the token env is unset; 401 wrong/missing Bearer.                                                                                                                                                                                                                                                                                         |
| GET    | `/funding/payout-days`                               | Bearer (moderator+)                          | Staff seven-UTC-day grant payout matrix (`days`: `blocked` / `missed` / `paid`; `welcome`: seven booleans, same order)                                                                                                                                                                                                                                                                                                                                                                                          |
| GET    | `/shops/activity`                                    | none                                         | 30-UTC-day shop till-charge counts (`days`: `{ day, shopCount }`, oldest first, zeros included)                                                                                                                                                                                                                                                                                                                                                                                                                 |
| GET    | `/funding/goal`                                      | Bearer (any role)                            | 7-UTC-day shop till-charge counts plus how many shops had a charge on 5 of those days (`days`, `qualifyingShops`)                                                                                                                                                                                                                                                                                                                                                                                               |
| GET    | `/messages`                                          | none for active / Bearer                     | Public active window with no header; otherwise Bearer. List top-level notes (+ visible `replyCount`); 409 if rules missing; name-copy notes without photo, extra stills, or video are omitted; About me text stays                                                                                                                                                                                                                                                                                              |
| GET    | `/messages/compose-target`                           | Bearer                                       | Platform profile note `{ messageId, sats }` for a 1-sat compose fee to 21.gifts                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| GET    | `/messages/places`                                   | Bearer                                       | Live top-level forum pins; 409 if rules missing                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| POST   | `/messages`                                          | Bearer                                       | Post text/photo; 409 if rules/name/username/Lightning Address missing; 403 text-only below verified                                                                                                                                                                                                                                                                                                                                                                                                             |
| GET    | `/messages/hidden`                                   | Bearer (moderator+)                          | Staff log of soft-hidden notes (session, not DEBUG_TOKEN)                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| GET    | `/messages/:id`                                      | none / Bearer (moderator+)                   | Live public JSON; staff hidden GET includes `deletedAt`/`deletedBy`                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| GET    | `/links/:code`                                       | none                                         | Public 8-hex prefix of exactly one message or account id                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| GET    | `/messages/:id/replies`                              | none / Bearer (moderator+)                   | Live replies; staff `listReplies(..., true)` includes hidden children even under a live parent                                                                                                                                                                                                                                                                                                                                                                                                                  |
| GET    | `/messages/:id/photo`                                | none / Bearer (moderator+)                   | Live photo bytes; staff hidden bytes `Cache-Control: private, no-store`                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| GET    | `/messages/:id/video.*`                              | none / Bearer (moderator+)                   | Live video bytes; staff hidden bytes `Cache-Control: private, no-store`                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| DELETE | `/messages/:id`                                      | Bearer (moderator+)                          | Soft-hide note + direct replies; retract in-app notifications; external target also blocks that pubkey                                                                                                                                                                                                                                                                                                                                                                                                          |
| PATCH  | `/messages/:id/place`                                | Bearer (moderator+)                          | Set, replace, or clear the map pin on a live top-level shop note                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| PATCH  | `/messages/:id/shop-account`                         | Bearer (moderator+)                          | Set, replace, or clear the 21.gifts account on a live top-level shop note                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| PATCH  | `/messages/:id/text`                                 | Bearer (moderator+)                          | Replace the text of a live top-level shop note; the shop tag stays                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| PATCH  | `/messages/:id/photos`                               | Bearer (moderator+)                          | Replace the stills of a live top-level shop note; a video stays; no edit history                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GET    | `/messages/:id/edits`                                | Bearer (moderator+)                          | Staff edit history of a shop note, newest first                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| POST   | `/messages/:id/invoice`                              | Bearer                                       | NIP-57 zap / BOLT11                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| GET    | `/habits`                                            | none                                         | Public member habits. A bearer includes private notes only on the caller's own rows.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| POST   | `/habits`                                            | Bearer                                       | Add, edit, archive, or log a habit; comment; delete a comment; or mint `{ pr, amountSats }` for a comment.                                                                                                                                                                                                                                                                                                                                                                                                      |
| GET    | `/messages/:id/repayment`                            | none                                         | Public credit ledger: who gave, and each repayment share                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| POST   | `/messages/:id/repayment`                            | Bearer                                       | Author pays the next giver share from their own wallet. A repeat for that unpaid share returns the outstanding invoice.                                                                                                                                                                                                                                                                                                                                                                                         |
| POST   | `/contact`                                           | Bearer                                       | Send private in-app contact `{ text }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| GET    | `/pos`                                               | Bearer                                       | Open till charge or null, plus up to 20 history rows                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| POST   | `/pos`                                               | Bearer                                       | Pin one whole-sat amount for five minutes                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| DELETE | `/pos`                                               | Bearer                                       | Cancel every unexpired pending till charge                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| GET    | `/conversations`                                     | Bearer                                       | List visible private threads (per-row `unreadMessageCount`; envelope `unreadCount` is thread count)                                                                                                                                                                                                                                                                                                                                                                                                             |
| GET    | `/conversations/moderator-group`                     | Bearer (moderator+)                          | Open/ensure closed moderator-group tool                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| POST   | `/conversations`                                     | Bearer                                       | Open thread from a forum note (`forumMessageId`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GET    | `/conversations/:id`                                 | Bearer                                       | Oldest-first messages (`?sinceMessageId=` long-polls until that id exists)                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| GET    | `/conversations/:id/messages/:messageId/photo`       | Bearer                                       | Private photo 0 bytes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| GET    | `/conversations/:id/messages/:messageId/photo/:file` | Bearer                                       | Private extra stills 1–9 (`{1-9}.{jpg, jpeg, png, webp}`)                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| POST   | `/conversations/:id`                                 | Bearer                                       | Send `{ text?, photo?, photos? }` (stills on every kind; photo rows skip Nostr)                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| POST   | `/conversations/:id/invoice`                         | Bearer                                       | NIP-57 zap / BOLT11 for a private gift (`{ sats, text? }` → `{ pr, amountSats, messageId }`)                                                                                                                                                                                                                                                                                                                                                                                                                    |
| POST   | `/conversations/:id/read`                            | Bearer                                       | Stamp last-read for the viewer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| POST   | `/conversations/:id/messages/:messageId/translate`   | Bearer                                       | Translate stored conversation text (`{ target }` → `{ translatedText, cached }`)                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GET    | `/notifications`                                     | Bearer                                       | List + unreadCount; drop leftover hidden forum_post/forum_reply (zap checks parent only)                                                                                                                                                                                                                                                                                                                                                                                                                        |
| POST   | `/notifications/read-all`                            | Bearer                                       | Mark all notifications read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| POST   | `/notifications/read-by-message`                     | Bearer                                       | Mark forum and zap notifications for one opened note read and return dismiss tags                                                                                                                                                                                                                                                                                                                                                                                                                               |
| POST   | `/notifications/read-visible`                        | Bearer                                       | Mark forum notifications whose event is the fully shown note read and return dismiss tags                                                                                                                                                                                                                                                                                                                                                                                                                       |
| POST   | `/notifications/:id/read`                            | Bearer                                       | Mark one notification read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| GET    | `/lightning-address`                                 | none                                         | Resolve LUD-16 metadata (cached)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| POST   | `/diagnostics`                                       | none                                         | `{ event }` plus optional `name`, `message`, `prfPresent`, `challengeId`, `accountId`, `stage`, `status`, `path` → `204`; 60/IP and 600 global per minute                                                                                                                                                                                                                                                                                                                                                       |
| GET    | `/debug/accounts`                                    | `Authorization: Bearer`                      | Operator account listing (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| GET    | `/debug/accounts/:id`                                | `Authorization: Bearer`                      | Operator one-account detail (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| POST   | `/debug/accounts`                                    | `Authorization: Bearer`                      | Operator provision name + Lightning Address (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| PATCH  | `/debug/accounts/:id`                                | `Authorization: Bearer`                      | Operator set `role` / unlink Lightning Address / `platform` / `sessionRefused`                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| POST   | `/debug/accounts/:id/session`                        | `Authorization: Bearer`                      | Operator mint of a member bearer (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| POST   | `/debug/accounts/merge`                              | `Authorization: Bearer`                      | Operator merge of one account into another (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| GET    | `/debug/api-log`                                     | `Authorization: Bearer`                      | Operator HTTP audit log (`DEBUG_TOKEN`); follow `before`/`beforeId`; no query string, body, or Authorization stored                                                                                                                                                                                                                                                                                                                                                                                             |
| GET    | `/debug/diagnostics`                                 | `Authorization: Bearer`                      | Operator diagnostic log (`DEBUG_TOKEN`); newest 200; no secrets                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| GET    | `/debug/db`                                          | `Authorization: Bearer`                      | Operator page through every public table (`DEBUG_TOKEN`); follow `nextCursor`                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| GET    | `/debug/contacts`                                    | `Authorization: Bearer`                      | Operator contact listing (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| GET    | `/debug/invoices`                                    | `Authorization: Bearer`                      | Operator invoice attempts, forum and conversation (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| POST   | `/debug/invoices/settle`                             | `Authorization: Bearer`                      | Resumable operator settlement of a paid forum invoice (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| POST   | `/debug/spend-ping`                                  | `Authorization: Bearer`                      | Replay today's daily spend ping for one qualifying top-level forum post (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                         |
| GET    | `/debug/zap-ingests`                                 | `Authorization: Bearer`                      | Operator kind:9735 ingest log (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| GET    | `/debug/messages`                                    | `Authorization: Bearer`                      | Operator forum listing including hidden rows and replies (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| GET    | `/debug/messages/:id`                                | `Authorization: Bearer`                      | Operator single-note fetch including hidden rows (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GET    | `/debug/messages/:id/photo`                          | `Authorization: Bearer`                      | Operator photo bytes including hidden notes (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| PUT    | `/debug/messages/:id/video`                          | `Authorization: Bearer`                      | Operator restore of missing forum-video bytes (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| POST   | `/debug/messages/:id/restore`                        | `Authorization: Bearer`                      | Operator unhide of a soft-hidden forum note (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| GET    | `/debug/external-pubkeys`                            | `Authorization: Bearer`                      | Operator lists entitled and blocked external pubkeys (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GET    | `/debug/trust-edges`                                 | `Authorization: Bearer`                      | Operator trust-edge listing (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| POST   | `/debug/trust-edges`                                 | `Authorization: Bearer`                      | Operator trust-edge backfill (`DEBUG_TOKEN`); does not change `role`                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| DELETE | `/debug/trust-edges`                                 | `Authorization: Bearer`                      | Operator trust-edge delete (`DEBUG_TOKEN`); does not change `role`                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| GET    | `/push/vapid-public`                                 | Bearer                                       | VAPID public key for Web Push subscribe                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| POST   | `/me/push-subscriptions`                             | Bearer                                       | Upsert a browser PushSubscription                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| DELETE | `/me/push-subscriptions`                             | Bearer                                       | Remove a browser PushSubscription                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| POST   | `/debug/push-ping`                                   | Bearer `DEBUG_TOKEN`                         | Enqueue a test push for one account                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| POST   | `/debug/passkey-renew/reopen`                        | Bearer `DEBUG_TOKEN`                         | Delete one account's failed passkey-renew rows so the blocking dialog opens again. Refuses when a seed is already stored.                                                                                                                                                                                                                                                                                                                                                                                       |
| GET    | `/debug/dump`                                        | `Authorization: Bearer`                      | Operator catalog of allowlisted tables (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| GET    | `/debug/dump/:table`                                 | `Authorization: Bearer`                      | Operator catalog of one allowlisted table (`DEBUG_TOKEN`)                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| GET    | `/gifts`                                             | none                                         | Outbound gifts for one UTC day (`?day=`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| GET    | `/gifts/stats`                                       | none                                         | Aggregated outbound gift statistics                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| GET    | `/messages/stats`                                    | none                                         | Living forum notes and replies counted together, by UTC day                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| GET    | `/invoices/passkey`                                  | Bearer `SPEND_API_TOKEN`                     | Whether a Lightning Address has a passkey-backed account                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| GET    | `/invoices/posted`                                   | Bearer `SPEND_API_TOKEN`                     | Live top-level post flag plus welcome media (`welcomeHasMedia` includes About me)                                                                                                                                                                                                                                                                                                                                                                                                                               |
| GET    | `/invoices/eligible`                                 | Bearer `SPEND_API_TOKEN`                     | Whether the address is funding-eligible today, plus effective grant `status`                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| POST   | `/invoices`                                          | Bearer `SPEND_API_TOKEN`                     | Fetch a recipient BOLT11 (LNURL-pay; passkey, funding grant, and forum post required)                                                                                                                                                                                                                                                                                                                                                                                                                           |
| POST   | `/invoices/proof`                                    | Bearer `SPEND_API_TOKEN`                     | Accept payment preimage as proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| POST   | `/spend/daily-instruction`                           | Bearer `SPEND_API_TOKEN`                     | Spend Bearer. Body `{ address }`. The kind is always daily. 503 if the token env is unset; 401 wrong/missing Bearer. Success 200 is `{ action: skip, reason }` or `{ action: pay, amountUsd, comment }`, plus messageId only when the decision includes it.                                                                                                                                                                                                                                                     |

Auth column: "Bearer (X+)" means minimum role X — X or any higher role.

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
  "version": "0.1.0"
}
```

`version` is `SERVICE_VERSION` (env) or `"0.1.0"` when unset.

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

Public LUD-16 payRequest for `username@21.gifts`. No auth. Looks up the
stored username via `getAccountByUsername` after `normalizeUsername` on
the path param. Passes through the linked Wallet of Satoshi LNURL-pay
JSON (`resolveLnurlpDocument`). Callback and metadata stay on Wallet of
Satoshi. While an unexpired pending `pos_charge` exists, both
`minSendable` and `maxSendable` become `amountSats * 1000`. 21.gifts
does not mint invoices. Settlement stays on the linked Wallet of Satoshi
address.

CORS origin and methods match `/.well-known/nostr.json`
(`Access-Control-Allow-Origin: *`, methods `GET` / `OPTIONS`).
The pay request itself is `Cache-Control: no-store`. `public, max-age=60`
stays on `GET /.well-known/nostr.json` only.

Username invalid (`normalizeUsername` returns null), unknown
(`getAccountByUsername` undefined), or unlinked (no non-blank
`lightningAddress`) → **Response** `404`:

```json
{ "error": "Not found" }
```

Wallet of Satoshi unreachable (`!resolved.ok`) or the store throws →
**Response** `502`:

```json
{ "error": "Lightning Address could not be resolved" }
```

Success → **Response** `200` with the provider payRequest JSON. Callback
and metadata are not rewritten. An unexpired pending till charge rewrites
only `minSendable` and `maxSendable`, both to that amount in millisats.

### `GET /pos`

Bearer session. Returns the signed-in member's open point-of-sale charge,
or `charge: null`, plus up to 20 newest rows of any status. A pending row
whose `expiresAt` is not in the future is marked `expired` before the
response and is not `charge`. Amounts are whole sats. There is no paid
status. TTL is five minutes.

**Response** `200`:

```json
{ "charge": null, "history": [] }
```

**Response** `401`: `{ "error": "Unauthorized" }`.

### `POST /pos`

Bearer session. Body `{ "amountSats" }` integer ≥ 1. Requires a username
and a linked Wallet of Satoshi address. Resolves that address and rejects
amounts whose millisats fall outside inclusive `minSendable`..`maxSendable`.
One unexpired pending charge at a time. The insert enforces that again
(`pos_charge_account_pending_idx`; the in-memory store rejects before
append), so a second request that already passed the earlier read is still 409. `201` `{ "charge" }` with `expiresAt` five minutes after `now`. While
pending, `GET /.well-known/lnurlp/:username` keeps the Wallet of Satoshi
callback and metadata and sets both sendable bounds to that millisat amount.

**Response** `400`: `{ "error": "Expected a JSON body with an integer \"amountSats\"" }`,
`{ "error": "Set a username first" }`,
`{ "error": "Set a Wallet of Satoshi address first" }`, or
`{ "error": "Amount is outside the wallet range" }`.

**Response** `409`: `{ "error": "A payment is already open" }`.

**Response** `502`: `{ "error": "Lightning Address could not be resolved" }`.

### `DELETE /pos`

Bearer session. Cancels every unexpired pending charge for the account,
not only the newest. An already expired row is not cancelled.

**Response** `200`: `{ "charge": null }` when at least one row was cancelled.

**Response** `404`: `{ "error": "No open payment" }`.

### `GET /pay/:username`

Public pay-link card. No auth. Normalises `:username`, loads the account,
and returns the trimmed display name (or the normalised username when the
name is blank) plus `minSats`, `maxSats`, and `charge` from the linked
Lightning Address. No open charge → `charge` is `null` and the bounds stay
the wallet sat range. An unexpired pending point-of-sale charge → both
bounds equal that amount and `charge` is `{ amountSats, expiresAt }` only
(`expiresAt` is ISO-8601). A bad wallet window is still 502 before any pin.
`currentPending` throwing is the existing 502. Does not return the
callback, the address, or provider metadata.

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
  "charge": { "amountSats": 21, "expiresAt": "2026-09-01T12:05:00.000Z" }
}
```

Invalid username, unknown account, or blank `lightningAddress` →
**Response** `404` `{ "error": "Not found" }`.

The stored address is not a LUD-16 address, the provider is unreachable,
the store throws, `currentPending` throws, `minSendable` or `maxSendable`
is not a safe integer, or `maxSats < minSats` → **Response** `502`
`{ "error": "Lightning Address could not be resolved" }`.

### `POST /pay/:username/invoice`

One BOLT11 invoice for an exact satoshi amount. No auth. Same account
lookup as `GET /pay/:username` (including the till pin). Body
`{ "amountSats": <integer> }` must sit inside `[minSats, maxSats]` and the
millisatoshi value must sit inside the provider window. A different amount
while a charge is open is the existing 400 and does not call the invoice
callback. The charge amount must still sit in the provider millisatoshi
window or that same 400 is returned and the callback is not called.
Settlement calls the stored address, never `username@21.gifts`. No comment.
No spend token.

**Response** `200`:

```json
{ "pr": "lnbc...", "amountSats": 21 }
```

The `pr` is returned only when it decodes to exactly `amountSats * 1000`
millisatoshis.

Invalid username, unknown account, or blank address → **Response** `404`
`{ "error": "Not found" }`. Missing or invalid JSON, a non-integer, or an
amount outside the window → **Response** `400`
`{ "error": "Enter a whole number of sats" }`. Resolve or store failure, an
empty or non-safe-integer window, a failed invoice fetch, or a BOLT11 that
is missing, not a safe integer amount, or not the requested amount →
**Response** `502` `{ "error": "Lightning Address could not be resolved" }`.

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

| Status | Body                                                                                              | When                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 500    | `{ "error": "Server auth is not configured" }`                                                    | RP ID missing, not on the allowlist, or no matching origin                                              |
| 400    | `{ "error": "Finish body is not valid JSON" }`                                                    | Body is not JSON                                                                                        |
| 400    | `{ "error": "Expected a JSON body with challengeId and credential" }`                             | Missing body, or JSON that is not `{ challengeId, credential }`                                         |
| 400    | `{ "error": "Unknown or expired challenge" }`                                                     | Unknown `challengeId`                                                                                   |
| 400    | `{ "error": "Challenge expired" }`                                                                | Past challenge TTL                                                                                      |
| 400    | `{ "error": "Challenge already used" }`                                                           | Finish already attempted; challenge is consumed before verification                                     |
| 400    | `{ "error": "Wrong challenge type" }`                                                             | Challenge is not `register`                                                                             |
| 400    | `{ "error": "Invalid origin" }`                                                                   | Missing or disallowed `Origin`                                                                          |
| 400    | `{ "error": "Invalid passkey" }`                                                                  | Attestation verify failed or duplicate credential                                                       |
| 400    | `{ "error": "Username must be 1–32 characters of a-z, 0-9, hyphen, underscore, or dot" }`         | Stored register name no longer normalizes; no credential and no session                                 |
| 403    | `{ "error": "You signed in with the wrong account. Please try again with the correct account." }` | Account with `sessionRefused`; no bearer is persisted                                                   |
| 409    | `{ "error": "Username is already in use" }`                                                       | Register-challenge name taken at finish, or the account row was not inserted; no credential, no session |

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
    "passkeyCredentialId": "<base64url>",
    "passkeyRenewFailed": false,
    "passkeyRenewClosed": false,
    "passkeyRenewPrfUnsupported": false
  }
}
```

The `account` object is the same owner JSON as `GET /me` (includes `viewKey`, `setup`, `missing`, `hasPosted`, `aboutMe`, `aboutMeHasPhoto`, `aboutMessageId`, `notificationLevel`, `amountUnit`, `locale`, `fiat`, `walletRequired`, `walletBackupSeenAt`, `passkeyCredentialId`, `passkeyRenewFailed`, `passkeyRenewClosed`, and `passkeyRenewPrfUnsupported`). `passkeyRenewPrfUnsupported` is true only when the newest unacknowledged failed row has error name `prfUnsupported`. `locale` and `fiat` are null until the member's app stores them. The example above is a nameless new register (`name: null`, `username: null`, `setup: "name"`). When begin stored a name, `name` and `username` are that normalised handle (example `ada`), `nameSkippedAt` stays null, there is no profile note, and `setup` is `lightning-address`. Finish does not take `name` from the body. The recovery phrase is not a setup step and does not change `setup` or `missing`. Existing members start with `walletRequired: false`. Seed finish sets `walletRequired: true` and does not change `walletBackupSeenAt`. Replace refuses and changes nothing. `walletBackupSeenAt` does not decide whether a seed exists. The nameless example remains `walletRequired: true` with `setup: "name"` when the name is unset.

A new register row is stored with `walletRequired: true` and `walletBackupSeenAt: null`. First-passkey claim of a provisioned row sets `walletRequired: true` in the same write as the credential (`createFirstPasskeyCredential`: Postgres CTE locks the account row with `FOR UPDATE`, then inserts and sets `wallet_required`; memory store writes both in one method) and does not clear a seen timestamp. Passkey replace refuses and does not change these columns. Seed finish sets `walletRequired: true` without changing `walletBackupSeenAt`. Operator `POST /debug/accounts` provision leaves `walletRequired` false. The api never stores a mnemonic or PRF output.

### `POST /auth/passkey/authenticate/begin`

Starts a discoverable-credential assertion. `allowCredentials` is empty.
Same 500 as register begin when WebAuthn is unconfigured.

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
not stored. An account with `sessionRefused` is **403**
`{ "error": "You signed in with the wrong account. Please try again with the correct account." }`
and does not persist a bearer. Success body matches register finish
(`linkingKey` is whatever the account currently has).

### `POST /auth/passkey/replace/begin`

After a valid Bearer this returns **409**
`{ "error": "A recovery phrase cannot be replaced" }`.
It does not create a challenge, does not delete or insert a passkey, and
does not mint a session.

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
  "passkeyCredentialId": null,
  "passkeyRenewFailed": false,
  "passkeyRenewClosed": false,
  "passkeyRenewPrfUnsupported": false
}
```

The example above is an existing member (`walletRequired: false`,
`walletBackupSeenAt: null`). New register/claim owner JSON has
`walletRequired: true` and `setup: "name"` when the name is unset.
The recovery phrase is not a setup step and does not change `setup` or `missing`.
`staffTag` is present only as `"software_developer"` when set and is omitted
otherwise (never JSON `null`). It is not a permission and does not change
`role`.

About me is the profile-note text when it is a real bio, else null (auto
name-copy is not a bio, including after a display-name rename when the note
text still equals the stored profile-note `name` (Ada→Grace with text `Ada`
stays `null`)).

| Field                        | Type           | Meaning                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                         | string         | Opaque account id                                                                                                                                                                                                                                                                                                                                        |
| `linkingKey`                 | string \| null | Historical LNURL-auth linking key (hex), or `null` for passkey accounts                                                                                                                                                                                                                                                                                  |
| `role`                       | string         | `basis`, `verified`, `moderator`, `initiator`, or `founder`                                                                                                                                                                                                                                                                                              |
| `staffTag`                   | string         | Present only as `"software_developer"` when set; omitted otherwise. Never JSON `null`. Not a permission and does not change `role`.                                                                                                                                                                                                                      |
| `name`                       | string \| null | Display name, or `null` until set                                                                                                                                                                                                                                                                                                                        |
| `username`                   | string \| null | Unique LUD-16 / NIP-05 local-part (`a-z0-9-_.`), or `null` until set. Cannot skip.                                                                                                                                                                                                                                                                       |
| `location`                   | string \| null | Free-text location set by the owner, or `null` when unset. Not unique. Not a setup step.                                                                                                                                                                                                                                                                 |
| `lightningAddress`           | string \| null | Linked LUD-16 address, or `null`                                                                                                                                                                                                                                                                                                                         |
| `lightningAddressVerified`   | boolean        | Proof-of-control flag (`true` only after confirm)                                                                                                                                                                                                                                                                                                        |
| `forumLawsDismissed`         | boolean        | `true` after the welcome-forum living-room laws hint was dismissed                                                                                                                                                                                                                                                                                       |
| `viewKey`                    | string         | Durable 64 lowercase hex capability secret for GET /view/:viewKey. Owner-only. Not a session.                                                                                                                                                                                                                                                            |
| `createdAt`                  | number         | Creation time (epoch ms)                                                                                                                                                                                                                                                                                                                                 |
| `rulesAgreedAt`              | number \| null | Epoch ms of first living-room rules agreement, or `null`                                                                                                                                                                                                                                                                                                 |
| `setup`                      | string \| null | Next wizard step: `name`, `username`, `lightning-address`, `rules`, or `null` when complete. The union still includes `wallet` for older clients; the api never returns it. Skip timestamps count as done except username, which cannot be skipped. Wallet backup is not a setup step. Clients must not invent a parallel sequence.                      |
| `missing`                    | string[]       | Factually unset fields (`name`, `username`, `lightning-address`, `rules`) even when skipped. Never includes `wallet`. Does not include `profileMessageId`.                                                                                                                                                                                               |
| hasPosted                    | boolean        | True when there is a live forum row that is not the profile note (replies still count) OR when `aboutMe` is non-null. A profile note that is only the display-name copy, a photo without bio text, a missing note, and a soft-hidden note do not count. Not the same predicate as GET /invoices/posted (that stays top-level non-profile only).          |
| `aboutMe`                    | string \| null | Profile-note text when it is a real bio, else `null` (missing or soft-hidden (`deletedAt` set); auto name-copy is not a bio, including after a display-name rename when the note text still equals the stored profile-note `name` (Ada→Grace with text `Ada` stays `null`))                                                                              |
| `aboutMeHasPhoto`            | boolean        | True when the live profile note has a stored JPEG/PNG/WebP. Independent of `aboutMe` (photo-only and name-copy notes can still have a photo). Bytes are `GET /me/about/photo`. Does not expose `profileMessageId`.                                                                                                                                       |
| `aboutMessageId`             | string \| null | Id of the stored About me note when `aboutMe` is non-null. `null` when `aboutMe` is `null` (including a name-copy note). Not a display name.                                                                                                                                                                                                             |
| `notificationLevel`          | string         | Owner fan-out filter: `all`, `active`, or `mentions`. Default `all`. Owner-only; omitted from public `GET /view/:viewKey` and member cards.                                                                                                                                                                                                              |
| `amountUnit`                 | string         | Owner amount-entry unit: `btc` or `fiat`. Default `btc`. Owner-only; omitted from public `GET /view/:viewKey` and member cards. The last unit the member chose on any amount field.                                                                                                                                                                      |
| `locale`                     | string \| null | Owner UI language: `en`, `de`, `es`, or `fil`, or `null` when not stored yet. Owner-only; omitted from public `GET /view/:viewKey` and member cards. A stored value wins over the browser.                                                                                                                                                               |
| `fiat`                       | string \| null | Owner fiat: `CHF`, `EUR`, `USD`, or `PHP`, or `null` when not stored yet. Owner-only; omitted from public `GET /view/:viewKey` and member cards. A stored value wins over the language default.                                                                                                                                                          |
| `funding`                    | object \| null | Funding-program grant. `null` for `basis`. Otherwise always an object; no row is `{ status: "none", trialUtcDate: null, admittedAt: null, reviewedByName: null, dailyPayoutStoppedNotice: false }`. `dailyPayoutStoppedNotice` is true only for the six legacy daily accounts while effective status is `none`. Admitted includes live `reviewedByName`. |
| `walletRequired`             | boolean        | True when a seed-bearing passkey exists (new register/claim, or seed finish). Default false does not mean a seed is present. It does not make `setup` `'wallet'`.                                                                                                                                                                                        |
| `walletBackupSeenAt`         | number \| null | Epoch ms recorded after an existing member activates a passkey that can show a recovery phrase, so the app can offer Show recovery phrase next time instead of Activate. Not a confirmation. Not a seed check; it does not decide whether a seed exists. Null when that has not been recorded.                                                           |
| `passkeyCredentialId`        | string \| null | Null when `walletRequired` is not true, even if a login passkey exists. When `walletRequired` is true it is the newest credential id (`created_at` desc, `credential_id` desc with `COLLATE "C"`). Owner-only.                                                                                                                                           |
| `passkeyRenewFailed`         | boolean        | True only when that account has a failed renew row whose `acknowledged_at` is null. Owner-only.                                                                                                                                                                                                                                                          |
| `passkeyRenewClosed`         | boolean        | True only when `walletRequired` is not true and a failed renew row has non-null `acknowledged_at`. A later seed (`walletRequired` true) is not closed. While this is true the account still has no seed. Owner-only.                                                                                                                                     |
| `passkeyRenewPrfUnsupported` | boolean        | True only when the newest unacknowledged failed renew row has error name `prfUnsupported`. Owner-only. False when that row is absent, acknowledged, or a different error.                                                                                                                                                                                |

### `GET /me/activity`

Bearer required (same session as `GET /me`). No living-room-rules gate.

Missing or invalid bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

Store throw or missing BTC-USD day → **Response** `503`:

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
  "fx": {
    "quote": "BTC-USD",
    "dayBasis": "utc",
    "source": "coinbase-exchange-daily-close",
    "quotes": [{ "code": "USD", "pair": "BTC-USD", "source": "coinbase-exchange-daily-close" }]
  }
}
```

`donatedOverTime` / `receivedOverTime` reuse the `spendOverTime` day objects from `GET /gifts/stats`, including additive CHF/EUR/PHP. The stored payment-time USD/CHF/EUR/PHP is what is returned. Missing fiat is JSON `null`, never 503 (`account.activity.fiat_failed` still 200). Empty activity is 200 zeros with USD-only `fx.quotes` (no Coinbase / Frankfurter). Given = confirmed forum zaps this account paid on notes that are not loans, excluding repay: repayment invoices, plus outbound house gifts of kind daily and welcome when isPlatform is true. Moderator stipends (kind === 'moderator') are omitted. Received = indexed zaps on authored notes that are not loans (including hidden notes and replies), plus message.sats remainder on top-level non-loan notes only (a loan note is omitted entirely, including a hidden one; gift-as-reply sats are not Received), plus house gifts of kind daily and welcome to the account Lightning Address handle. A loan is a note with goalRepayable === true. An unknown note (getById undefined) still counts as a donation. Forum zaps are not mixed into GET /gifts/stats.

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
Sets the matching skip timestamp to now; does not clear `name` /
`lightningAddress`. `step: "wallet"` is **400** with the same copy as an
invalid step: `{ "error": "Expected a JSON body with step \"name\" or \"lightning-address\"" }`.
`step: "rules"` and unknown steps are the same **400**. Success → **200**
owner JSON.

### `GET /members/:accountId`

Bearer required. `:accountId` must be a UUID. After auth,
`requireAction(caller, 'forum.read')` — missing rules → **409**
`{ "error": "missing_requirements", "missing": ["rules"] }`. Unknown id →
**404**. Store throw → **503** `{ "error": "Messages are unavailable" }`.
Success → live `id` / `name` / `username` (`string | null` LUD-16 / NIP-05
local-part) / `location` / `role` / `lightningAddress` / ISO
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
`eventId`. Never pending/trial/rejected on the member card.

### `GET /members/:accountId/posts`

Bearer required. Same 401 / 409 / 404 / 503 as `GET /members/:accountId`
(`members.posts.failed` on 503). Live-only top-level notes by the member,
newest-first, capped at 200. Body `{ "messages": [...] }` via
`serializeMessage` like signed-in `GET /messages` (`accountId`,
`replyCount`, `payable` when a non-empty `eventId` and a non-blank Lightning Address are set;
optional `goalSats` omitted when unset, optional `goalRepayable: true` when
the stored column is true (omitted when null; never false), optional
`goalTermDays` when the stored column is not null (omitted when null), and when
`goalCurrency` is stored also `goalCurrency`, `goalAmount`, and the four
`goalAmount*` snapshots — a snapshot may be null, a legacy row omits those
keys).
Omits `parentId`. Replies by that member are not listed.

### `GET /members/:accountId/replies`

Bearer required. Same 401 / 409 / 404 / 503 as `GET /members/:accountId`
(`members.replies.failed` on 503). Live-only replies by the member,
newest-first, capped at 200. Body `{ "messages": [...] }` via
`serializeMessage` with `payable` when a non-empty `eventId` and a non-blank Lightning Address are set, `accountId`, and optional
`parentId` when set; omits `replyCount`. Replies never include `goalSats`,
`goalRepayable`, or `goalTermDays`.
Top-level notes by that member are not listed.

### `GET /members/:accountId/activity`

Same auth and 401 / 409 / 404 as `GET /members/:accountId`. Success is the
same JSON as `GET /me/activity` for **that** member. 503 `{ "error": "Gift
stats are unavailable" }` when the gift store throws or a gift day lacks
BTC-USD.

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

Staff pending-moderator queue. Bearer **session** required (moderator).
This is **not** a `DEBUG_TOKEN` route. No `forum.read` /
rules gate — a moderator without rules agreement is still **200**.

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

Bearer session. Body `{ "accountId": "<uuid>", "confirmedName": "<string>" }`.
Caller must be at least `moderator`. Inserts a `verify` edge from the caller
to the subject, then sets `account.role` to `verified`. `verified` is a
real-life confirmation (forum badge), not Lightning-Address proof.

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
me. Omitted messages or spend ping skips that ping. A ping failure still
returns **200**.

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
While applications are paused, every verified caller except
`joey-rosima`, `vincent`, and `jewel-bacolbas` gets **403**
`{ "error": "Applications are paused" }` with no About me, photo,
location, or grant write, and the route logs `funding.apply.paused`
`{ accountId }`. Those three usernames are not paused. They, and every
caller when the route is built with `applicationsPaused` set to false,
still run the checks below. Production omits that flag. Apply requires a
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

### `GET /funding/applications/:accountId`

Staff Bearer. **404** when the id is not a UUID, the account is missing,
or there is no grant. **200** `{ account: { id, name, role, lightningAddress },
grant: { status, appliedAt, trialUtcDate, admittedAt, decidedAt },
messages }` with **effective** grant status and the same video-drop as
member posts (`MESSAGE_LIST_LIMIT`, `serializeMessage`).

### `POST /funding/trial`

Staff Bearer. Body `{ "accountId" }`. Target must be effective pending,
not self, not `basis`. Sets `trial`, `trialUtcDate` = today UTC,
`decidedAt`/`decidedBy` now. **200** `{ id, name, role, funding }`.
Self / ineligible → **409**. Same 401/403/400/404/503 as
`POST /trust/verify` with Funding-unavailable 503.

### `POST /funding/admit`

Staff Bearer. Target effective pending **or** trial, not self, not
`basis`. Sets `admitted`, `admittedAt` now, `trialUtcDate` null.
**200** same shape as trial.

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
Logs `funding.payouts.listed` `{ count }`.
No session → **401** `{ "error": "Unauthorized" }`. Below moderator →
**403** `{ "error": "Forbidden" }`. Store throw → **503**
`{ "error": "Funding is unavailable" }` (`funding.payouts.failed`).

### `GET /funding/daily-roster`

Bearer session, then initiator or founder (`canEditDailyPayoutRoster`). No session → 401 `{ "error": "Unauthorized" }`. Any other role, including moderator → 403 `{ "error": "Forbidden" }` and never 503. The API roster store is always present. Success 200 is only `{ comment, paymentsEnabled, defaultAmountUsd, recipients: [{ address, amountUsd, accountId, name }] }`. `defaultAmountUsd` is always 1: the USD paid to an unlisted admitted or trial grant. Moderators are not mixed into this public list. A store 400 whose `error` is exactly `Invalid comment`, `Invalid payments switch`, `Invalid address or amount`, `Address already listed`, or `Unknown address` stays 400 with that text. Any other store throw → 502 `{ "error": "Daily roster is unavailable" }`.

### `POST /funding/daily-roster/comment`

Same gate and success/502 as GET. Body `{ comment: string }`. A body that is not that object, including a non-string comment → 400 `{ "error": "Invalid comment" }`. Newlines (`\n`, `\r`, `\r\n`) become spaces, then trim. Empty after trim is valid. Longer than 500 characters after that is 400 `{ "error": "Invalid comment" }` and is not cut. The stored `{ comment }` is that normalized string. The store returns any of these five exact texts unchanged: `Invalid comment`, `Invalid payments switch`, `Invalid address or amount`, `Address already listed`, `Unknown address`.

### `POST /funding/daily-roster/payments`

Same gate and success/502 as GET. Body `{ enabled: boolean }` only. Strings, numbers, and missing fields → 400 `{ "error": "Invalid payments switch" }`. Sets `paymentsEnabled` only. Store 400 texts are the same five.

### `POST /funding/daily-roster/recipients`

Same gate and success/502 as GET. Public body `{ accountId: string, amountUsd: number }`. `accountId` must match `MESSAGE_ID_RE`. `amountUsd` must be a finite number; numeric strings are rejected here. A body that is still `{ address, amountUsd }` fails. Local bad body → 400 `{ "error": "Invalid person or amount" }`. The route loads the account. Unknown account → 400 `{ "error": "Unknown person" }`. No Lightning address after trim → 400 `{ "error": "Person has no Lightning address" }`. Store failure on that load → 502 `{ "error": "Daily roster is unavailable" }`. The API store receives `{ address, amountUsd }` from the stored trimmed address and the amount. Duplicate addresses are case-insensitive (`trim` then `toLowerCase`). Store 400 texts are the same five.

### `POST /funding/daily-roster/recipients/update`

Same gate and success/502 as GET. Body `{ address: string, amountUsd: finite number }`. If the body is an object (not an array) whose `address` is a string but the amount fails → 400 `{ "error": "Invalid address or amount" }`. Any other local failure, including a missing address → 400 `{ "error": "Unknown address" }`. Address match is after trim and lower-case. Other row fields stay. Store 400 strings are the same five.

### `POST /funding/daily-roster/recipients/delete`

Same gate and success/502 as GET. Body `{ address: string }`. Local failure → 400 `{ "error": "Unknown address" }` always. Store 400 texts are the same five.

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

Bearer session. Any signed-in role, including `basis`. Missing or
invalid bearer is **401** `{ "error": "Unauthorized" }`. Seven UTC days
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
`created_at` on that day, any status (`pending`, `cancelled`, or
`expired`). Distinct notes, not accounts: one account on two notes
counts twice. Duplicate note ids count once. Reassigning the account,
clearing it, removing the hashtag, or soft-deleting the note rewrites
every past day. This is not a historical usage log. JSON
`{ "days": [ { "day": "YYYY-MM-DD", "shopCount": 0 } ] }` with exactly
30 objects, missing days included as zero. No Sunday-rest gate. Does
not create a BOLT11 invoice. A store throw → **503**
`{ "error": "Shop activity is unavailable" }` and log
`shops.activity.failed` with no account, note, or charge ids.

### `GET /view/:viewKey`

Public capability URL for a read-only profile card. No auth. Not a session:
the key cannot write, cannot mint a session, and is not accepted as
`Authorization: Bearer`.

Param not matching `/^[0-9a-f]{64}$/` or an unknown key → **Response** `404`:

```json
{ "error": "Not found" }
```

**Response** `200` (ten fields including `username` (`string | null`);
omits `id`, `linkingKey`, `role`, `viewKey`):

```json
{
  "name": null,
  "username": null,
  "location": null,
  "lightningAddress": null,
  "lightningAddressVerified": false,
  "createdAt": 0,
  "hasPasskey": false,
  "aboutMe": null,
  "aboutMeHasPhoto": false,
  "aboutMessageId": null
}
```

`hasPasskey` is `true` when the account has at least one passkey credential,
otherwise `false`. Clients use it to show an activation banner only while the
profile is still unclaimed. `aboutMe` is the profile-note text when it is a
real bio, else `null` (missing or soft-hidden (`deletedAt` set); auto
name-copy is not a bio, including after a display-name rename when the note
text still equals the stored profile-note `name` (Ada→Grace with text `Ada`
stays `null`)). `aboutMeHasPhoto` is true when the live profile note has a
stored photo; bytes are `GET /view/:viewKey/about/photo`. Store throw on the
profile-note read → **503** `{ "error": "Messages are unavailable" }`
(`view.get.failed`).

### `GET /view/:viewKey/activity`

Public. Same 404 as `GET /view/:viewKey` for a bad or unknown key. Success is
the same JSON as `GET /me/activity` for the account behind the key. 503
`{ "error": "Gift stats are unavailable" }` when the gift store throws or a
gift day lacks BTC-USD.

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
does). When a non-blank Lightning Address is already linked, the first
persisted non-empty name also creates exactly one top-level profile
forum note and claims `profileMessageId` via `claimProfileMessageId`
(set only while the pointer still matches the missing/hidden read; not
on owner JSON). Without a Lightning Address the name is stored and no
profile note is inserted (linking the address later creates it). Rename
does not create a second note and does not change the note text.

### `POST /me/username`

Set the unique LUD-16 / NIP-05 local-part. Body:

```json
{ "username": "ada" }
```

Charset is lowercase `a-z0-9-_.`, 1–32 characters, leading letter or
digit. Cannot skip (no `POST /me/setup/skip` step for username; skip
body is only `"name" | "lightning-address"`). Same handle on the same
account is idempotent **200**.

Missing/invalid bearer → **Response** `401` `{ "error": "Unauthorized" }`.

Body is not JSON with a `username` string → **Response** `400`:

```json
{ "error": "Expected a JSON body with a \"username\" string" }
```

`normalizeUsername` fails (invalid charset / length / leading character /
`_` alone) → **Response** `400`:

```json
{ "error": "Username must be 1–32 characters of a-z, 0-9, hyphen, underscore, or dot" }
```

Another account owns the handle, including a unique-index race
(re-read after `updateAccount`: if the stored username lower/trim is
not the requested handle) → **Response** `409`:

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

Lightning Address is not required. Empty `text` clears the bio
(`aboutMe` becomes `null`; a live note row is kept with empty text).
When no live profile note exists (missing or soft-hidden), empty text
with `photo` omitted or `null` does not create a note and does not
notify. Empty text **with** a decoded photo creates a photo-only live
note. A non-empty write with no live note (missing or soft-hidden)
creates a new live note even without a Lightning Address and claims
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

Success → **Response** `200` with the account (same shape as `GET /me`).
About me is the profile-note text when it is a real bio, else null (auto
name-copy is not a bio, including after a display-name rename when the
note text still equals the stored profile-note `name` (Ada→Grace with
text `Ada` stays `null`)). `aboutMeHasPhoto` is true when the live note
has a stored photo. After that successful save, a verified account with a
live top-level photo or video (including this note) is welcome-pinged.
Omitted spend ping skips. A ping failure still returns **200**.

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

### `POST /me/notification-level`

Set the owner fan-out filter. Bearer session required (same as
`POST /me/forum-laws-dismissed`). Body:

```json
{ "level": "active" }
```

`level` must be `all`, `active`, or `mentions`.

Missing/invalid bearer → **Response** `401` `{ "error": "Unauthorized" }`.

Body is missing, not JSON, or `level` is not one of those three strings
→ **Response** `400`:

```json
{ "error": "Expected a JSON body with a level of all, active, or mentions" }
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
New accounts start with `rulesAgreedAt: null`. Name and Lightning Address
link/unlink do not clear the timestamp.

### `POST /me/lightning-address`

Link or replace the receiver Lightning Address. After the LUD-16 shape check,
the api live-resolves the well-known LNURL-pay metadata and requires zap
support (`allowsNostr === true` and a non-empty `nostrPubkey`). It then runs a
NIP-57 mint probe (`probeNip57Mint` with the account's custodial key): a
throwaway kind:9734 is signed, an invoice is requested (never paid), and the
BOLT11 must be a NIP-57 `description_hash` invoice. Placeholder, unreachable,
or non-zap addresses are rejected and not stored. Body:

```json
{ "address": "name@domain.tld" }
```

Missing/invalid bearer → **Response** `401` `{ "error": "Unauthorized" }`.

Body is not JSON with an `address` string → **Response** `400`:

```json
{ "error": "Expected a JSON body with an \"address\" string" }
```

Address fails LUD-16 shape check, or trimmed length `> 255` → **Response**
`400`:

```json
{ "error": "Not a valid Lightning Address (expected name@domain)" }
```

Well-known resolve fails, metadata lacks zap support, or the mint probe is
`unreachable` → **Response** `400` (account unchanged; logs
`account.lightning_address.resolve_failed`):

```json
{ "error": "Lightning Address could not be resolved" }
```

Mint probe returns `not_zap` (wallet advertised zap support but the minted
invoice is not NIP-57) → **Response** `400` (account unchanged; logs
`account.lightning_address.not_zap`):

```json
{ "error": "This Wallet of Satoshi address cannot receive these Bitcoin payments" }
```

Missing `NOSTR_NSEC_KEK` / `nostrKek`, key ensure failure, or a missing
account pubkey after ensure → **Response** `503` (account unchanged):

```json
{ "error": "Lightning Address could not be resolved" }
```

Another account already owns the address (including a unique-index race)
→ **Response** `409`:

```json
{ "error": "Lightning Address is already in use" }
```

Success → **Response** `200` with the updated account (same shape as
`GET /me`). `lightningAddressVerified` is always reset to `false`, and any
pending verification for the account is cleared. After the address is
stored, `ensureProfileMessage` runs so a non-blank display name that was
set earlier gets its profile forum note. There is no proof-of-control in
this step — use `POST /me/lightning-address/verification` for that.

### `DELETE /me/lightning-address`

Unlink the receiver Lightning Address. Also clears any pending verification
for the account.

Missing/invalid bearer → **Response** `401` `{ "error": "Unauthorized" }`.

Success → **Response** `200` with the updated account:

- `lightningAddress`: `null`
- `lightningAddressVerified`: `false`

Does not clear `username`. After unlink, `setup` is `username` if the
handle is blank; `setup` is `lightning-address` when name is done or
skipped **and** username is set (and LN is blank / skip cleared). The
recovery phrase is not a setup step and does not change `setup` or
`missing`.

### `POST /me/lightning-address/verification`

Start proof-of-control for the linked Lightning Address. No request body.

The api resolves the address via LUD-16 / LNURL-pay, pays **1 sat** (or the
provider's `minSendable` if higher, capped at 10 sat) with a one-time nonce in
the LUD-12 comment (`21gifts <32-hex-nonce>`), and stores a pending
verification (TTL 15 minutes). The **nonce is never returned** — the user
reads it from their wallet payment history and posts it to confirm.

Missing/invalid bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

No linked address → **Response** `409`:

```json
{ "error": "No Lightning Address linked" }
```

Address already verified → **Response** `409`:

```json
{ "error": "Lightning Address already verified" }
```

No invoice payer configured (default until a real payer is wired) →
**Response** `503`:

```json
{ "error": "Verification payments are not configured" }
```

LNURL-pay resolve/invoice failure, or payment failure → **Response** `502`:

```json
{ "error": "Lightning Address did not accept the verification payment" }
```

Success → **Response** `200`:

```json
{ "status": "sent", "expiresInSeconds": 900, "sats": 1 }
```

| Field              | Meaning                                                                               |
| ------------------ | ------------------------------------------------------------------------------------- |
| `status`           | Always `"sent"` on success                                                            |
| `expiresInSeconds` | Seconds until the pending record expires                                              |
| `sats`             | Amount paid, in sats (`payMsat / 1000`; fractional if minSendable is not a whole sat) |

Linking or unlinking the address clears any pending verification.

### `POST /me/lightning-address/verification/confirm`

Confirm proof-of-control with the nonce from the wallet history. Body:

```json
{ "nonce": "<32 hex chars>" }
```

Missing/invalid bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

Body is not JSON with a `nonce` string → **Response** `400`:

```json
{ "error": "Expected a JSON body with a \"nonce\" string" }
```

Empty nonce after trim, or nonce does not match → **Response** `400`:

```json
{ "error": "Incorrect verification code" }
```

No pending verification (or address no longer matches the record) →
**Response** `409`:

```json
{ "error": "No verification in progress" }
```

Pending verification past the TTL → **Response** `409`:

```json
{ "error": "Verification expired" }
```

Success → **Response** `200` with the updated account (same shape as
`GET /me`), with `lightningAddressVerified: true`. The pending record is
deleted.

### `GET /lightning-address`

Public LUD-16 metadata resolve for a future guest Donate flow. The api is
**not** in the payment path: this route returns cached well-known LNURL-pay
metadata only. It never fetches a BOLT11 invoice (`pr`) and never pays.

Query parameter:

| Param     | Required | Meaning                               |
| --------- | -------- | ------------------------------------- |
| `address` | yes      | Lightning Address (`name@domain.tld`) |

The value is normalised with the same LUD-16 shape check as
`POST /me/lightning-address` (trim; length ≤ 255; `local@domain.tld`).

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
absent. `bytea` cells, including `nostr_nsec_ciphertext`, are octet lengths.
Text in `token`, `challenge`, `nonce`, `view_key`, `endpoint`, `p256dh`,
`auth`, `delivered_endpoints`, and `skip_endpoints` is the string `"redacted"`. A primary key
that is one of those columns is paged by `ctid`, so the cursor is not the
secret. A cursor that does not match the key is **Response** `400`
`{ "error": "Invalid cursor" }`. An unknown table is **Response** `404`
`{ "error": "Not found" }`. A store failure is **Response** `503`
`{ "error": "Database is unavailable" }`.

### `GET /debug/accounts`

Operator listing of every stored account. Authenticated with
`Authorization: Bearer` matching `DEBUG_TOKEN`. This is not an end-user
session. Session tokens and verification nonces are never returned.

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
`walletBackupSeenAt`, and Nostr debug fields). `locale` and `fiat` are null
until stored. `staffTag` is present only as `"software_developer"` when set
and is omitted otherwise (never JSON `null`). It is not a permission and
does not change `role`. Member `GET /me` does not include `isPlatform` or
`sessionRefused`. Public member cards omit `locale` and `fiat`.

Accounts are ordered by `createdAt` ascending, then `id`. An empty store
returns `"accounts": []`.

Environment:

| Variable       | Meaning                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `DATABASE_URL` | When set, auth state is stored in Postgres; when unset, in-memory only. |
| `DEBUG_TOKEN`  | Operator bearer for this route. Unset → 503; process still boots.       |

### `GET /debug/accounts/:id`

Operator detail of one account via `serializeDebugAccountDetail`: every
account column plus nested `passkeys`, `sessions`, `addressVerification`,
and matching `passkeyChallenges`. Session tokens are plaintext. nsec is
envelope hex, never decrypted. Unknown or non-UUID id → **Response** `404`.
Same `DEBUG_TOKEN` gate as `GET /debug/accounts`.

### `POST /debug/accounts`

Operator provision of accounts by display name and Lightning Address, with no
passkey and `rulesAgreedAt` null. Same `DEBUG_TOKEN` bearer as GET. **All**
new addresses are NIP-57 mint-probed (`probeNip57Mint` with an ephemeral key)
first; only then is any row persisted. Set `NIP57_PROBE=0` to skip that probe
(e2e only; Playwright pins it). Unset in production so every new address is
still probed. One failing new-address probe is
**400** and no new address in that request is saved. Name-only updates
(address already in the store) do **not** probe and run after every probe
has passed.

**Request** JSON `{ "accounts": [ { "name": string, "lightningAddress": string } ] }`
(1–100 rows; name 1–80 after trim; address has exactly one `@` with both sides
non-empty). Invalid body, C0/DEL in a name, or an address that is not LUD-16
→ **Response** `400` `{ "error": "Expected a JSON body with an \"accounts\" array" }`
(no row is written). Mint probe `not_zap` → **Response** `400`
`{ "error": "This Wallet of Satoshi address cannot receive these Bitcoin payments" }`
(no new address in that request is saved). Mint probe `unreachable` → **Response** `400`
`{ "error": "Lightning Address could not be resolved" }` (no new address in
that request is saved). Create that does
not persist the address, a name-only update that matches no row, or a
name-only update that returns a row whose `name` is not the requested name
→ **Response** `500` `{ "error": "Could not save the account" }`.

Success → **Response** `200`:

```json
{
  "accounts": [
    {
      "name": "Ada",
      "lightningAddress": "guest@walletofsatoshi.com",
      "viewKey": "<64 lowercase hex>",
      "created": true
    }
  ]
}
```

Existing address (`lower(trim)`): name-only write still goes through
`updateAccountNameByLightningAddress` (name column only; `viewKey`, `role`,
`rulesAgreedAt`, and other columns stay unchanged in that write). Then, if
stored username is blank, `maybeSetProvisionUsername` fills it. A non-blank
stored username is kept. `created` is `false`. New address: sets
`provisionUsername` on the new `basis` row (fresh `viewKey`, `created` is
`true`). `GET /debug/accounts` and `GET /debug/accounts/:id` also include
`viewKey` (and provisioned `username`).

### `PATCH /debug/accounts/:id`

Operator assignment of the account's forum display role, unlinking the
Lightning Address, the official platform flag (`isPlatform`), and/or
session refusal (`sessionRefused`). Authenticated with
`Authorization: Bearer` matching `DEBUG_TOKEN` (same gate as
`GET /debug/accounts`). Body is one or more of `role`,
`lightningAddress: null`, `platform`, and `sessionRefused`:

```json
{ "role": "basis", "lightningAddress": null, "platform": true, "sessionRefused": true }
```

`role` must be one of `basis`, `verified`, `moderator`, `initiator`, or `founder`.
`lightningAddress` may only be JSON `null` (unlink). `platform` is a
boolean; `true` clears any other platform flag (at most one `isPlatform`
account) and, when a conversation store is wired, points every
`member_platform` thread at this account except a thread whose member is
already this account. `sessionRefused` is a boolean; `true` makes passkey
finish and this route's session mint return 403 with the wrong-account
copy (`GET /me` too). Setting a new address is not supported here
(`POST /me/lightning-address` remains the live resolve path). Unlink
resets `lightningAddressVerified` to `false` and drops any in-flight
verification. It does not clear `username`. `GET /me` then returns `setup: "username"` if
the handle is blank, or `setup: "lightning-address"` when name is done or
skipped **and** username is set (and LN is blank / skip cleared). The recovery
phrase is not a setup step and does not change `setup` or `missing`, so any
client that follows `setup` shows the username or address form as appropriate. `verified` as a **role** is a
human-identity badge (a moderator physically met the person); it
is not `lightningAddressVerified`. New passkey accounts stay `basis` until
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

Body is not JSON with a known `role`, `lightningAddress: null`,
`platform` boolean, and/or `sessionRefused` boolean → **Response** `400`:

```json
{
  "error": "Expected a JSON body with a \"role\" string, lightningAddress null, platform boolean, and/or sessionRefused boolean"
}
```

Unknown account id → **Response** `404`:

```json
{ "error": "Not found" }
```

Success → **Response** `200` with the updated account JSON (same
`serializeDebugAccount` shape as `GET /debug/accounts`, including
`isPlatform`, `sessionRefused`, `viewKey`, `walletRequired`,
`walletBackupSeenAt`, and Nostr debug fields). Role changes log `debug.accounts.role_set`
with the account id and new role. Unlink logs
`debug.accounts.lightning_address.cleared` with the account id (never the
token or the previous address). Platform changes log
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
location, and Lightning Address are not copied from the source, and
neither is the verified flag on that address. Gifts are stored against
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
laws. The role stays the survivor's and is never lowered. A basis
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
Sessions of the source are deleted. Messages, invoice rows, edit
history, contacts, push subscriptions, and the other foreign keys to
`account(id)` are moved. Those foreign keys are read from the catalog
inside the transaction, so a later table is moved too. A conversation
that exists only between these two accounts is deleted. Two
conversations with the same other person are folded into one, and the
messages are kept. Where a second row would break a unique key, the
survivor's row stays and the source's row is dropped: the same image
slot, the same notification, the same repayment day, a second address
check, and a second open till charge. Two funding grants are refused
before any of those writes.

An invalid body is **400**
`{ "error": "Expected a JSON body with \"from\" and \"into\"" }`
before the database is required. The same id is **409**
`{ "error": "Cannot merge an account into itself" }`. A missing
account is **404** `{ "error": "Not found" }`. The platform account
is **409** `{ "error": "Cannot merge the platform account" }`. Two
funding grants are **409**
`{ "error": "Both accounts have a funding grant" }`. A database that
cannot run the merge, and any thrown write, is **503**
`{ "error": "Merge is unavailable" }`. The same 503/401 debug-token
gate as the other debug account routes applies. Success logs
`debug.accounts.merged` with the two ids and the message count.
Failure logs `debug.accounts.merge_failed` with the two ids and the
SQLSTATE when the driver reported one. The text of a message, a
token, an nsec, and a view key are not logged.

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
`passkey_challenge`, `auth_session`, `address_verification`, `api_log`,
`contact`, `pos_charge`, `conversation`, `conversation_message`, `conversation_read`,
`message`, `message_extra_photo`, `message_invoice`, `nostr_zap_ingest`,
`nostr_zap_receipt`, `nostr_zap_payment`, `nostr_zapper`,
`nostr_blocked_pubkey`, `notification`, `push_subscription`, `push_outbox`,
`trust_edge`, `gift`, `btc_usd_daily`, `usd_fiat_daily`, `db_change`. Media
bytes stay off JSON. `nostrNsecCiphertext` is envelope hex. `btc_usd_daily`,
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
`address_verification`, `api_log`, `contact`, `pos_charge`, `conversation`,
`conversation_message`, `conversation_read`, `message`, `message_extra_photo`,
`message_invoice`, `nostr_zap_ingest`, `nostr_zap_receipt`, `nostr_zap_payment`,
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
`/view/:viewKey`). Write failure on the request path logs
`api_log.write.failed` and does not replace the response.

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
      "lightningAddress": "user@walletofsatoshi.com",
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
`sign_failed`, `rate_limited`, `bad_body`, `not_found`. `isNip57Invoice` is
true only when `descriptionHash` equals SHA-256 of the zap-request JSON string
sent as LNURL `nostr=`. Failure rows have `pr` null and `isNip57Invoice`
false, except `not_zap` which stores the rejected BOLT11 (`pr` set,
`isNip57Invoice` false). When `DATABASE_URL` is unset the in-memory store
starts empty.

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
`placeLat`, `placeLng`, `placeLabel`, and `shopAccountId` (JSON `null` when
unset). Never
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
may be null), and always-present `placeLat`, `placeLng`, `placeLabel`, and
`shopAccountId` (JSON `null` when unset). Never
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
(`endpoint` unique; rebinds if another account held it).

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

### `GET /gifts`

Public list of outbound gifts for one UTC calendar day. Query `day=YYYY-MM-DD`.
No auth. The body never includes invoices, fees, or wallet identifiers.

Missing, blank, or impossible `day` (`2026-02-31`) → **400**
`{ "error": "Expected a UTC day (YYYY-MM-DD)" }`.

When `DATABASE_URL` is unset the in-memory gift store is empty — **200** with
zeros (`totalUsd` / `totalChf` / `totalEur` / `totalPhp` `"0.00"`), `gifts: []`,
and `fx` with USD-only `quotes` (no Coinbase / Frankfurter). When gifts exist
for that day, the stored payment-time USD/CHF/EUR/PHP is what is returned.
A SQL NULL snapshot is JSON `null` and does not fetch a close. The api ensures
a BTC-USD close for that UTC day only for an in-memory gift that omits the
field (`undefined`). An empty matching set is
200 without Coinbase or Frankfurter. A query failure is **503**. A still-missing
BTC-USD rate is **503** only for that omitted-field row. A missing stored amount
or CHF/EUR/PHP cross is JSON `null` on the matching total and per-gift amount, never 503.

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

**Response** `200` (one gift; 1000 sats at BTC-USD 100000 and CHF 0.80 / EUR 0.90 / PHP 50):

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
    "quotes": [
      { "code": "USD", "pair": "BTC-USD", "source": "coinbase-exchange-daily-close" },
      { "code": "CHF", "pair": "USD-CHF", "source": "frankfurter-ecb" },
      { "code": "EUR", "pair": "USD-EUR", "source": "frankfurter-ecb" },
      { "code": "PHP", "pair": "USD-PHP", "source": "frankfurter-ecb" }
    ]
  }
}
```

| Field       | Type                                                                                         | Meaning                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `day`       | string                                                                                       | UTC `YYYY-MM-DD` of the query                                                                             |
| `giftCount` | number                                                                                       | Number of gifts that UTC day                                                                              |
| `totalSats` | number                                                                                       | Sum of gift amounts (sats; fees excluded)                                                                 |
| `totalBtc`  | string                                                                                       | `totalSats` as BTC with eight decimals                                                                    |
| `totalUsd`  | string or null                                                                               | Sum of stored payment-time USD (`"1.00"`); `"0.00"` when empty; `null` if any gift lacks stored USD       |
| `totalChf`  | string or null                                                                               | Sum of stored payment-time CHF; `"0.00"` when empty; `null` if any gift lacks stored CHF                  |
| `totalEur`  | string or null                                                                               | Sum of stored payment-time EUR; `"0.00"` when empty; `null` if any gift lacks stored EUR                  |
| `totalPhp`  | string or null                                                                               | Sum of stored payment-time PHP; `"0.00"` when empty; `null` if any gift lacks stored PHP                  |
| `gifts`     | `{ paidAt, amountSats, amountBtc, amountUsd, amountChf, amountEur, amountPhp, recipient }[]` | Ordered by `paidAt` ascending, then `recipient`                                                           |
| `fx`        | `{ quote, dayBasis, source, quotes }`                                                        | Always present; `quote` is BTC-USD; `quotes` lists USD always and CHF/EUR/PHP when that day has the cross |

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

**Response** `503`: `{ "error": "Gift stats are unavailable" }` (store failure or missing BTC-USD only; missing fiat is never 503).

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
is JSON `null` and does not fetch a close. It ensures a BTC-USD
daily close only for an in-memory gift that omits the field (`undefined`)
(from `btc_usd_daily`, fetching Coinbase only for missing days /
stale UTC-today / after-midnight finalize of an intraday print). A gift that
lacks a stored amount returns that currency as
JSON `null`; a running total goes `null` if any selected gift lacks that
currency. Gap days in `spendOverTime` are zero `giftCount`/sats/BTC/USD and `"0.00"` fiat
and need no rate. Gap months in `byMonth` are zero sats/BTC/USD and
`"0.00"` fiat and need no rate.
A query failure is **503**. A still-missing BTC-USD rate is **503** only for
an omitted-field row. A missing stored amount is never 503.

Optional query `recipient` filters to one Wallet of Satoshi handle
(case-insensitive). The value is trimmed first. When the trimmed value
contains `@` after the first character, the local-part before `@` is used;
otherwise the whole trimmed string is the handle. Missing or blank
(after trim) `recipient` is unfiltered.
An unknown handle is empty **200** (zeros, USD-only `fx.quotes`) without a
Coinbase or Frankfurter call. Rates are ensured only for the selected
gifts' UTC days.

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

| Field            | Type                                                                                                                                             | Meaning                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `totalSats`      | number                                                                                                                                           | Sum of gift amounts (sats; fees excluded)                                                                                    |
| `totalBtc`       | string                                                                                                                                           | `totalSats` as BTC with eight decimals                                                                                       |
| `totalUsd`       | string or null                                                                                                                                   | Sum of stored payment-time USD (`"1234.56"`); `"0.00"` when empty; `null` if any gift lacks stored USD                       |
| `totalChf`       | string or null                                                                                                                                   | Sum of stored payment-time CHF; `"0.00"` when empty; `null` if any gift lacks stored CHF                                     |
| `totalEur`       | string or null                                                                                                                                   | Sum of stored payment-time EUR; `"0.00"` when empty; `null` if any gift lacks stored EUR                                     |
| `totalPhp`       | string or null                                                                                                                                   | Sum of stored payment-time PHP; `"0.00"` when empty; `null` if any gift lacks stored PHP                                     |
| `giftCount`      | number                                                                                                                                           | Number of outbound gifts                                                                                                     |
| `recipientCount` | number                                                                                                                                           | Distinct recipient handles                                                                                                   |
| `firstPaidAt`    | string or null                                                                                                                                   | ISO-8601 of the earliest gift                                                                                                |
| `lastPaidAt`     | string or null                                                                                                                                   | ISO-8601 of the latest gift                                                                                                  |
| `spendOverTime`  | `{ day, giftCount, sats, cumulativeSats, btc, cumulativeBtc, usd, cumulativeUsd, chf, cumulativeChf, eur, cumulativeEur, php, cumulativePhp }[]` | UTC days from first through last; `giftCount` is outbound gifts that day; gaps are zero count/sats/BTC/USD and `"0.00"` fiat |
| `byRecipient`    | `{ recipient, giftCount, sats, btc, usd, chf, eur, php }[]`                                                                                      | Sorted by sats descending, then name; fiat `null` if any gift to that recipient lacks the cross                              |
| `byMonth`        | `{ month, giftCount, sats, btc, usd, chf, eur, php }[]`                                                                                          | UTC YYYY-MM from first through last; gaps are zero sats/BTC/USD and `"0.00"` fiat                                            |
| `fx`             | `{ quote, dayBasis, source, quotes }`                                                                                                            | Always present; `quote` is BTC-USD; `quotes` lists USD always and CHF/EUR/PHP when any selected gift day has that cross      |

**Response** `503`:

```json
{ "error": "Gift stats are unavailable" }
```

503 is store failure or missing BTC-USD only. Missing CHF/EUR/PHP is JSON
`null`, never 503.

### `GET /invoices/passkey`

Spend-worker eligibility check. Query `address=name@domain.tld`. Same
`SPEND_API_TOKEN` Bearer as `POST /invoices` (503 unconfigured / 401
unauthorized).

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

Success is always **200** (never 404 for an unknown address):

```json
{ "eligible": true, "status": "admitted" }
```

`status` is `effectiveStatus`: `none`, `pending`, `trial`, `admitted`, or
`rejected`. Unknown address and `basis` are always
`{ "eligible": false, "status": "none" }` with no grant lookup. Until UTC
2026-10-01 a missing/pending/rejected grant on a non-`basis` account is
`eligible: true` with `status` still from `effectiveStatus`; from that day
`eligible` is false unless admitted or trial-today.

### `GET /invoices/posted`

Spend-worker eligibility check. Query `address=name@domain.tld`. Same
`SPEND_API_TOKEN` Bearer as `POST /invoices` (503 unconfigured / 401
unauthorized).

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
A profile note that has a photo or video keeps `hasPosted: false` and sets `welcomeHasMedia: true` with that note as `welcomeMessageId`. Replies do not count. Photo-only / empty-text
top-level notes still count for `hasPosted`. `hasMedia` is true only when such a
post has photo 0, extra stills, or video. `welcomeHasMedia` is true when any live top-level photo or video exists, including the About-me note, even when `hasPosted` is false. `welcomeMessageId` is that newest note's id, or null. When `hasPosted` is true, `messageId` is usually
the newest live top-level non-profile post id; it can still be `null` if
`listPostsByAccount` yields no non-profile row. `postedAt` is that row's
`createdAt` (ISO-8601) or `null` when `messageId` is null. Replies and the auto profile
note never become `messageId`. A text-only newest row can still pair with
`hasMedia: true` when an older live top-level media post exists.

### `POST /invoices`

Spend-worker invoice fetch. After address and amount validation, the api
requires a 21.gifts account for `address` that already has a passkey
credential and `eligibleToday` (grant required from UTC 2026-10-01).
When `messageId` is omitted, it also requires at least one live **top-level**
forum message that is not the auto-created profile note. When `messageId` is
set, that note must be this address's live top-level note, including About me,
and have a photo or video. Replies do not unlock an invoice. It then resolves
LUD-16, GETs the LNURL-pay callback, decodes the BOLT11, and stores
`{ id, pr, paymentHash }` in memory. It does not pay.

**Body:**

```json
{
  "address": "name@domain.tld",
  "amountMsat": 100000,
  "amountUsd": "5.00",
  "comment": "optional",
  "messageId": "<uuid>"
}
```

Moderator stipend form (never together with `messageId`):

```json
{
  "address": "name@domain.tld",
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
unset and proof may use the spot. `comment` is optional and at most 255 characters. `amountMsat` must be an
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
(no LNURL). Stores `messageId` and `comment` (or `''`) on the invoice.
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

The account has a passkey but is not funding-eligible today (`eligibleToday`)
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
invoice has `groupMessageId` else `21gifts daily`,
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
live top-level post, media, funding eligibility, the same-UTC-day welcome
flag, and the daily roster, then returns whether to pay and the amount,
comment, and optional `messageId`. Spend does not choose those fields.

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
and no hashtag, this is the public window: the first 200 active rows;
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
**200**), opaque `cursor`, and optional `hashtag` (name without `#`;
token match on live top-level `text`; combines with mode/limit/cursor).
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
optional `place` (`{ lat, lng, label }` when a pin is stored;
the key is omitted when unset),
`payable` (true when the note has a non-empty signed `eventId` and the author
has a non-blank Lightning Address; null or empty `eventId` is not payable),
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
and `payable` is false. Rows with neither an account nor an author pubkey stay
invisible. List JSON never includes photo
or video bytes. Live list, single-note GET, and replies include
`accountId` whenever the stored author id is non-null, with or without a
session, and omit it for an external row. `mentions`
(`{ username, accountId }[]`) stay tied to that same inclusion (only when
`accountId` is included and the stored list is non-empty). Nostr event ids are never included in the JSON.

A present Authorization header that is not a live session, a signed-out
request that is not `mode=active` without a hashtag, or a public cursor
outside the window → **Response** `401`. A missing header on that public
window is not 401. Missing/invalid/expired bearer on the signed-in list
→ **Response** `401`:

```json
{ "error": "Unauthorized" }
```

Unknown `mode`, `limit` outside 1–200, a bad/mismatched `cursor`, or an invalid `hashtag` → **Response** `400`:

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
      "hasPhoto": false,
      "photoCount": 0,
      "photoTakenAts": [],
      "hasVideo": false,
      "videoContentType": null,
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

The hot lane uses the same receipt-read URL set as full ingest (space plus the
public list, including when `NOSTR_PUBLISH_PUBLIC` is unset, then
`wss://nostr.wine` and `wss://nostr.bitcoiner.social` unless that exact URL is
already present), but only for recent in-app invoice e-tags, and it makes no
relay query when no target remains. Those two URLs are not written into the
kind:9734 `relays` tag and are not used for inbound kind:1 replies or direct
messages.

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
`{ "places": [{ "id", "name", "createdAt", "lat", "lng", "label", "shop", "accountId?" }] }`.
`shop` is true when the note text contains the shop tag. `accountId` is set for a 21gifts author and omitted for an external pin.
`createdAt` is ISO-8601. Newest first (`created_at` desc, `id` desc). Only
live top-level rows with both coordinates. Replies and hidden notes are
excluded.

### `GET /messages/compose-target`

Bearer session required. After auth, `requireAction(account, 'forum.post')`
(rules + name + username + Lightning Address). Returns the official platform
profile note so a basis account can invoice 1 sat to 21.gifts before posting
or replying:

```json
{ "messageId": "<uuid>", "sats": 0 }
```

Ensures that profile note exists. The client then calls
`POST /messages/:id/invoice` on `messageId`. A later indexed member/invoice zap
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

Platform note not yet payable (unsigned or missing Lightning Address) →
**Response** `400`:

```json
{ "error": "This message cannot be paid yet" }
```

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
on a top-level note only). Optional `shopUsername` (JSON string or multipart field) on a shop note stores that account on the same insert as the note and does not write `message_edit`. Omitted, null, blank, or `@` alone stores nothing. A non-string is 400 `Username is not valid`. A reply, or a note that is not a shop, with a non-blank username is 400 `Only a shop note can set a shop account` before the handle is normalised or looked up. After that, a handle `normalizeUsername` rejects is 400 `Username is not valid`. An unknown username, or a stored username that is null or blank, is 404 `No account with that username`. A media replay of an existing live note does not change its shop account. Optional `takenAt` is `YYYY-MM-DDTHH:MM:SS` with an optional `±HH:MM`
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
(including the parent author) posting unpaid **text-only** → **403**
`{ "error": "A post needs a Bitcoin payment" }` or `{ "error": "A reply needs a Bitcoin payment" }`
for `inReplyTo`. A photo or video body from `basis` is **200**. Pay 1 sat to
21.gifts first (`GET /messages/compose-target`
then `POST /messages/:id/invoice` on that platform profile note). Optional
`goalSats` omitted, JSON `null`, or a missing/empty multipart field means
no goal. Multipart accepts `goalSats` as a decimal digit string. A positive
`goalSats` together with `inReplyTo` → **400** `{ "error": "A reply cannot ask for a goal" }`.
Optional `place` is `{ lat, lng, label? }`. Omitted or null stores no pin
and the 200 JSON omits `place`. Invalid place is 400 with `Place must be a
latitude and longitude` or `Place label must be at most 80 characters`.
`inReplyTo` together with a non-null place is 400
`{ "error": "A reply cannot include a place" }`. Multipart fields are
`placeLat`, `placeLng`, and optional `placeLabel` (always top-level). Both
coordinates empty means no pin. Exactly one of them set is 400
`Place must be a latitude and longitude`.
An invalid multipart `goalSats` → **400** `{ "error": "Goal must be a positive whole-sat amount" }`.
A post sends either legacy `goalSats` alone, or both `goalCurrency` (`BTC`, `USD`, `CHF`, `EUR`, or `PHP`) and `goalAmount` (trimmed decimal string, comma or dot, at most eight fractional digits). Both styles together, only one of the new pair, a non-string `goalAmount`, or a string that fails that grammar → **400** `{ "error": "Send either goalSats or both goalCurrency and goalAmount" }`. A reply that sends `goalSats`, `goalCurrency`, `goalAmount`, `goalRepayable`, or `goalTermDays` → **400** `{ "error": "A reply cannot ask for a goal" }`. Optional `goalRepayable` (JSON boolean or multipart string) marks a top-level ask as repayable. Absent, JSON `null`, or a missing/empty multipart field stores SQL NULL and the 200 JSON omits the key. JSON `true` or multipart `"true"` stores `true` only when this create also stores an ask (`goalSats`, or both `goalCurrency` and `goalAmount`) and a term; the 200 JSON then includes `goalRepayable: true`. JSON `false`, any other type, or any other string → **400** `{ "error": "Ask obligation must be true" }`. `true` without an ask → **400** `{ "error": "A repayment obligation needs an ask" }`. Stored values are SQL NULL or TRUE, never `false`. Optional `goalTermDays` (JSON number or multipart digits) is the agreed repayment term in whole days. Absent, JSON `null`, or a missing/empty multipart field stores SQL NULL and the 200 JSON omits the key. A whole number from 1 to 3650 stores that integer only when this create also stores `goalRepayable: true` and an ask; the 200 JSON then includes `goalTermDays` as that integer. Anything else, including 0, 3651, a fraction, or a string that is not an integer → **400** `{ "error": "Ask term must be a whole number of days from 1 to 3650" }`. A term without `goalRepayable: true` → **400** `{ "error": "A repayment term needs a repayable ask" }`. `goalRepayable: true` without a term → **400** `{ "error": "A repayable ask needs a term in days" }`. Interest is not stored. When collected sats first reach `goal_sats`, `goal_funded_at` is set. Repayment is due each UTC day starting the day after that, for `goal_term_days` days. Each giver is repaid exactly what they paid: their sats on a bitcoin ask, or the cents of the goal currency recorded on their payments on a fiat ask. A fraction below one sat or one cent carries to a later day until it is one whole unit, so a gift of 1 sat or 1 cent comes back in full. The shares of one day add up to that day's split of the total, with the remainder on the last day. The author pays the next unpaid share at that giver's Lightning address. A fiat share is priced in bitcoin at the rate of the day it is paid. A paid zap whose invoice description is `repay:<day>:<accountId>` is stored in `message_repayment` and does not increase the ask. `GET /messages/:id/repayment` is public on a live repayable ask and lists every giver and every Lightning repayment (who, how much, which UTC day, and whether it is paid, due, or still scheduled). Dates are omitted until the credit is fully given. Sats with no 21.gifts payer are reported separately and are not repaid. The flag and term are not written into Nostr event content or the note text. The canonical stored `goalAmount` uses a dot, no exponent, no leading zeros, and no trailing fractional zeros (`10.` and `10.0` are `10`). `goal_sats` is that integer for `BTC` (1..10_000_000; a missing gift-day does not reject it) or `Math.round(amount * day.sats / dayFiat)` for fiat, with a rounded 0 raised to 1. Fiat needs a usable latest gift-day (`GET /gifts/stats` `spendOverTime`, last day with `sats > 0`) and a result in 1..10_000_000; otherwise **400** `{ "error": "Ask amount is unavailable" }`. If that loader throws for a fiat ask → **503** `{ "error": "Messages are unavailable" }`. A BTC ask still stores the typed sats when the loader throws. Frozen columns `goal_currency`, `goal_amount`, and `goal_fiat_usd` / `goal_fiat_chf` / `goal_fiat_eur` / `goal_fiat_php` are null when there is no currency ask. Legacy rows keep `goal_sats` and leave the new columns null (no backfill). Public, debug, and hidden JSON include `goalRepayable: true` only when the column is true and omit the key when null (never emit `false`). Public and debug JSON omit the currency-ask keys when `goal_currency` is null. When it is set they include `goalCurrency`, `goalAmount` (the typed canonical string, not the two-decimal snapshot), `goalSats`, and `goalAmountUsd` / `goalAmountChf` / `goalAmountEur` / `goalAmountPhp` (two-decimal string or null). Payment progress fiat stays the sum of per-payment gift-day snapshots. A null component on a later payment does not wipe a stored total; a null stored column is assigned the next non-null snapshot and is not rebuilt. One-time and Daily are still not stored. Settlement is not moved onto Coinbase spot.
JSON type/range errors keep **400** `{ "error": "Expected a JSON body with text and/or photo" }`.
Above 10_000_000 is rejected, not clamped. Multipart video posts do not
accept `inReplyTo` (they are always top-level).

After auth, `requireAction(account, 'forum.post')` requires rules agreement,
a non-blank display name, a non-blank username, and a non-blank Lightning
Address (skip timestamps do not satisfy; username cannot be skipped). The api stores a **name snapshot** (trimmed account name at
post time), normalised text (possibly `""` for photo-only), optional
JPEG/PNG/WebP bytes (≤ 1 MiB; MIME from magic bytes), `parentId` (null for
top-level notes), and a timestamp. Text longer than **8000** after trim, or
with disallowed C0/DEL controls, is rejected. Newlines (`\n`, `\r`) are
allowed. The **200** body is the public message object itself (not wrapped
in `{ messages }`), including `sats`, `payable`, `hasPhoto`, `photoCount`
(0–10; always present; `hasPhoto` still means photo 0 exists), `photoTakenAts`
(always; length equals `photoCount`; null when unknown; `[]` when there are no
stills) and `photoTakenAt` only when `photoCount` is 1, `hasVideo`, and
`videoContentType`. May include `goalSats` (positive integer on a top-level
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
author LN). `role` is the posting session account's live `account.role`. Web Push and in-app rows for a **top-level** note (`notifyForumPost`, kind
`forum_post`, `url` `/messages/<id>`, `tag` `forum_post:<id>`) and for a
**reply** (`notifyForumReply`, kind `forum_reply`, `url` `/messages/<replyId>`,
`tag` `forum_reply:<replyId>`) fan out in-app to every account except the
actor and except each account marked on the created row (no-op when the actor is the official platform account), then filter recipients by each account's `notificationLevel`
(`all` / `active` / `mentions`). The excluded ids are the created row's mention account ids other than the author, deduped; an empty list omits `excludeAccountIds`. Web Push still goes only to bell subscribers
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
POST. The api POSTs `{ address, messageId }` to `{SPEND_URL}/ping` with
Bearer `SPEND_API_TOKEN` (fire-and-await; `messageId` is the UUID of the new
top-level row) only when `eligibleToday` for the author's funding grant
**and** the new row has media (`hasPhoto` / `hasVideo` / `photoCount > 0`).
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
verification happened in either order. Spend pays once per Lightning Address;
this API may ping again. Replies, and any role other than `verified`, do not
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
then `lightning-address`. A named, rules-agreed, username-set account with
null LN yields `["lightning-address"]` only.)

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

Anyone below `verified` posting an unpaid text-only top-level note →
**Response** `403`:

```json
{ "error": "A post needs a Bitcoin payment" }
```

Anyone below `verified` posting an unpaid text-only reply (`inReplyTo`) →
**Response** `403`:

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
  "hasPhoto": false,
  "photoCount": 0,
  "photoTakenAts": [],
  "hasVideo": false,
  "videoContentType": null,
  "role": "verified"
}
```

### `POST /messages/:id/invoice`

Signed-in pay-on-note. Bearer session required. `:id` is a UUID (`MESSAGE_ID_RE`).
Body `{ "sats": <int 1..10_000_000>, "text"?: "<string>", "amountUsd"?: "<string>|null", "amountChf"?: "<string>|null", "amountEur"?: "<string>|null", "amountPhp"?: "<string>|null" }`. Optional `text` is the
NIP-57 zap-request `content` (same 1–8000 forum rules; omit or whitespace = gift-only).
Omitting every amount key leaves the invoice unpinned. Any present amount key pins all four; a missing sibling is null. `"0"`, `"0.0"`, and `"0.00"` are stored as `"0.00"`. An unusable amount string is **400** `{ "error": "Expected a JSON body with a positive \"sats\" integer" }`.
Invalid `text` → **400** `{ "error": "Text must be 1–8000 characters" }`.
The api signs a NIP-57 zap request with the
**payer** key and returns a BOLT11 invoice for the **author** Lightning Address
**only** when the minted invoice's `description_hash` equals SHA-256 of the
zap-request JSON (`isNip57Invoice`). A validated kind:9735 receipt credits the
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
`{ "error": "The author's wallet cannot receive this Bitcoin payment" }` with
**no** `pr` in the body. LNURL `noZap` (author wallet does not advertise zap
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
{ "pr": "lnbc…", "amountSats": 21 }
```

Missing Bearer → **401** `{ "error": "Unauthorized" }`.
Payer missing living-room rules → **409** `{ "error": "missing_requirements", "missing": ["rules"] }`.
Malformed body or `sats` above 10 million → **400** `{ "error": "Expected a JSON body with a positive \"sats\" integer" }`.
Unknown id → **404** `{ "error": "Not found" }`. Unsigned note (null or empty
`eventId`), author without a non-blank Lightning Address (including
whitespace-only), or missing recipient pubkey →
**400** `{ "error": "This message cannot be paid yet" }`. Missing KEK →
**503** `{ "error": "Messages are unavailable" }` (before the limiter).
Over-limit → **429** `{ "error": "Too many payments" }` (`Retry-After: 10`) —
checked only after auth, amount, payable, and KEK checks succeed, so early
400/404/401/503 do not consume quota. LNURL/zap or sign failure after the
limiter still counts. Author-wallet zap failure (`noZap` or `not_zap`) →
**400** `{ "error": "The author's wallet cannot receive this Bitcoin payment" }`.
Other LNURL/zap failure (`unreachable`) →
**400** `{ "error": "Could not start the Bitcoin payment" }`. Keygen/sign failure →
**503** `{ "error": "Messages are unavailable" }`.

### `GET /messages/:id/repayment`

Public credit ledger. No session. `:id` must be a UUID (`MESSAGE_ID_RE`); anything else is **404** `{ "error": "Not found" }`. **404** unless the note is live, top-level, `goalRepayable` true, and has a term. A local Sunday does not refuse this read.

Success → **Response** `200`:

```json
{
  "currency": "BTC",
  "fundedAt": null,
  "termDays": 30,
  "daysDue": 0,
  "daysPaid": 0,
  "unassignedSats": 0,
  "givers": [
    {
      "accountId": "<uuid>",
      "name": "Ada",
      "username": "ada",
      "givenSats": 21,
      "givenAmount": null
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
      "via": "lightning"
    }
  ],
  "next": null
}
```

`currency` is `BTC`, `USD`, `CHF`, `EUR`, or `PHP`. `fundedAt` is ISO-8601 or null until collected sats first reach the ask. `dueOn` is `YYYY-MM-DD` UTC, or null until then. `givenAmount` and `amount` are two-decimal strings in the ask currency, or null for bitcoin. For a fiat ask, `sats` on a repayment is the paid share or null until it is paid. `status` is `paid`, `due`, or `scheduled`. `unassignedSats` is bitcoin with no 21.gifts payer and is not in the plan. `next` is the next unpaid share once the credit has filled, else null. A 1-sat or 1-cent gift is its own row.

Fiat amount or gift-day rate missing → **503** `{ "error": "Ask amount is unavailable" }`.

### `POST /messages/:id/repayment`

Author pays the next giver share from their own wallet. Bearer session required. No body. A missing or invalid Bearer is **401** `{ "error": "Unauthorized" }`, including when `:id` is not a UUID. After a valid session, a non-UUID `:id` is **404** `{ "error": "Not found" }`. The author pays the returned BOLT11. The description is `repay:<day>:<accountId>`. When that zap is indexed, the share is stored on `message_repayment` and `message.sats` does not rise. A repeat for the same unpaid share returns the outstanding invoice instead of minting another, including when the sat price of that fiat share has moved.

Success → **Response** `200`:

```json
{ "pr": "lnbc…", "amountSats": 21 }
```

Missing or invalid Bearer → **401** `{ "error": "Unauthorized" }`, including when `:id` is not a UUID.
Unknown id, a non-UUID after a valid session, a note that is not a live repayable ask, a credit that is not funded yet, or a caller who is not the author → **404** `{ "error": "Not found" }`. GET of that same unfunded credit stays **200**.
Nothing left to pay → **400** `{ "error": "Nothing is due" }`.
Note not payable yet → **400** `{ "error": "This message cannot be paid yet" }`.
Giver without a Lightning address → **400** `{ "error": "A giver has no Lightning address" }`.
Recipient wallet cannot take the payment → **400** `{ "error": "The recipient's wallet cannot receive this Bitcoin payment" }`.
Other payment start failure → **400** `{ "error": "Could not start the Bitcoin payment" }`.
Author missing forum pay → **409** `{ "error": "missing_requirements", "missing": ["rules"] }`.
Device `Time-Zone` in Sunday → **403** `{ "error": "SUNDAY_REST" }`. A missing, blank, or invalid zone does not refuse.
Over-limit → **429** `{ "error": "Too many payments" }`.
Fiat share cannot be priced → **503** `{ "error": "Ask amount is unavailable" }`.
Signing keys missing or the invoice attempt cannot be stored → **503** `{ "error": "Messages are unavailable" }`.

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
`payable` when a member row has a non-empty `eventId` and a non-blank
Lightning Address, and no `replyCount`. Items include `accountId` whenever
the stored author id is non-null, with or without a session. External replies
set `via: "nostr"`, keep `payable: false`, and omit `accountId`, `role`, and the
pubkey. Replies never include `goalSats`, `goalRepayable`, or `goalTermDays`.
Photo and video bytes are never included. `:id` is a UUID
(`MESSAGE_ID_RE`).

Unsigned/non-staff: hidden children are omitted. A founder/moderator Bearer
is **200** `{ "messages" }` from `listReplies(id, limit, true)` including
hidden attributed children with hide stamps and `payable: false`, whether
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
`GET /messages/:id`. **200** `{ "name", "npub", "postCount", "replyCount" }`
and, when present, `nip05` and `lud16`. `name` is the stored snapshot
(truncated pubkey when blank). A live kind 0 name replaces it only when
`externalDisplayName` accepts it. `npub` is the NIP-19 bech32 encoding of
the stored 64-hex author pubkey. `postCount` and `replyCount` are always
present, including 0: uncapped live top-level notes, and uncapped live
public replies (`replyCount` is 0 when the pubkey is not a recorded
zapper). `nip05` requires `fetchImpl` and
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
`replyCount` of live attributed children, `payable` false, `via: "nostr"`,
and omits `role`. **503** `{ "error": "Messages are unavailable" }`
(`messages.external_posts.failed`). A serialize failure skips that row
and still returns 200.

### `GET /messages/:id/external-replies`

Public list of live public replies for an external author. No Bearer.
Registered **before** `GET /messages/:id`. Same 404 gate as
`GET /messages/:id/external-profile`. **200** `{ "messages" }` capped at
200, newest first (`createdAt` desc, `id` desc). Each item includes
`parentId`, omits `replyCount`, `payable` false, `via: "nostr"`, and omits
`role`. A non-zapper author's list is empty. **503**
`{ "error": "Messages are unavailable" }` (`messages.external_replies.failed`).
A serialize failure skips that row and still returns 200.

### `GET /messages/:id`

Public single-note fetch. Live rows need **no Bearer.** `:id` is a UUID.
Registered **after** photo, video, `GET /messages/:id/replies`,
`GET /messages/:id/external-profile`,
`GET /messages/:id/external-posts`, `GET /messages/:id/external-replies`,
`DELETE /messages/:id`, `PATCH /messages/:id/place`, `PATCH /messages/:id/shop-account`, `PATCH /messages/:id/text`, `PATCH /messages/:id/photos`, `GET /messages/:id/edits`, `GET /messages/stats`, `GET /messages/hidden`, and
`GET /messages/places` so
those paths are not captured as `:id`. A live GET returns
the public message JSON (`sats`, optional `goalSats` on a top-level note
when the stored ask is a positive integer, optional `goalRepayable: true`
when the stored column is true (omitted when null; never false), optional
`goalTermDays` when the stored column is not null (omitted when null), and when
`goalCurrency` is stored also `goalCurrency`, `goalAmount`, and the four
`goalAmount*` snapshots — a snapshot may be null, a legacy row omits those
keys — optional `place` when a pin is stored and omitted when unset,
optional `shopAccount` (`{ id, username, name }`) when a shop account is
stored and omitted when unset, even when `accountId` is omitted,
`payable`, `hasPhoto`, `photoCount`
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
`deletedAt` ISO, `deletedBy.{id,name,role}`, `payable: false`, and
`accountId` for 21gifts authors. A live reply with `accountId` null
returns **200** only when `authorPubkey` is set and that pubkey is a recorded
zapper (checked via `isZapperPubkey` on every read, including during a
`sinceSats` poll loop); that **200** includes `via: "nostr"`, omits `role`,
and sets `payable` false. Otherwise (no `authorPubkey`, or an `authorPubkey`
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

### `PATCH /messages/:id/place`

Staff map pin on a live top-level shop note (`#21GiftsShop`). Bearer
session required. Live role must be at least `moderator`. No rules
gate. `:id` must match `MESSAGE_ID_RE` or the response is **404**.
Body is JSON via `c.req.json()`; a non-JSON body or an object with no
`place` key is **400** `{ "error": "Invalid body" }`. `normalizePlace`
accepts a pin or `null` (clears). A bad coordinate is **400**
`{ "error": "Place must be a latitude and longitude" }`. A label over
80 characters is **400** `{ "error": "Place label must be at most 80 characters" }`.
Missing or hidden row → **404** and no write. A reply → **400**
`{ "error": "A reply cannot include a place" }`. A non-shop top-level
note → **400** `{ "error": "Only a shop note can set a place" }`.
`setPlace` false → **404**. Store throw → **503**
`{ "error": "Messages are unavailable" }` and `messages.place.failed`.

Success → **200** live public message JSON (optional `place`, reply
count, no hide stamps). Logs `messages.place.updated` with
`messageId`, `accountId`, and `role` only. Text and publish state are
unchanged. A real pin change appends `message_edit`. An identical pin
does not.

### `PATCH /messages/:id/shop-account`

Staff assignment of a 21.gifts account on a live top-level shop note
(`#21GiftsShop`). The assignment is not the note author. Bearer session
required. Live role must be at least `moderator`. No rules gate. `:id`
must match `MESSAGE_ID_RE` or the response is **404**. Body is JSON via
`c.req.json()`; a non-JSON body or an object with no `username` key is
**400** `{ "error": "Invalid body" }`. `username: null` clears. A string
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

Success → **200** live public message JSON (optional `shopAccount`
`{ id, username, name }`, omitted when cleared, reply count, no hide
stamps). Logs `messages.shop_account.updated` with `messageId`,
`accountId`, and `role` only. Text, place, and publish state are
unchanged. The write stores only `shop_account_id`. A real change appends `message_edit`. An unchanged account does not. The same account id with a new name or username is unchanged.

### `PATCH /messages/:id/text`

Staff replacement of the body of a live top-level shop note (`#21GiftsShop`). Bearer session required. Live role must be at least `moderator`. Checks run in this order: `:id` must match `MESSAGE_ID_RE` or the response is **404**; a non-object body or a missing string `text` is **400** `{ "error": "Invalid body" }`; text outside 1–8000 characters is **400** before the row is read; a missing or hidden row is **404** `{ "error": "Not found" }`; a reply is **400** `{ "error": "A reply cannot be edited" }`; a non-shop note is **400** `{ "error": "Only a shop note can be edited" }`; empty text on a note with no photo and no video is **400** `{ "error": "Text must be 1–8000 characters or include a photo" }`. The shop tag is kept or restored, and if that makes the text longer than 8000 characters the response is **400** `{ "error": "Text must be 1–8000 characters" }`. An unchanged body is **200** without `message_edit`. A real change writes the body and `message_edit` together and is **200** public message JSON. Store throw → **503** `{ "error": "Messages are unavailable" }` and leaves the previous body with no new history row.

### `PATCH /messages/:id/photos`

Staff replacement of the stills on a live top-level shop note. Bearer session required. Live role must be at least `moderator`. Checks run in this order: `:id` must match `MESSAGE_ID_RE` or the response is **404**; the body must be `{ "photos": [{ "contentType", "data", "takenAt?" }] }` with at most 10 items, and a bad photo is **400** `{ "error": "Photo must be a JPEG, PNG, or WebP under 1 MiB" }`, before the row is read (a missing or hidden row with a bad photo is still that **400**); a missing or hidden row is then **404** `{ "error": "Not found" }`; a reply is **400** `{ "error": "A reply cannot be edited" }`; a non-shop note is **400** `{ "error": "Only a shop note can be edited" }`. An empty list clears stills. A video on the note stays. The stills are replaced in one write. This write does not append `message_edit`. Success is **200** public message JSON. Store throw → **503**.

### `GET /messages/:id/edits`

Staff history for a top-level shop note, newest first, including a hidden shop note. Bearer session required. Live role must be at least `moderator`. GET is not a Sunday write. Success is **200** `{ "edits": [{ "id", "createdAt", "field", "before", "after", "actor" }] }`. `createdAt` is ISO. `field` is `"text"`, `"place"`, or `"shopAccount"` (SQL `shop_account` is published as `shopAccount`). `before` and `after` are the previous and next value: a text string, a place pin or null, or a shop account `{ "id", "username", "name" }` or null. `actor` is `{ "id", "name", "role" }`. A missing account keeps `{ "id", "name": null, "role": null }`. Empty history `{ "edits": [] }` is only for an existing top-level shop note, including a hidden one. A non-UUID `:id`, a missing row, a reply, or a non-shop note is **404** `{ "error": "Not found" }`. Public message JSON does not include `edits`.

### `GET /messages/hidden`

Staff hidden-note log. Inverse **read** of `DELETE /messages/:id`. Bearer
**session** required (moderator). This is **not** a
`DEBUG_TOKEN` route. Registered **before** public `GET /messages/:id` so
`"hidden"` is not captured as `:id`. No `forum.read` gate — a
moderator without rules agreement is still **200**. Listed rows
include every hidden row regardless of external-zapper entitlement — the
moderation view is intentionally unaffected by the public read-visibility
rule.

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
a legacy row omits those keys), optional `place`
when a pin is stored (omitted when unset), optional `shopAccount`
(`{ id, username, name }`) when a shop account is stored (omitted when
unset), always-present `parentId` (JSON `null`
on top-level), optional `via: "nostr"` exactly when `accountId === null &&
authorPubkey !== null` (the same rule as public message JSON), and
`deletedBy: { id, name, role }` resolved from
`authStore.getAccount` (missing account keeps that id with `name` /
`role` null; null `deletedBy` is `{ id: null, name: null, role: null }`).
Includes `accountId` for a 21gifts author and omits it for an external row.
Never includes `authorPubkey`, `eventId`, `nostrPublishState`,
`payable`, author `role`, `nostrEvent`, `claimedUntil`, `contentFp`, nsec,
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
      "accountId": "<uuid>"
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
(never JSON `null`).

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
Lightning Address is a non-empty
trimmed string, `spendPing` is set, **and** the caller has a live
living-room top-level post (not the profile note) whose `createdAt` is on
the same UTC day **and** `eligibleToday` for the author's funding grant.
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
against the counterpart's Lightning Address using their profile-note event
id as the zap `e` tag. The conversation row is **not** inserted until the
zap receipt is ingested.

Success → **Response** `200`:

```json
{ "pr": "lnbc…", "amountSats": 21, "messageId": "<uuid>" }
```

`messageId` is the predetermined conversation message id. Poll
`GET /conversations/:id?sinceMessageId=` until it appears.

**400** `{ "error": "The author's wallet cannot receive this Bitcoin payment" }`
for Damus threads, missing counterpart LN / profile event, LNURL `noZap`, or a
non-NIP-57 invoice. **400** `{ "error": "Could not start the Bitcoin payment" }`
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

The `pr` is returned only when it decodes to exactly `amountSats * 1000`
millisatoshis, the same rule as `POST /pay/:username/invoice`.

Donating to the caller's own comment is **400**
`{ "error": "Cannot donate to yourself" }`. No Lightning Address on the
author is **409** `{ "error": "The author's wallet cannot receive this Bitcoin payment" }`. The existing invoice
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
is implemented as `GET /messages/hidden` (moderator **session**,
not `DEBUG_TOKEN`; registered before `GET /messages/:id`). Operator debug
restore exists as `POST /debug/messages/:id/restore` (`DEBUG_TOKEN`).
Staff / moderator session unhide is still not a route. Other Moderator
actions are not HTTP routes yet. Role values
exist on the account model; `GET /debug/accounts` and
`PATCH /debug/accounts/:id` are operator token routes, not a moderator session.

---

## Out of scope for v1

- Passkey + PRF + NIP-06 user-owned keys (non-custodial phase)
- Optional securing of the account ([docs/social-recovery.md](docs/social-recovery.md)). Not a v1 route. Mein Konto absichern is not required. An owner who continues chooses two people. It only opens the account on a new device and restores the same 12 words. No path in that document is reserved.
- Shop payment in USDT or USDC ([docs/shop-spark-payment.md](docs/shop-spark-payment.md)). Not a v1 route. The OpenCryptoPay QR stays. A later build settles that payment as bitcoin on the shop's own Spark wallet. No path in that document is reserved. Current receiving stays LUD-16.
- Email/password login (or any second login method)
- Internationalization of api response text and push payloads (they stay English). A signed-in account may store `locale` and `fiat`; that is not translated copy.
- Platform custody of **receiver** funds (receiving stays LUD-16 only)
- Arbitrary LNDHub URLs (the external spend worker uses lightning.space only)
