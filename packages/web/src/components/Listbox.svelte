<script lang="ts">
  /** Single-select listbox with arrow-key navigation. */
  let {
    label,
    options,
    value,
    onChange,
  }: {
    label: string;
    options: { value: string; label: string }[];
    value: string | null;
    onChange: (value: string) => void;
  } = $props();

  function keydown(event: KeyboardEvent) {
    const at = options.findIndex((o) => o.value === value);
    const next = event.key === 'ArrowDown' ? at + 1 : event.key === 'ArrowUp' ? at - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const option = options[Math.max(0, Math.min(options.length - 1, next))];
    if (option) onChange(option.value);
  }
</script>

<div
  class="listbox"
  role="listbox"
  aria-label={label}
  tabindex="0"
  aria-activedescendant={value ? `opt-${value}` : undefined}
  onkeydown={keydown}
>
  {#each options as option (option.value)}
    <div
      id="opt-{option.value}"
      role="option"
      aria-selected={option.value === value}
      class:selected={option.value === value}
      tabindex="-1"
      onclick={() => onChange(option.value)}
      onkeydown={() => undefined}
    >
      {option.label}
    </div>
  {/each}
</div>

<style>
  .listbox {
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-panel);
    padding: 4px;
  }
  [role='option'] {
    padding: 6px 10px;
    border-radius: 4px;
    cursor: pointer;
  }
  .selected {
    background: var(--color-accent-soft);
  }
</style>
