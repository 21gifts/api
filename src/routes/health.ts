import { Hono } from 'hono';
import { SERVICE_NAME, SERVICE_VERSION } from '@/lib/meta';

/**
 * Shape returned by `GET /healthz`.
 *
 * Consumers (Uptime Kuma, container orchestrators, CI smoke tests) should
 * treat HTTP 200 and `status === 'ok'` as the liveness signal; anything else
 * counts as unhealthy.
 */
export interface HealthResponse {
  status: 'ok';
  service: typeof SERVICE_NAME;
  version: string;
}

/**
 * `GET /healthz` — liveness probe.
 *
 * Returns immediately with no I/O so probes can run aggressively without
 * load on downstream dependencies. A more thorough `/readyz` (checking
 * relay connection, DB, etc.) will land alongside those subsystems.
 */
export const healthRoute = new Hono().get('/', (c) => {
  const body: HealthResponse = {
    status: 'ok',
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
  };
  return c.json(body, 200);
});
