import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  brandRoutes,
  readPublicBrandFile,
  type BrandFileName,
  type BrandReader,
} from '@/routes/brand';

const PATHS: BrandFileName[] = ['favicon.ico', 'favicon.svg', 'apple-touch-icon.png'];

const CONTENT_TYPES: Record<BrandFileName, RegExp> = {
  'favicon.ico': /image\/x-icon/,
  'favicon.svg': /image\/svg\+xml/,
  'apple-touch-icon.png': /image\/png/,
};

describe('brandRoutes', () => {
  it('returns 200 with correct Content-Type, body, and Cache-Control for each path', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const read: BrandReader = async () => bytes;
    const app = brandRoutes({ read });

    for (const name of PATHS) {
      const res = await app.request(`/${name}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(CONTENT_TYPES[name]);
      const cache = res.headers.get('cache-control') ?? '';
      expect(cache).toMatch(/public/);
      expect(cache).toMatch(/max-age=86400/);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    }
  });

  it('returns 404 with empty body when the reader returns null', async () => {
    const read: BrandReader = async () => null;
    const app = brandRoutes({ read });

    for (const name of PATHS) {
      const res = await app.request(`/${name}`);
      expect(res.status).toBe(404);
      expect((await res.arrayBuffer()).byteLength).toBe(0);
    }
  });
});

describe('readPublicBrandFile', () => {
  it('returns a Windows ICO with RGBA PNG payloads for public/favicon.ico', async () => {
    const bytes = await readPublicBrandFile('favicon.ico');
    expect(bytes).not.toBeNull();
    expect(bytes?.byteLength ?? 0).toBeGreaterThan(0);
    expect(Array.from(bytes?.slice(0, 4) ?? [])).toEqual([0, 0, 1, 0]);
    const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const hay = bytes ?? new Uint8Array();
    let pngAt = -1;
    for (let i = 0; i <= hay.length - pngMagic.length; i += 1) {
      if (pngMagic.every((b, j) => hay[i + j] === b)) {
        pngAt = i;
        break;
      }
    }
    expect(pngAt).toBeGreaterThanOrEqual(0);
    // IHDR: signature(8) + len(4) + 'IHDR'(4) + width(4) + height(4) + bitDepth(1) + colorType(1)
    expect(hay[pngAt + 24]).toBe(8);
    expect(hay[pngAt + 25]).toBe(6);
  });

  it('returns null when the file is missing', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'brand-missing-'));
    try {
      const bytes = await readPublicBrandFile('favicon.ico', emptyDir);
      expect(bytes).toBeNull();
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
