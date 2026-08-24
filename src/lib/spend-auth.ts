import { timingSafeEqual } from 'node:crypto';

/**
 * Result of checking a spend-worker Bearer token against `SPEND_API_TOKEN`.
 *
 * `unconfigured` maps to HTTP 503 (process boots without the env).
 * `unauthorized` maps to HTTP 401. `ok` means the header matched.
 */
export type SpendAuthStatus = 'unconfigured' | 'unauthorized' | 'ok';

/**
 * Compare a spend-worker Bearer token to the configured secret.
 *
 * Different lengths never call `timingSafeEqual` (it throws). A missing or
 * blank configured token is unconfigured regardless of the header.
 *
 * @param configuredToken - `SPEND_API_TOKEN`, or `undefined` when unset.
 * @param authorizationHeader - Raw `Authorization` header, if present.
 * @returns Status for the invoices routes to map to HTTP.
 */
export function checkSpendAuth(
  configuredToken: string | undefined,
  authorizationHeader: string | undefined,
): SpendAuthStatus {
  if (configuredToken === undefined || configuredToken.trim() === '') {
    return 'unconfigured';
  }
  if (authorizationHeader === undefined || !authorizationHeader.startsWith('Bearer ')) {
    return 'unauthorized';
  }
  const presented = authorizationHeader.slice('Bearer '.length).trim();
  const expected = configuredToken.trim();
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    return 'unauthorized';
  }
  return timingSafeEqual(a, b) ? 'ok' : 'unauthorized';
}
