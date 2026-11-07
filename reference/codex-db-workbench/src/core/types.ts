export type Engine = 'postgres' | 'mysql';
export type Channel = 'gui' | 'api' | 'mcp';
export interface Actor {
  subject: string;
  roles: string[];
  channel: Channel;
  clientId: string;
  expiresAt: number;
  profileId?: string;
}
export interface Connection {
  id: string;
  owner: string;
  name: string;
  engine: Engine;
  host: string;
  port: number;
  database: string;
  username: string;
  password?: string;
  tls: boolean;
  ca?: string;
  readOnly: boolean;
  enabled: boolean;
}
export interface Profile {
  id: string;
  owner: string;
  name: string;
  clientId: string;
  connectionIds: string[];
  readOnly: boolean;
  enabled: boolean;
}
export interface ExecutionInput {
  connectionId: string;
  sql: string;
  capture: 'preview' | 'full';
  transaction: 'per_statement' | 'atomic';
  timeoutMs: number;
  retentionHours: number;
  requestKey: string;
}
export type Status =
  | 'queued'
  | 'running'
  | 'cancel_requested'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'interrupted'
  | 'unknown';
export interface Execution extends ExecutionInput {
  id: string;
  owner: string;
  actor: Actor;
  status: Status;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  transactionOutcome: 'pending' | 'committed' | 'rolled_back' | 'partial_commit' | 'unknown';
}
export type Cell = null | string | number | boolean | { base64: string };
export type Row = Cell[];
export interface Column {
  name: string;
  type: string;
}
export interface Result {
  id: string;
  executionId: string;
  statementIndex: number;
  sql: string;
  executedSql: string;
  columns: Column[];
  rows: number;
  bytes: number;
  affectedRows: number | null;
  completeness:
    'capturing' | 'complete' | 'preview_limited' | 'interrupted' | 'quota_limited' | 'expired';
  transactionOutcome: 'pending' | 'committed' | 'rolled_back' | 'unknown';
  expiresAt: number;
  durationMs: number;
}
export interface Batch {
  columns: Column[];
  rows: Row[];
  affectedRows?: number | null;
}
export interface Statement {
  sql: string;
  readOnly: boolean;
  type: string;
  writeTables: { database?: string; table: string }[];
}
export interface Session {
  begin(readOnly: boolean): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  query(sql: string, signal: AbortSignal): AsyncIterable<Batch>;
  cancel(): Promise<void>;
  close(): Promise<void>;
  validateAtomic?(statements: Statement[]): Promise<void>;
}
export interface Adapter {
  open(connection: Connection, timeoutMs: number): Promise<Session>;
}
export interface Limits {
  previewRows: number;
  previewBytes: number;
  responseBytes: number;
  maxResultBytes: number;
  maxTotalBytes: number;
  concurrency: number;
  maxTimeoutMs: number;
  maxRetentionHours: number;
}
export const DEFAULT_LIMITS: Limits = {
  previewRows: 1000,
  previewBytes: 256 * 1024,
  responseBytes: 256 * 1024,
  maxResultBytes: 100 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  concurrency: 2,
  maxTimeoutMs: 300_000,
  maxRetentionHours: 24 * 7,
};
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function assert(
  condition: unknown,
  code: string,
  message: string,
  status = 400,
): asserts condition {
  if (!condition) throw new AppError(code, message, status);
}
