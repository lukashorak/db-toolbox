<script lang="ts">
  let { environment }: { environment: 'production' | 'development' | string } = $props();
</script>

<span class="env" class:prod={environment === 'production'}>{environment.toUpperCase()}</span>

<style>
  .env {
    display: inline-flex;
    align-items: center;
    height: 18px;
    padding: 0 6px;
    border-radius: var(--radius-chip);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--color-dev);
    background: var(--color-dev-bg);
    border: 1px solid var(--color-dev-border);
  }
  .prod {
    color: var(--color-prod);
    background: var(--color-prod-bg);
    border-color: var(--color-prod-border);
  }
</style>
