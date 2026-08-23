import { randomHex } from '@/lib/auth/lnurl';
import { issueSession } from '@/lib/auth/service';
import type { Account, AuthStore, PasskeyChallenge } from '@/lib/auth/store';
import type { PasskeyCeremony } from '@/lib/auth/webauthn';
import { CHALLENGE_TTL_MS } from '@/lib/config';
import type { WebAuthnRuntimeConfig } from '@/lib/config';

/** Browser-facing payload from a passkey begin step. */
export interface PasskeyBeginResult {
  /** Opaque id the client must send back on finish. */
  challengeId: string;
  /** WebAuthn options JSON for `navigator.credentials`. */
  options: unknown;
}

/** Successful finish: a session token and the account it authenticates. */
export interface PasskeyFinishOk {
  /** Opaque bearer token. */
  token: string;
  /** The authenticated account (`linkingKey` is null for passkey-created rows). */
  account: Account;
}

/** Failed finish with a client-facing error string. */
export interface PasskeyFinishErr {
  /** Stable error copy returned as `{ error }`. */
  error: string;
}

/** Outcome of a passkey finish step. */
export type PasskeyFinishResult =
  { ok: true; value: PasskeyFinishOk } | { ok: false; error: string };

/**
 * Read the WebAuthn credential `id` from an untyped browser payload.
 *
 * @param credential - The `credential` field from the finish body.
 * @returns The id string, or `null` when missing or empty.
 */
export function credentialIdFrom(credential: unknown): string | null {
  if (typeof credential !== 'object' || credential === null) {
    return null;
  }
  if (!('id' in credential)) {
    return null;
  }
  const id = (credential as { id: unknown }).id;
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * Start passkey registration: mint a pending account id and creation options.
 *
 * The account row is not persisted until {@link finishPasskeyRegistration}
 * succeeds, so a cancelled ceremony leaves no orphan.
 *
 * @param store - Auth persistence port.
 * @param ceremony - WebAuthn collaborator.
 * @param config - RP ID, name, and allowed origins.
 * @param now - Current time in epoch milliseconds.
 * @returns `challengeId` plus creation options.
 */
export async function startPasskeyRegistration(
  store: AuthStore,
  ceremony: PasskeyCeremony,
  config: WebAuthnRuntimeConfig,
  now: number,
): Promise<PasskeyBeginResult> {
  const accountId = crypto.randomUUID();
  const generated = await ceremony.generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userID: new TextEncoder().encode(accountId),
    userName: accountId,
    userDisplayName: '21.gifts',
  });
  const challengeId = randomHex(32);
  await store.createPasskeyChallenge({
    id: challengeId,
    type: 'register',
    challenge: generated.challenge,
    accountId,
    consumed: false,
    createdAt: now,
  });
  return { challengeId, options: generated.options };
}

/**
 * Complete passkey registration: verify attestation, persist the account and
 * credential, issue a session.
 *
 * @param store - Auth persistence port.
 * @param ceremony - WebAuthn collaborator.
 * @param config - RP ID, name, and allowed origins.
 * @param now - Current time in epoch milliseconds.
 * @param origin - Request `Origin` header (must match `expectedOrigins`).
 * @param challengeId - Id returned by {@link startPasskeyRegistration}.
 * @param credential - Browser attestation JSON.
 * @returns Session + account, or a 400 error string.
 */
export async function finishPasskeyRegistration(
  store: AuthStore,
  ceremony: PasskeyCeremony,
  config: WebAuthnRuntimeConfig,
  now: number,
  origin: string | undefined,
  challengeId: string,
  credential: unknown,
): Promise<PasskeyFinishResult> {
  const originErr = requireOrigin(origin, config.expectedOrigins);
  if (originErr !== null) {
    return { ok: false, error: originErr };
  }
  const loaded = await loadChallenge(store, now, challengeId, 'register');
  if (!loaded.ok) {
    return loaded;
  }
  const challenge = loaded.challenge;
  const verified = await ceremony.verifyRegistration({
    response: credential,
    expectedChallenge: challenge.challenge,
    expectedOrigin: config.expectedOrigins,
    expectedRPID: config.rpId,
  });
  if (!verified.ok) {
    return { ok: false, error: 'Invalid passkey' };
  }
  const accountId = challenge.accountId;
  if (accountId === null) {
    return { ok: false, error: 'Unknown or expired challenge' };
  }
  if ((await store.getPasskeyCredential(verified.credentialId)) !== undefined) {
    return { ok: false, error: 'Invalid passkey' };
  }
  const account: Account = {
    id: accountId,
    linkingKey: null,
    role: 'basis',
    name: null,
    lightningAddress: null,
    lightningAddressVerified: false,
    createdAt: now,
  };
  await store.createAccount(account);
  await store.createPasskeyCredential({
    credentialId: verified.credentialId,
    publicKey: verified.publicKey,
    signCount: verified.signCount,
    accountId,
    createdAt: now,
  });
  await consumeChallenge(store, challenge);
  const issued = await issueSession(store, now, account);
  return { ok: true, value: issued };
}

/**
 * Start passkey authentication: mint request options for a discoverable credential.
 *
 * @param store - Auth persistence port.
 * @param ceremony - WebAuthn collaborator.
 * @param config - RP ID, name, and allowed origins.
 * @param now - Current time in epoch milliseconds.
 * @returns `challengeId` plus request options.
 */
export async function startPasskeyAuthentication(
  store: AuthStore,
  ceremony: PasskeyCeremony,
  config: WebAuthnRuntimeConfig,
  now: number,
): Promise<PasskeyBeginResult> {
  const generated = await ceremony.generateAuthenticationOptions({ rpID: config.rpId });
  const challengeId = randomHex(32);
  await store.createPasskeyChallenge({
    id: challengeId,
    type: 'authenticate',
    challenge: generated.challenge,
    accountId: null,
    consumed: false,
    createdAt: now,
  });
  return { challengeId, options: generated.options };
}

/**
 * Complete passkey authentication: verify assertion, bump signCount, issue a session.
 *
 * @param store - Auth persistence port.
 * @param ceremony - WebAuthn collaborator.
 * @param config - RP ID, name, and allowed origins.
 * @param now - Current time in epoch milliseconds.
 * @param origin - Request `Origin` header.
 * @param challengeId - Id returned by {@link startPasskeyAuthentication}.
 * @param credential - Browser assertion JSON.
 * @returns Session + account, or a 400 error string.
 */
export async function finishPasskeyAuthentication(
  store: AuthStore,
  ceremony: PasskeyCeremony,
  config: WebAuthnRuntimeConfig,
  now: number,
  origin: string | undefined,
  challengeId: string,
  credential: unknown,
): Promise<PasskeyFinishResult> {
  const originErr = requireOrigin(origin, config.expectedOrigins);
  if (originErr !== null) {
    return { ok: false, error: originErr };
  }
  const loaded = await loadChallenge(store, now, challengeId, 'authenticate');
  if (!loaded.ok) {
    return loaded;
  }
  const challenge = loaded.challenge;
  const credentialId = credentialIdFrom(credential);
  if (credentialId === null) {
    return { ok: false, error: 'Unknown credential' };
  }
  const stored = await store.getPasskeyCredential(credentialId);
  if (stored === undefined) {
    return { ok: false, error: 'Unknown credential' };
  }
  const verified = await ceremony.verifyAuthentication({
    response: credential,
    expectedChallenge: challenge.challenge,
    expectedOrigin: config.expectedOrigins,
    expectedRPID: config.rpId,
    credentialId: stored.credentialId,
    publicKey: stored.publicKey,
    signCount: stored.signCount,
  });
  if (!verified.ok) {
    return { ok: false, error: 'Invalid passkey' };
  }
  await store.updatePasskeyCredential({ ...stored, signCount: verified.newSignCount });
  const account = await store.getAccount(stored.accountId);
  if (account === undefined) {
    return { ok: false, error: 'Unknown or expired challenge' };
  }
  await consumeChallenge(store, challenge);
  const issued = await issueSession(store, now, account);
  return { ok: true, value: issued };
}

/**
 * Reject a missing or disallowed Origin header.
 *
 * @param origin - Raw `Origin` header, or `undefined`.
 * @param expectedOrigins - Origins allowed for this RP ID.
 * @returns An error string, or `null` when the origin is allowed.
 */
function requireOrigin(origin: string | undefined, expectedOrigins: string[]): string | null {
  if (origin === undefined || origin === '') {
    return 'Invalid origin';
  }
  return expectedOrigins.includes(origin) ? null : 'Invalid origin';
}

/** Loaded challenge, or a finish error. */
type LoadedChallenge = { ok: true; challenge: PasskeyChallenge } | { ok: false; error: string };

/**
 * Load a passkey challenge and enforce type, TTL, and one-use.
 *
 * @param store - Auth persistence port.
 * @param now - Current time in epoch milliseconds.
 * @param challengeId - Client-supplied challenge id.
 * @param expectedType - Register vs authenticate.
 * @returns The challenge, or a 400 error string.
 */
async function loadChallenge(
  store: AuthStore,
  now: number,
  challengeId: string,
  expectedType: PasskeyChallenge['type'],
): Promise<LoadedChallenge> {
  const challenge = await store.getPasskeyChallenge(challengeId);
  if (challenge === undefined) {
    return { ok: false, error: 'Unknown or expired challenge' };
  }
  if (now - challenge.createdAt > CHALLENGE_TTL_MS) {
    return { ok: false, error: 'Challenge expired' };
  }
  if (challenge.consumed) {
    return { ok: false, error: 'Challenge already used' };
  }
  if (challenge.type !== expectedType) {
    return { ok: false, error: 'Wrong challenge type' };
  }
  return { ok: true, challenge };
}

/**
 * Mark a passkey challenge consumed so finish cannot mint a second session.
 *
 * @param store - Auth persistence port.
 * @param challenge - The challenge that just succeeded.
 */
async function consumeChallenge(store: AuthStore, challenge: PasskeyChallenge): Promise<void> {
  await store.updatePasskeyChallenge({ ...challenge, consumed: true });
}
