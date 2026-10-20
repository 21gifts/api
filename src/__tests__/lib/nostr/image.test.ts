import { encode as encodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { imageBlurhash, imageDisplaySize, imageHeaderSize, stillLook } from '@/lib/nostr/image';

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
      0xff, 0xd8, 0xff, 0x01, 0xff, 0xd8, 0xff, 0xd9, 0xff, 0xd0, 0xff, 0xc0, 0x00, 0x08, 0x08,
      0x00, 0x01, 0x00, 0x01, 0x00,
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
    expect(
      imageDisplaySize(
        new Uint8Array([
          0xff, 0xd8, 0xff, 0xff, 0xc0, 0x00, 0x08, 0x08, 0x00, 0x01, 0x00, 0x01, 0x00,
        ]),
        'image/jpeg',
      ),
    ).toBe('1x1');
    expect(
      imageDisplaySize(
        new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x02, 0x08, 0x00, 0x05, 0x00, 0x07]),
        'image/jpeg',
      ),
    ).toBeNull();
    expect(imageDisplaySize(new Uint8Array([0xff, 0xd8, 0xff, 0xff]), 'image/jpeg')).toBeNull();
    expect(imageDisplaySize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg')).toBeNull();
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
        new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x08, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]),
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

function tiffBlock(
  order: 'II' | 'MM',
  entries: Array<[number, number]>,
  ifdOffset = 8,
): Uint8Array {
  const little = order === 'II';
  const bytes = new Uint8Array(ifdOffset + 2 + entries.length * 12 + 4);
  const view = new DataView(bytes.buffer);
  bytes[0] = order.charCodeAt(0);
  bytes[1] = order.charCodeAt(1);
  view.setUint16(2, 42, little);
  view.setUint32(4, ifdOffset, little);
  view.setUint16(ifdOffset, entries.length, little);
  entries.forEach(([tag, value], index) => {
    const entry = ifdOffset + 2 + index * 12;
    view.setUint16(entry, tag, little);
    view.setUint16(entry + 2, 3, little);
    view.setUint32(entry + 4, 1, little);
    view.setUint16(entry + 8, value, little);
  });
  return bytes;
}

function segment(marker: number, payload: Uint8Array): Uint8Array {
  const size = payload.length + 2;
  return new Uint8Array([0xff, marker, size >> 8, size & 0xff, ...payload]);
}

function exifPayload(tiff: Uint8Array): Uint8Array {
  return new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]);
}

function withSegments(image: Uint8Array, ...segments: Uint8Array[]): Uint8Array {
  return new Uint8Array([
    ...image.subarray(0, 2),
    ...segments.flatMap((s) => [...s]),
    ...image.subarray(2),
  ]);
}

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

const NONE = { width: null, height: null };

describe('imageHeaderSize', () => {
  it('reads a PNG IHDR without decoding, also from a header alone', () => {
    expect(imageHeaderSize(pngHeader(320, 200), 'image/png')).toEqual({ width: 320, height: 200 });
    expect(imageHeaderSize(png(3, 2), 'image/png')).toEqual({ width: 3, height: 2 });
    const offset = new Uint8Array(30);
    offset.set(pngHeader(5, 6), 6);
    expect(imageHeaderSize(offset.subarray(6), 'image/png')).toEqual({ width: 5, height: 6 });
  });

  it('answers null for an unreadable PNG header', () => {
    const badSignature = pngHeader(1, 1);
    badSignature[7] = 0;
    const noIhdr = pngHeader(1, 1);
    noIhdr[12] = 0;
    for (const bytes of [
      new Uint8Array(23),
      badSignature,
      noIhdr,
      pngHeader(0, 1),
      pngHeader(30000, 1),
    ]) {
      expect(imageHeaderSize(bytes, 'image/png')).toEqual(NONE);
    }
  });

  it('reads JPEG SOF and WebP headers', () => {
    expect(imageHeaderSize(jpeg(4, 3), 'image/jpeg')).toEqual({ width: 4, height: 3 });
    expect(imageHeaderSize(vp8x(7, 5), 'image/webp')).toEqual({ width: 7, height: 5 });
    expect(imageHeaderSize(vp8l(9, 8), 'image/webp')).toEqual({ width: 9, height: 8 });
    expect(imageHeaderSize(new Uint8Array([1, 2]), 'image/jpeg')).toEqual(NONE);
    expect(imageHeaderSize(new Uint8Array([1, 2]), 'image/webp')).toEqual(NONE);
    expect(imageHeaderSize(jpeg(4, 3), 'video/mp4' as never)).toEqual(NONE);
  });

  it('swaps the axes for a JPEG with EXIF orientation 5 to 8', () => {
    for (const orientation of [5, 6, 7, 8]) {
      for (const order of ['II', 'MM'] as const) {
        const bytes = withSegments(
          jpeg(4, 3),
          segment(
            0xe1,
            exifPayload(
              tiffBlock(order, [
                [0x010f, 1],
                [0x0112, orientation],
              ]),
            ),
          ),
        );
        expect(imageHeaderSize(bytes, 'image/jpeg')).toEqual({ width: 3, height: 4 });
      }
    }
  });

  it('finds the EXIF orientation behind fill bytes and length-less markers', () => {
    const exif = segment(0xe1, exifPayload(tiffBlock('II', [[0x0112, 6]])));
    const filled = new Uint8Array([0xff, 0xff, 0xff, ...exif]);
    const standalone = new Uint8Array([0xff, 0x01, 0xff, 0xd0, 0xff, 0xd7, 0xff, 0xd8]);
    for (const prefix of [filled, standalone]) {
      expect(imageHeaderSize(withSegments(jpeg(4, 3), prefix, exif), 'image/jpeg')).toEqual({
        width: 3,
        height: 4,
      });
    }
    expect(imageHeaderSize(withSegments(jpeg(4, 3), filled), 'image/jpeg')).toEqual({
      width: 3,
      height: 4,
    });
  });

  it('keeps the axes for any other or unreadable orientation', () => {
    const cases: Uint8Array[] = [
      segment(0xe1, exifPayload(tiffBlock('II', [[0x0112, 3]]))),
      segment(0xe1, exifPayload(tiffBlock('II', [[0x0112, 0]]))),
      segment(0xe1, exifPayload(tiffBlock('MM', [[0x0112, 9]]))),
      segment(0xe1, exifPayload(tiffBlock('II', [[0x010f, 6]]))),
      segment(0xe1, exifPayload(tiffBlock('XX' as 'II', [[0x0112, 6]]))),
      segment(0xe1, exifPayload(new Uint8Array([0x49, 0x49, 42, 0]))),
      segment(0xe1, exifPayload(tiffBlock('II', [[0x0112, 6]], 200).subarray(0, 20))),
      segment(0xe1, exifPayload(tiffBlock('II', [[0x0112, 6]]).subarray(0, 16))),
      segment(0xe1, new Uint8Array([0x68, 0x74, 0x74, 0x70, 0x3a, 0x2f, 0x2f, 0x6e])),
      segment(0xe0, exifPayload(tiffBlock('II', [[0x0112, 6]]))),
    ];
    for (const extra of cases) {
      expect(imageHeaderSize(withSegments(jpeg(4, 3), extra), 'image/jpeg')).toEqual({
        width: 4,
        height: 3,
      });
    }
  });

  it('keeps the axes without TIFF magic 42 in the byte order or for a non-SHORT entry', () => {
    const patched = (
      order: 'II' | 'MM',
      patch: (view: DataView, little: boolean) => void,
    ): Uint8Array => {
      const tiff = tiffBlock(order, [[0x0112, 6]]);
      patch(new DataView(tiff.buffer), order === 'II');
      return segment(0xe1, exifPayload(tiff));
    };
    const cases: Uint8Array[] = [];
    for (const order of ['II', 'MM'] as const) {
      // 42 written in the other byte order, and another magic.
      cases.push(patched(order, (view, little) => view.setUint16(2, 42, !little)));
      cases.push(patched(order, (view, little) => view.setUint16(2, 43, little)));
      // Type LONG (4) and type 0 instead of SHORT (3).
      cases.push(patched(order, (view, little) => view.setUint16(10 + 2, 4, little)));
      cases.push(patched(order, (view, little) => view.setUint16(10 + 2, 0, little)));
      // Count 2 and count 0 instead of 1.
      cases.push(patched(order, (view, little) => view.setUint32(10 + 4, 2, little)));
      cases.push(patched(order, (view, little) => view.setUint32(10 + 4, 0, little)));
    }
    for (const extra of cases) {
      expect(imageHeaderSize(withSegments(jpeg(4, 3), extra), 'image/jpeg')).toEqual({
        width: 4,
        height: 3,
      });
    }
  });

  it('stops looking for EXIF at the scan or a broken segment', () => {
    const plain = jpeg(4, 3);
    const app0 = segment(0xe0, new Uint8Array([1, 2, 3]));
    const exif = segment(0xe1, exifPayload(tiffBlock('II', [[0x0112, 6]])));
    expect(imageHeaderSize(withSegments(plain, app0, exif), 'image/jpeg')).toEqual({
      width: 3,
      height: 4,
    });
    const sofIndex = plain.findIndex((byte, index) => byte === 0xff && plain[index + 1] === 0xc0);
    const sof = plain.subarray(sofIndex);
    const scanFirst = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, ...exif, ...sof]);
    expect(imageDisplaySize(scanFirst, 'image/jpeg')).toBe('4x3');
    expect(imageHeaderSize(scanFirst, 'image/jpeg')).toEqual({ width: 4, height: 3 });
    const sofSegment = sof.subarray(0, 2 + ((sof[2]! << 8) | sof[3]!));
    const afterSof = (...tail: number[]): Uint8Array =>
      new Uint8Array([0xff, 0xd8, ...sofSegment, ...tail]);
    for (const bytes of [
      afterSof(),
      afterSof(0xff, 0xe2, 0x00, 0x01),
      afterSof(0x00, 0x00, 0x00, 0x00),
      afterSof(0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0, 0),
    ]) {
      expect(imageHeaderSize(bytes, 'image/jpeg')).toEqual({ width: 4, height: 3 });
    }
    const padded = new Uint8Array([0xff, 0xd8, 0xff, 0xff, ...sof.subarray(1)]);
    expect(imageHeaderSize(padded, 'image/jpeg')).toEqual({ width: 4, height: 3 });
  });
});
