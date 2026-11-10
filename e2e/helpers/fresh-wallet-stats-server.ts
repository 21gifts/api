import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { DEFAULT_BOOT_ENV, PINNED_OFF } from './pinned-env';

/** A dedicated memory-boot API and its isolated request context. */
export interface FreshWalletStatsServer {
  /** Request context whose relative paths resolve to the fresh API. */
  request: APIRequestContext;
  /** Stop the API process and dispose of its request context. */
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close((error) => (error === undefined ? resolvePort(port) : reject(error)));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  child.kill('SIGTERM');
  const timedOut = await Promise.race([exited.then(() => false), delay(5_000).then(() => true)]);
  if (timedOut) {
    child.kill('SIGKILL');
    await exited;
  }
}

/**
 * Start a dedicated default-mode API for one test, so public totals have no data from other specs.
 *
 * @returns Request context bound to the fresh API and a close function.
 */
export async function startFreshWalletStatsServer(): Promise<FreshWalletStatsServer> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const port = await freePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const mediaDir = mkdtempSync(join(tmpdir(), '21gifts-e2e-wallet-stats-'));
  const child = spawn('bun', ['src/index.ts'], {
    cwd: root,
    env: {
      ...process.env,
      ...PINNED_OFF,
      ...DEFAULT_BOOT_ENV,
      BIND_ADDR: `127.0.0.1:${port}`,
      PUBLIC_BASE_URL: baseURL,
      DEBUG_TOKEN: 'e2e-debug-token',
      CORS_ALLOWED_ORIGINS: baseURL,
      MEDIA_DIR: mediaDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  let spawnError: Error | undefined;
  child.once('error', (error: Error) => {
    spawnError = error;
  });
  let context: APIRequestContext;
  try {
    context = await playwrightRequest.newContext({ baseURL });
  } catch (error) {
    await stopChild(child);
    rmSync(mediaDir, { recursive: true, force: true });
    throw error;
  }
  const close = async (): Promise<void> => {
    await context.dispose();
    await stopChild(child);
    rmSync(mediaDir, { recursive: true, force: true });
  };

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (spawnError !== undefined) {
      await close();
      throw new Error(`Fresh wallet-stats API failed to start: ${spawnError.message}`);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      await close();
      throw new Error(`Fresh wallet-stats API exited before healthz:\n${output}`);
    }
    try {
      const health = await context.get('/healthz');
      if (health.ok()) {
        return { request: context, close };
      }
    } catch {
      // The listener is not up yet.
    }
    await delay(50);
  }
  await close();
  throw new Error(`Fresh wallet-stats API did not become healthy:\n${output}`);
}
