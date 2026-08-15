/**
 * Auth and verification configuration.
 *
 * Configuration is read from the environment only (no config files, per
 * CONTRIBUTING). `PUBLIC_BASE_URL` is security-relevant: it pins the
 * LNURL-auth callback host, which is the domain the wallet derives its
 * `linkingKey` against. A wrong host would silently split account identities,
 * so a missing or empty value is treated as a hard misconfiguration rather
 * than a guessed default. Verification TTL and micro-payment amounts for
 * Lightning Address proof-of-control also live here.
 */

/** Lifetime of an unclaimed LNURL-auth `k1` challenge, in milliseconds. */
export const CHALLENGE_TTL_MS = 10 * 60 * 1000;

/** Lifetime of an issued session token, in milliseconds. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Lifetime of a pending Lightning Address verification, in milliseconds. */
export const VERIFICATION_TTL_MS = 15 * 60 * 1000;

/** Preferred verification micro-payment amount, in millisatoshis (1 sat). */
export const VERIFICATION_AMOUNT_MSAT = 1_000;

/**
 * Maximum amount the api will pay for verification, in millisatoshis (10 sat).
 * If the provider's `minSendable` exceeds this, verification is refused.
 */
export const VERIFICATION_AMOUNT_CAP_MSAT = 10_000;

/** In-memory TTL for a successful LUD-16 metadata resolve, in milliseconds. */
export const LN_ADDRESS_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Normalise the configured public base URL used to build LNURL-auth callbacks.
 *
 * Trims surrounding whitespace and strips any trailing slashes so callback
 * URLs concatenate cleanly. A missing or blank value yields `null` — the
 * caller turns that into a fail-closed `500`, never a guessed host.
 *
 * @param raw - The raw `PUBLIC_BASE_URL` value (or `undefined` when unset).
 * @returns The normalised base URL, or `null` when unset or blank.
 */
export function normalizePublicBaseUrl(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') {
    return null;
  }
  return raw.trim().replace(/\/+$/, '');
}

/**
 * Browser origins allowed to call the api by default — the 21.gifts app
 * surfaces (prd, dev, and local dev). These are public, fixed hostnames, not
 * secrets; `CORS_ALLOWED_ORIGINS` overrides them when a different surface needs
 * cross-origin access.
 */
const DEFAULT_ALLOWED_ORIGINS = [
  'https://app.21.gifts',
  'https://dev-app.21.gifts',
  'http://localhost:3000',
];

/**
 * Resolve the browser origins that CORS should allow.
 *
 * @param env - Environment slice (injected so tests need not mutate the real env).
 * @returns The origins from `CORS_ALLOWED_ORIGINS` (comma-separated) when set,
 * otherwise the default 21.gifts app surfaces.
 */
export function resolveAllowedOrigins(env: Record<string, string | undefined>): string[] {
  const raw = env['CORS_ALLOWED_ORIGINS'];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_ALLOWED_ORIGINS;
  }
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
}
