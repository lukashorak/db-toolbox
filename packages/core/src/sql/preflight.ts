import type { Engine } from '../domain/types.js';
import { TRANSACTIONAL_ENGINES, UNRESOLVED_VIEW, type AnalyzedStatement, type TableRef } from './types.js';

export type TransactionMode = 'per_statement' | 'atomic';

export type PreflightCode =
  | 'empty_script'
  | 'incomplete_statement'
  | 'parse_error'
  | 'read_only_violation'
  | 'transaction_control'
  | 'implicit_commit'
  | 'no_transaction_block'
  | 'routine_may_commit'
  | 'unchecked_write_target'
  | 'irreversible_effect'
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
  /**
   * MySQL atomic mode: what a called function writes (see DbAdapter.functionEngine). Called only for
   * scripts that may write.
   */
  functionEngine?: (fn: TableRef) => Promise<string | null>;
  /** MySQL atomic mode: what reading a named relation writes (see DbAdapter.viewEngine). */
  viewEngine?: (table: TableRef) => Promise<string | null>;
}

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
    if (options.transactionMode === 'atomic' && a.mayCommit) {
      problems.push({
        code: 'routine_may_commit',
        statement: s.index,
        message:
          a.command === 'EXECUTE'
            ? `${label(s)} (EXECUTE) runs a prepared statement that cannot be checked; it can commit implicitly in MySQL, so the script cannot be promised to run as one transaction.`
            : `${label(s)} (${a.command}) runs a procedure, which can commit on its own in MySQL, so the script cannot be promised to run as one transaction.`,
        hint: 'Use per-statement mode.',
      });
    }
    if (options.transactionMode === 'atomic' && a.irreversible) {
      problems.push({
        code: 'irreversible_effect',
        statement: s.index,
        message: `${label(s)} (${a.command}) ${a.irreversible}, which a rollback does not undo, so the script cannot be promised to run as one transaction.`,
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
    // USE changes which database unqualified names refer to for the rest of the script.
    let database: string | null = null;
    for (const s of statements) {
      if (s.analysis.usesDatabase !== undefined) database = s.analysis.usesDatabase;
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
      if (s.analysis.writeTargetsUnknown) {
        problems.push({
          code: 'unchecked_write_target',
          statement: s.index,
          message: `${label(s)} (${s.analysis.command}) writes to tables that could not be determined, so whether they can roll back cannot be checked.`,
          hint: 'Use per-statement mode, which reports each statement’s outcome honestly.',
        });
      }
      for (const written of s.analysis.writesTables) {
        const table: TableRef = { ...written, schema: written.schema ?? database };
        // Exact case: on servers with case-sensitive names, `Ledger` and `ledger` are two tables.
        const key = `${table.schema ?? ''}.${table.name}|${table.events?.join(',') ?? '*'}`;
        if (!seen.has(key)) seen.set(key, await options.tableEngine(table));
        const engine = seen.get(key);
        if (engine === UNRESOLVED_VIEW) {
          problems.push({
            code: 'unchecked_write_target',
            statement: s.index,
            message: `${label(s)} writes to ${table.schema ? `${table.schema}.` : ''}${table.name}, whose effects could not be determined (the tables beneath a view, or triggers the account cannot see), so whether the write can roll back cannot be checked.`,
            hint: 'Use per-statement mode. On MySQL, an account needs the TRIGGER privilege to see a table’s triggers.',
          });
        } else if (engine && !TRANSACTIONAL_ENGINES.has(engine.toLowerCase())) {
          problems.push({
            code: 'non_transactional_engine',
            statement: s.index,
            message: `${label(s)} writes to ${table.schema ? `${table.schema}.` : ''}${table.name}, a ${engine} table. Changes to it cannot be rolled back.`,
            hint: 'Use per-statement mode, which reports each statement’s outcome honestly.',
          });
        }
      }
      // Stored functions run inside the statement and can write too. A read-only transaction stops
      // their writes; statements refused above for committing are not looked into.
      if (!options.functionEngine || options.readOnly || s.analysis.implicitCommit || s.analysis.mayCommit)
        continue;
      for (const called of s.analysis.callsFunctions ?? []) {
        const fn: TableRef = { schema: called.schema ?? database, name: called.name };
        const name = `${fn.schema ? `${fn.schema}.` : ''}${fn.name}()`;
        const key = `\u0000fn ${fn.schema ?? ''}.${fn.name.toLowerCase()}`;
        if (!seen.has(key)) seen.set(key, await options.functionEngine(fn));
        const engine = seen.get(key);
        const base = engine?.split(' ')[0];
        if (engine === UNRESOLVED_VIEW) {
          problems.push({
            code: 'unchecked_write_target',
            statement: s.index,
            message: `${label(s)} calls ${name}, a stored function whose effects could not be determined (its body is hidden from the account, or does more than plain reads and writes), so whether the script can roll back cannot be checked.`,
            hint: 'Use per-statement mode. On MySQL, an account sees the body of a function it did not define only with SHOW_ROUTINE.',
          });
        } else if (base && !TRANSACTIONAL_ENGINES.has(base.toLowerCase())) {
          problems.push({
            code: 'non_transactional_engine',
            statement: s.index,
            message: `${label(s)} calls ${name}, which writes to a ${base} table. Those changes cannot be rolled back.`,
            hint: 'Use per-statement mode, which reports each statement’s outcome honestly.',
          });
        }
      }
      // A view's definition can call stored functions too, whichever statement names it.
      for (const named of options.viewEngine ? (s.analysis.referencesTables ?? []) : []) {
        const view: TableRef = { schema: named.schema ?? database, name: named.name };
        const name = `${view.schema ? `${view.schema}.` : ''}${view.name}`;
        const key = `\u0000view ${view.schema ?? ''}.${view.name}`;
        if (!seen.has(key)) seen.set(key, await options.viewEngine!(view));
        const engine = seen.get(key);
        const base = engine?.split(' ')[0];
        if (engine === UNRESOLVED_VIEW) {
          problems.push({
            code: 'unchecked_write_target',
            statement: s.index,
            message: `${label(s)} uses the view ${name}, whose definition or the stored functions it calls could not be checked, so whether the script can roll back cannot be checked.`,
            hint: 'Use per-statement mode. On MySQL, an account sees a view’s definition only with SHOW VIEW, and a function’s body only with SHOW_ROUTINE.',
          });
        } else if (base && !TRANSACTIONAL_ENGINES.has(base.toLowerCase())) {
          problems.push({
            code: 'non_transactional_engine',
            statement: s.index,
            message: `${label(s)} uses the view ${name}, which calls a stored function that writes to a ${base} table. Those changes cannot be rolled back.`,
            hint: 'Use per-statement mode, which reports each statement’s outcome honestly.',
          });
        }
      }
    }
  }
  return problems;
}
