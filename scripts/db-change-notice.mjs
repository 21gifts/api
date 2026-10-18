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
  new RegExp(
    '\\bUPDATE\\s+(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)' +
      '(?:\\.(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*))?\\s+SET\\b',
    'i',
  ),
  /\bDELETE\s+FROM\b/i,
  /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i,
  /\bCREATE\s+TABLE\b/i,
  /\bALTER\s+TABLE\b/i,
  /\bDROP\s+(?:TABLE|INDEX)\b/i,
  /\bON\s+CONFLICT\b/i,
  /\bCREATE\s+TRIGGER\b/i,
];

/**
 * Patterns that mark hunk text as a database call or schema helper.
 * Used when a hunk has a changed line but that line itself is not SQL.
 * @type {RegExp[]}
 */
const DATABASE_ANCHOR_PATTERNS = [
  /sql`/,
  /\.query\(/,
  /\.execute\(/,
  /\.unsafe\(/,
  /\.begin\(/,
  /_SCHEMA_SQL/,
  /migrate\w*Schema/,
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

// A run of N backticks opens a span and closes at the next run of exactly N on
// the same line. An unmatched run stays. The span, backticks included, is removed.
function stripInlineCode(line) {
  let kept = '';
  let index = 0;
  while (index < line.length) {
    if (line[index] !== '`') {
      kept += line[index];
      index += 1;
      continue;
    }
    let length = 0;
    while (index + length < line.length && line[index + length] === '`') length += 1;
    let cursor = index + length;
    let close = -1;
    while (cursor < line.length) {
      if (line[cursor] !== '`') {
        cursor += 1;
        continue;
      }
      let run = 0;
      while (cursor + run < line.length && line[cursor + run] === '`') run += 1;
      if (run === length) {
        close = cursor;
        break;
      }
      cursor += run;
    }
    if (close === -1) {
      kept += line.slice(index, index + length);
      index += length;
      continue;
    }
    index = close + length;
  }
  return kept;
}

// Indented code is a line of 4+ spaces or a tab that follows a blank line or
// another indented-code line. The first line counts as following a blank line.
// A 4-space line right after ordinary text is a lazy continuation and stays.
function stripCode(input) {
  const lines = input.split(/\r?\n/);
  const kept = [];
  let afterBlank = true;
  let afterIndentedCode = false;
  for (const line of lines) {
    const blank = line.trim() === '';
    const indented = line.startsWith('\t') || line.startsWith('    ');
    if (!blank && indented && (afterBlank || afterIndentedCode)) {
      kept.push('');
      afterBlank = false;
      afterIndentedCode = true;
      continue;
    }
    kept.push(stripInlineCode(line));
    afterBlank = blank;
    afterIndentedCode = false;
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
 * Hide text from the first unclosed `<!--` or `<details` through the end.
 * GitHub treats an unclosed comment or details region as hidden. Closed regions are already gone.
 * @param {string} text
 * @returns {string}
 */
function stripUnclosedRegions(text) {
  const match = /<!--|<details\b/i.exec(text);
  if (!match) return text;
  return text.slice(0, match.index);
}

/**
 * Pull-request body after hidden regions are removed.
 * Hidden regions are fenced code, inline and indented code, HTML comments, `<details>` blocks,
 * and any unclosed `<!--` or `<details` through the end of the text.
 * @param {string | null | undefined} body
 * @returns {string}
 */
export function visibleBody(body) {
  const source = body ?? '';
  return stripUnclosedRegions(stripDetails(stripHtmlComments(stripCode(stripFencedCode(source)))));
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
 * Split a patch into hunks. A line matching `@@ ... @@` starts a hunk and is not part of it.
 * Lines before the first header are one implicit hunk, including a patch that has no `@@` header.
 * A trailing CR is stripped from each line.
 * @param {string} patch
 * @returns {string[][]}
 */
function splitHunks(patch) {
  /** @type {string[][]} */
  const hunks = [[]];
  for (const raw of patch.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (/^@@ .* @@/.test(line)) {
      hunks.push([]);
      continue;
    }
    hunks[hunks.length - 1].push(line);
  }
  return hunks;
}

/**
 * Whether hunk text contains a database anchor.
 * @param {string} text
 * @returns {boolean}
 */
function textHasDatabaseAnchor(text) {
  return DATABASE_ANCHOR_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Whether one hunk touches the database.
 * A changed line that matches a database line pattern always triggers.
 * An explicit hunk (one that follows a `@@` header) also triggers when it has at least one
 * changed line and its full text, context lines included, matches a database anchor.
 * The implicit leading hunk uses changed lines only, so patches without `@@` headers stay on
 * that rule.
 * @param {string[]} lines
 * @param {boolean} afterHeader
 * @returns {boolean}
 */
function hunkTouchesDatabase(lines, afterHeader) {
  let changed = false;
  for (const line of lines) {
    if (!isChangedLine(line)) continue;
    if (lineTouchesDatabase(line)) return true;
    changed = true;
  }
  if (!afterHeader || !changed) return false;
  return textHasDatabaseAnchor(lines.join('\n'));
}

/**
 * Whether a patch touches the database. A missing or empty patch is fail-closed.
 * The patch is split into hunks. Each hunk after a `@@` header triggers when a changed line
 * matches a database line pattern, or when it has a changed line and the hunk text matches a
 * database anchor. Lines before the first header are one implicit hunk and trigger only on
 * changed lines.
 * @param {string | undefined} patch
 * @returns {boolean}
 */
function patchTouchesDatabase(patch) {
  if (patch === undefined || patch === '') return true;
  const hunks = splitHunks(patch);
  for (let index = 0; index < hunks.length; index += 1) {
    if (hunkTouchesDatabase(hunks[index], index > 0)) return true;
  }
  return false;
}

/**
 * Whether one pull-request file requires the database-change marker.
 * A rename also triggers when `previous_filename` is a path trigger.
 * @param {{ filename: string, previous_filename?: string, patch?: string }} file
 * @returns {boolean}
 */
function fileTriggers(file) {
  if (isPathTrigger(file.filename)) return true;
  if (typeof file.previous_filename === 'string' && isPathTrigger(file.previous_filename)) {
    return true;
  }
  if (!isInspectedSource(file.filename)) return false;
  return patchTouchesDatabase(file.patch);
}

/**
 * Decide if the marker is required and whether the body already shows it.
 * `triggers` lists triggering filenames once, in file order.
 * @param {{
 *   body?: string | null,
 *   files?: Array<{
 *     filename: string,
 *     previous_filename?: string,
 *     status?: string,
 *     patch?: string,
 *   }>,
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
