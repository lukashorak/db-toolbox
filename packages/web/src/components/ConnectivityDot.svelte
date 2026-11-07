<script lang="ts" module>
  export type Connectivity = 'reachable' | 'limited' | 'unreachable' | 'disabled' | 'untested';
</script>

<script lang="ts">
  let { state }: { state: Connectivity } = $props();
  const labels: Record<Connectivity, string> = {
    reachable: 'Reachable',
    limited: 'Reachable · limited',
    unreachable: 'Unreachable',
    disabled: 'Disabled',
    untested: 'Not tested',
  };
</script>

<span class="conn {state}"><span class="dot" aria-hidden="true"></span>{labels[state]}</span>

<style>
  .conn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--color-neutral);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--dot-off);
  }
  .reachable {
    color: var(--color-success);
  }
  .reachable .dot {
    background: var(--dot-ok);
  }
  .limited {
    color: var(--color-warning);
  }
  .limited .dot {
    background: var(--dot-limited);
  }
  .unreachable {
    color: var(--color-danger);
  }
  .unreachable .dot {
    background: var(--dot-bad);
  }
</style>
