import type { z } from 'zod';
import { AppError } from '../domain/errors.js';

/** Parses input with a zod schema and turns problems into one `validation_failed` error with per-field messages. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_';
    fields[key] ??= issue.message;
  }
  throw new AppError('validation_failed', 'Some fields are invalid.', { fields });
}

export const fieldError = (field: string, message: string): AppError =>
  new AppError('validation_failed', 'Some fields are invalid.', { fields: { [field]: message } });

const HOSTNAME =
  /^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV6 = /^[0-9A-Fa-f:.]+$/;

/** A host name or IP address, without scheme, port, path or credentials. */
export const isHost = (value: string): boolean =>
  HOSTNAME.test(value) || (value.includes(':') && IPV6.test(value));

export const isPemCertificate = (value: string): boolean =>
  /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(value);
