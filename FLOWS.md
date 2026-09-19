# 21.gifts — Core UI Flows

> Screen-by-screen sketch of the five journeys named in CONCEPT next-step 7,
> plus the shipped in-app contact mailbox (journey 6) and in-app Notifications
> plus Web Push (journey 7).
> Product decisions live in [`CONCEPT.md`](./CONCEPT.md). Implemented HTTP
> contracts live in [`SPEC.md`](./SPEC.md). This file **does not invent HTTP
> paths, JSON fields, or status codes**. When a journey has no route in
> `SPEC.md`, say so and stop.

**Status**: living document. Last revised 2026-09-16.

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

Login is passkey-only. LNURL-auth has been removed.

The signed-in view currently lives on `/login` — there is no separate
`/profile` route yet. It shows a name form, a Lightning Address form, and
**Sign out**. Name and Lightning Address are each skippable via
`POST /me/setup/skip`; living-room rules stay required.

After name/skip and address/skip, the app records living-room rules agreement
via `POST /me/rules-agreement`. `GET /me` carries `setup` (wizard; skip counts
as done), `missing` (facts; skip does not), and `rulesAgreedAt` (epoch ms of
the first agreement, or `null`).

No email, no password. Losing the passkey (and platform sync) loses the
account.

HTTP cited: `/auth/passkey/register/begin`, `/auth/passkey/register/finish`,
`/auth/passkey/authenticate/begin`, `/auth/passkey/authenticate/finish`,
`/me`, `/me/setup/skip`, `/me/name`, `/me/rules-agreement`.

---

## 2. Profile — **Shipped** (address, name) + **Sketch** (photo / story)

### Address — **Shipped**

Every account can receive. From the signed-in view the user can link, replace,
or unlink a LUD-16 Lightning Address:

- `POST /me/lightning-address` — link or replace after a live well-known
  resolve that requires zap metadata (`allowsNostr` + `nostrPubkey`). Always
  leaves the address **unverified**. Unreachable or non-zap addresses are
  rejected and not stored.
- `DELETE /me/lightning-address` — unlink (also clears the LN skip timestamp
  so `setup` returns to `lightning-address` when a name is set or name-skipped)

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
3. `POST /invoices/proof` — preimage (`sha256` = payment hash); the api records the gift for `GET /gifts/stats` and `GET /gifts?day=`. After recording the gift, when the invoice has `messageId` the api inserts a platform-account gift-reply under a top-level post first, then `addSats`. When `messageId` is already a reply, it hides a deterministic spend marker and `addSats`s that reply (no nested gift-reply)

Recurring **USD** gifts are paid by the external spend worker **when the
recipient posts a top-level note**, not on a daily timer. Invoice HTTP
(`POST /invoices` / `POST /invoices/proof`) is unchanged. Recurring donor UI
is still a sketch. **Do not invent** `/me/donor`, `/me/recurring`, or
scheduler paths. HTTP that exists today is only the spend-worker invoice
pair above (`SPEC.md`).

---

## 5. Message — **Shipped**

Public comment / encouragement is a v1 surface. The composer POSTs
`{ text }` and/or `{ photo: { contentType, data } }` to `POST /messages`
(requires rules + name + Lightning Address — missing requirements are
**409** `missing_requirements`);
a **new top-level** persist pings spend (`POST {SPEND_URL}/ping` with
`{ address, messageId }` and Bearer `SPEND_API_TOKEN`); replies and media replay do
not ping; unset/blank env skips the ping and still returns 200;
the public thread is listed via `GET /messages` (requires rules; newest first, name
snapshotted at post, `sats`, `payable`, `hasPhoto`, and live author `role`
— never photo bytes). Bytes are public `GET /messages/:id/photo` (Nostr `imeta`). Staff hide is a public-API filter **and** a best-effort NIP-09 (`kind: 5`, signed with the note author's custodial nsec) on the durability relay plus the public relay list, plus a best-effort Cloudflare purge of public photo/video URLs; operator `GET /debug/messages` (Bearer `DEBUG_TOKEN`) still lists and fetches soft-hidden forum rows and their photo bytes. Restore does not undelete Nostr. The shipped UI
is a messenger-group thread: oldest notes at the top, newest at the bottom,
composer under the newest note. The welcome-forum living-room laws hint is
dismissed via `POST /me/forum-laws-dismissed`. Posts are standalone kind:1
notes (Damus-visible `#bitcoin` / `#21gifts` in content on first sign, plus `#<locationHashtagName>` and a `t` tag when account `location` is non-null (not on the profile note, not kind:0); forum `text` unchanged; pending notes EVENT before any hashtag/photo re-sign so the sign lease cannot starve fan-out);
the worker fans out when `NOSTR_PUBLISH=1`. Pay-on-note is
`POST /messages/:id/invoice` (optional `text` becomes the zap comment). After a
validated kind:9735 is indexed, a payer gift-reply is inserted only when the
paid row is top-level (`parentId` null). A zap on a signed reply credits that
reply and does not nest a gift-reply. Gift-only (empty text) replies are not published to Nostr. Unpaid
replies from `basis` (not the parent author) are **403**; `verified` stays
unpaid-reply exempt. Do not invent `/events` or `/comments` paths.

**External zap → gift reply.** A kind:9735 first credits the addressed member
note under the existing receipt and payment-hash checks. If its embedded
kind:9734 belongs to no account, the api additionally requires the exact
BOLT11 description hash, matching `e` tag, matching optional msat `amount`,
and a valid signature. At least 1 sat records permanent zapper entitlement.
An unblocked, unreplayed request on a live top-level note then becomes a
visible gift-reply with the external profile-name snapshot, comment, sats,
`accountId: null`, `via: "nostr"`, and no platform Nostr publication. Zaps on
replies or hidden notes keep the sats and entitlement but create no row.

**External reply → visible after first zap.** The inbound reply REQ deliberately
has no `since`. Before entitlement, a kind:1 reply from an unknown pubkey is
silently skipped. Membership, or zapper entitlement plus not-blocked status, is
decided before the event signature check and before event-specific store reads.
On the first worker tick after that pubkey's first verified zap, the same older
event is queried again. A per-store in-flight event-id guard prevents overlapping
ticks from storing it concurrently. Only signed kind:0 profiles up to 64 KiB
can supply its name; name resolution precedes limiter acquisition. Per-pubkey
and global budget is consumed immediately before the row write and released if
that write fails. It is listed and counted like a member reply, but public JSON
exposes only `via: "nostr"`, never the pubkey. Only the parent's member author is
notified, and only for an event no more than one hour old.

**Staff hide → block.** Founder/moderator `DELETE /messages/:id` keeps the
normal target-and-direct-reply soft-hide. When the target itself is external,
it also writes the pubkey kill switch and soft-hides that pubkey's other live
rows. Future external gift-replies and inbound replies are skipped while sats
and zapper entitlement remain. Operator restore removes the block only when
restoring its source message; rows hidden elsewhere by the author-wide cascade
are restored individually.

Private messaging ships as one PN channel: `GET/POST /conversations` plus
member→platform via `POST /contact`. Inbox threads have per-viewer unread
via `GET /conversations` (`unread` / `unreadCount`) and
`POST /conversations/:id/read`. NIP-17 gift wraps and legacy kind:4
inbound; outbound wraps with the sender nsec (platform nsec for staff on
official threads). Forum replies stay on `/messages` and are not mixed
with PNs. Lightning gifts in a Direct/Contact thread use
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

For member-authored living-room events, the api writes one in-app row to every
account except the actor, then filters recipients by each account's
`notificationLevel`, and enqueues (does not send inline) one Web Push to every
remaining bell subscriber (an account with at least one `push_subscription`)
except the actor. External replies use the targeted exception below:

- a **forum post** payload when someone else posts (`title` New post on 21.gifts, `url: /notifications`, `tag: forum_post:<postId>`)
- a **reply** payload when someone replies (`title` New reply on 21.gifts, `url: /notifications`, `tag: forum_reply:<replyId>`). Damus-only parents still fan out; a self-reply skips only the actor. That includes an unpaid `POST /messages` reply and an inbound member reply the worker persisted.
- an **external reply** payload only for the parent note's member author, never a broadcast, and only when the inbound event is at most one hour old. Its notification actor is the generic "Someone", not the reply's own name. The persisted row remains visible when older.
- a **zap** payload when a zap receipt is newly indexed (`title` Bitcoin on 21.gifts, `body` Someone sent sats., `url: /notifications`, `tag: zap:<id>`). The note author is notified unless they are the payer.

Missing `pushStore` still writes in-app rows. If persist or enqueue
fails, the living-room write still succeeds (HTTP 200 on `POST /messages`;
worker paths log and keep the row).

The in-app Notifications list (`GET /notifications`, mark-read POSTs) is
separate from `/conversations` chat. Post, reply, and zap pushes open
`/notifications`. A new inbound private message enqueues Web Push
`/messages?c=` (bell subscribers only); badge `unreadCount` is
notification unread plus listed inbox unread.

The worker sends when VAPID is configured. On outbox retry it does not re-send
an endpoint that already succeeded for that outbox row. Open focused tabs skip
a second banner (service worker). Owners set one of three levels via POST /me/notification-level (`all` default = current behaviour; `active` = related top-level post sats>0, zaps also when amountSats>0; `mentions` = staff/platform actor or reply/zap on the recipient's own note). Filter applies to in-app and Web Push. GET /notifications lists stored rows unfiltered.

HTTP cited: `/push/vapid-public`, `/me/push-subscriptions`, `/me/notification-level`, `/debug/push-ping`,
`/notifications`, `/notifications/read-all`, `/notifications/:id/read`.

---

## Out of these seven journeys

Explicitly not journeys in this file:

- Moderator actions
- NIP-05 badge
- Passkey / non-custodial key material
- Categories and search
