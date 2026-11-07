import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError, DbError, ERROR_CODES, type Config, type ErrorCode } from '@workbench/core';
import { MCP_PATH } from '@workbench/mcp';

export interface ErrorBody {
  error: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  requestId: string;
}

/** Codes for which a client should obtain a new token rather than give up. */
const TOKEN_ERRORS = new Set<ErrorCode>(['invalid_token', 'token_expired', 'wrong_audience', 'wrong_client']);

const quote = (value: string) => `"${value.replace(/["\\]/g, '')}"`;

/**
 * RFC 6750 challenge. For MCP it also carries the protected resource metadata URL (RFC 9728), which
 * is how Claude Code discovers that it must sign in through Keycloak.
 */
export function bearerChallenge(config: Config, isMcp: boolean, error?: AppError): string {
  const parts = ['Bearer realm="workbench"'];
  if (isMcp) {
    parts.push(
      `resource_metadata=${quote(`${config.publicUrl}/.well-known/oauth-protected-resource${MCP_PATH}`)}`,
    );
  }
  if (error && TOKEN_ERRORS.has(error.code)) {
    parts.push('error="invalid_token"', `error_description=${quote(error.message)}`);
  }
  return parts.join(', ');
}

export function sendError(
  config: Config,
  request: FastifyRequest,
  reply: FastifyReply,
  error: AppError,
  status: number = error.status,
) {
  if (status === 401) {
    reply.header('www-authenticate', bearerChallenge(config, request.url.split('?')[0] === MCP_PATH, error));
  }
  if (error.code === 'rate_limited')
    reply.header('retry-after', String(error.details?.retryAfterSeconds ?? 60));
  const body: ErrorBody = { error: error.code, message: error.message, requestId: String(request.id) };
  if (error.details) body.details = error.details;
  return reply.code(status).send(body);
}

/**
 * Single error model for the API: stable codes from core, a request ID for support, and no
 * internal detail (SQL, stack traces, credentials) for unexpected failures.
 */
export function installErrorHandler(app: FastifyInstance, config: Config): void {
  app.setErrorHandler((error: FastifyError | AppError | DbError, request, reply) => {
    if (error instanceof AppError) {
      if (error.status >= 500) request.log.error({ err: error }, 'request failed');
      return sendError(config, request, reply, error);
    }
    if (error instanceof DbError) {
      return sendError(
        config,
        request,
        reply,
        new AppError('database_error', error.message, { ...error.toJSON(), message: undefined }),
      );
    }
    const fastifyError = error as FastifyError;
    if (fastifyError.validation) {
      return sendError(
        config,
        request,
        reply,
        new AppError('validation_failed', 'The request is invalid.', {
          fields: fastifyError.validation.map((v) => ({ path: v.instancePath, message: v.message })),
        }),
      );
    }
    const status = fastifyError.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      const code: ErrorCode = status === 405 ? 'method_not_allowed' : 'bad_request';
      return sendError(config, request, reply, new AppError(code, fastifyError.message), status);
    }
    request.log.error({ err: error }, 'request failed');
    return sendError(
      config,
      request,
      reply,
      new AppError('internal', 'Something went wrong. Quote the request ID when reporting it.'),
      ERROR_CODES.internal,
    );
  });
}
