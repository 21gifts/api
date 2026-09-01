# Contributing to 21.gifts api

## Quick start

```bash
git clone https://github.com/21gifts/api.git
cd api
bun install
MEDIA_DIR="$(mktemp -d)" bun run dev    # → http://localhost:3000/healthz
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
│   │   ├── me.ts             # GET /me; POST /me/name; POST /me/forum-laws-dismissed; POST /me/rules-agreement; link/unlink + address verification
│   │   ├── view.ts           # GET /view/:viewKey (public profile card)
│   │   ├── lightning-address.ts  # GET /lightning-address (public LUD-16 resolve)
│   │   ├── debug.ts          # GET/POST /debug/accounts; PATCH /debug/accounts/:id; POST /debug/accounts/:id/session (DEBUG_TOKEN)
│   │   ├── debug-contacts.ts # GET /debug/contacts (operator DEBUG_TOKEN)
│   │   ├── debug-messages.ts # PUT /debug/messages/:id/video (operator DEBUG_TOKEN)
│   │   ├── debug-payments.ts # GET /debug/invoices; GET /debug/zap-ingests (DEBUG_TOKEN)
│   │   ├── debug-push.ts     # POST /debug/push-ping (operator DEBUG_TOKEN)
│   │   ├── push.ts           # GET /push/vapid-public; POST/DELETE /me/push-subscriptions
│   │   ├── stats.ts          # GET /gifts/stats (public gift totals)
│   │   ├── gifts.ts          # GET /gifts?day= (public per-day gift list)
│   │   ├── invoices.ts       # POST /invoices, POST /invoices/proof (spend worker)
│   │   ├── messages.ts       # GET/POST /messages, public GET /messages/:id, GET /messages/:id/replies, GET /messages/:id/photo, GET /messages/:id/video.*, POST /messages/:id/invoice
│   │   ├── well-known.ts     # GET /.well-known/nostr.json (NIP-05)
│   │   ├── contact.ts        # POST /contact (private mailbox + platform thread)
│   │   └── conversations.ts  # GET/POST /conversations, GET/POST /conversations/:id
│   ├── lib/
│   │   ├── meta.ts           # Service constants (name, version, repo URL)
│   │   ├── config.ts         # Auth, verification, and gift-invoice TTLs/amounts (no required env for verify)
│   │   ├── name.ts           # Display-name trim/validate (C0/DEL)
│   │   ├── message.ts        # Forum text/photo/video validate + public JSON (hasPhoto/hasVideo; no bytes)
│   │   ├── video.ts          # Forum video magic-bytes, faststart, MEDIA_DIR, Range parse
│   │   ├── nip05.ts          # NIP-05 slugs, nostr.json names, kind:0 identifier
│   │   ├── nip57-probe.ts    # NIP-57 mint probe before linking a Lightning Address
│   │   ├── message-store.ts  # MessageStore port, InMemoryMessageStore, PostgresMessageStore
│   │   ├── contact.ts        # Contact public/debug JSON projection (reuses forum text rules)
│   │   ├── contact-store.ts  # ContactStore port, InMemoryContactStore, PostgresContactStore
│   │   ├── conversation.ts   # PN public JSON (no accountId / eventId / npub)
│   │   ├── conversation-store.ts  # ConversationStore port, memory + Postgres
│   │   ├── push-config.ts    # resolveVapidConfig (VAPID env; missing → null)
│   │   ├── push.ts           # parsePushSubscription + English forum/zap payloads
│   │   ├── push-store.ts     # PushStore port, memory + Postgres, PUSH_SCHEMA_SQL
│   │   ├── push-sender.ts    # PushSender port, UnconfiguredPushSender, WebPushSender
│   │   ├── push-worker.ts    # enqueue + outbox tick
│   │   ├── lightning-address.ts  # LUD-16 shape check
│   │   ├── invoice-payer.ts  # InvoicePayer port + UnconfiguredInvoicePayer
│   │   ├── lnurlp.ts         # LUD-16 well-known metadata resolve (shared)
│   │   ├── ln-address-cache.ts  # In-memory TTL cache for successful resolves
│   │   ├── log.ts            # JSON event lines (console.warn); requestLog middleware
│   │   ├── lnurl-pay.ts      # LUD-16 → LNURL-pay invoice (amount + LUD-12 comment)
│   │   ├── gift-invoice.ts   # LUD-16 → LNURL-pay invoice for gift amounts (no 10-sat cap)
│   │   ├── bolt11.ts         # Decode/inspect BOLT11 (hash, amount, description / description_hash)
│   │   ├── proof.ts          # sha256(preimage) === payment hash
│   │   ├── spend-auth.ts     # Timing-safe SPEND_API_TOKEN Bearer check
│   │   ├── invoice-store.ts  # In-memory gift invoices awaiting proof
│   │   ├── gift-recorder.ts  # Persist proven spend gifts into `gift` (no-op or SQL)
│   │   ├── verification.ts   # Address proof-of-control start/confirm domain logic
│   │   ├── debug-token.ts    # Constant-time DEBUG_TOKEN Bearer compare
│   │   ├── boot-stores.ts    # DATABASE_URL → auth, optional QueryGiftStore + SqlGiftRecorder, message, contact, conversation, push, BTC-USD rates, KEK, db_change
│   │   ├── money.ts          # Sats/BTC strings and historical USD cents
│   │   ├── btc-usd-candles.ts # Coinbase Exchange BTC-USD daily closes
│   │   ├── btc-usd-store.ts  # btc_usd_daily migrate + rate book
│   │   ├── db-change.ts      # append-only `db_change` change log migrate
│   │   ├── gift.ts           # GiftRow + buildGiftStats + SQL row mapper
│   │   ├── gift-store.ts     # GiftStore port, InMemoryGiftStore, QueryGiftStore
│   │   ├── nostr/            # Custodial nsec, kind:0/1/10002 worker, NIP-17/kind:4 DMs, NIP-57 zap, write-set relays
│   │   └── auth/
│   │       ├── account-json.ts # Public account JSON (no nsec)
│   │       ├── account-setup.ts # Next owner setup step (name, Lightning Address, rules)
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
│       │   ├── db-change.test.ts
│       │   ├── gift.test.ts
│       │   ├── gift-store.test.ts
│       │   ├── message.test.ts
│       │   ├── video.test.ts
│       │   ├── nip05.test.ts
│       │   ├── nip57-probe.test.ts
│       │   ├── message-store.test.ts
│       │   ├── nostr/            # kek, keys, publish, worker, dm, relays, zap, event, sign, rate-limit
│       │   ├── contact.test.ts
│       │   ├── contact-store.test.ts
│       │   ├── conversation.test.ts
│       │   ├── conversation-store.test.ts
│       │   ├── push.test.ts
│       │   ├── push-config.test.ts
│       │   ├── push-store.test.ts
│       │   ├── push-sender.test.ts
│       │   ├── push-worker.test.ts
│       │   └── auth/
│       │       ├── account-json.test.ts
│       │       ├── account-setup.test.ts
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
│           ├── messages.test.ts
│           ├── well-known.test.ts
│           ├── contact.test.ts
│           ├── conversations.test.ts
│           ├── debug-contacts.test.ts
│           ├── debug-messages.test.ts
│           ├── debug-payments.test.ts
│           ├── push.test.ts
│           ├── debug-push.test.ts
│           └── view.test.ts
├── docs/handbook/            # Mandatory: every function + HTTP endpoint
│   ├── README.md
│   ├── functions.md
│   └── endpoints.md
├── docs/schema/
│   ├── gift.sql              # gift table used by GET /gifts and GET /gifts/stats
│   ├── btc_usd_daily.sql     # UTC daily BTC-USD closes for historical USD stats
│   ├── message.sql           # forum `message` plus `message_invoice` and `nostr_zap_ingest`
│   ├── contact.sql           # private contact mailbox table for POST /contact
│   ├── conversation.sql      # PN threads + messages (member/platform/Damus)
│   ├── push.sql              # push_subscription + push_outbox
│   └── db_change.sql         # append-only row-change log
├── scripts/
│   ├── check-handbook.mjs    # CI gate: missing heading → exit 1
│   ├── check-e2e.mjs         # CI gate: missing endpoint request or Function: title → exit 1
│   └── gifts-debug.sh        # Operator CLI: list, set role, unlink Lightning Address (DEBUG_TOKEN)
├── e2e/
│   ├── http.spec.ts          # Playwright endpoint smokes against bun src/index.ts
│   ├── forum-replies.spec.ts # Playwright: provision, session, note, public GET, reply, replyCount
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
`PostgresContactStore`, `migrateContactSchema`,
`PostgresConversationStore`, `migrateConversationSchema`,
`PostgresPushStore`, `migratePushSchema`, `migrateDbChangeSchema`,
`DB_CHANGE_SCHEMA_SQL`,
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
`NOSTR_PUBLISH_PUBLIC`, `NOSTR_RELAY_URL`, `NOSTR_RELAY_SPACE`,
`NOSTR_RELAY_PUBLIC`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and
`VAPID_SUBJECT` to blank, and `NIP57_PROBE` to `0`,
so those outcomes do not depend on the host environment.
`bun run e2e:check` **fails the PR** if an endpoint has no matching
`request.get/post/delete` or a function has no matching
`test('Function: <Name> …')` title. The check reads `e2e/**/*.spec.ts` only.
Adding a route or export without an e2e call in the **same PR** is an
undeclared deviation and is rejected. CI runs `e2e:check` then `e2e`.

### Durable writes (hard requirement)

When `DATABASE_URL` is set, every INSERT, UPDATE, and DELETE on a public Postgres
table **must** be reconstructable from append-only `db_change` with timestamp
(`at`), operation (`op`: INSERT/UPDATE/DELETE), previous row (`before`; null on
INSERT), and new row (`after`; null on DELETE). Example: a display-name change
(`POST /me/name`) **must** produce an UPDATE row with the old and new `name` in
plaintext. A durable write without that trail is forbidden — there **must** be no
gap. Reviewers enforce this; `migrateDbChangeSchema` in `src/lib/db-change.ts` /
`docs/schema/db_change.sql` is the attach path.

- Logging is done by Postgres AFTER INSERT OR UPDATE OR DELETE **row** triggers
  named `trg_db_change` on every `public` table except `db_change` itself — **not**
  by application store methods. New public tables are covered on the next SQL boot
  (`migrateDbChangeSchema` after `migratePushSchema`) once the table exists. A
  missing table **fails** the write; it does not skip the log.
- `db_change` is append-only at runtime. UPDATE, DELETE, and TRUNCATE on it
  **must** fail (exception `db_change is append-only`). `migrateDbChangeSchema`
  may drop that trigger once per boot to hash plaintext `view_key` values that
  still match a live `account.view_key`, then recreates it. Rows whose key no
  longer matches a live account are left unchanged.
- In the stored JSON, secret columns `token`, `challenge`, `nostr_nsec_ciphertext`,
  `nonce`, `view_key`, `endpoint`, `p256dh`, `auth`, and `delivered_endpoints` are SHA-256 hex of the column text. All other columns, including
  `name`, stay plaintext. Do not omit those secret keys from the JSON (rotation
  **must** still be visible as a hash change).
- Compare OLD vs NEW **before** redaction
  (`to_jsonb(OLD) IS NOT DISTINCT FROM to_jsonb(NEW)`). No-op UPDATEs skip the
  log row.
- In-memory boots (`DATABASE_URL` unset) do not migrate `db_change` and have no
  log.

Weakening attach, logging from app code instead of triggers, omitting
`before`/`after`, hashing `name`, dropping a public table from coverage, or
landing a durable write without a `db_change` row in the **same PR** is an
undeclared deviation and is rejected.

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

| Variable               | Default                                 | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BIND_ADDR`            | `0.0.0.0:3000`                          | Listen address                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `SERVICE_VERSION`      | `0.1.0`                                 | Surfaced via `/info`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `DATABASE_URL`         | _(unset → in-memory)_                   | Postgres connection string. When set, auth, `btc_usd_daily`, `message` (plus `message_invoice` and `nostr_zap_ingest`), `contact`, `conversation` / `conversation_message`, `push_subscription`, `push_outbox`, and `db_change` are migrated, `GET /gifts` and `GET /gifts/stats` read `gift` plus persisted BTC-USD daily closes (best-effort boot fill; failures log and do not kill the process), `GET/POST /messages`, `GET /messages/:id`, `GET /messages/:id/replies`, `GET /messages/:id/photo`, and `GET /messages/:id/video.*` (MIME in Postgres, bytes under `MEDIA_DIR`) use `PostgresMessageStore`, `POST /contact` / `GET /debug/contacts` use `PostgresContactStore`, `GET/POST /conversations` and `GET/POST /conversations/:id` use `PostgresConversationStore`, `GET /debug/invoices` and `GET /debug/zap-ingests` list invoice attempts and zap ingest rows, and a matching `POST /invoices/proof` inserts into `gift`. Unset keeps `InMemoryAuthStore`, in-memory forum, contact, conversation, and push stores, empty gift stats, empty day lists, and a no-op gift recorder. |
| `DEBUG_TOKEN`          | _(unset → debug off)_                   | Operator bearer for `GET /debug/accounts`, `POST /debug/accounts`, `PATCH /debug/accounts/:id`, `POST /debug/accounts/:id/session`, `GET /debug/contacts`, `GET /debug/invoices`, `GET /debug/zap-ingests`, `PUT /debug/messages/:id/video`, and `POST /debug/push-ping`. Unset or blank → `503`; the process still boots.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `NIP57_PROBE`          | _(unset → probe on)_                    | Set to `0` to skip the NIP-57 mint probe on `POST /debug/accounts` new addresses (Playwright e2e only). Unset or any other value probes. Production must not set this. The process still boots.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `WEBAUTHN_RP_ID`       | _(none — required for passkey)_         | WebAuthn RP ID (`21.gifts` / `dev.21.gifts` / `localhost`). Passkey routes return `500` until it is set; the process still boots. Not a secret.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `WEBAUTHN_RP_NAME`     | `21.gifts`                              | Human-readable RP name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `CORS_ALLOWED_ORIGINS` | built-in apex / app aliases / localhost | Comma-separated browser origins. Passkey finish keeps those whose hostname is the RP ID or `app.<rpId>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `SPEND_API_TOKEN`      | _(none — optional)_                     | Bearer for spend-worker `POST /invoices` / `POST /invoices/proof`. Unset/blank → **503**; the process still boots.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `BTC_USD_CANDLES_URL`  | Coinbase Exchange BTC-USD candles URL   | Optional override for daily close fetch used by `GET /gifts` and `GET /gifts/stats`. Blank/unset → default Coinbase URL; the process still boots.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `NOSTR_NSEC_KEK`       | _(required with `DATABASE_URL`)_        | 32-byte hex AES-GCM KEK for custodial nsec. With `DATABASE_URL`, missing or malformed KEK **throws at boot**. Memory boots omit it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `NOSTR_PUBLISH`        | _(unset → sign only)_                   | Set to `1` to fan out signed kind:1 notes, replaceable kind:0 profiles, and NIP-65 kind:10002 relay lists over WebSockets. Unchanged kind:0 / kind:10002 content is skipped for the life of the AuthStore instance. Other values do not publish.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `NOSTR_PUBLISH_PUBLIC` | _(unset → space-only published)_        | Set to `1` (with `NOSTR_PUBLISH=1`) to also write kind:1 notes, kind:0 profiles, and kind:10002 relay lists to Damus / Primal / nos.lol. Unset: space ACK is terminal `published`. Does not gate zap ingest or invoice `relays`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `NOSTR_RELAY_URL`      | `wss://relay.nostr.space`               | Compose durability relay (nostr.space). Used when `NOSTR_RELAY_SPACE` is unset.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `NOSTR_RELAY_SPACE`    | _(falls back to `NOSTR_RELAY_URL`)_     | Optional override of the durability relay WebSocket URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `NOSTR_RELAY_PUBLIC`   | Damus, Primal, nos.lol                  | Optional comma-separated public relays. Used for kind:1, kind:0, and kind:10002 write when `NOSTR_PUBLISH_PUBLIC=1`, and always for zap ingest plus invoice `relays` tags (even when that flag is off).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PUBLIC_BASE_URL`      | _(unset → no media URL / no NIP-05)_    | Site origin for public photo/video URLs in kind:1 and the NIP-05 domain (`https://21.gifts` → `https://api.21.gifts` for media; nip05 uses hostname `21.gifts`). Unset or blank → media notes are signed without a URL and NIP-05 is omitted. Not required at boot. Playwright pins it to `http://127.0.0.1:3000`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `MEDIA_DIR`            | _(required — no default)_               | Directory for forum video files. Missing or blank → **throws at boot** (no temp fallback). Image and Compose pin `/data/media`. Not a secret. Vitest setup and Playwright set it for tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `VAPID_PUBLIC_KEY`     | _(unset → push HTTP 503)_               | URL-safe base64 uncompressed P-256 public key (65 decoded bytes). Not a secret. Missing, blank, malformed, or unpaired with a valid private key → push HTTP **503**; the process still boots.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `VAPID_PRIVATE_KEY`    | _(unset → push HTTP 503)_               | URL-safe base64 P-256 private key. Secret. Never log. Pair with `VAPID_PUBLIC_KEY`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `VAPID_SUBJECT`        | `https://21.gifts`                      | VAPID `sub` URI. Optional.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

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
