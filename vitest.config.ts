import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Vitest configuration with a hard 100% coverage gate.
 *
 * Any code under `src` that is reachable in a happy-path environment must be
 * covered by tests. Genuinely-unreachable defensive code (e.g. SSR guards,
 * `process.exit()` paths) can be exempted with a `v8 ignore` annotation
 * accompanied by a one-line reason — never to silence the gate.
 *
 * The thresholds are enforced by CI, so a PR cannot merge while coverage
 * sits below 100% on the activated surface.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    setupFiles: ['src/__tests__/setup-media-dir.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts', // entry-point; covered by integration test of server factory
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        'src/types/**', // type-only modules contribute no executable code
        'src/lib/auth/sql.ts', // SqlClient interface only; Bun adapter lives in index.ts
      ],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
      all: true,
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
