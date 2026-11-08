import type { z } from 'zod';
import { AppError } from '../domain/errors.js';

/** One problem with one field: the same shape as the API's own request validation. */
export interface FieldProblem {
  path: string;
  message: string;
}

/** Parses input with a zod schema and turns problems into one `validation_failed` error with per-field messages. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields: FieldProblem[] = [];
  for (const issue of result.error.issues) {
    const path = issue.path.join('.') || '_';
    if (!fields.some((f) => f.path === path)) fields.push({ path, message: issue.message });
  }
  throw new AppError('validation_failed', 'Some fields are invalid.', { fields });
}

export const fieldError = (field: string, message: string): AppError =>
  new AppError('validation_failed', 'Some fields are invalid.', { fields: [{ path: field, message }] });

const HOSTNAME =
  /^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV6 = /^[0-9A-Fa-f:.]+$/;

/** A host name or IP address, without scheme, port, path or credentials. */
export const isHost = (value: string): boolean =>
  HOSTNAME.test(value) || (value.includes(':') && IPV6.test(value));

export const isPemCertificate = (value: string): boolean =>
  /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(value);
