# Multi-stage Docker build for the 21.gifts api service.
#
# Build:
#   docker build -t 21gifts/api:beta .
#   docker build -t 21gifts/api:latest .
#
# Run:
#   docker run -p 3000:3000 21gifts/api:latest
#
# Configuration is environment-variable only; see CONTRIBUTING.md.

FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock* bun.lockb* ./
# Install with dev deps (vitest/tsc/eslint not strictly needed at runtime but
# kept here so the same dep layer is reusable for tooling steps if added later).
RUN bun install --frozen-lockfile

FROM oven/bun:1.3-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun build src/index.ts --target=bun --outdir=dist

FROM oven/bun:1.3-alpine
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app \
  && mkdir -p /data/media && chown app:app /data/media
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/public ./public
USER app

ENV BIND_ADDR=0.0.0.0:3000
EXPOSE 3000

CMD ["bun", "run", "dist/index.js"]
