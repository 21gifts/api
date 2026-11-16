/**
 * Classify an Authorization header for the HTTP audit log.
 *
 * Key tokens of the operator SSH key login go through
 * {@link OperatorLogin.resolveBearer}. Session tokens go through
 * {@link resolveSession}.
 */

import { resolveSession } from '@/lib/auth/service';
import type { AuthStore } from '@/lib/auth/store';
import type { ApiLogAuthKind } from '@/lib/api-log';
import type { OperatorKeyGrant, OperatorLogin } from '@/lib/operator-login';

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
  /** Operator name when the bearer is a key token of the SSH key login; else null. */
  operator: string | null;
}

/**
 * Classify `Authorization` as debug, session, or none.
 *
 * A valid key token of the SSH key login is `debug` with the operator name;
 * it is the only bearer classed `debug`. When `keyGrant` is given (the
 * grant resolved when the request arrived, or `null` for no key token), it is
 * used as is and the token row is not looked up again.
 *
 * @param args - Header, stores, clock, the optional key login, and the optional `keyGrant` carried from the request start.
 * @returns Auth kind, optional account id, and the operator name of a key token. Never returns the token.
 * @throws Rejects when the operator token store or the session store rejects a lookup.
 */
export async function resolveRequestAuth(args: {
  authorizationHeader: string | undefined;
  authStore: AuthStore;
  now: number;
  operatorLogin?: OperatorLogin | undefined;
  keyGrant?: OperatorKeyGrant | null | undefined;
}): Promise<RequestAuth> {
  const grant =
    args.keyGrant !== undefined
      ? args.keyGrant
      : ((await args.operatorLogin?.resolveBearer(args.authorizationHeader, args.now)) ?? null);
  if (grant !== null) {
    return { accountId: null, authKind: 'debug', operator: grant.operator };
  }
  const token = sessionBearerToken(args.authorizationHeader);
  if (token === null) {
    return { accountId: null, authKind: 'none', operator: null };
  }
  const account = await resolveSession(args.authStore, args.now, token);
  if (account === null) {
    return { accountId: null, authKind: 'none', operator: null };
  }
  return { accountId: account.id, authKind: 'session', operator: null };
}
