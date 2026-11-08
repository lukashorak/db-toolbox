<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import Banner from '../components/Banner.svelte';
  import ResultsPanel from '../components/ResultsPanel.svelte';
  import SidePanel from '../components/SidePanel.svelte';
  import SqlEditor from '../components/SqlEditor.svelte';
  import StatusPill from '../components/StatusPill.svelte';
  import { api, ApiError } from '../lib/api';
  import {
    errorRange,
    TERMINAL,
    type CheckedStatement,
    type ExecutionView,
    type Problem,
  } from '../lib/execution';
  import { jobs } from '../lib/session.svelte';
  import { DEFAULT_SETTINGS, type RunSettings } from '../lib/storage';
  import { addTab, closeTab, ensureLoaded, persist, workbench } from '../lib/tabs.svelte';
  import { toast } from '../lib/toasts.svelte';
  import type { Connection, MetadataResult, ObjectInfo } from '../lib/types';

  let connections = $state<Connection[]>([]);
  let selection = $state({ from: 0, to: 0 });
  let checked = $state<{
    statements: CheckedStatement[];
    problems: Problem[];
    readOnly: boolean;
    policySources: string[];
    /** The inputs this analysis is for: its ranges are valid only for exactly this text. */
    for: { tab: string; sql: string; connectionId: string; mode: string };
  } | null>(null);
  let rejected = $state<{ problems: Problem[]; base: number; statements: CheckedStatement[] } | null>(null);
  let views = $state<Record<string, ExecutionView>>({});
  let tablist = $state<HTMLElement | null>(null);
  let shownRun = $state<string | null>(null);
  let completion = $state<Record<string, string[]>>({});
  let shortcuts = $state(false);
  /** Where each run's SQL started in the editor, for error positions (this session only). */
  const bases = new SvelteMap<string, number>();

  const tab = $derived(workbench.tabs.find((t) => t.id === workbench.active) ?? null);
  const settings = $derived<RunSettings>(tab?.settings ?? DEFAULT_SETTINGS);
  const connection = $derived(connections.find((c) => c.id === tab?.connectionId) ?? null);
  const runs = $derived(tab?.runs ?? []);
  const current = $derived(shownRun && views[shownRun] ? views[shownRun] : runs[0] ? views[runs[0]] : null);
  const active = $derived(runs.some((id) => views[id] && !TERMINAL.has(views[id].status)));
  /** Tabs whose submission is on its way: a second Run (double click, repeated shortcut) waits. */
  const submitting = new SvelteSet<string>();
  const busy = $derived(active || (tab ? submitting.has(tab.id) : false));

  /** The analysis of exactly what the editor holds now; null while the text is being checked again. */
  const fresh = $derived(
    checked &&
      tab &&
      checked.for.tab === tab.id &&
      checked.for.sql === tab.sql &&
      checked.for.connectionId === tab.connectionId &&
      checked.for.mode === settings.transactionMode
      ? checked
      : null,
  );

  /** What Run will execute: the selection, or the statement at the cursor. */
  const target = $derived.by(() => {
    if (!tab) return null;
    if (selection.to > selection.from)
      return { from: selection.from, to: selection.to, label: 'Run selection', scope: 'Selection' };
    // Ranges from an older text could cover other statements of the new one: never use them.
    const statements = fresh?.statements ?? [];
    const at =
      statements.find((s) => selection.from >= s.range.start && selection.from <= s.range.end) ??
      [...statements].reverse().find((s) => s.range.start <= selection.from) ??
      statements[0];
    return at
      ? {
          from: at.range.start,
          to: at.range.end,
          label: `Run statement ${at.index + 1} · line ${at.range.startLine}`,
          scope: `Statement ${at.index + 1}`,
        }
      : null;
  });

  const marks = $derived.by(() => {
    const list: { from: number; to: number; kind: 'target' | 'error'; title?: string }[] = [];
    if (target && !active) list.push({ from: target.from, to: target.to, kind: 'target' });
    if (rejected) {
      for (const p of rejected.problems) {
        const s = p.statement !== null ? rejected.statements[p.statement] : undefined;
        if (s)
          list.push({
            from: rejected.base + s.range.start,
            to: rejected.base + s.range.end,
            kind: 'error',
            title: p.message,
          });
      }
    }
    if (current && bases.has(current.id)) {
      const failed = current.statements.find((s) => s.status === 'failed' && s.error);
      if (failed)
        list.push({
          ...errorRange(failed, bases.get(current.id) ?? 0),
          kind: 'error',
          title: failed.error?.message ?? '',
        });
    }
    return list;
  });

  onMount(() => {
    ensureLoaded();
    void api<Connection[]>('GET', '/connections').then((list) => {
      connections = list.filter((c) => c.enabled);
      for (const t of workbench.tabs)
        if (!t.connectionId && connections[0]) t.connectionId = connections[0].id;
    });
    // A fallback refresh for runs of this page, in addition to live events.
    const timer = setInterval(() => void refreshActive(), 1500);
    return () => clearInterval(timer);
  });

  $effect(() => {
    void JSON.stringify(workbench.tabs);
    void workbench.active;
    persist();
  });

  // Live status: refetch a shown run when its live status changes. React to changes of the live
  // status only, never to a difference from the fetched view: the two can disagree for a moment, and
  // a refetch must not trigger another one.
  const seenStatus: Record<string, string> = {};
  $effect(() => {
    for (const job of jobs.items) {
      if (seenStatus[job.id] === job.status) continue;
      seenStatus[job.id] = job.status;
      if (untrack(() => views[job.id])) void load(job.id);
    }
  });

  // Load the runs of the active tab after a tab switch or reload (recovers runs by ID).
  $effect(() => {
    const ids = runs.slice(0, 5);
    untrack(() => {
      shownRun = null;
      for (const id of ids) if (!views[id]) void load(id);
    });
  });

  // Statement ranges and preflight problems, a moment after typing stops.
  let checkTimer: ReturnType<typeof setTimeout> | undefined;
  /** Only the latest request may set `checked`; an older answer arriving late is dropped. */
  let checkRequest = 0;
  $effect(() => {
    const sql = tab?.sql ?? '';
    const tabId = tab?.id ?? '';
    const connectionId = tab?.connectionId;
    const mode = settings.transactionMode;
    clearTimeout(checkTimer);
    const request = ++checkRequest;
    if (!connectionId || !sql.trim()) {
      checked = null;
      return;
    }
    checkTimer = setTimeout(() => {
      void api<Omit<NonNullable<typeof checked>, 'for'>>('POST', '/sql/check', {
        connectionId,
        sql,
        transactionMode: mode,
      })
        .then((r) => {
          if (request === checkRequest) checked = { ...r, for: { tab: tabId, sql, connectionId, mode } };
        })
        .catch(() => undefined);
    }, 350);
  });

  // Completion: table names of the connection's default schema.
  $effect(() => {
    const c = connection;
    if (!c) return;
    const schema = c.engine === 'mysql' ? c.database : (c.schema ?? 'public');
    void api<MetadataResult<ObjectInfo>>(
      'GET',
      `/connections/${c.id}/metadata/schemas/${encodeURIComponent(schema)}/objects`,
    )
      .then(
        (r) =>
          (completion = Object.fromEntries(
            r.items
              .filter((o) => !['function', 'procedure', 'aggregate'].includes(o.kind))
              .map((o) => [o.name, []]),
          )),
      )
      .catch(() => (completion = {}));
  });

  async function load(id: string) {
    try {
      views[id] = await api<ExecutionView>('GET', `/executions/${id}`);
    } catch {
      // Expired or deleted: drop it from the tab.
      if (tab) tab.runs = (tab.runs ?? []).filter((r) => r !== id);
    }
  }
  async function refreshActive() {
    for (const id of runs) if (views[id] && !TERMINAL.has(views[id].status)) await load(id);
  }

  function update(patch: Partial<RunSettings>) {
    if (tab) tab.settings = { ...settings, ...patch };
  }

  async function run(
    kind: 'statement' | 'script',
    sqlOverride?: { sql: string; base: number; scope: string; captureMode?: 'full' },
  ) {
    if (!tab || !tab.connectionId || busy) return;
    // Running "the statement" must never fall back to the whole script: until the statement check
    // has resolved the range at the cursor, refuse (the shortcut can fire before the button exists).
    if (kind === 'statement' && !sqlOverride && !target) {
      toast(
        'The statement at the cursor is still being checked. Try again in a moment, or run the script.',
        'info',
      );
      return;
    }
    const part =
      sqlOverride ??
      (kind === 'script' || !target
        ? { sql: tab.sql, base: 0, scope: 'Script' }
        : { sql: tab.sql.slice(target.from, target.to), base: target.from, scope: target.scope });
    if (!part.sql.trim()) return;
    rejected = null;
    // Set before the first await, so a second call in the meantime returns above.
    const tabId = tab.id;
    submitting.add(tabId);
    try {
      const view = await api<ExecutionView>('POST', '/executions', {
        connectionId: tab.connectionId,
        sql: part.sql,
        title: tab.title,
        scope: part.scope,
        requestKey: crypto.randomUUID(),
        captureMode: sqlOverride?.captureMode ?? settings.captureMode,
        transactionMode: settings.transactionMode,
        continueOnError: settings.transactionMode === 'per_statement' && settings.continueOnError,
        ...(settings.timeoutSeconds ? { timeoutMs: settings.timeoutSeconds * 1000 } : {}),
        ...(settings.retainDays ? { retention: 'retained', retainDays: settings.retainDays } : {}),
      });
      bases.set(view.id, part.base);
      views[view.id] = view;
      tab.runs = [view.id, ...(tab.runs ?? [])].slice(0, 20);
      shownRun = view.id;
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'read_only_policy' || e.code === 'preflight_rejected')) {
        const statements =
          (
            await api<Omit<NonNullable<typeof checked>, 'for'>>('POST', '/sql/check', {
              connectionId: tab.connectionId,
              sql: part.sql,
            }).catch(() => null)
          )?.statements ?? [];
        rejected = { problems: (e.details?.problems ?? []) as Problem[], base: part.base, statements };
      } else toast(e instanceof Error ? e.message : String(e), 'danger');
    } finally {
      submitting.delete(tabId);
    }
  }

  async function cancel() {
    const id = runs.find((r) => views[r] && !TERMINAL.has(views[r].status));
    if (id) views[id] = await api<ExecutionView>('POST', `/executions/${id}/cancel`);
  }
</script>

<div class="tabs">
  <!-- Only tabs inside the tab list (ARIA tabs pattern). Close with ✕ or Delete on the focused tab. -->
  <div class="tablist" role="tablist" aria-label="Query tabs" bind:this={tablist}>
    {#each workbench.tabs as t (t.id)}
      <button
        class="tab"
        class:active={t.id === workbench.active}
        role="tab"
        aria-selected={t.id === workbench.active}
        tabindex={t.id === workbench.active ? 0 : -1}
        aria-keyshortcuts={workbench.tabs.length > 1 ? 'Delete' : undefined}
        title={workbench.tabs.length > 1 ? 'Delete closes this tab' : undefined}
        onclick={() => (workbench.active = t.id)}
        onkeydown={(e) => {
          const i = workbench.tabs.findIndex((x) => x.id === t.id);
          if (e.key === 'Delete' && workbench.tabs.length > 1) closeTab(t.id);
          else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            const next =
              workbench.tabs[
                (i + (e.key === 'ArrowRight' ? 1 : -1) + workbench.tabs.length) % workbench.tabs.length
              ];
            if (next) {
              workbench.active = next.id;
              (
                e.currentTarget.parentElement?.children[workbench.tabs.indexOf(next)] as
                  HTMLElement | undefined
              )?.focus();
            }
          } else return;
          e.preventDefault();
        }}
        >{t.title}{#if workbench.tabs.length > 1}<span
            class="x"
            aria-hidden="true"
            onclick={(e) => (e.stopPropagation(), closeTab(t.id))}>✕</span
          >{/if}</button
      >
    {/each}
  </div>
  <button
    class="add"
    aria-label="New tab"
    onclick={async () => {
      addTab();
      await tick();
      tablist?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    }}>＋</button
  >
</div>

{#if tab}
  <div class="toolbar">
    <label class="field"
      ><span>Connection</span>
      <select bind:value={tab.connectionId} disabled={busy}>
        {#each connections as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
      </select></label
    >
    <label class="field"
      ><span>Capture</span>
      <select
        value={settings.captureMode}
        disabled={busy}
        onchange={(e) =>
          update({ captureMode: (e.currentTarget as HTMLSelectElement).value as RunSettings['captureMode'] })}
      >
        <option value="preview">Preview (1,000 rows)</option><option value="full">Full result</option>
      </select></label
    >
    <label class="field"
      ><span>Transaction</span>
      <select
        value={settings.transactionMode}
        disabled={busy}
        onchange={(e) =>
          update({
            transactionMode: (e.currentTarget as HTMLSelectElement).value as RunSettings['transactionMode'],
          })}
      >
        <option value="per_statement">Per statement</option><option value="atomic">Single transaction</option>
      </select></label
    >
    {#if settings.transactionMode === 'per_statement'}
      <label class="check"
        ><input
          type="checkbox"
          checked={settings.continueOnError}
          disabled={busy}
          onchange={(e) => update({ continueOnError: (e.currentTarget as HTMLInputElement).checked })}
        /> Continue after error</label
      >
    {/if}
    <label class="field narrow"
      ><span>Timeout (s)</span><input
        type="number"
        min="1"
        placeholder="default"
        value={settings.timeoutSeconds ?? ''}
        disabled={busy}
        onchange={(e) =>
          update({ timeoutSeconds: Number((e.currentTarget as HTMLInputElement).value) || null })}
      /></label
    >
    <label class="field"
      ><span>Keep results</span>
      <select
        value={String(settings.retainDays ?? '')}
        disabled={busy}
        onchange={(e) => update({ retainDays: Number((e.currentTarget as HTMLSelectElement).value) || null })}
      >
        <option value="">24 hours</option><option value="3">3 days</option><option value="7">7 days</option>
      </select></label
    >
    <div class="run">
      {#if active}
        <button class="button danger" onclick={() => void cancel()}>Cancel run</button>
      {:else}
        <button
          class="button primary"
          disabled={!target || !tab.connectionId || busy}
          onclick={() => void run('statement')}
          data-testid="run-target">{target?.label ?? 'Run'}</button
        >
        <button
          class="button"
          disabled={!tab.connectionId || !tab.sql.trim() || busy}
          onclick={() => void run('script')}>Run script</button
        >
      {/if}
      <button class="button" onclick={() => (shortcuts = true)} aria-label="Keyboard shortcuts">⌘</button>
    </div>
  </div>

  {#if checked?.readOnly}<p class="note">
      Read-only here ({checked.policySources.join(', ')}): modifying SQL is rejected before it runs.
    </p>{/if}
  {#if checked?.problems.length && !rejected}
    <Banner tone="warning" title="This script would be rejected:"
      >{checked.problems.map((p) => p.message).join(' ')}</Banner
    >
  {/if}
  {#if rejected}
    <Banner tone="danger" title="Not run."
      >{rejected.problems.map((p) => `${p.message}${p.hint ? ` ${p.hint}` : ''}`).join(' ')}</Banner
    >
  {/if}

  <div class="editor-wrap">
    <SqlEditor
      value={tab.sql}
      engine={connection?.engine ?? 'postgresql'}
      schema={completion}
      {marks}
      onChange={(v) => {
        if (tab) tab.sql = v;
      }}
      onCursor={(s) => (selection = s)}
      onRun={(kind) => void run(kind)}
    />
  </div>

  {#if runs.length}
    <div class="runs" aria-label="Runs of this tab">
      {#each runs.slice(0, 5) as id, i (id)}
        {#if views[id]}
          <button class:on={current?.id === id} onclick={() => (shownRun = id)}>
            {i === 0 ? 'Latest' : `Run −${i}`}
            <StatusPill kind="execution" value={views[id].status} />
          </button>
        {/if}
      {/each}
    </div>
  {/if}
  {#if current}
    <ResultsPanel
      execution={current}
      onRunFull={(sql) => void run('statement', { sql, base: 0, scope: 'Full result', captureMode: 'full' })}
    />
  {/if}
{/if}

<SidePanel open={shortcuts} title="Keyboard shortcuts" onClose={() => (shortcuts = false)}>
  <dl class="keys">
    <dt>Ctrl/⌘ + Enter</dt>
    <dd>Run the selection, or the statement at the cursor</dd>
    <dt>Shift + Ctrl/⌘ + Enter</dt>
    <dd>Run the whole script</dd>
    <dt>Shift + Ctrl/⌘ + F</dt>
    <dd>Format SQL</dd>
    <dt>Ctrl + Space</dt>
    <dd>Completion</dd>
    <dt>Ctrl/⌘ + F</dt>
    <dd>Search in the editor</dd>
    <dt>Escape</dt>
    <dd>Close a panel</dd>
  </dl>
</SidePanel>

<style>
  .tabs {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    border-bottom: 1px solid var(--color-border);
    margin-bottom: 10px;
    overflow-x: auto;
  }
  .tablist {
    display: flex;
    gap: 2px;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 8px;
    border: 1px solid var(--color-border);
    border-bottom: 0;
    border-radius: 6px 6px 0 0;
    background: var(--color-panel-subtle);
    padding: 6px 10px;
    cursor: pointer;
    white-space: nowrap;
  }
  .tab.active {
    background: var(--color-panel);
    box-shadow: inset 0 2px 0 var(--color-accent);
  }
  .add {
    border: 0;
    background: none;
    padding: 6px 10px;
    cursor: pointer;
  }
  .x {
    color: var(--color-text-muted);
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: flex-end;
    margin-bottom: 8px;
  }
  .narrow input {
    width: 90px;
  }
  .check {
    display: flex;
    gap: 6px;
    align-items: center;
    height: 30px;
  }
  .run {
    display: flex;
    gap: 6px;
    margin-left: auto;
  }
  .note {
    margin: 0 0 6px;
    color: var(--color-policy);
    font: var(--text-dense);
  }
  .editor-wrap {
    height: 260px;
    margin-bottom: 10px;
  }
  .runs {
    display: flex;
    gap: 6px;
    margin-bottom: 8px;
  }
  .runs button {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-panel);
    padding: 3px 8px;
    cursor: pointer;
  }
  .runs .on {
    border-color: var(--color-accent);
  }
  .keys {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 8px 16px;
  }
  .keys dt {
    font-family: var(--font-mono);
  }
  .keys dd {
    margin: 0;
  }
</style>
