<script lang="ts">
  /** A menu button: Enter or ArrowDown opens it, arrows move, Escape closes and returns focus. */
  let {
    label,
    items,
  }: { label: string; items: { label: string; onSelect: () => void; disabled?: boolean }[] } = $props();
  let open = $state(false);
  let button = $state<HTMLButtonElement | null>(null);
  let list = $state<HTMLElement | null>(null);

  function focusItem(index: number) {
    const all = list
      ? [...list.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')]
      : [];
    all[(index + all.length) % all.length]?.focus();
  }
  function toggle() {
    open = !open;
    if (open) queueMicrotask(() => focusItem(0));
  }
  function keydown(event: KeyboardEvent) {
    const all = list
      ? [...list.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')]
      : [];
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') focusItem(at + 1);
    else if (event.key === 'ArrowUp') focusItem(at - 1);
    else if (event.key === 'Escape') {
      open = false;
      button?.focus();
    } else return;
    event.preventDefault();
  }
</script>

<div class="menu">
  <button class="button" aria-haspopup="menu" aria-expanded={open} bind:this={button} onclick={toggle}
    >{label} ▾</button
  >
  {#if open}
    <div class="list" role="menu" tabindex="-1" bind:this={list} onkeydown={keydown}>
      {#each items as item (item.label)}
        <button
          role="menuitem"
          aria-disabled={item.disabled ? 'true' : undefined}
          disabled={item.disabled}
          onclick={() => {
            open = false;
            button?.focus();
            item.onSelect();
          }}>{item.label}</button
        >
      {/each}
    </div>
  {/if}
</div>

<style>
  .menu {
    position: relative;
    display: inline-block;
  }
  .list {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    z-index: 25;
    min-width: 180px;
    padding: 4px;
    background: var(--color-panel);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: var(--shadow-overlay);
  }
  .list button {
    display: block;
    width: 100%;
    padding: 6px 10px;
    border: 0;
    border-radius: 4px;
    background: none;
    text-align: left;
    cursor: pointer;
  }
  .list button:hover,
  .list button:focus-visible {
    background: var(--color-accent-soft);
  }
</style>
