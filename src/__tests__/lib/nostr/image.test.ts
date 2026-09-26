import { encode as encodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { imageBlurhash, imageDisplaySize, stillLook } from '@/lib/nostr/image';

function png(width: number, height: number): Uint8Array {
  const image = new PNG({ width, height });
  image.data.fill(255);
  return new Uint8Array(PNG.sync.write(image));
}

function jpeg(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  data.fill(255);
  return new Uint8Array(encodeJpeg({ data, width, height }, 50).data);
}

function webp(widthMinus1: number, heightMinus1: number, vp8x: boolean): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  if (vp8x) {
    bytes.set([0x56, 0x50, 0x38, 0x58], 12);
  }
  bytes[24] = widthMinus1 & 0xff;
  bytes[25] = (widthMinus1 >> 8) & 0xff;
  bytes[26] = (widthMinus1 >> 16) & 0xff;
  bytes[27] = heightMinus1 & 0xff;
  bytes[28] = (heightMinus1 >> 8) & 0xff;
  bytes[29] = (heightMinus1 >> 16) & 0xff;
  return bytes;
}

describe('image display size and blurhash', () => {
  it('reads png and jpeg, including a sample larger than 32 px', () => {
    expect(imageDisplaySize(png(1, 1), 'image/png')).toBe('1x1');
    expect(imageDisplaySize(jpeg(1, 1), 'image/jpeg')).toBe('1x1');
    expect(imageBlurhash(png(1, 1), 'image/png')).toMatch(/^[0-9A-Za-z#$%*+,\-.:;=?@[\]^_{|}~]+$/);
    expect(imageBlurhash(jpeg(40, 1), 'image/jpeg')).toMatch(
      /^[0-9A-Za-z#$%*+,\-.:;=?@[\]^_{|}~]+$/,
    );
    const look = stillLook(png(2, 2), 'image/png');
    expect(look.dim).toBe('2x2');
    expect(look.blurhash).toBeTruthy();
  });

  it('returns null for truncated bytes, webp without VP8X, video, and an oversized webp', () => {
    expect(imageDisplaySize(new Uint8Array([0x89, 0x50]), 'image/png')).toBeNull();
    expect(imageDisplaySize(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg')).toBeNull();
    expect(imageDisplaySize(new Uint8Array(10), 'image/webp')).toBeNull();
    expect(imageDisplaySize(new Uint8Array(30), 'image/webp')).toBeNull();
    expect(imageDisplaySize(webp(7, 5, false), 'image/webp')).toBeNull();
    expect(imageDisplaySize(webp(7, 5, true), 'image/webp')).toBe('8x6');
    expect(imageDisplaySize(webp(20000, 1, true), 'image/webp')).toBeNull();
    expect(imageDisplaySize(png(1, 1), 'video/mp4')).toBeNull();
    expect(imageBlurhash(png(1, 1), 'image/webp')).toBeNull();
    expect(imageBlurhash(png(1, 1), 'video/mp4')).toBeNull();
    expect(imageBlurhash(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg')).toBeNull();
    expect(imageBlurhash(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png')).toBeNull();
    expect(stillLook(new Uint8Array([1, 2, 3]), 'image/jpeg')).toEqual({});
  });
});
