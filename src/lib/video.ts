/**
 * Forum video validation: magic-byte MIME, size cap, and filename extension
 * so Damus embeds the URL as a player instead of a website card.
 */

import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Maximum decoded video size (32 MiB). */
export const MESSAGE_VIDEO_MAX_BYTES = 32 * 1024 * 1024;

/** Allowed stored video types. */
export type ForumVideoContentType = 'video/mp4' | 'video/webm' | 'video/quicktime';

/** Decoded forum video ready for disk. */
export interface ForumVideo {
  /** MIME from magic bytes. */
  contentType: ForumVideoContentType;
  /** Raw container bytes. */
  bytes: Uint8Array;
}

/**
 * Resolve the on-disk media directory.
 *
 * @param env - Process env (injected for tests).
 * @returns `MEDIA_DIR` when set, otherwise a process-local temp dir.
 */
export function resolveMediaDir(env: Record<string, string | undefined> = process.env): string {
  const raw = env['MEDIA_DIR'];
  if (raw !== undefined && raw.trim() !== '') {
    return raw.trim();
  }
  return join(tmpdir(), '21gifts-media');
}

/**
 * Filename extension Damus treats as inline video.
 *
 * @param mime - Stored type.
 * @returns `mp4`, `webm`, or `mov`.
 */
export function forumVideoExt(mime: ForumVideoContentType): 'mp4' | 'webm' | 'mov' {
  if (mime === 'video/webm') {
    return 'webm';
  }
  if (mime === 'video/quicktime') {
    return 'mov';
  }
  return 'mp4';
}

/**
 * Absolute public video URL for kind:1 + `imeta`.
 *
 * @param apiBase - Public API origin.
 * @param messageId - Message id.
 * @param mime - Stored type.
 * @returns `GET /messages/:id/video.mp4` (or `.webm` / `.mov`).
 */
export function forumVideoUrl(
  apiBase: string,
  messageId: string,
  mime: ForumVideoContentType,
): string {
  return `${apiBase.replace(/\/$/, '')}/messages/${messageId}/video.${forumVideoExt(mime)}`;
}

/**
 * On-disk path for a message video.
 *
 * @param dir - Media directory.
 * @param messageId - Message id.
 * @param mime - Stored type.
 * @returns Absolute file path.
 */
export function videoFilePath(dir: string, messageId: string, mime: ForumVideoContentType): string {
  return join(dir, `${messageId}.${forumVideoExt(mime)}`);
}

/**
 * Detect MP4 / QuickTime / WebM from magic bytes.
 *
 * @param bytes - Raw candidate.
 * @returns Matching type, or `null`.
 */
export function detectVideoContentType(bytes: Uint8Array): ForumVideoContentType | null {
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(
      bytes[8] as number,
      bytes[9] as number,
      bytes[10] as number,
      bytes[11] as number,
    );
    if (brand.startsWith('qt')) {
      return 'video/quicktime';
    }
    return 'video/mp4';
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return 'video/webm';
  }
  return null;
}

/**
 * Validate raw video bytes (size + magic).
 *
 * @param bytes - Uploaded bytes.
 * @returns A {@link ForumVideo}, or `null` when empty, oversize, or unrecognized.
 */
export function decodeForumVideo(bytes: Uint8Array): ForumVideo | null {
  if (bytes.length === 0 || bytes.length > MESSAGE_VIDEO_MAX_BYTES) {
    return null;
  }
  const contentType = detectVideoContentType(bytes);
  if (contentType === null) {
    return null;
  }
  return { contentType, bytes: bytes.slice() };
}

/**
 * Write video bytes to `MEDIA_DIR`. Creates the directory when missing.
 *
 * @param messageId - Message id (filename stem).
 * @param video - Validated video.
 * @param env - Process env.
 */
export async function writeForumVideo(
  messageId: string,
  video: ForumVideo,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const dir = resolveMediaDir(env);
  await mkdir(dir, { recursive: true });
  await writeFile(videoFilePath(dir, messageId, video.contentType), video.bytes);
}

/**
 * Delete a video file if present (best-effort).
 *
 * @param messageId - Message id.
 * @param mime - Stored type.
 * @param env - Process env.
 */
export async function removeForumVideo(
  messageId: string,
  mime: ForumVideoContentType,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  try {
    await unlink(videoFilePath(resolveMediaDir(env), messageId, mime));
  } catch {
    /* missing file is fine */
  }
}

/**
 * Parse a single `bytes=start-end` Range header.
 *
 * @param header - Raw Range header, or undefined.
 * @param size - File size in bytes.
 * @returns Inclusive start/end, or `null` for a full-file response.
 */
export function parseBytesRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (header === undefined || header.trim() === '') {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null || size <= 0) {
    return null;
  }
  /* v8 ignore next 2 -- capturing groups are always strings */
  const startRaw = match[1] === undefined ? '' : match[1];
  const endRaw = match[2] === undefined ? '' : match[2];
  if (startRaw === '' && endRaw === '') {
    return null;
  }
  if (startRaw === '') {
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return null;
    }
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }
  const start = Number(startRaw);
  const end = endRaw === '' ? size - 1 : Number(endRaw);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}
