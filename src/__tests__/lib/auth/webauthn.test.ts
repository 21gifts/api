import { describe, it, expect, vi } from 'vitest';
import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { SimpleWebAuthnPasskeyCeremony } from '@/lib/auth/webauthn';

vi.mock('@simplewebauthn/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simplewebauthn/server')>();
  return {
    ...actual,
    verifyRegistrationResponse: vi.fn(actual.verifyRegistrationResponse),
    verifyAuthenticationResponse: vi.fn(actual.verifyAuthenticationResponse),
  };
});

const ceremony = new SimpleWebAuthnPasskeyCeremony();
const userID = new TextEncoder().encode('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

describe('SimpleWebAuthnPasskeyCeremony', () => {
  it('generates registration options with a challenge', async () => {
    const generated = await ceremony.generateRegistrationOptions({
      rpName: '21.gifts',
      rpID: 'localhost',
      userID,
      userName: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userDisplayName: '21.gifts',
    });
    expect(generated.challenge.length).toBeGreaterThan(8);
    expect(generated.options.rp.id).toBe('localhost');
    expect(generated.options.authenticatorSelection?.residentKey).toBe('required');
    expect(generated.options.authenticatorSelection?.userVerification).toBe('required');
  });

  it('rejects a string registration response', async () => {
    const result = await ceremony.verifyRegistration({
      response: 'nope',
      expectedChallenge: 'abc',
      expectedOrigin: 'http://localhost:3000',
      expectedRPID: 'localhost',
    });
    expect(result).toEqual({ ok: false, reason: 'Invalid passkey' });
  });

  it('rejects a null registration response', async () => {
    const result = await ceremony.verifyRegistration({
      response: null,
      expectedChallenge: 'abc',
      expectedOrigin: 'http://localhost:3000',
      expectedRPID: 'localhost',
    });
    expect(result).toEqual({ ok: false, reason: 'Invalid passkey' });
  });

  it('rejects garbage registration responses', async () => {
    const result = await ceremony.verifyRegistration({
      response: { not: 'webauthn' },
      expectedChallenge: 'abc',
      expectedOrigin: 'http://localhost:3000',
      expectedRPID: 'localhost',
    });
    expect(result).toEqual({ ok: false, reason: 'Invalid passkey' });
  });

  it('rejects a registration response that throws inside verify', async () => {
    vi.mocked(verifyRegistrationResponse).mockRejectedValueOnce(new Error('bad'));
    const result = await ceremony.verifyRegistration({
      response: { id: 'x', rawId: 'x', type: 'public-key', response: {} },
      expectedChallenge: 'abc',
      expectedOrigin: 'http://localhost:3000',
      expectedRPID: 'localhost',
    });
    expect(result).toEqual({ ok: false, reason: 'Invalid passkey' });
  });

  it('rejects a verified registration missing credential material', async () => {
    vi.mocked(verifyRegistrationResponse).mockResolvedValueOnce({
      verified: true,
    } as Awaited<ReturnType<typeof verifyRegistrationResponse>>);
    const result = await ceremony.verifyRegistration({
      response: { id: 'x', rawId: 'x', type: 'public-key', response: { clientDataJSON: 'e30' } },
      expectedChallenge: 'abc',
      expectedOrigin: 'http://localhost:3000',
      expectedRPID: 'localhost',
    });
    expect(result).toEqual({ ok: false, reason: 'Invalid passkey' });
  });

  it('rejects an unverified registration', async () => {
    vi.mocked(verifyRegistrationResponse).mockResolvedValueOnce({ verified: false });
    const result = await ceremony.verifyRegistration({
      response: { id: 'x', rawId: 'x', type: 'public-key', response: { clientDataJSON: 'e30' } },
      expectedChallenge: 'abc',
      expectedOrigin: 'http://localhost:3000',
      expectedRPID: 'localhost',
    });
    expect(result).toEqual({ ok: false, reason: 'Invalid passkey' });
  });

  it('maps a verified registration to credential fields', async () => {
    vi.mocked(verifyRegistrationResponse).mockResolvedValueOnce({
      verified: true,
      registrationInfo: {
        credential: { id: 'cred', publicKey: new Uint8Array([1, 2]), counter: 0 },
      },
    } as Awaited<ReturnType<typeof verifyRegistrationResponse>>);
    const result = await ceremony.verifyRegistration({
      response: {
        id: 'cred',
        rawId: 'cred',
        type: 'public-key',
        response: { clientDataJSON: 'e30' },
      },
      expectedChallenge: 'abc',
      expectedOrigin: 'http://localhost:3000',
      expectedRPID: 'localhost',
    });
    expect(result).toEqual({
      ok: true,
      credentialId: 'cred',
      publicKey: new Uint8Array([1, 2]),
      signCount: 0,
    });
  });

  it('generates authentication options with an empty allowCredentials list', async () => {
    const generated = await ceremony.generateAuthenticationOptions({ rpID: 'localhost' });
    expect(generated.challenge.length).toBeGreaterThan(8);
    expect(generated.options.userVerification).toBe('required');
    expect(generated.options.allowCredentials ?? []).toEqual([]);
  });

  it('rejects a string authentication response', async () => {
    const result = await ceremony.verifyAuthentication({
      response: 'nope',
      expectedChallenge: 'abc',
      expectedOrigin: 'http://localhost:3000',
      expectedRPID: 'localhost',
      credentialId: 'cred',
      publicKey: new Uint8Array([1]),
      signCount: 0,
    });
    expect(result).toEqual({ ok: false, reason: 'Invalid passkey' });
  });

  it('rejects a null authentication response', async () => {
    const result = await ceremony.verifyAuthentication({
      response: null,
      expectedChallenge: 'abc',
      expectedOrigin: 'http://localhost:3000',
      expectedRPID: 'localhost',
      credentialId: 'cred',
      publicKey: new Uint8Array([1]),
      signCount: 0,
    });
    expect(result).toEqual({ ok: false, reason: 'Invalid passkey' });
  });

  it('rejects garbage authentication responses', async () => {
    const result = await ceremony.verifyAuthentication({
      response: { not: 'webauthn' },
      expectedChallenge: 'abc',
      expectedOrigin: 'http://localhost:3000',
      expectedRPID: 'localhost',
      credentialId: 'cred',
      publicKey: new Uint8Array([1]),
      signCount: 0,
    });
    expect(result).toEqual({ ok: false, reason: 'Invalid passkey' });
  });

  it('rejects an authentication response that throws inside verify', async () => {
    vi.mocked(verifyAuthenticationResponse).mockRejectedValueOnce(new Error('bad'));
    const result = await ceremony.verifyAuthentication({
      response: { id: 'x', rawId: 'x', type: 'public-key', response: {} },
      expectedChallenge: 'abc',
      expectedOrigin: 'http://localhost:3000',
      expectedRPID: 'localhost',
      credentialId: 'cred',
      publicKey: new Uint8Array([1]),
      signCount: 0,
    });
    expect(result).toEqual({ ok: false, reason: 'Invalid passkey' });
  });

  it('rejects a verified authentication missing counter material', async () => {
    vi.mocked(verifyAuthenticationResponse).mockResolvedValueOnce({
      verified: true,
    } as Awaited<ReturnType<typeof verifyAuthenticationResponse>>);
    const result = await ceremony.verifyAuthentication({
      response: { id: 'x', rawId: 'x', type: 'public-key', response: { clientDataJSON: 'e30' } },
      expectedChallenge: 'abc',
      expectedOrigin: 'http://localhost:3000',
      expectedRPID: 'localhost',
      credentialId: 'cred',
      publicKey: new Uint8Array([1]),
      signCount: 0,
    });
    expect(result).toEqual({ ok: false, reason: 'Invalid passkey' });
  });

  it('rejects an unverified authentication', async () => {
    vi.mocked(verifyAuthenticationResponse).mockResolvedValueOnce({
      verified: false,
    } as Awaited<ReturnType<typeof verifyAuthenticationResponse>>);
    const result = await ceremony.verifyAuthentication({
      response: { id: 'x', rawId: 'x', type: 'public-key', response: { clientDataJSON: 'e30' } },
      expectedChallenge: 'abc',
      expectedOrigin: 'http://localhost:3000',
      expectedRPID: 'localhost',
      credentialId: 'cred',
      publicKey: new Uint8Array([1]),
      signCount: 0,
    });
    expect(result).toEqual({ ok: false, reason: 'Invalid passkey' });
  });

  it('maps a verified authentication to the new sign count', async () => {
    vi.mocked(verifyAuthenticationResponse).mockResolvedValueOnce({
      verified: true,
      authenticationInfo: { newCounter: 4 },
    } as Awaited<ReturnType<typeof verifyAuthenticationResponse>>);
    const result = await ceremony.verifyAuthentication({
      response: {
        id: 'cred',
        rawId: 'cred',
        type: 'public-key',
        response: { clientDataJSON: 'e30' },
      },
      expectedChallenge: 'abc',
      expectedOrigin: 'http://localhost:3000',
      expectedRPID: 'localhost',
      credentialId: 'cred',
      publicKey: new Uint8Array([1]),
      signCount: 0,
    });
    expect(result).toEqual({ ok: true, newSignCount: 4 });
  });
});
