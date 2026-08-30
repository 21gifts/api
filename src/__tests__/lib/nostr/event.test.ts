import { describe, expect, it } from 'vitest';
import {
  KIND0_PICTURE_URL,
  buildKind0Content,
  buildKind0Event,
  buildKind1Event,
  buildKind10002Event,
  forumPhotoUrl,
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
});

describe('kind0', () => {
  it('omits lud16 when the address is null', () => {
    expect(JSON.parse(buildKind0Content('Ada', null))).toEqual({
      name: 'Ada',
      display_name: 'Ada',
      website: 'https://21.gifts',
      picture: KIND0_PICTURE_URL,
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
    expect(buildKind0Event('Ada', null, 1).tags).toEqual([]);
  });

  it('includes lud16 when set', () => {
    expect(JSON.parse(buildKind0Content('Ada', 'ada@walletofsatoshi.com')).lud16).toBe(
      'ada@walletofsatoshi.com',
    );
  });
});

describe('kind10002', () => {
  it('emits r tags', () => {
    const event = buildKind10002Event(['wss://relay.nostr.space'], 2);
    expect(event.kind).toBe(10002);
    expect(event.tags).toEqual([['r', 'wss://relay.nostr.space']]);
  });
});
