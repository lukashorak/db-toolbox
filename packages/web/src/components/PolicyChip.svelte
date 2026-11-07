<script lang="ts">
  /** Read/write policy: square chips with a lock, so they are never confused with status pills. */
  let { readOnly, sources = [] }: { readOnly: boolean; sources?: string[] } = $props();
  const label = $derived(
    readOnly ? `Read-only${sources.length ? ` · ${sources.join(' + ')}` : ''}` : 'Writes allowed',
  );
</script>

<span
  class="chip"
  class:ro={readOnly}
  title={readOnly ? 'Modifying SQL is rejected before it runs' : 'Writes need query:write'}
>
  <span aria-hidden="true">{readOnly ? '🔒' : '✎'}</span>{label}
</span>

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 20px;
    padding: 0 6px;
    border-radius: var(--radius-chip);
    border: 1px solid var(--color-writes-border);
    background: var(--color-writes-bg);
    color: var(--color-writes);
    font-size: 12px;
    white-space: nowrap;
  }
  .ro {
    color: var(--color-policy);
    background: var(--color-policy-bg);
    border-color: var(--color-policy-border);
  }
</style>
