/**
 * Metadata as the browser and MCP see it. Every list says whether it is complete: `ok` means the
 * list is everything there is (it may really be empty); `insufficient_permission` and
 * `unavailable` mean the database did not let us see it, with the reason.
 */
export type MetadataStatus = 'ok' | 'insufficient_permission' | 'unavailable';

export interface MetadataResult<T> {
  status: MetadataStatus;
  items: T[];
  reason?: string;
}

export interface DatabaseInfo {
  name: string;
  /** The database this connection is configured for. */
  current: boolean;
  /** Objects can be listed through this connection (PostgreSQL: only the current database). */
  browsable: boolean;
  system: boolean;
}

export interface SchemaInfo {
  name: string;
  system: boolean;
  /** The account may use objects in it (PostgreSQL USAGE). */
  usable: boolean;
}

export type ObjectKind =
  | 'table'
  | 'partitioned_table'
  | 'view'
  | 'materialized_view'
  | 'foreign_table'
  | 'function'
  | 'procedure'
  | 'aggregate';

export interface ObjectInfo {
  schema: string;
  name: string;
  kind: ObjectKind;
  /** Routines: identity arguments, for example `integer, text`. */
  signature?: string;
  /** Routines: result type. */
  returns?: string | null;
  comment: string | null;
  /** Tables and views: the account may SELECT; routines: may EXECUTE. Null when unknown. */
  accessible: boolean | null;
  /** MySQL storage engine. */
  engine?: string | null;
  /** Planner estimate, not a count. */
  rowEstimate?: number | null;
}

export interface ColumnDetail {
  position: number;
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  comment: string | null;
  /** `always`, `by default` (identity) or `auto_increment`. */
  identity: string | null;
  /** Generation expression of a generated column. */
  generated: string | null;
}

export interface KeyInfo {
  name: string;
  type: 'primary' | 'unique' | 'foreign' | 'check' | 'exclusion';
  columns: string[];
  references?: { schema: string; table: string; columns: string[] };
  definition: string | null;
}

export interface IndexInfo {
  name: string;
  unique: boolean;
  primary: boolean;
  columns: string[];
  method: string | null;
  definition: string | null;
}

export interface Definition {
  status: MetadataStatus;
  text: string | null;
  /** The definition was assembled from the catalog, not returned by the server verbatim. */
  reconstructed?: boolean;
  reason?: string;
}

export interface TableDetail {
  schema: string;
  name: string;
  kind: ObjectKind;
  comment: string | null;
  columns: MetadataResult<ColumnDetail>;
  keys: MetadataResult<KeyInfo>;
  indexes: MetadataResult<IndexInfo>;
  definition: Definition;
}

export interface MetadataReader {
  databases(): Promise<MetadataResult<DatabaseInfo>>;
  schemas(): Promise<MetadataResult<SchemaInfo>>;
  objects(schema: string): Promise<MetadataResult<ObjectInfo>>;
  /** Tables, views and materialized views. Null when it does not exist (or is not visible). */
  table(schema: string, name: string): Promise<TableDetail | null>;
  routine(schema: string, name: string, signature?: string): Promise<Definition>;
}

export const ok = <T>(items: T[]): MetadataResult<T> => ({ status: 'ok', items });
