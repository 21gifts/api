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
import { RecordingQuerier, type NostrEventFrame } from '@/lib/nostr/query';

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

function handBuiltRequest(noteEventId: string, overrides: Record<string, unknown>): string {
  return JSON.stringify({
    kind: 9734,
    id: '11'.repeat(32),
    sig: '22'.repeat(64),
    pubkey: '33'.repeat(32),
    created_at: 1,
    tags: [['e', noteEventId]],
    content: 'hello',
    ...overrides,
  });
}

function profileEvent(pubkey: string, content: unknown): NostrEventFrame {
  return {
    id: 'profile',
    pubkey,
    kind: 0,
    tags: [],
    created_at: 1,
    content,
  } as unknown as NostrEventFrame;
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

  it.each([
    ['a null description hash', null],
    ['a present non-hex description hash', 'g'.repeat(64)],
  ])('rejects a description with %s', (_label, expectedHash) => {
    const note = 'bc'.repeat(32);
    const description = signedRequest(note);
    expect(
      verifiedExternalZapRequest({
        tags: [['description', description]],
        descriptionHash: expectedHash,
        amountMsat: 21_000,
        noteEventId: note,
      }),
    ).toBeNull();
  });

  it.each([
    ['JSON null', 'null'],
    ['a JSON primitive', '42'],
    ['a JSON array', '[]'],
  ])('rejects a description that parses to %s', (_label, description) => {
    expect(
      verifiedExternalZapRequest({
        tags: [['description', description]],
        descriptionHash: descriptionHash(description),
        amountMsat: 1000,
        noteEventId: 'bd'.repeat(32),
      }),
    ).toBeNull();
  });

  it.each([
    ['the wrong kind', { kind: 1 }],
    ['a missing id', { id: undefined }],
    ['an empty id', { id: '' }],
    ['a missing signature', { sig: undefined }],
    ['an empty signature', { sig: '' }],
    ['a missing pubkey', { pubkey: undefined }],
    ['an empty pubkey', { pubkey: '' }],
    ['a missing created_at', { created_at: undefined }],
    ['missing tags', { tags: undefined }],
    ['missing content', { content: undefined }],
  ])('rejects a hand-built request with %s', (_label, overrides) => {
    const note = 'be'.repeat(32);
    const description = handBuiltRequest(note, overrides);
    expect(
      verifiedExternalZapRequest({
        tags: [['description', description]],
        descriptionHash: descriptionHash(description),
        amountMsat: 1000,
        noteEventId: note,
      }),
    ).toBeNull();
  });

  it('rejects a non-integer numeric invoice amount', () => {
    const note = 'bf'.repeat(32);
    const description = signedRequest(note, '1000');
    expect(
      verifiedExternalZapRequest({
        tags: [['description', description]],
        descriptionHash: descriptionHash(description),
        amountMsat: 1.5,
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

  it.each([
    ['non-string content', '03', 42, null],
    ['JSON null', '04', 'null', null],
    ['a JSON primitive', '05', '42', null],
    ['a JSON array', '06', '[]', null],
    ['a non-string display_name', '07', '{"display_name":42,"name":"Fallback"}', 'Fallback'],
    ['a blank display_name', '08', '{"display_name":"  ","name":"Fallback"}', 'Fallback'],
    ['a non-string fallback name', '09', '{"display_name":null,"name":42}', null],
    ['a blank fallback name', '0a', '{"display_name":null,"name":"  "}', null],
    ['invalid JSON', '0b', '{', null],
  ])('resolves a profile with %s', async (_label, pubkeyByte, content, expected) => {
    const querier = new RecordingQuerier();
    const pubkey = pubkeyByte.repeat(32);
    querier.events = [profileEvent(pubkey, content)];
    await expect(
      resolveExternalProfileName({
        querier,
        urls: ['wss://relay.example'],
        pubkey,
        nowMs: 1000,
        timeoutMs: 50,
      }),
    ).resolves.toBe(expected);
  });

  it('orders profiles with absent created_at values as timestamp zero', async () => {
    const querier = new RecordingQuerier();
    const pubkey = '0c'.repeat(32);
    querier.events = [
      { id: 'first', pubkey, kind: 0, tags: [], content: '{"name":"First"}' },
      { id: 'second', pubkey, kind: 0, tags: [], content: '{"name":"Second"}' },
    ];
    await expect(
      resolveExternalProfileName({
        querier,
        urls: ['wss://relay.example'],
        pubkey,
        nowMs: 1000,
        timeoutMs: 50,
      }),
    ).resolves.toBe('First');
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

  it('evicts a pubkey after the idle window', () => {
    const limiter = new ExternalIngestLimiter();
    expect(limiter.tryAcquire('idle', 0)).toBe(true);

    const afterIdleWindow = 48 * 3_600_000 + 1;
    expect(limiter.tryAcquire('other', afterIdleWindow)).toBe(true);
    for (let i = 1; i <= 6; i += 1) {
      expect(limiter.tryAcquire('idle', afterIdleWindow + i)).toBe(true);
    }
    expect(limiter.tryAcquire('idle', afterIdleWindow + 7)).toBe(false);
  });
});
