import { encode } from 'blurhash';
import { decode as decodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';
import type { Kind1Photo } from '@/lib/nostr/event';

const BLUR_MAX = 32;

/**
 * `WIDTHxHEIGHT` from a still, or `null` when the header is missing.
 * JPEG uses the SOF marker. WebP accepts VP8, VP8L, and VP8X. Video types
 * return `null`.
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
    return jpegSize(bytes);
  }
  if (mime === 'image/webp') {
    return webpSize(bytes);
  }
  return null;
}

/**
 * Width and height of a still from its header only, without decoding
 * pixels: JPEG `SOF`, PNG `IHDR`, WebP `VP8`/`VP8L`/`VP8X`. For a JPEG whose
 * EXIF orientation is 5 to 8 the two are swapped (the displayed size).
 * {@link imageDisplaySize} stays as it is.
 *
 * @param bytes - Stored image bytes.
 * @param mime - Stored still MIME.
 * @returns Header size, or both `null` when the header cannot be read.
 */
export function imageHeaderSize(
  bytes: Uint8Array,
  mime: Kind1Photo['mime'],
): { width: number | null; height: number | null } {
  const dim =
    mime === 'image/png'
      ? pngHeaderSize(bytes)
      : mime === 'image/jpeg'
        ? jpegSize(bytes)
        : mime === 'image/webp'
          ? webpSize(bytes)
          : null;
  if (dim === null) {
    return { width: null, height: null };
  }
  const [width, height] = dim.split('x').map(Number) as [number, number];
  return mime === 'image/jpeg' && jpegExifOrientation(bytes) >= 5
    ? { width: height, height: width }
    : { width, height };
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
        maxResolutionInMP: 64,
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
 * Optional `dim` and `blurhash` for one still. A readable header can set
 * `dim` alone. The object is empty only when neither field is produced.
 * Does not throw.
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

function jpegSize(bytes: Uint8Array): string | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) {
      return null;
    }
    while (i < bytes.length && bytes[i] === 0xff) {
      i += 1;
    }
    const marker = bytes[i];
    if (marker === undefined) {
      return null;
    }
    i += 1;
    if (
      marker === 0x01 ||
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }
    if (i + 1 >= bytes.length) {
      return null;
    }
    const length = (bytes[i]! << 8) | bytes[i + 1]!;
    if (length < 2 || i + length > bytes.length) {
      return null;
    }
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (length < 7) {
        return null;
      }
      const height = (bytes[i + 3]! << 8) | bytes[i + 4]!;
      const width = (bytes[i + 5]! << 8) | bytes[i + 6]!;
      return dimText(width, height);
    }
    i += length;
  }
  return null;
}

function webpSize(bytes: Uint8Array): string | null {
  if (
    bytes.length < 12 ||
    bytes[0] !== 0x52 ||
    bytes[1] !== 0x49 ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 0x46 ||
    bytes[8] !== 0x57 ||
    bytes[9] !== 0x45 ||
    bytes[10] !== 0x42 ||
    bytes[11] !== 0x50
  ) {
    return null;
  }
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const tag = String.fromCharCode(
      bytes[offset]!,
      bytes[offset + 1]!,
      bytes[offset + 2]!,
      bytes[offset + 3]!,
    );
    const size = u32le(bytes, offset + 4);
    const payload = offset + 8;
    if (tag === 'VP8X' && size >= 10 && payload + 10 <= bytes.length) {
      return dimText(
        1 + (bytes[payload + 4]! | (bytes[payload + 5]! << 8) | (bytes[payload + 6]! << 16)),
        1 + (bytes[payload + 7]! | (bytes[payload + 8]! << 8) | (bytes[payload + 9]! << 16)),
      );
    }
    if (tag === 'VP8 ' && size >= 10 && payload + 10 <= bytes.length) {
      return vp8LossySize(bytes, payload);
    }
    if (tag === 'VP8L' && size >= 5 && payload + 5 <= bytes.length) {
      return vp8lSize(bytes, payload);
    }
    const step = 8 + size + (size & 1);
    if (step < 8 || offset + step > bytes.length) {
      return null;
    }
    offset += step;
  }
  return null;
}

function vp8LossySize(bytes: Uint8Array, payload: number): string | null {
  if ((bytes[payload]! & 1) !== 0) {
    return null;
  }
  if (bytes[payload + 3] !== 0x9d || bytes[payload + 4] !== 0x01 || bytes[payload + 5] !== 0x2a) {
    return null;
  }
  const width = (bytes[payload + 6]! | (bytes[payload + 7]! << 8)) & 0x3fff;
  const height = (bytes[payload + 8]! | (bytes[payload + 9]! << 8)) & 0x3fff;
  return dimText(width, height);
}

function vp8lSize(bytes: Uint8Array, payload: number): string | null {
  if (bytes[payload] !== 0x2f) {
    return null;
  }
  const bits = u32le(bytes, payload + 1);
  return dimText((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_IHDR = [0x49, 0x48, 0x44, 0x52];

/** `WIDTHxHEIGHT` from the PNG signature and the `IHDR` chunk, or `null`. */
function pngHeaderSize(bytes: Uint8Array): string | null {
  if (
    bytes.length < 24 ||
    PNG_SIGNATURE.some((value, index) => bytes[index] !== value) ||
    PNG_IHDR.some((value, index) => bytes[12 + index] !== value)
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return dimText(view.getUint32(16), view.getUint32(20));
}

/**
 * EXIF orientation (1–8) of a JPEG whose `SOF` was already found, or `1`
 * when there is no readable orientation in an `APP1` `Exif` segment before
 * the scan.
 */
function jpegExifOrientation(bytes: Uint8Array): number {
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1];
    const size = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (marker === 0xda || size < 2) {
      return 1;
    }
    const end = Math.min(bytes.length, offset + 2 + size);
    if (
      marker === 0xe1 &&
      String.fromCharCode(...bytes.subarray(offset + 4, offset + 10)) === 'Exif\0\0'
    ) {
      return exifOrientation(bytes, offset + 10, end);
    }
    offset += 2 + size;
  }
  return 1;
}

/** Orientation tag `0x0112` of IFD0 in a TIFF block `[tiff, end)`, or `1`. */
function exifOrientation(bytes: Uint8Array, tiff: number, end: number): number {
  const order = String.fromCharCode(bytes[tiff] ?? 0, bytes[tiff + 1] ?? 0);
  if ((order !== 'II' && order !== 'MM') || tiff + 8 > end) {
    return 1;
  }
  const little = order === 'II';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ifd = tiff + view.getUint32(tiff + 4, little);
  const count = ifd + 2 <= end ? view.getUint16(ifd, little) : 0;
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > end) {
      return 1;
    }
    if (view.getUint16(entry, little) === 0x0112) {
      const value = view.getUint16(entry + 8, little);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function dimText(width: number, height: number): string | null {
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
