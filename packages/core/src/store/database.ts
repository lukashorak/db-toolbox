import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { MIGRATIONS } from './migrations.js';

export type Params = Record<string, SQLInputValue>;
export type Row = Record<string, unknown>;

export const DATABASE_FILE = 'workbench.sqlite';

/**
 * Thin wrapper around `node:sqlite`. Every write runs in a short IMMEDIATE transaction so that
 * concurrent writers queue on the busy timeout instead of failing halfway.
 */
export class Database {
  readonly raw: DatabaseSync;
  #depth = 0;

  private constructor(raw: DatabaseSync) {
    this.raw = raw;
  }

  /** Opens (and creates) the database file. Use `:memory:` in tests. */
  static open(file: string): Database {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (file !== ':memory:') raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    const db = new Database(raw);
    db.migrate();
    return db;
  }

  static openInDir(dataDir: string): Database {
    return Database.open(join(dataDir, DATABASE_FILE));
  }

  get schemaVersion(): number {
    return Number((this.raw.prepare('PRAGMA user_version').get() as Row).user_version);
  }

  /** Applies pending migrations in order, each in its own transaction. Returns the new version. */
  migrate(): number {
    for (const migration of MIGRATIONS) {
      if (migration.version <= this.schemaVersion) continue;
      this.transaction(() => {
        this.raw.exec(migration.sql);
        this.raw.exec(`PRAGMA user_version = ${migration.version}`);
      });
    }
    return this.schemaVersion;
  }

  get<T = Row>(sql: string, params: Params = {}): T | undefined {
    return this.raw.prepare(sql).get(params) as T | undefined;
  }

  all<T = Row>(sql: string, params: Params = {}): T[] {
    return this.raw.prepare(sql).all(params) as T[];
  }

  run(sql: string, params: Params = {}): { changes: number; lastInsertRowid: number } {
    const result = this.raw.prepare(sql).run(params);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  /** Runs `fn` in a transaction; nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.#depth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.#depth++;
    try {
      const value = fn();
      this.raw.exec('COMMIT');
      return value;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    } finally {
      this.#depth--;
    }
  }

  close(): void {
    this.raw.close();
  }
}

export const bool = (value: unknown): boolean => Number(value) === 1;
export const int = (value: boolean): number => (value ? 1 : 0);
