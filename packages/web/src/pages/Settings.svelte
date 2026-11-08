<script lang="ts">
  import { onMount } from 'svelte';
  import Banner from '../components/Banner.svelte';
  import KeyValueList from '../components/KeyValueList.svelte';
  import { api } from '../lib/api';
  import { latestOnly } from '../lib/latest';
  import { signOut } from '../lib/auth';
  import { navigate } from '../lib/router.svelte';
  import { can, session } from '../lib/session.svelte';
  import { toast } from '../lib/toasts.svelte';

  interface Defaults {
    ordinaryTimeoutMs: number;
    fullTimeoutMaxMs: number;
    concurrencyPerConnection: number;
    workingRetentionHours: number;
    retainedMaxDays: number;
    metadataRetentionDays: number;
    monitoringRefreshSeconds: number;
  }
  interface AuditEvent {
    id: number;
    at: string;
    actorLabel: string;
    source: string;
    action: string;
    targetLabel: string | null;
    outcome: string;
    details: Record<string, unknown>;
  }

  let defaults = $state<Defaults | null>(null);
  let storage = $state<{ usedBytes: number; totalLimitBytes: number; executionLimitBytes: number } | null>(
    null,
  );
  let retained = $state<{ id: string; title: string; resultExpiresAt: string | null; retention: string }[]>(
    [],
  );
  let audit = $state<AuditEvent[]>([]);
  let auditFilter = $state({ actionPrefix: '', source: '' });
  const admin = $derived(can('settings.manage'));
  const auditor = $derived(can('audit.view'));
  const usage = $derived(storage ? storage.usedBytes / storage.totalLimitBytes : 0);
  const mib = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MiB`;

  // Only the newest audit filter's answer is shown.
  const beginAudit = latestOnly();
  async function loadAudit() {
    const current = beginAudit();
    const q = [
      auditFilter.actionPrefix && `actionPrefix=${encodeURIComponent(auditFilter.actionPrefix)}`,
      auditFilter.source && `source=${auditFilter.source}`,
      'limit=100',
    ]
      .filter(Boolean)
      .join('&');
    const loaded = await api<AuditEvent[]>('GET', `/audit?${q}`);
    if (current()) audit = loaded;
  }
  onMount(async () => {
    defaults = await api<Defaults>('GET', '/settings/execution');
    storage = await api('GET', '/settings/storage');
    if (can('sql.read'))
      retained = (await api<typeof retained>('GET', '/executions?limit=200')).filter(
        (e) => e.retention === 'retained',
      );
    if (auditor) await loadAudit();
  });

  async function save() {
    if (!defaults) return;
    try {
      defaults = await api<Defaults>('PATCH', '/settings/execution', defaults);
      toast('Execution defaults saved.', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'danger');
    }
  }
  const FIELDS: [keyof Defaults, string][] = [
    ['ordinaryTimeoutMs', 'Ordinary timeout (ms)'],
    ['fullTimeoutMaxMs', 'Full result timeout maximum (ms)'],
    ['concurrencyPerConnection', 'Running executions per connection'],
    ['workingRetentionHours', 'Working results kept (hours)'],
    ['retainedMaxDays', 'Retained results kept at most (days)'],
    ['metadataRetentionDays', 'Execution history kept (days)'],
    ['monitoringRefreshSeconds', 'Monitoring refresh (seconds)'],
  ];
</script>

<section class="panel">
  <p class="section-label">Identity</p>
  {#if session.user}
    <KeyValueList
      items={[
        { label: 'Name', value: session.user.displayName },
        { label: 'User', value: session.user.username },
        { label: 'Roles', value: session.user.roles.join(', ') },
        { label: 'Permissions', value: session.permissions.join(', ') },
      ]}
    />
  {/if}
  <p class="note">Roles are managed in Keycloak.</p>
  <button class="button" onclick={() => void signOut()}>Sign out</button>
</section>

<section class="panel">
  <p class="section-label">Execution defaults {admin ? '' : '· read-only'}</p>
  {#if defaults}
    <form class="grid" onsubmit={(e) => (e.preventDefault(), void save())}>
      {#each FIELDS as [key, label] (key)}
        <label class="field"
          ><span>{label}</span><input type="number" bind:value={defaults[key]} disabled={!admin} /></label
        >
      {/each}
      {#if admin}<button class="button primary" type="submit">Save defaults</button>{/if}
    </form>
  {/if}
</section>

<section class="panel">
  <p class="section-label">Retention and storage</p>
  {#if storage}
    <div
      class="meter"
      role="meter"
      aria-valuemin="0"
      aria-valuemax={storage.totalLimitBytes}
      aria-valuenow={storage.usedBytes}
      aria-label="Captured result storage"
    >
      <span style="width: {Math.min(100, usage * 100)}%" class:warn={usage > 0.8}></span>
    </div>
    <p data-testid="storage">
      {mib(storage.usedBytes)} of {mib(storage.totalLimitBytes)} used by captured results · {mib(
        storage.executionLimitBytes,
      )} per execution
    </p>
    {#if usage > 0.8}<Banner tone="warning" title="Storage is nearly full."
        >Full captures may become quota-limited. Delete retained results you no longer need.</Banner
      >{/if}
  {/if}
  <p class="section-label">Retained results</p>
  {#each retained as r (r.id)}
    <p>
      <a href="/executions/{r.id}" onclick={(e) => (e.preventDefault(), navigate(`/executions/${r.id}`))}
        >{r.title}</a
      >
      · kept until {r.resultExpiresAt ? new Date(r.resultExpiresAt).toLocaleString() : '—'}
    </p>
  {:else}<p class="note">
      No retained results. Working results are kept for {defaults?.workingRetentionHours ?? 24} hours.
    </p>{/each}
</section>

{#if auditor}
  <section class="panel">
    <p class="section-label">Audit events</p>
    <form class="filters" onsubmit={(e) => (e.preventDefault(), void loadAudit())}>
      <label class="field"
        ><span>Action starts with</span><input
          bind:value={auditFilter.actionPrefix}
          placeholder="connection."
        /></label
      >
      <label class="field"
        ><span>Source</span><select bind:value={auditFilter.source}
          ><option value="">Any</option><option value="gui">GUI</option><option value="api">API</option
          ><option value="mcp">MCP</option><option value="server">Server</option></select
        ></label
      >
      <button class="button" type="submit">Filter</button>
    </form>
    <table class="list" data-testid="audit">
      <thead
        ><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Outcome</th><th>Details</th></tr
        ></thead
      >
      <tbody>
        {#each audit as e (e.id)}
          <tr
            ><td>{new Date(e.at).toLocaleString()}</td><td>{e.actorLabel} · {e.source}</td><td>{e.action}</td
            ><td>{e.targetLabel ?? ''}</td><td>{e.outcome}</td><td class="mono"
              >{JSON.stringify(e.details)}</td
            ></tr
          >
        {/each}
      </tbody>
    </table>
    <p class="note">
      Sensitive details (passwords, tokens, SQL parameters) are redacted before they are stored.
    </p>
  </section>
{/if}

<style>
  .panel {
    background: var(--color-panel);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    padding: 12px 16px;
    margin-bottom: 14px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 10px;
    align-items: end;
  }
  .note {
    color: var(--color-text-muted);
    font: var(--text-dense);
  }
  .meter {
    height: 8px;
    border-radius: 4px;
    background: var(--color-neutral-bg);
    overflow: hidden;
  }
  .meter span {
    display: block;
    height: 100%;
    background: var(--color-accent);
  }
  .meter .warn {
    background: var(--color-warning);
  }
  .filters {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    margin-bottom: 8px;
  }
  .list {
    width: 100%;
    border-collapse: collapse;
  }
  th,
  td {
    padding: 4px 8px;
    text-align: left;
    border-bottom: 1px solid var(--color-border);
    vertical-align: top;
  }
  td.mono {
    max-width: 360px;
    word-break: break-word;
  }
</style>
