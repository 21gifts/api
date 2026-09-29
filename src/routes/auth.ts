import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { resolveWebAuthnConfig } from '@/lib/config';
import {
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
  finishPasskeySeed,
  startPasskeyAuthentication,
  startPasskeyClaim,
  startPasskeyRegistration,
  startPasskeySeed,
} from '@/lib/auth/passkey';
import { serializeOwnerAccountWithPosts } from '@/lib/auth/account-json';
import { resolveSession } from '@/lib/auth/service';
import { WRONG_ACCOUNT_ERROR } from '@/lib/auth/wrong-account';
import { InMemoryFundingStore, type FundingStore } from '@/lib/funding-store';
import type { AuthStore } from '@/lib/auth/store';
import type { PasskeyCeremony } from '@/lib/auth/webauthn';
import { logEvent } from '@/lib/log';
import type { MessageStore } from '@/lib/message-store';
import type { NostrKeygen } from '@/lib/nostr/keys';
import { normalizeUsername } from '@/lib/username';
import { bearerToken } from '@/routes/me';

/**
 * Passkey (WebAuthn) HTTP surface. Login is passkey-only; LNURL-auth is gone.
 */

/** Collaborators the auth routes need. */
export interface AuthRouteDeps {
  /** Shared auth persistence port. */
  store: AuthStore;
  /** Forum persistence (live-post lookup and profile-note About me). */
  messages: Pick<MessageStore, 'accountHasLivePost' | 'getById'>;
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
  /**
   * Funding grants for owner JSON (default: empty {@link InMemoryFundingStore}).
   */
  fundingStore?: FundingStore;
}

/** Body schema for passkey finish (registration or authentication). */
const passkeyFinishBody = z.object({
  challengeId: z.string(),
  credential: z.unknown(),
});

/** Real ceremony ids are 64 lowercase hex characters. Anything else is not logged. */
const LOGGED_CHALLENGE_ID = /^[0-9a-f]{64}$/;

function passkeyFailFields(
  challengeId: string,
  error: string,
): { error: string; challengeId?: string } {
  if (LOGGED_CHALLENGE_ID.test(challengeId)) {
    return { challengeId, error };
  }
  return { error };
}

/**
 * Record a seed-path passkey renew row. Unexported so it does not need a
 * handbook heading. Does not change the account row.
 */
async function recordPasskeySeedAttempt(
  deps: AuthRouteDeps,
  accountId: string,
  userAgent: string | undefined,
  stage: 'begin' | 'finish',
  outcome: 'failed' | 'succeeded',
  httpStatus: number | null,
  message: string | null,
): Promise<void> {
  await deps.store.insertPasskeyRenewAttempt({
    id: randomUUID(),
    accountId,
    createdAt: deps.now(),
    stage,
    outcome,
    errorName: null,
    errorCode: null,
    httpStatus,
    message,
    userAgent: userAgent ?? null,
  });
}

/**
 * Build the `/auth` route group.
 *
 * @param deps - Shared store, message store, clock, and passkey collaborators.
 * @returns A Hono app exposing passkey register, authenticate, replace, and seed routes.
 */
export function authRoutes(deps: AuthRouteDeps): Hono {
  return new Hono()
    .post('/passkey/register/begin', async (c) => {
      const config = webAuthnConfig(deps);
      if (config === null) {
        return c.json({ error: 'Server auth is not configured' }, 500);
      }
      const body = await c.req.json().catch(() => null);
      if (body !== null && typeof body === 'object' && !Array.isArray(body) && 'viewKey' in body) {
        const viewKey = (body as { viewKey: unknown }).viewKey;
        if (typeof viewKey !== 'string') {
          return c.json({ error: 'Expected a JSON body with an optional "viewKey" string' }, 400);
        }
        const claimed = await startPasskeyClaim(
          deps.store,
          deps.passkeyCeremony,
          config,
          deps.now(),
          viewKey,
        );
        if (!claimed.ok) {
          const status = claimed.error === 'This profile already has a passkey' ? 409 : 404;
          return c.json({ error: claimed.error }, status);
        }
        return c.json(claimed.value, 200);
      }
      if (body !== null && typeof body === 'object' && !Array.isArray(body) && 'name' in body) {
        const name = (body as { name: unknown }).name;
        if (typeof name !== 'string') {
          return c.json({ error: 'Expected a JSON body with an optional "name" string' }, 400);
        }
        const requestedName = normalizeUsername(name);
        if (requestedName === null) {
          return c.json(
            {
              error: 'Username must be 1–32 characters of a-z, 0-9, hyphen, underscore, or dot',
            },
            400,
          );
        }
        if ((await deps.store.getAccountByUsername(requestedName)) !== undefined) {
          return c.json({ error: 'Username is already in use' }, 409);
        }
        const started = await startPasskeyRegistration(
          deps.store,
          deps.passkeyCeremony,
          config,
          deps.now(),
          requestedName,
        );
        return c.json(started, 200);
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
        logEvent(
          'auth.passkey.register.fail',
          passkeyFailFields(parsed.data.challengeId, result.error),
        );
        const status =
          result.error === WRONG_ACCOUNT_ERROR
            ? 403
            : result.error === 'Username is already in use'
              ? 409
              : 400;
        return c.json({ error: result.error }, status);
      }
      logEvent('auth.passkey.register.ok', { accountId: result.value.account.id });
      return c.json(
        {
          token: result.value.token,
          account: await serializeOwnerAccountWithPosts(result.value.account, deps.messages, {
            store: deps.fundingStore ?? new InMemoryFundingStore(),
            nowMs: deps.now(),
            authStore: deps.store,
          }),
        },
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
        logEvent(
          'auth.passkey.login.fail',
          passkeyFailFields(parsed.data.challengeId, result.error),
        );
        const status = result.error === WRONG_ACCOUNT_ERROR ? 403 : 400;
        return c.json({ error: result.error }, status);
      }
      logEvent('auth.passkey.login.ok', { accountId: result.value.account.id });
      return c.json(
        {
          token: result.value.token,
          account: await serializeOwnerAccountWithPosts(result.value.account, deps.messages, {
            store: deps.fundingStore ?? new InMemoryFundingStore(),
            nowMs: deps.now(),
            authStore: deps.store,
          }),
        },
        200,
      );
    })
    .post('/passkey/replace/begin', async (c) => {
      const config = webAuthnConfig(deps);
      if (config === null) {
        return c.json({ error: 'Server auth is not configured' }, 500);
      }
      const token = bearerToken(c.req.header('authorization'));
      if (token === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const account = await resolveSession(deps.store, deps.now(), token);
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      logEvent('auth.passkey.replace.refused', { accountId: account.id });
      return c.json({ error: 'A recovery phrase cannot be replaced' }, 409);
    })
    .post('/passkey/replace/finish', async (c) => {
      const config = webAuthnConfig(deps);
      if (config === null) {
        return c.json({ error: 'Server auth is not configured' }, 500);
      }
      const token = bearerToken(c.req.header('authorization'));
      if (token === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const account = await resolveSession(deps.store, deps.now(), token);
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      logEvent('auth.passkey.replace.refused', { accountId: account.id });
      return c.json({ error: 'A recovery phrase cannot be replaced' }, 409);
    })
    .post('/passkey/seed/begin', async (c) => {
      const config = webAuthnConfig(deps);
      if (config === null) {
        return c.json({ error: 'Server auth is not configured' }, 500);
      }
      const token = bearerToken(c.req.header('authorization'));
      if (token === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const account = await resolveSession(deps.store, deps.now(), token);
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const started = await startPasskeySeed(
        deps.store,
        deps.passkeyCeremony,
        config,
        deps.now(),
        account,
      );
      if (!('challengeId' in started)) {
        await recordPasskeySeedAttempt(
          deps,
          account.id,
          c.req.header('user-agent'),
          'begin',
          'failed',
          409,
          started.error,
        );
        return c.json({ error: started.error }, 409);
      }
      return c.json(started, 200);
    })
    .post('/passkey/seed/finish', async (c) => {
      const config = webAuthnConfig(deps);
      if (config === null) {
        return c.json({ error: 'Server auth is not configured' }, 500);
      }
      const token = bearerToken(c.req.header('authorization'));
      if (token === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const account = await resolveSession(deps.store, deps.now(), token);
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const userAgent = c.req.header('user-agent');
      if (account.walletRequired === true) {
        const alreadyHasPhrase = 'This account already has a recovery phrase';
        logEvent('auth.passkey.seed.fail', {
          accountId: account.id,
          error: alreadyHasPhrase,
        });
        await recordPasskeySeedAttempt(
          deps,
          account.id,
          userAgent,
          'finish',
          'failed',
          409,
          alreadyHasPhrase,
        );
        return c.json({ error: alreadyHasPhrase }, 409);
      }
      const parsed = passkeyFinishBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        const badBody = 'Expected a JSON body with challengeId and credential';
        await recordPasskeySeedAttempt(
          deps,
          account.id,
          userAgent,
          'finish',
          'failed',
          400,
          badBody,
        );
        return c.json({ error: badBody }, 400);
      }
      const result = await finishPasskeySeed(
        deps.store,
        deps.passkeyCeremony,
        config,
        deps.now(),
        c.req.header('origin'),
        parsed.data.challengeId,
        parsed.data.credential,
        account,
      );
      if (!result.ok) {
        logEvent(
          'auth.passkey.seed.fail',
          passkeyFailFields(parsed.data.challengeId, result.error),
        );
        const status = result.error === 'This account already has a recovery phrase' ? 409 : 400;
        await recordPasskeySeedAttempt(
          deps,
          account.id,
          userAgent,
          'finish',
          'failed',
          status,
          result.error,
        );
        return c.json({ error: result.error }, status);
      }
      await recordPasskeySeedAttempt(
        deps,
        result.account.id,
        userAgent,
        'finish',
        'succeeded',
        null,
        null,
      );
      await deps.store.acknowledgePasskeyRenewFailures(result.account.id, deps.now());
      logEvent('auth.passkey.seed.ok', { accountId: result.account.id });
      return c.json(
        {
          account: await serializeOwnerAccountWithPosts(result.account, deps.messages, {
            store: deps.fundingStore ?? new InMemoryFundingStore(),
            nowMs: deps.now(),
            authStore: deps.store,
          }),
        },
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
  /* v8 ignore start -- optional test-only nostrKeygen injection */
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
