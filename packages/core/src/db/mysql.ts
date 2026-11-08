import iconv from 'iconv-lite';
import mysql, { type FieldPacket, type Pool, type PoolConnection, type PoolOptions } from 'mysql2';
import { analyzeMysql } from '../sql/analyze-mysql.js';
import { splitStatements } from '../sql/split.js';
import { TRANSACTIONAL_ENGINES, UNRESOLVED_VIEW, type TableRef, type TriggerEvent } from '../sql/types.js';
import { afterInterruption, DbError, mapMysqlError } from './errors.js';
import { MysqlMetadata } from './metadata-mysql.js';
import { bounded, CONTROL_TIMEOUT_MS, settlesWithin, STALL_GRACE_MS, StallGuard } from './stall.js';
import { mysqlTls, mysqlVerifyFullProblem } from './tls.js';
import type {
  Cell,
  ColumnInfo,
  ConnectionTarget,
  DbAdapter,
  DbSession,
  Endpoint,
  ExecuteOptions,
  PoolSizes,
  ResultSink,
  StatementOutcome,
  WaitBounds,
  ViewEffects,
} from './types.js';

const METADATA_TIMEOUT_MS = 30_000;
/** The character set and collation sessions use: negotiated at connect, set again after a reset. */
const CONNECTION_COLLATION = 'UTF8MB4_GENERAL_CI';

/** Where a lookup keeps the session's SHOW GRANTS lines (no table name contains a NUL). */
const GRANTS_KEY = '\u0000grants';
/** Where a lookup keeps whether the server has partial revokes on ('1') or off ('0'). */
const PARTIAL_REVOKES_KEY = '\u0000partial_revokes';

/** A backticked or bare identifier, unquoted. */
const unquote = (name: string) =>
  name.startsWith('`') && name.endsWith('`') ? name.slice(1, -1).replace(/``/g, '`') : name;

/**
 * A grant's schema pattern against a name. `\\` escapes; unescaped % and _ are wildcards, except with
 * partial revokes on, where the server reads them literally.
 */
function schemaMatches(pattern: string, name: string, wildcards: boolean): boolean {
  let regex = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === '\\' && i + 1 < pattern.length)
      regex += (pattern[++i] as string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (c === '%' && wildcards) regex += '.*';
    else if (c === '_' && wildcards) regex += '.';
    else regex += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${regex}$`).test(name);
}

/**
 * The scope at which a SHOW GRANTS line (`GRANT …`, or with partial revokes `REVOKE …`) covers
 * TRIGGER on the table: `*.*`, its schema (or a matching pattern), or the table itself.
 */
function triggerScope(
  line: string,
  verb: 'GRANT' | 'REVOKE',
  db: string,
  table: string,
  partialRevokes: boolean,
): 'global' | 'schema' | 'table' | null {
  const m = new RegExp(`^${verb} (.+?) ON (.+?) (?:TO|FROM) `).exec(line);
  if (!m) return null;
  const privileges = (m[1] ?? '')
    .replace(/\([^)]*\)/g, '')
    .split(',')
    .map((p) => p.trim().toUpperCase());
  if (!privileges.some((p) => p === 'TRIGGER' || p === 'ALL PRIVILEGES' || p === 'ALL')) return null;
  const target = (m[2] ?? '').trim();
  if (target === '*.*') return 'global';
  const parts = /^(`(?:[^`]|``)*`|[^.`]+)\.(`(?:[^`]|``)*`|\*)$/.exec(target);
  if (!parts) return null;
  const schema = unquote(parts[1] ?? '');
  if (parts[2] === '*') return schemaMatches(schema, db, !partialRevokes) ? 'schema' : null;
  return schema === db && unquote(parts[2] ?? '') === table ? 'table' : null;
}

/**
 * Whether SHOW GRANTS lines give TRIGGER on the table. A partial revoke (`REVOKE … ON db.*`, only with
 * the server's partial_revokes on) narrows only the global grant; a table-level grant still gives
 * the privilege.
 */
export function triggerVisible(lines: string[], db: string, table: string, partialRevokes = false): boolean {
  const scope = (line: string, verb: 'GRANT' | 'REVOKE') =>
    triggerScope(line, verb, db, table, partialRevokes);
  const granted = new Set(lines.map((line) => scope(line, 'GRANT')));
  if (granted.has('table') || granted.has('schema')) return true;
  if (!granted.has('global')) return false;
  return !lines.some((line) => scope(line, 'REVOKE') === 'schema');
}

/** What a trigger or stored-function body writes and which (possibly stored) functions it calls. */
interface RoutineEffects {
  tables: TableRef[];
  functions: TableRef[];
  /** Tables and views the body names: a view among them can call functions that write. */
  relations: TableRef[];
}

/**
 * The effects of a trigger or stored-function body, or null when they cannot be determined
 * (control flow, cursors, handlers, calls, anything but plain writes, reads, SET, DECLARE and RETURN).
 */
function routineEffects(body: string): RoutineEffects | null {
  const block = /^\s*BEGIN\b([\s\S]*)\bEND\s*$/i.exec(body);
  const effects: RoutineEffects = { tables: [], functions: [], relations: [] };
  for (const statement of splitStatements(block ? (block[1] ?? '') : body, 'mysql')) {
    // RETURN expr evaluates expr, like SELECT expr.
    const text = statement.text.replace(/^\s*RETURN\b/i, 'SELECT');
    const a = analyzeMysql(text);
    // Expressions anywhere (SET NEW.v = f(), DEFAULT f(), RETURN f()) may call stored functions.
    effects.functions.push(...(a.callsFunctions ?? []));
    effects.relations.push(...(a.referencesTables ?? []));
    if (a.kind === 'read' && !a.irreversible) continue;
    if (a.kind === 'session' && a.command === 'SET') continue;
    if (/^\s*DECLARE\b/i.test(text) && !/\b(HANDLER|CURSOR)\b/i.test(text)) continue;
    if (a.kind !== 'write' || a.writeTargetsUnknown || a.mayCommit || a.irreversible) return null;
    if (!a.writesTables.length) return null;
    effects.tables.push(...a.writesTables);
  }
  return effects;
}

const BINARY_CHARSET = 63;
const TYPE_NAMES = new Map<number, string>(
  Object.entries(mysql.Types).map(([name, id]) => [Number(id), name]),
);
const STRING_TYPES = new Set([
  'STRING',
  'VAR_STRING',
  'VARCHAR',
  'BLOB',
  'TINY_BLOB',
  'MEDIUM_BLOB',
  'LONG_BLOB',
]);

type RawField = FieldPacket & { columnType?: number; characterSet?: number; encoding?: string };

function columnInfo(field: RawField): ColumnInfo {
  const type = TYPE_NAMES.get(Number(field.columnType ?? field.type)) ?? 'UNKNOWN';
  const binary =
    type === 'GEOMETRY' ||
    type === 'BIT' ||
    (STRING_TYPES.has(type) && field.characterSet === BINARY_CHARSET);
  return { name: field.name, type, binary };
}

/** Raw bytes for every value; turned into text (or `\x` hex for binary columns) per column. */
const RAW = (field: { buffer(): Buffer | null }) => field.buffer();
/**
 * Text is decoded in the character set the server sent it in, which the column definition names:
 * `character_set_results` (a script can change it, with SET NAMES for example), or the column's own
 * when that is NULL. Decoding everything as UTF-8 would turn latin1 `é` into U+FFFD.
 */
const toCell = (value: unknown, binary: boolean, encoding = 'utf8'): Cell => {
  if (value === null || value === undefined) return null;
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  if (binary) return `\\x${bytes.toString('hex')}`;
  if (encoding === 'utf8' || encoding === 'binary' || !iconv.encodingExists(encoding))
    return bytes.toString('utf8');
  // MySQL's latin1 is cp1252 (with the euro sign at 0x80), not ISO-8859-1.
  return iconv.decode(bytes, encoding === 'latin1' ? 'cp1252' : encoding);
};

export interface MysqlOptions {
  sizes: PoolSizes;
  connectTimeoutMs: number;
}

export function mysqlConnectionOptions(
  target: ConnectionTarget,
  endpoint: Endpoint,
  connectTimeoutMs: number,
): PoolOptions {
  const ssl = mysqlTls({ mode: target.tlsMode, caPem: target.caPem });
  return {
    host: endpoint.host,
    port: endpoint.port,
    user: target.username,
    password: target.password,
    database: target.database,
    ...(ssl ? { ssl } : {}),
    connectTimeout: connectTimeoutMs,
    charset: CONNECTION_COLLATION,
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
  };
}

export class MysqlAdapter implements DbAdapter {
  readonly engine = 'mysql' as const;
  readonly metadata: MysqlMetadata;
  readonly #work: Pool;
  readonly #meta: Pool;
  readonly #control: Pool;
  readonly #monitor: Pool;
  readonly monitorAccount: string;
  readonly #refusal: DbError | null;
  #active = 0;

  constructor(target: ConnectionTarget, endpoint: Endpoint, options: MysqlOptions) {
    this.#refusal = mysqlVerifyFullProblem(target.tlsMode, endpoint.host);
    const base = mysqlConnectionOptions(target, endpoint, options.connectTimeoutMs);
    const pool = (connectionLimit: number, account?: { username: string; password: string } | null) => {
      const p = mysql.createPool({
        ...base,
        ...(account ? { user: account.username, password: account.password } : {}),
        connectionLimit,
        maxIdle: connectionLimit,
        idleTimeout: 30_000,
        waitForConnections: true,
        queueLimit: 0,
      });
      p.on('connection', (c) => c.on('error', () => undefined));
      return p;
    };
    this.#work = pool(options.sizes.work);
    this.#meta = pool(options.sizes.metadata);
    this.#control = pool(options.sizes.control);
    this.#monitor = pool(options.sizes.monitor ?? 1, target.monitor);
    this.monitorAccount = target.monitor?.username ?? target.username;
    this.metadata = new MysqlMetadata((sql, params) => this.#metaQuery(sql, params), target.database);
  }

  /** A connection from the pool; with `waitMs`, a request still waiting then is withdrawn. */
  async #acquire(pool: Pool, waitMs?: number): Promise<PoolConnection> {
    if (this.#refusal) throw this.#refusal;
    return new Promise<PoolConnection>((resolve, reject) => {
      let withdrawn = false;
      const timer =
        waitMs === undefined
          ? undefined
          : setTimeout(() => {
              withdrawn = true;
              reject(new DbError('resource', `No database connection became free within ${waitMs} ms.`));
            }, waitMs);
      pool.getConnection((error, c) => {
        clearTimeout(timer);
        // Withdrawn meanwhile: nothing runs on this connection.
        if (withdrawn) {
          if (!error) c.release();
        } else if (error) reject(mapMysqlError(error));
        else resolve(c);
      });
    });
  }

  async #pooledQuery(
    pool: Pool,
    sql: string,
    params: unknown[] = [],
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>[]> {
    signal?.throwIfAborted();
    // A query with a time limit waits at most as long for a connection.
    const connection = await this.#acquire(pool, timeout);
    // Aborted while waiting for a connection: give it back without running anything.
    if (signal?.aborted) {
      connection.release();
      signal.throwIfAborted();
    }
    let timedOut = false;
    try {
      return await new Promise((resolve, reject) =>
        connection.query({ sql, values: params, ...(timeout ? { timeout } : {}) }, (error, rows) => {
          if (error) {
            timedOut = (error as { code?: string }).code === 'PROTOCOL_SEQUENCE_TIMEOUT';
            reject(mapMysqlError(error));
          } else resolve((Array.isArray(rows) ? rows : []) as Record<string, unknown>[]);
        }),
      );
    } finally {
      // A query that timed out may still be running there: that connection is not reused.
      if (timedOut) connection.destroy();
      else connection.release();
    }
  }

  /** Metadata lookups give up after 30 s, so a stalled one cannot hold the metadata connection. */
  #metaQuery(sql: string, params: unknown[] = [], signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    return this.#pooledQuery(this.#meta, sql, params, METADATA_TIMEOUT_MS, signal);
  }

  async withSession<T>(fn: (session: DbSession) => Promise<T>): Promise<T> {
    const connection = await this.#acquire(this.#work);
    this.#active++;
    const session = new MysqlSession(connection, this);
    try {
      return await fn(session);
    } finally {
      await session.finish();
      this.#active--;
      if (session.dirty) connection.destroy();
      else connection.release();
    }
  }

  /**
   * KILL QUERY over the control pool; resolves once the server has accepted it. A control
   * connection that does not answer is closed, so it cannot hold up later cancels.
   */
  async cancel(backendId: number): Promise<boolean> {
    try {
      await this.#pooledQuery(this.#control, 'KILL QUERY ?', [backendId], CONTROL_TIMEOUT_MS);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The storage engine a write to this table reaches. A view has no engine of its own: its base
   * tables decide, and the first non-transactional one is reported. A view whose base tables cannot
   * be determined (no privilege, a cycle, nesting deeper than 16) reports UNRESOLVED_VIEW.
   */
  async tableEngine(table: TableRef, signal?: AbortSignal): Promise<string | null> {
    return this.#engineOf(table.schema, table.name, [], new Map(), signal, table.events);
  }

  /**
   * `ancestors`: the views above this one on the current path (a view used twice is not a cycle).
   * `known`: relations already resolved in this lookup, so a view shared by many paths is looked up
   * once and branching view graphs cost one lookup per relation, not per path.
   */
  async #engineOf(
    schema: string | null,
    name: string,
    ancestors: string[],
    known: Map<string, string | null>,
    signal?: AbortSignal,
    events?: TriggerEvent[],
  ): Promise<string | null> {
    const asked = `${schema ?? ''}.${name}|${events?.join(',') ?? '*'}`;
    if (known.has(asked)) return known.get(asked) ?? null;
    const engine = await this.#resolveEngine(schema, name, ancestors, known, signal, events);
    known.set(asked, engine);
    return engine;
  }

  async #resolveEngine(
    schema: string | null,
    name: string,
    ancestors: string[],
    known: Map<string, string | null>,
    signal?: AbortSignal,
    events?: TriggerEvent[],
  ): Promise<string | null> {
    const [row] = await this.#metaQuery(
      `SELECT TABLE_SCHEMA AS db, TABLE_TYPE AS type, ENGINE AS engine FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?`,
      [schema, name],
      signal,
    );
    if (!row) return null;
    const key = `${String(row.db)}.${name}`;
    if (row.type !== 'VIEW') {
      const engine = row.engine ? String(row.engine) : null;
      if (!engine || !TRANSACTIONAL_ENGINES.has(engine.toLowerCase())) return engine;
      // Triggers the write can fire write other tables in the same statement: those decide too.
      const fired = events?.length ? events : (['INSERT', 'UPDATE', 'DELETE'] as TriggerEvent[]);
      const triggers = await this.#metaQuery(
        `SELECT TRIGGER_SCHEMA AS db, ACTION_STATEMENT AS body FROM information_schema.TRIGGERS
          WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?
            AND EVENT_MANIPULATION IN (${fired.map(() => '?').join(', ')})`,
        [row.db, name, ...fired],
        signal,
      );
      // MySQL lists only the triggers of tables the account holds TRIGGER on: none listed proves
      // nothing without that privilege.
      if (!triggers.length) {
        return (await this.#seesTriggers(String(row.db), name, known, signal)) ? engine : UNRESOLVED_VIEW;
      }
      if (ancestors.includes(key) || ancestors.length >= 16) return UNRESOLVED_VIEW;
      for (const trigger of triggers) {
        const effects = routineEffects(String(trigger.body));
        const reached = await this.#effectsEngine(
          effects,
          String(trigger.db),
          [...ancestors, key],
          known,
          signal,
        );
        if (reached === UNRESOLVED_VIEW) return UNRESOLVED_VIEW;
        if (reached && !TRANSACTIONAL_ENGINES.has(reached.toLowerCase()))
          return `${reached} (written by a trigger)`;
      }
      return engine;
    }
    if (ancestors.includes(key) || ancestors.length >= 16) return UNRESOLVED_VIEW;
    const path = [...ancestors, key];
    const bases = await this.#metaQuery(
      'SELECT TABLE_SCHEMA AS db, TABLE_NAME AS name FROM information_schema.VIEW_TABLE_USAGE WHERE VIEW_SCHEMA = ? AND VIEW_NAME = ?',
      [row.db, name],
      signal,
    );
    if (!bases.length) return UNRESOLVED_VIEW;
    let found: string | null = null;
    for (const base of bases) {
      const engine = await this.#engineOf(String(base.db), String(base.name), path, known, signal);
      if (engine === null || engine === UNRESOLVED_VIEW) return UNRESOLVED_VIEW;
      if (!TRANSACTIONAL_ENGINES.has(engine.toLowerCase())) return engine;
      found ??= engine;
    }
    return found;
  }

  /**
   * Where the effects of a trigger or function body (defined in `db`) reach: UNRESOLVED_VIEW when
   * they cannot be determined, else the first non-transactional engine written (directly, through
   * triggers or through nested functions), else a transactional engine written, else null.
   */
  async #effectsEngine(
    effects: RoutineEffects | null,
    db: string,
    path: string[],
    known: Map<string, string | null>,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (!effects) return UNRESOLVED_VIEW;
    let found: string | null = null;
    for (const target of effects.tables) {
      const written = await this.#engineOf(
        target.schema ?? db,
        target.name,
        path,
        known,
        signal,
        target.events,
      );
      if (written === null || written === UNRESOLVED_VIEW) return UNRESOLVED_VIEW;
      const base = written.split(' ')[0] ?? written;
      if (!TRANSACTIONAL_ENGINES.has(base.toLowerCase())) return base;
      found ??= base;
    }
    for (const called of effects.functions) {
      const reached = await this.#functionEngineOf(called.schema ?? db, called.name, path, known, signal);
      if (reached === UNRESOLVED_VIEW) return UNRESOLVED_VIEW;
      const base = reached?.split(' ')[0] ?? null;
      if (base && !TRANSACTIONAL_ENGINES.has(base.toLowerCase())) return base;
      found ??= base;
    }
    for (const named of effects.relations) {
      const reached = await this.#viewEngineOf(named.schema ?? db, named.name, path, known, signal);
      if (reached === UNRESOLVED_VIEW) return UNRESOLVED_VIEW;
      const base = reached?.split(' ')[0] ?? null;
      if (base && !TRANSACTIONAL_ENGINES.has(base.toLowerCase())) return base;
      found ??= base;
    }
    return found;
  }

  /**
   * Where a call to a function reaches, for single-transaction checks: null when it is not a stored
   * function (a built-in or loadable one) or writes nothing; the engine a stored function writes
   * (the first non-transactional one, through triggers and nested functions too); UNRESOLVED_VIEW
   * when its body is hidden from the account or does more than plain reads and writes.
   */
  async functionEngine(fn: TableRef, signal?: AbortSignal): Promise<string | null> {
    return this.#functionEngineOf(fn.schema, fn.name, [], new Map(), signal);
  }

  async #functionEngineOf(
    schema: string | null,
    name: string,
    ancestors: string[],
    known: Map<string, string | null>,
    signal?: AbortSignal,
  ): Promise<string | null> {
    // Function names are not case-sensitive. A NUL keeps these apart from table keys.
    const asked = `\u0000fn ${schema ?? ''}.${name.toLowerCase()}`;
    if (known.has(asked)) return known.get(asked) ?? null;
    const [row] = await this.#metaQuery(
      `SELECT ROUTINE_SCHEMA AS db, ROUTINE_DEFINITION AS body FROM information_schema.ROUTINES
        WHERE ROUTINE_TYPE = 'FUNCTION' AND ROUTINE_SCHEMA = COALESCE(?, DATABASE()) AND ROUTINE_NAME = ?`,
      [schema, name],
      signal,
    );
    let engine: string | null;
    if (!row) engine = null;
    // MySQL shows a function's body only to its definer and to accounts with SHOW_ROUTINE.
    else if (row.body === null || row.body === undefined) engine = UNRESOLVED_VIEW;
    else {
      const key = `${String(row.db)}.${name.toLowerCase()}()`;
      engine =
        ancestors.includes(key) || ancestors.length >= 16
          ? UNRESOLVED_VIEW
          : await this.#effectsEngine(
              routineEffects(String(row.body)),
              String(row.db),
              [...ancestors, key],
              known,
              signal,
            );
    }
    known.set(asked, engine);
    return engine;
  }

  async viewEffects(): Promise<ViewEffects> {
    return { irreversible: null, notReadOnly: null };
  }

  async viewEngine(table: TableRef, signal?: AbortSignal): Promise<string | null> {
    return this.#viewEngineOf(table.schema, table.name, [], new Map(), signal, false);
  }

  /**
   * TABLES says whether a name is a base table or a view (it lists every relation the account can
   * use). A view's stored functions are found in its definition, which MySQL shows only with
   * SHOW VIEW (or to its definer): a view whose definition is hidden is unresolved. The views
   * beneath it come from VIEW_TABLE_USAGE and from the definition itself, so one hidden from either
   * is still followed. `beneath`: the name was reached through a view or routine, which runs with
   * its definer's rights: one the account cannot see there may be a view that writes.
   */
  async #viewEngineOf(
    schema: string | null,
    name: string,
    ancestors: string[],
    known: Map<string, string | null>,
    signal?: AbortSignal,
    beneath = true,
  ): Promise<string | null> {
    const asked = `\u0000view${beneath ? ' beneath' : ''} ${schema ?? ''}.${name}`;
    if (known.has(asked)) return known.get(asked) ?? null;
    const bad = (e: string | null) =>
      e === UNRESOLVED_VIEW || (e !== null && !TRANSACTIONAL_ENGINES.has(e.toLowerCase()));
    const [relation] = await this.#metaQuery(
      `SELECT TABLE_SCHEMA AS db, TABLE_TYPE AS type FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?`,
      [schema, name],
      signal,
    );
    let engine: string | null = null;
    // Not listed where the account itself names it: nothing it can read (a CTE name, a temporary
    // table, or none at all), so no view runs. Not listed beneath a view or routine: unknown. A base
    // table calls nothing either.
    if (!relation) engine = beneath ? UNRESOLVED_VIEW : null;
    else if (relation.type === 'VIEW') {
      const db = String(relation.db);
      const key = `${db}.${name}`;
      const [view] = await this.#metaQuery(
        'SELECT VIEW_DEFINITION AS body FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
        [db, name],
        signal,
      );
      if (!view?.body || ancestors.includes(key) || ancestors.length >= 16) engine = UNRESOLVED_VIEW;
      else {
        const path = [...ancestors, key];
        const definition = analyzeMysql(String(view.body));
        engine = await this.#effectsEngine(
          { tables: [], functions: definition.callsFunctions ?? [], relations: [] },
          db,
          path,
          known,
          signal,
        );
        if (!bad(engine)) {
          const used = await this.#metaQuery(
            `SELECT TABLE_SCHEMA AS db, TABLE_NAME AS name FROM information_schema.VIEW_TABLE_USAGE
              WHERE VIEW_SCHEMA = ? AND VIEW_NAME = ?`,
            [db, name],
            signal,
          );
          const below = new Map<string, TableRef>();
          for (const r of [
            ...used.map((u) => ({ schema: String(u.db), name: String(u.name) })),
            ...(definition.referencesTables ?? []).map((r) => ({ schema: r.schema ?? db, name: r.name })),
          ])
            below.set(`${r.schema}.${r.name}`, r);
          for (const relationBelow of below.values()) {
            const reached = await this.#viewEngineOf(
              relationBelow.schema,
              relationBelow.name,
              path,
              known,
              signal,
            );
            if (bad(reached)) {
              engine = reached;
              break;
            }
            engine ??= reached;
          }
        }
      }
    }
    known.set(asked, engine);
    return engine;
  }

  /**
   * The session holds TRIGGER on the table (globally, on its schema or on the table), directly or
   * through its active roles. SHOW GRANTS … USING expands what those roles grant.
   */
  async #seesTriggers(
    db: string,
    table: string,
    known: Map<string, string | null>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    // The session's grants, read once per lookup.
    let grants = known.get(GRANTS_KEY);
    if (grants === undefined) {
      const [current] = await this.#metaQuery(
        'SELECT CURRENT_ROLE() AS roles, @@global.partial_revokes AS partialRevokes',
        [],
        signal,
      );
      const roles = String(current?.roles ?? 'NONE');
      known.set(PARTIAL_REVOKES_KEY, Number(current?.partialRevokes) === 1 ? '1' : '0');
      // The role list comes from the server, already quoted (`role`@`host`, …).
      const rows = await this.#metaQuery(
        roles && roles !== 'NONE' ? `SHOW GRANTS FOR CURRENT_USER() USING ${roles}` : 'SHOW GRANTS',
        [],
        signal,
      );
      grants = rows.map((row) => String(Object.values(row)[0] ?? '')).join('\n');
      known.set(GRANTS_KEY, grants);
    }
    return triggerVisible((grants ?? '').split('\n'), db, table, known.get(PARTIAL_REVOKES_KEY) === '1');
  }

  activeSessions(): number {
    return this.#active;
  }

  monitorQuery(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    return this.#pooledQuery(this.#monitor, sql, params);
  }

  async close(): Promise<void> {
    const end = (p: Pool) => new Promise<void>((resolve) => p.end(() => resolve()));
    await Promise.allSettled([end(this.#work), end(this.#meta), end(this.#control), end(this.#monitor)]);
  }
}

class MysqlSession implements DbSession {
  readonly backendId: number;
  dirty: string | null = null;
  #inTransaction = false;
  /** Leading comment that shows the execution ID in the process list (digests ignore comments). */
  #label = '';
  readonly #onError = (error: Error) => this.markDirty(`connection error: ${error.message}`);

  constructor(
    private readonly connection: PoolConnection,
    private readonly adapter: MysqlAdapter,
  ) {
    this.backendId = connection.threadId ?? 0;
    connection.on('error', this.#onError);
  }

  markDirty(reason: string): void {
    this.dirty ??= reason;
  }

  async mayWriteThrough(
    refs: { functions: TableRef[]; relations: TableRef[] },
    database: string | null,
    signal?: AbortSignal,
  ): Promise<boolean> {
    for (const called of refs.functions) {
      const fn = { ...called, schema: called.schema ?? database };
      if ((await this.adapter.functionEngine(fn, signal)) !== null) return true;
    }
    for (const named of refs.relations) {
      const table = { ...named, schema: named.schema ?? database };
      if ((await this.adapter.viewEngine(table, signal)) !== null) return true;
    }
    return false;
  }

  #run(sql: string): Promise<Record<string, unknown>[]> {
    return new Promise((resolve, reject) =>
      this.connection.query({ sql }, (error, rows) =>
        error
          ? reject(mapMysqlError(error))
          : resolve((Array.isArray(rows) ? rows : []) as Record<string, unknown>[]),
      ),
    );
  }

  async tag(executionId: string): Promise<void> {
    this.#label = `/* database-workbench ${executionId.replace(/[^\w-]/g, '')} */ `;
  }

  /** Waits for one command on this connection, within `bounds` (see `bounded`). */
  #bounded<T>(work: Promise<T>, bounds: WaitBounds): Promise<T> {
    return bounded(work, () => this.#abandon(), bounds);
  }

  async begin(options: { readOnly: boolean } & WaitBounds): Promise<void> {
    await this.#bounded(
      this.#run(options.readOnly ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION READ WRITE'),
      options,
    );
    this.#inTransaction = true;
  }

  async commit(bounds: WaitBounds = {}): Promise<void> {
    this.#inTransaction = false;
    await this.#bounded(this.#run('COMMIT'), bounds);
  }

  async rollback(): Promise<void> {
    this.#inTransaction = false;
    // Closing the connection rolls the transaction back on the server, too.
    await this.#bounded(this.#run('ROLLBACK'), { deadline: Date.now() });
  }

  async execute(sql: string, sink: ResultSink, options: ExecuteOptions): Promise<StatementOutcome> {
    const timeout = Math.max(1, Math.floor(options.timeoutMs));
    const batchSize = options.batchSize ?? 500;
    const outcome: StatementOutcome = {
      command: null,
      affectedRows: null,
      resultSets: 0,
      rowsDelivered: 0,
      stopped: false,
      notices: [],
    };
    let interrupted: 'timeout' | 'cancelled' | 'stopped' | null = null;
    let killed: Promise<boolean> | null = null;
    /** Every wait on this connection: KILL QUERY cannot end one on a connection that stopped answering. */
    const guard = new StallGuard(() => this.#abandon());
    const interrupt = (why: 'timeout' | 'cancelled' | 'stopped') => {
      if (interrupted) return;
      interrupted = why;
      killed = this.adapter.cancel(this.backendId);
      guard.interrupted();
    };
    const timer = setTimeout(() => interrupt('timeout'), timeout);
    const onAbort = () => interrupt('cancelled');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) interrupt('cancelled');

    const drain = options.onStop === 'drain';
    /** Result sets the sink has enough of, while the statement runs on (drain). */
    const discarded = new Set<number>();
    let warnings = 0;
    let lost: ((error?: unknown) => void) | null = null;
    let failed: unknown = null;
    try {
      await guard.wait(
        new Promise<void>((resolve, reject) => {
          let columns: ColumnInfo[] = [];
          let encodings: string[] = [];
          let batch: Cell[][] = [];
          let index = -1;
          let pending: Promise<void> = Promise.resolve();
          // `pause`: hold the socket while the sink catches up. Not after the last row: once the
          // statement has ended (or was cancelled), a paused connection can swallow the reply to the
          // next command, which then never returns.
          const flush = (pause = true) => {
            if (!batch.length) return;
            const rows = batch;
            const at = index;
            batch = [];
            if (pause) this.connection.pause();
            pending = pending
              .then(async () => {
                if (interrupted || discarded.has(at)) return;
                outcome.rowsDelivered += rows.length;
                if ((await sink.rows(rows, at)) === 'stop') {
                  outcome.stopped = true;
                  if (drain) discarded.add(at);
                  else interrupt('stopped');
                }
              })
              .catch((error: unknown) => {
                failed ??= error;
                interrupt('stopped');
              })
              .finally(() => {
                if (pause) this.connection.resume();
              });
          };
          const query = this.connection.query({
            sql: this.#label + sql,
            rowsAsArray: true,
            typeCast: RAW as never,
          });
          /** An exception inside a driver event handler would otherwise leave this promise pending. */
          const guard =
            <A extends unknown[]>(handler: (...args: A) => void) =>
            (...args: A) => {
              try {
                handler(...args);
              } catch (error) {
                failed ??= error;
              }
            };
          query.on(
            'fields',
            guard((fields: RawField[] | undefined) => {
              // Statements without a result set report an empty field list.
              if (!fields?.length) return;
              flush();
              index++;
              columns = fields.map(columnInfo);
              encodings = fields.map((f) => f.encoding ?? 'utf8');
              outcome.resultSets = index + 1;
              const cols = columns;
              const at = index;
              pending = pending
                .then(() => sink.start(cols, at))
                .catch((error: unknown) => {
                  // Mirrors flush(): a sink that cannot store the result ends the statement.
                  failed ??= error;
                  interrupt('stopped');
                });
            }),
          );
          query.on(
            'result',
            guard((row: unknown) => {
              if (Array.isArray(row)) {
                if (interrupted || discarded.has(index)) return;
                batch.push(row.map((value, i) => toCell(value, columns[i]?.binary ?? false, encodings[i])));
                if (batch.length >= batchSize) flush();
              } else if (row && typeof row === 'object') {
                const header = row as { affectedRows?: number; warningStatus?: number };
                if (typeof header.affectedRows === 'number')
                  outcome.affectedRows = (outcome.affectedRows ?? 0) + header.affectedRows;
                warnings += header.warningStatus ?? 0;
              }
            }),
          );
          query.on('error', (error: unknown) => {
            void pending.finally(() => reject(error));
          });
          query.on('end', () => {
            flush(false);
            // finally, not then: the outer promise must settle even if a step of the chain failed.
            void pending.finally(() => (failed ? reject(failed) : resolve()));
          });
          // A dropped connection (KILL, a restart, the network) reaches mysql2's connection, not a
          // streaming query: without this, the statement would wait forever.
          lost = (error?: unknown) =>
            void pending.finally(() =>
              reject(
                error ??
                  Object.assign(new Error('Connection lost: the server closed the connection.'), {
                    code: 'PROTOCOL_CONNECTION_LOST',
                    fatal: true,
                  }),
              ),
            );
          this.connection.once('error', lost);
          this.connection.once('end', lost);
        }),
      );
    } catch (error) {
      const mapped = guard.abandoned ? guard.error() : mapMysqlError(error);
      const stoppedOnRequest =
        interrupted === 'stopped' && (mapped.code === '1317' || mapped.code === '3024');
      // Otherwise (the sink stopped reading and the server ended the statement on request), the
      // statement failed; a lost connection stays one even after a cancel or the time limit (our
      // cancel never closes the connection).
      if (!stoppedOnRequest) {
        const final = afterInterruption(mapped, interrupted === 'stopped' ? null : interrupted, timeout);
        if (final.category === 'connectivity') this.markDirty('connection lost');
        throw final;
      }
    } finally {
      if (lost) {
        this.connection.off('error', lost);
        this.connection.off('end', lost);
      }
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (killed && !guard.abandoned) await guard.wait(this.#absorbKill(killed));
      guard.stop();
    }
    // The sink failed (for example, storing captured rows): its stop request ended the statement
    // without an error of its own, but the result is incomplete and must not pass as finished.
    if (failed) throw failed;
    // An interrupted SLEEP() or BENCHMARK() ends without an error; the interruption still counts.
    // But a statement the server answered with rows changed has finished: outside a transaction
    // (autocommit) it has committed, so a cancel or time limit that came too late does not make it
    // read as rolled back. Inside one the interruption stands, and the transaction is rolled back.
    const committed = !this.#inTransaction && outcome.resultSets === 0 && (outcome.affectedRows ?? 0) > 0;
    if (interrupted === 'timeout' && !committed) {
      throw new DbError('timeout', `The statement exceeded its time limit of ${timeout} ms.`);
    }
    if (interrupted === 'cancelled' && !committed)
      throw new DbError('cancelled', 'The statement was cancelled.');
    // Result sets carry their warning count in the EOF packet, which mysql2 does not surface, so ask.
    if (!this.dirty) {
      try {
        const rows =
          warnings > 0 || outcome.resultSets > 0
            ? await this.#bounded(this.#run('SHOW WARNINGS LIMIT 20'), { deadline: Date.now() })
            : [];
        outcome.notices = rows.map((r) => `${String(r.Level)} ${String(r.Code)}: ${String(r.Message)}`);
      } catch {
        // Warnings are informative only.
      }
    }
    return outcome;
  }

  /**
   * After KILL QUERY, waits until the server has applied it and makes sure a late kill cannot hit
   * the next statement on this connection.
   */
  async #absorbKill(killed: Promise<boolean>): Promise<void> {
    if (!(await settlesWithin(killed, STALL_GRACE_MS))) {
      this.markDirty('a cancel request did not settle');
      return;
    }
    try {
      await this.#run('SELECT 1');
    } catch (error) {
      if (error instanceof DbError && error.code === '1317') {
        try {
          await this.#run('SELECT 1');
          return;
        } catch {
          // fall through
        }
      }
      this.markDirty('connection state unknown after cancellation');
    }
  }

  /**
   * Closes a connection that stopped answering (the raw socket: mysql2's own close waits for the
   * server and keeps a pending statement waiting). The statement ends as a lost connection.
   */
  #abandon(): void {
    this.markDirty('the connection stopped answering');
    (this.connection as unknown as { stream?: { destroy(): void } }).stream?.destroy();
  }

  async finish(): Promise<void> {
    try {
      if (this.#inTransaction && !this.dirty) {
        this.#inTransaction = false;
        await this.#bounded(this.#run('ROLLBACK'), { deadline: Date.now() });
      }
    } catch {
      this.markDirty('could not roll back');
    }
    // Whatever the run left on the connection is cleared before another execution, perhaps another
    // user's, gets it: user variables, named locks, temporary tables, LAST_INSERT_ID and session
    // variables, also when a stored function, trigger or procedure set them, which the statement
    // analysis cannot see. A reset also restores the server's default collation: set ours again.
    try {
      if (!this.dirty) {
        await this.#bounded(
          new Promise<void>((resolve, reject) =>
            this.connection.reset((error) => (error ? reject(mapMysqlError(error)) : resolve())),
          ),
          { deadline: Date.now() },
        );
        await this.#bounded(this.#run(`SET NAMES utf8mb4 COLLATE ${CONNECTION_COLLATION.toLowerCase()}`), {
          deadline: Date.now(),
        });
      }
    } catch {
      this.markDirty('could not reset the session');
    } finally {
      this.connection.removeListener('error', this.#onError);
    }
  }
}
