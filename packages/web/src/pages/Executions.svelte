<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Banner from '../components/Banner.svelte';
  import ConfirmPanel from '../components/ConfirmPanel.svelte';
  import KeyValueList from '../components/KeyValueList.svelte';
  import PolicyChip from '../components/PolicyChip.svelte';
  import ResultsPanel from '../components/ResultsPanel.svelte';
  import StatusPill from '../components/StatusPill.svelte';
  import { api } from '../lib/api';
  import { download } from '../lib/download';
  import { TERMINAL, type ExecutionView, type ExportView } from '../lib/execution';
  import { navigate, route } from '../lib/router.svelte';
  import { jobs } from '../lib/session.svelte';
  import { openTab } from '../lib/tabs.svelte';
  import { toast } from '../lib/toasts.svelte';
  import type { Connection } from '../lib/types';

  const id = $derived(
    route.path.startsWith('/executions/')
      ? decodeURIComponent(route.path.slice('/executions/'.length))
      : null,
  );
  let list = $state<ExecutionView[]>([]);
  let connections = $state<Connection[]>([]);
  let filters = $state({ source: '', status: '', connectionId: '', from: '' });
  let detail = $state<ExecutionView | null>(null);
  let exports = $state<ExportView[]>([]);
  let approvals = $state<
    { id: string; resultIndex: number; profile: { name: string }; status: string; expiresAt: string | null }[]
  >([]);
  let retainDays = $state(7);
  let confirmDelete = $state(false);
  let error = $state<string | null>(null);

  async function loadList() {
    const query = Object.entries(filters)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${encodeURIComponent(k === 'from' ? new Date(v).toISOString() : v)}`)
      .concat('limit=100')
      .join('&');
    try {
      list = await api<ExecutionView[]>('GET', `/executions?${query}`);
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  async function loadDetail(executionId: string) {
    try {
      detail = await api<ExecutionView>('GET', `/executions/${executionId}`);
      exports = await api<ExportView[]>('GET', `/executions/${executionId}/exports`);
      approvals = (
        await api<typeof approvals & { executionId: string }[]>('GET', '/approvals').catch(() => [])
      ).filter((a) => (a as unknown as { executionId: string }).executionId === executionId);
      error = null;
    } catch (e) {
      detail = null;
      error = e instanceof Error ? e.message : String(e);
    }
  }

  onMount(() => {
    void api<Connection[]>('GET', '/connections').then((c) => (connections = c));
  });
  $effect(() => {
    if (id) void loadDetail(id);
    else void loadList();
  });
  // Live updates: refresh what is shown when a live status changes (only then: reading `detail` or
  // `filters` here would make every refresh trigger the next one).
  let lastStatuses = '';
  $effect(() => {
    const statuses = jobs.items.map((j) => `${j.id}:${j.status}`).join();
    if (statuses === lastStatuses) return;
    lastStatuses = statuses;
    untrack(() => {
      if (id && detail && !TERMINAL.has(detail.status)) void loadDetail(id);
      else if (!id) void loadList();
    });
  });

  async function retain() {
    if (!detail) return;
    try {
      detail = await api<ExecutionView>('POST', `/executions/${detail.id}/retain`, {
        days: Number(retainDays),
      });
      toast(`Results kept until ${new Date(String(detail.resultExpiresAt)).toLocaleString()}`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'danger');
    }
  }
  async function deleteResults() {
    if (!detail) return;
    await api('DELETE', `/executions/${detail.id}/results`);
    confirmDelete = false;
    toast('Stored results deleted; the execution stays in history.', 'success');
    await loadDetail(detail.id);
  }
  const span = (a: string | null, b: string | null) =>
    a && b ? `${((Date.parse(b) - Date.parse(a)) / 1000).toFixed(1)} s` : '—';
</script>

{#if error}<Banner tone="danger" title="Could not load executions.">{error}</Banner>{/if}

{#if !id}
  <form
    class="filters"
    onsubmit={(e) => (e.preventDefault(), void loadList())}
    aria-label="Filter executions"
  >
    <label class="field"
      ><span>Source</span><select bind:value={filters.source} onchange={() => void loadList()}
        ><option value="">Any</option><option value="gui">GUI</option><option value="api">API</option><option
          value="mcp">MCP</option
        ></select
      ></label
    >
    <label class="field"
      ><span>Status</span><select bind:value={filters.status} onchange={() => void loadList()}
        ><option value="">Any</option
        >{#each ['queued', 'running', 'succeeded', 'failed', 'preflight_rejected', 'cancelled', 'timed_out', 'interrupted', 'unknown'] as s (s)}<option
            value={s}>{s.replace('_', ' ')}</option
          >{/each}</select
      ></label
    >
    <label class="field"
      ><span>Connection</span><select bind:value={filters.connectionId} onchange={() => void loadList()}
        ><option value="">Any</option>{#each connections as c (c.id)}<option value={c.id}>{c.name}</option
          >{/each}</select
      ></label
    >
    <label class="field"
      ><span>Since</span><input
        type="datetime-local"
        bind:value={filters.from}
        onchange={() => void loadList()}
      /></label
    >
  </form>
  <table class="list" data-testid="executions">
    <thead
      ><tr
        ><th>Title</th><th>Source</th><th>Connection</th><th>Status</th><th>Transaction</th><th>Submitted</th
        ></tr
      ></thead
    >
    <tbody>
      {#each list as e (e.id)}
        <tr data-id={e.id}>
          <td
            ><a
              href="/executions/{e.id}"
              onclick={(ev) => (ev.preventDefault(), navigate(`/executions/${e.id}`))}>{e.title}</a
            ></td
          >
          <td>{e.source.toUpperCase()}{e.profile ? ` · ${e.profile.name}` : ''}</td>
          <td>{e.connection.name}</td>
          <td><StatusPill kind="execution" value={e.status} /></td>
          <td><StatusPill kind="transaction" value={e.transactionOutcome} /></td>
          <td>{new Date(e.submittedAt).toLocaleString()}</td>
        </tr>
      {:else}
        <tr><td colspan="6">No executions match. Run SQL from the Workbench, the API or Claude Code.</td></tr>
      {/each}
    </tbody>
  </table>
{:else if detail}
  <div class="detail" data-testid="execution-detail" data-status={detail.status}>
    <p>
      <a href="/executions" onclick={(e) => (e.preventDefault(), navigate('/executions'))}>← All executions</a
      >
    </p>
    <h2>{detail.title}</h2>
    <div class="badges">
      <StatusPill kind="execution" value={detail.status} />
      <StatusPill kind="transaction" value={detail.transactionOutcome} />
      <PolicyChip readOnly={detail.readOnly} sources={detail.policySources} />
      {#if !TERMINAL.has(detail.status)}<button
          class="button danger"
          onclick={async () => (detail = await api('POST', `/executions/${detail?.id}/cancel`))}
          >Cancel</button
        >{/if}
      <button
        class="button"
        onclick={() => (
          openTab({ title: detail?.title, sql: detail?.sql, connectionId: detail?.connection.id }),
          navigate('/workbench')
        )}>Open in Workbench</button
      >
    </div>
    {#if detail.transactionOutcome === 'unknown'}
      <Banner tone="warning" title="Outcome unknown: check before running again.">
        The connection was lost during a write or during COMMIT, so the database may or may not have kept the
        changes. Look at the affected rows in the database first.
      </Banner>
    {/if}
    <div class="cols">
      <section>
        <p class="section-label">Execution</p>
        <KeyValueList
          items={[
            { label: 'Connection', value: `${detail.connection.name} (${detail.connection.engine})` },
            {
              label: 'Source',
              value: `${detail.source.toUpperCase()} · ${detail.clientId}${detail.profile ? ` · ${detail.profile.name}` : ''}`,
            },
            { label: 'Scope', value: detail.scope },
            {
              label: 'Mode',
              value: `${detail.transactionMode === 'atomic' ? 'Single transaction' : 'Per statement'} · ${detail.captureMode} capture`,
            },
            { label: 'Request key', value: detail.requestKey },
            { label: 'Submitted', value: new Date(detail.submittedAt).toLocaleString() },
            { label: 'Waited', value: span(detail.submittedAt, detail.startedAt) },
            { label: 'Ran', value: span(detail.startedAt, detail.finishedAt) },
            {
              label: 'Cancel requested',
              value: detail.cancelRequestedAt ? new Date(detail.cancelRequestedAt).toLocaleString() : null,
            },
            {
              label: 'Results kept until',
              value: detail.resultExpiresAt ? new Date(detail.resultExpiresAt).toLocaleString() : null,
            },
          ]}
        />
        <div class="retain">
          <label class="field"
            ><span>Keep results for (days)</span><input
              type="number"
              min="1"
              max="7"
              bind:value={retainDays}
            /></label
          >
          <button class="button" onclick={() => void retain()}>Retain</button>
          <button
            class="button danger"
            disabled={!detail.resultSets.some((r) => !['expired', 'deleted'].includes(r.completeness))}
            onclick={() => (confirmDelete = true)}>Delete stored results</button
          >
        </div>
      </section>
      <section>
        <p class="section-label">SQL snapshot</p>
        <pre class="mono" data-testid="sql-snapshot">{detail.sql}</pre>
        <p class="section-label">Exports</p>
        <ul>
          {#each exports as x (x.id)}
            <li>
              {x.fileName ?? `${x.format.toUpperCase()} export`} · {x.status}{x.previewOnly
                ? ' · preview only'
                : ''} · {x.rowCount} rows
              {#if x.status === 'ready'}<button
                  class="button"
                  onclick={() =>
                    void download(`/exports/${x.id}/download`).catch((e) => toast(String(e), 'danger'))}
                  >Download</button
                >{/if}
            </li>
          {:else}<li>No exports.</li>{/each}
        </ul>
        <p class="section-label">MCP disclosure</p>
        <ul>
          {#each approvals as a (a.id)}<li>
              Result {a.resultIndex + 1} · {a.profile.name} · {a.status}{a.expiresAt
                ? ` until ${new Date(a.expiresAt).toLocaleString()}`
                : ''}
            </li>{:else}<li>None.</li>{/each}
        </ul>
      </section>
    </div>
    <ResultsPanel
      execution={detail}
      onRunFull={(sql) => (
        openTab({ title: `${detail?.title} (full)`, sql, connectionId: detail?.connection.id }),
        navigate('/workbench')
      )}
    />
  </div>
  <ConfirmPanel
    open={confirmDelete}
    title="Delete stored results?"
    consequences={[
      'Captured rows and export files are removed.',
      'Any MCP disclosure of these results ends.',
      'The execution, its SQL and statement outcomes stay in history.',
    ]}
    confirmLabel="Delete results"
    danger
    onConfirm={() => void deleteResults()}
    onClose={() => (confirmDelete = false)}
  />
{:else}
  <p role="status">Loading…</p>
{/if}

<style>
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-bottom: 12px;
  }
  .list {
    width: 100%;
    border-collapse: collapse;
    background: var(--color-panel);
    border: 1px solid var(--color-border);
  }
  th,
  td {
    padding: 8px 12px;
    text-align: left;
    border-bottom: 1px solid var(--color-border);
  }
  th {
    font: var(--text-label);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
  }
  .detail {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  h2 {
    margin: 0;
    font: var(--text-panel-title);
  }
  .badges,
  .retain {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: flex-end;
  }
  .cols {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .cols section {
    background: var(--color-panel);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    padding: 12px;
  }
  pre {
    white-space: pre-wrap;
    max-height: 220px;
    overflow: auto;
    background: var(--color-panel-subtle);
    padding: 10px;
    border-radius: 8px;
  }
  @media (max-width: 900px) {
    .cols {
      grid-template-columns: 1fr;
    }
  }
</style>
