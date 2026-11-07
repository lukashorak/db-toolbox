<script lang="ts">
  import type { Snippet } from 'svelte';
  import Menu from '../components/Menu.svelte';
  import Toasts from '../components/Toasts.svelte';
  import { signOut } from '../lib/auth';
  import { navigate, route } from '../lib/router.svelte';
  import { can, jobs, runningJobs, session } from '../lib/session.svelte';
  import JobsPopover from './JobsPopover.svelte';

  let { title, children }: { title: string; children: Snippet } = $props();
  const demo = import.meta.env.VITE_DEMO === '1';

  const nav = $derived(
    [
      { path: '/workbench', label: 'Workbench', show: can('sql.read') },
      { path: '/explorer', label: 'Explorer', show: can('sql.read') },
      { path: '/queries', label: 'Saved queries', show: can('queries.manage') },
      { path: '/executions', label: 'Executions', show: can('sql.read'), badge: runningJobs() },
      { path: '/monitoring', label: 'Monitoring', show: can('monitor.view') },
      { path: '/mcp', label: 'MCP access', show: can('connections.view'), badge: jobs.pendingApprovals },
      { path: '/connections', label: 'Connections', show: can('connections.view') },
      { path: '/settings', label: 'Settings', show: true },
    ].filter((n) => n.show),
  );
  const isActive = (path: string) => route.path === path || route.path.startsWith(`${path}/`);
</script>

<a class="skip" href="#main">Skip to content</a>
<div class="shell">
  <nav class="sidebar" aria-label="Main">
    <div class="brand">Database Workbench</div>
    {#if demo}<div class="demo">Demo data</div>{/if}
    <ul>
      {#each nav as item (item.path)}
        <li>
          <a
            href={item.path}
            aria-current={isActive(item.path) ? 'page' : undefined}
            onclick={(e) => {
              e.preventDefault();
              navigate(item.path);
            }}
          >
            {item.label}
            {#if item.badge}<span class="badge" aria-label="{item.badge} pending">{item.badge}</span>{/if}
          </a>
        </li>
      {/each}
    </ul>
  </nav>
  <div class="main">
    <header class="header">
      <h1>{title}</h1>
      <div class="tools">
        <JobsPopover />
        <Menu
          label={session.user?.displayName ?? 'Account'}
          items={[
            { label: 'Settings', onSelect: () => navigate('/settings') },
            { label: 'Sign out', onSelect: () => void signOut() },
          ]}
        />
      </div>
    </header>
    <main id="main" tabindex="-1">{@render children()}</main>
  </div>
</div>
<Toasts />

<style>
  .skip {
    position: absolute;
    left: -9999px;
  }
  .skip:focus {
    left: 8px;
    top: 8px;
    z-index: 40;
    padding: 6px 10px;
    background: var(--color-panel);
  }
  .shell {
    display: grid;
    grid-template-columns: 220px 1fr;
    height: 100vh;
  }
  .sidebar {
    background: var(--color-nav);
    color: var(--color-nav-text);
    padding: 16px 10px;
    overflow: auto;
  }
  .brand {
    padding: 0 10px 16px;
    color: #fff;
    font-weight: 600;
  }
  .demo {
    margin: 0 10px 12px;
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--color-warning-bg);
    color: var(--color-warning);
    font-size: 11px;
    font-weight: 600;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  a {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 7px 10px;
    border-radius: 6px;
    color: inherit;
    text-decoration: none;
  }
  a:hover {
    background: rgba(255, 255, 255, 0.06);
  }
  a[aria-current='page'] {
    background: rgba(255, 255, 255, 0.1);
    color: var(--color-nav-active);
  }
  .badge {
    min-width: 18px;
    padding: 0 5px;
    border-radius: 9px;
    background: var(--color-accent);
    color: #fff;
    font-size: 11px;
    text-align: center;
  }
  .main {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 52px;
    padding: 0 20px;
    background: var(--color-panel);
    border-bottom: 1px solid var(--color-border);
  }
  h1 {
    margin: 0;
    font: var(--text-screen-title);
  }
  .tools {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  main {
    flex: 1;
    overflow: auto;
    padding: 20px;
  }
  @media (max-width: 760px) {
    .shell {
      grid-template-columns: 1fr;
      grid-template-rows: auto 1fr;
    }
    .sidebar ul {
      display: flex;
      flex-wrap: wrap;
    }
  }
</style>
