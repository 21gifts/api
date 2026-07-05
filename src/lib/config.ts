/**
 * Auth-subsystem configuration.
 *
 * Configuration is read from the environment only (no config files, per
 * CONTRIBUTING). `PUBLIC_BASE_URL` is security-relevant: it pins the
 * LNURL-auth callback host, which is the domain the wallet derives its
 * `linkingKey` against. A wrong host would silently split account identities,
 * so a missing or empty value is treated as a hard misconfiguration rather
 * than a guessed default.
 */

/** Lifetime of an unclaimed LNURL-auth `k1` challenge, in milliseconds. */
export const CHALLENGE_TTL_MS = 10 * 60 * 1000;

/** Lifetime of an issued session token, in milliseconds. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
