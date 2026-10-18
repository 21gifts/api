#!/usr/bin/env node
/**
 * Tests for the database-change notice check. No extra packages.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MARKER, evaluate, isMarkerVisible, visibleBody } from './db-change-notice.mjs';

const PLAIN_MARKER = MARKER.replaceAll('\uFE0F', '');

/**
 * Build a one-file pull-request list.
 * @param {string} filename
 * @param {string | undefined} patch Omit the patch when `patch` is `undefined`.
 * @returns {Array<{ filename: string, status: string, patch?: string }>}
 */
function files(filename, patch) {
  /** @type {{ filename: string, status: string, patch?: string }} */
  const entry = { filename, status: 'modified' };
  if (patch !== undefined) entry.patch = patch;
  return [entry];
}

/**
 * Unified diff whose only changed content line is `line`.
 * @param {string} line
 * @returns {string}
 */
function diffWith(line) {
  return `--- a/src/lib/gift.ts\n+++ b/src/lib/gift.ts\n${line}\n`;
}

describe('path triggers', () => {
  it('triggers for docs/schema, docs/database, integration, and boot-stores', () => {
    const names = [
      'docs/schema/gift.sql',
      'docs/database/overview.md',
      'integration/gift.test.ts',
      'src/lib/boot-stores.ts',
    ];
    for (const filename of names) {
      const result = evaluate({
        body: '',
        files: files(filename, diffWith('+export const n = 1;')),
      });
      assert.deepEqual(result.triggers, [filename]);
      assert.equal(result.required, true);
      assert.equal(result.ok, false);
    }
  });

  it('keeps the first filename order and drops duplicates', () => {
    const result = evaluate({
      body: MARKER,
      files: [
        ...files('docs/schema/a.sql', ''),
        ...files('README.md', diffWith('+db.query(1);')),
        ...files('docs/schema/a.sql', ''),
        ...files('integration/run.ts'),
      ],
    });
    assert.deepEqual(result.triggers, ['docs/schema/a.sql', 'integration/run.ts']);
    assert.equal(result.ok, true);
  });
});

describe('patch triggers under src', () => {
  /** @type {Array<[string, string]>} */
  const patterns = [
    ['_SCHEMA_SQL', '+const q = _SCHEMA_SQL;'],
    ['migrateSchema', '+await migrateUserSchema();'],
    ['sql tag', '+const q = sql`select 1`;'],
    ['.query(', '+await db.query(text);'],
    ['.execute(', '+await db.execute(text);'],
    ['.unsafe(', '+await sql.unsafe(text);'],
    ['.begin(', '+await sql.begin(async () => {});'],
    ['SELECT FROM', '+const q = "select id from gift";'],
    ['INSERT INTO', '+const q = "INSERT INTO gift values (1)";'],
    ['UPDATE SET', '+const q = "UPDATE gift SET name = 1";'],
    ['DELETE FROM', '+const q = "delete from gift";'],
    ['CREATE INDEX', '+const q = "CREATE INDEX gift_idx ON gift (id)";'],
    ['CREATE UNIQUE INDEX', '+const q = "create unique index gift_idx on gift (id)";'],
    ['CREATE TABLE', '+const q = "CREATE TABLE gift (id int)";'],
    ['ALTER TABLE', '+const q = "alter table gift add column n int";'],
    ['DROP TABLE', '+const q = "DROP TABLE gift";'],
    ['DROP INDEX', '+const q = "drop index gift_idx";'],
    ['ON CONFLICT', '+const q = "ON CONFLICT DO NOTHING";'],
    ['CREATE TRIGGER', '+const q = "CREATE TRIGGER touch_gift";'],
    ['removed line', '-await db.query(text);'],
  ];

  for (const [name, line] of patterns) {
    it(`triggers on ${name}`, () => {
      const result = evaluate({
        body: '',
        files: files('src/lib/gift.ts', diffWith(line)),
      });
      assert.deepEqual(result.triggers, ['src/lib/gift.ts']);
      assert.equal(result.required, true);
      assert.equal(result.ok, false);
    });
  }

  it('fail-closes when a src TypeScript patch is missing or empty', () => {
    for (const patch of [undefined, '']) {
      const result = evaluate({ body: '', files: files('src/domain/gift.ts', patch) });
      assert.deepEqual(result.triggers, ['src/domain/gift.ts']);
      assert.equal(result.ok, false);
    }
  });
});

describe('non-triggers', () => {
  it('ignores SQL under src/__tests__', () => {
    for (const filename of ['src/__tests__/gift.test.ts', 'src/lib/__tests__/gift.test.ts']) {
      const result = evaluate({
        body: '',
        files: files(filename, diffWith('+const q = "SELECT id FROM gift";')),
      });
      assert.deepEqual(result.triggers, []);
      assert.equal(result.required, false);
      assert.equal(result.ok, true);
    }
  });

  it('ignores a TypeScript edit that does not touch the database', () => {
    const result = evaluate({
      body: '',
      files: files('src/lib/gift.ts', diffWith('+export const n = 1;')),
    });
    assert.deepEqual(result, { required: false, ok: true, triggers: [] });
  });

  it('ignores a non-src file even when the patch contains SQL', () => {
    const result = evaluate({
      body: undefined,
      files: files('README.md', diffWith('+const q = "DELETE FROM gift";')),
    });
    assert.equal(result.ok, true);
    assert.equal(result.required, false);
  });

  it('ignores +++ and --- header lines', () => {
    const patches = [
      [
        '--- a/src/lib/gift.ts',
        '+++ b/src/lib/gift.ts',
        ' context line .query(',
        '+export const n = 1;',
      ],
      ['--- /dev/null', '+++ b/src/lib/gift.ts', '+export const n = 1;'],
    ];
    for (const lines of patches) {
      const result = evaluate({ body: '', files: files('src/lib/gift.ts', lines.join('\n')) });
      assert.deepEqual(result.triggers, []);
    }
  });

  it('stays ok with no files when the body is empty or omitted', () => {
    assert.deepEqual(evaluate({ body: '', files: [] }), {
      required: false,
      ok: true,
      triggers: [],
    });
    assert.deepEqual(evaluate({ body: undefined, files: [] }), {
      required: false,
      ok: true,
      triggers: [],
    });
    assert.deepEqual(evaluate({ files: [] }), { required: false, ok: true, triggers: [] });
  });
});

describe('marker visibility', () => {
  const hidden = [
    ['details', `<details>\n${MARKER}\n</details>`],
    [
      'nested details',
      `<details>\n<details open>\n${MARKER}\n</details>\nstill hidden\n</details>`,
    ],
    ['details any case', `<DETAILS>\n${MARKER}\n</DETAILS>`],
    ['backtick fence', `\`\`\`md\n${MARKER}\n\`\`\``],
    ['tilde fence', `~~~\n${MARKER}\n~~~`],
    ['html comment', `<!--\n${MARKER}\n-->`],
  ];

  for (const [name, body] of hidden) {
    it(`rejects a marker that is only inside ${name}`, () => {
      assert.equal(isMarkerVisible(body), false);
      assert.equal(visibleBody(body).includes(PLAIN_MARKER), false);
      const result = evaluate({ body, files: files('docs/schema/gift.sql', '') });
      assert.equal(result.required, true);
      assert.equal(result.ok, false);
    });
  }

  it('accepts the marker on its own line, including without U+FE0F', () => {
    assert.notEqual(PLAIN_MARKER, MARKER);
    assert.equal(isMarkerVisible(`note\n${MARKER}\n`), true);
    assert.equal(isMarkerVisible(`\n  ${PLAIN_MARKER}  \n`), true);
    const result = evaluate({
      body: PLAIN_MARKER,
      files: files('src/lib/boot-stores.ts', '+export const n = 1;'),
    });
    assert.equal(result.required, true);
    assert.equal(result.ok, true);
  });

  it('rejects the marker when the same line has other text', () => {
    assert.equal(isMarkerVisible(`see ${MARKER}`), false);
    assert.equal(isMarkerVisible(`${MARKER} now`), false);
    const result = evaluate({
      body: `see ${MARKER}`,
      files: files('integration/job.ts'),
    });
    assert.equal(result.ok, false);
  });

  it('keeps a marker that sits outside a nested details block', () => {
    const body = `<details><details>\nhidden\n</details></details>\n${MARKER}\n`;
    assert.equal(isMarkerVisible(body), true);
    assert.equal(visibleBody(body).includes('hidden'), false);
  });

  it('a ```sql line does not close a fence', () => {
    const body = `\`\`\`md\n\`\`\`sql\n${MARKER}\n\`\`\``;
    assert.equal(isMarkerVisible(body), false);
    const result = evaluate({ body, files: files('docs/schema/gift.sql', '') });
    assert.equal(result.ok, false);
  });

  it('a marker after a properly closed fence is visible', () => {
    const body = `\`\`\`md\nsample\n\`\`\`\n${MARKER}\n`;
    assert.equal(isMarkerVisible(body), true);
  });

  it('hides a marker inside a list-item fence', () => {
    const body = `- \`\`\`text\n  ${MARKER}\n  \`\`\``;
    assert.equal(isMarkerVisible(body), false);
  });

  it('hides a marker inside a blockquote fence', () => {
    const body = `> \`\`\`\`\n> ${MARKER}\n> \`\`\`\``;
    assert.equal(isMarkerVisible(body), false);
  });

  it('keeps a marker after a closed list-item fence visible', () => {
    const body = `- \`\`\`text\n  sample\n  \`\`\`\n${MARKER}`;
    assert.equal(isMarkerVisible(body), true);
  });

  it('a four-backtick opener is not closed by a three-backtick line', () => {
    const body = `\`\`\`\`\n\`\`\`\n${MARKER}\n\`\`\`\``;
    assert.equal(isMarkerVisible(body), false);
  });
});

it('a </details> inside inline code does not reveal a hidden marker', () => {
  const body = '<details>\n`</details>`\n\n⚠️ 🗄️ Attention: database change\n\n</details>';
  assert.equal(isMarkerVisible(body), false);
});

it('a </details> inside indented code does not reveal a hidden marker', () => {
  const body = '<details>\n\n    </details>\n\n⚠️ 🗄️ Attention: database change\n\n</details>';
  assert.equal(isMarkerVisible(body), false);
});

it('a visible marker next to inline code stays visible', () => {
  assert.equal(isMarkerVisible('Uses `sql.query`.\n\n⚠️ 🗄️ Attention: database change'), true);
});

describe('hunk anchors', () => {
  it('triggers when the changed line sits in a hunk whose context has an anchor', () => {
    const patch = '@@ -1,3 +1,3 @@\n await sql.query(`\n+  WHERE id = $1\n )\n';
    const result = evaluate({ body: '', files: files('src/lib/gift.ts', patch) });
    assert.deepEqual(result.triggers, ['src/lib/gift.ts']);
  });

  it('does not trigger when the same added line has no anchor in the hunk', () => {
    const patch = '@@ -1,3 +1,3 @@\n const a = 1;\n+  WHERE id = $1\n const b = 2;\n';
    const result = evaluate({ body: '', files: files('src/lib/gift.ts', patch) });
    assert.deepEqual(result.triggers, []);
  });

  it('triggers when the anchor and the changed line are in different hunks', () => {
    const patch = [
      '@@ -1,2 +1,2 @@',
      ' await sql.query(`',
      ' const keep = 1;',
      '@@ -8,2 +8,3 @@',
      ' const a = 1;',
      '+  WHERE id = $1',
      ' const b = 2;',
    ].join('\n');
    const result = evaluate({ body: '', files: files('src/lib/gift.ts', patch) });
    assert.deepEqual(result.triggers, ['src/lib/gift.ts']);
  });

  it('does not trigger when no hunk has an anchor', () => {
    const patch = [
      '@@ -1,2 +1,3 @@',
      ' const a = 1;',
      '+  WHERE id = $1',
      '@@ -8,2 +8,1 @@',
      ' const a = 1;',
      '-const old = 2;',
    ].join('\n');
    const result = evaluate({ body: '', files: files('src/lib/gift.ts', patch) });
    assert.deepEqual(result.triggers, []);
  });

  it('counts a removed line that starts with --- after the first @@', () => {
    const patch = '@@ -1,3 +1,2 @@\n await sql.query(`\n--- SELECT 1 FROM gift\n )\n';
    const result = evaluate({ body: '', files: files('src/lib/gift.ts', patch) });
    assert.deepEqual(result.triggers, ['src/lib/gift.ts']);
  });

  it('counts a removed --- line through the anchor alone', () => {
    const patch = '@@ -1,3 +1,2 @@\n await sql.query(`\n--- plain comment\n )\n';
    const result = evaluate({ body: '', files: files('src/lib/gift.ts', patch) });
    assert.deepEqual(result.triggers, ['src/lib/gift.ts']);
  });

  it('counts an added +++ line after the first @@', () => {
    const patch = '@@ -1,2 +1,3 @@\n await sql.query(`\n+++ plain note\n )\n';
    const result = evaluate({ body: '', files: files('src/lib/gift.ts', patch) });
    assert.deepEqual(result.triggers, ['src/lib/gift.ts']);
  });

  it('does not count a --- line after @@ when no anchor exists', () => {
    const patch = '@@ -1,2 +1,1 @@\n const a = 1;\n--- plain comment\n';
    const result = evaluate({ body: '', files: files('src/lib/gift.ts', patch) });
    assert.deepEqual(result.triggers, []);
  });

  it('triggers on a schema-qualified or quoted UPDATE', () => {
    for (const line of ['+UPDATE public.gift SET x = 1', '+UPDATE "gift" SET x = 1']) {
      const result = evaluate({
        body: '',
        files: files('src/lib/gift.ts', diffWith(line)),
      });
      assert.deepEqual(result.triggers, ['src/lib/gift.ts']);
    }
  });
});

describe('renames', () => {
  it('triggers when the previous path is a path trigger', () => {
    const result = evaluate({
      files: [
        {
          filename: 'archive/gift.sql',
          previous_filename: 'docs/schema/gift.sql',
          status: 'renamed',
          patch: '',
        },
      ],
    });
    assert.equal(result.required, true);
    assert.deepEqual(result.triggers, ['archive/gift.sql']);
  });

  it('does not trigger a rename between two non-trigger paths', () => {
    const result = evaluate({
      files: [
        {
          filename: 'notes/b.md',
          previous_filename: 'notes/a.md',
          status: 'renamed',
          patch: '',
        },
      ],
    });
    assert.equal(result.required, false);
    assert.deepEqual(result.triggers, []);
  });

  it('scans the patch when the previous path is an inspected source', () => {
    const result = evaluate({
      files: [
        {
          filename: 'docs/x.ts',
          previous_filename: 'src/lib/x.ts',
          status: 'renamed',
          patch: '@@ -1 +1 @@\n-const q = "SELECT id FROM gift";\n+const q = 1;\n',
        },
      ],
    });
    assert.deepEqual(result.triggers, ['docs/x.ts']);
    assert.equal(result.required, true);
  });

  it('fails closed on a rename from an inspected source without a patch', () => {
    const result = evaluate({
      files: [
        {
          filename: 'docs/x.ts',
          previous_filename: 'src/lib/x.ts',
          status: 'renamed',
        },
      ],
    });
    assert.deepEqual(result.triggers, ['docs/x.ts']);
  });

  it('does not trigger on a rename from an inspected source when the patch has no database content', () => {
    const result = evaluate({
      files: [
        {
          filename: 'docs/x.ts',
          previous_filename: 'src/lib/x.ts',
          status: 'renamed',
          patch: '@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n',
        },
      ],
    });
    assert.deepEqual(result.triggers, []);
  });
});

describe('unclosed hidden regions', () => {
  it('hides a marker after an unclosed details tag', () => {
    assert.equal(isMarkerVisible(`<details>\nsummary\n${MARKER}\n`), false);
    assert.equal(isMarkerVisible(`<DETAILS open>\nsummary\n${MARKER}\n`), false);
  });

  it('hides a marker after an unclosed HTML comment', () => {
    assert.equal(isMarkerVisible(`<!--\n${MARKER}\n`), false);
  });

  it('keeps a marker that sits before an unclosed region', () => {
    assert.equal(isMarkerVisible(`${MARKER}\n<details>\nhidden\n`), true);
    assert.equal(isMarkerVisible(`${MARKER}\n<!--\nhidden\n`), true);
  });

  it('fails evaluate when the marker is only after an unclosed details tag', () => {
    const result = evaluate({
      body: `<details>\nsummary\n${MARKER}\n`,
      files: files('docs/schema/gift.sql', ''),
    });
    assert.equal(result.required, true);
    assert.equal(result.ok, false);
  });
});

describe('generic database calls', () => {
  it('triggers on a change in the middle of a sql.query<Row>( statement', () => {
    const patch =
      '@@ -326,5 +326,5 @@\n    const rows = await this.#sql.query<{ id: string }>(\n      `UPDATE pos_charge\n-       SET state = $2\n+       SET state = $3\n        WHERE id = $1`,';
    const result = evaluate({ body: '', files: files('src/lib/pos-store.ts', patch) });
    assert.deepEqual(result.triggers, ['src/lib/pos-store.ts']);
  });

  it('triggers on a changed sql.execute<Row>( line', () => {
    const result = evaluate({
      body: '',
      files: files('src/lib/pos-store.ts', diffWith('+  await sql.execute<void>(text, params);')),
    });
    assert.deepEqual(result.triggers, ['src/lib/pos-store.ts']);
  });
});
