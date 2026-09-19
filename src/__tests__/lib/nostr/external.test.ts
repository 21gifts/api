import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import {
  EXTERNAL_REPLY_FUTURE_SKEW_MS,
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
    expect(EXTERNAL_REPLY_FUTURE_SKEW_MS).toBe(600_000);
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

  it('falls back for Support with Cyrillic o U+043E', () => {
    const pubkey = 'ABCDEF0123456789';
    expect(externalDisplayName({ profileName: 'Supp\u043ert', pubkey, accountNames: [] })).toBe(
      'abcdef01…6789',
    );
  });

  it('falls back for Admin with Cyrillic A U+0410', () => {
    const pubkey = 'ABCDEF0123456789';
    expect(externalDisplayName({ profileName: '\u0410dmin', pubkey, accountNames: [] })).toBe(
      'abcdef01…6789',
    );
  });

  it('falls back for a Cyrillic-Alice collision with a member name', () => {
    const pubkey = 'ABCDEF0123456789';
    expect(
      externalDisplayName({ profileName: '\u0410lice', pubkey, accountNames: ['Alice'] }),
    ).toBe('abcdef01…6789');
  });

  it('falls back for Team with Greek capital tau U+03A4', () => {
    const pubkey = 'ABCDEF0123456789';
    expect(externalDisplayName({ profileName: '\u03a4eam', pubkey, accountNames: [] })).toBe(
      'abcdef01…6789',
    );
  });

  it('keeps an ordinary pure-Cyrillic name', () => {
    expect(
      externalDisplayName({
        profileName: '\u041c\u0430\u0440\u0438\u044f',
        pubkey: 'ABCDEF0123456789',
        accountNames: [],
      }),
    ).toBe('\u041c\u0430\u0440\u0438\u044f');
  });

  it('keeps an ordinary Latin name with diacritics', () => {
    expect(
      externalDisplayName({
        profileName: 'José',
        pubkey: 'ABCDEF0123456789',
        accountNames: [],
      }),
    ).toBe('José');
  });

  it('folds Greek capital nu to N and small eta to n before comparing member names', () => {
    const pubkey = 'ABCDEF0123456789';
    expect(
      externalDisplayName({
        profileName: '\u039d\u0399\u039a\u039f',
        pubkey,
        accountNames: ['Niko'],
      }),
    ).toBe('abcdef01…6789');
    expect(
      externalDisplayName({
        profileName: '\u03a4\u03b9\u03b7\u03b1',
        pubkey,
        accountNames: ['Tina'],
      }),
    ).toBe('abcdef01…6789');
  });

  it('falls back for Admin spelled with Greek and Cyrillic look-alikes only', () => {
    const pubkey = 'ABCDEF0123456789';
    expect(
      externalDisplayName({
        profileName: '\u0391\u0501\u043c\u0456\u039d',
        pubkey,
        accountNames: [],
      }),
    ).toBe('abcdef01…6789');
  });

  it('falls back for a name mixing Greek and Cyrillic without any Latin letter', () => {
    const pubkey = 'ABCDEF0123456789';
    expect(
      externalDisplayName({
        profileName: '\u0391\u043b\u0435\u043a\u0441',
        pubkey,
        accountNames: [],
      }),
    ).toBe('abcdef01…6789');
  });

  it('keeps a name in a script without Latin look-alikes and still protects a member with that name', () => {
    const pubkey = 'ABCDEF0123456789';
    expect(
      externalDisplayName({ profileName: '\u7530\u4e2d', pubkey, accountNames: ['Alice'] }),
    ).toBe('\u7530\u4e2d');
    expect(
      externalDisplayName({ profileName: '\u7530\u4e2d', pubkey, accountNames: ['\u7530\u4e2d'] }),
    ).toBe('abcdef01…6789');
  });

  it('falls back for a name without any letter or digit', () => {
    expect(
      externalDisplayName({ profileName: '***', pubkey: 'ABCDEF0123456789', accountNames: [] }),
    ).toBe('abcdef01…6789');
  });

  it('falls back for an otherwise ordinary mixed Latin and Cyrillic name', () => {
    const pubkey = 'ABCDEF0123456789';
    expect(externalDisplayName({ profileName: 'Ca\u0442nip', pubkey, accountNames: [] })).toBe(
      'abcdef01…6789',
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
    const args = {
      querier,
      urls: ['wss://relay.example'],
      pubkey,
      nowMs: 1000,
      timeoutMs: 50,
      verifyProfile: () => true,
    };
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

  it('ignores a newer forged profile after a valid cached profile expires', async () => {
    const querier = new RecordingQuerier();
    const signed = finalizeEvent(
      { kind: 0, created_at: 1, tags: [], content: '{"name":"Signed"}' },
      generateSecretKey(),
    );
    const pubkey = signed.pubkey;
    querier.events = [signed];
    const args = { querier, urls: ['wss://relay.example'], pubkey, nowMs: 1000, timeoutMs: 50 };
    await expect(resolveExternalProfileName(args)).resolves.toBe('Signed');

    querier.events = [
      signed,
      {
        id: '11'.repeat(32),
        pubkey,
        kind: 0,
        tags: [],
        created_at: 2,
        content: '{"name":"Forged"}',
      },
    ];
    await expect(
      resolveExternalProfileName({ ...args, nowMs: 1000 + 60 * 60 * 1000 }),
    ).resolves.toBe('Signed');
    expect(querier.calls).toHaveLength(2);
  });

  it('lets an injected verifier select a valid older profile over an invalid newer one', async () => {
    const querier = new RecordingQuerier();
    const pubkey = '0d'.repeat(32);
    querier.events = [
      { id: 'valid', pubkey, kind: 0, tags: [], created_at: 1, content: '{"name":"Valid"}' },
      { id: 'forged', pubkey, kind: 0, tags: [], created_at: 2, content: '{"name":"Forged"}' },
    ];
    await expect(
      resolveExternalProfileName({
        querier,
        urls: ['wss://relay.example'],
        pubkey,
        nowMs: 1000,
        timeoutMs: 50,
        verifyProfile: (event) => event.id === 'valid',
      }),
    ).resolves.toBe('Valid');
  });

  it.each([
    ['a missing created_at', '0e', { created_at: undefined }],
    ['a non-string id', '0f', { id: 1 }],
    ['an empty id', '10', { id: '' }],
    ['a non-string signature', '11', { sig: 1 }],
    ['an empty signature', '12', { sig: '' }],
    ['missing content', '14', { content: undefined }],
  ])('rejects a profile frame with %s', async (_label, pubkeyByte, overrides) => {
    const querier = new RecordingQuerier();
    const pubkey = pubkeyByte.repeat(32);
    querier.events = [
      {
        id: '11'.repeat(32),
        pubkey,
        kind: 0,
        tags: [],
        created_at: 1,
        content: '{"name":"Forged"}',
        sig: '22'.repeat(64),
        ...overrides,
      } as unknown as NostrEventFrame,
    ];
    await expect(
      resolveExternalProfileName({
        querier,
        urls: ['wss://relay.example'],
        pubkey,
        nowMs: 1000,
        timeoutMs: 50,
      }),
    ).resolves.toBeNull();
  });

  it('ignores oversized profile content before parsing it', async () => {
    const querier = new RecordingQuerier();
    const pubkey = '13'.repeat(32);
    querier.events = [profileEvent(pubkey, 'x'.repeat(64 * 1024 + 1))];
    const parse = vi.spyOn(JSON, 'parse');
    const verifyProfile = vi.fn(() => true);
    try {
      await expect(
        resolveExternalProfileName({
          querier,
          urls: ['wss://relay.example'],
          pubkey,
          nowMs: 1000,
          timeoutMs: 50,
          verifyProfile,
        }),
      ).resolves.toBeNull();
      expect(verifyProfile).not.toHaveBeenCalled();
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
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
        verifyProfile: () => true,
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
        verifyProfile: () => true,
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

  it('release restores per-pubkey hourly and UTC-day budget', () => {
    const hourly = new ExternalIngestLimiter();
    for (let i = 0; i < 6; i += 1) {
      expect(hourly.tryAcquire('AA', i)).toBe(true);
    }
    expect(hourly.tryAcquire('aa', 6)).toBe(false);
    hourly.release('aa', 6);
    expect(hourly.tryAcquire('aa', 6)).toBe(true);
    expect(hourly.tryAcquire('aa', 6)).toBe(false);

    const daily = new ExternalIngestLimiter();
    for (let i = 0; i < 20; i += 1) {
      expect(daily.tryAcquire('key', i * 3_600_001)).toBe(true);
    }
    const afterTwentyHours = 20 * 3_600_001;
    expect(daily.tryAcquire('key', afterTwentyHours)).toBe(false);
    daily.release('KEY', afterTwentyHours);
    expect(daily.tryAcquire('key', afterTwentyHours)).toBe(true);
  });

  it('release restores global hourly and UTC-day budget', () => {
    const hourly = new ExternalIngestLimiter();
    for (let i = 0; i < 30; i += 1) {
      expect(hourly.tryAcquire(`hour-${i}`, i)).toBe(true);
    }
    expect(hourly.tryAcquire('hour-overflow', 30)).toBe(false);
    hourly.release('HOUR-0', 30);
    expect(hourly.tryAcquire('hour-overflow', 30)).toBe(true);

    const daily = new ExternalIngestLimiter();
    for (let i = 0; i < 100; i += 1) {
      expect(daily.tryAcquire(`day-${i}`, i * 600_001)).toBe(true);
    }
    const afterHundredIntervals = 100 * 600_001;
    expect(daily.tryAcquire('day-overflow', afterHundredIntervals)).toBe(false);
    daily.release('DAY-99', afterHundredIntervals);
    expect(daily.tryAcquire('day-overflow', afterHundredIntervals)).toBe(true);
  });

  it('release is a safe no-op without a retained acquisition', () => {
    const limiter = new ExternalIngestLimiter();
    limiter.release('missing', 0);

    expect(limiter.tryAcquire('old', 0)).toBe(true);
    expect(limiter.tryAcquire('current', 3_600_001)).toBe(true);
    limiter.release('old', 3_600_001);
    limiter.release('old', 3_600_001);

    for (let i = 1; i < 6; i += 1) {
      expect(limiter.tryAcquire('current', 3_600_001 + i)).toBe(true);
    }
    expect(limiter.tryAcquire('current', 3_600_007)).toBe(false);
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
