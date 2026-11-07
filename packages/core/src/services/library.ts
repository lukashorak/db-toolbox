import { z } from 'zod';
import { AppError, assert } from '../domain/errors.js';
import { newId } from '../domain/ids.js';
import type { Actor, FolderView, SavedQueryView } from '../domain/types.js';
import { requirePermission } from '../security/policy.js';
import type { Row } from '../store/database.js';
import { isoNow, type ServiceContext } from './context.js';
import { fieldError, parseInput } from './validation.js';

const name = z.string().trim().min(1, 'Enter a name.').max(80, 'Use 80 characters or fewer.');
const folderName = name.refine((v) => !v.includes('/'), 'Folder names cannot contain “/”.');
const id = z.string().min(1);

const folderCreate = z
  .object({ name: folderName, parentId: id.nullable().optional().default(null) })
  .strict();
const folderUpdate = z.object({ name: folderName, parentId: id.nullable() }).partial().strict();
const queryCreate = z
  .object({
    name,
    folderId: id.nullable().optional().default(null),
    sql: z.string().max(1_000_000),
    defaultConnectionId: id.nullable().optional().default(null),
  })
  .strict();
const queryUpdate = z
  .object({
    name,
    folderId: id.nullable(),
    sql: z.string().max(1_000_000),
    defaultConnectionId: id.nullable(),
  })
  .partial()
  .strict();

export type CreateFolderInput = z.input<typeof folderCreate>;
export type UpdateFolderInput = z.input<typeof folderUpdate>;
export type CreateQueryInput = z.input<typeof queryCreate>;
export type UpdateQueryInput = z.input<typeof queryUpdate>;

const folderView = (r: Row): FolderView => ({
  id: String(r.id),
  owner: String(r.owner),
  parentId: (r.parent_id as string | null) ?? null,
  name: String(r.name),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

const queryView = (r: Row): SavedQueryView => ({
  id: String(r.id),
  owner: String(r.owner),
  folderId: (r.folder_id as string | null) ?? null,
  name: String(r.name),
  sql: String(r.sql),
  defaultConnectionId: (r.default_connection_id as string | null) ?? null,
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

/**
 * Saved queries in nested folders, owned per user. Saving is an application change, so it needs
 * `queries.manage` only — a read-only database user can save. Editing a query never touches the
 * SQL snapshots stored with executions.
 */
export class LibraryService {
  constructor(private readonly ctx: ServiceContext) {}

  folders(actor: Actor): FolderView[] {
    requirePermission(actor, 'queries.manage');
    return this.ctx.db
      .all('SELECT * FROM folders WHERE owner = :owner ORDER BY lower(name)', { owner: actor.subject })
      .map(folderView);
  }

  /** Lists queries, optionally inside a folder and its subfolders, filtered by name. */
  queries(actor: Actor, filter: { folderId?: string | null; search?: string } = {}): SavedQueryView[] {
    requirePermission(actor, 'queries.manage');
    let rows = this.ctx.db
      .all('SELECT * FROM saved_queries WHERE owner = :owner ORDER BY lower(name)', { owner: actor.subject })
      .map(queryView);
    if (filter.folderId !== undefined) {
      const scope = filter.folderId === null ? null : new Set(this.subtree(actor, filter.folderId));
      rows = rows.filter((q) =>
        scope === null ? q.folderId === null : q.folderId !== null && scope.has(q.folderId),
      );
    }
    const term = filter.search?.trim().toLowerCase();
    if (term) rows = rows.filter((q) => q.name.toLowerCase().includes(term));
    return rows;
  }

  query(actor: Actor, queryId: string): SavedQueryView {
    requirePermission(actor, 'queries.manage');
    return queryView(this.queryRow(actor, queryId));
  }

  /** Human-readable path such as “Analytics / Revenue”. */
  folderPath(actor: Actor, folderId: string | null): string {
    if (!folderId) return 'Unfiled';
    const names: string[] = [];
    let current: string | null = folderId;
    for (let guard = 0; current && guard < 64; guard++) {
      const row = this.folderRow(actor, current);
      names.unshift(String(row.name));
      current = (row.parent_id as string | null) ?? null;
    }
    return names.join(' / ');
  }

  createFolder(actor: Actor, input: CreateFolderInput): FolderView {
    requirePermission(actor, 'queries.manage');
    const v = parseInput(folderCreate, input);
    if (v.parentId) this.folderRow(actor, v.parentId);
    const folderId = newId('folder', this.ctx.clock.now());
    this.ctx.db.transaction(() => {
      this.assertFolderNameFree(actor, v.parentId, v.name);
      this.ctx.db.run(
        `INSERT INTO folders (id, owner, parent_id, name, created_at, updated_at) VALUES (:id, :owner, :parent, :name, :now, :now)`,
        { id: folderId, owner: actor.subject, parent: v.parentId, name: v.name, now: isoNow(this.ctx) },
      );
      this.audit(actor, 'folder.create', 'folder', folderId, v.name);
    });
    return folderView(this.folderRow(actor, folderId));
  }

  updateFolder(actor: Actor, folderId: string, input: UpdateFolderInput): FolderView {
    requirePermission(actor, 'queries.manage');
    const v = parseInput(folderUpdate, input);
    const before = folderView(this.folderRow(actor, folderId));
    const parentId = v.parentId === undefined ? before.parentId : v.parentId;
    const newName = v.name ?? before.name;
    if (parentId) {
      this.folderRow(actor, parentId);
      if (this.subtree(actor, folderId).includes(parentId)) {
        throw new AppError('folder_cycle', 'A folder cannot move into itself or one of its subfolders.');
      }
    }
    this.ctx.db.transaction(() => {
      if (parentId !== before.parentId || newName.toLowerCase() !== before.name.toLowerCase()) {
        this.assertFolderNameFree(actor, parentId, newName, folderId);
      }
      this.ctx.db.run(
        'UPDATE folders SET name = :name, parent_id = :parent, updated_at = :now WHERE id = :id',
        {
          id: folderId,
          name: newName,
          parent: parentId,
          now: isoNow(this.ctx),
        },
      );
      this.audit(
        actor,
        parentId !== before.parentId ? 'folder.move' : 'folder.rename',
        'folder',
        folderId,
        newName,
      );
    });
    return folderView(this.folderRow(actor, folderId));
  }

  /**
   * Deletes a folder. `move-to-parent` keeps its contents one level up; `delete-contents` removes
   * subfolders and queries too. Execution history is never deleted with saved queries.
   */
  deleteFolder(
    actor: Actor,
    folderId: string,
    mode: 'move-to-parent' | 'delete-contents',
  ): { movedQueries: number; deletedQueries: number; folders: number } {
    requirePermission(actor, 'queries.manage');
    const folder = folderView(this.folderRow(actor, folderId));
    const tree = this.subtree(actor, folderId);
    return this.ctx.db.transaction(() => {
      const owner = actor.subject;
      if (mode === 'move-to-parent') {
        const children = this.ctx.db.all(
          'SELECT id, name FROM folders WHERE owner = :owner AND parent_id = :id',
          {
            owner,
            id: folderId,
          },
        );
        const queries = this.ctx.db.all(
          'SELECT id, name FROM saved_queries WHERE owner = :owner AND folder_id = :id',
          {
            owner,
            id: folderId,
          },
        );
        for (const c of children)
          this.assertFolderNameFree(actor, folder.parentId, String(c.name), String(c.id));
        for (const q of queries)
          this.assertQueryNameFree(actor, folder.parentId, String(q.name), String(q.id));
        this.ctx.db.run('UPDATE folders SET parent_id = :parent WHERE owner = :owner AND parent_id = :id', {
          owner,
          id: folderId,
          parent: folder.parentId,
        });
        this.ctx.db.run(
          'UPDATE saved_queries SET folder_id = :parent WHERE owner = :owner AND folder_id = :id',
          {
            owner,
            id: folderId,
            parent: folder.parentId,
          },
        );
        this.ctx.db.run('DELETE FROM folders WHERE id = :id', { id: folderId });
        this.audit(actor, 'folder.delete', 'folder', folderId, folder.name, {
          mode,
          movedQueries: queries.length,
        });
        return { movedQueries: queries.length, deletedQueries: 0, folders: 1 };
      }
      const placeholders = tree.map((_, i) => `:f${i}`).join(', ');
      const params = Object.fromEntries(tree.map((f, i) => [`f${i}`, f]));
      const deleted = this.ctx.db.run(
        `DELETE FROM saved_queries WHERE folder_id IN (${placeholders})`,
        params,
      ).changes;
      for (const f of [...tree].reverse()) this.ctx.db.run('DELETE FROM folders WHERE id = :id', { id: f });
      this.audit(actor, 'folder.delete', 'folder', folderId, folder.name, {
        mode,
        deletedQueries: deleted,
        folders: tree.length,
      });
      return { movedQueries: 0, deletedQueries: deleted, folders: tree.length };
    });
  }

  createQuery(actor: Actor, input: CreateQueryInput): SavedQueryView {
    requirePermission(actor, 'queries.manage');
    const v = parseInput(queryCreate, input);
    if (v.folderId) this.folderRow(actor, v.folderId);
    if (v.defaultConnectionId) this.assertConnection(v.defaultConnectionId);
    const queryId = newId('query', this.ctx.clock.now());
    this.ctx.db.transaction(() => {
      this.assertQueryNameFree(actor, v.folderId, v.name);
      this.ctx.db.run(
        `INSERT INTO saved_queries (id, owner, folder_id, name, sql, default_connection_id, created_at, updated_at)
         VALUES (:id, :owner, :folder, :name, :sql, :conn, :now, :now)`,
        {
          id: queryId,
          owner: actor.subject,
          folder: v.folderId,
          name: v.name,
          sql: v.sql,
          conn: v.defaultConnectionId,
          now: isoNow(this.ctx),
        },
      );
      this.audit(actor, 'query.create', 'saved_query', queryId, v.name, {
        folder: this.folderPath(actor, v.folderId),
      });
    });
    return this.query(actor, queryId);
  }

  updateQuery(actor: Actor, queryId: string, input: UpdateQueryInput): SavedQueryView {
    requirePermission(actor, 'queries.manage');
    const v = parseInput(queryUpdate, input);
    const before = queryView(this.queryRow(actor, queryId));
    const folderId = v.folderId === undefined ? before.folderId : v.folderId;
    const newName = v.name ?? before.name;
    if (folderId) this.folderRow(actor, folderId);
    if (v.defaultConnectionId) this.assertConnection(v.defaultConnectionId);
    this.ctx.db.transaction(() => {
      if (folderId !== before.folderId || newName.toLowerCase() !== before.name.toLowerCase()) {
        this.assertQueryNameFree(actor, folderId, newName, queryId);
      }
      this.ctx.db.run(
        `UPDATE saved_queries SET name = :name, folder_id = :folder, sql = :sql, default_connection_id = :conn, updated_at = :now
         WHERE id = :id`,
        {
          id: queryId,
          name: newName,
          folder: folderId,
          sql: v.sql ?? before.sql,
          conn: v.defaultConnectionId === undefined ? before.defaultConnectionId : v.defaultConnectionId,
          now: isoNow(this.ctx),
        },
      );
      const action =
        folderId !== before.folderId
          ? 'query.move'
          : newName !== before.name
            ? 'query.rename'
            : 'query.update';
      this.audit(actor, action, 'saved_query', queryId, newName, {
        sqlChanged: v.sql !== undefined && v.sql !== before.sql,
      });
    });
    return this.query(actor, queryId);
  }

  duplicateQuery(
    actor: Actor,
    queryId: string,
    input: { name: string; folderId?: string | null },
  ): SavedQueryView {
    const source = this.query(actor, queryId);
    return this.createQuery(actor, {
      name: input.name,
      folderId: input.folderId === undefined ? source.folderId : input.folderId,
      sql: source.sql,
      defaultConnectionId: source.defaultConnectionId,
    });
  }

  /** Deletes a saved query. Executions that ran it keep their own SQL snapshot. */
  deleteQuery(actor: Actor, queryId: string): void {
    requirePermission(actor, 'queries.manage');
    const before = queryView(this.queryRow(actor, queryId));
    this.ctx.db.transaction(() => {
      this.ctx.db.run('DELETE FROM saved_queries WHERE id = :id', { id: queryId });
      this.audit(actor, 'query.delete', 'saved_query', queryId, before.name);
    });
  }

  /** Folder ids of a folder and all of its descendants, parents before children. */
  private subtree(actor: Actor, folderId: string): string[] {
    this.folderRow(actor, folderId);
    const all = this.ctx.db.all('SELECT id, parent_id FROM folders WHERE owner = :owner', {
      owner: actor.subject,
    });
    const out = [folderId];
    for (let i = 0; i < out.length; i++) {
      for (const f of all) if (f.parent_id === out[i]) out.push(String(f.id));
    }
    return out;
  }

  private folderRow(actor: Actor, folderId: string): Row {
    const row = this.ctx.db.get('SELECT * FROM folders WHERE id = :id AND owner = :owner', {
      id: folderId,
      owner: actor.subject,
    });
    assert(row, 'not_found', 'Folder not found.', { id: folderId });
    return row;
  }

  private queryRow(actor: Actor, queryId: string): Row {
    const row = this.ctx.db.get('SELECT * FROM saved_queries WHERE id = :id AND owner = :owner', {
      id: queryId,
      owner: actor.subject,
    });
    assert(row, 'not_found', 'Saved query not found.', { id: queryId });
    return row;
  }

  private assertConnection(connectionId: string): void {
    if (!this.ctx.db.get('SELECT 1 AS ok FROM connections WHERE id = :id', { id: connectionId })) {
      throw fieldError('defaultConnectionId', 'This connection does not exist.');
    }
  }

  private assertFolderNameFree(actor: Actor, parentId: string | null, folder: string, except?: string): void {
    const taken = this.ctx.db.get(
      `SELECT id FROM folders WHERE owner = :owner AND coalesce(parent_id, '') = :parent AND lower(name) = lower(:name)
         AND id <> :except`,
      { owner: actor.subject, parent: parentId ?? '', name: folder, except: except ?? '' },
    );
    if (taken)
      throw new AppError('name_conflict', `A folder named “${folder}” already exists here.`, {
        field: 'name',
      });
  }

  private assertQueryNameFree(actor: Actor, folderId: string | null, query: string, except?: string): void {
    const taken = this.ctx.db.get(
      `SELECT id FROM saved_queries WHERE owner = :owner AND coalesce(folder_id, '') = :folder AND lower(name) = lower(:name)
         AND id <> :except`,
      { owner: actor.subject, folder: folderId ?? '', name: query, except: except ?? '' },
    );
    if (taken) {
      throw new AppError(
        'name_conflict',
        `A query named “${query}” already exists in ${this.folderPath(actor, folderId)}. Choose another name or open the existing query.`,
        { field: 'name', existingId: String(taken.id) },
      );
    }
  }

  private audit(
    actor: Actor,
    action: string,
    type: string,
    targetId: string,
    label: string,
    details?: Record<string, unknown>,
  ): void {
    this.ctx.audit.record({
      actor,
      action,
      target: { type, id: targetId, label },
      outcome: 'succeeded',
      ...(details ? { details } : {}),
    });
  }
}
