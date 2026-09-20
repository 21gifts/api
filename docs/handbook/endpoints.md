# HTTP endpoints

## Endpoint: DELETE /me/lightning-address

- **Purpose:** Bearer required. Clears the account Lightning Address, resets `lightningAddressVerified` to false, and clears `lightningAddressSkippedAt` so owner `setup` returns to `lightning-address` when a name is set or name-skipped.
- **Errors:** 401 without session.
- **Used by:** `unlinkLightningAddress` in the app.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /messages/:id/video.mp4

- **Purpose:** Public MP4 bytes as a sized body (`Content-Length` = body byte length) with `Accept-Ranges` / HTTP 206 `Content-Range` so clients can seek. Best-effort faststart (`moov` before `mdat`) on write; heal-on-read remuxes when the stored file is still mdat-first. `Access-Control-Allow-Origin: *`. Soft-hidden rows (`deletedAt` set) are 404 even when the on-disk file remains. A live reply without an account whose author pubkey is not a recorded zapper (or that has no author pubkey) is the same 404, matching `GET /messages/:id`. After deploy, purge or wait out CDN cache for URLs previously served without `Content-Length` (chunked streams that ignored `Range`).
- **Errors:** 404 `{ error: 'Video not found' }` (missing / soft-hidden / wrong ext / empty); 416 unsatisfiable `Range` (`Content-Range: bytes */SIZE`); 503 `{ error: 'Messages are unavailable' }`.
- **Used by:** Damus/Primal/Safari kind:1 video URLs.
- **Auth:** none.

## Endpoint: GET /messages/:id/video.webm

- **Purpose:** Same as `video.mp4` for WebM posts (sized body + Range; WebM is not remuxed). Soft-hidden rows are 404.
- **Errors:** Same 404 / 416 / 503.
- **Used by:** Damus/Primal/Safari.
- **Auth:** none.

## Endpoint: GET /messages/:id/video.mov

- **Purpose:** Same as `video.mp4` for QuickTime posts (sized body + Range + faststart). Soft-hidden rows are 404.
- **Errors:** Same 404 / 416 / 503.
- **Used by:** Damus/Primal/Safari.
- **Auth:** none.

## Endpoint: DELETE /messages/:id

- **Purpose:** Bearer required. A moderator soft-hides a forum note: stamps `deleted_at` / `deleted_by` on the target and every untagged **direct** reply via `MessageStore.markDeleted`. Does not hard-delete rows, media, invoices, zap receipts, or gifts; does not call `deleteById`. Already-tagged targets keep original stamps and still return 204. When the target itself is external (`accountId === null && authorPubkey !== null`), after `markDeleted` succeeds the route calls the single atomic `blockPubkeyAndHideRows` operation to add the staff kill-switch entitlement block and soft-hide every other live row from that pubkey, then logs `messages.external.blocked` with `{ messageId, hidden: cascaded + 1 }`. Hiding a member note that merely has external children does not block a pubkey or hide that pubkey's other rows; only the normal direct-reply cascade applies. Public JSON never exposes `deletedAt` / `deletedBy`. After a successful stamp (including already tagged), best-effort NIP-09 `kind: 5` is published for the target and each direct child with a non-empty `eventId` and non-null `accountId`, signed with that row's custodial nsec (not the staff deleter), to the durability relay plus the public relay list (not gated on `NOSTR_PUBLISH` / `NOSTR_PUBLISH_PUBLIC`). Then, when `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_API_TOKEN` are set and `PUBLIC_BASE_URL` resolves, public photo/video URLs for those rows are purged at Cloudflare (`purge_cache` files, chunks of 30). Sign/publish/purge failure still 204; logs `messages.delete.nostr_failed` / `messages.delete.purge_failed` / `messages.delete.retract_failed` with `messageId` only (never nsec, token, or post text). Debug restore does not undelete Nostr or un-purge. Logs `messages.deleted` with `messageId`, `accountId`, and staff `role` (never post text).
- **Errors:** 401 `{ error: 'Unauthorized' }` without a session; 403 `{ error: 'Forbidden' }` when the live role is not at least moderator (including the author); 404 `{ error: 'Not found' }` for a non-UUID `:id` or missing row; 503 `{ error: 'Messages are unavailable' }` when the store throws (`messages.delete.failed`).
- **Used by:** Staff hide controls in the app forum.
- **Auth:** `Authorization: Bearer` session (moderator).

## Endpoint: GET /messages/hidden

- **Purpose:** Bearer session required (moderator; not `DEBUG_TOKEN`). Inverse **read** of `DELETE /messages/:id`. Lists soft-hidden forum rows (`deletedAt` set) newest-hidden first (`deletedAt` desc, then `id` desc), capped at 200, via `listHidden` / `serializeHiddenMessage`. Listed rows include every hidden row regardless of external-zapper entitlement — this endpoint is a moderation view and is intentionally unaffected by the read-visibility rule described above. Each item includes stored `name` (no empty-name pubkey fallback), ISO `createdAt` / `deletedAt`, `hasPhoto` / `hasVideo` / `videoContentType`, always-present `parentId` (JSON `null` on top-level), and `deletedBy: { id, name, role }` resolved from `authStore.getAccount` (missing account keeps the id with `name` / `role` null; null `deletedBy` is `{ id: null, name: null, role: null }`). Optional `via: 'nostr'` is present exactly when `accountId === null && authorPubkey !== null`, the same rule as public message JSON; the pubkey itself is never included. Never includes `accountId`, `eventId`, `nostrPublishState`, `payable`, author `role`, `nostrEvent`, `claimedUntil`, `contentFp`, nsec, or photo/video bytes. Public list/GET/photo stay 404 for hidden rows. No `forum.read` gate — a moderator without rules agreement is still 200. Logs `messages.hidden.listed` with `{ count }` only (never post text, never message ids). Registered before public `GET /messages/:id` so `"hidden"` is not captured as `:id`. No staff UNHIDE session route.
- **Errors:** 401 `{ error: 'Unauthorized' }` without a session; 403 `{ error: 'Forbidden' }` when the live role is not at least moderator (including the author / verified); 503 `{ error: 'Messages are unavailable' }` when the store, deleter lookup, or serialize throws (`messages.hidden.list_failed`).
- **Used by:** Staff hidden-note log in the app forum.
- **Auth:** `Authorization: Bearer` session (moderator). Not `DEBUG_TOKEN`.

## Endpoint: GET /.well-known/nostr.json

- **Purpose:** NIP-05 directory `{ names, relays }`. CORS `*`. Optional `?name=`.
- **Errors:** 503 `{ error: 'Directory is unavailable' }`.
- **Used by:** Damus verification; app proxies this from the site apex.
- **Auth:** none.

## Endpoint: GET /.well-known/lnurlp/:username

- **Purpose:** LUD-16 payRequest for `username@21.gifts`. Looks up the stored username, then returns the linked Wallet of Satoshi LNURL-pay JSON (callback stays on WoS so gifts still settle there). CORS `*`.
- **Errors:** 404 `{ error: 'Not found' }` when the username is invalid, unknown, or has no linked address; 502 `{ error: 'Lightning Address could not be resolved' }` when WoS is unreachable or the store throws.
- **Used by:** Lightning wallets paying `username@21.gifts`; app proxies this from the site apex.
- **Auth:** none.

## Endpoint: GET /apple-touch-icon.png

- **Purpose:** PNG brand mark (apple-touch). `Cache-Control: public, max-age=86400`.
- **Errors:** 404 empty body when `public/apple-touch-icon.png` is missing.
- **Used by:** iOS home-screen icon crawlers.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /debug/accounts

- **Purpose:** Operator listing of registered accounts (`id`, `linkingKey`, `role`, `name`, `location` (`string | null`, never omit, never `""`), lightning address fields, `forumLawsDismissed`, `createdAt`, `rulesAgreedAt`, `isPlatform`) **without** `viewKey`.
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
- **Used by:** Operator `gifts-debug role` / `gifts-debug unlink` CLI and platform-account setup. Does not write trust edges (`POST /debug/trust-edges` is the backfill path).
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: GET /debug/contacts

- **Purpose:** Operator listing of private in-app contacts newest-first (cap 200), including `accountId`, name snapshot, text, and ISO `createdAt`.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 503 `{ error: 'Contact is unavailable' }` if the store throws (`contact.list.failed`).
- **Used by:** Operators reading the private mailbox.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: GET /debug/invoices

- **Purpose:** Operator listing of all `message_invoice` attempts (forum `POST /messages/:id/invoice` and conversation `POST /conversations/:id/invoice`) newest-first (cap 200): result, HTTP status, BOLT11 `pr`, payment hash, description / description_hash, `isNip57Invoice`, and `lnurlResponse` (raw LNURL callback JSON object or null). ISO `createdAt`. Never includes nsec. `serializeInvoice` omits `conversationId` and `conversationMessageId`. Rejected non-NIP-57 attempts (`not_zap`) still list the rejected `pr` for debug.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 503 `{ error: 'Messages are unavailable' }` when listing throws (`debug.invoices.list_failed`).
- **Used by:** Operators debugging zap invoice issuance (including rejected non-NIP-57 `not_zap` rows with `pr` and raw `lnurlResponse`).
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: POST /debug/invoices/settle

- **Purpose:** Manually settle one successful forum `message_invoice` by its 32-byte payment hash. Body `{ paymentHash, note, preimage? }`; `note` is trimmed operator evidence (1–500 characters, no C0/DEL controls). A verified optional preimage is stored in the synthetic kind:9735 tags, but is not required because wallet-internal payments can expose a value that does not hash to the invoice payment hash.
- **Trust / effects:** `DEBUG_TOKEN` plus the required durable note is the settlement authority; when supplied, `preimage` must be 32-byte hex and hash to `paymentHash`. Success claims the payment hash, credits `message.sats` once, writes an `indexed` `nostr_zap_ingest` with `manual=debug-settle` and `note`, fans out the normal zap notification, and inserts the payer gift-reply. The response contains only `{ receiptId, messageId, amountSats, resumed }`, never the note or preimage. If credit succeeded but that direct ingest write failed, a retry writes the missing ingest from the current request, runs the post-credit effects, returns `resumed: true`, and does not credit again.
- **Errors:** 400 `Invalid body` for malformed JSON/types, 400 `Invalid note`, 400 for malformed/mismatched hash or preimage, 404 for a missing invoice/message, 409 for conversation invoices or an already indexed/settled payment, and 503 `Messages are unavailable` when a store operation throws, including the ingest write. A later relay receipt for the same hash is recorded as `rejected`/`settled` and cannot add sats again because the payment-hash claim survives ingest failures and message deletion.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`; unset/blank returns 503 and a bad bearer returns 401. This operator-only authority is the same debug token used for role assignment and session minting.
- **Used by:** `gifts-debug settle <payment-hash> <note> [preimage]` after the normal zap-receipt window has elapsed.

## Endpoint: GET /debug/zap-ingests

- **Purpose:** Operator listing of kind:9735 ingest decisions newest-first (cap 200): `outcome` (`indexed` \| `rejected`), `reason`, receipt id, note/message ids, amount, and the receipt event frame. ISO `createdAt`. Never includes nsec. One `nostr_zap_ingest` row is written per receipt per decision change per process (the memory is per store instance and empty after a restart, so the first tick after boot may write one `rejected`/`duplicate` row per receipt that tick still queries (`listLatest` plus non-null `listReplies` children of those rows)). A repeated identical `outcome:reason` is normally not written again, because the memory is consulted before the write; that is not a guarantee, since the memory is set only after the write resolves, worker ticks are not serialised, and a failed write leaves it untouched. Receipts whose remembered decision is terminal (`indexed` or `rejected`/`duplicate`) skip note lookup, account/LNURL validation, and ingest persist, but still run `verifyReceipt` then `tryEnsureGiftReply`.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 503 `{ error: 'Messages are unavailable' }` when listing throws (`debug.zap_ingests.list_failed`).
- **Used by:** Operators debugging zap receipt indexing.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: GET /debug/messages

- **Purpose:** Operator listing of every persisted forum row newest-first (cap 200): top-level notes **and** replies, live **and** soft-hidden (`deletedAt` set). Public hide does **not** apply. JSON via `serializeDebugMessage` (`id`, `name`, `text`, ISO `createdAt`, `sats`, `hasPhoto`, `photoCount` (0–10), `hasVideo`, `videoContentType`, `parentId`, `eventId`, `nostrPublishState`, ISO-or-null `deletedAt`, `deletedBy`, `authorPubkey`, `nostrAttempts`, and `accountId` as a string or JSON `null` for Damus-only). Never includes `nostrEvent`, `claimedUntil`, `contentFp`, nsec, or photo/video bytes.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 503 `{ error: 'Messages are unavailable' }` when listing throws (`debug.messages.list_failed`).
- **Used by:** Operators inspecting hidden forum notes (`gifts-debug messages`).
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: GET /debug/messages/:id

- **Purpose:** Operator single-note fetch (Bearer `DEBUG_TOKEN`). Returns the debug JSON object (not wrapped) via `serializeDebugMessage`. Soft-hidden rows (`deletedAt` set) are **200** with `deletedAt` / `deletedBy` / `text`. Public `GET /messages/:id` hide does **not** apply. Unknown or non-UUID `:id` is 404. Never includes `nostrEvent`, `contentFp`, nsec, or photo/video bytes.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 404 `{ error: 'Not found' }` when `:id` is not a UUID or the row is missing; 503 `{ error: 'Messages are unavailable' }` when `getById` or serialize throws (`debug.messages.get_failed`).
- **Used by:** Operators fetching one forum note including hidden rows (`gifts-debug message <id>`).
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: GET /debug/messages/:id/photo

- **Purpose:** Operator JPEG/PNG/WebP bytes for a forum note, **including** soft-hidden rows. Same `Content-Type` / `Content-Disposition` / CORS as public `GET /messages/:id/photo`. Public hide does **not** apply: a hidden note with a photo is 200. Missing row, no photo, or non-UUID `:id` is 404. Never returns photo bytes inside JSON.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 404 `{ error: 'Photo not found' }` when `:id` is not a UUID, the row is missing, or `getPhoto` returns null; 503 `{ error: 'Messages are unavailable' }` when the store throws (`debug.messages.photo.get_failed`).
- **Used by:** Operators viewing a hidden forum photo without SSH.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: GET /debug/messages/:id/photo/:file

- **Purpose:** Operator extra still (indices 1–9) **including** soft-hidden rows. Hidden with that extra is **200**. Same headers as public extra / photo 0. `:file` same regex as public.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 404 `{ error: 'Photo not found' }` when `:id` is not a UUID, the row is missing, `:file` is invalid, or `getExtraPhoto` returns null; 503 `{ error: 'Messages are unavailable' }` (`debug.messages.photo.get_failed`).
- **Used by:** Operators viewing a hidden extra still without SSH.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: PUT /debug/messages/:id/video

- **Purpose:** Operator restore of missing forum-video bytes for an existing message with `hasVideo`. Raw body is validated (`decodeForumVideo`), must match the stored MIME extension, and is written under `MEDIA_DIR` so public `GET /messages/:id/video.*` can serve it. Does not create a new message id or change the DB row.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match (checked before the body is read); 404 `{ error: 'Not found' }` for a non-UUID or unknown id; 409 `{ error: 'Message has no video' }` when `hasVideo` is not true or `videoContentType` is missing; 409 `{ error: 'Video type does not match' }` when the decoded type's extension differs from the stored MIME; 400 `{ error: 'Expected a video body' }` for empty, oversize, or unrecognized bytes; 503 `{ error: 'Messages are unavailable' }` when the store or disk write throws (`debug.messages.video.put_failed`).
- **Used by:** Operators restoring a missing on-disk forum video without SSH (`gifts-debug video-put`).
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: POST /debug/messages/:id/restore

- **Purpose:** Operator unhide of a soft-hidden forum note (Bearer `DEBUG_TOKEN`). Calls `MessageStore.markUndeleted`: inverse of `markDeleted`'s cascade (clears `deletedAt` / `deletedBy` on the hidden target and stamp-matched **direct** children; already-live target is a no-op for children). After that succeeds, calls `unblockPubkeyByMessage`, which removes a block only when this id is the source row whose hide created it. Restoring that source row unblocks the pubkey but leaves unrelated cascade-hidden rows hidden; restoring any other row hidden by the external-pubkey cascade makes that row visible but leaves the pubkey blocked, so each such row must be restored separately and new content from the still-blocked pubkey continues to be rejected. Does not recreate the row via `POST /messages`, does not hard-delete, and does not unlink media, invoices, zap receipts, Nostr, text, or photo. Existing live id still 204. Success is 204 empty body. Logs `debug.messages.restored` with `{ messageId }` only (never text, never `deletedBy`).
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 404 `{ error: 'Not found' }` for a non-UUID or unknown id; 503 `{ error: 'Messages are unavailable' }` when `markUndeleted` or `unblockPubkeyByMessage` throws (`debug.messages.restore_failed`).
- **Used by:** Operators unhiding a soft-hidden forum note (`gifts-debug restore`).
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

- **Purpose:** Verifies the assertion and issues `{ token, account }` immediately. Requires `Origin`. `{ token, account }` uses owner JSON including `hasPosted`, `aboutMe`, `aboutMeHasPhoto`, and `notificationLevel`.
- **Errors:** 400 invalid body/origin/challenge/credential; 500 if WebAuthn is unconfigured.
- **Used by:** App passkey sign-in.
- **Auth:** Public (proof is the assertion).

## Endpoint: POST /auth/passkey/register/begin

- **Purpose:** Issues WebAuthn creation options. JSON: challengeId, options. Empty body / no `viewKey` mints a pending new account id (row created only on finish). Optional body `{ "viewKey": "<64-hex>" }` claims an operator-provisioned account (same id/name/lightningAddress/viewKey).
- **Errors:** HTTP 500 `{ error: 'Server auth is not configured' }` if `WEBAUTHN_RP_ID` is unset, blank, not on the allowlist, or no CORS origin matches it; 400 `{ error: 'Expected a JSON body with an optional "viewKey" string' }` when `viewKey` is present but not a string; 404 `{ error: 'This profile could not be found.' }` for a malformed/unknown view key; 409 `{ error: 'This profile already has a passkey' }` when the provisioned account already has a credential.
- **Used by:** App passkey account creation and claim-by-viewKey.
- **Auth:** Public.

## Endpoint: POST /auth/passkey/register/finish

- **Purpose:** Verifies the attestation, creates a `linkingKey: null` account (or binds a passkey to a provisioned account without recreating it), issues `{ token, account }`. Requires `Origin`. `{ token, account }` uses owner JSON including `hasPosted`, `aboutMe`, `aboutMeHasPhoto`, and `notificationLevel`.
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

- **Purpose:** Public JSON of outbound gifts for one UTC day (`?day=YYYY-MM-DD`): `giftCount`, totals (`totalSats` / `totalBtc` / `totalUsd` plus additive `totalChf` / `totalEur` / `totalPhp`), `gifts[]` (`paidAt`, `amountSats`, `amountBtc`, `amountUsd`, `amountChf` / `amountEur` / `amountPhp`, `recipient`), and `fx` (`quote` stays BTC-USD; `fx.quotes` lists USD always and CHF/EUR/PHP when that day has the cross). USD uses that UTC day's Coinbase close; CHF/EUR/PHP are USD × that UTC day's Frankfurter ECB rate. Empty day is 200 with zeros and USD-only `fx.quotes` (no Coinbase / Frankfurter). A gift day that lacks a fiat cross returns that currency as JSON `null`. No invoices.
- **Errors:** 400 `{ "error": "Expected a UTC day (YYYY-MM-DD)" }` when `day` is missing or not a real date; 503 `{ "error": "Gift stats are unavailable" }` on store failure or missing BTC-USD (`gifts.day.fx_incomplete` / `gifts.day.failed`). Missing CHF/EUR/PHP is never 503 (`gifts.day.fiat_failed` still 200).
- **Used by:** App day page (`GET /gifts` same-origin proxy).
- **Auth:** Public.

## Endpoint: GET /me/activity

- **Purpose:** Bearer session JSON of given and received sats for the signed-in account (`donatedSats`, `receivedSats`, `donatedOverTime`, `receivedOverTime`, `fx`). Given is confirmed forum zaps this account paid plus all outbound house gifts when the account is platform. Received is zaps on authored notes (including hidden and replies) plus `message.sats` remainder on **top-level** notes only (so a ₿21 post cannot sit under an empty chart; gift-as-reply `sats` are not Received) plus house gifts to the Lightning handle. Series are the same `spendOverTime` day objects as `GET /gifts/stats` including additive CHF/EUR/PHP. USD = per-gift UTC-day Coinbase BTC-USD close. CHF/EUR/PHP = USD × that UTC day's Frankfurter ECB cross. Empty activity is 200 zeros with USD-only `fx.quotes` (no Coinbase / Frankfurter). Missing CHF/EUR/PHP is JSON `null`. No invoices or payment hashes.
- **Errors:** 401 `{ "error": "Unauthorized" }` without session; 503 `{ "error": "Gift stats are unavailable" }` on store throw or missing BTC-USD (`account.activity.failed` / `account.activity.fx_incomplete`). Missing CHF/EUR/PHP is never 503 (`account.activity.fiat_failed` still 200).
- **Used by:** App `/me/activity` proxy, signed-in profile chart and menu totals.
- **Auth:** Bearer session. No living-room-rules gate.

## Endpoint: GET /members/:accountId/activity

- **Purpose:** Same activity JSON as `GET /me/activity` for the member `:accountId`. Auth matches `GET /members/:accountId`.
- **Errors:** 401 without session; 409 `missing_requirements` when the caller lacks rules; 404 non-uuid or unknown account; 503 gift stats unavailable. Missing fiat is never 503 (same as `GET /me/activity`).
- **Used by:** App `/forum/members/[accountId]/activity` proxy and member profile chart.
- **Auth:** Bearer session with `forum.read`.

## Endpoint: GET /view/:viewKey/activity

- **Purpose:** Public activity JSON for the account behind the 64-hex view key. Same body as `GET /me/activity`.
- **Errors:** 404 `{ "error": "Not found" }` for a bad or unknown key (same as `GET /view/:viewKey`); 503 gift stats unavailable. Missing fiat is never 503 (same as `GET /me/activity`).
- **Used by:** App `/view-key/[viewKey]/activity` proxy and public view profile chart.
- **Auth:** none.

## Endpoint: GET /gifts/stats

- **Purpose:** Public JSON of outbound gift totals: `totalSats` / `totalBtc` / `totalUsd` plus additive `totalChf` / `totalEur` / `totalPhp`, `giftCount`, `recipientCount`, date range, `spendOverTime` (sats+BTC+USD+fiat), `byRecipient`, `byMonth`, and `fx` (`quote` stays BTC-USD; `fx.quotes` lists USD always and CHF/EUR/PHP when at least one selected gift day has that cross). USD uses each gift's UTC-day Coinbase BTC-USD daily close (not spot); CHF/EUR/PHP are USD × that UTC day's Frankfurter ECB rate. A gift day that lacks a fiat cross returns that currency as JSON `null` (totals go null if any selected gift lacks that cross). Optional query `recipient` filters to one Wallet of Satoshi handle (case-insensitive). When `recipient` contains `@` after the first character, the local-part before `@` is used; otherwise the whole trimmed string. Missing/blank `recipient` = unfiltered. Unknown handle = empty stats **200** with zeros and USD-only `fx.quotes` (no Coinbase / Frankfurter). Empty boots are empty **200** with zeros and USD-only `fx.quotes` (no Coinbase / Frankfurter). No invoices.
- **Errors:** 503 `{ "error": "Gift stats are unavailable" }` when the gift store throws, when BTC-USD `ensureDays` fails, or when any selected gift day still lacks BTC-USD after ensure (`gifts.stats.fx_incomplete` / `gifts.stats.failed`). Missing CHF/EUR/PHP is never 503 (`gifts.stats.fiat_failed` still 200).
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

## Endpoint: GET /invoices/passkey

- **Purpose:** Spend-worker only. Query `address=local@domain`. Returns `{ hasPasskey: boolean }` so spend can filter before preflight. Fail closed: unknown address or account without a passkey credential → `hasPasskey: false` (always HTTP 200 on success; never 404).
- **Errors:** 503 if the token env is unset; 401 wrong/missing Bearer; 400 missing or invalid Lightning Address (`Not a valid Lightning Address (expected name@domain)`).
- **Used by:** the external spend worker before issuing a gift invoice.
- **Auth:** `Authorization: Bearer` matching `SPEND_API_TOKEN`.

## Endpoint: GET /invoices/posted

- **Purpose:** Spend-worker only. Query `address=local@domain`. Returns `{ hasPosted, messageId, postedAt }` (`messageId` newest live top-level non-profile id, or null; `postedAt` that row's `createdAt` ISO-8601, or null). `hasPosted: false` always pairs with `messageId: null` and `postedAt: null`. `hasPosted: true` can still have `messageId: null` and `postedAt: null` when `listPostsByAccount` yields no non-profile row. Fail closed: unknown address, or account with no live **top-level** forum message that is not the auto-created profile note → `hasPosted: false`, `messageId: null`, `postedAt: null` (always HTTP 200 on success; never 404). Replies do not count. Photo-only / empty-text top-level notes still count. Damus-only rows (`accountId` null) and soft-deleted rows do not.
- **Errors:** 503 if the token env is unset; 401 wrong/missing Bearer; 400 missing or invalid Lightning Address (`Not a valid Lightning Address (expected name@domain)`).
- **Used by:** the external spend worker before issuing a gift invoice.
- **Auth:** `Authorization: Bearer` matching `SPEND_API_TOKEN`.

## Endpoint: POST /invoices

- **Purpose:** Spend-worker only. Bearer `SPEND_API_TOKEN`. Body `{ address, amountMsat, comment?, messageId? }` (`comment` max 255). Optional `messageId` UUID; when set, 403 Forum post required if not that author's live top-level non-profile note; 503 `Platform account is not configured` if no isPlatform account. Requires a 21.gifts account for `address` that already has a passkey credential and at least one live **top-level** forum message that is not the auto-created profile note. Replies do not unlock (`Forum post required`). Then resolves LUD-16, fetches a BOLT11 via LNURL-pay, decodes hash/amount, stores the invoice in memory.
- **Errors:** 503 if the token env is unset; 503 `{ error: 'Platform account is not configured' }` when `messageId` is set and there is no `isPlatform` account (before LNURL); 401 wrong/missing Bearer; 400 bad JSON/address/amount/`comment` longer than 255 or invalid `messageId` UUID; 403 `{ error: 'Passkey required' }` when there is no account or the account has no passkey (before LNURL); 403 `{ error: 'Forum post required' }` when the account has a passkey but no live top-level non-profile forum row, or when `messageId` is set but is not that author's live top-level non-profile note (after passkey, before LNURL); 502 provider did not issue a matching invoice.
- **Used by:** the external spend worker before paying via lightning.space.
- **Auth:** `Authorization: Bearer` matching `SPEND_API_TOKEN`.

## Endpoint: POST /invoices/proof

- **Purpose:** Spend-worker only. Body `{ id, preimage }`. Accepts the payment preimage as proof (`sha256(preimage)` must equal the stored payment hash). Idempotent for the same preimage. A match inserts an outbound `gift` row when `DATABASE_URL` is set (BOLT11 `pr` as `lightning_invoice`, amount floor(msat/1000) sats, fee 0, recipient handle from the address, description `21gifts daily`, `source_wallet` `lightning.space`); otherwise recording is a no-op. Insert failure logs `gifts.record_failed` and still returns 200. When `invoice.messageId` is set, inserts a platform gift-reply first, then `addSats` (idempotent), then `notifyForumReply` with `auth` (in-app every account except the platform actor, then filtered by each account's `notificationLevel`; Web Push only to bell subscribers, same filter; missing `pushStore` still writes in-app rows; notify failure logs `messages.reply.notify.failed` and still 200); when that message is already a reply (`parentId` set), persists a deterministic `spendGiftReplyId` marker under that reply, `markDeleted` so live `listReplies` omits it, then `addSats`s the reply (a live existing marker is `markDeleted` only and does not `addSats`); skip and log `invoice.gift_reply.failed` if parent/platform missing; still 200.
- **Errors:** 503 unconfigured; 401 unauthorized; 400 bad body or hash mismatch on an unexpired invoice; 404 unknown id (including after unpaid sweep/restart); 409 expired without a matching preimage, or already paid with a different preimage. Matching preimage is 200 after TTL while the row remains.
- **Used by:** the external spend worker after LNDHub `payinvoice` returns a preimage.
- **Auth:** `Authorization: Bearer` matching `SPEND_API_TOKEN`.

## Endpoint: GET /lightning-address

- **Purpose:** Query `address=local@domain`. Resolves LUD-16, cached 5 minutes on success.
- **Errors:** 400 invalid, 502 unresolved.
- **Used by:** App donate `resolveLightningAddress`.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /me

- **Purpose:** Bearer session. Current owner account JSON (id, linkingKey, role, name, `location` (`string | null`, never omit, never `""`), lightning address, verified flag, forumLawsDismissed, `createdAt`, `rulesAgreedAt`, owner `viewKey`, `setup`, `missing`, `hasPosted`, `aboutMe`, `aboutMeHasPhoto`, `notificationLevel`). `hasPosted` is true when the account has a live forum row that is not the auto-created profile note (`profileMessageId` excluded). `aboutMe` is the profile-note text when it is a real bio, else `null` (missing or soft-hidden (`deletedAt` set); auto name-copy is not a bio). `aboutMeHasPhoto` is true when the live profile note has a stored photo. `notificationLevel` is the owner fan-out filter (`all` \| `active` \| `mentions`, default `all`, owner-only). `setup` is the next wizard step (`name` \| `lightning-address` \| `rules`) or `null` when complete; skip timestamps count as done for the wizard. `missing` lists factually unset fields (`name`, `lightning-address`, `rules`) even when skipped. Does not expose `profileMessageId`. Location is not a setup step.
- **Errors:** 401 if missing/expired.
- **Used by:** App `fetchMe`.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /members/:accountId

- **Purpose:** Bearer required. Live member profile card for `:accountId` (UUID): `id`, `name`, `username` (`string | null` LUD-16 / NIP-05 local-part), `location` (`string | null`, never omit, never `""`), `role`, `lightningAddress`, ISO `createdAt`, `profileMessage` (`serializeMessage` with `accountId` / `replyCount` like the signed-in forum list, or `null` when no note or when the profile note is soft-hidden via `deletedAt`), derived `aboutMe` (profile-note text when it is a real bio, else `null` when the profile note is missing or soft-hidden via `deletedAt` (same as `profileMessage`); auto name-copy is not a bio; keep `profileMessage`), `aboutMeHasPhoto` (true when the live profile note has a stored photo; false when `profileMessage` is null), uncapped live `postCount` / `replyCount` from `countByAccount` (not the latest-200 window), and `trust` (`accountTrust`: `verifiedBy` / `proposedBy` / `confirmedBy` / `appointedBy`, each `{ id, name }` or `null`; all-null when no stored edges). Soft-hide does **not** clear `account.profileMessageId`. Never includes `viewKey`, linkingKey, npub, nsec, or `eventId`.
- **Errors:** 401 without session; 409 `{ error: 'missing_requirements', missing: [...] }` when `requireAction(caller, 'forum.read')` fails; 404 `{ error: 'Not found' }` for a non-UUID id or unknown account; 503 `{ error: 'Messages are unavailable' }` when a store throws (`members.get.failed`).
- **Used by:** App member profile surfaces.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /members/:accountId/posts

- **Purpose:** Bearer required. Live-only top-level notes by `:accountId` newest-first, capped at 200 (`listPostsByAccount`). Same `serializeMessage` as signed-in `GET /messages` (`accountId`, `replyCount`, `payable` when a non-empty `eventId` and a non-blank Lightning Address are set). Omits `parentId`. Replies by that member are not listed. A `hasVideo` row whose file is missing or empty is deleted and omitted. For each kept top-level note, missing-file `hasVideo` direct replies in the replies window (cap 200) are deleted (`messages.video.dropped`); `replyCount` is the live direct-reply count of attributed children (a 21.gifts author, or an external row whose `author_pubkey` is a recorded zapper in `nostr_zapper`) minus those dropped.
- **Errors:** 401 without session; 409 `{ error: 'missing_requirements', missing: [...] }` when `requireAction(caller, 'forum.read')` fails; 404 `{ error: 'Not found' }` for a non-UUID id or unknown account; 503 `{ error: 'Messages are unavailable' }` when a store throws (`members.posts.failed`).
- **Used by:** App member profile post feed.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /members/:accountId/replies

- **Purpose:** Bearer required. Live-only replies by `:accountId` newest-first, capped at 200 (`listRepliesByAccount`). `serializeMessage` with `payable` when a non-empty `eventId` and a non-blank Lightning Address are set (same as posts), `accountId`, and optional `parentId` when set; omits `replyCount`. Top-level notes by that member are not listed. A `hasVideo` row whose file is missing or empty is deleted and omitted. A child that cannot serialize (invalid `createdAt`) is omitted; remaining siblings still 200 `{ messages }`.
- **Errors:** 401 without session; 409 `{ error: 'missing_requirements', missing: [...] }` when `requireAction(caller, 'forum.read')` fails; 404 `{ error: 'Not found' }` for a non-UUID id or unknown account; 503 `{ error: 'Messages are unavailable' }` when a store throws (`members.replies.failed`). Invalid `createdAt` on one child is not 503.
- **Used by:** App member profile reply feed.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /view/:viewKey

- **Purpose:** Public capability URL. Read-only profile card (`name`, `location` (`string | null`, never omit, never `""`), `lightningAddress`, `lightningAddressVerified`, `createdAt`, `hasPasskey`, `aboutMe`, `aboutMeHasPhoto`). `hasPasskey` is true when the account already has a passkey credential. `aboutMe` is the profile-note text when it is a real bio, else `null` (missing or soft-hidden (`deletedAt` set); auto name-copy is not a bio). `aboutMeHasPhoto` is true when the live profile note has a stored photo. No auth. Not a session.
- **Errors:** 404 `{ "error": "Not found" }` when the param is not 64 lowercase hex or the key is unknown. 503 `{ "error": "Messages are unavailable" }` when the profile-note read throws (`view.get.failed`).
- **Used by:** Anyone with the link (owner copies `viewKey` from GET `/me`); invite page uses `hasPasskey` for the activation banner.
- **Auth:** none.

## Endpoint: GET /messages

- **Purpose:** Bearer required. After auth, `requireAction(account, 'forum.read')` (needs rules). Lists **top-level** forum notes only (`parent_id` null, `deleted_at` null) newest-first (author name snapshotted at post unless stored `name` trims empty, then `truncatePubkeyDisplay(row.authorPubkey ?? '')` / `'npub'` if the pubkey is missing, `text`, ISO `createdAt`, `sats`, `payable`, `hasPhoto`, `photoCount` (0–10; `hasPhoto` still means photo 0 exists), `hasVideo`, `videoContentType`, live author `role`, and `replyCount` of live direct children that have either an account or a recorded zapper pubkey, `account_id IS NOT NULL OR (author_pubkey IS NOT NULL AND EXISTS (SELECT 1 FROM nostr_zapper WHERE pubkey = lower(author_pubkey)))`), capped at 200 (latest-200 window). Soft-hidden top-level notes are omitted. A `hasVideo` row whose file is missing or empty is deleted and omitted. For each kept top-level note, missing-file `hasVideo` direct replies in the replies window (cap 200) are deleted (`messages.video.dropped`); those children already satisfy the same account-or-recorded-zapper-pubkey visibility predicate; `replyCount` is the live attributed direct-reply count minus those dropped. Replies are never listed here. Clients render chronological messenger-group order (oldest top, newest bottom above the composer). Empty list is 200 `{ messages: [] }`. No photo/video bytes in JSON; signed-in list may include `accountId` (21gifts author id; omitted for external top-level notes); a row with `accountId === null` and a recorded-zapper author pubkey carries `via: 'nostr'` and never the pubkey (same `serializeMessage` rule as `GET /messages/:id`); never includes `deletedAt` / `deletedBy`; `payable` is true when the note has a non-empty `eventId` and the author has a non-blank Lightning Address; missing author → `role` `"basis"` and `payable` false. `videoContentType` is `null` when `hasVideo` is false.
- **Errors:** 401 `{ error: 'Unauthorized' }` missing/invalid/expired bearer; 409 `{ error: 'missing_requirements', missing: ['rules'] }` when rules are not agreed; 503 `{ error: 'Messages are unavailable' }` when the store throws, `serializeMessage` throws (invalid `createdAt`), or author lookup throws (`messages.list.failed`).
- **Used by:** App public comment thread.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /messages/:id

- **Purpose:** Public single-note fetch (no Bearer). Returns the public message JSON via `serializeMessage` (`sats`, `payable`, `hasPhoto`, `photoCount` (0–10; `hasPhoto` still means photo 0 exists), `hasVideo`, `videoContentType`; live `role` for 21gifts authors; `payable` is true when a non-empty `eventId` and a non-blank author Lightning Address are set (top-level or signed reply); an external Nostr-authored row with `accountId` null and a recorded `authorPubkey` omits `role`, sets `payable` false, and includes `via: 'nostr'`). A live reply with `accountId` null is 200 only when `authorPubkey` is set AND recorded as a zapper (checked via `isZapperPubkey`, including on every `sinceSats` poll iteration); otherwise — no `authorPubkey`, or one not yet a recorded zapper — it is 404 `{ "error": "Not found" }` (same body as missing/hidden). Never includes `accountId`, `authorPubkey`, `deletedAt`, or `deletedBy`. Photo/video bytes are never included. Soft-hidden rows (`deletedAt` set) are 404 before any missing-video cleanup. A live `hasVideo` row whose file is missing or empty is deleted (`messages.video.dropped`) and then 404. Optional query `sinceSats` (non-negative integer) long-polls until `sats` is strictly greater than that value (pay sheet / Lightning zap confirmation); timeout still returns 200 with the current body.
- **Errors:** 400 `{ error: 'Expected sinceSats to be a non-negative integer' }` when `sinceSats` is present but not a non-negative integer string; 404 `{ error: 'Not found' }` when `:id` is not a UUID, the row is missing, soft-hidden, a live reply has no account and either no author pubkey or an author pubkey that is not a recorded zapper, or a missing-file video row was dropped; 503 `{ error: 'Messages are unavailable' }` when the store throws, `serializeMessage` throws (invalid `createdAt`), or author lookup throws (`messages.get.failed`). Timeout with unchanged sats remains 200.
- **Used by:** App deep links / share URLs for one forum note; pay sheet / Lightning zap confirmation via `?sinceSats=`.
- **Auth:** none (public).

## Endpoint: GET /messages/:id/replies

- **Purpose:** Bearer optional. Lists direct live replies that have either an account or a recorded zapper pubkey (`account_id IS NOT NULL OR (author_pubkey IS NOT NULL AND EXISTS (SELECT 1 FROM nostr_zapper WHERE pubkey = lower(author_pubkey)))`) for parent `:id` oldest-first (`createdAt` then `id` ASC), capped at 200. Soft-hidden children and rows with no account and either no author pubkey or a not-yet-recorded-zapper author pubkey are omitted. A soft-hidden or missing parent is 404. A `hasVideo` reply whose file is missing or empty is deleted (`messages.video.dropped`) and omitted from `{ messages }`. A child that cannot serialize or whose author lookup throws is omitted; remaining siblings still 200 `{ messages }`. Body is `{ messages: [...] }` (same key as `GET /messages`, not `replies`). Each item is public message JSON with `payable` true when the child has a non-empty `eventId` and the author has a non-blank Lightning Address; external Nostr-authored items instead have `payable` false, omit `role`, and include `via: 'nostr'`; unauthenticated items omit `accountId`; signed-in items include `accountId` only for 21gifts authors; never includes `authorPubkey`, `deletedAt`, or `deletedBy`.
- **Errors:** 404 `{ error: 'Not found' }` when `:id` is not a UUID, the parent is missing, or the parent is soft-hidden; 503 `{ error: 'Messages are unavailable' }` only when `getById` / `listReplies` throws or `dropMissingVideoRow` store/I/O throws (non-ENOENT video I/O or `deleteById`) (`messages.replies.failed`) — a child whose author lookup or serialize throws is omitted and remaining siblings still 200 `{ messages }`.
- **Used by:** App reply thread under a top-level note.
- **Auth:** none (public).

## Endpoint: GET /messages/:id/photo

- **Purpose:** Public. Returns raw photo bytes for one message (`Content-Type` jpeg/png/webp, `Cache-Control: public, max-age=86400`, `Access-Control-Allow-Origin: *`, `Content-Disposition: inline; filename="photo.jpg|png|webp"`) so Nostr clients can load NIP-92 `imeta` URLs. Same bytes at `/photo.jpg`, `/photo.jpeg`, `/photo.png`, and `/photo.webp` because Damus only embeds URLs that look like image files. List JSON never embeds bytes — clients fetch here when `hasPhoto` is true. Soft-hidden rows 404 even when photo bytes remain in the store (handler checks `getById` / `deletedAt` before `getPhoto`). A live reply without an account whose author pubkey is not a recorded zapper (or that has no author pubkey) is the same 404, matching `GET /messages/:id`.
- **Errors:** 404 `{ error: 'Photo not found' }` when the id is missing, not a UUID, soft-hidden, or has no photo; 503 `{ error: 'Messages are unavailable' }` (`messages.photo.failed`).
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

## Endpoint: GET /messages/:id/photo/:file

- **Purpose:** Public extra still for indices 1–9. Param `:file` must match `^([1-9])\.(jpg|jpeg|png|webp)$` (Damus URLs look like `/messages/:id/photo/1.jpg` … `/photo/9.webp`). No `/photo/0.jpg` — photo 0 stays `GET /messages/:id/photo.jpg`. Same bytes/headers as photo 0 (`Content-Type` jpeg/png/webp, `Cache-Control: public, max-age=86400`, `Access-Control-Allow-Origin: *`, `Content-Disposition: inline; filename="photo.jpg|png|webp"`). Soft-hidden rows 404 even when extra bytes remain (`getById` / `deletedAt` before `getExtraPhoto`). A live reply without an account whose author pubkey is not a recorded zapper (or that has no author pubkey) is the same 404, matching `GET /messages/:id`.
- **Errors:** 404 `{ error: 'Photo not found' }` when the id is missing, not a UUID, soft-hidden, has no extra at that index, or `:file` is not `{1-9}.{jpg|jpeg|png|webp}`; 503 `{ error: 'Messages are unavailable' }` (`messages.photo.failed`).
- **Used by:** Damus/Primal via kind:1 extra still URLs; App gallery.
- **Auth:** none.

## Endpoint: POST /messages

- **Purpose:** Bearer required. After auth, `requireAction(account, 'forum.post')` (needs rules + name + Lightning Address; skip timestamps do not satisfy). JSON `{ text?, photo?: { contentType, data }, photos?: { contentType, data }[], inReplyTo? }` (`photos` max 10; non-empty `photos` wins over singular `photo`; dual-send uses `photos`) (base64 JPEG/PNG/WebP ≤ 1 MiB) or `multipart/form-data` with `text`, `video` (MP4/WebM/MOV ≤ 32 MiB), and optional JPEG/PNG/WebP `poster`. Optional `inReplyTo` is a **top-level** parent message UUID (sets `parentId` for a one-level NIP-10 reply; JSON only). Text-only stays valid; photo-only (singular or `photos`) or video-only allowed; at least one of non-empty trimmed text, photo, non-empty `photos`, or video required. Name snapshot. 200 is the public message including `sats`, `payable`, `hasPhoto`, `photoCount` (0–10), `hasVideo`, `videoContentType`, the session account's live `role`, and `accountId` (not wrapped; never `contentFp`). Identical live photo/video from the same account+parent (same normalised text + same media bytes) returns the existing row (200, same id) without consuming the 1/10s burst limiter and without a second push; text-only is unchanged (new row + burst). New notes have `sats` 0 and `payable` false until signed (and stay `payable` false without author LN). Top-level creates call `notifyForumPost` (kind `forum_post`, tag `forum_post:<id>`, url `/notifications`) for every account except the actor, then filtered by each account's `notificationLevel` (Web Push still only to bell subscribers, same filter). After a new top-level persist, the api POSTs `{ address, messageId }` to `{SPEND_URL}/ping` with Bearer `SPEND_API_TOKEN` (fire-and-await, errors logged, still 200). Replies do not ping. A reply calls `notifyForumReply` (kind `forum_reply`, tag `forum_reply:<replyId>`, url `/notifications`) for every account except the actor, then filtered by each account's `notificationLevel` — Damus-only parents still fan out; a self-reply skips only the actor. The booted process always has those stores (in-memory without `DATABASE_URL`, Postgres when it is set). Photo-only empty text still notifies; missing `pushStore` still writes in-app rows; notification or push failure still returns 200. It does not copy into the member↔member inbox. Unpaid replies from anyone except the parent author or `verified` are 403.
- **Errors:** 401 Unauthorized; 409 `{ error: 'missing_requirements', missing: [...] }` when rules, name, and/or Lightning Address are missing (order `rules`, then `name`, then `lightning-address`); 400 Expected a JSON body with text and/or photo; 400 Text must be 1–500 characters; 400 Text must be 1–500 characters or include a photo; 400 Text must be 1–500 characters or include a photo or video; 400 Photo must be a JPEG, PNG, or WebP under 1 MiB; 400 `{ error: 'At most 10 photos' }` when `photos.length > 10`; 400 Poster must be a JPEG, PNG, or WebP under 1 MiB; 400 Video must be an MP4, WebM, or MOV under 32 MiB; 404 `{ error: 'Not found' }` when `inReplyTo` is present but not a UUID, the parent is missing, soft-hidden (`deletedAt` set), or the parent is itself a reply (`parentId !== null`); 403 `{ error: 'A reply needs a Bitcoin payment' }` when `inReplyTo` is a valid parent and the caller is neither the parent author nor `verified`; 429 Too many messages (`Retry-After: 10`); 503 Messages are unavailable (`messages.create.failed`).
- **Used by:** App forum composer and reply composer (exempt free replies only).
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /messages/:id/invoice

- **Purpose:** Bearer required. After auth, `requireAction(payer, 'forum.pay')` (payer needs rules only — never 409 `lightning-address` for the payer). `:id` is a UUID (top-level or a reply — `parentId` is not a mint gate). Body `{ sats, text? }` (`sats` integer 1..10_000_000; optional `text` is the NIP-57 comment, same 1–500 forum rules; omit/whitespace = gift-only). Builds a NIP-57 kind:9734 zap request for the note (content = normalised text), signs it with the payer's custodial key (ensuring one exists when KEK is present), and returns `{ pr, amountSats }` only when the minted BOLT11 is a NIP-57 `description_hash` invoice (`isNip57Invoice`); otherwise persists `not_zap` (with rejected `pr` for debug) and responds 400 `The author's wallet cannot receive this Bitcoin payment` without `pr` in the body. Same author's-wallet 400 for LNURL `noZap`; other LNURL transport failures (`unreachable`) keep `Could not start the Bitcoin payment`. Mint gate is a non-empty signed `eventId` plus a non-blank author Lightning Address; null or empty `eventId` / missing or whitespace-only author LN stay 400 `This message cannot be paid yet` and do not call LNURL (resource state, not payer `missing`). Damus-only notes (`accountId` null) stay 400 `The author's wallet cannot receive this Bitcoin payment` and persist `no_author`. Soft-hidden notes are treated as missing (`not_found` persist + 404). After auth, valid-UUID attempts are persisted best-effort (`message_invoice`); persist failures do not change the HTTP response. The invoice rate limit is applied only after auth, amount, payable, and KEK checks (NIP-57 reject still counts, same as other LNURL failures). Indexed kind:9735 credits the paid row (`:id` that was minted, which may be a reply) — not always the top-level parent. The worker then calls `notifyZap` best-effort (in-app rows for every account except the resolved payer, then filtered by each account's `notificationLevel`; Web Push only to bell subscribers, same filter; enqueue failure logs `push.enqueue.failed`) and inserts a payer gift-reply (`sats` = this zap, gift-only `nostrPublishState` `skipped`) only when that paid row is top-level (`parentId` null). A zap on a reply is `addSats` only (no nested gift-reply). It does not call `notifyForumReply` for that gift-reply.
- **Errors:** 401 Unauthorized; 409 `{ error: 'missing_requirements', missing: ['rules'] }` when the payer has not agreed to rules; 400 bad body / Text must be 1–500 characters / This message cannot be paid yet / The author's wallet cannot receive this Bitcoin payment (`noZap`, `not_zap`) / Could not start the Bitcoin payment (`unreachable` and other LNURL transport failures); 404 Not found (unknown id, soft-hidden id, or non-UUID `:id`, the latter without a persist row); 429 Too many payments (`Retry-After: 10`, after payable checks); 503 Messages are unavailable (missing KEK before limiter, or keygen/sign failure after).
- **Used by:** App pay sheet and paid reply composer for forum notes.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /contact

- **Purpose:** Bearer required. After auth, `requireAction(account, 'contact.post')` (needs rules + name). Body `{ text }`. Private mailbox to 21.gifts — never listed publicly. Name snapshot as forum messages; text uses `normalizeForumText` then still requires 1–500 characters (forum photo-only empty text does not apply). After the platform account exists, persists the contact row first, then opens/appends the member→platform conversation thread so the message is readable via `GET /conversations`. A successful append enqueues a conversation Web Push to bell-subscribed counterparts (`notifyConversationMessage`; failure logs `conversations.push.failed`). Conversation append failure logs `conversations.contact_sync.failed` and still returns 200 (contact is the product surface). 200 is the public contact object (no `accountId`).
- **Errors:** 401 Unauthorized; 409 `{ error: 'missing_requirements', missing: [...] }` when rules and/or name are missing; 400 Expected a JSON body with a "text" string; 400 Text must be 1–500 characters; 503 `{ error: 'Platform account is not configured' }` when no `isPlatform` account exists (neither contact nor thread is written); 503 Contact is unavailable (`contact.create.failed`).
- **Used by:** App in-app contact composer.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /conversations

- **Purpose:** Bearer required. Lists threads the session may see: own member threads plus, when the role is at least moderator, all platform threads. Lists threads with at least one inbound message for the viewer (empty and outbound-only member/Damus omitted). The member's own `member_platform` contact thread is listed when it has a message, even if outbound-only. Inbound = not `conversationFromMe`; Damus null sender is inbound. This list never includes `kind: 'moderator_group'` (the closed group is `GET /conversations/moderator-group`). `GET /conversations/:id` and `POST` are unchanged for outbound-only and empty threads. Newest last-message first (cap 200). Public JSON is `{ conversations: [{ id, kind, name, lastText, lastAt, lastFromMe, lastSats, unread, accountId? }], unreadCount }` — optional counterpart 21.gifts `accountId` (omitted for Damus-only counterparts); no event ids or npubs (Damus-only `name` may be a truncated npub). `lastFromMe` is true when the last message was sent by the viewer, or by the platform identity a staff viewer is acting as; Damus inbound (`senderAccountId` null) is false. `lastSats` is the last message's sats (0 for unpaid text). `unreadCount` is the number of listed rows with `unread: true` (same cap/filter). List GET does not stamp last-read. `DEBUG_TOKEN` cannot read this inbox.
- **Errors:** 401 Unauthorized; 503 `{ error: 'Conversations are unavailable' }` (`conversations.list.failed`).
- **Used by:** App conversation list.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /conversations/:id/read

- **Purpose:** Bearer required. UUID `:id`. After `getById` + `canAccess`, `markRead(id, account.id, new Date(deps.now()))`. 200 `{ ok: true }`. Does not copy DMs into Notifications. `GET /conversations/:id` does not mark read. Registered before `POST /conversations/:id`. `DEBUG_TOKEN` cannot use this.
- **Errors:** 401 Unauthorized; 404 `{ error: 'Not found' }` (unknown / other-account / non-uuid); 503 `{ error: 'Conversations are unavailable' }` (`conversations.read.failed`).
- **Used by:** App mark-conversation-read control.

## Endpoint: GET /conversations/moderator-group

- **Purpose:** Bearer required. Closed moderator-group tool, not the member inbox. At least moderator (`isModeratorGroupMember`: `roleAtLeast` `moderator` and not the platform account): `ensureModeratorGroup` then `{ conversation }` via `publicThread` (`kind: 'moderator_group'`, name `Moderators`, `unread` from `hasUnread`). Verified, basis and the platform account → 404 `{ error: 'Not found' }` (same as `canAccess`, no existence leak). Missing platform or store failure → 503 (`conversations.moderator_group.failed`). Unauthenticated 401. Registered before `GET /:id`.
- **Errors:** 401 Unauthorized; 404 Not found; 503 `{ error: 'Conversations are unavailable' }` (`conversations.moderator_group.failed`).
- **Used by:** App moderator-group tool.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /notifications

- **Purpose:** Bearer required. List `{ notifications, unreadCount }` cap 200 newest-first after the owner's `notificationLevel` filter (`notificationsMatchingLevel` on the newest 1000 stored rows). `unreadCount` is matching unread in that scan, not the unfiltered store count. Each item `type` is `'forum_post' | 'forum_reply' | 'zap' | 'moderator_appointed'`. No account ids. `moderator_appointed` always stays.
- **Errors:** 401 Unauthorized; 503 Notifications are unavailable (`notifications.list.failed`).
- **Used by:** App in-app notification list.
- **Auth:** Bearer session.

## Endpoint: POST /notifications/read-all

- **Purpose:** Bearer required. 200 `{ ok: true }`. Marks every unread notification for the session account read.
- **Errors:** 401 Unauthorized; 503 Notifications are unavailable (`notifications.read_all.failed`).
- **Used by:** App mark-all-read control.
- **Auth:** Bearer session.

## Endpoint: POST /notifications/:id/read

- **Purpose:** Bearer required. UUID `:id`. 200 `PublicNotification` with `readAt` set.
- **Errors:** 401 Unauthorized; 404 Not found (unknown/other/non-uuid); 503 Notifications are unavailable (`notifications.read.failed`).
- **Used by:** App mark-one-read control.
- **Auth:** Bearer session.

## Endpoint: POST /conversations

- **Purpose:** Bearer required. Body `{ forumMessageId }` (forum note UUID). Opens or returns the thread with that note's author (21gifts account or Damus pubkey). 200 is the public conversation object (includes `kind`, `lastFromMe`, `unread`, and optional counterpart `accountId`; empty new threads are `lastFromMe: false` and `unread: false`; Damus-only counterparts omit `accountId`).
- **Errors:** 401 Unauthorized; 400 Expected a JSON body with a "forumMessageId" string; 400 `{ error: 'Cannot message yourself' }` when the author is the session account; 404 `{ error: 'Not found' }` for a non-UUID / missing note / Damus note without pubkey; 503 Conversations are unavailable.
- **Used by:** App "message the author" from a forum note.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /conversations/:id

- **Purpose:** Bearer required. `:id` is a UUID. Messages oldest-first (cap 200) as `{ messages: [{ id, name, text, createdAt, fromMe, sats, accountId? }] }`. Envelope is `{ messages }` only (no counterpart `accountId` on the thread). Optional `accountId` is the sender 21.gifts account (omitted when `senderAccountId` is null). `fromMe` is true when that message was sent by the viewer, or by the platform identity a staff viewer is acting as; Damus inbound (`senderAccountId` null) is false. Optional `?sinceMessageId=` (UUID) long-polls until that id is in the thread (pay-sheet confirmation); timeout still 200 with the current messages. 404 when the session may not see the thread. `moderator_group` is 404 `{ error: 'Not found' }` unless the caller is a group member (`isModeratorGroupMember`: at least moderator, never the platform account) (no existence leak). Unauthenticated 401.
- **Errors:** 401 Unauthorized; 400 `{ error: 'Expected sinceMessageId to be a UUID' }`; 404 Not found; 503 Conversations are unavailable.
- **Used by:** App conversation thread and gift pay-sheet poll.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /conversations/:id/invoice

- **Purpose:** Bearer required. Body `{ sats: <int 1..10_000_000>, text? }`. Issues a NIP-57 BOLT11 to the counterpart's Lightning Address (profile-note `e` tag). 200 `{ pr, amountSats, messageId }` — `messageId` is the predetermined conversation row, inserted only after zap ingest. Gift-only omits text. Damus threads are not invoiced.
- **Errors:** 401 Unauthorized; 400 Expected a JSON body with a positive "sats" integer; 400 Text must be 1–500 characters; 400 Set a name before posting; 400 Cannot message yourself; 400 The author's wallet cannot receive this Bitcoin payment (`noZap`, `not_zap`, Damus, missing counterpart LN / profile event); 400 Could not start the Bitcoin payment (`unreachable` and other LNURL transport failures); 404 Not found; 429 Too many payments; 503 Messages are unavailable / Conversations are unavailable (persist failure after a successful LNURL mint is 503 and the response has no `pr`).
- **Used by:** App inbox amount composer.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /conversations/:id

- **Purpose:** Bearer required. Body `{ text }` 1–500 via `normalizeForumText`. Appends a message. 200 is the public conversation message (includes `fromMe`, true for the viewer, including staff sending as the platform account, and sender `accountId` of the sending 21.gifts account). Moderator replies on a platform thread persist as the platform account (worker signs with the platform nsec). After persist, enqueues one conversation Web Push to bell-subscribed counterparts (`/messages?c=<id>`; `unreadCount` is notification unread + listed inbox unread; `moderator_group` notifies other accounts with `roleAtLeast` `moderator`, not the platform account). Push failure is void-caught (`conversations.push.failed`) so 200 is unchanged. Does not write in-app Notification rows. Local persist does not wait for relay ACK. On `moderator_group`, sender is the caller account (moderator, not platform), `nostrPublishState` skipped (never Nostr). `moderator_group` is 404 `{ error: 'Not found' }` unless the caller is a group member (`isModeratorGroupMember`: at least moderator, never the platform account) (no existence leak). After a new persist, ping `{ address, kind: "moderator" }` only when Lightning Address is a non-empty trimmed string, `spendPing` is set, **and** the caller has a live living-room top-level post (not the profile note) whose `createdAt` is on the same UTC day. No living-room post today → 200, no ping (`spend.ping.skipped` `no_public_post`). Ping throw still 200, no ping. Living-room lookup failure after persist still 200, no ping (`spend.ping.skipped` `posted_unreachable`). Empty/invalid text still 400, no ping.
- **Errors:** 401 Unauthorized; 400 Expected a JSON body with a "text" string; 400 Set a name before posting; 400 Text must be 1–500 characters; 404 Not found; 503 Conversations are unavailable.
- **Used by:** App conversation composer.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /me/forum-laws-dismissed

- **Purpose:** Bearer required. No body. Sets `forumLawsDismissed` to `true` on the account (idempotent; no un-dismiss). Returns the owner account JSON (same as GET `/me`, including `viewKey`).
- **Errors:** 401 without session.
- **Used by:** App welcome-forum living-room laws dismiss control.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: POST /me/notification-level

- **Purpose:** Bearer required like `POST /me/forum-laws-dismissed`. Body `{ "level": "all" | "active" | "mentions" }`. Stores the owner fan-out filter on the account (`notificationLevel`). Default for new and omitted rows is `all` (current every-account behaviour). `active` is the related top-level post with sats>0 (zaps also when amountSats>0). `mentions` is a staff/platform actor or a reply/zap on the recipient's own note. Success is owner JSON including `notificationLevel`. Same level again is still 200. Logs `account.notification_level.set` `{ accountId, level }`.
- **Errors:** 401 `{ error: "Unauthorized" }` without a session; 400 `{ error: "Expected a JSON body with a level of all, active, or mentions" }` when the body is missing, not JSON, or `level` is not one of those three strings.
- **Used by:** App notification-level control on the signed-in profile.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /me/lightning-address

- **Purpose:** Body `{ address }`. Live-resolves LUD-16 well-known metadata, requires zap support (`allowsNostr` + non-empty `nostrPubkey`), then runs a NIP-57 mint probe (`probeNip57Mint` with the account's custodial key). On `ok`, stores the address unverified on the account, then runs `ensureProfileMessage` so a non-blank display name already set gets its profile forum note.
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

- **Purpose:** Bearer required. Body `{ name }`. Stores the trimmed display name on the account (1–80 characters, no C0/DEL control characters). When username is still blank, also stores `usernameFromDisplayName(name)` if that handle is free. When a non-blank Lightning Address is already linked, the first persisted non-empty name also creates exactly one top-level profile forum note (`ensureProfileMessage`) and claims `profileMessageId` via `claimProfileMessageId` (set only while the pointer still matches the missing/hidden read; not exposed on owner JSON); without LN the name is stored and no note is inserted. Rename does not create a second note and does not change the note text.
- **Errors:** 401 without session; 400 if the body is not `{ name: string }` or the name fails validation.
- **Used by:** App `setName`.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: POST /me/username

- **Purpose:** Bearer required. Body `{ username }`. Stores a unique LUD-16 / NIP-05 local-part (lowercase `a-z0-9-_.`, 1–32 characters, leading letter or digit). Cannot be skipped. Same handle on the same account is 200. Logs `account.username.set`.
- **Errors:** 401 `{ error: 'Unauthorized' }`; 400 `{ error: 'Expected a JSON body with a "username" string' }`; 400 `{ error: 'Username must be 1–32 characters of a-z, 0-9, hyphen, underscore, or dot' }`; 409 `{ error: 'Username is already in use' }` when another account owns it, including a unique-index race.
- **Used by:** App username onboarding and profile.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /me/location

- **Purpose:** Bearer required. Body `{ location }`. Stores the trimmed free-text location on the account (at most 80 characters after trim, no C0/DEL control characters). Empty or whitespace-only input stores `null` (clear). Does not call `ensureProfileMessage`. Field is always present on owner JSON as `location` (`string | null`, never omitted, never `""`). Not a setup step, not a posting requirement, not a profile forum note, not Nostr `kind:0`.
- **Errors:** 401 `{ error: "Unauthorized" }` without a session; 400 `{ error: "Expected a JSON body with a \"location\" string" }` when the body is not `{ location: string }`; 400 `{ error: "Location must be at most 80 characters" }` when `normalizeLocation` returns `{ ok: false }`.
- **Used by:** App owner profile location.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: PUT /me/about

- **Purpose:** Bearer required. Body `{ text, photo? }`. `text` is required. `photo` omitted keeps a stored photo; JSON `null` clears it; `{ contentType, data }` is `decodeForumPhoto` (same JPEG/PNG/WebP under 1 MiB as `POST /messages`). Writes About me onto the profile forum note (creates a new live note without a Lightning Address when the note is missing or soft-hidden via `deletedAt`, including photo-only empty text with a decoded photo, then claims `profileMessageId` via `claimProfileMessageId` only while the pointer still matches the missing/hidden read; a lost claim deletes the insert and adopts a live winner). A won inline claim create calls `notifyForumPost` after the writes (best-effort; enqueue failure still 200). Adopting a live CAS winner does not notify. PUT `/about` does not call `ensureProfileMessage` (no name-copy insert). Updating an already-live note does not notify. Empty text with `photo` omitted or `null` and no live note does not create or notify. The hidden row stays hidden. Empty text clears the bio (`aboutMe` null; the live note row is kept). Name-only auto-copy is not a bio, including after a display-name rename (Ada→Grace with note text still `Ada` stays `null`). A live photo still sets `aboutMeHasPhoto`. Requires a display name (not LN). Success is owner JSON with `aboutMe` and `aboutMeHasPhoto`.
- **Errors:** 401 without session; 400 if the body is not `{ text: string }`, text is longer than 500 characters (`About me must be at most 500 characters`), or text contains C0/DEL control characters; 400 `{ error: 'Photo must be a JPEG, PNG, or WebP under 1 MiB' }` when `photo` is present but neither `null` nor a decodable `{ contentType, data }`; 409 `{ error: 'missing_requirements', missing: ['name'] }` when name is blank; 503 `{ error: 'Messages are unavailable' }` when the store throws (`account.about.failed`).
- **Used by:** App profile About me editor.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /me/about/photo

- **Purpose:** Bearer required. Raw profile-note photo bytes via `forumPhotoResponse` (`Content-Type` jpeg/png/webp, `Cache-Control: public, max-age=86400`, `Access-Control-Allow-Origin: *`, inline `photo.jpg|png|webp`). Does not expose `profileMessageId`.
- **Errors:** 401 `{ error: 'Unauthorized' }` without session; 404 `{ error: 'Photo not found' }` when there is no live profile note or no photo; 503 `{ error: 'Messages are unavailable' }` (`account.about.photo.failed`).
- **Used by:** App signed-in About me photo display.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /view/:viewKey/about/photo

- **Purpose:** Public. Same bytes as `GET /me/about/photo` for the account behind the 64-hex view key (`forumPhotoResponse`). No auth. Not a session.
- **Errors:** 404 `{ error: 'Not found' }` when the param is not 64 lowercase hex or the key is unknown; 404 `{ error: 'Photo not found' }` when there is no live profile note or no photo; 503 `{ error: 'Messages are unavailable' }` (`view.photo.failed`).
- **Used by:** App public view-key About me photo.
- **Auth:** none.

## Endpoint: GET /trust-chain

- **Purpose:** Stored trust graph. Bearer session required (any role). Bare `GET` returns founder seeds only (`edges` empty) so a large chain is not dumped on first paint. `?around=<id>` returns that chain member plus one hop of stored public edges with at most one incoming kind per subject: the oldest eligible sibling (`createdAt` then `id`). Eligible: `verify`, `moderator_appoint`, and `moderator_propose` only when the live subject is a `moderator`; `moderator_confirm` never. Later appoint, confirm, or propose do not replace an earlier eligible contact. Neighborhood uses full sibling lists per subject (`listEdgesForSubject`) so a non-touching older eligible edge still wins over a touching newer one. A pending propose stays private. Nodes are founder/moderator/verified (never basis). Never invents edges; omits lightning addresses, view keys, and linking keys.
- **Errors:** 401 `{ error: 'Unauthorized' }` without a session or with an invalid Bearer. 404 `{ error: 'Not found' }` when `around` is supplied but is not a uuid, is unknown, or is not a chain member (including Postgres `22P02`). Omitting `around` (or empty) is founder seeds, not 404. Unauthenticated `around` is 401, not 404. 503 `{ error: 'Trust chain is unavailable' }` when listing accounts or edges throws (`trust.chain.failed`).
- **Used by:** signed-in app `/trust-chain` via app `GET /trust/graph`.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /trust/proposals

- **Purpose:** Bearer session required (moderator; not `DEBUG_TOKEN`). Lists pending `moderator_propose` rows via `pendingModeratorProposals`: live subject `role` is `verified` and the subject has no `moderator_confirm` / `moderator_appoint`. JSON `{ "proposals": [ { subject: { id, name, role: "verified" }, proposedBy: { id, name }, createdAt } ] }` with ISO-8601 `createdAt` (empty list is 200). Oldest `createdAt` first, then propose-edge id. Missing subjects are omitted; a missing actor is `{ id, name: null }`. No `forum.read` / rules gate — a moderator without rules agreement is still 200. Logs `trust.proposals.listed` with `{ count }` only. `GET /trust-chain` still omits a pending `moderator_propose`. Once the subject is a `moderator`, that propose is eligible as the public incoming edge only when it is the oldest eligible sibling (`createdAt` then `id`).
- **Errors:** 401 `{ error: 'Unauthorized' }` without a session; 403 `{ error: 'Forbidden' }` when the live role is not at least moderator; 503 `{ error: 'Trust chain is unavailable' }` when listing accounts/edges or projecting throws (`trust.proposals.failed`).
- **Used by:** Staff moderator-proposal queue in the app.
- **Auth:** `Authorization: Bearer` session (moderator). Not `DEBUG_TOKEN`.

## Endpoint: POST /trust/verify

- **Purpose:** Bearer staff (moderator). Body `{ "accountId": "<uuid>" }`. Confirms the subject in real life: insert `verify` edge then `updateAccount` role=`verified`, log `trust.verified` `{ subjectId, actorId }`, `200 { id, name, role }`. Idempotent 200 when the existing verify edge actor is the caller and the subject is already `verified`. If that caller-owned edge exists and the subject is still `basis`, completes the role write and returns 200.
- **Errors:** 401 `{ error: 'Unauthorized' }` without session; 403 `{ error: 'Forbidden' }` when the caller is not at least moderator; 400 `{ error: 'Expected a JSON body with an "accountId" string' }`; 404 `{ error: 'Not found' }` for a non-UUID or missing subject; 409 `{ error: 'Conflict' }` when the subject is self, a verify edge belongs to someone else, or the subject is ineligible (`role` is not `basis` except the caller-owned retry above); 503 `{ error: 'Trust chain is unavailable' }` on unexpected store throw (`trust.write.failed`).
- **Used by:** Staff verify flow in the app.
- **Auth:** `Authorization: Bearer` session. Staff only.

## Endpoint: POST /trust/propose-moderator

- **Purpose:** Bearer staff. Body `{ "accountId" }`. Subject must be `verified`, not self, and must not already have `moderator_propose` / `moderator_confirm` / `moderator_appoint` (and not already moderator/founder). Inserts `moderator_propose` without changing role; logs `trust.moderator_proposed`; `200 { id, name, role }`.
- **Errors:** Same 401/403/400/404/409/503 JSON shapes as `POST /trust/verify` (409 when the subject is not verified, is self, or already has a staff-grant edge).
- **Used by:** Staff moderator-proposal flow.
- **Auth:** `Authorization: Bearer` session. Staff only.

## Endpoint: POST /trust/confirm-moderator

- **Purpose:** Bearer staff. Body `{ "accountId" }`. A pending `moderator_propose` must exist and the caller id must differ from the proposer's actor id. Subject must still be `verified`. Inserts `moderator_confirm` then sets role to `moderator`, logs `trust.moderator_confirmed`, `200 { id, name, role }`. If the caller already stored `moderator_confirm` and the subject is still `verified`, completes the role write and returns 200; already-moderator with that caller-owned edge is idempotent 200. After a 200 that leaves the subject as `moderator` (new grant and idempotent already-moderator same-actor 200), wrap `notifyModeratorAppointed` for the subject only (in-app `moderator_appointed`, Web Push url `/welcome`). Failure logs `push.enqueue.failed`; persist/HTTP still 200.
- **Errors:** Same 401/403/400/404/409/503 JSON shapes as `POST /trust/verify` (409 when there is no pending propose, the caller proposed, the subject is no longer verified, or a confirm edge belongs to someone else).
- **Used by:** Independent second staff confirmation.
- **Auth:** `Authorization: Bearer` session. Staff only.

## Endpoint: POST /trust/appoint-moderator

- **Purpose:** Bearer founder (moderators → 403). Body `{ "accountId" }`. Subject must not be self, not founder, and not already moderator; may be `basis` or `verified`. Inserts `moderator_appoint` then sets role to `moderator`, logs `trust.moderator_appointed`, `200 { id, name, role }`. If the caller already stored `moderator_appoint` and the subject is not yet `moderator`, completes the role write and returns 200; already-moderator with that caller-owned edge is idempotent 200. After a 200 that leaves the subject as `moderator` (new grant and idempotent already-moderator same-actor 200), wrap `notifyModeratorAppointed` for the subject only (in-app `moderator_appointed`, Web Push url `/welcome`). Failure logs `push.enqueue.failed`; persist/HTTP still 200.
- **Errors:** 401 without session; 403 when the caller is not `founder`; 400/404/409/503 same JSON shapes as `POST /trust/verify`.
- **Used by:** Founder appointment of a moderator.
- **Auth:** `Authorization: Bearer` session. Founder only.

## Endpoint: POST /debug/trust-edges

- **Purpose:** Operator backfill of a stored trust edge. Body `{ "subjectId", "actorId", "kind" }` with `kind` one of `verify` / `moderator_propose` / `moderator_confirm` / `moderator_appoint`. Inserts the edge, logs `debug.trust_edges.inserted` `{ subjectId, actorId, kind }`, and returns `{ id, subjectId, actorId, kind, createdAt }` (`createdAt` ISO-8601). Does **not** change `account.role`. `PATCH /debug/accounts/:id` remains role-only.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 400 `{ error: 'Expected a JSON body with "subjectId", "actorId", and "kind" strings' }`; 404 `{ error: 'Not found' }` when subject or actor is missing or not a UUID; 409 `{ error: 'Conflict' }` on duplicate `(subjectId, kind)` or `subjectId === actorId`; 503 `{ error: 'Trust chain is unavailable' }` on unexpected store throw (`debug.trust_edges.failed`).
- **Used by:** Operator `gifts-debug trust-edge` CLI.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: DELETE /debug/trust-edges

- **Purpose:** Operator delete of a stored trust edge. Body `{ "subjectId", "kind" }` with `kind` one of `verify` / `moderator_propose` / `moderator_confirm` / `moderator_appoint`. Removes the unique `(subjectId, kind)` row, logs `debug.trust_edges.deleted` `{ subjectId, kind }`, and returns the deleted `{ id, subjectId, actorId, kind, createdAt }` (`createdAt` ISO-8601). Does **not** change `account.role`.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 400 `{ error: 'Expected a JSON body with "subjectId" and "kind" strings' }`; 404 `{ error: 'Not found' }` when `subjectId` is not a UUID or no row matches; 503 `{ error: 'Trust chain is unavailable' }` on unexpected store throw (`debug.trust_edges.delete_failed`).
- **Used by:** Operator `gifts-debug trust-edge-delete` CLI.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: POST /me/setup/skip

- **Purpose:** Bearer required. Body `{ step: "name" | "lightning-address" }`. Sets `nameSkippedAt` or `lightningAddressSkippedAt` to now so owner `setup` advances; does not clear or change `name` / `lightningAddress`. Skipping an already-set field is allowed (writes the skip timestamp). Rules cannot be skipped.
- **Errors:** 401 without session; 400 for unknown step, `step: "rules"`, or bad JSON.
- **Used by:** App onboarding skip controls (api-first; app proxy may follow later).
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /debug/external-pubkeys

Operator inspection of external Nostr identities that have earned visibility or have been blocked.

- **Auth:** Requires `Authorization: Bearer <DEBUG_TOKEN>`; unset or blank configuration returns 503 and a mismatch returns 401.
- **Response:** Returns `{ zappers, blocked }`, with lowercase pubkeys, receipt/message references, staff id, and ISO timestamps; both arrays are newest first.
- **Limits:** Each array is independently capped at 200 rows, matching the other operator debug listings.
- **Failure:** A store read failure returns 503 `{ "error": "External pubkeys are unavailable" }` and no partial list.
