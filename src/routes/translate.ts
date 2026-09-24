import { Hono } from 'hono';
import { resolveTranslateUpstream } from '@/lib/translate-config';

/** Dependencies for {@link translateRoutes}. */
export interface TranslateRouteDeps {
  /** Process env (injected so tests need not mutate it). */
  env: Record<string, string | undefined>;
}

/**
 * Public `GET /translate` availability.
 *
 * @param deps - Env slice.
 * @returns Hono app with `GET /`.
 */
export function translateRoutes(deps: TranslateRouteDeps): Hono {
  return new Hono().get('/', (c) => {
    return c.json({ available: resolveTranslateUpstream(deps.env) !== null }, 200);
  });
}
