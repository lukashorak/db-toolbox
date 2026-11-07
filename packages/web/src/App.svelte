<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError, whenUnauthorized } from './lib/api';
  import { completeSignIn, currentUser, initAuth, loadClientConfig, onSessionLost, signIn } from './lib/auth';
  import { navigate, route } from './lib/router.svelte';
  import { followJobs, session, type SessionUser } from './lib/session.svelte';
  import Connections from './pages/Connections.svelte';
  import Executions from './pages/Executions.svelte';
  import Explorer from './pages/Explorer.svelte';
  import Gate from './pages/Gate.svelte';
  import Placeholder from './pages/Placeholder.svelte';
  import SavedQueries from './pages/SavedQueries.svelte';
  import Workbench from './pages/Workbench.svelte';
  import Shell from './shell/Shell.svelte';

  const TITLES: Record<string, string> = {
    '/workbench': 'Workbench',
    '/explorer': 'Explorer',
    '/queries': 'Saved queries',
    '/executions': 'Executions',
    '/monitoring': 'Monitoring',
    '/mcp': 'MCP access',
    '/connections': 'Connections',
    '/settings': 'Settings',
  };
  const section = $derived(
    Object.keys(TITLES).find((p) => route.path === p || route.path.startsWith(`${p}/`)) ?? '/workbench',
  );

  onMount(() => {
    let stop: (() => void) | undefined;
    const lost = () => {
      if (session.status === 'signed_in') session.status = 'lost';
    };
    whenUnauthorized(lost);
    const off = onSessionLost(lost);
    void (async () => {
      try {
        session.config = await loadClientConfig();
        initAuth(session.config);
        if (route.path === '/auth/callback') {
          navigate(await completeSignIn(), true);
        }
        if (!(await currentUser())) {
          await signIn();
          return;
        }
        const me = await api<{ user: SessionUser; permissions: string[] }>('GET', '/session');
        session.user = me.user;
        session.permissions = me.permissions;
        session.status = 'signed_in';
        if (route.path === '/') navigate('/workbench', true);
        stop = followJobs();
      } catch (error) {
        if (error instanceof ApiError && error.code === 'no_role') session.status = 'denied';
        else if (session.status !== 'lost') {
          session.status = 'failed';
          session.error = error instanceof Error ? error.message : String(error);
        }
      }
    })();
    return () => {
      stop?.();
      off();
    };
  });
</script>

{#if session.status === 'loading'}
  <p class="loading" role="status">Signing in…</p>
{:else if session.status === 'denied'}
  <Gate kind="denied" />
{:else if session.status === 'failed'}
  <Gate kind="failed" />
{:else}
  <Shell title={TITLES[section] ?? 'Workbench'}>
    {#if section === '/workbench'}
      <Workbench />
    {:else if section === '/executions'}
      <Executions />
    {:else if section === '/connections'}
      <Connections />
    {:else if section === '/explorer'}
      <Explorer />
    {:else if section === '/queries'}
      <SavedQueries />
    {:else}
      <Placeholder name={TITLES[section] ?? 'This screen'} />
    {/if}
  </Shell>
  {#if session.status === 'lost'}
    <div class="overlay"><Gate kind="lost" /></div>
  {/if}
{/if}

<style>
  .loading {
    padding: 24px;
    color: var(--color-text-muted);
  }
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: rgba(20, 25, 37, 0.4);
  }
</style>
