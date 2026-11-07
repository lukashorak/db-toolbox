import parserPackage from 'node-sql-parser';
import { assert, AppError, type Engine, type Statement } from './types.js';
const parser = new parserPackage.Parser();
type Token = { text: string; start: number; end: number; depth: number };

// A lexical splitter preserves original numeric literals and quoting. Parsing is
// used for policy, never to round-trip and rewrite the submitted SQL.
function scan(sql: string, engine: Engine): { tokens: Token[]; ends: number[] } {
  const tokens: Token[] = [];
  const ends: number[] = [];
  let depth = 0;
  for (let i = 0; i < sql.length;) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (sql.startsWith('--', i) || (engine === 'mysql' && c === '#')) {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      assert(
        !sql.startsWith('/*!', i) && !sql.startsWith('/*M!', i),
        'UNSUPPORTED_SQL',
        'Executable SQL comments are not supported.',
      );
      let level = 1;
      i += 2;
      while (i < sql.length && level) {
        if (sql.startsWith('/*', i)) {
          level++;
          i += 2;
        } else if (sql.startsWith('*/', i)) {
          level--;
          i += 2;
        } else i++;
      }
      assert(!level, 'INVALID_SQL', 'Unterminated SQL comment.');
      continue;
    }
    const dollar =
      engine === 'postgres'
        ? sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/)?.[0]
        : undefined;
    if (dollar) {
      const end = sql.indexOf(dollar, i + dollar.length);
      assert(end >= 0, 'INVALID_SQL', 'Unterminated dollar-quoted SQL.');
      tokens.push({ text: '<literal>', start: i, end: end + dollar.length, depth });
      i = end + dollar.length;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const start = i++;
      const escapeBackslash =
        engine === 'mysql' ||
        (c === "'" && /[eE]/.test(sql[start - 1] ?? '') && !/[\w]/.test(sql[start - 2] ?? ''));
      let closed = false;
      while (i < sql.length) {
        if (escapeBackslash && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      assert(closed, 'INVALID_SQL', 'Unterminated SQL string or identifier.');
      tokens.push({ text: c === "'" ? '<literal>' : sql.slice(start, i), start, end: i, depth });
      continue;
    }
    if (c === ';' && depth === 0) {
      ends.push(i);
      i++;
      continue;
    }
    if (c === '(') {
      tokens.push({ text: c, start: i, end: i + 1, depth });
      depth++;
      i++;
      continue;
    }
    if (c === ')') {
      depth--;
      assert(depth >= 0, 'INVALID_SQL', 'Unbalanced SQL parentheses.');
      i++;
      continue;
    }
    const text = sql.slice(i).match(/^[A-Za-z_][A-Za-z_0-9$]*|^\d+(?:\.\d+)?/)?.[0] ?? c;
    tokens.push({ text: text.toLowerCase(), start: i, end: i + text.length, depth });
    i += text.length;
  }
  assert(depth === 0, 'INVALID_SQL', 'Unbalanced SQL parentheses.');
  return { tokens, ends };
}
export function splitStatements(sql: string, engine: Engine): string[] {
  const { ends } = scan(sql, engine);
  let start = 0;
  const statements: string[] = [];
  for (const end of [...ends, sql.length]) {
    const part = sql.slice(start, end).trim();
    start = end + 1;
    if (scan(part, engine).tokens.length) statements.push(part);
  }
  return statements;
}
const safeFunctions = new Set(
  'count sum avg min max abs round ceil ceiling floor mod power sqrt coalesce nullif greatest least lower upper length char_length octet_length concat concat_ws substring substr trim ltrim rtrim replace left right position strpos split_part date_trunc date_part extract to_char to_date to_timestamp date_format datediff timestampdiff ifnull if cast convert now current_date current_timestamp current_time localtimestamp row_number rank dense_rank lag lead first_value last_value nth_value ntile percent_rank cume_dist json_extract json_unquote json_array_length json_type jsonb_typeof jsonb_array_length json_build_object jsonb_build_object array_agg string_agg group_concat bool_and bool_or every stddev variance round trunc generate_series pg_sleep'.split(
    ' ',
  ),
);
function safeRead(node: any): boolean {
  if (!node || typeof node !== 'object') return true;
  if (Array.isArray(node)) return node.every(safeRead);
  if (
    [
      'insert',
      'update',
      'delete',
      'create',
      'drop',
      'alter',
      'truncate',
      'call',
      'set',
      'exec',
      'execute',
      'replace',
    ].includes(node.type)
  )
    return false;
  if (node.type === 'select' && (node.locking_read || node.for_update || node.into?.position))
    return false;
  if (node.type === 'function' || node.type === 'aggr_func') {
    const name =
      typeof node.name === 'string'
        ? node.name
        : node.name?.name?.map((n: any) => n.value).join('.');
    const schema = node.name?.schema?.value;
    if (!name || !safeFunctions.has(name.toLowerCase()) || (schema && schema !== 'pg_catalog'))
      return false;
  }
  if (node.type === 'var' || node.type === 'assign') return false;
  return Object.values(node).every(safeRead);
}
export function analyze(
  sql: string,
  engine: Engine,
  readOnly: boolean,
  transaction: 'atomic' | 'per_statement',
): Statement[] {
  const statements = splitStatements(sql, engine);
  assert(
    statements.length > 0 && statements.length <= 50,
    'INVALID_SCRIPT',
    'A script must contain between 1 and 50 statements.',
  );
  return statements.map((text) => {
    let ast: any;
    try {
      ast = parser.astify(text, { database: engine === 'postgres' ? 'Postgresql' : 'MySQL' });
    } catch {
      throw new AppError(
        'UNSUPPORTED_SQL',
        'This SQL is outside the supported parser grammar. It was not executed.',
      );
    }
    assert(!Array.isArray(ast), 'INVALID_SCRIPT', 'Statement boundaries could not be validated.');
    const isRead = ast.type === 'select' && safeRead(ast);
    assert(
      !readOnly || isRead,
      'READ_ONLY',
      'This operation is not allowed by the effective read-only policy.',
      403,
    );
    // Manual session commands and procedures are a separate future milestone.
    assert(
      ['select', 'insert', 'update', 'delete', 'create', 'alter', 'drop', 'truncate'].includes(
        ast.type,
      ),
      'UNSUPPORTED_SQL',
      'Only queries, DML and standalone DDL are supported in this milestone.',
    );
    if (transaction === 'atomic')
      assert(
        ['select', 'insert', 'update', 'delete'].includes(ast.type),
        'NON_ATOMIC_SQL',
        'DDL and implicit-commit operations cannot be used in atomic script mode.',
      );
    const tableNodes = ast.type === 'insert' ? ast.table : (ast.table ?? []);
    const writeTables = ['insert', 'update', 'delete'].includes(ast.type)
      ? (Array.isArray(tableNodes) ? tableNodes : [tableNodes])
          .filter((n: any) => n?.table)
          .map((n: any) => ({ database: n.db ?? undefined, table: n.table }))
      : [];
    return { sql: text, readOnly: isRead, type: ast.type, writeTables };
  });
}
export function previewSql(statement: Statement, engine: Engine, maxRows: number): string {
  if (!statement.readOnly) return statement.sql;
  const tokens = scan(statement.sql, engine).tokens.filter((t) => t.depth === 0);
  const index = tokens.findLastIndex((t) => t.text === 'limit');
  if (index < 0) return `${statement.sql}\nLIMIT ${maxRows}`;
  let count = tokens[index + 1];
  if (engine === 'mysql' && tokens[index + 2]?.text === ',') count = tokens[index + 3];
  assert(
    count && /^\d+$/.test(count.text),
    'UNSUPPORTED_LIMIT',
    'Preview requires a literal numeric LIMIT. Use full execution for other forms.',
  );
  const bounded = Math.min(Number(count.text), maxRows);
  return statement.sql.slice(0, count.start) + bounded + statement.sql.slice(count.end);
}
