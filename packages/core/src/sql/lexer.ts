import type { Engine } from '../domain/types.js';

export type TokenKind =
  | 'word'
  | 'quoted_identifier'
  | 'string'
  | 'number'
  | 'parameter'
  | 'operator'
  | 'delimiter'
  | 'comment'
  /** MySQL `/*! … *\/`: the server executes its content. */
  | 'executable_comment'
  /** MySQL client command `DELIMITER x` (not sent to the server). */
  | 'delimiter_command'
  | 'whitespace';

export interface Token {
  kind: TokenKind;
  text: string;
  /** UTF-16 offsets into the source, end exclusive. */
  start: number;
  end: number;
  /** Set when a string, identifier or comment runs to the end of the input. */
  unterminated?: true;
  /** For `delimiter_command`: the new delimiter. */
  delimiter?: string;
}

const isWordStart = (c: string) => /[A-Za-z_\u0080-￿]/.test(c);
const isWordPart = (c: string, dialect: Engine) =>
  /[A-Za-z0-9_\u0080-￿]/.test(c) || c === '$' || (dialect === 'mysql' && c === '@');
const isDigit = (c: string) => c >= '0' && c <= '9';
const isSpace = (c: string) =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';

/**
 * Dialect-aware SQL tokenizer. It is lexical only: it knows quoting and comment rules well
 * enough to find statement boundaries and leading keywords, and leaves grammar to the parsers.
 */
export function* tokenize(sql: string, dialect: Engine): Generator<Token> {
  let i = 0;
  let delimiter = ';';
  let lineStart = true;
  const n = sql.length;

  const token = (kind: TokenKind, start: number, end: number, extra: Partial<Token> = {}): Token => ({
    kind,
    text: sql.slice(start, end),
    start,
    end,
    ...extra,
  });

  /** Scans a quoted run starting at `i` (on the opening quote). Returns [end, terminated]. */
  const quoted = (quote: string, backslash: boolean): [number, boolean] => {
    let j = i + 1;
    while (j < n) {
      const c = sql[j];
      if (backslash && c === '\\') {
        j += 2;
        continue;
      }
      if (c === quote) {
        if (sql[j + 1] === quote) {
          j += 2;
          continue;
        }
        return [j + 1, true];
      }
      j++;
    }
    return [n, false];
  };

  while (i < n) {
    const c = sql[i] as string;
    const next = sql[i + 1] ?? '';
    const start = i;

    if (isSpace(c)) {
      while (i < n && isSpace(sql[i] as string)) {
        if (sql[i] === '\n') lineStart = true;
        i++;
      }
      yield token('whitespace', start, i);
      continue;
    }

    // MySQL client command: DELIMITER at the start of a line, up to the end of the line.
    if (dialect === 'mysql' && lineStart && /^delimiter[ \t]/i.test(sql.slice(i, i + 10))) {
      let j = i + 9;
      while (j < n && sql[j] !== '\n') j++;
      const value = sql.slice(i + 9, j).trim();
      if (value) {
        delimiter = value;
        i = j;
        yield token('delimiter_command', start, i, { delimiter: value });
        continue;
      }
    }
    lineStart = false;

    if (sql.startsWith(delimiter, i)) {
      i += delimiter.length;
      yield token('delimiter', start, i);
      continue;
    }

    // Line comments: `--` (MySQL requires whitespace or end of input after it) and MySQL `#`.
    if (
      (c === '-' && next === '-' && (dialect !== 'mysql' || i + 2 >= n || isSpace(sql[i + 2] as string))) ||
      (dialect === 'mysql' && c === '#')
    ) {
      while (i < n && sql[i] !== '\n') i++;
      yield token('comment', start, i);
      continue;
    }

    if (c === '/' && next === '*') {
      const executable = dialect === 'mysql' && sql[i + 2] === '!';
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--;
          j += 2;
        } else if (dialect === 'postgresql' && sql[j] === '/' && sql[j + 1] === '*') {
          depth++;
          j += 2;
        } else j++;
      }
      i = j;
      yield token(
        executable ? 'executable_comment' : 'comment',
        start,
        i,
        depth > 0 ? { unterminated: true } : {},
      );
      continue;
    }

    if (c === "'" || (dialect === 'mysql' && c === '"')) {
      const [end, ok] = quoted(c, dialect === 'mysql');
      i = end;
      yield token('string', start, i, ok ? {} : { unterminated: true });
      continue;
    }

    if (dialect === 'postgresql' && (c === 'E' || c === 'e') && next === "'") {
      i++;
      const [end, ok] = quoted("'", true);
      i = end;
      yield token('string', start, i, ok ? {} : { unterminated: true });
      continue;
    }

    if ((dialect === 'postgresql' && c === '"') || (dialect === 'mysql' && c === '`')) {
      const [end, ok] = quoted(c, false);
      i = end;
      yield token('quoted_identifier', start, i, ok ? {} : { unterminated: true });
      continue;
    }

    if (dialect === 'postgresql' && c === '$') {
      if (isDigit(next)) {
        i++;
        while (i < n && isDigit(sql[i] as string)) i++;
        yield token('parameter', start, i);
        continue;
      }
      const tag = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(sql.slice(i, i + 64));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        i = close === -1 ? n : close + tag[0].length;
        yield token('string', start, i, close === -1 ? { unterminated: true } : {});
        continue;
      }
    }

    if (isDigit(c) || (c === '.' && isDigit(next))) {
      while (i < n && /[0-9A-Za-z_.]/.test(sql[i] as string)) {
        // Exponent sign: 1e-5
        if ((sql[i] === 'e' || sql[i] === 'E') && (sql[i + 1] === '-' || sql[i + 1] === '+')) i++;
        i++;
      }
      yield token('number', start, i);
      continue;
    }

    if (isWordStart(c) || (dialect === 'mysql' && c === '@')) {
      i++;
      while (i < n && isWordPart(sql[i] as string, dialect)) i++;
      yield token('word', start, i);
      continue;
    }

    i++;
    yield token('operator', start, i);
  }
}

/** Significant tokens: no whitespace, comments or client commands. */
export function significant(tokens: Iterable<Token>): Token[] {
  const result: Token[] = [];
  for (const t of tokens) {
    if (t.kind !== 'whitespace' && t.kind !== 'comment' && t.kind !== 'delimiter_command') result.push(t);
  }
  return result;
}

/** Upper-cased leading words of a statement, for keyword-level rules. */
export function leadingWords(sql: string, dialect: Engine, count = 4): string[] {
  const words: string[] = [];
  for (const t of tokenize(sql, dialect)) {
    if (t.kind === 'whitespace' || t.kind === 'comment') continue;
    if (t.kind !== 'word') break;
    words.push(t.text.toUpperCase());
    if (words.length >= count) break;
  }
  return words;
}
