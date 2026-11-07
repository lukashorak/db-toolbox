<script lang="ts" module>
  export interface GridColumn {
    name: string;
    type: string;
    binary?: boolean;
  }
</script>

<script lang="ts">
  /**
   * Virtualized result grid (at most 1,000 rows are held in the browser). NULL is shown as an
   * italic NULL, never as an empty cell; binary values say so.
   */
  let {
    columns,
    rows,
    height = 360,
    onSelectRow,
  }: {
    columns: GridColumn[];
    rows: (string | null)[][];
    height?: number;
    onSelectRow?: (index: number) => void;
  } = $props();

  const ROW = 26;
  let scrollTop = $state(0);
  let active = $state(-1);
  const first = $derived(Math.max(0, Math.floor(scrollTop / ROW) - 5));
  const last = $derived(Math.min(rows.length, Math.ceil((scrollTop + height) / ROW) + 5));
  const visible = $derived(rows.slice(first, last));

  function keydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown') active = Math.min(rows.length - 1, active + 1);
    else if (event.key === 'ArrowUp') active = Math.max(0, active - 1);
    else if (event.key === 'Enter' && active >= 0) onSelectRow?.(active);
    else return;
    event.preventDefault();
  }
</script>

<div
  class="grid"
  role="grid"
  aria-rowcount={rows.length + 1}
  aria-colcount={columns.length + 1}
  tabindex="0"
  style="height: {height}px"
  onscroll={(e) => (scrollTop = (e.currentTarget as HTMLElement).scrollTop)}
  onkeydown={keydown}
>
  <div class="head" role="row" aria-rowindex="1">
    <span class="num" role="columnheader">#</span>
    {#each columns as column, i (i)}
      <span role="columnheader" title={column.type}>{column.name}<small>{column.type}</small></span>
    {/each}
  </div>
  <div class="body" style="height: {rows.length * ROW}px">
    {#each visible as row, i (first + i)}
      <div
        class="row"
        class:active={first + i === active}
        role="row"
        aria-rowindex={first + i + 2}
        style="top: {(first + i) * ROW}px"
        tabindex="-1"
        onclick={() => ((active = first + i), onSelectRow?.(first + i))}
        onkeydown={(e) => e.key === 'Enter' && onSelectRow?.(first + i)}
      >
        <span class="num" role="rowheader">{first + i + 1}</span>
        {#each row as value, c (c)}
          {#if value === null}
            <span class="null" role="gridcell">NULL</span>
          {:else if columns[c]?.binary}
            <span class="binary" role="gridcell" title={value}
              >binary · {Math.max(0, (value.length - 2) / 2)} bytes</span
            >
          {:else}
            <span role="gridcell" title={value.length > 60 ? value : undefined}>{value}</span>
          {/if}
        {/each}
      </div>
    {/each}
  </div>
</div>

<style>
  .grid {
    position: relative;
    overflow: auto;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-panel);
    font-family: var(--font-mono);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .head,
  .row {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(120px, 1fr);
    grid-template-columns: 56px;
    align-items: center;
  }
  .head {
    position: sticky;
    top: 0;
    z-index: 1;
    height: 34px;
    background: var(--color-panel-subtle);
    border-bottom: 1px solid var(--color-border);
    font-family: var(--font-ui);
    font-weight: 600;
  }
  .head small {
    display: block;
    font-weight: 400;
    font-size: 10.5px;
    color: var(--color-text-muted);
  }
  .body {
    position: relative;
  }
  .row {
    position: absolute;
    left: 0;
    right: 0;
    height: 26px;
    border-bottom: 1px solid #eef0f3;
  }
  .row.active {
    background: var(--color-accent-soft);
  }
  .row span,
  .head span {
    padding: 0 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .num {
    color: var(--color-text-muted);
    text-align: right;
  }
  .null {
    color: var(--sql-null);
    font-style: italic;
  }
  .binary {
    color: var(--color-neutral);
  }
</style>
