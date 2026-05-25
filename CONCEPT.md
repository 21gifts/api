# 21.gifts — Concept

> Peer-to-peer donation platform. Direct human-to-human giving over Bitcoin
> Lightning, with NOSTR as the invisible communication substrate.

**Status**: draft, in active iteration. Last revised 2026-05-25.

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

## Architecture

### Identity & Keys

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

Open question (see below): how to handle the unsupported tail.

### Donations

- Receiver profile **must** include a Lightning Address (LUD-16)
- The api resolves and caches LUD-16 metadata server-side, with health checks
- Donor flow in the browser: click _Donate_ → app reads cached LN-Address from
  api → browser fetches LNURL-pay callback → invoice → pay (browser ↔ wallet
  provider directly, the api is not in the payment path)
- The api never sees the invoice, the amount, the payer, or the funds
- Optional: **NIP-57 Zap receipts** published to NOSTR for transparent acknowledgements

### Communication

Every "message" the user writes in the UI is a NOSTR event:

| UI surface                            | NOSTR primitive                                           |
| ------------------------------------- | --------------------------------------------------------- |
| Profile metadata (name, photo, story) | `kind:0` (NIP-01 metadata)                                |
| Receiver profile / campaign post      | `kind:1` (text note), tagged with campaign metadata       |
| Public comment / encouragement        | `kind:1` reply, with `e` and `p` tags                     |
| Private message donor ↔ receiver      | `kind:14` (NIP-17 sealed DM, modern) or `kind:4` (legacy) |
| Donation acknowledgement              | `kind:9735` Zap receipt (when NIP-57 enabled)             |

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

### Trust & Verification

**Protocol level**: completely open. Anyone publishes. Trust emerges from NOSTR
reputation (who follows / vouches for whom).

**Website level**: stricter, to protect donors from obvious scams:

- NIP-05 verification (optional, badged)
- Profile completeness (story, photo, LN-Address resolves successfully)
- Community vouching (other NOSTR identities sign off)
- No KYC, no government ID

The website is **not a gatekeeper** — it's a curator with transparent rules. If
a receiver doesn't meet website requirements, they can still use a different
client on the same protocol.

### Backend (`api`)

Central to the architecture from day one. Holds the project's canonical
documentation, schema, and protocol. The app is just one client of this api;
other clients (mobile apps, third-party reference implementations) can target
the same endpoints later.

**Responsibilities**:

- **NOSTR fan-out** — accept signed events from clients, verify signatures,
  publish to the configured relay set
- **NOSTR aggregation / indexing** — subscribe to relays, index events, expose
  paginated read endpoints for the app
- **LN-Address resolution + caching** — LUD-16 endpoints get cached server-side
  with health checks; the app fetches a single normalized response
- **Discovery** — recent campaigns, ordering, eventual categories / search
- **Anti-abuse signals** — rate-limiting, spam scoring, suspicious-pattern
  detection at the edge
- **Optional pinned relay** — for guaranteed persistence of platform-originated
  events (decision deferred to open question #3)

**Non-responsibilities** (stay client-side):

- Passkey ceremonies, PRF evaluation, key derivation
- Event signing (the api never sees the nsec)
- LNURL-pay flow (browser → wallet provider directly, no api proxy)
- Decryption of NIP-17 sealed DMs (payloads pass through the api opaque)

The api lives in its own repository (`21gifts/api`) and is the **canonical
home for project-level documentation**, including this concept document. The
app repo (`21gifts/app`) only carries frontend-specific docs.

### Storage (client-side)

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

- Sign-up via Passkey (PRF) → derive NOSTR identity (NIP-06)
- Receiver profile UI: name, photo, story, Lightning Address
- Public campaign feed (rendered from api response)
- _Donate_ button → LNURL-pay (browser flow)
- Public comment composer (sign → POST to api)
- Lock / unlock via Passkey or password

**In** — api:

- Authenticated event ingest endpoint (signature verification, basic rate-limiting)
- NOSTR fan-out to a default relay set (5–10 relays)
- Subscribe to relays + index `kind:0`, `kind:1` events
- Read endpoints: feed, profile-by-npub, replies-to-event, recent campaigns
- LN-Address (LUD-16) resolution + cache + health check
- Basic anti-abuse: rate-limit per pubkey, malformed-event rejection

**Out, deferred:**

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

1. **PRF fallback** — what happens if the user's browser doesn't support PRF?
   Options: (a) refuse with "use a modern browser" message; (b) generate `nsec`
   in the browser and encrypt it with a user passphrase, store encrypted blob in
   IndexedDB. Trade-off: simplicity vs. inclusivity.
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

**Dependency philosophy**: stay minimal. Target ~12 runtime dependencies. The
app does crypto + signing + UI; everything else (relay I/O, indexing,
discovery, anti-abuse, LN-Address resolution) is the api's job.

### Backend (`21gifts/api`) — central service

The workload is I/O-bound (HTTP, WebSocket, JSON) — not CPU-bound. The
language choice optimizes for iteration speed, dependency sharing with the
app, and operational simplicity.

| Layer          | Choice                                                                      | Rationale                                                                       |
| -------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Runtime        | **[Bun](https://bun.sh) ≥ 1.3**                                             | Fast TS execution, built-in package manager, native HTTP server, small image    |
| Language       | TypeScript (strict mode)                                                    | Same language as app → shared types, mental-model symmetry                      |
| Framework      | **[Hono](https://hono.dev)**                                                | TypeScript-first, runs natively on Bun, tiny surface, ergonomic test ergonomics |
| Validation     | `zod`                                                                       | Same as app; shared schemas down the line                                       |
| NOSTR client   | `nostr-tools` (subscriptions, encoding, signature verification)             | Same lib as the app; one mental model                                           |
| Lightning      | LUD-16 JSON resolution via `fetch`; `light-bolt11-decoder` if ever needed   | LN node not required                                                            |
| Storage        | TBD (Postgres for relational; potentially Redis for relay-event cache)      | Decision deferred until indexer surface stabilizes                              |
| Relay endpoint | Shared `wss://relay.nostr.space` (PRD), `wss://dev-relay.nostr.space` (DEV) | Operated as separate infrastructure; configured via env var                     |
| Test           | **Vitest** + `@vitest/coverage-v8`                                          | Explicit `coverage.thresholds: { lines, branches, functions, statements: 100 }` |
| Lint           | ESLint (flat config) + Prettier + `eslint-plugin-tsdoc`                     | TSDoc on every exported function enforced                                       |

**Quality bar**: 100% coverage on every function (lines, branches, functions,
statements). Unreachable defensive code is exempted via `v8 ignore` markers
with a one-line written reason — never to silence the gate. CI is red until
thresholds are met.

---

## Repositories

GitHub organization: **`21gifts`** (created 2026-05-25).

| Repo                            | Purpose                                                                       | Status    |
| ------------------------------- | ----------------------------------------------------------------------------- | --------- |
| **`21gifts/api`**               | Backend service + **canonical project docs** (this file, ROADMAP, SPEC, etc.) | To create |
| `21gifts/app`                   | Web frontend client (`21.gifts`) — thin, only frontend-specific docs          | To create |
| `21gifts/docs`                  | Public developer documentation site (`docs.21.gifts`)                         | Later     |
| `21gifts/landing-page`          | Whitepaper / manifest landing page                                            | Later     |
| `21gifts/marketing` _(private)_ | Brand assets, launch material                                                 | Later     |

**Where docs live**:

- `21gifts/api` — `CONCEPT.md` (this file), `ROADMAP.md`, future `SPEC.md`,
  protocol decisions, schema, architecture diagrams. The api is the brain of
  the system, so it owns the canonical project specification.
- `21gifts/app` — `README.md` (short, points at api repo for protocol),
  `CONTRIBUTING.md` (frontend-specific: dev setup, component conventions,
  styling, testing). Nothing protocol-level.

**Per-repo conventions**:

- `develop` is the default branch
- `main` is the production branch
- Feature branch → PR → merge to `develop`
- `main` is protected; updates flow via an auto-generated Release PR (`develop → main`)
- Every repo has `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE`
- Strict linting (Prettier + ESLint for TS, Clippy for Rust)
- No `console.log` / `dbg!` / `println!` in committed code
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
- `api`: `cargo fmt --check && cargo clippy -- -D warnings && cargo test`

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

| Service | Env | Source branch | Image tag | Public URL                 |
| ------- | --- | ------------- | --------- | -------------------------- |
| app     | DEV | `develop`     | `:beta`   | `dev.21.gifts`             |
| app     | PRD | `main`        | `:latest` | `21.gifts`, `www.21.gifts` |
| api     | DEV | `develop`     | `:beta`   | `dev-api.21.gifts`         |
| api     | PRD | `main`        | `:latest` | `api.21.gifts`             |

Subdomain convention: **dash, not dot** (e.g., `dev-api.21.gifts` rather than
`dev.api.21.gifts`). This keeps every subdomain at exactly one level deep,
which sidesteps the multi-level wildcard certificate problem on Cloudflare.

Public routing: behind a reverse proxy / tunnel that terminates TLS and
forwards to the container's port. Specific host names, secret stores, monitoring
hooks, and deploy mechanics live in the operator's separate infrastructure
repository — they're intentionally not part of this project's scope.

---

## Decisions Log

| Date       | Decision                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-05-25 | Domain `21.gifts` registered (premium .gifts TLD on Identity Digital)                                                                                        |
| 2026-05-25 | GitHub organization `21gifts` created                                                                                                                        |
| 2026-05-25 | Docker Hub organization `21gifts` created                                                                                                                    |
| 2026-05-25 | Tech stack: Next.js 15 + TS strict + Tailwind + Zustand, mirroring the zkCoins-app pattern                                                                   |
| 2026-05-25 | Passkey + PRF + NIP-06 derivation chosen as the key model (over `PRF → HKDF → nsec` direct path)                                                             |
| 2026-05-25 | No external WebAuthn library — `navigator.credentials.*` directly                                                                                            |
| 2026-05-25 | Lightning Address (LUD-16) mandatory for receivers; platform never custodies funds                                                                           |
| 2026-05-25 | English-only product (no i18n in v1)                                                                                                                         |
| 2026-05-25 | Hard-fail on PRF-unsupported authenticators (no silent fallback)                                                                                             |
| 2026-05-25 | Multi-repo architecture: `api`, `app`, `docs` (later), `landing-page` (later), `marketing` (private, later)                                                  |
| 2026-05-25 | Thin-client / thick-server: app holds only keys+signing+UI; everything else (relay I/O, indexing, discovery, LN-Address resolution, anti-abuse) lives in api |
| 2026-05-25 | Backend service is named `api` and is built from day one — not deferred                                                                                      |
| 2026-05-25 | Canonical project documentation (CONCEPT, ROADMAP, SPEC) lives in `21gifts/api`; the app repo carries only frontend-specific docs                            |
| 2026-05-25 | Backend stack: **TypeScript + Bun + Hono + Vitest** (revised from Rust + Axum). Workload is I/O-bound, not CPU-bound; language symmetry with the app wins    |
| 2026-05-25 | NOSTR relay: shared `nostr.space` infra (`wss://relay.nostr.space` / `wss://dev-relay.nostr.space`). 21.gifts is a client, not an operator. Closes OQ #3     |
| 2026-05-25 | Hard 100% coverage gate (lines + branches + functions + statements) enforced via `vitest.config.ts` thresholds; CI red until met                             |
| 2026-05-25 | TSDoc on every exported symbol, enforced via `eslint-plugin-tsdoc`                                                                                           |

---

## Next Steps

1. ~~Create `21gifts/api` repo skeleton~~ — done 2026-05-25: TS + Bun + Hono +
   Vitest, 100% coverage on `/healthz` and `/info`, this CONCEPT.md committed
   as the canonical home
2. Create `21gifts/app` repo skeleton (Next.js 15 + TS strict + Tailwind + Zustand)
3. Port the passkey + PRF + key-derivation primitives from the reference app,
   adjusted for NIP-06 output (32-byte nsec, not BIP-32 xpriv)
4. Define the v1 api surface (event-ingest, feed, profile, LN-Address resolver) — `SPEC.md` in the api repo
5. Wire up the four CI/CD workflows on both repos and Docker Hub publishing
6. Validate the PRF flow end-to-end on target browsers (iOS Safari 18+, Chrome,
   Edge, 1Password)
7. Sketch core UI flows: sign-up → profile → donate → message
8. Choose initial NOSTR relay set
9. First public DEV deploy
10. Iterate MVP, dogfood early

---

_This document is the canonical source for product-level decisions on 21.gifts.
Hosting, secrets, DNS, and any other operator-specific details are out of scope
and live in the operator's separate infrastructure repository._
