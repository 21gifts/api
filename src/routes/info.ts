import { Hono } from 'hono';
import { SERVICE_NAME, SERVICE_VERSION, SERVICE_DESCRIPTION, SERVICE_REPO_URL } from '@/lib/meta';

/**
 * Shape returned by `GET /info`.
 *
 * Surfaces service identity in a structured way so the app (and other
 * clients) can render version + provenance without needing to look up
 * environment-specific metadata elsewhere.
 */
export interface InfoResponse {
  service: typeof SERVICE_NAME;
  version: string;
  description: string;
  repository: string;
}

/**
 * `GET /info` — service identity and version.
 *
 * Stable, no-auth endpoint. Safe to consume from anywhere; should not leak
 * runtime configuration (env values, secrets, host names). Capabilities and
 * environment-flavoured config belong in a separate endpoint added later.
 */
export const infoRoute = new Hono().get('/', (c) => {
  const body: InfoResponse = {
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    description: SERVICE_DESCRIPTION,
    repository: SERVICE_REPO_URL,
  };
  return c.json(body, 200);
});
