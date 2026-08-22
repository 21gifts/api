import { describe, it, expect } from 'vitest';
import { encodeLnurl, randomHex, verifyAuthSig } from '@/lib/auth/lnurl';
import { newWallet } from '@/__tests__/helpers/auth-vectors';

const K1 = 'a'.repeat(64);

describe('encodeLnurl', () => {
  it('produces a lower-case bech32 lnurl string', () => {
    const lnurl = encodeLnurl(`https://dev.21.gifts/auth/lnurl/callback?tag=login&k1=${K1}`);
    expect(lnurl.startsWith('lnurl1')).toBe(true);
    expect(lnurl).toBe(lnurl.toLowerCase());
  });
});

describe('randomHex', () => {
  it('returns hex of the requested byte length', () => {
    expect(randomHex(32)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is random across calls', () => {
    expect(randomHex(16)).not.toBe(randomHex(16));
  });
});

describe('verifyAuthSig', () => {
  it('accepts a valid signature over the challenge', () => {
    const w = newWallet();
    expect(verifyAuthSig(K1, w.sign(K1), w.key)).toBe(true);
  });

  it('rejects a valid signature over a different challenge', () => {
    const w = newWallet();
    expect(verifyAuthSig(K1, w.sign('b'.repeat(64)), w.key)).toBe(false);
  });

  it('rejects a signature under a different key', () => {
    const signer = newWallet();
    const other = newWallet();
    expect(verifyAuthSig(K1, signer.sign(K1), other.key)).toBe(false);
  });

  it('rejects a well-formed-hex but structurally invalid DER signature', () => {
    const w = newWallet();
    expect(verifyAuthSig(K1, 'abcd', w.key)).toBe(false);
  });

  it('rejects a malformed k1', () => {
    const w = newWallet();
    expect(verifyAuthSig('zz', w.sign(K1), w.key)).toBe(false);
  });

  it('rejects a malformed public key', () => {
    const w = newWallet();
    expect(verifyAuthSig(K1, w.sign(K1), `04${'a'.repeat(64)}`)).toBe(false);
  });

  it('rejects a non-hex signature', () => {
    const w = newWallet();
    expect(verifyAuthSig(K1, 'zzzz', w.key)).toBe(false);
  });

  it('rejects a well-formed-hex but off-curve public key', () => {
    const w = newWallet();
    expect(verifyAuthSig(K1, w.sign(K1), `02${'f'.repeat(64)}`)).toBe(false);
  });

  it('rejects a signature made over sha256(k1) instead of the raw k1 (LUD-04)', () => {
    const w = newWallet();
    // A prehash:true signature signs sha256(k1); LUD-04 verification must reject it.
    expect(verifyAuthSig(K1, w.sign(K1, { prehash: true }), w.key)).toBe(false);
  });
});
