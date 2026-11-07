<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Banner from '../components/Banner.svelte';
  import PolicyChip from '../components/PolicyChip.svelte';
  import SidePanel from '../components/SidePanel.svelte';
  import StatusPill from '../components/StatusPill.svelte';
  import { api, ApiError } from '../lib/api';
  import { navigate } from '../lib/router.svelte';
  import { can, jobs, session } from '../lib/session.svelte';
  import { toast } from '../lib/toasts.svelte';
  import type { Connection } from '../lib/types';

  interface Profile {
    id: string;
    name: string;
    clientId: string;
    connectionIds: string[];
    readOnly: boolean;
    enabled: boolean;
    timeoutMs: number;
    previewRows: number;
    previewBytes: number;
  }
  interface Access {
    connectionId: string;
    connectionName: string;
    allowed: boolean;
    policy: { readOnly: boolean; sources: string[] } | null;
  }
  interface Approval {
    id: string;
    executionId: string;
    executionTitle: string;
    connectionName: string;
    resultIndex: number;
    profile: { name: string };
    status: string;
    requested: { rows: number; bytes: number; by: string | null; at: string };
    granted: { rows: number; bytes: number } | null;
    delivered: { rows: number; bytes: number };
    expiresAt: string | null;
  }

  let profiles = $state<Profile[]>([]);
  let access = $state<Record<string, Access[]>>({});
  let connections = $state<Connection[]>([]);
  let approvals = $state<Approval[]>([]);
  let recent = $state<
    { id: string; title: string; status: string; profile: { name: string } | null; submittedAt: string }[]
  >([]);
  let editing = $state<{ profile: Profile | null; form: Omit<Profile, 'id'> } | null>(null);
  let formError = $state<string | null>(null);
  let reviewing = $state<{ approval: Approval; rows: number; minutes: number } | null>(null);
  const admin = $derived(can('profiles.manage'));
  const mcp = $derived(session.config?.mcp ?? null);
  const command = $derived(
    mcp
      ? `claude mcp add --transport http --client-id ${mcp.clientId} --callback-port 8765 workbench ${mcp.url}`
      : '',
  );

  async function load() {
    profiles = await api<Profile[]>('GET', '/profiles');
    for (const p of profiles) access[p.id] = await api<Access[]>('GET', `/profiles/${p.id}/access`);
    if (can('disclosure.decide')) {
      approvals = await api<Approval[]>('GET', '/approvals');
      jobs.pendingApprovals = approvals.filter((a) => a.status === 'pending').length;
    }
    recent = await api<typeof recent>('GET', '/executions?source=mcp&limit=10').catch(() => []);
  }
  onMount(async () => {
    connections = await api<Connection[]>('GET', '/connections');
  });
  // Load now and again whenever an approval changes (a new MCP request arrives live).
  $effect(() => {
    void jobs.approvalChanges;
    untrack(() => void load().catch((e) => toast(e instanceof Error ? e.message : String(e), 'danger')));
  });

  function edit(profile: Profile | null) {
    formError = null;
    editing = {
      profile,
      form: profile
        ? {
            name: profile.name,
            clientId: profile.clientId,
            connectionIds: [...profile.connectionIds],
            readOnly: profile.readOnly,
            enabled: profile.enabled,
            timeoutMs: profile.timeoutMs,
            previewRows: profile.previewRows,
            previewBytes: profile.previewBytes,
          }
        : {
            name: '',
            clientId: 'workbench-mcp',
            connectionIds: [],
            readOnly: true,
            enabled: true,
            timeoutMs: 30000,
            previewRows: 1000,
            previewBytes: 262144,
          },
    };
  }
  const numbers = <T extends { timeoutMs: number; previewRows: number; previewBytes: number }>(f: T): T => ({
    ...f,
    timeoutMs: Number(f.timeoutMs),
    previewRows: Number(f.previewRows),
    previewBytes: Number(f.previewBytes),
  });
  async function save() {
    if (!editing) return;
    const { form, profile } = editing;
    try {
      if (profile) {
        const { clientId: _clientId, ...patch } = form;
        await api('PATCH', `/profiles/${profile.id}`, numbers(patch));
      } else await api('POST', '/profiles', numbers(form));
      editing = null;
      await load();
    } catch (e) {
      formError =
        e instanceof ApiError && e.details?.fields
          ? (e.details.fields as { message: string }[]).map((f) => f.message).join(' ')
          : e instanceof Error
            ? e.message
            : String(e);
    }
  }
  async function decide(
    kind: 'approve' | 'deny' | 'revoke',
    approval: Approval,
    body: Record<string, unknown> = {},
  ) {
    try {
      await api('POST', `/approvals/${approval.id}/${kind}`, body);
      toast(
        kind === 'approve'
          ? 'Approved. The MCP client can read the rows until it expires.'
          : kind === 'deny'
            ? 'Request denied.'
            : 'Approval revoked; further pages are refused.',
        'success',
      );
      reviewing = null;
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'danger');
    }
  }
</script>

<section class="panel">
  <p class="section-label">Endpoint</p>
  {#if mcp}
    <p>
      <code class="mono" data-testid="mcp-url">{mcp.url}</code> · OAuth client
      <code class="mono">{mcp.clientId}</code>
    </p>
    <p class="section-label">Connect Claude Code</p>
    <pre class="mono">{command}</pre>
    <p class="note">
      Then run <code>/mcp</code> in Claude Code and sign in in the browser. Each OAuth client is bound to one profile
      below.
    </p>
  {/if}
</section>

{#if can('disclosure.decide')}
  <section class="panel">
    <p class="section-label">Approvals</p>
    {#each approvals.filter((a) => a.status === 'pending') as a (a.id)}
      <div class="approval" data-testid="pending-approval" data-id={a.id}>
        <div>
          <strong>{a.executionTitle}</strong> · result {a.resultIndex + 1} · {a.connectionName}
          <div class="note">
            {a.profile.name} asks for {a.requested.rows.toLocaleString()} rows (about {Math.max(
              1,
              Math.round(a.requested.bytes / 1024),
            )} KiB) · {new Date(a.requested.at).toLocaleString()}
          </div>
        </div>
        <button
          class="button primary"
          onclick={() => (reviewing = { approval: a, rows: a.requested.rows, minutes: 60 })}>Review</button
        >
        <button class="button" onclick={() => void decide('deny', a)}>Deny</button>
      </div>
    {:else}
      <p class="note">No pending requests.</p>
    {/each}
    {#if approvals.some((a) => a.status === 'active')}
      <p class="section-label">Active</p>
      {#each approvals.filter((a) => a.status === 'active') as a (a.id)}
        <div class="approval" data-testid="active-approval">
          <div>
            <strong>{a.executionTitle}</strong> · {a.profile.name} · {a.delivered.rows.toLocaleString()} of {a.granted?.rows.toLocaleString()}
            rows used
            <div class="note">Expires {a.expiresAt ? new Date(a.expiresAt).toLocaleString() : '—'}</div>
          </div>
          <button class="button danger" onclick={() => void decide('revoke', a)}>Revoke</button>
        </div>
      {/each}
    {/if}
  </section>
{/if}

<section class="panel">
  <div class="head">
    <p class="section-label">Profiles</p>
    {#if admin}<button class="button primary" onclick={() => edit(null)}>Add profile</button>{/if}
  </div>
  {#each profiles as p (p.id)}
    <div class="profile">
      <div class="profile-head">
        <strong>{p.name}</strong> <code class="mono">{p.clientId}</code>
        <PolicyChip readOnly={p.readOnly} sources={p.readOnly ? ['profile'] : []} />
        {#if !p.enabled}<StatusPill kind="execution" value="cancelled" />{/if}
        <span class="note"
          >{p.previewRows.toLocaleString()} rows · {(p.previewBytes / 1024).toFixed(0)} KiB · {p.timeoutMs /
            1000} s</span
        >
        {#if admin}<button class="button" onclick={() => edit(p)}>Edit</button>{/if}
      </div>
      <table class="list">
        <thead><tr><th>Connection</th><th>Effective access through this profile</th></tr></thead>
        <tbody>
          {#each (access[p.id] ?? []).filter((a) => a.allowed) as a (a.connectionId)}
            <tr
              ><td>{a.connectionName}</td><td
                ><PolicyChip readOnly={a.policy?.readOnly ?? true} sources={a.policy?.sources ?? []} /></td
              ></tr
            >
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <Banner tone="neutral" title="No MCP profiles yet."
      >{admin ? 'Add one and bind it to an OAuth client.' : 'An administrator adds profiles.'}</Banner
    >
  {/each}
</section>

<section class="panel">
  <p class="section-label">Recent MCP executions</p>
  {#each recent as e (e.id)}
    <p>
      <a href="/executions/{e.id}" onclick={(ev) => (ev.preventDefault(), navigate(`/executions/${e.id}`))}
        >{e.title}</a
      >
      · {e.profile?.name} · <StatusPill kind="execution" value={e.status} />
    </p>
  {:else}<p class="note">None yet.</p>{/each}
</section>

<SidePanel open={reviewing !== null} title="Approve disclosure" onClose={() => (reviewing = null)}>
  {#if reviewing}
    <p><strong>{reviewing.approval.executionTitle}</strong> · result {reviewing.approval.resultIndex + 1}</p>
    <p>
      Lets <strong>{reviewing.approval.profile.name}</strong> read more rows of this one result than its allowance,
      until the approval expires. It grants no other access.
    </p>
    <label class="field"><span>Rows</span><input type="number" min="1" bind:value={reviewing.rows} /></label>
    <label class="field"
      ><span>Expires after (minutes)</span><input
        type="number"
        min="1"
        bind:value={reviewing.minutes}
      /></label
    >
  {/if}
  {#snippet footer()}
    <button class="button" onclick={() => reviewing && void decide('deny', reviewing.approval)}>Deny</button>
    <button
      class="button primary"
      onclick={() =>
        reviewing &&
        void decide('approve', reviewing.approval, {
          rows: Number(reviewing.rows),
          minutes: Number(reviewing.minutes),
        })}>Approve</button
    >
  {/snippet}
</SidePanel>

<SidePanel
  open={editing !== null}
  title={editing?.profile ? `Edit ${editing.profile.name}` : 'Add profile'}
  onClose={() => (editing = null)}
>
  {#if editing}
    {#if formError}<p class="problem" role="alert">{formError}</p>{/if}
    <label class="field"><span>Name</span><input bind:value={editing.form.name} /></label>
    <label class="field"
      ><span>OAuth client ID</span><input
        bind:value={editing.form.clientId}
        disabled={editing.profile !== null}
      /></label
    >
    <fieldset>
      <legend class="section-label">Connections</legend>
      {#each connections as c (c.id)}
        <label class="check"
          ><input type="checkbox" value={c.id} bind:group={editing.form.connectionIds} /> {c.name}</label
        >
      {/each}
    </fieldset>
    <label class="check"
      ><input type="checkbox" bind:checked={editing.form.readOnly} /> Read-only profile</label
    >
    <label class="check"><input type="checkbox" bind:checked={editing.form.enabled} /> Enabled</label>
    <div class="row">
      <label class="field"
        ><span>Rows per execution</span><input type="number" bind:value={editing.form.previewRows} /></label
      >
      <label class="field"
        ><span>Bytes per execution</span><input type="number" bind:value={editing.form.previewBytes} /></label
      >
      <label class="field"
        ><span>Timeout (ms)</span><input type="number" bind:value={editing.form.timeoutMs} /></label
      >
    </div>
  {/if}
  {#snippet footer()}
    <button class="button" onclick={() => (editing = null)}>Cancel</button>
    <button class="button primary" onclick={() => void save()}>Save</button>
  {/snippet}
</SidePanel>

<style>
  .panel {
    background: var(--color-panel);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    padding: 12px 16px;
    margin-bottom: 14px;
  }
  .head,
  .profile-head {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
  }
  .profile {
    margin: 10px 0;
  }
  .approval {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 8px 0;
    border-bottom: 1px solid var(--color-border);
  }
  .approval > div {
    flex: 1;
  }
  .note {
    color: var(--color-text-muted);
    font: var(--text-dense);
  }
  pre {
    white-space: pre-wrap;
    background: var(--color-panel-subtle);
    padding: 10px;
    border-radius: 8px;
  }
  .list {
    width: 100%;
    border-collapse: collapse;
    margin-top: 6px;
  }
  th,
  td {
    padding: 4px 8px;
    text-align: left;
    border-bottom: 1px solid var(--color-border);
  }
  fieldset {
    border: 0;
    padding: 0;
    margin: 10px 0;
  }
  .check {
    display: flex;
    gap: 6px;
    align-items: center;
    margin: 4px 0;
  }
  .row {
    display: flex;
    gap: 8px;
  }
  .problem {
    padding: 8px 10px;
    border-radius: 6px;
    background: var(--color-danger-bg);
    color: var(--color-danger);
  }
</style>
