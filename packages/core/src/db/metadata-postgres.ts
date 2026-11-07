import { DbError } from './errors.js';
import {
  ok,
  type ColumnDetail,
  type DatabaseInfo,
  type Definition,
  type IndexInfo,
  type KeyInfo,
  type MetadataReader,
  type MetadataResult,
  type ObjectInfo,
  type ObjectKind,
  type SchemaInfo,
  type TableDetail,
} from './metadata.js';

type Query = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

const RELKINDS: Record<string, ObjectKind> = {
  r: 'table',
  p: 'partitioned_table',
  v: 'view',
  m: 'materialized_view',
  f: 'foreign_table',
};
const PROKINDS: Record<string, ObjectKind> = { f: 'function', w: 'function', p: 'procedure', a: 'aggregate' };
const CONTYPES: Record<string, KeyInfo['type']> = {
  p: 'primary',
  u: 'unique',
  f: 'foreign',
  c: 'check',
  x: 'exclusion',
};

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const bool = (v: unknown) => v === true || v === 't' || v === 'true';
/** Arrays are selected as JSON (values stay text in this pool), so names with commas survive. */
function textArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  const parsed: unknown = JSON.parse(String(v ?? '[]'));
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

const quoteIdent = (name: string) =>
  /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;

/** Extension members (for example pg_stat_statements views) are left out of object lists. */
const NOT_EXTENSION_MEMBER = (oid: string, classid: string) =>
  `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = '${classid}'::regclass AND d.objid = ${oid} AND d.deptype = 'e')`;

export class PostgresMetadata implements MetadataReader {
  constructor(
    private readonly query: Query,
    private readonly defaultSchema: string | null,
  ) {}

  async databases(): Promise<MetadataResult<DatabaseInfo>> {
    const rows = await this.query(`
      SELECT datname AS name, datname = current_database() AS current
        FROM pg_database
       WHERE NOT datistemplate AND datallowconn
       ORDER BY datname = current_database() DESC, datname`);
    return ok(
      rows.map((r) => ({
        name: String(r.name),
        current: bool(r.current),
        browsable: bool(r.current),
        system: r.name === 'postgres',
      })),
    );
  }

  async schemas(): Promise<MetadataResult<SchemaInfo>> {
    const rows = await this.query(`
      SELECT nspname AS name,
             (nspname IN ('pg_catalog', 'information_schema') OR nspname LIKE 'pg\\_%') AS system,
             has_schema_privilege(oid, 'USAGE') AS usable
        FROM pg_namespace
       WHERE nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp\\_%'
       ORDER BY 2, 1`);
    return ok(rows.map((r) => ({ name: String(r.name), system: bool(r.system), usable: bool(r.usable) })));
  }

  async objects(schema: string): Promise<MetadataResult<ObjectInfo>> {
    const [ns] = await this.query(
      'SELECT oid, has_schema_privilege(oid, $2) AS usable FROM pg_namespace WHERE nspname = $1',
      [schema, 'USAGE'],
    );
    if (!ns) return { status: 'unavailable', items: [], reason: `Schema ${schema} does not exist.` };
    const relations = await this.query(
      `SELECT c.relname AS name, c.relkind AS kind, obj_description(c.oid, 'pg_class') AS comment,
              has_table_privilege(c.oid, 'SELECT') AS accessible,
              CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS estimate
         FROM pg_class c
        WHERE c.relnamespace = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition
          AND ${NOT_EXTENSION_MEMBER('c.oid', 'pg_class')}
        ORDER BY c.relname`,
      [ns.oid],
    );
    const routines = await this.query(
      `SELECT p.proname AS name, p.prokind AS kind, pg_get_function_identity_arguments(p.oid) AS signature,
              pg_get_function_result(p.oid) AS returns, obj_description(p.oid, 'pg_proc') AS comment,
              has_function_privilege(p.oid, 'EXECUTE') AS accessible
         FROM pg_proc p
        WHERE p.pronamespace = $1 AND ${NOT_EXTENSION_MEMBER('p.oid', 'pg_proc')}
        ORDER BY p.proname, 3`,
      [ns.oid],
    );
    const items: ObjectInfo[] = [
      ...relations.map((r) => ({
        schema,
        name: String(r.name),
        kind: RELKINDS[String(r.kind)] ?? 'table',
        comment: str(r.comment),
        accessible: bool(r.accessible),
        rowEstimate: r.estimate === null || r.estimate === undefined ? null : Number(r.estimate),
      })),
      ...routines.map((r) => ({
        schema,
        name: String(r.name),
        kind: PROKINDS[String(r.kind)] ?? 'function',
        signature: String(r.signature ?? ''),
        returns: str(r.returns),
        comment: str(r.comment),
        accessible: bool(r.accessible),
      })),
    ];
    if (!bool(ns.usable)) {
      return {
        status: 'insufficient_permission',
        items,
        reason: `The account has no USAGE privilege on schema ${schema}; its objects are listed but cannot be queried.`,
      };
    }
    return ok(items);
  }

  async table(schema: string, name: string): Promise<TableDetail | null> {
    const [rel] = await this.query(
      `SELECT c.oid, c.relkind AS kind, obj_description(c.oid, 'pg_class') AS comment
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`,
      [schema, name],
    );
    if (!rel) return null;
    const oid = rel.oid;
    const kind = RELKINDS[String(rel.kind)] ?? 'table';
    const columns = (
      await this.query(
        `SELECT a.attnum AS position, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
                NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS default_value,
                col_description(a.attrelid, a.attnum) AS comment, a.attidentity AS identity, a.attgenerated AS generated
           FROM pg_attribute a
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`,
        [oid],
      )
    ).map((r): ColumnDetail => ({
      position: Number(r.position),
      name: String(r.name),
      type: String(r.type),
      nullable: bool(r.nullable),
      default: r.generated === 's' ? null : str(r.default_value),
      comment: str(r.comment),
      identity: r.identity === 'a' ? 'always' : r.identity === 'd' ? 'by default' : null,
      generated: r.generated === 's' ? str(r.default_value) : null,
    }));
    const keys = (
      await this.query(
        `SELECT con.conname AS name, con.contype AS type, pg_get_constraintdef(con.oid, true) AS definition,
                to_json(ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, ord)
                        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.ord)) AS columns,
                fn.nspname AS ref_schema, fc.relname AS ref_table,
                to_json(ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, ord)
                        JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.ord)) AS ref_columns
           FROM pg_constraint con
           LEFT JOIN pg_class fc ON fc.oid = con.confrelid
           LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
          WHERE con.conrelid = $1
          ORDER BY CASE con.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2 ELSE 3 END, con.conname`,
        [oid],
      )
    ).map((r): KeyInfo => ({
      name: String(r.name),
      type: CONTYPES[String(r.type)] ?? 'check',
      columns: textArray(r.columns),
      ...(r.type === 'f'
        ? {
            references: {
              schema: String(r.ref_schema),
              table: String(r.ref_table),
              columns: textArray(r.ref_columns),
            },
          }
        : {}),
      definition: str(r.definition),
    }));
    const indexes = (
      await this.query(
        `SELECT i.relname AS name, x.indisunique AS unique, x.indisprimary AS primary, am.amname AS method,
                pg_get_indexdef(x.indexrelid) AS definition,
                to_json(ARRAY(SELECT pg_get_indexdef(x.indexrelid, k, true) FROM generate_series(1, x.indnkeyatts) k ORDER BY k)) AS columns
           FROM pg_index x
           JOIN pg_class i ON i.oid = x.indexrelid
           JOIN pg_am am ON am.oid = i.relam
          WHERE x.indrelid = $1
          ORDER BY x.indisprimary DESC, i.relname`,
        [oid],
      )
    ).map((r): IndexInfo => ({
      name: String(r.name),
      unique: bool(r.unique),
      primary: bool(r.primary),
      method: str(r.method),
      columns: textArray(r.columns),
      definition: str(r.definition),
    }));

    let definition: Definition;
    if (kind === 'view' || kind === 'materialized_view') {
      const [view] = await this.query('SELECT pg_get_viewdef($1::oid, true) AS text', [oid]);
      definition = {
        status: 'ok',
        text: `CREATE ${kind === 'view' ? 'VIEW' : 'MATERIALIZED VIEW'} ${quoteIdent(schema)}.${quoteIdent(name)} AS\n${String(view?.text ?? '').trimEnd()}`,
      };
    } else {
      const lines = [
        ...columns.map(
          (c) =>
            `  ${quoteIdent(c.name)} ${c.type}${c.identity ? ` GENERATED ${c.identity.toUpperCase()} AS IDENTITY` : ''}${
              c.generated ? ` GENERATED ALWAYS AS (${c.generated}) STORED` : ''
            }${c.default ? ` DEFAULT ${c.default}` : ''}${c.nullable ? '' : ' NOT NULL'}`,
        ),
        ...keys.map((k) => `  CONSTRAINT ${quoteIdent(k.name)} ${k.definition ?? ''}`),
      ];
      definition = {
        status: 'ok',
        reconstructed: true,
        text: `CREATE TABLE ${quoteIdent(schema)}.${quoteIdent(name)} (\n${lines.join(',\n')}\n);${indexes
          .filter((i) => !keys.some((k) => k.name === i.name))
          .map((i) => `\n${i.definition};`)
          .join('')}`,
      };
    }
    return {
      schema,
      name,
      kind,
      comment: str(rel.comment),
      columns: ok(columns),
      keys: ok(keys),
      indexes: ok(indexes),
      definition,
    };
  }

  async routine(schema: string, name: string, signature?: string): Promise<Definition> {
    const rows = await this.query(
      `SELECT p.oid, p.prokind AS kind FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND p.proname = $2 AND ($3::text IS NULL OR pg_get_function_identity_arguments(p.oid) = $3)`,
      [schema, name, signature ?? null],
    );
    if (!rows.length) return { status: 'unavailable', text: null, reason: 'The routine does not exist.' };
    if (rows.length > 1) {
      return {
        status: 'unavailable',
        text: null,
        reason: 'Several routines have this name; give the signature.',
      };
    }
    const [routine] = rows as [Record<string, unknown>];
    if (routine.kind === 'a')
      return { status: 'unavailable', text: null, reason: 'Aggregates have no function body to show.' };
    try {
      const [def] = await this.query('SELECT pg_get_functiondef($1::oid) AS text', [routine.oid]);
      return { status: 'ok', text: str(def?.text) };
    } catch (error) {
      if (error instanceof DbError && error.category === 'permission') {
        return { status: 'insufficient_permission', text: null, reason: error.message };
      }
      throw error;
    }
  }

  /** The schema new objects resolve to by default. */
  get schema(): string | null {
    return this.defaultSchema;
  }
}
