# Multi-stage Docker build for the 21.gifts api service.
#
# Build:
#   docker build -t 21gifts/api:beta .
#   docker build -t 21gifts/api:latest .
#
# Run:
#   docker run -p 3000:3000 -e RUST_LOG=info 21gifts/api:latest
#
# Configuration is environment-variable only; see api/src/main.rs.

FROM rust:bookworm AS builder
WORKDIR /app

COPY rust-toolchain.toml ./
RUN rustup show

COPY . .

RUN cargo build --release -p api

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/api /usr/local/bin/api

ENV RUST_LOG=info
ENV BIND_ADDR=0.0.0.0:3000
EXPOSE 3000

ENTRYPOINT ["api"]
