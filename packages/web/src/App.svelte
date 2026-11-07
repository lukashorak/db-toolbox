<script lang="ts">
  import { onMount } from 'svelte';

  interface Check {
    ok: boolean;
    detail: string;
  }

  let status = $state<'loading' | 'ready' | 'not_ready' | 'unreachable'>('loading');
  let checks = $state<Record<string, Check>>({});

  onMount(async () => {
    try {
      const response = await fetch('/readyz', { headers: { accept: 'application/json' } });
      const body = (await response.json()) as {
        status: 'ready' | 'not_ready';
        checks: Record<string, Check>;
      };
      status = body.status;
      checks = body.checks;
    } catch {
      status = 'unreachable';
    }
  });

  const label = $derived(
    {
      loading: 'Checking the server…',
      ready: 'Server ready',
      not_ready: 'Server not ready',
      unreachable: 'Server unreachable',
    }[status],
  );
</script>

<main>
  <h1>Database Workbench</h1>
  <p class="note">Foundation build (step 0). The workbench screens arrive from step 9.</p>
  <section aria-live="polite">
    <h2>{label}</h2>
    {#if Object.keys(checks).length}
      <ul>
        {#each Object.entries(checks) as [name, check] (name)}
          <li class:ok={check.ok}>
            <span class="name">{name}</span>
            <span>{check.ok ? 'OK' : 'Problem'} · {check.detail}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</main>

<style>
  main {
    max-width: 640px;
    margin: 64px auto;
    padding: 24px 28px;
    background: var(--color-panel);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-panel);
  }
  h1 {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
  }
  h2 {
    margin: 20px 0 8px;
    font-size: 14px;
    font-weight: 600;
  }
  .note {
    margin: 6px 0 0;
    color: var(--color-text-muted);
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    gap: 12px;
    padding: 6px 0;
    border-top: 1px solid var(--color-border);
    color: var(--color-danger);
  }
  li.ok {
    color: var(--color-success);
  }
  .name {
    min-width: 90px;
    color: var(--color-text);
    font-weight: 500;
  }
</style>
