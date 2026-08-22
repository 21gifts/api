# 21.gifts — API Specification

> Canonical description of the HTTP surface implemented by this service.
> Product decisions live in [`CONCEPT.md`](./CONCEPT.md); this file owns
> request/response contracts for routes that exist in code today.

**Status**: living document. Last revised 2026-08-22 (apex origin).

---

## Implemented HTTP surface (normative)

The process holds all auth state in memory (`InMemoryAuthStore`). There is no
durable database yet: restarting the process clears challenges, accounts,
sessions, and pending address verifications.

Lightning Address verification HTTP routes are implemented. A live
verification payment requires an injected invoice payer; the default
`UnconfiguredInvoicePayer` makes start verification return **503**. Public
`GET /lightning-address` resolves LUD-16 metadata with an in-memory cache; it
does not fetch or pay invoices. No BOLT11 decoder and no LNDHub /
lightning.space payer are wired in this service yet.

CORS allows the configured origins (`CORS_ALLOWED_ORIGINS`, or the default
surfaces `https://21.gifts`, `https://dev.21.gifts`, `https://app.21.gifts`,
`https://dev-app.21.gifts`, and `http://localhost:3000`) and methods `GET`,
`POST`, `DELETE`, `OPTIONS`, with headers `Authorization`, `Content-Type`, and
`X-Poll-Token`. Sessions and the poll token are sent as headers — no cookies,
credentials not enabled.

Public base URLs used in examples:

| Environment | API                        | App                    |
| ----------- | -------------------------- | ---------------------- |
| PRD         | `https://api.21.gifts`     | `https://21.gifts`     |
| DEV         | `https://dev-api.21.gifts` | `https://dev.21.gifts` |

| Method | Path                                         | Auth                    | Purpose                                    |
| ------ | -------------------------------------------- | ----------------------- | ------------------------------------------ |
| GET    | `/healthz`                                   | none                    | Liveness                                   |
| GET    | `/info`                                      | none                    | Service identity                           |
| GET    | `/favicon.ico`                               | none                    | Brand mark (favicon)                       |
| GET    | `/favicon.svg`                               | none                    | Brand mark (SVG favicon)                   |
| GET    | `/apple-touch-icon.png`                      | none                    | Brand mark (Apple touch icon)              |
| GET    | `/auth/lnurl`                                | none                    | Issue LNURL-auth challenge                 |
| GET    | `/auth/lnurl/callback`                       | none (wallet)           | LUD-04 callback                            |
| GET    | `/auth/session`                              | `X-Poll-Token`          | App polls for the session                  |
| GET    | `/me`                                        | `Authorization: Bearer` | Account                                    |
| POST   | `/me/lightning-address`                      | Bearer                  | Link/replace receiver address (unverified) |
| DELETE | `/me/lightning-address`                      | Bearer                  | Unlink address                             |
| POST   | `/me/lightning-address/verification`         | Bearer                  | Start address proof-of-control payment     |
| POST   | `/me/lightning-address/verification/confirm` | Bearer                  | Confirm nonce from wallet history          |
| GET    | `/lightning-address`                         | none                    | Resolve LUD-16 metadata (cached)           |

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

### `GET /auth/lnurl`

Issues an LNURL-auth (LUD-04) challenge for the browser app. The app renders
`lnurl` as a QR / `lightning:` deep link and polls `/auth/session` with
`pollToken`.

When the public base URL is not configured:

**Response** `500`:

```json
{ "error": "Server auth is not configured" }
```

Otherwise **Response** `200` — payload from `startChallenge`:

```json
{
  "lnurl": "lnurl1…",
  "k1": "<64 hex chars>",
  "pollToken": "<64 hex chars>",
  "expiresInSeconds": 600
}
```

| Field              | Meaning                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `lnurl`            | Bech32 `lnurl1…` encoding the wallet callback URL                       |
| `k1`               | Public 32-byte challenge (hex); also embedded in the QR                 |
| `pollToken`        | Secret; the app presents it on `/auth/session` (never placed in the QR) |
| `expiresInSeconds` | Challenge TTL in seconds (currently 600)                                |

### `GET /auth/lnurl/callback`

Wallet-facing LUD-04 callback. Query parameters: `k1`, `sig`, `key`.

LUD-04 uses **HTTP 200 for both success and error**; clients must read
`status`.

Missing or invalid query (schema failure) → **Response** `200`:

```json
{ "status": "ERROR", "reason": "Missing k1, sig, or key" }
```

Failed verify (unknown/expired/used challenge, bad signature, …) →
**Response** `200`:

```json
{ "status": "ERROR", "reason": "<string from completeCallback>" }
```

Documented `reason` values from `completeCallback`:

| `reason`                       | When                                 |
| ------------------------------ | ------------------------------------ |
| `Unknown or expired challenge` | `k1` not in the store                |
| `Challenge already used`       | Challenge status is not `pending`    |
| `Challenge expired`            | Past the challenge TTL               |
| `Invalid signature`            | LUD-04 signature verification failed |

Success → **Response** `200`:

```json
{ "status": "OK" }
```

On success the account for the wallet's `linkingKey` is upserted (created as
role `basis` on first sight) and the challenge is marked authenticated.

### `GET /auth/session`

App polls after showing the QR. Authorization is the secret poll token in the
`X-Poll-Token` header (not `k1`).

Without `X-Poll-Token` → **Response** `200`:

```json
{ "status": "expired" }
```

With a token → **Response** `200` with one of the `claimSession` statuses:

| `status`        | Body shape                                                          |
| --------------- | ------------------------------------------------------------------- |
| `pending`       | `{ "status": "pending" }` — wallet has not signed yet               |
| `expired`       | `{ "status": "expired" }` — unknown token or challenge past TTL     |
| `used`          | `{ "status": "used" }` — session already claimed for this challenge |
| `authenticated` | `{ "status": "authenticated", "token": "<hex>", "account": { … } }` |

On `authenticated`, a one-time session token is minted and the challenge is
consumed. `account` is the stored account object:

```json
{
  "id": "<uuid>",
  "linkingKey": "<hex>",
  "role": "basis",
  "lightningAddress": null,
  "lightningAddressVerified": false,
  "createdAt": 0
}
```

The app then calls authenticated routes with
`Authorization: Bearer <token>`.

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
  "lightningAddress": null,
  "lightningAddressVerified": false,
  "createdAt": 0
}
```

| Field                      | Type           | Meaning                                           |
| -------------------------- | -------------- | ------------------------------------------------- |
| `id`                       | string         | Opaque account id                                 |
| `linkingKey`               | string         | Wallet LNURL-auth linking key (hex)               |
| `role`                     | string         | `basis` or `moderator`                            |
| `lightningAddress`         | string \| null | Linked LUD-16 address, or `null`                  |
| `lightningAddressVerified` | boolean        | Proof-of-control flag (`true` only after confirm) |
| `createdAt`                | number         | Creation time (epoch ms)                          |

### `POST /me/lightning-address`

Link or replace the receiver Lightning Address. Body:

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
No new environment variables; the process still boots with zero extra config.

---

## Not implemented (v1, decided in CONCEPT — no HTTP paths)

The following are decided product capabilities for v1 (see `CONCEPT.md`) but
are **not** exposed as HTTP routes in this codebase yet. Paths and JSON for
these land in the PR that implements them; this file is updated then. Do not
treat the list below as inventing endpoints.

**Donor upgrade (custodial `lndhub://` from lightning.space only).** Any
account may become a donor by depositing an LNDHub export restricted to
`lightning.space`. Credentials would be stored encrypted; arbitrary LNDHub
URLs are rejected. Not wired yet.

**Recurring daily gifts (fail-closed scheduler).** Donors configure fixed
USD amounts to recipients; a server-side scheduler resolves LUD-16, converts
USD → sats (fail-closed on bad rates), pays via stored LNDHub credentials
with per-day idempotency and caps. Not wired yet.

**Custodial per-account NOSTR identities + server-side signing.** On sign-up
the api would generate a keypair, store `nsec` encrypted, and sign that
account's events server-side. Not wired yet.

**Feed / discovery / campaign index.** Paginated read endpoints over indexed
NOSTR events (profiles, campaigns, replies). Not wired yet.

**Durable persistence (Postgres) and a readiness probe.** Auth and future data
need a durable store; a readiness probe that checks downstream dependencies is
planned alongside that. Today only `/healthz` (liveness) exists. The LUD-16
metadata cache on `GET /lightning-address` is in-memory only; a durable
Postgres cache is later.

**Moderator-only endpoints.** Content hide/unhide and related Moderator
actions. Role values exist on the account model; no moderator routes yet.

---

## Out of scope for v1

- Passkey + PRF + NIP-06 user-owned keys (non-custodial phase)
- Email/password login (or any second login method)
- Internationalization (English only)
- Platform custody of **receiver** funds (receiving stays LUD-16 only)
- Arbitrary LNDHub URLs (only `lightning.space` when donor upgrade lands)
