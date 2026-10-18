import { describe, expect, test } from 'bun:test';
import {
  GENERATED_HEADER,
  REPO_ROOT,
  baseKind,
  buildSchemaModel,
  cardinality,
  columnKind,
  compareToCommitted,
  dbType,
  externalSchemaFiles,
  externalSchemaTables,
  generate,
  isEnumCheck,
  readCommitted,
  renderDefault,
  renderPages,
  type ColumnRow,
  type ConstraintRow,
  type IndexRow,
  type SchemaModel,
} from './db-schema-reference';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined || databaseUrl === '') {
  throw new Error('DATABASE_URL is required');
}

describe('docs/database', () => {
  test('docs/database matches the boot schema', async () => {
    const rendered = await generate(databaseUrl);
    const committed = await readCommitted(REPO_ROOT);
    const diff = compareToCommitted(rendered, committed);
    const lines = [
      ...diff.missing.map((file) => `missing: ${file}`),
      ...diff.differing.map((file) => `differs: ${file}`),
      ...diff.stale.map((file) => `stale: ${file}`),
    ];
    if (lines.length > 0) {
      lines.push('Run: bun run db:docs');
    }
    expect(lines).toEqual([]);
  }, 120_000);
});

describe('isEnumCheck', () => {
  test('accepts an ANY-array literal list', () => {
    expect(isEnumCheck(`CHECK ((kind = ANY (ARRAY['a'::text, 'b'::text])))`, 'kind')).toBe(true);
  });

  test('accepts an IN list', () => {
    expect(isEnumCheck(`CHECK ((kind IN ('a', 'b')))`, 'kind')).toBe(true);
  });

  test('accepts a literal list combined with IS NULL', () => {
    expect(
      isEnumCheck(`CHECK (((kind = ANY (ARRAY['a'::text, 'b'::text])) OR kind IS NULL))`, 'kind'),
    ).toBe(true);
  });

  test('rejects a check that also constrains another column', () => {
    expect(isEnumCheck(`CHECK (((kind = ANY (ARRAY['a'::text])) AND (amount > 0)))`, 'kind')).toBe(
      false,
    );
  });

  test('rejects a check on a different column', () => {
    expect(isEnumCheck(`CHECK ((kind = ANY (ARRAY['a'::text, 'b'::text])))`, 'other')).toBe(false);
  });

  test('rejects a numeric range check', () => {
    expect(isEnumCheck(`CHECK ((amount > 0))`, 'amount')).toBe(false);
  });

  test('rejects text that does not start with CHECK', () => {
    expect(isEnumCheck(`kind IN ('a', 'b')`, 'kind')).toBe(false);
  });

  test('accepts a quoted column name', () => {
    expect(isEnumCheck(`CHECK (("kind" = ANY (ARRAY['a'::text, 'b'::text])))`, 'kind')).toBe(true);
  });
});

describe('baseKind / columnKind / dbType', () => {
  test('baseKind maps every catalog branch', () => {
    expect(baseKind('integer', 'int4', false)).toBe('Integer');
    expect(baseKind('bigint', 'int8', false)).toBe('Integer');
    expect(baseKind('smallint', 'int2', false)).toBe('Integer');
    expect(baseKind('numeric', 'numeric', false)).toBe('Decimal');
    expect(baseKind('double precision', 'float8', false)).toBe('Decimal');
    expect(baseKind('real', 'float4', false)).toBe('Decimal');
    expect(baseKind('boolean', 'bool', false)).toBe('Boolean');
    expect(baseKind('timestamp with time zone', 'timestamptz', false)).toBe('Date/time');
    expect(baseKind('date', 'date', false)).toBe('Date/time');
    expect(baseKind('time without time zone', 'time', false)).toBe('Date/time');
    expect(baseKind('text', 'text', false)).toBe('Free text');
    expect(baseKind('character varying', 'varchar', false)).toBe('Free text');
    expect(baseKind('character', 'bpchar', false)).toBe('Free text');
    expect(baseKind('json', 'json', false)).toBe('JSON');
    expect(baseKind('jsonb', 'jsonb', false)).toBe('JSON');
    expect(baseKind('uuid', 'uuid', false)).toBe('UUID');
    expect(baseKind('bytea', 'bytea', false)).toBe('Binary');
    expect(baseKind('ARRAY', '_int4', false)).toBe('Array of integer');
    expect(baseKind('ARRAY', '_int8', false)).toBe('Array of bigint');
    expect(baseKind('ARRAY', '_text', false)).toBe('Array of text');
    expect(baseKind('ARRAY', '_citext', false)).toBe('Array of citext');
    expect(baseKind('USER-DEFINED', 'gift_status', true)).toBe('ENUM');
    expect(baseKind('USER-DEFINED', 'gift_status', false)).toBe('USER-DEFINED');
    expect(baseKind('citext', 'citext', false)).toBe('citext');
  });

  test('columnKind specializes primary keys, foreign keys, and enums', () => {
    expect(
      columnKind({
        base: 'Integer',
        isEnum: false,
        isPrimaryKey: true,
        isAutoIncrement: true,
        isForeignKey: false,
      }),
    ).toBe('Integer (primary key, auto-increment)');
    expect(
      columnKind({
        base: 'Free text',
        isEnum: false,
        isPrimaryKey: true,
        isAutoIncrement: false,
        isForeignKey: false,
      }),
    ).toBe('Free text (primary key)');
    expect(
      columnKind({
        base: 'UUID',
        isEnum: false,
        isPrimaryKey: false,
        isAutoIncrement: false,
        isForeignKey: true,
      }),
    ).toBe('UUID (foreign key)');
    expect(
      columnKind({
        base: 'Free text',
        isEnum: true,
        isPrimaryKey: false,
        isAutoIncrement: false,
        isForeignKey: false,
      }),
    ).toBe('ENUM');
    expect(
      columnKind({
        base: 'Free text',
        isEnum: false,
        isPrimaryKey: false,
        isAutoIncrement: false,
        isForeignKey: false,
      }),
    ).toBe('Free text');
  });

  test('dbType renders length, precision, and array element types', () => {
    expect(
      dbType({
        data_type: 'character varying',
        udt_name: 'varchar',
        character_maximum_length: 32,
        numeric_precision: null,
        numeric_scale: null,
      }),
    ).toBe('character varying(32)');
    expect(
      dbType({
        data_type: 'character',
        udt_name: 'bpchar',
        character_maximum_length: 8,
        numeric_precision: null,
        numeric_scale: null,
      }),
    ).toBe('character(8)');
    expect(
      dbType({
        data_type: 'character',
        udt_name: 'bpchar',
        character_maximum_length: null,
        numeric_precision: null,
        numeric_scale: null,
      }),
    ).toBe('character');
    expect(
      dbType({
        data_type: 'USER-DEFINED',
        udt_name: 'gift_status',
        character_maximum_length: null,
        numeric_precision: null,
        numeric_scale: null,
      }),
    ).toBe('gift_status');
    expect(
      dbType({
        data_type: 'numeric',
        udt_name: 'numeric',
        character_maximum_length: null,
        numeric_precision: 18,
        numeric_scale: 8,
      }),
    ).toBe('numeric(18,8)');
    expect(
      dbType({
        data_type: 'ARRAY',
        udt_name: '_int4',
        character_maximum_length: null,
        numeric_precision: null,
        numeric_scale: null,
      }),
    ).toBe('integer[]');
    expect(
      dbType({
        data_type: 'ARRAY',
        udt_name: '_int8',
        character_maximum_length: null,
        numeric_precision: null,
        numeric_scale: null,
      }),
    ).toBe('bigint[]');
    expect(
      dbType({
        data_type: 'ARRAY',
        udt_name: '_text',
        character_maximum_length: null,
        numeric_precision: null,
        numeric_scale: null,
      }),
    ).toBe('text[]');
    expect(
      dbType({
        data_type: 'timestamp with time zone',
        udt_name: 'timestamptz',
        character_maximum_length: null,
        numeric_precision: null,
        numeric_scale: null,
      }),
    ).toBe('timestamp with time zone');
  });
});

describe('renderDefault', () => {
  test('renders each default branch', () => {
    expect(renderDefault(null, false)).toBe('–');
    expect(renderDefault(null, true)).toBe('auto-increment');
    expect(renderDefault("nextval('gift_id_seq'::regclass)", false)).toBe('auto-increment');
    expect(renderDefault("'none'::text", false)).toBe('`none`');
    expect(renderDefault('now()', false)).toBe('`now()`');
    expect(renderDefault('0', false)).toBe('`0`');
    expect(renderDefault('false', false)).toBe('`false`');
  });
});

describe('cardinality', () => {
  test('covers every nullability and uniqueness pair', () => {
    expect(cardinality(true, false)).toBe('}o--o|');
    expect(cardinality(false, false)).toBe('}o--||');
    expect(cardinality(true, true)).toBe('|o--o|');
    expect(cardinality(false, true)).toBe('|o--||');
  });
});

function column(
  row: Pick<
    ColumnRow,
    'table_name' | 'column_name' | 'ordinal_position' | 'data_type' | 'udt_name'
  > &
    Partial<ColumnRow>,
): ColumnRow {
  return {
    character_maximum_length: null,
    numeric_precision: null,
    numeric_scale: null,
    is_nullable: 'NO',
    column_default: null,
    is_identity: 'NO',
    is_pg_enum: false,
    ...row,
  };
}

function fixture(): {
  columns: ColumnRow[];
  constraints: ConstraintRow[];
  indexes: IndexRow[];
} {
  const columns: ColumnRow[] = [
    column({
      table_name: 'account',
      column_name: 'id',
      ordinal_position: 1,
      data_type: 'uuid',
      udt_name: 'uuid',
    }),
    column({
      table_name: 'account',
      column_name: 'kind',
      ordinal_position: 2,
      data_type: 'text',
      udt_name: 'text',
    }),
    column({
      table_name: 'gift',
      column_name: 'id',
      ordinal_position: 1,
      data_type: 'bigint',
      udt_name: 'int8',
      is_identity: 'YES',
    }),
    column({
      table_name: 'gift',
      column_name: 'account_id',
      ordinal_position: 2,
      data_type: 'uuid',
      udt_name: 'uuid',
    }),
    column({
      table_name: 'gift',
      column_name: 'note',
      ordinal_position: 3,
      data_type: 'text',
      udt_name: 'text',
      is_nullable: 'YES',
      column_default: "'none'::text",
    }),
    column({
      table_name: 'marker',
      column_name: 'id',
      ordinal_position: 1,
      data_type: 'text',
      udt_name: 'text',
    }),
  ];
  const constraints: ConstraintRow[] = [
    {
      table_name: 'account',
      name: 'account_pkey',
      type: 'p',
      columns: ['id'],
      definition: 'PRIMARY KEY (id)',
      ref_table: null,
      ref_columns: [],
    },
    {
      table_name: 'account',
      name: 'account_kind_check',
      type: 'c',
      columns: ['kind'],
      definition: `CHECK ((kind = ANY (ARRAY['a'::text, 'b'::text])))`,
      ref_table: null,
      ref_columns: [],
    },
    {
      table_name: 'gift',
      name: 'gift_pkey',
      type: 'p',
      columns: ['id'],
      definition: 'PRIMARY KEY (id)',
      ref_table: null,
      ref_columns: [],
    },
    {
      table_name: 'gift',
      name: 'gift_account_id_fkey',
      type: 'f',
      columns: ['account_id'],
      definition: 'FOREIGN KEY (account_id) REFERENCES account(id)',
      ref_table: 'account',
      ref_columns: ['id'],
    },
    {
      table_name: 'marker',
      name: 'marker_pkey',
      type: 'p',
      columns: ['id'],
      definition: 'PRIMARY KEY (id)',
      ref_table: null,
      ref_columns: [],
    },
  ];
  const indexes: IndexRow[] = [
    {
      table_name: 'gift',
      name: 'gift_note_key',
      columns: ['note'],
      is_unique: true,
      is_primary: false,
      where: null,
      definition: 'CREATE UNIQUE INDEX gift_note_key ON public.gift USING btree (note)',
    },
  ];
  return { columns, constraints, indexes };
}

function kindOf(model: SchemaModel, tableName: string, columnName: string): string {
  return (
    model.tables
      .find((table) => table.name === tableName)
      ?.columns.find((column) => column.name === columnName)?.kind ?? ''
  );
}

describe('buildSchemaModel and renderPages', () => {
  test('builds kinds, hides enum literals, and renders relations', async () => {
    const { columns, constraints, indexes } = fixture();
    const model = buildSchemaModel(columns, constraints, indexes);
    expect(kindOf(model, 'account', 'id')).toBe('UUID (primary key)');
    expect(kindOf(model, 'account', 'kind')).toBe('ENUM');
    expect(kindOf(model, 'gift', 'id')).toBe('Integer (primary key, auto-increment)');
    expect(kindOf(model, 'gift', 'account_id')).toBe('UUID (foreign key)');
    expect(kindOf(model, 'gift', 'note')).toBe('Free text');
    expect(kindOf(model, 'marker', 'id')).toBe('Free text (primary key)');

    const giftKey = model.tables.find((table) => table.name === 'gift')?.foreignKeys[0];
    expect(giftKey?.unique).toBe(false);
    expect(giftKey?.nullable).toBe(false);

    const pages = await renderPages(model, new Map(), REPO_ROOT);
    const readme = pages.get('docs/database/README.md') ?? '';
    const giftPage = pages.get('docs/database/tables/gift.md') ?? '';
    const accountPage = pages.get('docs/database/tables/account.md') ?? '';
    const markerPage = pages.get('docs/database/tables/marker.md') ?? '';

    for (const page of pages.values()) {
      expect(page.startsWith(GENERATED_HEADER)).toBe(true);
      expect(page.includes(`'a'`)).toBe(false);
    }
    expect(readme).toContain('# Database schema');
    expect(readme).toMatch(/\| Table +\| Source +\| Columns +\| Foreign keys +\|/);
    expect(readme).toContain('- Tables: 3');
    expect(readme).toContain('- Columns: 6');
    expect(readme).toContain('- Foreign keys: 1');
    expect(giftPage).toContain('## Relations');
    expect(giftPage).toContain('erDiagram');
    expect(giftPage).toContain('}o--||');
    expect(accountPage).toContain('## Referenced by');
    expect(accountPage).toContain('gift');
    expect(markerPage).not.toContain('## Relations');
  });

  test('renders the same pages twice and after the input rows are shuffled', async () => {
    const { columns, constraints, indexes } = fixture();
    const sources = new Map<string, string[]>();
    const first = await renderPages(
      buildSchemaModel(columns, constraints, indexes),
      sources,
      REPO_ROOT,
    );
    const second = await renderPages(
      buildSchemaModel(columns, constraints, indexes),
      sources,
      REPO_ROOT,
    );
    expect(second).toEqual(first);

    const shuffled = await renderPages(
      buildSchemaModel([...columns].reverse(), [...constraints].reverse(), [...indexes].reverse()),
      sources,
      REPO_ROOT,
    );
    expect(shuffled).toEqual(first);
  });

  test('links the schema file and says so for tables created outside this service', async () => {
    const { columns, constraints, indexes } = fixture();
    const model = buildSchemaModel(columns, constraints, indexes);
    const pages = await renderPages(
      model,
      new Map(),
      REPO_ROOT,
      new Map([['gift', 'docs/schema/gift.sql']]),
    );
    const giftPage = pages.get('docs/database/tables/gift.md') ?? '';
    const accountPage = pages.get('docs/database/tables/account.md') ?? '';
    const readme = pages.get('docs/database/README.md') ?? '';
    expect(giftPage).toContain('[docs/schema/gift.sql](../../../docs/schema/gift.sql)');
    expect(giftPage).toContain(
      'Created outside this service; definition from docs/schema/gift.sql.',
    );
    expect(accountPage).not.toContain('Created outside this service');
    expect(readme).toContain('[docs/schema/gift.sql](../../docs/schema/gift.sql)');
    expect(readme).toContain('Tables created outside this service are built from their');
  });
});

describe('foreign key uniqueness', () => {
  function textColumn(tableName: string, columnName: string, position: number): ColumnRow {
    return column({
      table_name: tableName,
      column_name: columnName,
      ordinal_position: position,
      data_type: 'text',
      udt_name: 'text',
    });
  }

  function key(
    tableName: string,
    name: string,
    type: ConstraintRow['type'],
    columns: string[],
    refTable: string | null,
    refColumns: string[],
  ): ConstraintRow {
    return {
      table_name: tableName,
      name,
      type,
      columns,
      definition: name,
      ref_table: refTable,
      ref_columns: refColumns,
    };
  }

  test('marks every column of a composite foreign key unique when the child primary key matches that set', () => {
    const model = buildSchemaModel(
      [
        textColumn('parent', 'a', 1),
        textColumn('parent', 'b', 2),
        textColumn('child', 'a', 1),
        textColumn('child', 'b', 2),
      ],
      [
        key('parent', 'parent_pkey', 'p', ['a', 'b'], null, []),
        key('child', 'child_pkey', 'p', ['a', 'b'], null, []),
        key('child', 'child_parent_fkey', 'f', ['a', 'b'], 'parent', ['a', 'b']),
      ],
      [],
    );
    const foreignKeys = model.tables.find((table) => table.name === 'child')?.foreignKeys ?? [];
    expect(foreignKeys).toHaveLength(2);
    expect(foreignKeys.every((foreignKey) => foreignKey.unique)).toBe(true);
  });

  test('does not treat a wider unique or a single covering column as uniqueness of the composite key', () => {
    const wider = buildSchemaModel(
      [
        textColumn('parent', 'a', 1),
        textColumn('parent', 'b', 2),
        textColumn('child', 'a', 1),
        textColumn('child', 'b', 2),
        textColumn('child', 'c', 3),
      ],
      [
        key('parent', 'parent_pkey', 'p', ['a', 'b'], null, []),
        key('child', 'child_pkey', 'p', ['a'], null, []),
        key('child', 'child_abc_key', 'u', ['a', 'b', 'c'], null, []),
        key('child', 'child_parent_fkey', 'f', ['a', 'b'], 'parent', ['a', 'b']),
      ],
      [],
    );
    const widerKeys = wider.tables.find((table) => table.name === 'child')?.foreignKeys ?? [];
    expect(widerKeys).toHaveLength(2);
    expect(widerKeys.every((foreignKey) => foreignKey.unique)).toBe(false);

    const covered = buildSchemaModel(
      [
        textColumn('parent', 'a', 1),
        textColumn('parent', 'b', 2),
        textColumn('child', 'a', 1),
        textColumn('child', 'b', 2),
      ],
      [
        key('parent', 'parent_pkey', 'p', ['a', 'b'], null, []),
        key('child', 'child_a_key', 'u', ['a'], null, []),
        key('child', 'child_parent_fkey', 'f', ['a', 'b'], 'parent', ['a', 'b']),
      ],
      [],
    );
    const coveredKeys = covered.tables.find((table) => table.name === 'child')?.foreignKeys ?? [];
    expect(coveredKeys.every((foreignKey) => foreignKey.unique)).toBe(false);
  });

  test('keeps a single-column foreign key unique when a unique constraint matches that column', () => {
    const model = buildSchemaModel(
      [textColumn('parent', 'id', 1), textColumn('child', 'parent_id', 1)],
      [
        key('parent', 'parent_pkey', 'p', ['id'], null, []),
        key('child', 'child_parent_id_key', 'u', ['parent_id'], null, []),
        key('child', 'child_parent_fkey', 'f', ['parent_id'], 'parent', ['id']),
      ],
      [],
    );
    const foreignKeys = model.tables.find((table) => table.name === 'child')?.foreignKeys ?? [];
    expect(foreignKeys).toHaveLength(1);
    expect(foreignKeys[0]?.unique).toBe(true);
  });
});

describe('externalSchemaFiles / externalSchemaTables', () => {
  const schemaFiles = new Map<string, string>([
    [
      'docs/schema/gift.sql',
      '-- CREATE TABLE commented_out (id int);\nCREATE TABLE IF NOT EXISTS gift (id bigserial PRIMARY KEY);\nCREATE INDEX gift_idx ON gift (id);',
    ],
    ['docs/schema/account.sql', 'CREATE TABLE account (id uuid PRIMARY KEY);'],
    [
      'docs/schema/mixed.sql',
      'CREATE TABLE IF NOT EXISTS account_note (id int);\nCREATE TABLE public."outside" (id int);',
    ],
  ]);
  const sources = new Map<string, string[]>([
    ['account', ['src/lib/account.ts']],
    ['account_note', ['src/lib/note.ts']],
  ]);

  test('a table created in src is excluded', () => {
    expect(
      externalSchemaFiles(
        new Map([['docs/schema/account.sql', 'CREATE TABLE account (id uuid PRIMARY KEY);']]),
        sources,
      ),
    ).toEqual([]);
  });

  test('a table only in docs/schema is included', () => {
    const giftOnly = new Map<string, string>([
      ['docs/schema/gift.sql', schemaFiles.get('docs/schema/gift.sql') ?? ''],
    ]);
    expect(externalSchemaFiles(giftOnly, sources)).toEqual(['docs/schema/gift.sql']);
    expect([...externalSchemaTables(giftOnly, sources)]).toEqual([
      ['gift', 'docs/schema/gift.sql'],
    ]);
  });

  test('a file with two tables, one external, is included', () => {
    const mixed = new Map<string, string>([
      ['docs/schema/mixed.sql', schemaFiles.get('docs/schema/mixed.sql') ?? ''],
    ]);
    expect(externalSchemaFiles(mixed, sources)).toEqual(['docs/schema/mixed.sql']);
    expect([...externalSchemaTables(mixed, sources)]).toEqual([
      ['outside', 'docs/schema/mixed.sql'],
    ]);
  });

  test('the result is sorted and does not depend on the map insertion order', () => {
    expect(externalSchemaFiles(schemaFiles, sources)).toEqual([
      'docs/schema/gift.sql',
      'docs/schema/mixed.sql',
    ]);
    expect(externalSchemaFiles(new Map([...schemaFiles].reverse()), sources)).toEqual([
      'docs/schema/gift.sql',
      'docs/schema/mixed.sql',
    ]);
    expect([...externalSchemaTables(schemaFiles, sources).keys()]).toEqual(['gift', 'outside']);
  });

  test('the first schema file in sorted order wins for a table defined twice', () => {
    const duplicated = new Map<string, string>([
      ['docs/schema/b.sql', 'CREATE TABLE dup (id int);'],
      ['docs/schema/a.sql', 'CREATE TABLE dup (id int);'],
    ]);
    expect([...externalSchemaTables(duplicated, new Map())]).toEqual([
      ['dup', 'docs/schema/a.sql'],
    ]);
    expect(externalSchemaFiles(duplicated, new Map())).toEqual([
      'docs/schema/a.sql',
      'docs/schema/b.sql',
    ]);
  });
});

describe('compareToCommitted', () => {
  test('reports missing, differing, and stale paths in sorted order', () => {
    const rendered = new Map<string, string>([
      ['z.md', 'only rendered'],
      ['m.md', 'changed'],
      ['a.md', 'same'],
      ['b.md', 'also missing'],
    ]);
    const committed = new Map<string, string>([
      ['m.md', 'original'],
      ['a.md', 'same'],
      ['s.md', 'only committed'],
      ['c.md', 'also stale'],
    ]);
    expect(compareToCommitted(rendered, committed)).toEqual({
      missing: ['b.md', 'z.md'],
      differing: ['m.md'],
      stale: ['c.md', 's.md'],
    });
  });
});
