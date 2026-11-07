/** Shared domain vocabulary. State names match the design prototype. */

export const ENGINES = ['postgresql', 'mysql'] as const;
export type Engine = (typeof ENGINES)[number];

export const ENVIRONMENTS = ['production', 'development'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** `disable` is direct TCP without TLS; `require` encrypts without verifying the certificate. */
export const TLS_MODES = ['verify-full', 'verify-ca', 'require', 'disable'] as const;
export type TlsMode = (typeof TLS_MODES)[number];

export const ROLES = ['query:read', 'query:write', 'monitor:read', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const SOURCES = ['gui', 'api', 'mcp'] as const;
export type Source = (typeof SOURCES)[number];

export const EXECUTION_STATUSES = [
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
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];
export const ACTIVE_EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  'queued',
  'running',
  'cancel_requested',
];

export const TRANSACTION_OUTCOMES = [
  'none',
  'not_started',
  'committed',
  'rolled_back',
  'partial_commit',
  'unknown',
] as const;
export type TransactionOutcome = (typeof TRANSACTION_OUTCOMES)[number];

export const COMPLETENESS = [
  'capturing',
  'complete',
  'preview_limited',
  'interrupted',
  'quota_limited',
  'expired',
  'deleted',
] as const;
export type Completeness = (typeof COMPLETENESS)[number];

export const EXPORT_STATUSES = ['generating', 'ready', 'failed', 'expired', 'deleted'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

export const APPROVAL_STATUSES = ['pending', 'active', 'expired', 'revoked', 'denied'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const AUDIT_OUTCOMES = ['succeeded', 'accepted', 'pending', 'denied', 'failed'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/** The authenticated caller of one request. Built from a validated token in step 2. */
export interface Actor {
  /** Stable Keycloak subject. */
  subject: string;
  username: string;
  displayName: string;
  roles: readonly Role[];
  source: Source;
  /** OAuth client that obtained the token. */
  clientId: string;
  /** Set for MCP calls: the profile bound to `clientId`. */
  profileId?: string;
  /** Expiry of the access token that authenticated this request (ISO-8601). */
  expiresAt?: string;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Connection as returned by every interface: never contains the password. */
export interface ConnectionView {
  id: string;
  owner: string;
  name: string;
  engine: Engine;
  environment: Environment;
  host: string;
  port: number;
  database: string;
  schema: string | null;
  username: string;
  hasPassword: boolean;
  tlsMode: TlsMode;
  hasCustomCa: boolean;
  /** Separate account for monitoring queries, when configured. */
  monitorUsername: string | null;
  readOnly: boolean;
  enabled: boolean;
  transport: 'direct';
  lastTestAt: string | null;
  lastTestResult: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileView {
  id: string;
  owner: string;
  name: string;
  clientId: string;
  connectionIds: string[];
  readOnly: boolean;
  enabled: boolean;
  timeoutMs: number;
  previewRows: number;
  previewBytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface FolderView {
  id: string;
  owner: string;
  parentId: string | null;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface SavedQueryView {
  id: string;
  owner: string;
  folderId: string | null;
  name: string;
  sql: string;
  defaultConnectionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEventView {
  id: number;
  at: string;
  actorSubject: string | null;
  actorLabel: string;
  source: Source | 'server';
  profileId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  outcome: AuditOutcome;
  details: Record<string, unknown>;
}
