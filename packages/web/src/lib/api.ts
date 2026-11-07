import { accessToken, SessionLostError } from './auth';

/** An error from the API, with its stable code (see docs/api.md). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> | undefined,
    readonly requestId: string | undefined,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let onUnauthorized: () => void = () => undefined;
export function whenUnauthorized(handler: () => void): void {
  onUnauthorized = handler;
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let token: string;
  try {
    token = await accessToken();
  } catch (error) {
    if (error instanceof SessionLostError) onUnauthorized();
    throw error;
  }
  const response = await fetch(`/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 204) return undefined as T;
  const data = (await response.json().catch(() => null)) as {
    error?: string;
    message?: string;
    details?: Record<string, unknown>;
    requestId?: string;
  } | null;
  if (!response.ok) {
    if (response.status === 401) onUnauthorized();
    throw new ApiError(
      response.status,
      data?.error ?? 'internal',
      data?.message ?? `Request failed (${response.status}).`,
      data?.details,
      data?.requestId,
    );
  }
  return data as T;
}
