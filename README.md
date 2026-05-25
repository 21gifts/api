# 21.gifts — api

Backend service for [21.gifts](https://21.gifts) — a peer-to-peer Bitcoin
Lightning donation platform with NOSTR as the invisible communication substrate.

This repository is the **canonical home** for project-level documentation
(see [`CONCEPT.md`](./CONCEPT.md)). The frontend lives at
[`21gifts/app`](https://github.com/21gifts/app).

## Live

| Environment | Image                | URL                        |
| ----------- | -------------------- | -------------------------- |
| **PRD**     | `21gifts/api:latest` | `https://api.21.gifts`     |
| **DEV**     | `21gifts/api:beta`   | `https://dev-api.21.gifts` |

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

| Doc                                    | Purpose                                             |
| -------------------------------------- | --------------------------------------------------- |
| [`CONCEPT.md`](./CONCEPT.md)           | Project vision, architecture, principles, decisions |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Dev setup, conventions, workflow                    |
| [`SECURITY.md`](./SECURITY.md)         | Reporting vulnerabilities                           |

## License

MIT — see [`LICENSE`](./LICENSE).
