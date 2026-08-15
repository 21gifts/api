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

## 🐳 Docker images

Pre-built images are published to Docker Hub on every push to `develop` (`:beta`)
and `main` (`:latest`).

| Tag                                                                           | Source    | Deploy target | Public URL                 |
| ----------------------------------------------------------------------------- | --------- | ------------- | -------------------------- |
| [`21gifts/api:beta`](https://hub.docker.com/r/21gifts/api/tags?name=beta)     | `develop` | DEV           | `https://dev-api.21.gifts` |
| [`21gifts/api:latest`](https://hub.docker.com/r/21gifts/api/tags?name=latest) | `main`    | PRD           | `https://api.21.gifts`     |

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

It explicitly **does not** hold keys, sign events, or proxy LNURL-pay flows —
those are the app's job.

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
bun run dev    # → http://localhost:3000/healthz
```

## Local checks (the same gates CI runs)

```bash
bun run typecheck       # tsc --noEmit
bun run lint            # eslint + prettier --check
bun run test:coverage   # vitest with 100% threshold
bun run build           # bun build to dist/
```

## Documentation

| Doc                                    | Purpose                                                             |
| -------------------------------------- | ------------------------------------------------------------------- |
| [`CONCEPT.md`](./CONCEPT.md)           | Project vision, architecture, principles, decisions                 |
| [`SPEC.md`](./SPEC.md)                 | Implemented HTTP surface (request/response contracts)               |
| [`FLOWS.md`](./FLOWS.md)               | Core UI journeys (sign-in → profile → donate → recurring → message) |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Dev setup, conventions, workflow                                    |
| [`SECURITY.md`](./SECURITY.md)         | Reporting vulnerabilities                                           |

## License

MIT — see [`LICENSE`](./LICENSE).
