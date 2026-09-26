/**
 * Forum video validation: magic-byte MIME, size cap, filename extension,
 * and ISO-BMFF faststart so Safari/Damus can play without seeking to EOF.
 */

import * as fs from 'node:fs/promises';

/** Disk ops {@link readForumVideoBytes} uses (overridable in tests). */
export type ForumVideoFs = Pick<typeof fs, 'readFile' | 'writeFile' | 'rename' | 'unlink'>;
import { basename, dirname, join } from 'node:path';

/** Maximum decoded video size (32 MiB). */
export const MESSAGE_VIDEO_MAX_BYTES = 32 * 1024 * 1024;

/** Allowed stored video types. */
export type ForumVideoContentType = 'video/mp4' | 'video/webm' | 'video/quicktime';

/** ISO-BMFF major brands treated as MP4 (lowercased 4-byte brand). */
const MP4_BRANDS = new Set([
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'mp71',
  'avc1',
  'avc3',
  'dash',
  'm4v ',
]);

/** Container boxes that may nest `stco` / `co64` or further containers. */
const ISO_BMFF_CONTAINERS = new Set([
  'moov',
  'trak',
  'mdia',
  'minf',
  'stbl',
  'edts',
  'udta',
  'mvex',
  'moof',
  'traf',
  'meta',
  'dinf',
]);

/** Visual sample-entry types with coded width/height at payload offset 24. */
const VISUAL_SAMPLE_ENTRY_TYPES = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'mp4v', 'encv', 'vp09']);

/** 16.16 unit for `1` in a QuickTime display matrix. */
const DISPLAY_MATRIX_UNITY = 65536;

/** Required 2.30 `w` for a rotation this module will patch. */
const DISPLAY_MATRIX_W = 0x40000000;

/** Decoded forum video ready for disk. */
export interface ForumVideo {
  /** MIME from magic bytes. */
  contentType: ForumVideoContentType;
  /** Raw container bytes. Stored as these bytes, apart from faststart and display-matrix repair. */
  bytes: Uint8Array;
  /** Civil capture time read from the container. Absent or null when the file has none. */
  takenAt?: string | null;
}

/** One top-level or nested ISO-BMFF box. */
interface IsoBmffBox {
  /** Four-character type. */
  type: string;
  /** Absolute start offset in the buffer. */
  start: number;
  /** Total box size including header. */
  size: number;
  /** Header length (8 or 16). */
  headerSize: number;
}

/**
 * Resolve the on-disk media directory.
 *
 * @param env - Process env (injected for tests).
 * @returns Trimmed `MEDIA_DIR`.
 * @throws If `MEDIA_DIR` is missing, not a string, or blank after trim.
 */
export function resolveMediaDir(env: Record<string, string | undefined> = process.env): string {
  const raw = env['MEDIA_DIR'];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('MEDIA_DIR must be a non-empty path');
  }
  return raw.trim();
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
 * True when the stored video file exists, is a regular file, and is non-empty.
 *
 * @param dir - Media directory.
 * @param messageId - Message id.
 * @param mime - Stored type, or `null` when the row has no video.
 * @param statFn - Injected `stat` (tests).
 * @returns False when `mime` is null, the path is missing (`ENOENT`), not a file, or size 0.
 * @throws Non-ENOENT `stat` failures (for example EACCES, EIO).
 */
export async function forumVideoFilePresent(
  dir: string,
  messageId: string,
  mime: ForumVideoContentType | null,
  statFn: (path: string) => Promise<{ isFile: () => boolean; size: number }> = fs.stat,
): Promise<boolean> {
  if (mime === null) {
    return false;
  }
  try {
    const info = await statFn(videoFilePath(dir, messageId, mime));
    return info.isFile() && info.size > 0;
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return false;
    }
    throw err;
  }
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
    if (MP4_BRANDS.has(brand.toLowerCase())) {
      return 'video/mp4';
    }
    return null;
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    const head = String.fromCharCode(...bytes.subarray(0, Math.min(256, bytes.length)));
    if (head.toLowerCase().includes('webm')) {
      return 'video/webm';
    }
    return null;
  }
  return null;
}

/**
 * Read a box header at `offset`.
 *
 * @param bytes - Buffer.
 * @param offset - Start of the box.
 * @param end - Exclusive end of the available region.
 * @returns Parsed box, or `null` when truncated/invalid.
 */
function readIsoBmffBox(bytes: Uint8Array, offset: number, end: number): IsoBmffBox | null {
  if (offset + 8 > end) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size = view.getUint32(offset);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > end) {
      return null;
    }
    const large = view.getBigUint64(offset + 8);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }
    size = Number(large);
    headerSize = 16;
  } else if (size === 0) {
    size = end - offset;
  }
  if (size < headerSize || offset + size > end) {
    return null;
  }
  const type = String.fromCharCode(
    bytes[offset + 4] as number,
    bytes[offset + 5] as number,
    bytes[offset + 6] as number,
    bytes[offset + 7] as number,
  );
  return { type, start: offset, size, headerSize };
}

/**
 * Parse contiguous sibling boxes in `[start, end)`.
 *
 * @param bytes - Buffer.
 * @param start - Inclusive start.
 * @param end - Exclusive end.
 * @returns Boxes in order, or `null` when truncated/invalid.
 */
function parseIsoBmffBoxes(bytes: Uint8Array, start: number, end: number): IsoBmffBox[] | null {
  const boxes: IsoBmffBox[] = [];
  let offset = start;
  while (offset < end) {
    const box = readIsoBmffBox(bytes, offset, end);
    if (box === null) {
      return null;
    }
    boxes.push(box);
    offset = box.start + box.size;
  }
  return boxes;
}

/**
 * Add `delta` to every `stco` / `co64` chunk offset under `box`.
 *
 * Aborts (`false`) on truncated / oversized chunk-offset tables, a `cmov`
 * box, unparseable container children, or an `stco` uint32 overflow.
 *
 * @param bytes - Mutable buffer holding the box tree.
 * @param box - Current box.
 * @param delta - Byte shift applied to chunk offsets.
 * @param state - Counts visited `stco` / `co64` boxes.
 * @returns `false` when the remux must be abandoned.
 */
function patchChunkOffsets(
  bytes: Uint8Array,
  box: IsoBmffBox,
  delta: number,
  state: { offsetBoxes: number },
): boolean {
  const payloadStart = box.start + box.headerSize;
  const payloadEnd = box.start + box.size;
  if (box.type === 'cmov') {
    return false;
  }
  if (box.type === 'stco') {
    if (payloadStart + 8 > payloadEnd) {
      return false;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint32(payloadStart + 4);
    if (payloadStart + 8 + count * 4 > payloadEnd) {
      return false;
    }
    state.offsetBoxes += 1;
    for (let i = 0; i < count; i += 1) {
      const at = payloadStart + 8 + i * 4;
      const next = view.getUint32(at) + delta;
      if (next > 0xffffffff) {
        return false;
      }
      view.setUint32(at, next);
    }
    return true;
  }
  if (box.type === 'co64') {
    if (payloadStart + 8 > payloadEnd) {
      return false;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint32(payloadStart + 4);
    if (payloadStart + 8 + count * 8 > payloadEnd) {
      return false;
    }
    state.offsetBoxes += 1;
    const bigDelta = BigInt(delta);
    for (let i = 0; i < count; i += 1) {
      const at = payloadStart + 8 + i * 8;
      view.setBigUint64(at, view.getBigUint64(at) + bigDelta);
    }
    return true;
  }
  if (!ISO_BMFF_CONTAINERS.has(box.type)) {
    return true;
  }
  const children = parseIsoBmffBoxes(bytes, payloadStart, payloadEnd);
  if (children === null) {
    return false;
  }
  for (const child of children) {
    if (!patchChunkOffsets(bytes, child, delta, state)) {
      return false;
    }
  }
  return true;
}

/**
 * Rearrange ISO-BMFF so moov precedes mdat (qt-faststart).
 *
 * @param bytes - Container bytes.
 * @returns Remuxed copy, or the original `bytes` when unchanged / invalid.
 */
export function faststartIsoBmff(bytes: Uint8Array): Uint8Array {
  const top = parseIsoBmffBoxes(bytes, 0, bytes.byteLength);
  if (top === null) {
    return bytes;
  }
  let moov: IsoBmffBox | undefined;
  let mdat: IsoBmffBox | undefined;
  let moovCount = 0;
  let mdatCount = 0;
  let hasMoof = false;
  for (const box of top) {
    if (box.type === 'moov') {
      moovCount += 1;
      moov = box;
    } else if (box.type === 'mdat') {
      mdatCount += 1;
      mdat = box;
    } else if (box.type === 'moof') {
      hasMoof = true;
    }
  }
  if (moovCount !== 1 || mdatCount !== 1 || moov === undefined || mdat === undefined || hasMoof) {
    return bytes;
  }
  if (moov.start < mdat.start) {
    return bytes;
  }
  const delta = moov.size;
  let moovBytes = bytes.slice(moov.start, moov.start + moov.size);
  if (moov.headerSize === 8) {
    const declared = new DataView(bytes.buffer, bytes.byteOffset + moov.start, 4).getUint32(0);
    if (declared === 0) {
      // Files are capped at 32 MiB, so the rewritten size always fits uint32.
      moovBytes = new Uint8Array(moovBytes);
      new DataView(moovBytes.buffer, moovBytes.byteOffset).setUint32(0, moov.size);
    }
  }
  const moovBox: IsoBmffBox = {
    type: 'moov',
    start: 0,
    size: moov.size,
    headerSize: moov.headerSize,
  };
  const state = { offsetBoxes: 0 };
  if (!patchChunkOffsets(moovBytes, moovBox, delta, state) || state.offsetBoxes === 0) {
    return bytes;
  }
  const out = new Uint8Array(bytes.byteLength);
  let writeAt = 0;
  for (const box of top) {
    if (box.type === 'moov') {
      continue;
    }
    if (box.type === 'mdat') {
      out.set(moovBytes, writeAt);
      writeAt += moovBytes.byteLength;
    }
    out.set(bytes.subarray(box.start, box.start + box.size), writeAt);
    writeAt += box.size;
  }
  return out;
}

/**
 * Walk nested boxes for the first non-zero `tkhd` display size.
 *
 * @param bytes - Buffer.
 * @param box - Current box.
 * @returns Width/height integers, or `null`.
 */
function findTkhdDisplaySize(
  bytes: Uint8Array,
  box: IsoBmffBox,
): { width: number; height: number } | null {
  const payloadStart = box.start + box.headerSize;
  const payloadEnd = box.start + box.size;
  if (box.type === 'tkhd') {
    if (payloadStart >= payloadEnd) {
      return null;
    }
    const version = bytes[payloadStart] as number;
    if (version !== 0 && version !== 1) {
      return null;
    }
    const widthAt = version === 1 ? payloadStart + 88 : payloadStart + 76;
    const heightAt = widthAt + 4;
    if (heightAt + 4 > payloadEnd) {
      return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(widthAt) >>> 16;
    const height = view.getUint32(heightAt) >>> 16;
    if (width > 0 && height > 0) {
      return { width, height };
    }
    return null;
  }
  if (!ISO_BMFF_CONTAINERS.has(box.type)) {
    return null;
  }
  const children = parseIsoBmffBoxes(bytes, payloadStart, payloadEnd);
  if (children === null) {
    return null;
  }
  for (const child of children) {
    const size = findTkhdDisplaySize(bytes, child);
    if (size !== null) {
      return size;
    }
  }
  return null;
}

/**
 * Display size from the first non-zero tkhd (16.16).
 *
 * @param bytes - ISO-BMFF bytes.
 * @returns Integer width/height, or `null` when missing.
 */
export function isoBmffDisplaySize(bytes: Uint8Array): { width: number; height: number } | null {
  const top = parseIsoBmffBoxes(bytes, 0, bytes.byteLength);
  if (top === null) {
    return null;
  }
  for (const box of top) {
    if (box.type !== 'moov') {
      continue;
    }
    const size = findTkhdDisplaySize(bytes, box);
    if (size !== null) {
      return size;
    }
  }
  return null;
}

type DisplayRotation = 90 | 180 | 270;

interface MatrixPatch {
  /** Absolute offset of `tx` in the output buffer. */
  txAt: number;
  /** Absolute offset of the `tkhd` width field. */
  widthAt: number;
  /** Translation and display size, already in 16.16 units. */
  tx: number;
  ty: number;
  displayWidth: number;
  displayHeight: number;
}

/**
 * Put a 90°, 180°, or 270° picture back inside the frame.
 *
 * Some phone files rotate the track but leave `tx`/`ty` at 0, so players
 * that apply the matrix draw every pixel outside the element. An unchanged
 * file is returned as the same reference.
 *
 * @param bytes - ISO-BMFF bytes. Not modified.
 * @returns Patched copy, or `bytes` when nothing changes.
 */
export function normalizeIsoBmffDisplayMatrix(bytes: Uint8Array): Uint8Array {
  const top = parseIsoBmffBoxes(bytes, 0, bytes.byteLength);
  if (top === null) {
    return bytes;
  }
  const patches: MatrixPatch[] = [];
  for (const box of top) {
    if (box.type !== 'moov') {
      continue;
    }
    collectMatrixPatches(bytes, box.start + box.headerSize, box.start + box.size, patches);
  }
  if (patches.length === 0) {
    return bytes;
  }
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (const patch of patches) {
    view.setInt32(patch.txAt, patch.tx);
    view.setInt32(patch.txAt + 4, patch.ty);
    view.setUint32(patch.widthAt, patch.displayWidth);
    view.setUint32(patch.widthAt + 4, patch.displayHeight);
  }
  return out;
}

function rotationOf(a: number, b: number, c: number, d: number): DisplayRotation | null {
  if (a === 0 && b === DISPLAY_MATRIX_UNITY && c === -DISPLAY_MATRIX_UNITY && d === 0) {
    return 90;
  }
  if (a === 0 && b === -DISPLAY_MATRIX_UNITY && c === DISPLAY_MATRIX_UNITY && d === 0) {
    return 270;
  }
  if (a === -DISPLAY_MATRIX_UNITY && b === 0 && c === 0 && d === -DISPLAY_MATRIX_UNITY) {
    return 180;
  }
  return null;
}

function collectMatrixPatches(
  bytes: Uint8Array,
  start: number,
  end: number,
  patches: MatrixPatch[],
): void {
  const traks = parseIsoBmffBoxes(bytes, start, end);
  if (traks === null) {
    return;
  }
  for (const trak of traks) {
    if (trak.type !== 'trak') {
      continue;
    }
    const patch = matrixPatchForTrak(bytes, trak);
    if (patch !== null) {
      patches.push(patch);
    }
  }
}

function matrixPatchForTrak(bytes: Uint8Array, trak: IsoBmffBox): MatrixPatch | null {
  const found = {
    handler: '',
    tkhd: null as IsoBmffBox | null,
    visual: null as { width: number; height: number } | null,
  };
  const payloadStart = trak.start + trak.headerSize;
  const payloadEnd = trak.start + trak.size;
  if (!scanTrak(bytes, payloadStart, payloadEnd, found)) {
    return null;
  }
  if (found.handler !== 'vide' || found.tkhd === null) {
    return null;
  }
  const tkhd = found.tkhd;
  const body = tkhd.start + tkhd.headerSize;
  const version = bytes[body] as number;
  const layout =
    version === 0
      ? { matrix: 40, width: 76, min: 84 }
      : version === 1
        ? { matrix: 52, width: 88, min: 96 }
        : null;
  if (layout === null || body + layout.min > tkhd.start + tkhd.size) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const matrixAt = body + layout.matrix;
  const widthAt = body + layout.width;
  const u = view.getInt32(matrixAt + 8);
  const v = view.getInt32(matrixAt + 20);
  const w = view.getInt32(matrixAt + 32);
  if (u !== 0) {
    return null;
  }
  if (v !== 0) {
    return null;
  }
  if (w !== DISPLAY_MATRIX_W) {
    return null;
  }
  const rotation = rotationOf(
    view.getInt32(matrixAt),
    view.getInt32(matrixAt + 4),
    view.getInt32(matrixAt + 12),
    view.getInt32(matrixAt + 16),
  );
  if (rotation === null) {
    return null;
  }
  const tx = view.getInt32(matrixAt + 24);
  const ty = view.getInt32(matrixAt + 28);
  const coded = codedSize(
    found.visual,
    view.getUint32(widthAt),
    view.getUint32(widthAt + 4),
    tx,
    ty,
    rotation,
  );
  if (coded === null) {
    return null;
  }
  const display = displayFor(rotation, coded.width, coded.height);
  const needTx = display.tx * DISPLAY_MATRIX_UNITY;
  const needTy = display.ty * DISPLAY_MATRIX_UNITY;
  const needW = display.width * DISPLAY_MATRIX_UNITY;
  const needH = display.height * DISPLAY_MATRIX_UNITY;
  if (
    tx === needTx &&
    ty === needTy &&
    view.getUint32(widthAt) === needW &&
    view.getUint32(widthAt + 4) === needH
  ) {
    return null;
  }
  return {
    txAt: matrixAt + 24,
    widthAt,
    tx: needTx,
    ty: needTy,
    displayWidth: needW,
    displayHeight: needH,
  };
}

function codedSize(
  visual: { width: number; height: number } | null,
  rawWidth: number,
  rawHeight: number,
  tx: number,
  ty: number,
  rotation: DisplayRotation,
): { width: number; height: number } | null {
  if (visual !== null) {
    if (!pixelInRange(visual.width) || !pixelInRange(visual.height)) {
      return null;
    }
    return visual;
  }
  const width = rawWidth >>> 16;
  const height = rawHeight >>> 16;
  let coded = { width, height };
  if (!(tx === 0 && ty === 0) && rotation !== 180) {
    coded = { width: height, height: width };
  }
  if (!pixelInRange(coded.width) || !pixelInRange(coded.height)) {
    return null;
  }
  return coded;
}

function displayFor(
  rotation: DisplayRotation,
  width: number,
  height: number,
): { tx: number; ty: number; width: number; height: number } {
  if (rotation === 90) {
    return { tx: height, ty: 0, width: height, height: width };
  }
  if (rotation === 270) {
    return { tx: 0, ty: width, width: height, height: width };
  }
  return { tx: width, ty: height, width, height };
}

function pixelInRange(value: number): boolean {
  return value >= 1 && value <= 65535;
}

function scanTrak(
  bytes: Uint8Array,
  start: number,
  end: number,
  found: {
    handler: string;
    tkhd: IsoBmffBox | null;
    visual: { width: number; height: number } | null;
  },
): boolean {
  const children = parseIsoBmffBoxes(bytes, start, end);
  if (children === null) {
    return false;
  }
  for (const child of children) {
    if (child.type === 'tkhd' && found.tkhd === null) {
      found.tkhd = child;
    }
    if (child.type === 'hdlr' && found.handler === '') {
      const payload = child.start + child.headerSize;
      if (payload + 12 <= child.start + child.size) {
        found.handler = String.fromCharCode(
          bytes[payload + 8] as number,
          bytes[payload + 9] as number,
          bytes[payload + 10] as number,
          bytes[payload + 11] as number,
        );
      }
    }
    if (VISUAL_SAMPLE_ENTRY_TYPES.has(child.type) && found.visual === null) {
      const payload = child.start + child.headerSize;
      if (payload + 28 <= child.start + child.size) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        found.visual = {
          width: view.getUint16(payload + 24),
          height: view.getUint16(payload + 26),
        };
      }
    }
    const descend = ISO_BMFF_CONTAINERS.has(child.type) || child.type === 'stsd';
    if (!descend) {
      continue;
    }
    const payload = child.start + child.headerSize;
    const childEnd = child.start + child.size;
    const innerStart = child.type === 'stsd' ? payload + 8 : payload;
    if (innerStart > childEnd) {
      return false;
    }
    if (!scanTrak(bytes, innerStart, childEnd, found)) {
      return false;
    }
  }
  return true;
}

/**
 * Validate raw video bytes (size + magic). MP4/MOV go through {@link faststartIsoBmff}
 * (`moov` before `mdat` only when remux succeeds; abort cases stay unchanged)
 * and {@link normalizeIsoBmffDisplayMatrix}.
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
  const copy = bytes.slice();
  const remuxed =
    contentType === 'video/mp4' || contentType === 'video/quicktime'
      ? normalizeIsoBmffDisplayMatrix(faststartIsoBmff(copy))
      : copy;
  return { contentType, bytes: remuxed, takenAt: readVideoTakenAt(remuxed) };
}

const MAC_EPOCH_MS = Date.UTC(1904, 0, 1);

/**
 * Read a capture time from an MP4/MOV `mvhd` box.
 *
 * WebM and unrecognized containers return null. The bytes are not modified.
 *
 * @param bytes - Video container bytes.
 * @returns `YYYY-MM-DDTHH:MM:SS+00:00`, or null when the file has no usable time.
 */
export function readVideoTakenAt(bytes: Uint8Array): string | null {
  const box = findIsoBox(bytes, 0, bytes.byteLength, 'mvhd');
  if (box === null) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const payload = box.start + box.headerSize;
  const boxEnd = box.start + box.size;
  if (payload >= boxEnd) {
    return null;
  }
  const version = bytes[payload];
  let seconds: number;
  if (version === 0) {
    if (payload + 8 > boxEnd) {
      return null;
    }
    seconds = view.getUint32(payload + 4);
  } else if (version === 1) {
    if (payload + 12 > boxEnd) {
      return null;
    }
    const raw = view.getBigUint64(payload + 4);
    if (raw > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }
    seconds = Number(raw);
  } else {
    return null;
  }
  if (seconds === 0) {
    return null;
  }
  const ms = MAC_EPOCH_MS + seconds * 1000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const year = date.getUTCFullYear();
  const maxYear = new Date().getUTCFullYear() + 1;
  if (year < 1990 || year > maxYear) {
    return null;
  }
  const part = (value: number): string => String(value).padStart(2, '0');
  return `${year}-${part(date.getUTCMonth() + 1)}-${part(date.getUTCDate())}T${part(date.getUTCHours())}:${part(date.getUTCMinutes())}:${part(date.getUTCSeconds())}+00:00`;
}

/**
 * Seconds from the first mvhd, or null (including WebM).
 *
 * Version 0: timescale at payload+12, duration at payload+16 (uint32).
 * Version 1: timescale at payload+20 (uint32), duration at payload+24 (uint64).
 * Returns the rounded quotient only when that integer is from 1 through 86400.
 *
 * @param bytes - Container bytes. Not modified.
 * @returns Whole seconds, or null when mvhd is missing or unusable.
 */
export function isoBmffDurationSeconds(bytes: Uint8Array): number | null {
  const box = findIsoBox(bytes, 0, bytes.byteLength, 'mvhd');
  if (box === null) {
    return null;
  }
  const payload = box.start + box.headerSize;
  const boxEnd = box.start + box.size;
  if (payload >= boxEnd) {
    return null;
  }
  const version = bytes[payload];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let timescale: number;
  let duration: number;
  if (version === 0) {
    if (payload + 20 > boxEnd) {
      return null;
    }
    timescale = view.getUint32(payload + 12);
    duration = view.getUint32(payload + 16);
  } else if (version === 1) {
    if (payload + 32 > boxEnd) {
      return null;
    }
    timescale = view.getUint32(payload + 20);
    const raw = view.getBigUint64(payload + 24);
    if (raw > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }
    duration = Number(raw);
  } else {
    return null;
  }
  if (timescale === 0 || duration === 0) {
    return null;
  }
  const rounded = Math.round(duration / timescale);
  if (rounded < 1 || rounded > 86400) {
    return null;
  }
  return rounded;
}

function findIsoBox(
  bytes: Uint8Array,
  start: number,
  end: number,
  type: string,
): IsoBmffBox | null {
  let offset = start;
  while (offset + 8 <= end) {
    const box = readIsoBmffBox(bytes, offset, end);
    if (box === null) {
      return null;
    }
    if (box.type === type) {
      return box;
    }
    if (ISO_BMFF_CONTAINERS.has(box.type)) {
      const found = findIsoBox(bytes, box.start + box.headerSize, box.start + box.size, type);
      if (found !== null) {
        return found;
      }
    }
    offset = box.start + box.size;
  }
  return null;
}

/**
 * Write video bytes to `MEDIA_DIR`. Creates the directory when missing.
 * Writes a UUID sibling temp then `rename`s onto the public path so readers
 * never see a partial file.
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
  await fs.mkdir(dir, { recursive: true });
  const dest = videoFilePath(dir, messageId, video.contentType);
  const tempPath = join(dir, `.${basename(dest)}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(tempPath, video.bytes);
  await fs.rename(tempPath, dest);
}

/**
 * Read video bytes, remux for faststart, and rewrite the file when boxes move.
 *
 * Heal writes go to a UUID sibling temp (same directory as `path`) then
 * `rename` onto `path`, so a failed write leaves the original file intact.
 * On write/rename error the remuxed buffer is still returned for this response.
 *
 * @param path - Absolute path on disk.
 * @param io - Disk ops; production omits this and uses `node:fs/promises`.
 * @returns Bytes to serve (moov before mdat, display matrix inside the frame).
 */
export async function readForumVideoBytes(
  path: string,
  io: ForumVideoFs = fs,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(await io.readFile(path));
  const remuxed = faststartIsoBmff(bytes);
  const normalized = normalizeIsoBmffDisplayMatrix(remuxed);
  if (normalized !== bytes) {
    const tempPath = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.tmp`);
    try {
      await io.writeFile(tempPath, normalized);
      await io.rename(tempPath, path);
    } catch {
      try {
        await io.unlink(tempPath);
      } catch {
        /* best-effort cleanup of a partial temp */
      }
    }
  }
  return normalized;
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
    await fs.unlink(videoFilePath(resolveMediaDir(env), messageId, mime));
  } catch {
    /* missing file is fine */
  }
}

/**
 * Result of {@link parseBytesRange} (RFC 7233 single `bytes` range).
 *
 * - `full` — ignore Range and send the whole file (200).
 * - `partial` — inclusive `start`/`end` for a 206 slice.
 * - `unsatisfiable` — well-formed but `start >= size` (416).
 */
export type ParsedBytesRange =
  { type: 'full' } | { type: 'partial'; start: number; end: number } | { type: 'unsatisfiable' };

/**
 * Parse a single `bytes=start-end` Range header (RFC 7233).
 *
 * Missing, blank, or malformed headers (wrong unit, empty bounds, inverted
 * range, `bytes=-0`, or any range when `size === 0`) become `{ type: 'full' }`.
 * A well-formed range whose start is past the last byte becomes
 * `{ type: 'unsatisfiable' }`.
 *
 * @param header - Raw Range header, or undefined.
 * @param size - File size in bytes.
 * @returns Discriminated parse result for 200 / 206 / 416.
 */
export function parseBytesRange(header: string | undefined, size: number): ParsedBytesRange {
  if (header === undefined || header.trim() === '') {
    return { type: 'full' };
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null || size <= 0) {
    return { type: 'full' };
  }
  /* v8 ignore next 2 -- capturing groups are always strings */
  const startRaw = match[1] === undefined ? '' : match[1];
  const endRaw = match[2] === undefined ? '' : match[2];
  if (startRaw === '' && endRaw === '') {
    return { type: 'full' };
  }
  if (startRaw === '') {
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return { type: 'full' };
    }
    const start = Math.max(0, size - suffix);
    return { type: 'partial', start, end: size - 1 };
  }
  const start = Number(startRaw);
  /* v8 ignore next 3 -- \d* from the regex is always a finite non-negative */
  if (!Number.isFinite(start) || start < 0) {
    return { type: 'full' };
  }
  if (start >= size) {
    return { type: 'unsatisfiable' };
  }
  const end = endRaw === '' ? size - 1 : Number(endRaw);
  if (!Number.isFinite(end) || start > end) {
    return { type: 'full' };
  }
  return { type: 'partial', start, end: Math.min(end, size - 1) };
}
