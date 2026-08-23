# Functions

## Function: InMemoryAuthStore

- **Purpose:** Process-local AuthStore: challenges, accounts, sessions, verifications. Evicts expired challenges/sessions on write.
- **Inputs:** Constructor none. Methods take domain objects (`Challenge`, `Account`, `Session`, `AddressVerification`).
- **Returns / side effects:** Lookups return the object or `undefined`. Writes are void.
- **Used by:** `createApp` default store; all auth/me routes.

## Function: InMemoryLnAddressCache

- **Purpose:** TTL cache for successful LUD-16 metadata resolves.
- **Inputs:** `get(address, now)`, `put(entry, now)`. TTL from `LN_ADDRESS_CACHE_TTL_MS`.
- **Returns / side effects:** `get` returns `CachedLnAddress` or `null`.
- **Used by:** `lightningAddressRoutes`.

## Function: UnconfiguredInvoicePayer

- **Purpose:** InvoicePayer that always fails — process boots without a payer so verification returns 503 until wired.
- **Inputs:** `isConfigured()` is always false. `payInvoice(bolt11)` is the pay method.
- **Returns / side effects:** `{ ok: false, reason: 'not_configured' }` — it does not throw.
- **Used by:** Default `createApp` `invoicePayer`.

## Function: authRoutes

- **Purpose:** Hono sub-app for LNURL-auth.
- **Inputs:** `AuthRouteDeps`: store, now, publicBaseUrl.
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

- **Purpose:** Wires CORS, requestLog, brand, health, info, auth, me, lightning-address.
- **Inputs:** Optional `AppDeps` (store, clock, payer, fetch, cache, readBrand, origins, publicBaseUrl).
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
