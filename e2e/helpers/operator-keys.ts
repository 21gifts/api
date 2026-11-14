import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';

/** Namespace of the default Playwright boot. */
export const E2E_SIGNING_NAMESPACE = '21gifts-debug-dev';

/** Throwaway keys and allowed-signers files of the default Playwright boot. */
export interface E2eOperatorKeys {
  /** `DEBUG_ALLOWED_SIGNERS_DIR` of the default boot. */
  signersDir: string;
  /** Private key listed in `read.allowed_signers` as `e2e-reader`. */
  readKey: string;
  /** Private key listed in `write.allowed_signers` as `e2e-writer`. */
  writeKey: string;
  /** Private key listed in `admin.allowed_signers` as `e2e-admin`. */
  adminKey: string;
  /** Private ECDSA key listed in `read.allowed_signers`; the loader drops it. */
  ecdsaKey: string;
  /** Private key that no file lists. */
  unlistedKey: string;
}

// Bump the suffix whenever the key set changes, so a cache of an older set is not reused.
const ROOT = join(tmpdir(), '21gifts-e2e-operator-keys-v2');

function makeKey(name: string, type: string): void {
  execFileSync('ssh-keygen', ['-q', '-t', type, '-N', '', '-C', name, '-f', join(ROOT, name)]);
}

function publicKey(name: string): string {
  return readFileSync(join(ROOT, `${name}.pub`), 'utf8')
    .trim()
    .split(' ')
    .slice(0, 2)
    .join(' ');
}

/**
 * Make the keys once per machine (nothing is committed) and return their paths.
 * The Playwright config calls this before the default server starts, so the
 * workers find the same keys.
 *
 * @returns Paths of the signers directory and of each private key.
 */
export function e2eOperatorKeys(): E2eOperatorKeys {
  const keys: E2eOperatorKeys = {
    signersDir: join(ROOT, 'signers'),
    readKey: join(ROOT, 'reader'),
    writeKey: join(ROOT, 'writer'),
    adminKey: join(ROOT, 'admin'),
    ecdsaKey: join(ROOT, 'ecdsa'),
    unlistedKey: join(ROOT, 'unlisted'),
  };
  if (existsSync(join(ROOT, 'ready'))) {
    return keys;
  }
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, 'signers'), { recursive: true, mode: 0o700 });
  makeKey('reader', 'ed25519');
  makeKey('writer', 'ed25519');
  makeKey('admin', 'ed25519');
  makeKey('ecdsa', 'ecdsa');
  makeKey('unlisted', 'ed25519');
  const ns = `namespaces="${E2E_SIGNING_NAMESPACE}"`;
  writeFileSync(
    join(keys.signersDir, 'read.allowed_signers'),
    `e2e-reader ${ns} ${publicKey('reader')}\ne2e-ecdsa ${publicKey('ecdsa')}\n`,
  );
  writeFileSync(
    join(keys.signersDir, 'write.allowed_signers'),
    `e2e-writer ${ns} ${publicKey('writer')}\n`,
  );
  writeFileSync(
    join(keys.signersDir, 'admin.allowed_signers'),
    `e2e-admin ${ns} ${publicKey('admin')}\n`,
  );
  writeFileSync(join(ROOT, 'ready'), '');
  return keys;
}

/**
 * Sign `message` with `ssh-keygen -Y sign`.
 *
 * @param keyPath - Private key.
 * @param message - Exact challenge text.
 * @param namespace - Signature namespace (default: the default boot's).
 * @returns The armored signature.
 */
export function e2eSign(
  keyPath: string,
  message: string,
  namespace = E2E_SIGNING_NAMESPACE,
): string {
  return execFileSync('ssh-keygen', ['-Y', 'sign', '-n', namespace, '-f', keyPath], {
    input: message,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  });
}

/**
 * `SHA256:` fingerprint of a key as `ssh-keygen -l` prints it.
 *
 * @param keyPath - Private key (its `.pub` is read).
 * @returns The fingerprint.
 */
export function e2eFingerprint(keyPath: string): string {
  return (
    execFileSync('ssh-keygen', ['-l', '-f', `${keyPath}.pub`], { encoding: 'utf8' }).split(
      ' ',
    )[1] ?? ''
  );
}

/** Operator level of a key token. */
export type E2eOperatorLevel = 'read' | 'write' | 'admin';

/** `Authorization` header of an operator key token. */
export type E2eOperatorHeaders = { authorization: string };

/** A key token is reused until this long before its `expiresAt`. */
const TOKEN_RENEW_BEFORE_MS = 5 * 60_000;

/** Base URLs of request contexts made outside the project's `baseURL`. */
const contextBaseURLs = new WeakMap<APIRequestContext, string>();

/**
 * Record the base URL of a request context that targets another api than
 * the project's `baseURL` (e.g. a server a test boots itself), so
 * {@link operatorHeaders} logs in there.
 *
 * @param request - Request context of that api.
 * @param baseURL - Its base URL.
 */
export function registerOperatorBaseURL(request: APIRequestContext, baseURL: string): void {
  contextBaseURLs.set(request, baseURL);
}

const tokenCache = new Map<string, Promise<{ headers: E2eOperatorHeaders; expiresAt: number }>>();

async function logIn(
  request: APIRequestContext,
  baseURL: string,
  level: E2eOperatorLevel,
): Promise<{ headers: E2eOperatorHeaders; expiresAt: number }> {
  const keys = e2eOperatorKeys();
  const keyPath = { read: keys.readKey, write: keys.writeKey, admin: keys.adminKey }[level];
  const issued = await request.get(new URL('/debug/auth/challenge', baseURL).toString());
  expect(issued.status(), 'GET /debug/auth/challenge').toBe(200);
  const { challenge } = (await issued.json()) as { challenge: string };
  const login = await request.post(new URL('/debug/auth', baseURL).toString(), {
    data: { challenge, signature: e2eSign(keyPath, challenge) },
  });
  expect(login.status(), `POST /debug/auth (${level})`).toBe(200);
  const body = (await login.json()) as { token: string; level: string; expiresAt: string };
  expect(body.level).toBe(level);
  return {
    headers: { authorization: `Bearer ${body.token}` },
    expiresAt: Date.parse(body.expiresAt),
  };
}

/**
 * `Authorization` header of an operator key token at `level`, from the SSH
 * key login (`GET /debug/auth/challenge`, then `POST /debug/auth`) with the
 * throwaway key of that level. The token is kept per level and base URL in
 * this worker until shortly before it expires.
 *
 * @param request - Request context of the api.
 * @param level - Lowest operator level the routes need.
 * @param baseURL - Base URL of the api (default: the one registered with
 *   {@link registerOperatorBaseURL}, else the project's `baseURL`).
 * @returns The header to send.
 */
export async function operatorHeaders(
  request: APIRequestContext,
  level: E2eOperatorLevel,
  baseURL: string = contextBaseURLs.get(request) ?? test.info().project.use.baseURL ?? '',
): Promise<E2eOperatorHeaders> {
  if (baseURL === '') {
    throw new Error('operatorHeaders needs a baseURL');
  }
  const key = `${level} ${baseURL}`;
  const cached = tokenCache.get(key);
  if (cached !== undefined) {
    try {
      const entry = await cached;
      if (entry.expiresAt - Date.now() > TOKEN_RENEW_BEFORE_MS) {
        return entry.headers;
      }
    } catch {
      // A failed login is not kept; log in again below.
    }
    if (tokenCache.get(key) !== cached) {
      return operatorHeaders(request, level, baseURL);
    }
  }
  const pending = logIn(request, baseURL, level);
  tokenCache.set(key, pending);
  pending.catch(() => {
    if (tokenCache.get(key) === pending) {
      tokenCache.delete(key);
    }
  });
  return (await pending).headers;
}
