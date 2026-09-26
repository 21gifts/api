/**
 * Persistence for public OpenCryptoPay places.
 *
 * In-memory for tests and memory boots; Postgres when `DATABASE_URL` is set.
 * Unique on `(origin, external_id)` — a second insert returns the existing
 * row without overwriting coordinates or name.
 */

import type { SqlClient } from '@/lib/auth/sql';
import type { OcpPlaceInput } from '@/lib/ocp-place';

/** Stored public OCP place. */
export type OcpPlace = {
  id: string;
  origin: string;
  externalId: string;
  name: string;
  lat: number;
  lon: number;
  category: string;
  paymentMethods: string | null;
  createdAt: Date;
};

/** Persistence port for OCP places. */
export interface OcpPlaceStore {
  /**
   * Insert when `(origin, externalId)` is new; otherwise return the existing
   * row unchanged.
   *
   * @param input - Validated place fields.
   * @returns `{ created: true, place }` on insert; `{ created: false, place }`
   *   when the pair already existed.
   */
  insertIfNew(input: OcpPlaceInput): Promise<{ created: boolean; place: OcpPlace }>;

  /**
   * Newest first (`createdAt` DESC, then `id` DESC), capped at `limit`.
   *
   * @param limit - Maximum rows.
   */
  list(limit: number): Promise<OcpPlace[]>;
}

/**
 * Idempotent DDL for `ocp_place` (matches `docs/schema/ocp-place.sql`).
 * Single statement.
 */
export const OCP_PLACE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS ocp_place (
  id uuid PRIMARY KEY,
  origin text NOT NULL,
  external_id text NOT NULL,
  name text NOT NULL,
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  category text NOT NULL,
  payment_methods text,
  created_at timestamptz NOT NULL,
  UNIQUE (origin, external_id)
)`;

/**
 * Apply {@link OCP_PLACE_SCHEMA_SQL}. Idempotent.
 *
 * @param sql - Parameter-bound SQL client.
 */
export async function migrateOcpPlaceSchema(sql: SqlClient): Promise<void> {
  await sql.execute(OCP_PLACE_SCHEMA_SQL);
}

/** Caller-owned copy; mutating dates or the object does not change the store. */
function copyPlace(row: OcpPlace): OcpPlace {
  return {
    ...row,
    createdAt: new Date(row.createdAt.getTime()),
  };
}

/** Newest `createdAt` first, then `id` descending. */
function newestFirst(rows: readonly OcpPlace[]): OcpPlace[] {
  return [...rows].sort((a, b) => {
    const byTime = b.createdAt.getTime() - a.createdAt.getTime();
    if (byTime !== 0) {
      return byTime;
    }
    return b.id.localeCompare(a.id);
  });
}

/**
 * Process-local {@link OcpPlaceStore}. Used in tests and when no database URL
 * is configured — the process still boots. Always starts empty.
 */
export class InMemoryOcpPlaceStore implements OcpPlaceStore {
  readonly #rows: OcpPlace[] = [];
  readonly #now: () => Date;

  /**
   * @param now - Clock for `createdAt`. Defaults to `Date`. Tests pass a
   *   fixed clock so equal timestamps take the id ordering branch.
   */
  constructor(now?: () => Date) {
    this.#now = now ?? (() => new Date());
  }

  /**
   * Return the existing row for `(origin, externalId)`, or insert a new one.
   *
   * @param input - Validated place fields.
   */
  insertIfNew(input: OcpPlaceInput): Promise<{ created: boolean; place: OcpPlace }> {
    const existing = this.#rows.find(
      (row) => row.origin === input.origin && row.externalId === input.externalId,
    );
    if (existing !== undefined) {
      return Promise.resolve({ created: false, place: copyPlace(existing) });
    }
    const place: OcpPlace = {
      id: crypto.randomUUID(),
      origin: input.origin,
      externalId: input.externalId,
      name: input.name,
      lat: input.lat,
      lon: input.lon,
      category: input.category,
      paymentMethods: input.paymentMethods,
      createdAt: this.#now(),
    };
    this.#rows.push(place);
    return Promise.resolve({ created: true, place: copyPlace(place) });
  }

  /**
   * Newest-first copy, capped at `limit`.
   *
   * @param limit - Maximum rows.
   */
  list(limit: number): Promise<OcpPlace[]> {
    return Promise.resolve(
      newestFirst(this.#rows)
        .slice(0, limit)
        .map((row) => copyPlace(row)),
    );
  }
}

/** Row shape selected from `ocp_place`. */
interface OcpPlaceSqlRow {
  id: string;
  origin: string;
  external_id: string;
  name: string;
  lat: number | string;
  lon: number | string;
  category: string;
  payment_methods: string | null;
  created_at: Date | string;
}

/** Coerce Postgres timestamps; copy so callers cannot mutate driver dates. */
function asDate(value: Date | string): Date {
  return value instanceof Date ? new Date(value.getTime()) : new Date(value);
}

/** Map a SQL row onto {@link OcpPlace}. */
function mapOcpPlaceRow(row: OcpPlaceSqlRow): OcpPlace {
  return {
    id: row.id,
    origin: row.origin,
    externalId: row.external_id,
    name: row.name,
    lat: typeof row.lat === 'number' ? row.lat : Number(row.lat),
    lon: typeof row.lon === 'number' ? row.lon : Number(row.lon),
    category: row.category,
    paymentMethods: row.payment_methods,
    createdAt: asDate(row.created_at),
  };
}

const OCP_PLACE_SELECT = `id, origin, external_id, name, lat, lon, category, payment_methods, created_at`;

/**
 * Durable {@link OcpPlaceStore} backed by Postgres.
 */
export class PostgresOcpPlaceStore implements OcpPlaceStore {
  readonly #sql: SqlClient;

  /**
   * @param sql - Parameter-bound SQL client (already migrated).
   */
  constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  /**
   * Insert when new; on unique conflict return the existing row unchanged.
   *
   * @param input - Validated place fields.
   */
  async insertIfNew(input: OcpPlaceInput): Promise<{ created: boolean; place: OcpPlace }> {
    const id = crypto.randomUUID();
    const createdAt = new Date();
    const inserted = await this.#sql.query<OcpPlaceSqlRow>(
      `INSERT INTO ocp_place (
         id, origin, external_id, name, lat, lon, category, payment_methods, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (origin, external_id) DO NOTHING
       RETURNING ${OCP_PLACE_SELECT}`,
      [
        id,
        input.origin,
        input.externalId,
        input.name,
        input.lat,
        input.lon,
        input.category,
        input.paymentMethods,
        createdAt.toISOString(),
      ],
    );
    const row = inserted[0];
    if (row !== undefined) {
      return { created: true, place: mapOcpPlaceRow(row) };
    }
    const existing = await this.#sql.query<OcpPlaceSqlRow>(
      `SELECT ${OCP_PLACE_SELECT}
       FROM ocp_place
       WHERE origin = $1 AND external_id = $2`,
      [input.origin, input.externalId],
    );
    const found = existing[0];
    if (found === undefined) {
      throw new Error('ocp.place.insert_conflict_missing');
    }
    return { created: false, place: mapOcpPlaceRow(found) };
  }

  /**
   * Newest first, capped at `limit`.
   *
   * @param limit - Maximum rows (`$1`).
   */
  async list(limit: number): Promise<OcpPlace[]> {
    const rows = await this.#sql.query<OcpPlaceSqlRow>(
      `SELECT ${OCP_PLACE_SELECT}
       FROM ocp_place
       ORDER BY created_at DESC, id DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => mapOcpPlaceRow(row));
  }
}
