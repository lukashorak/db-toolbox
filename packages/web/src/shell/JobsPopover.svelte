<script lang="ts">
  import StatusPill from '../components/StatusPill.svelte';
  import { navigate } from '../lib/router.svelte';
  import { jobs, runningJobs } from '../lib/session.svelte';

  let open = $state(false);
  let button = $state<HTMLButtonElement | null>(null);
  const running = $derived(runningJobs());

  function close() {
    open = false;
    button?.focus();
  }
</script>

<div class="jobs">
  <button
    class="button"
    aria-haspopup="dialog"
    aria-expanded={open}
    bind:this={button}
    onclick={() => (open = !open)}
    data-testid="jobs-button"
  >
    Jobs
    <span class="count" class:active={running > 0} data-testid="jobs-running">{running}</span>
    <span class="visually-hidden">running</span>
    <span
      class="live {jobs.live}"
      title={jobs.live === 'live' ? 'Live updates' : 'Reconnecting'}
      aria-hidden="true"
    ></span>
  </button>
  {#if open}
    <div
      class="popover"
      role="dialog"
      aria-label="Recent jobs"
      tabindex="-1"
      onkeydown={(e) => e.key === 'Escape' && close()}
    >
      {#if jobs.live !== 'live'}<p class="note">
          Reconnecting… statuses are refreshed when the connection is back.
        </p>{/if}
      {#each jobs.items.slice(0, 8) as job (job.id)}
        <button
          class="job"
          onclick={() => {
            close();
            navigate(`/executions/${job.id}`);
          }}
        >
          <span class="title">{job.title}</span>
          <span class="meta">{job.connection}</span>
          <StatusPill kind="execution" value={job.status} />
        </button>
      {:else}
        <p class="note">No executions yet.</p>
      {/each}
      <button
        class="all"
        onclick={() => {
          close();
          navigate('/executions');
        }}>All executions</button
      >
    </div>
  {/if}
</div>

<style>
  .jobs {
    position: relative;
  }
  .count {
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 9px;
    background: var(--color-neutral-bg);
    font-size: 11px;
    line-height: 18px;
  }
  .count.active {
    background: var(--color-info-bg);
    color: var(--color-info);
  }
  .live {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--dot-off);
  }
  .live.live {
    background: var(--dot-ok);
  }
  .popover {
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    z-index: 25;
    width: 360px;
    padding: 6px;
    background: var(--color-panel);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    box-shadow: var(--shadow-overlay);
  }
  .job {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 2px 8px;
    width: 100%;
    padding: 8px;
    border: 0;
    border-radius: 6px;
    background: none;
    text-align: left;
    cursor: pointer;
  }
  .job:hover {
    background: var(--color-panel-subtle);
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    grid-row: 2;
    font-size: 12px;
    color: var(--color-text-muted);
  }
  .note {
    margin: 8px;
    color: var(--color-text-muted);
    font: var(--text-dense);
  }
  .all {
    width: 100%;
    margin-top: 4px;
    padding: 8px;
    border: 0;
    border-top: 1px solid var(--color-border);
    background: none;
    color: var(--color-accent);
    cursor: pointer;
  }
</style>
