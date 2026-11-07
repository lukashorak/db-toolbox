import { resolve } from 'node:path';
import { z } from 'zod';

/** Thrown when the environment does not describe a valid deployment. Messages never contain values. */
export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export interface Limits {
  /** Total preview boundary per result, not a page size. */
  previewRows: number;
  /** MCP preview allowance per execution, across result sets, pages and calls. */
  mcpPreviewRows: number;
  mcpPreviewBytes: number;
  /** Capture budget for one execution. */
  maxResultBytes: number;
  /** Capture budget for all retained results. */
  maxTotalBytes: number;
  /** Running executions per stored connection; further work queues (GUI and MCP share the slots). */
  concurrencyPerConnection: number;
  ordinaryTimeoutMs: number;
  fullTimeoutMaxMs: number;
}

export interface Config {
  env: 'development' | 'test' | 'production';
  /** Origin users reach, without a trailing slash, for example https://db.example.com */
  publicUrl: string;
  keycloakIssuer: string;
  guiClientId: string;
  mcpClientId: string;
  apiAudience: string;
  /** Token audience required for MCP calls: `${publicUrl}/mcp`. */
  mcpAudience: string;
  /** 32-byte key for credential encryption. Never logged or returned. */
  encryptionKey: Buffer;
  host: string;
  port: number;
  dataDir: string;
  exportDir: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  trustProxy: boolean;
  /** On SIGTERM, how long running executions may finish before they are interrupted. */
  shutdownGraceMs: number;
  limits: Limits;
}

type Env = Record<string, string | undefined>;

const REQUIRED = ['PUBLIC_URL', 'KEYCLOAK_ISSUER', 'ENCRYPTION_KEY'] as const;

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PUBLIC_URL: z.string(),
  KEYCLOAK_ISSUER: z.string(),
  ENCRYPTION_KEY: z.string(),
  GUI_CLIENT_ID: z.string().min(1).default('workbench-gui'),
  MCP_CLIENT_ID: z.string().min(1).default('workbench-mcp'),
  API_AUDIENCE: z.string().min(1).default('workbench-api'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATA_DIR: z.string().min(1).default('./data'),
  EXPORT_DIR: z.string().min(1).default('./exports'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  PREVIEW_ROWS: positiveInt(1000),
  MCP_PREVIEW_ROWS: positiveInt(1000),
  MCP_PREVIEW_BYTES: positiveInt(256 * 1024),
  MAX_RESULT_BYTES: positiveInt(100 * 1024 * 1024),
  MAX_TOTAL_BYTES: positiveInt(1024 * 1024 * 1024),
  CONCURRENCY_PER_CONNECTION: positiveInt(2),
  ORDINARY_TIMEOUT_MS: positiveInt(30_000),
  FULL_TIMEOUT_MAX_MS: positiveInt(300_000),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(600_000).default(20_000),
});

function parseOrigin(name: string, value: string, requireHttps: boolean, issues: string[]): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    issues.push(`${name} must be an absolute URL`);
    return '';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') issues.push(`${name} must use http or https`);
  else if (requireHttps && url.protocol !== 'https:') issues.push(`${name} must use https in production`);
  if (url.pathname !== '/' || url.search || url.hash) issues.push(`${name} must be an origin without a path`);
  if (url.username || url.password) issues.push(`${name} must not contain credentials`);
  return url.origin;
}

function parseIssuer(value: string, requireHttps: boolean, issues: string[]): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    issues.push('KEYCLOAK_ISSUER must be an absolute URL');
    return '';
  }
  if (requireHttps && url.protocol !== 'https:') issues.push('KEYCLOAK_ISSUER must use https in production');
  if (!/\/realms\/[^/]+$/.test(url.pathname.replace(/\/$/, ''))) {
    issues.push(
      'KEYCLOAK_ISSUER must point at a realm, for example https://auth.example.com/realms/workbench',
    );
  }
  return value.replace(/\/$/, '');
}

function parseKey(value: string, issues: string[]): Buffer {
  const key = Buffer.from(value, 'base64');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || key.length !== 32) {
    issues.push('ENCRYPTION_KEY must be 32 random bytes encoded as base64');
  }
  return key;
}

/**
 * Reads and validates the deployment configuration. All problems are reported at once and
 * no message echoes a value, so secrets cannot leak into startup logs.
 */
export function loadConfig(env: Env, cwd: string = process.cwd()): Config {
  const issues: string[] = [];
  for (const name of REQUIRED) {
    if (!env[name] || !env[name]?.trim()) issues.push(`${name} is required`);
  }
  if (issues.length) throw new ConfigError(issues);

  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || 'environment'} is invalid (${issue.code})`,
      ),
    );
  }
  const e = parsed.data;
  const production = e.NODE_ENV === 'production';
  const publicUrl = parseOrigin('PUBLIC_URL', e.PUBLIC_URL.trim(), production, issues);
  const keycloakIssuer = parseIssuer(e.KEYCLOAK_ISSUER.trim(), production, issues);
  const encryptionKey = parseKey(e.ENCRYPTION_KEY.trim(), issues);
  if (e.FULL_TIMEOUT_MAX_MS < e.ORDINARY_TIMEOUT_MS) {
    issues.push('FULL_TIMEOUT_MAX_MS must not be lower than ORDINARY_TIMEOUT_MS');
  }
  if (e.MAX_TOTAL_BYTES < e.MAX_RESULT_BYTES)
    issues.push('MAX_TOTAL_BYTES must not be lower than MAX_RESULT_BYTES');
  if (issues.length) throw new ConfigError(issues);

  return {
    env: e.NODE_ENV,
    publicUrl,
    keycloakIssuer,
    guiClientId: e.GUI_CLIENT_ID,
    mcpClientId: e.MCP_CLIENT_ID,
    apiAudience: e.API_AUDIENCE,
    mcpAudience: `${publicUrl}/mcp`,
    encryptionKey,
    host: e.HOST,
    port: e.PORT,
    dataDir: resolve(cwd, e.DATA_DIR),
    exportDir: resolve(cwd, e.EXPORT_DIR),
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY === 'true',
    shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
    limits: {
      previewRows: e.PREVIEW_ROWS,
      mcpPreviewRows: e.MCP_PREVIEW_ROWS,
      mcpPreviewBytes: e.MCP_PREVIEW_BYTES,
      maxResultBytes: e.MAX_RESULT_BYTES,
      maxTotalBytes: e.MAX_TOTAL_BYTES,
      concurrencyPerConnection: e.CONCURRENCY_PER_CONNECTION,
      ordinaryTimeoutMs: e.ORDINARY_TIMEOUT_MS,
      fullTimeoutMaxMs: e.FULL_TIMEOUT_MAX_MS,
    },
  };
}
