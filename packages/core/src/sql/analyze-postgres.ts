import { loadModule, parseSync } from 'libpg-query';
import { baseAnalysis, unsafe, type StatementAnalysis, type StatementKind, type TableRef } from './types.js';

type Node = Record<string, unknown>;

let ready: Promise<void> | undefined;
/** Loads the WASM parser once. */
export function loadPostgresParser(): Promise<void> {
  ready ??= loadModule();
  return ready;
}

/** Functions whose effects a read-only transaction does not stop, or that change server state. */
const UNSAFE_FUNCTIONS: Record<string, string> = {
  dblink: 'runs SQL over another connection that is not read-only',
  dblink_exec: 'runs SQL over another connection that is not read-only',
  dblink_send_query: 'runs SQL over another connection that is not read-only',
  dblink_connect: 'opens another database connection',
  dblink_connect_u: 'opens another database connection',
  set_config: 'changes a configuration setting',
  pg_terminate_backend: 'terminates another session',
  pg_cancel_backend: 'cancels another session’s query',
  pg_reload_conf: 'reloads the server configuration',
  pg_rotate_logfile: 'rotates the server log',
  pg_promote: 'promotes a standby',
  pg_switch_wal: 'switches the WAL file',
  pg_create_restore_point: 'creates a restore point',
  pg_create_physical_replication_slot: 'creates a replication slot',
  pg_create_logical_replication_slot: 'creates a replication slot',
  pg_drop_replication_slot: 'drops a replication slot',
  pg_log_backend_memory_contexts: 'writes to the server log',
  pg_notify: 'sends a notification',
  nextval: 'advances a sequence',
  setval: 'changes a sequence',
  pg_read_file: 'reads files on the database server',
  pg_read_binary_file: 'reads files on the database server',
  pg_ls_dir: 'lists files on the database server',
  pg_file_write: 'writes files on the database server',
  pg_file_rename: 'renames files on the database server',
  pg_file_unlink: 'deletes files on the database server',
  lo_import: 'reads files on the database server',
  lo_export: 'writes files on the database server',
  lo_create: 'creates a large object',
  lo_creat: 'creates a large object',
  lo_from_bytea: 'creates a large object',
  lo_put: 'changes a large object',
  lo_unlink: 'deletes a large object',
};
const UNSAFE_PREFIXES: [string, string][] = [
  ['pg_advisory_', 'takes advisory locks'],
  ['pg_try_advisory_', 'takes advisory locks'],
  ['pg_stat_reset', 'resets statistics'],
  ['pg_replication_origin_', 'changes replication state'],
];

const WRITE_NODES = new Set(['InsertStmt', 'UpdateStmt', 'DeleteStmt', 'MergeStmt']);
/**
 * Built-in functions that change data in the database: large objects, which live in
 * pg_largeobject and roll back with the transaction. Sequences (nextval, setval) are left out:
 * PostgreSQL never rolls them back, and they hold no table data.
 */
export const WRITING_BUILT_INS: Record<string, string> = {
  lo_create: 'creates a large object',
  lo_creat: 'creates a large object',
  lo_from_bytea: 'creates a large object',
  lo_import: 'creates a large object',
  lo_put: 'changes a large object',
  lowrite: 'changes a large object',
  lo_truncate: 'changes a large object',
  lo_truncate64: 'changes a large object',
  lo_unlink: 'deletes a large object',
};
/** Functions that write, rename or delete files on the database server. */
const FILE_FUNCTIONS = new Set(['lo_export', 'pg_file_write', 'pg_file_rename', 'pg_file_unlink']);

/** Visits every node of the parse tree as (type, body). */
function walk(value: unknown, visit: (type: string, body: Node) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Node)) {
    if (/^[A-Z]/.test(key) && child && typeof child === 'object' && !Array.isArray(child)) {
      visit(key, child as Node);
    }
    walk(child, visit);
  }
}

/**
 * Tables and views the statement names. An unqualified name that a WITH clause around it defines
 * refers to that query, not to a relation; the same name outside that WITH still counts. A CTE's
 * own definition sees only the CTEs before it, or all of them in WITH RECURSIVE.
 */
function relationsReferenced(tree: unknown): TableRef[] {
  const found = new Map<string, TableRef>();
  const visit = (value: unknown, scope: ReadonlySet<string>): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, scope);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Node)) {
      if (!/^[A-Z]/.test(key) || !child || typeof child !== 'object' || Array.isArray(child)) {
        visit(child, scope);
        continue;
      }
      const body = child as Node;
      if (key === 'RangeVar' && typeof body.relname === 'string') {
        const schema = typeof body.schemaname === 'string' && body.schemaname ? body.schemaname : null;
        if (schema !== null || !scope.has(body.relname))
          found.set(`${schema ?? ''}.${body.relname}`, { schema, name: body.relname });
      }
      const withClause = body.withClause as Node | undefined;
      if (!withClause) {
        visit(body, scope);
        continue;
      }
      const ctes = (Array.isArray(withClause.ctes) ? withClause.ctes : []) as Node[];
      const names = ctes.map((c) => String((c.CommonTableExpr as Node | undefined)?.ctename ?? ''));
      ctes.forEach((c, i) =>
        visit(c, new Set([...scope, ...(withClause.recursive === true ? names : names.slice(0, i))])),
      );
      const { withClause: _defined, ...rest } = body;
      visit(rest, new Set([...scope, ...names]));
    }
  };
  visit(tree, new Set());
  return [...found.values()];
}

const strings = (list: unknown): string[] =>
  Array.isArray(list)
    ? list.map((item) => String(((item as Node).String as Node | undefined)?.sval ?? '')).filter(Boolean)
    : [];

/** Value of a boolean-ish constant: `off`, `false`, `0` and protobuf's omitted zero are false. */
function constIsFalse(arg: unknown): boolean {
  const c = (arg as Node | undefined)?.A_Const as Node | undefined;
  if (!c) return false;
  if ('sval' in c) return /^(off|false|0|no|f|n)$/i.test(String((c.sval as Node).sval ?? ''));
  if ('ival' in c) return Number((c.ival as Node).ival ?? 0) === 0;
  if ('boolval' in c) return !(c.boolval as Node).boolval;
  return false;
}

/** DefElem lists such as BEGIN READ WRITE or SET SESSION CHARACTERISTICS. */
function setsReadWrite(options: unknown): boolean {
  return (Array.isArray(options) ? options : []).some((o) => {
    const d = (o as Node).DefElem as Node | undefined;
    return d?.defname === 'transaction_read_only' && constIsFalse(d.arg);
  });
}

const READ_ONLY_SETTINGS = new Set(['transaction_read_only', 'default_transaction_read_only']);

function commandName(type: string, body: Node): string {
  switch (type) {
    case 'SelectStmt':
      return body.intoClause ? 'SELECT INTO' : 'SELECT';
    case 'InsertStmt':
      return 'INSERT';
    case 'UpdateStmt':
      return 'UPDATE';
    case 'DeleteStmt':
      return 'DELETE';
    case 'MergeStmt':
      return 'MERGE';
    case 'ExplainStmt':
      return 'EXPLAIN';
    case 'VariableSetStmt':
      return body.kind === 'VAR_RESET' || body.kind === 'VAR_RESET_ALL' ? 'RESET' : 'SET';
    case 'VariableShowStmt':
      return 'SHOW';
    case 'TransactionStmt':
      return String(body.kind ?? '')
        .replace('TRANS_STMT_', '')
        .replace('_', ' ');
    case 'CreateStmt':
      return 'CREATE TABLE';
    case 'CreateTableAsStmt':
      return 'CREATE TABLE AS';
    case 'IndexStmt':
      return 'CREATE INDEX';
    case 'ViewStmt':
      return 'CREATE VIEW';
    case 'CreateFunctionStmt':
      return 'CREATE FUNCTION';
    case 'DropStmt':
      return 'DROP';
    case 'AlterTableStmt':
      return 'ALTER TABLE';
    default:
      return type
        .replace(/Stmt$/, '')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toUpperCase();
  }
}

function checkTree(analysis: StatementAnalysis, tree: unknown): void {
  const calls = new Map<string, TableRef>();
  walk(tree, (type, body) => {
    if (WRITE_NODES.has(type)) {
      analysis.kind = 'write';
      unsafe(analysis, 'contains a data-modifying statement');
    }
    if (type === 'LockingClause') unsafe(analysis, 'takes row locks (FOR UPDATE / FOR SHARE)');
    if (type === 'SelectStmt' && body.intoClause) {
      analysis.kind = 'write';
      unsafe(analysis, 'SELECT INTO creates a table');
    }
    if (type === 'FuncCall') {
      const name = (strings(body.funcname).at(-1) ?? '').toLowerCase();
      const reason =
        UNSAFE_FUNCTIONS[name] ?? UNSAFE_PREFIXES.find(([prefix]) => name.startsWith(prefix))?.[1];
      if (reason) unsafe(analysis, `${name}() ${reason}`);
      // set_config(…, false) keeps the setting for the rest of the session.
      if (name === 'set_config') analysis.changesSession = true;
      // The catalog's own function only: unqualified or pg_catalog.…, spelled as the catalog names
      // it (a quoted "LO_PUT" or public.lo_put is another function, looked up like any other).
      const called = strings(body.funcname);
      const exact = called.at(-1) ?? '';
      const inCatalog = called.length === 1 || called.at(-2) === 'pg_catalog';
      if (inCatalog && Object.hasOwn(WRITING_BUILT_INS, exact))
        analysis.builtinWrite ??= `${exact}() ${WRITING_BUILT_INS[exact]}`;
      // Files on the server outlive any rollback.
      if (FILE_FUNCTIONS.has(name)) analysis.irreversible = `${name}() changes files on the database server`;
      // Session-level advisory locks outlive the transaction: the connection must not be reused.
      if (/^pg_(try_)?advisory_lock(_shared)?$/.test(name)) analysis.changesSession = true;
      // A user-defined function may write, even when called from a SELECT. Built-in names are kept
      // too: a search path that puts a user schema before pg_catalog lets that schema's function
      // stand in for one.
      const parts = strings(body.funcname);
      const schema = parts.length > 1 ? (parts.at(-2) ?? null) : null;
      if (schema !== 'pg_catalog')
        calls.set(`${schema ?? ''}.${name}`, { schema, name: parts.at(-1) ?? name });
    }
  });
  if (calls.size) analysis.callsFunctions = [...(analysis.callsFunctions ?? []), ...calls.values()];
  // Views among them can call functions that write.
  const named = relationsReferenced(tree);
  if (named.length) analysis.referencesTables = [...(analysis.referencesTables ?? []), ...named];
}

function analyzeNode(type: string, body: Node): StatementAnalysis {
  const kindOf = (kind: StatementKind) => baseAnalysis(kind, commandName(type, body));
  switch (type) {
    case 'SelectStmt': {
      const a = kindOf('read');
      a.returnsRows = !body.intoClause;
      checkTree(a, { SelectStmt: body });
      return a;
    }
    case 'InsertStmt':
    case 'UpdateStmt':
    case 'DeleteStmt':
    case 'MergeStmt': {
      const a = unsafe(kindOf('write'), 'modifies data');
      // PostgreSQL 18 parse trees use returningClause.exprs; older ones returningList.
      const returning = ((body.returningClause as Node | undefined)?.exprs ?? body.returningList) as unknown;
      a.returnsRows = Array.isArray(returning) && returning.length > 0;
      checkTree(a, body);
      return a;
    }
    case 'ExplainStmt': {
      const analyze = (Array.isArray(body.options) ? body.options : []).some((o) => {
        const d = (o as Node).DefElem as Node | undefined;
        return d?.defname === 'analyze' && !constIsFalse(d.arg);
      });
      const [innerType, innerBody] = Object.entries((body.query as Node) ?? {})[0] ?? [];
      if (analyze && innerType) {
        const inner = analyzeNode(innerType, innerBody as Node);
        inner.command = `EXPLAIN ANALYZE ${inner.command}`;
        inner.returnsRows = true;
        if (!inner.readOnlySafe) inner.reasons.unshift('EXPLAIN ANALYZE executes the statement');
        return inner;
      }
      const a = kindOf('read');
      a.returnsRows = true;
      return a;
    }
    case 'VariableShowStmt': {
      const a = kindOf('read');
      a.returnsRows = true;
      return a;
    }
    case 'VariableSetStmt': {
      const a = kindOf('session');
      const name = String(body.name ?? '').toLowerCase();
      if (
        READ_ONLY_SETTINGS.has(name) &&
        (body.kind === 'VAR_SET_VALUE' ? constIsFalse((body.args as unknown[])?.[0]) : true)
      ) {
        unsafe(a, `changing ${name} would disable read-only mode`);
      }
      if ((name === 'session characteristics' || name === 'transaction') && setsReadWrite(body.args)) {
        unsafe(a, 'READ WRITE would disable read-only mode');
      }
      if (body.kind === 'VAR_RESET_ALL')
        unsafe(a, 'RESET ALL would restore settings including read-only mode');
      a.changesSession = !body.is_local;
      return a;
    }
    case 'TransactionStmt': {
      const a = kindOf('transaction');
      const kind = String(body.kind ?? '');
      a.transactionControl =
        kind === 'TRANS_STMT_BEGIN' || kind === 'TRANS_STMT_START'
          ? 'begin'
          : kind === 'TRANS_STMT_COMMIT' ||
              kind === 'TRANS_STMT_PREPARE' ||
              kind === 'TRANS_STMT_COMMIT_PREPARED'
            ? 'commit'
            : kind === 'TRANS_STMT_ROLLBACK' || kind === 'TRANS_STMT_ROLLBACK_PREPARED'
              ? 'rollback'
              : 'savepoint';
      a.readOnlySafe = true;
      if (setsReadWrite(body.options)) unsafe(a, 'READ WRITE would disable read-only mode');
      if (kind.includes('PREPARED') || kind === 'TRANS_STMT_PREPARE')
        a.unsupported = 'Two-phase commit is not supported.';
      return a;
    }
    case 'CopyStmt': {
      if (body.is_from) return unsafe(kindOf('write'), 'COPY FROM loads data');
      if (body.filename || body.is_program) {
        const a = unsafe(kindOf('write'), 'COPY TO a file or program writes on the database server');
        a.irreversible = body.is_program
          ? 'runs a program on the database server'
          : 'writes a file on the database server';
        return a;
      }
      const a = kindOf('read');
      a.unsupported = 'COPY is not supported here. Use SELECT and export the result.';
      return a;
    }
    case 'DeclareCursorStmt':
    case 'FetchStmt':
    case 'ClosePortalStmt': {
      const a = kindOf('session');
      a.unsupported = 'Cursors are managed by the workbench; run the query directly.';
      return a;
    }
    case 'PrepareStmt':
    case 'DeallocateStmt': {
      const a = kindOf('session');
      a.changesSession = true;
      return a;
    }
    case 'ExecuteStmt':
      return unsafe(kindOf('unknown'), 'EXECUTE runs a prepared statement that cannot be checked');
    case 'DoStmt': {
      const a = unsafe(kindOf('unknown'), 'DO runs procedural code that cannot be checked');
      // Its body may create temporary objects or change settings that stay on the connection.
      a.changesSession = true;
      return a;
    }
    case 'CallStmt': {
      const a = unsafe(kindOf('write'), 'procedures can modify data and control transactions');
      // What the procedure leaves on the connection (settings, temporary tables, advisory locks) is
      // unknown: the connection is not reused.
      a.changesSession = true;
      return a;
    }
    case 'ListenStmt':
    case 'UnlistenStmt':
    case 'DiscardStmt': {
      const a = kindOf('session');
      a.changesSession = true;
      return a;
    }
    case 'LockStmt':
      return unsafe(kindOf('write'), 'takes table locks');
    case 'VacuumStmt': {
      const a = unsafe(kindOf('write'), 'maintenance command');
      a.command = body.is_vacuumcmd ? 'VACUUM' : 'ANALYZE';
      a.noTransactionBlock = Boolean(body.is_vacuumcmd);
      return a;
    }
    default: {
      const a = unsafe(kindOf('write'), 'changes the database');
      // DDL can evaluate expressions too (CREATE TABLE … AS SELECT set_config(…)): the same checks.
      checkTree(a, body);
      const concurrent =
        Boolean(body.concurrent) ||
        (Array.isArray(body.params) &&
          body.params.some((p) => ((p as Node).DefElem as Node | undefined)?.defname === 'concurrently'));
      a.noTransactionBlock =
        concurrent ||
        [
          'CreatedbStmt',
          'DropdbStmt',
          'CreateTableSpaceStmt',
          'DropTableSpaceStmt',
          'AlterSystemStmt',
        ].includes(type);
      return a;
    }
  }
}

/** Combines analyses when one statement text contains several parsed statements. */
function combine(parts: StatementAnalysis[]): StatementAnalysis {
  if (parts.length === 1) return parts[0] as StatementAnalysis;
  const order: StatementKind[] = ['read', 'session', 'transaction', 'write', 'unknown'];
  const kind = parts.map((p) => p.kind).reduce((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a));
  const result = baseAnalysis(kind, parts.map((p) => p.command).join('; '));
  result.readOnlySafe = parts.every((p) => p.readOnlySafe);
  result.reasons = [...new Set(parts.flatMap((p) => p.reasons))];
  result.changesSession = parts.some((p) => p.changesSession);
  result.returnsRows = parts.some((p) => p.returnsRows);
  result.noTransactionBlock = parts.some((p) => p.noTransactionBlock);
  result.transactionControl = parts.find((p) => p.transactionControl)?.transactionControl;
  result.unsupported = parts.find((p) => p.unsupported)?.unsupported;
  const irreversible = parts.find((p) => p.irreversible)?.irreversible;
  if (irreversible) result.irreversible = irreversible;
  return result;
}

/**
 * Creates or names a temporary object (CREATE TEMP TABLE, SELECT INTO TEMP, pg_temp.x). Temporary
 * objects live as long as the connection and can shadow permanent ones, so the connection must not
 * go back to the pool for someone else.
 */
function touchesTemporaryObjects(tree: unknown): boolean {
  const isTempSchema = (name: unknown) => /^pg_temp/i.test(String(name ?? ''));
  // Relations are not always wrapped in a typed node (CreateStmt.relation), so look at every object.
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit);
    if (!value || typeof value !== 'object') return false;
    const node = value as Node;
    if (node.relpersistence === 't' || isTempSchema(node.schemaname)) return true;
    if (Array.isArray(node.funcname) && isTempSchema(strings(node.funcname)[0])) return true;
    return Object.values(node).some(visit);
  };
  return visit(tree);
}

/** Analyzes one PostgreSQL statement. Call `loadPostgresParser()` first. */
export function analyzePostgres(text: string): StatementAnalysis {
  let parsed: { stmts?: { stmt: Node }[] };
  try {
    parsed = parseSync(text) as { stmts?: { stmt: Node }[] };
  } catch (error) {
    const a = unsafe(baseAnalysis('unknown', 'UNKNOWN'), 'the statement could not be parsed');
    const details = (error as { sqlDetails?: { message?: string; cursorPosition?: number } }).sqlDetails;
    a.parseError = {
      message: details?.message ?? (error as Error).message,
      ...(typeof details?.cursorPosition === 'number'
        ? { offset: Buffer.from(text).subarray(0, details.cursorPosition).toString().length }
        : {}),
    };
    return a;
  }
  const parts = (parsed.stmts ?? []).map(({ stmt }) => {
    const [type, body] = Object.entries(stmt)[0] ?? ['Unknown', {}];
    const a = analyzeNode(type, body as Node);
    if (touchesTemporaryObjects(stmt)) a.changesSession = true;
    return a;
  });
  if (!parts.length) return unsafe(baseAnalysis('unknown', 'EMPTY'), 'no statement found');
  return combine(parts);
}
