<script lang="ts">
  let { items }: { items: { label: string; value: string | number | null | undefined }[] } = $props();
</script>

<dl class="kv">
  {#each items as item (item.label)}
    <dt>{item.label}</dt>
    <dd>{item.value ?? '—'}</dd>
  {/each}
</dl>

<style>
  .kv {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 6px 16px;
    margin: 0;
  }
  dt {
    color: var(--color-text-muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
