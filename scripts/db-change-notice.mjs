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
  /\.query\s*(?:<[^()]*>)?\s*\(/,
  /\.execute\s*(?:<[^()]*>)?\s*\(/,
  /\.unsafe\s*(?:<[^()]*>)?\s*\(/,
  /\.begin\s*(?:<[^()]*>)?\s*\(/,
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
 * Patterns that mark a source file as accessing the database.
 * @type {RegExp[]}
 */
const DATABASE_FILE_PATTERNS = [
  /^\s*import\s+(?:type\s+)?[\w$*{},\s]+?\bfrom\s*['"]@\/lib\/auth\/sql['"]/m,
  /^\s*import\s+(?:type\s+)?[\w$*{},\s]+?\bfrom\s*['"]\.\/sql['"]/m,
  /^\s*import\s+(?:type\s+)?[\w$*{},\s]+?\bfrom\s*['"](?:\.\.?\/)+(?:[^'"]*\/)?auth\/sql['"]/m,
  /^\s*import\s+(?:type\s+)?\{[^}]*\bSQL\b[^}]*\}\s*from\s*['"]bun['"]/m,
  /_SCHEMA_SQL/,
  /migrate\w*Schema/,
];

/**
 * Patterns that mark hunk text as a database call or schema helper.
 * Used when any explicit hunk of the patch contains an anchor on a changed or context line:
 * every explicit hunk that has a changed line then triggers. The implicit leading hunk does
 * not use anchors.
 * @type {RegExp[]}
 */
const DATABASE_ANCHOR_PATTERNS = [
  /sql`/,
  /\.query\s*(?:<[^()]*>)?\s*\(/,
  /\.execute\s*(?:<[^()]*>)?\s*\(/,
  /\.unsafe\s*(?:<[^()]*>)?\s*\(/,
  /\.begin\s*(?:<[^()]*>)?\s*\(/,
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
 * Remove fenced code blocks. A fence opens on a line of at least three backticks or tildes,
 * including after nested list-item or blockquote prefixes and up to three extra spaces. It closes
 * only on a line whose prefixed content is just a fence of the same character, at least as long as
 * the opener, so a line such as ```sql does not close a fence. One trailing CR is ignored.
 * @param {string} text
 * @returns {string}
 */
function stripFencedCode(text) {
  /** @type {string[]} */
  const kept = [];
  /** @type {{ mark: string, length: number } | null} */
  let open = null;
  const listItemPrefix = /[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]/.source;
  const blockquotePrefix = /[ \t]{0,3}>[ \t]?/.source;
  const extraIndent = /[ \t]{0,3}/.source;
  const containers = `(?:(?:${listItemPrefix})|(?:${blockquotePrefix}))*${extraIndent}`;
  const fence = /(`{3,}|~{3,})/.source;
  const opener = new RegExp(`^${containers}${fence}`);
  const closer = new RegExp(`^${containers}${fence}[ \\t]*$`);
  for (const line of text.split('\n')) {
    const bare = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (open) {
      const match = closer.exec(bare);
      if (match && match[1][0] === open.mark && match[1].length >= open.length) open = null;
      continue;
    }
    const match = opener.exec(line);
    if (match) {
      open = { mark: match[1][0], length: match[1].length };
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

// A run of N backticks opens a span and closes at the next run of exactly N in the
// same paragraph. An unmatched run stays. The span, backticks included, is removed.
function stripInlineCode(paragraph) {
  let kept = '';
  let index = 0;
  while (index < paragraph.length) {
    if (paragraph[index] !== '`') {
      kept += paragraph[index];
      index += 1;
      continue;
    }
    let length = 0;
    while (index + length < paragraph.length && paragraph[index + length] === '`') {
      length += 1;
    }
    let cursor = index + length;
    let close = -1;
    while (cursor < paragraph.length) {
      if (paragraph[cursor] !== '`') {
        cursor += 1;
        continue;
      }
      let run = 0;
      while (cursor + run < paragraph.length && paragraph[cursor + run] === '`') {
        run += 1;
      }
      if (run === length) {
        close = cursor;
        break;
      }
      cursor += run;
    }
    if (close === -1) {
      kept += paragraph.slice(index, index + length);
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
    kept.push(line);
    afterBlank = blank;
    afterIndentedCode = false;
  }

  const visible = [];
  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    visible.push(...stripInlineCode(paragraph.join('\n')).split('\n'));
    paragraph = [];
  };
  for (const line of kept) {
    if (line.trim() === '') {
      flushParagraph();
      visible.push(line);
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return visible.join('\n');
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
 * Whether the complete source file imports a database client or defines schema work.
 * @param {string} content
 * @returns {boolean}
 */
function contentTouchesDatabase(content) {
  return DATABASE_FILE_PATTERNS.some((pattern) => pattern.test(content));
}

/**
 * Whether a diff line is an added or removed content line.
 * Before the first `@@` header, lines matching `--- a/`, `--- /dev/null`, `+++ b/`, or
 * `+++ /dev/null` are file headers and are not content. After that header, any line that
 * starts with `+` or `-` is a changed line, including lines that start with `---` or `+++`.
 * @param {string} line
 * @param {boolean} afterHeader
 * @returns {boolean}
 */
function isChangedLine(line, afterHeader) {
  if (
    !afterHeader &&
    (/^--- (?:a\/|\/dev\/null)/.test(line) || /^\+\+\+ (?:b\/|\/dev\/null)/.test(line))
  ) {
    return false;
  }
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
 * A changed line that matches a database line pattern always triggers. `afterHeader` is passed
 * to the changed-line test: file headers count only before the first `@@`. Otherwise an
 * explicit hunk triggers when it has a changed line and `patchAnchored` is true.
 * @param {string[]} lines
 * @param {boolean} afterHeader
 * @param {boolean} patchAnchored
 * @returns {boolean}
 */
function hunkTouchesDatabase(lines, afterHeader, patchAnchored) {
  let changed = false;
  for (const line of lines) {
    if (!isChangedLine(line, afterHeader)) continue;
    if (lineTouchesDatabase(line)) return true;
    changed = true;
  }
  if (afterHeader && changed && patchAnchored) return true;
  return false;
}

/**
 * Whether a patch touches the database. A missing or empty patch is fail-closed.
 * The patch is anchored when any explicit hunk (after a `@@` header) contains a database
 * anchor on a changed or context line. Every explicit hunk that has a changed line then
 * triggers. The implicit leading hunk, before the first `@@`, triggers only when a changed
 * line matches a database line pattern.
 * @param {string | undefined} patch
 * @returns {boolean}
 */
function patchTouchesDatabase(patch) {
  if (patch === undefined || patch === '') return true;
  const hunks = splitHunks(patch);
  const patchAnchored = hunks.some(
    (lines, index) => index > 0 && textHasDatabaseAnchor(lines.join('\n')),
  );
  for (let index = 0; index < hunks.length; index += 1) {
    if (hunkTouchesDatabase(hunks[index], index > 0, patchAnchored)) return true;
  }
  return false;
}

/**
 * Whether one pull-request file requires the database-change marker.
 * A rename also triggers when `previous_filename` is a path trigger.
 * A rename scans the patch when either the current path or `previous_filename` is an
 * inspected source. An absent patch stays fail-closed.
 * @param {{
 *   filename: string,
 *   previous_filename?: string,
 *   patch?: string,
 *   content?: string,
 * }} file
 * @returns {boolean}
 */
function fileTriggers(file) {
  if (isPathTrigger(file.filename)) return true;
  if (typeof file.previous_filename === 'string' && isPathTrigger(file.previous_filename)) {
    return true;
  }
  const inspected =
    isInspectedSource(file.filename) ||
    (typeof file.previous_filename === 'string' && isInspectedSource(file.previous_filename));
  if (!inspected) return false;
  if (typeof file.content === 'string' && contentTouchesDatabase(file.content)) return true;
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
 *     content?: string,
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
