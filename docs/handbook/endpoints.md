# HTTP endpoints

## Endpoint: DELETE /me/lightning-address

- **Purpose:** Bearer required. Clears the account Lightning Address, resets `lightningAddressVerified` to false, and clears `lightningAddressSkippedAt`. Does not clear `username`. After unlink, owner `setup` is `username` if the handle is blank; `setup` is `lightning-address` when name is done or skipped **and** username is set. The recovery phrase is not a setup step and does not change `setup` or `missing`.
- **Errors:** 401 without session.
- **Used by:** `unlinkLightningAddress` in the app.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /messages/:id/video.mp4

- **Purpose:** Public MP4 bytes as a sized body (`Content-Length` = body byte length) with `Accept-Ranges` / HTTP 206 `Content-Range` so clients can seek. Best-effort faststart (`moov` before `mdat`) on write; heal-on-read remuxes when the stored file is still mdat-first. `Access-Control-Allow-Origin: *`. Public: hidden rows (`deletedAt` set) are still 404 even when the on-disk file remains. A live reply without an account whose author pubkey is not a recorded zapper (or that has no author pubkey) is the same 404, matching `GET /messages/:id`. Founder/moderator Bearer (`roleAtLeast(..., 'moderator')`): serve hidden-row bytes (keep Range / `Content-Length` / CORS) with `Cache-Control: private, no-store` and `Vary: Authorization` so a staff GET cannot refill a public CDN cache. After deploy, purge or wait out CDN cache for URLs previously served without `Content-Length` (chunked streams that ignored `Range`).
- **Errors:** 404 `{ error: 'Video not found' }` (missing / wrong ext / empty / live withheld zapper reply / soft-hidden without a founder/moderator Bearer); 416 unsatisfiable `Range` (`Content-Range: bytes */SIZE`); 503 `{ error: 'Messages are unavailable' }`.
- **Used by:** Damus/Primal/Safari kind:1 video URLs.
- **Auth:** none for live public GET; founder/moderator Bearer for a hidden row.

## Endpoint: GET /messages/:id/video.webm

- **Purpose:** Same as `video.mp4` for WebM posts (sized body + Range; WebM is not remuxed). Public: hidden still 404. Staff Bearer: serve hidden-row bytes (keep Range / `Content-Length` / CORS) with `Cache-Control: private, no-store` and `Vary: Authorization`.
- **Errors:** Same 404 / 416 / 503.
- **Used by:** Damus/Primal/Safari.
- **Auth:** none for live public GET; founder/moderator Bearer for a hidden row.

## Endpoint: GET /messages/:id/video.mov

- **Purpose:** Same as `video.mp4` for QuickTime posts (sized body + Range + faststart). Public: hidden still 404. Staff Bearer: serve hidden-row bytes (keep Range / `Content-Length` / CORS) with `Cache-Control: private, no-store` and `Vary: Authorization`.
- **Errors:** Same 404 / 416 / 503.
- **Used by:** Damus/Primal/Safari.
- **Auth:** none for live public GET; founder/moderator Bearer for a hidden row.

## Endpoint: DELETE /messages/:id

- **Purpose:** Bearer required. A moderator soft-hides a forum note: stamps `deleted_at` / `deleted_by` on the target and every untagged **direct** reply via `MessageStore.markDeleted`. Does not hard-delete rows, media, invoices, zap receipts, or gifts; does not call `deleteById`. Already-tagged targets keep original stamps and still return 204. When the target itself is external (`accountId === null && authorPubkey !== null`), after `markDeleted` succeeds the route calls the single atomic `blockPubkeyAndHideRows` operation to add the staff kill-switch entitlement block and soft-hide every other live row from that pubkey, then logs `messages.external.blocked` with `{ messageId, hidden: cascaded + 1 }`. Hiding a member note that merely has external children does not block a pubkey or hide that pubkey's other rows; only the normal direct-reply cascade applies. Live public JSON never exposes the stamps; staff GET of a hidden row may include them. After a successful stamp (including already tagged), best-effort NIP-09 `kind: 5` is published for the target and each direct child with a non-empty `eventId` and non-null `accountId`, signed with that row's custodial nsec (not the staff deleter), to the durability relay plus the public relay list (not gated on `NOSTR_PUBLISH` / `NOSTR_PUBLISH_PUBLIC`). Then, when `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_API_TOKEN` are set and `PUBLIC_BASE_URL` resolves, public photo/video URLs for those rows are purged at Cloudflare (`purge_cache` files, chunks of 30). Sign/publish/purge failure still 204; logs `messages.delete.nostr_failed` / `messages.delete.purge_failed` / `messages.delete.retract_failed` with `messageId` only (never nsec, token, or post text). After the stamp (including already tagged), also best-effort retract in-app notifications whose `parentId` or `replyId` is the note or a direct child (`listChildIds` then `deleteByMessageIds([id, ...childIds])`). Retract / `listChildIds` failure logs `messages.delete.notifications_failed` and still 204 (never 503). Debug restore does not undelete Nostr or un-purge. Logs `messages.deleted` with `messageId`, `accountId`, and staff `role` (never post text).
- **Errors:** 401 `{ error: 'Unauthorized' }` without a session; 403 `{ error: 'Forbidden' }` when the live role is not at least moderator (including the author); 404 `{ error: 'Not found' }` for a non-UUID `:id` or missing row; 503 `{ error: 'Messages are unavailable' }` when the store throws (`messages.delete.failed`). NIP-09 / purge / notification retract failure is never 503.
- **Used by:** Staff hide controls in the app forum.
- **Auth:** `Authorization: Bearer` session (moderator).

## Endpoint: GET /messages/hidden

- **Purpose:** Bearer session required (moderator; not `DEBUG_TOKEN`). Inverse **read** of `DELETE /messages/:id`. Lists soft-hidden forum rows (`deletedAt` set) newest-hidden first (`deletedAt` desc, then `id` desc), capped at 200, via `listHidden` / `serializeHiddenMessage`. Listed rows include every hidden row regardless of external-zapper entitlement — this endpoint is a moderation view and is intentionally unaffected by the read-visibility rule described above. Each item includes stored `name` (no empty-name pubkey fallback), ISO `createdAt` / `deletedAt`, `hasPhoto` / `photoCount` / `photoTakenAts` (length equals `photoCount`; null when unknown; `[]` when there are no stills; `photoTakenAt` only when `photoCount === 1`) / `hasVideo` / `videoContentType`, optional `goalSats` (positive integer on a top-level note; omitted when unset/null/0/absent or on a reply), optional `place` when a pin is stored (omitted when unset), always-present `parentId` (JSON `null` on top-level), and `deletedBy: { id, name, role }` resolved from `authStore.getAccount` (missing account keeps the id with `name` / `role` null; null `deletedBy` is `{ id: null, name: null, role: null }`). Optional `via: 'nostr'` is present exactly when `accountId === null && authorPubkey !== null`, the same rule as public message JSON; the pubkey itself is never included. Never includes `accountId`, `eventId`, `nostrPublishState`, `payable`, author `role`, `nostrEvent`, `claimedUntil`, `contentFp`, nsec, or photo/video bytes. Unsigned/non-staff list/GET/photo/video stay 404 for hidden rows; a founder/moderator session may GET the hidden permalink and photo/video. No `forum.read` gate — a moderator without rules agreement is still 200. Logs `messages.hidden.listed` with `{ count }` only (never post text, never message ids). Registered before public `GET /messages/:id` so `"hidden"` is not captured as `:id`. No staff UNHIDE session route.
- **Errors:** 401 `{ error: 'Unauthorized' }` without a session; 403 `{ error: 'Forbidden' }` when the live role is not at least moderator (including the author / verified); 503 `{ error: 'Messages are unavailable' }` when the store, deleter lookup, or serialize throws (`messages.hidden.list_failed`).
- **Used by:** Staff hidden-note log in the app forum.
- **Auth:** `Authorization: Bearer` session (moderator). Not `DEBUG_TOKEN`.

## Endpoint: GET /.well-known/nostr.json

- **Purpose:** NIP-05 directory `{ names, relays }`. `names` keys are those locals (stored username wins over display-name slug; nameless accounts with a stored username are included). CORS `*`. Optional `?name=`.
- **Errors:** 503 `{ error: 'Directory is unavailable' }`.
- **Used by:** Damus verification; app proxies this from the site apex.
- **Auth:** none.

## Endpoint: GET /.well-known/lnurlp/:username

- **Purpose:** LUD-16 payRequest for `username@21.gifts`. Looks up the stored username, then returns the linked Wallet of Satoshi LNURL-pay JSON. Callback and metadata stay on Wallet of Satoshi so gifts still settle there. While an unexpired pending point-of-sale charge exists, both `minSendable` and `maxSendable` become that amount in millisats (`amountSats * 1000`). CORS `*`. `Cache-Control: no-store` so a public cache cannot keep the pin or the unpinned range.
- **Errors:** 404 `{ error: 'Not found' }` when the username is invalid, unknown, or has no linked address; 502 `{ error: 'Lightning Address could not be resolved' }` when WoS is unreachable or the store throws.
- **Used by:** Lightning wallets paying `username@21.gifts`; app proxies this from the site apex.
- **Auth:** none.

## Endpoint: GET /pay/:username

- **Purpose:** Public, unauthenticated pay-link card for a member. Normalises `:username`, loads the account, and returns `name`, `username`, `minSats`, and `maxSats` from the linked Lightning Address LNURL-pay metadata. `name` is the trimmed display name, or the normalised username when the display name is blank. Does not return the callback, the Lightning Address, or provider metadata. No spend token.
- **Errors:** 404 `{ error: 'Not found' }` when the username is invalid, the account is unknown, or `lightningAddress` is blank; 502 `{ error: 'Lightning Address could not be resolved' }` when the stored address is not a LUD-16 address, the provider is unreachable, the store throws, `minSendable` or `maxSendable` is not a safe integer, or `maxSats < minSats`.
- **Used by:** A browser pay page that shows the member and the allowed satoshi range.
- **Auth:** none.

## Endpoint: POST /pay/:username/invoice

- **Purpose:** Public, unauthenticated BOLT11 mint for an exact satoshi amount. Same account lookup as `GET /pay/:username`, then `{ amountSats: number }` must be an integer inside `[minSats, maxSats]` whose millisatoshi value sits inside the provider window. Settlement calls `requestGiftInvoice` on the stored Lightning Address only — never `username@21.gifts`. Response is `{ pr, amountSats }` with no comment sent. No spend token.
- **Errors:** 404 `{ error: 'Not found' }` for an invalid username, unknown account, or blank Lightning Address; 400 `{ error: 'Enter a whole number of sats' }` for missing or invalid JSON, a non-integer, or an amount outside the window; 502 `{ error: 'Lightning Address could not be resolved' }` when the address cannot be resolved, the store throws, the sat window is empty or not a safe integer, the invoice fetch fails, or the BOLT11 is missing, not a safe integer amount, or not for that exact millisatoshi amount.
- **Used by:** The browser pay page minting one invoice for the typed satoshi amount.
- **Auth:** none.

## Endpoint: GET /apple-touch-icon.png

- **Purpose:** PNG brand mark (apple-touch). `Cache-Control: public, max-age=86400`.
- **Errors:** 404 empty body when `public/apple-touch-icon.png` is missing.
- **Used by:** iOS home-screen icon crawlers.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /debug/accounts

- **Purpose:** Operator listing of registered accounts. Same shape as `serializeDebugAccount`: public fields including `username`, plus `isPlatform`, `sessionRefused`, `viewKey`, skip stamps, `profileMessageId`, `notificationLevel`, `walletRequired`, `walletBackupSeenAt`, and Nostr debug fields (`nostrNsecCiphertext` is hex of the stored envelope, never decrypted).
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match.
- **Used by:** Operator `gifts-debug` CLI.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: POST /debug/accounts

- **Purpose:** Operator provision of accounts by display name + Lightning Address (no passkey, `rulesAgreedAt` null). Body `{ "accounts": [ { "name", "lightningAddress" } ] }` (1–100 rows). **All** new addresses are NIP-57 mint-probed (`probeNip57Mint`) first, unless `NIP57_PROBE=0` (e2e only); only then is any row persisted. Name-only updates (address already in store) do **not** probe and run after every new-address probe has passed. Creates a new `basis` row with a fresh `viewKey` and sets `provisionUsername`, or when the address already exists (`lower(trim)` match) updates **only** `name` via `updateAccountNameByLightningAddress` (other columns including `viewKey`, `role`, and `rulesAgreedAt` stay unchanged in that write) then, if stored username is blank, `maybeSetProvisionUsername` fills it (a non-blank stored username is kept). Response `{ accounts: [ { name, lightningAddress, viewKey, created } ] }` includes `viewKey` for the invite link. `GET /debug/accounts` and `GET /debug/accounts/:id` also include `viewKey` (and provisioned `username`).
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 400 `{ error: 'Expected a JSON body with an "accounts" array' }` for invalid/missing/non-JSON body, C0/DEL names, or non-LUD-16 addresses (no row is written); 400 `{ error: LIGHTNING_ADDRESS_NOT_ZAP }` when any new address fails the NIP-57 mint probe (`not_zap`; no new address in that request is saved); 400 `{ error: 'Lightning Address could not be resolved' }` when any new-address probe is unreachable (no new address in that request is saved); 500 `{ error: 'Could not save the account' }` when create does not persist the address, the name-only update matches no row, or the name-only update returns a row whose `name` is not the requested name.
- **Used by:** Operator provisioning before passkey claim.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: GET /debug/accounts/:id

- **Purpose:** Operator read of one account (`serializeDebugAccountDetail`): every account column plus nested `passkeys`, `sessions`, `addressVerification`, and matching `passkeyChallenges`. `nostrNsecCiphertext` is hex of the stored AES-GCM envelope, never decrypted. Nested `sessions[].token` is the stored plaintext token.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 404 `{ error: 'Not found' }` when the id is not a UUID or the account is missing.
- **Used by:** Operator `gifts-debug account`.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: POST /debug/accounts/:id/session

- **Purpose:** Operator mint of a member bearer session for the given account id. Response `{ token }`. For e2e and operator debugging only — not a member login path. An account with `sessionRefused` is refused with no mint and no `debug.accounts.session_minted` log.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 404 `{ error: 'Not found' }` when the account id is unknown; 403 `{ error: 'You signed in with the wrong account. Please try again with the correct account.' }` when `sessionRefused` is true.
- **Used by:** Playwright e2e against the booted process; operators reproducing member HTTP.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: PATCH /debug/accounts/:id

- **Purpose:** Operator assignment of `account.role` (`basis` \| `verified` \| `moderator` \| `founder`), hard-unlink of the Lightning Address, the official platform flag, and/or `sessionRefused`. Body may include any of `{ "role": "<AccountRole>" }`, `{ "lightningAddress": null }`, `{ "platform": true|false }`, `{ "sessionRefused": true|false }`. Unlink sets `lightningAddress` to null, `lightningAddressVerified` to false, and drops in-flight address verification. Setting `platform: true` clears any other platform flag (at most one true) and, when a conversation store is wired, points every `member_platform` thread at this account (`retargetMemberPlatform`), except a thread whose member is already this account. `sessionRefused: true` makes passkey finish and debug session mint return 403 with the wrong-account copy. Returns the updated account JSON (same shape as `GET /debug/accounts` via `serializeDebugAccount`, including `isPlatform`, `sessionRefused`, `viewKey`, `walletRequired`, `walletBackupSeenAt`, and Nostr debug fields). Does not set a new address here (`POST /me/lightning-address` remains the live resolve path).
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 400 `{ error: 'Expected a JSON body with a "role" string, lightningAddress null, platform boolean, and/or sessionRefused boolean' }` for unknown/missing/non-JSON body or a non-null `lightningAddress`; 404 `{ error: 'Not found' }` when the account id is unknown.
- **Used by:** Operator `gifts-debug role` / `gifts-debug unlink` / `gifts-debug refuse-session` CLI and platform-account setup. Does not write trust edges (`POST /debug/trust-edges` is the backfill path).
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: GET /debug/db

- **Purpose:** Operator read of every ordinary table in schema `public`. With no `table`, returns `{ tables: [{ name, rowCount }] }` sorted by name. With `table`, returns one page of 200 rows (`columns`, `rows`) and `nextCursor` when another page exists. Follow `nextCursor` until it is absent to read the whole table. `bytea` values, including `nostr_nsec_ciphertext`, are octet lengths (or null), never the bytes. Text columns named `token`, `challenge`, `nonce`, `view_key`, `endpoint`, `p256dh`, `auth`, or `delivered_endpoints` are the string `"redacted"` when not null. A primary key that is one of those secret columns is paged by `ctid`, so `nextCursor` is not the secret. There is no `limit` that stops early.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 503 `{ error: 'Database is not configured' }` when this process has no SQL client; 404 `{ error: 'Not found' }` when `table` is not an ordinary public table; 400 `{ error: 'Invalid cursor' }` when `cursor` is present without `table` or does not match the table key; 503 `{ error: 'Database is unavailable' }` if the store throws (`debug.db.failed`).
- **Used by:** Operators reading the whole database (`gifts-debug db`).
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: GET /debug/api-log

- **Purpose:** Operator listing of HTTP audit rows newest-first (cap 200): method, redacted path, status, ms, nullable `accountId` (always present; JSON `null` unless `authKind` is `session`), and `authKind` (`session` | `debug` | `spend` | `none`). No query string, Authorization, bodies, or tokens. OPTIONS and `/healthz` are not stored.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 503 `{ error: 'Log is unavailable' }` if the store throws (`api_log.list.failed`).
- **Used by:** Operators attributing who called the API (`gifts-debug api-log`).
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: GET /debug/contacts

- **Purpose:** Operator listing of private in-app contacts newest-first (cap 200), including `accountId`, name snapshot, text, and ISO `createdAt`.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 503 `{ error: 'Contact is unavailable' }` if the store throws (`contact.list.failed`).
- **Used by:** Operators reading the private mailbox.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: GET /debug/invoices

- **Purpose:** Operator listing of all `message_invoice` attempts (forum `POST /messages/:id/invoice` and conversation `POST /conversations/:id/invoice`) newest-first (cap 200): result, HTTP status, BOLT11 `pr`, payment hash, description / description_hash, `isNip57Invoice`, and `lnurlResponse` (raw LNURL callback JSON object or null). ISO `createdAt`. Never includes nsec. Includes `conversationId` and `conversationMessageId` (`null` on forum invoices), plus `fiatPinned` and `amountUsd`, `amountChf`, `amountEur`, and `amountPhp` (`null` when unset). Rejected non-NIP-57 attempts (`not_zap`) still list the rejected `pr` for debug.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 503 `{ error: 'Messages are unavailable' }` when listing throws (`debug.invoices.list_failed`).
- **Used by:** Operators debugging zap invoice issuance (including rejected non-NIP-57 `not_zap` rows with `pr` and raw `lnurlResponse`).
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: POST /debug/invoices/settle

- **Purpose:** Manually settle one successful forum `message_invoice` by its 32-byte payment hash. Body `{ paymentHash, note, preimage? }`; `note` is trimmed operator evidence (1–500 characters, no C0/DEL controls). A verified optional preimage is stored in the synthetic kind:9735 tags, but is not required because wallet-internal payments can expose a value that does not hash to the invoice payment hash.
- **Trust / effects:** `DEBUG_TOKEN` plus the required durable note is the settlement authority; when supplied, `preimage` must be 32-byte hex and hash to `paymentHash`. Success claims the payment hash, credits `message.sats` once, writes an `indexed` `nostr_zap_ingest` with `manual=debug-settle` and `note`. On a member note, fans out `notifyZap` and inserts the payer gift-reply. On the platform profile note, skips `notifyZap` and treats the zap comment as a compose post/reply (`sats` 0) gated by `forum.post`; a created top-level post fans out `notifyForumPost` and `spendPing` only when `eligibleToday` (same gate as `POST /messages`), a reply fans out `notifyForumReply`. The response contains only `{ receiptId, messageId, amountSats, resumed }`, never the note or preimage. If credit succeeded but that direct ingest write failed, a retry writes the missing ingest from the current request, runs the post-credit effects, returns `resumed: true`, and does not credit again.
- **Errors:** 400 `Invalid body` for malformed JSON/types, 400 `Invalid note`, 400 for malformed/mismatched hash or preimage, 404 for a missing invoice/message, 409 for conversation invoices or an already indexed/settled payment, and 503 `Messages are unavailable` when a store operation throws, including the ingest write, or a thrown note-author lookup before claim. A later relay receipt for the same hash is recorded as `rejected`/`settled` and cannot add sats again because the payment-hash claim survives ingest failures and message deletion.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`; unset/blank returns 503 and a bad bearer returns 401. This operator-only authority is the same debug token used for role assignment and session minting.
- **Used by:** `gifts-debug settle <payment-hash> <note> [preimage]` after the normal zap-receipt window has elapsed.

## Endpoint: GET /debug/zap-ingests

- **Purpose:** Operator listing of kind:9735 ingest decisions newest-first (cap 200): `outcome` (`indexed` \| `rejected`), `reason`, receipt id, note/message ids, amount, and the receipt event frame. ISO `createdAt`. Never includes nsec. One `nostr_zap_ingest` row is written per receipt per decision change per process (the memory is per store instance and empty after a restart, so the first tick after boot may write one `rejected`/`duplicate` row per receipt that tick still queries (`listLatest` plus non-null `listReplies` children of those rows, unioned with the official platform profile note's `eventId` even after it ages out of `listLatest`)). A repeated identical `outcome:reason` is normally not written again, because the memory is consulted before the write; that is not a guarantee, since the memory is set only after the write resolves, worker ticks are not serialised, and a failed write leaves it untouched. Receipts whose remembered decision is terminal (`indexed` or `rejected`/`duplicate`) skip note lookup, account/LNURL validation, and ingest persist, but still run `verifyReceipt` then `tryEnsureGiftReply`.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 503 `{ error: 'Messages are unavailable' }` when listing throws (`debug.zap_ingests.list_failed`).
- **Used by:** Operators debugging zap receipt indexing.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: GET /debug/messages

- **Purpose:** Operator listing of every persisted forum row newest-first (cap 200): top-level notes **and** replies, live **and** soft-hidden (`deletedAt` set). Public hide does **not** apply. JSON via `serializeDebugMessage` (`id`, `name`, `text`, ISO `createdAt`, `sats`, `goalSats` (stored column; JSON `null` when unset), `placeLat`, `placeLng`, `placeLabel` (JSON `null` when unset), `hasPhoto`, `photoCount` (0–10), `photoTakenAts` (always; length equals `photoCount`; null when unknown; `[]` when there are no stills), `photoTakenAt` only when `photoCount === 1`, `hasVideo`, `videoContentType`, `parentId`, `eventId`, `nostrPublishState`, `nostrEvent`, `claimedUntil`, `nostrFirstAttemptAt`, `nostrPublishEpoch`, `contentFp`, ISO-or-null `deletedAt`, `deletedBy`, `authorPubkey`, `nostrAttempts`, `accountId` as a string or JSON `null` for Damus-only, plus photo MIME/byte lengths). Never includes nsec or photo/video payloads.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 503 `{ error: 'Messages are unavailable' }` when listing throws (`debug.messages.list_failed`).
- **Used by:** Operators inspecting hidden forum notes (`gifts-debug messages`).
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: GET /debug/messages/:id

- **Purpose:** Operator single-note fetch (Bearer `DEBUG_TOKEN`). Returns the debug JSON object (not wrapped) via `serializeDebugMessage` (same columns as `GET /debug/messages`, including `nostrEvent`, `claimedUntil`, `contentFp`, photo MIME/byte lengths, stored `goalSats` as JSON `null` when unset, and `placeLat` / `placeLng` / `placeLabel` as JSON `null` when unset). Soft-hidden rows (`deletedAt` set) are **200** with `deletedAt` / `deletedBy` / `text`. Public `GET /messages/:id` hide does **not** apply. Unknown or non-UUID `:id` is 404. Never includes nsec or photo/video payloads.
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

- **Purpose:** Issues WebAuthn request options for a discoverable credential. JSON: challengeId, options (`extensions.prf.eval.first` = base64url SHA-256 of `21gifts-nostr-v1`).
- **Errors:** HTTP 500 `{ error: 'Server auth is not configured' }` if `WEBAUTHN_RP_ID` is unset, blank, not on the allowlist, or no CORS origin matches it.
- **Used by:** App passkey sign-in.
- **Auth:** Public.

## Endpoint: POST /auth/passkey/authenticate/finish

- **Purpose:** Verifies the assertion and issues `{ token, account }` immediately. Requires `Origin`. `{ token, account }` uses owner JSON including `hasPosted`, `aboutMe`, `aboutMeHasPhoto`, `notificationLevel`, `funding`, `walletRequired`, `walletBackupSeenAt`, and `passkeyCredentialId`. An account with `sessionRefused` is refused with no bearer.
- **Errors:** 400 invalid body/origin/challenge/credential; 403 `{ error: 'You signed in with the wrong account. Please try again with the correct account.' }` when `sessionRefused` is true; 500 if WebAuthn is unconfigured.
- **Used by:** App passkey sign-in.
- **Auth:** Public (proof is the assertion).

## Endpoint: POST /auth/passkey/register/begin

- **Purpose:** Issues WebAuthn creation options. JSON: challengeId, options (`extensions.prf: {}`). Empty body / no `viewKey` mints a pending new account id (row created only on finish). Optional body `{ "viewKey": "<64-hex>" }` claims an operator-provisioned account (same id/name/lightningAddress/viewKey).
- **Errors:** HTTP 500 `{ error: 'Server auth is not configured' }` if `WEBAUTHN_RP_ID` is unset, blank, not on the allowlist, or no CORS origin matches it; 400 `{ error: 'Expected a JSON body with an optional "viewKey" string' }` when `viewKey` is present but not a string; 404 `{ error: 'This profile could not be found.' }` for a malformed/unknown view key; 409 `{ error: 'This profile already has a passkey' }` when the provisioned account already has a credential.
- **Used by:** App passkey account creation and claim-by-viewKey.
- **Auth:** Public.

## Endpoint: POST /auth/passkey/register/finish

- **Purpose:** Verifies the attestation, creates a `linkingKey: null` account (or binds a passkey to a provisioned account without recreating it), issues `{ token, account }`. Requires `Origin`. `{ token, account }` uses owner JSON including `hasPosted`, `aboutMe`, `aboutMeHasPhoto`, `notificationLevel`, `funding`, `walletRequired`, `walletBackupSeenAt`, and `passkeyCredentialId`. An account with `sessionRefused` is refused with no bearer.
- **Errors:** 400 invalid body/origin/challenge/passkey; 403 `{ error: 'You signed in with the wrong account. Please try again with the correct account.' }` when `sessionRefused` is true; 500 if WebAuthn is unconfigured.
- **Used by:** App passkey account creation and claim-by-viewKey.
- **Auth:** Public (proof is the attestation).

## Endpoint: POST /auth/passkey/replace/begin

- **Purpose:** Bearer session. Refuses to replace a passkey. A recovery phrase is never replaced. Does not create a challenge and does not delete or insert a credential. `walletBackupSeenAt` is not consulted.
- **Errors:** 401 `{ error: 'Unauthorized' }` missing or invalid Bearer; 409 `{ error: 'A recovery phrase cannot be replaced' }` after a valid session; 500 `{ error: 'Server auth is not configured' }` when WebAuthn is unconfigured (checked before the bearer).
- **Used by:** App passkey replace, which the api now refuses.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /auth/passkey/replace/finish

- **Purpose:** Bearer session. Same refusal as begin. Does not parse a ceremony once the session is valid. Does not delete or insert a passkey. Does not mint a session. `walletBackupSeenAt` does not decide whether a seed exists.
- **Errors:** 401 without a session; 409 `{ error: 'A recovery phrase cannot be replaced' }` after a valid session; 500 if WebAuthn is unconfigured.
- **Used by:** App passkey replace, which the api now refuses.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /auth/passkey/seed/begin

- **Purpose:** Bearer session. When `walletRequired` is not true, issues WebAuthn creation options for one extra seed passkey (`{ challengeId, options }`, no `excludeCredentials`, user id and name are the account id). Does not delete the login passkey. `walletRequired: true` means a seed passkey already exists.
- **Errors:** 401 missing or invalid Bearer; 409 `{ error: 'This account already has a recovery phrase' }` when `walletRequired` is true (no challenge); 500 if WebAuthn is unconfigured.
- **Used by:** App add-recovery-phrase for an account that has no seed yet.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /auth/passkey/seed/finish

- **Purpose:** Bearer session. Verifies a `seed` attestation and inserts an additional passkey, setting `walletRequired` true. Does not delete the login passkey, does not change `walletBackupSeenAt`, and does not mint a session. Success JSON is `{ account }` owner JSON. `passkeyCredentialId` is the new credential id. `walletBackupSeenAt` does not decide whether a seed exists.
- **Errors:** 401 without a session, including a `sessionRefused` bearer (resolved before finish, not 409); 409 `{ error: 'This account already has a recovery phrase' }` when `walletRequired` is already true, the credential id is taken, the account is missing, or the insert does not land; 400 invalid body, origin, challenge, or attestation; 500 if WebAuthn is unconfigured.
- **Used by:** App add-recovery-phrase finish.
- **Auth:** `Authorization: Bearer` session.

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

- **Purpose:** Public JSON of outbound gifts for one UTC day (`?day=YYYY-MM-DD`): `giftCount`, totals (`totalSats` / `totalBtc` / `totalUsd` plus additive `totalChf` / `totalEur` / `totalPhp`), `gifts[]` (`paidAt`, `amountSats`, `amountBtc`, `amountUsd`, `amountChf` / `amountEur` / `amountPhp`, `recipient`), and `fx` (`quote` stays BTC-USD; `fx.quotes` lists USD always and CHF/EUR/PHP when that day has the cross). The stored payment-time USD/CHF/EUR/PHP is what is returned (not recomputed from that day's close). Empty day is 200 with zeros and USD-only `fx.quotes` (no Coinbase / Frankfurter). A gift day that lacks a fiat cross returns that currency as JSON `null`. No invoices.
- **Errors:** 400 `{ "error": "Expected a UTC day (YYYY-MM-DD)" }` when `day` is missing or not a real date; 503 `{ "error": "Gift stats are unavailable" }` on store failure or missing BTC-USD (`gifts.day.fx_incomplete` / `gifts.day.failed`). Missing CHF/EUR/PHP is never 503 (`gifts.day.fiat_failed` still 200).
- **Used by:** App day page (`GET /gifts` same-origin proxy).
- **Auth:** Public.

## Endpoint: GET /me/activity

- **Purpose:** Bearer session JSON of given and received sats for the signed-in account (`donatedSats`, `receivedSats`, `donatedOverTime`, `receivedOverTime`, `fx`). Given is confirmed forum zaps this account paid plus all outbound house gifts when the account is platform. Received is zaps on authored notes (including hidden and replies) plus `message.sats` remainder on **top-level** notes only (so a ₿21 post cannot sit under an empty chart; gift-as-reply `sats` are not Received) plus house gifts to the Lightning handle. Series are the same `spendOverTime` day objects as `GET /gifts/stats` including additive CHF/EUR/PHP. The stored payment-time USD/CHF/EUR/PHP is what is returned. Empty activity is 200 zeros with USD-only `fx.quotes` (no Coinbase / Frankfurter). Missing CHF/EUR/PHP is JSON `null`. No invoices or payment hashes.
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

## Endpoint: GET /messages/stats

- **Purpose:** Public count of living forum notes and replies together. `postCount` is the total. `postsOverTime` is one row per UTC day from the first living note through today (or a later note), with `postCount: 0` on days that had none. Soft-hidden notes are omitted. A reply counts the same as a top-level note.
- **Errors:** 503 `{ "error": "Post stats are unavailable" }` when the count query throws (`posts.stats.failed`). An empty forum is 200 `{ postCount: 0, postsOverTime: [] }`.
- **Used by:** The public statistics page.
- **Auth:** Public.

## Endpoint: GET /gifts/stats

- **Purpose:** Public JSON of outbound gift totals: `totalSats` / `totalBtc` / `totalUsd` plus additive `totalChf` / `totalEur` / `totalPhp`, `giftCount`, `recipientCount`, date range, `spendOverTime` (giftCount+sats+BTC+USD+fiat), `byRecipient`, `byMonth`, and `fx` (`quote` stays BTC-USD; `fx.quotes` lists USD always and CHF/EUR/PHP when at least one selected gift day has that cross). The stored payment-time USD/CHF/EUR/PHP is what is returned (not recomputed from that day's close). A gift day that lacks a fiat cross returns that currency as JSON `null` (totals go null if any selected gift lacks that cross). Optional query `recipient` filters to one Wallet of Satoshi handle (case-insensitive). When `recipient` contains `@` after the first character, the local-part before `@` is used; otherwise the whole trimmed string. Missing/blank `recipient` = unfiltered. Unknown handle = empty stats **200** with zeros and USD-only `fx.quotes` (no Coinbase / Frankfurter). Empty boots are empty **200** with zeros and USD-only `fx.quotes` (no Coinbase / Frankfurter). No invoices.
- **Errors:** 503 `{ "error": "Gift stats are unavailable" }` when the gift store throws, when BTC-USD `ensureDays` fails, or when any selected gift day still lacks BTC-USD after ensure (`gifts.stats.fx_incomplete` / `gifts.stats.failed`). Missing CHF/EUR/PHP is never 503 (`gifts.stats.fiat_failed` still 200).
- **Used by:** App statistics page (`GET /gifts/stats` same-origin proxy); optional per-recipient view via `?recipient=`; staff payout-goal widget on `/moderate`.
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

## Endpoint: GET /invoices/eligible

- **Purpose:** Spend-worker only. Query `address=local@domain`. Returns `{ eligible: boolean, status }` so spend can filter before issue and pay admitted members without a roster entry (1 USD). `status` is `effectiveStatus` (`'none' | 'pending' | 'trial' | 'admitted' | 'rejected'`). Unknown address and `basis` are always `{ eligible: false, status: 'none' }` (`basis` must not leak a stored grant). Before UTC `2026-09-25` (`FUNDING_REQUIRED_FROM_UTC`), every other role is `eligible: true` without a grant (`status` still follows `effectiveStatus`). From that day, fail closed unless admitted or trial-today (always HTTP 200 on success; never 404). Expired trial is `status: 'pending'` and `eligible: false` on the gate day.
- **Errors:** 503 if the token env is unset; 401 wrong/missing Bearer; 400 missing or invalid Lightning Address (`Not a valid Lightning Address (expected name@domain)`).
- **Used by:** the external spend worker before issuing a gift invoice.
- **Auth:** `Authorization: Bearer` matching `SPEND_API_TOKEN`.

## Endpoint: GET /invoices/posted

- **Purpose:** Spend-worker only. Query `address=local@domain`. Returns `{ hasPosted, messageId, postedAt, hasMedia }` (`messageId` newest live top-level non-profile id, or null; `postedAt` that row's `createdAt` ISO-8601, or null). `hasPosted` is still any live top-level non-profile post (no media requirement). `hasMedia` is true only when such a post has photo 0, extra stills, or video. `hasPosted: false` always pairs with `messageId: null`, `postedAt: null`, and `hasMedia: false`. `hasPosted: true` can still have `messageId: null` and `postedAt: null` when `listPostsByAccount` yields no non-profile row; `hasMedia` can still be true from an older media post when the newest listed row is text-only. Fail closed: unknown address, or account with no live **top-level** forum message that is not the auto-created profile note → `hasPosted: false`, `messageId: null`, `postedAt: null`, `hasMedia: false` (always HTTP 200 on success; never 404). Replies do not count. Photo-only / empty-text top-level notes still count for `hasPosted`. Damus-only rows (`accountId` null) and soft-deleted rows do not.
- **Errors:** 503 if the token env is unset; 401 wrong/missing Bearer; 400 missing or invalid Lightning Address (`Not a valid Lightning Address (expected name@domain)`).
- **Used by:** the external spend worker before issuing a gift invoice.
- **Auth:** `Authorization: Bearer` matching `SPEND_API_TOKEN`.

## Endpoint: POST /invoices

- **Purpose:** Spend-worker only. Bearer `SPEND_API_TOKEN`. Body `{ address, amountMsat, amountUsd?, comment?, messageId?, groupMessageId? }` (`comment` max 255). Optional `amountUsd` is a positive amount with at most two decimals and at most 100000; a present value is stored as that two-decimal USD (`"5"` becomes `"5.00"`), and a bad present value is the same 400 as a bad body. An absent key stays unset. Optional `messageId` UUID; when set, that note must be that author's live top-level non-profile note **and** have a photo or video (else 403 Forum post required); 503 `Platform account is not configured` if no isPlatform account. Omitted `messageId` stays any live top-level non-profile post (no media requirement; moderator stipend). Optional `groupMessageId` UUID, mutually exclusive with `messageId`. Display-only: stored only when it is that address's message in the closed `moderator_group` thread and an `isPlatform` account exists; otherwise the invoice is still issued and `invoice.group_message_ignored` is logged. A missing conversation store never blocks the 200. The living-room post gate still applies when `groupMessageId` is set. Requires a 21.gifts account for `address` that already has a passkey credential, is `eligibleToday` (before UTC `2026-09-25` every non-`basis` role without a grant; from that day admitted, or trial whose `trialUtcDate` is today UTC; `basis` never), and has at least one live **top-level** forum message that is not the auto-created profile note. Replies do not unlock (`Forum post required`). Then resolves LUD-16, fetches a BOLT11 via LNURL-pay, decodes hash/amount, stores the invoice in memory.
- **Errors:** 503 if the token env is unset; 503 `{ error: 'Platform account is not configured' }` when `messageId` is set and there is no `isPlatform` account (before LNURL); 401 wrong/missing Bearer; 400 bad JSON/address/amount/`comment` longer than 255, invalid `messageId` or `groupMessageId` UUID, or both `messageId` and `groupMessageId` set; 403 `{ error: 'Passkey required' }` when there is no account or the account has no passkey (before LNURL); 403 `{ error: 'Funding grant required' }` when the account has a passkey but is not `eligibleToday` (after passkey, before the living-room post check and LNURL; grant required from UTC 2026-09-25); 403 `{ error: 'Forum post required' }` when the account has a passkey and is eligible but no live top-level non-profile forum row, or when `messageId` is set but is not that author's live top-level non-profile note with a photo or video (after grant, before LNURL); 502 provider did not issue a matching invoice.
- **Used by:** the external spend worker before paying via lightning.space.
- **Auth:** `Authorization: Bearer` matching `SPEND_API_TOKEN`.

## Endpoint: POST /invoices/proof

- **Purpose:** Spend-worker only. Body `{ id, preimage }`. Accepts the payment preimage as proof (`sha256(preimage)` must equal the stored payment hash). Idempotent for the same preimage. A match inserts an outbound `gift` row when `DATABASE_URL` is set (BOLT11 `pr` as `lightning_invoice`, amount floor(msat/1000) sats, fee 0, recipient handle from the address, description `21gifts moderator` when the invoice has `groupMessageId` else `21gifts daily`, `source_wallet` `lightning.space`); otherwise recording is a no-op. Insert failure logs `gifts.record_failed` and still returns 200. When `invoice.messageId` is set, inserts a platform gift-reply first, then `addSats` (idempotent). Platform gift-replies do not notify (no in-app rows, no Web Push; `messages.reply.notify.failed` is not logged on this path; the nested gift-reply still persists); when that message is already a reply (`parentId` set), persists a deterministic `spendGiftReplyId` marker under that reply, `markDeleted` so live `listReplies` omits it, then `addSats`s the reply (a live existing marker is `markDeleted` only and does not `addSats`; no `notifyForumReply`); skip and log `invoice.gift_reply.failed` if parent/platform missing; still 200. When `invoice.groupMessageId` is set, inserts one platform conversation message in that closed `moderator_group` thread (name trimmed or `21.gifts`, `sats` = floor(msat/1000), text = comment · recipient name, `giftForMessageId` set to the triggering message's id); skip and log `invoice.group_gift.failed` if the triggering row/thread/platform is missing; still 200. Repeat proof is idempotent on the deterministic stipend id.
- **Errors:** 503 unconfigured; 401 unauthorized; 400 bad body or hash mismatch on an unexpired invoice; 404 unknown id (including after unpaid sweep/restart); 409 expired without a matching preimage, or already paid with a different preimage. Matching preimage is 200 after TTL while the row remains.
- **Used by:** the external spend worker after LNDHub `payinvoice` returns a preimage.
- **Auth:** `Authorization: Bearer` matching `SPEND_API_TOKEN`.

## Endpoint: GET /lightning-address

- **Purpose:** Query `address=local@domain`. Resolves LUD-16, cached 5 minutes on success.
- **Errors:** 400 invalid, 502 unresolved.
- **Used by:** App donate `resolveLightningAddress`.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /me

- **Purpose:** Bearer session. Current owner account JSON (id, linkingKey, role, name, `username` (`string | null` LUD-16 / NIP-05 local-part), `location` (`string | null`, never omit, never `""`), lightning address, verified flag, forumLawsDismissed, `createdAt`, `rulesAgreedAt`, owner `viewKey`, `setup`, `missing`, `hasPosted`, `aboutMe`, `aboutMeHasPhoto`, `notificationLevel`, `funding`, `walletRequired`, `walletBackupSeenAt`, `passkeyCredentialId`). `hasPosted` is true when the account has a live forum row that is not the profile note (replies still count) OR when `aboutMe` is non-null. A profile note that is only the display-name copy, a photo without bio text, a missing note, and a soft-hidden note do not count. Not the same predicate as GET /invoices/posted (that stays top-level non-profile only). `aboutMe` is the profile-note text when it is a real bio, else `null` (missing or soft-hidden (`deletedAt` set); auto name-copy is not a bio). `aboutMeHasPhoto` is true when the live profile note has a stored photo. `notificationLevel` is the owner fan-out filter (`all` \| `active` \| `mentions`, default `all`, owner-only). `funding` is `null` for `basis`; otherwise always an object (`status: 'none'` when there is no row). `setup` is the next wizard step (`name` \| `username` \| `lightning-address` \| `rules`) or `null` when complete; the api never returns `wallet`. Username is not skippable. The recovery phrase is not a setup step and does not change `setup` or `missing`. Skip timestamps count as done for name and Lightning Address, not username. `missing` lists factually unset fields (`name`, `username`, `lightning-address`, `rules`) even when skipped, and never includes `wallet`. Does not expose `profileMessageId`. Location is not a setup step. An account with `sessionRefused` is 403 (not 401) so the client can sign the visitor out.
- **Errors:** 401 if missing/expired; 403 `{ error: 'You signed in with the wrong account. Please try again with the correct account.' }` when the bearer belongs to an account with `sessionRefused`.
- **Used by:** App `fetchMe`.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /members/:accountId

- **Purpose:** Bearer required. Live member profile card for `:accountId` (UUID): `id`, `name`, `username` (`string | null` LUD-16 / NIP-05 local-part), `location` (`string | null`, never omit, never `""`), `role`, `lightningAddress`, ISO `createdAt`, `profileMessage` (`serializeMessage` with `accountId` / `replyCount` like the signed-in forum list, or `null` when no note or when the profile note is soft-hidden via `deletedAt`), derived `aboutMe` (profile-note text when it is a real bio, else `null` when the profile note is missing or soft-hidden via `deletedAt` (same as `profileMessage`); auto name-copy is not a bio; keep `profileMessage`), `aboutMeHasPhoto` (true when the live profile note has a stored photo; false when `profileMessage` is null), uncapped live `postCount` / `replyCount` from `countByAccount` (not the latest-200 window), `trust` (`accountTrust`: `verifiedBy` / `proposedBy` / `confirmedBy` / `appointedBy`, each `{ id, name }` or `null`; all-null when no stored edges), and `fundingReviewedAt` (`grant.admittedAt` when the effective grant is admitted, else `null`; does not expose pending/trial/rejected). Soft-hide does **not** clear `account.profileMessageId`. Never includes `viewKey`, linkingKey, npub, nsec, or `eventId`.
- **Errors:** 401 without session; 409 `{ error: 'missing_requirements', missing: [...] }` when `requireAction(caller, 'forum.read')` fails; 404 `{ error: 'Not found' }` for a non-UUID id or unknown account; 503 `{ error: 'Messages are unavailable' }` when a store throws (`members.get.failed`).
- **Used by:** App member profile surfaces.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /members/:accountId/posts

- **Purpose:** Bearer required. Live-only top-level notes by `:accountId` newest-first, capped at 200 (`listPostsByAccount`). Same `serializeMessage` as signed-in `GET /messages` (`accountId`, `replyCount`, `payable` when a non-empty `eventId` and a non-blank Lightning Address are set). Omits `parentId`. Omits `goalSats` when unset (null/0/absent); includes the key only when a positive whole-sat goal is stored on a top-level note. Replies by that member are not listed. A `hasVideo` row whose file is missing or empty is deleted and omitted. For each kept top-level note, missing-file `hasVideo` direct replies in the replies window (cap 200) are deleted (`messages.video.dropped`); `replyCount` is the live direct-reply count of attributed children (a 21.gifts author, or an external row whose `author_pubkey` is a recorded zapper in `nostr_zapper`) minus those dropped.
- **Errors:** 401 without session; 409 `{ error: 'missing_requirements', missing: [...] }` when `requireAction(caller, 'forum.read')` fails; 404 `{ error: 'Not found' }` for a non-UUID id or unknown account; 503 `{ error: 'Messages are unavailable' }` when a store throws (`members.posts.failed`).
- **Used by:** App member profile post feed.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /members/:accountId/replies

- **Purpose:** Bearer required. Live-only replies by `:accountId` newest-first, capped at 200 (`listRepliesByAccount`). `serializeMessage` with `payable` when a non-empty `eventId` and a non-blank Lightning Address are set (same as posts), `accountId`, and optional `parentId` when set; omits `replyCount`. Omits `goalSats` when unset (null/0/absent; replies never include it). Top-level notes by that member are not listed. A `hasVideo` row whose file is missing or empty is deleted and omitted. A child that cannot serialize (invalid `createdAt`) is omitted; remaining siblings still 200 `{ messages }`.
- **Errors:** 401 without session; 409 `{ error: 'missing_requirements', missing: [...] }` when `requireAction(caller, 'forum.read')` fails; 404 `{ error: 'Not found' }` for a non-UUID id or unknown account; 503 `{ error: 'Messages are unavailable' }` when a store throws (`members.replies.failed`). Invalid `createdAt` on one child is not 503.
- **Used by:** App member profile reply feed.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /view/:viewKey

- **Purpose:** Public capability URL. Read-only nine-field profile card (`name`, `username` (`string | null` LUD-16 / NIP-05 local-part), `location` (`string | null`, never omit, never `""`), `lightningAddress`, `lightningAddressVerified`, `createdAt`, `hasPasskey`, `aboutMe`, `aboutMeHasPhoto`). `hasPasskey` is true when the account already has a passkey credential. `aboutMe` is the profile-note text when it is a real bio, else `null` (missing or soft-hidden (`deletedAt` set); auto name-copy is not a bio). `aboutMeHasPhoto` is true when the live profile note has a stored photo. No auth. Not a session.
- **Errors:** 404 `{ "error": "Not found" }` when the param is not 64 lowercase hex or the key is unknown. 503 `{ "error": "Messages are unavailable" }` when the profile-note read throws (`view.get.failed`).
- **Used by:** Anyone with the link (owner copies `viewKey` from GET `/me`); invite page uses `hasPasskey` for the activation banner.
- **Auth:** none.

## Endpoint: GET /messages

- **Purpose:** Bearer required. After auth, `requireAction(account, 'forum.read')` (needs rules). Lists **top-level** forum notes only (`parent_id` null, `deleted_at` null) via `listFeed`. A profile note is omitted only when its trimmed text equals the display name or the name stored on the note (case-insensitive) and it has no photo and no video. A profile note with other About me text stays in the feed. `GET /messages/:id`, `listLatest`, and `listPostsByAccount` are unchanged. Query: `mode` (`all` default, `active` = paid notes plus unpaid founder/moderator notes plus top-level notes with `goalSats` > 0, `unpaid` = `sats = 0`, `popular` = paid sats-desc), `limit` (1–200, default 200), opaque `cursor` (keyset), optional `hashtag` (name without `#`; token match on `text`; combines with mode/limit/cursor). Body `{ messages }` plus `nextCursor` when `listFeed` returned `limit` rows (before missing-file video drops on listed parents). Newest-first except `popular`. Each row includes author name snapshotted at post unless stored `name` trims empty, then `truncatePubkeyDisplay(row.authorPubkey ?? '')` / `'npub'` if the pubkey is missing, `text`, ISO `createdAt`, `sats`, `payable`, `hasPhoto`, `photoCount` (0–10; `hasPhoto` still means photo 0 exists), `photoTakenAts` (always; length equals `photoCount`; null when unknown; `[]` when there are no stills), `photoTakenAt` only when `photoCount === 1`, `hasVideo`, `videoContentType`, live author `role`, and `replyCount` of live direct children that have either an account or a recorded zapper pubkey (`account_id IS NOT NULL OR (author_pubkey IS NOT NULL AND EXISTS (SELECT 1 FROM nostr_zapper WHERE pubkey = lower(author_pubkey)))`). Soft-hidden top-level notes are omitted. A `hasVideo` row whose file is missing or empty is deleted and omitted. The list path does **not** load replies or drop missing-file video children (`GET /messages/:id/replies` still does). Replies are never listed here. Clients render chronological messenger-group order (oldest top, newest bottom above the composer). Empty list is 200 `{ messages: [] }`. No photo/video bytes in JSON; signed-in list may include `accountId` (21gifts author id; omitted for external top-level notes); a row with `accountId === null` and a recorded-zapper author pubkey carries `via: 'nostr'` and never the pubkey (same `serializeMessage` rule as `GET /messages/:id`); never includes `deletedAt` / `deletedBy`; omits `goalSats` when unset (null/0/absent) and includes the key only when a positive whole-sat goal is stored on a top-level note; `payable` is true when the note has a non-empty `eventId` and the author has a non-blank Lightning Address; missing author → `role` `"basis"` and `payable` false. `videoContentType` is `null` when `hasVideo` is false. Each message includes `place` only when a pin is stored (same omit rule as parentId).

- **Errors:** 401 `{ error: 'Unauthorized' }` missing/invalid/expired bearer; 400 `{ error: 'Invalid mode' }` / `{ error: 'Invalid limit' }` / `{ error: 'Invalid cursor' }` / `{ error: 'Invalid hashtag' }`; 409 `{ error: 'missing_requirements', missing: ['rules'] }` when rules are not agreed; 503 `{ error: 'Messages are unavailable' }` when the store throws, `serializeMessage` throws (invalid `createdAt`), or author lookup throws (`messages.list.failed`).
- **Used by:** App public comment thread.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /messages/compose-target

- **Purpose:** Bearer required. After auth, `requireAction(account, 'forum.post')` (needs rules + name + username + Lightning Address; skip timestamps do not satisfy; username cannot be skipped). Returns `{ messageId, sats }` for the official platform profile note so a basis account can invoice 1 sat to 21.gifts before posting or replying. Ensures that profile note exists. A later indexed member/invoice zap on that note turns the zap comment into the payer's top-level post (`sats` 0). An external zap on that same note still inserts `insertExternalGiftReply`. The worker always includes that profile note's `event_id` in the relay query, even after the note ages out of `listLatest`. A comment `inReplyTo:<uuid>\n<body>` becomes a reply on that live top-level parent; a missing, hidden, or nested parent falls back to a top-level post with the remaining body. An empty comment does not create a blank living-room post.
- **Errors:** 401 `{ error: 'Unauthorized' }` missing/invalid/expired bearer; 409 `{ error: 'missing_requirements', missing: [...] }` when rules, name, username, and/or Lightning Address are missing (order `rules`, then `name`, then `username`, then `lightning-address`); 400 `{ error: 'This message cannot be paid yet' }` when the platform note has no non-empty `eventId` or the platform account has a blank Lightning Address; 503 `{ error: 'Messages are unavailable' }` when no `isPlatform` account exists, the profile note id is missing, the row is missing or soft-hidden, or the store throws (`messages.compose_target.failed`).
- **Used by:** App forum composer (`fetchComposeTarget`) before `POST /messages/:id/invoice` on the returned `messageId`.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /messages/places

- **Purpose:** Bearer required. After auth, `requireAction(account, 'forum.read')`. Lists live top-level notes that have both coordinates (`parent_id` null, `deleted_at` null, `place_lat` and `place_lng` not null) via `listPlaces`. Query `limit` (integer 1–1000, default 1000). Body `{ places: [{ id, name, createdAt, lat, lng, label }] }`. `createdAt` is ISO-8601. Newest `createdAt` then `id` descending. `label` is a string or null. Replies and soft-hidden notes are excluded. No photo bytes.
- **Errors:** 401 `{ error: 'Unauthorized' }`; 400 `{ error: 'Invalid limit' }`; 409 `{ error: 'missing_requirements', missing: [...] }` when `forum.read` fails; 503 `{ error: 'Messages are unavailable' }` when `listPlaces` throws (`messages.places.failed`).
- **Used by:** App map of live forum pins.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /translate

- **Purpose:** `{ available: boolean }` is true only when `TRANSLATE_URL` is a valid http(s) URL and `TRANSLATE_API_KEY` is non-blank after trim. No DeepL call. Always 200.
- **Errors:** none.
- **Used by:** App `GET /translate` proxy; `NoteTranslate` availability.
- **Auth:** Public.

## Endpoint: POST /messages/:id/translate

- **Purpose:** `{ target: en|de|es|fil }` translates the stored `message.text`. Looks up `message_translation` for `(message_id, target_lang)` first; a matching `source_sha256` of that text is returned as `{ translatedText, cached: true }` with no DeepL call. A miss or a changed source hashes, then one DeepL POST (concurrent callers of the same key share it), then upsert (first writer for a hash wins). `fil` → DeepL `TL`. Empty text 400. Same visibility as `GET /messages/:id` (unsigned 404 for hidden/withheld; staff may translate a hidden permalink; a live `hasVideo` row whose file is missing or empty is deleted (`messages.video.dropped`) then 404; staff-hidden rows skip this cleanup).
- **Errors:** 400 `{ error: 'Invalid body' }` bad JSON, unknown target, or empty text; 404 `{ error: 'Not found' }` bad id / missing / withheld / unsigned hidden / missing-file video; 502 `{ error: 'Translate upstream failed' }`; 503 `{ error: 'Translate is not configured' }` missing URL/key; 503 `{ error: 'Messages are unavailable' }` store throw (`messages.translate.failed`).
- **Used by:** App `POST /translate` with `{ messageId, target }`.
- **Auth:** none for a live public note; founder/moderator Bearer for a hidden permalink.

## Endpoint: GET /messages/:id

- **Purpose:** Public single-note fetch (no Bearer for a live row). Returns the public message JSON via `serializeMessage` (`sats`, optional `goalSats` on a top-level note when the stored ask is a positive integer, optional `place` when a pin is stored and omitted when unset, `payable`, `hasPhoto`, `photoCount` (0–10; `hasPhoto` still means photo 0 exists), `photoTakenAts` (always; length equals `photoCount`; null when unknown; `[]` when there are no stills), `photoTakenAt` only when `photoCount === 1`, `hasVideo`, `videoContentType`; live `role` for 21gifts authors; `payable` is true when a non-empty `eventId` and a non-blank author Lightning Address are set (top-level or signed reply); an external Nostr-authored row with `accountId` null and a recorded `authorPubkey` omits `role`, sets `payable` false, and includes `via: 'nostr'`). A live reply with `accountId` null is 200 only when `authorPubkey` is set AND recorded as a zapper (checked via `isZapperPubkey`, including on every `sinceSats` poll iteration); otherwise — no `authorPubkey`, or one not yet a recorded zapper — it is 404 `{ "error": "Not found" }` (same body as missing/hidden). Live GET omits `deletedAt` / `deletedBy`; unauthenticated live GET still omits `accountId`. Omits `goalSats` when unset (null/0/absent); includes the key only when a positive whole-sat goal is stored on a top-level note. Photo/video bytes are never included. Unsigned visitors and non-staff still 404 `{ error: 'Not found' }` for soft-hidden rows (`deletedAt` set) before any missing-video cleanup (same body as today; no `deletedAt` in the 404 body). A founder or moderator Bearer (`roleAtLeast(..., 'moderator')`, no `forum.read`) is 200 public JSON plus `deletedAt` ISO, `deletedBy.{id,name,role}`, `payable: false`, and `accountId` for 21gifts authors; skip missing-video drop; do not long-poll `sinceSats` on hidden rows. A live `hasVideo` row whose file is missing or empty is deleted (`messages.video.dropped`) and then 404. Optional query `sinceSats` (non-negative integer) long-polls until `sats` is strictly greater than that value (pay sheet / Lightning zap confirmation); timeout still returns 200 with the current body. A top-level note (parent id null), whether the live public body or the founder/moderator hidden body, includes `replyCount` of live direct children with an account or a recorded zapper pubkey; a reply omits `replyCount`.
- **Errors:** 400 `{ error: 'Expected sinceSats to be a non-negative integer' }` when `sinceSats` is present but not a non-negative integer string; 404 `{ error: 'Not found' }` when `:id` is not a UUID, the row is missing, a live reply has no account and either no author pubkey or an author pubkey that is not a recorded zapper, a missing-file video row was dropped, or a soft-hidden row is requested without a founder/moderator Bearer; 503 `{ error: 'Messages are unavailable' }` when the store throws, `serializeMessage` throws (invalid `createdAt`), or author lookup throws (`messages.get.failed`). Timeout with unchanged sats remains 200.
- **Used by:** App deep links / share URLs for one forum note; pay sheet / Lightning zap confirmation via `?sinceSats=`.
- **Auth:** none for live public GET; founder/moderator Bearer for a hidden permalink.

## Endpoint: GET /messages/:id/replies

- **Purpose:** Bearer optional. Lists direct live replies that have either an account or a recorded zapper pubkey (`account_id IS NOT NULL OR (author_pubkey IS NOT NULL AND EXISTS (SELECT 1 FROM nostr_zapper WHERE pubkey = lower(author_pubkey)))`) for parent `:id` oldest-first (`createdAt` then `id` ASC), capped at 200. Soft-hidden children and rows with no account and either no author pubkey or a not-yet-recorded-zapper author pubkey are omitted for unsigned/non-staff. A hidden or missing parent is 404 for unsigned/non-staff (same body as today). A founder or moderator Bearer (`roleAtLeast(..., 'moderator')`, no `forum.read`) is 200 `{ messages }` from `listReplies(id, MESSAGE_LIST_LIMIT, true)` including hidden attributed children with hide stamps (`deletedAt` ISO, `deletedBy.{id,name,role}`) and `payable: false`, whether the parent is live or hidden. Live children stay live serialize. A `hasVideo` reply whose file is missing or empty is deleted (`messages.video.dropped`) and omitted from `{ messages }` (live children). A child that cannot serialize or whose author lookup throws is omitted; remaining siblings still 200 `{ messages }`. Body is `{ messages: [...] }` (same key as `GET /messages`, not `replies`). Each live item is public message JSON with `payable` true when the child has a non-empty `eventId` and the author has a non-blank Lightning Address; external Nostr-authored items instead have `payable` false, omit `role`, and include `via: 'nostr'`; unauthenticated items omit `accountId`; signed-in items include `accountId` only for 21gifts authors; live JSON never includes `authorPubkey`, `deletedAt`, or `deletedBy`; omits `goalSats` when unset (null/0/absent; replies never include it — a positive whole-sat goal is only stored on a top-level note).
- **Errors:** 404 `{ error: 'Not found' }` when `:id` is not a UUID, the parent is missing, or a hidden parent is requested without a founder/moderator Bearer; 503 `{ error: 'Messages are unavailable' }` only when `getById` / `listReplies` throws or `dropMissingVideoRow` store/I/O throws (non-ENOENT video I/O or `deleteById`) (`messages.replies.failed`) — a child whose author lookup or serialize throws is omitted and remaining siblings still 200 `{ messages }`.
- **Used by:** App reply thread under a top-level note.
- **Auth:** none for a live parent; founder/moderator Bearer for a hidden parent.

## Endpoint: GET /messages/:id/photo

- **Purpose:** Public. Returns raw photo bytes for one message (`Content-Type` jpeg/png/webp, `Cache-Control: public, max-age=86400`, `Access-Control-Allow-Origin: *`, `Content-Disposition: inline; filename="photo.jpg|png|webp"`) so Nostr clients can load NIP-92 `imeta` URLs. Same bytes at `/photo.jpg`, `/photo.jpeg`, `/photo.png`, and `/photo.webp` because Damus only embeds URLs that look like image files. List JSON never embeds bytes — clients fetch here when `hasPhoto` is true. Public/Damus (no staff bearer): hidden rows 404 `{ error: 'Photo not found' }` even when bytes remain (handler checks `getById` / `deletedAt` before `getPhoto`). A live reply without an account whose author pubkey is not a recorded zapper (or that has no author pubkey) is the same 404, matching `GET /messages/:id`. Founder/moderator Bearer: serve hidden-row bytes with CORS `*` and `Cache-Control: private, no-store` plus `Vary: Authorization` (do not reuse the live public cache header).
- **Errors:** 404 `{ error: 'Photo not found' }` when the id is missing, not a UUID, has no photo, is a live withheld zapper reply, or is soft-hidden without a founder/moderator Bearer; 503 `{ error: 'Messages are unavailable' }` (`messages.photo.failed`).
- **Used by:** App forum photo display; Damus/Primal via kind:1 photo URLs.
- **Auth:** none for live public GET; founder/moderator Bearer for a hidden row.

## Endpoint: GET /messages/:id/photo.jpg

- **Purpose:** Same public bytes as `GET /messages/:id/photo`. Kind:1 and `imeta` use this path so Damus embeds the image instead of a website card.
- **Errors:** Same 404 / 503 as `GET /messages/:id/photo`.
- **Used by:** Damus, Primal, njump via kind:1 photo URLs.
- **Auth:** none for live public GET; founder/moderator Bearer for a hidden row.

## Endpoint: GET /messages/:id/photo.jpeg

- **Purpose:** Alias of `GET /messages/:id/photo.jpg`.
- **Errors:** Same 404 / 503 as `GET /messages/:id/photo`.
- **Used by:** Clients that request `.jpeg`.
- **Auth:** none for live public GET; founder/moderator Bearer for a hidden row.

## Endpoint: GET /messages/:id/photo.png

- **Purpose:** Same handler as `GET /messages/:id/photo` when the stored type is PNG. Kind:1 URLs use `.png` for PNG posts.
- **Errors:** Same 404 / 503 as `GET /messages/:id/photo`.
- **Used by:** Damus/Primal for PNG forum photos.
- **Auth:** none for live public GET; founder/moderator Bearer for a hidden row.

## Endpoint: GET /messages/:id/photo.webp

- **Purpose:** Same handler as `GET /messages/:id/photo` when the stored type is WebP. Kind:1 URLs use `.webp` for WebP posts.
- **Errors:** Same 404 / 503 as `GET /messages/:id/photo`.
- **Used by:** Damus/Primal for WebP forum photos.
- **Auth:** none for live public GET; founder/moderator Bearer for a hidden row.

## Endpoint: GET /messages/:id/photo/:file

- **Purpose:** Public extra still for indices 1–9. Param `:file` must match `^([1-9])\.(jpg|jpeg|png|webp)$` (Damus URLs look like `/messages/:id/photo/1.jpg` … `/photo/9.webp`). No `/photo/0.jpg` — photo 0 stays `GET /messages/:id/photo.jpg`. Same bytes/headers as photo 0 (`Content-Type` jpeg/png/webp, `Cache-Control: public, max-age=86400`, `Access-Control-Allow-Origin: *`, `Content-Disposition: inline; filename="photo.jpg|png|webp"`). Public/Damus (no staff bearer): hidden rows 404 even when extra bytes remain (`getById` / `deletedAt` before `getExtraPhoto`). A live reply without an account whose author pubkey is not a recorded zapper (or that has no author pubkey) is the same 404, matching `GET /messages/:id`. Founder/moderator Bearer: same staff exception as `GET /messages/:id/photo` (hidden-row bytes with `Cache-Control: private, no-store` and `Vary: Authorization`).
- **Errors:** 404 `{ error: 'Photo not found' }` when the id is missing, not a UUID, has no extra at that index, `:file` is not `{1-9}.{jpg|jpeg|png|webp}`, is a live withheld zapper reply, or is soft-hidden without a founder/moderator Bearer; 503 `{ error: 'Messages are unavailable' }` (`messages.photo.failed`).
- **Used by:** Damus/Primal via kind:1 extra still URLs; App gallery.
- **Auth:** none for live public GET; founder/moderator Bearer for a hidden row.

## Endpoint: POST /messages

- **Purpose:** Bearer required. After auth, `requireAction(account, 'forum.post')` (needs rules + name + username + Lightning Address; skip timestamps do not satisfy; username cannot be skipped). JSON `{ text?, photo?: { contentType, data, takenAt? }, photos?: { contentType, data, takenAt? }[], inReplyTo?, goalSats? }` (`takenAt` is optional `YYYY-MM-DDTHH:MM:SS` with an optional `±HH:MM` offset, a real calendar date, and a year from 1990 through the current UTC year + 1; `Z`, a fractional second, a leap second, a non-string, or a missing value is stored null and does not 400) (`photos` max 10; non-empty `photos` wins over singular `photo`; dual-send uses `photos`) (base64 JPEG/PNG/WebP ≤ 1 MiB) or `multipart/form-data` with `text`, `video` (MP4/WebM/MOV ≤ 32 MiB), optional JPEG/PNG/WebP `poster`, and optional `goalSats` (string form field). Optional `goalSats` is a whole-sat ask on a top-level note (JSON number; multipart string). Omitted, JSON `null`, or a multipart empty/missing field means no goal. Max 10_000_000; above max is rejected, not clamped. 200 JSON may include `goalSats` or omit the key. Optional `inReplyTo` is a **top-level** parent message UUID (sets `parentId` for a one-level NIP-10 reply; JSON only). Text-only stays valid; photo-only (singular or `photos`) or video-only allowed; at least one of non-empty trimmed text, photo, non-empty `photos`, or video required. Name snapshot. 200 is the public message including `sats`, `payable`, `hasPhoto`, `photoCount` (0–10), `photoTakenAts` (always; length equals `photoCount`; null when unknown; `[]` when there are no stills), `photoTakenAt` only when `photoCount === 1`, `hasVideo`, `videoContentType`, the session account's live `role`, and `accountId` (not wrapped; never `contentFp`). Identical live photo/video from the same account+parent (same normalised text + same media bytes) and the same pin returns the existing row (200, same id) without consuming the 1/10s burst limiter and without a second push; the same media with a different pin is 409 `{ error: 'A live note with this media already exists' }`; text-only is unchanged (new row + burst). New notes have `sats` 0 and `payable` false until signed (and stay `payable` false without author LN). Top-level creates call `notifyForumPost` (kind `forum_post`, tag `forum_post:<id>`, url `/notifications`) for every account except the actor (no-op when the actor is the official platform account), then filtered by each account's `notificationLevel` (Web Push still only to bell subscribers, same filter). After a new top-level persist, the api POSTs `{ address, messageId }` to `{SPEND_URL}/ping` with Bearer `SPEND_API_TOKEN` only when `eligibleToday` and the new row has media (`hasPhoto` / `hasVideo` / `photoCount > 0`) (fire-and-await, errors logged, still 200; ineligible logs `spend.ping.skipped` / `not_eligible`; eligible text-only logs `spend.ping.skipped` / `no_media`). A new top-level media post from `role === 'verified'` also POSTs `{ address, messageId, kind: "welcome" }` independent of `eligibleToday` (Spend pays once lifetime; this API may ping again). Replies, text-only, moderator, and founder do not welcome-ping. Replies do not ping. A reply calls `notifyForumReply` (kind `forum_reply`, tag `forum_reply:<replyId>`, url `/notifications`) for every account except the actor (no-op when the actor is the official platform account), then filtered by each account's `notificationLevel` — Damus-only parents still fan out; a self-reply skips only the actor. The booted process always has those stores (in-memory without `DATABASE_URL`, Postgres when it is set). Photo-only empty text still notifies; missing `pushStore` still writes in-app rows; notification or push failure still returns 200. It does not copy into the member↔member inbox. Unpaid text-only posts and replies from anyone below `verified` (including the parent author) are 403 (`A post needs a Bitcoin payment` / `A reply needs a Bitcoin payment`); photo or video posts and replies from basis are allowed; pay 1 sat to 21.gifts via `GET /messages/compose-target` then `POST /messages/:id/invoice` on the platform profile note. `verified` stays unpaid-write exempt. Optional JSON `place` `{ lat, lng, label? }` and multipart fields `placeLat`, `placeLng`, `placeLabel`. Omitted place stores nothing and the 200 JSON omits `place`. Invalid place is 400 with the normalizePlace error. A reply with a non-null place is 400 `A reply cannot include a place`. Multipart with exactly one of placeLat/placeLng is 400 `Place must be a latitude and longitude`.
- **Errors:** 401 Unauthorized; 409 `{ error: 'missing_requirements', missing: [...] }` when rules, name, username, and/or Lightning Address are missing (order `rules`, then `name`, then `username`, then `lightning-address`); 400 Expected a JSON body with text and/or photo (including JSON `goalSats` type/range errors); 400 Text must be 1–500 characters; 400 Text must be 1–500 characters or include a photo; 400 Text must be 1–500 characters or include a photo or video; 400 Photo must be a JPEG, PNG, or WebP under 1 MiB; 400 `{ error: 'At most 10 photos' }` when `photos.length > 10`; 400 Poster must be a JPEG, PNG, or WebP under 1 MiB; 400 Video must be an MP4, WebM, or MOV under 32 MiB; 400 `{ error: 'A reply cannot ask for a goal' }` when `inReplyTo` is set and `goalSats` is a positive number; 400 `{ error: 'Goal must be a positive whole-sat amount' }` when a multipart `goalSats` is present and not `/^\d+$/` or not an integer 1..10_000_000; 404 `{ error: 'Not found' }` when `inReplyTo` is present but not a UUID, the parent is missing, soft-hidden (`deletedAt` set), or the parent is itself a reply (`parentId !== null`); 403 `{ error: 'A post needs a Bitcoin payment' }` or `{ error: 'A reply needs a Bitcoin payment' }` when the caller is below `verified` (including the parent author) and the body is text-only; photo or video posts and replies from basis are 200; pay 1 sat to 21.gifts via `GET /messages/compose-target` then `POST /messages/:id/invoice` on that note; 429 Too many messages (`Retry-After: 10`); 503 Messages are unavailable (`messages.create.failed`). 409 `{ error: 'A live note with this media already exists' }` when the same account, parent, and live media fingerprint already exists with a different pin. 400 `{ error: 'Place must be a latitude and longitude' }` when JSON `place` is invalid or multipart has exactly one of placeLat/placeLng; 400 `{ error: 'Place label must be at most 80 characters' }` when the label fails normalizePlace; 400 `{ error: 'A reply cannot include a place' }` when `inReplyTo` is set and place is non-null.
- **Used by:** App forum composer and reply composer.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /messages/:id/invoice

- **Purpose:** Bearer required. After auth, `requireAction(payer, 'forum.pay')` (payer needs rules only — never 409 `lightning-address` for the payer). `:id` is a UUID (top-level or a reply — `parentId` is not a mint gate). Body `{ sats, text?, amountUsd?, amountChf?, amountEur?, amountPhp? }` (`sats` integer 1..10_000_000; optional `text` is the NIP-57 comment, same 1–500 forum rules; omit/whitespace = gift-only; omitting every amount key leaves the invoice unpinned; any present amount key pins all four and a missing sibling is null; `"0"`, `"0.0"`, and `"0.00"` are stored as `"0.00"`; an unusable amount string is the same 400 as a bad sats body). Builds a NIP-57 kind:9734 zap request for the note (content = normalised text), signs it with the payer's custodial key (ensuring one exists when KEK is present), and returns `{ pr, amountSats }` only when the minted BOLT11 is a NIP-57 `description_hash` invoice (`isNip57Invoice`); otherwise persists `not_zap` (with rejected `pr` for debug) and responds 400 `The author's wallet cannot receive this Bitcoin payment` without `pr` in the body. Same author's-wallet 400 for LNURL `noZap`; other LNURL transport failures (`unreachable`) keep `Could not start the Bitcoin payment`. Mint gate is a non-empty signed `eventId` plus a non-blank author Lightning Address; null or empty `eventId` / missing or whitespace-only author LN stay 400 `This message cannot be paid yet` and do not call LNURL (resource state, not payer `missing`). Damus-only notes (`accountId` null) stay 400 `The author's wallet cannot receive this Bitcoin payment` and persist `no_author`. Soft-hidden notes are treated as missing (`not_found` persist + 404). After auth, valid-UUID attempts are persisted best-effort (`message_invoice`); persist failures do not change the HTTP response. The invoice rate limit is applied only after auth, amount, payable, and KEK checks (NIP-57 reject still counts, same as other LNURL failures). Indexed kind:9735 credits the paid row (`:id` that was minted, which may be a reply) — not always the top-level parent. On a **member note**, the worker then calls `notifyZap` best-effort (in-app rows for every account except the resolved payer (no-op when the payer is the official platform account), then filtered by each account's `notificationLevel`; Web Push only to bell subscribers, same filter; enqueue failure logs `push.enqueue.failed`) and inserts a payer gift-reply (`sats` = this zap, gift-only `nostrPublishState` `skipped`) only when that paid row is top-level (`parentId` null). A zap on the official platform profile note (`GET /messages/compose-target`) is a compose fee: skip `notifyZap`; the comment becomes the payer's post or `inReplyTo:` reply with `sats` 0, then `notifyForumPost` / `notifyForumReply` plus a top-level `spendPing` only when `eligibleToday` (same gate as `POST /messages`; ineligible logs `spend.ping.skipped` / `not_eligible`). A zap on a reply is `addSats` only (no nested gift-reply). A member-note gift-reply does not call `notifyForumReply`.
- **Errors:** 401 Unauthorized; 409 `{ error: 'missing_requirements', missing: ['rules'] }` when the payer has not agreed to rules; 400 bad body / Text must be 1–500 characters / This message cannot be paid yet / The author's wallet cannot receive this Bitcoin payment (`noZap`, `not_zap`) / Could not start the Bitcoin payment (`unreachable` and other LNURL transport failures); 404 Not found (unknown id, soft-hidden id, or non-UUID `:id`, the latter without a persist row); 429 Too many payments (`Retry-After: 10`, after payable checks); 503 Messages are unavailable (missing KEK before limiter, or keygen/sign failure after).
- **Used by:** App pay sheet and paid reply composer for forum notes.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /pos

- **Purpose:** Bearer required. Returns the signed-in member's open point-of-sale charge, or `charge: null`, plus up to 20 newest rows of any status. A pending row whose `expiresAt` is not in the future is marked `expired` before the response and is not `charge`. Amounts are whole sats. There is no paid status: Wallet of Satoshi settles the invoice and this API does not see it. TTL is five minutes (`POS_CHARGE_TTL_MS`).
- **Errors:** 401 Unauthorized.
- **Used by:** App `/pos` page.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /pos

- **Purpose:** Bearer required. Body `{ amountSats }` integer ≥ 1. Requires a username and a linked Wallet of Satoshi address. Resolves that address and rejects amounts whose millisats (`amountSats * 1000`) fall outside inclusive `minSendable`..`maxSendable`. One unexpired pending charge at a time. The insert enforces that again (`pos_charge_account_pending_idx`, and the in-memory store rejects before append), so a second request that already passed the earlier read is still 409. 201 `{ charge }` with `expiresAt` five minutes after `now`. While pending, `GET /.well-known/lnurlp/:username` keeps the Wallet of Satoshi document and sets both sendable bounds to that millisat amount. Callback and metadata stay unchanged.
- **Errors:** 401 Unauthorized; 400 Expected a JSON body with an integer "amountSats"; 400 Set a username first; 400 Set a Wallet of Satoshi address first; 400 Amount is outside the wallet range; 409 A payment is already open; 502 Lightning Address could not be resolved.
- **Used by:** App `/pos` amount form.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: DELETE /pos

- **Purpose:** Bearer required. Cancels every unexpired pending charge for the account, not only the newest. 200 `{ charge: null }` when at least one row was cancelled. An already expired row is not cancelled.
- **Errors:** 401 Unauthorized; 404 No open payment.
- **Used by:** App `/pos` cancel control.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /contact

- **Purpose:** Bearer required. After auth, `requireAction(account, 'contact.post')` (needs rules + name + username). Body `{ text }`. Private mailbox to 21.gifts — never listed publicly. Name snapshot as forum messages; text uses `normalizeForumText` then still requires 1–500 characters (forum photo-only empty text does not apply). After the platform account exists, persists the contact row first, then opens/appends the member→platform conversation thread so the message is readable via `GET /conversations`. A successful append enqueues a conversation Web Push to bell-subscribed counterparts (`notifyConversationMessage`; failure logs `conversations.push.failed`). Conversation append failure logs `conversations.contact_sync.failed` and still returns 200 (contact is the product surface). 200 is the public contact object (no `accountId`).
- **Errors:** 401 Unauthorized; 409 `{ error: 'missing_requirements', missing: [...] }` when rules, name, and/or username are missing; 400 Expected a JSON body with a "text" string; 400 Text must be 1–500 characters; 503 `{ error: 'Platform account is not configured' }` when no `isPlatform` account exists (neither contact nor thread is written); 503 Contact is unavailable (`contact.create.failed`).
- **Used by:** App in-app contact composer.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /conversations

- **Purpose:** Bearer required. Lists threads the session may see: own member threads plus, when the role is at least moderator, all platform threads. Lists threads with at least one inbound message for the viewer (empty and outbound-only member/Damus omitted). The member's own `member_platform` contact thread is listed when it has a message, even if outbound-only. Inbound = not `conversationFromMe`; Damus null sender is inbound. This list never includes `kind: 'moderator_group'` (the closed group is `GET /conversations/moderator-group`). `GET /conversations/:id` and `POST` are unchanged for outbound-only and empty threads. Newest last-message first (cap 200). Public JSON is `{ conversations: [{ id, kind, name, lastText, lastAt, lastFromMe, lastSats, amountUsd, amountChf, amountEur, amountPhp, unread, unreadMessageCount, accountId? }], unreadCount }` — the four amounts are always present (string or null; the last message's stored payment-time fiat) — optional counterpart 21.gifts `accountId` (omitted for Damus-only counterparts); no event ids or npubs (Damus-only `name` may be a truncated npub). `lastFromMe` is true when the last message's actor (else sender) is the viewer; Damus inbound (`senderAccountId` null) is false. No staff-as-platform shortcut. `lastSats` is the last message's sats (0 for unpaid text). Per-row `unreadMessageCount` is inbound messages strictly after last-read (`0` when none); `unread` is `unreadMessageCount > 0`. Envelope `unreadCount` is the number of listed rows with `unread: true` (same cap/filter; menu/PWA badge, still a thread count). List GET does not stamp last-read. `DEBUG_TOKEN` cannot read this inbox.
- **Errors:** 401 Unauthorized; 503 `{ error: 'Conversations are unavailable' }` (`conversations.list.failed`).
- **Used by:** App conversation list.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /conversations/:id/read

- **Purpose:** Bearer required. UUID `:id`. After `getById` + `canAccess`, `markRead(id, account.id, new Date(deps.now()))`. 200 `{ ok: true }`. Does not copy DMs into Notifications. `GET /conversations/:id` does not mark read. Registered before `POST /conversations/:id`. `DEBUG_TOKEN` cannot use this.
- **Errors:** 401 Unauthorized; 404 `{ error: 'Not found' }` (unknown / other-account / non-uuid); 503 `{ error: 'Conversations are unavailable' }` (`conversations.read.failed`).
- **Used by:** App mark-conversation-read control.

## Endpoint: GET /conversations/moderator-group

- **Purpose:** Bearer required. Closed moderator-group tool, not the member inbox. At least moderator (`isModeratorGroupMember`: `roleAtLeast` `moderator` and not the platform account): `ensureModeratorGroup` then `{ conversation }` via `publicThread` (`kind: 'moderator_group'`, name `Moderators`, `unread` / `unreadMessageCount` from `countUnread`). Verified, basis and the platform account → 404 `{ error: 'Not found' }` (same as `canAccess`, no existence leak). Missing platform or store failure → 503 (`conversations.moderator_group.failed`). Unauthenticated 401. Registered before `GET /:id`.
- **Errors:** 401 Unauthorized; 404 Not found; 503 `{ error: 'Conversations are unavailable' }` (`conversations.moderator_group.failed`).
- **Used by:** App moderator-group tool.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /notifications

- **Purpose:** Bearer required. List `{ notifications, unreadCount }`. Apply the owner's `notificationLevel` filter (`notificationsMatchingLevel` on the newest 1000 stored rows), then drop rows whose parent **message** is missing or `deletedAt !== null` (`forum_post` / `zap` / `forum_reply`); `forum_reply` also drops when the child `replyId` message is missing or hidden. A `zap` `replyId` is a receipt-derived UUID, not a message id — it is not looked up and is never added to the purge set. Then cap the kept list at 200 newest-first. Then best-effort `deleteByMessageIds` of those **message** ids (`notifications.hidden.purged`; throw logs `notifications.hidden.purge_failed` and is not 503). Never drops `moderator_appointed` or `moderator_proposal` in the hidden filter (those rows stay in `{ notifications }`; do not look up a forum message; do not add the parent id to the purge set). Appointed/proposal `parentId`/`replyId` are account ids in prod, so a purge of hidden **message** ids does not remove them. `unreadCount` is unread among kept rows after the hidden filter (before the 200 cap), not the unfiltered store count (if purge throws, still count kept unread; do not 503 the list). Each item `type` is `'forum_post' | 'forum_reply' | 'zap' | 'moderator_appointed' | 'moderator_proposal'`. No account ids. `moderator_appointed` and `moderator_proposal` always stay through the level filter. Mark-read / read-all do not stamp `moderator_proposal`.
- **Errors:** 401 Unauthorized; 503 Notifications are unavailable (`notifications.list.failed`).
- **Used by:** App in-app notification list.
- **Auth:** Bearer session.

## Endpoint: POST /notifications/read-all

- **Purpose:** Bearer required. 200 `{ ok: true }`. Marks every unread notification for the session account read except `moderator_proposal` (mark-read does not stamp them; rows drop on confirm, on reject when pending is then empty, or on appoint).
- **Errors:** 401 Unauthorized; 503 Notifications are unavailable (`notifications.read_all.failed`).
- **Used by:** App mark-all-read control.
- **Auth:** Bearer session.

## Endpoint: POST /notifications/:id/read

- **Purpose:** Bearer required. UUID `:id`. 200 `PublicNotification` with `readAt` set. A `moderator_proposal` row is 200 with `readAt` still `null` (mark-read does not dismiss it).
- **Errors:** 401 Unauthorized; 404 Not found (unknown/other/non-uuid); 503 Notifications are unavailable (`notifications.read.failed`).
- **Used by:** App mark-one-read control.
- **Auth:** Bearer session.

## Endpoint: POST /conversations

- **Purpose:** Bearer required. Body `{ forumMessageId }` (forum note UUID). Opens or returns the thread with that note's author (21gifts account or Damus pubkey). 200 is the public conversation object (includes `kind`, `lastFromMe`, `unread`, `unreadMessageCount`, and optional counterpart `accountId`; empty new threads are `lastFromMe: false`, `unread: false`, and `unreadMessageCount: 0`; Damus-only counterparts omit `accountId`).
- **Errors:** 401 Unauthorized; 400 Expected a JSON body with a "forumMessageId" string; 400 `{ error: 'Cannot message yourself' }` when the author is the session account; 404 `{ error: 'Not found' }` for a non-UUID / missing note / Damus note without pubkey; 503 Conversations are unavailable.
- **Used by:** App "message the author" from a forum note.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /conversations/:id

- **Purpose:** Bearer required. `:id` is a UUID. Messenger-style keyset paging returns the newest `limit` messages (default/max 200), oldest-first within each page, as `{ messages: [{ id, name, text, createdAt, fromMe, sats, hasPhoto, photoCount, accountId?, giftFor? }], nextCursor? }`. Optional `?limit=` is 1–200. Optional `?cursor=` is base64url JSON `{ k: 't', c: <ISO>, i: <uuid> }` encoded and decoded by the message-feed cursor helpers; it selects rows exclusively older than `createdAt` + `id`. A full page includes `nextCursor`, encoded from that page's oldest row; a shorter page omits it. The envelope has no counterpart `accountId` on the thread. Optional message `accountId` is the sender 21.gifts account (omitted when `senderAccountId` is null). For a staff viewer, `name` and `accountId` are the actor when `actorAccountId` is set. Members still see the house/sender snapshot (`21.gifts` on official replies). `fromMe` is true when the actor (else sender) is the viewer; Damus inbound (`senderAccountId` null) is false. No staff-as-platform shortcut. `hasPhoto` / `photoCount` (0–10) flag stills; bytes are never in this JSON. Optional `giftFor` is the id of the group message a paid moderator stipend belongs to (omitted on every other row; never JSON `null`). Optional `?sinceMessageId=` (UUID) long-polls until that id is in the thread (pay-sheet confirmation); timeout still 200 with the current messages, and the response then uses the newest page regardless of a valid supplied cursor. A present invalid cursor is still 400. 404 when the session may not see the thread. `moderator_group` is 404 `{ error: 'Not found' }` unless the caller is a group member (`isModeratorGroupMember`: at least moderator, never the platform account) (no existence leak). Unauthenticated 401.
- **Errors:** 401 Unauthorized; 400 `{ error: 'Expected sinceMessageId to be a UUID' }`; 400 `{ error: 'Invalid limit' }`; 400 `{ error: 'Invalid cursor' }`; 404 Not found; 503 Conversations are unavailable.
- **Used by:** App conversation thread and gift pay-sheet poll.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /conversations/:id/invoice

- **Purpose:** Bearer required. Body `{ sats: <int 1..10_000_000>, text?, amountUsd?, amountChf?, amountEur?, amountPhp? }` (omitting every amount key leaves the invoice unpinned; any present amount key pins all four and a missing sibling is null; `"0"`, `"0.0"`, and `"0.00"` are stored as `"0.00"`; an unusable amount string is the same 400 as a bad sats body). Issues a NIP-57 BOLT11 to the counterpart's Lightning Address (profile-note `e` tag). 200 `{ pr, amountSats, messageId }` — `messageId` is the predetermined conversation row, inserted only after zap ingest. Gift-only omits text. Damus threads are not invoiced.
- **Errors:** 401 Unauthorized; 400 Expected a JSON body with a positive "sats" integer; 400 Text must be 1–500 characters; 400 Set a name before posting; 400 Cannot message yourself; 400 The author's wallet cannot receive this Bitcoin payment (`noZap`, `not_zap`, Damus, missing counterpart LN / profile event); 400 Could not start the Bitcoin payment (`unreachable` and other LNURL transport failures); 404 Not found; 429 Too many payments; 503 Messages are unavailable / Conversations are unavailable (persist failure after a successful LNURL mint is 503 and the response has no `pr`).
- **Used by:** App inbox amount composer.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /conversations/:id

- **Purpose:** Bearer required. Body `{ text?, photo?: { contentType, data, takenAt? }, photos?: { contentType, data, takenAt? }[] }` (at most 10 stills; non-empty `photos` wins over singular `photo`). Optional `takenAt` is the same civil string as `POST /messages` (invalid or missing is stored null and does not 400). Conversation JSON does not return it. Empty text allowed on every kind when a photo is present. JPEG/PNG/WebP stills (max 10) are allowed on Direct (`member_member`), Contact (`member_platform`), Damus (`member_damus`), and `moderator_group`. Photo-bearing rows persist `nostrPublishState` skipped (never signed or published to Nostr); text-only Direct/Contact/Damus stay `pending`. Text 1–500 via `normalizeForumText`. Appends a message. 200 is the public conversation message (`fromMe` true when this session is the actor; staff JSON `name`/`accountId` are the actor; members still see the platform sender; `hasPhoto` and `photoCount` 0–10; never photo bytes). Staff (at least moderator) replies on a platform thread persist `senderAccountId` as the platform account (worker signs with the platform nsec) and store `actorAccountId`/`actorName` as the logged-in staff. After persist, enqueues one conversation Web Push to bell-subscribed counterparts (member threads `/messages?c=<id>`; `moderator_group` `/moderate/group`; `unreadCount` is notification unread + listed inbox unread; `moderator_group` notifies other accounts with `roleAtLeast` `moderator`, not the platform account). Push failure is void-caught (`conversations.push.failed`) so 200 is unchanged. Does not write in-app Notification rows. Local persist does not wait for relay ACK. On `moderator_group`, sender is the caller account (at least moderator, not platform), `nostrPublishState` skipped (never Nostr). `moderator_group` is 404 `{ error: 'Not found' }` unless the caller is a group member (`isModeratorGroupMember`: at least moderator, never the platform account) (no existence leak). After a new persist, ping `{ address, kind: "moderator", groupMessageId }` only when Lightning Address is a non-empty trimmed string, `spendPing` is set, **and** the caller has a live living-room top-level post (not the profile note) whose `createdAt` is on the same UTC day **and** `eligibleToday` for the author's funding grant. No living-room post today → 200, no ping (`spend.ping.skipped` `no_public_post`). Public post today but not funding-eligible → 200, no ping (`spend.ping.skipped` `not_eligible`). Ping throw still 200, no ping. Living-room lookup failure after persist still 200, no ping (`spend.ping.skipped` `posted_unreachable`). Empty/invalid text still 400, no ping (empty text without a photo is 400 `{ error: 'Text must be 1–500 characters or include a photo' }` on every kind).
- **Errors:** 401 Unauthorized; 400 Expected a JSON body with text and/or photo; 400 At most 10 photos; 400 Photo must be a JPEG, PNG, or WebP under 1 MiB; 400 Text must be 1–500 characters or include a photo; 400 Set a name before posting; 400 Text must be 1–500 characters; 404 Not found; 503 Conversations are unavailable.
- **Used by:** App conversation composer.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /conversations/:id/messages/:messageId/photo

- **Purpose:** Bearer required. UUID `:id` and `:messageId`. After getById + canAccess, serve photo 0 via getPhoto + forumPhotoResponse, then override to `Cache-Control: private, no-store` and drop `Access-Control-Allow-Origin` (forum helper is public CDN; conversation stills stay private). No Damus `.jpg` alias. Missing still or message not in this thread → 404 `{ error: 'Photo not found' }`. Unknown/unauthorized thread → 404 `{ error: 'Not found' }`. Registered before GET `/:id`.
- **Errors:** 401 `{ error: 'Unauthorized' }`; 404 `{ error: 'Not found' }` / `{ error: 'Photo not found' }`; 503 `{ error: 'Conversations are unavailable' }` (`conversations.photo.failed`).
- **Used by:** App conversation stills on Direct, Contact, Damus, and moderator-group threads.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /conversations/:id/messages/:messageId/photo/:file

- **Purpose:** Bearer required. Extra stills 1–9. `:file` must match `^([1-9])\.(jpg|jpeg|png|webp)$`; else 404 `{ error: 'Photo not found' }`. Same canAccess / belonging / private cache headers as photo 0. No `/photo/0.jpg`.
- **Errors:** Same 401 / 404 / 503 as photo 0 (`conversations.photo.failed`).
- **Used by:** App extra conversation stills on Direct, Contact, Damus, and moderator-group threads.
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

- **Purpose:** Bearer required. Body `{ name }`. Stores the trimmed display name on the account (1–80 characters, no C0/DEL control characters) in a name-only write that does not change username. When username is still blank, a follow-up write stores `usernameFromDisplayName(name)` if that handle is free; a uniqueness race leaves username null and setup at `username`. The response is the stored row after both writes. When a non-blank Lightning Address is already linked, the first persisted non-empty name also creates exactly one top-level profile forum note (`ensureProfileMessage`) and claims `profileMessageId` via `claimProfileMessageId` (set only while the pointer still matches the missing/hidden read; not exposed on owner JSON); without LN the name is stored and no note is inserted. Rename does not create a second note and does not change the note text.
- **Errors:** 401 without session; 400 if the body is not `{ name: string }` or the name fails validation. Does not 409 when the derived username is taken or lost to a uniqueness race (name still 200, username stays null).
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

- **Purpose:** Bearer required. Body `{ text, photo? }`. `text` is required. `photo` omitted keeps a stored photo; JSON `null` clears it and clears `photo_taken_at`; `{ contentType, data, takenAt? }` is `decodeForumPhoto` (same JPEG/PNG/WebP under 1 MiB as `POST /messages`). `takenAt` is the same optional civil string as `POST /messages` (invalid or missing is stored null and does not 400). Replacing the photo writes that time. Writes About me onto the profile forum note (creates a new live note without a Lightning Address when the note is missing or soft-hidden via `deletedAt`, including photo-only empty text with a decoded photo, then claims `profileMessageId` via `claimProfileMessageId` only while the pointer still matches the missing/hidden read; a lost claim deletes the insert and adopts a live winner). A won inline claim create calls `notifyForumPost` after the writes (best-effort; no-op when the actor is the official platform account; enqueue failure still 200). Adopting a live CAS winner does not notify. PUT `/about` does not call `ensureProfileMessage` (no name-copy insert). Updating an already-live note does not notify. Empty text with `photo` omitted or `null` and no live note does not create or notify. The hidden row stays hidden. Empty text clears the bio (`aboutMe` null; the live note row is kept). Name-only auto-copy is not a bio, including after a display-name rename (Ada→Grace with note text still `Ada` stays `null`). A live photo still sets `aboutMeHasPhoto`. Requires a display name (not LN). Success is owner JSON with `aboutMe` and `aboutMeHasPhoto`.
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

- **Purpose:** Stored trust graph. Bearer session required (any role). Bare `GET` returns founder seeds only (`edges` empty) so a large chain is not dumped on first paint. `?around=<id>` returns that chain member plus one hop of stored public edges with at most one incoming edge per subject: the oldest eligible sibling (`createdAt` then `id`), skipping a non-chain oldest sibling so a later displayable contact can show. Eligible: `verify`, `moderator_appoint`, and `moderator_propose` only when the live subject is a `moderator`; `moderator_confirm` and `moderator_reject` never. Later appoint, confirm, or propose do not replace an earlier eligible contact. Neighborhood uses full sibling lists per subject (`listEdgesForSubject`) so a non-touching older eligible edge still wins over a touching newer one. A pending propose stays private. Nodes are founder/moderator/verified (never basis). Never invents edges; omits lightning addresses, view keys, and linking keys.
- **Errors:** 401 `{ error: 'Unauthorized' }` without a session or with an invalid Bearer. 404 `{ error: 'Not found' }` when `around` is supplied but is not a uuid, is unknown, or is not a chain member (including Postgres `22P02`). Omitting `around` (or empty) is founder seeds, not 404. Unauthenticated `around` is 401, not 404. 503 `{ error: 'Trust chain is unavailable' }` when listing accounts or edges throws (`trust.chain.failed`).
- **Used by:** signed-in app `/trust-chain` via app `GET /trust/graph`.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /trust/proposals

- **Purpose:** Bearer session required (moderator; not `DEBUG_TOKEN`). Lists pending proposals via `pendingModeratorProposals`: latest propose/reject is `moderator_propose`, live subject `role` is `verified`, and the subject has no `moderator_confirm` / `moderator_appoint`. JSON `{ "proposals": [ { id, subject: { id, name, role: "verified" }, proposedBy: { id, name }, createdAt } ] }` with the propose-edge `id` and ISO-8601 `createdAt` (empty list is 200). Oldest `createdAt` first, then propose-edge id. Missing subjects are omitted; a missing actor is `{ id, name: null }`. No `forum.read` / rules gate — a moderator without rules agreement is still 200. Logs `trust.proposals.listed` with `{ count }` only. `GET /trust-chain` still omits a pending `moderator_propose`. Once the subject is a `moderator`, that propose is eligible as the public incoming edge only when it is the oldest eligible sibling (`createdAt` then `id`).
- **Errors:** 401 `{ error: 'Unauthorized' }` without a session; 403 `{ error: 'Forbidden' }` when the live role is not at least moderator; 503 `{ error: 'Trust chain is unavailable' }` when listing accounts/edges or projecting throws (`trust.proposals.failed`).
- **Used by:** Staff moderator-proposal queue in the app.
- **Auth:** `Authorization: Bearer` session (moderator). Not `DEBUG_TOKEN`.

## Endpoint: POST /trust/verify

- **Purpose:** Bearer staff (moderator). Body `{ "accountId": "<uuid>" }`. Confirms the subject in real life: insert `verify` edge then `updateAccount` role=`verified`, log `trust.verified` `{ subjectId, actorId }`, `200 { id, name, role }`. Idempotent 200 when the existing verify edge actor is the caller and the subject is already `verified`. If that caller-owned edge exists and the subject is still `basis`, completes the role write and returns 200.
- **Errors:** 401 `{ error: 'Unauthorized' }` without session; 403 `{ error: 'Forbidden' }` when the caller is not at least moderator; 400 `{ error: 'Expected a JSON body with an "accountId" string' }`; 404 `{ error: 'Not found' }` for a non-UUID or missing subject; 409 `{ error: 'Conflict' }` when the subject is self, a verify edge belongs to someone else, or the subject is ineligible (`role` is not `basis` except the caller-owned retry above); 503 `{ error: 'Trust chain is unavailable' }` on unexpected store throw (`trust.write.failed`).
- **Used by:** Staff verify flow in the app.
- **Auth:** `Authorization: Bearer` session. Staff only.

## Endpoint: POST /trust/propose-moderator

- **Purpose:** Bearer staff. Body `{ "accountId" }`. Subject must be `verified`, not self. 409 only when currently pending (latest propose/reject is propose), any confirm/appoint exists, the subject is self, role is not verified, or after insert this row is not the oldest open propose (the insert is deleted; remaining pending is then best-effort cleared and fan-out for that propose-edge id, failure stays 409; empty open after a concurrent reject is the same 409). After a reject, 200 inserts a **new** `moderator_propose` (history kept). When this insert is the oldest open propose and extras exist, delete newer extra proposes and still 200. Role unchanged; logs `trust.moderator_proposed`; `200 { id, name, role }`. After 200, delete existing `moderator_proposal` rows for the subject then wrap `notifyModeratorProposed` (in-app `moderator_proposal` plus Web Push to other staff). Then re-list: if pending is empty or the pending propose-edge `id` is not this insert, delete those rows again; if a different propose is pending, fan out for that actor only when a second re-list still shows that same id, and delete the rows if a re-list after that fan-out no longer matches. HTTP still 200 if notify or the purge fails.
- **Errors:** Same 401/403/400/404/409/503 JSON shapes as `POST /trust/verify` (409 when the subject is not verified, is self, is currently pending, already has confirm/appoint, or after insert this row is not the oldest open propose).
- **Used by:** Staff moderator-proposal flow.
- **Auth:** `Authorization: Bearer` session. Staff only.

## Endpoint: POST /trust/confirm-moderator

- **Purpose:** Bearer staff. Body `{ "accountId" }`. A pending proposal must exist (latest propose/reject is propose) and the caller id must differ from that latest proposer's actor id. Subject must still be `verified`. Inserts `moderator_confirm` then re-lists: if the pending propose-edge `id` from `pendingModeratorProposals` (ignoring this confirm insert) is no longer the same, or that id is not also the oldest open propose, delete that confirm and 409 without promoting. Otherwise sets role to `moderator`, logs `trust.moderator_confirmed`, `200 { id, name, role }`. If the caller already stored `moderator_confirm` and the subject is still `verified`, completes the role write and returns 200; already-moderator with that caller-owned edge is idempotent 200. After a 200 that leaves the subject as `moderator` (new grant and idempotent already-moderator same-actor 200), delete `moderator_proposal` rows (`replyId === subject.id`) then wrap `notifyModeratorAppointed` for the subject only (in-app `moderator_appointed`, Web Push url `/welcome`). Failure logs `push.enqueue.failed`; persist/HTTP still 200.
- **Errors:** Same 401/403/400/404/409/503 JSON shapes as `POST /trust/verify` (409 when there is no pending propose, the caller proposed, the subject is no longer verified, a confirm edge belongs to someone else, the pending propose-edge id changed after insert, or that id is not the oldest open propose).
- **Used by:** Independent second staff confirmation.
- **Auth:** `Authorization: Bearer` session. Staff only.

## Endpoint: POST /trust/reject-moderator

- **Purpose:** Bearer staff (same auth as propose-moderator). Body `{ "accountId" }`. Reject an open moderator proposal: pending means the latest propose/reject is propose, the subject is still `verified`, and there is no confirm/appoint. Inserts append-only `moderator_reject` then re-lists: if a concurrent confirm or appoint already closed the grant, or the pending propose-edge `id` is still the same (this reject lost the same-ms id tie), delete that reject and 409. If a newer propose already reopened the queue (including a same-actor same-ms re-propose with a different edge `id`), 200 keeps the reject in history and does not drop `moderator_proposal` rows. Role stays `verified`. The original proposer may reject. Logs `trust.moderator_rejected` `{ subjectId, actorId }`. When pending is empty after insert, re-lists once more and deletes `moderator_proposal` rows with `replyId === subject.id` only if pending is still empty; if a re-list after that delete shows a new pending propose, fan out for that actor and re-list again so a concurrent close drops those rows. No notify for the reject itself. `200 { id, name, role }` with role unchanged.
- **Errors:** 401 `{ error: 'Unauthorized' }` without a bearer session; 403 `{ error: 'Forbidden' }` when the caller is not staff; 400 `{ error: 'Expected a JSON body with an "accountId" string' }`; 404 `{ error: 'Not found' }` for a non-UUID or missing subject; 409 `{ error: 'Conflict' }` when the subject is self, not pending, `role !== verified`, a concurrent confirm/appoint closed the grant, or the pending propose-edge id is still the same after insert; 503 `{ error: 'Trust chain is unavailable' }` on unexpected store throw (`trust.write.failed`).
- **Used by:** Staff moderator-proposal queue in the app (reject an open proposal so another staff member can re-propose).
- **Auth:** `Authorization: Bearer` session. Staff only (moderator+). Not `DEBUG_TOKEN`.

## Endpoint: POST /trust/appoint-moderator

- **Purpose:** Bearer founder (moderators → 403). Body `{ "accountId" }`. Subject must not be self, not founder, and not already moderator; may be `basis` or `verified`. Inserts `moderator_appoint` then sets role to `moderator`, logs `trust.moderator_appointed`, `200 { id, name, role }`. If the caller already stored `moderator_appoint` and the subject is not yet `moderator`, completes the role write and returns 200; already-moderator with that caller-owned edge is idempotent 200. After a 200 that leaves the subject as `moderator` (new grant and idempotent already-moderator same-actor 200), delete `moderator_proposal` rows with `replyId === subject.id`, then wrap `notifyModeratorAppointed` for the subject only (in-app `moderator_appointed`, Web Push url `/welcome`). Failure logs `push.enqueue.failed`; persist/HTTP still 200.
- **Errors:** 401 without session; 403 when the caller is not `founder`; 400/404/409/503 same JSON shapes as `POST /trust/verify`.
- **Used by:** Founder appointment of a moderator.
- **Auth:** `Authorization: Bearer` session. Founder only.

## Endpoint: POST /funding/apply

- **Purpose:** Bearer session. Role `basis` → 403. Apply also requires a filled About me (real bio, not empty/name-only), an About me photo, and a non-empty location, checked in that order before the grant 409. Effective `none` or `rejected` upserts `pending` (`appliedAt` now; trial/admitted/decided cleared). `pending` / `trial` / `admitted` → 409. 200 `{ funding: OwnerFundingJson }`. Logs `funding.applied`.
- **Errors:** 401 `{ error: 'Unauthorized' }`; 403 `{ error: 'Forbidden' }` for `basis`; 400 `{ error: 'About me is required' }`; 400 `{ error: 'About me photo is required' }`; 400 `{ error: 'Location is required' }`; 409 `{ error: 'Conflict' }`; 503 `{ error: 'Funding is unavailable' }` (`funding.write.failed`).
- **Used by:** App funding apply.
- **Auth:** `Authorization: Bearer` session. Not `basis`.

## Endpoint: GET /funding/applications

- **Purpose:** Staff Bearer. Effective pending grants only (expired trials after lazy persist). JSON `{ applications: [{ accountId, name, role, appliedAt }] }` oldest `appliedAt` first. Logs `funding.applications.listed` `{ count }`.
- **Errors:** 401 `{ error: 'Unauthorized' }`; 403 `{ error: 'Forbidden' }` when the live role is not at least moderator; 503 `{ error: 'Funding is unavailable' }` (`funding.list.failed`).
- **Used by:** Staff funding queue.
- **Auth:** `Authorization: Bearer` session (moderator).

## Endpoint: GET /funding/applications/:accountId

- **Purpose:** Staff Bearer. 200 `{ account: { id, name, role, lightningAddress }, grant: { status, appliedAt, trialUtcDate, admittedAt, decidedAt }, messages }` with **effective** grant status and the same video-drop as member posts (`MESSAGE_LIST_LIMIT`, `serializeMessage`).
- **Errors:** 401/403 as list; 404 `{ error: 'Not found' }` for a non-UUID, missing account, or no grant; 503 `{ error: 'Funding is unavailable' }` (`funding.list.failed`).
- **Used by:** Staff funding review.
- **Auth:** `Authorization: Bearer` session (moderator).

## Endpoint: POST /funding/trial

- **Purpose:** Staff Bearer. Body `{ accountId }`. Target must be effective pending, not self, not `basis`. Sets `trial`, `trialUtcDate` = today UTC, `decidedAt`/`decidedBy` now, `admittedAt` null. 200 `{ id, name, role, funding }`. Logs `funding.trial`.
- **Errors:** 401/403 as list; 400 `{ error: 'Expected a JSON body with an "accountId" string' }`; 404 `{ error: 'Not found' }`; 409 `{ error: 'Conflict' }` for self / not pending / `basis`; 503 `{ error: 'Funding is unavailable' }` (`funding.write.failed`).
- **Used by:** Staff one-day trial.
- **Auth:** `Authorization: Bearer` session. Staff only.

## Endpoint: POST /funding/admit

- **Purpose:** Staff Bearer. Body `{ accountId }`. Target effective pending or trial, not self, not `basis`. Sets `admitted`, `admittedAt` now, `trialUtcDate` null. 200 `{ id, name, role, funding }`. Logs `funding.admitted`.
- **Errors:** Same 401/403/400/404/409/503 JSON as `POST /funding/trial`.
- **Used by:** Staff recurring admission.
- **Auth:** `Authorization: Bearer` session. Staff only.

## Endpoint: POST /funding/reject

- **Purpose:** Staff Bearer. Body `{ accountId }`. Target effective pending or trial, not self. Sets `rejected` and clears trial/admitted. 200 `{ id, name, role, funding }`. Logs `funding.rejected`.
- **Errors:** Same 401/403/400/404/409/503 JSON as `POST /funding/trial` (409 does not require the subject to be non-`basis`).
- **Used by:** Staff funding reject (subject may re-apply).
- **Auth:** `Authorization: Bearer` session. Staff only.

## Endpoint: GET /debug/trust-edges

- **Purpose:** Operator listing of every stored trust edge (`serializeTrustEdge`), newest `createdAt` then `id` descending. Success JSON is `{ edges }` (`serializeTrustEdge` rows).
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 503 `{ error: 'Trust chain is unavailable' }` on unexpected store throw (`debug.trust_edges.failed`).
- **Used by:** Operator `gifts-debug trust-edges`.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: POST /debug/trust-edges

- **Purpose:** Operator backfill of a stored trust edge. Body `{ "subjectId", "actorId", "kind" }` with `kind` one of `verify` / `moderator_propose` / `moderator_confirm` / `moderator_appoint` / `moderator_reject`. Inserts the edge, logs `debug.trust_edges.inserted` `{ subjectId, actorId, kind }`, and returns `{ id, subjectId, actorId, kind, createdAt }` (`createdAt` ISO-8601). Does **not** change `account.role`. `PATCH /debug/accounts/:id` remains role-only. POST 409 duplicate only for live-unique kinds (`verify` / `moderator_confirm` / `moderator_appoint`); propose and reject may repeat.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 400 `{ error: 'Expected a JSON body with "subjectId", "actorId", and "kind" strings' }`; 404 `{ error: 'Not found' }` when subject or actor is missing or not a UUID; 409 `{ error: 'Conflict' }` on duplicate live-unique `(subjectId, kind)` or `subjectId === actorId`; 503 `{ error: 'Trust chain is unavailable' }` on unexpected store throw (`debug.trust_edges.failed`).
- **Used by:** Operator `gifts-debug trust-edge` CLI.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: DELETE /debug/trust-edges

- **Purpose:** Operator delete of a stored trust edge. Body `{ "subjectId", "kind" }` with `kind` one of `verify` / `moderator_propose` / `moderator_confirm` / `moderator_appoint` / `moderator_reject`. Removes the latest `(subjectId, kind)` row (`createdAt` desc, then `id` desc), logs `debug.trust_edges.deleted` `{ subjectId, kind }`, and returns the deleted `{ id, subjectId, actorId, kind, createdAt }` (`createdAt` ISO-8601). Does **not** change `account.role`.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 400 `{ error: 'Expected a JSON body with "subjectId" and "kind" strings' }`; 404 `{ error: 'Not found' }` when `subjectId` is not a UUID or no row matches; 503 `{ error: 'Trust chain is unavailable' }` on unexpected store throw (`debug.trust_edges.delete_failed`).
- **Used by:** Operator `gifts-debug trust-edge-delete` CLI.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: GET /debug/dump

- **Purpose:** Operator catalog of every allowlisted Postgres table as camelCase JSON (cap 200 per table). Success JSON is `{ tables }` keyed by allowlisted table name: `account`, `passkey_credential`, `passkey_challenge`, `auth_session`, `address_verification`, `api_log`, `contact`, `pos_charge`, `conversation`, `conversation_message`, `conversation_read`, `message`, `message_extra_photo`, `message_invoice`, `nostr_zap_ingest`, `nostr_zap_receipt`, `nostr_zap_payment`, `nostr_zapper`, `nostr_blocked_pubkey`, `notification`, `push_subscription`, `push_outbox`, `trust_edge`, `gift`, `btc_usd_daily`, `usd_fiat_daily`, `db_change`. Media bytes stay off JSON (`photoBytes` / extra-photo `bytes` are lengths). `nostrNsecCiphertext` is envelope hex. `btc_usd_daily` / `usd_fiat_daily` dump stored rate rows when the rate books expose `listDebug`; `db_change` dumps when a list port is wired (in-memory boots dump `[]`). `api_log` dumps when `apiLogStore` is wired (same rows as `GET /debug/api-log`).
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 503 `{ error: 'Dump is unavailable' }` when a store throws.
- **Used by:** Operator `gifts-debug dump`.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: GET /debug/dump/:table

- **Purpose:** Same catalog as `GET /debug/dump` for one allowlisted table name. Response `{ table, rows }`.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 404 `{ error: 'Not found' }` when the table name is not allowlisted (`account`, `passkey_credential`, `passkey_challenge`, `auth_session`, `address_verification`, `api_log`, `contact`, `pos_charge`, `conversation`, `conversation_message`, `conversation_read`, `message`, `message_extra_photo`, `message_invoice`, `nostr_zap_ingest`, `nostr_zap_receipt`, `nostr_zap_payment`, `nostr_zapper`, `nostr_blocked_pubkey`, `notification`, `push_subscription`, `push_outbox`, `trust_edge`, `gift`, `btc_usd_daily`, `usd_fiat_daily`, `db_change`); 503 `{ error: 'Dump is unavailable' }` when a store throws.
- **Used by:** Operator `gifts-debug dump <table>`.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: POST /me/wallet-backup-seen

- **Purpose:** Bearer required. Empty body. Sets `walletBackupSeenAt` via `markWalletBackupSeen` (`WHERE wallet_backup_seen_at IS NULL`; logs `account.wallet.backup_seen` `{ accountId }` only when this call wrote). Does not change `walletRequired`. Owner JSON including `setup` / `missing` / `funding`. Never a mnemonic or PRF.
- **Errors:** 401 without session.
- **Used by:** App `POST /me/wallet-backup-seen` records that this account can show a recovery phrase. Not a confirmation and not a setup step. Empty body. Does not change `walletRequired`.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /me/setup/skip

- **Purpose:** Bearer required. Body `{ step: "name" | "lightning-address" }`. Sets `nameSkippedAt` or `lightningAddressSkippedAt` to now so owner `setup` advances; does not clear or change `name` / `lightningAddress`. Skipping an already-set field is allowed (writes the skip timestamp). Rules cannot be skipped. `step: "wallet"` is 400 like an unknown step.
- **Errors:** 401 without session; 400 for unknown step, `step: "wallet"`, `step: "rules"`, or bad JSON (same copy as an invalid step).
- **Used by:** App onboarding skip controls (api-first; app proxy may follow later).
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /debug/external-pubkeys

Operator inspection of external Nostr identities that have earned visibility or have been blocked.

- **Auth:** Requires `Authorization: Bearer <DEBUG_TOKEN>`; unset or blank configuration returns 503 and a mismatch returns 401.
- **Response:** Returns `{ zappers, blocked }`, with lowercase pubkeys, receipt/message references, staff id, and ISO timestamps; both arrays are newest first.
- **Limits:** Each array is independently capped at 200 rows, matching the other operator debug listings.
- **Failure:** A store read failure returns 503 `{ "error": "External pubkeys are unavailable" }` and no partial list.

## Endpoint: GET /links/:code

- **Purpose:** Public resolver: an 8-hex prefix of a forum-message UUID or account UUID becomes exactly one full id. Website short links are `https://<origin>/l/<8 hex>` and call this to learn where that code points (`kind` is `message` or `member`).
- **Errors:** 400 `{ error: 'invalid_code' }` when `:code` is not exactly eight hex digits after `toLowerCase()` (no trim); 404 `{ error: 'not_found' }` when neither store has a match; 409 `{ error: 'ambiguous' }` when two or more ids match (two messages, two accounts, or one of each). No ids in error bodies. No 503 path.
- **Used by:** Website short-link landing (`/l/<8 hex>`).
- **Auth:** none. Public. Soft-hidden messages are included; the public message page decides who may see them.
