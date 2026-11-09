/**
 * Auth and gift-invoice configuration.
 *
 * Configuration is read from the environment only (no config files, per
 * CONTRIBUTING). `WEBAUTHN_RP_ID` pins the passkey relying party (missing →
 * passkey routes 500; the process still boots).
 * The in-memory LUD-16 metadata cache TTL (`LN_ADDRESS_CACHE_TTL_MS`) is a
 * code constant, not an environment variable. `LNURL_SERVER_URL` (with `PUBLIC_BASE_URL`) enables
 * the self-hosted LNURL server; unset or blank leaves that feature off.
 * `LNURL_ZAP_NSEC_HEX` (with `SPARK_OPERATOR_URL`) additionally enables free
 * in-app payments between members with a verified wallet.
 */

/** Lifetime of an unclaimed passkey ceremony challenge, in milliseconds. */
export const CHALLENGE_TTL_MS = 10 * 60 * 1000;

/** Lifetime of an issued session token, in milliseconds. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** In-memory TTL for a successful LUD-16 metadata resolve, in milliseconds. */
export const LN_ADDRESS_CACHE_TTL_MS = 5 * 60 * 1000;

/** Minimum gift invoice amount, in millisatoshis (1 sat). */
export const GIFT_INVOICE_MIN_MSAT = 1_000;

/** Maximum gift invoice amount, in millisatoshis (10 million sats). */
export const GIFT_INVOICE_MAX_MSAT = 10_000_000_000;

/** Lifetime of an unpaid gift invoice awaiting proof, in milliseconds. */
export const GIFT_INVOICE_TTL_MS = 15 * 60 * 1000;

/**
 * Browser origins allowed to call the api by default — the 21.gifts apex
 * (prd, staging, dev), transitional app-subdomain aliases, and local dev. These are
 * public, fixed hostnames, not secrets; `CORS_ALLOWED_ORIGINS` overrides them
 * when a different surface needs cross-origin access.
 */
const DEFAULT_ALLOWED_ORIGINS = [
  'https://21.gifts',
  'https://dev.21.gifts',
  'https://staging.21.gifts',
  'https://app.21.gifts',
  'https://dev-app.21.gifts',
  'https://staging-app.21.gifts',
  'http://localhost:3000',
];

/**
 * Resolve the browser origins that CORS should allow.
 *
 * @param env - Environment slice (injected so tests need not mutate the real env).
 * @returns The origins from `CORS_ALLOWED_ORIGINS` (comma-separated) when set,
 * otherwise the default 21.gifts app surfaces.
 */
export function resolveAllowedOrigins(env: Record<string, string | undefined>): string[] {
  const raw = env['CORS_ALLOWED_ORIGINS'];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_ALLOWED_ORIGINS;
  }
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
}

/** RP IDs the process will mint credentials under. Anything else is `null`. */
const WEBAUTHN_RP_IDS = new Set(['21.gifts', 'dev.21.gifts', 'staging.21.gifts', 'localhost']);

/**
 * Normalise `WEBAUTHN_RP_ID`. A missing, blank, or unknown value yields
 * `null` — passkey routes fail closed rather than minting under a surprise RP.
 *
 * @param raw - The raw env value, or `undefined` when unset.
 * @returns The trimmed RP ID, or `null`.
 */
export function normalizeWebAuthnRpId(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') {
    return null;
  }
  const rpId = raw.trim();
  return WEBAUTHN_RP_IDS.has(rpId) ? rpId : null;
}

/**
 * Extra hostname label allowed in front of the RP ID (transitional `app.*`
 * alias). `dev.21.gifts` must not match RP ID `21.gifts`.
 */
const WEBAUTHN_RP_EXTRA_LABELS = new Set(['app']);

/**
 * Origins whose hostname is the RP ID, or `app.<rpId>`.
 *
 * `https://app.21.gifts` matches RP ID `21.gifts`; `https://dev.21.gifts` and
 * `http://localhost:3000` do not. Invalid origin strings are dropped.
 *
 * @param rpId - Configured WebAuthn RP ID.
 * @param allowedOrigins - CORS allowlist (or an override).
 * @returns Origins that may complete a ceremony for `rpId`.
 */
export function expectedOriginsForRpId(rpId: string, allowedOrigins: string[]): string[] {
  return allowedOrigins.filter((origin) => {
    try {
      const host = new URL(origin).hostname;
      if (host === rpId) {
        return true;
      }
      if (!host.endsWith(`.${rpId}`)) {
        return false;
      }
      const prefix = host.slice(0, -(rpId.length + 1));
      return WEBAUTHN_RP_EXTRA_LABELS.has(prefix);
    } catch {
      return false;
    }
  });
}

/**
 * Resolved WebAuthn relying-party config used by the passkey routes.
 */
export interface WebAuthnRuntimeConfig {
  /** RP ID presented to authenticators. */
  rpId: string;
  /** Human-readable RP name. */
  rpName: string;
  /** Origins allowed to finish a ceremony for this RP ID. */
  expectedOrigins: string[];
}

/**
 * Resolve WebAuthn runtime config from the environment and CORS origins.
 *
 * @param env - Environment slice (injected so tests need not mutate process env).
 * @param allowedOrigins - Browser origins CORS already allows.
 * @returns The config, or `null` when the RP ID is missing or no origin matches it.
 */
export function resolveWebAuthnConfig(
  env: Record<string, string | undefined>,
  allowedOrigins: string[],
): WebAuthnRuntimeConfig | null {
  const rpId = normalizeWebAuthnRpId(env['WEBAUTHN_RP_ID']);
  if (rpId === null) {
    return null;
  }
  const expectedOrigins = expectedOriginsForRpId(rpId, allowedOrigins);
  if (expectedOrigins.length === 0) {
    return null;
  }
  const rpNameRaw = env['WEBAUTHN_RP_NAME'];
  const rpName = rpNameRaw === undefined || rpNameRaw.trim() === '' ? '21.gifts' : rpNameRaw.trim();
  return { rpId, rpName, expectedOrigins };
}

/** Resolved configuration of the self-hosted LNURL server. */
export interface LnurlServerConfig {
  /** Base URL of the LNURL server, without a trailing slash. */
  baseUrl: string;
  /** `PUBLIC_BASE_URL` without a trailing slash; prefix of the pay callback. */
  publicBaseUrl: string;
  /** Host (with port when present) of `PUBLIC_BASE_URL`; sent as `Host` on every call. */
  host: string;
}

/**
 * Trim and remove at most one trailing `/`.
 *
 * @param raw - Raw env value.
 * @returns Normalised string (may be empty).
 */
function trimBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

/**
 * Whether `value` parses as an absolute `http:` or `https:` URL.
 *
 * @param value - Candidate base URL (already trimmed, no trailing slash).
 * @returns The parsed URL, or `null`.
 */
function parseHttpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Resolve the self-hosted LNURL server configuration from the environment.
 *
 * Returns `null` when `LNURL_SERVER_URL` is unset or blank, when either URL
 * fails to parse, or when either protocol is not `http:` / `https:`.
 *
 * @param env - Environment slice (injected so tests need not mutate process env).
 * @returns The resolved config, or `null` when the feature is off.
 */
export function resolveLnurlServerConfig(
  env: Record<string, string | undefined>,
): LnurlServerConfig | null {
  const rawServer = env['LNURL_SERVER_URL'];
  if (rawServer === undefined || rawServer.trim() === '') {
    return null;
  }
  const baseUrl = trimBaseUrl(rawServer);
  const rawPublic = env['PUBLIC_BASE_URL'];
  if (rawPublic === undefined) {
    return null;
  }
  const publicBaseUrl = trimBaseUrl(rawPublic);
  const serverUrl = parseHttpUrl(baseUrl);
  const publicUrl = parseHttpUrl(publicBaseUrl);
  if (serverUrl === null || publicUrl === null) {
    return null;
  }
  return {
    baseUrl,
    publicBaseUrl,
    host: publicUrl.host,
  };
}

/** Spark coordinator used when `SPARK_OPERATOR_URL` is unset or blank. */
export const DEFAULT_SPARK_OPERATOR_URL = 'https://0.spark.lightspark.com';

/** Resolved configuration of free in-app payments between members. */
export interface FreePaymentsConfig {
  /** 32-byte server secret from `LNURL_ZAP_NSEC_HEX`; root of the per-member receipt keys. */
  zapNsec: Uint8Array;
  /** Spark coordinator base URL, with at most one trailing slash removed. */
  operatorUrl: string;
}

/**
 * Resolve the free in-app payments configuration from the environment.
 *
 * Returns `null` (feature off) when `LNURL_ZAP_NSEC_HEX` is unset, blank, or
 * not 64 hex characters, or when `SPARK_OPERATOR_URL` is set to something
 * other than an `http:` / `https:` URL. Unset or blank `SPARK_OPERATOR_URL`
 * uses {@link DEFAULT_SPARK_OPERATOR_URL}. The feature also needs
 * {@link resolveLnurlServerConfig}; callers check both.
 *
 * @param env - Environment slice (injected so tests need not mutate process env).
 * @returns The resolved config, or `null`.
 */
export function resolveFreePaymentsConfig(
  env: Record<string, string | undefined>,
): FreePaymentsConfig | null {
  const nsecHex = (env['LNURL_ZAP_NSEC_HEX'] ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(nsecHex)) {
    return null;
  }
  const rawOperator = env['SPARK_OPERATOR_URL'];
  const operatorUrl =
    rawOperator === undefined || rawOperator.trim() === ''
      ? DEFAULT_SPARK_OPERATOR_URL
      : trimBaseUrl(rawOperator);
  if (parseHttpUrl(operatorUrl) === null) {
    return null;
  }
  return { zapNsec: Uint8Array.from(Buffer.from(nsecHex, 'hex')), operatorUrl };
}

/** Resolved configuration of the shop payment in USDT and USDC (`docs/shop-stablecoin-payment.md`). */
export interface ShopPaymentConfig {
  /** Orchestra origin (`ORCHESTRA_BASE_URL`), absolute `https`, no path, no trailing slash. */
  orchestraBaseUrl: string;
  /** Orchestra server key (`ORCHESTRA_API_KEY`, `fn_…`). Never logged. */
  orchestraApiKey: string;
  /** JSON-RPC URL per EVM chain id (`SHOP_EVM_RPC`). Never logged. */
  evmRpc: ReadonlyMap<number, string>;
  /** Refund address sent on every quote (`SHOP_REFUND_ADDRESS`), lowercase `0x` + 40 hex. */
  refundAddress: string;
}

/**
 * Whether `value` is an absolute `https:` URL without user info.
 *
 * @param value - Candidate URL.
 * @returns The parsed URL, or `null`.
 */
function parseHttpsUrl(value: string): URL | null {
  const parsed = parseHttpUrl(value);
  if (
    parsed === null ||
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    return null;
  }
  return parsed;
}

/**
 * Parse `SHOP_EVM_RPC`: a JSON object from decimal chain id (no sign, no
 * leading zero) to an absolute `https` URL.
 *
 * @param raw - Raw env value.
 * @returns The endpoints by chain id, or `null` when the value is missing,
 *   blank, not such an object, or has no entry.
 */
function parseEvmRpc(raw: string | undefined): ReadonlyMap<number, string> | null {
  if (raw === undefined || raw.trim() === '') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const endpoints = new Map<number, string>();
  for (const [key, value] of Object.entries(parsed)) {
    const chainId = Number(key);
    if (!/^[1-9][0-9]*$/.test(key) || !Number.isSafeInteger(chainId)) {
      return null;
    }
    if (typeof value !== 'string' || parseHttpsUrl(value.trim()) === null) {
      return null;
    }
    endpoints.set(chainId, value.trim());
  }
  return endpoints.size === 0 ? null : endpoints;
}

/**
 * Resolve the shop payment configuration from the environment.
 *
 * Returns `null`, so no stablecoin is offered and the process still boots,
 * when any of the four values is missing or invalid: `ORCHESTRA_BASE_URL`
 * must be an absolute `https` origin without path, query, or user info;
 * `ORCHESTRA_API_KEY` must be a server key (`fn_…`; a client key `fnp_…` is
 * refused); `SHOP_EVM_RPC` must be a non-empty JSON object from decimal chain
 * id to an absolute `https` URL; `SHOP_REFUND_ADDRESS` must be `0x` and 40
 * hexadecimal characters. Never logs a value.
 *
 * @param env - Environment slice.
 * @returns The resolved config, or `null` when the feature is off.
 */
export function resolveShopPaymentConfig(
  env: Record<string, string | undefined>,
): ShopPaymentConfig | null {
  const baseRaw = trimBaseUrl(env['ORCHESTRA_BASE_URL'] ?? '');
  const base = parseHttpsUrl(baseRaw);
  if (base === null || base.pathname !== '/' || base.search !== '' || base.hash !== '') {
    return null;
  }
  const apiKey = (env['ORCHESTRA_API_KEY'] ?? '').trim();
  if (!apiKey.startsWith('fn_') || apiKey.length <= 'fn_'.length) {
    return null;
  }
  const evmRpc = parseEvmRpc(env['SHOP_EVM_RPC']);
  if (evmRpc === null) {
    return null;
  }
  const refund = (env['SHOP_REFUND_ADDRESS'] ?? '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(refund)) {
    return null;
  }
  return {
    orchestraBaseUrl: base.origin,
    orchestraApiKey: apiKey,
    evmRpc,
    refundAddress: refund.toLowerCase(),
  };
}
