import type { SqlClient } from '@/lib/auth/sql';

/**
 * Operator read of every ordinary table in schema `public`.
 * Pages are fixed at {@link DEBUG_DB_PAGE_SIZE}. Callers follow `nextCursor`
 * until it is null. Photo and video bytes are lengths. Authentication
 * secrets are the string `redacted`.
 */

/** Rows returned in one page. The query fetches one extra row to detect another page. */
export const DEBUG_DB_PAGE_SIZE = 200;

/**
 * Column names stored as SHA-256 by `db_change_redact`. Text values become
 * `"redacted"`. A `bytea` secret stays an octet length, not the bytes.
 */
export const DEBUG_DB_SECRET_COLUMNS: readonly string[] = [
  'token',
  'challenge',
  'nostr_nsec_ciphertext',
  'nonce',
  'view_key',
  'endpoint',
  'p256dh',
  'auth',
  'delivered_endpoints',
];

/** One ordinary public table and its row count. */
export interface DebugDbTable {
  /** Catalog name (`pg_class.relname`). */
  name: string;
  /** `count(*)` of that table. */
  rowCount: number;
}

/** One keyset page. `nextCursor` is null when this page is the last. */
export interface DebugDbPage {
  /** Table that was read. */
  table: string;
  /** Result columns, catalog order, unsafe identifiers omitted. */
  columns: string[];
  /** Page rows. `bytea` values are octet lengths or null. */
  rows: Record<string, unknown>[];
  /** Opaque cursor for the next page, or null when the page is short. */
  nextCursor: string | null;
}

/**
 * Thrown when a cursor does not decode or does not match the table key.
 * The route maps this to HTTP 400.
 */
export class DebugDbCursorError extends Error {
  /**
   * @param message - Stable error text. Callers do not show it to clients.
   */
  constructor(message = 'invalid cursor') {
    super(message);
    this.name = 'DebugDbCursorError';
  }
}

/** Read-only catalog and page port. No cache across calls. */
export interface DebugDbStore {
  /**
   * Every ordinary table in schema `public`, sorted by name.
   *
   * @returns Names that match a safe identifier, with `count(*)`.
   */
  listTables(): Promise<DebugDbTable[]>;
  /**
   * One page of `table`, or `undefined` when it is not an ordinary public table.
   *
   * @param table - Catalog name.
   * @param cursor - Previous `nextCursor`, or null for the first page.
   * @returns The page, or `undefined` when the table is unknown.
   * @throws DebugDbCursorError when `cursor` is not a cursor for this table's key.
   */
  readPage(table: string, cursor: string | null): Promise<DebugDbPage | undefined>;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
const SECRET = new Set<string>(DEBUG_DB_SECRET_COLUMNS);
const CTID_ALIAS = 'debug_db_ctid';

const TABLE_NAMES_SQL = `SELECT c.relname AS name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY c.relname`;

const COLUMNS_SQL = `SELECT a.attname AS name, t.typname AS type
FROM pg_attribute a
JOIN pg_type t ON t.oid = a.atttypid
WHERE a.attrelid = $1::regclass
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY a.attnum`;

const PRIMARY_KEY_SQL = `SELECT a.attname AS name
FROM pg_index i
JOIN pg_attribute a
  ON a.attrelid = i.indrelid
 AND a.attnum = ANY (i.indkey)
WHERE i.indrelid = $1::regclass
  AND i.indisprimary
  AND a.attnum > 0
ORDER BY array_position(i.indkey, a.attnum)`;

/**
 * Quote a catalog identifier that already matched {@link IDENT}.
 *
 * @param name - Lowercase identifier from `pg_catalog`.
 * @returns A double-quoted identifier.
 */
function quoteIdent(name: string): string {
  return `"${name}"`;
}

/**
 * Encode key values as a URL-safe cursor.
 *
 * @param values - Primary-key values, or one `ctid` text.
 * @returns base64url JSON, without padding.
 */
function encodeCursor(values: unknown[]): string {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
}

/**
 * Decode a cursor into key values.
 *
 * @param cursor - Client-supplied cursor.
 * @returns The JSON array.
 * @throws DebugDbCursorError when the text is not a JSON array.
 */
function decodeCursor(cursor: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed)) {
      throw new DebugDbCursorError();
    }
    return parsed;
  } catch (error) {
    if (error instanceof DebugDbCursorError) {
      throw error;
    }
    throw new DebugDbCursorError();
  }
}

/**
 * Postgres `DebugDbStore`. Identifiers are interpolated only after they come
 * from `pg_catalog` and match {@link IDENT}.
 */
export class PostgresDebugDbStore implements DebugDbStore {
  /** Bound SQL executor. */
  readonly #sql: SqlClient;

  /**
   * @param sql - Parameter-bound SQL client. Identifiers are not bound.
   */
  constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  /**
   * Ordinary public tables and their counts.
   *
   * @returns Safe names, sorted by the catalog query.
   */
  async listTables(): Promise<DebugDbTable[]> {
    const names = await this.#tableNames();
    const tables: DebugDbTable[] = [];
    for (const name of names) {
      const rows = await this.#sql.query<{ n: number | string | bigint | null }>(
        `SELECT count(*)::bigint AS n FROM ${quoteIdent(name)}`,
      );
      const raw = rows[0]?.n;
      tables.push({
        name,
        rowCount: raw === undefined || raw === null ? 0 : Number(raw),
      });
    }
    return tables;
  }

  /**
   * One keyset page. No primary key, or a primary key that is a secret
   * column, uses `ctid` so the cursor never carries the secret.
   *
   * @param table - Catalog name.
   * @param cursor - Previous page cursor, or null.
   * @returns The page, or `undefined` when `table` is not listed.
   * @throws DebugDbCursorError when `cursor` does not match the key.
   */
  async readPage(table: string, cursor: string | null): Promise<DebugDbPage | undefined> {
    if (!IDENT.test(table)) {
      return undefined;
    }
    const names = await this.#tableNames();
    if (!names.includes(table)) {
      return undefined;
    }
    const regclass = `public.${table}`;
    const discovered = await this.#sql.query<{ name: string | null; type: string }>(COLUMNS_SQL, [
      regclass,
    ]);
    const columns = discovered.filter(
      (column): column is { name: string; type: string } =>
        typeof column.name === 'string' && IDENT.test(column.name),
    );
    const keyRows = await this.#sql.query<{ name: string | null }>(PRIMARY_KEY_SQL, [regclass]);
    const primaryKey = keyRows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === 'string' && IDENT.test(name));
    const secretKey = primaryKey.some((name) => SECRET.has(name));
    const useCtid = primaryKey.length === 0 || secretKey;
    if (!useCtid && columns.length === 0) {
      return { table, columns: [], rows: [], nextCursor: null };
    }
    const keyColumns = useCtid ? [CTID_ALIAS] : primaryKey;
    const keyValues = cursor === null ? null : decodeCursor(cursor);
    if (keyValues !== null && keyValues.length !== keyColumns.length) {
      throw new DebugDbCursorError();
    }
    const selectList = columns
      .map((column) =>
        column.type === 'bytea'
          ? `octet_length(${quoteIdent(column.name)}) AS ${quoteIdent(column.name)}`
          : quoteIdent(column.name),
      )
      .concat(useCtid ? [`ctid::text AS ${quoteIdent(CTID_ALIAS)}`] : []);
    const orderList = useCtid ? ['ctid'] : primaryKey.map(quoteIdent);
    const where =
      keyValues === null
        ? ''
        : useCtid
          ? `WHERE ctid > $1::tid`
          : `WHERE (${primaryKey.map(quoteIdent).join(', ')}) > (${keyValues.map((_, index) => `$${index + 1}`).join(', ')})`;
    const params = keyValues ?? [];
    const fetched = await this.#sql.query<Record<string, unknown>>(
      `SELECT ${selectList.join(', ')} FROM ${quoteIdent(table)} ${where} ORDER BY ${orderList.join(', ')} LIMIT ${DEBUG_DB_PAGE_SIZE + 1}`,
      params,
    );
    const hasMore = fetched.length > DEBUG_DB_PAGE_SIZE;
    const page = hasMore ? fetched.slice(0, DEBUG_DB_PAGE_SIZE) : fetched;
    const columnNames = columns.map((column) => column.name);
    const rows = page.map((raw) => projectRow(raw, columns));
    if (!hasMore) {
      return { table, columns: columnNames, rows, nextCursor: null };
    }
    const last = page[DEBUG_DB_PAGE_SIZE - 1];
    /* v8 ignore next 3 -- a full page always has a last row */
    if (last === undefined) {
      return { table, columns: columnNames, rows, nextCursor: null };
    }
    return {
      table,
      columns: columnNames,
      rows,
      nextCursor: encodeCursor(cursorValues(last, keyColumns)),
    };
  }

  /**
   * Safe ordinary table names. Called on every list and page so the catalog
   * is not cached.
   *
   * @returns Identifier-safe names in catalog order.
   */
  async #tableNames(): Promise<string[]> {
    const rows = await this.#sql.query<{ name: unknown }>(TABLE_NAMES_SQL);
    const names: string[] = [];
    for (const row of rows) {
      if (typeof row.name === 'string' && IDENT.test(row.name)) {
        names.push(row.name);
      }
    }
    return names;
  }
}

/**
 * Copy one SQL row into JSON, replacing bytes and secrets.
 *
 * @param raw - Driver row, including the `ctid` alias when used.
 * @param columns - Safe columns and their `typname`.
 * @returns A row whose keys are the column names.
 */
function projectRow(
  raw: Record<string, unknown>,
  columns: readonly { name: string; type: string }[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of columns) {
    const value = raw[column.name];
    if (column.type === 'bytea') {
      out[column.name] = value === null || value === undefined ? null : Number(value);
      continue;
    }
    if (value !== null && value !== undefined && SECRET.has(column.name)) {
      out[column.name] = 'redacted';
      continue;
    }
    out[column.name] = value === undefined ? null : value;
  }
  return out;
}

/**
 * Key values for the next cursor, in key order.
 *
 * @param raw - Last returned driver row.
 * @param keyColumns - Primary-key names, or the `ctid` alias.
 * @returns JSON-safe values. Missing fields become null.
 */
function cursorValues(raw: Record<string, unknown>, keyColumns: readonly string[]): unknown[] {
  return keyColumns.map((name) => {
    const value = raw[name];
    return value === undefined ? null : value;
  });
}
