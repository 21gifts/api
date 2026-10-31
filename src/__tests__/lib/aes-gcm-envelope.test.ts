import { describe, expect, it } from 'vitest';
import {
  AES_GCM_ENVELOPE_VERSION,
  AES_GCM_NONCE_BYTES,
  AES_GCM_TAG_BYTES,
  sealAesGcmEnvelope,
} from '@/lib/aes-gcm-envelope';

const KEK = new Uint8Array(32).fill(7);
const AAD = new TextEncoder().encode('3f2b8c1e-9d4a-4e7b-8c6f-1a2b3c4d5e6f');

/** Open an envelope in the test only; the api has no open function. */
async function open(envelope: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', KEK, { name: 'AES-GCM' }, false, ['decrypt']);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: envelope.subarray(5, 5 + AES_GCM_NONCE_BYTES), additionalData: aad },
      key,
      envelope.subarray(5 + AES_GCM_NONCE_BYTES),
    ),
  );
}

describe('sealAesGcmEnvelope', () => {
  it('writes version, big-endian kek id, a 12-byte nonce, and ciphertext plus a 16-byte tag', async () => {
    const plaintext = new TextEncoder().encode('hello envelope');
    const envelope = await sealAesGcmEnvelope(plaintext, KEK, AAD, 0x01020304);
    expect(AES_GCM_ENVELOPE_VERSION).toBe(0x01);
    expect(envelope[0]).toBe(AES_GCM_ENVELOPE_VERSION);
    expect([...envelope.subarray(1, 5)]).toEqual([1, 2, 3, 4]);
    expect(envelope).toHaveLength(
      1 + 4 + AES_GCM_NONCE_BYTES + plaintext.length + AES_GCM_TAG_BYTES,
    );
    const again = await sealAesGcmEnvelope(plaintext, KEK, AAD, 0x01020304);
    expect(again.subarray(5, 17)).not.toEqual(envelope.subarray(5, 17));
  });

  it('round-trips with the same additional data and fails with another', async () => {
    const plaintext = new TextEncoder().encode('round trip');
    const envelope = await sealAesGcmEnvelope(plaintext, KEK, AAD, 1);
    expect(await open(envelope, AAD)).toEqual(plaintext);
    await expect(open(envelope, new TextEncoder().encode('other-account'))).rejects.toThrow();
  });

  it('refuses a KEK that is not 32 bytes and empty plaintext', async () => {
    await expect(
      sealAesGcmEnvelope(new Uint8Array([1]), new Uint8Array(31), AAD, 1),
    ).rejects.toThrow('KEK must be 32 bytes');
    await expect(sealAesGcmEnvelope(new Uint8Array(), KEK, AAD, 1)).rejects.toThrow(
      'Plaintext must not be empty',
    );
  });
});
