import { describe, expect, it } from 'vitest';
import {
  decodeForumVideo,
  detectVideoContentType,
  forumVideoExt,
  forumVideoUrl,
  parseBytesRange,
  removeForumVideo,
  resolveMediaDir,
  streamForumVideo,
  videoFilePath,
  writeForumVideo,
} from '@/lib/video';

function mp4Bytes(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  return bytes;
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

  it('writes and removes a video file', async () => {
    const video = decodeForumVideo(mp4Bytes());
    expect(video).not.toBeNull();
    if (video === null) {
      return;
    }
    await writeForumVideo('vid-1', video);
    const stream = streamForumVideo(
      videoFilePath(resolveMediaDir(), 'vid-1', 'video/mp4'),
      0,
      video.bytes.byteLength - 1,
    );
    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value?.byteLength).toBeGreaterThan(0);
    await reader.cancel();
    await removeForumVideo('vid-1', 'video/mp4');
    await removeForumVideo('missing', 'video/mp4');
  });
});
