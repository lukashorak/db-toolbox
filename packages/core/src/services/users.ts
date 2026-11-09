import type { Actor } from '../domain/types.js';
import { isoNow, type ServiceContext } from './context.js';

/**
 * Keeps a record of every authenticated subject so that owners and actors in history stay
 * resolvable. Identity itself is managed in Keycloak.
 */
export class UserService {
  constructor(private readonly ctx: ServiceContext) {}

  /** Called once per authenticated request; inserts the user or refreshes name and last seen. */
  touch(actor: Actor, email?: string | null): void {
    const now = isoNow(this.ctx);
    this.ctx.db.run(
      `INSERT INTO users (subject, username, display_name, email, first_seen_at, last_seen_at)
       VALUES (:subject, :username, :display, :email, :now, :now)
       ON CONFLICT (subject) DO UPDATE SET username = excluded.username, display_name = excluded.display_name,
         email = coalesce(excluded.email, users.email), last_seen_at = excluded.last_seen_at`,
      {
        subject: actor.subject,
        username: actor.username,
        display: actor.displayName || actor.username,
        email: email ?? null,
        now,
      },
    );
  }

  get(subject: string): { subject: string; username: string; displayName: string } | undefined {
    const row = this.ctx.db.get(
      'SELECT subject, username, display_name FROM users WHERE subject = :subject',
      {
        subject,
      },
    );
    return row
      ? {
          subject: String(row.subject),
          username: String(row.username),
          displayName: String(row.display_name),
        }
      : undefined;
  }
}
