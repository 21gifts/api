# 21.gifts — Core UI Flows

> Screen-by-screen sketch of the five journeys named in CONCEPT next-step 7,
> plus the shipped in-app contact mailbox (journey 6) and in-app Notifications
> plus Web Push (journey 7).
> Product decisions live in [`CONCEPT.md`](./CONCEPT.md). Implemented HTTP
> contracts live in [`SPEC.md`](./SPEC.md). This file **does not invent HTTP
> paths, JSON fields, or status codes**. When a journey has no route in
> `SPEC.md`, say so and stop.

**Status**: living document. Last revised 2026-09-23.

---

## How to read this file

| Label       | Meaning                                                                                |
| ----------- | -------------------------------------------------------------------------------------- |
| **Shipped** | Exists in `21gifts/app` and/or this api today; HTTP only as already named in `SPEC.md` |
| **Sketch**  | Decided v1 UX from `CONCEPT.md`; no UI and no HTTP yet. Headings here are not routes.  |

Users are never asked about keys, relays, or NOSTR jargon on any screen. The
product stays warm and direct — people helping people.

---

## 1. Sign-in — **Shipped**

The landing page at `/` is the marketing site (pitch, how-it-works, FAQ) with
**Log in** / **Ask for help** to `/login` and **Send help** to `/donate`.
`/login` is the passkey-only sign-in surface (`LoginCard`). Passkey RP ID is
`WEBAUTHN_RP_ID`.

On mount the app rehydrates a persisted session token via `GET /me`. A **401**
clears the token; a transient failure does not.

**Passkey (first login, HTTP shipped)**

1. App calls `POST /auth/passkey/register/begin` (new account, or
   `{ "viewKey" }` to claim a provisioned profile) or
   `POST /auth/passkey/authenticate/begin` (returning).
2. Browser runs `navigator.credentials.create` / `get` with the returned
   `options` (no WebAuthn library in the app).
3. App posts the credential to the matching `…/finish` with the page
   `Origin`. The api verifies and returns `{ token, account }` immediately.
   An account with `sessionRefused` (operator flag on the row) is refused at
   finish and on `GET /me` with 403 and no new bearer, so the client can sign
   the visitor out.

Login is passkey-only. LNURL-auth has been removed.

A signed-in member can replace their one passkey (`POST /auth/passkey/replace/begin`
then `…/finish` with Bearer) so a PRF-capable authenticator can own the account.
The existing session stays valid. The api never sees PRF output or a mnemonic.

The signed-in view currently lives on `/login` — there is no separate
`/profile` route yet. It shows a name form, a username form, a Lightning
Address form, and **Sign out**. Name and Lightning Address are each
skippable via `POST /me/setup/skip`. Username cannot skip; the app sets
the handle with `POST /me/username`. Living-room rules stay required.
New passkey accounts must confirm the recovery phrase first
(`POST /me/wallet-backup-seen`); that step cannot skip.

`GET /me` `setup` order is wallet (when `walletRequired` and the backup
is unseen; not skippable), then name, then username (unskippable), then
lightning-address, then rules. When username is still blank,
`POST /me/name` auto-assigns `usernameFromDisplayName` if that handle is
free; a collision or uniqueness race leaves username null and `setup` at
username.

After wallet backup (new accounts), name/skip, username, and address/skip,
the app records living-room rules agreement via `POST /me/rules-agreement`.
`GET /me` carries `setup` (wizard; skip counts as done for name and
Lightning Address, not username or wallet), `missing` (facts; skip does
not), `walletRequired`, `walletBackupSeenAt`, and `rulesAgreedAt` (epoch
ms of the first agreement, or `null`).

No email, no password. Losing the passkey (and platform sync) loses the
account.

HTTP cited: `/auth/passkey/register/begin`, `/auth/passkey/register/finish`,
`/auth/passkey/authenticate/begin`, `/auth/passkey/authenticate/finish`,
`/auth/passkey/replace/begin`, `/auth/passkey/replace/finish`,
`/me`, `/me/wallet-backup-seen`, `/me/setup/skip`, `/me/name`, `/me/username`,
`/me/rules-agreement`.

---

## 2. Profile — **Shipped** (address, name) + **Sketch** (photo / story)

### Address — **Shipped**

Every account can receive. From the signed-in view the user can link, replace,
or unlink a LUD-16 Lightning Address:

- `POST /me/lightning-address` — link or replace after a live well-known
  resolve that requires zap metadata (`allowsNostr` + `nostrPubkey`). Always
  leaves the address **unverified**. Unreachable or non-zap addresses are
  rejected and not stored.
- `DELETE /me/lightning-address` — unlink (also clears the LN skip timestamp;
  does not clear `username`). After unlink, `setup` stays `wallet` when
  `walletRequired` is true and backup is unseen; otherwise `setup` is
  `username` if the handle is blank; `setup` is `lightning-address` only when
  wallet is done or not required, name is done or skipped, **and** username is
  set

Proof-of-control of the linked Lightning Address is the flag
`lightningAddressVerified` (not the forum role **Verified**):

1. `POST /me/lightning-address/verification` (no body). The api pays 1 sat, or
   the provider's `minSendable` when higher, capped at 10 sat, with a LUD-12
   comment `21gifts <32-hex-nonce>`. The nonce is never returned to the client.
2. The user types the code from wallet history into
   `POST /me/lightning-address/verification/confirm`.

Until an invoice payer is injected, start returns **503**
`{ "error": "Verification payments are not configured" }`. The process still
boots. Live verification payments do **not** work today. Edit or unlink clears
any pending verification (`SPEC.md`).

### Identity copy — **Shipped** (name / location / About me / About me photo)

Receiver name is stored on the account (`POST /me/name`). Optional free-text
location is stored on the account (`POST /me/location`); empty or whitespace
after trim stores `null`. Location is public on member and view cards. It is
not a setup step, not a posting requirement, not a profile forum note, and
not Nostr `kind:0`. About me is `PUT /me/about` (Bearer `{ text, photo? }`): a
non-blank name is required (409 otherwise); Lightning Address is not; empty
text clears the bio (`aboutMe` null; a live note row is kept). Optional
`photo` uses the same JPEG/PNG/WebP decode as a forum post (`omitted` keeps,
`null` clears, object sets). When no live note exists, empty text without a
new photo does not create or notify; a photo-only or non-empty write against
a missing or hidden note creates a live note without LN and notifies after
the write. Auto name-copy is not a bio (`aboutMe` is `null`); a photo still
sets `aboutMeHasPhoto`. `POST /me/name` still no-ops the note without LN;
`POST /me/lightning-address` still creates the name-copy note. Rename does
not create a second note. Other members read live identity plus `aboutMe`
and `aboutMeHasPhoto` via `GET /members/:accountId` (Bearer; rules required).
Kind:0 `picture` stays the brand icon. **Do not invent** `POST /me/profile`.

### View-key link — **Shipped**

The owner can copy a view-key link from `viewKey` on `GET /me`. The URL is
`GET /view/:viewKey`. Opening that URL shows a read-only public profile card.
It cannot write and cannot mint a session. Do not invent extra paths.

---

## 3. Donate — **Sketch** (button / browser pay) + **Shipped** (resolve)

Guest / one-off giving: the donor clicks **Donate** on a receiver and pays
through browser LNURL-pay (resolve the Lightning Address → invoice → wallet
pays). The api is **not** in the payment path. This works without an account
(CONCEPT Donations).

Public `GET /lightning-address` now resolves and caches LUD-16 metadata
(callback, min/max sendable, optional commentAllowed). There is still no
Donate button; for this guest path the api still does not fetch or pay the
gift invoice (spend-worker invoice fetch is §4 / `POST /invoices`).

There is no campaign feed and no Donate button in the app today. Do not invent
`/feed` or `/campaigns` paths.

HTTP cited: `/lightning-address`, `/gifts/stats`, `/gifts?day=` (see `SPEC.md`).

Public gift totals are **Shipped** as `GET /gifts/stats` (sats, BTC,
historical USD at each gift's UTC-day Coinbase BTC-USD close, and
CHF/EUR/PHP = USD × that UTC day's ECB rate, last business day if closed;
UTC spend-over-time, per person, per month). Individual gifts for one UTC day
are **Shipped** as `GET /gifts?day=YYYY-MM-DD`. No invoices. The app
statistics page and `/stats/{day}` consume those routes.

Optional NIP-57 Zap receipts stay deferred (CONCEPT Out).

---

## 4. Recurring gifts — **Sketch**

**Prerequisite**: paying is out of this process. The external spend
worker holds lightning.space LNDHub credentials and calls:

1. `POST /invoices` — this api fetches the BOLT11 from the recipient via LNURL-pay
2. LNDHub `payinvoice` (spend, not this api)
3. `POST /invoices/proof` — preimage (`sha256` = payment hash); the api records the gift for `GET /gifts/stats` and `GET /gifts?day=`. After recording the gift, when the invoice has `messageId` the api inserts a platform-account gift-reply under a top-level post first, then `addSats`. This path does not notify (no in-app rows, no Web Push). When `messageId` is already a reply, it hides a deterministic spend marker and `addSats`s that reply (no nested gift-reply). When the invoice has `groupMessageId`, the api also inserts a platform-account conversation message in the closed Moderators group (text + paid sats, name `21.gifts`) after the triggering group message, at payment time; a missing or mismatched group reference is ignored and does not block the 200. Recorded description is `21gifts moderator` when `groupMessageId` is stored, else `21gifts daily`.

Recurring **USD** gifts are paid by the external spend worker **when the
recipient posts a top-level note with a photo or video**, not on a daily timer, and only when
that recipient is funding-eligible today. `POST /invoices` with `messageId`
requires that photo or video (else 403 `Forum post required`); omitted
`messageId` (moderator stipend) stays any live top-level non-profile post.
`GET /invoices/posted` returns additive `hasMedia` (`hasPosted` unchanged).
`POST /invoices` 403s
`Funding grant required` when not eligible. `GET /invoices/eligible?address=`
is the spend lookup and returns 200 `{ eligible, status }` (`status` is
`effectiveStatus`; unknown/`basis` are `{ eligible: false, status: "none" }`).
`POST /invoices/proof` does not check the grant.
Recurring donor UI is still a sketch. **Do not invent** `/me/donor`,
`/me/recurring`, or scheduler paths. HTTP that exists today is the
spend-worker invoice surface in `SPEC.md`.

---

## 5. Message — **Shipped**

Public comment / encouragement is a v1 surface. The composer POSTs
`{ text }` and/or `{ photo: { contentType, data } }` to `POST /messages`
(requires rules + name + username + Lightning Address — missing requirements are
**409** `missing_requirements`);
a **new top-level** persist pings spend (`POST {SPEND_URL}/ping` with
`{ address, messageId }` and Bearer `SPEND_API_TOKEN`) only when the author
is funding-eligible today and the new row has media (`hasPhoto` /
`hasVideo` / `photoCount > 0`); otherwise log `spend.ping.skipped` /
`not_eligible` or `no_media` and still 200; a **new** top-level media post
from `role === 'verified'` also pings `{ address, messageId, kind: "welcome" }`
independent of `eligibleToday` (Spend pays once lifetime; this API may ping
again; replies / text-only / moderator / founder do not welcome-ping); replies and media replay do
not ping; unset/blank env skips the ping and still returns 200;
the public thread is listed via `GET /messages` (requires rules; newest first, optional `hashtag` query (name without `#`; token filter on `text`), name
snapshotted at post, `sats`, `payable`, `hasPhoto`, and live author `role`
— never photo bytes). Bytes are public `GET /messages/:id/photo` (Nostr `imeta`). Staff hide is a public-API filter **and** a best-effort NIP-09 (`kind: 5`, signed with the note author's custodial nsec) on the durability relay plus the public relay list, plus a best-effort Cloudflare purge of public photo/video URLs. Unsigned/public GET of a hidden row stays 404. A founder/moderator session may GET the hidden row (and photo/video) so the app can show who hid it and when. Hiding a note also retracts in-app notifications whose parent or reply is that note or a direct child. `GET /notifications` drops remaining rows whose parent or reply message is missing or hidden. Operator `GET /debug/messages` (Bearer `DEBUG_TOKEN`) still lists and fetches soft-hidden forum rows and their photo bytes. Restore does not undelete Nostr. The shipped UI
is a messenger-group thread: oldest notes at the top, newest at the bottom,
composer under the newest note. The welcome-forum living-room laws hint is
dismissed via `POST /me/forum-laws-dismissed`. Posts are standalone kind:1
notes (Damus-visible `#bitcoin` / `#21gifts` in content on first sign, plus `#<locationHashtagName>` and a `t` tag when account `location` is non-null (not on the profile note, not kind:0); forum `text` unchanged; pending notes EVENT before any hashtag/photo re-sign so the sign lease cannot starve fan-out);
the worker fans out when `NOSTR_PUBLISH=1`. Pay-on-note is
`POST /messages/:id/invoice` (optional `text` becomes the zap comment). After a
validated kind:9735 is indexed, a payer gift-reply is inserted only when the
paid row is top-level (`parentId` null) and is not the official platform
profile note. A zap on a signed reply credits that
reply and does not nest a gift-reply. Gift-only (empty text) replies are not published to Nostr. Unpaid
posts and replies from `basis` (including the parent author) are **403** until
the author pays 1 sat to 21.gifts (`GET /messages/compose-target` then
`POST /messages/:id/invoice` on the platform profile note). `verified` stays
unpaid-write exempt. A member/invoice zap on that platform note with a comment becomes the
payer’s top-level post (`sats` 0). An external zap on that same note still
inserts a gift-reply under it. The worker always queries that profile
note’s event id, even after the note ages out of `listLatest`. A comment `inReplyTo:<uuid>\n<body>` becomes
a reply on that live top-level parent; a missing, hidden, or nested parent
falls back to a top-level post with the remaining body. An empty comment does
not create a blank living-room post. Extra gifts on someone else’s note still
pay that author. Do not invent `/events` or `/comments` paths.

**External zap → gift reply.** A kind:9735 first credits the addressed member
note under the existing receipt and payment-hash checks. If its embedded
kind:9734 belongs to no account, the api additionally requires the exact
BOLT11 description hash, matching `e` tag, matching optional msat `amount`,
and a valid signature. At least 1 sat records permanent zapper entitlement.
Later zaps from the same pubkey skip the repeated entitlement write through a
per-store process-local lowercase-pubkey memo while keeping the rest of the flow.
Attribution happens before the block check; a blocked payer is then durably
dequeued while retaining the request id. Sats stay credited, nothing is shown,
a later unblock does not resurrect zaps made while blocked. An unblocked,
unreplayed request on a live top-level note then becomes a visible gift-reply
with the external profile-name snapshot, comment, sats, `accountId: null`,
`via: "nostr"`, and no platform Nostr publication. Immediately before creating
that row, after both the account list and relay profile-name lookups resolve,
the payer pubkey is checked again. A block added during either lookup still
wins: the payer is cleared, sats remain credited, and no row is created even
though the post-attribution check passed. Zaps on replies or hidden notes keep
the sats and entitlement but create no row. Replayed requests and receipts
below the external minimum are remembered process-locally per message store,
capped at 10,000 receipt ids by dropping the oldest, so later ticks do not
re-verify their embedded kind:9734 or repeat writes.

On Postgres boot, historical indexed receipts that still lack any payer,
request, or gift-reply attribution are scanned newest-first in 200-row pages.
The scan continues through older receipts with a strict keyset cursor that
advances past every returned row using the last row's immutable ingest
`createdAt` and receipt `eventId`, whether or not the row becomes attributed;
changing membership cannot cause offset-style skips or repeats. It stops after
a short page or a hard 10,000-row ceiling. Equal ingest timestamps are ordered
by receipt event id descending in both message-store implementations. It is
idempotent, and its failure is logged without stopping the rest of boot.

**External reply → visible after first zap.** The inbound reply REQ deliberately
has no `since`. Before entitlement, a kind:1 reply from an unknown pubkey is
silently skipped. Membership, or zapper entitlement plus not-blocked status, is
decided before the event signature check and before event-specific store reads.
On the first worker tick after that pubkey's first verified zap, the same older
event is queried again. A per-store in-flight event-id guard prevents overlapping
ticks from storing it concurrently. Only signed kind:0 profiles up to 64 KiB
can supply its name. Control characters, explicit bidirectional controls, names
without a letter or digit, names mixing more than one of the Latin, Cyrillic
and Greek scripts, names containing a default-ignorable code point (checked on
both the name and its NFKD form), except the ZWNJ/ZWJ joiners and the emoji
variation selectors, which stay allowed, and member or reserved-identity
confusables (by glyph, or by sound for Cyrillic) fall back to the truncated
pubkey. Member-name fold
comparisons require every candidate letter to be ASCII or mapped by the
respective table, so unmapped non-Latin letters do not spuriously collide;
eligible pure non-Latin names remain visible. Name resolution precedes a fresh
single-pubkey block check inside the in-flight guard. A block added
during profile lookup wins before limiter acquisition, consumes no budget, and
the event id is still released.
Per-pubkey and global budget is consumed immediately before the row write and
released if that write fails. It is listed and counted like a member reply, but
public JSON exposes only `via: "nostr"`, never the pubkey. This same
recorded-zapper check also gates every read of an existing row (list, count,
and single-fetch), not just the ingest-time decision to persist a new one —
so a reply row that predates this pubkey's zapper entitlement, or a row from a
pubkey that has never zapped, stays invisible until that check passes, and
`GET /messages/hidden` (staff moderation) is exempt from this read gate. Only
the parent's member author is notified, and only for a numeric event time no
more than one hour old and no more than ten minutes in the future. Missing/non-numeric and
farther-future event times still persist with the existing ingest-time storage
fallback/clamp but do not notify.

**Staff hide → block.** Moderator `DELETE /messages/:id` keeps the
normal target-and-direct-reply soft-hide. When the target itself is external,
it also writes the pubkey kill switch and soft-hides that pubkey's other live
rows. Future external gift-replies and inbound replies are skipped while sats
and zapper entitlement remain. Operator restore removes the block only when
restoring its source message; rows hidden elsewhere by the author-wide cascade
are restored individually. Operator zapper and block lists use timestamp
descending, then pubkey descending, in both memory and Postgres.

Private messaging ships as one PN channel: `GET/POST /conversations` plus
member→platform via `POST /contact`. Inbox threads have per-viewer unread
via `GET /conversations` (per-row `unread` / `unreadMessageCount`; envelope
`unreadCount` is the number of unread threads) and
`POST /conversations/:id/read`. NIP-17 gift wraps and legacy kind:4
inbound; outbound wraps with the sender nsec (platform nsec for staff on
official threads). Forum replies stay on `/messages` and are not mixed
with PNs. Conversation POST may include `{ photo }` / `{ photos }`
(JPEG/PNG/WebP, ≤10, every kind; empty text is allowed only when at least one photo is present). Photo-bearing rows skip Nostr; text-only Direct/Contact/Damus stay pending. Bytes via authenticated GET
`/conversations/:id/messages/:messageId/photo` (photo 0) and
`/conversations/:id/messages/:messageId/photo/:file` (extras 1–9). Lightning gifts in a Direct/Contact thread use
`POST /conversations/:id/invoice` (`{ sats, text? }`). Payment is confirmed
when a matching zap receipt is ingested: the api appends a conversation
message (`text` + `sats`, or empty `text` with `sats` only) and does **not**
credit the counterpart's profile note or insert a forum gift-reply.
`GET /conversations/:id?sinceMessageId=` long-polls until that predetermined
row exists. Damus threads cannot be invoiced.

---

## 6. Contact — **Shipped**

Private mailbox so members can write to 21.gifts without a published email.
Signed-in members POST `{ text }` to `POST /contact` (name snapshot as
forum messages; `normalizeForumText` plus a required 1–500 character body —
forum photo-only empty text does not apply). After the platform account
exists, the contact row is persisted first, then the same text is appended
to the member→platform conversation thread (`GET /conversations`).
Conversation append failure logs `conversations.contact_sync.failed` and
still 200. No platform account → 503 `Platform account is not configured`
(no writes). Operators still read
the legacy mailbox via `GET /debug/contacts` (`DEBUG_TOKEN` must not read
member PNs). No public list, no email delivery. Do not invent `/events`.

---

## 7. Notifications — **Shipped**

Transactional Web Push for signed-in members. The app is installable
(Web App Manifest + service worker). After login the profile card has an
icon-only bell: enable asks the OS permission, then `POST /me/push-subscriptions`.
Disable `DELETE`s the endpoint. `GET /push/vapid-public` is Bearer.

On iPhone Safari the site must be on the Home Screen before the OS will
deliver pushes; the app shows that hint. Android and desktop Chrome do
not need the icon.

The official platform account (`isPlatform`) never fans out living-room post,
reply, or zap notifications (in-app or Web Push). For other member-authored
living-room events, the api writes one in-app row to every account except the
actor, then filters recipients by each account's `notificationLevel`, and
enqueues (does not send inline) one Web Push to every remaining bell subscriber
(an account with at least one `push_subscription`) except the actor. External
replies use the targeted exception below:

- a **forum post** payload when someone else posts (title is the author display name, or Someone when blank; the body is the note text on one line, cut at 180 code points, or the photo/video sentence when the text is empty; `url: /notifications`, `tag: forum_post:<postId>`)
- a **reply** payload when someone replies (title and body follow the post rules; `url: /notifications`, `tag: forum_reply:<replyId>`). Damus-only parents still fan out; a self-reply skips only the actor. That includes an unpaid `POST /messages` reply and an inbound member reply the worker persisted.
- an **external reply** payload only for the parent note's member author, never a broadcast, and only when numeric `created_at` is at most one hour old and no more than ten minutes in the future. Missing/non-numeric, farther-future, and older event times do not notify. Its notification actor and push title stay the generic "Someone", not the reply's own name. The body is the reply text on one line, cut at 180 code points, or the photo/video sentence when the text is empty. The persisted row remains visible in every suppressed-notification case.
- a **zap** payload when a zap receipt is newly indexed (title is the payer name, or Someone when blank; body is `Sent <amount> sats.`; `url: /notifications`, `tag: zap:<id>`). The note author is notified unless they are the payer. A platform-account payer does not notify anyone.

Missing `pushStore` still writes in-app rows. If persist or enqueue
fails, the living-room write still succeeds (HTTP 200 on `POST /messages`;
worker paths log and keep the row).

The in-app Notifications list (`GET /notifications`, mark-read POSTs) is
separate from `/conversations` chat. The list omits rows whose parent or
reply forum message is missing or hidden (`forum_reply` also checks the
child note; `zap` only the parent note). `moderator_appointed` stays. Post, reply, and zap pushes open
`/notifications`. A new inbound private message enqueues Web Push
`/messages?c=` (bell subscribers only); badge `unreadCount` is
notification unread plus listed inbox unread.

The worker sends when VAPID is configured. On outbox retry it does not re-send
an endpoint that already succeeded for that outbox row. Open focused tabs skip
a second banner (service worker). Owners set one of three levels via POST /me/notification-level (`all` default = current behaviour; `active` = related top-level post sats>0, zaps also when amountSats>0; `mentions` = staff/platform actor or reply/zap on the recipient's own note). Filter applies to in-app writes, Web Push, and `GET /notifications` (list + unreadCount).

HTTP cited: `/push/vapid-public`, `/me/push-subscriptions`, `/me/notification-level`, `/debug/push-ping`,
`/notifications`, `/notifications/read-all`, `/notifications/:id/read`.

---

## Out of these seven journeys

Explicitly not journeys in this file:

- Moderator actions
- NIP-05 badge
- Passkey / non-custodial key material
- Categories and search
