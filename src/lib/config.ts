/**
 * Auth, verification, and gift-invoice configuration.
 *
 * Configuration is read from the environment only (no config files, per
 * CONTRIBUTING). `PUBLIC_BASE_URL` is security-relevant: it pins the
 * LNURL-auth callback host, which is the domain the wallet derives its
 * `linkingKey` against. A wrong host would silently split account identities,
 * so a missing or empty value is treated as a hard misconfiguration rather
 * than a guessed default. `WEBAUTHN_RP_ID` pins the passkey relying party
 * the same way (missing → passkey routes 500; the process still boots).
 * Verification TTL and micro-payment amounts for Lightning Address
 * proof-of-control also live here, as does the in-memory LUD-16 metadata
 * cache TTL (`LN_ADDRESS_CACHE_TTL_MS` — a code constant, not an
 * environment variable).
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

/** Minimum gift invoice amount, in millisatoshis (1 sat). */
export const GIFT_INVOICE_MIN_MSAT = 1_000;

/** Maximum gift invoice amount, in millisatoshis (10 million sats). */
export const GIFT_INVOICE_MAX_MSAT = 10_000_000_000;

/** Lifetime of an unpaid gift invoice awaiting proof, in milliseconds. */
export const GIFT_INVOICE_TTL_MS = 15 * 60 * 1000;

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
 * Browser origins allowed to call the api by default — the 21.gifts apex
 * (prd, dev), transitional app-subdomain aliases, and local dev. These are
 * public, fixed hostnames, not secrets; `CORS_ALLOWED_ORIGINS` overrides them
 * when a different surface needs cross-origin access.
 */
const DEFAULT_ALLOWED_ORIGINS = [
  'https://21.gifts',
  'https://dev.21.gifts',
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

/**
 * Normalise `WEBAUTHN_RP_ID`. A missing or blank value yields `null` — passkey
 * routes fail closed rather than guessing `localhost` or the apex.
 *
 * @param raw - The raw env value, or `undefined` when unset.
 * @returns The trimmed RP ID, or `null`.
 */
export function normalizeWebAuthnRpId(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') {
    return null;
  }
  return raw.trim();
}

/**
 * Extra hostname label allowed in front of the RP ID (transitional `app.*`
 * alias). `dev.21.gifts` must not match RP ID `21.gifts`.
 */
const WEBAUTHN_RP_EXTRA_LABELS = new Set(['app']);

/**
 * Origins whose hostname is the RP ID, or `app.<rpId>`.
 *
 * `https://app.21.gifts` matches RP ID `21.gifts`; `https://dev.21.gifts` and
 * `http://localhost:3000` do not. Invalid origin strings are dropped.
 *
 * @param rpId - Configured WebAuthn RP ID.
 * @param allowedOrigins - CORS allowlist (or an override).
 * @returns Origins that may complete a ceremony for `rpId`.
 */
export function expectedOriginsForRpId(rpId: string, allowedOrigins: string[]): string[] {
  return allowedOrigins.filter((origin) => {
    try {
      const host = new URL(origin).hostname;
      if (host === rpId) {
        return true;
      }
      if (!host.endsWith(`.${rpId}`)) {
        return false;
      }
      const prefix = host.slice(0, -(rpId.length + 1));
      return WEBAUTHN_RP_EXTRA_LABELS.has(prefix);
    } catch {
      return false;
    }
  });
}

/**
 * Resolved WebAuthn relying-party config used by the passkey routes.
 */
export interface WebAuthnRuntimeConfig {
  /** RP ID presented to authenticators. */
  rpId: string;
  /** Human-readable RP name. */
  rpName: string;
  /** Origins allowed to finish a ceremony for this RP ID. */
  expectedOrigins: string[];
}

/**
 * Resolve WebAuthn runtime config from the environment and CORS origins.
 *
 * @param env - Environment slice (injected so tests need not mutate process env).
 * @param allowedOrigins - Browser origins CORS already allows.
 * @returns The config, or `null` when the RP ID is missing or no origin matches it.
 */
export function resolveWebAuthnConfig(
  env: Record<string, string | undefined>,
  allowedOrigins: string[],
): WebAuthnRuntimeConfig | null {
  const rpId = normalizeWebAuthnRpId(env['WEBAUTHN_RP_ID']);
  if (rpId === null) {
    return null;
  }
  const expectedOrigins = expectedOriginsForRpId(rpId, allowedOrigins);
  if (expectedOrigins.length === 0) {
    return null;
  }
  const rpNameRaw = env['WEBAUTHN_RP_NAME'];
  const rpName = rpNameRaw === undefined || rpNameRaw.trim() === '' ? '21.gifts' : rpNameRaw.trim();
  return { rpId, rpName, expectedOrigins };
}
