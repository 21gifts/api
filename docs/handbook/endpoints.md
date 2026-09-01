# HTTP endpoints

## Endpoint: DELETE /me/lightning-address

- **Purpose:** Bearer required. Clears the account Lightning Address.
- **Errors:** 401 without session.
- **Used by:** `unlinkLightningAddress` in the app.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /messages/:id/video.mp4

- **Purpose:** Public MP4 bytes as a sized body (`Content-Length` = body byte length) with `Accept-Ranges` / HTTP 206 `Content-Range` so clients can seek. Best-effort faststart (`moov` before `mdat`) on write; heal-on-read remuxes when the stored file is still mdat-first. `Access-Control-Allow-Origin: *`. After deploy, purge or wait out CDN cache for URLs previously served without `Content-Length` (chunked streams that ignored `Range`).
- **Errors:** 404 `{ error: 'Video not found' }`; 416 unsatisfiable `Range` (`Content-Range: bytes */SIZE`); 503 `{ error: 'Messages are unavailable' }`.
- **Used by:** Damus/Primal/Safari kind:1 video URLs.
- **Auth:** none.

## Endpoint: GET /messages/:id/video.webm

- **Purpose:** Same as `video.mp4` for WebM posts (sized body + Range; WebM is not remuxed).
- **Errors:** Same 404 / 416 / 503.
- **Used by:** Damus/Primal/Safari.
- **Auth:** none.

## Endpoint: GET /messages/:id/video.mov

- **Purpose:** Same as `video.mp4` for QuickTime posts (sized body + Range + faststart).
- **Errors:** Same 404 / 416 / 503.
- **Used by:** Damus/Primal/Safari.
- **Auth:** none.

## Endpoint: GET /.well-known/nostr.json

- **Purpose:** NIP-05 directory `{ names, relays }`. CORS `*`. Optional `?name=`.
- **Errors:** 503 `{ error: 'Directory is unavailable' }`.
- **Used by:** Damus verification; app proxies this from the site apex.
- **Auth:** none.

## Endpoint: GET /apple-touch-icon.png

- **Purpose:** PNG brand mark (apple-touch). `Cache-Control: public, max-age=86400`.
- **Errors:** 404 empty body when `public/apple-touch-icon.png` is missing.
- **Used by:** iOS home-screen icon crawlers.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /debug/accounts

- **Purpose:** Operator listing of registered accounts (`id`, `linkingKey`, `role`, `name`, lightning address fields, `forumLawsDismissed`, `createdAt`, `rulesAgreedAt`, `isPlatform`) **without** `viewKey`.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match.
- **Used by:** Operator `gifts-debug` CLI.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: POST /debug/accounts

- **Purpose:** Operator provision of accounts by display name + Lightning Address (no passkey, `rulesAgreedAt` null). Body `{ "accounts": [ { "name", "lightningAddress" } ] }` (1–100 rows). **All** new addresses are NIP-57 mint-probed (`probeNip57Mint`) first, unless `NIP57_PROBE=0` (e2e only); only then is any row persisted. Name-only updates (address already in store) do **not** probe and run after every new-address probe has passed. Creates a new `basis` row with a fresh `viewKey`, or updates **only** `name` when the address already exists (`lower(trim)` match; other columns including `viewKey`, `role`, and `rulesAgreedAt` stay unchanged). Response `{ accounts: [ { name, lightningAddress, viewKey, created } ] }` includes `viewKey` for the invite link; `GET` still omits it.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 400 `{ error: 'Expected a JSON body with an "accounts" array' }` for invalid/missing/non-JSON body, C0/DEL names, or non-LUD-16 addresses (no row is written); 400 `{ error: LIGHTNING_ADDRESS_NOT_ZAP }` when any new address fails the NIP-57 mint probe (`not_zap`; no new address in that request is saved); 400 `{ error: 'Lightning Address could not be resolved' }` when any new-address probe is unreachable (no new address in that request is saved); 500 `{ error: 'Could not save the account' }` when create does not persist the address, the name-only update matches no row, or the name-only update returns a row whose `name` is not the requested name.
- **Used by:** Operator provisioning before passkey claim.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: POST /debug/accounts/:id/session

- **Purpose:** Operator mint of a member bearer session for the given account id. Response `{ token }`. For e2e and operator debugging only — not a member login path.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 404 `{ error: 'Not found' }` when the account id is unknown.
- **Used by:** Playwright e2e against the booted process; operators reproducing member HTTP.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: PATCH /debug/accounts/:id

- **Purpose:** Operator assignment of `account.role` (`basis` \| `verified` \| `moderator` \| `founder`), hard-unlink of the Lightning Address, and/or the official platform flag. Body may include any of `{ "role": "<AccountRole>" }`, `{ "lightningAddress": null }`, `{ "platform": true|false }`. Unlink sets `lightningAddress` to null, `lightningAddressVerified` to false, and drops in-flight address verification. Setting `platform: true` clears any other platform flag (at most one true) and, when a conversation store is wired, points every `member_platform` thread at this account (`retargetMemberPlatform`), except a thread whose member is already this account. Returns the updated account JSON (same shape as `GET /debug/accounts` via `serializeDebugAccount`, including `isPlatform`; no `viewKey`). Does not set a new address here (`POST /me/lightning-address` remains the live resolve path).
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 400 `{ error: 'Expected a JSON body with a "role" string, lightningAddress null, and/or platform boolean' }` for unknown/missing/non-JSON body or a non-null `lightningAddress`; 404 `{ error: 'Not found' }` when the account id is unknown.
- **Used by:** Operator `gifts-debug role` / `gifts-debug unlink` CLI and platform-account setup.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: GET /debug/contacts

- **Purpose:** Operator listing of private in-app contacts newest-first (cap 200), including `accountId`, name snapshot, text, and ISO `createdAt`.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 503 `{ error: 'Contact is unavailable' }` if the store throws (`contact.list.failed`).
- **Used by:** Operators reading the private mailbox.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: GET /debug/invoices

- **Purpose:** Operator listing of forum `POST /messages/:id/invoice` attempts newest-first (cap 200): result, HTTP status, BOLT11 `pr`, payment hash, description / description_hash, `isNip57Invoice`, and `lnurlResponse` (raw LNURL callback JSON object or null). ISO `createdAt`. Never includes nsec. Rejected non-NIP-57 attempts (`not_zap`) still list the rejected `pr` for debug.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 503 `{ error: 'Messages are unavailable' }` when listing throws (`debug.invoices.list_failed`).
- **Used by:** Operators debugging zap invoice issuance (including rejected non-NIP-57 `not_zap` rows with `pr` and raw `lnurlResponse`).
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: GET /debug/zap-ingests

- **Purpose:** Operator listing of kind:9735 ingest decisions newest-first (cap 200): `outcome` (`indexed` \| `rejected`), `reason`, receipt id, note/message ids, amount, and the receipt event frame. ISO `createdAt`. Never includes nsec.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 503 `{ error: 'Messages are unavailable' }` when listing throws (`debug.zap_ingests.list_failed`).
- **Used by:** Operators debugging zap receipt indexing.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: GET /push/vapid-public

- **Purpose:** Bearer session. Returns `{ publicKey }` (URL-safe base64 VAPID public) so the app can subscribe.
- **Errors:** 401 `{ error: 'Unauthorized' }` without a session; 503 `{ error: 'Push is not configured' }` when VAPID keys are missing.
- **Used by:** App `fetchVapidPublicKey` / enable-notifications.
- **Auth:** `Authorization: Bearer` member session.

## Endpoint: POST /me/push-subscriptions

- **Purpose:** Bearer session. Upserts `{ endpoint, keys: { p256dh, auth } }` for the account. Rebinds the endpoint if another account owned it.
- **Errors:** 401 Unauthorized; 503 Push is not configured; 400 `{ error: 'Invalid subscription' }`.
- **Used by:** App `postPushSubscription`.
- **Auth:** `Authorization: Bearer` member session.

## Endpoint: DELETE /me/push-subscriptions

- **Purpose:** Bearer session. Body `{ endpoint }` removes that device for the account.
- **Errors:** 401 Unauthorized; 503 Push is not configured; 400 Invalid subscription; 404 `{ error: 'Not found' }`.
- **Used by:** App `deletePushSubscription`.
- **Auth:** `Authorization: Bearer` member session.

## Endpoint: POST /debug/push-ping

- **Purpose:** Operator enqueue of a test notification for `{ accountId }`. Returns `{ enqueued }` (`0` or `1`).
- **Errors:** 503 Debug is not configured; 401 Unauthorized; 503 Push is not configured; 400 expected accountId; 404 Not found.
- **Used by:** Operators verifying Web Push delivery.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: POST /auth/passkey/authenticate/begin

- **Purpose:** Issues WebAuthn request options for a discoverable credential. JSON: challengeId, options.
- **Errors:** HTTP 500 `{ error: 'Server auth is not configured' }` if `WEBAUTHN_RP_ID` is unset, blank, not on the allowlist, or no CORS origin matches it.
- **Used by:** App passkey sign-in.
- **Auth:** Public.

## Endpoint: POST /auth/passkey/authenticate/finish

- **Purpose:** Verifies the assertion and issues `{ token, account }` immediately. Requires `Origin`.
- **Errors:** 400 invalid body/origin/challenge/credential; 500 if WebAuthn is unconfigured.
- **Used by:** App passkey sign-in.
- **Auth:** Public (proof is the assertion).

## Endpoint: POST /auth/passkey/register/begin

- **Purpose:** Issues WebAuthn creation options. JSON: challengeId, options. Empty body / no `viewKey` mints a pending new account id (row created only on finish). Optional body `{ "viewKey": "<64-hex>" }` claims an operator-provisioned account (same id/name/lightningAddress/viewKey).
- **Errors:** HTTP 500 `{ error: 'Server auth is not configured' }` if `WEBAUTHN_RP_ID` is unset, blank, not on the allowlist, or no CORS origin matches it; 400 `{ error: 'Expected a JSON body with an optional "viewKey" string' }` when `viewKey` is present but not a string; 404 `{ error: 'This profile could not be found.' }` for a malformed/unknown view key; 409 `{ error: 'This profile already has a passkey' }` when the provisioned account already has a credential.
- **Used by:** App passkey account creation and claim-by-viewKey.
- **Auth:** Public.

## Endpoint: POST /auth/passkey/register/finish

- **Purpose:** Verifies the attestation, creates a `linkingKey: null` account (or binds a passkey to a provisioned account without recreating it), issues `{ token, account }`. Requires `Origin`.
- **Errors:** 400 invalid body/origin/challenge/passkey; 500 if WebAuthn is unconfigured.
- **Used by:** App passkey account creation and claim-by-viewKey.
- **Auth:** Public (proof is the attestation).

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

## Endpoint: GET /gifts

- **Purpose:** Public JSON of outbound gifts for one UTC day (`?day=YYYY-MM-DD`): `giftCount`, totals, `gifts[]` (`paidAt`, `amountSats`, `amountBtc`, `amountUsd`, `recipient`), and `fx`. USD uses that UTC day's Coinbase close. Empty day is 200 with zeros (no Coinbase). No invoices.
- **Errors:** 400 `{ "error": "Expected a UTC day (YYYY-MM-DD)" }` when `day` is missing or not a real date; 503 `{ "error": "Gift stats are unavailable" }` on store/rate failure (`gifts.day.fx_incomplete` / `gifts.day.failed`).
- **Used by:** App day page (`GET /gifts` same-origin proxy).
- **Auth:** Public.

## Endpoint: GET /gifts/stats

- **Purpose:** Public JSON of outbound gift totals: `totalSats` / `totalBtc` / `totalUsd`, `giftCount`, `recipientCount`, date range, `spendOverTime` (sats+BTC+USD), `byRecipient`, `byMonth`, and `fx`. USD uses each gift's UTC-day Coinbase BTC-USD daily close (not spot). Optional query `recipient` filters to one Wallet of Satoshi handle (case-insensitive). When `recipient` contains `@` after the first character, the local-part before `@` is used; otherwise the whole trimmed string. Missing/blank `recipient` = unfiltered. Unknown handle = empty stats **200** with zeros and `fx` (no Coinbase call). Empty boots are empty **200** with zeros and `fx` (no Coinbase call). No invoices.
- **Errors:** 503 `{ "error": "Gift stats are unavailable" }` when the gift store throws, when `ensureDays` fails, or when any selected gift day still lacks a rate after ensure (`gifts.stats.fx_incomplete` / `gifts.stats.failed`).
- **Used by:** App statistics page (`GET /gifts/stats` same-origin proxy); optional per-recipient view via `?recipient=`.
- **Auth:** Public.

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

- **Purpose:** Spend-worker only. Bearer `SPEND_API_TOKEN`. Body `{ address, amountMsat, comment? }` (`comment` max 255). Resolves LUD-16, fetches a BOLT11 via LNURL-pay, decodes hash/amount, stores the invoice in memory.
- **Errors:** 503 if the token env is unset; 401 wrong/missing Bearer; 400 bad JSON/address/amount/`comment` longer than 255; 502 provider did not issue a matching invoice.
- **Used by:** the external spend worker before paying via lightning.space.
- **Auth:** `Authorization: Bearer` matching `SPEND_API_TOKEN`.

## Endpoint: POST /invoices/proof

- **Purpose:** Spend-worker only. Body `{ id, preimage }`. Accepts the payment preimage as proof (`sha256(preimage)` must equal the stored payment hash). Idempotent for the same preimage. A match inserts an outbound `gift` row when `DATABASE_URL` is set (BOLT11 `pr` as `lightning_invoice`, amount floor(msat/1000) sats, fee 0, recipient handle from the address, description `21gifts daily`, `source_wallet` `lightning.space`); otherwise recording is a no-op. Insert failure logs `gifts.record_failed` and still returns 200.
- **Errors:** 503 unconfigured; 401 unauthorized; 400 bad body or hash mismatch on an unexpired invoice; 404 unknown id (including after unpaid sweep/restart); 409 expired without a matching preimage, or already paid with a different preimage. Matching preimage is 200 after TTL while the row remains.
- **Used by:** the external spend worker after LNDHub `payinvoice` returns a preimage.
- **Auth:** `Authorization: Bearer` matching `SPEND_API_TOKEN`.

## Endpoint: GET /lightning-address

- **Purpose:** Query `address=local@domain`. Resolves LUD-16, cached 5 minutes on success.
- **Errors:** 400 invalid, 502 unresolved.
- **Used by:** App donate `resolveLightningAddress`.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /me

- **Purpose:** Bearer session. Current account JSON (id, linkingKey, role, name, lightning address, verified flag, forumLawsDismissed, `createdAt`, `rulesAgreedAt`, owner `viewKey`, `setup`). `setup` is the next owner step (`name` \| `lightning-address` \| `rules`) or `null` when complete; computed here so clients do not invent a parallel sequence.
- **Errors:** 401 if missing/expired.
- **Used by:** App `fetchMe`.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /view/:viewKey

- **Purpose:** Public capability URL. Read-only profile card (`name`, `lightningAddress`, `lightningAddressVerified`, `createdAt`, `hasPasskey`). `hasPasskey` is true when the account already has a passkey credential. No auth. Not a session.
- **Errors:** 404 `{ "error": "Not found" }` when the param is not 64 lowercase hex or the key is unknown.
- **Used by:** Anyone with the link (owner copies `viewKey` from GET `/me`); invite page uses `hasPasskey` for the activation banner.
- **Auth:** none.

## Endpoint: GET /messages

- **Purpose:** Bearer required. Lists **top-level** forum notes only (`parent_id` null) newest-first (author name snapshotted at post, `text`, ISO `createdAt`, `sats`, `payable`, `hasPhoto`, `hasVideo`, `videoContentType`, live author `role`, and `replyCount`), capped at 200 (latest-200 window). Replies are never listed here. Clients render chronological messenger-group order (oldest top, newest bottom above the composer). Empty list is 200 `{ messages: [] }`. No photo/video bytes in JSON; signed-in list may include `accountId` (21gifts author id; omitted for Damus-only); `payable` is true when the note has an `eventId` and the author has a Lightning Address; missing author → `role` `"basis"` and `payable` false. `videoContentType` is `null` when `hasVideo` is false.
- **Errors:** 401 `{ error: 'Unauthorized' }` missing/invalid/expired bearer; 503 `{ error: 'Messages are unavailable' }` if the store throws (`messages.list.failed`).
- **Used by:** App public comment thread.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /messages/:id

- **Purpose:** Public single-note fetch (no Bearer). Returns the public message JSON via `serializeMessage` (`sats`, `payable`, `hasPhoto`, `hasVideo`, `videoContentType`; live `role` for 21gifts authors; Damus-only `accountId: null` omits `role` and sets `payable` false). Never includes `accountId`. Photo/video bytes are never included.
- **Errors:** 404 `{ error: 'Not found' }` when `:id` is not a UUID or the row is missing; 503 `{ error: 'Messages are unavailable' }` when the store throws (`messages.get.failed`).
- **Used by:** App deep links / share URLs for one forum note.
- **Auth:** none (public).

## Endpoint: GET /messages/:id/replies

- **Purpose:** Bearer required. Lists direct replies for parent `:id` oldest-first (`createdAt` then `id` ASC), capped at 200. Body is `{ messages: [...] }` (same key as `GET /messages`, not `replies`). Each item is public message JSON with `payable` false; may include `accountId` for 21gifts authors (omitted for Damus-only); Damus-only replies omit `role`.
- **Errors:** 401 `{ error: 'Unauthorized' }` without a session; 404 `{ error: 'Not found' }` when `:id` is not a UUID or the parent is missing; 503 `{ error: 'Messages are unavailable' }` (`messages.replies.failed`).
- **Used by:** App reply thread under a top-level note.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /messages/:id/photo

- **Purpose:** Public. Returns raw photo bytes for one message (`Content-Type` jpeg/png/webp, `Cache-Control: public, max-age=86400`, `Access-Control-Allow-Origin: *`, `Content-Disposition: inline; filename="photo.jpg|png|webp"`) so Nostr clients can load NIP-92 `imeta` URLs. Same bytes at `/photo.jpg`, `/photo.jpeg`, `/photo.png`, and `/photo.webp` because Damus only embeds URLs that look like image files. List JSON never embeds bytes — clients fetch here when `hasPhoto` is true.
- **Errors:** 404 `{ error: 'Photo not found' }` when the id is missing, not a UUID, or has no photo; 503 `{ error: 'Messages are unavailable' }` (`messages.photo.failed`).
- **Used by:** App forum photo display; Damus/Primal via kind:1 photo URLs.
- **Auth:** none.

## Endpoint: GET /messages/:id/photo.jpg

- **Purpose:** Same public bytes as `GET /messages/:id/photo`. Kind:1 and `imeta` use this path so Damus embeds the image instead of a website card.
- **Errors:** Same 404 / 503 as `GET /messages/:id/photo`.
- **Used by:** Damus, Primal, njump via kind:1 photo URLs.
- **Auth:** none.

## Endpoint: GET /messages/:id/photo.jpeg

- **Purpose:** Alias of `GET /messages/:id/photo.jpg`.
- **Errors:** Same 404 / 503 as `GET /messages/:id/photo`.
- **Used by:** Clients that request `.jpeg`.
- **Auth:** none.

## Endpoint: GET /messages/:id/photo.png

- **Purpose:** Same handler as `GET /messages/:id/photo` when the stored type is PNG. Kind:1 URLs use `.png` for PNG posts.
- **Errors:** Same 404 / 503 as `GET /messages/:id/photo`.
- **Used by:** Damus/Primal for PNG forum photos.
- **Auth:** none.

## Endpoint: GET /messages/:id/photo.webp

- **Purpose:** Same handler as `GET /messages/:id/photo` when the stored type is WebP. Kind:1 URLs use `.webp` for WebP posts.
- **Errors:** Same 404 / 503 as `GET /messages/:id/photo`.
- **Used by:** Damus/Primal for WebP forum photos.
- **Auth:** none.

## Endpoint: POST /messages

- **Purpose:** Bearer required. JSON `{ text?, photo?: { contentType, data }, inReplyTo? }` (base64 JPEG/PNG/WebP ≤ 1 MiB) or `multipart/form-data` with `text`, `video` (MP4/WebM/MOV ≤ 32 MiB), and optional JPEG/PNG/WebP `poster`. Optional `inReplyTo` is a **top-level** parent message UUID (sets `parentId` for a one-level NIP-10 reply; JSON only). Text-only stays valid; photo-only or video-only allowed; at least one of non-empty trimmed text, photo, or video required. Name snapshot. 200 is the public message including `sats`, `payable`, `hasPhoto`, `hasVideo`, `videoContentType`, the session account's live `role`, and `accountId` (not wrapped). New notes have `sats` 0 and `payable` false until signed. Top-level creates may enqueue push; replies do not.
- **Errors:** 401 Unauthorized; 400 Expected a JSON body with text and/or photo; 400 Set a name before posting; 400 Text must be 1–500 characters; 400 Text must be 1–500 characters or include a photo; 400 Text must be 1–500 characters or include a photo or video; 400 Photo must be a JPEG, PNG, or WebP under 1 MiB; 400 Poster must be a JPEG, PNG, or WebP under 1 MiB; 400 Video must be an MP4, WebM, or MOV under 32 MiB; 404 `{ error: 'Not found' }` when `inReplyTo` is present but not a UUID, the parent is missing, or the parent is itself a reply (`parentId !== null`); 429 Too many messages (`Retry-After: 10`); 503 Messages are unavailable (`messages.create.failed`).
- **Used by:** App forum composer and reply composer.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /messages/:id/invoice

- **Purpose:** Bearer required. `:id` is a UUID. Body `{ sats }` (integer 1..10_000_000). Builds a NIP-57 kind:9734 zap request for the note, signs it with the payer's custodial key (ensuring one exists when KEK is present), and returns `{ pr, amountSats }` only when the minted BOLT11 is a NIP-57 `description_hash` invoice (`isNip57Invoice`); otherwise persists `not_zap` (with rejected `pr` for debug) and responds 400 `The author's wallet cannot receive this Bitcoin payment` without `pr` in the body. Same author's-wallet 400 for LNURL `noZap`; other LNURL transport failures (`unreachable`) keep `Could not start the Bitcoin payment`. After auth, valid-UUID attempts are persisted best-effort (`message_invoice`); persist failures do not change the HTTP response. The invoice rate limit is applied only after auth, amount, payable, and KEK checks (NIP-57 reject still counts, same as other LNURL failures).
- **Errors:** 401 Unauthorized; 400 bad body / This message cannot be paid yet / The author's wallet cannot receive this Bitcoin payment (`noZap`, `not_zap`) / Could not start the Bitcoin payment (`unreachable` and other LNURL transport failures); 404 Not found (unknown id or non-UUID `:id`, the latter without a persist row); 429 Too many payments (`Retry-After: 10`, after payable checks); 503 Messages are unavailable (missing KEK before limiter, or keygen/sign failure after).
- **Used by:** App pay sheet for forum notes.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /contact

- **Purpose:** Bearer required. Body `{ text }`. Private mailbox to 21.gifts — never listed publicly. Name snapshot as forum messages; text uses `normalizeForumText` then still requires 1–500 characters (forum photo-only empty text does not apply). After the platform account exists, persists the contact row first, then opens/appends the member→platform conversation thread so the message is readable via `GET /conversations`. Conversation append failure logs `conversations.contact_sync.failed` and still returns 200 (contact is the product surface). 200 is the public contact object (no `accountId`).
- **Errors:** 401 Unauthorized; 400 Expected a JSON body with a "text" string; 400 Set a name before posting; 400 Text must be 1–500 characters; 503 `{ error: 'Platform account is not configured' }` when no `isPlatform` account exists (neither contact nor thread is written); 503 Contact is unavailable (`contact.create.failed`).
- **Used by:** App in-app contact composer.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /conversations

- **Purpose:** Bearer required. Lists threads the session may see: own member threads plus, when role is founder or moderator, all platform threads. Newest last-message first (cap 200). Public JSON is `{ conversations: [{ id, name, lastText, lastAt }] }` — no account ids, event ids, or npubs (Damus-only `name` may be a truncated npub). `DEBUG_TOKEN` cannot read this inbox.
- **Errors:** 401 Unauthorized; 503 `{ error: 'Conversations are unavailable' }` (`conversations.list.failed`).
- **Used by:** App conversation list.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /conversations

- **Purpose:** Bearer required. Body `{ forumMessageId }` (forum note UUID). Opens or returns the thread with that note's author (21gifts account or Damus pubkey). 200 is the public conversation object.
- **Errors:** 401 Unauthorized; 400 Expected a JSON body with a "forumMessageId" string; 400 `{ error: 'Cannot message yourself' }` when the author is the session account; 404 `{ error: 'Not found' }` for a non-UUID / missing note / Damus note without pubkey; 503 Conversations are unavailable.
- **Used by:** App "message the author" from a forum note.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /conversations/:id

- **Purpose:** Bearer required. `:id` is a UUID. Messages oldest-first (cap 200) as `{ messages: [{ id, name, text, createdAt }] }`. 404 when the session may not see the thread.
- **Errors:** 401 Unauthorized; 404 Not found; 503 Conversations are unavailable.
- **Used by:** App conversation thread.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /conversations/:id

- **Purpose:** Bearer required. Body `{ text }` 1–500 via `normalizeForumText`. Appends a message. Staff (founder/moderator) replies on a platform thread persist as the platform account (worker signs with the platform nsec). Local persist does not wait for relay ACK.
- **Errors:** 401 Unauthorized; 400 Expected a JSON body with a "text" string; 400 Set a name before posting; 400 Text must be 1–500 characters; 404 Not found; 503 Conversations are unavailable.
- **Used by:** App conversation composer.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /me/forum-laws-dismissed

- **Purpose:** Bearer required. No body. Sets `forumLawsDismissed` to `true` on the account (idempotent; no un-dismiss). Returns the owner account JSON (same as GET `/me`, including `viewKey`).
- **Errors:** 401 without session.
- **Used by:** App welcome-forum living-room laws dismiss control.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: POST /me/lightning-address

- **Purpose:** Body `{ address }`. Live-resolves LUD-16 well-known metadata, requires zap support (`allowsNostr` + non-empty `nostrPubkey`), then runs a NIP-57 mint probe (`probeNip57Mint` with the account's custodial key). On `ok`, stores the address unverified on the account.
- **Errors:** 401 Unauthorized; 400 Expected a JSON body with an "address" string; 400 Not a valid Lightning Address (expected name@domain); 400 Lightning Address could not be resolved (unreachable well-known / missing zap metadata / unreachable probe; account unchanged); 400 `{ error: LIGHTNING_ADDRESS_NOT_ZAP }` when the mint probe returns `not_zap` (account unchanged); 503 `{ error: 'Lightning Address could not be resolved' }` when `NOSTR_NSEC_KEK` / `nostrKek` is missing or key ensure fails; 409 Lightning Address is already in use (another account owns it, including a unique-index race).
- **Used by:** App `setLightningAddress`.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: POST /me/lightning-address/verification

- **Purpose:** Triggers the 1-sat proof-of-control payment. JSON `{ status: 'sent', expiresInSeconds, sats }`. The nonce is **not** returned to the client; it is only in the LUD-12 wallet comment.
- **Errors:** 401 `{ error: 'Unauthorized' }`; 409 `{ error: 'No Lightning Address linked' }` or `{ error: 'Lightning Address already verified' }`; 502 `{ error: 'Lightning Address did not accept the verification payment' }`; 503 `{ error: 'Verification payments are not configured' }`.
- **Used by:** App `startLightningAddressVerification`.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: POST /me/rules-agreement

- **Purpose:** Bearer required. No body required. Records first living-room rules agreement using the server clock; later POSTs return the original timestamp (idempotent 200 account JSON).
- **Errors:** 401 `{ error: 'Unauthorized' }` without a session.
- **Used by:** App after name and address onboarding.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: POST /me/lightning-address/verification/confirm

- **Purpose:** Body `{ nonce }`. Marks the address verified when the invoice was paid.
- **Errors:** 401 `{ error: 'Unauthorized' }`; 400 `{ error: 'Expected a JSON body with a "nonce" string' }` or `{ error: 'Incorrect verification code' }`; 409 `{ error: 'No verification in progress' }` or `{ error: 'Verification expired' }`.
- **Used by:** App `confirmLightningAddressVerification`.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: POST /me/name

- **Purpose:** Bearer required. Body `{ name }`. Stores the trimmed display name on the account (1–80 characters, no C0/DEL control characters).
- **Errors:** 401 without session; 400 if the body is not `{ name: string }` or the name fails validation.
- **Used by:** App `setName`.
- **Auth:** See Purpose — Bearer where stated, else public.
