import mysqlParser from 'node-sql-parser/build/mysql.js';
import { significant, tokenize, type Token } from './lexer.js';
import { baseAnalysis, unsafe, type StatementAnalysis, type TableRef, type TriggerEvent } from './types.js';

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

/** Words before which a name followed by `(` is a table or CTE with a column list, not a call. */
const NAME_POSITIONS = new Set(['WITH', 'RECURSIVE', 'INTO', 'TABLE', 'UPDATE', 'JOIN', 'FROM']);

/**
 * tokens[i] is a function call: an unquoted word followed by `(`, not in a name position (a table or
 * CTE with a column list, `WITH get_lock (x) AS (…)`, `INSERT INTO load_file (a) …`).
 */
function isFunctionCall(tokens: Token[], i: number): boolean {
  if (tokens[i]?.kind !== 'word' || tokens[i + 1]?.text !== '(') return false;
  if (NAME_POSITIONS.has(word(tokens[i - 1]))) return false;
  // A later CTE of a WITH list: `…), get_lock (x) AS (…)`. It sits at the top level of the statement
  // after a comma, and its column list is followed by `AS (`. A call inside parentheses, such as
  // CAST(get_lock('n', 0) AS UNSIGNED), is never one.
  if (tokens[i - 1]?.text !== ',' || depthAt(tokens, i) !== 0) return true;
  let depth = 0;
  for (let j = i + 1; j < tokens.length; j++) {
    const text = tokens[j]?.text;
    if (text === '(') depth++;
    else if (text === ')' && --depth === 0)
      return !(word(tokens[j + 1]) === 'AS' && tokens[j + 2]?.text === '(');
  }
  return true;
}

/** Parentheses open before tokens[i]. */
function depthAt(tokens: Token[], i: number): number {
  let depth = 0;
  for (let j = 0; j < i; j++) {
    if (tokens[j]?.text === '(') depth++;
    else if (tokens[j]?.text === ')') depth = Math.max(0, depth - 1);
  }
  return depth;
}

/**
 * Names followed by `(` that never call a stored function: built-in functions (an unqualified call
 * runs the built-in even when a stored function has the same name), data types and keywords.
 * Anything else is looked up; a name missing here only costs that lookup.
 */
const NOT_STORED_FUNCTIONS = new Set(
  `
  values in exists row as on using and or not xor where select any some all over partition window
  lateral key index primary unique foreign references check constraint interval case when then else
  distinct by if char varchar binary varbinary decimal numeric dec float double real int integer
  bigint smallint tinyint mediumint bit enum set datetime timestamp time year text blob json point
  linestring polygon geometry signed unsigned
  count sum min max avg group_concat json_arrayagg json_objectagg std stddev stddev_pop stddev_samp
  variance var_pop var_samp bit_and bit_or bit_xor row_number rank dense_rank percent_rank cume_dist
  ntile lag lead first_value last_value nth_value grouping any_value
  now current_timestamp current_date current_time curdate curtime sysdate utc_timestamp utc_date
  utc_time unix_timestamp from_unixtime date date_add date_sub adddate subdate addtime subtime
  datediff timediff timestampdiff timestampadd date_format time_format str_to_date extract day
  dayofmonth dayofweek dayofyear dayname month monthname week weekday weekofyear yearweek hour minute
  second microsecond quarter last_day makedate maketime period_add period_diff to_days from_days
  sec_to_time time_to_sec convert_tz
  concat concat_ws substring substr substring_index left right length char_length
  character_length octet_length bit_length lower upper lcase ucase trim ltrim rtrim replace repeat
  reverse lpad rpad locate instr position format hex unhex md5 sha sha1 sha2 uuid uuid_short
  uuid_to_bin bin_to_uuid is_uuid ascii ord space strcmp field find_in_set elt make_set export_set
  insert quote soundex regexp_like regexp_replace regexp_substr regexp_instr weight_string
  coalesce ifnull nullif isnull greatest least cast convert
  abs ceil ceiling floor round truncate mod pow power sqrt exp ln log log2 log10 sign rand pi sin cos
  tan asin acos atan atan2 cot degrees radians crc32 bin oct conv
  json_extract json_unquote json_quote json_object json_array json_contains json_contains_path
  json_length json_depth json_keys json_set json_insert json_replace json_remove json_merge_patch
  json_merge_preserve json_valid json_type json_search json_table json_overlaps json_value
  json_pretty json_storage_size member
  database schema user current_user session_user system_user current_role version connection_id
  last_insert_id row_count found_rows charset collation coercion
  inet_aton inet_ntoa inet6_aton inet6_ntoa is_ipv4 is_ipv6 to_base64 from_base64 compress
  uncompress uncompressed_length aes_encrypt aes_decrypt random_bytes statement_digest
  statement_digest_text sleep benchmark get_lock release_lock release_all_locks is_free_lock
  is_used_lock load_file
  `
    .trim()
    .split(/\s+/),
);

/** Words before which `name (` (or `schema.name (`) is a table, index or column list. */
const LIST_POSITIONS = new Set([...NAME_POSITIONS, 'INSERT', 'REPLACE', 'REFERENCES', 'INDEX', 'KEY']);

/** Functions a statement calls that may be stored functions, as written (`f` or `schema.f`). */
function storedFunctionCalls(tokens: Token[]): TableRef[] {
  const calls = new Map<string, TableRef>();
  tokens.forEach((t, i) => {
    if (tokens[i + 1]?.text !== '(') return;
    const name = identifier(t);
    if (name === undefined) return;
    const qualified = tokens[i - 1]?.text === '.';
    const schema = qualified ? identifier(tokens[i - 2]) : null;
    if (schema === undefined) return;
    if (LIST_POSITIONS.has(word(tokens[qualified ? i - 3 : i - 1]))) return;
    if (!qualified) {
      if (t.kind === 'word' && NOT_STORED_FUNCTIONS.has(name.toLowerCase())) return;
      // A later CTE of a WITH list, `…), name (x) AS (…)`, is not a call.
      if (t.kind === 'word' && !isFunctionCall(tokens, i)) return;
    }
    calls.set(`${schema ?? ''}.${name.toLowerCase()}`, { schema, name });
  });
  return [...calls.values()];
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

/**
 * Tables a statement writes, with the trigger events each can fire: INSERT … ON DUPLICATE KEY
 * UPDATE also updates, and REPLACE deletes the row it replaces.
 */
function tablesWritten(tableList: string[], text: string): TableRef[] {
  // From the significant tokens, so comments between the keywords change nothing.
  const words = significant([...tokenize(text, 'mysql')]).map(word);
  const upsert = words.some(
    (w, i) =>
      w === 'ON' && words[i + 1] === 'DUPLICATE' && words[i + 2] === 'KEY' && words[i + 3] === 'UPDATE',
  );
  // The parser reports REPLACE INTO as an insert.
  const replace = words[0] === 'REPLACE';
  const eventsOf = (op: string): TriggerEvent[] => {
    switch (op.toLowerCase()) {
      case 'insert':
        if (replace) return ['INSERT', 'DELETE'];
        return upsert ? ['INSERT', 'UPDATE'] : ['INSERT'];
      case 'replace':
        return ['INSERT', 'DELETE'];
      case 'update':
        return ['UPDATE'];
      default:
        return ['DELETE'];
    }
  };
  return tableList
    .map((entry) => entry.split('::'))
    .filter(([op]) => /^(insert|update|delete|replace)$/i.test(op ?? ''))
    .map(([op, schema, name]) => ({
      schema: schema && schema !== 'null' ? schema : null,
      name: name ?? '',
      events: eventsOf(op ?? ''),
    }))
    .filter((t) => t.name && t.name !== 'null');
}

/**
 * Unqualified names the statement reads or writes outside the scope of any WITH that defines them
 * (a CTE's own definition sees only the CTEs before it, or all of them in WITH RECURSIVE), and
 * every name some WITH defines.
 */
function cteScopes(asts: unknown): { outside: Set<string>; defined: Set<string> } {
  const outside = new Set<string>();
  const defined = new Set<string>();
  const visit = (value: unknown, scope: ReadonlySet<string>): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, scope);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const node = value as Node;
    // A FROM item or a write target: { db, table, as }. Column references carry a table too.
    if (typeof node.table === 'string' && 'db' in node && node.type !== 'column_ref' && !('column' in node)) {
      const name = node.table.toLowerCase();
      if (!node.db && !scope.has(name)) outside.add(name);
    }
    if (!Array.isArray(node.with)) {
      for (const child of Object.values(node)) visit(child, scope);
      return;
    }
    const ctes = node.with as { name?: { value?: unknown }; recursive?: unknown }[];
    // Each WITH is recursive or not on its own: a nested WITH RECURSIVE changes nothing outside it.
    const recursive = ctes.some((w) => w?.recursive === true);
    const names = ctes.map((w) => (typeof w?.name?.value === 'string' ? w.name.value.toLowerCase() : ''));
    for (const name of names) if (name) defined.add(name);
    ctes.forEach((w, i) => visit(w, new Set([...scope, ...(recursive ? names : names.slice(0, i))])));
    const { with: _defined, ...rest } = node;
    for (const child of Object.values(rest)) visit(child, new Set([...scope, ...names]));
  };
  visit(asts, new Set());
  return { outside, defined };
}

/**
 * Every table or view the parser saw the statement name, once each. A name a WITH defines is left
 * out only when every unqualified reference to it lies within that WITH: an inner CTE does not hide
 * an outer view of the same name.
 */
function tablesReferenced(tableList: string[], asts: unknown): TableRef[] {
  const { outside, defined } = cteScopes(asts);
  const seen = new Map<string, TableRef>();
  for (const [, schema, name] of tableList.map((entry) => entry.split('::'))) {
    if (!name || name === 'null') continue;
    const unqualified = !schema || schema === 'null';
    if (unqualified && defined.has(name.toLowerCase()) && !outside.has(name.toLowerCase())) continue;
    const ref = { schema: schema && schema !== 'null' ? schema : null, name };
    seen.set(`${ref.schema ?? ''}.${name}`, ref);
  }
  return [...seen.values()];
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
  const referenced = tablesReferenced(parsed.tableList, asts);
  if (type !== 'select') {
    const a = unsafe(baseAnalysis('write', type.toUpperCase()), 'modifies data');
    a.writesTables = tablesWritten(parsed.tableList, text);
    if (!a.writesTables.length) a.writeTargetsUnknown = true;
    if (referenced.length) a.referencesTables = referenced;
    return a;
  }
  const a = baseAnalysis('read', 'SELECT');
  a.returnsRows = true;
  if (referenced.length) a.referencesTables = referenced;
  walk(asts, (node) => {
    const into = node.into as Node | undefined;
    const keyword = String(into?.keyword ?? '').toUpperCase();
    if (keyword === 'OUTFILE' || keyword === 'DUMPFILE') {
      a.kind = 'write';
      a.returnsRows = false;
      unsafe(a, `SELECT … INTO ${keyword} writes a file on the database server`);
      a.irreversible = 'writes a file on the database server';
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
  for (const assignment of setAssignments(tokens)) {
    const { scope, value } = assignment;
    // `autocommit` and @@session.`autocommit` name the same variable as autocommit.
    const name = assignment.name.replace(/`/g, '');
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
        const { tableList, ast } = parser.parse(text, OPTIONS);
        a.writesTables = tablesWritten(tableList, text);
        const referenced = tablesReferenced(tableList, ast);
        if (referenced.length) a.referencesTables = referenced;
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
        // LOAD DATA … REPLACE deletes the rows it replaces.
        const events: TriggerEvent[] = words.includes('REPLACE') ? ['INSERT', 'DELETE'] : ['INSERT'];
        if (target) a.writesTables = [{ ...target, events }];
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
    case 'EXECUTE': {
      const a = unsafe(
        baseAnalysis('unknown', 'EXECUTE'),
        'EXECUTE runs a prepared statement that cannot be checked',
      );
      // The prepared statement is unknown here: it may be DDL, which commits implicitly.
      a.mayCommit = true;
      return a;
    }
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
  // Wherever they appear (SELECT, VALUES ROW(…), INSERT … VALUES, UPDATE … SET), functions with
  // effects a read-only transaction does not stop make the statement unsafe, and a named lock
  // belongs to the connection, which must then not be reused by someone else.
  tokens.forEach((t, i) => {
    if (!isFunctionCall(tokens, i)) return;
    const name = t.text.toLowerCase();
    if (UNSAFE_FUNCTIONS[name]) unsafe(analysis, `${name}() ${UNSAFE_FUNCTIONS[name]}`);
    if (name === 'get_lock') analysis.changesSession = true;
    // LAST_INSERT_ID(expr) sets what LAST_INSERT_ID() returns later on the connection; a rollback
    // does not restore it.
    if (name === 'last_insert_id' && tokens[i + 2]?.text !== ')') analysis.changesSession = true;
  });
  const calls = storedFunctionCalls(tokens);
  if (calls.length) analysis.callsFunctions = calls;
  // `@v := …` assigns a user variable, which stays on the connection.
  if (tokens.some((t, i) => t.text === ':' && tokens[i + 1]?.text === '=' && tokens[i + 1]?.start === t.end))
    analysis.changesSession = true;
  return analysis;
}
