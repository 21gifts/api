/**
 * Optional Cloudflare cache purge for public forum media URLs.
 *
 * Unset zone/token skips purge. Missing config never fails boot.
 */

import type { FetchFn } from '@/lib/lnurlp';
import type { MessageRow } from '@/lib/message';

/** Cloudflare files-purge request cap. */
const PURGE_FILES_CHUNK = 30;

/** Zone + API token when both env values are non-empty after trim. */
export interface CloudflarePurgeConfig {
  /** Cloudflare zone id. */
  zoneId: string;
  /** API token (never log). */
  token: string;
}

/**
 * Resolve optional Cloudflare purge credentials.
 *
 * Both `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_API_TOKEN` must be non-empty
 * after trim; otherwise `null`. Does not throw.
 *
 * @param env - Environment slice.
 * @returns Config, or `null` when either value is missing/blank.
 */
export function resolveCloudflarePurgeConfig(
  env: Record<string, string | undefined>,
): CloudflarePurgeConfig | null {
  const zoneId = (env['CLOUDFLARE_ZONE_ID'] ?? '').trim();
  const token = (env['CLOUDFLARE_API_TOKEN'] ?? '').trim();
  if (zoneId === '' || token === '') {
    return null;
  }
  return { zoneId, token };
}

/**
 * Public media URLs to purge for one forum row.
 *
 * Empty `apiBase` → no URLs. Trailing slash on `apiBase` is stripped.
 * Photo 0 (when `hasPhoto` or `photoCount > 0`) includes the extensionless
 * `/photo` path plus `.jpg` / `.jpeg` / `.png` / `.webp`. Extra stills
 * (`photoCount >= 2`) are indices `1 .. photoCount-1` with those four
 * extensions. Video adds `.mp4` / `.webm` / `.mov`. Dedupe keeps first-seen
 * order.
 *
 * @param apiBase - Public API origin (already resolved).
 * @param row - Forum row (photo/video flags; bytes never read).
 * @returns Absolute URLs, or `[]`.
 */
export function forumMediaPurgeUrls(apiBase: string, row: MessageRow): string[] {
  const base = apiBase.replace(/\/$/, '');
  if (base === '') {
    return [];
  }
  const urls: string[] = [];
  const seen = new Set<string>();
  const add = (path: string): void => {
    const url = `${base}${path}`;
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  };
  const photoCount = row.photoCount ?? 0;
  if (row.hasPhoto || photoCount > 0) {
    add(`/messages/${row.id}/photo`);
    add(`/messages/${row.id}/photo.jpg`);
    add(`/messages/${row.id}/photo.jpeg`);
    add(`/messages/${row.id}/photo.png`);
    add(`/messages/${row.id}/photo.webp`);
  }
  if (photoCount >= 2) {
    for (let n = 1; n <= photoCount - 1; n += 1) {
      add(`/messages/${row.id}/photo/${n}.jpg`);
      add(`/messages/${row.id}/photo/${n}.jpeg`);
      add(`/messages/${row.id}/photo/${n}.png`);
      add(`/messages/${row.id}/photo/${n}.webp`);
    }
  }
  if (row.hasVideo) {
    add(`/messages/${row.id}/video.mp4`);
    add(`/messages/${row.id}/video.webm`);
    add(`/messages/${row.id}/video.mov`);
  }
  return urls;
}

/**
 * POST Cloudflare `purge_cache` for `urls` in chunks of 30.
 *
 * No-op when `urls` is empty. Throws a generic error when HTTP is not 200
 * or JSON `success` is not `true`. Never includes the token in the message.
 *
 * @param fetchImpl - Injected `fetch`.
 * @param config - Zone id and API token.
 * @param urls - Absolute file URLs to purge.
 * @returns Resolves when every chunk succeeds.
 */
export async function purgeCloudflareFiles(
  fetchImpl: FetchFn,
  config: CloudflarePurgeConfig,
  urls: readonly string[],
): Promise<void> {
  if (urls.length === 0) {
    return;
  }
  for (let offset = 0; offset < urls.length; offset += PURGE_FILES_CHUNK) {
    const chunk = urls.slice(offset, offset + PURGE_FILES_CHUNK);
    const response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/zones/${config.zoneId}/purge_cache`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ files: chunk }),
      },
    );
    if (response.status !== 200) {
      throw new Error('Cloudflare purge failed');
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error('Cloudflare purge failed');
    }
    if (
      typeof body !== 'object' ||
      body === null ||
      (body as { success?: unknown }).success !== true
    ) {
      throw new Error('Cloudflare purge failed');
    }
  }
}
