import type { PasskeyCeremony } from '@/lib/auth/webauthn';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';

/**
 * Test double for {@link PasskeyCeremony}. Accepts sentinel JSON instead of
 * real WebAuthn attestations so HTTP and domain tests stay deterministic.
 */
export class FakePasskeyCeremony implements PasskeyCeremony {
  /**
   * Return a fixed creation challenge for tests.
   *
   * @param input - RP and user entity (user fields unused by the fake).
   * @returns A fixed challenge and a stub creation-options object.
   */
  async generateRegistrationOptions(input: {
    rpName: string;
    rpID: string;
    userID: Uint8Array;
    userName: string;
    userDisplayName: string;
  }): Promise<{ challenge: string; options: PublicKeyCredentialCreationOptionsJSON }> {
    return {
      challenge: 'test-challenge',
      options: {
        challenge: 'test-challenge',
        rp: { id: input.rpID, name: input.rpName },
        user: { id: input.userName, name: input.userName, displayName: input.userDisplayName },
        pubKeyCredParams: [],
      },
    };
  }

  /**
   * Succeeds when `response` is `{ test: 'ok' }` (extra keys allowed).
   *
   * @param input - Attestation payload from the finish body.
   * @returns Fixed credential `cred-1`, or `{ ok: false }`.
   */
  async verifyRegistration(input: {
    response: unknown;
    expectedChallenge: string;
    expectedOrigin: string | string[];
    expectedRPID: string;
  }): Promise<
    | { ok: true; credentialId: string; publicKey: Uint8Array; signCount: number }
    | { ok: false; reason: string }
  > {
    if (isSentinel(input.response, 'ok')) {
      return {
        ok: true,
        credentialId: 'cred-1',
        publicKey: new Uint8Array([1, 2, 3]),
        signCount: 0,
      };
    }
    return { ok: false, reason: 'Invalid passkey' };
  }

  /**
   * Return a fixed assertion challenge for tests.
   *
   * @param input - RP id for the stub request options.
   * @returns A fixed challenge and a stub request-options object.
   */
  async generateAuthenticationOptions(input: {
    rpID: string;
  }): Promise<{ challenge: string; options: PublicKeyCredentialRequestOptionsJSON }> {
    return {
      challenge: 'test-challenge',
      options: {
        challenge: 'test-challenge',
        rpId: input.rpID,
      },
    };
  }

  /**
   * Succeeds when `response` is `{ test: 'ok' }` (extra keys allowed) with
   * `signCount + 1`. `{ test: 'zero' }` succeeds with `newSignCount` 0 so the
   * authenticator 0/0 path is reachable. `{ test: 'replay' }` fails.
   *
   * @param input - Assertion payload from the finish body.
   * @returns A new sign count on success, or `{ ok: false }`.
   */
  async verifyAuthentication(input: {
    response: unknown;
    expectedChallenge: string;
    expectedOrigin: string | string[];
    expectedRPID: string;
    credentialId: string;
    publicKey: Uint8Array;
    signCount: number;
  }): Promise<{ ok: true; newSignCount: number } | { ok: false; reason: string }> {
    if (isSentinel(input.response, 'replay')) {
      return { ok: false, reason: 'Invalid passkey' };
    }
    if (isSentinel(input.response, 'zero')) {
      return { ok: true, newSignCount: 0 };
    }
    if (isSentinel(input.response, 'ok')) {
      return { ok: true, newSignCount: input.signCount + 1 };
    }
    return { ok: false, reason: 'Invalid passkey' };
  }
}

/**
 * Whether `value` is `{ test: expected }` (extra keys allowed).
 *
 * @param value - Unknown finish `credential`.
 * @param expected - Sentinel `test` field.
 * @returns True when the shape matches.
 */
function isSentinel(value: unknown, expected: string): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (value as { test?: unknown }).test === expected;
}
