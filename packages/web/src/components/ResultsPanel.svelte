<script lang="ts">
  import { api } from '../lib/api';
  import { columnComparator } from '../lib/compare';
  import { download } from '../lib/download';
  import type { ExecutionView, ExportView } from '../lib/execution';
  import { toast } from '../lib/toasts.svelte';
  import Banner from './Banner.svelte';
  import DataGrid from './DataGrid.svelte';
  import KeyValueList from './KeyValueList.svelte';
  import PolicyChip from './PolicyChip.svelte';
  import SidePanel from './SidePanel.svelte';
  import StatusPill from './StatusPill.svelte';

  /** Results of one execution: statements, result sets and what can be done with them. */
  let {
    execution,
    onRunFull,
    onShowError,
  }: {
    execution: ExecutionView;
    onRunFull: (sql: string) => void;
    onShowError?: (statement: number) => void;
  } = $props();

  let statementTab = $state(0);
  /** Which of the statement's result sets is shown (a MySQL procedure can return several). */
  let resultTab = $state(0);
  let rows = $state<(string | null)[][]>([]);
  let loadedFor = $state('');
  let sortBy = $state<{ column: number; dir: 1 | -1 } | null>(null);
  let filter = $state('');
  let inspected = $state<number | null>(null);
  let panel = $state<'full' | 'export' | 'preview-export' | 'share' | null>(null);
  let exportFormat = $state<'csv' | 'json'>('csv');
  let shareForm = $state({ profileId: '', minutes: 60 });
  let profiles = $state<{ id: string; name: string }[]>([]);
  let busy = $state(false);
  /**
   * The result a side panel acts on, fixed when it opens. Showing another execution or result set
   * closes the panel (and drops one still loading), so a confirmation never applies to a result
   * other than the one it was opened for.
   */
  type Target = { execution: string; title: string; index: number; sql: string; rows: number };
  let target = $state.raw<Target | null>(null);

  const statement = $derived(execution.statements[statementTab] ?? null);
  const sets = $derived(execution.resultSets.filter((r) => r.statement === statementTab));
  const set = $derived(sets[resultTab] ?? sets[0] ?? null);
  const shown = $derived.by(() => {
    let list = rows.map((r, i) => ({ r, i }));
    if (filter)
      list = list.filter(({ r }) =>
        r.some((v) => v !== null && v.toLowerCase().includes(filter.toLowerCase())),
      );
    if (sortBy) {
      const { column, dir } = sortBy;
      const compare = columnComparator(
        list.map(({ r }) => r[column]).filter((v): v is string => v !== null && v !== undefined),
      );
      list = [...list].sort((a, b) => {
        const x = a.r[column] ?? null;
        const y = b.r[column] ?? null;
        if (x === y) return 0;
        if (x === null) return 1;
        if (y === null) return -1;
        return compare(x, y) * dir;
      });
    }
    return list;
  });

  function showStatement(i: number) {
    statementTab = i;
    resultTab = 0;
  }

  // The panel stays when another execution is shown (a new run, an earlier one picked): that one
  // starts at its first statement and result set. Before the jump below, so a failure still wins.
  let shownExecution = '';
  $effect(() => {
    if (execution.id !== shownExecution) {
      shownExecution = execution.id;
      showStatement(0);
    }
  });

  // Statement 1 by default; jump to a failed statement once, when it fails. Not reactive on purpose:
  // the jump must not repeat when the person picks another statement afterwards.
  let jumpedTo = '';
  $effect(() => {
    const failed = execution.statements.findIndex((s) => s.status === 'failed');
    const key = `${execution.id}:${failed}`;
    if (failed !== -1 && key !== jumpedTo) {
      jumpedTo = key;
      showStatement(failed);
    }
  });
  $effect(() => {
    const now = set ? `${execution.id}:${set.index}` : '';
    if (target && `${target.execution}:${target.index}` !== now) {
      target = null;
      panel = null;
    }
  });
  function openPanel(kind: 'full' | 'export' | 'preview-export'): void {
    if (!set) return;
    target = targetOf();
    panel = kind;
  }
  function targetOf(): Target | null {
    if (!set) return null;
    return {
      execution: execution.id,
      title: execution.title,
      index: set.index,
      sql: statement?.sql ?? '',
      rows: set.rowCount,
    };
  }
  $effect(() => {
    if (!set) {
      rows = [];
      loadedFor = '';
      return;
    }
    const identity = `${execution.id}:${set.index}:`;
    const key = `${identity}${set.completeness}:${set.rowCount}`;
    if (key === loadedFor) return;
    // Another execution or result set: never show the previous rows under its heading, also while
    // it is still capturing, and let no late answer for the previous one land (its key is gone).
    if (!loadedFor.startsWith(identity)) {
      rows = [];
      loadedFor = `${identity}pending`;
    }
    if (set.completeness === 'capturing') return;
    loadedFor = key;
    sortBy = null;
    filter = '';
    inspected = null;
    void api<{ rows: (string | null)[][] }>(
      'GET',
      `/executions/${execution.id}/results/${set.index}/rows?limit=1000`,
    )
      .then((page) => {
        // A slower answer for a set that is no longer selected must not replace the current rows.
        if (loadedFor === key) rows = page.rows;
      })
      .catch((e) => {
        if (loadedFor === key) toast(e instanceof Error ? e.message : String(e), 'danger');
      });
  });

  const reasons = $derived({
    full:
      !statement || statement.kind !== 'read'
        ? 'Only statements that read data can be run again for the full result.'
        : !set
          ? 'This statement returned no rows.'
          : set.completeness === 'complete'
            ? 'The full result is already captured.'
            : null,
    export: !set
      ? 'There is no result to export.'
      : set.completeness !== 'complete'
        ? `The captured result is ${set.completeness.replace('_', '-')}; only a complete result can be exported in full.`
        : null,
    previewExport: !set
      ? 'There is no result to export.'
      : ['expired', 'deleted', 'capturing'].includes(set.completeness)
        ? 'The result is not stored.'
        : null,
    share: !set
      ? 'There is no result to share.'
      : ['expired', 'deleted', 'capturing'].includes(set.completeness)
        ? 'The result is not stored.'
        : null,
  });

  async function exportResult(previewOnly: boolean) {
    const t = target;
    if (!t) return;
    busy = true;
    try {
      let created = await api<ExportView>('POST', `/executions/${t.execution}/results/${t.index}/exports`, {
        format: exportFormat,
        previewOnly,
      });
      while (created.status === 'generating') {
        await new Promise((r) => setTimeout(r, 300));
        created = await api<ExportView>('GET', `/exports/${created.id}`);
      }
      if (created.status !== 'ready') throw new Error(created.error?.message ?? 'The export failed.');
      const file = await download(`/exports/${created.id}/download`);
      toast(`${file.fileName} · ${created.rowCount} rows`, 'success');
      panel = null;
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'danger');
    } finally {
      busy = false;
    }
  }

  async function openShare() {
    const opened = (target = targetOf());
    if (!opened) return;
    const list = await api<{ id: string; name: string }[]>('GET', '/profiles');
    // Another result was shown while the profiles loaded: that dropped this dialog.
    if (target !== opened) return;
    profiles = list;
    shareForm.profileId = list[0]?.id ?? '';
    panel = 'share';
  }

  async function share() {
    const t = target;
    if (!t) return;
    busy = true;
    try {
      await api('POST', `/executions/${t.execution}/results/${t.index}/share`, {
        profileId: shareForm.profileId,
        minutes: Number(shareForm.minutes),
      });
      toast('Shared with the MCP profile until the approval expires.', 'success');
      panel = null;
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'danger');
    } finally {
      busy = false;
    }
  }
</script>

<section
  class="results"
  aria-label="Results"
  data-testid="results"
  data-status={execution.status}
  data-execution-id={execution.id}
>
  <header class="summary">
    <StatusPill kind="execution" value={execution.status} />
    <StatusPill kind="transaction" value={execution.transactionOutcome} />
    {#if set}<StatusPill kind="capture" value={set.completeness} />{/if}
    <PolicyChip readOnly={execution.readOnly} sources={execution.policySources} />
    <span class="meta"
      >{execution.connection.name} · {execution.scope} · {execution.transactionMode === 'atomic'
        ? 'single transaction'
        : 'per statement'}</span
    >
  </header>
  {#if execution.queue}<Banner tone="neutral" title="Queued · position {execution.queue.position}"
      >{execution.queue.reason}</Banner
    >{/if}
  {#if execution.statusNote}<p class="note">{execution.statusNote}</p>{/if}
  {#if execution.status === 'unknown' || execution.transactionOutcome === 'unknown'}
    <Banner tone="warning" title="The outcome is unknown."
      >The connection was lost while writing or committing. Check the database before running the script
      again.</Banner
    >
  {/if}
  {#if execution.status === 'preflight_rejected' || execution.status === 'rejected'}
    <Banner tone="danger" title="Not run.">{execution.error?.message}</Banner>
  {/if}

  {#if execution.statements.length > 1}
    <div class="statement-tabs" role="tablist" aria-label="Statements">
      {#each execution.statements as s, i (s.ordinal)}
        <button
          role="tab"
          aria-selected={statementTab === i}
          class:active={statementTab === i}
          class:failed={s.status === 'failed'}
          onclick={() => showStatement(i)}
        >
          {i + 1} · {s.command} <small>{s.status.replace('_', ' ')}</small>
        </button>
      {/each}
    </div>
  {/if}

  {#if statement}
    <div class="statement">
      <span>{statement.command} · line {statement.range.startLine}</span>
      {#if statement.affectedRows !== null}<span data-testid="affected"
          >{statement.affectedRows} row(s) affected</span
        >{/if}
      {#if statement.transactionOutcome !== 'not_started'}<StatusPill
          kind="transaction"
          value={statement.transactionOutcome}
        />{/if}
      {#if statement.durationMs !== null}<span>{statement.durationMs} ms</span>{/if}
    </div>
    {#if statement.error}
      <Banner tone="danger" title={statement.error.message}>
        {statement.error.code ? `Code ${statement.error.code}. ` : ''}<button
          class="link"
          onclick={() => onShowError?.(statementTab)}>Show in editor</button
        >
      </Banner>
    {/if}
    {#each statement.notices as notice, n (n)}<p class="note">{notice}</p>{/each}
  {/if}

  {#if sets.length > 1}
    <div class="statement-tabs" role="tablist" aria-label="Result sets of this statement">
      {#each sets as r, i (r.index)}
        <button
          role="tab"
          aria-selected={set?.index === r.index}
          class:active={set?.index === r.index}
          data-testid="result-set-tab"
          onclick={() => (resultTab = i)}
        >
          Result {i + 1} <small>{r.rowCount.toLocaleString()} rows</small>
        </button>
      {/each}
    </div>
  {/if}

  {#if set}
    <div class="grid-bar">
      <span data-testid="row-summary">
        {#if set.moreAvailable && set.completeness === 'preview_limited'}Showing {set.rowCount.toLocaleString()}
          rows. More rows are available; the total was not counted.
        {:else}{set.rowCount.toLocaleString()} rows{set.completeness === 'complete'
            ? ''
            : ` · ${set.completeness.replace('_', '-')}`}{/if}
      </span>
      <input
        type="search"
        aria-label="Filter rows shown"
        placeholder="Filter rows shown"
        bind:value={filter}
      />
      <div class="actions">
        <button
          class="button"
          disabled={Boolean(reasons.full)}
          title={reasons.full ?? ''}
          onclick={() => openPanel('full')}>Run full result</button
        >
        <button
          class="button"
          disabled={Boolean(reasons.export)}
          title={reasons.export ?? ''}
          onclick={() => openPanel('export')}>Export full result</button
        >
        <button
          class="button dashed"
          disabled={Boolean(reasons.previewExport)}
          title={reasons.previewExport ?? ''}
          onclick={() => openPanel('preview-export')}>Export preview only</button
        >
        <button
          class="button policy"
          disabled={Boolean(reasons.share)}
          title={reasons.share ?? ''}
          onclick={() => void openShare()}>Share full result with MCP</button
        >
      </div>
    </div>
    {#if sortBy || filter}<p class="note">
        Sorting and filtering apply only to the {rows.length.toLocaleString()} rows shown here, not to the database.
      </p>{/if}
    <div class="sort" role="group" aria-label="Sort rows shown">
      {#each set.columns as column, c (c)}
        <button
          class:on={sortBy?.column === c}
          onclick={() =>
            (sortBy =
              sortBy?.column === c
                ? sortBy.dir === 1
                  ? { column: c, dir: -1 }
                  : null
                : { column: c, dir: 1 })}
          >{column.name}{sortBy?.column === c ? (sortBy.dir === 1 ? ' ↑' : ' ↓') : ''}</button
        >
      {/each}
    </div>
    <DataGrid
      columns={set.columns}
      rows={shown.map((x) => x.r)}
      height={320}
      onSelectRow={(i) => (inspected = shown[i]?.i ?? null)}
    />
  {:else if statement && statement.status === 'succeeded' && !execution.resultSets.length}
    <p class="note">No rows returned.</p>
  {/if}
</section>

<SidePanel
  open={inspected !== null}
  title="Row {inspected !== null ? inspected + 1 : ''}"
  onClose={() => (inspected = null)}
>
  {#if inspected !== null && set}
    <KeyValueList
      items={set.columns.map((c, i) => ({ label: c.name, value: rows[inspected as number]?.[i] ?? 'NULL' }))}
    />
  {/if}
</SidePanel>

<SidePanel open={panel === 'full'} title="Run full result" onClose={() => (panel = null)}>
  <p>
    Runs this statement again as a <strong>new execution</strong> and captures every row, within the time and size
    limits. The data may have changed since the preview.
  </p>
  {#snippet footer()}
    <button class="button" onclick={() => (panel = null)}>Cancel</button>
    <button class="button primary" onclick={() => ((panel = null), target && onRunFull(target.sql))}
      >Run full result</button
    >
  {/snippet}
</SidePanel>

<SidePanel
  open={panel === 'export' || panel === 'preview-export'}
  title={panel === 'export' ? 'Export full result' : 'Export preview only'}
  onClose={() => (panel = null)}
>
  {#if panel === 'preview-export'}
    <Banner tone="warning" title="Partial file"
      >Only the {target?.rows.toLocaleString()} captured rows. The file name says PREVIEW-ONLY.</Banner
    >
  {:else}
    <p>Writes a file from the captured result. No SQL runs.</p>
  {/if}
  <label class="field"
    ><span>Format</span><select bind:value={exportFormat}
      ><option value="csv">CSV</option><option value="json">JSON</option></select
    ></label
  >
  {#snippet footer()}
    <button class="button" onclick={() => (panel = null)}>Cancel</button>
    <button
      class="button primary"
      disabled={busy}
      onclick={() => void exportResult(panel === 'preview-export')}>Export and download</button
    >
  {/snippet}
</SidePanel>

<SidePanel open={panel === 'share'} title="Share full result with MCP" onClose={() => (panel = null)}>
  <p>
    Lets one MCP profile read this result beyond its allowance, until the approval expires. It grants no write
    permission.
  </p>
  {#if target}<p class="note" data-testid="share-target">
      Result {target.index + 1} of “{target.title}”.
    </p>{/if}
  {#if profiles.length}
    <label class="field"
      ><span>Profile</span><select bind:value={shareForm.profileId}
        >{#each profiles as p (p.id)}<option value={p.id}>{p.name}</option>{/each}</select
      ></label
    >
    <label class="field"
      ><span>Expires after (minutes)</span><input
        type="number"
        min="1"
        bind:value={shareForm.minutes}
      /></label
    >
  {:else}
    <Banner tone="neutral" title="No MCP profiles exist." />
  {/if}
  {#snippet footer()}
    <button class="button" onclick={() => (panel = null)}>Cancel</button>
    <button class="button primary" disabled={busy || !shareForm.profileId} onclick={() => void share()}
      >Share</button
    >
  {/snippet}
</SidePanel>

<style>
  .results {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .summary,
  .statement {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .meta,
  .note {
    color: var(--color-text-muted);
    font: var(--text-dense);
    margin: 0;
  }
  .statement-tabs {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .statement-tabs button {
    border: 1px solid var(--color-border);
    background: var(--color-panel);
    border-radius: 6px;
    padding: 4px 8px;
    cursor: pointer;
  }
  .statement-tabs .active {
    background: var(--color-accent-soft);
    border-color: var(--color-accent);
  }
  .statement-tabs .failed {
    color: var(--color-danger);
  }
  .grid-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .grid-bar input {
    height: 28px;
    padding: 0 8px;
    border: 1px solid var(--color-border-strong);
    border-radius: 6px;
  }
  .actions {
    display: flex;
    gap: 6px;
    margin-left: auto;
    flex-wrap: wrap;
  }
  .dashed {
    border-style: dashed;
  }
  .policy {
    color: var(--color-policy);
    border-color: var(--color-policy-border);
  }
  .sort {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .sort button {
    border: 0;
    background: none;
    color: var(--color-text-muted);
    font-size: 12px;
    cursor: pointer;
  }
  .sort .on {
    color: var(--color-accent);
  }
  .link {
    border: 0;
    background: none;
    padding: 0;
    color: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
</style>
