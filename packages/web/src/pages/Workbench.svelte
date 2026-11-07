<script lang="ts">
  import { onMount } from 'svelte';
  import { session } from '../lib/session.svelte';
  import { loadTabs, saveTabs, type DraftTab } from '../lib/storage';

  /** Step 9: tabs and SQL drafts that survive reloads. The editor and runs arrive in step 11. */
  let tabs = $state<DraftTab[]>([]);
  let active = $state<string | null>(null);
  const subject = $derived(session.user?.subject ?? 'anonymous');
  const current = $derived(tabs.find((t) => t.id === active) ?? null);

  onMount(() => {
    const saved = loadTabs(subject);
    tabs = saved.tabs.length
      ? saved.tabs
      : [{ id: crypto.randomUUID(), title: 'Query 1', sql: '', connectionId: null }];
    active = saved.active && tabs.some((t) => t.id === saved.active) ? saved.active : (tabs[0]?.id ?? null);
  });

  $effect(() => {
    if (tabs.length) saveTabs(subject, { tabs: $state.snapshot(tabs), active });
  });

  function add() {
    const tab = { id: crypto.randomUUID(), title: `Query ${tabs.length + 1}`, sql: '', connectionId: null };
    tabs.push(tab);
    active = tab.id;
  }
  function close(id: string) {
    const at = tabs.findIndex((t) => t.id === id);
    tabs.splice(at, 1);
    if (active === id) active = tabs[Math.max(0, at - 1)]?.id ?? null;
  }
</script>

<div class="tabs" role="tablist" aria-label="Query tabs">
  {#each tabs as tab (tab.id)}
    <div class="tab" class:active={tab.id === active}>
      <button role="tab" aria-selected={tab.id === active} onclick={() => (active = tab.id)}
        >{tab.title}</button
      >
      {#if tabs.length > 1}<button class="x" aria-label="Close {tab.title}" onclick={() => close(tab.id)}
          >✕</button
        >{/if}
    </div>
  {/each}
  <button class="add" aria-label="New tab" onclick={add}>＋</button>
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
