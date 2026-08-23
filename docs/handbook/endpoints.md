# HTTP endpoints

## Endpoint: DELETE /me/lightning-address

- **Purpose:** Bearer required. Clears the account Lightning Address.
- **Errors:** 401 without session.
- **Used by:** `unlinkLightningAddress` in the app.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /apple-touch-icon.png

- **Purpose:** PNG brand mark (apple-touch). `Cache-Control: public, max-age=86400`.
- **Errors:** 404 empty body when `public/apple-touch-icon.png` is missing.
- **Used by:** iOS home-screen icon crawlers.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /auth/lnurl

- **Purpose:** Creates a login challenge. JSON: lnurl, k1, pollToken.
- **Errors:** HTTP 500 `{ error: 'Server auth is not configured' }` if `PUBLIC_BASE_URL` is unset.
- **Used by:** App `startLnurlAuth`.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /auth/lnurl/callback

- **Purpose:** Wallet hits this with `k1`, `sig`, `key` (LUD-04). Success body `{ status: 'OK' }`. Query is never written to http.request logs.
- **Errors:** HTTP 200 `{ status: 'ERROR', reason }` on missing params or bad signature (LUD-04).
- **Used by:** Wallet of Satoshi / any LNURL-auth wallet.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /auth/session

- **Purpose:** Header `X-Poll-Token`. Returns pending until the callback succeeds, then `{ status: 'authenticated', token, account }`.
- **Errors:** expired/used after TTL or reuse.
- **Used by:** App `pollSession`.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /favicon.ico

- **Purpose:** Windows ICO (RGBA PNG-in-ICO) of the 21.gifts mark. `Content-Type: image/x-icon`, `Cache-Control: public, max-age=86400`.
- **Errors:** 404 empty body when `public/favicon.ico` is missing.
- **Used by:** Browsers opening api.21.gifts.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /favicon.svg

- **Purpose:** SVG mark, orange 21 on black. `Content-Type: image/svg+xml`, `Cache-Control: public, max-age=86400`.
- **Errors:** 404 empty body when `public/favicon.svg` is missing.
- **Used by:** Modern browsers preferring SVG icons.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /healthz

- **Purpose:** Liveness. `{ status: 'ok', service, version }`. Not logged as http.request.
- **Errors:** Always 200 if the process is up.
- **Used by:** Orchestrators, e2e, Uptime checks.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /info

- **Purpose:** Service metadata (name, version, description, repo).
- **Errors:** 200 JSON.
- **Used by:** Humans and service catalogs.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: POST /invoices

- **Purpose:** Spend-worker only. Bearer `SPEND_API_TOKEN`. Body `{ address, amountMsat, comment? }`. Resolves LUD-16, fetches a BOLT11 via LNURL-pay, decodes hash/amount, stores the invoice in memory.
- **Errors:** 503 if the token env is unset; 401 wrong/missing Bearer; 400 bad JSON/address/amount; 502 provider did not issue a matching invoice.
- **Used by:** `21gifts/spend` before paying via lightning.space.
- **Auth:** `Authorization: Bearer` matching `SPEND_API_TOKEN`.

## Endpoint: POST /invoices/proof

- **Purpose:** Spend-worker only. Body `{ id, preimage }`. Accepts the payment preimage as proof (`sha256(preimage)` must equal the stored payment hash). Idempotent for the same preimage.
- **Errors:** 503 unconfigured; 401 unauthorized; 400 bad body or hash mismatch; 404 unknown id; 409 expired or already paid with a different preimage.
- **Used by:** `21gifts/spend` after LNDHub `payinvoice` returns a preimage.
- **Auth:** `Authorization: Bearer` matching `SPEND_API_TOKEN`.

## Endpoint: GET /lightning-address

- **Purpose:** Query `address=local@domain`. Resolves LUD-16, cached 5 minutes on success.
- **Errors:** 400 invalid, 502 unresolved.
- **Used by:** App donate `resolveLightningAddress`.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /me

- **Purpose:** Bearer session. Current account JSON (id, linkingKey, role, name, lightning address, verified flag).
- **Errors:** 401 if missing/expired.
- **Used by:** App `fetchMe`.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: POST /me/lightning-address

- **Purpose:** Body `{ address }`. Stores unverified LUD-16 on the account.
- **Errors:** 401/400.
- **Used by:** App `setLightningAddress`.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: POST /me/lightning-address/verification

- **Purpose:** Triggers the 1-sat proof-of-control payment. JSON `{ status: 'sent', expiresInSeconds, sats }`. The nonce is **not** returned to the client; it is only in the LUD-12 wallet comment.
- **Errors:** 401 `{ error: 'Unauthorized' }`; 409 `{ error: 'No Lightning Address linked' }` or `{ error: 'Lightning Address already verified' }`; 502 `{ error: 'Lightning Address did not accept the verification payment' }`; 503 `{ error: 'Verification payments are not configured' }`.
- **Used by:** App `startLightningAddressVerification`.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: POST /me/name

- **Purpose:** Bearer required. Body `{ name }`. Stores the trimmed display name on the account (1–80 characters, no C0/DEL control characters).
- **Errors:** 401 without session; 400 if the body is not `{ name: string }` or the name fails validation.
- **Used by:** App `setName`.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: POST /me/lightning-address/verification/confirm

- **Purpose:** Body `{ nonce }`. Marks the address verified when the invoice was paid.
- **Errors:** 401 `{ error: 'Unauthorized' }`; 400 `{ error: 'Expected a JSON body with a "nonce" string' }` or `{ error: 'Incorrect verification code' }`; 409 `{ error: 'No verification in progress' }` or `{ error: 'Verification expired' }`.
- **Used by:** App `confirmLightningAddressVerification`.
- **Auth:** See Purpose — Bearer where stated, else public.
