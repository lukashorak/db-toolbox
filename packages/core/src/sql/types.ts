import type { SplitStatement } from './split.js';

export type StatementKind = 'read' | 'write' | 'transaction' | 'session' | 'unknown';

export type TransactionControl = 'begin' | 'commit' | 'rollback' | 'savepoint' | 'autocommit' | 'lock' | 'xa';

/**
 * Storage engine reported for a view whose base tables could not be determined (MySQL): whether
 * a write through it can be rolled back is unknown.
 */
export const UNRESOLVED_VIEW = 'unresolved view';

/** MySQL storage engines that roll back (lower case). */
export const TRANSACTIONAL_ENGINES = new Set(['innodb', 'ndb', 'ndbcluster']);

export interface TableRef {
  schema: string | null;
  name: string;
}

export interface StatementAnalysis {
  kind: StatementKind;
  /** Short command name for people, for example `SELECT`, `CREATE TABLE`, `SET`. */
  command: string;
  /** May run under a read-only policy. `false` for writes, unparsable SQL and bypass attempts. */
  readOnlySafe: boolean;
  /** Why the statement is not read-only safe, or other facts worth showing. */
  reasons: string[];
  /** Leaves session state behind (SET, USE, PREPARE, LISTEN …); the session is discarded afterwards. */
  changesSession: boolean;
  /** Probably returns rows. The driver reports what actually happened. */
  returnsRows: boolean;
  transactionControl?: TransactionControl;
  /** MySQL: the statement commits the current transaction implicitly. */
  implicitCommit: boolean;
  /** PostgreSQL: the statement cannot run inside a transaction block. */
  noTransactionBlock: boolean;
  /**
   * MySQL: runs code (a procedure, or a prepared statement that may be DDL) that may COMMIT or
   * ROLLBACK on its own, so a single transaction around it cannot be promised.
   */
  mayCommit?: boolean;
  /** The workbench cannot execute this statement, with the reason. */
  unsupported?: string;
  /** Tables the statement inserts into, updates or deletes from (MySQL engine checks). */
  writesTables: TableRef[];
  /**
   * MySQL: the statement writes, but the tables it writes could not be determined (it did not
   * parse), so their storage engines cannot be checked.
   */
  writeTargetsUnknown?: boolean;
  /** MySQL `USE`: the database that later unqualified names in the session refer to. */
  usesDatabase?: string;
  /** `ENGINE=` given in a MySQL CREATE or ALTER TABLE. */
  declaredEngine?: string;
  parseError?: { message: string; /** 0-based offset within the statement text. */ offset?: number };
}

export interface AnalyzedStatement extends SplitStatement {
  analysis: StatementAnalysis;
}

export function baseAnalysis(kind: StatementKind, command: string): StatementAnalysis {
  return {
    kind,
    command,
    readOnlySafe: kind === 'read' || kind === 'session',
    reasons: [],
    changesSession: false,
    returnsRows: false,
    implicitCommit: false,
    noTransactionBlock: false,
    writesTables: [],
  };
}

/** Marks an analysis as not read-only safe with a reason. */
export function unsafe(analysis: StatementAnalysis, reason: string): StatementAnalysis {
  analysis.readOnlySafe = false;
  if (!analysis.reasons.includes(reason)) analysis.reasons.push(reason);
  return analysis;
}
