import { loadConfig } from '../src/config.js';
import { createCore, type Core } from '../src/core.js';
import type { Actor, Clock, Role } from '../src/domain/types.js';

export const TEST_KEY = Buffer.alloc(32, 42);

export const limits = loadConfig({
  PUBLIC_URL: 'https://db.example.test',
  KEYCLOAK_ISSUER: 'https://auth.example.test/realms/workbench',
  ENCRYPTION_KEY: TEST_KEY.toString('base64'),
}).limits;

/** A clock that advances one second per call, so timestamps are ordered and deterministic. */
export function steppingClock(start = Date.UTC(2026, 10, 7, 10, 0, 0)): Clock {
  let t = start;
  return { now: () => new Date((t += 1000)) };
}

export function actor(subject: string, roles: Role[], extra: Partial<Actor> = {}): Actor {
  return {
    subject,
    username: subject,
    displayName: subject,
    roles,
    source: 'gui',
    clientId: 'workbench-gui',
    ...extra,
  };
}

export const admin = actor('admin', ['query:read', 'query:write', 'monitor:read', 'admin']);
export const writer = actor('writer', ['query:read', 'query:write']);
export const reader = actor('reader', ['query:read']);
export const adminWithoutWrite = actor('ops-admin', ['query:read', 'admin']);

export function testCore(file = ':memory:'): Core {
  const core = createCore({ databaseFile: file, encryptionKey: TEST_KEY, limits, clock: steppingClock() });
  for (const a of [admin, writer, reader, adminWithoutWrite]) core.users.touch(a);
  return core;
}

export const pgInput = {
  name: 'Production analytics',
  engine: 'postgresql' as const,
  environment: 'production' as const,
  host: 'pg-analytics.db.example.test',
  port: 5432,
  database: 'commerce',
  schema: 'public',
  username: 'wb_analytics_ro',
  password: 'correct horse battery staple',
  tlsMode: 'verify-full' as const,
  readOnly: true,
};

/** Inserts an execution row directly, for tests of services that react to executions. */
export function insertExecution(core: Core, id: string, connectionId: string | null, status: string): void {
  core.db.run(
    `INSERT INTO executions (id, owner, actor_subject, source, client_id, connection_id, connection_name, engine, title,
       request_key, request_hash, sql, scope, capture_mode, transaction_mode, timeout_ms, retention, status,
       transaction_outcome, submitted_at, metadata_expires_at)
     VALUES (:id, 'writer', 'writer', 'gui', 'workbench-gui', :conn, 'conn', 'postgresql', 'test', :id, 'h', 'SELECT 1',
       'Current statement', 'preview', 'per_statement', 30000, 'working', :status, 'not_started', '2026-11-07T10:00:00Z',
       '2027-02-05T10:00:00Z')`,
    { id, conn: connectionId, status },
  );
}
