# 21.gifts — Core UI Flows

> Screen-by-screen sketch of the five journeys named in CONCEPT next-step 7.
> Product decisions live in [`CONCEPT.md`](./CONCEPT.md). Implemented HTTP
> contracts live in [`SPEC.md`](./SPEC.md). This file **does not invent HTTP
> paths, JSON fields, or status codes**. When a journey has no route in
> `SPEC.md`, say so and stop.

**Status**: living document. Last revised 2026-08-23.

---

## How to read this file

| Label       | Meaning                                                                                |
| ----------- | -------------------------------------------------------------------------------------- |
| **Shipped** | Exists in `21gifts/app` and/or this api today; HTTP only as already named in `SPEC.md` |
| **Sketch**  | Decided v1 UX from `CONCEPT.md`; no UI and no HTTP yet. Headings here are not routes.  |

Users are never asked about keys, relays, or NOSTR jargon on any screen. The
product stays warm and direct — people helping people.

---

## 1. Sign-in — **Shipped** (API) / **Sketch** (app passkey CTA)

The landing page at `/` is the marketing site (pitch, how-it-works, FAQ) with
**Log in** / **Ask for help** to `/login` and **Send help** to `/donate`.
`/login` is the sign-in surface (`LoginCard`). The LUD-04 callback host is
the public apex (`21.gifts` / `dev.21.gifts`). Passkey RP ID is
`WEBAUTHN_RP_ID`.

On mount the app rehydrates a persisted session token via `GET /me`. A **401**
clears the token; a transient failure does not.

**Passkey (first login, HTTP shipped)**

1. App calls `POST /auth/passkey/register/begin` (new account) or
   `POST /auth/passkey/authenticate/begin` (returning).
2. Browser runs `navigator.credentials.create` / `get` with the returned
   `options` (no WebAuthn library in the app).
3. App posts the credential to the matching `…/finish` with the page
   `Origin`. The api verifies and returns `{ token, account }` immediately.

**LNURL-auth (parallel namespace, still shipped)**

1. App calls `GET /auth/lnurl` and shows a QR of the uppercased `lnurl` plus
   a `lightning:` deep link. The poll token is **never** put in the QR.
2. App polls `GET /auth/session` with `X-Poll-Token`.
3. The wallet signs `k1` at `GET /auth/lnurl/callback` (wallet-facing;
   LUD-04 **200** + `status`).
4. Poll returns `pending` / `expired` / `used` / `authenticated` as in
   `SPEC.md`. On `authenticated`, the app stores the session and sends
   `Authorization: Bearer` on subsequent calls.

The signed-in view currently lives on `/login` — there is no separate
`/profile` route yet. It shows a shortened `linkingKey` when one is present,
a name form, a Lightning Address form, and **Sign out**.

Passkey and LNURL accounts are not merged. No email, no password. Losing the
passkey (and platform sync) or the wallet still loses that namespace.

HTTP cited: `/auth/passkey/register/begin`, `/auth/passkey/register/finish`,
`/auth/passkey/authenticate/begin`, `/auth/passkey/authenticate/finish`,
`/auth/lnurl`, `/auth/lnurl/callback`, `/auth/session`, `/me`, `/me/name`.

---

## 2. Profile — **Shipped** (address, name) + **Sketch** (photo / story)

### Address — **Shipped**

Every account can receive. From the signed-in view the user can link, replace,
or unlink a LUD-16 Lightning Address:

- `POST /me/lightning-address` — link or replace (always leaves the address
  **unverified**)
- `DELETE /me/lightning-address` — unlink

The **verified** badge is proof-of-control:

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

---

## 3. Donate — **Sketch** (button / browser pay) + **Shipped** (resolve)

Guest / one-off giving: the donor clicks **Donate** on a receiver and pays
through browser LNURL-pay (resolve the Lightning Address → invoice → wallet
pays). The api is **not** in the payment path. This works without an account
(CONCEPT Donations).

Public `GET /lightning-address` now resolves and caches LUD-16 metadata
(callback, min/max sendable, optional commentAllowed). There is still no
Donate button and the api still does not fetch or pay the gift invoice.

There is no campaign feed and no Donate button in the app today. Do not invent
`/feed` or `/campaigns` paths.

HTTP cited: `/lightning-address`, `/gifts/stats` (see `SPEC.md`).

Public gift totals are **Shipped** as `GET /gifts/stats` (amounts, UTC
spend-over-time, per person, per month). No invoices. The app statistics
page consumes that route.

Optional NIP-57 Zap receipts stay deferred (CONCEPT Out).

---

## 4. Recurring gifts — **Sketch**

**Prerequisite**: paying is out of this process. The external spend
worker holds lightning.space LNDHub credentials and calls:

1. `POST /invoices` — this api fetches the BOLT11 from the recipient via LNURL-pay
2. LNDHub `payinvoice` (spend, not this api)
3. `POST /invoices/proof` — preimage (`sha256` = payment hash)

Recurring **daily** gifts as fixed **USD** amounts and the donor UI are still
a sketch. **Do not invent** `/me/donor`, `/me/recurring`, or scheduler paths.
HTTP that exists today is only the spend-worker invoice pair above (`SPEC.md`).

---

## 5. Message — **Sketch**

Public comment / encouragement is a v1 surface: a composer POSTs to the api;
v1 signs server-side with the account's custodial key (`kind:1` reply). **No
HTTP and no composer UI today.** Do not invent `/events` or `/comments`
paths.

Private donor↔receiver DMs (NIP-17) are **out of v1** (CONCEPT deferred). Do
not sketch a DM inbox as if it ships in v1.

---

## Out of these five journeys

Explicitly not journeys in this file:

- Moderator actions
- NIP-05 badge
- Passkey / non-custodial key material
- Categories and search
