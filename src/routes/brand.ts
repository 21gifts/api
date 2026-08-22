import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';

/** Brand mark filenames served from `public/` at the origin root. */
export type BrandFileName = 'favicon.ico' | 'favicon.svg' | 'apple-touch-icon.png';

/**
 * Returns file bytes for a brand mark, or `null` if the file is missing.
 *
 * @param name - Brand file under `public/`.
 * @returns File bytes, or `null` when absent.
 */
export type BrandReader = (name: BrandFileName) => Promise<Uint8Array | null>;

/**
 * Default reader: `public/<name>` relative to `process.cwd()`.
 * Missing file → `null` (does not throw).
 *
 * @param name - Brand file under `public/`.
 * @returns File bytes, or `null` when the file cannot be read.
 */
export async function readPublicBrandFile(name: BrandFileName): Promise<Uint8Array | null> {
  try {
    const buf = await readFile(join(process.cwd(), 'public', name));
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/** Collaborators the brand routes need. */
export interface BrandRouteDeps {
  /** Reads brand file bytes (default: {@link readPublicBrandFile}). */
  read: BrandReader;
}

const CONTENT_TYPES: Record<BrandFileName, string> = {
  'favicon.ico': 'image/x-icon',
  'favicon.svg': 'image/svg+xml',
  'apple-touch-icon.png': 'image/png',
};

const CACHE_CONTROL = 'public, max-age=86400';

/**
 * Reads one brand file and turns it into an HTTP response.
 *
 * @param deps - Injected brand file reader.
 * @param name - File under `public/`.
 * @returns `200` with bytes, or `404` empty body.
 */
async function sendBrand(deps: BrandRouteDeps, name: BrandFileName): Promise<Response> {
  const bytes = await deps.read(name);
  if (bytes === null) {
    return new Response(null, { status: 404 });
  }
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': CONTENT_TYPES[name],
      'Cache-Control': CACHE_CONTROL,
    },
  });
}

/**
 * Brand mark routes at the origin root.
 *
 * - `GET /favicon.ico` → `200` `image/x-icon`
 * - `GET /favicon.svg` → `200` `image/svg+xml`
 * - `GET /apple-touch-icon.png` → `200` `image/png`
 *
 * Missing bytes → `404` empty body. Successful responses set
 * `Cache-Control: public, max-age=86400`.
 *
 * @param deps - Injected brand file reader.
 * @returns A Hono app with the three GET handlers.
 */
export function brandRoutes(deps: BrandRouteDeps): Hono {
  const app = new Hono();
  app.get('/favicon.ico', () => sendBrand(deps, 'favicon.ico'));
  app.get('/favicon.svg', () => sendBrand(deps, 'favicon.svg'));
  app.get('/apple-touch-icon.png', () => sendBrand(deps, 'apple-touch-icon.png'));
  return app;
}
