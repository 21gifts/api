/**
 * Challenges and tokens of the operator SSH key login (memory or Postgres).
 *
 * A challenge is single use: {@link OperatorLoginStore.consumeChallenge}
 * deletes it and reports whether it was still valid in one step. A token is
 * stored only as the SHA-256 hex of its value.
 */

import type { SqlClient } from '@/lib/auth/sql';
import type { OperatorLevel } from '@/lib/operator';

/**
 * Idempotent DDL (matches `docs/schema/operator_login.sql`). Has no foreign
 * keys, so it can run at any point before `migrateDbChangeSchema`.
 */
export const OPERATOR_LOGIN_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS operator_challenge (
  challenge text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS operator_challenge_expires_at_idx ON operator_challenge (expires_at)`,
  `CREATE TABLE IF NOT EXISTS operator_token (
  token_hash text PRIMARY KEY,
  operator text NOT NULL,
  key_fingerprint text NOT NULL,
  level text NOT NULL CHECK (level IN ('read', 'write', 'admin')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS operator_token_expires_at_idx ON operator_token (expires_at)`,
];

/** One issued operator token. */
export interface OperatorTokenRecord {
  /** SHA-256 hex of the token. */
  tokenHash: string;
  /** Principal of the key that logged in. */
  operator: string;
  /** `SHA256:` fingerprint of that key. */
  keyFingerprint: string;
  /** Level granted at login. */
  level: OperatorLevel;
  /** Issue time (epoch milliseconds). */
  createdAt: number;
  /** End of validity (epoch milliseconds). */
  expiresAt: number;
}

/** Persistence port of the operator SSH key login. */
export interface OperatorLoginStore {
  /**
   * Store a new challenge.
   *
   * @param challenge - Random challenge text.
   * @param createdAt - Issue time (epoch milliseconds).
   * @param expiresAt - End of validity (epoch milliseconds).
   */
  addChallenge(challenge: string, createdAt: number, expiresAt: number): Promise<void>;
  /**
   * Delete a challenge and report whether it was valid, in one step.
   *
   * @param challenge - Challenge text from the caller.
   * @param now - Current time (epoch milliseconds).
   * @returns `true` only when the challenge existed and `expiresAt > now`.
   */
  consumeChallenge(challenge: string, now: number): Promise<boolean>;
  /**
   * Store an issued token.
   *
   * @param record - Token hash, operator, key, level, and times.
   */
  addToken(record: OperatorTokenRecord): Promise<void>;
  /**
   * Find a token that has not expired.
   *
   * @param tokenHash - SHA-256 hex of the presented token.
   * @param now - Current time (epoch milliseconds).
   * @returns The record, or `null` when unknown or `expiresAt <= now`.
   */
  findToken(tokenHash: string, now: number): Promise<OperatorTokenRecord | null>;
  /**
   * Delete every challenge and token with `expiresAt <= now`.
   *
   * @param now - Current time (epoch milliseconds).
   */
  deleteExpired(now: number): Promise<void>;
}

/**
 * Apply {@link OPERATOR_LOGIN_SCHEMA_SQL} in order. Idempotent.
 *
 * @param sql - Parameter-bound SQL client.
 * @returns Resolves when every statement has executed.
 */
export async function migrateOperatorLoginSchema(sql: SqlClient): Promise<void> {
  for (const statement of OPERATOR_LOGIN_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}

/**
 * Process-local {@link OperatorLoginStore} (memory boots and tests).
 */
export class InMemoryOperatorLoginStore implements OperatorLoginStore {
  readonly #challenges = new Map<string, number>();
  readonly #tokens = new Map<string, OperatorTokenRecord>();

  /**
   * Store a challenge.
   *
   * @param challenge - Challenge text.
   * @param _createdAt - Issue time (not kept in memory).
   * @param expiresAt - End of validity.
   * @returns Resolves once stored.
   */
  addChallenge(challenge: string, _createdAt: number, expiresAt: number): Promise<void> {
    this.#challenges.set(challenge, expiresAt);
    return Promise.resolve();
  }

  /**
   * Delete a challenge; report whether it was still valid.
   *
   * @param challenge - Challenge text.
   * @param now - Current time.
   * @returns Whether it existed and had not expired.
   */
  consumeChallenge(challenge: string, now: number): Promise<boolean> {
    const expiresAt = this.#challenges.get(challenge);
    this.#challenges.delete(challenge);
    return Promise.resolve(expiresAt !== undefined && expiresAt > now);
  }

  /**
   * Store a token record.
   *
   * @param record - Token record.
   * @returns Resolves once stored.
   */
  addToken(record: OperatorTokenRecord): Promise<void> {
    this.#tokens.set(record.tokenHash, { ...record });
    return Promise.resolve();
  }

  /**
   * Find an unexpired token.
   *
   * @param tokenHash - SHA-256 hex.
   * @param now - Current time.
   * @returns A copy of the record, or `null`.
   */
  findToken(tokenHash: string, now: number): Promise<OperatorTokenRecord | null> {
    const record = this.#tokens.get(tokenHash);
    return Promise.resolve(record === undefined || record.expiresAt <= now ? null : { ...record });
  }

  /**
   * Delete expired challenges and tokens.
   *
   * @param now - Current time.
   * @returns Resolves once deleted.
   */
  deleteExpired(now: number): Promise<void> {
    for (const [challenge, expiresAt] of this.#challenges) {
      if (expiresAt <= now) {
        this.#challenges.delete(challenge);
      }
    }
    for (const [hash, record] of this.#tokens) {
      if (record.expiresAt <= now) {
        this.#tokens.delete(hash);
      }
    }
    return Promise.resolve();
  }
}

/** Row selected from `operator_token`. */
interface OperatorTokenSqlRow {
  token_hash: string;
  operator: string;
  key_fingerprint: string;
  level: string;
  created_at: Date | string;
  expires_at: Date | string;
}

function epochMs(value: Date | string): number {
  return (value instanceof Date ? value : new Date(value)).getTime();
}

/**
 * Durable {@link OperatorLoginStore} backed by Postgres, shared by every api
 * instance.
 */
export class PostgresOperatorLoginStore implements OperatorLoginStore {
  readonly #sql: SqlClient;

  /**
   * @param sql - Parameter-bound SQL client (already migrated).
   */
  constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  /**
   * Insert a challenge.
   *
   * @param challenge - Challenge text.
   * @param createdAt - Issue time.
   * @param expiresAt - End of validity.
   */
  async addChallenge(challenge: string, createdAt: number, expiresAt: number): Promise<void> {
    await this.#sql.execute(
      `INSERT INTO operator_challenge (challenge, created_at, expires_at) VALUES ($1, $2, $3)`,
      [challenge, new Date(createdAt), new Date(expiresAt)],
    );
  }

  /**
   * Delete a challenge with one statement; report whether it was still valid.
   *
   * @param challenge - Challenge text.
   * @param now - Current time.
   * @returns Whether a row existed and had not expired.
   */
  async consumeChallenge(challenge: string, now: number): Promise<boolean> {
    const rows = await this.#sql.query<{ expires_at: Date | string }>(
      `DELETE FROM operator_challenge WHERE challenge = $1 RETURNING expires_at`,
      [challenge],
    );
    const row = rows[0];
    return row !== undefined && epochMs(row.expires_at) > now;
  }

  /**
   * Insert a token record.
   *
   * @param record - Token record.
   */
  async addToken(record: OperatorTokenRecord): Promise<void> {
    await this.#sql.execute(
      `INSERT INTO operator_token (token_hash, operator, key_fingerprint, level, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        record.tokenHash,
        record.operator,
        record.keyFingerprint,
        record.level,
        new Date(record.createdAt),
        new Date(record.expiresAt),
      ],
    );
  }

  /**
   * Select an unexpired token.
   *
   * @param tokenHash - SHA-256 hex.
   * @param now - Current time.
   * @returns The record, or `null`.
   */
  async findToken(tokenHash: string, now: number): Promise<OperatorTokenRecord | null> {
    const rows = await this.#sql.query<OperatorTokenSqlRow>(
      `SELECT token_hash, operator, key_fingerprint, level, created_at, expires_at
       FROM operator_token
       WHERE token_hash = $1 AND expires_at > $2`,
      [tokenHash, new Date(now)],
    );
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      tokenHash: row.token_hash,
      operator: row.operator,
      keyFingerprint: row.key_fingerprint,
      level: row.level as OperatorLevel,
      createdAt: epochMs(row.created_at),
      expiresAt: epochMs(row.expires_at),
    };
  }

  /**
   * Delete expired challenges and tokens.
   *
   * @param now - Current time.
   */
  async deleteExpired(now: number): Promise<void> {
    await this.#sql.execute(`DELETE FROM operator_challenge WHERE expires_at <= $1`, [
      new Date(now),
    ]);
    await this.#sql.execute(`DELETE FROM operator_token WHERE expires_at <= $1`, [new Date(now)]);
  }
}
