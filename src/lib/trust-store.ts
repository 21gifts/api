/**
 * Persistence for trust-chain edges (who granted which staff status).
 *
 * v1 default is in-memory. Production boot injects Postgres when
 * `DATABASE_URL` is set. Column layout matches `docs/schema/trust_edge.sql`.
 */

import type { SqlClient } from '@/lib/auth/sql';
import type { TrustEdge, TrustKind } from '@/lib/trust';

/** Message thrown when `(subjectId, kind)` is already stored. */
const DUPLICATE_TRUST_EDGE = 'duplicate trust edge';

/**
 * Persistence port for trust edges.
 */
export interface TrustStore {
  /**
   * Every stored edge, oldest `createdAt` first, then `id` ascending.
   *
   * @returns Edge copies (caller-owned).
   */
  listEdges(): Promise<TrustEdge[]>;

  /**
   * Edges whose subject is `subjectId`, oldest `createdAt` first, then `id`.
   *
   * @param subjectId - Account receiving the status.
   * @returns Edge copies (caller-owned).
   */
  listEdgesForSubject(subjectId: string): Promise<TrustEdge[]>;

  /**
   * Edges whose subject or actor is `accountId`, oldest `createdAt` first, then `id`.
   *
   * @param accountId - Account on either end of the edge.
   * @returns Edge copies (caller-owned).
   */
  listEdgesTouching(accountId: string): Promise<TrustEdge[]>;

  /**
   * Insert. Rejects a duplicate `(subjectId, kind)`.
   *
   * @param edge - Fully formed edge (id, subject, actor, kind, time).
   * @returns The stored edge (a copy is fine).
   * @throws Error whose message is {@link DUPLICATE_TRUST_EDGE}.
   */
  insertEdge(edge: TrustEdge): Promise<TrustEdge>;

  /**
   * Delete the stored `(subjectId, kind)` row, if any.
   *
   * @param subjectId - Account that received the status.
   * @param kind - Grant kind to remove.
   * @returns A copy of the deleted edge, or `undefined` when none matched.
   */
  deleteEdge(subjectId: string, kind: TrustKind): Promise<TrustEdge | undefined>;
}

/** Idempotent DDL for the trust_edge table (matches `docs/schema/trust_edge.sql`). */
export const TRUST_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS trust_edge (
  id uuid PRIMARY KEY,
  subject_id uuid NOT NULL REFERENCES account (id),
  actor_id uuid NOT NULL REFERENCES account (id),
  kind text NOT NULL CHECK (kind IN ('verify', 'moderator_propose', 'moderator_confirm', 'moderator_appoint')),
  created_at timestamptz NOT NULL,
  CHECK (subject_id <> actor_id)
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS trust_edge_subject_kind_uidx ON trust_edge (subject_id, kind)`,
  `CREATE INDEX IF NOT EXISTS trust_edge_actor_idx ON trust_edge (actor_id)`,
];

/**
 * Apply {@link TRUST_SCHEMA_SQL} in order. Idempotent.
 *
 * @param sql - Parameter-bound SQL client.
 * @returns Resolves when every statement has executed.
 */
export async function migrateTrustSchema(sql: SqlClient): Promise<void> {
  for (const statement of TRUST_SCHEMA_SQL) {
    await sql.execute(statement);
  }
}

/**
 * Process-local {@link TrustStore}. Used in tests and when no database URL
 * is configured — the process still boots.
 */
export class InMemoryTrustStore implements TrustStore {
  readonly #edges: TrustEdge[];

  /**
   * @param seed - Optional seed edges; copied into private storage.
   */
  constructor(seed: readonly TrustEdge[] = []) {
    this.#edges = seed.map(copyEdge);
  }

  /**
   * Oldest-first copy of every stored edge.
   *
   * @returns A new array of copies; mutating it does not change the store.
   */
  listEdges(): Promise<TrustEdge[]> {
    return Promise.resolve(sortedCopies(this.#edges));
  }

  /**
   * Oldest-first copy of edges for `subjectId`.
   *
   * @param subjectId - Account receiving the status.
   * @returns A new array of copies.
   */
  listEdgesForSubject(subjectId: string): Promise<TrustEdge[]> {
    return Promise.resolve(
      sortedCopies(this.#edges.filter((edge) => edge.subjectId === subjectId)),
    );
  }

  /**
   * Oldest-first copy of edges that touch `accountId`.
   *
   * @param accountId - Account on either end of the edge.
   * @returns A new array of copies.
   */
  listEdgesTouching(accountId: string): Promise<TrustEdge[]> {
    return Promise.resolve(
      sortedCopies(
        this.#edges.filter((edge) => edge.subjectId === accountId || edge.actorId === accountId),
      ),
    );
  }

  /**
   * Append a copy of `edge` and return a copy.
   *
   * @param edge - Edge to store.
   * @returns A copy of the stored edge.
   * @throws Error with message {@link DUPLICATE_TRUST_EDGE} when that pair exists.
   */
  async insertEdge(edge: TrustEdge): Promise<TrustEdge> {
    const duplicate = this.#edges.some(
      (stored) => stored.subjectId === edge.subjectId && stored.kind === edge.kind,
    );
    if (duplicate) {
      throw new Error(DUPLICATE_TRUST_EDGE);
    }
    const stored = copyEdge(edge);
    this.#edges.push(stored);
    return Promise.resolve(copyEdge(stored));
  }

  /**
   * Remove the `(subjectId, kind)` row and return a copy, or `undefined`.
   *
   * @param subjectId - Account that received the status.
   * @param kind - Grant kind to remove.
   * @returns A copy of the deleted edge, or `undefined`.
   */
  deleteEdge(subjectId: string, kind: TrustKind): Promise<TrustEdge | undefined> {
    const index = this.#edges.findIndex(
      (stored) => stored.subjectId === subjectId && stored.kind === kind,
    );
    if (index < 0) {
      return Promise.resolve(undefined);
    }
    const removed = this.#edges[index];
    /* v8 ignore next 3 -- findIndex ≥ 0 always yields a row */
    if (removed === undefined) {
      return Promise.resolve(undefined);
    }
    this.#edges.splice(index, 1);
    return Promise.resolve(copyEdge(removed));
  }
}

/** Row shape selected from `trust_edge`. */
interface TrustSqlRow {
  id: string;
  subject_id: string;
  actor_id: string;
  kind: TrustKind;
  created_at: Date | string;
}

/** Map a SQL row onto {@link TrustEdge}. Unexported. */
function mapTrustRow(row: TrustSqlRow): TrustEdge {
  return {
    id: row.id,
    subjectId: row.subject_id,
    actorId: row.actor_id,
    kind: row.kind,
    createdAt: epochMs(row.created_at),
  };
}

/**
 * Durable {@link TrustStore} backed by Postgres.
 */
export class PostgresTrustStore implements TrustStore {
  readonly #sql: SqlClient;

  /**
   * @param sql - Parameter-bound SQL client (already migrated).
   */
  constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  /**
   * Oldest-first list from `trust_edge`.
   *
   * @returns Mapped rows.
   */
  async listEdges(): Promise<TrustEdge[]> {
    const rows = await this.#sql.query<TrustSqlRow>(
      `SELECT id, subject_id, actor_id, kind, created_at FROM trust_edge ORDER BY created_at ASC, id ASC`,
    );
    return rows.map((row) => mapTrustRow(row));
  }

  /**
   * Oldest-first list from `trust_edge` for one subject.
   *
   * @param subjectId - Account receiving the status (`$1`).
   * @returns Mapped rows.
   */
  async listEdgesForSubject(subjectId: string): Promise<TrustEdge[]> {
    const rows = await this.#sql.query<TrustSqlRow>(
      `SELECT id, subject_id, actor_id, kind, created_at FROM trust_edge WHERE subject_id = $1 ORDER BY created_at ASC, id ASC`,
      [subjectId],
    );
    return rows.map((row) => mapTrustRow(row));
  }

  /**
   * Oldest-first list from `trust_edge` where `accountId` is subject or actor.
   *
   * @param accountId - Account on either end (`$1`).
   * @returns Mapped rows.
   */
  async listEdgesTouching(accountId: string): Promise<TrustEdge[]> {
    const rows = await this.#sql.query<TrustSqlRow>(
      `SELECT id, subject_id, actor_id, kind, created_at FROM trust_edge WHERE subject_id = $1 OR actor_id = $1 ORDER BY created_at ASC, id ASC`,
      [accountId],
    );
    return rows.map((row) => mapTrustRow(row));
  }

  /**
   * Insert `edge` into `trust_edge` and return a copy.
   *
   * @param edge - Fully formed edge.
   * @returns The input edge after a successful insert (a copy).
   * @throws Error with message {@link DUPLICATE_TRUST_EDGE} on unique violation (23505).
   */
  async insertEdge(edge: TrustEdge): Promise<TrustEdge> {
    try {
      await this.#sql.execute(
        `INSERT INTO trust_edge (id, subject_id, actor_id, kind, created_at) VALUES ($1,$2,$3,$4,$5)`,
        [edge.id, edge.subjectId, edge.actorId, edge.kind, new Date(edge.createdAt)],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new Error(DUPLICATE_TRUST_EDGE);
      }
      throw error;
    }
    return copyEdge(edge);
  }

  /**
   * Delete the `(subjectId, kind)` row from `trust_edge`.
   *
   * @param subjectId - Account that received the status (`$1`).
   * @param kind - Grant kind (`$2`).
   * @returns The deleted row, or `undefined` when none matched.
   */
  async deleteEdge(subjectId: string, kind: TrustKind): Promise<TrustEdge | undefined> {
    const rows = await this.#sql.query<TrustSqlRow>(
      `DELETE FROM trust_edge WHERE subject_id = $1 AND kind = $2 RETURNING id, subject_id, actor_id, kind, created_at`,
      [subjectId, kind],
    );
    const row = rows[0];
    return row === undefined ? undefined : mapTrustRow(row);
  }
}

/** Caller-owned shallow copy. */
function copyEdge(edge: TrustEdge): TrustEdge {
  return { ...edge };
}

/** Oldest `createdAt` first, then `id` ascending. */
function compareEdges(a: TrustEdge, b: TrustEdge): number {
  const byTime = a.createdAt - b.createdAt;
  if (byTime !== 0) {
    return byTime;
  }
  return a.id.localeCompare(b.id);
}

/** Sort then copy so callers cannot mutate store state. */
function sortedCopies(edges: readonly TrustEdge[]): TrustEdge[] {
  return [...edges].sort(compareEdges).map(copyEdge);
}

/** `timestamptz` (Date or ISO string) to epoch ms. */
function epochMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/** True when `error` is a Postgres unique-violation (`code === '23505'`). */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === '23505'
  );
}
