import { z } from 'zod';
import { ERROR_CODES, type Config } from '@workbench/core';
import type { RouteRegistry } from './routes/registry.js';

const jsonSchema = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { target: 'openapi-3.0', io: 'input', unrepresentable: 'any' });

/** OpenAPI 3.0 document built from the route registry and the zod schemas the services validate with. */
export function openApiDocument(registry: RouteRegistry, config: Config, version: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of registry.routes) {
    const path = `/api/v1${route.url.replace(/:(\w+)/g, '{$1}')}`;
    const parameters: unknown[] = [...route.url.matchAll(/:(\w+)/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    if (route.query) {
      const q = jsonSchema(route.query) as { properties?: Record<string, unknown>; required?: string[] };
      for (const [name, schema] of Object.entries(q.properties ?? {})) {
        parameters.push({ name, in: 'query', required: q.required?.includes(name) ?? false, schema });
      }
    }
    const status = String(route.status ?? 200);
    (paths[path] ??= {})[route.method.toLowerCase()] = {
      summary: route.summary,
      tags: [route.tag],
      description: `Access: ${route.access}.`,
      security: [{ bearer: [] }],
      ...(parameters.length ? { parameters } : {}),
      ...(route.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: jsonSchema(route.body) } },
            },
          }
        : {}),
      responses: {
        [status]: { description: route.produces ? `Success (${route.produces})` : 'Success' },
        default: {
          description: 'Error',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
    };
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'Database Workbench API',
      version,
      description:
        'Bearer tokens from Keycloak client workbench-gui (audience workbench-api). Errors use stable codes; messages are for people.',
    },
    servers: [{ url: config.publicUrl }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: {
        Error: {
          type: 'object',
          required: ['error', 'message', 'requestId'],
          properties: {
            error: { type: 'string', enum: Object.keys(ERROR_CODES) },
            message: { type: 'string' },
            details: { type: 'object' },
            requestId: { type: 'string' },
          },
        },
      },
    },
    paths,
  };
}
