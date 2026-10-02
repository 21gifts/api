# HTTP endpoints

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

- **Purpose:** Bearer required. A moderator soft-hides a forum note: stamps `deleted_at` / `deleted_by` on the target and every untagged **direct** reply via `MessageStore.markDeleted`. Does not hard-delete rows, media, invoices, zap receipts, or gifts; does not call `deleteById`. Already-tagged targets keep original stamps and still return 204. When the target itself is external (`accountId === null && authorPubkey !== null`), after `markDeleted` succeeds the route calls the single atomic `blockPubkeyAndHideRows` operation to add the staff kill-switch entitlement block and soft-hide every other live row from that pubkey, then logs `messages.external.blocked` with `{ messageId, hidden: cascaded + 1 }`. Hiding a member note that merely has external children does not block a pubkey or hide that pubkey's other rows; only the normal direct-reply cascade applies. After `markDeleted` succeeds, a top-level shop note that had a place sends DELETE to `/map/places`. A failure logs `ocp.place.failed` and the response stays 204. Live public JSON never exposes the stamps; staff GET of a hidden row may include them. After a successful stamp (including already tagged), best-effort NIP-09 `kind: 5` is published for the target and each direct child with a non-empty `eventId` and non-null `accountId`, signed with that row's custodial nsec (not the staff deleter), to the durability relay plus the public relay list (not gated on `NOSTR_PUBLISH` / `NOSTR_PUBLISH_PUBLIC`). Then, when `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_API_TOKEN` are set and `PUBLIC_BASE_URL` resolves, public photo/video URLs for those rows are purged at Cloudflare (`purge_cache` files, chunks of 30). Sign/publish/purge failure still 204; logs `messages.delete.nostr_failed` / `messages.delete.purge_failed` / `messages.delete.retract_failed` with `messageId` only (never nsec, token, or post text). After the stamp (including already tagged), also best-effort retract in-app notifications whose `parentId` or `replyId` is the note or a direct child (`listChildIds` then `deleteByMessageIds([id, ...childIds])`). Retract / `listChildIds` failure logs `messages.delete.notifications_failed` and still 204 (never 503). Debug restore does not undelete Nostr or un-purge. Logs `messages.deleted` with `messageId`, `accountId`, and staff `role` (never post text).
- **Errors:** 401 `{ error: 'Unauthorized' }` without a session; 403 `{ error: 'Forbidden' }` when the live role is not at least moderator (including the author); 404 `{ error: 'Not found' }` for a non-UUID `:id` or missing row; 503 `{ error: 'Messages are unavailable' }` when the store throws (`messages.delete.failed`). NIP-09 / purge / notification retract failure is never 503. 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names an IANA zone that is Sunday on the server clock (a missing, blank, or invalid zone does not refuse).
- **Used by:** Staff hide controls in the app forum.
- **Auth:** `Authorization: Bearer` session (moderator).

## Endpoint: PATCH /messages/:id/place

- **Purpose:** Bearer required. A moderator sets, replaces, or clears the map pin on a live top-level shop note (`#21GiftsShop`) via `MessageStore.setPlace`. A shop pin is sent with PUT on every successful place write, including a replace. A clear sends DELETE. techProvider is `21.gifts`. A failure logs `ocp.place.failed` and this response stays 200. Boot sets `mapPush` when `SHOP_PLACE_PUSH_ENABLED` is true and both values are non-blank. Does not republish Nostr, change note text, or notify. `place: null` clears; a missing `place` key does not. A real change appends `message_edit`. An identical pin does not. Success is the live public message JSON (optional `place`, reply count, no hide stamps).
- **Errors:** 401 `{ error: 'Unauthorized' }` without a session; 403 `{ error: 'Forbidden' }` when the live role is not at least moderator; 404 `{ error: 'Not found' }` for a non-UUID `:id`, missing or hidden row, or `setPlace` false; 400 `{ error: 'Invalid body' }` for non-JSON or a missing `place` key; 400 `{ error: 'Place must be a latitude and longitude' }`; 400 `{ error: 'Place label must be at most 80 characters' }`; 400 `{ error: 'A reply cannot include a place' }`; 400 `{ error: 'Only a shop note can set a place' }`; 503 `{ error: 'Messages are unavailable' }`. 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names an IANA zone that is Sunday on the server clock (a missing, blank, or invalid zone does not refuse).
- **Used by:** Staff shop map pin in the app forum.
- **Auth:** `Authorization: Bearer` session (moderator).

## Endpoint: PATCH /messages/:id/shop-account

- **Purpose:** Bearer required. A moderator sets, replaces, or clears the 21.gifts account on a live top-level shop note (`#21GiftsShop`) via `MessageStore.setShopAccount`. The assignment is not the note author. Does not republish Nostr or change note text. `username: null` clears; a missing `username` key does not. A real change appends `message_edit`. An unchanged account does not. The assignment is the account id: a new name or username on that same id is not a change. When the updated row has a place, PUT the current pin to `/map/places` with techProvider `21.gifts`. No place means no map call. A failure logs `ocp.place.failed` and the response stays 200. Success is the live public message JSON (optional `shopAccount`, reply count, no hide stamps).
- **Errors:** 401 `{ error: 'Unauthorized' }` without a session; 403 `{ error: 'Forbidden' }` when the live role is not at least moderator; 404 `{ error: 'Not found' }` for a non-UUID `:id`; a missing or hidden row is 404 `{ error: 'Not found' }` before the handle is searched; `setShopAccount` false is 404 `{ error: 'Not found' }`; 400 `{ error: 'Invalid body' }` when the body is not a JSON object or has no `username` key; 400 `{ error: 'Username is not valid' }`; 404 `{ error: 'No account with that username' }` only after the row is a live shop note; 400 `{ error: 'A reply cannot include a shop account' }`; 400 `{ error: 'Only a shop note can set a shop account' }`; 503 `{ error: 'Messages are unavailable' }`. 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names an IANA zone that is Sunday on the server clock (a missing, blank, or invalid zone does not refuse).
- **Used by:** The app shops feed.
- **Auth:** `Authorization: Bearer` session (moderator).

## Endpoint: PATCH /messages/:id/text

- **Purpose:** Bearer required. A moderator changes the text of a live top-level shop note (`#21GiftsShop`) via `MessageStore.updateText`. The shop tag is kept or restored. Does not republish Nostr, notify, or change sats, media, author, mentions, event ids, or publish state. An unchanged body is 200 without a history row. A real change appends `message_edit`. Success is the live public message JSON (reply count, no hide stamps, no `edits` field).
- **Errors:** In order: 401 `{ error: 'Unauthorized' }` without a session; 403 `{ error: 'Forbidden' }` when the live role is not at least moderator; 404 `{ error: 'Not found' }` for a non-UUID `:id`; 400 `{ error: 'Invalid body' }` when the body is not a JSON object or `text` is missing or not a string; 400 `{ error: 'Text must be 1–8000 characters' }` before the row is read; 404 `{ error: 'Not found' }` for a missing row, a hidden row, or `updateText` undefined; 400 `{ error: 'A reply cannot be edited' }`; 400 `{ error: 'Only a shop note can be edited' }`; 400 `{ error: 'Text must be 1–8000 characters or include a photo' }` when the normalized text is empty and the note has neither a photo nor a video; the shop tag is then kept or restored, and if that exceeds 8000 characters, 400 `{ error: 'Text must be 1–8000 characters' }`; 503 `{ error: 'Messages are unavailable' }`. 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names an IANA zone that is Sunday on the server clock (a missing, blank, or invalid zone does not refuse).
- **Used by:** Staff shop-note text edit in the app forum.
- **Auth:** `Authorization: Bearer` session (moderator).

## Endpoint: PATCH /messages/:id/photos

- **Purpose:** Bearer required. A moderator replaces the stills on a live top-level shop note (`#21GiftsShop`) via `MessageStore.replacePhotos`. Body `{ photos: { contentType, data, takenAt? }[] }` (at most 10; empty clears stills). Does not republish Nostr, write `message_edit`, or change text, video, sats, author, or event ids. A video note keeps its video. Success is the live public message JSON.
- **Errors:** In order: 401 `{ error: 'Unauthorized' }`; 403 `{ error: 'Forbidden' }` below moderator; 404 `{ error: 'Not found' }` for a non-UUID `:id`; 400 `{ error: 'Invalid body' }`; 400 `{ error: 'At most 10 photos' }`; 400 `{ error: 'Photo must be a JPEG, PNG, or WebP under 1 MiB' }` before the row is read, including when that row is missing or hidden; 404 `{ error: 'Not found' }` for a missing row, a hidden row, or `replacePhotos` undefined; 400 `{ error: 'A reply cannot be edited' }`; 400 `{ error: 'Only a shop note can be edited' }`; 503 `{ error: 'Messages are unavailable' }`. 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names an IANA zone that is Sunday on the server clock (a missing, blank, or invalid zone does not refuse).
- **Used by:** The shop-note pencil wizard in the app.
- **Auth:** `Authorization: Bearer` session (moderator).

## Endpoint: GET /messages/:id/edits

- **Purpose:** Bearer required. A moderator lists `message_edit` history for a top-level shop note, newest first, including a hidden shop note. Does not change the note and does not republish Nostr. GET is not a Sunday write. Success is `{ edits: [{ id, createdAt, field, before, after, actor }] }`, newest first. `createdAt` is ISO. `field` is `text`, `place`, or `shopAccount` (SQL `shop_account` is published as `shopAccount`). `before` and `after` are the previous and next value: a text string, a place pin or null, or a shop account `{ id, username, name }` or null. `actor` is `{ id, name, role }`. A missing account keeps `{ id, name: null, role: null }`. Public message JSON does not include `edits`. Empty history is `{ edits: [] }`.
- **Errors:** 401 `{ error: 'Unauthorized' }` without a session; 403 `{ error: 'Forbidden' }` when the live role is not at least moderator; 404 `{ error: 'Not found' }` for a non-UUID `:id`, a missing row, a reply, or a note that is not a shop note; 503 `{ error: 'Messages are unavailable' }`. GET history is not refused with `SUNDAY_REST`.
- **Used by:** Staff shop-note history in the app forum.
- **Auth:** `Authorization: Bearer` session (moderator).

## Endpoint: GET /messages/hidden

- **Purpose:** Bearer session required (moderator; not `DEBUG_TOKEN`). Inverse **read** of `DELETE /messages/:id`. Lists soft-hidden forum rows (`deletedAt` set) newest-hidden first (`deletedAt` desc, then `id` desc), capped at 200, via `listHidden` / `serializeHiddenMessage`. Listed rows include every hidden row regardless of external-zapper entitlement — this endpoint is a moderation view and is intentionally unaffected by the read-visibility rule described above. Each item includes stored `name` (no empty-name pubkey fallback), ISO `createdAt` / `deletedAt`, `hasPhoto` / `photoCount` / `photoTakenAts` (length equals `photoCount`; null when unknown; `[]` when there are no stills; `photoTakenAt` only when `photoCount === 1`) / `hasVideo` / `videoContentType`, optional `goalSats` (positive integer on a top-level note; omitted when unset/null/0/absent or on a reply), optional `goalRepayable: true` only when stored true (omitted when null, never false, omitted on a reply), optional `goalTermDays` when stored (omitted when null, omitted on a reply), `goalCurrency`, `goalAmount`, and the four `goalAmount*` snapshots when `goalCurrency` is stored (omitted on a legacy row; a snapshot may be null), optional `place` when a pin is stored (omitted when unset), optional `shopAccount` (`{ id, username, name }`) when a shop account is stored (omitted when unset), always-present `parentId` (JSON `null` on top-level), and `deletedBy: { id, name, role }` resolved from `authStore.getAccount` (missing account keeps the id with `name` / `role` null; null `deletedBy` is `{ id: null, name: null, role: null }`). Optional `via: 'nostr'` is present exactly when `accountId === null && authorPubkey !== null`, the same rule as public message JSON; the pubkey itself is never included. Includes `accountId` when the author is a 21.gifts account and omits it for an external row. Never includes `eventId`, `nostrPublishState`, `payable`, author `role`, `nostrEvent`, `claimedUntil`, `contentFp`, nsec, or photo/video bytes. Unsigned/non-staff list/GET/photo/video stay 404 for hidden rows; a founder/moderator session may GET the hidden permalink and photo/video. No `forum.read` gate — a moderator without rules agreement is still 200. Logs `messages.hidden.listed` with `{ count }` only (never post text, never message ids). Registered before public `GET /messages/:id` so `"hidden"` is not captured as `:id`. No staff UNHIDE session route.
- **Errors:** 401 `{ error: 'Unauthorized' }` without a session; 403 `{ error: 'Forbidden' }` when the live role is not at least moderator (including the author / verified); 503 `{ error: 'Messages are unavailable' }` when the store, deleter lookup, or serialize throws (`messages.hidden.list_failed`).
- **Used by:** Staff hidden-note log in the app forum.
- **Auth:** `Authorization: Bearer` session (moderator). Not `DEBUG_TOKEN`.

## Endpoint: GET /.well-known/nostr.json

- **Purpose:** NIP-05 directory `{ names, relays }`. `names` keys are those locals (stored username wins over display-name slug; nameless accounts with a stored username are included). CORS `*`. Optional `?name=`.
- **Errors:** 503 `{ error: 'Directory is unavailable' }`.
- **Used by:** Damus verification; app proxies this from the site apex.
- **Auth:** none.

## Endpoint: GET /.well-known/lnurlp/:username

- **Purpose:** LUD-16 payRequest for `<username>@<host of PUBLIC_BASE_URL>` (in production `username@21.gifts`). A member receives only on their in-app wallet: when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve and the account has a verified wallet key (`sparkPubkeyVerifiedAt` is a number), the pay request comes from the self-hosted LNURL server (`GET /.well-known/lnurlp/<username>`, 5 s timeout, fixed `Host`, 120 requests per minute per client address); it is returned only when `walletPayRequest` accepts it with callback `<PUBLIC_BASE_URL>/lnurlp/<username>/invoice`. While an unexpired pending point-of-sale charge exists, both `minSendable` and `maxSendable` become that amount in millisats (`amountSats * 1000`). CORS `*`. `Cache-Control: no-store` so a public cache cannot keep the pin or the unpinned range. There is no pass-through to any other provider.
- **Errors:** 404 `{ error: 'Not found' }` when the username is invalid or unknown, the account has no verified wallet, or the LNURL server is not configured; an upstream 404 returns 404 with the same body; over the limit returns 429 `{ error: 'Too many requests' }`; an unreachable LNURL server, another non-2xx status, unparsable JSON, or a document `walletPayRequest` rejects returns 503 `{ error: 'Lightning Address could not be resolved' }`; 502 `{ error: 'Lightning Address could not be resolved' }` when the store throws.
- **Used by:** Lightning wallets paying `<username>@<host of PUBLIC_BASE_URL>`; app proxies this from the site apex.
- **Auth:** none.

## Endpoint: GET /mentions

- **Purpose:** Signed-in suggestions for `@` in a forum post or reply. Query `q` is optional. Omitted, empty, whitespace, or a lone `@` after trim is the first 20 handles in alphabetical order. Otherwise the value is trimmed, one leading `@` is stripped, and the rest is lowercased. That remainder must match `^[a-z0-9][a-z0-9._-]{0,31}$` or the route returns 400. A valid token matches the start of the username, the start of a username segment split on `.` `_` `-`, the start of the display name, or a display-name word split on space `.` `_` `-`. A token that itself contains `.`, `_`, or `-` matches only a whole-string start. Each row is `{ id, username, name }` where `name` is the trimmed display name, or the stored username when that name is blank. At most 20 rows, ordered by `lower(trim(username))` then `id`. Blank usernames are skipped. Does not parse or store `@username` marks on a note.
- **Errors:** 401 `{ error: 'Unauthorized' }` without a usable bearer session; 409 `{ error: 'missing_requirements', missing }` when `forum.read` is not allowed yet; 400 `{ error: 'Invalid query' }` when the remainder after trim and one leading `@` is not a username prefix.
- **Used by:** The forum composer suggestion list (`GET /forum/mentions` on the app, which proxies here).
- **Auth:** Bearer session with `forum.read`.

## Endpoint: GET /pay/:username

- **Purpose:** Public, unauthenticated pay-link card for a member. Normalises `:username`, loads the account, and returns `name`, `username`, `minSats`, `maxSats`, and `charge` from the LNURL-pay metadata of the member's receiving address (`receivingAddress`: their verified wallet, resolved internally against the LNURL server). `name` is the trimmed display name, or the normalised username when the display name is blank. No charge → `charge: null` and the wallet sat range. Unexpired pending → both bounds equal that amount and `charge` is `{ amountSats, expiresAt }` only. A bad wallet window is still 502 before any pin. Does not return the callback, the Lightning Address, or provider metadata. No spend token.
- **Errors:** 404 `{ error: 'Not found' }` when the username is invalid, the account is unknown, or it has no receiving address (no verified wallet, or the LNURL server is not configured); 502 `{ error: 'Lightning Address could not be resolved' }` when the LNURL server is unreachable, the store throws, `currentPending` throws, `minSendable` or `maxSendable` is not a safe integer, or `maxSats < minSats`.
- **Used by:** A browser pay page that uses GET /pay/:username to show an open till instead of a free amount.
- **Auth:** none.

## Endpoint: POST /pay/:username/invoice

- **Purpose:** Public, unauthenticated BOLT11 mint for an exact satoshi amount. Same account lookup as `GET /pay/:username`, then `{ amountSats: number }` must be an integer inside `[minSats, maxSats]` whose millisatoshi value sits inside the provider window. A different POST amount while a charge is open is the existing 400 and does not call the invoice callback. The charge amount must still sit in the provider millisatoshi window or that same 400 is returned and the callback is not called. Settlement calls `requestGiftInvoice` on the member's receiving address, the verified in-app wallet resolved internally through the LNURL server; there is no fallback to an external address. Response is `{ pr, amountSats }` with no comment sent. No spend token.
- **Errors:** 404 `{ error: 'Not found' }` for an invalid username, unknown account, or no receiving address (no verified wallet, or the LNURL server is not configured); 400 `{ error: 'Enter a whole number of sats' }` for missing or invalid JSON, a non-integer, or an amount outside the window; 502 `{ error: 'Lightning Address could not be resolved' }` when the address cannot be resolved, the store throws, `currentPending` throws, the sat window is empty or not a safe integer, the invoice fetch fails, or the BOLT11 is missing, not a safe integer amount, or not for that exact millisatoshi amount.
- **Used by:** The browser pay page minting the open till amount when a charge is present, not a freely typed amount.
- **Auth:** none.

## Endpoint: POST /lnurl/pay-request

- **Purpose:** Fetches and checks the LNURL pay request of a Lightning Address or bech32 LNURL on another host, for addresses the app cannot read from the browser (no CORS). Body `{ target }`; an optional `lightning:` prefix (any case) is dropped and the target is lowercased; a bech32 LNURL in mixed case is refused. The URL must be `https`, on a DNS name of at most 253 characters with at least two labels (no address literal, no `localhost`, no `.local` / `.internal` / `.localhost`, no trailing dot), with no port other than the default 443 and no user name or password, and every address it resolves to must pass `isPublicIp` (public unicast only, IPv4 carried in IPv6 checked as IPv4), and an IPv6 answer must also lie in `2000::/3` or the well-known NAT64 prefix `64:ff9b::/96` and not in `2001::/23`. A Lightning Address whose name is only dots is refused. The fetch does not follow redirects and reads at most 64 KB; each lookup and each fetch waits at most 5 s and the whole call at most 8 s (below the server's 10 s idle timeout). The pay request needs `tag: 'payRequest'`, an `https` callback that passes the same host checks, a string `metadata`, safe-integer `minSendable` ≥ 1 and `maxSendable` ≥ `minSendable`, and an optional non-negative integer `commentAllowed` (missing or null is 0). Response `{ target, minSendableMsat, maxSendableMsat, commentAllowed, description, domain }`; `description` is the metadata's `text/plain` entry or an empty string.
- **Errors:** 401 `{ error: 'Unauthorized' }` without a session; 429 `{ error: 'Too many requests' }` with `Retry-After: 60` over 30 relay requests per member per minute (shared with `POST /lnurl/invoice`); 400 `{ error: 'Not a payable address' }` for a missing or malformed target (including one over 2048 characters), a target on the host of `PUBLIC_BASE_URL`, a target or callback host that resolves to a non-public address, or a pay request that fails the checks; 404 `{ error: 'Address not found' }` for HTTP 404/410 or an LNURL `ERROR` body; 502 `{ error: 'Address could not be reached' }` for a host that does not resolve in time, a step or the whole call running out of time, a network failure, timeout, redirect, other non-2xx status, an oversize body, or a body that is not a JSON object.
- **Used by:** The app when a member pays a Lightning Address or LNURL on another host with the in-app wallet.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /lnurl/invoice

- **Purpose:** Resolves `target` again (same checks as `POST /lnurl/pay-request`; the client never sends a callback URL), checks `amountMsat` and `comment`, and requests a BOLT11 from the callback with `amount` and, when non-empty, `comment`. Body `{ target, amountMsat, comment? }`. The invoice must decode to exactly `amountMsat` and carry a description hash equal to SHA-256 of the pay request's `metadata`. Response `{ pr }`. Success logs `lnurl.invoice.ok` with `amountMsat`; failure logs `lnurl.invoice.failed` with `reason` and `status`; the target, comment, and invoice are never logged.
- **Errors:** As `POST /lnurl/pay-request`, plus 400 `{ error: 'Amount out of range' }` when `amountMsat` is not a number, not a whole number of millisatoshis, or outside `[minSendable, maxSendable]`; 400 `{ error: 'Comment too long' }` when `comment` is not a string (null is no comment), is not well-formed Unicode (a lone surrogate) or longer than 2000 UTF-16 code units (both refused before any outbound request), or has more characters than `commentAllowed`; 502 `{ error: 'Address could not be reached' }` when the invoice fetch fails or the invoice is missing, undecodable, for another amount, or for another description hash.
- **Used by:** The app before it pays the returned `pr` with the in-app wallet.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /apple-touch-icon.png

- **Purpose:** PNG brand mark (apple-touch). `Cache-Control: public, max-age=86400`.
- **Errors:** 404 empty body when `public/apple-touch-icon.png` is missing.
- **Used by:** iOS home-screen icon crawlers.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /debug/accounts

- **Purpose:** Operator listing of registered accounts. Same shape as `serializeDebugAccount`: public fields including `username`, plus `isPlatform`, `sessionRefused`, `viewKey`, skip stamps, `profileMessageId`, `notificationLevel`, `amountUnit`, `locale` (nullable, null when unset, owner/debug only, omitted from public member cards and view profiles), `fiat` (nullable, null when unset, owner/debug only, omitted from public member cards and view profiles), `walletRequired`, `walletBackupSeenAt`, `sparkPubkey`, `sparkPubkeyVerifiedAt` (null until claimed / verified), and Nostr debug fields (`nostrNsecCiphertext` is hex of the stored envelope, never decrypted).
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match.
- **Used by:** Operator `gifts-debug` CLI.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: POST /debug/accounts

- **Purpose:** Operator provision of accounts by display name (no passkey, no wallet, `rulesAgreedAt` null). Body `{ "accounts": [ { "name", "username"? } ] }` (1–100 rows; unknown keys such as `lightningAddress` are refused). With `username`, an existing account with that username (`lower(trim)`) gets only its `name` updated (`created: false`; other columns stay) and otherwise a new `basis` row with that username and a fresh `viewKey` is created. Without `username`, every row creates a new `basis` row with a username derived from the name (`provisionUsername`). A provisioned member has no verified wallet, so it can read but cannot receive or post until it sets one up. Response `{ accounts: [ { name, username, viewKey, created } ] }` includes `viewKey` for the invite link. `GET /debug/accounts` and `GET /debug/accounts/:id` also include `viewKey` and `username`.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 400 `{ error: 'Expected a JSON body with an "accounts" array' }` for an invalid/missing/non-JSON body, an unknown row key, C0/DEL names, or an invalid username (no row is written); 500 `{ error: 'Could not save the account' }` when a created row cannot be read back.
- **Used by:** Operator provisioning before passkey claim.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: GET /debug/accounts/:id

- **Purpose:** Operator read of one account (`serializeDebugAccountDetail`): the account columns except the legacy `lightning_address` and `lightning_address_verified`, plus nested `passkeys`, `sessions`, and matching `passkeyChallenges`. `lightningAddress` is the receiving address (verified wallet) when the LNURL server is configured. `nostrNsecCiphertext` is hex of the stored AES-GCM envelope, never decrypted. Nested `sessions[].token` is the stored plaintext token.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 404 `{ error: 'Not found' }` when the id is not a UUID or the account is missing.
- **Used by:** Operator `gifts-debug account`.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: POST /debug/accounts/:id/session

- **Purpose:** Operator mint of a member bearer session for the given account id. Response `{ token }`. For e2e and operator debugging only — not a member login path. An account with `sessionRefused` is refused with no mint and no `debug.accounts.session_minted` log.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 404 `{ error: 'Not found' }` when the account id is unknown; 403 `{ error: 'You signed in with the wrong account. Please try again with the correct account.' }` when `sessionRefused` is true.
- **Used by:** Playwright e2e against the booted process; operators reproducing member HTTP.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: POST /debug/accounts/merge

- **Purpose:** Operator merge of account `from` into account `into`, in one database transaction. Body `{ "from", "into", "verify"? }`. Both ids are UUIDs. `verify` is `from` or `into` and defaults to `into`. Success is 200 `{ into, deleted, messages }`: `deleted` is the source id, `messages` is how many message rows belonged to `from` before the move. The survivor is the account named by `into`. Its name, username, location, and in-app wallet key stay, including the wallet verification. Gifts are stored against the Wallet of Satoshi username and are not moved. Nostr keys, the view key, and the linking key stay. `sessionRefused` stays the survivor's: a refusal on the closed account does not lock the login that remains. Notification level and amount unit stay the survivor's, because those columns have no empty value. Locale and fiat stay when the survivor already has one, and are copied from the source only when the survivor's value is empty. `created_at` becomes the earlier of the two times, so a replacement login does not look like a new person. `rules_agreed_at` becomes the earlier agreement; if only one account agreed, that time is kept; if neither agreed, it stays empty. `wallet_required` becomes true when either account already has it, so a closed recovery-phrase prompt is not opened again. `wallet_backup_seen_at` becomes the earlier time, or the only time when just one account has seen it. `forum_laws_dismissed` becomes true when either account dismissed the laws. Role stays the survivor's and is never downgraded; a basis survivor becomes verified when a verify edge remains. The profile note stays the survivor's when it has one, and is the source profile note only when the survivor has none. `verify: "into"` keeps the survivor's verify edge and deletes the source's. `verify: "from"` deletes the survivor's verify edge and moves the source's onto the survivor. Passkeys of both accounts stay, so both phones can sign in. Sessions of the source are deleted, not moved. Messages, contacts, and push rows are moved. A direct conversation that exists only between the two accounts is deleted. Two conversations with the same other party are collapsed onto the survivor's conversation, and the messages are kept. The same slot of a profile image, the same notification, the same repayment day, and a second open till charge keep the survivor's row and drop the source's. A second funding grant refuses the merge. A throw rolls every write back.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 503 `{ error: 'Merge is unavailable' }` when `mergeDb` is omitted or the merge throws (including SQLSTATE 23505); 400 `{ error: 'Expected a JSON body with "from" and "into"' }` for a missing, non-JSON, or invalid body; 409 `{ error: 'Cannot merge an account into itself' }` when `from` and `into` are the same id; 404 `{ error: 'Not found' }` when either account is missing; 409 `{ error: 'Cannot merge the platform account' }` when either account is the platform account; 409 `{ error: 'Both accounts have a funding grant' }` when both accounts have a funding grant.
- **Used by:** Operator debug token. Not a member session.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: PATCH /debug/accounts/:id

- **Purpose:** Operator assignment of `account.role` (`basis` \| `verified` \| `moderator` \| `initiator` \| `founder`), the official platform flag, and/or `sessionRefused`. Body may include any of `{ "role": "<AccountRole>" }`, `{ "platform": true|false }`, `{ "sessionRefused": true|false }`; unknown keys (including `lightningAddress`) are refused. Setting `platform: true` clears any other platform flag (at most one true) and, when a conversation store is wired, points every `member_platform` thread at this account (`retargetMemberPlatform`), except a thread whose member is already this account. `sessionRefused: true` makes passkey finish and debug session mint return 403 with the wrong-account copy. Returns the updated account JSON (same shape as `GET /debug/accounts` via `serializeDebugAccount`, including `isPlatform`, `sessionRefused`, `viewKey`, `walletRequired`, `walletBackupSeenAt`, `sparkPubkey`, `sparkPubkeyVerifiedAt` (null until claimed / verified), and Nostr debug fields).
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 400 `{ error: 'Expected a JSON body with a "role" string, platform boolean, and/or sessionRefused boolean' }` for an unknown key or a missing/non-JSON body; 404 `{ error: 'Not found' }` when the account id is unknown.
- **Used by:** Operator `gifts-debug role` / `gifts-debug refuse-session` CLI and platform-account setup. Does not write trust edges (`POST /debug/trust-edges` is the backfill path).
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: GET /debug/db

- **Purpose:** Operator read of every ordinary table in schema `public`. With no `table`, returns `{ tables: [{ name, rowCount }] }` sorted by name. With `table`, returns one page of 200 rows (`columns`, `rows`) and `nextCursor` when another page exists. Follow `nextCursor` until it is absent to read the whole table. `bytea` values, including `nostr_nsec_ciphertext`, are octet lengths (or null), never the bytes. Text columns named `token`, `challenge`, `nonce`, `view_key`, `endpoint`, `p256dh`, `auth`, `delivered_endpoints`, or `skip_endpoints` are the string `"redacted"` when not null. A primary key that is one of those secret columns is paged by `ctid`, so `nextCursor` is not the secret. There is no `limit` that stops early.
- **Errors:** 503 `{ error: 'Debug is not configured' }` only when `DEBUG_TOKEN` and `DEBUG_READ_TOKEN` are both empty after trim; 401 `{ error: 'Unauthorized' }` when the bearer matches no configured token; 503 `{ error: 'Database is not configured' }` when this process has no SQL client; 404 `{ error: 'Not found' }` when `table` is not an ordinary public table; 400 `{ error: 'Invalid cursor' }` when `cursor` is present without `table` or does not match the table key; 503 `{ error: 'Database is unavailable' }` if the store throws (`debug.db.failed`).
- **Used by:** Operators reading the whole database (`gifts-debug db`).
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN` or `DEBUG_READ_TOKEN`. `DEBUG_READ_TOKEN` applies only to GET and HEAD `/debug/db`. HEAD is the same GET handler. Not an end-user session.

## Endpoint: GET /debug/api-log

- **Purpose:** Operator listing of HTTP audit rows newest-first, one keyset page of 200. Follow `before` (last log `createdAt`) and `beforeId` (its `id`) while `hasMore` is true to read every matching row, including every row for one `accountId`. Omit `accountId` for every account. Body `{ logs, hasMore }`: method, redacted path, status, ms, nullable `accountId` (always present; JSON `null` unless `authKind` is `session`), `authKind` (`session` | `debug` | `spend` | `none`), and nullable `clientIp`, `clientCountry`, `cfRay`, `userAgent`, `acceptLanguage`, and `origin` (JSON `null` when the header is missing or invalid). `createdAt` is ISO-8601. The `api_log` dump is the newest 200; the full history is this endpoint. No query string, Authorization, bodies, or tokens. OPTIONS and `/healthz` are not stored.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 400 `{ error: 'Invalid account' }` when `accountId` is present and not a UUID; 400 `{ error: 'Invalid cursor' }` when only one of `before` / `beforeId` is present, `before` is not a finite `Date.parse` time, or `beforeId` is not a UUID; 503 `{ error: 'Log is unavailable' }` if the store throws (`api_log.list.failed`).
- **Used by:** Operators attributing who called the API (`gifts-debug api-log`).
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: POST /diagnostics

- **Purpose:** Public client diagnostic ingest with no auth. The JSON object requires `event` (`client.` plus 1–60 of `a-z`, digits, and `.`). Optional `name` (1–40 letters), `message` (1–120 of letters, digits, `.`, `_`, `:`, space, `-`; no slash), `prfPresent` (boolean, never the bytes), `challengeId` (64 lowercase hex), `accountId` (UUID), `stage` (`register` / `authenticate` / `seed` / `login` / `unhandled`), `status` (integer 100–599), and `path` (string; `/view/<segment>` becomes `/view/:viewKey`; rejected if it contains `?` or 32 lowercase hex digits (`0-9`, `a-f`) in a row). Any other key is rejected. A valid body is stored as a `client` row and answered with 204 and an empty body. `User-Agent` is not a body field; the server may store it as `userAgent` after stripping controls and truncating to 200. The server also stores `clientIp`, `clientCountry`, `cfRay`, `acceptLanguage`, and `origin` when those headers validate, using the same rules as the audit log; those names are not body keys, and absent values are omitted. Rows are kept forever (no TTL, no DELETE). Secrets are not stored: no PRF bytes, mnemonic, session token, view key, nsec, Authorization, Cookie, WebAuthn challenge, attestation, signatures, or raw request bodies.
- **Errors:** 400 `{ error: 'Invalid diagnostics' }` when JSON or any field fails the allowlist; 429 `{ error: 'Too many diagnostics' }` when the IP window (60) or the global window (600) in 60 seconds is full (the accept timestamp is not recorded on 429); 500 `{ error: 'Log is unavailable' }` when the insert throws (that failure does not consume a rate-limit slot).
- **Auth:** None. No session and no debug bearer.

## Endpoint: GET /debug/diagnostics

- **Purpose:** Operator read of diagnostic rows, newest-first, cap 200, with `createdAt` as ISO-8601 and allowlisted scalar fields. Rows are kept forever (no TTL, no DELETE). No PRF bytes, mnemonic, session token, view key, nsec, Authorization, Cookie, WebAuthn challenge, attestation, signatures, or request bodies.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 503 `{ error: 'Log is unavailable' }` if the store throws.
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

- **Purpose:** Manually settle one successful forum `message_invoice` by its 32-byte payment hash. Body `{ paymentHash, note, preimage? }`; `note` is trimmed operator evidence (1–8000 characters, no C0/DEL controls). A verified optional preimage is stored in the synthetic kind:9735 tags, but is not required because wallet-internal payments can expose a value that does not hash to the invoice payment hash.
- **Trust / effects:** `DEBUG_TOKEN` plus the required durable note is the settlement authority; when supplied, `preimage` must be 32-byte hex and hash to `paymentHash`. Success claims the payment hash, credits `message.sats` once, writes an `indexed` `nostr_zap_ingest` with `manual=debug-settle` and `note`. On a member note, fans out `notifyZap` and inserts the payer gift-reply. On the platform profile note, skips `notifyZap` and treats the zap comment as a compose post/reply (`sats` 0) gated by `forum.post`; a created top-level post fans out `notifyForumPost` and `spendPing` only when `eligibleToday` (same gate as `POST /messages`), a reply fans out `notifyForumReply`. The response contains only `{ receiptId, messageId, amountSats, resumed }`, never the note or preimage. If credit succeeded but that direct ingest write failed, a retry writes the missing ingest from the current request, runs the post-credit effects, returns `resumed: true`, and does not credit again.
- **Errors:** 400 `Invalid body` for malformed JSON/types, 400 `Invalid note`, 400 for malformed/mismatched hash or preimage, 404 for a missing invoice/message, 409 for conversation invoices or an already indexed/settled payment, and 503 `Messages are unavailable` when a store operation throws, including the ingest write, or a thrown note-author lookup before claim. A later relay receipt for the same hash is recorded as `rejected`/`settled` and cannot add sats again because the payment-hash claim survives ingest failures and message deletion.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`; unset/blank returns 503 and a bad bearer returns 401. This operator-only authority is the same debug token used for role assignment and session minting.
- **Used by:** `gifts-debug settle <payment-hash> <note> [preimage]` after the normal zap-receipt window has elapsed.

## Endpoint: POST /debug/spend-ping

- **Purpose:** Replay today's daily spend ping for one qualifying top-level forum post. Body `{ messageId }` (UUID). The process calls `spendPing.ping(address, message.id, 'daily', effectiveStatus(grant, now))` only when the note is live, not a reply, not the account profile note, created on the current UTC day, the account has a receiving address (verified wallet, sent as `address`), `eligibleToday` is true, and the note has media (`hasPhoto`, `hasVideo`, or `photoCount` > 0). Success is 202 `{ messageId }`. The address is never returned.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 503 `{ error: 'Spend ping is not configured' }` when `spendPing` is absent; 400 `{ error: 'Invalid body' }` for malformed JSON, a non-object, or a non-UUID `messageId`; 404 `{ error: 'Not found' }` when the message is missing; 404 `{ error: 'Account not found' }` when `accountId` is null or the account is missing; 409 `{ error: 'Message is hidden' }`, `{ error: 'Replies are not paid' }`, `{ error: 'Profile notes are not paid' }`, `{ error: 'Message is not from today' }`, `{ error: 'No Lightning address' }`, or `{ error: 'Message has no media' }`; 403 `{ error: 'Not eligible' }` when `eligibleToday` is false (no ping); 503 `{ error: 'Messages are unavailable' }` when `getById`, `getAccount`, `getByAccountId`, or `ping` throws (`debug.spend_ping.failed`). Skips log `debug.spend_ping.skipped` with `reason` `not_eligible` or `no_media`. A sent ping logs `debug.spend_ping.sent`. Logs carry `messageId` only, never the address.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.
- **Used by:** Operators replaying a qualifying living-room post that never reached spend.

## Endpoint: GET /debug/zap-ingests

- **Purpose:** Operator listing of kind:9735 ingest decisions newest-first (cap 200): `outcome` (`indexed` \| `rejected`), `reason`, receipt id, note/message ids, amount, and the receipt event frame. ISO `createdAt`. Never includes nsec. One `nostr_zap_ingest` row is written per receipt per decision change per process (the memory is per store instance and empty after a restart, so the first ingest pass after boot may write one `rejected`/`duplicate` row per receipt that pass still queries (`listLatest` plus non-null `listReplies` children of those rows, plus the newest MESSAGE_LIST_LIMIT live replies that have an event id (`listRecentReplies`) even when their parent is not in `listLatest`, unioned with the official platform profile note's `eventId` even after it ages out of `listLatest`)). A repeated identical `outcome:reason` is normally not written again, because the memory is consulted before the write; that is not a guarantee, since the memory is set only after the write resolves, fast-lane ticks are not serialised, and a failed write leaves it untouched. Receipts whose remembered decision is terminal (`indexed` or `rejected`/`duplicate`) skip note lookup, account/LNURL validation, and ingest persist, but still run `verifyReceipt` then `tryEnsureGiftReply`.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 503 `{ error: 'Messages are unavailable' }` when listing throws (`debug.zap_ingests.list_failed`).
- **Used by:** Operators debugging zap receipt indexing.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: GET /debug/messages

- **Purpose:** Operator listing of every persisted forum row newest-first (cap 200): top-level notes **and** replies, live **and** soft-hidden (`deletedAt` set). Public hide does **not** apply. JSON via `serializeDebugMessage` (`id`, `name`, `text`, ISO `createdAt`, `sats`, `goalSats` (stored column; JSON `null` when unset), `goalRepayable` only when stored true (omitted when null, never false), `goalTermDays` only when stored (omitted when null), `goalCurrency`, `goalAmount`, and `goalAmountUsd` / `goalAmountChf` / `goalAmountEur` / `goalAmountPhp` when `goalCurrency` is stored (omitted on a legacy row; a snapshot may be null), `placeLat`, `placeLng`, `placeLabel` (JSON `null` when unset), `hasPhoto`, `photoCount` (0–10), `photoTakenAts` (always; length equals `photoCount`; null when unknown; `[]` when there are no stills), `photoTakenAt` only when `photoCount === 1`, `hasVideo`, `videoContentType`, `parentId`, `eventId`, `nostrPublishState`, `nostrEvent`, `claimedUntil`, `nostrFirstAttemptAt`, `nostrPublishEpoch`, `contentFp`, ISO-or-null `deletedAt`, `deletedBy`, `authorPubkey`, `nostrAttempts`, `accountId` as a string or JSON `null` for Damus-only, plus photo MIME/byte lengths). Never includes nsec or photo/video payloads.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 503 `{ error: 'Messages are unavailable' }` when listing throws (`debug.messages.list_failed`).
- **Used by:** Operators inspecting hidden forum notes (`gifts-debug messages`).
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: GET /debug/messages/:id

- **Purpose:** Operator single-note fetch (Bearer `DEBUG_TOKEN`). Returns the debug JSON object (not wrapped) via `serializeDebugMessage` (same columns as `GET /debug/messages`, including `nostrEvent`, `claimedUntil`, `contentFp`, photo MIME/byte lengths, stored `goalSats` as JSON `null` when unset, `goalRepayable` only when stored true (omitted when null, never false), `goalTermDays` only when stored (omitted when null), the currency-ask keys when `goalCurrency` is stored, and `placeLat` / `placeLng` / `placeLabel` as JSON `null` when unset). Soft-hidden rows (`deletedAt` set) are **200** with `deletedAt` / `deletedBy` / `text`. Public `GET /messages/:id` hide does **not** apply. Unknown or non-UUID `:id` is 404. Never includes nsec or photo/video payloads.
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

- **Purpose:** Operator unhide of a soft-hidden forum note (Bearer `DEBUG_TOKEN`). Calls `MessageStore.markUndeleted`: inverse of `markDeleted`'s cascade (clears `deletedAt` / `deletedBy` on the hidden target and stamp-matched **direct** children; already-live target is a no-op for children). After that succeeds, calls `unblockPubkeyByMessage`, which removes a block only when this id is the source row whose hide created it. Restoring that source row unblocks the pubkey but leaves unrelated cascade-hidden rows hidden; restoring any other row hidden by the external-pubkey cascade makes that row visible but leaves the pubkey blocked, so each such row must be restored separately and new content from the still-blocked pubkey continues to be rejected. Does not recreate the row via `POST /messages`, does not hard-delete, and does not unlink media, invoices, zap receipts, Nostr, text, or photo. Existing live id still 204. Success is 204 empty body. After a successful unhide, a live top-level shop note with a place is PUT again to `/map/places`. Missing `mapPush` does nothing. A map failure logs `ocp.place.failed` and the response stays 204. Logs `debug.messages.restored` with `{ messageId }` only (never text, never `deletedBy`).
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

## Endpoint: POST /debug/passkey-renew/reopen

- **Purpose:** Operator delete of one account's failed passkey-renew rows so the blocking dialog opens again at the explanation. Body `{ accountId }` UUID. Returns `{ deleted }`. Succeeded and cancelled rows stay. Does not change the account. Refuses when `walletRequired` is true.
- **Errors:** 503 Debug is not configured; 401 Unauthorized; 400 Invalid account; 404 Not found; 409 Account already has a seed.
- **Used by:** Operators who must ask one member to repeat passkey renew.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: POST /auth/passkey/authenticate/begin

- **Purpose:** Issues WebAuthn request options for a discoverable credential. JSON: challengeId, options (`extensions.prf.eval.first` = base64url SHA-256 of `21gifts-nostr-v1`).
- **Errors:** HTTP 500 `{ error: 'Server auth is not configured' }` if `WEBAUTHN_RP_ID` is unset, blank, not on the allowlist, or no CORS origin matches it. That 500 is logged as `auth.passkey.login.fail` with the same error and no account id.
- **Used by:** App passkey sign-in.
- **Auth:** Public.

## Endpoint: POST /auth/passkey/authenticate/finish

- **Purpose:** Verifies the assertion and issues `{ token, account }` immediately. Requires `Origin`. `{ token, account }` uses owner JSON including `hasPosted`, `aboutMe`, `aboutMeHasPhoto`, `notificationLevel`, `amountUnit`, `funding`, `walletRequired`, `walletBackupSeenAt`, and `passkeyCredentialId`. An account with `sessionRefused` is refused with no bearer.
- **Errors:** 400 invalid body/origin/challenge/credential; 403 `{ error: 'You signed in with the wrong account. Please try again with the correct account.' }` when `sessionRefused` is true; 500 if WebAuthn is unconfigured. A missing body is 400 `Expected a JSON body with challengeId and credential`, logged as `auth.passkey.login.fail` with `json` `absent` and `bodyBytes`. Invalid JSON is 400 `Finish body is not valid JSON`, logged with `json` `invalid` and `bodyBytes`, and the text is not logged. A parsed body without `challengeId` and `credential` is the expected-body 400, logged with `json` `parsed`, `bodyKind`, and for an object `hasCredential` and `challengeIdKind`. The challenge id is logged only when it is 64 lowercase hex. The credential and the raw body are not logged. The 500 is logged as the same event with `Server auth is not configured`.
- **Used by:** App passkey sign-in.
- **Auth:** Public (proof is the assertion).

## Endpoint: POST /auth/passkey/register/begin

- **Purpose:** Issues WebAuthn creation options. JSON: challengeId, options (`extensions.prf: {}`). Empty body, `{}`, or no `name` and no `viewKey` mints a pending new account id (row created only on finish); `user.name` is that UUID and `user.displayName` is `21.gifts`. Optional `{ "name": string }` with no `viewKey` normalizes with the username rules; on success `user.name` and `user.displayName` are that normalized string and `user.id` stays the new account UUID. Optional body `{ "viewKey": "<64-hex>" }` claims an operator-provisioned account (same id/name/username/viewKey) and ignores `name`.
- **Errors:** HTTP 500 `{ error: 'Server auth is not configured' }` if `WEBAUTHN_RP_ID` is unset, blank, not on the allowlist, or no CORS origin matches it; 400 `{ error: 'Expected a JSON body with an optional "viewKey" string' }` when `viewKey` is present but not a string; 400 `{ error: 'Expected a JSON body with an optional "name" string' }` when `name` is present and not a string; 400 `{ error: 'Username must be 1–32 characters of a-z, 0-9, hyphen, underscore, or dot' }` when `name` does not normalize; 404 `{ error: 'This profile could not be found.' }` for a malformed/unknown view key; 409 `{ error: 'This profile already has a passkey' }` when the provisioned account already has a credential; 409 `{ error: 'Username is already in use' }` when the normalized name is taken. Failed name checks write no challenge row. Invalid JSON is 400 `{ error: 'Begin body is not valid JSON' }`, logs `auth.passkey.register.fail` with `json` `invalid` and `bodyBytes`, and does not open a challenge. Those failures log `auth.passkey.register.fail` with the error text and not the view key.
- **Used by:** App passkey account creation and claim-by-viewKey.
- **Auth:** Public.

## Endpoint: POST /auth/passkey/register/finish

- **Purpose:** Verifies the attestation, creates a `linkingKey: null` account (or binds a passkey to a provisioned account without recreating it), issues `{ token, account }`. Requires `Origin`. When the challenge stored a name, the new account's `name` and `username` are that string. `{ token, account }` uses owner JSON including `hasPosted`, `aboutMe`, `aboutMeHasPhoto`, `notificationLevel`, `amountUnit`, `funding`, `walletRequired`, `walletBackupSeenAt`, and `passkeyCredentialId`. An account with `sessionRefused` is refused with no bearer.
- **Errors:** 400 invalid body/origin/challenge/passkey; 400 `{ error: 'Username must be 1–32 characters of a-z, 0-9, hyphen, underscore, or dot' }` when the stored name no longer normalizes; 403 `{ error: 'You signed in with the wrong account. Please try again with the correct account.' }` when `sessionRefused` is true; 409 `{ error: 'Username is already in use' }` when that handle is taken or the account row was not inserted. Those name failures create no credential and no session. 500 if WebAuthn is unconfigured. A missing body is 400 `Expected a JSON body with challengeId and credential`, logged as `auth.passkey.register.fail` with `json` `absent` and `bodyBytes`. Invalid JSON is 400 `Finish body is not valid JSON`, logged with `json` `invalid` and `bodyBytes`, and the text is not logged. A parsed body without `challengeId` and `credential` is the expected-body 400, logged with `json` `parsed`, `bodyKind`, and for an object `hasCredential` and `challengeIdKind`. The challenge id is logged only when it is 64 lowercase hex. The credential and the raw body are not logged. The 500 is logged as the same event with `Server auth is not configured`.
- **Used by:** App passkey account creation and claim-by-viewKey.
- **Auth:** Public (proof is the attestation).

## Endpoint: POST /auth/passkey/replace/begin

- **Purpose:** Bearer session. Refuses to replace a passkey. A recovery phrase is never replaced. Does not create a challenge and does not delete or insert a credential. `walletBackupSeenAt` is not consulted.
- **Errors:** 401 `{ error: 'Unauthorized' }` missing or invalid Bearer; 409 `{ error: 'A recovery phrase cannot be replaced' }` after a valid session; 500 `{ error: 'Server auth is not configured' }` when WebAuthn is unconfigured (checked before the bearer). That 500 is logged as `auth.passkey.replace.refused` with the same error and no account id.
- **Used by:** App passkey replace, which the api now refuses.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /auth/passkey/replace/finish

- **Purpose:** Bearer session. Same refusal as begin. Does not parse a ceremony once the session is valid. Does not delete or insert a passkey. Does not mint a session. `walletBackupSeenAt` does not decide whether a seed exists.
- **Errors:** 401 without a session; 409 `{ error: 'A recovery phrase cannot be replaced' }` after a valid session; 500 if WebAuthn is unconfigured. That 500 is logged as `auth.passkey.replace.refused` with `Server auth is not configured` and no account id.
- **Used by:** App passkey replace, which the api now refuses.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /auth/passkey/seed/begin

- **Purpose:** Bearer session. When `walletRequired` is not true, issues WebAuthn creation options for one extra seed passkey (`{ challengeId, options }`, no `excludeCredentials`, user id and name are the account id). Does not delete the login passkey. `walletRequired: true` means a seed passkey already exists. A 409 because a seed already exists stores a failed renew row (`stage` `begin`, HTTP 409), logs `auth.passkey.seed.fail` with the account id and error, and does not change the account. A 200 stores no renew row. 401 stores no row and no diagnostic row. 500 stores no renew row and logs `auth.passkey.seed.fail` with `Server auth is not configured`.
- **Errors:** 401 missing or invalid Bearer; 409 `{ error: 'This account already has a recovery phrase' }` when `walletRequired` is true (no challenge); 500 if WebAuthn is unconfigured.
- **Used by:** App add-recovery-phrase for an account that has no seed yet.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /auth/passkey/seed/finish

- **Purpose:** Bearer session. Verifies a `seed` attestation and inserts an additional passkey, setting `walletRequired` true. Does not delete the login passkey, does not change `walletBackupSeenAt`, and does not mint a session. Success JSON is the owner account itself, same shape as `GET /me`, with no `token` and no `account` wrapper. `passkeyCredentialId` is the new credential id. `walletBackupSeenAt` does not decide whether a seed exists. A 400 or 409 after the session is known stores a failed renew row and does not change the account. Success stores `outcome` `succeeded` with null error fields, then acknowledges failed rows that are still unacknowledged, so the owner JSON has `walletRequired` true and `passkeyRenewClosed` false. 401 stores no renew row and no diagnostic row. 500 stores no renew row and logs `auth.passkey.seed.fail` with `Server auth is not configured`. A missing finish body is 400 `Expected a JSON body with challengeId and credential`, logged as `auth.passkey.seed.fail` with the account id, `json` `absent`, and `bodyBytes`. Invalid JSON is 400 `Finish body is not valid JSON`, logged with the account id, `json` `invalid`, and `bodyBytes`; the text is not logged. A parsed body without `challengeId` and `credential` is the expected-body 400, logged with the account id, `json` `parsed`, `bodyKind`, and for an object `hasCredential` and `challengeIdKind`. The challenge id is logged only when it is 64 lowercase hex. Each of those 400s still stores the failed renew row. The credential is not logged. A later ceremony 400 or 409 also logs `auth.passkey.seed.fail` with the account id.
- **Errors:** 401 without a session, including a `sessionRefused` bearer (resolved before finish, not 409); 409 `{ error: 'This account already has a recovery phrase' }` when `walletRequired` is already true, the credential id is taken, the account is missing, or the insert does not land; 400 invalid body, origin, challenge, or attestation; 500 if WebAuthn is unconfigured. Invalid JSON (`Finish body is not valid JSON`) and a body without `challengeId` and `credential` log `auth.passkey.seed.fail` with the account id as well as the renew row. The text, credential, and bearer are not logged. The 500 logs that fail event and stores no renew row.
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

- **Purpose:** Bearer session JSON of given and received sats for the signed-in account (`donatedSats`, `receivedSats`, `donatedOverTime`, `receivedOverTime`, `fx`). Given is confirmed forum zaps this account paid plus all outbound house gifts when the account is platform. Received is zaps on authored notes (including hidden and replies) plus `message.sats` remainder on **top-level** notes only (so a ₿21 post cannot sit under an empty chart; gift-as-reply `sats` are not Received) plus house gifts to the Lightning handle. Series are the same `spendOverTime` day objects as `GET /gifts/stats` including additive CHF/EUR/PHP and `officialCount`. Zap rows and `message.sats` remainders are not kind `daily` or `welcome`, so they do not increment `officialCount`. Stored house gifts do, by their kind. The stored payment-time USD/CHF/EUR/PHP is what is returned. Empty activity is 200 zeros with USD-only `fx.quotes` (no Coinbase / Frankfurter). Missing CHF/EUR/PHP is JSON `null`. No invoices or payment hashes.
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

- **Purpose:** Public JSON of outbound gift totals: `totalSats` / `totalBtc` / `totalUsd` plus additive `totalChf` / `totalEur` / `totalPhp`, `giftCount`, `recipientCount`, date range, `spendOverTime` (giftCount+officialCount+sats+BTC+USD+fiat; `officialCount` is the distinct case-insensitive recipient handles that UTC day with kind `daily` or `welcome`, one person once, moderator excluded, gap days 0; `giftCount` remains every outbound row), `byRecipient`, `byMonth`, and `fx` (`quote` stays BTC-USD; `fx.quotes` lists USD always and CHF/EUR/PHP when at least one selected gift day has that cross). The stored payment-time USD/CHF/EUR/PHP is what is returned (not recomputed from that day's close). A gift day that lacks a fiat cross returns that currency as JSON `null` (totals go null if any selected gift lacks that cross). Optional query `recipient` filters to one recipient handle (the local part of the receiving address; case-insensitive). When `recipient` contains `@` after the first character, the local-part before `@` is used; otherwise the whole trimmed string. Missing/blank `recipient` = unfiltered. Unknown handle = empty stats **200** with zeros and USD-only `fx.quotes` (no Coinbase / Frankfurter). Empty boots are empty **200** with zeros and USD-only `fx.quotes` (no Coinbase / Frankfurter). No invoices.
- **Errors:** 503 `{ "error": "Gift stats are unavailable" }` when the gift store throws, when BTC-USD `ensureDays` fails, or when any selected gift day still lacks BTC-USD after ensure (`gifts.stats.fx_incomplete` / `gifts.stats.failed`). Missing CHF/EUR/PHP is never 503 (`gifts.stats.fiat_failed` still 200).
- **Used by:** App statistics page (`GET /gifts/stats` same-origin proxy); optional per-recipient view via `?recipient=`; staff payout-goal widget on `/moderate`; the habit tracker pay sheet when a session is present, for the same fiat suffix as a forum zap.
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

- **Purpose:** Spend-worker only. Query `address=local@domain`. Returns `{ hasPasskey: boolean }` so spend can filter before preflight. `address` is matched only as the wallet-backed `<username>@<host of PUBLIC_BASE_URL>` (trimmed, case-insensitive): the username is looked up and the account must have a verified wallet (`accountByReceivingAddress`). Another domain, a member without a verified wallet, or the LNURL server being off is the unknown-address answer. Fail closed: unknown address or account without a passkey credential → `hasPasskey: false` (always HTTP 200 on success; never 404).
- **Errors:** 503 if the token env is unset; 401 wrong/missing Bearer; 400 missing or invalid Lightning Address (`Not a valid Lightning Address (expected name@domain)`; an address on the configured wallet host passes even when that host has a port or is an IP address).
- **Used by:** the external spend worker before issuing a gift invoice.
- **Auth:** `Authorization: Bearer` matching `SPEND_API_TOKEN`.

## Endpoint: GET /invoices/eligible

- **Purpose:** Spend-worker only. Query `address=local@domain`. `address` is matched only as the wallet-backed `<username>@<host of PUBLIC_BASE_URL>` (trimmed, case-insensitive): the username is looked up and the account must have a verified wallet (`accountByReceivingAddress`). Another domain, a member without a verified wallet, or the LNURL server being off is the unknown-address answer. Returns `{ eligible: boolean, status }` so spend can filter before issue and pay admitted members without a roster entry (1 USD). `status` is `effectiveStatus` (`'none' | 'pending' | 'trial' | 'admitted' | 'rejected'`). Unknown address and `basis` are always `{ eligible: false, status: 'none' }` (`basis` must not leak a stored grant). Before UTC `2026-10-01` (`FUNDING_REQUIRED_FROM_UTC`), every other role is `eligible: true` without a grant (`status` still follows `effectiveStatus`). From that day, fail closed unless admitted or trial-today (always HTTP 200 on success; never 404). Expired trial is `status: 'pending'` and `eligible: false` on the gate day.
- **Errors:** 503 if the token env is unset; 401 wrong/missing Bearer; 400 missing or invalid Lightning Address (`Not a valid Lightning Address (expected name@domain)`; an address on the configured wallet host passes even when that host has a port or is an IP address).
- **Used by:** the external spend worker before issuing a gift invoice.
- **Auth:** `Authorization: Bearer` matching `SPEND_API_TOKEN`.

## Endpoint: GET /invoices/posted

- **Purpose:** Spend-worker only. Query `address=local@domain`. `address` is matched only as the wallet-backed `<username>@<host of PUBLIC_BASE_URL>` (trimmed, case-insensitive): the username is looked up and the account must have a verified wallet (`accountByReceivingAddress`). Another domain, a member without a verified wallet, or the LNURL server being off is the unknown-address answer. Returns `{ hasPosted, messageId, postedAt, hasMedia, welcomeHasMedia, welcomeMessageId }` (`messageId` newest live top-level non-profile id, or null; `postedAt` that row's `createdAt` ISO-8601, or null). `hasPosted` is still any live top-level non-profile post (no media requirement). An account that already received the welcome gift (a platform `Welcome` reply under one of its notes, live or hidden, or a recorded `welcome` gift with description `21gifts welcome` under its username at or after its wallet verification) reports `welcomeHasMedia: false` and `welcomeMessageId: null`. `hasMedia` is true only when such a post has photo 0, extra stills, or video. `welcomeHasMedia` is true when any live top-level photo or video exists, including the About-me note. `welcomeMessageId` is that newest note's id, or null. Daily `hasPosted` / `hasMedia` still exclude the About-me note. `hasPosted: false` always pairs with `messageId: null`, `postedAt: null`, and `hasMedia: false`. `hasPosted: true` can still have `messageId: null` and `postedAt: null` when `listPostsByAccount` yields no non-profile row; `hasMedia` can still be true from an older media post when the newest listed row is text-only. Fail closed: unknown address, or account with no live **top-level** forum message that is not the auto-created profile note → `hasPosted: false`, `messageId: null`, `postedAt: null`, `hasMedia: false` (`welcomeHasMedia` can still be true when About me has a photo or video) (always HTTP 200 on success; never 404). Replies do not count. Photo-only / empty-text top-level notes still count for `hasPosted`. Damus-only rows (`accountId` null) and soft-deleted rows do not.
- **Errors:** 503 if the token env is unset; 401 wrong/missing Bearer; 400 missing or invalid Lightning Address (`Not a valid Lightning Address (expected name@domain)`; an address on the configured wallet host passes even when that host has a port or is an IP address).
- **Used by:** the external spend worker before issuing a gift invoice.
- **Auth:** `Authorization: Bearer` matching `SPEND_API_TOKEN`.

## Endpoint: POST /invoices

- **Purpose:** Spend-worker only. Bearer `SPEND_API_TOKEN`. Body `{ address, amountMsat, amountUsd?, comment?, messageId?, groupMessageId? }` (`comment` max 255). Optional `amountUsd` is a positive amount with at most two decimals and at most 100000; a present value is stored as that two-decimal USD (`"5"` becomes `"5.00"`), and a bad present value is the same 400 as a bad body. An absent key stays unset. Optional `messageId` UUID; when set, that note must be that author's live top-level note, including About me, **and** have a photo or video (else 403 Forum post required; a text-only profile note stays 403); 503 `Platform account is not configured` if no isPlatform account. Omitted `messageId` stays any live top-level non-profile post (no media requirement; moderator stipend). Optional `groupMessageId` UUID, mutually exclusive with `messageId`. Display-only: stored only when it is that address's message in the closed `moderator_group` thread and an `isPlatform` account exists; otherwise the invoice is still issued and `invoice.group_message_ignored` is logged. A missing conversation store never blocks the 200. The living-room post gate still applies when `groupMessageId` is set. Requires a 21.gifts member whose wallet-backed address is `address` (`<username>@<host of PUBLIC_BASE_URL>`, case-insensitive, verified wallet; any other domain or no verified wallet is 403 Passkey required) that already has a passkey credential, is `eligibleToday` (before UTC `2026-10-01` every non-`basis` role without a grant; from that day admitted, or trial whose `trialUtcDate` is today UTC; `basis` never), When `messageId` is omitted, it also requires at least one live **top-level** forum message that is not the auto-created profile note. Replies do not unlock (`Forum post required`). Then fetches a BOLT11 for the canonical lower-case wallet address through the internal LNURL-server resolver (`lnurlServerFetch`; never over the public URL), decodes hash/amount, and stores the invoice in memory under that address.
- **Errors:** 503 if the token env is unset; 503 `{ error: 'Platform account is not configured' }` when `messageId` is set and there is no `isPlatform` account (before LNURL); 409 `{ error: 'Welcome gift already paid' }` when `comment` is `Welcome` (with or without `messageId`; not for a resolved moderator `groupMessageId`, which is recorded as `moderator`) and the account already has a platform `Welcome` reply under one of its notes or a recorded `welcome` gift with description `21gifts welcome` under its username at or after its wallet verification (after the passkey and grant checks, before LNURL; the welcome gift is once per account); 401 wrong/missing Bearer; 400 bad JSON/address (an address on the configured wallet host passes even when that host has a port or is an IP address)/amount/`comment` longer than 255, invalid `messageId` or `groupMessageId` UUID, or both `messageId` and `groupMessageId` set; 403 `{ error: 'Passkey required' }` when there is no account or the account has no passkey (before LNURL); 403 `{ error: 'Funding grant required' }` when the account has a passkey but is not `eligibleToday` (after passkey, before the living-room post check and LNURL; grant required from UTC 2026-10-01); 403 `{ error: 'Forum post required' }` when `messageId` is omitted and the account has a passkey and is eligible but no live top-level non-profile forum row, or when `messageId` is set but is not that author's live top-level note (About me included) with a photo or video (after grant, before LNURL); 502 provider did not issue a matching invoice.
- **Used by:** the external spend worker before paying via lightning.space.
- **Auth:** `Authorization: Bearer` matching `SPEND_API_TOKEN`.

## Endpoint: POST /invoices/proof

- **Purpose:** Spend-worker only. Body `{ id, preimage }`. Accepts the payment preimage as proof (`sha256(preimage)` must equal the stored payment hash). Idempotent for the same preimage. A match inserts an outbound `gift` row when `DATABASE_URL` is set (BOLT11 `pr` as `lightning_invoice`, amount floor(msat/1000) sats, fee 0, recipient handle from the address, description `21gifts moderator` when the invoice has `groupMessageId`, else `21gifts welcome` when `comment` is exactly `Welcome`, else `21gifts daily`, `kind` `moderator` when `groupMessageId` is set else `welcome` when `comment` is exactly `Welcome` else `daily` (older welcome gifts kept description `21gifts daily` and do not count for the welcome checks), `source_wallet` `lightning.space`); otherwise recording is a no-op. Insert failure logs `gifts.record_failed` and still returns 200. When `invoice.messageId` is set, inserts a platform gift-reply first, then `addSats` (idempotent). Platform gift-replies do not notify (no in-app rows, no Web Push; `messages.reply.notify.failed` is not logged on this path; the nested gift-reply still persists); when that message is already a reply (`parentId` set), persists a deterministic `spendGiftReplyId` marker under that reply, `markDeleted` so live `listReplies` omits it, then `addReceivedSats`s the reply (a live existing marker is `markDeleted` only and does not `addReceivedSats`; no `notifyForumReply`); skip and log `invoice.gift_reply.failed` if parent/platform missing; still 200. When `invoice.groupMessageId` is set, inserts one platform conversation message in that closed `moderator_group` thread (name trimmed or `21.gifts`, `sats` = floor(msat/1000), text = comment · recipient name, `giftForMessageId` set to the triggering message's id); skip and log `invoice.group_gift.failed` if the triggering row/thread/platform is missing; still 200. Repeat proof is idempotent on the deterministic stipend id.
- **Errors:** 503 unconfigured; 401 unauthorized; 400 bad body or hash mismatch on an unexpired invoice; 404 unknown id (including after unpaid sweep/restart); 409 expired without a matching preimage, or already paid with a different preimage. Matching preimage is 200 after TTL while the row remains.
- **Used by:** the external spend worker after LNDHub `payinvoice` returns a preimage.
- **Auth:** `Authorization: Bearer` matching `SPEND_API_TOKEN`.

## Endpoint: GET /lightning-address

- **Purpose:** Query `address=local@domain`. Resolves LUD-16, cached 5 minutes on success. For a member's wallet address (`<username>@<host of PUBLIC_BASE_URL>`) the returned callback is the api's own `/lnurlp/:username/invoice`, forwarded to the self-hosted LNURL server (the api sees the amount and the invoice, never pays or holds funds); for any other domain the provider's callback is returned unchanged.
- **Errors:** 400 invalid, 502 unresolved.
- **Used by:** App donate `resolveLightningAddress`.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /me

- **Purpose:** Bearer session. Current owner account JSON (id, linkingKey, role, name, `username` (`string | null` LUD-16 / NIP-05 local-part), `location` (`string | null`, never omit, never `""`), `lightningAddress` (the receiving address: the verified in-app wallet `<username>@<host of PUBLIC_BASE_URL>`, or `null`; name kept for app compatibility), `lightningAddressVerified` (true iff `lightningAddress` is set), forumLawsDismissed, `createdAt`, `rulesAgreedAt`, owner `viewKey`, `setup`, `missing`, `hasPosted`, `aboutMe`, `aboutMeHasPhoto`, `aboutMessageId`, `notificationLevel`, `amountUnit`, `locale`, `fiat`, `funding`, `walletRequired`, `walletBackupSeenAt`, `sparkPubkey` (`string | null` wallet identity key), `sparkWalletVerified` (true when `sparkPubkeyVerifiedAt` is a number), `passkeyCredentialId`, `passkeyRenewFailed`, `passkeyRenewClosed`, `passkeyRenewPrfUnsupported`). `passkeyRenewFailed` is true only when that account has a failed renew row whose `acknowledged_at` is null. `passkeyRenewClosed` is true only when `walletRequired` is not true and a failed renew row has non-null `acknowledged_at`. `passkeyRenewPrfUnsupported` is true only when the newest unacknowledged failed renew row has error name `prfUnsupported`. A later seed (`walletRequired` true) is not closed. While it is true the account still has no seed. All three are owner-only. `sparkPubkey` / `sparkWalletVerified` are owner-only (omitted from public member cards and view profiles). `hasPosted` is true when the account has a live forum row that is not the profile note (replies still count) OR when `aboutMe` is non-null. A profile note that is only the display-name copy, a photo without bio text, a missing note, and a soft-hidden note do not count. Not the same predicate as GET /invoices/posted (that stays top-level non-profile only). `aboutMe` is the profile-note text when it is a real bio, else `null` (missing or soft-hidden (`deletedAt` set); auto name-copy is not a bio). `aboutMeHasPhoto` is true when the live profile note has a stored photo. `aboutMessageId` is the live profile-note id only when `aboutMe !== null`, else `null` (never `profileMessageId` under another name). `notificationLevel` is the owner fan-out filter (`all` \| `active` \| `mentions`, default `all`, owner-only). `amountUnit` is the owner amount-entry unit (`btc` \| `fiat`, default `btc`, owner-only). `locale` is the owner UI language (`en` \| `de` \| `es` \| `fil`, nullable, null when unset, owner/debug only, omitted from public member cards and view profiles). `fiat` is the owner fiat display currency (`CHF` \| `EUR` \| `USD` \| `PHP`, nullable, null when unset, owner/debug only, omitted from public member cards and view profiles). `funding` is `null` for `basis`; otherwise always an object (`status: 'none'` when there is no row). `setup` is the next wizard step (`name` \| `username` \| `lightning-address` \| `rules`) or `null` when complete; `lightning-address` is the receiving-wallet step, done once the wallet is verified (or skipped); the api never returns `wallet`. Username is not skippable. The recovery phrase is not a setup step and does not change `setup` or `missing`. Skip timestamps count as done for name and the receiving wallet, not username. `missing` lists factually unset fields (`name`, `username`, `lightning-address` until the wallet is verified, `rules`) even when skipped, and never includes `wallet`. Does not expose `profileMessageId`. Location is not a setup step. An account with `sessionRefused` is 403 (not 401) so the client can sign the visitor out.
- **Errors:** 401 if missing/expired; 403 `{ error: 'You signed in with the wrong account. Please try again with the correct account.' }` when the bearer belongs to an account with `sessionRefused`.
- **Used by:** App `fetchMe`.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: GET /members/:accountId

- **Purpose:** Bearer required. Live member profile card for `:accountId` (UUID): `id`, `name`, `username` (`string | null` LUD-16 / NIP-05 local-part), `location` (`string | null`, never omit, never `""`), `role`, `lightningAddress`, ISO `createdAt`, `profileMessage` (`serializeMessage` with `accountId` / `replyCount` like the signed-in forum list, or `null` when no note or when the profile note is soft-hidden via `deletedAt`), derived `aboutMe` (profile-note text when it is a real bio, else `null` when the profile note is missing or soft-hidden via `deletedAt` (same as `profileMessage`); auto name-copy is not a bio; keep `profileMessage`), `aboutMeHasPhoto` (true when the live profile note has a stored photo; false when `profileMessage` is null), uncapped live `postCount` / `replyCount` from `countByAccount` (not the latest-200 window), `trust` (`accountTrust`: `verifiedBy` / `proposedBy` / `confirmedBy` / `appointedBy`, each `{ id, name }` or `null`; all-null when no stored edges), and `fundingReviewedAt` (`grant.admittedAt` when the effective grant is admitted, else `null`; does not expose pending/trial/rejected) and `fundingReviewedByName` (live display name of `decidedBy` when that time is set and the trimmed name is non-empty, else `null`). Soft-hide does **not** clear `account.profileMessageId`. Member GET keeps `profileMessage` and does not include `aboutMessageId`. Never includes `viewKey`, linkingKey, npub, nsec, or `eventId`.
- **Errors:** 401 without session; 409 `{ error: 'missing_requirements', missing: [...] }` when `requireAction(caller, 'forum.read')` fails; 404 `{ error: 'Not found' }` for a non-UUID id or unknown account; 503 `{ error: 'Messages are unavailable' }` when a store throws (`members.get.failed`).
- **Used by:** App member profile surfaces.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /members/:accountId/posts

- **Purpose:** Bearer required. Live-only top-level notes by `:accountId` newest-first, capped at 200 (`listPostsByAccount`). Same `serializeMessage` as signed-in `GET /messages` (`accountId`, `replyCount`, `payable` when a non-empty `eventId` and a receiving address (`receivingAddress`: a verified wallet with the LNURL server configured) are set). Omits `parentId`. Omits `goalSats` when unset (null/0/absent); includes the key only when a positive whole-sat goal is stored on a top-level note. Includes `goalRepayable: true` only when stored true (omitted when null, never false) and `goalTermDays` only when stored (omitted when null). Includes `goalCurrency`, `goalAmount`, and the four `goalAmount*` snapshots only when `goalCurrency` is stored (a snapshot may be null); a legacy row omits them. Replies by that member are not listed. A `hasVideo` row whose file is missing or empty is deleted and omitted. For each kept top-level note, missing-file `hasVideo` direct replies in the replies window (cap 200) are deleted (`messages.video.dropped`); `replyCount` is the live direct-reply count of attributed children (a 21.gifts author, or an external row whose `author_pubkey` is a recorded zapper in `nostr_zapper`) minus those dropped.
- **Errors:** 401 without session; 409 `{ error: 'missing_requirements', missing: [...] }` when `requireAction(caller, 'forum.read')` fails; 404 `{ error: 'Not found' }` for a non-UUID id or unknown account; 503 `{ error: 'Messages are unavailable' }` when a store throws (`members.posts.failed`).
- **Used by:** App member profile post feed.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /members/:accountId/replies

- **Purpose:** Bearer required. Live-only replies by `:accountId` newest-first, capped at 200 (`listRepliesByAccount`). `serializeMessage` with `payable` when a non-empty `eventId` and a receiving address (`receivingAddress`: a verified wallet with the LNURL server configured) are set (same as posts), `accountId`, and optional `parentId` when set; omits `replyCount`. Omits `goalSats`, `goalRepayable`, and `goalTermDays` (replies never include them). Top-level notes by that member are not listed. A `hasVideo` row whose file is missing or empty is deleted and omitted. A child that cannot serialize (invalid `createdAt`) is omitted; remaining siblings still 200 `{ messages }`.
- **Errors:** 401 without session; 409 `{ error: 'missing_requirements', missing: [...] }` when `requireAction(caller, 'forum.read')` fails; 404 `{ error: 'Not found' }` for a non-UUID id or unknown account; 503 `{ error: 'Messages are unavailable' }` when a store throws (`members.replies.failed`). Invalid `createdAt` on one child is not 503.
- **Used by:** App member profile reply feed.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /view/:viewKey

- **Purpose:** Public capability URL. Read-only ten-field profile card (`name`, `username` (`string | null` LUD-16 / NIP-05 local-part), `location` (`string | null`, never omit, never `""`), `lightningAddress`, `lightningAddressVerified`, `createdAt`, `hasPasskey`, `aboutMe`, `aboutMeHasPhoto`, `aboutMessageId`). `hasPasskey` is true when the account already has a passkey credential. `aboutMe` is the profile-note text when it is a real bio, else `null` (missing or soft-hidden (`deletedAt` set); auto name-copy is not a bio). `aboutMeHasPhoto` is true when the live profile note has a stored photo. `aboutMessageId` is the live profile-note id only when `aboutMe !== null`, else `null` (never `profileMessageId` under another name). No auth. Not a session.
- **Errors:** 404 `{ "error": "Not found" }` when the param is not 64 lowercase hex or the key is unknown. 503 `{ "error": "Messages are unavailable" }` when the profile-note read throws (`view.get.failed`).
- **Used by:** Anyone with the link (owner copies `viewKey` from GET `/me`); invite page uses `hasPasskey` for the activation banner.
- **Auth:** none.

## Endpoint: GET /messages

- **Purpose:** Signed-in list after `requireAction(account, 'forum.read')` (needs rules). With no `Authorization` header, `mode=active`, and no hashtag, the same path is the public window (see Auth) and is 200, not 401. Lists **top-level** forum notes only (`parent_id` null, `deleted_at` null) via `listFeed`. A profile note is omitted only when its trimmed text equals the display name or the name stored on the note (case-insensitive) and it has no photo, no extra stills, and no video. A profile note with other About me text stays in the feed. `GET /messages/:id`, `listLatest`, and `listPostsByAccount` are unchanged. Query: `mode` (`all` default, `active` = paid notes (`sats > 0`) plus unpaid founder/moderator notes; a top-level ask with `goalSats` > 0 and `sats = 0` is not active, `unpaid` = `sats = 0`, `popular` = paid sats-desc), `limit` (1–200, default 200), opaque `cursor` (keyset), optional `hashtag` (name without `#`; token match on `text`; combines with mode/limit/cursor). Body `{ messages }` plus `nextCursor` when `listFeed` returned `limit` rows (before missing-file video drops on listed parents). Newest-first except `popular`. Each row includes author name snapshotted at post unless stored `name` trims empty, then `truncatePubkeyDisplay(row.authorPubkey ?? '')` / `'npub'` if the pubkey is missing, `text`, ISO `createdAt`, `sats`, `payable`, `hasPhoto`, `photoCount` (0–10; `hasPhoto` still means photo 0 exists), `photoTakenAts` (always; length equals `photoCount`; null when unknown; `[]` when there are no stills), `photoTakenAt` only when `photoCount === 1`, `hasVideo`, `videoContentType`, live author `role`, and `replyCount` of live direct children that have either an account or a recorded zapper pubkey (`account_id IS NOT NULL OR (author_pubkey IS NOT NULL AND EXISTS (SELECT 1 FROM nostr_zapper WHERE pubkey = lower(author_pubkey)))`). Soft-hidden top-level notes are omitted. A `hasVideo` row whose file is missing or empty is deleted and omitted. The list path does **not** load replies or drop missing-file video children (`GET /messages/:id/replies` still does). Replies are never listed here. Clients render chronological messenger-group order (oldest top, newest bottom above the composer). Empty list is 200 `{ messages: [] }`. No photo/video bytes in JSON; live list, with or without a session, includes `accountId` whenever the stored author id is non-null and omits it for an external row, and `mentions` (`{ username, accountId }[]` only when `accountId` is included and the stored list is non-empty); a row with `accountId === null` and a recorded-zapper author pubkey carries `via: 'nostr'` and never the pubkey (same `serializeMessage` rule as `GET /messages/:id`); never includes `deletedAt` / `deletedBy`; omits `goalSats` when unset (null/0/absent) and includes the key only when a positive whole-sat goal is stored on a top-level note; includes `goalRepayable: true` only when stored true (omitted when null, never false) and `goalTermDays` only when stored (omitted when null); includes `goalCurrency`, `goalAmount`, and `goalAmountUsd` / `goalAmountChf` / `goalAmountEur` / `goalAmountPhp` only when `goalCurrency` is stored (a snapshot may be null); a legacy row omits those keys; `payable` is true when the note has a non-empty `eventId` and the author has a receiving address (`receivingAddress`: a verified wallet with the LNURL server configured); missing author → `role` `"basis"` and `payable` false. `videoContentType` is `null` when `hasVideo` is false. Each message includes `place` only when a pin is stored (same omit rule as parentId).

- **Errors:** 401 `{ error: 'Unauthorized' }` when an Authorization header is present but is not a live session, when a public cursor is outside the window, or when a signed-out request is not `mode=active` without a hashtag. A missing Authorization header on that public window is not 401. 400 `{ error: 'Invalid mode' }` / `{ error: 'Invalid limit' }` / `{ error: 'Invalid cursor' }` / `{ error: 'Invalid hashtag' }`; 409 `{ error: 'missing_requirements', missing: ['rules'] }` when rules are not agreed; 503 `{ error: 'Messages are unavailable' }` when the store throws, `serializeMessage` throws (invalid `createdAt`), or author lookup throws (`messages.list.failed`).
- **Used by:** App public comment thread.
- **Auth:** `Authorization: Bearer` session. A request with no `Authorization` header and `mode=active` and no hashtag is the public window: the first 200 active rows, paged by `limit`. Live list includes `accountId` whenever the stored author id is non-null, with or without a session, and omits it for an external row; `mentions` stay tied to that same flag. A cursor inside that window is allowed. The cursor of the 200th row is 401 when a further row exists beyond 200. A cursor whose id is gone continues at the first row strictly older than its timestamp, or is 401 when nothing in the window is older. Exactly 200 rows omit `nextCursor`. Missing mode, any other mode, or a hashtag without a session is 401. A bearer that is not a session is 401 and does not use this window. A session without `forum.read` stays 409.

## Endpoint: GET /messages/compose-target

- **Purpose:** Bearer required. After auth, `requireAction(account, 'forum.post')` (needs rules + name + username + a verified wallet (`lightning-address`); skip timestamps do not satisfy; username cannot be skipped). Returns `{ messageId, sats }` for the official platform profile note so a basis account can invoice 1 sat to 21.gifts before posting or replying. Ensures that profile note exists. A later indexed member/invoice zap on that note turns the zap comment into the payer's top-level post (`sats` 0). An external zap on that same note still inserts `insertExternalGiftReply`. The worker always includes that profile note's `event_id` in the relay query, even after the note ages out of `listLatest`. A comment `inReplyTo:<uuid>\n<body>` becomes a reply on that live top-level parent; a missing, hidden, or nested parent falls back to a top-level post with the remaining body. An empty comment does not create a blank living-room post.
- **Errors:** 401 `{ error: 'Unauthorized' }` missing/invalid/expired bearer; 409 `{ error: 'missing_requirements', missing: [...] }` when rules, name, username, and/or a verified wallet are missing (order `rules`, then `name`, then `username`, then `lightning-address`; only a verified wallet satisfies `lightning-address`); 400 `{ error: 'This message cannot be paid yet', code: 'cannot_receive' }` when the platform account has no receiving address (no verified wallet with the LNURL server configured), and the same text without `code` when the platform note has no non-empty `eventId`; 503 `{ error: 'Messages are unavailable' }` when no `isPlatform` account exists, the profile note id is missing, the row is missing or soft-hidden, or the store throws (`messages.compose_target.failed`).
- **Used by:** App forum composer (`fetchComposeTarget`) before `POST /messages/:id/invoice` on the returned `messageId`.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /messages/places

- **Purpose:** Bearer required. After auth, `requireAction(account, 'forum.read')`. Lists live top-level notes that have both coordinates (`parent_id` null, `deleted_at` null, `place_lat` and `place_lng` not null) via `listPlaces`. Query `limit` (integer 1–1000, default 1000). Body `{ places: [{ id, name, createdAt, lat, lng, label, shop, accountId? }] }`. `shop` is true when the note text contains the shop tag. `accountId` is set for a 21.gifts author and omitted for an external pin. `createdAt` is ISO-8601. Newest `createdAt` then `id` descending. `label` is a string or null. Replies and soft-hidden notes are excluded. No photo bytes.
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

## Endpoint: POST /conversations/:id/messages/:messageId/translate

- **Purpose:** Bearer required. Body `{ target: en|de|es|fil }` only. Translates stored `conversation_message.text` via `translateForumNote` and `conversation_message_translation` (not `message_translation`; the client never sends source text). A matching cache hash is `{ translatedText, cached: true }` with no DeepL call; otherwise one DeepL POST then upsert. Empty trimmed text 400. Access is `canAccess` like `GET /conversations/:id` (`moderator_group` only via `isModeratorGroupMember`; otherwise `roleAtLeast` as on GET).
- **Errors:** 401 `{ error: 'Unauthorized' }` without a session. 404 `{ error: 'Not found' }` when `:id` or `:messageId` is not a UUID, the thread is missing, `canAccess` is false (`moderator_group` only via `isModeratorGroupMember`; otherwise `roleAtLeast` like `GET /conversations/:id`), the message is missing, or `conversationId` does not match. 400 `{ error: 'Invalid body' }` for malformed JSON/target or when stored text trims empty. 200 `{ translatedText, cached }`. 503 `{ error: 'Translate is not configured' }`. 502 `{ error: 'Translate upstream failed' }`. 503 `{ error: 'Conversations are unavailable' }` on store/unexpected (`conversations.translate.failed`; no API key, no text).
- **Used by:** App conversation translate control.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /messages/:id/external-profile

- **Purpose:** Public profile for a forum author with no 21.gifts account. No Bearer. 200 `{ name, npub, postCount, replyCount }` plus optional `nip05` and `lud16`. `name` is the stored snapshot, or a truncated pubkey when that is blank; a live kind 0 name replaces it only when `externalDisplayName` accepts it. `npub` comes from the stored pubkey. `postCount` and `replyCount` are always present, including 0: `postCount` is the uncapped live top-level notes for that pubkey; `replyCount` is the uncapped live public replies, and is 0 when the pubkey is not a recorded zapper. `nip05` is included only when `fetchImpl` is set and `https://<host>/.well-known/nostr.json?name=<local>` names that pubkey after a public-address DNS check (at most two HTTPS redirects, 5s, 64 KiB). `lud16` is the published `user@host` and is not fetched. No hex pubkey, picture, about, callback, or invoice. Registered before `GET /messages/:id`. A missing querier, empty relay list, or relay failure still returns 200 with the stored name and npub.
- **Errors:** 404 `{ error: 'Not found' }` for a non-UUID id, a missing row, a deleted row (including a founder/moderator Bearer), a withheld reply, a member-authored row, or a pubkey that is not 64 hex. 503 `{ error: 'Messages are unavailable' }` when the store or account list throws (`messages.external_profile.failed`, no pubkey and no profile text). A well-known or DNS failure omits `nip05` and stays 200.
- **Used by:** App `GET /public-messages/[id]/external-profile`.
- **Auth:** Public. No staff exception for a deleted row.

## Endpoint: GET /messages/:id/external-posts

- **Purpose:** Public list of live top-level notes for the external author of `:id`. No Bearer. Same 404 gate as `GET /messages/:id/external-profile`. 200 `{ messages }` capped at 200, newest first (`createdAt` desc, `id` desc). Each item is public message JSON with `replyCount` of live attributed children, `payable` false, `via: 'nostr'`, and no `role`. Registered before `GET /messages/:id`.
- **Errors:** 404 `{ error: 'Not found' }` for a non-UUID id, a missing row, a deleted row (including a founder/moderator Bearer), a withheld reply, a member-authored row, or a pubkey that is not 64 hex. 503 `{ error: 'Messages are unavailable' }` when the store throws (`messages.external_posts.failed`, no pubkey and no profile text). A serialize failure skips that row and still returns 200.
- **Used by:** App `GET /public-messages/[id]/external-posts`.
- **Auth:** Public. No staff exception for a deleted row.

## Endpoint: GET /messages/:id/external-replies

- **Purpose:** Public list of live public replies for the external author of `:id`. No Bearer. Same 404 gate as `GET /messages/:id/external-profile`. 200 `{ messages }` capped at 200, newest first (`createdAt` desc, `id` desc). Each item includes `parentId`, omits `replyCount`, `payable` false, `via: 'nostr'`, and no `role`. A non-zapper author's reply list is empty. Registered before `GET /messages/:id`.
- **Errors:** 404 `{ error: 'Not found' }` for a non-UUID id, a missing row, a deleted row (including a founder/moderator Bearer), a withheld reply, a member-authored row, or a pubkey that is not 64 hex. 503 `{ error: 'Messages are unavailable' }` when the store throws (`messages.external_replies.failed`, no pubkey and no profile text). A serialize failure skips that row and still returns 200.
- **Used by:** App `GET /public-messages/[id]/external-replies`.
- **Auth:** Public. No staff exception for a deleted row.

## Endpoint: GET /messages/:id

- **Purpose:** Public single-note fetch (no Bearer for a live row). Returns the public message JSON via `serializeMessage` (`sats` (the amount sent with a reply; the collected zap total on a top-level note), `receivedSats` / `receivedAmountUsd` / `receivedAmountChf` / `receivedAmountEur` / `receivedAmountPhp` on a reply (0 / null when none; omitted on a top-level note so older clients keep parsing notes), optional `goalSats` on a top-level note when the stored ask is a positive integer, optional `goalRepayable: true` only when stored true (omitted when null, never false, omitted on a reply), optional `goalTermDays` only when stored (omitted when null, omitted on a reply), optional `place` when a pin is stored and omitted when unset, optional `shopAccount` (`{ id, username, name }`) when a shop account is stored and omitted when unset, `payable`, `hasPhoto`, `photoCount` (0–10; `hasPhoto` still means photo 0 exists), `photoTakenAts` (always; length equals `photoCount`; null when unknown; `[]` when there are no stills), `photoTakenAt` only when `photoCount === 1`, `hasVideo`, `videoContentType`; live `role` for 21gifts authors; `payable` is true when a non-empty `eventId` and an author with a receiving address (`receivingAddress`: a verified wallet with the LNURL server configured) are set (top-level or signed reply); an external Nostr-authored row with `accountId` null and a recorded `authorPubkey` omits `role`, sets `payable` false, and includes `via: 'nostr'`). A live reply with `accountId` null is 200 only when `authorPubkey` is set AND recorded as a zapper (checked via `isZapperPubkey`, including on every `sinceSats` poll iteration); otherwise — no `authorPubkey`, or one not yet a recorded zapper — it is 404 `{ "error": "Not found" }` (same body as missing/hidden). Live GET omits `deletedAt` / `deletedBy`. Live single-note GET includes `accountId` whenever the stored author id is non-null, with or without a session, and omits it for an external row; `mentions` stay tied to that same flag. Omits `goalSats` when unset (null/0/absent); includes the key only when a positive whole-sat goal is stored on a top-level note. Includes `goalRepayable: true` only when stored true (omitted when null, never false) and `goalTermDays` only when stored (omitted when null). Includes `goalCurrency`, `goalAmount`, and `goalAmountUsd` / `goalAmountChf` / `goalAmountEur` / `goalAmountPhp` only when `goalCurrency` is stored (a snapshot may be null); a legacy row omits those keys. Photo/video bytes are never included. Unsigned visitors and non-staff still 404 `{ error: 'Not found' }` for soft-hidden rows (`deletedAt` set) before any missing-video cleanup (same body as today; no `deletedAt` in the 404 body). A founder or moderator Bearer (`roleAtLeast(..., 'moderator')`, no `forum.read`) is 200 public JSON plus `deletedAt` ISO, `deletedBy.{id,name,role}`, `payable: false`, and `accountId` for 21gifts authors; skip missing-video drop; do not long-poll `sinceSats` or `sinceReceivedSats` on hidden rows. A live `hasVideo` row whose file is missing or empty is deleted (`messages.video.dropped`) and then 404. Optional query `sinceSats` (non-negative integer) long-polls until `sats` is strictly greater than that value (pay sheet / Lightning zap confirmation). Optional query `sinceReceivedSats` (non-negative integer) long-polls a live reply until `receivedSats` is strictly greater; a top-level note ignores it. Timeout still returns 200 with the current body. A top-level note (parent id null), whether the live public body or the founder/moderator hidden body, includes `replyCount` of live direct children with an account or a recorded zapper pubkey; a reply omits `replyCount`.
- **Errors:** 400 `{ error: 'Expected sinceSats to be a non-negative integer' }` when `sinceSats` is present but not a non-negative integer string; 400 `{ error: 'Expected sinceReceivedSats to be a non-negative integer' }` when `sinceReceivedSats` is present but not a non-negative integer string; 404 `{ error: 'Not found' }` when `:id` is not a UUID, the row is missing, a live reply has no account and either no author pubkey or an author pubkey that is not a recorded zapper, a missing-file video row was dropped, or a soft-hidden row is requested without a founder/moderator Bearer; 503 `{ error: 'Messages are unavailable' }` when the store throws, `serializeMessage` throws (invalid `createdAt`), or author lookup throws (`messages.get.failed`). Timeout with unchanged sats remains 200.
- **Used by:** App deep links / share URLs for one forum note; pay sheet / Lightning zap confirmation via `?sinceSats=` or `?sinceReceivedSats=`.
- **Auth:** none for live public GET; founder/moderator Bearer for a hidden permalink.

## Endpoint: GET /messages/:id/replies

- **Purpose:** Bearer optional. Lists direct live replies that have either an account or a recorded zapper pubkey (`account_id IS NOT NULL OR (author_pubkey IS NOT NULL AND EXISTS (SELECT 1 FROM nostr_zapper WHERE pubkey = lower(author_pubkey)))`) for parent `:id` oldest-first (`createdAt` then `id` ASC), capped at 200. Soft-hidden children and rows with no account and either no author pubkey or a not-yet-recorded-zapper author pubkey are omitted for unsigned/non-staff. A hidden or missing parent is 404 for unsigned/non-staff (same body as today). A founder or moderator Bearer (`roleAtLeast(..., 'moderator')`, no `forum.read`) is 200 `{ messages }` from `listReplies(id, MESSAGE_LIST_LIMIT, true)` including hidden attributed children with hide stamps (`deletedAt` ISO, `deletedBy.{id,name,role}`) and `payable: false`, whether the parent is live or hidden. Live children stay live serialize. A `hasVideo` reply whose file is missing or empty is deleted (`messages.video.dropped`) and omitted from `{ messages }` (live children). A child that cannot serialize or whose author lookup throws is omitted; remaining siblings still 200 `{ messages }`. Body is `{ messages: [...] }` (same key as `GET /messages`, not `replies`). Each live item is public message JSON with `payable` true when the child has a non-empty `eventId` and the author has a receiving address (`receivingAddress`: a verified wallet with the LNURL server configured); external Nostr-authored items instead have `payable` false, omit `role`, and include `via: 'nostr'`; live replies include `accountId` whenever the stored author id is non-null, with or without a session, and omit it for an external row; `mentions` stay tied to that same flag; live JSON never includes `authorPubkey`, `deletedAt`, or `deletedBy`; omits `goalSats`, `goalRepayable`, and `goalTermDays` (replies never include them).
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

- **Purpose:** Bearer required. After auth, `requireAction(account, 'forum.post')` (needs rules + name + username + a verified wallet (`lightning-address`); skip timestamps do not satisfy; username cannot be skipped). JSON `{ text?, photo?: { contentType, data, takenAt? }, photos?: { contentType, data, takenAt? }[], inReplyTo?, goalSats?, goalCurrency?, goalAmount?, goalRepayable?, goalTermDays? }` (`takenAt` is optional `YYYY-MM-DDTHH:MM:SS` with an optional `±HH:MM` offset, a real calendar date, and a year from 1990 through the current UTC year + 1; `Z`, a fractional second, a leap second, a non-string, or a missing value is stored null and does not 400) (`photos` max 10; non-empty `photos` wins over singular `photo`; dual-send uses `photos`) (base64 JPEG/PNG/WebP ≤ 1 MiB) or `multipart/form-data` with `text`, `video` (MP4/WebM/MOV ≤ 32 MiB), optional JPEG/PNG/WebP `poster`, and optional `goalSats` (string form field) or both `goalCurrency` and `goalAmount` (JSON accepts that same pair: both or neither, not mixed with `goalSats`, not half a pair), plus optional `goalRepayable` (multipart `"true"`; an empty field is absent) and optional `goalTermDays` (multipart digits from 1 to 3650; an empty field is absent). A currency ask freezes `goal_sats` plus `goal_currency`, `goal_amount`, and four `goal_fiat_*` snapshots from the latest gift-day with sats > 0 (same path as `GET /gifts/stats`). Legacy `goalSats` leaves those columns null. JSON omits the new keys when `goalCurrency` is null. Progress fiat is the sum of per-payment snapshots; a null delta does not wipe a stored total. One-time/Daily is not stored. Optional `goalSats` is a whole-sat ask on a top-level note (JSON number; multipart string). Omitted, JSON `null`, or a multipart empty/missing field means no goal. Max 10_000_000; above max is rejected, not clamped. 200 JSON may include `goalSats` or omit the key. Optional `inReplyTo` is a **top-level** parent message UUID (sets `parentId` for a one-level NIP-10 reply; JSON only). Text-only stays valid; photo-only (singular or `photos`) or video-only allowed; at least one of non-empty trimmed text, photo, non-empty `photos`, or video required. Name snapshot. 200 is the public message including `sats`, `payable`, `hasPhoto`, `photoCount` (0–10), `photoTakenAts` (always; length equals `photoCount`; null when unknown; `[]` when there are no stills), `photoTakenAt` only when `photoCount === 1`, `hasVideo`, `videoContentType`, the session account's live `role`, and `accountId` (not wrapped; never `contentFp`). Identical live photo/video from the same account+parent (same normalised text + same media bytes) and the same pin returns the existing row (200, same id) without consuming the 1/10s burst limiter and without a second push; the same media with a different pin is 409 `{ error: 'A live note with this media already exists' }`; text-only is unchanged (new row + burst). New notes have `sats` 0 and `payable` false until signed (and stay `payable` false without an author receiving address). Top-level creates call `notifyForumPost` (kind `forum_post`, tag `forum_post:<id>`, url `/messages/<id>`) for every account except the actor and except each account marked on the created row (no-op when the actor is the official platform account), then filtered by each account's `notificationLevel` (Web Push still only to bell subscribers, same filter). The excluded ids are the created row's mention account ids other than the author, deduped; an empty list omits `excludeAccountIds`. After a new top-level persist, a note with `#21GiftsShop` and a pin is sent with PUT to `/map/places` when `mapPush` is set, with techProvider `21.gifts`. A replay does not call. Boot sets `mapPush` when `SHOP_PLACE_PUSH_ENABLED` is true and both values are non-blank. A blank URL or token also keeps the forum pin, and a failed PUT logs `ocp.place.failed` and still returns 200. A replace is not this path. After a new top-level persist, the api calls `spendPing.ping(address, messageId, 'daily', effectiveStatus(grant, now))` only when `eligibleToday` and the new row has media (`hasPhoto` / `hasVideo` / `photoCount > 0`) (`address` is the author's wallet-backed receiving address; no verified wallet → no ping; fire-and-await, errors logged, still 200; ineligible logs `spend.ping.skipped` / `not_eligible`; eligible text-only logs `spend.ping.skipped` / `no_media`). When `role === 'verified'` and any live top-level photo or video exists, including the About-me note, the route also calls `spendPing.ping(address, messageId, 'welcome')` for that note, independent of `eligibleToday` (the new row need not itself have media; the welcome gift is once per account: an account with a platform `Welcome` reply under one of its notes, or a `welcome` gift with description `21gifts welcome` recorded under its username at or after its wallet verification, is not pinged and logs `spend.ping.skipped` / `welcomed`). Replies, and any role other than `verified`, do not welcome-ping. Replies do not ping. A reply calls `notifyForumReply` (kind `forum_reply`, tag `forum_reply:<replyId>`, url `/messages/<replyId>`) for every account except the actor and except each account marked on the created row (no-op when the actor is the official platform account), then filtered by each account's `notificationLevel` — Damus-only parents still fan out; a self-reply skips only the actor. The same mark-id exclusion applies. Those marked accounts still receive one `forum_mention` from `notifyForumMentions`. The booted process always has those stores (in-memory without `DATABASE_URL`, Postgres when it is set). Photo-only empty text still notifies; missing `pushStore` still writes in-app rows; notification or push failure still returns 200. It does not copy into the member↔member inbox. Unpaid text-only posts and replies from anyone below `verified` (including the parent author) are 403 (`A post needs a Bitcoin payment` / `A reply needs a Bitcoin payment`); photo or video posts and replies from basis are allowed; pay 1 sat to 21.gifts via `GET /messages/compose-target` then `POST /messages/:id/invoice` on the platform profile note. `verified` stays unpaid-write exempt. Optional JSON `place` `{ lat, lng, label? }` and multipart fields `placeLat`, `placeLng`, `placeLabel`. Omitted place stores nothing and the 200 JSON omits `place`. Invalid place is 400 with the normalizePlace error. A reply with a non-null place is 400 `A reply cannot include a place`. Multipart with exactly one of placeLat/placeLng is 400 `Place must be a latitude and longitude`. Optional `shopUsername` (JSON string or multipart field) assigns a 21.gifts account on a new top-level shop note (`#21GiftsShop`). Omitted, null, blank, or only `@` stores no shop account. A non-string is 400 `Username is not valid`. A reply or a note that is not a shop is 400 `Only a shop note can set a shop account` when the handle is non-blank, before the handle is normalised. A handle `normalizeUsername` rejects is then 400 `Username is not valid`. Unknown username, or a stored username that is missing or blank, is 404 `No account with that username` before the row is created. The account id is stored on the same insert as the note, and the 200 JSON includes `shopAccount`; that first assignment does not write `message_edit`. A media replay of an existing live note does not change its shop account. Any account that can post the shop may set it. Later changes stay on staff `PATCH /messages/:id/shop-account`.
- **Errors:** 401 Unauthorized; 409 `{ error: 'missing_requirements', missing: [...] }` when rules, name, username, and/or a verified wallet are missing (order `rules`, then `name`, then `username`, then `lightning-address`; only a verified wallet satisfies `lightning-address`); 400 Expected a JSON body with text and/or photo (including JSON `goalSats` type/range errors); 400 Text must be 1–8000 characters; 400 Text must be 1–8000 characters or include a photo; 400 Text must be 1–8000 characters or include a photo or video; 400 Photo must be a JPEG, PNG, or WebP under 1 MiB; 400 `{ error: 'At most 10 photos' }` when `photos.length > 10`; 400 Poster must be a JPEG, PNG, or WebP under 1 MiB; 400 Video must be an MP4, WebM, or MOV under 32 MiB; 400 `{ error: 'A reply cannot ask for a goal' }` when `inReplyTo` is set and the body sends `goalSats`, `goalCurrency`, `goalAmount`, `goalRepayable`, or `goalTermDays`; 400 `{ error: 'Ask obligation must be true' }` when `goalRepayable` is present and not JSON `true` or multipart `"true"` (JSON `""` is rejected; a multipart empty field is absent); 400 `{ error: 'A repayment obligation needs an ask' }` when `goalRepayable` is true without an ask; 400 `{ error: 'Ask term must be a whole number of days from 1 to 3650' }` when `goalTermDays` is present and outside that range; 400 `{ error: 'A repayment term needs a repayable ask' }` when a term is sent without `goalRepayable: true`; 400 `{ error: 'A repayable ask needs a term in days' }` when `goalRepayable` is true and the term is absent; JSON includes `goalRepayable` only when true (never false) and `goalTermDays` only when set; 400 `{ error: 'Goal must be a positive whole-sat amount' }` when a multipart `goalSats` is present and not `/^\d+$/` or not an integer 1..10_000_000, and when a BTC `goalAmount` is not an integer 1..10_000_000; 400 `{ error: 'Send either goalSats or both goalCurrency and goalAmount' }` when both styles or only one of the new pair is sent, or `goalAmount` is not a canonical decimal string; 400 `{ error: 'Ask amount is unavailable' }` when a fiat ask has no usable gift-day quote or the frozen sats fall outside 1..10_000_000; 503 `{ error: 'Messages are unavailable' }` when the gift-day loader throws for a fiat ask (a BTC ask still stores the typed sats); 404 `{ error: 'Not found' }` when `inReplyTo` is present but not a UUID, the parent is missing, soft-hidden (`deletedAt` set), or the parent is itself a reply (`parentId !== null`); 403 `{ error: 'A post needs a Bitcoin payment' }` or `{ error: 'A reply needs a Bitcoin payment' }` when the caller is below `verified` (including the parent author) and the body is text-only; photo or video posts and replies from basis are 200; pay 1 sat to 21.gifts via `GET /messages/compose-target` then `POST /messages/:id/invoice` on that note; 429 Too many messages (`Retry-After: 10`); 503 Messages are unavailable (`messages.create.failed`). 409 `{ error: 'A live note with this media already exists' }` when the same account, parent, and live media fingerprint already exists with a different pin. 400 `{ error: 'Place must be a latitude and longitude' }` when JSON `place` is invalid or multipart has exactly one of placeLat/placeLng; 400 `{ error: 'Place label must be at most 80 characters' }` when the label fails normalizePlace; 400 `{ error: 'A reply cannot include a place' }` when `inReplyTo` is set and place is non-null. 400 `{ error: 'Username is not valid' }` when `shopUsername` is not a usable handle; 404 `{ error: 'No account with that username' }` when that handle matches no account or the stored username is missing or blank; 400 `{ error: 'Only a shop note can set a shop account' }` when a non-blank `shopUsername` is sent on a reply or a note without `#21GiftsShop`. 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names an IANA zone that is Sunday on the server clock (a missing, blank, or invalid zone does not refuse). Pay links, the till, contact, and ordinary private threads are not this error.- **Used by:** App forum composer and reply composer.
- **Auth:** `Authorization: Bearer` session.
- **Marks:** `POST /messages` resolves `@username` at send time (longest username-character run, not an address like `name@21.gifts`) to the account that owns that username then, stores `{ accountId, username }` on the row, and notifies that person once with kind `forum_mention` (not the author; the same person twice is one row). That mark is the only in-app row and the only push that account gets for this note. A later rename does not move the mark. About me, the contact form, and inbound Nostr notes are not parsed. `POST /conversations/:id` (inbox and the moderator room) and a paid inbox gift store the same `{ accountId, username }` marks and do not notify that person. Live JSON includes `mentions` only when `accountId` is included and the list is non-empty. Push body is `{name} marked you` in the recipient locale (`de` `{name} hat dich markiert`, `es` `{name} te marcó`, `fil` `Minarkahan ka ni {name}`).

## Endpoint: GET /messages/:id/repayment

- **Purpose:** Public read of a live repayable ask. No session. 404 unless the note is a live top-level credit with a term. 200 lists `givers` (account, name, username, `givenSats`, and `givenAmount` in the goal currency or null for bitcoin) and `repayments`. Each repayment is one bitcoin payment: `dayIndex`, `dueOn` (`YYYY-MM-DD` UTC, or null until the credit is fully given), who receives it, `amount` (a two-decimal currency string such as `0.01`, or null for bitcoin), `sats` (the bitcoin share, or for fiat the sats of a paid share and null until it is paid), `status` `paid` | `due` | `scheduled`, and `via: lightning`. A 1-sat or 1-cent gift is a row of its own. `unassignedSats` is bitcoin with no 21.gifts payer and is not in the plan. `next` is the next unpaid share once the credit has filled, else null. 503 `{ error: 'Ask amount is unavailable' }` when a fiat amount or the gift-day rate is missing.
- **Errors:** 404 Not found. 503 Ask amount is unavailable.
- **Auth:** none. A local Sunday does not refuse this read.
- **Used by:** Anyone opening the credit.

## Endpoint: POST /messages/:id/repayment

- **Purpose:** Same author session. A missing or invalid Bearer is 401, including when the id is not a UUID. After a valid session, 404 covers a non-UUID id, a missing note, a note that is not a live repayable ask, a credit that is not funded yet, and a caller who is not the author. GET of that same unfunded credit stays 200. Issues `{ pr, amountSats, sparkInvoice }` for the next giver share. A later request for that same unpaid share returns the outstanding invoice instead of minting another, including when the sat price of that fiat share has moved, but only while it was minted for the giver's current wallet address; while an open invoice minted for another address is still payable the answer is 409 `{ error: 'A payment for this share is still open' }`, and after it expires a new one is minted. The author pays that invoice from their own wallet. The zap tags the credit note. When indexed, the share is stored on `message_repayment` and the ask total does not rise. Gifts that arrive after the credit has filled do not change the plan. 409 `missing_requirements` without forum pay. 403 `{ error: 'SUNDAY_REST' }` when the device `Time-Zone` is in Sunday. 429 when rate limited. 400 `Nothing is due`, `This message cannot be paid yet`, `A giver has no Lightning address`, or when the wallet cannot take a zap. 503 `{ error: 'Ask amount is unavailable' }` when the fiat share cannot be priced, and 503 `{ error: 'Messages are unavailable' }` when signing keys are missing or storing the invoice attempt fails. The giver's address comes from `receivingAddress`: with a verified wallet and the LNURL server configured it is the wallet-backed `<username>@<host of PUBLIC_BASE_URL>`, resolved against the LNURL server internally (`lnurlServerFetch`). Without a verified wallet there is no address. The response also carries `sparkInvoice`: a `spark1…` Spark invoice for the same amount to the giver's verified wallet with memo `zap:<payment hash of pr>` when free in-app payments are on (`LNURL_SERVER_URL`, `PUBLIC_BASE_URL`, `LNURL_ZAP_NSEC_HEX`) and the giver is wallet-backed, else `null`. The app pays it from its wallet and waits on the existing long-poll; the Spark invoice worker turns the settled transfer into a zap receipt for `pr`. A returned outstanding invoice carries the same Spark invoice (issued on demand when missing).
- **Errors:** 401 Unauthorized, including a non-UUID id with no session; 404 Not found after a valid session when the id is not a UUID, the note is not a live funded repayable ask, or the caller is not the author (GET of an unfunded credit stays 200); 400 as in the purpose (`{ error: 'A giver has no Lightning address', code: 'cannot_receive' }` when a giver has no receiving address, the same text without `code` when a giver has no Nostr key, and `{ error: "The recipient's wallet cannot receive this Bitcoin payment", code: 'cannot_receive' }` when the giver's wallet refuses the zap, and `{ error: 'Could not start the Bitcoin payment' }` for any other LNURL failure, e.g. an unreachable wallet); 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names a Sunday (a missing, blank, or invalid zone does not refuse; GET stays open); 409 `{ error: 'missing_requirements', missing }` or `{ error: 'A payment for this share is still open' }` (an open invoice for this share was minted for another address); 429 Too many payments; 503 `{ error: 'Ask amount is unavailable' }` or `{ error: 'Messages are unavailable' }`.
- **Auth:** `Authorization: Bearer` session.
- **Used by:** The author of the credit, from their own wallet.

## Endpoint: POST /messages/:id/invoice

- **Purpose:** Bearer required. After auth, `requireAction(payer, 'forum.pay')` (payer needs rules only — never 409 `lightning-address` for the payer). `:id` is a UUID (top-level or a reply — `parentId` is not a mint gate). Body `{ sats, text?, amountUsd?, amountChf?, amountEur?, amountPhp? }` (`sats` integer 1..10_000_000; optional `text` is the NIP-57 comment, same 1–8000 forum rules; omit/whitespace = gift-only; omitting every amount key leaves the invoice unpinned; any present amount key pins all four and a missing sibling is null; `"0"`, `"0.0"`, and `"0.00"` are stored as `"0.00"`; an unusable amount string is the same 400 as a bad sats body). Builds a NIP-57 kind:9734 zap request for the note (content = normalised text), signs it with the payer's custodial key (ensuring one exists when KEK is present), and returns `{ pr, amountSats, sparkInvoice }` only when the minted BOLT11 is a NIP-57 `description_hash` invoice (`isNip57Invoice`); otherwise persists `not_zap` (with rejected `pr` for debug) and responds 400 `The author's wallet cannot receive this Bitcoin payment` without `pr` in the body. Same author's-wallet 400 for LNURL `noZap`; other LNURL transport failures (`unreachable`) keep `Could not start the Bitcoin payment`. Mint gate is a non-empty signed `eventId` plus an author with a receiving address (`receivingAddress`: a verified wallet with the LNURL server configured); null or empty `eventId` / no author receiving address stay 400 `This message cannot be paid yet` and do not call LNURL (resource state, not payer `missing`). Damus-only notes (`accountId` null) stay 400 `The author's wallet cannot receive this Bitcoin payment` and persist `no_author`. Soft-hidden notes are treated as missing (`not_found` persist + 404). After auth, valid-UUID attempts are persisted best-effort (`message_invoice`); persist failures do not change the HTTP response. The invoice rate limit is applied only after auth, amount, payable, and KEK checks (NIP-57 reject still counts, same as other LNURL failures). Indexed kind:9735 credits the paid row (`:id` that was minted, which may be a reply) — not always the top-level parent. On a **member note**, the worker then calls `notifyZap` best-effort (in-app rows for every account except the resolved payer (no-op when the payer is the official platform account), then filtered by each account's `notificationLevel`; Web Push only to bell subscribers, same filter; enqueue failure logs `push.enqueue.failed`) and inserts a payer gift-reply (`sats` = this zap, gift-only `nostrPublishState` `skipped`) only when that paid row is top-level (`parentId` null). A zap on the official platform profile note (`GET /messages/compose-target`) is a compose fee: skip `notifyZap`; the comment becomes the payer's post or `inReplyTo:` reply with `sats` 0, then `notifyForumPost` / `notifyForumReply` plus a top-level `spendPing` only when `eligibleToday` (same gate as `POST /messages`; ineligible logs `spend.ping.skipped` / `not_eligible`). A zap on a reply is `addSats` only (no nested gift-reply). A member-note gift-reply does not call `notifyForumReply`. The recipient's address comes from `receivingAddress`: with a verified wallet and the LNURL server configured it is the wallet-backed `<username>@<host of PUBLIC_BASE_URL>`, resolved against the LNURL server internally (`lnurlServerFetch`). Without a verified wallet there is no address. The response also carries `sparkInvoice`: a `spark1…` Spark invoice for the same amount to the recipient's verified wallet with memo `zap:<payment hash of pr>` when free in-app payments are on (`LNURL_SERVER_URL`, `PUBLIC_BASE_URL`, `LNURL_ZAP_NSEC_HEX`) and the recipient is wallet-backed, else `null`. The app pays it from its wallet and waits on the existing long-poll; the Spark invoice worker turns the settled transfer into a zap receipt for `pr`.
- **Errors:** 401 Unauthorized; 409 `{ error: 'missing_requirements', missing: ['rules'] }` when the payer has not agreed to rules; 400 bad body / Text must be 1–8000 characters / This message cannot be paid yet (with `code: 'cannot_receive'` when the author has no receiving address; without `code` for an unsigned note or a missing recipient key) / The author's wallet cannot receive this Bitcoin payment with `code: 'cannot_receive'` (`noZap`, `not_zap`, or a note without a member author) / Could not start the Bitcoin payment (`unreachable` and other LNURL transport failures); 404 Not found (unknown id, soft-hidden id, or non-UUID `:id`, the latter without a persist row); 429 Too many payments (`Retry-After: 10`, after payable checks); 503 Messages are unavailable (missing KEK before limiter, or keygen/sign failure after). 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names an IANA zone that is Sunday on the server clock (a missing, blank, or invalid zone does not refuse). A conversation invoice, a pay link, and the till are not this error.
- **Used by:** App pay sheet and paid reply composer for forum notes.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /pos

- **Purpose:** Bearer required. Returns the signed-in member's open point-of-sale charge, or `charge: null`, plus up to 20 newest rows of any status. A pending row whose `expiresAt` is not in the future is marked `expired` before the response and is not `charge`. Amounts are whole sats. There is no paid status: the member's verified in-app wallet settles the invoice and this API does not observe settlement. TTL is five minutes (`POS_CHARGE_TTL_MS`).
- **Errors:** 401 Unauthorized.
- **Used by:** App `/pos` page.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /pos

- **Purpose:** Bearer required. Body `{ amountSats }` integer ≥ 1. Requires a username and a receiving address (`receivingAddress`: the verified wallet, resolved internally against the LNURL server). Resolves that address and rejects amounts whose millisats (`amountSats * 1000`) fall outside inclusive `minSendable`..`maxSendable`. One unexpired pending charge at a time. The insert enforces that again (`pos_charge_account_pending_idx`, and the in-memory store rejects before append), so a second request that already passed the earlier read is still 409. 201 `{ charge }` with `expiresAt` five minutes after `now`. While pending, `GET /.well-known/lnurlp/:username` sets both sendable bounds of the wallet pay request to that millisat amount. Callback and metadata stay unchanged.
- **Errors:** 401 Unauthorized; 400 Expected a JSON body with an integer "amountSats"; 400 Set a username first; 400 `{ error: 'Set up your wallet first', code: 'wallet_required' }` (no verified wallet); 400 Amount is outside the wallet range; 409 A payment is already open; 502 Lightning Address could not be resolved.
- **Used by:** App `/pos` amount form.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: DELETE /pos

- **Purpose:** Bearer required. Cancels every unexpired pending charge for the account, not only the newest. 200 `{ charge: null }` when at least one row was cancelled. An already expired row is not cancelled.
- **Errors:** 401 Unauthorized; 404 No open payment.
- **Used by:** App `/pos` cancel control.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /contact

- **Purpose:** Bearer required. After auth, `requireAction(account, 'contact.post')` (needs rules + name + username). Body `{ text }`. Private mailbox to 21.gifts — never listed publicly. Name snapshot as forum messages; text uses `normalizeForumText` then still requires 1–8000 characters (forum photo-only empty text does not apply). After the platform account exists, persists the contact row first, then opens/appends the member→platform conversation thread so the message is readable via `GET /conversations`. A successful append enqueues a conversation Web Push to bell-subscribed counterparts (`notifyConversationMessage`; failure logs `conversations.push.failed`). Conversation append failure logs `conversations.contact_sync.failed` and still returns 200 (contact is the product surface). 200 is the public contact object (no `accountId`).
- **Errors:** 401 Unauthorized; 409 `{ error: 'missing_requirements', missing: [...] }` when rules, name, and/or username are missing; 400 Expected a JSON body with a "text" string; 400 Text must be 1–8000 characters; 503 `{ error: 'Platform account is not configured' }` when no `isPlatform` account exists (neither contact nor thread is written); 503 Contact is unavailable (`contact.create.failed`).
- **Used by:** App in-app contact composer.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /conversations

- **Purpose:** Bearer required. Lists threads the session may see: own member threads plus, when the role is at least moderator, all platform threads. A thread is listed when it has an inbound message for the viewer, or when its latest message is from the viewer (a member or Damus chat the viewer started, before anyone replies). Empty threads stay omitted. The member's own `member_platform` contact thread stays listed when it has a message. One-sided rows are `unread: false`. Inbound = not `conversationFromMe`; Damus null sender is inbound. This list never includes `kind: 'moderator_group'` (the closed group is `GET /conversations/moderator-group`). `GET /conversations/:id` and `POST` are unchanged for outbound-only and empty threads. Newest last-message first (cap 200). Public JSON is `{ conversations: [{ id, kind, name, lastText, lastMessageId, lastAt, lastFromMe, lastSats, amountUsd, amountChf, amountEur, amountPhp, unread, unreadMessageCount, accountId? }], unreadCount }` — `lastMessageId` is the id of that same newest row (`created_at DESC, id DESC`), else `null`, always present, and is not translated on the list — the four amounts are always present (string or null; the last message's stored payment-time fiat) — optional counterpart 21.gifts `accountId` (omitted for Damus-only counterparts); no event ids or npubs (Damus-only `name` may be a truncated npub). `lastFromMe` is true when the last message's actor (else sender) is the viewer; Damus inbound (`senderAccountId` null) is false. No staff-as-platform shortcut. `lastSats` is the last message's sats (0 for unpaid text). Per-row `unreadMessageCount` is inbound messages strictly after last-read (`0` when none); `unread` is `unreadMessageCount > 0`. Envelope `unreadCount` is the number of listed rows with `unread: true` (still a thread count). The menu/PWA badge matches that number because a row kept only because its latest message is from the viewer is `unread: false`. List GET does not stamp last-read. `DEBUG_TOKEN` cannot read this inbox.
- **Errors:** 401 Unauthorized; 503 `{ error: 'Conversations are unavailable' }` (`conversations.list.failed`).
- **Used by:** App conversation list.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /conversations/:id/read

- **Purpose:** Bearer required. UUID `:id`. After `getById` + `canAccess`, `markRead(id, account.id, new Date(deps.now()))`. 200 `{ ok: true }`. Does not copy DMs into Notifications. `GET /conversations/:id` does not mark read. Registered before `POST /conversations/:id`. `DEBUG_TOKEN` cannot use this.
- **Errors:** 401 Unauthorized; 404 `{ error: 'Not found' }` (unknown / other-account / non-uuid); 503 `{ error: 'Conversations are unavailable' }` (`conversations.read.failed`). 403 `{ error: 'SUNDAY_REST' }` only when the loaded thread kind is `moderator_group` and `Time-Zone` names an IANA zone that is Sunday (a missing, blank, or invalid zone does not refuse; an ordinary private thread is not refused).
- **Used by:** App mark-conversation-read control.

## Endpoint: GET /conversations/moderator-group

- **Purpose:** Bearer required. Closed moderator-group tool, not the member inbox. At least moderator (`isModeratorGroupMember`: `roleAtLeast` `moderator` and not the platform account): `ensureModeratorGroup` then `{ conversation }` via `publicThread` (`kind: 'moderator_group'`, name `Moderators`, `unread` / `unreadMessageCount` from `countUnread`). Verified, basis and the platform account → 404 `{ error: 'Not found' }` (same as `canAccess`, no existence leak). Missing platform or store failure → 503 (`conversations.moderator_group.failed`). Unauthenticated 401. Registered before `GET /:id`.
- **Errors:** 401 Unauthorized; 404 Not found; 503 `{ error: 'Conversations are unavailable' }` (`conversations.moderator_group.failed`). 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names an IANA zone that is Sunday on the server clock (a missing, blank, or invalid zone does not refuse). Ordinary private threads, pay links, the till, and contact are not this error.
- **Used by:** App moderator-group tool.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /notifications

- **Purpose:** Bearer required. List `{ notifications, unreadCount }`. Scan the newest 1000 stored rows. If a `forum_mention` in that scan has `replyId` R, drop every `forum_post` and `forum_reply` in that scan with the same `replyId` before the level filter and before the hidden-message filter (do not drop `zap`, `forum_mention`, `moderator_appointed`, or `moderator_proposal` in this duplicate drop). Then best-effort `deleteForRecipient` of those dropped notification ids (`notifications.duplicate.purged`; a throw logs `notifications.duplicate.purge_failed` and the list is still 200). Then apply the owner's `notificationLevel` filter (`notificationsMatchingLevel` on the rows that remain), then drop rows whose parent **message** is missing or `deletedAt !== null` (`forum_post` / `zap` / `forum_reply` / `forum_mention`); `forum_reply` also drops when the child `replyId` message is missing or hidden. A `zap` `replyId` is a receipt-derived UUID, not a message id — it is not looked up and is never added to the purge set. Then cap the kept list at 200 newest-first. Then best-effort `deleteByMessageIds` of those **message** ids (`notifications.hidden.purged`; throw logs `notifications.hidden.purge_failed` and is not 503). Never drops `moderator_appointed` or `moderator_proposal` in the hidden filter (those rows stay in `{ notifications }`; do not look up a forum message; do not add the parent id to the purge set). Appointed/proposal `parentId`/`replyId` are account ids in prod, so a purge of hidden **message** ids does not remove them. `unreadCount` is unread among kept rows after the duplicate drop and the hidden filter (before the 200 cap), not the unfiltered store count (if purge throws, still count kept unread; do not 503 the list). Each item `type` is `'forum_post' | 'forum_reply' | 'forum_mention' | 'zap' | 'moderator_appointed' | 'moderator_proposal'`. No account ids. `moderator_appointed` and `moderator_proposal` always stay through the level filter. Mark-read / read-all do not stamp `moderator_proposal`.
- **Errors:** 401 Unauthorized; 503 Notifications are unavailable (`notifications.list.failed`).
- **Used by:** App in-app notification list.
- **Auth:** Bearer session.

## Endpoint: POST /notifications/read-all

- **Purpose:** Bearer required. 200 `{ ok: true, tags }`. Marks every unread notification for the session account read except `moderator_proposal` (those rows stay until confirm, until reject when pending is then empty, or until appoint). `tags` are the collapse tags of rows this call stamped, including `moderator_appointed`. A missing or invalid body is not 404. An optional `endpoint` is skipped on the dismiss push only when it is one of this account's subscriptions, and it is never echoed. Enqueue failure is still 200. Empty `tags` enqueues nothing.
- **Errors:** 401 Unauthorized; 503 Notifications are unavailable (`notifications.read_all.failed`).
- **Used by:** App mark-all-read control.
- **Auth:** Bearer session.

## Endpoint: POST /notifications/read-by-message

- **Purpose:** Bearer required. Body `{ messageId }` must be a JSON object with a UUID. Stamps unread `forum_post`, `forum_reply`, `forum_mention`, and `zap` for this account whose `parentId` or `replyId` equals that id. Does not stamp `moderator_appointed`, `moderator_proposal`, another account, or an already-read row. 200 `{ ok: true, tags }` lists only rows this call stamped (zap tag is `zap:<replyId>`). A second call returns `tags: []`. Optional `endpoint` is skipped on the dismiss push only when it belongs to this account and is never echoed.
- **Errors:** 401 Unauthorized; 404 `{ error: 'Not found' }` for a missing, non-object, or non-UUID body (not 400); 503 `{ error: 'Notifications are unavailable' }` (`notifications.read_message.failed`). Dismiss enqueue failure is still 200.
- **Used by:** App when a signed-in member expands a note, asks for a translation, or opens the message page.
- **Auth:** Bearer session.

## Endpoint: POST /notifications/:id/read

- **Purpose:** Bearer required. UUID `:id`. 200 `PublicNotification` with `readAt` set. The body stays that notification, not `{ ok, tags }`. Dismiss happens only when this call changes `readAt` from null, which enqueues that row's dismiss tag for the account's other devices. An already-read row does not enqueue, even when its `readAt` equals the route clock. A `moderator_proposal` does not enqueue and is 200 with `readAt` still `null`.
- **Errors:** 401 Unauthorized; 404 Not found (unknown/other/non-uuid); 503 Notifications are unavailable (`notifications.read.failed`). Dismiss enqueue failure is still 200.
- **Used by:** App mark-one-read control.
- **Auth:** Bearer session.

## Endpoint: POST /conversations

- **Purpose:** Bearer required. Body `{ forumMessageId }` (forum note UUID). Opens or returns the thread with that note's author (21gifts account or Damus pubkey). 200 is the public conversation object (includes `kind`, `lastFromMe`, `unread`, `unreadMessageCount`, and optional counterpart `accountId`; empty new threads are `lastFromMe: false`, `unread: false`, and `unreadMessageCount: 0`; Damus-only counterparts omit `accountId`).
- **Errors:** 401 Unauthorized; 400 Expected a JSON body with a "forumMessageId" string; 400 `{ error: 'Cannot message yourself' }` when the author is the session account; 404 `{ error: 'Not found' }` for a non-UUID / missing note / Damus note without pubkey; 503 Conversations are unavailable.
- **Used by:** App "message the author" from a forum note.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /conversations/:id

- **Purpose:** Bearer required. `:id` is a UUID. Messenger-style keyset paging returns the newest `limit` messages (default/max 200), oldest-first within each page, as `{ messages: [{ id, name, text, createdAt, fromMe, sats, hasPhoto, photoCount, accountId?, giftFor?, mentions? }], nextCursor? }`. Optional `?limit=` is 1–200. Optional `?cursor=` is base64url JSON `{ k: 't', c: <ISO>, i: <uuid> }` encoded and decoded by the message-feed cursor helpers; it selects rows exclusively older than `createdAt` + `id`. A full page includes `nextCursor`, encoded from that page's oldest row; a shorter page omits it. The envelope has no counterpart `accountId` on the thread. Optional message `accountId` is the sender 21.gifts account (omitted when `senderAccountId` is null). For a staff viewer, `name` and `accountId` are the actor when `actorAccountId` is set. Members still see the house/sender snapshot (`21.gifts` on official replies). `fromMe` is true when the actor (else sender) is the viewer; Damus inbound (`senderAccountId` null) is false. No staff-as-platform shortcut. `hasPhoto` / `photoCount` (0–10) flag stills; bytes are never in this JSON. Optional `giftFor` is the id of the group message a paid moderator stipend belongs to (omitted on every other row; never JSON `null`). Optional `mentions` is `{ accountId, username }[]` when the text marks a person (omitted when nobody matches). A mark is a profile link and does not notify that person. Optional `?sinceMessageId=` (UUID) long-polls until that id is in the thread (pay-sheet confirmation); timeout still 200 with the current messages, and the response then uses the newest page regardless of a valid supplied cursor. A present invalid cursor is still 400. 404 when the session may not see the thread. `moderator_group` is 404 `{ error: 'Not found' }` unless the caller is a group member (`isModeratorGroupMember`: at least moderator, never the platform account) (no existence leak). Unauthenticated 401.
- **Errors:** 401 Unauthorized; 400 `{ error: 'Expected sinceMessageId to be a UUID' }`; 400 `{ error: 'Invalid limit' }`; 400 `{ error: 'Invalid cursor' }`; 404 Not found; 503 Conversations are unavailable. 403 `{ error: 'SUNDAY_REST' }` only when the loaded thread kind is `moderator_group` and `Time-Zone` names an IANA zone that is Sunday (a missing, blank, or invalid zone does not refuse; an ordinary private thread is not refused).
- **Used by:** App conversation thread and gift pay-sheet poll.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /conversations/:id/invoice

- **Purpose:** Bearer required. Body `{ sats: <int 1..10_000_000>, text?, amountUsd?, amountChf?, amountEur?, amountPhp? }` (omitting every amount key leaves the invoice unpinned; any present amount key pins all four and a missing sibling is null; `"0"`, `"0.0"`, and `"0.00"` are stored as `"0.00"`; an unusable amount string is the same 400 as a bad sats body). Issues a NIP-57 BOLT11 to the counterpart's receiving address (profile-note `e` tag). 200 `{ pr, amountSats, messageId, sparkInvoice }` — `messageId` is the predetermined conversation row, inserted only after zap ingest. Gift-only omits text. Damus threads are not invoiced. The counterpart's address comes from `receivingAddress`: with a verified wallet and the LNURL server configured it is the wallet-backed `<username>@<host of PUBLIC_BASE_URL>`, resolved against the LNURL server internally (`lnurlServerFetch`). Without a verified wallet there is no address. The response also carries `sparkInvoice`: a `spark1…` Spark invoice for the same amount to the recipient's verified wallet with memo `zap:<payment hash of pr>` when free in-app payments are on (`LNURL_SERVER_URL`, `PUBLIC_BASE_URL`, `LNURL_ZAP_NSEC_HEX`) and the recipient is wallet-backed, else `null`. The app pays it from its wallet and waits on the existing long-poll; the Spark invoice worker turns the settled transfer into a zap receipt for `pr`.
- **Errors:** 401 Unauthorized; 400 Expected a JSON body with a positive "sats" integer; 400 Text must be 1–8000 characters; 400 Set a name before posting; 400 Cannot message yourself; 400 The author's wallet cannot receive this Bitcoin payment, with `code: 'cannot_receive'` for `noZap`, `not_zap`, Damus, no counterpart, or no counterpart receiving address / profile note, and without `code` when the profile note is not signed yet or has no Nostr key; 400 Could not start the Bitcoin payment (`unreachable` and other LNURL transport failures); 404 Not found; 429 Too many payments; 503 Messages are unavailable / Conversations are unavailable (persist failure after a successful LNURL mint is 503 and the response has no `pr`). Sunday rest does not refuse this route: a conversation invoice stays open, as do an ordinary private thread, a pay link, the till, and contact.
- **Used by:** App inbox amount composer.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /conversations/:id

- **Purpose:** Bearer required. Body `{ text?, photo?: { contentType, data, takenAt? }, photos?: { contentType, data, takenAt? }[] }` (at most 10 stills; non-empty `photos` wins over singular `photo`). Optional `takenAt` is the same civil string as `POST /messages` (invalid or missing is stored null and does not 400). Conversation JSON does not return it. Empty text allowed on every kind when a photo is present. JPEG/PNG/WebP stills (max 10) are allowed on Direct (`member_member`), Contact (`member_platform`), Damus (`member_damus`), and `moderator_group`. Photo-bearing rows persist `nostrPublishState` skipped (never signed or published to Nostr); text-only Direct/Contact/Damus stay `pending`. Text 1–8000 via `normalizeForumText`. Appends a message. 200 is the public conversation message (`fromMe` true when this session is the actor; staff JSON `name`/`accountId` are the actor; members still see the platform sender; `hasPhoto` and `photoCount` 0–10; never photo bytes). Staff (at least moderator) replies on a platform thread persist `senderAccountId` as the platform account (worker signs with the platform nsec) and store `actorAccountId`/`actorName` as the logged-in staff. After persist, enqueues one conversation Web Push to bell-subscribed counterparts (member threads `/messages?c=<id>`; `moderator_group` `/moderate/group`; `unreadCount` is notification unread + listed inbox unread; `moderator_group` notifies other accounts with `roleAtLeast` `moderator`, not the platform account). Push failure is void-caught (`conversations.push.failed`) so 200 is unchanged. Does not write in-app Notification rows. Local persist does not wait for relay ACK. On `moderator_group`, sender is the caller account (at least moderator, not platform), `nostrPublishState` skipped (never Nostr). `moderator_group` is 404 `{ error: 'Not found' }` unless the caller is a group member (`isModeratorGroupMember`: at least moderator, never the platform account) (no existence leak). After a new persist, call `spendPing.ping(address, created.id, 'moderator')` only when the author has a receiving address (verified wallet; it is sent as `address`), `spendPing` is set, **and** the caller has a live living-room top-level post (not the profile note) whose `createdAt` is on the same UTC day **and** `eligibleToday` for the author's funding grant. No living-room post today → 200, no ping (`spend.ping.skipped` `no_public_post`). Public post today but not funding-eligible → 200, no ping (`spend.ping.skipped` `not_eligible`). Ping throw still 200, no ping. Living-room lookup failure after persist still 200, no ping (`spend.ping.skipped` `posted_unreachable`). Empty/invalid text still 400, no ping (empty text without a photo is 400 `{ error: 'Text must be 1–8000 characters or include a photo' }` on every kind).
- **Errors:** 401 Unauthorized; 400 Expected a JSON body with text and/or photo; 400 At most 10 photos; 400 Photo must be a JPEG, PNG, or WebP under 1 MiB; 400 Text must be 1–8000 characters or include a photo; 400 Set a name before posting; 400 Text must be 1–8000 characters; 404 Not found; 503 Conversations are unavailable. 403 `{ error: 'SUNDAY_REST' }` only when the loaded thread kind is `moderator_group` and `Time-Zone` names an IANA zone that is Sunday (a missing, blank, or invalid zone does not refuse; an ordinary private thread is not refused).
- **Used by:** App conversation composer.
- **Auth:** `Authorization: Bearer` session.
- **Marks:** Resolves `@username` in `text` at send time (same rules as `POST /messages`, so `name@host` is not a mark). Stores `{ accountId, username }` when that username exists then. Omits `mentions` when nobody matches. Does not write `forum_mention`. A marked person who is not already a recipient of the message gets no push. A later rename does not move the mark. A paid inbox gift stores the same marks when the zap comment is inserted. The contact form and inbound Nostr notes are not parsed.

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

- **Purpose:** Bearer required like `POST /me/forum-laws-dismissed`. Body `{ "level": "all" | "active" | "mentions" }`. Stores the owner fan-out filter on the account (`notificationLevel`). Default for new and omitted rows is `all` (current every-account behaviour). `active` is the related top-level post with sats>0 (zaps also when amountSats>0). `mentions` is a reply or zap on the recipient's own note, or a stored `@username` mark (`forum_mention`) for that recipient. A staff or platform actor does not satisfy mentions. Success is owner JSON including `notificationLevel`. Same level again is still 200. Logs `account.notification_level.set` `{ accountId, level }`.
- **Errors:** 401 `{ error: "Unauthorized" }` without a session; 400 `{ error: "Expected a JSON body with a level of all, active, or mentions" }` when the body is missing, not JSON, or `level` is not one of those three strings.
- **Used by:** App notification-level control on the signed-in profile.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /me/amount-unit

- **Purpose:** Bearer required like `POST /me/notification-level`. Body `{ "unit": "btc" | "fiat" }`. Stores the signed-in member's amount-entry unit on the account (`amountUnit`). Default for new and omitted rows is `btc`. Success is owner JSON including `amountUnit`. The same unit again is still 200 (idempotent write). Logs `account.amount_unit.set` `{ accountId, unit }`. Payment amounts stay whole sats; this route does not change invoices.
- **Errors:** 401 `{ error: "Unauthorized" }` without a session; 400 `{ error: "Expected a JSON body with a unit of btc or fiat" }` when the body is missing, not JSON, or `unit` is not one of those two strings.
- **Used by:** App amount-entry unit control on the signed-in profile so the member's preferred `btc` or `fiat` unit is stored on the account.
- **Auth:** `Authorization: Bearer` session required; unauthenticated callers receive 401 `{ error: "Unauthorized" }` and the account row is not written.

## Endpoint: POST /me/locale

- **Purpose:** Bearer required like `POST /me/amount-unit`. Body `{ "locale": "en" | "de" | "es" | "fil", "onlyIfUnset"?: boolean }`. Stores the signed-in member's UI language on the account (`locale`). Null on new rows means not defined yet. `onlyIfUnset: true` writes only while the column is still null; otherwise the current row is returned unchanged. Omitted or false replaces a stored value. Success is 200 owner JSON including `locale` (null when unset). Logs `account.locale.set` `{ accountId, locale, onlyIfUnset, wrote }` even when `wrote` is false.
- **Errors:** 401 `{ error: "Unauthorized" }` without a session (and if the row vanishes mid-request); 400 `{ error: "Expected a JSON body with a locale of en, de, es, or fil" }` when the body is missing, not JSON, `locale` is not one of those four strings, or `onlyIfUnset` is present and not a boolean.
- **Used by:** App language control on the signed-in profile so the member's resolved UI language is stored once (`onlyIfUnset`) and an explicit control can still replace a stored value.
- **Auth:** `Authorization: Bearer` session required; unauthenticated callers receive 401 `{ error: "Unauthorized" }` and the account row is not written.

## Endpoint: POST /me/fiat

- **Purpose:** Bearer required like `POST /me/locale`. Body `{ "fiat": "CHF" | "EUR" | "USD" | "PHP", "onlyIfUnset"?: boolean }`. Stores the signed-in member's fiat display currency on the account (`fiat`). Null on new rows means not defined yet. `onlyIfUnset: true` writes only while the column is still null; otherwise the current row is returned unchanged. Omitted or false replaces a stored value. Success is 200 owner JSON including `fiat` (null when unset). Logs `account.fiat.set` `{ accountId, fiat, onlyIfUnset, wrote }` even when `wrote` is false.
- **Errors:** 401 `{ error: "Unauthorized" }` without a session (and if the row vanishes mid-request); 400 `{ error: "Expected a JSON body with a fiat of CHF, EUR, USD, or PHP" }` when the body is missing, not JSON, `fiat` is not one of those four strings, or `onlyIfUnset` is present and not a boolean.
- **Used by:** App fiat-currency control on the signed-in profile so the member's resolved display currency is stored once (`onlyIfUnset`) and an explicit control can still replace a stored value.
- **Auth:** `Authorization: Bearer` session required; unauthenticated callers receive 401 `{ error: "Unauthorized" }` and the account row is not written.

## Endpoint: POST /me/rules-agreement

- **Purpose:** Bearer required. No body required. Records first living-room rules agreement using the server clock; later POSTs return the original timestamp (idempotent 200 account JSON).
- **Errors:** 401 `{ error: 'Unauthorized' }` without a session.
- **Used by:** App after name and address onboarding.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: POST /me/name

- **Purpose:** Bearer required. Body `{ name }`. Stores the trimmed display name on the account (1–80 characters, no C0/DEL control characters) in a name-only write that does not change username. When username is still blank, a follow-up write stores `usernameFromDisplayName(name)` if that handle is free; a uniqueness race leaves username null and setup at `username`. The response is the stored row after both writes. When the wallet is verified, the first persisted non-empty name also creates exactly one top-level profile forum note (`ensureProfileMessage`) and claims `profileMessageId` via `claimProfileMessageId` (set only while the pointer still matches the missing/hidden read; not exposed on owner JSON); without a verified wallet the name is stored and no note is inserted. Rename does not create a second note and does not change the note text.
- **Errors:** 401 without session; 400 if the body is not `{ name: string }` or the name fails validation. Does not 409 when the derived username is taken or lost to a uniqueness race (name still 200, username stays null). 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names an IANA zone that is Sunday on the server clock (a missing, blank, or invalid zone does not refuse).
- **Used by:** App `setName`.
- **Auth:** See Purpose — Bearer where stated, else public.

## Endpoint: POST /me/username

- **Purpose:** Bearer required. Body `{ username }`. Stores a unique LUD-16 / NIP-05 local-part (lowercase `a-z0-9-_.`, 1–32 characters, leading letter or digit; no trailing `.`, no `..`). Cannot be skipped. Same handle on the same account is 200. Once the wallet is verified, a request with a valid session, body and handle is 409, including the same handle; a missing session is still 401 and an invalid body or handle still 400. Logs `account.username.set`.
- **Errors:** 401 `{ error: 'Unauthorized' }`; 400 `{ error: 'Expected a JSON body with a "username" string' }`; 400 `{ error: 'Username must be 1–32 characters of a-z, 0-9, hyphen, underscore, or dot' }` (including trailing or double-dot rejects); 409 `{ error: 'Username is already in use' }` when another account owns it, including a unique-index race; 409 `{ error: 'Username is fixed once the wallet is connected' }` when the wallet is already verified. 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names an IANA zone that is Sunday on the server clock (a missing, blank, or invalid zone does not refuse).
- **Used by:** App username onboarding and profile.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /me/location

- **Purpose:** Bearer required. Body `{ location }`. Stores the trimmed free-text location on the account (at most 80 characters after trim, no C0/DEL control characters). Empty or whitespace-only input stores `null` (clear). Does not call `ensureProfileMessage`. Field is always present on owner JSON as `location` (`string | null`, never omitted, never `""`). Not a setup step, not a posting requirement, not a profile forum note, not Nostr `kind:0`.
- **Errors:** 401 `{ error: "Unauthorized" }` without a session; 400 `{ error: "Expected a JSON body with a \"location\" string" }` when the body is not `{ location: string }`; 400 `{ error: "Location must be at most 80 characters" }` when `normalizeLocation` returns `{ ok: false }`. 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names an IANA zone that is Sunday on the server clock (a missing, blank, or invalid zone does not refuse).
- **Used by:** App owner profile location.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: PUT /me/about

- **Purpose:** Bearer required. Body `{ text, photo? }`. `text` is required. `photo` omitted keeps a stored photo; JSON `null` clears it and clears `photo_taken_at`; `{ contentType, data, takenAt? }` is `decodeForumPhoto` (same JPEG/PNG/WebP under 1 MiB as `POST /messages`). `takenAt` is the same optional civil string as `POST /messages` (invalid or missing is stored null and does not 400). Replacing the photo writes that time. Writes About me onto the profile forum note (creates a new live note, with or without a verified wallet, when the note is missing or soft-hidden via `deletedAt`, including photo-only empty text with a decoded photo, then claims `profileMessageId` via `claimProfileMessageId` only while the pointer still matches the missing/hidden read; a lost claim deletes the insert and adopts a live winner). A won inline claim create calls `notifyForumPost` after the writes (best-effort; no-op when the actor is the official platform account; enqueue failure still 200). Adopting a live CAS winner does not notify. PUT `/about` does not call `ensureProfileMessage` (no name-copy insert). Updating an already-live note does not notify. Empty text with `photo` omitted or `null` and no live note does not create or notify. The hidden row stays hidden. Empty text clears the bio (`aboutMe` null; the live note row is kept). Name-only auto-copy is not a bio, including after a display-name rename (Ada→Grace with note text still `Ada` stays `null`). A live photo still sets `aboutMeHasPhoto`. Requires a display name (not a verified wallet). Success is owner JSON with `aboutMe` and `aboutMeHasPhoto`. After a successful save, a verified account with a live top-level photo or video (including this note) is welcome-pinged (`kind: "welcome"`); omitted `spendPing` skips; an account without a receiving address (no verified wallet, or the LNURL server off), or one that already has the welcome gift (once per account, as for `POST /messages`), is not pinged; a ping failure still returns 200.
- **Errors:** 401 without session; 400 if the body is not `{ text: string }`, text is longer than 8000 characters (`About me must be at most 8000 characters`), or text contains C0/DEL control characters; 400 `{ error: 'Photo must be a JPEG, PNG, or WebP under 1 MiB' }` when `photo` is present but neither `null` nor a decodable `{ contentType, data }`; 409 `{ error: 'missing_requirements', missing: ['name'] }` when name is blank; 503 `{ error: 'Messages are unavailable' }` when the store throws (`account.about.failed`). 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names an IANA zone that is Sunday on the server clock (a missing, blank, or invalid zone does not refuse).
- **Used by:** App profile About me editor.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /pictures/me

- **Purpose:** Bearer required. Raw profile-photo bytes. This is not the wide image and not the About me note photo.
- **Errors:** 401 `{ error: 'Unauthorized' }` without a session; 404 `{ error: 'Profile photo not found' }` when none is stored.
- **Used by:** App profile editor.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: PUT /pictures/me

- **Purpose:** Bearer required. Body `{ photo }`. `null` clears the profile photo. `{ contentType, data }` must be a JPEG, PNG, or WebP under 1 MiB with a readable size. Does not change the wide image or the About me note.
- **Errors:** 401 without a session; 400 `{ error: 'Expected a JSON body with a "photo" field' }` when `photo` is missing or not an object; 400 `{ error: 'Profile photo must be a JPEG, PNG, or WebP' }` when the bytes are not a decodable still. 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names an IANA zone that is Sunday on the server clock (a missing, blank, or invalid zone does not refuse).
- **Used by:** App profile editor.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /pictures/:file

- **Purpose:** Public. `:file` is `{accountId}.jpg`, `.png`, or `.webp`. Returns the stored profile photo when the extension matches. No auth. Used as the Nostr kind:0 `picture` URL.
- **Errors:** 404 `{ error: 'Not found' }` when the name does not match, nothing is stored, the account id is not a UUID, or the extension does not match.
- **Used by:** Nostr clients.
- **Auth:** none.

## Endpoint: GET /banners/me

- **Purpose:** Bearer required. Raw wide-image bytes via `forumPhotoResponse`. This is not the profile photo and not the About me photo.
- **Errors:** 401 `{ error: 'Unauthorized' }` without a session; 404 `{ error: 'Wide image not found' }` when none is stored.
- **Used by:** App profile editor.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: PUT /banners/me

- **Purpose:** Bearer required. Body `{ photo }`. `null` clears the wide image. `{ contentType, data }` must be a JPEG, PNG, or WebP under 1 MiB that is at least 640 px wide and at least 1.5 times as wide as it is tall. A portrait is rejected. Does not change the profile photo or the About me photo.
- **Errors:** 401 without a session; 400 `{ error: 'Expected a JSON body with a "photo" field' }` when `photo` is missing or not an object; 400 `{ error: 'Wide image must be at least 640 px wide and at least 1.5 times as wide as it is tall' }` when the bytes are not a decodable wide image. 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names an IANA zone that is Sunday on the server clock (a missing, blank, or invalid zone does not refuse).
- **Used by:** App profile editor.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /banners/:file

- **Purpose:** Public. `:file` is `{accountId}.jpg`, `.png`, or `.webp`. Returns the stored wide image when the extension matches the stored MIME. No auth. Used as the Nostr kind:0 `banner` URL.
- **Errors:** 404 `{ error: 'Not found' }` when the name does not match, nothing is stored, the account id is not a UUID, or the extension does not match.
- **Used by:** Nostr clients.
- **Auth:** none.

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

- **Purpose:** Stored trust graph. Bearer session required (any role). Bare `GET` returns founder seeds only (`edges` empty) so a large chain is not dumped on first paint. `?around=<id>` returns that chain member plus one hop of stored public edges with at most one incoming edge per subject: the oldest eligible sibling (`createdAt` then `id`), skipping a non-chain oldest sibling so a later displayable contact can show. Eligible: `verify`, `moderator_appoint`, and `moderator_propose` only when the live subject is a `moderator`; `moderator_confirm` and `moderator_reject` never. Later appoint, confirm, or propose do not replace an earlier eligible contact. Neighborhood uses full sibling lists per subject (`listEdgesForSubject`) so a non-touching older eligible edge still wins over a touching newer one. A pending propose stays private. Nodes are accounts at least verified (never basis). Never invents edges; omits lightning addresses, view keys, and linking keys.
- **Errors:** 401 `{ error: 'Unauthorized' }` without a session or with an invalid Bearer. 404 `{ error: 'Not found' }` when `around` is supplied but is not a uuid, is unknown, or is not a chain member (including Postgres `22P02`). Omitting `around` (or empty) is founder seeds, not 404. Unauthenticated `around` is 401, not 404. 503 `{ error: 'Trust chain is unavailable' }` when listing accounts or edges throws (`trust.chain.failed`).
- **Used by:** signed-in app `/trust-chain` via app `GET /trust/graph`.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: GET /trust/proposals

- **Purpose:** Bearer session required (moderator; not `DEBUG_TOKEN`). Lists pending proposals via `pendingModeratorProposals`: latest propose/reject is `moderator_propose`, live subject `role` is `verified`, and the subject has no `moderator_confirm` / `moderator_appoint`. JSON `{ "proposals": [ { id, subject: { id, name, role: "verified" }, proposedBy: { id, name }, createdAt } ] }` with the propose-edge `id` and ISO-8601 `createdAt` (empty list is 200). Oldest `createdAt` first, then propose-edge id. Missing subjects are omitted; a missing actor is `{ id, name: null }`. No `forum.read` / rules gate — a moderator without rules agreement is still 200. Logs `trust.proposals.listed` with `{ count }` only. `GET /trust-chain` still omits a pending `moderator_propose`. Once the subject is a `moderator`, that propose is eligible as the public incoming edge only when it is the oldest eligible sibling (`createdAt` then `id`).
- **Errors:** 401 `{ error: 'Unauthorized' }` without a session; 403 `{ error: 'Forbidden' }` when the live role is not at least moderator; 503 `{ error: 'Trust chain is unavailable' }` when listing accounts/edges or projecting throws (`trust.proposals.failed`).
- **Used by:** Staff moderator-proposal queue in the app.
- **Auth:** `Authorization: Bearer` session (moderator). Not `DEBUG_TOKEN`.

## Endpoint: POST /trust/verify

- **Purpose:** Bearer staff (moderator). Body `{ "accountId": "<uuid>" }`. Confirms the subject in real life: insert `verify` edge then `updateAccount` role=`verified`, log `trust.verified` `{ subjectId, actorId }`, `200 { id, name, role }`. Idempotent 200 when the existing verify edge actor is the caller and the subject is already `verified`. If that caller-owned edge exists and the subject is still `basis`, completes the role write and returns 200. After a 200 that leaves the subject `verified` (new grant, role completion, and idempotent repeat), the subject is welcome-pinged when a live top-level photo or video exists, including About me; omitted messages or spend ping skips; an account without a receiving address (no verified wallet, or the LNURL server off), or one that already has the welcome gift (once per account, as for `POST /messages`), is not pinged; a ping failure still returns 200.
- **Errors:** 401 `{ error: 'Unauthorized' }` without session; 403 `{ error: 'Forbidden' }` when the caller is not at least moderator; 400 `{ error: 'Expected a JSON body with an "accountId" string' }`; 404 `{ error: 'Not found' }` for a non-UUID or missing subject; 409 `{ error: 'Conflict' }` when the subject is self, a verify edge belongs to someone else, or the subject is ineligible (`role` is not `basis` except the caller-owned retry above); 503 `{ error: 'Trust chain is unavailable' }` on unexpected store throw (`trust.write.failed`). 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names an IANA zone that is Sunday on the server clock (a missing, blank, or invalid zone does not refuse).
- **Used by:** Staff verify flow in the app.
- **Auth:** `Authorization: Bearer` session. Staff only.

## Endpoint: POST /trust/propose-moderator

- **Purpose:** Bearer staff. Body `{ "accountId" }`. Subject must be `verified`, not self. 409 only when currently pending (latest propose/reject is propose), any confirm/appoint exists, the subject is self, role is not verified, or after insert this row is not the oldest open propose (the insert is deleted; remaining pending is then best-effort cleared and fan-out for that propose-edge id, failure stays 409; empty open after a concurrent reject is the same 409). After a reject, 200 inserts a **new** `moderator_propose` (history kept). When this insert is the oldest open propose and extras exist, delete newer extra proposes and still 200. Role unchanged; logs `trust.moderator_proposed`; `200 { id, name, role }`. After 200, delete existing `moderator_proposal` rows for the subject then wrap `notifyModeratorProposed` (in-app `moderator_proposal` plus Web Push to other staff). Then re-list: if pending is empty or the pending propose-edge `id` is not this insert, delete those rows again; if a different propose is pending, fan out for that actor only when a second re-list still shows that same id, and delete the rows if a re-list after that fan-out no longer matches. HTTP still 200 if notify or the purge fails.
- **Errors:** Same 401/403/400/404/409/503 JSON shapes as `POST /trust/verify` (409 when the subject is not verified, is self, is currently pending, already has confirm/appoint, or after insert this row is not the oldest open propose). 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names an IANA zone that is Sunday on the server clock (a missing, blank, or invalid zone does not refuse).
- **Used by:** Staff moderator-proposal flow.
- **Auth:** `Authorization: Bearer` session. Staff only.

## Endpoint: POST /trust/confirm-moderator

- **Purpose:** Bearer staff. Body `{ "accountId" }`. A pending proposal must exist (latest propose/reject is propose) and the caller id must differ from that latest proposer's actor id. Subject must still be `verified`. Inserts `moderator_confirm` then re-lists: if the pending propose-edge `id` from `pendingModeratorProposals` (ignoring this confirm insert) is no longer the same, or that id is not also the oldest open propose, delete that confirm and 409 without promoting. Otherwise sets role to `moderator`, logs `trust.moderator_confirmed`, `200 { id, name, role }`. If the caller already stored `moderator_confirm` and the subject is still `verified`, completes the role write and returns 200. If that caller-owned edge exists and the subject's rank equals the moderator rank, returns 200 with the stored role unchanged. A founder subject is 409 and stays `founder`. After a 200 that leaves the subject at the moderator rank (new grant and idempotent same-actor 200), delete `moderator_proposal` rows (`replyId === subject.id`) then wrap `notifyModeratorAppointed` for the subject only (in-app `moderator_appointed`, Web Push url `/welcome`). Failure logs `push.enqueue.failed`; persist/HTTP still 200.
- **Errors:** Same 401/403/400/404/409/503 JSON shapes as `POST /trust/verify` (409 when there is no pending propose, the caller proposed, the subject is no longer verified, a confirm edge belongs to someone else, the pending propose-edge id changed after insert, or that id is not the oldest open propose). 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names an IANA zone that is Sunday on the server clock (a missing, blank, or invalid zone does not refuse).
- **Used by:** Independent second staff confirmation.
- **Auth:** `Authorization: Bearer` session. Staff only.

## Endpoint: POST /trust/reject-moderator

- **Purpose:** Bearer staff (same auth as propose-moderator). Body `{ "accountId" }`. Reject an open moderator proposal: pending means the latest propose/reject is propose, the subject is still `verified`, and there is no confirm/appoint. Inserts append-only `moderator_reject` then re-lists: if a concurrent confirm or appoint already closed the grant, or the pending propose-edge `id` is still the same (this reject lost the same-ms id tie), delete that reject and 409. If a newer propose already reopened the queue (including a same-actor same-ms re-propose with a different edge `id`), 200 keeps the reject in history and does not drop `moderator_proposal` rows. Role stays `verified`. The original proposer may reject. Logs `trust.moderator_rejected` `{ subjectId, actorId }`. When pending is empty after insert, re-lists once more and deletes `moderator_proposal` rows with `replyId === subject.id` only if pending is still empty; if a re-list after that delete shows a new pending propose, fan out for that actor and re-list again so a concurrent close drops those rows. No notify for the reject itself. `200 { id, name, role }` with role unchanged.
- **Errors:** 401 `{ error: 'Unauthorized' }` without a bearer session; 403 `{ error: 'Forbidden' }` when the caller is not staff; 400 `{ error: 'Expected a JSON body with an "accountId" string' }`; 404 `{ error: 'Not found' }` for a non-UUID or missing subject; 409 `{ error: 'Conflict' }` when the subject is self, not pending, `role !== verified`, a concurrent confirm/appoint closed the grant, or the pending propose-edge id is still the same after insert; 503 `{ error: 'Trust chain is unavailable' }` on unexpected store throw (`trust.write.failed`). 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names an IANA zone that is Sunday on the server clock (a missing, blank, or invalid zone does not refuse).
- **Used by:** Staff moderator-proposal queue in the app (reject an open proposal so another staff member can re-propose).
- **Auth:** `Authorization: Bearer` session. Staff only (moderator+). Not `DEBUG_TOKEN`.

## Endpoint: POST /trust/appoint-moderator

- **Purpose:** Bearer founder (moderators → 403). Body `{ "accountId" }`. Subject must not be self, not founder, and not already at the moderator rank; may be `basis` or `verified`. Inserts `moderator_appoint` then sets role to `moderator`, logs `trust.moderator_appointed`, `200 { id, name, role }`. If the caller already stored `moderator_appoint` and the subject's rank equals the moderator rank, returns 200 with the stored role unchanged. If that edge exists and the subject is not yet at that rank, completes the role write and returns 200. A subject already at the moderator rank with no caller-owned appoint edge is 409. After a 200 that leaves the subject at the moderator rank (new grant and idempotent same-actor 200), delete `moderator_proposal` rows with `replyId === subject.id`, then wrap `notifyModeratorAppointed` for the subject only (in-app `moderator_appointed`, Web Push url `/welcome`). Failure logs `push.enqueue.failed`; persist/HTTP still 200.
- **Errors:** 401 without session; 403 when the caller is not `founder`; 400/404/409/503 same JSON shapes as `POST /trust/verify`. 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names an IANA zone that is Sunday on the server clock (a missing, blank, or invalid zone does not refuse).
- **Used by:** Founder appointment of a moderator.
- **Auth:** `Authorization: Bearer` session. Founder only.

## Endpoint: POST /funding/apply

- **Purpose:** Bearer session. Role `basis` → 403 Forbidden. While applications are paused, usernames `joey-rosima`, `vincent`, and `jewel-bacolbas` still run the About me, photo, location, and grant write. Every other verified caller still gets 403 `{ error: 'Applications are paused' }` with no grant write. Those checks and the grant write also run when `applicationsPaused` is false. Production omits that flag. Logs `funding.apply.paused` `{ accountId }` while paused (not for an exempt caller). A 200 logs `funding.applied` `{ accountId }`.
- **Errors:** 401 `{ error: 'Unauthorized' }`; 403 `{ error: 'Forbidden' }` for `basis`; 403 `{ error: 'Applications are paused' }` for verified and above while paused except `joey-rosima`, `vincent`, and `jewel-bacolbas`; 400 `{ error: 'About me is required' }`; 400 `{ error: 'About me photo is required' }`; 400 `{ error: 'Location is required' }` (exempt callers while paused, or when the switch is off); 409 `{ error: 'Conflict' }` when the grant is already pending, trial, or admitted, or the pending write matches no row (same callers); 503 `{ error: 'Funding is unavailable' }` (`funding.write.failed`). 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names an IANA zone that is Sunday on the server clock (a missing, blank, or invalid zone does not refuse).
- **Used by:** The app does not submit this route while applications are paused except for usernames `joey-rosima`, `vincent`, and `jewel-bacolbas`. Direct clients still receive the paused error unless the username is one of those three.
- **Auth:** `Authorization: Bearer` session. Not `basis`.

## Endpoint: GET /shops/activity

- **Purpose:** No staff and no bearer. How many shops were used per UTC day for the last 30 UTC days ending today (oldest first, zeros included). A shop is a live top-level forum note whose text contains `#21GiftsShop` (case-insensitive token; the next character must not be a letter, digit, or underscore) and whose `shop_account_id` is set. It counts on a UTC day when that currently assigned account has at least one `pos_charge` with `created_at` on that UTC day. Any status (`pending`, `cancelled`, `expired`) counts; creating the charge is the till use. There is no paid status. One account assigned to two qualifying notes counts as two shops that day. Replies, deleted notes, notes without an assigned account, and notes that are not shop notes do not count. JSON `{ days: [{ day, shopCount }] }`.
- **Errors:** 503 `{ error: 'Shop activity is unavailable' }` (`shops.activity.failed`).
- **Used by:** The statistics shop chart for every visitor.
- **Auth:** none.

## Endpoint: GET /funding/goal

- **Purpose:** Bearer session, any role including `basis`. How many shops had at least one till charge on each of the last 7 UTC days ending today (oldest first, zeros included), and how many of those shops had a charge on at least 5 of those days. A shop is a live top-level forum note whose text contains `#21GiftsShop` (case-insensitive token; the next character must not be a letter, digit, or underscore) and whose `shop_account_id` is set. It counts on a UTC day when that currently assigned account has at least one `pos_charge` with `created_at` on that UTC day. Any status (`pending`, `cancelled`, `expired`) counts; creating the charge is the till use. There is no paid status. One account assigned to two qualifying notes counts as two shops. The 5 days need not be consecutive. This is not `GET /shops/activity`. JSON `{ days: [{ day, shopCount }], qualifyingShops }`.
- **Errors:** 401 `{ error: 'Unauthorized' }` without a bearer session or with an unknown bearer. 503 `{ error: 'Funding goal is unavailable' }` (`funding.goal.failed`, keys `event` and `ts` only).
- **Used by:** The signed-in grant goals page.
- **Auth:** `Authorization: Bearer` session. Any signed-in role. Not `DEBUG_TOKEN`.

## Endpoint: GET /funding/payout-days

- **Purpose:** Staff Bearer. Seven UTC days ending today (oldest first) and one row per person who missed a grant day, received a daily payout, or received a welcome gift in that window, including a person who was not entitled. JSON `{ days, rows }` where each row is `{ accountId, name, days, welcome }`. Each cell in `days` is `blocked` (not entitled), `missed` (entitled, no daily gift), or `paid` (kind `daily` that UTC day). `welcome` is seven booleans in the same order as `days`. A daily gift sets `paid` and does not set `welcome`. A welcome gift sets `welcome` and does not change `blocked`, `missed`, or `paid`. Both may be true on the same UTC day. Moderator stipends, blank handles, gifts outside the window, and other kinds do not count. Does not call lazy trial expiry. Logs `funding.payouts.listed` `{ count }`.
- **Errors:** 401 `{ error: 'Unauthorized' }` without a bearer session; 403 `{ error: 'Forbidden' }` when the live role is not at least moderator; 503 `{ error: 'Funding is unavailable' }` (`funding.payouts.failed`).
- **Used by:** Staff payout-per-person table.
- **Auth:** `Authorization: Bearer` session (moderator).

## Endpoint: GET /funding/applications

- **Purpose:** Staff Bearer. Effective pending grants only (expired trials after lazy persist). JSON `{ applications: [{ accountId, name, role, appliedAt }] }` oldest `appliedAt` first. Logs `funding.applications.listed` `{ count }`.
- **Errors:** 401 `{ error: 'Unauthorized' }`; 403 `{ error: 'Forbidden' }` when the live role is not at least moderator; 503 `{ error: 'Funding is unavailable' }` (`funding.list.failed`).
- **Used by:** Staff funding queue.
- **Auth:** `Authorization: Bearer` session (moderator).

## Endpoint: GET /funding/applications/:accountId

- **Purpose:** Staff Bearer. 200 `{ account: { id, name, role, lightningAddress }, grant: { status, appliedAt, trialUtcDate, admittedAt, decidedAt }, messages }` (`account.lightningAddress` is the receiving address, the verified wallet, or `null`) with **effective** grant status and the same video-drop as member posts (`MESSAGE_LIST_LIMIT`, `serializeMessage`).
- **Errors:** 401/403 as list; 404 `{ error: 'Not found' }` for a non-UUID, missing account, or no grant; 503 `{ error: 'Funding is unavailable' }` (`funding.list.failed`).
- **Used by:** Staff funding review.
- **Auth:** `Authorization: Bearer` session (moderator).

## Endpoint: POST /funding/trial

- **Purpose:** Staff Bearer. Body `{ accountId }`. Target must be effective pending, not self, not `basis`. Sets `trial`, `trialUtcDate` = today UTC, `decidedAt`/`decidedBy` now, `admittedAt` null. 200 `{ id, name, role, funding }`. Logs `funding.trial`. After the 200, when `spendPing` is configured, ping it once with the member's receiving address (verified wallet; no wallet → no ping) and the newest live top-level photo or video (including About me) whose `createdAt` falls on today's UTC day. The ping is `spendPing.ping(address, id, 'daily', grantStatus)`, where grantStatus is the effective status of the grant just written. A blank address, no such post, or a post from an earlier UTC day does not ping. A thrown lookup or ping logs `funding.daily_ping.failed` and the HTTP status stays 200.
- **Errors:** 401/403 as list; 400 `{ error: 'Expected a JSON body with an "accountId" string' }`; 404 `{ error: 'Not found' }`; 409 `{ error: 'Conflict' }` for self / not pending / `basis`; 503 `{ error: 'Funding is unavailable' }` (`funding.write.failed`). 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names an IANA zone that is Sunday on the server clock (a missing, blank, or invalid zone does not refuse).
- **Used by:** Staff one-day trial.
- **Auth:** `Authorization: Bearer` session. Staff only.

## Endpoint: POST /funding/admit

- **Purpose:** Staff Bearer. Body `{ accountId }`. Target effective pending or trial, not self, not `basis`. Sets `admitted`, `admittedAt` now, `trialUtcDate` null. 200 `{ id, name, role, funding }`. Logs `funding.admitted`. A 200 from effective pending uses that same daily ping. A 200 from an active trial does not ping.
- **Errors:** Same 401/403/400/404/409/503 JSON as `POST /funding/trial`. 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names an IANA zone that is Sunday on the server clock (a missing, blank, or invalid zone does not refuse).
- **Used by:** Staff recurring admission.
- **Auth:** `Authorization: Bearer` session. Staff only.

## Endpoint: POST /funding/reject

- **Purpose:** Staff Bearer. Body `{ accountId }`. Target effective pending or trial, not self. Sets `rejected` and clears trial/admitted. 200 `{ id, name, role, funding }`. Logs `funding.rejected`.
- **Errors:** Same 401/403/400/404/409/503 JSON as `POST /funding/trial` (409 does not require the subject to be non-`basis`). 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names an IANA zone that is Sunday on the server clock (a missing, blank, or invalid zone does not refuse).
- **Used by:** Staff funding reject (subject may re-apply).
- **Auth:** `Authorization: Bearer` session. Staff only.

## Endpoint: GET /funding/daily-roster

- **Purpose:** Bearer session, initiator or founder only, moderator is 403. Reads the spend daily payout roster. Success 200 is only `{ comment, paymentsEnabled, defaultAmountUsd, recipients: [{ address, amountUsd }] }`. `defaultAmountUsd` is finite and forwarded unchanged. A missing or non-finite value is 502. There is no request body proxied to spend. Missing or blank `SPEND_URL` or `SPEND_API_TOKEN` is 503 only after the role gate, so a moderator is never 503.
- **Errors:** 401 `{ error: 'Unauthorized' }` with no session; 403 `{ error: 'Forbidden' }` when the live role is not initiator or founder; 503 `{ error: 'Daily roster is not configured' }` when spend is not configured; a spend 400 whose `error` is exactly `Invalid comment`, `Invalid payments switch`, `Invalid address or amount`, `Address already listed`, or `Unknown address` stays 400 with that text; any other spend 400 is 400 `{ error: 'Invalid daily roster change' }`; 502 `{ error: 'Daily roster is unavailable' }` when spend answers 401, 403, 500, or any status other than 200 or 400, the network fails, the response body cannot be read, the call times out, or the 200 body is not the roster shape.
- **Used by:** App daily payout roster.
- **Auth:** `Authorization: Bearer` session. Initiator or founder only.

## Endpoint: POST /funding/daily-roster/comment

- **Purpose:** Bearer session, initiator or founder only, moderator is 403. Newlines become spaces, then trim. Empty after trim is valid. Longer than 500 is 400 `Invalid comment` before fetch and is not cut. The normalized string is proxied to spend `POST /daily-roster/comment` as `{ comment }`. Success 200 is only `{ comment, paymentsEnabled, defaultAmountUsd, recipients: [{ address, amountUsd }] }`. `defaultAmountUsd` is finite and forwarded unchanged. A missing or non-finite value is 502. 503 only after the role gate.
- **Errors:** 401 `{ error: 'Unauthorized' }`; 403 `{ error: 'Forbidden' }` when the live role is not initiator or founder; 503 `{ error: 'Daily roster is not configured' }`; 400 `{ error: 'Invalid comment' }` when the body is not `{ comment: string }` or the normalized comment is longer than 500; spend 400 `{ error: 'Invalid comment' }`, `{ error: 'Invalid payments switch' }`, `{ error: 'Invalid address or amount' }`, `{ error: 'Address already listed' }`, or `{ error: 'Unknown address' }` returned unchanged; 400 `{ error: 'Invalid daily roster change' }` for any other spend 400 whose body was read; 502 `{ error: 'Daily roster is unavailable' }` for spend 401, 403, 500, or any status other than 200 or 400, a network failure, a response body that cannot be read, a timeout, or a 200 body that is not the roster.
- **Used by:** App daily payout roster comment.
- **Auth:** `Authorization: Bearer` session. Initiator or founder only.

## Endpoint: POST /funding/daily-roster/payments

- **Purpose:** Bearer session, initiator or founder only, moderator is 403, body proxied to spend `POST /daily-roster/payments` as `{ enabled }`. Success 200 is only `{ comment, paymentsEnabled, defaultAmountUsd, recipients: [{ address, amountUsd }] }`. `defaultAmountUsd` is finite and forwarded unchanged. A missing or non-finite value is 502. 503 only after the role gate.
- **Errors:** 401 `{ error: 'Unauthorized' }`; 403 `{ error: 'Forbidden' }` when the live role is not initiator or founder; 503 `{ error: 'Daily roster is not configured' }`; 400 `{ error: 'Invalid payments switch' }` when the body is not `{ enabled: boolean }`; spend 400 `{ error: 'Invalid comment' }`, `{ error: 'Invalid payments switch' }`, `{ error: 'Invalid address or amount' }`, `{ error: 'Address already listed' }`, or `{ error: 'Unknown address' }` returned unchanged; 400 `{ error: 'Invalid daily roster change' }` for any other spend 400 whose body was read; 502 `{ error: 'Daily roster is unavailable' }` for spend 401, 403, 500, or any status other than 200 or 400, a network failure, a response body that cannot be read, a timeout, or a 200 body that is not the roster.
- **Used by:** App daily payout roster payments switch.
- **Auth:** `Authorization: Bearer` session. Initiator or founder only.

## Endpoint: POST /funding/daily-roster/recipients

- **Purpose:** Bearer session, initiator or founder only, moderator is 403, body proxied to spend `POST /daily-roster/recipients` as `{ address, amountUsd }`. Success 200 is only `{ comment, paymentsEnabled, defaultAmountUsd, recipients: [{ address, amountUsd }] }`. `defaultAmountUsd` is finite and forwarded unchanged. A missing or non-finite value is 502. 503 only after the role gate.
- **Errors:** 401 `{ error: 'Unauthorized' }`; 403 `{ error: 'Forbidden' }` when the live role is not initiator or founder; 503 `{ error: 'Daily roster is not configured' }`; 400 `{ error: 'Invalid address or amount' }` when the body is not `{ address: string, amountUsd: number }`; spend 400 `{ error: 'Invalid comment' }`, `{ error: 'Invalid payments switch' }`, `{ error: 'Invalid address or amount' }`, `{ error: 'Address already listed' }`, or `{ error: 'Unknown address' }` returned unchanged; 400 `{ error: 'Invalid daily roster change' }` for any other spend 400 whose body was read; 502 `{ error: 'Daily roster is unavailable' }` for spend 401, 403, 500, or any status other than 200 or 400, a network failure, a response body that cannot be read, a timeout, or a 200 body that is not the roster.
- **Used by:** App daily payout roster recipient add.
- **Auth:** `Authorization: Bearer` session. Initiator or founder only.

## Endpoint: POST /funding/daily-roster/recipients/update

- **Purpose:** Bearer session, initiator or founder only, moderator is 403, body proxied to spend `POST /daily-roster/recipients/update` as `{ address, amountUsd }`. Success 200 is only `{ comment, paymentsEnabled, defaultAmountUsd, recipients: [{ address, amountUsd }] }`. `defaultAmountUsd` is finite and forwarded unchanged. A missing or non-finite value is 502. 503 only after the role gate.
- **Errors:** 401 `{ error: 'Unauthorized' }`; 403 `{ error: 'Forbidden' }` when the live role is not initiator or founder; 503 `{ error: 'Daily roster is not configured' }`; 400 `{ error: 'Invalid address or amount' }` when `address` is a string and the amount is bad; 400 `{ error: 'Unknown address' }` when `address` is not a string; spend 400 `{ error: 'Invalid comment' }`, `{ error: 'Invalid payments switch' }`, `{ error: 'Invalid address or amount' }`, `{ error: 'Address already listed' }`, or `{ error: 'Unknown address' }` returned unchanged; 400 `{ error: 'Invalid daily roster change' }` for any other spend 400 whose body was read; 502 `{ error: 'Daily roster is unavailable' }` for spend 401, 403, 500, or any status other than 200 or 400, a network failure, a response body that cannot be read, a timeout, or a 200 body that is not the roster.
- **Used by:** App daily payout roster recipient update.
- **Auth:** `Authorization: Bearer` session. Initiator or founder only.

## Endpoint: POST /funding/daily-roster/recipients/delete

- **Purpose:** Bearer session, initiator or founder only, moderator is 403, body proxied to spend `POST /daily-roster/recipients/delete` as `{ address }`. Success 200 is only `{ comment, paymentsEnabled, defaultAmountUsd, recipients: [{ address, amountUsd }] }`. `defaultAmountUsd` is finite and forwarded unchanged. A missing or non-finite value is 502. 503 only after the role gate.
- **Errors:** 401 `{ error: 'Unauthorized' }`; 403 `{ error: 'Forbidden' }` when the live role is not initiator or founder; 503 `{ error: 'Daily roster is not configured' }`; 400 `{ error: 'Unknown address' }` when the body is not `{ address: string }`; spend 400 `{ error: 'Invalid comment' }`, `{ error: 'Invalid payments switch' }`, `{ error: 'Invalid address or amount' }`, `{ error: 'Address already listed' }`, or `{ error: 'Unknown address' }` returned unchanged; 400 `{ error: 'Invalid daily roster change' }` for any other spend 400 whose body was read; 502 `{ error: 'Daily roster is unavailable' }` for spend 401, 403, 500, or any status other than 200 or 400, a network failure, a response body that cannot be read, a timeout, or a 200 body that is not the roster.
- **Used by:** App daily payout roster recipient delete.
- **Auth:** `Authorization: Bearer` session. Initiator or founder only.

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

- **Purpose:** Operator catalog of every allowlisted Postgres table as camelCase JSON (cap 200 per table). Success JSON is `{ tables }` keyed by allowlisted table name: `account`, `passkey_credential`, `passkey_challenge`, `auth_session`, `api_log`, `contact`, `pos_charge`, `conversation`, `conversation_message`, `conversation_read`, `message`, `message_extra_photo`, `message_invoice`, `nostr_zap_ingest`, `nostr_zap_receipt`, `nostr_zap_payment`, `nostr_zapper`, `nostr_blocked_pubkey`, `notification`, `push_subscription`, `push_outbox`, `trust_edge`, `gift`, `btc_usd_daily`, `usd_fiat_daily`, `db_change`. Media bytes stay off JSON (`photoBytes` / extra-photo `bytes` are lengths). `nostrNsecCiphertext` is envelope hex. `btc_usd_daily` / `usd_fiat_daily` dump stored rate rows when the rate books expose `listDebug`; `db_change` dumps when a list port is wired (in-memory boots dump `[]`). `api_log` dumps when `apiLogStore` is wired (the newest 200; the full history is `GET /debug/api-log` following `before` and `beforeId` while `hasMore` is true).
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 503 `{ error: 'Dump is unavailable' }` when a store throws.
- **Used by:** Operator `gifts-debug dump`.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: GET /debug/dump/:table

- **Purpose:** Same catalog as `GET /debug/dump` for one allowlisted table name. Response `{ table, rows }`.
- **Errors:** 503 `{ error: 'Debug is not configured' }` when `DEBUG_TOKEN` is unset or blank; 401 `{ error: 'Unauthorized' }` when the Bearer token does not match; 404 `{ error: 'Not found' }` when the table name is not allowlisted (`account`, `passkey_credential`, `passkey_challenge`, `auth_session`, `api_log`, `contact`, `pos_charge`, `conversation`, `conversation_message`, `conversation_read`, `message`, `message_extra_photo`, `message_invoice`, `nostr_zap_ingest`, `nostr_zap_receipt`, `nostr_zap_payment`, `nostr_zapper`, `nostr_blocked_pubkey`, `notification`, `push_subscription`, `push_outbox`, `trust_edge`, `gift`, `btc_usd_daily`, `usd_fiat_daily`, `db_change`); 503 `{ error: 'Dump is unavailable' }` when a store throws.
- **Used by:** Operator `gifts-debug dump <table>`.
- **Auth:** `Authorization: Bearer` with `DEBUG_TOKEN`. Not an end-user session.

## Endpoint: PUT /me/wallet

- **Purpose:** Bearer required. Body `{ sparkPubkey }` (66 hex characters, compressed secp256k1). Claims the wallet identity key on the account while unverified (`claimSparkPubkey`). A second PUT overwrites freely until verification. Mounted only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve; otherwise Hono's default 404. Logs `account.wallet.claimed` `{ accountId }` (never the key). Success is owner JSON including `sparkPubkey` and `sparkWalletVerified`.
- **Errors:** 401 `{ error: 'Unauthorized' }`; 400 `{ error: 'Expected a JSON body with a "sparkPubkey" of 66 hex characters' }`; 409 `{ error: 'missing_requirements', missing: ['username'] }` without a username; 409 `{ error: 'Wallet is not set up' }` when `walletRequired` is not true; 409 `{ error: 'Wallet is already connected' }` once verified (or a concurrent verification). Not mounted → 404.
- **Used by:** App wallet bind after seed setup.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /lnurlpay/:pubkey

- **Purpose:** Forward wallet registration to the self-hosted LNURL server. Mounted only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve. Gate: normalised pubkey, JSON body with string `username`; `body.username` must consist only of printable ASCII characters (otherwise 404 and the LNURL server is not contacted); no other key equals `username` after NFKC normalisation and lower-casing (for example `Username`); normalised name; account owns that username with matching claimed key; and no other account is verified on the key. The body is forwarded as the parsed JSON re-serialised. Upstream 2xx marks the key verified (`account.wallet.verified`); when the account is not verified on that key afterwards, 409 `{ error: 'Wallet registration could not be confirmed' }` and `account.wallet.unconfirmed`. Path segments are only `A-Z a-z 0-9 . _ ~ -`, never `.` or `..`. Rate limit 30/min/client. Body cap 1 MB (1 048 576 bytes); a larger body gets 413 `{ error: 'Request body is too large' }` and the upstream is not contacted. A request without a validated `cf-connecting-ip` is not counted by the per-address limits.
- **Errors:** 404 `{ error: 'Not found' }` when the gate fails, a path segment is refused, or the route is not mounted; 409 `{ error: 'Wallet registration could not be confirmed' }` when upstream accepted registration but the account is not verified on that key afterwards; 429 `{ error: 'Too many requests' }`; 413 `{ error: 'Request body is too large' }`; 503 `{ error: 'Lightning address service is unavailable' }` when upstream is unreachable, the store throws, or upstream returns a status outside 2xx and 4xx (for example 5xx). Upstream 2xx passed through with its status, body and only the `content-type` / `cache-control` headers (a 204 stays a 204). Upstream 4xx is passed through with body and status (nothing verified).
- **Used by:** In-app wallet registration of `username@<domain>`.
- **Auth:** none (wallet signature in body or `x-breez-*` headers; no api session).

## Endpoint: POST /lnurlpay/:pubkey/recover

- **Purpose:** Forward signed recover to the self-hosted LNURL server. Mounted only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve. Gate: normalised pubkey and `isSparkPubkeyClaimed`. Rate limit 30/min/client. Body cap 1 MB (1 048 576 bytes); a larger body gets 413 `{ error: 'Request body is too large' }` and the upstream is not contacted.
- **Errors:** 404 when the gate fails or the route is not mounted; 429; 413; 503 when unreachable, the store throws, or upstream returns any status other than 2xx and 404 (other 4xx and 5xx). Upstream 2xx passed through with its status, body and only the `content-type` / `cache-control` headers (a 204 stays a 204); upstream 404 → 404.
- **Used by:** In-app wallet recover of a previously registered name.
- **Auth:** none (wallet signature headers/body; no api session).

## Endpoint: GET /lnurlpay/:pubkey/metadata

- **Purpose:** Forward signed metadata for received payments. Mounted only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve. Gate: normalised pubkey and a verified account on that key. Raw query string forwarded unchanged. Rate limit 120/min/client. A `HEAD` request is answered 404 and the LNURL server is not contacted.
- **Errors:** 404 when the gate fails or the route is not mounted; 429; 503 when unreachable, the store throws, or upstream returns any status other than 2xx and 404 (other 4xx and 5xx). Upstream 2xx passed through with its status, body and only the `content-type` / `cache-control` headers (a 204 stays a 204); upstream 404 → 404.
- **Used by:** In-app wallet payment history.
- **Auth:** none (wallet signature headers; no api session).

## Endpoint: GET /lnurlp/:username/invoice

- **Purpose:** Forward LNURL-pay invoice fetch for a wallet-backed username. Mounted only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve. Gate: normalised username and account with verified wallet. Raw query string forwarded unchanged. Rate limit 20/min/client. CORS `*`. A `HEAD` request is answered 404 and the LNURL server is not contacted.
- **Errors:** 404 when the gate fails or the route is not mounted; 429; 503 when unreachable, the store throws, or upstream returns any status other than 2xx and 404 (other 4xx and 5xx). Upstream 2xx passed through with its status, body and only the `content-type` / `cache-control` headers (a 204 stays a 204), including LUD-06 `{ status: 'ERROR', reason }` as HTTP 200 from upstream.
- **Used by:** Payers fetching an invoice for `username@<domain>` after the well-known payRequest.
- **Auth:** none.

## Endpoint: GET /verify/:paymentHash

- **Purpose:** LUD-21 payment verification forward to the self-hosted LNURL server. Mounted only when `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve. Forwarded when the payment hash segment is only `A-Z a-z 0-9 . _ ~ -` and is neither `.` nor `..` (joined as-is, no percent-encoding). No query string. Rate limit 120/min/client. CORS `*`. A `HEAD` request is answered 404 and the LNURL server is not contacted.
- **Errors:** 404 when the route is not mounted or the payment hash segment is refused (upstream not contacted); 429; 503 when unreachable (network / timeout / redirect / body-read failure) or upstream returns any status other than 2xx and 404 (other 4xx and 5xx). Upstream 2xx passed through with its status, body and only the `content-type` / `cache-control` headers (a 204 stays a 204); upstream 404 → 404.
- **Used by:** Wallets verifying a paid invoice.
- **Auth:** none.

## Endpoint: POST /me/wallet-backup-seen

- **Purpose:** Bearer required. Empty body. Sets `walletBackupSeenAt` via `markWalletBackupSeen` (`WHERE wallet_backup_seen_at IS NULL`; logs `account.wallet.backup_seen` `{ accountId }` only when this call wrote). Does not change `walletRequired`. Owner JSON including `setup` / `missing` / `funding`. Never a mnemonic or PRF.
- **Errors:** 401 without session.
- **Used by:** App `POST /me/wallet-backup-seen` records that this account can show a recovery phrase. Not a confirmation and not a setup step. Empty body. Does not change `walletRequired`.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /me/passkey-renew/report

- **Purpose:** Bearer required. Strict JSON `{ stage, outcome, errorName, errorCode, httpStatus, message }` plus optional public authenticator facts (`authenticatorAttachment`, `transports`, `aaguid`, `prfEnabled`, `prfPresent`, `extensions`, `authenticatorFlags`, `publicKeyAlgorithm`, `residentKey`, `hmacSecret`, `credProtect`, `clientCapabilities`). Accepts only `failed` or `cancelled` (`succeeded` is 400). Stores a passkey renew row (server id and `createdAt`; User-Agent from the header). Does not change the account row. Before the length cap, a phrase of 12 or more whitespace-separated tokens, or a run of 64 or more token characters, is stored as `[redacted]` on error name (80), error code (80), message (500), and user agent (300). Debug values outside the allowlist are stored as null and do not reject the row. `authenticatorFlags` is the WebAuthn flags byte (UP 0x01, UV 0x04, BE 0x08, BS 0x10, AT 0x40, ED 0x80). Never stores a credential id, attestation, challenge, or PRF output. Returns owner JSON loaded after the insert, including `passkeyRenewFailed`, `passkeyRenewClosed`, and `passkeyRenewPrfUnsupported` (true only for the newest unacknowledged `prfUnsupported` row). A seed that landed during the request is not closed. `passkeyRenewClosed` is true only while `walletRequired` is false.
- **Errors:** 401 without session; 400 for a bad report body (invalid JSON, unknown keys, or `outcome: "succeeded"`).
- **Used by:** App passkey renew ceremony (browser cancel / PRF failure) via `POST /me/passkey-renew/report`.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /me/passkey-renew/ack

- **Purpose:** Bearer required. Empty body is fine. Acknowledges failed unacknowledged renew rows only (`outcome = 'failed'` and `acknowledged_at` IS NULL). Does not change the account row. Returns owner JSON loaded after the acknowledgement, including `passkeyRenewFailed`, `passkeyRenewClosed`, and `passkeyRenewPrfUnsupported` (true only when the newest unacknowledged failed renew row has error name `prfUnsupported`; acknowledgement clears that row, so the flag is false). A seed that landed during the request is not closed. `passkeyRenewClosed` is true only while `walletRequired` is false.
- **Errors:** 401 without session.
- **Used by:** App after the owner dismisses a failed renew.
- **Auth:** `Authorization: Bearer` session.

## Endpoint: POST /me/setup/skip

- **Purpose:** Bearer required. Body `{ step: "name" | "lightning-address" }`. Sets `nameSkippedAt` or `lightningAddressSkippedAt` to now so owner `setup` advances; does not clear or change `name` or the wallet. `lightning-address` is the receiving-wallet step (token kept for app compatibility). Skipping an already-set field is allowed (writes the skip timestamp). Rules cannot be skipped. `step: "wallet"` is 400 like an unknown step.
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

## Endpoint: GET /habits

- **Purpose:** Public list of member habits. No bearer required. A valid bearer includes `notes` only on the caller's own habits. `notes` is omitted for everyone else. An invalid or unknown bearer is treated as signed out and still returns the public list. Periods run from `firstPeriod` through the latest ratable day or week and stop at `lastPeriod`. `logged` is false and `status` is null when the owner has not recorded that period.
- **Inputs:** Optional `Authorization: Bearer`. No query and no body.
- **Returns / side effects:** 200 `{ reviewWeek: { start }, habits }`. `reviewWeek.start` is the Manila review Monday. No writes.
- **Errors:** 503 `{ error: 'Habits are unavailable' }` when the store throws (`habits.failed`). A bad bearer is not an error.
- **Used by:** the habit tracker page.

## Endpoint: POST /habits

- **Purpose:** One strict JSON action: `add`, `edit`, `archive`, `log`, `comment`, `deleteComment`, `invoice`. Bearer required. `add` requires `Time-Zone`. `comment`, `deleteComment`, and `invoice` follow the same Sunday rest as other public writing and as `POST /messages/:id/invoice`: 403 `{ error: 'SUNDAY_REST' }` when `Time-Zone` names an IANA zone that is Sunday. The invoice check is before the amount check. A missing, blank, or invalid zone does not refuse. Rating, add, edit, and archive are not that refusal. An edit whose current period is after `lastPeriod` is 409 `{ error: 'Period is closed' }` and does not change the stored wording. An edit of another member's habit is 404, including when that period is already closed. `invoice` returns `{ pr, amountSats }` minted on the comment author's receiving address (the verified in-app wallet) and does not pay. Comments are not forum posts.
- **Inputs:** Bearer session. Body is one action object. `add`, `comment`, `deleteComment`, and `invoice` also send `Time-Zone`.
- **Returns / side effects:** 201 `{ ok: true, id }` for add. 201 `{ ok: true }` for comment, with no id. 200 `{ ok: true }` for edit, archive, log, and deleteComment. 200 `{ pr, amountSats }` for invoice. 400 invalid body, name, description, notes, time zone, status, period, or comment, self-donation, or `{ error: 'Expected a JSON body with an integer "amountSats"' }` when `amountSats` is missing, not a number, not a positive integer, or above 10_000_000. 401 missing bearer. 403 `{ error: 'SUNDAY_REST' }` for `comment`, `deleteComment`, and `invoice` on Sunday, or `{ error: 'Forbidden' }` for `deleteComment` below initiator rank. 404 missing habit or comment, including a comment id that is not a UUID on `deleteComment` and `invoice`. 409 `{ error: 'Period is closed' }` or `{ error: "The author's wallet cannot receive this Bitcoin payment" }`. 429 `{ error: 'Too many payments' }`. 502 `{ error: 'Lightning Address could not be resolved' }` when the mint fails or the BOLT11 does not decode to exactly `amountSats * 1000` millisatoshis. 503 `{ error: 'Habits are unavailable' }` when the store throws (`habits.failed`).
- **Used by:** the habit tracker page.
