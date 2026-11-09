<script lang="ts">
  import type { Snippet } from 'svelte';
  import SidePanel from './SidePanel.svelte';

  /** Confirmation that lists the consequences before a destructive action. */
  let {
    open,
    title,
    consequences,
    confirmLabel,
    danger = false,
    busy = false,
    onConfirm,
    onClose,
    children,
  }: {
    open: boolean;
    title: string;
    consequences: string[];
    confirmLabel: string;
    danger?: boolean;
    busy?: boolean;
    onConfirm: () => void;
    onClose: () => void;
    /** Choices that change the consequences (for example what happens to a folder's contents). */
    children?: Snippet;
  } = $props();
</script>

<SidePanel {open} {title} {onClose}>
  {#if children}{@render children()}{/if}
  <p class="section-label">What happens</p>
  <ul>
    {#each consequences as item (item)}<li>{item}</li>{/each}
  </ul>
  {#snippet footer()}
    <button class="button" onclick={onClose}>Cancel</button>
    <button class="button {danger ? 'danger' : 'primary'}" disabled={busy} onclick={onConfirm}
      >{confirmLabel}</button
    >
  {/snippet}
</SidePanel>
