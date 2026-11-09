import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, type Actor } from '@workbench/core';
import { actorOf } from '../auth.js';

export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface RouteContext<B, Q> {
  actor: Actor;
  params: Record<string, string>;
  query: Q;
  body: B;
  request: FastifyRequest;
  reply: FastifyReply;
}

export interface RouteSpec<B = unknown, Q = Record<string, unknown>> {
  method: Method;
  /** Path below /api/v1, with :params. */
  url: string;
  summary: string;
  tag: string;
  /** Roles or permissions needed, for the documentation (the services enforce them). */
  access: string;
  body?: z.ZodType<B>;
  query?: z.ZodType<Q>;
  /** Success status (default 200). */
  status?: number;
  /** For responses that are not JSON. */
  produces?: string;
  handler: (ctx: RouteContext<B, Q>) => unknown;
}

/** Collects routes so the same definitions serve Fastify and the OpenAPI document. */
export class RouteRegistry {
  readonly routes: RouteSpec<unknown, Record<string, unknown>>[] = [];

  add<B, Q extends Record<string, unknown>>(spec: RouteSpec<B, Q>): void {
    this.routes.push(spec as unknown as RouteSpec<unknown, Record<string, unknown>>);
  }

  register(app: FastifyInstance): void {
    for (const spec of this.routes) {
      app.route({
        method: spec.method,
        url: spec.url,
        handler: async (request, reply) => {
          const body = spec.body ? parse(spec.body, request.body ?? {}, 'body') : request.body;
          const query = spec.query
            ? parse(spec.query, request.query ?? {}, 'query')
            : (request.query as Record<string, unknown>);
          const result = await spec.handler({
            actor: actorOf(request),
            params: request.params as Record<string, string>,
            query,
            body,
            request,
            reply,
          });
          if (reply.sent) return reply;
          if (spec.status) reply.code(spec.status);
          if (result === undefined) return reply.code(204).send();
          return result;
        },
      });
    }
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, where: 'body' | 'query'): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new AppError('validation_failed', 'The request is invalid.', {
    fields: result.error.issues.map((i) => ({ path: [where, ...i.path].join('.'), message: i.message })),
  });
}
