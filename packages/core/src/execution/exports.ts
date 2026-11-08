import { EventEmitter } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Cell, ColumnInfo } from '../db/types.js';
import { AppError, assert } from '../domain/errors.js';
import { newId } from '../domain/ids.js';
import type { Actor, Completeness, ExportStatus } from '../domain/types.js';
import { isoNow, type ServiceContext } from '../services/context.js';
import { parseInput } from '../services/validation.js';
import { bool, type Row } from '../store/database.js';
import { readRows, resultGone } from './capture.js';
import { canSeeExecution } from './visibility.js';

export type ExportFormat = 'csv' | 'json';

const createSchema = z
  .object({
    format: z.enum(['csv', 'json']),
    /** Export only the captured preview; labelled PREVIEW-ONLY in the file name and metadata. */
    previewOnly: z.boolean().default(false),
  })
  .strict();

export type CreateExportInput = z.input<typeof createSchema>;

export interface ExportView {
  id: string;
  executionId: string;
  resultIndex: number;
  format: ExportFormat;
  previewOnly: boolean;
  status: ExportStatus;
  /** Published only once the file is complete. */
  fileName: string | null;
  rowCount: number;
  byteCount: number;
  error: { code: string; message: string } | null;
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
}

/** RFC 4180 field: NULL is empty and unquoted; everything else that needs it is quoted. */
export function csvField(value: Cell): string {
  if (value === null) return '';
  if (value === '' || /[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** `\x` hex (how binary values are captured) as base64 for JSON. */
export function hexToBase64(value: string): string {
  return Buffer.from(value.startsWith('\\x') ? value.slice(2) : value, 'hex').toString('base64');
}

const slug = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40)
    .toLowerCase() || 'result';

/** Maps a file-system error to the export failure shown to people. */
export function exportFailure(error: unknown): { code: string; message: string } {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOSPC') return { code: 'disk_full', message: 'The export folder is full.' };
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return { code: 'write_permission', message: 'The server may not write to the export folder.' };
  }
  return {
    code: 'generation_failed',
    message: `The export could not be written: ${(error as Error).message}`,
  };
}

function write(stream: WriteStream, chunk: string): Promise<void> {
  return stream.write(chunk) ? Promise.resolve() : new Promise((resolve) => stream.once('drain', resolve));
}

/**
 * Exports of captured results as CSV or JSON. An export reads stored chunks only; it never runs
 * SQL, so regenerating it cannot change the database or create another execution.
 */
export class ExportService {
  /** `change` events ({ id, executionId, status }) for live status in the GUI. */
  readonly events = new EventEmitter();
  readonly #pending = new Set<Promise<void>>();
  /** Exports whose file this process is writing now. */
  readonly #writing = new Set<string>();

  constructor(
    private readonly ctx: ServiceContext,
    private readonly exportDir: string | null,
  ) {}

  async create(
    actor: Actor,
    executionId: string,
    resultIndex: number,
    input: CreateExportInput,
  ): Promise<ExportView> {
    const v = parseInput(createSchema, input);
    const execution = this.#execution(actor, executionId);
    const set = this.#resultSet(executionId, resultIndex);
    const completeness = String(set.completeness) as Completeness;
    if (resultGone(set, this.ctx.clock.now())) {
      throw new AppError('result_expired', 'The captured result is no longer stored. Run the query again.');
    }
    if (completeness === 'capturing')
      throw new AppError('export_not_ready', 'The result is still being captured.');
    if (!v.previewOnly && completeness !== 'complete') {
      throw new AppError(
        'not_complete',
        `Only a complete result can be exported in full; this one is ${completeness.replace('_', ' ')}. Export the preview only, or run the query again with full capture.`,
        { completeness },
      );
    }
    if (!this.exportDir) throw new AppError('exports_unavailable', 'No export folder is configured.');
    // The same result, format and scope already has an export being written or ready: use it. Files
    // per result are bounded this way, so repeated exports cannot fill the disk.
    const same = this.ctx.db.get(
      `SELECT * FROM exports WHERE execution_id = :execution AND result_index = :index AND format = :format
         AND preview_only = :preview AND status IN ('generating', 'ready') ORDER BY created_at DESC, id DESC LIMIT 1`,
      { execution: executionId, index: resultIndex, format: v.format, preview: v.previewOnly ? 1 : 0 },
    );
    if (same) {
      const sameId = String(same.id);
      if (same.status === 'generating' && this.#writing.has(sameId)) return this.view(sameId);
      if (same.status === 'ready' && same.file_name) {
        const present = await stat(join(this.#folder(executionId), String(same.file_name))).then(
          () => true,
          () => false,
        );
        if (present) return this.view(sameId);
      }
      // Abandoned or its file is gone: write it again rather than add another export.
      return this.regenerate(actor, sameId);
    }
    const id = newId('export', this.ctx.clock.now());
    this.ctx.db.transaction(() => {
      this.ctx.db.run(
        `INSERT INTO exports (id, execution_id, result_index, format, preview_only, status, created_by, created_at, expires_at)
         VALUES (:id, :execution, :index, :format, :preview, 'generating', :by, :now, :expires)`,
        {
          id,
          execution: executionId,
          index: resultIndex,
          format: v.format,
          preview: v.previewOnly ? 1 : 0,
          by: actor.subject,
          now: isoNow(this.ctx),
          expires: (set.expires_at as string | null) ?? null,
        },
      );
      this.ctx.audit.record({
        actor,
        action: 'export.create',
        target: { type: 'export', id, label: String(execution.title) },
        outcome: 'accepted',
        details: { executionId, resultIndex, format: v.format, previewOnly: v.previewOnly },
      });
    });
    this.#generate(id);
    return this.view(id);
  }

  /** Rebuilds a failed or missing file from the captured data. Never submits SQL. */
  async regenerate(actor: Actor, id: string): Promise<ExportView> {
    const row = this.#row(id);
    this.#execution(actor, String(row.execution_id));
    const set = this.#resultSet(String(row.execution_id), Number(row.result_index));
    if (resultGone(set, this.ctx.clock.now())) {
      throw new AppError('result_expired', 'The captured result is no longer stored. Run the query again.');
    }
    // Being written by this process: nothing to do. A `generating` record without a job here was
    // abandoned (a restart), and is written again.
    if (this.#writing.has(id)) return this.view(id);
    if (row.status === 'deleted' || row.status === 'expired') {
      throw new AppError('result_expired', 'This export was removed with its result.');
    }
    // Claimed before the first await, so a second call at the same time does not write it too.
    this.#writing.add(id);
    try {
      await this.#removeFile(row);
    } catch (error) {
      this.#writing.delete(id);
      throw error;
    }
    this.ctx.db.run(
      `UPDATE exports SET status = 'generating', file_name = NULL, error_code = NULL, error_message = NULL, completed_at = NULL,
         row_count = 0, byte_count = 0 WHERE id = :id`,
      { id },
    );
    this.ctx.audit.record({
      actor,
      action: 'export.regenerate',
      target: { type: 'export', id },
      outcome: 'accepted',
    });
    this.#generate(id);
    return this.view(id);
  }

  list(actor: Actor, executionId: string): ExportView[] {
    this.#execution(actor, executionId);
    return this.ctx.db
      .all('SELECT id FROM exports WHERE execution_id = :id ORDER BY created_at DESC, id DESC', {
        id: executionId,
      })
      .map((r) => this.view(String(r.id)));
  }

  get(actor: Actor, id: string): ExportView {
    this.#execution(actor, String(this.#row(id).execution_id));
    return this.view(id);
  }

  /** The file to send. Errors here never regenerate the file. */
  async download(
    actor: Actor,
    id: string,
  ): Promise<{ path: string; fileName: string; contentType: string; size: number }> {
    const row = this.#row(id);
    this.#execution(actor, String(row.execution_id));
    const now = this.ctx.clock.now().getTime();
    if (row.expires_at != null && Date.parse(String(row.expires_at)) <= now) {
      throw new AppError(
        'result_expired',
        'This export has passed its retention and is no longer available.',
      );
    }
    if (row.status !== 'ready' || !row.file_name) {
      throw new AppError('export_not_ready', `The export is ${String(row.status)}.`, {
        status: String(row.status),
      });
    }
    const path = join(this.#folder(String(row.execution_id)), String(row.file_name));
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      throw new AppError(
        'export_missing',
        'The export file is missing from the export folder. Regenerate it.',
      );
    }
    this.ctx.audit.record({
      actor,
      action: 'export.download',
      target: { type: 'export', id },
      outcome: 'succeeded',
    });
    return {
      path,
      fileName: String(row.file_name),
      contentType: row.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      size,
    };
  }

  /**
   * Deletes the stored results of an execution (all, or one result set): rows, export files and any
   * pending or active disclosure. The execution and its statements stay in history.
   */
  async deleteResults(actor: Actor, executionId: string, resultIndex?: number): Promise<number> {
    this.#execution(actor, executionId);
    const sets = this.ctx.db.all(
      `SELECT result_index, byte_count FROM result_sets WHERE execution_id = :id AND completeness NOT IN ('expired', 'deleted', 'capturing')
         ${resultIndex === undefined ? '' : 'AND result_index = :index'}`,
      { id: executionId, ...(resultIndex === undefined ? {} : { index: resultIndex }) },
    );
    let freed = 0;
    const removed: number[] = [];
    for (const set of sets) {
      const bytes = await this.#removeResult(executionId, Number(set.result_index), 'deleted');
      freed += bytes;
      // An overlapping request may have removed it in the meantime; that one records it.
      if (bytes || Number(set.byte_count) === 0) removed.push(Number(set.result_index));
    }
    if (removed.length) {
      this.ctx.audit.record({
        actor,
        action: 'result.delete',
        target: { type: 'execution', id: executionId },
        outcome: 'succeeded',
        details: { resultSets: removed },
      });
    }
    return freed;
  }

  /**
   * Retention: removes export files of results that expired (or whose execution metadata is about
   * to be deleted). Run before ExecutionService.cleanup().
   */
  async cleanup(now = this.ctx.clock.now()): Promise<number> {
    const at = now.toISOString();
    const rows = this.ctx.db.all(
      `SELECT x.* FROM exports x
         JOIN result_sets r ON r.execution_id = x.execution_id AND r.result_index = x.result_index
         JOIN executions e ON e.id = x.execution_id
        WHERE x.status NOT IN ('expired', 'deleted')
          AND ((r.expires_at IS NOT NULL AND r.expires_at <= :at) OR e.metadata_expires_at <= :at
               OR r.completeness IN ('expired', 'deleted'))`,
      { at },
    );
    for (const row of rows) {
      await this.#removeFile(row);
      // A deletion that finished while the file was removed keeps its `deleted`.
      this.ctx.db.run(
        "UPDATE exports SET status = 'expired' WHERE id = :id AND status NOT IN ('expired', 'deleted')",
        {
          id: String(row.id),
        },
      );
    }
    // Folders of executions whose metadata is about to be deleted.
    for (const e of this.ctx.db.all('SELECT id FROM executions WHERE metadata_expires_at <= :at', { at })) {
      if (this.exportDir) await rm(this.#folder(String(e.id)), { recursive: true, force: true });
    }
    // Disclosure ends with the result it refers to.
    this.ctx.db.run(
      `UPDATE disclosure_approvals SET status = 'expired'
        WHERE status IN ('pending', 'active') AND EXISTS (
          SELECT 1 FROM result_sets r WHERE r.execution_id = disclosure_approvals.execution_id
            AND r.result_index = disclosure_approvals.result_index AND r.completeness IN ('expired', 'deleted'))`,
    );
    return rows.length;
  }

  /**
   * At startup: exports still `generating` lost their job with the previous process. They become
   * `failed` (with `interrupted`), so clients stop waiting and can regenerate them from the captured
   * data. Leftover partial files are removed.
   */
  async reconcile(): Promise<number> {
    const rows = this.ctx.db.all("SELECT * FROM exports WHERE status = 'generating'");
    let count = 0;
    for (const row of rows) {
      const id = String(row.id);
      if (this.#writing.has(id)) continue;
      if (this.exportDir) await this.#removeFile(row);
      const done = this.ctx.db.run(
        `UPDATE exports SET status = 'failed', error_code = 'interrupted', completed_at = :now,
           error_message = 'The server restarted while this file was being written. Regenerate it.'
         WHERE id = :id AND status = 'generating'`,
        { id, now: isoNow(this.ctx) },
      );
      if (Number(done.changes) === 0) continue;
      count++;
      this.ctx.audit.record({
        actor: 'system',
        action: 'export.fail',
        target: { type: 'export', id },
        outcome: 'failed',
        details: { code: 'interrupted' },
      });
    }
    return count;
  }

  /** Waits for background generation (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
  }

  view(id: string): ExportView {
    const r = this.#row(id);
    return {
      id,
      executionId: String(r.execution_id),
      resultIndex: Number(r.result_index),
      format: r.format as ExportFormat,
      previewOnly: bool(r.preview_only),
      status: r.status as ExportStatus,
      fileName: (r.file_name as string | null) ?? null,
      rowCount: Number(r.row_count),
      byteCount: Number(r.byte_count),
      error: r.error_code ? { code: String(r.error_code), message: String(r.error_message ?? '') } : null,
      createdBy: String(r.created_by),
      createdAt: String(r.created_at),
      completedAt: (r.completed_at as string | null) ?? null,
      expiresAt: (r.expires_at as string | null) ?? null,
    };
  }

  // ---------------------------------------------------------------- internals

  #row(id: string): Row {
    const row = this.ctx.db.get('SELECT * FROM exports WHERE id = :id', { id });
    assert(row, 'not_found', 'Export not found.', { id });
    return row;
  }

  #execution(actor: Actor, id: string): Row {
    const row = this.ctx.db.get('SELECT * FROM executions WHERE id = :id', { id });
    if (!row || !canSeeExecution(this.ctx.db, actor, row))
      throw new AppError('not_found', 'Execution not found.', { id });
    return row;
  }

  #resultSet(executionId: string, index: number): Row {
    const set = this.ctx.db.get(
      'SELECT * FROM result_sets WHERE execution_id = :id AND result_index = :index',
      {
        id: executionId,
        index,
      },
    );
    assert(set, 'not_found', 'Result set not found.', { resultIndex: index });
    return set;
  }

  /** Server-controlled location: <EXPORT_DIR>/<execution id>/. IDs contain no path characters. */
  #folder(executionId: string): string {
    return join(String(this.exportDir), executionId);
  }

  async #removeFile(row: Row): Promise<void> {
    const folder = this.#folder(String(row.execution_id));
    await rm(join(folder, `${String(row.id)}.part`), { force: true });
    if (row.file_name) await rm(join(folder, String(row.file_name)), { force: true });
  }

  /**
   * Removes one result set's rows and export files. Returns the bytes this call released: 0 when
   * retention or an overlapping call removed it first.
   */
  async #removeResult(
    executionId: string,
    index: number,
    completeness: 'deleted' | 'expired',
  ): Promise<number> {
    for (const x of this.ctx.db.all(
      'SELECT * FROM exports WHERE execution_id = :id AND result_index = :index',
      {
        id: executionId,
        index,
      },
    )) {
      await this.#removeFile(x);
    }
    // Decided in one synchronous transaction after the awaits, so of two overlapping calls only the
    // one that changes a still-counted result releases its bytes.
    const bytes = this.ctx.db.transaction(() => {
      const set = this.ctx.db.get(
        'SELECT byte_count, completeness FROM result_sets WHERE execution_id = :id AND result_index = :index',
        { id: executionId, index },
      );
      const counted = set && set.completeness !== 'expired' && set.completeness !== 'deleted';
      this.ctx.db.run(
        "UPDATE exports SET status = :status WHERE execution_id = :id AND result_index = :index AND status NOT IN ('deleted', 'expired')",
        { id: executionId, index, status: completeness },
      );
      this.ctx.db.run('DELETE FROM result_chunks WHERE execution_id = :id AND result_index = :index', {
        id: executionId,
        index,
      });
      this.ctx.db.run(
        'UPDATE result_sets SET completeness = :c WHERE execution_id = :id AND result_index = :index',
        {
          id: executionId,
          index,
          c: completeness,
        },
      );
      this.ctx.db.run(
        `UPDATE disclosure_approvals SET status = 'revoked', note = 'The result was deleted.'
          WHERE execution_id = :id AND result_index = :index AND status IN ('pending', 'active')`,
        { id: executionId, index },
      );
      return counted ? Number(set.byte_count ?? 0) : 0;
    });
    if (bytes) this.ctx.onResultBytesFreed?.(bytes);
    return bytes;
  }

  #changed(id: string): void {
    const row = this.ctx.db.get('SELECT execution_id, status FROM exports WHERE id = :id', { id });
    if (row)
      this.events.emit('change', { id, executionId: String(row.execution_id), status: String(row.status) });
  }

  #generate(id: string): void {
    this.#writing.add(id);
    this.#changed(id);
    const job = this.#write(id).finally(() => {
      this.#writing.delete(id);
      this.#pending.delete(job);
      try {
        this.#changed(id);
      } catch {
        // Database closed during shutdown.
      }
    });
    this.#pending.add(job);
  }

  async #write(id: string): Promise<void> {
    const x = this.#row(id);
    const executionId = String(x.execution_id);
    const index = Number(x.result_index);
    const execution = this.ctx.db.get('SELECT * FROM executions WHERE id = :id', { id: executionId }) as Row;
    const set = this.#resultSet(executionId, index);
    const columns = JSON.parse(String(set.columns)) as ColumnInfo[];
    const previewOnly = bool(x.preview_only);
    const total = Number(set.row_count);
    const format = x.format as ExportFormat;
    const folder = this.#folder(executionId);
    const part = join(folder, `${id}.part`);
    const fileName = `${slug(String(execution.title))}-${id}${previewOnly ? '-PREVIEW-ONLY' : ''}.${format}`;
    let rows = 0;
    try {
      await mkdir(folder, { recursive: true });
      const stream = createWriteStream(part, { flags: 'wx' });
      const opened = new Promise<void>((resolve, reject) => {
        stream.once('open', () => resolve());
        stream.once('error', reject);
      });
      await opened;
      const failed = new Promise<never>((_, reject) => stream.on('error', reject));
      const body = async () => {
        if (format === 'csv') {
          await write(stream, `${columns.map((c) => csvField(c.name)).join(',')}\r\n`);
        } else {
          const header = {
            format: 'database-workbench.result.v1',
            completeness: previewOnly ? 'preview_only' : 'complete',
            capturedRows: total,
            exportedRows: total,
            moreAvailable: bool(set.more_available),
            execution: {
              id: executionId,
              title: String(execution.title),
              connection: String(execution.connection_name),
              engine: String(execution.engine),
              submittedAt: String(execution.submitted_at),
            },
            resultIndex: index,
            columns: columns.map((c) => ({ name: c.name, type: c.type, binary: c.binary })),
          };
          await write(stream, `${JSON.stringify(header).slice(0, -1)},"rows":[`);
        }
        for (let offset = 0; offset < total; offset += 1000) {
          const page = readRows(this.ctx.db, executionId, index, offset, 1000);
          let text = '';
          for (const row of page) {
            if (format === 'csv') text += `${row.map(csvField).join(',')}\r\n`;
            else {
              const values = row.map((v, i) =>
                v !== null && columns[i]?.binary ? { base64: hexToBase64(v) } : v,
              );
              text += `${rows === 0 ? '' : ','}\n${JSON.stringify(values)}`;
            }
            rows++;
          }
          await write(stream, text);
        }
        if (format === 'json') await write(stream, '\n]}\n');
        await new Promise<void>((resolve, reject) =>
          stream.end((error?: Error | null) => (error ? reject(error) : resolve())),
        );
      };
      await Promise.race([body(), failed]);
      if (rows !== total) throw new Error(`expected ${total} rows, wrote ${rows}`);
      const { size } = await stat(part);
      await rename(part, join(folder, fileName));
      const done = this.ctx.db.run(
        `UPDATE exports SET status = 'ready', file_name = :name, row_count = :rows, byte_count = :size, completed_at = :now
          WHERE id = :id AND status = 'generating'`,
        { id, name: fileName, rows, size, now: isoNow(this.ctx) },
      );
      // The result was deleted or expired while this file was written: do not leave it behind.
      if (Number(done.changes) === 0) await rm(join(folder, fileName), { force: true });
    } catch (error) {
      await rm(part, { force: true }).catch(() => undefined);
      const f = exportFailure(error);
      this.ctx.db.run(
        `UPDATE exports SET status = 'failed', error_code = :code, error_message = :message, completed_at = :now
          WHERE id = :id AND status = 'generating'`,
        { id, code: f.code, message: f.message, now: isoNow(this.ctx) },
      );
      this.ctx.audit.record({
        actor: 'system',
        action: 'export.fail',
        target: { type: 'export', id },
        outcome: 'failed',
        details: { code: f.code },
      });
    }
  }
}

export { createSchema as exportCreateSchema };
