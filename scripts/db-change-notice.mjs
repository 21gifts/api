#!/usr/bin/env node
/**
 * Decide whether a pull request body must show the database-change marker.
 * Run from the repo root. No extra packages.
 */

/**
 * Line that must be visible when a change touches the database.
 * Variation selectors are optional.
 */
export const MARKER = '⚠️ 🗄️ Attention: database change';

/**
 * Patterns that mark a changed line as SQL or a database call.
 * Keyword forms are case-insensitive. Call and template forms match as written.
 * @type {RegExp[]}
 */
const DATABASE_LINE_PATTERNS = [
  /_SCHEMA_SQL/,
  /migrate\w*Schema/,
  /sql`/,
  /\.query\(/,
  /\.execute\(/,
  /\.unsafe\(/,
  /\.begin\(/,
  /\bSELECT\b.*\bFROM\b/i,
  /\bINSERT\s+INTO\b/i,
  /\bUPDATE\s+[A-Za-z_][A-Za-z0-9_]*\s+SET\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i,
  /\bCREATE\s+TABLE\b/i,
  /\bALTER\s+TABLE\b/i,
  /\bDROP\s+(?:TABLE|INDEX)\b/i,
  /\bON\s+CONFLICT\b/i,
  /\bCREATE\s+TRIGGER\b/i,
];

/**
 * Drop U+FE0F so a marker with or without emoji variation selectors compares equal.
 * @param {string} text
 * @returns {string}
 */
function stripVariationSelectors(text) {
  return text.replaceAll('\uFE0F', '');
}

/**
 * Remove fenced code blocks. A fence is a line of at least three backticks or tildes.
 * @param {string} text
 * @returns {string}
 */
function stripFencedCode(text) {
  /** @type {string[]} */
  const kept = [];
  /** @type {{ mark: string, length: number } | null} */
  let open = null;
  for (const line of text.split('\n')) {
    const match = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (open) {
      if (match && match[1][0] === open.mark && match[1].length >= open.length) open = null;
      continue;
    }
    if (match) {
      open = { mark: match[1][0], length: match[1].length };
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Remove HTML comments, including comments that span lines.
 * @param {string} text
 * @returns {string}
 */
function stripHtmlComments(text) {
  return text.replaceAll(/<!--[\s\S]*?-->/g, '');
}

/**
 * Remove `<details>` blocks, innermost first, so nested blocks disappear.
 * Matching is case-insensitive and spans lines.
 * @param {string} text
 * @returns {string}
 */
function stripDetails(text) {
  const inner = /<details\b[^>]*>(?:(?!<details\b)[\s\S])*?<\/details>/gi;
  let current = text;
  let next = current.replace(inner, '');
  while (next !== current) {
    current = next;
    next = current.replace(inner, '');
  }
  return current;
}

/**
 * Pull-request body after hidden regions are removed.
 * Hidden regions are fenced code, HTML comments, and `<details>` blocks.
 * @param {string | null | undefined} body
 * @returns {string}
 */
export function visibleBody(body) {
  const source = body ?? '';
  return stripDetails(stripHtmlComments(stripFencedCode(source)));
}

/**
 * Whether any remaining line is exactly the database-change marker.
 * @param {string | null | undefined} body
 * @returns {boolean}
 */
export function isMarkerVisible(body) {
  const marker = stripVariationSelectors(MARKER);
  return visibleBody(body)
    .split('\n')
    .some((line) => stripVariationSelectors(line.trim()) === marker);
}

/**
 * Whether the path alone requires the marker, regardless of the patch.
 * @param {string} filename
 * @returns {boolean}
 */
function isPathTrigger(filename) {
  return (
    filename.startsWith('docs/schema/') ||
    filename.startsWith('docs/database/') ||
    filename.startsWith('integration/') ||
    filename === 'src/lib/boot-stores.ts'
  );
}

/**
 * Whether this TypeScript path is scanned for SQL, database calls, or a missing patch.
 * @param {string} filename
 * @returns {boolean}
 */
function isInspectedSource(filename) {
  return /^src\/.+\.ts$/.test(filename) && !filename.includes('/__tests__/');
}

/**
 * Whether a diff line is an added or removed content line.
 * Git's `+++` and `---` headers are not content.
 * @param {string} line
 * @returns {boolean}
 */
function isChangedLine(line) {
  if (line.startsWith('+++') || line.startsWith('---')) return false;
  return line.startsWith('+') || line.startsWith('-');
}

/**
 * Whether an added or removed line contains SQL or a database call.
 * @param {string} line
 * @returns {boolean}
 */
function lineTouchesDatabase(line) {
  return DATABASE_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * Whether a patch touches the database. A missing or empty patch is fail-closed.
 * @param {string | undefined} patch
 * @returns {boolean}
 */
function patchTouchesDatabase(patch) {
  if (patch === undefined || patch === '') return true;
  for (const raw of patch.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (isChangedLine(line) && lineTouchesDatabase(line)) return true;
  }
  return false;
}

/**
 * Whether one pull-request file requires the database-change marker.
 * @param {{ filename: string, patch?: string }} file
 * @returns {boolean}
 */
function fileTriggers(file) {
  if (isPathTrigger(file.filename)) return true;
  if (!isInspectedSource(file.filename)) return false;
  return patchTouchesDatabase(file.patch);
}

/**
 * Decide if the marker is required and whether the body already shows it.
 * `triggers` lists triggering filenames once, in file order.
 * @param {{
 *   body?: string | null,
 *   files?: Array<{ filename: string, status?: string, patch?: string }>,
 * }} input
 * @returns {{ required: boolean, ok: boolean, triggers: string[] }}
 */
export function evaluate({ body, files }) {
  /** @type {string[]} */
  const triggers = [];
  const seen = new Set();
  for (const file of files ?? []) {
    if (!fileTriggers(file) || seen.has(file.filename)) continue;
    seen.add(file.filename);
    triggers.push(file.filename);
  }
  const required = triggers.length > 0;
  return { required, ok: !required || isMarkerVisible(body), triggers };
}
