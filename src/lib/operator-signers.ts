/**
 * Operator SSH keys allowed to log in on the debug surface.
 *
 * Three OpenSSH allowed-signers files, one per operator level, are read once
 * at boot from `DEBUG_ALLOWED_SIGNERS_DIR` (`read.allowed_signers`,
 * `write.allowed_signers`, `admin.allowed_signers`). `DEBUG_SIGNING_NAMESPACE`
 * names the one namespace this api accepts (`21gifts-debug-dev`,
 * `21gifts-debug-stg`, or `21gifts-debug-prd`).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logEvent } from '@/lib/log';
import { OPERATOR_LEVELS, type OperatorLevel } from '@/lib/operator';

/** The only key type a loaded line may carry. */
export const OPERATOR_KEY_TYPE = 'ssh-ed25519';

/** File name of each level inside `DEBUG_ALLOWED_SIGNERS_DIR`. */
export const OPERATOR_SIGNER_FILES: Readonly<Record<OperatorLevel, string>> = {
  read: 'read.allowed_signers',
  write: 'write.allowed_signers',
  admin: 'admin.allowed_signers',
};

const NAMESPACE_PATTERN = /^21gifts-debug-(dev|stg|prd)$/;
const PRINCIPAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
const OPTION_PATTERN = /^([a-z-]+)(?:="([^"]*)")?$/;
const VALID_BEFORE_PATTERN = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?Z?$/;
const KEY_TYPE_PATTERN = /^(ssh|ecdsa|sk|rsa)-/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** One accepted line of an allowed-signers file. */
export interface OperatorSigner {
  /** Principal (the operator name). */
  principal: string;
  /** Level of the file the line came from. */
  level: OperatorLevel;
  /** `SHA256:` fingerprint of the public key, as `ssh-keygen -l` prints it. */
  fingerprint: string;
  /** End of validity (epoch milliseconds), or `null` when the line has no `valid-before`. */
  validBefore: number | null;
  /** The line as read, passed to `ssh-keygen`. */
  line: string;
}

/**
 * The loaded operator keys and the namespace this api accepts.
 */
export class OperatorSigners {
  readonly #signers: readonly OperatorSigner[];

  /** Namespace a signature must carry (`21gifts-debug-<env>`). */
  readonly namespace: string;

  /**
   * @param namespace - Accepted signature namespace.
   * @param signers - Accepted lines of all three files.
   */
  constructor(namespace: string, signers: readonly OperatorSigner[]) {
    this.namespace = namespace;
    this.#signers = signers.map((signer) => ({ ...signer }));
  }

  /** Number of accepted lines. */
  get size(): number {
    return this.#signers.length;
  }

  /**
   * Highest level a key holds for a principal at `nowMs`.
   *
   * Only lines with the same principal and the same key fingerprint count.
   * A line past its `valid-before` does not count.
   *
   * @param principal - Operator name.
   * @param fingerprint - `SHA256:` fingerprint of the key.
   * @param nowMs - Current time (epoch milliseconds).
   * @returns The highest level, or `null` when no line is valid.
   */
  levelFor(principal: string, fingerprint: string, nowMs: number): OperatorLevel | null {
    let best: OperatorLevel | null = null;
    for (const signer of this.#signers) {
      if (signer.principal !== principal || signer.fingerprint !== fingerprint) {
        continue;
      }
      if (signer.validBefore !== null && nowMs >= signer.validBefore) {
        continue;
      }
      if (best === null || OPERATOR_LEVELS.indexOf(signer.level) > OPERATOR_LEVELS.indexOf(best)) {
        best = signer.level;
      }
    }
    return best;
  }

  /**
   * Allowed-signers text of every accepted line, one per line.
   *
   * @returns File content for `ssh-keygen -Y find-principals` and `-Y verify`.
   */
  allowedSignersText(): string {
    return this.#signers.map((signer) => `${signer.line}\n`).join('');
  }
}

/** Reads one file as UTF-8 text; throws when it cannot. */
export type ReadSignerFile = (path: string) => string;

/**
 * `SHA256:` fingerprint of an OpenSSH public key blob.
 *
 * @param blob - Wire-format public key.
 * @returns `SHA256:` plus unpadded base64 of the SHA-256 digest.
 */
export function sshKeyFingerprint(blob: Uint8Array): string {
  const digest = createHash('sha256').update(blob).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

/** Split a line on whitespace outside double quotes. */
function splitFields(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
      current += char;
    } else if (!quoted && (char === ' ' || char === '\t')) {
      if (current !== '') {
        fields.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current !== '') {
    fields.push(current);
  }
  return fields;
}

/** Split an options field on commas outside double quotes. */
function splitOptions(field: string): string[] {
  const options: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of field) {
    if (char === '"') {
      quoted = !quoted;
    }
    if (char === ',' && !quoted) {
      options.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  options.push(current);
  return options;
}

/**
 * Epoch milliseconds of a `valid-before` value, read as OpenSSH reads it: a
 * trailing `Z` is UTC, no `Z` is the host's local time. `null` when malformed
 * or when a component is out of range (for example month 13 or minute 60).
 */
function parseValidBefore(value: string): number | null {
  const match = VALID_BEFORE_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  const [, y, mo, d, h, mi, s] = match;
  const parts = [
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h ?? '0'),
    Number(mi ?? '0'),
    Number(s ?? '0'),
  ] as const;
  const utc = value.endsWith('Z');
  const date = utc ? new Date(Date.UTC(...parts)) : new Date(...parts);
  const read = utc
    ? [
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        date.getUTCHours(),
        date.getUTCMinutes(),
        date.getUTCSeconds(),
      ]
    : [
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        date.getHours(),
        date.getMinutes(),
        date.getSeconds(),
      ];
  return read.every((part, index) => part === parts[index]) ? date.getTime() : null;
}

/** Wire-format key type and key length of an ed25519 public key blob, or `null`. */
function ed25519Blob(base64: string): Uint8Array | null {
  if (!BASE64_PATTERN.test(base64)) {
    return null;
  }
  const blob = new Uint8Array(Buffer.from(base64, 'base64'));
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  if (blob.byteLength !== 4 + OPERATOR_KEY_TYPE.length + 4 + 32) {
    return null;
  }
  if (view.getUint32(0) !== OPERATOR_KEY_TYPE.length) {
    return null;
  }
  const type = Buffer.from(blob.subarray(4, 4 + OPERATOR_KEY_TYPE.length)).toString('latin1');
  if (type !== OPERATOR_KEY_TYPE || view.getUint32(4 + OPERATOR_KEY_TYPE.length) !== 32) {
    return null;
  }
  return blob;
}

/**
 * Whether `namespace` matches an OpenSSH pattern list (`namespaces="…"`).
 * Comma-separated patterns with `*` and `?`; a matching `!pattern` refuses.
 */
function namespaceListMatches(list: string, namespace: string): boolean {
  let matched = false;
  for (const raw of list.split(',')) {
    const negated = raw.startsWith('!');
    const pattern = negated ? raw.slice(1) : raw;
    const regex = new RegExp(
      `^${pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')}$`,
    );
    if (regex.test(namespace)) {
      if (negated) {
        return false;
      }
      matched = true;
    }
  }
  return matched;
}

/** Outcome of reading one line. */
type LineOutcome =
  | { kind: 'skip' }
  | { kind: 'other_namespace' }
  | { kind: 'drop'; reason: string; keyType?: string }
  | { kind: 'keep'; signer: OperatorSigner };

/** Parse one allowed-signers line of `level` for this api's `namespace`. */
function parseLine(raw: string, level: OperatorLevel, namespace: string): LineOutcome {
  const line = raw.trim();
  if (line === '' || line.startsWith('#')) {
    return { kind: 'skip' };
  }
  const [principal, second, third, fourth] = [...splitFields(line), '', '', ''] as [
    string,
    string,
    string,
    string,
  ];
  const hasOptions = !KEY_TYPE_PATTERN.test(second);
  const keyType = hasOptions ? third : second;
  const keyBase64 = hasOptions ? fourth : third;
  if (keyType !== OPERATOR_KEY_TYPE) {
    return { kind: 'drop', reason: 'key_type', keyType: keyType.slice(0, 40) };
  }
  if (!PRINCIPAL_PATTERN.test(principal)) {
    return { kind: 'drop', reason: 'principal' };
  }
  let validBefore: number | null = null;
  let namespaces: string | null = null;
  for (const option of hasOptions ? splitOptions(second) : []) {
    const [, name, value] = OPTION_PATTERN.exec(option) ?? [];
    if (name === 'namespaces' && value !== undefined) {
      namespaces = value;
      continue;
    }
    if (name === 'valid-before' && value !== undefined) {
      validBefore = parseValidBefore(value);
      if (validBefore === null) {
        return { kind: 'drop', reason: 'valid_before' };
      }
      continue;
    }
    return { kind: 'drop', reason: 'option' };
  }
  const blob = ed25519Blob(keyBase64);
  if (blob === null) {
    return { kind: 'drop', reason: 'key' };
  }
  if (namespaces !== null && !namespaceListMatches(namespaces, namespace)) {
    return { kind: 'other_namespace' };
  }
  return {
    kind: 'keep',
    signer: { principal, level, fingerprint: sshKeyFingerprint(blob), validBefore, line },
  };
}

/**
 * Load the operator keys once at boot.
 *
 * Returns `null` (key login off; `DEBUG_TOKEN` is unaffected) when
 * `DEBUG_ALLOWED_SIGNERS_DIR` or `DEBUG_SIGNING_NAMESPACE` is unset or blank,
 * when the namespace is not `21gifts-debug-dev`, `-stg`, or `-prd`, or when
 * one of the three files cannot be read. Both unset stays silent; every other
 * off case logs `debug.auth.signers.off` with a `reason`. Lines whose key type
 * is not `ssh-ed25519`, whose principal is not one plain name, whose options
 * are not `namespaces` or `valid-before`, or whose key does not decode are
 * dropped and logged as `debug.auth.signers.line_dropped` with the level, the
 * line number, and the reason. A line whose `namespaces` option does not
 * match this api's namespace belongs to another environment: it is left out
 * of the level lookup and of the lines handed to `ssh-keygen`, and counted
 * as `otherNamespace`. A loaded set logs `debug.auth.signers.loaded`.
 *
 * @param env - Environment to read the two settings from.
 * @param readText - File reader (default: UTF-8 `readFileSync`).
 * @returns The loaded keys, or `null` when key login is off.
 */
export function loadOperatorSigners(
  env: Readonly<Record<string, string | undefined>>,
  readText: ReadSignerFile = (path) => readFileSync(path, 'utf8'),
): OperatorSigners | null {
  const dir = (env['DEBUG_ALLOWED_SIGNERS_DIR'] ?? '').trim();
  const namespace = (env['DEBUG_SIGNING_NAMESPACE'] ?? '').trim();
  if (dir === '' && namespace === '') {
    return null;
  }
  if (dir === '' || namespace === '') {
    logEvent('debug.auth.signers.off', { reason: dir === '' ? 'dir_unset' : 'namespace_unset' });
    return null;
  }
  if (!NAMESPACE_PATTERN.test(namespace)) {
    logEvent('debug.auth.signers.off', { reason: 'namespace_invalid' });
    return null;
  }
  const signers: OperatorSigner[] = [];
  const counts: Record<OperatorLevel, number> = { read: 0, write: 0, admin: 0 };
  let otherNamespace = 0;
  for (const level of OPERATOR_LEVELS) {
    let text: string;
    try {
      text = readText(join(dir, OPERATOR_SIGNER_FILES[level]));
    } catch {
      logEvent('debug.auth.signers.off', { reason: 'unreadable', level });
      return null;
    }
    text.split('\n').forEach((raw, index) => {
      const outcome = parseLine(raw, level, namespace);
      if (outcome.kind === 'keep') {
        signers.push(outcome.signer);
        counts[level] += 1;
      } else if (outcome.kind === 'other_namespace') {
        otherNamespace += 1;
      } else if (outcome.kind === 'drop') {
        logEvent('debug.auth.signers.line_dropped', {
          level,
          line: index + 1,
          reason: outcome.reason,
          ...(outcome.keyType === undefined ? {} : { keyType: outcome.keyType }),
        });
      }
    });
  }
  logEvent('debug.auth.signers.loaded', { namespace, ...counts, otherNamespace });
  return new OperatorSigners(namespace, signers);
}
