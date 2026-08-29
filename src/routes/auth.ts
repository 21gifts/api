import { Hono } from 'hono';
import { z } from 'zod';
import { resolveWebAuthnConfig } from '@/lib/config';
import {
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
  startPasskeyAuthentication,
  startPasskeyRegistration,
} from '@/lib/auth/passkey';
import { serializeAccount } from '@/lib/auth/account-json';
import type { AuthStore } from '@/lib/auth/store';
import type { PasskeyCeremony } from '@/lib/auth/webauthn';
import { logEvent } from '@/lib/log';
import type { NostrKeygen } from '@/lib/nostr/keys';

/**
 * Passkey (WebAuthn) HTTP surface. Login is passkey-only; LNURL-auth is gone.
 */

/** Collaborators the auth routes need. */
export interface AuthRouteDeps {
  /** Shared auth persistence port. */
  store: AuthStore;
  /** Clock returning epoch milliseconds (injected for testability). */
  now: () => number;
  /** Browser origins CORS already allows; passkey finish filters these by RP ID. */
  allowedOrigins: string[];
  /** Raw `WEBAUTHN_RP_ID`; `undefined` if unset (passkey routes 500). */
  webAuthnRpId: string | undefined;
  /** Optional `WEBAUTHN_RP_NAME` override. */
  webAuthnRpName: string | undefined;
  /** WebAuthn generate/verify collaborator. */
  passkeyCeremony: PasskeyCeremony;
  /** Optional KEK for custodial Nostr keys. */
  nostrKek?: Uint8Array;
  /** Optional keygen (tests). */
  nostrKeygen?: NostrKeygen;
}

/** Body schema for passkey finish (registration or authentication). */
const passkeyFinishBody = z.object({
  challengeId: z.string(),
  credential: z.unknown(),
});

/**
 * Build the `/auth` route group.
 *
 * @param deps - Shared store, clock, and passkey collaborators.
 * @returns A Hono app exposing passkey register and authenticate routes.
 */
export function authRoutes(deps: AuthRouteDeps): Hono {
  return new Hono()
    .post('/passkey/register/begin', async (c) => {
      const config = webAuthnConfig(deps);
      if (config === null) {
        return c.json({ error: 'Server auth is not configured' }, 500);
      }
      const started = await startPasskeyRegistration(
        deps.store,
        deps.passkeyCeremony,
        config,
        deps.now(),
      );
      return c.json(started, 200);
    })
    .post('/passkey/register/finish', async (c) => {
      const config = webAuthnConfig(deps);
      if (config === null) {
        return c.json({ error: 'Server auth is not configured' }, 500);
      }
      const parsed = passkeyFinishBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with challengeId and credential' }, 400);
      }
      const result = await finishPasskeyRegistration(
        deps.store,
        deps.passkeyCeremony,
        config,
        deps.now(),
        c.req.header('origin'),
        parsed.data.challengeId,
        parsed.data.credential,
        nostrOpts(deps),
      );
      if (!result.ok) {
        return c.json({ error: result.error }, 400);
      }
      logEvent('auth.passkey.register.ok', { accountId: result.value.account.id });
      return c.json(
        { token: result.value.token, account: serializeAccount(result.value.account) },
        200,
      );
    })
    .post('/passkey/authenticate/begin', async (c) => {
      const config = webAuthnConfig(deps);
      if (config === null) {
        return c.json({ error: 'Server auth is not configured' }, 500);
      }
      const started = await startPasskeyAuthentication(
        deps.store,
        deps.passkeyCeremony,
        config,
        deps.now(),
      );
      return c.json(started, 200);
    })
    .post('/passkey/authenticate/finish', async (c) => {
      const config = webAuthnConfig(deps);
      if (config === null) {
        return c.json({ error: 'Server auth is not configured' }, 500);
      }
      const parsed = passkeyFinishBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with challengeId and credential' }, 400);
      }
      const result = await finishPasskeyAuthentication(
        deps.store,
        deps.passkeyCeremony,
        config,
        deps.now(),
        c.req.header('origin'),
        parsed.data.challengeId,
        parsed.data.credential,
        nostrOpts(deps),
      );
      if (!result.ok) {
        return c.json({ error: result.error }, 400);
      }
      logEvent('auth.passkey.login.ok', { accountId: result.value.account.id });
      return c.json(
        { token: result.value.token, account: serializeAccount(result.value.account) },
        200,
      );
    });
}

/**
 * Optional Nostr keygen collaborators for passkey finish.
 *
 * @param deps - Auth route deps.
 * @returns KEK payload, or `undefined` when no KEK is configured.
 */
function nostrOpts(deps: AuthRouteDeps): { kek: Uint8Array; keygen?: NostrKeygen } | undefined {
  if (deps.nostrKek === undefined) {
    return undefined;
  }
  /* v8 ignore start */
  return deps.nostrKeygen === undefined
    ? { kek: deps.nostrKek }
    : { kek: deps.nostrKek, keygen: deps.nostrKeygen };
  /* v8 ignore stop */
}

/**
 * Resolve WebAuthn config for this request, or `null` when the RP ID is missing
 * or no CORS origin matches it.
 *
 * @param deps - Auth route collaborators.
 * @returns Runtime config, or `null`.
 */
function webAuthnConfig(deps: AuthRouteDeps): ReturnType<typeof resolveWebAuthnConfig> {
  return resolveWebAuthnConfig(
    {
      WEBAUTHN_RP_ID: deps.webAuthnRpId,
      WEBAUTHN_RP_NAME: deps.webAuthnRpName,
    },
    deps.allowedOrigins,
  );
}
