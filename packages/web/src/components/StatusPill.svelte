<script lang="ts">
  import { CAPTURE, EXECUTION, MONITORING, TONE_ICON, TRANSACTION, type Tone } from '../lib/labels';

  /** A status with a label, an icon and a color: never color alone. */
  let { kind, value }: { kind: 'execution' | 'transaction' | 'capture' | 'monitoring'; value: string } =
    $props();
  const table = { execution: EXECUTION, transaction: TRANSACTION, capture: CAPTURE, monitoring: MONITORING };
  const entry = $derived<[string, Tone]>(table[kind][value] ?? [value, 'neutral']);
</script>

<span class="pill {entry[1]}" data-kind={kind} data-value={value}>
  <span class="icon" aria-hidden="true">{TONE_ICON[entry[1]]}</span>{entry[0]}
</span>

<style>
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 20px;
    padding: 0 8px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
  }
  .icon {
    font-size: 10px;
  }
  .neutral {
    color: var(--color-neutral);
    background: var(--color-neutral-bg);
  }
  .info {
    color: var(--color-info);
    background: var(--color-info-bg);
  }
  .success {
    color: var(--color-success);
    background: var(--color-success-bg);
  }
  .warning {
    color: var(--color-warning);
    background: var(--color-warning-bg);
  }
  .danger {
    color: var(--color-danger);
    background: var(--color-danger-bg);
  }
</style>
