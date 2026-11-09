<script lang="ts">
  import { api, ApiError } from '../lib/api';
  import type { Connection, TestReport } from '../lib/types';
  import SidePanel from './SidePanel.svelte';
  import TestReportView from './TestReportView.svelte';

  let {
    open,
    connection,
    onClose,
    onSaved,
  }: { open: boolean; connection: Connection | null; onClose: () => void; onSaved: (c: Connection) => void } =
    $props();

  const TLS = [
    ['verify-full', 'Verify certificate and host name'],
    ['verify-ca', 'Verify certificate only'],
    ['require', 'Encrypt without verifying (not recommended)'],
    ['disable', 'No encryption'],
  ] as const;

  const blank = () => ({
    name: '',
    engine: 'postgresql' as Connection['engine'],
    environment: 'development' as Connection['environment'],
    host: '',
    port: 5432,
    database: '',
    schema: '',
    username: '',
    password: '',
    tlsMode: 'verify-full' as Connection['tlsMode'],
    caPem: '',
    monitorUsername: '',
    monitorPassword: '',
    readOnly: true,
  });
  let form = $state(blank());
  let errors = $state<Record<string, string>>({});
  let problem = $state<string | null>(null);
  let report = $state<TestReport | null>(null);
  let busy = $state(false);
  const editing = $derived(connection !== null);

  $effect(() => {
    if (!open) return;
    errors = {};
    problem = null;
    report = null;
    form = connection
      ? {
          ...blank(),
          ...connection,
          schema: connection.schema ?? '',
          password: '',
          caPem: '',
          monitorUsername: connection.monitorUsername ?? '',
          monitorPassword: '',
        }
      : blank();
  });

  function payload() {
    const body: Record<string, unknown> = {
      name: form.name,
      environment: form.environment,
      host: form.host,
      port: Number(form.port),
      database: form.database,
      schema: form.engine === 'postgresql' && form.schema ? form.schema : null,
      username: form.username,
      tlsMode: form.tlsMode,
      readOnly: form.readOnly,
      monitorUsername: form.monitorUsername || null,
    };
    if (!editing) body.engine = form.engine;
    if (form.password || !editing) body.password = form.password;
    if (form.caPem) body.caPem = form.caPem;
    if (form.monitorPassword) body.monitorPassword = form.monitorPassword;
    return body;
  }

  function fail(error: unknown) {
    errors = {};
    if (error instanceof ApiError && error.code === 'validation_failed') {
      const fields = (error.details?.fields ?? []) as { path: string; message: string }[];
      for (const f of fields) errors[f.path.split('.').pop() ?? f.path] = f.message;
      if (error.details?.field) errors[String(error.details.field)] = error.message;
      problem = fields.length ? 'Check the highlighted fields.' : error.message;
    } else if (error instanceof ApiError && error.code === 'name_conflict') {
      errors.name = error.message;
      problem = error.message;
    } else problem = error instanceof Error ? error.message : String(error);
  }

  async function test() {
    busy = true;
    report = null;
    try {
      const { name: _name, environment: _env, readOnly: _ro, monitorUsername: _mu, ...draft } = payload();
      delete draft.monitorPassword;
      report = await api<TestReport>('POST', '/connections/test', {
        ...draft,
        engine: form.engine,
        ...(connection ? { connectionId: connection.id } : {}),
        password: form.password,
      });
      problem = null;
    } catch (error) {
      fail(error);
    } finally {
      busy = false;
    }
  }

  async function save() {
    busy = true;
    try {
      const saved = connection
        ? await api<Connection>('PATCH', `/connections/${connection.id}`, payload())
        : await api<Connection>('POST', '/connections', payload());
      onSaved(saved);
    } catch (error) {
      fail(error);
    } finally {
      busy = false;
    }
  }
</script>

<SidePanel {open} title={editing ? `Edit ${connection?.name}` : 'Add connection'} {onClose} width={520}>
  <form class="form" onsubmit={(e) => (e.preventDefault(), void save())} novalidate>
    {#if problem}<p class="problem" role="alert">{problem}</p>{/if}
    <label class="field"
      ><span>Name</span><input bind:value={form.name} aria-invalid={Boolean(errors.name)} required />
      {#if errors.name}<small class="err">{errors.name}</small>{/if}</label
    >
    <div class="row">
      <label class="field"
        ><span>Engine</span>
        <select
          bind:value={form.engine}
          disabled={editing}
          onchange={() => (form.port = form.engine === 'mysql' ? 3306 : 5432)}
          ><option value="postgresql">PostgreSQL</option><option value="mysql">MySQL</option></select
        ></label
      >
      <label class="field"
        ><span>Environment</span>
        <select bind:value={form.environment}
          ><option value="development">Development</option><option value="production">Production</option
          ></select
        ></label
      >
    </div>
    <div class="row">
      <label class="field grow"
        ><span>Host</span><input bind:value={form.host} aria-invalid={Boolean(errors.host)} />
        {#if errors.host}<small class="err">{errors.host}</small>{/if}</label
      >
      <label class="field port"
        ><span>Port</span><input type="number" bind:value={form.port} />
        {#if errors.port}<small class="err">{errors.port}</small>{/if}</label
      >
    </div>
    <div class="row">
      <label class="field grow"><span>Database</span><input bind:value={form.database} /></label>
      {#if form.engine === 'postgresql'}<label class="field grow"
          ><span>Schema</span><input bind:value={form.schema} placeholder="public" /></label
        >{/if}
    </div>
    <div class="row">
      <label class="field grow"
        ><span>User</span><input bind:value={form.username} autocomplete="off" /></label
      >
      <label class="field grow"
        ><span>Password</span><input
          type="password"
          bind:value={form.password}
          autocomplete="new-password"
          placeholder={editing ? 'Leave blank to keep the stored password' : ''}
        />
        {#if errors.password}<small class="err">{errors.password}</small>{/if}</label
      >
    </div>
    <fieldset>
      <legend class="section-label">Transport</legend>
      <label><input type="radio" checked disabled={false} /> Direct (TCP)</label>
      <label class="planned"><input type="radio" disabled /> SSH tunnel · Planned</label>
    </fieldset>
    <label class="field"
      ><span>TLS</span>
      <select bind:value={form.tlsMode}>
        {#each TLS as [value, label] (value)}<option {value}>{label}</option>{/each}
      </select></label
    >
    {#if form.tlsMode !== 'disable'}
      <label class="field"
        ><span>Custom CA (PEM){connection?.hasCustomCa ? ' · a CA is stored; paste to replace' : ''}</span
        ><textarea rows="3" bind:value={form.caPem} class="mono"></textarea>
        {#if errors.caPem}<small class="err">{errors.caPem}</small>{/if}</label
      >
    {/if}
    <details>
      <summary>Monitoring account (optional)</summary>
      <div class="row">
        <label class="field grow"
          ><span>User</span><input bind:value={form.monitorUsername} autocomplete="off" /></label
        >
        <label class="field grow"
          ><span>Password</span><input
            type="password"
            bind:value={form.monitorPassword}
            autocomplete="new-password"
            placeholder={connection?.monitorUsername ? 'Leave blank to keep' : ''}
          />
          {#if errors.monitorPassword}<small class="err">{errors.monitorPassword}</small>{/if}</label
        >
      </div>
    </details>
    <label class="check"
      ><input type="checkbox" bind:checked={form.readOnly} /> Read-only connection (modifying SQL is rejected for
      everyone)</label
    >
    {#if report}<TestReportView {report} />{/if}
    <button type="submit" hidden aria-hidden="true"></button>
  </form>
  {#snippet footer()}
    <button class="button" disabled={busy} onclick={() => void test()}>Test connection</button>
    <button class="button primary" disabled={busy} onclick={() => void save()}
      >{editing ? 'Save changes' : 'Add connection'}</button
    >
  {/snippet}
</SidePanel>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .row {
    display: flex;
    gap: 12px;
  }
  .grow {
    flex: 1;
  }
  .port {
    width: 100px;
  }
  .err {
    color: var(--color-danger);
  }
  .problem {
    margin: 0;
    padding: 8px 10px;
    border-radius: 6px;
    background: var(--color-danger-bg);
    color: var(--color-danger);
  }
  fieldset {
    border: 0;
    padding: 0;
    margin: 0;
    display: flex;
    gap: 16px;
  }
  .planned {
    color: var(--color-text-muted);
  }
  .check {
    display: flex;
    gap: 8px;
    align-items: center;
  }
</style>
