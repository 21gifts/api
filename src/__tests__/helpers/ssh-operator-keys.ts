import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperatorLevel } from '@/lib/operator';
import { OPERATOR_SIGNER_FILES } from '@/lib/operator-signers';

/** A throwaway key made with `ssh-keygen` for one test run. */
export interface TestKey {
  /** Private key file. */
  path: string;
  /** `<type> <base64>` of the public key. */
  publicKey: string;
  /** `SHA256:` fingerprint as `ssh-keygen -l` prints it. */
  fingerprint: string;
}

/** A scratch directory with throwaway keys; nothing is committed. */
export class TestKeyring {
  readonly dir: string;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'operator-keys-test-'));
  }

  /**
   * Make a key without a passphrase.
   *
   * @param name - File name.
   * @param type - `ed25519` (default), `ecdsa`, or `rsa`.
   * @returns The key.
   */
  key(name: string, type: 'ed25519' | 'ecdsa' | 'rsa' = 'ed25519'): TestKey {
    const path = join(this.dir, name);
    execFileSync('ssh-keygen', ['-q', '-t', type, '-N', '', '-C', name, '-f', path]);
    const publicKey = readFileSync(`${path}.pub`, 'utf8').trim().split(' ').slice(0, 2).join(' ');
    const fingerprint =
      execFileSync('ssh-keygen', ['-l', '-f', `${path}.pub`], { encoding: 'utf8' }).split(' ')[1] ??
      '';
    return { path, publicKey, fingerprint };
  }

  /**
   * Write the three allowed-signers files into a new directory.
   *
   * @param files - Lines per level; a missing level writes no file.
   * @returns The directory.
   */
  signersDir(files: Partial<Record<OperatorLevel, string[]>>): string {
    const dir = mkdtempSync(join(this.dir, 'signers-'));
    for (const [level, lines] of Object.entries(files) as [OperatorLevel, string[]][]) {
      writeFileSync(join(dir, OPERATOR_SIGNER_FILES[level]), lines.map((l) => `${l}\n`).join(''));
    }
    return dir;
  }

  /** Remove every file of this keyring. */
  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * Sign `message` with `ssh-keygen -Y sign`.
 *
 * @param key - Signing key.
 * @param namespace - Signature namespace.
 * @param message - Exact bytes to sign.
 * @returns The armored signature.
 */
export function sshSign(key: TestKey, namespace: string, message: string): string {
  return execFileSync('ssh-keygen', ['-Y', 'sign', '-n', namespace, '-f', key.path], {
    input: message,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  });
}

/**
 * One allowed-signers line.
 *
 * @param principal - Operator name.
 * @param key - Listed key.
 * @param options - Optional options field.
 * @returns The line.
 */
export function signerLine(principal: string, key: TestKey, options?: string): string {
  return options === undefined
    ? `${principal} ${key.publicKey}`
    : `${principal} ${options} ${key.publicKey}`;
}
