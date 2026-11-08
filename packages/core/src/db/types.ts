import type { Engine, TlsMode } from '../domain/types.js';
import type { TableRef } from '../sql/types.js';
import type { MetadataReader } from './metadata.js';

/** Decrypted connection settings. Lives only in memory, inside core. */
export interface ConnectionTarget {
  id: string;
  name: string;
  engine: Engine;
  host: string;
  port: number;
  database: string;
  /** PostgreSQL default schema (search_path); always null for MySQL. */
  schema: string | null;
  username: string;
  password: string;
  tlsMode: TlsMode;
  caPem: string | null;
  /** Separate account for the fixed monitoring queries; the main account is used otherwise. */
  monitor?: { username: string; password: string } | null;
}

/** Where the driver connects. SSH tunnels will return a local forward with the original servername. */
export interface Endpoint {
  host: string;
  port: number;
  /** Name the server certificate must match under verify-full. */
  servername: string;
}

export interface Transport {
  readonly kind: 'direct';
  open(): Promise<Endpoint>;
  close(): Promise<void>;
}

export interface ColumnInfo {
  name: string;
  /** Engine type name, for example `int4`, `timestamptz`, `VARCHAR`. */
  type: string;
  /** Values are hex-encoded bytes with a `\x` prefix. */
  binary: boolean;
}

/** Every value is text in the engine's canonical text form, or null. Binary is `\x` + hex. */
export type Cell = string | null;

export interface ResultSink {
  /** A result set begins. Called once per result set (MySQL procedures can return several). */
  start(columns: ColumnInfo[], index: number): void | Promise<void>;
  /** A batch of rows. Return `'stop'` to stop reading; the rest of the result is discarded. */
  rows(rows: Cell[][], index: number): void | 'stop' | Promise<void | 'stop'>;
}

export interface StatementOutcome {
  /** Command tag (PostgreSQL) or a generic verb (MySQL); null when unknown. */
  command: string | null;
  /** Rows changed by a write, when the engine reports it. */
  affectedRows: number | null;
  resultSets: number;
  rowsDelivered: number;
  /** The sink asked to stop before the result ended. */
  stopped: boolean;
  /** Engine notices and warnings, already redacted of nothing: they come from the database. */
  notices: string[];
}

export interface ExecuteOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Rows per sink call. */
  batchSize?: number;
  /**
   * When the sink has enough rows of a result set: `cancel` ends the statement (default; for
   * reads), `drain` lets it run to the end and discards the rest of that result set (for statements
   * that change data, such as a procedure that returns rows and then writes).
   */
  onStop?: 'cancel' | 'drain';
}

/**
 * Bounds a wait on a session's connection: once `signal` aborts or `deadline` (epoch ms) passes,
 * the connection has a grace period to answer, then it is closed and the wait fails as a lost
 * connection (whether the command took effect is unknown).
 */
export interface WaitBounds {
  signal?: AbortSignal;
  deadline?: number;
}

export interface DbSession {
  /** Server process (PostgreSQL) or thread (MySQL) ID, for cancellation and monitoring. */
  readonly backendId: number;
  begin(options: { readOnly: boolean } & WaitBounds): Promise<void>;
  /** A COMMIT on a connection that stops answering fails as a lost connection: its outcome is unknown. */
  commit(bounds?: WaitBounds): Promise<void>;
  /** Bounded by the grace period: a connection that does not answer is closed, which rolls back too. */
  rollback(): Promise<void>;
  execute(sql: string, sink: ResultSink, options: ExecuteOptions): Promise<StatementOutcome>;
  /** The session's state is no longer known to be clean; it is closed instead of reused. */
  markDirty(reason: string): void;
  /** Labels the session with an execution ID, so monitoring can tell this tool's work apart. */
  tag(executionId: string, bounds?: WaitBounds): Promise<void>;
  /**
   * Whether a statement may write through the functions it calls, directly or through the views it
   * names: MySQL, a stored function that writes or cannot be checked, or a view whose definition
   * cannot be read (unqualified names are looked up in `database`); PostgreSQL, a VOLATILE function
   * outside pg_catalog that this session's search path reaches (or the named schema holds), or that
   * a named view calls. Stops when `signal` aborts.
   */
  mayWriteThrough(
    refs: { functions: TableRef[]; relations: TableRef[] },
    database: string | null,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

export interface DbAdapter {
  readonly engine: Engine;
  /** Runs `fn` with a pooled session. Waits for a free slot (bounded by the concurrency limit). */
  withSession<T>(fn: (session: DbSession) => Promise<T>, options?: { signal?: AbortSignal }): Promise<T>;
  /** Cancels the running statement of a session, over a reserved control connection. */
  cancel(backendId: number): Promise<boolean>;
  readonly metadata: MetadataReader;
  /** MySQL: storage engine of a table, for single-transaction preflight. */
  /** `signal`: stop looking (no further query starts) once it aborts. */
  tableEngine(table: TableRef, signal?: AbortSignal): Promise<string | null>;
  /**
   * MySQL: where a call to a possibly stored function writes, for single-transaction preflight: null
   * when it is not a stored function or writes nothing, UNRESOLVED_VIEW when that cannot be told.
   */
  functionEngine(fn: TableRef, signal?: AbortSignal): Promise<string | null>;
  /**
   * MySQL: where reading this relation writes, through the stored functions a view (or a view
   * beneath it) calls: null for a base table or a view that calls none that write, UNRESOLVED_VIEW
   * when a definition cannot be read.
   */
  viewEngine(table: TableRef, signal?: AbortSignal): Promise<string | null>;
  /** Sessions currently checked out. */
  activeSessions(): number;
  /** Runs one of the fixed monitoring queries on the reserved monitoring connection. */
  monitorQuery(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  /** Account the monitoring queries use. */
  readonly monitorAccount: string;
  close(): Promise<void>;
}

export interface PoolSizes {
  /** Concurrent executions per connection (GUI and MCP share them). */
  work: number;
  /** Metadata browsing and connection tests. */
  metadata: number;
  /** Cancellation, so it works when all work slots are busy. */
  control: number;
  /** Monitoring queries (optionally with a separate account). Default 1. */
  monitor?: number;
}
