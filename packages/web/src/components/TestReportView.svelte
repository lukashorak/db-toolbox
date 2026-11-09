<script lang="ts">
  import type { TestReport } from '../lib/types';
  let { report }: { report: TestReport } = $props();
  const icon = { ok: '✓', failed: '✕', skipped: '–' } as const;
</script>

<div class="report" data-testid="test-report" data-ok={report.ok}>
  <p class:ok={report.ok} class:bad={!report.ok}>
    {#if report.ok}✓ Connected to {report.server?.product} {report.server?.version}{:else}✕ {report.failure
        ?.message}{/if}
  </p>
  <ol class="steps">
    {#each report.steps as step (step.name)}
      <li class={step.status}>
        <span aria-hidden="true">{icon[step.status]}</span>
        <strong
          >{step.name === 'reach'
            ? 'Reach'
            : step.name === 'tls'
              ? 'TLS'
              : step.name === 'authenticate'
                ? 'Sign in'
                : 'Capabilities'}</strong
        >
        <span class="detail">{step.detail}</span>
      </li>
    {/each}
  </ol>
  {#if report.capabilities.length}
    <p class="section-label">Capabilities</p>
    <ul class="caps">
      {#each report.capabilities as cap (cap.name)}
        <li><span aria-hidden="true">{cap.available ? '✓' : '○'}</span> {cap.detail}</li>
      {/each}
    </ul>
  {/if}
  {#each report.warnings as warning (warning)}<p class="warn">! {warning}</p>{/each}
</div>

<style>
  .report {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .ok {
    color: var(--color-success);
  }
  .bad {
    color: var(--color-danger);
  }
  .steps,
  .caps {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .steps li {
    display: grid;
    grid-template-columns: 16px 90px 1fr;
    gap: 6px;
  }
  .failed {
    color: var(--color-danger);
  }
  .skipped {
    color: var(--color-text-muted);
  }
  .detail {
    color: var(--color-text-soft);
    font: var(--text-dense);
  }
  .warn {
    margin: 0;
    color: var(--color-warning);
  }
</style>
