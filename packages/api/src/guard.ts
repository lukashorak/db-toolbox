import type { FastifyRequest } from 'fastify';
import { AppError, type Actor, type Authenticator, type Config } from '@workbench/core';
import { RateLimiter } from './rate-limit.js';

/**
 * Authentication with rate limits: rejected tokens count against the client address (so token
 * guessing and verification load are bounded), accepted requests against the user, or the user
 * and MCP client. Each verification reserves one of the address's failure allowance before it
 * starts and gives it back when the token is accepted, so concurrent requests cannot all start
 * verifying on the same allowance.
 */
export class RequestGuard {
  readonly #api: RateLimiter;
  readonly #mcp: RateLimiter;
  readonly #failures: RateLimiter;

  constructor(
    private readonly authenticator: Authenticator,
    limits: Config['rateLimits'],
    now?: () => number,
  ) {
    this.#api = new RateLimiter(limits.apiPerMinute, now);
    this.#mcp = new RateLimiter(limits.mcpPerMinute, now);
    this.#failures = new RateLimiter(limits.authFailuresPerMinute, now);
  }

  async authenticate(request: FastifyRequest, kind: 'gui' | 'mcp'): Promise<Actor> {
    const address = request.ip;
    const wait = this.#failures.wait(address);
    if (wait > 0) {
      throw new AppError(
        'rate_limited',
        `Too many rejected sign-ins from this address. Try again in ${wait} s.`,
        {
          retryAfterSeconds: wait,
        },
      );
    }
    // Same tick as wait(): a token is there to reserve.
    this.#failures.take(address, 'rejected sign-ins');
    let actor: Actor;
    try {
      actor = await this.authenticator.authenticate(request.headers.authorization, kind);
    } catch (error) {
      // A rejected token keeps its reservation; any other failure (the identity provider
      // unreachable, say) is not the client's and gives it back.
      if (!(error instanceof AppError && error.status === 401)) this.#failures.refund(address);
      throw error;
    }
    this.#failures.refund(address);
    if (kind === 'mcp') this.#mcp.take(`${actor.subject} ${actor.clientId}`, 'MCP requests');
    else this.#api.take(actor.subject, 'requests');
    return actor;
  }
}
