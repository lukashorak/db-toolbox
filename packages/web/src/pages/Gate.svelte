<script lang="ts">
  import { signIn, signOut } from '../lib/auth';
  import { session } from '../lib/session.svelte';

  /** Pages shown instead of the app: access denied, sign-in failure, and a lost session. */
  let { kind }: { kind: 'denied' | 'failed' | 'lost' } = $props();

  // A lost session is a modal over the app (which is inert meanwhile): focus moves into it.
  let action = $state<HTMLButtonElement>();
  $effect(() => {
    if (kind === 'lost') action?.focus();
  });
</script>

<div
  class="gate"
  role={kind === 'lost' ? 'alertdialog' : 'main'}
  aria-modal={kind === 'lost' ? 'true' : undefined}
  aria-labelledby="gate-title"
  aria-describedby={kind === 'lost' ? 'gate-message' : undefined}
>
  <div class="card">
    {#if kind === 'denied'}
      <h1 id="gate-title">No access to Database Workbench</h1>
      <p>
        Your account has no Database Workbench role. Ask an administrator to assign one in Keycloak, then sign
        in again.
      </p>
      <button class="button" onclick={() => void signOut()}>Sign out</button>
    {:else if kind === 'failed'}
      <h1 id="gate-title">Sign-in did not work</h1>
      <p>{session.error ?? 'The identity provider could not be reached.'}</p>
      <button class="button primary" onclick={() => void signIn('/')}>Try again</button>
    {:else}
      <h1 id="gate-title">Your session has ended</h1>
      <p id="gate-message">
        Sign in again to continue. Your open tabs and SQL drafts are kept in this browser, and running
        executions continue on the server.
      </p>
      <button class="button primary" bind:this={action} onclick={() => void signIn()}>Sign in again</button>
    {/if}
  </div>
</div>

<style>
  .gate {
    display: grid;
    place-items: center;
    min-height: 100vh;
    padding: 16px;
  }
  .card {
    max-width: 440px;
    padding: 24px;
    background: var(--color-panel);
    border: 1px solid var(--color-border);
    border-radius: 10px;
  }
  h1 {
    margin: 0 0 8px;
    font: var(--text-panel-title);
  }
</style>
