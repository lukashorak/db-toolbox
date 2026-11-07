<script lang="ts">
  import { onMount } from 'svelte';
  import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';
  type Connection = {
    id: string;
    name: string;
    engine: 'postgres' | 'mysql';
    host: string;
    port: number;
    database: string;
    username: string;
    tls: boolean;
    readOnly: boolean;
    enabled: boolean;
    hasCustomCa?: boolean;
  };
  type Profile = {
    id: string;
    name: string;
    clientId: string;
    connectionIds: string[];
    readOnly: boolean;
    enabled: boolean;
  };
  type Query = { id: string; name: string; folder: string; sql: string; connectionId?: string };
  type Result = {
    id: string;
    statementIndex: number;
    columns: { name: string; type: string }[];
    rows: number;
    bytes: number;
    completeness: string;
    transactionOutcome: string;
    durationMs: number;
    expiresAt: number;
    affectedRows: number | null;
  };
  type Job = {
    id: string;
    sql: string;
    connectionId: string;
    status: string;
    capture: string;
    transactionOutcome: string;
    createdAt: number;
    error?: string;
    results: Result[];
  };
  type Tab = { id: string; name: string; sql: string; connectionId: string; executionId?: string };
  type Grid = {
    columns: { name: string; type?: string }[];
    rows: unknown[][];
    available?: boolean;
    message?: string;
    sampledAt?: number;
  };
  let config: any = $state(null);
  let manager: UserManager;
  let user: User | null = $state(null);
  let loading = $state(true);
  let view = $state('workbench');
  let error = $state('');
  let notice = $state('');
  let busy = $state(false);
  let connections: Connection[] = $state([]);
  let profiles: Profile[] = $state([]);
  let history: Job[] = $state([]);
  let saved: Query[] = $state([]);
  let tabs: Tab[] = $state([
    { id: crypto.randomUUID(), name: 'Query 1', sql: 'SELECT 1 AS ready;', connectionId: '' },
  ]);
  let tabId = $state(tabs[0]!.id);
  let tab = $derived(tabs.find((t) => t.id === tabId)!);
  let connection = $derived(connections.find((c) => c.id === tab?.connectionId));
  let transaction = $state('per_statement');
  let timeout = $state(30);
  let retain = $state(24);
  let job: Job | null = $state(null);
  let selectedResult = $state('');
  let result = $derived.by(() => job?.results.find((r) => r.id === selectedResult));
  let grid: Grid = $state({ columns: [], rows: [] });
  let editor = $state<HTMLTextAreaElement>();
  let inspectionConnection = $state('');
  let inspectionView = $state('activity');
  let inspection: Grid = $state({ columns: [], rows: [] });
  let disclosure = $state(false);
  let approvalProfile = $state('');
  let approvals: { resultId: string; profileId: string; expiresAt: number }[] = $state([]);
  let connectionForm = $state(false);
  let editId = $state('');
  let form = $state({
    name: '',
    engine: 'postgres' as 'postgres' | 'mysql',
    host: '',
    port: 5432,
    database: '',
    username: '',
    password: '',
    tls: true,
    ca: '',
    readOnly: true,
    enabled: true,
  });
  let profileForm = $state(false);
  let profileId = $state('');
  let pf = $state({
    name: 'Claude Code',
    clientId: 'workbench-mcp',
    connectionIds: [] as string[],
    readOnly: true,
    enabled: true,
  });
  let saveForm = $state(false);
  let saveName = $state('');
  let saveFolder = $state('');
  const terminal = (status: string) =>
    ['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted', 'unknown'].includes(status);
  const format = (value: unknown) =>
    value === null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const time = (value: number) => new Date(value).toLocaleString();
  const bytes = (n: number) =>
    n < 1024
      ? `${n} B`
      : n < 1024 * 1024
        ? `${(n / 1024).toFixed(1)} KB`
        : `${(n / 1024 / 1024).toFixed(1)} MB`;
  function openDialog(node: HTMLDialogElement) {
    node.showModal();
    const cancel = () => {
      connectionForm = false;
      profileForm = false;
      saveForm = false;
    };
    node.addEventListener('cancel', cancel);
    return {
      destroy() {
        node.removeEventListener('cancel', cancel);
        node.close();
      },
    };
  }
  async function api(path: string, options: RequestInit = {}) {
    const current = await manager.getUser();
    if (!current || current.expired) throw new Error('Your session expired. Sign in again.');
    const response = await fetch('/api' + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${current.access_token}`,
        ...options.headers,
      },
    });
    if (response.status === 401) {
      user = null;
      throw new Error('Your session expired. Sign in again.');
    }
    if (!response.ok) {
      const body = await response.json();
      throw new Error(body.error?.message ?? 'Request failed.');
    }
    return response.status === 204 ? null : response.json();
  }
  async function perform(action: () => Promise<void>) {
    error = '';
    notice = '';
    busy = true;
    try {
      await action();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
  async function refresh() {
    [connections, profiles, history, saved, approvals] = await Promise.all([
      api('/connections'),
      api('/profiles'),
      api('/executions'),
      api('/queries'),
      api('/approvals'),
    ]);
    if (!tab.connectionId && connections[0]) tab.connectionId = connections[0].id;
    if (!inspectionConnection && connections[0]) inspectionConnection = connections[0].id;
  }
  onMount(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    void (async () => {
      try {
        config = await fetch('/api/config').then((r) => r.json());
        manager = new UserManager({
          authority: config.issuer,
          client_id: config.clientId,
          redirect_uri: new URL('/auth/callback', config.publicUrl).href,
          post_logout_redirect_uri: config.publicUrl,
          response_type: 'code',
          scope: 'openid profile workbench:api',
          automaticSilentRenew: true,
          userStore: new WebStorageStateStore({ store: sessionStorage }),
        });
        manager.events.addUserLoaded((value) => {
          user = value;
        });
        manager.events.addSilentRenewError(() => {
          error = 'Session renewal failed. Sign in again when your session expires.';
        });
        if (location.pathname === '/auth/callback') {
          await manager.signinRedirectCallback();
          window.history.replaceState({}, '', '/');
        }
        user = await manager.getUser();
        if (user?.expired) user = null;
        if (user) await refresh();
        timer = setInterval(() => {
          if (user && job && !terminal(job.status))
            void poll(job.id).catch((e) => {
              error = e.message;
            });
        }, 1200);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      } finally {
        loading = false;
      }
    })();
    return () => {
      if (timer) clearInterval(timer);
    };
  });
  async function poll(id: string) {
    const value: Job = await api(`/executions/${id}`);
    if (tab.executionId !== id) return;
    job = value;
    if (!selectedResult && value.results.length) selectedResult = value.results[0]!.id;
    if (terminal(value.status)) {
      if (selectedResult) await loadResult(selectedResult);
      history = await api('/executions');
    }
  }
  async function selectTab(id: string) {
    tabId = id;
    job = null;
    selectedResult = '';
    grid = { columns: [], rows: [] };
    disclosure = false;
    if (tab.executionId) await poll(tab.executionId);
  }
  function newTab(sql = 'SELECT 1;', name?: string, connectionId?: string) {
    const next = {
      id: crypto.randomUUID(),
      name: name ?? `Query ${tabs.length + 1}`,
      sql,
      connectionId: connectionId ?? tab.connectionId,
    };
    tabs.push(next);
    void selectTab(next.id);
  }
  async function run(capture: 'preview' | 'full') {
    await perform(async () => {
      const selected =
        editor && editor.selectionStart !== editor.selectionEnd
          ? tab.sql.slice(editor.selectionStart, editor.selectionEnd)
          : tab.sql;
      const value = await api('/executions', {
        method: 'POST',
        body: JSON.stringify({
          connectionId: tab.connectionId,
          sql: selected,
          capture,
          transaction,
          timeoutMs: timeout * 1000,
          retentionHours: retain,
          requestKey: crypto.randomUUID(),
        }),
      });
      tab.executionId = value.id;
      selectedResult = '';
      grid = { columns: [], rows: [] };
      disclosure = false;
      job = { ...value, results: [] };
      await poll(value.id);
    });
  }
  async function loadResult(id: string) {
    selectedResult = id;
    const value = await api(`/results/${id}?limit=1000`);
    grid = { columns: value.result.columns, rows: value.rows };
  }
  async function download(format: 'csv' | 'json') {
    await perform(async () => {
      if (!result) return;
      const item = await api(`/results/${result.id}/exports`, {
        method: 'POST',
        body: JSON.stringify({ format }),
      });
      const current = await manager.getUser();
      const response = await fetch(`/api/exports/${item.id}`, {
        headers: { Authorization: `Bearer ${current!.access_token}` },
      });
      if (!response.ok) throw new Error('Export download failed.');
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `result-${result.id}.${format}`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notice = `Exported all ${item.rows.toLocaleString()} captured rows.`;
    });
  }
  function editConnection(value?: Connection) {
    editId = value?.id ?? '';
    form = {
      name: '',
      engine: 'postgres',
      host: '',
      port: 5432,
      database: '',
      username: '',
      password: '',
      tls: true,
      ca: '',
      readOnly: true,
      enabled: true,
      ...value,
    };
    connectionForm = true;
  }
  async function persistConnection() {
    await perform(async () => {
      const value = {
        name: form.name,
        engine: form.engine,
        host: form.host,
        port: Number(form.port),
        database: form.database,
        username: form.username,
        tls: form.tls,
        readOnly: form.readOnly,
        enabled: form.enabled,
        ...(form.password || !editId ? { password: form.password } : {}),
        ...(form.ca ? { ca: form.ca } : {}),
      };
      await api('/connections' + (editId ? `/${editId}` : ''), {
        method: editId ? 'PUT' : 'POST',
        body: JSON.stringify(value),
      });
      connectionForm = false;
      await refresh();
      notice = 'Connection saved.';
    });
  }
  async function inspect() {
    await perform(async () => {
      inspection = await api(`/connections/${inspectionConnection}/inspect/${inspectionView}`);
    });
  }
  async function navigate(next: string) {
    view = next;
    error = '';
    notice = '';
    if (next === 'history' || next === 'saved' || next === 'mcp') await perform(refresh);
    if (next === 'explorer') {
      inspectionView = 'objects';
      if (inspectionConnection) await inspect();
    }
    if (next === 'monitoring') {
      inspectionView = 'activity';
      if (inspectionConnection) await inspect();
    }
  }
  async function openHistory(value: Job) {
    view = 'workbench';
    newTab(value.sql, `Execution ${value.id.slice(0, 6)}`, value.connectionId);
    tab.executionId = value.id;
    await poll(value.id);
  }
  async function saveQuery() {
    await perform(async () => {
      await api('/queries', {
        method: 'POST',
        body: JSON.stringify({
          name: saveName,
          folder: saveFolder,
          sql: tab.sql,
          ...(tab.connectionId ? { connectionId: tab.connectionId } : {}),
        }),
      });
      saveForm = false;
      saved = await api('/queries');
      notice = 'Query saved.';
    });
  }
  async function persistProfile() {
    await perform(async () => {
      await api('/profiles' + (profileId ? `/${profileId}` : ''), {
        method: profileId ? 'PUT' : 'POST',
        body: JSON.stringify(pf),
      });
      profileForm = false;
      await refresh();
    });
  }
  async function approve() {
    await perform(async () => {
      if (!result) return;
      await api(`/results/${result.id}/approvals`, {
        method: 'POST',
        body: JSON.stringify({ profileId: approvalProfile, hours: 1 }),
      });
      disclosure = false;
      approvals = await api('/approvals');
      notice =
        'MCP access to this full result is approved for one hour, or until the result expires.';
    });
  }
</script>

{#if loading}
  <main class="welcome">
    <div class="brandmark">▤</div>
    <p>Opening workbench…</p>
  </main>
{:else if !user}
  <main class="welcome">
    <div class="login-card">
      <div class="brandmark">▤</div>
      <p class="eyebrow">YOUR DATABASES, ONE WORKSPACE</p>
      <h1>Database Workbench</h1>
      <p>Explore data, run SQL, and give your AI tools precisely scoped access.</p>
      <button
        class="primary"
        onclick={() =>
          perform(async () => {
            await manager.signinRedirect();
          })}
        disabled={!config || busy}>Sign in with Keycloak <span>↗</span></button
      >{#if error}<p class="error" role="alert">{error}</p>{/if}<small
        >MySQL · PostgreSQL · MCP</small
      >
    </div>
  </main>
{:else}
  <div class="shell">
    <aside class="sidebar">
      <a class="brand" href="/" aria-label="Database Workbench home"
        ><span class="brandmark small">▤</span><span>Workbench<small>DATABASE CONSOLE</small></span
        ></a
      >
      <p class="nav-label">WORKSPACE</p>
      <nav>
        {#each [['workbench', '⌘', 'SQL workbench'], ['explorer', '▦', 'Explorer'], ['saved', '▱', 'Saved queries'], ['history', '◷', 'Execution history'], ['monitoring', '▥', 'Monitoring']] as [key, icon, label]}<button
            class:active={view === key}
            onclick={() => navigate(key!)}><span class="nav-icon">{icon}</span>{label}</button
          >{/each}
      </nav>
      <p class="nav-label">CONFIGURATION</p>
      <nav>
        <button class:active={view === 'connections'} onclick={() => navigate('connections')}
          ><span class="nav-icon">◉</span>Connections
          <span class="count">{connections.length}</span></button
        ><button class:active={view === 'mcp'} onclick={() => navigate('mcp')}
          ><span class="nav-icon">◇</span>MCP access</button
        >
      </nav>
      <div class="sidebar-bottom">
        <span class="avatar"
          >{String(user.profile.preferred_username ?? 'U')
            .slice(0, 1)
            .toUpperCase()}</span
        >
        <div>
          <strong>{user.profile.preferred_username ?? 'Signed in'}</strong><small
            >Personal workspace</small
          >
        </div>
        <button class="icon-button" title="Sign out" onclick={() => manager.signoutRedirect()}
          >↗</button
        >
      </div>
    </aside>
    <main class="main">
      <header class="page-header">
        <div>
          <p class="eyebrow">DATABASE WORKSPACE</p>
          <h1>
            {{
              workbench: 'SQL workbench',
              explorer: 'Database explorer',
              saved: 'Saved queries',
              history: 'Execution history',
              monitoring: 'Database monitoring',
              connections: 'Connections',
              mcp: 'MCP access',
            }[view]}
          </h1>
        </div>
        <span class="version">EARLY BUILD <strong>0.1</strong></span>
      </header>
      {#if error}<div class="banner error" role="alert">
          {error}<button onclick={() => (error = '')} aria-label="Dismiss error">×</button>
        </div>{/if}
      {#if notice}<div class="banner success" role="status">
          {notice}<button onclick={() => (notice = '')} aria-label="Dismiss notice">×</button>
        </div>{/if}

      {#if view === 'workbench'}
        <div class="workspace-top">
          <label class="connection-picker"
            ><span>CONNECTION</span><select
              bind:value={tab.connectionId}
              aria-label="Active connection"
              ><option value="" disabled>Select a connection</option>{#each connections as c}<option
                  value={c.id}>{c.name} · {c.database}</option
                >{/each}</select
            ></label
          >{#if connection}<span class="pill" class:green={connection.readOnly}
              >{connection.readOnly ? 'Read only' : 'Writes enabled'}</span
            ><span class="muted">{connection.engine === 'postgres' ? 'PostgreSQL' : 'MySQL'}</span
            >{/if}<button class="link-button push" onclick={() => navigate('connections')}
            >Manage connections ↗</button
          >
        </div>
        <section class="editor-panel">
          <div class="tabbar">
            {#each tabs as t}<button
                class:chosen={tabId === t.id}
                onclick={() => perform(() => selectTab(t.id))}
                ><span class="sql-icon">SQL</span>{t.name}{#if t.executionId}<span class="dot"
                  ></span>{/if}</button
              >{/each}<button class="new-tab" onclick={() => newTab()} aria-label="New SQL tab"
              >+</button
            >
          </div>
          <div class="editor-label">
            <span>SQL EDITOR</span><button
              class="link-button"
              onclick={() => {
                saveName = tab.name;
                saveForm = true;
              }}>Save query</button
            >
          </div>
          <textarea
            class="sql-editor"
            bind:this={editor}
            bind:value={tab.sql}
            spellcheck="false"
            aria-label="SQL editor"
            onkeydown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                void run('preview');
              }
            }}></textarea>
          <div class="execution-options">
            <label
              >Transaction<select bind:value={transaction}
                ><option value="per_statement">One per statement</option><option value="atomic"
                  >Entire script</option
                ></select
              ></label
            ><label
              >Timeout <div class="input-unit">
                <input
                  type="number"
                  bind:value={timeout}
                  min="1"
                  max="300"
                  aria-label="Timeout seconds"
                /><span>sec</span>
              </div></label
            ><label
              >Keep results <select bind:value={retain}
                ><option value={24}>24 hours</option><option value={168}>7 days</option></select
              ></label
            ><span class="push muted shortcut">⌘ / Ctrl + Enter</span>
          </div>
          <div class="runbar">
            <button
              class="primary"
              disabled={busy || !tab.connectionId || !tab.sql.trim()}
              onclick={() => run('preview')}>▶ Run preview</button
            ><button
              disabled={busy || !tab.connectionId || !tab.sql.trim()}
              onclick={() => run('full')}>Run full result</button
            >{#if job && !terminal(job.status)}<button
                class="danger"
                onclick={() =>
                  perform(async () => {
                    await api(`/executions/${job!.id}/cancel`, { method: 'POST' });
                    await poll(job!.id);
                  })}>Stop execution</button
              >{/if}<span class="muted push">Selected SQL or this tab · preview ≤ 1,000 rows</span>
          </div>
        </section>
        <section class="results-panel">
          <div class="section-heading">
            <h2>Results</h2>
            {#if job}<span class="status" class:green={job.status === 'succeeded'}
                >{job.status.replaceAll('_', ' ')}</span
              ><span class="muted">{job.transactionOutcome.replaceAll('_', ' ')}</span><button
                class="link-button push"
                onclick={() => perform(() => poll(job!.id))}>Refresh</button
              >{/if}
          </div>
          {#if job?.error}<div class="result-error">{job.error}</div>{/if}
          {#if job?.results.length}<div class="result-tabs">
              {#each job.results as r}<button
                  class:chosen={selectedResult === r.id}
                  onclick={() => perform(() => loadResult(r.id))}
                  >Statement {r.statementIndex + 1}<span>{r.rows.toLocaleString()}</span></button
                >{/each}
            </div>{/if}
          {#if result}<div class="result-summary">
              <span
                ><strong>{result.rows.toLocaleString()}</strong> captured rows · {bytes(
                  result.bytes,
                )} · {result.durationMs} ms</span
              ><span class="pill">{result.completeness.replaceAll('_', ' ')}</span>
              <div class="push result-actions">
                <button
                  disabled={busy ||
                    result.completeness !== 'complete' ||
                    result.transactionOutcome !== 'committed'}
                  onclick={() => download('csv')}>↓ CSV</button
                ><button
                  disabled={busy ||
                    result.completeness !== 'complete' ||
                    result.transactionOutcome !== 'committed'}
                  onclick={() => download('json')}>↓ JSON</button
                ><button
                  disabled={result.completeness !== 'complete' ||
                    result.transactionOutcome !== 'committed'}
                  onclick={() => {
                    approvalProfile =
                      profiles.find((p) => p.connectionIds.includes(job!.connectionId))?.id ?? '';
                    disclosure = !disclosure;
                  }}>Share full result with MCP</button
                >
              </div>
            </div>
            {#if disclosure}<div class="disclosure-card">
                <h3>Allow an MCP client to read this result</h3>
                <p>
                  This grants access to all {result.rows.toLocaleString()} captured rows. Exporting a
                  file alone does not grant this access.
                </p>
                <label
                  >MCP profile<select bind:value={approvalProfile}
                    ><option value="" disabled>Select profile</option
                    >{#each profiles.filter((p) => p.enabled && p.connectionIds.includes(job!.connectionId)) as p}<option
                        value={p.id}>{p.name}</option
                      >{/each}</select
                  ></label
                ><button class="primary" disabled={!approvalProfile || busy} onclick={approve}
                  >Allow for 1 hour</button
                ><button onclick={() => (disclosure = false)}>Cancel</button>
              </div>{/if}
            {#if grid.columns.length}<div class="table-scroll result-grid">
                <table>
                  <thead
                    ><tr
                      ><th class="row-number">#</th>{#each grid.columns as c}<th
                          >{c.name}<small>{c.type}</small></th
                        >{/each}</tr
                    ></thead
                  ><tbody
                    >{#each grid.rows as row, i}<tr
                        ><td class="row-number">{i + 1}</td>{#each row as cell}<td
                            class:null-value={cell === null}
                            title={format(cell)}>{format(cell)}</td
                          >{/each}</tr
                      >{/each}</tbody
                  >
                </table>
              </div>{:else}<div class="empty small-empty">
                <p>
                  {result.affectedRows !== null
                    ? `${result.affectedRows} affected rows`
                    : 'No tabular result.'}
                </p>
              </div>{/if}
            <footer class="result-footer">
              <span
                >Showing {grid.rows.length.toLocaleString()} rows. Exports contain the complete captured
                result.</span
              ><span>Expires {time(result.expiresAt)}</span>
            </footer>
          {:else}<div class="empty">
              <span class="empty-icon">▤</span>
              <h3>
                {job && !terminal(job.status)
                  ? 'Query running on the server'
                  : 'Your results will appear here'}
              </h3>
              <p>
                {job && !terminal(job.status)
                  ? 'You can leave this page and return through execution history.'
                  : 'Select a connection and run SQL. A preview shows up to 1,000 rows.'}
              </p>
            </div>{/if}
        </section>
      {:else if view === 'connections'}
        <div class="intro-row">
          <p>
            Connection settings are stored on the server. Read-only restrictions apply across every
            interface.
          </p>
          <button class="primary" onclick={() => editConnection()}>+ Add connection</button>
        </div>
        <div class="connection-cards">
          {#each connections as c}<article class="connection-card">
              <div class="card-top">
                <span class="database-icon">▤</span><span class="pill" class:green={c.readOnly}
                  >{c.readOnly ? 'Read only' : 'Read / write'}</span
                >
              </div>
              <h2>{c.name}</h2>
              <p>{c.engine === 'postgres' ? 'PostgreSQL' : 'MySQL'} · {c.database}</p>
              <code>{c.host}:{c.port}</code>
              <footer>
                <span>{c.tls ? 'TLS verified' : 'TCP'} · {c.enabled ? 'Enabled' : 'Disabled'}</span
                ><button onclick={() => editConnection(c)}>Edit</button><button
                  onclick={() =>
                    perform(async () => {
                      const value = await api(`/connections/${c.id}/test`, { method: 'POST' });
                      notice = String(value.version);
                    })}>Test</button
                >
              </footer>
            </article>{/each}
        </div>
        {#if !connections.length}<div class="empty card">
            <h3>Add your first database</h3>
            <p>
              Start with a PostgreSQL or MySQL connection. You can restrict MCP access separately.
            </p>
          </div>{/if}
      {:else if view === 'history'}
        <div class="intro-row">
          <p>Executions continue on the server when this page is closed.</p>
          <button onclick={() => perform(refresh)}>Refresh</button>
        </div>
        <div class="card table-scroll">
          <table>
            <thead
              ><tr
                ><th>Started</th><th>SQL</th><th>Capture</th><th>Status</th><th>Transaction</th><th
                ></th></tr
              ></thead
            ><tbody
              >{#each history as item}<tr
                  ><td>{time(item.createdAt)}</td><td class="sql-cell">{item.sql}</td><td
                    >{item.capture}</td
                  ><td
                    ><span class="status" class:green={item.status === 'succeeded'}
                      >{item.status}</span
                    ></td
                  ><td>{item.transactionOutcome}</td><td
                    ><button onclick={() => perform(() => openHistory(item))}>Open</button></td
                  ></tr
                >{/each}</tbody
            >
          </table>
          {#if !history.length}<div class="empty">
              <h3>No executions yet</h3>
              <p>Run a query to start building your history.</p>
            </div>{/if}
        </div>
      {:else if view === 'saved'}
        <div class="intro-row">
          <p>Keep SQL in named folders. Opening a saved query does not execute it.</p>
        </div>
        <div class="saved-list">
          {#each saved as item}<article class="card saved-card">
              <span class="sql-icon">SQL</span>
              <div>
                <small>{item.folder || 'Unfiled'}</small>
                <h3>{item.name}</h3>
                <code>{item.sql.slice(0, 180)}</code>
              </div>
              <button
                class="push"
                onclick={() => {
                  newTab(item.sql, item.name, item.connectionId);
                  view = 'workbench';
                }}>Open in tab</button
              >
            </article>{/each}{#if !saved.length}<div class="empty card">
              <h3>Your query collection starts here</h3>
              <p>Use Save query in the SQL editor to add a named query and folder.</p>
            </div>{/if}
        </div>
      {:else if view === 'monitoring' || view === 'explorer'}
        <div class="intro-row">
          <p>
            {view === 'monitoring'
              ? 'Live database activity includes queries started by other applications. Slow-query data is aggregated.'
              : 'Browse database objects and columns. Changes can be made through authorized SQL.'}
          </p>
        </div>
        <div class="inspection-toolbar">
          <select bind:value={inspectionConnection} aria-label="Inspection connection"
            >{#each connections as c}<option value={c.id}>{c.name}</option>{/each}</select
          >
          <div class="segmented">
            {#each view === 'monitoring' ? ['activity', 'blocking', 'statistics', 'slow'] : ['databases', 'objects', 'columns'] as mode}<button
                class:chosen={inspectionView === mode}
                onclick={() => {
                  inspectionView = mode;
                  void inspect();
                }}
                >{mode === 'slow'
                  ? 'Slow statements'
                  : mode[0]!.toUpperCase() + mode.slice(1)}</button
              >{/each}
          </div>
          <button class="push" disabled={!inspectionConnection || busy} onclick={inspect}
            >↻ Refresh</button
          >
        </div>
        <section class="card">
          {#if inspection.available === false}<div class="empty">
              <h3>This view is unavailable</h3>
              <p>{inspection.message}</p>
              <small
                >Check database privileges or whether the required statistics extension is enabled.</small
              >
            </div>{:else if inspection.columns.length}<div class="table-scroll">
              <table>
                <thead
                  ><tr
                    >{#each inspection.columns as c}<th>{c.name}</th>{/each}</tr
                  ></thead
                ><tbody
                  >{#each inspection.rows as row}<tr
                      >{#each row as cell}<td title={format(cell)}>{format(cell)}</td>{/each}</tr
                    >{/each}</tbody
                >
              </table>
            </div>
            {#if !inspection.rows.length}<div class="empty small-empty">
                No visible records.
              </div>{/if}{:else}<div class="empty">
              <h3>Select a database to explore</h3>
              <p>Refresh to load available information.</p>
            </div>{/if}{#if inspection.sampledAt}<footer class="result-footer">
              Snapshot {time(inspection.sampledAt)} · Up to 1,000 records
            </footer>{/if}
        </section>
      {:else if view === 'mcp'}
        <div class="intro-row">
          <p>
            Each profile is bound to a distinct Keycloak OAuth client. A profile can only narrow
            your database permissions.
          </p>
          <button
            class="primary"
            onclick={() => {
              profileId = '';
              pf = {
                name: 'Claude Code',
                clientId: 'workbench-mcp',
                connectionIds: [],
                readOnly: true,
                enabled: true,
              };
              profileForm = true;
            }}>+ Create profile</button
          >
        </div>
        <div class="card endpoint">
          <p class="eyebrow">AUTHENTICATED HTTP ENDPOINT</p>
          <code>{config.mcpEndpoint}</code>
          <p>
            Sign in through Keycloak. Full-result disclosure is always a separate action in the
            workbench.
          </p>
        </div>
        {#each profiles as p}<article class="card profile-card">
            <div class="section-heading">
              <h2>{p.name}</h2>
              <span class="pill" class:green={p.readOnly}
                >{p.readOnly ? 'Read only' : 'Writes permitted'}</span
              ><button
                class="push"
                onclick={() => {
                  profileId = p.id;
                  pf = {
                    name: p.name,
                    clientId: p.clientId,
                    connectionIds: [...p.connectionIds],
                    readOnly: p.readOnly,
                    enabled: p.enabled,
                  };
                  profileForm = true;
                }}>Edit</button
              >
            </div>
            <p>
              {p.connectionIds.length} allowed connections · OAuth client <code>{p.clientId}</code>
              · {p.enabled ? 'Enabled' : 'Disabled'}
            </p>
            <pre>claude mcp add --transport http --client-id {p.clientId} --callback-port 8765 workbench {config.mcpEndpoint}</pre>
          </article>{/each}
        <h2 class="standalone-title">Active result approvals</h2>
        <div class="card table-scroll">
          <table>
            <thead><tr><th>Result</th><th>Profile</th><th>Expires</th><th></th></tr></thead><tbody
              >{#each approvals as approval}<tr
                  ><td><code>{approval.resultId.slice(0, 8)}</code></td><td
                    >{profiles.find((p) => p.id === approval.profileId)?.name ??
                      approval.profileId}</td
                  ><td>{time(approval.expiresAt)}</td><td
                    ><button
                      onclick={() =>
                        perform(async () => {
                          await api(
                            `/results/${approval.resultId}/approvals/${approval.profileId}`,
                            { method: 'DELETE' },
                          );
                          approvals = await api('/approvals');
                        })}>Revoke</button
                    ></td
                  ></tr
                >{/each}</tbody
            >
          </table>
          {#if !approvals.length}<div class="empty small-empty">
              No full results are currently approved for MCP disclosure.
            </div>{/if}
        </div>
      {/if}
    </main>
  </div>
{/if}

{#if connectionForm}<div class="modal-backdrop">
    <dialog use:openDialog class="modal" aria-modal="true" aria-label="Connection settings">
      <div class="section-heading">
        <h2>{editId ? 'Edit connection' : 'Add connection'}</h2>
        <button class="push icon-button" onclick={() => (connectionForm = false)} aria-label="Close"
          >×</button
        >
      </div>
      <form
        onsubmit={(e) => {
          e.preventDefault();
          void persistConnection();
        }}
      >
        <label>Name<input bind:value={form.name} required placeholder="Analytics database" /></label
        >
        <div class="form-row">
          <label
            >Database engine<select
              bind:value={form.engine}
              onchange={() => (form.port = form.engine === 'postgres' ? 5432 : 3306)}
              ><option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option
              ></select
            ></label
          ><label>Port<input type="number" bind:value={form.port} required /></label>
        </div>
        <label>Host<input bind:value={form.host} required placeholder="db.example.com" /></label
        ><label>Database<input bind:value={form.database} required /></label>
        <div class="form-row">
          <label>Username<input bind:value={form.username} required autocomplete="off" /></label
          ><label
            >Password<input
              type="password"
              bind:value={form.password}
              placeholder={editId ? 'Leave blank to keep current' : ''}
              autocomplete="new-password"
            /></label
          >
        </div>
        <label class="check"
          ><input type="checkbox" bind:checked={form.tls} />Use verified TLS</label
        >{#if form.tls}<label
            >Custom CA certificate <small>Optional PEM</small><textarea
              class="ca-input"
              bind:value={form.ca}
              placeholder="-----BEGIN CERTIFICATE-----"></textarea></label
          >{/if}<label class="check"
          ><input type="checkbox" bind:checked={form.readOnly} />Restrict this connection to
          read-only SQL</label
        ><label class="check"
          ><input type="checkbox" bind:checked={form.enabled} />Connection enabled</label
        >
        <div class="modal-actions">
          <button type="button" onclick={() => (connectionForm = false)}>Cancel</button><button
            class="primary"
            disabled={busy}>Save connection</button
          >
        </div>
      </form>
    </dialog>
  </div>{/if}
{#if profileForm}<div class="modal-backdrop">
    <dialog use:openDialog class="modal" aria-modal="true" aria-label="MCP profile">
      <h2>{profileId ? 'Edit' : 'Create'} MCP profile</h2>
      <form
        onsubmit={(e) => {
          e.preventDefault();
          void persistProfile();
        }}
      >
        <label>Name<input bind:value={pf.name} required /></label><label
          >Keycloak OAuth client ID<input bind:value={pf.clientId} required /></label
        >
        <p class="muted">
          Register this public client in Keycloak with PKCE and callback
          http://localhost:8765/callback.
        </p>
        <label class="check"
          ><input type="checkbox" bind:checked={pf.readOnly} />Read-only database access</label
        ><label class="check"
          ><input type="checkbox" bind:checked={pf.enabled} />Profile enabled</label
        >
        <p class="eyebrow">ALLOWED CONNECTIONS</p>
        {#each connections as c}<label class="check"
            ><input type="checkbox" value={c.id} bind:group={pf.connectionIds} />{c.name}</label
          >{/each}
        <div class="modal-actions">
          <button type="button" onclick={() => (profileForm = false)}>Cancel</button><button
            class="primary"
            disabled={busy}>Save profile</button
          >
        </div>
      </form>
    </dialog>
  </div>{/if}
{#if saveForm}<div class="modal-backdrop">
    <dialog use:openDialog class="modal compact" aria-modal="true" aria-label="Save query">
      <h2>Save query</h2>
      <form
        onsubmit={(e) => {
          e.preventDefault();
          void saveQuery();
        }}
      >
        <label>Query name<input bind:value={saveName} required /></label><label
          >Folder<input bind:value={saveFolder} placeholder="Analytics / Monthly" /></label
        >
        <p class="muted">Separate nested folders with /.</p>
        <div class="modal-actions">
          <button type="button" onclick={() => (saveForm = false)}>Cancel</button><button
            class="primary">Save query</button
          >
        </div>
      </form>
    </dialog>
  </div>{/if}
