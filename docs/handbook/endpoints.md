# HTTP endpoints

## Endpoint: DELETE /me/lightning-address

- **Purpose:** Bearer required. Clears the account Lightning Address.
- **Errors:** 401 without session.
- **Used by:** `unlinkLightningAddress` in the app.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /apple-touch-icon.png

- **Purpose:** 180×180 PNG brand mark. `Cache-Control: public, max-age=86400`.
- **Errors:** 404 if `public/` missing in the image.
- **Used by:** iOS home-screen icon crawlers.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /auth/lnurl

- **Purpose:** Creates a login challenge. JSON: lnurl, k1, pollToken.
- **Errors:** 503 if PUBLIC_BASE_URL unset.
- **Used by:** App `startLnurlAuth`.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /auth/lnurl/callback

- **Purpose:** Wallet hits this with `k1`, `sig`, `key` (LUD-04). Body `{ status: 'OK' }` or ERROR. Query is never written to http.request logs.
- **Errors:** 400/ERROR on bad sig.
- **Used by:** Wallet of Satoshi / any LNURL-auth wallet.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /auth/session

- **Purpose:** Header `X-Poll-Token`. Returns pending until the callback succeeds, then `{ status: 'authenticated', token, account }`.
- **Errors:** expired/used after TTL or reuse.
- **Used by:** App `pollSession`.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /favicon.ico

- **Purpose:** Windows ICO (RGBA PNG-in-ICO) of the 21.gifts mark.
- **Errors:** 404 if file missing.
- **Used by:** Browsers opening api.21.gifts.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /favicon.svg

- **Purpose:** SVG mark, orange 21 on black.
- **Errors:** 404 if missing.
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

## Endpoint: GET /lightning-address

- **Purpose:** Query `address=local@domain`. Resolves LUD-16, cached 5 minutes on success.
- **Errors:** 400 invalid, 502 unresolved.
- **Used by:** App donate `resolveLightningAddress`.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /me

- **Purpose:** Bearer session. Current account JSON (id, linkingKey prefix fields, lightning address, verified flag, role).
- **Errors:** 401 if missing/expired.
- **Used by:** App `fetchMe`.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: POST /me/lightning-address

- **Purpose:** Body `{ address }`. Stores unverified LUD-16 on the account.
- **Errors:** 401/400.
- **Used by:** App `setLightningAddress`.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: POST /me/lightning-address/verification

- **Purpose:** Triggers the 1-sat proof-of-control payment. Returns nonce + amount.
- **Errors:** 401/503 if payer unconfigured.
- **Used by:** App `startLightningAddressVerification`.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: POST /me/lightning-address/verification/confirm

- **Purpose:** Body `{ nonce }`. Marks the address verified when the invoice was paid.
- **Errors:** 401/400 mismatch.
- **Used by:** App `confirmLightningAddressVerification`.
- **Auth:** See Purpose — Bearer where stated, else public.
