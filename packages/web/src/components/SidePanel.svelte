<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * Modal side panel. Focus moves into it when it opens, stays inside while it is open, Escape
   * closes it, and focus returns to what had it before.
   */
  let {
    open,
    title,
    onClose,
    children,
    footer,
    width = 440,
  }: {
    open: boolean;
    title: string;
    onClose: () => void;
    children: Snippet;
    footer?: Snippet;
    width?: number;
  } = $props();

  let panel = $state<HTMLElement | null>(null);
  let returnTo: HTMLElement | null = null;

  const focusable = () =>
    panel
      ? [
          ...panel.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          ),
        ].filter((e) => !e.hasAttribute('disabled'))
      : [];

  $effect(() => {
    if (open && panel) {
      returnTo = document.activeElement as HTMLElement | null;
      (focusable()[0] ?? panel).focus();
      return () => returnTo?.focus?.();
    }
  });

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    } else if (event.key === 'Tab') {
      const items = focusable();
      if (!items.length) return;
      const firstItem = items[0] as HTMLElement;
      const lastItem = items[items.length - 1] as HTMLElement;
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    }
  }
</script>

{#if open}
  <div class="backdrop" role="presentation" onclick={onClose}></div>
  <div
    class="panel"
    role="dialog"
    aria-modal="true"
    aria-labelledby="side-panel-title"
    tabindex="-1"
    style="width: {width}px"
    bind:this={panel}
    onkeydown={keydown}
  >
    <header>
      <h2 id="side-panel-title">{title}</h2>
      <button class="close" aria-label="Close" onclick={onClose}>✕</button>
    </header>
    <div class="content">{@render children()}</div>
    {#if footer}<footer>{@render footer()}</footer>{/if}
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(20, 25, 37, 0.24);
    z-index: 20;
  }
  .panel {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    max-width: 100vw;
    z-index: 21;
    display: flex;
    flex-direction: column;
    background: var(--color-panel);
    box-shadow: var(--shadow-overlay);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--color-border);
  }
  h2 {
    margin: 0;
    font: var(--text-panel-title);
  }
  .close {
    border: 0;
    background: none;
    font-size: 16px;
    cursor: pointer;
    color: var(--color-text-muted);
  }
  .content {
    flex: 1;
    overflow: auto;
    padding: 16px 20px;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px;
    border-top: 1px solid var(--color-border);
  }
</style>
