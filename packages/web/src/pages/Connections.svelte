<script lang="ts">
  import { onMount } from 'svelte';
  import Banner from '../components/Banner.svelte';
  import ConfirmPanel from '../components/ConfirmPanel.svelte';
  import ConnectionForm from '../components/ConnectionForm.svelte';
  import ConnectivityDot, { type Connectivity } from '../components/ConnectivityDot.svelte';
  import EnvLabel from '../components/EnvLabel.svelte';
  import KeyValueList from '../components/KeyValueList.svelte';
  import PolicyChip from '../components/PolicyChip.svelte';
  import SidePanel from '../components/SidePanel.svelte';
  import TestReportView from '../components/TestReportView.svelte';
  import { api } from '../lib/api';
  import { latestOnly } from '../lib/latest';
  import { can } from '../lib/session.svelte';
  import { toast } from '../lib/toasts.svelte';
  import type { Connection, References, TestReport } from '../lib/types';

  let connections = $state<Connection[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let selected = $state<Connection | null>(null);
  let references = $state<References | null>(null);
  let editing = $state<{ open: boolean; connection: Connection | null }>({ open: false, connection: null });
  let confirm = $state<'delete' | 'disable' | null>(null);
  let busy = $state(false);
  const manage = $derived(can('connections.manage'));

  const connectivity = (c: Connection): Connectivity =>
    !c.enabled
      ? 'disabled'
      : !c.lastTestResult
        ? 'untested'
        : c.lastTestResult.ok
          ? c.lastTestResult.capabilities.every((x) => x.available)
            ? 'reachable'
            : 'limited'
          : 'unreachable';

  // A reload after a change can overlap an earlier one: only the newest answer is shown.
  const beginLoad = latestOnly();
  async function load() {
    const current = beginLoad();
    try {
      const loaded = await api<Connection[]>('GET', '/connections');
      if (!current()) return;
      connections = loaded;
      error = null;
      if (selected) selected = connections.find((c) => c.id === selected?.id) ?? null;
    } catch (e) {
      if (current()) error = e instanceof Error ? e.message : String(e);
    } finally {
      // Only the newest load ends "Loading": an older one ending first would show an empty list.
      if (current()) loading = false;
    }
  }
  onMount(load);

  const beginReferences = latestOnly();
  async function open(c: Connection) {
    selected = c;
    references = null;
    // Another connection opened meanwhile: its references, not this one's, belong in the panel.
    const current = beginReferences();
    const loaded = await api<References>('GET', `/connections/${c.id}/references`);
    if (current()) references = loaded;
  }

  async function test(c: Connection) {
    busy = true;
    try {
      const report = await api<TestReport>('POST', `/connections/${c.id}/test`);
      toast(
        report.ok ? `${c.name}: connected` : `${c.name}: ${report.failure?.message}`,
        report.ok ? 'success' : 'danger',
      );
      await load();
    } catch (e) {
      toast(`${c.name}: the test could not run. ${e instanceof Error ? e.message : String(e)}`, 'danger');
    } finally {
      busy = false;
    }
  }

  async function act() {
    if (!selected || !confirm) return;
    busy = true;
    try {
      if (confirm === 'delete') {
        await api('DELETE', `/connections/${selected.id}`);
        toast(`${selected.name} deleted`, 'success');
        selected = null;
      } else {
        await api('POST', `/connections/${selected.id}/${selected.enabled ? 'disable' : 'enable'}`);
      }
      confirm = null;
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'danger');
    } finally {
      busy = false;
    }
  }

  const consequences = $derived(
    !selected || !references
      ? []
      : confirm === 'delete'
        ? [
            'The stored settings and encrypted password are removed. The target database is not touched.',
            `${references.savedQueries.length} saved quer${references.savedQueries.length === 1 ? 'y loses' : 'ies lose'} their default connection.`,
            references.profiles.length
              ? `MCP profiles lose access: ${references.profiles.map((p) => p.name).join(', ')}.`
              : 'No MCP profile uses it.',
            'Execution history keeps the connection name.',
          ]
        : [
            'New executions on this connection are refused, including queued ones when they would start.',
            'Running executions are not stopped.',
          ],
  );
</script>

<div class="bar">
  <p class="section-label">Stored connections</p>
  {#if manage}<button class="button primary" onclick={() => (editing = { open: true, connection: null })}
      >Add connection</button
    >{/if}
</div>
{#if error}<Banner tone="danger" title="Connections could not be loaded.">{error}</Banner>{/if}
{#if loading}
  <p role="status">Loading…</p>
{:else if !connections.length}
  <Banner tone="neutral" title="No connections yet."
    >{manage ? 'Add one to start.' : 'An administrator adds connections.'}</Banner
  >
{:else}
  <table class="list" data-testid="connections">
    <thead><tr><th>Name</th><th>Engine</th><th>Environment</th><th>Policy</th><th>Status</th></tr></thead>
    <tbody>
      {#each connections as c (c.id)}
        <tr class:selected={selected?.id === c.id} data-name={c.name}>
          <td><button class="link" onclick={() => void open(c)}>{c.name}</button></td>
          <td>{c.engine === 'postgresql' ? 'PostgreSQL' : 'MySQL'}</td>
          <td><EnvLabel environment={c.environment} /></td>
          <td><PolicyChip readOnly={c.readOnly} sources={c.readOnly ? ['connection'] : []} /></td>
          <td><ConnectivityDot state={connectivity(c)} /></td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<SidePanel
  open={selected !== null && !editing.open && confirm === null}
  title={selected?.name ?? ''}
  onClose={() => (selected = null)}
  width={500}
>
  {#if selected}
    <KeyValueList
      items={[
        { label: 'Engine', value: selected.engine },
        { label: 'Host', value: `${selected.host}:${selected.port}` },
        { label: 'Database', value: selected.database },
        { label: 'Schema', value: selected.schema },
        { label: 'User', value: selected.username },
        { label: 'TLS', value: `${selected.tlsMode}${selected.hasCustomCa ? ' · custom CA' : ''}` },
        { label: 'Monitoring account', value: selected.monitorUsername },
        { label: 'Transport', value: 'Direct (SSH planned)' },
        {
          label: 'Last test',
          value: selected.lastTestAt ? new Date(selected.lastTestAt).toLocaleString() : 'Never',
        },
      ]}
    />
    {#if selected.lastTestResult}<p class="section-label">Last test</p>
      <TestReportView report={selected.lastTestResult} />{/if}
    {#if references}
      <p class="section-label">Used by</p>
      <p data-testid="references">
        {references.savedQueries.length} saved queries · {references.profiles.length} MCP profiles · {references
          .activeExecutions.length} active executions
      </p>
    {/if}
  {/if}
  {#snippet footer()}
    {#if manage && selected}
      <button class="button" disabled={busy} onclick={() => void test(selected as Connection)}>Test</button>
      <button class="button" onclick={() => (editing = { open: true, connection: selected })}>Edit</button>
      <button class="button" onclick={() => (confirm = 'disable')}
        >{selected.enabled ? 'Disable' : 'Enable'}</button
      >
      <button class="button danger" onclick={() => (confirm = 'delete')}>Delete</button>
    {/if}
  {/snippet}
</SidePanel>

<ConnectionForm
  open={editing.open}
  connection={editing.connection}
  onClose={() => (editing = { open: false, connection: null })}
  onSaved={(c) => {
    editing = { open: false, connection: null };
    toast(`${c.name} saved`, 'success');
    void load().then(() => void open(c));
  }}
/>

<ConfirmPanel
  open={confirm !== null}
  title={confirm === 'delete'
    ? `Delete ${selected?.name}?`
    : `${selected?.enabled ? 'Disable' : 'Enable'} ${selected?.name}?`}
  consequences={selected?.enabled === false && confirm === 'disable'
    ? ['New executions are allowed again.']
    : consequences}
  confirmLabel={confirm === 'delete' ? 'Delete connection' : selected?.enabled ? 'Disable' : 'Enable'}
  danger={confirm === 'delete'}
  {busy}
  onConfirm={() => void act()}
  onClose={() => (confirm = null)}
/>

<style>
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .list {
    width: 100%;
    border-collapse: collapse;
    background: var(--color-panel);
    border: 1px solid var(--color-border);
  }
  th,
  td {
    padding: 8px 12px;
    text-align: left;
    border-bottom: 1px solid var(--color-border);
  }
  th {
    font: var(--text-label);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
  }
  tr.selected {
    background: var(--color-accent-soft);
  }
  .link {
    border: 0;
    background: none;
    padding: 0;
    color: var(--color-accent);
    cursor: pointer;
    font-weight: 500;
  }
</style>
