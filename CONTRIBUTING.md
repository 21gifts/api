# Contributing to 21.gifts api

## Quick start

```bash
git clone https://github.com/21gifts/api.git
cd api
bun install
bun run dev    # → http://localhost:3000/healthz
```

## Prerequisites

| Tool                       | Version | Purpose                                       |
| -------------------------- | ------- | --------------------------------------------- |
| [Bun](https://bun.sh)      | ≥ 1.3   | Runtime + package manager + test runner       |
| Node.js (for tooling only) | ≥ 22    | Some dev-tools (TypeScript, ESLint) expect it |

Install Bun:

```bash
brew install oven-sh/bun/bun
# or: curl -fsSL https://bun.sh/install | bash
```

## Project structure

```
api/
├── src/
│   ├── index.ts              # Bun runtime entry (boot path, v8 ignored)
│   ├── server.ts             # createApp() factory + bind-addr helpers (pure, testable)
│   ├── routes/
│   │   ├── health.ts         # GET /healthz
│   │   ├── info.ts           # GET /info
│   │   ├── brand.ts          # GET /favicon.ico, /favicon.svg, /apple-touch-icon.png
│   │   ├── auth.ts           # Passkey: /auth/passkey/register|authenticate begin/finish
│   │   ├── me.ts             # GET /me; POST /me/name; link/unlink + address verification
│   │   ├── lightning-address.ts  # GET /lightning-address (public LUD-16 resolve)
│   │   ├── debug.ts          # GET /debug/accounts (operator DEBUG_TOKEN)
│   │   ├── stats.ts          # GET /gifts/stats (public gift totals)
│   │   ├── gifts.ts          # GET /gifts?day= (public per-day gift list)
│   │   ├── invoices.ts       # POST /invoices, POST /invoices/proof (spend worker)
│   │   └── messages.ts       # GET /messages, POST /messages, POST /messages/:id/invoice
│   ├── lib/
│   │   ├── meta.ts           # Service constants (name, version, repo URL)
│   │   ├── config.ts         # Auth, verification, and gift-invoice TTLs/amounts (no required env for verify)
│   │   ├── name.ts           # Display-name trim/validate (C0/DEL)
│   │   ├── message.ts        # Forum text trim/validate + public JSON projection
│   │   ├── message-store.ts  # MessageStore port, InMemoryMessageStore, PostgresMessageStore
│   │   ├── lightning-address.ts  # LUD-16 shape check
│   │   ├── invoice-payer.ts  # InvoicePayer port + UnconfiguredInvoicePayer
│   │   ├── lnurlp.ts         # LUD-16 well-known metadata resolve (shared)
│   │   ├── ln-address-cache.ts  # In-memory TTL cache for successful resolves
│   │   ├── log.ts            # JSON event lines (console.warn); requestLog middleware
│   │   ├── lnurl-pay.ts      # LUD-16 → LNURL-pay invoice (amount + LUD-12 comment)
│   │   ├── gift-invoice.ts   # LUD-16 → LNURL-pay invoice for gift amounts (no 10-sat cap)
│   │   ├── bolt11.ts         # Decode BOLT11 payment hash + amount
│   │   ├── proof.ts          # sha256(preimage) === payment hash
│   │   ├── spend-auth.ts     # Timing-safe SPEND_API_TOKEN Bearer check
│   │   ├── invoice-store.ts  # In-memory gift invoices awaiting proof
│   │   ├── gift-recorder.ts  # Persist proven spend gifts into `gift` (no-op or SQL)
│   │   ├── verification.ts   # Address proof-of-control start/confirm domain logic
│   │   ├── debug-token.ts    # Constant-time DEBUG_TOKEN Bearer compare
│   │   ├── boot-stores.ts    # DATABASE_URL → auth, optional QueryGiftStore + SqlGiftRecorder, message, BTC-USD rates, KEK
│   │   ├── money.ts          # Sats/BTC strings and historical USD cents
│   │   ├── btc-usd-candles.ts # Coinbase Exchange BTC-USD daily closes
│   │   ├── btc-usd-store.ts  # btc_usd_daily migrate + rate book
│   │   ├── gift.ts           # GiftRow + buildGiftStats + SQL row mapper
│   │   ├── gift-store.ts     # GiftStore port, InMemoryGiftStore, QueryGiftStore
│   │   ├── nostr/            # Custodial nsec, kind:1 worker, NIP-57 zap, write-set relays
│   │   └── auth/
│   │       ├── account-json.ts # Public account JSON (no nsec)
│   │       ├── hex.ts        # CSPRNG hex tokens
│   │       ├── passkey.ts    # WebAuthn register/authenticate domain logic
│   │       ├── service.ts    # Session issuance and bearer resolution
│   │       ├── store.ts      # AuthStore port + in-memory adapter (+ passkey records)
│   │       ├── sql.ts        # SqlClient port (Bun adapter is in index.ts)
│   │       ├── schema.ts     # AUTH_SCHEMA_SQL
│   │       ├── postgres-store.ts  # Durable AuthStore
│   │       ├── open-store.ts # DATABASE_URL → memory or Postgres
│   │       └── webauthn.ts   # PasskeyCeremony port + SimpleWebAuthn adapter
│   └── __tests__/            # Mirror tree; one *.test.ts per source file
│       ├── server.test.ts
│       ├── helpers/
│       │   └── fake-passkey.ts   # PasskeyCeremony test double
│       ├── integration/
│       │   └── auth-flow.test.ts
│       ├── lib/
│       │   ├── meta.test.ts
│       │   ├── config.test.ts
│       │   ├── name.test.ts
│       │   ├── lightning-address.test.ts
│       │   ├── invoice-payer.test.ts
│       │   ├── lnurlp.test.ts
│       │   ├── ln-address-cache.test.ts
│       │   ├── log.test.ts
│       │   ├── lnurl-pay.test.ts
│       │   ├── gift-invoice.test.ts
│       │   ├── bolt11.test.ts
│       │   ├── proof.test.ts
│       │   ├── spend-auth.test.ts
│       │   ├── invoice-store.test.ts
│       │   ├── gift-recorder.test.ts
│       │   ├── verification.test.ts
│       │   ├── debug-token.test.ts
│       │   ├── boot-stores.test.ts
│       │   ├── money.test.ts
│       │   ├── btc-usd-candles.test.ts
│       │   ├── btc-usd-store.test.ts
│       │   ├── gift.test.ts
│       │   ├── gift-store.test.ts
│       │   ├── message.test.ts
│       │   ├── message-store.test.ts
│       │   └── auth/
│       │       ├── hex.test.ts
│       │       ├── passkey.test.ts
│       │       ├── service.test.ts
│       │       ├── store.test.ts
│       │       ├── schema.test.ts
│       │       ├── sql.test.ts
│       │       ├── postgres-store.test.ts
│       │       ├── open-store.test.ts
│       │       └── webauthn.test.ts
│       └── routes/
│           ├── health.test.ts
│           ├── info.test.ts
│           ├── brand.test.ts
│           ├── auth.test.ts
│           ├── me.test.ts
│           ├── lightning-address.test.ts
│           ├── debug.test.ts
│           ├── stats.test.ts
│           ├── gifts.test.ts
│           ├── invoices.test.ts
│           └── messages.test.ts
├── docs/handbook/            # Mandatory: every function + HTTP endpoint
│   ├── README.md
│   ├── functions.md
│   └── endpoints.md
├── docs/schema/
│   ├── gift.sql              # gift table used by GET /gifts and GET /gifts/stats
│   ├── btc_usd_daily.sql     # UTC daily BTC-USD closes for historical USD stats
│   └── message.sql           # public forum message table for GET/POST /messages
├── scripts/
│   ├── check-handbook.mjs    # CI gate: missing heading → exit 1
│   ├── check-e2e.mjs         # CI gate: missing endpoint request or Function: title → exit 1
│   └── gifts-debug.sh        # Operator CLI for GET /debug/accounts
├── e2e/
│   ├── http.spec.ts          # Playwright endpoint smokes against bun src/index.ts
│   └── functions.spec.ts     # Playwright Function: <Name> tests against the booted process
├── playwright.config.ts
├── public/                   # Brand mark files served at origin root
│   ├── favicon.ico
│   ├── favicon.svg
│   └── apple-touch-icon.png
├── package.json
├── tsconfig.json
├── vitest.config.ts          # 100% coverage threshold
├── eslint.config.js          # Flat config
├── .prettierrc
├── Dockerfile                # Multi-stage Bun build
├── CONCEPT.md                # Canonical project documentation
├── SPEC.md                   # Implemented HTTP surface (request/response contracts)
├── FLOWS.md                  # Core UI journey sketch (CONCEPT next-step 7)
├── README.md
├── CONTRIBUTING.md
├── SECURITY.md
└── LICENSE
```

## Git workflow

### Branches

| Branch    | Purpose                            | Deploy target |
| --------- | ---------------------------------- | ------------- |
| `develop` | Default branch, active development | DEV           |
| `main`    | Production releases                | PRD           |

- Push to `develop` via **feature branch + PR**
- `main` is protected — updates flow via an auto-generated Release PR (`develop → main`)
- Never force-push, never amend published commits

### Commit messages

English, concise, describe _what_ changed.

```
# Good
Add /healthz endpoint
Wire signature verification into event ingest
Fix LUD-16 caching TTL parsing

# Bad
fix
WIP
update stuff
```

## Code style

### TypeScript

- **Strict mode**, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`
- **Explicit return types on exported functions** (enforced by ESLint)
- **No `any`** — use `unknown` and narrow
- **No `console.log`** in committed code — `console.warn` / `console.error` only, for legitimate operator-facing output
- **Named exports**, no default exports
- **Path alias `@/`** points at `src/` (configured in `tsconfig.json` and `vitest.config.ts`)

### TSDoc

Every exported symbol has a TSDoc block with a one-line summary plus
`@param` / `@returns` / `@throws` where applicable. `eslint-plugin-tsdoc`
flags malformed comments.

### Handbook (hard requirement)

The handbook under `docs/handbook/` **must exist**. This repo has no UI screens.
Every exported function/class in `src/` and every HTTP endpoint **must** have a
complete section:

- Functions: `## Function: name`
- Endpoints: `## Endpoint: METHOD /path`

A section is complete only if it has at least three `- **…**` bullets and enough
prose to describe the behaviour. `bun run handbook:check` (and CI) **fails the
PR** when a heading is missing or a section is a stub. Adding an export or
route without updating the handbook in the **same PR** is an undeclared
deviation and is rejected.

### E2E (hard requirement)

Every HTTP endpoint **must** have at least one Playwright request against a
booted server (`bun src/index.ts`). Every exported function/class **must** have
a Playwright `test('Function: <Name> …')` (or `"…"` / `` `…` ``) that hits the
booted process over HTTP (not `app.request()`). If an export is unreachable on
the default boot surface (today: `requestPayInvoice`, which needs a configured
`InvoicePayer`; `PostgresAuthStore`, `migrateAuthSchema`, `QueryGiftStore`,
`mapGiftQueryRow`, `PostgresBtcUsdStore`, `migrateBtcUsdSchema`,
`PostgresMessageStore`, `migrateMessageSchema`,
`fillRatesForGiftRange`, `fetchDailyCloses`, `parseCoinbaseCandles`,
`resolveCandlesUrl`, and `SqlGiftRecorder`, which need `DATABASE_URL`;
`InMemoryInvoiceStore`, `requestGiftInvoice`, `decodeBolt11`, `newInvoiceId`,
`normalizeHex32`, `preimageMatchesHash`, `NoopGiftRecorder`, and
`recipientHandleFromAddress`, which need `SPEND_API_TOKEN` and a reachable
LNURL-pay;
`satsToUsdCents`, `parseUsdPerBtc`, and `utcDayFromPaidAt`, which need a non-empty gift list),
that test still exists and asserts the default-boot outcome that proves it is
not invoked (verification `503`, spend invoices unconfigured `503`, or a
healthy process with `DATABASE_URL` blank). Playwright `webServer.env` pins
`DATABASE_URL`, `SPEND_API_TOKEN`, `NOSTR_NSEC_KEK`, `NOSTR_PUBLISH`,
`NOSTR_PUBLISH_PUBLIC`, `NOSTR_RELAY_URL`, `NOSTR_RELAY_SPACE`, and
`NOSTR_RELAY_PUBLIC` to blank
so those outcomes do not depend on the host environment.
`bun run e2e:check` **fails the PR** if an endpoint has no matching
`request.get/post/delete` or a function has no matching
`test('Function: <Name> …')` title. The check reads `e2e/**/*.spec.ts` only.
Adding a route or export without an e2e call in the **same PR** is an
undeclared deviation and is rejected. CI runs `e2e:check` then `e2e`.

### Tests

- One `*.test.ts` per source file, under `src/__tests__/` mirroring the source tree
- Every function exercised in at least one test
- Coverage gate: 100% lines, branches, functions, statements on the activated surface
  (see `vitest.config.ts`). Unreachable defensive code can be exempted with a
  `v8 ignore` annotation that names a concrete reason — never to silence the gate.

### Before every push (the same checks CI runs)

```bash
bun run typecheck
bun run lint
bun run handbook:check
bun run e2e:check
bun run test:coverage
bun run build
bun run e2e
```

CI will fail on the same conditions; catching them locally is faster.

## Docker

The service runs as a single Bun binary in a slim Debian container:

```bash
docker build -t 21gifts/api:dev .
docker run -p 3000:3000 -e BIND_ADDR=0.0.0.0:3000 21gifts/api:dev
```

Configuration is read from environment variables only — no config files.
Currently:

| Variable               | Default                                 | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BIND_ADDR`            | `0.0.0.0:3000`                          | Listen address                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `SERVICE_VERSION`      | `0.1.0`                                 | Surfaced via `/info`                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `DATABASE_URL`         | _(unset → in-memory)_                   | Postgres connection string. When set, auth, `btc_usd_daily`, and `message` are migrated, `GET /gifts` and `GET /gifts/stats` read `gift` plus persisted BTC-USD daily closes (best-effort boot fill; failures log and do not kill the process), `GET/POST /messages` use `PostgresMessageStore`, and a matching `POST /invoices/proof` inserts into `gift`. Unset keeps `InMemoryAuthStore`, in-memory forum store, empty gift stats, empty day lists, and a no-op gift recorder. |
| `DEBUG_TOKEN`          | _(unset → debug off)_                   | Operator bearer for `GET /debug/accounts`. Unset or blank → `503`; the process still boots.                                                                                                                                                                                                                                                                                                                                                                                       |
| `WEBAUTHN_RP_ID`       | _(none — required for passkey)_         | WebAuthn RP ID (`21.gifts` / `dev.21.gifts` / `localhost`). Passkey routes return `500` until it is set; the process still boots. Not a secret.                                                                                                                                                                                                                                                                                                                                   |
| `WEBAUTHN_RP_NAME`     | `21.gifts`                              | Human-readable RP name.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `CORS_ALLOWED_ORIGINS` | built-in apex / app aliases / localhost | Comma-separated browser origins. Passkey finish keeps those whose hostname is the RP ID or `app.<rpId>`.                                                                                                                                                                                                                                                                                                                                                                          |
| `SPEND_API_TOKEN`      | _(none — optional)_                     | Bearer for spend-worker `POST /invoices` / `POST /invoices/proof`. Unset/blank → **503**; the process still boots.                                                                                                                                                                                                                                                                                                                                                                |
| `BTC_USD_CANDLES_URL`  | Coinbase Exchange BTC-USD candles URL   | Optional override for daily close fetch used by `GET /gifts` and `GET /gifts/stats`. Blank/unset → default Coinbase URL; the process still boots.                                                                                                                                                                                                                                                                                                                                 |
| `NOSTR_NSEC_KEK`       | _(unset → no keys/worker)_              | 32-byte hex AES-GCM KEK for custodial nsec. With `DATABASE_URL`, missing KEK still boots but notes stay unsigned and `POST /messages/:id/invoice` is 503.                                                                                                                                                                                                                                                                                                                         |
| `NOSTR_PUBLISH`        | _(unset → sign only)_                   | Set to `1` to fan out signed kind:1 events over WebSockets. Other values do not publish.                                                                                                                                                                                                                                                                                                                                                                                          |
| `NOSTR_PUBLISH_PUBLIC` | _(unset → space only)_                  | Set to `1` (with `NOSTR_PUBLISH=1`) to also write Damus / Primal / nos.lol.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `NOSTR_RELAY_URL`      | `wss://relay.nostr.space`               | Compose durability relay (nostr.space). Used when `NOSTR_RELAY_SPACE` is unset.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `NOSTR_RELAY_SPACE`    | _(falls back to `NOSTR_RELAY_URL`)_     | Optional override of the durability relay WebSocket URL.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `NOSTR_RELAY_PUBLIC`   | Damus, Primal, nos.lol                  | Optional comma-separated public write relays.                                                                                                                                                                                                                                                                                                                                                                                                                                     |

More will be added as concrete subsystems that need runtime configuration
(relay client, …) land. The LUD-16 metadata cache TTL is a code constant
(`LN_ADDRESS_CACHE_TTL_MS`), not an environment variable.

## CI / CD

| Workflow               | Trigger               | Action                                                                       |
| ---------------------- | --------------------- | ---------------------------------------------------------------------------- |
| `ci.yaml`              | PR (including drafts) | Typecheck + lint + handbook + e2e-check + test (100% coverage) + build + e2e |
| `deploy-dev.yaml`      | push to `develop`     | Docker build → push `21gifts/api:beta` → notify infrastructure               |
| `deploy-prd.yaml`      | push to `main`        | Docker build → push `21gifts/api:latest` → notify infrastructure             |
| `auto-release-pr.yaml` | push to `develop`     | Auto-create Release PR (`develop → main`)                                    |

Images target `linux/arm64`.

Deploy workflows require these GitHub Actions secrets:

| Secret            | Purpose                                             |
| ----------------- | --------------------------------------------------- |
| `DOCKER_USERNAME` | Docker Hub username for image push                  |
| `DOCKER_PASSWORD` | Docker Hub token for image push                     |
| `DISPATCH_TOKEN`  | PAT used to fire `repository_dispatch` after push   |
| `DISPATCH_REPO`   | Target `owner/repo` that receives `image-published` |

If `DISPATCH_TOKEN` or `DISPATCH_REPO` is missing, notify warns and exits 0 —
the image is already on Hub; DFXServer `probe-published-images.yml` dispatches
`image-published` when the tag moves. Set the secrets for an immediate pull.

## Related repos

- [`21gifts/app`](https://github.com/21gifts/app) — Web frontend client
