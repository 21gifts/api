# 21.gifts — Core UI Flows

> Screen-by-screen sketch of the five journeys named in CONCEPT next-step 7.
> Product decisions live in [`CONCEPT.md`](./CONCEPT.md). Implemented HTTP
> contracts live in [`SPEC.md`](./SPEC.md). This file **does not invent HTTP
> paths, JSON fields, or status codes**. When a journey has no route in
> `SPEC.md`, say so and stop.

**Status**: living document. Last revised 2026-08-22.

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
`/login` is the LNURL-auth surface (`LoginCard`). The LUD-04 callback host
is the public apex (`21.gifts` / `dev.21.gifts`).

On mount the app rehydrates a persisted session token via `GET /me`. A **401**
clears the token; a transient failure does not.

**Steps**

1. App calls `GET /auth/lnurl` and shows a QR of the uppercased `lnurl` plus
   a `lightning:` deep link. The poll token is **never** put in the QR.
2. App polls `GET /auth/session` with `X-Poll-Token`.
3. The wallet signs `k1` at `GET /auth/lnurl/callback` (wallet-facing;
   LUD-04 **200** + `status`).
4. Poll returns `pending` / `expired` / `used` / `authenticated` as in
   `SPEC.md`. On `authenticated`, the app stores the session and sends
   `Authorization: Bearer` on subsequent calls.

The signed-in view currently lives on `/login` — there is no separate
`/profile` route yet. It shows a shortened `linkingKey`, a Lightning Address
form, and **Sign out**.

Auth is LNURL-auth only. No email, no password, no passkey. Losing the wallet
or a linking-key change is unrecoverable in v1 (CONCEPT accepted trade-off) —
there is no recovery screen.

HTTP cited: `/auth/lnurl`, `/auth/lnurl/callback`, `/auth/session`, `/me`.

---

## 2. Profile — **Shipped** (address) + **Sketch** (identity copy)

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

There is no name, photo, or story editor in the app today.

### Identity copy — **Sketch**

Receiver profile UI will add name, photo, and story. In v1 those become
custodial `kind:0` metadata signed server-side. **No HTTP for this yet**; it
lands in the PR that implements it. Do not invent `POST /me/profile` or any
other path.

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

HTTP cited: `/lightning-address` (see `SPEC.md`).

Optional NIP-57 Zap receipts stay deferred (CONCEPT Out).

---

## 4. Recurring gifts — **Sketch**

**Prerequisite**: the donor upgrades by depositing a `lndhub://` export
restricted to `lightning.space` (custodial v1 compromise). Account-stored
credentials are **not** wired; **no HTTP**.

The fail-closed payout **worker** is in-process: operator env
(`LNDHUB_*`, `DAILY_GIFTS_RECIPIENTS` as USD JSON, `DAILY_GIFTS_LOG_PATH`)
starts a scheduler at 20:00 Europe/Zurich. It resolves each LUD-16 address,
converts USD → sats via Kraken (fail-closed corridor), decode-checks the
invoice amount, and pays via LNDHub. Per-day idempotency, uncertain
outcomes quarantined, balance preflight, and a daily USD cap apply
(CONCEPT). **No HTTP, no UI today.** Do not invent `/me/donor`,
`/me/recurring`, or scheduler paths.

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
