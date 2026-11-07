import type { Engine } from '../domain/types.js';

export type DbErrorCategory =
  | 'connectivity'
  | 'tls'
  | 'authentication'
  | 'configuration'
  | 'timeout'
  | 'cancelled'
  | 'syntax'
  | 'permission'
  | 'read_only'
  | 'not_found'
  | 'constraint'
  | 'conflict'
  | 'resource'
  | 'other';

export interface DbErrorPosition {
  /** 0-based offset within the statement, when the engine reports one. */
  offset?: number;
  /** 1-based line within the statement. */
  line?: number;
}

/**
 * A database error as people and clients see it: category, the engine's own code, message and
 * detail. Never carries credentials.
 */
export class DbError extends Error {
  readonly category: DbErrorCategory;
  /** SQLSTATE (both engines) */
  readonly sqlState: string | null;
  /** Engine code: SQLSTATE for PostgreSQL, the numeric error for MySQL, or a driver code. */
  readonly code: string | null;
  readonly detail: string | null;
  readonly hint: string | null;
  readonly position: DbErrorPosition | null;

  constructor(
    category: DbErrorCategory,
    message: string,
    extra: Partial<Pick<DbError, 'sqlState' | 'code' | 'detail' | 'hint' | 'position'>> = {},
  ) {
    super(message);
    this.name = 'DbError';
    this.category = category;
    this.sqlState = extra.sqlState ?? null;
    this.code = extra.code ?? null;
    this.detail = extra.detail ?? null;
    this.hint = extra.hint ?? null;
    this.position = extra.position ?? null;
  }

  toJSON() {
    return {
      category: this.category,
      message: this.message,
      sqlState: this.sqlState,
      code: this.code,
      detail: this.detail,
      hint: this.hint,
      position: this.position,
    };
  }
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'PROTOCOL_CONNECTION_LOST',
]);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT']);
const TLS_CODES =
  /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ERR_TLS|ERR_SSL|HANDSHAKE_NO_SSL|DEPTH_ZERO|HOSTNAME|ALTNAME/;

/** Node and driver errors that are not database errors. */
function transportError(error: { code?: unknown; message?: string }): DbError | null {
  const code = typeof error.code === 'string' ? error.code : '';
  const message = error.message ?? String(error);
  if (TLS_CODES.test(code) || /\bssl\b|\btls\b|certificate/i.test(message)) {
    return new DbError('tls', `TLS failed: ${message}`, { code: code || null });
  }
  if (TIMEOUT_CODES.has(code) || /timeout/i.test(message)) {
    return new DbError('timeout', `Timed out: ${message}`, { code: code || null });
  }
  if (NETWORK_CODES.has(code) || /connection terminated|socket hang up|connect ECONN/i.test(message)) {
    return new DbError('connectivity', `Cannot reach the database server: ${message}`, {
      code: code || null,
    });
  }
  return null;
}

function postgresCategory(sqlState: string, message: string): DbErrorCategory {
  if (sqlState === '57014') return /statement timeout/.test(message) ? 'timeout' : 'cancelled';
  if (sqlState === '25006') return 'read_only';
  if (sqlState === '28P01' || sqlState === '28000') return 'authentication';
  if (sqlState === '3D000' || sqlState === '3F000') return 'configuration';
  if (sqlState === '42501') return 'permission';
  if (sqlState === '42P01' || sqlState === '42883' || sqlState === '42703' || sqlState === '42704')
    return 'not_found';
  if (sqlState.startsWith('42') || sqlState === '0A000' || sqlState.startsWith('22')) return 'syntax';
  if (sqlState.startsWith('23')) return 'constraint';
  if (sqlState.startsWith('40') || sqlState === '55P03') return 'conflict';
  if (sqlState.startsWith('08') || sqlState === '57P01' || sqlState === '57P03') return 'connectivity';
  if (sqlState.startsWith('53') || sqlState.startsWith('54')) return 'resource';
  return 'other';
}

export function mapPostgresError(error: unknown): DbError {
  if (error instanceof DbError) return error;
  const e = error as {
    code?: string;
    message?: string;
    detail?: string;
    hint?: string;
    position?: string;
    severity?: string;
  };
  const sqlState = typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : null;
  if (!sqlState || !e.severity) {
    return transportError(e) ?? new DbError('other', e.message ?? 'Database error', { code: e.code ?? null });
  }
  const message = e.message ?? 'Database error';
  const offset = e.position ? Number(e.position) - 1 : undefined;
  return new DbError(postgresCategory(sqlState, message), message, {
    sqlState,
    code: sqlState,
    detail: e.detail ?? null,
    hint: e.hint ?? null,
    position: offset !== undefined && Number.isFinite(offset) ? { offset } : null,
  });
}

const MYSQL_CATEGORIES: Record<number, DbErrorCategory> = {
  1045: 'authentication',
  1044: 'authentication',
  1251: 'authentication',
  1049: 'configuration',
  1064: 'syntax',
  1142: 'permission',
  1143: 'permission',
  1227: 'permission',
  1370: 'permission',
  1792: 'read_only',
  1290: 'read_only',
  1836: 'read_only',
  1146: 'not_found',
  1054: 'not_found',
  1305: 'not_found',
  1062: 'constraint',
  1451: 'constraint',
  1452: 'constraint',
  1048: 'constraint',
  3819: 'constraint',
  1213: 'conflict',
  1205: 'conflict',
  3024: 'timeout',
  1317: 'cancelled',
  2013: 'connectivity',
  2006: 'connectivity',
  1040: 'resource',
  1203: 'resource',
};

export function mapMysqlError(error: unknown): DbError {
  if (error instanceof DbError) return error;
  const e = error as {
    errno?: number;
    code?: string;
    sqlState?: string;
    sqlMessage?: string;
    message?: string;
    fatal?: boolean;
  };
  if (typeof e.errno !== 'number' || !e.sqlMessage) {
    return transportError(e) ?? new DbError('other', e.message ?? 'Database error', { code: e.code ?? null });
  }
  const line = /at line (\d+)$/.exec(e.sqlMessage)?.[1];
  return new DbError(MYSQL_CATEGORIES[e.errno] ?? 'other', e.sqlMessage, {
    sqlState: e.sqlState ?? null,
    code: String(e.errno),
    position: line ? { line: Number(line) } : null,
  });
}

export function mapDbError(engine: Engine, error: unknown): DbError {
  return engine === 'postgresql' ? mapPostgresError(error) : mapMysqlError(error);
}
