export { ConfigError, loadConfig, type Config, type Limits } from './config.js';
export { createLogger, REDACT_PATHS, REDACTED, type Logger } from './logger.js';
export { checkDatabase, checkExportDir, checkReadiness, type CheckResult, type Readiness } from './health.js';
export { createCore, verifyEncryptionKey, type Core, type CoreOptions } from './core.js';
export { AuditLog, redactDetails, type AuditQuery, type AuditRecord } from './audit.js';
export { AppError, ERROR_CODES, type ErrorCode } from './domain/errors.js';
export { ID_PATTERN, ID_PREFIXES, newId, type IdKind } from './domain/ids.js';
export * from './domain/types.js';
export {
  can,
  evaluateWritePolicy,
  permissionsOf,
  PERMISSIONS,
  requirePermission,
  ROLE_PERMISSIONS,
  type Permission,
  type PolicyLayer,
  type PolicyLayerName,
  type WritePolicy,
} from './security/policy.js';
export { SecretBox } from './security/secrets.js';
export { Database, DATABASE_FILE } from './store/database.js';
export { MIGRATIONS } from './store/migrations.js';
export type {
  ConnectionReferences,
  CreateConnectionInput,
  UpdateConnectionInput,
} from './services/connections.js';
export type { CreateProfileInput, EffectiveAccess, UpdateProfileInput } from './services/profiles.js';
export type {
  CreateFolderInput,
  CreateQueryInput,
  UpdateFolderInput,
  UpdateQueryInput,
} from './services/library.js';
export type { ExecutionDefaults } from './services/settings.js';
export type { ConnectionDraft } from './services/databases.js';
export { Authenticator } from './identity/authenticator.js';
export { buildRealm, type RealmOptions } from './identity/realm.js';
export {
  TokenVerifier,
  type Channel,
  type TokenVerifierOptions,
  type VerifiedToken,
} from './identity/tokens.js';
export { splitStatements, lineIndex, type SourceRange, type SplitStatement } from './sql/split.js';
export { analyzeScript, analyzeStatement } from './sql/analyze.js';
export {
  preflight,
  type PreflightCode,
  type PreflightOptions,
  type PreflightProblem,
  type TransactionMode,
} from './sql/preflight.js';
export type {
  AnalyzedStatement,
  StatementAnalysis,
  StatementKind,
  TableRef,
  TransactionControl,
} from './sql/types.js';
export { DbError, mapDbError, type DbErrorCategory, type DbErrorPosition } from './db/errors.js';
export { AdapterRegistry, DirectTransport, type RegistryOptions } from './db/registry.js';
export {
  testConnection,
  type Capability,
  type ConnectionTestReport,
  type TestFailureCategory,
  type TestStep,
} from './db/connection-test.js';
export { describeTls } from './db/tls.js';
export type * from './db/metadata.js';
export type {
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
  Transport,
} from './db/types.js';
export {
  ExecutionService,
  type ExecutionOptions,
  type ExecutionView,
  type ResultSetView,
  type StatementView,
  type SubmitInput,
} from './execution/service.js';
