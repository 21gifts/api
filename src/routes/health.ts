import { Hono } from 'hono';
import {
  resolveFreePaymentsConfig,
  resolveLnurlServerConfig,
  resolveWebAuthnConfig,
} from '@/lib/config';
import { SERVICE_NAME, SERVICE_VERSION } from '@/lib/meta';

/**
 * Which in-app wallet features this process has configured.
 *
 * Only booleans: no value, key, or URL from the environment is exposed.
 */
export interface WalletFeatures {
  /** `LNURL_SERVER_URL` and `PUBLIC_BASE_URL` resolve through `resolveLnurlServerConfig`. */
  lnurlServer: boolean;
  /** `LNURL_ZAP_NSEC_HEX` (with a usable `SPARK_OPERATOR_URL`) resolves through `resolveFreePaymentsConfig`. */
  zapSigning: boolean;
  /** Both of the above: free in-app payments between members are on. */
  freePayments: boolean;
  /**
   * `WEBAUTHN_RP_ID` and the CORS origins resolve through `resolveWebAuthnConfig`, the
   * same check the passkey routes make; the wallet phrase is bound to the passkey.
   */
  passkey: boolean;
}

/**
 * Shape returned by `GET /healthz`.
 *
 * Consumers (Uptime Kuma, container orchestrators, CI smoke tests) should
 * treat HTTP 200 and `status === 'ok'` as the liveness signal; anything else
 * counts as unhealthy. `wallet` is informational and never changes the status.
 */
export interface HealthResponse {
  status: 'ok';
  service: typeof SERVICE_NAME;
  version: string;
  wallet: WalletFeatures;
}

/**
 * Resolve the wallet feature flags once from the environment.
 *
 * Uses the same resolvers that decide whether the wallet routes are mounted
 * or the passkey routes answer, so the flags match what the process serves.
 * Every input is fixed at boot, so no request is needed.
 *
 * @param env - Environment slice (the same one `createApp` mounts routes from).
 * @param webAuthnRpId - Raw WebAuthn RP ID the auth routes use.
 * @param allowedOrigins - CORS origins the auth routes use.
 * @returns The wallet feature flags.
 */
export function walletFeatures(
  env: Record<string, string | undefined>,
  webAuthnRpId: string | undefined,
  allowedOrigins: string[],
): WalletFeatures {
  const lnurlServer = resolveLnurlServerConfig(env) !== null;
  const zapSigning = resolveFreePaymentsConfig(env) !== null;
  return {
    lnurlServer,
    zapSigning,
    freePayments: lnurlServer && zapSigning,
    passkey: resolveWebAuthnConfig({ WEBAUTHN_RP_ID: webAuthnRpId }, allowedOrigins) !== null,
  };
}

/**
 * `GET /healthz` — liveness probe.
 *
 * Returns immediately with no I/O so probes can run aggressively without
 * load on downstream dependencies. The wallet flags are fixed at boot.
 *
 * @param wallet - Wallet feature flags from {@link walletFeatures}.
 * @returns A Hono app answering `GET /`.
 */
export function healthRoute(wallet: WalletFeatures): Hono {
  const body: HealthResponse = {
    status: 'ok',
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    wallet: { ...wallet },
  };
  return new Hono().get('/', (c) => c.json(body, 200));
}
