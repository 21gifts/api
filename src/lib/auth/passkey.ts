import { randomHex } from '@/lib/auth/hex';
import { forwardRecoveryLookup, settleDecision } from '@/lib/auth/recovery';
import { issueSession } from '@/lib/auth/service';
import type { Account, AuthStore, PasskeyChallenge } from '@/lib/auth/store';
import type { PasskeyCeremony } from '@/lib/auth/webauthn';
import { isWrongAccount, WRONG_ACCOUNT_ERROR } from '@/lib/auth/wrong-account';
import { CHALLENGE_TTL_MS } from '@/lib/config';
import type { LnurlServerConfig, WebAuthnRuntimeConfig } from '@/lib/config';
import { LOGINS_CLOSED_ERROR } from '@/lib/login-gate';
import { logEvent } from '@/lib/log';
import type { FetchFn } from '@/lib/lnurlp';
import { ensureAccountNostrKey, generateNostrKeyRecord, type NostrKeygen } from '@/lib/nostr/keys';
import { recoveryMessage, verifyRecoverySignature } from '@/lib/recovery-signature';
import { normalizeUsername } from '@/lib/username';

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
  /** Discriminator for the error branch. */
  ok: false;
  /** Stable error copy returned as `{ error }`. */
  error: string;
}

/** Outcome of a passkey finish step. */
export type PasskeyFinishResult = { ok: true; value: PasskeyFinishOk } | PasskeyFinishErr;

/**
 * Login switch check run before a session-creating step writes anything.
 * Receives the account the session would authenticate, or `null` for an
 * account that does not exist yet; `false` refuses with {@link LOGINS_CLOSED_ERROR}.
 */
export type SessionAdmit = (account: Account | null) => Promise<boolean>;

/** Outcome of passkey replace finish: existing session stays valid (no new token). */
export type PasskeyReplaceFinishResult = { ok: true; account: Account } | PasskeyFinishErr;

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

/** Stable 404 copy when a claim view key is missing or malformed. */
const CLAIM_NOT_FOUND = 'This profile could not be found.';

/** Stable 409 copy when a provisioned profile already has a passkey. */
const CLAIM_ALREADY_HAS_PASSKEY = 'This profile already has a passkey';

/** Stable 409 copy when the account already has a seed-bearing passkey. */
const SEED_ALREADY_HAS_PHRASE = 'This account already has a recovery phrase';

/** Stable 409 copy when the register-challenge name is taken. */
const USERNAME_IN_USE = 'Username is already in use';

/** Stable 400 copy when a stored register name no longer normalises. */
const USERNAME_INVALID = 'Username must be 1–32 characters of a-z, 0-9, hyphen, underscore, or dot';

/**
 * Stable 409 copy when authenticate finish meets the new passkey of a pending
 * social recovery, so the app keeps that passkey instead of asking the
 * authenticator to delete it as unknown.
 */
export const RECOVERY_PENDING_ERROR = 'Recovery is not finished';

/** Stable 400 copy when the recovery message's signer or signature does not fit the account. */
const RECOVERY_SIGNATURE_INVALID = 'Invalid recovery signature';

/** Stable 409 copy when the recovery's new wallet key is held already. */
const RECOVERY_KEY_IN_USE = 'Wallet key is already in use';

/** Stable 409 copy when the account already has a pending recovery. */
const RECOVERY_ALREADY_PENDING = 'A recovery is already pending';

/**
 * Outcome of {@link startPasskeyRecovery}: creation options for the new
 * passkey, or why none were issued.
 */
export type RecoveryBeginResult =
  | { ok: true; challengeId: string; options: unknown; accountId: string; username: string }
  | {
      ok: false;
      reason: 'not_found' | 'done' | 'operator' | 'wrong_account' | 'logins_closed' | 'unavailable';
    };

/**
 * Outcome of {@link finishPasskeyRecovery}. `accountId` is set once the
 * challenge's account is known.
 */
export type RecoveryFinishResult =
  { ok: true; accountId: string } | { ok: false; error: string; accountId?: string };

/**
 * Start passkey registration: mint a pending account id and creation options.
 *
 * The account row is not persisted until {@link finishPasskeyRegistration}
 * succeeds; a cancelled ceremony or a duplicate-credential race leaves no orphan.
 *
 * @param store - Auth persistence port.
 * @param ceremony - WebAuthn collaborator.
 * @param config - RP ID, name, and allowed origins.
 * @param now - Current time in epoch milliseconds.
 * @param requestedName - Already-normalised handle, or `null`/`undefined`
 *   for a nameless registration. Uniqueness is the caller's job.
 * @returns `challengeId` plus creation options.
 */
export async function startPasskeyRegistration(
  store: AuthStore,
  ceremony: PasskeyCeremony,
  config: WebAuthnRuntimeConfig,
  now: number,
  requestedName?: string | null,
): Promise<PasskeyBeginResult> {
  const accountId = crypto.randomUUID();
  let userName: string = accountId;
  let userDisplayName = '21.gifts';
  let storedName: string | null = null;
  if (typeof requestedName === 'string') {
    userName = requestedName;
    userDisplayName = requestedName;
    storedName = requestedName;
  }
  const generated = await ceremony.generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userID: new TextEncoder().encode(accountId),
    userName,
    userDisplayName,
  });
  const challengeId = randomHex(32);
  await store.createPasskeyChallenge({
    id: challengeId,
    type: 'register',
    challenge: generated.challenge,
    accountId,
    consumed: false,
    createdAt: now,
    requestedName: storedName,
  });
  logEvent('auth.passkey.register.begin', { accountId, challengeId });
  return { challengeId, options: generated.options };
}

/**
 * Start passkey claim: bind a passkey to an operator-provisioned account
 * identified by its durable view key. Does not mint a new account id.
 *
 * @param store - Auth persistence port.
 * @param ceremony - WebAuthn collaborator.
 * @param config - RP ID, name, and allowed origins.
 * @param now - Current time in epoch milliseconds.
 * @param viewKey - Capability secret from the invite link (64 lowercase hex).
 * @param admit - Optional login switch check; a refusal is {@link LOGINS_CLOSED_ERROR}
 *   after the 404/409 checks and before a challenge is stored.
 * @returns Creation options, or a stable 404/409 or logins-closed error string.
 */
export async function startPasskeyClaim(
  store: AuthStore,
  ceremony: PasskeyCeremony,
  config: WebAuthnRuntimeConfig,
  now: number,
  viewKey: string,
  admit?: SessionAdmit,
): Promise<{ ok: true; value: PasskeyBeginResult } | { ok: false; error: string }> {
  if (!/^[0-9a-f]{64}$/.test(viewKey)) {
    logEvent('auth.passkey.claim.fail', { error: CLAIM_NOT_FOUND });
    return { ok: false, error: CLAIM_NOT_FOUND };
  }
  const account = await store.getAccountByViewKey(viewKey);
  if (account === undefined) {
    logEvent('auth.passkey.claim.fail', { error: CLAIM_NOT_FOUND });
    return { ok: false, error: CLAIM_NOT_FOUND };
  }
  if (await store.accountHasPasskey(account.id)) {
    logEvent('auth.passkey.claim.fail', { error: CLAIM_ALREADY_HAS_PASSKEY });
    return { ok: false, error: CLAIM_ALREADY_HAS_PASSKEY };
  }
  if (admit !== undefined && !(await admit(account))) {
    return { ok: false, error: LOGINS_CLOSED_ERROR };
  }
  const generated = await ceremony.generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userID: new TextEncoder().encode(account.id),
    userName: account.id,
    userDisplayName: account.name ?? '21.gifts',
  });
  const challengeId = randomHex(32);
  await store.createPasskeyChallenge({
    id: challengeId,
    type: 'register',
    challenge: generated.challenge,
    accountId: account.id,
    consumed: false,
    createdAt: now,
  });
  logEvent('auth.passkey.claim.begin', { accountId: account.id, challengeId });
  return { ok: true, value: { challengeId, options: generated.options } };
}

/**
 * Complete passkey registration: verify attestation, persist the account and
 * credential, issue a session. When claiming a provisioned account, binds the
 * credential without creating or deleting the row and sets walletRequired
 * true without clearing walletBackupSeenAt. When creating a new account,
 * stores walletRequired true and walletBackupSeenAt null; optional
 * `nostr` mints a custodial nsec (rolls the account back if keygen fails) and
 * a duplicate credential id rolls the new account back via `deleteAccount`.
 * A string `requestedName` on the challenge is stored as `name` and
 * `username` after a second normalisation and uniqueness check. A handle
 * that no longer normalises is the username charset error. A taken handle,
 * or a named `createAccount` that inserts nothing, is
 * `{ ok: false, error: "Username is already in use" }` with no credential
 * and no session.
 *
 * @param store - Auth persistence port.
 * @param ceremony - WebAuthn collaborator.
 * @param config - RP ID, name, and allowed origins.
 * @param now - Current time in epoch milliseconds.
 * @param origin - Request `Origin` header (must match `expectedOrigins`).
 * @param challengeId - Id returned by {@link startPasskeyRegistration} or
 *   {@link startPasskeyClaim}.
 * @param credential - Browser attestation JSON.
 * @param nostr - Optional KEK (and test-only keygen) to mint a custodial nsec.
 * @param admit - Optional login switch check, run after the attestation is
 *   verified and before any account, credential, or session write; a refusal
 *   is {@link LOGINS_CLOSED_ERROR}. A new account is checked as `null`.
 * @returns Session + account, or `{ ok: false, error }`. New accounts have
 *   walletRequired true and walletBackupSeenAt null. Claim sets
 *   walletRequired true without clearing a seen timestamp. An existing
 *   account with {@link isWrongAccount} is refused before session mint with
 *   {@link WRONG_ACCOUNT_ERROR}.
 */
export async function finishPasskeyRegistration(
  store: AuthStore,
  ceremony: PasskeyCeremony,
  config: WebAuthnRuntimeConfig,
  now: number,
  origin: string | undefined,
  challengeId: string,
  credential: unknown,
  nostr?: { kek: Uint8Array; keygen?: NostrKeygen },
  admit?: SessionAdmit,
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
  if (!(await consumeChallenge(store, challenge))) {
    return { ok: false, error: 'Challenge already used' };
  }
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
  const existing = await store.getAccount(accountId);
  if (existing !== undefined) {
    if (isWrongAccount(existing)) {
      return { ok: false, error: WRONG_ACCOUNT_ERROR };
    }
    if (await store.accountHasPasskey(accountId)) {
      return { ok: false, error: 'Invalid passkey' };
    }
    if (admit !== undefined && !(await admit(existing))) {
      return { ok: false, error: LOGINS_CLOSED_ERROR };
    }
    const stored = await store.createFirstPasskeyCredential({
      credentialId: verified.credentialId,
      publicKey: verified.publicKey,
      signCount: verified.signCount,
      accountId,
      createdAt: now,
    });
    if (!stored) {
      const current = await store.getAccount(accountId);
      if (current !== undefined && isWrongAccount(current)) {
        return { ok: false, error: WRONG_ACCOUNT_ERROR };
      }
      return { ok: false, error: 'Invalid passkey' };
    }
    if (nostr !== undefined) {
      try {
        await ensureAccountNostrKey(store, existing.id, nostr.kek, nostr.keygen);
      } catch {
        logEvent('nostr.keygen.backfill.failed', { accountId: existing.id });
      }
    }
    const claimed: Account = { ...existing, walletRequired: true };
    return mintSession(store, now, claimed);
  }
  if (admit !== undefined && !(await admit(null))) {
    return { ok: false, error: LOGINS_CLOSED_ERROR };
  }
  let name: string | null = null;
  if (typeof challenge.requestedName === 'string') {
    const handle = normalizeUsername(challenge.requestedName);
    if (handle === null) {
      return { ok: false, error: USERNAME_INVALID };
    }
    if ((await store.getAccountByUsername(handle)) !== undefined) {
      return { ok: false, error: USERNAME_IN_USE };
    }
    name = handle;
  }
  const account: Account = {
    id: accountId,
    linkingKey: null,
    role: 'basis',
    name,
    ...(name === null ? {} : { username: name }),
    location: null,
    forumLawsDismissed: false,
    walletIntroSeen: false,
    viewKey: randomHex(32),
    createdAt: now,
    rulesAgreedAt: null,
    nameSkippedAt: null,
    lightningAddressSkippedAt: null,
    profileMessageId: null,
    notificationLevel: 'all',
    amountUnit: 'btc',
    walletRequired: false,
    walletBackupSeenAt: null,
  };
  await store.createAccount(account);
  if (
    typeof challenge.requestedName === 'string' &&
    (await store.getAccount(accountId)) === undefined
  ) {
    return { ok: false, error: USERNAME_IN_USE };
  }
  if (nostr !== undefined) {
    try {
      const record = await generateNostrKeyRecord(accountId, nostr.kek, nostr.keygen);
      const written = await store.setNostrKeyIfAbsent(accountId, record);
      /* v8 ignore next 4 -- CAS loser after a unique register is unreachable */
      if (written === 'exists') {
        await store.deleteAccount(accountId);
        return { ok: false, error: 'Invalid passkey' };
      }
      /* v8 ignore next 4 -- keygen/encrypt failures */
    } catch {
      await store.deleteAccount(accountId);
      return { ok: false, error: 'Invalid passkey' };
    }
  }
  const stored = await store.createFirstPasskeyCredential({
    credentialId: verified.credentialId,
    publicKey: verified.publicKey,
    signCount: verified.signCount,
    accountId,
    createdAt: now,
  });
  if (!stored) {
    await store.deleteAccount(accountId);
    return { ok: false, error: 'Invalid passkey' };
  }
  return mintSession(store, now, { ...account, walletRequired: true });
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
  logEvent('auth.passkey.authenticate.begin', { challengeId });
  return { challengeId, options: generated.options };
}

/**
 * Complete passkey authentication: verify assertion, CAS-update signCount, issue a session.
 * When `nostr` is set, best-effort backfills a missing custodial nsec.
 *
 * @param store - Auth persistence port.
 * @param ceremony - WebAuthn collaborator.
 * @param config - RP ID, name, and allowed origins.
 * @param now - Current time in epoch milliseconds.
 * @param origin - Request `Origin` header.
 * @param challengeId - Id returned by {@link startPasskeyAuthentication}.
 * @param credential - Browser assertion JSON.
 * @param nostr - Optional KEK (and test-only keygen) to backfill a missing nsec.
 * @param admit - Optional login switch check, run after the assertion is
 *   verified and before the sign count or a session is written; a refusal is
 *   {@link LOGINS_CLOSED_ERROR}.
 * @returns Session + account, or `{ ok: false, error }`. A credential id that
 *   is no stored passkey but the new passkey of a pending social recovery is
 *   {@link RECOVERY_PENDING_ERROR}; any other unknown id is `Unknown credential`.
 *   After the account is loaded, {@link isWrongAccount} is
 *   {@link WRONG_ACCOUNT_ERROR} and never issues a token.
 */
export async function finishPasskeyAuthentication(
  store: AuthStore,
  ceremony: PasskeyCeremony,
  config: WebAuthnRuntimeConfig,
  now: number,
  origin: string | undefined,
  challengeId: string,
  credential: unknown,
  nostr?: { kek: Uint8Array; keygen?: NostrKeygen },
  admit?: SessionAdmit,
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
  if (!(await consumeChallenge(store, challenge))) {
    return { ok: false, error: 'Challenge already used' };
  }
  const credentialId = credentialIdFrom(credential);
  if (credentialId === null) {
    return { ok: false, error: 'Unknown credential' };
  }
  const stored = await store.getPasskeyCredential(credentialId);
  if (stored === undefined) {
    if ((await store.getPendingRecoveryByCredentialId(credentialId, now)) !== undefined) {
      return { ok: false, error: RECOVERY_PENDING_ERROR };
    }
    return { ok: false, error: 'Unknown credential' };
  }
  const account = await store.getAccount(stored.accountId);
  if (account === undefined) {
    return { ok: false, error: 'Unknown or expired challenge' };
  }
  if (isWrongAccount(account)) {
    return { ok: false, error: WRONG_ACCOUNT_ERROR };
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
  if (admit !== undefined && !(await admit(account))) {
    return { ok: false, error: LOGINS_CLOSED_ERROR };
  }
  const latest = await store.getPasskeyCredential(stored.credentialId);
  /* v8 ignore next 3 -- credential cannot vanish mid-request in the in-memory store */
  if (latest === undefined) {
    return { ok: false, error: 'Unknown credential' };
  }
  const accepted = await store.updatePasskeyCredential({
    ...latest,
    signCount: verified.newSignCount,
  });
  if (!accepted) {
    return { ok: false, error: 'Invalid passkey' };
  }
  if (nostr !== undefined) {
    try {
      await ensureAccountNostrKey(store, account.id, nostr.kek, nostr.keygen);
      /* v8 ignore next 3 -- lazy keygen failure must not block login */
    } catch {
      logEvent('nostr.keygen.backfill.failed', { accountId: account.id });
    }
  }
  return mintSession(store, now, account);
}

async function mintSession(
  store: AuthStore,
  now: number,
  account: Account,
): Promise<
  | { ok: true; value: { token: string; account: Account } }
  | { ok: false; error: typeof WRONG_ACCOUNT_ERROR }
> {
  try {
    return { ok: true, value: await issueSession(store, now, account) };
  } catch (error) {
    if (error instanceof Error && error.message === WRONG_ACCOUNT_ERROR) {
      return { ok: false, error: WRONG_ACCOUNT_ERROR };
    }
    throw error;
  }
}

/**
 * Start passkey replace: mint creation options that exclude the current credential.
 *
 * @param store - Auth persistence port.
 * @param ceremony - WebAuthn collaborator.
 * @param config - RP ID, name, and allowed origins.
 * @param now - Current time in epoch milliseconds.
 * @param account - Signed-in account that owns the credential to replace.
 * @returns Creation options, or `{ ok: false, error: string }` when the account has no passkey.
 */
export async function startPasskeyReplace(
  store: AuthStore,
  ceremony: PasskeyCeremony,
  config: WebAuthnRuntimeConfig,
  now: number,
  account: Account,
): Promise<PasskeyBeginResult | { ok: false; error: string }> {
  const existing = await store.getPasskeyCredentialForAccount(account.id);
  if (existing === undefined) {
    return { ok: false, error: 'No passkey to replace' };
  }
  const generated = await ceremony.generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userID: new TextEncoder().encode(account.id),
    userName: account.id,
    userDisplayName: account.name ?? '21.gifts',
    excludeCredentials: [{ id: existing.credentialId, type: 'public-key' }],
  });
  const challengeId = randomHex(32);
  await store.createPasskeyChallenge({
    id: challengeId,
    type: 'replace',
    challenge: generated.challenge,
    accountId: account.id,
    consumed: false,
    createdAt: now,
  });
  return { challengeId, options: generated.options };
}

/**
 * Complete passkey replace: verify a new attestation and swap the one credential.
 * Does not mint a session; the existing Bearer stays valid.
 *
 * @param store - Auth persistence port.
 * @param ceremony - WebAuthn collaborator.
 * @param config - RP ID, name, and allowed origins.
 * @param now - Current time in epoch milliseconds.
 * @param origin - Request `Origin` header (must match `expectedOrigins`).
 * @param challengeId - Id returned by {@link startPasskeyReplace}.
 * @param credential - Browser attestation JSON.
 * @param account - Signed-in account from the Bearer session.
 * @returns `{ ok: true, account }` or `{ ok: false, error: string }`. Does not mint a session.
 */
export async function finishPasskeyReplace(
  store: AuthStore,
  ceremony: PasskeyCeremony,
  config: WebAuthnRuntimeConfig,
  now: number,
  origin: string | undefined,
  challengeId: string,
  credential: unknown,
  account: Account,
): Promise<PasskeyReplaceFinishResult> {
  const originErr = requireOrigin(origin, config.expectedOrigins);
  if (originErr !== null) {
    return { ok: false, error: originErr };
  }
  const loaded = await loadChallenge(store, now, challengeId, 'replace');
  if (!loaded.ok) {
    return loaded;
  }
  const challenge = loaded.challenge;
  if (challenge.accountId === null || challenge.accountId !== account.id) {
    return { ok: false, error: 'Unknown or expired challenge' };
  }
  if (!(await consumeChallenge(store, challenge))) {
    return { ok: false, error: 'Challenge already used' };
  }
  const verified = await ceremony.verifyRegistration({
    response: credential,
    expectedChallenge: challenge.challenge,
    expectedOrigin: config.expectedOrigins,
    expectedRPID: config.rpId,
  });
  if (!verified.ok) {
    return { ok: false, error: 'Invalid passkey' };
  }
  const other = await store.getPasskeyCredential(verified.credentialId);
  if (other !== undefined && other.accountId !== account.id) {
    return { ok: false, error: 'Invalid passkey' };
  }
  const current = await store.getPasskeyCredentialForAccount(account.id);
  if (current !== undefined && current.credentialId === verified.credentialId) {
    return { ok: false, error: 'Invalid passkey' };
  }
  const replaced = await store.replacePasskeyCredential({
    credentialId: verified.credentialId,
    publicKey: verified.publicKey,
    signCount: verified.signCount,
    accountId: account.id,
    createdAt: now,
  });
  if (!replaced) {
    return { ok: false, error: 'Invalid passkey' };
  }
  const latest = await store.getAccount(account.id);
  /* v8 ignore next -- the account row cannot vanish after a successful replace */
  return { ok: true, account: latest ?? account };
}

/**
 * Start passkey seed: mint creation options for an extra seed-bearing credential.
 * Does not set `excludeCredentials`. Does not mint a session.
 *
 * @param store - Auth persistence port.
 * @param ceremony - WebAuthn collaborator.
 * @param config - RP ID, name, and allowed origins.
 * @param now - Current time in epoch milliseconds.
 * @param account - Signed-in account that may add a seed passkey.
 * @returns Creation options, or `{ ok: false, error: string }` when the account
 *   already has a seed-bearing passkey (`walletRequired === true`).
 */
export async function startPasskeySeed(
  store: AuthStore,
  ceremony: PasskeyCeremony,
  config: WebAuthnRuntimeConfig,
  now: number,
  account: Account,
): Promise<PasskeyBeginResult | { ok: false; error: string }> {
  if (account.walletRequired === true) {
    logEvent('auth.passkey.seed.fail', { accountId: account.id, error: SEED_ALREADY_HAS_PHRASE });
    return { ok: false, error: SEED_ALREADY_HAS_PHRASE };
  }
  const generated = await ceremony.generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userID: new TextEncoder().encode(account.id),
    userName: account.id,
    userDisplayName: account.name ?? '21.gifts',
  });
  const challengeId = randomHex(32);
  await store.createPasskeyChallenge({
    id: challengeId,
    type: 'seed',
    challenge: generated.challenge,
    accountId: account.id,
    consumed: false,
    createdAt: now,
  });
  logEvent('auth.passkey.seed.begin', { accountId: account.id, challengeId });
  return { challengeId, options: generated.options };
}

/**
 * Complete passkey seed: verify a new attestation and insert an additional
 * credential. Sets `walletRequired` true. Does not delete the login passkey,
 * does not change `walletBackupSeenAt`, and does not mint a session.
 *
 * @param store - Auth persistence port.
 * @param ceremony - WebAuthn collaborator.
 * @param config - RP ID, name, and allowed origins.
 * @param now - Current time in epoch milliseconds.
 * @param origin - Request `Origin` header (must match `expectedOrigins`).
 * @param challengeId - Id returned by {@link startPasskeySeed}.
 * @param credential - Browser attestation JSON.
 * @param account - Signed-in account from the Bearer session.
 * @returns `{ ok: true, account }` or `{ ok: false, error: string }`. Does not mint a session.
 */
export async function finishPasskeySeed(
  store: AuthStore,
  ceremony: PasskeyCeremony,
  config: WebAuthnRuntimeConfig,
  now: number,
  origin: string | undefined,
  challengeId: string,
  credential: unknown,
  account: Account,
): Promise<PasskeyReplaceFinishResult> {
  const originErr = requireOrigin(origin, config.expectedOrigins);
  if (originErr !== null) {
    return { ok: false, error: originErr };
  }
  if (account.walletRequired === true || account.sessionRefused === true) {
    return { ok: false, error: SEED_ALREADY_HAS_PHRASE };
  }
  const loaded = await loadChallenge(store, now, challengeId, 'seed');
  if (!loaded.ok) {
    return loaded;
  }
  const challenge = loaded.challenge;
  if (challenge.accountId === null || challenge.accountId !== account.id) {
    return { ok: false, error: 'Unknown or expired challenge' };
  }
  if (!(await consumeChallenge(store, challenge))) {
    return { ok: false, error: 'Challenge already used' };
  }
  const verified = await ceremony.verifyRegistration({
    response: credential,
    expectedChallenge: challenge.challenge,
    expectedOrigin: config.expectedOrigins,
    expectedRPID: config.rpId,
  });
  if (!verified.ok) {
    return { ok: false, error: 'Invalid passkey' };
  }
  if ((await store.getPasskeyCredential(verified.credentialId)) !== undefined) {
    return { ok: false, error: SEED_ALREADY_HAS_PHRASE };
  }
  const stored = await store.addSeedPasskeyCredential({
    credentialId: verified.credentialId,
    publicKey: verified.publicKey,
    signCount: verified.signCount,
    accountId: account.id,
    createdAt: now,
  });
  if (!stored) {
    return { ok: false, error: SEED_ALREADY_HAS_PHRASE };
  }
  const latest = await store.getAccount(account.id);
  if (latest === undefined) {
    return { ok: false, error: SEED_ALREADY_HAS_PHRASE };
  }
  return { ok: true, account: latest };
}

/**
 * Start a social recovery ceremony for the account whose verified wallet key
 * is `sparkPubkey`, after the LNURL server verified that wallet's signed lookup.
 *
 * Without an account on the key, a previous wallet's key answers `done` once
 * its lookup is verified (`unavailable` otherwise) and any other key
 * `not_found` with no upstream call. A session-refused account is
 * `wrong_account`, a refusal of `admit` is `logins_closed`. A forwarded pending
 * recovery is settled first ({@link settleDecision} with the old key's
 * lookup): a commit answers `done` (log `account.recovery.committed`,
 * `via: 'begin'`), a drop goes on (log `account.recovery.dropped`), a keep is
 * `unavailable`. Then an unverified lookup is `unavailable`, and a key that no
 * longer holds the account's username is `operator` (log
 * `auth.passkey.recovery.fail`). Otherwise issues creation options as for a
 * seed passkey (user id and name the account id, no `excludeCredentials`) and
 * stores a `recovery` challenge through `startRecoveryChallenge`, which also
 * consumes earlier ones and drops an unforwarded pending recovery.
 *
 * @param deps - Auth store, WebAuthn collaborator and config, LNURL server
 *   config, `fetch`, clock, and the optional login switch check.
 * @param input - Normalized old wallet key and its signed lookup (DER hex
 *   signature, Unix-seconds timestamp).
 * @returns {@link RecoveryBeginResult}. Never logs the key or the lookup.
 * @throws When the auth store throws.
 */
export async function startPasskeyRecovery(
  deps: {
    store: AuthStore;
    ceremony: PasskeyCeremony;
    config: WebAuthnRuntimeConfig;
    lnurlServer: LnurlServerConfig;
    fetchImpl: FetchFn;
    now: () => number;
    admit?: SessionAdmit;
  },
  input: { sparkPubkey: string; lookup: { signature: string; timestamp: number } },
): Promise<RecoveryBeginResult> {
  const { store } = deps;
  const account = await store.getAccountByVerifiedSparkPubkey(input.sparkPubkey);
  if (account === undefined) {
    if ((await store.getPreviousWalletBySparkPubkey(input.sparkPubkey)) === undefined) {
      return { ok: false, reason: 'not_found' };
    }
    const { answer } = await forwardRecoveryLookup(
      deps.lnurlServer,
      deps.fetchImpl,
      deps.now,
      input.sparkPubkey,
      input.lookup,
    );
    return { ok: false, reason: answer.kind === 'unverified' ? 'unavailable' : 'done' };
  }
  if (isWrongAccount(account)) {
    return { ok: false, reason: 'wrong_account' };
  }
  if (deps.admit !== undefined && !(await deps.admit(account))) {
    return { ok: false, reason: 'logins_closed' };
  }
  const { sentAt, answer } = await forwardRecoveryLookup(
    deps.lnurlServer,
    deps.fetchImpl,
    deps.now,
    input.sparkPubkey,
    input.lookup,
  );
  const pending = await store.getPendingRecovery(account.id, deps.now());
  if (pending !== undefined && pending.forwardedAt !== null) {
    const decision = settleDecision(pending, { role: 'old', sentAt, answer }, account.username);
    if (decision === 'keep') {
      return { ok: false, reason: 'unavailable' };
    }
    if (decision === 'commit') {
      const committed = await store.commitRecovery({
        accountId: account.id,
        newSparkPubkey: pending.newSparkPubkey,
        now: deps.now(),
      });
      if (committed !== 'committed') {
        return { ok: false, reason: 'unavailable' };
      }
      logEvent('account.recovery.committed', { accountId: account.id, via: 'begin' });
      return { ok: false, reason: 'done' };
    }
    const dropped = await store.dropPendingRecovery({
      accountId: account.id,
      newSparkPubkey: pending.newSparkPubkey,
    });
    if (dropped) {
      logEvent('account.recovery.dropped', { accountId: account.id, via: 'begin' });
    }
  }
  if (answer.kind === 'unverified') {
    return { ok: false, reason: 'unavailable' };
  }
  const username =
    typeof account.username === 'string' ? normalizeUsername(account.username) : null;
  if (answer.kind === 'not_found' || username === null || answer.username !== username) {
    logEvent('auth.passkey.recovery.fail', {
      stage: 'begin',
      accountId: account.id,
      error: 'operator',
    });
    return { ok: false, reason: 'operator' };
  }
  const generated = await deps.ceremony.generateRegistrationOptions({
    rpName: deps.config.rpName,
    rpID: deps.config.rpId,
    userID: new TextEncoder().encode(account.id),
    userName: account.id,
    userDisplayName: account.name ?? '21.gifts',
  });
  const challengeId = randomHex(32);
  const createdAt = deps.now();
  const started = await store.startRecoveryChallenge({
    accountId: account.id,
    oldSparkPubkey: input.sparkPubkey,
    challenge: {
      id: challengeId,
      type: 'recovery',
      challenge: generated.challenge,
      accountId: account.id,
      consumed: false,
      createdAt,
    },
    now: createdAt,
  });
  if (started !== 'started') {
    return { ok: false, reason: 'unavailable' };
  }
  logEvent('auth.passkey.recovery.begin', { accountId: account.id, challengeId });
  return { ok: true, challengeId, options: generated.options, accountId: account.id, username };
}

/**
 * Finish a social recovery ceremony: verify the new passkey and the old
 * wallet's signature over the recovery message, then store a pending recovery.
 *
 * Checks in order: origin; a `recovery` challenge inside `CHALLENGE_TTL_MS`
 * (a consumed one is allowed here, so the store can recognize a repeat); the
 * challenge's account exists, is not session-refused ({@link WRONG_ACCOUNT_ERROR})
 * and passes `admit` ({@link LOGINS_CLOSED_ERROR}); `signature.pubkey` is its
 * verified wallet key and the new key differs from it; the attestation
 * verifies; the old key's compact signature over {@link recoveryMessage}
 * (with the credential id `verifyRegistration` returned, never the browser's
 * `credential.id`) verifies. `storePendingRecovery` then consumes the
 * challenge and stores the row in one locked step. A repeat of the finish
 * that stored it, with the same challenge, credential id and new key, is ok
 * again and changes nothing. Mints no session.
 *
 * @param deps - Auth store, WebAuthn collaborator and config, clock, and the
 *   optional login switch check.
 * @param input - Request `Origin`, challenge id, attestation, normalized new
 *   wallet key, and the old wallet's normalized key with its compact signature.
 * @returns `{ ok: true, accountId }`, or `{ ok: false, error }` with the
 *   account id once known. Logs `auth.passkey.recovery.finish` when stored.
 * @throws When the auth store throws, including an unmapped unique violation.
 */
export async function finishPasskeyRecovery(
  deps: {
    store: AuthStore;
    ceremony: PasskeyCeremony;
    config: WebAuthnRuntimeConfig;
    now: () => number;
    admit?: SessionAdmit;
  },
  input: {
    origin: string | undefined;
    challengeId: string;
    credential: unknown;
    newSparkPubkey: string;
    signature: { pubkey: string; signature: string };
  },
): Promise<RecoveryFinishResult> {
  const { store } = deps;
  const originErr = requireOrigin(input.origin, deps.config.expectedOrigins);
  if (originErr !== null) {
    return { ok: false, error: originErr };
  }
  const now = deps.now();
  const loaded = await loadChallenge(store, now, input.challengeId, 'recovery', {
    allowConsumed: true,
  });
  if (!loaded.ok) {
    return loaded;
  }
  const challenge = loaded.challenge;
  const account =
    challenge.accountId === null ? undefined : await store.getAccount(challenge.accountId);
  if (account === undefined) {
    return { ok: false, error: 'Unknown or expired challenge' };
  }
  const accountId = account.id;
  if (isWrongAccount(account)) {
    return { ok: false, error: WRONG_ACCOUNT_ERROR, accountId };
  }
  if (deps.admit !== undefined && !(await deps.admit(account))) {
    return { ok: false, error: LOGINS_CLOSED_ERROR, accountId };
  }
  const oldSparkPubkey = account.sparkPubkey;
  if (
    typeof oldSparkPubkey !== 'string' ||
    typeof account.sparkPubkeyVerifiedAt !== 'number' ||
    oldSparkPubkey !== input.signature.pubkey
  ) {
    return { ok: false, error: RECOVERY_SIGNATURE_INVALID, accountId };
  }
  if (input.newSparkPubkey === oldSparkPubkey) {
    return { ok: false, error: RECOVERY_KEY_IN_USE, accountId };
  }
  const verified = await deps.ceremony.verifyRegistration({
    response: input.credential,
    expectedChallenge: challenge.challenge,
    expectedOrigin: deps.config.expectedOrigins,
    expectedRPID: deps.config.rpId,
  });
  if (!verified.ok) {
    return { ok: false, error: 'Invalid passkey', accountId };
  }
  const message = recoveryMessage({
    accountId,
    challenge: challenge.challenge,
    credentialId: verified.credentialId,
    newSparkPubkey: input.newSparkPubkey,
  });
  if (!verifyRecoverySignature(message, oldSparkPubkey, input.signature.signature)) {
    return { ok: false, error: RECOVERY_SIGNATURE_INVALID, accountId };
  }
  const stored = await store.storePendingRecovery({
    challengeId: challenge.id,
    pending: {
      accountId,
      oldSparkPubkey,
      newSparkPubkey: input.newSparkPubkey,
      credentialId: verified.credentialId,
      publicKey: verified.publicKey,
      signCount: verified.signCount,
      createdAt: now,
      forwardedAt: null,
    },
    now,
  });
  switch (stored) {
    case 'stored':
      logEvent('auth.passkey.recovery.finish', { accountId });
      return { ok: true, accountId };
    case 'same':
      return { ok: true, accountId };
    case 'challenge':
      return { ok: false, error: 'Challenge already used', accountId };
    case 'changed':
      return { ok: false, error: RECOVERY_SIGNATURE_INVALID, accountId };
    case 'pending':
      return { ok: false, error: RECOVERY_ALREADY_PENDING, accountId };
    case 'key':
      return { ok: false, error: RECOVERY_KEY_IN_USE, accountId };
    case 'credential':
      return { ok: false, error: 'Invalid passkey', accountId };
  }
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
 * @param expectedType - Register, authenticate, replace, seed, or recovery.
 * @param options - `allowConsumed` skips the one-use check; the recovery
 *   finish leaves that check to `storePendingRecovery`, which recognizes a repeat.
 * @returns The challenge, or a 400 error string.
 */
async function loadChallenge(
  store: AuthStore,
  now: number,
  challengeId: string,
  expectedType: PasskeyChallenge['type'],
  options: { allowConsumed?: boolean } = {},
): Promise<LoadedChallenge> {
  const challenge = await store.getPasskeyChallenge(challengeId);
  if (challenge === undefined) {
    return { ok: false, error: 'Unknown or expired challenge' };
  }
  if (now - challenge.createdAt > CHALLENGE_TTL_MS) {
    return { ok: false, error: 'Challenge expired' };
  }
  if (challenge.consumed && options.allowConsumed !== true) {
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
 * @param challenge - The challenge that is being consumed now.
 * @returns false when the row is missing or already consumed.
 */
async function consumeChallenge(store: AuthStore, challenge: PasskeyChallenge): Promise<boolean> {
  return store.updatePasskeyChallenge({ ...challenge, consumed: true });
}
