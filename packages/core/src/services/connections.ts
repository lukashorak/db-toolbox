import { isIP } from 'node:net';
import { z } from 'zod';
import { AppError, assert } from '../domain/errors.js';
import { newId } from '../domain/ids.js';
import {
  ACTIVE_EXECUTION_STATUSES,
  ENGINES,
  ENVIRONMENTS,
  TLS_MODES,
  type Actor,
  type ConnectionView,
  type Engine,
} from '../domain/types.js';
import { requirePermission } from '../security/policy.js';
import { bool, int, type Row } from '../store/database.js';
import { changedFields, isoNow, type ServiceContext } from './context.js';
import { fieldError, isHost, isPemCertificate, parseInput } from './validation.js';

const common = {
  name: z.string().trim().min(1, 'Enter a name.').max(80, 'Use 80 characters or fewer.'),
  environment: z.enum(ENVIRONMENTS),
  host: z
    .string()
    .trim()
    .min(1, 'Enter a host name or IP address.')
    .refine(isHost, 'Use a host name or IP address without scheme, port or path.'),
  port: z.number().int().min(1, 'Use a port from 1 to 65535.').max(65535, 'Use a port from 1 to 65535.'),
  database: z.string().trim().min(1, 'Enter the default database.').max(128),
  schema: z.string().trim().min(1).max(128).nullable(),
  username: z.string().trim().min(1, 'Enter the database user name.').max(128),
  tlsMode: z.enum(TLS_MODES),
  caPem: z.string().trim().max(65536).refine(isPemCertificate, 'Paste a PEM certificate.').nullable(),
  readOnly: z.boolean(),
  enabled: z.boolean(),
};

const createSchema = z
  .object({
    ...common,
    engine: z.enum(ENGINES),
    password: z.string().min(1, 'Enter the password for a new connection.').max(4096),
    /** Optional separate account used only by the fixed monitoring queries. */
    monitorUsername: z.string().trim().min(1).max(128).nullable().default(null),
    monitorPassword: z.string().max(4096).default(''),
    schema: common.schema.optional().default(null),
    caPem: common.caPem.optional().default(null),
    readOnly: common.readOnly.default(true),
    enabled: common.enabled.default(true),
  })
  .strict();

/** On update, an omitted or empty password keeps the stored secret. */
const updateSchema = z
  .object({
    name: common.name,
    environment: common.environment,
    host: common.host,
    port: common.port,
    database: common.database,
    schema: common.schema,
    username: common.username,
    tlsMode: common.tlsMode,
    caPem: common.caPem,
    readOnly: common.readOnly,
    enabled: common.enabled,
    password: z.string().max(4096),
    /** null removes the monitoring account; a blank password keeps the stored one. */
    monitorUsername: z.string().trim().min(1).max(128).nullable(),
    monitorPassword: z.string().max(4096),
    engine: z.enum(ENGINES),
  })
  .partial()
  .strict();

export type CreateConnectionInput = z.input<typeof createSchema>;
export type UpdateConnectionInput = z.input<typeof updateSchema>;

interface Secret {
  password: string;
}

/** Full connection settings for adapters inside core. Never returned through an interface. */
export interface ConnectionCredentials extends ConnectionView {
  password: string;
  caPem: string | null;
  /** Separate monitoring account, when configured. */
  monitor: { username: string; password: string } | null;
}

export interface ConnectionReferences {
  savedQueries: { id: string; name: string }[];
  profiles: { id: string; name: string }[];
  activeExecutions: { id: string; status: string }[];
}

const toView = (r: Row): ConnectionView => ({
  id: String(r.id),
  owner: String(r.owner),
  name: String(r.name),
  engine: r.engine as Engine,
  environment: r.environment as ConnectionView['environment'],
  host: String(r.host),
  port: Number(r.port),
  database: String(r.database_name),
  schema: (r.schema_name as string | null) ?? null,
  username: String(r.username),
  hasPassword: true,
  tlsMode: r.tls_mode as ConnectionView['tlsMode'],
  hasCustomCa: r.ca_pem != null,
  monitorUsername: (r.monitor_username as string | null) ?? null,
  readOnly: bool(r.read_only),
  enabled: bool(r.enabled),
  transport: 'direct',
  lastTestAt: (r.last_test_at as string | null) ?? null,
  lastTestResult: r.last_test_result ? JSON.parse(String(r.last_test_result)) : null,
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

/** MySQL's driver checks certificate names only for host names (see db/tls.ts). */
function checkTls(engine: Engine, host: string, tlsMode: string): void {
  if (engine === 'mysql' && tlsMode === 'verify-full' && isIP(host)) {
    throw fieldError(
      'host',
      'For MySQL with verify-full, use the host name in the server certificate, or choose verify-ca.',
    );
  }
}

const ACTIVE = ACTIVE_EXECUTION_STATUSES.map((s) => `'${s}'`).join(', ');

export class ConnectionService {
  constructor(private readonly ctx: ServiceContext) {}

  list(actor: Actor): ConnectionView[] {
    requirePermission(actor, 'connections.view');
    return this.ctx.db.all('SELECT * FROM connections ORDER BY lower(name)').map(toView);
  }

  get(actor: Actor, id: string): ConnectionView {
    requirePermission(actor, 'connections.view');
    return toView(this.row(id));
  }

  create(actor: Actor, input: CreateConnectionInput): ConnectionView {
    requirePermission(actor, 'connections.manage');
    const value = parseInput(createSchema, input);
    if (value.engine === 'mysql' && value.schema) {
      throw fieldError('schema', 'MySQL has no separate schema; set the default database instead.');
    }
    checkTls(value.engine, value.host, value.tlsMode);
    if (value.monitorUsername && !value.monitorPassword) {
      throw fieldError('monitorPassword', 'Enter the password of the monitoring account.');
    }
    const id = newId('connection', this.ctx.clock.now());
    const now = isoNow(this.ctx);
    this.ctx.db.transaction(() => {
      this.assertNameFree(value.name);
      this.ctx.db.run(
        `INSERT INTO connections (id, owner, name, engine, environment, host, port, database_name, schema_name, username,
           secret, monitor_username, monitor_secret, tls_mode, ca_pem, read_only, enabled, created_at, updated_at)
         VALUES (:id, :owner, :name, :engine, :environment, :host, :port, :database, :schema, :username,
           :secret, :monitorUser, :monitorSecret, :tls, :ca, :ro, :enabled, :now, :now)`,
        {
          id,
          owner: actor.subject,
          name: value.name,
          engine: value.engine,
          environment: value.environment,
          host: value.host,
          port: value.port,
          database: value.database,
          schema: value.schema,
          username: value.username,
          secret: this.ctx.secrets.seal({ password: value.password } satisfies Secret, id),
          monitorUser: value.monitorUsername,
          monitorSecret: value.monitorUsername
            ? this.ctx.secrets.seal({ password: value.monitorPassword } satisfies Secret, `${id}:monitor`)
            : null,
          tls: value.tlsMode,
          ca: value.caPem,
          ro: int(value.readOnly),
          enabled: int(value.enabled),
          now,
        },
      );
      this.ctx.audit.record({
        actor,
        action: 'connection.create',
        target: { type: 'connection', id, label: value.name },
        outcome: 'succeeded',
        details: {
          engine: value.engine,
          environment: value.environment,
          readOnly: value.readOnly,
          tlsMode: value.tlsMode,
        },
      });
    });
    return toView(this.row(id));
  }

  update(actor: Actor, id: string, input: UpdateConnectionInput): ConnectionView {
    requirePermission(actor, 'connections.manage');
    const patch = parseInput(updateSchema, input);
    const before = toView(this.row(id));
    if (patch.engine !== undefined && patch.engine !== before.engine) {
      throw new AppError(
        'engine_immutable',
        'The engine of a connection cannot change. Create a new connection instead.',
      );
    }
    const schema = patch.schema === undefined ? before.schema : patch.schema;
    if (before.engine === 'mysql' && schema) {
      throw fieldError('schema', 'MySQL has no separate schema; set the default database instead.');
    }
    checkTls(before.engine, patch.host ?? before.host, patch.tlsMode ?? before.tlsMode);
    const replacePassword = typeof patch.password === 'string' && patch.password.length > 0;
    const monitorUser = patch.monitorUsername === undefined ? before.monitorUsername : patch.monitorUsername;
    const replaceMonitor =
      Boolean(monitorUser) && typeof patch.monitorPassword === 'string' && patch.monitorPassword.length > 0;
    if (monitorUser && !before.monitorUsername && !replaceMonitor) {
      throw fieldError('monitorPassword', 'Enter the password of the monitoring account.');
    }
    const {
      password: _password,
      engine: _engine,
      monitorPassword: _monitorPassword,
      caPem,
      ...fields
    } = patch;
    const changed = changedFields(before, fields);
    this.ctx.db.transaction(() => {
      if (patch.name !== undefined && patch.name.toLowerCase() !== before.name.toLowerCase())
        this.assertNameFree(patch.name);
      this.ctx.db.run(
        `UPDATE connections SET name = :name, environment = :environment, host = :host, port = :port,
           database_name = :database, schema_name = :schema, username = :username, tls_mode = :tls,
           ca_pem = CASE WHEN :caSet = 1 THEN :ca ELSE ca_pem END,
           secret = CASE WHEN :secretSet = 1 THEN :secret ELSE secret END,
           monitor_username = :monitorUser,
           monitor_secret = CASE WHEN :monitorUser IS NULL THEN NULL WHEN :monitorSet = 1 THEN :monitorSecret ELSE monitor_secret END,
           read_only = :ro, enabled = :enabled, updated_at = :now
         WHERE id = :id`,
        {
          id,
          name: patch.name ?? before.name,
          environment: patch.environment ?? before.environment,
          host: patch.host ?? before.host,
          port: patch.port ?? before.port,
          database: patch.database ?? before.database,
          schema,
          username: patch.username ?? before.username,
          tls: patch.tlsMode ?? before.tlsMode,
          caSet: int(caPem !== undefined),
          ca: caPem ?? null,
          secretSet: int(replacePassword),
          secret: replacePassword
            ? this.ctx.secrets.seal({ password: String(patch.password) } satisfies Secret, id)
            : '',
          monitorUser: monitorUser ?? null,
          monitorSet: int(replaceMonitor),
          monitorSecret: replaceMonitor
            ? this.ctx.secrets.seal(
                { password: String(patch.monitorPassword) } satisfies Secret,
                `${id}:monitor`,
              )
            : '',
          ro: int(patch.readOnly ?? before.readOnly),
          enabled: int(patch.enabled ?? before.enabled),
          now: isoNow(this.ctx),
        },
      );
      this.ctx.audit.record({
        actor,
        action: 'connection.update',
        target: { type: 'connection', id, label: patch.name ?? before.name },
        outcome: 'succeeded',
        details: {
          changed: [...changed, ...(caPem !== undefined ? ['caPem'] : [])],
          credential: replacePassword ? 'replaced' : 'kept',
          monitorCredential: !monitorUser
            ? before.monitorUsername
              ? 'removed'
              : 'none'
            : replaceMonitor
              ? 'replaced'
              : 'kept',
          ...(patch.readOnly !== undefined && patch.readOnly !== before.readOnly
            ? { readOnly: { from: before.readOnly, to: patch.readOnly } }
            : {}),
        },
      });
    });
    this.ctx.onConnectionChanged?.(id);
    return toView(this.row(id));
  }

  setEnabled(actor: Actor, id: string, enabled: boolean): ConnectionView {
    requirePermission(actor, 'connections.manage');
    const before = toView(this.row(id));
    if (before.enabled === enabled) return before;
    this.ctx.db.transaction(() => {
      this.ctx.db.run('UPDATE connections SET enabled = :enabled, updated_at = :now WHERE id = :id', {
        id,
        enabled: int(enabled),
        now: isoNow(this.ctx),
      });
      this.ctx.audit.record({
        actor,
        action: enabled ? 'connection.enable' : 'connection.disable',
        target: { type: 'connection', id, label: before.name },
        outcome: 'succeeded',
      });
    });
    this.ctx.onConnectionChanged?.(id);
    return toView(this.row(id));
  }

  /** What refers to a connection, disclosed before disabling or deleting it. */
  references(actor: Actor, id: string): ConnectionReferences {
    requirePermission(actor, 'connections.view');
    this.row(id);
    const db = this.ctx.db;
    return {
      savedQueries: db
        .all('SELECT id, name FROM saved_queries WHERE default_connection_id = :id ORDER BY lower(name)', {
          id,
        })
        .map((r) => ({ id: String(r.id), name: String(r.name) })),
      profiles: db
        .all(
          `SELECT p.id, p.name FROM mcp_profiles p JOIN mcp_profile_connections pc ON pc.profile_id = p.id
           WHERE pc.connection_id = :id ORDER BY lower(p.name)`,
          { id },
        )
        .map((r) => ({ id: String(r.id), name: String(r.name) })),
      activeExecutions: db
        .all(
          `SELECT id, status FROM executions WHERE connection_id = :id AND status IN (${ACTIVE}) ORDER BY submitted_at`,
          {
            id,
          },
        )
        .map((r) => ({ id: String(r.id), status: String(r.status) })),
    };
  }

  /**
   * Deletes the stored configuration and its encrypted credentials. The target database is not
   * touched. History keeps its snapshot of the connection name. Refused while work is active.
   */
  delete(actor: Actor, id: string): ConnectionReferences {
    requirePermission(actor, 'connections.manage');
    const before = toView(this.row(id));
    const result = this.ctx.db.transaction(() => {
      const refs = this.references(actor, id);
      if (refs.activeExecutions.length) {
        throw new AppError(
          'connection_busy',
          'Active executions use this connection. Cancel them or wait first.',
          {
            activeExecutions: refs.activeExecutions.map((e) => e.id),
          },
        );
      }
      this.ctx.db.run('DELETE FROM connections WHERE id = :id', { id });
      this.ctx.audit.record({
        actor,
        action: 'connection.delete',
        target: { type: 'connection', id, label: before.name },
        outcome: 'succeeded',
        details: { savedQueries: refs.savedQueries.length, profiles: refs.profiles.map((p) => p.name) },
      });
      return refs;
    });
    this.ctx.onConnectionChanged?.(id);
    return result;
  }

  /** Stores the outcome of a connection test (step 3). */
  recordTest(id: string, result: unknown): void {
    this.ctx.db.run('UPDATE connections SET last_test_at = :at, last_test_result = :result WHERE id = :id', {
      id,
      at: isoNow(this.ctx),
      result: JSON.stringify(result),
    });
  }

  /** Decrypts credentials for a database session. For adapters inside core only. */
  credentials(id: string): ConnectionCredentials {
    const row = this.row(id);
    const secret = this.ctx.secrets.open<Secret>(String(row.secret), id);
    const monitor =
      row.monitor_username && row.monitor_secret
        ? {
            username: String(row.monitor_username),
            password: this.ctx.secrets.open<Secret>(String(row.monitor_secret), `${id}:monitor`).password,
          }
        : null;
    return {
      ...toView(row),
      password: secret.password,
      caPem: (row.ca_pem as string | null) ?? null,
      monitor,
    };
  }

  private row(id: string): Row {
    const row = this.ctx.db.get('SELECT * FROM connections WHERE id = :id', { id });
    assert(row, 'not_found', 'Connection not found.', { id });
    return row;
  }

  private assertNameFree(name: string): void {
    const taken = this.ctx.db.get('SELECT id FROM connections WHERE lower(name) = lower(:name)', { name });
    if (taken)
      throw new AppError('name_conflict', `Another connection is already named “${name}”.`, {
        field: 'name',
      });
  }
}

export { createSchema as connectionCreateSchema, updateSchema as connectionUpdateSchema };
