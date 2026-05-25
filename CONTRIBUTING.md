# Contributing to 21.gifts api

## Quick start

```bash
git clone https://github.com/21gifts/api.git
cd api
cargo run -p api
# → http://localhost:3000/healthz
```

## Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Rust | stable (current) | Pinned via [`rust-toolchain.toml`](./rust-toolchain.toml) |
| Cargo | (bundled) | Package manager |

`rustup` honors the toolchain file automatically on first `cargo` invocation.

## Project structure

```
api/
├── api/                  # Main service crate
│   ├── src/
│   │   └── main.rs       # Axum entrypoint
│   └── Cargo.toml
├── shared/               # Types shared across future crates
│   ├── src/
│   │   └── lib.rs
│   └── Cargo.toml
├── Cargo.toml            # Workspace manifest
├── rust-toolchain.toml
├── Dockerfile            # Multi-stage Rust build
├── CONCEPT.md            # Canonical project documentation
├── README.md
├── CONTRIBUTING.md
├── SECURITY.md
└── LICENSE
```

## Git workflow

### Branches

| Branch | Purpose | Deploy target |
|---|---|---|
| `develop` | Default branch, active development | DEV |
| `main` | Production releases | PRD |

- Push to `develop` via **feature branch + PR**
- `main` is protected — updates flow via an auto-generated Release PR (`develop → main`)
- Never force-push, never amend published commits

### Commit messages

English, concise, describe *what* changed.

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

### Rust

- **Strict clippy** — `cargo clippy --all-targets --all-features -- -D warnings` must pass
- **Format** — `cargo fmt --all` before commit; CI checks with `--check`
- No `println!` / `dbg!` in committed code (use `tracing` macros: `info!`, `debug!`, `warn!`, `error!`)
- No unwraps in non-test code unless invariant is obvious + commented

### Before every push

```bash
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo build --release
cargo test
```

CI will catch the same things; failing locally first is faster.

## Docker

The service runs as a single static binary in a slim Debian container:

```bash
docker build -t 21gifts/api:dev .
docker run -p 3000:3000 -e RUST_LOG=info 21gifts/api:dev
```

Configuration is read from environment variables only — no config files. See
[`api/src/main.rs`](./api/src/main.rs) for the current variable list.

## CI / CD

| Workflow | Trigger | Action |
|---|---|---|
| `ci.yaml` | PR | Lint + build + test |
| `deploy-dev.yaml` | push to `develop` | Build → push `21gifts/api:beta` |
| `deploy-prd.yaml` | push to `main` | Build → push `21gifts/api:latest` |
| `auto-release-pr.yaml` | push to `develop` | Auto-create Release PR (`develop → main`) |

Images target `linux/arm64`.

## Related repos

- [`21gifts/app`](https://github.com/21gifts/app) — Web frontend client
