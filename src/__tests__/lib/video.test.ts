import * as fs from 'node:fs/promises';
import { chmod, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  decodeForumVideo,
  detectVideoContentType,
  faststartIsoBmff,
  forumVideoExt,
  forumVideoUrl,
  isoBmffDisplaySize,
  parseBytesRange,
  readForumVideoBytes,
  removeForumVideo,
  resolveMediaDir,
  videoFilePath,
  writeForumVideo,
} from '@/lib/video';

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
});
