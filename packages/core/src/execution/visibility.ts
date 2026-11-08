import type { Actor } from '../domain/types.js';
import { can } from '../security/policy.js';
import type { Database, Row } from '../store/database.js';

/**
 * Who may see an execution (and its results, exports and disclosure): its owner, and
 * administrators in the GUI or API. An MCP client sees only its user's executions on connections
 * its profile allows now, so removing a connection from a profile also closes its results.
 */
export function canSeeExecution(db: Database, actor: Actor, execution: Row): boolean {
  if (execution.owner !== actor.subject) return actor.source !== 'mcp' && can(actor, 'connections.manage');
  if (actor.source !== 'mcp') return true;
  if (!actor.profileId || !execution.connection_id) return false;
  const allowed = db.get(
    `SELECT 1 AS ok FROM mcp_profiles p JOIN mcp_profile_connections pc ON pc.profile_id = p.id
      WHERE p.id = :profile AND p.client_id = :client AND p.enabled = 1 AND pc.connection_id = :connection`,
    { profile: actor.profileId, client: actor.clientId, connection: String(execution.connection_id) },
  );
  return Boolean(allowed);
}
