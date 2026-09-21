# 21.gifts — API Specification

> Canonical description of the HTTP surface implemented by this service.
> Product decisions live in [`CONCEPT.md`](./CONCEPT.md); this file owns
> request/response contracts for routes that exist in code today.

**Status**: living document. Last revised 2026-09-21 (`GET /conversations` list/open rows include per-row `unreadMessageCount`; envelope `unreadCount` remains unread thread count; `GET /trust-chain` requires a member Bearer session; public graph uses at most one incoming kind per subject: the oldest eligible sibling (`createdAt` then `id`); eligible `verify`, `moderator_appoint`, and `moderator_propose` only when the subject is a moderator; `moderator_confirm` never; later appoint/confirm/propose do not replace the first eligible contact; owner `notificationLevel` on GET `/me` and `POST /me/notification-level`; fan-out filters in-app and Web Push by `all` / `active` / `mentions`; GET `/notifications` applies the same filter to stored rows (`moderator_appointed` always stays; `unreadCount` is matching unread in the newest 1000, not `store.unreadCount()`, and may exceed the 200 page); a zap that inserts a gift-reply fans out only `notifyZap`, not a second `forum_reply`; gift-reply row still lands in the thread; confirm/appoint notify the subject only with `moderator_appointed` and Web Push url `/welcome`; official platform account (`isPlatform`) never fans out living-room `forum_post` / `forum_reply` / `zap`; house daily gift-replies still persist).

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
also expressed as BTC and historical USD using the UTC-calendar-day
BTC-USD daily close from Coinbase Exchange (persisted in `btc_usd_daily`),
plus additive CHF/EUR/PHP (USD × that UTC day's Frankfurter ECB rate,
persisted in `usd_fiat_daily`; last business day if the market is closed).
GET fetches Coinbase only for missing gift days, UTC-today when `fetched_at`
is older than one hour, and a past day whose `fetched_at` is still on that
same UTC calendar day (intraday print not yet the settled close). Settled
stored days are not re-fetched. A missing BTC-USD rate after ensure/fetch is
**503**. A missing CHF/EUR/PHP cross is JSON `null`, never 503.

Lightning Address verification HTTP routes are implemented. A live
verification payment requires an injected invoice payer; the default
`UnconfiguredInvoicePayer` makes start verification return **503**. Public
`GET /lightning-address` resolves LUD-16 metadata with an in-memory cache; it
does not fetch or pay invoices.

Spend-worker invoice routes (`GET /invoices/passkey`, `GET /invoices/posted`,
`POST /invoices`, `POST /invoices/proof`) check passkey eligibility and a live
**top-level** forum post, fetch a BOLT11 via LNURL-pay, and accept a preimage proof. Issue
requires a passkey-backed account for the address and at least one live **top-level** forum
message that is not the auto-created profile note. Replies do not count. They require `SPEND_API_TOKEN`;
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
`POST /invoices`. `GET /invoices/posted` returns `{ hasPosted, messageId, postedAt }`.

CORS allows the configured origins (`CORS_ALLOWED_ORIGINS`, or the default
surfaces `https://21.gifts`, `https://dev.21.gifts`, `https://app.21.gifts`,
`https://dev-app.21.gifts`, and `http://localhost:3000`) and methods `GET`,
`POST`, `PUT`, `DELETE`, `OPTIONS`, with headers `Authorization` and `Content-Type`.
Sessions are sent as `Authorization: Bearer` headers — no cookies,
credentials not enabled.

Public base URLs used in examples:

| Environment | API                        | App                    |
| ----------- | -------------------------- | ---------------------- |
| PRD         | `https://api.21.gifts`     | `https://21.gifts`     |
| DEV         | `https://dev-api.21.gifts` | `https://dev.21.gifts` |

| Method | Path                                         | Auth                       | Purpose                                                                                                   |
| ------ | -------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------- |
| GET    | `/healthz`                                   | none                       | Liveness                                                                                                  |
| GET    | `/info`                                      | none                       | Service identity                                                                                          |
| GET    | `/.well-known/lnurlp/:username`              | none                       | LUD-16 payRequest for username@21.gifts; settlement stays on linked Wallet of Satoshi                     |
| GET    | `/favicon.ico`                               | none                       | Brand mark (favicon)                                                                                      |
| GET    | `/favicon.svg`                               | none                       | Brand mark (SVG favicon)                                                                                  |
| GET    | `/apple-touch-icon.png`                      | none                       | Brand mark (Apple touch icon)                                                                             |
| POST   | `/auth/passkey/register/begin`               | none                       | Issue WebAuthn creation options                                                                           |
| POST   | `/auth/passkey/register/finish`              | none                       | Verify attestation, issue session                                                                         |
| POST   | `/auth/passkey/authenticate/begin`           | none                       | Issue WebAuthn request options                                                                            |
| POST   | `/auth/passkey/authenticate/finish`          | none                       | Verify assertion, issue session                                                                           |
| GET    | `/me`                                        | `Authorization: Bearer`    | Account (`setup` + factual `missing` + `hasPosted` + `aboutMe` + `aboutMeHasPhoto` + `notificationLevel`) |
| GET    | `/me/activity`                               | Bearer                     | Given + received series (forum zaps + house gifts; platform given = all outbound)                         |
| GET    | `/view/:viewKey`                             | none                       | Public profile card by view key                                                                           |
| GET    | `/view/:viewKey/about/photo`                 | none                       | Profile-note photo bytes for the view-key card                                                            |
| GET    | `/view/:viewKey/activity`                    | none                       | Public given/received payload for the account behind the view key                                         |
| POST   | `/me/setup/skip`                             | Bearer                     | Skip name or Lightning Address wizard step                                                                |
| POST   | `/me/name`                                   | Bearer                     | Set/replace display name (profile note when name + LN are both set); auto-assign username when free       |
| POST   | `/me/username`                               | Bearer                     | Set unique LUD-16 / NIP-05 local-part (cannot skip)                                                       |
| POST   | `/me/location`                               | Bearer                     | Set, change, or clear free-text profile location                                                          |
| PUT    | `/me/about`                                  | Bearer                     | Set/clear About me text and optional photo on the profile note                                            |
| GET    | `/me/about/photo`                            | Bearer                     | Owner profile-note photo bytes                                                                            |
| POST   | `/me/forum-laws-dismissed`                   | Bearer                     | Dismiss welcome-forum living-room laws                                                                    |
| POST   | `/me/notification-level`                     | Bearer                     | Set owner fan-out filter (`all` / `active` / `mentions`)                                                  |
| POST   | `/me/rules-agreement`                        | Bearer                     | Record living-room rules agreement                                                                        |
| POST   | `/me/lightning-address`                      | Bearer                     | Link/replace after live LNURL resolve + NIP-57 mint probe                                                 |
| DELETE | `/me/lightning-address`                      | Bearer                     | Unlink address (clears LN skip)                                                                           |
| POST   | `/me/lightning-address/verification`         | Bearer                     | Start address proof-of-control payment                                                                    |
| POST   | `/me/lightning-address/verification/confirm` | Bearer                     | Confirm nonce from wallet history                                                                         |
| GET    | `/members/:accountId`                        | Bearer                     | Live member identity + profile note + `aboutMeHasPhoto` + counts + `trust`                                |
| GET    | `/members/:accountId/activity`               | Bearer                     | Same given/received payload as `/me/activity` for that member                                             |
| GET    | `/members/:accountId/posts`                  | Bearer                     | Live member top-level notes (latest 200)                                                                  |
| GET    | `/members/:accountId/replies`                | Bearer                     | Live member replies (latest 200)                                                                          |
| GET    | `/trust-chain`                               | Bearer                     | Founder seeds (empty edges); `?around=<id>` one hop of stored public edges                                |
| POST   | `/trust/verify`                              | Bearer (moderator+)        | Staff: confirm a person in real life (`verified`)                                                         |
| POST   | `/trust/propose-moderator`                   | Bearer (moderator+)        | Staff: propose a verified member as moderator                                                             |
| GET    | `/trust/proposals`                           | Bearer (moderator+)        | Staff: list pending moderator proposals                                                                   |
| POST   | `/trust/confirm-moderator`                   | Bearer (moderator+)        | Staff: second, independent confirmation → `moderator`                                                     |
| POST   | `/trust/appoint-moderator`                   | Bearer (founder)           | Founder: appoint a moderator directly                                                                     |
| GET    | `/messages`                                  | Bearer                     | List top-level forum notes (+ visible `replyCount`); 409 if rules missing                                 |
| POST   | `/messages`                                  | Bearer                     | Post text/photo; 409 if rules/name/username/Lightning Address missing                                     |
| GET    | `/messages/hidden`                           | Bearer (moderator+)        | Staff log of soft-hidden notes (session, not DEBUG_TOKEN)                                                 |
| GET    | `/messages/:id`                              | none / Bearer (moderator+) | Live public JSON; staff hidden GET includes `deletedAt`/`deletedBy`                                       |
| GET    | `/messages/:id/replies`                      | none / Bearer (moderator+) | Live replies; staff `listReplies(..., true)` includes hidden children even under a live parent            |
| GET    | `/messages/:id/photo`                        | none / Bearer (moderator+) | Live photo bytes; staff hidden bytes `Cache-Control: private, no-store`                                   |
| GET    | `/messages/:id/video.*`                      | none / Bearer (moderator+) | Live video bytes; staff hidden bytes `Cache-Control: private, no-store`                                   |
| DELETE | `/messages/:id`                              | Bearer (moderator+)        | Soft-hide note + direct replies; retract in-app notifications; external target also blocks that pubkey    |
| POST   | `/messages/:id/invoice`                      | Bearer                     | NIP-57 zap / BOLT11                                                                                       |
| POST   | `/contact`                                   | Bearer                     | Send private in-app contact `{ text }`                                                                    |
| GET    | `/conversations`                             | Bearer                     | List visible private threads (per-row `unreadMessageCount`; envelope `unreadCount` is thread count)       |
| GET    | `/conversations/moderator-group`             | Bearer (moderator+)        | Open/ensure closed moderator-group tool                                                                   |
| POST   | `/conversations`                             | Bearer                     | Open thread from a forum note (`forumMessageId`)                                                          |
| GET    | `/conversations/:id`                         | Bearer                     | Oldest-first messages (`?sinceMessageId=` long-polls until that id exists)                                |
| POST   | `/conversations/:id`                         | Bearer                     | Send `{ text }` in a private thread                                                                       |
| POST   | `/conversations/:id/invoice`                 | Bearer                     | NIP-57 zap / BOLT11 for a private gift (`{ sats, text? }` → `{ pr, amountSats, messageId }`)              |
| POST   | `/conversations/:id/read`                    | Bearer                     | Stamp last-read for the viewer                                                                            |
| GET    | `/notifications`                             | Bearer                     | List + unreadCount; drop leftover hidden forum_post/forum_reply (zap checks parent only)                  |
| POST   | `/notifications/read-all`                    | Bearer                     | Mark all notifications read                                                                               |
| POST   | `/notifications/:id/read`                    | Bearer                     | Mark one notification read                                                                                |
| GET    | `/lightning-address`                         | none                       | Resolve LUD-16 metadata (cached)                                                                          |
| GET    | `/debug/accounts`                            | `Authorization: Bearer`    | Operator account listing (`DEBUG_TOKEN`)                                                                  |
| POST   | `/debug/accounts`                            | `Authorization: Bearer`    | Operator provision name + Lightning Address (`DEBUG_TOKEN`)                                               |
| PATCH  | `/debug/accounts/:id`                        | `Authorization: Bearer`    | Operator set `role` / unlink Lightning Address / `platform` / `sessionRefused`                            |
| POST   | `/debug/accounts/:id/session`                | `Authorization: Bearer`    | Operator mint of a member bearer (`DEBUG_TOKEN`)                                                          |
| GET    | `/debug/api-log`                             | `Authorization: Bearer`    | Operator HTTP audit log (`DEBUG_TOKEN`); no query string, body, or Authorization                          |
| GET    | `/debug/contacts`                            | `Authorization: Bearer`    | Operator contact listing (`DEBUG_TOKEN`)                                                                  |
| GET    | `/debug/invoices`                            | `Authorization: Bearer`    | Operator invoice attempts, forum and conversation (`DEBUG_TOKEN`)                                         |
| POST   | `/debug/invoices/settle`                     | `Authorization: Bearer`    | Resumable operator settlement of a paid forum invoice (`DEBUG_TOKEN`)                                     |
| GET    | `/debug/zap-ingests`                         | `Authorization: Bearer`    | Operator kind:9735 ingest log (`DEBUG_TOKEN`)                                                             |
| GET    | `/debug/messages`                            | `Authorization: Bearer`    | Operator forum listing including hidden rows and replies (`DEBUG_TOKEN`)                                  |
| GET    | `/debug/messages/:id`                        | `Authorization: Bearer`    | Operator single-note fetch including hidden rows (`DEBUG_TOKEN`)                                          |
| GET    | `/debug/messages/:id/photo`                  | `Authorization: Bearer`    | Operator photo bytes including hidden notes (`DEBUG_TOKEN`)                                               |
| PUT    | `/debug/messages/:id/video`                  | `Authorization: Bearer`    | Operator restore of missing forum-video bytes (`DEBUG_TOKEN`)                                             |
| POST   | `/debug/messages/:id/restore`                | `Authorization: Bearer`    | Operator unhide of a soft-hidden forum note (`DEBUG_TOKEN`)                                               |
| GET    | `/debug/external-pubkeys`                    | `Authorization: Bearer`    | Operator lists entitled and blocked external pubkeys (`DEBUG_TOKEN`)                                      |
| POST   | `/debug/trust-edges`                         | `Authorization: Bearer`    | Operator trust-edge backfill (`DEBUG_TOKEN`); does not change `role`                                      |
| DELETE | `/debug/trust-edges`                         | `Authorization: Bearer`    | Operator trust-edge delete (`DEBUG_TOKEN`); does not change `role`                                        |
| GET    | `/push/vapid-public`                         | Bearer                     | VAPID public key for Web Push subscribe                                                                   |
| POST   | `/me/push-subscriptions`                     | Bearer                     | Upsert a browser PushSubscription                                                                         |
| DELETE | `/me/push-subscriptions`                     | Bearer                     | Remove a browser PushSubscription                                                                         |
| POST   | `/debug/push-ping`                           | Bearer `DEBUG_TOKEN`       | Enqueue a test push for one account                                                                       |
| GET    | `/gifts`                                     | none                       | Outbound gifts for one UTC day (`?day=`)                                                                  |
| GET    | `/gifts/stats`                               | none                       | Aggregated outbound gift statistics                                                                       |
| GET    | `/invoices/passkey`                          | Bearer `SPEND_API_TOKEN`   | Whether a Lightning Address has a passkey-backed account                                                  |
| GET    | `/invoices/posted`                           | Bearer `SPEND_API_TOKEN`   | Whether a Lightning Address has a live top-level non-profile forum post                                   |
| POST   | `/invoices`                                  | Bearer `SPEND_API_TOKEN`   | Fetch a recipient BOLT11 (LNURL-pay; passkey and forum post required)                                     |
| POST   | `/invoices/proof`                            | Bearer `SPEND_API_TOKEN`   | Accept payment preimage as proof                                                                          |

Auth column: "Bearer (X+)" means minimum role X — X or any higher role.

## Role hierarchy

Roles are ordered `founder > moderator > verified > basis`. A higher role can
always do and see everything a lower role can; there are no exceptions. Every
route that names a role names the **minimum** role: "Bearer (moderator+)" means
moderator **or founder**, "Bearer (verified+)" means verified, moderator or
founder. Permission checks use `roleAtLeast` (`src/lib/auth/roles.ts`); an
equality test on the caller's role is a defect. Checks on the _subject_ of an
action (for example "only a verified member can be proposed as moderator") are
state rules, not permissions, and stay exact.

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
JSON unchanged (`resolveLnurlpDocument`; `c.json(resolved.body, 200,
WELL_KNOWN_CORS)`). The callback stays on Wallet of Satoshi. 21.gifts
does not mint invoices. Settlement stays on the linked Wallet of Satoshi
address.

CORS is the same `WELL_KNOWN_CORS` as `/.well-known/nostr.json`:
`Access-Control-Allow-Origin: *`, methods `GET` / `OPTIONS`,
`Cache-Control: public, max-age=60`.

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

Success → **Response** `200` with the provider payRequest JSON passed
through unchanged. This service does not invent or rewrite Wallet of
Satoshi fields.

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

Starts a discoverable-credential registration. Empty body mints a new account
id (no row until finish). Optional JSON `{ "viewKey": "<64 lowercase hex>" }`
claims an existing provisioned account: `404` when the profile is missing,
`409` when it already has a passkey, `400` when `viewKey` is present but not a
string.

When `WEBAUTHN_RP_ID` is unset, blank, not on the allowlist (`21.gifts` /
`dev.21.gifts` / `localhost`), or no CORS origin matches that RP ID:

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
`userVerification` required, attestation `none`). `user.id` is the pending
account UUID encoded as UTF-8 (the provisioned account when claiming by
`viewKey`). The process still boots without
`WEBAUTHN_RP_ID` — only these routes fail closed.

### `POST /auth/passkey/register/finish`

Verifies the attestation and issues a session immediately (no poll).

Body:

```json
{ "challengeId": "<hex>", "credential": {} }
```

`credential` is the browser `RegistrationResponseJSON`. The request `Origin`
must be in the RP ID's expected origins (CORS allowlist filtered to that RP
ID).

| Status | Body                                                                                              | When                                                                |
| ------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 500    | `{ "error": "Server auth is not configured" }`                                                    | RP ID missing, not on the allowlist, or no matching origin          |
| 400    | `{ "error": "Expected a JSON body with challengeId and credential" }`                             | Body parse fail                                                     |
| 400    | `{ "error": "Unknown or expired challenge" }`                                                     | Unknown `challengeId`                                               |
| 400    | `{ "error": "Challenge expired" }`                                                                | Past challenge TTL                                                  |
| 400    | `{ "error": "Challenge already used" }`                                                           | Finish already attempted; challenge is consumed before verification |
| 400    | `{ "error": "Wrong challenge type" }`                                                             | Challenge is not `register`                                         |
| 400    | `{ "error": "Invalid origin" }`                                                                   | Missing or disallowed `Origin`                                      |
| 400    | `{ "error": "Invalid passkey" }`                                                                  | Attestation verify failed or duplicate credential                   |
| 403    | `{ "error": "You signed in with the wrong account. Please try again with the correct account." }` | Account with `sessionRefused`; no bearer is persisted               |

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
    "notificationLevel": "all"
  }
}
```

The `account` object is the same owner JSON as `GET /me` (includes `viewKey`, `setup`, `missing`, `hasPosted`, `aboutMe`, `aboutMeHasPhoto`, and `notificationLevel`).

### `POST /auth/passkey/authenticate/begin`

Starts a discoverable-credential assertion. `allowCredentials` is empty.
Same 500 as register begin when WebAuthn is unconfigured.

**Response** `200`: `{ "challengeId", "options" }` where `options` is
`PublicKeyCredentialRequestOptionsJSON`.

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
  "notificationLevel": "all"
}
```

About me is the profile-note text when it is a real bio, else null (auto
name-copy is not a bio, including after a display-name rename when the note
text still equals the stored profile-note `name` (Ada→Grace with text `Ada`
stays `null`)).

| Field                      | Type           | Meaning                                                                                                                                                                                                                                                                     |
| -------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                       | string         | Opaque account id                                                                                                                                                                                                                                                           |
| `linkingKey`               | string \| null | Historical LNURL-auth linking key (hex), or `null` for passkey accounts                                                                                                                                                                                                     |
| `role`                     | string         | `basis`, `verified`, `moderator`, or `founder`                                                                                                                                                                                                                              |
| `name`                     | string \| null | Display name, or `null` until set                                                                                                                                                                                                                                           |
| `username`                 | string \| null | Unique LUD-16 / NIP-05 local-part (`a-z0-9-_.`), or `null` until set. Cannot skip.                                                                                                                                                                                          |
| `location`                 | string \| null | Free-text location set by the owner, or `null` when unset. Not unique. Not a setup step.                                                                                                                                                                                    |
| `lightningAddress`         | string \| null | Linked LUD-16 address, or `null`                                                                                                                                                                                                                                            |
| `lightningAddressVerified` | boolean        | Proof-of-control flag (`true` only after confirm)                                                                                                                                                                                                                           |
| `forumLawsDismissed`       | boolean        | `true` after the welcome-forum living-room laws hint was dismissed                                                                                                                                                                                                          |
| `viewKey`                  | string         | Durable 64 lowercase hex capability secret for GET /view/:viewKey. Owner-only. Not a session.                                                                                                                                                                               |
| `createdAt`                | number         | Creation time (epoch ms)                                                                                                                                                                                                                                                    |
| `rulesAgreedAt`            | number \| null | Epoch ms of first living-room rules agreement, or `null`                                                                                                                                                                                                                    |
| `setup`                    | string \| null | Next wizard step: `name`, `username`, `lightning-address`, `rules`, or `null` when complete. Skip timestamps count as done except username, which cannot be skipped. Clients must not invent a parallel sequence.                                                           |
| `missing`                  | string[]       | Factually unset fields (`name`, `username`, `lightning-address`, `rules`) even when skipped. Does not include `profileMessageId`.                                                                                                                                           |
| hasPosted                  | boolean        | True when this account has a live forum row that is not the auto-created profile note. Replies still count. Not the same predicate as GET /invoices/posted (that is top-level only).                                                                                        |
| `aboutMe`                  | string \| null | Profile-note text when it is a real bio, else `null` (missing or soft-hidden (`deletedAt` set); auto name-copy is not a bio, including after a display-name rename when the note text still equals the stored profile-note `name` (Ada→Grace with text `Ada` stays `null`)) |
| `aboutMeHasPhoto`          | boolean        | True when the live profile note has a stored JPEG/PNG/WebP. Independent of `aboutMe` (photo-only and name-copy notes can still have a photo). Bytes are `GET /me/about/photo`. Does not expose `profileMessageId`.                                                          |
| `notificationLevel`        | string         | Owner fan-out filter: `all`, `active`, or `mentions`. Default `all`. Owner-only; omitted from public `GET /view/:viewKey` and member cards.                                                                                                                                 |

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

`donatedOverTime` / `receivedOverTime` reuse the `spendOverTime` day objects from `GET /gifts/stats`, including additive CHF/EUR/PHP. USD = per-gift UTC-day Coinbase BTC-USD close. CHF/EUR/PHP = USD × that UTC day's Frankfurter ECB cross. Missing fiat is JSON `null`, never 503 (`account.activity.fiat_failed` still 200). Empty activity is 200 zeros with USD-only `fx.quotes` (no Coinbase / Frankfurter). Given = confirmed forum zaps this account paid, plus every outbound house gift when `isPlatform` is true. Received = indexed zaps on notes this account authored (including hidden and replies), plus `message.sats` remainder on **top-level** notes only (so a visible ₿21 post is never empty; gift-as-reply `sats` are not Received), plus house gifts to the account Lightning Address handle. Forum zaps are not mixed into `GET /gifts/stats`.

### `POST /me/setup/skip`

Skip a skippable wizard step. Body:

```json
{ "step": "name" }
```

or `{ "step": "lightning-address" }`. Sets the matching skip timestamp to now;
does not clear `name` / `lightningAddress`. `step: "rules"` and unknown steps
are **400**. Success → **200** owner JSON.

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
(not the latest-200 window), and `trust` (`verifiedBy` / `proposedBy` /
`confirmedBy` / `appointedBy`, each `{ id, name }` or `null`). Default
`trust` is all-null when no stored edges exist. Never `viewKey` /
`eventId`.

### `GET /members/:accountId/posts`

Bearer required. Same 401 / 409 / 404 / 503 as `GET /members/:accountId`
(`members.posts.failed` on 503). Live-only top-level notes by the member,
newest-first, capped at 200. Body `{ "messages": [...] }` via
`serializeMessage` like signed-in `GET /messages` (`accountId`,
`replyCount`, `payable` when a non-empty `eventId` and a non-blank Lightning Address are set;
optional `goalSats` omitted when unset).
Omits `parentId`. Replies by that member are not listed.

### `GET /members/:accountId/replies`

Bearer required. Same 401 / 409 / 404 / 503 as `GET /members/:accountId`
(`members.replies.failed` on 503). Live-only replies by the member,
newest-first, capped at 200. Body `{ "messages": [...] }` via
`serializeMessage` with `payable` when a non-empty `eventId` and a non-blank Lightning Address are set, `accountId`, and optional
`parentId` when set; omits `replyCount`. Replies never include `goalSats`.
Top-level notes by that member are not listed.

### `GET /members/:accountId/activity`

Same auth and 401 / 409 / 404 as `GET /members/:accountId`. Success is the
same JSON as `GET /me/activity` for **that** member. 503 `{ "error": "Gift
stats are unavailable" }` when the gift store throws or a gift day lacks
BTC-USD.

### `GET /trust-chain`

Stored trust graph. Bearer session required (any role, including basis).
Missing or invalid Bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

Bare `GET /trust-chain` returns
**founder seeds only** (`edges` empty) so a large chain is not dumped on
first paint. `GET /trust-chain?around=<id>` returns that chain member plus
one hop of **stored** public edges with at most one incoming kind per
subject: the oldest eligible sibling (`createdAt` then `id`). Eligible:
`verify`, `moderator_appoint`, and `moderator_propose` only when the live
subject is a `moderator`; `moderator_confirm` never. Later appoint,
confirm, or propose do not replace an earlier eligible contact. A pending
propose (subject still `verified`) stays private and is not a hop neighbor.
Neighborhood must consider all stored edges for each subject, not only
edges that touch `around`. Nodes are `founder` / `moderator` / `verified`
(never `basis`).
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

Lists pending `moderator_propose` edges whose live subject is still
`verified` and has no `moderator_confirm` or `moderator_appoint`. Missing
subjects are omitted. Oldest `createdAt` first, then propose-edge `id`
(FIFO). JSON `{ "proposals": [ … ] }` including an empty list. Each item
is `{ subject: { id, name, role: "verified" }, proposedBy: { id, name },
createdAt }` with ISO-8601 `createdAt`. A missing actor is
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

Bearer session. Body `{ "accountId": "<uuid>" }`. Caller must be at least
`moderator`. Inserts a `verify` edge from the caller to the subject,
then sets `account.role` to `verified`. `verified` is a real-life
confirmation (forum badge), not Lightning-Address proof.

Missing/invalid bearer → **401** `{ "error": "Unauthorized" }`.
Caller not staff → **403** `{ "error": "Forbidden" }`.
Body is not JSON with an `accountId` string → **400**
`{ "error": "Expected a JSON body with an \"accountId\" string" }`.
`accountId` is not a UUID or the subject is missing → **404**
`{ "error": "Not found" }`.
Subject is the caller, a verify edge belongs to someone else, or the
subject is ineligible (`role` is not `basis`, except the caller-owned
retry below) → **409** `{ "error": "Conflict" }`.
Unexpected store throw → **503** `{ "error": "Trust chain is unavailable" }`
logged as `trust.write.failed`.

Idempotent **200** when the existing verify edge's actor is the caller and
the subject is already `verified` (no second insert). If that caller-owned
edge exists and the subject is still `basis`, completes the role write and
returns **200**.

Otherwise insert the edge then update role, log `trust.verified`
`{ subjectId, actorId }`.

**Response** `200`:

```json
{ "id": "<uuid>", "name": "Ada", "role": "verified" }
```

### `POST /trust/propose-moderator`

Bearer session. Body `{ "accountId": "<uuid>" }`. Staff only. Subject role
must be `verified`, not self, and must not already have
`moderator_propose` / `moderator_confirm` / `moderator_appoint` or be
`moderator`/`founder`. Inserts `moderator_propose` without changing role.
Logs `trust.moderator_proposed`. Same 401/403/400/404/409/503 shapes as
`POST /trust/verify`. **200** `{ id, name, role }` (role unchanged).

### `POST /trust/confirm-moderator`

Bearer session. Body `{ "accountId": "<uuid>" }`. Staff only. A pending
`moderator_propose` must exist; the caller id must not equal the proposer's
actor id (independent second staff member). Subject must still be
`verified`. Inserts `moderator_confirm` then sets role to `moderator`, logs
`trust.moderator_confirmed`. If the caller already stored `moderator_confirm`
and the subject is still `verified`, completes the role write and returns
**200**; already-moderator with that caller-owned edge is idempotent **200**.
Same 401/403/400/404/409/503 JSON shapes (409 when a confirm edge belongs
to someone else). **200** `{ id, name, role }` with `role: "moderator"`.
After a 200 that leaves the subject as `moderator` (new grant and
idempotent already-moderator same-actor 200), the api notifies the
subject only (`moderator_appointed`, Web Push url `/welcome`). Notify
failure does not fail the POST.

### `POST /trust/appoint-moderator`

Bearer session. Body `{ "accountId": "<uuid>" }`. Caller must be `founder`
(moderators → **403**). Subject must not be self, not `founder`, and not
already `moderator`; subject may be `basis` or `verified`. Inserts
`moderator_appoint` then sets role to `moderator`, logs
`trust.moderator_appointed`. If the caller already stored `moderator_appoint`
and the subject is not yet `moderator`, completes the role write and returns
**200**; already-moderator with that caller-owned edge is idempotent **200**.
Same 401/403/400/404/409/503 shapes as `POST /trust/verify` (403
when the caller is not a founder). **200** `{ id, name, role }` with
`role: "moderator"`. After a 200 that leaves the subject as
`moderator` (new grant and idempotent already-moderator same-actor
200), the api notifies the subject only (`moderator_appointed`, Web
Push url `/welcome`). Notify failure does not fail the POST.

### `GET /view/:viewKey`

Public capability URL for a read-only profile card. No auth. Not a session:
the key cannot write, cannot mint a session, and is not accepted as
`Authorization: Bearer`.

Param not matching `/^[0-9a-f]{64}$/` or an unknown key → **Response** `404`:

```json
{ "error": "Not found" }
```

**Response** `200` (nine fields including `username` (`string | null`);
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
  "aboutMeHasPhoto": false
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
JSON `null` clears it; `{ contentType, data }` is decoded with
`decodeForumPhoto` (same JPEG/PNG/WebP under 1 MiB as `POST /messages`).

Missing/invalid bearer → **Response** `401` `{ "error": "Unauthorized" }`.

Body is not JSON with a `text` string → **Response** `400`:

```json
{ "error": "Expected a JSON body with a \"text\" string" }
```

`text` is a string but `photo` is present and neither `null` nor
`{ contentType, data }`, or decode fails → **Response** `400`:

```json
{ "error": "Photo must be a JPEG, PNG, or WebP under 1 MiB" }
```

Text longer than 500 characters after trim (or containing a disallowed
control character) → **Response** `400`:

```json
{ "error": "About me must be at most 500 characters" }
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
has a stored photo.

### `GET /me/about/photo`

Bearer. Raw profile-note photo bytes (`forumPhotoResponse`: jpeg/png/webp
`Content-Type`, one-day public cache, CORS `*`, inline filename).

Missing/invalid bearer → **Response** `401` `{ "error": "Unauthorized" }`.

No live profile note or no photo → **Response** `404`
`{ "error": "Photo not found" }`.

Store throw → **Response** `503` `{ "error": "Messages are unavailable" }`
(`account.about.photo.failed`).

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
handle is blank; `setup` is `lightning-address` only when name is done or
skipped **and** username is set (and LN is blank / skip cleared).

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
      "sessionRefused": false
    }
  ]
}
```

The listing uses `serializeDebugAccount` (the eleven public fields plus
`isPlatform` and `sessionRefused`) and never includes `viewKey`. Member `GET /me` does not
include `isPlatform` or `sessionRefused`.

Accounts are ordered by `createdAt` ascending, then `id`. An empty store
returns `"accounts": []`.

Environment:

| Variable       | Meaning                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `DATABASE_URL` | When set, auth state is stored in Postgres; when unset, in-memory only. |
| `DEBUG_TOKEN`  | Operator bearer for this route. Unset → 503; process still boots.       |

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
`true`). GET still omits `viewKey` (provisioned `username` appears on GET
`/debug/accounts`).

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

`role` must be one of `basis`, `verified`, `moderator`, or `founder`.
`lightningAddress` may only be JSON `null` (unlink). `platform` is a
boolean; `true` clears any other platform flag (at most one `isPlatform`
account) and, when a conversation store is wired, points every
`member_platform` thread at this account except a thread whose member is
already this account. `sessionRefused` is a boolean; `true` makes passkey
finish and this route's session mint return 403 with the wrong-account
copy (`GET /me` too). Setting a new address is not supported here
(`POST /me/lightning-address` remains the live resolve path). Unlink
resets `lightningAddressVerified` to `false` and drops any in-flight
verification. It does not clear `username`. `GET /me` then returns
`setup: "username"` if the handle is blank, or `setup: "lightning-address"`
only when name is done or skipped **and** username is set (and LN is blank
/ skip cleared), so any client that follows `setup` shows the username or
address form as appropriate. `verified` as a **role** is a
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
`isPlatform` and `sessionRefused`; no `viewKey`). Role changes log `debug.accounts.role_set`
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
`moderator_appoint`.

Bad body → **400** `{ "error": "Expected a JSON body with \"subjectId\", \"actorId\", and \"kind\" strings" }`.
Missing subject or actor (or a non-UUID id) → **404** `{ "error": "Not found" }`.
Duplicate `(subjectId, kind)` or `subjectId === actorId` → **409**
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
other debug routes). Does **not** change `account.role`. Unique
`(subjectId, kind)` means one row is enough to identify.

**Request**:

```json
{
  "subjectId": "<uuid>",
  "kind": "moderator_confirm"
}
```

`kind` is one of `verify`, `moderator_propose`, `moderator_confirm`,
`moderator_appoint`.

Bad body → **400** `{ "error": "Expected a JSON body with \"subjectId\" and \"kind\" strings" }`.
Non-UUID `subjectId` or no matching row → **404** `{ "error": "Not found" }`.
Unexpected store throw → **503** `{ "error": "Trust chain is unavailable" }`
logged as `debug.trust_edges.delete_failed`.
Success logs `debug.trust_edges.deleted` `{ subjectId, kind }`.

**Response** `200` is the deleted edge, same JSON as `POST /debug/trust-edges`.

### `GET /debug/api-log`

Operator listing of HTTP audit rows (`api_log`). Authenticated with
`Authorization: Bearer` matching `DEBUG_TOKEN`. This is not an end-user
session. Rows are newest-first (`createdAt` descending, then `id`), capped
at **200**. The log never stores OPTIONS, `/healthz`, the query string,
request bodies, or the Authorization header. Paths pass through
`requestLogPath` (`/view/<segment>` → `/view/:viewKey`). Write failure on
the request path logs `api_log.write.failed` and does not replace the
response.

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
      "createdAt": "2026-09-19T15:16:52.530Z",
      "method": "POST",
      "path": "/conversations/<uuid>",
      "status": 200,
      "ms": 8,
      "accountId": "<uuid>",
      "authKind": "session"
    }
  ]
}
```

`authKind` is `session`, `debug`, `spend`, or `none`. `accountId` is the
session account when `authKind` is `session`; otherwise JSON `null`. An
empty log returns `"logs": []`. When `DATABASE_URL` is unset the default
in-memory store starts empty; when set, rows come from Postgres `api_log`.

Environment:

| Variable       | Meaning                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| `DATABASE_URL` | When set, audit rows are stored in Postgres; when unset, in-memory only. |
| `DEBUG_TOKEN`  | Operator bearer for this route. Unset → 503; process still boots.        |

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
      "lnurlResponse": { "pr": "lnbc21n1...", "status": "OK" }
    }
  ]
}
```

`lnurlResponse` is the raw LNURL callback JSON object, or `null` when none
was stored. Rows are newest-first, capped at **200**. Never includes nsec.
`serializeInvoice` omits `conversationId` and `conversationMessageId` even
when the row is a conversation invoice.
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
1–500 characters without C0/DEL controls. `preimage` must be absent or a
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
the note (plus `preimage` only when it was supplied and verified). It then runs
the normal zap notification fan-out and inserts the payer gift-reply from the
original zap request. If credit succeeded but the ingest write failed, that
failure returns 503; a retry writes the missing ingest from the current
request, runs the post-credit effects, returns `resumed: true`, and does not
credit again. Fresh success returns `resumed: false`.

The durable payment-hash claim prevents a later real receipt, an ingest-write
failure, or message deletion from allowing another credit. A later real
receipt is persisted as `rejected` / `settled`. A payment hash already owned by
another receipt or represented by any indexed ingest cannot be settled
manually. If payer lookup throws after credit, the route still succeeds: it
logs the gift-reply failure, omits payer fields from the notification, and
skips the gift-reply.

Failures:

- malformed JSON/body field types → `400 { "error": "Invalid body" }`
- malformed payment hash or supplied preimage → `400 { "error": "Invalid payment hash or preimage" }`
- invalid note → `400 { "error": "Invalid note" }`
- supplied preimage/hash mismatch → `400 { "error": "Preimage does not match payment hash" }`
- no usable successful invoice → `404 { "error": "Invoice not found" }`
- conversation invoice → `409 { "error": "Conversation invoices cannot be settled" }`
- missing/hidden target message → `404 { "error": "Message not found" }`
- already indexed/settled payment → `409 { "error": "Already settled" }`
- store failure, including the direct ingest write → `503 { "error": "Messages are unavailable" }`

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
JSON `{ "messages": [ … ] }` via `serializeDebugMessage`. Optional `goalSats`
is a positive integer on a top-level note and is omitted on replies and when
the stored value is unset, null, or 0. Never includes
`nostrEvent`, `contentFp`, nsec, or photo/video bytes.

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
(not wrapped). Optional `goalSats` is a positive integer on a top-level note
and is omitted on replies and when the stored value is unset, null, or 0.
Never includes `nostrEvent`, `contentFp`, nsec, or photo/video bytes.

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

### `GET /gifts`

Public list of outbound gifts for one UTC calendar day. Query `day=YYYY-MM-DD`.
No auth. The body never includes invoices, fees, or wallet identifiers.

Missing, blank, or impossible `day` (`2026-02-31`) → **400**
`{ "error": "Expected a UTC day (YYYY-MM-DD)" }`.

When `DATABASE_URL` is unset the in-memory gift store is empty — **200** with
zeros (`totalUsd` / `totalChf` / `totalEur` / `totalPhp` `"0.00"`), `gifts: []`,
and `fx` with USD-only `quotes` (no Coinbase / Frankfurter). When gifts exist
for that day, the api ensures a BTC-USD close for that UTC day and converts
each gift at **that day's** close. CHF/EUR/PHP are USD × that UTC day's
Frankfurter ECB rate (last business day if closed). An empty matching set is
200 without Coinbase or Frankfurter. A query failure or a still-missing
BTC-USD rate is **503**. A missing CHF/EUR/PHP cross is JSON `null` on the
matching total and per-gift amount, never 503.

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
| `totalUsd`  | string                                                                                       | Sum of per-gift USD at **this** day's close (`"1.00"`)                                                    |
| `totalChf`  | string or null                                                                               | USD × this day's ECB CHF; `"0.00"` when empty; `null` if this day lacks CHF                               |
| `totalEur`  | string or null                                                                               | USD × this day's ECB EUR; `"0.00"` when empty; `null` if this day lacks EUR                               |
| `totalPhp`  | string or null                                                                               | USD × this day's ECB PHP; `"0.00"` when empty; `null` if this day lacks PHP                               |
| `gifts`     | `{ paidAt, amountSats, amountBtc, amountUsd, amountChf, amountEur, amountPhp, recipient }[]` | Ordered by `paidAt` ascending, then `recipient`                                                           |
| `fx`        | `{ quote, dayBasis, source, quotes }`                                                        | Always present; `quote` is BTC-USD; `quotes` lists USD always and CHF/EUR/PHP when that day has the cross |

`gifts[]` item:

| Field        | Type           | Meaning                                                 |
| ------------ | -------------- | ------------------------------------------------------- |
| `paidAt`     | string         | ISO-8601 instant (`toISOString`, UTC `Z`)               |
| `amountSats` | number         | Gift amount in sats                                     |
| `amountBtc`  | string         | Same amount as BTC with eight decimals                  |
| `amountUsd`  | string         | USD at this UTC day's close (`"1.00"`)                  |
| `amountChf`  | string or null | CHF at this UTC day's ECB cross, or `null` when missing |
| `amountEur`  | string or null | EUR at this UTC day's ECB cross, or `null` when missing |
| `amountPhp`  | string or null | PHP at this UTC day's ECB cross, or `null` when missing |
| `recipient`  | string         | Recipient handle (`recipient_wos_user`)                 |

**Response** `503`: `{ "error": "Gift stats are unavailable" }` (store failure or missing BTC-USD only; missing fiat is never 503).

### `GET /gifts/stats`

Public aggregated outbound gift statistics. No auth. The body never includes
invoices, fees, or wallet identifiers.

When `DATABASE_URL` is unset the in-memory gift and FX stores are empty —
**200** with zeros, empty series, `totalBtc` `"0.00000000"`, `totalUsd` /
`totalChf` / `totalEur` / `totalPhp` `"0.00"`, and `fx` with USD-only
`quotes` (no Coinbase / Frankfurter call). When it is set, the process
queries the `gift` table (`paid_at`, `amount_sats`, `recipient_wos_user`
only) and ensures a BTC-USD daily close for each gift's UTC calendar day
(from `btc_usd_daily`, fetching Coinbase only for missing days / stale
UTC-today / after-midnight finalize of an intraday print). Each gift's sats
are converted at **that day's** close (not spot). CHF/EUR/PHP are USD × that
UTC day's Frankfurter ECB rate (last business day if closed; persisted in
`usd_fiat_daily`). A gift day that lacks a cross returns that currency as
JSON `null`; a running total goes `null` if any selected gift lacks that
cross. Gap days in `spendOverTime` are zero `giftCount`/sats/BTC/USD and `"0.00"` fiat
and need no rate. Gap months in `byMonth` are zero sats/BTC/USD and
`"0.00"` fiat and need no rate.
A query failure or a still-missing BTC-USD rate after ensure is **503**.
A missing CHF/EUR/PHP cross is never 503.

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
| `totalUsd`       | string                                                                                                                                           | Sum of per-gift USD at each gift's UTC-day close (`"1234.56"`)                                                               |
| `totalChf`       | string or null                                                                                                                                   | USD × each gift day's ECB CHF; `"0.00"` when empty; `null` if any gift day lacks CHF                                         |
| `totalEur`       | string or null                                                                                                                                   | USD × each gift day's ECB EUR; `"0.00"` when empty; `null` if any gift day lacks EUR                                         |
| `totalPhp`       | string or null                                                                                                                                   | USD × each gift day's ECB PHP; `"0.00"` when empty; `null` if any gift day lacks PHP                                         |
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

### `GET /invoices/posted`

Spend-worker eligibility check. Query `address=name@domain.tld`. Same
`SPEND_API_TOKEN` Bearer as `POST /invoices` (503 unconfigured / 401
unauthorized).

Missing or invalid Lightning Address → **400**
`{ "error": "Not a valid Lightning Address (expected name@domain)" }`.

Success is always **200** (never 404 for an unknown address):

```json
{ "hasPosted": true, "messageId": "<uuid>", "postedAt": "<iso-8601>" }
```

or `{ "hasPosted": false, "messageId": null, "postedAt": null }` when there is no account for the
address or the account has no live **top-level** forum message other than the
auto-created profile note. Replies do not count. Photo-only / empty-text
top-level notes still count. When `hasPosted` is true, `messageId` is usually
the newest live top-level non-profile post id; it can still be `null` if
`listPostsByAccount` yields no non-profile row. `postedAt` is that row's
`createdAt` (ISO-8601) or `null` when `messageId` is null. Replies and the auto profile
note never become `messageId`.

### `POST /invoices`

Spend-worker invoice fetch. After address and amount validation, the api
requires a 21.gifts account for `address` that already has a passkey
credential and at least one live **top-level** forum message that is not the
auto-created profile note. Replies do not unlock an invoice. It then resolves
LUD-16, GETs the LNURL-pay callback, decodes the BOLT11, and stores
`{ id, pr, paymentHash }` in memory. It does not pay.

**Body:**

```json
{ "address": "name@domain.tld", "amountMsat": 100000, "comment": "optional", "messageId": "<uuid>" }
```

Moderator stipend form (never together with `messageId`):

```json
{
  "address": "name@domain.tld",
  "amountMsat": 100000,
  "comment": "optional",
  "groupMessageId": "<uuid>"
}
```

`comment` is optional and at most 255 characters. `amountMsat` must be an
integer in `1000..10000000000`. `messageId` is optional (current spend without
the field still works). `groupMessageId` is optional and mutually exclusive
with `messageId` (both set → **400**). Invalid UUID on either field → **400**
`{ "error": "Expected a JSON body with address and amountMsat" }`. When
`messageId` is set, the post must be that address's live top-level
non-profile note (else **403** `Forum post required` before LNURL). Missing
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

The account has a passkey but no live **top-level** forum message other than
the auto-created profile note, or `messageId` is set but is not that
address's live top-level non-profile note → **403** (after the passkey check,
before any LNURL fetch; no invoice is stored):

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

### `GET /messages`

Public member forum thread. Bearer session required. After auth,
`requireAction(account, 'forum.read')` (rules). Returns **only
top-level notes** (`parent_id IS NULL`) via `listFeed`. Query `mode`
(`all` default, `active`, `unpaid`, `popular`), `limit` (1–200, default
**200**), and opaque `cursor`. Response `{ messages }` plus `nextCursor`
only when the page is full. Newest first (`createdAt` descending, then
`id`) except `popular` (sats descending). Replies are never listed here —
use `GET /messages/:id/replies`. The list path does not load reply rows.
Clients must render the thread as a **messenger group** (oldest at
the top, newest at the bottom above the composer), reversing the array for
display. Each message exposes the author **name snapshotted at post time**,
`text` (may be empty when a photo or video is attached), ISO-8601
`createdAt`, `sats` (validated Lightning receipts on that note, default 0),
optional `goalSats` (positive integer on a top-level note; omitted when
unset/null/0),
`payable` (true when the note has a non-empty signed `eventId` and the author
has a non-blank Lightning Address; null or empty `eventId` is not payable),
`hasPhoto` (photo 0 exists), `photoCount` (integer 0–10 = photo 0
plus extras 1–9; always present), `hasVideo`, `videoContentType` (`null` when
`hasVideo` is false), live `role` (the author's current `account.role`, or
`"basis"` if the author is missing; omitted for external authors), and
`replyCount` of live attributed children (`parent_id` match, `deleted_at`
null, and `account_id` set, or `author_pubkey` set and that pubkey is a
recorded zapper (`nostr_zapper` entitlement, checked via `isZapperPubkey` /
an `EXISTS` subquery)). Visible external rows
include `"via": "nostr"`; their pubkey, `role`, and `accountId` remain omitted,
and `payable` is false. Rows with neither an account nor an author pubkey stay
invisible. List JSON never includes photo
or video bytes. Signed-in list/replies/create may include `accountId`
(21gifts author id; omitted for external rows); public GET `/messages/:id`
never includes it. Nostr event ids are never included in the JSON.

Missing/invalid/expired bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

Unknown `mode`, `limit` outside 1–200, or a bad/mismatched `cursor` → **Response** `400`:

```json
{ "error": "Invalid mode" }
```

```json
{ "error": "Invalid limit" }
```

```json
{ "error": "Invalid cursor" }
```

`mode=active` is paid notes plus unpaid founder/moderator notes; `unpaid` is `sats = 0`; `popular` is paid notes ordered by sats descending.

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
      "payable": false,
      "hasPhoto": false,
      "photoCount": 0,
      "hasVideo": false,
      "videoContentType": null,
      "role": "basis",
      "replyCount": 0
    }
  ]
}
```

An empty thread is **200** with `"messages": []`. When `DATABASE_URL` is
unset the default in-memory store starts empty; when set, rows come from
Postgres `message`. List queries select top-level rows only
(`parent_id IS NULL`), `(photo IS NOT NULL) AS has_photo`, and a
`replyCount` of live attributed children
(`account_id IS NOT NULL OR (author_pubkey IS NOT NULL AND EXISTS
(SELECT 1 FROM nostr_zapper WHERE pubkey = lower(author_pubkey)))`),
and must not select the `photo` bytea
column.

The nostr worker, each tick, queries zap relays (space plus the public
list, including when `NOSTR_PUBLISH_PUBLIC` is unset) for kind:9735
receipts whose `e` tag matches a non-empty `event_id` from `listLatest`
or a non-null `listReplies` child of those rows (unioned with open
conversation zap event ids). Empty `event_id` rows are skipped. A receipt is
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
has no `since`, so older replies become visible on the first tick after the
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

### `POST /messages`

Post to the public member forum. Bearer session required. JSON body (not
multipart) with text and/or one photo, optional `photos` (array, max 10,
each `{ contentType, data }` same shape as singular `photo`), an
optional parent UUID, and optional `goalSats` (positive integer 1..10_000_000
on a top-level note only):

Top-level with a goal:

```json
{
  "text": "…",
  "goalSats": 21000,
  "photo": { "contentType": "image/jpeg", "data": "<base64>" }
}
```

Reply (no `goalSats`; a positive `goalSats` with `inReplyTo` is 400):

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
null) → **404** `{ "error": "Not found" }`. A valid parent where the
caller is neither the parent author nor `verified` → **403**
`{ "error": "A reply needs a Bitcoin payment" }` (pay via
`POST /messages/:id/invoice` instead). Optional `goalSats` omitted, JSON
`null`, or a missing/empty multipart field means no goal. Multipart accepts
`goalSats` as a decimal digit string. A positive `goalSats` together with
`inReplyTo` → **400** `{ "error": "A reply cannot ask for a goal" }`. An
invalid multipart `goalSats` → **400** `{ "error": "Goal must be a positive whole-sat amount" }`.
JSON type/range errors keep **400** `{ "error": "Expected a JSON body with text and/or photo" }`.
Above 10_000_000 is rejected, not clamped. Multipart video posts do not
accept `inReplyTo` (they are always top-level).

After auth, `requireAction(account, 'forum.post')` requires rules agreement,
a non-blank display name, a non-blank username, and a non-blank Lightning
Address (skip timestamps do not satisfy; username cannot be skipped). The api stores a **name snapshot** (trimmed account name at
post time), normalised text (possibly `""` for photo-only), optional
JPEG/PNG/WebP bytes (≤ 1 MiB; MIME from magic bytes), `parentId` (null for
top-level notes), and a timestamp. Text longer than **500** after trim, or
with disallowed C0/DEL controls, is rejected. Newlines (`\n`, `\r`) are
allowed. The **200** body is the public message object itself (not wrapped
in `{ messages }`), including `sats`, `payable`, `hasPhoto`, `photoCount`
(0–10; always present; `hasPhoto` still means photo 0 exists), `hasVideo`, and
`videoContentType`. May include `goalSats` (positive integer on a top-level
note; omitted when unset). May include `accountId` (21gifts author id). No
`replyCount`, and no photo or video bytes in the JSON. `sats` is 0 and
`payable` is false until the worker signs the note (and stays false without
author LN). `role` is the posting session account's live `account.role`. Web Push and in-app rows for a **top-level** note (`notifyForumPost`, kind
`forum_post`, `url` `/notifications`, `tag` `forum_post:<id>`) and for a
**reply** (`notifyForumReply`, kind `forum_reply`, `url` `/notifications`,
`tag` `forum_reply:<replyId>`) fan out in-app to every account except the
actor (no-op when the actor is the official platform account), then filter recipients by each account's `notificationLevel`
(`all` / `active` / `mentions`). Web Push still goes only to bell subscribers
and uses the same level filter. Damus-only parents still
fan out. A self-reply skips only the actor. `GET /notifications` applies the
same `notificationLevel` filter to stored rows.
The booted process always has notification and push stores (in-memory without
`DATABASE_URL`, Postgres when it is set). Photo-only empty text still
notifies. Missing `pushStore` still writes in-app rows. Notification or
push failure does not fail the **200**. Over-limit posters
get **429** `{ "error": "Too many messages" }`
with `Retry-After: 10` (1/10s, 6/h, 20/UTC-day). A second **live** photo/video
POST with the same account, parent, normalised text, and media bytes returns
**200** with the existing row (no extra burst slot, no second top-level push).
Text-only posts are unchanged (still **429** on burst). After a **new**
top-level persist, the api POSTs `{ address, messageId }` to `{SPEND_URL}/ping` with
Bearer `SPEND_API_TOKEN` (fire-and-await; `messageId` is the UUID of the new
top-level row). Errors are logged; the POST still
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

Text longer than 500 after trim, or contains a disallowed control →
**Response** `400`:

```json
{ "error": "Text must be 1–500 characters" }
```

Whitespace-only / empty text with no photo and no non-empty `photos` →
**Response** `400`:

```json
{ "error": "Text must be 1–500 characters or include a photo" }
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

Valid parent, but the caller is not the parent author and not
`verified` →
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
  "hasVideo": false,
  "videoContentType": null,
  "role": "basis"
}
```

### `POST /messages/:id/invoice`

Signed-in pay-on-note. Bearer session required. `:id` is a UUID (`MESSAGE_ID_RE`).
Body `{ "sats": <int 1..10_000_000>, "text"?: "<string>" }`. Optional `text` is the
NIP-57 zap-request `content` (same 1–500 forum rules; omit or whitespace = gift-only).
Invalid `text` → **400** `{ "error": "Text must be 1–500 characters" }`.
The api signs a NIP-57 zap request with the
**payer** key and returns a BOLT11 invoice for the **author** Lightning Address
**only** when the minted invoice's `description_hash` equals SHA-256 of the
zap-request JSON (`isNip57Invoice`). A validated kind:9735 receipt credits the
paid row (`:id`, which may be a reply). After that increment (never in the same
SQL CTE), the worker inserts a reply from the payer (`text` from the zap-request
comment or `""`, `sats` = this zap) only when the paid row is top-level
(`parentId` null). Member invoices keep the existing relaxed signed-request
attribution. An external payer must pass the strict description-hash, target,
amount, signature, replay, and block checks described under `GET /messages`;
its gift-reply has `accountId` null, `via: "nostr"`, and is never signed by the
platform. A zap on a signed reply is `addSats` only (no nested gift-reply), but
a verified external payer still gains durable zapper entitlement. Gift-only
member replies (`text === ""`) and all external gift-replies stay
`nostrPublishState` `skipped` (no kind:1). Parent `sats` is the aggregate;
reply `sats` is this gift.
After a newly indexed receipt, `notifyZap` runs best-effort (in-app rows for
every account except the resolved payer, no-op when that payer is the official
platform account, then filtered by each account's
`notificationLevel`; Web Push only to bell subscribers with the same filter;
missing `pushStore` still writes in-app rows when `auth` is set; enqueue
failure logs `push.enqueue.failed`). `GET /notifications` applies the same
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
`hasPhoto` still means photo 0 exists) with
`payable` when a member row has a non-empty `eventId` and a non-blank
Lightning Address, and no `replyCount`. Unauthenticated items omit
`accountId`; signed-in member replies include `accountId`. External replies
set `via: "nostr"`, keep `payable: false`, and omit `accountId`, `role`, and the
pubkey. Replies never include `goalSats`.
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

### `GET /messages/:id`

Public single-note fetch. Live rows need **no Bearer.** `:id` is a UUID.
Registered **after** photo, video, `GET /messages/:id/replies`,
`DELETE /messages/:id`, and `GET /messages/hidden` so those paths are not
captured as `:id`. A live GET returns
the public message JSON (`sats`, optional `goalSats` on a top-level note
when the stored ask is a positive integer, `payable`, `hasPhoto`, `photoCount`
(0–10; always present; `hasPhoto` still means photo 0 exists), `hasVideo`,
`videoContentType`; live `role` for 21gifts authors) and omits
`accountId`, `deletedAt`, and `deletedBy`. Unsigned and non-staff GET of a
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
(same body as missing/hidden). `replyCount` is omitted. Photo and video bytes
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
  "hasVideo": false,
  "videoContentType": null,
  "role": "basis"
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
`hasVideo` / `videoContentType`, optional `goalSats` (positive integer on a
top-level note; omitted when unset/null/0 or on a reply), always-present `parentId` (JSON `null`
on top-level), optional `via: "nostr"` exactly when `accountId === null &&
authorPubkey !== null` (the same rule as public message JSON), and
`deletedBy: { id, name, role }` resolved from
`authStore.getAccount` (missing account keeps that id with `name` /
`role` null; null `deletedBy` is `{ id: null, name: null, role: null }`).
Never includes `accountId`, `authorPubkey`, `eventId`, `nostrPublishState`,
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
length **1–500**. Forum photo-only empty text is not accepted here. The
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

Text empty, longer than 500 after trim, or contains a disallowed control →
**Response** `400`:

```json
{ "error": "Text must be 1–500 characters" }
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
the role is at least `moderator`) every platform thread. Empty threads
and outbound-only member/Damus threads (every stored message is
`conversationFromMe` for the viewer — the actor, else the sender) are
omitted. The member's own `member_platform` contact thread is listed when
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

`unreadCount` is the number of listed rows with `unread: true` (same
cap/filter, not a second uncapped query; menu/PWA badge). Per-row
`unreadMessageCount` is the number of inbound messages strictly after
last-read (`0` when none; gift-only inbound counts; outbound does not).
Per-row `unread` is `unreadMessageCount > 0` (outbound-only listed contact
tickets are `false`). List GET does not stamp last-read. `accountId` is the
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
      "accountId": "<uuid>"
    },
    {
      "id": "<uuid>",
      "name": "21.gifts",
      "text": "21gifts moderator · Ada",
      "createdAt": "2026-08-29T12:00:02.000Z",
      "fromMe": false,
      "sats": 6158,
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
List rows also include `lastSats` (0 when the last message is unpaid text).

### `POST /conversations/:id`

Bearer session required. Body `{ "text": "…" }` 1–500 via
`normalizeForumText`. Moderator replies on a
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
the same UTC day. No such post → **200**, no ping,
log `spend.ping.skipped` / `no_public_post`. Ping throw still **200**.
Living-room lookup failure after persist is still **200**, no ping, log
`spend.ping.skipped` / `posted_unreachable`. Empty or invalid text is
**400** and does not ping. Verified, basis and the platform account **404**
on that id.

Same 401 / 400 text / 404 / 503 shapes as the list/get routes, plus
**400** `{ "error": "Set a name before posting" }` when the sending member
has no display name.

Success → **Response** `200` (one public conversation message, including
optional `accountId` — actor for staff when set, otherwise sender). After persist, the api enqueues one Web Push
(`type: conversation`, url `/messages?c=<conversationId>`) to each
bell-subscribed counterpart. `unreadCount` on that payload (and on forum
and zap payloads) is in-app notification unread plus listed inbox unread.
Push failure is logged and does not change the 200. DMs are not copied
into Notification rows.

### `POST /conversations/:id/invoice`

Bearer session required. Body `{ "sats": <int 1..10_000_000>, "text"?: "<string>" }`.
Optional `text` is the NIP-57 comment (empty = gift-only). Issues a BOLT11
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

### `GET /notifications`

Bearer session required. Lists the recipient's notifications newest-first
plus `unreadCount`. Fan-out already applied the owner's
`notificationLevel` when the row was written; this list applies the same
`notificationLevel` filter to stored rows (`notificationsMatchingLevel`
on the newest 1000). After the level filter, drop `forum_post` /
`forum_reply` whose parent message is missing or hidden; also drop
`forum_reply` when the child (`replyId`) is missing or hidden. Never drop
`moderator_appointed`. Zap only checks the parent (`replyId` is a
receipt-derived UUID, not a message id). Best-effort purge of those
message ids. Then cap the kept list at **200**. `unreadCount` is unread
among kept rows after the hidden filter (not the unfiltered matching
unread of the 1000, and not necessarily the page length). Member JSON
never includes recipient or actor account ids. Each item `type` is
`"forum_post"`, `"forum_reply"`, `"zap"`, or `"moderator_appointed"`.

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

`unreadCount` is matching unread in the newest 1000 after
`notificationsMatchingLevel`, not `store.unreadCount()`. It is not the
page length and may exceed the 200 list cap.

### `POST /notifications/read-all`

Bearer session required. Marks every unread notification for the session
account read.

Missing/invalid/expired bearer → **401** `{ "error": "Unauthorized" }`.
Store failure → **503** `{ "error": "Notifications are unavailable" }`.

Success → **Response** `200`:

```json
{ "ok": true }
```

### `POST /notifications/:id/read`

Bearer session required. `:id` is a UUID. Marks one notification read and
returns that `PublicNotification` with `readAt` set. Unknown id, another
account's notification, or a non-uuid `:id` → **404**
`{ "error": "Not found" }`. Same **401** / **503** as list.

Success → **Response** `200` (one public notification with `readAt` set).

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
- Email/password login (or any second login method)
- Internationalization of the api (responses and push payloads stay English; visitor-UI locales live in the app catalog)
- Platform custody of **receiver** funds (receiving stays LUD-16 only)
- Arbitrary LNDHub URLs (the external spend worker uses lightning.space only)
