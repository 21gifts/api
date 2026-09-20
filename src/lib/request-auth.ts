/**
 * Classify an Authorization header for the HTTP audit log.
 *
 * Debug and spend tokens are compared with the same constant-time helper as
 * the debug routes. Session tokens go through {@link resolveSession}.
 */

import { resolveSession } from '@/lib/auth/service';
import type { AuthStore } from '@/lib/auth/store';
import type { ApiLogAuthKind } from '@/lib/api-log';
import { bearerMatchesDebugToken } from '@/lib/debug-token';

function sessionBearerToken(header: string | undefined): string | null {
  if (header === undefined || !header.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice('Bearer '.length).trim();
  return token === '' ? null : token;
}

/** Resolved bearer class for one request. */
export interface RequestAuth {
  /** Session account id when `authKind` is `session`; else null. */
  accountId: string | null;
  /** Bearer class. */
  authKind: ApiLogAuthKind;
}

/**
 * Classify `Authorization` as debug, spend, session, or none.
 *
 * @param args - Header, stores, clock, and configured tokens.
 * @returns Auth kind and optional account id. Never returns the token.
 */
export async function resolveRequestAuth(args: {
  authorizationHeader: string | undefined;
  authStore: AuthStore;
  now: number;
  debugToken: string | undefined;
  spendApiToken: string | undefined;
}): Promise<RequestAuth> {
  const debugToken = args.debugToken?.trim() ?? '';
  if (debugToken !== '' && bearerMatchesDebugToken(debugToken, args.authorizationHeader)) {
    return { accountId: null, authKind: 'debug' };
  }
  const spendToken = args.spendApiToken?.trim() ?? '';
  if (spendToken !== '' && bearerMatchesDebugToken(spendToken, args.authorizationHeader)) {
    return { accountId: null, authKind: 'spend' };
  }
  const token = sessionBearerToken(args.authorizationHeader);
  if (token === null) {
    return { accountId: null, authKind: 'none' };
  }
  const account = await resolveSession(args.authStore, args.now, token);
  if (account === null) {
    return { accountId: null, authKind: 'none' };
  }
  return { accountId: account.id, authKind: 'session' };
}
