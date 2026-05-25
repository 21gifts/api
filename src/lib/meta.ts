/**
 * Centralised service metadata.
 *
 * Kept as a single module so any route, log line, or telemetry annotation
 * that references the service identity points at one source of truth.
 * Bumping the version here propagates to `/healthz`, `/info`, and any future
 * surface that consumes these constants.
 */

/** Stable machine-readable service name. Surfaced in `/healthz` and `/info`. */
export const SERVICE_NAME = '21gifts-api' as const;

/**
 * Semantic version of the running build.
 *
 * Sourced from `process.env.SERVICE_VERSION` at startup so it can be supplied
 * by a Docker build arg, falling back to a conservative default for local
 * dev runs that don't set it.
 */
export const SERVICE_VERSION: string = process.env['SERVICE_VERSION'] ?? '0.1.0';

/** Human-readable one-liner shown by `/info`. */
export const SERVICE_DESCRIPTION =
  'Backend for 21.gifts — peer-to-peer Bitcoin Lightning donations with NOSTR-native communication.';

/** Canonical repository URL — referenced by `/info`. */
export const SERVICE_REPO_URL = 'https://github.com/21gifts/api';
