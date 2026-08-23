import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time compare of a configured debug token against an Authorization header.
 *
 * @param debugToken - The configured operator token (already known to be non-empty).
 * @param authorizationHeader - Raw `Authorization` header, or `undefined`.
 * @returns True only when the header is `Bearer <debugToken>`.
 */
export function bearerMatchesDebugToken(
  debugToken: string,
  authorizationHeader: string | undefined,
): boolean {
  if (authorizationHeader === undefined || !authorizationHeader.startsWith('Bearer ')) {
    return false;
  }
  const provided = authorizationHeader.slice('Bearer '.length).trim();
  const a = Buffer.from(debugToken, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
