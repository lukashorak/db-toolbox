<script lang="ts">
  import Banner from '../components/Banner.svelte';
  let { name }: { name: string } = $props();
</script>

<Banner tone="neutral" title="{name} is not available in this build yet.">
  The API already offers it; see <a href="/api/v1/openapi.json">the API reference</a>.
</Banner>
