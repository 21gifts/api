import * as fs from 'node:fs/promises';
import { chmod, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  decodeForumVideo,
  detectVideoContentType,
  dropZeroDurationAudioSamples,
  faststartIsoBmff,
  normalizeIsoBmffDisplayMatrix,
  forumVideoExt,
  forumVideoFilePresent,
  forumVideoUrl,
  isoBmffDisplaySize,
  isoBmffDurationSeconds,
  parseBytesRange,
  readForumVideoBytes,
  readVideoTakenAt,
  removeForumVideo,
  resolveMediaDir,
  videoFilePath,
  writeForumVideo,
} from '@/lib/video';

function mvhd(version: number, seconds: number): Uint8Array {
  const payload = version === 1 ? 32 : 20;
  const bytes = new Uint8Array(8 + payload);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length);
  bytes.set([0x6d, 0x76, 0x68, 0x64], 4);
  bytes[8] = version;
  if (version === 1) {
    view.setBigUint64(12, BigInt(seconds));
  } else {
    view.setUint32(12, seconds);
  }
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.byteLength);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(payload, 8);
  return out;
}

/** ISO-BMFF box with 32-bit size field `1` and 64-bit largesize (16-byte header). */
function box64(type: string, payload: Uint8Array): Uint8Array {
  const size = 16 + payload.byteLength;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, 1);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  view.setBigUint64(8, BigInt(size));
  out.set(payload, 16);
  return out;
}

function ftypBox(): Uint8Array {
  const payload = new Uint8Array(16);
  payload.set([0x69, 0x73, 0x6f, 0x6d], 0);
  payload.set([0x69, 0x73, 0x6f, 0x6d], 8);
  return box('ftyp', payload);
}

function stcoBox(offset: number): Uint8Array {
  const payload = new Uint8Array(12);
  const view = new DataView(payload.buffer);
  view.setUint32(4, 1);
  view.setUint32(8, offset);
  return box('stco', payload);
}

function co64Box(offset: bigint): Uint8Array {
  const payload = new Uint8Array(16);
  const view = new DataView(payload.buffer);
  view.setUint32(4, 1);
  view.setBigUint64(8, offset);
  return box('co64', payload);
}

function moovWithStco(chunkOffset: number): Uint8Array {
  return box('moov', box('trak', box('mdia', box('minf', box('stbl', stcoBox(chunkOffset))))));
}

function moovWithCo64(chunkOffset: bigint): Uint8Array {
  return box('moov', box('trak', box('mdia', box('minf', box('stbl', co64Box(chunkOffset))))));
}

function tkhdBox(width: number, height: number, version = 0): Uint8Array {
  const payload = new Uint8Array(version === 1 ? 96 : 84);
  payload[0] = version;
  const view = new DataView(payload.buffer);
  const widthAt = version === 1 ? 88 : 76;
  view.setUint32(widthAt, width << 16);
  view.setUint32(widthAt + 4, height << 16);
  return box('tkhd', payload);
}

function topLevelTypes(bytes: Uint8Array): string[] {
  const types: string[] = [];
  let offset = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset + 8 <= bytes.byteLength) {
    let size = view.getUint32(offset);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > bytes.byteLength) {
        break;
      }
      const large = view.getBigUint64(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) {
        break;
      }
      size = Number(large);
      headerSize = 16;
    }
    if (size < headerSize || offset + size > bytes.byteLength) {
      break;
    }
    types.push(
      String.fromCharCode(
        bytes[offset + 4] as number,
        bytes[offset + 5] as number,
        bytes[offset + 6] as number,
        bytes[offset + 7] as number,
      ),
    );
    offset += size;
  }
  return types;
}

function readStcoOffset(bytes: Uint8Array): number | null {
  const text = Buffer.from(bytes).toString('binary');
  const idx = text.indexOf('stco');
  if (idx < 0) {
    return null;
  }
  const boxStart = idx - 4;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(boxStart + 8 + 8);
}

function mp4Bytes(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  return bytes;
}

function mdatFirstFixture(): Uint8Array {
  const ftyp = ftypBox();
  const media = new Uint8Array([1, 2, 3, 4]);
  const mdat = box('mdat', media);
  const chunkOffset = ftyp.byteLength + 8;
  const moov = moovWithStco(chunkOffset);
  return concat(ftyp, mdat, moov);
}

describe('video', () => {
  it('detects mp4, mov, and webm', () => {
    expect(detectVideoContentType(mp4Bytes())).toBe('video/mp4');
    const mov = mp4Bytes();
    mov.set([0x71, 0x74, 0x20, 0x20], 8);
    expect(detectVideoContentType(mov)).toBe('video/quicktime');
    expect(
      detectVideoContentType(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x77, 0x65, 0x62, 0x6d])),
    ).toBe('video/webm');
    expect(detectVideoContentType(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('rejects non-video ISO-BMFF brands and bare EBML', () => {
    const heic = mp4Bytes();
    heic.set([0x6d, 0x69, 0x66, 0x31], 8);
    expect(detectVideoContentType(heic)).toBeNull();
    const avif = mp4Bytes();
    avif.set([0x61, 0x76, 0x69, 0x66], 8);
    expect(detectVideoContentType(avif)).toBeNull();
    const m4a = mp4Bytes();
    m4a.set([0x4d, 0x34, 0x41, 0x20], 8);
    expect(detectVideoContentType(m4a)).toBeNull();
    expect(detectVideoContentType(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00]))).toBeNull();
  });

  it('rejects empty and oversize video', () => {
    expect(decodeForumVideo(new Uint8Array())).toBeNull();
    const huge = new Uint8Array(32 * 1024 * 1024 + 1);
    huge.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    expect(decodeForumVideo(huge)).toBeNull();
    expect(decodeForumVideo(mp4Bytes())?.contentType).toBe('video/mp4');
  });

  it('reports when a video file is present on disk', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(await forumVideoFilePresent(resolveMediaDir(), id, null)).toBe(false);
    expect(await forumVideoFilePresent(resolveMediaDir(), id, 'video/mp4')).toBe(false);
    await writeForumVideo(id, { contentType: 'video/mp4', bytes: mp4Bytes() });
    try {
      expect(await forumVideoFilePresent(resolveMediaDir(), id, 'video/mp4')).toBe(true);
    } finally {
      await removeForumVideo(id, 'video/mp4');
    }
    const emptyId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const emptyPath = videoFilePath(resolveMediaDir(), emptyId, 'video/mp4');
    await fs.writeFile(emptyPath, new Uint8Array());
    try {
      expect(await forumVideoFilePresent(resolveMediaDir(), emptyId, 'video/mp4')).toBe(false);
    } finally {
      await fs.unlink(emptyPath);
    }
    expect(
      await forumVideoFilePresent(resolveMediaDir(), id, 'video/mp4', async () => ({
        isFile: () => false,
        size: 12,
      })),
    ).toBe(false);
    await expect(
      forumVideoFilePresent(resolveMediaDir(), id, 'video/mp4', async () => {
        throw { code: 'EACCES' };
      }),
    ).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('builds Damus-friendly video URLs', () => {
    expect(forumVideoExt('video/mp4')).toBe('mp4');
    expect(forumVideoExt('video/webm')).toBe('webm');
    expect(forumVideoExt('video/quicktime')).toBe('mov');
    expect(forumVideoUrl('https://api.21.gifts/', 'm1', 'video/mp4')).toBe(
      'https://api.21.gifts/messages/m1/video.mp4',
    );
  });

  it('parses byte ranges', () => {
    expect(parseBytesRange(undefined, 100)).toEqual({ type: 'full' });
    expect(parseBytesRange('bytes=0-9', 100)).toEqual({ type: 'partial', start: 0, end: 9 });
    expect(parseBytesRange('bytes=50-', 100)).toEqual({ type: 'partial', start: 50, end: 99 });
    expect(parseBytesRange('bytes=-10', 100)).toEqual({ type: 'partial', start: 90, end: 99 });
    expect(parseBytesRange('bytes=80-70', 100)).toEqual({ type: 'full' });
    expect(parseBytesRange('bytes=', 100)).toEqual({ type: 'full' });
    expect(parseBytesRange('bytes=-', 100)).toEqual({ type: 'full' });
    expect(parseBytesRange('bytes=-0', 100)).toEqual({ type: 'full' });
    expect(parseBytesRange('bytes=abc-1', 100)).toEqual({ type: 'full' });
    expect(parseBytesRange('bytes=0-9', 0)).toEqual({ type: 'full' });
    expect(parseBytesRange('nope', 100)).toEqual({ type: 'full' });
    expect(parseBytesRange('  ', 100)).toEqual({ type: 'full' });
    expect(parseBytesRange('bytes=100-', 100)).toEqual({ type: 'unsatisfiable' });
    expect(parseBytesRange('bytes=200-300', 100)).toEqual({ type: 'unsatisfiable' });
  });

  it('trims MEDIA_DIR and rejects missing or blank', () => {
    expect(resolveMediaDir({ MEDIA_DIR: ' /data/media ' })).toBe('/data/media');
    expect(() => resolveMediaDir({})).toThrow('MEDIA_DIR must be a non-empty path');
    expect(() => resolveMediaDir({ MEDIA_DIR: '   ' })).toThrow(
      'MEDIA_DIR must be a non-empty path',
    );
  });

  it('moves moov before mdat and patches stco', () => {
    const input = mdatFirstFixture();
    const moov = moovWithStco(ftypBox().byteLength + 8);
    const remuxed = faststartIsoBmff(input);
    expect(remuxed.byteLength).toBe(input.byteLength);
    expect(topLevelTypes(remuxed)).toEqual(['ftyp', 'moov', 'mdat']);
    expect(readStcoOffset(remuxed)).toBe(ftypBox().byteLength + 8 + moov.byteLength);
  });

  it('remuxes when moov has a non-container sibling of stco', () => {
    const ftyp = ftypBox();
    const media = new Uint8Array([9, 8, 7, 6]);
    const mdat = box('mdat', media);
    const chunkOffset = ftyp.byteLength + 8;
    const moov = box('moov', concat(box('mvhd', new Uint8Array(4)), stcoBox(chunkOffset)));
    const input = concat(ftyp, mdat, moov);
    const remuxed = faststartIsoBmff(input);
    expect(topLevelTypes(remuxed)).toEqual(['ftyp', 'moov', 'mdat']);
    expect(readStcoOffset(remuxed)).toBe(chunkOffset + moov.byteLength);
  });

  it('remuxes when a top-level box uses a 64-bit size header', () => {
    const ftypPayload = new Uint8Array(16);
    ftypPayload.set([0x69, 0x73, 0x6f, 0x6d], 0);
    ftypPayload.set([0x69, 0x73, 0x6f, 0x6d], 8);
    const ftyp = box64('ftyp', ftypPayload);
    const media = new Uint8Array([1, 2, 3, 4]);
    const mdat = box('mdat', media);
    const chunkOffset = ftyp.byteLength + 8;
    const moov = moovWithStco(chunkOffset);
    const input = concat(ftyp, mdat, moov);
    const remuxed = faststartIsoBmff(input);
    expect(remuxed.byteLength).toBe(input.byteLength);
    expect(topLevelTypes(remuxed)).toEqual(['ftyp', 'moov', 'mdat']);
    expect(readStcoOffset(remuxed)).toBe(ftyp.byteLength + 8 + moov.byteLength);
  });

  it('is a no-op when moov already precedes mdat', () => {
    const ftyp = ftypBox();
    const moovSize = moovWithStco(0).byteLength;
    const moov = moovWithStco(ftyp.byteLength + moovSize + 8);
    const mdat = box('mdat', new Uint8Array([9, 9]));
    const input = concat(ftyp, moov, mdat);
    const remuxed = faststartIsoBmff(input);
    expect(remuxed).toBe(input);
  });

  it('leaves WebM and random bytes unchanged', () => {
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x77, 0x65, 0x62, 0x6d]);
    expect(faststartIsoBmff(webm)).toBe(webm);
    const random = new Uint8Array([1, 2, 3, 4, 5]);
    expect(faststartIsoBmff(random)).toBe(random);
  });

  it('patches co64 offsets and aborts stco overflow', () => {
    const ftyp = ftypBox();
    const mdat = box('mdat', new Uint8Array([1]));
    const moov = moovWithCo64(BigInt(ftyp.byteLength + 8));
    const input = concat(ftyp, mdat, moov);
    const remuxed = faststartIsoBmff(input);
    expect(topLevelTypes(remuxed)).toEqual(['ftyp', 'moov', 'mdat']);
    const overflowMoov = moovWithStco(0xfffffff0);
    const overflowInput = concat(ftyp, mdat, overflowMoov);
    expect(faststartIsoBmff(overflowInput)).toBe(overflowInput);
  });

  it('skips fragmented files with moof', () => {
    const input = concat(
      ftypBox(),
      box('moof', new Uint8Array(4)),
      box('mdat', new Uint8Array(4)),
      moovWithStco(8),
    );
    expect(faststartIsoBmff(input)).toBe(input);
  });

  it('aborts remux on truncated or oversized chunk-offset tables', () => {
    const ftyp = ftypBox();
    const mdat = box('mdat', new Uint8Array([1]));
    const truncatedStco = box('stco', new Uint8Array(4));
    const truncatedInput = concat(ftyp, mdat, box('moov', truncatedStco));
    expect(faststartIsoBmff(truncatedInput)).toBe(truncatedInput);
    const overCountPayload = new Uint8Array(12);
    const overView = new DataView(overCountPayload.buffer);
    overView.setUint32(4, 2);
    const overCountInput = concat(ftyp, mdat, box('moov', box('stco', overCountPayload)));
    expect(faststartIsoBmff(overCountInput)).toBe(overCountInput);
    const truncatedCo64 = box('co64', new Uint8Array(4));
    const truncatedCo64Input = concat(ftyp, mdat, box('moov', truncatedCo64));
    expect(faststartIsoBmff(truncatedCo64Input)).toBe(truncatedCo64Input);
    const overCo64Payload = new Uint8Array(12);
    const overCo64View = new DataView(overCo64Payload.buffer);
    overCo64View.setUint32(4, 1);
    const overCo64Input = concat(ftyp, mdat, box('moov', box('co64', overCo64Payload)));
    expect(faststartIsoBmff(overCo64Input)).toBe(overCo64Input);
  });

  it('aborts remux on cmov, empty offset tables, bad children, or duplicate boxes', () => {
    const ftyp = ftypBox();
    const mdat = box('mdat', new Uint8Array([1]));
    const cmovInput = concat(ftyp, mdat, box('moov', box('cmov', new Uint8Array(4))));
    expect(faststartIsoBmff(cmovInput)).toBe(cmovInput);
    const emptyMoovInput = concat(ftyp, mdat, box('moov', box('trak', new Uint8Array(0))));
    expect(faststartIsoBmff(emptyMoovInput)).toBe(emptyMoovInput);
    const badChildrenInput = concat(
      ftyp,
      mdat,
      box('moov', box('trak', new Uint8Array([1, 2, 3]))),
    );
    expect(faststartIsoBmff(badChildrenInput)).toBe(badChildrenInput);
    const twoMdat = concat(ftyp, mdat, box('mdat', new Uint8Array([2])), moovWithStco(8));
    expect(faststartIsoBmff(twoMdat)).toBe(twoMdat);
    const twoMoov = concat(ftyp, mdat, moovWithStco(8), moovWithStco(8));
    expect(faststartIsoBmff(twoMoov)).toBe(twoMoov);
  });

  it('handles 64-bit and size-0 box headers without remuxing junk', () => {
    const large = new Uint8Array(24);
    const view = new DataView(large.buffer);
    view.setUint32(0, 1);
    large.set([0x66, 0x72, 0x65, 0x65], 4);
    view.setBigUint64(8, 24n);
    expect(faststartIsoBmff(large)).toBe(large);
    const sizeZero = new Uint8Array(16);
    sizeZero.set([0x6d, 0x64, 0x61, 0x74], 4);
    expect(faststartIsoBmff(sizeZero)).toBe(sizeZero);
    const mdatFirst = mdatFirstFixture();
    const sizeZeroMoov = new Uint8Array(mdatFirst);
    const sizeZeroView = new DataView(sizeZeroMoov.buffer);
    let lastBox = 0;
    let walk = 0;
    while (walk + 8 <= sizeZeroMoov.byteLength) {
      lastBox = walk;
      walk += sizeZeroView.getUint32(walk);
    }
    sizeZeroView.setUint32(lastBox, 0);
    const remuxedZeroMoov = faststartIsoBmff(sizeZeroMoov);
    expect(topLevelTypes(remuxedZeroMoov)).toEqual(['ftyp', 'moov', 'mdat']);
    expect(
      new DataView(remuxedZeroMoov.buffer, remuxedZeroMoov.byteOffset).getUint32(
        ftypBox().byteLength,
      ),
    ).not.toBe(0);
    const truncated = new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70, 1]);
    expect(faststartIsoBmff(truncated)).toBe(truncated);
  });

  it('reads display size from tkhd and returns null without moov', () => {
    const withTkhd = concat(ftypBox(), box('moov', box('trak', tkhdBox(720, 1280))));
    expect(isoBmffDisplaySize(withTkhd)).toEqual({ width: 720, height: 1280 });
    const v1 = concat(ftypBox(), box('moov', box('trak', tkhdBox(640, 360, 1))));
    expect(isoBmffDisplaySize(v1)).toEqual({ width: 640, height: 360 });
    const unknownVersion = concat(ftypBox(), box('moov', box('trak', tkhdBox(720, 1280, 2))));
    expect(isoBmffDisplaySize(unknownVersion)).toBeNull();
    const audioThenVideo = concat(
      ftypBox(),
      box('moov', concat(box('trak', tkhdBox(0, 0)), box('trak', tkhdBox(1280, 720)))),
    );
    expect(isoBmffDisplaySize(audioThenVideo)).toEqual({ width: 1280, height: 720 });
    expect(isoBmffDisplaySize(ftypBox())).toBeNull();
    expect(isoBmffDisplaySize(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(
      isoBmffDisplaySize(concat(ftypBox(), box('moov', box('mvhd', new Uint8Array(4))))),
    ).toBeNull();
    expect(
      isoBmffDisplaySize(concat(ftypBox(), box('moov', new Uint8Array([1, 2, 3, 4])))),
    ).toBeNull();
    expect(
      isoBmffDisplaySize(
        concat(ftypBox(), box('moov', box('trak', box('tkhd', new Uint8Array(0))))),
      ),
    ).toBeNull();
  });

  it('faststarts mdat-first mp4 on decode', () => {
    const decoded = decodeForumVideo(mdatFirstFixture());
    expect(decoded).not.toBeNull();
    if (decoded === null) {
      return;
    }
    expect(decoded.contentType).toBe('video/mp4');
    expect(topLevelTypes(decoded.bytes)).toEqual(['ftyp', 'moov', 'mdat']);
  });

  it('faststarts mdat-first quicktime on decode', () => {
    const mov = mdatFirstFixture();
    mov.set([0x71, 0x74, 0x20, 0x20], 8);
    const decoded = decodeForumVideo(mov);
    expect(decoded?.contentType).toBe('video/quicktime');
    expect(topLevelTypes(decoded?.bytes ?? new Uint8Array())).toEqual(['ftyp', 'moov', 'mdat']);
  });

  it('copies WebM bytes without ISO-BMFF remux on decode', () => {
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x77, 0x65, 0x62, 0x6d]);
    const decoded = decodeForumVideo(webm);
    expect(decoded).not.toBeNull();
    if (decoded === null) {
      return;
    }
    expect(decoded.contentType).toBe('video/webm');
    expect(decoded.bytes).toEqual(webm);
  });

  it('returns null display size for a truncated tkhd', () => {
    const short = concat(ftypBox(), box('moov', box('trak', box('tkhd', new Uint8Array(4)))));
    expect(isoBmffDisplaySize(short)).toBeNull();
  });

  it('returns unchanged bytes for truncated 64-bit headers', () => {
    const shortLarge = new Uint8Array(12);
    const view = new DataView(shortLarge.buffer);
    view.setUint32(0, 1);
    shortLarge.set([0x66, 0x72, 0x65, 0x65], 4);
    expect(faststartIsoBmff(shortLarge)).toBe(shortLarge);
    const hugeLarge = new Uint8Array(16);
    const hugeView = new DataView(hugeLarge.buffer);
    hugeView.setUint32(0, 1);
    hugeLarge.set([0x66, 0x72, 0x65, 0x65], 4);
    hugeView.setBigUint64(8, BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    expect(faststartIsoBmff(hugeLarge)).toBe(hugeLarge);
  });

  it('writes, heals on read, and removes a video file', async () => {
    const video = decodeForumVideo(mp4Bytes());
    expect(video).not.toBeNull();
    if (video === null) {
      return;
    }
    await writeForumVideo('vid-1', video);
    const path = videoFilePath(resolveMediaDir(), 'vid-1', 'video/mp4');
    const loaded = await readForumVideoBytes(path);
    expect(loaded.byteLength).toBe(video.bytes.byteLength);
    const mdatFirst = mdatFirstFixture();
    await writeForumVideo('vid-heal', {
      contentType: 'video/mp4',
      bytes: mdatFirst,
    });
    const healPath = videoFilePath(resolveMediaDir(), 'vid-heal', 'video/mp4');
    const healed = await readForumVideoBytes(healPath);
    expect(topLevelTypes(healed)).toEqual(['ftyp', 'moov', 'mdat']);
    expect(topLevelTypes(new Uint8Array(await readFile(healPath)))).toEqual([
      'ftyp',
      'moov',
      'mdat',
    ]);
    await removeForumVideo('vid-1', 'video/mp4');
    await removeForumVideo('vid-heal', 'video/mp4');
    await removeForumVideo('missing', 'video/mp4');
  });

  it('returns remuxed bytes when heal cannot rewrite a read-only media dir', async () => {
    const messageId = 'vid-heal-ro';
    const mediaDir = resolveMediaDir();
    await writeForumVideo(messageId, {
      contentType: 'video/mp4',
      bytes: mdatFirstFixture(),
    });
    const path = videoFilePath(mediaDir, messageId, 'video/mp4');
    await chmod(mediaDir, 0o555);
    try {
      const remuxed = await readForumVideoBytes(path);
      expect(topLevelTypes(remuxed)).toEqual(['ftyp', 'moov', 'mdat']);
      expect(topLevelTypes(new Uint8Array(await readFile(path)))).toEqual(['ftyp', 'mdat', 'moov']);
    } finally {
      await chmod(mediaDir, 0o755);
      await removeForumVideo(messageId, 'video/mp4');
    }
  });

  it('unlinks the heal temp when rename fails after a successful write', async () => {
    const messageId = 'vid-heal-rename';
    await writeForumVideo(messageId, {
      contentType: 'video/mp4',
      bytes: mdatFirstFixture(),
    });
    const path = videoFilePath(resolveMediaDir(), messageId, 'video/mp4');
    const io = {
      readFile: fs.readFile,
      writeFile: fs.writeFile,
      unlink: fs.unlink,
      rename: async () => {
        throw Object.assign(new Error('rename failed'), { code: 'EIO' });
      },
    };
    try {
      const remuxed = await readForumVideoBytes(path, io);
      expect(topLevelTypes(remuxed)).toEqual(['ftyp', 'moov', 'mdat']);
      expect(topLevelTypes(new Uint8Array(await readFile(path)))).toEqual(['ftyp', 'mdat', 'moov']);
    } finally {
      await removeForumVideo(messageId, 'video/mp4');
    }
  });

  it('faststarts a quicktime file on read', async () => {
    const mov = mdatFirstFixture();
    mov.set([0x71, 0x74, 0x20, 0x20], 8);
    const id = 'vid-mov-read';
    await writeForumVideo(id, { contentType: 'video/quicktime', bytes: mov });
    const path = videoFilePath(resolveMediaDir(), id, 'video/quicktime');
    try {
      const healed = await readForumVideoBytes(path, fs, {});
      expect(topLevelTypes(healed)).toEqual(['ftyp', 'moov', 'mdat']);
    } finally {
      await removeForumVideo(id, 'video/quicktime');
    }
  });

  it('does not rewrite a WebM file on read', async () => {
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x77, 0x65, 0x62, 0x6d, 0x01]);
    const id = 'vid-webm-read';
    await writeForumVideo(id, { contentType: 'video/webm', bytes: webm });
    const path = videoFilePath(resolveMediaDir(), id, 'video/webm');
    let writes = 0;
    const io = {
      readFile: fs.readFile,
      writeFile: async () => {
        writes += 1;
      },
      rename: fs.rename,
      unlink: fs.unlink,
    };
    try {
      const loaded = await readForumVideoBytes(path, io, {});
      expect(loaded).toEqual(webm);
      expect(writes).toBe(0);
      expect(new Uint8Array(await fs.readFile(path))).toEqual(webm);
    } finally {
      await removeForumVideo(id, 'video/webm');
    }
  });
});

describe('readVideoTakenAt', () => {
  const seconds = Math.floor((Date.UTC(2020, 0, 1) - Date.UTC(1904, 0, 1)) / 1000);

  it('reads an mvhd creation time and ignores a missing or zero time', () => {
    expect(readVideoTakenAt(mvhd(0, seconds))).toBe('2020-01-01T00:00:00+00:00');
    expect(readVideoTakenAt(mvhd(1, seconds))).toBe('2020-01-01T00:00:00+00:00');
    expect(readVideoTakenAt(mvhd(0, 0))).toBeNull();
    expect(readVideoTakenAt(mvhd(2, seconds))).toBeNull();
    expect(readVideoTakenAt(new Uint8Array([0, 1, 2, 3]))).toBeNull();
    expect(readVideoTakenAt(mvhd(0, 1))).toBeNull();
  });

  it('ignores a truncated, nested, or out-of-range mvhd', () => {
    expect(readVideoTakenAt(box('moov', mvhd(0, seconds)))).toBe('2020-01-01T00:00:00+00:00');
    expect(readVideoTakenAt(box('moov', box('free', new Uint8Array(4))))).toBeNull();
    const headerOnly = new Uint8Array(8);
    new DataView(headerOnly.buffer).setUint32(0, 8);
    headerOnly.set([0x6d, 0x76, 0x68, 0x64], 4);
    expect(readVideoTakenAt(headerOnly)).toBeNull();
    const short = new Uint8Array(12);
    new DataView(short.buffer).setUint32(0, 12);
    short.set([0x6d, 0x76, 0x68, 0x64], 4);
    expect(readVideoTakenAt(short)).toBeNull();
    short[8] = 1;
    expect(readVideoTakenAt(short)).toBeNull();
    const huge = mvhd(1, 0);
    new DataView(huge.buffer).setBigUint64(12, BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    expect(readVideoTakenAt(huge)).toBeNull();
    const overflow = mvhd(1, 0);
    new DataView(overflow.buffer).setBigUint64(12, 9_000_000_000_000n);
    expect(readVideoTakenAt(overflow)).toBeNull();
    const future = Math.floor((Date.UTC(2030, 0, 1) - Date.UTC(1904, 0, 1)) / 1000);
    expect(readVideoTakenAt(mvhd(0, future))).toBeNull();
    const truncated = new Uint8Array(12);
    new DataView(truncated.buffer).setUint32(0, 100);
    truncated.set([0x66, 0x72, 0x65, 0x65], 4);
    expect(readVideoTakenAt(truncated)).toBeNull();
    const followed = new Uint8Array(32);
    new DataView(followed.buffer).setUint32(0, 12);
    followed.set([0x6d, 0x76, 0x68, 0x64], 4);
    new DataView(followed.buffer).setUint32(12, seconds);
    expect(readVideoTakenAt(followed)).toBeNull();
    followed[8] = 1;
    new DataView(followed.buffer).setBigUint64(12, BigInt(seconds));
    expect(readVideoTakenAt(followed)).toBeNull();
  });
});

describe('isoBmffDurationSeconds', () => {
  function durationMvhd(version: 0 | 1, timescale: number, duration: bigint): Uint8Array {
    const payload = new Uint8Array(version === 1 ? 32 : 20);
    payload[0] = version;
    const view = new DataView(payload.buffer);
    if (version === 1) {
      view.setUint32(20, timescale);
      view.setBigUint64(24, duration);
    } else {
      view.setUint32(12, timescale);
      view.setUint32(16, Number(duration));
    }
    return box('mvhd', payload);
  }

  it('reads rounded seconds from mvhd version 0 and version 1', () => {
    expect(isoBmffDurationSeconds(box('moov', durationMvhd(0, 1000, 2000n)))).toBe(2);
    expect(isoBmffDurationSeconds(durationMvhd(0, 1000, 2500n))).toBe(3);
    expect(isoBmffDurationSeconds(durationMvhd(0, 1, 1n))).toBe(1);
    expect(isoBmffDurationSeconds(durationMvhd(1, 1, 86400n))).toBe(86400);
  });

  it('returns null when mvhd is missing, truncated, or out of range', () => {
    expect(isoBmffDurationSeconds(new Uint8Array())).toBeNull();
    expect(isoBmffDurationSeconds(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toBeNull();
    const headerOnly = new Uint8Array(8);
    new DataView(headerOnly.buffer).setUint32(0, 8);
    headerOnly.set([0x6d, 0x76, 0x68, 0x64], 4);
    expect(isoBmffDurationSeconds(headerOnly)).toBeNull();
    expect(isoBmffDurationSeconds(box('mvhd', new Uint8Array(4)))).toBeNull();
    const shortV1 = new Uint8Array(24);
    shortV1[0] = 1;
    expect(isoBmffDurationSeconds(box('mvhd', shortV1))).toBeNull();
    const unknown = new Uint8Array(20);
    unknown[0] = 2;
    expect(isoBmffDurationSeconds(box('mvhd', unknown))).toBeNull();
    expect(isoBmffDurationSeconds(durationMvhd(0, 0, 10n))).toBeNull();
    expect(isoBmffDurationSeconds(durationMvhd(0, 1000, 0n))).toBeNull();
    expect(isoBmffDurationSeconds(durationMvhd(0, 1000, 400n))).toBeNull();
    expect(isoBmffDurationSeconds(durationMvhd(0, 1, 86401n))).toBeNull();
    expect(
      isoBmffDurationSeconds(durationMvhd(1, 1, BigInt(Number.MAX_SAFE_INTEGER) + 1n)),
    ).toBeNull();
  });
});

const MATRIX_W = 0x40000000;
const MATRIX_ONE = 65536;

function hdlrBox(kind: string): Uint8Array {
  const payload = new Uint8Array(Math.max(12, kind.length === 4 ? 12 : 4));
  if (kind.length === 4) {
    payload[8] = kind.charCodeAt(0);
    payload[9] = kind.charCodeAt(1);
    payload[10] = kind.charCodeAt(2);
    payload[11] = kind.charCodeAt(3);
  }
  return box('hdlr', payload);
}

function avc1Box(width: number, height: number): Uint8Array {
  const payload = new Uint8Array(28);
  const view = new DataView(payload.buffer);
  view.setUint16(24, width);
  view.setUint16(26, height);
  return box('avc1', payload);
}

function stsdBox(entry: Uint8Array): Uint8Array {
  const payload = new Uint8Array(8 + entry.byteLength);
  new DataView(payload.buffer).setUint32(4, 1);
  payload.set(entry, 8);
  return box('stsd', payload);
}

function matrixTkhd(version: number, width: number, height: number, matrix: number[]): Uint8Array {
  const payload = new Uint8Array(version === 1 ? 96 : version === 0 ? 84 : 84);
  payload[0] = version;
  const view = new DataView(payload.buffer);
  const matrixAt = version === 1 ? 52 : 40;
  const widthAt = version === 1 ? 88 : 76;
  for (let i = 0; i < 9; i += 1) {
    view.setInt32(matrixAt + i * 4, matrix[i] ?? 0);
  }
  view.setUint32(widthAt, width * MATRIX_ONE);
  view.setUint32(widthAt + 4, height * MATRIX_ONE);
  return box('tkhd', payload);
}

function rotationMatrix(
  kind: 90 | 180 | 270,
  tx = 0,
  ty = 0,
  u = 0,
  v = 0,
  w = MATRIX_W,
): number[] {
  const a = kind === 180 ? -MATRIX_ONE : 0;
  const b = kind === 90 ? MATRIX_ONE : kind === 270 ? -MATRIX_ONE : 0;
  const c = kind === 90 ? -MATRIX_ONE : kind === 270 ? MATRIX_ONE : 0;
  const d = kind === 180 ? -MATRIX_ONE : 0;
  return [a, b, u, c, d, v, tx * MATRIX_ONE, ty * MATRIX_ONE, w];
}

function portraitTrak(options: {
  version?: number;
  kind?: 90 | 180 | 270;
  tkhdWidth?: number;
  tkhdHeight?: number;
  tx?: number;
  ty?: number;
  u?: number;
  v?: number;
  w?: number;
  handler?: string;
  entry?: Uint8Array | null;
  extraTkhd?: boolean;
}): Uint8Array {
  const version = options.version ?? 0;
  const kind = options.kind ?? 90;
  const tkhd = matrixTkhd(
    version,
    options.tkhdWidth ?? 1024,
    options.tkhdHeight ?? 576,
    rotationMatrix(
      kind,
      options.tx ?? 0,
      options.ty ?? 0,
      options.u ?? 0,
      options.v ?? 0,
      options.w,
    ),
  );
  const handler = hdlrBox(options.handler ?? 'vide');
  const entry = options.entry === undefined ? avc1Box(1024, 576) : options.entry;
  const parts = [tkhd];
  if (options.extraTkhd === true) {
    parts.push(tkhd);
  }
  const mdia: Uint8Array[] = [handler];
  if (entry !== null) {
    mdia.push(box('minf', box('stbl', stsdBox(entry))));
  }
  parts.push(box('mdia', concat(...mdia)));
  return box('trak', concat(...parts));
}

function matrixFile(trak: Uint8Array, media = new Uint8Array([9, 8, 7, 6])): Uint8Array {
  return concat(ftypBox(), box('moov', trak), box('mdat', media));
}

function tkhdView(
  bytes: Uint8Array,
  version = 0,
): { tx: number; ty: number; width: number; height: number } {
  const text = Buffer.from(bytes).toString('binary');
  const idx = text.indexOf('tkhd');
  const body = idx + 4;
  const matrixAt = body + (version === 1 ? 52 : 40);
  const widthAt = body + (version === 1 ? 88 : 76);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    tx: view.getInt32(matrixAt + 24),
    ty: view.getInt32(matrixAt + 28),
    width: view.getUint32(widthAt),
    height: view.getUint32(widthAt + 4),
  };
}

describe('normalizeIsoBmffDisplayMatrix', () => {
  it('moves a broken 90 degree picture back into the frame', () => {
    const media = new Uint8Array([9, 8, 7, 6]);
    const input = matrixFile(portraitTrak({ extraTkhd: true }), media);
    const before = new Uint8Array(input);
    const out = normalizeIsoBmffDisplayMatrix(input);
    expect(out).not.toBe(input);
    expect(input).toEqual(before);
    const fields = tkhdView(out);
    expect(fields.tx).toBe(576 * MATRIX_ONE);
    expect(fields.ty).toBe(0);
    expect(fields.width).toBe(576 * MATRIX_ONE);
    expect(fields.height).toBe(1024 * MATRIX_ONE);
    const payload = Buffer.from(out).toString('binary');
    const mdat = payload.indexOf('mdat');
    expect(out.subarray(mdat + 4, mdat + 8)).toEqual(media);
  });

  it('keeps an already corrected 90 degree matrix', () => {
    const input = matrixFile(portraitTrak({ tkhdWidth: 576, tkhdHeight: 1024, tx: 576, ty: 0 }));
    expect(normalizeIsoBmffDisplayMatrix(input)).toBe(input);
  });

  it('corrects 270 and 180 degree matrices', () => {
    const turned = normalizeIsoBmffDisplayMatrix(matrixFile(portraitTrak({ kind: 270 })));
    expect(tkhdView(turned)).toEqual({
      tx: 0,
      ty: 1024 * MATRIX_ONE,
      width: 576 * MATRIX_ONE,
      height: 1024 * MATRIX_ONE,
    });
    const flipped = normalizeIsoBmffDisplayMatrix(matrixFile(portraitTrak({ kind: 180 })));
    expect(tkhdView(flipped)).toEqual({
      tx: 1024 * MATRIX_ONE,
      ty: 576 * MATRIX_ONE,
      width: 1024 * MATRIX_ONE,
      height: 576 * MATRIX_ONE,
    });
  });

  it('corrects a version 1 tkhd', () => {
    const out = normalizeIsoBmffDisplayMatrix(matrixFile(portraitTrak({ version: 1 })));
    expect(tkhdView(out, 1).tx).toBe(576 * MATRIX_ONE);
    expect(tkhdView(out, 1).width).toBe(576 * MATRIX_ONE);
    expect(tkhdView(out, 1).height).toBe(1024 * MATRIX_ONE);
  });

  it('uses the tkhd size as the coded size when the sample entry is absent', () => {
    const out = normalizeIsoBmffDisplayMatrix(matrixFile(portraitTrak({ entry: null })));
    expect(tkhdView(out).tx).toBe(576 * MATRIX_ONE);
    expect(tkhdView(out).width).toBe(576 * MATRIX_ONE);
    expect(tkhdView(out).height).toBe(1024 * MATRIX_ONE);
  });

  it('leaves identity, zero, audio, shear, and a bad w component untouched', () => {
    const identityMatrix = matrixTkhd(0, 1024, 576, [
      MATRIX_ONE,
      0,
      0,
      0,
      MATRIX_ONE,
      0,
      0,
      0,
      MATRIX_W,
    ]);
    const identityFile = matrixFile(
      box('trak', concat(identityMatrix, box('mdia', hdlrBox('vide')))),
    );
    expect(normalizeIsoBmffDisplayMatrix(identityFile)).toBe(identityFile);
    const zero = matrixFile(box('trak', concat(tkhdBox(1024, 576), box('mdia', hdlrBox('vide')))));
    expect(normalizeIsoBmffDisplayMatrix(zero)).toBe(zero);
    const audio = matrixFile(portraitTrak({ handler: 'soun' }));
    expect(normalizeIsoBmffDisplayMatrix(audio)).toBe(audio);
    const sheared = matrixFile(portraitTrak({ u: 1 }));
    expect(normalizeIsoBmffDisplayMatrix(sheared)).toBe(sheared);
    const vShear = matrixFile(portraitTrak({ v: 1 }));
    expect(normalizeIsoBmffDisplayMatrix(vShear)).toBe(vShear);
    const badW = matrixFile(portraitTrak({ w: 0 }));
    expect(normalizeIsoBmffDisplayMatrix(badW)).toBe(badW);
  });

  it('skips a zero coded width, a short sample entry, and an unknown tkhd version', () => {
    const zeroWidth = matrixFile(portraitTrak({ entry: avc1Box(0, 576) }));
    expect(normalizeIsoBmffDisplayMatrix(zeroWidth)).toBe(zeroWidth);
    const zeroHeight = matrixFile(portraitTrak({ entry: avc1Box(1024, 0) }));
    expect(normalizeIsoBmffDisplayMatrix(zeroHeight)).toBe(zeroHeight);
    const shortEntry = matrixFile(portraitTrak({ entry: box('avc1', new Uint8Array(4)) }));
    expect(normalizeIsoBmffDisplayMatrix(shortEntry)).not.toBe(shortEntry);
    const version2 = matrixTkhd(2, 1024, 576, rotationMatrix(90));
    const unknown = matrixFile(box('trak', concat(version2, box('mdia', hdlrBox('vide')))));
    expect(normalizeIsoBmffDisplayMatrix(unknown)).toBe(unknown);
    const shortTkhd = box('tkhd', new Uint8Array([0, 0, 0, 0]));
    const shortTrack = matrixFile(box('trak', concat(shortTkhd, box('mdia', hdlrBox('vide')))));
    expect(normalizeIsoBmffDisplayMatrix(shortTrack)).toBe(shortTrack);
  });

  it('returns the same reference for truncated bytes and a trak that will not parse', () => {
    const junk = new Uint8Array([1, 2, 3]);
    expect(normalizeIsoBmffDisplayMatrix(junk)).toBe(junk);
    const broken = concat(ftypBox(), box('moov', new Uint8Array([0, 0, 0, 1])));
    expect(normalizeIsoBmffDisplayMatrix(broken)).toBe(broken);
    const shortHandler = matrixFile(
      box(
        'trak',
        concat(
          matrixTkhd(0, 1024, 576, rotationMatrix(90)),
          box('mdia', box('hdlr', new Uint8Array(4))),
        ),
      ),
    );
    expect(normalizeIsoBmffDisplayMatrix(shortHandler)).toBe(shortHandler);
    const movieHeader = concat(ftypBox(), box('moov', box('mvhd', new Uint8Array(20))));
    expect(normalizeIsoBmffDisplayMatrix(movieHeader)).toBe(movieHeader);
    const brokenTrak = concat(ftypBox(), box('moov', box('trak', new Uint8Array([0, 0, 0, 1]))));
    expect(normalizeIsoBmffDisplayMatrix(brokenTrak)).toBe(brokenTrak);
    expect(decodeForumVideo(new Uint8Array(16))).toBeNull();
    const tinyStsd = matrixFile(
      box(
        'trak',
        concat(
          matrixTkhd(0, 1024, 576, rotationMatrix(90)),
          box(
            'mdia',
            concat(hdlrBox('vide'), box('minf', box('stbl', box('stsd', new Uint8Array())))),
          ),
        ),
      ),
    );
    expect(normalizeIsoBmffDisplayMatrix(tinyStsd)).toBe(tinyStsd);
  });

  it('stores a corrected matrix from decodeForumVideo', () => {
    const input = matrixFile(portraitTrak({}));
    const decoded = decodeForumVideo(input);
    expect(decoded).not.toBeNull();
    if (decoded === null) {
      return;
    }
    expect(tkhdView(decoded.bytes).width).toBe(576 * MATRIX_ONE);
    expect(tkhdView(decoded.bytes).tx).toBe(576 * MATRIX_ONE);
  });

  it('rewrites a broken matrix when the file is read', async () => {
    const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const input = matrixFile(portraitTrak({}));
    await writeForumVideo(id, { contentType: 'video/mp4', bytes: input });
    const path = videoFilePath(resolveMediaDir(), id, 'video/mp4');
    try {
      const loaded = await readForumVideoBytes(path, fs, {});
      expect(tkhdView(loaded).tx).toBe(576 * MATRIX_ONE);
      expect(tkhdView(new Uint8Array(await readFile(path))).tx).toBe(576 * MATRIX_ONE);
      const again = await readForumVideoBytes(path, fs, {});
      expect(tkhdView(again).tx).toBe(576 * MATRIX_ONE);
      expect(tkhdView(again).width).toBe(576 * MATRIX_ONE);
    } finally {
      await removeForumVideo(id, 'video/mp4');
    }
  });

  it('derives the coded size from a translated tkhd when no sample entry exists', () => {
    const already = matrixFile(
      portraitTrak({ entry: null, tkhdWidth: 576, tkhdHeight: 1024, tx: 576, ty: 0 }),
    );
    expect(normalizeIsoBmffDisplayMatrix(already)).toBe(already);
    const flat = matrixFile(
      portraitTrak({ entry: null, kind: 180, tkhdWidth: 0, tkhdHeight: 0, tx: 1, ty: 0 }),
    );
    expect(normalizeIsoBmffDisplayMatrix(flat)).toBe(flat);
    const missing = matrixFile(
      portraitTrak({ entry: null, tkhdWidth: 0, tkhdHeight: 0, tx: 0, ty: 0 }),
    );
    expect(normalizeIsoBmffDisplayMatrix(missing)).toBe(missing);
  });

  it('leaves a translation that does not fit in a signed 32-bit field', () => {
    const input = matrixFile(portraitTrak({ entry: avc1Box(1024, 40000) }));
    expect(normalizeIsoBmffDisplayMatrix(input)).toBe(input);
  });

  it('purges the site and api cache after rewriting a broken video', async () => {
    const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const input = matrixFile(portraitTrak({}));
    await writeForumVideo(id, { contentType: 'video/mp4', bytes: input });
    const path = videoFilePath(resolveMediaDir(), id, 'video/mp4');
    const calls: string[] = [];
    const fetchImpl = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push(String(init?.body ?? ''));
      return { status: 200, json: async () => ({ success: true }) } as Response;
    };
    const env = {
      PUBLIC_BASE_URL: 'https://21.gifts',
      CLOUDFLARE_ZONE_ID: 'zone',
      CLOUDFLARE_API_TOKEN: 'token',
    };
    try {
      const loaded = await readForumVideoBytes(path, fs, env, fetchImpl);
      expect(tkhdView(loaded).width).toBe(576 * MATRIX_ONE);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain(`https://api.21.gifts/messages/${id}/video.mp4`);
      expect(calls[0]).toContain(`https://21.gifts/messages/${id}/video.mp4`);
      await readForumVideoBytes(path, fs, env, fetchImpl);
      expect(calls).toHaveLength(1);
    } finally {
      await removeForumVideo(id, 'video/mp4');
    }
  });

  it('still returns corrected bytes when the cache purge fails', async () => {
    const id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    await writeForumVideo(id, { contentType: 'video/mp4', bytes: matrixFile(portraitTrak({})) });
    const path = videoFilePath(resolveMediaDir(), id, 'video/mp4');
    const warnings: string[] = [];
    const previous = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    const fetchImpl = async (): Promise<Response> =>
      ({ status: 500, json: async () => ({ success: false }) }) as Response;
    try {
      const loaded = await readForumVideoBytes(
        path,
        fs,
        {
          PUBLIC_BASE_URL: 'https://api.example.test',
          CLOUDFLARE_ZONE_ID: 'zone',
          CLOUDFLARE_API_TOKEN: 'token',
        },
        fetchImpl,
      );
      expect(tkhdView(loaded).tx).toBe(576 * MATRIX_ONE);
      expect(warnings.some((line) => line.includes('messages.video.purge_failed'))).toBe(true);
    } finally {
      console.warn = previous;
      await removeForumVideo(id, 'video/mp4');
    }
  });

  it('does not purge when credentials or a public video name are missing', async () => {
    const id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const input = matrixFile(portraitTrak({}));
    await writeForumVideo(id, { contentType: 'video/mp4', bytes: input });
    const path = videoFilePath(resolveMediaDir(), id, 'video/mp4');
    let calls = 0;
    const fetchImpl = async (): Promise<Response> => {
      calls += 1;
      return { status: 200, json: async () => ({ success: true }) } as Response;
    };
    const bare = path.slice(0, -4);
    const odd = `${path.slice(0, -4)}.bin`;
    await fs.writeFile(bare, input);
    await fs.writeFile(odd, input);
    try {
      await readForumVideoBytes(path, fs, {}, fetchImpl);
      await readForumVideoBytes(
        bare,
        fs,
        {
          PUBLIC_BASE_URL: 'https://21.gifts',
          CLOUDFLARE_ZONE_ID: 'zone',
          CLOUDFLARE_API_TOKEN: 'token',
        },
        fetchImpl,
      );
      await readForumVideoBytes(
        odd,
        fs,
        {
          PUBLIC_BASE_URL: 'https://21.gifts',
          CLOUDFLARE_ZONE_ID: 'zone',
          CLOUDFLARE_API_TOKEN: 'token',
        },
        fetchImpl,
      );
      expect(calls).toBe(0);
    } finally {
      await removeForumVideo(id, 'video/mp4');
      await fs.unlink(bare).catch(() => undefined);
      await fs.unlink(odd).catch(() => undefined);
    }
  });
});

function sttsRuns(runs: [number, number][]): Uint8Array {
  const payload = new Uint8Array(8 + runs.length * 8);
  const view = new DataView(payload.buffer);
  view.setUint32(4, runs.length);
  runs.forEach(([count, delta], index) => {
    view.setUint32(8 + index * 8, count);
    view.setUint32(12 + index * 8, delta);
  });
  return box('stts', payload);
}

function stszValues(sizes: number[], constant = false): Uint8Array {
  const payload = new Uint8Array(constant ? 12 : 12 + sizes.length * 4);
  const view = new DataView(payload.buffer);
  view.setUint32(4, constant ? (sizes[0] ?? 0) : 0);
  view.setUint32(8, sizes.length);
  if (!constant) {
    sizes.forEach((size, index) => {
      view.setUint32(12 + index * 4, size);
    });
  }
  return box('stsz', payload);
}

function stscRuns(entries: [number, number, number][]): Uint8Array {
  const payload = new Uint8Array(8 + entries.length * 12);
  const view = new DataView(payload.buffer);
  view.setUint32(4, entries.length);
  entries.forEach(([first, samples, desc], index) => {
    const at = 8 + index * 12;
    view.setUint32(at, first);
    view.setUint32(at + 4, samples);
    view.setUint32(at + 8, desc);
  });
  return box('stsc', payload);
}

function stcoValues(offsets: number[]): Uint8Array {
  const payload = new Uint8Array(8 + offsets.length * 4);
  const view = new DataView(payload.buffer);
  view.setUint32(4, offsets.length);
  offsets.forEach((offset, index) => {
    view.setUint32(8 + index * 4, offset);
  });
  return box('stco', payload);
}

function co64Values(offsets: bigint[]): Uint8Array {
  const payload = new Uint8Array(8 + offsets.length * 8);
  const view = new DataView(payload.buffer);
  view.setUint32(4, offsets.length);
  offsets.forEach((offset, index) => {
    view.setBigUint64(8 + index * 8, offset);
  });
  return box('co64', payload);
}

function soundTrak(tables: Uint8Array): Uint8Array {
  return box('trak', box('mdia', concat(hdlrBox('soun'), box('minf', box('stbl', tables)))));
}

function videoTrak(offset: number): Uint8Array {
  return box(
    'trak',
    box('mdia', concat(hdlrBox('vide'), box('minf', box('stbl', stcoBox(offset))))),
  );
}

/** ftyp + moov + mdat, with every stco aimed at the media payload. */
function movieWith(inner: Uint8Array, media: Uint8Array): Uint8Array {
  const moov = box('moov', inner);
  const file = concat(ftypBox(), moov, box('mdat', media));
  const payloadAt = ftypBox().byteLength + moov.byteLength + 8;
  const view = new DataView(file.buffer);
  const walk = (start: number, end: number): void => {
    let offset = start;
    while (offset + 8 <= end) {
      const size = view.getUint32(offset);
      if (size < 8 || offset + size > end) {
        return;
      }
      const type = String.fromCharCode(
        file[offset + 4] ?? 0,
        file[offset + 5] ?? 0,
        file[offset + 6] ?? 0,
        file[offset + 7] ?? 0,
      );
      if (type === 'stco') {
        const count = view.getUint32(offset + 12);
        for (let index = 0; index < count; index += 1) {
          view.setUint32(offset + 16 + index * 4, payloadAt);
        }
      }
      if (
        type === 'moov' ||
        type === 'trak' ||
        type === 'mdia' ||
        type === 'minf' ||
        type === 'stbl'
      ) {
        walk(offset + 8, offset + size);
      }
      offset += size;
    }
  };
  walk(0, file.byteLength);
  return file;
}

function stcoBoxesIn(bytes: Uint8Array): number[] {
  const starts: number[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const walk = (start: number, end: number): void => {
    let offset = start;
    while (offset + 8 <= end) {
      const size = view.getUint32(offset);
      if (size < 8 || offset + size > end) {
        return;
      }
      const type = String.fromCharCode(
        bytes[offset + 4] ?? 0,
        bytes[offset + 5] ?? 0,
        bytes[offset + 6] ?? 0,
        bytes[offset + 7] ?? 0,
      );
      if (type === 'stco' || type === 'co64') {
        starts.push(offset);
      }
      if (
        type === 'moov' ||
        type === 'trak' ||
        type === 'mdia' ||
        type === 'minf' ||
        type === 'stbl'
      ) {
        walk(offset + 8, offset + size);
      }
      offset += size;
    }
  };
  walk(0, bytes.byteLength);
  return starts;
}

function firstBytes(bytes: Uint8Array, type: string): { payload: number; end: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const walk = (start: number, end: number): { payload: number; end: number } | null => {
    let offset = start;
    while (offset + 8 <= end) {
      const size = view.getUint32(offset);
      if (size < 8 || offset + size > end) {
        return null;
      }
      const found = String.fromCharCode(
        bytes[offset + 4] ?? 0,
        bytes[offset + 5] ?? 0,
        bytes[offset + 6] ?? 0,
        bytes[offset + 7] ?? 0,
      );
      if (found === type) {
        return { payload: offset + 8, end: offset + size };
      }
      if (
        found === 'moov' ||
        found === 'trak' ||
        found === 'mdia' ||
        found === 'minf' ||
        found === 'stbl'
      ) {
        const nested = walk(offset + 8, offset + size);
        if (nested !== null) {
          return nested;
        }
      }
      offset += size;
    }
    return null;
  };
  return walk(0, bytes.byteLength);
}

describe('dropZeroDurationAudioSamples', () => {
  it('drops a leading zero-duration audio sample and keeps the picture byte', () => {
    const media = Uint8Array.of(0x11, 0x90, 0xaa, 0xbb, 0xcc, 0xdd);
    const input = movieWith(
      concat(
        videoTrak(0),
        soundTrak(
          concat(
            sttsRuns([
              [1, 0],
              [1, 1024],
            ]),
            stscRuns([[1, 2, 1]]),
            stszValues([2, 4]),
            stcoValues([0]),
          ),
        ),
      ),
      media,
    );
    const healed = dropZeroDurationAudioSamples(input);
    expect(healed).not.toBe(input);
    const audio = firstBytes(healed, 'stsz');
    expect(audio).not.toBeNull();
    const view = new DataView(healed.buffer, healed.byteOffset, healed.byteLength);
    if (audio === null) {
      return;
    }
    expect(view.getUint32(audio.payload + 4)).toBe(4);
    expect(view.getUint32(audio.payload + 8)).toBe(1);
    const boxes = stcoBoxesIn(healed);
    expect(boxes).toHaveLength(2);
    const videoOffset = view.getUint32((boxes[0] ?? 0) + 16);
    const audioOffset = view.getUint32((boxes[1] ?? 0) + 16);
    expect(healed[videoOffset]).toBe(0x11);
    expect(healed[audioOffset]).toBe(0xaa);
    expect(healed[audioOffset + 3]).toBe(0xdd);
  });

  it('returns the same reference when the audio timing is already usable', () => {
    const input = movieWith(
      soundTrak(
        concat(sttsRuns([[1, 1024]]), stscRuns([[1, 1, 1]]), stszValues([4]), stcoValues([0])),
      ),
      Uint8Array.of(1, 2, 3, 4),
    );
    expect(dropZeroDurationAudioSamples(input)).toBe(input);
    const truncated = new Uint8Array([0, 0, 0, 3]);
    expect(dropZeroDurationAudioSamples(truncated)).toBe(truncated);
  });

  it('does not rewrite a zero-duration sample on a video track', () => {
    const input = movieWith(
      box(
        'trak',
        box(
          'mdia',
          concat(
            hdlrBox('vide'),
            box(
              'minf',
              box(
                'stbl',
                concat(sttsRuns([[1, 0]]), stscRuns([[1, 1, 1]]), stszValues([4]), stcoValues([0])),
              ),
            ),
          ),
        ),
      ),
      Uint8Array.of(1, 2, 3, 4),
    );
    expect(dropZeroDurationAudioSamples(input)).toBe(input);
  });

  it('leaves a chunk hole, a blocked table, and a negative offset untouched', () => {
    const hole = movieWith(
      soundTrak(
        concat(
          sttsRuns([
            [1, 1024],
            [1, 0],
            [1, 1024],
          ]),
          stscRuns([[1, 3, 1]]),
          stszValues([4, 2, 4]),
          stcoValues([0]),
        ),
      ),
      Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10),
    );
    const blocked = movieWith(
      soundTrak(
        concat(
          sttsRuns([
            [1, 0],
            [1, 1024],
          ]),
          box('ctts', new Uint8Array(8)),
          stscRuns([[1, 2, 1]]),
          stszValues([2, 4]),
          stcoValues([0]),
        ),
      ),
      Uint8Array.of(1, 2, 3, 4, 5, 6),
    );
    const negative = movieWith(
      soundTrak(
        concat(
          sttsRuns([
            [1, 1024],
            [1, 0],
          ]),
          stscRuns([[1, 2, 1]]),
          stszValues([4, 2]),
          stcoValues([0]),
        ),
      ),
      Uint8Array.of(1, 2, 3, 4, 5, 6),
    );
    const view = new DataView(negative.buffer);
    const stcoAt = Buffer.from(negative).indexOf('stco') - 4;
    view.setUint32(stcoAt + 16, 0);
    expect(dropZeroDurationAudioSamples(hole)).toBe(hole);
    expect(dropZeroDurationAudioSamples(blocked)).toBe(blocked);
    expect(dropZeroDurationAudioSamples(negative)).toBe(negative);
  });

  it('drops a chunk that contains only the bad sample', () => {
    const media = Uint8Array.of(0x11, 0x90, 0xaa, 0xbb, 0xcc, 0xdd);
    const input = movieWith(
      soundTrak(
        concat(
          sttsRuns([
            [1, 0],
            [1, 1024],
          ]),
          stscRuns([
            [1, 1, 1],
            [2, 1, 1],
          ]),
          stszValues([2, 4]),
          stcoValues([0, 0]),
        ),
      ),
      media,
    );
    const source = new DataView(input.buffer);
    const sourceStco = stcoBoxesIn(input)[0] ?? 0;
    const origin = source.getUint32(sourceStco + 16);
    source.setUint32(sourceStco + 20, origin + 2);
    const healed = dropZeroDurationAudioSamples(input);
    const view = new DataView(healed.buffer, healed.byteOffset, healed.byteLength);
    const stco = stcoBoxesIn(healed)[0] ?? 0;
    expect(view.getUint32(stco + 12)).toBe(1);
    expect(healed[view.getUint32(stco + 16)]).toBe(0xaa);
  });

  it('leaves media ahead of moov and an offset that does not fit in 64 bits', () => {
    const media = Uint8Array.of(0x11, 0x90, 0xaa, 0xbb, 0xcc, 0xdd);
    const ftyp = ftypBox();
    const ahead = concat(
      ftyp,
      box('mdat', media),
      box(
        'moov',
        soundTrak(
          concat(
            sttsRuns([
              [1, 0],
              [1, 1024],
            ]),
            stscRuns([[1, 2, 1]]),
            stszValues([2, 4]),
            stcoValues([ftyp.byteLength + 8]),
          ),
        ),
      ),
    );
    expect(dropZeroDurationAudioSamples(ahead)).toBe(ahead);

    const inside = movieWith(
      concat(
        videoTrak(0),
        soundTrak(
          concat(
            sttsRuns([
              [1, 0],
              [1, 1024],
            ]),
            stscRuns([[1, 2, 1]]),
            stszValues([2, 4]),
            stcoValues([0]),
          ),
        ),
      ),
      media,
    );
    const videoStco = stcoBoxesIn(inside)[0] ?? 0;
    new DataView(inside.buffer).setUint32(videoStco + 16, 40);
    expect(dropZeroDurationAudioSamples(inside)).toBe(inside);

    const underflow = movieWith(
      concat(
        videoTrak(0),
        soundTrak(
          concat(
            sttsRuns([
              [1, 0],
              [1, 1024],
            ]),
            stscRuns([[1, 2, 1]]),
            stszValues([2, 4]),
            stcoValues([0]),
          ),
        ),
      ),
      media,
    );
    new DataView(underflow.buffer).setUint32((stcoBoxesIn(underflow)[0] ?? 0) + 16, 0);
    expect(dropZeroDurationAudioSamples(underflow)).toBe(underflow);

    const doubled = concat(
      ftyp,
      box(
        'moov',
        soundTrak(
          concat(
            sttsRuns([
              [1, 0],
              [1, 1024],
            ]),
            stscRuns([[1, 2, 1]]),
            stszValues([2, 4]),
            stcoValues([400]),
          ),
        ),
      ),
      box('moov', new Uint8Array(0)),
      box('mdat', media),
    );
    expect(dropZeroDurationAudioSamples(doubled)).toBe(doubled);

    const overflow = concat(
      ftyp,
      box(
        'moov',
        soundTrak(
          concat(
            sttsRuns([
              [1, 0],
              [1, 1024],
            ]),
            stscRuns([[1, 2, 1]]),
            stszValues([1, 4]),
            co64Values([0xffffffffffffffffn]),
          ),
        ),
      ),
      box('mdat', media),
    );
    expect(dropZeroDurationAudioSamples(overflow)).toBe(overflow);
  });

  it('drops the bad sample when the movie header stays the same size', () => {
    const media = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17);
    const input = movieWith(
      soundTrak(
        concat(
          sttsRuns([
            [1, 0],
            [3, 1024],
          ]),
          stscRuns([[1, 2, 1]]),
          stszValues([2, 4, 5, 6]),
          stcoValues([0, 0]),
        ),
      ),
      media,
    );
    const stco = stcoBoxesIn(input)[0] ?? 0;
    const view = new DataView(input.buffer);
    const origin = view.getUint32(stco + 16);
    view.setUint32(stco + 20, origin + 6);
    const healed = dropZeroDurationAudioSamples(input);
    expect(healed).not.toBe(input);
    expect(healed.byteLength).toBe(input.byteLength);
    const healedStco = stcoBoxesIn(healed)[0] ?? 0;
    const healedView = new DataView(healed.buffer, healed.byteOffset, healed.byteLength);
    expect(healed[healedView.getUint32(healedStco + 16)]).toBe(3);

    const frozen = new Uint8Array(input);
    const moovAt = Buffer.from(frozen).indexOf('moov') - 4;
    new DataView(frozen.buffer).setUint32(moovAt, 0);
    expect(dropZeroDurationAudioSamples(frozen)).toBe(frozen);
  });

  it('stores a huge chunk offset in co64 and still points at the kept sample', () => {
    const media = Uint8Array.of(9, 9, 9, 9, 1, 2, 3, 4);
    const input = movieWith(
      concat(
        videoTrak(0),
        soundTrak(
          concat(
            sttsRuns([
              [1, 0],
              [2, 1024],
              [3, 1024],
            ]),
            stscRuns([
              [1, 3, 1],
              [2, 3, 1],
            ]),
            stszValues([4, 4, 4, 4, 4, 4], true),
            stcoValues([0, 0]),
          ),
        ),
      ),
      media,
    );
    const view = new DataView(input.buffer);
    const marker = Buffer.from(input).indexOf('soun');
    const stcoAt = Buffer.from(input).indexOf('stco', marker) - 4;
    view.setUint32(stcoAt + 16, 0xfffffffc);
    view.setUint32(stcoAt + 20, 0xfffffffc);
    const healed = dropZeroDurationAudioSamples(input);
    expect(Buffer.from(healed).includes(Buffer.from('co64'))).toBe(true);
    expect(healed).not.toBe(input);
  });

  it('leaves the file unchanged when another track cannot hold a shifted 32-bit offset', () => {
    const media = Uint8Array.of(9, 9, 9, 9, 1, 2, 3, 4);
    const input = movieWith(
      concat(
        videoTrak(0),
        soundTrak(
          concat(
            sttsRuns([
              [1, 0],
              [7, 1024],
            ]),
            stscRuns([[1, 2, 1]]),
            stszValues([4, 5, 6, 7, 8, 9, 10, 11]),
            stcoValues([0, 0, 0, 0]),
          ),
        ),
      ),
      media,
    );
    const view = new DataView(input.buffer);
    const marker = Buffer.from(input).indexOf('soun');
    const audioStco = Buffer.from(input).indexOf('stco', marker) - 4;
    for (let entry = 0; entry < 4; entry += 1) {
      view.setUint32(audioStco + 16 + entry * 4, 0xfffffffc);
    }
    const videoStco = stcoBoxesIn(input)[0] ?? 0;
    view.setUint32(videoStco + 16, 0xffffffff);
    expect(dropZeroDurationAudioSamples(input)).toBe(input);
  });

  it('leaves a fragmented file unchanged when the movie header would move', () => {
    const media = Uint8Array.of(0x11, 0x90, 0xaa, 0xbb, 0xcc, 0xdd);
    const base = movieWith(
      soundTrak(
        concat(
          sttsRuns([
            [1, 0],
            [1, 1024],
          ]),
          stscRuns([[1, 2, 1]]),
          stszValues([2, 4]),
          stcoValues([0]),
        ),
      ),
      media,
    );
    for (const kind of ['moof', 'mfra']) {
      const fragmented = concat(base, box(kind, new Uint8Array(8)));
      expect(dropZeroDurationAudioSamples(fragmented)).toBe(fragmented);
    }
  });

  it('keeps a per-sample size table when every kept sample has size 0', () => {
    const media = Uint8Array.of(0x11, 0x90, 0xaa, 0xbb, 0xcc, 0xdd);
    const input = movieWith(
      soundTrak(
        concat(
          sttsRuns([
            [1, 0],
            [2, 1024],
          ]),
          stscRuns([[1, 3, 1]]),
          stszValues([0, 0, 0]),
          stcoValues([0]),
        ),
      ),
      media,
    );
    const healed = dropZeroDurationAudioSamples(input);
    expect(healed).not.toBe(input);
    const at = Buffer.from(healed).indexOf('stsz');
    const view = new DataView(healed.buffer, healed.byteOffset, healed.byteLength);
    expect(view.getUint32(at - 4)).toBe(28);
    expect(view.getUint32(at + 8)).toBe(0);
    expect(view.getUint32(at + 12)).toBe(2);
    expect(view.getUint32(at + 16)).toBe(0);
    expect(view.getUint32(at + 20)).toBe(0);
  });

  it('heals on upload and on read', async () => {
    const media = Uint8Array.of(0x11, 0x90, 0xaa, 0xbb, 0xcc, 0xdd);
    const broken = concat(
      ftypBox(),
      box('mdat', media),
      box(
        'moov',
        soundTrak(
          concat(
            sttsRuns([
              [1, 0],
              [1, 1024],
            ]),
            stscRuns([[1, 2, 1]]),
            stszValues([2, 4]),
            stcoValues([ftypBox().byteLength + 8]),
          ),
        ),
      ),
    );
    const decoded = decodeForumVideo(broken);
    expect(decoded).not.toBeNull();
    if (decoded === null) {
      return;
    }
    const decodedView = new DataView(
      decoded.bytes.buffer,
      decoded.bytes.byteOffset,
      decoded.bytes.byteLength,
    );
    const decodedStco = firstBytes(decoded.bytes, 'stco');
    expect(decodedStco).not.toBeNull();
    if (decodedStco === null) {
      return;
    }
    expect(decoded.bytes[decodedView.getUint32(decodedStco.payload + 8)]).toBe(0xaa);

    const id = 'vid-audio-zero';
    const path = videoFilePath(resolveMediaDir(), id, 'video/mp4');
    await fs.writeFile(path, broken);
    try {
      const healed = await readForumVideoBytes(path, fs, {});
      expect(new Uint8Array(await fs.readFile(path))).toEqual(healed);
      const again = await readForumVideoBytes(path, fs, {});
      expect(again).toEqual(healed);
    } finally {
      await removeForumVideo(id, 'video/mp4');
    }
  });

  it('rejects audio tables that cannot be rewritten safely', () => {
    const media = Uint8Array.of(1, 2, 3, 4, 5, 6);
    const base = (): Uint8Array =>
      movieWith(
        soundTrak(
          concat(
            sttsRuns([
              [1, 0],
              [1, 1024],
            ]),
            stscRuns([[1, 2, 1]]),
            stszValues([2, 4]),
            stcoValues([0]),
          ),
        ),
        media,
      );
    const version = (type: string): Uint8Array => {
      const file = base();
      const at = Buffer.from(file).indexOf(type);
      file[at + 4] = 1;
      return file;
    };
    const shortHandler = movieWith(
      box(
        'trak',
        box(
          'mdia',
          concat(box('hdlr', new Uint8Array(4)), box('minf', box('stbl', stcoValues([0])))),
        ),
      ),
      media,
    );
    const noTiming = movieWith(soundTrak(concat(stszValues([4]), stcoValues([0]))), media);
    const bothOffsets = movieWith(
      soundTrak(
        concat(
          sttsRuns([
            [1, 0],
            [1, 1024],
          ]),
          stscRuns([[1, 2, 1]]),
          stszValues([2, 4]),
          stcoValues([0]),
          co64Values([0n]),
        ),
      ),
      media,
    );
    const duplicate = movieWith(
      soundTrak(
        concat(
          sttsRuns([[1, 0]]),
          sttsRuns([[1, 1024]]),
          stscRuns([[1, 2, 1]]),
          stszValues([2, 4]),
          stcoValues([0]),
        ),
      ),
      media,
    );
    const overCount = base();
    const sttsAt = Buffer.from(overCount).indexOf('stts');
    new DataView(overCount.buffer).setUint32(sttsAt + 8, 2_000_001);
    const uneven = movieWith(
      soundTrak(
        concat(sttsRuns([[2, 0]]), stscRuns([[1, 3, 1]]), stszValues([2, 2]), stcoValues([0])),
      ),
      media,
    );
    const lateChunk = movieWith(
      soundTrak(
        concat(
          sttsRuns([
            [1, 0],
            [1, 1024],
          ]),
          stscRuns([
            [1, 2, 1],
            [5, 1, 1],
          ]),
          stszValues([2, 4]),
          stcoValues([0]),
        ),
      ),
      media,
    );
    const badDesc = movieWith(
      soundTrak(
        concat(
          sttsRuns([
            [1, 0],
            [1, 1024],
          ]),
          stscRuns([[1, 2, 0]]),
          stszValues([2, 4]),
          stcoValues([0]),
        ),
      ),
      media,
    );
    const emptyStsc = movieWith(
      soundTrak(
        concat(
          sttsRuns([
            [1, 0],
            [1, 1024],
          ]),
          stscRuns([]),
          stszValues([2, 4]),
          stcoValues([0]),
        ),
      ),
      media,
    );
    const notFirst = movieWith(
      soundTrak(
        concat(
          sttsRuns([
            [1, 0],
            [1, 1024],
          ]),
          stscRuns([[2, 2, 1]]),
          stszValues([2, 4]),
          stcoValues([0]),
        ),
      ),
      media,
    );
    const allZero = movieWith(
      soundTrak(
        concat(sttsRuns([[1, 0]]), stscRuns([[1, 1, 1]]), stszValues([2]), stcoValues([0])),
      ),
      media,
    );
    const zeroCount = base();
    const zeroStts = Buffer.from(zeroCount).indexOf('stts');
    new DataView(zeroCount.buffer).setUint32(zeroStts + 12, 0);
    const hugeSizes = base();
    const stszAt = Buffer.from(hugeSizes).indexOf('stsz');
    new DataView(hugeSizes.buffer).setUint32(stszAt + 8, 4);
    new DataView(hugeSizes.buffer).setUint32(stszAt + 12, 2_000_001);
    const shortSizes = base();
    const shortStsz = Buffer.from(shortSizes).indexOf('stsz');
    new DataView(shortSizes.buffer).setUint32(shortStsz + 12, 9);
    const hugeStsc = base();
    const stscAt = Buffer.from(hugeStsc).indexOf('stsc');
    new DataView(hugeStsc.buffer).setUint32(stscAt + 8, 40);
    const decreasing = movieWith(
      soundTrak(
        concat(
          sttsRuns([
            [1, 0],
            [1, 1024],
          ]),
          stscRuns([
            [1, 1, 1],
            [1, 1, 1],
          ]),
          stszValues([2, 4]),
          stcoValues([0, 0]),
        ),
      ),
      media,
    );
    const shortStco = base();
    const stcoAt = Buffer.from(shortStco).indexOf('stco');
    new DataView(shortStco.buffer).setUint32(stcoAt + 8, 9);
    const shortCo64 = movieWith(
      soundTrak(
        concat(
          sttsRuns([
            [1, 0],
            [1, 1024],
          ]),
          stscRuns([[1, 2, 1]]),
          stszValues([2, 4]),
          co64Values([0n]),
        ),
      ),
      media,
    );
    const co64At = Buffer.from(shortCo64).indexOf('co64');
    new DataView(shortCo64.buffer).setUint32(co64At + 8, 9);
    const otherBroken = movieWith(
      concat(
        videoTrak(0),
        soundTrak(
          concat(
            sttsRuns([
              [1, 0],
              [1, 1024],
            ]),
            stscRuns([[1, 2, 1]]),
            stszValues([2, 4]),
            stcoValues([0]),
          ),
        ),
      ),
      media,
    );
    const videoStco = stcoBoxesIn(otherBroken)[0] ?? 0;
    new DataView(otherBroken.buffer).setUint32(videoStco + 12, 9);
    const brokenTree = concat(ftypBox(), box('moov', new Uint8Array([0, 0, 0, 1])));
    for (const file of [
      version('stts'),
      version('stsz'),
      version('stsc'),
      version('stco'),
      shortHandler,
      noTiming,
      bothOffsets,
      duplicate,
      overCount,
      uneven,
      lateChunk,
      badDesc,
      emptyStsc,
      notFirst,
      allZero,
      zeroCount,
      hugeSizes,
      shortSizes,
      hugeStsc,
      decreasing,
      shortStco,
      shortCo64,
      otherBroken,
      brokenTree,
    ]) {
      expect(dropZeroDurationAudioSamples(file)).toBe(file);
    }
  });

  it('rewrites a largesize moov and a file whose moov size does not change', () => {
    const media = Uint8Array.of(9, 9, 9, 9, 1, 2, 3, 4);
    const inner = soundTrak(
      concat(
        sttsRuns([
          [1, 0],
          [1, 1024],
        ]),
        stscRuns([[1, 2, 1]]),
        stszValues([4, 4]),
        stcoValues([0]),
      ),
    );
    const moov = box64('moov', inner);
    const wide = concat(ftypBox(), moov, box('mdat', media));
    const payloadAt = ftypBox().byteLength + moov.byteLength + 8;
    const stcoAt = Buffer.from(wide).indexOf('stco');
    new DataView(wide.buffer).setUint32(stcoAt + 12, payloadAt);
    expect(dropZeroDurationAudioSamples(wide)).not.toBe(wide);

    const balanced = movieWith(
      concat(
        videoTrak(0),
        soundTrak(
          concat(
            sttsRuns([
              [1, 0],
              [2, 1024],
              [3, 512],
            ]),
            stscRuns([
              [1, 3, 1],
              [2, 3, 1],
            ]),
            stszValues([4, 4, 4, 4, 4, 4], true),
            stcoValues([0, 0]),
          ),
        ),
      ),
      media,
    );
    const marker = Buffer.from(balanced).indexOf('soun');
    const audioStco = Buffer.from(balanced).indexOf('stco', marker);
    const view = new DataView(balanced.buffer);
    view.setUint32(audioStco + 12, 0xfffffffc);
    view.setUint32(audioStco + 16, 0xfffffffc);
    const healed = dropZeroDurationAudioSamples(balanced);
    expect(Buffer.from(healed).includes(Buffer.from('co64'))).toBe(true);

    const extended = movieWith(
      soundTrak(
        concat(
          sttsRuns([
            [1, 0],
            [1, 1024],
          ]),
          stscRuns([[1, 2, 1]]),
          stszValues([2, 4]),
          stcoValues([0]),
        ),
      ),
      Uint8Array.of(1, 2, 3, 4, 5, 6),
    );
    const moovAt = Buffer.from(extended).indexOf('moov') - 4;
    new DataView(extended.buffer).setUint32(moovAt, 0);
    expect(dropZeroDurationAudioSamples(extended)).toBe(extended);

    const mixed = movieWith(
      soundTrak(
        concat(
          sttsRuns([
            [1, 0],
            [1, 1024],
            [1, 512],
          ]),
          stscRuns([
            [1, 2, 1],
            [2, 1, 1],
          ]),
          stszValues([2, 4, 6]),
          stcoValues([0, 0]),
        ),
      ),
      Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12),
    );
    expect(dropZeroDurationAudioSamples(mixed)).not.toBe(mixed);
  });

  it('keeps an existing 64-bit chunk offset pointed at the kept sample', () => {
    const media = Uint8Array.of(0x11, 0x90, 0xaa, 0xbb, 0xcc, 0xdd);
    const moov = box(
      'moov',
      soundTrak(
        concat(
          sttsRuns([
            [1, 0],
            [1, 1024],
          ]),
          stscRuns([[1, 2, 1]]),
          stszValues([2, 4]),
          co64Values([0n]),
        ),
      ),
    );
    const file = concat(ftypBox(), moov, box('mdat', media));
    const payloadAt = BigInt(ftypBox().byteLength + moov.byteLength + 8);
    const co64At = Buffer.from(file).indexOf('co64');
    new DataView(file.buffer).setBigUint64(co64At + 12, payloadAt);
    const healed = dropZeroDurationAudioSamples(file);
    const healedCo64 = Buffer.from(healed).indexOf('co64');
    const offset = new DataView(healed.buffer).getBigUint64(healedCo64 + 12);
    expect(healed[Number(offset)]).toBe(0xaa);
  });
});
