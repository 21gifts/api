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
      DEBUG_TOKEN: 'e2e-debug-token',
    },
  },
});
