<script lang="ts">
  import Banner from '../components/Banner.svelte';
  import StatusPill from '../components/StatusPill.svelte';
  import { jobs } from '../lib/session.svelte';
</script>

<p class="section-label">Recent executions · updated live</p>
{#if jobs.live === 'offline'}<Banner tone="warning" title="Live updates are reconnecting." />{/if}
<table class="list" data-testid="executions">
  <thead
    ><tr><th>Title</th><th>Connection</th><th>Status</th><th>Transaction</th><th>Submitted</th></tr></thead
  >
  <tbody>
    {#each jobs.items as job (job.id)}
      <tr data-id={job.id}>
        <td>{job.title}</td>
        <td>{job.connection}</td>
        <td><StatusPill kind="execution" value={job.status} /></td>
        <td><StatusPill kind="transaction" value={job.transactionOutcome} /></td>
        <td>{new Date(job.submittedAt).toLocaleString()}</td>
      </tr>
    {:else}
      <tr><td colspan="5">No executions yet. Run SQL from the Workbench, the API or Claude Code.</td></tr>
    {/each}
  </tbody>
</table>

<style>
  .list {
    width: 100%;
    border-collapse: collapse;
    background: var(--color-panel);
    border: 1px solid var(--color-border);
    border-radius: 10px;
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
</style>
