import type { Engine } from '../domain/types.js';
import { analyzeMysql } from './analyze-mysql.js';
import { analyzePostgres, loadPostgresParser } from './analyze-postgres.js';
import { splitStatements } from './split.js';
import { baseAnalysis, unsafe, type AnalyzedStatement, type StatementAnalysis } from './types.js';

/** Analyzes one statement for the given engine. */
export async function analyzeStatement(text: string, engine: Engine): Promise<StatementAnalysis> {
  if (engine === 'postgresql') {
    await loadPostgresParser();
    return analyzePostgres(text);
  }
  return analyzeMysql(text);
}

/**
 * Splits a script and analyzes every statement. Classification comes from the engine's parser;
 * when the parser cannot decide, the statement is `unknown` and not read-only safe.
 */
export async function analyzeScript(sql: string, engine: Engine): Promise<AnalyzedStatement[]> {
  if (engine === 'postgresql') await loadPostgresParser();
  return splitStatements(sql, engine).map((statement) => {
    let analysis: StatementAnalysis;
    if (statement.incomplete) {
      analysis = unsafe(
        baseAnalysis('unknown', 'INCOMPLETE'),
        'a string, identifier or comment is not closed',
      );
    } else {
      analysis = engine === 'postgresql' ? analyzePostgres(statement.text) : analyzeMysql(statement.text);
    }
    return { ...statement, analysis };
  });
}
