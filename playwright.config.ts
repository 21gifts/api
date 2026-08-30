import { defineConfig } from '@playwright/test';

/**
 * HTTP end-to-end tests against `bun src/index.ts` (request-only; no browser).
 * Docker runs the compiled `dist/index.js`; locally and in CI this boots source.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3000',
  },
  webServer: {
    command: 'bun src/index.ts',
    url: 'http://127.0.0.1:3000/healthz',
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
    env: {
      ...process.env,
      BIND_ADDR: '127.0.0.1:3000',
      PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
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
      DEBUG_TOKEN: 'e2e-debug-token',
      WEBAUTHN_RP_ID: 'localhost',
      CORS_ALLOWED_ORIGINS: 'http://localhost:3000,http://127.0.0.1:3000',
    },
  },
});
