import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';

/**
 * Collaborator that talks to the WebAuthn library. Tests inject a fake so HTTP
 * and domain logic do not need a live authenticator.
 */
export interface PasskeyCeremony {
  /**
   * Build `navigator.credentials.create()` options and the challenge to persist.
   *
   * @param input - Relying party and user entity for this registration.
   * @returns The challenge string (base64url) and the JSON options for the browser.
   */
  generateRegistrationOptions(input: {
    rpName: string;
    rpID: string;
    userID: Uint8Array;
    userName: string;
    userDisplayName: string;
  }): Promise<{ challenge: string; options: PublicKeyCredentialCreationOptionsJSON }>;

  /**
   * Verify a registration attestation.
   *
   * @param input - Browser response plus the values remembered at begin.
   * @returns Credential material on success, or a reason on failure.
   */
  verifyRegistration(input: {
    response: unknown;
    expectedChallenge: string;
    expectedOrigin: string | string[];
    expectedRPID: string;
  }): Promise<
    | { ok: true; credentialId: string; publicKey: Uint8Array; signCount: number }
    | { ok: false; reason: string }
  >;

  /**
   * Build `navigator.credentials.get()` options for a discoverable credential.
   *
   * @param input - Relying party id.
   * @returns The challenge string and the JSON options for the browser.
   */
  generateAuthenticationOptions(input: {
    rpID: string;
  }): Promise<{ challenge: string; options: PublicKeyCredentialRequestOptionsJSON }>;

  /**
   * Verify an authentication assertion against a stored credential.
   *
   * @param input - Browser response plus stored public key and counter.
   * @returns The new sign count on success, or a reason on failure.
   */
  verifyAuthentication(input: {
    response: unknown;
    expectedChallenge: string;
    expectedOrigin: string | string[];
    expectedRPID: string;
    credentialId: string;
    publicKey: Uint8Array;
    signCount: number;
  }): Promise<{ ok: true; newSignCount: number } | { ok: false; reason: string }>;
}

/**
 * Production {@link PasskeyCeremony} wrapping `@simplewebauthn/server`.
 */
export class SimpleWebAuthnPasskeyCeremony implements PasskeyCeremony {
  /**
   * Build WebAuthn creation options via SimpleWebAuthn.
   *
   * @param input - RP and user entity for `generateRegistrationOptions`.
   * @returns Challenge plus creation options (residentKey required).
   */
  async generateRegistrationOptions(input: {
    rpName: string;
    rpID: string;
    userID: Uint8Array;
    userName: string;
    userDisplayName: string;
  }): Promise<{ challenge: string; options: PublicKeyCredentialCreationOptionsJSON }> {
    const options = await generateRegistrationOptions({
      rpName: input.rpName,
      rpID: input.rpID,
      userID: Uint8Array.from(input.userID),
      userName: input.userName,
      userDisplayName: input.userDisplayName,
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
    });
    return { challenge: options.challenge, options };
  }

  /**
   * Verify a registration attestation via SimpleWebAuthn.
   *
   * @param input - Attestation to verify.
   * @returns Stored credential fields, or `{ ok: false }`.
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
    if (!isRegistrationResponse(input.response)) {
      return { ok: false, reason: 'Invalid passkey' };
    }
    try {
      const verification = await verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: input.expectedChallenge,
        expectedOrigin: input.expectedOrigin,
        expectedRPID: input.expectedRPID,
        requireUserVerification: true,
      });
      if (!verification.verified || verification.registrationInfo === undefined) {
        return { ok: false, reason: 'Invalid passkey' };
      }
      const { credential } = verification.registrationInfo;
      return {
        ok: true,
        credentialId: credential.id,
        publicKey: credential.publicKey,
        signCount: credential.counter,
      };
    } catch {
      return { ok: false, reason: 'Invalid passkey' };
    }
  }

  /**
   * Build WebAuthn request options via SimpleWebAuthn.
   *
   * @param input - RP id for a discoverable-credential assertion.
   * @returns Challenge plus request options (`allowCredentials` empty).
   */
  async generateAuthenticationOptions(input: {
    rpID: string;
  }): Promise<{ challenge: string; options: PublicKeyCredentialRequestOptionsJSON }> {
    const options = await generateAuthenticationOptions({
      rpID: input.rpID,
      userVerification: 'required',
      allowCredentials: [],
    });
    return { challenge: options.challenge, options };
  }

  /**
   * Verify an authentication assertion via SimpleWebAuthn.
   *
   * @param input - Assertion plus the stored credential.
   * @returns The updated sign count, or `{ ok: false }`.
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
    if (!isAuthenticationResponse(input.response)) {
      return { ok: false, reason: 'Invalid passkey' };
    }
    try {
      const verification = await verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: input.expectedChallenge,
        expectedOrigin: input.expectedOrigin,
        expectedRPID: input.expectedRPID,
        credential: {
          id: input.credentialId,
          publicKey: Uint8Array.from(input.publicKey),
          counter: input.signCount,
        },
        requireUserVerification: true,
      });
      if (!verification.verified || verification.authenticationInfo === undefined) {
        return { ok: false, reason: 'Invalid passkey' };
      }
      return { ok: true, newSignCount: verification.authenticationInfo.newCounter };
    } catch {
      return { ok: false, reason: 'Invalid passkey' };
    }
  }
}

/**
 * Narrow unknown JSON to a registration response.
 *
 * @param value - The body `credential` field.
 * @returns Whether it has the WebAuthn registration shape.
 */
function isRegistrationResponse(value: unknown): value is RegistrationResponseJSON {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record['id'] === 'string' && typeof record['response'] === 'object';
}

/**
 * Narrow unknown JSON to an authentication response.
 *
 * @param value - The body `credential` field.
 * @returns Whether it has the WebAuthn authentication shape.
 */
function isAuthenticationResponse(value: unknown): value is AuthenticationResponseJSON {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record['id'] === 'string' && typeof record['response'] === 'object';
}
