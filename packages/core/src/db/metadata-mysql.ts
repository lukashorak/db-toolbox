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
  type SchemaInfo,
  type TableDetail,
} from './metadata.js';

type Query = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

const SYSTEM = new Set(['mysql', 'information_schema', 'performance_schema', 'sys']);
const str = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
const quoteIdent = (name: string) => `\`${name.replace(/`/g, '``')}\``;
const notVisible = (what: string) =>
  `${what} does not exist, or the account has no privileges on it (MySQL hides objects it cannot access).`;

/**
 * MySQL metadata from information_schema. MySQL only shows objects the account has some privilege
 * on, so a missing object is reported as "not visible" rather than "does not exist".
 */
export class MysqlMetadata implements MetadataReader {
  constructor(
    private readonly query: Query,
    private readonly currentDatabase: string,
  ) {}

  async databases(): Promise<MetadataResult<DatabaseInfo>> {
    const rows = await this.query(
      'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME',
    );
    const items = rows.map((r) => ({
      name: String(r.name),
      current: r.name === this.currentDatabase,
      browsable: true,
      system: SYSTEM.has(String(r.name)),
    }));
    items.sort((a, b) => Number(b.current) - Number(a.current) || Number(a.system) - Number(b.system));
    return { status: 'ok', items, reason: 'Only databases the account has privileges on are listed.' };
  }

  async schemas(): Promise<MetadataResult<SchemaInfo>> {
    const { items, reason } = await this.databases();
    return {
      status: 'ok',
      items: items.map((d) => ({ name: d.name, system: d.system, usable: true })),
      ...(reason ? { reason } : {}),
    };
  }

  async objects(schema: string): Promise<MetadataResult<ObjectInfo>> {
    const [visible] = await this.query(
      'SELECT 1 AS ok FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [schema],
    );
    if (!visible) return { status: 'unavailable', items: [], reason: notVisible(`Database ${schema}`) };
    const tables = await this.query(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_COMMENT AS comment, TABLE_ROWS AS estimate
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
      [schema],
    );
    const routines = await this.query(
      `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type, DTD_IDENTIFIER AS returns, ROUTINE_COMMENT AS comment
         FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME`,
      [schema],
    );
    return ok<ObjectInfo>([
      ...tables.map((t) => ({
        schema,
        name: String(t.name),
        kind: String(t.type) === 'VIEW' ? ('view' as const) : ('table' as const),
        comment: String(t.type) === 'VIEW' ? null : str(t.comment),
        accessible: null,
        engine: str(t.engine),
        rowEstimate: t.estimate === null || t.estimate === undefined ? null : Number(t.estimate),
      })),
      ...routines.map((r) => ({
        schema,
        name: String(r.name),
        kind: String(r.type) === 'PROCEDURE' ? ('procedure' as const) : ('function' as const),
        returns: str(r.returns),
        comment: str(r.comment),
        accessible: null,
      })),
    ]);
  }

  async table(schema: string, name: string): Promise<TableDetail | null> {
    const [table] = await this.query(
      `SELECT TABLE_TYPE AS type, TABLE_COMMENT AS comment FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [schema, name],
    );
    if (!table) return null;
    const kind = String(table.type) === 'VIEW' ? ('view' as const) : ('table' as const);
    const columns = (
      await this.query(
        `SELECT ORDINAL_POSITION AS position, COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
                COLUMN_DEFAULT AS default_value, COLUMN_COMMENT AS comment, EXTRA AS extra,
                GENERATION_EXPRESSION AS generation
           FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
        [schema, name],
      )
    ).map((c): ColumnDetail => ({
      position: Number(c.position),
      name: String(c.name),
      type: String(c.type),
      nullable: c.nullable === 'YES',
      default: str(c.default_value),
      comment: str(c.comment),
      identity: /auto_increment/i.test(String(c.extra ?? '')) ? 'auto_increment' : null,
      generated: str(c.generation),
    }));
    const keyRows = await this.query(
      `SELECT tc.CONSTRAINT_NAME AS name, tc.CONSTRAINT_TYPE AS type, k.COLUMN_NAME AS column_name,
              k.REFERENCED_TABLE_SCHEMA AS ref_schema, k.REFERENCED_TABLE_NAME AS ref_table,
              k.REFERENCED_COLUMN_NAME AS ref_column, cc.CHECK_CLAUSE AS check_clause
         FROM information_schema.TABLE_CONSTRAINTS tc
         LEFT JOIN information_schema.KEY_COLUMN_USAGE k
           ON k.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
          AND k.TABLE_SCHEMA = tc.TABLE_SCHEMA AND k.TABLE_NAME = tc.TABLE_NAME
         LEFT JOIN information_schema.CHECK_CONSTRAINTS cc
           ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
        WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ?
        ORDER BY FIELD(tc.CONSTRAINT_TYPE, 'PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY', 'CHECK'), tc.CONSTRAINT_NAME,
                 k.ORDINAL_POSITION`,
      [schema, name],
    );
    const keys = new Map<string, KeyInfo>();
    for (const r of keyRows) {
      const type = (
        { 'PRIMARY KEY': 'primary', UNIQUE: 'unique', 'FOREIGN KEY': 'foreign', CHECK: 'check' } as Record<
          string,
          KeyInfo['type']
        >
      )[String(r.type)];
      if (!type) continue;
      const key = keys.get(String(r.name)) ?? {
        name: String(r.name),
        type,
        columns: [],
        definition: type === 'check' ? `CHECK ${String(r.check_clause ?? '')}` : null,
        ...(type === 'foreign'
          ? { references: { schema: String(r.ref_schema), table: String(r.ref_table), columns: [] } }
          : {}),
      };
      if (r.column_name) key.columns.push(String(r.column_name));
      if (r.ref_column) key.references?.columns.push(String(r.ref_column));
      keys.set(key.name, key);
    }
    const indexRows = await this.query(
      `SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, INDEX_TYPE AS method, COLUMN_NAME AS column_name,
              EXPRESSION AS expression
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX`,
      [schema, name],
    );
    const indexes = new Map<string, IndexInfo>();
    for (const r of indexRows) {
      const index = indexes.get(String(r.name)) ?? {
        name: String(r.name),
        unique: Number(r.non_unique) === 0,
        primary: r.name === 'PRIMARY',
        method: str(r.method),
        columns: [],
        definition: null,
      };
      index.columns.push(String(r.column_name ?? `(${String(r.expression ?? '')})`));
      indexes.set(index.name, index);
    }
    return {
      schema,
      name,
      kind,
      comment: kind === 'view' ? null : str(table.comment),
      columns: ok(columns),
      keys: ok([...keys.values()]),
      indexes: ok([...indexes.values()]),
      definition: await this.#showCreate(kind === 'view' ? 'VIEW' : 'TABLE', schema, name),
    };
  }

  async routine(schema: string, name: string): Promise<Definition> {
    const [routine] = await this.query(
      'SELECT ROUTINE_TYPE AS type FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ?',
      [schema, name],
    );
    if (!routine)
      return { status: 'unavailable', text: null, reason: notVisible(`Routine ${schema}.${name}`) };
    return this.#showCreate(String(routine.type) === 'PROCEDURE' ? 'PROCEDURE' : 'FUNCTION', schema, name);
  }

  async #showCreate(
    what: 'TABLE' | 'VIEW' | 'PROCEDURE' | 'FUNCTION',
    schema: string,
    name: string,
  ): Promise<Definition> {
    try {
      const [row] = await this.query(`SHOW CREATE ${what} ${quoteIdent(schema)}.${quoteIdent(name)}`);
      const text = row?.[`Create ${what.charAt(0)}${what.slice(1).toLowerCase()}`];
      if (text === null || text === undefined) {
        return {
          status: 'insufficient_permission',
          text: null,
          reason:
            'The account may not see this definition (it needs to own the routine or have SHOW_ROUTINE).',
        };
      }
      return { status: 'ok', text: String(text) };
    } catch (error) {
      if (error instanceof DbError && (error.category === 'permission' || error.code === '1356')) {
        return { status: 'insufficient_permission', text: null, reason: error.message };
      }
      throw error;
    }
  }
}
