<script lang="ts">
  import { onMount } from 'svelte';
  import Banner from '../components/Banner.svelte';
  import ConfirmPanel from '../components/ConfirmPanel.svelte';
  import SidePanel from '../components/SidePanel.svelte';
  import TreeRow from '../components/TreeRow.svelte';
  import { treeKeyboard } from '../lib/tree';
  import { api, ApiError } from '../lib/api';
  import { navigate } from '../lib/router.svelte';
  import { openTab } from '../lib/tabs.svelte';
  import { toast } from '../lib/toasts.svelte';
  import type { Connection, Folder, SavedQuery } from '../lib/types';

  let folders = $state<Folder[]>([]);
  let queries = $state<SavedQuery[]>([]);
  let connections = $state<Connection[]>([]);
  let folderId = $state<string | null>(null);
  let search = $state('');
  let error = $state<string | null>(null);
  let expanded = $state<Record<string, boolean>>({});

  /** One form panel for every name-based action; the API decides on conflicts. */
  type Form =
    | { kind: 'folder-new' | 'folder-rename'; name: string; target?: Folder }
    | { kind: 'query-new'; name: string; sql: string; connectionId: string | null }
    | { kind: 'query-rename' | 'query-duplicate'; name: string; target: SavedQuery }
    | { kind: 'query-move'; folderId: string | null; target: SavedQuery };
  let form = $state<Form | null>(null);
  let formError = $state<string | null>(null);
  let confirm = $state<
    | { kind: 'folder'; target: Folder; mode: 'move-to-parent' | 'delete-contents' }
    | { kind: 'query'; target: SavedQuery }
    | null
  >(null);

  async function load() {
    try {
      [folders, queries] = await Promise.all([
        api<Folder[]>('GET', '/folders'),
        api<SavedQuery[]>(
          'GET',
          // "All queries" is every query, in folders too: no folder filter.
          search
            ? `/queries?search=${encodeURIComponent(search)}`
            : folderId
              ? `/queries?folderId=${encodeURIComponent(folderId)}`
              : '/queries',
        ),
      ]);
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  onMount(async () => {
    connections = await api<Connection[]>('GET', '/connections').catch(() => []);
    await load();
  });

  const children = (parent: string | null) =>
    folders.filter((f) => f.parentId === parent).sort((a, b) => a.name.localeCompare(b.name));
  const path = (id: string | null): string => {
    const f = folders.find((x) => x.id === id);
    return f ? `${f.parentId ? `${path(f.parentId)} / ` : ''}${f.name}` : 'All queries';
  };
  const descendants = (id: string): string[] => children(id).flatMap((c) => [c.id, ...descendants(c.id)]);

  async function submit() {
    if (!form) return;
    formError = null;
    try {
      switch (form.kind) {
        case 'folder-new':
          await api('POST', '/folders', { name: form.name, parentId: folderId });
          break;
        case 'folder-rename':
          await api('PATCH', `/folders/${form.target?.id}`, { name: form.name });
          break;
        case 'query-new':
          await api('POST', '/queries', {
            name: form.name,
            sql: form.sql,
            folderId,
            defaultConnectionId: form.connectionId,
          });
          break;
        case 'query-rename':
          await api('PATCH', `/queries/${form.target.id}`, { name: form.name });
          break;
        case 'query-duplicate':
          await api('POST', `/queries/${form.target.id}/duplicate`, { name: form.name });
          break;
        case 'query-move':
          await api('PATCH', `/queries/${form.target.id}`, { folderId: form.folderId });
          break;
      }
      form = null;
      await load();
    } catch (e) {
      formError =
        e instanceof ApiError && e.code === 'validation_failed'
          ? ((e.details?.fields as { message: string }[] | undefined)?.[0]?.message ?? e.message)
          : e instanceof Error
            ? e.message
            : String(e);
    }
  }

  async function remove() {
    if (!confirm) return;
    try {
      if (confirm.kind === 'folder') {
        const r = await api<{ movedQueries: number; deletedQueries: number }>(
          'DELETE',
          `/folders/${confirm.target.id}?mode=${confirm.mode}`,
        );
        toast(`Folder deleted · ${r.deletedQueries} queries deleted, ${r.movedQueries} moved`, 'success');
        if (folderId === confirm.target.id) folderId = confirm.target.parentId;
      } else {
        await api('DELETE', `/queries/${confirm.target.id}`);
        toast(`${confirm.target.name} deleted`, 'success');
      }
      confirm = null;
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'danger');
    }
  }

  function open(q: SavedQuery) {
    openTab({ title: q.name, sql: q.sql, connectionId: q.defaultConnectionId });
    navigate('/workbench');
  }

  const folderConsequences = $derived.by(() => {
    if (confirm?.kind !== 'folder') return [];
    const nested = descendants(confirm.target.id).length;
    return confirm.mode === 'move-to-parent'
      ? [
          `Its queries and ${nested} subfolder(s) move to ${path(confirm.target.parentId)}.`,
          'Name conflicts there stop the deletion; nothing changes then.',
        ]
      : [`Its queries and ${nested} subfolder(s) are deleted.`, 'Execution history of those queries stays.'];
  });
</script>

{#snippet folderRows(parent: string | null, level: number)}
  {#each children(parent) as f (f.id)}
    <TreeRow
      label={f.name}
      icon="▸"
      {level}
      expanded={children(f.id).length ? Boolean(expanded[f.id]) : undefined}
      selected={folderId === f.id && !search}
      onToggle={() => (expanded[f.id] = !expanded[f.id])}
      onSelect={() => ((folderId = f.id), (search = ''), void load())}
    />
    {#if expanded[f.id]}{@render folderRows(f.id, level + 1)}{/if}
  {/each}
{/snippet}

<div class="library">
  <aside class="pane">
    <div class="actions">
      <button class="button" onclick={() => (form = { kind: 'folder-new', name: '' })}>New folder</button>
    </div>
    <div role="tree" aria-label="Folders" data-testid="folders" use:treeKeyboard>
      <TreeRow
        label="All queries"
        icon="★"
        selected={folderId === null && !search}
        onSelect={() => ((folderId = null), (search = ''), void load())}
      />
      {@render folderRows(null, 2)}
    </div>
  </aside>
  <section class="pane">
    <div class="actions">
      <h2>{search ? `Search: ${search}` : path(folderId)}</h2>
      <input
        type="search"
        aria-label="Search saved queries"
        placeholder="Search names and SQL"
        bind:value={search}
        onchange={() => void load()}
      />
      <button
        class="button primary"
        onclick={() => (form = { kind: 'query-new', name: '', sql: '', connectionId: null })}
        >New query</button
      >
      {#if folderId && !search}
        {@const current = folders.find((f) => f.id === folderId)}
        {#if current}
          <button
            class="button"
            onclick={() => (form = { kind: 'folder-rename', name: current.name, target: current })}
            >Rename folder</button
          >
          <button
            class="button danger"
            onclick={() => (confirm = { kind: 'folder', target: current, mode: 'move-to-parent' })}
            >Delete folder</button
          >
        {/if}
      {/if}
    </div>
    {#if error}<Banner tone="danger" title="Saved queries could not be loaded.">{error}</Banner>{/if}
    <table class="list" data-testid="queries">
      <thead
        ><tr
          ><th>Name</th><th>Default connection</th><th>Updated</th><th
            ><span class="visually-hidden">Actions</span></th
          ></tr
        ></thead
      >
      <tbody>
        {#each queries as q (q.id)}
          <tr data-name={q.name}>
            <td><button class="link" onclick={() => open(q)}>{q.name}</button></td>
            <td>{connections.find((c) => c.id === q.defaultConnectionId)?.name ?? '—'}</td>
            <td>{new Date(q.updatedAt).toLocaleString()}</td>
            <td class="row-actions">
              <button
                class="button"
                onclick={() => (form = { kind: 'query-rename', name: q.name, target: q })}>Rename</button
              >
              <button
                class="button"
                onclick={() => (form = { kind: 'query-move', folderId: q.folderId, target: q })}>Move</button
              >
              <button
                class="button"
                onclick={() => (form = { kind: 'query-duplicate', name: `${q.name} (copy)`, target: q })}
                >Duplicate</button
              >
              <button class="button danger" onclick={() => (confirm = { kind: 'query', target: q })}
                >Delete</button
              >
            </td>
          </tr>
        {:else}
          <tr><td colspan="4">{search ? 'No saved query matches.' : 'No saved queries here.'}</td></tr>
        {/each}
      </tbody>
    </table>
  </section>
</div>

<SidePanel
  open={form !== null}
  title={form?.kind === 'folder-new'
    ? 'New folder'
    : form?.kind === 'folder-rename'
      ? 'Rename folder'
      : form?.kind === 'query-new'
        ? 'New saved query'
        : form?.kind === 'query-move'
          ? 'Move query'
          : form?.kind === 'query-duplicate'
            ? 'Duplicate query'
            : 'Rename query'}
  onClose={() => ((form = null), (formError = null))}
>
  {#if form}
    <form class="form" onsubmit={(e) => (e.preventDefault(), void submit())}>
      {#if formError}<p class="problem" role="alert">{formError}</p>{/if}
      {#if form.kind === 'query-move'}
        <label class="field"
          ><span>Folder</span>
          <select bind:value={form.folderId}>
            <option value={null}>All queries (top level)</option>
            {#each folders as f (f.id)}<option value={f.id}>{path(f.id)}</option>{/each}
          </select></label
        >
      {:else}
        <label class="field"><span>Name</span><input bind:value={form.name} /></label>
      {/if}
      {#if form.kind === 'query-new'}
        <label class="field"
          ><span>SQL</span><textarea rows="6" class="mono" bind:value={form.sql}></textarea></label
        >
        <label class="field"
          ><span>Default connection</span>
          <select bind:value={form.connectionId}>
            <option value={null}>None</option>
            {#each connections as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
          </select></label
        >
      {/if}
    </form>
  {/if}
  {#snippet footer()}
    <button class="button" onclick={() => (form = null)}>Cancel</button>
    <button class="button primary" onclick={() => void submit()}>Save</button>
  {/snippet}
</SidePanel>

<ConfirmPanel
  open={confirm !== null}
  title={confirm?.kind === 'folder'
    ? `Delete folder ${confirm.target.name}?`
    : `Delete ${confirm?.target.name}?`}
  consequences={confirm?.kind === 'folder'
    ? folderConsequences
    : ['The saved query is removed. Its execution history stays.']}
  confirmLabel="Delete"
  danger
  onConfirm={() => void remove()}
  onClose={() => (confirm = null)}
>
  {#if confirm?.kind === 'folder'}
    <div class="mode" role="radiogroup" aria-label="What happens to the contents">
      <label><input type="radio" bind:group={confirm.mode} value="move-to-parent" /> Move contents up</label>
      <label><input type="radio" bind:group={confirm.mode} value="delete-contents" /> Delete contents</label>
    </div>
  {/if}
</ConfirmPanel>

<style>
  .library {
    display: grid;
    grid-template-columns: 260px 1fr;
    gap: 16px;
  }
  .pane {
    background: var(--color-panel);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    padding: 12px;
    /* Grid items may shrink below their content; wide tables scroll inside the pane. */
    min-width: 0;
    overflow-x: auto;
  }
  @media (max-width: 760px) {
    .library {
      grid-template-columns: 1fr;
    }
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin-bottom: 10px;
  }
  .actions h2 {
    margin: 0;
    flex: 1;
    font: var(--text-panel-title);
  }
  .actions input {
    height: 30px;
    padding: 0 8px;
    border: 1px solid var(--color-border-strong);
    border-radius: 6px;
  }
  .list {
    width: 100%;
    border-collapse: collapse;
  }
  th,
  td {
    padding: 6px 8px;
    text-align: left;
    border-bottom: 1px solid var(--color-border);
  }
  .row-actions {
    display: flex;
    gap: 4px;
    justify-content: flex-end;
  }
  .link {
    border: 0;
    background: none;
    padding: 0;
    color: var(--color-accent);
    cursor: pointer;
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .problem {
    margin: 0;
    padding: 8px 10px;
    border-radius: 6px;
    background: var(--color-danger-bg);
    color: var(--color-danger);
  }
  .mode {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 12px;
  }
</style>
