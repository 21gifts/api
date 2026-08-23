# Functions

## Function: buildGiftStats

- **Purpose:** Pure aggregation of outbound gifts into the public stats JSON (UTC daily series with gap days, recipients, months).
- **Inputs:** `readonly GiftRow[]` (`paidAt`, `amountSats`, `recipientWosUser`).
- **Returns / side effects:** `GiftStats`. Empty input yields zeros and empty arrays. No I/O.
- **Used by:** `giftsStatsRoutes`.

## Function: giftsStatsRoutes

- **Purpose:** Hono sub-app for `GET /gifts/stats`.
- **Inputs:** `{ store: GiftStore }`.
- **Returns / side effects:** Hono app mounted at `/gifts/stats`. Logs `gifts.stats.failed` on store errors (503).
- **Used by:** `createApp`.

## Function: InMemoryAuthStore

- **Purpose:** Process-local AuthStore: LNURL challenges, passkey challenges/credentials, accounts, sessions, verifications. Evicts expired challenges/sessions on write. Indexes `linkingKey` only when non-null. `listAccounts` returns every account oldest-first.
- **Inputs:** Constructor none. Methods take domain objects (`Challenge`, `PasskeyChallenge`, `PasskeyCredential`, `Account`, `Session`, `AddressVerification`). `createAccount` is a no-op when a non-null `linkingKey` already exists. `updateChallenge` / `updatePasskeyChallenge` return false when the row is missing or already consumed.
- **Returns / side effects:** Lookups return the object or `undefined`. Writes resolve when persisted. `listAccounts` returns `Account[]`.
- **Used by:** `createApp` default store; all auth/me/debug routes.

## Function: PostgresAuthStore

- **Purpose:** Durable AuthStore over Postgres (`SqlClient`). Same eviction-on-write semantics as the in-memory adapter, including passkey challenges and credentials.
- **Inputs:** Constructor takes a `SqlClient`. Methods match `AuthStore`.
- **Returns / side effects:** Parameter-bound SQL; maps snake_case rows to domain objects.
- **Used by:** `openAuthStore` when `DATABASE_URL` is set.

## Function: migrateAuthSchema

- **Purpose:** Applies `AUTH_SCHEMA_SQL` in order (`CREATE TABLE IF NOT EXISTS` plus `ALTER` backfills for existing databases).
- **Inputs:** `SqlClient`.
- **Returns / side effects:** Void; creates `account`, `auth_challenge`, `auth_session`, `address_verification`, `passkey_challenge`, `passkey_credential` and backfills `account.name` / nullable `linking_key`.
- **Used by:** `openAuthStore`.

## Function: openAuthStore

- **Purpose:** Chooses in-memory vs Postgres AuthStore from `DATABASE_URL`.
- **Inputs:** URL or blank/undefined; `createClient` factory required when the URL is set (boot supplies Bun SQL; tests inject a mock).
- **Returns / side effects:** `InMemoryAuthStore` if unset; otherwise migrate then `PostgresAuthStore`. Throws if the URL is set without a factory.
- **Used by:** `src/index.ts` boot.

## Function: bearerMatchesDebugToken

- **Purpose:** Constant-time compare of `DEBUG_TOKEN` against `Authorization: Bearer`.
- **Inputs:** Configured token (non-empty) and raw header or `undefined`.
- **Returns / side effects:** `true` only on an exact Bearer match (trim on the presented token).
- **Used by:** `debugRoutes`.

## Function: compareAccountsForList

- **Purpose:** Sort key for `listAccounts`: older `createdAt` first, then `id` ascending.
- **Inputs:** Two `Account` values.
- **Returns / side effects:** Negative / positive / 0.
- **Used by:** `InMemoryAuthStore.listAccounts`.

## Function: debugRoutes

- **Purpose:** Operator listing of registered accounts.
- **Inputs:** `DebugRouteDeps`: store, optional debugToken.
- **Returns / side effects:** Hono app. 503 if token unset; 401 if bearer mismatches; 200 `{ accounts }` otherwise. Logs `debug.accounts.listed` with count, never the token.
- **Used by:** `createApp` at `/debug/accounts`.

## Function: InMemoryGiftStore

- **Purpose:** Process-local GiftStore seeded at construction. Default empty so the process boots without a database.
- **Inputs:** Optional `GiftRow[]`. `listOutbound()` copies and sorts by `paidAt`.
- **Returns / side effects:** Promise of rows. Does not mutate the seed array.
- **Used by:** `createApp` default `giftStore`.

## Function: InMemoryLnAddressCache

- **Purpose:** TTL cache for successful LUD-16 metadata resolves.
- **Inputs:** `get(address, now)`, `put(entry, now)`. TTL from `LN_ADDRESS_CACHE_TTL_MS`.
- **Returns / side effects:** `get` returns `CachedLnAddress` or `null`.
- **Used by:** `lightningAddressRoutes`.

## Function: mapGiftQueryRow

- **Purpose:** Maps a SQL `gift` row (`paid_at`, `amount_sats`, `recipient_wos_user`) onto a `GiftRow`.
- **Inputs:** `GiftQueryRow` (Date or string timestamp; numeric/string/bigint sats).
- **Returns / side effects:** `{ paidAt, amountSats, recipientWosUser }`. No I/O.
- **Used by:** Production `QueryGiftStore` query in `src/index.ts`.

## Function: QueryGiftStore

- **Purpose:** GiftStore that delegates `listOutbound` to an injected query (Postgres in production).
- **Inputs:** `() => Promise<GiftRow[]>`.
- **Returns / side effects:** The query result. Errors propagate to the route (503).
- **Used by:** `src/index.ts` when `DATABASE_URL` is set.

## Function: UnconfiguredInvoicePayer

- **Purpose:** InvoicePayer that always fails — process boots without a payer so verification returns 503 until wired.
- **Inputs:** `isConfigured()` is always false. `payInvoice(bolt11)` is the pay method.
- **Returns / side effects:** `{ ok: false, reason: 'not_configured' }` — it does not throw.
- **Used by:** Default `createApp` `invoicePayer`.

## Function: authRoutes

- **Purpose:** Hono sub-app for LNURL-auth and passkey login.
- **Inputs:** `AuthRouteDeps`: store, now, publicBaseUrl, allowedOrigins, webAuthnRpId, webAuthnRpName, passkeyCeremony.
- **Returns / side effects:** Hono app mounted at `/auth`.
- **Used by:** `createApp`.

## Function: bearerToken

- **Purpose:** Parses `Authorization: Bearer <token>`.
- **Inputs:** Header string or undefined.
- **Returns / side effects:** Token or `null`.
- **Used by:** `meRoutes`.

## Function: brandRoutes

- **Purpose:** Serves favicon.ico, favicon.svg, apple-touch-icon.png from `public/`.
- **Inputs:** `BrandRouteDeps.read`.
- **Returns / side effects:** Hono app with three GETs; 404 empty body if bytes missing.
- **Used by:** `createApp` at `/`.

## Function: claimSession

- **Purpose:** Consumes an authenticated challenge and issues a session.
- **Inputs:** `store`, `now`, `pollToken`.
- **Returns / side effects:** `SessionResult` pending/authenticated/expired/used.
- **Used by:** `GET /auth/session`.

## Function: completeCallback

- **Purpose:** Verifies wallet sig+key against k1, upserts account, marks challenge authenticated.
- **Inputs:** `store`, `now`, `{ k1, sig, key }`.
- **Returns / side effects:** `{ ok: true, accountId, firstLogin }` or `{ ok: false, reason }`.
- **Used by:** `GET /auth/lnurl/callback`.

## Function: confirmVerification

- **Purpose:** Checks the nonce the user read from the wallet payment comment (`21gifts <hex>`), not a nonce returned by startVerification.
- **Inputs:** `store`, `now`, `account`, `nonceRaw`.
- **Returns / side effects:** Success marks the address verified, or a `ConfirmVerificationCode`.
- **Used by:** `POST /me/lightning-address/verification/confirm`.

## Function: createApp

- **Purpose:** Wires CORS, requestLog, brand, health, info, auth, me, lightning-address, `/debug/accounts`, and gifts/stats.
- **Inputs:** Optional `AppDeps` (store, clock, payer, fetch, cache, readBrand, origins, publicBaseUrl, `debugToken`, giftStore).
- **Returns / side effects:** Hono app. Used by Bun.serve in `index.ts` and by tests via `app.request()`.
- **Used by:** Boot path and every HTTP test.

## Function: encodeLnurl

- **Purpose:** bech32-encodes an HTTPS URL as `lnurl1…` (LUD-01).
- **Inputs:** `url` string.
- **Returns / side effects:** Bech32 LNURL.
- **Used by:** `startChallenge`.

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

- **Purpose:** Authenticated account routes (name, Lightning Address, verification).
- **Inputs:** `MeRouteDeps` store, now, payer, fetchImpl.
- **Returns / side effects:** Hono at `/me`.
- **Used by:** `createApp`.

## Function: normalizeDisplayName

- **Purpose:** Trim and validate an account display name (1–80 characters, no C0/DEL controls).
- **Inputs:** `raw` string.
- **Returns / side effects:** Trimmed name or `null`.
- **Used by:** `POST /me/name`.

## Function: normalizeLightningAddress

- **Purpose:** Lowercases and validates `local@domain` LUD-16 shape.
- **Inputs:** `raw` string.
- **Returns / side effects:** Canonical address or `null`.
- **Used by:** me lightning-address POST and public resolve.

## Function: normalizePublicBaseUrl

- **Purpose:** Trims trailing slash; rejects empty.
- **Inputs:** raw env string or undefined.
- **Returns / side effects:** Base URL or `null`. Auth routes then respond HTTP 500 `Server auth is not configured`.
- **Used by:** `startChallenge` via auth routes.

## Function: parseBindAddr

- **Purpose:** Parses `host:port` bind spec.
- **Inputs:** `addr` string.
- **Returns / side effects:** `{ host, port }`. Throws on garbage.
- **Used by:** `index.ts` boot.

## Function: randomHex

- **Purpose:** CSPRNG hex for k1 / poll tokens / session tokens / nonces.
- **Inputs:** `byteLength`.
- **Returns / side effects:** Lowercase hex.
- **Used by:** Auth challenge + session + verification.

## Function: readPublicBrandFile

- **Purpose:** Reads `public/<name>` relative to a root directory.
- **Inputs:** `BrandFileName` and optional `root` (default `process.cwd()`).
- **Returns / side effects:** `Uint8Array` or `null` if missing. Does not change the process cwd.
- **Used by:** Default `brandRoutes` reader.

## Function: requestLog

- **Purpose:** Hono middleware: `http.request` JSON after the handler. Skips `/healthz` and OPTIONS. Never logs the query string.
- **Inputs:** None.
- **Returns / side effects:** `MiddlewareHandler`.
- **Used by:** `createApp`.

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
- **Returns / side effects:** Callback URL + min/max sendable or error.
- **Used by:** `lightningAddressRoutes`, `requestPayInvoice`.

## Function: resolveSession

- **Purpose:** Looks up a bearer session; rejects expired.
- **Inputs:** `store`, `now`, `token`.
- **Returns / side effects:** `Account` or `null`.
- **Used by:** `meRoutes`.

## Function: startChallenge

- **Purpose:** Mints k1, poll token, LNURL pointing at `{base}/auth/lnurl/callback`.
- **Inputs:** `store`, `now`, `baseUrl`.
- **Returns / side effects:** `StartChallengeResult`.
- **Used by:** `GET /auth/lnurl`.

## Function: startVerification

- **Purpose:** Pays a 1-sat LNURL-pay invoice to the linked address and stores a nonce.
- **Inputs:** `StartVerificationArgs` (store, payer, fetch, accountId, now).
- **Returns / side effects:** Sent result or a `StartVerificationCode` (no address, payer down, …).
- **Used by:** `POST /me/lightning-address/verification`.

## Function: verifyAuthSig

- **Purpose:** secp256k1 verify: DER sig of k1 by linkingKey.
- **Inputs:** `k1`, `sig`, `key` hex.
- **Returns / side effects:** `true` iff the wallet signed this challenge.
- **Used by:** `completeCallback`.

## Function: credentialIdFrom

- **Purpose:** Reads the WebAuthn credential `id` from an untyped finish body.
- **Inputs:** Unknown `credential` JSON.
- **Returns / side effects:** Non-empty string id, or `null`.
- **Used by:** `finishPasskeyAuthentication`.

## Function: expectedOriginsForRpId

- **Purpose:** Filters CORS origins to those whose hostname equals the RP ID or is a subdomain of it.
- **Inputs:** `rpId`, `allowedOrigins`.
- **Returns / side effects:** Matching origin strings; invalid URLs dropped.
- **Used by:** `resolveWebAuthnConfig`.

## Function: finishPasskeyAuthentication

- **Purpose:** Verifies a discoverable-credential assertion, updates signCount, issues a session.
- **Inputs:** store, ceremony, config, now, Origin, challengeId, credential.
- **Returns / side effects:** `{ ok: true, value: { token, account } }` or `{ ok: false, error }`.
- **Used by:** `POST /auth/passkey/authenticate/finish`.

## Function: finishPasskeyRegistration

- **Purpose:** Verifies an attestation, creates a `linkingKey: null` account plus credential, issues a session.
- **Inputs:** store, ceremony, config, now, Origin, challengeId, credential.
- **Returns / side effects:** `{ ok: true, value: { token, account } }` or `{ ok: false, error }`.
- **Used by:** `POST /auth/passkey/register/finish`.

## Function: issueSession

- **Purpose:** Mints a bearer session token for an already-authenticated account.
- **Inputs:** `store`, `now`, `account`.
- **Returns / side effects:** `{ token, account }`; writes the session row.
- **Used by:** `claimSession`, passkey finish paths.

## Function: normalizeWebAuthnRpId

- **Purpose:** Trims `WEBAUTHN_RP_ID`; missing/blank is `null` (fail closed on passkey routes).
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

- **Purpose:** Mints WebAuthn creation options and a pending account UUID (row created only on finish).
- **Inputs:** store, ceremony, config, now.
- **Returns / side effects:** `{ challengeId, options }`; persists a passkey challenge.
- **Used by:** `POST /auth/passkey/register/begin`.
