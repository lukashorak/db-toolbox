<script lang="ts">
  import { onMount } from 'svelte';
  import Banner from '../components/Banner.svelte';
  import StatusPill from '../components/StatusPill.svelte';
  import { api } from '../lib/api';
  import { navigate } from '../lib/router.svelte';
  import type { Connection } from '../lib/types';

  interface Section<T> {
    availability: string;
    reason: string | null;
    items: T[];
  }
  interface Session {
    id: string;
    user: string | null;
    application: string | null;
    state: string | null;
    wait: string | null;
    durationMs: number | null;
    query: string | null;
    queryVisible: boolean;
    blockedBy: string[];
    executionId: string | null;
  }
  interface Wait {
    waiting: string;
    blocking: string | null;
    lock: string | null;
    object: string | null;
    waitingQuery: string | null;
    blockingQuery: string | null;
    waitMs: number | null;
  }
  interface Snapshot {
    capturedAt: string;
    account: string;
    sessions: Section<Session>;
    lockWaits: Section<Wait>;
    counters: {
      availability: string;
      reason: string | null;
      data: {
        reset: boolean;
        intervalSeconds: number | null;
        perSecond: Record<string, number | null>;
        values: Record<string, number>;
      } | null;
    };
  }
  interface Statements {
    availability: string;
    reason: string | null;
    statsSince: string | null;
    items: {
      id: string;
      text: string | null;
      calls: number;
      totalMs: number;
      meanMs: number;
      rows: number;
    }[];
  }

  let connections = $state<Connection[]>([]);
  let connectionId = $state<string | null>(null);
  let tab = $state<'overview' | 'activity' | 'blocking' | 'statements'>('overview');
  let snapshot = $state<Snapshot | null>(null);
  let statements = $state<Statements | null>(null);
  let paused = $state(false);
  let failure = $state<string | null>(null);
  let refreshSeconds = $state(15);

  async function refresh() {
    if (!connectionId) return;
    try {
      snapshot = await api<Snapshot>('GET', `/connections/${connectionId}/monitoring/activity`);
      if (tab === 'statements' || !statements)
        statements = await api<Statements>(
          'GET',
          `/connections/${connectionId}/monitoring/statements?limit=25`,
        );
      failure = null;
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
  }

  onMount(() => {
    void (async () => {
      connections = (await api<Connection[]>('GET', '/connections')).filter((c) => c.enabled);
      refreshSeconds = Math.max(
        5,
        (await api<{ monitoringRefreshSeconds: number }>('GET', '/settings/execution'))
          .monitoringRefreshSeconds,
      );
      connectionId = connections[0]?.id ?? null;
      await refresh();
    })();
  });
  $effect(() => {
    if (paused || !connectionId) return;
    const timer = setInterval(() => void refresh(), refreshSeconds * 1000);
    return () => clearInterval(timer);
  });

  const ms = (v: number | null) =>
    v === null ? '—' : v >= 60_000 ? `${(v / 60_000).toFixed(1)} min` : `${(v / 1000).toFixed(1)} s`;
  const COUNTERS: Record<string, string> = {
    xact_commit: 'Commits',
    xact_rollback: 'Rollbacks',
    blks_read: 'Blocks read',
    tup_returned: 'Rows returned',
    tup_inserted: 'Rows inserted',
    tup_updated: 'Rows updated',
    tup_deleted: 'Rows deleted',
    deadlocks: 'Deadlocks',
    questions: 'Statements',
    com_commit: 'Commits',
    com_rollback: 'Rollbacks',
    innodb_rows_read: 'Rows read',
    innodb_rows_inserted: 'Rows inserted',
    innodb_rows_updated: 'Rows updated',
    innodb_rows_deleted: 'Rows deleted',
    slow_queries: 'Slow queries',
    innodb_row_lock_waits: 'Row lock waits',
  };
</script>

<div class="bar">
  <label class="field"
    ><span>Connection</span>
    <select
      bind:value={connectionId}
      onchange={() => ((snapshot = null), (statements = null), void refresh())}
    >
      {#each connections as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
    </select></label
  >
  <span class="sample" data-testid="sample-time"
    >{snapshot
      ? `Sample ${new Date(snapshot.capturedAt).toLocaleTimeString()} · account ${snapshot.account}`
      : ''}</span
  >
  <button class="button" onclick={() => (paused = !paused)} aria-pressed={paused}
    >{paused ? 'Resume' : 'Pause'}</button
  >
  <button class="button" onclick={() => void refresh()}>Refresh</button>
</div>
{#if failure}
  <Banner
    tone={snapshot ? 'warning' : 'danger'}
    title={snapshot ? 'Showing the last sample; the latest refresh failed.' : 'Monitoring is not available.'}
    >{failure}</Banner
  >
{/if}

<div class="tabs" role="tablist">
  {#each [['overview', 'Overview'], ['activity', 'Activity'], ['blocking', 'Blocking'], ['statements', 'Slow statements']] as [key, label] (key)}
    <button
      role="tab"
      aria-selected={tab === key}
      class:active={tab === key}
      onclick={() => ((tab = key as typeof tab), key === 'statements' && void refresh())}
      >{label}{key === 'blocking' && snapshot?.lockWaits.items.length
        ? ` (${snapshot.lockWaits.items.length})`
        : ''}</button
    >
  {/each}
</div>

{#if snapshot}
  {#if tab === 'overview'}
    <div class="cards">
      {#each [['Sessions', snapshot.sessions], ['Lock waits', snapshot.lockWaits]] as [label, section] (label)}
        {@const s = section as Section<unknown>}
        <div class="card">
          <span class="section-label">{label}</span><strong
            >{s.availability === 'unavailable' ? '—' : s.items.length}</strong
          ><StatusPill kind="monitoring" value={s.availability} />{#if s.reason}<small>{s.reason}</small>{/if}
        </div>
      {/each}
      <div class="card">
        <span class="section-label">Slow statements</span><StatusPill
          kind="monitoring"
          value={statements?.availability ?? 'unavailable'}
        />{#if statements?.reason}<small>{statements.reason}</small>{/if}
      </div>
    </div>
    {#if snapshot.counters.data}
      {@const c = snapshot.counters.data}
      <p class="section-label">
        Rates per second {c.intervalSeconds ? `over ${c.intervalSeconds.toFixed(0)} s` : ''}
      </p>
      {#if c.reset}<Banner
          tone="neutral"
          title="The server reset its statistics; rates start again with the next sample."
        />{/if}
      {#if !c.intervalSeconds && !c.reset}<p class="note">Rates appear from the second sample.</p>{/if}
      <table class="list">
        <tbody>
          {#each Object.entries(c.perSecond).filter(([k]) => COUNTERS[k]) as [k, v] (k)}<tr
              ><td>{COUNTERS[k]}</td><td class="num">{v === null ? '—' : v}</td></tr
            >{/each}
        </tbody>
      </table>
    {/if}
  {:else if tab === 'activity'}
    {#if snapshot.sessions.reason}<Banner tone="warning" title="Limited view"
        >{snapshot.sessions.reason}</Banner
      >{/if}
    <table class="list" data-testid="sessions">
      <thead
        ><tr><th>Session</th><th>User</th><th>State</th><th>Wait</th><th>Duration</th><th>Query</th></tr
        ></thead
      >
      <tbody>
        {#each snapshot.sessions.items as s (s.id)}
          <tr data-session={s.id}>
            <td
              >{s.id}{#if s.executionId}<br /><a
                  href="/executions/{s.executionId}"
                  onclick={(e) => (e.preventDefault(), navigate(`/executions/${s.executionId}`))}>this tool</a
                >{/if}</td
            >
            <td>{s.user ?? '—'}</td>
            <td>{s.state ?? '—'}</td>
            <td>{s.wait ?? ''}{s.blockedBy.length ? ` · blocked by ${s.blockedBy.join(', ')}` : ''}</td>
            <td>{ms(s.durationMs)}</td>
            <td class="mono query">{s.queryVisible ? (s.query ?? '') : 'Hidden: no permission to see it'}</td>
          </tr>
        {:else}<tr><td colspan="6">No other sessions.</td></tr>{/each}
      </tbody>
    </table>
  {:else if tab === 'blocking'}
    {#if snapshot.lockWaits.availability === 'unavailable'}
      <Banner tone="neutral" title="Lock waits are unavailable.">{snapshot.lockWaits.reason}</Banner>
    {:else}
      <table class="list" data-testid="lock-waits">
        <thead
          ><tr
            ><th>Waiting</th><th>Blocked by</th><th>Lock</th><th>Waiting for</th><th>Waiting query</th><th
              >Blocking query</th
            ></tr
          ></thead
        >
        <tbody>
          {#each snapshot.lockWaits.items as w (w.waiting + w.blocking)}
            <tr data-waiting={w.waiting}
              ><td>{w.waiting}</td><td>{w.blocking ?? 'unknown'}</td><td>{w.lock ?? ''} {w.object ?? ''}</td
              ><td>{ms(w.waitMs)}</td><td class="mono query">{w.waitingQuery ?? ''}</td><td class="mono query"
                >{w.blockingQuery ?? ''}</td
              ></tr
            >
          {:else}<tr><td colspan="6">Nothing is waiting for a lock.</td></tr>{/each}
        </tbody>
      </table>
    {/if}
  {:else if statements}
    {#if statements.availability === 'unavailable'}
      <Banner tone="neutral" title="Statement statistics are unavailable.">{statements.reason}</Banner>
    {:else}
      <p class="note">
        Since {statements.statsSince
          ? new Date(statements.statsSince).toLocaleString()
          : 'the statistics were last reset'}. {statements.reason ?? ''}
      </p>
      <table class="list" data-testid="statements">
        <thead><tr><th>Statement</th><th>Calls</th><th>Total</th><th>Mean</th><th>Rows</th></tr></thead>
        <tbody>
          {#each statements.items as st (st.id)}
            <tr
              ><td class="mono query">{st.text ?? 'Hidden: no permission to see it'}</td><td class="num"
                >{st.calls}</td
              ><td class="num">{st.totalMs.toFixed(1)} ms</td><td class="num">{st.meanMs.toFixed(2)} ms</td
              ><td class="num">{st.rows}</td></tr
            >
          {/each}
        </tbody>
      </table>
    {/if}
  {/if}
{:else if !failure}
  <p role="status">Loading…</p>
{/if}

<style>
  .bar {
    display: flex;
    gap: 10px;
    align-items: flex-end;
    margin-bottom: 10px;
  }
  .sample {
    margin-left: auto;
    color: var(--color-text-muted);
    font: var(--text-dense);
  }
  .tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 10px;
  }
  .tabs button {
    border: 0;
    background: none;
    padding: 6px 10px;
    border-radius: 6px;
    cursor: pointer;
  }
  .tabs .active {
    background: var(--color-accent-soft);
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px;
    margin-bottom: 12px;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px;
    background: var(--color-panel);
    border: 1px solid var(--color-border);
    border-radius: 10px;
  }
  .card strong {
    font-size: 22px;
  }
  .card small,
  .note {
    color: var(--color-text-muted);
  }
  .list {
    width: 100%;
    border-collapse: collapse;
    background: var(--color-panel);
    border: 1px solid var(--color-border);
  }
  th,
  td {
    padding: 6px 10px;
    text-align: left;
    border-bottom: 1px solid var(--color-border);
    vertical-align: top;
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .query {
    max-width: 420px;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
