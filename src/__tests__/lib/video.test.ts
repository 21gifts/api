import { readFile } from 'node:fs/promises';
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
    const size = view.getUint32(offset);
    if (size < 8 || offset + size > bytes.byteLength) {
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

  it('falls back to a temp media dir', () => {
    expect(resolveMediaDir({ MEDIA_DIR: ' /data/media ' })).toBe('/data/media');
    expect(resolveMediaDir({})).toContain('21gifts-media');
  });

  it('moves moov before mdat and patches stco', () => {
    const input = mdatFirstFixture();
    const moov = moovWithStco(ftypBox().byteLength + 8);
    const remuxed = faststartIsoBmff(input);
    expect(remuxed.byteLength).toBe(input.byteLength);
    expect(topLevelTypes(remuxed)).toEqual(['ftyp', 'moov', 'mdat']);
    expect(readStcoOffset(remuxed)).toBe(ftypBox().byteLength + 8 + moov.byteLength);
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
    const truncated = new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70, 1]);
    expect(faststartIsoBmff(truncated)).toBe(truncated);
  });

  it('reads display size from tkhd and returns null without moov', () => {
    const withTkhd = concat(ftypBox(), box('moov', box('trak', tkhdBox(720, 1280))));
    expect(isoBmffDisplaySize(withTkhd)).toEqual({ width: 720, height: 1280 });
    const v1 = concat(ftypBox(), box('moov', box('trak', tkhdBox(640, 360, 1))));
    expect(isoBmffDisplaySize(v1)).toEqual({ width: 640, height: 360 });
    const audioThenVideo = concat(
      ftypBox(),
      box('moov', concat(box('trak', tkhdBox(0, 0)), box('trak', tkhdBox(1280, 720)))),
    );
    expect(isoBmffDisplaySize(audioThenVideo)).toEqual({ width: 1280, height: 720 });
    expect(isoBmffDisplaySize(ftypBox())).toBeNull();
    expect(isoBmffDisplaySize(new Uint8Array([1, 2, 3]))).toBeNull();
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
});
