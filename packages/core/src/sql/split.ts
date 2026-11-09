import type { Engine } from '../domain/types.js';
import { tokenize, type Token } from './lexer.js';

export interface SourceRange {
  /** UTF-16 offsets into the script, end exclusive (what the editor uses). */
  start: number;
  end: number;
  /** 1-based line and column of the first and last character. */
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface SplitStatement {
  /** 0-based position in the script. */
  index: number;
  /** Statement text without the delimiter and surrounding whitespace or comments. */
  text: string;
  range: SourceRange;
  /** A string, identifier or comment is not closed. */
  incomplete: boolean;
  /** MySQL executable comment (`/*! … *\/`) present. */
  executableComment: boolean;
}

/** Maps offsets to 1-based line and column. */
export function lineIndex(source: string) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  return (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - (starts[lo] as number) + 1 };
  };
}

/**
 * Splits a script into statements. Delimiters inside strings, quoted identifiers, comments,
 * PostgreSQL dollar quotes and `BEGIN ATOMIC … END` bodies do not split. MySQL `DELIMITER`
 * lines change the delimiter and are not statements.
 */
export function splitStatements(sql: string, dialect: Engine): SplitStatement[] {
  const position = lineIndex(sql);
  const statements: SplitStatement[] = [];
  let current: Token[] = [];
  let atomicDepth = 0;
  let previousWord = '';

  const flush = () => {
    const meaningful = current.filter((t) => t.kind !== 'whitespace' && t.kind !== 'comment');
    const first = meaningful[0];
    const last = meaningful[meaningful.length - 1];
    if (first && last) {
      const start = first.start;
      const end = last.end;
      const from = position(start);
      const to = position(Math.max(start, end - 1));
      statements.push({
        index: statements.length,
        text: sql.slice(start, end),
        range: {
          start,
          end,
          startLine: from.line,
          startColumn: from.column,
          endLine: to.line,
          endColumn: to.column,
        },
        incomplete: current.some((t) => t.unterminated),
        executableComment: current.some((t) => t.kind === 'executable_comment'),
      });
    }
    current = [];
    atomicDepth = 0;
    previousWord = '';
  };

  for (const t of tokenize(sql, dialect)) {
    if (t.kind === 'delimiter_command') {
      flush();
      continue;
    }
    if (t.kind === 'delimiter' && atomicDepth === 0) {
      flush();
      continue;
    }
    if (dialect === 'postgresql' && t.kind === 'word') {
      const word = t.text.toUpperCase();
      if (atomicDepth === 0 && word === 'ATOMIC' && previousWord === 'BEGIN') atomicDepth = 1;
      else if (atomicDepth > 0 && word === 'CASE') atomicDepth++;
      else if (atomicDepth > 0 && word === 'END') atomicDepth--;
      previousWord = word;
    }
    current.push(t);
  }
  flush();
  return statements;
}
