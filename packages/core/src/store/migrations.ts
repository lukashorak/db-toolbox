export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const enumCheck = (column: string, values: readonly string[]) =>
  `CHECK (${column} IN (${values.map((v) => `'${v}'`).join(', ')}))`;

const EXECUTION_STATUS = [
  'queued',
  'running',
  'cancel_requested',
  'succeeded',
  'failed',
  'rejected',
  'preflight_rejected',
  'cancelled',
  'timed_out',
  'interrupted',
  'unknown',
];
const TX_OUTCOME = ['none', 'not_started', 'committed', 'rolled_back', 'partial_commit', 'unknown'];
const COMPLETENESS = [
  'capturing',
  'complete',
  'preview_limited',
  'interrupted',
  'quota_limited',
  'expired',
  'deleted',
];

/**
 * Migration 1 creates the whole v1 schema so later steps add behavior, not structure. Times are
 * ISO-8601 UTC text. Booleans are 0/1 integers. Snapshots (names, SQL) keep history readable
 * after the referenced configuration changes or is deleted.
 */
const INITIAL = `
CREATE TABLE users (
  subject       TEXT PRIMARY KEY,
  username      TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  email         TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
) STRICT;

CREATE TABLE connections (
  id               TEXT PRIMARY KEY,
  owner            TEXT NOT NULL REFERENCES users(subject),
  name             TEXT NOT NULL,
  engine           TEXT NOT NULL ${enumCheck('engine', ['postgresql', 'mysql'])},
  environment      TEXT NOT NULL ${enumCheck('environment', ['production', 'development'])},
  host             TEXT NOT NULL,
  port             INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  database_name    TEXT NOT NULL,
  schema_name      TEXT,
  username         TEXT NOT NULL,
  secret           TEXT NOT NULL,
  monitor_username    TEXT,
  monitor_secret      TEXT,
  tls_mode         TEXT NOT NULL ${enumCheck('tls_mode', ['verify-full', 'verify-ca', 'require', 'disable'])},
  ca_pem           TEXT,
  read_only        INTEGER NOT NULL CHECK (read_only IN (0, 1)),
  enabled          INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  transport        TEXT NOT NULL DEFAULT 'direct' ${enumCheck('transport', ['direct'])},
  last_test_at     TEXT,
  last_test_result TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX connections_name ON connections(lower(name));

CREATE TABLE mcp_profiles (
  id            TEXT PRIMARY KEY,
  owner         TEXT NOT NULL REFERENCES users(subject),
  name          TEXT NOT NULL,
  client_id     TEXT NOT NULL UNIQUE,
  read_only     INTEGER NOT NULL CHECK (read_only IN (0, 1)),
  enabled       INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  timeout_ms    INTEGER NOT NULL CHECK (timeout_ms > 0),
  preview_rows  INTEGER NOT NULL CHECK (preview_rows > 0),
  preview_bytes INTEGER NOT NULL CHECK (preview_bytes > 0),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX mcp_profiles_name ON mcp_profiles(lower(name));

CREATE TABLE mcp_profile_connections (
  profile_id    TEXT NOT NULL REFERENCES mcp_profiles(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  PRIMARY KEY (profile_id, connection_id)
) STRICT;

CREATE TABLE folders (
  id         TEXT PRIMARY KEY,
  owner      TEXT NOT NULL REFERENCES users(subject),
  parent_id  TEXT REFERENCES folders(id) ON DELETE RESTRICT,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX folders_name ON folders(owner, coalesce(parent_id, ''), lower(name));

CREATE TABLE saved_queries (
  id                    TEXT PRIMARY KEY,
  owner                 TEXT NOT NULL REFERENCES users(subject),
  folder_id             TEXT REFERENCES folders(id) ON DELETE RESTRICT,
  name                  TEXT NOT NULL,
  sql                   TEXT NOT NULL,
  default_connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX saved_queries_name ON saved_queries(owner, coalesce(folder_id, ''), lower(name));

CREATE TABLE executions (
  id                  TEXT PRIMARY KEY,
  owner               TEXT NOT NULL REFERENCES users(subject),
  actor_subject       TEXT NOT NULL,
  source              TEXT NOT NULL ${enumCheck('source', ['gui', 'api', 'mcp'])},
  client_id           TEXT NOT NULL,
  actor_roles         TEXT NOT NULL DEFAULT '[]',
  profile_id          TEXT REFERENCES mcp_profiles(id) ON DELETE SET NULL,
  profile_name        TEXT,
  connection_id       TEXT REFERENCES connections(id) ON DELETE SET NULL,
  connection_name     TEXT NOT NULL,
  engine              TEXT NOT NULL ${enumCheck('engine', ['postgresql', 'mysql'])},
  database_name       TEXT,
  schema_name         TEXT,
  saved_query_id      TEXT REFERENCES saved_queries(id) ON DELETE SET NULL,
  title               TEXT NOT NULL,
  request_key         TEXT NOT NULL,
  request_hash        TEXT NOT NULL,
  sql                 TEXT NOT NULL,
  scope               TEXT NOT NULL,
  capture_mode        TEXT NOT NULL ${enumCheck('capture_mode', ['preview', 'full'])},
  transaction_mode    TEXT NOT NULL ${enumCheck('transaction_mode', ['per_statement', 'atomic'])},
  continue_on_error   INTEGER NOT NULL DEFAULT 0 CHECK (continue_on_error IN (0, 1)),
  timeout_ms          INTEGER NOT NULL CHECK (timeout_ms > 0),
  retention           TEXT NOT NULL ${enumCheck('retention', ['working', 'retained'])},
  retain_days         INTEGER,
  read_only           INTEGER NOT NULL DEFAULT 1 CHECK (read_only IN (0, 1)),
  policy_sources      TEXT NOT NULL DEFAULT '[]',
  status              TEXT NOT NULL ${enumCheck('status', EXECUTION_STATUS)},
  status_note         TEXT,
  transaction_outcome TEXT NOT NULL ${enumCheck('transaction_outcome', TX_OUTCOME)},
  submitted_at        TEXT NOT NULL,
  started_at          TEXT,
  finished_at         TEXT,
  cancel_requested_at TEXT,
  error_code          TEXT,
  error_message       TEXT,
  error_detail        TEXT,
  result_expires_at   TEXT,
  metadata_expires_at TEXT NOT NULL,
  UNIQUE (owner, request_key)
) STRICT;
CREATE INDEX executions_queue ON executions(connection_id, status, submitted_at);
CREATE INDEX executions_owner ON executions(owner, submitted_at);

CREATE TABLE statements (
  execution_id        TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  ordinal             INTEGER NOT NULL,
  sql                 TEXT NOT NULL,
  kind                TEXT NOT NULL ${enumCheck('kind', ['read', 'write', 'transaction', 'session', 'unknown'])},
  command             TEXT NOT NULL,
  offset_start        INTEGER NOT NULL,
  offset_end          INTEGER NOT NULL,
  line_start          INTEGER NOT NULL,
  column_start        INTEGER NOT NULL,
  line_end            INTEGER NOT NULL,
  column_end          INTEGER NOT NULL,
  status              TEXT NOT NULL ${enumCheck('status', ['not_run', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'])},
  transaction_outcome TEXT NOT NULL ${enumCheck('transaction_outcome', TX_OUTCOME)},
  affected_rows       INTEGER,
  error_code          TEXT,
  error_message       TEXT,
  error_detail        TEXT,
  notices             TEXT,
  started_at          TEXT,
  duration_ms         INTEGER,
  PRIMARY KEY (execution_id, ordinal)
) STRICT;

CREATE TABLE result_sets (
  execution_id   TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  result_index   INTEGER NOT NULL,
  statement      INTEGER NOT NULL,
  columns        TEXT NOT NULL,
  row_count      INTEGER NOT NULL DEFAULT 0,
  byte_count     INTEGER NOT NULL DEFAULT 0,
  more_available INTEGER NOT NULL DEFAULT 0 CHECK (more_available IN (0, 1)),
  completeness   TEXT NOT NULL ${enumCheck('completeness', COMPLETENESS)},
  captured_at    TEXT,
  expires_at     TEXT,
  PRIMARY KEY (execution_id, result_index)
) STRICT;

CREATE TABLE result_chunks (
  execution_id TEXT NOT NULL,
  result_index INTEGER NOT NULL,
  chunk_index  INTEGER NOT NULL,
  row_start    INTEGER NOT NULL,
  row_count    INTEGER NOT NULL,
  byte_count   INTEGER NOT NULL,
  data         BLOB NOT NULL,
  PRIMARY KEY (execution_id, result_index, chunk_index),
  FOREIGN KEY (execution_id, result_index) REFERENCES result_sets(execution_id, result_index) ON DELETE CASCADE
) STRICT;

CREATE TABLE exports (
  id            TEXT PRIMARY KEY,
  execution_id  TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  result_index  INTEGER NOT NULL,
  format        TEXT NOT NULL ${enumCheck('format', ['csv', 'json'])},
  preview_only  INTEGER NOT NULL CHECK (preview_only IN (0, 1)),
  status        TEXT NOT NULL ${enumCheck('status', ['generating', 'ready', 'failed', 'expired', 'deleted'])},
  file_name     TEXT,
  row_count     INTEGER NOT NULL DEFAULT 0,
  byte_count    INTEGER NOT NULL DEFAULT 0,
  error_code    TEXT,
  error_message TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  completed_at  TEXT,
  expires_at    TEXT
) STRICT;
CREATE INDEX exports_execution ON exports(execution_id, result_index);

CREATE TABLE disclosure_approvals (
  id              TEXT PRIMARY KEY,
  execution_id    TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  result_index    INTEGER NOT NULL,
  profile_id      TEXT REFERENCES mcp_profiles(id) ON DELETE SET NULL,
  profile_name    TEXT NOT NULL,
  status          TEXT NOT NULL ${enumCheck('status', ['pending', 'active', 'expired', 'revoked', 'denied'])},
  requested_rows  INTEGER NOT NULL,
  requested_bytes INTEGER NOT NULL,
  requested_by    TEXT,
  requested_at    TEXT NOT NULL,
  granted_rows    INTEGER,
  granted_bytes   INTEGER,
  rows_delivered  INTEGER NOT NULL DEFAULT 0,
  bytes_delivered INTEGER NOT NULL DEFAULT 0,
  decided_by      TEXT,
  decided_at      TEXT,
  expires_at      TEXT,
  note            TEXT
) STRICT;
CREATE INDEX disclosure_scope ON disclosure_approvals(execution_id, result_index, profile_id, status);

CREATE TABLE mcp_usage (
  execution_id   TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  profile_id     TEXT NOT NULL,
  rows_returned  INTEGER NOT NULL DEFAULT 0,
  bytes_returned INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (execution_id, profile_id)
) STRICT;

CREATE TABLE audit_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT NOT NULL,
  actor_subject TEXT,
  actor_label   TEXT NOT NULL,
  source        TEXT NOT NULL ${enumCheck('source', ['gui', 'api', 'mcp', 'server'])},
  profile_id    TEXT,
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  target_label  TEXT,
  outcome       TEXT NOT NULL ${enumCheck('outcome', ['succeeded', 'accepted', 'pending', 'denied', 'failed'])},
  details       TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE INDEX audit_at ON audit_events(at);
CREATE INDEX audit_action ON audit_events(action, at);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
) STRICT;
`;

export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: 'initial schema', sql: INITIAL }];
