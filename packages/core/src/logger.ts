import { pino, type DestinationStream, type Logger } from 'pino';

export type { Logger } from 'pino';

/**
 * Fields that must never reach logs: credentials, tokens, keys, SQL parameters and result data.
 * SQL text is application data too; log execution IDs instead of statements.
 */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'authorization',
  '*.authorization',
  'cookie',
  '*.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'encryptionKey',
  '*.encryptionKey',
  'secret',
  '*.secret',
  'params',
  '*.params',
  'sql',
  '*.sql',
  'rows',
  '*.rows',
];

export const REDACTED = '[redacted]';

export function createLogger(options: { level: string; destination?: DestinationStream }): Logger {
  return pino(
    {
      level: options.level,
      base: { service: 'database-workbench' },
      redact: { paths: REDACT_PATHS, censor: REDACTED },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    options.destination,
  );
}
