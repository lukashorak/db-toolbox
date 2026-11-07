<script lang="ts">
  import { onMount } from 'svelte';
  import { addTab, closeTab, ensureLoaded, persist, workbench } from '../lib/tabs.svelte';

  /** Tabs and SQL drafts that survive reloads. The editor and runs arrive in step 11. */
  const current = $derived(workbench.tabs.find((t) => t.id === workbench.active) ?? null);
  onMount(ensureLoaded);
  $effect(() => {
    void JSON.stringify(workbench.tabs);
    void workbench.active;
    persist();
  });
</script>

<div class="tabs" role="tablist" aria-label="Query tabs">
  {#each workbench.tabs as tab (tab.id)}
    <div class="tab" class:active={tab.id === workbench.active}>
      <button
        role="tab"
        aria-selected={tab.id === workbench.active}
        onclick={() => (workbench.active = tab.id)}>{tab.title}</button
      >
      {#if workbench.tabs.length > 1}<button
          class="x"
          aria-label="Close {tab.title}"
          onclick={() => closeTab(tab.id)}>✕</button
        >{/if}
    </div>
  {/each}
  <button class="add" aria-label="New tab" onclick={addTab}>＋</button>
</div>
{#if current}
  <label class="field editor">
    <span>SQL draft · saved in this browser</span>
    <textarea rows="14" spellcheck="false" bind:value={current.sql} data-testid="sql-draft" class="mono"
    ></textarea>
  </label>
{/if}

<style>
  .tabs {
    display: flex;
    gap: 2px;
    border-bottom: 1px solid var(--color-border);
    margin-bottom: 12px;
  }
  .tab {
    display: flex;
    align-items: center;
    border: 1px solid var(--color-border);
    border-bottom: 0;
    border-radius: 6px 6px 0 0;
    background: var(--color-panel-subtle);
  }
  .tab.active {
    background: var(--color-panel);
    box-shadow: inset 0 2px 0 var(--color-accent);
  }
  .tab button,
  .add {
    border: 0;
    background: none;
    padding: 6px 10px;
    cursor: pointer;
  }
  .x {
    color: var(--color-text-muted);
  }
  .editor textarea {
    width: 100%;
    font-size: 12.5px;
    line-height: 20px;
  }
</style>
