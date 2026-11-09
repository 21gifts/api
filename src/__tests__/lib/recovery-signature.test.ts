import { describe, it, expect } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@/lib/nostr/kek';
import {
  RECOVERY_MESSAGE_PREFIX,
  lnurlTransferFromMessage,
  lnurlTransferToMessage,
  recoveryMessage,
  verifyLnurlDerSignature,
  verifyRecoverySignature,
} from '@/lib/recovery-signature';
import { PINNED, PINNED_PRIVATE_KEYS, signDer } from '@/__tests__/helpers/recovery';

/** secp256k1 group order. */
const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

/** SDK golden vector keys (`signed_message.rs`). */
const DOMAIN = 'lnurl.example.com';
const ALICE = '02a1633cafcc01ebfb6d78e39f687a1f0995c62fc95f51ead10a02ee0be551b5dc';
const BOB = '0379be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

describe('recoveryMessage', () => {
  it('joins the five lines with LF and no trailing LF', () => {
    const message = recoveryMessage({
      accountId: PINNED.accountId,
      challenge: PINNED.challenge,
      credentialId: PINNED.credentialId,
      newSparkPubkey: PINNED.newSparkPubkey,
    });
    expect(message).toBe(PINNED.message);
    expect(message.split('\n')).toEqual([
      RECOVERY_MESSAGE_PREFIX,
      PINNED.accountId,
      PINNED.challenge,
      PINNED.credentialId,
      PINNED.newSparkPubkey,
    ]);
    expect(message.endsWith('\n')).toBe(false);
  });
});

describe('verifyRecoverySignature', () => {
  it('verifies the pinned SDK vector', () => {
    expect(verifyRecoverySignature(PINNED.message, PINNED.oldSparkPubkey, PINNED.signature)).toBe(
      true,
    );
  });

  it('refuses the same signature with a high S', () => {
    expect(
      verifyRecoverySignature(PINNED.message, PINNED.oldSparkPubkey, PINNED.signatureHighS),
    ).toBe(false);
  });

  it('refuses a message with one flipped byte', () => {
    const flipped = `${PINNED.message.slice(0, -1)}e`;
    expect(flipped).not.toBe(PINNED.message);
    expect(verifyRecoverySignature(flipped, PINNED.oldSparkPubkey, PINNED.signature)).toBe(false);
  });

  it('refuses uppercase hex in the signature or the key', () => {
    expect(
      verifyRecoverySignature(
        PINNED.message,
        PINNED.oldSparkPubkey,
        PINNED.signature.toUpperCase(),
      ),
    ).toBe(false);
    expect(
      verifyRecoverySignature(
        PINNED.message,
        PINNED.oldSparkPubkey.toUpperCase(),
        PINNED.signature,
      ),
    ).toBe(false);
  });

  it('refuses 127- and 129-character signatures without throwing', () => {
    expect(
      verifyRecoverySignature(PINNED.message, PINNED.oldSparkPubkey, PINNED.signature.slice(1)),
    ).toBe(false);
    expect(
      verifyRecoverySignature(PINNED.message, PINNED.oldSparkPubkey, `${PINNED.signature}0`),
    ).toBe(false);
  });

  it('refuses a key that is not on the curve', () => {
    expect(verifyRecoverySignature(PINNED.message, `02${'f'.repeat(64)}`, PINNED.signature)).toBe(
      false,
    );
  });

  it('refuses the key with the other prefix', () => {
    const otherPrefix = `03${PINNED.oldSparkPubkey.slice(2)}`;
    expect(verifyRecoverySignature(PINNED.message, otherPrefix, PINNED.signature)).toBe(false);
  });

  it('refuses a signature of another key', () => {
    expect(verifyRecoverySignature(PINNED.message, PINNED.newSparkPubkey, PINNED.signature)).toBe(
      false,
    );
  });
});

describe('lnurlTransferFromMessage', () => {
  it('matches the SDK golden vector', () => {
    expect(lnurlTransferFromMessage(DOMAIN, 'alice', ALICE, BOB, 1_700_000_000)).toBe(
      `breez-lnurl:v2\ntransfer-from\nlnurl.example.com\nalice\n${ALICE}\n${BOB}\n1700000000`,
    );
  });
});

describe('lnurlTransferToMessage', () => {
  it('matches the SDK golden vector, with the description hashed', () => {
    expect(lnurlTransferToMessage(DOMAIN, 'alice', ALICE, BOB, 'Pay to alice', 1_700_000_000)).toBe(
      `breez-lnurl:v2\ntransfer-to\nlnurl.example.com\nalice\n${ALICE}\n${BOB}\n` +
        '0261d8b11c7eba9f71ccf5180df58416d3b2d19ba917caf57ba4bacead3ce2c2\n1700000000',
    );
  });
});

describe('verifyLnurlDerSignature', () => {
  const message = lnurlTransferFromMessage(
    DOMAIN,
    'alice',
    PINNED.oldSparkPubkey,
    PINNED.newSparkPubkey,
    1_700_000_000,
  );

  it('accepts a noble DER low-S signature', () => {
    const der = signDer(message, PINNED_PRIVATE_KEYS.old);
    expect(verifyLnurlDerSignature(message, PINNED.oldSparkPubkey, der)).toBe(true);
    expect(verifyLnurlDerSignature(message, PINNED.newSparkPubkey, der)).toBe(false);
  });

  it('refuses the same signature with a high S', () => {
    const der = hexToBytes(signDer(message, PINNED_PRIVATE_KEYS.old));
    const low = secp256k1.Signature.fromBytes(der, 'der');
    const high = new secp256k1.Signature(low.r, N - low.s).toBytes('der');
    expect(verifyLnurlDerSignature(message, PINNED.oldSparkPubkey, bytesToHex(high))).toBe(false);
  });

  it('refuses bad hex, an odd length, a malformed key, and bytes that are not DER', () => {
    const der = signDer(message, PINNED_PRIVATE_KEYS.old);
    expect(verifyLnurlDerSignature(message, PINNED.oldSparkPubkey, der.toUpperCase())).toBe(false);
    expect(verifyLnurlDerSignature(message, PINNED.oldSparkPubkey, `${der}0`)).toBe(false);
    expect(verifyLnurlDerSignature(message, PINNED.oldSparkPubkey, 'zz'.repeat(36))).toBe(false);
    expect(verifyLnurlDerSignature(message, PINNED.oldSparkPubkey.toUpperCase(), der)).toBe(false);
    expect(verifyLnurlDerSignature(message, PINNED.oldSparkPubkey, 'ab'.repeat(40))).toBe(false);
    expect(verifyLnurlDerSignature(message, `02${'f'.repeat(64)}`, der)).toBe(false);
  });

  it('verifies the DER encoding of the pinned compact signature', () => {
    const compact = secp256k1.Signature.fromBytes(hexToBytes(PINNED.signature), 'compact');
    expect(bytesToHex(compact.toBytes('der'))).toBe(PINNED.signatureDer);
    expect(
      verifyLnurlDerSignature(PINNED.message, PINNED.oldSparkPubkey, PINNED.signatureDer),
    ).toBe(true);
  });

  it('signs with the identity keys of the pinned mnemonics', () => {
    expect(bytesToHex(secp256k1.getPublicKey(hexToBytes(PINNED_PRIVATE_KEYS.old), true))).toBe(
      PINNED.oldSparkPubkey,
    );
    expect(bytesToHex(secp256k1.getPublicKey(hexToBytes(PINNED_PRIVATE_KEYS.new), true))).toBe(
      PINNED.newSparkPubkey,
    );
  });
});
