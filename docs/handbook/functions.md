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

- **Purpose:** Authenticated account routes.
- **Inputs:** `MeRouteDeps` store, now, payer, fetchImpl.
- **Returns / side effects:** Hono at `/me`.
- **Used by:** `createApp`.

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

## Function: decodeBolt11AmountSats

- **Purpose:** Decode integer satoshis from a mainnet BOLT11 amount prefix.
- **Inputs:** `bolt11` string (case-insensitive). Only `lnbc` is accepted.
- **Returns / side effects:** `{ ok: true, sats }` or `{ ok: false, reason: 'no_amount' | 'invalid' }`. No signature verify.
- **Used by:** `runDailyGifts` before Wallet of Satoshi payment.

Amount-only check so the payout worker can reject a provider invoice that does not match the intended sats.

## Function: usdToSats

- **Purpose:** Convert a USD amount to integer satoshis at a USD-per-BTC rate.
- **Inputs:** `usd`, `usdPerBtc` (both numbers).
- **Returns / side effects:** `Math.round(usd / usdPerBtc * 1e8)`.
- **Used by:** `runDailyGifts`.

## Function: fetchKrakenXbtUsd

- **Purpose:** Fetch Kraken XBTUSD last trade and corridor-check it.
- **Inputs:** Injected `fetchImpl`, inclusive `minUsd`/`maxUsd`.
- **Returns / side effects:** `{ ok: true, usdPerBtc }` or `{ ok: false, reason: 'unavailable' | 'implausible' }`. 15s timeout.
- **Used by:** `runDailyGifts`. Fail-closed: a missing or implausible rate pays nobody.

## Function: signWosRequest

- **Purpose:** HMAC-SHA256 of `endpoint + nonce + apiToken + body` for WoS POSTs.
- **Inputs:** `apiSecret`, `endpoint`, `nonce`, `apiToken`, JSON `body`.
- **Returns / side effects:** Lower-case hex digest. Never logs inputs.
- **Used by:** `WosClient.payInvoice`.

## Function: WosClient

- **Purpose:** Wallet of Satoshi REST client: GET balance, signed POST payment.
- **Inputs:** `apiToken`, `apiSecret`, injected `fetchImpl`, optional nonce factory.
- **Returns / side effects:** Balance in sats; pay result `paid` / `failed` / `uncertain`. Never logs secrets.
- **Used by:** `WosInvoicePayer` and `runDailyGifts`. Host pinned to `www.livingroomofsatoshi.com`.

## Function: WosInvoicePayer

- **Purpose:** `InvoicePayer` adapter over `WosClient` for address verification.
- **Inputs:** Constructor takes a `WosClient`. `payInvoice(bolt11)`.
- **Returns / side effects:** `isConfigured()` is true. Paid → `{ ok: true }`; failed/uncertain → `{ ok: false, reason: 'payment_failed' }`.
- **Used by:** `invoicePayerFromEnv` when WoS env is complete.

## Function: invoicePayerFromEnv

- **Purpose:** Build a payer from `WOS_API_TOKEN` / `WOS_API_SECRET`.
- **Inputs:** Env slice and `fetchImpl`.
- **Returns / side effects:** `WosInvoicePayer` or `UnconfiguredInvoicePayer`. Emits `wos.unconfigured` without secrets.
- **Used by:** Boot path in `src/index.ts`. Process still boots when unset.

## Function: parseDailyGiftsConfig

- **Purpose:** Parse operator daily-gifts env into a typed config.
- **Inputs:** Env slice. Recipients JSON in `DAILY_GIFTS_RECIPIENTS`.
- **Returns / side effects:** `{ ok: true, config }` or `{ ok: false, reason }`. No throw.
- **Used by:** `startDailyGiftsFromEnv`.

Required vars include WoS API token/secret, recipient JSON, USD cap, Kraken corridor, and `DAILY_GIFTS_LOG_PATH`. Hour defaults to 20; timezone must be Europe/Zurich.

## Function: zurichDate

- **Purpose:** Calendar date `YYYY-MM-DD` in Europe/Zurich.
- **Inputs:** Epoch milliseconds.
- **Returns / side effects:** Date string used as the idempotency day key.
- **Used by:** `runDailyGifts` and the payment log.

## Function: replayDay

- **Purpose:** Replay JSONL rows for one address on one Zurich date.
- **Inputs:** `entries`, `date`, `address`.
- **Returns / side effects:** `paid` / `uncertain` / `clear`. Dangling `sending` becomes `uncertain`; `failed` after `sending` is retryable (`clear`).
- **Used by:** `runDailyGifts` skip logic.

## Function: FileGiftLog

- **Purpose:** Append-only JSONL gift log with injected filesystem.
- **Inputs:** `{ path, fs }`. `load()` / `append(entry)`.
- **Returns / side effects:** Load returns entries or `corrupt`. Append writes one JSON line.
- **Used by:** `runDailyGifts`. Tests inject an in-memory `GiftLogFs`.

## Function: nodeGiftLogFs

- **Purpose:** Real filesystem adapter: append+fsync, mkdir, exclusive `wx` lock.
- **Inputs:** None. Methods take paths and a pid for the lock file.
- **Returns / side effects:** `readFile` returns `null` on ENOENT. `tryLock` is exclusive. `unlock` unlinks.
- **Used by:** Production `startDailyGiftsFromEnv`. Lock path is `logPath + '.lock'`.

## Function: runDailyGifts

- **Purpose:** One fail-closed daily payout run for "today" in Europe/Zurich.
- **Inputs:** `WorkerDeps` (config, payout client, fetch, log, fs, clock, `requestInvoice`).
- **Returns / side effects:** Counts plus optional `aborted`. Pays sequentially; WAL `sending` before Wallet of Satoshi payment.
- **Used by:** `startDailyGiftsScheduler` via `startDailyGiftsFromEnv`.

Aborts without new payments on lock, corrupt log, bad rate, USD cap, or insufficient balance (remaining sats + 1% headroom). LNURL/decode failures are not logged (safe retry).

## Function: nodeTimeoutSchedule

- **Purpose:** Production `setTimeout` adapter for the daily-gifts scheduler.
- **Inputs:** `ms` delay and callback `fn`.
- **Returns / side effects:** `{ cancel }` which clears the timeout.
- **Used by:** `startDailyGiftsFromEnv` when no `schedule` is injected.

## Function: msUntilNextHour

- **Purpose:** Delay until the next local `hour:00:00` in a time zone (DST-safe).
- **Inputs:** `nowMs`, `hour` 0–23, IANA `timeZone`.
- **Returns / side effects:** Non-negative milliseconds. Exact instant returns 0.
- **Used by:** `startDailyGiftsScheduler`.

## Function: startDailyGiftsScheduler

- **Purpose:** In-process timer loop: wait, run, reschedule.
- **Inputs:** Config, `run` callback, clock, `schedule` factory (tests inject; production uses `setTimeout`).
- **Returns / side effects:** `{ stop }`. Overlapping runs skipped. Run errors logged as `daily_gifts.run.error`.
- **Used by:** `startDailyGiftsFromEnv`. Does not start from `createApp`.

## Function: startDailyGiftsFromEnv

- **Purpose:** Parse env and start the scheduler, or no-op when misconfigured.
- **Inputs:** Env plus `fetchImpl` and optional fs/clock/schedule/pid.
- **Returns / side effects:** `{ stop }`. Parse failure emits `daily_gifts.unconfigured` and does not throw.
- **Used by:** Boot path in `src/index.ts`.

## Function: requestAmountInvoice

- **Purpose:** LNURL-pay invoice for an exact millisatoshi amount (no verification cap).
- **Inputs:** `address`, `amountMsat`, `fetchImpl`, optional `comment`.
- **Returns / side effects:** `{ ok: true, pr, payMsat }` or `{ ok: false, reason: 'unreachable' }`. Does not raise to `minSendable`.
- **Used by:** `runDailyGifts`. Comment omitted unless provided and `commentAllowed` permits it.
