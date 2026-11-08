<script lang="ts">
  import { onMount } from 'svelte';
  import Banner from '../components/Banner.svelte';
  import DataGrid from '../components/DataGrid.svelte';
  import StatusPill from '../components/StatusPill.svelte';
  import TreeRow from '../components/TreeRow.svelte';
  import { treeKeyboard } from '../lib/tree';
  import { api, ApiError } from '../lib/api';
  import { navigate } from '../lib/router.svelte';
  import { selectSql } from '../lib/sql';
  import { openTab } from '../lib/tabs.svelte';
  import type { Connection, MetadataResult, ObjectInfo, SchemaInfo, TableDetail } from '../lib/types';

  let connections = $state<Connection[]>([]);
  let connectionId = $state<string | null>(null);
  let schemas = $state<MetadataResult<SchemaInfo> | null>(null);
  let objects = $state<Record<string, MetadataResult<ObjectInfo>>>({});
  let expanded = $state<Record<string, boolean>>({});
  let loading = $state(false);
  let failure = $state<string | null>(null);
  let loadedAt = $state<Date | null>(null);
  let search = $state('');
  let selected = $state<ObjectInfo | null>(null);
  let detail = $state<{
    table?: TableDetail;
    routine?: { status: string; text: string | null; reason?: string };
    missing?: boolean;
  } | null>(null);
  let tab = $state<'columns' | 'keys' | 'indexes' | 'definition'>('columns');
  let preview = $state<{
    status: string;
    columns: { name: string; type: string; binary?: boolean }[];
    rows: (string | null)[][];
    error?: string;
  } | null>(null);

  const connection = $derived(connections.find((c) => c.id === connectionId) ?? null);
  const engine = $derived(connection?.engine ?? 'postgresql');
  const KIND_ICON: Record<string, string> = {
    table: '▦',
    partitioned_table: '▦',
    view: '◫',
    materialized_view: '◫',
    foreign_table: '▦',
    function: 'ƒ',
    procedure: 'ƒ',
    aggregate: 'ƒ',
  };
  const isRelation = (o: ObjectInfo) => !['function', 'procedure', 'aggregate'].includes(o.kind);

  onMount(async () => {
    connections = (await api<Connection[]>('GET', '/connections')).filter((c) => c.enabled);
    connectionId = connections[0]?.id ?? null;
    if (connectionId) await refresh();
  });

  async function refresh() {
    if (!connectionId) return;
    loading = true;
    try {
      schemas = await api<MetadataResult<SchemaInfo>>('GET', `/connections/${connectionId}/metadata/schemas`);
      for (const name of Object.keys(expanded)) if (expanded[name]) await loadObjects(name);
      loadedAt = new Date();
      failure = null;
    } catch (e) {
      // Keep what was shown and say it is stale.
      failure = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function loadObjects(schema: string) {
    objects[schema] = await api<MetadataResult<ObjectInfo>>(
      'GET',
      `/connections/${connectionId}/metadata/schemas/${encodeURIComponent(schema)}/objects`,
    );
  }

  async function toggle(schema: string) {
    expanded[schema] = !expanded[schema];
    if (expanded[schema] && !objects[schema]) {
      try {
        await loadObjects(schema);
      } catch (e) {
        objects[schema] = {
          status: 'unavailable',
          items: [],
          reason: e instanceof Error ? e.message : String(e),
        };
      }
    }
  }

  async function select(o: ObjectInfo) {
    selected = o;
    detail = null;
    preview = null;
    tab = isRelation(o) ? 'columns' : 'definition';
    const base = `/connections/${connectionId}/metadata/schemas/${encodeURIComponent(o.schema)}`;
    try {
      detail = isRelation(o)
        ? { table: await api<TableDetail>('GET', `${base}/tables/${encodeURIComponent(o.name)}`) }
        : {
            routine: await api(
              'GET',
              `${base}/routines/${encodeURIComponent(o.name)}${o.signature !== undefined ? `?signature=${encodeURIComponent(o.signature)}` : ''}`,
            ),
          };
    } catch (e) {
      if (e instanceof ApiError && e.code === 'not_found') detail = { missing: true };
      else failure = e instanceof Error ? e.message : String(e);
    }
  }

  function openSelect() {
    if (!selected || !connectionId) return;
    openTab({ title: selected.name, sql: selectSql(engine, selected.schema, selected.name), connectionId });
    navigate('/workbench');
  }

  async function previewData() {
    if (!selected || !connectionId) return;
    preview = { status: 'queued', columns: [], rows: [] };
    try {
      let view = await api<{
        id: string;
        status: string;
        error: { message: string } | null;
        resultSets: { columns: { name: string; type: string; binary: boolean }[] }[];
      }>('POST', '/executions', {
        connectionId,
        sql: selectSql(engine, selected.schema, selected.name),
        title: `Preview ${selected.name}`,
        scope: 'Explorer preview',
      });
      while (['queued', 'running', 'cancel_requested'].includes(view.status)) {
        await new Promise((r) => setTimeout(r, 300));
        view = await api('GET', `/executions/${view.id}`);
      }
      if (view.status !== 'succeeded' || !view.resultSets.length) {
        preview = { status: view.status, columns: [], rows: [], error: view.error?.message ?? 'No result.' };
        return;
      }
      const page = await api<{
        columns: { name: string; type: string; binary: boolean }[];
        rows: (string | null)[][];
      }>('GET', `/executions/${view.id}/results/0/rows?limit=100`);
      preview = { status: view.status, columns: page.columns, rows: page.rows };
    } catch (e) {
      preview = {
        status: 'failed',
        columns: [],
        rows: [],
        error: e instanceof ApiError ? `${e.message}` : String(e),
      };
    }
  }

  const filtered = (schema: string) =>
    (objects[schema]?.items ?? []).filter(
      (o) => !search || o.name.toLowerCase().includes(search.toLowerCase()),
    );
</script>

<div class="explorer">
  <aside class="tree-pane">
    <div class="controls">
      <label class="field">
        <span>Connection</span>
        <select
          bind:value={connectionId}
          onchange={() => ((objects = {}), (expanded = {}), (selected = null), void refresh())}
        >
          {#each connections as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
        </select>
      </label>
      <div class="row">
        <input
          type="search"
          placeholder="Filter loaded objects"
          aria-label="Filter objects"
          bind:value={search}
        />
        <button class="button" onclick={() => void refresh()} disabled={loading}>Refresh</button>
      </div>
    </div>
    {#if !connections.length}
      <Banner tone="neutral" title="No enabled connections." />
    {:else if failure && loadedAt}
      <Banner tone="warning" title="Showing data from {loadedAt.toLocaleTimeString()}; refresh failed."
        >{failure}</Banner
      >
    {:else if failure}
      <Banner tone="danger" title="Metadata could not be loaded.">{failure}</Banner>
    {/if}
    {#if loading && !schemas}<p role="status">Loading schemas…</p>{/if}
    {#if schemas}
      {#if schemas.reason}<p class="note">{schemas.reason}</p>{/if}
      <div role="tree" aria-label="Database objects" data-testid="tree" use:treeKeyboard>
        {#each schemas.items.filter((s) => !s.system) as schema (schema.name)}
          <TreeRow
            label={schema.name}
            icon="▤"
            expanded={Boolean(expanded[schema.name])}
            onToggle={() => void toggle(schema.name)}
            onSelect={() => void toggle(schema.name)}
          >
            {#snippet trailing()}{#if !schema.usable}<span title="No USAGE privilege">🔒</span>{/if}{/snippet}
          </TreeRow>
          {#if expanded[schema.name]}
            {@const result = objects[schema.name]}
            {#if !result}
              <p class="note indent" role="status">Loading…</p>
            {:else}
              {#if result.status !== 'ok'}
                <p class="note indent warn" data-testid="schema-state">
                  {result.status === 'insufficient_permission' ? 'Insufficient permission' : 'Unavailable'}: {result.reason}
                </p>
              {/if}
              {#each filtered(schema.name) as o (o.kind + o.name + (o.signature ?? ''))}
                <TreeRow
                  level={2}
                  icon={KIND_ICON[o.kind] ?? '·'}
                  label={o.signature !== undefined ? `${o.name}(${o.signature})` : o.name}
                  selected={selected?.name === o.name &&
                    selected?.schema === o.schema &&
                    selected?.signature === o.signature}
                  onSelect={() => void select(o)}
                />
              {:else}
                {#if result.status === 'ok'}<p class="note indent">
                    {search ? 'No matches.' : 'This schema is empty.'}
                  </p>{/if}
              {/each}
            {/if}
          {/if}
        {/each}
      </div>
    {/if}
  </aside>
  <section class="detail" aria-live="polite">
    {#if !selected}
      <p class="note">Select a table, view or routine.</p>
    {:else}
      <header class="detail-head">
        <h2>{selected.schema}.{selected.name}</h2>
        <span class="kind">{selected.kind.replace('_', ' ')}</span>
        {#if isRelation(selected)}
          <button class="button" onclick={openSelect}>Open SELECT</button>
          <button class="button" onclick={() => void previewData()}>Preview data</button>
        {/if}
      </header>
      {#if selected.comment}<p>{selected.comment}</p>{/if}
      {#if detail?.missing}
        <Banner tone="warning" title="This object no longer exists or was renamed."
          >Refresh the tree to see the current objects.</Banner
        >
      {:else if !detail}
        <p role="status">Loading details…</p>
      {:else if detail.table}
        {@const t = detail.table}
        <div class="tabs" role="tablist">
          {#each ['columns', 'keys', 'indexes', 'definition'] as name (name)}
            <button
              role="tab"
              aria-selected={tab === name}
              class:active={tab === name}
              onclick={() => (tab = name as typeof tab)}>{name}</button
            >
          {/each}
        </div>
        {#if tab === 'columns'}
          <table class="meta" data-testid="columns">
            <thead><tr><th>#</th><th>Column</th><th>Type</th><th>Null</th><th>Default</th></tr></thead>
            <tbody>
              {#each t.columns.items as c (c.position)}
                <tr
                  ><td>{c.position}</td><td>{c.name}</td><td class="mono">{c.type}</td><td
                    >{c.nullable ? 'yes' : 'no'}</td
                  ><td class="mono">{c.identity ?? c.generated ?? c.default ?? ''}</td></tr
                >
              {/each}
            </tbody>
          </table>
        {:else if tab === 'keys'}
          <ul>
            {#each t.keys.items as k (k.name)}
              <li>
                <strong>{k.type}</strong>
                {k.name} ({k.columns.join(', ')}){#if k.references}
                  → {k.references.schema}.{k.references.table}({k.references.columns.join(', ')}){/if}
              </li>
            {:else}<li>No keys or constraints.</li>{/each}
          </ul>
        {:else if tab === 'indexes'}
          <ul>
            {#each t.indexes.items as i (i.name)}<li>
                {i.name}{i.unique ? ' · unique' : ''} ({i.columns.join(', ')})
              </li>{:else}<li>No indexes.</li>{/each}
          </ul>
        {:else}
          {#if t.definition.reconstructed}<p class="note">Reconstructed from the catalog.</p>{/if}
          {#if t.definition.status !== 'ok'}<Banner tone="neutral" title="Definition not available."
              >{t.definition.reason}</Banner
            >{:else}<pre class="mono">{t.definition.text}</pre>{/if}
        {/if}
      {:else if detail.routine}
        {#if detail.routine.status !== 'ok'}
          <Banner
            tone="neutral"
            title={detail.routine.status === 'insufficient_permission'
              ? 'Insufficient permission'
              : 'Definition not available'}>{detail.routine.reason}</Banner
          >
        {:else}<pre class="mono">{detail.routine.text}</pre>{/if}
      {/if}
      {#if preview}
        <div class="preview">
          <p class="section-label">
            Preview · first 100 rows <StatusPill kind="execution" value={preview.status} />
          </p>
          {#if preview.error}<Banner tone="danger" title="Preview failed.">{preview.error}</Banner
            >{:else if preview.rows.length || preview.columns.length}<DataGrid
              columns={preview.columns}
              rows={preview.rows}
              height={260}
            />{/if}
        </div>
      {/if}
    {/if}
  </section>
</div>

<style>
  .explorer {
    display: grid;
    grid-template-columns: 320px 1fr;
    gap: 16px;
    min-height: 0;
  }
  .tree-pane,
  .detail {
    background: var(--color-panel);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    padding: 12px;
    overflow: auto;
  }
  .controls {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 8px;
  }
  .row {
    display: flex;
    gap: 8px;
  }
  .row input {
    flex: 1;
    height: 30px;
    padding: 0 8px;
    border: 1px solid var(--color-border-strong);
    border-radius: 6px;
  }
  .note {
    color: var(--color-text-muted);
    font: var(--text-dense);
  }
  .indent {
    margin: 2px 0 2px 32px;
  }
  .warn {
    color: var(--color-warning);
  }
  .detail-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .detail-head h2 {
    margin: 0;
    font: var(--text-panel-title);
    flex: 1;
  }
  .kind {
    color: var(--color-text-muted);
  }
  .tabs {
    display: flex;
    gap: 4px;
    margin: 12px 0 8px;
  }
  .tabs button {
    border: 0;
    background: none;
    padding: 6px 10px;
    border-radius: 6px;
    cursor: pointer;
    text-transform: capitalize;
  }
  .tabs .active {
    background: var(--color-accent-soft);
  }
  .meta {
    width: 100%;
    border-collapse: collapse;
  }
  .meta th,
  .meta td {
    padding: 4px 8px;
    text-align: left;
    border-bottom: 1px solid var(--color-border);
  }
  pre {
    white-space: pre-wrap;
    background: var(--color-panel-subtle);
    padding: 12px;
    border-radius: 8px;
  }
  .preview {
    margin-top: 16px;
  }
</style>
