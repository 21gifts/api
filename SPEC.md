# 21.gifts — API Specification

> Canonical description of the HTTP surface implemented by this service.
> Product decisions live in [`CONCEPT.md`](./CONCEPT.md); this file owns
> request/response contracts for routes that exist in code today.

**Status**: living document. Last revised 2026-08-29 (private in-app `POST /contact` + `GET /debug/contacts`; `POST /me/lightning-address` live-resolves and requires zap metadata; invoice limiter after payable checks; public forum `GET/POST /messages` with `sats`/`payable`; worker indexes kind:9735 zap receipts onto `sats`; `POST /messages/:id/invoice` NIP-57 zap; SQL boot requires `NOSTR_NSEC_KEK`; passkey-only login; gift stats BTC + historical USD via Coinbase daily close; `GET /gifts?day=`).

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
BTC-USD daily close from Coinbase Exchange (persisted in `btc_usd_daily`).
GET fetches Coinbase only for missing gift days, UTC-today when `fetched_at`
is older than one hour, and a past day whose `fetched_at` is still on that
same UTC calendar day (intraday print not yet the settled close). Settled
stored days are not re-fetched. A missing rate after ensure/fetch is **503**.

Lightning Address verification HTTP routes are implemented. A live
verification payment requires an injected invoice payer; the default
`UnconfiguredInvoicePayer` makes start verification return **503**. Public
`GET /lightning-address` resolves LUD-16 metadata with an in-memory cache; it
does not fetch or pay invoices.

Spend-worker invoice routes (`POST /invoices`, `POST /invoices/proof`) fetch a
BOLT11 via LNURL-pay and accept a preimage proof. They require
`SPEND_API_TOKEN`; when it is unset the routes return **503** and the process
still boots. This service does not pay invoices (no LNDHub client). A matching
proof inserts an outbound row into `gift` when `DATABASE_URL` is set (no-op
without it) so `GET /gifts/stats` and `GET /gifts?day=` include the payment. Insert failure logs
`gifts.record_failed` and still returns **200**.

CORS allows the configured origins (`CORS_ALLOWED_ORIGINS`, or the default
surfaces `https://21.gifts`, `https://dev.21.gifts`, `https://app.21.gifts`,
`https://dev-app.21.gifts`, and `http://localhost:3000`) and methods `GET`,
`POST`, `DELETE`, `OPTIONS`, with headers `Authorization` and `Content-Type`.
Sessions are sent as `Authorization: Bearer` headers — no cookies,
credentials not enabled.

Public base URLs used in examples:

| Environment | API                        | App                    |
| ----------- | -------------------------- | ---------------------- |
| PRD         | `https://api.21.gifts`     | `https://21.gifts`     |
| DEV         | `https://dev-api.21.gifts` | `https://dev.21.gifts` |

| Method | Path                                         | Auth                     | Purpose                                  |
| ------ | -------------------------------------------- | ------------------------ | ---------------------------------------- |
| GET    | `/healthz`                                   | none                     | Liveness                                 |
| GET    | `/info`                                      | none                     | Service identity                         |
| GET    | `/favicon.ico`                               | none                     | Brand mark (favicon)                     |
| GET    | `/favicon.svg`                               | none                     | Brand mark (SVG favicon)                 |
| GET    | `/apple-touch-icon.png`                      | none                     | Brand mark (Apple touch icon)            |
| POST   | `/auth/passkey/register/begin`               | none                     | Issue WebAuthn creation options          |
| POST   | `/auth/passkey/register/finish`              | none                     | Verify attestation, issue session        |
| POST   | `/auth/passkey/authenticate/begin`           | none                     | Issue WebAuthn request options           |
| POST   | `/auth/passkey/authenticate/finish`          | none                     | Verify assertion, issue session          |
| GET    | `/me`                                        | `Authorization: Bearer`  | Account                                  |
| POST   | `/me/name`                                   | Bearer                   | Set/replace display name                 |
| POST   | `/me/forum-laws-dismissed`                   | Bearer                   | Dismiss welcome-forum living-room laws   |
| POST   | `/me/lightning-address`                      | Bearer                   | Link/replace after live LNURL resolve    |
| DELETE | `/me/lightning-address`                      | Bearer                   | Unlink address                           |
| POST   | `/me/lightning-address/verification`         | Bearer                   | Start address proof-of-control payment   |
| POST   | `/me/lightning-address/verification/confirm` | Bearer                   | Confirm nonce from wallet history        |
| GET    | `/messages`                                  | Bearer                   | List public forum thread                 |
| POST   | `/messages`                                  | Bearer                   | Post `{ text }` to the public forum      |
| POST   | `/messages/:id/invoice`                      | Bearer                   | NIP-57 zap / BOLT11                      |
| POST   | `/contact`                                   | Bearer                   | Send private in-app contact `{ text }`   |
| GET    | `/lightning-address`                         | none                     | Resolve LUD-16 metadata (cached)         |
| GET    | `/debug/accounts`                            | `Authorization: Bearer`  | Operator account listing (`DEBUG_TOKEN`) |
| GET    | `/debug/contacts`                            | `Authorization: Bearer`  | Operator contact listing (`DEBUG_TOKEN`) |
| GET    | `/gifts`                                     | none                     | Outbound gifts for one UTC day (`?day=`) |
| GET    | `/gifts/stats`                               | none                     | Aggregated outbound gift statistics      |
| POST   | `/invoices`                                  | Bearer `SPEND_API_TOKEN` | Fetch a recipient BOLT11 (LNURL-pay)     |
| POST   | `/invoices/proof`                            | Bearer `SPEND_API_TOKEN` | Accept payment preimage as proof         |

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

Starts a discoverable-credential registration. No body. Does not persist an
account until finish.

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
account UUID encoded as UTF-8. The process still boots without
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

| Status | Body                                                                  | When                                                                |
| ------ | --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 500    | `{ "error": "Server auth is not configured" }`                        | RP ID missing, not on the allowlist, or no matching origin          |
| 400    | `{ "error": "Expected a JSON body with challengeId and credential" }` | Body parse fail                                                     |
| 400    | `{ "error": "Unknown or expired challenge" }`                         | Unknown `challengeId`                                               |
| 400    | `{ "error": "Challenge expired" }`                                    | Past challenge TTL                                                  |
| 400    | `{ "error": "Challenge already used" }`                               | Finish already attempted; challenge is consumed before verification |
| 400    | `{ "error": "Wrong challenge type" }`                                 | Challenge is not `register`                                         |
| 400    | `{ "error": "Invalid origin" }`                                       | Missing or disallowed `Origin`                                      |
| 400    | `{ "error": "Invalid passkey" }`                                      | Attestation verify failed or duplicate credential                   |

**Response** `200`:

```json
{
  "token": "<hex>",
  "account": {
    "id": "<uuid>",
    "linkingKey": null,
    "role": "basis",
    "name": null,
    "lightningAddress": null,
    "lightningAddressVerified": false,
    "forumLawsDismissed": false,
    "createdAt": 0
  }
}
```

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
not stored. Success body matches register finish (`linkingKey` is whatever
the account currently has).

### `GET /me`

Returns the account bound to the bearer session.

Missing or invalid bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

**Response** `200`:

```json
{
  "id": "<uuid>",
  "linkingKey": "<hex>",
  "role": "basis",
  "name": null,
  "lightningAddress": null,
  "lightningAddressVerified": false,
  "forumLawsDismissed": false,
  "createdAt": 0
}
```

| Field                      | Type           | Meaning                                                                 |
| -------------------------- | -------------- | ----------------------------------------------------------------------- |
| `id`                       | string         | Opaque account id                                                       |
| `linkingKey`               | string \| null | Historical LNURL-auth linking key (hex), or `null` for passkey accounts |
| `role`                     | string         | `basis` or `moderator`                                                  |
| `name`                     | string \| null | Display name, or `null` until set                                       |
| `lightningAddress`         | string \| null | Linked LUD-16 address, or `null`                                        |
| `lightningAddressVerified` | boolean        | Proof-of-control flag (`true` only after confirm)                       |
| `forumLawsDismissed`       | boolean        | `true` after the welcome-forum living-room laws hint was dismissed      |
| `createdAt`                | number         | Creation time (epoch ms)                                                |

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
`GET /me`). The stored value is trimmed. Names are not unique.

### `POST /me/forum-laws-dismissed`

Mark the welcome-forum living-room laws hint as dismissed. No body.

Missing/invalid bearer → **Response** `401` `{ "error": "Unauthorized" }`.

Success → **Response** `200` with the updated account (same shape as
`GET /me`), with `forumLawsDismissed: true`. Already-dismissed accounts return
the same shape without a second write (idempotent). There is no un-dismiss.

### `POST /me/lightning-address`

Link or replace the receiver Lightning Address. After the LUD-16 shape check,
the api live-resolves the well-known LNURL-pay metadata and requires zap
support (`allowsNostr === true` and a non-empty `nostrPubkey`). Placeholder or
unreachable addresses are rejected and not stored. Body:

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

Well-known resolve fails, or metadata lacks zap support → **Response** `400`
(account unchanged; logs `account.lightning_address.resolve_failed`):

```json
{ "error": "Lightning Address could not be resolved" }
```

Success → **Response** `200` with the updated account (same shape as
`GET /me`). `lightningAddressVerified` is always reset to `false`, and any
pending verification for the account is cleared. There is no proof-of-control
in this step — use `POST /me/lightning-address/verification` for that.

### `DELETE /me/lightning-address`

Unlink the receiver Lightning Address. Also clears any pending verification
for the account.

Missing/invalid bearer → **Response** `401` `{ "error": "Unauthorized" }`.

Success → **Response** `200` with the updated account:

- `lightningAddress`: `null`
- `lightningAddressVerified`: `false`

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
      "lightningAddress": null,
      "lightningAddressVerified": false,
      "forumLawsDismissed": false,
      "createdAt": 0
    }
  ]
}
```

Accounts are ordered by `createdAt` ascending, then `id`. An empty store
returns `"accounts": []`.

Environment:

| Variable       | Meaning                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `DATABASE_URL` | When set, auth state is stored in Postgres; when unset, in-memory only. |
| `DEBUG_TOKEN`  | Operator bearer for this route. Unset → 503; process still boots.       |

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

### `GET /gifts`

Public list of outbound gifts for one UTC calendar day. Query `day=YYYY-MM-DD`.
No auth. The body never includes invoices, fees, or wallet identifiers.

Missing, blank, or impossible `day` (`2026-02-31`) → **400**
`{ "error": "Expected a UTC day (YYYY-MM-DD)" }`.

When `DATABASE_URL` is unset the in-memory gift store is empty — **200** with
zeros, `gifts: []`, and `fx` (no Coinbase). When gifts exist for that day, the
api ensures a BTC-USD close for that UTC day and converts each gift at **that
day's** close. An empty matching set is 200 without Coinbase. A query failure
or a still-missing rate is **503**.

**Response** `200` (empty day):

```json
{
  "day": "2026-06-01",
  "giftCount": 0,
  "totalSats": 0,
  "totalBtc": "0.00000000",
  "totalUsd": "0.00",
  "gifts": [],
  "fx": {
    "quote": "BTC-USD",
    "dayBasis": "utc",
    "source": "coinbase-exchange-daily-close"
  }
}
```

**Response** `200` (one gift):

```json
{
  "day": "2026-06-01",
  "giftCount": 1,
  "totalSats": 500,
  "totalBtc": "0.00000500",
  "totalUsd": "0.50",
  "gifts": [
    {
      "paidAt": "2026-06-01T08:00:00.000Z",
      "amountSats": 500,
      "amountBtc": "0.00000500",
      "amountUsd": "0.50",
      "recipient": "alice"
    }
  ],
  "fx": {
    "quote": "BTC-USD",
    "dayBasis": "utc",
    "source": "coinbase-exchange-daily-close"
  }
}
```

| Field       | Type                                                        | Meaning                                                      |
| ----------- | ----------------------------------------------------------- | ------------------------------------------------------------ |
| `day`       | string                                                      | UTC `YYYY-MM-DD` of the query                                |
| `giftCount` | number                                                      | Number of gifts that UTC day                                 |
| `totalSats` | number                                                      | Sum of gift amounts (sats; fees excluded)                    |
| `totalBtc`  | string                                                      | `totalSats` as BTC with eight decimals                       |
| `totalUsd`  | string                                                      | Sum of per-gift USD at **this** day's close (`"0.50"`)       |
| `gifts`     | `{ paidAt, amountSats, amountBtc, amountUsd, recipient }[]` | Ordered by `paidAt` ascending, then `recipient`              |
| `fx`        | `{ quote, dayBasis, source }`                               | Always present; Coinbase Exchange daily close, UTC day basis |

`gifts[]` item:

| Field        | Type   | Meaning                                   |
| ------------ | ------ | ----------------------------------------- |
| `paidAt`     | string | ISO-8601 instant (`toISOString`, UTC `Z`) |
| `amountSats` | number | Gift amount in sats                       |
| `amountBtc`  | string | Same amount as BTC with eight decimals    |
| `amountUsd`  | string | USD at this UTC day's close (`"0.50"`)    |
| `recipient`  | string | Recipient handle (`recipient_wos_user`)   |

**Response** `503`: `{ "error": "Gift stats are unavailable" }`.

### `GET /gifts/stats`

Public aggregated outbound gift statistics. No auth. The body never includes
invoices, fees, or wallet identifiers.

When `DATABASE_URL` is unset the in-memory gift and FX stores are empty —
**200** with zeros, empty series, `totalBtc` `"0.00000000"`, `totalUsd`
`"0.00"`, and `fx` present (no Coinbase call). When it is set, the process
queries the `gift` table (`paid_at`, `amount_sats`, `recipient_wos_user`
only) and ensures a BTC-USD daily close for each gift's UTC calendar day
(from `btc_usd_daily`, fetching Coinbase only for missing days / stale
UTC-today / after-midnight finalize of an intraday print). Each gift's sats
are converted at **that day's** close (not spot). Gap days in
`spendOverTime` are zero sats/BTC/USD and need no rate. Gap months in
`byMonth` are zero sats/BTC/USD and need no rate.
A query failure or a still-missing rate after ensure is **503**.

Optional query `recipient` filters to one Wallet of Satoshi handle
(case-insensitive). The value is trimmed first. When the trimmed value
contains `@` after the first character, the local-part before `@` is used;
otherwise the whole trimmed string is the handle. Missing or blank
(after trim) `recipient` is unfiltered.
An unknown handle is empty **200** (zeros, `fx` present) without a Coinbase
call. Rates are ensured only for the selected gifts' UTC days.

**Response** `200`:

```json
{
  "totalSats": 0,
  "totalBtc": "0.00000000",
  "totalUsd": "0.00",
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
    "source": "coinbase-exchange-daily-close"
  }
}
```

| Field            | Type                                                                      | Meaning                                                         |
| ---------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `totalSats`      | number                                                                    | Sum of gift amounts (sats; fees excluded)                       |
| `totalBtc`       | string                                                                    | `totalSats` as BTC with eight decimals                          |
| `totalUsd`       | string                                                                    | Sum of per-gift USD at each gift's UTC-day close (`"1234.56"`)  |
| `giftCount`      | number                                                                    | Number of outbound gifts                                        |
| `recipientCount` | number                                                                    | Distinct recipient handles                                      |
| `firstPaidAt`    | string or null                                                            | ISO-8601 of the earliest gift                                   |
| `lastPaidAt`     | string or null                                                            | ISO-8601 of the latest gift                                     |
| `spendOverTime`  | `{ day, sats, cumulativeSats, btc, cumulativeBtc, usd, cumulativeUsd }[]` | UTC days from first through last; gaps are zero sats/BTC/USD    |
| `byRecipient`    | `{ recipient, giftCount, sats, btc, usd }[]`                              | Sorted by sats descending, then name                            |
| `byMonth`        | `{ month, giftCount, sats, btc, usd }[]`                                  | UTC YYYY-MM from first through last; gaps are zero sats/BTC/USD |
| `fx`             | `{ quote, dayBasis, source }`                                             | Always present; Coinbase Exchange daily close, UTC day basis    |

**Response** `503`:

```json
{ "error": "Gift stats are unavailable" }
```

### `POST /invoices`

Spend-worker invoice fetch. The api resolves LUD-16, GETs the LNURL-pay
callback, decodes the BOLT11, and stores `{ id, pr, paymentHash }` in memory.
It does not pay.

**Body:**

```json
{ "address": "name@domain.tld", "amountMsat": 100000, "comment": "optional" }
```

`comment` is optional and at most 255 characters. `amountMsat` must be an
integer in `1000..10000000000`.

When `SPEND_API_TOKEN` is unset or blank:

**Response** `503`:

```json
{ "error": "Spend invoices are not configured" }
```

Missing or wrong `Authorization: Bearer` → **401** `{ "error": "Unauthorized" }`.

Bad JSON, `amountMsat` outside `1000..10000000000`, or `comment` longer than
255 → **400**
`{ "error": "Expected a JSON body with address and amountMsat" }`.

Invalid Lightning Address → **400**
`{ "error": "Not a valid Lightning Address (expected name@domain)" }`.

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
handle from the invoice address, description `21gifts daily`,
`source_wallet` `lightning.space`. Without SQL the recorder is a no-op.
Insert errors log `gifts.record_failed` and do not change the HTTP
response.

Success → **Response** `200`:

```json
{ "status": "paid", "id": "<id>", "paymentHash": "<64 hex>" }
```

### `GET /messages`

Public member forum thread. Bearer session required. Returns newest messages
first (`createdAt` descending, then `id`), capped at **200**. This is the
latest-200 **window** on the wire; clients must render the thread as a
**messenger group** (oldest at the top, newest at the bottom above the
composer), reversing the array for display. Each message exposes the author
**name snapshotted at post time**, `text`, ISO-8601 `createdAt`, `sats`
(validated Lightning receipts on that note, default 0), and `payable` (true
when the note is signed and the author has a Lightning Address). `accountId`
and Nostr event ids are never included in the JSON.

Missing/invalid/expired bearer → **Response** `401`:

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
  "messages": [
    {
      "id": "<uuid>",
      "name": "Ada",
      "text": "Thank you!",
      "createdAt": "2026-08-28T12:00:00.000Z",
      "sats": 0,
      "payable": false
    }
  ]
}
```

An empty thread is **200** with `"messages": []`. When `DATABASE_URL` is
unset the default in-memory store starts empty; when set, rows come from
Postgres `message`.

The nostr worker, each tick, queries zap relays (space plus the public
list, including when `NOSTR_PUBLISH_PUBLIC` is unset) for kind:9735
receipts whose `e` tag matches a recent note `event_id`. A receipt is
indexed when the signer pubkey matches the author's LNURL-pay
`nostrPubkey`, the bolt11 amount is at least 1 sat, and the receipt id
is new. Indexed receipts increment that row's `sats` (GET /messages then
returns the new total). Kind:1 EVENT frames published to relays are JSON
objects, not JSON strings.

### `POST /messages`

Post to the public member forum. Bearer session required. Body:

```json
{ "text": "…" }
```

The account must already have a non-blank display name. The api stores a
**name snapshot** (trimmed account name at post time), the normalised text,
and a timestamp. Text is trimmed; length must be **1–500** characters.
Newlines (`\n`, `\r`) are allowed; other C0 controls and DEL are rejected.
The **200** body is the public message object itself (not wrapped in
`{ messages }`). No `accountId` in the JSON. `sats` is 0 and `payable` is
false until the worker signs the note. Over-limit posters get **429**
`{ "error": "Too many messages" }` with `Retry-After: 10` (1/10s, 6/h,
20/UTC-day). The worker signs a top-level kind:1 and fans out when
`NOSTR_PUBLISH=1`.

Missing/invalid/expired bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

Body is not JSON with a `text` string → **Response** `400`:

```json
{ "error": "Expected a JSON body with a \"text\" string" }
```

Account has no display name (null or blank after trim) → **Response** `400`:

```json
{ "error": "Set a name before posting" }
```

Text empty, longer than 500 after trim, or contains a disallowed control →
**Response** `400`:

```json
{ "error": "Text must be 1–500 characters" }
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
  "payable": false
}
```

### `POST /messages/:id/invoice`

Signed-in pay-on-note. Bearer session required. Body `{ "sats": <int ≥ 1> }`.
The api signs a NIP-57 zap request with the **payer** key and returns a BOLT11
invoice for the **author** Lightning Address. It does **not** increment
`sats` (that happens when a validated kind:9735 receipt is indexed).

Success → **Response** `200`:

```json
{ "pr": "lnbc…", "amountSats": 21 }
```

Missing Bearer → **401** `{ "error": "Unauthorized" }`.
Malformed body → **400** `{ "error": "Expected a JSON body with a positive \"sats\" integer" }`.
Unknown id → **404** `{ "error": "Not found" }`. Unsigned note, author without a Lightning Address, or missing recipient pubkey →
**400** `{ "error": "This message cannot be paid yet" }`. Missing KEK →
**503** `{ "error": "Messages are unavailable" }` (before the limiter).
Over-limit → **429** `{ "error": "Too many payments" }` (`Retry-After: 10`) —
checked only after auth, amount, payable, and KEK checks succeed, so early
400/404/401/503 do not consume quota. LNURL/zap or sign failure after the
limiter still counts. LNURL/zap failure →
**400** `{ "error": "Could not start the Bitcoin payment" }`. Keygen/sign failure →
**503** `{ "error": "Messages are unavailable" }`.

### `POST /contact`

Private in-app contact mailbox. Bearer session required. Body:

```json
{ "text": "…" }
```

The account must already have a non-blank display name. The api stores a
**name snapshot** (trimmed account name at post time), the normalised text,
and a timestamp. Text rules match the public forum (`normalizeForumText`):
trimmed length **1–500**; newlines (`\n`, `\r`) allowed; other C0 controls
and DEL rejected. The **200** body is the public contact object itself (not
wrapped). No `accountId` in the member-facing JSON. Contacts are **never**
listed publicly — operators read them via `GET /debug/contacts`. No email,
no DMs, no Nostr fan-out.

Missing/invalid/expired bearer → **Response** `401`:

```json
{ "error": "Unauthorized" }
```

Body is not JSON with a `text` string → **Response** `400`:

```json
{ "error": "Expected a JSON body with a \"text\" string" }
```

Account has no display name (null or blank after trim) → **Response** `400`:

```json
{ "error": "Set a name before posting" }
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

---

## Not implemented (v1, decided in CONCEPT — no HTTP paths)

The following are decided product capabilities for v1 (see `CONCEPT.md`) but
are **not** exposed as HTTP routes in this codebase yet. Paths and JSON for
these land in the PR that implements them; this file is updated then. Do not
treat the list below as inventing endpoints.

**Donor LNDHub credentials.** Paying uses lightning.space LNDHub in the
external spend worker, not encrypted storage in this api. No `/me/donor`
deposit route.

**Recurring daily gifts UI.** Donors will configure fixed USD amounts to
recipients. Invoice fetch + preimage proof for the external payer is
`POST /invoices` / `POST /invoices/proof`. No `/me/recurring` or in-process
scheduler.

**Feed / discovery / campaign index.** Paginated read endpoints over indexed
NOSTR events (profiles, campaigns, replies). Not wired yet. Custodial nsec
and server-side kind:1 / zap signing ship in this version (KEK + worker).

**Readiness probe.** `/healthz` remains liveness-only. A readiness check of
downstream dependencies is still planned. The LUD-16 metadata cache on
`GET /lightning-address` is in-memory only. Gift statistics read Postgres
when `DATABASE_URL` is set.

**Moderator-only endpoints.** Content hide/unhide and related Moderator
actions. Role values exist on the account model; `GET /debug/accounts` is
an operator token route, not a moderator session.

---

## Out of scope for v1

- Passkey + PRF + NIP-06 user-owned keys (non-custodial phase)
- Email/password login (or any second login method)
- Internationalization (English only)
- Platform custody of **receiver** funds (receiving stays LUD-16 only)
- Arbitrary LNDHub URLs (the external spend worker uses lightning.space only)
