# 21.gifts — api

[![Docker Hub](https://img.shields.io/badge/Docker%20Hub-21gifts%2Fapi-2496ED?logo=docker&logoColor=white)](https://hub.docker.com/r/21gifts/api)
[![Image size (beta)](https://img.shields.io/docker/image-size/21gifts/api/beta?label=beta%20size)](https://hub.docker.com/r/21gifts/api/tags?name=beta)
[![Image size (latest)](https://img.shields.io/docker/image-size/21gifts/api/latest?label=latest%20size)](https://hub.docker.com/r/21gifts/api/tags?name=latest)
[![Pulls](https://img.shields.io/docker/pulls/21gifts/api?label=pulls)](https://hub.docker.com/r/21gifts/api)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Backend service for [21.gifts](https://21.gifts) — a peer-to-peer Bitcoin
Lightning donation platform with NOSTR as the invisible communication substrate.

This repository is the **canonical home** for project-level documentation
(see [`CONCEPT.md`](./CONCEPT.md)). The implemented HTTP surface is documented
in [`SPEC.md`](./SPEC.md). The frontend lives at
[`21gifts/app`](https://github.com/21gifts/app).

21.gifts stands on three convictions: giving is a duty of every
Christian; the best gift travels from one person to another with no
middleman; Bitcoin is the most effective money available today. The
argument is in [`CONCEPT.md`](./CONCEPT.md) (Convictions) and on
[`21.gifts/about`](https://21.gifts/about).

## 🐳 Docker images

Pre-built images are published to Docker Hub on every push to `develop` (`:beta`),
`staging` (`:staging`), and `main` (`:latest`).

| Tag                                                                             | Source    | Deploy target | Public URL                     |
| ------------------------------------------------------------------------------- | --------- | ------------- | ------------------------------ |
| [`21gifts/api:beta`](https://hub.docker.com/r/21gifts/api/tags?name=beta)       | `develop` | DEV           | `https://dev-api.21.gifts`     |
| [`21gifts/api:staging`](https://hub.docker.com/r/21gifts/api/tags?name=staging) | `staging` | staging       | `https://staging-api.21.gifts` |
| [`21gifts/api:latest`](https://hub.docker.com/r/21gifts/api/tags?name=latest)   | `main`    | PRD           | `https://api.21.gifts`         |

**Pull and run locally:**

```bash
docker run --rm -p 3000:3000 21gifts/api:beta
# → http://localhost:3000/healthz
```

Full image list and history: **[hub.docker.com/r/21gifts/api](https://hub.docker.com/r/21gifts/api/tags)**.

## What this service does

The api is the "thick server" in a thin-client / thick-server architecture.
It handles everything that doesn't have to run client-side:

- **NOSTR fan-out** — accepts signed events from clients, verifies signatures, publishes to the shared `nostr.space` relay
- **NOSTR aggregation** — subscribes to the relay, indexes events, exposes paginated reads
- **LN-Address resolution + caching** — LUD-16 endpoints health-checked and normalized
- **Discovery** — recent campaigns, ordering, future categories / search
- **Anti-abuse** — rate-limiting, spam scoring, malformed-event rejection

It explicitly **does not** hold keys or sign events for the non-custodial
target (v1 signs custodial identities server-side). Guest Donate LNURL-pay
is paid in the browser; for a member's wallet address this api forwards the
LNURL metadata and invoice callback, so it sees the amount and the invoice,
but it never pays or holds funds. The spend-worker path is the exception
(`POST /invoices` fetches a recipient BOLT11, this api still does not pay).

## Stack

| Layer       | Choice                          |
| ----------- | ------------------------------- |
| Runtime     | [Bun](https://bun.sh) ≥ 1.3     |
| Language    | TypeScript (strict)             |
| Framework   | [Hono](https://hono.dev)        |
| Test runner | Vitest + `@vitest/coverage-v8`  |
| Lint        | ESLint (flat config) + Prettier |
| Validation  | Zod                             |

All non-trivial functions ship with TSDoc. Coverage is hard-gated at 100%
(lines, branches, functions, statements) on the activated surface — CI red
otherwise.

## Quick start

```bash
git clone https://github.com/21gifts/api.git
cd api
bun install
MEDIA_DIR="$(mktemp -d)" bun run dev    # → http://localhost:3000/healthz
```

## Local checks (the same gates CI runs)

```bash
bun run typecheck       # tsc --noEmit
bun run lint            # eslint + prettier --check
bun run handbook:check  # every function and HTTP endpoint must be documented
bun run e2e:check       # every HTTP endpoint request and Function: <Name> title
bun run test:coverage   # vitest with 100% threshold
# Postgres driver (Bun test, not Vitest); fails if DATABASE_URL is missing
DATABASE_URL=postgres://gifts:gifts@127.0.0.1:5432/gifts bun run test:postgres
bun run build           # bun build to dist/
bun run e2e             # Playwright against bun src/index.ts
```

## Runtime configuration

| Variable               | Required          | Purpose                                                                                                                                                  |
| ---------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEDIA_DIR`            | yes               | Directory for forum video files. Missing or blank → process does not boot. Image/Compose pin `/data/media`. Not a secret.                                |
| `WEBAUTHN_RP_ID`       | For passkey login | WebAuthn RP ID (`21.gifts` / `dev.21.gifts` / `staging.21.gifts` / `localhost`). Missing → passkey routes return 500; process still boots. Not a secret. |
| `WEBAUTHN_RP_NAME`     | no                | Human-readable RP name (default `21.gifts`).                                                                                                             |
| `CORS_ALLOWED_ORIGINS` | no                | Comma-separated browser origins. Passkey finish allows those whose hostname is the RP ID or `app.<rpId>` only.                                           |
| `LOGINS_OPEN_DEFAULT`  | no                | Login switch until an operator sets it: `open` (default) or `closed`. Any other value stops the boot. Not a secret.                                      |
| `APP_BUILD_REQUIRED`   | no                | App build id that session-creating requests must send in `X-App-Build`. Unset or blank → no check. Not a secret.                                         |

## Documentation

| Doc                                                                    | Purpose                                                                                                                                                                                             |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`docs/shop-identity.md`](./docs/shop-identity.md)                     | Every shop gets its own NOSTR identity and page `/{npub}`, shared with OpenCryptoPay (concept only, not implemented)                                                                                |
| [`CONCEPT.md`](./CONCEPT.md)                                           | Project vision, architecture, principles, decisions                                                                                                                                                 |
| [`SPEC.md`](./SPEC.md)                                                 | Implemented HTTP surface (request/response contracts)                                                                                                                                               |
| [`FLOWS.md`](./FLOWS.md)                                               | Core UI journeys (sign-in → profile → donate → recurring → message)                                                                                                                                 |
| [`docs/social-recovery.md`](./docs/social-recovery.md)                 | Optional securing of the account by choosing two people (concept only, not implemented)                                                                                                             |
| [`docs/shop-stablecoin-payment.md`](./docs/shop-stablecoin-payment.md) | Shop QR stays OpenCryptoPay; USDT or USDC on fixed EVM chains goes to Orchestra, which pays one BOLT11 to the shop (implemented; stablecoin rows only when the four shop payment variables resolve) |
| [`docs/shop-stablecoin-staging-e2e.md`](./docs/shop-stablecoin-staging-e2e.md) | Record of one live staging payment (Polygon USDT, 2026-10-22) and the manual script that can repeat it. It does not close the release checks. |
| [`docs/wallet-release-payouts.md`](./docs/wallet-release-payouts.md)   | Daily payouts across the in-app wallet release: who is paid today, why each keeps being paid on the wallet only, and what release day needs                                                         |
| [`docs/handbook/`](./docs/handbook/)                                   | Mandatory: every function and HTTP endpoint                                                                                                                                                         |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md)                                 | Dev setup, conventions, workflow                                                                                                                                                                    |
| [`SECURITY.md`](./SECURITY.md)                                         | Reporting vulnerabilities                                                                                                                                                                           |

## License

MIT — see [`LICENSE`](./LICENSE).
