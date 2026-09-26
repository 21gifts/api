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

function riff(tag: string, payload: Uint8Array): Uint8Array {
  const size = payload.length;
  const bytes = new Uint8Array(20 + size + (size & 1));
  bytes.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  bytes[12] = tag.charCodeAt(0);
  bytes[13] = tag.charCodeAt(1);
  bytes[14] = tag.charCodeAt(2);
  bytes[15] = tag.charCodeAt(3);
  bytes[16] = size & 0xff;
  bytes[17] = (size >> 8) & 0xff;
  bytes[18] = (size >> 16) & 0xff;
  bytes[19] = (size >> 24) & 0xff;
  bytes.set(payload, 20);
  return bytes;
}

function vp8x(width: number, height: number): Uint8Array {
  const payload = new Uint8Array(10);
  const w = width - 1;
  const h = height - 1;
  payload[4] = w & 0xff;
  payload[5] = (w >> 8) & 0xff;
  payload[6] = (w >> 16) & 0xff;
  payload[7] = h & 0xff;
  payload[8] = (h >> 8) & 0xff;
  payload[9] = (h >> 16) & 0xff;
  return riff('VP8X', payload);
}

function vp8(width: number, height: number, keyframe = true, start = true): Uint8Array {
  const payload = new Uint8Array(10);
  payload[0] = keyframe ? 0 : 1;
  if (start) {
    payload[3] = 0x9d;
    payload[4] = 0x01;
    payload[5] = 0x2a;
  }
  payload[6] = width & 0xff;
  payload[8] = height & 0xff;
  return riff('VP8 ', payload);
}

function vp8l(width: number, height: number, signature = 0x2f): Uint8Array {
  const bits = (width - 1) | ((height - 1) << 14);
  return riff(
    'VP8L',
    new Uint8Array([
      signature,
      bits & 0xff,
      (bits >> 8) & 0xff,
      (bits >> 16) & 0xff,
      (bits >> 24) & 0xff,
    ]),
  );
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

  it('reads VP8, VP8L, and VP8X, and ignores a truncated or oversized header', () => {
    expect(imageDisplaySize(vp8x(8, 6), 'image/webp')).toBe('8x6');
    expect(imageDisplaySize(vp8(8, 6), 'image/webp')).toBe('8x6');
    expect(imageDisplaySize(vp8l(8, 6), 'image/webp')).toBe('8x6');
    expect(imageBlurhash(vp8x(8, 6), 'image/webp')).toBeNull();
    expect(imageDisplaySize(vp8(8, 6, false), 'image/webp')).toBeNull();
    expect(imageDisplaySize(vp8(8, 6, true, false), 'image/webp')).toBeNull();
    expect(imageDisplaySize(vp8l(8, 6, 0), 'image/webp')).toBeNull();
    expect(imageDisplaySize(vp8x(20001, 6), 'image/webp')).toBeNull();
    expect(imageDisplaySize(vp8x(8, 20001), 'image/webp')).toBeNull();
    expect(imageDisplaySize(riff('VP8X', new Uint8Array(0)), 'image/webp')).toBeNull();
    expect(imageDisplaySize(new Uint8Array(10), 'image/webp')).toBeNull();
    expect(imageDisplaySize(new Uint8Array(30), 'image/webp')).toBeNull();
    const huge = riff('VP8X', new Uint8Array(4));
    huge[16] = 100;
    expect(imageDisplaySize(huge, 'image/webp')).toBeNull();
  });

  it('reads a JPEG size from the SOF marker even when the frame does not decode', () => {
    const sof = new Uint8Array([
      0xff, 0xd8, 0xff, 0x01, 0xff, 0xd8, 0xff, 0xd9, 0xff, 0xd0, 0xff, 0xc0, 0x00, 0x11, 0x08,
      0x00, 0x01, 0x00, 0x01,
    ]);
    expect(imageDisplaySize(sof, 'image/jpeg')).toBe('1x1');
    expect(imageBlurhash(sof, 'image/jpeg')).toBeNull();
    expect(stillLook(sof, 'image/jpeg')).toEqual({ dim: '1x1' });
    const sof1 = new Uint8Array(sof);
    sof1[11] = 0xc1;
    const sof2 = new Uint8Array(sof);
    sof2[11] = 0xc2;
    expect(imageDisplaySize(sof1, 'image/jpeg')).toBe('1x1');
    expect(imageDisplaySize(sof2, 'image/jpeg')).toBe('1x1');
    expect(imageDisplaySize(new Uint8Array([1, 2, 3, 4]), 'image/jpeg')).toBeNull();
    expect(imageDisplaySize(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg')).toBeNull();
    expect(
      imageDisplaySize(
        new Uint8Array([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
        'image/jpeg',
      ),
    ).toBeNull();
    expect(
      imageDisplaySize(
        new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]),
        'image/jpeg',
      ),
    ).toBeNull();
    expect(
      imageDisplaySize(
        new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x00, 0x00, 0x00]),
        'image/jpeg',
      ),
    ).toBeNull();
    expect(
      imageDisplaySize(
        new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
        'image/jpeg',
      ),
    ).toBeNull();
    expect(imageDisplaySize(new Uint8Array([0x89, 0x50]), 'image/png')).toBeNull();
    expect(imageDisplaySize(png(1, 1), 'video/mp4')).toBeNull();
    expect(imageBlurhash(png(1, 1), 'video/mp4')).toBeNull();
    expect(imageBlurhash(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg')).toBeNull();
    expect(imageBlurhash(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png')).toBeNull();
    expect(stillLook(new Uint8Array([1, 2, 3]), 'image/jpeg')).toEqual({});
  });
});
