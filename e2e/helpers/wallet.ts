import { secp256k1 } from '@noble/curves/secp256k1.js';

/**
 * Playwright copy of the Vitest LUD-04 wallet helper. Lives under e2e/ so
 * the HTTP tests can sign a real k1 without importing from src/__tests__.
 */

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** A test wallet: a compressed public linkingKey plus a k1 signer. */
export interface TestWallet {
  /** Compressed public linkingKey as 66-char hex. */
  key: string;
  /**
   * Sign a k1 challenge, returning the DER-encoded signature as hex. Signs the
   * raw k1 as the digest (LUD-04) by default; `prehash: true` signs sha256(k1)
   * instead, to exercise the rejection of non-LUD-04 signatures.
   */
  sign(k1: string, opts?: { prehash?: boolean }): string;
}

/** Create a fresh secp256k1 test wallet for LUD-04 vectors. */
export function newWallet(): TestWallet {
  const { secretKey, publicKey } = secp256k1.keygen();
  return {
    key: bytesToHex(publicKey),
    sign(k1: string, opts?: { prehash?: boolean }): string {
      const compact = secp256k1.sign(hexToBytes(k1), secretKey, {
        prehash: opts?.prehash ?? false,
      });
      return secp256k1.Signature.fromHex(bytesToHex(compact), 'compact').toHex('der');
    },
  };
}
