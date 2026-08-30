import { describe, expect, it } from 'vitest';
import { generateSecretKey } from 'nostr-tools/pure';
import { InMemoryAuthStore } from '@/lib/auth/store';
import {
  decryptNostrSecret,
  encryptNostrSecret,
  ensureAccountNostrKey,
  generateNostrKeyRecord,
  NOSTR_ENVELOPE_VERSION,
  publicKeyHexFromSecret,
  zeroizeSecret,
} from '@/lib/nostr/keys';
import { parseNostrKek } from '@/lib/nostr/kek';

const KEK = parseNostrKek('ab'.repeat(32));

describe('encryptNostrSecret / decryptNostrSecret', () => {
  it('round-trips a 32-byte secret', async () => {
    const secret = generateSecretKey();
    const envelope = await encryptNostrSecret(secret, KEK, 'acc-1');
    expect(envelope[0]).toBe(NOSTR_ENVELOPE_VERSION);
    const plain = await decryptNostrSecret(envelope, KEK, 'acc-1');
    expect(plain).toEqual(secret);
    await expect(decryptNostrSecret(envelope, KEK, 'acc-2')).rejects.toThrow();
  });

  it('rejects a short envelope and wrong version', async () => {
    await expect(decryptNostrSecret(new Uint8Array(4), KEK, 'acc')).rejects.toThrow(/too short/);
    const secret = generateSecretKey();
    const envelope = await encryptNostrSecret(secret, KEK, 'acc');
    envelope[0] = 2;
    await expect(decryptNostrSecret(envelope, KEK, 'acc')).rejects.toThrow(/version/);
  });

  it('rejects a 31-byte secret', async () => {
    await expect(encryptNostrSecret(new Uint8Array(31), KEK, 'acc')).rejects.toThrow(/32 bytes/);
  });

  it('rejects a short KEK', async () => {
    const secret = generateSecretKey();
    await expect(encryptNostrSecret(secret, new Uint8Array(16), 'acc')).rejects.toThrow(
      /KEK must be 32 bytes/,
    );
    const envelope = await encryptNostrSecret(secret, KEK, 'acc');
    await expect(decryptNostrSecret(envelope, new Uint8Array(16), 'acc')).rejects.toThrow(
      /KEK must be 32 bytes/,
    );
  });
});

describe('zeroizeSecret', () => {
  it('fills zeros', () => {
    const buf = new Uint8Array([1, 2, 3]);
    zeroizeSecret(buf);
    expect([...buf]).toEqual([0, 0, 0]);
  });
});

describe('ensureAccountNostrKey', () => {
  it('inserts once and is a no-op later', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    const first = await ensureAccountNostrKey(store, 'acc', KEK);
    expect(first).toHaveLength(64);
    const second = await ensureAccountNostrKey(store, 'acc', KEK);
    expect(second).toBe(first);
    expect(publicKeyHexFromSecret(generateSecretKey()).length).toBe(64);
  });

  it('generateNostrKeyRecord produces ciphertext', async () => {
    const record = await generateNostrKeyRecord('acc', KEK);
    expect(record.custody).toBe('custodial');
    expect(record.ciphertext.length).toBeGreaterThan(16);
  });
});
