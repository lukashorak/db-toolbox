/** Execution shapes from the API (docs/executions.md). */
export interface StatementView {
  ordinal: number;
  sql: string;
  kind: string;
  command: string;
  range: {
    start: number;
    end: number;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
  status: string;
  transactionOutcome: string;
  affectedRows: number | null;
  error: {
    code: string | null;
    message: string;
    detail: { category?: string; position?: { offset?: number; line?: number } | null } | null;
  } | null;
  notices: string[];
  startedAt: string | null;
  durationMs: number | null;
}

export interface ResultSetView {
  index: number;
  statement: number;
  columns: { name: string; type: string; binary: boolean }[];
  rowCount: number;
  byteCount: number;
  moreAvailable: boolean;
  completeness: string;
  expiresAt: string | null;
}

export interface ExecutionView {
  id: string;
  title: string;
  source: string;
  clientId: string;
  profile: { id: string | null; name: string } | null;
  connection: { id: string | null; name: string; engine: string };
  requestKey: string;
  sql: string;
  scope: string;
  captureMode: 'preview' | 'full';
  transactionMode: 'per_statement' | 'atomic';
  continueOnError: boolean;
  timeoutMs: number;
  retention: 'working' | 'retained';
  readOnly: boolean;
  policySources: string[];
  status: string;
  statusNote: string | null;
  transactionOutcome: string;
  submittedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequestedAt: string | null;
  error: { code: string | null; message: string; detail: unknown } | null;
  queue: { position: number; reason: string } | null;
  statements: StatementView[];
  resultSets: ResultSetView[];
  resultExpiresAt: string | null;
}

export interface ExportView {
  id: string;
  resultIndex: number;
  format: 'csv' | 'json';
  previewOnly: boolean;
  status: string;
  fileName: string | null;
  rowCount: number;
  byteCount: number;
  error: { code: string; message: string } | null;
  createdAt: string;
}

export interface CheckedStatement {
  index: number;
  range: {
    start: number;
    end: number;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
  incomplete: boolean;
  kind: string;
  command: string;
  readOnlySafe: boolean;
  returnsRows: boolean;
  reasons: string[];
}

export interface Problem {
  code: string;
  statement: number | null;
  message: string;
  hint?: string;
}

export const TERMINAL = new Set([
  'succeeded',
  'failed',
  'rejected',
  'preflight_rejected',
  'cancelled',
  'timed_out',
  'interrupted',
  'unknown',
]);

/** Where in the editor an error points: absolute offsets within the text that was run. */
export function errorRange(statement: StatementView, base: number): { from: number; to: number } {
  const position = statement.error?.detail?.position;
  const from = base + statement.range.start + (position?.offset ?? 0);
  return position?.offset !== undefined
    ? { from, to: from + 1 }
    : { from: base + statement.range.start, to: base + statement.range.end };
}
