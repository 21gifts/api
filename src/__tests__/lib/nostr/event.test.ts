import { describe, expect, it } from 'vitest';
import {
  KIND0_PICTURE_URL,
  buildKind0Content,
  buildKind0Event,
  buildKind1Event,
  buildKind5Event,
  buildKind10002Event,
  forumExtraPhotoUrl,
  forumPhotoUrl,
  notePageUrl,
  kind1ContentWithHashtags,
  kind1HasHashtag,
  kind1Tags,
} from '@/lib/nostr/event';

describe('kind1', () => {
  it('uses frozen tags and no name prefix', () => {
    const event = buildKind1Event('hello', 1_700_000_000);
    expect(event.kind).toBe(1);
    expect(event.content).toBe('hello\n\n#bitcoin #21gifts');
    expect(event.tags).toEqual([
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['r', 'https://21.gifts'],
    ]);
    expect(kind1Tags()).not.toBe(event.tags);
  });

  it('appends the photo URL and imeta when a photo is set', () => {
    const event = buildKind1Event('hello', 1, {
      url: 'http://127.0.0.1:3000/messages/m1/photo.jpg',
      mime: 'image/jpeg',
    });
    expect(event.content).toBe(
      'hello\nhttp://127.0.0.1:3000/messages/m1/photo.jpg\n\n#bitcoin #21gifts',
    );
    expect(event.tags.at(-1)).toEqual([
      'imeta',
      'url http://127.0.0.1:3000/messages/m1/photo.jpg',
      'm image/jpeg',
    ]);
  });

  it('includes dim and size on imeta when provided', () => {
    const event = buildKind1Event('clip', 1, {
      url: 'https://api.21.gifts/messages/m1/video.mp4',
      mime: 'video/mp4',
      dim: '720x1280',
      size: 1659838,
      posterUrl: 'https://api.21.gifts/messages/m1/photo.jpg',
    });
    expect(event.tags.at(-1)).toEqual([
      'imeta',
      'url https://api.21.gifts/messages/m1/video.mp4',
      'm video/mp4',
      'dim 720x1280',
      'size 1659838',
      'image https://api.21.gifts/messages/m1/photo.jpg',
    ]);
  });

  it('omits dim and size on imeta when not provided', () => {
    const event = buildKind1Event('clip', 1, {
      url: 'https://api.21.gifts/messages/m1/video.mp4',
      mime: 'video/mp4',
      posterUrl: 'https://api.21.gifts/messages/m1/photo.jpg',
    });
    expect(event.tags.at(-1)).toEqual([
      'imeta',
      'url https://api.21.gifts/messages/m1/video.mp4',
      'm video/mp4',
      'image https://api.21.gifts/messages/m1/photo.jpg',
    ]);
  });

  it('uses the photo URL as content when text is empty', () => {
    const event = buildKind1Event('', 1, {
      url: 'http://127.0.0.1:3000/messages/m1/photo.png',
      mime: 'image/png',
    });
    expect(event.content).toBe('http://127.0.0.1:3000/messages/m1/photo.png\n\n#bitcoin #21gifts');
  });

  it('does not treat https://21.gifts as #21gifts', () => {
    expect(kind1HasHashtag('see https://21.gifts', '21gifts')).toBe(false);
    expect(kind1ContentWithHashtags('see https://21.gifts')).toBe(
      'see https://21.gifts\n\n#bitcoin #21gifts',
    );
    expect(buildKind1Event('see https://21.gifts', 1).content).toBe(
      'see https://21.gifts\n\n#bitcoin #21gifts',
    );
  });

  it('appends only missing hashtags and leaves complete content alone', () => {
    expect(kind1ContentWithHashtags('')).toBe('#bitcoin #21gifts');
    expect(kind1ContentWithHashtags('hello #21gifts')).toBe('hello #21gifts\n\n#bitcoin');
    expect(kind1ContentWithHashtags('x\n\n#bitcoin #21gifts')).toBe('x\n\n#bitcoin #21gifts');
    expect(kind1ContentWithHashtags('hello #21Gifts')).toBe('hello #21Gifts\n\n#bitcoin');
    expect(kind1HasHashtag('note #Bitcoin here', 'bitcoin')).toBe(true);
  });

  it('does not treat #bitcoiners or #21giftshop as the Damus tokens', () => {
    expect(kind1HasHashtag('hello #bitcoiners', 'bitcoin')).toBe(false);
    expect(kind1HasHashtag('shop #21giftshop', '21gifts')).toBe(false);
    expect(kind1ContentWithHashtags('hello #bitcoiners')).toBe(
      'hello #bitcoiners\n\n#bitcoin #21gifts',
    );
    expect(kind1ContentWithHashtags('shop #21giftshop')).toBe(
      'shop #21giftshop\n\n#bitcoin #21gifts',
    );
    expect(kind1HasHashtag('#bitcoin.', 'bitcoin')).toBe(true);
    expect(kind1HasHashtag('#21gifts', '21gifts')).toBe(true);
  });

  it('appends NIP-10 e/p tags when replyTo is set', () => {
    const noteEventId = 'ee'.repeat(32);
    const noteAuthorPubkey = 'aa'.repeat(32);
    const event = buildKind1Event('reply', 1_700_000_000, undefined, {
      noteEventId,
      spaceRelay: 'wss://relay.nostr.space',
      noteAuthorPubkey,
    });
    expect(event.tags).toEqual([
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['r', 'https://21.gifts'],
      ['e', noteEventId, 'wss://relay.nostr.space', 'root'],
      ['e', noteEventId, 'wss://relay.nostr.space', 'reply'],
      ['p', noteAuthorPubkey],
    ]);
  });

  it('keeps top-level notes without e/p tags', () => {
    const event = buildKind1Event('hello', 1);
    expect(event.tags.some((tag) => tag[0] === 'e' || tag[0] === 'p')).toBe(false);
  });

  it('inserts extra t tags after 21gifts and before r', () => {
    expect(kind1Tags(['berlin'])).toEqual([
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['t', 'berlin'],
      ['r', 'https://21.gifts'],
    ]);
    expect(kind1Tags(['bitcoin'])).toEqual([
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['r', 'https://21.gifts'],
    ]);
  });

  it('appends extra location hashtags after bitcoin and 21gifts', () => {
    expect(kind1ContentWithHashtags('hello', ['Berlin'])).toBe(
      'hello\n\n#bitcoin #21gifts #Berlin',
    );
    expect(kind1ContentWithHashtags('hello\n\n#bitcoin #21gifts #Berlin', ['Berlin'])).toBe(
      'hello\n\n#bitcoin #21gifts #Berlin',
    );
  });

  it('adds a location hashtag and t tag when location is set', () => {
    const berlin = buildKind1Event('hello', 1, undefined, undefined, 'Berlin');
    expect(berlin.content).toBe('hello\n\n#bitcoin #21gifts #Berlin');
    expect(berlin.tags).toEqual([
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['t', 'berlin'],
      ['r', 'https://21.gifts'],
    ]);
    const newYork = buildKind1Event('hello', 1, undefined, undefined, 'New York');
    expect(newYork.content).toBe('hello\n\n#bitcoin #21gifts #NewYork');
    expect(newYork.tags).toEqual([
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['t', 'newyork'],
      ['r', 'https://21.gifts'],
    ]);
  });

  it('omits a location hashtag when location is null or collides with Damus tokens', () => {
    const fourArg = buildKind1Event('hello', 1);
    const withNull = buildKind1Event('hello', 1, undefined, undefined, null);
    expect(withNull).toEqual(fourArg);
    const bitcoinLocation = buildKind1Event('hello', 1, undefined, undefined, 'Bitcoin');
    expect(bitcoinLocation.content).toBe('hello\n\n#bitcoin #21gifts');
    expect(bitcoinLocation.tags).toEqual([
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['r', 'https://21.gifts'],
    ]);
  });

  it('keeps extra location t tags before r when replyTo is set', () => {
    const noteEventId = 'ee'.repeat(32);
    const noteAuthorPubkey = 'aa'.repeat(32);
    const event = buildKind1Event(
      'reply',
      1,
      undefined,
      {
        noteEventId,
        spaceRelay: 'wss://relay.nostr.space',
        noteAuthorPubkey,
      },
      'Berlin',
    );
    expect(event.tags).toEqual([
      ['t', 'bitcoin'],
      ['t', '21gifts'],
      ['t', 'berlin'],
      ['r', 'https://21.gifts'],
      ['e', noteEventId, 'wss://relay.nostr.space', 'root'],
      ['e', noteEventId, 'wss://relay.nostr.space', 'reply'],
      ['p', noteAuthorPubkey],
    ]);
  });

  it('keeps an omitted or empty extraPhotos arg bit-identical to five-arg one-photo', () => {
    const photo = {
      url: 'http://127.0.0.1:3000/messages/m1/photo.jpg',
      mime: 'image/jpeg' as const,
    };
    const threeArg = buildKind1Event('hello', 1, photo);
    const fiveArg = buildKind1Event('hello', 1, photo, undefined, undefined);
    const emptyExtras = buildKind1Event('hello', 1, photo, undefined, undefined, []);
    expect(fiveArg).toEqual(threeArg);
    expect(emptyExtras).toEqual(threeArg);
  });

  it('appends extra still URL lines and imeta without a poster', () => {
    const photo = {
      url: 'http://127.0.0.1:3000/messages/m1/photo.jpg',
      mime: 'image/jpeg' as const,
    };
    const extra = {
      url: 'http://127.0.0.1:3000/messages/m1/photo/1.jpg',
      mime: 'image/jpeg' as const,
      dim: '640x480',
      size: 12,
    };
    const event = buildKind1Event('hello', 1, photo, undefined, undefined, [extra]);
    expect(event.content).toBe(
      'hello\nhttp://127.0.0.1:3000/messages/m1/photo.jpg\nhttp://127.0.0.1:3000/messages/m1/photo/1.jpg\n\n#bitcoin #21gifts',
    );
    expect(event.tags.filter((tag) => tag[0] === 'imeta')).toEqual([
      ['imeta', 'url http://127.0.0.1:3000/messages/m1/photo.jpg', 'm image/jpeg'],
      [
        'imeta',
        'url http://127.0.0.1:3000/messages/m1/photo/1.jpg',
        'm image/jpeg',
        'dim 640x480',
        'size 12',
      ],
    ]);
  });

  it('uses extra still URL as content when text is empty and first photo is omitted', () => {
    const extra = {
      url: 'http://127.0.0.1:3000/messages/m1/photo/1.jpg',
      mime: 'image/jpeg' as const,
    };
    const event = buildKind1Event('', 1, undefined, undefined, undefined, [extra]);
    expect(event.content).toBe(
      'http://127.0.0.1:3000/messages/m1/photo/1.jpg\n\n#bitcoin #21gifts',
    );
    expect(event.tags.filter((tag) => tag[0] === 'imeta')).toEqual([
      ['imeta', 'url http://127.0.0.1:3000/messages/m1/photo/1.jpg', 'm image/jpeg'],
    ]);
  });

  it('appends imeta x and duration only when they are valid', () => {
    const hash = 'ab'.repeat(32);
    const extraHash = 'cd'.repeat(32);
    const event = buildKind1Event('clip', 1, {
      url: 'https://api.21.gifts/messages/m1/video.mp4',
      mime: 'video/mp4',
      dim: '720x1280',
      size: 10,
      posterUrl: 'https://api.21.gifts/messages/m1/photo.jpg',
      hash,
      durationSeconds: 12,
    });
    expect(event.tags.at(-1)).toEqual([
      'imeta',
      'url https://api.21.gifts/messages/m1/video.mp4',
      'm video/mp4',
      'dim 720x1280',
      'size 10',
      'image https://api.21.gifts/messages/m1/photo.jpg',
      `x ${hash}`,
      'duration 12',
    ]);
    const rejected = buildKind1Event('clip', 1, {
      url: 'https://api.21.gifts/messages/m1/video.mp4',
      mime: 'video/mp4',
      hash: 'AB'.repeat(32),
      durationSeconds: 0,
    });
    expect(rejected.tags.at(-1)).toEqual([
      'imeta',
      'url https://api.21.gifts/messages/m1/video.mp4',
      'm video/mp4',
    ]);
    const fractional = buildKind1Event('clip', 1, {
      url: 'https://api.21.gifts/messages/m1/video.mp4',
      mime: 'video/mp4',
      hash: 'abcd',
      durationSeconds: 1.5,
    });
    expect(fractional.tags.at(-1)).toEqual([
      'imeta',
      'url https://api.21.gifts/messages/m1/video.mp4',
      'm video/mp4',
    ]);
    const tooLong = buildKind1Event('clip', 1, {
      url: 'https://api.21.gifts/messages/m1/video.mp4',
      mime: 'video/mp4',
      durationSeconds: 86401,
    });
    expect(tooLong.tags.at(-1)?.some((part) => part.startsWith('duration '))).toBe(false);
    const withExtra = buildKind1Event(
      'pics',
      1,
      {
        url: 'https://api.21.gifts/messages/m1/photo.jpg',
        mime: 'image/jpeg',
        hash,
      },
      undefined,
      undefined,
      [
        {
          url: 'https://api.21.gifts/messages/m1/photo/1.jpg',
          mime: 'image/jpeg',
          hash: extraHash,
          durationSeconds: 86400,
        },
      ],
    );
    expect(withExtra.tags.filter((tag) => tag[0] === 'imeta')).toEqual([
      ['imeta', 'url https://api.21.gifts/messages/m1/photo.jpg', 'm image/jpeg', `x ${hash}`],
      [
        'imeta',
        'url https://api.21.gifts/messages/m1/photo/1.jpg',
        'm image/jpeg',
        `x ${extraHash}`,
        'duration 86400',
      ],
    ]);
  });
});

describe('note page link', () => {
  const page = 'https://21.gifts/l/abcdef01';

  it('builds /l/ from a UUID and rejects anything else', () => {
    expect(notePageUrl('https://21.gifts/', 'ABCDEF01-2222-4333-8444-555555555555')).toBe(
      'https://21.gifts/l/abcdef01',
    );
    expect(notePageUrl('', 'abcdef01-2222-4333-8444-555555555555')).toBeNull();
    expect(notePageUrl('https://21.gifts', 'm-pic')).toBeNull();
  });

  it('points the reference and the text at the note page', () => {
    const event = buildKind1Event('hello', 1, undefined, undefined, null, undefined, page);
    expect(event.content).toBe(`hello\n${page}\n\n#bitcoin #21gifts`);
    expect(event.tags.find((tag) => tag[0] === 'r')?.[1]).toBe(page);
    const again = buildKind1Event(`see ${page}`, 1, undefined, undefined, null, undefined, page);
    expect(again.content).toBe(`see ${page}\n\n#bitcoin #21gifts`);
    const empty = buildKind1Event('', 1, undefined, undefined, null, undefined, page);
    expect(empty.content).toBe(`${page}\n\n#bitcoin #21gifts`);
    expect(
      buildKind1Event('hello', 1, undefined, undefined, null, undefined, null).tags[2]?.[1],
    ).toBe('https://21.gifts');
    expect(
      buildKind1Event('hello', 1, undefined, undefined, null, undefined, '').tags[2]?.[1],
    ).toBe('https://21.gifts');
  });

  it('omits a blurhash that is not BlurHash text', () => {
    const event = buildKind1Event('x', 1, {
      url: 'https://api.21.gifts/messages/m1/photo.jpg',
      mime: 'image/jpeg',
      blurhash: '!!!',
    });
    const imeta = event.tags.find((tag) => tag[0] === 'imeta');
    expect(imeta?.some((part) => part.startsWith('blurhash '))).toBe(false);
    const kept = buildKind1Event('x', 1, {
      url: 'https://api.21.gifts/messages/m1/photo.jpg',
      mime: 'image/jpeg',
      blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
    });
    expect(kept.tags.find((tag) => tag[0] === 'imeta')).toContain(
      'blurhash LEHV6nWB2yk8pyo0adR*.7kCMdnj',
    );
  });
});

describe('kind0', () => {
  it('omits lud16 when the address is null', () => {
    expect(JSON.parse(buildKind0Content('Ada', null))).toEqual({
      name: 'Ada',
      display_name: 'Ada',
      website: 'https://21.gifts',
      banner: 'https://21.gifts/og.png',
      picture: KIND0_PICTURE_URL,
      about: '21.gifts',
    });
    expect(forumPhotoUrl('https://api.21.gifts/', 'm1')).toBe(
      'https://api.21.gifts/messages/m1/photo.jpg',
    );
    expect(forumPhotoUrl('https://api.21.gifts', 'm1', 'image/png')).toBe(
      'https://api.21.gifts/messages/m1/photo.png',
    );
    expect(forumPhotoUrl('https://api.21.gifts', 'm1', 'image/webp')).toBe(
      'https://api.21.gifts/messages/m1/photo.webp',
    );
    expect(forumExtraPhotoUrl('https://api.21.gifts/', 'm1', 1)).toBe(
      'https://api.21.gifts/messages/m1/photo/1.jpg',
    );
    expect(forumExtraPhotoUrl('https://api.21.gifts', 'm1', 2, 'image/png')).toBe(
      'https://api.21.gifts/messages/m1/photo/2.png',
    );
    expect(forumExtraPhotoUrl('https://api.21.gifts', 'm1', 1, 'image/webp')).toBe(
      'https://api.21.gifts/messages/m1/photo/1.webp',
    );
    expect(buildKind0Event('Ada', null, 1).tags).toEqual([]);
  });

  it('includes lud16 when set', () => {
    expect(JSON.parse(buildKind0Content('Ada', 'ada@walletofsatoshi.com')).lud16).toBe(
      'ada@walletofsatoshi.com',
    );
  });

  it('uses the optional about argument for kind:0 content', () => {
    expect(JSON.parse(buildKind0Content('Ada', null, null, 'Hello from Ada')).about).toBe(
      'Hello from Ada',
    );
    expect(JSON.parse(buildKind0Event('Ada', null, 1, null, 'Bio').content).about).toBe('Bio');
  });
});

describe('kind5', () => {
  it('builds an empty NIP-09 template with e and k tags', () => {
    const eventId = 'ab'.repeat(32);
    const event = buildKind5Event(eventId, 1_700_000_000);
    expect(event).toEqual({
      kind: 5,
      content: '',
      tags: [
        ['e', eventId],
        ['k', '1'],
      ],
      created_at: 1_700_000_000,
    });
  });
});

describe('kind10002', () => {
  it('emits r tags', () => {
    const event = buildKind10002Event(['wss://relay.nostr.space'], 2);
    expect(event.kind).toBe(10002);
    expect(event.tags).toEqual([['r', 'wss://relay.nostr.space']]);
  });
});
