import { encode } from 'blurhash';
import { decode as decodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';
import type { Kind1Photo } from '@/lib/nostr/event';

const BLUR_MAX = 32;

/**
 * `WIDTHxHEIGHT` from a still, or `null` when the bytes do not decode.
 * WebP uses the VP8X header only. Video types return `null`.
 *
 * @param bytes - Stored image bytes.
 * @param mime - Stored still MIME.
 * @returns Display size for an `imeta` `dim` field, or `null`.
 */
export function imageDisplaySize(bytes: Uint8Array, mime: Kind1Photo['mime']): string | null {
  if (mime === 'image/png') {
    return decodedDim(() => {
      const image = PNG.sync.read(Buffer.from(bytes));
      return { width: image.width, height: image.height };
    });
  }
  if (mime === 'image/jpeg') {
    return decodedDim(() => {
      const image = decodeJpeg(bytes, {
        useTArray: true,
        formatAsRGBA: true,
        maxResolutionInMP: 8,
      });
      return { width: image.width, height: image.height };
    });
  }
  if (mime === 'image/webp') {
    return webpSize(bytes);
  }
  return null;
}

/**
 * BlurHash placeholder for a JPEG or PNG, or `null` when the bytes do not
 * decode. WebP and video return `null`. The sample is at most 32 px on the
 * long side.
 *
 * @param bytes - Stored image bytes.
 * @param mime - Stored still MIME.
 * @returns BlurHash string, or `null`.
 */
export function imageBlurhash(bytes: Uint8Array, mime: Kind1Photo['mime']): string | null {
  try {
    if (mime === 'image/jpeg') {
      const image = decodeJpeg(bytes, {
        useTArray: true,
        formatAsRGBA: true,
        maxResolutionInMP: 8,
      });
      return blurhashFromRgba(image.data, image.width, image.height);
    }
    if (mime === 'image/png') {
      const image = PNG.sync.read(Buffer.from(bytes));
      return blurhashFromRgba(image.data, image.width, image.height);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Optional `dim` and `blurhash` for one still. Empty when the bytes do not
 * decode. Does not throw.
 *
 * @param bytes - Stored image bytes.
 * @param mime - Stored still MIME.
 * @returns Fields to copy onto a `Kind1Photo`.
 */
export function stillLook(
  bytes: Uint8Array,
  mime: Kind1Photo['mime'],
): { dim?: string; blurhash?: string } {
  const out: { dim?: string; blurhash?: string } = {};
  const dim = imageDisplaySize(bytes, mime);
  if (dim !== null) {
    out.dim = dim;
  }
  const blurhash = imageBlurhash(bytes, mime);
  if (blurhash !== null) {
    out.blurhash = blurhash;
  }
  return out;
}

function decodedDim(read: () => { width: number; height: number }): string | null {
  try {
    const size = read();
    return `${size.width}x${size.height}`;
  } catch {
    return null;
  }
}

function webpSize(bytes: Uint8Array): string | null {
  if (bytes.length < 30) {
    return null;
  }
  const riff =
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50;
  const vp8x = bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x58;
  if (!riff || !vp8x) {
    return null;
  }
  const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
  const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
  if (width < 1 || height < 1 || width > 20000 || height > 20000) {
    return null;
  }
  return `${width}x${height}`;
}

function blurhashFromRgba(data: Uint8Array, width: number, height: number): string {
  const step = Math.max(1, Math.ceil(Math.max(width, height) / BLUR_MAX));
  const w = Math.ceil(width / step);
  const h = Math.ceil(height / step);
  const sample = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(width - 1, x * step);
      const sy = Math.min(height - 1, y * step);
      const si = (sy * width + sx) * 4;
      const di = (y * w + x) * 4;
      sample[di] = data[si]!;
      sample[di + 1] = data[si + 1]!;
      sample[di + 2] = data[si + 2]!;
      sample[di + 3] = data[si + 3]!;
    }
  }
  return encode(sample, w, h, 4, 3);
}
