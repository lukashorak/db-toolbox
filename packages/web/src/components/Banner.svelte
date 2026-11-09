<script lang="ts">
  import type { Snippet } from 'svelte';
  import { TONE_ICON, type Tone } from '../lib/labels';

  let { tone = 'info', title, children }: { tone?: Tone; title: string; children?: Snippet } = $props();
</script>

<div class="banner {tone}" role={tone === 'danger' ? 'alert' : 'status'}>
  <span class="icon" aria-hidden="true">{TONE_ICON[tone]}</span>
  <div>
    <strong>{title}</strong>
    {#if children}<div class="body">{@render children()}</div>{/if}
  </div>
</div>

<style>
  .banner {
    display: flex;
    gap: 10px;
    padding: 10px 14px;
    border-radius: 8px;
    border: 1px solid transparent;
  }
  .icon {
    font-weight: 700;
  }
  .body {
    margin-top: 2px;
    font: var(--text-dense);
  }
  .neutral {
    background: var(--color-neutral-bg);
    color: var(--color-neutral);
  }
  .info {
    background: var(--color-info-bg);
    color: var(--color-info);
  }
  .success {
    background: var(--color-success-bg);
    color: var(--color-success);
  }
  .warning {
    background: var(--color-warning-bg);
    color: var(--color-warning);
  }
  .danger {
    background: var(--color-danger-bg);
    color: var(--color-danger);
  }
</style>
