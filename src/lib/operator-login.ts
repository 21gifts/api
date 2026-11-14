/**
 * Operator login with SSH keys.
 *
 * `GET /debug/auth/challenge` issues a random challenge (60 seconds, single
 * use, stored through {@link OperatorLoginStore}). The operator signs it with
 * `ssh-keygen -Y sign -n <namespace>`. `POST /debug/auth` consumes the
 * challenge, runs `ssh-keygen -Y find-principals` and `ssh-keygen -Y verify`
 * against the loaded allowed-signers lines, and issues a token valid for
 * 15 minutes. Only the SHA-256 hex of the token is stored.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logEvent, type LogFields } from '@/lib/log';
import { OPERATOR_LEVELS, type OperatorLevel } from '@/lib/operator';
import type { OperatorLoginStore } from '@/lib/operator-login-store';
import { OPERATOR_KEY_TYPE, sshKeyFingerprint, type OperatorSigners } from '@/lib/operator-signers';

/** Lifetime of a challenge, in milliseconds. */
export const OPERATOR_CHALLENGE_TTL_MS = 60_000;

/** Lifetime of an operator token, in milliseconds. */
export const OPERATOR_TOKEN_TTL_MS = 15 * 60_000;

/** Largest accepted signature, in bytes (an ed25519 signature file is about 314). */
export const OPERATOR_SIGNATURE_MAX_BYTES = 2048;

/** Time limit of one `ssh-keygen` run, in milliseconds. */
export const SSH_KEYGEN_TIMEOUT_MS = 5_000;

/** Prefix of every operator token; session tokens are lower-case hex. */
const TOKEN_PREFIX = 'op_';
const TOKEN_PATTERN = /^op_[A-Za-z0-9_-]{43}$/;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ARMOR_BEGIN = '-----BEGIN SSH SIGNATURE-----';
const ARMOR_END = '-----END SSH SIGNATURE-----';
const OUTPUT_LIMIT_BYTES = 16_384;

/** Level and operator a valid key token grants. */
export interface OperatorKeyGrant {
  /** Principal of the key that logged in. */
  operator: string;
  /** `SHA256:` fingerprint of that key. */
  keyFingerprint: string;
  /** Level the token was issued with. */
  level: OperatorLevel;
}

/** Why a login was refused. */
export type OperatorLoginRefusal =
  'challenge' | 'signature' | 'key_type' | 'unknown_key' | 'verify' | 'not_listed';

/** Outcome of {@link OperatorLogin.login}. */
export type OperatorLoginResult =
  | { ok: true; token: string; grant: OperatorKeyGrant; expiresAt: number }
  | { ok: false; reason: OperatorLoginRefusal };

/** Collaborators of {@link OperatorLogin}. */
export interface OperatorLoginDeps {
  /** Loaded allowed-signers lines, or `null` when key login is off. */
  signers: OperatorSigners | null;
  /** Challenge and token persistence. */
  store: OperatorLoginStore;
  /** Clock (epoch milliseconds). */
  now: () => number;
  /** `ssh-keygen` executable (default: `ssh-keygen` from `PATH`). */
  sshKeygenPath?: string;
  /** Time limit of one `ssh-keygen` run (default: {@link SSH_KEYGEN_TIMEOUT_MS}). */
  sshKeygenTimeoutMs?: number;
}

/** Exit code and stdout of one `ssh-keygen` run; `code` is `null` when it did not exit normally. */
interface ProcessOutcome {
  code: number | null;
  stdout: string;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Token from `Authorization: Bearer op_…`, or `null` for any other header. */
function keyBearer(header: string | undefined): string | null {
  if (header === undefined || !header.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice('Bearer '.length).trim();
  return TOKEN_PATTERN.test(token) ? token : null;
}

/** Read one SSH wire string at `offset`; `null` when it runs past the end. */
function readString(bytes: Uint8Array, offset: number): { value: Uint8Array; next: number } | null {
  if (offset + 4 > bytes.byteLength) {
    return null;
  }
  const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
  const start = offset + 4;
  if (start + length > bytes.byteLength) {
    return null;
  }
  return { value: bytes.subarray(start, start + length), next: start + length };
}

/**
 * Public key blob of an armored SSHSIG signature, or `null` when malformed.
 * Layout: `SSHSIG`, uint32 version, string public key, ….
 */
function signaturePublicKey(armored: string): Uint8Array | null {
  const text = armored.trim();
  if (!text.startsWith(ARMOR_BEGIN) || !text.endsWith(ARMOR_END)) {
    return null;
  }
  const body = text.slice(ARMOR_BEGIN.length, text.length - ARMOR_END.length).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) {
    return null;
  }
  const bytes = new Uint8Array(Buffer.from(body, 'base64'));
  if (Buffer.from(bytes.subarray(0, 6)).toString('latin1') !== 'SSHSIG' || bytes.byteLength < 10) {
    return null;
  }
  return readString(bytes, 10)?.value ?? null;
}

/** Key type named inside a public key blob, or `null`. */
function blobKeyType(blob: Uint8Array): string | null {
  const type = readString(blob, 0);
  return type === null ? null : Buffer.from(type.value).toString('latin1');
}

/**
 * Run `ssh-keygen` with a fixed argument list and no shell.
 *
 * Caller data reaches it only as `stdin` or as file content. The process is
 * killed after `timeoutMs`; stdout is kept up to {@link OUTPUT_LIMIT_BYTES}.
 */
function runSshKeygen(
  path: string,
  args: readonly string[],
  stdin: string,
  timeoutMs: number,
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const finish = (code: number | null): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout });
      }
    };
    const child = spawn(path, [...args], {
      shell: false,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < OUTPUT_LIMIT_BYTES) {
        stdout += chunk.slice(0, OUTPUT_LIMIT_BYTES - stdout.length);
      }
    });
    /* v8 ignore next 3 -- EPIPE only when ssh-keygen exits before reading the 43-byte stdin; its exit code decides */
    child.stdin.on('error', () => {
      // A process that exits before reading stdin closes the pipe; its exit code decides.
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
    child.stdin.end(stdin);
  });
}

/**
 * Operator login with SSH keys: challenges, signature checks, and token checks.
 */
export class OperatorLogin {
  readonly #signers: OperatorSigners | null;
  readonly #store: OperatorLoginStore;
  readonly #now: () => number;
  readonly #sshKeygenPath: string;
  readonly #timeoutMs: number;

  /**
   * @param deps - Loaded signers, store, clock, and optional `ssh-keygen` settings.
   */
  constructor(deps: OperatorLoginDeps) {
    this.#signers = deps.signers;
    this.#store = deps.store;
    this.#now = deps.now;
    this.#sshKeygenPath = deps.sshKeygenPath ?? 'ssh-keygen';
    this.#timeoutMs = deps.sshKeygenTimeoutMs ?? SSH_KEYGEN_TIMEOUT_MS;
  }

  /** Whether the allowed-signers files and the namespace were loaded at boot. */
  get configured(): boolean {
    return this.#signers !== null;
  }

  /**
   * Store and return a new challenge. Deletes expired challenges and tokens first.
   *
   * @returns The challenge (43 base64url characters) and its end of validity.
   * @throws When key login is off (callers check {@link OperatorLogin.configured}).
   */
  async issueChallenge(): Promise<{ challenge: string; expiresAt: number }> {
    this.#loadedSigners();
    const now = this.#now();
    await this.#store.deleteExpired(now);
    const challenge = randomBytes(32).toString('base64url');
    const expiresAt = now + OPERATOR_CHALLENGE_TTL_MS;
    await this.#store.addChallenge(challenge, now, expiresAt);
    return { challenge, expiresAt };
  }

  /**
   * Check a signed challenge and issue a token.
   *
   * Deletes expired challenges and tokens, then consumes the challenge; an
   * unknown, expired, or used challenge is refused before any process starts.
   * Only an `ssh-ed25519` signature key is accepted. `find-principals` must
   * name exactly one principal, and `verify` must exit 0 for that principal
   * and this api's namespace. The token's level is the highest level that
   * principal and key hold now. Every attempt logs `debug.auth.login.ok` or
   * `debug.auth.login.refused` with the reason, the operator when known, and
   * the key fingerprint when the signature names a key; never the token, the
   * signature, or the challenge.
   *
   * @param challenge - Challenge from `GET /debug/auth/challenge`.
   * @param signature - Armored `ssh-keygen -Y sign` output.
   * @returns The token and its grant, or the refusal reason.
   * @throws When key login is off, or when the store fails.
   */
  async login(challenge: string, signature: string): Promise<OperatorLoginResult> {
    const signers = this.#loadedSigners();
    const now = this.#now();
    await this.#store.deleteExpired(now);
    const fields: Record<string, string> = {};
    const refuse = (reason: OperatorLoginRefusal): OperatorLoginResult => {
      logEvent('debug.auth.login.refused', { reason, ...fields } satisfies LogFields);
      return { ok: false, reason };
    };
    if (
      !CHALLENGE_PATTERN.test(challenge) ||
      !(await this.#store.consumeChallenge(challenge, now))
    ) {
      return refuse('challenge');
    }
    const blob = signaturePublicKey(signature);
    if (blob === null) {
      return refuse('signature');
    }
    const keyFingerprint = sshKeyFingerprint(blob);
    fields['keyFingerprint'] = keyFingerprint;
    if (blobKeyType(blob) !== OPERATOR_KEY_TYPE) {
      return refuse('key_type');
    }
    const principal = await this.#withFiles(signers, signature, async (sigPath, allowedPath) => {
      const found = await runSshKeygen(
        this.#sshKeygenPath,
        ['-Y', 'find-principals', '-s', sigPath, '-f', allowedPath],
        '',
        this.#timeoutMs,
      );
      const names = [...new Set(found.stdout.split('\n').map((l) => l.trim()))].filter(Boolean);
      if (found.code !== 0 || names.length !== 1) {
        return { refusal: 'unknown_key' as const };
      }
      const name = names[0] as string;
      fields['operator'] = name;
      const verified = await runSshKeygen(
        this.#sshKeygenPath,
        ['-Y', 'verify', '-f', allowedPath, '-I', name, '-n', signers.namespace, '-s', sigPath],
        challenge,
        this.#timeoutMs,
      );
      return verified.code === 0 ? { name } : { refusal: 'verify' as const };
    });
    if ('refusal' in principal) {
      return refuse(principal.refusal);
    }
    const level = signers.levelFor(principal.name, keyFingerprint, now);
    if (level === null) {
      return refuse('not_listed');
    }
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const expiresAt = now + OPERATOR_TOKEN_TTL_MS;
    const grant: OperatorKeyGrant = { operator: principal.name, keyFingerprint, level };
    await this.#store.addToken({
      tokenHash: sha256Hex(token),
      ...grant,
      createdAt: now,
      expiresAt,
    });
    logEvent('debug.auth.login.ok', { ...fields, level });
    return { ok: true, token, grant, expiresAt };
  }

  /**
   * Grant of a key token in an `Authorization` header.
   *
   * The token must be stored and unexpired, and its operator must still be
   * listed in the loaded files with the same key, at the token's level or
   * higher, and not past `valid-before`.
   *
   * @param authorizationHeader - Raw `Authorization` header, or `undefined`.
   * @param at - Instant to check against (epoch milliseconds; default: the
   *   login clock now). The audit log passes the request's start.
   * @returns The grant, or `null` when key login is off, the bearer is not a
   *   key token, or the token is refused.
   */
  async resolveBearer(
    authorizationHeader: string | undefined,
    at?: number,
  ): Promise<OperatorKeyGrant | null> {
    const token = keyBearer(authorizationHeader);
    if (this.#signers === null || token === null) {
      return null;
    }
    const now = at ?? this.#now();
    const record = await this.#store.findToken(sha256Hex(token), now);
    if (record === null) {
      return null;
    }
    const listed = this.#signers.levelFor(record.operator, record.keyFingerprint, now);
    if (
      listed === null ||
      OPERATOR_LEVELS.indexOf(listed) < OPERATOR_LEVELS.indexOf(record.level)
    ) {
      return null;
    }
    return {
      operator: record.operator,
      keyFingerprint: record.keyFingerprint,
      level: record.level,
    };
  }

  #loadedSigners(): OperatorSigners {
    if (this.#signers === null) {
      throw new Error('Operator key login is not configured');
    }
    return this.#signers;
  }

  /**
   * Write the signature and the allowed-signers lines into a fresh private
   * directory (mode 0700, random name), run `body`, and remove the directory
   * in every outcome.
   */
  async #withFiles<T>(
    signers: OperatorSigners,
    signature: string,
    body: (sigPath: string, allowedPath: string) => Promise<T>,
  ): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'operator-login-'));
    try {
      const sigPath = join(dir, 'challenge.sig');
      const allowedPath = join(dir, 'allowed_signers');
      await writeFile(sigPath, signature.trim() + '\n', { mode: 0o600 });
      await writeFile(allowedPath, signers.allowedSignersText(), { mode: 0o600 });
      return await body(sigPath, allowedPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
