import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import {
  EXTERNAL_REPLY_NOTIFY_MAX_AGE_MS,
  EXTERNAL_ZAPPER_MIN_SATS,
  ExternalIngestLimiter,
  externalDisplayName,
  resolveExternalProfileName,
  verifiedExternalZapRequest,
} from '@/lib/nostr/external';
import { RecordingQuerier } from '@/lib/nostr/query';

function signedRequest(noteEventId: string, amount = '21000', content = ' thanks '): string {
  return JSON.stringify(
    finalizeEvent(
      {
        kind: 9734,
        created_at: 1,
        tags: [
          ['e', noteEventId],
          ['amount', amount],
        ],
        content,
      },
      generateSecretKey(),
    ),
  );
}

function descriptionHash(description: string): string {
  return createHash('sha256').update(description, 'utf8').digest('hex');
}

describe('external constants', () => {
  it('uses the product thresholds', () => {
    expect(EXTERNAL_ZAPPER_MIN_SATS).toBe(1);
    expect(EXTERNAL_REPLY_NOTIFY_MAX_AGE_MS).toBe(3_600_000);
  });
});

describe('verifiedExternalZapRequest', () => {
  it('requires every signed invoice and note binding', () => {
    const note = 'ee'.repeat(32);
    const description = signedRequest(note);
    const valid = verifiedExternalZapRequest({
      tags: [['description', description]],
      descriptionHash: descriptionHash(description).toUpperCase(),
      amountMsat: 21_000n,
      noteEventId: note,
    });
    expect(valid).toEqual({
      pubkey: expect.stringMatching(/^[0-9a-f]{64}$/),
      requestId: expect.stringMatching(/^[0-9a-f]{64}$/),
      content: 'thanks',
    });

    expect(
      verifiedExternalZapRequest({
        tags: [['description', description]],
        descriptionHash: '00'.repeat(32),
        amountMsat: 21_000,
        noteEventId: note,
      }),
    ).toBeNull();
    expect(
      verifiedExternalZapRequest({
        tags: [['description', description]],
        descriptionHash: descriptionHash(description),
        amountMsat: 21_000,
        noteEventId: 'ff'.repeat(32),
      }),
    ).toBeNull();
    expect(
      verifiedExternalZapRequest({
        tags: [['description', description]],
        descriptionHash: descriptionHash(description),
        amountMsat: 22_000,
        noteEventId: note,
      }),
    ).toBeNull();
  });

  it('rejects malformed and unsigned descriptions and accepts no amount tag', () => {
    const note = 'aa'.repeat(32);
    const malformed = '{';
    expect(
      verifiedExternalZapRequest({
        tags: [['description', malformed]],
        descriptionHash: descriptionHash(malformed),
        amountMsat: 1000,
        noteEventId: note,
      }),
    ).toBeNull();
    expect(
      verifiedExternalZapRequest({
        tags: [],
        descriptionHash: null,
        amountMsat: null,
        noteEventId: note,
      }),
    ).toBeNull();

    const unsigned = JSON.stringify({
      kind: 9734,
      id: '11'.repeat(32),
      sig: '22'.repeat(64),
      pubkey: '33'.repeat(32),
      created_at: 1,
      tags: [['e', note]],
      content: 'hello',
    });
    expect(
      verifiedExternalZapRequest({
        tags: [['description', unsigned]],
        descriptionHash: descriptionHash(unsigned),
        amountMsat: 1000,
        noteEventId: note,
      }),
    ).toBeNull();

    const withoutAmount = JSON.stringify(
      finalizeEvent(
        { kind: 9734, created_at: 1, tags: [['e', note]], content: '\u0000bad' },
        generateSecretKey(),
      ),
    );
    expect(
      verifiedExternalZapRequest({
        tags: [['description', withoutAmount]],
        descriptionHash: descriptionHash(withoutAmount),
        amountMsat: null,
        noteEventId: note,
      })?.content,
    ).toBe('');
  });

  it('rejects non-decimal amount tags', () => {
    const note = 'bb'.repeat(32);
    const description = signedRequest(note, '1.0');
    expect(
      verifiedExternalZapRequest({
        tags: [['description', description]],
        descriptionHash: descriptionHash(description),
        amountMsat: 1,
        noteEventId: note,
      }),
    ).toBeNull();
  });
});

describe('externalDisplayName', () => {
  it('trims and caps an ordinary profile name', () => {
    expect(
      externalDisplayName({
        profileName: `  ${'a'.repeat(100)}  `,
        pubkey: '12'.repeat(32),
        accountNames: [],
      }),
    ).toBe('a'.repeat(80));
  });

  it('falls back for missing, invalid, member-owned, and reserved names', () => {
    const pubkey = 'ABCDEF0123456789';
    const fallback = 'abcdef01…6789';
    expect(externalDisplayName({ profileName: null, pubkey, accountNames: [] })).toBe(fallback);
    expect(externalDisplayName({ profileName: '  ', pubkey, accountNames: [] })).toBe(fallback);
    expect(externalDisplayName({ profileName: 'bad\u0000name', pubkey, accountNames: [] })).toBe(
      fallback,
    );
    expect(
      externalDisplayName({ profileName: 'Áda Lovelace', pubkey, accountNames: ['ada-lovelace'] }),
    ).toBe(fallback);
    expect(externalDisplayName({ profileName: 'Official Helper', pubkey, accountNames: [] })).toBe(
      fallback,
    );
  });
});

describe('resolveExternalProfileName', () => {
  it('uses the newest profile, display_name precedence, and the hit cache', async () => {
    const querier = new RecordingQuerier();
    const pubkey = '01'.repeat(32);
    querier.events = [
      { id: 'old', pubkey, kind: 0, tags: [], created_at: 1, content: '{"name":"Old"}' },
      {
        id: 'new',
        pubkey: pubkey.toUpperCase(),
        kind: 0,
        tags: [],
        created_at: 2,
        content: '{"display_name":"Display","name":"Name"}',
      },
    ];
    const args = { querier, urls: ['wss://relay.example'], pubkey, nowMs: 1000, timeoutMs: 50 };
    await expect(resolveExternalProfileName(args)).resolves.toBe('Display');
    querier.events = [];
    await expect(resolveExternalProfileName({ ...args, nowMs: 2000 })).resolves.toBe('Display');
    expect(querier.calls).toHaveLength(1);
    expect(querier.calls[0]?.filter).toEqual({ kinds: [0], authors: [pubkey], limit: 20 });
  });

  it('caches misses briefly and never throws', async () => {
    const pubkey = '02'.repeat(32);
    const querier = { query: vi.fn().mockRejectedValue(new Error('offline')) };
    const args = { querier, urls: ['wss://relay.example'], pubkey, nowMs: 1000, timeoutMs: 50 };
    await expect(resolveExternalProfileName(args)).resolves.toBeNull();
    await expect(resolveExternalProfileName({ ...args, nowMs: 2000 })).resolves.toBeNull();
    expect(querier.query).toHaveBeenCalledTimes(1);
  });
});

describe('ExternalIngestLimiter', () => {
  it('enforces per-pubkey hourly limits without recording a rejection', () => {
    const limiter = new ExternalIngestLimiter();
    for (let i = 0; i < 6; i += 1) {
      expect(limiter.tryAcquire('AA', i)).toBe(true);
    }
    expect(limiter.tryAcquire('aa', 6)).toBe(false);
    expect(limiter.tryAcquire('aa', 3_600_001)).toBe(true);
  });

  it('enforces the global hourly cap', () => {
    const limiter = new ExternalIngestLimiter();
    for (let i = 0; i < 30; i += 1) {
      expect(limiter.tryAcquire(`key-${i}`, i)).toBe(true);
    }
    expect(limiter.tryAcquire('overflow', 31)).toBe(false);
  });

  it('enforces per-pubkey and global UTC-day caps', () => {
    const perKey = new ExternalIngestLimiter();
    for (let i = 0; i < 20; i += 1) {
      expect(perKey.tryAcquire('key', i * 3_600_001)).toBe(true);
    }
    expect(perKey.tryAcquire('key', 20 * 3_600_001)).toBe(false);

    const global = new ExternalIngestLimiter();
    for (let i = 0; i < 100; i += 1) {
      expect(global.tryAcquire(`key-${i}`, i * 600_001)).toBe(true);
    }
    expect(global.tryAcquire('overflow', 100 * 600_001)).toBe(false);
    expect(global.tryAcquire('overflow', 86_400_001)).toBe(true);
  });
});
