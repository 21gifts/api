# 21.gifts — api

Backend service for [21.gifts](https://21.gifts) — a peer-to-peer Bitcoin
Lightning donation platform with NOSTR as the invisible communication substrate.

This repository is the **canonical home** for project-level documentation
(see [`CONCEPT.md`](./CONCEPT.md)). The frontend lives at
[`21gifts/app`](https://github.com/21gifts/app).

## Live

| Environment | Image | URL |
|---|---|---|
| **PRD** | `21gifts/api:latest` | `https://api.21.gifts` |
| **DEV** | `21gifts/api:beta` | `https://dev-api.21.gifts` |

## What this service does

The api is the "thick server" in a thin-client / thick-server architecture.
It handles everything that doesn't have to run client-side:

- **NOSTR fan-out** — accepts signed events from clients, verifies signatures, publishes to relays
- **NOSTR aggregation** — subscribes to relays, indexes events, exposes paginated reads
- **LN-Address resolution + cache** — LUD-16 health-checked, normalized
- **Discovery** — recent campaigns, ordering, future categories / search
- **Anti-abuse** — rate-limiting, spam scoring, malformed-event rejection

It explicitly **does not** hold keys, sign events, or proxy LNURL-pay flows —
those are the app's job.

## Stack

| Layer | Choice |
|---|---|
| Language | Rust (stable) |
| Framework | Axum |
| Project | Cargo workspace (`api`, `shared`) |
| Signature verification | `secp256k1` (Schnorr) |
| Async runtime | Tokio |
| Tracing | `tracing` + `tracing-subscriber` |

## Quick start

```bash
git clone https://github.com/21gifts/api.git
cd api
cargo run -p api
# → http://localhost:3000/healthz
```

## Documentation

| Doc | Purpose |
|---|---|
| [`CONCEPT.md`](./CONCEPT.md) | Project vision, architecture, principles, decisions |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Dev setup, conventions, workflow |
| [`SECURITY.md`](./SECURITY.md) | Reporting vulnerabilities |

## License

MIT — see [`LICENSE`](./LICENSE).
