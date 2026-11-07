/**
 * Stable error codes shared by the API and MCP. Clients branch on `code`; messages are for people
 * and may change. New codes are added here, never invented at the call site.
 */
export const ERROR_CODES = {
  validation_failed: 400,
  /** MCP asked for more than its allowance; a human must approve in the GUI. */
  approval_required: 403,
  /** The script was rejected before it ran; the stored execution is in `details.execution`. */
  preflight_rejected: 422,
  /** As preflight_rejected, when a read-only policy is the reason. */
  read_only_policy: 422,
  /** Malformed HTTP request (bad JSON, wrong media type, too large); the HTTP status says which. */
  bad_request: 400,
  unauthenticated: 401,
  invalid_token: 401,
  token_expired: 401,
  wrong_audience: 401,
  wrong_client: 401,
  no_role: 403,
  profile_unknown: 403,
  profile_disabled: 403,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  name_conflict: 409,
  client_id_conflict: 409,
  connection_busy: 409,
  connection_disabled: 409,
  engine_immutable: 409,
  folder_cycle: 409,
  idempotency_conflict: 409,
  result_expired: 410,
  export_not_ready: 409,
  not_complete: 409,
  export_missing: 410,
  exports_unavailable: 503,
  secret_unreadable: 500,
  encryption_key_mismatch: 500,
  /** The target database reported an error; `details.category` says which kind. */
  database_error: 502,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_CODES[code];
    this.details = details;
  }
}

export function assert(
  condition: unknown,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): asserts condition {
  if (!condition) throw new AppError(code, message, details);
}
