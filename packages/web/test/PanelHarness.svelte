<script lang="ts">
  import SidePanel from '../src/components/SidePanel.svelte';
  let open = $state(false);
</script>

<button onclick={() => (open = true)}>Open panel</button>
<SidePanel {open} title="Edit connection" onClose={() => (open = false)}>
  <label>Name <input /></label>
</SidePanel>
