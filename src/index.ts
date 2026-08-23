/**
 * Service entry point.
 *
 * The thinnest possible top-level: resolve + parse the bind address, build
 * the app via the factory, hand the request handler to Bun's native HTTP
 * server. All testable logic lives in `server.ts`; this file is the I/O
 * boundary that wires those pure helpers to the Bun runtime and is therefore
 * excluded from coverage.
 */
import { startDailyGiftsFromEnv } from './lib/daily-gifts/scheduler';
import { invoicePayerFromEnv } from './lib/lndhub-invoice-payer';
import { createApp, parseBindAddr, resolveBindAddr } from './server';

/* v8 ignore start — Bun runtime boot path; exercised by smoke tests, not unit tests */
if (import.meta.main) {
  const addr = resolveBindAddr(undefined, process.env);
  const { host, port } = parseBindAddr(addr);
  const fetchImpl = globalThis.fetch;
  const invoicePayer = invoicePayerFromEnv(process.env, fetchImpl);
  const app = createApp({ invoicePayer });
  Bun.serve({ fetch: app.fetch, hostname: host, port });
  console.warn(`21gifts-api listening on ${host}:${port}`);
  startDailyGiftsFromEnv(process.env, { fetchImpl });
}
/* v8 ignore stop */
