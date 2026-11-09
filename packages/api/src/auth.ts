import type { FastifyRequest } from 'fastify';
import { AppError, type Actor } from '@workbench/core';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the authentication hook on protected routes. */
    actor: Actor | null;
  }
}

/** The authenticated actor of a protected route; a missing actor is a wiring bug, not a 401. */
export function actorOf(request: FastifyRequest): Actor {
  if (!request.actor) throw new AppError('internal', 'Route is missing authentication.');
  return request.actor;
}
