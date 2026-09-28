import { encode as encodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import type { SqlClient } from '@/lib/auth/sql';
import {
  InMemoryBannerStore,
  PostgresBannerStore,
  bannerPublicUrl,
  migrateBannerSchema,
  wideBannerSize,
} from '@/lib/banner-store';

function jpeg(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  data.fill(255);
  return new Uint8Array(encodeJpeg({ data, width, height }, 50).data);
}

function png(width: number, height: number): Uint8Array {
  const image = new PNG({ width, height });
  image.data.fill(255);
  return new Uint8Array(PNG.sync.write(image));
}

describe('wideBannerSize', () => {
  it('accepts a wide still and rejects a portrait, a small strip, and junk', () => {
    expect(wideBannerSize(jpeg(1280, 640), 'image/jpeg')).toEqual({ width: 1280, height: 640 });
    expect(wideBannerSize(png(800, 400), 'image/png')).toEqual({ width: 800, height: 400 });
    expect(wideBannerSize(jpeg(800, 700), 'image/jpeg')).toBeNull();
    expect(wideBannerSize(jpeg(400, 200), 'image/jpeg')).toBeNull();
    expect(wideBannerSize(new Uint8Array([1, 2, 3]), 'image/jpeg')).toBeNull();
  });
});

describe('bannerPublicUrl', () => {
  it('uses the stored extension and strips a trailing slash', () => {
    expect(bannerPublicUrl('https://api.21.gifts/', 'acc', 'image/png')).toBe(
      'https://api.21.gifts/banners/acc.png',
    );
    expect(bannerPublicUrl('https://api.21.gifts', 'acc', 'image/webp')).toBe(
      'https://api.21.gifts/banners/acc.webp',
    );
    expect(bannerPublicUrl('https://api.21.gifts', 'acc', 'image/jpeg')).toBe(
      'https://api.21.gifts/banners/acc.jpg',
    );
  });
});

describe('InMemoryBannerStore', () => {
  it('stores a copy and clears it', async () => {
    const store = new InMemoryBannerStore();
    const bytes = new Uint8Array([1, 2, 3]);
    await store.set('acc', { contentType: 'image/jpeg', bytes });
    bytes[0] = 9;
    const stored = await store.get('acc');
    expect(stored?.bytes[0]).toBe(1);
    expect(stored?.contentType).toBe('image/jpeg');
    await store.set('acc', null);
    expect(await store.get('acc')).toBeNull();
    expect(await store.get('missing')).toBeNull();
  });
});

describe('PostgresBannerStore', () => {
  it('migrates, reads, writes, and rejects a bad row', async () => {
    const calls: string[] = [];
    let rows: { content_type: string; data: unknown }[] = [];
    const sql: SqlClient = {
      query: async <T>(text: string): Promise<T[]> => {
        calls.push(text);
        return rows as T[];
      },
      execute: async (text: string) => {
        calls.push(text);
      },
    };
    await migrateBannerSchema(sql);
    expect(calls.some((text) => text.includes('CREATE TABLE IF NOT EXISTS account_banner'))).toBe(
      true,
    );
    const store = new PostgresBannerStore(sql);
    expect(await store.get('acc')).toBeNull();
    rows = [{ content_type: 'image/jpeg', data: new Uint8Array([4, 5]) }];
    const jpegRow = await store.get('acc');
    expect(jpegRow?.bytes).toEqual(new Uint8Array([4, 5]));
    rows = [{ content_type: 'image/png', data: new ArrayBuffer(2) }];
    expect((await store.get('acc'))?.contentType).toBe('image/png');
    rows = [{ content_type: 'text/plain', data: new Uint8Array([1]) }];
    expect(await store.get('acc')).toBeNull();
    rows = [{ content_type: 'image/webp', data: 'nope' }];
    expect(await store.get('acc')).toBeNull();
    await store.set('acc', { contentType: 'image/webp', bytes: new Uint8Array([7]) });
    await store.set('acc', null);
    expect(calls.some((text) => text.startsWith('DELETE'))).toBe(true);
    expect(calls.some((text) => text.includes('ON CONFLICT'))).toBe(true);
  });
});
