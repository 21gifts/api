/**
 * Best-effort OpenCryptoPay map ping after a point-of-sale charge.
 *
 * Tells the map that live `#21GiftsShop` notes assigned to the till account
 * had a transaction. Failures are logged and never thrown.
 */

import { errorLogFields, logEvent } from '@/lib/log';
import type { MapFetch } from '@/lib/ocp-place';

/** HTTP fetch and credentials for `POST /map/places/transactions`. */
export type ActivityPing = {
  baseUrl: string;
  token: string;
  fetchImpl: MapFetch;
};

/** Fixed origin for till activity pings. */
const SHOP_ORIGIN = '21gifts';

/**
 * Build a map activity ping from the environment.
 *
 * Ignores `SHOP_PLACE_PUSH_ENABLED`; a blank URL or token means no ping.
 *
 * @param env - `OCP_MAP_BASE_URL` and `OCP_PLACE_INGEST_TOKEN`.
 * @param fetchImpl - HTTP fetch.
 * @returns The ping target, or `undefined`.
 */
export function resolveActivityPing(
  env: Record<string, string | undefined>,
  fetchImpl: MapFetch,
): ActivityPing | undefined {
  const rawUrl = env['OCP_MAP_BASE_URL'];
  const rawToken = env['OCP_PLACE_INGEST_TOKEN'];
  if (rawUrl === undefined || rawUrl.trim() === '') {
    return undefined;
  }
  if (rawToken === undefined || rawToken.trim() === '') {
    return undefined;
  }
  return {
    baseUrl: rawUrl.trim().replace(/\/+$/u, ''),
    token: rawToken.trim(),
    fetchImpl,
  };
}

/**
 * Allowlisted fields for a thrown map activity error, including a syscall code on `cause`.
 *
 * @param error - Thrown value.
 * @returns Fields for `ocp.activity.failed`; empty when nothing is allowlisted.
 */
function mapPlacesCatchFields(error: unknown): ReturnType<typeof errorLogFields> {
  const outer = errorLogFields(error);
  if (outer['code'] !== undefined || outer['errno'] !== undefined) {
    return outer;
  }
  if (!(error instanceof Error) || error.cause === null || error.cause === undefined) {
    return outer;
  }
  const cause = errorLogFields(error.cause);
  const fields: { [key: string]: string | number | boolean } = { ...outer };
  if (cause['code'] !== undefined) {
    fields['code'] = cause['code'];
  }
  if (cause['errno'] !== undefined) {
    fields['errno'] = cause['errno'];
  }
  return fields;
}

/**
 * Log `ocp.activity.failed` for a thrown map ping or shop-note list.
 *
 * Uses allowlisted fields only. Empty allowlist logs the event with no second
 * argument. Never logs the message, the address, or the bearer.
 *
 * @param error - Thrown value.
 * @returns void
 */
export function logActivityFailure(error: unknown): void {
  const fields = mapPlacesCatchFields(error);
  if (Object.keys(fields).length === 0) {
    logEvent('ocp.activity.failed');
  } else {
    logEvent('ocp.activity.failed', fields);
  }
}

/**
 * Unique non-empty ids in input order (first occurrence wins).
 *
 * Empty means `=== ''` only; ids are not trimmed.
 *
 * @param externalIds - Shop note ids, possibly duplicated or empty.
 * @returns Deduped ids.
 */
function uniqueExternalIds(externalIds: readonly string[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of externalIds) {
    if (id === '' || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * POST each unique shop note id to the OpenCryptoPay map.
 *
 * No-op when `ping` is undefined or no ids remain. Sequential; never throws.
 * A failure does not skip later ids. Non-2xx logs only numeric `status`.
 * A thrown fetch logs through {@link logActivityFailure}. Each request uses
 * `AbortSignal.timeout(5000)`. The response body is not read.
 *
 * @param ping - Configured map target, or `undefined`.
 * @param externalIds - Shop note ids (`externalId`).
 * @param occurredAt - ISO-8601 instant of the stored charge.
 * @returns void
 */
export async function pingShopActivity(
  ping: ActivityPing | undefined,
  externalIds: readonly string[],
  occurredAt: string,
): Promise<void> {
  if (ping === undefined) {
    return;
  }
  const ids = uniqueExternalIds(externalIds);
  if (ids.length === 0) {
    return;
  }
  for (const externalId of ids) {
    try {
      const response = await ping.fetchImpl(`${ping.baseUrl}/map/places/transactions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ping.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          origin: SHOP_ORIGIN,
          externalId,
          occurredAt,
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        logEvent('ocp.activity.failed', { status: response.status });
      }
    } catch (error) {
      logActivityFailure(error);
    }
  }
}
