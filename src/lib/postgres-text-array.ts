/**
 * Encode strings as one Postgres text-array literal.
 *
 * Bun 1.4.4 `SQL.unsafe` accepts a JavaScript array for `text[]`. The stores still bind this literal.
 */

/**
 * Encode `values` as one Postgres text-array literal.
 *
 * Empty input is `{}`. A backslash or double quote inside a value is escaped.
 * Bun 1.4.4 also accepts a JavaScript array for `text[]`. Callers still pass this literal.
 *
 * @param values - Strings to include in the array.
 * @returns A literal such as `{"rejected"}` or `{}`.
 */
export function postgresTextArrayLiteral(values: readonly string[]): string {
  return `{${values
    .map((value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)
    .join(',')}}`;
}
