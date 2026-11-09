<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    label,
    level = 1,
    expanded,
    selected = false,
    icon = '',
    onToggle,
    onSelect,
    trailing,
  }: {
    label: string;
    level?: number;
    expanded?: boolean;
    selected?: boolean;
    icon?: string;
    onToggle?: () => void;
    onSelect?: () => void;
    trailing?: Snippet;
  } = $props();

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect?.();
    } else if (event.key === 'ArrowRight' && expanded === false) onToggle?.();
    else if (event.key === 'ArrowLeft' && expanded === true) onToggle?.();
  }
</script>

<div
  class="row"
  class:selected
  role="treeitem"
  aria-level={level}
  aria-expanded={expanded}
  aria-selected={selected}
  tabindex="-1"
  style="padding-left: {8 + (level - 1) * 14}px"
  onclick={() => onSelect?.()}
  onkeydown={keydown}
>
  {#if expanded !== undefined}
    <button
      class="twisty"
      tabindex="-1"
      aria-hidden="true"
      onclick={(e) => (e.stopPropagation(), onToggle?.())}>{expanded ? '▾' : '▸'}</button
    >
  {:else}
    <span class="twisty"></span>
  {/if}
  {#if icon}<span class="icon" aria-hidden="true">{icon}</span>{/if}
  <span class="label">{label}</span>
  {#if trailing}<span class="trailing">{@render trailing()}</span>{/if}
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 26px;
    padding-right: 8px;
    cursor: pointer;
    border-radius: 4px;
  }
  .row:hover {
    background: var(--color-panel-subtle);
  }
  .selected {
    background: var(--color-accent-soft);
  }
  .twisty {
    width: 16px;
    border: 0;
    background: none;
    padding: 0;
    color: var(--color-text-muted);
    cursor: pointer;
  }
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .trailing {
    color: var(--color-text-muted);
    font-size: 12px;
  }
</style>
