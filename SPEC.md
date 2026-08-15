# 21.gifts — API Specification

> Canonical description of the HTTP surface implemented by this service.
> Product decisions live in [`CONCEPT.md`](./CONCEPT.md); this file owns
> request/response contracts for routes that exist in code today.

**Status**: living document. Last revised 2026-08-15.

---

## Implemented HTTP surface (normative)

The process holds all auth state in memory (`InMemoryAuthStore`). There is no
durable database yet: restarting the process clears challenges, accounts, and
sessions.

CORS allows the configured origins (`CORS_ALLOWED_ORIGINS`, or the default app
surfaces `https://app.21.gifts`, `https://dev-app.21.gifts`, and
`http://localhost:3000`) and methods `GET`, `POST`, `DELETE`, `OPTIONS`, with
headers `Authorization`, `Content-Type`, and `X-Poll-Token`. Sessions and the
poll token are sent as headers — no cookies, credentials not enabled.

Public base URLs used in examples:

| Environment | API                        | App                        |
| ----------- | -------------------------- | -------------------------- |
| PRD         | `https://api.21.gifts`     | `https://app.21.gifts`     |
| DEV         | `https://dev-api.21.gifts` | `https://dev-app.21.gifts` |

| Method | Path                    | Auth                    | Purpose                                    |
| ------ | ----------------------- | ----------------------- | ------------------------------------------ |
| GET    | `/healthz`              | none                    | Liveness                                   |
| GET    | `/info`                 | none                    | Service identity                           |
| GET    | `/auth/lnurl`           | none                    | Issue LNURL-auth challenge                 |
| GET    | `/auth/lnurl/callback`  | none (wallet)           | LUD-04 callback                            |
| GET    | `/auth/session`         | `X-Poll-Token`          | App polls for the session                  |
| GET    | `/me`                   | `Authorization: Bearer` | Account                                    |
| POST   | `/me/lightning-address` | Bearer                  | Link/replace receiver address (unverified) |
| DELETE | `/me/lightning-address` | Bearer                  | Unlink address                             |

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

| Field                      | Type           | Meaning                                             |
| -------------------------- | -------------- | --------------------------------------------------- |
| `id`                       | string         | Opaque account id                                   |
| `linkingKey`               | string         | Wallet LNURL-auth linking key (hex)                 |
| `role`                     | string         | `basis` or `moderator`                              |
| `lightningAddress`         | string \| null | Linked LUD-16 address, or `null`                    |
| `lightningAddressVerified` | boolean        | Proof-of-control flag (always `false` until verify) |
| `createdAt`                | number         | Creation time (epoch ms)                            |

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
`GET /me`). `lightningAddressVerified` is always reset to `false`. There is
no proof-of-control in this step — a wrong address is self-punishing (gifts
go elsewhere).

### `DELETE /me/lightning-address`

Unlink the receiver Lightning Address.

Missing/invalid bearer → **Response** `401` `{ "error": "Unauthorized" }`.

Success → **Response** `200` with the updated account:

- `lightningAddress`: `null`
- `lightningAddressVerified`: `false`

---

## Not implemented (v1, decided in CONCEPT — no HTTP paths)

The following are decided product capabilities for v1 (see `CONCEPT.md`) but
are **not** exposed as HTTP routes in this codebase yet. Paths and JSON for
these land in the PR that implements them; this file is updated then. Do not
treat the list below as inventing endpoints.

**Receiver address verification (micro-payment + LUD-12 nonce).** The
verified badge requires proof of control: the api sends a few sats with a
one-time nonce in the LNURL-pay comment; the user enters the nonce from the
wallet history. Linking via `POST /me/lightning-address` does not verify.

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

**Durable persistence (Postgres) and a readiness probe.** Auth and future data need a
durable store; a readiness probe that checks downstream dependencies is
planned alongside that. Today only `/healthz` (liveness) exists.

**Moderator-only endpoints.** Content hide/unhide and related Moderator
actions. Role values exist on the account model; no moderator routes yet.

---

## Out of scope for v1

- Passkey + PRF + NIP-06 user-owned keys (non-custodial phase)
- Email/password login (or any second login method)
- Internationalization (English only)
- Platform custody of **receiver** funds (receiving stays LUD-16 only)
- Arbitrary LNDHub URLs (only `lightning.space` when donor upgrade lands)
