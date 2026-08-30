# 21.gifts — Core UI Flows

> Screen-by-screen sketch of the five journeys named in CONCEPT next-step 7,
> plus the shipped in-app contact mailbox (journey 6) and Web Push (journey 7).
> Product decisions live in [`CONCEPT.md`](./CONCEPT.md). Implemented HTTP
> contracts live in [`SPEC.md`](./SPEC.md). This file **does not invent HTTP
> paths, JSON fields, or status codes**. When a journey has no route in
> `SPEC.md`, say so and stop.

**Status**: living document. Last revised 2026-08-30.

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
**Sign out**.

After name and address, the app records living-room rules agreement via
`POST /me/rules-agreement`. `GET /me` carries `rulesAgreedAt` (epoch ms of
the first agreement, or `null`).

No email, no password. Losing the passkey (and platform sync) loses the
account.

HTTP cited: `/auth/passkey/register/begin`, `/auth/passkey/register/finish`,
`/auth/passkey/authenticate/begin`, `/auth/passkey/authenticate/finish`,
`/me`, `/me/name`, `/me/rules-agreement`.

---

## 2. Profile — **Shipped** (address, name) + **Sketch** (photo / story)

### Address — **Shipped**

Every account can receive. From the signed-in view the user can link, replace,
or unlink a LUD-16 Lightning Address:

- `POST /me/lightning-address` — link or replace after a live well-known
  resolve that requires zap metadata (`allowsNostr` + `nostrPubkey`). Always
  leaves the address **unverified**. Unreachable or non-zap addresses are
  rejected and not stored.
- `DELETE /me/lightning-address` — unlink

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

### Identity copy — **Shipped** (name) + **Sketch** (photo / story)

Receiver name is stored on the account (`POST /me/name`). Photo and story
will become custodial `kind:0` metadata signed server-side. **No HTTP for
photo/story yet**. Do not invent `POST /me/profile`.

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

Public gift totals are **Shipped** as `GET /gifts/stats` (sats, BTC, and
historical USD at each gift's UTC-day Coinbase BTC-USD close; UTC
spend-over-time, per person, per month). Individual gifts for one UTC day
are **Shipped** as `GET /gifts?day=YYYY-MM-DD`. No invoices. The app
statistics page and `/stats/{day}` consume those routes.

Optional NIP-57 Zap receipts stay deferred (CONCEPT Out).

---

## 4. Recurring gifts — **Sketch**

**Prerequisite**: paying is out of this process. The external spend
worker holds lightning.space LNDHub credentials and calls:

1. `POST /invoices` — this api fetches the BOLT11 from the recipient via LNURL-pay
2. LNDHub `payinvoice` (spend, not this api)
3. `POST /invoices/proof` — preimage (`sha256` = payment hash); the api records the gift for `GET /gifts/stats` and `GET /gifts?day=`

Recurring **daily** gifts as fixed **USD** amounts and the donor UI are still
a sketch. **Do not invent** `/me/donor`, `/me/recurring`, or scheduler paths.
HTTP that exists today is only the spend-worker invoice pair above (`SPEC.md`).

---

## 5. Message — **Shipped**

Public comment / encouragement is a v1 surface. The composer POSTs
`{ text }` and/or `{ photo: { contentType, data } }` to `POST /messages`;
the public thread is listed via `GET /messages` (newest first, name
snapshotted at post, `sats`, `payable`, `hasPhoto`, and live author `role`
— never photo bytes). Bytes are public `GET /messages/:id/photo` (Nostr `imeta`). The shipped UI
is a messenger-group thread: oldest notes at the top, newest at the bottom,
composer under the newest note. The welcome-forum living-room laws hint is
dismissed via `POST /me/forum-laws-dismissed`. Posts are standalone kind:1
notes (Damus-visible `#bitcoin` / `#21gifts` in content on first sign; forum `text` unchanged; pending notes EVENT before any hashtag/photo re-sign so the sign lease cannot starve fan-out);
the worker fans out when `NOSTR_PUBLISH=1`. Pay-on-note is
`POST /messages/:id/invoice`. Do not invent `/events` or `/comments` paths.

Private messaging ships as one PN channel: `GET/POST /conversations` plus
member→platform via `POST /contact`. NIP-17 gift wraps and legacy kind:4
inbound; outbound wraps with the sender nsec (platform nsec for staff on
official threads). Forum replies stay on `/messages` and are not mixed
with PNs.

---

## 6. Contact — **Shipped**

Private mailbox so members can write to 21.gifts without a published email.
Signed-in members POST `{ text }` to `POST /contact` (name snapshot as
forum messages; `normalizeForumText` plus a required 1–500 character body —
forum photo-only empty text does not apply). The same text is appended to
the member→platform conversation thread (`GET /conversations`). No platform
account → 503 `Platform account is not configured`. Operators still read
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

The api enqueues (does not send inline):

- a **forum** payload when someone else posts (`tag: forum`)
- a **zap** payload when a zap receipt is newly indexed onto the author's note

The worker sends when VAPID is configured. On outbox retry it does not re-send
an endpoint that already succeeded for that outbox row. Open focused tabs skip
a second banner (service worker). Do not invent preference HTTP in v1.

HTTP cited: `/push/vapid-public`, `/me/push-subscriptions`, `/debug/push-ping`.

---

## Out of these seven journeys

Explicitly not journeys in this file:

- Moderator actions
- NIP-05 badge
- Passkey / non-custodial key material
- Categories and search
