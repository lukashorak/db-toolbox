<script lang="ts">
  import { dismiss, toasts } from '../lib/toasts.svelte';
</script>

<div class="toasts" role="status" aria-live="polite" aria-relevant="additions">
  {#each toasts as t (t.id)}
    <div class="toast {t.tone}">
      <span>{t.message}</span>
      <button aria-label="Dismiss" onclick={() => dismiss(t.id)}>✕</button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 30;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .toast {
    display: flex;
    gap: 12px;
    align-items: center;
    min-width: 260px;
    max-width: 420px;
    padding: 10px 12px;
    border-radius: 8px;
    background: var(--color-nav);
    color: #fff;
    box-shadow: var(--shadow-overlay);
  }
  .toast.danger {
    background: var(--color-danger);
  }
  .toast.success {
    background: var(--color-success);
  }
  button {
    margin-left: auto;
    border: 0;
    background: none;
    color: inherit;
    cursor: pointer;
  }
</style>
