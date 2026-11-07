import type { Engine } from '../domain/types.js';
import type { AnalyzedStatement, TableRef } from './types.js';

export type TransactionMode = 'per_statement' | 'atomic';

export type PreflightCode =
  | 'empty_script'
  | 'incomplete_statement'
  | 'parse_error'
  | 'read_only_violation'
  | 'transaction_control'
  | 'implicit_commit'
  | 'no_transaction_block'
  | 'non_transactional_engine'
  | 'unsupported_statement';

export interface PreflightProblem {
  code: PreflightCode;
  /** 0-based statement index, or null for the whole script. */
  statement: number | null;
  message: string;
  /** What to do instead. */
  hint?: string;
}

export interface PreflightOptions {
  engine: Engine;
  transactionMode: TransactionMode;
  /** Effective read-only policy from the user, connection and profile layers. */
  readOnly: boolean;
  /** Names the layers that make the policy read-only, for messages. */
  readOnlySources?: string[];
  /**
   * MySQL atomic mode: storage engine of a table, or null when unknown. Called only for tables the
   * script writes to.
   */
  tableEngine?: (table: TableRef) => Promise<string | null>;
}

const TRANSACTIONAL_ENGINES = new Set(['innodb', 'ndb', 'ndbcluster']);

const label = (s: AnalyzedStatement) => `Statement ${s.index + 1} (line ${s.range.startLine})`;

/**
 * Checks a script before anything runs. Every problem blocks the run; nothing is executed partly
 * because of a problem this check can see.
 */
export async function preflight(
  statements: AnalyzedStatement[],
  options: PreflightOptions,
): Promise<PreflightProblem[]> {
  const problems: PreflightProblem[] = [];
  if (!statements.length) {
    return [{ code: 'empty_script', statement: null, message: 'There is no statement to run.' }];
  }
  const sources = options.readOnlySources?.length
    ? ` (read-only from: ${options.readOnlySources.join(', ')})`
    : '';

  for (const s of statements) {
    const a = s.analysis;
    if (s.incomplete) {
      problems.push({
        code: 'incomplete_statement',
        statement: s.index,
        message: `${label(s)} has a string, quoted identifier or comment that is not closed.`,
      });
      continue;
    }
    if (a.unsupported) {
      problems.push({
        code: 'unsupported_statement',
        statement: s.index,
        message: `${label(s)}: ${a.unsupported}`,
      });
    }
    if (a.transactionControl) {
      problems.push({
        code: 'transaction_control',
        statement: s.index,
        message: `${label(s)} (${a.command}) controls transactions, but the workbench manages them in ${
          options.transactionMode === 'atomic' ? 'single-transaction' : 'per-statement'
        } mode.`,
        hint:
          options.transactionMode === 'atomic'
            ? 'Remove it; the whole script already runs in one transaction.'
            : 'Remove it, or choose single-transaction mode to run the script as one transaction.',
      });
    }
    if (options.readOnly && !a.readOnlySafe) {
      const parse = a.parseError ? `: ${a.parseError.message}` : '';
      problems.push({
        code: a.parseError ? 'parse_error' : 'read_only_violation',
        statement: s.index,
        message: a.parseError
          ? `${label(s)} could not be checked${parse}. Under a read-only policy, statements that cannot be checked do not run.`
          : `${label(s)} (${a.command}) is not allowed under a read-only policy${sources}: ${a.reasons.join('; ')}.`,
      });
    }
    if (options.transactionMode === 'atomic' && a.implicitCommit && !a.transactionControl) {
      problems.push({
        code: 'implicit_commit',
        statement: s.index,
        message: `${label(s)} (${a.command}) makes MySQL commit implicitly, so the script cannot run as one transaction.`,
        hint: 'Use per-statement mode, or run this statement separately.',
      });
    }
    if (options.transactionMode === 'atomic' && a.noTransactionBlock) {
      problems.push({
        code: 'no_transaction_block',
        statement: s.index,
        message: `${label(s)} (${a.command}) cannot run inside a transaction block.`,
        hint: 'Use per-statement mode, or run this statement separately.',
      });
    }
  }

  if (options.engine === 'mysql' && options.transactionMode === 'atomic') {
    const seen = new Map<string, string | null>();
    for (const s of statements) {
      const declared = s.analysis.declaredEngine?.toLowerCase();
      if (declared && !TRANSACTIONAL_ENGINES.has(declared)) {
        problems.push({
          code: 'non_transactional_engine',
          statement: s.index,
          message: `${label(s)} uses the ${s.analysis.declaredEngine} storage engine, which cannot roll back.`,
          hint: 'Use InnoDB, or per-statement mode.',
        });
      }
      if (!options.tableEngine) continue;
      for (const table of s.analysis.writesTables) {
        const key = `${table.schema ?? ''}.${table.name}`.toLowerCase();
        if (!seen.has(key)) seen.set(key, await options.tableEngine(table));
        const engine = seen.get(key);
        if (engine && !TRANSACTIONAL_ENGINES.has(engine.toLowerCase())) {
          problems.push({
            code: 'non_transactional_engine',
            statement: s.index,
            message: `${label(s)} writes to ${table.schema ? `${table.schema}.` : ''}${table.name}, a ${engine} table. Changes to it cannot be rolled back.`,
            hint: 'Use per-statement mode, which reports each statement’s outcome honestly.',
          });
        }
      }
    }
  }
  return problems;
}
