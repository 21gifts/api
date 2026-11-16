import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Namespace of the default Playwright boot. */
export const E2E_SIGNING_NAMESPACE = '21gifts-debug-dev';

/** Throwaway keys and allowed-signers files of the default Playwright boot. */
export interface E2eOperatorKeys {
  /** `DEBUG_ALLOWED_SIGNERS_DIR` of the default boot. */
  signersDir: string;
  /** Private key listed in `read.allowed_signers` as `e2e-reader`. */
  readKey: string;
  /** Private key listed in `admin.allowed_signers` as `e2e-admin`. */
  adminKey: string;
  /** Private ECDSA key listed in `read.allowed_signers`; the loader drops it. */
  ecdsaKey: string;
  /** Private key that no file lists. */
  unlistedKey: string;
}

const ROOT = join(tmpdir(), '21gifts-e2e-operator-keys');

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
  makeKey('admin', 'ed25519');
  makeKey('ecdsa', 'ecdsa');
  makeKey('unlisted', 'ed25519');
  const ns = `namespaces="${E2E_SIGNING_NAMESPACE}"`;
  writeFileSync(
    join(keys.signersDir, 'read.allowed_signers'),
    `e2e-reader ${ns} ${publicKey('reader')}\ne2e-ecdsa ${publicKey('ecdsa')}\n`,
  );
  writeFileSync(join(keys.signersDir, 'write.allowed_signers'), '');
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
