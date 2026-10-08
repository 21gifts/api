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
  const a = Buffer.from(debugToken.trim(), 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Refuse boot when the write and read debug tokens are the same secret.
 *
 * Trim first. An empty token after trim is not compared. Differing UTF-8
 * lengths return. Equal length plus `timingSafeEqual` throws without
 * interpolating either value.
 *
 * @param writeToken - Operator write token, or `undefined` when unset.
 * @param readToken - Operator read token, or `undefined` when unset.
 * @throws When both trimmed values are non-empty and equal.
 */
export function assertDistinctDebugTokens(
  writeToken: string | undefined,
  readToken: string | undefined,
): void {
  const write = (writeToken ?? '').trim();
  const read = (readToken ?? '').trim();
  if (write === '' || read === '') {
    return;
  }
  const a = Buffer.from(write, 'utf8');
  const b = Buffer.from(read, 'utf8');
  if (a.length !== b.length) {
    return;
  }
  if (timingSafeEqual(a, b)) {
    throw new Error('DEBUG_READ_TOKEN matches DEBUG_TOKEN');
  }
}

/**
 * Classify a Bearer header for `GET /debug/db`.
 *
 * Trim both tokens. Both empty → `unconfigured`. Otherwise the write token
 * is tried first, then the read token. A configured token that does not
 * match is `unauthorized`.
 *
 * @param writeToken - Operator write token, or `undefined` when unset.
 * @param readToken - Operator read token, or `undefined` when unset.
 * @param authorizationHeader - Raw `Authorization` header, or `undefined`.
 * @returns The access class for this request.
 */
export function classifyDebugDbBearer(
  writeToken: string | undefined,
  readToken: string | undefined,
  authorizationHeader: string | undefined,
): 'unconfigured' | 'unauthorized' | 'write' | 'read' {
  const write = (writeToken ?? '').trim();
  const read = (readToken ?? '').trim();
  if (write === '' && read === '') {
    return 'unconfigured';
  }
  if (write !== '' && bearerMatchesDebugToken(write, authorizationHeader)) {
    return 'write';
  }
  if (read !== '' && bearerMatchesDebugToken(read, authorizationHeader)) {
    return 'read';
  }
  return 'unauthorized';
}
