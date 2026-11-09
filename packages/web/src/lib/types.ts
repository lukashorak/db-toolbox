/** API shapes used by the screens (see /api/v1/openapi.json). */
export interface Connection {
  id: string;
  name: string;
  engine: 'postgresql' | 'mysql';
  environment: 'production' | 'development';
  host: string;
  port: number;
  database: string;
  schema: string | null;
  username: string;
  hasPassword: boolean;
  tlsMode: 'verify-full' | 'verify-ca' | 'require' | 'disable';
  hasCustomCa: boolean;
  monitorUsername: string | null;
  readOnly: boolean;
  enabled: boolean;
  transport: 'direct';
  lastTestAt: string | null;
  lastTestResult: TestReport | null;
  createdAt: string;
  updatedAt: string;
}

export interface TestReport {
  ok: boolean;
  testedAt: string;
  failure: { category: string; message: string; code: string | null } | null;
  steps: { name: string; status: 'ok' | 'failed' | 'skipped'; durationMs: number; detail: string }[];
  server: { product: string; version: string } | null;
  tls: { mode: string; description: string; encrypted: boolean | null; protocol: string | null };
  capabilities: { name: string; available: boolean; detail: string }[];
  warnings: string[];
}

export interface References {
  savedQueries: { id: string; name: string }[];
  profiles: { id: string; name: string }[];
  activeExecutions: { id: string; status: string }[];
}

export interface MetadataResult<T> {
  status: 'ok' | 'insufficient_permission' | 'unavailable';
  items: T[];
  reason?: string;
}

export interface SchemaInfo {
  name: string;
  system: boolean;
  usable: boolean;
}

export interface ObjectInfo {
  schema: string;
  name: string;
  kind: string;
  signature?: string;
  returns?: string | null;
  comment: string | null;
  accessible: boolean | null;
  engine?: string | null;
  rowEstimate?: number | null;
}

export interface TableDetail {
  schema: string;
  name: string;
  kind: string;
  comment: string | null;
  columns: MetadataResult<{
    position: number;
    name: string;
    type: string;
    nullable: boolean;
    default: string | null;
    comment: string | null;
    identity: string | null;
    generated: string | null;
  }>;
  keys: MetadataResult<{
    name: string;
    type: string;
    columns: string[];
    references?: { schema: string; table: string; columns: string[] };
    definition: string | null;
  }>;
  indexes: MetadataResult<{
    name: string;
    unique: boolean;
    primary: boolean;
    columns: string[];
    method: string | null;
    definition: string | null;
  }>;
  definition: { status: string; text: string | null; reconstructed?: boolean; reason?: string };
}

export interface Folder {
  id: string;
  parentId: string | null;
  name: string;
}

export interface SavedQuery {
  id: string;
  folderId: string | null;
  name: string;
  sql: string;
  defaultConnectionId: string | null;
  updatedAt: string;
}
