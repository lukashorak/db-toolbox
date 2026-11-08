import type { Cell, ColumnInfo, ResultSink } from '../db/types.js';
import type { Completeness } from '../domain/types.js';
import type { Database, Row } from '../store/database.js';

/**
 * Bytes of captured result data across all executions. Shared by concurrent captures so the
 * deployment total is never exceeded; part of the total is kept free for metadata.
 */
export class StorageBudget {
  #used: number;
  constructor(
    private readonly limit: number,
    used: number,
  ) {
    this.#used = used;
  }

  static #stored(db: Database): number {
    const row = db.get(
      `SELECT coalesce(sum(byte_count), 0) AS used FROM result_sets WHERE completeness NOT IN ('expired', 'deleted')`,
    );
    return Number(row?.used ?? 0);
  }

  static fromDatabase(db: Database, totalBytes: number): StorageBudget {
    // Keep 5% (at most 64 MiB) for execution metadata, statements and audit.
    const reserve = Math.min(Math.floor(totalBytes * 0.05), 64 * 1024 * 1024);
    return new StorageBudget(totalBytes - reserve, StorageBudget.#stored(db));
  }

  /** Counts stored results again, for example after restart recovery added interrupted ones. */
  recount(db: Database): void {
    this.#used = StorageBudget.#stored(db);
  }

  get used(): number {
    return this.#used;
  }

  /** Takes `bytes` if they fit. */
  take(bytes: number): boolean {
    if (this.#used + bytes > this.limit) return false;
    this.#used += bytes;
    return true;
  }

  release(bytes: number): void {
    this.#used = Math.max(0, this.#used - bytes);
  }
}

export interface CaptureOptions {
  mode: 'preview' | 'full';
  /** Rows kept in preview mode (one more is read to know whether more exist). */
  previewRows: number;
  /** Captured bytes allowed for this execution, across its result sets. */
  executionBytes: { limit: number; used: number };
  budget: StorageBudget;
  now: () => string;
}

const CHUNK_ROWS = 1000;
const CHUNK_BYTES = 1024 * 1024;

interface OpenSet {
  index: number;
  rows: number;
  bytes: number;
  more: boolean;
  quota: boolean;
  chunk: number;
  buffer: Cell[][];
  bufferBytes: number;
}

/**
 * Receives a statement's result sets from an adapter and stores them as chunks. Preview capture
 * keeps the first rows and records whether more exist; full capture keeps everything that fits
 * the quotas and says `quota_limited` otherwise, never `complete`.
 */
export class ResultCapture implements ResultSink {
  readonly #sets = new Map<number, OpenSet>();
  #first: number;

  constructor(
    private readonly db: Database,
    private readonly executionId: string,
    private readonly statement: number,
    /** Execution-wide index of this statement's first result set. */
    firstIndex: number,
    private readonly options: CaptureOptions,
  ) {
    this.#first = firstIndex;
  }

  /** Rows per adapter batch: in preview, one batch decides whether more rows exist. */
  get batchSize(): number {
    return this.options.mode === 'preview' ? this.options.previewRows + 1 : 500;
  }

  /** Result sets this statement produced. */
  get count(): number {
    return this.#sets.size;
  }

  start(columns: ColumnInfo[], local: number): void {
    const index = this.#first + local;
    this.db.run(
      `INSERT INTO result_sets (execution_id, result_index, statement, columns, completeness, captured_at)
       VALUES (:id, :index, :statement, :columns, 'capturing', :now)`,
      {
        id: this.executionId,
        index,
        statement: this.statement,
        columns: JSON.stringify(columns),
        now: this.options.now(),
      },
    );
    this.#sets.set(local, {
      index,
      rows: 0,
      bytes: 0,
      more: false,
      quota: false,
      chunk: 0,
      buffer: [],
      bufferBytes: 0,
    });
  }

  rows(rows: Cell[][], local: number): 'stop' | undefined {
    const set = this.#sets.get(local);
    if (!set) return 'stop';
    for (const row of rows) {
      if (this.options.mode === 'preview' && set.rows >= this.options.previewRows) {
        set.more = true;
        return 'stop';
      }
      const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
      const execution = this.options.executionBytes;
      if (execution.used + bytes > execution.limit || !this.options.budget.take(bytes)) {
        set.quota = true;
        set.more = true;
        return 'stop';
      }
      execution.used += bytes;
      set.buffer.push(row);
      set.bufferBytes += bytes;
      set.rows++;
      set.bytes += bytes;
      if (set.buffer.length >= CHUNK_ROWS || set.bufferBytes >= CHUNK_BYTES) this.#flush(set);
    }
    return undefined;
  }

  #flush(set: OpenSet): void {
    if (!set.buffer.length) return;
    const data = Buffer.from(JSON.stringify(set.buffer));
    this.db.run(
      `INSERT INTO result_chunks (execution_id, result_index, chunk_index, row_start, row_count, byte_count, data)
       VALUES (:id, :index, :chunk, :start, :count, :bytes, :data)`,
      {
        id: this.executionId,
        index: set.index,
        chunk: set.chunk,
        start: set.rows - set.buffer.length,
        count: set.buffer.length,
        bytes: set.bufferBytes,
        data,
      },
    );
    set.chunk++;
    set.buffer = [];
    set.bufferBytes = 0;
  }

  /**
   * After storing the result failed: keeps what was stored, marked interrupted, and drops the rows
   * not stored yet (giving their bytes back). Best effort: the database may refuse this too; a set
   * left `capturing` is then closed by restart recovery.
   */
  abandon(expiresAt: string | null): void {
    for (const set of this.#sets.values()) {
      const dropped = set.bufferBytes;
      set.rows -= set.buffer.length;
      set.bytes -= dropped;
      set.buffer = [];
      set.bufferBytes = 0;
      this.options.budget.release(dropped);
      this.options.executionBytes.used = Math.max(0, this.options.executionBytes.used - dropped);
      try {
        this.db.run(
          `UPDATE result_sets SET row_count = :rows, byte_count = :bytes, more_available = 1, completeness = 'interrupted',
             expires_at = :expires WHERE execution_id = :id AND result_index = :index`,
          { id: this.executionId, index: set.index, rows: set.rows, bytes: set.bytes, expires: expiresAt },
        );
      } catch {
        // See above.
      }
    }
  }

  /** Closes all result sets: `complete` when the statement finished, `interrupted` otherwise. */
  finish(ended: 'complete' | 'interrupted', expiresAt: string | null): void {
    for (const set of this.#sets.values()) {
      this.#flush(set);
      const completeness: Completeness = set.quota
        ? 'quota_limited'
        : this.options.mode === 'preview' && set.more
          ? 'preview_limited'
          : ended;
      this.db.run(
        `UPDATE result_sets SET row_count = :rows, byte_count = :bytes, more_available = :more, completeness = :completeness,
           expires_at = :expires WHERE execution_id = :id AND result_index = :index`,
        {
          id: this.executionId,
          index: set.index,
          rows: set.rows,
          bytes: set.bytes,
          more: set.more ? 1 : 0,
          completeness,
          expires: expiresAt,
        },
      );
    }
  }
}

/**
 * SQL condition (execution aliased `e`, parameter `:at`): its metadata may be deleted. Metadata
 * waits for the results: an execution is kept while any of its results is still within retention
 * (a result retained for longer than metadata is kept for that long, with its execution).
 */
export const METADATA_DUE = `(e.metadata_expires_at <= :at AND NOT EXISTS (
  SELECT 1 FROM result_sets live WHERE live.execution_id = e.id
    AND live.completeness NOT IN ('expired', 'deleted')
    AND (live.expires_at IS NULL OR live.expires_at > :at)))`;

/**
 * A captured result that may no longer be read: expired or deleted, or past its retention deadline
 * although the periodic cleanup has not removed it yet.
 */
export function resultGone(set: Row, now: Date): boolean {
  const completeness = String(set.completeness);
  if (completeness === 'expired' || completeness === 'deleted') return true;
  return set.expires_at != null && Date.parse(String(set.expires_at)) <= now.getTime();
}

/** Reads a page of captured rows. */
export function readRows(
  db: Database,
  executionId: string,
  resultIndex: number,
  offset: number,
  limit: number,
): Cell[][] {
  const chunks = db.all(
    `SELECT row_start, row_count, data FROM result_chunks
      WHERE execution_id = :id AND result_index = :index AND row_start < :end AND row_start + row_count > :offset
      ORDER BY chunk_index`,
    { id: executionId, index: resultIndex, offset, end: offset + limit },
  );
  const rows: Cell[][] = [];
  for (const chunk of chunks) {
    const data = JSON.parse(Buffer.from(chunk.data as Uint8Array).toString('utf8')) as Cell[][];
    const start = Number(chunk.row_start);
    for (let i = Math.max(0, offset - start); i < data.length && rows.length < limit; i++)
      rows.push(data[i] as Cell[]);
  }
  return rows;
}
