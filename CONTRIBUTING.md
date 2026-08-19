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
│   │   ├── auth.ts           # LNURL-auth: /auth/lnurl, /auth/lnurl/callback, /auth/session
│   │   ├── me.ts             # GET /me; link/unlink + address verification
│   │   └── lightning-address.ts  # GET /lightning-address (public LUD-16 resolve)
│   ├── lib/
│   │   ├── meta.ts           # Service constants (name, version, repo URL)
│   │   ├── config.ts         # Auth + verification TTLs/amounts (no required env for verify)
│   │   ├── lightning-address.ts  # LUD-16 shape check
│   │   ├── invoice-payer.ts  # InvoicePayer port + UnconfiguredInvoicePayer
│   │   ├── lnurlp.ts         # LUD-16 well-known metadata resolve (shared)
│   │   ├── ln-address-cache.ts  # In-memory TTL cache for successful resolves
│   │   ├── lnurl-pay.ts      # LUD-16 → LNURL-pay invoice (amount + LUD-12 comment)
│   │   ├── verification.ts   # Address proof-of-control start/confirm domain logic
│   │   └── auth/
│   │       ├── lnurl.ts      # LUD-04 crypto: k1, lnurl encoding, signature verify
│   │       ├── service.ts    # Challenge lifecycle, account upsert, session issuance
│   │       └── store.ts      # AuthStore port + in-memory adapter (+ verification records)
│   └── __tests__/            # Mirror tree; one *.test.ts per source file
│       ├── server.test.ts
│       ├── helpers/
│       │   └── auth-vectors.ts   # secp256k1 test wallet (coverage-excluded)
│       ├── integration/
│       │   └── auth-flow.test.ts
│       ├── lib/
│       │   ├── meta.test.ts
│       │   ├── config.test.ts
│       │   ├── lightning-address.test.ts
│       │   ├── invoice-payer.test.ts
│       │   ├── lnurlp.test.ts
│       │   ├── ln-address-cache.test.ts
│       │   ├── lnurl-pay.test.ts
│       │   ├── verification.test.ts
│       │   └── auth/
│       │       ├── lnurl.test.ts
│       │       ├── service.test.ts
│       │       └── store.test.ts
│       └── routes/
│           ├── health.test.ts
│           ├── info.test.ts
│           ├── auth.test.ts
│           ├── me.test.ts
│           └── lightning-address.test.ts
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
bun run test:coverage
bun run build
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

| Variable          | Default                      | Purpose                                                                                                             |
| ----------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `BIND_ADDR`       | `0.0.0.0:3000`               | Listen address                                                                                                      |
| `SERVICE_VERSION` | `0.1.0`                      | Surfaced via `/info`                                                                                                |
| `PUBLIC_BASE_URL` | _(none — required for auth)_ | Pinned LNURL-auth callback host (e.g. `https://dev-api.21.gifts`). `GET /auth/lnurl` returns `500` until it is set. |

More will be added as concrete subsystems that need runtime configuration
(relay client, …) land. The LUD-16 metadata cache TTL is a code constant
(`LN_ADDRESS_CACHE_TTL_MS`), not an environment variable.

## CI / CD

| Workflow               | Trigger           | Action                                                                 |
| ---------------------- | ----------------- | ---------------------------------------------------------------------- |
| `ci.yaml`              | PR                | Typecheck + lint + test (100% coverage) + build                        |
| `deploy-dev.yaml`      | push to `develop` | Docker build → push `21gifts/api:beta` → notify infrastructure         |
| `deploy-prd.yaml`      | push to `main`    | Docker build → push `21gifts/api:latest` → notify infrastructure       |
| `auto-release-pr.yaml` | push to `develop` | Auto-create Release PR (`develop → main`)                              |

Images target `linux/arm64`.

Deploy workflows require these GitHub Actions secrets:

| Secret             | Purpose                                              |
| ------------------ | ---------------------------------------------------- |
| `DOCKER_USERNAME`  | Docker Hub username for image push                   |
| `DOCKER_PASSWORD`  | Docker Hub token for image push                      |
| `DISPATCH_TOKEN`   | PAT used to fire `repository_dispatch` after push    |
| `DISPATCH_REPO`    | Target `owner/repo` that receives `image-published`  |

If `DISPATCH_TOKEN` or `DISPATCH_REPO` is missing, notify warns and exits 0 —
the image is already on Hub; DFXServer `probe-published-images.yml` dispatches
`image-published` when the tag moves. Set the secrets for an immediate pull.

## Related repos

- [`21gifts/app`](https://github.com/21gifts/app) — Web frontend client
