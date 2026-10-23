/**
 * Encode strings as one Postgres text-array literal.
 *
 * Bun `SQL.unsafe` cannot bind a JavaScript array to `text[]`.
 */

/**
 * Encode `values` as one Postgres text-array literal.
 *
 * Empty input is `{}`. A backslash or double quote inside a value is escaped.
 * Bun SQL cannot bind a JavaScript array to `text[]`.
 *
 * @param values - Strings to include in the array.
 * @returns A literal such as `{"rejected"}` or `{}`.
 */
export function postgresTextArrayLiteral(values: readonly string[]): string {
  return `{${values
    .map((value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)
    .join(',')}}`;
}
