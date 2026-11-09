import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SecretBox } from './secrets.js';
import type { Actor, Connection, Execution, Profile, Result, Row, Status } from './types.js';

type RecordRow = Record<string, any>;
export interface ExportRecord {
  id: string;
  owner: string;
  resultId: string;
  format: 'csv' | 'json';
  path: string;
  bytes: number;
  rows: number;
  expiresAt: number;
  createdAt: number;
}
export class Store {
  readonly db: DatabaseSync;
  constructor(
    path: string,
    private secrets: SecretBox,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    const version = (this.db.prepare('PRAGMA user_version').get() as RecordRow).user_version;
    if (version > 1) throw new Error('The application database was created by a newer version.');
    if (version === 0)
      this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE connections(id TEXT PRIMARY KEY, owner TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE profiles(id TEXT PRIMARY KEY, owner TEXT NOT NULL, client_id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE executions(id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(owner,request_key));
      CREATE INDEX executions_owner_created ON executions(owner,created_at);
      CREATE TABLE results(id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(execution_id,ordinal));
      CREATE TABLE chunks(result_id TEXT NOT NULL REFERENCES results(id) ON DELETE CASCADE, start_row INTEGER NOT NULL, row_count INTEGER NOT NULL, bytes INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(result_id,start_row));
      CREATE TABLE approvals(result_id TEXT NOT NULL REFERENCES results(id) ON DELETE CASCADE, profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, owner TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(result_id,profile_id));
      CREATE TABLE exports(id TEXT PRIMARY KEY, owner TEXT NOT NULL, result_id TEXT NOT NULL REFERENCES results(id) ON DELETE CASCADE, payload TEXT NOT NULL);
      CREATE TABLE records(kind TEXT NOT NULL, id TEXT PRIMARY KEY, owner TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, owner TEXT NOT NULL, source TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL);
      PRAGMA user_version=1;
      COMMIT;
    `);
  }
  close(): void {
    this.db.close();
  }
  saveConnection(value: Connection): void {
    this.db
      .prepare(
        'INSERT INTO connections VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      )
      .run(value.id, value.owner, this.secrets.seal(value));
  }
  connection(id: string): Connection | undefined {
    const r = this.db.prepare('SELECT payload FROM connections WHERE id=?').get(id) as
      RecordRow | undefined;
    return r ? this.secrets.open<Connection>(r.payload) : undefined;
  }
  connections(owner: string): Connection[] {
    return this.db
      .prepare('SELECT payload FROM connections WHERE owner=?')
      .all(owner)
      .map((r) => this.secrets.open<Connection>(r.payload as string));
  }
  saveProfile(value: Profile): void {
    this.db
      .prepare(
        'INSERT INTO profiles VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET client_id=excluded.client_id,payload=excluded.payload',
      )
      .run(value.id, value.owner, value.clientId, JSON.stringify(value));
  }
  profile(id: string): Profile | undefined {
    return this.payload<Profile>('SELECT payload FROM profiles WHERE id=?', id);
  }
  profileByClient(clientId: string): Profile | undefined {
    return this.payload<Profile>('SELECT payload FROM profiles WHERE client_id=?', clientId);
  }
  profiles(owner: string): Profile[] {
    return this.payloads<Profile>('SELECT payload FROM profiles WHERE owner=?', owner);
  }
  execution(id: string): Execution | undefined {
    return this.payload<Execution>('SELECT payload FROM executions WHERE id=?', id);
  }
  existing(owner: string, key: string): { execution: Execution; fingerprint: string } | undefined {
    const row = this.db
      .prepare('SELECT payload,fingerprint FROM executions WHERE owner=? AND request_key=?')
      .get(owner, key) as RecordRow | undefined;
    return row ? { execution: JSON.parse(row.payload), fingerprint: row.fingerprint } : undefined;
  }
  addExecution(value: Execution, fingerprint: string): void {
    this.db
      .prepare('INSERT INTO executions VALUES(?,?,?,?,?,?,?)')
      .run(
        value.id,
        value.owner,
        value.requestKey,
        fingerprint,
        value.status,
        value.createdAt,
        JSON.stringify(value),
      );
  }
  saveExecution(value: Execution): void {
    this.db
      .prepare('UPDATE executions SET status=?,payload=? WHERE id=?')
      .run(value.status, JSON.stringify(value), value.id);
  }
  executions(owner: string, limit = 100): Execution[] {
    return this.payloads<Execution>(
      'SELECT payload FROM executions WHERE owner=? ORDER BY created_at DESC LIMIT ?',
      owner,
      limit,
    );
  }
  unfinished(): Execution[] {
    return this.payloads<Execution>(
      "SELECT payload FROM executions WHERE status IN ('queued','running','cancel_requested') ORDER BY created_at",
    );
  }
  addResult(execution: Execution, index: number, sql: string, executedSql: string): Result {
    const value: Result = {
      id: randomUUID(),
      executionId: execution.id,
      statementIndex: index,
      sql,
      executedSql,
      columns: [],
      rows: 0,
      bytes: 0,
      affectedRows: null,
      completeness: 'capturing',
      transactionOutcome: 'pending',
      expiresAt: Date.now() + execution.retentionHours * 3600_000,
      durationMs: 0,
    };
    this.db
      .prepare('INSERT INTO results VALUES(?,?,?,?)')
      .run(value.id, value.executionId, index, JSON.stringify(value));
    return value;
  }
  result(id: string): Result | undefined {
    return this.payload<Result>('SELECT payload FROM results WHERE id=?', id);
  }
  results(executionId: string): Result[] {
    return this.payloads<Result>(
      'SELECT payload FROM results WHERE execution_id=? ORDER BY ordinal',
      executionId,
    );
  }
  saveResult(value: Result): void {
    this.db.prepare('UPDATE results SET payload=? WHERE id=?').run(JSON.stringify(value), value.id);
  }
  append(result: Result, rows: Row[]): void {
    if (!rows.length) return;
    const payload = JSON.stringify(rows);
    const bytes = Buffer.byteLength(payload);
    this.db
      .prepare('INSERT INTO chunks VALUES(?,?,?,?,?)')
      .run(result.id, result.rows, rows.length, bytes, payload);
    result.rows += rows.length;
    result.bytes += bytes;
    this.saveResult(result);
  }
  *rows(resultId: string): Generator<Row> {
    for (const chunk of this.db
      .prepare('SELECT payload FROM chunks WHERE result_id=? ORDER BY start_row')
      .iterate(resultId)) {
      yield* JSON.parse(chunk.payload as string) as Row[];
    }
  }
  totalBytes(): number {
    return Number(this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM chunks').get()!.n);
  }
  approve(resultId: string, profileId: string, owner: string, expiresAt: number): void {
    this.db
      .prepare(
        'INSERT INTO approvals VALUES(?,?,?,?) ON CONFLICT(result_id,profile_id) DO UPDATE SET expires_at=excluded.expires_at',
      )
      .run(resultId, profileId, owner, expiresAt);
  }
  approved(resultId: string, profileId: string, owner: string): boolean {
    return !!this.db
      .prepare(
        'SELECT 1 FROM approvals WHERE result_id=? AND profile_id=? AND owner=? AND expires_at>?',
      )
      .get(resultId, profileId, owner, Date.now());
  }
  approvals(owner: string): RecordRow[] {
    return this.db
      .prepare(
        'SELECT result_id AS resultId,profile_id AS profileId,expires_at AS expiresAt FROM approvals WHERE owner=? AND expires_at>?',
      )
      .all(owner, Date.now());
  }
  revoke(resultId: string, profileId: string): void {
    this.db
      .prepare('DELETE FROM approvals WHERE result_id=? AND profile_id=?')
      .run(resultId, profileId);
  }
  addExport(value: ExportRecord): void {
    this.db
      .prepare('INSERT INTO exports VALUES(?,?,?,?)')
      .run(value.id, value.owner, value.resultId, JSON.stringify(value));
  }
  export(id: string): ExportRecord | undefined {
    return this.payload<ExportRecord>('SELECT payload FROM exports WHERE id=?', id);
  }
  exports(owner?: string): ExportRecord[] {
    return owner
      ? this.payloads<ExportRecord>('SELECT payload FROM exports WHERE owner=?', owner)
      : this.payloads<ExportRecord>('SELECT payload FROM exports');
  }
  deleteExport(id: string): void {
    this.db.prepare('DELETE FROM exports WHERE id=?').run(id);
  }
  expiredResults(now: number): Result[] {
    return this.payloads<Result>('SELECT payload FROM results').filter(
      (r) => r.expiresAt <= now && r.completeness !== 'expired',
    );
  }
  expire(result: Result): void {
    this.db.prepare('DELETE FROM chunks WHERE result_id=?').run(result.id);
    this.db.prepare('DELETE FROM approvals WHERE result_id=?').run(result.id);
    result.completeness = 'expired';
    this.saveResult(result);
  }
  pruneMetadata(before: number): void {
    this.db.prepare('DELETE FROM audit WHERE at<?').run(before);
    this.db
      .prepare(
        "DELETE FROM executions WHERE created_at<? AND status NOT IN ('running','queued','cancel_requested') AND NOT EXISTS(SELECT 1 FROM results WHERE execution_id=executions.id AND json_extract(payload,'$.completeness')<>'expired')",
      )
      .run(before);
  }
  saveRecord(kind: string, id: string, owner: string, payload: unknown): void {
    this.db
      .prepare(
        'INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      )
      .run(kind, id, owner, JSON.stringify(payload));
  }
  records<T>(kind: string, owner: string): T[] {
    return this.payloads<T>('SELECT payload FROM records WHERE kind=? AND owner=?', kind, owner);
  }
  record<T>(kind: string, id: string): T | undefined {
    return this.payload<T>('SELECT payload FROM records WHERE kind=? AND id=?', kind, id);
  }
  audit(actor: Actor, action: string, target: string, detail: unknown = {}): void {
    this.db
      .prepare('INSERT INTO audit(at,owner,source,action,target,detail) VALUES(?,?,?,?,?,?)')
      .run(Date.now(), actor.subject, actor.channel, action, target, JSON.stringify(detail));
  }
  auditLog(owner: string): RecordRow[] {
    return this.db
      .prepare(
        'SELECT at,source,action,target,detail FROM audit WHERE owner=? ORDER BY id DESC LIMIT 100',
      )
      .all(owner);
  }
  private payload<T>(sql: string, ...args: (string | number)[]): T | undefined {
    const row = this.db.prepare(sql).get(...args);
    return row ? (JSON.parse(row.payload as string) as T) : undefined;
  }
  private payloads<T>(sql: string, ...args: (string | number)[]): T[] {
    return this.db
      .prepare(sql)
      .all(...args)
      .map((row) => JSON.parse(row.payload as string) as T);
  }
}
