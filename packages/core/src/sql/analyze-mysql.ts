import mysqlParser from 'node-sql-parser/build/mysql.js';
import { significant, tokenize, type Token } from './lexer.js';
import { baseAnalysis, unsafe, type StatementAnalysis, type TableRef } from './types.js';

const parser = new mysqlParser.Parser();
const OPTIONS = { database: 'MySQL' };

type Node = Record<string, unknown>;

const UNSAFE_FUNCTIONS: Record<string, string> = {
  get_lock: 'takes a named lock that outlives the statement',
  release_lock: 'releases a named lock',
  release_all_locks: 'releases named locks',
  load_file: 'reads files on the database server',
  source_pos_wait: 'waits on replication',
  master_pos_wait: 'waits on replication',
};

/** Statements that end the current transaction implicitly (MySQL 8.4 reference, 15.3.3). */
const IMPLICIT_COMMIT = new Set([
  'ALTER',
  'CREATE',
  'DROP',
  'RENAME',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'INSTALL',
  'UNINSTALL',
  'LOCK',
  'UNLOCK',
  'BEGIN',
  'START',
  'ANALYZE',
  'CACHE',
  'CHECK',
  'FLUSH',
  'OPTIMIZE',
  'REPAIR',
  'RESET',
  'CHANGE',
  'STOP',
  'IMPORT',
]);
const ADMIN = new Set([
  'KILL',
  'FLUSH',
  'RESET',
  'PURGE',
  'OPTIMIZE',
  'REPAIR',
  'ANALYZE',
  'CHECK',
  'CACHE',
  'INSTALL',
  'UNINSTALL',
  'SHUTDOWN',
  'RESTART',
  'CLONE',
  'IMPORT',
  'BINLOG',
  'CHANGE',
  'STOP',
]);
const READ_ONLY_VARIABLES = /^(@@(session\.|local\.)?)?(transaction_read_only|tx_read_only)$/i;
const GLOBAL_SCOPE = /^(global|persist|persist_only)$|^@@(global|persist|persist_only)\./i;

const word = (t: Token | undefined) => (t?.kind === 'word' ? t.text.toUpperCase() : '');

/** An identifier token as a name: backtick quotes removed. Undefined for anything else. */
function identifier(t: Token | undefined): string | undefined {
  if (t?.kind === 'word') return t.text;
  if (t?.kind === 'quoted_identifier' && t.text.startsWith('`') && !t.unterminated)
    return t.text.slice(1, -1).replace(/``/g, '`');
  return undefined;
}

/** `name` or `schema.name` starting at tokens[i]. */
function qualifiedName(tokens: Token[], i: number): TableRef | undefined {
  const first = identifier(tokens[i]);
  if (first === undefined) return undefined;
  if (tokens[i + 1]?.text !== '.') return { schema: null, name: first };
  const second = identifier(tokens[i + 2]);
  return second === undefined ? undefined : { schema: first, name: second };
}

/** Replaces `/*!NNNNN …*\/` with its content, which MySQL executes. */
function expandExecutableComments(text: string): string {
  let out = '';
  for (const t of tokenize(text, 'mysql')) {
    out +=
      t.kind === 'executable_comment' ? ` ${t.text.replace(/^\/\*!\d*/, '').replace(/\*\/$/, '')} ` : t.text;
  }
  return out;
}

function tablesWritten(tableList: string[]): TableRef[] {
  return tableList
    .map((entry) => entry.split('::'))
    .filter(([op]) => /^(insert|update|delete|replace)$/i.test(op ?? ''))
    .map(([, schema, name]) => ({ schema: schema && schema !== 'null' ? schema : null, name: name ?? '' }))
    .filter((t) => t.name && t.name !== 'null');
}

function walk(value: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(value)) value.forEach((v) => walk(v, visit));
  else if (value && typeof value === 'object') {
    visit(value as Node);
    Object.values(value as Node).forEach((v) => walk(v, visit));
  }
}

function functionName(node: Node): string {
  const name = node.name as unknown;
  if (typeof name === 'string') return name.toLowerCase();
  const parts = (name as { name?: { value?: string }[] } | undefined)?.name;
  return String(parts?.at(-1)?.value ?? '').toLowerCase();
}

/** SELECT, WITH and parenthesised queries: decided from the parse tree. */
function analyzeQuery(text: string): StatementAnalysis {
  let parsed: { ast: Node | Node[]; tableList: string[] };
  try {
    parsed = parser.parse(text, OPTIONS) as unknown as { ast: Node | Node[]; tableList: string[] };
  } catch (error) {
    const a = unsafe(baseAnalysis('unknown', 'UNKNOWN'), 'the statement could not be parsed');
    const location = (error as { location?: { start?: { offset?: number } } }).location;
    a.parseError = {
      message: (error as Error).message.split('\n')[0] ?? 'Syntax error',
      ...(typeof location?.start?.offset === 'number' ? { offset: location.start.offset } : {}),
    };
    return a;
  }
  const asts = Array.isArray(parsed.ast) ? parsed.ast : [parsed.ast];
  const root = asts[0] ?? {};
  const type = String(root.type ?? '').toLowerCase();
  if (type !== 'select') {
    const a = unsafe(baseAnalysis('write', type.toUpperCase()), 'modifies data');
    a.writesTables = tablesWritten(parsed.tableList);
    if (!a.writesTables.length) a.writeTargetsUnknown = true;
    return a;
  }
  const a = baseAnalysis('read', 'SELECT');
  a.returnsRows = true;
  walk(asts, (node) => {
    const into = node.into as Node | undefined;
    const keyword = String(into?.keyword ?? '').toUpperCase();
    if (keyword === 'OUTFILE' || keyword === 'DUMPFILE') {
      a.kind = 'write';
      a.returnsRows = false;
      unsafe(a, `SELECT … INTO ${keyword} writes a file on the database server`);
    } else if (keyword === 'VAR') {
      a.returnsRows = false;
      a.changesSession = true;
    }
    if (node.locking_read) unsafe(a, 'takes row locks (FOR UPDATE / FOR SHARE)');
    if (node.type === 'function') {
      const name = functionName(node);
      if (UNSAFE_FUNCTIONS[name]) unsafe(a, `${name}() ${UNSAFE_FUNCTIONS[name]}`);
    }
    if (node.type === 'assign' || (node.type === 'binary_expr' && node.operator === ':='))
      a.changesSession = true;
  });
  return a;
}

/** Variables assigned by a SET statement, with their scope words. */
function setAssignments(tokens: Token[]): { name: string; scope: string; value: string }[] {
  const result: { name: string; scope: string; value: string }[] = [];
  let depth = 0;
  let part: Token[] = [];
  const flush = () => {
    const eq = part.findIndex((t) => t.text === '=' || t.text === ':');
    const left = (eq === -1 ? part : part.slice(0, eq)).map((t) => t.text);
    const value =
      eq === -1
        ? ''
        : part
            .slice(eq + 1)
            .map((t) => t.text)
            .join('')
            .replace(/^=/, '');
    const scope =
      left.length > 1 && /^(global|session|local|persist|persist_only)$/i.test(left[0] ?? '')
        ? (left[0] as string)
        : '';
    result.push({ name: (scope ? left.slice(1) : left).join(''), scope, value });
    part = [];
  };
  for (const t of tokens.slice(1)) {
    if (t.text === '(') depth++;
    if (t.text === ')') depth--;
    if (t.text === ',' && depth === 0) flush();
    else part.push(t);
  }
  if (part.length) flush();
  return result;
}

function analyzeSet(tokens: Token[]): StatementAnalysis {
  const second = word(tokens[1]);
  const third = word(tokens[2]);
  const a = baseAnalysis('session', 'SET');
  a.changesSession = true;
  const text = tokens.map((t) => t.text.toUpperCase()).join(' ');
  if (
    second === 'TRANSACTION' ||
    ((second === 'SESSION' || second === 'GLOBAL') && third === 'TRANSACTION')
  ) {
    a.command = 'SET TRANSACTION';
    if (second === 'GLOBAL') {
      a.kind = 'write';
      unsafe(a, 'changes server configuration');
    }
    if (/READ\s+WRITE/.test(text)) unsafe(a, 'READ WRITE would disable read-only mode');
    return a;
  }
  if (second === 'PASSWORD' || (second === 'DEFAULT' && third === 'ROLE')) {
    const w = unsafe(baseAnalysis('write', `SET ${second}`), 'changes an account');
    w.implicitCommit = second === 'PASSWORD';
    return w;
  }
  for (const { name, scope, value } of setAssignments(tokens)) {
    const plain = name
      .replace(/^@@(session\.|local\.|global\.|persist\.|persist_only\.)?/i, '')
      .toLowerCase();
    if (GLOBAL_SCOPE.test(scope) || GLOBAL_SCOPE.test(name)) {
      a.kind = 'write';
      unsafe(a, 'changes server configuration');
    }
    if (plain === 'autocommit') {
      a.kind = 'transaction';
      a.transactionControl = 'autocommit';
      a.command = 'SET autocommit';
    }
    if (READ_ONLY_VARIABLES.test(plain) && /^(0|off|false)$/i.test(value.trim())) {
      unsafe(a, `changing ${plain} would disable read-only mode`);
    }
  }
  return a;
}

function analyzeByKeyword(text: string, tokens: Token[]): StatementAnalysis {
  const [first, second] = [word(tokens[0]), word(tokens[1])];
  const words = tokens.filter((t) => t.kind === 'word').map((t) => t.text.toUpperCase());
  const write = (command: string, reason: string) => {
    const a = unsafe(baseAnalysis('write', command), reason);
    a.implicitCommit = IMPLICIT_COMMIT.has(first);
    return a;
  };

  switch (first) {
    case 'SELECT':
    case 'WITH':
      return analyzeQuery(text);
    case 'TABLE':
    case 'VALUES': {
      if (words.includes('INTO')) return write(first, 'INTO writes a file or sets variables');
      const a = baseAnalysis('read', first);
      a.returnsRows = true;
      return a;
    }
    case 'SHOW':
    case 'HELP':
    case 'CHECKSUM': {
      const a = baseAnalysis('read', `${first}${second ? ` ${second}` : ''}`);
      a.returnsRows = true;
      return a;
    }
    case 'EXPLAIN':
    case 'DESCRIBE':
    case 'DESC': {
      if (second === 'ANALYZE') {
        const inner = analyzeMysql(
          text.slice(tokens[2]?.start ?? text.length).replace(/^\s*FORMAT\s*=\s*\w+/i, ''),
        );
        inner.command = `EXPLAIN ANALYZE ${inner.command}`;
        inner.returnsRows = true;
        if (!inner.readOnlySafe) inner.reasons.unshift('EXPLAIN ANALYZE executes the statement');
        return inner;
      }
      const a = baseAnalysis('read', first === 'EXPLAIN' ? 'EXPLAIN' : 'DESCRIBE');
      a.returnsRows = true;
      return a;
    }
    case 'START':
      if (second === 'TRANSACTION') {
        const a = baseAnalysis('transaction', 'START TRANSACTION');
        a.transactionControl = 'begin';
        a.implicitCommit = true;
        if (words.includes('WRITE')) unsafe(a, 'READ WRITE would disable read-only mode');
        return a;
      }
      return write(`START ${second}`, 'administrative command');
    case 'BEGIN': {
      const a = baseAnalysis('transaction', 'BEGIN');
      a.transactionControl = 'begin';
      a.implicitCommit = true;
      return a;
    }
    case 'COMMIT':
    case 'ROLLBACK':
    case 'SAVEPOINT':
    case 'RELEASE': {
      const a = baseAnalysis('transaction', first);
      a.transactionControl =
        first === 'COMMIT'
          ? 'commit'
          : first === 'ROLLBACK' && !words.includes('TO')
            ? 'rollback'
            : 'savepoint';
      return a;
    }
    case 'XA': {
      const a = baseAnalysis('transaction', 'XA');
      a.transactionControl = 'xa';
      a.unsupported = 'XA transactions are not supported.';
      return a;
    }
    case 'LOCK':
    case 'UNLOCK': {
      const a = unsafe(baseAnalysis('transaction', `${first} ${second}`.trim()), 'controls table locks');
      a.transactionControl = 'lock';
      a.implicitCommit = second !== 'INSTANCE';
      return a;
    }
    case 'SET':
      return analyzeSet(tokens);
    case 'USE': {
      const a = baseAnalysis('session', 'USE');
      a.changesSession = true;
      const database = identifier(tokens[1]);
      if (database !== undefined) a.usesDatabase = database;
      return a;
    }
    case 'INSERT':
    case 'UPDATE':
    case 'DELETE':
    case 'REPLACE': {
      const a = write(first, 'modifies data');
      try {
        const { tableList } = parser.parse(text, OPTIONS);
        a.writesTables = tablesWritten(tableList);
      } catch {
        a.reasons.push('the statement could not be parsed; the database will report any syntax error');
      }
      if (!a.writesTables.length) a.writeTargetsUnknown = true;
      return a;
    }
    case 'CREATE':
    case 'ALTER':
    case 'DROP':
    case 'RENAME':
    case 'TRUNCATE':
    case 'GRANT':
    case 'REVOKE': {
      const a = write(`${first} ${second}`.trim(), 'changes the database');
      if ((first === 'CREATE' || first === 'DROP') && second === 'TEMPORARY') a.implicitCommit = false;
      // A temporary table lives as long as the connection, and can shadow a permanent table of the
      // same name: the connection must not go back to the pool for someone else.
      if (first === 'CREATE' && second === 'TEMPORARY') a.changesSession = true;
      const engineAt = words.indexOf('ENGINE');
      const engine = engineAt === -1 ? undefined : tokens.filter((t) => t.kind === 'word')[engineAt + 1];
      if (engine) a.declaredEngine = engine.text;
      return a;
    }
    case 'LOAD': {
      const a = write(`LOAD ${second}`, second === 'INDEX' ? 'administrative command' : 'loads data');
      a.implicitCommit = second === 'INDEX';
      if (second === 'DATA' || second === 'XML') {
        // LOAD DATA … INTO TABLE name …: the table whose storage engine decides whether it rolls back.
        const into = tokens.findIndex((t, i) => word(t) === 'INTO' && word(tokens[i + 1]) === 'TABLE');
        const target = into === -1 ? undefined : qualifiedName(tokens, into + 2);
        if (target) a.writesTables = [target];
        else a.writeTargetsUnknown = true;
      }
      return a;
    }
    case 'CALL': {
      const a = write('CALL', 'procedures can modify data and control transactions');
      a.returnsRows = true;
      a.mayCommit = true;
      // What the procedure leaves on the connection (variables, temporary tables, named locks) is
      // unknown: the connection is not reused.
      a.changesSession = true;
      return a;
    }
    case 'DO':
      return unsafe(baseAnalysis('unknown', 'DO'), 'DO evaluates expressions only for their side effects');
    case 'HANDLER': {
      const a = unsafe(baseAnalysis('unknown', 'HANDLER'), 'HANDLER keeps a table open in the session');
      a.unsupported = 'HANDLER is not supported.';
      return a;
    }
    case 'PREPARE':
    case 'DEALLOCATE': {
      const a = baseAnalysis('session', first);
      a.changesSession = true;
      return a;
    }
    case 'EXECUTE':
      return unsafe(
        baseAnalysis('unknown', 'EXECUTE'),
        'EXECUTE runs a prepared statement that cannot be checked',
      );
    default:
      if (ADMIN.has(first)) return write(`${first}${second ? ` ${second}` : ''}`, 'administrative command');
      if (tokens[0]?.text === '(') return analyzeQuery(text);
      return unsafe(baseAnalysis('unknown', first || 'UNKNOWN'), 'unrecognized statement');
  }
}

/** Analyzes one MySQL statement. */
export function analyzeMysql(text: string): StatementAnalysis {
  const raw = [...tokenize(text, 'mysql')];
  if (raw.some((t) => t.kind === 'executable_comment')) {
    const expanded = analyzeMysql(expandExecutableComments(text));
    expanded.reasons.push('analyzed with its executable comments (/*! … */) as if they run');
    return expanded;
  }
  const tokens = significant(raw);
  if (!tokens.length) return unsafe(baseAnalysis('unknown', 'EMPTY'), 'no statement found');
  const analysis = analyzeByKeyword(text, tokens);
  // A named lock belongs to the connection, wherever the call appears (SELECT, INSERT … VALUES,
  // UPDATE … SET): the connection must not be reused by someone else.
  if (tokens.some((t, i) => word(t) === 'GET_LOCK' && tokens[i + 1]?.text === '('))
    analysis.changesSession = true;
  return analysis;
}
