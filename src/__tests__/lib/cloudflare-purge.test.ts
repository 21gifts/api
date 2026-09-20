import { describe, expect, it } from 'vitest';
import {
  forumMediaPurgeUrls,
  purgeCloudflareFiles,
  resolveCloudflarePurgeConfig,
} from '@/lib/cloudflare-purge';
import { unsignedNostrDefaults, type MessageRow } from '@/lib/message';

const ROW: MessageRow = {
  id: '11111111-1111-4111-8111-111111111111',
  accountId: 'acc',
  name: 'Ada',
  text: 'hi',
  createdAt: new Date('2026-09-20T00:00:00.000Z'),
  hasPhoto: false,
  ...unsignedNostrDefaults(),
};

describe('resolveCloudflarePurgeConfig', () => {
  it('returns null when either value is missing or blank', () => {
    expect(resolveCloudflarePurgeConfig({})).toBeNull();
    expect(resolveCloudflarePurgeConfig({ CLOUDFLARE_ZONE_ID: 'zone' })).toBeNull();
    expect(resolveCloudflarePurgeConfig({ CLOUDFLARE_API_TOKEN: 'tok' })).toBeNull();
    expect(
      resolveCloudflarePurgeConfig({ CLOUDFLARE_ZONE_ID: '  ', CLOUDFLARE_API_TOKEN: 'tok' }),
    ).toBeNull();
  });

  it('trims both values', () => {
    expect(
      resolveCloudflarePurgeConfig({
        CLOUDFLARE_ZONE_ID: ' zone ',
        CLOUDFLARE_API_TOKEN: ' tok ',
      }),
    ).toEqual({ zoneId: 'zone', token: 'tok' });
  });
});

describe('forumMediaPurgeUrls', () => {
  it('returns no URLs when apiBase is empty', () => {
    expect(forumMediaPurgeUrls('', { ...ROW, hasPhoto: true })).toEqual([]);
  });

  it('strips a trailing slash and lists photo plus video extensions', () => {
    const urls = forumMediaPurgeUrls('https://api.21.gifts/', {
      ...ROW,
      hasPhoto: true,
      photoCount: 3,
      hasVideo: true,
    });
    expect(urls).toEqual([
      'https://api.21.gifts/messages/11111111-1111-4111-8111-111111111111/photo',
      'https://api.21.gifts/messages/11111111-1111-4111-8111-111111111111/photo.jpg',
      'https://api.21.gifts/messages/11111111-1111-4111-8111-111111111111/photo.jpeg',
      'https://api.21.gifts/messages/11111111-1111-4111-8111-111111111111/photo.png',
      'https://api.21.gifts/messages/11111111-1111-4111-8111-111111111111/photo.webp',
      'https://api.21.gifts/messages/11111111-1111-4111-8111-111111111111/photo/1.jpg',
      'https://api.21.gifts/messages/11111111-1111-4111-8111-111111111111/photo/1.jpeg',
      'https://api.21.gifts/messages/11111111-1111-4111-8111-111111111111/photo/1.png',
      'https://api.21.gifts/messages/11111111-1111-4111-8111-111111111111/photo/1.webp',
      'https://api.21.gifts/messages/11111111-1111-4111-8111-111111111111/photo/2.jpg',
      'https://api.21.gifts/messages/11111111-1111-4111-8111-111111111111/photo/2.jpeg',
      'https://api.21.gifts/messages/11111111-1111-4111-8111-111111111111/photo/2.png',
      'https://api.21.gifts/messages/11111111-1111-4111-8111-111111111111/photo/2.webp',
      'https://api.21.gifts/messages/11111111-1111-4111-8111-111111111111/video.mp4',
      'https://api.21.gifts/messages/11111111-1111-4111-8111-111111111111/video.webm',
      'https://api.21.gifts/messages/11111111-1111-4111-8111-111111111111/video.mov',
    ]);
  });

  it('lists photo 0 when hasPhoto is true and photoCount is omitted', () => {
    const urls = forumMediaPurgeUrls('https://api.21.gifts', { ...ROW, hasPhoto: true });
    expect(urls).toContain(
      'https://api.21.gifts/messages/11111111-1111-4111-8111-111111111111/photo.jpg',
    );
    expect(urls.some((url) => url.includes('/photo/1.'))).toBe(false);
  });

  it('lists photo 0 when only photoCount is set', () => {
    const urls = forumMediaPurgeUrls('https://api.21.gifts', { ...ROW, photoCount: 1 });
    expect(urls[0]).toBe(
      'https://api.21.gifts/messages/11111111-1111-4111-8111-111111111111/photo',
    );
    expect(urls.some((url) => url.endsWith('/photo/1.jpg'))).toBe(false);
  });
});

describe('purgeCloudflareFiles', () => {
  it('is a no-op for an empty list', async () => {
    const calls: unknown[] = [];
    await purgeCloudflareFiles(
      async (input, init) => {
        calls.push([input, init]);
        return new Response('{}', { status: 200 });
      },
      { zoneId: 'zone', token: 'secret-token' },
      [],
    );
    expect(calls).toEqual([]);
  });

  it('posts files in chunks of 30 and omits the token from errors', async () => {
    const bodies: unknown[] = [];
    const urls = Array.from({ length: 31 }, (_, i) => `https://api.21.gifts/u${i}`);
    await purgeCloudflareFiles(
      async (input, init) => {
        expect(String(input)).toBe('https://api.cloudflare.com/client/v4/zones/zone/purge_cache');
        expect(init?.headers).toEqual({
          Authorization: 'Bearer secret-token',
          'Content-Type': 'application/json',
        });
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      },
      { zoneId: 'zone', token: 'secret-token' },
      urls,
    );
    expect(bodies).toEqual([{ files: urls.slice(0, 30) }, { files: urls.slice(30) }]);
  });

  it('throws a generic error on HTTP 500 without the token', async () => {
    await expect(
      purgeCloudflareFiles(
        async () => new Response('nope', { status: 500 }),
        { zoneId: 'zone', token: 'secret-token' },
        ['https://api.21.gifts/photo.jpg'],
      ),
    ).rejects.toThrow('Cloudflare purge failed');
  });

  it('throws a generic error when success is not true', async () => {
    await expect(
      purgeCloudflareFiles(
        async () => new Response(JSON.stringify({ success: false }), { status: 200 }),
        { zoneId: 'zone', token: 'secret-token' },
        ['https://api.21.gifts/photo.jpg'],
      ),
    ).rejects.toThrow('Cloudflare purge failed');
  });

  it('throws a generic error when the body is not JSON', async () => {
    await expect(
      purgeCloudflareFiles(
        async () => new Response('not-json', { status: 200 }),
        { zoneId: 'zone', token: 'secret-token' },
        ['https://api.21.gifts/photo.jpg'],
      ),
    ).rejects.toThrow('Cloudflare purge failed');
  });
});
