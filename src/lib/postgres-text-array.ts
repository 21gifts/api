/**
 * Encode strings as one Postgres text-array literal.
 *
 * Bun 1.4.4 binds a JavaScript array to `text[]`. Call sites still pass this literal.
 */

/**
 * Encode `values` as one Postgres text-array literal.
 *
 * Empty input is `{}`. A backslash or double quote inside a value is escaped.
 * Bun 1.4.4 binds a JavaScript array to `text[]`. Call sites still pass this literal.
 *
 * @param values - Strings to include in the array.
 * @returns A literal such as `{"rejected"}` or `{}`.
 */
export function postgresTextArrayLiteral(values: readonly string[]): string {
  return `{${values
    .map((value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)
    .join(',')}}`;
}
