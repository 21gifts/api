import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  API_PORT,
  CONTROL_URL,
  DEBUG_TOKEN,
  LNURL_PORT,
  ORCHESTRA_API_KEY,
  ORCHESTRA_PORT,
  PUBLIC_BASE_URL,
  REFUND_ADDRESS,
  RPC_PORTS,
  WEBAUTHN_ORIGIN,
} from './e2e/shop-payment/stand-ins/ports';

/**
 * HTTP end-to-end tests against `bun src/index.ts` (request-only; no browser).
 * Docker runs the compiled `dist/index.js`; locally and in CI this boots source.
 *
 * Two projects:
 * - `default`: `e2e/*.spec.ts` against the default boot on :3000, where every
 *   optional service (LNURL server, Orchestra, RPC, database, …) is pinned off.
 * - `shop-payment`: `e2e/shop-payment/*.spec.ts` against a second api on
 *   :3411 wired to the stand-ins of `e2e/shop-payment/stand-ins/server.ts`
 *   (`docs/shop-stablecoin-payment.md`, Implementation › Tests).
 *
 * `webServer` is global in Playwright, so the servers of a project start only
 * when that project runs: `--project=default` starts only :3000,
 * `--project=shop-payment` only the stand-ins and :3411, and a run without
 * `--project` starts all of them.
 */

/** Projects named on the command line (`--project=x` or `--project x`), or all. */
function selectedProjects(): Set<string> {
  const names = new Set<string>();
  const argv = process.argv;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg.startsWith('--project=')) {
      names.add(arg.slice('--project='.length));
    } else if (arg === '--project' && argv[i + 1] !== undefined) {
      names.add(argv[i + 1] ?? '');
      i += 1;
    }
  }
  return names.size === 0 ? new Set(['default', 'shop-payment']) : names;
}

const selected = selectedProjects();
const runDefault = selected.has('default');
const runShop = selected.has('shop-payment');

/** Optional services the default boot pins off (shared by both api boots). */
const PINNED_OFF = {
  LNURL_ZAP_NSEC_HEX: '',
  SPARK_OPERATOR_URL: '',
  TEST_INVOICE_BURST_CAP: '',
  TEST_INVOICE_HOUR_CAP: '',
  DATABASE_URL: '',
  NOSTR_NSEC_KEK: '',
  NOSTR_PUBLISH: '',
  NOSTR_PUBLISH_PUBLIC: '',
  NOSTR_RELAY_URL: '',
  NOSTR_RELAY_SPACE: '',
  NOSTR_RELAY_PUBLIC: '',
  SPEND_API_TOKEN: '',
  VAPID_PUBLIC_KEY: '',
  VAPID_PRIVATE_KEY: '',
  VAPID_SUBJECT: '',
  TRANSLATE_URL: '',
  TRANSLATE_API_KEY: '',
  OCP_MAP_BASE_URL: '',
  OCP_PLACE_INGEST_TOKEN: '',
  LOGINS_OPEN_DEFAULT: '',
  APP_BUILD_REQUIRED: '',
  // Refused port: GET /fx/spot stays the empty result, independent of the network.
  BTC_FIAT_SPOT_URL: 'http://127.0.0.1:9/',
  DEBUG_READ_TOKEN: '',
  WEBAUTHN_RP_ID: 'localhost',
} as const;

const defaultServer = {
  command: 'bun src/index.ts',
  url: 'http://127.0.0.1:3000/healthz',
  reuseExistingServer: !process.env['CI'],
  timeout: 60_000,
  env: {
    ...process.env,
    ...PINNED_OFF,
    BIND_ADDR: '127.0.0.1:3000',
    PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
    LNURL_SERVER_URL: '',
    // The shop stablecoin payment stays off: each new route answers its default.
    ORCHESTRA_BASE_URL: '',
    ORCHESTRA_API_KEY: '',
    SHOP_EVM_RPC: '',
    SHOP_REFUND_ADDRESS: '',
    DEBUG_TOKEN: 'e2e-debug-token',
    CORS_ALLOWED_ORIGINS: 'http://localhost:3000,http://127.0.0.1:3000',
    MEDIA_DIR: join(tmpdir(), '21gifts-e2e-media'),
  },
};

const shopServers = [
  {
    command: 'bun e2e/shop-payment/stand-ins/server.ts',
    url: `${CONTROL_URL}/__health`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  {
    command: 'bun src/index.ts',
    url: `http://127.0.0.1:${API_PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      ...process.env,
      ...PINNED_OFF,
      BIND_ADDR: `127.0.0.1:${API_PORT}`,
      PUBLIC_BASE_URL,
      LNURL_SERVER_URL: `http://127.0.0.1:${LNURL_PORT}`,
      ORCHESTRA_BASE_URL: `https://127.0.0.1:${ORCHESTRA_PORT}`,
      ORCHESTRA_API_KEY,
      SHOP_EVM_RPC: JSON.stringify(
        Object.fromEntries(
          Object.entries(RPC_PORTS).map(([chainId, port]) => [
            chainId,
            `https://127.0.0.1:${port}`,
          ]),
        ),
      ),
      SHOP_REFUND_ADDRESS: REFUND_ADDRESS,
      // The stand-ins' spot price (100 000 USD per BTC, the price of their
      // quotes): without a fresh spot the api offers no stablecoin.
      BTC_FIAT_SPOT_URL: `${CONTROL_URL}/__spot`,
      // Test-only: the stand-ins serve TLS with a certificate made at start.
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      DEBUG_TOKEN,
      CORS_ALLOWED_ORIGINS: WEBAUTHN_ORIGIN,
      MEDIA_DIR: join(tmpdir(), '21gifts-e2e-shop-media'),
    },
  },
];

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  reporter: 'list',
  projects: [
    {
      name: 'default',
      testIgnore: ['shop-payment/**'],
      use: { baseURL: 'http://127.0.0.1:3000' },
    },
    {
      name: 'shop-payment',
      testDir: './e2e/shop-payment',
      // Settlement polls run 30 s; watcher scenarios wait for 10 s history
      // reads and the 30 s receipt duty.
      timeout: 240_000,
      use: { baseURL: `http://127.0.0.1:${API_PORT}`, ignoreHTTPSErrors: true },
    },
  ],
  webServer: [...(runDefault ? [defaultServer] : []), ...(runShop ? shopServers : [])],
});
