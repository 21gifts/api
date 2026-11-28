import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSecretKey } from 'nostr-tools/pure';
import { InMemoryAuthStore } from '@/lib/auth/store';
import {
  currentKekEnvelope,
  decryptNostrSecret,
  encryptNostrSecret,
  ensureAccountNostrKey,
  generateNostrKeyRecord,
  NOSTR_ENVELOPE_VERSION,
  NOSTR_KEK_ID_V1,
  publicKeyHexFromSecret,
  zeroizeSecret,
} from '@/lib/nostr/keys';
import { bindKekId, parseNostrKek } from '@/lib/nostr/kek';

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

describe('KEK ids of Nostr envelopes', () => {
  function envelopeId(envelope: Uint8Array): number {
    return new DataView(envelope.buffer, envelope.byteOffset).getUint32(1, false);
  }

  it('seals under the id bound to the key and opens only that id', async () => {
    const current = bindKekId(parseNostrKek('ab'.repeat(32)), 2);
    const secret = generateSecretKey();
    const envelope = await encryptNostrSecret(secret, current, 'acc');
    expect(envelopeId(envelope)).toBe(2);
    expect(await decryptNostrSecret(envelope, current, 'acc')).toEqual(secret);
    // The same bytes without the binding are id 1 and never open an id 2 envelope.
    await expect(decryptNostrSecret(envelope, KEK, 'acc')).rejects.toThrow(
      'Unsupported Nostr kek_id',
    );
    const legacy = await encryptNostrSecret(secret, KEK, 'acc');
    expect(envelopeId(legacy)).toBe(NOSTR_KEK_ID_V1);
    await expect(decryptNostrSecret(legacy, current, 'acc')).rejects.toThrow(
      'Unsupported Nostr kek_id',
    );
  });

  it('records the id of the key in generated records and ensured keys', async () => {
    const current = bindKekId(parseNostrKek('12'.repeat(32)), 3);
    const record = await generateNostrKeyRecord('shop:note', current);
    expect(record.kekId).toBe(3);
    expect(envelopeId(record.ciphertext)).toBe(3);
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: null,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await ensureAccountNostrKey(store, 'acc', current);
    const rows = await store.listNostrKeys();
    expect(rows.find((row) => row.accountId === 'acc')?.record.kekId).toBe(3);
  });
});

describe('currentKekEnvelope', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  function events(): Array<Record<string, unknown>> {
    return warn.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
  }

  it('passes an envelope under the current id, a missing one, and a malformed one', async () => {
    const envelope = await encryptNostrSecret(generateSecretKey(), KEK, 'acc');
    expect(currentKekEnvelope(envelope, KEK, { accountId: 'acc' })).toBe(envelope);
    expect(currentKekEnvelope(undefined, KEK, { accountId: 'acc' })).toBeUndefined();
    const short = new Uint8Array(4);
    expect(currentKekEnvelope(short, KEK, { accountId: 'acc' })).toBe(short);
    expect(events()).toEqual([]);
  });

  it('treats an envelope under another id as missing and warns once per owner', async () => {
    const current = bindKekId(parseNostrKek('34'.repeat(32)), 2);
    const stale = await encryptNostrSecret(generateSecretKey(), KEK, 'acc-stale');
    expect(currentKekEnvelope(stale, current, { accountId: 'acc-stale' })).toBeUndefined();
    expect(currentKekEnvelope(stale, current, { accountId: 'acc-stale' })).toBeUndefined();
    expect(currentKekEnvelope(stale, current, { messageId: 'note-stale' })).toBeUndefined();
    const logged = events().filter((event) => event['event'] === 'nostr.key.kek_stale');
    expect(logged).toEqual([
      expect.objectContaining({ accountId: 'acc-stale' }),
      expect.objectContaining({ messageId: 'note-stale' }),
    ]);
    for (const event of logged) {
      expect(Object.keys(event).sort()).toEqual(
        ['event', 'ts', 'accountId' in event ? 'accountId' : 'messageId'].sort(),
      );
    }
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
      forumLawsDismissed: false,
      location: null,
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
