# 21.gifts — Concept

> Peer-to-peer donation platform. Direct human-to-human giving over Bitcoin
> Lightning, with NOSTR as the invisible communication substrate.

**Status**: draft, in active iteration. Last revised 2026-08-29.

---

## Vision

Help people in difficult situations by enabling **direct gifts** from one human
to another — without any organizational middleman taking a cut, gatekeeping, or
politicizing the flow of help.

Bitcoin Lightning is the only payment rail. NOSTR is the only message rail.
Both are plumbing — the user just sees a website where they can ask for help
or send help.

---

## Core Principles

1. **Non-profit** — the platform itself earns nothing beyond what it costs to operate
2. **Truly P2P** — funds flow donor → receiver directly; the platform never custodies money
3. **Open protocol** — anyone can build a client; the website is one reference implementation
4. **NOSTR-native, NOSTR-invisible** — every message in the UI is also a NOSTR event,
   visible in Damus/Amethyst/etc., but the user is never asked about keys or relays
5. **Self-sovereign keys** — Passkey + PRF derives the NOSTR key client-side; the
   server never sees raw key material
6. **Lightning Address mandatory** — receivers must have a LUD-16 address; no custodial wallets
7. **English only** — UI, copy, code, docs, and commits are all in English. No
   multi-language support in v1. Internationalization is explicitly out of scope.
8. **Thin client, thick server** — the browser holds only what _must_ be
   client-side (keys, signing, wallet flow). Everything else — relay
   communication, indexing, discovery, LN-Address resolution, anti-abuse —
   lives in the backend API. The app bundle stays tiny.

---

## v1 Transitional Model (decided 2026-07-05)

v1 ships with a deliberately simplified account and custody model so the
platform can go live and be dogfooded. It deviates from Core Principle 2 on
the donor's **sending** side (custodial LNDHub spending) and from Core
Principle 5 for **all** v1 accounts (no client-side keys; each account's
NOSTR identity is custodial, held and used for signing server-side — see
"NOSTR in v1" below). Both deviations are transitional
and will be replaced by a non-custodial setup. Receiving stays non-custodial
(LUD-16 only, as before).

### Roles

| Role      | Capabilities                                                                     |
| --------- | -------------------------------------------------------------------------------- |
| Basis     | Log in, maintain a profile, receive gifts (every account can receive by default) |
| Moderator | Basis, plus extended permissions for content moderation                          |

Becoming a **donor** is an upgrade available to every account, not a role of
its own (see below).

### Login: passkey only

- **Passkey (WebAuthn) is the only login method.** No email, no password, no
  LNURL-auth. The browser creates or asserts a discoverable credential; the
  api issues a bearer session immediately. Account identity is `account.id`.
- **Accepted trade-off**: if the user loses the passkey and any platform
  sync, the account is unrecoverable. LNURL-auth was removed (2026-08-24);
  leftover `account.linking_key` values are historical and cannot log in.
- WebAuthn RP ID is `WEBAUTHN_RP_ID` (`21.gifts` / `dev.21.gifts`). Missing
  RP ID → passkey routes 500; the process still boots.

### Donor upgrade (custodial, v1 only)

Any account can additionally become a donor and spend money:

- Recurring paying uses an **external spend worker** with a
  `lightning.space` LNDHub wallet. This api does not store LNDHub
  credentials and does not pay.
- The api issues recipient BOLT11 invoices (`POST /invoices`) and verifies
  the payment preimage (`POST /invoices/proof`). A matching proof records
  the outbound gift for public `GET /gifts/stats`.
- This remains a v1 custody compromise (the worker can spend), documented
  because it contradicts the non-custodial target; that replacement retires
  it.

### Receiver address verification

A receiver's Lightning Address is entered free-form on sign-up (a wrong
address is self-punishing — gifts simply go elsewhere). The **verified
badge** requires proof of control via micro-payment: the api pays 1 sat (or
the provider's `minSendable` if higher, capped at 10 sat) with a one-time
nonce in the LNURL-pay comment (LUD-12; Wallet of Satoshi allows 255
characters); the user reads the nonce from the wallet's transaction history
and enters it in the app (`POST /me/lightning-address/verification` +
`…/confirm`). No LNDHub payer is wired yet — start returns 503 until one is
injected; the process still boots. No LUD-21 dependency — WoS does not
implement LNURL-verify.

### Recurring gifts (v1 feature)

Donors can configure recurring daily gifts: fixed USD amounts to a list of
recipients. This api does not pay. It issues BOLT11 invoices
(`POST /invoices`, LNURL-pay to the recipient) and verifies the payment
preimage (`POST /invoices/proof`). A matching proof records the outbound
gift for public `GET /gifts/stats`. An external worker holds lightning.space
LNDHub credentials, pays, and submits the proof. Payout semantics on that
worker are fail-closed: per-day idempotency log, ambiguous outcomes
quarantined as "uncertain" and never auto-retried the same day, balance
preflight before the first payment, and a per-donor daily cap. Recurring
donor UI and an in-process scheduler are not HTTP yet.

### NOSTR in v1

Passkey login without PRF provides no client-side NOSTR key, so v1 runs NOSTR **fully
custodially** (decided 2026-07-05, resolves Open Question #9): on sign-up the
api generates a NOSTR keypair for the account, stores the `nsec` encrypted at
rest, and signs that account's events server-side with the account's own key.
Every profile, campaign, and comment therefore appears on the public NOSTR
network under the user's own `npub` — attribution stays per-user, and
external clients (Damus, Amethyst, …) see ordinary per-identity events.
User-owned keys (Passkey + PRF → NIP-06) arrive with the non-custodial phase;
the custodial-to-user-owned migration path is the remaining open part of
Open Question #9.

---

## Architecture

### Identity & Keys

> **Post-v1 target architecture.** v1 login is passkey without PRF, so there is
> no client-side key material — see "v1 Transitional Model" above. Everything in
> this section describes the non-custodial phase that replaces it.

The full key flow, end-to-end:

```
WebAuthn Passkey (PRF extension)
        │
        ▼  prf.eval.first(SHA-256("21gifts-nostr-v1"))
   PRF output (32 bytes, deterministic from Secure Enclave)
        │
        ▼  HKDF-SHA256(salt="21gifts-seed-derivation", info="mnemonic-v1")
   128 bits of entropy
        │
        ▼  BIP-39
   12-word mnemonic
        │
        ▼  BIP-39 seed → BIP-32 master
   BIP-32 derivation at m/44'/1237'/0'/0/0   (NIP-06 path, 1237 = NOSTR slip-44)
        │
        ▼
   32-byte secp256k1 private key (NOSTR nsec)
        │
        ▼  schnorr_pubkey
   NOSTR npub
```

**Key design choices** — directly modeled after the zkCoins app passkey module:

- **PRF salt is cached** — `SHA-256("21gifts-nostr-v1")` computed once per session
  and reused so all PRF evaluations yield the same deterministic output
- **Domain-separated HKDF** — different `info` tags for different uses (mnemonic
  derivation, AES key derivation, future expansion). Same PRF output, different
  outputs by purpose.
- **Versioning** — `DERIVATION_VERSION = "v1"` stored alongside the credential.
  Future versions can derive in parallel for migration.
- **Hard-fail on missing PRF** — no silent fallback to a weaker scheme. If the
  authenticator doesn't expose PRF, the user is told to use a supported device.
- **Address in cleartext for the locked view** — public NOSTR pubkey stored
  unencrypted so the locked UI can display "this is your wallet" without
  requiring authentication.

**Why NIP-06 (BIP-39 mnemonic in the middle) instead of `PRF → HKDF → nsec` directly?**

- User-readable 12-word backup (familiar to anyone who has used a Bitcoin wallet)
- Cross-client compatibility — Damus, Amethyst, and all NOSTR clients that
  implement NIP-06 can import the same mnemonic and recover the same identity
- Future-proof — the same mnemonic can derive other keys (LN, BTC) later if the
  scope grows, without breaking the existing identity
- Matches the architecture of related projects in the same stack, minimizing
  mental overhead

**Recovery paths**:

1. Platform Passkey sync — iCloud Keychain, Google Password Manager, 1Password,
   Bitwarden, hardware authenticator with sync
2. Optional explicit 12-word backup, shown once on sign-up, never sent to the server

**The server never holds the nsec.** All NOSTR signing happens in the browser.

### Browser support for WebAuthn PRF (as of 2026)

| Platform / Authenticator  | PRF Support              |
| ------------------------- | ------------------------ |
| iOS / macOS Safari 18+    | ✅                       |
| Chrome on macOS/iOS       | ✅                       |
| Edge (Chromium)           | ✅                       |
| Android Chrome 132+       | ✅                       |
| 1Password 8+              | ✅                       |
| Bitwarden                 | ✅                       |
| YubiKey 5 (firmware 5.7+) | ✅                       |
| Firefox                   | partial — lagging behind |

Unsupported-tail handling is deferred with Open Question #1 to the
non-custodial phase (this table, like the rest of this section, is post-v1).

### Donations

- Receiver profile **must** include a Lightning Address (LUD-16)
- The api resolves and caches LUD-16 metadata server-side, with health checks
- Donor flow in the browser: click _Donate_ → app reads cached LN-Address from
  api → browser fetches LNURL-pay callback → invoice → pay (browser ↔ wallet
  provider directly, the api is not in the payment path)
- In this browser flow the api never sees the invoice, the amount, the payer,
  or the funds
- **v1 addition** (see "v1 Transitional Model"): recurring gifts are paid by
  an external spend worker via lightning.space LNDHub. This api only fetches
  the invoice and verifies the preimage — it is not in the LNDHub pay path.
  The browser flow above remains for guests and one-off gifts.
- Optional: **NIP-57 Zap receipts** published to NOSTR for transparent acknowledgements

### Communication

Every "message" the user writes in the UI is a NOSTR event. (v1 note: NOSTR
is fully custodial in v1 — the api holds one keypair per account and signs
events server-side with the account's own key, see "NOSTR in v1". The table
below applies to v1 for the surfaces v1 ships — profile metadata, campaign
post, public comment; the DM and Zap-receipt rows stay deferred, see MVP
scope. The client-side-signing flow beneath it is target state.)

| UI surface                            | NOSTR primitive                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| Profile metadata (name, photo, story) | `kind:0` (NIP-01 metadata)                                                                   |
| Receiver profile / campaign post      | `kind:1` (text note), tagged with campaign metadata                                          |
| Public comment / encouragement        | top-level `kind:1` (frozen `t=bitcoin` / `t=21gifts` / `r=https://21.gifts`; no `e`/`p`/`q`) |
| Private message donor ↔ receiver      | `kind:14` (NIP-17 sealed DM, modern) or `kind:4` (legacy)                                    |
| Donation acknowledgement              | `kind:9735` Zap receipt (when NIP-57 enabled)                                                |

**Flow** — the app does not talk to NOSTR relays directly. It talks to the
backend API, which acts as the user's edge to the network:

```
app  ──signed event──→  api  ──fan-out──→  relays (public NOSTR network)
                                          (Damus, Amethyst, etc. observe)

app  ←──indexed feed──  api  ←──subscribe──  relays
```

- The app signs every event client-side with the PRF-derived key
- The app POSTs the signed event to the api
- The api verifies the signature, applies anti-abuse filters, then fans out to
  the configured relay set
- For reading, the api maintains an indexed view aggregated from the relay set
  and exposes simple REST/GraphQL endpoints — the app fetches one paginated
  resource, not raw relay traffic
- Default relay set is configured server-side; users can opt into a "raw mode"
  later (deferred) where the app talks to relays directly with the same key
- Private DMs (NIP-17) pass through the api as opaque encrypted payloads — the
  api never sees plaintext

### Public member forum (v1)

The `/messages` thread is a **forum / messenger group**, not a social-media
feed. Visitors read it top-to-bottom like a group chat: oldest notes at the
top, newest at the bottom, composer under the newest note. A new post is
inserted at the bottom. `GET /messages` still returns the latest 200 notes
newest-first so the window is "what is recent"; every client reverses that
array for display.

### Trust & Verification

**Protocol level**: completely open. Anyone publishes. Trust emerges from NOSTR
reputation (who follows / vouches for whom).

**Website level**: stricter, to protect donors from obvious scams:

- NIP-05 verification (optional, badged)
- Profile completeness (story, photo, LN-Address resolves successfully)
- Community vouching (other NOSTR identities sign off)
- No KYC, no government ID

(v1 note: NIP-05 badging and NOSTR-identity vouching are post-v1 — v1 NOSTR
identities are custodial, server-held. The v1 verified badge is proof of
Lightning-Address control via micro-payment nonce, see "Receiver address
verification".)

The website is **not a gatekeeper** — it's a curator with transparent rules. If
a receiver doesn't meet website requirements, they can still use a different
client on the same protocol.

### Backend (`api`)

Central to the architecture from day one. Holds the project's canonical
documentation, schema, and protocol. The app is just one client of this api;
other clients (mobile apps, third-party reference implementations) can target
the same endpoints later.

**Responsibilities**:

- **NOSTR fan-out** — accept signed events from clients and verify their
  signatures (target state — in v1 events originate and are signed
  server-side, see the v1 additions below), publish to the configured relay
  set
- **NOSTR aggregation / indexing** — subscribe to relays, index events, expose
  paginated read endpoints for the app
- **LN-Address resolution + caching** — LUD-16 endpoints get cached server-side
  with health checks; the app fetches a single normalized response
- **Discovery** — recent campaigns, ordering, eventual categories / search
- **Anti-abuse signals** — rate-limiting, spam scoring, suspicious-pattern
  detection at the edge
- **v1 additions** (see "v1 Transitional Model"): passkey register/authenticate
  and sessions; spend-worker invoice HTTP (`POST /invoices`,
  `POST /invoices/proof`); receiver address verification via micro-payment
  nonce; custodial per-account NOSTR identities (`nsec` encrypted at rest)
  with server-side event signing

**Non-responsibilities** (stay client-side; target state — the v1 additions
above temporarily move key generation/custody and event signing server-side;
recurring paying stays in the external spend worker):

- Passkey ceremonies, PRF evaluation, key derivation
- Event signing (the api never sees the nsec)
- Guest Donate LNURL-pay flow (browser → wallet provider directly). Recurring
  spend-worker invoices are the exception (`POST /invoices`).
- Decryption of NIP-17 sealed DMs (payloads pass through the api opaque)

The api lives in its own repository (`21gifts/api`) and is the **canonical
home for project-level documentation**, including this concept document. The
app repo (`21gifts/app`) only carries frontend-specific docs.

**Durability**: Durable Postgres writes are also appended to `db_change` with
`at` / `op` / `before` / `after`. Secret columns `token`, `challenge`,
`nostr_nsec_ciphertext`, `nonce`, and `view_key` are stored as SHA-256 hex in that JSON;
other columns including `name` stay plaintext.

### Storage (client-side)

> **Post-v1 target architecture** (like "Identity & Keys" above). v1 stores
> no client-side key material; the v1 session is a server-issued token bound
> to `account.id` after passkey authentication.

IndexedDB, two object stores:

| Store         | Contents                                                                                                                |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `credentials` | Passkey metadata (credential ID, derivation version, creation timestamp)                                                |
| `keystore`    | Encrypted secret material (encrypted mnemonic / encrypted nsec); plus the NOSTR `npub` in cleartext for the locked view |

Encryption: AES-GCM 256, with two key-derivation paths:

- **Passkey path** — HKDF-SHA256 from PRF output, salt `"21gifts-encryption"`, info `"aes-key-v1"`
- **Password path** — PBKDF2-SHA256 from user password, 100,000 iterations, 16-byte random salt persisted with the ciphertext

---

## MVP Scope (v1)

**In** — app:

- Sign-in via passkey (WebAuthn discoverable credential; session bound to
  `account.id`)
- Receiver profile UI: name, photo, story, Lightning Address (+ verified
  badge via micro-payment nonce)
- Public campaign feed (rendered from api response)
- _Donate_ button → LNURL-pay (browser flow, works without an account)
- Recurring gifts: configure daily USD amounts per recipient (paid by the
  external spend worker, not by depositing LNDHub into this api)
- Public comment composer (POST to api; signed server-side with the
  account's custodial key)
- Moderation actions on campaigns/comments (Moderator role)

**In** — api:

- Passkey endpoints: register/authenticate begin and finish, session issuance
- Spend-worker invoice HTTP: `POST /invoices` / `POST /invoices/proof`
  (paying and LNDHub stay in the external worker)
- Receiver address verification: micro-payment with one-time nonce in the
  LUD-12 comment
- Custodial NOSTR identities: per-account keypair generated on sign-up,
  `nsec` stored encrypted at rest, events signed server-side
- NOSTR fan-out to a default relay set
- Subscribe to relays + index `kind:0`, `kind:1` events
- Read endpoints: feed, profile, replies-to-event, recent campaigns
- LN-Address (LUD-16) resolution + cache + health check
- Basic anti-abuse: rate-limit per account, malformed-input rejection
- Moderation: hide/unhide content endpoints (Moderator role); role
  assignment stays operator-side in v1
- USD → sats conversion for recurring-gift amounts via an exchange-rate
  source (fail-closed on a missing or implausible rate; paying stays in
  the spend worker)

**Out, deferred:**

- Passkey + PRF → NOSTR identity (NIP-06) — moves to the non-custodial phase
- Client-side event signing (v1 signs server-side with custodial keys)
- Any second login method or account recovery (no email, no backup auth —
  accepted risk, see "v1 Transitional Model")
- Linking multiple LNURL-auth wallets to one account
- Non-custodial donor spending (replaces the v1 spend worker)
- Private DMs (NIP-17 sealed messages)
- NIP-57 Zap receipts / leaderboards
- NIP-05 verification badge
- Native mobile app
- Categories / filters / search
- Smart matching / recommendations
- Advanced anti-abuse (spam scoring, ML)
- Pinned relay
- "Raw mode" where the app talks to relays directly

---

## Open Questions

1. ~~PRF fallback — what happens if the user's browser doesn't support PRF?~~
   **Deferred 2026-07-05, restated 2026-08-24**: v1 login is passkey without
   PRF; this question returns with the non-custodial phase.
2. **Verification rigor** — pure NOSTR-reputation, or also platform-level checks?
   Where exactly is the line between "open" and "responsible"?
3. ~~Relay strategy — public relays only, or run a pinned relay for the
   platform?~~ **Resolved 2026-05-25**: 21.gifts uses the shared `nostr.space`
   relay (strfry) maintained as part of the wider NOSTR-space infrastructure.
   No relay operation is in 21.gifts' scope.
4. **Funding the platform** — hosting, domain, dev work need someone to pay.
   Options: rounding-up donations, optional tip on every flow, sponsor, founder
   funds. Must align with "non-profit" principle.
5. **Legal exposure** — gift law vs. fundraising law per jurisdiction. Liability
   if a receiver turns out to be a scammer? Clear "this is a gift, not a
   contract" disclaimers probably essential.
6. **Discovery UX** — how do donors find receivers? Random? Curated front page?
   Categories (medical, education, refugee, etc.)? Time-sensitive urgency?
7. **Anti-abuse** — scammers, fake stories, AI-generated profiles. How to
   detect without becoming a centralized gatekeeper?
8. **Sybil resistance** — one person, many profiles? NOSTR Web of Trust helps
   but isn't bulletproof.
9. ~~Platform-signed NOSTR events in v1 — one platform key for everything,
   or one derived key per account? How is authorship attributed?~~
   **Resolved 2026-07-05**: v1 NOSTR is fully custodial — one keypair per
   account, generated server-side on sign-up, `nsec` encrypted at rest,
   events signed with the account's own key, so public attribution is
   per-user. **Still open**: the migration path from custodial to user-owned
   keys in the non-custodial phase (key hand-over/export vs. fresh identity
   plus republish).

---

## Tech Stack

### App (`21gifts/app`) — thin frontend client

Goal: smallest viable browser bundle. Only what _must_ run client-side.

| Layer               | Choice                                                      | Rationale                                                               |
| ------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| Framework           | **Next.js 15** (App Router)                                 | SSR, standalone Docker output, broad ecosystem                          |
| Language            | TypeScript (strict mode)                                    | Type safety                                                             |
| Styling             | **Tailwind CSS only**                                       | No CSS files, no styled-components                                      |
| State               | **Zustand**                                                 | Minimal boilerplate, encrypted IndexedDB persistence                    |
| WebAuthn / PRF      | `navigator.credentials.*` directly, **no external library** | Smallest surface                                                        |
| Crypto primitives   | Web Crypto API (HKDF, PBKDF2, AES-GCM, SHA-256)             | Native, audited, no dependency cost                                     |
| secp256k1 / Schnorr | `@noble/curves`                                             | Pure TypeScript, audited, no WASM needed                                |
| BIP-32 / BIP-39     | `@scure/bip32`, `@scure/bip39`                              | Pure TypeScript, NIP-06-compatible                                      |
| NOSTR event helpers | `nostr-tools` (encoding + signing only; **no relay code**)  | App uses it for event construction and NIP-19 bech32, not for relay I/O |
| Lightning           | `light-bolt11-decoder` for invoice decoding                 | LUD-16 metadata comes pre-resolved from api                             |
| Schema validation   | `zod`                                                       | API response validation                                                 |
| Icons               | `lucide-react`                                              | Minimal icon set                                                        |
| Test                | Vitest (unit), Playwright (e2e)                             | Standard                                                                |
| Lint                | `next lint` + Prettier                                      | Standard                                                                |

> The WebAuthn/PRF, BIP-32/39, and client-side signing rows describe the
> non-custodial phase. v1 ships without client-side key material; the app's
> v1 crypto surface is limited to what passkey login and LNURL-pay
> require.

**Dependency philosophy**: stay minimal. Target ~12 runtime dependencies. The
app does UI plus — in the non-custodial phase — crypto + signing; everything
else (relay I/O, indexing, discovery, anti-abuse, LN-Address resolution) is
the api's job.

### Backend (`21gifts/api`) — central service

The workload is I/O-bound (HTTP, WebSocket, JSON) — not CPU-bound. The
language choice optimizes for iteration speed, dependency sharing with the
app, and operational simplicity.

| Layer          | Choice                                                                                                                                                  | Rationale                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Runtime        | **[Bun](https://bun.sh) ≥ 1.3**                                                                                                                         | Fast TS execution, built-in package manager, native HTTP server, small image    |
| Language       | TypeScript (strict mode)                                                                                                                                | Same language as app → shared types, mental-model symmetry                      |
| Framework      | **[Hono](https://hono.dev)**                                                                                                                            | TypeScript-first, runs natively on Bun, tiny surface, ergonomic test ergonomics |
| Validation     | `zod`                                                                                                                                                   | Same as app; shared schemas down the line                                       |
| NOSTR client   | `nostr-tools` (subscriptions, encoding, signature verification; v1 additionally: key generation + server-side event signing for custodial identities)   | Same lib as the app; one mental model                                           |
| Lightning      | LUD-16 JSON resolution via `fetch`; LNURL-pay invoice fetch + `light-bolt11-decoder` for spend-worker invoices; LNDHub pay stays in the external worker | LN node not required                                                            |
| Storage        | TBD (Postgres for relational; potentially Redis for relay-event cache)                                                                                  | Decision deferred until indexer surface stabilizes                              |
| Relay endpoint | Shared `wss://relay.nostr.space` (PRD), `wss://dev-relay.nostr.space` (DEV)                                                                             | Operated as separate infrastructure; configured via env var                     |
| Test           | **Vitest** + `@vitest/coverage-v8`                                                                                                                      | Explicit `coverage.thresholds: { lines, branches, functions, statements: 100 }` |
| Lint           | ESLint (flat config) + Prettier + `eslint-plugin-tsdoc`                                                                                                 | TSDoc on every exported function enforced                                       |

**Quality bar**: 100% coverage on every function (lines, branches, functions,
statements). Unreachable defensive code is exempted via `v8 ignore` markers
with a one-line written reason — never to silence the gate. CI is red until
thresholds are met.

---

## Repositories

GitHub organization: **`21gifts`** (created 2026-05-25).

| Repo                            | Purpose                                                                       | Status             |
| ------------------------------- | ----------------------------------------------------------------------------- | ------------------ |
| **`21gifts/api`**               | Backend service + **canonical project docs** (this file, ROADMAP, SPEC, etc.) | Created 2026-05-25 |
| `21gifts/app`                   | Web frontend client (`21.gifts`) — thin, only frontend-specific docs          | Created 2026-07-05 |
| `21gifts/docs`                  | Public developer documentation site (`docs.21.gifts`)                         | Later              |
| `21gifts/landing-page`          | Whitepaper / manifest landing page                                            | Later              |
| `21gifts/marketing` _(private)_ | Brand assets, launch material                                                 | Later              |

**Where docs live**:

- `21gifts/api` — `CONCEPT.md` (this file), `SPEC.md`, `FLOWS.md` (UI-journey
  sketch), future `ROADMAP.md`, protocol decisions, schema, architecture
  diagrams. The api is the brain of the system, so it owns the canonical
  project specification.
- `21gifts/app` — `README.md` (short, points at api repo for protocol),
  `CONTRIBUTING.md` (frontend-specific: dev setup, component conventions,
  styling, testing). Nothing protocol-level.

**Per-repo conventions**:

- `develop` is the default branch
- `main` is the production branch
- Feature branch → PR → merge to `develop`
- `main` is protected; updates flow via an auto-generated Release PR (`develop → main`)
- Every repo has `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE`
- Strict linting (Prettier + ESLint)
- No `console.log` in committed code
- Commit messages in English, concise, describe _what_ changed

---

## Brand

- **Domain**: `21.gifts` (secured 2026-05-25). The `21` is a Bitcoin
  reference (21M cap); `.gifts` semantically captures the intent — these are
  gifts, not donations, not transactions
- **Tone**: warm, direct, dignified. Not charity-speak ("the needy"), not
  techbro-speak ("disrupting philanthropy"). People helping people, with the
  best money humans have ever had.
- **Visual**: minimal, photo-driven, large typography. Receiver photos and
  stories are the hero. Tech is invisible.
- **Language**: English only.

---

## Docker

- Docker Hub organization: **`21gifts`** (created 2026-05-25)
- Image names match the repo: `21gifts/app`, `21gifts/api`
- Tag convention per image:
  - `:beta` — built from `develop`, deployed to DEV
  - `:latest` — built from `main`, deployed to PRD
- **One image, multiple environments** — for the app, build-time placeholders
  for `NEXT_PUBLIC_*` variables are replaced at container start by an
  `entrypoint.sh` with runtime values; the api reads its config purely from
  environment variables at startup. Same image runs DEV and PRD without rebuild.

---

## CI / CD (per product repo)

Four GitHub Actions workflows, identical structure for `app` and `api`:

| Workflow               | Trigger             | Action                                            |
| ---------------------- | ------------------- | ------------------------------------------------- |
| `ci.yaml`              | PR, push to develop | Lint + build + test (required for merge)          |
| `deploy-dev.yaml`      | push to develop     | Docker build → push `:beta` → notify infra repo   |
| `deploy-prd.yaml`      | push to main        | Docker build → push `:latest` → notify infra repo |
| `auto-release-pr.yaml` | push to develop     | Auto-create release PR `develop → main`           |

**Pre-push local checks**:

- `app`: `npm run lint && npm run build && npm test`
- `api`: `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run test:coverage && bun run build`

CI red is unacceptable; it's caught locally.

**Testing rule**: new code on the activated surface (features actually
shipped) must hit 100% line/branch/statement/function coverage. Feature-gated
code (behind a build-time flag or a server-side capability gate) is excluded —
gated code does not need coverage as long as the gate stays off in production
builds.

**Image-build → deploy hand-off**: the product repo's `deploy-*.yaml`
workflow pushes the image to Docker Hub and sends a `repository_dispatch`
event to a separate infrastructure repository (private, not part of this
project's scope). That repo handles the actual host-level deploy, secrets,
DNS, and reverse-proxy routing.

---

## Hosting & Operations

Two environments per service, mapped 1:1 to the branch model:

| Service | Env | Source branch | Image tag | Public URL         |
| ------- | --- | ------------- | --------- | ------------------ |
| app     | DEV | `develop`     | `:beta`   | `dev.21.gifts`     |
| app     | PRD | `main`        | `:latest` | `21.gifts`         |
| api     | DEV | `develop`     | `:beta`   | `dev-api.21.gifts` |
| api     | PRD | `main`        | `:latest` | `api.21.gifts`     |

`app.21.gifts` / `dev-app.21.gifts` remain transitional aliases for the app
container. Passkey RP ID is the apex (`21.gifts` / `dev.21.gifts`), not the
api hostname.

Subdomain convention: **dash, not dot** (e.g., `dev-api.21.gifts` rather than
`dev.api.21.gifts`). This keeps every subdomain at exactly one level deep,
which sidesteps the multi-level wildcard certificate problem on Cloudflare.

Public routing: behind a reverse proxy / tunnel that terminates TLS and
forwards to the container's port. Specific host names, secret stores, monitoring
hooks, and deploy mechanics live in the operator's separate infrastructure
repository — they're intentionally not part of this project's scope.

---

## Decisions Log

| Date       | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-05-25 | Domain `21.gifts` registered (premium .gifts TLD on Identity Digital)                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-05-25 | GitHub organization `21gifts` created                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-05-25 | Docker Hub organization `21gifts` created                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-05-25 | Tech stack: Next.js 15 + TS strict + Tailwind + Zustand, mirroring the zkCoins-app pattern                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-05-25 | Passkey + PRF + NIP-06 derivation chosen as the key model (over `PRF → HKDF → nsec` direct path)                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-05-25 | No external WebAuthn library — `navigator.credentials.*` directly                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2026-05-25 | Lightning Address (LUD-16) mandatory for receivers; platform never custodies funds                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-05-25 | English-only product (no i18n in v1)                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-05-25 | Hard-fail on PRF-unsupported authenticators (no silent fallback)                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-05-25 | Multi-repo architecture: `api`, `app`, `docs` (later), `landing-page` (later), `marketing` (private, later)                                                                                                                                                                                                                                                                                                                                                        |
| 2026-05-25 | Thin-client / thick-server: app holds only keys+signing+UI; everything else (relay I/O, indexing, discovery, LN-Address resolution, anti-abuse) lives in api                                                                                                                                                                                                                                                                                                       |
| 2026-05-25 | Backend service is named `api` and is built from day one — not deferred                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-05-25 | Canonical project documentation (CONCEPT, ROADMAP, SPEC) lives in `21gifts/api`; the app repo carries only frontend-specific docs                                                                                                                                                                                                                                                                                                                                  |
| 2026-05-25 | Backend stack: **TypeScript + Bun + Hono + Vitest** (revised from Rust + Axum). Workload is I/O-bound, not CPU-bound; language symmetry with the app wins                                                                                                                                                                                                                                                                                                          |
| 2026-05-25 | NOSTR relay: shared `nostr.space` infra (`wss://relay.nostr.space` / `wss://dev-relay.nostr.space`). 21.gifts is a client, not an operator. Closes OQ #3                                                                                                                                                                                                                                                                                                           |
| 2026-05-25 | Hard 100% coverage gate (lines + branches + functions + statements) enforced via `vitest.config.ts` thresholds; CI red until met                                                                                                                                                                                                                                                                                                                                   |
| 2026-05-25 | TSDoc on every exported symbol, enforced via `eslint-plugin-tsdoc`                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-07-05 | v1 account model: Basis (login + receive, default for every account) and Moderator (content moderation); donor is an upgrade, not a role                                                                                                                                                                                                                                                                                                                           |
| 2026-07-05 | v1 login: **LNURL-auth (LUD-04) only** — no email, no password, no passkey; `linkingKey` = account identifier; lockout risk explicitly accepted; auth callback host pinned to `api.21.gifts` / `dev-api.21.gifts`                                                                                                                                                                                                                                                  |
| 2026-08-22 | Auth callback host (wallet `linkingKey` domain) moved to the public apex `21.gifts` / `dev.21.gifts`. Supersedes the 2026-07-05 pin to `api.21.gifts`. App public URL is the apex; `app.21.gifts` stays a transitional alias. In-memory accounts from the old host do not survive.                                                                                                                                                                                 |
| 2026-07-05 | v1 donor spending: custodial via deposited `lndhub://` export, restricted to `lightning.space` wallets; explicit transitional deviation from Core Principles 2/5, replaced by a non-custodial setup later                                                                                                                                                                                                                                                          |
| 2026-07-05 | Recurring daily gifts are a v1 feature: server-side scheduler in the api with fail-closed payout semantics                                                                                                                                                                                                                                                                                                                                                         |
| 2026-07-05 | Receiver verification: micro-payment with one-time nonce in the LUD-12 comment (WoS-compatible, min 1 sat); no LUD-21 dependency (WoS lacks it)                                                                                                                                                                                                                                                                                                                    |
| 2026-07-05 | Research recorded: WoS has no official API; WoS supports LNURL-auth (Classic since 2023, Self-Custody since app v3.2.5 / 2026-02-04)                                                                                                                                                                                                                                                                                                                               |
| 2026-07-05 | v1 NOSTR events are platform-signed (users hold no keys until the non-custodial phase) — attribution details open in OQ #9                                                                                                                                                                                                                                                                                                                                         |
| 2026-07-05 | Revised same day: v1 NOSTR is **fully custodial** — one keypair per account, generated server-side, `nsec` encrypted at rest, events signed with the account's own key. Supersedes the platform-signed row above; resolves OQ #9 (migration path to user-owned keys stays open)                                                                                                                                                                                    |
| 2026-08-15 | CORS on the api allows `DELETE` so the browser app can unlink a Lightning Address; `SPEC.md` added as the HTTP contract home                                                                                                                                                                                                                                                                                                                                       |
| 2026-08-15 | Receiver address verification endpoints: `POST /me/lightning-address/verification` and `…/confirm`; api pays 1 sat (or provider `minSendable` ≤ 10 sat) with a LUD-12 comment nonce; **503** until an invoice payer is wired (process still boots)                                                                                                                                                                                                                 |
| 2026-08-15 | Core UI journeys sketched in `FLOWS.md` (sign-in, profile, donate, recurring gifts, message). Implemented screens cite `SPEC.md` only; donate / recurring / message remain CONCEPT sketches with no HTTP                                                                                                                                                                                                                                                           |
| 2026-08-15 | Public `GET /lightning-address` resolves LUD-16 metadata (callback, min/max sendable, optional commentAllowed) with a 5-minute in-memory cache; the process still boots with no extra env. Gift invoices stay browser-side.                                                                                                                                                                                                                                        |
| 2026-08-23 | Spend-worker invoice HTTP: `POST /invoices` fetches a recipient BOLT11 via LNURL-pay; `POST /invoices/proof` accepts the payment preimage. Paying is the external spend worker via lightning.space LNDHub — this api does not store LNDHub credentials or pay. `SPEND_API_TOKEN` optional (503 until set). **Supersedes** the 2026-07-05 in-api scheduler/LNDHub-pay decision and the 2026-08-15 “gift invoices stay browser-side” note for the spend-worker path. |
| 2026-08-24 | v1 login is **passkey only**; LNURL-auth (LUD-04) endpoints, QR login, and `/auth/session` poll removed. `linkingKey` remains a nullable historical column. LNURL-pay (donate / invoices / address verification) is unchanged. **Supersedes** the 2026-07-05 LNURL-auth-only login decision.                                                                                                                                                                       |
| 2026-08-24 | Matching `POST /invoices/proof` inserts an outbound `gift` row when `DATABASE_URL` is set so `GET /gifts/stats` includes spend-worker payments. Insert failure logs `gifts.record_failed` and still returns 200. Memory boots keep a no-op recorder.                                                                                                                                                                                                               |
| 2026-08-24 | Public `GET /gifts?day=YYYY-MM-DD` lists each outbound gift on that UTC day (time, recipient, sats/BTC/USD at that day's close). No invoices. Empty day is 200.                                                                                                                                                                                                                                                                                                    |
| 2026-08-28 | v1 public comments ship as custodial HTTP `GET/POST /messages` (name snapshot, text, timestamp); kind:1 relay fan-out remains unwired.                                                                                                                                                                                                                                                                                                                             |
| 2026-08-29 | Member-forum posts are **top-level kind:1** notes (not replies). GET/POST `/messages` include `sats` and `payable`. `POST /messages/:id/invoice` is a NIP-57 zap. Guest Send-a-gift is removed from the app. Worker fans out when `NOSTR_PUBLISH=1`.                                                                                                                                                                                                               |
| 2026-08-29 | Worker indexes validated kind:9735 zap receipts onto `message.sats` (durable `nostr_zap_receipt`, LNURL provider pubkey + bolt11 amount). Kind:1 EVENT frames are published as JSON objects so relays can ACK.                                                                                                                                                                                                                                                     |
| 2026-08-29 | `POST /me/lightning-address` live-resolves LUD-16 and requires NIP-57 zap metadata before save (no migration of existing rows). Invoice limiter on `POST /messages/:id/invoice` runs only after auth, amount, payable, and KEK checks so early 400/404/401/503 do not burn quota.                                                                                                                                                                                  |
| 2026-08-29 | Public member forum UX is a messenger-group thread (oldest top, newest bottom above the composer). `GET /messages` remains the latest-200 window newest-first; clients reverse for display.                                                                                                                                                                                                                                                                        |
| 2026-08-29 | Zap ingest and invoice `relays` always include the public list (space plus Damus / Primal / nos.lol); kind:1 public write stays gated on `NOSTR_PUBLISH_PUBLIC`.                                                                                                                                                                                                                                                                                                   |

---

## Next Steps

1. ~~Create `21gifts/api` repo skeleton~~ — done 2026-05-25: TS + Bun + Hono +
   Vitest, 100% coverage on `/healthz` and `/info`, this CONCEPT.md committed
   as the canonical home
2. ~~Create `21gifts/app` repo skeleton (Next.js 15 + TS strict + Tailwind +
   Zustand)~~ — done 2026-07-05: public repo exists
3. ~~Port the passkey + PRF + key-derivation primitives from the reference
   app~~ — deferred 2026-07-05 to the non-custodial phase (v1 login is
   passkey without PRF; restated 2026-08-24)
4. ~~Define the v1 api surface (passkey login, donor wallets, recurring-gift
   scheduler, address verification, custodial NOSTR identities + server-side
   event signing, feed, LN-Address resolver) — `SPEC.md` in the api repo~~ —
   done 2026-08-15: implemented HTTP surface documented in `SPEC.md`;
   remaining CONCEPT capabilities listed there as not implemented
5. ~~Wire up the four CI/CD workflows on both repos and Docker Hub
   publishing~~ — done 2026-07-05: `ci`, `deploy-dev`, `deploy-prd`, and
   `auto-release-pr` exist on api and app
6. ~~Validate LNURL-auth end-to-end with real wallets~~ — cancelled 2026-08-24:
   LNURL-auth login was removed; login is passkey-only
7. ~~Sketch core UI flows: sign-in → profile → donate → recurring gifts → message~~ —
   done 2026-08-15: `FLOWS.md` sketches the five journeys and labels
   each Shipped vs Sketch; HTTP stays in `SPEC.md`
8. ~~Choose initial NOSTR relay set~~ — done 2026-05-25: shared `nostr.space` relay
   (see Decisions Log 2026-05-25 / Open Question #3)
9. ~~First public DEV deploy~~ — done 2026-07-05: public DEV URLs are live
   (`dev-api.21.gifts`, `dev-app.21.gifts`)
10. Iterate MVP, dogfood early

---

_This document is the canonical source for product-level decisions on 21.gifts.
Hosting, secrets, DNS, and any other operator-specific details are out of scope
and live in the operator's separate infrastructure repository._
